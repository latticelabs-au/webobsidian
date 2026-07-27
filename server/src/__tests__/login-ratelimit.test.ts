/**
 * Regression tests for the operator-configurable login throttle
 * (`auth.rateLimit`).
 *
 * The property this file exists to protect is narrow and unforgiving: an
 * operator must never be able to save a login limit that locks them out of their
 * own instance, because the page that would undo it is behind the login they just
 * closed. `POST /auth/login` is guarded by two limiters that both test
 * `hits.length >= max`, which is true on the very first request whenever `max` is
 * zero or less, and the throttle runs BEFORE any credential is checked, so not
 * even the WEBOBSIDIAN_PASSWORD recovery override gets past it. The only remedy
 * left would be hand-editing settings.json on the server.
 *
 * So four things are pinned here, and each one is silent when it breaks:
 *
 *   1. THE DEFAULTS DID NOT MOVE. The whole change is only safe because an
 *      install that has never touched the setting behaves exactly as the previous
 *      build did: 10 attempts per 15 minutes on the network layer, 25 failures
 *      per 15 minutes on the identity layer.
 *   2. A VALUE BELOW THE FLOOR IS REFUSED, NOT HEALED. Over HTTP the answer is a
 *      400 and nothing is written. Clamping would answer 200 while storing a
 *      number the operator did not type, so the throttle they believe is in force
 *      and the one that is would differ with nothing anywhere saying so.
 *   3. A HAND-EDITED FILE BELOW THE FLOOR HEALS LOUDLY. The schema's `.catch()`
 *      cannot throw (loadSettingsImpl treats any parse failure as "file unusable"
 *      and rewrites from defaults, destroying jwtSecret and every API key), so it
 *      falls back to the shipped value and says so. The instance stays reachable.
 *   4. A CHANGED LIMIT APPLIES WITHOUT A RESTART, and the hit history survives
 *      the change. A setting that silently needs a restart is the failure mode
 *      this repo keeps calling out; a limiter that rebuilt its store on a change
 *      would be worse still, because it would hand every key a clean slate and
 *      count nothing.
 *
 * Structure notes, following settings.test.ts and ratelimit.test.ts:
 *
 * - ONE module graph per test, built by boot(). The settings service, the
 *   settings router and the ratelimit middleware must all be the same instances,
 *   because the test asserts that a write through the router is visible to the
 *   limiter through `peekSettings()`. A static import of any of them would defeat
 *   that entirely and the tests would pass against whichever cache happened to be
 *   warm first.
 * - Time is a Date.now stub, as in ratelimit.test.ts. The stores are sliding
 *   windows over Date.now() with no timers of their own, so a stub is faithful
 *   and it is the only way to assert what happens fifteen minutes later.
 * - Assertions read settings.json off disk, not just the response body. A value
 *   that survives in the cache but not in the file is still lost on the next
 *   restart, and the file is what the operator keeps.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import type { Express, Request, RequestHandler, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  makeTestApp,
  makeTmpDataDir,
  resetSettingsCache,
  writeSettings,
  type TmpDir,
} from './helpers.js';
import type { Settings } from '../services/settings.js';

type SettingsModule = typeof import('../services/settings.js');
type RateLimitModule = typeof import('../middleware/ratelimit.js');

/** The shipped numbers, spelled out rather than imported. */
const SHIPPED = {
  loginWindowSec: 900,
  loginMaxAttempts: 10,
  loginFailureWindowSec: 900,
  loginFailureMaxAttempts: 25,
} as const;

/** The error middleware's response shape. */
interface ErrorBody {
  error: string;
}

let tmp: TmpDir | null = null;
let warnSpy: MockInstance<typeof console.warn>;
let prevTrustProxy: string | undefined;

beforeEach(() => {
  // The limiters key on the TCP socket address unless TRUST_PROXY names a subnet
  // or a preset, and the fake requests below supply a socket address only. A
  // value leaking in from the developer's own environment would switch the keying
  // rule and make the bucketing assertions pass or fail for reasons that have
  // nothing to do with this code.
  prevTrustProxy = process.env.TRUST_PROXY;
  delete process.env.TRUST_PROXY;
  // The self-healing fields warn on purpose and several tests below assert that
  // they do. Capturing rather than silencing keeps the output readable AND makes
  // the loudness itself testable: a heal nobody can see is the bug.
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (prevTrustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = prevTrustProxy;
  await tmp?.cleanup();
  tmp = null;
});

interface Booted {
  app: Express;
  token: string;
  settings: SettingsModule;
  ratelimit: RateLimitModule;
}

/**
 * Build an isolated world: a throwaway DATA_DIR, an optional seeded settings.json,
 * a fresh module graph, the real settings router, and a real owner token.
 *
 * The ratelimit middleware is imported from the SAME graph and after the settings
 * module, which is the point of the helper. `loginRateLimit` is constructed at
 * module scope and resolves its bounds through `peekSettings()`, so it has to be
 * looking at the same cache the router writes for "no restart needed" to be a
 * meaningful claim rather than a coincidence of two separate caches.
 */
async function boot(seed?: Record<string, unknown>): Promise<Booted> {
  resetSettingsCache();
  tmp = await makeTmpDataDir();
  if (seed) await writeSettings(tmp.dataDir, seed);

  const settings = await import('../services/settings.js');
  const { settingsRouter } = await import('../routes/settings.js');
  const { errorHandler } = await import('../middleware/error.js');
  const { issueToken } = await import('../services/auth.js');
  const ratelimit = await import('../middleware/ratelimit.js');

  const app = makeTestApp();
  app.use('/api/settings', settingsRouter);
  app.use(errorHandler);

  // Warms the settings cache as a side effect, which is what any heal a seed is
  // testing runs during, and what `peekSettings()` needs before the limiters can
  // read anything but their fallback.
  const token = await issueToken();
  return { app, token, settings, ratelimit };
}

function get(b: Booted) {
  return request(b.app).get('/api/settings').set('Authorization', `Bearer ${b.token}`);
}

function put(b: Booted, body: Record<string, unknown>) {
  return request(b.app).put('/api/settings').set('Authorization', `Bearer ${b.token}`).send(body);
}

/** The settings.json as it actually sits on disk. The cache is not the point. */
async function readStoredFile(): Promise<Settings> {
  if (!tmp) throw new Error('boot() was not called');
  const raw = await fs.readFile(path.join(tmp.dataDir, 'settings.json'), 'utf8');
  return JSON.parse(raw) as Settings;
}

/** ---- Limiter harness (mirrors ratelimit.test.ts) --------------------------- */

const SOCKET_IP = '198.51.100.7';

/** A Request stand-in carrying only the field `clientIp` reads under TRUST_PROXY unset. */
function fakeReq(socketIp: string = SOCKET_IP): Request {
  return { socket: { remoteAddress: socketIp } } as unknown as Request;
}

interface Captured {
  statusCode: number | null;
  body: unknown;
  headers: Record<string, string>;
}

interface FakeRes {
  setHeader(name: string, value: string | number): FakeRes;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
}

function fakeRes(): { res: Response; captured: Captured } {
  const captured: Captured = { statusCode: null, body: undefined, headers: {} };
  const res: FakeRes = {
    setHeader(name, value) {
      captured.headers[name.toLowerCase()] = String(value);
      return res;
    },
    status(code) {
      captured.statusCode = code;
      return res;
    },
    json(payload) {
      captured.body = payload;
      return res;
    },
  };
  return { res: res as unknown as Response, captured };
}

interface RunResult {
  allowed: boolean;
  captured: Captured;
}

/** Drive a limiter middleware once. The handler is synchronous by construction. */
function run(handler: RequestHandler, req: Request = fakeReq()): RunResult {
  const { res, captured } = fakeRes();
  let allowed = false;
  handler(req, res, () => {
    allowed = true;
  });
  return { allowed, captured };
}

/**
 * A movable Date.now.
 *
 * Started from the real clock rather than a fixed epoch, because the limiter
 * stores are constructed during boot() with the real Date.now and record their
 * first sweep timestamp then. Jumping backwards afterwards would leave the store
 * measuring against a future `lastSweep`, which is not a state the running server
 * can ever be in.
 */
function useClock() {
  let current = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => current);
  return {
    advance(ms: number): void {
      current += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. The defaults did not move
// ---------------------------------------------------------------------------

describe('auth.rateLimit defaults', () => {
  it('is exactly the pair that used to be hardcoded', async () => {
    // The safety argument for making this configurable at all rests entirely on
    // "no existing deployment changes behaviour". These four numbers are that
    // claim: 10/15min was LOGIN_MAX_ATTEMPTS/LOGIN_WINDOW_MS in
    // middleware/ratelimit.ts, 25/15min was the literal pair in routes/auth.ts.
    const b = await boot();
    const stored = await readStoredFile();
    expect(stored.auth.rateLimit).toEqual(SHIPPED);
    expect(b.ratelimit.loginRateLimitSettings()).toEqual(SHIPPED);
  });

  it('fills the block in for a settings.json written before it existed', async () => {
    // Every file on every existing install is in this shape: an `auth` block with
    // the three credential fields and no `rateLimit` key at all. An absent block
    // must read as the shipped numbers, not as zero.
    await boot({ auth: { userPasswordHash: '', passwordHash: '', jwtSecret: 'seeded-secret' } });
    const stored = await readStoredFile();
    expect(stored.auth.rateLimit).toEqual(SHIPPED);
    // And the migration did not cost the operator their signing key on the way.
    expect(stored.auth.jwtSecret).toBe('seeded-secret');
  });

  it('still allows 10 attempts and refuses the 11th out of the box', async () => {
    // The end-to-end version of the same claim: not just that the numbers are
    // stored, but that the limiter in front of POST /auth/login behaves the way
    // the previous build's literals made it behave.
    const b = await boot();
    useClock();
    for (let i = 0; i < SHIPPED.loginMaxAttempts; i++) {
      expect(run(b.ratelimit.loginRateLimit).allowed, `attempt ${i}`).toBe(true);
    }
    const refused = run(b.ratelimit.loginRateLimit);
    expect(refused.allowed).toBe(false);
    expect(refused.captured.statusCode).toBe(429);
    // 15 minutes, from the configured window rather than from a literal.
    expect(refused.captured.headers['retry-after']).toBe(String(SHIPPED.loginWindowSec));
  });

  it('falls back to the shipped numbers before the settings file has been read', async () => {
    // peekSettings() returns null until the first load resolves. A login arriving
    // in that window (server/src/index.ts loads during boot, so it is milliseconds
    // wide) must be throttled at the default rather than at nothing.
    resetSettingsCache();
    tmp = await makeTmpDataDir();
    const settings = await import('../services/settings.js');
    const ratelimit = await import('../middleware/ratelimit.js');
    expect(settings.peekSettings()).toBeNull();
    expect(ratelimit.loginRateLimitSettings()).toEqual(SHIPPED);
  });
});

// ---------------------------------------------------------------------------
// 2. Below the floor is refused, never healed silently
// ---------------------------------------------------------------------------

describe('the hard floors, over HTTP', () => {
  /**
   * Zero is the value this whole guard exists for, so it leads the list. It does
   * not mean "unlimited": `hits.length >= 0` is true for an empty bucket, so the
   * login endpoint 429s the first request and every one after it, forever.
   * Negative is the same thing. 1.5 is not a lockout but is unpredictable at the
   * boundary, and NaN would make every window comparison false so the limiter
   * would stop firing while still looking installed.
   */
  const BAD_ATTEMPTS = [0, -1, 2, 1.5, Number.NaN, 1_000_001];
  const BAD_WINDOWS = [0, -1, 0.5, Number.NaN, 86_401];

  it('refuses an attempt count below the floor and stores nothing', async () => {
    const b = await boot();
    for (const bad of BAD_ATTEMPTS) {
      const res = await put(b, { auth: { rateLimit: { loginMaxAttempts: bad } } });
      expect(res.status, String(bad)).toBe(400);
      expect((res.body as ErrorBody).error).toContain('auth.rateLimit.loginMaxAttempts');
      // The floor is named in the message: an operator who just locked themselves
      // out of the settings page would have no other way to learn it.
      expect((res.body as ErrorBody).error).toContain('3');
    }
    // Not clamped to the floor, not coerced to anything: untouched.
    expect((await readStoredFile()).auth.rateLimit).toEqual(SHIPPED);
  });

  it('refuses a failure count below the floor and stores nothing', async () => {
    // Layer 2 already refused `max: 0` at construction, but `max: 1` is the
    // subtler lockout: one mistyped password locks the owner out for the whole
    // window, and the only thing that clears the counter is a SUCCESS, which is
    // precisely what they can no longer produce.
    const b = await boot();
    for (const bad of [0, 1, 2, -5]) {
      const res = await put(b, { auth: { rateLimit: { loginFailureMaxAttempts: bad } } });
      expect(res.status, String(bad)).toBe(400);
      expect((res.body as ErrorBody).error).toContain('auth.rateLimit.loginFailureMaxAttempts');
    }
    expect((await readStoredFile()).auth.rateLimit).toEqual(SHIPPED);
  });

  it('refuses a window outside its bounds and stores nothing', async () => {
    const b = await boot();
    for (const field of ['loginWindowSec', 'loginFailureWindowSec'] as const) {
      for (const bad of BAD_WINDOWS) {
        const res = await put(b, { auth: { rateLimit: { [field]: bad } } });
        expect(res.status, `${field}=${String(bad)}`).toBe(400);
        expect((res.body as ErrorBody).error).toContain(`auth.rateLimit.${field}`);
      }
    }
    expect((await readStoredFile()).auth.rateLimit).toEqual(SHIPPED);
  });

  it('rejects the whole request when any one field is bad, leaving the good ones unwritten', async () => {
    // All-or-nothing on purpose. A partial apply would store the loosened window
    // and drop the tightened cap, which is the half of the pair the operator
    // cared about, and answer 400 as if nothing had happened.
    const b = await boot();
    const res = await put(b, {
      auth: { rateLimit: { loginWindowSec: 60, loginMaxAttempts: 0 } },
    }).expect(400);
    expect((res.body as ErrorBody).error).toContain('loginMaxAttempts');
    expect((await readStoredFile()).auth.rateLimit).toEqual(SHIPPED);
  });

  it('rejects a rateLimit that is not an object', async () => {
    const b = await boot();
    for (const bad of [42, 'tight', [], null]) {
      const res = await put(b, { auth: { rateLimit: bad } });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect((res.body as ErrorBody).error).toContain('auth.rateLimit');
    }
    expect((await readStoredFile()).auth.rateLimit).toEqual(SHIPPED);
  });

  it('accepts the floor and the ceiling themselves, where the pair allows it', async () => {
    // The bounds are inclusive on both ends. An off-by-one here would be
    // invisible until an operator tried the exact value the error told them to
    // use. The window ceiling is paired with an attempt count that satisfies the
    // joint rule, because the ceiling on its own no longer says whether a
    // configuration is legal: see the pair test below.
    const b = await boot();
    await put(b, {
      auth: {
        rateLimit: {
          loginMaxAttempts: 3,
          loginFailureMaxAttempts: 1_000_000,
          loginWindowSec: 1,
          loginFailureWindowSec: 3_600,
        },
      },
    }).expect(200);
    expect((await readStoredFile()).auth.rateLimit).toEqual({
      loginMaxAttempts: 3,
      loginFailureMaxAttempts: 1_000_000,
      loginWindowSec: 1,
      loginFailureWindowSec: 3_600,
    });
  });

  /*
   * The pair, which is the check the per-field bounds could not make.
   *
   * Both of these passed every individual bound and were reproduced as real
   * lockouts by execution before the joint rule existed:
   *
   *  - Layer 2 at max window / min attempts: that layer is keyed `() => 'owner'`
   *    and runs BEFORE the credential check, so three unauthenticated wrong
   *    passwords locked the owner out for the whole window, recovery password
   *    included, renewable by a stranger for three requests per window.
   *  - Layer 1 at max window / min attempts: that layer charges every attempt
   *    including successful ones, and under the shipped trust-proxy default it is
   *    one bucket for the instance, so ordinary sign-ins exhausted it.
   */
  it('refuses a long window paired with a low attempt count, on both layers', async () => {
    const b = await boot();
    for (const field of ['loginMaxAttempts', 'loginFailureMaxAttempts'] as const) {
      const windowField =
        field === 'loginMaxAttempts' ? 'loginWindowSec' : 'loginFailureWindowSec';
      const res = await put(b, {
        auth: { rateLimit: { [windowField]: 3_600, [field]: 3 } },
      }).expect(400);
      // The message has to name the fix, because "invalid" on a security
      // parameter reads as a bug in the form rather than a deliberate guard.
      expect(res.body?.error ?? res.text).toMatch(/lock|throttl/i);
    }
    // Nothing was persisted by either rejected request.
    expect((await readStoredFile()).auth.rateLimit).toEqual({
      loginWindowSec: 900,
      loginMaxAttempts: 10,
      loginFailureWindowSec: 900,
      loginFailureMaxAttempts: 25,
    });
  });

  it('accepts the same long window once the attempt count scales with it', async () => {
    const b = await boot();
    // 3600s needs 12 attempts at one per 300s. The window the operator asked for
    // is preserved; only the count moves.
    await put(b, {
      auth: { rateLimit: { loginWindowSec: 3_600, loginMaxAttempts: 12 } },
    }).expect(200);
    expect((await readStoredFile()).auth.rateLimit.loginWindowSec).toBe(3_600);
    expect((await readStoredFile()).auth.rateLimit.loginMaxAttempts).toBe(12);
  });

  it('heals a hand-edited lockout pair by raising the count, not shortening the window', async () => {
    // The file path heals rather than refusing, because there is nobody to tell.
    // Raising the count is the safe direction: shortening the window would give
    // an attacker a shorter memory than the operator configured, which is a
    // security change made on their behalf without saying so.
    const b = await boot({
      auth: { rateLimit: { loginWindowSec: 3_600, loginMaxAttempts: 3 } },
    });
    const loaded = (await b.settings.getSettings()).auth.rateLimit;
    expect(loaded.loginWindowSec).toBe(3_600);
    expect(loaded.loginMaxAttempts).toBe(12);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/lockout|Raising it/i));
  });

  it('survives a rateLimit that is not an object, without destroying the file', async () => {
    /*
     * The regression that made this whole feature dangerous. `.default({})` fires
     * on undefined and nothing else, so a non-object failed the parse, which
     * propagated to SettingsSchema.parse and landed in loadSettingsImpl's bare
     * catch: cache = defaults(), persist(). That rotated jwtSecret, cleared BOTH
     * password hashes so the instance fell back to accepting 123456, and
     * destroyed git.token and every API key hash.
     *
     * The path there is the documented one: the lockout warning tells operators
     * to hand-edit this file, and a hand edit is exactly where `"rateLimit": 10`
     * gets typed instead of `"rateLimit": {"loginMaxAttempts": 10}`.
     */
    for (const bad of [null, 10, 'fast', [], true]) {
      const b = await boot({
        auth: {
          rateLimit: bad as unknown as Record<string, number>,
          jwtSecret: 'SECRET-THAT-MUST-SURVIVE',
          userPasswordHash: 'USERHASH',
          passwordHash: 'RECOVERYHASH',
        },
      });
      const loaded = await b.settings.getSettings();
      expect(loaded.auth.jwtSecret, `jwtSecret survives rateLimit=${JSON.stringify(bad)}`).toBe(
        'SECRET-THAT-MUST-SURVIVE',
      );
      expect(loaded.auth.userPasswordHash).toBe('USERHASH');
      expect(loaded.auth.passwordHash).toBe('RECOVERYHASH');
      // And the limits fell back to the shipped values rather than to nothing.
      expect(loaded.auth.rateLimit.loginMaxAttempts).toBe(10);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The PUT allowlist, and what it must never widen into
// ---------------------------------------------------------------------------

describe('the auth block in the PUT allowlist', () => {
  it('writes auth.rateLimit and answers with the new value', async () => {
    // The block being in the if-chain at all is the thing under test. A settings
    // block missing from it is silently unwritable AND still answers 200, which
    // is the worst failure mode that endpoint has.
    const b = await boot();
    const res = await put(b, {
      auth: { rateLimit: { loginMaxAttempts: 50, loginWindowSec: 300 } },
    }).expect(200);

    const stored = await readStoredFile();
    expect(stored.auth.rateLimit.loginMaxAttempts).toBe(50);
    expect(stored.auth.rateLimit.loginWindowSec).toBe(300);
    // Fields the patch did not name keep their stored values rather than being
    // reset to the schema defaults by a whole-object assign.
    expect(stored.auth.rateLimit.loginFailureMaxAttempts).toBe(SHIPPED.loginFailureMaxAttempts);
    const body = res.body as { auth: { rateLimit: typeof SHIPPED } };
    expect(body.auth.rateLimit.loginMaxAttempts).toBe(50);
  });

  it('never lets the credential fields ride along with a valid rateLimit', async () => {
    // The security assertion of this whole change. `auth` is now an accepted
    // top-level block, and the rest of it is jwtSecret plus both password hashes,
    // i.e. the credentials that gate this very endpoint. If the mutator ever
    // assigned onto `d.auth` instead of `d.auth.rateLimit`, one authenticated
    // settings save would become "choose the signing key and the owner password".
    const b = await boot();
    const before = await readStoredFile();

    await put(b, {
      auth: {
        jwtSecret: 'attacker-chosen-secret',
        userPasswordHash: 'attacker-chosen-hash',
        passwordHash: 'attacker-chosen-override',
        rateLimit: { loginMaxAttempts: 20 },
      },
    }).expect(200);

    const stored = await readStoredFile();
    expect(stored.auth.jwtSecret).toBe(before.auth.jwtSecret);
    expect(stored.auth.userPasswordHash).toBe(before.auth.userPasswordHash);
    expect(stored.auth.passwordHash).toBe(before.auth.passwordHash);
    // And the one writable field still landed, so this is not passing by refusing
    // the whole body.
    expect(stored.auth.rateLimit.loginMaxAttempts).toBe(20);
  });

  it('leaves an auth body with no rateLimit key alone and still answers 200', async () => {
    const b = await boot();
    const before = await readStoredFile();
    await put(b, { auth: { jwtSecret: 'nope' } }).expect(200);
    const stored = await readStoredFile();
    expect(stored.auth.jwtSecret).toBe(before.auth.jwtSecret);
    expect(stored.auth.rateLimit).toEqual(SHIPPED);
  });

  it('publishes the limits through GET while still withholding every credential', async () => {
    // redactSettings() builds the `auth` branch by ENUMERATION rather than by
    // spreading s.auth, so a field that stops at the schema renders as undefined
    // in the UI with nothing anywhere saying so. This pins both halves: the four
    // integers are published (they are measurable from outside anyway, by counting
    // attempts and reading Retry-After) and the three secrets are not.
    const b = await boot({ auth: { jwtSecret: 'the-real-signing-key', passwordHash: 'override' } });
    const res = await get(b).expect(200);
    const auth = (res.body as { auth: Record<string, unknown> }).auth;
    expect(auth.rateLimit).toEqual(SHIPPED);
    expect(auth).not.toHaveProperty('jwtSecret');
    expect(auth).not.toHaveProperty('userPasswordHash');
    expect(auth).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(res.body)).not.toContain('the-real-signing-key');
  });
});

// ---------------------------------------------------------------------------
// 4. A hand-edited file heals loudly instead of locking the instance
// ---------------------------------------------------------------------------

describe('a settings.json edited below the floor', () => {
  it('heals to the shipped value, says so, and leaves the instance reachable', async () => {
    // The file did not come through the API, so there is nobody to answer 400 to.
    // Throwing is not an option either: loadSettingsImpl treats any parse failure
    // as "file unusable" and rewrites from defaults(), which would answer a
    // mistyped number by destroying jwtSecret, both password hashes, git.token and
    // every API key hash.
    const b = await boot({
      auth: { jwtSecret: 'must-survive-the-heal', rateLimit: { loginMaxAttempts: 0 } },
    });

    const stored = await readStoredFile();
    expect(stored.auth.rateLimit.loginMaxAttempts).toBe(SHIPPED.loginMaxAttempts);
    // Loud. A heal nobody can see is the bug, not the fix: the operator asked for
    // a tighter throttle and did not get one.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('auth.rateLimit.loginMaxAttempts'),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('does not mean "unlimited"'));
    // The rest of the file is intact, which is the reason the heal is a `.catch()`
    // and not a throw.
    expect(stored.auth.jwtSecret).toBe('must-survive-the-heal');

    // The half that actually matters: somebody can still log in. A healed value
    // that was not wired through to the limiter would look correct on disk and
    // still refuse every request.
    useClock();
    expect(run(b.ratelimit.loginRateLimit).allowed).toBe(true);
    expect(b.ratelimit.loginRateLimitSettings().loginMaxAttempts).toBe(10);
  });

  it('heals a window of zero rather than wedging the limiter at construction', async () => {
    // `windowMs: 0` fails validateWindow, and validateWindow THROWS. That throw
    // happens while middleware/ratelimit.ts is being evaluated, so an unhealed
    // zero here would not be a bad limiter, it would be a server that cannot
    // start: the module graph fails to load and nothing serves at all.
    const b = await boot({ auth: { rateLimit: { loginWindowSec: 0 } } });
    expect((await readStoredFile()).auth.rateLimit.loginWindowSec).toBe(SHIPPED.loginWindowSec);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('auth.rateLimit.loginWindowSec'));
    useClock();
    expect(run(b.ratelimit.loginRateLimit).allowed).toBe(true);
  });

  it('heals each malformed field independently and keeps the good ones', async () => {
    // Per-field `.catch()` rather than one on the object, so a single bad number
    // does not silently reset the other three to the shipped defaults.
    await boot({
      auth: {
        rateLimit: {
          loginMaxAttempts: 'lots',
          loginWindowSec: 60,
          loginFailureMaxAttempts: -3,
          loginFailureWindowSec: 120,
        },
      },
    });
    const stored = await readStoredFile();
    expect(stored.auth.rateLimit).toEqual({
      loginMaxAttempts: SHIPPED.loginMaxAttempts,
      loginWindowSec: 60,
      loginFailureMaxAttempts: SHIPPED.loginFailureMaxAttempts,
      loginFailureWindowSec: 120,
    });
  });

  it('heals a rateLimit that is not an object at all', async () => {
    await boot({ auth: { rateLimit: 'tight' } });
    expect((await readStoredFile()).auth.rateLimit).toEqual(SHIPPED);
  });
});

// ---------------------------------------------------------------------------
// 5. A changed limit applies without a restart
// ---------------------------------------------------------------------------

describe('a saved limit takes effect on the next request', () => {
  it('loosens without a restart, and does not forget the attempts already made', async () => {
    // Both halves matter and they pull against each other. The bounds have to be
    // re-read per request (or the change needs a restart), while the STORE has to
    // survive (or the change hands every key a clean slate and the limiter counts
    // nothing at all, which is the tempting wrong implementation).
    const b = await boot({ auth: { rateLimit: { loginMaxAttempts: 3 } } });
    useClock();

    for (let i = 0; i < 3; i++) {
      expect(run(b.ratelimit.loginRateLimit).allowed, `attempt ${i}`).toBe(true);
    }
    expect(run(b.ratelimit.loginRateLimit).allowed).toBe(false);

    await put(b, { auth: { rateLimit: { loginMaxAttempts: 8 } } }).expect(200);

    // Immediately usable again: no restart, no re-import, same limiter object.
    // Exactly five more, because the three already recorded were NOT discarded.
    for (let i = 0; i < 5; i++) {
      expect(run(b.ratelimit.loginRateLimit).allowed, `post-change attempt ${i}`).toBe(true);
    }
    expect(run(b.ratelimit.loginRateLimit).allowed).toBe(false);
  });

  it('tightens without a restart, and locks out a key that is already over the new cap', async () => {
    const b = await boot({ auth: { rateLimit: { loginMaxAttempts: 10 } } });
    useClock();

    for (let i = 0; i < 4; i++) expect(run(b.ratelimit.loginRateLimit).allowed).toBe(true);

    await put(b, { auth: { rateLimit: { loginMaxAttempts: 3 } } }).expect(200);

    // Four recorded hits against a new cap of three. The bucket is over the cap
    // rather than being truncated to it, which only means this key refuses sooner
    // and drains as its timestamps expire.
    expect(run(b.ratelimit.loginRateLimit).allowed).toBe(false);
    // A key with no history is measured against the new cap from scratch.
    const fresh = fakeReq('198.51.100.99');
    for (let i = 0; i < 3; i++) expect(run(b.ratelimit.loginRateLimit, fresh).allowed).toBe(true);
    expect(run(b.ratelimit.loginRateLimit, fresh).allowed).toBe(false);
  });

  it('shortens the window without a restart, releasing a lockout early', async () => {
    // The window is read by the STORE, not just by the handler, so this is the
    // case that fails if createWindowStore captured its window at construction:
    // the cap would follow the setting while the cutoff stayed frozen at boot.
    // The cap is the floor itself rather than something smaller, because the
    // schema would heal anything under it back to 10 and the test would then be
    // asserting against a limit it did not configure.
    const b = await boot({ auth: { rateLimit: { loginMaxAttempts: 3, loginWindowSec: 900 } } });
    const clock = useClock();

    for (let i = 0; i < 3; i++) expect(run(b.ratelimit.loginRateLimit).allowed).toBe(true);
    expect(run(b.ratelimit.loginRateLimit).allowed).toBe(false);

    await put(b, { auth: { rateLimit: { loginWindowSec: 60 } } }).expect(200);

    // Still inside the new 60s window, so still refused: shortening releases the
    // aged-out hits, it does not amnesty the recent ones.
    clock.advance(30_000);
    expect(run(b.ratelimit.loginRateLimit).allowed).toBe(false);

    // Past the new window. Under the original 900s setting this would still be
    // locked for another fourteen minutes.
    clock.advance(31_000);
    expect(run(b.ratelimit.loginRateLimit).allowed).toBe(true);
  });

  it('reports Retry-After from the window in force now, not the one at boot', async () => {
    // A stale Retry-After is worse than no header: the client is told a time by
    // which it may retry and is refused when it does.
    const b = await boot({ auth: { rateLimit: { loginMaxAttempts: 3, loginWindowSec: 900 } } });
    useClock();

    for (let i = 0; i < 3; i++) expect(run(b.ratelimit.loginRateLimit).allowed).toBe(true);
    expect(run(b.ratelimit.loginRateLimit).captured.headers['retry-after']).toBe('900');

    await put(b, { auth: { rateLimit: { loginWindowSec: 120 } } }).expect(200);
    const refused = run(b.ratelimit.loginRateLimit);
    expect(refused.allowed).toBe(false);
    expect(refused.captured.headers['retry-after']).toBe('120');
    expect(refused.captured.body).toMatchObject({ retryAfter: 120 });
  });
});

// ---------------------------------------------------------------------------
// 6. The same properties for Layer 2, which the login route drives by hand
// ---------------------------------------------------------------------------

describe('the identity-keyed failure limiter follows the setting too', () => {
  /** Build a Layer 2 limiter over the live setting, exactly as routes/auth.ts does. */
  async function ownerFailureLimiter(b: Booted) {
    return b.ratelimit.createFailureLimiter({
      windowMs: () => b.ratelimit.loginRateLimitSettings().loginFailureWindowSec * 1000,
      max: () => b.ratelimit.loginRateLimitSettings().loginFailureMaxAttempts,
      keyFn: () => 'owner',
    });
  }

  it('locks out at the configured failure count and reports the configured window', async () => {
    const b = await boot({
      auth: { rateLimit: { loginFailureMaxAttempts: 3, loginFailureWindowSec: 60 } },
    });
    useClock();
    const limiter = await ownerFailureLimiter(b);

    limiter.recordFailure('owner');
    limiter.recordFailure('owner');
    expect(limiter.check('owner')).toBe(true);
    limiter.recordFailure('owner');
    expect(limiter.check('owner')).toBe(false);
    expect(limiter.retryAfterSeconds('owner')).toBe(60);
  });

  it('raises the budget without a restart and keeps the failures already charged', async () => {
    const b = await boot({ auth: { rateLimit: { loginFailureMaxAttempts: 3 } } });
    useClock();
    const limiter = await ownerFailureLimiter(b);

    for (let i = 0; i < 3; i++) limiter.recordFailure('owner');
    expect(limiter.check('owner')).toBe(false);

    await put(b, { auth: { rateLimit: { loginFailureMaxAttempts: 5 } } }).expect(200);

    // Unlocked immediately, with exactly two of the five left: the three failures
    // already charged were not forgotten by the change.
    expect(limiter.check('owner')).toBe(true);
    limiter.recordFailure('owner');
    expect(limiter.check('owner')).toBe(true);
    limiter.recordFailure('owner');
    expect(limiter.check('owner')).toBe(false);
  });

  it('still clears the whole counter on a success, whatever the budget is', async () => {
    // The property that makes Layer 1's fail-closed collapse acceptable, and the
    // one an operator retuning these numbers must not be able to break: a caller
    // presenting the right credential is restored outright, so a stranger's
    // guessing can never hold the owner out.
    const b = await boot({ auth: { rateLimit: { loginFailureMaxAttempts: 3 } } });
    useClock();
    const limiter = await ownerFailureLimiter(b);

    for (let i = 0; i < 3; i++) limiter.recordFailure('owner');
    expect(limiter.check('owner')).toBe(false);
    limiter.reset('owner');
    expect(limiter.check('owner')).toBe(true);
    expect(limiter.retryAfterSeconds('owner')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. A resolver that goes bad at runtime must not close the door
// ---------------------------------------------------------------------------

describe('an unusable resolved bound falls back instead of throwing', () => {
  it('keeps enforcing the last known-good numbers and says so once', async () => {
    // Belt and braces: the schema bounds the setting and the API refuses anything
    // outside them, so this state should be unreachable. It is guarded anyway
    // because "unreachable" is a claim about code in three other files, and the
    // cost of being wrong is that an exception escapes a synchronous
    // RequestHandler mounted in front of POST /auth/login, turning every sign-in
    // into a 500. That is the same total lockout the floors exist to prevent,
    // reached through a different door.
    const b = await boot();
    useClock();
    let max = 2;
    const limiter = b.ratelimit.createRateLimiter({ windowMs: 60_000, max: () => max });

    expect(run(limiter).allowed).toBe(true);
    max = -1; // would make every request refuse, operator included
    expect(run(limiter).allowed).toBe(true);
    expect(run(limiter).allowed).toBe(false); // the construction-time 2, still enforced

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('createRateLimiter'));
    // Latched: unthrottled logging here would be a flood an unauthenticated
    // client controls, which is the cheap denial of service the store's own
    // memory bounds are written to avoid.
    const complaints = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('[ratelimit]'),
    );
    expect(complaints).toHaveLength(1);
  });

  it('still throws at construction, so a limiter that is broken from the start is loud', async () => {
    // The startup crash is the good failure: it names the value and happens
    // before anything is serving. Only a bound that goes bad AFTER construction
    // is healed.
    const b = await boot();
    expect(() => b.ratelimit.createRateLimiter({ windowMs: () => 0, max: 10 })).toThrow(TypeError);
    expect(() => b.ratelimit.createRateLimiter({ windowMs: 1000, max: () => -1 })).toThrow(
      TypeError,
    );
    expect(() =>
      b.ratelimit.createFailureLimiter({ windowMs: 1000, max: () => 0 }),
    ).toThrow(TypeError);
  });
});
