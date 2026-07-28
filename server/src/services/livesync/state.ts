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
 * Plus three the bridge has no equivalent for, all of which exist because they
 * are facts that must OUTLIVE A RUN:
 *
 *  - `nodeId`: see `getNodeId()`. The bridge never registers itself in the
 *    cluster's milestone document at all, so it never needed a stable identity;
 *    this port does register, and an identity that changed per boot would grow
 *    the shared document without bound.
 *  - `decodedWith` and `undecodableWith`: see `hasDecodedWith()` and
 *    `getUndecodableWith()`. The two halves of the evidence behind the decision to
 *    STOP the peer as fatally misconfigured, neither of which can be a per-run
 *    counter. They are kept apart rather than fused into one record because they
 *    are recorded under independent fingerprints and answer independent questions:
 *    "has this configuration ever read anything somebody else wrote" and "how much
 *    of what somebody else wrote can it not read".
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
import { UNDECODABLE_QUORUM } from './progress.js';
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
    /**
     * This server's identity in the CouchDB cluster. See `getNodeId()`.
     *
     * Optional in the persisted shape rather than required, so that a state file
     * written before this field existed still loads (and simply mints one) rather
     * than reading as corrupt and throwing away a perfectly good checkpoint.
     * That is also why STATE_VERSION was NOT bumped for it: a bump discards
     * everything, and the whole point of this field is continuity.
     */
    nodeId?: string;
    /**
     * The key material fingerprint that last decrypted a remote document. See
     * `hasDecodedWith()`.
     *
     * Optional for the same reason `nodeId` is, and NOT covered by a version
     * bump for the same reason: a state file written before this field existed
     * must keep its checkpoint rather than read as corrupt. Its absence is
     * simply "no decode has been recorded", which is the safe reading (it makes
     * a total decryption failure fatal, i.e. it errs towards stopping).
     */
    decodedWith?: string;
    /**
     * The distinct remote documents that failed to decrypt under `fingerprint`,
     * and the other half of the fatal verdict's evidence. See
     * `getUndecodableWith()`.
     *
     * Optional and NOT covered by a version bump, for the same reason `nodeId` and
     * `decodedWith` are not. Its absence reads as "no failure has been recorded",
     * which is the safe direction here in the opposite sense to `decodedWith`:
     * missing evidence FOR a working passphrase errs towards stopping, and missing
     * evidence AGAINST one errs towards continuing, so a state file written before
     * this field existed simply starts the count again rather than inheriting a
     * verdict nothing wrote down.
     *
     * Carries its own fingerprint rather than reusing `decodedWith`'s, because the
     * two are independent facts that can legitimately be recorded under different
     * configurations: an operator who changes the passphrase has a `decodedWith`
     * for the old one and needs failures under the new one counted from zero.
     */
    undecodableWith?: { fingerprint: string; ids: string[] };
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
    private nodeId = '';
    private decodedWith = '';
    private undecodableFingerprint = '';
    private undecodableIds: string[] = [];
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
     *
     * `nodeId`, `decodedWith` AND `undecodableWith` SURVIVE ALL THREE RESETS, and
     * that is deliberate in all three cases:
     *
     *  - `nodeId` is a cluster identity, not a description of this vault's
     *    contents, so nothing a reset is protecting against is helped by minting
     *    a new one, and minting one leaves an entry in a shared remote document
     *    that nothing will ever clean up. See `getNodeId()`.
     *  - `decodedWith` is a fact about key material and a remote database, and
     *    it already carries its own identity in the fingerprint, so a reset of
     *    the vault-scoped state says nothing about it either way. Discarding it
     *    here would re-open exactly the bug it exists to close: a peer that has
     *    decrypted for months would, after a state reset, treat the next
     *    undecryptable document as proof of a wrong passphrase and stop.
     *    See `hasDecodedWith()`.
     *  - `undecodableWith` is the same kind of fact about the same pair, and it is
     *    the other half of the same verdict. It is also the half a reset is most
     *    able to destroy silently: the checkpoint goes with the reset, so the
     *    replay redelivers everything and the count would be rebuilt anyway in the
     *    common case, but a peer whose own echo has already carried the checkpoint
     *    past its unreadable backlog rebuilds nothing. See `getUndecodableWith()`.
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

        // Salvaged BEFORE the version and namespace gates, for the reason in the
        // doc comment. Type-checked rather than trusted, because everything else
        // read out of this file is, and an object here would end up as the key of
        // a map in a document shared with every other client.
        if (typeof parsed?.nodeId === 'string' && parsed.nodeId !== '') this.nodeId = parsed.nodeId;
        // Same treatment, and type-checked for a sharper reason: this value
        // suppresses the fatal "nothing decrypts" verdict when it MATCHES the
        // running configuration's fingerprint, so anything that is not a string
        // must read as "no evidence" rather than as evidence.
        if (typeof parsed?.decodedWith === 'string' && parsed.decodedWith !== '') {
            this.decodedWith = parsed.decodedWith;
        }
        /*
         * Same treatment again, and type-checked element by element rather than
         * trusted as a whole. This value is one half of the evidence behind
         * STOPPING the peer, so anything that is not a string in a string array
         * under a string fingerprint has to read as "no evidence" rather than
         * partially. The quorum cap is applied here as well as on the way out,
         * because a hand-edited or corrupted file is exactly the input that would
         * otherwise hand the ledger a thousand ids to adopt.
         */
        const undecodable = parsed?.undecodableWith;
        if (
            undecodable &&
            typeof undecodable === 'object' &&
            typeof undecodable.fingerprint === 'string' &&
            undecodable.fingerprint !== '' &&
            Array.isArray(undecodable.ids)
        ) {
            const ids = undecodable.ids.filter((id): id is string => typeof id === 'string');
            if (ids.length > 0) {
                this.undecodableFingerprint = undecodable.fingerprint;
                this.undecodableIds = ids.slice(0, UNDECODABLE_QUORUM);
            }
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

    // --- node id ---------------------------------------------------------------

    /**
     * This server's identity in the CouchDB cluster, minted once and then stable
     * for the life of the installation.
     *
     * WHY IT HAS TO BE STABLE. The identity is a key in two maps inside the
     * shared milestone document (`accepted_nodes`, `node_chunk_info`, and a third
     * in `tweak_values`). Nothing in the protocol ever removes a key from those
     * maps: `ensureRemoteIsCompatible` only ever merges into them. So an identity
     * that changed per boot would append an entry to a document every client on
     * the cluster reads, on every restart, forever, and it would do it silently.
     * Worse, `ensureRemoteIsCompatible` decides whether to WRITE partly on
     * "is this node absent from the document", so a fresh id would also force a
     * pointless write, and therefore a revision, on every single start.
     *
     * 16 bytes of `randomBytes`, hex. Not a hostname, not a vault path, not a
     * hash of the CouchDB URL: this string is published to every client on the
     * cluster in a document nobody encrypts, so it must carry no information
     * about the host or the operator. Random is the only shape that guarantees
     * that, and 128 bits makes an accidental collision with another client's id
     * (which would silently merge two nodes' chunk ranges) not worth reasoning
     * about.
     *
     * Generated lazily rather than in the constructor so that `load()` gets the
     * chance to supply the persisted one first; the caller is expected to have
     * awaited `load()` before any peer runs, which every code path here does.
     */
    getNodeId(): string {
        if (this.nodeId === '') {
            this.nodeId = randomBytes(16).toString('hex');
            this.markDirty();
        }
        return this.nodeId;
    }

    // --- decode evidence -------------------------------------------------------

    /**
     * A one-way fingerprint of "this key material, against this database".
     *
     * WHAT IT IS FOR. `InboundProgress` stops the peer outright when documents
     * arrive, NO DOCUMENT WRITTEN BY ANOTHER CLIENT has ever decrypted, and enough
     * distinct documents have failed to; that conjunction is the signature of a
     * wrong end-to-end passphrase, and continuing would publish chunks no other
     * client can read. "Ever" has to mean more than "since this process started",
     * or one restart turns a single undecryptable document into a fatal verdict
     * against a passphrase that works (the sequence is written out in
     * `InboundProgress.adoptPriorDecodeEvidence`). So the fact is persisted.
     *
     * "NOTHING has ever decrypted" would be the shorter sentence and it is false,
     * which is worth stating here because this fingerprint is what makes the
     * claim checkable. A peer decrypts its own pushes echoing back off the feed
     * under any passphrase at all, so the count of successful decryptions can be
     * large in a fatal verdict. Only decryptions of documents this peer did not
     * write are evidence, and only those reach `markDecodedWith()`.
     *
     * WHY IT IS A FINGERPRINT AND NOT A BOOLEAN. A bare "we decrypted something
     * once" would survive the operator CHANGING the passphrase to a wrong one,
     * which is the one case the fatal verdict must still catch: the peer would
     * report `degraded` forever while the push direction kept writing documents
     * encrypted with a key nobody else has. Binding the evidence to the key
     * material means a changed passphrase (or a changed remote) reads as no
     * evidence at all, and the verdict is fatal again exactly when it should be.
     *
     * WHAT IS ACTUALLY STORED. A SHA-256 digest, so nothing is recoverable from
     * it. That is worth stating precisely because this file's own header says it
     * holds no credentials: a digest is a verifier, not a credential, and the
     * passphrase itself already sits in plaintext in `data/settings.json` beside
     * this file at the same 0600. So this adds no exposure that the settings file
     * does not already carry, and it deliberately does not become a second place
     * a secret can leak from.
     *
     * The database identity is included as well as the passphrase because
     * "decryption works" is a claim about a pair. Pointing the same passphrase at
     * a different CouchDB is a different claim, and one nothing has verified yet.
     */
    static decodeEvidenceKey(input: {
        url: string;
        database: string;
        passphrase: string | undefined;
        obfuscatePassphrase: string | undefined;
    }): string {
        const h = createHash('sha256');
        // A domain separator, then NUL between fields: without it, moving a
        // character from the end of one field to the start of the next would
        // produce the same digest, and two different configurations would share
        // one piece of evidence.
        h.update('webobsidian-livesync-decode-evidence-v1');
        for (const part of [input.url, input.database, input.passphrase ?? '', input.obfuscatePassphrase ?? '']) {
            h.update(' ');
            h.update(part, 'utf8');
        }
        return h.digest('hex');
    }

    /**
     * Has a remote document ever decrypted under exactly this fingerprint?
     *
     * Exact match, and never a "was anything ever recorded" test: a stored
     * fingerprint from a previous configuration is evidence about that
     * configuration and none at all about this one.
     */
    hasDecodedWith(fingerprint: string): boolean {
        return fingerprint !== '' && this.decodedWith === fingerprint;
    }

    /**
     * Record that one has.
     *
     * Called from `CouchDBPeer.noteForeignDecode()` and from nowhere else, i.e.
     * on a document that survived decryption AND that this peer did not write.
     * The second half of that is not a refinement: a peer can always decrypt what
     * it encrypted itself, so recording on decryption alone let a wrong
     * passphrase persist its own fingerprint from its own echo and permanently
     * suppress the fatal verdict this record exists to gate. Overwrites rather than
     * accumulating: only the configuration currently in use can produce new
     * evidence, and keeping a list would mean an old passphrase's record could
     * still suppress the fatal verdict after the operator changed it.
     */
    markDecodedWith(fingerprint: string): void {
        if (fingerprint === '' || this.decodedWith === fingerprint) return;
        this.decodedWith = fingerprint;
        this.markDirty();
    }

    /**
     * The distinct remote documents that have failed to decrypt under exactly
     * this fingerprint, across every run.
     *
     * THE OTHER HALF OF THE FATAL VERDICT'S EVIDENCE, and it has to be persisted
     * for a reason that is specific to it rather than a mirror of
     * `hasDecodedWith()`'s. The verdict stops the peer when no foreign document
     * has ever decrypted AND enough distinct documents have failed; a per-run
     * count of the second half is destroyed by the peer's OWN echo. The sequence,
     * measured: a wrong-passphrase peer pushes one local note, the echo comes back
     * down the feed, decrypts (it encrypted it), applies, and the apply callback
     * advances the checkpoint past the whole foreign backlog it could not read.
     * One restart later the backlog is behind the checkpoint, nothing redelivers
     * it, the run measures zero failures, and the peer reports `idle` forever
     * while publishing chunks no other client can read. Persisting the count is
     * what stops a peer erasing the evidence against itself.
     *
     * EXACT FINGERPRINT MATCH, never a "was anything ever recorded" test, and for
     * the sharper of the two possible reasons: failures recorded under an OLD
     * passphrase are evidence about that passphrase. Carrying them forward would
     * let an operator who corrects a typo be stopped by the failures the typo
     * caused, on their first bad document, with the fix already in place.
     *
     * WHAT IS STORED IS RAW COUCHDB IDS, deliberately. This file already holds
     * vault paths at 0600 by its own header, so ids add no new class of exposure,
     * and an operator handed a "this peer has stopped, your passphrase may be
     * wrong" verdict has no other way to find out WHICH documents produced it. At
     * most `UNDECODABLE_QUORUM` of them: this is a decision variable, not a census.
     */
    getUndecodableWith(fingerprint: string): string[] {
        if (fingerprint === '' || this.undecodableFingerprint !== fingerprint) return [];
        return [...this.undecodableIds];
    }

    /**
     * Record more of them.
     *
     * Additive WITHIN a fingerprint and wholesale-replacing ACROSS one, which is
     * the same rule `markDecodedWith` follows and for the same reason: only the
     * configuration currently in use can produce evidence about itself, and
     * keeping a per-fingerprint history would mean an old passphrase's failures
     * could still stop a peer whose passphrase is now right.
     *
     * Capped, and silently: the ledger caps its own set at the quorum too, so
     * anything past that is a caller that has not been told the number matters
     * only up to a threshold. Growing this array without bound would put one
     * entry per unreadable document in a file that is rewritten on a debounce.
     */
    addUndecodableWith(fingerprint: string, ids: readonly string[]): void {
        if (fingerprint === '' || ids.length === 0) return;
        if (this.undecodableFingerprint !== fingerprint) {
            this.undecodableFingerprint = fingerprint;
            this.undecodableIds = [];
        }
        if (this.undecodableIds.length >= UNDECODABLE_QUORUM) return;
        let changed = false;
        for (const id of ids) {
            if (this.undecodableIds.length >= UNDECODABLE_QUORUM) break;
            if (this.undecodableIds.includes(id)) continue;
            this.undecodableIds.push(id);
            changed = true;
        }
        if (changed) this.markDirty();
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
            // Written even when empty-string, so that a reader can tell "no id
            // has ever been minted" from "the field predates this version".
            nodeId: this.nodeId,
            decodedWith: this.decodedWith,
            // Omitted entirely when nothing has failed, rather than written as an
            // empty shell: the absence of this key is what a first run looks like,
            // and an operator reading the file should not have to tell an empty
            // record apart from a missing one.
            ...(this.undecodableIds.length > 0
                ? { undecodableWith: { fingerprint: this.undecodableFingerprint, ids: [...this.undecodableIds] } }
                : {}),
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
 * THE 5000 NOW HAS A SECOND MEANING, AND IT IS A SECURITY ONE. Recorded here
 * rather than acted on, because raising the bound is a separate decision that
 * needs its own argument.
 *
 * `CouchDBPeer.noteForeignDecode()` decides a document's PROVENANCE from a
 * `hasSeen()` MISS: a document these bytes have not recently passed through is
 * treated as somebody else's, and decrypting somebody else's document is the
 * receipt that suppresses the fatal "your passphrase is wrong" verdict, is
 * persisted against the configuration's fingerprint, and is never revoked. So an
 * EVICTED entry does not merely cost a redundant dispatch any more: it lets a
 * peer read its OWN document as a stranger's and grant itself that receipt.
 * Measured against this class: 5100 `remember()` calls followed by 5100
 * `hasSeen()` calls in the same order leaves 5000 recognised and the first 100
 * read as foreign, and ONE is enough to persist a wrong passphrase's fingerprint
 * permanently. It is conditional on the push stream getting more than `capacity`
 * documents ahead of the echo stream, which a large vault's first offline scan
 * can do and ordinary editing cannot.
 *
 * Two bounds on the exposure, both worth knowing before anyone changes the
 * number. The receipt is only ever CONSULTED once a document has failed to
 * decrypt, so a cluster whose documents all decrypt never reads it; and once the
 * receipt is legitimately held, later evictions are inert. The window is
 * therefore a fresh peer's first bulk push, which is also exactly when a mistyped
 * passphrase is most likely to be present. Whatever else changes here, this
 * capacity and this eviction policy are now part of the wrong-passphrase
 * detector, and a change to either is a change to it.
 *
 * This is one of two layers. The other is the persisted `file-stat-<path>`
 * baseline, which survives a restart; this one catches same-content rewrites
 * that the stat cannot distinguish. Both are needed. (The baseline is also the
 * obvious candidate for hardening the paragraph above, since it does not evict,
 * but it compares an mtime and a size rather than content, so it is a complement
 * and not a replacement, and it belongs in its own change.)
 *
 * THE QUESTION AND THE RECORD ARE TWO OPERATIONS, AND THAT SPLIT IS A BUG FIX.
 *
 * The bridge (and this port's first revision) fused them into a single
 * `isRepeating()` that recorded the hash on the MISS path, on the argument that
 * "is this a repeat" and "remember it" are one thought and splitting them invites
 * a caller who checks and forgets to record. That argument is right about the
 * hazard and wrong about which hazard is worse, because recording on the miss
 * path states something the caller does not yet know: it says "this content has
 * passed through this path" at the moment the caller has only decided to TRY to
 * pass it through. When the attempt then fails, the claim is a lie that nothing
 * ever retracts, and every later retry of the same bytes is answered with "you
 * already did that".
 *
 * Measured, against a real CouchDB. A note edited during a CouchDB outage was
 * checked here (miss, recorded), dispatched, and the dispatch threw. The storage
 * peer deliberately leaves the file's baseline unadvanced on a throw so that the
 * next offline scan finds the file again, which it did; the scan routed it back
 * through the same code path, which now found the entry recorded by the FAILED
 * attempt and skipped it. Two individually correct mechanisms cancelled each
 * other out and the note was never pushed for the life of the process, while
 * `/healthz/livesync` served 200 and the inbound direction reported `idle`. A
 * process restart pushed the file within twenty seconds, because this cache is
 * in memory and the restart was the only thing that cleared the false claim.
 *
 * So the record is now explicit and every caller makes it only after its
 * operation has actually happened. The invariant that replaces "check and record
 * are one call" is stated once, here, and asserted by the regression tests:
 *
 *   A write that was never successfully passed on must always be retried, and a
 *   write that WAS passed on must never come back as a new change.
 *
 * `hasSeen()` gives the first half by recording nothing; `remember()` gives the
 * second half, and is called on the success path of `StoragePeer.put`/`delete`/
 * `processPath` and `CouchDBPeer.put`/`delete`/`onRemoteChange`. The window
 * between the two calls is genuinely unprotected, and the peers' own comments
 * argue at their call sites why nothing can loop through it.
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
     * A QUERY: a miss records nothing, which is the whole point of the split
     * described above. A HIT does touch the entry, moving it to the end of the
     * LRU, because a file that keeps round-tripping is exactly the one whose
     * entry must not be evicted. That is recency bookkeeping about an entry that
     * already exists, not a new claim about content that has not moved.
     */
    hasSeen(relPath: string, data: FileData | false): boolean {
        const seen = this.entries.get(relPath);
        if (seen === undefined || seen !== hashContent(data)) return false;
        this.entries.delete(relPath);
        this.entries.set(relPath, seen);
        return true;
    }

    /**
     * Record that this exact content HAS now passed through this path.
     *
     * Call this only once the operation it describes has succeeded. Calling it
     * before is the defect the class comment documents: it makes a claim on
     * behalf of an operation that may still fail, and there is no later event
     * that retracts it.
     *
     * Delete-then-set rather than a bare `set`, so a re-recorded path moves to
     * the end of the LRU. A path being written right now is by definition the
     * hottest one, and leaving it at its original position (which is what a bare
     * `set` on an existing key does) would let a busy file whose content keeps
     * changing age out while quiet ones survive.
     */
    remember(relPath: string, data: FileData | false): void {
        this.entries.delete(relPath);
        this.entries.set(relPath, hashContent(data));
        this.evict();
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
