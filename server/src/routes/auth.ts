import { Router, type Request } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { COOKIE_NAME, requireAuth } from '../middleware/auth.js';
import {
  hasCustomPassword,
  authenticatePassword,
  auditCredentialUse,
  changePassword,
  issueToken,
  readSession,
  MIN_PASSWORD_LEN,
  type OwnerSession,
} from '../services/auth.js';
import {
  loginRateLimit,
  loginRateLimitSettings,
  createFailureLimiter,
  createRateLimiter,
} from '../middleware/ratelimit.js';
import {
  buildAuthorizationUrl,
  handleCallback,
  isOidcAvailable,
  OidcError,
  TRANSACTION_TTL_SECONDS,
  type OidcErrorCode,
} from '../services/oidc.js';
import { recordOidcLogin } from '../services/oidc-users.js';

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
 *
 * The budget defaults to the 25 failures per 15 minutes that used to be literals here
 * and is now `auth.rateLimit.loginFailure*` in services/settings.ts, for the same reason
 * Layer 1's numbers moved: the shipped pair is right for most deployments and is still a
 * dead end for the ones it is wrong for. It is deliberately LOOSER than Layer 1's default
 * because the two layers meter different things. Layer 1 charges every attempt and, under
 * the shipped `trust proxy`, charges them all to one shared bucket; Layer 2 charges only
 * this account's own failures. An operator retuning them should keep that relationship in
 * mind rather than setting them to the same number by symmetry.
 *
 * Passed as resolvers rather than values so a change applies without a restart. The store
 * is built once inside createFailureLimiter and is NOT rebuilt when the numbers move, so
 * an accumulated lockout survives the edit instead of being handed a clean slate; see the
 * note on createWindowStore for exactly what a window change does to the buckets already
 * in flight.
 */
const loginFailureLimit = createFailureLimiter({
  windowMs: () => loginRateLimitSettings().loginFailureWindowSec * 1000,
  max: () => loginRateLimitSettings().loginFailureMaxAttempts,
  keyFn: () => 'owner',
});

// A `Secure` cookie is silently dropped by browsers over plain http://, so tying
// it to NODE_ENV broke HTTP-only self-hosting (every API call 401'd → blank UI).
// Default 'auto' = match the request's actual transport (honours X-Forwarded-Proto
// via `trust proxy`); set COOKIE_SECURE=true/false to force.
const COOKIE_SECURE = (process.env.COOKIE_SECURE ?? 'auto').toLowerCase();

function isSecureRequest(req: Request): boolean {
  return COOKIE_SECURE === 'true' ? true : COOKIE_SECURE === 'false' ? false : req.secure;
}

function cookieOpts(req: Request) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isSecureRequest(req),
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  };
}

/** ---- OIDC single sign-on (FR-15) ----------------------------------------- */

/**
 * The cookie carrying the in-flight OIDC transaction (state, nonce, PKCE
 * verifier, redirect URI), signed and short-lived. See services/oidc.ts for what
 * is inside it and why it is one sealed value rather than three cookies.
 */
const OIDC_TX_COOKIE = 'webobsidian_oidc_tx';

/**
 * Scoped to the callback's own path. It is only ever read by
 * `GET /auth/oidc/callback`, so there is no reason for it to ride along on every
 * request to the app, and a path-scoped cookie is one fewer secret in every
 * request log and every XHR.
 */
const OIDC_TX_PATH = '/auth/oidc';

function oidcTxCookieOpts(req: Request) {
  return {
    httpOnly: true,
    // MUST be 'lax', and this is the one cookie in the app where the value is
    // load bearing rather than conventional. The callback arrives as a top-level
    // GET navigation initiated by the IdP's origin, which is cross-site.
    // 'strict' would withhold the cookie on exactly that request, so every login
    // would fail with a missing transaction; 'none' would send it on cross-site
    // sub-requests too, which it has no business doing. 'lax' sends it on a
    // top-level GET navigation and nothing else, which is precisely the shape of
    // the one request that needs it. (This is also half of why the flow uses
    // response_mode=query: a cross-site top-level POST would not carry it
    // either.)
    sameSite: 'lax' as const,
    secure: isSecureRequest(req),
    maxAge: TRANSACTION_TTL_SECONDS * 1000,
    path: OIDC_TX_PATH,
  };
}

/**
 * Throttles for the two SSO endpoints. Neither is optional, and they are two
 * limiters rather than one shared handler.
 *
 * `/auth/oidc/login` is unauthenticated and each hit can cost an outbound
 * discovery request plus a PKCE challenge computation, so without a limit it is
 * a free amplifier pointed at the operator's own IdP. `/auth/oidc/callback` is
 * unauthenticated and does a token exchange plus a JWKS validation, and it is
 * the endpoint an attacker would hammer while replaying a captured callback or
 * guessing at a state value.
 *
 * TWO limiters because a middleware instance owns one store, so mounting one
 * handler on both routes would put them in a single bucket: a complete login is
 * one hit on each, so the two surfaces would draw down the same budget and the
 * effective login allowance would be half the configured number. That is exactly
 * the "tripping a cheap limiter locks a client out of an unrelated route" failure
 * that middleware/ratelimit.ts documents as the reason every limiter owns its own
 * store.
 *
 * Layer 1 only (network keyed), on purpose: unlike the password login there is
 * no per-identity failure counter to pair it with, because the identity is not
 * known until after the exchange has already happened. The budget is set high
 * enough (30 per quarter hour, per surface) that a real user retrying a failed
 * login never meets it, and it is deliberately generous because under the
 * shipped `trust proxy` default every client behind a reverse proxy shares one
 * bucket (see `ThrottleKeySource`), so this number is an instance-wide budget on
 * most deployments rather than a per-person one.
 *
 * A 429 here renders as raw JSON rather than as the app's login screen, which is
 * ugly; it is also unreachable by anyone behaving normally, and dressing up the
 * abuse path is not worth a second HTML surface.
 */
const OIDC_RATE_LIMIT = { windowMs: 15 * 60 * 1000, max: 30 } as const;

const oidcLoginRateLimit = createRateLimiter({
  ...OIDC_RATE_LIMIT,
  message: 'Too many single sign-on attempts. Try again later.',
});

const oidcCallbackRateLimit = createRateLimiter({
  ...OIDC_RATE_LIMIT,
  message: 'Too many single sign-on callbacks. Try again later.',
});

/**
 * The redirect URI to use when the operator has not configured one explicitly.
 *
 * Derived from the request, which means it derives from the `Host` header, which
 * is client-controlled. That is safe here and it is worth being precise about
 * why, because "attacker-controlled value in a redirect URI" is normally a
 * finding:
 *
 *  - It is never used as a redirect TARGET by this server. It is sent to the IdP
 *    as the `redirect_uri` parameter, and the IdP refuses any value that is not
 *    on its own registered list. A forged Host therefore produces a failed
 *    authorization request at the IdP, not a redirect anywhere.
 *  - It cannot desynchronise the token exchange either, because the value is
 *    sealed into the transaction cookie at login time and read back out of the
 *    cookie at callback time (services/oidc.ts), so the two halves of the flow
 *    always agree even if the two requests disagree about the host.
 *
 * `req.protocol` honours `X-Forwarded-Proto` when `trust proxy` is set, which is
 * the common reverse-proxy case. An operator whose proxy rewrites the path, or
 * who terminates on a different hostname, should set `oidc.redirectUri`
 * explicitly rather than rely on this.
 */
function fallbackRedirectUri(req: Request): string {
  const host = req.get('host') ?? `localhost`;
  return `${req.protocol}://${host}${OIDC_TX_PATH}/callback`;
}

/**
 * Where a failed SSO attempt lands.
 *
 * Always a relative path, so this can never become an open redirect, and always
 * one of the closed set of codes from services/oidc.ts, so it can never leak an
 * issuer URL, a token endpoint response or a stack frame to an unauthenticated
 * visitor. The detail is logged; the browser gets a code the login screen can
 * turn into a sentence.
 */
function ssoFailureRedirect(code: OidcErrorCode | 'internal'): string {
  return `/?sso_error=${encodeURIComponent(code)}`;
}

/**
 * Log the real reason, return the safe one.
 *
 * A misconfigured issuer has to be diagnosable by the operator, and the only
 * place that can happen is the server log: the browser deliberately learns
 * nothing. This is the seam that keeps "surfaced, not swallowed" true without
 * turning the login screen into an information leak.
 */
function reportSsoFailure(err: unknown): OidcErrorCode | 'internal' {
  if (err instanceof OidcError) {
    console.warn(`[oidc] ${err.code}: ${err.detail}`);
    return err.code;
  }
  console.error('[oidc] unexpected failure during single sign-on:', err);
  return 'internal';
}

/**
 * Start the flow: 302 the browser to the IdP.
 *
 * A server-issued redirect rather than anything client-side, because the CSP in
 * index.ts blocks both of the browser-side options (`formAction: 'self'` kills a
 * form POST to the IdP, `connectSrc: 'self'` kills a fetch) while governing
 * neither a 302 nor a `location.assign()`. See the header of services/oidc.ts.
 *
 * Every failure path redirects rather than rendering an error, so an operator
 * with a broken issuer sees the login screen with a reason on it instead of a
 * bare JSON error page in the middle of a navigation.
 */
authRouter.get(
  '/oidc/login',
  oidcLoginRateLimit,
  asyncHandler(async (req, res) => {
    try {
      const { url, transaction } = await buildAuthorizationUrl(fallbackRedirectUri(req));
      res.cookie(OIDC_TX_COOKIE, transaction, oidcTxCookieOpts(req)).redirect(302, url);
    } catch (err) {
      res.redirect(302, ssoFailureRedirect(reportSsoFailure(err)));
    }
  }),
);

/**
 * Finish the flow: validate, exchange, authorize, and mint the session.
 *
 * The transaction cookie is cleared FIRST, before anything can fail, so that
 * every exit from this handler (success, refusal, crash) leaves the browser
 * without a transaction. Combined with the single-use id check inside
 * services/oidc.ts, that makes a replay of the same callback URL fail on both
 * halves: no cookie, and a consumed id even if a copy of the cookie survives
 * somewhere.
 */
authRouter.get(
  '/oidc/callback',
  oidcCallbackRateLimit,
  asyncHandler(async (req, res) => {
    // clearCookie must be given the same path the cookie was set with, or the
    // browser keeps the original and only shadows it.
    res.clearCookie(OIDC_TX_COOKIE, { path: OIDC_TX_PATH });

    const transaction = req.cookies?.[OIDC_TX_COOKIE];
    const query = new URLSearchParams(
      // req.query is Express's parsed object, which can hold arrays and nested
      // objects for repeated or bracketed parameters. The OIDC callback is a
      // flat set of scalars, so it is read back off the raw URL instead: one
      // parser, no shape surprises, and it is the same string the state check
      // and the library both see.
      req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '',
    );

    let identity;
    try {
      identity = await handleCallback(
        typeof transaction === 'string' ? transaction : undefined,
        query,
      );
    } catch (err) {
      res.redirect(302, ssoFailureRedirect(reportSsoFailure(err)));
      return;
    }

    // Persist the identity BEFORE minting the session. It grants nothing today
    // (every allowlisted subject maps onto the single owner), but recording it is
    // the entire reason this app does SSO natively instead of putting a
    // forward-auth proxy in front of itself: an implementation that authenticates
    // and then discards the subject gives working SSO and zero groundwork. See
    // services/oidc-users.ts. The write is debounced and cannot throw.
    recordOidcLogin({
      iss: identity.iss,
      sub: identity.sub,
      name: identity.name,
      email: identity.email,
      preferredUsername: identity.preferredUsername,
    });

    // One audit line naming WHO. `req.ip` is only as trustworthy as `trust proxy`
    // is accurate (see config.ts), which is why it is recorded as context rather
    // than as identity; the subject is the identity.
    auditCredentialUse('sso', 'login', req.ip, `${identity.iss}|${identity.sub}`);

    // The nested `idp` claim, never the top-level `sub`. See issueToken.
    const token = await issueToken({ iss: identity.iss, sub: identity.sub });
    res.cookie(COOKIE_NAME, token, cookieOpts(req)).redirect(302, '/');
  }),
);

/**
 * Read the session claims for a request that `requireAuth` has already accepted.
 *
 * This repeats middleware/auth.ts's token extraction, which is duplication and
 * is worth one sentence of justification. The alternative was to have the
 * middleware attach the decoded session to the request, which means changing a
 * file this change does not own and putting a decode on the hot path of every
 * authenticated request for the benefit of one endpoint. Two lines here, on a
 * route that runs once per page load, is the cheaper trade. It cannot
 * disagree with the middleware about whether the caller is authenticated,
 * because both go through the same `readSession`/`verifyToken` pair and this one
 * only ever runs after the middleware has said yes.
 */
async function sessionFor(req: Request): Promise<OwnerSession | null> {
  const header = req.headers.authorization;
  const token = req.cookies?.[COOKIE_NAME] || (header?.startsWith('Bearer ') ? header.slice(7) : '');
  if (typeof token !== 'string' || !token) return null;
  return readSession(token);
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
    //
    // `ssoEnabled` is the one thing added to it, and it is a single boolean on
    // purpose. The login screen has to decide whether to render an SSO button
    // before anyone has authenticated, so SOMETHING has to be public here. What
    // is not public is anything about who: no issuer URL, no client id, no
    // provider name, no allowlist shape, no hint about whether a given person
    // would be let in. An unauthenticated scan learns exactly one bit, "this
    // instance can federate", which it would learn anyway the moment it loaded
    // the login page and saw the button. Everything past that button is behind
    // the IdP.
    res.json({ passwordSet: true, ssoEnabled: await isOidcAvailable() });
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
      // `sso: false` unconditionally: this route only ever mints a session from
      // a password, so the field is a constant here. It is reported anyway so
      // that /auth/login and /auth/me have the same shape and the client can
      // read one field in one place rather than inferring it from which endpoint
      // answered.
      .json({ ok: true, sso: false, mustChangePassword: !(await hasCustomPassword()) });
  }),
);

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' }).json({ ok: true });
});

/**
 * Who am I, and does this session have to change its password?
 *
 * THE SSO EXEMPTION, which is the reason this route grew a second field.
 * `mustChangePassword` is derived from `!hasCustomPassword()`, it gates the
 * ENTIRE app at web/src/App.tsx, and the only way through the screen it renders
 * is `changePassword('123456', ...)`. A user who signed in through the IdP on an
 * instance that never moved off the default password would therefore be shown a
 * wall whose only exit is a password they do not have and were never meant to
 * need: they authenticated at the IdP, they were never issued a local password,
 * and there is nothing they can type. That is a total lockout produced entirely
 * by a flag meaning to be helpful.
 *
 * The exemption is computed HERE, on the server, rather than left to the client
 * to work out from the `sso` flag. Both are reported, and the split of
 * responsibility is deliberate: `mustChangePassword` is the decision (the client
 * gates on it exactly as it always has, and a client that has never heard of SSO
 * keeps working), while `sso` is the explanation (it lets the UI say "signed in
 * as a federated user" and suppress the change-password prompts in settings).
 * Deriving the gate on the client would mean every future client had to
 * re-implement the exemption correctly, and getting it wrong would lock a user
 * out rather than merely mis-render a label.
 *
 * Note what the exemption does NOT do: it does not weaken the password, it does
 * not disable the local login, and it does not mark the instance as having a
 * custom password. An operator who also uses the password still sees the prompt
 * on a password session, because the flag is a property of the SESSION, not of
 * the instance.
 */
authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const session = await sessionFor(req);
    const sso = Boolean(session?.idp);
    res.json({
      authenticated: true,
      sso,
      mustChangePassword: !sso && !(await hasCustomPassword()),
    });
  }),
);
