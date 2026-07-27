import type { Request, Response, NextFunction } from 'express';
import { authenticateKey, type Scope } from '../services/apikeys.js';
import { createRateLimiter } from './ratelimit.js';
import { getSettings } from '../services/settings.js';
import type { ApiKeyRecord } from '../services/settings.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKey?: ApiKeyRecord;
    }
  }
}

// Simple in-memory sliding-window rate limiter, keyed per API key id.
const hits = new Map<string, number[]>();

/**
 * Throttle for FAILED authentication, keyed by client address.
 *
 * WHAT THIS CLOSES. The per-key limiter below can only run once a key has been
 * recognised, so before this existed a request with an invalid or absent key was
 * 401'd on a path that consulted no limiter at all: unauthenticated callers were
 * the only ones on the whole API not throttled, and /api/v1 did not behave the
 * way docs/AGENT_API.md describes. What it bounds is the rate at which one
 * client address can drive the rejection path: the 401 responses it generates,
 * the log volume, and the retry storm a misconfigured agent produces. Key
 * entropy (192 bits) makes guessing hopeless, so this was never about brute
 * force.
 *
 * WHAT IT DOES NOT CLOSE, stated plainly because an earlier version of this
 * comment claimed otherwise. It does not eliminate the unauthenticated work a
 * rejected request costs us, because the limiter runs AFTER authenticateKey():
 * that is the only point at which we know the attempt failed, and running it
 * first would spend a valid agent's budget on its successful calls and
 * eventually 429 a client that never did anything wrong. The work in question is
 * one sha256 over the presented key plus a read of the in-memory settings cache,
 * which is not a meaningful sink. A pre-authentication ceiling charged to every
 * /api/v1 request was considered and rejected: to bound that work it would have
 * to sit near the legitimate request rate, and any ceiling low enough to matter
 * is low enough to lock out real agents sharing one address behind a proxy,
 * while a ceiling high enough to be safe bounds nothing an attacker cares about.
 * A request presenting no credential at all is the one case that is free to
 * detect, and it is short-circuited at the call site below.
 *
 * Only failures are charged, and the shared factory does not record a request it
 * rejects, so a client that keeps hammering cannot extend its own lockout. The
 * budget is per client address (the factory's default key rule: see
 * middleware/ratelimit.ts, which believes a forwarded address only when the TCP
 * peer is on a network the public internet cannot route to, and otherwise keys
 * on the unforgeable socket address). The default rule is used deliberately
 * rather than a custom keyFn: keying on the presented API key would let an
 * attacker mint a fresh budget per guess, which is exactly the property being
 * closed.
 *
 * The window is generous on purpose. A misconfigured agent retrying with a stale
 * key should get 429 instead of 401 (that is the point), but a whole NAT, or a
 * whole reverse-proxied deployment whose proxy sits on a public address, can
 * collapse onto one address here, so the limit has to sit well above what a
 * handful of legitimately broken clients would produce. The cost of being wrong
 * is bounded either way: only requests that were already going to be rejected
 * ever see the 429.
 */
const failedAuthRateLimit = createRateLimiter({
  windowMs: 60_000,
  max: 20,
  message: 'Too many failed API key attempts. Try again later.',
});

function rateOk(keyId: string, perMin: number): boolean {
  // Clamp the configured budget before it is used as a threshold.
  //
  // `settings.api.rateLimitPerMin` is schema'd as a bare number and the settings
  // PUT handler accepts anything that passes `typeof === 'number'`, so `0`, a
  // negative value, a fractional one or NaN all reach here. Each of them breaks
  // this comparison in the same silent direction: `arr.length >= 0` is true on
  // the very first request and `>= NaN` is false forever, so a single bad value
  // either 429s every valid agent key or disables the limiter outright. Neither
  // failure is visible to the operator who typed it. A limit is a security
  // parameter, so it gets a floor of 1 rather than being trusted.
  const limit = Number.isFinite(perMin) ? Math.max(1, Math.floor(perMin)) : 1;
  const now = Date.now();
  const windowStart = now - 60_000;
  const arr = (hits.get(keyId) ?? []).filter((t) => t > windowStart);
  if (arr.length >= limit) {
    hits.set(keyId, arr);
    return false;
  }
  arr.push(now);
  hits.set(keyId, arr);
  return true;
}

function extractKey(req: Request): string {
  const xkey = req.headers['x-api-key'];
  if (typeof xkey === 'string' && xkey) return xkey;
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return '';
}

/** Guard for /api/v1 agent routes; optionally enforce a required scope. */
export function requireApiKey(scope?: Scope) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const raw = extractKey(req);
    // A request carrying no credential at all is known to have failed before any
    // work is done for it, so it never reaches the hash or the settings read.
    // authenticateKey() would also return null for an empty string, but relying
    // on that puts the only free rejection in the tree behind a call into
    // another module whose first line could change.
    const record = raw ? await authenticateKey(raw) : null;
    if (!record) {
      // Charge the failure to this client's address budget and let the limiter
      // answer if the budget is spent. It has to run AFTER authenticateKey, since
      // only now do we know this attempt failed: running it first would spend a
      // valid agent's budget on its successful calls and eventually 429 a client
      // that never did anything wrong.
      failedAuthRateLimit(req, res, () => {
        res.status(401).json({ error: 'Invalid or missing API key' });
      });
      return;
    }
    const s = await getSettings();
    if (!rateOk(record.id, s.api.rateLimitPerMin)) {
      res.status(429).json({ error: 'Rate limit exceeded' });
      return;
    }
    if (scope && !record.scopes.includes(scope)) {
      res.status(403).json({ error: `Missing scope: ${scope}` });
      return;
    }
    req.apiKey = record;
    // lightweight audit log (no secrets)
    console.log(`[api] ${record.name} ${req.method} ${req.path}`);
    next();
  };
}
