import { Router } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import {
  getSettings,
  updateSettings,
  redactSettings,
  ensureVaultBrowsable,
  isVaultRelativeSubpath,
  isUnsafeE2eePairing,
  isOidcUsable,
  isWithinRoot,
  normalizeOidcList,
  OIDC_CALLBACK_PATH,
  REDACTED_SECRET,
  type Settings,
} from '../services/settings.js';
import { redactUrlCreds } from '../lib/redact.js';
import { isReservedClaim } from '../services/oidc.js';
import { config } from '../config.js';

/** Build an error the shared error middleware will answer with `status`. */
function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/** The subset of the settings tree this endpoint accepts. Everything arrives as
 *  unknown and is narrowed per field below; nothing is trusted by shape alone. */
interface SettingsPatchBody {
  vault?: Record<string, unknown>;
  git?: Record<string, unknown>;
  // Each of these has to be listed here AND handled in the if-chain inside the
  // PUT below. A block that is missing from that chain is silently unwritable
  // through the API and the request still answers 200 with the unchanged
  // settings, which is the worst failure mode this endpoint has: the operator
  // sees "Saved", the value never lands, and there is nothing in the response or
  // the log to say so. Adding a settings block is a four-file contract (schema,
  // redaction, this allowlist, the UI panel) and half of it fails quietly.
  sync?: Record<string, unknown>;
  livesync?: Record<string, unknown>;
  oidc?: Record<string, unknown>;
  search?: Record<string, unknown>;
  ui?: Record<string, unknown>;
  api?: Record<string, unknown>;
}

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

settingsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(redactSettings(await getSettings()));
  }),
);

// Patch a subset of settings. Secret fields are only overwritten when present.
settingsRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    const body: SettingsPatchBody = req.body ?? {};
    // Validate the vault patch BEFORE opening the update, so a rejected value
    // answers 400/403 without ever taking the settings lock or half-applying the
    // rest of the body.
    const vaultPatch = body.vault ? sanitizeVault(body.vault) : null;
    // A changed vault.path turns the whole files API into read/write over that
    // tree, so constrain it to the allowed roots (same gate as Browse…) and
    // require it to be an existing directory before persisting.
    //
    // Keyed on PRESENCE, not on truthiness. The previous gate was
    // `typeof body.vault.path === 'string' && body.vault.path`, and "" is falsy,
    // so `{"vault":{"path":""}}` skipped the allowed-roots check entirely and was
    // then copied straight through to disk. getVaultRoot() is
    // `path.resolve(s.vault.path)` and `path.resolve('')` is the server's own
    // working directory, so that one request relocated the vault onto the install
    // tree: with the default DATA_DIR, `GET /api/files/content?path=data/settings.json`
    // then returns jwtSecret, both password hashes, git.token and every API key
    // hash in cleartext, and `PUT /api/files/content?path=server/dist/index.js`
    // is code execution on the next restart. It was reachable from the shipped
    // UI, which posts `{vault:{path}}` from a free-text input: clearing the box
    // and pressing Save was enough. sanitizeVault now refuses empty, relative and
    // NUL-bearing values outright, and this gate runs for every path that
    // survives it.
    //
    // It is handed the sanitised string rather than the raw body so that the
    // value which is checked is byte-for-byte the value that gets persisted.
    if (vaultPatch?.path !== undefined) await assertVaultPathAllowed(vaultPatch.path);
    // Also validated before the lock, and for the same reason as the vault fields:
    // this one is the API rate budget, and middleware/apikey.ts tests
    // `arr.length >= perMin`, so a persisted 0 or -1 429s every valid agent key
    // on its first request and keeps doing it across restarts. `typeof === 'number'`
    // was the only check, which accepts 0, -1 and 0.5 alike. The schema carries the
    // same bound with a `.catch()` for hand-edited files; here it is a loud 400.
    const rateLimit = body.api?.rateLimitPerMin;
    if (rateLimit !== undefined) {
      if (typeof rateLimit !== 'number' || !Number.isInteger(rateLimit) || rateLimit < 1) {
        throw httpError(400, 'api.rateLimitPerMin must be a whole number of at least 1');
      }
    }
    // Which backend owns the vault. One value, never a set: see the long note on
    // the `sync` block in services/settings.ts for why two writers over one vault
    // is unrepairable rather than merely untidy. Validated here so an unknown
    // literal answers 400 instead of being coerced to 'none' by the schema's
    // `.catch()`, which would read as "saved, and quietly stopped syncing".
    const syncBackend =
      body.sync?.backend !== undefined ? requireSyncBackend(body.sync.backend) : undefined;
    // Everything about the LiveSync block that can be judged without looking at
    // the stored settings is judged before the lock, exactly as the vault patch
    // is: a rejected value answers 400 without taking the settings lock.
    //
    // The stored URI is read here because recognising the redacted echo (see
    // sanitizeLiveSync) needs it. getSettings() deliberately does NOT take the
    // settings lock (see the note on updateSettings), so reading it here cannot
    // deadlock against the update below. The read is racy against a concurrent
    // write in exactly one direction: if another request changed the URI in
    // between, the worst outcome is that this request leaves the stored URI
    // alone. It can never cause a masked URI to be persisted, which is the only
    // outcome that would matter.
    const liveSyncPatch = body.livesync
      ? sanitizeLiveSync(body.livesync, (await getSettings()).livesync.uri)
      : null;
    // Same shape, same reasoning, one block over. The stored OIDC block is read
    // for the same single purpose the stored URI is read above: recognising a
    // client that echoed back a redacted URL. Everything that can be judged from
    // the patch alone is judged here, before the settings lock is taken, so a
    // malformed issuer answers 400 without half-applying the rest of the body.
    const oidcPatch = body.oidc ? sanitizeOidc(body.oidc, (await getSettings()).oidc) : null;
    const updated = await updateSettings((d) => {
      if (vaultPatch) {
        Object.assign(d.vault, vaultPatch);
        ensureVaultBrowsable(d);
      }
      if (body.git) {
        const { token, ...rest } = body.git;
        Object.assign(d.git, rest);
        // The secret round-trip rule, stated once here and applied field by field
        // to the LiveSync secrets by readSecret() below. The constant is imported
        // rather than written out again so the mask this compares against is
        // provably the same string redactSettings() emits.
        if (typeof token === 'string' && token && token !== REDACTED_SECRET) d.git.token = token;
      }
      if (liveSyncPatch) {
        // `fields` last-writer-wins over the block, `secrets` applied on top and
        // only for the fields the client actually sent a new value for. Two
        // objects rather than one because "absent" and "empty" mean different
        // things for a secret and the same thing for everything else.
        Object.assign(d.livesync, liveSyncPatch.fields, liveSyncPatch.secrets);
      }
      if (syncBackend) d.sync.backend = syncBackend;
      // Deliberately inside the mutator, unlike every other check in this
      // handler, and for two reasons.
      //
      // It is a question about the MERGED result, not about the request: a body
      // that sets only `obfuscatePassphrase` is unsafe or not depending on the
      // passphrase already on disk, and a body that clears `passphrase` is unsafe
      // or not depending on the obfuscation passphrase already on disk. Neither
      // can be answered from the patch alone.
      //
      // And throwing here is just as atomic as throwing before the lock:
      // updateSettings awaits the mutator BEFORE it validates, assigns the cache
      // or persists, so a throw rejects the whole call with the draft discarded,
      // the cache untouched and nothing written. The queue is not poisoned either
      // (withSettingsLock swallows the rejection for the next caller).
      //
      // Gated on the request actually touching sync configuration. Without that
      // gate, an instance that already holds the bad pairing from a hand edit
      // would 400 on every unrelated save (a theme change, an API key) with an
      // error about a passphrase, which is both baffling and unfixable from the
      // UI it breaks.
      if (body.livesync || body.sync) assertSafeE2eePairing(d);
      if (oidcPatch) {
        // Split for exactly the reason the LiveSync patch is split: for the
        // client secret, "absent" and "empty" both mean "leave the stored value
        // alone", while for every other field absent means "not being changed"
        // and empty means "clear it".
        Object.assign(d.oidc, oidcPatch.fields, oidcPatch.secrets);
      }
      // Inside the mutator, and gated on the request touching the block, for the
      // same two reasons spelled out on assertSafeE2eePairing above: these are
      // questions about the MERGED result (a body that only turns `enabled` on is
      // valid or not depending on the issuer already stored, and a body that only
      // clears the issuer is valid or not depending on `enabled` already stored),
      // and an instance that already holds a bad combination from a hand edit
      // must not 400 on every unrelated save with an error about SSO.
      if (body.oidc) assertUsableOidc(d);
      if (body.search) Object.assign(d.search, body.search);
      if (body.ui) Object.assign(d.ui, body.ui);
      if (typeof rateLimit === 'number') d.api.rateLimitPerMin = rateLimit;
    });
    res.json(redactSettings(updated));
  }),
);

/**
 * Narrow an incoming vault patch to the fields we accept, rejecting anything that
 * would let a directory setting escape the vault root.
 *
 * `trash` is joined onto the vault root and then treated as a trusted directory:
 * it backs GET /api/files/trash (lists every entry) and DELETE /api/files/trash
 * (fs.rm recursive+force over every entry), so a value like
 * "..\\..\\..\\Windows\\Temp" turned a notes setting into host directory
 * disclosure plus recursive deletion. It used to be copied straight through on a
 * `typeof === 'string'` check alone. `attachmentDir` has no consumer in this
 * build at all, so it is validated pre-emptively rather than defensively: it is
 * schema'd as a vault-relative directory and the only thing such a setting can
 * ever be used for is a join onto the vault root, so the first consumer should
 * inherit the invariant instead of rediscovering it.
 *
 * `path` is the field with the real blast radius, because it IS the vault root
 * rather than something under it. See the gate in the PUT handler.
 *
 * `allowedRoots` is deliberately NOT accepted here; see effectiveRoots().
 *
 * This throws a 400 rather than silently coercing, because a settings PUT is an
 * explicit operator action and should fail loudly. The zod schema applies the
 * same predicates as a non-destructive fallback for hand-edited files.
 */
function sanitizeVault(v: Record<string, unknown>): Partial<Settings['vault']> {
  const out: Partial<Settings['vault']> = {};
  if (v.path !== undefined) out.path = requireVaultRoot(v.path);
  if (v.trash !== undefined) out.trash = requireVaultRelative(v.trash, 'vault.trash');
  if (typeof v.deleteMode === 'string' && (v.deleteMode === 'trash' || v.deleteMode === 'permanent')) {
    out.deleteMode = v.deleteMode;
  }
  if (v.attachmentDir !== undefined) {
    out.attachmentDir = requireVaultRelative(v.attachmentDir, 'vault.attachmentDir');
  }
  return out;
}

/**
 * Accept an absolute host directory for the vault root, or reject the request.
 *
 * Every rejected form here resolves somewhere the caller did not name:
 *   - "" and "   ": `path.resolve('')` is the server's working directory, i.e.
 *     the install tree (see the long note on the gate in the PUT handler).
 *   - "." and "..": the same thing, and the parent of it.
 *   - any other relative value: resolved against whatever directory the process
 *     happened to be started in, which is not something an operator can reason
 *     about and which changes under systemd, Docker and the Electron shell.
 *   - NUL: truncates inside libuv, so the string validated here would not be the
 *     path opened at syscall time.
 * Absolute-only removes the whole class in one rule, and it costs nothing: the
 * Browse... picker returns absolute paths already.
 *
 * The value is normalised with path.resolve so that the containment check, the
 * stat and the stored value are all the same canonical string.
 */
function requireVaultRoot(value: unknown): string {
  const bad = (why: string) => httpError(400, `vault.path ${why}`);
  if (typeof value !== 'string') throw bad('must be a string');
  const raw = value.trim();
  if (!raw) throw bad('must not be empty');
  if (raw.includes('\0')) throw bad('must not contain NUL bytes');
  if (!path.isAbsolute(raw)) throw bad('must be an absolute path');
  return path.resolve(raw);
}

/** Accept a vault-relative directory or reject the whole request with a 400.
 *  The value is trimmed on the way in so " .trash " cannot smuggle whitespace
 *  into a path that later gets joined onto the vault root. The schema trims too,
 *  so both doors store the same thing. */
function requireVaultRelative(value: unknown, field: string): string {
  if (!isVaultRelativeSubpath(value)) {
    throw httpError(
      400,
      `${field} must be a directory inside the vault: no absolute paths, drive letters, UNC prefixes or ".." segments`,
    );
  }
  return value.trim();
}

/**
 * Accept one of the three backend names, or reject the request.
 *
 * The enum is the mutual-exclusivity mechanism (KICKOFF §5.3, and the long note
 * on the `sync` block in services/settings.ts). There is no combination of
 * backends to express here because there is no safe one: git resolves conflicts
 * at commit granularity over a working tree it assumes it alone mutates, and
 * LiveSync resolves them per document against CouchDB revision history, so each
 * one reads the other's writes as an unexplained local edit and the vault churns
 * between two histories that cannot afterwards be merged. A single value makes
 * the bad state unrepresentable rather than merely discouraged.
 *
 * Loud rather than coerced: the schema heals an unknown literal to 'none' so a
 * hand-edited file still loads, but a request that names a backend this build
 * does not have must not answer 200 and then quietly stop syncing.
 */
function requireSyncBackend(value: unknown): Settings['sync']['backend'] {
  if (value !== 'none' && value !== 'git' && value !== 'livesync') {
    throw httpError(400, "sync.backend must be one of 'none', 'git' or 'livesync'");
  }
  return value;
}

/**
 * A validated LiveSync patch, split by how "absent" has to be interpreted.
 *
 * `fields` are ordinary values: absent means "not being changed", and every
 * present value has already been checked and normalised.
 * `secrets` holds ONLY the credential fields the client actually supplied a new
 * value for. For those, absent and empty are the same thing (leave the stored
 * secret alone), which is why they cannot travel in the same bag as the rest.
 */
interface LiveSyncPatch {
  fields: Partial<Settings['livesync']>;
  secrets: Partial<
    Pick<Settings['livesync'], 'password' | 'passphrase' | 'obfuscatePassphrase'>
  >;
}

/**
 * Narrow an incoming livesync patch to the fields we accept, rejecting anything
 * malformed with a 400 rather than coercing it.
 *
 * `currentUri` is the stored URI, needed only to recognise the redacted echo
 * described below.
 */
function sanitizeLiveSync(v: Record<string, unknown>, currentUri: string): LiveSyncPatch {
  const fields: Partial<Settings['livesync']> = {};

  if (v.uri !== undefined) {
    const uri = requireLiveSyncString(v.uri, 'livesync.uri').trim();
    // redactSettings() masks credentials embedded in the stored URI, so a client
    // that round-trips what it read sends back `https://***@host`. That is not a
    // new value, it is the mask, and storing it would replace a working URL with
    // a broken one (and then requireCouchUri would reject it on the way in
    // anyway, telling the operator their URL contains credentials they never
    // typed). Recognising it here, before validation, is the same idea as the
    // secret sentinel: a value the client can only have got from us means "I did
    // not change this". The `uri !== currentUri` half keeps it from swallowing a
    // genuine edit, since redactUrlCreds is the identity on a URL without
    // userinfo, which is every URL this build is willing to store.
    if (!(uri === redactUrlCreds(currentUri) && uri !== currentUri)) {
      fields.uri = requireCouchUri(uri);
    }
  }
  if (v.database !== undefined) fields.database = requireDatabaseName(v.database);
  if (v.username !== undefined) {
    fields.username = requireLiveSyncString(v.username, 'livesync.username').trim();
  }
  if (v.liveMode !== undefined) {
    if (typeof v.liveMode !== 'boolean') {
      throw httpError(400, 'livesync.liveMode must be a boolean');
    }
    fields.liveMode = v.liveMode;
  }
  if (v.intervalSec !== undefined) {
    // Same bound and the same reasoning as api.rateLimitPerMin above: 0 or a
    // negative value turns the poll timer into a hot loop against CouchDB, and
    // the value is persisted, so it survives a restart. The schema carries the
    // bound too, with a `.catch()`, for hand-edited files; here it is a 400.
    const n = v.intervalSec;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      throw httpError(400, 'livesync.intervalSec must be a whole number of at least 1');
    }
    fields.intervalSec = n;
  }
  if (v.includeInternal !== undefined) {
    fields.includeInternal = requireIncludeInternal(v.includeInternal);
  }

  const secrets: LiveSyncPatch['secrets'] = {};
  const password = readSecret(v.password, 'livesync.password');
  if (password !== undefined) secrets.password = password;
  const passphrase = readSecret(v.passphrase, 'livesync.passphrase');
  if (passphrase !== undefined) secrets.passphrase = passphrase;
  const obfuscate = readSecret(v.obfuscatePassphrase, 'livesync.obfuscatePassphrase');
  if (obfuscate !== undefined) secrets.obfuscatePassphrase = obfuscate;

  return { fields, secrets };
}

/**
 * Decide what an incoming secret means. `undefined` means "leave the stored
 * value alone"; a string is the value to write.
 *
 * The rule for a non-empty string is git.token's, verbatim, and for the same
 * reason: the client is served REDACTED_SECRET in place of a stored secret, so
 * any form that round-trips what it read sends the mask back. Writing that would
 * replace the credential with eight bullet characters, and the operator would
 * meet it as an authentication failure with nothing to connect it to. An empty
 * string is treated as "the field was left blank", not "erase it", because a
 * password input is conventionally rendered empty even when a value is stored,
 * so a blank field is the normal state of a save that was not about the password.
 *
 * That rule alone cannot express "remove this", which is not an academic gap
 * here: an instance holding obfuscatePassphrase with no passphrase (a hand edit,
 * a restored backup, or a file written before assertSafeE2eePairing existed) is
 * otherwise wedged, because every livesync save is refused by the pairing check
 * and the one field that has to change cannot be changed through this API. An
 * explicit JSON `null` is therefore the clear signal. It is deliberately a value
 * no text input produces by accident, so it cannot be sent by a form that simply
 * did not populate the field, which is precisely the accident the rule above
 * exists to prevent.
 *
 * Note what does NOT happen to the value: it is not trimmed. These are key
 * material, and a passphrase with a trailing space that gets silently trimmed
 * derives a different key. The symptom is not an error at save time, it is a
 * remote database this instance can no longer decrypt.
 */
function readSecret(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return '';
  if (typeof value !== 'string') throw httpError(400, `${field} must be a string or null`);
  if (!value || value === REDACTED_SECRET) return undefined;
  return value;
}

/** A string field, or a 400. Kept separate from the vault helpers because the
 *  message names the livesync field rather than a vault one. */
function requireLiveSyncString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw httpError(400, `${field} must be a string`);
  return value;
}

/**
 * Accept a CouchDB base URL, or reject the request.
 *
 * Empty is accepted and means "not configured", which is how an operator takes
 * the backend out of service without deleting the rest of the block.
 *
 * Credentials in the URL are refused rather than accepted-and-hidden. They would
 * otherwise sit in a field nothing treats as a secret: it is returned by GET
 * /api/settings, it is the natural thing to include in an error message, and it
 * would be copied into a bug report by an operator who does not realise their
 * password is in it. There is a dedicated pair of fields for the credential, and
 * they are masked everywhere this one is not.
 *
 * The trailing slash is stripped because the engine builds its endpoint by
 * concatenation (`url + "/" + database`), so a stored trailing slash produces a
 * double slash, which CouchDB reads as a database whose name begins with an
 * empty path segment. The failure is a 404 that looks nothing like its cause.
 * The schema normalises identically, so both doors store one string.
 */
function requireCouchUri(value: string): string {
  const bad = (why: string) => httpError(400, `livesync.uri ${why}`);
  const raw = value.trim();
  if (!raw) return '';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw bad('must be an absolute URL, e.g. https://couchdb.example:6984');
  }
  // `new URL` happily parses `couchdb://host` and `file:///etc`, so the scheme
  // has to be checked explicitly rather than inferred from the parse succeeding.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw bad('must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw bad('must not embed credentials; use livesync.username and livesync.password');
  }
  return raw.replace(/\/+$/, '');
}

/**
 * Accept a CouchDB database name, or reject the request.
 *
 * The character set is CouchDB's own, minus the slash. CouchDB does allow a
 * slash in a database name (URL-encoded), but the engine builds its endpoint as
 * `url + "/" + database` with no encoding step, so a value containing a slash or
 * a `..` segment is path traversal against the CouchDB API rather than a name:
 * `../_users` would point the replicator at the server's credential database.
 * Refusing the character outright costs a legitimate operator nothing, since
 * slashes in database names are a legacy curiosity and a LiveSync vault database
 * never has one.
 *
 * Uppercase is rejected here rather than at the server, so the operator gets a
 * sentence naming the field instead of a CouchDB 400 surfacing several layers
 * away from the setting that caused it.
 */
function requireDatabaseName(value: unknown): string {
  const bad = (why: string) => httpError(400, `livesync.database ${why}`);
  if (typeof value !== 'string') throw bad('must be a string');
  const raw = value.trim();
  if (!raw) return '';
  if (!/^[a-z][a-z0-9_$()+-]*$/.test(raw)) {
    throw bad(
      'must be a CouchDB database name: lowercase, starting with a letter, and containing only a-z 0-9 _ $ ( ) + -',
    );
  }
  return raw;
}

/**
 * Accept the list of vault-relative directories to replicate as LiveSync
 * internal (`i:`) documents, or reject the request.
 *
 * Held to exactly the same containment rule as vault.trash, and by the same
 * predicate, because an entry here is used the same way: joined onto the vault
 * root and then walked. A `..` segment would enumerate a directory above the
 * vault and replicate it into CouchDB, which is a disclosure that leaves the
 * machine rather than merely a bad read. The list defaults to empty; see the
 * note on the schema field for why the feature ships off.
 */
function requireIncludeInternal(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw httpError(400, 'livesync.includeInternal must be an array of vault-relative directories');
  }
  return value.map((entry: unknown) => {
    if (!isVaultRelativeSubpath(entry)) {
      throw httpError(
        400,
        'livesync.includeInternal entries must be directories inside the vault: no absolute paths, drive letters, UNC prefixes or ".." segments',
      );
    }
    return entry.trim();
  });
}

/**
 * Refuse to store the one E2EE combination that looks configured and is not.
 *
 * With obfuscatePassphrase set and passphrase empty, the engine hashes every
 * document id (`f:<hash>`) but writes the document BODY in the clear, because
 * encryption is derived from the passphrase alone. Path, mtime, size and content
 * are then readable by anyone with access to the database, while the ids look
 * exactly like the ones KICKOFF acceptance criterion 3 tells an operator to
 * check for. So the naive verification passes and the property it was meant to
 * verify does not hold. That is why this is a hard 400 rather than a warning:
 * the whole hazard is that nothing downstream looks wrong.
 *
 * The message names both ways out, because one of them (clearing a secret) is
 * not otherwise discoverable: see readSecret() on the explicit `null`.
 */
function assertSafeE2eePairing(d: Settings): void {
  if (!isUnsafeE2eePairing(d.livesync)) return;
  throw httpError(
    400,
    'livesync.obfuscatePassphrase requires livesync.passphrase: obfuscation alone hashes document ids ' +
      'but leaves path, mtime, size and content unencrypted in CouchDB, which looks like end-to-end ' +
      'encryption without being it. Set a passphrase, or send obfuscatePassphrase as null to clear it.',
  );
}

/**
 * A validated OIDC patch, split by how "absent" has to be read, exactly as the
 * LiveSync patch is. `secrets` holds only `clientSecret`, and only when the
 * client actually supplied a new value for it.
 */
interface OidcPatch {
  fields: Partial<Settings['oidc']>;
  secrets: Partial<Pick<Settings['oidc'], 'clientSecret'>>;
}

/**
 * True when `incoming` is the redacted form of `stored` rather than a new value.
 *
 * redactSettings() masks credentials embedded in the OIDC URLs, so a UI that
 * round-trips what it read sends `https://***@host` back. That is not an edit, it
 * is the mask, and storing it would replace a working issuer with one that
 * resolves nowhere (and would then be refused on the way in anyway, telling the
 * operator their URL contains credentials they never typed). It is the same idea
 * as the REDACTED_SECRET sentinel: a value the client can only have obtained from
 * us means "I did not change this".
 *
 * The `incoming !== stored` half is what keeps this from swallowing a genuine
 * edit. redactUrlCreds is the identity on a URL without userinfo, which is every
 * URL this build is willing to store, so without that half every unchanged save
 * of a normal URL would take this branch. Harmless today, but it would silently
 * stop being harmless the moment the field gained a normalisation step.
 */
function isRedactedUrlEcho(incoming: string, stored: string): boolean {
  return incoming === redactUrlCreds(stored) && incoming !== stored;
}

/**
 * Narrow an incoming oidc patch to the fields we accept, rejecting anything
 * malformed with a 400 rather than coercing it.
 *
 * `current` is the stored block, needed only to recognise the redacted echoes
 * described on isRedactedUrlEcho.
 */
function sanitizeOidc(v: Record<string, unknown>, current: Settings['oidc']): OidcPatch {
  const fields: Partial<Settings['oidc']> = {};

  if (v.enabled !== undefined) {
    if (typeof v.enabled !== 'boolean') throw httpError(400, 'oidc.enabled must be a boolean');
    fields.enabled = v.enabled;
  }
  if (v.issuer !== undefined) {
    // Trailing slashes are stripped before both the echo check and validation so
    // that this door and the schema store one canonical string; see the note on
    // the schema field for why discovery cares.
    const issuer = requireOidcString(v.issuer, 'oidc.issuer').trim().replace(/\/+$/, '');
    if (!isRedactedUrlEcho(issuer, current.issuer)) fields.issuer = requireIssuerUrl(issuer);
  }
  if (v.clientId !== undefined) {
    fields.clientId = requireOidcString(v.clientId, 'oidc.clientId').trim();
  }
  if (v.redirectUri !== undefined) {
    const redirectUri = requireOidcString(v.redirectUri, 'oidc.redirectUri')
      .trim()
      .replace(/\/+$/, '');
    if (!isRedactedUrlEcho(redirectUri, current.redirectUri)) {
      fields.redirectUri = requireRedirectUri(redirectUri);
    }
  }
  if (v.scopes !== undefined) fields.scopes = requireScopes(v.scopes);
  if (v.allowedSubjects !== undefined) {
    fields.allowedSubjects = requireStringList(v.allowedSubjects, 'oidc.allowedSubjects');
  }
  if (v.allowedGroups !== undefined) {
    fields.allowedGroups = requireStringList(v.allowedGroups, 'oidc.allowedGroups');
  }
  // Refused with a 400 rather than filtered, because a rule silently dropped
  // from an authorization allowlist is indistinguishable from one that is in
  // force and simply never matching. The reserved-name check in particular has
  // to say WHY: `{"claim":"type","values":["id-token"]}` looks like a specific
  // rule and would admit every account the issuer has.
  if (v.allowedClaims !== undefined) {
    if (!Array.isArray(v.allowedClaims)) {
      throw httpError(400, 'oidc.allowedClaims must be an array');
    }
    const rules: { claim: string; values: string[] }[] = [];
    for (const entry of v.allowedClaims) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw httpError(400, 'each oidc.allowedClaims entry must be an object');
      }
      const rec = entry as Record<string, unknown>;
      const claim = typeof rec.claim === 'string' ? rec.claim.trim() : '';
      if (!claim) throw httpError(400, 'each oidc.allowedClaims entry needs a claim name');
      if (isReservedClaim(claim)) {
        throw httpError(
          400,
          `oidc.allowedClaims cannot use '${claim}': that claim carries the same value for every ` +
            'user of the issuer, or changes on every request, so a rule on it would admit ' +
            'everybody or nobody rather than a specific person. Use a claim that identifies the ' +
            'user, such as preferred_username or a custom claim your provider issues.',
        );
      }
      const values = requireStringList(rec.values, `oidc.allowedClaims['${claim}'].values`);
      if (values.length === 0) {
        throw httpError(400, `oidc.allowedClaims['${claim}'] needs at least one value`);
      }
      rules.push({ claim, values });
    }
    fields.allowedClaims = rules;
  }
  if (v.allowPasswordLogin !== undefined) {
    if (typeof v.allowPasswordLogin !== 'boolean') {
      throw httpError(400, 'oidc.allowPasswordLogin must be a boolean');
    }
    fields.allowPasswordLogin = v.allowPasswordLogin;
  }
  // Validated against the literal union rather than passed through, because the
  // zod schema's .catch('auto') would silently rewrite a typo to the default. A
  // save that reads back as something other than what was submitted is the worst
  // outcome for a security toggle: the operator believes PKCE is off, the server
  // has it on, and nothing anywhere says so.
  if (v.pkce !== undefined) {
    if (v.pkce !== 'auto' && v.pkce !== 'force' && v.pkce !== 'off') {
      throw httpError(400, "oidc.pkce must be one of 'auto', 'force' or 'off'");
    }
    fields.pkce = v.pkce;
  }

  // One secret, but it goes through readSecret() unchanged: the sentinel rule,
  // the "empty means untouched" rule and the explicit-null escape hatch are all
  // identical here, and re-deriving them for one field is how two copies of a
  // security rule start to drift.
  const secrets: OidcPatch['secrets'] = {};
  const clientSecret = readSecret(v.clientSecret, 'oidc.clientSecret');
  if (clientSecret !== undefined) secrets.clientSecret = clientSecret;

  return { fields, secrets };
}

/** A string field, or a 400 naming the OIDC field rather than a LiveSync one. */
function requireOidcString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw httpError(400, `${field} must be a string`);
  return value;
}

/**
 * True for a host whose traffic never leaves the machine.
 *
 * This is the whole of the http exception below, so it is deliberately narrow:
 * the loopback names and nothing else. `localhost` is included because that is
 * what an operator types; the 127.0.0.0/8 block and `::1` because that is what
 * a container, an Electron shell or an SSH tunnel actually resolves to.
 */
function isLoopbackHost(hostname: string): boolean {
  // URL.hostname KEEPS the brackets on an IPv6 literal (verified: `new
  // URL('http://[::1]/').hostname` is the five characters `[::1]`), so both forms
  // are stripped here rather than assuming the tidier one. Getting this wrong
  // fails in the annoying direction: a working loopback issuer refused with a
  // message about TLS.
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Parse one of the two OIDC URL fields, applying the rules both of them share.
 *
 * Rejected in every case, because each one either cannot work or is a credential
 * leak: a non-absolute value (there is no base to resolve it against inside the
 * process), a scheme other than http/https, embedded userinfo (it would sit in a
 * field the UI renders in the clear and an operator pastes into a bug report),
 * and a fragment (RFC 6749 §3.1 forbids one on both endpoints, and the
 * authorization response would silently drop everything after the `#` anyway,
 * because a fragment never reaches the server).
 */
function parseOidcUrl(raw: string, field: string): URL {
  const bad = (why: string) => httpError(400, `${field} ${why}`);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw bad('must be an absolute URL, e.g. https://auth.example.com');
  }
  // `new URL` parses `data:...` and `file:///etc` perfectly happily, so the
  // scheme has to be named explicitly rather than inferred from a successful parse.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw bad('must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw bad('must not embed credentials');
  }
  if (parsed.hash) throw bad('must not contain a fragment');
  return parsed;
}

/**
 * Accept an OIDC issuer identifier, or reject the request.
 *
 * Empty is accepted and means "not configured", which is how an operator takes
 * SSO out of service without deleting the client id and the allowlists they will
 * want back later. Enabling SSO with an empty issuer is refused separately, on
 * the merged result (assertUsableOidc).
 *
 * https is required, with ONE exception: a loopback host may use http.
 *
 * The exception exists because a self-hosted IdP on the same box (or reached
 * through an SSH tunnel, or run from a compose file on a developer's laptop)
 * frequently has no certificate, and refusing http there would mean the only way
 * to try this feature is to first stand up a CA. That is a real barrier for
 * exactly the homelab audience this is built for.
 *
 * The exception stops at loopback rather than extending to the whole LAN, and
 * that boundary is the point rather than an oversight. Everything that crosses
 * this connection is either a bearer credential or the material to mint one: the
 * client secret goes to the token endpoint, the authorization code comes back,
 * and the id_token that proves who the user is arrives in the response body. On
 * loopback that traffic never touches a wire. On a LAN it touches every switch,
 * access point and other device between here and the IdP, any of which can read
 * the code and the secret and then mint a session as the vault owner. "It is only
 * my home network" is the assumption; a plaintext token is the consequence when
 * the assumption is wrong.
 *
 * A query string is refused because discovery is `issuer + suffix` string
 * concatenation: `https://host/?x=1` would produce
 * `https://host/?x=1/.well-known/openid-configuration`, a URL that is not a typo
 * anyone spots by reading it. A path is allowed, because multi-tenant IdPs
 * legitimately issue from one (`https://host/realms/notes`).
 */
function requireIssuerUrl(value: string): string {
  const bad = (why: string) => httpError(400, `oidc.issuer ${why}`);
  const raw = value.trim().replace(/\/+$/, '');
  if (!raw) return '';
  const parsed = parseOidcUrl(raw, 'oidc.issuer');
  if (parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname)) {
    throw bad(
      'must use https; http is only accepted for a loopback host (localhost, 127.0.0.1, ::1), ' +
        'because the client secret, the authorization code and the id_token all travel over this ' +
        'connection in the clear',
    );
  }
  if (parsed.search) throw bad('must not contain a query string');
  return raw;
}

/**
 * Accept the redirect URI the IdP sends the authorization response to, or reject
 * the request.
 *
 * Empty is accepted and means "not configured here". That is deliberately not
 * treated as an error even when SSO is enabled: this server cannot know its own
 * external origin from inside the process (a reverse proxy, a container port
 * mapping and the Electron shell's 127.0.0.1 all disagree with what Node sees),
 * so deriving it from the arriving request is a legitimate strategy for the OIDC
 * service to take. What this door guarantees is that a value which IS stored is
 * one the callback route can actually serve.
 *
 * http is allowed here without the loopback restriction that applies to the
 * issuer, and the asymmetry is intentional: this URL is THIS server's own
 * address, and a self-hosted WebObsidian behind a plain-http reverse proxy or on
 * a LAN is the normal deployment rather than the exotic one. Refusing it would
 * make the feature unusable for most of its audience. The risk is not symmetric
 * either: an operator who terminates TLS elsewhere still gets an encrypted hop
 * where it counts, and the value here is only ever compared, never dialled.
 *
 * The path must end with OIDC_CALLBACK_PATH. "Ends with" rather than "equals"
 * because an install served under a sub-path by a reverse proxy is legitimate.
 * A query string is refused because the authorization response appends its own
 * (`?code=...&state=...`) and the exact-match rule at the IdP turns any
 * pre-existing one into a registration that is easy to get subtly wrong and hard
 * to debug: the failure surfaces at the IdP, before the redirect, as a generic
 * "invalid redirect_uri".
 */
function requireRedirectUri(value: string): string {
  const bad = (why: string) => httpError(400, `oidc.redirectUri ${why}`);
  const raw = value.trim().replace(/\/+$/, '');
  if (!raw) return '';
  const parsed = parseOidcUrl(raw, 'oidc.redirectUri');
  if (parsed.search) throw bad('must not contain a query string');
  if (!parsed.pathname.endsWith(OIDC_CALLBACK_PATH)) {
    throw bad(`must end with ${OIDC_CALLBACK_PATH}, which is the path this server answers on`);
  }
  return raw;
}

/**
 * Accept the scope list, or reject the request.
 *
 * `openid` is mandatory and its absence is a 400 rather than a silent fix. Without
 * it the authorization request is plain OAuth 2.0: the IdP may return an access
 * token and no id_token whatsoever, so there is no signed subject to bind a
 * session to. Silently adding the scope would be the friendlier-looking choice
 * and the wrong one, because the operator would then be looking at a saved value
 * they did not type while debugging why their IdP shows a consent screen they did
 * not expect. (The schema does heal it, for hand-edited files only, where there is
 * nobody to tell.)
 *
 * The character set is RFC 6749 §3.3's scope-token, which excludes the space that
 * delimits the list and the quote and backslash that would let a value break out
 * of the serialised parameter. A scope containing a space is not a scope, it is
 * two, and accepting it here would silently request something other than what the
 * operator sees stored.
 */
function requireScopes(value: unknown): string[] {
  const bad = (why: string) => httpError(400, `oidc.scopes ${why}`);
  if (!Array.isArray(value)) throw bad('must be an array of scope names');
  const scopes = normalizeOidcList(
    value.map((entry: unknown) => {
      if (typeof entry !== 'string') throw bad('entries must be strings');
      return entry;
    }),
  );
  for (const scope of scopes) {
    // RFC 6749 §3.3: scope-token = 1*( %x21 / %x23-5B / %x5D-7E ), i.e. printable
    // ASCII minus space, double quote and backslash.
    if (!/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope)) {
      throw bad(`entries must be OAuth scope tokens; ${JSON.stringify(scope)} is not one`);
    }
  }
  if (!scopes.includes('openid')) {
    throw bad(
      "must include 'openid'; without it the IdP is not required to return an id_token, so there " +
        'is no verified subject to attach the session to',
    );
  }
  return scopes;
}

/**
 * Accept one of the two access allowlists, or reject the request.
 *
 * Trimmed and de-duplicated but deliberately NOT case-folded: `sub` is an opaque,
 * case-sensitive string by specification and group names usually are too, so
 * lowercasing an entry here would turn a working allowlist into a lockout whose
 * cause is invisible in the UI, since the stored value and the claim would look
 * identical to a reader.
 */
function requireStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw httpError(400, `${field} must be an array of strings`);
  return normalizeOidcList(
    value.map((entry: unknown) => {
      if (typeof entry !== 'string') throw httpError(400, `${field} entries must be strings`);
      return entry;
    }),
  );
}

/**
 * Refuse to persist an OIDC block that cannot work, or that would lock everybody
 * out. Three separate failures, all of which would otherwise answer 200 and only
 * show themselves at the next login attempt.
 *
 * 1. Enabled with no issuer or no client id. There is no authorization request to
 *    build, so the SSO button leads to an error and nothing says why.
 * 2. A group allowlist without the `groups` scope. This one is the reason this
 *    check exists at all: the claim is only issued when the scope is requested,
 *    so an allowlist of groups that are never asked for can never match. Whether
 *    that fails closed (nobody can log in) or open (the check finds no claim and
 *    waves everyone through) depends on code elsewhere, and a security boundary
 *    whose behaviour depends on which way another module happens to have written
 *    an if statement is not a boundary. Refusing the combination removes the
 *    question.
 * 3. Password login off while OIDC is not usable. Every door closed at once,
 *    including the Electron shell's automatic WEBOBSIDIAN_PASSWORD login, with
 *    the only remedy being a hand edit of settings.json. The schema heals this
 *    for a file that arrived out of band; here it is a 400, because a request
 *    that does it is an operator about to lock themselves out and they should
 *    hear about it now rather than at the next restart.
 */
function assertUsableOidc(d: Settings): void {
  const o = d.oidc;
  if (o.enabled && !o.issuer) {
    throw httpError(400, 'oidc.issuer is required when oidc.enabled is true');
  }
  if (o.enabled && !o.clientId) {
    throw httpError(400, 'oidc.clientId is required when oidc.enabled is true');
  }
  if (o.allowedGroups.length && !o.scopes.includes('groups')) {
    throw httpError(
      400,
      "oidc.allowedGroups requires the 'groups' scope: the IdP only issues the groups claim when " +
        'it is requested, so an allowlist of groups that are never asked for can never match. Add ' +
        "'groups' to oidc.scopes, or clear oidc.allowedGroups.",
    );
  }
  if (!o.allowPasswordLogin && !isOidcUsable(o)) {
    throw httpError(
      400,
      'oidc.allowPasswordLogin cannot be false while OIDC is unusable: with oidc.enabled, ' +
        'oidc.issuer and oidc.clientId not all set there would be no way to sign in at all, ' +
        'including the desktop shell. Finish configuring OIDC in the same save, or leave password ' +
        'login enabled.',
    );
  }
}

/**
 * The roots a vault path may live under. Operator configuration ONLY.
 *
 * This is the single most important property in this file, so it is stated
 * plainly: nothing a request carries may influence the boundary that same request
 * is checked against. The previous version took `newAllowed` straight from the
 * PUT body and preferred it over everything else, which meant
 *
 *     PUT /api/settings {"vault":{"path":"C:\\","allowedRoots":["C:\\"]}}
 *
 * passed trivially. That is not a weak gate, it is not a gate: the request
 * supplied the rule it was measured against, so it granted itself the whole
 * filesystem as a read/write vault and, on the way, overrode the operator's
 * ALLOWED_ROOTS env, the only server-side control an operator has. Two requests
 * would have been enough even without the body preference, because
 * `vault.allowedRoots` was itself writable through the same PUT (write the roots
 * first, move the vault second), which is why sanitizeVault no longer accepts the
 * field at all and the schema documents it as operator-only.
 *
 * Precedence, all of it out of reach of the API:
 *   1. ALLOWED_ROOTS (config.allowedRoots). An operator who states a boundary
 *      explicitly gets that boundary and nothing may widen it, persisted settings
 *      included: previously the persisted list won, so a settings.json that had
 *      drifted wider silently voided the env. config.defaultVaultPath rides along
 *      because it is operator configuration too (VAULT_PATH), and without it an
 *      operator whose ALLOWED_ROOTS does not happen to contain their VAULT_PATH
 *      could not browse to their own vault.
 *   2. The persisted list, which now only ever changes through a hand edit of
 *      settings.json (filesystem access) or ensureVaultBrowsable's server-side
 *      healing, which can only ever add a path the gate already allowed.
 *   3. The home directory, unchanged, as the last-resort default for an install
 *      that has neither.
 *
 * One caveat worth stating rather than hiding: this does not retroactively narrow
 * an install whose persisted vault.path or allowedRoots were already widened by
 * exploiting the old behaviour. Case 2 keeps trusting the file. An operator who
 * suspects that should set ALLOWED_ROOTS, which case 1 makes authoritative.
 *
 * Used by both the PUT gate and GET /browse, which previously disagreed about
 * precedence. One function, one answer.
 */
async function effectiveRoots(): Promise<string[]> {
  const raw = config.allowedRoots.length
    ? [...config.allowedRoots, config.defaultVaultPath]
    : (await getSettings()).vault.allowedRoots;
  const roots = (raw.length ? raw : [os.homedir()]).map((r) => path.resolve(r));
  return [...new Set(roots)];
}

/** Confirm a candidate vault root is inside the operator's boundary and is a real
 *  directory. Throws 403/400; never returns a value the caller has to remember to
 *  check. `vaultPath` must already be absolute and normalised (requireVaultRoot). */
async function assertVaultPathAllowed(vaultPath: string): Promise<void> {
  const target = path.resolve(vaultPath);
  const roots = await effectiveRoots();
  if (!roots.some((r) => isWithinRoot(target, r))) {
    throw httpError(403, 'Vault path is outside the allowed roots');
  }
  const st = await fs.stat(target).catch(() => null);
  if (!st || !st.isDirectory()) {
    throw httpError(400, 'Vault path is not an existing directory');
  }
  // Symlink guard, mirroring assertRealpathInVault in services/vault.ts: the
  // check above is lexical, so a symlink sitting inside an allowed root and
  // pointing anywhere at all would satisfy it while the vault actually lands
  // outside the boundary (fs.stat follows the link, so it reports a directory).
  // Only done when the realpath differs, both to save the syscalls on the common
  // case and because realpath canonicalises case on Windows: comparing a
  // canonicalised target against uncanonicalised roots would 403 valid paths.
  const real = await fs.realpath(target).catch(() => target);
  if (real !== target) {
    const realRoots = await Promise.all(roots.map((r) => fs.realpath(r).catch(() => r)));
    if (!realRoots.some((r) => isWithinRoot(real, r))) {
      throw httpError(403, 'Vault path resolves outside the allowed roots');
    }
  }
}


/** Safe folder browser for picking a vault path, limited to allowed roots. */
settingsRouter.get(
  '/browse',
  asyncHandler(async (req, res) => {
    // Same roots as the PUT gate, from the same function. These two used to
    // compute the boundary independently and in a different precedence order,
    // which is how a browser could enumerate a directory the PUT would refuse
    // (and the reverse). A picker that shows a folder the save then rejects is
    // also just a bad experience, so agreeing has two payoffs.
    const roots = await effectiveRoots();
    const dir = req.query.dir ? path.resolve(String(req.query.dir)) : roots[0];

    const allowed = roots.some((r) => isWithinRoot(dir, r));
    if (!allowed) {
      res.status(403).json({ error: 'Path outside allowed roots', roots });
      return;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const folders = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ dir, parent: path.dirname(dir), roots, folders });
  }),
);
