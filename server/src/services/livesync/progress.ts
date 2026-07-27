/**
 * The inbound progress ledger: the fact the health model was missing.
 *
 * WHY THIS EXISTS. Before this module, `CouchDBPeer.snapshot()` answered "am I
 * syncing?" with `connected && man.watching`. `watching` is a plain boolean the
 * vendored engine sets to true once in `beginWatch()` and clears only on the
 * feed's `complete` or `error` events. That makes it a statement about a socket,
 * not about work, and there are at least three ways for the inbound direction to
 * stop dead while it stays true. All three were traced in the vendored source and
 * are named here because each one is a reason a specific counter below exists:
 *
 *  1. DECRYPTION THROWS AND THE THROW IS DISCARDED. Decryption is installed as a
 *     PouchDB `transform` (upstream/src/API/DirectFileManipulatorV2.ts around
 *     `$everyOnInitializeDatabase`, which calls `enableEncryption`, which ends in
 *     `db.transform({ incoming, outgoing })`). `transform-pouch` wraps a `change`
 *     listener as `async (change) => origListener(await modifyChange(change))`
 *     and registers that on an EventEmitter, so the returned promise is dropped
 *     on the floor. When `outgoing` rejects (a wrong passphrase, an unknown
 *     encryption version, a corrupt chunk) the engine's real listener is never
 *     called, no `error` event fires, `watching` stays true, and the only trace
 *     is a process-level unhandled rejection.
 *  2. THE ENGINE AWAITS `getByMeta` OUTSIDE ITS OWN TRY. In `beginWatch`'s
 *     listener the line `const docX = await this.getByMeta(doc);` sits above the
 *     `try` that guards the callback, and `getByMeta` throws readily ("Corrupted
 *     document", and every `return false` inside `EntryManager` funnels into it).
 *     Same terminal state as (1).
 *  3. A CHUNK WAIT THAT CAN NEVER SETTLE. `ChunkManager._enqueueWaiting` hands a
 *     second waiter for the same chunk id the RAW `resolver.promise` while the
 *     first waiter holds a `withTimeout` wrapper. On timeout the wrapper resolves
 *     `false` and deletes the map entry, so the second waiter's promise has no
 *     route to resolution left at all. `_waitForArrival` gathers with
 *     `Promise.all`, so one hung chunk hangs the whole read, hence `getByMeta`,
 *     hence the un-try-caught await in (2). This one produces no throw and no log
 *     line at any level: the listener simply never completes.
 *
 * All three are upstream defects and the vendored tree is read only, so none of
 * them can be fixed where they happen. What they have in common is observable
 * from our side: a document arrives at the feed and never reaches the vault. This
 * module is the bookkeeping that makes that observable, and it deliberately keeps
 * the cases APART rather than collapsing them into one "not ok", because they
 * call for different responses:
 *
 *  - `undecodable` (delivered, never decoded) is a decryption failure. Whether it
 *    is FATAL depends on a second fact this ledger already holds, and getting that
 *    wrong is worse than not reporting it at all: see `verdict()`.
 *  - `unapplied` (decoded, never settled) is a wedge. Restarting plausibly helps,
 *    so it must reach `HealthTracker` and let the existing restart machinery act.
 *  - `unwritable` (decoded, reached the vault, and the write threw, with nothing
 *    landing since) is not an engine defect at all: it is a full disk, a volume
 *    remounted read-only, or a uid change. It has to be reported because a
 *    failure settles the ledger, so without its own clock a peer where EVERY
 *    write fails reads as `idle` and answers 200. See `noteFailed()`.
 *  - `undelivered` (the remote has changes past the feed's own cursor and the
 *    feed is delivering nothing) is the case none of the in-process counters can
 *    see, because nothing arrives to count. It needs the peer's out-of-band
 *    `_changes` probe, which feeds `setRemotePending()` below.
 *
 * TWO QUANTITIES THAT LOOK LIKE ONE, AND THE BUG THAT CAME FROM CONFLATING THEM.
 * "The feed has delivered up to here" and "we have applied a note up to here" are
 * different facts, and this module now tracks only the first. An earlier revision
 * advanced the feed cursor exclusively for `newnote`/`plain` documents, because
 * those are the only ones the engine hands on to its interest predicate. But the
 * feed's server-side selector is `{ type: { $ne: "leaf" } }`, which is strictly
 * wider: `versioninfo` (written to the remote by upstream's own version
 * negotiation on every version bump), `syncinfo`, `notes` (every document in a
 * vault migrated from an older LiveSync) and `chunkpack` all pass it. Any one of
 * them sitting past the cursor made the peer's out-of-band probe answer "the
 * remote has changes you have not received" forever, which is a permanent false
 * wedge: a 503 on `/healthz/livesync`, a restart every cooldown, and a reset on
 * reconnect that only restarts the loop. The cursor therefore advances on EVERY
 * delivered change (`noteFeedChange`), while the decode receipt is owed only by
 * the documents that will actually be decoded. The probe's selector and the
 * cursor now agree by construction rather than by keeping two type lists in step.
 *
 * THE CLOCK DISCIPLINE IS PORTED FROM `HealthTracker`, NOT INVENTED. Every one of
 * the conditions is timed, and every one of them has its clock RESET by evidence
 * of progress rather than by the absence of evidence, which is the same rule as
 * `HealthTracker.probe()`'s "a single ok probe resets the clock completely".
 * Without the window, ordinary asynchrony reads as a stall: a healthy document is
 * `delivered` synchronously and `decoded` a microtask later, so the gap is
 * non-zero for a moment on every single document that ever arrives.
 *
 * WHAT COUNTS AS "PROGRESS" IS PER DOCUMENT, THOUGH, and reading it as per peer
 * silently disabled the two detectors it applies to. Both clocks used to be one
 * timestamp restamped to now whenever anything settled while anything remained
 * outstanding, so a wedged document was masked by any concurrent stream of other
 * documents, which is the default deployment rather than a corner case. See
 * `PendingClock`, which holds one entry per outstanding document and answers the
 * question the clocks were always meant to ask.
 *
 * Nothing in here does I/O, holds a timer, or knows what a peer is. It is a
 * counter with a clock, so the wedge conditions can be tested without a CouchDB.
 */

/**
 * How long a delivered document may go undecoded before decryption is judged
 * broken.
 *
 * Decryption is CPU-bound and local: an HKDF derive plus an AES-GCM open, both
 * measured in milliseconds. Thirty seconds is three orders of magnitude of
 * headroom, chosen so that this can never fire because a machine was briefly
 * busy, only because the decrypt genuinely never completes.
 */
export const DECODE_GRACE_MS = 30_000;

/**
 * How long a decoded document may go unsettled before the apply path is judged
 * wedged.
 *
 * Must sit ABOVE the engine's own `LEAF_WAIT_TIMEOUT` (30s,
 * upstream/src/common/types.ts), or a document that is waiting normally for a
 * chunk that is merely late would be reported as wedged. Two minutes leaves room
 * for several sequential chunk waits on a large attachment while still catching
 * mechanism 3's permanent hang, which never resolves at any duration.
 */
export const APPLY_GRACE_MS = 120_000;

/**
 * How long the remote may hold changes past the feed's cursor before the feed is
 * judged dead.
 *
 * `RESTART_GRACE_MS` in health.ts, deliberately: this condition is exactly the
 * kind the restart machinery is meant to act on, and giving it a different window
 * would mean the two halves of the same decision disagreed about how patient to
 * be. It also sits far outside the engine's own ten-second watch reconnect, so
 * ordinary self-healing never trips it.
 */
export const DELIVER_GRACE_MS = 60_000;

/**
 * How long the out-of-band pending-changes probe may fail to answer before the
 * inbound direction is declared unmeasurable.
 *
 * NOT ZERO, and not one failed attempt. The probe is a network request against
 * the operator's CouchDB and a single one can fail for reasons that say nothing
 * about the feed: a dropped connection, a proxy restarting, a burst of chunk
 * writes that pushes the emptiness scan past its own timeout. Flipping the health
 * signal on one of those would produce exactly the alarm nobody believes.
 *
 * The same 60 seconds as `DELIVER_GRACE_MS`, for the same reason it matches
 * `RESTART_GRACE_MS`: "the feed may be dead" and "I can no longer tell whether
 * the feed is dead" are two halves of one question, and they should not disagree
 * about how patient to be. At the peer's 20-second probe cadence this means at
 * least three consecutive failures, so a transient one is invisible and a
 * genuinely broken probe is reported inside a minute.
 */
export const PROBE_GRACE_MS = 60_000;

/**
 * How long every inbound write may go on failing, with none succeeding, before
 * the vault side is judged unwritable.
 *
 * NOT ZERO, for the reason `noteFailed()` gives: a single failed write is a real
 * event but not yet a condition, and one transient EBUSY on a Windows vault or
 * one file momentarily held open by an indexer must not flip the health signal.
 * The clock is cleared by `noteApplied()` and by nothing else, so a peer that is
 * writing anything at all never reaches this state however many individual
 * writes fail alongside; only a peer where NOTHING is landing does.
 *
 * The same 60 seconds as `DELIVER_GRACE_MS` and `PROBE_GRACE_MS`, so the module
 * has one notion of how patient to be with a standing condition rather than
 * three that quietly disagree. It is deliberately NOT tied to a per-pass verdict:
 * `syncImpl` separately refuses to call a pass ok when the `failed` counter moved
 * during it, and that catches the failures that land inside a pass window. This
 * clock is what catches the ones that do not, which is the common case on an idle
 * vault where a pass window is a millisecond wide and a full disk is permanent.
 */
export const WRITE_GRACE_MS = 60_000;

/**
 * How long the replication checkpoint may sit held behind a change that failed
 * to apply before the peer says so out loud.
 *
 * THE CONDITION THIS TIMES IS NOT A FAULT, IT IS A DEFERRED RETRY, which is why
 * it gets a window rather than an immediate verdict. A single failed inbound
 * write holds the checkpoint (see `noteCheckpointHeld`), and the great majority
 * of those clear themselves: the engine re-arms its own feed ten seconds after an
 * error, the re-arm resumes from the held checkpoint, and the document is applied
 * on the second attempt with nobody the wiser. Reporting that as a stall would
 * turn ordinary self-healing into an alarm.
 *
 * What must NOT stay quiet is the other case: a hold that is still standing a
 * minute later means the failed change is waiting for a replay that is not coming
 * on its own, and the vault is missing a note that the status API would otherwise
 * describe as `idle`. The same 60 seconds as `DELIVER_GRACE_MS`, `PROBE_GRACE_MS`
 * and `WRITE_GRACE_MS`, so this module keeps one notion of how patient to be with
 * a standing condition instead of four that quietly disagree.
 */
export const HELD_GRACE_MS = 60_000;

/** What the inbound direction is doing, as a fixed vocabulary. */
export type InboundState =
    /** Nothing outstanding and nothing pending on the remote. Genuinely idle. */
    | 'idle'
    /** Work outstanding, and progressing inside its window. */
    | 'flowing'
    /**
     * Documents arrived at the feed and NOTHING has ever decoded. Decryption is
     * broken outright, which no amount of retrying changes.
     */
    | 'undecodable'
    /**
     * Some documents failed to decode while others succeeded. Real loss, but not
     * a broken configuration: see `verdict()` for why the difference decides
     * whether this peer stops or keeps running.
     */
    | 'degraded'
    /** Documents decoded and never settled: the apply path is wedged. */
    | 'unapplied'
    /**
     * Every decoded document that reached the vault threw on the way in, and
     * none has landed since. A full disk, a volume remounted read-only, a uid
     * change. Loud rather than fatal: the fault is outside this process and
     * clears itself the moment one write succeeds.
     */
    | 'unwritable'
    /**
     * A remote change failed to apply, so the replication checkpoint is being
     * held at it, and the hold has outlasted the replays that normally clear it.
     *
     * Distinct from `unwritable`, which is the total case (nothing is landing at
     * all). This is the PARTIAL one: other changes are applying perfectly well
     * and the vault is nonetheless missing the ones that failed, which is exactly
     * the combination that used to resolve to `idle` and answer 200.
     */
    | 'behind'
    /** The remote has work past the feed's cursor and the feed delivers nothing. */
    | 'undelivered'
    /**
     * The inbound direction cannot be measured, so none of the above can be
     * ruled out. Reported as a stall rather than as health: an unmeasurable
     * subsystem must never answer "fine". Two ways in, and they are deliberately
     * the same answer: the raw feed could not be instrumented
     * (`CouchDBPeer.instrumentFeed()`), or the pending-changes probe has stopped
     * answering (`noteProbeUnanswerable()`).
     */
    | 'unobservable';

export interface InboundCounts {
    /**
     * Every change the raw feed emitted, of every type.
     *
     * Distinct from `delivered` on purpose. This is the number that proves the
     * feed is alive, and it counts the `versioninfo`, `syncinfo`, `notes` and
     * `chunkpack` documents that pass the feed's selector but never reach the
     * engine's note handling. It is also the count that moves the cursor.
     */
    received: number;
    /** Note-typed changes the raw feed emitted. These owe a decode receipt. */
    delivered: number;
    /** Changes that reached the engine's interest predicate, i.e. decrypted. */
    decoded: number;
    /** Decoded changes this peer deliberately ignored (prefixed or out of baseDir). */
    skipped: number;
    /** Decoded changes written to the vault, with the checkpoint advanced. */
    applied: number;
    /** Decoded changes whose write threw. Loud, counted, and NOT a stall: see below. */
    failed: number;
}

export interface InboundVerdict extends InboundCounts {
    state: InboundState;
    /**
     * Why, from a fixed vocabulary plus counts. Never carries an error string or
     * a path: this reaches the status API, and `routes/livesync.ts` explains at
     * length why free-form text must not.
     */
    detail: string;
    /** Health must be false. True for every state except `idle` and `flowing`. */
    stalled: boolean;
    /**
     * Waiting cannot fix this, and neither can restarting.
     *
     * Only `undecodable`, i.e. only when NOTHING has ever decoded. See
     * `verdict()`: this flag stops the peer outright, so the evidence behind it
     * has to be evidence of a broken configuration rather than of a bad document.
     */
    fatal: boolean;
    /**
     * Reported unhealthy, and RESTARTING CANNOT CHANGE THAT.
     *
     * A separate axis from `fatal`, which is stronger: `fatal` stops the peer and
     * takes the push direction down with it, so it is reserved for a broken
     * configuration. This one says only "keep reporting it, but do not act on it
     * by reconnecting", and it exists because the supervisor's one lever is a
     * reconnect.
     *
     * The rule, from `routes/livesync.ts`'s `maybeRestart`: a restart tears the
     * peer pair down and builds a fresh one, which replays the changes feed from
     * the persisted checkpoint and runs a full offline vault scan through
     * `onConnected`. For a condition a fresh pair reproduces immediately, that is
     * a costly no-op repeated every cooldown for as long as the condition lasts,
     * which is forever for all three of:
     *
     *  - `unobservable`: either the raw feed cannot be instrumented (a dependency
     *    shape a new emitter has too) or the out-of-band probe is not answering
     *    (a proxy or network fault the peer does not own). Neither is fixed by a
     *    new connection.
     *  - `degraded` and `undecodable`: a specific remote document does not
     *    decrypt. The replay hands the same document back, so the restart's only
     *    effect is a vault rescan and another 5 minutes of the same verdict.
     *  - `unwritable`: the vault volume is full or read-only. Nothing about the
     *    CouchDB connection is involved.
     *
     * `unapplied` and `undelivered` are deliberately NOT futile and keep their
     * restart: a hung chunk wait and a black-holed long-poll are exactly what a
     * fresh manipulator fixes, and that is the recovery this whole subsystem was
     * built to trigger.
     */
    restartFutile: boolean;
    /** How long the reported condition has persisted. 0 when not stalled. */
    stalledMs: number;
    /** Documents lost between the feed and decryption. */
    undecodable: number;
    /** Documents lost between decryption and the vault. */
    unapplied: number;
    /**
     * The replication checkpoint is being held behind a change that failed to
     * apply, so that change is replayed rather than skipped.
     *
     * Published as a plain fact rather than only as a `state`, because it is true
     * for the whole of `HELD_GRACE_MS` before the state says anything, and an
     * operator reading the status API during that window should be able to see
     * that the checkpoint is not where the feed is. It is also the one number in
     * the ledger that explains why a restart is worth doing: the restart is what
     * performs the replay.
     */
    checkpointHeld: boolean;
}

export interface InboundProgressOptions {
    decodeGraceMs?: number;
    applyGraceMs?: number;
    deliverGraceMs?: number;
    probeGraceMs?: number;
    writeGraceMs?: number;
    heldGraceMs?: number;
}

/**
 * Bucket for entries whose caller could not name a document. See `PendingClock`.
 *
 * A document id, being a CouchDB `_id`, is never the empty string, so this
 * cannot collide with a real one.
 */
const UNNAMED = '';

/**
 * "How long has the OLDEST outstanding document been outstanding?", answered per
 * document rather than per peer.
 *
 * THE BUG THIS REPLACES, because the shape only makes sense against it. Both
 * stall clocks used to be a single `number | undefined` restamped to `Date.now()`
 * whenever anything settled while anything remained outstanding. That reads as
 * the module's own rule ("evidence of progress resets the clock") and is not:
 * progress on document B is not evidence about document A. Measured, before the
 * fix: one wedged document on its own reported `unapplied` and `stalled: true`;
 * the same wedged document with any concurrent stream of OTHER documents
 * reported `flowing` and `stalled: false`, permanently. The detector worked
 * only in isolation, and the masking stream is the default deployment rather
 * than a corner case: `i:` internal documents are note-typed, so they are
 * delivered, decoded, refused by the interest predicate and settled, and an
 * actively edited vault's own pushes echo back through the feed with the same
 * effect.
 *
 * WHY A PLAIN FIFO IS NOT ENOUGH EITHER, since that is the obvious repair.
 * Completion is genuinely out of order here: the whole point of mechanism 3 in
 * the header is one document hanging on a chunk while every other document
 * behind it completes normally. A queue that pops its head on each settle
 * therefore pops the WEDGED document's timestamp on the first unrelated
 * completion, the head becomes a fresh timestamp, and the stall is masked again
 * one settle later. So entries are keyed by document, and a settle removes the
 * entry belonging to THAT document.
 *
 * DEGRADES TO THE FIFO RATHER THAN TO SILENCE. The keys come from three
 * different points in the engine's pipeline (the raw change row, the interest
 * predicate, the apply callback), all of which carry the same CouchDB `_id`
 * today. If that ever stopped being true, an exact-match removal would never
 * find its entry, the clock would never drain, and a healthy peer would report a
 * permanent stall: a false alarm is the one failure mode a health instrument
 * cannot afford. So an unmatched settle falls back to dropping the oldest entry
 * of any key, which is the FIFO behaviour, i.e. exactly as good as the naive
 * implementation and no worse. That also keeps the invariant this class is
 * relied on for: one settle removes exactly one entry whenever there is one to
 * remove, so the clock's population always matches the caller's counters.
 *
 * COST. One number per outstanding document, and outstanding documents are
 * precisely what the ledger exists to bound: a large population here IS the
 * stall being reported, and it is cleared by `reset()` when the peer restarts.
 * `oldest()` walks the distinct keys, which is the same population, and it is
 * called from the health snapshot rather than from the per-document path.
 */
class PendingClock {
    /** Document key to the times at which each of its outstanding copies started. */
    private readonly waiting = new Map<string, number[]>();

    /** A document started owing an outcome. */
    add(key: string | undefined, at: number): void {
        const k = key ?? UNNAMED;
        const stamps = this.waiting.get(k);
        if (stamps) stamps.push(at);
        else this.waiting.set(k, [at]);
    }

    /** A document produced one. Exact when the key matches, oldest-first if not. */
    settle(key: string | undefined): void {
        const k = key ?? UNNAMED;
        const stamps = this.waiting.get(k);
        if (stamps !== undefined && stamps.length > 0) {
            // Same key outstanding more than once (the same path updated twice
            // before either write landed) is settled oldest-first, which is the
            // only ordering the caller could mean.
            stamps.shift();
            if (stamps.length === 0) this.waiting.delete(k);
            return;
        }
        this.dropOldest();
    }

    /** When the oldest outstanding document started waiting, or undefined if none is. */
    oldest(): number | undefined {
        let oldest: number | undefined;
        for (const stamps of this.waiting.values()) {
            const head = stamps[0];
            if (head === undefined) continue;
            if (oldest === undefined || head < oldest) oldest = head;
        }
        return oldest;
    }

    clear(): void {
        this.waiting.clear();
    }

    private dropOldest(): void {
        let oldestKey: string | undefined;
        let oldest = Number.POSITIVE_INFINITY;
        for (const [k, stamps] of this.waiting) {
            const head = stamps[0];
            if (head === undefined) continue;
            if (head < oldest) {
                oldest = head;
                oldestKey = k;
            }
        }
        if (oldestKey === undefined) return;
        const stamps = this.waiting.get(oldestKey);
        if (!stamps) return;
        stamps.shift();
        if (stamps.length === 0) this.waiting.delete(oldestKey);
    }
}

/**
 * One ledger per CouchDB peer, owned by it, reset when it stops.
 *
 * Every mutator is synchronous and cannot throw: two of them run inside a
 * PouchDB EventEmitter callback and inside the engine's interest predicate,
 * where a throw would take the changes feed with it.
 */
export class InboundProgress {
    private readonly decodeGraceMs: number;
    private readonly applyGraceMs: number;
    private readonly deliverGraceMs: number;
    private readonly probeGraceMs: number;
    private readonly writeGraceMs: number;
    private readonly heldGraceMs: number;

    private received = 0;
    private delivered = 0;
    private decoded = 0;
    private skipped = 0;
    private applied = 0;
    private failed = 0;

    /**
     * The last sequence the raw feed emitted, whatever became of it afterwards.
     *
     * Deliberately NOT the persisted checkpoint, and deliberately not restricted
     * to the documents this peer applies. Two separate reasons, both of which
     * produced a permanently false "the remote is holding changes back":
     *
     *  - The checkpoint only advances for documents this peer is interested in,
     *    so on a remote that also carries `i:` internal documents (which
     *    `isInterested` refuses, correctly) it lags the remote's true sequence
     *    forever.
     *  - The feed's selector admits more than note entries. See the header: a
     *    single `versioninfo` document past the cursor was enough to make the
     *    probe answer "pending" for the life of the process.
     *
     * So this tracks one thing only: how far the feed has got. A document we
     * ignored, could not decrypt or could not write was still DELIVERED, and the
     * separate counters above are what report those.
     */
    private cursor: string | undefined;

    /** Delivered, not yet decoded. Its head is the decode clock. */
    private readonly awaitingDecode = new PendingClock();
    /** Decoded, not yet settled. Its head is the apply clock. */
    private readonly awaitingApply = new PendingClock();

    /**
     * When the current run of failed writes began, or undefined if none is
     * running. See `noteFailed` for why it is a standing clock rather than a
     * per-document one.
     */
    private failedSince: number | undefined;

    /**
     * When the replication checkpoint was first held behind a failed change, and
     * how many changes have failed since.
     *
     * ONE TIMESTAMP AND ONE COUNTER IS THE WHOLE OF THE STATE, and that is a
     * deliberate answer to the obvious alternative. "Everything up to N except 4,
     * 5 and 6" cannot be expressed by a high-water mark, and the tempting repair
     * is to keep the exception list and retry its members. That list has no
     * natural bound (a vault volume that stays full collects one entry per remote
     * change, indefinitely), it is in memory while the checkpoint is on disk, so a
     * restart loses precisely the record that says which documents still need
     * replaying, and CouchDB sequences are opaque strings that cannot be ordered
     * or reasoned about by arithmetic anyway.
     *
     * Holding the checkpoint instead needs neither ordering nor a list: the peer
     * simply stops advancing it, and every replay from that point re-delivers
     * every change after it, the failed ones included. The counter below exists
     * only so the report can say how much is waiting; nothing derives correctness
     * from it, so it has nothing to overflow.
     */
    private checkpointHeldSince: number | undefined;
    private checkpointHeldCount = 0;

    private undeliveredSince: number | undefined;
    /** First unanswered probe since the last answered one. See `noteProbeUnanswerable`. */
    private probeUnansweredSince: number | undefined;

    /** Set by `setObservable(false)` when the feed cannot be instrumented. */
    private observable = true;

    /**
     * Decryption has demonstrably worked, at some point, for this configuration
     * against this remote. See `adoptPriorDecodeEvidence()` and `verdict()`.
     *
     * NOT CLEARED BY `reset()`, and that is the entire point of the field: the
     * fatal verdict below is the one judgement in this module that must be made
     * on evidence which outlives a run, because the thing it stops the peer over
     * (a wrong end-to-end passphrase) is a fact about the configuration rather
     * than about this connection.
     */
    private everDecoded = false;

    constructor(opts: InboundProgressOptions = {}) {
        this.decodeGraceMs = opts.decodeGraceMs ?? DECODE_GRACE_MS;
        this.applyGraceMs = opts.applyGraceMs ?? APPLY_GRACE_MS;
        this.deliverGraceMs = opts.deliverGraceMs ?? DELIVER_GRACE_MS;
        this.probeGraceMs = opts.probeGraceMs ?? PROBE_GRACE_MS;
        this.writeGraceMs = opts.writeGraceMs ?? WRITE_GRACE_MS;
        this.heldGraceMs = opts.heldGraceMs ?? HELD_GRACE_MS;
    }

    // --- recording -------------------------------------------------------------

    /**
     * The raw feed emitted a change, before any decryption.
     *
     * ONE ENTRY POINT FOR ALL CHANGES, AND THAT IS THE POINT. The cursor moves
     * here and nowhere else, so it cannot fall behind the feed for any document
     * type, which is the property the out-of-band probe depends on (the header
     * explains what happened when it did not hold). `owesDecode` is the second
     * question, asked at the same moment and kept separate: only `newnote` and
     * `plain` documents reach the engine's interest predicate, so only those can
     * ever produce the decode receipt that `noteDecoded()` records. Counting a
     * `versioninfo` as "delivered" would open a gap no decode could ever close
     * and report a healthy peer as unable to decrypt.
     *
     * A delivery is also the strongest possible proof that the feed is alive,
     * stronger than any probe answer, so it clears BOTH clocks that stand for
     * "we may not be receiving anything": the remote-pending one and the one
     * that says the probe which answers that question has stopped answering.
     * Clearing only the first was a bug with a measured symptom: ten documents
     * received, decoded and applied inside the window still resolved to
     * `unobservable`, `stalled: true`, `ok: false`, on a demonstrably healthy
     * peer, for as long as some proxy kept refusing the probe's POST. The probe
     * exists to detect a feed delivering nothing; a feed that is delivering has
     * answered the question the probe was asked.
     *
     * `key` is the CouchDB document id from the raw change row, used to settle
     * the decode clock against the right document. See `PendingClock`.
     */
    noteFeedChange(seq: string | number | undefined, owesDecode: boolean, key?: string): void {
        this.received += 1;
        if (seq !== undefined && seq !== null) this.cursor = String(seq);
        this.undeliveredSince = undefined;
        this.probeUnansweredSince = undefined;
        if (!owesDecode) return;
        this.delivered += 1;
        this.awaitingDecode.add(key, Date.now());
    }

    /**
     * A change survived decryption and reached the interest predicate.
     *
     * Progress FOR THAT DOCUMENT, which is all it is evidence of: it settles that
     * document's decode clock and opens its apply clock, because from here the
     * document is this peer's responsibility. It does not restamp anything owed
     * by any other document, which is the distinction `PendingClock` exists to
     * make.
     *
     * It is also the only thing in this module that may set `everDecoded`, and
     * that is deliberate: the flag suppresses the fatal verdict, so it has to
     * mean "a document actually decrypted" and nothing weaker.
     */
    noteDecoded(key?: string): void {
        this.decoded += 1;
        this.everDecoded = true;
        this.awaitingDecode.settle(key);
        this.awaitingApply.add(key, Date.now());
    }

    /** A decoded change this peer deliberately ignored. Counts as settled. */
    noteSkipped(key?: string): void {
        this.skipped += 1;
        this.awaitingApply.settle(key);
    }

    /**
     * A decoded change written to the vault, checkpoint advanced.
     *
     * The one event that clears the failed-write clock, and the only one that
     * may: a write landing is the only proof that the vault is writable. A skip
     * is not (nothing was written), and a decode is not (nothing was attempted).
     */
    noteApplied(key?: string): void {
        this.applied += 1;
        this.awaitingApply.settle(key);
        this.failedSince = undefined;
    }

    /**
     * A decoded change whose write threw.
     *
     * SETTLED BUT NOT FORGOTTEN, and the second half of that took a bug to
     * arrive at. Settling is right: leaving the document outstanding would make
     * one permanently unwritable remote document pin the peer at unhealthy
     * forever, which in turn makes it permanently restart-worthy and puts the
     * process in a slow restart loop over a fault a restart cannot fix.
     *
     * But settling and then reporting nothing else is how the whole condition
     * disappeared. `unappliedCount()` is decoded minus skipped minus applied
     * minus failed, so a failure cancels itself out of the outstanding set, and
     * no branch of `verdict()` read the `failed` counter. Measured: fifty
     * consecutive remote writes all throwing resolved to `state: 'idle'`,
     * `stalled: false`, so `snapshot().ok` was true and `/healthz/livesync`
     * served 200 while not one remote change was reaching the vault. That is the
     * exact silent failure this module was written to remove, arrived at from a
     * different direction, and it is not hypothetical: a full vault volume
     * (ENOSPC), a Docker volume remounted read-only, or a uid change making
     * every write EACCES produces it.
     *
     * `syncImpl`'s per-pass check was supposed to cover this and cannot: it is a
     * delta over a pass window, so it only fires if a failure happens to land
     * inside one, and when it does not the pass reports ok, clears `lastError`
     * and stamps `lastSyncAt`. So the standing condition gets a standing clock.
     * It is opened by the FIRST failure and left alone by later ones (restamping
     * it per failure would be the same per-peer restamping bug `PendingClock`
     * exists to fix, in a new field), and it is closed by `noteApplied()` alone.
     *
     * THE COST OF "BY `noteApplied()` ALONE", stated rather than hidden. A peer
     * whose remaining inbound traffic is all refused (a remote pushing nothing
     * but `i:` internal documents, say) keeps reporting this after a single
     * transient failure, because no later event ever demonstrates that the vault
     * is writable again. That is a narrow standing false alarm and it is the
     * deliberate side of the trade: clearing the clock on a SKIP would let the
     * `i:` stream mask a genuinely unwritable vault, which is the same masking
     * bug `PendingClock` exists to remove and a far worse one to reintroduce
     * here. The report stays truthful either way ("N failed to write and none has
     * been written since"), and one successful inbound write clears it.
     */
    noteFailed(key?: string): void {
        this.failed += 1;
        this.awaitingApply.settle(key);
        if (this.failedSince === undefined) this.failedSince = Date.now();
    }

    /**
     * The peer has stopped advancing the replication checkpoint because a change
     * failed to apply.
     *
     * SEPARATE FROM `noteFailed()` ON PURPOSE, though the peer calls both from the
     * same catch. They are different facts with different lifetimes: a failed
     * write is an event, and the checkpoint being held is a STANDING condition
     * that outlives it. `noteApplied()` clears the failed-write clock the moment
     * anything lands, which is right for "is the vault writable", and would be
     * exactly wrong here: the checkpoint stays held whatever else succeeds,
     * because the change that failed has still not been applied and later
     * successes say nothing about it. That difference is the reported defect. The
     * checkpoint was a single high-water mark, so the next successful apply wrote
     * its own higher sequence over the failure and the failed sequences were
     * skipped forever; the ledger meanwhile watched the failed-write clock get
     * cleared by those very successes and went back to reporting `idle`.
     *
     * Opened by the FIRST hold and left alone by later ones, for the same reason
     * `noteFailed()` gives: restamping per event would measure the time since the
     * last failure rather than how long the condition has stood, which is the
     * per-peer restamping bug `PendingClock` exists to remove.
     */
    noteCheckpointHeld(): void {
        this.checkpointHeldCount += 1;
        if (this.checkpointHeldSince === undefined) this.checkpointHeldSince = Date.now();
    }

    /**
     * The checkpoint is free to advance again.
     *
     * The peer calls this when it arms the changes feed from the persisted
     * checkpoint, because that is the one event that makes the hold unnecessary:
     * the feed replays every sequence after the checkpoint, so the changes that
     * failed are delivered again and get another attempt. Nothing else clears it,
     * and in particular a later successful apply does not, since applying a
     * DIFFERENT document is no evidence about the one still waiting.
     */
    noteCheckpointReleased(): void {
        this.checkpointHeldSince = undefined;
        this.checkpointHeldCount = 0;
    }

    /**
     * Adopt persisted evidence that decryption has worked for this configuration
     * against this remote before now.
     *
     * WHY THE EVIDENCE HAS TO OUTLIVE THE RUN. `verdict()` calls a total decode
     * failure fatal, and its whole justification is that "not one document has
     * decrypted" is the signature of a wrong passphrase. `decoded` is per-run,
     * and the CHECKPOINT is not, and that mismatch turned the non-fatal
     * `degraded` verdict into a fatal one exactly one restart later:
     *
     *   500 documents decrypt and land, the checkpoint reaches 499, the document
     *   at sequence 500 never decrypts. `degraded`, correctly. The peer is not
     *   ok, CouchDB is reachable, so it is judged restart-worthy after the grace
     *   window and the pair is rebuilt. The fresh feed resumes from 499 and
     *   delivers exactly one document: the bad one. Now `delivered` is 1 and
     *   `decoded` is 0, so the run's evidence says "nothing has ever decrypted",
     *   the peer is stopped as fatally misconfigured, and the operator is told to
     *   check a passphrase that decrypted 500 documents ninety seconds earlier.
     *   `requireReady` then refuses every push, and a fatal peer reports its
     *   backend down, so nothing ever restarts it again.
     *
     * The caller owns what counts as evidence and where it is kept
     * (`LiveSyncStateStore`, keyed so that changing the passphrase or the remote
     * discards it: a new passphrase that decrypts nothing must still be fatal,
     * which is the entire point of the check). This method only accepts it, and
     * it is deliberately one-way and argument-free so that nothing can use it to
     * clear the flag or to set it on anything other than a real decode.
     */
    adoptPriorDecodeEvidence(): void {
        this.everDecoded = true;
    }

    /**
     * The out-of-band answer to "does the remote hold changes past our cursor?".
     *
     * Only ever called with a REAL answer. "The probe could not answer" is a
     * different fact with different consequences and has its own method; routing
     * it through here as a `false`-shaped value is precisely the bug that made an
     * unanswerable probe read as health.
     */
    setRemotePending(pending: boolean): void {
        this.probeUnansweredSince = undefined;
        if (pending) {
            if (this.undeliveredSince === undefined) this.undeliveredSince = Date.now();
            return;
        }
        this.undeliveredSince = undefined;
    }

    /**
     * The pending-changes probe did not produce an answer.
     *
     * FAILS TOWARDS UNHEALTHY, and that direction is the whole point. The probe
     * is the ONLY detector for a feed that has gone silent while still reporting
     * itself attached: the in-process counters cannot see it, because the entire
     * failure is that nothing arrives to count. So "I could not tell" must never
     * be reported as "fine", or the one instrument that covers the original bug
     * can be disabled by the same proxy or network fault that caused it.
     *
     * An earlier revision cleared the undelivered clock here, which made an
     * unanswerable probe resolve to `idle` and `ok: true`: the exact pre-fix
     * silent behaviour, restored through the back door. Note the asymmetry that
     * made it obviously wrong once written down: an uninstrumentable FEED already
     * failed loudly to `unobservable`, while an unanswerable PROBE failed green.
     *
     * It is still TIMED rather than immediate, because one failed request is not
     * evidence of anything. See `PROBE_GRACE_MS`.
     */
    noteProbeUnanswerable(): void {
        if (this.probeUnansweredSince === undefined) this.probeUnansweredSince = Date.now();
    }

    /**
     * Declare whether the raw feed could be instrumented at all.
     *
     * False makes every verdict `unobservable`, which reads as unhealthy. That is
     * the deliberate direction to fail in: this module's entire purpose is to stop
     * the subsystem reporting green while doing nothing, so losing the ability to
     * measure must not quietly restore the behaviour it was written to remove.
     */
    setObservable(observable: boolean): void {
        this.observable = observable;
    }

    /** The feed's own position, for the remote-pending probe. */
    getCursor(): string | undefined {
        return this.cursor;
    }

    /**
     * Forget everything about this run. Called when a peer stops, so a fresh run
     * starts clean.
     *
     * `everDecoded` is the one thing that survives, for the reason
     * `adoptPriorDecodeEvidence()` gives at length: it is the fact that stops a
     * restart from re-reading a partial decryption failure as a total one and
     * killing the peer over a passphrase that works.
     */
    reset(): void {
        this.received = 0;
        this.delivered = 0;
        this.decoded = 0;
        this.skipped = 0;
        this.applied = 0;
        this.failed = 0;
        this.cursor = undefined;
        this.awaitingDecode.clear();
        this.awaitingApply.clear();
        this.failedSince = undefined;
        // Cleared with the rest: a fresh run arms its feed from the persisted
        // checkpoint, which is exactly the replay the hold was waiting for, so
        // carrying the hold across would report a condition the new run has
        // already acted on.
        this.checkpointHeldSince = undefined;
        this.checkpointHeldCount = 0;
        this.undeliveredSince = undefined;
        this.probeUnansweredSince = undefined;
        this.observable = true;
    }

    // --- reading ---------------------------------------------------------------

    counts(): InboundCounts {
        return {
            received: this.received,
            delivered: this.delivered,
            decoded: this.decoded,
            skipped: this.skipped,
            applied: this.applied,
            failed: this.failed,
        };
    }

    private undecodableCount(): number {
        return Math.max(0, this.delivered - this.decoded);
    }

    private unappliedCount(): number {
        return Math.max(0, this.decoded - this.skipped - this.applied - this.failed);
    }

    /**
     * The classification, ordered most permanent first.
     *
     * The order matters for the same reason `classifyDetail()` in
     * routes/livesync.ts orders its cases: a decryption failure also produces
     * documents that never land and a remote that stays pending, and reporting
     * either symptom would send an operator to look at CouchDB instead of at
     * their passphrase.
     */
    verdict(): InboundVerdict {
        const counts = this.counts();
        const undecodable = this.undecodableCount();
        const unapplied = this.unappliedCount();
        const now = Date.now();
        const base = { ...counts, undecodable, unapplied, checkpointHeld: this.checkpointHeldSince !== undefined };

        if (!this.observable) {
            return {
                ...base,
                state: 'unobservable',
                detail: 'inbound progress cannot be observed',
                stalled: true,
                fatal: false,
                // A feed that cannot be instrumented is a fact about the shape of
                // the dependency, and a fresh emitter has the same shape. See
                // `restartFutile`.
                restartFutile: true,
                stalledMs: 0,
            };
        }

        const decodeSince = this.awaitingDecode.oldest();
        if (undecodable > 0 && decodeSince !== undefined && now - decodeSince > this.decodeGraceMs) {
            const stalledMs = now - decodeSince;
            /*
             * TWO VERY DIFFERENT FAULTS WEAR THE SAME SYMPTOM, and the ledger is
             * the only thing that can tell them apart. Both look like "documents
             * arrived and did not decode"; what separates them is whether
             * ANYTHING has ever decoded.
             *
             *  - nothing has EVER decoded: not one document has decrypted with
             *    this passphrase against this database, on this run or any
             *    earlier one. That is what a wrong end-to-end passphrase
             *    produces, and nothing on the connect path can catch it first:
             *    the reachability probe is a plain GET, and the milestone is a
             *    `_local/` document, which `transform-pouch` refuses to transform
             *    at all. So a wrong passphrase connects cleanly and then decrypts
             *    nothing. Retrying cannot help, and continuing is actively
             *    harmful (the push direction would keep writing chunks under a
             *    key no other client shares), so it is FATAL.
             *  - something HAS decoded: the passphrase is demonstrably correct,
             *    because documents have decrypted with it. Some specific document
             *    did not, which is real loss and must be reported, but it is not a
             *    broken configuration. Treating it as fatal stopped the peer, took
             *    the PUSH direction down with it (`requireReady` throws once
             *    `fatalReason` is set), blocked `restartWorthy` forever (a fatal
             *    peer reports its backend down by design) and told the operator to
             *    change a passphrase that was correct. One bad document out of
             *    five hundred good ones needed a human to clear it.
             *
             * `everDecoded` RATHER THAN `counts.decoded === 0` IS THE WHOLE POINT
             * OF THIS BRANCH, and using the counter was a bug with a two-minute
             * fuse rather than a wording problem: the counter is per-run, the
             * checkpoint is not, and a restart therefore replays only the
             * documents past the checkpoint. In the case above that is exactly one
             * document, the bad one, so the restarted peer measures
             * `decoded === 0` and escalates the same partial failure to fatal
             * with the passphrase message attached. `adoptPriorDecodeEvidence()`
             * documents the sequence in full.
             *
             * So `degraded` is stalled but not fatal: it keeps the condition out
             * of `ok` (a lost document is not "fine") and leaves the push
             * direction running. It is `restartFutile`, because the restart it
             * used to earn replays the same undecryptable document from the same
             * checkpoint and reproduces the same verdict, at the price of a full
             * offline vault scan every cooldown, forever.
             *
             * Both messages are worded from the evidence. The fatal one may name
             * the likely cause because "nothing has ever decrypted" IS that
             * cause's signature; the degraded one may not, because the same
             * wording sent operators to change a correct passphrase.
             */
            if (!this.everDecoded) {
                return {
                    ...base,
                    state: 'undecodable',
                    detail: `${undecodable} remote change(s) could not be decrypted, and none has ever decrypted`,
                    stalled: true,
                    fatal: true,
                    restartFutile: true,
                    stalledMs,
                };
            }
            return {
                ...base,
                state: 'degraded',
                detail:
                    counts.decoded > 0
                        ? `${undecodable} of ${counts.delivered} delivered change(s) could not be decrypted, ` +
                          `while ${counts.decoded} decrypted normally`
                        : `${undecodable} of ${counts.delivered} delivered change(s) could not be decrypted; ` +
                          'nothing has decrypted since this peer started, though decryption has worked before now',
                stalled: true,
                fatal: false,
                restartFutile: true,
                stalledMs,
            };
        }

        /*
         * Ordered ahead of `unapplied` because it is the more specific of the
         * two and names something an operator can go and look at. A vault that
         * refuses every write also leaves documents in flight while they are
         * being attempted, so reporting "accepted but never written" would send
         * someone to look at the sync engine over a full disk.
         */
        if (this.failedSince !== undefined && now - this.failedSince > this.writeGraceMs) {
            return {
                ...base,
                state: 'unwritable',
                detail: `${counts.failed} remote change(s) failed to write and none has been written since`,
                stalled: true,
                // Not a broken configuration: the vault may become writable again
                // at any moment, and the peer must be running to notice.
                fatal: false,
                // A full or read-only volume is not repaired by rebuilding a
                // CouchDB connection.
                restartFutile: true,
                stalledMs: now - this.failedSince,
            };
        }

        /*
         * Ordered directly BELOW `unwritable`, because the two are the total and
         * the partial reading of the same evidence and the total one is both more
         * specific and differently actionable. A vault that refuses every write
         * holds the checkpoint too, and reporting the hold there would send an
         * operator to look at replication over a full disk, and would also claim a
         * restart was worth doing when `unwritable` has just established that it
         * is not.
         *
         * Everything below this point is about work that is still moving, so this
         * is also the last of the "something is wrong with what already arrived"
         * cases.
         */
        if (this.checkpointHeldSince !== undefined && now - this.checkpointHeldSince > this.heldGraceMs) {
            return {
                ...base,
                state: 'behind',
                detail:
                    `${this.checkpointHeldCount} remote change(s) failed to apply; the replication ` +
                    'checkpoint is held at the earliest of them so they are replayed rather than skipped',
                stalled: true,
                // Not a broken configuration. The changes are still on the remote
                // and the peer has to be running to replay them.
                fatal: false,
                /*
                 * DELIBERATELY RESTART-WORTHY, and the only state below
                 * `unwritable` for which that is the actual repair rather than a
                 * side effect. The supervisor's lever is to tear the peer pair
                 * down and build a fresh one; the fresh one arms its feed from the
                 * persisted checkpoint, which is being held at the failed change,
                 * so the restart IS the replay this state is waiting for. That is
                 * also what the operators who hit the original defect did by hand:
                 * `POST /disconnect` then `POST /connect` was the only thing that
                 * recovered the missing notes, and the point of reporting this is
                 * that they should not have to.
                 */
                restartFutile: false,
                stalledMs: now - this.checkpointHeldSince,
            };
        }

        const applySince = this.awaitingApply.oldest();
        if (unapplied > 0 && applySince !== undefined && now - applySince > this.applyGraceMs) {
            return {
                ...base,
                state: 'unapplied',
                detail: `${unapplied} remote change(s) accepted but never written`,
                stalled: true,
                fatal: false,
                // Deliberately restart-worthy: this is mechanism 3 from the
                // header, a chunk wait with no route to resolution, and a fresh
                // manipulator is the one thing that clears it.
                restartFutile: false,
                stalledMs: now - applySince,
            };
        }

        if (this.undeliveredSince !== undefined && now - this.undeliveredSince > this.deliverGraceMs) {
            return {
                ...base,
                state: 'undelivered',
                detail: 'the remote has changes the feed is not delivering',
                stalled: true,
                fatal: false,
                // Also deliberately restart-worthy: a long-poll being black-holed
                // is precisely what re-arming the feed fixes.
                restartFutile: false,
                stalledMs: now - this.undeliveredSince,
            };
        }

        /*
         * Ordered BELOW `undelivered` because the two can hold at once and
         * `undelivered` is the more specific of the pair. A probe that answered
         * "pending" and then stopped answering leaves both clocks running; the
         * first answer is real evidence about the remote, while this one only
         * says the instrument is gone, so the operator should be told the finding
         * rather than the outage in the instrument that found it.
         */
        if (this.probeUnansweredSince !== undefined && now - this.probeUnansweredSince > this.probeGraceMs) {
            return {
                ...base,
                state: 'unobservable',
                detail: 'the remote cannot be asked whether the feed is missing changes',
                stalled: true,
                fatal: false,
                // The probe is a plain HTTP request of our own, independent of the
                // feed and of the manipulator. Whatever is refusing it refuses it
                // just as hard after a reconnect.
                restartFutile: true,
                stalledMs: now - this.probeUnansweredSince,
            };
        }

        // Not stalled. `flowing` versus `idle` is only a reporting distinction,
        // but it is the distinction KICKOFF asks for by name, so it is made
        // explicitly rather than left to a caller to infer from a count.
        const busy = undecodable > 0 || unapplied > 0 || this.undeliveredSince !== undefined;
        /*
         * A held checkpoint inside its grace window does NOT change the state, and
         * does change the detail.
         *
         * Not the state, because that would break the rule every other clock here
         * follows: a condition inside its window is not yet a condition, and the
         * window exists because most holds are cleared within seconds by the
         * engine's own feed reconnect. Promoting it immediately would make routine
         * self-healing indistinguishable from the failure it heals.
         *
         * The detail, because `idle at 4 applied` is the exact sentence the
         * original defect produced while three notes were missing from the vault,
         * and there is no reason for this module to say it when it holds a fact
         * that contradicts it. `checkpointHeld` on the verdict carries the same
         * information as a field, for callers that would rather test than parse.
         */
        const held =
            this.checkpointHeldSince === undefined
                ? ''
                : `; ${this.checkpointHeldCount} failed change(s) awaiting replay`;
        return {
            ...base,
            state: busy ? 'flowing' : 'idle',
            detail:
                (busy
                    ? `${undecodable + unapplied} remote change(s) in flight`
                    : `idle at ${counts.applied} applied, ${counts.skipped} ignored`) + held,
            stalled: false,
            fatal: false,
            restartFutile: false,
            stalledMs: 0,
        };
    }
}
