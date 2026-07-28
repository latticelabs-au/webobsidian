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

/**
 * How many DISTINCT remote documents must fail to decrypt, with no foreign
 * decode behind them, before the peer is stopped as fatally misconfigured.
 *
 * WHY THERE IS A QUANTITY HERE AT ALL. The fatal predicate used to be
 * "undecodable > 0 and nothing has ever decoded", and that bar was sound only
 * for as long as the receipt on the other side of the `and` was cheap to earn.
 * It was: any decode granted it, and a peer can always decrypt what it
 * encrypted itself, so every peer that had ever pushed anything held one. When
 * the receipt was correctly narrowed to documents this peer did NOT write (see
 * `noteForeignDecode`), a whole class of legitimate peer stopped holding it, and
 * the bar of one turned into "one bad document from a stranger is a broken
 * configuration". Measured: a peer with a CORRECT passphrase, whose only inbound
 * traffic so far had been its own echoes, received one stranger's document that
 * failed to decrypt and went `undecodable`, `fatal`, permanently 503, with the
 * push direction stopped and its next local write never reaching CouchDB. Four
 * documents had decrypted on it. Narrowing the receipt without raising this bar
 * traded one silent failure for one loud and wrong one.
 *
 * WHY THE FIX IS A QUANTITY AND NOT A DIFFERENT KIND OF EVIDENCE. A key is a
 * property of a CLIENT, not of a document, and clients write in bulk. So the
 * observed distribution of "documents I cannot read" is mechanically bimodal:
 * zero, one or two (an accident, a half-failed write, a document restored from
 * an older key), or the entire cluster. Almost nothing sits in between. A wrong
 * passphrase does not fail on one document; it fails on everything anybody else
 * ever wrote. That is the shape the bar is drawn against, and it is why the
 * choice is insensitive anywhere in roughly [2, 12] and only has to be defended
 * against 1 and against "large".
 *
 * WHY 3 AND NOT 2. One is excluded by the measurement above. Two is excluded by
 * mechanism rather than by margin: a single client's half-completed bulk write,
 * or a pair of documents restored from a backup taken under an older passphrase,
 * produces two genuinely bad documents without anything being wrong with this
 * peer's configuration. Three requires three independent document-level
 * coincidences on a peer that has never once read a stranger's document, against
 * one configuration-level explanation, which is where the parsimonious reading
 * flips. Above roughly five the bar starts failing to protect small real vaults,
 * which is the harm the fatal verdict exists to prevent.
 *
 * NOT OPERATOR-CONFIGURABLE, for the same reason the grace windows are not: it
 * is overridable from `InboundProgressOptions` so a test does not have to build
 * a twelve-document fixture to drive a boundary, and from nowhere else.
 *
 * WHAT IT IS NOT. It is not a bound on how much damage a wrong passphrase can
 * do, and it does not pretend to be: `verdict()` states the case it deliberately
 * lets through (a wrong passphrase against a cluster holding fewer than three
 * foreign documents) and why that is the cheaper end of an unavoidable trade.
 */
export const UNDECODABLE_QUORUM = 3;

/** What the inbound direction is doing, as a fixed vocabulary. */
export type InboundState =
    /** Nothing outstanding and nothing pending on the remote. Genuinely idle. */
    | 'idle'
    /** Work outstanding, and progressing inside its window. */
    | 'flowing'
    /**
     * Documents arrived at the feed, NO DOCUMENT WRITTEN BY ANOTHER CLIENT has
     * ever decoded, and enough distinct documents have failed that a run of bad
     * documents is no longer the parsimonious reading. Decryption is broken
     * outright, which no amount of retrying changes.
     *
     * "Nothing has ever decoded" would be the shorter sentence and it is false:
     * `counts.decoded` can be arbitrarily large in this state, because a peer can
     * always decrypt its OWN pushes echoing back off the feed, whatever passphrase
     * it used. Only `counts.foreignDecoded` is evidence about the configuration.
     */
    | 'undecodable'
    /**
     * Documents failed to decode, no document written by another client has
     * decoded yet, and TOO FEW have failed to tell the two apart.
     *
     * Not a softened `degraded`, but its own condition: `degraded` means
     * decryption is demonstrably working and one document is bad, and this peer
     * has no standing to make that claim. Loud (`stalled`) and deliberately not
     * `fatal`: see `verdict()` for why the tie is broken towards innocence and
     * what that costs.
     */
    | 'unproven'
    /**
     * Some documents failed to decode while documents written by ANOTHER CLIENT
     * succeeded. Real loss, but not a broken configuration: see `verdict()` for
     * why the difference decides whether this peer stops or keeps running.
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
    /**
     * Changes that reached the engine's interest predicate, i.e. decrypted.
     *
     * PROVES NOTHING ABOUT THE CONFIGURATION, and reading it as though it did is
     * the mistake this pair of fields exists to make impossible. A peer can always
     * decrypt what it encrypted itself, and its own pushes echo back down the feed
     * within milliseconds of every write, so this number counts a wrong
     * passphrase's own output as readily as a right one's.
     */
    decoded: number;
    /**
     * Of those, the ones written by ANOTHER CLIENT. The number that is evidence
     * about the configuration rather than about a document.
     *
     * DIFFERENT LIFETIME FROM EVERY OTHER COUNT HERE, deliberately: the rest are
     * per run and are zeroed by `reset()`, and this one is not, for the same
     * reason `everDecoded` is not (`adoptPriorDecodeEvidence()` argues it at
     * length). It counts what THIS ledger instance has observed; evidence adopted
     * from an earlier process arrives as a flag rather than a number, because
     * nothing persisted the number, so `foreignDecoded === 0` alongside a
     * `degraded` verdict means "the proof came from disk" and not "there is no
     * proof".
     *
     * Published rather than kept private because the fatal verdict's message is
     * about it, and an operator holding `{ decoded: 4, foreignDecoded: 0 }` can
     * see at once why four successful decryptions did not clear the alarm. The
     * shape `{ decoded: 4, undecodable: 1, detail: '...none has ever decrypted' }`
     * was printable before this field existed, and reads as a bug in the ledger
     * rather than as the true statement it is.
     */
    foreignDecoded: number;
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
     * Only `undecodable`, i.e. only when NO DOCUMENT WRITTEN BY ANOTHER CLIENT
     * has ever decoded AND at least `UNDECODABLE_QUORUM` distinct documents have
     * failed to. See `verdict()`: this flag stops the peer outright, so the
     * evidence behind it has to be evidence of a broken CONFIGURATION rather than
     * of a bad document, and each half of the conjunction rules out one of the two
     * ways that reading has been wrong in production.
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
    /**
     * Documents lost between the feed and decryption, as DELIVERY EVENTS.
     *
     * Carries magnitude, not identity, and cannot be used as the fatal
     * predicate's quantity: an undecodable document never reaches the apply
     * callback, so it never advances the checkpoint, so every feed re-arm (the
     * engine's own ten-second retry, or the watchdog's every five seconds)
     * redelivers it and this number climbs 1, 2, 3 on one bad document and one
     * CouchDB hiccup. `undecodableDistinct` is what the verdict turns on.
     */
    undecodable: number;
    /**
     * Distinct documents that failed to decrypt, counted by CouchDB `_id`, across
     * this run AND every earlier run under the same configuration fingerprint.
     *
     * The quantity the fatal verdict is actually made on, published so that an
     * operator handed a "this peer has stopped" verdict can see the number behind
     * it rather than infer it. SATURATES AT `UNDECODABLE_QUORUM`: it is a decision
     * variable and not a census, and capping it is what keeps the set that backs
     * it to three strings on a peer that cannot read a hundred thousand documents.
     * So it reads as "at least this many", and every message worded from it says
     * so.
     */
    undecodableDistinct: number;
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
    /**
     * Override `UNDECODABLE_QUORUM`. Tests only, and for the same reason the
     * grace windows are overridable: driving a boundary should not require a
     * twelve-document fixture.
     */
    undecodableQuorum?: number;
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

    /**
     * Every document whose OLDEST outstanding copy started waiting before `before`.
     *
     * The identity half of what `oldest()` answers as a timestamp, and the only
     * reader that cares which documents rather than how long. `InboundProgress`
     * uses it to turn "these are still owed a decode, and have been for longer
     * than the grace window" into a set of document ids that survives this clock:
     * an entry here is removed by a settle (including the `dropOldest()` fallback)
     * and the whole map is cleared by `reset()`, so a judgement that has to be
     * made across runs cannot be re-derived from it later.
     *
     * KEYED, SO REDELIVERY OF ONE DOCUMENT IS ONE ANSWER. The same id arriving
     * again appends a second stamp under the same key rather than making a new
     * one, which is exactly the property the fatal verdict needs: an undecodable
     * document is redelivered by every feed re-arm, forever, because it never
     * advances the checkpoint.
     *
     * The `UNNAMED` bucket contributes at most one entry however many unnamed
     * documents it holds, which under-counts. That is the same direction this
     * class degrades in everywhere else, and the right one: under-counting delays
     * a fatal verdict, and over-counting manufactures one.
     */
    expiredKeys(before: number): string[] {
        const out: string[] = [];
        for (const [k, stamps] of this.waiting) {
            const head = stamps[0];
            if (head === undefined) continue;
            if (head < before) out.push(k);
        }
        return out;
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
    private readonly undecodableQuorum: number;

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
     * against this remote, ON A DOCUMENT THIS PEER DID NOT WRITE. See
     * `noteForeignDecode()`, `adoptPriorDecodeEvidence()` and `verdict()`.
     *
     * That last qualifier is the whole load-bearing part of the sentence and was
     * missing from the code for a while: without it the flag was satisfiable by a
     * peer's own echo, which a wrong passphrase produces just as readily as a
     * right one. `noteDecoded()` records what that cost.
     *
     * NOT CLEARED BY `reset()`, and that is the entire point of the field: the
     * fatal verdict below is the one judgement in this module that must be made
     * on evidence which outlives a run, because the thing it stops the peer over
     * (a wrong end-to-end passphrase) is a fact about the configuration rather
     * than about this connection.
     *
     * SPLIT INTO A COUNT AND A FLAG so the count can be published (see
     * `InboundCounts.foreignDecoded`). They are not the same fact: the count is
     * what this ledger has watched happen, and the flag is what an earlier
     * process wrote down and this one adopted. Nothing persisted a number, so
     * inventing one for the adopted case would be a fabricated measurement in a
     * field an operator is being asked to reason from.
     */
    private foreignDecoded = 0;
    private adoptedDecode = false;

    private get everDecoded(): boolean {
        return this.foreignDecoded > 0 || this.adoptedDecode;
    }

    /**
     * Distinct documents that were delivered, owed a decode, and never produced
     * one inside the grace window. Capped at `undecodableQuorum`.
     *
     * WHY THIS EXISTS SEPARATELY FROM `awaitingDecode`, which already holds the
     * same documents. Two reasons, and both are the difference between a detector
     * that fires on the right evidence and one that fires on an artefact:
     *
     *  - `delivered - decoded` counts DELIVERY EVENTS, and an undecodable
     *    document is redelivered indefinitely, because it never reaches the apply
     *    callback and therefore never advances the checkpoint. Every feed re-arm
     *    replays it. A threshold on that count would reach 3 on ONE bad document
     *    after two re-arms, i.e. after one CouchDB hiccup, which is the regression
     *    this whole change removes, reintroduced on a delay and therefore harder
     *    to see. Keying by document id is mandatory, not a refinement.
     *  - `awaitingDecode` is cleared by `reset()` and drained by `settle()`'s
     *    documented `dropOldest()` fallback, so it cannot carry a judgement that
     *    has to hold across runs. This is the durable projection of it.
     *
     * NOT CLEARED BY `reset()`, for the reason `everDecoded` is not, plus one
     * that is specific to it and is a real measured loss rather than a symmetry
     * argument. A wrong-passphrase peer that also pushes a local note has that
     * note's echo decode, apply, and ADVANCE THE CHECKPOINT PAST the foreign
     * backlog (the apply callback advances it whatever the dispatch returned). One
     * restart later the backlog sits behind the checkpoint and is never delivered
     * again, so a per-run set would measure zero and the fault would become
     * invisible for good. Persisting this is what stops a peer's own echo from
     * erasing the evidence against it; `CouchDBPeer` keys the persisted copy by
     * the same configuration fingerprint as the decode receipt.
     */
    private readonly undecodableIds = new Set<string>();

    /**
     * Ids added to the set above since the owner last took them away to persist.
     *
     * A queue rather than a "dirty" flag so the owner writes down exactly what is
     * new, and survives `reset()` for the same reason the set does: the peer
     * drains this on the watchdog tick, and a stop between an addition and the
     * next tick must not lose the record.
     */
    private pendingUndecodablePersist: string[] = [];

    constructor(opts: InboundProgressOptions = {}) {
        this.decodeGraceMs = opts.decodeGraceMs ?? DECODE_GRACE_MS;
        this.applyGraceMs = opts.applyGraceMs ?? APPLY_GRACE_MS;
        this.deliverGraceMs = opts.deliverGraceMs ?? DELIVER_GRACE_MS;
        this.probeGraceMs = opts.probeGraceMs ?? PROBE_GRACE_MS;
        this.writeGraceMs = opts.writeGraceMs ?? WRITE_GRACE_MS;
        this.heldGraceMs = opts.heldGraceMs ?? HELD_GRACE_MS;
        this.undecodableQuorum = Math.max(1, opts.undecodableQuorum ?? UNDECODABLE_QUORUM);
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
     * IT DELIBERATELY DOES NOT SET `everDecoded`, AND THAT SEPARATION IS A BUG
     * FIX RATHER THAN A TIDY-UP. It used to, on the argument that the flag
     * suppresses the fatal verdict so it must mean "a document actually
     * decrypted" and nothing weaker. The argument was right and the code was
     * strictly weaker than it claimed, because A PEER CAN ALWAYS DECRYPT WHAT IT
     * ENCRYPTED ITSELF. Its own pushed document echoes back down the changes feed
     * within milliseconds of every write, decrypts perfectly, and lands here, so
     * a WRONG passphrase satisfied the receipt using nothing but its own output.
     *
     * Measured: a fresh install with a mistyped passphrase and one unsynced local
     * note pushed that note, took its echo as proof, persisted the wrong
     * passphrase's fingerprint, and from then on could never reach the branch
     * below. It settled at `degraded` forever, served 503 with a message about a
     * bad document rather than a bad passphrase, and kept publishing chunks no
     * other client in the cluster could read. Somebody setting up a new device
     * and mistyping the passphrase is the most likely way this fault is ever met,
     * and it defeated the one detector written for it.
     *
     * So the evidence half has its own entry point, `noteForeignDecode()`, which
     * a caller may only reach for a document it did not write.
     */
    noteDecoded(key?: string): void {
        this.decoded += 1;
        this.awaitingDecode.settle(key);
        this.awaitingApply.add(key, Date.now());
    }

    /**
     * A change THIS PEER DID NOT WRITE survived decryption.
     *
     * The only route to `everDecoded` within a run, and therefore the only thing
     * that can suppress the fatal "nothing has ever decrypted" verdict on the
     * strength of what this run has seen. Split out of `noteDecoded()` for the
     * reason written out there: decrypting a document is evidence about the
     * document, and only decrypting SOMEBODY ELSE'S document is evidence about
     * the configuration.
     *
     * This module cannot check that claim, and deliberately does not try. Nothing
     * here knows what the peer has pushed. `CouchDBPeer.noteForeignDecode()` is
     * the sole caller and carries the argument for how provenance is decided,
     * where in the inbound path that can honestly be done, and what the remaining
     * false negatives cost.
     *
     * Argument-free and one-way, exactly like `adoptPriorDecodeEvidence()`: there
     * is nothing to key it on, since the flag is a statement about the
     * configuration rather than about any one document, and nothing may use it to
     * clear the flag.
     *
     * Counted rather than flagged so `counts.foreignDecoded` can be published
     * beside `counts.decoded`. The pair is what makes the fatal verdict's message
     * legible: `{ decoded: 4, foreignDecoded: 0 }` says in two numbers what a
     * paragraph of detail text otherwise has to argue.
     */
    noteForeignDecode(): void {
        this.foreignDecoded += 1;
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
     *
     * THE FIRST SENTENCE OF THAT JUSTIFICATION HAS TO BE READ EXACTLY. The fatal
     * verdict's claim was once "not one document has decrypted", and that is now
     * reachable-false: `counts.decoded` may be large in a fatal verdict, because a
     * peer decrypts its own echoes under any passphrase at all. What outlives the
     * run, and what this method adopts, is the narrower fact that a document
     * written by ANOTHER CLIENT decrypted. See `noteForeignDecode()`.
     */
    adoptPriorDecodeEvidence(): void {
        this.adoptedDecode = true;
    }

    /**
     * Adopt the distinct documents that failed to decrypt under this exact
     * configuration in earlier runs.
     *
     * The counterpart of `adoptPriorDecodeEvidence()` on the other side of the
     * conjunction, and it exists for a sharper reason than symmetry: without it a
     * wrong-passphrase peer erases the evidence against itself with its own echo.
     * The sequence is written out on `undecodableIds`, and its end state is a peer
     * that reports `idle` forever while publishing chunks nobody can read.
     *
     * Additive and one-way, and capped at the quorum on the way in so that a
     * hand-edited or corrupted state file cannot make a peer fatal on adoption
     * alone: the verdict still requires live undecodable traffic (`undecodable > 0`
     * past the decode grace window) before the count is ever consulted.
     *
     * The CALLER owns which fingerprint these belong to, exactly as it does for
     * the decode receipt: failures under an old passphrase are evidence about that
     * passphrase and none at all about this one.
     */
    adoptPriorUndecodable(ids: readonly string[]): void {
        for (const id of ids) {
            if (this.undecodableIds.size >= this.undecodableQuorum) return;
            this.undecodableIds.add(id);
        }
    }

    /**
     * Take the newly-observed undecodable document ids away, for the owner to
     * write down.
     *
     * DRAINING, RATHER THAN A GETTER PLUS A FLAG, so that "what is new" is
     * answered once and cannot be answered twice: the owner persists on a
     * five-second watchdog tick and the alternative shapes either re-write the
     * whole set every tick or need a second piece of state saying how much of it
     * was already written.
     *
     * Nothing here calls it. `verdict()` does the observing, this hands the result
     * out, and `CouchDBPeer` decides where it goes; the ledger stays a counter
     * with a clock that does no I/O and knows nothing about a peer.
     */
    drainPersistableUndecodable(): string[] {
        if (this.pendingUndecodablePersist.length === 0) return [];
        const out = this.pendingUndecodablePersist;
        this.pendingUndecodablePersist = [];
        return out;
    }

    /**
     * Move every document that has now been owed a decode for longer than the
     * grace window into the durable set.
     *
     * CALLED FROM `verdict()`, which makes `verdict()` the one reader in this
     * module that also records, and that placement is deliberate rather than
     * convenient. The alternative was an explicit `sweepUndecodable()` that the
     * watchdog calls just before it judges, which reads better and fails worse:
     * forgetting the call disables the fatal detector entirely and silently, and
     * "a detector that is quietly not running" is the exact shape of fault this
     * whole subsystem exists to remove. Wiring the observation to the judgement
     * means the two cannot come apart. The remaining wiring (persistence) can
     * only cost DURABILITY if it is dropped, not detection.
     *
     * Safe to call as often as callers like: it is idempotent (a `Set`, keyed by
     * document id), monotone (nothing removes an entry), and short-circuits the
     * moment the quorum is reached, so the common case is one integer comparison.
     * It also adds no asymptotic cost even when it does walk: `oldest()` already
     * walks the same map on every single `verdict()` call.
     *
     * GATED ON `undecodable > 0`, WHICH IS THE SAME FIRST CONJUNCT THE DECODE
     * BRANCH USES, AND FOR A SHARPER REASON THAN CONSISTENCY. The clock and the
     * counter can disagree in exactly one direction: `noteDecoded()` called while
     * the clock is empty removes nothing (a document decoded before
     * `instrumentFeed()` attached, which `startWatch` makes reachable by arming
     * the feed before instrumenting it), so from then on `decoded` can exceed
     * `delivered`, the subtraction clamps to zero, and the clock nonetheless holds
     * whatever arrives next. Sweeping through that would write down a document as
     * a decryption failure on a peer whose ledger says nothing has failed at all.
     *
     * Worse, `PendingClock` promises to degrade to plain FIFO rather than to a
     * false alarm: an unmatched settle drops the OLDEST entry of any key, so in
     * that desynchronised state the entry left standing can belong to a document
     * that decoded perfectly well. Recording it here would promote a deliberate
     * FIFO approximation into persistent, fingerprinted evidence for stopping the
     * peer. With this gate the walk can never return more entries than the counter
     * says are missing, because the only way the clock's population exceeds
     * `delivered - decoded` is the clamped case this refuses to enter.
     */
    private sweepUndecodable(now: number, undecodable: number): void {
        if (undecodable <= 0) return;
        if (this.undecodableIds.size >= this.undecodableQuorum) return;
        for (const key of this.awaitingDecode.expiredKeys(now - this.decodeGraceMs)) {
            if (this.undecodableIds.size >= this.undecodableQuorum) return;
            if (this.undecodableIds.has(key)) continue;
            this.undecodableIds.add(key);
            this.pendingUndecodablePersist.push(key);
        }
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
     * TWO THINGS SURVIVE, AND THEY ARE THE TWO HALVES OF THE FATAL PREDICATE.
     * That is not a coincidence: the fatal verdict is the one judgement in this
     * module that is about the CONFIGURATION rather than about this connection, so
     * neither side of it may be re-derived from a single run's traffic.
     *
     *  - the foreign decode evidence (`foreignDecoded`, `adoptedDecode`), for the
     *    reason `adoptPriorDecodeEvidence()` gives at length: it is the fact that
     *    stops a restart from re-reading a partial decryption failure as a total
     *    one and killing the peer over a passphrase that works.
     *  - `undecodableIds` and its pending-persist queue, for the mirror-image
     *    reason written out on the field: a restart otherwise erases the evidence
     *    AGAINST a wrong passphrase, because the peer's own echo can carry the
     *    checkpoint past the documents it could not read.
     *
     * Dropping either one re-opens a measured failure, in opposite directions.
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
            foreignDecoded: this.foreignDecoded,
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
        // Before anything is read, because the decode branch below turns on the
        // result and because tying the observation to the judgement is what stops
        // a mis-wiring from disabling the detector. See `sweepUndecodable()`.
        this.sweepUndecodable(now, undecodable);
        const base = {
            ...counts,
            undecodable,
            undecodableDistinct: this.undecodableIds.size,
            unapplied,
            checkpointHeld: this.checkpointHeldSince !== undefined,
        };

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
            const distinct = this.undecodableIds.size;
            /*
             * THREE VERY DIFFERENT FAULTS WEAR THE SAME SYMPTOM, and the ledger is
             * the only thing that can tell them apart. All three look like
             * "documents arrived and did not decode". What separates them is two
             * facts, and BOTH are needed: whether a document written by another
             * client has ever decoded, and how many distinct documents have failed.
             *
             *  - NO FOREIGN DECODE, AND ENOUGH DISTINCT FAILURES. Not one document
             *    this peer did not write has decrypted, on this run or any earlier
             *    one, and at least `UNDECODABLE_QUORUM` distinct documents have
             *    failed to. That is what a wrong end-to-end passphrase produces,
             *    and nothing on the connect path can catch it first: the
             *    reachability probe is a plain GET, and the milestone is a
             *    `_local/` document, which `transform-pouch` refuses to transform
             *    at all. So a wrong passphrase connects cleanly and then decrypts
             *    nothing anybody else wrote. Retrying cannot help, and continuing
             *    is actively harmful (the push direction would keep writing chunks
             *    under a key no other client shares), so it is FATAL.
             *  - NO FOREIGN DECODE, TOO FEW FAILURES: `unproven`. Loud, and not
             *    fatal. See below.
             *  - A FOREIGN DECODE HAS HAPPENED: `degraded`. The passphrase is
             *    demonstrably correct, because a document written by somebody else
             *    decrypted with it. Some specific document did not, which is real
             *    loss and must be reported, but it is not a broken configuration.
             *    Treating it as fatal stopped the peer, took the PUSH direction
             *    down with it (`requireReady` throws once `fatalReason` is set),
             *    blocked `restartWorthy` forever (a fatal peer reports its backend
             *    down by design) and told the operator to change a passphrase that
             *    was correct. One bad document out of five hundred good ones
             *    needed a human to clear it.
             *
             * EACH HALF OF THE CONJUNCTION RULES OUT ONE MEASURED FAILURE, and
             * neither half is redundant. The revisions are worth naming, because
             * every one of them was arrived at by fixing the previous one:
             *
             *  1. `counts.decoded === 0`. Per-run, while the checkpoint is not, so
             *     a restart that replays only the one bad document past the
             *     checkpoint measures zero and escalates a partial failure to
             *     fatal about ninety seconds later. `adoptPriorDecodeEvidence()`
             *     documents that sequence in full.
             *  2. `!everDecoded` with the receipt granted by ANY decode. A peer can
             *     always decrypt what it encrypted itself, so a fresh install with
             *     a mistyped passphrase took its own echo as proof, persisted the
             *     wrong passphrase's fingerprint, and could never reach this branch
             *     again. `noteDecoded()` records that one.
             *  3. `!everDecoded` with the receipt correctly narrowed to FOREIGN
             *     documents, and this bar still at one. That is where the distinct
             *     count comes from: with the receipt made expensive to earn, a bar
             *     of one means a peer whose only inbound traffic so far has been
             *     its own echoes is stopped by the FIRST stranger's document that
             *     fails. Measured on a peer whose passphrase was correct and which
             *     had decrypted four documents.
             *
             * WHY THE QUANTITY IS DISTINCT DOCUMENTS AND NOT `undecodable`. An
             * undecodable document never advances the checkpoint, so every feed
             * re-arm redelivers it and the raw count climbs on one bad document
             * plus one CouchDB hiccup. A cumulative threshold would therefore
             * reintroduce revision 3's regression on a delay, which is strictly
             * worse than leaving it in place because it looks fixed. See
             * `undecodableIds`.
             *
             * `unproven` IS ITS OWN CONDITION RATHER THAN A SOFTENED `degraded`,
             * and the distinction is the whole reason `degraded`'s message is
             * allowed to be reassuring: `degraded` asserts that decryption is
             * working here, and a peer with no foreign receipt has no standing to
             * assert it. Both are `stalled` (a document really is missing from the
             * vault) and both are `restartFutile` (a restart replays the same
             * undecryptable document from the same checkpoint). The difference is
             * `fatal`, which is what stops the peer, and that is exactly the axis
             * the regression was on: the complaint was never "it reported
             * unhealthy", it was "it stopped, disconnected, and swallowed the next
             * local write".
             *
             * WHAT `unproven` DELIBERATELY LETS THROUGH, stated rather than hidden:
             * a WRONG passphrase against a cluster holding fewer than
             * `UNDECODABLE_QUORUM` foreign documents settles here, reports
             * unhealthy forever, and keeps publishing chunks nobody else can read.
             * That is the price of removing the regression and it cannot be
             * avoided, because a peer with no foreign receipt and one failing
             * foreign document is information-theoretically ambiguous: no local
             * evidence separates "the only stranger's document here is corrupt"
             * from "my passphrase is wrong and there is only one stranger's
             * document here". Requiring that a correct peer keep pushing forces the
             * tie to be broken towards innocence. It is bounded three ways: the
             * cluster is nearly empty, so the damage is nearly nil; the next
             * distinct foreign failure resolves it in whichever direction is true,
             * with no restart, because `escalateInboundFatal()` re-reads this every
             * five seconds; and the count is persisted, so the peer's own echo
             * carrying the checkpoint past the backlog no longer erases it.
             *
             * THE MESSAGES ARE WORDED FROM THE EVIDENCE, and which of them may name
             * a passphrase follows from what each one actually knows.
             *
             *  - The FATAL one may name it, because the CONJUNCTION is that cause's
             *    signature. Neither half is on its own, and an earlier revision's
             *    justification ("'nothing has ever decrypted' IS that signature")
             *    is now reachable-false twice over: `counts.decoded` can be large
             *    here, and one foreign failure is not a signature of anything. It
             *    must name BOTH candidates, this server's passphrase and the
             *    writing client's, because no local evidence separates them: a
             *    correct peer that meets a wrong-keyed client's bulk push before
             *    any correctly-keyed foreign document lands in this branch, and
             *    feed order is by sequence and not ours to choose.
             *  - The `unproven` one may raise a passphrase as ONE OF TWO readings,
             *    and must be worded that way. Silence would be worse: this is the
             *    state in which an operator who has just mistyped a passphrase most
             *    needs the word in front of them.
             *  - The `degraded` one may NOT name one, unchanged, because that
             *    wording sent operators to change a passphrase five hundred
             *    documents had just decrypted with.
             */
            if (!this.everDecoded && distinct >= this.undecodableQuorum) {
                return {
                    ...base,
                    state: 'undecodable',
                    detail:
                        `${undecodable} remote change(s) could not be decrypted, across ${distinct} or more ` +
                        'distinct document(s), and no document written by another client has ever decrypted',
                    stalled: true,
                    fatal: true,
                    restartFutile: true,
                    stalledMs,
                };
            }
            if (!this.everDecoded) {
                return {
                    ...base,
                    state: 'unproven',
                    detail:
                        `${undecodable} of ${counts.delivered} delivered change(s) could not be decrypted and no ` +
                        'document written by another client has decrypted yet, so this peer cannot yet tell a ' +
                        'wrong end-to-end passphrase here from documents written with a different one',
                    stalled: true,
                    fatal: false,
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
