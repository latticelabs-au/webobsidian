/**
 * Persistent and in-memory state for the LiveSync backend.
 *
 * This module replaces the reference bridge's use of `localStorage`
 * (`Peer.setSetting`/`getSetting` in reference/livesync-bridge/Peer.ts). Deno
 * has `localStorage`; Node does not, so the port needs real storage. That is not
 * a mechanical substitution, because one of the three things the bridge keeps in
 * there is the CouchDB replication checkpoint: drop it and every restart either
 * resumes from "now" and permanently loses whatever changed while the process
 * was down, or rescans the entire database.
 *
 * Three logical keys, exactly as the bridge has them:
 *
 *  - `file-stat-<path>`: `"<mtimeMs>-<size>"` per vault file. Two jobs at once.
 *    It is the offline-change baseline (the startup scan pushes any file whose
 *    stat differs) AND the storage side's echo suppressor (a file we just wrote
 *    because CouchDB told us to has a matching baseline, so the watcher event it
 *    causes is recognised as our own).
 *  - `since`: the CouchDB changes-feed checkpoint.
 *  - `remote-created`: the remote milestone document's `created` timestamp, used
 *    to notice that the remote database was rebuilt from scratch and that the
 *    checkpoint therefore means nothing any more.
 *
 * Storage shape: ONE JSON file under `data/`, per CONTRIBUTING's "do not add a
 * DB engine" rule and matching `data/shares.json`, `data/uistate.json` and
 * friends. But `file-stat-*` is high-cardinality (one entry per vault file) and
 * written on every single file event, so serialising a whole JSON blob per event
 * would turn a bulk edit of a 30k-file vault into 30k full-file rewrites. Hence
 * an in-memory Map that is authoritative during the process's life, with a
 * debounced atomic flush behind it and an unconditional flush on shutdown.
 *
 * The file contains vault paths, so it is written 0600 like the rest of `data/`.
 * It contains no credentials, and nothing here should ever be given any.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { config } from '../../config.js';
import type { FileData, LiveSyncLogger } from './types.js';

/** Bumped only when the on-disk shape changes incompatibly (a bump discards state). */
const STATE_VERSION = 1;

/** Default location, alongside settings.json and the other runtime JSON files. */
export const DEFAULT_STATE_FILE = path.join(config.dataDir, 'livesync-state.json');

/** Default debounce before an in-memory change reaches the disk. */
const DEFAULT_FLUSH_DELAY_MS = 1500;

interface PersistedState {
    version: number;
    /** See `namespaceFor`. A mismatch discards everything below it. */
    namespace: string;
    since: string;
    remoteCreated: string;
    fileStats: Record<string, string>;
}

export interface StateStoreOptions {
    /** Override the state file location (tests, or a second vault). */
    file?: string;
    /** Override the debounce window. 0 flushes on the next tick. */
    flushDelayMs?: number;
    log?: LiveSyncLogger;
}

export interface StateLoadResult {
    /** True when nothing usable was inherited and the peers must start from zero. */
    reset: boolean;
    /** Why, for the log line. */
    reason?: string;
}

/**
 * The persisted half of a peer pair's memory.
 *
 * Load it once at startup, hand the same instance to both peers, and close it on
 * shutdown. Reads are synchronous because they happen inside the per-file hot
 * path; only `flush()`/`close()` touch the disk.
 */
export class LiveSyncStateStore {
    private readonly file: string;
    private readonly flushDelayMs: number;
    private readonly log?: LiveSyncLogger;

    /** The identity this state belongs to. See `namespaceFor`. */
    readonly namespace: string;

    private since = '';
    private remoteCreated = '';
    private fileStats = new Map<string, string>();

    private loaded = false;
    private dirty = false;
    private closed = false;
    private timer?: NodeJS.Timeout;
    /** Serialises writes so two flushes cannot interleave temp file and rename. */
    private writeChain: Promise<void> = Promise.resolve();

    constructor(namespace: string, opts: StateStoreOptions = {}) {
        this.namespace = namespace;
        this.file = opts.file ?? DEFAULT_STATE_FILE;
        this.flushDelayMs = opts.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
        this.log = opts.log;
    }

    /**
     * The identity a body of state belongs to: the vault root plus the peer
     * pair's `baseDir`.
     *
     * The bridge encodes the same thing in every key
     * (`${name}-${type}-${baseDir}-${key}`), which means that renaming a peer or
     * changing its baseDir silently orphans all of its state: the old keys stay
     * in localStorage forever, the new keys read back empty, and the operator
     * gets a full rescan and a replay from sequence zero with no explanation.
     * Recording the namespace ONCE, at the top of the file, and comparing it on
     * load turns that from an accident into an announced event (see `load`).
     *
     * The peer NAME is deliberately not part of it. A name is a label for logs;
     * making it part of the identity means renaming "couch" to "couchdb" throws
     * away a valid checkpoint. The vault root and the baseDir are what actually
     * determine whether the recorded stats and sequence describe the same tree.
     */
    static namespaceFor(vaultRoot: string, baseDir: string): string {
        return `${path.resolve(vaultRoot)}::${baseDir ?? ''}`;
    }

    /**
     * Read the state file, or start empty.
     *
     * Four ways this ends up empty, three of which are worth announcing:
     * no file yet (first run, expected), unparseable JSON, a version bump, or a
     * namespace mismatch. In every case the peers must behave as if they had
     * never run: a full offline scan, and a changes feed replayed from the
     * beginning. That is the safe direction (it re-pushes and re-pulls work that
     * is already in place) whereas the alternative, resuming from "now", loses
     * everything that happened in the gap.
     */
    async load(): Promise<StateLoadResult> {
        let raw: string;
        try {
            raw = await fs.readFile(this.file, 'utf8');
        } catch {
            this.loaded = true;
            return { reset: true, reason: 'no previous state (first run)' };
        }

        let parsed: Partial<PersistedState> | undefined;
        try {
            parsed = JSON.parse(raw) as Partial<PersistedState>;
        } catch {
            this.loaded = true;
            // Deliberately not deleting the file: the next flush overwrites it,
            // and leaving it lets an operator look at what went wrong.
            return { reset: true, reason: 'state file is not valid JSON' };
        }

        if (parsed?.version !== STATE_VERSION) {
            this.loaded = true;
            return { reset: true, reason: `state file version ${String(parsed?.version)} is not ${STATE_VERSION}` };
        }
        if (parsed.namespace !== this.namespace) {
            this.loaded = true;
            return {
                reset: true,
                // The vault path is not a credential, and naming both sides is
                // the whole point of making this explicit.
                reason:
                    `state belongs to a different vault/baseDir ` +
                    `(stored "${String(parsed.namespace)}", now "${this.namespace}")`,
            };
        }

        this.since = typeof parsed.since === 'string' ? parsed.since : '';
        this.remoteCreated = typeof parsed.remoteCreated === 'string' ? parsed.remoteCreated : '';
        this.fileStats = new Map<string, string>();
        if (parsed.fileStats && typeof parsed.fileStats === 'object') {
            for (const [k, v] of Object.entries(parsed.fileStats)) {
                if (typeof v === 'string') this.fileStats.set(k, v);
            }
        }
        this.loaded = true;
        return { reset: false };
    }

    /** True once `load()` has run. Peers should not read state before that. */
    isLoaded(): boolean {
        return this.loaded;
    }

    // --- since -----------------------------------------------------------------

    /**
     * The changes-feed checkpoint, or `''` when there is none.
     *
     * A MISSING checkpoint means replay from the beginning, NOT "now". The
     * bridge does the opposite (`this.man.since = this.getSetting("since") || "now"`),
     * which is the more comfortable default and the wrong one: combined with the
     * fact that it never advances `since` at all (see `setSince`), it means a
     * bridge that is down for an hour resumes at "now" and every change made in
     * that hour is never seen by the filesystem side. There is no later event
     * that repairs it, because CouchDB has already delivered those sequences to
     * nobody.
     */
    getSince(): string {
        return this.since;
    }

    /**
     * Record the changes-feed checkpoint.
     *
     * The bridge writes this from inside its `checkIsInterested` predicate, using
     * `this.man.since`, and `this.man.since` is never assigned by `beginWatch()`
     * (verified in the vendored engine: `beginWatch` reads `this.since` when it
     * opens the feed and never writes it back). So the bridge persists the value
     * it started with, over and over. The caller here passes the sequence from
     * the change event itself, which is the only place the real value exists.
     */
    setSince(value: string): void {
        if (this.since === value) return;
        this.since = value;
        this.markDirty();
    }

    // --- remote-created --------------------------------------------------------

    getRemoteCreated(): string {
        return this.remoteCreated;
    }

    setRemoteCreated(value: string): void {
        if (this.remoteCreated === value) return;
        this.remoteCreated = value;
        this.markDirty();
    }

    // --- file stats ------------------------------------------------------------

    getFileStat(relPath: string): string | undefined {
        return this.fileStats.get(relPath);
    }

    setFileStat(relPath: string, stat: string): void {
        if (this.fileStats.get(relPath) === stat) return;
        this.fileStats.set(relPath, stat);
        this.markDirty();
    }

    deleteFileStat(relPath: string): void {
        if (!this.fileStats.delete(relPath)) return;
        this.markDirty();
    }

    /**
     * Every path with a recorded baseline.
     *
     * This is what makes offline DELETION detection possible, and the bridge has
     * no equivalent: its startup scan walks the filesystem and asks "is this file
     * changed?", so a file removed while the daemon was down is simply never
     * visited, stays in the remote database, and gets pushed back onto disk by
     * the first changes-feed replay. Resurrected notes are the most alarming
     * possible sync failure, so the storage peer diffs the tracked set against
     * what the walk found and dispatches a delete for the difference.
     */
    trackedPaths(): string[] {
        return [...this.fileStats.keys()];
    }

    /** Number of tracked files, for the health/status line. */
    trackedCount(): number {
        return this.fileStats.size;
    }

    // --- flushing --------------------------------------------------------------

    private markDirty(): void {
        this.dirty = true;
        if (this.closed || this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.flush().catch(() => {
                /* flush() already logged; never let a background write reject. */
            });
        }, this.flushDelayMs);
        // A pending state write must never be the reason the process stays
        // alive. The engine already leaks a socket and a timer past close()
        // (measured while proving it works under Node), so the shutdown path is
        // fragile enough without this adding to it.
        this.timer.unref?.();
    }

    /**
     * Write the current state out, atomically, and wait for it.
     *
     * Chained rather than concurrent: two overlapping flushes would each create a
     * temp file and rename it over the target, and the loser of that race can
     * be the OLDER snapshot. Serialising also means `close()` can simply await
     * the chain.
     */
    async flush(): Promise<void> {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        if (!this.dirty) return this.writeChain;
        // Clear the flag before the write, not after: a change made while the
        // write is in flight has to schedule another one, and the snapshot is
        // taken inside writeNow().
        this.dirty = false;
        this.writeChain = this.writeChain.then(() => this.writeNow());
        return this.writeChain;
    }

    private async writeNow(): Promise<void> {
        const snapshot: PersistedState = {
            version: STATE_VERSION,
            namespace: this.namespace,
            since: this.since,
            remoteCreated: this.remoteCreated,
            fileStats: Object.fromEntries(this.fileStats),
        };
        try {
            await fs.mkdir(path.dirname(this.file), { recursive: true });
            // Temp-then-rename, with randomness in the name for the same reason
            // vault.ts's writeFileText has it: two writers picking the same
            // millisecond would otherwise interleave into one corrupt file. A
            // reader (a human, or a future process) sees either the whole old
            // file or the whole new one.
            const tmp = `${this.file}.tmp-${randomBytes(4).toString('hex')}`;
            try {
                // No pretty-printing: this file has one entry per vault file and
                // is written on a timer, not read by hand in the normal case.
                await fs.writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
                await fs.rename(tmp, this.file);
            } finally {
                await fs.rm(tmp, { force: true }).catch(() => {});
            }
        } catch (e) {
            // Losing the state file is recoverable (a rescan and a replay), so
            // this must never take the sync down. But it has to be loud: silent
            // state loss shows up later as "why did it re-push everything?".
            this.dirty = true;
            this.log?.(`could not write ${this.file}: ${String(e)}`, 'error');
        }
    }

    /** Final flush. After this the store still reads, but stops scheduling writes. */
    async close(): Promise<void> {
        this.closed = true;
        await this.flush();
        await this.writeChain;
    }
}

// --- echo suppression --------------------------------------------------------

/**
 * The in-memory half of echo suppression: recent content hashes per path.
 *
 * Ported from `Peer.isRepeating()` / `Peer.cache` in the bridge, with its
 * capacity raised from 300 to 5000, which is a correctness fix rather than a
 * tuning preference. The cache exists so that a write dispatched to a peer does
 * not bounce straight back as that peer's own "change" event. At 300 entries, a
 * bulk operation over more than 300 files evicts its OWN suppression entries
 * while it is still running: entry 301 pushes entry 1 out, entry 1's watcher
 * event arrives afterwards, finds no cached hash, and is dispatched back. The
 * whole batch echoes, and because each echo is itself a write, it can echo
 * again. 5000 covers a realistic bulk import or a folder rename in a large vault
 * while costing roughly a megabyte.
 *
 * This is one of two layers. The other is the persisted `file-stat-<path>`
 * baseline, which survives a restart; this one catches same-content rewrites
 * that the stat cannot distinguish. Both are needed.
 */
export class EchoSuppressor {
    private readonly capacity: number;
    /** Map iteration order is insertion order, which is what makes this an LRU. */
    private readonly entries = new Map<string, string>();

    constructor(capacity = 5000) {
        this.capacity = Math.max(1, capacity);
    }

    /**
     * Has this exact content already passed through this path, recently?
     *
     * Records the hash as a side effect, exactly as the bridge does: the question
     * "is this a repeat" and the act of remembering are one operation, and
     * splitting them invites a caller that checks and forgets to record.
     */
    isRepeating(relPath: string, data: FileData | false): boolean {
        const digest = hashContent(data);
        const seen = this.entries.get(relPath);
        if (seen === digest) {
            // Refresh recency: a file that keeps round-tripping is exactly the
            // one whose entry must not be evicted.
            this.entries.delete(relPath);
            this.entries.set(relPath, digest);
            return true;
        }
        this.entries.set(relPath, digest);
        this.evict();
        return false;
    }

    /** Drop a path's entry (used when a file is deleted for good). */
    forget(relPath: string): void {
        this.entries.delete(relPath);
    }

    clear(): void {
        this.entries.clear();
    }

    private evict(): void {
        while (this.entries.size > this.capacity) {
            const oldest = this.entries.keys().next();
            if (oldest.done) return;
            this.entries.delete(oldest.value);
        }
    }
}

/**
 * SHA-256 over the content, with a sentinel for deletion.
 *
 * The sentinel is the bridge's (`"\u0001Deleted"`), kept verbatim so that a
 * delete and a file whose content happens to be that string are still told
 * apart by the leading control character. node:crypto rather than
 * `crypto.subtle` because this runs synchronously in the per-file path and the
 * result never leaves the process, so there is nothing to gain from the async
 * WebCrypto shape.
 */
function hashContent(data: FileData | false): string {
    const h = createHash('sha256');
    if (data === false) {
        h.update('\u0001Deleted');
    } else if (data.data instanceof Uint8Array) {
        h.update(data.data);
    } else {
        // The engine hands text back as an array of chunks; hashing the join is
        // what makes a re-chunked but identical file compare equal.
        for (const chunk of data.data) h.update(chunk, 'utf8');
    }
    return h.digest('hex');
}
