/**
 * Test helpers: temporary directories, settings fixtures, module-cache reset,
 * and a minimal Express app factory for route-level tests.
 *
 * ---------------------------------------------------------------------------
 * Typical pattern for a test that needs isolated settings state:
 *
 *   let tmpDir: { dataDir: string; vaultDir: string; cleanup: () => Promise<void> };
 *
 *   beforeEach(async () => {
 *     // 1. Wipe the module cache so the next import gets fresh instances of
 *     //    config.ts and services/settings.ts with the new DATA_DIR.
 *     resetSettingsCache();
 *     // 2. Create a throwaway directory and point env vars at it.
 *     tmpDir = await makeTmpDataDir();
 *     // 3. (Optional) Seed the file with non-default values.
 *     await writeSettings(tmpDir.dataDir, { vault: { path: tmpDir.vaultDir } });
 *   });
 *
 *   afterEach(async () => {
 *     await tmpDir.cleanup();   // removes dirs, restores env vars
 *   });
 *
 *   it('loads settings from disk', async () => {
 *     // Import INSIDE the test (or in beforeEach) so the new DATA_DIR is
 *     // already in process.env when config.ts is first evaluated.
 *     const { loadSettings } = await import('../services/settings.js');
 *     const s = await loadSettings();
 *     expect(s.vault.path).toBe(tmpDir.vaultDir);
 *   });
 * ---------------------------------------------------------------------------
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import cookieParser from 'cookie-parser';
import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Temporary data directory
// ---------------------------------------------------------------------------

export interface TmpDir {
  /** The directory pointed at by DATA_DIR. Holds settings.json. */
  dataDir: string;
  /** A real vault directory inside dataDir. */
  vaultDir: string;
  /** Remove both directories and restore the previous env vars. */
  cleanup: () => Promise<void>;
}

/**
 * Create a throwaway DATA_DIR and a vault directory inside it, point the
 * DATA_DIR and VAULT_PATH env vars at them, and return an async cleanup fn.
 *
 * Call resetSettingsCache() BEFORE this helper so config.ts is evicted from
 * vitest's module registry. config.ts reads DATA_DIR at module load time; if
 * it is already loaded it holds the old path and the new env var has no effect.
 *
 * The cleanup function restores env vars first, then removes the directories.
 * Restoring first is deliberate: an accidental settings read after cleanup
 * picks up the real (or absent) data dir rather than a path that no longer
 * exists on disk.
 */
export async function makeTmpDataDir(): Promise<TmpDir> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-test-'));
  const vaultDir = path.join(dataDir, 'vault');
  await fs.mkdir(vaultDir, { recursive: true });

  const prevDataDir = process.env.DATA_DIR;
  const prevVaultPath = process.env.VAULT_PATH;
  process.env.DATA_DIR = dataDir;
  process.env.VAULT_PATH = vaultDir;

  async function cleanup(): Promise<void> {
    if (prevDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = prevDataDir;
    }
    if (prevVaultPath === undefined) {
      delete process.env.VAULT_PATH;
    } else {
      process.env.VAULT_PATH = prevVaultPath;
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  }

  return { dataDir, vaultDir, cleanup };
}

// ---------------------------------------------------------------------------
// Settings fixture
// ---------------------------------------------------------------------------

/**
 * Write a settings.json into `dataDir` with the given (partial) shape.
 *
 * Only the keys you supply are written. When services/settings.ts loads the
 * file, zod's schema fills in every field that is absent. This lets tests
 * write only the fields they care about without constructing a complete
 * settings object.
 *
 * Note on `vault.path`: it must be an absolute path. If you omit it, the
 * schema defaults to the process.env.VAULT_PATH value that was in effect when
 * config.ts was last evaluated.
 */
export async function writeSettings(
  dataDir: string,
  shape: Record<string, unknown>,
): Promise<void> {
  const file = path.join(dataDir, 'settings.json');
  await fs.writeFile(file, JSON.stringify(shape, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Settings module cache reset
// ---------------------------------------------------------------------------

/**
 * Discard the settings module's in-memory cache so the next dynamic import of
 * services/settings.ts starts completely fresh.
 *
 * WHY THIS IS NEEDED. services/settings.ts holds three module-level variables:
 *
 *   let cache: Settings | null            the parsed settings object
 *   let loading: Promise<Settings> | null  the in-flight load (deduplicated)
 *   let settingsQueue: Promise<unknown>    the mutation serialiser
 *
 * None of them are exported, so there is no direct way to reset them from
 * outside the module. There is also no "settings.resetForTesting()" function,
 * and one was deliberately not added here (the house rule is: do not modify
 * application logic to make a test pass; that change belongs in a future PR
 * that owns settings.ts).
 *
 * The only available mechanism is vi.resetModules(), which evicts ALL modules
 * from vitest's registry. The next `await import('...')` then evaluates fresh
 * source, starting with empty module-level variables. Because config.ts also
 * reads DATA_DIR at load time, resetting modules here also ensures the next
 * import of config.ts picks up whatever DATA_DIR is set to at that moment.
 *
 * Side effect: every module loaded so far in this test is evicted, not just
 * settings.ts. Tests that call this helper must import their subjects via
 * dynamic `await import(...)` inside each test or in beforeEach, rather than
 * with a static import at the top of the file.
 *
 * Call sequence:
 *   resetSettingsCache();          // evict all modules
 *   const tmp = await makeTmpDataDir();  // set DATA_DIR env var
 *   const { loadSettings } = await import('../services/settings.js'); // fresh
 */
export function resetSettingsCache(): void {
  vi.resetModules();
}

// ---------------------------------------------------------------------------
// Minimal Express app factory
// ---------------------------------------------------------------------------

/**
 * Build a bare Express application for supertest-style route tests.
 *
 * WHY NOT A FULL BOOT. server/src/index.ts:main() indexes the vault, builds
 * the link graph and file index, starts a chokidar watcher, starts autosync,
 * and starts the LiveSync health beat. Doing all of that in a unit test would
 * be slow, depend on disk layout, and leak the chokidar watcher and health-beat
 * timer into the test process. A full boot is wrong for unit tests.
 *
 * This factory returns a minimal app with only the middleware that every route
 * needs: JSON body parsing and cookie parsing. Mount the route you are testing
 * and supply any dependencies (settings loader, auth middleware) as mocks or
 * stubs. Add an error-handler with `app.use(errorHandler)` if your test needs
 * to assert on error response shapes.
 *
 * Note: routes that call getSettings() or loadSettings() at request time (not
 * at module load time) can work with the real settings module if you call
 * resetSettingsCache() + makeTmpDataDir() + writeSettings() first. Routes that
 * import services with their own internal state (search index, link graph) will
 * need vi.mock() to avoid those services initialising.
 *
 * Example with supertest (add `supertest` and `@types/supertest` as devDeps):
 *
 *   import request from 'supertest';
 *   import { settingsRouter } from '../routes/settings.js';
 *
 *   const app = makeTestApp();
 *   app.use('/api/settings', settingsRouter);
 *
 *   await request(app).get('/api/settings').expect(200);
 */
export function makeTestApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '32mb' }));
  app.use(cookieParser());
  return app;
}
