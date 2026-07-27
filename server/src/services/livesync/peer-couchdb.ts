/**
 * The CouchDB side of the pair: a port of the reference bridge's `PeerCouchDB`
 * (reference/livesync-bridge/PeerCouchDB.ts) onto the vendored engine.
 *
 * Everything structural is the bridge's: the probe/build/retry connect loop, the
 * fresh-manipulator-per-attempt rule, the remote-tweak adoption, the
 * remote-rebuilt detection, the same-content skip, and the health snapshot. Four
 * things are deliberately different, and each one is a defect fix rather than a
 * preference. They are marked FIX 3, FIX 4, FIX 10 and FATAL CONFIG below:
 *
 *  - FIX 3: `compareDate()` had an operator-precedence bug and an int32
 *    overflow, so the same-content dedup fired essentially at random.
 *  - FIX 4: `since` was never advanced, so the peer always resumed from "now"
 *    and permanently lost every change made while it was down.
 *  - FIX 10: the changes feed's `complete` event was a terminal, silent stop.
 *    This is the actual mechanism behind the "did a full push, then went silent"
 *    behaviour KICKOFF section 7 reports.
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
import { DirectFileManipulator, createBlob, createTextBlob, isPlainText } from 'livesync-engine';
import type {
    ChunkSplitterVersion,
    DocumentID,
    E2EEAlgorithm,
    FileInfo,
    FilePathWithPrefix,
    HashAlgorithm,
    MetaEntry,
    PouchDatabaseConfiguration,
    PouchDatabaseHandle,
    ReadyEntry,
} from 'livesync-engine';
import { HealthTracker, type PeerHealth } from './health.js';
import { EchoSuppressor, type LiveSyncStateStore } from './state.js';
import {
    describeError,
    validateCouchDBConf,
    type DispatchFn,
    type FileData,
    type LiveSyncCouchDBConf,
    type LiveSyncLogger,
} from './types.js';

/**
 * The id of Self-hosted LiveSync's milestone document.
 *
 * Hard-coded rather than imported: the vendored package's curated entry surface
 * (`server/vendor/livesync-engine/src/entry.ts`) does not re-export
 * `MILESTONE_DOCID`, and the vendor tree is off limits for edits. The value is
 * copied verbatim from `upstream/src/common/types.ts`, misspelling included
 * ("obsydian"), because the string is a wire identifier: correcting the typo
 * would silently point this peer at a document no other LiveSync client writes.
 */
const MILESTONE_DOCID = '_local/obsydian_livesync_milestone' as DocumentID;

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

/** The subset of the milestone document this peer reads. */
interface MilestoneDoc {
    created?: number;
    tweak_values?: Record<string, RemoteTweaks>;
}

/**
 * The tweak fields the bridge adopts from the remote.
 *
 * Structural and partial on purpose: upstream's `TweakValues` is derived from
 * the Obsidian plugin's entire settings object and is not exported by the
 * vendored entry surface. Naming only what is read here keeps the coupling to
 * the vendored types minimal and makes the adopted set auditable at a glance.
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
    private connected = false;
    /**
     * Connected fine, but the remote has no milestone document yet, so there is
     * nothing to reconcile against. Tracked separately from `connected` so the
     * health snapshot can call it syncing rather than stuck.
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

    constructor(conf: LiveSyncCouchDBConf, deps: CouchDBPeerDeps) {
        this.conf = { ...conf };
        this.deps = deps;
        this.state = deps.state;
        this.log = deps.log ?? (() => {});
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
        this.wakeFromBackoff?.();
        if (this.watchdog) {
            clearInterval(this.watchdog);
            this.watchdog = undefined;
        }
        const man = this.man;
        this.man = undefined;
        this.tracker.reset();
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

    isConnected(): boolean {
        return this.connected;
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

    /** Is CouchDB up right now? Same success threshold as the connect probe. */
    private async couchReachable(): Promise<boolean> {
        try {
            await this.probeCouch(REACHABLE_TIMEOUT_MS);
            return true;
        } catch {
            return false;
        }
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

    /** Reconcile with the remote, then attach the changes feed. */
    private async connectAndWatch(): Promise<void> {
        await this.waitReady(READY_TIMEOUT_MS);
        let man = this.man;
        if (!man) throw new Error('manipulator was torn down while connecting');

        const milestone = await man.rawGet<MilestoneDoc>(MILESTONE_DOCID);

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

        if (!milestone) {
            /*
             * A remote with no milestone document has never been initialised by a
             * LiveSync client. The bridge logs this, records `remote-created` as
             * "0" and RETURNS WITHOUT WATCHING, which means the peer stays deaf
             * until the process is restarted: whenever another client does
             * initialise the database, nothing here notices.
             *
             * We keep the marker (so the milestone appearing later reads as a
             * rebuild and forces a replay from zero) but attach the feed anyway.
             * Watching an empty database costs one idle long-poll and removes a
             * whole class of "it only worked after I restarted it".
             */
            this.remoteEmpty = true;
            this.state.setRemoteCreated('0');
            this.log('remote database looks empty; watching from the first sequence.');
        } else {
            this.remoteEmpty = false;
            const created = String(milestone.created ?? '');
            if (this.state.getRemoteCreated() !== created) {
                // A different `created` means a different database wearing the
                // same name. Every sequence number we remember belongs to the old
                // one, so the only safe checkpoint is the beginning.
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

    // --- the changes feed ------------------------------------------------------

    private startWatch(): void {
        const man = this.man;
        if (!man || this.stopping) return;
        const baseDir = this.conf.baseDir ?? '';
        // Re-read the checkpoint on every (re)arm so a reconnect resumes where the
        // last processed change left off rather than where this process started.
        man.since = this.state.getSince() || '0';
        man.beginWatch(
            async (entry: ReadyEntry, seq?: string | number) => {
                await this.onRemoteChange(entry);
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
                 */
                if (seq !== undefined && seq !== null) {
                    const value = String(seq);
                    man.since = value;
                    this.state.setSince(value);
                }
            },
            (doc: MetaEntry) => this.isInterested(doc, baseDir),
        );
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

    /** Apply one remote change to the storage side. */
    private async onRemoteChange(entry: ReadyEntry): Promise<void> {
        const remotePath = String(entry.path ?? '');
        const vaultPath = this.toVaultPath(remotePath);
        if (!vaultPath) return;

        if (entry.deleted || entry._deleted) {
            if (this.echo.isRepeating(vaultPath, false)) return;
            this.log(`${vaultPath} delete detected`, 'debug');
            await this.deps.dispatch(vaultPath, false);
            return;
        }

        const data: FileData = {
            ctime: entry.ctime,
            mtime: entry.mtime,
            size: entry.size,
            deleted: entry.deleted || entry._deleted,
            data: decodeEntryData(entry),
        };
        if (this.echo.isRepeating(vaultPath, data)) return;
        this.log(`${vaultPath} change detected`, 'debug');
        await this.deps.dispatch(vaultPath, data);
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
        if (this.echo.isRepeating(pathSrc, data)) return false;
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
            this.log(`${pathSrc} ${ok ? 'saved' : 'ignored'}`, 'debug');
            return ok;
        } catch (e) {
            // Rethrow, redacted: the caller must not record this file as synced.
            throw new Error(`CouchDB put failed for ${pathSrc}: ${describeError(e)}`);
        }
    }

    async delete(pathSrc: string): Promise<boolean> {
        const man = this.requireReady();
        if (this.echo.isRepeating(pathSrc, false)) return false;
        const remotePath = this.toRemotePath(pathSrc);
        try {
            const ok = await man.delete(remotePath);
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
     * Synchronous snapshot. `ok` means actually syncing: connected AND either
     * watching or a known-empty remote.
     *
     * A brief dip while the feed reconnects makes `ok` false, which is correct:
     * the grace window in `HealthTracker` is what stops that from being read as a
     * wedge.
     */
    snapshot(): PeerHealth {
        const watching = this.man?.watching === true;
        const syncing = this.connected && (watching || this.remoteEmpty);
        let detail: string;
        if (this.fatalReason) detail = `configuration error: ${this.fatalReason}`;
        else if (!this.connected) detail = 'connecting';
        else if (watching) detail = 'watching';
        else if (this.remoteEmpty) detail = 'connected (empty remote)';
        else detail = 'reconnecting';
        return {
            name: this.conf.name,
            type: this.type,
            ok: syncing,
            detail,
            // Only asserted here when we are demonstrably syncing; probeHealth()
            // refines it with a real probe in every other case.
            backendUp: syncing,
            restartWorthy: false,
        };
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
    // The milestone stores tweaks per node id; the bridge takes the first entry,
    // and so do we. They are expected to agree (a cluster with disagreeing
    // chunking settings is already broken), and there is no better tiebreak
    // available from here.
    const tweaks = Object.values(tweakValues)[0];
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
