import type { Request } from 'express';

/**
 * The single home for how this server marks a credential-bearing cookie.
 *
 * WHY THIS MODULE EXISTS. Two cookies on this server are bearer credentials: the
 * owner session cookie set by `routes/auth.ts`, and the per-share unlock cookie
 * set by `routes/shares.ts`. They differ only in name and lifetime. Everything
 * that makes them safe (httpOnly, SameSite, the `Secure` decision, the `path`
 * they are scoped to) is identical, and it has to be, because both are "hold
 * this string, get access" tokens travelling over the same transport.
 *
 * Those attributes used to be written out twice, once per router, and the two
 * copies agreed byte for byte. That is not a stable state, it is the moment
 * before divergence: the next person to tighten one copy has no mechanical
 * reason to discover the other, and reviewers reading either file see a rule
 * that looks locally complete. The copy most likely to be left behind is the
 * share one, because it lives in a file about publishing notes rather than a
 * file about authentication, and that is precisely the credential guarding a
 * note published to the open internet. Import beats transcribe.
 *
 * COOKIE_SECURE, and why the default is 'auto' rather than `true`. A `Secure`
 * cookie is silently dropped by browsers over plain `http://`: no error, no
 * console warning, the cookie simply never arrives. This project explicitly
 * supports plain-HTTP self-hosting (a LAN box, a NAS, a container behind
 * Tailscale), so hardcoding `true` would break those deployments in the most
 * confusing way available, with every subsequent API call answering 401 and the
 * unlock form looping forever with nothing to explain why. Tying it to NODE_ENV
 * has the same defect and adds a second one, since it makes a security attribute
 * depend on an env var that `.env.example` leaves commented out.
 *
 * So the default follows the request's actual transport. `req.secure` is
 * Express's answer to "did this arrive over TLS", and it honours
 * X-Forwarded-Proto through the `trust proxy` setting, which is what makes a
 * TLS-terminating reverse proxy work without extra configuration. Operators who
 * want the decision pinned rather than inferred set COOKIE_SECURE=true or
 * COOKIE_SECURE=false; the desktop shell pins it to 'false' because it always
 * talks to 127.0.0.1 over plain HTTP.
 *
 * The residual, stated rather than argued away: with the shipped default
 * `trust proxy: true`, a client connecting directly can send
 * `X-Forwarded-Proto: http` and make `req.secure` false, dropping `Secure` from
 * the cookie it is about to receive. That costs the attacker nothing they did
 * not already have (it is their own cookie, on their own connection) and cannot
 * be aimed at a third party, so it is a wart rather than a hole. Setting
 * COOKIE_SECURE=true on an HTTPS-only deployment removes it.
 *
 * Read once at module load, deliberately: a cookie attribute that could change
 * under the running process would mean two requests in the same session get
 * different protection with nothing in the logs to say when it flipped.
 */
const COOKIE_SECURE = (process.env.COOKIE_SECURE ?? 'auto').toLowerCase();

/** Should a cookie set on this request carry the `Secure` attribute? */
export function cookieSecure(req: Request): boolean {
  if (COOKIE_SECURE === 'true') return true;
  if (COOKIE_SECURE === 'false') return false;
  return req.secure;
}

/**
 * The attribute set every credential cookie on this server gets.
 *
 * Declared as an explicit interface rather than left to inference so that
 * `sameSite` keeps its literal type: inferred, it would widen to `string` and
 * stop being assignable to Express's `CookieOptions`, which is the kind of
 * breakage that only shows up at the call site.
 */
export interface CredentialCookieOptions {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  maxAge: number;
}

/**
 * Options for a credential cookie with the given lifetime.
 *
 * `httpOnly` keeps the token out of `document.cookie`, so an XSS in a rendered
 * note cannot read it, and it is what lets an embedded `<img>` on a share page
 * carry the unlock cookie automatically without any script involvement.
 *
 * `sameSite: 'lax'` rather than 'strict' because 'strict' would drop the cookie
 * on the very navigation that matters most: following a share link, or returning
 * to the app from an external link, would land the visitor on a page that
 * behaves as though they were signed out.
 *
 * `path: '/'` because both cookies are needed across unrelated prefixes. The
 * session cookie is read by `/api/*`, `/auth/*` and the WebSocket upgrade at
 * `/ws`; the unlock cookie is read by both `/public/shares/<id>/*` and the SSR
 * page at `/share/<id>`. Narrowing the path would silently break one of the two
 * surfaces in each case.
 *
 * `maxAge` is the caller's, because the two lifetimes are a deliberate
 * difference rather than an oversight: a session is the owner's own device and
 * lasts 30 days, while an unlock is a visitor proving knowledge of a password
 * for one published note and lasts 12 hours.
 */
export function credentialCookieOpts(req: Request, maxAgeMs: number): CredentialCookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(req),
    path: '/',
    maxAge: maxAgeMs,
  };
}
