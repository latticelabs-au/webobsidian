/**
 * Regression tests for the settings layer.
 *
 * These lock down six properties that are load-bearing and, in five of the six
 * cases, silent when they break. That is the whole reason this file exists:
 * every failure mode below reports success to the operator while doing the wrong
 * thing, so nothing downstream would have caught a regression.
 *
 *   1. The secret round-trip rule. redactSettings() serves REDACTED_SECRET in
 *      place of a stored credential, so any UI that saves what it loaded sends
 *      the mask back. Storing it replaces the credential with eight bullet
 *      characters and the operator meets it later as an authentication failure
 *      with nothing to connect it to.
 *   2. The sentinel is defined once. The mask is compared byte-for-byte on the
 *      way in, so two copies that drift turn every settings save into a
 *      credential wipe.
 *   3. The PUT allowlist. A settings block that is missing from the if-chain in
 *      routes/settings.ts is unwritable AND answers 200 with the unchanged
 *      settings, which is the worst failure mode that endpoint has.
 *   4. isUnsafeE2eePairing. obfuscatePassphrase without passphrase yields opaque
 *      document ids over plaintext bodies, so the check an operator would run to
 *      prove E2EE is on passes while path, mtime, size and content sit readable
 *      in CouchDB.
 *   5. vault.trash / vault.attachmentDir containment. The trash directory is
 *      joined onto the vault root and then listed and fs.rm(recursive, force)'d,
 *      so an escaping value was arbitrary directory disclosure plus recursive
 *      deletion.
 *   6. vault.path. path.resolve('') is the process working directory, so an
 *      empty value relocated the files API onto the install tree (settings.json
 *      readable in cleartext, server/dist writable). And allowedRoots is the
 *      gate a vault path is measured against, so a request must never be able to
 *      supply it.
 *
 * Structure notes for anyone extending this file:
 *
 * - Every test boots its own module graph via boot(). helpers.ts's
 *   resetSettingsCache() evicts ALL modules, which is the only way to clear
 *   services/settings.ts's module-global cache/loading/queue triple, so the
 *   subjects have to be pulled in with dynamic import AFTER the reset and after
 *   DATA_DIR points at the throwaway directory. A static import of anything with
 *   runtime state would defeat that and the tests would pass against whichever
 *   settings object happened to be cached first.
 * - Assertions read the settings.json on disk rather than only the response
 *   body. A credential that survives in the cache but not in the file is still
 *   destroyed on the next restart, and the file is what the operator keeps.
 * - requireAuth is NOT stubbed. The router mounts it itself, and minting a real
 *   owner token from the same module instance keeps these tests honest about the
 *   middleware actually running rather than about a mock.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  makeTestApp,
  makeTmpDataDir,
  resetSettingsCache,
  writeSettings,
  type TmpDir,
} from './helpers.js';
import type { Settings } from '../services/settings.js';

/** The settings service, as pulled in fresh by boot(). */
type SettingsModule = typeof import('../services/settings.js');

/**
 * The eight U+2022 BULLET characters that stand in for a stored secret.
 *
 * Written as escapes rather than as literal bullets so that the source scan in
 * "the redaction sentinel" below cannot match this file, and so that a reviewer
 * can count the characters. The tests still compare against the module's own
 * exported constant wherever the round-trip rule is what is under test; this
 * copy exists only to assert the constant's VALUE.
 */
const SENTINEL = '\u2022'.repeat(8);

/** The subset of a redacted settings response these tests read. */
interface RedactedBody {
  git: { token: string; branch: string; remote: string };
  livesync: {
    uri: string;
    database: string;
    username: string;
    password: string;
    passphrase: string;
    obfuscatePassphrase: string;
    liveMode: boolean;
    intervalSec: number;
  };
  vault: { path: string; trash: string; attachmentDir: string; allowedRoots: string[] };
  sync: { backend: string };
  ui: { theme: string };
}

/** The error middleware's response shape. */
interface ErrorBody {
  error: string;
}

let tmp: TmpDir | null = null;
/** Directories created outside the tmp data dir, removed in afterEach. */
let extraDirs: string[] = [];
let warnSpy: MockInstance<typeof console.warn>;
let errorSpy: MockInstance<typeof console.error>;
let prevAllowedRoots: string | undefined;

beforeEach(() => {
  // effectiveRoots() in routes/settings.ts prefers ALLOWED_ROOTS over the
  // persisted list, so a value leaking in from the developer's own environment
  // would change which vault paths the 403 gate accepts and make the allowedRoots
  // tests pass or fail for reasons that have nothing to do with the code.
  prevAllowedRoots = process.env.ALLOWED_ROOTS;
  delete process.env.ALLOWED_ROOTS;
  // The self-healing settings fields warn loudly on purpose, and several tests
  // below assert that they do. Capturing rather than silencing keeps the test
  // output readable AND makes the loudness itself testable.
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  // Same for the error middleware's 5xx log, which one test below deliberately
  // provokes. Captured rather than silenced so that "the failure was logged" is
  // itself assertable: an unlogged 5xx is a failure nobody can diagnose.
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  if (prevAllowedRoots === undefined) delete process.env.ALLOWED_ROOTS;
  else process.env.ALLOWED_ROOTS = prevAllowedRoots;
  for (const dir of extraDirs) await fs.rm(dir, { recursive: true, force: true });
  extraDirs = [];
  await tmp?.cleanup();
  tmp = null;
});

interface Booted {
  app: Express;
  token: string;
  settings: SettingsModule;
}

/**
 * Build an isolated settings world: a throwaway DATA_DIR, an optional seeded
 * settings.json, a fresh module graph, an Express app with the real settings
 * router and error middleware mounted, and a real owner session token.
 *
 * Call order matters and is the sequence documented in helpers.ts. The reset has
 * to precede makeTmpDataDir() so config.ts is evicted before DATA_DIR changes,
 * the seed has to be written before the first import so loadSettings() sees it
 * rather than creating a defaults file, and every import has to be dynamic so it
 * evaluates against the new environment.
 *
 * `seed` is a partial settings.json. Anything absent is filled in by the schema,
 * including vault.path, which defaults to config.defaultVaultPath and therefore
 * to the VAULT_PATH that makeTmpDataDir() just set.
 */
async function boot(seed?: Record<string, unknown>): Promise<Booted> {
  resetSettingsCache();
  tmp = await makeTmpDataDir();
  if (seed) await writeSettings(tmp.dataDir, seed);

  const settings = await import('../services/settings.js');
  const { settingsRouter } = await import('../routes/settings.js');
  const { errorHandler } = await import('../middleware/error.js');
  const { issueToken } = await import('../services/auth.js');

  const app = makeTestApp();
  app.use('/api/settings', settingsRouter);
  app.use(errorHandler);

  // Triggers the first load (and therefore any heal or migration a seed is
  // testing) as a side effect, which is why the warn spy is installed in
  // beforeEach rather than inside individual tests.
  const token = await issueToken();
  return { app, token, settings };
}

function get(b: Booted) {
  return request(b.app).get('/api/settings').set('Authorization', `Bearer ${b.token}`);
}

function put(b: Booted, body: Record<string, unknown>) {
  return request(b.app)
    .put('/api/settings')
    .set('Authorization', `Bearer ${b.token}`)
    .send(body);
}

/** The settings.json as it actually sits on disk. The cache is not the point. */
async function readStoredFile(): Promise<Settings> {
  if (!tmp) throw new Error('boot() was not called');
  const raw = await fs.readFile(path.join(tmp.dataDir, 'settings.json'), 'utf8');
  return JSON.parse(raw) as Settings;
}

/** A real directory outside the tmp data dir, for the allowed-roots tests. */
async function makeOutsideDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-outside-'));
  extraDirs.push(dir);
  return dir;
}

/**
 * A settings.json with every credential populated, so that "the stored value
 * survived" is a meaningful assertion rather than a comparison of two empties.
 * vault.path is deliberately absent: the schema defaults it to the tmp vault.
 */
const CONFIGURED: Record<string, unknown> = {
  git: {
    enabled: true,
    remote: 'https://example.invalid/notes.git',
    branch: 'main',
    token: 'ghp_this_is_the_real_token',
  },
  sync: { backend: 'livesync' },
  livesync: {
    uri: 'https://couch.example.invalid:6984',
    database: 'vaultdb',
    username: 'syncuser',
    password: 'couch-password',
    passphrase: 'encryption-passphrase',
    obfuscatePassphrase: 'obfuscation-passphrase',
  },
};

// ---------------------------------------------------------------------------
// 1. The secret round-trip rule
// ---------------------------------------------------------------------------

describe('the secret round-trip rule', () => {
  it('masks every stored secret on the way out and leaves unset ones empty', async () => {
    const b = await boot(CONFIGURED);
    const res = await get(b).expect(200);
    const body = res.body as RedactedBody;

    expect(body.git.token).toBe(b.settings.REDACTED_SECRET);
    expect(body.livesync.password).toBe(b.settings.REDACTED_SECRET);
    expect(body.livesync.passphrase).toBe(b.settings.REDACTED_SECRET);
    expect(body.livesync.obfuscatePassphrase).toBe(b.settings.REDACTED_SECRET);
    // The plaintext must not ride along in some other field of the same response.
    expect(JSON.stringify(body)).not.toContain('ghp_this_is_the_real_token');
    expect(JSON.stringify(body)).not.toContain('couch-password');
    expect(JSON.stringify(body)).not.toContain('encryption-passphrase');
  });

  it('reports an unset secret as empty rather than as the mask', async () => {
    // "Not configured" and "configured, value withheld" have to stay
    // distinguishable, otherwise the UI cannot render the two states differently
    // and an operator cannot tell whether a credential exists at all.
    const b = await boot();
    const body = (await get(b).expect(200)).body as RedactedBody;
    expect(body.git.token).toBe('');
    expect(body.livesync.password).toBe('');
    expect(body.livesync.passphrase).toBe('');
    expect(body.livesync.obfuscatePassphrase).toBe('');
  });

  it('does not overwrite git.token when the client echoes the mask back', async () => {
    const b = await boot(CONFIGURED);
    // Exactly what a UI that loaded redacted values and pressed Save sends.
    const res = await put(b, {
      git: { token: b.settings.REDACTED_SECRET, branch: 'release' },
    }).expect(200);

    const stored = await readStoredFile();
    expect(stored.git.token).toBe('ghp_this_is_the_real_token');
    // The rest of the same block still applied, so the token survived because the
    // sentinel was recognised and not because the whole request was dropped.
    expect(stored.git.branch).toBe('release');
    expect((res.body as RedactedBody).git.token).toBe(b.settings.REDACTED_SECRET);
  });

  it('does not overwrite the three LiveSync secrets when the client echoes the mask back', async () => {
    const b = await boot(CONFIGURED);
    await put(b, {
      livesync: {
        password: b.settings.REDACTED_SECRET,
        passphrase: b.settings.REDACTED_SECRET,
        obfuscatePassphrase: b.settings.REDACTED_SECRET,
        database: 'renameddb',
      },
    }).expect(200);

    const stored = await readStoredFile();
    expect(stored.livesync.password).toBe('couch-password');
    expect(stored.livesync.passphrase).toBe('encryption-passphrase');
    expect(stored.livesync.obfuscatePassphrase).toBe('obfuscation-passphrase');
    expect(stored.livesync.database).toBe('renameddb');
  });

  it('does not overwrite a stored secret when the field is sent empty', async () => {
    // A password input renders empty even when a value is stored, so a blank
    // field is the normal state of a save that was not about the password.
    const b = await boot(CONFIGURED);
    await put(b, { git: { token: '' }, livesync: { password: '', passphrase: '' } }).expect(200);

    const stored = await readStoredFile();
    expect(stored.git.token).toBe('ghp_this_is_the_real_token');
    expect(stored.livesync.password).toBe('couch-password');
    expect(stored.livesync.passphrase).toBe('encryption-passphrase');
  });

  it('does not overwrite the stored URI when the client echoes the redacted URI back', async () => {
    // Same idea one field over: redactSettings() masks credentials embedded in
    // the URI, so a client round-tripping what it read would otherwise persist
    // https://***@host and break a working URL.
    const b = await boot({
      livesync: { uri: 'https://couchuser:couchpass@couch.example.invalid:6984', database: 'vaultdb' },
    });
    const shown = (await get(b).expect(200)).body as RedactedBody;
    expect(shown.livesync.uri).not.toContain('couchpass');

    await put(b, { livesync: { uri: shown.livesync.uri } }).expect(200);
    const stored = await readStoredFile();
    expect(stored.livesync.uri).toBe('https://couchuser:couchpass@couch.example.invalid:6984');
  });

  it('writes a genuinely new secret', async () => {
    // The guard against over-correcting: a rule that never writes a secret would
    // pass every test above and make the feature useless.
    const b = await boot(CONFIGURED);
    await put(b, {
      git: { token: 'ghp_a_brand_new_token' },
      livesync: { password: 'new-couch-password' },
    }).expect(200);

    const stored = await readStoredFile();
    expect(stored.git.token).toBe('ghp_a_brand_new_token');
    expect(stored.livesync.password).toBe('new-couch-password');
  });

  it('clears a secret only on an explicit null', async () => {
    // The documented escape hatch. Without it an instance holding
    // obfuscatePassphrase with no passphrase is wedged: every livesync save is
    // refused by the pairing check and the one field that has to change cannot
    // be changed through this API. null is chosen because no text input produces
    // it by accident.
    const b = await boot(CONFIGURED);
    await put(b, { livesync: { obfuscatePassphrase: null } }).expect(200);
    const stored = await readStoredFile();
    expect(stored.livesync.obfuscatePassphrase).toBe('');
    // Only the field that was nulled.
    expect(stored.livesync.passphrase).toBe('encryption-passphrase');
    expect(stored.livesync.password).toBe('couch-password');
  });

  it('rejects a non-string, non-null secret instead of coercing it', async () => {
    const b = await boot(CONFIGURED);
    const res = await put(b, { livesync: { password: 12345 } }).expect(400);
    expect((res.body as ErrorBody).error).toContain('livesync.password');
    expect((await readStoredFile()).livesync.password).toBe('couch-password');
  });
});

// ---------------------------------------------------------------------------
// 2. One sentinel, both doors
// ---------------------------------------------------------------------------

describe('the redaction sentinel', () => {
  it('is eight U+2022 BULLET characters', async () => {
    const b = await boot();
    expect(b.settings.REDACTED_SECRET).toBe(SENTINEL);
    expect(b.settings.REDACTED_SECRET).toHaveLength(8);
  });

  it('is written once in server/src, in the module that also exports it', async () => {
    // The producer (redactSettings) and the comparison (routes/settings.ts and
    // readSecret) have to be provably the same bytes. A second literal anywhere
    // in the server tree is the drift this asserts against, and the failure of
    // that drift is silent and maximally destructive: the comparison stops
    // matching, so the mask the UI echoed back is stored AS the credential.
    //
    // Scoped to server/src on purpose. web/src/lib/api.ts carries its own copy
    // because a browser bundle cannot import from the server workspace, so that
    // one is a known, unavoidable duplicate rather than accidental drift. It is
    // still a real risk and is called out in the review notes; it cannot be
    // closed from this file.
    const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const files = await collectSourceFiles(srcDir);
    const hits: string[] = [];
    let occurrencesInSettings = 0;
    for (const file of files) {
      const text = await fs.readFile(file, 'utf8');
      const count = text.split(SENTINEL).length - 1;
      if (count === 0) continue;
      const rel = path.relative(srcDir, file).split(path.sep).join('/');
      hits.push(rel);
      if (rel === 'services/settings.ts') occurrencesInSettings = count;
    }

    expect(hits).toEqual(['services/settings.ts']);
    expect(occurrencesInSettings).toBe(1);
  });

  it('is imported by the route that performs the comparison', async () => {
    const routes = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../routes/settings.ts',
    );
    const text = await fs.readFile(routes, 'utf8');
    // The named import, from the module that owns the constant. Written as one
    // regex over the whole file because the import list spans several lines.
    expect(text).toMatch(/import\s*\{[^}]*\bREDACTED_SECRET\b[^}]*\}\s*from\s*'\.\.\/services\/settings\.js'/);
    expect(text).toContain('REDACTED_SECRET');
  });

  it('stores a near-miss of the mask verbatim, which is what drift would cost', async () => {
    // Seven bullets is not the sentinel, so it is treated as a new secret and
    // written. This is not a wish, it is the demonstration of the failure mode:
    // if the two copies of the constant ever differ by one byte, this is exactly
    // what happens to a real credential on the next save from the UI.
    const b = await boot(CONFIGURED);
    const nearMiss = '\u2022'.repeat(7);
    await put(b, { git: { token: nearMiss } }).expect(200);
    expect((await readStoredFile()).git.token).toBe(nearMiss);
  });
});

// ---------------------------------------------------------------------------
// 3. The PUT allowlist
// ---------------------------------------------------------------------------

describe('the PUT allowlist', () => {
  it('writes sync.backend', async () => {
    const b = await boot();
    await put(b, { sync: { backend: 'git' } }).expect(200);
    expect((await readStoredFile()).sync.backend).toBe('git');
  });

  it('rejects an unknown sync.backend rather than coercing it to none', async () => {
    // The schema heals an unknown literal to 'none' so a hand-edited file still
    // loads. Over HTTP that would read as "saved, and quietly stopped syncing".
    const b = await boot({ sync: { backend: 'git' } });
    const res = await put(b, { sync: { backend: 'both' } }).expect(400);
    expect((res.body as ErrorBody).error).toContain('sync.backend');
    expect((await readStoredFile()).sync.backend).toBe('git');
  });

  it('writes the livesync block, normalised', async () => {
    const b = await boot();
    await put(b, {
      livesync: {
        // Trailing slash: the engine concatenates url + "/" + database, so a
        // stored slash yields http://host//db, which CouchDB reads as a database
        // whose name starts with an empty segment.
        uri: 'https://couch.example.invalid:6984/',
        database: 'vaultdb',
        username: '  syncuser  ',
        liveMode: true,
        intervalSec: 15,
        includeInternal: ['.obsidian/snippets'],
      },
    }).expect(200);

    const stored = await readStoredFile();
    expect(stored.livesync.uri).toBe('https://couch.example.invalid:6984');
    expect(stored.livesync.database).toBe('vaultdb');
    expect(stored.livesync.username).toBe('syncuser');
    expect(stored.livesync.liveMode).toBe(true);
    expect(stored.livesync.intervalSec).toBe(15);
    expect(stored.livesync.includeInternal).toEqual(['.obsidian/snippets']);
  });

  it('ignores an unknown top-level block, and still answers 200', async () => {
    // This is the documented failure mode of the four-file settings contract:
    // a block missing from the if-chain is unwritable AND indistinguishable from
    // a successful save. The test pins the CURRENT behaviour so that adding a
    // block without wiring it up shows up here, and it doubles as the security
    // assertion that auth and plugins are not writable through this endpoint.
    const b = await boot();
    const before = await readStoredFile();

    const res = await put(b, {
      auth: { jwtSecret: 'attacker-chosen-secret', userPasswordHash: '' },
      plugins: { enabled: ['evil-plugin'], installed: ['evil-plugin'] },
      notASettingsBlock: { anything: true },
    }).expect(200);

    const stored = await readStoredFile();
    expect(stored.auth.jwtSecret).toBe(before.auth.jwtSecret);
    expect(stored.plugins.enabled).toEqual([]);
    expect(stored.plugins.installed).toEqual([]);
    expect(stored).not.toHaveProperty('notASettingsBlock');
    expect(res.body).not.toHaveProperty('notASettingsBlock');
  });

  it('ignores api.keys while accepting api.rateLimitPerMin', async () => {
    // Only rateLimitPerMin is in the if-chain. Key creation and revocation live
    // on their own routes for a reason: an injected key here would be a
    // credential grant through a general settings save.
    const b = await boot();
    await put(b, {
      api: {
        rateLimitPerMin: 42,
        keys: [
          {
            id: 'injected',
            name: 'injected',
            hash: 'deadbeef',
            prefix: 'wok_inject',
            scopes: ['read', 'write', 'search'],
            createdAt: new Date().toISOString(),
            lastUsed: null,
          },
        ],
      },
    }).expect(200);

    const stored = await readStoredFile();
    expect(stored.api.rateLimitPerMin).toBe(42);
    expect(stored.api.keys).toEqual([]);
  });

  it('refuses an api.rateLimitPerMin that would 429 every key', async () => {
    // middleware/apikey.ts tests `arr.length >= perMin`, so 0 rejects the first
    // request of every valid key, and the value is persisted so the lockout
    // survives a restart.
    const b = await boot();
    for (const bad of [0, -1, 0.5]) {
      const res = await put(b, { api: { rateLimitPerMin: bad } }).expect(400);
      expect((res.body as ErrorBody).error).toContain('api.rateLimitPerMin');
    }
    expect((await readStoredFile()).api.rateLimitPerMin).toBe(120);
  });

  it('does not persist anything when a value fails schema validation', async () => {
    // body.ui is Object.assign'd straight onto the draft and only validated by
    // SettingsSchema.parse inside updateSettings. The invariant that matters is
    // that a failed parse leaves both the cache and the file untouched: the
    // draft is a deep clone and the parse runs before the assignment and the
    // write. (The status is 500 rather than 400 today, because the failure
    // surfaces from the mutator instead of from a pre-lock check. That is a
    // reporting wart, not a persistence bug, so this asserts the persistence
    // invariant and only that the request failed.)
    const b = await boot();
    const before = await readStoredFile();
    const res = await put(b, { ui: { theme: 'neon-hacker' } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await readStoredFile()).ui.theme).toBe(before.ui.theme);
    // Whatever status it carries, the rejection reaches the operator's log with
    // a correlation id rather than disappearing.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[error]'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('writes ui and search, which are in the chain', async () => {
    const b = await boot();
    await put(b, {
      ui: { theme: 'obsidian-dark' },
      search: { fuzzy: 0.4, prefix: false },
    }).expect(200);
    const stored = await readStoredFile();
    expect(stored.ui.theme).toBe('obsidian-dark');
    expect(stored.search.fuzzy).toBe(0.4);
    expect(stored.search.prefix).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. The E2EE pairing that looks configured and is not
// ---------------------------------------------------------------------------

describe('isUnsafeE2eePairing', () => {
  it('is true only for obfuscation without encryption', async () => {
    const { isUnsafeE2eePairing } = (await boot()).settings;
    // The hazard: ids are hashed from obfuscatePassphrase, but encryption is
    // derived from passphrase ALONE, so this combination writes opaque ids over
    // plaintext bodies.
    expect(isUnsafeE2eePairing({ passphrase: '', obfuscatePassphrase: 'obf' })).toBe(true);
    // Both set: ids hashed and bodies encrypted.
    expect(isUnsafeE2eePairing({ passphrase: 'enc', obfuscatePassphrase: 'obf' })).toBe(false);
    // Encryption without obfuscation: plaintext ids, encrypted bodies. Honest.
    expect(isUnsafeE2eePairing({ passphrase: 'enc', obfuscatePassphrase: '' })).toBe(false);
    // Neither: plainly unencrypted, which claims nothing.
    expect(isUnsafeE2eePairing({ passphrase: '', obfuscatePassphrase: '' })).toBe(false);
  });

  it('refuses a PUT that sets obfuscatePassphrase with no stored passphrase', async () => {
    const b = await boot({ livesync: { uri: 'https://couch.example.invalid:6984', database: 'vaultdb' } });
    const res = await put(b, { livesync: { obfuscatePassphrase: 'obf' } }).expect(400);
    expect((res.body as ErrorBody).error).toContain('livesync.obfuscatePassphrase requires livesync.passphrase');
    expect((await readStoredFile()).livesync.obfuscatePassphrase).toBe('');
  });

  it('refuses a PUT that sets obfuscatePassphrase while leaving passphrase blank', async () => {
    // An empty passphrase in the same body means "leave the stored one alone"
    // (readSecret), so this is the pairing check reading the MERGED result
    // rather than the patch.
    const b = await boot();
    await put(b, { livesync: { obfuscatePassphrase: 'obf', passphrase: '' } }).expect(400);
    expect((await readStoredFile()).livesync.obfuscatePassphrase).toBe('');
  });

  it('refuses a PUT that clears the passphrase while obfuscation is stored', async () => {
    const b = await boot(CONFIGURED);
    const res = await put(b, { livesync: { passphrase: null } }).expect(400);
    expect((res.body as ErrorBody).error).toContain('livesync.passphrase');
    const stored = await readStoredFile();
    expect(stored.livesync.passphrase).toBe('encryption-passphrase');
    expect(stored.livesync.obfuscatePassphrase).toBe('obfuscation-passphrase');
  });

  it('accepts both passphrases set in one request', async () => {
    const b = await boot();
    await put(b, { livesync: { passphrase: 'enc', obfuscatePassphrase: 'obf' } }).expect(200);
    const stored = await readStoredFile();
    expect(stored.livesync.passphrase).toBe('enc');
    expect(stored.livesync.obfuscatePassphrase).toBe('obf');
  });

  it('refuses to RUN the backend when a hand-edited file carries the bad pairing', async () => {
    // The non-destructive counterpart to the 400. Fail closed: the operator's
    // fields are preserved exactly as written (never invent key material, never
    // silently downgrade to plaintext ids), and not one byte leaves the machine
    // under a false expectation of encryption.
    const b = await boot({
      sync: { backend: 'livesync' },
      livesync: {
        uri: 'https://couch.example.invalid:6984',
        database: 'vaultdb',
        passphrase: '',
        obfuscatePassphrase: 'obf',
      },
    });

    const loaded = await b.settings.getSettings();
    expect(loaded.sync.backend).toBe('none');
    expect(loaded.livesync.obfuscatePassphrase).toBe('obf');
    expect(loaded.livesync.passphrase).toBe('');
    // The refusal is visible, not silent: a sync daemon that quietly does the
    // wrong thing is the whole hazard.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('refusing to run the LiveSync backend'),
    );

    const stored = await readStoredFile();
    expect(stored.sync.backend).toBe('none');
    expect(stored.livesync.obfuscatePassphrase).toBe('obf');
  });

  it('does not block an unrelated save on an instance that already holds the bad pairing', async () => {
    // The pairing check is gated on the request touching sync configuration.
    // Without that gate, an instance in this state would 400 on every unrelated
    // save with an error about a passphrase, which is baffling and unfixable
    // from the UI it breaks.
    const b = await boot({
      livesync: { passphrase: '', obfuscatePassphrase: 'obf' },
    });
    await put(b, { ui: { theme: 'obsidian-dark' } }).expect(200);
    const stored = await readStoredFile();
    expect(stored.ui.theme).toBe('obsidian-dark');
    expect(stored.livesync.obfuscatePassphrase).toBe('obf');
  });

  it('lets the wedged instance fix itself by nulling obfuscatePassphrase', async () => {
    const b = await boot({ livesync: { passphrase: '', obfuscatePassphrase: 'obf' } });
    await put(b, { livesync: { obfuscatePassphrase: null } }).expect(200);
    expect((await readStoredFile()).livesync.obfuscatePassphrase).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 5. vault.trash and vault.attachmentDir containment
// ---------------------------------------------------------------------------

/**
 * Values that must never survive as a vault-relative directory. Each one either
 * resolves outside the vault root or resolves to the vault root itself, and the
 * trash directory is enumerated and recursively deleted, so both outcomes are
 * destructive.
 */
const TRAVERSAL_CASES: Array<[string, string]> = [
  ['posix absolute', '/etc'],
  ['backslash rooted', String.raw`\Windows`],
  ['drive absolute', String.raw`C:\Windows\Temp`],
  ['drive relative', 'C:temp'],
  ['UNC share', String.raw`\\host\share`],
  ['parent hop', '../outside'],
  ['backslash parent hop', String.raw`..\outside`],
  ['nested escape', 'a/../../outside'],
  ['bare parent', '..'],
  // Win32 strips trailing dots and spaces from every path component before the
  // path reaches the filesystem, so each of these is a parent hop on Windows
  // while none of them is byte-equal to "..".
  ['dot space hop', 'a/.. /b'],
  ['triple dot', '...'],
  ['dot space dot', '. .'],
  // "." or "./" alone makes the trash root the vault root, so emptying the trash
  // would wipe the whole vault.
  ['self', '.'],
  ['self with separator', './'],
  ['empty', ''],
  ['whitespace only', '   '],
  // A NUL truncates inside libuv, so the string checked would not be the path
  // opened at syscall time.
  ['NUL byte', 'ok\0/../../etc'],
];

describe('vault-relative directory containment', () => {
  it.each(TRAVERSAL_CASES)('isVaultRelativeSubpath rejects %s', async (_label, value) => {
    const { isVaultRelativeSubpath } = (await boot()).settings;
    expect(isVaultRelativeSubpath(value)).toBe(false);
  });

  it('isVaultRelativeSubpath accepts real sub-paths and non-strings are refused', async () => {
    const { isVaultRelativeSubpath } = (await boot()).settings;
    expect(isVaultRelativeSubpath('.trash')).toBe(true);
    expect(isVaultRelativeSubpath('archive/trash')).toBe(true);
    expect(isVaultRelativeSubpath(String.raw`archive\trash`)).toBe(true);
    expect(isVaultRelativeSubpath('a/b/c')).toBe(true);
    // Trimmed before the test, so both entry points agree on one meaning.
    expect(isVaultRelativeSubpath('  .trash  ')).toBe(true);
    // A "..name" directory is not a parent hop.
    expect(isVaultRelativeSubpath('..hidden')).toBe(true);

    expect(isVaultRelativeSubpath(undefined)).toBe(false);
    expect(isVaultRelativeSubpath(null)).toBe(false);
    expect(isVaultRelativeSubpath(42)).toBe(false);
    expect(isVaultRelativeSubpath(['.trash'])).toBe(false);
  });

  it.each(TRAVERSAL_CASES)('PUT vault.trash refuses %s with a 400', async (_label, value) => {
    const b = await boot();
    const res = await put(b, { vault: { trash: value } }).expect(400);
    expect((res.body as ErrorBody).error).toContain('vault.trash');
    expect((await readStoredFile()).vault.trash).toBe('.trash');
  });

  it.each(TRAVERSAL_CASES)('PUT vault.attachmentDir refuses %s with a 400', async (_label, value) => {
    const b = await boot();
    const res = await put(b, { vault: { attachmentDir: value } }).expect(400);
    expect((res.body as ErrorBody).error).toContain('vault.attachmentDir');
    expect((await readStoredFile()).vault.attachmentDir).toBe('attachments');
  });

  it('accepts a real sub-directory and stores it trimmed', async () => {
    const b = await boot();
    await put(b, { vault: { trash: '  archive/trash  ', attachmentDir: 'files/att' } }).expect(200);
    const stored = await readStoredFile();
    expect(stored.vault.trash).toBe('archive/trash');
    expect(stored.vault.attachmentDir).toBe('files/att');
  });

  it('rejects the whole request rather than half-applying it', async () => {
    // sanitizeVault runs before the settings lock is taken, so a bad trash value
    // must not leave a good deleteMode behind.
    const b = await boot();
    await put(b, { vault: { deleteMode: 'permanent', trash: '../outside' } }).expect(400);
    const stored = await readStoredFile();
    expect(stored.vault.deleteMode).toBe('trash');
    expect(stored.vault.trash).toBe('.trash');
  });

  it('heals a hand-edited file instead of rewriting it from defaults', async () => {
    // The schema coerces rather than throws, because loadSettings treats ANY
    // parse failure as "file unusable" and rewrites from defaults, which would
    // answer a path typo by destroying jwtSecret, git.token and every API key.
    const b = await boot({
      auth: { jwtSecret: 'a-secret-that-must-survive', userPasswordHash: '', passwordHash: '' },
      git: { token: 'ghp_must_survive' },
      vault: { trash: '../../etc', attachmentDir: String.raw`C:\Windows` },
    });

    const loaded = await b.settings.getSettings();
    expect(loaded.vault.trash).toBe('.trash');
    expect(loaded.vault.attachmentDir).toBe('attachments');
    expect(loaded.auth.jwtSecret).toBe('a-secret-that-must-survive');
    expect(loaded.git.token).toBe('ghp_must_survive');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('refusing out-of-vault path'));

    // Healed once and written back, so the warning is a repair rather than a
    // line the operator sees on every save forever.
    const stored = await readStoredFile();
    expect(stored.vault.trash).toBe('.trash');
    expect(stored.vault.attachmentDir).toBe('attachments');
  });

  it('holds livesync.includeInternal to the same containment rule', async () => {
    // Entries here are joined onto the vault root and walked exactly like trash
    // is, and the result is replicated to a remote, so an escape leaves the
    // machine rather than merely reading badly.
    const b = await boot();
    const res = await put(b, { livesync: { includeInternal: ['.obsidian', '../../secrets'] } }).expect(400);
    expect((res.body as ErrorBody).error).toContain('livesync.includeInternal');
    expect((await readStoredFile()).livesync.includeInternal).toEqual([]);
  });

  it('heals a hand-edited includeInternal to the empty list, not to everything', async () => {
    const b = await boot({ livesync: { includeInternal: ['../../secrets'] } });
    expect((await b.settings.getSettings()).livesync.includeInternal).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. vault.path, and the gate that must not come from the caller
// ---------------------------------------------------------------------------

/** Values whose resolution has nothing to do with what the caller named. */
const BAD_VAULT_ROOTS: Array<[string, string]> = [
  // path.resolve('') is the process working directory, i.e. the install tree.
  ['empty', ''],
  ['whitespace only', '   '],
  ['dot', '.'],
  ['parent', '..'],
  ['relative', 'notes/vault'],
  ['NUL byte', '/tmp/vault\0/etc'],
];

describe('vault.path', () => {
  it.each(BAD_VAULT_ROOTS)('refuses %s and leaves the vault where it was', async (_label, value) => {
    const b = await boot();
    const before = await readStoredFile();
    const res = await put(b, { vault: { path: value } }).expect(400);
    expect((res.body as ErrorBody).error).toContain('vault.path');

    const stored = await readStoredFile();
    expect(stored.vault.path).toBe(before.vault.path);
    expect(stored.vault.path).toBe(tmp?.vaultDir);
    // The specific catastrophe: with the vault on the install tree, GET
    // /api/files/content?path=data/settings.json returns jwtSecret, both
    // password hashes, git.token and every API key hash in cleartext, and a PUT
    // to server/dist/index.js is code execution on the next restart.
    expect(stored.vault.path).not.toBe(process.cwd());
  });

  it('heals a hand-edited empty vault.path to the configured vault, not to the working directory', async () => {
    const b = await boot({ vault: { path: '' } });
    const loaded = await b.settings.getSettings();
    expect(loaded.vault.path).toBe(tmp?.vaultDir);
    expect(loaded.vault.path).not.toBe(process.cwd());
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('refusing unusable vault path'));
    expect((await readStoredFile()).vault.path).toBe(tmp?.vaultDir);
  });

  it('heals a hand-edited relative vault.path the same way', async () => {
    // Relative is the same catastrophe as empty, one step removed: it resolves
    // against whatever directory the process happened to be started in, which
    // changes under systemd, Docker and the Electron shell.
    const b = await boot({ vault: { path: './notes' } });
    expect((await b.settings.getSettings()).vault.path).toBe(tmp?.vaultDir);
  });

  it('accepts an absolute directory inside the allowed roots', async () => {
    // The positive control. Without it every 403 below could be passing because
    // the gate refuses everything.
    const b = await boot();
    const target = path.join(tmp!.dataDir, 'second-vault');
    await fs.mkdir(target, { recursive: true });
    await put(b, { vault: { path: target } }).expect(200);
    expect((await readStoredFile()).vault.path).toBe(target);
  });

  it('refuses a vault path outside the allowed roots', async () => {
    const b = await boot();
    const outside = await makeOutsideDir();
    const res = await put(b, { vault: { path: outside } }).expect(403);
    expect((res.body as ErrorBody).error).toContain('allowed roots');
    expect((await readStoredFile()).vault.path).toBe(tmp?.vaultDir);
  });

  it('refuses a path that exists but is not a directory', async () => {
    const b = await boot();
    const file = path.join(tmp!.dataDir, 'not-a-directory.md');
    await fs.writeFile(file, '# not a vault');
    await put(b, { vault: { path: file } }).expect(400);
    expect((await readStoredFile()).vault.path).toBe(tmp?.vaultDir);
  });

  it('does not accept allowedRoots from the request body', async () => {
    // allowedRoots IS the boundary a vault path is measured against, so nothing
    // a request carries may influence it. sanitizeVault does not list the field
    // at all, which is why this answers 200 while changing nothing.
    const b = await boot();
    const outside = await makeOutsideDir();
    const before = await readStoredFile();

    await put(b, { vault: { allowedRoots: [outside, path.parse(outside).root] } }).expect(200);

    const stored = await readStoredFile();
    expect(stored.vault.allowedRoots).toEqual(before.vault.allowedRoots);
    expect(stored.vault.allowedRoots).not.toContain(outside);
  });

  it('does not let one request supply the gate it is measured against', async () => {
    // The original bug, verbatim: PUT {"vault":{"path":"C:\\","allowedRoots":["C:\\"]}}
    // passed trivially, so the request granted itself the whole filesystem as a
    // read/write vault and overrode the operator's ALLOWED_ROOTS on the way.
    const b = await boot();
    const outside = await makeOutsideDir();
    const before = await readStoredFile();

    await put(b, { vault: { path: outside, allowedRoots: [outside] } }).expect(403);

    const stored = await readStoredFile();
    expect(stored.vault.path).toBe(before.vault.path);
    expect(stored.vault.allowedRoots).toEqual(before.vault.allowedRoots);
  });

  it('does not let two requests do it either', async () => {
    // Widen first, move second. This is why the field is not writable at all
    // rather than merely deprioritised.
    const b = await boot();
    const outside = await makeOutsideDir();

    await put(b, { vault: { allowedRoots: [outside] } }).expect(200);
    await put(b, { vault: { path: outside } }).expect(403);

    const stored = await readStoredFile();
    expect(stored.vault.path).toBe(tmp?.vaultDir);
    expect(stored.vault.allowedRoots).not.toContain(outside);
  });

  it('keeps ALLOWED_ROOTS authoritative over the persisted list', async () => {
    // Precedence 1 in effectiveRoots(): an operator who states a boundary
    // explicitly gets that boundary, and a settings.json that has drifted wider
    // cannot void it.
    const b = await boot();
    const outside = await makeOutsideDir();
    // Simulate a file that was widened out of band (a hand edit, or an install
    // that exploited the old behaviour before it was fixed).
    await b.settings.updateSettings((d) => {
      d.vault.allowedRoots = [...d.vault.allowedRoots, outside];
    });
    expect((await readStoredFile()).vault.allowedRoots).toContain(outside);

    // The env is read at config load time, so the module graph has to be rebuilt
    // for it to take effect. Keep the same DATA_DIR so the widened file is the
    // one that gets loaded.
    const dataDir = tmp!.dataDir;
    const vaultDir = tmp!.vaultDir;
    process.env.ALLOWED_ROOTS = vaultDir;
    resetSettingsCache();
    process.env.DATA_DIR = dataDir;
    process.env.VAULT_PATH = vaultDir;

    const settings = await import('../services/settings.js');
    const { settingsRouter } = await import('../routes/settings.js');
    const { errorHandler } = await import('../middleware/error.js');
    const { issueToken } = await import('../services/auth.js');
    const app = makeTestApp();
    app.use('/api/settings', settingsRouter);
    app.use(errorHandler);
    const reBooted: Booted = { app, token: await issueToken(), settings };

    await put(reBooted, { vault: { path: outside } }).expect(403);
    expect((await readStoredFile()).vault.path).toBe(vaultDir);
  });
});

// ---------------------------------------------------------------------------
// Local utilities
// ---------------------------------------------------------------------------

/**
 * Every .ts file under server/src, excluding this directory.
 *
 * Written by hand rather than with fs.readdir's `recursive` option: that option
 * landed in Node 20.1 and its dirent shape changed again in 20.12, and this has
 * to work on whatever Node 20 CI happens to pin.
 */
async function collectSourceFiles(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      await collectSourceFiles(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}
