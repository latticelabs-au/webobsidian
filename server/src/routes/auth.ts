import { Router, type Request } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { COOKIE_NAME, requireAuth } from '../middleware/auth.js';
import {
  hasCustomPassword,
  authenticatePassword,
  auditCredentialUse,
  changePassword,
  issueToken,
  MIN_PASSWORD_LEN,
} from '../services/auth.js';
import { loginRateLimit, createFailureLimiter } from '../middleware/ratelimit.js';

export const authRouter = Router();

/**
 * Layer 2 of the login throttle, and the reason Layer 1 is allowed to fail closed.
 *
 * The network-keyed limiter (loginRateLimit) keys on the TCP socket address unless
 * `trust proxy` names a subnet or preset, because only that form is self-validating.
 * Behind a reverse proxy under the default configuration that means every client
 * shares one bucket, so ten failed logins from anywhere on the internet would lock
 * the real owner out for fifteen minutes, repeatedly and renewably. That lockout was
 * the original finding; keying on the socket address alone would have traded a bypass
 * for a denial of service.
 *
 * This limiter charges only FAILED attempts and a success clears the counter, so an
 * owner who knows their password is never charged and can always get in no matter how
 * much noise an attacker is making. It is not a RequestHandler because only the route
 * knows whether the credential check actually failed.
 *
 * Honest limit, worth stating because it bounds what this buys: the app has a single
 * owner account and no username, so the identity here is the account itself and an
 * attacker can still accumulate failures against it. What it guarantees is that the
 * owner's own correct password is never rejected on account of someone else's failures,
 * which is precisely the availability property Layer 1 gave up.
 */
const loginFailureLimit = createFailureLimiter({
  windowMs: 15 * 60 * 1000,
  max: 25,
  keyFn: () => 'owner',
});

// A `Secure` cookie is silently dropped by browsers over plain http://, so tying
// it to NODE_ENV broke HTTP-only self-hosting (every API call 401'd → blank UI).
// Default 'auto' = match the request's actual transport (honours X-Forwarded-Proto
// via `trust proxy`); set COOKIE_SECURE=true/false to force.
const COOKIE_SECURE = (process.env.COOKIE_SECURE ?? 'auto').toLowerCase();

function cookieOpts(req: Request) {
  const secure =
    COOKIE_SECURE === 'true' ? true : COOKIE_SECURE === 'false' ? false : req.secure;
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  };
}

authRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    // Do NOT report `mustChangePassword` here. This route needs no auth, so the
    // flag was a public oracle for "this instance still accepts 123456": a port
    // scan was enough to find every takeable deployment.
    // The flag is available post-login on /auth/login and /auth/me.
    //
    // `passwordSet` is a constant. The instance always has an effective login
    // password (at minimum the default 123456), so there has never been a state
    // where this was false. It is kept in the response, rather than removed,
    // purely so existing clients that read the field keep parsing the payload:
    // the route now carries no information at all, which is the point.
    res.json({ passwordSet: true });
  }),
);

// NOTE: there is deliberately no POST /auth/setup any more.
//
// It was an unauthenticated endpoint that called setUserPassword() and then set
// a session cookie, guarded only by `isPasswordSet()` returning a hardcoded
// `true`. Nothing about that guard was structural: one edit to that function
// (say, making it report whether the user had actually chosen a password) would
// have reopened a public "set the owner password and hand me a session"
// endpoint, i.e. remote account takeover in a single request. The first-run flow
// it existed for does not exist either, because a fresh install already logs in
// with the default password and is then pushed through ForceChangePassword.
// Deleting it removes the latent hazard rather than re-guarding it.

authRouter.post(
  '/change-password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body ?? {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      res.status(400).json({ error: 'currentPassword and newPassword required' });
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LEN) {
      res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters` });
      return;
    }
    try {
      await changePassword(currentPassword, newPassword);
    } catch {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }
    // Changing the password now invalidates every outstanding session token,
    // including the one that authenticated THIS request (see credentialFingerprint
    // in services/auth.ts). Minting a fresh cookie here is what makes that
    // useful rather than hostile: the caller stays signed in, every other
    // session (a stolen cookie, an old device) is evicted on its next request.
    // Without this, the user who just secured their account would be bounced to
    // the login screen and the desktop shell would break outright.
    const token = await issueToken();
    res.cookie(COOKIE_NAME, token, cookieOpts(req)).json({ ok: true });
  }),
);

authRouter.post(
  '/login',
  loginRateLimit,
  asyncHandler(async (req, res) => {
    const { password } = req.body ?? {};

    // Layer 2 runs before the credential check so a locked-out identity never reaches
    // scrypt. That also removes the CPU amplification an unthrottled password endpoint
    // otherwise offers, since every attempt would otherwise cost a key derivation.
    const failureKey = loginFailureLimit.keyFor(req);
    if (!loginFailureLimit.check(failureKey)) {
      const retryAfter = loginFailureLimit.retryAfterSeconds(failureKey);
      res.set('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Too many failed login attempts. Try again later.', retryAfter });
      return;
    }

    const kind = typeof password === 'string' ? await authenticatePassword(password) : null;
    if (!kind) {
      loginFailureLimit.recordFailure(failureKey);
      res.status(401).json({ error: 'Invalid password' });
      return;
    }
    // A correct credential clears the accumulated failures immediately, which is what
    // stops an attacker's noise from ever locking out someone who knows the password.
    loginFailureLimit.reset(failureKey);
    // Audit-log logins that used a recovery override rather than the owner's own
    // password. Those credentials never expire and survive a password change, so
    // a successful one is the single event most worth being able to find in a log
    // after the fact. `req.ip` is only as trustworthy as `trust proxy` is accurate
    // (see config.ts), which is why it is recorded as context, not as identity.
    auditCredentialUse(kind, 'login', req.ip);
    const token = await issueToken();
    res
      .cookie(COOKIE_NAME, token, cookieOpts(req))
      .json({ ok: true, mustChangePassword: !(await hasCustomPassword()) });
  }),
);

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' }).json({ ok: true });
});

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({ authenticated: true, mustChangePassword: !(await hasCustomPassword()) });
  }),
);
