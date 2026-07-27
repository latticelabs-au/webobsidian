/**
 * The CouchDB side of the pair: a port of the reference bridge's `PeerCouchDB`
 * (reference/livesync-bridge/PeerCouchDB.ts) onto the vendored engine.
 *
 * Everything structural is the bridge's: the probe/build/retry connect loop, the
 * fresh-manipulator-per-attempt rule, the remote-tweak adoption, the
 * remote-rebuilt detection, the same-content skip, and the health snapshot. Six
 * things are deliberately different, and each one is a defect fix rather than a
 * preference. They are marked FIX 3, FIX 4, FIX 10, INBOUND LEDGER, MILESTONE
 * HANDSHAKE and FATAL CONFIG below:
 *
 *  - FIX 3: `compareDate()` had an operator-precedence bug and an int32
 *    overflow, so the same-content dedup fired essentially at random.
 *  - FIX 4: `since` was never advanced, so the peer always resumed from "now"
 *    and permanently lost every change made while it was down.
 *  - FIX 10: the changes feed's `complete` event was a terminal, silent stop.
 *    This is the actual mechanism behind the "did a full push, then went silent"
 *    behaviour KICKOFF section 7 reports.
 *  - INBOUND LEDGER: `ok` meant "connected, and the feed OBJECT is attached",
 *    which is a claim about a socket rather than about work. Three separate
 *    upstream defects stop documents dead while `watching` stays true (see
 *    progress.ts, which names all three), so a wedged peer reported itself
 *    healthy, `restartWorthy` was unreachable, and `/healthz/livesync` answered
 *    200 forever. `snapshot()` now requires work to be flowing, measured by
 *    `InboundProgress` plus one out-of-band `_changes` probe.
 *  - MILESTONE HANDSHAKE: the bridge READS the cluster's milestone document and
 *    never writes it, which is invisible while an Obsidian client has already
 *    initialised the database (the bridge's own deployment) and wrong the moment
 *    the daemon is the first client against an empty one, which WebObsidian is
 *    explicitly allowed to be. Two consequences, both silent: another client
 *    joining later seeds the document from ITS settings and we adopt them on the
 *    next restart, having already written a database in a different format; and
 *    a `locked`/`cleaned` flag set by a plugin rebuild or chunk clean-up is
 *    ignored, so we keep writing into a database that has been declared rebuilt.
 *    `connectAndWatch` now drives the engine's own `ensureRemoteIsCompatible`.
 *  - FATAL CONFIG: the three remote-tweak mismatches (encryption, obfuscation,
 *    compression) were thrown into the retry loop, so a passphrase typo retried
 *    every 30 seconds forever while the storage side wedged behind a promise
 *    that would never resolve.
 *
 * Credential hygiene: the CouchDB URL carries `user:password`, and PouchDB
 * embeds the request URL in its error messages. Every error leaving this file
 * goes through `describeError()` (which applies `lib/redact.ts`'s
 * `redactUrlCreds`), and the logger from `types.ts` redacts again on the way
 * out. Two layers, because one forgotten call would publish the password.
 */
import {
    DEVICE_ID_PREFERRED,
    DirectFileManipulator,
    MILESTONE_DOCID,
    TweakValuesDefault,
    TweakValuesShouldMatchedTemplate,
    TweakValuesTemplate,
    createBlob,
    createTextBlob,
    ensureRemoteIsCompatible,
    extractObject,
    isObjectDifferent,
    isPlainText,
} from 'livesync-engine';
import type {
    ChunkSplitterVersion,
    ChunkVersionRange,
    E2EEAlgorithm,
    ENSURE_DB_RESULT,
    EntryMilestoneInfo,
    FileInfo,
    FilePathWithPrefix,
    HashAlgorithm,
    MetaEntry,
    PouchDatabaseConfiguration,
    PouchDatabaseHandle,
    ReadyEntry,
    RemoteDBSettings,
    TweakValues,
} from 'livesync-engine';
import { HealthTracker, type PeerHealth } from './health.js';
import { InboundProgress, type InboundProgressOptions, type InboundVerdict } from './progress.js';
// `LiveSyncStateStore` is imported as a VALUE and not only as a type: the
// decode-evidence fingerprint is a static on it, deliberately kept next to the
// store that persists it rather than reimplemented here.
import { EchoSuppressor, LiveSyncStateStore } from './state.js';
import {
    describeError,
    validateCouchDBConf,
    type DispatchFn,
    type FileData,
    type LiveSyncCouchDBConf,
    type LiveSyncLogger,
} from './types.js';

/**
 * The chunk format range this peer advertises in the milestone document.
 *
 * A WIRE CONSTANT, copied out of the engine because it cannot be imported:
 * `currentVersionRange` is a module-local `const` in
 * `upstream/src/replication/couchdb/LiveSyncReplicator.ts` and is not exported,
 * so `src/entry.ts` has nothing to re-export. It is not a tuning knob. `max`
 * feeds the engine's compatibility arithmetic (`ensureRemoteIsCompatible`
 * intersects every accepted node's range and returns INCOMPATIBLE when the
 * intersection is empty), so inventing a value here would either lock this peer
 * out of a healthy cluster or, worse, claim we can read a chunk format we cannot.
 *
 * `livesync-wire-constants.test.ts` reads the literal straight out of the
 * vendored source and fails if the two drift, because a commit bump that changed
 * it would otherwise be silent until a real cluster refused us.
 */
export const CURRENT_VERSION_RANGE: ChunkVersionRange = { min: 0, max: 2400, current: 2 };

/**
 * Tweak keys that a mismatch on is provably harmless FOR THIS BACKEND.
 *
 * Context, because this list is a licence to ignore a warning and therefore has
 * to justify itself key by key. `ensureRemoteIsCompatible` returns MISMATCHED
 * when any key in upstream's `TweakValuesShouldMatchedTemplate` differs from the
 * cluster's preferred values. That template is scoped to the Obsidian plugin,
 * whose settings surface is much wider than this server's, and three of its keys
 * are ones this server cannot set at all: `DirectFileManipulatorOptions` has no
 * field for them, so `DirectFileManipulator`'s `settings` getter always reports
 * `DEFAULT_SETTINGS`' value however the remote is configured. Treating those as
 * fatal would mean refusing to sync with a perfectly compatible cluster over a
 * value we are structurally incapable of changing.
 *
 * Verified in the vendored source, one at a time:
 *
 *  - `useSegmenter`: dead as a setting. `ContentSplitterBase.ts:83` derives the
 *    real flag as `settings.chunkSplitterVersion === "v2-segmenter"` and never
 *    reads `settings.useSegmenter`. We DO adopt `chunkSplitterVersion`, so the
 *    behaviour agrees even when the advertised value does not.
 *  - `longLineThreshold`: has no reader anywhere under `upstream/src` outside the
 *    settings type itself. Entirely vestigial.
 *  - `usePluginSyncV2`: governs the plugin's own plugin-sync documents. This peer
 *    replicates note entries only (`isNoteEntryType`), so it neither reads nor
 *    writes a document the flag applies to. Note that upstream's RECOMMENDED
 *    template sets it to `true` while the engine default is `false`, so an
 *    ordinary plugin user mismatches us on it by default: this entry is the
 *    difference between working against a normal cluster and refusing to start.
 *
 * Everything else that can still differ after tweak adoption is format-relevant
 * and IS fatal. See `classifyMismatch`.
 */
export const BEHAVIOUR_FREE_TWEAK_KEYS: ReadonlySet<string> = new Set([
    'useSegmenter',
    'longLineThreshold',
    'usePluginSyncV2',
]);

/** Ceiling on the connect backoff, matching the bridge. */
const MAX_BACKOFF_MS = 30_000;
/** How long to wait for the manipulator's one-shot init before giving up on it. */
const READY_TIMEOUT_MS = 15_000;
/** Bound on the connect-time reachability probe. */
const PROBE_TIMEOUT_MS = 10_000;
/** Bound on the health-time reachability probe (shorter: a health check must not hang). */
const REACHABLE_TIMEOUT_MS = 5_000;
/** How often the watch supervisor checks that the changes feed is still attached. */
const WATCHDOG_INTERVAL_MS = 5_000;
/**
 * How often to ask CouchDB whether it holds changes the feed has not delivered.
 *
 * This is the only network request in the health path that a HEALTHY peer makes,
 * so its cost is the thing to justify. It is one `_changes` request with
 * `limit=1` and `timeout=0` starting from the feed's own cursor. Every 20 seconds
 * is four ticks of the watchdog: frequent enough that a dead feed is classified
 * inside the 60-second `DELIVER_GRACE_MS`, rare enough to be invisible next to
 * the long-poll the feed itself is holding open.
 *
 * Exported for the guard-rail assertion in `livesync-inbound.test.ts` that this
 * stays longer than the timeout below, so two probes can never be in flight at
 * once over the same connection.
 */
export const REMOTE_PENDING_INTERVAL_MS = 20_000;
/**
 * Bound on that probe.
 *
 * THE HEALTHY ANSWER IS THE EXPENSIVE ONE, which is the opposite of what the
 * request looks like and the reason this used to be five seconds. With
 * `filter=_selector&limit=1`, a POSITIVE answer ("yes, something is pending")
 * returns the moment CouchDB finds one matching row and is essentially free. The
 * NEGATIVE answer cannot return early at all: to prove that nothing matches,
 * CouchDB has to walk the by-sequence index from `since` to the tail and evaluate
 * the selector on every row it passes. So the tightest deadline landed on exactly
 * the case where everything is fine, and a timeout there is not an answer, it is
 * a failed measurement, which now costs the peer its health signal
 * (`noteProbeUnanswerable`). Five seconds was a false-alarm generator.
 *
 * The walk is bounded by the chunk (`leaf`) documents written since the cursor
 * last moved, because the cursor now advances on every non-leaf change (see
 * `instrumentFeed`). One large attachment is a burst of thousands of them, so the
 * bound has to cover a burst rather than a steady state. Fifteen seconds does,
 * and stays under `REMOTE_PENDING_INTERVAL_MS` so probes cannot overlap. It is
 * still bounded, which is the property that matters: a health check that hangs
 * looks exactly like the wedge it is supposed to detect.
 */
export const REMOTE_PENDING_TIMEOUT_MS = 15_000;
/**
 * How long to stay quiet between repeats of the "the probe is not answering"
 * notice.
 *
 * NOT a latch. The previous shape was a single boolean that, once set, demoted
 * every subsequent failure to `debug` for the life of the process, so a
 * permanently broken probe produced one line at boot and then nothing: the exact
 * "goes quiet" behaviour this subsystem exists to remove, applied to the
 * instrument rather than to the data. Rate-limiting keeps the log readable during
 * a long outage while leaving the condition visible to anyone reading the log
 * later. The HEALTH signal is not rate-limited at all: `InboundProgress` keeps
 * reporting `unobservable` for as long as the probe is unanswerable.
 */
const PROBE_COMPLAINT_INTERVAL_MS = 300_000;
/**
 * Only consider a same-content skip when the two mtimes are within an hour.
 *
 * The bridge's window, kept. Outside it the two documents are different enough
 * in time that resolving them by content would hide a real conflict, and the
 * cost of the check (fetching and rehydrating every chunk of the old document)
 * is not worth paying on every push.
 */
const SAME_CONTENT_WINDOW_SEC = 3600;

/**
 * A configuration that can never work. The peer refuses to start rather than
 * retrying, because no amount of waiting fixes it.
 */
export class LiveSyncFatalError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LiveSyncFatalError';
    }
}

/**
 * The peer cannot accept a write right now (still connecting, disconnected, or
 * fatally misconfigured).
 *
 * Thrown rather than returned as `false` because the caller has to be able to
 * tell "skipped, that is fine" from "not delivered". See `DispatchFn` in
 * types.ts: the storage peer only advances a file's synced baseline when the
 * dispatch did not throw, so throwing here is what keeps a local edit made
 * during a CouchDB outage from being marked as synced and lost.
 */
export class LiveSyncNotReadyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LiveSyncNotReadyError';
    }
}

/**
 * The tweak fields this peer will ADOPT from the remote.
 *
 * Deliberately narrower than the engine's own `TweakValues`, which this package
 * does now export. `TweakValues` carries an index signature (it is derived from
 * the Obsidian plugin's entire settings object), and an index signature is
 * exactly the wrong shape for the one list in this file that has to be auditable
 * at a glance: these are the settings that decide how this peer encrypts, splits
 * and names every document it writes. Naming them explicitly means adding one is
 * a visible diff rather than a value that starts flowing through because the
 * remote happened to send it.
 */
interface RemoteTweaks {
    customChunkSize?: number;
    minimumChunkSize?: number;
    encrypt?: boolean;
    usePathObfuscation?: boolean;
    enableCompression?: boolean;
    hashAlg?: HashAlgorithm;
    useEden?: boolean;
    maxAgeInEden?: number;
    maxTotalLengthInEden?: number;
    maxChunksInEden?: number;
    useDynamicIterationCount?: boolean;
    enableChunkSplitterV2?: boolean;
    chunkSplitterVersion?: ChunkSplitterVersion;
    E2EEAlgorithm?: E2EEAlgorithm;
    doNotUseFixedRevisionForChunks?: boolean;
    handleFilenameCaseSensitive?: boolean;
}

/** Minimal shape of the bundled PouchDB constructor. See `buildManipulator`. */
type PouchConstructor = new (name: string, options: PouchDatabaseConfiguration) => PouchDatabaseHandle;

/**
 * One raw event from PouchDB's changes emitter, BEFORE decryption.
 *
 * Only three fields are read, and all three survive end-to-end encryption. `seq`
 * is CouchDB's, never the document's. `type` is stored in plaintext even on an
 * encrypted database, which is not an assumption but a load-bearing fact of the
 * engine's own design: `beginWatch` opens the feed with the server-side selector
 * `{ type: { $ne: "leaf" } }`, and a server-side selector can only match a field
 * CouchDB can read. `outgoingDecryptHKDF` never rewrites it either.
 *
 * `id` is the CouchDB document id, which is what correlates this raw row with
 * the decrypted document the engine hands to the interest predicate later; see
 * `changeKey()`.
 */
interface RawFeedChange {
    seq?: string | number;
    id?: unknown;
    doc?: { _id?: unknown; type?: unknown } | null;
}

/**
 * The part of the changes emitter this peer needs and the vendored `ChangesHandle`
 * declaration does not carry.
 *
 * `addListener`, not `on`, and the difference is the whole point. See
 * `instrumentFeed()`.
 */
interface RawChangesEmitter {
    addListener?: (event: string, listener: (change: RawFeedChange) => void) => unknown;
}

/**
 * The document types the engine's own `isNoteEntry()` accepts.
 *
 * Duplicated rather than imported because `isNoteEntry` is a module-private
 * function in the vendored tree and the curated entry surface does not export it.
 * Keeping the two in step matters: this predicate decides which delivered
 * documents OWE A DECODE RECEIPT, and the engine's decides what reaches
 * `checkIsInterested`, so a disagreement would show up as a permanent phantom gap
 * between the two counters and report a healthy peer as unable to decrypt.
 *
 * WHAT IT DELIBERATELY DOES NOT DECIDE is how far the changes feed has got. That
 * is a wider question (the feed's selector admits `versioninfo`, `syncinfo`,
 * legacy `notes` and `chunkpack` too) and conflating the two produced a permanent
 * false wedge. See the call site in `instrumentFeed()`.
 */
function isNoteEntryType(type: unknown): boolean {
    return type === 'newnote' || type === 'plain';
}

/**
 * The identity that ties one document's three appearances together, for the
 * inbound ledger's per-document stall clocks (`PendingClock` in progress.ts).
 *
 * A document is seen three times on the way in, at points that carry different
 * shapes: as a raw change row on the feed, as a decrypted `MetaEntry` in the
 * interest predicate, and as a `ReadyEntry` in the apply callback. The clocks
 * need to know that those are the same document, and the CouchDB `_id` is the
 * only field that is the same at all three, verified rather than assumed:
 *
 *  - the raw row's `id` is CouchDB's key, and our counting listener is attached
 *    with `addListener`, so nothing has transformed it;
 *  - `outgoingDecryptHKDF` builds its result as `{...doc}` and rewrites `data`,
 *    `path` and `eden`. It never touches `_id`, which it could not: the id is the
 *    database key, and for an obfuscated vault it is already the opaque `f:` hash
 *    on both sides;
 *  - `getDBEntryFromMeta` sets `_id: meta._id` explicitly on both of its return
 *    paths.
 *
 * The PATH would have been the natural choice and is the wrong one: with path
 * obfuscation the raw row has no readable path at all, so the correlation would
 * silently fail on precisely the deployments KICKOFF names in its acceptance
 * criteria. `PendingClock` degrades to plain FIFO order rather than to a false
 * alarm if a key ever fails to match, so this is a sharpness rather than a
 * correctness dependency, but it is worth getting right.
 */
function changeKey(id: unknown, docId: unknown): string | undefined {
    if (typeof id === 'string' && id !== '') return id;
    if (typeof docId === 'string' && docId !== '') return docId;
    return undefined;
}

export interface CouchDBPeerDeps {
    state: LiveSyncStateStore;
    /** Hand a remote change to the storage peer. */
    dispatch: DispatchFn;
    log?: LiveSyncLogger;
    /**
     * Called after every successful (re)connect.
     *
     * The recovery hook: a local edit made while CouchDB was unreachable was
     * rejected by `put()` and therefore never had its baseline advanced, so the
     * storage peer's offline scan will find it. Running that scan on reconnect
     * is what turns "recovers after a restart" into "recovers without one",
     * which is half of KICKOFF section 8's last acceptance criterion.
     */
    onConnected?: () => void;
    /**
     * Grace-window overrides for the inbound ledger.
     *
     * Injectable for the same reason `HealthTracker`'s window is: the defaults are
     * measured in minutes and a test that had to wait them out would either be
     * slow or would quietly assert against a shorter window than production uses.
     */
    progress?: InboundProgressOptions;
}

export class CouchDBPeer {
    readonly type = 'couchdb' as const;

    private conf: LiveSyncCouchDBConf;
    private readonly deps: CouchDBPeerDeps;
    private readonly log: LiveSyncLogger;
    private readonly state: LiveSyncStateStore;
    private readonly echo = new EchoSuppressor();
    private readonly tracker: HealthTracker;

    private man?: DirectFileManipulator;
    /**
     * A LIFECYCLE flag: the connect sequence completed and this peer is running.
     *
     * NOT a statement about the link, and the distinction is a reported defect
     * rather than a nicety. It is set once when `connectLoop` succeeds and cleared
     * only by `stop()` and `markFatal()`, so it stays true through an outage of any
     * length: measured at `true` for the whole of a 269-second dead link. Every
     * reader that wants "is the peer running" (`start()`'s re-entry guard,
     * `requireReady`, the probe gate) is asking the right question of it, and every
     * reader that wants "is the link up" is not. The second question has its own
     * answer now: see `isLinkUp()`.
     */
    private connected = false;
    /**
     * The replication checkpoint is being held at a change that failed to apply.
     *
     * See the apply callback in `startWatch()` (FIX 4 part 3) for what it protects
     * and why a boolean is enough: it turns the checkpoint from a high-water mark
     * into a low-water one, which is the only shape that can survive a failure
     * followed by later successes. Set in the callback's catch, and cleared only by
     * `startWatch()`, which is the point at which the feed is armed from the held
     * position and the failed changes are therefore about to be re-delivered.
     */
    private checkpointHeld = false;
    /**
     * Connected fine, but there is no milestone document to reconcile against.
     * Tracked separately from `connected` so the health snapshot can call it
     * syncing rather than stuck.
     *
     * Since the handshake landed this is close to unreachable: an absent milestone
     * is now SEEDED rather than merely noted, so the normal outcome of connecting
     * to an empty database is a document that exists. The flag is kept because it
     * is what the health snapshot falls back on, and a future change that stopped
     * producing a document should report "not syncing" rather than crash.
     */
    private remoteEmpty = false;
    private starting = false;
    private stopping = false;
    /**
     * The changes feed has been observed detached since the last time it was
     * healthy. Drives the "recovered without a restart" announcement and the
     * rescan that goes with it (see `startWatchdog`).
     */
    private degraded = false;
    private fatalReason?: string;
    private watchdog?: NodeJS.Timeout;
    /** Resolver for the interruptible backoff sleep, so stop() is immediate. */
    private wakeFromBackoff?: () => void;

    /**
     * The inbound ledger: the difference between "the feed object is attached"
     * and "remote changes are landing in the vault". See progress.ts for the three
     * upstream defects that make the distinction necessary.
     */
    private readonly progress: InboundProgress;
    /**
     * The changes emitter this peer has already attached its counting listener to.
     *
     * Identity-compared rather than a boolean because the engine replaces the
     * emitter on its own ten-second reconnect, and an instrumented-once flag would
     * leave every feed after the first one uncounted, i.e. silently unmeasured.
     */
    private instrumented?: object;
    /** Watchdog ticks since the last remote-pending probe. See REMOTE_PENDING_INTERVAL_MS. */
    private pendingProbeTicks = 0;
    /** A remote-pending probe is in flight; do not start a second. */
    private pendingProbeInFlight = false;
    /**
     * When the "probe is not answering" notice was last written.
     *
     * A TIMESTAMP, NOT A FLAG. See `noteProbeUnanswerable`: the flag it replaced
     * silenced the notice for the life of the process after one line, which left a
     * permanently blind peer looking like a quiet one in the log. Undefined means
     * the probe is currently answering, so the next failure complains at once.
     */
    private pendingProbeComplainedAt?: number;

    /**
     * The fingerprint under which a successful decode is recorded and looked up.
     *
     * Computed once, from the configuration this peer was built with, because it
     * has to be stable for the life of the peer: it is the key that decides
     * whether persisted evidence of a working passphrase belongs to THIS
     * configuration. `mergeRemoteTweaks` may replace `this.conf` while adopting
     * the cluster's chunking settings, and it never touches the passphrase, the
     * url or the database, but computing this up front means a future edit that
     * did would not silently invalidate every peer's stored evidence.
     */
    private readonly decodeEvidenceKey: string;

    constructor(conf: LiveSyncCouchDBConf, deps: CouchDBPeerDeps) {
        this.conf = { ...conf };
        this.deps = deps;
        this.state = deps.state;
        this.log = deps.log ?? (() => {});
        this.progress = new InboundProgress(deps.progress);
        this.decodeEvidenceKey = LiveSyncStateStore.decodeEvidenceKey({
            url: conf.url,
            database: conf.database,
            passphrase: conf.passphrase,
            obfuscatePassphrase: conf.obfuscatePassphrase,
        });
        this.tracker = new HealthTracker(
            () => this.snapshot(),
            () => this.couchReachable(),
        );
    }

    // --- lifecycle -------------------------------------------------------------

    /**
     * Start the supervised connect loop.
     *
     * Resolves once the FIRST attempt has settled, one way or the other, while
     * the loop keeps retrying in the background. That differs from the bridge,
     * whose `start()` only resolves on success, and the difference matters at
     * boot: `Hub.start()` awaits every CouchDB peer before starting any storage
     * peer (correctly, so a storage scan cannot push into an uninitialised DB
     * manager), which means a CouchDB that is down at boot leaves the whole
     * daemon waiting forever, with the filesystem side never started at all.
     * Here the storage side starts either way and simply cannot dispatch while
     * this peer is disconnected: `put()`/`delete()` throw, no baseline is
     * advanced, and `onConnected` replays the difference later.
     *
     * Never rejects. A fatal configuration error is recorded and surfaced
     * through health and `getFatalReason()`, because throwing out of startup
     * would take the whole server's boot with it.
     */
    async start(): Promise<void> {
        if (this.starting || this.connected) return;
        // A fresh start re-judges the configuration: the operator may have just
        // fixed the passphrase that made the last one fatal, and a stale reason
        // would keep reporting a problem that no longer exists.
        this.fatalReason = undefined;
        const configErrors = validateCouchDBConf(this.conf);
        if (configErrors.length > 0) {
            this.markFatal(configErrors.join(' '));
            return;
        }
        this.starting = true;
        this.stopping = false;
        this.tracker.reset();
        // A fresh run must not inherit the previous run's gap. Its outstanding
        // documents will be replayed from the persisted checkpoint, so counting
        // them again would double-count the same work and, worse, would carry a
        // stall verdict across a restart that may well have fixed it.
        this.progress.reset();
        const firstAttempt = this.connectOnce();
        // The loop continues past the first attempt; the caller only waits for
        // that first result.
        void this.connectLoop(firstAttempt);
        await firstAttempt.catch(() => {});
    }

    /**
     * The supervised retry loop, with the bridge's capped exponential backoff.
     *
     * Rationale, unchanged from the bridge: CouchDB is regularly unreachable or
     * still warming up when both come up together after a host reboot, and a
     * failed connect surfacing as a fatal unhandled rejection previously
     * crash-looped the daemon into systemd's start limit and left it down for
     * days.
     */
    private async connectLoop(firstAttempt: Promise<void>): Promise<void> {
        let attempt = 0;
        let pending = firstAttempt;
        for (;;) {
            if (this.stopping) return;
            try {
                await pending;
                if (attempt > 0) {
                    this.log(`connected to CouchDB after ${attempt} ${attempt === 1 ? 'retry' : 'retries'}.`, 'notice');
                }
                this.starting = false;
                this.connected = true;
                this.deps.onConnected?.();
                return;
            } catch (e) {
                if (e instanceof LiveSyncFatalError) {
                    this.markFatal(e.message);
                    return;
                }
                attempt += 1;
                const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempt - 1, 5));
                this.log(`CouchDB connect attempt ${attempt} failed; retrying in ${delay / 1000}s.`, 'notice');
                this.log(describeError(e), 'debug');
                await this.sleep(delay);
                if (this.stopping) return;
                pending = this.connectOnce();
            }
        }
    }

    /** One probe/build/connect attempt. */
    private async connectOnce(): Promise<void> {
        await this.probeCouch(PROBE_TIMEOUT_MS);
        // CouchDB answered cleanly, so build against it now: a manipulator built
        // before the probe would have fired its one-shot init at a possibly-down
        // CouchDB, and that init cannot be retried (see buildManipulator).
        this.buildManipulator();
        await this.connectAndWatch();
    }

    /**
     * Stop watching and release what can be released.
     *
     * Two things do NOT happen here, and callers need to know both. First,
     * `close()` does not release every handle the engine holds: a TCP socket and
     * a timer survive it (measured while proving the engine works under Node),
     * so a process that has used this peer will not exit naturally and the
     * shutdown path has to be explicit about ending. Second, in-flight
     * dispatches are not cancelled; they finish against a manipulator that is
     * being torn down, which is why `put`/`delete`/`get` re-check `connected`.
     */
    async stop(): Promise<void> {
        this.stopping = true;
        this.starting = false;
        this.connected = false;
        this.remoteEmpty = false;
        this.degraded = false;
        // A stopped peer holds nothing: the next run arms its feed from the
        // persisted checkpoint, which is the replay the hold was waiting for.
        this.checkpointHeld = false;
        this.wakeFromBackoff?.();
        if (this.watchdog) {
            clearInterval(this.watchdog);
            this.watchdog = undefined;
        }
        const man = this.man;
        this.man = undefined;
        this.instrumented = undefined;
        this.tracker.reset();
        this.progress.reset();
        try {
            man?.endWatch();
        } catch (e) {
            this.log(`endWatch failed: ${describeError(e)}`, 'debug');
        }
        try {
            await man?.close();
        } catch (e) {
            this.log(`close failed: ${describeError(e)}`, 'debug');
        }
    }

    /**
     * Is this peer RUNNING? A lifecycle question, and the one the callers below
     * have always been asking.
     *
     * Kept exactly as it was, deliberately, because three callers depend on the
     * lifecycle reading and would be made worse by the link reading:
     * `services/livesync.ts`'s `dispatchToCouch` uses it to decide whether a push
     * should wait for the first connect attempt to settle, `syncImpl` uses it to
     * decide whether a pass can do anything at all, and `connectImpl` uses it to
     * decide whether the connect it just performed worked. None of those wants a
     * transient feed detachment to change the answer.
     */
    isConnected(): boolean {
        return this.connected;
    }

    /**
     * Is the LINK to CouchDB up right now?
     *
     * THE FLAG THIS REPLACES WAS A LIFECYCLE FLAG WEARING A LINK FLAG'S NAME.
     * `connected` is set once when the connect sequence succeeds and cleared only
     * by an explicit stop or a fatal configuration, so a link that dies mid-session
     * leaves it true indefinitely: measured true throughout a 269-second outage.
     * Two things read badly as a result. `routes/livesync.ts`'s `classifyDetail`
     * has a `not connected to CouchDB` case that was unreachable for any
     * mid-session drop, so the endpoint published the much vaguer `peers not
     * syncing` for the first minute of every outage and named nothing an operator
     * could go and look at; and the `connected` field on the status API, which an
     * operator or the settings panel reads as "is the link up", said yes while it
     * was down.
     *
     * The answer is composed rather than stored, from the two facts that together
     * mean a live connection: the peer is running, and its changes feed is
     * currently attached. `man.watching` is not a strong enough signal on its own
     * (the whole inbound ledger exists because an attached feed can be delivering
     * nothing), but it is exactly the right signal for THIS question: it goes false
     * when the connection errors or completes, which is what a dropped link does,
     * and the watchdog re-arms it as soon as the link is back. `remoteEmpty` is
     * included for the same reason `snapshot()` includes it: a peer connected to a
     * database with no milestone document to reconcile against is connected.
     *
     * Synchronous and free, so a status call costs no network I/O. The expensive,
     * authoritative question ("does CouchDB answer right now?") already has its own
     * answer in `couchReachable()`, which `HealthTracker` calls only when a peer is
     * already unhealthy.
     */
    isLinkUp(): boolean {
        return this.connected && (this.man?.watching === true || this.remoteEmpty);
    }

    /** Set when the configuration itself is unusable. Never cleared by retrying. */
    getFatalReason(): string | undefined {
        return this.fatalReason;
    }

    private markFatal(reason: string): void {
        this.fatalReason = reason;
        this.starting = false;
        this.connected = false;
        // Loud, once, at error level: this is an operator action item, and the
        // alternative (a retry loop) is precisely the silent failure mode this
        // port exists to remove.
        this.log(`refusing to start: ${reason}`, 'error');
    }

    /** Backoff sleep that stop() can cut short. */
    private sleep(ms: number): Promise<void> {
        return new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                this.wakeFromBackoff = undefined;
                resolve();
            }, ms);
            timer.unref?.();
            this.wakeFromBackoff = () => {
                clearTimeout(timer);
                this.wakeFromBackoff = undefined;
                resolve();
            };
        });
    }

    // --- connection ------------------------------------------------------------

    /**
     * (Re)create the underlying `DirectFileManipulator`.
     *
     * A fresh instance per attempt, never a retry against the old one. The
     * constructor kicks off a one-shot async database init whose `ready` promise
     * never resolves (and whose rejection is unhandled) when CouchDB is
     * unreachable, so the only way to recover from a failed connect is to build
     * a new one. This is the bridge's `_buildManipulator()` and its reasoning
     * holds exactly.
     */
    private buildManipulator(): void {
        const prev = this.man;
        const man = new DirectFileManipulator(this.conf);

        /*
         * Force the platform's native fetch, as the bridge does (node:http shims
         * broke long-polling behind a reverse proxy, which is exactly the
         * deployment shape a self-hosted CouchDB tends to have).
         *
         * Two subtleties, both about vendored internals:
         *
         * 1. ASSIGNING AFTER CONSTRUCTION IS SAFE, BUT ONLY JUST. The constructor
         *    calls `void this.liveSyncLocalDB.initializeDatabase()`, and that
         *    method's first statement is `await this._prepareHashFunctions()`.
         *    The await yields before `$$createPouchDBInstance` is reached, so an
         *    override installed synchronously on the very next line (as here)
         *    still wins. If a future engine bump removes that await, the default
         *    factory would be used instead and the only symptom would be
         *    long-polling behaving differently behind a proxy. Verified against
         *    upstream/src/pouchdb/LiveSyncLocalDB.ts at the pinned commit.
         *
         * 2. WE HAVE NO POUCHDB CONSTRUCTOR TO CALL. The bridge imports PouchDB
         *    from commonlib directly; the vendored package deliberately does not
         *    re-export it, and adding `pouchdb-core` as a server dependency to
         *    get one would drag a second copy of PouchDB into the process. So the
         *    constructor is recovered from an instance the default factory makes.
         *    That probe is cheap: `pouchdb-adapter-http` builds its api object
         *    synchronously and defers `setup()` (the HEAD/PUT that creates the
         *    remote database) until the first real operation, so constructing and
         *    immediately closing a handle performs no network I/O.
         *
         * Any failure here falls back to the default factory. A fetch
         * implementation is an optimisation; a connect is not, and this must
         * never be the reason sync does not start.
         */
        const defaultFactory = (name?: string, options?: PouchDatabaseConfiguration): PouchDatabaseHandle =>
            DirectFileManipulator.prototype.$$createPouchDBInstance.call(man, name, options);
        let ctor: PouchConstructor | undefined;
        man.$$createPouchDBInstance = <T extends object>(
            name?: string,
            options?: PouchDatabaseConfiguration,
        ): PouchDatabaseHandle<T> => {
            try {
                if (!ctor) {
                    const probe = defaultFactory(name, options);
                    const candidate = (probe as { constructor?: unknown }).constructor;
                    if (typeof candidate === 'function') ctor = candidate as PouchConstructor;
                    const closeProbe = (probe as { close?: () => Promise<unknown> }).close;
                    if (typeof closeProbe === 'function') void closeProbe.call(probe).catch(() => {});
                }
                if (!ctor) return defaultFactory(name, options) as unknown as PouchDatabaseHandle<T>;
                // Same target and credentials the default factory uses; the only
                // addition is the explicit fetch.
                return new ctor(`${this.conf.url}/${this.conf.database}`, {
                    auth: { username: this.conf.username, password: this.conf.password },
                    fetch: (url: unknown, opts?: unknown) =>
                        globalThis.fetch(
                            url as Parameters<typeof globalThis.fetch>[0],
                            opts as Parameters<typeof globalThis.fetch>[1],
                        ),
                }) as unknown as PouchDatabaseHandle<T>;
            } catch (e) {
                this.log(`native-fetch PouchDB factory unavailable, using the default: ${describeError(e)}`, 'debug');
                return defaultFactory(name, options) as unknown as PouchDatabaseHandle<T>;
            }
        };

        // FIX 4 (part 1): resume from the persisted checkpoint, and default a
        // MISSING one to replay-from-zero rather than the bridge's `|| "now"`.
        // "now" silently discards everything that changed while we were down.
        // The `|| '0'` normalisation is deliberate: PouchDB forwards this value
        // into the `since=` query parameter verbatim, and `0` is a documented
        // CouchDB input where an empty string is not.
        man.since = this.state.getSince() || '0';

        this.man = man;
        // Release the previous instance if this is a rebuild, best-effort and
        // fire-and-forget: it may be mid-init, and the connect path must not
        // block (or fail) on teardown.
        if (prev) void prev.close().catch(() => {});
    }

    /**
     * Probe CouchDB the way PouchDB will: a request whose body must parse as
     * JSON.
     *
     * A half-ready CouchDB, or a proxy error page, returns a non-JSON body, which
     * is the case that used to crash the bridge from deep inside PouchDB's init.
     * Treating it as "not ready yet" turns a hang into a fast, retriable failure.
     */
    private async probeCouch(timeoutMs: number): Promise<void> {
        // Straight from config: the manipulator may not exist yet, and these are
        // the same credentials it will use.
        const url = `${this.conf.url}/${this.conf.database}`;
        const headers: Record<string, string> = {};
        if (this.conf.username) {
            // Buffer, not btoa: `btoa` throws on code points above 0xFF, so a
            // non-ASCII password would make every probe fail forever even though
            // CouchDB would have accepted it. (The bridge works around the same
            // trap by hand-encoding to UTF-8 first; Node just does it.)
            const creds = `${this.conf.username}:${this.conf.password ?? ''}`;
            headers.Authorization = `Basic ${Buffer.from(creds, 'utf8').toString('base64')}`;
        }
        // Bounded, so a hung connection can stall neither the connect loop nor
        // the health probe (a health check that hangs looks exactly like the
        // wedged process it is supposed to detect).
        const res = await globalThis.fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) {
            await res.body?.cancel();
            throw new Error(`CouchDB not ready: HTTP ${res.status}`);
        }
        await res.json();
    }

    /**
     * Is CouchDB up right now? Same success threshold as the connect probe.
     *
     * A FATALLY MISCONFIGURED PEER REPORTS ITS BACKEND DOWN, whatever CouchDB
     * says. This reads as a lie and is not one: `backendUp` exists for exactly one
     * consumer, `HealthTracker`'s `restartWorthy`, whose question is "would
     * restarting plausibly help?". For a wrong passphrase, a compression mismatch
     * or a database that cannot be decrypted the answer is no, at any hour of any
     * day, and answering yes puts `routes/livesync.ts`'s `maybeRestart` into a
     * restart-every-cooldown loop over a fault that only an operator can fix. The
     * condition is not hidden: `fatalReason` is reported by `snapshot()`,
     * `getFatalReason()` and the status API, all of which say precisely what is
     * wrong.
     */
    private async couchReachable(): Promise<boolean> {
        if (this.fatalReason) return false;
        try {
            await this.probeCouch(REACHABLE_TIMEOUT_MS);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Does the remote hold non-chunk changes past the point the FEED has reached?
     *
     * The one fact no in-process counter can produce, and the one that separates
     * IDLE from WEDGED when the feed has gone quiet: an attached long-poll whose
     * connection is being black-holed by a proxy delivers nothing, raises nothing,
     * and leaves `watching` true forever. Counting what arrives cannot see that,
     * because the whole failure is that nothing arrives.
     *
     * Three details are load-bearing:
     *
     *  - THE SELECTOR MUST MATCH THE FEED'S, IN BOTH DIRECTIONS. `beginWatch`
     *    opens the feed with `{ type: { $ne: "leaf" } }`, so chunk documents never
     *    reach it and never advance its cursor. An unfiltered probe would see
     *    every chunk written by any client as "pending", which on a busy remote is
     *    always, so a healthy peer would report itself wedged permanently. The
     *    converse bites just as hard and is less obvious: everything the selector
     *    DOES admit has to advance the cursor, or the probe measures against a
     *    position the feed has already passed. That is what `instrumentFeed()`
     *    now guarantees, and its comment lists the document types that made the
     *    earlier, narrower rule fail.
     *  - THE CURSOR IS THE FEED'S, NOT THE CHECKPOINT'S. See `InboundProgress`'s
     *    `cursor` field: the checkpoint only advances for documents this peer is
     *    interested in, so on a remote that also carries `i:` internal documents
     *    it lags forever by design.
     *  - AN UNANSWERABLE PROBE RETURNS `undefined`, not `false` and not `true`.
     *    `filter=_selector` needs CouchDB 2.0, a proxy can refuse a POST, and a
     *    network can drop. None of those is evidence about the feed, so none of
     *    them may be reported as one. `tickPendingProbe` routes that answer to
     *    `noteProbeUnanswerable()`, which fails towards unhealthy rather than
     *    towards silence.
     */
    private async probeRemotePending(): Promise<boolean | undefined> {
        const since = this.progress.getCursor() ?? this.state.getSince() ?? '';
        const query = new URLSearchParams({
            since: since || '0',
            limit: '1',
            timeout: '0',
            feed: 'normal',
            filter: '_selector',
        });
        const url = `${this.conf.url}/${this.conf.database}/_changes?${query.toString()}`;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (this.conf.username) {
            // Buffer, not btoa: btoa throws above code point 0xFF, so a non-ASCII
            // password would make every probe fail forever. Same reasoning as
            // probeCouch, and deliberately the same spelling.
            const creds = `${this.conf.username}:${this.conf.password ?? ''}`;
            headers.Authorization = `Basic ${Buffer.from(creds, 'utf8').toString('base64')}`;
        }
        const res = await globalThis.fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ selector: { type: { $ne: 'leaf' } } }),
            signal: AbortSignal.timeout(REMOTE_PENDING_TIMEOUT_MS),
        });
        if (!res.ok) {
            await res.body?.cancel();
            throw new Error(`CouchDB refused the pending-changes probe: HTTP ${res.status}`);
        }
        const body = (await res.json()) as { results?: unknown };
        // A body without `results` is not an answer. Treating a shape we do not
        // recognise as "nothing pending" would be the silent direction to fail in.
        if (!Array.isArray(body.results)) return undefined;
        return body.results.length > 0;
    }

    /**
     * Wait for the manipulator's one-shot init, bounded.
     *
     * `ready` never settles if the init failed, so racing it against a timeout is
     * what turns a permanent hang into a retriable failure.
     */
    private waitReady(timeoutMs: number): Promise<void> {
        const man = this.man;
        if (!man) return Promise.reject(new Error('manipulator was torn down while connecting'));
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('CouchDB init timed out')), timeoutMs);
            timer.unref?.();
        });
        return Promise.race([man.ready.promise, timeout]).finally(() => {
            if (timer !== undefined) clearTimeout(timer);
        });
    }

    /**
     * Reconcile with the remote, then attach the changes feed.
     *
     * ORDER IS LOAD-BEARING, and it is the reverse of what reads naturally.
     * Tweak adoption happens FIRST and the milestone handshake second, so that
     * what we publish about ourselves describes the settings we are actually
     * going to write with. Handshake first would register the pre-adoption
     * configuration, which is the one we are about to abandon, and would report a
     * mismatch against the cluster's preferred values that adoption was on its way
     * to resolving.
     */
    private async connectAndWatch(): Promise<void> {
        await this.waitReady(READY_TIMEOUT_MS);
        let man = this.man;
        if (!man) throw new Error('manipulator was torn down while connecting');

        const milestone = await man.rawGet<EntryMilestoneInfo>(MILESTONE_DOCID);

        if (milestone && milestone.tweak_values && this.conf.useRemoteTweaks) {
            const { merged, changes } = mergeRemoteTweaks(this.conf, milestone.tweak_values);
            if (changes.length > 0) {
                this.log('remote tweaks differ from the local configuration, adopting:');
                for (const line of changes) this.log(`  ${line}`);
                this.conf = merged;
                /*
                 * Rebuild rather than reach inside.
                 *
                 * The bridge assigns `man.options` and then calls
                 * `man.liveSyncLocalDB.initializeDatabase()` to make the engine
                 * pick the new settings up. `liveSyncLocalDB` is engine-internal
                 * plumbing that the vendored package's declarations deliberately
                 * do not expose, and reaching through them with a cast would make
                 * this file silently dependent on an internal that a version bump
                 * is free to rename. Constructing a fresh manipulator runs the
                 * same initialisation through the supported entry point, and this
                 * peer already knows how to build one.
                 */
                this.buildManipulator();
                await this.waitReady(READY_TIMEOUT_MS);
                man = this.man;
                if (!man) throw new Error('manipulator was torn down while adopting remote tweaks');
            }
        }

        const effective = await this.handshakeMilestone(man, milestone);

        /*
         * The remote is "empty" only if the handshake could not settle it either.
         * With the handshake in place that means one thing: `ensureRemoteIsCompatible`
         * decided no write was needed AND handed back no document, which cannot
         * happen for a missing milestone (a missing one always writes). The branch
         * is kept rather than deleted because `remoteEmpty` still feeds the health
         * snapshot, and a peer that silently reported "not syncing" because a
         * future refactor stopped producing a document would be the same class of
         * bug this file exists to remove.
         */
        if (!effective) {
            this.remoteEmpty = true;
            this.state.setRemoteCreated('0');
            this.log('remote database looks empty; watching from the first sequence.');
        } else {
            this.remoteEmpty = false;
            const created = String(effective.created ?? '');
            if (this.state.getRemoteCreated() !== created) {
                /*
                 * A different `created` means a different database wearing the
                 * same name. Every sequence number we remember belongs to the old
                 * one, so the only safe checkpoint is the beginning.
                 *
                 * Note what changed with the handshake: when WE seed the document,
                 * `created` is now a real timestamp rather than the `'0'` marker
                 * the bridge records. Recording the real value is what stops the
                 * NEXT connect from reading our own freshly written milestone as
                 * someone else's rebuild and forcing a pointless replay from
                 * sequence zero on every single start.
                 */
                this.log('remote database looks rebuilt; fetching from the first sequence again.', 'notice');
                this.state.setRemoteCreated(created);
                this.state.setSince('0');
            } else {
                this.log(`watch starting from sequence ${this.state.getSince() || '0'}`);
            }
        }

        this.startWatch();
        this.startWatchdog();
    }

    /**
     * Announce this peer to the cluster, and find out whether the cluster will
     * have it.
     *
     * THE BUG THIS EXISTS FOR. The reference bridge reads the milestone document
     * and never writes it. Against the bridge author's own deployment that is
     * invisible, because an Obsidian client always initialised the database
     * first, so the bridge is never the seeder. WebObsidian is positioned as a
     * first-class backend that may be pointed at an empty CouchDB, which is
     * precisely the case the bridge never exercises, and it fails in two ways
     * that produce no error anywhere:
     *
     *  1. SEEDING RACE. We write documents into an empty database using engine
     *     defaults (`buildCouchConf` sets only url/db/credentials/passphrases, so
     *     everything else falls through to `DEFAULT_SETTINGS`). Some time later an
     *     Obsidian client connects, finds no milestone, and seeds one from ITS
     *     settings, which for a current plugin differ from those defaults out of
     *     the box (`chunkSplitterVersion`, `enableChunkSplitterV2`,
     *     `doNotUseFixedRevisionForChunks`). Nothing complains, because there was
     *     nothing to compare against. On our next restart we adopt those values.
     *     The chunking half of that is storage bloat rather than data loss (reads
     *     resolve chunks by the ids stored on the document, so existing documents
     *     stay readable), but `handleFilenameCaseSensitive` is a genuine silent
     *     fork: it is passed to `path2id_base` as `caseInsensitive`, so flipping
     *     it changes the document ID of every path containing an uppercase
     *     character. Everything we previously wrote is then orphaned under an id
     *     we will never GET or PUT again. Updates create a second document,
     *     deletes miss, and the vault diverges with no error on any side.
     *  2. THE LOCK IS IGNORED. `locked` and `cleaned` are how the engine stops
     *     clients writing into a database that is being rebuilt or having its
     *     chunks garbage collected. A peer that never reads them keeps writing
     *     against chunks a clean-up is in the middle of deleting.
     *
     * Both are closed by one call to the engine's own `ensureRemoteIsCompatible`.
     * Driving the engine matters more than it looks: a hand-rolled milestone that
     * disagreed with the engine's format would be a worse bug than the one it
     * fixed, because the document is a wire contract with every Obsidian client
     * on the cluster.
     *
     * Returns the document as it now stands remotely, or `false` if the engine
     * decided nothing needed writing and there was nothing to read.
     */
    private async handshakeMilestone(
        man: DirectFileManipulator,
        milestone: EntryMilestoneInfo | false,
    ): Promise<EntryMilestoneInfo | false> {
        const nodeId = this.state.getNodeId();

        // Before anything is written, and not derived from the engine's verdict.
        // See `assertNotLockedOut` for why the verdict cannot be trusted for this.
        if (milestone) this.assertNotLockedOut(milestone, nodeId);

        /*
         * Two fields have to be corrected before they are published, or we
         * announce something we do not do. Both are upstream inconsistencies in
         * `DirectFileManipulator`'s `settings` getter
         * (`DirectFileManipulatorV2.ts:241-277`), which maps most of its options
         * onto the settings object and forgets these:
         *
         *  - `usePathObfuscation` is never set, so it reports
         *    `DEFAULT_SETTINGS.usePathObfuscation === false` even while
         *    `path2id` is actively obfuscating because `obfuscatePassphrase` is
         *    set (`:140-148`). Publishing that would tell the cluster our ids are
         *    readable paths when they are `f:<hash>`, which is the single most
         *    consequential thing a client can be wrong about: the two document
         *    sets never intersect and both sides silently sync half a vault.
         *  - `useDynamicIterationCount` is never set either, though
         *    `$everyOnInitializeDatabase` reads `this.options.useDynamicIterationCount`
         *    directly when it enables encryption (`:210`).
         *
         * `handleFilenameCaseSensitive` is pinned to an explicit `false` rather
         * than left to fall through, for a subtler reason: its engine default is
         * literally `undefined` (`types.ts:1187`), and the mismatch comparison
         * runs `isObjectDifferent(..., ignoreUndefined = true)`, which SKIPS any
         * key that is undefined on either side. Shipping `undefined` would
         * therefore disable the mismatch check on the one field with the worst
         * failure mode. `false` is also the truth: `path2id` passes
         * `!options.handleFilenameCaseSensitive`, and `!undefined` is `true`, i.e.
         * case-insensitive, i.e. exactly what `false` means.
         *
         * The engine reduces this object with `extractObject(TweakValuesTemplate, ...)`
         * before it reaches the document, and that template contains no
         * `passphrase`, no `couchDB_PASSWORD` and no `couchDB_URI`, so nothing
         * secret is published. That is asserted by a test rather than trusted.
         */
        const announced: RemoteDBSettings = {
            ...man.settings,
            usePathObfuscation: Boolean(this.conf.obfuscatePassphrase),
            useDynamicIterationCount: this.conf.useDynamicIterationCount ?? false,
            handleFilenameCaseSensitive: this.conf.handleFilenameCaseSensitive ?? false,
        };

        /*
         * The engine mutates and hands back the document it wrote, but only
         * through this callback: when the milestone was missing it builds one
         * internally and the caller never otherwise sees it. Capturing it here is
         * the only way to learn the `created` timestamp of a document we just
         * seeded, which the checkpoint logic above needs.
         */
        let written: EntryMilestoneInfo | undefined;
        const result = await ensureRemoteIsCompatible(
            milestone,
            announced,
            nodeId,
            CURRENT_VERSION_RANGE,
            async (info) => {
                written = info;
                /*
                 * A raw put, because the document's shape IS the contract, and it
                 * takes the document unchanged: no cast, because the vendored
                 * `EntryMilestoneInfo` is declared as a type alias rather than an
                 * interface precisely so it satisfies `putRaw`'s parameter without
                 * one. A cast here would be the place a future shape change stops
                 * being checked.
                 *
                 * It still passes through the transform-pouch transforms the engine
                 * installs, which is both unavoidable and harmless: `compressDoc`
                 * returns any document without a `data` field untouched, and
                 * `incomingEncryptHKDF` only rewrites chunk entries, the syncinfo
                 * entry, obfuscated (`f:`) ids and non-empty `eden`. The milestone
                 * matches none of those, and the Obsidian plugin writes the same
                 * document through the same transforms.
                 *
                 * A rejection here (a read-only CouchDB user, or a 409 from two
                 * clients seeding at the same instant) propagates out of
                 * `connectAndWatch` into the connect retry loop, which is correct
                 * for both: a peer that cannot write the milestone cannot write
                 * documents either, and a 409 resolves itself on the next attempt
                 * because that attempt re-reads the document the winner wrote.
                 */
                await man.liveSyncLocalDB.putRaw(info);
            },
        );

        this.applyEnsureResult(result, milestone !== false, announced);
        return written ?? milestone;
    }

    /**
     * Refuse to touch a database that has been locked against this node.
     *
     * THE ENGINE'S VERDICT CANNOT BE USED FOR THIS, and finding that out is the
     * reason this function exists rather than a branch on `NODE_LOCKED`.
     * `ensureRemoteIsCompatible` checks the settings mismatch FIRST and returns
     * early (`LiveSyncDBFunctions.ts:105-120`), so a milestone that is both
     * mismatched and locked reports only MISMATCHED. The lock check at `:122`
     * is never reached. Verified against the vendored engine, not assumed.
     *
     * The Obsidian plugin does not notice because it stops on every non-OK
     * verdict, so masking one stop with another changes nothing for it. This peer
     * deliberately CONTINUES past a mismatch confined to keys it cannot control
     * (see `applyMismatch`), which turns the same ordering into a hole: a
     * `usePluginSyncV2` difference, which an ordinary plugin user has by default,
     * would hide a chunk clean-up in progress and we would keep writing against
     * chunks that are being deleted. That is the corruption scenario KICKOFF names
     * as the top risk, so it is checked here, directly, on the document.
     *
     * Placed before the handshake WRITE as well as before the feed: registering
     * ourselves in a database that has refused us is pointless noise in a document
     * every other client reads.
     */
    private assertNotLockedOut(milestone: EntryMilestoneInfo, nodeId: string): void {
        if (!milestone.locked) return;
        if (Array.isArray(milestone.accepted_nodes) && milestone.accepted_nodes.includes(nodeId)) {
            /*
             * Locked, but this node IS accepted. The engine's own consumer
             * (`LiveSyncReplicator.ts:867`) proceeds here, and so do we: the lock
             * exists to keep UNACCEPTED nodes out, and diverging would mean
             * refusing a database every Obsidian client on the cluster is happily
             * replicating. Loud anyway, because an operator who did not knowingly
             * lock this database wants to know.
             */
            this.log(
                'the remote database is marked locked, but this server is listed as an accepted node, ' +
                    'so replication continues. Someone rebuilt or cleaned this database.',
                'notice',
            );
            return;
        }

        /*
         * Locked and NOT accepted. Neither `cleaned` nor a plain lock heals by
         * waiting, and both mean the same thing for our stored state: the remote
         * has been rebuilt or had its chunks garbage collected, so our checkpoint
         * points into a sequence space that no longer exists and the chunks our
         * documents reference may already be gone.
         *
         * There is no unlock action on this side, deliberately. Unlocking asserts
         * that this client has re-fetched the rebuilt database, and this peer has
         * no rebuild flow that would make the assertion true. Recovery is an
         * operator action from a plugin client followed by a restart here (a fatal
         * reason is only cleared by `start()`), and the message says so rather
         * than leaving it to be guessed.
         */
        const what = milestone.cleaned ? 'cleaned up (chunk garbage collection)' : 'rebuilt or locked';
        throw new LiveSyncFatalError(
            `The remote database has been ${what} since this server last synchronised, and this server ` +
                'is not among the nodes accepted afterwards. Continuing would write into a database that ' +
                'has been declared rebuilt, against chunks that may already be deleted, so the peer has ' +
                'stopped. Unlock the database (or mark this device resolved) from a Self-hosted LiveSync ' +
                'client, then restart the backend.',
        );
    }

    /**
     * Act on the engine's verdict.
     *
     * The three lock verdicts are handled here only as a backstop: `assertNotLockedOut`
     * has already made the same judgement directly on the document, and made it
     * first, precisely because the engine's mismatch check can return before its
     * lock check ever runs. Reaching one of them here means the document said
     * something the direct check did not, so it is treated the same way rather
     * than assumed unreachable.
     *
     * Stopping is a thrown `LiveSyncFatalError`, which `connectLoop` turns into a
     * recorded reason instead of another retry, and which `requireReady` then uses
     * to refuse every subsequent `put`/`delete`. That last part is the point: for
     * these conditions, continuing to WRITE is the corruption scenario, not merely
     * an unhealthy state.
     */
    private applyEnsureResult(result: ENSURE_DB_RESULT, existed: boolean, announced: RemoteDBSettings): void {
        if (result === 'OK' || result === 'LOCKED') {
            // LOCKED means locked-but-accepted, which `assertNotLockedOut` has
            // already reported. Nothing further to say.
            if (result === 'OK' && !existed) {
                this.log(
                    'remote database had no milestone document; seeded one and registered this server ' +
                        'in it, so a client joining later reconciles against our format instead of ' +
                        'silently seeding a different one.',
                    'notice',
                );
            }
            return;
        }

        if (result === 'NODE_LOCKED' || result === 'NODE_CLEANED') {
            const what = result === 'NODE_CLEANED' ? 'cleaned up (chunk garbage collection)' : 'rebuilt';
            throw new LiveSyncFatalError(
                `The remote database has been ${what} since this server last synchronised, and this ` +
                    'server is not among the nodes accepted afterwards. Continuing would write into a ' +
                    'database that has been declared rebuilt, against chunks that may already be ' +
                    'deleted, so the peer has stopped. Unlock the database (or mark this device ' +
                    'resolved) from a Self-hosted LiveSync client, then restart the backend.',
            );
        }

        if (result === 'INCOMPATIBLE') {
            throw new LiveSyncFatalError(
                'The remote database uses a chunk format outside the range this server can read ' +
                    `(${CURRENT_VERSION_RANGE.min}-${CURRENT_VERSION_RANGE.max}). Retrying cannot help; ` +
                    'the engine bundled with this server has to be updated.',
            );
        }

        // Only ["MISMATCHED", preferred] is left, and the tuple form is what
        // narrows it: the string cases are all handled above.
        this.applyMismatch(result[1], announced);
    }

    /**
     * A settings mismatch against the cluster's preferred values, after adoption
     * has already had its turn.
     *
     * WHY THIS IS NOT SIMPLY FATAL. `ensureRemoteIsCompatible` compares the whole
     * of upstream's `TweakValuesShouldMatchedTemplate`, which is scoped to the
     * Obsidian plugin. Three of its keys are ones this server has no option for
     * and therefore cannot make agree at any price, and one of those three
     * (`usePluginSyncV2`) differs from an ordinary plugin user BY DEFAULT: the
     * engine's default is `false` and its own recommended template says `true`.
     * A blanket fatal would mean refusing to sync with a normal cluster over a
     * flag that governs documents this peer never touches. See
     * `BEHAVIOUR_FREE_TWEAK_KEYS` for the per-key evidence.
     *
     * So the verdict is split on which keys actually differ. Anything outside
     * that audited set is format-relevant and IS fatal, which is what finally
     * closes the two silent-divergence directions `mergeRemoteTweaks` could not
     * see: a remote that says `encrypt: false` while we hold a passphrase, and a
     * remote that says `usePathObfuscation: false` while we obfuscate. Both are
     * one-way holes there (it only throws when the REMOTE has the feature on and
     * we do not), and both produce two document sets that never intersect.
     */
    private applyMismatch(preferred: TweakValues, announced: RemoteDBSettings): void {
        const differing = mismatchedKeys(preferred, announced);

        /*
         * The engine said the settings mismatch and we cannot name a single key
         * that does. That is not a benign case, it is evidence that
         * `mismatchedKeys` and `ensureRemoteIsCompatible` have stopped agreeing,
         * and dismissing a verdict we cannot classify is exactly the silent
         * failure this file exists to remove. Refuse instead, and say why in terms
         * that point at this code rather than at the operator's settings.
         */
        if (differing.length === 0) {
            throw new LiveSyncFatalError(
                'The remote reports that this server\'s settings do not match the cluster\'s preferred ' +
                    'settings, but this server cannot determine which setting differs. That is an ' +
                    'internal inconsistency, not a configuration error, and it is treated as fatal ' +
                    'because continuing would mean ignoring a mismatch nobody can see. Please report it.',
            );
        }

        const harmful = differing.filter((k) => !BEHAVIOUR_FREE_TWEAK_KEYS.has(k));

        if (harmful.length === 0) {
            this.log(
                `the cluster's preferred settings differ from this server's on ${differing.join(', ')}. ` +
                    'These have no effect on the documents this server reads or writes, so replication ' +
                    'continues; unify them from the Obsidian clients if you want the warning to stop.',
                'notice',
            );
            return;
        }

        throw new LiveSyncFatalError(
            `This server's settings disagree with the cluster's preferred settings on ${harmful.join(', ')}. ` +
                'These decide how documents are encrypted, split and named, so continuing would write ' +
                'documents the other clients cannot read (or under ids they will never look at, which ' +
                'forks the vault silently). Make them agree; retrying cannot help.',
        );
    }

    // --- the changes feed ------------------------------------------------------

    private startWatch(): void {
        const man = this.man;
        if (!man || this.stopping) return;
        const baseDir = this.conf.baseDir ?? '';
        // Re-read the checkpoint on every (re)arm so a reconnect resumes where the
        // last processed change left off rather than where this process started.
        man.since = this.state.getSince() || '0';
        /*
         * Arming the feed from the persisted checkpoint is the event that RELEASES
         * the checkpoint hold, and it is the only one.
         *
         * The hold (see the apply callback below) stops the checkpoint moving past
         * a change that failed to apply, so that the change is replayed instead of
         * being skipped. Everything after the held position is then re-delivered
         * by the very next feed the peer opens, which is this one: the failed
         * changes get another attempt, and the ones that already succeeded are
         * re-applied harmlessly, since an inbound write is idempotent (same
         * content, same mtime, same resulting baseline).
         *
         * Releasing HERE rather than on the next successful apply is what keeps the
         * checkpoint honest. A later success is no evidence about the change that
         * failed; only a replay that re-delivers it is. Releasing on the assignment
         * above also keeps the two facts adjacent, so a reader can see that the
         * position the hold was protecting is exactly the position the feed is
         * about to resume from.
         *
         * It can never release the hold for a feed that is still running: the
         * connect sequence reaches this through `connectAndWatch` with a freshly
         * built manipulator, and the watchdog reaches it only after finding
         * `man.watching` false.
         *
         * THE ENGINE CAN ALSO ARM A FEED WITHOUT COMING THROUGH HERE, and the flag
         * is deliberately left set when it does. Its `error` handler clears
         * `watching` and schedules its own `beginWatch` ten seconds later
         * (`DirectFileManipulatorV2.ts:473-486`), which re-reads `man.since` and so
         * performs the same replay. Our watchdog ticks every five seconds and
         * therefore normally wins that race, but if it ever did not, the hold would
         * simply stand: the checkpoint stops advancing, the ledger reports `behind`
         * once the grace window passes, and the supervisor's restart clears it.
         * Erring towards a checkpoint that is too old costs re-applied work, which
         * is idempotent; erring the other way costs a note.
         */
        this.checkpointHeld = false;
        this.progress.noteCheckpointReleased();
        /*
         * Hand the ledger the evidence that OUTLIVES this run, before the first
         * document can arrive.
         *
         * Here rather than in `start()` because this is the point where the feed
         * is armed, and it is the only point on every path that arms one
         * (`start()` reaches it through the connect loop, the watchdog's re-arm
         * reaches it directly). Getting this wrong is silent and expensive: a peer
         * that failed to adopt its own history reads the first undecryptable
         * document as proof of a wrong passphrase, stops itself, and blocks the
         * push direction. See `InboundProgress.adoptPriorDecodeEvidence`.
         */
        if (this.state.hasDecodedWith(this.decodeEvidenceKey)) this.progress.adoptPriorDecodeEvidence();
        man.beginWatch(
            async (entry: ReadyEntry, seq?: string | number) => {
                const key = changeKey(undefined, entry?._id);
                let applied: boolean;
                try {
                    applied = await this.onRemoteChange(entry);
                } catch (e) {
                    /*
                     * COUNTED AND SAID OUT LOUD, then rethrown unchanged.
                     *
                     * The engine catches whatever this callback throws and logs
                     * `WATCH: PROCESS FAILED` at its INFO level with the reason at
                     * VERBOSE, so before this block a remote document that could
                     * not be written to the vault vanished without a single line
                     * an operator would ever see. Rethrowing preserves the
                     * behaviour that actually protects the data (the checkpoint
                     * advance below is skipped, so the change is not marked as
                     * consumed), while the counter makes the loss visible: see
                     * `InboundProgress.noteFailed` for why a failure settles the
                     * ledger instead of pinning it, and `syncImpl` for where the
                     * per-pass verdict is derived from it.
                     */
                    this.progress.noteFailed(key);
                    /*
                     * FIX 4 (part 3): HOLD THE CHECKPOINT, do not merely decline to
                     * advance it for this one sequence.
                     *
                     * Skipping the advance below is necessary and was not
                     * sufficient, and the gap between those two is a measured data
                     * loss. `state.setSince` records a single HIGH-WATER MARK, so
                     * the very next change that applies writes its own, higher
                     * sequence straight over the failure. A high-water mark cannot
                     * express "everything up to 14 except 6, 7 and 8": once it
                     * reads 14, the sequences that failed are behind it and no
                     * replay will ever deliver them again. Measured against a real
                     * CouchDB: the checkpoint sat at 5 through three failed writes,
                     * jumped to 14 when the next document landed, three notes were
                     * missing from the vault permanently, and the status API
                     * reported `state: idle`, `healthy: true`, `applied.pulled: 4`
                     * with `/healthz/livesync` serving 200 throughout. Even a
                     * deliberate disconnect and reconnect did not recover them,
                     * because the checkpoint they resumed from was already past.
                     *
                     * So the flag below turns the checkpoint into a LOW-water mark:
                     * it stops advancing at the earliest unresolved failure and
                     * stays there, and the peer keeps applying everything after it
                     * in the meantime, so nothing is delayed except the record of
                     * how far we have got. It is released by `startWatch`, i.e. by
                     * the replay that re-delivers the failed changes. That is what
                     * makes the at-least-once claim below true rather than
                     * conditional: without it, the claim held only for as long as
                     * no LATER change succeeded, which on any active vault is
                     * seconds.
                     *
                     * The cost is stated rather than hidden: while the hold stands,
                     * a restart replays every change made since it began, and that
                     * tail grows with time. It is re-applied idempotently, and the
                     * ledger reports the hold (`InboundProgress.noteCheckpointHeld`,
                     * and the `behind` state once it outlasts its grace window) so
                     * a hold that is not clearing itself becomes an operator's
                     * problem rather than a silent one. Re-applying work is the
                     * recoverable direction; skipping it is not.
                     */
                    this.checkpointHeld = true;
                    this.progress.noteCheckpointHeld();
                    this.log(`could not apply a remote change: ${describeError(e)}`, 'error');
                    throw e;
                }
                /*
                 * FIX 4 (part 2): advance the checkpoint HERE, from the change's
                 * own sequence, and only after the change has been applied.
                 *
                 * The bridge advances nothing: it writes `this.man.since` from
                 * inside `checkIsInterested`, and `beginWatch` never assigns
                 * `man.since` (verified in the vendored engine: it reads `since`
                 * when opening the feed and never writes it back). So the value
                 * persisted is the value it started with, and after a restart the
                 * peer resumes from "now" and every change made while it was down
                 * is lost with no event that could ever repair it.
                 *
                 * Advancing after the dispatch, rather than before, makes the
                 * semantics at-least-once: a crash mid-change replays it, which is
                 * safe (the same content lands again), whereas advancing first
                 * would drop it. A throw from `onRemoteChange` skips this line
                 * entirely, which is exactly what we want for a failed local write.
                 * Note that the engine catches and logs whatever the callback
                 * throws, so a throw here stops the checkpoint without stopping the
                 * feed.
                 *
                 * `checkpointHeld` is the part that makes "skips this line" mean
                 * something durable: see part 3 in the catch above. While it is
                 * set, a SUCCESSFUL apply does not advance the checkpoint either,
                 * because the earlier failure is still unreplayed and moving the
                 * mark past it would skip it forever. `man.since` is held in step
                 * with the persisted value deliberately, since it is what the next
                 * re-arm resumes from; letting the in-memory copy run ahead would
                 * lose the failures on the engine's own ten-second feed reconnect,
                 * which is the most likely replay to happen at all.
                 */
                if (seq !== undefined && seq !== null && !this.checkpointHeld) {
                    const value = String(seq);
                    man.since = value;
                    this.state.setSince(value);
                }
                /*
                 * Last, and split on what the storage side actually did with it.
                 *
                 * `dispatch` returns false without throwing for a document this
                 * server refuses to host: an excluded path (`.trash/`, any
                 * dot-prefixed segment, `.git`, `.obsidian`), a path that fails
                 * `resolveInVault`, one that resolves to the vault root, or an
                 * echo of our own push. The boolean used to be discarded, so all
                 * of those counted as `applied`, which overstated the counter,
                 * disagreed with `rt.pulled` (which is incremented from the same
                 * boolean in `dispatchToStorage`), and made the one number an
                 * operator would use to check the ledger against the status API
                 * quietly wrong.
                 *
                 * The CHECKPOINT still advances on a refusal, deliberately, and
                 * `StoragePeer.put`'s own doc comment explains why: a refused path
                 * replayed forever would pin the feed at that sequence. Only the
                 * classification changes here, and `noteSkipped` is the correct
                 * one because a refusal is a terminal outcome rather than a loss.
                 */
                if (applied) this.progress.noteApplied(key);
                else this.progress.noteSkipped(key);
            },
            (doc: MetaEntry) => {
                /*
                 * The interest predicate doubles as the DECODE receipt, and that
                 * is the only place such a receipt can be taken.
                 *
                 * The engine calls this from inside its `change` listener, which
                 * runs after `transform-pouch` has awaited `outgoing(doc)`. So
                 * reaching this line is proof the document decrypted; NOT reaching
                 * it, for a document the raw feed already counted as delivered, is
                 * proof it did not. Nothing downstream can distinguish the two,
                 * because a rejected `outgoing` never calls the engine's listener
                 * at all (mechanism 1 in progress.ts).
                 */
                const key = changeKey(undefined, doc?._id);
                this.progress.noteDecoded(key);
                /*
                 * The same proof, written down where it survives this process.
                 *
                 * This is the ONLY caller, and it is on the proof itself rather
                 * than on anything that merely correlates with it, because the
                 * record suppresses the fatal "nothing decrypts" verdict. Cheap
                 * enough to do per document: the store compares a string and only
                 * marks itself dirty when the value actually changes, so this is
                 * one write per configuration rather than one per change.
                 */
                this.state.markDecodedWith(this.decodeEvidenceKey);
                const interested = this.isInterested(doc, baseDir);
                // A deliberate refusal is a terminal outcome, not a loss. Without
                // this the ledger would treat every `i:` document on the remote as
                // a document we failed to write, and report a healthy peer wedged.
                if (!interested) this.progress.noteSkipped(key);
                return interested;
            },
        );
        this.instrumentFeed();
    }

    /**
     * Attach a counting listener to the RAW changes emitter.
     *
     * WHY `addListener` AND NOT `on`. Decryption is a `transform-pouch` transform,
     * and that library's `changes()` wrapper replaces the emitter's `on` with
     *
     *     async (change) => origListener(await modifyChange(change))
     *
     * where `modifyChange` decrypts. Registering through `on` would therefore put
     * this counter BEHIND the very decryption whose failure it exists to detect,
     * and would additionally decrypt every document a second time. `addListener`
     * is the untouched `EventEmitter.prototype` method (transform-pouch installs
     * its wrapper as an own property named `on` and nothing else), so a listener
     * registered through it sees the document exactly as CouchDB sent it.
     *
     * THAT IS A DEPENDENCY-VERSION ASSUMPTION, SO IT IS CHECKED RATHER THAN
     * TRUSTED. If a future transform-pouch wraps `addListener` too, the wrapper
     * would be an own property of the emitter and this counter would be swallowed
     * in exactly the case it was written for: the subsystem would go back to
     * reporting green while doing nothing. The `hasOwnProperty` check below turns
     * that into a loud, permanent "unobservable" verdict instead.
     */
    private instrumentFeed(): void {
        const changes = this.man?.changes;
        if (!changes || this.instrumented === changes) return;
        const emitter = changes as unknown as RawChangesEmitter;
        if (
            typeof emitter.addListener !== 'function' ||
            Object.prototype.hasOwnProperty.call(changes, 'addListener')
        ) {
            this.progress.setObservable(false);
            this.log(
                'the changes feed cannot be instrumented, so a wedged inbound direction would be ' +
                    'indistinguishable from an idle one; reporting unhealthy rather than guessing.',
                'error',
            );
            return;
        }
        this.progress.setObservable(true);
        this.instrumented = changes;
        emitter.addListener('change', (change: RawFeedChange) => {
            /*
             * Runs inside PouchDB's emitter, so it must never throw: an exception
             * here would propagate out of `emit()` and take the feed down, turning
             * a health instrument into the outage it measures.
             */
            try {
                if (!change) return;
                /*
                 * EVERY CHANGE ADVANCES THE CURSOR. ONLY NOTE-TYPED CHANGES OWE A
                 * DECODE RECEIPT. Those are two questions, and an earlier revision
                 * answered them with one `if`, which is the bug this shape exists
                 * to prevent.
                 *
                 * The feed's server-side selector is `{ type: { $ne: "leaf" } }`
                 * (upstream `beginWatch`), and `probeRemotePending()` asks CouchDB
                 * with the identical selector from the cursor this call sets. So
                 * the cursor has to move for everything that selector admits, not
                 * just for the subset the engine goes on to decode. Real,
                 * replicated, non-`_local` types that pass it and that upstream's
                 * `isNoteEntry` then drops: `versioninfo` (id
                 * `obsydian_livesync_version`, written to the REMOTE by upstream's
                 * own version negotiation on every version bump), `syncinfo`,
                 * `notes` (the legacy note type, i.e. every document in a vault
                 * migrated from an older LiveSync) and `chunkpack`. Gate the
                 * cursor on `isNoteEntryType` and any one of them sitting past it
                 * makes the probe answer "pending" for the life of the process:
                 * `snapshot().ok` goes false, `couchReachable()` stays true
                 * because nothing is actually wrong, the peer is judged
                 * restart-worthy every grace window, `/healthz/livesync` serves a
                 * permanent 503, and the reset on reconnect only restarts the
                 * loop. Nothing in that chain is recoverable without an operator,
                 * over a database that is working perfectly.
                 *
                 * The decode receipt is the separate question, and it keeps the
                 * narrower predicate for a reason of its own: only `newnote` and
                 * `plain` reach `checkIsInterested`, so only those can ever
                 * produce the receipt `InboundProgress.noteDecoded()` records.
                 * Claiming a `versioninfo` owed one would open a gap no decode
                 * could ever close and report a healthy peer as unable to decrypt.
                 *
                 * `change.doc` may legitimately be absent (a change row without an
                 * included document); the sequence is still real and the feed
                 * still delivered it, so the cursor still moves.
                 *
                 * The third argument is the document identity the ledger's stall
                 * clocks correlate on: see `changeKey()`, and `PendingClock` in
                 * progress.ts for what the clocks do with it.
                 */
                this.progress.noteFeedChange(
                    change.seq,
                    isNoteEntryType(change.doc?.type),
                    changeKey(change.id, change.doc?._id),
                );
            } catch {
                /* deliberately empty: see above */
            }
        });
    }

    /**
     * Which documents this peer cares about.
     *
     * Prefixed ids (`i:` internal files, `ix:`, `ps:` plugin sync) are refused
     * outright. The bridge lets `includeInternal` opt into `i:`, and mangles the
     * result in both directions; `types.ts` explains why that feature cannot work
     * against a WebObsidian vault at all, and `validateCouchDBConf` rejects the
     * setting, so here we simply never accept a prefixed path.
     */
    private isInterested(doc: MetaEntry, baseDir: string): boolean {
        const path = String(doc?.path ?? '');
        if (path.indexOf(':') !== -1) return false;
        return path.startsWith(baseDir);
    }

    /**
     * Apply one remote change to the storage side.
     *
     * RETURNS WHETHER ANYTHING LANDED, and the caller records the answer rather
     * than assuming it. Four of the paths below end without a write and without
     * an exception: a path this server refuses to host, an echo of our own push
     * in either direction, and `StoragePeer.put`/`delete` returning false for the
     * same reasons on their side (an excluded path, one that fails
     * `resolveInVault`, one that resolves to the vault root). A remote carrying
     * `.trash/note.md` or any vault dotfile as an ordinary document takes one of
     * them on every replication. Discarding the boolean made all of that count as
     * `applied`, which is the one number in the ledger an operator would reach for
     * to check it against `applied.pulled` in the status API, and the two came
     * from the same boolean on one side and not on the other.
     *
     * Throwing still means something different from returning false, and the
     * distinction is the checkpoint's: a throw leaves it where it is so the change
     * is replayed, a refusal advances it so the same rejected document is not
     * replayed forever. That is `StoragePeer.put`'s contract, unchanged.
     */
    private async onRemoteChange(entry: ReadyEntry): Promise<boolean> {
        const remotePath = String(entry.path ?? '');
        const vaultPath = this.toVaultPath(remotePath);
        if (!vaultPath) return false;

        if (entry.deleted || entry._deleted) {
            if (this.echo.hasSeen(vaultPath, false)) return false;
            this.log(`${vaultPath} delete detected`, 'debug');
            const applied = await this.deps.dispatch(vaultPath, false);
            this.echo.remember(vaultPath, false);
            return applied;
        }

        const data: FileData = {
            ctime: entry.ctime,
            mtime: entry.mtime,
            size: entry.size,
            deleted: entry.deleted || entry._deleted,
            data: decodeEntryData(entry),
        };
        if (this.echo.hasSeen(vaultPath, data)) return false;
        this.log(`${vaultPath} change detected`, 'debug');
        const applied = await this.deps.dispatch(vaultPath, data);
        /*
         * Recorded only once the dispatch has RETURNED, and therefore never when
         * it threw.
         *
         * The check above used to record the hash as a side effect, which made
         * the retry of a failed inbound write impossible to distinguish from an
         * echo. The sequence, measured: the vault write throws, the throw
         * propagates so the checkpoint is not advanced, the feed later replays
         * that sequence, and the replayed document arrives here and matches the
         * claim left behind by the attempt that failed. The dispatch is skipped,
         * `false` is returned, the caller reads that as a deliberate refusal, and
         * the checkpoint advances past a document that never reached the vault.
         * `EchoSuppressor` documents the same defect in the outbound direction;
         * the two are the same mistake facing opposite ways, and the checkpoint
         * hold added for the leapfrog defect would have been useless without this
         * half, since every replay it enables would have been swallowed here.
         *
         * `false` still records. A `false` from the storage peer means the write
         * was legitimately skipped rather than failed (an excluded path, a path
         * `resolveInVault` refuses, one that resolves to the vault root, or an
         * echo the storage side recognised first), and the caller advances the
         * checkpoint for exactly that reason. The claim and the checkpoint stay in
         * step: this document is done with, either way.
         */
        this.echo.remember(vaultPath, data);
        return applied;
    }

    /**
     * FIX 10: supervise the changes feed and re-arm it when it stops.
     *
     * The engine reconnects itself ten seconds after an `error`, but its
     * `complete` handler only sets `watching = false` and drops the handle. A
     * long-poll that is closed cleanly (an idle timeout, a reverse proxy trimming
     * an idle connection, CouchDB restarting gracefully) therefore ends the feed
     * with no error, no reconnect, and no log line above verbose. The process
     * stays up, the storage side keeps pushing, and nothing ever comes back down
     * again: precisely the "did a full push, then went silent" behaviour KICKOFF
     * section 7 observed.
     *
     * Re-arming is safe against a double subscription because `beginWatch()`
     * returns false immediately when `watching` is already true, so a race with
     * the engine's own pending retry resolves to exactly one feed.
     */
    private startWatchdog(): void {
        if (this.watchdog) return;
        this.watchdog = setInterval(() => {
            if (this.stopping || !this.man) return;
            // Before anything else, because both are about whether the inbound
            // direction can be measured at all, and a re-armed feed (ours or the
            // engine's own ten-second retry) is a brand new emitter that nothing
            // is counting until this runs.
            this.instrumentFeed();
            this.escalateInboundFatal();
            this.tickPendingProbe();
            if (this.man.watching) {
                /*
                 * Recovery, and the second half of KICKOFF section 8's last
                 * acceptance criterion ("dropped mid-session ... then recovering
                 * without a restart").
                 *
                 * The pull direction repairs itself: the feed resumes from the
                 * persisted checkpoint and replays what was missed. The PUSH
                 * direction does not, because every local edit attempted during
                 * the outage threw, and a throw deliberately leaves that file's
                 * baseline unadvanced instead of marking it synced. Announcing
                 * the reconnect here lets the owner re-run the storage peer's
                 * offline scan, which finds exactly those files.
                 */
                if (this.degraded) {
                    this.degraded = false;
                    this.log('changes feed recovered; rescanning for changes missed while it was down.', 'notice');
                    this.deps.onConnected?.();
                }
                return;
            }
            // Announce the transition once, then drop to debug: while CouchDB is
            // down this branch runs every few seconds, and a notice per tick would
            // bury the one line that actually matters (and, on a long outage, the
            // rest of the server's log with it).
            const firstFailure = !this.degraded;
            this.degraded = true;
            this.log('changes feed is not attached; re-arming.', firstFailure ? 'notice' : 'debug');
            try {
                this.startWatch();
            } catch (e) {
                this.log(`re-arming the changes feed failed: ${describeError(e)}`, 'error');
            }
        }, WATCHDOG_INTERVAL_MS);
        this.watchdog.unref?.();
    }

    /**
     * Turn a TOTAL decryption failure into a stop, not into another retry.
     *
     * This is the same judgement `mergeRemoteTweaks` already makes for the three
     * settings it refuses to adopt, applied to the case that only shows up once
     * documents start arriving. A passphrase does not become correct by being
     * tried again in thirty seconds, and continuing has a second cost beyond the
     * wasted retries: the PUSH direction would keep writing chunks encrypted with
     * a key no other client shares, so the longer the peer runs the more of the
     * remote database is unreadable to everyone including itself after a restart.
     * Stopping leaves every local edit's baseline unadvanced, so nothing is lost
     * and a corrected passphrase replays all of it.
     *
     * TOTAL IS THE LOAD-BEARING WORD, AND IT IS WHY THE PREDICATE LIVES IN THE
     * LEDGER RATHER THAN HERE. `verdict.fatal` is true only when NOTHING has ever
     * decoded, on this run OR any earlier one, for this passphrase against this
     * database (`InboundProgress.verdict()` argues the split at length). Two
     * revisions got that wrong in turn, and both took a human to clear:
     *
     *  - escalating on ANY undecodable document meant one bad document among five
     *    hundred good ones stopped the peer, took the push direction with it via
     *    `requireReady`, made `couchReachable()` report the backend down so
     *    `restartWorthy` could never become true, and printed a message telling
     *    the operator to change a passphrase five hundred documents had just
     *    decrypted with;
     *  - escalating on the RUN's counter fixed that for exactly as long as the
     *    process lived. The demoted `degraded` verdict is restart-worthy, the
     *    restarted pair replays from the checkpoint, and past a checkpoint of 499
     *    the remote has exactly one document to hand back: the bad one. So the
     *    fresh run measured `decoded === 0` and escalated the identical partial
     *    failure to fatal, with the identical wrong message, about ninety seconds
     *    later.
     *
     * The message may name the likely cause here, and only here, because "nothing
     * has ever decrypted" is that cause's signature rather than a guess: nothing
     * on the connect path decrypts anything (the reachability probe is a plain
     * GET, and the milestone is a `_local/` document, which `transform-pouch`
     * refuses to transform), so a wrong passphrase connects cleanly and then
     * decrypts nothing at all. The partial case gets a message worded from the
     * evidence instead, and does not come through this function.
     */
    private escalateInboundFatal(): void {
        if (this.fatalReason) return;
        const verdict = this.progress.verdict();
        if (!verdict.fatal) return;
        this.markFatal(
            `${verdict.detail}. Nothing has ever decrypted with this passphrase against this database, ` +
                'which is what a wrong end-to-end encryption passphrase looks like (or a remote written ' +
                'with a different one). Retrying cannot help, and continuing would publish chunks no ' +
                'other client can read, so the peer has stopped.',
        );
        // Fire and forget: stop() is bounded, never throws, and the watchdog must
        // not become a place that awaits I/O.
        void this.stop().catch(() => {});
    }

    /**
     * Run the remote-pending probe on its own, slower cadence.
     *
     * Skipped entirely while disconnected or fatally misconfigured: neither state
     * has anything to learn from the answer, and hammering a CouchDB that is
     * already refusing us is how a health check becomes a denial of service
     * against the operator's own database.
     */
    private tickPendingProbe(): void {
        if (!this.connected || this.fatalReason || this.pendingProbeInFlight) return;
        this.pendingProbeTicks += 1;
        if (this.pendingProbeTicks * WATCHDOG_INTERVAL_MS < REMOTE_PENDING_INTERVAL_MS) return;
        this.pendingProbeTicks = 0;
        this.pendingProbeInFlight = true;
        void this.probeRemotePending()
            .then((pending) => {
                // `undefined` is a body this code did not recognise, which is not
                // an answer however cleanly it arrived. Routed to the same place a
                // thrown probe goes, because the consequence is identical: we do
                // not know whether the feed is missing changes.
                if (pending === undefined) {
                    this.noteProbeUnanswerable('CouchDB returned a _changes body with no results array');
                    return;
                }
                this.progress.setRemotePending(pending);
                this.pendingProbeComplainedAt = undefined;
            })
            .catch((e: unknown) => {
                this.noteProbeUnanswerable(describeError(e));
            })
            .finally(() => {
                this.pendingProbeInFlight = false;
            });
    }

    /**
     * Record that the pending-changes probe produced no answer.
     *
     * TWO SEPARATE OBLIGATIONS, AND ONLY ONE OF THEM MAY BE RATE-LIMITED.
     *
     * The health signal is unconditional: `noteProbeUnanswerable()` starts (or
     * leaves running) the clock that turns into an `unobservable` verdict, and it
     * keeps reporting for as long as the probe stays unanswerable. The previous
     * shape cleared the clock instead, which made a broken probe resolve to `ok`;
     * the probe is the ONLY detector for a feed that has gone silent while still
     * reporting itself attached, so "I could not tell" reading as "fine" disables
     * the instrument that covers the original bug, using the same proxy or network
     * fault that would cause it.
     *
     * The LOG is rate-limited, because a failing probe fails every 20 seconds and
     * an unthrottled notice would bury the rest of the server's log within a day.
     * It is throttled by time and not by a one-shot flag: the flag version emitted
     * exactly one line per process and then went silent, so an operator reading
     * the log during an incident found nothing about a subsystem that had been
     * blind since boot.
     */
    private noteProbeUnanswerable(reason: string): void {
        this.progress.noteProbeUnanswerable();
        const now = Date.now();
        const due =
            this.pendingProbeComplainedAt === undefined ||
            now - this.pendingProbeComplainedAt >= PROBE_COMPLAINT_INTERVAL_MS;
        if (!due) return;
        this.pendingProbeComplainedAt = now;
        this.log(
            `pending-changes probe did not answer, so a silently dead changes feed cannot be ` +
                `detected; reporting the inbound direction as unobservable: ${reason}`,
            'notice',
        );
    }

    // --- peer operations -------------------------------------------------------

    /**
     * Write a file to CouchDB. Returns false when the write was legitimately
     * skipped, throws when it could not be attempted or failed.
     */
    async put(pathSrc: string, data: FileData): Promise<boolean> {
        const man = this.requireReady();
        // Echo key is the vault-relative path on BOTH sides of the pair, so an
        // inbound write and the outbound event it causes hash against the same
        // entry. (The bridge does the same, keying on the pre-mapping path.)
        if (this.echo.hasSeen(pathSrc, data)) return false;
        const remotePath = this.toRemotePath(pathSrc);
        const info: FileInfo = { ctime: data.ctime, mtime: data.mtime, size: data.size };
        const body = data.data instanceof Uint8Array ? createBlob(data.data) : createTextBlob(data.data);

        try {
            const old = await man.get(remotePath as FilePathWithPrefix, true);
            if (old && 'children' in old && Math.abs(compareMtimeSeconds(info, old)) < SAME_CONTENT_WINDOW_SEC) {
                const oldDoc = await man.getByMeta(old as MetaEntry);
                if (oldDoc && 'data' in oldDoc) {
                    const oldBody =
                        oldDoc.type === 'plain' ? createTextBlob(oldDoc.data) : createBlob(decodeEntryData(oldDoc));
                    if (await isSameContent(oldBody, body)) {
                        this.log(`skipped (same content) ${pathSrc}`, 'debug');
                        return false;
                    }
                }
            }
            const type = isPlainText(remotePath) ? 'plain' : 'newnote';
            const ok = await man.put(remotePath, body, info, type);
            /*
             * Claimed only now, and this is the half of the echo fix WITHOUT
             * which the storage-side half achieves nothing.
             *
             * The failure being closed: `man.put` throws (CouchDB unreachable
             * mid-write, a 401 after a credential rotation, a conflict), the
             * throw propagates so `StoragePeer.processPath` leaves that file's
             * baseline unadvanced, and the offline scan finds the file again.
             * With the claim recorded before the write, that retry reached this
             * method, matched the entry left by the attempt that failed, and
             * returned `false` WITHOUT THROWING. `processPath` treats a
             * non-throwing dispatch as delivered and advances the baseline, so
             * the file was marked synced having never been written to CouchDB,
             * and no later scan would look at it again. Fixing only the storage
             * peer's suppressor would have moved the same loss one layer down.
             *
             * The same-content skip above deliberately does NOT record. It
             * returns before any write, and this method claims only what this
             * peer actually wrote; the caller's own baseline is what records that
             * the file needs no further attention.
             */
            this.echo.remember(pathSrc, data);
            this.log(`${pathSrc} ${ok ? 'saved' : 'ignored'}`, 'debug');
            return ok;
        } catch (e) {
            // Rethrow, redacted: the caller must not record this file as synced.
            throw new Error(`CouchDB put failed for ${pathSrc}: ${describeError(e)}`);
        }
    }

    async delete(pathSrc: string): Promise<boolean> {
        const man = this.requireReady();
        if (this.echo.hasSeen(pathSrc, false)) return false;
        const remotePath = this.toRemotePath(pathSrc);
        try {
            const ok = await man.delete(remotePath);
            // As in `put`: claimed after the remote write, so a delete that threw
            // is retried by the next offline scan instead of being answered with
            // a claim the failed attempt left behind.
            this.echo.remember(pathSrc, false);
            this.log(`${pathSrc} ${ok ? 'deleted' : 'delete ignored'}`, 'debug');
            return ok;
        } catch (e) {
            throw new Error(`CouchDB delete failed for ${pathSrc}: ${describeError(e)}`);
        }
    }

    /** Read a file from CouchDB, or false when there is no such document. */
    async get(pathSrc: string): Promise<false | FileData> {
        const man = this.requireReady();
        const remotePath = this.toRemotePath(pathSrc);
        try {
            const ret = await man.get(remotePath as FilePathWithPrefix);
            if (ret === false || !('data' in ret)) return false;
            const entry = ret as ReadyEntry;
            return {
                ctime: entry.ctime,
                mtime: entry.mtime,
                size: entry.size,
                deleted: entry.deleted,
                data: decodeEntryData(entry),
            };
        } catch (e) {
            throw new Error(`CouchDB get failed for ${pathSrc}: ${describeError(e)}`);
        }
    }

    private requireReady(): DirectFileManipulator {
        if (this.fatalReason) throw new LiveSyncFatalError(this.fatalReason);
        if (!this.connected || !this.man) {
            throw new LiveSyncNotReadyError('CouchDB peer is not connected');
        }
        return this.man;
    }

    // --- path mapping ----------------------------------------------------------

    /**
     * Vault-relative path to remote path.
     *
     * NOTE: do NOT special-case a leading `_` here. The engine's
     * `path2id_base`/`id2path_base` already handle underscore-prefixed paths, and
     * the bridge carries an explicit warning that adding a second rule
     * double-mangled `_attachments` on round-trip.
     */
    private toRemotePath(pathSrc: string): string {
        const baseDir = this.conf.baseDir ?? '';
        if (!baseDir) return pathSrc;
        const joined = `${baseDir.replace(/\/+$/, '')}/${pathSrc.replace(/^\/+/, '')}`;
        return joined === '.' ? '' : joined;
    }

    /**
     * Remote path to vault-relative path.
     *
     * Strips `baseDir` and the separator it leaves behind. The bridge strips only
     * `baseDir.length` characters in `toGlobalPath` and leaves the leading slash,
     * so a non-empty baseDir yields "/note.md", which then resolves differently
     * on the filesystem side. Harmless in the common baseDir="" case, wrong
     * otherwise, so it is fixed here.
     */
    private toVaultPath(remotePath: string): string {
        const baseDir = this.conf.baseDir ?? '';
        let path = remotePath;
        if (baseDir && path.startsWith(baseDir)) path = path.substring(baseDir.length);
        return path.replace(/^\/+/, '');
    }

    // --- health ----------------------------------------------------------------

    /**
     * Synchronous snapshot.
     *
     * `ok` means actually syncing, and the second half of that sentence is the
     * change this file exists to make. It used to mean "connected AND either
     * watching or a known-empty remote", which is a statement about a socket and a
     * boolean the engine sets once. Work flowing is now a required term: an
     * attached feed that is delivering nothing while the remote holds changes, or
     * delivering documents that never reach the vault, is NOT ok, however
     * cheerfully `man.watching` reports itself.
     *
     * A brief dip while the feed reconnects makes `ok` false, which is correct:
     * the grace window in `HealthTracker` is what stops that from being read as a
     * wedge, and `InboundProgress` applies the same rule to its own three clocks.
     */
    snapshot(): PeerHealth {
        const watching = this.man?.watching === true;
        const inbound = this.progress.verdict();
        // `isLinkUp()` rather than a second copy of the same expression: this
        // snapshot and the status API's `connected` field must agree about what a
        // live connection is, and the way to guarantee that is to have one of them
        // ask the other rather than to keep two spellings in step by hand.
        const attached = this.isLinkUp();
        const syncing = attached && !inbound.stalled;
        let detail: string;
        if (this.fatalReason) detail = `configuration error: ${this.fatalReason}`;
        else if (!this.connected) detail = 'connecting';
        // Ordered ahead of 'watching' deliberately: while the inbound direction is
        // stalled, "watching" is true and is the single most misleading thing this
        // peer could say about itself.
        else if (attached && inbound.stalled) detail = inbound.detail;
        else if (watching) detail = 'watching';
        else if (this.remoteEmpty) detail = 'connected (empty remote)';
        else detail = 'reconnecting';
        return {
            name: this.conf.name,
            type: this.type,
            ok: syncing,
            detail,
            /*
             * Asserted only when we are demonstrably syncing; probeHealth()
             * refines it with a real probe in every other case.
             *
             * Note that a stall makes this false while CouchDB is reachable, which
             * is exactly the combination `HealthTracker` needs in order to reach a
             * `restartWorthy` verdict at all: it requires a non-ok snapshot AND a
             * reachable backend. Before the inbound ledger existed, a wedged feed
             * kept `ok` true, so the tracker returned early on every probe and the
             * whole restart path in routes/livesync.ts was unreachable in precisely
             * the failure mode it was built for.
             */
            backendUp: syncing,
            restartWorthy: false,
            /*
             * The peer's veto on the restart the line above cannot see. Gated on
             * `attached` so it can only ever suppress a restart that would have
             * been prompted by the INBOUND verdict: while the peer is
             * disconnected or the feed is detached, reconnecting is exactly the
             * right response and nothing here may block it.
             *
             * `HealthTracker` reads this; `PeerHealth.restartFutile` argues the
             * case, and `InboundVerdict.restartFutile` lists which states set it
             * and why each of them survives a fresh peer pair unchanged.
             */
            restartFutile: attached && inbound.restartFutile,
        };
    }

    /**
     * The inbound ledger's verdict and counts, for the status API and the sync
     * pass.
     *
     * Exposed rather than folded into `PeerHealth` because the two answer
     * different questions: `PeerHealth` is the supervisor's boolean, this is the
     * evidence behind it, and `syncImpl` needs the evidence in order to say
     * something true about a direction it does not itself drive.
     */
    inbound(): InboundVerdict {
        return this.progress.verdict();
    }

    /** Health with the backend-aware restart verdict. */
    probeHealth(): Promise<PeerHealth> {
        return this.tracker.probe();
    }
}

// --- helpers -----------------------------------------------------------------

/**
 * FIX 3: compare two mtimes in whole seconds.
 *
 * The bridge's version is
 *
 *     const aMTime = ~~(a?.mtime ?? 0 / 1000);
 *
 * which has two independent defects. `/` binds tighter than `??`, so it parses
 * as `a?.mtime ?? (0 / 1000)`: the division never touches `a.mtime` and the
 * value stays in MILLISECONDS. Then `~~` truncates to a signed 32-bit integer,
 * and epoch milliseconds (about 1.7e12) is three orders of magnitude past
 * 2^31-1, so the result is whatever the low 32 bits happen to be. Two mtimes a
 * second apart can compare as hours apart, or in the wrong order.
 *
 * The consequence is not cosmetic. This feeds the `< 3600` window that decides
 * whether to compare content at all, so the same-content skip fires essentially
 * at random: identical pushes create new revisions, and the database grows a
 * revision per push per file.
 *
 * `Math.floor` rather than `~~` because `~~` would reintroduce the 32-bit
 * truncation in 2038, when epoch SECONDS crosses 2^31.
 */
export function compareMtimeSeconds(a: FileInfo | undefined, b: FileInfo | undefined): number {
    const aSec = Math.floor((a?.mtime ?? 0) / 1000);
    const bSec = Math.floor((b?.mtime ?? 0) / 1000);
    return aSec - bSec;
}

/**
 * Byte-exact content comparison, replacing commonlib's `isDocContentSame`
 * (which the vendored entry surface does not export).
 *
 * Size first, because it is free and settles most cases. The full comparison is
 * a single `Buffer.compare`: `Buffer.from(arrayBuffer)` is a view, not a copy,
 * so this does not double the memory of a large attachment.
 */
async function isSameContent(a: Blob, b: Blob): Promise<boolean> {
    if (a.size !== b.size) return false;
    const [ab, bb] = await Promise.all([a.arrayBuffer(), b.arrayBuffer()]);
    return Buffer.from(ab).equals(Buffer.from(bb));
}

/**
 * Turn a document's stored data into the form the storage peer writes.
 *
 * Text comes back as the engine's chunk array and stays that way. Binary is
 * base64 (or, for documents written by much older clients, a UTF-16 packing)
 * and has to be decoded, which is what `decodeBinary` does in commonlib. That
 * function lives in octagonal-wheels and is not re-exported by the vendored
 * package, and octagonal-wheels is a dependency of the vendored package rather
 * than of the server, so importing it here would be an undeclared dependency
 * that happens to resolve today because of hoisting. Reimplemented instead,
 * against the same encoding.
 */
function decodeEntryData(entry: ReadyEntry): string[] | Uint8Array {
    if (entry.type === 'plain') return entry.data;
    return decodeBinaryChunks(entry.data);
}

/**
 * Decode commonlib's binary encoding.
 *
 * Mirrors `octagonal-wheels/binary`'s `decodeBinary`: chunks are base64 unless
 * the FIRST chunk starts with "%", which marks the legacy UTF-16 packing (the
 * marker appears once, on the first chunk only, and is not part of the payload).
 */
function decodeBinaryChunks(src: string[]): Uint8Array {
    if (!src || src.length === 0) return new Uint8Array(0);
    if (src[0].startsWith('%')) {
        const [head, ...rest] = src;
        return decodeUtf16Packed([head.substring(1), ...rest]);
    }
    const parts = src.map((chunk) => Buffer.from(chunk, 'base64'));
    return new Uint8Array(Buffer.concat(parts));
}

/**
 * The legacy UTF-16 packing: bytes outside the "safe" printable range are stored
 * as code points offset by 0xC0.
 *
 * Kept because a database written by an older Self-hosted LiveSync client still
 * contains documents in this form, and reading one back as garbage would be a
 * silent corruption rather than a visible failure. The safe range and the 0xC0
 * offset are copied from octagonal-wheels' table construction
 * (`range(0xc0, 0x1bf)`, i.e. byte i maps to code point 0xC0 + i).
 */
function decodeUtf16Packed(chunks: string[]): Uint8Array {
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        for (let i = 0; i < chunk.length; i += 1) {
            const code = chunk.charCodeAt(i);
            if (code >= 0x26 && code <= 0x7e && code !== 0x3a) {
                out[offset + i] = code;
            } else {
                const value = code - 0xc0;
                // Out of range means the document is not in this encoding after
                // all. Zero matches what the reference implementation produces
                // (an undefined table lookup stored into a Uint8Array).
                out[offset + i] = value >= 0 && value <= 0xff ? value : 0;
            }
        }
        offset += chunk.length;
    }
    return out;
}

/**
 * Merge the remote's tweak values into a local configuration.
 *
 * Pure, and separated from the peer so the fatal cases are testable without a
 * CouchDB. Returns the merged config plus a human-readable list of what changed.
 *
 * THE THREE THROWS ARE FATAL, and that is the deliberate behaviour change from
 * the bridge. The bridge throws these inside its connect loop, so a wrong
 * passphrase, a missing obfuscation passphrase or a compression mismatch retries
 * every 30 seconds forever: the log fills with connect failures that look
 * transient, the peer never connects, and (in the bridge's design) every
 * storage-side dispatch waits on a `_started` promise that will never resolve,
 * so the filesystem side wedges too. None of the three can be fixed by waiting.
 * They are operator errors, so they stop the peer and say so.
 */
export function mergeRemoteTweaks(
    conf: LiveSyncCouchDBConf,
    tweakValues: Record<string, RemoteTweaks>,
): { merged: LiveSyncCouchDBConf; changes: string[] } {
    /*
     * `tweak_values` is keyed by node id, PLUS one reserved key: `PREFERRED`
     * (`DEVICE_ID_PREFERRED`), which is the cluster's authoritative answer. The
     * bridge ignores it and takes `Object.values(...)[0]`, i.e. whichever entry
     * the JSON parser happened to put first.
     *
     * That is not a stylistic difference. `ensureRemoteIsCompatible` compares
     * against `tweak_values[PREFERRED]` and nothing else, so adopting some other
     * node's entry means adopting values the engine will then declare mismatched.
     * With a single client the two coincide, which is why the bridge's version
     * looks fine; the moment a third client joins with different settings, the
     * bridge can adopt a stale node's tweaks and the disagreement is permanent.
     *
     * The first-entry fallback is kept for a milestone written by a client old
     * enough not to set `PREFERRED` at all.
     */
    const tweaks = tweakValues[DEVICE_ID_PREFERRED] ?? Object.values(tweakValues)[0];
    if (!tweaks) return { merged: conf, changes: [] };

    if (tweaks.encrypt && !conf.passphrase) {
        throw new LiveSyncFatalError(
            'The remote database is end-to-end encrypted but no passphrase is configured. ' +
                'Set the passphrase; retrying cannot help.',
        );
    }
    if (tweaks.usePathObfuscation && !conf.obfuscatePassphrase) {
        throw new LiveSyncFatalError(
            'The remote database uses path obfuscation but no obfuscation passphrase is configured. ' +
                'Set the obfuscation passphrase; retrying cannot help.',
        );
    }
    // Compared as booleans on both sides: `undefined` and `false` mean the same
    // thing here, and a mismatch means every chunk we write is unreadable to the
    // other clients (and theirs to us).
    if (!conf.enableCompression !== !tweaks.enableCompression) {
        throw new LiveSyncFatalError(
            `Compression setting mismatched: the remote has compression ${
                tweaks.enableCompression ? 'enabled' : 'disabled'
            } and this peer has it ${conf.enableCompression ? 'enabled' : 'disabled'}. ` +
                'Make them agree; retrying cannot help.',
        );
    }

    /*
     * The adoptable set, written out as a typed literal rather than copied field
     * by field. The literal is where the type checking happens (every value here
     * has to match the config field it lands in); the loop below is then a plain
     * diff, which keeps the "what changed" report and the assignment from ever
     * disagreeing about which fields were adopted.
     *
     * Note what is NOT here: `encrypt`, `usePathObfuscation` and
     * `enableCompression`. Those three are checked above and are fatal on
     * mismatch, never adopted. Silently turning on encryption because the remote
     * says so would mean writing chunks that this peer cannot read back after a
     * restart, and silently turning it off would publish the vault in plaintext.
     */
    const incoming: Partial<LiveSyncCouchDBConf> = {
        customChunkSize: tweaks.customChunkSize,
        minimumChunkSize: tweaks.minimumChunkSize,
        hashAlg: tweaks.hashAlg,
        useEden: tweaks.useEden,
        maxAgeInEden: tweaks.maxAgeInEden,
        maxTotalLengthInEden: tweaks.maxTotalLengthInEden,
        maxChunksInEden: tweaks.maxChunksInEden,
        useDynamicIterationCount: tweaks.useDynamicIterationCount,
        enableChunkSplitterV2: tweaks.enableChunkSplitterV2,
        chunkSplitterVersion: tweaks.chunkSplitterVersion,
        E2EEAlgorithm: tweaks.E2EEAlgorithm,
        doNotUseFixedRevisionForChunks: tweaks.doNotUseFixedRevisionForChunks,
        handleFilenameCaseSensitive: tweaks.handleFilenameCaseSensitive,
    };

    const merged: LiveSyncCouchDBConf = { ...conf };
    const changes: string[] = [];
    // The two casts are contained to this loop: indexing a typed object by a
    // runtime key is the one thing the type system cannot express here, and the
    // literal above has already established that every key and value is valid.
    const target = merged as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(incoming)) {
        if (value === undefined) continue;
        const current = target[key];
        if (current === value) continue;
        changes.push(`${key}: ${String(current)} -> ${String(value)}`);
        target[key] = value;
    }

    return { merged, changes };
}

/**
 * Which of the "should be matched" tweak keys actually differ between the
 * cluster's preferred values and what this peer announced about itself.
 *
 * `ensureRemoteIsCompatible` computes the same comparison and returns a boolean
 * verdict; this reproduces it and returns the KEYS, because the verdict alone
 * cannot be acted on correctly (see `applyMismatch`).
 *
 * REPRODUCED USING THE ENGINE'S OWN TEMPLATES AND COMPARISON, not by hand. Both
 * `extractObject` calls, the `TweakValuesDefault` underlay and the
 * skip-if-undefined-on-either-side rule are lifted directly from
 * `LiveSyncDBFunctions.ts:105-119` and `octagonal-wheels`' `isObjectDifferent`
 * with `ignoreUndefined = true`. Doing it any other way would let this function
 * and the engine disagree about what mismatched, which would show up as a peer
 * that refuses to start while reporting that nothing is wrong.
 *
 * The `TweakValuesDefault` underlay is what stops an old milestone, written by a
 * client that predates a key, from mismatching on that key: the key comes back
 * `undefined` on the remote side and the rule below skips it.
 */
export function mismatchedKeys(preferred: TweakValues, announced: RemoteDBSettings): string[] {
    const current = extractObject(TweakValuesTemplate, announced);
    const remoteSide = extractObject(TweakValuesShouldMatchedTemplate, { ...TweakValuesDefault, ...preferred });
    const localSide = extractObject(TweakValuesShouldMatchedTemplate, { ...TweakValuesDefault, ...current });
    return Object.keys(remoteSide)
        .filter(
            (key) =>
                remoteSide[key] !== undefined &&
                localSide[key] !== undefined &&
                isObjectDifferent(remoteSide[key], localSide[key]),
        )
        .sort();
}
