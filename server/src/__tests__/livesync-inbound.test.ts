/**
 * Regression tests for the inbound (CouchDB to vault) direction, and for the
 * health verdict derived from it.
 *
 * WHY THIS FILE EXISTS. The bug it guards is "LiveSync reports healthy while
 * doing nothing": the changes feed stays attached, `/healthz/livesync` answers
 * 200, `sync ok` is logged every tick, and not one remote document reaches the
 * vault. Nothing throws out of the process, nothing fails a typecheck, and the
 * only difference between that state and a genuinely idle one used to be
 * invisible from every seam the server exposes.
 *
 * A TEST THAT ONLY ASSERTS THE HAPPY PATH WOULD BE WORTHLESS HERE, so every
 * block below drives one of the three ways the vendored engine loses a document
 * and asserts that the subsystem says so. Two of the three produce no exception
 * and no log line at any level, which is exactly why they are reproduced against
 * a faithful harness rather than asserted on a mock's call count:
 *
 *  - `TransformedChangesFeed` reproduces `transform-pouch`'s wrapper verbatim: it
 *    replaces `on` with `async (change) => origListener(await modifyChange(change))`
 *    and registers THAT on an EventEmitter, so a rejected decrypt takes the
 *    listener's promise with it and nothing downstream ever runs.
 *  - `FakeManipulator.beginWatch` reproduces the engine's own listener verbatim,
 *    including the `await this.getByMeta(doc)` that sits ABOVE its try/catch and
 *    the catch that logs and continues.
 *
 * If either harness is "simplified" to await the listener, or to move the
 * getByMeta call inside the try, it stops modelling the defect and every
 * assertion here becomes a tautology. Both are marked at their site.
 *
 * SCOPE: no CouchDB and no sockets. `globalThis.fetch` is stubbed where a
 * reachability probe is genuinely part of what is being asserted, and nowhere
 * else.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';

import { makeTmpDataDir, type TmpDir } from './helpers.js';
import { LiveSyncStateStore } from '../services/livesync/state.js';
import {
    CouchDBPeer,
    REMOTE_PENDING_INTERVAL_MS,
    REMOTE_PENDING_TIMEOUT_MS,
} from '../services/livesync/peer-couchdb.js';
import { RESTART_GRACE_MS } from '../services/livesync/health.js';
import {
    InboundProgress,
    APPLY_GRACE_MS,
    DECODE_GRACE_MS,
    DELIVER_GRACE_MS,
    HELD_GRACE_MS,
    PROBE_GRACE_MS,
    UNDECODABLE_QUORUM,
    WRITE_GRACE_MS,
    type InboundProgressOptions,
} from '../services/livesync/progress.js';
import type { DispatchFn, FileData, LiveSyncCouchDBConf, LiveSyncLogger } from '../services/livesync/types.js';

// ===========================================================================
// 1. The ledger on its own
// ===========================================================================

describe('InboundProgress', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    /** Short windows so a test does not have to sit out two real minutes. */
    const fast = () =>
        new InboundProgress({
            decodeGraceMs: 100,
            applyGraceMs: 200,
            deliverGraceMs: 300,
            probeGraceMs: 400,
            writeGraceMs: 500,
        });

    /**
     * A note-typed change: one that owes a decode receipt.
     *
     * The sequence doubles as the document key, which is what the per-document
     * stall clocks correlate on. Tests that need two documents told apart pass
     * different sequences, which is the same thing CouchDB does.
     */
    const note = (p: InboundProgress, seq: string) => p.noteFeedChange(seq, true, `doc-${seq}`);
    /**
     * Every step of one healthy document, keyed consistently.
     *
     * `noteForeignDecode` is part of the sequence because a document that flows
     * all the way to the vault is, in production, always one this peer did not
     * write: `CouchDBPeer.onRemoteChange` recognises its own echo through the
     * suppressor and returns before dispatching, so an echo is a `noteSkipped`
     * and never a `noteApplied`. A helper that decoded without taking the
     * foreign receipt would model a case that cannot happen and would leave every
     * test built on it asserting against the wrong ledger state.
     */
    const flowOne = (p: InboundProgress, seq: string) => {
        note(p, seq);
        p.noteDecoded(`doc-${seq}`);
        p.noteForeignDecode();
        p.noteApplied(`doc-${seq}`);
    };

    it('reports idle when nothing has ever arrived, and says so by name', () => {
        // The whole point of the type: "idle" and "wedged" must be different
        // answers, not the same `ok: true` with different causes.
        const p = fast();
        const v = p.verdict();
        expect(v.state).toBe('idle');
        expect(v.stalled).toBe(false);
        expect(v.fatal).toBe(false);
    });

    it('a document that flows end to end leaves the ledger idle again', () => {
        const p = fast();
        flowOne(p, '1');
        expect(p.verdict().state).toBe('idle');
        expect(p.verdict().applied).toBe(1);
        expect(p.verdict().restartFutile).toBe(false);
    });

    it('does not call a document in flight a stall before its window elapses', () => {
        // Every healthy document is momentarily "delivered but not decoded": the
        // raw feed counts it synchronously and decryption resolves a microtask
        // later. Without the window that transient would report every single
        // document that ever arrived as a decryption failure.
        const p = fast();
        note(p, '1');
        expect(p.verdict().state).toBe('flowing');
        expect(p.verdict().stalled).toBe(false);
        vi.advanceTimersByTime(99);
        expect(p.verdict().stalled).toBe(false);
    });

    it('MECHANISM 1: delivered, nothing FOREIGN ever decoded, and enough distinct failures is fatal', () => {
        // This is the state a wrong end-to-end passphrase produces: the feed hands
        // over documents, `transform-pouch` rejects while decrypting each of them,
        // and the engine's listener is never called. Fatal rather than retryable,
        // matching how mergeRemoteTweaks already treats the three settings it
        // refuses.
        //
        // THREE DOCUMENTS RATHER THAN ONE, and that is the evidence rather than
        // the fixture being generous. A key is a property of a client and clients
        // write in bulk, so a wrong passphrase fails on everything anybody else
        // wrote; one failure is a bad document at least as often as it is a bad
        // key. The two neighbouring tests are the other halves of the split: any
        // foreign decode behind it is `degraded`, and too few failures is
        // `unproven`.
        const p = fast();
        note(p, '1');
        note(p, '2');
        note(p, '3');
        vi.advanceTimersByTime(101);
        const v = p.verdict();
        expect(v.state).toBe('undecodable');
        expect(v.stalled).toBe(true);
        expect(v.fatal).toBe(true);
        expect(v.undecodable).toBe(3);
        expect(v.undecodableDistinct).toBe(3);
        expect(v.decoded).toBe(0);
        expect(v.foreignDecoded).toBe(0);
        expect(v.detail).toContain('decrypted');
    });

    it('FINDING 3: an undecodable document among successful decodes is degraded, NOT fatal', () => {
        /*
         * REGRESSION GUARD FOR FINDING 3, at the ledger.
         *
         * `fatal` stops the peer outright: the watchdog calls markFatal and stop(),
         * requireReady then throws on every put and delete so the PUSH direction
         * dies too, and couchReachable() reports the backend down so restartWorthy
         * can never become true. That is the correct response to a wrong
         * passphrase and a catastrophic one to a single bad document, and the
         * evidence separating the two was already in the ledger and unused: a
         * wrong passphrase decodes NOTHING, this decodes 500 things.
         *
         * Revert the `decoded === 0` requirement and `fatal` comes back true here,
         * which is exactly the assertion below.
         */
        const p = fast();
        for (let i = 0; i < 500; i += 1) flowOne(p, String(i));
        note(p, '500'); // this one never decodes
        vi.advanceTimersByTime(101);

        const v = p.verdict();
        expect(v.state).toBe('degraded');
        expect(v.fatal).toBe(false);
        // Still not "fine": a document was lost, so it stays out of the ok signal.
        expect(v.stalled).toBe(true);
        expect(v.undecodable).toBe(1);
        expect(v.decoded).toBe(500);
        // Worded from the evidence. The old message asserted a cause ("almost
        // always a wrong end-to-end encryption passphrase") that is false here and
        // sent operators to change a passphrase 500 documents had just decrypted
        // with.
        expect(v.detail).not.toContain('passphrase');
        expect(v.detail).toContain('500');
    });

    it('MECHANISM 2 and 3: decoded but never settled is a wedge, and is NOT fatal', () => {
        // A hung chunk wait (ChunkManager._enqueueWaiting hands the second waiter
        // a promise with no route to resolution) or a getByMeta throw above the
        // engine's try. Restarting plausibly helps, so this must NOT be fatal:
        // marking it fatal would stop the peer instead of letting the existing
        // restart machinery try the thing that might actually work.
        const p = fast();
        note(p, '1');
        p.noteDecoded();
        vi.advanceTimersByTime(201);
        const v = p.verdict();
        expect(v.state).toBe('unapplied');
        expect(v.stalled).toBe(true);
        expect(v.fatal).toBe(false);
        expect(v.unapplied).toBe(1);
    });

    it('classifies an undecodable document ahead of the unapplied one it also causes', () => {
        // Ordering is deliberate and mirrors classifyDetail(): a decryption
        // failure also leaves documents unsettled and the remote pending, and
        // reporting either symptom would send an operator to look at CouchDB
        // instead of at their passphrase.
        const p = fast();
        note(p, '1');
        p.noteDecoded();
        // A document from another client, which is what makes the classification
        // the PARTIAL one rather than the fatal one. The point of this case is
        // the ORDER, and it is unchanged by either split.
        p.noteForeignDecode();
        note(p, '2'); // this one never decodes
        p.setRemotePending(true);
        vi.advanceTimersByTime(1_000);
        expect(p.verdict().state).toBe('degraded');
    });

    it('MECHANISM 5: a remote holding changes the feed never delivers is a wedge', () => {
        // The case no in-process counter can see, because the entire failure is
        // that nothing arrives to count.
        const p = fast();
        p.setRemotePending(true);
        expect(p.verdict().stalled).toBe(false); // window not elapsed
        vi.advanceTimersByTime(301);
        const v = p.verdict();
        expect(v.state).toBe('undelivered');
        expect(v.stalled).toBe(true);
        expect(v.fatal).toBe(false);
    });

    it('FINDING 2: a probe that cannot answer reports unobservable, and never reports fine', () => {
        /*
         * REGRESSION GUARD FOR FINDING 2, at the ledger.
         *
         * The probe is the ONLY detector for a feed that has gone silent while
         * still reporting itself attached, because the in-process counters cannot
         * see a failure whose entire shape is that nothing arrives to count. The
         * previous code cleared the undelivered clock when the probe could not
         * answer, so the verdict became `idle` and `snapshot().ok` became TRUE:
         * the pre-fix silent behaviour, restored through the back door, and
         * reachable by the same proxy fault that would cause the outage.
         *
         * Note the asymmetry that made it wrong: an uninstrumentable FEED already
         * failed loudly to `unobservable`, an unanswerable PROBE failed green.
         *
         * Revert `noteProbeUnanswerable` to clearing the clock and the last three
         * assertions fail.
         */
        const p = fast();
        p.noteProbeUnanswerable();
        // One failed request is not evidence of anything, so the window applies
        // here exactly as it does everywhere else in this module.
        vi.advanceTimersByTime(399);
        expect(p.verdict().stalled).toBe(false);

        vi.advanceTimersByTime(2);
        const v = p.verdict();
        expect(v.state).toBe('unobservable');
        expect(v.stalled).toBe(true);
        expect(v.fatal).toBe(false);
    });

    it('FINDING 2: a probe that answers again clears the unobservable verdict', () => {
        // The other direction, and the reason the clock exists rather than a
        // latch: a proxy that dropped one request for a minute must not leave the
        // peer permanently unhealthy once it starts answering.
        const p = fast();
        p.noteProbeUnanswerable();
        vi.advanceTimersByTime(401);
        expect(p.verdict().state).toBe('unobservable');
        p.setRemotePending(false);
        vi.advanceTimersByTime(10_000);
        expect(p.verdict().state).toBe('idle');
    });

    it('a delivery clears the undelivered clock outright', () => {
        // A document arriving is the strongest possible proof the feed is alive,
        // and it is stronger evidence than any probe: the probe asks CouchDB what
        // it holds, the delivery proves the path from CouchDB to here works.
        const p = fast();
        p.setRemotePending(true);
        vi.advanceTimersByTime(299);
        note(p, '1');
        vi.advanceTimersByTime(299);
        expect(p.verdict().state).not.toBe('undelivered');
    });

    it('FINDING 1: a change of ANY type moves the cursor and clears the undelivered clock', () => {
        /*
         * REGRESSION GUARD FOR FINDING 1, at the ledger.
         *
         * The feed's selector is `type != leaf`, which admits `versioninfo`,
         * `syncinfo`, legacy `notes` and `chunkpack` as well as the two note
         * types. Only the note types owe a decode receipt, but ALL of them move
         * the feed forward, and the out-of-band probe measures from exactly this
         * cursor. Gate the cursor on the note types and one `versioninfo`
         * document past it makes the probe answer "pending" forever.
         *
         * Revert `noteFeedChange`'s unconditional cursor advance and both halves
         * below fail: the cursor stays undefined and the clock stays running.
         */
        const p = fast();
        p.setRemotePending(true);
        vi.advanceTimersByTime(299);
        p.noteFeedChange('900', false); // e.g. obsydian_livesync_version

        expect(p.getCursor()).toBe('900');
        expect(p.counts().received).toBe(1);
        // It owes no decode receipt, so it opens no gap that nothing could close.
        expect(p.counts().delivered).toBe(0);
        vi.advanceTimersByTime(10_000);
        const v = p.verdict();
        expect(v.state).toBe('idle');
        expect(v.stalled).toBe(false);
    });

    it('progress resets the clocks, so sustained load never reads as a stall', () => {
        // The rule ported from HealthTracker: evidence of progress resets the
        // window completely. Without it a peer under continuous inbound load,
        // where the outstanding count never touches zero, would cross its window
        // and report itself wedged while working perfectly.
        const p = fast();
        for (let i = 0; i < 20; i += 1) {
            note(p, String(i));
            p.noteDecoded();
            p.noteApplied();
            vi.advanceTimersByTime(150); // longer than the decode window, every time
            expect(p.verdict().stalled).toBe(false);
        }
    });

    it('keeps counting while it is stalled, so the report is evidence and not just a flag', () => {
        const p = fast();
        for (let i = 0; i < 5; i += 1) note(p, String(i));
        vi.advanceTimersByTime(101);
        const v = p.verdict();
        expect(v.received).toBe(5);
        expect(v.delivered).toBe(5);
        expect(v.undecodable).toBe(5);
        expect(v.detail).toContain('5');
        expect(v.stalledMs).toBeGreaterThan(100);
    });

    it('a deliberately ignored document is settled, not lost', () => {
        // THE FALSE-POSITIVE GUARD, and the reason the ledger counts skips at all.
        // A remote that also carries `i:` internal documents delivers them to this
        // peer, which refuses them on purpose. Counting a refusal as a document
        // that failed to land would report a perfectly healthy deployment as
        // permanently wedged, and a health signal that is always red is exactly as
        // useless as one that is always green.
        const p = fast();
        for (let i = 0; i < 10; i += 1) {
            note(p, String(i));
            p.noteDecoded();
            p.noteSkipped();
        }
        vi.advanceTimersByTime(10_000);
        const v = p.verdict();
        expect(v.state).toBe('idle');
        expect(v.stalled).toBe(false);
        expect(v.skipped).toBe(10);
    });

    it('a failed write settles the outstanding set without leaving the document outstanding', () => {
        // The half of noteFailed that was always right, asserted on its own so the
        // FINDING 4 tests below cannot be satisfied by simply un-settling
        // failures. Leaving a permanently unwritable remote document outstanding
        // would report it as `unapplied` forever, which is the wrong diagnosis
        // (nothing is waiting; a write was attempted and refused).
        const p = fast();
        note(p, '1');
        p.noteDecoded('doc-1');
        p.noteFailed('doc-1');
        vi.advanceTimersByTime(10_000);
        const v = p.verdict();
        expect(v.unapplied).toBe(0);
        expect(v.state).not.toBe('unapplied');
        expect(v.failed).toBe(1);
    });

    it('F1: a failed write is still visible after its own window, and is NOT idle', () => {
        /*
         * REGRESSION GUARD FOR F1, at the ledger.
         *
         * `noteFailed` settles the document, and `unappliedCount()` subtracts
         * `failed`, so a failure cancelled itself out of every quantity the
         * verdict looked at. Measured, before the fix: fifty consecutive remote
         * writes all throwing produced `{decoded: 50, applied: 0, failed: 50,
         * unapplied: 0, state: 'idle', stalled: false}`, so `snapshot().ok` was
         * true and `/healthz/livesync` served 200 while not one remote change was
         * reaching the vault. A full disk, a volume remounted read-only or a uid
         * change produces exactly that.
         *
         * The per-pass check in `syncImpl` was supposed to cover it and cannot: it
         * is a delta over a millisecond-wide pass window, so on an idle vault the
         * failures land outside every pass, the pass reports ok, and it CLEARS
         * `lastError` and stamps `lastSyncAt` on the way.
         *
         * Revert the `failedSince` clock in `noteFailed` and this test's last
         * three assertions fail: the state goes back to 'idle'.
         */
        const p = fast();
        for (let i = 0; i < 50; i += 1) {
            note(p, String(i));
            p.noteDecoded(`doc-${i}`);
            p.noteFailed(`doc-${i}`);
        }
        // A single failure is not yet a condition: the window is what separates
        // one transient EBUSY from a vault that cannot be written to.
        expect(p.verdict().stalled).toBe(false);

        vi.advanceTimersByTime(501);
        const v = p.verdict();
        expect(v.state).toBe('unwritable');
        expect(v.stalled).toBe(true);
        expect(v.failed).toBe(50);
        // Loud, but not a reason to stop the peer or to restart it: the fault is
        // outside this process and clears itself the moment a write lands.
        expect(v.fatal).toBe(false);
        expect(v.restartFutile).toBe(true);
        expect(v.detail).toContain('50');
    });

    it('F1: a peer that applied first and then failed everything is not idle either', () => {
        // The variant that defeats a naive "did anything ever apply?" check: the
        // vault filled up part way through. Ten documents landed, the next forty
        // did not, and before the fix this was the same `idle` as the previous
        // case.
        const p = fast();
        for (let i = 0; i < 10; i += 1) flowOne(p, String(i));
        for (let i = 10; i < 50; i += 1) {
            note(p, String(i));
            p.noteDecoded(`doc-${i}`);
            p.noteFailed(`doc-${i}`);
        }
        vi.advanceTimersByTime(501);
        const v = p.verdict();
        expect(v.state).toBe('unwritable');
        expect(v.applied).toBe(10);
        expect(v.failed).toBe(40);
    });

    it('F1: one write landing clears the failed-write clock, so occasional failures never alarm', () => {
        /*
         * THE FALSE-POSITIVE GUARD, and the reason the clock is cleared by
         * `noteApplied` and by nothing weaker. A vault with one permanently
         * unwritable remote document (a path this server refuses, a name the
         * filesystem rejects) alongside normal traffic must stay healthy: a
         * health signal that is always red is exactly as useless as one that is
         * always green.
         *
         * Note what does NOT clear it, asserted at the end: a skip means nothing
         * was written, and a decode means nothing was attempted, so neither is
         * evidence that the vault is writable.
         */
        const p = fast();
        for (let i = 0; i < 20; i += 1) {
            note(p, `f${i}`);
            p.noteDecoded(`doc-f${i}`);
            p.noteFailed(`doc-f${i}`);
            vi.advanceTimersByTime(400); // most of the window, every time
            flowOne(p, `g${i}`);
            vi.advanceTimersByTime(400);
            expect(p.verdict().stalled).toBe(false);
        }

        // ...and once the applies stop, the condition surfaces.
        note(p, 'last');
        p.noteDecoded('doc-last');
        p.noteFailed('doc-last');
        note(p, 'ignored');
        p.noteDecoded('doc-ignored');
        p.noteSkipped('doc-ignored');
        vi.advanceTimersByTime(501);
        expect(p.verdict().state).toBe('unwritable');
    });

    it('reports unobservable, not healthy, when the feed cannot be instrumented', () => {
        // The direction to fail in. If a dependency change ever hides the raw
        // feed, the subsystem must not quietly go back to the behaviour this
        // whole module was written to remove.
        const p = fast();
        p.setObservable(false);
        const v = p.verdict();
        expect(v.state).toBe('unobservable');
        expect(v.stalled).toBe(true);
        expect(v.fatal).toBe(false);
    });

    it('reset() clears a stall, so a restarted peer is judged on its own run', () => {
        const p = fast();
        note(p, '1');
        vi.advanceTimersByTime(1_000);
        expect(p.verdict().stalled).toBe(true);
        p.reset();
        vi.advanceTimersByTime(1_000);
        expect(p.verdict().state).toBe('idle');
    });

    // -----------------------------------------------------------------------
    // F4: the stall clocks are per document, not per peer
    // -----------------------------------------------------------------------

    it('F4: a wedged document is still reported while OTHER documents keep settling', () => {
        /*
         * REGRESSION GUARD FOR F4, at the apply clock.
         *
         * The clock used to be one timestamp restamped to `Date.now()` by every
         * settle that left anything outstanding, which reads as this module's own
         * "progress resets the clock" rule and is not: progress on document B is
         * not evidence about document A. Measured, before the fix: one wedged
         * document ALONE reported `unapplied`/`stalled: true`; the same wedged
         * document with a concurrent stream of other documents reported
         * `flowing`/`stalled: false`, permanently.
         *
         * The masking stream is the default deployment rather than a corner case.
         * `i:` internal-file documents are note-typed, so a remote with
         * `syncInternalFiles` on delivers them constantly; they decode, the
         * interest predicate refuses them, and each refusal used to wipe the
         * clock. An actively edited vault's own pushes echo back with the same
         * effect. So the detector for mechanism 3 (a chunk wait with no route to
         * resolution) was disabled by ordinary traffic.
         *
         * Revert `PendingClock` to a single restamped timestamp and the last two
         * assertions fail: the state comes back 'flowing'.
         */
        const p = fast();
        note(p, 'wedged');
        p.noteDecoded('doc-wedged'); // and never settles

        // Concurrent traffic, well past the apply window in total.
        for (let i = 0; i < 20; i += 1) {
            note(p, `skip${i}`);
            p.noteDecoded(`doc-skip${i}`);
            p.noteSkipped(`doc-skip${i}`);
            vi.advanceTimersByTime(30);
        }

        const v = p.verdict();
        expect(v.unapplied).toBe(1);
        expect(v.state).toBe('unapplied');
        expect(v.stalled).toBe(true);
    });

    it('F4: an undecodable document is still reported while OTHER documents keep decoding', () => {
        /*
         * REGRESSION GUARD FOR F4, at the decode clock, which had the identical
         * defect in `noteDecoded`. One document that never decrypts, with any
         * concurrent stream of documents that do, resolved to `flowing`.
         *
         * Revert `PendingClock` and the state comes back 'flowing' here too.
         */
        const p = fast();
        note(p, 'bad'); // delivered, never decoded
        for (let i = 0; i < 20; i += 1) {
            flowOne(p, `good${i}`);
            vi.advanceTimersByTime(15);
        }

        const v = p.verdict();
        expect(v.undecodable).toBe(1);
        expect(v.state).toBe('degraded'); // 20 decoded, so not the fatal branch
        expect(v.stalled).toBe(true);
    });

    it('F4: a continuously busy healthy peer is still never a stall', () => {
        /*
         * THE FALSE-POSITIVE GUARD FOR F4, and the reason the fix is a per
         * document clock rather than "stamp when the outstanding count leaves
         * zero". Under sustained load the outstanding count never touches zero,
         * so a transition-stamped clock would be set once at the start of the
         * load and never reset, and a peer working perfectly would report itself
         * wedged after one window.
         *
         * Here every document is outstanding at the same time as several others,
         * for far longer in total than any window, and each one settles promptly.
         */
        const p = fast();
        const inFlight: string[] = [];
        for (let i = 0; i < 60; i += 1) {
            note(p, String(i));
            p.noteDecoded(`doc-${i}`);
            inFlight.push(`doc-${i}`);
            // Three documents are always in flight, so the outstanding count is
            // never zero from the third document onwards.
            if (inFlight.length > 3) p.noteApplied(inFlight.shift() as string);
            vi.advanceTimersByTime(40);
            expect(p.verdict().stalled).toBe(false);
        }
    });

    it('F4: two updates to one path are counted separately, and settled oldest first', () => {
        // A document can legitimately be outstanding twice: the remote updated it
        // again before our write of the first version landed. The clock keeps one
        // entry per outstanding COPY under the one key, so the second copy is
        // still tracked after the first settles.
        //
        // Oldest-first within a key is the only ordering the caller could mean:
        // the storage peer serialises writes per path (`enqueue(rel, ...)`), so
        // the first update's write is the one that completes first.
        const p = fast();
        note(p, 'a1');
        p.noteDecoded('same.md');
        vi.advanceTimersByTime(150);
        note(p, 'a2');
        p.noteDecoded('same.md');
        p.noteApplied('same.md'); // the first of the two lands

        // One copy is still outstanding, and it is the second, so it is judged
        // from ITS arrival rather than from the first's or from now.
        expect(p.verdict().unapplied).toBe(1);
        vi.advanceTimersByTime(190);
        expect(p.verdict().state).toBe('flowing'); // 190 < the 200ms apply window

        // An unrelated document settling in the meantime changes nothing about
        // it, which is the part a per-peer clock got wrong.
        flowOne(p, 'unrelated');
        vi.advanceTimersByTime(20);
        const v = p.verdict();
        expect(v.state).toBe('unapplied');
        expect(v.stalledMs).toBeGreaterThanOrEqual(210);
        expect(v.stalledMs).toBeLessThan(360); // not measured from the FIRST copy
    });

    it('F4: an unkeyed settle still removes an entry, so the clock can never over-report', () => {
        // The degradation path. The keys come from three points in the engine's
        // pipeline; if one ever stopped matching, an exact-match-only removal
        // would leave the clock draining never, and a healthy peer would report a
        // permanent stall. A false alarm is the one failure a health instrument
        // cannot afford, so an unmatched settle drops the oldest entry instead,
        // which is the plain FIFO behaviour: no better than before, and no worse.
        const p = fast();
        note(p, '1');
        p.noteDecoded('a-key-that-does-not-match');
        p.noteApplied('nor-does-this-one');
        vi.advanceTimersByTime(10_000);
        expect(p.verdict().state).toBe('idle');
        expect(p.verdict().stalled).toBe(false);
    });

    // -----------------------------------------------------------------------
    // F2: the fatal verdict rests on evidence that outlives the run
    // -----------------------------------------------------------------------

    it('F2: prior evidence of a working passphrase makes a total run failure degraded, not fatal', () => {
        /*
         * REGRESSION GUARD FOR F2, at the ledger.
         *
         * `fatal` used to be `counts.decoded === 0`, which is per RUN, while the
         * checkpoint is not. So the sequence was: 500 documents decrypt and land,
         * the checkpoint reaches 499, the document at 500 never decrypts,
         * `degraded` is reported, the peer is judged restart-worthy, the pair is
         * rebuilt, and the fresh feed resumes from 499 and delivers exactly one
         * document: the bad one. `decoded === 0` for that run, so the peer stops
         * itself as fatally misconfigured and tells the operator to check a
         * passphrase that decrypted 500 documents ninety seconds earlier.
         *
         * Revert `!this.everDecoded` to `counts.decoded === 0` and this test's
         * `fatal` assertion fails.
         */
        const p = fast();
        p.adoptPriorDecodeEvidence();
        note(p, '500'); // the only document the replay delivers, and it does not decode
        vi.advanceTimersByTime(101);

        const v = p.verdict();
        expect(v.decoded).toBe(0); // the run really did decode nothing
        expect(v.state).toBe('degraded');
        expect(v.fatal).toBe(false);
        // Still loud, and still worded from the evidence rather than asserting a
        // cause the evidence does not support.
        expect(v.stalled).toBe(true);
        expect(v.detail).not.toContain('passphrase');
        expect(v.detail).toContain('decryption has worked before');
    });

    it('F2: with NO prior evidence the same shape is still fatal, which is the whole point', () => {
        // The control. A genuinely new peer pointed at a remote with a wrong
        // passphrase decodes nothing and has nothing behind it, and that must
        // still stop the peer: continuing would publish chunks encrypted with a
        // key no other client shares. A wrong passphrase fails on the whole
        // cluster, so reaching the quorum costs it nothing.
        const p = fast();
        note(p, '1');
        note(p, '2');
        note(p, '3');
        vi.advanceTimersByTime(101);
        expect(p.verdict().state).toBe('undecodable');
        expect(p.verdict().fatal).toBe(true);
    });

    it('F2: a real decode is remembered across reset(), because a restart is what re-reads it', () => {
        // `reset()` is called on every stop and start, and a restarted pair gets a
        // brand new ledger anyway, so the evidence has to be re-supplied by the
        // peer from persistent storage. What must NOT happen is reset() throwing
        // away evidence the same instance has already earned.
        const p = fast();
        flowOne(p, '1');
        p.reset();
        note(p, '2');
        vi.advanceTimersByTime(101);
        expect(p.verdict().fatal).toBe(false);
        expect(p.verdict().state).toBe('degraded');
    });

    // -----------------------------------------------------------------------
    // D5: the fatal bar is a QUANTITY of foreign evidence, not one document
    //
    // Narrowing the decode receipt to documents this peer did not write (D4) was
    // correct and it made the receipt expensive to earn. The bar on the other
    // side of the `and` was still one, so a whole class of legitimate peer
    // became stoppable by a single stranger's bad document. These are the two
    // halves of the conjunction, driven separately.
    // -----------------------------------------------------------------------

    /**
     * One document this peer pushed, coming back down the feed.
     *
     * It decodes, because this peer encrypted it, and the suppressor recognises
     * it so `onRemoteChange` returns false and the peer records a SKIP. What it
     * never does is grant the foreign receipt, which is the whole of D4. Modelled
     * here rather than asserted through the peer so the ledger's own bar can be
     * driven without a feed harness.
     */
    const echoOne = (p: InboundProgress, seq: string) => {
        note(p, seq);
        p.noteDecoded(`doc-${seq}`);
        p.noteSkipped(`doc-${seq}`);
    };

    it('D5 CASE 2: a peer whose only decodes are its OWN echoes is not stopped by one bad stranger', () => {
        /*
         * REGRESSION GUARD FOR THE MEASURED REGRESSION, at the ledger.
         *
         * The peer's passphrase is CORRECT. Its inbound traffic so far has been
         * nothing but its own pushes echoing back, so it holds no foreign receipt,
         * correctly: an echo decrypts under any passphrase at all and proves
         * nothing. Then one document from a stranger fails to decrypt.
         *
         * With the bar at one, that single document was enough: `undecodable`,
         * `fatal`, permanent 503, `connected` false, the push direction stopped
         * through `requireReady`, and the next local write never reached CouchDB.
         * On a peer that had decrypted four documents and whose configuration was
         * fine.
         *
         * Drop the `distinct >= quorum` term from `verdict()` and this test's
         * `fatal` assertion fails, which is the regression exactly.
         */
        const p = fast();
        for (let i = 0; i < 4; i += 1) echoOne(p, `echo${i}`);
        note(p, 'stranger'); // one foreign document that does not decrypt
        vi.advanceTimersByTime(101);

        const v = p.verdict();
        expect(v.fatal).toBe(false);
        expect(v.state).toBe('unproven');
        // Still not "fine", and deliberately so: a document really is missing from
        // the vault. The regression was never that it reported unhealthy.
        expect(v.stalled).toBe(true);
        expect(v.restartFutile).toBe(true);
        // The pair of numbers that makes the verdict legible instead of
        // contradictory. Four decrypted; none of the four is evidence.
        expect(v.decoded).toBe(4);
        expect(v.foreignDecoded).toBe(0);
        expect(v.undecodableDistinct).toBe(1);
        // It names the passphrase as one of two readings, which `degraded` may not
        // and `undecodable` asserts outright. This is the state an operator who
        // has just mistyped a passphrase is most likely to be looking at.
        expect(v.detail).toContain('passphrase');
        expect(v.detail).toContain('another');
    });

    it('D5 CASE 1: the same peer with a WRONG passphrase still stops, because a key fails on everything', () => {
        // The control, and the reason the quorum costs the headline case nothing.
        // A key is a property of a client and clients write in bulk, so a wrong
        // passphrase does not fail on one document: it fails on the whole cluster.
        const p = fast();
        for (let i = 0; i < 4; i += 1) echoOne(p, `echo${i}`);
        for (let i = 0; i < 12; i += 1) note(p, `stranger${i}`);
        vi.advanceTimersByTime(101);

        const v = p.verdict();
        expect(v.state).toBe('undecodable');
        expect(v.fatal).toBe(true);
        expect(v.decoded).toBe(4);
        expect(v.foreignDecoded).toBe(0);
        // Saturating, by design: this is a decision variable and not a census, and
        // capping it is what bounds the set behind it to three strings on a peer
        // that cannot read a hundred thousand documents. Every message worded from
        // it says "or more".
        expect(v.undecodableDistinct).toBe(UNDECODABLE_QUORUM);
        expect(v.detail).toContain('or more');
    });

    it('D5: one bad document redelivered forever is still ONE document, and never becomes fatal', () => {
        /*
         * THE REASON THE QUANTITY IS DISTINCT DOCUMENTS AND NOT `undecodable`.
         *
         * An undecodable document never reaches the apply callback, so it never
         * advances the checkpoint, so every feed re-arm resumes at or before it and
         * hands it back. The engine re-arms ten seconds after an error and the
         * watchdog re-arms every five, so `delivered - decoded` climbs 1, 2, 3 on
         * ONE bad document and one CouchDB hiccup.
         *
         * A threshold on that count would therefore reintroduce CASE 2's regression
         * on a delay, which is strictly worse than leaving it in place because it
         * looks fixed. Key the quantity on `undecodable` instead of on the distinct
         * set and this test goes fatal on the third redelivery.
         */
        const p = fast();
        for (let i = 0; i < 4; i += 1) echoOne(p, `echo${i}`);
        for (let i = 0; i < 20; i += 1) {
            // The same CouchDB `_id`, because it is the same document.
            p.noteFeedChange(String(i), true, 'doc-stranger');
            vi.advanceTimersByTime(101);
            const v = p.verdict();
            expect(v.fatal).toBe(false);
            expect(v.state).toBe('unproven');
            expect(v.undecodableDistinct).toBe(1);
        }
        // The raw count is what a naive threshold would have read.
        expect(p.verdict().undecodable).toBe(20);
    });

    it('D5: the boundary is exactly the quorum, and the document below it is not fatal', () => {
        // Stated as a pair so a change to `UNDECODABLE_QUORUM` has to move both
        // assertions deliberately rather than one of them by accident.
        const p = fast();
        for (let i = 0; i < UNDECODABLE_QUORUM - 1; i += 1) note(p, `stranger${i}`);
        vi.advanceTimersByTime(101);
        expect(p.verdict().undecodableDistinct).toBe(UNDECODABLE_QUORUM - 1);
        expect(p.verdict().state).toBe('unproven');
        expect(p.verdict().fatal).toBe(false);

        note(p, 'one-more');
        vi.advanceTimersByTime(101);
        expect(p.verdict().undecodableDistinct).toBe(UNDECODABLE_QUORUM);
        expect(p.verdict().state).toBe('undecodable');
        expect(p.verdict().fatal).toBe(true);
    });

    it('D5: a foreign decode arriving below the quorum demotes the verdict and settles it there', () => {
        // The receipt short-circuits the count entirely, and must: one document
        // written by somebody else decrypting is proof that the passphrase works,
        // whatever else has failed. `degraded` may then use its reassuring wording.
        const p = fast();
        for (let i = 0; i < UNDECODABLE_QUORUM - 1; i += 1) note(p, `stranger${i}`);
        vi.advanceTimersByTime(101);
        expect(p.verdict().state).toBe('unproven');

        p.noteForeignDecode();
        expect(p.verdict().state).toBe('degraded');
        expect(p.verdict().fatal).toBe(false);
        expect(p.verdict().detail).not.toContain('passphrase');

        // ...and no quantity of further failures brings the fatal verdict back.
        for (let i = 0; i < 20; i += 1) note(p, `later${i}`);
        vi.advanceTimersByTime(101);
        expect(p.verdict().state).toBe('degraded');
        expect(p.verdict().fatal).toBe(false);
    });

    it('D5: the failure count survives reset(), because the peer\'s own echo can erase it otherwise', () => {
        /*
         * THE MIRROR OF F2, on the other side of the conjunction, and it guards a
         * real loss rather than a symmetry.
         *
         * A wrong-passphrase peer that also pushes a local note has that note's
         * echo decode, apply, and carry the CHECKPOINT past the foreign backlog it
         * could not read (the apply callback advances it whatever the dispatch
         * returned). One restart later the backlog is behind the checkpoint and is
         * never delivered again, so a per-run count measures zero and the fault
         * becomes invisible for good: `idle`, healthy, publishing chunks nobody can
         * read, forever.
         *
         * Clear `undecodableIds` in `reset()` and the last two assertions fail.
         */
        const p = fast();
        for (let i = 0; i < UNDECODABLE_QUORUM - 1; i += 1) note(p, `stranger${i}`);
        vi.advanceTimersByTime(101);
        expect(p.verdict().undecodableDistinct).toBe(UNDECODABLE_QUORUM - 1);

        p.reset();
        expect(p.verdict().undecodableDistinct).toBe(UNDECODABLE_QUORUM - 1);

        // The next run delivers exactly one new bad document, and that is enough.
        note(p, 'one-more-next-run');
        vi.advanceTimersByTime(101);
        expect(p.verdict().state).toBe('undecodable');
        expect(p.verdict().fatal).toBe(true);
    });

    it('D5: adopted failures reach the quorum, and adoption alone can never be fatal', () => {
        // How a restarted peer inherits the count from disk. The second half is the
        // safety property: a hand-edited or corrupted state file hands over three
        // ids and the peer stays `idle`, because the branch is only entered once
        // LIVE traffic has failed past the decode window. Evidence about the past
        // may raise the bar's other side; it may not manufacture a symptom.
        const p = fast();
        p.adoptPriorUndecodable(['a', 'b', 'c']);
        vi.advanceTimersByTime(10_000);
        expect(p.verdict().state).toBe('idle');
        expect(p.verdict().fatal).toBe(false);

        note(p, 'live');
        vi.advanceTimersByTime(101);
        expect(p.verdict().state).toBe('undecodable');
        expect(p.verdict().fatal).toBe(true);
    });

    it('D5: what the ledger observes is handed out exactly once, for the owner to write down', () => {
        // The drain contract. The peer persists on a five-second watchdog tick, so
        // "what is new" has to be answerable without re-writing the whole set every
        // tick, and it must not be answerable twice.
        const p = fast();
        note(p, 'a');
        note(p, 'b');
        vi.advanceTimersByTime(101);
        p.verdict(); // the observation happens here, not in the drain
        expect(p.drainPersistableUndecodable().sort()).toEqual(['doc-a', 'doc-b']);
        expect(p.drainPersistableUndecodable()).toEqual([]);

        // Redelivery of the same documents adds nothing to write down.
        note(p, 'a');
        vi.advanceTimersByTime(101);
        p.verdict();
        expect(p.drainPersistableUndecodable()).toEqual([]);
    });

    it('D5: a decode that outran its own delivery is not read as a decryption failure', () => {
        /*
         * BOTH CONJUNCTS ON THE BRANCH GUARD ARE LOAD-BEARING, which a revert of
         * `undecodable > 0` alone did not previously demonstrate.
         *
         * `CouchDBPeer.startWatch` calls `man.beginWatch()` and only then
         * `instrumentFeed()`, so a document handed over in that window reaches the
         * interest predicate without ever having been counted as delivered. From
         * then on `decoded` can exceed `delivered`, `undecodableCount()` clamps the
         * difference to zero, and the decode CLOCK does not clamp with it: the next
         * document genuinely in flight leaves `decodeSince` set while the count says
         * nothing is missing.
         *
         * Drop `undecodable > 0` from the guard and this peer reports `unproven`
         * with a detail reading "0 of 1 delivered change(s) could not be decrypted",
         * i.e. a decryption verdict against a peer that has not failed to decrypt
         * anything at all. On a peer with no foreign receipt, three of those in a
         * row would be fatal.
         */
        const p = fast();
        p.noteDecoded('decoded-before-we-were-counting');
        note(p, 'genuinely-in-flight');
        vi.advanceTimersByTime(101);

        const v = p.verdict();
        expect(v.undecodable).toBe(0);
        expect(v.state).toBe('flowing');
        expect(v.fatal).toBe(false);
        expect(v.undecodableDistinct).toBe(0);
    });

    it('D5: documents the feed did not name count as one, which delays a verdict rather than inventing one', () => {
        // `PendingClock`'s unnamed bucket collapses to a single entry however many
        // documents it holds, so a feed that stopped supplying ids would under
        // count. That is the direction this whole module degrades in: under
        // counting delays a fatal verdict, over-counting manufactures one against a
        // configuration that works.
        const p = fast();
        for (let i = 0; i < 10; i += 1) p.noteFeedChange(String(i), true);
        vi.advanceTimersByTime(101);
        expect(p.verdict().undecodable).toBe(10);
        expect(p.verdict().undecodableDistinct).toBe(1);
        expect(p.verdict().fatal).toBe(false);
    });

    // -----------------------------------------------------------------------
    // F3: which stalls are worth restarting
    // -----------------------------------------------------------------------

    it('F3: the stalls a restart cannot fix say so, and the two it can do not', () => {
        /*
         * REGRESSION GUARD FOR F3, at the ledger.
         *
         * `stalled` alone drives `restartWorthy`, and `couchReachable()`
         * short-circuits on `fatalReason` only, so before this flag every
         * non-fatal stall reached `maybeRestart()` every cooldown (5 minutes,
         * flat, no backoff), and each cycle tore the peer pair down and ran a
         * full offline vault scan through `onConnected`. For a document that will
         * not decrypt, a probe a proxy refuses, or a full disk, that is a costly
         * no-op repeated forever. The codebase already states the principle in
         * prose for the fatal case; this applies it to the rest.
         *
         * Revert `restartFutile` and the first three assertions fail.
         */
        const unobservable = fast();
        unobservable.setObservable(false);
        expect(unobservable.verdict().restartFutile).toBe(true);

        const degraded = fast();
        for (let i = 0; i < 5; i += 1) flowOne(degraded, String(i));
        note(degraded, 'bad');
        vi.advanceTimersByTime(101);
        expect(degraded.verdict().state).toBe('degraded');
        expect(degraded.verdict().restartFutile).toBe(true);

        const unwritable = fast();
        note(unwritable, '1');
        unwritable.noteDecoded('doc-1');
        unwritable.noteFailed('doc-1');
        vi.advanceTimersByTime(501);
        expect(unwritable.verdict().state).toBe('unwritable');
        expect(unwritable.verdict().restartFutile).toBe(true);

        // The two a fresh manipulator genuinely repairs. These must stay
        // restart-worthy: they are the recovery this whole subsystem exists to
        // trigger, and marking them futile would disable it.
        const unapplied = fast();
        note(unapplied, '1');
        unapplied.noteDecoded('doc-1');
        vi.advanceTimersByTime(201);
        expect(unapplied.verdict().state).toBe('unapplied');
        expect(unapplied.verdict().restartFutile).toBe(false);

        const undelivered = fast();
        undelivered.setRemotePending(true);
        vi.advanceTimersByTime(301);
        expect(undelivered.verdict().state).toBe('undelivered');
        expect(undelivered.verdict().restartFutile).toBe(false);
    });

    it('F3: an unanswerable probe is unhealthy and unfixable by restarting, both at once', () => {
        // The other entry point to `unobservable`. It keeps `stalled` and
        // therefore the 503, which is the loudness the design wants, while
        // refusing to spend a vault rescan every five minutes on a proxy fault.
        const p = fast();
        p.noteProbeUnanswerable();
        vi.advanceTimersByTime(401);
        const v = p.verdict();
        expect(v.state).toBe('unobservable');
        expect(v.stalled).toBe(true);
        expect(v.restartFutile).toBe(true);
    });

    // -----------------------------------------------------------------------
    // F6: a delivery answers the question the probe was asked
    // -----------------------------------------------------------------------

    it('F6: a live delivery clears the probe clock, not just the pending one', () => {
        /*
         * REGRESSION GUARD FOR F6.
         *
         * `noteFeedChange`'s own doc comment states the rule ("a delivery is the
         * strongest possible proof that the feed is alive, stronger than any
         * probe answer") and the code cleared only `undeliveredSince`. Measured,
         * before the fix: ten documents received, decoded and applied inside the
         * window still gave `unobservable`, `stalled: true`, `ok: false` on a
         * demonstrably healthy peer, for as long as anything kept the probe from
         * answering. The probe exists to detect a feed delivering nothing; a feed
         * that is delivering has already answered.
         *
         * Revert the `probeUnansweredSince` clear in `noteFeedChange` and the two
         * assertions after the deliveries fail.
         */
        const p = fast();
        p.noteProbeUnanswerable();
        vi.advanceTimersByTime(399);
        for (let i = 0; i < 10; i += 1) flowOne(p, String(i));

        vi.advanceTimersByTime(399);
        expect(p.verdict().state).toBe('idle');
        expect(p.verdict().stalled).toBe(false);

        // And it comes back if the deliveries stop while the probe stays broken:
        // the clear is evidence with a shelf life, not a latch.
        p.noteProbeUnanswerable();
        vi.advanceTimersByTime(401);
        expect(p.verdict().state).toBe('unobservable');
    });

    it('tracks the FEED cursor, not the applied checkpoint', () => {
        // The cursor is what the remote-pending probe compares against. Using the
        // applied checkpoint instead would lag forever on any remote carrying
        // documents this peer ignores, and would report every such deployment as
        // having pending changes it is failing to apply.
        const p = fast();
        note(p, '11');
        p.noteDecoded();
        p.noteSkipped(); // ignored, so no checkpoint advance would ever happen
        expect(p.getCursor()).toBe('11');
    });

    it('ships windows that are wide enough to survive the engine they wrap', () => {
        // Guard rails for a future edit. APPLY_GRACE_MS must exceed the engine's
        // own 30s LEAF_WAIT_TIMEOUT or a document waiting normally for a late
        // chunk reads as wedged; DELIVER_GRACE_MS is deliberately the same 60s as
        // RESTART_GRACE_MS so the two halves of one decision agree about patience,
        // and PROBE_GRACE_MS matches both so "the feed may be dead" and "I can no
        // longer tell whether the feed is dead" are equally patient.
        expect(APPLY_GRACE_MS).toBeGreaterThan(30_000);
        expect(DELIVER_GRACE_MS).toBe(RESTART_GRACE_MS);
        expect(PROBE_GRACE_MS).toBe(DELIVER_GRACE_MS);
        expect(DECODE_GRACE_MS).toBeGreaterThan(1_000);
        // F1's window belongs to the same family: it is a standing condition, so
        // it gets the standing conditions' patience rather than a fourth number.
        // It must not be zero, or one transient EBUSY flips the health signal.
        expect(WRITE_GRACE_MS).toBe(DELIVER_GRACE_MS);
        // And so does the checkpoint hold, for a reason of its own: the engine
        // re-arms its own changes feed ten seconds after an error, and that re-arm
        // replays from the held checkpoint and clears the hold. A window shorter
        // than that would report ordinary self-healing as a fault on every blip.
        expect(HELD_GRACE_MS).toBe(DELIVER_GRACE_MS);
        expect(HELD_GRACE_MS).toBeGreaterThan(10_000);
    });

    it('FINDING 2: gives the pending probe a deadline sized for its EXPENSIVE case', () => {
        /*
         * Guard rail for the second half of Finding 2. With
         * `filter=_selector&limit=1` the positive answer returns on the first
         * matching row and is free; proving EMPTINESS makes CouchDB walk the
         * by-sequence index from `since` to the tail evaluating the selector per
         * row. So the tightest deadline used to land on the healthy case, and a
         * timeout there is not an answer, it is a failed measurement, which now
         * costs the peer its health signal. Five seconds was a false-alarm
         * generator.
         *
         * It must also stay UNDER the probe interval, or two probes overlap on the
         * same connection and the in-flight guard silently skips beats.
         */
        expect(REMOTE_PENDING_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
        expect(REMOTE_PENDING_TIMEOUT_MS).toBeLessThan(REMOTE_PENDING_INTERVAL_MS);
        // And the probe still has to be able to answer inside the window that
        // classifies a dead feed, or the classification could never be reached.
        expect(REMOTE_PENDING_INTERVAL_MS).toBeLessThan(DELIVER_GRACE_MS);
    });
});

// ===========================================================================
// 2. The wired feed
// ===========================================================================

/**
 * A raw change as PouchDB emits it, before any decryption.
 *
 * `id` is CouchDB's document id and is always present on a real change row. It
 * is modelled here rather than left out because the peer's stall clocks
 * correlate a document's three appearances (raw row, interest predicate, apply
 * callback) on it, and a harness that omitted it would exercise only the
 * fallback path and prove nothing about the one that runs in production.
 */
interface RawChange {
    seq: string | number;
    id?: string;
    doc: Record<string, unknown> | null;
}

type Outgoing = (doc: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * PouchDB's changes emitter with `transform-pouch`'s wrapper on top, reproduced
 * from `node_modules/transform-pouch/index.js`.
 *
 * THE TWO DEFECTIVE PROPERTIES ARE THE POINT AND MUST NOT BE TIDIED AWAY:
 *
 *  1. the replacement `on` is `async` and its promise is DISCARDED by the
 *     EventEmitter, so a rejected `outgoing` silently drops the listener call;
 *  2. only `on` is replaced, as an own property, leaving `addListener` untouched
 *     on the prototype. That is what the peer's counting listener relies on, and
 *     asserting through this harness is what would catch the dependency bump that
 *     took it away.
 */
class TransformedChangesFeed extends EventEmitter {
    /** How many listeners were registered through the decrypting `on`. */
    wrappedRegistrations = 0;

    constructor(outgoing: Outgoing, discarded: unknown[]) {
        super();
        const origOn = EventEmitter.prototype.on.bind(this);
        const modifyChange = async (change: RawChange): Promise<RawChange> => {
            if (change.doc) change.doc = await outgoing(change.doc);
            return change;
        };
        Object.assign(this, {
            cancel() {
                /* nothing to cancel in the harness */
            },
            on: (event: string, listener: (change: RawChange) => void) => {
                if (event !== 'change') return origOn(event, listener);
                this.wrappedRegistrations += 1;
                return origOn(event, (change: RawChange) => {
                    // Verbatim from transform-pouch: an async listener on an
                    // EventEmitter. The library DISCARDS this promise, so a
                    // rejected decrypt never reaches `listener` and never reaches
                    // an error handler either.
                    const settled = (async () => {
                        listener(await modifyChange(change));
                    })();
                    /*
                     * The one deliberate divergence, and it changes nothing under
                     * test. In production this rejection escapes to the process
                     * and is counted by the `unhandledRejection` hook in
                     * services/livesync.ts; here it is recorded instead, because a
                     * test runner treats an unhandled rejection as a failed run
                     * and this file needs the rejection to HAPPEN. What matters to
                     * every assertion below is unchanged: `listener` is not
                     * called, nothing downstream observes the document, and no
                     * error event fires on the feed.
                     */
                    void settled.catch((e: unknown) => discarded.push(e));
                });
            },
        });
    }
}

interface FakeManipulatorOptions {
    /** Decryption. Reject to reproduce a wrong passphrase. */
    outgoing?: Outgoing;
    /** Chunk resolution. Reject or hang to reproduce the two engine defects. */
    getByMeta?: (doc: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/**
 * A stand-in for `DirectFileManipulator` covering only `beginWatch`.
 *
 * The listener body is copied from
 * `vendor/livesync-engine/upstream/src/API/DirectFileManipulatorV2.ts`, and the
 * two things that look like mistakes are the mistakes being tested: `getByMeta`
 * is awaited OUTSIDE the try, and the catch logs and continues.
 */
class FakeManipulator {
    watching = false;
    since = '';
    changes?: TransformedChangesFeed;
    /**
     * Every rejection the engine's own plumbing throws away.
     *
     * In production these reach the process as unhandled rejections (mechanism 1)
     * or are swallowed by the engine's catch (mechanism 2); either way nothing
     * downstream of the feed learns that a document was lost. Collected here so
     * the tests can assert that the loss happened and was invisible.
     */
    readonly discarded: unknown[] = [];
    private readonly opts: FakeManipulatorOptions;

    constructor(opts: FakeManipulatorOptions = {}) {
        this.opts = opts;
    }

    beginWatch(
        callback: (doc: unknown, seq?: string | number) => Promise<unknown> | void,
        checkIsInterested?: (doc: never) => boolean,
    ): false | void {
        if (this.watching) return false;
        this.watching = true;
        const outgoing = this.opts.outgoing ?? ((doc: Record<string, unknown>) => Promise.resolve(doc));
        const getByMeta =
            this.opts.getByMeta ??
            ((doc: Record<string, unknown>) =>
                Promise.resolve({ ...doc, data: ['content of ' + String(doc.path)] }));
        const feed = new TransformedChangesFeed(outgoing, this.discarded);
        this.changes = feed;
        feed.on('change', (change: RawChange) => {
            const run = (async () => {
                const doc = change.doc;
                if (!doc) return;
                if (doc.type !== 'newnote' && doc.type !== 'plain') return;
                if (checkIsInterested && !checkIsInterested(doc as never)) return;
                const docX = await getByMeta(doc); // OUTSIDE the try: the engine's bug
                try {
                    await callback(docX, change.seq);
                } catch {
                    /* the engine logs at INFO and continues */
                }
            })();
            // Recorded rather than left unhandled, for the reason given in
            // TransformedChangesFeed. The engine leaves it unhandled.
            void run.catch((e: unknown) => this.discarded.push(e));
        });
    }

    endWatch(): void {
        this.watching = false;
    }

    close(): Promise<void> {
        return Promise.resolve();
    }

    // --- the push direction ----------------------------------------------------
    //
    // Present only so a test can assert that the OUTBOUND half is still accepting
    // writes. That is a real question rather than a completeness exercise:
    // `CouchDBPeer.requireReady()` throws for every put and delete once
    // `fatalReason` is set, so anything that marks the peer fatal takes the push
    // direction down with it whatever the inbound fault was.

    /** Paths this manipulator was asked to write. */
    readonly puts: string[] = [];

    get(_path: string, _meta?: boolean): Promise<false> {
        // No existing document, so `put` skips the same-content comparison and
        // goes straight to the write, which is the path under test.
        return Promise.resolve(false);
    }

    put(path: string): Promise<boolean> {
        this.puts.push(path);
        return Promise.resolve(true);
    }

    /** Push one raw change into the feed, exactly as CouchDB would. */
    emitChange(change: RawChange): void {
        const row: RawChange = { ...change };
        // CouchDB always sends the id on the row itself, so fill it in from the
        // document unless a test is deliberately withholding it.
        if (row.id === undefined && typeof change.doc?._id === 'string') row.id = change.doc._id;
        this.changes?.emit('change', row);
    }
}

/** The private surface these tests drive. Structural, so a rename breaks the build. */
interface PeerInternals {
    man: unknown;
    connected: boolean;
    startWatch(): void;
    startWatchdog(): void;
    escalateInboundFatal(): void;
    probeRemotePending(): Promise<boolean | undefined>;
    tickPendingProbe(): void;
    progress: InboundProgress;
}

/**
 * `FakeManipulator.put` replaced for one test, so a CouchDB write can be made to
 * throw.
 *
 * Typed rather than assigned through `any`: the peer calls `man.put(path, body,
 * info, type)` and only the path is asserted on, so the stand-in takes the path
 * and ignores the rest, which is exactly what the class method does.
 */
type PutFn = (path: string) => Promise<boolean>;

function couchConf(overrides: Partial<LiveSyncCouchDBConf> = {}): LiveSyncCouchDBConf {
    return {
        name: 'couch',
        baseDir: '',
        url: 'https://couch.example.test:5984',
        username: 'syncuser',
        password: 'hunter2-should-never-be-logged',
        database: 'vault',
        // Spelled out rather than omitted: the engine's option type requires
        // both, and `undefined` is its documented spelling for "disabled".
        passphrase: undefined,
        obfuscatePassphrase: undefined,
        ...overrides,
    };
}

/**
 * The fingerprint a peer built from this configuration records decode evidence
 * under.
 *
 * Computed from the same four fields `CouchDBPeer`'s constructor uses, so a test
 * can read the PERSISTED evidence rather than infer it from a verdict. Both are
 * worth asserting and they are not the same claim: the verdict is what an
 * operator sees now, the record is what a restarted peer adopts.
 */
function evidenceKey(overrides: Partial<LiveSyncCouchDBConf> = {}): string {
    const conf = couchConf(overrides);
    return LiveSyncStateStore.decodeEvidenceKey({
        url: conf.url,
        database: conf.database,
        passphrase: conf.passphrase,
        obfuscatePassphrase: conf.obfuscatePassphrase,
    });
}

/** A remote metadata document as it sits in CouchDB. */
function remoteDoc(p: string, type: 'plain' | 'newnote' = 'plain'): Record<string, unknown> {
    return { _id: p, type, path: p, ctime: 1, mtime: 1, size: 8, children: ['h:aaaa'] };
}

/**
 * Let every pending microtask run.
 *
 * Microtasks, not timers: the feed's path is a chain of awaits with no timer in
 * it, and `vi.advanceTimersByTime` would not drain a single one of them.
 */
async function flush(times = 30): Promise<void> {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/**
 * The watchdog ticks the pending probe runs on, without a watchdog.
 *
 * `tickPendingProbe` fires one probe per `REMOTE_PENDING_INTERVAL_MS` worth of
 * 5-second watchdog ticks (four of them), so a test that called it once would
 * silently assert nothing at all.
 */
async function runProbe(internals: PeerInternals): Promise<void> {
    const ticks = Math.ceil(REMOTE_PENDING_INTERVAL_MS / 5_000);
    for (let i = 0; i < ticks; i += 1) internals.tickPendingProbe();
    await flush();
}

describe('CouchDBPeer inbound wiring', () => {
    let tmp: TmpDir;
    let dispatched: string[];

    beforeEach(async () => {
        vi.useFakeTimers();
        tmp = await makeTmpDataDir();
        dispatched = [];
    });

    afterEach(async () => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        await tmp.cleanup();
    });

    /** Everything a test may want to vary about the peer around the fake feed. */
    interface PeerWiring {
        log?: LiveSyncLogger;
        /** Overrides the recording dispatch. Return false to model a refusal. */
        dispatch?: DispatchFn;
        /** Share one store between two peers, i.e. model a restart. */
        state?: LiveSyncStateStore;
        /** Change the key material or the remote the peer believes it is talking to. */
        conf?: Partial<LiveSyncCouchDBConf>;
        /**
         * Narrow the ledger's windows further for one test.
         *
         * Merged over the defaults below rather than replacing them, so a test
         * that only cares about (say) the checkpoint-hold window does not silently
         * restore the production-length windows for every other clock and then
         * assert against a condition that can no longer be reached inside a test.
         */
        progress?: InboundProgressOptions;
    }

    /** A store on the shared temp dir, with the debounce pushed out of reach. */
    function makeState(): LiveSyncStateStore {
        return new LiveSyncStateStore('test::', {
            file: path.join(tmp.dataDir, 'livesync-state.json'),
            // Far beyond anything these tests advance, so no write is scheduled
            // onto the fake clock.
            flushDelayMs: 3_600_000,
        });
    }

    /**
     * A peer wired to a fake manipulator, with short windows.
     *
     * `startWatch()` is called rather than `start()`: connecting is what needs a
     * CouchDB, watching is not, and the seam under test is the one between the
     * feed and the ledger.
     */
    function makePeer(opts: FakeManipulatorOptions = {}, wiring: PeerWiring | LiveSyncLogger = {}) {
        // The second argument used to be the logger, and several tests still pass
        // one. Accepting both keeps those readable rather than making every call
        // site wrap a one-field object.
        const w: PeerWiring = typeof wiring === 'function' ? { log: wiring } : wiring;
        const state = w.state ?? makeState();
        const peer = new CouchDBPeer(couchConf(w.conf), {
            state,
            dispatch:
                w.dispatch ??
                ((p: string, data: FileData | false) => {
                    dispatched.push(`${data === false ? 'delete' : 'put'} ${p}`);
                    return Promise.resolve(true);
                }),
            log: w.log,
            progress: {
                decodeGraceMs: 1_000,
                applyGraceMs: 2_000,
                deliverGraceMs: 3_000,
                probeGraceMs: 4_000,
                writeGraceMs: 5_000,
                ...w.progress,
            },
        });
        const man = new FakeManipulator(opts);
        const internals = peer as unknown as PeerInternals;
        internals.man = man;
        internals.connected = true;
        internals.startWatch();
        return { peer, man, internals, state };
    }

    it('counts a healthy document all the way through and stays ok', async () => {
        const { peer, man } = makePeer();
        man.emitChange({ seq: '7', doc: remoteDoc('note.md') });
        await flush();

        expect(dispatched).toEqual(['put note.md']);
        const v = peer.inbound();
        expect(v.delivered).toBe(1);
        expect(v.decoded).toBe(1);
        expect(v.applied).toBe(1);
        expect(v.state).toBe('idle');
        expect(peer.snapshot().ok).toBe(true);

        // ...and nothing about the passage of time changes that.
        vi.advanceTimersByTime(60_000);
        expect(peer.snapshot().ok).toBe(true);
        expect(peer.snapshot().detail).toBe('watching');
    });

    it('registers its counter through addListener, NOT through the decrypting on()', () => {
        // The assertion that fails if someone "tidies" instrumentFeed to use the
        // same `on` everything else uses. Going through `on` would put the counter
        // behind the very decryption whose failure it exists to detect, and would
        // decrypt every document twice on the way.
        const { man } = makePeer();
        expect(man.changes?.wrappedRegistrations).toBe(1); // the engine's listener only
        expect(man.changes?.listenerCount('change')).toBe(2); // plus ours, raw
        expect(Object.prototype.hasOwnProperty.call(man.changes, 'addListener')).toBe(false);
    });

    it('MECHANISM 1: a document whose decryption throws is seen, reported, and FATAL', async () => {
        // The exact reported symptom: feed attached, health ok, zero documents
        // decrypted and written. `transform-pouch` swallows the rejection, so
        // before the counter existed nothing anywhere observed the loss.
        const { peer, man, internals } = makePeer({
            outgoing: () => Promise.reject(new Error('Decryption with HKDF failed.')),
        });

        // Three documents, because the fatal verdict now needs three distinct
        // failures as well as no foreign decode. A wrong passphrase supplies them
        // by construction: it fails on everything anybody else ever wrote.
        man.emitChange({ seq: '1', doc: remoteDoc('secret.md') });
        man.emitChange({ seq: '2', doc: remoteDoc('secret-2.md') });
        man.emitChange({ seq: '3', doc: remoteDoc('secret-3.md') });
        await flush();

        // The engine's listener never ran, so nothing was dispatched, and the
        // only trace the engine's own plumbing left is a discarded rejection...
        expect(dispatched).toEqual([]);
        expect(man.discarded).toHaveLength(3);
        // ...and yet the loss is visible, which is the entire fix.
        expect(peer.inbound().delivered).toBe(3);
        expect(peer.inbound().decoded).toBe(0);

        // The feed is still attached and would still claim to be watching. Before
        // the ledger, that alone made the peer report ok.
        expect(man.watching).toBe(true);

        vi.advanceTimersByTime(1_001);
        const snap = peer.snapshot();
        expect(snap.ok).toBe(false);
        expect(snap.detail).toContain('decrypted');
        expect(peer.inbound().fatal).toBe(true);

        // And it stops rather than retrying every thirty seconds forever.
        internals.escalateInboundFatal();
        await flush();
        expect(peer.getFatalReason()).toContain('passphrase');
    });

    it('MECHANISM 2: a getByMeta throw above the engine try is reported, not lost', async () => {
        // `getDBEntryFromMeta` returns false for a missing chunk and getByMeta
        // turns that into "Corrupted document". The await sits above the engine's
        // try, so the throw escapes the async listener into a discarded promise.
        const { peer, man } = makePeer({
            getByMeta: () => Promise.reject(new Error('Corrupted document: note.md')),
        });

        man.emitChange({ seq: '1', doc: remoteDoc('note.md') });
        await flush();

        expect(dispatched).toEqual([]);
        expect(man.discarded).toHaveLength(1);
        expect(peer.inbound().decoded).toBe(1);
        expect(peer.inbound().applied).toBe(0);
        expect(peer.snapshot().ok).toBe(true); // inside the window, correctly

        vi.advanceTimersByTime(2_001);
        const snap = peer.snapshot();
        expect(snap.ok).toBe(false);
        expect(snap.detail).toContain('never written');
        // A wedge, not a configuration error: restarting might genuinely fix it.
        expect(peer.inbound().fatal).toBe(false);
    });

    it('MECHANISM 3: a chunk wait that never settles is reported, though it never throws', async () => {
        // The worst of the three: no throw, no rejection, no log line at any
        // level. The engine's change listener simply never completes, while the
        // feed keeps delivering and `watching` stays true.
        const { peer, man } = makePeer({
            getByMeta: () => new Promise(() => {}), // never settles, ever
        });

        man.emitChange({ seq: '1', doc: remoteDoc('note.md') });
        await flush();
        expect(dispatched).toEqual([]);
        expect(man.watching).toBe(true);

        vi.advanceTimersByTime(2_001);
        expect(peer.snapshot().ok).toBe(false);
        expect(peer.inbound().unapplied).toBe(1);
    });

    it('a remote change this peer deliberately ignores does not read as a wedge', async () => {
        // The false-positive guard, wired. `i:` documents are refused by
        // isInterested on purpose (writing one is remote code execution: see
        // types.ts), and a remote with `syncInternalFiles` enabled delivers them
        // constantly. If a refusal counted as a lost document, every such
        // deployment would report itself permanently unhealthy.
        const { peer, man } = makePeer();
        for (let i = 0; i < 5; i += 1) {
            man.emitChange({ seq: String(i), doc: remoteDoc(`i:.obsidian/app-${i}.json`) });
        }
        await flush();

        expect(dispatched).toEqual([]);
        expect(peer.inbound().skipped).toBe(5);
        vi.advanceTimersByTime(60_000);
        expect(peer.snapshot().ok).toBe(true);
        expect(peer.inbound().state).toBe('idle');
    });

    it('a write that fails is counted and logged, and does not advance the checkpoint', async () => {
        const failures: string[] = [];
        const state = new LiveSyncStateStore('test::', {
            file: path.join(tmp.dataDir, 'livesync-state.json'),
            flushDelayMs: 3_600_000,
        });
        const peer = new CouchDBPeer(couchConf(), {
            state,
            dispatch: () => Promise.reject(new Error('vault refused the write')),
            log: (message, level) => {
                if (level === 'error') failures.push(message);
            },
            progress: { decodeGraceMs: 1_000, applyGraceMs: 2_000, deliverGraceMs: 3_000 },
        });
        const man = new FakeManipulator();
        const internals = peer as unknown as PeerInternals;
        internals.man = man;
        internals.connected = true;
        internals.startWatch();

        man.emitChange({ seq: '42', doc: remoteDoc('note.md') });
        await flush();

        expect(peer.inbound().failed).toBe(1);
        // Loud: before this, the engine's own catch logged at a level nothing
        // routes and the reason at a level nothing prints.
        expect(failures.join(' ')).toContain('could not apply a remote change');
        // And the checkpoint did not move, so the change is replayed rather than
        // silently consumed.
        expect(state.getSince()).toBe('');
    });

    it('MECHANISM 5: an attached feed delivering nothing while the remote has work is a wedge', async () => {
        // The case the counters cannot see. `man.watching` is true, no document is
        // lost because none arrives, and the vault falls further behind every
        // minute. This is what the out-of-band _changes probe is for.
        const { peer, internals } = makePeer();
        expect(peer.snapshot().ok).toBe(true);

        internals.progress.setRemotePending(true);
        vi.advanceTimersByTime(3_001);

        const snap = peer.snapshot();
        expect(snap.ok).toBe(false);
        expect(snap.detail).toContain('not delivering');
    });

    it('asks CouchDB for pending changes with the SAME selector the feed uses', async () => {
        // If the probe did not filter chunk documents out, every chunk any client
        // wrote would read as a pending change the feed had not delivered, because
        // the feed's own selector excludes them. A healthy peer would then report
        // itself wedged permanently, which is how a health signal gets ignored.
        const calls: { url: string; init: RequestInit }[] = [];
        vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
            calls.push({ url, init });
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ results: [{ seq: '9' }] }),
            });
        });

        const { internals } = makePeer();
        await expect(internals.probeRemotePending()).resolves.toBe(true);

        expect(calls).toHaveLength(1);
        expect(calls[0].url).toContain('/vault/_changes?');
        expect(calls[0].url).toContain('filter=_selector');
        expect(calls[0].url).toContain('limit=1');
        expect(String(calls[0].init.body)).toContain('leaf');
        // An empty result is the IDLE answer, and must not be confused with the
        // unanswerable one.
        vi.stubGlobal('fetch', () =>
            Promise.resolve({ ok: true, json: () => Promise.resolve({ results: [] }) }),
        );
        await expect(internals.probeRemotePending()).resolves.toBe(false);
    });

    it('treats a probe response it does not understand as no answer, not as "nothing pending"', async () => {
        // Failing towards silence is the one direction this subsystem may not
        // fail in.
        vi.stubGlobal('fetch', () =>
            Promise.resolve({ ok: true, json: () => Promise.resolve({ error: 'nope' }) }),
        );
        const { peer, internals } = makePeer();
        await expect(internals.probeRemotePending()).resolves.toBeUndefined();

        // ...and "no answer" reaches the ledger as no answer, not as a clean
        // `false`. A body this code cannot parse arrives with a 200 and an
        // untouched connection, so it is the easiest of the three unanswerable
        // cases to mistake for health.
        await runProbe(internals);
        vi.advanceTimersByTime(4_001);
        expect(peer.inbound().state).toBe('unobservable');
        expect(peer.snapshot().ok).toBe(false);
    });

    it('FINDING 1: a versioninfo document past the cursor does not wedge the peer forever', async () => {
        /*
         * REGRESSION GUARD FOR FINDING 1, wired end to end.
         *
         * `versioninfo` (id `obsydian_livesync_version`) is written to the REMOTE
         * by upstream's own version negotiation on every version bump. It is a
         * replicated document, not a `_local/` one, so it appears in `_changes`;
         * it passes the feed's `type != leaf` selector, so the feed delivers it;
         * and upstream's `isNoteEntry` drops it, so it never reaches the engine's
         * interest predicate. `syncinfo`, the legacy `notes` type (every document
         * in a vault migrated from an older LiveSync) and `chunkpack` behave the
         * same way.
         *
         * Advance the cursor only for note types and the probe then asks CouchDB
         * for changes from a sequence the feed has already passed, so the answer
         * is "pending" for the life of the process. `snapshot().ok` goes false
         * while `couchReachable()` stays true, which is precisely the combination
         * `HealthTracker` turns into `restartWorthy`, so the peer pair is
         * restarted every cooldown forever, `/healthz/livesync` serves a permanent
         * 503, and the ledger reset on reconnect only restarts the loop. Over a
         * database that is working perfectly.
         *
         * The remote below holds NOTHING past sequence 12, and says so only when
         * asked from 12. Revert the cursor fix and the probe asks from 0, this
         * same healthy remote answers "pending", and the peer wedges.
         */
        const { peer, man, internals } = makePeer();
        man.emitChange({ seq: '12', doc: { _id: 'obsydian_livesync_version', type: 'versioninfo' } });
        await flush();

        // Delivered, so the feed has moved...
        expect(peer.inbound().received).toBe(1);
        expect(internals.progress.getCursor()).toBe('12');
        // ...but it owes no decode receipt, because the engine will never decode
        // it. Counting it as one would open a gap nothing could ever close.
        expect(peer.inbound().delivered).toBe(0);
        expect(peer.inbound().undecodable).toBe(0);
        expect(dispatched).toEqual([]);

        const askedFrom: string[] = [];
        vi.stubGlobal('fetch', (url: string) => {
            const since = new URL(url).searchParams.get('since') ?? '';
            askedFrom.push(since);
            // A remote whose newest document IS the versioninfo at 12.
            const results = since === '12' ? [] : [{ seq: '12' }];
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ results }) });
        });

        await runProbe(internals);
        expect(askedFrom).toEqual(['12']);

        // Well past every window in the ledger, and still not a wedge.
        vi.advanceTimersByTime(60_000);
        expect(peer.inbound().state).toBe('idle');
        expect(peer.inbound().stalled).toBe(false);
        expect(peer.snapshot().ok).toBe(true);
    });

    it('FINDING 2: a probe that never answers takes the peer to unobservable, not to ok', async () => {
        /*
         * REGRESSION GUARD FOR FINDING 2, wired end to end.
         *
         * A reverse proxy that refuses the POST, a CouchDB below 2.0, a dropped
         * connection: none of them is evidence about the changes feed, and none of
         * them may be reported as "fine". This peer's feed is attached and idle,
         * which is exactly the state a silently dead feed also presents, and the
         * probe is the only thing that can tell the two apart.
         *
         * Revert to clearing the clock on an unanswered probe and the peer reports
         * `idle` with `ok: true` here, which is the original bug with a different
         * trigger.
         */
        const { peer, internals } = makePeer();
        vi.stubGlobal('fetch', () => Promise.reject(new Error('502 Bad Gateway from the reverse proxy')));

        await runProbe(internals);
        // One failed request is a blip, not a verdict.
        expect(peer.snapshot().ok).toBe(true);

        vi.advanceTimersByTime(4_001);
        const v = peer.inbound();
        expect(v.state).toBe('unobservable');
        expect(v.stalled).toBe(true);
        expect(v.fatal).toBe(false);
        const snap = peer.snapshot();
        expect(snap.ok).toBe(false);
        // Not 'watching', which is the single most misleading thing this peer
        // could say while it cannot tell whether it is receiving anything.
        expect(snap.detail).not.toBe('watching');
    });

    it('FINDING 2: the "probe is not answering" notice is rate-limited, never latched off', async () => {
        /*
         * The other half of Finding 2. The previous code demoted every repeat to
         * `debug` with a boolean that was never cleared, so a permanently broken
         * probe wrote one line at boot and then nothing for the life of the
         * process: an operator reading the log during an incident found no trace
         * of a subsystem that had been blind since it started.
         *
         * Revert to the latch and the third assertion fails: the notice count
         * stays at one forever.
         */
        const notices: string[] = [];
        const { internals } = makePeer({}, (message, level) => {
            if (level === 'notice') notices.push(message);
        });
        vi.stubGlobal('fetch', () => Promise.reject(new Error('502 Bad Gateway')));

        await runProbe(internals);
        expect(notices).toHaveLength(1);

        // A second failure moments later is throttled: a probe fails every 20
        // seconds, and an unthrottled notice would bury the rest of the log.
        vi.advanceTimersByTime(REMOTE_PENDING_INTERVAL_MS);
        await runProbe(internals);
        expect(notices).toHaveLength(1);

        // But it comes back. The condition is still true, so it is still said.
        vi.advanceTimersByTime(600_000);
        await runProbe(internals);
        expect(notices).toHaveLength(2);
        expect(notices[1]).toContain('unobservable');
    });

    it('FINDING 3: one bad document among many good ones degrades the peer, it does not stop it', async () => {
        /*
         * REGRESSION GUARD FOR FINDING 3, wired end to end.
         *
         * 500 documents decrypt and land; one does not. Before the fix that single
         * document made the ledger's verdict FATAL, so the watchdog called
         * markFatal and stop(): the push direction died with it (`requireReady`
         * throws for every put and delete once `fatalReason` is set), the backend
         * was reported down so `restartWorthy` could never become true, and the
         * message told the operator to change a passphrase that 500 documents had
         * just decrypted with. Nothing recovered without a human.
         *
         * Revert the `decoded === 0` requirement on `fatal` and every assertion
         * after the first block fails.
         */
        const badPath = 'unreadable.md';
        const { peer, man, internals } = makePeer({
            outgoing: (doc) =>
                doc.path === badPath
                    ? Promise.reject(new Error('Decryption with HKDF failed.'))
                    : Promise.resolve(doc),
        });
        vi.stubGlobal('fetch', () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));

        // Earn "was healthy once", so the restart machinery is reachable at all.
        expect((await peer.probeHealth()).ok).toBe(true);

        for (let i = 0; i < 500; i += 1) man.emitChange({ seq: String(i), doc: remoteDoc(`note-${i}.md`) });
        await flush(60);
        expect(peer.inbound().applied).toBe(500);

        man.emitChange({ seq: '500', doc: remoteDoc(badPath) });
        await flush();
        expect(peer.inbound().undecodable).toBe(1);
        expect(peer.inbound().decoded).toBe(500);

        vi.advanceTimersByTime(1_001);
        const v = peer.inbound();
        expect(v.state).toBe('degraded');
        expect(v.fatal).toBe(false);
        // A lost document is not "fine", so it still costs the peer its ok signal.
        expect(v.stalled).toBe(true);
        expect(peer.snapshot().ok).toBe(false);
        expect(peer.snapshot().detail).not.toContain('passphrase');

        // The watchdog's escalation looks at this verdict and does nothing.
        internals.escalateInboundFatal();
        await flush();
        expect(peer.getFatalReason()).toBeUndefined();

        // So the PUSH direction is still accepting writes, rather than throwing
        // LiveSyncFatalError at every local edit.
        await expect(peer.put('local.md', { ctime: 1, mtime: 1, size: 3, data: ['abc'] })).resolves.toBe(true);
        expect(man.puts).toEqual(['local.md']);

        /*
         * F3: AND IT IS NOT RESTARTED OVER IT, which is a deliberate change from
         * the first version of this fix rather than a regression in it.
         *
         * The reasoning that made `degraded` restart-worthy was "a restart is the
         * one recovery that can actually work here". Following it through says
         * otherwise: a restart replays from the persisted checkpoint, the
         * checkpoint only advances on a settled document, so the bad document
         * comes back every single time. Each cycle costs a peer-pair teardown and
         * a full offline vault scan through `onConnected`, every five minutes,
         * forever. Worse, the replayed run delivers ONLY that document, which is
         * the sequence F2 documents: it used to measure `decoded === 0` and stop
         * the peer for good.
         *
         * So the condition stays maximally loud (`ok: false`, `stalled`, a 503 on
         * /healthz/livesync, and the state named in the status API) and stops
         * being acted on. `backendUp` stays TRUE, deliberately: CouchDB is up, and
         * saying otherwise to suppress the restart would be a lie in the one field
         * an operator uses to decide whether their server is at fault.
         */
        expect((await peer.probeHealth()).restartWorthy).toBe(false); // stamps the clock
        vi.advanceTimersByTime(RESTART_GRACE_MS + 1);
        const verdict = await peer.probeHealth();
        expect(verdict.ok).toBe(false);
        expect(verdict.backendUp).toBe(true);
        expect(verdict.restartWorthy).toBe(false);
        expect(verdict.restartFutile).toBe(true);
    });

    it('FINDING 3: a remote that decrypts NOTHING is still fatal, and still names the passphrase', async () => {
        // The other side of the same split, and the reason it is a split rather
        // than a demotion. Nothing has ever decoded, which is what a wrong
        // end-to-end passphrase produces and what nothing on the connect path can
        // catch first: the reachability probe is a plain GET and the milestone is
        // a `_local/` document, which transform-pouch refuses to transform at all.
        const { peer, man, internals } = makePeer({
            outgoing: () => Promise.reject(new Error('Decryption with HKDF failed.')),
        });

        for (let i = 0; i < 5; i += 1) man.emitChange({ seq: String(i), doc: remoteDoc(`note-${i}.md`) });
        await flush();
        expect(peer.inbound().decoded).toBe(0);

        vi.advanceTimersByTime(1_001);
        expect(peer.inbound().state).toBe('undecodable');
        expect(peer.inbound().fatal).toBe(true);

        internals.escalateInboundFatal();
        await flush();
        expect(peer.getFatalReason()).toContain('passphrase');
    });

    // -----------------------------------------------------------------------
    // F1: a vault that refuses every write
    // -----------------------------------------------------------------------

    it('F1: a peer whose every write throws is reported unhealthy, not idle', async () => {
        /*
         * REGRESSION GUARD FOR F1, wired end to end.
         *
         * The real trigger is mundane and total: the vault volume fills (ENOSPC),
         * a Docker volume remounts read-only, a uid change makes every write
         * EACCES. Every remote change decodes, the storage peer throws, the peer
         * counts and logs it, and the checkpoint correctly does not advance. But
         * a failure SETTLES the ledger and `unappliedCount()` subtracts it, so
         * before this fix the verdict was `idle`, `stalled: false`,
         * `snapshot().ok` was true and `/healthz/livesync` served 200 with
         * nothing in the UI.
         *
         * Revert the `failedSince` clock and the block after the window fails:
         * the state comes back 'idle' and `ok` comes back true.
         */
        const { peer, man } = makePeer({}, { dispatch: () => Promise.reject(new Error('ENOSPC: no space left')) });

        for (let i = 0; i < 20; i += 1) man.emitChange({ seq: String(i), doc: remoteDoc(`note-${i}.md`) });
        await flush(40);

        // Everything arrived and decoded; nothing landed.
        expect(peer.inbound().decoded).toBe(20);
        expect(peer.inbound().failed).toBe(20);
        expect(peer.inbound().applied).toBe(0);
        // The feed is attached and would still claim to be watching, which is why
        // nothing upstream of the ledger could see this.
        expect(man.watching).toBe(true);

        vi.advanceTimersByTime(5_001);
        const v = peer.inbound();
        expect(v.state).toBe('unwritable');
        expect(v.stalled).toBe(true);
        const snap = peer.snapshot();
        expect(snap.ok).toBe(false);
        expect(snap.detail).not.toBe('watching');
        expect(snap.detail).toContain('failed to write');
        // And the peer is not restarted over it: a full volume is not a CouchDB
        // problem, and a rebuilt peer pair meets the same disk.
        expect(snap.restartFutile).toBe(true);
    });

    it('F1: one successful write clears the condition, without a restart', async () => {
        // Recovery has to be automatic: an operator who frees disk space should
        // not also have to restart the backend. The clock is cleared by the first
        // write that lands, which is the same "evidence of progress" rule every
        // other clock in the ledger follows.
        const failing = { value: true };
        const { peer, man } = makePeer(
            {},
            {
                dispatch: () =>
                    failing.value ? Promise.reject(new Error('ENOSPC: no space left')) : Promise.resolve(true),
            },
        );

        man.emitChange({ seq: '1', doc: remoteDoc('a.md') });
        await flush();
        vi.advanceTimersByTime(5_001);
        expect(peer.inbound().state).toBe('unwritable');

        failing.value = false;
        man.emitChange({ seq: '2', doc: remoteDoc('b.md') });
        await flush();
        expect(peer.inbound().state).toBe('idle');
        expect(peer.snapshot().ok).toBe(true);
    });

    // -----------------------------------------------------------------------
    // F5: `applied` means a write landed
    // -----------------------------------------------------------------------

    it('F5: a write the storage peer REFUSES is counted as ignored, not as applied', async () => {
        /*
         * REGRESSION GUARD FOR F5, wired.
         *
         * `StoragePeer.put` returns false WITHOUT throwing on four paths: an
         * excluded vault path, one that fails `resolveInVault`, one that resolves
         * to the vault root, and an echo of our own push. A remote carrying
         * `.trash/note.md` or any vault dotfile as a plain document takes one of
         * them on every replication. The boolean was awaited and discarded, so all
         * of it counted as `applied`, which disagrees with `applied.pulled` in the
         * status API: that counter is incremented from the same boolean in
         * `dispatchToStorage`, and the two came from it on one side only.
         *
         * The CHECKPOINT still advances, deliberately: a refused path replayed
         * forever would pin the feed at that sequence. Only the classification
         * changes.
         *
         * Revert the `if (applied) ... else ...` split and the first two
         * assertions fail.
         */
        const { peer, man, state } = makePeer({}, { dispatch: () => Promise.resolve(false) });

        man.emitChange({ seq: '77', doc: remoteDoc('.trash/note.md') });
        await flush();

        expect(peer.inbound().applied).toBe(0);
        expect(peer.inbound().skipped).toBe(1);
        expect(peer.inbound().failed).toBe(0);
        // Advanced, so the same refused document is not replayed forever.
        expect(state.getSince()).toBe('77');
        // And a refusal is a terminal outcome, so the peer stays healthy.
        vi.advanceTimersByTime(60_000);
        expect(peer.inbound().state).toBe('idle');
        expect(peer.snapshot().ok).toBe(true);
    });

    it('F5: a write that DOES land is still counted as applied', async () => {
        // The control for the line above: the split must not have turned every
        // write into a skip.
        const { peer, man } = makePeer();
        man.emitChange({ seq: '5', doc: remoteDoc('note.md') });
        await flush();
        expect(peer.inbound().applied).toBe(1);
        expect(peer.inbound().skipped).toBe(0);
    });

    // -----------------------------------------------------------------------
    // F4: a wedged document survives a stream of settled ones
    // -----------------------------------------------------------------------

    it('F4: a wedged document is still detected while internal documents stream past', async () => {
        /*
         * REGRESSION GUARD FOR F4, wired against the real masking stream.
         *
         * `i:` internal-file documents are note-typed (upstream puts them as
         * plain/newnote), so a remote with `syncInternalFiles` on delivers them
         * constantly; they decode, `isInterested` refuses them, and each refusal
         * used to restamp the apply clock to now. So mechanism 3 (a chunk wait
         * with no route to resolution) became undetectable on the DEFAULT
         * deployment while remaining perfectly detectable in isolation, which is
         * the worst possible split for a health instrument.
         *
         * Revert `PendingClock` to one restamped timestamp and the last block
         * fails: the state comes back 'flowing' and `ok` comes back true.
         */
        const { peer, man } = makePeer({
            getByMeta: (doc) =>
                doc.path === 'wedged.md'
                    ? new Promise(() => {}) // never settles, ever
                    : Promise.resolve({ ...doc, data: ['content'] }),
        });

        man.emitChange({ seq: '1', doc: remoteDoc('wedged.md') });
        await flush();
        expect(peer.inbound().unapplied).toBe(1);

        // The masking stream, spread across more than the apply window.
        for (let i = 0; i < 10; i += 1) {
            man.emitChange({ seq: String(100 + i), doc: remoteDoc(`i:.obsidian/workspace-${i}.json`) });
            await flush();
            vi.advanceTimersByTime(300);
        }
        expect(peer.inbound().skipped).toBe(10);

        const v = peer.inbound();
        expect(v.unapplied).toBe(1);
        expect(v.state).toBe('unapplied');
        expect(peer.snapshot().ok).toBe(false);
    });

    // -----------------------------------------------------------------------
    // F6: deliveries answer the probe's question
    // -----------------------------------------------------------------------

    it('F6: documents arriving keep the peer healthy even while the probe is refused', async () => {
        /*
         * REGRESSION GUARD FOR F6, wired.
         *
         * A reverse proxy refusing the probe's POST is not evidence about the
         * feed, and a feed that is visibly delivering is the strongest possible
         * evidence that it is alive. Before the one-line fix, `noteFeedChange`
         * cleared the remote-pending clock and not the probe clock, so a peer
         * receiving, decoding and applying documents throughout still resolved to
         * `unobservable`, `stalled: true`, `ok: false`.
         *
         * Revert the `probeUnansweredSince` clear in `noteFeedChange` and the two
         * assertions after the deliveries fail.
         */
        const { peer, man, internals } = makePeer();
        vi.stubGlobal('fetch', () => Promise.reject(new Error('502 Bad Gateway from the reverse proxy')));

        await runProbe(internals);
        vi.advanceTimersByTime(3_999);
        // One document, arriving just before the probe window would have expired.
        man.emitChange({ seq: '1', doc: remoteDoc('note.md') });
        await flush();
        expect(peer.inbound().applied).toBe(1);

        vi.advanceTimersByTime(3_999);
        expect(peer.inbound().state).toBe('idle');
        expect(peer.snapshot().ok).toBe(true);
    });

    // -----------------------------------------------------------------------
    // F2: a restart must not re-read a partial failure as a total one
    // -----------------------------------------------------------------------

    it('F2: the peer a restart builds does not call the same bad document a wrong passphrase', async () => {
        /*
         * REGRESSION GUARD FOR F2, wired across the restart it describes.
         *
         * The first peer decrypts 500 documents and lands them, so the checkpoint
         * reaches 499; the document at 500 never decrypts, which is `degraded`.
         * The pair is then rebuilt (a fresh `CouchDBPeer` over the SAME state
         * store, which is exactly what `maybeRestart` produces), the feed resumes
         * from 499, and the remote has exactly one document to hand back: the bad
         * one. That run decodes NOTHING.
         *
         * With the fatal test written against the per-run counter, the restarted
         * peer stopped itself and told the operator to check a passphrase that had
         * decrypted 500 documents ninety seconds earlier; `requireReady` then
         * refused every push and `couchReachable()` returned false forever, so
         * nothing restarted it again. So the fix to F3 bought about two minutes
         * and one full vault rescan before landing in the identical terminal state
         * it was written to remove.
         *
         * Revert `!this.everDecoded` to `counts.decoded === 0` and the second
         * block fails: the restarted peer is fatal and names the passphrase.
         */
        const badPath = 'unreadable.md';
        const decryptExcept = (doc: Record<string, unknown>) =>
            doc.path === badPath
                ? Promise.reject(new Error('Decryption with HKDF failed.'))
                : Promise.resolve(doc);

        const state = makeState();
        const first = makePeer({ outgoing: decryptExcept }, { state });
        for (let i = 0; i < 500; i += 1) {
            first.man.emitChange({ seq: String(i), doc: remoteDoc(`note-${i}.md`) });
        }
        await flush(60);
        first.man.emitChange({ seq: '500', doc: remoteDoc(badPath) });
        await flush();
        expect(first.peer.inbound().decoded).toBe(500);
        expect(state.getSince()).toBe('499'); // the bad document did not advance it

        // The restart. A fresh peer over the same persisted state, replaying only
        // what sits past the checkpoint.
        const second = makePeer({ outgoing: decryptExcept }, { state });
        second.man.emitChange({ seq: '500', doc: remoteDoc(badPath) });
        await flush();
        expect(second.peer.inbound().decoded).toBe(0); // the run really did decode nothing
        expect(second.peer.inbound().delivered).toBe(1);

        vi.advanceTimersByTime(1_001);
        const v = second.peer.inbound();
        expect(v.state).toBe('degraded');
        expect(v.fatal).toBe(false);
        second.internals.escalateInboundFatal();
        await flush();
        expect(second.peer.getFatalReason()).toBeUndefined();

        // Still loud, and the push direction still works, which is what being
        // non-fatal is for.
        expect(v.stalled).toBe(true);
        expect(second.peer.snapshot().ok).toBe(false);
        await expect(
            second.peer.put('local.md', { ctime: 1, mtime: 1, size: 3, data: ['abc'] }),
        ).resolves.toBe(true);
    });

    it('F2: a CHANGED passphrase that decrypts nothing is still fatal, and still names it', async () => {
        /*
         * THE CONTROL FOR F2, and the case the persisted evidence must not
         * swallow. An operator changing the passphrase to a wrong one has to trip
         * the fatal verdict, or the peer reports `degraded` forever while the push
         * direction keeps writing documents encrypted with a key no other client
         * has. The evidence is therefore fingerprinted by key material and remote,
         * so a different passphrase reads as no evidence at all.
         */
        const state = makeState();
        const good = makePeer({}, { state, conf: { passphrase: 'the right one' } });
        good.man.emitChange({ seq: '1', doc: remoteDoc('note.md') });
        await flush();
        expect(good.peer.inbound().decoded).toBe(1);

        const wrong = makePeer(
            { outgoing: () => Promise.reject(new Error('Decryption with HKDF failed.')) },
            { state, conf: { passphrase: 'the wrong one' } },
        );
        // The changed passphrase also discards the FAILURE record, not just the
        // decode receipt, so this peer starts counting from zero and has to reach
        // the quorum on its own. That is the point of fingerprinting both halves:
        // failures under the old passphrase are evidence about the old passphrase.
        wrong.man.emitChange({ seq: '2', doc: remoteDoc('note.md') });
        wrong.man.emitChange({ seq: '3', doc: remoteDoc('note-2.md') });
        wrong.man.emitChange({ seq: '4', doc: remoteDoc('note-3.md') });
        await flush();
        vi.advanceTimersByTime(1_001);
        expect(wrong.peer.inbound().state).toBe('undecodable');
        expect(wrong.peer.inbound().fatal).toBe(true);
        wrong.internals.escalateInboundFatal();
        await flush();
        expect(wrong.peer.getFatalReason()).toContain('passphrase');
    });

    it('F2: a brand new peer against a wrong passphrase is fatal on its very first run', async () => {
        // The other control, and the one the whole fatal branch exists for. There
        // is no persisted evidence, so the "nothing has ever decrypted" reading is
        // exactly right and the peer stops.
        const { peer, man, internals, state } = makePeer({
            outgoing: () => Promise.reject(new Error('Decryption with HKDF failed.')),
        });
        expect(state.getSince()).toBe(''); // nothing has ever been consumed

        man.emitChange({ seq: '1', doc: remoteDoc('note.md') });
        man.emitChange({ seq: '2', doc: remoteDoc('note-2.md') });
        man.emitChange({ seq: '3', doc: remoteDoc('note-3.md') });
        await flush();
        vi.advanceTimersByTime(1_001);
        expect(peer.inbound().fatal).toBe(true);
        internals.escalateInboundFatal();
        await flush();
        expect(peer.getFatalReason()).toContain('passphrase');
    });

    // -----------------------------------------------------------------------
    // D1 (CouchDB half): a push that threw must be retried, not answered with
    // the claim its own failed attempt left behind
    // -----------------------------------------------------------------------

    it('D1: a CouchDB write that threw is genuinely re-attempted, not swallowed as an echo', async () => {
        /*
         * REGRESSION GUARD FOR DEFECT 1, THE HALF THAT LIVES ON THIS SIDE OF THE
         * PAIR, and the reason fixing the storage peer alone would have moved the
         * loss one layer down rather than removing it.
         *
         * The suppressor used to record the content hash as a side effect of the
         * "is this an echo?" question, on the MISS path, i.e. before the write it
         * describes had happened. So a push that threw (CouchDB unreachable
         * mid-write, a 401 after a credential rotation) left behind a claim that
         * these exact bytes had already gone out. `StoragePeer.processPath` reacts
         * to a throw by leaving the file's baseline unadvanced precisely so the
         * next offline scan retries it, and that retry arrived here, matched the
         * claim, and returned `false` WITHOUT THROWING. A non-throwing dispatch is
         * what `processPath` treats as delivered, so it advanced the baseline and
         * the file was marked synced having never reached CouchDB. No scan looks
         * at it again.
         *
         * The two assertions that matter are the second `put` resolving TRUE and
         * `man.puts` containing the path: both say the retry reached the network.
         * Revert `hasSeen`/`remember` here to the old record-on-miss and the second
         * put resolves `false` with `man.puts` empty.
         */
        const { peer, man } = makePeer();
        const data: FileData = { ctime: 1, mtime: 1, size: 3, data: ['abc'] };

        let failNext = true;
        const put: PutFn = (p: string) => {
            if (failNext) {
                failNext = false;
                return Promise.reject(new Error('socket hang up'));
            }
            man.puts.push(p);
            return Promise.resolve(true);
        };
        man.put = put;

        // The outage. A throw is the contract: the caller must not record this
        // file as synced.
        await expect(peer.put('note.md', data)).rejects.toThrow(/CouchDB put failed/);
        expect(man.puts).toEqual([]);

        // CouchDB is back, and the scan retries the same bytes at the same path.
        await expect(peer.put('note.md', data)).resolves.toBe(true);
        expect(man.puts).toEqual(['note.md']);
    });

    it('D1 CONTROL: a push that SUCCEEDED still does not bounce back off the feed', async () => {
        /*
         * The other half of the invariant, and the reason the fix could not simply
         * be "stop recording": a write that WAS pushed must never come back as a
         * new change. The feed hands our own document back within milliseconds of
         * every push, and without suppression it would be dispatched to the vault,
         * rewritten there, observed by the watcher, and pushed again.
         *
         * `getByMeta` is overridden so the document that comes back down carries
         * the bytes that went up; the suppressor hashes content only, so that is
         * what makes this the same change rather than a different one.
         */
        const bytes = 'abc';
        const { peer, man } = makePeer({
            getByMeta: (doc) => Promise.resolve({ ...doc, data: [bytes] }),
        });
        const data: FileData = { ctime: 1, mtime: 1, size: bytes.length, data: [bytes] };

        await expect(peer.put('note.md', data)).resolves.toBe(true);
        expect(man.puts).toEqual(['note.md']);

        // ...and here it comes back down the changes feed, as it always does.
        man.emitChange({ seq: '1', doc: remoteDoc('note.md') });
        await flush();
        expect(dispatched).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // D4: the decode receipt is evidence about the CONFIGURATION, and a peer
    // can always decrypt what it encrypted itself
    // -----------------------------------------------------------------------

    it('D4: a fresh peer with a WRONG passphrase is still fatal after pushing one local note', async () => {
        /*
         * REGRESSION GUARD FOR THE DEFECT THIS SECTION EXISTS FOR, driven as the
         * scenario that actually produces it: somebody setting up a new device
         * and mistyping the passphrase.
         *
         * The receipt used to be taken in the interest predicate, which is
         * reached by any document that decrypts at all. A peer can always decrypt
         * what it encrypted itself, so ONE local push echoing back off the feed
         * satisfied it. Measured: `everDecoded` set, the wrong passphrase's
         * fingerprint persisted to disk, and from then on the fatal branch in
         * `progress.verdict()` (which requires `!everDecoded`) could never fire
         * again, on this run or any later one. The peer settled at `degraded`
         * forever, served 503 with a message describing a bad document rather
         * than a bad passphrase, and kept pushing chunks no other client in the
         * cluster could read.
         *
         * `outgoing` below is precisely what a wrong passphrase does: our own
         * document decrypts, everybody else's does not.
         *
         * Move the receipt back into the interest predicate and the last four
         * assertions fail: the state is `degraded`, `fatal` is false,
         * `getFatalReason()` is undefined, and the fingerprint is on disk.
         */
        const ours = 'the one unsynced note on this brand new device';
        const wrong = { passphrase: 'hunter2-with-a-typo' };
        const { peer, man, internals, state } = makePeer(
            {
                outgoing: (doc) =>
                    doc.path === 'local.md'
                        ? Promise.resolve(doc)
                        : Promise.reject(new Error('Decryption with HKDF failed.')),
                getByMeta: (doc) => Promise.resolve({ ...doc, data: [ours] }),
            },
            { conf: wrong },
        );
        expect(state.hasDecodedWith(evidenceKey(wrong))).toBe(false); // nothing behind it

        // The offline scan finds the one unsynced note and pushes it.
        await expect(
            peer.put('local.md', { ctime: 1, mtime: 1, size: ours.length, data: [ours] }),
        ).resolves.toBe(true);

        // ...and here it comes straight back down the feed, as it always does. It
        // decrypts, because we encrypted it. That is the whole trap.
        man.emitChange({ seq: '1', doc: remoteDoc('local.md') });
        await flush();
        expect(peer.inbound().decoded).toBe(1);
        expect(dispatched).toEqual([]); // recognised as our own, correctly

        // The documents already on the cluster, written by clients that used the
        // RIGHT passphrase. Twelve, as in the measured run: a wrong passphrase
        // fails on the whole cluster rather than on one document, which is exactly
        // why the quorum costs this case nothing.
        for (let i = 0; i < 12; i += 1) {
            man.emitChange({ seq: String(i + 2), doc: remoteDoc(`somebody-else-${i}.md`) });
        }
        await flush();
        vi.advanceTimersByTime(1_001);

        const v = peer.inbound();
        expect(v.state).toBe('undecodable');
        expect(v.fatal).toBe(true);
        // The contradiction that used to be printable, now resolved in the data
        // rather than only in the prose: one change decrypted here, and it was
        // this peer's own, so the count that is evidence stays zero.
        expect(v.decoded).toBe(1);
        expect(v.foreignDecoded).toBe(0);
        internals.escalateInboundFatal();
        await flush();
        expect(peer.getFatalReason()).toContain('passphrase');
        // And it says which count it decided on, and does not claim the one
        // successful decryption never happened.
        expect(peer.getFatalReason()).toContain('another client');
        expect(peer.getFatalReason()).toContain("this peer's own writes");
        // And nothing was written down as a DECODE, so a restart cannot adopt
        // evidence this run never earned...
        expect(state.hasDecodedWith(evidenceKey(wrong))).toBe(false);
        // ...while what it did earn, the failures, is written down, so a restart
        // reaches the same verdict without waiting for a redelivery its own
        // checkpoint may already have passed.
        expect(state.getUndecodableWith(evidenceKey(wrong))).toHaveLength(3);
    });

    it('D4: a peer that only RECEIVES still earns the receipt, on the first document it sees', async () => {
        /*
         * THE FALSE-POSITIVE GUARD, and the reason the fix cannot simply be "stop
         * taking the receipt on the inbound path". A read-only replica pushes
         * nothing, so every document it ever sees is somebody else's, and it must
         * be able to establish that its passphrase works. Without that, the first
         * undecryptable document anywhere in the cluster would stop it and blame
         * a passphrase that had been decrypting all day.
         *
         * `EchoSuppressor`'s ordering is what makes this hold rather than a
         * special case for it: `hasSeen` is a pure query and `remember` runs
         * after the dispatch, so a document's FIRST arrival is always a miss,
         * whether or not this peer has ever written anything.
         */
        const right = { passphrase: 'the right one' };
        const { peer, man, state } = makePeer(
            {
                outgoing: (doc) =>
                    doc.path === 'unreadable.md'
                        ? Promise.reject(new Error('Decryption with HKDF failed.'))
                        : Promise.resolve(doc),
            },
            { conf: right },
        );

        man.emitChange({ seq: '1', doc: remoteDoc('from-another-client.md') });
        await flush();
        expect(dispatched).toEqual(['put from-another-client.md']);
        expect(man.puts).toEqual([]); // it has never pushed anything, ever
        expect(state.hasDecodedWith(evidenceKey(right))).toBe(true);

        // ...so one document that will not decrypt is a lost document rather than
        // a broken configuration, and the peer stays up.
        man.emitChange({ seq: '2', doc: remoteDoc('unreadable.md') });
        await flush();
        vi.advanceTimersByTime(1_001);
        const v = peer.inbound();
        expect(v.state).toBe('degraded');
        expect(v.fatal).toBe(false);
        expect(v.detail).not.toContain('passphrase');
    });

    it('D4: the echo suppressor still suppresses, and still lets a real change through', async () => {
        /*
         * THE INVARIANT GUARD. The receipt now hangs off the suppressor's
         * verdict, so the change must not have moved that verdict. The contract
         * `EchoSuppressor` states is two-sided: a write that WAS passed on must
         * never come back as a new change, and a write that was never
         * successfully passed on must always be retried. The first half is
         * asserted here at the feed; the second is 'D1: a CouchDB write that
         * threw is genuinely re-attempted' above, which still passes untouched.
         *
         * The last two assertions are the ones that catch an over-eager fix.
         * Suppressing by PATH alone, which is the obvious way to make "is this
         * ours?" cheap, would swallow every later revision of a file this peer
         * once pushed: the vault would silently stop receiving edits to exactly
         * the files it edits most, and the evidence would never be earned either.
         */
        let body = 'the bytes we pushed';
        const { peer, man, state } = makePeer({
            getByMeta: (doc) => Promise.resolve({ ...doc, data: [body] }),
        });

        await expect(
            peer.put('note.md', { ctime: 1, mtime: 1, size: body.length, data: [body] }),
        ).resolves.toBe(true);
        man.emitChange({ seq: '1', doc: remoteDoc('note.md') });
        await flush();
        expect(dispatched).toEqual([]);
        expect(state.hasDecodedWith(evidenceKey())).toBe(false);

        // Another client edits the same file. Same path, different content, and
        // nothing about it is an echo of anything.
        body = 'what somebody else wrote over it';
        man.emitChange({ seq: '2', doc: remoteDoc('note.md') });
        await flush();
        expect(dispatched).toEqual(['put note.md']);
        expect(state.hasDecodedWith(evidenceKey())).toBe(true);
    });

    it('D4: an unwritable vault cannot turn the next bad document into a passphrase verdict', async () => {
        /*
         * THE ORDERING ASSERTION, and the reason the receipt is taken BEFORE the
         * dispatch while `remember` is recorded after it. The two sit either side
         * of one call, so the symmetry is inviting and it is wrong: `remember` is
         * a CLAIM about an operation and must wait for the operation to succeed
         * (state.ts records the data loss that claiming early caused), while the
         * receipt is an OBSERVATION about something that already happened, since
         * the document decrypted before `onRemoteChange` was ever called and no
         * later failure can un-decrypt it.
         *
         * Taking it on the success path instead would let a vault that cannot be
         * written to (a full disk, a volume remounted read-only) withhold the
         * evidence, and the next undecryptable document would then escalate
         * `unwritable`, which is transient and non-fatal, into the passphrase
         * verdict, which stops the peer, takes the push direction down with it
         * and needs a human. Two independent faults must not compound into a
         * third diagnosis that is wrong about both.
         *
         * Move `noteForeignDecode()` below the dispatch in `onRemoteChange` and
         * the last three assertions fail.
         */
        const { peer, man, state } = makePeer(
            {
                outgoing: (doc) =>
                    doc.path === 'unreadable.md'
                        ? Promise.reject(new Error('Decryption with HKDF failed.'))
                        : Promise.resolve(doc),
            },
            { dispatch: () => Promise.reject(new Error('ENOSPC: no space left on device')) },
        );

        man.emitChange({ seq: '1', doc: remoteDoc('from-another-client.md') });
        await flush();
        expect(peer.inbound().failed).toBe(1); // it decrypted; the vault refused it
        expect(state.hasDecodedWith(evidenceKey())).toBe(true);

        man.emitChange({ seq: '2', doc: remoteDoc('unreadable.md') });
        await flush();
        vi.advanceTimersByTime(1_001);
        expect(peer.inbound().state).toBe('degraded');
        expect(peer.inbound().fatal).toBe(false);
    });

    // -----------------------------------------------------------------------
    // D5: the fatal bar is a QUANTITY of foreign evidence, wired end to end
    //
    // The five cases the design was written against, driven through the feed
    // rather than through the ledger, because the regression they guard was
    // reachable only once D4 had correctly narrowed the receipt: the ledger
    // change and the peer change are only wrong TOGETHER.
    // -----------------------------------------------------------------------

    /** Deterministic bytes per path, so a push and its echo hash equal. */
    const bodyFor = (p: string) => `the contents of ${p}`;

    it('D5 CASE 2: a CORRECT peer with only its own echoes behind it survives one bad stranger', async () => {
        /*
         * REGRESSION GUARD FOR THE MEASURED REGRESSION, wired.
         *
         * Measured before the quorum: `{ state: 'undecodable', fatal: true,
         * decoded: 4, undecodable: 1 }`, permanent 503, `connected` false, the push
         * direction stopped, and the peer's next local write never reaching
         * CouchDB. On a peer whose passphrase was correct.
         *
         * The four decodes are its own pushes echoing back, which is why it holds
         * no foreign receipt: that is D4 working, not D4 failing. What was missing
         * was any bar on the other side of the conjunction.
         *
         * Drop the `distinct >= quorum` term and the four assertions after the
         * verdict block fail: the peer is fatal, disconnected, and refuses the
         * final put with LiveSyncFatalError.
         */
        const { peer, man, internals, state } = makePeer({
            outgoing: (doc) =>
                doc.path === 'unreadable.md'
                    ? Promise.reject(new Error('Decryption with HKDF failed.'))
                    : Promise.resolve(doc),
            getByMeta: (doc) => Promise.resolve({ ...doc, data: [bodyFor(String(doc.path))] }),
        });
        vi.stubGlobal('fetch', () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
        // Earn "was healthy once", so the restart machinery is reachable at all and
        // the assertions at the end are about this verdict rather than about a peer
        // that was never up.
        expect((await peer.probeHealth()).ok).toBe(true);

        // Four local notes pushed, each echoing straight back off the feed.
        for (let i = 0; i < 4; i += 1) {
            const p = `mine-${i}.md`;
            const body = bodyFor(p);
            await expect(peer.put(p, { ctime: 1, mtime: 1, size: body.length, data: [body] })).resolves.toBe(true);
            man.emitChange({ seq: String(i), doc: remoteDoc(p) });
        }
        await flush();
        expect(peer.inbound().decoded).toBe(4);
        expect(dispatched).toEqual([]); // all four recognised as our own, correctly
        expect(state.hasDecodedWith(evidenceKey())).toBe(false); // and none is evidence

        // One document from another client, which happens not to decrypt.
        man.emitChange({ seq: '9', doc: remoteDoc('unreadable.md') });
        await flush();
        vi.advanceTimersByTime(1_001);

        const v = peer.inbound();
        expect(v.state).toBe('unproven');
        expect(v.fatal).toBe(false);
        expect(v.decoded).toBe(4);
        expect(v.foreignDecoded).toBe(0);
        expect(v.undecodableDistinct).toBe(1);
        // Loud, deliberately: a document really is missing from the vault, so the
        // peer keeps costing itself its ok signal and answering 503.
        expect(v.stalled).toBe(true);
        expect(peer.snapshot().ok).toBe(false);

        // The watchdog's escalation reads this verdict and does nothing.
        internals.escalateInboundFatal();
        await flush();
        expect(peer.getFatalReason()).toBeUndefined();

        // `backendUp` stays TRUE, which is the field that used to go false and take
        // the recovery path with it: a fatal peer reports its backend down by
        // design, so `restartWorthy` could never become true again and nothing
        // would ever have restarted this peer.
        const health = await peer.probeHealth();
        expect(health.ok).toBe(false);
        expect(health.backendUp).toBe(true);
        expect(health.restartFutile).toBe(true);

        // ...so the next local write still reaches CouchDB, which is the sentence
        // the whole change is about.
        const body = bodyFor('after.md');
        await expect(peer.put('after.md', { ctime: 2, mtime: 2, size: body.length, data: [body] })).resolves.toBe(
            true,
        );
        expect(man.puts).toContain('after.md');
    });

    it('D5 CASE 4: the first peer into an empty cluster is never punished for having read nothing', async () => {
        /*
         * The reason `everDecoded === false` must never be a problem on its own.
         *
         * A brand new peer against an empty database has no foreign receipt and
         * cannot get one, because there is nothing to receive. It pushes its vault,
         * every document echoes back, and none of the echoes is evidence. The
         * decode branch is never ENTERED, because it requires a document that
         * failed, so the peer is `idle` and healthy throughout.
         */
        const { peer, man, state } = makePeer({
            getByMeta: (doc) => Promise.resolve({ ...doc, data: [bodyFor(String(doc.path))] }),
        });

        for (let i = 0; i < 30; i += 1) {
            const p = `note-${i}.md`;
            const body = bodyFor(p);
            await expect(peer.put(p, { ctime: 1, mtime: 1, size: body.length, data: [body] })).resolves.toBe(true);
            man.emitChange({ seq: String(i), doc: remoteDoc(p) });
        }
        await flush(60);
        vi.advanceTimersByTime(10_000);

        const v = peer.inbound();
        expect(v.state).toBe('idle');
        expect(v.stalled).toBe(false);
        expect(v.fatal).toBe(false);
        expect(v.undecodable).toBe(0);
        expect(v.foreignDecoded).toBe(0); // it has genuinely proven nothing...
        expect(peer.snapshot().ok).toBe(true); // ...and that costs it nothing
        expect(state.hasDecodedWith(evidenceKey())).toBe(false);
    });

    it('D5 CASE 5: two peers sharing one wrong passphrase read each other, and neither stops', async () => {
        /*
         * NOT A HOLE, AND WORTH ASSERTING SO IT IS NOT "FIXED" LATER. "Wrong" is
         * only ever defined relative to other clients, and an encryption key has no
         * external referent a process can check. Two peers that can read each
         * other's documents are a working cluster with an unusual passphrase, and
         * each is genuinely foreign to the other: the suppressor has never seen the
         * other's bytes at that path, so the receipt is granted for the right
         * reason rather than by accident.
         *
         * The interesting sub-case is the one asserted at the end: a correctly
         * keyed client's documents then fail on this peer, which is real loss and
         * is reported as `degraded` rather than as a broken configuration, because
         * this peer's passphrase demonstrably decrypts something somebody else
         * wrote. That is the design working as specified.
         */
        const shared = { passphrase: 'the same typo on both devices' };
        const { peer, man, internals, state } = makePeer(
            {
                outgoing: (doc) =>
                    String(doc.path).startsWith('real-client-')
                        ? Promise.reject(new Error('Decryption with HKDF failed.'))
                        : Promise.resolve(doc),
            },
            { conf: shared },
        );

        // The other device, which shares this one's passphrase, writes a note.
        man.emitChange({ seq: '1', doc: remoteDoc('from-the-other-device.md') });
        await flush();
        expect(dispatched).toEqual(['put from-the-other-device.md']);
        expect(peer.inbound().foreignDecoded).toBe(1);
        expect(state.hasDecodedWith(evidenceKey(shared))).toBe(true);

        // And now the rest of the cluster, which does not.
        for (let i = 0; i < 12; i += 1) man.emitChange({ seq: String(i + 2), doc: remoteDoc(`real-client-${i}.md`) });
        await flush();
        vi.advanceTimersByTime(1_001);

        const v = peer.inbound();
        expect(v.state).toBe('degraded');
        expect(v.fatal).toBe(false);
        expect(v.detail).not.toContain('passphrase');
        internals.escalateInboundFatal();
        await flush();
        expect(peer.getFatalReason()).toBeUndefined();
    });

    it('D5: the failure count survives the restart that the peer\'s own echo would otherwise erase', async () => {
        /*
         * THE CROSS-RUN GUARANTEE, wired, and the reason the count is persisted
         * rather than rebuilt from a replay.
         *
         * The peer cannot read two documents. It also pushes a local note, whose
         * echo decodes, APPLIES, and carries the checkpoint past both of them (the
         * apply callback advances `since` from the change's own sequence whatever
         * the dispatch returned). A restart therefore resumes past the backlog and
         * is handed none of it back. Without the persisted count the fresh run
         * measures zero distinct failures and can never reach the quorum, however
         * many more documents fail later, so the peer reports its way to `idle` and
         * keeps publishing.
         *
         * Revert `undecodableWith` in state.ts, or the adoption in `startWatch`,
         * and the final two assertions fail: the restarted peer is `unproven`.
         */
        const wrong = { passphrase: 'hunter2-with-a-typo' };
        const readable = 'mine.md';
        const opts = {
            outgoing: (doc: Record<string, unknown>) =>
                doc.path === readable
                    ? Promise.resolve(doc)
                    : Promise.reject(new Error('Decryption with HKDF failed.')),
            getByMeta: (doc: Record<string, unknown>) =>
                Promise.resolve({ ...doc, data: [bodyFor(String(doc.path))] }),
        };
        const state = makeState();
        const first = makePeer(opts, { state, conf: wrong });

        first.man.emitChange({ seq: '1', doc: remoteDoc('stranger-a.md') });
        first.man.emitChange({ seq: '2', doc: remoteDoc('stranger-b.md') });
        await flush();
        vi.advanceTimersByTime(1_001);
        expect(first.peer.inbound().state).toBe('unproven');
        expect(first.peer.inbound().fatal).toBe(false);

        // The watchdog's tick, which is where the record is written down.
        first.internals.escalateInboundFatal();
        await flush();
        expect(state.getUndecodableWith(evidenceKey(wrong))).toHaveLength(2);

        // The local note whose echo carries the checkpoint past the backlog.
        const body = bodyFor(readable);
        await expect(
            first.peer.put(readable, { ctime: 1, mtime: 1, size: body.length, data: [body] }),
        ).resolves.toBe(true);
        first.man.emitChange({ seq: '3', doc: remoteDoc(readable) });
        await flush();
        expect(state.getSince()).toBe('3'); // past both unreadable documents, for good

        // The restart. A fresh peer over the same persisted state, resuming from a
        // checkpoint that will never deliver stranger-a or stranger-b again.
        const second = makePeer(opts, { state, conf: wrong });
        second.man.emitChange({ seq: '4', doc: remoteDoc('stranger-c.md') });
        await flush();
        vi.advanceTimersByTime(1_001);

        // One new failure in this run, and two inherited, is the quorum.
        expect(second.peer.inbound().undecodableDistinct).toBe(UNDECODABLE_QUORUM);
        expect(second.peer.inbound().state).toBe('undecodable');
        expect(second.peer.inbound().fatal).toBe(true);
    });

    it('D5: failures recorded under one passphrase are not held against the next one', async () => {
        /*
         * THE OTHER SIDE OF PERSISTENCE, and the reason the record carries its own
         * fingerprint. An operator who corrects a typo must not be stopped by the
         * failures the typo caused: those are evidence about the old passphrase and
         * none at all about the new one. Same rule as `hasDecodedWith`, in the
         * opposite direction.
         */
        const typo = { passphrase: 'hunter2-with-a-typo' };
        const fixed = { passphrase: 'hunter2' };
        const failEverything = { outgoing: () => Promise.reject(new Error('Decryption with HKDF failed.')) };
        const state = makeState();

        const before = makePeer(failEverything, { state, conf: typo });
        before.man.emitChange({ seq: '1', doc: remoteDoc('a.md') });
        before.man.emitChange({ seq: '2', doc: remoteDoc('b.md') });
        await flush();
        vi.advanceTimersByTime(1_001);
        before.internals.escalateInboundFatal();
        await flush();
        expect(state.getUndecodableWith(evidenceKey(typo))).toHaveLength(2);
        expect(state.getUndecodableWith(evidenceKey(fixed))).toEqual([]);

        // The corrected passphrase reads none of that back, so its first bad
        // document is its first bad document.
        const after = makePeer(failEverything, { state, conf: fixed });
        after.man.emitChange({ seq: '3', doc: remoteDoc('c.md') });
        await flush();
        vi.advanceTimersByTime(1_001);
        expect(after.peer.inbound().undecodableDistinct).toBe(1);
        expect(after.peer.inbound().fatal).toBe(false);
    });

    it('D5: the real watchdog reaches the verdict on its own, without a test touching the ledger', async () => {
        /*
         * THE WIRING ASSERTION. The observation that feeds the quorum is taken
         * inside `verdict()` precisely so that it cannot be forgotten at a call
         * site, and this is the test that says so: nothing below reaches into
         * `progress`, and the only thing driven is the timer the peer schedules for
         * itself.
         *
         * A shape that swept from the watchdog instead would pass every ledger test
         * in this file and still ship a detector that never ran.
         */
        vi.stubGlobal('fetch', () => Promise.resolve({ ok: true, json: () => Promise.resolve({ results: [] }) }));
        const { peer, man, internals, state } = makePeer({
            outgoing: () => Promise.reject(new Error('Decryption with HKDF failed.')),
        });
        internals.startWatchdog();

        for (let i = 0; i < 5; i += 1) man.emitChange({ seq: String(i), doc: remoteDoc(`note-${i}.md`) });
        await flush();
        expect(peer.getFatalReason()).toBeUndefined();

        // Past the decode window, then one watchdog tick.
        vi.advanceTimersByTime(1_001);
        await vi.advanceTimersByTimeAsync(5_000);
        await flush();

        expect(peer.getFatalReason()).toContain('passphrase');
        expect(peer.getFatalReason()).toContain('another client');
        // And it wrote down what it decided on, on its way out.
        expect(state.getUndecodableWith(evidenceKey())).toHaveLength(UNDECODABLE_QUORUM);
    });

    // -----------------------------------------------------------------------
    // D2: the checkpoint is a low-water mark, not a high-water one
    // -----------------------------------------------------------------------

    /** The three seed documents whose writes fail, as in the measured run. */
    function failOn(paths: string[]): DispatchFn {
        const failing = new Set(paths);
        return (p: string) =>
            failing.has(p)
                ? Promise.reject(new Error('EACCES: permission denied'))
                : Promise.resolve(true);
    }

    it('D2: a later successful change does not carry the checkpoint past a failed one', async () => {
        /*
         * REGRESSION GUARD FOR DEFECT 2, driven with the sequence numbers from the
         * run that found it.
         *
         * A throw from `onRemoteChange` correctly skips the checkpoint advance for
         * THAT sequence, and that was never enough, because `since` is a single
         * value. The next change that applies writes its own, higher sequence over
         * the failure, and from that moment the failed sequences are behind the
         * checkpoint: no replay will ever deliver them again, from this process or
         * any later one, because the checkpoint is persisted. Measured against a
         * real CouchDB: pinned at 5 through three failures, jumped to 14 when the
         * next document landed, three notes permanently missing from the vault,
         * `state: idle`, `healthy: true`, `/healthz/livesync` 200, and a deliberate
         * disconnect/reconnect did NOT recover them.
         *
         * Revert `checkpointHeld` and the assertion below reads '14', which is the
         * defect exactly.
         */
        const { peer, man, state } = makePeer(
            {},
            { dispatch: failOn(['seed-4.md', 'seed-5.md', 'seed-6.md']) },
        );

        man.emitChange({ seq: '5', doc: remoteDoc('seed-3.md') });
        await flush();
        expect(state.getSince()).toBe('5'); // the last change that actually landed

        man.emitChange({ seq: '6', doc: remoteDoc('seed-4.md') });
        man.emitChange({ seq: '7', doc: remoteDoc('seed-5.md') });
        man.emitChange({ seq: '8', doc: remoteDoc('seed-6.md') });
        await flush();
        expect(peer.inbound().failed).toBe(3);

        // The change that used to do the damage: it applies cleanly, and its own
        // sequence used to become the checkpoint.
        man.emitChange({ seq: '14', doc: remoteDoc('seed-7.md') });
        await flush();
        expect(peer.inbound().applied).toBe(2);

        expect(state.getSince()).toBe('5');
        expect(peer.inbound().checkpointHeld).toBe(true);
    });

    it('D2: the held checkpoint is what makes a reconnect replay the failed changes', async () => {
        /*
         * The other end of the same fix: holding the checkpoint is only worth
         * anything if something eventually replays from it, and this is the
         * mechanism that does. Re-arming the feed (what the watchdog does when the
         * connection drops, and what `maybeRestart`'s disconnect/connect does)
         * resumes from the persisted checkpoint, so every sequence after the hold
         * is delivered again, the failed ones included.
         *
         * This also drives the inbound half of DEFECT 1, and could not work
         * without it: the first attempt at seed-4.md threw, and if that attempt had
         * recorded an echo claim the replay would have been skipped at the gate and
         * the hold would have been released having achieved nothing. Both hunks are
         * load-bearing here, so a revert of either fails the last two assertions.
         */
        const failing = new Set(['seed-4.md']);
        // Its own recorder: supplying `dispatch` replaces the shared one that
        // writes to `dispatched`, so a test that asserts on what reached the vault
        // has to keep its own list or it would assert against an array nothing
        // ever appends to.
        const landed: string[] = [];
        const { peer, man, internals, state } = makePeer(
            {},
            {
                dispatch: (p: string) => {
                    if (failing.has(p)) return Promise.reject(new Error('EACCES: permission denied'));
                    landed.push(p);
                    return Promise.resolve(true);
                },
            },
        );

        man.emitChange({ seq: '5', doc: remoteDoc('seed-3.md') });
        await flush();
        man.emitChange({ seq: '6', doc: remoteDoc('seed-4.md') });
        await flush();
        expect(landed).toEqual(['seed-3.md']);
        expect(state.getSince()).toBe('5');

        // The link drops and the watchdog re-arms the feed. It must resume from
        // the HELD position, not from the last sequence the feed happened to see.
        man.endWatch();
        internals.startWatch();
        expect(man.since).toBe('5');
        expect(peer.inbound().checkpointHeld).toBe(false);

        // The vault is writable again, and the replay delivers seed-4.md a second
        // time. It has to reach the vault this time.
        failing.clear();
        man.emitChange({ seq: '6', doc: remoteDoc('seed-4.md') });
        await flush();
        expect(landed).toEqual(['seed-3.md', 'seed-4.md']);
        expect(state.getSince()).toBe('6');
    });

    it('D2: a checkpoint held past its grace window is reported, and is restart-worthy', async () => {
        /*
         * The visibility half. A hold that clears itself in seconds is ordinary
         * self-healing and must stay quiet; a hold that is still standing a minute
         * later means the vault is missing a note and nothing is coming to fix it
         * on its own, which is precisely the state that used to report `idle` and
         * answer 200.
         *
         * `restartFutile: false` is the assertion that closes the loop: the
         * supervisor's one lever is to rebuild the peer pair, the rebuilt pair arms
         * its feed from the held checkpoint, and that replay IS the retry. The
         * operators who hit this defect performed it by hand.
         */
        const { peer, man } = makePeer(
            {},
            { dispatch: failOn(['seed-4.md']), progress: { heldGraceMs: 6_000 } },
        );

        man.emitChange({ seq: '6', doc: remoteDoc('seed-4.md') });
        await flush();
        // A change that lands afterwards, so the total-failure verdict
        // (`unwritable`) is NOT what is being measured here: the partial case is
        // the one that used to be invisible.
        man.emitChange({ seq: '7', doc: remoteDoc('seed-7.md') });
        await flush();

        // Inside the window: still quiet, and still honest about it in the detail.
        expect(peer.inbound().state).toBe('idle');
        expect(peer.inbound().checkpointHeld).toBe(true);
        expect(peer.inbound().detail).toContain('awaiting replay');
        expect(peer.snapshot().ok).toBe(true);

        vi.advanceTimersByTime(6_001);
        const v = peer.inbound();
        expect(v.state).toBe('behind');
        expect(v.stalled).toBe(true);
        expect(v.fatal).toBe(false);
        expect(v.restartFutile).toBe(false);
        expect(peer.snapshot().ok).toBe(false);
        expect(peer.snapshot().detail).toContain('checkpoint is held');
    });

    // -----------------------------------------------------------------------
    // D3: "the peer is running" and "the link is up" are two questions
    // -----------------------------------------------------------------------

    it('D3: a mid-session link drop is visible, while the lifecycle flag stays true', () => {
        /*
         * REGRESSION GUARD FOR DEFECT 3.
         *
         * `connected` is set once when the connect sequence succeeds and cleared
         * only by an explicit stop or a fatal configuration, so it is a statement
         * about the peer's lifecycle and not about the link. Measured true for the
         * whole of a 269-second dead link. Two things read badly as a result:
         * `classifyDetail()` in routes/livesync.ts has a `not connected to CouchDB`
         * case that is unreachable for any mid-session drop, so the public health
         * endpoint published the far vaguer `peers not syncing` for the first
         * minute of every outage; and the `connected` field on the status API,
         * which an operator reads as "is my CouchDB reachable", said yes while it
         * was not.
         *
         * The fix is to add the second question rather than to redefine the first,
         * because three callers genuinely want the lifecycle answer (see
         * `isConnected`). Revert `isLinkUp()` to return `this.connected` and every
         * `false` below becomes `true`.
         */
        const { peer, man } = makePeer();
        expect(peer.isConnected()).toBe(true);
        expect(peer.isLinkUp()).toBe(true);

        // The link dies. PouchDB's feed emits `error` (or a clean `complete` on an
        // idle-timeout), the engine clears `watching`, and nothing else changes.
        man.endWatch();

        // The lifecycle answer is deliberately unchanged: the peer is still
        // running, still supervised, and still the thing that will reconnect.
        expect(peer.isConnected()).toBe(true);
        // The link answer is not.
        expect(peer.isLinkUp()).toBe(false);
        expect(peer.snapshot().detail).toBe('reconnecting');

        // And time does not heal it, which is the whole shape of the report: the
        // flag stayed true for 269 measured seconds of a dead link.
        vi.advanceTimersByTime(269_000);
        expect(peer.isConnected()).toBe(true);
        expect(peer.isLinkUp()).toBe(false);
    });

    it('D3: the link reads down before the first connect, and up again after a re-arm', () => {
        // The two boundaries. A peer that has never connected must not claim a
        // link, and a peer whose watchdog has re-armed the feed must stop denying
        // one, or the recovery would be invisible in exactly the field an operator
        // is watching.
        const { peer, man, internals } = makePeer();
        internals.connected = false;
        expect(peer.isLinkUp()).toBe(false);

        internals.connected = true;
        man.endWatch();
        expect(peer.isLinkUp()).toBe(false);

        internals.startWatch();
        expect(peer.isLinkUp()).toBe(true);
    });
});

// ===========================================================================
// 3. The restart verdict
// ===========================================================================

describe('the wedge reaches the restart machinery, and a fatal config does not', () => {
    let tmp: TmpDir;

    beforeEach(async () => {
        vi.useFakeTimers();
        tmp = await makeTmpDataDir();
    });

    afterEach(async () => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        await tmp.cleanup();
    });

    function makePeer() {
        const state = new LiveSyncStateStore('test::', {
            file: path.join(tmp.dataDir, 'livesync-state.json'),
            flushDelayMs: 3_600_000,
        });
        const peer = new CouchDBPeer(couchConf(), {
            state,
            dispatch: () => Promise.resolve(true),
            progress: { decodeGraceMs: 1_000, applyGraceMs: 2_000, deliverGraceMs: 3_000, probeGraceMs: 4_000 },
        });
        const man = new FakeManipulator();
        const internals = peer as unknown as PeerInternals;
        internals.man = man;
        internals.connected = true;
        internals.startWatch();
        return { peer, man, internals };
    }

    it('a wedged feed becomes restart-worthy, which it could never be before', async () => {
        /*
         * THE ASSERTION THAT TIES THE WHOLE FIX TOGETHER.
         *
         * HealthTracker only reaches a restart verdict on a snapshot that is NOT
         * ok. While `ok` meant "connected and watching", a wedged feed kept it
         * true, the tracker returned early on every probe, and routes/livesync.ts's
         * maybeRestart was unreachable in precisely the failure mode it was built
         * for. Making the stall part of `ok` is what re-arms it.
         */
        const reachable = vi.fn(() =>
            Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
        );
        vi.stubGlobal('fetch', reachable);

        const { peer, internals } = makePeer();
        expect((await peer.probeHealth()).ok).toBe(true); // earns "was healthy once"

        internals.progress.setRemotePending(true);
        vi.advanceTimersByTime(3_001);
        expect((await peer.probeHealth()).restartWorthy).toBe(false); // stamps the clock

        vi.advanceTimersByTime(RESTART_GRACE_MS + 1);
        const verdict = await peer.probeHealth();
        expect(verdict.ok).toBe(false);
        expect(verdict.backendUp).toBe(true);
        expect(verdict.restartWorthy).toBe(true);
        expect(reachable).toHaveBeenCalled();
    });

    it('a fatally misconfigured peer is NOT restart-worthy, and does not probe to find out', async () => {
        // Restarting into a wrong passphrase produces a restart every cooldown,
        // forever, over a fault only an operator can fix. `backendUp` answers
        // "would a restart help", so a fatal configuration answers no without
        // asking CouchDB anything.
        const probe = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
        vi.stubGlobal('fetch', probe);

        const { peer, man, internals } = makePeer();
        expect((await peer.probeHealth()).ok).toBe(true);

        // Force the TOTAL-decode-failure state directly: three DISTINCT delivered
        // notes that never decode, with no foreign decode before them. That
        // conjunction is what `fatal` now requires, and driving it through the
        // ledger keeps this test about the restart verdict rather than about the
        // feed harness. The keys have to differ: an undecodable document is
        // redelivered forever by every feed re-arm, so the verdict counts distinct
        // documents rather than delivery events.
        internals.progress.noteFeedChange('2', true, 'doc-a');
        internals.progress.noteFeedChange('3', true, 'doc-b');
        internals.progress.noteFeedChange('4', true, 'doc-c');
        vi.advanceTimersByTime(1_001);
        internals.escalateInboundFatal();
        await flush();

        expect(peer.getFatalReason()).toBeTruthy();
        probe.mockClear();

        vi.advanceTimersByTime(RESTART_GRACE_MS * 3);
        const verdict = await peer.probeHealth();
        expect(verdict.ok).toBe(false);
        expect(verdict.backendUp).toBe(false);
        expect(verdict.restartWorthy).toBe(false);
        expect(probe).not.toHaveBeenCalled();
    });

    it('F3: a peer that cannot MEASURE itself is loudly unhealthy and never restarted', async () => {
        /*
         * REGRESSION GUARD FOR F3, wired, on the `unobservable` half.
         *
         * The out-of-band probe is a plain HTTP request of this peer's own,
         * independent of the feed and of the manipulator, so whatever is refusing
         * it refuses it just as hard after a reconnect. Before `restartFutile`,
         * this state satisfied every condition `HealthTracker` checks (healthy
         * once, unhealthy since, CouchDB reachable) and therefore produced a
         * peer-pair teardown plus a full offline vault scan every five minutes,
         * flat, with no backoff, for as long as the proxy stayed broken.
         *
         * It stays maximally loud: `ok` is false and `/healthz/livesync` answers
         * 503, because an unmeasurable subsystem must never report itself fine.
         *
         * Revert either the ledger's `restartFutile` or the gate in
         * `HealthTracker.probe()` and the `restartWorthy` assertion fails.
         */
        const { peer, internals } = makePeer();
        // The reachability probe answers; only the pending-changes probe fails.
        // That combination is the point: it is exactly what used to make this
        // state look like a restartable wedge.
        vi.stubGlobal('fetch', (url: string) =>
            String(url).includes('_changes')
                ? Promise.reject(new Error('502 Bad Gateway from the reverse proxy'))
                : Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
        );

        expect((await peer.probeHealth()).ok).toBe(true); // earns "was healthy once"
        await runProbe(internals);
        vi.advanceTimersByTime(4_001);
        expect(peer.inbound().state).toBe('unobservable');
        expect((await peer.probeHealth()).restartWorthy).toBe(false); // stamps the clock

        vi.advanceTimersByTime(RESTART_GRACE_MS * 5);
        const verdict = await peer.probeHealth();
        expect(verdict.ok).toBe(false);
        expect(verdict.backendUp).toBe(true);
        expect(verdict.restartWorthy).toBe(false);
        expect(verdict.restartFutile).toBe(true);
    });
});
