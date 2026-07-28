/**
 * Setup URI issuance and import: the HTTP surface that lets device N+1 join.
 *
 * Four endpoints, all POST, all on `livesyncRouter` (so `requireAuth` already
 * applies), in two deliberately-separated pairs:
 *
 *   POST /setup-uri            mint  -> { handle, expiresAt }
 *   POST /setup-uri/retrieve   fetch -> { uri, qr }          (ONE TIME ONLY)
 *   POST /setup-uri/decode     preview a pasted URI, writes nothing
 *   POST /setup-uri/apply      commit a previewed URI
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS NOT IN routes/settings.ts, AND WHY IT IS NOT A SETTINGS FIELD
 *
 * `routes/settings.ts` IS the redaction boundary: its contract is "secrets never
 * leave". This file is the one deliberate, narrow hole in that rule, and putting
 * it next to `GET /settings` would invite a future refactor to share a
 * serialiser between the endpoint that must never emit secrets and the endpoint
 * whose entire job is to emit them once. Physical separation keeps the two
 * contracts from touching.
 *
 * It is also NOT on `agentRouter`, and that is a rule rather than an oversight.
 * An API key is a long-lived bearer token held by a script with no human
 * present, so the re-authentication requirement below is UNIMPLEMENTABLE for it.
 * A leaked `wok_...` key must not be able to escalate from "read my notes" to
 * "own my CouchDB and my end-to-end encryption key".
 *
 * Nothing here is stored. There is no new `SettingsSchema` field, no
 * `redactSettings` branch and no PUT-allowlist entry, so the four-file settings
 * contract does not apply. An implementation that finds itself adding a
 * `livesync.setupUri` setting has gone wrong.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PLUGIN'S OWN POLICY DOES NOT TRANSFER
 *
 * The Obsidian plugin renders a Setup URI into an Electron process the user
 * already owns: no network hop, no proxy, no browser history, no shared cache.
 * WebObsidian is internet-facing behind a reverse proxy. The response crosses a
 * TLS-terminating hop and lands in a browser with history, bfcache, extensions
 * and devtools. `requireAuth` proves only that SOMEONE HOLDS A VALID COOKIE, not
 * that the owner is at the keyboard.
 *
 * So issuance is treated as a CREDENTIAL ISSUANCE EVENT rather than a settings
 * read, and every control below exists to keep the hole small enough to reason
 * about: re-authentication on the request, a caller-supplied passphrase the
 * server never sees again, a 120-second single-use handle, its own rate limits
 * and failure budget, and an audit line.
 *
 * ---------------------------------------------------------------------------
 * THE IMPORT DIRECTION IS THE MORE DANGEROUS ONE
 *
 * Emitting leaks THIS instance's secrets. Importing hands over THIS instance's
 * VAULT, and it is the direction an attacker can initiate, because a Setup URI
 * is just a string a user can be socially engineered into pasting.
 *
 *   Attack (a), REPOINT. A URI whose `couchDB_URI` is the attacker's server. The
 *   local vault is pushed to it, and since the E2EE passphrase travels in the
 *   same URI, the attacker holds the key to everything they receive.
 *
 *   Attack (b), POISON. A URI whose `passphrase` differs from the one the
 *   existing remote was written with. Every existing document becomes
 *   undecryptable and new writes are encrypted under a key the other devices
 *   lack.
 *
 * Both are addressed by making import a two-phase operation that shows a diff
 * and names the host change in plain language before anything is written, and by
 * reading a FIXED ALLOWLIST out of the decoded object rather than merging it.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { asyncHandler } from '../middleware/error.js';
import { createRateLimiter, createFailureLimiter, clientIp } from '../middleware/ratelimit.js';
import {
  getSettings,
  updateSettings,
  redactSettings,
  isUnsafeE2eePairing,
  REDACTED_SECRET,
} from '../services/settings.js';
import { authenticatePassword, auditCredentialUse } from '../services/auth.js';
import { redactUrlCreds } from '../lib/redact.js';
import { encodeQr, QrTooLargeError } from '../lib/qr.js';
import { requireCouchUri, requireDatabaseName } from './settings.js';
import {
  encodeSetupUri,
  decodeSetupUri,
  unsupportedRemoteReason,
  SetupUriError,
  MAX_SETUP_URI_LENGTH,
  MIN_SETUP_URI_PASSPHRASE_LENGTH,
  type LiveSyncBlockView,
} from '../services/livesync/setup-uri.js';

// ---------------------------------------------------------------------------
// Cache control
// ---------------------------------------------------------------------------

/**
 * Mark a response uncacheable.
 *
 * Mirrors `routes/shares.ts`'s `noStore`, and is applied as middleware AHEAD OF
 * THE RATE LIMITER on every route here rather than inside the handlers. That
 * ordering is load-bearing and has bitten this codebase before: a limiter
 * answers its own 429 and returns WITHOUT reaching the handler, so headers set
 * in the handler never happen on exactly the response most likely to be
 * repeated. Every branch (200, 400, 401, 404, 409, 429) has to carry these.
 *
 * A 200 with no cache directives is heuristically cacheable under RFC 9111
 * 4.2.2, and this deployment explicitly sits behind a proxy that may cache. A
 * shared cache pinning one owner's Setup URI and serving it to the next
 * requester is the whole hazard.
 */
function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Cookie');
}

const noStoreFirst = (_req: Request, res: Response, next: NextFunction): void => {
  noStore(res);
  next();
};

// ---------------------------------------------------------------------------
// The one-shot handle store
// ---------------------------------------------------------------------------

/**
 * How long a minted URI or a decoded preview stays retrievable.
 *
 * Pairing takes seconds. A short window means a proxy replay, a browser prefetch
 * or a duplicated tab gets nothing AND THE OWNER SEES THE FAILURE, rather than
 * the URI living indefinitely in whatever caught it. A process restart is
 * therefore also a revocation.
 */
const HANDLE_TTL_MS = 120_000;

/**
 * Hard cap on live handles.
 *
 * Each entry holds a full Setup URI (a few kilobytes), and minting is
 * authenticated and rate limited, so this can never be approached in normal use.
 * It exists so that the store is provably bounded rather than merely unlikely to
 * grow: an unbounded in-memory map behind an authenticated endpoint is still a
 * memory leak waiting for a script.
 */
const MAX_LIVE_HANDLES = 16;

interface StoredEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * A single-retrieval, TTL-bounded, in-memory store.
 *
 * IN MEMORY ONLY. Never written to `data/`, never to a temp file, and above all
 * never into the vault: the vault is indexed, link-graphed, reachable through the
 * agent API's read scope, and REPLICATED BY THE VERY SYNC BACKEND THIS URI
 * CONFIGURES. Persisting a Setup URI there would push the credential bundle to
 * the CouchDB an attacker may already be reading.
 *
 * `take` deletes before returning, so a replay of the same handle -- from a
 * proxy, a prefetcher or a double-submitted form -- finds nothing. Expired,
 * consumed and never-existed are indistinguishable to the caller by design: all
 * three return the same 404, so the endpoint cannot be used to probe which
 * handles were ever real.
 */
class OneShotStore<T> {
  private readonly entries = new Map<string, StoredEntry<T>>();

  put(value: T): { handle: string; expiresAt: number } {
    this.sweep();
    // Evict oldest-first if at capacity, so a burst cannot deny the owner the
    // ability to mint at all.
    while (this.entries.size >= MAX_LIVE_HANDLES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    // 256 bits from the CSPRNG. base64url so the value is safe in a JSON body
    // and in any future transport without re-encoding.
    const handle = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + HANDLE_TTL_MS;
    this.entries.set(handle, { value, expiresAt });
    return { handle, expiresAt };
  }

  /** Retrieve and consume. Returns null for expired, consumed or unknown alike. */
  take(handle: unknown): T | null {
    this.sweep();
    if (typeof handle !== 'string' || handle.length === 0 || handle.length > 128) return null;
    const entry = this.entries.get(handle);
    if (!entry) return null;
    this.entries.delete(handle);
    if (entry.expiresAt <= Date.now()) return null;
    return entry.value;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [handle, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(handle);
    }
  }

  /** Test seam: drop everything. Not reachable over HTTP. */
  clear(): void {
    this.entries.clear();
  }
}

/** Minted URIs awaiting their single retrieval. */
const mintedUris = new OneShotStore<{ uri: string }>();

/** Decoded previews awaiting an explicit apply. */
const decodedPreviews = new OneShotStore<{ block: LiveSyncBlockView; host: string }>();

/** Test seam: clear both stores between cases. */
export function __clearSetupUriStores(): void {
  mintedUris.clear();
  decodedPreviews.clear();
}

// ---------------------------------------------------------------------------
// Throttling
// ---------------------------------------------------------------------------

const WINDOW_MS = 15 * 60 * 1000;

/**
 * Layer 1, per surface, one private store each.
 *
 * 5 per 15 minutes sits far above any honest pairing rate and far below anything
 * useful for grinding. Each of these routes is expensive on purpose: the owner
 * password check is a 128 MiB scrypt, and the codec runs 310_000 PBKDF2
 * iterations, so an unthrottled surface here is a CPU and memory amplifier
 * before it is anything else.
 *
 * Note the documented caveat in middleware/ratelimit.ts: under the default
 * `trust proxy`, every client behind the reverse proxy shares one Layer 1 key.
 * That is precisely why the password check ALSO has a Layer 2 failure limiter
 * below, which charges only failures and is cleared by a success, so a caller
 * presenting the right credential can never be locked out by someone else's
 * noise.
 */
const mintLimit = createRateLimiter({
  windowMs: WINDOW_MS,
  max: 5,
  message: 'Too many Setup URI requests. Try again later.',
});
const retrieveLimit = createRateLimiter({
  windowMs: WINDOW_MS,
  max: 5,
  message: 'Too many Setup URI requests. Try again later.',
});
const decodeLimit = createRateLimiter({
  windowMs: WINDOW_MS,
  max: 5,
  message: 'Too many Setup URI imports. Try again later.',
});
const applyLimit = createRateLimiter({
  windowMs: WINDOW_MS,
  max: 5,
  message: 'Too many Setup URI imports. Try again later.',
});

/**
 * Layer 2, and it MUST NOT be the login failure limiter.
 *
 * `loginFailureLimit` is keyed `() => 'owner'`, i.e. one global bucket, and it is
 * checked before the credential check on `/auth/login`. Sharing it would mean
 * wrong passwords typed HERE consume the owner's global login budget and lock
 * them out of the instance entirely -- a self-inflicted denial of service
 * reachable from a settings panel.
 */
const setupPasswordFailures = createFailureLimiter({
  windowMs: WINDOW_MS,
  max: 5,
  keyFn: (req) => `setup-uri|${clientIp(req)}`,
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface JsonBody {
  [key: string]: unknown;
}

const bodyOf = (req: Request): JsonBody =>
  typeof req.body === 'object' && req.body !== null ? (req.body as JsonBody) : {};

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Verify the owner password for a request that `requireAuth` has already
 * accepted, or answer and return false.
 *
 * This is the re-authentication requirement, and it is what separates this
 * surface from every other settings route. Those are write-mostly with a
 * bad-configuration worst case; these two are read-everything and
 * overwrite-everything. A stolen session cookie, an unlocked unattended browser
 * or a CSRF-adjacent path must not be enough on its own.
 */
async function reauthenticate(req: Request, res: Response, action: string): Promise<boolean> {
  const settings = await getSettings();

  /*
   * On an SSO-only instance there is no owner password to check, so this control
   * cannot be enforced. Refusing loudly is the only honest answer: silently
   * degrading to cookie-only would make the STRONGEST authentication
   * configuration the LEAST protected surface on the server.
   */
  if (!settings.oidc.allowPasswordLogin) {
    res.status(409).json({
      error:
        'Setup URI operations require the owner password, but password login is disabled on this ' +
        'instance. Re-enable password login temporarily to pair a device.',
    });
    return false;
  }

  // Layer 2 runs BEFORE the credential check, so a locked-out identity never
  // reaches scrypt. That is what removes the CPU amplification an unthrottled
  // password endpoint otherwise offers.
  const failureKey = setupPasswordFailures.keyFor(req);
  if (!setupPasswordFailures.check(failureKey)) {
    const retryAfter = setupPasswordFailures.retryAfterSeconds(failureKey);
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'Too many failed attempts. Try again later.', retryAfter });
    return false;
  }

  const password = bodyOf(req).currentPassword;
  const kind = typeof password === 'string' ? await authenticatePassword(password) : null;
  if (!kind) {
    setupPasswordFailures.recordFailure(failureKey);
    res.status(401).json({ error: 'Invalid password' });
    return false;
  }
  setupPasswordFailures.reset(failureKey);
  // Recovery-override credentials never expire and survive a password change, so
  // a successful one on a credential-issuing route is worth a log line.
  auditCredentialUse(kind, action, req.ip);
  return true;
}

/**
 * The single message EVERY decode failure answers with.
 *
 * Wrong passphrase, malformed blob, unsupported envelope and not-a-Setup-URI all
 * get this exact string. Distinguishing them would turn `/decode` into a
 * decryption oracle against an attacker-supplied blob, and the underlying reason
 * is deliberately not logged either, because the codec's own error messages
 * quote payload structure.
 */
const DECODE_FAILURE_MESSAGE =
  'Could not read that Setup URI. Check that it was pasted in full and that the passphrase is correct.';

/** The host part of a CouchDB URL, for display. Never the full URL with userinfo. */
function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return redactUrlCreds(uri);
  }
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export const livesyncSetupRouter = Router();

/**
 * Mint a Setup URI.
 *
 * The response deliberately does NOT contain the URI. It returns a handle that
 * the client must exchange within 120 seconds, exactly once. Splitting it in two
 * means the credential bundle is never in a response that anything replayed,
 * prefetched or cached the first time round.
 */
livesyncSetupRouter.post(
  '/setup-uri',
  noStoreFirst,
  mintLimit,
  asyncHandler(async (req, res) => {
    if (!(await reauthenticate(req, res, 'setup URI issuance'))) return;

    /*
     * The passphrase is MANDATORY and CALLER-SUPPLIED.
     *
     * Never generated here and returned beside the URI: one intercepted
     * response, one cached page or one screenshot would then be the complete
     * secret. Upstream says the same for the networked case -- "do not send the
     * Setup URI and its passphrase through the same channel" -- and its own CLI
     * generator only prints both together because it is local-only.
     *
     * The minimum length is not decoration either. This blob contains the whole
     * vault's keys, so a four-character passphrase over PBKDF2 is seconds of
     * offline grinding for anyone who captures it. The plugin guards this on
     * import and nowhere on export; we guard it where it is actually decided.
     */
    const uriPassphrase = asString(bodyOf(req).uriPassphrase);
    if (uriPassphrase.length < MIN_SETUP_URI_PASSPHRASE_LENGTH) {
      res.status(400).json({
        error: `The Setup URI passphrase must be at least ${MIN_SETUP_URI_PASSPHRASE_LENGTH} characters. It protects the URI only, and must be different from your vault passphrase.`,
      });
      return;
    }

    const settings = await getSettings();
    const ls = settings.livesync;

    /*
     * Refuse unless this instance is actually paired and running LiveSync.
     *
     * Mirrors the plugin's own `if (!settings.isConfigured) return false`, but
     * the stronger reason is the E2EE check below: propagating an
     * obfuscation-without-encryption configuration to a second device would make
     * the naive verification ("are the document ids opaque?") pass on BOTH
     * devices while the document bodies stay in the clear on both.
     */
    if (settings.sync.backend !== 'livesync') {
      res.status(409).json({
        error: 'The LiveSync backend is not the active sync backend on this instance.',
      });
      return;
    }
    if (!ls.uri || !ls.database || !ls.username || !ls.password) {
      res.status(409).json({
        error:
          'LiveSync is not fully configured. Set the CouchDB URL, database, username and password first.',
      });
      return;
    }
    if (isUnsafeE2eePairing(ls)) {
      res.status(409).json({
        error:
          'This instance has an obfuscation passphrase with no encryption passphrase, which hashes ' +
          'document ids while leaving content unencrypted. Fix that before pairing another device.',
      });
      return;
    }

    /*
     * A FRESH, MINIMAL object. Never the settings tree.
     *
     * `git.token`, `oidc.clientSecret`, `auth.jwtSecret` and every API key hash
     * live in the same tree, so a Setup URI built by serialising settings would
     * be a full configuration dump. `includeInternal` is excluded too: it is a
     * list of directories on THIS host, which is filesystem layout a joining
     * phone has no use for.
     */
    const block: LiveSyncBlockView = {
      uri: ls.uri,
      database: ls.database,
      username: ls.username,
      password: ls.password,
      passphrase: ls.passphrase,
      obfuscatePassphrase: ls.obfuscatePassphrase,
      liveMode: ls.liveMode,
      intervalSec: ls.intervalSec,
    };

    let uri: string;
    try {
      uri = await encodeSetupUri(block, uriPassphrase);
    } catch (e) {
      // The one expected failure is the unrepresentable obfuscation pairing,
      // whose message is written for an operator and names the way out.
      if (e instanceof SetupUriError && e.reason === 'unrepresentable') {
        res.status(409).json({ error: e.message });
        return;
      }
      throw e;
    }

    const { handle, expiresAt } = mintedUris.put({ uri });

    /*
     * One audit line. A minted Setup URI is a credential issuance and is the
     * single event most worth finding after the fact.
     *
     * It records WHEN and FROM WHERE and nothing else: never the URI, never the
     * passphrase, never the CouchDB URL. `req.ip` is only as trustworthy as
     * `trust proxy` is accurate, which is why it is context rather than identity.
     */
    console.warn(`[audit] Setup URI minted (client: ${req.ip ?? 'unknown'})`);

    res.json({ handle, expiresAt });
  }),
);

/**
 * Exchange a handle for the URI and its QR, exactly once.
 *
 * POST rather than GET even though this only reads, because a GET is what a
 * prefetcher, a link scanner or "open in new tab" replays, and the one-time rule
 * turns any replay into a lost pairing. A GET would also put the handle in
 * `req.url`, and therefore in the proxy's access log and the browser's history.
 */
livesyncSetupRouter.post(
  '/setup-uri/retrieve',
  noStoreFirst,
  retrieveLimit,
  asyncHandler(async (req, res) => {
    const entry = mintedUris.take(bodyOf(req).handle);
    if (!entry) {
      // Expired, already consumed and never-existed are one answer by design.
      res.status(404).json({ error: 'That Setup URI has expired or was already retrieved.' });
      return;
    }

    /*
     * The QR is built here, from the ENCRYPTED URI, and shipped as a matrix.
     *
     * Two things this deliberately is not. It is not the plugin's `settingsQR`
     * payload, which is UNENCRYPTED and would put the CouchDB password and the
     * E2EE passphrase on screen in the clear. And it is not an image endpoint:
     * an image URL would be cacheable, prefetchable, `Referer`-leaking and
     * "save image as"-able into a synced photo library, so it rides in this
     * one-shot response instead and lives exactly as long as the URI does.
     *
     * A matrix rather than SVG markup means nothing the client renders is
     * markup, so there is no injection question at that boundary at all.
     */
    let qr: { size: number; version: number; rows: string[] } | null = null;
    try {
      const encoded = encodeQr(entry.uri);
      qr = { size: encoded.size, version: encoded.version, rows: encoded.rows };
    } catch (e) {
      // A URI too large to scan is not a reason to withhold the URI itself: the
      // operator can still copy it. Degrade to no QR rather than failing.
      if (!(e instanceof QrTooLargeError)) throw e;
    }

    res.json({ uri: entry.uri, qr });
  }),
);

/**
 * Decode a pasted Setup URI and return a REDACTED preview plus a diff.
 *
 * Writes nothing. This exists so the operator sees what a URI would do before it
 * does it, which is the whole defence against both the repoint and the poison
 * attack: a protocol-handler-shaped one-call import is exactly what a malicious
 * page can trigger, and WebObsidian deliberately has no protocol handler.
 */
livesyncSetupRouter.post(
  '/setup-uri/decode',
  noStoreFirst,
  decodeLimit,
  asyncHandler(async (req, res) => {
    const body = bodyOf(req);
    const uri = asString(body.uri);
    const passphrase = asString(body.passphrase);

    // Cheap shape checks first, before any key derivation. The length cap in
    // particular has to precede the codec: the legacy envelope branch runs two
    // full PBKDF2 attempts, so without a cap the caller chooses our work factor.
    if (!uri || uri.length > MAX_SETUP_URI_LENGTH || !passphrase) {
      res.status(400).json({ error: DECODE_FAILURE_MESSAGE });
      return;
    }

    let decoded;
    try {
      decoded = await decodeSetupUri(uri, passphrase);
    } catch (e) {
      /*
       * ONE indistinguishable answer for every failure.
       *
       * Wrong passphrase, malformed blob, unsupported envelope and
       * not-a-Setup-URI all return the same 400 with the same text. Reporting
       * which one occurred would turn this endpoint into a decryption oracle
       * against an attacker-supplied blob. The underlying reason is deliberately
       * not logged either, because the codec's messages quote payload structure.
       */
      if (!(e instanceof SetupUriError)) throw e;
      res.status(400).json({ error: DECODE_FAILURE_MESSAGE });
      return;
    }

    const unsupported = unsupportedRemoteReason(decoded);
    if (unsupported) {
      res.status(400).json({ error: unsupported });
      return;
    }

    /*
     * Validate NOW, on the decode path, through the settings PUT's own
     * validators rather than a parallel copy.
     *
     * Doing it here rather than only on apply means the operator is told the URI
     * is unusable while they are still looking at the paste box, and it means an
     * unusable value never reaches the preview store at all.
     */
    let validatedUri: string;
    let validatedDatabase: string;
    try {
      validatedUri = requireCouchUri(decoded.block.uri);
      validatedDatabase = requireDatabaseName(decoded.block.database);
    } catch (e) {
      res.status(400).json({
        error: `This Setup URI is not usable: ${e instanceof Error ? redactUrlCreds(e.message) : 'invalid values'}`,
      });
      return;
    }
    if (!validatedUri || !validatedDatabase) {
      res.status(400).json({ error: 'This Setup URI is missing a CouchDB URL or database name.' });
      return;
    }

    /*
     * The obfuscation pairing, refused in the direction that cannot be
     * represented. A URI asking for path obfuscation with no encryption
     * passphrase describes a remote whose ids are hashed and whose bodies are
     * plaintext, which is the state `isUnsafeE2eePairing` exists to keep out.
     */
    if (decoded.usePathObfuscation && !decoded.block.passphrase) {
      res.status(400).json({
        error:
          'This Setup URI enables path obfuscation without an encryption passphrase, which hashes ' +
          'document ids while leaving content unencrypted. WebObsidian refuses that combination.',
      });
      return;
    }

    const block: LiveSyncBlockView = {
      ...decoded.block,
      uri: validatedUri,
      database: validatedDatabase,
    };

    const current = (await getSettings()).livesync;
    const host = hostOf(block.uri);
    const currentHost = current.uri ? hostOf(current.uri) : '';
    const firstTime = !current.uri;

    /*
     * Make both attacks legible, by name, rather than as a table row.
     *
     * A changed host is the headline because it IS the repoint attack. A changed
     * passphrase is reported by COMPARING, never by displaying either value, and
     * says plainly that existing remote documents become unreadable.
     */
    const warnings: string[] = [];
    if (firstTime) {
      warnings.push(
        `This instance is not paired yet. Applying this will connect it to ${host} and replace any local LiveSync settings.`,
      );
    } else if (currentHost !== host) {
      warnings.push(
        `This will point your vault at a DIFFERENT server: ${currentHost} becomes ${host}.`,
      );
    }
    if (current.passphrase && block.passphrase !== current.passphrase) {
      warnings.push(
        'The end-to-end encryption passphrase differs from the one in use. Documents already in the ' +
          'remote database will not be readable by this instance, and a rebuild will be required.',
      );
    }
    if (current.passphrase && !block.passphrase) {
      warnings.push(
        'This Setup URI has end-to-end encryption disabled, but this instance currently uses it.',
      );
    }
    if (block.liveMode && !current.liveMode) {
      warnings.push('This enables continuous (live) replication.');
    }

    const { handle, expiresAt } = decodedPreviews.put({ block, host });

    /*
     * The preview is REDACTED with the same rules as `redactSettings`.
     *
     * Host, database and username in full, because reviewing them is the entire
     * point of the preview. The three secrets are masked: an unredacted preview
     * would make this endpoint the very leak the export side works to prevent,
     * and would let an attacker use it to print the secrets out of a blob they
     * supplied.
     */
    res.json({
      handle,
      expiresAt,
      requiresHostConfirmation: !firstTime && currentHost !== host,
      warnings,
      preview: {
        uri: redactUrlCreds(block.uri),
        database: block.database,
        username: block.username,
        password: block.password ? REDACTED_SECRET : '',
        passphrase: block.passphrase ? REDACTED_SECRET : '',
        obfuscatePassphrase: block.obfuscatePassphrase ? REDACTED_SECRET : '',
        liveMode: block.liveMode,
        intervalSec: block.intervalSec,
      },
    });
  }),
);

/**
 * Apply a previously-decoded Setup URI.
 *
 * Requires the handle from `/decode`, the owner password again, and -- when the
 * CouchDB host is changing -- the new host typed back verbatim. The typed
 * confirmation is what makes the repoint attack require the operator to READ the
 * hostname rather than click through a dialog.
 */
livesyncSetupRouter.post(
  '/setup-uri/apply',
  noStoreFirst,
  applyLimit,
  asyncHandler(async (req, res) => {
    if (!(await reauthenticate(req, res, 'setup URI import'))) return;

    const body = bodyOf(req);
    const entry = decodedPreviews.take(body.handle);
    if (!entry) {
      res.status(404).json({ error: 'That preview has expired. Paste the Setup URI again.' });
      return;
    }

    const before = (await getSettings()).livesync;
    const hostChanging = Boolean(before.uri) && hostOf(before.uri) !== entry.host;
    if (hostChanging) {
      const typed = asString(body.confirmHost).trim();
      // Compared with a constant-time primitive out of habit rather than need:
      // the value is not a secret, but this is the confirmation gate on a
      // vault-repointing operation and it costs nothing to not leak a prefix.
      const expected = Buffer.from(entry.host);
      const actual = Buffer.from(typed);
      const matches =
        expected.length === actual.length && timingSafeEqual(expected, actual);
      if (!matches) {
        /*
         * The handle was consumed by `take` above and is NOT reissued here, so a
         * wrong confirmation costs a full re-paste. That is deliberate: it means
         * the confirmation cannot be brute-forced against a single preview, and
         * it forces the operator back through the screen that states the host
         * change in plain language. The message says so, because a button that
         * silently 404s on the retry would read as a bug.
         */
        res.status(400).json({
          error:
            `To change the CouchDB server you must type the new host exactly: ${entry.host}. ` +
            'Paste the Setup URI again to retry.',
        });
        return;
      }
    }

    /*
     * THE ALLOWLIST WRITE.
     *
     * This is the sharpest rule in the file, and it is about the SHAPE of the
     * write rather than about which fields the format happens to carry. The
     * decoded object is attacker-influenced, so it is never spread, never
     * `Object.assign`ed and never merged: eight named fields are assigned from a
     * value that was type-checked on the way out of the codec, and nothing else
     * is touched.
     *
     * Specifically NOT writable here, each for its own reason:
     *   - anything outside `livesync`. `vault.path` is the documented
     *     catastrophe: `path.resolve('')` becomes the process cwd, so a files
     *     read would return `auth.jwtSecret`, both password hashes, `git.token`
     *     and every API key hash in cleartext, and a files write to
     *     `server/dist/index.js` is code execution on the next restart. That was
     *     reachable from a free-text UI input once; it must not become reachable
     *     from a pasted string.
     *   - `livesync.includeInternal`. A list of directories this server walks and
     *     replicates, so an attacker-chosen entry is a disclosure primitive.
     *   - `sync.backend`. Switching backends is the act that STARTS writing, and
     *     two writers over one vault with different conflict models corrupt it.
     *     It stays a separate, deliberate operator action.
     */
    const applied = await updateSettings((draft) => {
      draft.livesync.uri = entry.block.uri;
      draft.livesync.database = entry.block.database;
      draft.livesync.username = entry.block.username;
      draft.livesync.password = entry.block.password;
      draft.livesync.passphrase = entry.block.passphrase;
      draft.livesync.obfuscatePassphrase = entry.block.obfuscatePassphrase;
      draft.livesync.liveMode = entry.block.liveMode;
      draft.livesync.intervalSec = entry.block.intervalSec;
    });

    /*
     * Belt to the braces. `updateSettings` re-parses through the zod schema, so
     * this can only fire if the schema and the codec ever disagree, but the state
     * it guards against is the one that looks encrypted and is not.
     */
    if (isUnsafeE2eePairing(applied.livesync)) {
      throw Object.assign(
        new Error('refusing an obfuscation-without-encryption configuration'),
        { status: 500 },
      );
    }

    console.warn(
      `[audit] LiveSync settings replaced from a Setup URI (host: ${entry.host}, client: ${req.ip ?? 'unknown'})`,
    );

    res.json({ ok: true, settings: redactSettings(applied) });
  }),
);
