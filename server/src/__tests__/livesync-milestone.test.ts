/**
 * Regression tests for the milestone handshake: how this server announces itself
 * to a Self-hosted LiveSync cluster, and what it refuses to do once it has read
 * the cluster's answer.
 *
 * WHY THIS FILE EXISTS. The reference bridge READS
 * `_local/obsydian_livesync_milestone` and never writes it. Against the bridge
 * author's own deployment that is invisible, because an Obsidian client always
 * seeded the database first. WebObsidian is explicitly allowed to be the FIRST
 * client against an empty CouchDB, which is the one case the bridge never
 * exercises, and the port inherited the hole. Two consequences, both silent:
 *
 *  - SEEDING RACE. We write documents in engine-default format; a plugin joining
 *    later finds no milestone and seeds one from its own settings; we adopt those
 *    on the next restart. For `handleFilenameCaseSensitive` that is a true fork
 *    rather than bloat: it feeds `path2id_base`'s `caseInsensitive` argument, so
 *    flipping it changes the document id of every path with an uppercase letter
 *    and orphans everything already written under an id nothing will look at
 *    again.
 *  - THE LOCK IS IGNORED. `locked`/`cleaned` are how the engine stops clients
 *    writing into a database being rebuilt or chunk-collected. `_local/` docs do
 *    not replicate and never appear in `_changes`, so nothing in a changes feed
 *    could ever have noticed.
 *
 * Nothing here needs CouchDB. `globalThis.fetch` is stubbed only for the connect
 * probe, and the manipulator is a fake that records what would have been written.
 *
 * TWO OF THESE TESTS GUARD FACTS ABOUT THE VENDORED ENGINE RATHER THAN ABOUT
 * THIS CODE, and they are the ones not to delete on a version bump:
 * `livesync-engine wire constants` reads the engine's own source, and
 * "a lock hidden behind a mismatch" pins an upstream ORDERING that this server
 * deliberately works around.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeTmpDataDir, type TmpDir } from './helpers.js';
import { LiveSyncStateStore } from '../services/livesync/state.js';
import {
    BEHAVIOUR_FREE_TWEAK_KEYS,
    CURRENT_VERSION_RANGE,
    CouchDBPeer,
    LiveSyncFatalError,
    mergeRemoteTweaks,
    mismatchedKeys,
} from '../services/livesync/peer-couchdb.js';
import {
    DEVICE_ID_PREFERRED,
    MILESTONE_DOCID,
    TweakValuesTemplate,
    extractObject,
} from 'livesync-engine';
import type { EntryMilestoneInfo, RemoteDBSettings, TweakValues } from 'livesync-engine';
import type { FileData, LiveSyncCouchDBConf } from '../services/livesync/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.resolve(here, '..', '..', 'vendor', 'livesync-engine', 'upstream', 'src');

// ===========================================================================
// 0. Facts about the engine, read out of the engine
// ===========================================================================

describe('livesync-engine wire constants', () => {
    /**
     * `currentVersionRange` is a module-local const in the engine's replicator
     * and is NOT exported, so `CURRENT_VERSION_RANGE` in peer-couchdb.ts is a
     * hand copy. It is not a tuning knob: `max` feeds the compatibility
     * arithmetic that decides whether a cluster will accept us at all.
     *
     * Reading the literal back out of the vendored source is the only mechanism
     * available that fails when a commit bump changes it. Without this, drift
     * would surface as a real cluster refusing this server for no visible reason.
     */
    it('CURRENT_VERSION_RANGE still matches the engine unexported literal', async () => {
        const src = await fs.readFile(
            path.join(VENDOR, 'replication', 'couchdb', 'LiveSyncReplicator.ts'),
            'utf8',
        );
        const match = /const currentVersionRange:\s*ChunkVersionRange\s*=\s*\{([^}]*)\}/.exec(src);
        expect(match, 'currentVersionRange is no longer declared the way this test parses').not.toBeNull();

        const read = Object.fromEntries(
            [...(match?.[1] ?? '').matchAll(/(min|max|current)\s*:\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]),
        );
        expect(read).toEqual({ ...CURRENT_VERSION_RANGE });
    });

    /**
     * The document id is a wire identifier shared with every Obsidian client,
     * misspelling included. It is now imported rather than hand-copied, so this
     * only has to prove the import still resolves to the literal the plugin uses.
     */
    it('MILESTONE_DOCID is the id the engine declares', async () => {
        const src = await fs.readFile(path.join(VENDOR, 'common', 'types.ts'), 'utf8');
        expect(src).toContain(`export const MILESTONE_DOCID = "${MILESTONE_DOCID}"`);
        expect(MILESTONE_DOCID).toBe('_local/obsydian_livesync_milestone');
    });

    /**
     * The three keys this server refuses to treat as fatal. Each is claimed to be
     * behaviour-free FOR THIS BACKEND, and each claim is checked against the
     * source rather than restated.
     */
    it('the behaviour-free tweak keys really have no reader on our paths', async () => {
        expect([...BEHAVIOUR_FREE_TWEAK_KEYS].sort()).toEqual([
            'longLineThreshold',
            'usePluginSyncV2',
            'useSegmenter',
        ]);

        // useSegmenter: the splitter derives the real flag from chunkSplitterVersion
        // (which we DO adopt) and never reads the setting of the same name.
        const splitter = await fs.readFile(path.join(VENDOR, 'ContentSplitter', 'ContentSplitterBase.ts'), 'utf8');
        expect(splitter).toContain('const useSegmenter = this.options.settings.chunkSplitterVersion');
        expect(splitter).not.toContain('settings.useSegmenter');
    });
});

// ===========================================================================
// 1. The node identity
// ===========================================================================

describe('LiveSyncStateStore node identity', () => {
    let tmp: TmpDir;
    let file: string;

    beforeEach(async () => {
        tmp = await makeTmpDataDir();
        file = path.join(tmp.dataDir, 'livesync-state.json');
    });

    afterEach(async () => {
        await tmp.cleanup();
    });

    const store = (namespace = 'ns::') => new LiveSyncStateStore(namespace, { file, flushDelayMs: 0 });

    it('mints one opaque id and keeps it across restarts', async () => {
        const a = store();
        await a.load();
        const id = a.getNodeId();
        // 16 random bytes, hex. Not a hostname, not a path, not a hash of the
        // CouchDB URL: this string is published to every client on the cluster in
        // a document nobody encrypts.
        expect(id).toMatch(/^[0-9a-f]{32}$/);
        expect(a.getNodeId()).toBe(id); // stable within a process
        await a.close();

        const b = store();
        await b.load();
        expect(b.getNodeId()).toBe(id);
        await b.close();
    });

    /**
     * The identity keys two maps inside a document shared with every client, and
     * nothing in the protocol ever REMOVES a key from them. A per-boot id would
     * append an entry on every restart, forever, and would also force a pointless
     * write each time (the engine writes whenever this node is absent).
     */
    it('survives a namespace reset, which throws away everything else', async () => {
        const a = store('vaultA::');
        await a.load();
        const id = a.getNodeId();
        a.setSince('4242');
        await a.close();

        const b = store('vaultB::');
        const result = await b.load();
        expect(result.reset).toBe(true);
        expect(b.getSince()).toBe(''); // vault state is gone, as designed...
        expect(b.getNodeId()).toBe(id); // ...but the cluster identity is not
        await b.close();
    });

    it('mints a fresh one rather than throwing when the stored value is not a string', async () => {
        await fs.writeFile(
            file,
            JSON.stringify({ version: 1, namespace: 'ns::', nodeId: { evil: true }, since: '', remoteCreated: '', fileStats: {} }),
        );
        const a = store();
        await a.load();
        expect(a.getNodeId()).toMatch(/^[0-9a-f]{32}$/);
        await a.close();
    });
});

// ===========================================================================
// 1b. The decode evidence (F2)
// ===========================================================================

/**
 * The persisted half of the "has decryption ever worked?" question.
 *
 * WHY IT IS PERSISTED AT ALL. `InboundProgress` stops the peer outright when
 * documents arrive and nothing decrypts, because that is the signature of a
 * wrong end-to-end passphrase. "Nothing decrypts" was measured per RUN while the
 * changes-feed checkpoint is not, so a partial decryption failure escalated to a
 * fatal one exactly one restart later: the replay resumes from the checkpoint,
 * delivers only the one document that never decrypted, and the fresh run sees
 * zero decodes. This store is what makes the evidence outlive the run.
 */
describe('LiveSyncStateStore decode evidence', () => {
    let tmp: TmpDir;
    let file: string;

    beforeEach(async () => {
        tmp = await makeTmpDataDir();
        file = path.join(tmp.dataDir, 'livesync-state.json');
    });

    afterEach(async () => {
        await tmp.cleanup();
    });

    const store = (namespace = 'ns::') => new LiveSyncStateStore(namespace, { file, flushDelayMs: 0 });

    const conf = {
        url: 'https://couch.example.test:5984',
        database: 'vault',
        passphrase: 'correct horse battery staple',
        obfuscatePassphrase: 'and another one',
    };

    it('F2: remembers a successful decode across a restart', async () => {
        const key = LiveSyncStateStore.decodeEvidenceKey(conf);
        const a = store();
        await a.load();
        expect(a.hasDecodedWith(key)).toBe(false); // nothing has happened yet
        a.markDecodedWith(key);
        await a.close();

        const b = store();
        await b.load();
        expect(b.hasDecodedWith(key)).toBe(true);
        await b.close();
    });

    it('F2: survives a namespace reset, which throws the vault-scoped state away', async () => {
        // The evidence is about key material and a remote database, and it
        // carries its own identity in the fingerprint, so a reset of the
        // vault-scoped state says nothing about it. Discarding it here would
        // re-open the bug: a peer that has decrypted for months would treat the
        // next undecryptable document as proof of a wrong passphrase and stop.
        const key = LiveSyncStateStore.decodeEvidenceKey(conf);
        const a = store('vaultA::');
        await a.load();
        a.setSince('4242');
        a.markDecodedWith(key);
        await a.close();

        const b = store('vaultB::');
        expect((await b.load()).reset).toBe(true);
        expect(b.getSince()).toBe(''); // vault state is gone, as designed...
        expect(b.hasDecodedWith(key)).toBe(true); // ...the decode evidence is not
        await b.close();
    });

    it('F2: a CHANGED passphrase reads as no evidence, so a wrong one is still fatal', async () => {
        /*
         * THE REASON THIS IS A FINGERPRINT AND NOT A BOOLEAN, and the one case a
         * bare "we decrypted something once" would get catastrophically wrong.
         * An operator changing the passphrase to a wrong one must still trip the
         * fatal verdict: otherwise the peer reports `degraded` forever while the
         * PUSH direction keeps writing documents encrypted with a key no other
         * client on the cluster has.
         */
        const key = LiveSyncStateStore.decodeEvidenceKey(conf);
        const a = store();
        await a.load();
        a.markDecodedWith(key);
        await a.close();

        const b = store();
        await b.load();
        expect(b.hasDecodedWith(LiveSyncStateStore.decodeEvidenceKey({ ...conf, passphrase: 'wrong' }))).toBe(false);
        // Same for the obfuscation passphrase (a different document set), and for
        // pointing the same passphrase at a different database (a claim nothing
        // has verified yet).
        expect(
            b.hasDecodedWith(LiveSyncStateStore.decodeEvidenceKey({ ...conf, obfuscatePassphrase: 'other' })),
        ).toBe(false);
        expect(b.hasDecodedWith(LiveSyncStateStore.decodeEvidenceKey({ ...conf, database: 'other' }))).toBe(false);
        expect(b.hasDecodedWith(LiveSyncStateStore.decodeEvidenceKey({ ...conf, url: 'https://other:5984' }))).toBe(
            false,
        );
        await b.close();
    });

    it('F2: stores a digest and never the passphrase itself', async () => {
        // This file sits beside settings.json at 0600 and its header says it holds
        // no credentials. A one-way digest is a verifier rather than a credential,
        // and asserting it here is what stops a future "just store the passphrase,
        // it is simpler" from being a silent change of that promise.
        const key = LiveSyncStateStore.decodeEvidenceKey(conf);
        expect(key).toMatch(/^[0-9a-f]{64}$/);
        expect(key).not.toContain('horse');

        const a = store();
        await a.load();
        a.markDecodedWith(key);
        await a.close();

        const raw = await fs.readFile(file, 'utf8');
        expect(raw).toContain(key);
        expect(raw).not.toContain(conf.passphrase);
        expect(raw).not.toContain(conf.obfuscatePassphrase);
    });

    it('F2: field boundaries are separated, so two configurations cannot share evidence', async () => {
        // Without a separator between the fields, moving a character from the end
        // of one to the start of the next produces the same digest and two
        // different configurations share one piece of evidence.
        expect(LiveSyncStateStore.decodeEvidenceKey({ ...conf, database: 'vault', passphrase: 'ab' })).not.toBe(
            LiveSyncStateStore.decodeEvidenceKey({ ...conf, database: 'vaulta', passphrase: 'b' }),
        );
    });

    it('F2: a stored value that is not a string reads as no evidence', async () => {
        // Type-checked rather than trusted, and in the direction that errs towards
        // stopping the peer rather than towards ignoring a wrong passphrase.
        await fs.writeFile(
            file,
            JSON.stringify({
                version: 1,
                namespace: 'ns::',
                decodedWith: { evil: true },
                since: '',
                remoteCreated: '',
                fileStats: {},
            }),
        );
        const a = store();
        await a.load();
        expect(a.hasDecodedWith(LiveSyncStateStore.decodeEvidenceKey(conf))).toBe(false);
        await a.close();
    });
});

// ===========================================================================
// 2. Harness
// ===========================================================================

/**
 * A plugin's `tweak_values` entry: every template key present, as a real client
 * writes it (`extractObject(TweakValuesTemplate, itsSettings)`).
 *
 * Built from the engine's own template so that a key added upstream appears here
 * automatically rather than being quietly untested.
 */
function pluginTweaks(overrides: Partial<TweakValues> = {}): TweakValues {
    return {
        ...extractObject(TweakValuesTemplate, {}),
        minimumChunkSize: 20,
        customChunkSize: 0,
        longLineThreshold: 250,
        encrypt: false,
        usePathObfuscation: false,
        enableCompression: false,
        useEden: false,
        maxAgeInEden: 10,
        maxTotalLengthInEden: 1024,
        maxChunksInEden: 10,
        useDynamicIterationCount: false,
        hashAlg: 'xxhash64',
        enableChunkSplitterV2: true,
        chunkSplitterVersion: 'v3-rabin-karp',
        E2EEAlgorithm: 'v2',
        doNotUseFixedRevisionForChunks: false,
        handleFilenameCaseSensitive: false,
        // The engine's DEFAULT is false and its own RECOMMENDED template is true,
        // so an ordinary plugin user disagrees with this server here by default.
        // That is the whole reason the mismatch verdict cannot be blanket-fatal.
        usePluginSyncV2: true,
        useSegmenter: false,
        ...overrides,
    };
}

function milestoneDoc(overrides: Partial<EntryMilestoneInfo> = {}): EntryMilestoneInfo {
    const tweaks = pluginTweaks();
    return {
        _id: MILESTONE_DOCID,
        _rev: '3-abc',
        type: 'milestoneinfo',
        created: 1_700_000_000_000,
        locked: false,
        accepted_nodes: ['some-plugin-node'],
        node_chunk_info: { 'some-plugin-node': { ...CURRENT_VERSION_RANGE } },
        tweak_values: { 'some-plugin-node': tweaks, [DEVICE_ID_PREFERRED]: tweaks },
        ...overrides,
    };
}

/**
 * The slice of `DirectFileManipulator` the handshake touches.
 *
 * `settings` reproduces the upstream getter's two OMISSIONS deliberately: it
 * does not set `usePathObfuscation` or `useDynamicIterationCount`, and it lets
 * `handleFilenameCaseSensitive` come through as `undefined`. Those absences are
 * exactly what `handshakeMilestone` corrects, so a "tidied" fake that filled them
 * in would make the correction untestable.
 */
class FakeManipulator {
    watching = false;
    since = '';
    changes: { cancel(): void } | undefined;
    ready = { promise: Promise.resolve(), resolve: () => {}, reject: () => {} };

    /** Every document handed to putRaw, in order. */
    readonly puts: EntryMilestoneInfo[] = [];
    /** Set to make the write fail, as a read-only CouchDB user would. */
    putError?: Error;

    constructor(
        private readonly stored: EntryMilestoneInfo | false,
        private readonly options: Partial<LiveSyncCouchDBConf> = {},
    ) {}

    get settings(): RemoteDBSettings {
        // `options.X ?? default`, key by key, exactly as the upstream getter does
        // it. That shape is what makes tweak ADOPTION observable: the peer merges
        // the remote's values into its conf and rebuilds, and the rebuilt
        // manipulator has to report the merged values or the handshake would be
        // comparing against settings nobody uses.
        const o = this.options;
        return {
            couchDB_URI: 'https://couch.example.test:5984',
            couchDB_DBNAME: 'vault',
            couchDB_USER: 'syncuser',
            couchDB_PASSWORD: 'hunter2-should-never-be-published',
            encrypt: o.passphrase ? true : false,
            passphrase: o.passphrase ?? '',
            minimumChunkSize: o.minimumChunkSize ?? 20,
            customChunkSize: o.customChunkSize ?? 0,
            longLineThreshold: 250,
            enableCompression: o.enableCompression ?? false,
            useEden: o.useEden ?? false,
            maxAgeInEden: o.maxAgeInEden ?? 10,
            maxTotalLengthInEden: o.maxTotalLengthInEden ?? 1024,
            maxChunksInEden: o.maxChunksInEden ?? 10,
            hashAlg: o.hashAlg ?? 'xxhash64',
            enableChunkSplitterV2: o.enableChunkSplitterV2 ?? true,
            chunkSplitterVersion: o.chunkSplitterVersion ?? 'v3-rabin-karp',
            doNotUseFixedRevisionForChunks: o.doNotUseFixedRevisionForChunks ?? false,
            E2EEAlgorithm: o.E2EEAlgorithm ?? 'v2',
            usePluginSyncV2: false,
            useSegmenter: false,
            /*
             * THE TWO OMISSIONS, REPRODUCED ON PURPOSE.
             *
             * `usePathObfuscation` is absent entirely and
             * `handleFilenameCaseSensitive` comes through as `undefined`, exactly
             * as `DirectFileManipulatorV2.ts:241-277` leaves them. Those absences
             * are what `handshakeMilestone` corrects; a fake that helpfully filled
             * them in would make the correction untestable and this file would
             * pass while the real thing published a lie.
             */
            handleFilenameCaseSensitive: undefined as unknown as boolean,
            useDynamicIterationCount: false,
        } as RemoteDBSettings;
    }

    readonly liveSyncLocalDB = {
        putRaw: (doc: EntryMilestoneInfo) => {
            if (this.putError) return Promise.reject(this.putError);
            // Structured-cloned so a later mutation by the engine cannot rewrite
            // history in the assertions.
            this.puts.push(structuredClone(doc));
            return Promise.resolve({ ok: true, id: String(doc._id), rev: '9-written' });
        },
    };

    rawGet<T>(id: string): Promise<false | T> {
        if (id !== MILESTONE_DOCID) return Promise.resolve(false);
        return Promise.resolve((this.stored === false ? false : structuredClone(this.stored)) as false | T);
    }

    beginWatch(): false | void {
        this.watching = true;
        this.changes = { cancel: () => {} };
    }
    endWatch(): void {
        this.watching = false;
    }
    close(): Promise<void> {
        return Promise.resolve();
    }
}

/** The private surface these tests drive. Structural, so a rename breaks the build. */
interface PeerInternals {
    man: unknown;
    conf: LiveSyncCouchDBConf;
    buildManipulator(): void;
    probeCouch(timeoutMs: number): Promise<void>;
}

/**
 * Replace the two things that need a real network, and nothing else.
 *
 * `buildManipulator` is stubbed to construct a fake FROM THE PEER'S CURRENT CONF,
 * which is what the real one does (`new DirectFileManipulator(this.conf)`).
 * Handing back one fixed instance instead would quietly break the one behaviour
 * that depends on rebuilding: after adopting the remote's tweaks the peer builds
 * a new manipulator so the engine picks the merged settings up, and a stub that
 * ignored the merge would let the handshake compare against settings nothing uses.
 */
function installFakes(
    peer: CouchDBPeer,
    stored: EntryMilestoneInfo | false,
): { latest: () => FakeManipulator; built: FakeManipulator[] } {
    const internals = peer as unknown as PeerInternals;
    const built: FakeManipulator[] = [];
    internals.probeCouch = () => Promise.resolve();
    internals.buildManipulator = () => {
        const man = new FakeManipulator(stored, internals.conf);
        built.push(man);
        internals.man = man;
    };
    return { latest: () => built[built.length - 1], built };
}

function couchConf(overrides: Partial<LiveSyncCouchDBConf> = {}): LiveSyncCouchDBConf {
    return {
        name: 'couch',
        baseDir: '',
        url: 'https://couch.example.test:5984',
        username: 'syncuser',
        password: 'hunter2-should-never-be-published',
        database: 'vault',
        passphrase: undefined,
        obfuscatePassphrase: undefined,
        useRemoteTweaks: true,
        ...overrides,
    };
}

// ===========================================================================
// 3. The handshake, driven through the real start() path
// ===========================================================================

describe('the milestone handshake', () => {
    let tmp: TmpDir;

    beforeEach(async () => {
        tmp = await makeTmpDataDir();
    });

    afterEach(async () => {
        vi.unstubAllGlobals();
        await tmp.cleanup();
    });

    /**
     * A peer driven through `start()`, with only the two things that need a real
     * network replaced: the reachability probe and the manipulator factory.
     *
     * Going through `start()` rather than poking `connectAndWatch` is deliberate.
     * The behaviour under test is not just "what does the handshake decide" but
     * "what does the peer DO about it", and the difference between a fatal stop
     * and another retry only exists inside `connectLoop`.
     */
    async function startPeer(
        stored: EntryMilestoneInfo | false,
        conf: Partial<LiveSyncCouchDBConf> = {},
        state?: LiveSyncStateStore,
    ): Promise<{ peer: CouchDBPeer; man: FakeManipulator; state: LiveSyncStateStore; logs: string[] }> {
        const store =
            state ??
            new LiveSyncStateStore('test::', {
                file: path.join(tmp.dataDir, 'livesync-state.json'),
                flushDelayMs: 3_600_000,
            });
        if (!state) await store.load();

        const logs: string[] = [];
        const peer = new CouchDBPeer(couchConf(conf), {
            state: store,
            dispatch: (_p: string, _d: FileData | false) => Promise.resolve(true),
            log: (message: string, level = 'info') => logs.push(`${level}: ${message}`),
        });

        const fakes = installFakes(peer, stored);
        await peer.start();
        return { peer, man: fakes.latest(), state: store, logs };
    }

    // --- seeding an empty database ------------------------------------------

    describe('an empty database', () => {
        it('is seeded with a milestone the engine itself produced', async () => {
            const { peer, man, state } = await startPeer(false);

            expect(peer.getFatalReason()).toBeUndefined();
            expect(man.puts).toHaveLength(1);

            const written = man.puts[0];
            expect(written._id).toBe(MILESTONE_DOCID);
            expect(written.type).toBe('milestoneinfo');
            expect(written.locked).toBe(false);
            // We seeded it, so we are the accepted node and the only chunk-range
            // entry. A client joining later reconciles against this rather than
            // silently seeding a different format.
            const nodeId = state.getNodeId();
            expect(written.accepted_nodes).toEqual([nodeId]);
            expect(written.node_chunk_info[nodeId]).toEqual({ ...CURRENT_VERSION_RANGE });
            // PREFERRED is what every other client compares itself against. An
            // absent one is the seeding race: the next client to connect would
            // install ITS values as authoritative.
            expect(written.tweak_values[DEVICE_ID_PREFERRED]).toBeDefined();
            expect(written.tweak_values[nodeId]).toBeDefined();

            await peer.stop();
        });

        /**
         * The document is world-readable to every client on the cluster and is
         * NOT encrypted (it is `_local/`, and the encryption transform only
         * rewrites chunk, syncinfo, obfuscated and eden documents). If a
         * credential ever reached it, it would reach everyone.
         */
        it('publishes no credential of any kind', async () => {
            const { peer, man } = await startPeer(false, {
                passphrase: 'correct-horse-battery-staple',
                obfuscatePassphrase: 'obfuscation-secret',
            });

            const blob = JSON.stringify(man.puts[0]);
            for (const secret of [
                'correct-horse-battery-staple',
                'obfuscation-secret',
                'hunter2-should-never-be-published',
                'syncuser',
                'couch.example.test',
            ]) {
                expect(blob, `the milestone leaked ${secret}`).not.toContain(secret);
            }
            // What it DOES publish about encryption is the boolean, exactly as an
            // Obsidian client publishes it.
            expect(man.puts[0].tweak_values[DEVICE_ID_PREFERRED].encrypt).toBe(true);

            await peer.stop();
        });

        /**
         * The upstream `settings` getter never sets `usePathObfuscation`, so it
         * reports `false` while `path2id` is actively producing `f:<hash>` ids.
         * Publishing that would tell the cluster our ids are readable paths when
         * they are not: the two document sets would never intersect and both
         * sides would silently sync half a vault.
         */
        it('announces path obfuscation truthfully, working around the engine getter', async () => {
            const { peer, man } = await startPeer(false, {
                passphrase: 'pass',
                obfuscatePassphrase: 'obf',
            });
            expect(man.puts[0].tweak_values[DEVICE_ID_PREFERRED].usePathObfuscation).toBe(true);
            await peer.stop();

            const plain = await startPeer(false);
            expect(plain.man.puts[0].tweak_values[DEVICE_ID_PREFERRED].usePathObfuscation).toBe(false);
            await plain.peer.stop();
        });

        /**
         * `DEFAULT_SETTINGS.handleFilenameCaseSensitive` is literally `undefined`,
         * and the mismatch comparison SKIPS any key undefined on either side. So
         * publishing `undefined` would disable the check on the single field with
         * the worst failure mode (it changes the document id of every path with an
         * uppercase letter). `false` is also the truth: `path2id` passes
         * `!options.handleFilenameCaseSensitive`.
         */
        it('pins handleFilenameCaseSensitive to an explicit false rather than undefined', async () => {
            const { peer, man } = await startPeer(false);
            const published = man.puts[0].tweak_values[DEVICE_ID_PREFERRED];
            expect(published.handleFilenameCaseSensitive).toBe(false);
            expect('handleFilenameCaseSensitive' in published).toBe(true);
            expect(published.useDynamicIterationCount).toBe(false);
            await peer.stop();
        });

        /**
         * The bridge records `'0'` here. That marker means "rebuilt" on the next
         * connect, so with a milestone now present every single start would read
         * its own document as someone else's rebuild and replay from sequence
         * zero.
         */
        it('records the real created timestamp, so the next start does not replay from zero', async () => {
            const first = await startPeer(false);
            const created = first.state.getRemoteCreated();
            expect(created).not.toBe('0');
            expect(Number(created)).toBeGreaterThan(0);
            first.state.setSince('812');
            await first.peer.stop();

            // Second connect: the same document comes back, so nothing is rebuilt.
            const stored = { ...first.man.puts[0], _rev: '9-written' };
            const secondState = new LiveSyncStateStore('test::', {
                file: path.join(tmp.dataDir, 'livesync-state.json'),
                flushDelayMs: 3_600_000,
            });
            await first.state.flush();
            await secondState.load();
            expect(secondState.getRemoteCreated()).toBe(created);

            const second = await startPeer(stored, {}, secondState);
            expect(secondState.getSince()).toBe('812'); // NOT reset to '0'
            // Nothing to write either: we are already registered with the same
            // chunk range and the same tweaks.
            expect(second.man.puts).toHaveLength(0);
            await second.peer.stop();
        });

        /**
         * A write failure is a connect failure, not something to sync past. A peer
         * that cannot write the milestone cannot write documents either, and a 409
         * from two clients seeding at the same instant resolves itself on the next
         * attempt because that attempt re-reads the winner's document.
         */
        it('does not report itself connected when the milestone write fails', async () => {
            const state = new LiveSyncStateStore('test::', {
                file: path.join(tmp.dataDir, 'livesync-state.json'),
                flushDelayMs: 3_600_000,
            });
            await state.load();
            const peer = new CouchDBPeer(couchConf(), { state, dispatch: () => Promise.resolve(true) });
            const fakes = installFakes(peer, false);
            const internals = peer as unknown as PeerInternals;
            const build = internals.buildManipulator.bind(internals);
            internals.buildManipulator = () => {
                build();
                fakes.latest().putError = new Error('forbidden');
            };

            await peer.start();
            expect(peer.isConnected()).toBe(false);
            // Retriable, not fatal: a permission can be granted, and a 409 is
            // transient by construction.
            expect(peer.getFatalReason()).toBeUndefined();
            expect(fakes.latest().watching).toBe(false);
            await peer.stop();
        });
    });

    // --- the lock ------------------------------------------------------------

    describe('a locked database', () => {
        it('stops the peer, and blocks writes, when this node is not accepted', async () => {
            const { peer, man } = await startPeer(milestoneDoc({ locked: true }));

            expect(peer.getFatalReason()).toMatch(/rebuilt or locked/);
            expect(peer.getFatalReason()).toMatch(/Unlock the database/);
            // Never registered itself in a database that refused it, and never
            // attached the feed.
            expect(man.puts).toHaveLength(0);
            expect(man.watching).toBe(false);
            // And the point of the whole exercise: writes are refused. Continuing
            // to write into a database declared rebuilt is the corruption
            // scenario, not merely an unhealthy state.
            await expect(
                peer.put('note.md', { ctime: 1, mtime: 1, size: 3, data: ['abc'] }),
            ).rejects.toBeInstanceOf(LiveSyncFatalError);

            await peer.stop();
        });

        it('names the chunk clean-up specifically when cleaned is set', async () => {
            const { peer } = await startPeer(milestoneDoc({ locked: true, cleaned: true }));
            expect(peer.getFatalReason()).toMatch(/cleaned up \(chunk garbage collection\)/);
            await peer.stop();
        });

        /**
         * THE ORDERING WORKAROUND, and the reason `assertNotLockedOut` exists at
         * all rather than a branch on the engine's verdict.
         *
         * `ensureRemoteIsCompatible` checks the settings mismatch FIRST and
         * returns early, so a milestone that is both mismatched and locked reports
         * only MISMATCHED and its lock check never runs. The Obsidian plugin does
         * not notice because it stops on every non-OK verdict. This server
         * deliberately continues past a mismatch confined to keys it cannot
         * control, and `usePluginSyncV2` is exactly such a key AND differs from an
         * ordinary plugin user by default. Without the direct check, a chunk
         * clean-up in progress would be invisible and we would keep writing
         * against chunks being deleted.
         */
        it('is still refused when a settings mismatch would have masked the lock', async () => {
            const stored = milestoneDoc({ locked: true, cleaned: true });
            // Prove the premise rather than assert it: the engine really does
            // report MISMATCHED for this document, not NODE_CLEANED.
            const { ensureRemoteIsCompatible } = await import('livesync-engine');
            const verdict = await ensureRemoteIsCompatible(
                structuredClone(stored),
                { ...new FakeManipulator(false, couchConf()).settings, usePluginSyncV2: false } as RemoteDBSettings,
                'unaccepted-node',
                CURRENT_VERSION_RANGE,
                () => Promise.resolve(),
            );
            expect(Array.isArray(verdict) && verdict[0]).toBe('MISMATCHED');

            const { peer, man } = await startPeer(stored);
            expect(peer.getFatalReason()).toMatch(/cleaned up/);
            expect(man.puts).toHaveLength(0);
            await peer.stop();
        });

        /**
         * Locked but ACCEPTED. The engine's own consumer proceeds here, and so do
         * we: the lock exists to keep unaccepted nodes out, and refusing would
         * mean rejecting a database every Obsidian client is happily replicating.
         */
        it('continues, loudly, when this node is listed as accepted', async () => {
            const state = new LiveSyncStateStore('test::', {
                file: path.join(tmp.dataDir, 'livesync-state.json'),
                flushDelayMs: 3_600_000,
            });
            await state.load();
            const nodeId = state.getNodeId();

            const stored = milestoneDoc({ locked: true, accepted_nodes: ['some-plugin-node', nodeId] });
            const { peer, man, logs } = await startPeer(stored, {}, state);

            expect(peer.getFatalReason()).toBeUndefined();
            expect(man.watching).toBe(true);
            expect(logs.some((l) => l.startsWith('notice:') && /marked locked/.test(l))).toBe(true);
            await peer.stop();
        });
    });

    // --- settings mismatch ---------------------------------------------------

    describe('a settings mismatch', () => {
        /**
         * The regression that would break this server against ordinary clusters if
         * MISMATCHED were treated as blanket-fatal. `usePluginSyncV2` governs the
         * plugin's own plugin-sync documents, which this peer never reads or
         * writes, and the engine's recommended value (true) differs from its
         * default (false), so a normal plugin user hits it immediately.
         */
        it('does not stop the peer when only behaviour-free keys differ', async () => {
            const { peer, man, logs } = await startPeer(milestoneDoc());

            expect(peer.getFatalReason()).toBeUndefined();
            expect(man.watching).toBe(true);
            expect(logs.some((l) => /usePluginSyncV2/.test(l) && l.startsWith('notice:'))).toBe(true);
            await peer.stop();
        });

        /**
         * The drift guard. `mismatchedKeys` reproduces the engine's comparison in
         * order to name the differing keys, and if the two ever stop agreeing, a
         * verdict of MISMATCHED with an empty key list would be waved through:
         * the same silent failure in a new place.
         *
         * There is no way to make the real engine disagree with our reproduction
         * on purpose (that is the point of building the reproduction out of the
         * engine's own templates), so the state is provoked directly: a MISMATCHED
         * verdict whose preferred values differ from the announced ones in no key
         * at all.
         */
        it('refuses rather than dismisses a mismatch it cannot explain', async () => {
            const state = new LiveSyncStateStore('test::', {
                file: path.join(tmp.dataDir, 'livesync-state.json'),
                flushDelayMs: 3_600_000,
            });
            await state.load();
            const peer = new CouchDBPeer(couchConf(), { state, dispatch: () => Promise.resolve(true) });
            installFakes(peer, milestoneDoc());

            // The engine's verdict, with a preferred set that differs from nothing
            // our comparison can see: every key equal to what we announce.
            const internals = peer as unknown as { applyMismatch(p: TweakValues, a: RemoteDBSettings): void };
            const announced = {
                ...new FakeManipulator(false, couchConf()).settings,
                usePluginSyncV2: false,
            } as RemoteDBSettings;
            expect(() => internals.applyMismatch(pluginTweaks({ usePluginSyncV2: false }), announced)).toThrow(
                /cannot determine which setting differs/,
            );
        });

        /**
         * The hole `mergeRemoteTweaks` could not see. It throws only when the
         * REMOTE has encryption or obfuscation on and we do not; the other
         * direction was silent, and it is the one that forks a vault. With the
         * remote saying `usePathObfuscation: false` while we write `f:<hash>` ids,
         * the two document sets never intersect and neither side reports anything.
         */
        it('IS fatal when a format-relevant key differs: obfuscation', async () => {
            const { peer, man } = await startPeer(milestoneDoc(), {
                passphrase: 'pass',
                obfuscatePassphrase: 'obf',
                // Otherwise adoption would pull the remote's values in and the
                // only difference left would be the obfuscation itself, which is
                // exactly what this test wants to isolate.
                useRemoteTweaks: false,
            });

            expect(peer.getFatalReason()).toMatch(/usePathObfuscation/);
            expect(peer.getFatalReason()).toMatch(/forks the vault silently/);
            expect(man.watching).toBe(false);
            await peer.stop();
        });

        it('IS fatal when a format-relevant key differs: encryption', async () => {
            const remote = milestoneDoc();
            // A remote that IS encrypted while we hold no passphrase. The reverse
            // of this is already caught by mergeRemoteTweaks; this is the case the
            // handshake adds.
            remote.tweak_values[DEVICE_ID_PREFERRED] = pluginTweaks({ encrypt: true });
            const { peer } = await startPeer(remote, { useRemoteTweaks: false });
            expect(peer.getFatalReason()).toMatch(/encrypt/);
            await peer.stop();
        });

        /**
         * Adoption runs BEFORE the handshake precisely so that a chunking
         * difference resolves itself rather than becoming fatal, and the rebuilt
         * manipulator is what the handshake then describes. Reverse either half
         * and this reports a mismatch on values it was on its way to adopting.
         */
        it('resolves a chunking difference by adopting it rather than refusing', async () => {
            const remote = milestoneDoc();
            remote.tweak_values[DEVICE_ID_PREFERRED] = pluginTweaks({
                usePluginSyncV2: false, // isolate the chunking difference
                customChunkSize: 7,
                hashAlg: 'sha1',
            });
            // The local conf deliberately does NOT carry those values: adopting
            // them from the remote is the behaviour under test.
            const { peer, man } = await startPeer(remote);

            expect(peer.getFatalReason()).toBeUndefined();
            expect(man.watching).toBe(true);
            // Adopted, and therefore also announced: the manipulator was rebuilt
            // and now reports the merged values.
            expect(man.settings.customChunkSize).toBe(7);
            expect(man.settings.hashAlg).toBe('sha1');
            await peer.stop();
        });

        /**
         * The same difference with adoption switched off. This is what the
         * previous test would look like if the order or the rebuild were wrong,
         * and it is also the honest behaviour for an operator who has pinned their
         * own chunking: a real disagreement, reported rather than absorbed.
         */
        it('IS fatal when the same difference cannot be adopted', async () => {
            const remote = milestoneDoc();
            remote.tweak_values[DEVICE_ID_PREFERRED] = pluginTweaks({
                usePluginSyncV2: false,
                customChunkSize: 7,
                hashAlg: 'sha1',
            });
            const { peer } = await startPeer(remote, { useRemoteTweaks: false });
            expect(peer.getFatalReason()).toMatch(/customChunkSize, hashAlg/);
            await peer.stop();
        });
    });

    // --- version compatibility ----------------------------------------------

    it('stops on an incompatible chunk format rather than writing into it', async () => {
        const stored = milestoneDoc({
            accepted_nodes: ['future-node'],
            // A node that can only read chunk formats far beyond ours: the
            // intersection with our range is empty.
            node_chunk_info: { 'future-node': { min: 9000, max: 9999, current: 9000 } },
        });
        const { peer, man } = await startPeer(stored);
        expect(peer.getFatalReason()).toMatch(/chunk format outside the range/);
        expect(man.watching).toBe(false);
        await peer.stop();
    });
});

// ===========================================================================
// 4. The pure helpers
// ===========================================================================

describe('mergeRemoteTweaks tweak selection', () => {
    const base = couchConf();

    /**
     * `tweak_values` is keyed by node id PLUS the reserved `PREFERRED` key, and
     * `ensureRemoteIsCompatible` compares against `PREFERRED` and nothing else.
     * The bridge takes `Object.values(...)[0]`, so once a third client joins it
     * can adopt a stale node's tweaks and then be told, permanently, that its
     * settings mismatch.
     */
    it('prefers the PREFERRED entry over whichever node happens to be first', () => {
        const { merged } = mergeRemoteTweaks(base, {
            'stale-node': { customChunkSize: 111 },
            [DEVICE_ID_PREFERRED]: { customChunkSize: 222 },
            'another-node': { customChunkSize: 333 },
        });
        expect(merged.customChunkSize).toBe(222);
    });

    it('falls back to the first entry for a milestone written before PREFERRED existed', () => {
        const { merged } = mergeRemoteTweaks(base, { 'old-node': { customChunkSize: 111 } });
        expect(merged.customChunkSize).toBe(111);
    });
});

describe('mismatchedKeys', () => {
    const announced = (overrides: Partial<RemoteDBSettings> = {}): RemoteDBSettings =>
        ({ ...new FakeManipulator(false, couchConf()).settings, usePluginSyncV2: false, ...overrides }) as RemoteDBSettings;

    it('names exactly the keys that differ', () => {
        expect(mismatchedKeys(pluginTweaks(), announced())).toEqual(['usePluginSyncV2']);
        expect(mismatchedKeys(pluginTweaks({ usePluginSyncV2: false }), announced())).toEqual([]);
        expect(mismatchedKeys(pluginTweaks({ usePluginSyncV2: false, hashAlg: 'sha1' }), announced())).toEqual([
            'hashAlg',
        ]);
    });

    /**
     * A milestone written by a client that predates a key: the key is absent, so
     * the engine's `TweakValuesDefault` underlay decides what happens, and the
     * skip-if-undefined-on-either-side rule does the rest. The split is not
     * arbitrary and it is worth pinning, because it is the difference between
     * "old client, ignore it" and "old client, refuse to sync with it".
     *
     * `hashAlg` has no entry in the underlay, so it comes back undefined and is
     * skipped. `E2EEAlgorithm` and `chunkSplitterVersion` DO have entries (both
     * the engine's bare defaults, `""`), so an ancient milestone is read as
     * asserting those, and they differ from ours. That is the correct outcome
     * rather than an inconvenience: both decide how bytes are encrypted and split,
     * so a client that really is on the old format should stop us.
     */
    it('applies the engine underlay to keys an older client never wrote', () => {
        const ancient: TweakValues = { minimumChunkSize: 20 };
        expect(mismatchedKeys(ancient, announced({ hashAlg: 'sha1' }))).toEqual([
            'E2EEAlgorithm',
            'chunkSplitterVersion',
        ]);
        // ...and none of them is dismissible.
        for (const key of ['E2EEAlgorithm', 'chunkSplitterVersion']) {
            expect(BEHAVIOUR_FREE_TWEAK_KEYS.has(key)).toBe(false);
        }
    });

    /**
     * The safety property the whole classification rests on: whatever else moves,
     * a difference on one of these is never allowed to be dismissed as
     * behaviour-free.
     *
     * Note that `usePathObfuscation` has to be supplied to `announced()` by hand
     * here, because the fake reproduces the upstream getter's omission of it. That
     * is precisely the omission `handshakeMilestone` corrects before calling this:
     * left uncorrected, the key is `undefined` on our side, the comparison skips
     * it, and the single worst divergence available becomes invisible.
     */
    it('reports format-relevant keys, which are never in the behaviour-free set', () => {
        const differing = mismatchedKeys(
            pluginTweaks({ usePluginSyncV2: false, encrypt: true, usePathObfuscation: true }),
            announced({ encrypt: false, usePathObfuscation: false }),
        );
        expect(differing).toEqual(['encrypt', 'usePathObfuscation']);
        for (const key of ['encrypt', 'usePathObfuscation', 'handleFilenameCaseSensitive', 'hashAlg']) {
            expect(BEHAVIOUR_FREE_TWEAK_KEYS.has(key)).toBe(false);
        }
    });

    /** The omission itself, pinned: an uncorrected side silently drops the check. */
    it('cannot see a difference the engine settings getter never reports', () => {
        expect(
            mismatchedKeys(pluginTweaks({ usePluginSyncV2: false, usePathObfuscation: true }), announced()),
        ).toEqual([]);
    });
});
