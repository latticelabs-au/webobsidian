/**
 * Regression tests for the two throttling layers and, above all, for the rule
 * that decides which address a bucket is keyed on.
 *
 * The keying rule has regressed twice (see the long note on `ThrottleKeySource`
 * in the module under test), and both regressions reopened the same bypass:
 * an attacker who can reach the port directly mints a fresh bucket per request
 * by rotating `X-Forwarded-For`, so the login limiter never fires. The rule is
 * two-valued and fails closed:
 *
 *   Trust a forwarded address only when Express's own resolution is
 *   ADDRESS-attested, which is only the subnet/preset list form of `trust proxy`.
 *   Under a hop count, bare `true`, or `false`, key on the TCP socket address.
 *
 * WHY EVERY TEST RE-IMPORTS THE MODULE. `THROTTLE_KEY_SOURCE` is computed once,
 * at module-evaluation time, from `config.trustProxy`, which is itself read from
 * process.env when `config.ts` is evaluated. Neither value can be changed after
 * the fact, so each case has to set TRUST_PROXY and then bring up a fresh module
 * registry. loadRatelimit() does exactly that.
 *
 * Time is driven by a Date.now stub rather than by real waiting. The stores are
 * sliding windows over Date.now(), with no timers of their own (deliberately: a
 * setInterval would hold the event loop open), so a stub is both faithful and
 * the only way to assert what happens fifteen minutes later.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, RequestHandler, Response } from 'express';
import request from 'supertest';
import { makeTestApp } from './helpers.js';

/** ---- Harness -------------------------------------------------------------- */

/**
 * Re-evaluate config.ts and ratelimit.ts with the given TRUST_PROXY value.
 * `undefined` means the variable is absent, which is the SHIPPED DEFAULT and
 * therefore the configuration most of these tests care about.
 */
async function loadRatelimit(trustProxy: string | undefined) {
  vi.resetModules();
  if (trustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = trustProxy;
  return import('../middleware/ratelimit.js');
}

let savedTrustProxy: string | undefined;

beforeEach(() => {
  savedTrustProxy = process.env.TRUST_PROXY;
});

afterEach(() => {
  if (savedTrustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = savedTrustProxy;
  vi.restoreAllMocks();
});

/**
 * A Request stand-in carrying only the two fields `clientIp` reads: the TCP peer
 * address and Express's resolved `req.ip`. Constructing a real Request means
 * booting a server, which the supertest block below does for the cases where
 * Express's own resolution is the thing under test; for the rule itself a stub is
 * clearer, because it can express "Express resolved a forwarded address" without
 * depending on proxy-addr's behaviour.
 *
 * The cast is confined to this one function so nothing else in the file needs it.
 */
function fakeReq(socketIp: string | undefined, ip?: string): Request {
  return { socket: { remoteAddress: socketIp }, ip } as unknown as Request;
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

/** Minimal Response stand-in that records what the limiter wrote to it. */
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
  /** True when the limiter called next(), i.e. the request was allowed through. */
  allowed: boolean;
  captured: Captured;
}

/** Drive a limiter middleware once. The handler is synchronous by construction. */
function run(handler: RequestHandler, req: Request): RunResult {
  const { res, captured } = fakeRes();
  let allowed = false;
  handler(req, res, () => {
    allowed = true;
  });
  return { allowed, captured };
}

/** A movable Date.now, for asserting what a sliding window does over time. */
function useClock(start = 1_700_000_000_000) {
  let current = start;
  vi.spyOn(Date, 'now').mockImplementation(() => current);
  return {
    advance(ms: number): void {
      current += ms;
    },
  };
}

/** ---- normalizeIp ---------------------------------------------------------- */

describe('normalizeIp', () => {
  it('collapses IPv4-mapped IPv6 onto the plain IPv4 form', async () => {
    const { normalizeIp } = await loadRatelimit(undefined);
    // On a dual-stack listener the same client shows up in either form depending
    // on how it connected. Without this, one client holds two budgets.
    expect(normalizeIp('::ffff:198.51.100.7')).toBe('198.51.100.7');
    expect(normalizeIp('::FFFF:198.51.100.7')).toBe('198.51.100.7');
  });

  it('leaves every other form untouched', async () => {
    const { normalizeIp } = await loadRatelimit(undefined);
    expect(normalizeIp('198.51.100.7')).toBe('198.51.100.7');
    expect(normalizeIp('::1')).toBe('::1');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeIp('unknown')).toBe('unknown');
    // Not the mapped form, so it must not be rewritten into something shorter
    // that could collide with a real address.
    expect(normalizeIp('::ffff:198.51.100.7.8')).toBe('::ffff:198.51.100.7.8');
    expect(normalizeIp('::ffff:198.51.100.7:9')).toBe('::ffff:198.51.100.7:9');
  });
});

/** ---- The keying rule ------------------------------------------------------ */

interface TrustCase {
  /** TRUST_PROXY as the operator sets it, or undefined for "not set". */
  env: string | undefined;
  /** Which address the limiters must key on under that setting. */
  source: 'socket' | 'req-ip';
  why: string;
}

const SOCKET_IP = '198.51.100.7';
const FORWARDED_IP = '203.0.113.9';

/**
 * The full space of TRUST_PROXY forms, with the answer for each.
 *
 * `req-ip` appears for exactly one shape: a subnet/preset list. That is the only
 * form under which proxy-addr tests the ADDRESS of each hop, so it is the only
 * form whose `req.ip` a directly connected attacker cannot write.
 */
const TRUST_CASES: TrustCase[] = [
  {
    env: undefined,
    source: 'socket',
    why: 'unset means bare true, so req.ip is the leftmost, fully client-written XFF entry',
  },
  { env: 'true', source: 'socket', why: 'bare true trusts every hop' },
  { env: 'on', source: 'socket', why: 'alias for bare true' },
  { env: 'false', source: 'socket', why: 'no proxy, so only the socket address exists' },
  { env: 'off', source: 'socket', why: 'alias for false' },
  { env: '0', source: 'socket', why: 'parsed as false, not as a zero hop count' },
  {
    env: '1',
    source: 'socket',
    why: 'a hop count counts, it never checks who the peer is (the F-03 regression)',
  },
  { env: '3', source: 'socket', why: 'still a hop count' },
  { env: 'loopback', source: 'req-ip', why: 'preset: proxy-addr tests each hop address' },
  { env: '10.0.0.0/8', source: 'req-ip', why: 'subnet: address-attested' },
  { env: '172.18.0.0/16', source: 'req-ip', why: 'the usual docker bridge subnet' },
  { env: 'loopback, 10.0.0.0/8', source: 'req-ip', why: 'a list is still address-attested' },
  {
    env: '0.0.0.0/0',
    source: 'socket',
    why: 'a /0 prefix matches everything: bare true wearing a subnet costume',
  },
  { env: '::/0', source: 'socket', why: 'the IPv6 spelling of the same thing' },
  { env: 'loopback,0.0.0.0/0', source: 'socket', why: 'one /0 entry demotes the whole list' },
  { env: ' , ', source: 'socket', why: 'a list with no usable entries attests nothing' },
  { env: '   ', source: 'socket', why: 'whitespace trims to empty, which means bare true' },
];

describe('clientIp: a forwarded address is trusted only under the subnet form', () => {
  it.each(TRUST_CASES)('TRUST_PROXY=$env keys on $source ($why)', async (c) => {
    const { clientIp } = await loadRatelimit(c.env);
    const req = fakeReq(SOCKET_IP, FORWARDED_IP);
    expect(clientIp(req)).toBe(c.source === 'socket' ? SOCKET_IP : FORWARDED_IP);
  });

  it('does not treat a private TCP peer as evidence of a proxy', async () => {
    // The second historical regression, and the more subtle one: "a private peer
    // may speak for its client, so believe the rightmost X-Forwarded-For entry".
    // That is false for any layer-4 forwarder or SNAT hop, all of which present a
    // private peer address and append NO header, leaving the header entirely
    // client-written. Under the shipped default it handed Docker Desktop's port
    // proxy, `ssh -R`, `kubectl port-forward` and any LAN-adjacent attacker
    // unlimited bucket minting with no misconfiguration required.
    const privatePeers = ['127.0.0.1', '::1', '10.0.0.5', '172.17.0.1', '192.168.1.20'];
    for (const env of [undefined, 'true', '1', 'false']) {
      const { clientIp } = await loadRatelimit(env);
      for (const peer of privatePeers) {
        expect(clientIp(fakeReq(peer, FORWARDED_IP)), `${String(env)} / ${peer}`).toBe(peer);
      }
    }
  });

  it('normalises whichever address it picks', async () => {
    const viaSocket = await loadRatelimit('true');
    expect(viaSocket.clientIp(fakeReq('::ffff:198.51.100.7', '::ffff:203.0.113.9'))).toBe(
      '198.51.100.7',
    );
    const viaReqIp = await loadRatelimit('loopback');
    expect(viaReqIp.clientIp(fakeReq('::ffff:198.51.100.7', '::ffff:203.0.113.9'))).toBe(
      '203.0.113.9',
    );
  });

  it('falls back to the socket address when Express resolved nothing', async () => {
    const { clientIp } = await loadRatelimit('loopback');
    expect(clientIp(fakeReq(SOCKET_IP, undefined))).toBe(SOCKET_IP);
  });

  it('keys on a constant rather than throwing when there is no socket address', async () => {
    // A destroyed socket reports undefined. Everything in that state collapses
    // into one bucket, which is the fail-closed direction.
    const { clientIp } = await loadRatelimit(undefined);
    expect(clientIp(fakeReq(undefined))).toBe('unknown');
  });
});

describe('clientIp under real Express resolution', () => {
  /**
   * Boot a real Express app whose `trust proxy` is the same value the limiter
   * module read, exactly as index.ts wires it, and report what each layer made of
   * one request.
   *
   * This is the half a stub cannot prove: that `req.ip` really is attacker-
   * controlled under the default setting, and therefore that the limiter refusing
   * to use it is load-bearing rather than paranoid.
   */
  async function probe(trustProxy: string | undefined, forwardedFor: string) {
    const { clientIp, normalizeIp } = await loadRatelimit(trustProxy);
    const { config } = await import('../config.js');
    const app = makeTestApp();
    app.set('trust proxy', config.trustProxy);
    app.get('/probe', (req, res) => {
      res.json({
        key: clientIp(req),
        expressIp: req.ip ? normalizeIp(req.ip) : null,
        socketIp: normalizeIp(req.socket.remoteAddress || 'unknown'),
      });
    });
    const response = await request(app).get('/probe').set('X-Forwarded-For', forwardedFor);
    expect(response.status).toBe(200);
    return response.body as { key: string; expressIp: string | null; socketIp: string };
  }

  it('ignores a forged X-Forwarded-For under the shipped default', async () => {
    const body = await probe(undefined, FORWARDED_IP);
    // Express DID adopt the header: that is the bypass, sitting right there in
    // req.ip on a default deployment.
    expect(body.expressIp).toBe(FORWARDED_IP);
    // The limiter did not.
    expect(body.key).toBe(body.socketIp);
    expect(body.key).not.toBe(FORWARDED_IP);
  });

  it('ignores a forged X-Forwarded-For under a hop count', async () => {
    const body = await probe('1', FORWARDED_IP);
    expect(body.expressIp).toBe(FORWARDED_IP);
    expect(body.key).toBe(body.socketIp);
    expect(body.key).not.toBe(FORWARDED_IP);
  });

  it('uses the forwarded address under the subnet form', async () => {
    // supertest connects over loopback, so the preset attests the peer and
    // Express hands back the forwarded entry.
    const body = await probe('loopback', FORWARDED_IP);
    expect(body.expressIp).toBe(FORWARDED_IP);
    expect(body.key).toBe(FORWARDED_IP);
  });

  it('takes the nearest untrusted hop, not the leftmost entry, under the subnet form', async () => {
    // [socket(loopback, trusted), 198.51.100.1(not in list -> stop)]. The
    // leftmost entry is the one a client can write freely, so a rule that took it
    // would be the bypass again with extra steps.
    const body = await probe('loopback', `${FORWARDED_IP}, 198.51.100.1`);
    expect(body.expressIp).toBe('198.51.100.1');
    expect(body.key).toBe('198.51.100.1');
    expect(body.key).not.toBe(FORWARDED_IP);
  });

  it('ignores the header when the peer is outside the trusted subnet', async () => {
    // The self-validating half of the subnet form. supertest connects over
    // loopback, which is not in 10.0.0.0/8, so proxy-addr fails the test at index
    // 0, truncates the list to the socket address and no header the client sends
    // can survive. This is what "address-attested" buys and what a hop count
    // cannot give.
    const body = await probe('10.0.0.0/8', FORWARDED_IP);
    expect(body.expressIp).toBe(body.socketIp);
    expect(body.key).toBe(body.socketIp);
    expect(body.key).not.toBe(FORWARDED_IP);
  });

  it('ignores the header entirely when trust proxy is off', async () => {
    const body = await probe('false', FORWARDED_IP);
    expect(body.expressIp).toBe(body.socketIp);
    expect(body.key).toBe(body.socketIp);
  });
});

describe('loginRateLimit: rotating X-Forwarded-For does not mint fresh buckets', () => {
  it('collapses one socket into one bucket under the shipped default', async () => {
    const { loginRateLimit } = await loadRatelimit(undefined);
    // Ten allowed per fifteen minutes. Every request below comes from the same
    // TCP peer but claims a different forwarded address, which is precisely the
    // shape of the F-03 bypass.
    for (let i = 0; i < 10; i++) {
      const attempt = run(loginRateLimit, fakeReq(SOCKET_IP, `203.0.113.${i}`));
      expect(attempt.allowed, `attempt ${i}`).toBe(true);
    }
    const refused = run(loginRateLimit, fakeReq(SOCKET_IP, '203.0.113.200'));
    expect(refused.allowed).toBe(false);
    expect(refused.captured.statusCode).toBe(429);
    expect(refused.captured.headers['retry-after']).toBeDefined();
    expect(refused.captured.body).toMatchObject({ error: 'Too many login attempts. Try again later.' });
  });

  it('still gives distinct sockets distinct buckets', async () => {
    const { loginRateLimit } = await loadRatelimit(undefined);
    for (let i = 0; i < 10; i++) {
      expect(run(loginRateLimit, fakeReq('198.51.100.7', FORWARDED_IP)).allowed).toBe(true);
    }
    expect(run(loginRateLimit, fakeReq('198.51.100.7')).allowed).toBe(false);
    // A different client is untouched by the first one's budget.
    expect(run(loginRateLimit, fakeReq('198.51.100.8')).allowed).toBe(true);
  });

  it('gives each forwarded client its own bucket under the subnet form', async () => {
    const { loginRateLimit } = await loadRatelimit('loopback');
    // Same socket, eleven distinct attested clients: nobody is throttled, which
    // is the per-client bucketing the subnet form is configured for.
    for (let i = 0; i < 11; i++) {
      expect(run(loginRateLimit, fakeReq(SOCKET_IP, `203.0.113.${i}`)).allowed).toBe(true);
    }
    // And one client can still exhaust its own budget.
    for (let i = 1; i < 10; i++) {
      expect(run(loginRateLimit, fakeReq(SOCKET_IP, '203.0.113.0')).allowed).toBe(true);
    }
    expect(run(loginRateLimit, fakeReq(SOCKET_IP, '203.0.113.0')).allowed).toBe(false);
    expect(run(loginRateLimit, fakeReq(SOCKET_IP, '203.0.113.1')).allowed).toBe(true);
  });
});

/** ---- Layer 1 option validation -------------------------------------------- */

describe('createRateLimiter option validation throws rather than clamping', () => {
  it('rejects a non-positive or non-integer windowMs', async () => {
    const { createRateLimiter } = await loadRatelimit(undefined);
    // NaN is the dangerous one: `cutoff` becomes NaN, every comparison is false,
    // every timestamp reads as expired and the limiter never fires again while
    // still looking installed.
    for (const windowMs of [0, -1, -1000, Number.NaN, 1.5, Infinity, -Infinity, 2 ** 53]) {
      expect(() => createRateLimiter({ windowMs, max: 10 }), String(windowMs)).toThrow(TypeError);
    }
  });

  it('rejects a negative or non-integer max', async () => {
    const { createRateLimiter } = await loadRatelimit(undefined);
    // max: -1 makes `hits.length >= max` true on the very first attempt, which
    // locks the surface out entirely.
    for (const max of [-1, -0.5, 1.5, Number.NaN, Infinity, -Infinity]) {
      expect(() => createRateLimiter({ windowMs: 1000, max }), String(max)).toThrow(TypeError);
    }
  });

  it('rejects a keyFn that is not a function', async () => {
    const { createRateLimiter } = await loadRatelimit(undefined);
    const notFunctions = [null, 'clientIp', 42, {}, []];
    for (const keyFn of notFunctions) {
      expect(
        // The point of the guard is a caller that ignores the types, so the cast
        // is the test rather than a convenience.
        () => createRateLimiter({ windowMs: 1000, max: 10, keyFn: keyFn as unknown as undefined }),
        String(keyFn),
      ).toThrow(TypeError);
    }
  });

  it('rejects an empty or non-string message', async () => {
    const { createRateLimiter } = await loadRatelimit(undefined);
    expect(() => createRateLimiter({ windowMs: 1000, max: 10, message: '' })).toThrow(TypeError);
    expect(() =>
      createRateLimiter({ windowMs: 1000, max: 10, message: 42 as unknown as undefined }),
    ).toThrow(TypeError);
  });

  it('accepts max: 0 as a documented kill switch and blocks everything', async () => {
    const { createRateLimiter } = await loadRatelimit(undefined);
    useClock();
    const limiter = createRateLimiter({ windowMs: 60_000, max: 0 });
    const refused = run(limiter, fakeReq(SOCKET_IP));
    expect(refused.allowed).toBe(false);
    expect(refused.captured.statusCode).toBe(429);
    // No recorded attempt exists to expire, so the answer is the whole window.
    expect(refused.captured.headers['retry-after']).toBe('60');
  });
});

/** ---- Layer 1 behaviour ---------------------------------------------------- */

describe('createRateLimiter sliding window', () => {
  it('allows max requests, refuses the next, and reports a Retry-After', async () => {
    const { createRateLimiter } = await loadRatelimit(undefined);
    const clock = useClock();
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });

    expect(run(limiter, fakeReq(SOCKET_IP)).allowed).toBe(true);
    clock.advance(10_000);
    expect(run(limiter, fakeReq(SOCKET_IP)).allowed).toBe(true);
    expect(run(limiter, fakeReq(SOCKET_IP)).allowed).toBe(true);

    const refused = run(limiter, fakeReq(SOCKET_IP));
    expect(refused.allowed).toBe(false);
    expect(refused.captured.statusCode).toBe(429);
    // 50s until the oldest of the three ages out.
    expect(refused.captured.headers['retry-after']).toBe('50');
    expect(refused.captured.body).toMatchObject({ retryAfter: 50 });
  });

  it('does not record refusals, so hammering cannot extend a lockout', async () => {
    const { createRateLimiter } = await loadRatelimit(undefined);
    const clock = useClock();
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });

    run(limiter, fakeReq(SOCKET_IP));
    run(limiter, fakeReq(SOCKET_IP));
    // Hammer for the whole window. If refusals were recorded, each one would push
    // the oldest timestamp forward and the throttle would become a permanent ban
    // (shared, under the default trust proxy, with every other client).
    for (let t = 0; t < 59_000; t += 1_000) {
      clock.advance(1_000);
      expect(run(limiter, fakeReq(SOCKET_IP)).allowed).toBe(false);
    }
    clock.advance(1_000);
    expect(run(limiter, fakeReq(SOCKET_IP)).allowed).toBe(true);
  });

  it('keeps each limiter instance on its own store', async () => {
    const { createRateLimiter } = await loadRatelimit(undefined);
    useClock();
    const login = createRateLimiter({ windowMs: 60_000, max: 1 });
    const other = createRateLimiter({ windowMs: 60_000, max: 1 });

    expect(run(login, fakeReq(SOCKET_IP)).allowed).toBe(true);
    expect(run(login, fakeReq(SOCKET_IP)).allowed).toBe(false);
    // Exhausting one surface must not lock a client out of an unrelated one.
    expect(run(other, fakeReq(SOCKET_IP)).allowed).toBe(true);
  });

  it('does not merge two over-long keys that share a prefix', async () => {
    const { createRateLimiter } = await loadRatelimit(undefined);
    useClock();
    // Keys are length-capped at 128 characters. Truncation ALONE would be a
    // security bug: two share ids sharing a long prefix would collapse into one
    // bucket, so an attacker could burn a victim's budget with a key it built to
    // collide. The cap appends a digest of the full key for exactly this reason.
    const prefix = 'x'.repeat(200);
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: 1,
      keyFn: (req) => `${prefix}${req.socket.remoteAddress ?? ''}`,
    });

    expect(run(limiter, fakeReq('198.51.100.7')).allowed).toBe(true);
    expect(run(limiter, fakeReq('198.51.100.7')).allowed).toBe(false);
    expect(run(limiter, fakeReq('198.51.100.8')).allowed).toBe(true);
  });
});

/** ---- Layer 2: the per-identity failure limiter ---------------------------- */

describe('createFailureLimiter', () => {
  it('validates its options, and refuses max: 0 unlike Layer 1', async () => {
    const { createFailureLimiter } = await loadRatelimit(undefined);
    // Layer 1 treats max: 0 as "disable this surface". Here it would mean "every
    // identity is locked out permanently and no success can clear it".
    expect(() => createFailureLimiter({ windowMs: 60_000, max: 0 })).toThrow(TypeError);
    expect(() => createFailureLimiter({ windowMs: 60_000, max: -1 })).toThrow(TypeError);
    expect(() => createFailureLimiter({ windowMs: 60_000, max: 1.5 })).toThrow(TypeError);
    expect(() => createFailureLimiter({ windowMs: 0, max: 5 })).toThrow(TypeError);
    expect(() => createFailureLimiter({ windowMs: Number.NaN, max: 5 })).toThrow(TypeError);
    expect(() =>
      createFailureLimiter({ windowMs: 60_000, max: 5, keyFn: 'owner' as unknown as undefined }),
    ).toThrow(TypeError);
  });

  it('charges only failures: checking never consumes budget', async () => {
    const { createFailureLimiter } = await loadRatelimit(undefined);
    useClock();
    const limiter = createFailureLimiter({ windowMs: 60_000, max: 3 });

    // This is rule 1, and it is what makes Layer 1's fail-closed collapse
    // acceptable: a caller presenting the right credential is never charged, so
    // volume alone can never throttle it.
    for (let i = 0; i < 500; i++) expect(limiter.check('owner')).toBe(true);
    expect(limiter.retryAfterSeconds('owner')).toBe(0);
  });

  it('locks an identity out after max failures and reports how long', async () => {
    const { createFailureLimiter } = await loadRatelimit(undefined);
    useClock();
    const limiter = createFailureLimiter({ windowMs: 60_000, max: 3 });

    limiter.recordFailure('owner');
    limiter.recordFailure('owner');
    expect(limiter.check('owner')).toBe(true);
    limiter.recordFailure('owner');
    expect(limiter.check('owner')).toBe(false);
    expect(limiter.retryAfterSeconds('owner')).toBe(60);
  });

  it('clears the counter on success, immediately and completely', async () => {
    const { createFailureLimiter } = await loadRatelimit(undefined);
    useClock();
    const limiter = createFailureLimiter({ windowMs: 60_000, max: 3 });

    for (let i = 0; i < 3; i++) limiter.recordFailure('owner');
    expect(limiter.check('owner')).toBe(false);

    // Rule 2: there is no state a third party can push a legitimate user into and
    // keep them in. The right credential restores the identity outright.
    limiter.reset('owner');
    expect(limiter.check('owner')).toBe(true);
    expect(limiter.retryAfterSeconds('owner')).toBe(0);

    // And the budget is genuinely full again, not merely one attempt wide.
    for (let i = 0; i < 3; i++) {
      limiter.recordFailure('owner');
      if (i < 2) expect(limiter.check('owner')).toBe(true);
    }
    expect(limiter.check('owner')).toBe(false);
  });

  it('never lets one identity lock out another', async () => {
    const { createFailureLimiter } = await loadRatelimit(undefined);
    useClock();
    const limiter = createFailureLimiter({ windowMs: 60_000, max: 3 });

    // The whole reason this layer exists. An attacker guessing at `alice` must
    // not cost `bob` anything, no matter how much noise it makes.
    for (let i = 0; i < 50; i++) limiter.recordFailure('alice');
    expect(limiter.check('alice')).toBe(false);

    expect(limiter.check('bob')).toBe(true);
    expect(limiter.retryAfterSeconds('bob')).toBe(0);
    // bob's own success clears bob's counter without releasing alice's lockout.
    limiter.recordFailure('bob');
    limiter.reset('bob');
    expect(limiter.check('bob')).toBe(true);
    expect(limiter.check('alice')).toBe(false);
  });

  it('does not record failures against an already locked identity', async () => {
    const { createFailureLimiter } = await loadRatelimit(undefined);
    const clock = useClock();
    const limiter = createFailureLimiter({ windowMs: 60_000, max: 3 });

    for (let i = 0; i < 3; i++) limiter.recordFailure('owner');
    expect(limiter.check('owner')).toBe(false);

    // Sustained attack for the whole window. Recording these would push the
    // oldest failure forward and hold the lockout open forever, turning a
    // throttle into a permanent denial of service against a named user.
    for (let t = 0; t < 59_000; t += 1_000) {
      clock.advance(1_000);
      limiter.recordFailure('owner');
      expect(limiter.check('owner')).toBe(false);
    }
    clock.advance(1_000);
    expect(limiter.check('owner')).toBe(true);
    expect(limiter.retryAfterSeconds('owner')).toBe(0);
  });

  it('slides: failures age out one at a time', async () => {
    const { createFailureLimiter } = await loadRatelimit(undefined);
    const clock = useClock();
    const limiter = createFailureLimiter({ windowMs: 60_000, max: 2 });

    limiter.recordFailure('owner');
    clock.advance(30_000);
    limiter.recordFailure('owner');
    expect(limiter.check('owner')).toBe(false);
    // 30s until the first one expires.
    expect(limiter.retryAfterSeconds('owner')).toBe(30);

    clock.advance(30_000);
    expect(limiter.check('owner')).toBe(true);
    // The second failure is still live, so one more locks it again.
    limiter.recordFailure('owner');
    expect(limiter.check('owner')).toBe(false);
  });

  it('does not merge two over-long identities that share a prefix', async () => {
    const { createFailureLimiter } = await loadRatelimit(undefined);
    useClock();
    const limiter = createFailureLimiter({ windowMs: 60_000, max: 2 });
    const prefix = 'share:'.padEnd(300, 'y');

    for (let i = 0; i < 2; i++) limiter.recordFailure(`${prefix}a`);
    expect(limiter.check(`${prefix}a`)).toBe(false);
    // Same first 128 characters, different identity: a truncating key bound would
    // hand the attacker a victim's lockout for free.
    expect(limiter.check(`${prefix}b`)).toBe(true);
  });

  it('derives the identity through keyFn, and defaults to the network key', async () => {
    const { createFailureLimiter } = await loadRatelimit(undefined);
    useClock();
    const byAccount = createFailureLimiter({
      windowMs: 60_000,
      max: 2,
      keyFn: () => 'owner',
    });
    expect(byAccount.keyFor(fakeReq(SOCKET_IP, FORWARDED_IP))).toBe('owner');

    // The default degrades to network keying, which is exactly what this layer
    // exists to stop being the only defence, hence the documented warning.
    const byNetwork = createFailureLimiter({ windowMs: 60_000, max: 2 });
    expect(byNetwork.keyFor(fakeReq(SOCKET_IP, FORWARDED_IP))).toBe(SOCKET_IP);
  });
});
