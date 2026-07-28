/**
 * The HTTP surface of the LiveSync backend, plus the liveness beat that stands
 * behind it.
 *
 * Two things live here, and the pairing is deliberate.
 *
 * THE ROUTER is a thin wrapper over `services/livesync.ts`, shaped exactly like
 * `routes/git.ts`: `requireAuth` at the router level, `asyncHandler` around every
 * handler, no logic of its own beyond turning a service call into a response. The
 * service owns the lock, the state and the peers; this file owns none of that on
 * purpose, because a second place that decides when to connect is a second writer
 * over one vault.
 *
 * THE LIVENESS BEAT is the requirement KICKOFF section 7 says it would not ship
 * without: "a sync daemon that fails silently is worse than one that crashes".
 * The reference bridge solves it with a heartbeat FILE
 * (reference/livesync-bridge/main.ts) because its healthcheck runs inside a
 * container with no socket to talk to. We already run an HTTP server, so the
 * equivalent is in-process: keep the bridge's 10-second self-scheduling timer and
 * its `{ ts, ok, restartWorthy, peers }` payload, drop the file, and serve the
 * payload from `GET /healthz/livesync`.
 *
 * It lives next to the endpoint that serves it rather than in the composition
 * root, because the beat exists ONLY to keep that endpoint's answer fresh, and
 * because `server/src/index.ts` is already the longest file in the tree.
 *
 * WHY A BEAT AT ALL, GIVEN THE ENDPOINT COULD JUST PROBE ON DEMAND. Three
 * reasons, in increasing order of importance:
 *
 *  1. A probe is not free. `probePeers()` does a bounded network reachability
 *    check against CouchDB whenever a peer is not ok, and this endpoint is
 *    unauthenticated so that a container healthcheck or an uptime monitor can
 *    reach it. On-demand probing would hand anyone who can reach the port a
 *    request amplifier pointed at the operator's CouchDB.
 *  2. `status()` runs inside the service's sync lock, so an on-demand probe can
 *    queue behind a full reconciliation scan. A liveness endpoint that hangs for
 *    the duration of a scan is worse than useless: the monitor times out and
 *    reports the whole server down.
 *  3. The `ts` is the actual liveness signal, and it can only exist if something
 *    is scheduled. An endpoint that computes its answer at request time proves
 *    that Express is responsive and nothing else. The beat proves that a timer
 *    chain we own is still being serviced, which is what "wedged" destroys and
 *    what a responsive HTTP server does not.
 *
 * Credential hygiene: every error rendered here passes through `redactUrlCreds`
 * (directly, or through `createPeerLogger`, which redacts every line it writes)
 * before it reaches a log line or a response body, because a CouchDB URL carries
 * `user:password` and PouchDB quotes the request URL in its error messages.
 */
import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { redactUrlCreds } from '../lib/redact.js';
import { broadcast } from '../services/realtime.js';
import * as livesync from '../services/livesync.js';
import type { LiveSyncStatus } from '../services/livesync.js';
import type { PeerHealth } from '../services/livesync/health.js';
import { createPeerLogger } from '../services/livesync/types.js';

const log = createPeerLogger('health');

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** The bridge's heartbeat period, kept as-is so the two behave alike. */
const BEAT_INTERVAL_MS = 10_000;

/**
 * How long one beat waits for `status()` before publishing without it.
 *
 * `status()` takes the service's sync lock, and a reconciliation scan can hold
 * that lock for minutes on a large vault. Without a budget the beat would simply
 * stop updating `ts` for the duration, the staleness rule below would fire, and a
 * perfectly healthy first-boot scan would be reported as a wedged process: a
 * false alarm produced by the very mechanism meant to remove false alarms.
 *
 * Shorter than BEAT_INTERVAL_MS so that the beat keeps roughly its nominal
 * cadence even when every probe is being starved.
 */
const PROBE_BUDGET_MS = 8_000;

/**
 * How old `lastHealth.ts` may get before the answer is treated as unhealthy
 * regardless of what it says.
 *
 * This check is kept even though an HTTP endpoint is itself a liveness signal,
 * and the reason is specific: the beat timer and Express are independent. A throw
 * that escaped the beat, a timer chain that was never re-armed, or an event loop
 * blocked by something other than the HTTP server all leave Express answering
 * requests happily with a `lastHealth` frozen at whatever it last said. Serving a
 * stale "everything is fine" is precisely the silent failure this subsystem
 * exists to prevent, so age is checked at read time and old readings are refused.
 *
 * Six beats of headroom: long enough that a couple of starved probes in a row
 * cannot trip it, short enough that a genuinely dead timer chain is visible
 * within about a minute.
 */
const HEALTH_STALE_MS = 60_000;

/**
 * Minimum spacing between two automatic restarts of the peer pair.
 *
 * `restartWorthy` is already conservative (the peer must have been healthy once,
 * have stayed unhealthy past a 60s grace window, AND have a reachable backend:
 * see services/livesync/health.ts), and stopping a pair resets its health
 * trackers so a fresh pair has to earn `everOk` again before it can ask for
 * another restart. This cooldown is the backstop for the case none of that
 * covers: a fault that lets a peer connect, report healthy once, and then wedge
 * again immediately, which would otherwise reconnect in a loop and churn a new
 * PouchDB connection (and, given the engine leaks a socket per pair, a new socket)
 * every grace window.
 */
const RESTART_COOLDOWN_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// The published health payload
// ---------------------------------------------------------------------------

/**
 * A peer's health as served to an UNAUTHENTICATED caller.
 *
 * Deliberately narrower than `PeerHealth`: the `detail` field is dropped. Today
 * it holds a short fixed vocabulary ('watching', 'connecting', 'scanning offline
 * changes') plus `configuration error: <reason>`, all of which are harmless, but
 * `/healthz/livesync` has no session behind it and a health string is exactly the
 * kind of field that grows to quote an underlying error later. Whoever adds that
 * error text should not also, silently, be publishing it to the internet. The
 * authenticated `GET /api/livesync/status` returns the full `PeerHealth`,
 * `detail` included, which is where an operator should be looking anyway.
 */
export interface PublicPeerHealth {
  name: string;
  type: PeerHealth['type'];
  ok: boolean;
  backendUp: boolean;
  restartWorthy: boolean;
}

/** The beat's payload: the bridge's shape, plus what an HTTP reader needs. */
export interface LiveSyncHealth {
  /**
   * When this beat FINISHED, stamped after the (possibly I/O-bound) probe, so it
   * still reflects a live event loop rather than merely a fired timer. Same
   * reasoning as the bridge's heartbeat file.
   */
  ts: number;
  /** `sync.backend === 'livesync'`. Nothing below is meaningful when false. */
  enabled: boolean;
  running: boolean;
  connected: boolean;
  /** Every peer is syncing right now (`combineHealth`). */
  ok: boolean;
  /** A peer judges that restarting the sync would plausibly help. */
  restartWorthy: boolean;
  /**
   * The health probe itself failed. Distinct from `ok: false`, which is a
   * measured verdict; this means there is no verdict at all.
   */
  degraded: boolean;
  /**
   * Why this reading is not `ok`, drawn from a FIXED vocabulary and never from
   * an underlying error string. Null when there is nothing to explain. See
   * `classifyDetail()` for why the real text stays out of this payload.
   */
  detail: string | null;
  peers: PublicPeerHealth[];
}

/** What `GET /healthz/livesync` serves. */
export interface LiveSyncHealthReport extends LiveSyncHealth {
  /** The value the HTTP status is derived from. See `healthSnapshot()`. */
  healthy: boolean;
  /** `ts` is older than HEALTH_STALE_MS: the beat is not being serviced. */
  stale: boolean;
  ageMs: number;
}

// ---------------------------------------------------------------------------
// Beat state
// ---------------------------------------------------------------------------

let lastHealth: LiveSyncHealth | null = null;
let beatTimer: NodeJS.Timeout | null = null;
let beating = false;
let lastBroadcastSignature = '';

let restartInFlight = false;
let lastRestartAt = 0;

/** Sentinel for "the probe did not answer in time", distinguishable from any value. */
const TIMED_OUT = Symbol('livesync-health-probe-timeout');

/**
 * Resolve with `p`'s value, or with TIMED_OUT after `ms`.
 *
 * `Promise.race` rather than a detached timer, so that a probe which rejects
 * AFTER the budget expired still has a rejection handler attached and cannot
 * become an unhandled rejection. That matters more than usual here: this
 * subsystem's whole reason for existing is that an unhandled rejection from deep
 * inside PouchDB once left the reference bridge down, silently, for days.
 */
function withBudget<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    // A health timer must never be the reason the process refuses to exit.
    timer.unref?.();
  });
  return Promise.race([p, budget]).finally(() => clearTimeout(timer));
}

/**
 * Why this reading is not `ok`, as a fixed vocabulary.
 *
 * THE UNDERLYING TEXT IS DELIBERATELY NOT PUBLISHED. `configErrors`,
 * `fatalReason`, `lastError` and a peer's `detail` are all free-form strings that
 * quote what went wrong, and what went wrong routinely names the CouchDB host
 * ('CouchDB URL is not a valid URL: https://couch.internal.example', an
 * ECONNREFUSED naming an address and port). `redactUrlCreds` strips the
 * `user:password` from those, which is the part that would be catastrophic, but
 * it leaves the host, and `/healthz/livesync` is reachable without a session. An
 * unauthenticated endpoint that names the operator's internal infrastructure is a
 * reconnaissance aid, and health checking does not need it: a probe needs to know
 * THAT the backend is not syncing and roughly which stage it is stuck at, not the
 * hostname it is stuck on.
 *
 * The full text is still available in two places that are appropriate for it: the
 * authenticated `GET /api/livesync/status`, and the server log, where the caller
 * of this function writes it once per change of classification.
 *
 * Ordered most permanent first, so the answer names the condition an operator has
 * to fix rather than a symptom of it: a misconfigured backend is also always
 * disconnected, and reporting the disconnection would send them to look at
 * CouchDB.
 */
function classifyDetail(s: LiveSyncStatus): string | null {
  if (!s.enabled) return 'not selected';
  if (s.configErrors.length > 0 || s.fatalReason) return 'configuration error';
  if (!s.running) return 'not started';
  if (!s.connected) return 'not connected to CouchDB';
  /*
   * Ahead of the generic 'peers not syncing', because it is the one condition
   * that used to be invisible and because it names a different thing to go and
   * look at. A stalled inbound direction means the connection is up, the feed is
   * attached, and remote changes are still not reaching the vault: an operator
   * told only "peers not syncing" would go and check CouchDB, which is fine.
   *
   * `inbound.state` is already a fixed vocabulary ('undecodable', 'unproven',
   * 'degraded', 'unapplied', 'unwritable', 'behind', 'undelivered',
   * 'unobservable'; see services/livesync/progress.ts), so it can be published
   * here without breaking this endpoint's rule against free-form text.
   * `inbound.detail` is NOT published: it carries counts today and would be the
   * natural place for someone to later append the underlying error, and since
   * 'unproven' it also names a passphrase as one of two readings, which is
   * appropriate in an authenticated status payload and not on an unauthenticated
   * health endpoint.
   */
  if (s.inbound?.stalled) return `inbound stalled: ${s.inbound.state}`;
  if (!s.healthy) return 'peers not syncing';
  return null;
}

function toPublicPeers(peers: PeerHealth[]): PublicPeerHealth[] {
  return peers.map((p) => ({
    name: p.name,
    type: p.type,
    ok: p.ok,
    backendUp: p.backendUp,
    restartWorthy: p.restartWorthy,
  }));
}

/**
 * One beat: probe, publish, act, broadcast.
 *
 * EVERYTHING FALLIBLE IS INSIDE THIS FUNCTION'S TRY, and that is structural
 * rather than stylistic. The scheduling loop below re-arms in a `finally`; if the
 * try/catch lived out there instead, one throw from a path the `finally` does not
 * cover would end the timer chain, `ts` would freeze, and the subsystem would go
 * silent in exactly the manner this file exists to detect. Wrapping the body
 * means the loop cannot be killed by anything the body does.
 */
async function beat(): Promise<void> {
  const previous = lastHealth;
  // Built into a local and published in one assignment at the end, rather than
  // written straight into `lastHealth` from three branches. A reader (and a
  // reader of a stack trace) then never has to ask whether an exception could
  // have left the module-level reading half-updated.
  let published: LiveSyncHealth;
  try {
    const probed = await withBudget(livesync.status(), PROBE_BUDGET_MS);

    if (probed === TIMED_OUT) {
      /*
       * The probe is queued behind the service's sync lock, which means a
       * reconciliation pass is running. That is a normal, healthy state and it
       * is also a state in which the peers genuinely are not "syncing" in the
       * sense `ok` measures (the storage peer reports `ok: false` for the whole
       * duration of a scan, by design: see services/livesync/health.ts).
       *
       * So report `ok: false` and NOT `degraded`. This is the same answer a
       * completed probe would have given during the same scan, which keeps the
       * timeout path from becoming a second, differently-behaved notion of
       * health. `restartWorthy` is forced false because we measured nothing, and
       * acting on an unmeasured verdict is how a restart loop starts.
       *
       * `ts` is still refreshed: the beat ran, the race resolved, the event loop
       * is demonstrably alive. That is precisely what `ts` claims and all it
       * claims.
       */
      published = {
        ts: Date.now(),
        enabled: previous?.enabled ?? false,
        running: previous?.running ?? false,
        connected: previous?.connected ?? false,
        ok: false,
        restartWorthy: false,
        degraded: false,
        detail: 'a sync pass is in progress; health was not re-probed',
        peers: previous?.peers ?? [],
      };
    } else {
      const detail = classifyDetail(probed);
      // The classification is what gets published; the underlying text goes to
      // the log, once, when the classification changes. That way an operator has
      // the full reason somewhere trusted without it being served to anyone who
      // can reach the port, and the log is not rewritten every ten seconds for as
      // long as the condition lasts.
      if (detail !== null && detail !== previous?.detail) {
        const reason =
          probed.configErrors.length > 0
            ? probed.configErrors.join(' ')
            : (probed.fatalReason ?? probed.lastError);
        log(reason ? `${detail}: ${reason}` : detail, 'notice');
      }
      published = {
        ts: Date.now(),
        enabled: probed.enabled,
        running: probed.running,
        connected: probed.connected,
        ok: probed.healthy,
        restartWorthy: probed.restartWorthy,
        degraded: false,
        detail,
        peers: toPublicPeers(probed.peers),
      };
    }
  } catch (e) {
    /*
     * The probe threw. We have no verdict, so say that rather than inventing
     * one: `degraded` makes /healthz/livesync answer 503 unconditionally, which
     * is the correct treatment for "the health of this subsystem cannot be
     * determined". `enabled` is carried forward from the last known reading so
     * that a probe failure cannot masquerade as "LiveSync is simply switched
     * off", which would otherwise read as healthy.
     */
    const detail = redactUrlCreds(e instanceof Error ? e.message : String(e));
    published = {
      ts: Date.now(),
      enabled: previous?.enabled ?? false,
      running: previous?.running ?? false,
      connected: false,
      ok: false,
      restartWorthy: false,
      degraded: true,
      // The classification only, for the reason classifyDetail() gives at
      // length. The message itself goes to the log on the next line.
      detail: 'health probe failed',
      peers: previous?.peers ?? [],
    };
    log(`health probe failed: ${detail}`, 'error');
  }

  lastHealth = published;

  // Both of these are non-throwing by construction, and both are called AFTER
  // the publish, so a restart decision is always made against the reading that
  // an HTTP caller can already see. The alternative (act, then publish) would
  // produce a window in which the endpoint reports a state the process has
  // already decided to abandon.
  if (published.restartWorthy) maybeRestart();
  broadcastIfChanged(published);
}

/**
 * Act on `restartWorthy` IN PROCESS, by reconnecting rather than by exiting.
 *
 * The reference bridge's answer to a wedged peer is to let the container's
 * healthcheck fail and have the orchestrator kill the process. That is not
 * because killing is the right lever, it is because Deno-in-a-container gave the
 * bridge no cheaper one. We have a cheaper one: the service exposes
 * disconnect-then-connect, which tears the peer pair down (flushing the state
 * store, so the changes-feed checkpoint and the per-file baselines survive) and
 * builds a fresh one. That matters for this engine specifically, since recovering
 * from a failed CouchDB init REQUIRES a fresh manipulator rather than a retry
 * against the wedged one.
 *
 * Exiting would also take the whole web server with it: the vault UI, the search
 * index and every open WebSocket, none of which is broken. Restarting a subsystem
 * is the proportionate response to a broken subsystem.
 *
 * Fire-and-forget, deliberately. Both calls queue on the service's sync lock and
 * can therefore take as long as whatever is ahead of them; awaiting here would
 * stall the beat, freeze `ts`, and make the recovery attempt look like the wedge
 * it is trying to fix.
 */
function maybeRestart(): void {
  if (restartInFlight) return;
  const since = Date.now() - lastRestartAt;
  if (lastRestartAt !== 0 && since < RESTART_COOLDOWN_MS) {
    log(
      `peers still report restart-worthy, but the last automatic restart was ${Math.round(since / 1000)}s ` +
        `ago; waiting out the cooldown.`,
      'notice',
    );
    return;
  }
  restartInFlight = true;
  lastRestartAt = Date.now();
  log('a peer has been unhealthy past its grace window with its backend reachable; restarting the peer pair.', 'notice');
  void (async () => {
    try {
      await livesync.disconnect();
      await livesync.connect();
      log('peer pair restarted.', 'notice');
    } catch (e) {
      // Not fatal, and explicitly not escalated to a process exit: the next beat
      // will find the peers still unhealthy and try again after the cooldown.
      log(`automatic restart failed: ${redactUrlCreds(e instanceof Error ? e.message : String(e))}`, 'error');
    } finally {
      restartInFlight = false;
      // Publish the result promptly rather than waiting out the beat interval.
      kickHealthBeat();
    }
  })();
}

/**
 * Push the health summary to every connected browser.
 *
 * ON CHANGE ONLY. A beat runs every ten seconds for the life of the process, and
 * an unconditional broadcast would be a permanent, pointless write to every open
 * WebSocket on every instance, including the overwhelming majority that never
 * enable this backend. The signature deliberately excludes `ts`, which changes
 * every beat by definition.
 *
 * ONE MESSAGE SHAPE for this subsystem: `{ type: 'livesync', health }`.
 * web/src/App.tsx already switches on `msg.type` for 'fs' and 'uistate', so this
 * is one more case. The routes below do NOT broadcast their own differently
 * shaped payloads; they kick a beat instead, so there is exactly one producer of
 * exactly one shape and a client never has to discriminate between them.
 */
function broadcastIfChanged(health: LiveSyncHealth): void {
  const signature = JSON.stringify([
    health.enabled,
    health.running,
    health.connected,
    health.ok,
    health.restartWorthy,
    health.degraded,
    health.detail,
    health.peers,
  ]);
  if (signature === lastBroadcastSignature) return;
  lastBroadcastSignature = signature;
  broadcast({ type: 'livesync', health });
}

// ---------------------------------------------------------------------------
// The beat loop
// ---------------------------------------------------------------------------

/**
 * Self-scheduling, NOT `setInterval`.
 *
 * `setInterval` fires on a wall clock and does not care whether the previous beat
 * finished, so a slow probe (a reachability check against a CouchDB that is
 * black-holing packets) would let a second beat start while the first is still
 * awaiting. Two overlapping beats race on `lastHealth` and can publish them out
 * of order, so a stale reading overwrites a fresh one and the endpoint reports
 * yesterday's news with today's timestamp. Chaining the next beat off the end of
 * the previous one makes the overlap impossible by construction rather than
 * unlikely. It is the same reason the reference bridge chains its heartbeat, and
 * the same reason the WebSocket sweep in index.ts chains itself.
 */
function scheduleBeat(delayMs: number): void {
  if (beatTimer) clearTimeout(beatTimer);
  beatTimer = setTimeout(() => {
    beatTimer = null;
    void runBeat();
  }, delayMs);
  // Never the reason the process stays alive. The HTTP server holds the loop
  // open; a health timer that outlived it would only delay shutdown.
  beatTimer.unref?.();
}

async function runBeat(): Promise<void> {
  if (beating) return; // a kick raced the timer; the in-flight beat re-arms
  beating = true;
  try {
    await beat();
  } finally {
    // Re-arm unconditionally. A beat loop that stops because one pass went wrong
    // is the exact failure this endpoint exists to report, so it must not be
    // possible to reach that state through this function.
    beating = false;
    scheduleBeat(BEAT_INTERVAL_MS);
  }
}

/**
 * Start the beat. Idempotent; safe to call more than once.
 *
 * Called unconditionally at boot, including on instances that use git or no sync
 * at all. When LiveSync is not the selected backend `status()` is cheap (a cached
 * settings read plus a pure config validation, no peers, no I/O), so the cost is
 * a timer and a few microseconds every ten seconds, and the payoff is that the
 * endpoint is already live and already fresh the moment an operator switches the
 * backend on.
 */
export function startLiveSyncHealthBeat(): void {
  if (lastHealth === null) {
    /*
     * Seed a reading so the ordinary rules apply from the very first request,
     * including the one that arrives before the first beat completes.
     *
     * `enabled: false` makes this seed report healthy (there is nothing to be
     * unhealthy about yet), and the `ts` makes it EXPIRE: if the beat below never
     * produces anything, the staleness rule turns this into a 503 within
     * HEALTH_STALE_MS instead of leaving a permanent, cheerful placeholder. A
     * seed that could not go stale would be worse than no seed.
     */
    lastHealth = {
      ts: Date.now(),
      enabled: false,
      running: false,
      connected: false,
      ok: false,
      restartWorthy: false,
      degraded: false,
      detail: 'starting',
      peers: [],
    };
  }
  // First beat immediately: the seed above is a placeholder, not a measurement.
  scheduleBeat(0);
}

/**
 * Bring the next beat forward, so a state change is published now rather than up
 * to ten seconds from now.
 *
 * A no-op while a beat is already running: that beat is about to publish a
 * reading at least as fresh as anything a kick could produce, and it re-arms the
 * normal cadence when it finishes.
 */
export function kickHealthBeat(): void {
  if (beating) return;
  scheduleBeat(0);
}

// ---------------------------------------------------------------------------
// Reading the published health
// ---------------------------------------------------------------------------

/**
 * The served view of `lastHealth`, with the staleness rule applied.
 *
 * WHAT `healthy` MEANS, since the choice is not obvious and the alternative is
 * defensible. `healthy` is false when the backend is enabled and is not syncing,
 * for ANY reason: still doing its initial scan, CouchDB unreachable, wedged, or
 * misconfigured. That is deliberately stricter than the reference bridge's
 * container probe, which alerts on `restartWorthy` alone and therefore stays
 * green through an outage.
 *
 * The reason is KICKOFF acceptance criterion 5, which requires that a CouchDB
 * that is unreachable at boot, or dropped mid-session, leaves the process alive
 * and REPORTING UNHEALTHY. A 503 from a dedicated endpoint is the most legible
 * form that report can take, and it is safe to make it strict here precisely
 * because this endpoint is not the container healthcheck: `/healthz` is, and it
 * stays green regardless (see index.ts). Nothing kills the process on the
 * strength of this status code.
 *
 * The cost is that a long first-boot scan reads as unhealthy for its duration.
 * That is true rather than misleading (the vault genuinely is not in sync yet),
 * and an operator who wants to page a human only when something is actually
 * BROKEN should alert on the `restartWorthy` field in the body, which is the
 * three-condition verdict built for exactly that question and which suppresses
 * both the startup case and the outage case.
 *
 * When LiveSync is not the selected backend the answer is 200: there is no
 * subsystem to be unhealthy. The body says `enabled: false` so a reader knows
 * which of the two green states they are looking at.
 */
export function healthSnapshot(): LiveSyncHealthReport {
  const current: LiveSyncHealth = lastHealth ?? {
    // Only reachable if something reads health before startLiveSyncHealthBeat()
    // has run. Treated as stale-by-construction rather than as healthy: an
    // unmeasured subsystem must never answer "fine".
    ts: 0,
    enabled: false,
    running: false,
    connected: false,
    ok: false,
    restartWorthy: false,
    degraded: true,
    detail: 'the health beat has not started',
    peers: [],
  };
  const ageMs = Date.now() - current.ts;
  const stale = ageMs > HEALTH_STALE_MS;
  const healthy = !stale && !current.degraded && (!current.enabled || current.ok);
  return { ...current, healthy, stale, ageMs };
}

/**
 * A compact summary for the main `/healthz` body.
 *
 * Reporting only. `/healthz` is what Docker uses to decide whether to kill the
 * whole app, and a sync backend that cannot reach its remote must never be able
 * to take the editor, the search index and every open WebSocket down with it.
 * Returned as data so the caller can embed it without any of it influencing the
 * status code.
 */
export function livesyncHealthSummary(): {
  healthy: boolean;
  enabled: boolean;
  running: boolean;
  connected: boolean;
  ok: boolean;
  restartWorthy: boolean;
  stale: boolean;
  ageMs: number;
} {
  const s = healthSnapshot();
  return {
    healthy: s.healthy,
    enabled: s.enabled,
    running: s.running,
    connected: s.connected,
    ok: s.ok,
    restartWorthy: s.restartWorthy,
    stale: s.stale,
    ageMs: s.ageMs,
  };
}

/**
 * `GET /healthz/livesync`. UNAUTHENTICATED, like `/healthz`.
 *
 * It has to be: a container healthcheck, a systemd `ExecStartPost` probe and an
 * uptime monitor all live outside any session, and a liveness endpoint that
 * requires a login is a liveness endpoint nobody will wire up. What it publishes
 * is bounded accordingly: booleans, a timestamp, an age, peer NAMES ('vault',
 * 'couchdb') and a detail string drawn from a fixed vocabulary. No URL, no
 * database name, no path, no error text, no count of anything in the vault.
 * `PublicPeerHealth` and `classifyDetail()` above are where that boundary is
 * enforced, and each says why.
 */
export function livesyncHealthHandler(_req: Request, res: Response): void {
  const snapshot = healthSnapshot();
  res.status(snapshot.healthy ? 200 : 503).json(snapshot);
}

// ---------------------------------------------------------------------------
// The authenticated API
// ---------------------------------------------------------------------------

export const livesyncRouter = Router();
livesyncRouter.use(requireAuth);

/**
 * Render a thrown value for a client.
 *
 * The generic error middleware would normally do this, and for most routes it
 * should. It is bypassed for the two state-changing routes below because of one
 * specific behaviour: `isOperationalError()` suppresses the message of any error
 * carrying Node's system-error stamp, and `ECONNREFUSED` carries it. Left to the
 * middleware, the single most common and most actionable LiveSync failure ("your
 * CouchDB is not accepting connections") reaches the operator as "Internal Server
 * Error", which is the opposite of the diagnosability this whole port is about.
 *
 * The suppression rule is right in general (those messages embed absolute paths
 * and server internals) so it is not weakened; the exception is narrow, local and
 * explicit, and the message is redacted here exactly as the middleware would have
 * redacted it.
 */
function clientError(e: unknown): string {
  return redactUrlCreds(e instanceof Error ? e.message : String(e));
}

livesyncRouter.get('/status', asyncHandler(async (_req, res) => res.json(await livesync.status())));

livesyncRouter.post(
  '/connect',
  asyncHandler(async (_req, res) => {
    console.log('[livesync] connect requested');
    try {
      await livesync.connect();
    } catch (e) {
      const error = clientError(e);
      console.warn('[livesync] connect refused:', error);
      // 502: this server is fine, the upstream (or the configuration naming it)
      // is not. The status object rides along so a settings panel can render the
      // failure and the current state from one response.
      kickHealthBeat();
      res.status(502).json({ error, status: await livesync.status() });
      return;
    }
    /*
     * Note what is NOT asserted here: that the connection succeeded. `connect()`
     * is bounded (CONNECT_WAIT_MS in the service) and returns once the first
     * attempt has settled either way, with the supervised retry loop continuing
     * in the background. An HTTP handler that blocked until CouchDB came back
     * would be a denial of service against the operator's own UI. The returned
     * status carries `connected`, which is the honest answer to "is it up yet".
     */
    kickHealthBeat();
    res.json(await livesync.status());
  }),
);

livesyncRouter.post(
  '/disconnect',
  asyncHandler(async (_req, res) => {
    console.log('[livesync] disconnect requested');
    // Never throws: the service's shutdown path catches per-peer failures, on the
    // principle that a stop which can fail is a stop that leaves a half-running
    // pair behind.
    await livesync.disconnect();
    kickHealthBeat();
    res.json(await livesync.status());
  }),
);

livesyncRouter.post(
  '/sync',
  asyncHandler(async (_req, res) => {
    console.log('[livesync] manual sync requested');
    /*
     * No `periodic` flag, and that is the whole difference between this and the
     * autosync tick. A person who pressed "sync now" is asking "is everything up
     * to date", and answering without a full reconciliation walk would be a lie.
     * The tick passes `periodic: true` so that live mode can relax that walk to a
     * safety net rather than doing one `stat` per vault file every interval.
     */
    const result = await livesync.sync();
    console.log(`[livesync] sync ${result.ok ? 'ok' : 'not-ok'}:`, result.log.join(' | '));
    kickHealthBeat();
    // Mirrors git.ts's `{ ok, log }`, with the status appended so the UI does not
    // have to make a second round trip to refresh the panel it just acted on.
    res.json({ ...result, status: await livesync.status() });
  }),
);
