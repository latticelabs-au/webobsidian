/**
 * Regression tests for the LiveSync storage peer's offline reconciliation scan,
 * and specifically for the two ways it used to invent deletions.
 *
 * WHY THIS IS A SEPARATE FILE. `livesync.test.ts` is deliberately scoped to pure
 * logic and imports its subjects statically. Everything here needs a real vault
 * on disk, which means `resetSettingsCache()` (i.e. `vi.resetModules()`) plus
 * dynamic imports inside each test, and mixing the two styles in one file gives
 * one half or the other a stale module registry.
 *
 * WHAT IS BEING GUARDED, and why it earns its own file. The scan infers
 * deletions by DIFFERENCE: "every path we recorded a sync baseline for, that the
 * walk did not find, must have been deleted while we were down". That inference
 * is only sound if both halves of the difference describe the SAME instant. They
 * did not. `seen` was accumulated during the walk and the baselines were read
 * after it, so every file the inbound replication stream wrote while the walk was
 * in progress landed in one set and not the other and was reported as a deletion.
 *
 * The consequence is not a wrong log line. A dispatched deletion soft-deletes the
 * document in CouchDB, which removes the note from every other client in the
 * cluster; and once the storage side re-pushes the file it still has on disk, the
 * echo entry that was supposed to recognise the returning delete has been
 * overwritten, so the delete is applied locally too and the file is gone with no
 * baseline and no pending change to bring it back. Measured against a real vault:
 * a full pull of 2731 documents into an empty vault landed 2724 files, with the
 * seven survivors of that sequence missing locally while their documents sat in
 * CouchDB, undeleted and perfectly readable.
 *
 * So the assertions below are written the strict way round: the scan may report
 * ONLY paths that are genuinely absent from the vault, and it must still report
 * those. A test that merely counted deletions, or that asserted "no deletions at
 * all", would pass against a scan that had simply stopped detecting deletions,
 * which is the resurrected-notes failure FIX 9 exists to prevent.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { makeTmpDataDir, resetSettingsCache, writeSettings, type TmpDir } from './helpers.js';
import type { FileData } from '../services/livesync/types.js';
import type { StoragePeer as StoragePeerType } from '../services/livesync/peer-storage.js';
import type { LiveSyncStateStore as StateStoreType } from '../services/livesync/state.js';

/** One recorded dispatch, in the shape the assertions care about. */
interface Dispatched {
    path: string;
    deleted: boolean;
}

/**
 * The module reset happens ONCE for this file, not once per test, and that is not
 * a shortcut.
 *
 * `resetSettingsCache()` is `vi.resetModules()`, which evicts everything under
 * `src/` AND everything under `vendor/`, but NOT the real `node_modules` packages
 * those re-import. `peer-storage.ts` pulls `isPlainText` from the vendored engine,
 * and the engine's entry point runs `PouchDB.plugin(replication)` at module
 * scope. Evaluate it twice against the same cached `pouchdb-core` and the second
 * registration throws `Cannot redefine property: replicate`, which fails every
 * test after the first for a reason that has nothing to do with what is being
 * tested. So the reset and the imports happen in `beforeAll`, and per-test
 * isolation is achieved by emptying the vault directory instead, which is
 * cheaper anyway.
 */
let tmp: TmpDir;
let StoragePeer: typeof StoragePeerType;
let LiveSyncStateStore: typeof StateStoreType;

describe('StoragePeer.runOfflineScan', () => {
    beforeAll(async () => {
        resetSettingsCache();
        tmp = await makeTmpDataDir();
        await writeSettings(tmp.dataDir, { vault: { path: tmp.vaultDir } });
        ({ StoragePeer } = await import('../services/livesync/peer-storage.js'));
        ({ LiveSyncStateStore } = await import('../services/livesync/state.js'));
    });

    afterAll(async () => {
        await tmp.cleanup();
    });

    beforeEach(async () => {
        // A clean vault per test. The state store is per-test too (each one gets
        // its own file below), so nothing carries over.
        await fs.rm(tmp.vaultDir, { recursive: true, force: true });
        await fs.mkdir(tmp.vaultDir, { recursive: true });
    });

    /** A per-test state store, so no two tests share baselines or a state file. */
    async function makeState(name: string): Promise<StateStoreType> {
        const state = new LiveSyncStateStore('scan-test::', {
            file: path.join(tmp.dataDir, `livesync-state-${name}.json`),
            flushDelayMs: 0,
        });
        await state.load();
        return state;
    }

    /**
     * Build a peer over the temporary vault.
     *
     * `scanOfflineChanges: false` so `start()` does not run a scan of its own:
     * every test here drives `runOfflineScan()` explicitly and wants to control
     * exactly what the vault looks like when it does.
     *
     * The state store is passed in rather than created here because one of these
     * tests subclasses it to get a deterministic hook into the middle of the walk.
     */
    async function makePeer(
        state: StateStoreType,
        onDispatch?: (p: string, d: FileData | false) => void,
    ): Promise<{ peer: StoragePeerType; dispatched: Dispatched[]; logs: string[] }> {
        const dispatched: Dispatched[] = [];
        const logs: string[] = [];
        const peer = new StoragePeer(
            { name: 'vault', baseDir: '', scanOfflineChanges: false, debounceMs: 300 },
            {
                state,
                dispatch: (p: string, d: FileData | false) => {
                    dispatched.push({ path: p, deleted: d === false });
                    onDispatch?.(p, d);
                    return Promise.resolve(true);
                },
                log: (m, l) => logs.push(`${l ?? 'info'}: ${m}`),
            },
        );
        await peer.start();
        return { peer, dispatched, logs };
    }

    /** The engine's chunk-array shape, which is what the CouchDB peer hands over. */
    function inbound(content: string): FileData {
        return {
            ctime: 1_700_000_000_000,
            mtime: 1_700_000_000_000,
            size: content.length,
            data: [content],
        };
    }

    function deletedPaths(dispatched: Dispatched[]): string[] {
        return dispatched.filter((d) => d.deleted).map((d) => d.path).sort();
    }

    /**
     * FIX 9a, deterministically.
     *
     * The hook fires from inside `isChanged()`, which the walk calls for the
     * first file it finds. By then `readdir()` of the vault ROOT has already
     * returned, so files created at the root from here on are invisible to this
     * walk: precisely the position an inbound write is in when the pull is
     * writing into a directory the walk has already passed. The hook then does
     * exactly what `put()` does, in the same order, write the file and then
     * record its baseline, so the state the scan goes on to read is the real one
     * and not a simulation of it.
     *
     * Byte-identical content across the three arrivals is not decoration. The
     * field report correlated the lost files with duplicated content, and this
     * fixture keeps that property so a future "optimisation" that keys anything
     * in this path on content rather than on path fails here.
     */
    it('does not report a file that arrived while the walk was in progress', async () => {
        const content = 'IDENTICAL BYTES\n';
        const arrivals = ['Card 1.md', 'Association.md', 'Else if.md'];

        // One directory with one file in it: enough that the walk descends, and
        // therefore enough that the root listing is finished before the hook runs.
        const seedDir = path.join(tmp.vaultDir, 'seed');
        await fs.mkdir(seedDir, { recursive: true });
        await fs.writeFile(path.join(seedDir, 'anchor.md'), content);

        let fired = false;
        class ArrivingDuringWalk extends LiveSyncStateStore {
            override getFileStat(rel: string): string | undefined {
                if (!fired) {
                    fired = true;
                    for (const name of arrivals) {
                        const abs = path.join(tmp.vaultDir, name);
                        writeFileSync(abs, content);
                        const st = statSync(abs);
                        super.setFileStat(name, `${Math.round(st.mtimeMs)}-${st.size}`);
                    }
                }
                return super.getFileStat(rel);
            }
        }

        const state = new ArrivingDuringWalk('scan-test::', {
            file: path.join(tmp.dataDir, 'livesync-state-arrivals.json'),
            flushDelayMs: 0,
        });
        await state.load();
        // A real deletion, tracked before the scan started and genuinely not on
        // disk. This is the control: the fix must not buy its correctness by
        // turning deletion detection off.
        state.setFileStat('deleted-while-down.md', '1700000000000-16');

        const { peer, dispatched } = await makePeer(state);
        await peer.runOfflineScan();
        await peer.stop();
        await state.close();

        expect(fired).toBe(true);
        expect(deletedPaths(dispatched)).toEqual(['deleted-while-down.md']);

        // And the arrivals are still on disk, which is the point: the scan was
        // about to tell CouchDB they were gone.
        for (const name of arrivals) {
            await expect(fs.stat(path.join(tmp.vaultDir, name))).resolves.toBeTruthy();
        }
    });

    /**
     * FIX 9b, deterministically.
     *
     * The snapshot ordering closes the systematic window but not the residual
     * one. `runOfflineScan` processes the whole `changed` list before it gets to
     * the deletions, and each of those is a file read plus a dispatch to CouchDB,
     * so on a large vault the gap between "the walk did not find this path" and
     * "this path is being deleted" is seconds, and the pull is writing the whole
     * time.
     *
     * Driven here through the real code path rather than a hook: the test's
     * dispatch handler is called while the `changed` list is being processed, and
     * it creates the file that the walk did not find. Nothing else about the scan
     * is altered.
     */
    it('does not report a file that reappeared between the walk and the delete', async () => {
        const content = 'IDENTICAL BYTES\n';
        const anchor = path.join(tmp.vaultDir, 'anchor.md');
        await fs.writeFile(anchor, content);

        const state = await makeState('reappeared');
        // Stale on purpose, so the anchor lands in `changed` and gives the scan
        // some work to do before it reaches the deletions.
        state.setFileStat('anchor.md', '1-1');
        // Tracked, and genuinely absent at the moment the walk runs.
        state.setFileStat('late-arrival.md', '1700000000000-16');
        // Tracked, absent at walk time, and still absent later: must be reported.
        state.setFileStat('deleted-while-down.md', '1700000000000-16');

        const { peer, dispatched } = await makePeer(state, (p, d) => {
            if (p === 'anchor.md' && d !== false) {
                // The inbound pull lands now: after the walk decided
                // `late-arrival.md` was missing, before the deletion for it is
                // dispatched.
                writeFileSync(path.join(tmp.vaultDir, 'late-arrival.md'), content);
            }
        });
        await peer.runOfflineScan();
        await peer.stop();
        await state.close();

        expect(dispatched.some((d) => d.path === 'anchor.md' && !d.deleted)).toBe(true);
        expect(deletedPaths(dispatched)).toEqual(['deleted-while-down.md']);
        await expect(fs.stat(path.join(tmp.vaultDir, 'late-arrival.md'))).resolves.toBeTruthy();
    });

    /**
     * The same hazard as the field report, driven the way the field hit it:
     * `runOfflineScan()` and a burst of inbound `put()` calls in flight at the
     * same time, which is the normal state of affairs at boot because
     * `ensureRunning` starts both peers without either awaiting the other.
     *
     * Timing-dependent by nature, so it is written as an invariant rather than a
     * count: whatever the interleaving turns out to be on a given machine, the
     * scan may never dispatch a deletion for a path that is sitting in the vault.
     * That is the property, and it holds for every interleaving.
     */
    it('never dispatches a deletion for a path that is on disk, under concurrency', async () => {
        const content = 'IDENTICAL BYTES\n';
        // Enough seeded files that the walk has real work to do while the writes
        // are landing.
        for (let i = 0; i < 60; i += 1) {
            const abs = path.join(tmp.vaultDir, `seed/${i}/note.md`);
            await fs.mkdir(path.dirname(abs), { recursive: true });
            await fs.writeFile(abs, content);
        }

        const state = await makeState('concurrency');
        state.setFileStat('deleted-while-down.md', '1700000000000-16');

        const { peer, dispatched } = await makePeer(state);

        const scan = peer.runOfflineScan();
        // Every one of these carries the same bytes, which is what makes them the
        // documents the field report saw go missing.
        const pulled = Array.from({ length: 24 }, (_, i) => `pulled/${i}/Card 1.md`);
        await Promise.all(pulled.map((p) => peer.put(p, inbound(content))));
        await scan;
        await peer.stop();
        await state.close();

        for (const p of deletedPaths(dispatched)) {
            // A dispatched deletion is only ever legitimate for a path that is
            // not there. Anything else is the bug.
            await expect(fs.stat(path.join(tmp.vaultDir, p))).rejects.toThrow();
        }
        expect(deletedPaths(dispatched)).toEqual(['deleted-while-down.md']);
        for (const p of pulled) {
            await expect(fs.stat(path.join(tmp.vaultDir, p))).resolves.toBeTruthy();
        }
    });

    /**
     * FIX 9 itself, unchanged: the whole point of the deletion half of the scan
     * is that a note deleted while the daemon was down does not come back. If a
     * future edit "fixes" the false positives by refusing to report anything,
     * this is the test that stops it.
     */
    it('still reports a file that was deleted while the peer was down', async () => {
        const content = 'IDENTICAL BYTES\n';
        const kept = path.join(tmp.vaultDir, 'kept.md');
        await fs.writeFile(kept, content);

        const state = await makeState('deleted-while-down');
        const st = await fs.stat(kept);
        state.setFileStat('kept.md', `${Math.round(st.mtimeMs)}-${st.size}`);
        state.setFileStat('gone-a.md', '1700000000000-16');
        state.setFileStat('gone-b.md', '1700000000000-16');

        const { peer, dispatched } = await makePeer(state);
        await peer.runOfflineScan();
        await peer.stop();
        await state.close();

        expect(deletedPaths(dispatched)).toEqual(['gone-a.md', 'gone-b.md']);
        // The baselines for the deleted files are dropped; the kept file's is not.
        expect(state.getFileStat('gone-a.md')).toBeUndefined();
        expect(state.getFileStat('kept.md')).toBeDefined();
    });

    /**
     * The mass-deletion safety valve, re-asserted here because moving the
     * baseline snapshot is exactly the kind of edit that could have moved it out
     * from under this check. An empty walk means the vault path is wrong or its
     * storage is not mounted; it never means the user deleted everything.
     */
    it('refuses to treat an empty vault as a mass deletion', async () => {
        const state = await makeState('empty-vault');
        for (let i = 0; i < 5; i += 1) state.setFileStat(`note-${i}.md`, '1700000000000-16');

        const { peer, dispatched, logs } = await makePeer(state);
        await peer.runOfflineScan();
        await peer.stop();
        await state.close();

        expect(deletedPaths(dispatched)).toEqual([]);
        expect(logs.some((l) => l.startsWith('error:') && l.includes('Refusing to treat that'))).toBe(true);
    });
});
