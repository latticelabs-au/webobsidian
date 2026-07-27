/**
 * The filesystem side of the pair: a port of the reference bridge's
 * `PeerStorage` (reference/livesync-bridge/PeerStorage.ts).
 *
 * ONLY the chokidar branch is ported. The bridge has two watch implementations
 * and picks between them with `useChokidar`; the `Deno.watchFs` branch skips the
 * `isChanged()` gate entirely, so every filesystem event it sees is pushed
 * whether the file changed or not, including the events caused by our own
 * inbound writes. That branch is not a fallback worth having.
 *
 * ARCHITECTURAL CHANGE, and the answer to KICKOFF section 5.4's open question:
 * this peer does NOT create a watcher. WebObsidian already runs one chokidar
 * watcher over the vault in `server/src/index.ts`, with an ignore list the bridge
 * lacks (`.git`, `.obsidian`, `node_modules`, `.trash`), an `awaitWriteFinish`
 * window, and a self-healing fallback to polling when the host's inotify limit is
 * too low. A second watcher over the same tree would mean two independent
 * debounce windows over one file (so an editor's write-truncate-write can be
 * observed as complete by one and incomplete by the other), twice the inotify
 * budget on a large vault, and two places to fix the next watcher bug. Instead
 * this peer exposes `onVaultEvent()`, and `index.ts`'s existing `onChange`
 * fanout (already the single point where filesystem events reach the search
 * index, the link graph, the file index and the websocket broadcast) drives it.
 * The startup offline scan stays here, because that is this peer's own business
 * and nothing else in the server does it.
 *
 * Five of the eleven reference defects live in this file. Each fix is marked
 * FIX <n> at its site: 1 (stat.isFile is a method in Node), 2 (utimes must
 * precede the stat baseline), 6 (short writes truncate the file), 8 (content read
 * before the debounce), and 9 (offline deletions were never detected).
 *
 * FIX 9 is the one addition the bridge has no counterpart for, and adding it
 * introduced a hazard of its own: a scan that infers deletions by DIFFERENCE has
 * to be careful which two sets it is differencing, because this peer runs
 * concurrently with an inbound replication stream that creates files the whole
 * time the scan is walking. Two follow-on fixes close that, marked FIX 9a (the
 * baseline snapshot is taken before the walk, not after) and FIX 9b (a deletion
 * is dispatched only on positive, freshly re-checked evidence of absence). Both
 * are argued at length at their sites, because getting this wrong deletes real
 * notes on every other peer in the cluster and the symptom shows up somewhere
 * else entirely.
 */
import { promises as fs } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isPlainText } from 'livesync-engine';
import { getVaultRoot, resolveInVault, toRel } from '../vault.js';
import { HealthTracker, type PeerHealth } from './health.js';
import { EchoSuppressor, type LiveSyncStateStore } from './state.js';
import {
    describeError,
    type DispatchFn,
    type FileData,
    type LiveSyncLogger,
    type LiveSyncStorageConf,
} from './types.js';

/** What the vault watcher observed. Only a hint: the handler re-reads reality. */
export type VaultEventKind = 'add' | 'change' | 'unlink';

/**
 * The outcome of trying to read a vault file.
 *
 * `missing` is the only value that may be turned into a deletion. `skip` covers
 * everything that is not a syncable regular file (a directory, a symlink, an
 * unreadable file, a path the vault layer refuses), none of which is evidence
 * that a note was deleted.
 */
type ReadResult =
    | { kind: 'file'; data: FileData; baseline: string }
    | { kind: 'missing' }
    | { kind: 'skip' };

/** Default trailing debounce, matched to index.ts's `awaitWriteFinish` window. */
const DEFAULT_DEBOUNCE_MS = 300;

/** Concurrency ceiling for the startup scan, so it cannot starve the event loop. */
const SCAN_CONCURRENCY = 8;

/**
 * Directory names this peer never touches, in either direction.
 *
 * Mirrors the ignore predicate in `index.ts`'s watcher, which is the authority:
 * events for these paths never reach `onVaultEvent()` in the first place, so
 * this copy only governs OUR OWN startup scan and our own inbound writes. It is
 * duplicated rather than imported because `index.ts` is the composition root and
 * importing from it would make this module depend on the whole server graph;
 * if the watcher's list changes, change this one too.
 *
 * Each name earns its place. `.git` and `.obsidian` are executed or read as this
 * server's own configuration (see PROTECTED_DIRS in services/vault.ts).
 * `node_modules` is dependency code. `.trash` is where deleted notes go, and
 * replicating it would push every deletion back out as a new file.
 */
const IGNORED_SEGMENT = /(^|\/)(\.git|\.obsidian|node_modules|\.trash)(\/|$)/;

/**
 * True when a vault-relative path must not take part in sync, in either
 * direction.
 *
 * Two rules, and the second one is not optional. Any DOT-PREFIXED segment is
 * excluded, because `resolveInVault` refuses every one of them
 * (`assertSegmentsAllowed`), so a dot path can be neither written from CouchDB
 * nor, if this filter let it through, read for a push. Agreeing with the
 * boundary up front rather than discovering it at the boundary is what keeps the
 * two directions consistent: without this rule the startup scan would find
 * `.hidden.md`, fail to resolve it while reading, conclude the file is gone, and
 * dispatch a DELETE for a file that is sitting right there.
 */
export function isIgnoredVaultPath(rel: string): boolean {
    if (!rel) return true;
    const posix = rel.split(path.sep).join('/');
    if (IGNORED_SEGMENT.test(posix)) return true;
    return posix.split('/').some((segment) => segment.startsWith('.'));
}

export interface StoragePeerDeps {
    state: LiveSyncStateStore;
    /** Hand a local change to the CouchDB peer. */
    dispatch: DispatchFn;
    log?: LiveSyncLogger;
}

export class StoragePeer {
    readonly type = 'storage' as const;

    private readonly conf: LiveSyncStorageConf;
    private readonly deps: StoragePeerDeps;
    private readonly log: LiveSyncLogger;
    private readonly state: LiveSyncStateStore;
    private readonly echo = new EchoSuppressor();
    private readonly tracker: HealthTracker;
    private readonly debounceMs: number;

    private started = false;
    private scanning = false;
    private stopping = false;

    /** Pending debounce timer per path. */
    private readonly timers = new Map<string, NodeJS.Timeout>();
    /**
     * Tail of the work queue per path.
     *
     * Per PATH rather than one global lock: two different files have nothing to
     * serialise against each other, and a global queue would make one slow
     * attachment upload stall every note. Per path is exactly the granularity
     * that matters, because the hazard being prevented is two overlapping reads
     * or writes of the SAME file. This replaces the bridge's
     * `scheduleOnceIfDuplicated`.
     */
    private readonly queues = new Map<string, Promise<void>>();

    constructor(conf: LiveSyncStorageConf, deps: StoragePeerDeps) {
        this.conf = conf;
        this.deps = deps;
        this.state = deps.state;
        this.log = deps.log ?? (() => {});
        this.debounceMs = conf.debounceMs ?? DEFAULT_DEBOUNCE_MS;
        // No backend probe: a storage peer has no remote, so `backendUp` is
        // always true and the HealthTracker default applies.
        this.tracker = new HealthTracker(() => this.snapshot());
    }

    // --- lifecycle -------------------------------------------------------------

    /**
     * Accept events and (optionally) reconcile with what happened while we were
     * down.
     *
     * `started` is set BEFORE the scan so that events arriving during it are not
     * dropped: they go through the same per-path queue as the scan's own work, so
     * ordering per file is preserved either way. Health stays not-ok until the
     * scan finishes, which is what keeps a supervisor from judging a peer that is
     * still catching up (see HealthTracker: never-ok is never restart-worthy).
     */
    async start(): Promise<void> {
        this.stopping = false;
        this.started = true;
        if (this.conf.scanOfflineChanges === false) {
            this.log('offline change scan: disabled');
            return;
        }
        await this.runOfflineScan();
    }

    async stop(): Promise<void> {
        this.stopping = true;
        this.started = false;
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        // Let in-flight work finish rather than abandoning it half-written: every
        // queued unit either completes a write or completes a dispatch, and both
        // are short.
        await Promise.allSettled([...this.queues.values()]);
        this.tracker.reset();
    }

    // --- inbound: the vault watcher drives this --------------------------------

    /**
     * Called by `index.ts`'s watcher fanout for every vault event.
     *
     * Deliberately fire-and-forget and deliberately kind-agnostic. The kind is
     * only a hint for the log: by the time the debounce expires the file may have
     * been created, changed and deleted again, so the handler asks the filesystem
     * what is true now rather than trusting an event from 300ms ago. That also
     * makes a missed or duplicated event harmless.
     */
    onVaultEvent(relPath: string, kind: VaultEventKind = 'change'): void {
        if (!this.started || this.stopping) return;
        const rel = normaliseRel(relPath);
        if (!rel || isIgnoredVaultPath(rel)) return;

        const existing = this.timers.get(rel);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
            this.timers.delete(rel);
            void this.enqueue(rel, () => this.processPath(rel, kind));
        }, this.debounceMs);
        timer.unref?.();
        this.timers.set(rel, timer);
    }

    /**
     * Walk the vault and reconcile it with the recorded baselines.
     *
     * Also exposed for the CouchDB peer's reconnect hook: a local edit made while
     * CouchDB was unreachable was refused by the dispatch and therefore never had
     * its baseline advanced, so re-running this scan is what recovers it without
     * a process restart.
     */
    async runOfflineScan(): Promise<void> {
        if (this.scanning) return;
        this.scanning = true;
        const startedAt = Date.now();
        try {
            const root = await getVaultRoot();

            /*
             * FIX 9: deletions that happened while we were down.
             *
             * The bridge's scan only walks the filesystem and asks "is this file
             * changed?", so a file deleted while the daemon was down is simply
             * never visited. It stays in CouchDB, and the first changes-feed
             * replay writes it back to disk. Deleting a note and finding it
             * resurrected on the next restart is the most alarming failure a sync
             * tool can produce, and it is silent.
             *
             * The recorded baselines are the missing half of the picture: they
             * name every file we believed existed. Whatever is in that set and not
             * on disk was deleted while we were not looking.
             *
             * FIX 9a: THE SNAPSHOT IS TAKEN HERE, BEFORE THE WALK, AND THAT
             * ORDERING IS THE ENTIRE CORRECTNESS OF THE DELETION CHECK BELOW.
             *
             * `seen` describes the tree DURING the walk; `trackedPaths()`
             * describes our beliefs at the instant it is read. Reading the
             * baselines AFTER the walk compares two snapshots taken at different
             * times, and the difference between them is not "files that were
             * deleted", it is "files that were deleted, PLUS every file that
             * appeared while the walk was in progress". Nothing about this peer
             * makes that second set empty. The opposite: this scan runs
             * concurrently with the CouchDB peer's changes feed by construction
             * (`ensureRunning` starts both peers without either awaiting the
             * other, and `onConnected` re-runs the scan on every reconnect), so
             * the inbound pull is writing files and recording their baselines the
             * whole time the walk is running. Any file whose baseline lands after
             * the walk has passed its directory is therefore in `tracked` and not
             * in `seen`, and was reported as a deletion.
             *
             * That is not a cosmetic misreport. `processDelete` dispatches it, the
             * CouchDB peer soft-deletes the document, and every other client in
             * the cluster removes the note. Measured against a real vault: a full
             * pull of 2731 documents into an empty vault dispatched deletes for
             * the files written during the walk, and a handful of them came back
             * down the feed after the storage side had already re-pushed and so
             * overwritten the echo entry that was supposed to suppress them, at
             * which point the local file was deleted too and nothing ever brought
             * it back (the feed had moved past that document, and a vault with no
             * file and no baseline is invisible to every later scan). The
             * documents were still in CouchDB, undeleted, which is what made it
             * look like the pull had never delivered them.
             *
             * Taking the snapshot first inverts the asymmetry: a file that appears
             * during the walk is not in the snapshot, so it can never be a
             * deletion candidate, and a file genuinely deleted before the scan
             * began is in the snapshot and is still detected. The one case this
             * ordering gives up is a file deleted DURING the walk, which is
             * exactly the case the vault watcher already owns and which the next
             * scan would catch anyway.
             */
            const tracked = this.state.trackedPaths().filter((p) => !isIgnoredVaultPath(p));

            const seen = new Set<string>();
            const changed: string[] = [];

            for await (const rel of walkVault(root)) {
                seen.add(rel);
                if (await this.isChanged(rel)) changed.push(rel);
            }

            let missing = tracked.filter((p) => !seen.has(p));

            /*
             * Safety valve: an empty walk never means "the user deleted every
             * note".
             *
             * It means the vault path points somewhere else, or a network volume
             * is not mounted yet, or the directory was recreated empty. Acting on
             * that reading would dispatch a delete for every file we have ever
             * tracked, and CouchDB would faithfully replicate the emptying to
             * every other peer. The one-way nature of that mistake is why it is
             * guarded here rather than left to the operator to notice.
             *
             * Deliberately narrow: only the all-or-nothing case is refused. A
             * percentage threshold would also block a legitimate bulk delete, and
             * refusing real user actions is its own kind of broken.
             */
            if (seen.size === 0 && missing.length > 0) {
                this.log(
                    `offline scan found no files at all while tracking ${missing.length}. ` +
                        'Refusing to treat that as a mass deletion: check that the vault path is correct ' +
                        'and that its storage is mounted.',
                    'error',
                );
                missing = [];
            }

            if (changed.length || missing.length) {
                this.log(
                    `offline scan: ${changed.length} changed, ${missing.length} deleted while down ` +
                        `(${seen.size} files, ${Date.now() - startedAt}ms)`,
                    'notice',
                );
            } else {
                this.log(`offline scan: nothing to do (${seen.size} files, ${Date.now() - startedAt}ms)`);
            }

            await this.runBounded(changed, (rel) => this.enqueue(rel, () => this.processPath(rel, 'change')));
            await this.runBounded(missing, (rel) => this.enqueue(rel, () => this.processDelete(rel)));
        } catch (e) {
            // A scan failure is recoverable (the next one repeats the work), so it
            // must not stop the peer, but it does mean we are not caught up.
            this.log(`offline scan failed: ${describeError(e)}`, 'error');
        } finally {
            this.scanning = false;
        }
    }

    // --- outbound: the CouchDB peer drives this --------------------------------

    /**
     * Write a file that arrived from CouchDB.
     *
     * Returns false for a legitimate skip (an echo of our own push, or a path this
     * server refuses to host). THROWS when the write itself failed, because the
     * caller uses that to decide whether to advance the replication checkpoint:
     * a thrown error must leave the checkpoint where it is so the change is
     * replayed, while a refused path must not, or the same rejected document
     * would be replayed forever and pin the feed at that sequence.
     */
    async put(pathSrc: string, data: FileData): Promise<boolean> {
        const rel = normaliseRel(pathSrc);
        if (!rel || isIgnoredVaultPath(rel)) {
            this.log(`refusing inbound write to an excluded path: ${rel}`, 'notice');
            return false;
        }
        if (this.echo.isRepeating(rel, data)) {
            this.log(`${rel} inbound write is an echo; skipped`, 'debug');
            return false;
        }

        let abs: string;
        try {
            /*
             * The security boundary for remote input.
             *
             * `resolveInVault` is the same gate every HTTP file request passes
             * through, and a CouchDB peer is exactly as untrusted as an HTTP
             * client: the path in the document was written by some other machine.
             * It refuses traversal, absolute paths, NUL bytes, Windows alternate
             * data streams (`note.md:hidden.js`), dot-prefixed segments and the
             * protected `.git`/`.obsidian` directories. Bypassing it for
             * "internal" file replication would hand any peer on the cluster the
             * ability to write `.obsidian/plugins/<id>/main.js`, which this
             * server then serves to every browser that opens the vault to
             * execute. There is no version of that trade worth making.
             */
            abs = await resolveInVault(rel);
        } catch (e) {
            this.log(`refusing inbound write to ${rel}: ${describeError(e)}`, 'notice');
            return false;
        }

        const root = await getVaultRoot();
        if (abs === root) {
            this.log('refusing inbound write that resolves to the vault root', 'notice');
            return false;
        }

        const dir = path.dirname(abs);
        await fs.mkdir(dir, { recursive: true });

        /*
         * FIX 6: write the whole file, atomically.
         *
         * The bridge opens the file, calls `fp.write(...)` ONCE and then
         * `fp.truncate(writtenSize)`. A short write (large attachment, slow or
         * full disk, a pipe-like filesystem) writes fewer bytes than requested,
         * and the truncate then cuts the file to that short length and calls it
         * done. The file is silently corrupt and, worse, its new mtime/size is
         * recorded as the synced baseline, so nothing ever re-pushes it. It also
         * writes in place, so a reader (this server's own API, the search
         * indexer, a user's editor) can observe a half-written note.
         *
         * `fs.writeFile` loops internally until every byte is written, and
         * write-to-temp-then-rename means a reader sees either the old file or
         * the new one. Same pattern as `vault.ts`'s `writeFileText`, including
         * the random suffix: two writes of the same path within one millisecond
         * would otherwise pick the same temp name and interleave their bytes.
         */
        const tmp = path.join(dir, `.${path.basename(abs)}.livesync-${Date.now()}-${randomBytes(6).toString('hex')}`);
        try {
            const body = data.data instanceof Uint8Array ? Buffer.from(data.data) : Buffer.from(joinChunks(data.data), 'utf8');
            await fs.writeFile(tmp, body);

            /*
             * FIX 2: the mtime must be stamped BEFORE the stat baseline is taken,
             * and here that ordering is structural rather than a convention.
             *
             * The invariant: `writeFileStat()` re-stats the file and records
             * `mtime-size` as the echo-suppression baseline, and `utime()` changes
             * the mtime. Take the baseline first and it describes a file that no
             * longer exists: the watcher event caused by our own write then
             * compares as changed, the file is pushed back to CouchDB, that push
             * returns as a change, and the document churns a new revision forever
             * with no user involved.
             *
             * The bridge gets this right in `put()` (utime, then writeFileStat)
             * and wrong in `dispatch()`, where the baseline is written before the
             * debounce window that the content is read after (see FIX 8 in
             * processPath). So it is a real hazard that the reference itself falls
             * into once, and it is one line away in either file.
             *
             * Making it impossible rather than remembered: the mtime is applied to
             * the TEMP file, `rename` preserves it, and the baseline is taken from
             * a stat of the final file afterwards. There is no ordering of these
             * statements that records a stale stat, because the stat does not
             * happen until after the file exists at its final path.
             */
            const stamp = new Date(data.mtime);
            await fs.utimes(tmp, stamp, stamp);
            await fs.rename(tmp, abs);
        } catch (e) {
            await fs.rm(tmp, { force: true }).catch(() => {});
            // Throw: the checkpoint must not advance past a change we failed to apply.
            throw new Error(`local write failed for ${rel}: ${describeError(e)}`);
        }

        await this.recordBaseline(rel);
        this.log(`${rel} saved`, 'debug');
        return true;
    }

    /**
     * Delete a file because CouchDB says it was deleted.
     *
     * Deliberately NOT routed through `vault.ts`'s `trash()`, even though that
     * would look like the safer choice. The trash root is operator-configurable,
     * and `index.ts`'s watcher only ignores the literal name `.trash`. With any
     * other trash root the "deleted" content reappears inside the vault at a
     * watched path, is observed as a new file, and is pushed straight back to
     * CouchDB, where every other peer materialises it too: a deletion loop that
     * multiplies the file instead of removing it. CouchDB keeps the tombstone and
     * the previous revisions, so recovery is a remote-side operation, which is
     * where the history actually lives.
     */
    async delete(pathSrc: string): Promise<boolean> {
        const rel = normaliseRel(pathSrc);
        if (!rel || isIgnoredVaultPath(rel)) return false;
        if (this.echo.isRepeating(rel, false)) {
            this.log(`${rel} inbound delete is an echo; skipped`, 'debug');
            return false;
        }

        let abs: string;
        try {
            abs = await resolveInVault(rel);
        } catch (e) {
            this.log(`refusing inbound delete of ${rel}: ${describeError(e)}`, 'notice');
            return false;
        }

        try {
            // Not recursive: a document names a FILE. `force` so a delete that
            // already happened locally is a success rather than an error, which is
            // the common case when two clients delete the same note.
            await fs.rm(abs, { force: true });
        } catch (e) {
            throw new Error(`local delete failed for ${rel}: ${describeError(e)}`);
        }
        this.state.deleteFileStat(rel);
        this.log(`${rel} deleted`, 'debug');
        return true;
    }

    /**
     * Read a vault file in the shape the engine wants.
     *
     * Returns false when the path is not a regular file, which covers both "it
     * was deleted between the event and now" and "it is a directory".
     */
    async get(pathSrc: string): Promise<false | FileData> {
        const read = await this.readFile(normaliseRel(pathSrc));
        return read.kind === 'file' ? read.data : false;
    }

    // --- internals -------------------------------------------------------------

    /**
     * Read content plus the stat that describes exactly the bytes we read.
     *
     * Returning both together is what lets the caller record a baseline that is
     * consistent with what it actually pushed. Stat first, then read: if the file
     * changes in between, the recorded baseline differs from the file on disk, so
     * the next scan re-detects it. The other order can record a baseline that
     * matches a file whose content we never sent.
     *
     * The three-way result is deliberate. "Missing" and "not something we sync"
     * must not collapse into one value, because the caller turns the first into a
     * DELETE dispatched to every other peer. A directory, an unreadable file or a
     * path the vault layer refuses is not evidence that anything was deleted.
     */
    private async readFile(rel: string): Promise<ReadResult> {
        if (!rel || isIgnoredVaultPath(rel)) return { kind: 'skip' };
        let abs: string;
        try {
            abs = await resolveInVault(rel);
        } catch {
            // A path the vault refuses cannot be pushed either.
            return { kind: 'skip' };
        }

        let st: Stats;
        try {
            st = await fs.stat(abs);
        } catch (e) {
            // ENOENT is the only code that means "deleted"; anything else (EACCES,
            // ELOOP, EIO) means we simply could not look.
            return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'skip' };
        }
        /*
         * FIX 1: `isFile` is a METHOD in Node and a PROPERTY in Deno.
         *
         * The bridge writes `if (!stat.isFile) return false;`. Under Node that
         * tests a function object, which is always truthy, so the guard is dead in
         * every one of its four sites and directories flow straight into the file
         * paths: a directory would be "read" (EISDIR), stat'ed as a synced file,
         * and pushed as a zero-byte document. This is the most mechanical of the
         * eleven defects and the easiest to port faithfully by accident, which is
         * exactly why it is called out here rather than silently fixed.
         */
        if (!st.isFile()) return { kind: 'skip' };

        const data: FileData = {
            // birthtime is 0 on some Linux filesystems; vault.ts's own stat cache
            // makes the same substitution.
            ctime: Math.round(st.birthtimeMs || st.mtimeMs),
            mtime: Math.round(st.mtimeMs),
            size: st.size,
            data: [],
        };
        try {
            // `isPlainText` from the engine, not our own extension list, so that
            // the plain/binary decision here is the same one the CouchDB side
            // makes when it picks a document type.
            data.data = isPlainText(rel) ? [await fs.readFile(abs, 'utf8')] : new Uint8Array(await fs.readFile(abs));
        } catch (e) {
            return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'skip' };
        }
        return { kind: 'file', data, baseline: baselineOf(st.mtimeMs, st.size) };
    }

    /** Has this file changed since the last baseline we recorded for it? */
    private async isChanged(rel: string): Promise<boolean> {
        const last = this.state.getFileStat(rel);
        if (!last) return true;
        let abs: string;
        try {
            abs = await resolveInVault(rel);
        } catch {
            return false;
        }
        try {
            const st = await fs.stat(abs);
            if (!st.isFile()) return false; // FIX 1 again: method, not property.
            return baselineOf(st.mtimeMs, st.size) !== last;
        } catch {
            return false;
        }
    }

    /**
     * Is this path definitely absent from the vault right now?
     *
     * TRUE only on positive evidence of absence, which is ENOENT and nothing
     * else. `resolveInVault` tolerates a path that does not exist (it climbs to
     * the deepest existing ancestor to run its containment and segment rules), so
     * a throw from it means the path is refused rather than missing, and a refused
     * path is not evidence that a note was deleted. Every other stat error
     * (EACCES, EIO, ELOOP, a network mount that has gone away) means we could not
     * look, which is also not evidence.
     *
     * Deliberately narrower than `readFile`, which returns content and a
     * baseline. The only question here is existence, and asking it this way costs
     * one stat instead of a whole file read.
     */
    private async isGoneFromDisk(rel: string): Promise<boolean> {
        try {
            const abs = await resolveInVault(rel);
            await fs.stat(abs);
            return false;
        } catch (e) {
            return (e as NodeJS.ErrnoException)?.code === 'ENOENT';
        }
    }

    /** Record "this file is synced as of now", from a fresh stat. */
    private async recordBaseline(rel: string): Promise<void> {
        try {
            const abs = await resolveInVault(rel);
            const st = await fs.stat(abs);
            if (!st.isFile()) return;
            this.state.setFileStat(rel, baselineOf(st.mtimeMs, st.size));
        } catch (e) {
            // Losing a baseline costs one redundant push on the next scan, which
            // is the safe direction, so this is not fatal.
            this.log(`could not record the sync baseline for ${rel}: ${describeError(e)}`, 'debug');
        }
    }

    /**
     * One debounced unit of work for one path.
     *
     * FIX 8: the content is read HERE, inside the critical section, after the
     * debounce has expired.
     *
     * The bridge reads the file first and then schedules the delayed section
     * around the already-read bytes. A write landing inside that window is
     * therefore pushed as the OLD content, and worse, the stat baseline recorded
     * at the end of the section describes the NEW file: the new content is marked
     * as already synced and never pushed at all. The window is 250ms wide and
     * lands squarely on the write-truncate-write pattern editors use, so it is not
     * a theoretical race.
     */
    private async processPath(rel: string, kind: VaultEventKind): Promise<void> {
        const read = await this.readFile(rel);
        if (read.kind === 'missing') {
            // Gone: treat as a delete. This is why the handler does not trust the
            // event kind, only what the filesystem says now.
            await this.processDelete(rel);
            return;
        }
        if (read.kind === 'skip') return;
        if (this.echo.isRepeating(rel, read.data)) {
            this.log(`${rel} local change is an echo; skipped`, 'debug');
            return;
        }
        this.log(`${rel} ${kind} detected`, 'debug');
        try {
            await this.deps.dispatch(rel, read.data);
        } catch (e) {
            /*
             * Not delivered, so the baseline is deliberately NOT advanced.
             *
             * The bridge records the baseline before dispatching and ignores the
             * outcome, so an edit made while CouchDB is unreachable is marked
             * synced and is never sent: it survives only until something else
             * touches the file. Leaving the baseline stale means the next offline
             * scan (at startup, or on the CouchDB peer's reconnect) finds this
             * file again and pushes it.
             */
            this.log(`${rel} not dispatched: ${describeError(e)}`, 'notice');
            return;
        }
        this.state.setFileStat(rel, read.baseline);
    }

    private async processDelete(rel: string): Promise<void> {
        /*
         * FIX 9b: never dispatch a deletion on the strength of an old
         * observation. Ask the filesystem, now.
         *
         * The snapshot ordering above removes the systematic source of false
         * positives, but it cannot remove all of them, because there is still a
         * gap between the walk finishing and this unit of work actually running:
         * the scan processes the whole `changed` list first, and every one of
         * those is a file read plus a network round trip, so the gap is seconds
         * on a large vault and the inbound pull is writing files throughout it.
         * The same applies on the watcher path, where `processPath` observed an
         * ENOENT up to a debounce window ago and an editor's save is a rename
         * away and a rename back.
         *
         * A deletion is the one dispatch that cannot be walked back. It removes
         * the note from every other peer in the cluster, and CouchDB keeps only a
         * tombstone plus history, so recovery is a manual remote-side operation.
         * Every other mistake this peer can make costs a redundant push. So the
         * rule here is positive evidence only: dispatch the delete when the
         * filesystem says ENOENT, and in every other case (the file is back, the
         * path is unreadable, the volume is having a bad day) do nothing and let
         * the next scan decide with better information.
         */
        if (!(await this.isGoneFromDisk(rel))) {
            this.log(`${rel} is on disk after all; not dispatching a delete for it`, 'debug');
            return;
        }
        if (this.echo.isRepeating(rel, false)) return;
        this.log(`${rel} delete detected`, 'debug');
        try {
            await this.deps.dispatch(rel, false);
        } catch (e) {
            this.log(`${rel} delete not dispatched: ${describeError(e)}`, 'notice');
            return;
        }
        this.state.deleteFileStat(rel);
        // The path is gone: keeping its content hash would only occupy an LRU slot
        // that a live file needs.
        this.echo.forget(rel);
    }

    /** Append to this path's serial queue. */
    private enqueue(rel: string, work: () => Promise<void>): Promise<void> {
        const previous = this.queues.get(rel) ?? Promise.resolve();
        const next = previous
            .then(work)
            .catch((e: unknown) => {
                // The queue must survive one failed unit of work, or a single bad
                // file would stop that path forever.
                this.log(`${rel} failed: ${describeError(e)}`, 'error');
            })
            .finally(() => {
                // Only clear if nothing else was appended behind us.
                if (this.queues.get(rel) === next) this.queues.delete(rel);
            });
        this.queues.set(rel, next);
        return next;
    }

    /** Run `work` over `items` with a bounded number in flight. */
    private async runBounded(items: string[], work: (item: string) => Promise<void>): Promise<void> {
        let index = 0;
        const workers = Array.from({ length: Math.min(SCAN_CONCURRENCY, items.length) }, async () => {
            for (;;) {
                const i = index;
                index += 1;
                if (i >= items.length || this.stopping) return;
                await work(items[i]);
            }
        });
        await Promise.all(workers);
    }

    // --- health ----------------------------------------------------------------

    /**
     * `ok` means started and no longer catching up.
     *
     * The bridge reports `ok` when its watcher object exists. This peer does not
     * own a watcher, so it reports on what it does own: whether it is accepting
     * events and whether the offline scan has finished. The vault watcher's own
     * liveness stays `index.ts`'s business, which is right, because that watcher
     * serves the search index and the websocket broadcast too and already
     * self-heals to polling when native watching fails.
     */
    snapshot(): PeerHealth {
        const ok = this.started && !this.scanning;
        let detail: string;
        if (!this.started) detail = 'stopped';
        else if (this.scanning) detail = 'scanning offline changes';
        else detail = 'watching';
        return {
            name: this.conf.name,
            type: this.type,
            ok,
            detail,
            // No remote backend of its own.
            backendUp: true,
            restartWorthy: false,
        };
    }

    probeHealth(): Promise<PeerHealth> {
        return this.tracker.probe();
    }
}

// --- helpers -----------------------------------------------------------------

/** POSIX-style, no leading separator: the one spelling used as a state key. */
function normaliseRel(input: string): string {
    return input.split(path.sep).join('/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** The baseline string, `"<mtimeMs>-<size>"`, as the bridge stores it. */
function baselineOf(mtimeMs: number, size: number): string {
    // Rounded to whole milliseconds: some filesystems report sub-millisecond
    // precision, LiveSync's own metadata is whole milliseconds, and the inbound
    // write path sets the mtime from that whole-millisecond value. Comparing at a
    // finer resolution than we can ever write would make every scan report every
    // inbound file as changed.
    return `${Math.round(mtimeMs)}-${size}`;
}

/** Text documents are stored as an array of chunks; the file is their join. */
function joinChunks(data: string[]): string {
    return data.join('');
}

/**
 * Yield every vault-relative file path, skipping the ignored directories.
 *
 * Hand-rolled rather than `fs.readdir(recursive: true)` so that an ignored
 * directory is never DESCENDED INTO. On a vault with a `node_modules` or a large
 * `.git`, the recursive form enumerates every entry and then throws the results
 * away, which is the difference between a scan that takes milliseconds and one
 * that takes a minute.
 */
async function* walkVault(root: string): AsyncGenerator<string> {
    async function* walk(absDir: string): AsyncGenerator<string> {
        let entries: Dirent[];
        try {
            entries = await fs.readdir(absDir, { withFileTypes: true });
        } catch {
            // Unreadable directory: skip it rather than failing the whole scan.
            return;
        }
        for (const entry of entries) {
            const abs = path.join(absDir, entry.name);
            const rel = toRel(root, abs);
            if (isIgnoredVaultPath(rel)) continue;
            if (entry.isDirectory()) {
                yield* walk(abs);
            } else if (entry.isFile()) {
                // Symlinks are neither: `readdir` reports them as symlinks, and
                // following them would let a link inside the vault push a file
                // from outside it into the database.
                yield rel;
            }
        }
    }
    yield* walk(root);
}
