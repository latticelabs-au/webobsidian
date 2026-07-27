import { createHash } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { config } from '../config.js';

/**
 * In-memory sliding-window throttling. Single-process app (no DB), so a
 * per-limiter Map is sufficient; it resets on restart, which is fine for
 * throttling interactive abuse.
 *
 * This module ships TWO independent layers, and the split is the whole design:
 *
 *  - **Layer 1, `createRateLimiter`**, keyed on the NETWORK identity (see
 *    `clientIp`). It is deliberately fail-closed: when the deployment has not
 *    described its proxy topology precisely enough for the address to be
 *    attested, every client collapses into one bucket rather than being handed
 *    a forgeable per-client key. That is an availability cost, and on its own it
 *    would be a nasty one, because a shared bucket means anyone on the internet
 *    can burn the owner's login budget.
 *
 *  - **Layer 2, `createFailureLimiter`**, keyed on the CALLER'S IDENTITY (an
 *    account, an API key fingerprint, a share id) and charging only FAILED
 *    attempts, with a success clearing the counter. This is what makes Layer 1's
 *    fail-closed collapse acceptable: a caller who presents the right credential
 *    is never charged, so it can never be locked out by someone else's failures
 *    or by sharing a network bucket with them.
 *
 * Every limiter built here owns its **own** store. Sharing one global store
 * across surfaces would mean a client's login attempts and its (say) share-link
 * or export requests drew down the same budget, so tripping a cheap limiter
 * would lock a client out of an unrelated, more important route. Separate
 * stores also keep each limiter's key space independently bounded.
 */

/** Login guard: 10 attempts per 15 minutes. */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

/**
 * Hard cap on distinct keys tracked by a single store. A store's memory is
 * bounded by MAX_TRACKED_KEYS * (`max` timestamps + MAX_KEY_LENGTH characters),
 * because a bucket never grows past `max` (once it is full we stop recording)
 * and a key never exceeds MAX_KEY_LENGTH (see `boundKey`). The worst case is
 * therefore a few megabytes even for a generous limiter. The cap exists so that
 * a flood from many source addresses (spoofed source IPs, or an IPv6 client
 * rotating through a /64 it legitimately owns) cannot turn the store into an
 * unbounded memory leak, which would be a cheaper denial of service than the
 * one the limiter is defending against.
 */
const MAX_TRACKED_KEYS = 10_000;

/**
 * Low-water mark that a size-triggered sweep evicts down to.
 *
 * This exists purely for amortisation, and closes a real self-inflicted denial
 * of service. An early revision evicted down to exactly MAX_TRACKED_KEYS while
 * the sweep trigger fired at `size > MAX_TRACKED_KEYS`, so once an attacker
 * parked the store at the cap, EVERY subsequent accepted request rebuilt a
 * 10,000-entry array of pairs and sorted it (~133k comparisons) to delete a
 * single key. On a deliberately single-process server that is an event-loop
 * stall the attacker controls, reachable unauthenticated through /auth/login.
 * Evicting 10% below the cap means a sweep only recurs after another ~1,000
 * distinct keys arrive, so the O(n log n) cost amortises to a few comparisons
 * per request instead of a full sort per request.
 */
const EVICT_DOWN_TO_KEYS = 9_000;

/**
 * Hard cap on the length of a store key, enforced by `boundKey`.
 *
 * The memory bound above is only true if keys are bounded, and a limiter does
 * not control its own keys: `keyFn` belongs to the caller, and callers build
 * keys out of request data. `routes/shares.ts` keys its unlock limiter on
 * `${clientIp(req)}|${req.params.id}`, and that limiter is route-level
 * middleware, so it runs BEFORE the share id has been validated or even looked
 * up. A path segment is bounded only by Node's `max-http-header-size` (16 KB by
 * default), so without this cap an unauthenticated client could park 10,000
 * multi-kilobyte strings in the store (~160 MB) for a full window, and every
 * eviction sort would then run over them. The forwarded-address half of a key
 * used to be length-capped for exactly this reason while the caller-supplied
 * half was not; capping centrally here fixes the whole class instead of one
 * instance of it, and it means the contract published by `keyFn` is one this
 * module can actually honour.
 */
const MAX_KEY_LENGTH = 128;

/**
 * How much of an over-long key is kept verbatim before the digest.
 *
 * 63 + 1 separator + 64 hex characters of SHA-256 lands exactly on
 * MAX_KEY_LENGTH. Truncation ALONE would be a security bug rather than a
 * memory fix: two share ids sharing a 128-character prefix would collapse into
 * one bucket, so an attacker could exhaust a victim's budget by guessing
 * against a key it constructed to collide. Appending a digest of the FULL key
 * keeps distinct identities distinct while bounding the stored size. The
 * readable prefix is retained only so a key stays recognisable if one is ever
 * surfaced in a diagnostic; nothing depends on it.
 */
const KEY_PREFIX_KEPT = 63;

/**
 * Bound a key's length without letting distinct keys merge.
 *
 * Cheap on the common path: every key produced by `clientIp` is at most 45
 * characters, so the hash is only ever computed for a caller-supplied key that
 * is already abusive, and computing one SHA-256 over at most 16 KB is far
 * cheaper than retaining those 16 KB for the length of the window.
 */
function boundKey(key: string): string {
  if (key.length <= MAX_KEY_LENGTH) return key;
  const digest = createHash('sha256').update(key).digest('hex');
  return `${key.slice(0, KEY_PREFIX_KEPT)}#${digest}`;
}

/**
 * How a limiter derives the network identity it throttles on.
 *
 * The whole difficulty is that `req.ip` is only sometimes attested. Express
 * resolves it through proxy-addr, whose address list is
 * `[socketAddress, ...X-Forwarded-For reversed]`, truncated at the first hop
 * the `trust proxy` setting rejects; the surviving rightmost element becomes
 * `req.ip`. What "rejects" means depends entirely on the form of the setting,
 * and the three forms are NOT interchangeable:
 *
 *  - **Subnet / preset list** ('loopback', '10.0.0.0/8', ...): proxy-addr's
 *    `compile()` builds a predicate that tests the ADDRESS of each hop. A
 *    directly connected attacker fails that test at index 0, the list truncates
 *    to just its socket address, and no header it sends can survive. This form
 *    is self-validating, so `req.ip` is genuinely proxy-attested and we use it
 *    as-is. It is also the only form that resolves multi-hop topologies
 *    correctly.
 *
 *  - **Hop count** (`TRUST_PROXY=1`): the predicate is `(addr, i) => i < n`.
 *    It counts, it never checks WHO the peer is. With `n = 1` the socket
 *    address is skipped and `req.ip` becomes the rightmost X-Forwarded-For
 *    entry regardless of who opened the connection. An attacker who can reach
 *    the port directly (docker-compose publishes :8787 on 0.0.0.0, so the app
 *    is commonly reachable beside the proxy as well as through it) would mint a
 *    fresh bucket per request just by rotating that header.
 *
 *  - **Bare `true`** (the shipped default, so that `X-Forwarded-Proto` keeps
 *    driving `Secure` cookies without extra config): every hop is trusted, so
 *    `req.ip` is the LEFTMOST X-Forwarded-For entry, which is 100%
 *    client-written. Never usable for throttling.
 *
 * So the rule is exactly two-valued, and it fails CLOSED:
 *
 *   Trust a forwarded address only when Express's own resolution is
 *   address-attested, which is only the subnet/preset list form. In every other
 *   case (hop count, bare `true`, `false`) key on the TCP socket address, which
 *   cannot be forged by anyone who is not on the path.
 *
 * Two earlier revisions of this file tried to do better than that and both
 * reopened the bypass the file exists to close. The first treated "hop count
 * >= 1" as equivalent to the subnet form (security report F-03). The second
 * replaced it with "a private TCP peer may speak for its client, so believe the
 * rightmost X-Forwarded-For entry", which is false for any layer-4 forwarder or
 * SNAT hop: those present a private peer address and append NO header, leaving
 * the header entirely client-written. Under the SHIPPED DEFAULT that made
 * Docker Desktop's port proxy, `ssh -R`, `kubectl port-forward`, Kubernetes
 * SNAT and any LAN-adjacent attacker into unlimited bucket minting, with no
 * operator misconfiguration required. A private peer does not imply a proxy,
 * and there is no header-shaped evidence that distinguishes the two, so the
 * heuristic is not fixable and is gone.
 *
 * **The accepted cost, stated plainly.** Under the default `TRUST_PROXY=true`
 * behind a reverse proxy, every client shares one bucket, because the only
 * unforgeable value available is the proxy's own socket address. That is an
 * availability tradeoff, not a security hole. Layer 2 (`createFailureLimiter`)
 * exists to remove its sting: a caller that presents a valid credential is
 * never charged, so a shared network bucket cannot lock a legitimate user out.
 * To get per-client network throttling, TRUST_PROXY must name the proxy's
 * subnet or a proxy-addr preset ('loopback' when the proxy is on the same host,
 * the proxy's CIDR otherwise). A hop count is not enough, and neither is `true`.
 *
 * Read once at module load: `config` is resolved from the environment at
 * startup and is the same value `index.ts` passes to `app.set('trust proxy')`.
 */
type ThrottleKeySource =
  /** `req.ip` is address-attested by Express itself. Use it verbatim. */
  | 'req-ip'
  /** Express's resolution is unattested. Use the TCP socket address. */
  | 'socket';

const THROTTLE_KEY_SOURCE: ThrottleKeySource = (() => {
  const value = config.trustProxy;
  if (typeof value !== 'string') return 'socket';
  const entries = value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (entries.length === 0) return 'socket';
  // A '/0' prefix length matches every address, so a list containing one is
  // bare `true` wearing a subnet costume: Express would hand us the leftmost,
  // fully client-written entry. Demote it rather than letting the string form
  // act as a blanket "this is safe" signal. In practice proxy-addr rejects a
  // zero-length range at boot, so this is belt and braces against a future
  // parser that does not, and it costs one string comparison at startup.
  if (entries.some((entry) => entry.endsWith('/0'))) return 'socket';
  return 'req-ip';
})();

/**
 * Collapse IPv4-mapped IPv6 ('::ffff:1.2.3.4') onto the plain IPv4 form. On a
 * dual-stack listener the same client can appear in either form depending on
 * how it connected and on what the proxy wrote into X-Forwarded-For; without
 * this, one client could hold two independent budgets for the same address.
 *
 * Exported so that limiters keyed on a tuple normalise the client half
 * identically instead of hand-copying the rule and drifting from it.
 */
export function normalizeIp(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return mapped ? mapped[1] : ip;
}

/**
 * Default limiter key: the client's network address, per the trust rule
 * documented on `ThrottleKeySource` above.
 *
 * Exported so limiters that need a composite key (see `routes/shares.ts`, which
 * keys on client plus share id) can reuse the exact rule rather than
 * re-deriving it. A second, drifting copy of this logic is a security bug
 * waiting to happen, because the two copies would disagree about which
 * addresses are forgeable, and that has already happened once in this tree.
 */
export function clientIp(req: Request): string {
  const socketIp = normalizeIp(req.socket.remoteAddress || 'unknown');
  if (THROTTLE_KEY_SOURCE === 'socket') return socketIp;
  return req.ip ? normalizeIp(req.ip) : socketIp;
}

/** One key's state, shared by both layers. */
interface Bucket {
  /** Ascending timestamps of the RECORDED events still inside the window. */
  hits: number[];
  /**
   * Last time this key was seen at all, recorded or refused. Deliberately not
   * derived from `hits`, because refusals are never recorded there: it is the
   * tiebreaker for eviction ordering in `sweep()` and nothing else, and in
   * particular it never feeds the sliding-window arithmetic.
   */
  lastSeen: number;
}

/** Shared, immutable "this key has nothing live" answer. */
const NO_HITS: readonly number[] = Object.freeze([]);

/**
 * Drop the expired prefix of an ascending timestamp array.
 *
 * Returns the SAME array when nothing expired, so the common path allocates
 * nothing. Callers must therefore treat the result as owned by the bucket.
 */
function dropExpired(hits: number[], cutoff: number): number[] {
  let live = 0;
  while (live < hits.length && hits[live] <= cutoff) live++;
  return live === 0 ? hits : hits.slice(live);
}

/**
 * The sliding-window store, with all of the bookkeeping both layers need.
 *
 * Kept as one implementation on purpose. The eviction ordering below is a
 * security property rather than housekeeping, and it was got wrong once
 * already; two copies of it would be two chances to get it wrong again.
 */
interface WindowStore {
  /**
   * Live (unexpired) timestamps for `key`, pruning the bucket in place and
   * marking the key as active NOW.
   *
   * Calling this IS the "seen" signal, and it deliberately never CREATES a
   * bucket, so a refused attempt against an untracked key stores nothing. The
   * returned array is the one held by the bucket, so a following `record()`
   * appends to it; callers must not mutate it themselves.
   */
  live(key: string, now: number): readonly number[];
  /**
   * Append `now` to `key`'s window. Only valid immediately after a `live()`
   * call on the same key in the same tick that returned fewer than `max`
   * entries, which is what keeps a bucket from ever exceeding `max` timestamps
   * and keeps the memory bound at the top of this file true.
   */
  record(key: string, now: number): void;
  /** Forget the key entirely, releasing whatever budget it held. */
  clear(key: string): void;
  /** Amortised housekeeping. Call once per request that recorded something. */
  maybeSweep(now: number): void;
}

function createWindowStore(windowMs: number): WindowStore {
  /** key -> bucket. */
  const buckets = new Map<string, Bucket>();
  let lastSweep = Date.now();

  /**
   * Drop aged-out timestamps everywhere, then enforce the key cap.
   *
   * The pruning pass matters on its own: a key hit once per window would
   * otherwise never be released, and its array would keep accumulating stale
   * entries that the per-request path re-scans every time.
   */
  function sweep(now: number): void {
    const cutoff = now - windowMs;
    for (const [key, bucket] of buckets) {
      const live = dropExpired(bucket.hits, cutoff);
      // An empty bucket carries no lockout, so dropping it loses nothing, and
      // holding it for its `lastSeen` alone would be a leak with no benefit.
      if (live.length === 0) buckets.delete(key);
      else bucket.hits = live;
    }
    if (buckets.size <= MAX_TRACKED_KEYS) return;

    // Still over cap after pruning: evict the EMPTIEST buckets first, breaking
    // ties on least recently seen.
    //
    // Eviction is the one operation here that hands budget back, so its
    // ordering is a security property, not a housekeeping detail. An earlier
    // revision sorted purely on the last recorded timestamp and claimed that a
    // currently-throttled key is by definition the most recently active one, so
    // a junk-key flood could not evict it. That was false twice over. First,
    // refusals are deliberately not recorded, so a throttled key's last hit is
    // frozen at its final accepted request and it sorts OLDEST, i.e. it is
    // evicted first: burn the budget from address X, push MAX_TRACKED_KEYS junk
    // keys through, return to X with a clean slate. Second, and this is why
    // refreshing recency on refusal is not on its own a fix, the attacker
    // controls whether X is touched at all: it can simply stay quiet during the
    // flood and let X age out.
    //
    // Ordering by live hit count removes the incentive instead of racing it. A
    // flood key carries one hit; a key worth stealing carries `max`. To evict a
    // full bucket the attacker must first fill EVICT_DOWN_TO_KEYS other buckets
    // to `max`, which costs `max` times more recorded events than the single
    // budget it would recover, and those events were available to it anyway
    // without any eviction. `lastSeen` (refreshed by `live()`, including on the
    // refusal path) then orders within a fullness class, so among equally full
    // buckets the one under active attack is the last to go rather than the
    // first.
    const byEvictionOrder = [...buckets.entries()].sort(
      (a, b) => a[1].hits.length - b[1].hits.length || a[1].lastSeen - b[1].lastSeen,
    );
    const evictCount = buckets.size - EVICT_DOWN_TO_KEYS;
    for (let i = 0; i < evictCount; i++) buckets.delete(byEvictionOrder[i][0]);
  }

  return {
    live(key, now) {
      const bucket = buckets.get(key);
      if (!bucket) return NO_HITS;
      const hits = dropExpired(bucket.hits, now - windowMs);
      if (hits.length === 0) {
        buckets.delete(key);
        return NO_HITS;
      }
      // Write the pruned array back even when the caller is about to refuse:
      // the entry is not growing (a refusal is not recorded), but this releases
      // stale timestamps immediately instead of waiting for the next sweep.
      bucket.hits = hits;
      // Mark the key as active NOW even if the attempt is refused. Without
      // this, a key under sustained attack looks idle to sweep()'s tiebreaker
      // and sorts ahead of genuinely idle peers of the same fullness.
      // `lastSeen` is eviction bookkeeping only and never feeds the window
      // arithmetic, so refreshing it cannot extend a lockout.
      bucket.lastSeen = now;
      return hits;
    },
    record(key, now) {
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.hits.push(now);
        bucket.lastSeen = now;
      } else {
        buckets.set(key, { hits: [now], lastSeen: now });
      }
    },
    clear(key) {
      buckets.delete(key);
    },
    maybeSweep(now) {
      // No setInterval: a timer would keep the event loop alive (and would need
      // unref'ing to avoid delaying shutdown) to prune a store that only grows
      // while requests are arriving. The size trigger is safe to leave hot
      // because sweep() evicts down to EVICT_DOWN_TO_KEYS, so it cannot re-fire
      // until ~1,000 further distinct keys arrive.
      if (buckets.size > MAX_TRACKED_KEYS || now - lastSweep >= windowMs) {
        lastSweep = now;
        sweep(now);
      }
    },
  };
}

/**
 * Validate window options at construction, and throw rather than clamp.
 *
 * These are security parameters, and every invalid value fails in a silent,
 * dangerous direction: `max: -1` makes `hits.length >= max` true on the very
 * first attempt and locks the surface out entirely, while `windowMs: NaN` makes
 * `cutoff` NaN, so every comparison is false, every timestamp is treated as
 * expired and the limiter never fires again while still looking installed.
 * Silently correcting either one would hide an operator error behind a limiter
 * that no longer does its job; a startup crash naming the bad value is loud and
 * fixable. All current call sites pass literals, so this can only fire for a
 * future caller that wires a user-editable value (settings.api.rateLimitPerMin
 * is the obvious candidate) into it, which is exactly when the guard is needed.
 */
function validateWindow(label: string, windowMs: number, max: number, minMax: number): void {
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new TypeError(`${label}: windowMs must be a positive integer, got ${String(windowMs)}`);
  }
  if (!Number.isSafeInteger(max) || max < minMax) {
    throw new TypeError(`${label}: max must be an integer >= ${minMax}, got ${String(max)}`);
  }
}

export interface RateLimiterOptions {
  /** Sliding window length in milliseconds. Must be a positive integer. */
  windowMs: number;
  /** Maximum allowed requests per key per window. Must be a non-negative integer (0 blocks everything). */
  max: number;
  /**
   * Bucket key. Defaults to the network-identity rule (see `clientIp`).
   *
   * The returned string is length-bounded by `boundKey` before it reaches the
   * store, so a `keyFn` that embeds request data cannot blow the store's memory
   * bound. It must still return a string.
   */
  keyFn?: (req: Request) => string;
  /** Body of the 429 response: `{ error: message, retryAfter }`. */
  message?: string;
}

/**
 * Build a Layer 1 sliding-window rate limiter with its own private store.
 *
 * A refused request is deliberately NOT recorded. Recording refusals would make
 * a client that keeps hammering extend its own lockout indefinitely, which
 * turns a throttle into a permanent ban triggered by any client that happens to
 * share the key. That matters more here than it looks, because under the
 * default `trust proxy` every client behind a reverse proxy DOES share the key
 * (see `ThrottleKeySource`).
 */
export function createRateLimiter(opts: RateLimiterOptions): RequestHandler {
  const { windowMs, max, keyFn = clientIp, message = 'Too many requests. Try again later.' } = opts;

  // `max: 0` stays legal here as a documented kill switch for a surface.
  validateWindow('createRateLimiter', windowMs, max, 0);
  if (typeof keyFn !== 'function') {
    throw new TypeError('createRateLimiter: keyFn must be a function');
  }
  if (typeof message !== 'string' || message.length === 0) {
    throw new TypeError('createRateLimiter: message must be a non-empty string');
  }

  const store = createWindowStore(windowMs);

  return function rateLimit(req, res, next): void {
    const now = Date.now();
    const key = boundKey(keyFn(req));
    const hits = store.live(key, now);

    if (hits.length >= max) {
      // hits[0] is inside the window, so this is always >= 1 second. The
      // `?? now` covers a `max: 0` limiter (block everything), where there is
      // no recorded attempt to expire and the answer is "the whole window".
      // Note that `live()` never created a bucket in that case, so a `max: 0`
      // limiter stores nothing at all no matter how much it is hammered.
      const oldest = hits[0] ?? now;
      const retryAfter = Math.ceil((oldest + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: message, retryAfter });
      return;
    }

    store.record(key, now);
    // Amortised cleanup on the request path, and only on the path that can grow
    // the store. The refusal path above returns without sweeping because it
    // cannot add a key, so an attacker cannot use refusals to force sweeps.
    store.maybeSweep(now);

    next();
  };
}

export interface FailureLimiterOptions {
  /** Sliding window length in milliseconds. Must be a positive integer. */
  windowMs: number;
  /** Failures tolerated per identity per window. Must be an integer >= 1. */
  max: number;
  /**
   * Optional convenience mapping from a request to the identity key, used by
   * `keyFor`. Defaults to `clientIp`, which degrades this back to network
   * keying: pass a real identity (an account name, an API key fingerprint, a
   * share id) if the surface has one, because keying on the network is exactly
   * what this layer exists to stop being the only defence.
   */
  keyFn?: (req: Request) => string;
}

export interface FailureLimiter {
  /** Derive the identity key for a request via the configured `keyFn`. */
  keyFor(req: Request): string;
  /** False when this identity is currently locked out. Records nothing. */
  check(key: string): boolean;
  /** Charge one failed attempt against this identity. */
  recordFailure(key: string): void;
  /** Clear the identity's failures. Call on every SUCCESSFUL authentication. */
  reset(key: string): void;
  /** Seconds until the identity's oldest failure ages out. 0 when not locked. */
  retryAfterSeconds(key: string): number;
}

/**
 * Build a Layer 2 per-identity failure limiter.
 *
 * This is the answer to the original High finding on this file: with a
 * network-keyed limiter alone, ten bad logins from anywhere on the internet
 * lock the real owner out for the whole window, and under the shipped
 * `trust proxy` default "anywhere" includes every client behind the proxy,
 * because they all share one bucket. Counting attempts is the wrong meter for a
 * credential check, because it charges the legitimate user for the attacker's
 * traffic.
 *
 * Two rules make that impossible here:
 *
 *  1. **Only failures are charged.** A caller that presents the right
 *     credential never touches the counter, so it can never be throttled by
 *     volume, its own or anyone else's.
 *  2. **A success clears the counter.** So even an identity that had
 *     accumulated failures (a user mistyping, or an attacker guessing at that
 *     identity) is fully restored the moment the real credential arrives. There
 *     is no state a third party can push a legitimate user into and keep it in.
 *
 * The remaining property to be careful about is that failures are capped at
 * `max` rather than accumulating: once an identity is locked, further failed
 * attempts are refused WITHOUT being recorded, exactly as in Layer 1. Otherwise
 * an attacker hammering a victim's identity would keep pushing the oldest
 * failure forward and hold the lockout open forever, converting a throttle into
 * a permanent denial of service against a named user. With the cap, a lockout
 * always ends `windowMs` after the `max`-th failure even under sustained
 * attack.
 *
 * The store lives here rather than at the call site so that the key bounding,
 * the sliding window and the eviction ordering are the ones this file has
 * already reasoned about, instead of a second hand-rolled Map per surface.
 *
 * Deliberately NOT a `RequestHandler`. A credential check only knows whether it
 * failed after it has run, so the caller has to drive this explicitly:
 * `check()` before doing the work, then `reset()` or `recordFailure()` on the
 * result. Wrapping it as middleware would force the "did it fail" decision back
 * into a place that cannot make it.
 */
export function createFailureLimiter(opts: FailureLimiterOptions): FailureLimiter {
  const { windowMs, max, keyFn = clientIp } = opts;

  // `max: 0` is rejected here, unlike in Layer 1. There it is a useful kill
  // switch for a whole surface; here it would mean "every identity is locked
  // out permanently and no success can clear it", which is a footgun with no
  // legitimate use: disabling a surface is Layer 1's job.
  validateWindow('createFailureLimiter', windowMs, max, 1);
  if (typeof keyFn !== 'function') {
    throw new TypeError('createFailureLimiter: keyFn must be a function');
  }

  const store = createWindowStore(windowMs);

  return {
    keyFor(req) {
      return keyFn(req);
    },
    check(key) {
      return store.live(boundKey(key), Date.now()).length < max;
    },
    recordFailure(key) {
      const now = Date.now();
      const bounded = boundKey(key);
      const hits = store.live(bounded, now);
      // Already locked: refuse without recording, so the attacker cannot extend
      // someone else's lockout by continuing to guess. See the note above.
      if (hits.length >= max) return;
      store.record(bounded, now);
      store.maybeSweep(now);
    },
    reset(key) {
      store.clear(boundKey(key));
    },
    retryAfterSeconds(key) {
      const now = Date.now();
      const hits = store.live(boundKey(key), now);
      if (hits.length < max) return 0;
      // hits[0] is inside the window by construction, so this is always >= 1.
      return Math.ceil((hits[0] + windowMs - now) / 1000);
    },
  };
}

/**
 * Brute-force guard for `POST /auth/login`: 10 attempts per 15 minutes per
 * network key. Behaviour and response shape are unchanged from the original
 * dedicated implementation.
 *
 * This is Layer 1 only, and on its own it is coarse: under the default
 * `trust proxy` it is one bucket for the whole instance. The route should pair
 * it with a `createFailureLimiter` keyed on the account so that the owner's
 * correct password is never charged and never locked out by a stranger's
 * failures. That wiring belongs in `routes/auth.ts`, next to the
 * `authenticatePassword` call that is the only place the pass/fail outcome
 * exists.
 */
export const loginRateLimit: RequestHandler = createRateLimiter({
  windowMs: LOGIN_WINDOW_MS,
  max: LOGIN_MAX_ATTEMPTS,
  message: 'Too many login attempts. Try again later.',
});
