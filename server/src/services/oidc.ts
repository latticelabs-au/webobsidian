import { createHash, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import * as oidcClient from 'openid-client';
import { getSettings } from './settings.js';
import { redactUrlCreds } from '../lib/redact.js';

/**
 * The OIDC authorization-code flow, server side (FR-15).
 *
 * WHY THE WHOLE FLOW LIVES ON THE SERVER, since the obvious instinct is to do it
 * in the SPA and it does not work here. Two independent walls, both in
 * server/src/index.ts:
 *
 *  - The CSP sets `formAction: ["'self'"]`, so a `<form action="https://idp/...">`
 *    is refused by the browser outright, and `connectSrc: ["'self'", 'ws:', 'wss:']`
 *    so a browser-side `fetch()` to the IdP is refused as well. CSP governs
 *    neither `location.assign()` nor a server-issued 302, which is precisely the
 *    seam this module is built on: the browser hits OUR endpoint, and WE redirect.
 *  - The token exchange needs the client secret. A public (PKCE-only) client
 *    would avoid that, but it also gives up the one thing that makes the callback
 *    safe to accept from a browser that we did not authenticate.
 *
 * WHY response_mode=query and not form_post. Also two independent reasons, and
 * either one on its own is fatal: `index.ts` registers `express.json()` and no
 * `express.urlencoded()` anywhere, so a form_post body arrives EMPTY (Express
 * leaves `req.body` undefined and the code parameter simply is not there); and a
 * `SameSite=Lax` cookie is not sent on a cross-site top-level POST, so the
 * transaction cookie below would be invisible on exactly the request that has to
 * read it. `query` is also the spec default, which matters here because this
 * IdP's discovery document omits `response_modes_supported` entirely.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO: it does not mint a session, and it
 * does not know what a session is. It returns a verified identity and nothing
 * else. `routes/auth.ts` decides what that identity is worth, and
 * `services/auth.ts` decides what a token carrying it looks like. Keeping the
 * protocol work and the authorization decision in separate files is what makes
 * the "IdP subject must never become the token's `sub`" rule (see issueToken)
 * enforceable by reading one function rather than by auditing a flow.
 */

/** ---- Settings contract ---------------------------------------------------- */

/**
 * The `oidc` settings block, as this module needs to READ it.
 *
 * `services/settings.ts` owns the zod schema, the defaults, the redaction and the
 * PUT allowlist; this is the consumer's view of the same block, re-derived at
 * runtime rather than trusted structurally. That is not duplication for its own
 * sake:
 *
 *  - settings.json is hand-editable, and `loadSettings()` treats a parse failure
 *    as "file unusable" and rewrites from defaults, which is why the schema heals
 *    bad values instead of throwing. A healed value is a value this module still
 *    has to cope with.
 *  - Reading through a narrow, validated lens means a settings block that is
 *    absent (an older settings.json, a downgrade/upgrade cycle) reads as "not
 *    configured" and the SSO button simply does not appear, rather than throwing
 *    on a property access somewhere inside the redirect handler.
 *
 * Every string is trimmed EXCEPT `clientSecret`. Surrounding whitespace in a URL
 * or a client id is always a paste artefact; in a secret it may be part of the
 * secret, and silently trimming key material produces an authentication failure
 * that no amount of staring at the settings page explains. This mirrors the rule
 * already documented on the LiveSync block for `passphrase`.
 */
export interface OidcSettings {
  enabled: boolean;
  /** Issuer identifier, no trailing slash (e.g. `https://auth.example.com`). */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /**
   * The exact redirect URI registered with the IdP. Empty means "derive it from
   * the incoming request", which is convenient for a single-host install and
   * wrong the moment a proxy rewrites the path or the host, so an operator
   * behind anything non-trivial should set it explicitly.
   */
  redirectUri: string;
  /** See `isAllowed()`. All three empty means NOBODY is allowed in. */
  allowedSubjects: string[];
  allowedGroups: string[];
  allowedEmails: string[];
}

function claimTrimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Read the block off the settings object.
 *
 * The `as unknown as` is doing real work and is not laziness: this file must
 * compile and behave correctly whether or not `services/settings.ts` has yet
 * grown the block (the two are edited independently), and a structural read is
 * the only form that is honest about that. Everything below re-validates, so
 * nothing is being smuggled past the type system that is not immediately checked.
 */
export async function getOidcSettings(): Promise<OidcSettings> {
  const s = await getSettings();
  const raw = (s as unknown as { oidc?: unknown }).oidc;
  const block: Record<string, unknown> =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    enabled: block.enabled === true,
    // Trailing slashes are stripped for the same reason the LiveSync URI strips
    // them: the issuer identifier is compared byte-for-byte against the `iss`
    // the discovery document reports, and "one configuration, one meaning" is
    // cheaper to guarantee here than to debug later.
    issuer: claimTrimmed(block.issuer).replace(/\/+$/, ''),
    clientId: claimTrimmed(block.clientId),
    clientSecret: typeof block.clientSecret === 'string' ? block.clientSecret : '',
    redirectUri: claimTrimmed(block.redirectUri).replace(/\/+$/, ''),
    allowedSubjects: stringList(block.allowedSubjects),
    allowedGroups: stringList(block.allowedGroups),
    allowedEmails: stringList(block.allowedEmails),
  };
}

/** True when the block is complete enough that a login attempt can succeed. */
function isConfigured(s: OidcSettings): boolean {
  return s.enabled && Boolean(s.issuer) && Boolean(s.clientId) && Boolean(s.clientSecret);
}

/**
 * Whether the UI should offer an SSO button.
 *
 * Deliberately checks completeness, not just `enabled`. A button that leads
 * straight to an error page is worse than no button: the operator sees SSO
 * "working" in the UI and only discovers the missing client secret when a user
 * cannot log in. This never performs discovery, so it stays cheap enough for the
 * unauthenticated `/auth/status` route to call on every page load.
 */
export async function isOidcAvailable(): Promise<boolean> {
  return isConfigured(await getOidcSettings());
}

/** ---- Errors --------------------------------------------------------------- */

/**
 * The complete set of reasons an SSO attempt can end badly, as a closed union.
 *
 * These codes are the ONLY thing that ever reaches the browser on a failure. The
 * underlying error text can contain the issuer URL, a token endpoint response
 * body, or a client id, and an unauthenticated caller can drive this whole path
 * by simply visiting `/auth/oidc/login`, so the detail stays server-side in the
 * log and the redirect carries an opaque code. A closed union rather than a
 * free-form string is what makes that guarantee checkable at the call site.
 */
export type OidcErrorCode =
  /** No `oidc` block, disabled, or missing issuer/clientId/clientSecret. */
  | 'not_configured'
  /** The issuer is unreachable, is not an OIDC issuer, or disagrees about `iss`. */
  | 'discovery_failed'
  /** No transaction cookie, expired, tampered with, or already used. */
  | 'invalid_state'
  /** The IdP itself refused (`?error=access_denied`, `?error=invalid_scope`, ...). */
  | 'idp_rejected'
  /** Code exchange or ID token validation failed. */
  | 'exchange_failed'
  /** Exchange succeeded but produced no usable subject. */
  | 'no_identity'
  /** Authenticated, but not on any allowlist. */
  | 'not_allowed';

export class OidcError extends Error {
  readonly code: OidcErrorCode;
  /** Already redacted. Safe to log; never sent to a client. */
  readonly detail: string;

  constructor(code: OidcErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'OidcError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Turn anything thrown by the OIDC stack into a string that is safe to log.
 *
 * Two passes, because the two libraries leak in two different shapes:
 *
 *  1. `redactUrlCreds` (the same helper the git service uses) strips `user:pass@`
 *    out of any URL in the message. An issuer URL should never carry userinfo,
 *    but a hand-edited settings.json can perfectly well contain one, and the
 *    error text quotes the URL it was fetching.
 *  2. The client secret is removed explicitly. `ClientSecretPost` puts it in the
 *    token request BODY, and while oauth4webapi's errors quote response bodies
 *    rather than request bodies, "the library does not currently echo it" is a
 *    property of a dependency version, not an invariant we control. One
 *    `replaceAll` is a cheap way to stop a future release from writing the
 *    instance's client secret into the operator's log file.
 */
function describeError(err: unknown, clientSecret?: string): string {
  let text = redactUrlCreds(err instanceof Error ? err.message : String(err));
  // A `cause` is where oauth4webapi puts the interesting half of a network
  // failure ("fetch failed" on its own tells an operator nothing).
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
  if (cause) {
    const causeText = redactUrlCreds(cause instanceof Error ? cause.message : String(cause));
    if (causeText && !text.includes(causeText)) text = `${text} (${causeText})`;
  }
  if (clientSecret && clientSecret.length > 0) text = text.split(clientSecret).join('***');
  return text;
}

/** ---- Discovery ------------------------------------------------------------ */

/** Seconds. Long enough for a cold IdP, short enough that a login does not hang. */
const DISCOVERY_TIMEOUT_SECONDS = 15;

interface DiscoveryCacheEntry {
  key: string;
  promise: Promise<oidcClient.Configuration>;
}

let discoveryCache: DiscoveryCacheEntry | null = null;

/**
 * Cache identity for a discovered configuration.
 *
 * Hashing rather than concatenating the raw values keeps the client secret out
 * of a long-lived module-level string. It is in memory anyway (the settings
 * cache holds it), so this is not a secrecy boundary; it is about the value not
 * being sitting in a variable that some future diagnostic prints.
 */
function cacheKey(s: OidcSettings): string {
  return createHash('sha256')
    .update(JSON.stringify([s.issuer, s.clientId, s.clientSecret]))
    .digest('hex');
}

/** Loopback hosts, where plain http is a development reality rather than a bug. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/**
 * Discover the issuer's metadata, lazily and exactly once per configuration.
 *
 * Three properties worth stating, because each one is a bug that this shape
 * avoids:
 *
 *  - **Lazy.** Discovery is a network call to a third party. Doing it at boot
 *    would mean an IdP that is down (or a typo in the issuer) delays or fails
 *    server startup, which is precisely the "one dependency takes the whole
 *    daemon down" failure mode this codebase spends so much effort avoiding
 *    elsewhere. Nobody who is not logging in should pay for it.
 *  - **Cached on the CONFIGURATION, not forever.** The key covers issuer, client
 *    id and secret, so changing any of them in settings invalidates the cache on
 *    the next login with no restart and no explicit invalidation call.
 *  - **A FAILURE IS NOT CACHED.** The rejected promise is evicted, so the next
 *    login retries. Caching the rejection would turn a transient DNS blip into a
 *    permanently broken SSO button until someone restarted the process, which is
 *    the exact class of silent, sticky failure the reference bridge documents at
 *    length (a failed connect needs a fresh attempt, not a retry against the
 *    dead object).
 *
 * The failure is SURFACED rather than swallowed: every caller gets an OidcError
 * whose `detail` names what went wrong, and `routes/auth.ts` logs it. A
 * misconfigured issuer must never present as a button that quietly does nothing.
 */
async function getConfiguration(s: OidcSettings): Promise<oidcClient.Configuration> {
  const key = cacheKey(s);
  if (discoveryCache && discoveryCache.key === key) return discoveryCache.promise;

  const entry: DiscoveryCacheEntry = { key, promise: discover(s) };
  discoveryCache = entry;
  entry.promise.catch(() => {
    // Only evict if we are still the current entry: a settings change during an
    // in-flight discovery must not delete the newer entry that replaced us.
    if (discoveryCache === entry) discoveryCache = null;
  });
  return entry.promise;
}

async function discover(s: OidcSettings): Promise<oidcClient.Configuration> {
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(s.issuer);
  } catch {
    throw new OidcError('not_configured', `oidc.issuer is not a URL: ${JSON.stringify(s.issuer)}`);
  }

  // Plain http is refused except on loopback. The authorization code and the ID
  // token both travel over this channel; over http on a real network the flow
  // authenticates nobody, it just looks like it does. Loopback is carved out
  // because a developer running an IdP on 127.0.0.1 has no MITM to worry about,
  // and refusing it would push people towards disabling TLS checks globally,
  // which is strictly worse.
  const insecure = issuerUrl.protocol === 'http:' && isLoopbackHost(issuerUrl.hostname);
  if (issuerUrl.protocol !== 'https:' && !insecure) {
    throw new OidcError(
      'not_configured',
      `oidc.issuer must be https (http is permitted only on loopback), got ${issuerUrl.protocol}//`,
    );
  }
  // `execute` is openid-client v6's supported hook for relaxing the transport
  // check; it is applied to the Configuration, which is why it also has to be
  // re-applied by hand if the configuration is rebuilt below.
  const execute = insecure ? [oidcClient.allowInsecureRequests] : undefined;

  const clientMetadata: Partial<oidcClient.ClientMetadata> = {
    client_secret: s.clientSecret,
    // Pin the ID token signature algorithm rather than accepting whatever the
    // token response happens to carry. oauth4webapi honours
    // `id_token_signed_response_alg` when it validates the JWT
    // (`checkSigningAlgorithm`), and this IdP advertises exactly
    // `id_token_signing_alg_values_supported: ["RS256"]`, so pinning costs
    // nothing and closes the door on an algorithm downgrade if the IdP's
    // metadata ever grows a weaker option.
    id_token_signed_response_alg: 'RS256',
  };

  let config: oidcClient.Configuration;
  try {
    config = await oidcClient.discovery(issuerUrl, s.clientId, clientMetadata, undefined, {
      execute,
      timeout: DISCOVERY_TIMEOUT_SECONDS,
    });
  } catch (err) {
    throw new OidcError(
      'discovery_failed',
      `could not discover ${redactUrlCreds(issuerUrl.href)}: ${describeError(err, s.clientSecret)}`,
    );
  }

  // Client authentication method, negotiated rather than assumed.
  //
  // openid-client picks `client_secret_post` whenever a secret is present. That
  // is the pragmatic choice and the one this IdP accepts, but OpenID Connect
  // Discovery says the DEFAULT when `token_endpoint_auth_methods_supported` is
  // absent is `client_secret_basic`, and some servers really do only implement
  // one of the two. So: keep the library's choice unless the server explicitly
  // publishes a list that excludes post and includes basic, in which case rebuild
  // the configuration with basic. No second network round trip is involved, the
  // metadata is already in hand.
  const metadata = config.serverMetadata();
  const authMethods = metadata.token_endpoint_auth_methods_supported;
  if (
    Array.isArray(authMethods) &&
    !authMethods.includes('client_secret_post') &&
    authMethods.includes('client_secret_basic')
  ) {
    config = new oidcClient.Configuration(
      metadata,
      s.clientId,
      clientMetadata,
      oidcClient.ClientSecretBasic(s.clientSecret),
    );
    // Rebuilding drops the transport relaxation applied via `execute` above, so
    // re-apply it or a loopback http issuer breaks only on servers that take
    // this branch, which is the worst kind of bug to find.
    if (insecure) oidcClient.allowInsecureRequests(config);
  }
  config.timeout = DISCOVERY_TIMEOUT_SECONDS;
  return config;
}

/** ---- The transaction (state / nonce / PKCE verifier) ---------------------- */

/**
 * How long a login attempt may sit at the IdP before the transaction expires.
 *
 * Ten minutes, not one: the user may have to type a TOTP code, approve a
 * passkey, or complete an enrolment step on the IdP's side. It is also the
 * lifetime of the cookie that carries it, so a stale tab cannot resurrect a
 * transaction from an hour ago.
 */
export const TRANSACTION_TTL_SECONDS = 600;

/**
 * The `sub` value on the transaction JWT.
 *
 * This is the SAME discriminator rule that `services/auth.ts` documents on
 * `verifyToken`, applied to a third token kind. One HMAC secret
 * (`auth.jwtSecret`) signs owner sessions (`sub: 'owner'`), share unlock cookies
 * (`sub: 'share'`) and now this, so `sub` is the only thing standing between a
 * pre-authentication artefact and a full owner session. `verifyToken` requires
 * `sub === 'owner'`, so a transaction cookie replayed as a session cookie is
 * refused, and this module requires `sub === 'oidc-tx'`, so a session cookie
 * replayed as a transaction is refused too. Both directions, explicitly.
 */
const TRANSACTION_SUBJECT = 'oidc-tx';

interface TransactionClaims {
  jti: string;
  /** `state`, echoed by the IdP and compared before anything else happens. */
  st: string;
  /** `nonce`, bound into the ID token by the IdP and checked on the way back. */
  no: string;
  /** The PKCE code verifier. Named `pk` so it is never confused with `cv`, which
   *  in this codebase means the credential fingerprint on a session token. */
  pk: string;
  /** The exact redirect_uri sent in the authorization request. */
  ru: string;
}

/**
 * Single-use enforcement for transactions, in memory.
 *
 * Clearing the cookie on the callback response is not sufficient on its own: the
 * browser may have the cookie in more than one place (two tabs, a restored
 * session), and an attacker who captured the cookie plus a callback URL could
 * otherwise replay the pair. There is no session store in this app and adding
 * one for this would be a large change for a small window, so the guard is a Map
 * of consumed ids with the same TTL as the transaction itself. It resets on
 * restart, which is harmless precisely because every entry it could have held
 * has expired within ten minutes anyway.
 *
 * The cap bounds memory. Reaching it requires more than MAX_CONSUMED distinct
 * VALID transactions inside one TTL window, which the callback rate limiter in
 * routes/auth.ts makes impractical; eviction is oldest-first so the entries most
 * likely to still matter are the last to go.
 */
const MAX_CONSUMED_TRANSACTIONS = 10_000;
const consumedTransactions = new Map<string, number>();

function consumeTransactionId(jti: string, now: number): boolean {
  for (const [id, expiresAt] of consumedTransactions) {
    if (expiresAt <= now) consumedTransactions.delete(id);
  }
  if (consumedTransactions.has(jti)) return false;
  if (consumedTransactions.size >= MAX_CONSUMED_TRANSACTIONS) {
    const oldest = [...consumedTransactions.entries()].sort((a, b) => a[1] - b[1]);
    const evict = consumedTransactions.size - MAX_CONSUMED_TRANSACTIONS + 1;
    for (let i = 0; i < evict; i++) consumedTransactions.delete(oldest[i][0]);
  }
  consumedTransactions.set(jti, now + TRANSACTION_TTL_SECONDS * 1000);
  return true;
}

async function sealTransaction(claims: TransactionClaims): Promise<string> {
  const s = await getSettings();
  return jwt.sign({ sub: TRANSACTION_SUBJECT, ...claims }, s.auth.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: TRANSACTION_TTL_SECONDS,
  });
}

async function openTransaction(sealed: string): Promise<TransactionClaims> {
  const s = await getSettings();
  let payload: unknown;
  try {
    payload = jwt.verify(sealed, s.auth.jwtSecret, { algorithms: ['HS256'] });
  } catch (err) {
    // Covers expiry, a bad signature and outright garbage. They are one answer
    // to the caller on purpose: telling an unauthenticated visitor WHICH of
    // those it was is free information about the instance's secret.
    throw new OidcError('invalid_state', `transaction cookie rejected: ${describeError(err)}`);
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new OidcError('invalid_state', 'transaction cookie has no payload');
  }
  const c = payload as Record<string, unknown>;
  if (c.sub !== TRANSACTION_SUBJECT) {
    // A token signed with the same secret but minted for something else (an
    // owner session, a share unlock). See the note on TRANSACTION_SUBJECT.
    throw new OidcError('invalid_state', 'transaction cookie is not an OIDC transaction');
  }
  const { jti, st, no, pk, ru } = c;
  if (
    typeof jti !== 'string' ||
    typeof st !== 'string' ||
    typeof no !== 'string' ||
    typeof pk !== 'string' ||
    typeof ru !== 'string' ||
    !jti ||
    !st ||
    !no ||
    !pk ||
    !ru
  ) {
    throw new OidcError('invalid_state', 'transaction cookie is missing required fields');
  }
  if (!consumeTransactionId(jti, Date.now())) {
    throw new OidcError('invalid_state', 'transaction has already been used');
  }
  return { jti, st, no, pk, ru };
}

/** ---- Authorization request ------------------------------------------------ */

export interface AuthorizationRequest {
  /** Absolute URL to 302 the browser to. */
  url: string;
  /**
   * Opaque, signed, short-lived. The caller must persist it (a cookie) and hand
   * it back to `handleCallback`. It carries the state, the nonce, the PKCE
   * verifier and the redirect URI, so the caller never has to hold four values
   * and never has to decide how to bind them together.
   */
  transaction: string;
}

/**
 * Which scopes to ask for.
 *
 * `groups` is requested only when the issuer advertises it (or advertises
 * nothing at all, in which case we cannot tell and the spec says a request for
 * an unsupported scope is the server's business). Asking unconditionally would
 * make this module unusable against any issuer without a `groups` scope, since
 * some servers hard-fail an unknown scope rather than ignoring it, and the
 * failure would land as an opaque `invalid_scope` on the callback.
 */
function scopesFor(config: oidcClient.Configuration): string {
  const supported = config.serverMetadata().scopes_supported;
  const scopes = ['openid', 'profile', 'email'];
  if (!Array.isArray(supported) || supported.includes('groups')) scopes.push('groups');
  return scopes.join(' ');
}

/**
 * Build the authorization URL and the transaction that has to come back with it.
 *
 * PKCE, AND THE REASON THIS DOES NOT USE A HELPER. This IdP's discovery document
 * has NO `code_challenge_methods_supported`, so anything that gates PKCE on
 * server metadata concludes the server does not support it and quietly omits the
 * challenge. openid-client v6 exposes that belief as
 * `config.serverMetadata().supportsPKCE()`, and it is ADVISORY ONLY: verified
 * against the shipped v6.8.4 build, `buildAuthorizationUrl()` copies the
 * parameters it is given onto the authorization endpoint verbatim and never
 * consults that field, and `authorizationCodeGrant()` forwards
 * `checks.pkceCodeVerifier` to oauth4webapi's `authorizationCodeGrantRequest()`,
 * which sets `code_verifier` whenever the verifier is not its `nopkce` sentinel,
 * again without consulting the metadata. So passing `code_challenge` and
 * `code_challenge_method` explicitly here, and the verifier explicitly in
 * `handleCallback`, genuinely sends S256 PKCE. Nothing is being dropped, and
 * nothing is relying on the library to infer it.
 *
 * That said, an unadvertised PKCE method means the IdP is not obliged to ENFORCE
 * it: a server that ignores `code_challenge` will happily exchange a code
 * without a verifier. PKCE is therefore defence in depth here, not the load
 * bearing check. What actually binds the callback to this browser is the signed,
 * single-use transaction cookie: `state` must match, `nonce` must appear inside
 * the signed ID token, and the transaction id must not have been used before.
 */
export async function buildAuthorizationUrl(
  fallbackRedirectUri: string,
): Promise<AuthorizationRequest> {
  const s = await getOidcSettings();
  if (!isConfigured(s)) {
    throw new OidcError('not_configured', 'the oidc settings block is disabled or incomplete');
  }
  const config = await getConfiguration(s);
  const redirectUri = s.redirectUri || fallbackRedirectUri;

  const state = oidcClient.randomState();
  const nonce = oidcClient.randomNonce();
  const codeVerifier = oidcClient.randomPKCECodeVerifier();
  const codeChallenge = await oidcClient.calculatePKCECodeChallenge(codeVerifier);

  const url = oidcClient.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: scopesFor(config),
    response_type: 'code',
    // Explicit even though it is the spec default, because this IdP publishes no
    // `response_modes_supported` at all and "the default" is a claim about a
    // document that does not exist. Stating it removes the ambiguity. See the
    // file header for why form_post would break two separate things here.
    response_mode: 'query',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  const transaction = await sealTransaction({
    jti: randomUUID(),
    st: state,
    no: nonce,
    pk: codeVerifier,
    // The redirect URI travels INSIDE the transaction rather than being
    // re-derived on the callback. openid-client rebuilds `redirect_uri` for the
    // token request by stripping the query off the URL it is handed, and the
    // token endpoint compares it byte-for-byte against the one in the
    // authorization request. Re-deriving from the callback request's own Host
    // header would make that comparison depend on two requests agreeing about
    // the host, which is not something we control behind a proxy.
    ru: redirectUri,
  });

  return { url: url.href, transaction };
}

/** ---- Callback ------------------------------------------------------------- */

/** A verified end-user identity. Nothing here is trusted before this point. */
export interface OidcIdentity {
  /** The issuer, as validated by the library against the discovered metadata. */
  iss: string;
  /** The IdP's subject identifier. Stable, opaque, and NEVER a session `sub`. */
  sub: string;
  name: string;
  email: string;
  emailVerified: boolean;
  preferredUsername: string;
  groups: string[];
}

/** An object with claim-shaped access. Both `IDToken` and `UserInfoResponse` fit. */
type ClaimSource = { readonly [claim: string]: unknown };

function claimString(source: ClaimSource, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value.trim() : '';
}

function claimStringList(source: ClaimSource, key: string): string[] {
  return stringList(source[key]);
}

function claimBoolean(source: ClaimSource, key: string): boolean {
  const value = source[key];
  // Some issuers send `email_verified` as the STRING "true". Accepting both is
  // not laxity: the alternative is silently treating a verified address as
  // unverified, which (see `isAllowed`) would lock out every user on an
  // email-allowlisted instance for a reason nothing in the UI could explain.
  return value === true || value === 'true';
}

function readProfile(source: ClaimSource): Omit<OidcIdentity, 'iss' | 'sub'> {
  return {
    name: claimString(source, 'name'),
    email: claimString(source, 'email'),
    emailVerified: claimBoolean(source, 'email_verified'),
    preferredUsername: claimString(source, 'preferred_username'),
    groups: claimStringList(source, 'groups'),
  };
}

/**
 * Would the userinfo endpoint tell us something we actually need?
 *
 * The ID token is the authoritative, signature-verified source and is preferred
 * in every case. This exists because an IdP is free to put `groups` (or even
 * `email`) only at userinfo, and an allowlist that silently evaluates against a
 * claim the token never carried fails closed for everybody, which looks exactly
 * like a broken deployment. So: one extra request, only when a claim the
 * ALLOWLIST depends on is missing, or when there is nothing at all to display.
 */
function needsUserInfo(
  profile: Omit<OidcIdentity, 'iss' | 'sub'>,
  s: OidcSettings,
): boolean {
  if (s.allowedGroups.length > 0 && profile.groups.length === 0) return true;
  if (s.allowedEmails.length > 0 && !profile.email) return true;
  return !profile.name && !profile.email && !profile.preferredUsername;
}

/**
 * Validate the callback, exchange the code, and return a verified identity.
 *
 * The order is deliberate and each step is refused before the next one costs
 * anything:
 *
 *  1. Open the transaction cookie (signature, expiry, single use).
 *  2. If the IdP sent `?error=`, stop. There is no code to exchange.
 *  3. Compare `state` ourselves BEFORE calling into the library, so a mismatch
 *     reports `invalid_state` rather than being folded into a generic exchange
 *     failure. The library checks it again via `expectedState`; two checks of the
 *     same thing is the correct amount here, since one of them exists to produce
 *     a good diagnostic and the other is the one that is load bearing.
 *  4. Exchange the code with the PKCE verifier. The library validates the ID
 *     token's RS256 signature against the discovered `jwks_uri`, its `iss`,
 *     `aud`, `exp`, and the `nonce`.
 *  5. Apply the allowlist. Authentication is not authorization.
 */
export async function handleCallback(
  sealedTransaction: string | undefined,
  query: URLSearchParams,
): Promise<OidcIdentity> {
  const s = await getOidcSettings();
  if (!isConfigured(s)) {
    throw new OidcError('not_configured', 'the oidc settings block is disabled or incomplete');
  }
  if (!sealedTransaction) {
    throw new OidcError('invalid_state', 'no transaction cookie on the callback');
  }
  const tx = await openTransaction(sealedTransaction);

  const idpError = query.get('error');
  if (idpError) {
    // The IdP's own refusal (the user pressed "deny", the client is not
    // authorised for a scope, ...). Its `error_description` is attacker-influenced
    // free text, so it is logged and never rendered.
    throw new OidcError(
      'idp_rejected',
      `the identity provider refused: ${idpError} ${query.get('error_description') ?? ''}`.trim(),
    );
  }
  if (query.get('state') !== tx.st) {
    throw new OidcError('invalid_state', 'state parameter does not match the transaction');
  }

  const config = await getConfiguration(s);
  const currentUrl = new URL(tx.ru);
  currentUrl.search = query.toString();

  let tokens: oidcClient.TokenEndpointResponse & oidcClient.TokenEndpointResponseHelpers;
  try {
    tokens = await oidcClient.authorizationCodeGrant(config, currentUrl, {
      expectedState: tx.st,
      expectedNonce: tx.no,
      pkceCodeVerifier: tx.pk,
      // Belt to the braces of `expectedNonce`, which already forces it. An
      // access token without an ID token would authenticate nobody: there would
      // be no signed subject to put in the session.
      idTokenExpected: true,
    });
  } catch (err) {
    throw new OidcError('exchange_failed', describeError(err, s.clientSecret));
  }

  const claims = tokens.claims();
  if (!claims || typeof claims.sub !== 'string' || !claims.sub) {
    throw new OidcError('no_identity', 'the ID token carried no subject');
  }

  let profile = readProfile(claims);
  if (needsUserInfo(profile, s)) {
    try {
      // `claims.sub` as the expected subject is not decoration: without it a
      // userinfo response for a DIFFERENT user would be merged into this
      // identity, and on a group-allowlisted instance that is an authorization
      // bypass. The library enforces the match.
      const info = await oidcClient.fetchUserInfo(config, tokens.access_token, claims.sub);
      const merged = readProfile(info);
      profile = {
        // ID token wins wherever it said anything: it is signed, userinfo is a
        // bearer-token-authenticated JSON document.
        name: profile.name || merged.name,
        email: profile.email || merged.email,
        emailVerified: profile.email ? profile.emailVerified : merged.emailVerified,
        preferredUsername: profile.preferredUsername || merged.preferredUsername,
        groups: profile.groups.length > 0 ? profile.groups : merged.groups,
      };
    } catch (err) {
      // Non-fatal. If the missing claim was one the allowlist needs, the
      // allowlist below refuses the login anyway, which is the right outcome and
      // a better one than turning a userinfo hiccup into a 500.
      console.warn('[oidc] userinfo lookup failed:', describeError(err, s.clientSecret));
    }
  }

  const identity: OidcIdentity = { iss: claims.iss, sub: claims.sub, ...profile };
  if (!isAllowed(identity, s)) {
    throw new OidcError(
      'not_allowed',
      `subject ${identity.sub} authenticated at ${redactUrlCreds(identity.iss)} but matches no allowlist entry`,
    );
  }
  return identity;
}

/** ---- Allowlist ------------------------------------------------------------ */

/**
 * Who is allowed in, and why the axis is what it is.
 *
 * Three axes are supported and any one of them matching is enough (they are a
 * union, not an intersection), because a real deployment mixes them: a group for
 * the team, a subject for the break-glass admin account.
 *
 *  - **`groups` is the intended primary axis.** It is the only one that scales
 *    past a handful of people, it is the axis this IdP is built around (it
 *    publishes a `groups` scope and a `groups` claim), and it puts the
 *    membership decision in the place that already owns identity. Adding or
 *    removing a person is then an IdP operation and does not touch this app's
 *    settings at all.
 *  - **`sub` is the axis for precision.** The subject is opaque and, unlike
 *    every other claim, the IdP guarantees it is stable and never reassigned. It
 *    is unreadable in a settings form, which is why it is not the primary axis,
 *    but it is the only entry that cannot be made to point at a different human
 *    later.
 *  - **`email` is supported, and it is the WEAKEST of the three.** Email
 *    addresses get reassigned (a person leaves, the address is recycled to a
 *    successor) and, at an IdP that permits self-service address changes, they
 *    can be claimed. An entry here therefore requires `email_verified` to be
 *    true; an unverified address is not an identity, it is a text field the user
 *    typed. Prefer groups or subjects.
 *
 * **AN EMPTY ALLOWLIST FAILS CLOSED: nobody gets in.** This is the single most
 * important line in the function and it is deliberately the opposite of the
 * convenient default. "Empty means everyone" would turn a half-finished settings
 * page, a typo that lands an entry in the wrong list, or a settings block that
 * healed to its defaults after a bad hand edit into OPEN REGISTRATION on a
 * self-hosted note vault: every account at the IdP, including any account the
 * IdP itself allows anyone to create, would become an owner of this instance. A
 * locked-out operator can still log in with the password, which is a recoverable
 * inconvenience; a silently world-readable vault is not recoverable at all.
 *
 * Matching rules: subjects compare exactly (they are opaque, and case is
 * meaningful in an opaque identifier). Groups and emails compare
 * case-insensitively, because neither is case-significant in practice and an
 * operator typing "Admins" for a group named "admins" would otherwise be
 * debugging an invisible failure.
 */
function isAllowed(identity: OidcIdentity, s: OidcSettings): boolean {
  if (
    s.allowedSubjects.length === 0 &&
    s.allowedGroups.length === 0 &&
    s.allowedEmails.length === 0
  ) {
    return false;
  }
  if (s.allowedSubjects.includes(identity.sub)) return true;

  const groups = new Set(identity.groups.map((g) => g.toLowerCase()));
  if (s.allowedGroups.some((g) => groups.has(g.toLowerCase()))) return true;

  if (identity.email && identity.emailVerified) {
    const email = identity.email.toLowerCase();
    if (s.allowedEmails.some((e) => e.toLowerCase() === email)) return true;
  }
  return false;
}

/**
 * Test seam: drop the cached discovery result.
 *
 * Exported because the cache is module-level state keyed on settings, and a test
 * that swaps the settings fixture between cases would otherwise inherit whatever
 * the previous case discovered. Nothing on the request path calls it: a real
 * settings change invalidates the cache by changing its key.
 */
export function resetOidcDiscoveryCache(): void {
  discoveryCache = null;
  consumedTransactions.clear();
}
