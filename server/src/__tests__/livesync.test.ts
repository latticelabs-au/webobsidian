/**
 * Regression tests for the LiveSync backend port.
 *
 * WHAT THIS FILE IS FOR. The port carries eleven numbered defect fixes over the
 * reference bridge (reference/livesync-bridge), and every one of them is a
 * SILENT corruption: a mangled path, an echo loop, a wedge that reports itself
 * healthy, a dedup that fires at random, a checkpoint that resets itself. None
 * of them throws, none of them fails a typecheck, and the repo has no other
 * mechanical gate. A reviewer reading the diff cannot tell a fixed version from
 * a reverted one by eye, which is precisely why these assertions exist.
 *
 * Each block below is written so that it FAILS against the reference bridge's
 * behaviour, not merely against a broken rewrite. Where that required choosing
 * a fixture carefully (epoch milliseconds above 2^31 for compareMtimeSeconds, a
 * bulk size above the bridge's 300-entry echo cache) the choice is spelled out
 * at the assertion, because a future edit that "simplifies" the fixture back to
 * small numbers would make the test pass against the defect it was written to
 * catch.
 *
 * SCOPE: pure logic only. Nothing here opens a socket or needs a CouchDB. The
 * connect loop, the changes feed and the real replication round trip are the
 * end-to-end script's job; what is testable without a server is tested here, and
 * that turns out to be every one of the fixes that can corrupt a vault on its
 * own.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { makeTmpDataDir, type TmpDir } from './helpers.js';
import {
    LiveSyncStateStore,
    EchoSuppressor,
    type StateStoreOptions,
} from '../services/livesync/state.js';
import {
    HealthTracker,
    combineHealth,
    RESTART_GRACE_MS,
    type PeerHealth,
} from '../services/livesync/health.js';
import {
    CouchDBPeer,
    LiveSyncFatalError,
    compareMtimeSeconds,
    mergeRemoteTweaks,
} from '../services/livesync/peer-couchdb.js';
import { isIgnoredVaultPath } from '../services/livesync/peer-storage.js';
import {
    describeError,
    validateCouchDBConf,
    type FileData,
    type LiveSyncCouchDBConf,
} from '../services/livesync/types.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/**
 * A syntactically valid CouchDB config. The password is deliberately present and
 * deliberately distinctive: several assertions below check that it never reaches
 * a log line or an error string.
 */
function couchConf(overrides: Partial<LiveSyncCouchDBConf> = {}): LiveSyncCouchDBConf {
    return {
        name: 'couch',
        baseDir: '',
        url: 'https://couch.example.test:5984',
        username: 'syncuser',
        password: 'hunter2-should-never-be-logged',
        database: 'vault',
        passphrase: undefined,
        obfuscatePassphrase: undefined,
        ...overrides,
    };
}

/** Text FileData with the given content, in the engine's chunk-array shape. */
function textData(content: string, mtime = 1_700_000_000_000): FileData {
    return { ctime: mtime, mtime, size: content.length, data: [content] };
}

// ===========================================================================
// 1. Path mapping
// ===========================================================================

/**
 * The mapping methods are private on CouchDBPeer, which is correct for
 * production (nothing outside the peer has any business mapping paths) and
 * inconvenient for exactly one caller: this file.
 *
 * Reaching them through a narrow structural type rather than `any` keeps the
 * test honest. If either method is renamed or its signature changes, this cast
 * stops compiling and the test is updated deliberately, which is the whole point
 * of the house rule against `any`.
 */
interface PathMapper {
    toRemotePath(pathSrc: string): string;
    toVaultPath(remotePath: string): string;
}

function mapperFor(baseDir: string): PathMapper {
    // The constructor is inert: it copies the config and builds a HealthTracker.
    // No I/O, no timers, nothing to tear down. start() is what connects, and it
    // is never called here.
    const peer = new CouchDBPeer(couchConf({ baseDir }), {
        state: new LiveSyncStateStore('test::'),
        dispatch: () => Promise.resolve(true),
    });
    return peer as unknown as PathMapper;
}

describe('path mapping', () => {
    /**
     * The fourth entry is the one that matters most.
     *
     * `Peer.toLocalPath`/`toGlobalPath` in the bridge carry an explicit warning
     * that commonlib's `path2id_base`/`id2path_base` ALREADY handle a leading
     * underscore (CouchDB reserves `_`-prefixed document ids, so the engine
     * escapes them), and that adding a second rule in the peer double-mangled
     * `_attachments` on round trip. A vault with an `_attachments` folder is the
     * default Obsidian layout for pasted images, so the double-mangle silently
     * corrupts the attachment path of a typical vault rather than an exotic one.
     */
    const PATHS = [
        'note.md',
        'projects/2024/quarterly review.md',
        'a note with spaces.md',
        '_attachments/foo.png',
        '_templates/_daily _note.md',
    ];

    // '' is the deployment default. The other two exercise the baseDir strip,
    // including the trailing-slash spelling an operator is likely to type.
    for (const baseDir of ['', 'vault', 'vault/']) {
        describe(`baseDir=${JSON.stringify(baseDir)}`, () => {
            for (const p of PATHS) {
                it(`round-trips ${JSON.stringify(p)} unchanged`, () => {
                    const m = mapperFor(baseDir);
                    expect(m.toVaultPath(m.toRemotePath(p))).toBe(p);
                });

                it(`round-trips ${JSON.stringify(p)} idempotently (catches double-mangling)`, () => {
                    const m = mapperFor(baseDir);
                    // A single round trip can be identity by accident when two
                    // bugs cancel. Two round trips cannot: any mangle that is not
                    // exactly reversed accumulates on the second pass, which is
                    // the failure mode the bridge's `_attachments` note describes.
                    const once = m.toVaultPath(m.toRemotePath(p));
                    const twice = m.toVaultPath(m.toRemotePath(once));
                    expect(twice).toBe(p);
                });
            }
        });
    }

    it('does not touch a leading underscore itself', () => {
        // With no baseDir the mapping must be the identity function, full stop.
        // Escaping `_` here would be the double-mangle: the engine escapes it
        // again on the way to the document id.
        const m = mapperFor('');
        expect(m.toRemotePath('_attachments/foo.png')).toBe('_attachments/foo.png');
        expect(m.toVaultPath('_attachments/foo.png')).toBe('_attachments/foo.png');
    });

    it('leaves no leading slash after stripping a non-empty baseDir', () => {
        // The bridge strips exactly `baseDir.length` characters and keeps the
        // separator, yielding "/note.md". That resolves differently on the
        // filesystem side, so the same document lands at two different paths
        // depending on which side observed it first.
        const m = mapperFor('vault');
        expect(m.toRemotePath('note.md')).toBe('vault/note.md');
        expect(m.toVaultPath('vault/note.md')).toBe('note.md');
        expect(m.toVaultPath('vault/note.md').startsWith('/')).toBe(false);
    });

    it('does not double the separator for a trailing-slash baseDir', () => {
        const m = mapperFor('vault/');
        expect(m.toRemotePath('note.md')).toBe('vault/note.md');
        expect(m.toRemotePath('/note.md')).toBe('vault/note.md');
    });
});

// ===========================================================================
// 2. Echo suppression
// ===========================================================================

describe('EchoSuppressor', () => {
    /**
     * WHY EVERY CASE BELOW NOW SPELLS THE RECORD OUT.
     *
     * The class used to expose one `isRepeating()` that answered the question and
     * recorded the hash on the miss path in the same call, and these tests were
     * written against that shape ("first call false, second call true"). The
     * combined call is gone, because recording on a miss claims that content has
     * passed through a path at the moment the caller has only decided to TRY, and
     * a caller whose attempt then fails leaves behind a claim that suppresses
     * every later retry of the same bytes. That produced permanent, silent,
     * measured data loss in both directions; `EchoSuppressor`'s own comment tells
     * the story and the peers' regression tests below drive it end to end.
     *
     * So the fixture is `hasSeen()` for the question and `remember()` for the
     * claim, and the sequence `hasSeen -> false; remember; hasSeen -> true` is
     * what the old `isRepeating` did in two calls. Every assertion about hashing
     * and eviction is preserved exactly; only the call shape changed.
     */
    it('suppresses the same content for the same path once it has been recorded', () => {
        const echo = new EchoSuppressor();
        const data = textData('hello');
        // Before the write there is nothing to repeat.
        expect(echo.hasSeen('note.md', data)).toBe(false);
        echo.remember('note.md', data);
        // And now the watcher event our own write caused is recognised.
        expect(echo.hasSeen('note.md', data)).toBe(true);
    });

    it('records nothing when it is only asked', () => {
        // THE PROPERTY THE WHOLE SPLIT EXISTS FOR. A caller that asks and then
        // fails to perform its write must leave the cache exactly as it found it,
        // or its own retry is answered with a claim it never earned.
        const echo = new EchoSuppressor();
        const data = textData('hello');
        expect(echo.hasSeen('note.md', data)).toBe(false);
        expect(echo.hasSeen('note.md', data)).toBe(false);
        expect(echo.hasSeen('note.md', data)).toBe(false);
    });

    it('does not suppress different content for the same path', () => {
        const echo = new EchoSuppressor();
        expect(echo.hasSeen('note.md', textData('hello'))).toBe(false);
        echo.remember('note.md', textData('hello'));
        expect(echo.hasSeen('note.md', textData('hello world'))).toBe(false);
        echo.remember('note.md', textData('hello world'));
        // ...and the new content is now the one being suppressed.
        expect(echo.hasSeen('note.md', textData('hello world'))).toBe(true);
        // The superseded content is no longer suppressed: an edit that reverts a
        // file must be pushed, not swallowed.
        expect(echo.hasSeen('note.md', textData('hello'))).toBe(false);
    });

    it('does not suppress the same content on a different path', () => {
        // Two files with identical content are two files. Keying the cache by
        // content alone would make a copy-paste of a note invisible to sync.
        const echo = new EchoSuppressor();
        echo.remember('a.md', textData('same'));
        expect(echo.hasSeen('b.md', textData('same'))).toBe(false);
    });

    it('hashes content only, so a touch with identical bytes is an echo', () => {
        // Documenting the deliberate design: mtime/ctime/size are NOT hashed.
        // A file rewritten with the same bytes carries no change to replicate,
        // and hashing the mtime would make every inbound write echo back out
        // (the inbound path sets the mtime from the remote metadata).
        const echo = new EchoSuppressor();
        echo.remember('note.md', textData('same bytes', 1_700_000_000_000));
        expect(echo.hasSeen('note.md', textData('same bytes', 1_700_000_999_000))).toBe(true);
    });

    it('models a delete distinctly from an empty write', () => {
        const echo = new EchoSuppressor();
        // A delete is recorded...
        expect(echo.hasSeen('note.md', false)).toBe(false);
        echo.remember('note.md', false);
        expect(echo.hasSeen('note.md', false)).toBe(true);

        // ...and an empty write to the same path is NOT that delete. Collapsing
        // the two would mean a "truncate to empty" arriving right after a delete
        // is swallowed, so the file stays deleted on one side and empty on the
        // other, permanently divergent with no event left to repair it.
        expect(echo.hasSeen('note.md', textData(''))).toBe(false);

        // Symmetrically: a delete following an empty write is not an echo of it.
        const echo2 = new EchoSuppressor();
        echo2.remember('note.md', textData(''));
        expect(echo2.hasSeen('note.md', false)).toBe(false);
    });

    it('hashes bytes, not the document type, so a text/binary crossing is not an echo storm', () => {
        // `isPlainText()` decides which of the engine's two document types a file
        // becomes, and the two representations meet here. Hashing the BYTES
        // rather than the representation is what makes that boundary safe: the
        // same file arriving as a chunk array and leaving as a byte array is one
        // file, not two, so it does not bounce.
        //
        // The corollary is that a zero-byte file is a zero-byte file whichever
        // type it was stored as. That is correct for this cache's purpose (it
        // guards LOCAL writes, and both cases write the same nothing to disk),
        // and it is asserted so a future change to hash the type as well is a
        // deliberate one.
        const echo = new EchoSuppressor();
        const asText: FileData = { ctime: 1, mtime: 1, size: 5, data: ['hello'] };
        const asBinary: FileData = {
            ctime: 1,
            mtime: 1,
            size: 5,
            data: new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]),
        };
        echo.remember('note.md', asText);
        expect(echo.hasSeen('note.md', asBinary)).toBe(true);

        const empties = new EchoSuppressor();
        const emptyText: FileData = { ctime: 1, mtime: 1, size: 0, data: [] };
        const emptyBinary: FileData = { ctime: 1, mtime: 1, size: 0, data: new Uint8Array(0) };
        empties.remember('x.bin', emptyText);
        expect(empties.hasSeen('x.bin', emptyBinary)).toBe(true);
        // ...but an empty file is still not a DELETE. That distinction is the one
        // that matters, and it holds.
        expect(empties.hasSeen('x.bin', false)).toBe(false);
    });

    it('compares a re-chunked text file equal to its original chunking', () => {
        // The engine hands text back as an array of chunks whose boundaries
        // depend on the chunk-size tweaks, which can differ between peers. If the
        // hash depended on the split, every inbound document would look like new
        // content and bounce straight back out.
        const echo = new EchoSuppressor();
        const oneChunk: FileData = { ctime: 1, mtime: 1, size: 11, data: ['hello world'] };
        const threeChunks: FileData = { ctime: 1, mtime: 1, size: 11, data: ['hello', ' ', 'world'] };
        echo.remember('note.md', oneChunk);
        expect(echo.hasSeen('note.md', threeChunks)).toBe(true);
    });

    it('forgets a path on demand', () => {
        const echo = new EchoSuppressor();
        const data = textData('hello');
        echo.remember('note.md', data);
        expect(echo.hasSeen('note.md', data)).toBe(true);
        echo.forget('note.md');
        expect(echo.hasSeen('note.md', data)).toBe(false);
    });

    /**
     * THE 300-ENTRY BUG.
     *
     * The bridge's cache holds 300 entries. A bulk operation over more than 300
     * files evicts its OWN suppression entries while it is still running: entry
     * 301 pushes entry 1 out, entry 1's watcher event arrives afterwards, finds
     * no cached hash, and is dispatched back. Every echo is itself a write, so
     * the batch can echo repeatedly.
     *
     * 4000 is chosen to sit well above 300 and below the 5000 capacity, so this
     * test fails against the bridge's number and passes against the port's. A
     * folder rename or a bulk import in a real vault is routinely this size.
     */
    it('survives a bulk operation without evicting its own entries', () => {
        const echo = new EchoSuppressor();
        const BULK = 4000;
        expect(BULK).toBeGreaterThan(300); // guard: do not shrink this fixture

        const paths = Array.from({ length: BULK }, (_, i) => `bulk/note-${i}.md`);
        for (const p of paths) {
            expect(echo.hasSeen(p, textData(`content of ${p}`))).toBe(false);
            echo.remember(p, textData(`content of ${p}`));
        }

        // Now the watcher events for the whole batch arrive, oldest first. Every
        // one of them must still be recognised as our own write.
        for (const p of paths) {
            expect(echo.hasSeen(p, textData(`content of ${p}`))).toBe(true);
        }
    });

    it('evicts in insertion order once capacity is genuinely exceeded', () => {
        // The eviction itself is not the bug; unbounded growth would be its own
        // problem on a 30k-file vault. Verified at a small capacity so the
        // boundary is exact.
        const echo = new EchoSuppressor(3);
        for (let i = 0; i < 3; i += 1) echo.remember(`p${i}`, textData(`c${i}`));
        // Still within capacity: nothing evicted.
        expect(echo.hasSeen('p0', textData('c0'))).toBe(true);
        // p0 was just refreshed to the end, so p1 is now the oldest.
        echo.remember('p3', textData('c3'));
        expect(echo.hasSeen('p1', textData('c1'))).toBe(false);
        expect(echo.hasSeen('p0', textData('c0'))).toBe(true);
    });

    it('refreshes recency on a hit, so a file that keeps round-tripping is never evicted', () => {
        // The pathological case for a plain insertion-order cache: the one file
        // that echoes constantly is also the one whose entry must survive.
        const echo = new EchoSuppressor(2);
        echo.remember('hot', textData('h'));
        echo.remember('cold', textData('c'));
        expect(echo.hasSeen('hot', textData('h'))).toBe(true); // moves 'hot' to the end
        echo.remember('new', textData('n')); // evicts 'cold', not 'hot'
        expect(echo.hasSeen('hot', textData('h'))).toBe(true);
        expect(echo.hasSeen('cold', textData('c'))).toBe(false);
    });

    it('clear() drops everything', () => {
        const echo = new EchoSuppressor();
        echo.remember('note.md', textData('hello'));
        echo.clear();
        expect(echo.hasSeen('note.md', textData('hello'))).toBe(false);
    });
});

// ===========================================================================
// 3. The health state machine
// ===========================================================================

/**
 * The idle-versus-wedged distinction, which KICKOFF calls the single most
 * important design requirement: a sync daemon that fails silently is worse than
 * one that crashes.
 *
 * Fake timers throughout, because every assertion here is about elapsed time and
 * the grace window is 60 seconds. `vi.useFakeTimers()` also fakes `Date.now()`,
 * which is what HealthTracker actually reads.
 */
describe('HealthTracker', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    /** A snapshot source whose `ok` and restart veto the test drives directly. */
    function makeSubject(opts: { backendUp?: boolean } = {}) {
        const state = { ok: false, restartFutile: false };
        const backendUp = { value: opts.backendUp ?? true };
        const probeBackend = vi.fn(() => Promise.resolve(backendUp.value));
        const snapshot = (): PeerHealth => ({
            name: 'couch',
            type: 'couchdb',
            ok: state.ok,
            detail: state.ok ? 'watching' : 'reconnecting',
            backendUp: state.ok,
            restartWorthy: false,
            restartFutile: state.restartFutile,
        });
        const tracker = new HealthTracker(snapshot, probeBackend);
        return { state, backendUp, probeBackend, tracker };
    }

    it('an ok probe resets the clock and does NOT touch the backend', async () => {
        // The steady state must cost nothing. A healthy peer's health check is
        // called from the heartbeat AND from the HTTP status endpoint, so an
        // I/O probe here would put a network round trip on every status poll.
        const { state, probeBackend, tracker } = makeSubject();
        state.ok = true;

        const h = await tracker.probe();
        expect(h.ok).toBe(true);
        expect(h.restartWorthy).toBe(false);
        expect(probeBackend).not.toHaveBeenCalled();

        vi.advanceTimersByTime(10 * 60_000);
        await tracker.probe();
        expect(probeBackend).not.toHaveBeenCalled();
    });

    it('a peer that has never been ok is never restart-worthy, however long it fails', async () => {
        // The startup case. A peer still doing its initial scan or its first
        // connect has never been healthy; a supervisor that restarted on "not ok"
        // would kill it during every boot and it would never finish.
        const { probeBackend, tracker } = makeSubject();

        for (let elapsed = 0; elapsed <= 30 * 60_000; elapsed += 60_000) {
            const h = await tracker.probe();
            expect(h.restartWorthy).toBe(false);
            vi.advanceTimersByTime(60_000);
        }
        // And it is diagnosed as starting up without any I/O at all: there is
        // nothing to diagnose yet, so there is nothing worth asking CouchDB.
        expect(probeBackend).not.toHaveBeenCalled();
    });

    it('after a first success, staying unhealthy past the grace with a live backend IS restart-worthy', async () => {
        const { state, tracker } = makeSubject({ backendUp: true });

        state.ok = true;
        await tracker.probe(); // earns "was healthy once"

        state.ok = false;
        // The first non-ok probe only STAMPS the clock. It cannot itself be past
        // a window that started at this instant.
        expect((await tracker.probe()).restartWorthy).toBe(false);

        vi.advanceTimersByTime(RESTART_GRACE_MS - 1_000);
        expect((await tracker.probe()).restartWorthy).toBe(false);

        // Exactly at the boundary is still not worthy: the comparison is strict
        // (`> graceMs`), and a peer is given the whole window, not all-but-one-ms.
        vi.advanceTimersByTime(1_000);
        expect((await tracker.probe()).restartWorthy).toBe(false);

        vi.advanceTimersByTime(1);
        const verdict = await tracker.probe();
        expect(verdict.restartWorthy).toBe(true);
        expect(verdict.backendUp).toBe(true);
        expect(verdict.ok).toBe(false);
    });

    it('F3: a peer that vetoes the restart never becomes restart-worthy, however long it fails', async () => {
        /*
         * REGRESSION GUARD FOR F3, at the tracker.
         *
         * The three conditions this class already applies (healthy once,
         * unhealthy since, backend reachable) are all about timing and
         * reachability, and none of them can see WHY the peer is unhealthy. For
         * some reasons a restart is a flat no however patient the caller is: a
         * remote document that will not decrypt, a probe a proxy refuses, a full
         * vault volume. `routes/livesync.ts` responds to `restartWorthy` by
         * tearing the peer pair down and rebuilding it, which also runs a full
         * offline vault scan, so acting on those is that cost repeated every
         * cooldown for as long as the fault lasts.
         *
         * Revert the `restartFutile` gate in `HealthTracker.probe()` and the
         * second block below fails: the verdict comes back restart-worthy.
         */
        const { state, tracker } = makeSubject({ backendUp: true });
        state.ok = true;
        await tracker.probe(); // earns "was healthy once"

        state.ok = false;
        state.restartFutile = true;
        await tracker.probe(); // stamps the clock
        vi.advanceTimersByTime(RESTART_GRACE_MS * 10);

        const vetoed = await tracker.probe();
        expect(vetoed.ok).toBe(false);
        expect(vetoed.restartWorthy).toBe(false);
        // Still honest about the backend. Suppressing the restart by claiming
        // CouchDB is down would be a lie in the one field an operator reads to
        // decide whether their server is at fault, and it is a lie the
        // fatal-config path takes on knowingly for a much narrower reason.
        expect(vetoed.backendUp).toBe(true);

        // Lifting the veto, with nothing else changed, restores the verdict. That
        // is what proves the veto and not some side effect is doing the work.
        state.restartFutile = false;
        expect((await tracker.probe()).restartWorthy).toBe(true);
    });

    it('measures the window from the first non-ok PROBE, not from the last check', async () => {
        // The stamp is taken once, on the transition, so the window measures how
        // long the peer has been broken rather than how long since anyone looked.
        // A supervisor that polls irregularly must not be able to shorten or
        // lengthen the grace by changing its poll rate.
        const { state, tracker } = makeSubject();
        state.ok = true;
        await tracker.probe();

        state.ok = false;
        vi.advanceTimersByTime(10 * 60_000); // broken for ten minutes, unobserved
        // First observation: stamps now, so it is not yet worthy. This is the
        // deliberate behaviour, and it costs at most one grace window after a
        // long silence.
        expect((await tracker.probe()).restartWorthy).toBe(false);

        vi.advanceTimersByTime(RESTART_GRACE_MS + 1);
        expect((await tracker.probe()).restartWorthy).toBe(true);
    });

    it('a peer whose backend is DOWN is never restart-worthy, however long it fails', async () => {
        // The outage case. CouchDB being down is not this process's fault, and
        // restarting into an outage just churns. This is the assertion that keeps
        // a supervisor from turning a remote outage into a local crash loop.
        const { state, backendUp, tracker } = makeSubject();
        backendUp.value = false;

        state.ok = true;
        await tracker.probe();
        state.ok = false;

        await tracker.probe(); // stamp
        for (let i = 0; i < 20; i += 1) {
            vi.advanceTimersByTime(60_000);
            const h = await tracker.probe();
            expect(h.restartWorthy).toBe(false);
            expect(h.backendUp).toBe(false);
        }

        // ...and the moment the backend comes back, the verdict flips. The peer
        // has been broken for twenty minutes; nothing else needed to change.
        backendUp.value = true;
        expect((await tracker.probe()).restartWorthy).toBe(true);
    });

    it('a single ok probe fully resets the grace clock', async () => {
        // Recovery is immediate: a peer that comes back does not have to out-wait
        // its own bad history before it stops being reported as broken.
        const { state, tracker } = makeSubject();

        state.ok = true;
        await tracker.probe();
        state.ok = false;
        await tracker.probe();
        vi.advanceTimersByTime(RESTART_GRACE_MS + 1);
        expect((await tracker.probe()).restartWorthy).toBe(true);

        // One good probe.
        state.ok = true;
        expect((await tracker.probe()).restartWorthy).toBe(false);

        // Now break it again: the clock starts from zero, not from the old stamp.
        state.ok = false;
        expect((await tracker.probe()).restartWorthy).toBe(false);
        vi.advanceTimersByTime(RESTART_GRACE_MS - 1);
        expect((await tracker.probe()).restartWorthy).toBe(false);
        vi.advanceTimersByTime(2);
        expect((await tracker.probe()).restartWorthy).toBe(true);
    });

    it('reset() makes a peer earn "was healthy once" again', async () => {
        // Called on a deliberate stop/start. Without it, a restarted peer that
        // never manages to connect inherits everOk from the previous run and is
        // judged restart-worthy on its very first probe, which is a restart loop.
        const { state, tracker } = makeSubject();
        state.ok = true;
        await tracker.probe();
        state.ok = false;
        await tracker.probe();
        vi.advanceTimersByTime(RESTART_GRACE_MS + 1);
        expect((await tracker.probe()).restartWorthy).toBe(true);

        tracker.reset();
        vi.advanceTimersByTime(RESTART_GRACE_MS * 10);
        expect((await tracker.probe()).restartWorthy).toBe(false);
    });

    it('honours an injected grace window', async () => {
        // The window is injectable so tests do not have to advance a full minute
        // to reach every verdict. Asserting that the injection is actually
        // honoured is what stops the rest of this block from silently testing the
        // default value instead of the one it asked for.
        const state = { ok: false };
        const fast = new HealthTracker(
            () => ({
                name: 'storage',
                type: 'storage',
                ok: state.ok,
                backendUp: true,
                restartWorthy: false,
            }),
            () => Promise.resolve(true),
            { graceMs: 5_000 },
        );

        state.ok = true;
        await fast.probe();
        state.ok = false;
        await fast.probe();
        vi.advanceTimersByTime(5_001);
        expect((await fast.probe()).restartWorthy).toBe(true);
    });
});

describe('combineHealth', () => {
    const peer = (over: Partial<PeerHealth> = {}): PeerHealth => ({
        name: 'p',
        type: 'storage',
        ok: true,
        backendUp: true,
        restartWorthy: false,
        ...over,
    });

    it('reports a peer list that failed to construct as NOT ok', () => {
        // `[].every(...)` is true, so the naive form reports a sync backend with
        // zero peers as perfectly healthy. That is exactly the silent failure the
        // whole health module exists to prevent, and it is the state after a
        // construction error.
        expect(combineHealth([]).ok).toBe(false);
        expect(combineHealth([]).restartWorthy).toBe(false);
    });

    it('is ok only when every peer is ok', () => {
        expect(combineHealth([peer(), peer()]).ok).toBe(true);
        expect(combineHealth([peer(), peer({ ok: false })]).ok).toBe(false);
    });

    it('is restart-worthy when ANY peer says so', () => {
        expect(combineHealth([peer(), peer({ ok: false, restartWorthy: true })]).restartWorthy).toBe(true);
        expect(combineHealth([peer(), peer()]).restartWorthy).toBe(false);
    });
});

// ===========================================================================
// 4. compareMtimeSeconds (the bridge's compareDate)
// ===========================================================================

/**
 * The bridge's version is
 *
 *     const aMTime = ~~(a?.mtime ?? 0 / 1000);
 *
 * with two independent defects: `/` binds tighter than `??` so the division
 * never touches `a.mtime` (the value stays in MILLISECONDS), and `~~` truncates
 * to a signed 32-bit integer, which epoch milliseconds overflow by three orders
 * of magnitude.
 *
 * EVERY fixture below uses realistic epoch milliseconds ABOVE 2^31. With small
 * numbers both defects are invisible and the test would pass against the broken
 * version, which is worse than having no test.
 */
describe('compareMtimeSeconds', () => {
    const NOV_2023_MS = 1_700_000_000_000;

    it('uses fixtures that actually exercise the overflow', () => {
        // Guard rail for a future edit: shrinking these values to "simpler"
        // numbers silently disarms every assertion in this block.
        expect(NOV_2023_MS).toBeGreaterThan(2 ** 31);
    });

    const at = (mtime: number) => ({ ctime: mtime, mtime, size: 0 });

    it('returns 0 for identical mtimes', () => {
        expect(compareMtimeSeconds(at(NOV_2023_MS), at(NOV_2023_MS))).toBe(0);
    });

    it('returns the difference in WHOLE SECONDS, not milliseconds', () => {
        // The bridge returns 1000 here (the millisecond delta), which is the
        // precedence bug made visible. 1 is the correct answer.
        expect(compareMtimeSeconds(at(NOV_2023_MS + 1_000), at(NOV_2023_MS))).toBe(1);
        expect(compareMtimeSeconds(at(NOV_2023_MS), at(NOV_2023_MS + 1_000))).toBe(-1);
    });

    it('floors sub-second differences to zero', () => {
        expect(compareMtimeSeconds(at(NOV_2023_MS + 999), at(NOV_2023_MS))).toBe(0);
    });

    it('produces a correctly-scaled value for the one-hour dedup window', () => {
        // This is what the comparison is FOR: `Math.abs(...) < 3600` decides
        // whether to fetch and rehydrate the old document and compare content.
        // With the bridge's arithmetic the window opens and closes essentially at
        // random, so identical pushes create a new revision every time and the
        // database grows a revision per push per file.
        const HOUR_MS = 3_600_000;
        expect(compareMtimeSeconds(at(NOV_2023_MS + HOUR_MS), at(NOV_2023_MS))).toBe(3600);

        // Just inside the window: dedup is considered.
        expect(Math.abs(compareMtimeSeconds(at(NOV_2023_MS + HOUR_MS - 1_000), at(NOV_2023_MS)))).toBeLessThan(3600);
        // Exactly an hour apart: not considered. Outside the window the two
        // documents are far enough apart in time that resolving them by content
        // would hide a real conflict.
        expect(Math.abs(compareMtimeSeconds(at(NOV_2023_MS + HOUR_MS), at(NOV_2023_MS)))).not.toBeLessThan(3600);
    });

    it('orders a realistic pair correctly rather than by their low 32 bits', () => {
        // Two timestamps a day apart. Under `~~` on milliseconds the sign of the
        // result depends on where each value happens to fall modulo 2^32, so the
        // "newer" document can compare as older.
        const older = at(NOV_2023_MS);
        const newer = at(NOV_2023_MS + 86_400_000);
        expect(compareMtimeSeconds(newer, older)).toBeGreaterThan(0);
        expect(compareMtimeSeconds(older, newer)).toBeLessThan(0);
        expect(compareMtimeSeconds(newer, older)).toBe(86_400);
    });

    it('stays correct past 2038, when epoch SECONDS cross 2^31', () => {
        // Math.floor rather than `~~`: `~~` would reintroduce the 32-bit
        // truncation on the SECONDS value in 2038, wrapping it negative.
        const YEAR_2039_MS = 2_200_000_000_000;
        expect(Math.floor(YEAR_2039_MS / 1000)).toBeGreaterThan(2 ** 31);
        expect(compareMtimeSeconds(at(YEAR_2039_MS), at(0))).toBe(2_200_000_000);
        expect(compareMtimeSeconds(at(YEAR_2039_MS), at(0))).toBeGreaterThan(0);
    });

    it('treats a missing side as epoch zero', () => {
        // `undefined` means "there is no remote document", which must read as
        // infinitely old, not as "same time".
        expect(compareMtimeSeconds(at(NOV_2023_MS), undefined)).toBe(NOV_2023_MS / 1000);
        expect(compareMtimeSeconds(undefined, at(NOV_2023_MS))).toBe(-NOV_2023_MS / 1000);
        expect(compareMtimeSeconds(undefined, undefined)).toBe(0);

        // ...and far outside the dedup window, so a push against a missing
        // document never tries to compare content with a document that is not
        // there.
        expect(Math.abs(compareMtimeSeconds(at(NOV_2023_MS), undefined))).toBeGreaterThan(3600);
    });
});

// ===========================================================================
// 5. The state store
// ===========================================================================

describe('LiveSyncStateStore', () => {
    let tmp: TmpDir;
    let stateFile: string;

    beforeEach(async () => {
        tmp = await makeTmpDataDir();
        stateFile = path.join(tmp.dataDir, 'livesync-state.json');
    });

    afterEach(async () => {
        await tmp.cleanup();
    });

    const NS_A = 'ns-a';
    const NS_B = 'ns-b';

    /** Flush immediately on demand; nothing here relies on the debounce timer. */
    function store(namespace: string, opts: StateStoreOptions = {}): LiveSyncStateStore {
        return new LiveSyncStateStore(namespace, { file: stateFile, ...opts });
    }

    it('reports a first run as a reset, with a reason', () => {
        // "reset" is not an error here, but it IS an announcement: it means the
        // peers must do a full offline scan and replay the changes feed from the
        // beginning rather than from "now".
        return store(NS_A)
            .load()
            .then((res) => {
                expect(res.reset).toBe(true);
                expect(res.reason).toBeTruthy();
            });
    });

    it('survives a flush and a reload with the file-stat baselines intact', async () => {
        const a = store(NS_A);
        await a.load();
        a.setFileStat('note.md', '1700000000000-42');
        a.setFileStat('folder/deep note.md', '1700000001000-7');
        a.setFileStat('_attachments/foo.png', '1700000002000-1024');
        a.setSince('seq-1234');
        a.setRemoteCreated('1699999999999');
        await a.flush();

        const b = store(NS_A);
        const res = await b.load();
        expect(res.reset).toBe(false);
        expect(res.reason).toBeUndefined();
        expect(b.isLoaded()).toBe(true);

        // The baselines are the offline-change detector AND the storage side's
        // echo suppressor. Losing them across a restart means a full re-push of
        // the vault, and (before FIX 9) resurrected notes.
        expect(b.getFileStat('note.md')).toBe('1700000000000-42');
        expect(b.getFileStat('folder/deep note.md')).toBe('1700000001000-7');
        expect(b.getFileStat('_attachments/foo.png')).toBe('1700000002000-1024');
        expect(b.trackedCount()).toBe(3);
        expect(b.trackedPaths().sort()).toEqual(
            ['_attachments/foo.png', 'folder/deep note.md', 'note.md'],
        );

        // The checkpoint is the other half: without it a restart either resumes
        // from "now" (losing every change made while down) or rescans everything.
        expect(b.getSince()).toBe('seq-1234');
        expect(b.getRemoteCreated()).toBe('1699999999999');
    });

    it('a missing checkpoint reads as "from the beginning", never as "now"', async () => {
        // Empty string, not the string "now". The bridge defaults to "now", which
        // combined with never advancing `since` means an hour of downtime is an
        // hour of changes that reach the filesystem side never: CouchDB has
        // already delivered those sequences to nobody, and no later event repairs
        // it.
        const a = store(NS_A);
        await a.load();
        expect(a.getSince()).toBe('');
        expect(a.getRemoteCreated()).toBe('');
    });

    it('persists a deletion of a baseline', async () => {
        const a = store(NS_A);
        await a.load();
        a.setFileStat('gone.md', '1-1');
        a.setFileStat('stays.md', '2-2');
        await a.flush();

        a.deleteFileStat('gone.md');
        await a.flush();

        const b = store(NS_A);
        await b.load();
        expect(b.getFileStat('gone.md')).toBeUndefined();
        expect(b.getFileStat('stays.md')).toBe('2-2');
        expect(b.trackedPaths()).toEqual(['stays.md']);
    });

    it('close() flushes a still-pending debounced write', async () => {
        // The debounce exists so a bulk edit of a 30k-file vault is not 30k
        // full-file rewrites. The unconditional flush on shutdown is what stops
        // that optimisation from losing the last window's worth of state on a
        // clean stop.
        const a = store(NS_A, { flushDelayMs: 60_000 });
        await a.load();
        a.setFileStat('note.md', '1700000000000-42');
        // Nothing on disk yet: the timer is still pending.
        await expect(fs.readFile(stateFile, 'utf8')).rejects.toThrow();

        await a.close();

        const b = store(NS_A);
        await b.load();
        expect(b.getFileStat('note.md')).toBe('1700000000000-42');
    });

    it('does not schedule further writes after close()', async () => {
        // Shutdown must actually be a shutdown: a store that kept arming timers
        // after close() would keep the process's event loop busy during the exact
        // window in which it is trying to exit, and the engine already leaks a
        // socket and a timer past its own close().
        const a = store(NS_A, { flushDelayMs: 5 });
        await a.load();
        a.setFileStat('before-close.md', '1-1');
        await a.close();
        expect(await fs.readFile(stateFile, 'utf8')).toContain('before-close.md');

        a.setFileStat('after-close.md', '9-9');
        // The value is still readable in memory (close() does not blind the
        // store), but no timer was armed, so nothing reaches the disk on its own.
        expect(a.getFileStat('after-close.md')).toBe('9-9');
        await new Promise((resolve) => setTimeout(resolve, 50));
        const raw = await fs.readFile(stateFile, 'utf8');
        expect(raw).not.toContain('after-close.md');
        expect(raw).toContain('before-close.md');
    });

    it('writes the file with owner-only permissions', async () => {
        // The file contains every vault path. No credentials, but the vault
        // layout is not public either, and the rest of data/ is 0600.
        const a = store(NS_A);
        await a.load();
        a.setFileStat('note.md', '1-1');
        await a.flush();
        const stat = await fs.stat(stateFile);
        // Windows does not implement POSIX mode bits, so assert only where the
        // assertion means something. The mode is passed to writeFile either way.
        if (process.platform !== 'win32') {
            expect(stat.mode & 0o777).toBe(0o600);
        } else {
            expect(stat.isFile()).toBe(true);
        }
    });

    describe('namespace', () => {
        it('is a composite of the resolved vault root and the baseDir', () => {
            const root = path.join(tmp.dataDir, 'vault');
            expect(LiveSyncStateStore.namespaceFor(root, '')).toBe(
                LiveSyncStateStore.namespaceFor(root, ''),
            );
            // baseDir is part of the identity: the recorded stats and the
            // sequence describe a different subtree once it changes.
            expect(LiveSyncStateStore.namespaceFor(root, '')).not.toBe(
                LiveSyncStateStore.namespaceFor(root, 'sub'),
            );
            // The vault root is part of it: pointing the server at a different
            // vault must not inherit the first vault's baselines.
            expect(LiveSyncStateStore.namespaceFor(root, '')).not.toBe(
                LiveSyncStateStore.namespaceFor(path.join(tmp.dataDir, 'other-vault'), ''),
            );
        });

        it('resolves the vault root, so a relative spelling is the same identity', () => {
            // Two settings files that name the same directory differently must
            // not each get their own half of the state.
            expect(LiveSyncStateStore.namespaceFor('.', 'sub')).toBe(
                LiveSyncStateStore.namespaceFor(path.resolve('.'), 'sub'),
            );
            expect(LiveSyncStateStore.namespaceFor('.', '')).toContain(path.resolve('.'));
        });

        it('takes only the vault root and the baseDir, never the peer name', () => {
            // Asserted through the signature rather than a value: the bridge
            // encodes the peer NAME in every key, so renaming "couch" to
            // "couchdb" throws away a valid checkpoint and triggers a full
            // rescan with no explanation. A name is a log label, not an identity.
            expect(LiveSyncStateStore.namespaceFor.length).toBe(2);
        });

        it('a mismatch is an ANNOUNCED reset naming both sides, not a silent discard', async () => {
            const a = store(NS_A);
            await a.load();
            a.setFileStat('note.md', '1-1');
            a.setSince('seq-999');
            await a.flush();

            const b = store(NS_B);
            const res = await b.load();

            // Announced...
            expect(res.reset).toBe(true);
            expect(res.reason).toContain(NS_A); // what was stored
            expect(res.reason).toContain(NS_B); // what we are now

            // ...and genuinely discarded, not partially inherited. Half-inheriting
            // (keeping the checkpoint but not the stats, or vice versa) is the
            // dangerous middle: the feed resumes mid-history against baselines
            // that describe a different tree.
            expect(b.getFileStat('note.md')).toBeUndefined();
            expect(b.trackedCount()).toBe(0);
            expect(b.getSince()).toBe('');
        });

        it('the next flush after a mismatch rewrites the file under the new namespace', async () => {
            const a = store(NS_A);
            await a.load();
            a.setFileStat('old.md', '1-1');
            await a.flush();

            const b = store(NS_B);
            await b.load();
            b.setFileStat('new.md', '2-2');
            await b.flush();

            const raw = JSON.parse(await fs.readFile(stateFile, 'utf8')) as {
                namespace: string;
                fileStats: Record<string, string>;
            };
            expect(raw.namespace).toBe(NS_B);
            expect(raw.fileStats).toEqual({ 'new.md': '2-2' });
        });
    });

    describe('unreadable state', () => {
        it('treats invalid JSON as a reset and leaves the file for inspection', async () => {
            await fs.writeFile(stateFile, '{ this is not json', 'utf8');
            const a = store(NS_A);
            const res = await a.load();
            expect(res.reset).toBe(true);
            expect(res.reason).toContain('JSON');
            // Not deleted: the next flush overwrites it anyway, and leaving it
            // lets an operator see what went wrong.
            await expect(fs.readFile(stateFile, 'utf8')).resolves.toContain('not json');
        });

        it('treats a version mismatch as a reset', async () => {
            await fs.writeFile(
                stateFile,
                JSON.stringify({
                    version: 999,
                    namespace: NS_A,
                    since: 'seq-1',
                    remoteCreated: '',
                    fileStats: { 'note.md': '1-1' },
                }),
                'utf8',
            );
            const a = store(NS_A);
            const res = await a.load();
            expect(res.reset).toBe(true);
            expect(res.reason).toContain('999');
            expect(a.getSince()).toBe('');
            expect(a.trackedCount()).toBe(0);
        });

        it('ignores non-string entries inside fileStats rather than adopting them', async () => {
            // The file is operator-editable and survives version upgrades, so a
            // malformed entry must not become a baseline that no real stat can
            // ever equal (which would re-push that file on every single scan).
            await fs.writeFile(
                stateFile,
                JSON.stringify({
                    version: 1,
                    namespace: NS_A,
                    since: 'seq-1',
                    remoteCreated: '',
                    fileStats: { good: '1-1', bad: 42, alsoBad: null },
                }),
                'utf8',
            );
            const a = store(NS_A);
            const res = await a.load();
            expect(res.reset).toBe(false);
            expect(a.getFileStat('good')).toBe('1-1');
            expect(a.getFileStat('bad')).toBeUndefined();
            expect(a.trackedPaths()).toEqual(['good']);
        });
    });
});

// ===========================================================================
// Configuration validation and remote-tweak adoption
// ===========================================================================

/**
 * Both of these are pure and both encode a refusal that the bridge does not
 * make. They are in scope here because getting either wrong corrupts a vault or
 * publishes it: the first decides whether E2EE is honoured or bypassed (KICKOFF
 * section 8's first non-negotiable acceptance criterion), and the second decides
 * whether a passphrase typo stops the peer or retries forever behind a promise
 * that never resolves.
 */
describe('validateCouchDBConf', () => {
    it('accepts a well-formed configuration', () => {
        expect(validateCouchDBConf(couchConf())).toEqual([]);
    });

    it('requires a URL and a database name', () => {
        expect(validateCouchDBConf(couchConf({ url: '' })).join(' ')).toContain('URL is required');
        expect(validateCouchDBConf(couchConf({ url: '   ' })).join(' ')).toContain('URL is required');
        expect(validateCouchDBConf(couchConf({ database: '' })).join(' ')).toContain('database name is required');
    });

    it('rejects a non-http scheme', () => {
        expect(validateCouchDBConf(couchConf({ url: 'ftp://couch.example.test' })).join(' ')).toContain(
            'must be http or https',
        );
        expect(validateCouchDBConf(couchConf({ url: 'not a url' })).join(' ')).toContain('not a valid URL');
    });

    it('never echoes credentials back in an error message', () => {
        // The natural way to write "your URL is malformed" is to quote the URL,
        // and a CouchDB URL is https://user:password@host.
        const errs = validateCouchDBConf(
            couchConf({ url: 'ftp://syncuser:hunter2-should-never-be-logged@couch.example.test' }),
        );
        expect(errs.join(' ')).not.toContain('hunter2-should-never-be-logged');
    });

    it('rejects path obfuscation without an encryption passphrase', () => {
        // Obfuscation alone hides the document IDs and passes the eyeball test
        // while the document BODY still carries path, mtime and size in
        // plaintext. The operator has paid the whole cost of opaque ids for
        // nothing, so this is refused rather than warned about.
        const errs = validateCouchDBConf(couchConf({ obfuscatePassphrase: 'obf', passphrase: undefined }));
        expect(errs.join(' ')).toContain('requires an end-to-end encryption passphrase');

        // With both set it is valid: this is the configuration KICKOFF section 8
        // requires for the opaque-document-id acceptance criterion.
        expect(validateCouchDBConf(couchConf({ obfuscatePassphrase: 'obf', passphrase: 'e2ee' }))).toEqual([]);
    });

    it('rejects includeInternal outright', () => {
        // Writing an `.obsidian/plugins/<id>/main.js` received from a remote peer
        // is remote code execution in every browser that opens the vault:
        // services/plugins.ts serves that file to the SPA to execute.
        const errs = validateCouchDBConf(couchConf({ includeInternal: ['.obsidian/**'] }));
        expect(errs.join(' ')).toContain('includeInternal is not supported');
        expect(validateCouchDBConf(couchConf({ includeInternal: [] }))).toEqual([]);
    });

    it('reports every problem at once', () => {
        // Returned rather than thrown so a settings route can surface all of them
        // in one save, instead of the operator fixing one per round trip.
        const errs = validateCouchDBConf(
            couchConf({ url: '', database: '', obfuscatePassphrase: 'obf', passphrase: undefined }),
        );
        expect(errs.length).toBeGreaterThanOrEqual(3);
    });
});

describe('mergeRemoteTweaks', () => {
    it('adopts chunking settings and reports what changed', () => {
        const { merged, changes } = mergeRemoteTweaks(couchConf({ customChunkSize: 1 }), {
            'node-a': { customChunkSize: 4, minimumChunkSize: 20, useEden: true },
        });
        expect(merged.customChunkSize).toBe(4);
        expect(merged.minimumChunkSize).toBe(20);
        expect(merged.useEden).toBe(true);
        expect(changes.join(' ')).toContain('customChunkSize');
    });

    it('is a no-op when the remote has no tweaks at all', () => {
        const conf = couchConf();
        const { merged, changes } = mergeRemoteTweaks(conf, {});
        expect(merged).toBe(conf);
        expect(changes).toEqual([]);
    });

    it('never adopts encryption, obfuscation or compression', () => {
        // Silently turning encryption ON would write chunks this peer cannot read
        // back after a restart; silently turning it OFF would publish the vault
        // in plaintext. Neither is a setting to inherit from the wire.
        const { merged } = mergeRemoteTweaks(couchConf({ passphrase: 'e2ee', obfuscatePassphrase: 'obf' }), {
            'node-a': { encrypt: true, usePathObfuscation: true, customChunkSize: 9 },
        });
        expect(merged.customChunkSize).toBe(9);
        expect('encrypt' in merged).toBe(false);
        expect('usePathObfuscation' in merged).toBe(false);
    });

    it('is FATAL when the remote is encrypted and no passphrase is set', () => {
        // Fatal rather than retryable: the bridge throws this inside its connect
        // loop, so a passphrase typo retries every 30 seconds forever while the
        // log fills with failures that look transient.
        expect(() =>
            mergeRemoteTweaks(couchConf({ passphrase: undefined }), { 'node-a': { encrypt: true } }),
        ).toThrow(LiveSyncFatalError);
    });

    it('is FATAL when the remote obfuscates paths and no obfuscation passphrase is set', () => {
        expect(() =>
            mergeRemoteTweaks(couchConf({ passphrase: 'e2ee', obfuscatePassphrase: undefined }), {
                'node-a': { usePathObfuscation: true },
            }),
        ).toThrow(LiveSyncFatalError);
    });

    it('is FATAL on a compression mismatch, in both directions', () => {
        // A mismatch means every chunk we write is unreadable to the other
        // clients and theirs to us: divergence that looks like successful sync.
        expect(() =>
            mergeRemoteTweaks(couchConf({ enableCompression: false }), {
                'node-a': { enableCompression: true },
            }),
        ).toThrow(LiveSyncFatalError);
        expect(() =>
            mergeRemoteTweaks(couchConf({ enableCompression: true }), {
                'node-a': { enableCompression: false },
            }),
        ).toThrow(LiveSyncFatalError);
    });

    it('treats absent and false compression as the same setting', () => {
        // `undefined` and `false` both mean "off". Comparing them strictly would
        // make a default config fatal against a remote that spells the default
        // out explicitly.
        expect(() =>
            mergeRemoteTweaks(couchConf(), { 'node-a': { enableCompression: false } }),
        ).not.toThrow();
    });
});

// ===========================================================================
// Credential hygiene and the shared path filter
// ===========================================================================

describe('describeError', () => {
    it('strips credentials from a CouchDB URL inside an error', () => {
        // PouchDB embeds the request URL in its error messages, and a CouchDB URL
        // carries user:password. Every error leaving the subsystem goes through
        // here before it reaches a log line or an API response.
        const e = new Error('request to https://syncuser:hunter2@couch.example.test/vault failed');
        const out = describeError(e);
        expect(out).not.toContain('hunter2');
        expect(out).toContain('***@couch.example.test');
    });

    it('handles a non-Error throw without losing the redaction', () => {
        expect(describeError('failed against https://u:p@host/db')).toBe('failed against https://***@host/db');
        expect(describeError(undefined)).toBe('undefined');
    });
});

describe('isIgnoredVaultPath', () => {
    it('excludes the directories the server executes or reads as its own config', () => {
        // .obsidian is served to the SPA to execute (services/plugins.ts) and
        // .git is handed to the git backend. A remote peer must not be able to
        // write into either.
        expect(isIgnoredVaultPath('.obsidian/plugins/x/main.js')).toBe(true);
        expect(isIgnoredVaultPath('.git/config')).toBe(true);
        expect(isIgnoredVaultPath('node_modules/pkg/index.js')).toBe(true);
        expect(isIgnoredVaultPath('.trash/deleted.md')).toBe(true);
        expect(isIgnoredVaultPath('nested/.git/config')).toBe(true);
    });

    it('excludes every dot-prefixed segment, not just the named ones', () => {
        // resolveInVault refuses all of them. Without agreeing up front, the
        // startup scan would find `.hidden.md`, fail to resolve it while reading,
        // conclude the file is gone, and dispatch a DELETE for a file that is
        // sitting right there.
        expect(isIgnoredVaultPath('.hidden.md')).toBe(true);
        expect(isIgnoredVaultPath('folder/.hidden/note.md')).toBe(true);
        expect(isIgnoredVaultPath('')).toBe(true);
    });

    it('allows ordinary notes, including leading-underscore paths', () => {
        expect(isIgnoredVaultPath('note.md')).toBe(false);
        expect(isIgnoredVaultPath('folder/a note.md')).toBe(false);
        expect(isIgnoredVaultPath('_attachments/foo.png')).toBe(false);
        // A file whose NAME merely contains a dot is fine; only a segment that
        // starts with one is excluded.
        expect(isIgnoredVaultPath('folder/my.notes.md')).toBe(false);
    });
});
