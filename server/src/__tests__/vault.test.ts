/**
 * Regression tests for the vault path guards (`services/vault.ts`), plus the one
 * guard that lives next to them because that is where the name is minted
 * (`safeUploadFilename` in `routes/files.ts`).
 *
 * Every case here is a defect that was found in this tree, not a hypothetical.
 * The comments name the defect rather than restating the assertion, because the
 * assertion is readable and the reason it exists is not.
 *
 * WHY A REAL TEMPORARY DIRECTORY AND NOT A MOCKED `fs`.
 *
 * These are path-SEMANTICS tests. What is being verified is what the operating
 * system does with a string: that `path.resolve` walks out of the root for one
 * spelling and not another, that `realpath.native` collapses an 8.3 short name
 * and a junction, that `fs.link` reports EEXIST atomically rather than replacing
 * its destination, that a backslash is a separator on Windows and an ordinary
 * character on Linux. A mocked `fs` answers whatever the mock was written to
 * answer, which means it would have agreed with the buggy implementation in
 * every one of these cases: the original bugs are precisely the places where the
 * author's model of the filesystem and the filesystem disagreed. So each test
 * builds a throwaway vault, performs the real operation, and asserts on the
 * RESOLVED OUTCOME (the returned absolute path, the bytes on disk, the directory
 * listing) rather than on the shape of the input string.
 *
 * WHY EVERY IMPORT OF THE SUBJECT IS DYNAMIC.
 *
 * `config.ts` reads `DATA_DIR`/`VAULT_PATH` at module-evaluation time and
 * `services/settings.ts` caches the parsed settings in module scope, so the
 * subject has to be imported AFTER the env vars point at this test's temp dir.
 * `resetSettingsCache()` (vi.resetModules) evicts both. See `helpers.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type { NextFunction, Request, Response } from 'express';
import {
  makeTestApp,
  makeTmpDataDir,
  resetSettingsCache,
  writeSettings,
  type TmpDir,
} from './helpers.js';

/**
 * `routes/files.ts` is imported by the upload suite at the bottom of this file
 * purely to reach `safeUploadFilename`, which is module-private and therefore
 * only observable through the route that calls it. Everything the route pulls in
 * that is NOT part of that question is stubbed: the search engine, the link
 * graph, the git auto-commit scheduler, the file index and the share store all
 * carry module-level state and would otherwise be built (and, for git, have a
 * timer scheduled) by a test about filenames.
 *
 * `requireAuth` is stubbed for the same reason and no other: minting a real
 * session would mean loading `services/auth.ts`, generating a JWT secret and
 * signing a token, none of which is under test here. The route's own auth
 * behaviour belongs in a route test, not in this file.
 *
 * `services/vault.ts` is deliberately NOT stubbed. The whole point of driving the
 * route is to watch a client-supplied filename travel through the real sanitiser
 * into the real containment check and land on a real disk.
 */
vi.mock('../middleware/auth.js', () => ({
  COOKIE_NAME: 'webobsidian_token',
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('../services/search.js', () => ({
  qmd: { upsert: vi.fn(async () => {}), rename: vi.fn(async () => {}), remove: vi.fn() },
}));
vi.mock('../services/links.js', () => ({ updateLinkGraphForFile: vi.fn(async () => {}) }));
vi.mock('../services/git.js', () => ({ scheduleAutoCommitOnSave: vi.fn() }));
vi.mock('../services/fileindex.js', () => ({
  resolveFile: vi.fn(() => null),
  indexFile: vi.fn(),
  unindexFile: vi.fn(),
}));
vi.mock('../services/shares.js', () => ({ onFileRenamed: vi.fn(async () => {}) }));

// ---------------------------------------------------------------------------
// Fixtures and assertion helpers
// ---------------------------------------------------------------------------

type VaultModule = typeof import('../services/vault.js');

/** Every refusal in `services/vault.ts` is an Error carrying an HTTP status. */
interface HttpError extends Error {
  status?: number;
}

let tmp: TmpDir;

beforeEach(async () => {
  // Order matters: evict the module registry FIRST, then set the env vars the
  // next import will read. See helpers.ts.
  resetSettingsCache();
  tmp = await makeTmpDataDir();
});

afterEach(async () => {
  await tmp.cleanup();
});

/**
 * Write this test's settings.json and hand back a freshly evaluated vault module.
 *
 * The module is re-imported per test rather than shared, which also resets
 * `canonicalVaultRoot`'s one-slot memo. Sharing it would let a memoised canonical
 * root from a previous test's (already deleted) temp directory decide the next
 * test's containment check.
 */
async function loadVault(vaultSettings: Record<string, unknown> = {}): Promise<VaultModule> {
  await writeSettings(tmp.dataDir, { vault: { path: tmp.vaultDir, ...vaultSettings } });
  return import('../services/vault.js');
}

/** Absolute path of something inside the test vault, from posix-style segments. */
function inVault(...segments: string[]): string {
  return path.join(tmp.vaultDir, ...segments);
}

/**
 * Await a call that MUST be refused and return the error it threw.
 *
 * Written as a helper rather than `expect(...).rejects` so the status and the
 * message can both be asserted on one object, and so that a call which
 * unexpectedly SUCCEEDS fails with "it resolved" rather than with a confusing
 * assertion about an undefined error.
 */
async function refusal(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error('expected the call to be refused, but it resolved');
}

async function onDisk(abs: string): Promise<boolean> {
  try {
    await fs.lstat(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * The containment invariant, stated as the filesystem sees it rather than as a
 * substring test on the request.
 */
function isInsideVault(abs: string): boolean {
  const root = path.resolve(tmp.vaultDir);
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  return abs === root || abs.startsWith(withSep);
}

/**
 * Can this host create a reparse point at all?
 *
 * Creating a symlink on Windows needs either administrator rights or Developer
 * Mode; a directory junction usually does not, but a locked-down host or an
 * exotic filesystem can refuse both. The alias tests below are meaningless
 * without one, so the capability is probed ONCE here and the tests are gated on
 * it with `it.runIf`, which reports them as skipped. The alternative (catching
 * the failure inside the test and returning) produces a test that passes while
 * asserting nothing, which is worse than one that visibly did not run.
 */
const linksArePermitted: boolean = await (async () => {
  const probe = await fs.mkdtemp(path.join(os.tmpdir(), 'webobsidian-linkprobe-'));
  try {
    const target = path.join(probe, 'target');
    await fs.mkdir(target);
    await fs.symlink(target, path.join(probe, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(probe, { recursive: true, force: true });
  }
})();

// ---------------------------------------------------------------------------
// 1. Traversal
// ---------------------------------------------------------------------------

describe('resolveInVault: traversal', () => {
  it('refuses a parent hop, and the file it points at stays unread and unwritten', async () => {
    const vault = await loadVault();
    // A real secret in the real place: the temp DATA_DIR is the vault's parent,
    // and it holds settings.json, which in production carries auth.jwtSecret,
    // both password hashes and git.token. That is the actual prize behind `..`,
    // so the escape target here is the one an attacker would pick.
    const secret = path.join(tmp.dataDir, 'secret.txt');
    await fs.writeFile(secret, 'SECRET');

    const read = await refusal(vault.readFileText('../secret.txt'));
    expect(read.status).toBe(400);
    expect(read.message).toBe('Path escapes vault');

    const deep = await refusal(vault.readFileText('notes/../../secret.txt'));
    expect(deep.status).toBe(400);

    // The refusal has to hold for writes too, and the proof is the absence of the
    // file rather than the presence of the error: a guard that throws after the
    // mkdir has already run is not a guard.
    const write = await refusal(vault.writeFileText('../pwned.md', 'X'));
    expect(write.status).toBe(400);
    expect(await onDisk(path.join(tmp.dataDir, 'pwned.md'))).toBe(false);

    // And the settings file the escape was aimed at is untouched and unread.
    expect(await fs.readFile(secret, 'utf8')).toBe('SECRET');
  });

  it('neutralises a rooted path into a vault-relative one instead of honouring it', async () => {
    const vault = await loadVault();
    // This is the case that string inspection gets wrong in both directions. An
    // absolute-looking request is not REFUSED here, it is stripped of its leading
    // separators and resolved inside the vault, so a test that asserted "throws"
    // would be asserting the wrong contract, and a test that asserted "does not
    // contain /etc" would pass for an implementation that returned /etc/passwd.
    // Assert the resolved path.
    await expect(vault.resolveInVault('/etc/passwd')).resolves.toBe(inVault('etc', 'passwd'));
    await expect(vault.resolveInVault('//etc/passwd')).resolves.toBe(inVault('etc', 'passwd'));
    await expect(vault.resolveInVault('/notes/a.md')).resolves.toBe(inVault('notes', 'a.md'));
  });

  it('never resolves a hostile spelling above the vault root, on any platform', async () => {
    const vault = await loadVault();
    // One table, one invariant, because the CORRECT outcome for several of these
    // is platform-dependent while the invariant is not. `a\..\..\x` is traversal
    // on Windows (backslash is a separator) and a single oddly-named file on
    // Linux (backslash is an ordinary character); `C:/x` escapes on Windows and
    // is a directory called "C:" on Linux. Asserting "throws" would therefore be
    // wrong on one platform or the other, while "either refused, or resolved to
    // something inside the vault" is exactly the guarantee the guard owes and it
    // holds everywhere.
    const hostile = [
      '../secret.txt',
      '..\\secret.txt',
      '../../../../../../etc/passwd',
      'notes/../../secret.txt',
      'notes\\..\\..\\secret.txt',
      'notes/./../../secret.txt',
      '/../secret.txt',
      '/..\\secret.txt',
      'C:\\Windows\\win.ini',
      'C:/Windows/win.ini',
      'C:notes.md', // drive-relative: not "absolute" per path.win32, still escapes
      '\\\\server\\share\\payload.md', // UNC
      '//server/share/payload.md',
      '....//secret.txt',
      '..%2Fsecret.txt', // pre-decoded by Express; included so a future decode is caught
    ];
    for (const spelling of hostile) {
      let resolved: string | null = null;
      try {
        resolved = await vault.resolveInVault(spelling);
      } catch (e) {
        expect((e as HttpError).status, `${spelling} should be refused with a 400`).toBe(400);
      }
      if (resolved !== null) {
        expect(isInsideVault(resolved), `${spelling} resolved outside the vault: ${resolved}`).toBe(
          true,
        );
      }
    }
  });

  it('refuses a NUL byte before it reaches the syscall', async () => {
    const vault = await loadVault();
    // NUL used to travel into libuv, which throws ERR_INVALID_ARG_VALUE with no
    // `status`, so a malformed request surfaced as a 500. The status is the
    // regression: a 400 says "your path is bad", a 500 says "the server is
    // broken" and buries real faults in the log.
    const e = await refusal(vault.resolveInVault('notes/a\0.md'));
    expect(e.status).toBe(400);
    expect(e.message).toBe('Path not allowed');
  });

  it.runIf(process.platform === 'win32')(
    'refuses a drive-qualified path and an NTFS alternate data stream',
    async () => {
      const vault = await loadVault();
      const drive = await refusal(vault.resolveInVault('C:\\Windows\\win.ini'));
      expect(drive.status).toBe(400);
      expect(drive.message).toBe('Path escapes vault');

      // A colon does not name a file on Windows, it selects a stream on one:
      // `attachments/note.md:hidden.js` attaches bytes to the EXISTING note,
      // where readdir cannot see them and the `wx` no-clobber flag does not fire
      // because the stream genuinely did not exist.
      const stream = await refusal(vault.resolveInVault('notes/note.md:hidden.js'));
      expect(stream.status).toBe(400);
      expect(stream.message).toBe('Path not allowed');
    },
  );

  it.runIf(linksArePermitted)(
    'refuses a path that leaves the vault through a link, not just through ".."',
    async () => {
      const vault = await loadVault();
      // The lexical prefix comparison structurally cannot see this one: the
      // string `escape/secret.txt` is inside the vault by every character-level
      // rule, and only canonicalisation reveals that `escape` is the vault's own
      // parent. This is the case that makes the second (realpath) pass load
      // bearing rather than belt-and-braces.
      const secret = path.join(tmp.dataDir, 'secret.txt');
      await fs.writeFile(secret, 'SECRET');
      await fs.symlink(
        tmp.dataDir,
        inVault('escape'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      const e = await refusal(vault.readFileText('escape/secret.txt'));
      expect(e.status).toBe(400);
      expect(e.message).toBe('Path escapes vault');
      expect(await fs.readFile(secret, 'utf8')).toBe('SECRET');
    },
  );

  it.runIf(linksArePermitted)(
    'refuses a link that aliases a protected directory without spelling its name',
    async () => {
      const vault = await loadVault();
      // `mklink /J pub .obsidian` needs no administrator, and after it
      // `PUT /api/files/content {"path":"pub/plugins/evil/main.js"}` passed every
      // character-level check and landed in the directory whose contents
      // services/plugins.ts hands to the SPA to execute. The request names no dot
      // segment at all, so only the canonical pass can see it.
      const pluginRoot = inVault('.obsidian', 'plugins', 'installed');
      await fs.mkdir(pluginRoot, { recursive: true });
      await fs.writeFile(path.join(pluginRoot, 'main.js'), 'SAFE');
      await fs.symlink(
        inVault('.obsidian'),
        inVault('pub'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      expect((await refusal(vault.resolveInVault('pub/plugins/installed/main.js'))).status).toBe(400);
      expect((await refusal(vault.writeFileText('pub/plugins/evil/main.js', 'PAYLOAD'))).status).toBe(
        400,
      );
      // The trash exception widens the dot rule for the path the caller NAMED,
      // never for wherever an alias happens to lead, so it is not a way back in.
      expect(
        (await refusal(vault.resolveInVault('pub/plugins/evil/main.js', { trash: { phase: 'root' } })))
          .status,
      ).toBe(400);

      expect(await fs.readFile(path.join(pluginRoot, 'main.js'), 'utf8')).toBe('SAFE');
      expect(await onDisk(inVault('.obsidian', 'plugins', 'evil'))).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// 2. Protected directories and the dot guard
// ---------------------------------------------------------------------------

describe('resolveInVault: .git, .obsidian and the dot guard', () => {
  it('refuses .git and .obsidian by every spelling, at every depth, in every mode', async () => {
    const vault = await loadVault();
    const denied = [
      '.git',
      '.git/hooks/post-merge',
      '.GIT/hooks/post-merge', // case-folded: same directory on Windows and macOS
      'notes/.git/config',
      '.obsidian',
      '.obsidian/plugins/evil/main.js',
      '.Obsidian/plugins/evil/main.js',
      '.obsidian/types.json',
      'notes/.obsidian/x.json',
    ];
    for (const rel of denied) {
      const e = await refusal(vault.resolveInVault(rel));
      expect(e.status, `${rel} should be refused`).toBe(400);
      expect(e.message, `${rel} should be refused`).toBe('Path not allowed');
    }

    // The trash exception widens the DOT rule and nothing else. This is the
    // load-bearing half of closing `vault.trash = ".obsidian"`: the two rules are
    // separate, and the protected-directory one has no opt-out.
    const viaTrash = await refusal(
      vault.resolveInVault('.obsidian/plugins/evil/main.js', { trash: { phase: 'root' } }),
    );
    expect(viaTrash.status).toBe(400);
    expect(viaTrash.message).toBe('Path not allowed');
  });

  it('does not create, overwrite or disclose anything under .obsidian', async () => {
    const vault = await loadVault();
    // `.obsidian/plugins/<id>/main.js` is handed to the SPA and executed, so a
    // write here is code execution in every browser that opens the vault. Assert
    // the bytes, not the error: an error that arrives after the write is not a
    // guard.
    const pluginDir = inVault('.obsidian', 'plugins', 'installed');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, 'main.js'), 'SAFE');
    await fs.writeFile(inVault('.obsidian', 'types.json'), '{"secret":"yes"}');

    await refusal(vault.writeFileText('.obsidian/plugins/installed/main.js', 'PAYLOAD'));
    await refusal(vault.writeFileBuffer('.obsidian/plugins/evil/main.js', Buffer.from('PAYLOAD')));
    await refusal(vault.createFolder('.obsidian/plugins/evil'));
    await refusal(vault.readFileText('.obsidian/types.json'));
    await refusal(vault.remove('.obsidian/types.json'));

    expect(await fs.readFile(path.join(pluginDir, 'main.js'), 'utf8')).toBe('SAFE');
    expect(await onDisk(inVault('.obsidian', 'plugins', 'evil'))).toBe(false);
    expect(await onDisk(inVault('.obsidian', 'types.json'))).toBe(true);
  });

  it('refuses any dot segment, file or directory, outside the trash exception', async () => {
    const vault = await loadVault();
    // Not only directories. A dot FILE is equally invisible to the tree, to
    // search and to the file index, so a note created at `.hidden.md` could never
    // be reopened through the UI: the write-somewhere-the-operator-cannot-see
    // primitive, reached without a directory.
    for (const rel of ['.env', '.hidden.md', 'notes/.secret/x.md', 'notes/.env']) {
      const e = await refusal(vault.resolveInVault(rel));
      expect(e.status, `${rel} should be refused`).toBe(400);
      expect(e.message).toBe('Path not allowed');
    }
    // Ordinary paths still work, which is the other half of the contract.
    await expect(vault.resolveInVault('notes/a.md')).resolves.toBe(inVault('notes', 'a.md'));
    await expect(vault.resolveInVault('notes/sub.dir/a.md')).resolves.toBe(
      inVault('notes', 'sub.dir', 'a.md'),
    );
  });

  it('applies the same rules to resolveDirCaseInsensitive, the second door in', async () => {
    const vault = await loadVault();
    // Two entry points, one rule set. The upload route reaches the disk through
    // this one, and it used to split on `/` only, so a Windows-style
    // `a\..\..\etc` arrived as a single "segment" that path.join then normalised
    // straight out of the vault. It also used to readdir() every attacker-named
    // ancestor on the way, which is a directory-existence oracle outside the
    // vault even when the final path is rejected afterwards.
    for (const rel of ['.obsidian/plugins', '.git', 'a\\..\\..\\etc', 'a/../../etc', '.hidden']) {
      const e = await refusal(vault.resolveDirCaseInsensitive(rel));
      expect(e.status, `${rel} should be refused`).toBe(400);
    }
    await expect(vault.resolveDirCaseInsensitive('attachments/sub')).resolves.toBe(
      'attachments/sub',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The trash root
// ---------------------------------------------------------------------------

describe('trash: containment and the legitimate workflow', () => {
  it('keeps a traversing vault.trash inside the vault instead of writing outside it', async () => {
    // Two independent layers have to hold, and this asserts both. The settings
    // schema refuses the value and self-heals to the default (it must SELF-HEAL
    // rather than throw: loadSettings treats any parse failure as "file unusable"
    // and rewrites from defaults, which would destroy jwtSecret and git.token).
    // services/vault.ts then re-derives the root through resolveInVault anyway,
    // so containment does not depend on how the value got in.
    const vault = await loadVault({ trash: '../../evil' });
    const { getSettings } = await import('../services/settings.js');
    expect((await getSettings()).vault.trash).toBe('.trash');

    await vault.writeFileText('notes/a.md', 'A');
    const dest = await vault.trash('notes/a.md');

    expect(dest).toBe('.trash/notes/a.md');
    expect(await onDisk(inVault('.trash', 'notes', 'a.md'))).toBe(true);
    // The blast radius, asserted directly: `listTrash` walks this root and
    // `emptyTrash`/`deleteFromTrash` run fs.rm(recursive, force) over it, so a
    // traversing value is arbitrary directory listing plus recursive deletion.
    expect(await onDisk(path.join(tmp.dataDir, 'evil'))).toBe(false);
    expect(await onDisk(path.resolve(tmp.dataDir, '..', 'evil'))).toBe(false);
  });

  it('refuses a vault.trash of .obsidian, which the settings schema does accept', async () => {
    const vault = await loadVault({ trash: '.obsidian' });
    const { getSettings } = await import('../services/settings.js');
    // The value really is stored: `isVaultRelativeSubpath` rejects `..`,
    // absolutes, drive letters and UNC, and has no opinion about a leading dot,
    // so `PUT /api/settings {"vault":{"trash":".obsidian"}}` is a 200. That is
    // what made the trash subsystem a general-purpose door into the plugin
    // directory, and it is why the refusal has to live in vault.ts.
    expect((await getSettings()).vault.trash).toBe('.obsidian');

    const pluginDir = inVault('.obsidian', 'plugins', 'installed');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, 'main.js'), 'SAFE');
    await vault.writeFileText('notes/a.md', 'A');

    // WRITE: trash() built `<trashRoot>/<source rel path>`, so an ordinary
    // create-then-delete relocated attacker bytes into .obsidian/plugins.
    const moved = await refusal(vault.trash('notes/a.md'));
    expect(moved.status).toBe(400);
    expect(await vault.readFileText('notes/a.md')).toBe('A');

    // READ: listTrash() enumerated the plugin directory.
    expect((await refusal(vault.listTrash())).status).toBe(400);
    // RESTORE: restoreFromTrash() moved any entry of it into the visible vault.
    expect((await refusal(vault.restoreFromTrash('.obsidian/plugins/installed/main.js'))).status)
      .toBe(400);
    // DESTROY: emptyTrash() and deleteFromTrash() are fs.rm(recursive, force).
    expect((await refusal(vault.emptyTrash())).status).toBe(400);
    expect((await refusal(vault.deleteFromTrash('.obsidian/plugins/installed/main.js'))).status)
      .toBe(400);

    expect(await fs.readFile(path.join(pluginDir, 'main.js'), 'utf8')).toBe('SAFE');
  });

  it('permits a dot only on the trash root head segment', async () => {
    // The exception exists for the one `.trash` convention at the top of a vault
    // and for nothing else, so a nested dot directory is refused even though it
    // is neither .git nor .obsidian.
    const nested = await loadVault({ trash: 'sub/.hidden' });
    await nested.writeFileText('notes/a.md', 'A');
    expect((await refusal(nested.trash('notes/a.md'))).status).toBe(400);
    expect(await onDisk(inVault('sub', '.hidden'))).toBe(false);
  });

  it('supports a trash root that needs no exception at all', async () => {
    const vault = await loadVault({ trash: 'archive/trash' });
    await vault.writeFileText('notes/a.md', 'A');
    expect(await vault.trash('notes/a.md')).toBe('archive/trash/notes/a.md');
    expect(await vault.readFileText('archive/trash/notes/a.md')).toBe('A');
  });

  it('still runs the whole .trash workflow: delete, list, restore, empty', async () => {
    // The other half of the contract, and the reason it is in the same file as
    // the containment tests: a "fix" that hardens the trash root by breaking the
    // default `.trash` is a regression, not a fix. Both must hold together.
    const vault = await loadVault(); // default: '.trash'
    await vault.writeFileText('notes/a.md', 'A');
    await vault.writeFileText('notes/b.md', 'B');

    const dest = await vault.trash('notes/a.md');
    expect(dest).toBe('.trash/notes/a.md');
    expect(await onDisk(inVault('notes', 'a.md'))).toBe(false);
    expect(await fs.readFile(inVault('.trash', 'notes', 'a.md'), 'utf8')).toBe('A');
    // Read back through the module rather than through fs, because the dot guard
    // means `readFileText('.trash/...')` is refused: trashed items are reachable
    // only through the trash API, which is the intended shape.
    expect((await refusal(vault.readFileText('.trash/notes/a.md'))).status).toBe(400);

    const listed = await vault.listTrash();
    expect(listed).toHaveLength(1);
    expect(listed[0].path).toBe('.trash/notes/a.md');
    expect(listed[0].original).toBe('notes/a.md');
    expect(listed[0].name).toBe('a.md');

    const restored = await vault.restoreFromTrash('.trash/notes/a.md');
    expect(restored).toBe('notes/a.md');
    expect(await vault.readFileText('notes/a.md')).toBe('A');
    expect(await vault.listTrash()).toEqual([]);
    // The now-empty `.trash/notes` is pruned, but the trash root itself survives.
    expect(await onDisk(inVault('.trash', 'notes'))).toBe(false);

    // And the destructive half still works on the item it is aimed at.
    await vault.trash('notes/b.md');
    await vault.deleteFromTrash('.trash/notes/b.md');
    expect(await vault.listTrash()).toEqual([]);
    expect(await vault.readFileText('notes/a.md')).toBe('A');
  });

  it('restores under a fresh name rather than clobbering a recreated note', async () => {
    const vault = await loadVault();
    await vault.writeFileText('notes/a.md', 'ORIGINAL');
    await vault.trash('notes/a.md');
    await vault.writeFileText('notes/a.md', 'RECREATED');

    const restored = await vault.restoreFromTrash('.trash/notes/a.md');
    expect(restored).not.toBe('notes/a.md');
    expect(restored).toMatch(/^notes\/a\.restored-\d+-[0-9a-f]+\.md$/);
    // The file that was standing there is the thing that must survive.
    expect(await vault.readFileText('notes/a.md')).toBe('RECREATED');
    expect(await vault.readFileText(restored)).toBe('ORIGINAL');
  });
});

// ---------------------------------------------------------------------------
// 4. rename must not clobber
// ---------------------------------------------------------------------------

describe('rename: no silent clobber', () => {
  it('refuses an existing destination and leaves both files intact', async () => {
    const vault = await loadVault();
    await vault.writeFileText('a.md', 'A');
    await vault.writeFileText('b.md', 'B');

    const e = await refusal(vault.rename('a.md', 'b.md'));
    expect(e.status).toBe(409);
    expect(e.message).toBe('Destination already exists');

    // This pair is the regression. `fs.rename` replaces its destination on every
    // platform this ships to, so renaming A onto B used to destroy B's content,
    // report ok: true, and leave the caller no way to detect it: no error, no
    // trash copy, and a rename is not a save so there is no version history.
    expect(await vault.readFileText('b.md')).toBe('B');
    expect(await vault.readFileText('a.md')).toBe('A');
  });

  it('refuses a destination occupied by a folder', async () => {
    const vault = await loadVault();
    await vault.writeFileText('a.md', 'A');
    await vault.createFolder('taken');
    await vault.writeFileText('taken/keep.md', 'KEEP');

    expect((await refusal(vault.rename('a.md', 'taken'))).status).toBe(409);
    expect(await vault.readFileText('taken/keep.md')).toBe('KEEP');
    expect(await vault.readFileText('a.md')).toBe('A');
  });

  it('still renames onto a free name, creating parent folders', async () => {
    // The no-clobber implementation borrows its atomicity from fs.link, which
    // fails for reasons that say nothing about the destination (EXDEV, EPERM on
    // FAT/SMB/FUSE, EISDIR for a directory source). Those fall back to a plain
    // rename on purpose, so the ordinary path has to be asserted alongside the
    // refusal or a fallback bug would be invisible.
    const vault = await loadVault();
    await vault.writeFileText('a.md', 'A');

    await vault.rename('a.md', 'sub/dir/c.md');
    expect(await vault.readFileText('sub/dir/c.md')).toBe('A');
    expect(await onDisk(inVault('a.md'))).toBe(false);
    // One name, not two: if the link lands and the unlink fails, the link is
    // removed again rather than silently turning one note into two names for one
    // inode.
    expect(await fs.readdir(tmp.vaultDir)).toEqual(['sub']);
  });

  it('permits a case-only rename, which file identity decides and strings cannot', async () => {
    const vault = await loadVault();
    await vault.writeFileText('note.md', 'A');
    // On NTFS and a case-insensitive APFS volume the "existing destination" IS
    // the source file, and `link` reports EEXIST for it, so a legitimate case
    // change came back as a 409. On a case-sensitive filesystem the two names are
    // genuinely different files and this is an ordinary rename. Both end here.
    await vault.rename('note.md', 'Note.md');
    expect(await vault.readFileText('Note.md')).toBe('A');
    expect(await fs.readdir(tmp.vaultDir)).toEqual(['Note.md']);
  });
});

// ---------------------------------------------------------------------------
// 5. A mutation may never resolve to the vault root
// ---------------------------------------------------------------------------

describe('mutations: the vault root itself is not a target', () => {
  it('refuses every spelling of the root, and drops no temp file beside the vault', async () => {
    const vault = await loadVault();
    await vault.writeFileText('keep.md', 'KEEP');
    const before = (await fs.readdir(tmp.dataDir)).sort();

    for (const rel of ['', '.', './', '/', '\\', '//']) {
      const write = await refusal(vault.writeFileText(rel, 'PAYLOAD'));
      expect(write.status, `writeFileText(${JSON.stringify(rel)})`).toBe(400);
      expect(write.message).toBe('Path required');
      expect((await refusal(vault.writeFileBuffer(rel, Buffer.from('P')))).status).toBe(400);
      expect((await refusal(vault.createFolder(rel))).status).toBe(400);
      expect((await refusal(vault.remove(rel))).status).toBe(400);
      expect((await refusal(vault.rename('keep.md', rel))).status).toBe(400);
    }

    // THE regression, and the reason this guard is in vault.ts rather than in
    // each route. `writeFileText` writes `<dir>/.<basename>.tmp-...` and then
    // renames it into place. With `abs === root` that temp file is
    // `${root}.tmp-...`: a SIBLING of the vault directory, one level outside the
    // sandbox and next to data/settings.json. The rename onto the root then
    // fails, so the stray file was never cleaned up and repeated calls simply
    // piled up attacker-named files outside the vault. Comparing the parent
    // directory's listing before and after is the only assertion that sees it.
    expect((await fs.readdir(tmp.dataDir)).sort()).toEqual(before);
    expect(await vault.readFileText('keep.md')).toBe('KEEP');
    // `remove('.')` is fs.rm(root, recursive, force): the whole vault, with no
    // error at all.
    expect(await onDisk(tmp.vaultDir)).toBe(true);
    expect(await fs.readdir(tmp.vaultDir)).toEqual(['keep.md']);
  });

  it('still resolves the root for a read, which is the deliberate asymmetry', async () => {
    const vault = await loadVault();
    // resolveInVault('') is legitimate and listTree/getTrashRoot depend on it;
    // only the MUTATING entry points add the extra refusal. Asserting this stops
    // a future "fix" from hardening resolveInVault itself and breaking the tree.
    await expect(vault.resolveInVault('')).resolves.toBe(path.resolve(tmp.vaultDir));
    await expect(vault.resolveInVault('.')).resolves.toBe(path.resolve(tmp.vaultDir));
    await expect(vault.resolveInVault('/')).resolves.toBe(path.resolve(tmp.vaultDir));
  });
});

// ---------------------------------------------------------------------------
// 6. Upload filename sanitisation
// ---------------------------------------------------------------------------

/**
 * `safeUploadFilename` is module-private, so it is exercised through
 * `POST /api/files/upload` with a hand-built multipart body: the exact bytes an
 * attacker would put in the Content-Disposition header, rather than supertest's
 * `.attach()`, which goes through the `form-data` package and normalises the
 * filename before it ever reaches the wire.
 *
 * WHAT THESE TESTS DO AND DO NOT PROVE, measured against busboy 1.x rather than
 * assumed. `busboy/lib/utils.js` applies its own `basename()` to every filename
 * parameter before multer sees it, and that function splits on `/` AND `\` and
 * maps a result of `.` or `..` to the empty string. Measured on this tree:
 *
 *     "a\b\c.png"  -> file.originalname === "c.png"
 *     ".."         -> filename "", which multer 2 skips entirely (no req.file)
 *     ".env"       -> ".env"        (reaches safeUploadFilename intact)
 *     "..."        -> "..."         (reaches safeUploadFilename intact)
 *
 * So these are STACK tests: they prove the property the original finding was
 * about, that a client-supplied `originalname` can never become more than one
 * path component and can never leave the target directory, and that the upload
 * route is the thing that holds it. They do NOT isolate `safeUploadFilename`'s
 * own split-on-both-separators branch, because no filename containing a
 * backslash survives busboy to reach it. That branch is real defence in depth
 * (nothing guarantees the next multipart parser basenames anything, and
 * `originalname` is documented by multer as untrusted), and covering it directly
 * needs the function exported from `routes/files.ts`, which is not this file's
 * to change.
 */
const BOUNDARY = 'webobsidianvaulttestboundary';

function multipartUpload(filename: string, content: string, dir: string): Buffer {
  return Buffer.from(
    [
      `--${BOUNDARY}`,
      'Content-Disposition: form-data; name="dir"',
      '',
      dir,
      `--${BOUNDARY}`,
      `Content-Disposition: form-data; name="file"; filename="${filename}"`,
      'Content-Type: application/octet-stream',
      '',
      content,
      `--${BOUNDARY}--`,
      '',
    ].join('\r\n'),
    'utf8',
  );
}

describe('upload filenames: one path component, always', () => {
  async function uploadApp() {
    await loadVault();
    const { filesRouter } = await import('../routes/files.js');
    const { errorHandler } = await import('../middleware/error.js');
    const app = makeTestApp();
    app.use('/api/files', filesRouter);
    // Without this the route's `Object.assign(new Error(...), { status: 400 })`
    // reaches Express's default handler and comes back as a 500, so the status
    // assertions below would be testing the absence of a middleware.
    app.use(errorHandler);
    return app;
  }

  function post(app: ReturnType<typeof makeTestApp>, body: Buffer) {
    return request(app)
      .post('/api/files/upload')
      .set('Content-Type', `multipart/form-data; boundary=${BOUNDARY}`)
      .send(body);
  }

  it('collapses a backslash-separated traversal to its last component', async () => {
    const app = await uploadApp();
    // Backslashes are DOUBLED on the wire because a quoted-string parameter in a
    // MIME header uses backslash as its own escape character, so a single `\.`
    // would be unescaped to `.` before anything downstream saw a separator at
    // all. `\\` decodes to one literal backslash: what an attacker targeting a
    // Windows server sends, and what `path.posix.basename` (which the pre-fix
    // code relied on) treats as an ordinary filename character rather than as a
    // separator.
    const res = await post(
      app,
      multipartUpload('..\\\\..\\\\.obsidian\\\\plugins\\\\evil\\\\main.js', 'PAYLOAD', 'attachments'),
    );

    expect(res.status).toBe(200);
    // The resolved outcome: one component, under the requested directory.
    expect(res.body.path).toBe('attachments/main.js');
    expect(path.posix.basename(res.body.path)).toBe('main.js');
    expect(await fs.readFile(inVault('attachments', 'main.js'), 'utf8')).toBe('PAYLOAD');
    // And nothing anywhere near the plugin directory, inside the vault or beside
    // it. This is the actual finding: multer passes `originalname` through
    // verbatim and it was joined straight onto the target directory.
    expect(await onDisk(inVault('.obsidian'))).toBe(false);
    expect(await onDisk(path.join(tmp.dataDir, '.obsidian'))).toBe(false);
  });

  it('collapses forward-slash traversal and every other hostile spelling', async () => {
    const app = await uploadApp();
    const hostile = [
      '../../evil.png',
      '/etc/passwd.png',
      'a/b/c/deep.png',
      'a\\\\b\\\\deep2.png',
      '..\\\\/mixed.png',
    ];
    for (const name of hostile) {
      const res = await post(app, multipartUpload(name, 'X', 'attachments'));
      expect(res.status, `${name} -> ${JSON.stringify(res.body)}`).toBe(200);
      const rel: string = res.body.path;
      // The invariant, stated on the OUTCOME: whatever name was minted, it is a
      // single component sitting directly in the requested directory.
      expect(path.posix.dirname(rel), name).toBe('attachments');
      const base = path.posix.basename(rel);
      expect(base.includes('/'), name).toBe(false);
      expect(base.includes('\\'), name).toBe(false);
      expect(await onDisk(inVault('attachments', base)), name).toBe(true);
    }
  });

  it('refuses a name that sanitises to nothing or to a dot file', async () => {
    const app = await uploadApp();
    // A leading dot stays a hard refusal rather than a rewrite: silently renaming
    // `.env` into something visible is more surprising than telling the caller
    // no, and an invisible file is the write-somewhere-the-operator-cannot-see
    // primitive the vault's own dot guard exists to remove. `...` and `. ` reach
    // the sanitiser intact and are reduced to the empty string by the
    // trailing-dot-and-space strip, which the emptiness test then catches.
    for (const name of ['.env', '.hidden.md', '...', '. ']) {
      const res = await post(app, multipartUpload(name, 'X', 'attachments'));
      expect(res.status, name).toBe(400);
      expect(res.body.error, name).toBe('Invalid file name');
    }

    // `.` and `..` never reach safeUploadFilename: busboy's own basename() maps
    // both to the empty string and multer 2 skips a file part with no filename,
    // so the route answers "file required" instead. Asserted anyway, because the
    // outcome is what matters (400, and nothing on disk) and because the message
    // documents WHERE the refusal actually happens, which is not where reading
    // routes/files.ts alone would suggest.
    for (const name of ['.', '..']) {
      const res = await post(app, multipartUpload(name, 'X', 'attachments'));
      expect(res.status, name).toBe(400);
      expect(res.body.error, name).toBe('file required');
    }

    expect(await onDisk(inVault('attachments', '.env'))).toBe(false);
    expect(await onDisk(inVault('attachments'))).toBe(false);
  });

  it('rewrites the characters that make a name lie or select an NTFS stream', async () => {
    const app = await uploadApp();
    // The colon is the security-relevant one: on Windows `note.md:hidden.js` does
    // not create a file, it attaches bytes to the existing `note.md` where
    // readdir, the search index and git never see them. Rewritten rather than
    // refused because the flows that reach here are clipboard paste and
    // drag-and-drop, where a hard error costs the user the screenshot they just
    // took, and because the rewrite has to happen on Linux too: an attachment is
    // expected to survive a checkout onto a Windows client.
    const res = await post(app, multipartUpload('note.md:hidden.js', 'X', 'attachments'));
    expect(res.status).toBe(200);
    expect(res.body.path).toBe('attachments/note.md-hidden.js');
    expect(await onDisk(inVault('attachments', 'note.md-hidden.js'))).toBe(true);

    // Trailing dots and spaces are stripped: Node addresses files through the
    // extended-length `\\?\` syntax and so creates a genuinely separate
    // `report.md.` that the tree lists but Explorer, git and Obsidian desktop
    // cannot open.
    const trailing = await post(app, multipartUpload('report.md. ', 'X', 'attachments'));
    expect(trailing.status).toBe(200);
    expect(trailing.body.path).toBe('attachments/report.md');

    // A reserved device name gets its suffix spliced in after the device word,
    // not appended, so the extension the file actually has survives.
    const device = await post(app, multipartUpload('con.md', 'X', 'attachments'));
    expect(device.status).toBe(200);
    expect(device.body.path).toBe('attachments/con-file.md');
  });

  it('uniquifies instead of destroying an attachment that is already there', async () => {
    const app = await uploadApp();
    const first = await post(app, multipartUpload('image.png', 'FIRST', 'attachments'));
    const second = await post(app, multipartUpload('image.png', 'SECOND', 'attachments'));

    expect(first.body.path).toBe('attachments/image.png');
    expect(second.body.path).toBe('attachments/image-1.png');
    // Clipboard paste hands every screenshot the same `image.png`, so a hard 409
    // would break the paste flow and a silent overwrite would delete the
    // previously pasted image with no error and no trash copy.
    expect(await fs.readFile(inVault('attachments', 'image.png'), 'utf8')).toBe('FIRST');
    expect(await fs.readFile(inVault('attachments', 'image-1.png'), 'utf8')).toBe('SECOND');
  });
});
