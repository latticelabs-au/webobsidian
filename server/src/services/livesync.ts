/**
 * The LiveSync backend: a sibling of `services/git.ts`, owning one storage peer
 * and one CouchDB peer and fanning changes between them.
 *
 * This file is the composition root for the subsystem. The peers under
 * `services/livesync/` know how to move one file in one direction; this module
 * decides when they exist, in what order they start, which of them a change goes
 * to, and what an operator is told about all of it.
 *
 * It deliberately mirrors the shape of `services/git.ts` (see `withSyncLock`
 * below) so that `services/autosync.ts` can branch on `settings.sync.backend`
 * and otherwise not care which backend is active. The two backends are mutually
 * exclusive by construction (KICKOFF section 5.3, and the `sync.backend` enum in
 * settings.ts): git resolves conflicts at commit granularity over a working tree
 * it assumes it alone mutates, LiveSync resolves them per document against
 * CouchDB revision history, and running both over one vault makes each one's
 * writes look to the other like an unexplained local edit.
 *
 * Four things in here are decisions rather than transcription, and each is
 * argued at its site:
 *
 *  1. START ORDER WITHOUT THE BRIDGE'S DEADLOCK. The reference `Hub.start()`
 *     awaits every CouchDB peer before starting any storage peer, which is the
 *     right ordering and the wrong mechanism: its `start()` only resolves on
 *     success, so a CouchDB that is down at boot means the filesystem side never
 *     starts at all. Here both peers start immediately and the ordering
 *     guarantee is enforced at the point of use, in `dispatchToCouch`.
 *  2. THE DISPATCH CONTRACT IS THREE-VALUED. True (applied), false (legitimately
 *     skipped) and THROWN (not delivered) mean different things, and the peers
 *     use the difference to decide whether it is safe to advance their "caught
 *     up to here" markers. This module must preserve the distinction rather than
 *     swallowing errors, or a local edit made during a CouchDB outage is marked
 *     synced and lost.
 *  3. WHAT `liveMode` CAN AND CANNOT MEAN with this engine. See `onVaultEvent`.
 *  4. THE PROCESS HOOKS. The engine's fire-and-forget init can reject from deep
 *     inside PouchDB, and its `close()` does not release every handle, so the
 *     shutdown path has to be explicit about both.
 *
 * Credential hygiene, non-negotiable: a CouchDB URL carries `user:password`, and
 * PouchDB embeds request URLs in its error messages. Every error that reaches a
 * log line or an API response in this file goes through `describeError()` or
 * `redactUrlCreds()`, exactly as `services/git.ts` does for a PAT baked into a
 * remote URL.
 */
import { createHash } from 'node:crypto';
import { getSettings, type Settings } from './settings.js';
import { getVaultRoot } from './vault.js';
import { redactUrlCreds } from '../lib/redact.js';
import { CouchDBPeer, LiveSyncNotReadyError } from './livesync/peer-couchdb.js';
import { StoragePeer } from './livesync/peer-storage.js';
import { LiveSyncStateStore } from './livesync/state.js';
import { combineHealth, type PeerHealth } from './livesync/health.js';
import type { InboundVerdict } from './livesync/progress.js';
import {
  createPeerLogger,
  describeError,
  validateCouchDBConf,
  type DispatchFn,
  type LiveSyncCouchDBConf,
  type LiveSyncLogger,
  type LiveSyncStorageConf,
} from './livesync/types.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Hard bound on how long `connect()` waits for the first CouchDB attempt.
 *
 * The attempt itself is already bounded by the peer (a 10s reachability probe
 * plus a 15s init race), so this is a ceiling on the ceiling, and it exists for
 * one reason: `connect()` is reachable from an HTTP route, and an HTTP handler
 * that can block for the better part of a minute is a denial of service against
 * the operator's own UI. Timing out here does NOT cancel anything. The peer's
 * supervised retry loop keeps running in the background and `status()` reports
 * its progress, which is the honest answer to "is it up yet".
 */
const CONNECT_WAIT_MS = 20_000;

/**
 * How long a queued push waits for a connect that is still in flight.
 *
 * This is the ordering guarantee from the bridge's `Hub.start()`, relocated from
 * startup to the point of use (see the module header). At boot the storage
 * peer's offline scan starts immediately and its first dispatch lands here while
 * the CouchDB peer is still connecting; waiting briefly turns what would be a
 * per-file "not connected" notice into a normal push. If the wait expires the
 * dispatch throws, which is the correct outcome and not a lost change: a throw
 * leaves that file's baseline unadvanced, so the next scan (at the next tick, or
 * on the peer's reconnect hook) finds it again.
 */
const DISPATCH_READY_WAIT_MS = 20_000;

/**
 * In live mode, the longest gap between two full reconciliation scans.
 *
 * In interval mode the scan IS the push mechanism and runs every tick. In live
 * mode the watcher pushes each change as it happens, so a scan is purely a
 * safety net against an event the watcher never delivered (an inotify overflow,
 * a network filesystem, a rename storm). Ten minutes is chosen to be cheap at
 * vault scale: a scan is one `stat` per file plus a read of only the files whose
 * `mtime-size` differs, but "cheap" times "every 30 seconds" times 30k files is
 * not cheap, and the watcher already covers the normal case.
 */
const LIVE_MODE_SAFETY_SCAN_MS = 600_000;

/** Bound on the shutdown path, so a wedged peer cannot hold a deploy open. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// The public status shape
// ---------------------------------------------------------------------------

export interface LiveSyncStatus {
  /** Which backend owns this vault. Included so a UI can render "off" honestly. */
  backend: Settings['sync']['backend'];
  /** True when `sync.backend === 'livesync'`. */
  enabled: boolean;
  /** A peer pair exists and has been started. */
  running: boolean;
  /**
   * The CouchDB peer has a live connection RIGHT NOW: the peer is running and its
   * changes feed is attached.
   *
   * The second half of that sentence is what this field used to be missing. It
   * reported the peer's lifecycle flag, which is set once on a successful connect
   * and cleared only by an explicit stop, so it answered "yes" for the whole of
   * every mid-session outage. See `CouchDBPeer.isLinkUp()`.
   */
  connected: boolean;
  liveMode: boolean;
  intervalSec: number;
  /** `<uri>/<database>`, credentials stripped. Never the raw configured string. */
  remote: string;
  database: string;
  /** Every peer is syncing (the aggregate of the three-valued health model). */
  healthy: boolean;
  /** A peer judges that restarting the sync would plausibly help. */
  restartWorthy: boolean;
  peers: PeerHealth[];
  /** Files with a recorded sync baseline. Roughly "files we believe are synced". */
  trackedFiles: number;
  /** Cumulative counts for this process, both directions. */
  applied: { pushed: number; pulled: number };
  /**
   * What the inbound (CouchDB to vault) direction is actually doing.
   *
   * `healthy` above is a boolean; this is the evidence behind it, and it exists
   * because the two most important states a sync backend can be in used to be
   * indistinguishable from the outside. An idle peer and a wedged one both
   * reported `healthy: true`, `connected: true` and an unchanging `applied`,
   * because nothing in the health path observed whether any work was flowing.
   * `state` distinguishes them by name; the counters let a reader check the
   * verdict rather than take it on trust. Null when no pair is running.
   */
  inbound: InboundVerdict | null;
  /**
   * Unhandled promise rejections observed while this backend was running.
   *
   * Reported rather than merely logged because it is the ONLY externally visible
   * trace of the vendored engine's worst failure mode: `transform-pouch` registers
   * an async `change` listener whose promise it discards, so a document that fails
   * to decrypt takes the rejection out of the process entirely, and the engine's
   * real handler is never called. A rising count here alongside a rising
   * `inbound.undecodable` is that exact fault, spelled out twice.
   */
  unhandledRejections: number;
  lastUnhandledRejectionAt: string | null;
  lastSyncAt: string | null;
  /** Last failure, redacted. Cleared by a successful pass. */
  lastError: string | null;
  /**
   * Reasons this configuration can never work (a missing URL, obfuscation
   * without encryption, a non-empty `includeInternal`). Non-empty means the
   * backend will refuse to start rather than retry, which is the point: a config
   * error that retries forever is the silent failure KICKOFF section 7 is about.
   */
  configErrors: string[];
  /** The same class of problem, as judged by a running peer. */
  fatalReason: string | null;
}

// ---------------------------------------------------------------------------
// Serialized access
//
// This mirrors `withGitLock` in services/git.ts, and for the same reason. Three
// independent drivers reach this backend over one vault: the interval tick in
// autosync.ts, the vault watcher's push path, and the manual HTTP routes. Let
// two of them run a reconciliation pass at once and they walk the same tree,
// dispatch the same files and race on the same state file. A LiveSync backend
// needs the same single-writer discipline a git backend does.
//
// Two differences from git.ts, both deliberate:
//
//  - There is no stale-lock self-healing step, because there is no lock file to
//    go stale. Its equivalent lives one layer down: the CouchDB peer builds a
//    FRESH manipulator per connect attempt rather than retrying a wedged one,
//    which is the self-heal that actually applies to this engine.
//  - The watcher path (`onVaultEvent`) deliberately does NOT take this lock. It
//    is a synchronous notification from the composition root's chokidar fanout,
//    and blocking it behind a running sync would stall the search index and the
//    websocket broadcast that share that fanout. Serialisation for that path is
//    the storage peer's own per-path queue, which is the granularity that
//    matters there (two writes to the SAME file), not a global one.
//
// As in git.ts: ops queue and never overlap, a rejecting op does not poison the
// queue, and callers that already hold the lock call the private *Impl directly
// rather than re-entering and dead-locking.
// ---------------------------------------------------------------------------
let syncQueue: Promise<unknown> = Promise.resolve();

function withSyncLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = syncQueue.then(fn);
  syncQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * How this pass was triggered.
 *
 * The distinction exists because a full reconciliation scan is a walk of the
 * whole vault, and the two callers want opposite things from it. A person who
 * pressed "sync now" wants the walk: their question is "is everything up to
 * date", and answering it without looking would be a lie. The interval tick in
 * live mode does not, because the watcher has already pushed every change and a
 * walk per tick is one `stat` per file every `intervalSec` forever. `periodic`
 * therefore relaxes the scan to a safety net; the default does not.
 *
 * Optional, so `sync()` still satisfies the contract git.ts sets and a caller
 * that does not care can ignore it entirely.
 */
export interface LiveSyncPassOptions {
  periodic?: boolean;
}

/** The contract autosync.ts and the routes drive. Mirrors git.ts's exports. */
export const status = (): Promise<LiveSyncStatus> => withSyncLock(statusImpl);
export const connect = (): Promise<void> => withSyncLock(connectImpl);
export const sync = (opts: LiveSyncPassOptions = {}): Promise<{ ok: boolean; log: string[] }> =>
  withSyncLock(() => syncImpl(opts));
export const disconnect = (): Promise<void> => withSyncLock(disconnectImpl);

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/**
 * One live peer pair plus everything that belongs to it.
 *
 * Held in a single object, and replaced wholesale when the configuration
 * changes, so that a stale peer finishing a dispatch after a reconfiguration can
 * see that ITS runtime is gone (`stopped`) instead of pushing into the new
 * pair's peers. That is why the dispatch closures below capture a reference cell
 * rather than reading the module-level `runtime`.
 */
interface Runtime {
  /** Hash of the configuration this pair was built for. See `configSignature`. */
  signature: string;
  state: LiveSyncStateStore;
  storage: StoragePeer;
  couch: CouchDBPeer;
  /**
   * Resolves once the FIRST CouchDB connect attempt has settled, either way.
   * Never rejects. This is the handle the ordering guarantee is enforced with.
   */
  couchStarted: Promise<void>;
  /** Refreshed from settings on every pass; no restart needed to change it. */
  liveMode: boolean;
  /** True once `storage.start()` has been called. Gates the reconnect rescan. */
  storageStarted: boolean;
  stopped: boolean;
  pushed: number;
  pulled: number;
  lastScanAt: number;
}

let runtime: Runtime | null = null;
let lastSyncAt: number | null = null;
let lastError: string | null = null;

/**
 * Process-lifetime evidence, not runtime state.
 *
 * Deliberately NOT reset when a peer pair is replaced. A rejection or an engine
 * notice is a thing that happened to this process, and zeroing the counters on
 * every reconnect would let an automatic restart erase its own evidence: the beat
 * restarts a wedged pair, the counters go back to zero, and the next reader sees
 * a clean subsystem that has in fact been failing all morning.
 */
let unhandledRejections = 0;
let lastUnhandledRejectionAt: number | null = null;

const log: LiveSyncLogger = createPeerLogger('backend');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Map the settings block onto the CouchDB peer's config.
 *
 * Empty secrets become `undefined` rather than `''` because the engine's
 * behaviour is keyed on truthiness (`encrypt: this.options.passphrase ? true :
 * false`) and its own type documents `undefined` as "disabled". Passing `''`
 * happens to work today; passing `undefined` says what is meant.
 *
 * `includeInternal` is passed THROUGH rather than forced to `[]`, even though a
 * non-empty value is refused. Silently dropping it would hand an operator who
 * ported a bridge config a backend that quietly does less than they configured;
 * `validateCouchDBConf` turns it into a visible, explained refusal instead.
 */
function buildCouchConf(s: Settings): LiveSyncCouchDBConf {
  return {
    name: 'couchdb',
    // The whole database. A remote prefix would be a second, independent way to
    // shard a vault, and nothing in the settings model exposes one.
    baseDir: '',
    url: s.livesync.uri,
    database: s.livesync.database,
    username: s.livesync.username,
    password: s.livesync.password,
    passphrase: s.livesync.passphrase || undefined,
    obfuscatePassphrase: s.livesync.obfuscatePassphrase || undefined,
    // Adopt the remote's chunking settings: it is how a peer joins an existing
    // cluster without the operator transcribing every tweak by hand. The three
    // settings that are NOT adopted (encryption, obfuscation, compression) are
    // fatal on mismatch inside the peer, which is the correct treatment: they
    // decide whether this peer's chunks are readable by anyone else.
    useRemoteTweaks: true,
    includeInternal: s.livesync.includeInternal,
  };
}

function buildStorageConf(): LiveSyncStorageConf {
  return {
    name: 'vault',
    baseDir: '',
    scanOfflineChanges: true,
    // Matches the `awaitWriteFinish.stabilityThreshold` the composition root's
    // watcher already applies, so an editor's write-truncate-write sequence
    // collapses into one push rather than two.
    debounceMs: 300,
  };
}

/**
 * Everything about the configuration that requires a NEW peer pair if it
 * changes, hashed.
 *
 * Hashed rather than kept as a string for one reason: this value lives in a
 * module-level variable for the lifetime of the process, and the fields it is
 * derived from include the CouchDB password and both passphrases. A hash cannot
 * be logged, serialised into an error, or read out of a heap dump as a
 * credential. It is not a security boundary (the peer holds the real values
 * anyway), it is the cheap way to make sure this particular copy never becomes
 * one more place a secret can escape from.
 *
 * `liveMode` and `intervalSec` are deliberately absent: both are re-read on
 * every pass and neither requires tearing a connection down.
 */
function configSignature(vaultRoot: string, conf: LiveSyncCouchDBConf): string {
  const material = JSON.stringify([
    vaultRoot,
    conf.url,
    conf.database,
    conf.username,
    conf.password,
    conf.passphrase ?? '',
    conf.obfuscatePassphrase ?? '',
    conf.baseDir,
    conf.includeInternal ?? [],
  ]);
  return createHash('sha256').update(material).digest('hex');
}

/**
 * `<uri>/<database>` with any credentials stripped.
 *
 * `redactUrlCreds` is belt to the API's braces: routes/settings.ts refuses a URI
 * carrying userinfo outright, but a hand-edited settings.json can contain one,
 * and this string goes into log lines and API responses.
 */
function describeRemote(s: Settings): string {
  const uri = redactUrlCreds(s.livesync.uri);
  return s.livesync.database ? `${uri}/${s.livesync.database}` : uri;
}

/**
 * Record a failure for the status API and the log.
 *
 * Two different renderings on purpose. The log gets `describeError`, which
 * prefers the stack (an engine-internal failure is not diagnosable without it),
 * while the API field gets the message only: a stack in a settings panel is
 * noise, and every extra byte of engine internals in an HTTP response is one
 * more thing to have to prove carries no credential. Both are redacted.
 */
function recordError(context: string, e: unknown): string {
  const detail = e instanceof Error ? redactUrlCreds(e.message) : redactUrlCreds(String(e));
  lastError = `${context}: ${detail}`;
  log(`${context}: ${describeError(e)}`, 'error');
  return detail;
}

// ---------------------------------------------------------------------------
// Building and starting the pair
// ---------------------------------------------------------------------------

/** Resolve when `p` settles or `ms` elapses, whichever is first. Never rejects. */
function raceTimeout(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A pending bound must never be the reason the process stays alive: the
    // engine already leaks a socket and a timer past close(), so the shutdown
    // path is fragile enough without this adding to it.
    timer.unref?.();
    void p.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

/**
 * Wire one pair together.
 *
 * ECHO SUPPRESSION IS A TWO-LAYER PROPERTY, AND BOTH LAYERS ARE LOAD-BEARING.
 * Nothing in this file may "simplify" either of them away, so it is written down
 * at the seam where the loop would form:
 *
 *  1. THE IN-MEMORY LRU (`EchoSuppressor`, one per peer, 5000 entries). A write
 *     dispatched to a peer records its content hash under the path, so the event
 *     that write causes is recognised as our own and not dispatched back. The
 *     reference bridge sizes this at 300, which is not a tuning preference but a
 *     defect: a bulk operation over more than 300 files evicts its OWN entries
 *     while it is still running, so entry 1's echo arrives to find no cached
 *     hash and bounces, and because each echo is itself a write it can echo
 *     again. 5000 covers a realistic bulk import or a folder rename.
 *  2. THE PERSISTED `mtime-size` BASELINE (`LiveSyncStateStore`). This is what
 *     survives a restart, and it is the loop breaker on the storage side: an
 *     inbound write stamps the document's mtime onto the file and records the
 *     resulting stat, so the scan that runs at the next startup does not see the
 *     file as locally changed and push it straight back. Deleting it because the
 *     LRU "already covers" the same event would restore precisely that loop, one
 *     process restart later.
 *
 * The two layers answer different questions ("did I just write these bytes here"
 * versus "is this file still as I last synced it") and neither one subsumes the
 * other. They live inside the peers; this comment exists because the composition
 * root is where someone would be tempted to add a third, cleverer one.
 */
function buildRuntime(
  signature: string,
  conf: LiveSyncCouchDBConf,
  state: LiveSyncStateStore,
  liveMode: boolean,
): Runtime {
  // The chicken-and-egg: the peers need dispatch functions, and the dispatch
  // functions need the peers. A reference cell resolves it without reaching for
  // the module-level `runtime`, which is what keeps a stale peer's late dispatch
  // from landing in a NEWER pair after a reconfiguration.
  const ref: { rt?: Runtime } = {};

  /**
   * Local change to CouchDB.
   *
   * This is where the bridge's `Hub.start()` ordering guarantee lives now. The
   * bridge awaits every CouchDB peer's `start()` before starting any storage
   * peer, because a storage peer's offline scan can otherwise push into a DB
   * manager that has not run `initializeDatabase()` yet ("Cannot read properties
   * of undefined (reading 'getDBEntryMeta')"). The ordering is right; awaiting an
   * infinite retry loop to get it is not, because CouchDB being down at boot then
   * means the filesystem side never starts at all and local edits are not even
   * observed.
   *
   * So: both peers start immediately, and the guarantee is asserted HERE, at the
   * only moment it actually matters. A dispatch arriving before the first connect
   * has settled waits for it (bounded), and `couch.put()` re-checks readiness and
   * throws `LiveSyncNotReadyError` if it still is not connected. A throw is not a
   * lost change: it deliberately leaves the file's sync baseline unadvanced, so
   * the next scan finds it again.
   */
  const dispatchToCouch: DispatchFn = async (path, data) => {
    const rt = ref.rt;
    if (!rt || rt.stopped) throw new LiveSyncNotReadyError('the LiveSync backend is not running');
    if (!rt.couch.isConnected() && !rt.couch.getFatalReason()) {
      await raceTimeout(rt.couchStarted, DISPATCH_READY_WAIT_MS);
    }
    const applied = data === false ? await rt.couch.delete(path) : await rt.couch.put(path, data);
    if (applied) rt.pushed += 1;
    return applied;
  };

  /**
   * Remote change to the vault.
   *
   * Note what is NOT here: any attempt to defer or batch inbound writes in
   * interval mode. It is tempting (settings.ts's `liveMode` note describes
   * interval mode as leaving "a window in which a misconfiguration can still be
   * noticed"), and it cannot be done at this seam without making things worse.
   * PouchDB's changes feed calls its `change` handler WITHOUT awaiting it, so
   * holding this promise applies no back-pressure at all: the feed keeps
   * emitting, and a first replication of a large remote vault would pile every
   * document's full content up in memory as blocked promises. Deferring the pull
   * direction needs a peer that can detach and re-attach its feed, not a queue
   * here. See `onVaultEvent` for what interval mode does govern.
   */
  const dispatchToStorage: DispatchFn = async (path, data) => {
    const rt = ref.rt;
    if (!rt || rt.stopped) throw new LiveSyncNotReadyError('the LiveSync backend is not running');
    const applied = data === false ? await rt.storage.delete(path) : await rt.storage.put(path, data);
    if (applied) rt.pulled += 1;
    return applied;
  };

  const storage = new StoragePeer(buildStorageConf(), {
    state,
    dispatch: dispatchToCouch,
    log: createPeerLogger('vault'),
  });

  const couch = new CouchDBPeer(conf, {
    state,
    dispatch: dispatchToStorage,
    log: createPeerLogger('couchdb'),
    /**
     * The recovery hook, and half of KICKOFF acceptance criterion 5 ("recovers
     * without a restart").
     *
     * Every local edit attempted while CouchDB was unreachable threw, and a
     * throw deliberately leaves that file's baseline unadvanced rather than
     * marking it synced. Those files are therefore exactly what an offline scan
     * finds. The pull direction repairs itself (the feed resumes from the
     * persisted checkpoint), so this is only about the push direction.
     *
     * Gated on `storageStarted` so the very first connect does not race the boot
     * scan into running twice: at that moment `storage.start()` is about to run
     * the same walk.
     *
     * THIS RECOVERY DEPENDS ON AN INVARIANT THE PEERS OWN: a dispatch that
     * FAILED must not leave its content hash in the echo-suppression LRU. The
     * LRU's job is to recognise a write that was applied; an entry recorded for
     * a write that threw makes the retry look like an echo, and the scan below
     * then skips the very file it just found. Measured, not theorised: with the
     * entry left in place a file edited during a CouchDB outage is reported by
     * the scan as changed and then silently dropped, so nothing is pushed and
     * the vault stays permanently behind.
     */
    onConnected: () => {
      const rt = ref.rt;
      if (!rt || rt.stopped || !rt.storageStarted) return;
      rt.lastScanAt = Date.now();
      void rt.storage.runOfflineScan().catch((e: unknown) => {
        log(`reconnect rescan failed: ${describeError(e)}`, 'error');
      });
    },
  });

  const rt: Runtime = {
    signature,
    state,
    storage,
    couch,
    // Replaced by the real handle in `ensureRunning`, immediately after the
    // runtime is published. Resolved rather than pending so that a dispatch
    // arriving in the gap waits for nothing instead of hanging.
    couchStarted: Promise.resolve(),
    liveMode,
    storageStarted: false,
    stopped: false,
    pushed: 0,
    pulled: 0,
    lastScanAt: 0,
  };
  ref.rt = rt;
  return rt;
}

/**
 * Bring the pair up, or confirm the running one still matches the settings.
 *
 * Runs inside the lock. Returns the runtime so callers can use it without
 * re-reading the module variable and finding it changed.
 */
async function ensureRunning(s: Settings): Promise<Runtime> {
  const conf = buildCouchConf(s);
  const errors = validateCouchDBConf(conf);

  if (s.sync.backend !== 'livesync') {
    /*
     * "Not selected" is sometimes a symptom rather than the cause, so say both.
     *
     * settings.ts's `enforceSyncSafety` heals `sync.backend` to 'none' when the
     * file asks for LiveSync with an obfuscation passphrase and no encryption
     * passphrase (opaque ids over plaintext bodies: worse than not obfuscating
     * at all). It is the right heal, and it means an operator who selected
     * LiveSync and hit that combination gets told the backend is not selected,
     * which is true and unhelpful on its own. Appending the real reason turns it
     * back into something actionable.
     */
    throw new Error(
      "the LiveSync backend is not selected (settings.sync.backend is not 'livesync')" +
        (errors.length > 0 ? `. The configuration is also refused because: ${errors.join(' ')}` : ''),
    );
  }

  if (errors.length > 0) {
    // Refuse rather than start-and-retry. None of these can be fixed by waiting,
    // and a backend that retries a permanent error every interval is the exact
    // silent-failure shape this port exists to remove.
    throw new Error(errors.join(' '));
  }

  const vaultRoot = await getVaultRoot();
  const signature = configSignature(vaultRoot, conf);

  const existing = runtime;
  if (existing && !existing.stopped) {
    if (existing.signature === signature) {
      // Same target: only the cheap, restart-free settings can have moved.
      existing.liveMode = s.livesync.liveMode;
      return existing;
    }
    // The vault, the database or a credential changed. Continuing against the
    // old pair would replicate this vault into the previous database, so the
    // pair is replaced wholesale rather than patched.
    log('configuration changed; restarting the peer pair.', 'notice');
    await stopRuntime(existing);
  }

  const state = new LiveSyncStateStore(LiveSyncStateStore.namespaceFor(vaultRoot, conf.baseDir), {
    log: createPeerLogger('state'),
  });
  const loaded = await state.load();
  if (loaded.reset) {
    // Announced, not silent: the consequence is a full rescan and a changes-feed
    // replay from the beginning, which is the safe direction but is also work an
    // operator will otherwise wonder about.
    log(`starting from zero: ${loaded.reason ?? 'no usable state'}`, 'notice');
  } else {
    log(`resuming: ${state.trackedCount()} tracked files, changes feed at ${state.getSince() || '0'}`);
  }

  installProcessHooks();

  const rt = buildRuntime(signature, conf, state, s.livesync.liveMode);
  runtime = rt;

  /*
   * Start order. Both start NOW; neither waits on the other.
   *
   * `couch.start()` resolves once the FIRST attempt has settled either way, with
   * its supervised retry loop continuing in the background, so holding the
   * handle is enough to express "the connect has been attempted" without
   * blocking on success. `storage.start()` accepts watcher events immediately
   * and then runs its offline scan in the background; the scan's first dispatch
   * is where the ordering guarantee is enforced (see `dispatchToCouch`).
   *
   * Not awaiting the scan is deliberate. It walks the whole vault, and
   * `connect()` is reachable from an HTTP route; the scan's progress is visible
   * through `status()` (the storage peer reports "scanning offline changes" and
   * health stays not-ok until it finishes, which is what stops a supervisor from
   * judging a peer that is still catching up).
   */
  rt.couchStarted = rt.couch.start();
  rt.storageStarted = true;
  rt.lastScanAt = Date.now();
  void rt.storage.start().catch((e: unknown) => {
    log(`vault peer failed to start: ${describeError(e)}`, 'error');
  });

  return rt;
}

/** Stop a pair and flush its state. Never throws: shutdown must not fail. */
async function stopRuntime(rt: Runtime): Promise<void> {
  rt.stopped = true;
  if (runtime === rt) runtime = null;
  try {
    await rt.storage.stop();
  } catch (e) {
    log(`vault peer stop failed: ${describeError(e)}`, 'error');
  }
  try {
    /*
     * The engine does not release everything `close()` implies.
     *
     * Measured while proving the engine works under Node: a TCP socket and a
     * timer survive `close()`, so a process that has used this peer will not
     * exit naturally once the event loop would otherwise be empty. Nothing here
     * can reclaim them (they are not reachable from this side of the vendored
     * API), which is precisely why `gracefulExit` below calls `process.exit`
     * explicitly instead of trusting the loop to drain. Everything this module
     * schedules itself is `unref`'d so that it is never the thing keeping the
     * process alive, and the leak is bounded per peer pair rather than per
     * operation, which is also why a reconfiguration replaces the pair rather
     * than reconnecting one in a loop.
     */
    await rt.couch.stop();
  } catch (e) {
    log(`couchdb peer stop failed: ${describeError(e)}`, 'error');
  }
  try {
    // The final, unconditional flush. The state store's ordinary writes are
    // debounced by 1.5s, so without this every deploy loses up to that much of
    // the file baselines and, more importantly, the changes-feed checkpoint.
    await rt.state.close();
  } catch (e) {
    log(`state flush failed: ${describeError(e)}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// The operations
// ---------------------------------------------------------------------------

async function connectImpl(): Promise<void> {
  const s = await getSettings();
  const rt = await ensureRunning(s);
  // Bounded (see CONNECT_WAIT_MS): the retry loop continues regardless, and
  // status() is where the answer to "is it connected" actually lives.
  await raceTimeout(rt.couchStarted, CONNECT_WAIT_MS);
  if (rt.couch.isConnected()) {
    lastError = null;
    log(`connected to ${describeRemote(s)}`);
  }
}

/**
 * One reconciliation pass: make sure the pair is up, then push whatever the
 * vault has that CouchDB does not.
 *
 * The analogue of `git.ts`'s `syncImpl`, and the same shape of return value, so
 * autosync.ts can log both backends identically. Runs entirely inside the lock
 * (via the exported `sync` wrapper), so it calls `ensureRunning` and the peer
 * methods directly: re-entering `withSyncLock` here would dead-lock, exactly as
 * it would in git.ts.
 *
 * There is no explicit "pull" step, and its absence is structural rather than an
 * omission. The inbound direction is a live CouchDB changes feed owned by the
 * CouchDB peer: it applies remote changes as they arrive and advances its
 * persisted checkpoint per change. There is nothing for a tick to trigger, and a
 * tick that pretended to pull would be reporting on work it did not do.
 *
 * NOT DRIVING A DIRECTION IS NOT A LICENCE TO STAY QUIET ABOUT IT. The pass
 * therefore reads the CouchDB peer's inbound ledger and reports it, and `ok` is
 * derived from it rather than from connectivity alone. See the block above the
 * `ok` assignment for what that changed and why it had to.
 */
async function syncImpl(opts: LiveSyncPassOptions): Promise<{ ok: boolean; log: string[] }> {
  const lines: string[] = [];
  const s = await getSettings();
  if (s.sync.backend !== 'livesync') {
    // Not an error: a route can legitimately ask while the backend is off.
    return { ok: false, log: ['LiveSync is not the selected sync backend'] };
  }

  let rt: Runtime;
  try {
    rt = await ensureRunning(s);
  } catch (e) {
    const detail = recordError('LiveSync could not start', e);
    return { ok: false, log: [`Could not start: ${detail}`] };
  }

  const before = { pushed: rt.pushed, pulled: rt.pulled, failed: rt.couch.inbound().failed };
  await raceTimeout(rt.couchStarted, CONNECT_WAIT_MS);

  const fatal = rt.couch.getFatalReason();
  if (fatal) {
    lastError = fatal;
    return { ok: false, log: [`Configuration error: ${fatal}`] };
  }

  /*
   * The LINK, not the lifecycle. `isConnected()` answers "did the connect
   * sequence complete", which stays true for the whole of an outage of any
   * length, so a pass during a dead link used to open with "Connected to
   * couch.example/vault" and then report everything else honestly. See
   * `CouchDBPeer.isLinkUp()`.
   */
  const connected = rt.couch.isLinkUp();
  lines.push(connected ? `Connected to ${describeRemote(s)}` : 'CouchDB is not reachable; retrying in the background');

  /*
   * The push pass.
   *
   * In interval mode this IS the push mechanism: watcher events are not
   * forwarded, so every local change reaches CouchDB from here, detected by its
   * `mtime-size` differing from the recorded baseline. In live mode the watcher
   * has already pushed, so for a PERIODIC pass the scan is only a safety net
   * against an event the watcher never delivered and runs at most every
   * LIVE_MODE_SAFETY_SCAN_MS. An explicitly requested pass always scans: see
   * LiveSyncPassOptions.
   *
   * The scan also recovers changes that were dispatched and REFUSED while
   * CouchDB was down, because a refused dispatch deliberately leaves the
   * baseline unadvanced. Running it while still disconnected is therefore not
   * wasted: each file will throw again, cheaply, and stay pending. What it must
   * not do is silently mark anything as synced, and it does not.
   */
  const dueForScan =
    !opts.periodic || !rt.liveMode || Date.now() - rt.lastScanAt >= LIVE_MODE_SAFETY_SCAN_MS;
  if (dueForScan) {
    rt.lastScanAt = Date.now();
    // The peer coalesces a scan request with one already in flight (it has its
    // own re-entrancy guard, which is right: two concurrent walks of one vault
    // would dispatch every file twice). That means this call can return without
    // having done the work, so ask first and report what actually happened
    // rather than what was requested. `ok` is false for the storage peer exactly
    // while it is scanning, which is the fact wanted here.
    const alreadyScanning = !rt.storage.snapshot().ok;
    try {
      await rt.storage.runOfflineScan();
      lines.push(
        alreadyScanning
          ? 'A reconciliation scan was already in progress'
          : 'Reconciled the vault against the recorded sync baselines',
      );
    } catch (e) {
      const detail = recordError('Reconciliation scan failed', e);
      lines.push(`Reconciliation scan failed: ${detail}`);
      return { ok: false, log: lines };
    }
  } else {
    lines.push('Live mode: local changes are pushed by the vault watcher');
  }

  const pushed = rt.pushed - before.pushed;
  const pulled = rt.pulled - before.pulled;
  // Honest numbers or none: these are counted by the dispatch wrappers as
  // changes are actually applied, not estimated from a file walk.
  if (pushed || pulled) lines.push(`Applied ${pushed} local and ${pulled} remote change(s) during this pass`);

  /*
   * THE PULL DIRECTION, REPORTED RATHER THAN OMITTED.
   *
   * This function still does not DRIVE the inbound direction, for the structural
   * reason the header gives, and nothing here pretends otherwise. What changed is
   * that it no longer stays silent about it either. `ok` used to be
   * `connected && health.ok`, which is a claim about a socket and a lifecycle
   * flag: a peer whose feed was attached and delivering nothing satisfied both,
   * so every tick logged "sync ok", set `lastSyncAt` and CLEARED `lastError`,
   * actively erasing the last recorded failure while the vault fell further
   * behind. An operator reading "ok" reasonably concludes it worked.
   *
   * So the pass now reports what the inbound ledger actually observed, and `ok`
   * is derived from it. `inbound.stalled` is the standing condition (nothing is
   * landing) and `failed` is the per-pass one (something arrived and could not be
   * written). The second is a delta on purpose: a document that can never be
   * written would otherwise pin `ok` false forever, and a permanently-false
   * verdict is as uninformative as a permanently-true one.
   */
  const inbound = rt.couch.inbound();
  const failed = inbound.failed - before.failed;
  /*
   * `received` and `delivered` are both reported, and the gap between them is
   * information rather than noise. `received` counts everything the changes feed
   * emitted and is what moves the feed cursor; `delivered` counts the note-typed
   * subset that the engine goes on to decrypt. A remote whose `received` climbs
   * while `delivered` does not is replicating version, syncinfo or chunk-pack
   * traffic and no notes, which is a perfectly healthy state that used to be
   * indistinguishable from a dead feed.
   */
  lines.push(
    `Inbound: ${inbound.state} (${inbound.detail}); ` +
      `${inbound.received} change(s) received, ${inbound.delivered} of them notes, ` +
      `${inbound.applied} applied, ${inbound.skipped} ignored, ${inbound.failed} failed since start`,
  );
  if (failed > 0) {
    lines.push(`${failed} remote change(s) could not be written to the vault during this pass`);
  }

  const health = combineHealth(await probePeers(rt));
  if (!health.ok) {
    const detail = health.peers.map((p) => `${p.name}: ${p.detail ?? (p.ok ? 'ok' : 'not ok')}`).join('; ');
    lines.push(`Not fully healthy (${detail})`);
  }

  // `health.ok` already folds in the stall (the CouchDB peer's snapshot consults
  // the same ledger), so `!inbound.stalled` is redundant today. It is spelled out
  // anyway: this is the assertion that must not be quietly lost if a future edit
  // changes what a peer snapshot means, and the cost of stating it is nothing.
  const ok = connected && health.ok && !inbound.stalled && failed === 0;
  if (ok) {
    lastError = null;
    lastSyncAt = Date.now();
  }
  return { ok, log: lines };
}

async function disconnectImpl(): Promise<void> {
  const rt = runtime;
  if (!rt) return;
  log('disconnecting.');
  await stopRuntime(rt);
}

async function statusImpl(): Promise<LiveSyncStatus> {
  const s = await getSettings();
  const rt = runtime;
  // Config errors are reported whether or not a pair is running, so the settings
  // UI can explain a backend that refuses to start without having to start it.
  const configErrors = validateCouchDBConf(buildCouchConf(s));
  const peers = rt && !rt.stopped ? await probePeers(rt) : [];
  const health = combineHealth(peers);
  return {
    backend: s.sync.backend,
    enabled: s.sync.backend === 'livesync',
    running: Boolean(rt) && rt?.stopped === false,
    /*
     * The LINK, and `running` above is the lifecycle. Splitting them here is the
     * whole point: an operator reading this API, and `classifyDetail()` in
     * routes/livesync.ts reading it on their behalf, is asking whether CouchDB is
     * reachable right now, and the lifecycle flag answered that with a permanent
     * yes for the entire duration of any mid-session drop. `classifyDetail`'s
     * `not connected to CouchDB` case was unreachable as a result, so the public
     * health endpoint reported the vaguer `peers not syncing` for the first minute
     * of every outage. See `CouchDBPeer.isLinkUp()`.
     */
    connected: rt?.couch.isLinkUp() ?? false,
    liveMode: s.livesync.liveMode,
    intervalSec: s.livesync.intervalSec,
    remote: describeRemote(s),
    database: s.livesync.database,
    healthy: health.ok,
    restartWorthy: health.restartWorthy,
    peers: health.peers,
    trackedFiles: rt?.state.trackedCount() ?? 0,
    applied: { pushed: rt?.pushed ?? 0, pulled: rt?.pulled ?? 0 },
    inbound: rt && !rt.stopped ? rt.couch.inbound() : null,
    unhandledRejections,
    lastUnhandledRejectionAt:
      lastUnhandledRejectionAt === null ? null : new Date(lastUnhandledRejectionAt).toISOString(),
    lastSyncAt: lastSyncAt === null ? null : new Date(lastSyncAt).toISOString(),
    lastError,
    configErrors,
    fatalReason: rt?.couch.getFatalReason() ?? null,
  };
}

/**
 * Both peers' full health verdicts.
 *
 * `probeHealth()` is cheap when a peer is healthy (the tracker returns early
 * without touching the network) and does a bounded reachability probe only when
 * it is not, which is exactly when a status caller wants the extra fact: it is
 * what separates "CouchDB is down, wait" from "CouchDB answers and we still are
 * not syncing, this process is at fault".
 */
function probePeers(rt: Runtime): Promise<PeerHealth[]> {
  return Promise.all([rt.storage.probeHealth(), rt.couch.probeHealth()]);
}

// ---------------------------------------------------------------------------
// The vault watcher seam
// ---------------------------------------------------------------------------

/**
 * Feed one filesystem event in, from the composition root's chokidar fanout.
 *
 * This is the answer to KICKOFF section 5.4's open question. WebObsidian already
 * runs exactly one watcher over the vault (`server/src/index.ts`), with an
 * ignore list, an `awaitWriteFinish` window and a self-healing fallback to
 * polling; a second watcher would mean two independent debounce windows over one
 * file, twice the inotify budget, and two places to fix the next watcher bug. So
 * the storage peer does not own a watcher, and this function is how the existing
 * one drives it.
 *
 * Synchronous, cheap and never throwing, because it is called from that fanout's
 * hot path alongside the search index and the websocket broadcast.
 *
 * WHAT `liveMode` GOVERNS, and why it is this and not the pull direction:
 *
 * The engine offers exactly one way to receive remote changes, a live changes
 * feed, and the CouchDB peer attaches it as part of connecting. Interval mode
 * therefore cannot mean "do not receive"; deferring inbound writes at the
 * dispatch seam would buffer the entire remote vault in memory (see
 * `dispatchToStorage`), and tearing the connection down between ticks would
 * churn a fresh manipulator, and a leaked socket, every interval.
 *
 * What interval mode CAN do, and does here, is hold the push direction: local
 * changes are not forwarded as they happen, they are found by the next tick's
 * reconciliation scan. That is the direction that matters most for the hazard
 * settings.ts describes (an operator who mistypes a database name, or points a
 * fresh instance at somebody else's cluster), because it is the direction that
 * publishes this operator's notes to a stranger's database. Nothing leaves the
 * vault until a tick, and until then a misconfiguration is still correctable.
 */
export function onVaultEvent(relPath: string, kind = 'change'): void {
  const rt = runtime;
  if (!rt || rt.stopped || !rt.liveMode) return;
  // Directory events carry no content. chokidar emits an `unlink` per watched
  // file when a directory is removed, so the files are covered either way, and
  // forwarding the directory itself would only make the peer stat a path it is
  // going to reject.
  if (kind === 'addDir' || kind === 'unlinkDir') return;
  const eventKind = kind === 'add' || kind === 'unlink' ? kind : 'change';
  rt.storage.onVaultEvent(relPath, eventKind);
}

/** True when a peer pair is up. Cheap; safe to call from a request path. */
export function isRunning(): boolean {
  return runtime !== null && !runtime.stopped;
}

// ---------------------------------------------------------------------------
// Process hooks
// ---------------------------------------------------------------------------

let processHooksInstalled = false;

/**
 * Install the two hooks the engine makes necessary, once, and only once the
 * LiveSync backend is actually being used.
 *
 * Lazy on purpose: an install that never selects this backend must behave
 * exactly as it does today (KICKOFF acceptance criterion 7 is about git, but the
 * same reasoning applies to process-wide signal handling), and a SIGTERM handler
 * registered at import time would change how every git-only deployment shuts
 * down.
 */
function installProcessHooks(): void {
  if (processHooksInstalled) return;
  processHooksInstalled = true;

  /*
   * The engine's fire-and-forget init.
   *
   * `new DirectFileManipulator(...)` kicks off an async database init that is
   * never awaited by the constructor, and a transient CouchDB hiccup (a non-JSON
   * body from a proxy, or a database still warming up at boot) surfaces as an
   * unhandled rejection from deep inside PouchDB. The reference bridge's author
   * documented what that cost them: it crash-looped the daemon into systemd's
   * start limit and left it down, silently, for days.
   *
   * `server/src/index.ts` already installs an `unhandledRejection` listener, and
   * the presence of ANY listener is what suppresses Node's default fatal
   * behaviour, so the process already survives. This one is additive (Node calls
   * every listener) and exists for the second half of the problem: it renders
   * the reason through `describeError`, which strips credentials out of a
   * PouchDB error that quotes its request URL. The generic handler in index.ts
   * prints the raw reason, so this line is what guarantees that a LiveSync-origin
   * rejection is redacted at least once in the log.
   */
  process.on('unhandledRejection', (reason: unknown) => {
    if (!isRunning()) return; // not ours to explain
    /*
     * COUNTED, NOT JUST PRINTED, and that is the change.
     *
     * A log line is invisible to every consumer of this subsystem's health: the
     * status API, the beat, `/healthz/livesync` and the settings panel all read
     * structured fields, and none of them reads stdout. That mattered because
     * this handler is where the engine's most damaging failure surfaces. A
     * document whose decryption throws inside `transform-pouch`'s discarded
     * listener promise arrives HERE and nowhere else: the feed stays attached,
     * `watching` stays true, no `error` event fires, and before the inbound
     * ledger existed the entire observable consequence of losing that document
     * was this one line.
     *
     * The count is now published through `statusImpl`, so "the process is
     * catching rejections it cannot explain" is a fact an operator can see next
     * to `inbound.undecodable`, which is the same event measured from the other
     * side.
     *
     * KNOWN GAP, AND IT IS NOT FIXABLE FROM HERE. The engine's OTHER swallowing
     * path never reaches this handler at all: `EntryManager.getDBEntryFromMeta`
     * catches its failures, writes "Missing document content!" or "Something went
     * wrong on reading ..." through octagonal-wheels' `Logger` at NOTICE, and
     * returns false. Capturing those needs `setGlobalLogFunction`, which the
     * vendored package does not re-export (`server/vendor/livesync-engine/src/entry.ts`
     * exports only `Logger` and `defaultLoggerEnv`). Note also that the vendored
     * `index.d.ts` declares `defaultLoggerEnv.logger`, which does NOT exist at
     * runtime: octagonal-wheels' `defaultLoggerEnv` carries `minLogLevel` and
     * nothing else, so assigning that property compiles, does nothing, and would
     * look exactly like a working sink. Both are vendor-tree fixes. Until then
     * those lines go to bare stdout uncounted, which is why the inbound ledger
     * measures the CONSEQUENCE (a document that never settles) rather than
     * relying on the engine to report the cause.
     */
    unhandledRejections += 1;
    lastUnhandledRejectionAt = Date.now();
    log(`unhandled rejection while syncing (kept alive): ${describeError(reason)}`, 'error');
  });

  /*
   * Shutdown.
   *
   * Two separate reasons this cannot be left to Node's default:
   *
   *  1. The state store's writes are debounced by 1.5s. Without an explicit
   *     flush, every deploy loses up to that much: the file baselines (costing a
   *     redundant rescan, recoverable) and the changes-feed checkpoint (costing a
   *     replay from the last persisted sequence, also recoverable but noisy).
   *  2. The engine leaks a socket and a timer past `close()`, so once this
   *     backend has run, the event loop never empties on its own and a process
   *     that politely waits for it to drain hangs forever.
   *
   * `once`, not `on`, and that is the escape hatch: after our handler has run,
   * the listener is removed, so a second SIGTERM from an impatient supervisor
   * takes Node's default action and terminates immediately.
   */
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void gracefulExit(signal);
    });
  }
}

/**
 * Stop the pair, flush the state, and end the process.
 *
 * Bounded twice over. `shutdownLiveSync` races the (locked) disconnect against a
 * timeout so that a reconciliation scan in flight cannot hold a deploy open, and
 * it then flushes the state store directly even if that race was lost, because
 * the store serialises its own writes and does not need the module lock. Losing
 * the checkpoint is recoverable; hanging a deploy is not.
 */
async function gracefulExit(signal: string): Promise<void> {
  log(`${signal} received; flushing LiveSync state.`, 'notice');
  await shutdownLiveSync();
  process.exit(0);
}

export async function shutdownLiveSync(timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<void> {
  const rt = runtime;
  await raceTimeout(disconnect(), timeoutMs);
  if (rt) {
    // Belt to the braces above: if the disconnect is still queued behind a long
    // op, at least the checkpoint and the baselines reach the disk.
    await raceTimeout(rt.state.flush(), timeoutMs);
  }
}
