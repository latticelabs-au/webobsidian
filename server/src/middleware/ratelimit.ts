import { createHash } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { config } from '../config.js';
import {
  peekSettings,
  LOGIN_RATE_LIMIT_DEFAULTS,
  type LoginRateLimit,
} from '../services/settings.js';

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

/**
 * The login throttle as the operator has configured it, or the shipped defaults.
 *
 * Read fresh on EVERY resolution rather than captured once, which is what makes a
 * settings change take effect without a process restart. `peekSettings()` returns
 * the live cache and `updateSettings()` replaces that cache wholesale, so holding
 * onto the object would pin the limiter to whatever was configured at boot: a
 * setting that silently needs a restart is exactly the failure this repo keeps
 * calling out, and it is worse here than elsewhere because the symptom (the old
 * limit still applying) is indistinguishable from the new limit simply not being
 * reached yet.
 *
 * Falling back to LOGIN_RATE_LIMIT_DEFAULTS covers one real window and one
 * impossible one. The real one is a login that arrives before the first
 * `loadSettings()` has resolved, where the cache is still null: server/src/index.ts
 * loads settings during boot so this is measured in milliseconds, but "the first
 * request after a restart is unthrottled" is not a thing to leave to timing. The
 * impossible one is a cache holding an `auth.rateLimit` that is not there at all,
 * which the schema's `.default({})` rules out; the `??` costs nothing and means
 * this function has no way to return undefined.
 */
export function loginRateLimitSettings(): LoginRateLimit {
  return peekSettings()?.auth.rateLimit ?? LOGIN_RATE_LIMIT_DEFAULTS;
}

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

/**
 * Build a store whose window length is resolved per call.
 *
 * `getWindowMs` rather than a number, so that an operator changing
 * `auth.rateLimit` takes effect on the next request instead of the next restart.
 * The STORE ITSELF is built once and never rebuilt, and that distinction is the
 * whole design: the Map holds the hit history, so discarding it on a settings
 * change (or, worse, per request) would hand every key a clean slate and leave
 * the limiter counting nothing at all. Only the cutoff arithmetic moves.
 *
 * WHAT HAPPENS TO THE EXISTING BUCKETS WHEN THE WINDOW CHANGES, stated in full
 * because it is the question a reader will have and the answer is not symmetric:
 *
 *  - SHORTENED. The next `live()` on a key immediately drops every timestamp
 *    older than the new, nearer cutoff, so a key part-way through a lockout is
 *    released early: on its own next touch, or at the next `sweep()` for a key
 *    nobody touches again. The sweep cadence follows the new window too, so
 *    idle keys are reclaimed sooner rather than lingering on the old schedule.
 *  - LENGTHENED. Timestamps that were already pruned are gone: pruning is
 *    destructive (both `live()` and `sweep()` rewrite `bucket.hits`), so a longer
 *    window cannot resurrect attempts the store has forgotten. Timestamps still
 *    held are simply held longer, so a client currently mid-lockout stays locked
 *    for the remainder of the NEW window measured from its own oldest surviving
 *    hit, which can be longer than it was promised by the Retry-After it already
 *    received.
 *
 * Both directions therefore take effect from the next request onward and neither
 * invents history. That is the safe asymmetry to have: the lengthening case can
 * hold someone slightly longer than they were told, which is a throttle being a
 * throttle, while the shortening case releases immediately, which is what an
 * operator digging themselves out of a too-tight setting needs it to do.
 *
 * `record()` still cannot push a bucket past the `max` in force at the moment it
 * runs, so the memory bound at the top of this file holds. A `max` that SHRINKS
 * can leave a bucket temporarily longer than the new cap, which only makes that
 * key refuse sooner and drains as its timestamps expire.
 */
function createWindowStore(getWindowMs: () => number): WindowStore {
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
    const cutoff = now - getWindowMs();
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
      const hits = dropExpired(bucket.hits, now - getWindowMs());
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
      if (buckets.size > MAX_TRACKED_KEYS || now - lastSweep >= getWindowMs()) {
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
 * fixable. Most call sites pass literals; the login limiters now pass resolvers
 * over `settings.auth.rateLimit`, which is exactly the "user-editable value wired
 * into a limiter" case this guard was written in anticipation of, and is why
 * `createLiveWindow` below re-applies the same two predicates on every read
 * rather than trusting the one check at construction.
 */
function validateWindow(label: string, windowMs: number, max: number, minMax: number): void {
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new TypeError(`${label}: windowMs must be a positive integer, got ${String(windowMs)}`);
  }
  if (!Number.isSafeInteger(max) || max < minMax) {
    throw new TypeError(`${label}: max must be an integer >= ${minMax}, got ${String(max)}`);
  }
}

/**
 * A limiter bound: a fixed number, or a function called once per use.
 *
 * The function form is what makes a limit operator-configurable without a
 * restart. It must be cheap and synchronous, because it runs on the request path
 * inside a `RequestHandler` that cannot await; `loginRateLimitSettings()` above is
 * a Map-free property read off the settings cache.
 */
export type LimiterBound = number | (() => number);

/** The two bounds of a limiter, re-resolved and re-validated per use. */
interface LiveWindow {
  /** Window length in ms for THIS call. Always a positive safe integer. */
  windowMs(): number;
  /** Cap for THIS call. Always a safe integer >= the layer's minimum. */
  max(): number;
}

/**
 * Wrap a limiter's two bounds so they can move at runtime while keeping every
 * guarantee `validateWindow` gives a limiter built from literals.
 *
 * TWO TIERS, and the split is deliberate.
 *
 * At CONSTRUCTION the bounds are resolved once and `validateWindow` runs on the
 * result, throwing exactly as before. That preserves the loud startup crash for
 * every existing call site (all of which pass literals, so nothing about their
 * behaviour changes) and it means a resolver that is broken from the very first
 * read takes the process down at boot with a message naming the value, rather
 * than at 3am on a login attempt.
 *
 * At USE the bounds are resolved again and the SAME two predicates are re-applied
 * non-fatally, falling back to the pair validated at construction. Throwing here
 * would be the wrong answer, and this is the one place in this file where a throw
 * is worse than a heal: the exception would escape from a synchronous
 * `RequestHandler` mounted in front of `POST /auth/login`, so an unusable settings
 * value would turn every login into a 500. That is the same total lockout the
 * floors in services/settings.ts exist to prevent, arrived at through a different
 * door. A limiter that keeps enforcing the last known-good numbers is strictly
 * better than a login endpoint that answers nothing at all.
 *
 * This is belt and braces rather than the control: `auth.rateLimit` is bounded by
 * the zod schema (which heals) and by routes/settings.ts (which answers 400), so
 * a resolver reading it cannot legitimately produce a bad number. The guard is
 * here because "cannot happen" is a claim about code in three other files, and
 * the cost of being wrong about it is the login door.
 *
 * The warning latches after the first occurrence. Unthrottled logging on this
 * path would be a log flood an unauthenticated client controls, which is the
 * cheap denial of service the store's own memory bounds are written to avoid; one
 * line naming the label and the value is enough to diagnose it, and the condition
 * is a persistent configuration state rather than a transient event.
 */
function createLiveWindow(
  label: string,
  windowMs: LimiterBound,
  max: LimiterBound,
  minMax: number,
): LiveWindow {
  const resolveWindowMs = typeof windowMs === 'function' ? windowMs : () => windowMs;
  const resolveMax = typeof max === 'function' ? max : () => max;

  const bootWindowMs = resolveWindowMs();
  const bootMax = resolveMax();
  validateWindow(label, bootWindowMs, bootMax, minMax);

  let warned = false;
  function heal(what: string, bad: number, fallback: number): number {
    if (!warned) {
      warned = true;
      console.warn(
        `[ratelimit] ${label}: refusing a resolved ${what} of ${String(bad)}; falling back to ` +
          `${fallback}. Further occurrences are not logged.`,
      );
    }
    return fallback;
  }

  return {
    windowMs() {
      const value = resolveWindowMs();
      // NaN is the dangerous one and the reason this is not a `< 1` test: it
      // makes `cutoff` NaN, every comparison false, every timestamp read as
      // expired, and the limiter never fires again while still looking installed.
      if (!Number.isSafeInteger(value) || value <= 0) return heal('windowMs', value, bootWindowMs);
      return value;
    },
    max() {
      const value = resolveMax();
      // Below the layer's minimum, `hits.length >= max` is true on the first
      // request and the surface is locked out entirely, operator included.
      if (!Number.isSafeInteger(value) || value < minMax) return heal('max', value, bootMax);
      return value;
    },
  };
}

export interface RateLimiterOptions {
  /**
   * Sliding window length in milliseconds, or a function returning one. Must
   * resolve to a positive integer.
   */
  windowMs: LimiterBound;
  /**
   * Maximum allowed requests per key per window, or a function returning one.
   * Must resolve to a non-negative integer (0 blocks everything).
   */
  max: LimiterBound;
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
  const { keyFn = clientIp, message = 'Too many requests. Try again later.' } = opts;

  // `max: 0` stays legal here as a documented kill switch for a surface.
  const bounds = createLiveWindow('createRateLimiter', opts.windowMs, opts.max, 0);
  if (typeof keyFn !== 'function') {
    throw new TypeError('createRateLimiter: keyFn must be a function');
  }
  if (typeof message !== 'string' || message.length === 0) {
    throw new TypeError('createRateLimiter: message must be a non-empty string');
  }

  const store = createWindowStore(bounds.windowMs);

  return function rateLimit(req, res, next): void {
    const now = Date.now();
    // Resolved once for the whole request so the cutoff the store applies, the
    // cap compared against and the Retry-After reported are provably the same
    // numbers. Nothing can change them mid-handler in any case (this body is
    // synchronous and updateSettings only swaps the cache from an async
    // continuation), but reading them once says so rather than relying on it.
    const windowMs = bounds.windowMs();
    const max = bounds.max();
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
  /**
   * Sliding window length in milliseconds, or a function returning one. Must
   * resolve to a positive integer.
   */
  windowMs: LimiterBound;
  /**
   * Failures tolerated per identity per window, or a function returning one.
   * Must resolve to an integer >= 1.
   */
  max: LimiterBound;
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
  const { keyFn = clientIp } = opts;

  // `max: 0` is rejected here, unlike in Layer 1. There it is a useful kill
  // switch for a whole surface; here it would mean "every identity is locked
  // out permanently and no success can clear it", which is a footgun with no
  // legitimate use: disabling a surface is Layer 1's job.
  const bounds = createLiveWindow('createFailureLimiter', opts.windowMs, opts.max, 1);
  if (typeof keyFn !== 'function') {
    throw new TypeError('createFailureLimiter: keyFn must be a function');
  }

  const store = createWindowStore(bounds.windowMs);

  // Every method below resolves `max` for itself rather than closing over one
  // value, for the same reason the store resolves its window per call: the
  // caller drives this across several turns (check, then the credential work,
  // then reset or recordFailure) and an operator can change the setting between
  // them. Each turn asking independently means the worst a mid-sequence change
  // can do is decide one turn under the old number and the next under the new
  // one, which is exactly what "takes effect immediately" means; caching it in
  // the closure instead would freeze the value at process start.
  return {
    keyFor(req) {
      return keyFn(req);
    },
    check(key) {
      return store.live(boundKey(key), Date.now()).length < bounds.max();
    },
    recordFailure(key) {
      const now = Date.now();
      const bounded = boundKey(key);
      const hits = store.live(bounded, now);
      // Already locked: refuse without recording, so the attacker cannot extend
      // someone else's lockout by continuing to guess. See the note above.
      if (hits.length >= bounds.max()) return;
      store.record(bounded, now);
      store.maybeSweep(now);
    },
    reset(key) {
      store.clear(boundKey(key));
    },
    retryAfterSeconds(key) {
      const now = Date.now();
      const hits = store.live(boundKey(key), now);
      if (hits.length < bounds.max()) return 0;
      // hits[0] is inside the window by construction, so this is always >= 1.
      return Math.ceil((hits[0] + bounds.windowMs() - now) / 1000);
    },
  };
}

/**
 * Brute-force guard for `POST /auth/login`, defaulting to 10 attempts per 15
 * minutes per network key. Behaviour and response shape are unchanged from the
 * original dedicated implementation.
 *
 * The two numbers are now operator configuration (`auth.rateLimit` in
 * services/settings.ts) rather than literals, because the shipped pair is
 * sensible and still wrong for somebody: a single-user instance behind a VPN
 * wants them loose, a public instance wants them tight, and an operator running
 * an automated client can exhaust this layer with no recourse short of editing
 * the source. They are passed as RESOLVERS, not as values read once, so a save
 * takes effect on the next request rather than at the next restart; the store
 * behind them is built once and survives the change, so the limiter keeps
 * counting across it. See `createLiveWindow` and `createWindowStore` above.
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
  windowMs: () => loginRateLimitSettings().loginWindowSec * 1000,
  max: () => loginRateLimitSettings().loginMaxAttempts,
  message: 'Too many login attempts. Try again later.',
});
