/**
 * Security regression tests for the Setup URI endpoints.
 *
 * This surface is the one deliberate hole in the rule that `redactSettings`
 * exists to enforce: it emits the CouchDB password and the end-to-end encryption
 * passphrase, once, on purpose. Everything here exists to keep that hole the
 * exact size it was designed to be, so the tests are written as "what must never
 * happen" rather than as coverage of the happy path.
 *
 * The two directions fail differently and both are covered:
 *
 *   EXPORT leaks THIS instance's secrets. The tests assert that an
 *   unauthenticated caller cannot mint, that a session cookie alone is not
 *   enough, that a minted URI carries nothing from outside the LiveSync block,
 *   and that a URI can be retrieved exactly once before the handle dies.
 *
 *   IMPORT hands over THIS instance's VAULT, and is the direction an attacker
 *   can initiate, because a Setup URI is a string a user can be talked into
 *   pasting. The tests assert that a hostile URI cannot touch anything outside
 *   `livesync`, that it cannot repoint the vault without the operator typing the
 *   new host, and that the decode endpoint cannot be used as a decryption oracle.
 *
 * `requireAuth` is never stubbed. The tests mount it exactly as production does
 * and mint a real owner token from the same module instance, so what is being
 * asserted is the middleware actually running rather than a mock of it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ROUTER IS MOUNTED THE WAY IT IS
 *
 * These tests need `resetSettingsCache()` (i.e. `vi.resetModules()`) per case,
 * because services/settings.ts keeps its cache, in-flight load and mutation
 * queue in module-global variables with no reset hook. That rules out reaching
 * the endpoints through `routes/livesync.ts`: importing it pulls in the vendored
 * engine, and a SECOND evaluation of the engine throws `Cannot redefine
 * property: replicate` because PouchDB refuses to apply its plugins twice.
 *
 * So the per-test app mounts `livesyncSetupRouter` behind the same `requireAuth`
 * that `livesyncRouter` applies, and one separate test -- using a STATIC import,
 * evaluated once before any module reset -- asserts that the production router
 * really does mount these paths. Together those cover both "the handlers behave"
 * and "the handlers are reachable where production serves them", without ever
 * evaluating the engine twice.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import type { Express, Router } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { makeTestApp, makeTmpDataDir, resetSettingsCache, writeSettings } from './helpers.js';
// STATIC, and deliberately the only import of this module in the file. It is
// evaluated once at file load, before any resetModules() call, so the engine it
// transitively pulls in is initialised exactly once.
import { livesyncRouter } from '../routes/livesync.js';

const OWNER_PASSWORD = '123456'; // the shipped default, active on a fresh instance
const URI_PASSPHRASE = 'a-long-enough-uri-passphrase';

/** A settings.json seed with LiveSync fully configured and secrets in the tree. */
function configuredSeed(overrides: Record<string, unknown> = {}) {
  return {
    sync: { backend: 'livesync' },
    livesync: {
      uri: 'https://couch.example.test',
      database: 'notes',
      username: 'alice',
      password: 'couch-secret',
      passphrase: 'vault-secret',
      obfuscatePassphrase: 'vault-secret',
      liveMode: false,
      intervalSec: 45,
      includeInternal: ['.obsidian'],
      ...overrides,
    },
    // Secrets from OTHER blocks, present so the export-scoping test has
    // something real to assert never leaves.
    git: { token: 'ghp_do_not_export_this_token' },
    oidc: { clientSecret: 'oidc-do-not-export-this-secret' },
  };
}

let tmp: Awaited<ReturnType<typeof makeTmpDataDir>> | null = null;
let warnSpy: MockInstance;

beforeEach(() => {
  // The audit lines are written with console.warn. Captured rather than
  // silenced, so "the issuance was audited" is itself assertable.
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  warnSpy.mockRestore();
  await tmp?.cleanup();
  tmp = null;
});

interface Booted {
  app: Express;
  token: string;
}

async function boot(seed?: Record<string, unknown>): Promise<Booted> {
  resetSettingsCache();
  tmp = await makeTmpDataDir();
  if (seed) await writeSettings(tmp.dataDir, seed);

  const { livesyncSetupRouter } = await import('../routes/livesync-setup.js');
  const { requireAuth } = await import('../middleware/auth.js');
  const { errorHandler } = await import('../middleware/error.js');
  const { issueToken } = await import('../services/auth.js');

  const app = makeTestApp();
  // The same two lines routes/livesync.ts uses, in the same order.
  app.use('/api/livesync', requireAuth, livesyncSetupRouter);
  app.use(errorHandler);

  return { app, token: await issueToken() };
}

/** Collect every concrete route path registered on a router, recursively. */
function routePaths(router: Router): string[] {
  const out: string[] = [];
  interface Layer {
    route?: { path: string };
    handle?: { stack?: Layer[] };
  }
  const stack = (router as unknown as { stack?: Layer[] }).stack ?? [];
  const walk = (layers: Layer[]): void => {
    for (const layer of layers) {
      if (layer.route) out.push(layer.route.path);
      else if (layer.handle?.stack) walk(layer.handle.stack);
    }
  };
  walk(stack);
  return out;
}

describe('the production mount', () => {
  /**
   * Guards the one thing the per-test app cannot: that `routes/livesync.ts`
   * actually mounts the setup router. Without this, deleting that single
   * `livesyncRouter.use(...)` line would leave every test below green while the
   * feature became unreachable in the running server.
   */
  it('registers the Setup URI routes on livesyncRouter', () => {
    const paths = routePaths(livesyncRouter);
    expect(paths).toContain('/setup-uri');
    expect(paths).toContain('/setup-uri/retrieve');
    expect(paths).toContain('/setup-uri/decode');
    expect(paths).toContain('/setup-uri/apply');
  });
});

const post = (b: Booted, urlPath: string, body: Record<string, unknown> = {}) =>
  request(b.app)
    .post(`/api/livesync${urlPath}`)
    .set('Authorization', `Bearer ${b.token}`)
    .send(body);

/** Mint and retrieve in one step, for tests that only care about the URI. */
async function mintUri(b: Booted, passphrase = URI_PASSPHRASE): Promise<string> {
  const minted = await post(b, '/setup-uri', {
    currentPassword: OWNER_PASSWORD,
    uriPassphrase: passphrase,
  }).expect(200);
  const got = await post(b, '/setup-uri/retrieve', { handle: minted.body.handle }).expect(200);
  return got.body.uri as string;
}

async function readStoredFile(): Promise<Record<string, never>> {
  if (!tmp) throw new Error('boot() was not called');
  return JSON.parse(await fs.readFile(path.join(tmp.dataDir, 'settings.json'), 'utf8'));
}

// ---------------------------------------------------------------------------
// Export: who may mint
// ---------------------------------------------------------------------------

describe('minting requires more than a session', () => {
  it('refuses an unauthenticated caller', async () => {
    const b = await boot(configuredSeed());
    await request(b.app)
      .post('/api/livesync/setup-uri')
      .send({ currentPassword: OWNER_PASSWORD, uriPassphrase: URI_PASSPHRASE })
      .expect(401);
  });

  /**
   * The whole point of re-authentication. A valid session cookie proves only
   * that SOMEONE holds it, not that the owner is at the keyboard, and this is a
   * read-everything endpoint rather than a write-mostly one.
   */
  it('refuses a valid session with no password', async () => {
    const b = await boot(configuredSeed());
    await post(b, '/setup-uri', { uriPassphrase: URI_PASSPHRASE }).expect(401);
  });

  it('refuses a valid session with the wrong password', async () => {
    const b = await boot(configuredSeed());
    await post(b, '/setup-uri', {
      currentPassword: 'not-the-password',
      uriPassphrase: URI_PASSPHRASE,
    }).expect(401);
  });

  it('refuses retrieval of a handle that was never issued', async () => {
    const b = await boot(configuredSeed());
    await post(b, '/setup-uri/retrieve', { handle: 'made-up-handle' }).expect(404);
  });

  /**
   * On an SSO-only instance the owner-password control cannot be enforced.
   * Refusing loudly beats degrading to cookie-only, which would make the
   * strongest auth configuration the weakest surface.
   */
  it('refuses on an instance with password login disabled', async () => {
    const b = await boot({
      ...configuredSeed(),
      oidc: {
        enabled: true,
        issuer: 'https://idp.example',
        clientId: 'client',
        allowPasswordLogin: false,
      },
    });
    const res = await post(b, '/setup-uri', {
      currentPassword: OWNER_PASSWORD,
      uriPassphrase: URI_PASSPHRASE,
    }).expect(409);
    expect(res.body.error).toMatch(/password login is disabled/i);
  });
});

describe('minting requires a usable configuration and a real passphrase', () => {
  it('refuses a passphrase shorter than the minimum', async () => {
    const b = await boot(configuredSeed());
    const res = await post(b, '/setup-uri', {
      currentPassword: OWNER_PASSWORD,
      uriPassphrase: 'short',
    }).expect(400);
    expect(res.body.error).toMatch(/at least 12 characters/i);
  });

  it('refuses an empty passphrase rather than generating one', async () => {
    const b = await boot(configuredSeed());
    await post(b, '/setup-uri', { currentPassword: OWNER_PASSWORD, uriPassphrase: '' }).expect(400);
    await post(b, '/setup-uri', { currentPassword: OWNER_PASSWORD }).expect(400);
  });

  it('refuses when LiveSync is not the active backend', async () => {
    const b = await boot({ ...configuredSeed(), sync: { backend: 'git' } });
    await post(b, '/setup-uri', {
      currentPassword: OWNER_PASSWORD,
      uriPassphrase: URI_PASSPHRASE,
    }).expect(409);
  });

  it('refuses when LiveSync is only half configured', async () => {
    const b = await boot({ ...configuredSeed({ password: '' }) });
    await post(b, '/setup-uri', {
      currentPassword: OWNER_PASSWORD,
      uriPassphrase: URI_PASSPHRASE,
    }).expect(409);
  });

  /**
   * The configuration that looks encrypted and is not: opaque `f:` document ids
   * over plaintext bodies. Propagating it to a second device would make the
   * naive verification ("are the ids opaque?") pass on BOTH devices while the
   * bodies sat readable in CouchDB on both.
   *
   * Note WHICH guard catches it, because the layering is the interesting part:
   * the settings SCHEMA already refuses to run the LiveSync backend in this
   * state (`enforceSyncSafety` flips `sync.backend` to 'none'), so the endpoint's
   * backend check fires first and the instance never even presents as paired.
   * The endpoint keeps its own `isUnsafeE2eePairing` check anyway, as the
   * matching guard for any future path that sets the backend differently; this
   * asserts the outcome an operator actually gets today, which is a refusal
   * either way.
   */
  it('refuses to propagate obfuscation without encryption', async () => {
    const b = await boot(configuredSeed({ passphrase: '', obfuscatePassphrase: 'x' }));
    const res = await post(b, '/setup-uri', {
      currentPassword: OWNER_PASSWORD,
      uriPassphrase: URI_PASSPHRASE,
    }).expect(409);
    expect(res.body.error).toMatch(/not the active sync backend/i);

    // The schema is what demoted it, and it says so loudly rather than silently.
    const stored = (await readStoredFile()) as never as { sync: { backend: string } };
    expect(stored.sync.backend).not.toBe('livesync');
  });

  /**
   * The plugin format has no slot for a distinct obfuscation passphrase, so
   * emitting one would hand the joining device a key that produces different
   * document ids for the same path. Refusing is the only honest answer.
   */
  it('refuses when the obfuscation passphrase differs from the encryption one', async () => {
    const b = await boot(configuredSeed({ obfuscatePassphrase: 'a-different-value' }));
    const res = await post(b, '/setup-uri', {
      currentPassword: OWNER_PASSWORD,
      uriPassphrase: URI_PASSPHRASE,
    }).expect(409);
    expect(res.body.error).toMatch(/cannot be expressed in a Setup URI/i);
  });
});

// ---------------------------------------------------------------------------
// Export: the handle, and what the URI contains
// ---------------------------------------------------------------------------

describe('the minted URI', () => {
  it('is not in the mint response, only a handle', async () => {
    const b = await boot(configuredSeed());
    const res = await post(b, '/setup-uri', {
      currentPassword: OWNER_PASSWORD,
      uriPassphrase: URI_PASSPHRASE,
    }).expect(200);
    expect(res.body.handle).toEqual(expect.any(String));
    expect(res.body.expiresAt).toEqual(expect.any(Number));
    expect(JSON.stringify(res.body)).not.toContain('couch-secret');
    expect(JSON.stringify(res.body)).not.toContain('obsidian://');
  });

  it('can be retrieved exactly once', async () => {
    const b = await boot(configuredSeed());
    const minted = await post(b, '/setup-uri', {
      currentPassword: OWNER_PASSWORD,
      uriPassphrase: URI_PASSPHRASE,
    }).expect(200);

    const first = await post(b, '/setup-uri/retrieve', { handle: minted.body.handle }).expect(200);
    expect(first.body.uri).toContain('obsidian://setuplivesync?settings=');

    // A replay -- from a proxy, a prefetcher or a duplicated tab -- gets nothing.
    await post(b, '/setup-uri/retrieve', { handle: minted.body.handle }).expect(404);
  });

  it('decodes back to this instance settings under the caller passphrase', async () => {
    const b = await boot(configuredSeed());
    const uri = await mintUri(b);
    const { decodeSetupUri } = await import('../services/livesync/setup-uri.js');
    const { block } = await decodeSetupUri(uri, URI_PASSPHRASE);
    expect(block).toEqual({
      uri: 'https://couch.example.test',
      database: 'notes',
      username: 'alice',
      password: 'couch-secret',
      passphrase: 'vault-secret',
      obfuscatePassphrase: 'vault-secret',
      liveMode: false,
      intervalSec: 45,
    });
  });

  it('cannot be decoded under any other passphrase', async () => {
    const b = await boot(configuredSeed());
    const uri = await mintUri(b);
    const { decodeSetupUri } = await import('../services/livesync/setup-uri.js');
    await expect(decodeSetupUri(uri, 'the-wrong-passphrase-entirely')).rejects.toThrow();
  });

  /**
   * A Setup URI must not become a configuration dump. `git.token`,
   * `oidc.clientSecret`, `auth.jwtSecret` and every API key hash live in the same
   * settings tree, and `includeInternal` is this host's filesystem layout.
   */
  it('carries nothing from outside the LiveSync block', async () => {
    const b = await boot(configuredSeed());
    const uri = await mintUri(b);
    const { decodeSetupUri } = await import('../services/livesync/setup-uri.js');
    const decoded = await decodeSetupUri(uri, URI_PASSPHRASE);
    const everything = JSON.stringify({ ...decoded.block, ...decoded.carryOver });

    expect(everything).not.toContain('ghp_do_not_export_this_token');
    expect(everything).not.toContain('oidc-do-not-export-this-secret');
    expect(everything).not.toContain('.obsidian');
    expect(everything).not.toContain('jwtSecret');
    for (const key of ['vault', 'auth', 'git', 'oidc', 'api', 'syncInternalFiles']) {
      expect(decoded.carryOver[key]).toBeUndefined();
    }
  });

  it('comes with a scannable QR matrix rather than an image URL', async () => {
    const b = await boot(configuredSeed());
    const minted = await post(b, '/setup-uri', {
      currentPassword: OWNER_PASSWORD,
      uriPassphrase: URI_PASSPHRASE,
    }).expect(200);
    const res = await post(b, '/setup-uri/retrieve', { handle: minted.body.handle }).expect(200);

    expect(res.body.qr.size).toBe(res.body.qr.version * 4 + 17);
    expect(res.body.qr.rows).toHaveLength(res.body.qr.size);
    for (const row of res.body.qr.rows) expect(row).toMatch(/^[01]+$/);
  });

  it('is audited without recording the URI, the passphrase or the CouchDB URL', async () => {
    const b = await boot(configuredSeed());
    await mintUri(b);
    const audit = warnSpy.mock.calls.flat().join('\n');
    expect(audit).toMatch(/\[audit\] Setup URI minted/);
    expect(audit).not.toContain('couch-secret');
    expect(audit).not.toContain(URI_PASSPHRASE);
    expect(audit).not.toContain('obsidian://');
  });
});

describe('cache control', () => {
  /**
   * A 200 with no directives is heuristically cacheable, and this deployment
   * sits behind a proxy that may cache. Every branch has to carry these headers,
   * including the ones a rate limiter answers before the handler runs.
   */
  it('marks every response uncacheable, on success and on failure alike', async () => {
    const b = await boot(configuredSeed());

    const ok = await post(b, '/setup-uri', {
      currentPassword: OWNER_PASSWORD,
      uriPassphrase: URI_PASSPHRASE,
    }).expect(200);
    const unauthorized = await post(b, '/setup-uri', { uriPassphrase: URI_PASSPHRASE }).expect(401);
    const notFound = await post(b, '/setup-uri/retrieve', { handle: 'nope' }).expect(404);

    for (const res of [ok, unauthorized, notFound]) {
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['vary']).toContain('Cookie');
    }
  });

  /**
   * The ordering trap this codebase has hit before: a limiter answers its own
   * 429 and returns WITHOUT reaching the handler, so headers set in the handler
   * never happen on the one response most likely to be repeated.
   */
  it('keeps the headers on a rate-limited 429', async () => {
    const b = await boot(configuredSeed());
    let limited: request.Response | null = null;
    for (let i = 0; i < 12; i += 1) {
      const res = await post(b, '/setup-uri', {
        currentPassword: OWNER_PASSWORD,
        uriPassphrase: URI_PASSPHRASE,
      });
      if (res.status === 429) {
        limited = res;
        break;
      }
    }
    expect(limited).not.toBeNull();
    expect(limited!.headers['cache-control']).toBe('private, no-store');
    expect(limited!.headers['vary']).toContain('Cookie');
  });
});

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** Build a Setup URI carrying `payload`, encrypted under `passphrase`. */
async function craftUri(
  block: Record<string, unknown>,
  carryOver: Record<string, unknown> = {},
  passphrase = URI_PASSPHRASE,
): Promise<string> {
  const { encodeSetupUri } = await import('../services/livesync/setup-uri.js');
  return encodeSetupUri(
    {
      uri: 'https://couch.example.test',
      database: 'notes',
      username: 'alice',
      password: 'couch-secret',
      passphrase: 'vault-secret',
      obfuscatePassphrase: 'vault-secret',
      liveMode: false,
      intervalSec: 45,
      ...block,
    } as never,
    passphrase,
    carryOver,
  );
}

/**
 * Encrypt an ARBITRARY payload object into a Setup URI, bypassing our encoder's
 * own field discipline.
 *
 * Needed because the hostile cases are precisely the ones `encodeSetupUri`
 * refuses to construct. Reproduces the `%$` envelope inline rather than reaching
 * into the codec, so a codec change that broke the format would break these
 * tests too instead of hiding behind a shared helper.
 */
async function craftRawUri(payload: Record<string, unknown>): Promise<string> {
  const { webcrypto } = await import('node:crypto');
  const pbkdf2Salt = webcrypto.getRandomValues(new Uint8Array(32));
  const hkdfSalt = webcrypto.getRandomValues(new Uint8Array(32));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const material = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(URI_PASSPHRASE),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  const master = await webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: pbkdf2Salt, iterations: 310_000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  const hkdfKey = await webcrypto.subtle.importKey(
    'raw',
    await webcrypto.subtle.exportKey('raw', master),
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  );
  const key = await webcrypto.subtle.deriveKey(
    { name: 'HKDF', salt: hkdfSalt, info: new Uint8Array(), hash: 'SHA-256' },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const ct = new Uint8Array(
    await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      key,
      new TextEncoder().encode(JSON.stringify(payload)),
    ),
  );
  const all = new Uint8Array(76 + ct.length);
  all.set(pbkdf2Salt, 0);
  all.set(iv, 32);
  all.set(hkdfSalt, 44);
  all.set(ct, 76);
  return (
    'obsidian://setuplivesync?settings=' +
    encodeURIComponent('%$' + Buffer.from(all).toString('base64'))
  );
}

describe('decoding a pasted URI', () => {
  it('returns a redacted preview and writes nothing', async () => {
    const b = await boot(configuredSeed());
    const uri = await craftUri({ uri: 'https://other.example.test' });

    const res = await post(b, '/setup-uri/decode', { uri, passphrase: URI_PASSPHRASE }).expect(200);

    expect(res.body.preview.database).toBe('notes');
    expect(res.body.preview.username).toBe('alice');
    // The three secrets are masked. An unredacted preview would make this
    // endpoint the leak the export side works to prevent.
    expect(res.body.preview.password).toBe('••••••••');
    expect(res.body.preview.passphrase).toBe('••••••••');
    expect(JSON.stringify(res.body)).not.toContain('couch-secret');
    expect(JSON.stringify(res.body)).not.toContain('vault-secret');

    // Nothing changed on disk.
    const stored = await readStoredFile();
    expect((stored as never as { livesync: { uri: string } }).livesync.uri).toBe(
      'https://couch.example.test',
    );
  });

  /**
   * The repoint attack, made legible. A changed host is the headline, not a
   * table row an operator scrolls past.
   */
  it('names a host change in plain language', async () => {
    const b = await boot(configuredSeed());
    const uri = await craftUri({ uri: 'https://attacker.example' });
    const res = await post(b, '/setup-uri/decode', { uri, passphrase: URI_PASSPHRASE }).expect(200);

    expect(res.body.requiresHostConfirmation).toBe(true);
    expect(res.body.warnings.join(' ')).toMatch(/DIFFERENT server/);
    expect(res.body.warnings.join(' ')).toContain('attacker.example');
  });

  /**
   * The poison attack. Reported by COMPARING the passphrases, never by
   * displaying either.
   */
  it('warns that a changed passphrase makes existing documents unreadable', async () => {
    const b = await boot(configuredSeed());
    const uri = await craftUri({ passphrase: 'a-different-vault-key', obfuscatePassphrase: 'a-different-vault-key' });
    const res = await post(b, '/setup-uri/decode', { uri, passphrase: URI_PASSPHRASE }).expect(200);
    expect(res.body.warnings.join(' ')).toMatch(/not be readable|rebuild/i);
    expect(JSON.stringify(res.body)).not.toContain('a-different-vault-key');
  });

  /**
   * No decryption oracle. Wrong passphrase, malformed blob, unsupported envelope
   * and not-a-Setup-URI must be indistinguishable, byte for byte.
   */
  it('answers every failure with one identical message', async () => {
    const b = await boot(configuredSeed());
    const uri = await craftUri({});

    const wrongPassphrase = await post(b, '/setup-uri/decode', {
      uri,
      passphrase: 'wrong-passphrase-here',
    }).expect(400);
    const malformed = await post(b, '/setup-uri/decode', {
      uri: 'obsidian://setuplivesync?settings=%$notbase64!!',
      passphrase: URI_PASSPHRASE,
    }).expect(400);
    const notAUri = await post(b, '/setup-uri/decode', {
      uri: 'https://example.com/nope',
      passphrase: URI_PASSPHRASE,
    }).expect(400);

    expect(malformed.body.error).toBe(wrongPassphrase.body.error);
    expect(notAUri.body.error).toBe(wrongPassphrase.body.error);
    // And it never leaks the codec's own vocabulary.
    expect(wrongPassphrase.body.error).not.toMatch(/decrypt|envelope|base64|prefix/i);
  });

  it('refuses an oversized URI without doing the key derivation', async () => {
    const b = await boot(configuredSeed());
    const started = Date.now();
    await post(b, '/setup-uri/decode', {
      uri: `obsidian://setuplivesync?settings=${'A'.repeat(70_000)}`,
      passphrase: URI_PASSPHRASE,
    }).expect(400);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('refuses a remote this server cannot drive', async () => {
    const b = await boot(configuredSeed());
    for (const carry of [{ remoteType: 'MINIO' }, { P2P_Enabled: true }]) {
      const uri = await craftUri({}, carry);
      const res = await post(b, '/setup-uri/decode', { uri, passphrase: URI_PASSPHRASE }).expect(400);
      expect(res.body.error).toMatch(/only supports CouchDB|peer-to-peer/i);
    }
  });

  /**
   * The same validators as the settings PUT, reached through the newer door.
   * `../_users` is the one that matters: the engine builds `url + "/" + database`
   * with no encoding, so it would point the replicator at CouchDB's credential
   * database -- and here the string is attacker-controlled.
   */
  it('refuses a traversing database name and a non-http scheme', async () => {
    const b = await boot(configuredSeed());

    const traversal = await craftUri({ database: '../_users' });
    const bad1 = await post(b, '/setup-uri/decode', {
      uri: traversal,
      passphrase: URI_PASSPHRASE,
    }).expect(400);
    expect(bad1.body.error).toMatch(/database/i);

    const scheme = await craftUri({ uri: 'file:///etc/passwd' });
    const bad2 = await post(b, '/setup-uri/decode', {
      uri: scheme,
      passphrase: URI_PASSPHRASE,
    }).expect(400);
    expect(bad2.body.error).toMatch(/http/i);
  });

  /**
   * The one E2EE combination that looks configured and is not: hashed document
   * ids over plaintext bodies. Our own encoder cannot produce it, so the payload
   * is crafted raw -- which is the honest test anyway, since the threat is a URI
   * this server did not write.
   */
  it('refuses a raw payload asking for obfuscation without encryption', async () => {
    const b = await boot(configuredSeed());
    const uri = await craftRawUri({
      couchDB_URI: 'https://couch.example.test',
      couchDB_DBNAME: 'notes',
      couchDB_USER: 'alice',
      couchDB_PASSWORD: 'pw',
      encrypt: false,
      passphrase: '',
      usePathObfuscation: true,
    });
    const res = await post(b, '/setup-uri/decode', { uri, passphrase: URI_PASSPHRASE }).expect(400);
    expect(res.body.error).toMatch(/without an encryption passphrase/i);
  });

  /**
   * A literal `__proto__` key in an attacker-supplied payload must stay inert.
   * The decoded object is JSON.parse over attacker-controlled plaintext, so this
   * is a real reachable input rather than a theoretical one.
   */
  it('cannot pollute a prototype through a crafted payload', async () => {
    const b = await boot(configuredSeed());
    const uri = await craftRawUri({
      couchDB_URI: 'https://couch.example.test',
      couchDB_DBNAME: 'notes',
      couchDB_USER: 'alice',
      couchDB_PASSWORD: 'pw',
      __proto__: { polluted: true },
    } as Record<string, unknown>);
    await post(b, '/setup-uri/decode', { uri, passphrase: URI_PASSPHRASE }).expect(200);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('applying a decoded URI', () => {
  async function decodeFor(b: Booted, uri: string): Promise<string> {
    const res = await post(b, '/setup-uri/decode', { uri, passphrase: URI_PASSPHRASE }).expect(200);
    return res.body.handle as string;
  }

  it('refuses without the owner password', async () => {
    const b = await boot(configuredSeed());
    const handle = await decodeFor(b, await craftUri({ username: 'bob' }));
    await post(b, '/setup-uri/apply', { handle }).expect(401);
  });

  it('refuses an unauthenticated caller', async () => {
    const b = await boot(configuredSeed());
    const handle = await decodeFor(b, await craftUri({ username: 'bob' }));
    await request(b.app)
      .post('/api/livesync/setup-uri/apply')
      .send({ handle, currentPassword: OWNER_PASSWORD })
      .expect(401);
  });

  it('applies a same-host change and writes only the LiveSync block', async () => {
    const b = await boot(configuredSeed());
    const handle = await decodeFor(b, await craftUri({ username: 'bob', intervalSec: 90 }));
    await post(b, '/setup-uri/apply', { handle, currentPassword: OWNER_PASSWORD }).expect(200);

    const stored = (await readStoredFile()) as never as {
      livesync: Record<string, unknown>;
      git: { token: string };
      sync: { backend: string };
    };
    expect(stored.livesync.username).toBe('bob');
    expect(stored.livesync.intervalSec).toBe(90);
    // Untouched neighbours.
    expect(stored.git.token).toBe('ghp_do_not_export_this_token');
    expect(stored.sync.backend).toBe('livesync');
    // includeInternal is NOT importable: it names directories this server walks.
    expect(stored.livesync.includeInternal).toEqual(['.obsidian']);
  });

  it('consumes the preview handle exactly once', async () => {
    const b = await boot(configuredSeed());
    const handle = await decodeFor(b, await craftUri({ username: 'bob' }));
    await post(b, '/setup-uri/apply', { handle, currentPassword: OWNER_PASSWORD }).expect(200);
    await post(b, '/setup-uri/apply', { handle, currentPassword: OWNER_PASSWORD }).expect(404);
  });

  /**
   * The repoint gate. An unattended browser or a stolen cookie must not be
   * enough to point the vault at someone else's server: the operator has to READ
   * the hostname and type it back.
   */
  it('refuses a host change unless the new host is typed back exactly', async () => {
    const b = await boot(configuredSeed());
    const uri = await craftUri({ uri: 'https://attacker.example' });

    const handle = await decodeFor(b, uri);
    const refused = await post(b, '/setup-uri/apply', {
      handle,
      currentPassword: OWNER_PASSWORD,
    }).expect(400);
    expect(refused.body.error).toContain('attacker.example');

    const stored = (await readStoredFile()) as never as { livesync: { uri: string } };
    expect(stored.livesync.uri).toBe('https://couch.example.test');

    const handle2 = await decodeFor(b, uri);
    await post(b, '/setup-uri/apply', {
      handle: handle2,
      currentPassword: OWNER_PASSWORD,
      confirmHost: 'wrong.example',
    }).expect(400);

    const handle3 = await decodeFor(b, uri);
    await post(b, '/setup-uri/apply', {
      handle: handle3,
      currentPassword: OWNER_PASSWORD,
      confirmHost: 'attacker.example',
    }).expect(200);

    const after = (await readStoredFile()) as never as { livesync: { uri: string } };
    expect(after.livesync.uri).toBe('https://attacker.example');
  });

  /**
   * THE headline import test. A hostile URI carrying keys that name other
   * settings blocks must not move any of them. The import reads a fixed
   * allowlist rather than merging, so these are inert by construction -- this
   * asserts that the construction actually holds end to end.
   */
  it('cannot change anything outside the LiveSync block', async () => {
    const b = await boot(configuredSeed());
    const before = (await readStoredFile()) as never as Record<string, Record<string, unknown>>;

    const hostile = await craftUri(
      { username: 'bob' },
      {
        // Names of our own settings blocks, in the payload.
        vault: { path: 'C:/', trash: '../../etc' },
        sync: { backend: 'git' },
        auth: { jwtSecret: 'attacker-secret', passwordHash: 'attacker-hash' },
        git: { token: 'attacker-token', remote: 'https://attacker.example/repo.git' },
        oidc: { clientSecret: 'attacker', allowPasswordLogin: false },
        api: { keys: [{ id: 'x', hash: 'y' }] },
        // And the LiveSync fields that are deliberately not importable.
        includeInternal: ['../../../etc'],
        syncInternalFiles: true,
      },
    );

    const handle = await decodeFor(b, hostile);
    await post(b, '/setup-uri/apply', { handle, currentPassword: OWNER_PASSWORD }).expect(200);

    const after = (await readStoredFile()) as never as Record<string, Record<string, unknown>>;

    expect(after.vault).toEqual(before.vault);
    expect(after.sync).toEqual(before.sync);
    expect(after.auth).toEqual(before.auth);
    expect(after.git).toEqual(before.git);
    expect(after.oidc).toEqual(before.oidc);
    expect(after.api).toEqual(before.api);
    expect(after.livesync.includeInternal).toEqual(['.obsidian']);
    // The one thing it WAS allowed to change.
    expect(after.livesync.username).toBe('bob');
    // And nothing anywhere carries the attacker's strings.
    const everything = JSON.stringify(after);
    for (const marker of ['attacker-secret', 'attacker-hash', 'attacker-token', '../../etc']) {
      expect(everything).not.toContain(marker);
    }
  });

  it('marks its responses uncacheable too', async () => {
    const b = await boot(configuredSeed());
    const handle = await decodeFor(b, await craftUri({ username: 'bob' }));
    const res = await post(b, '/setup-uri/apply', {
      handle,
      currentPassword: OWNER_PASSWORD,
    }).expect(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    // The applied settings come back redacted, like every other settings response.
    expect(JSON.stringify(res.body)).not.toContain('couch-secret');
  });
});
