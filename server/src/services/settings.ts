import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { config, SETTINGS_FILE } from '../config.js';
import { isDefaultPasswordActive } from './password-policy.js';
import { getApiKeyLastUsed } from './apikey-usage.js';
import { redactUrlCreds } from '../lib/redact.js';

/**
 * Schema version of the settings file this build writes. Bumped whenever a
 * one-shot migration below has to run exactly once per file. Files written by
 * older builds either carry a lower number or (pre-versioning) no `version`
 * field at all, which the schema's `.default(1)` turns into 1.
 */
const CURRENT_SETTINGS_VERSION = 2;

/** ---- Schema (PRD §6) ---------------------------------------------------- */

/**
 * True when `value` is a path that can only ever resolve INSIDE the vault.
 *
 * `vault.trash` is joined onto the vault root and the result is then treated as a
 * trusted directory: the trash listing enumerates it and "empty trash" runs
 * fs.rm(recursive, force) over every entry in it. With no containment check, a
 * single settings write of `trash: "..\\..\\..\\..\\Windows\\Temp"` re-points that
 * machinery at an arbitrary host directory, turning a notes setting into directory
 * disclosure plus recursive deletion. Path.join happily walks out of the root, so
 * the value has to be rejected before it is ever joined.
 *
 * `vault.attachmentDir` is held to the same rule even though, as of this build,
 * nothing in server/, web/ or desktop/ reads it. Being honest about that matters:
 * the containment argument above is a statement about `trash` today and about
 * `attachmentDir` the moment anyone joins it onto the vault root, which is the
 * only thing an "attachment directory" can ever be for. Validating it now costs a
 * line and means the first consumer inherits the invariant instead of having to
 * rediscover it.
 *
 * Rejected: empty/whitespace-only, NUL bytes, drive-qualified ("C:foo", "C:\foo"),
 * rooted ("/x", "\x"), UNC ("\\\\host\\share") and anything containing a ".."
 * segment under either separator. Nested sub-paths ("archive/trash") are fine.
 */
export function isVaultRelativeSubpath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  if (!raw) return false;
  // A NUL truncates the path inside libuv, so "ok\0/../../etc" would pass a
  // string-level check and then resolve to something else entirely at syscall time.
  if (raw.includes('\0')) return false;
  // Drive-relative forms ("C:foo") are NOT absolute per path.win32.isAbsolute but
  // still escape the vault once the OS resolves them against the drive's cwd.
  if (/^[A-Za-z]:/.test(raw)) return false;
  // Check BOTH flavours: a server on Linux must still refuse a backslash-rooted
  // value, because the same settings.json travels between hosts.
  if (path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw)) return false;
  const segments = raw.split(/[\\/]+/);
  for (const seg of segments) {
    // Empty (collapsed separators) and "." are no-op segments: neither moves the
    // resolved path, so neither can be part of an escape.
    if (seg === '' || seg === '.') continue;
    // Byte-equality against ".." is not enough on Windows. Win32 strips trailing
    // dots and spaces from every path component before the path reaches the
    // filesystem, so ".. ", "..  ", "..." and ". ." all resolve as a
    // parent-directory hop while none of them is `seg === '..'`. That is a real
    // hole and not a theoretical one: "a/.. /.. /x" used to be accepted here and
    // then resolved above the vault root on a Windows host. No directory on any
    // OS is legitimately named out of nothing but dots and spaces, so treat the
    // whole class as an escape attempt.
    if (/^[.\s]+$/.test(seg)) return false;
    // Same family, one step out: a segment that leans on leading or trailing
    // whitespace means two different directories on two different hosts (Win32
    // strips it, POSIX keeps it) and the same settings.json travels between
    // hosts. Refusing it also removes every remaining "looks like X, resolves to
    // Y" trick without costing a user anything real.
    if (seg !== seg.trim()) return false;
  }
  // "." or "./" alone would make the trash root the vault root itself, so
  // "empty trash" would wipe the whole vault. Require a real sub-directory.
  if (!segments.some((seg) => seg !== '' && seg !== '.')) return false;
  return true;
}

/**
 * A vault-relative directory setting that self-heals instead of exploding.
 *
 * The refinement is what makes the invariant hold for a hand-edited settings.json
 * (the HTTP layer has its own check that answers 400, see routes/settings.ts).
 * The trailing `.catch()` matters as much as the refinement: loadSettings() treats
 * ANY parse failure as "file is unusable" and rewrites the file from defaults, so
 * letting this field throw would trade a path-traversal bug for silently
 * destroying the operator's jwtSecret, API keys and git token. Coercing the one
 * bad field back to its safe default (loudly) keeps the rest of the file intact.
 *
 * The `.transform()` in front of the refinement is what makes the two entry points
 * agree. routes/settings.ts stores `value.trim()`, while this schema used to test
 * a trimmed copy and then store the untrimmed original: `{"trash": "  .trash  "}`
 * validated as `.trash` and was persisted with its padding, which Win32 then
 * resolves as `<vault>\  .trash` (it strips the trailing space, not the leading
 * one). Same input, two different directories depending on which door it came
 * through. Trimming before the refinement collapses that to one meaning.
 */
function vaultRelativePath(fallback: string) {
  return z
    .string()
    .default(fallback)
    .transform((v) => v.trim())
    .refine(isVaultRelativeSubpath, {
      message:
        'must be a vault-relative sub-path: no absolute paths, drive letters, UNC prefixes or ".." segments',
    })
    .catch((ctx: { input: unknown }) => {
      console.warn(
        `[settings] refusing out-of-vault path ${JSON.stringify(ctx.input)}; using ${JSON.stringify(fallback)} instead`,
      );
      return fallback;
    });
}

/**
 * The vault root, as an absolute host path, with an empty value healed rather
 * than honoured.
 *
 * Empty is not a neutral value for this field, which is exactly why it needs its
 * own guard rather than a bare `z.string()`. `services/vault.ts:getVaultRoot()` is
 * `path.resolve(s.vault.path)`, and `path.resolve('')` returns the server's own
 * current working directory. An empty (or "." or "./" or relative) value therefore
 * silently relocates the whole files API onto the install directory, where with
 * the default `DATA_DIR=./data` a plain `GET /api/files/content?path=data/settings.json`
 * reads out `auth.jwtSecret`, both password hashes, `git.token` and every API key
 * hash in cleartext (a total bypass of redactSettings), and a `PUT` to
 * `server/dist/index.js` or `web/dist/index.html` is code execution on the next
 * restart. The HTTP layer refuses these values with a 400 (routes/settings.ts);
 * this is the matching self-heal for a hand-edited, truncated or half-migrated
 * file.
 *
 * Requiring absolute (rather than only rejecting empty) is deliberate: "." and
 * ".." are the same catastrophe as "", and any other relative value silently
 * depends on how the process happened to be launched, which is not something an
 * operator can reason about. The heal is loud for that reason, because a
 * previously-working relative path changing to the configured default vault is a
 * visible behaviour change and must not be discovered by finding an empty file
 * tree.
 *
 * `.catch()` rather than a throw, for the reason spelled out on vaultRelativePath:
 * a throw here makes loadSettings() rewrite the entire file from defaults() and
 * destroy the operator's secrets.
 */
function vaultRootPath() {
  const heal = (input: unknown): string => {
    console.warn(
      `[settings] refusing unusable vault path ${JSON.stringify(input)}; using ${JSON.stringify(config.defaultVaultPath)} instead`,
    );
    return config.defaultVaultPath;
  };
  return z
    .string()
    // Defaulting to the configured vault (rather than to "") keeps a first boot
    // and a `parse({})` on the silent path: only a value the file actually
    // contains can reach `heal`, so the warning above always means something.
    .default(config.defaultVaultPath)
    .transform((v) => {
      const p = v.trim();
      // NUL truncates inside libuv, so the string checked here would not be the
      // path opened at syscall time.
      if (!p || p.includes('\0') || !path.isAbsolute(p)) return heal(v);
      // Normalise once, here, so every later comparison (allowed-roots
      // containment, ensureVaultBrowsable) works on one canonical form.
      return path.resolve(p);
    })
    .catch((ctx: { input: unknown }) => heal(ctx.input));
}

const ApiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  hash: z.string(),
  prefix: z.string(), // first chars, for display
  scopes: z.array(z.enum(['read', 'write', 'search'])).default(['read', 'search']),
  createdAt: z.string(),
  // Legacy field, kept so an existing settings.json round-trips without losing
  // the value it already holds. Live "last used" tracking moved to
  // services/apikey-usage.ts: it is per-request telemetry, and writing it here
  // meant every authenticated API call did a read-modify-write over the same
  // file that stores the key list itself (see the note on updateSettings).
  // Nothing writes this any more; it is only ever read as a seed value.
  lastUsed: z.string().nullable().default(null),
});

/**
 * The literal that stands in for a stored secret in every API response, and the
 * literal the settings PUT reads back as "the client did not change this".
 *
 * Eight U+2022 BULLET characters. It is a shared constant rather than a repeated
 * literal because it is load-bearing on BOTH sides of one round trip:
 * redactSettings() writes it, and routes/settings.ts compares an incoming value
 * against it byte-for-byte before deciding whether that value is a new secret.
 * Let the two copies drift and the failure is silent in the worst possible
 * direction: the comparison stops matching, so the mask the UI just echoed back
 * is stored as if it were the operator's real password or passphrase, and the
 * credential is destroyed by a save that reported success. Byte-identical, one
 * definition, both doors.
 */
export const REDACTED_SECRET = '••••••••';

/**
 * True when the LiveSync E2EE settings are in the one combination that looks
 * configured and is not: an obfuscation passphrase with no encryption passphrase.
 *
 * This gets a long note because the failure is invisible from outside and it
 * defeats the exact check an operator would run to convince themselves that
 * end-to-end encryption is on.
 *
 * The engine derives encryption from the passphrase ALONE. In
 * server/vendor/livesync-engine, DirectFileManipulatorV2's `get settings()`
 * builds the remote database settings with
 * `encrypt: this.options.passphrase ? true : false`, while the document id is
 * hashed on a separate path via
 * `path2id_base(name, this.options.obfuscatePassphrase ?? false, ...)`. So with
 * obfuscatePassphrase set and passphrase empty:
 *
 *   - every document id in CouchDB is opaque (`f:<hash>`), which is precisely
 *     what KICKOFF acceptance criterion 3 tells an operator to look for, and
 *   - every document BODY is written in the clear, so `path`, `mtime`, `size`
 *     and the chunk contents of every note are readable by anyone who can read
 *     the database.
 *
 * An operator who lists the ids sees opaque hashes, concludes E2EE is honoured,
 * and is wrong about every byte that matters. That is worse than plainly
 * unencrypted replication, because unencrypted replication does not claim
 * otherwise. Both doors therefore refuse the combination: the API answers 400
 * (routes/settings.ts) and the schema below refuses to RUN the backend when a
 * hand-edited file contains it.
 *
 * Structural, not stylistic: the predicate lives here so the HTTP layer, the
 * schema and services/livesync.ts all ask the same question in the same words.
 */
export function isUnsafeE2eePairing(v: {
  passphrase: string;
  obfuscatePassphrase: string;
}): boolean {
  return Boolean(v.obfuscatePassphrase) && !v.passphrase;
}

/**
 * The LiveSync (CouchDB) backend configuration, as a sibling of the `git` block.
 *
 * One deliberate difference from every other string field in this file: nothing
 * in here is trimmed except the fields where surrounding whitespace can only
 * ever be a paste artefact. `password`, `passphrase` and `obfuscatePassphrase`
 * are stored byte-for-byte INCLUDING leading and trailing whitespace, because
 * they are key material. Trimming a passphrase silently derives a different key,
 * and the symptom is not an error at save time: it is a remote database full of
 * documents this instance can no longer decrypt, discovered long afterwards with
 * nothing left to reconstruct the original string from. `uri`, `database` and
 * `username` are trimmed, because " http://host " is never anything but a typo.
 */
const LiveSyncBlockSchema = z.object({
  /**
   * The CouchDB base URL, WITHOUT the database name and without a trailing
   * slash. The engine builds its endpoint by string concatenation
   * (`this.options.url + "/" + this.options.database` in
   * DirectFileManipulatorV2.$$createPouchDBInstance), so a stored trailing slash
   * yields `http://host//db`. That is not a cosmetic difference: CouchDB treats
   * the empty path segment as a database name of its own, so the request lands
   * somewhere that does not exist and the backend reports a connection problem
   * that no amount of staring at the URL explains. Normalising here, and
   * identically in routes/settings.ts, means both entry points store one string.
   *
   * Credentials do not belong in this field. The API refuses a URL carrying
   * userinfo outright, and redactSettings() masks it on the way out in case a
   * hand-edited file has one anyway.
   */
  uri: z
    .string()
    .default('')
    .transform((v) => v.trim().replace(/\/+$/, '')),
  database: z
    .string()
    .default('')
    .transform((v) => v.trim()),
  username: z
    .string()
    .default('')
    .transform((v) => v.trim()),
  // The three secrets. Never trimmed (see the block note), never logged, always
  // masked by redactSettings() before they can reach a client.
  password: z.string().default(''),
  passphrase: z.string().default(''),
  obfuscatePassphrase: z.string().default(''),
  /**
   * Continuous replication, opt-in, default FALSE.
   *
   * That default is a safety property rather than a taste: live mode holds an
   * open changes feed and applies remote writes into the vault the moment they
   * arrive, so an operator who mistypes a database name (or points a fresh
   * instance at a colleague's cluster) finds out by having someone else's vault
   * written over theirs in real time. Interval polling reaches the same steady
   * state one tick later, with a window in which a misconfiguration can still be
   * noticed and corrected. Turn it on once the pairing is proven.
   */
  liveMode: z.boolean().default(false).catch(false),
  /**
   * Poll interval when liveMode is off, in seconds.
   *
   * Bounded for the same reason as api.rateLimitPerMin above: at 0 or a negative
   * value the scheduler's timer degenerates into a hot loop hammering CouchDB,
   * and because the value is persisted the damage survives a restart. `.catch()`
   * so that one bad literal in a hand-edited file cannot take the whole file
   * down with it, which (see `version`) would rewrite it from defaults and
   * destroy jwtSecret, the API keys and git.token.
   */
  intervalSec: z.number().int().min(1).default(30).catch(30),
  /**
   * Vault-relative directories replicated as LiveSync internal (`i:`) documents.
   * EMPTY BY DEFAULT, which is why this is a list of opt-in directories rather
   * than the boolean the reference bridge exposes.
   *
   * Two independent reasons, and either one on its own would be enough:
   *
   * 1. The reference bridge's own implementation of this feature is broken. It
   *    strips the base directory BEFORE adding the `i:` prefix, so the stored
   *    name is mangled, and it never re-adds the prefix on the outbound side, so
   *    the same file comes back as a second, divergent document. Shipping the
   *    feature on by default would mean shipping that defect on by default.
   * 2. WebObsidian's own watcher in server/src/index.ts deliberately ignores
   *    `.obsidian/`, because desktop Obsidian rewrites its workspace files
   *    constantly and floods the server. Replicating those same files inbound
   *    while refusing to watch them outbound is a one-way flow that no operator
   *    asked for.
   *
   * Entries are validated as vault-relative sub-paths by the API (the same
   * predicate that guards vault.trash), because an entry here is joined onto the
   * vault root exactly like that one is: a `..` segment would replicate the
   * operator's home directory into CouchDB. A hand-edited file with a bad entry
   * heals to the empty list rather than to "everything", i.e. fail closed:
   * replicating nothing extra is always recoverable, replicating the wrong tree
   * to a remote is not.
   */
  includeInternal: z
    .array(z.string())
    .default([])
    .transform((v) => v.map((entry) => entry.trim()))
    .refine((v) => v.every(isVaultRelativeSubpath), {
      message:
        'each entry must be a vault-relative sub-path: no absolute paths, drive letters, UNC prefixes or ".." segments',
    })
    .catch((ctx: { input: unknown }) => {
      console.warn(
        `[settings] refusing livesync.includeInternal ${JSON.stringify(ctx.input)}; replicating no internal files instead`,
      );
      return [] as string[];
    }),
});

/**
 * The path this server serves the OIDC authorization response on, as it appears
 * in `redirect_uri`.
 *
 * It lives here, next to the setting it validates, because three separate places
 * have to agree on it byte-for-byte and only one of them is a route file: the
 * settings PUT refuses a redirectUri that does not end with it, the OIDC service
 * builds the authorization request from the stored value, and the operator types
 * the same string into the IdP's client registration. `redirect_uri` matching at
 * the authorization server is an exact string comparison (RFC 6749 §3.1.2.3,
 * restated as a MUST for OIDC in OpenID Connect Core §3.1.2.1), so a difference
 * of one character is not a near miss: the IdP refuses the whole request, before
 * the user ever reaches a consent screen, with an error page that names nothing
 * this operator can act on.
 *
 * The leading `/auth` is the mount point of authRouter in server/src/index.ts.
 * "Ends with" rather than "equals" is what the check below tests, because an
 * install behind a reverse proxy that serves WebObsidian under a sub-path
 * (https://host/notes/auth/oidc/callback) is a legitimate deployment and the
 * server cannot know its own external prefix from inside the process.
 */
export const OIDC_CALLBACK_PATH = '/auth/oidc/callback';

/**
 * Trim, drop empties and de-duplicate a list of opaque strings, preserving order.
 *
 * Used for all three of the OIDC list fields (scopes, allowedSubjects,
 * allowedGroups) because they want identical treatment: an operator pastes them
 * one per line, so blank lines and stray padding are the normal input, and a
 * duplicate entry means nothing in any of the three.
 *
 * Shared by both doors for the usual reason: the API normalises what it stores
 * and the schema normalises what it loads, and a scope list that differed between
 * the two would mean the authorization request sent after a save is not the one
 * sent after a restart.
 *
 * Order is preserved rather than sorted, and nothing is case-folded. Sorting
 * would rewrite input the operator reads back in the UI for no gain, and folding
 * case would be actively wrong for the allowlists: `sub` is an opaque,
 * case-sensitive string by specification, so lowercasing it turns a working
 * allowlist entry into a lockout that looks identical to a working one.
 */
export function normalizeOidcList(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const entry = raw.trim();
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/**
 * `openid` first, always. Without that scope the authorization request is a bare
 * OAuth 2.0 request: the IdP is entitled to return an access token and NO
 * id_token at all, so there is no signed subject to bind a session to and the
 * whole point of this feature (persisting an identity rather than merely opening
 * a door) quietly evaporates. The API refuses a scope list that omits it with a
 * 400, so this heal only ever runs against a hand-edited file.
 */
function withOpenIdScope(scopes: string[]): string[] {
  return scopes.includes('openid') ? scopes : ['openid', ...scopes];
}

/**
 * True when the OIDC block is in a state the login flow can actually run in.
 *
 * Exported for the same structural reason as isUnsafeE2eePairing above: the HTTP
 * layer, the schema's self-heal and (later) the OIDC service itself all have to
 * ask this question in the same words, or an operator ends up with a block that
 * one layer calls configured and another calls empty.
 *
 * `redirectUri` is deliberately NOT part of the test. It is validated when it is
 * present, but an empty one is left to the service to fill in from the request
 * that is actually arriving, which is the only place the server's external
 * origin is knowable. `clientSecret` is not part of it either: a public client
 * authenticating with PKCE alone has no secret, and this IdP supports that.
 */
export function isOidcUsable(o: { enabled: boolean; issuer: string; clientId: string }): boolean {
  return Boolean(o.enabled && o.issuer && o.clientId);
}

/**
 * Native OIDC single sign-on (FR-15), as a sibling of the `git` and `livesync`
 * blocks.
 *
 * Why the identity is configured here at all, rather than being left to a
 * reverse-proxy forward-auth: a forward-auth gate tells this process that SOMEONE
 * authenticated and nothing else, so every visitor collapses into the one owner
 * session and no per-user state can ever be built on top of it. It also only
 * covers browsers, leaving the /api/v1 agent API, the Electron shell talking to
 * 127.0.0.1 and the /ws upgrade unserved. Storing the issuer and the client here
 * means the identity is something this server learns and can keep.
 */
const OidcBlockSchema = z.object({
  /**
   * Off by default, so this block appearing in an existing install changes
   * nothing until an operator opts in. `.catch()` for the reason documented on
   * `version`: a bad literal in a hand-edited file must not fail the parse and
   * take jwtSecret, the API keys and git.token down with it.
   */
  enabled: z.boolean().default(false).catch(false),
  /**
   * Whether to send a PKCE challenge, and the reason this is a setting rather
   * than a constant.
   *
   * PKCE should be on wherever it works, but hardcoding it locks out any IdP
   * that genuinely does not support it, with no recourse for the operator.
   * Hardcoding it OFF would be worse. So three states, and the default is the
   * one that is both secure and correct against a real-world server:
   *
   *   'auto'  send S256 when the server advertises it, AND when the server says
   *           nothing at all. Silence is not denial. This is not a hypothetical:
   *           Pocket ID supports S256 per client but omits
   *           `code_challenge_methods_supported` from its discovery document
   *           entirely, so a strict reading of the metadata would silently
   *           downgrade a working deployment. Only skip when the server
   *           explicitly publishes a method list that excludes S256, which is
   *           the one case where it has actually told us no.
   *   'force' always send, for a server whose metadata is wrong in the other
   *           direction (advertises a list that omits S256 while supporting it).
   *   'off'   never send. The escape hatch for a server that rejects the
   *           parameter outright.
   *
   * A silent PKCE downgrade is invisible in every log, which is why
   * `describePkceDecision()` records the branch taken at connect time: the
   * answer to "is PKCE actually on?" has to be observable, not inferred.
   */
  pkce: z.enum(['auto', 'force', 'off']).default('auto').catch('auto'),
  /**
   * The IdP's issuer identifier, e.g. https://auth.example.com.
   *
   * Stored WITHOUT a trailing slash, and the reason is the same shape as
   * livesync.uri's: discovery appends a fixed suffix to this string
   * (`issuer + "/.well-known/openid-configuration"`), so a stored trailing slash
   * produces a double slash. Some servers tolerate that and some 404, and the
   * ones that 404 do it in a way that looks like the IdP being down rather than
   * like a settings typo. Both doors normalise identically so there is one
   * stored form.
   *
   * The value is also compared against the `iss` claim of the returned id_token,
   * which is another reason it has to be one canonical string rather than
   * whatever the operator happened to paste.
   */
  issuer: z
    .string()
    .default('')
    .transform((v) => v.trim().replace(/\/+$/, '')),
  clientId: z
    .string()
    .default('')
    .transform((v) => v.trim()),
  /**
   * The client secret, for a confidential client. NEVER trimmed, for the same
   * reason the LiveSync secrets are not: it is an opaque credential issued by
   * something else, this process never gets to decide which of its bytes are
   * significant, and a silently trimmed secret fails as an authentication error
   * at the token endpoint with nothing pointing back at the save that caused it.
   *
   * Empty is legitimate. A public client using PKCE alone has no secret, and
   * that is a supported (and, where the redirect target is a desktop shell,
   * preferable) configuration.
   */
  clientSecret: z.string().default(''),
  /**
   * Where the IdP sends the authorization response. Must end with
   * OIDC_CALLBACK_PATH; see the note on that constant for why exact matching
   * makes this field unforgiving.
   *
   * Trailing slashes are stripped rather than preserved. `/callback` and
   * `/callback/` are two different registrations to an authorization server, and
   * the form this Express app actually serves is the one without the slash, so
   * normalising to it turns a paste artefact into a working configuration
   * instead of an "invalid redirect_uri" page.
   */
  redirectUri: z
    .string()
    .default('')
    .transform((v) => v.trim().replace(/\/+$/, '')),
  /**
   * The scopes requested at the authorization endpoint.
   *
   * The default is the minimum that yields a usable identity: `openid` for the
   * id_token itself, `profile` and `email` for something human-readable to show
   * next to the session. `groups` is deliberately NOT in the default, because
   * asking for a claim nothing consults is a request for data this application
   * has no reason to hold. Add it when allowedGroups is used, which is exactly
   * what the API insists on (see assertUsableOidc in routes/settings.ts).
   *
   * The `.catch()` heals to the default list rather than to the empty one: an
   * empty scope list is not a safer request, it is a request that returns no
   * identity at all.
   */
  scopes: z
    .array(z.string())
    .default(['openid', 'profile', 'email'])
    .transform((v) => withOpenIdScope(normalizeOidcList(v)))
    .catch((ctx: { input: unknown }) => {
      console.warn(
        `[settings] refusing oidc.scopes ${JSON.stringify(ctx.input)}; requesting openid, profile, email instead`,
      );
      return ['openid', 'profile', 'email'];
    }),
  /**
   * The IdP subjects (`sub` claims) allowed to take the owner session, and the
   * groups allowed to do the same. EMPTY MEANS "ANY SUBJECT THE IdP WILL
   * AUTHENTICATE", and that deserves to be said out loud rather than discovered.
   *
   * On a single-account homelab IdP that is exactly right and asking for an
   * allowlist would be busywork. On a shared IdP (a work SSO, a family instance,
   * anything with self-registration enabled) it means every account in the
   * directory can log in as the owner of this vault, with full read and write
   * over every note. The two fields are the boundary; there is no third thing
   * checking anything. Set at least one of them whenever the IdP has more
   * accounts than this vault has owners.
   *
   * Matching is on the raw claim values, so entries are trimmed and de-duplicated
   * but never case-folded: `sub` is an opaque, case-sensitive string by
   * specification, and lowercasing it would turn a non-match into a silent
   * lockout that no amount of staring at the two strings explains.
   *
   * Both heal to the empty list on a malformed hand edit. That is the permissive
   * direction, and it is the right one here only because the gate in front of it
   * is the IdP: healing to a non-empty guess would invent an access rule nobody
   * wrote, and healing to "deny everything" would lock the operator out of the
   * instance with the fix living in the file that is already broken.
   */
  allowedSubjects: z
    .array(z.string())
    .default([])
    .transform((v) => normalizeOidcList(v))
    .catch((ctx: { input: unknown }) => {
      console.warn(
        `[settings] refusing oidc.allowedSubjects ${JSON.stringify(ctx.input)}; allowing any authenticated subject instead`,
      );
      return [] as string[];
    }),
  allowedGroups: z
    .array(z.string())
    .default([])
    .transform((v) => normalizeOidcList(v))
    .catch((ctx: { input: unknown }) => {
      console.warn(
        `[settings] refusing oidc.allowedGroups ${JSON.stringify(ctx.input)}; applying no group restriction instead`,
      );
      return [] as string[];
    }),
  /**
   * Verified email addresses that may sign in.
   *
   * This field was matched on by isAllowed() from the day SSO landed and was
   * never declared here, so zod's default object behaviour (strip unknown keys)
   * silently deleted it on the first load and every write after that. The
   * setting looked configurable, the matcher had a paragraph explaining that an
   * entry here requires email_verified, and the list it read was permanently
   * empty. An operator setting only this got a locked instance and a log line
   * saying their account "matches no allowlist entry", with nothing anywhere
   * pointing at the real cause.
   *
   * Lowercased on the way in because addresses are not case-significant in
   * practice, matching how the matcher compares them. Subjects deliberately are
   * not: see the note above.
   */
  allowedEmails: z
    .array(z.string())
    .default([])
    .transform((v) => normalizeOidcList(v).map((entry) => entry.toLowerCase()))
    .catch((ctx: { input: unknown }) => {
      console.warn(
        `[settings] refusing oidc.allowedEmails ${JSON.stringify(ctx.input)}; applying no email restriction instead`,
      );
      return [] as string[];
    }),
  /**
   * Allowlist rules on a claim this app does not know the name of.
   *
   * The four fixed axes cover what OIDC standardises, and standardised claims
   * are not what most IdPs key identity on. A real Pocket ID token carries
   * `preferred_username`, `nextcloud_username` and `portainer_username` at once,
   * because it lets an operator define per-client custom claims, and which one
   * means "the user" is a deployment decision. So take the claim name from the
   * operator rather than adding a fixed field per claim anyone might use.
   *
   * Rules OR with each other and with the fixed axes, matching how the fixed
   * axes already behave. Claim names that are the same for every user of an
   * issuer (`iss`, `aud`, `type`, ...) are refused at the API and dropped here:
   * see RESERVED_CLAIMS in services/oidc.ts for why each one is on that list.
   */
  allowedClaims: z
    .array(z.object({ claim: z.string(), values: z.array(z.string()) }))
    .default([])
    .catch((ctx: { input: unknown }) => {
      console.warn(
        `[settings] refusing oidc.allowedClaims ${JSON.stringify(ctx.input)}; applying no claim restriction instead`,
      );
      return [] as { claim: string; values: string[] }[];
    }),
  /**
   * Whether the password form still works once SSO is configured. DEFAULT TRUE,
   * and the default is a compatibility requirement rather than a preference.
   *
   * The Electron desktop shell starts the server itself and logs in without a
   * human: it injects a shared secret as WEBOBSIDIAN_PASSWORD and posts it to
   * /auth/login on startup. That path has no browser to redirect to an IdP and
   * no way to complete an authorization code flow, so turning password login off
   * does not harden the desktop app, it bricks it. The same is true of any
   * scripted client that logs in with the owner password. Operators who want
   * SSO-only should turn this off deliberately, after checking that nothing they
   * run depends on the password door.
   *
   * Turning it off while OIDC is not usable locks every door at once, which the
   * API refuses (assertUsableOidc) and the schema heals (enforceLoginReachable).
   */
  allowPasswordLogin: z.boolean().default(true).catch(true),
});

const SettingsBaseSchema = z.object({
  /**
   * Schema version of the file on disk. Two separate behaviours, and they need
   * different answers, which is why this is not a bare `z.number()`:
   *
   * - ABSENT (`.default(1)`): every file written before versioning existed. That
   *   is the legacy population the migration below is for, so it must read as 1.
   * - PRESENT BUT MALFORMED (`.catch(...)`): `"version": "2"` or `null` from a
   *   hand edit or a truncated write. Without the `.catch()` this field throws,
   *   and loadSettingsImpl's bare catch treats ANY parse failure as "file is
   *   unusable" and rewrites from defaults(): one mistyped character would
   *   destroy jwtSecret, userPasswordHash, git.token and every API key, logging
   *   the owner out permanently and revoking every agent key. The same reasoning
   *   already documented on vaultRelativePath applies verbatim here.
   *
   * The caught value is CURRENT, not 1, and the difference is load-bearing. Only
   * a file that already contains a `version` key can reach the catch, and only a
   * build that knows about versioning writes one, so a malformed value means
   * "written by v2 or later, then mangled". Healing it to 1 would re-run the
   * one-shot auth migration against a file that has already been migrated, which
   * is the precise misfire the migration comment below exists to prevent.
   */
  version: z.number().int().default(1).catch(CURRENT_SETTINGS_VERSION),
  auth: z
    .object({
      // The password the user changed to. Empty = still on the default one (123456).
      userPasswordHash: z.string().default(''),
      // Override password for recovering from a forgotten password (edited into
      // this file by hand). Empty = none.
      passwordHash: z.string().default(''),
      jwtSecret: z.string().default(''),
    })
    .default({}),
  vault: z
    .object({
      path: vaultRootPath(),
      // NOT writable over HTTP: see the note on effectiveRoots() in
      // routes/settings.ts. This is the gate a vault path is checked against, so
      // it may only be set by operator configuration (the ALLOWED_ROOTS env, or
      // a hand edit of this file), never by the request being gated.
      allowedRoots: z.array(z.string()).default([]),
      trash: vaultRelativePath('.trash'),
      // Deleting a file: 'trash' = move it into the .trash folder (recoverable);
      // 'permanent' = delete it for good, immediately.
      deleteMode: z.enum(['trash', 'permanent']).default('trash'),
      attachmentDir: vaultRelativePath('attachments'),
    })
    .default({}),
  git: z
    .object({
      enabled: z.boolean().default(false),
      remote: z.string().default(''),
      branch: z.string().default('main'),
      token: z.string().default(''),
      authorName: z.string().default('WebObsidian'),
      authorEmail: z.string().default('webobsidian@localhost'),
      autoSync: z.boolean().default(false),
      autoCommitOnSave: z.boolean().default(false),
      intervalSec: z.number().default(300),
      lfsPatterns: z
        .array(z.string())
        .default(['*.png', '*.jpg', '*.jpeg', '*.gif', '*.pdf', '*.mp4', '*.mov', '*.zip']),
    })
    .default({}),
  /**
   * Which backend owns this vault's synchronisation. ONE value, never a set.
   *
   * Mutual exclusivity is enforced by the SHAPE of this field, deliberately, and
   * it is a data-integrity rule rather than a UI simplification (KICKOFF §5.3).
   * Git and LiveSync have incompatible conflict models: git resolves at commit
   * granularity over a working tree it assumes it alone mutates, while LiveSync
   * resolves per document against revision history held in CouchDB. Run both
   * over one vault and each one's writes look to the other like an unexplained
   * local edit. A checkout reverts a replicated change, LiveSync replicates the
   * revert back out as a new revision, the next tick reverts it again, and the
   * vault churns between two histories with no principled way to say which side
   * is right. There is no merge that repairs that after the fact, so the settings
   * model refuses to let the state be expressed at all: an enum cannot hold two
   * values, and there is no "both" for a UI to offer or a PUT to smuggle in.
   *
   * 'none' is the default so that this block appearing in an existing install
   * changes nothing until an operator opts in. The legacy `git.enabled` and
   * `git.autoSync` flags keep their current meaning for the git path and are
   * deliberately NOT rewritten when the backend changes: silently clearing an
   * operator's git configuration on a backend switch would be a surprise, and it
   * would not survive switching back. The contract is instead that
   * services/autosync.ts treats `sync.backend` as authoritative and must not run
   * the git path while the backend is 'livesync' (KICKOFF acceptance criterion 7:
   * git behaviour is unchanged when the backend is not 'livesync').
   *
   * `.catch()` for the usual reason documented on `version`: an unrecognised
   * literal in a hand-edited file heals to 'none' (no sync at all, the only safe
   * answer to "which writer owns this vault?") instead of failing the parse and
   * taking jwtSecret, the API keys and git.token down with it.
   */
  sync: z
    .object({
      backend: z.enum(['none', 'git', 'livesync']).default('none').catch('none'),
    })
    .default({}),
  livesync: LiveSyncBlockSchema.default({}),
  oidc: OidcBlockSchema.default({}),
  search: z
    .object({
      fuzzy: z.number().default(0.2),
      prefix: z.boolean().default(true),
      indexFrontmatter: z.boolean().default(true),
    })
    .default({}),
  api: z
    .object({
      keys: z.array(ApiKeySchema).default([]),
      // Bounds, not decoration. middleware/apikey.ts gates every /api/v1 request
      // on `rateOk(record.id, s.api.rateLimitPerMin)`, whose test is
      // `arr.length >= perMin`. At 0 or a negative value that is true on the very
      // first request, so every valid agent key is 429'd unconditionally, and
      // because the value is persisted the lockout survives a restart. A
      // fractional value makes the budget silently unpredictable instead. Neither
      // is reachable without the owner's own credentials, but a self-inflicted,
      // persistent denial of service is worth one token to close.
      // `.catch()` for the usual reason: a bad literal in a hand-edited file must
      // not take the rest of the file down with it (see `version` above).
      rateLimitPerMin: z.number().int().min(1).default(120).catch(120),
    })
    .default({}),
  ui: z
    .object({
      theme: z.enum(['obsidian-dark', 'obsidian-light']).default('obsidian-light'),
      defaultView: z.enum(['live', 'source', 'reading']).default('live'),
    })
    .default({}),
  plugins: z
    .object({
      enabled: z.array(z.string()).default([]),
      installed: z.array(z.string()).default([]),
    })
    .default({}),
});

type SettingsBase = z.infer<typeof SettingsBaseSchema>;

/**
 * The self-heal that pairs with the API's 400 for the E2EE hazard documented on
 * isUnsafeE2eePairing(): a settings file that would run the LiveSync backend
 * with an obfuscation passphrase and no encryption passphrase does not run it.
 *
 * This is the same division of labour the vault path fields use. The HTTP layer
 * refuses the combination loudly (routes/settings.ts), and this is the matching
 * non-destructive fallback for a file that arrived by a hand edit, a restored
 * backup, or a build that predates the check.
 *
 * Three plausible heals, and only one of them is honest:
 *
 *   - Clear obfuscatePassphrase. Rejected: replication then proceeds with
 *     plaintext ids AND plaintext bodies, which silently downgrades what the
 *     operator asked for, and re-keys every document id in a database that may
 *     already be populated.
 *   - Copy obfuscatePassphrase into passphrase. Rejected outright: never invent
 *     key material on a user's behalf. It would encrypt a vault under a key
 *     nobody chose and that no other client is configured with.
 *   - Refuse to run. Taken. The operator's fields are preserved exactly as
 *     written, so the UI still shows what they configured and one edit fixes it,
 *     and in the meantime not one byte of path, mtime, size or content leaves
 *     the machine under a false expectation of encryption. It fails closed and
 *     it fails visibly, which is the whole point: a sync daemon that quietly
 *     does the wrong thing is worse than one that stops.
 *
 * A transform rather than a throwing refinement, because loadSettingsImpl treats
 * ANY parse failure as "file unusable" and rewrites from defaults(), so throwing
 * here would answer a configuration mistake by destroying jwtSecret, every API
 * key and git.token.
 */
function enforceSyncSafety(s: SettingsBase): SettingsBase {
  if (s.sync.backend === 'livesync' && isUnsafeE2eePairing(s.livesync)) {
    console.warn(
      '[settings] refusing to run the LiveSync backend: livesync.obfuscatePassphrase is set ' +
        'while livesync.passphrase is empty, which produces opaque document ids over plaintext ' +
        'bodies (path, mtime, size and content readable in CouchDB). Set livesync.passphrase, ' +
        'or clear livesync.obfuscatePassphrase, then re-select the backend.',
    );
    s.sync.backend = 'none';
  }
  return s;
}

/**
 * Refuse to load a settings file that has locked every door.
 *
 * `allowPasswordLogin: false` is only meaningful next to a working OIDC
 * configuration. With OIDC disabled (or configured with no issuer or no client
 * id) the same flag means there is no way into this instance at all: the password
 * form is refused, the SSO button either is not rendered or leads to an
 * authorization request that cannot be built, and the Electron shell's automatic
 * WEBOBSIDIAN_PASSWORD login stops working too. Nobody chooses that state on
 * purpose; it is what a half-finished hand edit or a restored backup looks like.
 *
 * Healing OPEN rather than closed, which is the unusual direction for this file
 * and so needs its reason stated:
 *
 *   - "Open" here is not open. It restores the password door, which is itself
 *     credential-gated, rate-limited (middleware/ratelimit.ts) and exactly the
 *     door this install had before OIDC was configured. No one gets in who could
 *     not already get in.
 *   - The alternative is an instance the operator cannot reach through any
 *     interface, whose only remedy is hand-editing the very file that put it in
 *     that state. A recovery path that requires filesystem access to fix a
 *     settings typo is not a recovery path for the people most likely to hit it.
 *   - The API refuses to CREATE this state at all (assertUsableOidc in
 *     routes/settings.ts answers 400), so this heal only ever meets a file that
 *     did not come through the API.
 *
 * A transform rather than a throwing refinement, for the reason repeated all over
 * this file: loadSettingsImpl treats ANY parse failure as "file unusable" and
 * rewrites from defaults(), so throwing here would answer a login-configuration
 * mistake by destroying jwtSecret, every API key and git.token.
 */
function enforceLoginReachable(s: SettingsBase): SettingsBase {
  if (!s.oidc.allowPasswordLogin && !isOidcUsable(s.oidc)) {
    console.warn(
      '[settings] re-enabling password login: oidc.allowPasswordLogin is false while OIDC is not ' +
        'usable (oidc.enabled, oidc.issuer and oidc.clientId must all be set), which would leave ' +
        'no way to sign in at all. Finish configuring OIDC, then turn password login off again.',
    );
    s.oidc.allowPasswordLogin = true;
  }
  return s;
}

const SettingsSchema = SettingsBaseSchema.transform(enforceSyncSafety).transform(
  enforceLoginReachable,
);

export type Settings = z.infer<typeof SettingsSchema>;
export type ApiKeyRecord = z.infer<typeof ApiKeySchema>;

/** ---- Store --------------------------------------------------------------- */

let cache: Settings | null = null;

function defaults(): Settings {
  const base = SettingsSchema.parse({});
  // Stamp the current version so a brand-new file never looks like a legacy one
  // and never runs the one-shot auth migration below.
  base.version = CURRENT_SETTINGS_VERSION;
  base.auth.jwtSecret = randomBytes(48).toString('hex');
  base.vault.path = config.defaultVaultPath;
  base.vault.allowedRoots = config.allowedRoots.length
    ? config.allowedRoots
    : [path.dirname(config.defaultVaultPath), config.defaultVaultPath];
  return base;
}

/**
 * True when the absolute path `child` is `root` itself or lives underneath it.
 *
 * One containment rule, exported, because two copies of this test drifted apart
 * once already and because the naive form is wrong at a drive root. `root +
 * path.sep` produces "C:\\\\" for a root of "C:\\", and "C:\\Users" does not start
 * with that, so a perfectly valid path under an allowed root was refused (and,
 * read the other way, a caller could conclude the root was unreachable and widen
 * the list). Appending the separator only when it is missing is the fix, and it
 * matches how services/vault.ts does the same test.
 *
 * Both arguments must already be absolute and normalised (path.resolve'd). This
 * is a lexical test: callers that care about symlinks re-check the realpath
 * afterwards, exactly as assertRealpathInVault does in services/vault.ts.
 */
export function isWithinRoot(child: string, root: string): boolean {
  if (child === root) return true;
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  return child.startsWith(withSep);
}

/**
 * Guarantee the folder browser can reach the configured vault. The default
 * allowedRoots are derived from the sample vault, so pointing the vault at a
 * path outside them (e.g. ~/ObsidianVault) made Browse… return 403 with
 * "Path outside allowed roots". Add the vault's parent directory as a root
 * whenever it isn't already covered. Returns true if it mutated the draft.
 *
 * This is the ONLY writer of allowedRoots on the request path, and it is safe to
 * be one because it is not reachable with an unvetted vault path: a vault path
 * arriving over HTTP has already had to pass assertVaultPathAllowed against the
 * operator's roots, so the parent this appends is a path the operator's own
 * boundary already contained. Widening therefore stays inside that boundary
 * rather than escaping it, and when ALLOWED_ROOTS is set the persisted list is
 * not consulted for gating at all (see effectiveRoots in routes/settings.ts).
 */
export function ensureVaultBrowsable(d: Settings): boolean {
  const vaultPath = path.resolve(d.vault.path);
  const roots = d.vault.allowedRoots ?? [];
  const covered = roots.some((r) => isWithinRoot(vaultPath, path.resolve(r)));
  if (covered) return false;
  d.vault.allowedRoots = [...roots, path.dirname(vaultPath)];
  return true;
}

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
}

/** Atomic write: write to tmp then rename; keep a .bak of the previous file. */
async function persist(s: Settings): Promise<void> {
  await ensureDataDir();
  const json = JSON.stringify(s, null, 2);
  const tmp = `${SETTINGS_FILE}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, json, { mode: 0o600 });
  try {
    await fs.copyFile(SETTINGS_FILE, `${SETTINGS_FILE}.bak`);
  } catch {
    /* no previous file */
  }
  await fs.rename(tmp, SETTINGS_FILE);
}

// Collapses concurrent first-time loads. Without this, two requests arriving
// before the cache is warm both run the whole read-migrate-persist sequence, and
// on a missing file both call defaults(): the second one then generates a SECOND
// jwtSecret and persists it, silently invalidating the session cookie the first
// request just issued. One in-flight promise, shared by every caller.
let loading: Promise<Settings> | null = null;

export function loadSettings(): Promise<Settings> {
  if (cache) return Promise.resolve(cache);
  if (!loading) {
    loading = loadSettingsImpl().finally(() => {
      loading = null;
    });
  }
  return loading;
}

/**
 * True when `raw` (the JSON as it sits on disk, BEFORE the schema fills in
 * defaults) was written by a build that predates `auth.userPasswordHash`.
 *
 * This is the signal that makes the v1 -> v2 migration below safe on the one boot
 * where it actually runs, and it has to be taken from the raw object because the
 * parsed one cannot carry it: zod's `.default('')` makes an absent key and an
 * explicitly-empty key indistinguishable, and those are exactly the two cases
 * that need opposite treatment.
 *
 *   - Key ABSENT: written before the field existed, so `auth.passwordHash` was
 *     the login password. It must be moved.
 *   - Key PRESENT and empty: written by a build that knows about the field (every
 *     write goes through persist(), which serialises the whole parsed object, so
 *     the key is always emitted). The instance is on the default password and any
 *     `passwordHash` in the file is a recovery override the operator hand-added
 *     by following the UI's own forgot-password instructions. It must be left
 *     alone.
 *
 * The `version` gate alone cannot separate them, because every pre-versioning file
 * reads as version 1 whether or not it knows about userPasswordHash. Requiring
 * BOTH signals also survives a downgrade/upgrade cycle: an older build strips the
 * unknown `version` key on its next write, but it still writes userPasswordHash,
 * so the migration stays closed.
 */
function isPreUserPasswordFile(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const auth = (raw as { auth?: unknown }).auth;
  if (!auth || typeof auth !== 'object') return false;
  return !Object.prototype.hasOwnProperty.call(auth, 'userPasswordHash');
}

/** The three path fields as the file literally spells them, for the heal check. */
const HEALABLE_VAULT_FIELDS = ['path', 'trash', 'attachmentDir'] as const;

/**
 * True when the schema had to coerce one of the vault path fields on the way in.
 *
 * Without this the heal is per-parse rather than per-file: vaultRootPath and
 * vaultRelativePath coerce a bad value back to a safe one and warn as they do it,
 * but the file keeps the bad value, so every later parse repeats the work and the
 * warning. updateSettings runs a parse per mutation, so an operator with one
 * mistyped path would see the same line on every save forever. Persisting the
 * coercion once turns it into a repair. Rewriting the operator's file is
 * acceptable here for the same reason the jwtSecret backfill and the version stamp
 * do it, and persist() keeps a .bak of what was there before.
 */
function vaultPathsWereHealed(raw: unknown, parsed: Settings): boolean {
  const vault = raw && typeof raw === 'object' ? (raw as { vault?: unknown }).vault : undefined;
  if (!vault || typeof vault !== 'object') return false;
  const fields = vault as Record<string, unknown>;
  // Only fields the file actually carries: an absent one took a default, which is
  // not a coercion and must not trigger a rewrite.
  return HEALABLE_VAULT_FIELDS.some(
    (f) => fields[f] !== undefined && fields[f] !== parsed.vault[f],
  );
}

async function loadSettingsImpl(): Promise<Settings> {
  if (cache) return cache;
  await ensureDataDir();
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    // Keep the raw object: the migration below needs to know which keys the file
    // actually contained, which the parsed value can no longer tell it.
    const rawJson: unknown = JSON.parse(raw);
    const parsed = SettingsSchema.parse(rawJson);
    // Backfill secrets that may be empty in older files.
    let dirty = false;
    if (!parsed.auth.jwtSecret) {
      parsed.auth.jwtSecret = randomBytes(48).toString('hex');
      dirty = true;
    }
    // Migration (v1 -> v2): `passwordHash` used to BE the login password. The new
    // model treats `passwordHash` as the override password and `userPasswordHash`
    // as the login password (empty = the default 123456). So that an old file
    // can't be backdoored with 123456, move the old password over to
    // `userPasswordHash` and then clear the override field.
    //
    // Gated on TWO signals, and it needs both.
    //
    // `version` alone bounds the migration to files older than v2, which stops it
    // re-running on every boot. But every pre-existing file is v1 by definition
    // (no `version` key -> `.default(1)`), so on the single upgrade boot the gate
    // is wide open, and "userPasswordHash is empty" cannot finish the job: it
    // cannot distinguish a legacy login hash from a recovery override that the
    // operator just hand-edited in by following the UI's own forgot-password
    // instructions. On an instance still using the default password
    // (userPasswordHash === ''), that test matched the override, moved it into
    // userPasswordHash and cleared it. The credential still worked, but it had
    // silently become the permanent login password rather than the documented
    // one-shot recovery override, and re-editing the file appeared to do nothing.
    // That population is the one most likely to be in exactly this state, since
    // hand-editing passwordHash WAS the documented recovery path.
    //
    // isPreUserPasswordFile() supplies the missing bit: the key's presence in the
    // raw JSON, which separates "written before the field existed" from "written
    // by a build that knows the field and left it empty on purpose". Version
    // bounds the migration in time; key presence identifies the right file.
    if (parsed.version < CURRENT_SETTINGS_VERSION) {
      if (
        isPreUserPasswordFile(rawJson) &&
        parsed.auth.passwordHash &&
        !parsed.auth.userPasswordHash
      ) {
        parsed.auth.userPasswordHash = parsed.auth.passwordHash;
        parsed.auth.passwordHash = '';
      }
      // Stamp the version even when nothing moved. Otherwise the file stays at v1
      // forever and every later boot re-opens the window described above.
      parsed.version = CURRENT_SETTINGS_VERSION;
      dirty = true;
    }
    // Write back a coerced vault path once instead of re-coercing it forever.
    if (vaultPathsWereHealed(rawJson, parsed)) dirty = true;
    // Heal older files whose allowedRoots predate the current vault path.
    if (ensureVaultBrowsable(parsed)) dirty = true;
    cache = parsed;
    if (dirty) await persist(cache);
  } catch {
    cache = defaults();
    await persist(cache);
  }
  return cache;
}

export async function getSettings(): Promise<Settings> {
  return cache ?? (await loadSettings());
}

// ---------------------------------------------------------------------------
// Serialized settings mutation
//
// updateSettings() is a read-modify-write over BOTH a module-global cache and a
// shared file, with real async fs I/O (mkdir, tmp write, backup copy, rename) in
// between the read and the write. Every security-relevant mutation goes through
// it: password change, API key create/revoke, plugin enable/install, the general
// settings PUT. Unserialized, two overlapping calls each snapshot the cache, each
// apply their own mutation to their own copy, and the one that finishes last
// wins outright: the other mutation is silently erased from both cache and disk.
//
// The concrete exploit this closes is a resurrected API key. Revoking a key and
// any concurrent write raced, and the loser could be the revocation, restoring
// the key to disk so it survived a restart. The lastUsed bump made that trivially
// reachable because it fired unawaited on every authenticated request; that write
// has since moved out of this file entirely (services/apikey-usage.ts), but the
// same race exists between any two mutations, so the queue is the real fix.
//
// This mirrors withGitLock in services/git.ts: one chained promise, ops never
// overlap, and a rejecting op does not poison the queue for the next caller.
// ---------------------------------------------------------------------------
let settingsQueue: Promise<unknown> = Promise.resolve();

function withSettingsLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = settingsQueue.then(fn);
  settingsQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Mutate settings via an updater fn, validate, persist, and refresh cache.
 *  Serialized: the read, the mutation and the write are one atomic step. */
export function updateSettings(
  mutator: (draft: Settings) => void | Promise<void>,
): Promise<Settings> {
  return withSettingsLock(async () => {
    // Inside the lock, so the snapshot cannot be stale by the time it is written.
    // getSettings/loadSettings deliberately do NOT take this lock, so calling it
    // here cannot deadlock.
    const current = await getSettings();
    const draft: Settings = JSON.parse(JSON.stringify(current));
    await mutator(draft);
    const validated = SettingsSchema.parse(draft);
    cache = validated;
    await persist(validated);
    return validated;
  });
}

/** Redact secrets for sending to the client. */
export function redactSettings(s: Settings) {
  return {
    ...s,
    auth: {
      // hasCustomPassword=false means the default password (123456) is still in use.
      // Shares one condition with checkPassword: once an override is configured
      // (auth.passwordHash / WEBOBSIDIAN_PASSWORD) the default no longer works, so
      // the UI must stop warning that the instance is on the default password.
      hasCustomPassword: !isDefaultPasswordActive(s.auth),
      hasOverridePassword: Boolean(s.auth.passwordHash),
    },
    git: { ...s.git, token: s.git.token ? REDACTED_SECRET : '' },
    livesync: {
      ...s.livesync,
      /**
       * The URI is not a secret field, but it is a URL, and a hand-edited
       * settings.json can perfectly well contain `https://user:pass@host` in it.
       * The API refuses that form outright (requireCouchUri in
       * routes/settings.ts), so masking here is the belt to that braces: a
       * credential this process did not write still cannot leave it through a
       * settings response. redactUrlCreds is a no-op on a URL without userinfo,
       * which is every URL this build stores.
       *
       * routes/settings.ts knows this mask exists and treats an incoming URI
       * that is exactly the masked form of the stored one as "unchanged" rather
       * than storing `https://***@host`, which would replace a working URL with
       * a broken one on the next save from a UI that round-trips what it read.
       */
      uri: redactUrlCreds(s.livesync.uri),
      // All three are write-only over the API. Empty stays empty rather than
      // becoming the mask, so the client can still tell "not configured" from
      // "configured, value withheld" and render the two states differently.
      password: s.livesync.password ? REDACTED_SECRET : '',
      passphrase: s.livesync.passphrase ? REDACTED_SECRET : '',
      obfuscatePassphrase: s.livesync.obfuscatePassphrase ? REDACTED_SECRET : '',
    },
    oidc: {
      ...s.oidc,
      /**
       * Same treatment, and the same reasoning, as livesync.uri above. Neither
       * of these is a secret field, but both are URLs, and a hand-edited
       * settings.json can perfectly well carry `https://user:pass@host` in one.
       * The API refuses that form outright (requireOidcUrl in
       * routes/settings.ts), so this is the belt to that braces: a credential
       * this process did not write still cannot leave it through a settings
       * response, which is the response most likely to be pasted into a support
       * thread. redactUrlCreds is the identity on a URL without userinfo, which
       * is every URL this build is willing to store.
       *
       * routes/settings.ts knows these masks exist and treats an incoming value
       * that is exactly the masked form of the stored one as "unchanged", rather
       * than persisting `https://***@host` and replacing a working issuer with a
       * broken one on the next save from a UI that round-trips what it read.
       */
      issuer: redactUrlCreds(s.oidc.issuer),
      redirectUri: redactUrlCreds(s.oidc.redirectUri),
      /**
       * Write-only over the API, exactly like the LiveSync secrets. Empty stays
       * empty rather than becoming the mask, so the client can still tell "this
       * is a public client with no secret" from "configured, value withheld" and
       * render the two differently. Conflating them would be a real loss here,
       * because "no secret" is a legitimate configuration for a PKCE public
       * client rather than an unfinished one.
       */
      clientSecret: s.oidc.clientSecret ? REDACTED_SECRET : '',
    },
    api: {
      ...s.api,
      keys: s.api.keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        scopes: k.scopes,
        createdAt: k.createdAt,
        // Same shape as before, different source: live usage comes from the
        // separate telemetry store, and the value frozen in settings.json is only
        // the pre-split seed. Falls back to it so keys last used by an older
        // build still show their timestamp.
        lastUsed: getApiKeyLastUsed(k.id) ?? k.lastUsed,
      })),
    },
  };
}
