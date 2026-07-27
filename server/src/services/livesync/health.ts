/**
 * The three-valued health model, ported from the reference bridge's
 * `Peer.probeHealth()` (reference/livesync-bridge/Peer.ts).
 *
 * KICKOFF section 7 calls a liveness signal that distinguishes idle from wedged
 * "arguably the most important design requirement here", and observes a bridge
 * that stayed up, did a full push, then went silent forever. The bridge's own
 * author had already solved the classification half of that problem, so this is
 * a port of the STATE MACHINE, not just of the boolean. The behaviour below is
 * intended to be identical to the bridge's; the differences are that the state
 * lives in a small collaborator instead of a base class (this project has two
 * peers with nothing else in common, so inheritance would be the only reason the
 * base class existed) and that the grace window is injectable for tests.
 *
 * The three values and why one boolean is not enough:
 *
 *  - `ok`: this peer is syncing right now. Cheap, synchronous, no I/O.
 *  - `backendUp`: this peer's remote is reachable right now. Distinguishes "not
 *    syncing because CouchDB is down" (wait, do not restart, nothing here is
 *    broken) from "not syncing while CouchDB answers" (this process is at fault).
 *    A peer with no remote, i.e. the storage peer, reports true.
 *  - `restartWorthy`: restarting the sync would plausibly help. True only when
 *    the peer has been healthy at least once, has since stayed unhealthy past a
 *    grace window, AND its backend is reachable.
 *
 * Each of those three conditions removes a specific false alarm:
 *
 *  - "has been healthy once" removes the startup case. A peer still doing its
 *    initial scan or its first connect has never been healthy, so a supervisor
 *    that restarted on "not ok" would kill it during every boot and never let it
 *    finish.
 *  - the grace window removes the self-healing case. The engine's changes feed
 *    reconnects itself ten seconds after an error, and `watching` is false for
 *    that whole interval. Without the window, every transient network blip reads
 *    as a wedge.
 *  - "backend reachable" removes the outage case. A CouchDB that is down is not
 *    this process's fault and restarting into it just churns.
 *
 * A single `ok` probe resets the clock completely, so recovery is immediate
 * rather than requiring the peer to out-wait its own bad history.
 *
 * One thing here is NOT the bridge's: `restartFutile`, a veto the peer itself
 * supplies. The three conditions above are all about timing and reachability and
 * none of them can see what is actually wrong, so a peer that knows a restart
 * cannot help says so. See `PeerHealth.restartFutile`.
 */
import type { LiveSyncPeerType } from './types.js';

/**
 * How long a once-healthy peer must stay unhealthy, with its backend reachable,
 * before a restart is worth considering.
 *
 * 60 seconds is the bridge's value and is chosen to sit comfortably outside the
 * engine's own 10-second watch-reconnect, so ordinary self-healing never trips
 * it.
 */
export const RESTART_GRACE_MS = 60_000;

export interface PeerHealth {
    name: string;
    type: LiveSyncPeerType;
    /** Syncing right now. */
    ok: boolean;
    /** Short human-readable state, for the status API and the log line. */
    detail?: string;
    /**
     * This peer's remote is reachable right now. Peers with no remote report
     * true. Only meaningful once `probe()` has been through the backend check;
     * the synchronous snapshot asserts it only when the peer is actually
     * syncing, which is a fact it already knows.
     */
    backendUp: boolean;
    /**
     * Restarting could plausibly help. Always false in a synchronous snapshot:
     * the real verdict is time- and backend-aware and can only be produced by
     * `HealthTracker.probe()`.
     */
    restartWorthy: boolean;
    /**
     * This peer knows its condition cannot be fixed by restarting it.
     *
     * A VETO SUPPLIED BY THE PEER, and the fourth false alarm the three
     * conditions above do not remove. `restartWorthy` asks "would restarting
     * plausibly help?" and answers it from outside: healthy once, unhealthy
     * since, backend reachable. Those three cannot see WHY the peer is
     * unhealthy, and for some reasons the answer is a flat no however long the
     * condition has lasted and however reachable the backend is: a document on
     * the remote that will not decrypt, a vault volume that is full, an
     * out-of-band probe a proxy refuses. The supervisor's response to
     * `restartWorthy` is to tear the peer pair down and rebuild it, which
     * replays the feed and runs a full offline vault scan, so acting on those is
     * an expensive no-op repeated every cooldown for as long as the fault lasts.
     *
     * Distinct from `backendUp: false`, which is the lever the fatal-config case
     * already uses. That one says CouchDB is unreachable, and saying it while
     * CouchDB answers would be a lie in the one field an operator would use to
     * decide whether their server is at fault. This says only what it means.
     *
     * Optional because it is a peer-supplied opinion: a peer with nothing to say
     * (the storage peer) omits it, and the absence reads as "no veto".
     */
    restartFutile?: boolean;
}

/** Cheap synchronous snapshot, supplied by the peer. */
export type HealthSnapshotFn = () => PeerHealth;

/** Possibly I/O-bound reachability check, supplied by the peer. */
export type BackendProbeFn = () => Promise<boolean>;

export interface HealthTrackerOptions {
    graceMs?: number;
}

/**
 * Holds the "was it ever ok, and how long has it been broken" state that turns a
 * snapshot into a verdict.
 *
 * One instance per peer, owned by the peer, and only ever driven through
 * `probe()`.
 */
export class HealthTracker {
    private readonly snapshot: HealthSnapshotFn;
    private readonly checkBackendUp: BackendProbeFn;
    private readonly graceMs: number;

    private everOk = false;
    private notOkSince: number | undefined;

    constructor(
        snapshot: HealthSnapshotFn,
        // Default: no remote backend, so always up. This is the storage peer's
        // case, and it is why the storage peer never needs to implement one.
        checkBackendUp: BackendProbeFn = () => Promise.resolve(true),
        opts: HealthTrackerOptions = {},
    ) {
        this.snapshot = snapshot;
        this.checkBackendUp = checkBackendUp;
        this.graceMs = opts.graceMs ?? RESTART_GRACE_MS;
    }

    /**
     * The full verdict. Ported line for line from `Peer.probeHealth()`.
     *
     * Note the two early returns, both of which are load-bearing:
     *
     *  1. When the peer is ok we record that it has been ok, clear the failure
     *     clock, and return WITHOUT probing the backend. That is what keeps the
     *     steady state free of extra I/O: a healthy peer's health check makes no
     *     network requests at all, so it can be called as often as a caller
     *     likes (a heartbeat every ten seconds, an HTTP status endpoint, both).
     *  2. When the peer has never been ok we return the snapshot unchanged, again
     *     without probing. It is starting up. Nothing here is diagnosable yet and
     *     nothing should act on it.
     */
    async probe(): Promise<PeerHealth> {
        const base = this.snapshot();
        if (base.ok) {
            this.everOk = true;
            this.notOkSince = undefined;
            return base;
        }
        if (!this.everOk) return base; // still starting up: not this process's fault
        // Stamp on the FIRST non-ok probe only, so the window measures how long
        // the peer has been broken rather than how long since the last check.
        if (this.notOkSince === undefined) this.notOkSince = Date.now();
        /*
         * The backend is still probed even when the peer has vetoed a restart,
         * and that is deliberate rather than an oversight. `backendUp` is
         * published to the status API and the settings panel, where it answers
         * "is my CouchDB up?" for an operator staring at an unhealthy peer. A
         * peer whose vault volume is full has a perfectly healthy CouchDB, and
         * reporting otherwise to save one request would be the same lie the
         * fatal-config path takes on knowingly and for a narrower reason.
         */
        const backendUp = await this.checkBackendUp();
        const restartWorthy =
            base.restartFutile !== true && backendUp && Date.now() - this.notOkSince > this.graceMs;
        return { ...base, backendUp, restartWorthy };
    }

    /**
     * Forget the history.
     *
     * Called when a peer is deliberately stopped and restarted by the operator:
     * the new run must earn its "was healthy once" status again, exactly as it
     * would after a process restart. Without this, a stop/start cycle inherits
     * `everOk` from the previous run and a peer that never manages to connect
     * this time would be judged restart-worthy on its very first probe.
     */
    reset(): void {
        this.everOk = false;
        this.notOkSince = undefined;
    }
}

export interface CombinedHealth {
    /** Every peer is syncing. False when there are no peers at all. */
    ok: boolean;
    /** Any peer judges itself restart-worthy. */
    restartWorthy: boolean;
    peers: PeerHealth[];
}

/**
 * Aggregate peer verdicts, matching `Hub.healthProbe()`.
 *
 * `ok` requires a non-empty list on purpose: a pair that failed to construct
 * reports zero peers, and `[].every(...)` is true, so the naive form would
 * report a sync backend with no peers as perfectly healthy. That is precisely
 * the silent failure this whole module exists to prevent.
 */
export function combineHealth(peers: PeerHealth[]): CombinedHealth {
    return {
        ok: peers.length > 0 && peers.every((p) => p.ok),
        restartWorthy: peers.some((p) => p.restartWorthy),
        peers,
    };
}
