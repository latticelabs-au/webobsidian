import { promises as fs, realpath as realpathCallback } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { getSettings } from './settings.js';

export interface TreeNode {
  name: string;
  path: string; // vault-relative, posix style
  type: 'file' | 'folder';
  ext?: string;
  size?: number;
  mtime?: number; // last-modified (ms): for sort-by-modified-time
  ctime?: number; // created/birth (ms): for sort-by-created-time
  children?: TreeNode[];
}

/**
 * In-memory mtime/ctime cache so sort-by-time costs ONE stat per file total,
 * not 27k stats on every tree fetch (the tree is refetched on each fs event).
 * Filled lazily during listTree(); the file watcher invalidates changed paths
 * (see invalidateStat), so steady-state tree fetches do zero extra syscalls.
 */
const statCache = new Map<string, { m: number; c: number }>();

export function invalidateStat(rel: string): void {
  statCache.delete(rel);
}

async function fileStat(abs: string, rel: string): Promise<{ m: number; c: number }> {
  const hit = statCache.get(rel);
  if (hit) return hit;
  let v = { m: 0, c: 0 };
  try {
    const st = await fs.stat(abs);
    // birthtime can be 0 on some Linux filesystems → fall back to mtime.
    v = { m: st.mtimeMs, c: st.birthtimeMs || st.mtimeMs };
  } catch { /* file vanished mid-walk: leave zeros */ }
  statCache.set(rel, v);
  return v;
}

const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.csv', '.canvas', '.css', '.js', '.yml', '.yaml',
]);

const IGNORED = new Set(['.git', 'node_modules']);

/**
 * Directories inside the vault whose contents THIS SERVER treats as code or
 * configuration rather than as notes, and which are therefore never addressable
 * through the files API by any spelling, in any mode, including the trash
 * exception below.
 *
 * The list is short because it is a statement about our own behaviour, not a
 * guess at what a user might consider sensitive:
 *
 *  - `.git`: `services/git.ts` runs git against the vault, so a write to
 *    `.git/hooks/post-merge` executes on the next sync.
 *  - `.obsidian`: `services/plugins.ts` builds `<root>/.obsidian/plugins` and
 *    hands `<id>/main.js` to the SPA to execute, and `services/propertytypes.ts`
 *    reads `<root>/.obsidian/types.json`. A write there is remote code execution
 *    in every browser that opens the vault; a read there returns whatever
 *    credentials a plugin has stored in its `data.json`.
 *
 * Both of those consumers build their paths from `getVaultRoot()` directly and
 * never come through `resolveInVault`, so denying the names here costs the
 * server none of its own functionality. Names are compared case-folded because
 * on Windows and macOS `.GIT` and `.Obsidian` are the same directories, and on
 * Linux, where they are not, refusing them inside a note vault costs nobody
 * anything.
 */
const PROTECTED_DIRS = new Set(['.git', '.obsidian']);

export async function getVaultRoot(): Promise<string> {
  const s = await getSettings();
  return path.resolve(s.vault.path);
}

/**
 * The one blessed exception to the leading-dot guard, and the shape of that
 * blessing.
 *
 * This replaces a plain `allowDotDirs: boolean`, which was a general hole rather
 * than an exception. That flag said "dot segments are acceptable on this call"
 * and left the question of WHICH dot directory entirely to whatever string the
 * caller happened to pass. The trash root is operator-configurable and
 * legitimately begins with a dot, so `vault.trash` was a documented,
 * HTTP-reachable bypass of the entire guard: `isVaultRelativeSubpath`
 * (`services/settings.ts`) rejects `..`, absolutes, drive letters and UNC, but
 * it does not reject a leading dot, so
 * `PUT /api/settings {"vault":{"trash":".obsidian"}}` was a 200, and from that
 * moment the trash subsystem was a general-purpose door into `.obsidian`.
 * Reproduced end to end by the round-2 reviewer, all three primitives the dot
 * guard exists to remove:
 *
 *  - WRITE: `trash()` builds its destination as `<trashRoot>/<source rel path>`,
 *    so an ordinary `PUT /api/files/content` followed by an ordinary
 *    `DELETE /api/files?path=...` relocated attacker bytes to
 *    `.obsidian/plugins/<id>/main.js`, which `routes/plugins.ts` then serves to
 *    the SPA to execute.
 *  - READ: `listTrash()` enumerated `.obsidian`, and `restoreFromTrash()` moved
 *    any entry of it back into the visible vault where `GET /api/files/content`
 *    reads it.
 *  - DESTROY: `emptyTrash()` is `fs.rm(recursive, force)` over every entry of
 *    the trash root.
 *
 * The exception is therefore scoped three independent ways now instead of one,
 * and every one of them is evaluated against the CANONICAL location the
 * filesystem reports rather than the spelling the request used (see
 * `assertRealpathInVault`), because a rule that only ever sees the request
 * string is decorative on a filesystem that gives one directory several names:
 *
 *  1. `PROTECTED_DIRS` is denied in EVERY mode, trash included. That is the
 *     explicit blessing boundary: `.git` and `.obsidian` are not addressable
 *     through this module by any door, so no trash setting can name them.
 *  2. `phase: 'root'` (this call is resolving `settings.vault.trash` itself)
 *     additionally permits a dot only on the FIRST segment. A trash root needs
 *     the exception solely because of the `.trash` convention, and that is all
 *     it needs it for; nothing legitimate wants a dot segment nested underneath
 *     an ordinary directory, so `sub/.hidden` is refused as a trash root.
 *  3. `phase: 'inside'` (this call addresses an item that must already be in the
 *     trash) pins the resolved canonical path inside the resolved canonical
 *     trash root. That is strictly stronger than the `assertInTrash` the call
 *     sites already run afterwards, because `assertInTrash` compares lexical
 *     strings and so cannot see a junction planted inside the trash folder.
 */
export type TrashScope =
  | { readonly phase: 'root' }
  | { readonly phase: 'inside'; readonly trashRoot: string };

export interface ResolveOptions {
  /**
   * Opt in to the trash exception described above. Absent is the default, and it
   * is the only correct value for anything driven by a request body or query
   * string.
   *
   * Why the default is deny: dot directories are exactly the ones the tree view,
   * the file index and `listMarkdownFiles` all skip, so nothing a user can see or
   * click ever needs them, while the app itself treats their contents as *code
   * and configuration* rather than as notes. The worst case is concrete:
   * `.obsidian/plugins/<id>/main.js` is later handed to the SPA and executed, so
   * an authenticated (or API-key) write there is remote code execution in every
   * browser that opens the vault. `.obsidian/types.json`, snippets and workspace
   * files are the same class of problem one step down.
   *
   * The server's own features that legitimately live under a dot directory
   * (plugins, property types) build their paths from `getVaultRoot()` directly
   * and never come through here, so they are unaffected. The trash subsystem is
   * the only in-tree caller that opts in, and it is now the only thing that CAN:
   * the option carries the trash root with it rather than being a bare boolean
   * any future caller could set for an unrelated reason.
   */
  trash?: TrashScope;
}

/**
 * The per-segment rules that decide whether a vault-relative path is addressable
 * at all.
 *
 * Factored out of `resolveInVault` because it now has to run TWICE per
 * resolution, once on the string the client sent and once on the canonical name
 * the filesystem hands back, and because `resolveDirCaseInsensitive` has to
 * enforce exactly the same set. Three copies of these rules would drift.
 */
function assertSegmentsAllowed(segments: string[], allowDotDirs: boolean): void {
  for (const seg of segments) {
    // NUL previously travelled all the way into the syscall, where Node throws
    // ERR_INVALID_ARG_VALUE with no `status`, so a malformed request surfaced as
    // a 500 and put a spurious "the server is broken" line in the log.
    // `resolveDirCaseInsensitive` already rejected it; now both agree.
    if (seg.includes('\0')) {
      throw Object.assign(new Error('Path not allowed'), { status: 400 });
    }
    // Never resolve into a directory this server executes or reads as its own
    // configuration: `.git/hooks/post-merge` runs on the next git sync, and
    // `.obsidian/plugins/<id>/main.js` is served to the SPA to execute. See
    // PROTECTED_DIRS for the full reasoning and the case-folding rationale.
    //
    // This runs in EVERY mode, the trash exception included, and that is the
    // load-bearing half of closing the `vault.trash = ".obsidian"` bypass: the
    // trash exception can widen which dot directories are reachable, but it can
    // never reach these two, because the widening and this denial are separate
    // rules and this one has no opt-out.
    if (PROTECTED_DIRS.has(seg.toLowerCase())) {
      throw Object.assign(new Error('Path not allowed'), { status: 400 });
    }
    // Leading-dot guard (see ResolveOptions.trash for the reasoning, and for why
    // the one caller that relaxes this cannot relax it into a protected dir).
    // Applied to every segment, not just directories: a dot *file* is equally
    // invisible to the tree and to search, so a note created at `.hidden.md`
    // could never be reopened through the UI. Refusing it costs a user nothing
    // and removes the "write somewhere the operator cannot see" primitive.
    if (!allowDotDirs && seg.startsWith('.')) {
      throw Object.assign(new Error('Path not allowed'), { status: 400 });
    }
    // Windows only: a colon does not name a file, it selects an NTFS alternate
    // data stream on one. `attachments/note.md:hidden.js` does not create
    // `hidden.js`; it attaches attacker-controlled bytes to the EXISTING
    // `attachments/note.md`. Measured on this platform: the host file's own
    // content is untouched, `readdir` does not list the stream (so neither the
    // tree, nor the search index, nor git ever sees it), and the stream reads
    // back in full afterwards. The `wx` flag in `writeFileBuffer` is no defence
    // either, because the stream genuinely did not exist yet, so the write
    // succeeds and the uniquifier believes it created a fresh file. That is the
    // same "write somewhere the operator cannot see" primitive the dot guard
    // removes, reached by a different spelling.
    //
    // Platform-gated on purpose. A colon is an ordinary, legal character in a
    // POSIX filename, so enforcing this everywhere would make a Linux vault's
    // existing "meeting: notes.md" permanently unreadable AND undeletable
    // through the API, which is a worse outcome than the bug. On Windows no
    // legitimate file can carry one, so the rule costs nothing there.
    //
    // Deliberately NOT rejected here, having been measured rather than assumed:
    // trailing dots/spaces (`note.md.`) and reserved device names (`CON`,
    // `NUL`). Node addresses files through the extended-length `\\?\` syntax,
    // which bypasses Win32 name canonicalisation, so both land as ordinary,
    // distinct, `readdir`-visible files rather than aliasing an existing note or
    // reaching a device. They are a portability wart for Windows clients, which
    // is handled where names are minted (`safeUploadFilename` in routes/files),
    // not here, where a rule would only make an already-created file impossible
    // to delete.
    if (process.platform === 'win32' && seg.includes(':')) {
      throw Object.assign(new Error('Path not allowed'), { status: 400 });
    }
  }
}

/**
 * A trash ROOT may carry a dot on its first segment and nowhere else.
 *
 * `.trash` and `.trash/2026` are fine; `archive/trash` never needed the
 * exception in the first place; `sub/.hidden` and `.obsidian/plugins` are
 * refused. The rule exists because the only reason a trash root needs the dot
 * exception at all is the convention of one hidden folder at the top of the
 * vault, so that is exactly as much as it gets. Combined with `PROTECTED_DIRS`
 * (which removes `.obsidian` and `.git` outright) this turns "a dot is allowed
 * here" from a hole into a bounded exception with a stated shape.
 *
 * Run against the requested spelling AND against the canonical path, because a
 * setting of `pub` where `pub` is a junction to `sub/.hidden` is the same
 * request wearing a different name.
 */
function assertDotOnlyAtHead(segments: string[]): void {
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i].startsWith('.')) {
      throw Object.assign(new Error('Path not allowed'), { status: 400 });
    }
  }
}

/** Resolve a vault-relative path to an absolute one, refusing traversal. */
export async function resolveInVault(relPath: string, opts: ResolveOptions = {}): Promise<string> {
  const root = await getVaultRoot();
  const clean = relPath.replace(/^[/\\]+/, '');
  const abs = path.resolve(root, clean);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    throw Object.assign(new Error('Path escapes vault'), { status: 400 });
  }
  const scope = opts.trash;
  const segments = path.relative(root, abs).split(path.sep).filter(Boolean);
  assertSegmentsAllowed(segments, scope !== undefined);
  if (scope?.phase === 'root') assertDotOnlyAtHead(segments);
  // Second pass against reality: containment plus the same segment rules, run
  // on the canonical path rather than the requested one. See the function.
  await assertRealpathInVault(abs, root, scope, segments);
  return abs;
}

/**
 * Resolve a path that is about to be created, overwritten, moved or deleted, and
 * refuse the vault root itself.
 *
 * `resolveInVault('')`, `'.'`, `'/'` and `'./'` all legitimately resolve to the
 * root, which is harmless for a read but catastrophic for a mutation: `remove()`
 * would `rm -rf` the entire vault, `rename()` would move it aside, and
 * `writeFileText()` would drop its temp file *beside* the vault directory (i.e.
 * next to `data/settings.json`) because `${root}.tmp-...` is a sibling of the
 * root, not a child of it. Those paths are reachable from the API surface, for
 * example `DELETE /api/files?path=.` or a `PUT /api/v1/notes/` with a trailing
 * slash, so the guard belongs here rather than in each route.
 */
async function resolveForMutation(rel: string, opts: ResolveOptions = {}): Promise<string> {
  const root = await getVaultRoot();
  const abs = await resolveInVault(rel, opts);
  if (abs === root) {
    throw Object.assign(new Error('Path required'), { status: 400 });
  }
  return abs;
}

/**
 * Canonicalise a path through the operating system's own resolver rather than
 * through Node's JavaScript reimplementation of one. This comment covers the
 * pair below: `realpathNative` is the promise wrapper, `realpathCanonical` adds
 * the fallback.
 *
 * `fs.promises.realpath` only follows symbolic links, which on Windows leaves an
 * entire class of alias intact. Measured on this platform: `fs.realpath` on
 * `C:\PROGRA~1` returns `C:\PROGRA~1` unchanged, `fs.realpath.native` returns
 * `C:\Program Files`, and both names stat to the same inode and device. That
 * difference is the whole ballgame for the guards below, because `.obsidian`
 * aliases to the 8.3 short name `OBSIDI~1`, which carries no leading dot, and
 * needs no attacker-created link at all: it exists by default on any volume
 * where `NtfsDisable8dot3NameCreation` leaves short-name generation on. The
 * native resolver (libuv's `GetFinalPathNameByHandle` on Windows, `realpath(3)`
 * elsewhere) reports the name the filesystem actually holds, so short names,
 * junctions, symlinks and casing all collapse in one step.
 *
 * The narrow fallback covers exactly one documented gap: `realpath(3)` under
 * musl libc requires `/proc` to be mounted (noted in Node's own docs for
 * `fs.realpath.native`), which an unusually locked-down Alpine container may not
 * provide. Only "this resolver is not usable here" codes fall through; a
 * resolver that works and says ENOENT or EACCES is never second-guessed, because
 * degrading on those would quietly turn the guard off exactly when it matters.
 *
 * The fallback is gated to non-Windows for a reason that is easy to miss: that
 * documented gap is a POSIX one, so on Windows the fallback has no
 * justification, while the difference between the two resolvers is at its
 * largest there. libuv's `fs__realpath_handle` can fail when
 * `GetFinalPathNameByHandle(VOLUME_NAME_DOS)` returns a form it cannot rewrite
 * (a volume with no DOS mount point, for example), and falling back to the JS
 * resolver in that case would silently drop the 8.3 short-name leg of the guard
 * on exactly the deployments where nobody would notice. Failing closed there is
 * a visible fault the operator can act on; failing open is one they cannot see.
 */
function realpathNative(p: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    realpathCallback.native(p, (err, resolved) => (err ? reject(err) : resolve(resolved)));
  });
}

async function realpathCanonical(p: string): Promise<string> {
  try {
    return await realpathNative(p);
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (process.platform !== 'win32' && (code === 'ENOSYS' || code === 'ENOTSUP' || code === 'EINVAL')) {
      return fs.realpath(p);
    }
    throw e;
  }
}

/**
 * One-slot memo for the canonical form of the vault root, and the answer to the
 * one thing the canonical pass measurably made worse.
 *
 * `resolveInVault` is on the hot path of every read, write, tree fetch and share
 * fetch, and it was paying for TWO canonicalisations: the root, then the target.
 * Measured on this Windows host over 5000 iterations, `realpath.native` costs
 * 0.14-0.16 ms/op, against 0.17 ms/op for the `fs.readFile` it is guarding, so
 * the pair cost 0.30 ms of guard for a 0.17 ms operation. That lands hardest on
 * the two full-vault loops awaited at boot (`buildLinkGraph` and the search
 * index build, both one `readFileText` per note), where on the 27k-note vault
 * the PRD targets it is tens of seconds of pure guard. Memoising the root takes
 * the pair back to 0.15 ms/op, i.e. it removes essentially all of the added
 * cost, because the second call is the one that actually inspects the target.
 *
 * Caching this is safe in the only direction that matters, and it is worth
 * being precise about why rather than asserting it. A stale entry can only ever
 * cause a FALSE DENIAL, never a false allow: the canonical root is used solely
 * as the prefix that `real` is tested against, so if the lexical root starts
 * resolving somewhere else (a remounted bind mount, a repointed junction), the
 * freshly canonicalised target no longer sits under the remembered prefix and
 * every path is refused with "Path escapes vault". There is no arrangement in
 * which a remembered prefix admits a path that a fresh one would refuse, because
 * the remembered value is itself an exact prior canonicalisation of the same
 * lexical string.
 *
 * Two deliberate details. The entry is keyed on the lexical root, so a settings
 * change to `vault.path` misses rather than reusing the old answer (settings are
 * hot-reloadable, and this module re-reads them on every call). And FAILURES ARE
 * NEVER CACHED: the ENOENT branch in `assertRealpathInVault` returns early and
 * therefore skips the guard entirely, so remembering "the root does not exist"
 * would be the one form of staleness that fails open.
 *
 * The TTL exists only so that a genuinely relocated root heals without a
 * restart, since staleness costs availability rather than safety. Thirty seconds
 * comfortably covers a whole-vault boot loop with one syscall.
 */
const CANONICAL_ROOT_TTL_MS = 30_000;
let canonicalRootMemo: { lexical: string; canonical: string; at: number } | null = null;

async function canonicalVaultRoot(root: string): Promise<string> {
  const hit = canonicalRootMemo;
  const now = Date.now();
  if (hit && hit.lexical === root && now - hit.at < CANONICAL_ROOT_TTL_MS) return hit.canonical;
  const canonical = await realpathCanonical(root);
  canonicalRootMemo = { lexical: root, canonical, at: now };
  return canonical;
}

/**
 * Second pass of the path rules, run against what the filesystem says the path
 * actually is instead of against what the client asked for.
 *
 * The lexical pass in `resolveInVault` tests a string. A string is not the same
 * thing as the file it names: any alias inside the vault that spells a dot
 * directory without a dot satisfies every character-level rule we can write.
 * Both known aliases were reproduced on this host before this was written.
 *
 *  1. A junction or symlink. `mklink /J pub .obsidian` needs no administrator
 *     (`ln -s .obsidian pub` is the POSIX form). After it,
 *     `PUT /api/files/content {"path":"pub/plugins/evil/main.js"}` passed every
 *     check and landed in `.obsidian/plugins/evil/main.js`, which
 *     `services/plugins.ts` then serves to the SPA to execute. That is remote
 *     code execution in every browser that opens the vault, i.e. precisely the
 *     thing `ResolveOptions.trash` is documented as NOT being a door to. The
 *     `.git` spelling (`pub -> .git`, then `pub/hooks/post-merge`) is the same
 *     defect against the same guard.
 *  2. An 8.3 short name, needing no attacker-created link at all. See
 *     `realpathCanonical` for why the resolver choice decides this one.
 *
 * Canonicalising first and re-testing the result closes both with one rule,
 * because both aliases are gone from the canonical form. The containment test
 * stays here too: a symlink pointing OUT of the vault is the case the lexical
 * prefix comparison in `resolveInVault` structurally cannot see.
 *
 * Two residuals, both stated rather than papered over.
 *
 * HARD LINKS. A hard link is not an alias in the path sense (both names are
 * equally real, and no resolver will collapse one onto the other), so a hard
 * link created inside the vault pointing at a file inside `.obsidian` is not
 * caught here. Closing that needs an inode-identity check against every
 * protected directory on every resolution, which is a per-request directory walk
 * for a threat that already requires local filesystem write access.
 *
 * TOCTOU. What this function validates is a path, and what the caller then does
 * is open that same path a moment later, so a reparse point swapped in between
 * the two is followed by the syscall and not seen by the check. That window
 * cannot be closed portably in Node: doing so needs the operation to be
 * performed on the very object that was validated (an `openat`-style chain
 * against directory handles, or `O_NOFOLLOW` on the final component), and Node
 * exposes neither on every platform this ships to. The partial mitigations that
 * are expressible (re-canonicalise after opening and compare inode identity)
 * cost more syscalls on the hot path than they buy, which matters here because
 * the same pass had to remove a measured 1.7x regression from exactly this hot
 * path.
 *
 * What bounds it is the precondition, and it is worth being explicit because
 * "TOCTOU" on its own sounds worse than this is. Winning the race requires the
 * ability to create a symlink or junction inside the vault at a time of the
 * attacker's choosing. Nothing in the HTTP surface creates one: there is no
 * symlink API, and `resolveInVault` refuses to resolve through an existing one
 * that leaves the vault or lands in a protected directory. So the attacker needs
 * local filesystem write access to the vault, and an attacker with that can
 * write `.obsidian/plugins/<id>/main.js` directly and skip the race entirely.
 * The window therefore grants nothing the precondition does not already grant.
 * The one deployment where that argument weakens is a shared host on which a
 * second local account can write into the vault directory but not into
 * `.obsidian`; the honest answer there is filesystem permissions, not a check in
 * this function. Note also that a LiveSync backend writing concurrently into the
 * same vault is NOT an instance of this: it writes files, it does not create
 * reparse points, and it runs as the same user in the same process.
 */
async function assertRealpathInVault(
  abs: string,
  root: string,
  scope: TrashScope | undefined,
  requestedSegments: string[],
): Promise<void> {
  const allowDotDirs = scope !== undefined;
  let realRoot: string;
  try {
    realRoot = await canonicalVaultRoot(root);
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // The vault root does not exist: first boot before `ensureVault()`, or a
      // network mount that dropped mid-session. Nothing can exist UNDER a
      // directory that does not exist, so there is no alias between the root and
      // `abs` for the walk below to see through, and nothing to verify.
      //
      // Returning here rather than falling back to the lexical root is the
      // point. The previous code fell back, so the walk climbed PAST the vault
      // and canonicalised the vault's own parents; a parent that is itself a
      // symlink or bind mount then resolved somewhere that does not start with
      // the lexical root and every path operation failed with a bogus "Path
      // escapes vault". Concretely that turned `listTrash()`/`emptyTrash()` from
      // "degrade to an empty list" into a hard 400 whenever the vault directory
      // was missing, which is a visible error in the Trash modal for a condition
      // the UI used to ride out.
      return;
    }
    // Any other failure (EACCES on the root, an I/O error) is a real fault, not
    // an absent vault. Propagate it instead of silently switching the guard off:
    // a resolver we cannot trust must not be read as "the path is fine".
    throw e;
  }
  const realRootSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  let probe = abs;
  for (;;) {
    let real: string;
    try {
      real = await realpathCanonical(probe);
    } catch {
      const parent = path.dirname(probe);
      // Stop at the vault root. It canonicalised successfully above, so there is
      // no unexamined alias left between here and there, and climbing higher
      // would start resolving paths outside the sandbox this function polices.
      if (parent === probe || probe === root) return;
      probe = parent;
      continue;
    }
    if (real !== realRoot && !real.startsWith(realRootSep)) {
      throw Object.assign(new Error('Path escapes vault'), { status: 400 });
    }
    // Re-run the segment rules on the canonical name of the deepest EXISTING
    // ancestor, plus the still-lexical tail hanging below it. The tail needs no
    // alias treatment by definition: those components do not exist yet, so
    // nothing on disk can be aliasing them, and they were already tested
    // verbatim by the caller. Including them anyway keeps this function's answer
    // true on its own terms rather than only in combination with its caller.
    const realSegs = path.relative(realRoot, real).split(path.sep).filter(Boolean);
    const tailSegs = path.relative(probe, abs).split(path.sep).filter(Boolean);
    const canonicalSegments = [...realSegs, ...tailSegs];
    assertSegmentsAllowed(canonicalSegments, allowDotDirs);
    if (scope !== undefined) {
      // The trash exception relaxes the dot rule for the path the CALLER NAMED,
      // not for wherever an alias happens to lead. Without this, the trash
      // subsystem (the only opt-in caller) reopened the hole the canonical pass
      // just closed: a junction `pub -> .obsidian` made
      // `resolveInVault('pub/x', {trash})` succeed, because the canonical
      // `.obsidian` segment is a dot segment and dot segments were
      // blanket-permitted. `.obsidian` and `.git` are now refused outright by
      // `PROTECTED_DIRS` regardless, but the rule stays because it is the
      // general form: it also catches `pub -> .private-notes`, where the request
      // named no dot segment at all and the canonical path contains one.
      //
      // The rule: every dot segment in the canonical path has to be one the
      // request already spelled out. `.trash/folder/gone.md` asked for `.trash`
      // and canonically is `.trash`, so it passes; `pub/x` asked for no dot
      // segment and canonically contains one, so it does not. The comparison is
      // case-folded because the native resolver returns the on-disk casing,
      // which a hand-written `vault.trash` of `.Trash` would not match.
      const named = new Set(requestedSegments.filter((s) => s.startsWith('.')).map((s) => s.toLowerCase()));
      for (const seg of canonicalSegments) {
        if (seg.startsWith('.') && !named.has(seg.toLowerCase())) {
          throw Object.assign(new Error('Path not allowed'), { status: 400 });
        }
      }
      // The positional rule, applied to reality as well as to the request. See
      // `assertDotOnlyAtHead`: a trash root gets the dot exception for its head
      // segment only, and a junction is not allowed to smuggle a nested dot
      // directory into that position.
      if (scope.phase === 'root') assertDotOnlyAtHead(canonicalSegments);
      // And the containment half: an item addressed as being IN the trash has to
      // canonically be in the trash. The call sites all run `assertInTrash`
      // afterwards, but that compares lexical strings, so it cannot see a
      // junction planted inside the trash folder pointing elsewhere in the
      // vault, and `deleteFromTrash` ends in `fs.rm(recursive, force)`.
      if (scope.phase === 'inside') await assertRealInTrashRoot(real, scope.trashRoot);
    }
    return; // deepest existing ancestor is inside the vault; the rest is new
  }
}

/**
 * Confirm a canonical path is the canonical trash root or lives under it.
 *
 * `real` here is the deepest EXISTING ancestor of the requested path, so
 * equality with the trash root is a legitimate result: it is what
 * `deleteFromTrash('.trash/already-gone.md')` produces. Anything below it is the
 * ordinary case.
 *
 * A trash root that does not exist yet is not a failure. Nothing can exist under
 * a directory that does not exist, so there is no aliased item to catch, and
 * refusing here would break `listTrash()`/`emptyTrash()` on a vault that has
 * never had anything deleted. Any other resolver error propagates, on the same
 * reasoning as the root canonicalisation above: a resolver we cannot trust must
 * not be read as "the path is fine".
 */
async function assertRealInTrashRoot(real: string, trashRoot: string): Promise<void> {
  let canonicalTrash: string;
  try {
    canonicalTrash = await realpathCanonical(trashRoot);
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    throw e;
  }
  const withSep = canonicalTrash.endsWith(path.sep) ? canonicalTrash : canonicalTrash + path.sep;
  if (real !== canonicalTrash && !real.startsWith(withSep)) {
    throw Object.assign(new Error('Not a trash item'), { status: 400 });
  }
}

export function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

export async function ensureVault(): Promise<void> {
  const root = await getVaultRoot();
  await fs.mkdir(root, { recursive: true });
}

/** Build the full tree (folders + files), skipping ignored dirs. */
export async function listTree(): Promise<TreeNode> {
  const root = await getVaultRoot();
  await fs.mkdir(root, { recursive: true });

  async function walk(absDir: string): Promise<TreeNode[]> {
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    // Stat files concurrently per directory (cached) so the one-time fill is fast;
    // steady state reads from statCache → no syscalls. mtime/ctime power sort-by-time.
    const nodes = await Promise.all(
      entries
        .filter((e) => !(IGNORED.has(e.name) || e.name.startsWith('.'))) // hide dotfiles like Obsidian
        .map(async (e): Promise<TreeNode | null> => {
          const abs = path.join(absDir, e.name);
          const rel = toRel(root, abs);
          if (e.isDirectory()) {
            return { name: e.name, path: rel, type: 'folder', children: await walk(abs) };
          }
          if (e.isFile()) {
            const { m, c } = await fileStat(abs, rel);
            return { name: e.name, path: rel, type: 'file', ext: path.extname(e.name).toLowerCase(), mtime: m, ctime: c };
          }
          return null;
        }),
    );
    const out = nodes.filter((n): n is TreeNode => n !== null);
    // folders first, then alphabetical (client re-sorts by the chosen order)
    out.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  return { name: path.basename(root), path: '', type: 'folder', children: await walk(root) };
}

export function isTextFile(rel: string): boolean {
  return TEXT_EXTS.has(path.extname(rel).toLowerCase());
}

export async function readFileText(rel: string): Promise<string> {
  const abs = await resolveInVault(rel);
  return fs.readFile(abs, 'utf8');
}

export async function readFileBuffer(rel: string): Promise<Buffer> {
  const abs = await resolveInVault(rel);
  return fs.readFile(abs);
}

export async function writeFileText(rel: string, content: string): Promise<void> {
  // resolveForMutation, not resolveInVault: if `rel` resolved to the vault root
  // the temp file below would be created as a SIBLING of the vault directory,
  // i.e. one level outside the sandbox and next to `data/settings.json`. The
  // rename onto the root then fails, so the stray file was never cleaned up and
  // repeated calls simply piled up attacker-named files outside the vault.
  const abs = await resolveForMutation(rel);
  const dir = path.dirname(abs);
  await fs.mkdir(dir, { recursive: true });
  // Keep the temp file in the target's OWN directory so the write-then-rename
  // stays atomic (rename is only atomic within a filesystem) and can never land
  // outside the vault. The random suffix matters as much as the timestamp: two
  // saves of the same note inside the same millisecond would otherwise pick the
  // same temp name and interleave their bytes into one corrupt file.
  const tmp = path.join(dir, `.${path.basename(abs)}.tmp-${Date.now()}-${randomBytes(6).toString('hex')}`);
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, abs);
  } finally {
    // On success the rename consumed `tmp` and this is a no-op; on failure (disk
    // full, EACCES, EISDIR because `rel` names an existing folder) it stops a
    // half-written file from being left behind inside the vault, where the
    // watcher and the search index would both pick it up.
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

export interface WriteBufferOptions {
  /**
   * Replace an existing file. Defaults to false, and the caller has to ask.
   *
   * Uploads are the only consumer, and their filename is client-supplied: with
   * an implicit overwrite, a POST naming an existing attachment destroyed it
   * with no error, no prompt and no trash copy. The `wx` flag makes the refusal
   * atomic rather than a check-then-write race.
   */
  overwrite?: boolean;
}

export async function writeFileBuffer(rel: string, buf: Buffer, opts: WriteBufferOptions = {}): Promise<void> {
  const abs = await resolveForMutation(rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  try {
    await fs.writeFile(abs, buf, { flag: opts.overwrite ? 'w' : 'wx' });
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (!opts.overwrite && code === 'EEXIST') {
      throw Object.assign(new Error('File already exists'), { status: 409 });
    }
    // A folder already occupies the name. This is a client mistake, not a server
    // fault, so it should not surface as the 500 that an unclassified errno
    // produces (`POST /api/files/upload` with `overwrite=true` onto a directory
    // did exactly that). Only EISDIR is translated, deliberately: Windows tends
    // to report EPERM here instead, and mapping EPERM would turn a genuine
    // permissions failure into a misleading "a folder is in the way".
    if (code === 'EISDIR') {
      throw Object.assign(new Error('A folder already exists at that path'), { status: 409 });
    }
    throw e;
  }
}

export async function createFolder(rel: string): Promise<void> {
  const abs = await resolveForMutation(rel);
  await fs.mkdir(abs, { recursive: true });
}

/**
 * Resolve a directory path against the folders that already exist, matching each
 * segment case-insensitively. Prevents creating a case-duplicate folder (e.g. a
 * new `attachments` next to an existing `Attachments`) on case-sensitive
 * filesystems. Segments with no existing match are kept verbatim.
 */
export async function resolveDirCaseInsensitive(rel: string): Promise<string> {
  const root = await getVaultRoot();
  // Split on BOTH separators and validate every segment BEFORE touching the disk.
  // Two reasons. (1) The old `rel.split('/')` left a Windows-style `a\..\..\etc`
  // as a single "segment" that `path.join` then happily normalised out of the
  // vault. (2) Even with the caller's later `resolveInVault` recheck catching the
  // final path, the loop below issued real `fs.readdir` probes against every
  // attacker-supplied ancestor on the way there, which is a filesystem oracle
  // (existence and directory listings) outside the vault. Reject first, probe
  // second.
  const segs = rel.split(/[/\\]+/).filter(Boolean);
  // One shared rule set with `resolveInVault` (`.`/`..`/dot-leading,
  // PROTECTED_DIRS, NUL, and the Windows stream colon) rather than a second
  // hand-written copy,
  // so the two entry points into the vault cannot drift apart as rules are
  // added. `.` and `..` are covered by the dot-leading rule.
  assertSegmentsAllowed(segs, false);
  const out: string[] = [];
  let curAbs = root;
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  for (const seg of segs) {
    let actual = seg;
    try {
      const entries = await fs.readdir(curAbs, { withFileTypes: true });
      const exact = entries.find((e) => e.isDirectory() && e.name === seg);
      const ci = exact ?? entries.find((e) => e.isDirectory() && e.name.toLowerCase() === seg.toLowerCase());
      if (ci) actual = ci.name;
    } catch {
      /* directory doesn't exist yet: keep the requested casing */
    }
    out.push(actual);
    curAbs = path.join(curAbs, actual);
    // Belt and braces: the segment filter above should make this unreachable, but
    // the next loop iteration is about to readdir() `curAbs`, so confirm it is
    // still inside the vault before that happens.
    if (!curAbs.startsWith(rootWithSep)) {
      throw Object.assign(new Error('Path escapes vault'), { status: 400 });
    }
  }
  return out.join('/');
}

export async function exists(rel: string): Promise<boolean> {
  try {
    await fs.access(await resolveInVault(rel));
    return true;
  } catch {
    return false;
  }
}

/**
 * Move `absFrom` onto `absTo` without ever replacing something already there.
 * Returns false when the destination was taken, true when the move happened.
 *
 * `fs.rename` silently replaces its destination on every platform this ships to
 * (libuv uses `MOVEFILE_REPLACE_EXISTING` on Windows and plain `rename(2)`
 * elsewhere), so "check that it does not exist, then rename" is a race: a file
 * created in that window is destroyed with `ok: true` and no trash copy. That is
 * the exact outcome the refusal exists to prevent, which makes a check-then-act
 * implementation of it self-defeating, and it sat two functions away from
 * `writeFileBuffer`'s `wx` flag, which was given the atomic treatment.
 *
 * Node exposes no portable atomic no-replace rename (`renameat2` with
 * `RENAME_NOREPLACE` is Linux-only and unexposed; `MoveFileEx` without the
 * replace flag is not reachable either), so the atomicity is borrowed from
 * `link`, which is required to fail with EEXIST when the destination exists and
 * does so as a single filesystem operation. Link the new name, then drop the
 * old: for a regular file the observable result is identical to a rename, since
 * both names refer to the same inode throughout and only one survives.
 *
 * Deliberate details:
 *
 *  - EEXIST is the ONLY code treated as "taken". Everything else falls through
 *    to the old check-then-rename, because `link` legitimately fails for reasons
 *    that say nothing about the destination: EPERM/EISDIR/ENOTSUP for a
 *    directory source (hard links to directories do not exist), EXDEV for a
 *    sub-mount inside the vault, EPERM on FAT/exFAT and on some SMB and FUSE
 *    mounts, and EPERM again under Linux's `fs.protected_hardlinks`. Refusing
 *    those would break renaming outright for those users, so the fallback keeps
 *    the previous behaviour rather than trading a race for an outage. Directory
 *    renames always take that path, and are partly covered by the OS anyway:
 *    `rename` refuses to replace a non-empty directory on POSIX, and any
 *    existing destination on Windows.
 *  - ENOENT is not special-cased either, so a dangling symlink source (where
 *    BSD/macOS `link` follows the link and fails, while `rename` would have
 *    worked) still renames.
 *  - If the link lands but the unlink fails, the link is removed again. Leaving
 *    it would silently turn one note into two names for one file, which is worse
 *    than the failure being reported.
 *  - Both names exist for the duration of the unlink. A concurrent `listTree`
 *    can see both, and the watcher sees an add plus a delete, which is what it
 *    already saw for a rename.
 */
async function renameNoClobber(absFrom: string, absTo: string): Promise<boolean> {
  try {
    await fs.link(absFrom, absTo);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
    if (await pathExists(absTo)) return false;
    await fs.rename(absFrom, absTo);
    return true;
  }
  try {
    await fs.unlink(absFrom);
  } catch (e: unknown) {
    await fs.unlink(absTo).catch(() => {});
    throw e;
  }
  return true;
}

export async function rename(from: string, to: string): Promise<void> {
  const absFrom = await resolveForMutation(from);
  const absTo = await resolveForMutation(to);
  await fs.mkdir(path.dirname(absTo), { recursive: true });
  // The one case that must get through a no-clobber move is a case-only rename
  // (`note.md` -> `Note.md`) on a case-insensitive filesystem, where the
  // "existing destination" is the source file itself. That is decided by file
  // identity, not by string comparison: on a case-SENSITIVE filesystem those two
  // names are different files and renaming one onto the other is exactly the
  // clobber being blocked. It has to be handled before `renameNoClobber`,
  // because `link` cannot express it: on NTFS and on a case-insensitive APFS
  // volume, linking `note.md` to `Note.md` reports EEXIST even though the two
  // names are the same file, so a legitimate case change would come back as 409.
  //
  // `isSameFile` answers false when the destination does not exist (its lstat
  // throws and it fails closed), so this is not an extra existence check.
  if (await isSameFile(absFrom, absTo)) {
    await fs.rename(absFrom, absTo);
    return;
  }
  // Refusing rather than overwriting matches `copy()`'s `errorOnExist: true`.
  // Renaming note A onto an existing note B used to replace B's content with
  // A's, report `ok: true`, and leave the caller no way to detect that a file
  // had been destroyed: no error, no trash copy, and a rename is not a save so
  // there is no version history either.
  if (!(await renameNoClobber(absFrom, absTo))) {
    throw Object.assign(new Error('Destination already exists'), { status: 409 });
  }
}

/**
 * Recursively copy a file or folder to a new location. Returns the vault-relative
 * paths of every file created (so callers can reindex them). Throws if `to` exists.
 */
export async function copy(from: string, to: string): Promise<string[]> {
  const absFrom = await resolveForMutation(from);
  const absTo = await resolveForMutation(to);
  await fs.mkdir(path.dirname(absTo), { recursive: true });
  await fs.cp(absFrom, absTo, { recursive: true, errorOnExist: true, force: false });
  const root = await getVaultRoot();
  const out: string[] = [];
  const st = await fs.stat(absTo);
  if (st.isDirectory()) {
    async function walk(dir: string) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (IGNORED.has(e.name)) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) await walk(abs);
        else if (e.isFile()) out.push(toRel(root, abs));
      }
    }
    await walk(absTo);
  } else {
    out.push(toRel(root, absTo));
  }
  return out;
}

/** Permanently delete a file or folder (no trash). */
export async function remove(rel: string): Promise<void> {
  // resolveForMutation: `DELETE /api/files?path=.` resolves to the vault root,
  // and `fs.rm(root, { recursive: true, force: true })` would delete the entire
  // vault without so much as an error.
  const abs = await resolveForMutation(rel);
  await fs.rm(abs, { recursive: true, force: true });
}

/** Move a path into the vault trash folder, preserving relative layout. */
export async function trash(rel: string): Promise<string> {
  const root = await getVaultRoot();
  const absFrom = await resolveForMutation(rel);
  // Go through getTrashRoot() rather than re-joining `settings.vault.trash` onto
  // the root by hand: that inline join was the second copy of the same unchecked
  // computation, so a traversing trash setting turned every delete into a write
  // outside the vault.
  const trashRoot = await getTrashRoot();
  // Build the destination from the ALREADY-RESOLVED source path, not from the
  // caller's raw string. `path.join(trashRoot, rel)` re-introduced the caller's
  // unnormalised text (`..` segments, a leading slash, backslashes on Windows)
  // one step after it had been validated; `toRel` gives the normalised, verified
  // vault-relative form instead.
  const dest = path.join(trashRoot, toRel(root, absFrom));
  // Assert containment BEFORE creating anything: the mkdir below is itself a
  // write, so it has to be provably inside the trash root first.
  assertInTrash(dest, trashRoot);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  // Collision handling, atomically. The previous shape was "if it exists, add a
  // `Date.now()` suffix, then rename", which had both defects the `wx` in
  // `writeFileBuffer` was introduced to avoid: the existence test is a race
  // against `fs.rename`'s silent replacement, and a bare millisecond timestamp
  // is not unique, so two deletes of the same path inside one millisecond
  // picked the same destination and the second destroyed the first. The
  // uniquifier now carries randomness for the same reason `writeFileText`'s
  // temp name does, and the decision about whether the name is free is made by
  // the filesystem rather than by us.
  const ext = path.extname(dest);
  const stem = dest.slice(0, dest.length - ext.length);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate =
      attempt === 0 ? dest : `${stem}.${Date.now()}-${randomBytes(4).toString('hex')}${ext}`;
    // Re-assert on every generated name, so the collision branch cannot widen
    // what the check above just established.
    assertInTrash(candidate, trashRoot);
    if (await renameNoClobber(absFrom, candidate)) return toRel(root, candidate);
  }
  // Eight collisions on a name carrying 32 bits of randomness means something
  // other than bad luck (a destination directory that cannot be written into,
  // for example), so report it rather than looping.
  throw Object.assign(new Error('Could not move that item to the trash'), { status: 409 });
}

async function pathExists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when two absolute paths name the same file on disk. Used to tell a
 * case-only rename apart from a rename that would destroy a different file:
 * inode + device identity answers that correctly on every filesystem, whereas
 * comparing the strings gets it wrong in one direction or the other depending
 * on how the filesystem treats case.
 */
async function isSameFile(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  try {
    const [sa, sb] = await Promise.all([fs.lstat(a), fs.lstat(b)]);
    if (sa.ino !== 0 && sa.ino === sb.ino && sa.dev === sb.dev) return true;
  } catch {
    /* one side vanished mid-check: fall through and treat them as different,
       which is the safe direction (the caller refuses the rename). */
  }
  return false;
}

/** ---- Trash (FR-1) -------------------------------------------------------- */

export interface TrashItem {
  name: string; // basename
  path: string; // vault-relative, including the trash prefix, e.g. ".trash/folder/note.md"
  original: string; // where it restores to, e.g. "folder/note.md"
  ext: string;
  size: number;
  mtime: number; // deletion time (file mtime when it landed in trash)
}

/**
 * Absolute path of the trash folder, resolved through the SAME containment
 * logic as every other path in this module.
 *
 * The previous `path.join(root, s.vault.trash)` trusted the setting completely.
 * `vault.trash` is a stored string, so it is only ever as trustworthy as the
 * weakest way it can be set: a hand-edited `data/settings.json`, a file written
 * by an older build that had no validation, a restored backup, or the next bug
 * in the settings route. And the blast radius is not "a misplaced folder":
 * `listTrash()` walks this path and returns what it finds, while `emptyTrash()`
 * and `deleteFromTrash()` call `fs.rm(recursive, force)` on it. A traversing
 * value therefore reads as arbitrary directory listing and recursive deletion
 * anywhere the server process can reach.
 *
 * Validating the setting where it enters the system is right and is done
 * separately; re-deriving it safely at the point of use is what makes the
 * containment hold no matter how the value got in. This is checked on every
 * trash operation rather than cached, because settings are hot-reloadable.
 */
async function getTrashRoot(): Promise<string> {
  const s = await getSettings();
  const root = await getVaultRoot();
  // `phase: 'root'` is the blessed dot exception, and it is narrow on purpose:
  // the default `.trash` is itself a dot directory and this is the one subsystem
  // that legitimately owns one, but the exception now permits a dot only on the
  // head segment and never permits `PROTECTED_DIRS` at all. That is what stops
  // `vault.trash = ".obsidian"` (which the settings route accepts, since
  // `isVaultRelativeSubpath` has no opinion about leading dots) from turning
  // every delete into a write into the plugin directory. See `TrashScope`.
  // Everything else about the resolution (traversal, symlink escape, canonical
  // re-check) still applies unchanged.
  const abs = await resolveInVault(s.vault.trash, { trash: { phase: 'root' } });
  if (abs === root) {
    // A trash root equal to the vault root would make `emptyTrash()` delete the
    // whole vault, and `assertInTrash` would start accepting every note in it.
    throw Object.assign(new Error('Invalid trash folder'), { status: 500 });
  }
  return abs;
}

/** Confirm `abs` lives inside the trash folder; return its trash-relative path. */
function assertInTrash(abs: string, trashRoot: string): string {
  const rel = path.relative(trashRoot, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw Object.assign(new Error('Not a trash item'), { status: 400 });
  }
  return rel;
}

/** Remove now-empty directories upward from `dir`, stopping at (and keeping) `stopAt`. */
async function pruneEmptyDirs(dir: string, stopAt: string): Promise<void> {
  let cur = path.resolve(dir);
  const root = path.resolve(stopAt);
  while (cur !== root && cur.startsWith(root + path.sep)) {
    try {
      const remaining = await fs.readdir(cur);
      if (remaining.length > 0) break;
      await fs.rmdir(cur);
    } catch {
      break;
    }
    cur = path.dirname(cur);
  }
}

/** List every file currently in the trash, newest deletion first. */
export async function listTrash(): Promise<TrashItem[]> {
  const root = await getVaultRoot();
  const trashRoot = await getTrashRoot();
  const out: TrashItem[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // trash folder doesn't exist yet
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile()) {
        const st = await fs.stat(abs).catch(() => null);
        out.push({
          name: e.name,
          path: toRel(root, abs),
          original: path.relative(trashRoot, abs).split(path.sep).join('/'),
          ext: path.extname(e.name).toLowerCase(),
          size: st?.size ?? 0,
          mtime: st ? st.mtimeMs : 0,
        });
      }
    }
  }
  await walk(trashRoot);
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** Move a trashed item back to its original location. Returns the restored rel path. */
export async function restoreFromTrash(trashRel: string): Promise<string> {
  const trashRoot = await getTrashRoot();
  // The trash exception on the SOURCE only, and scoped to this trash root:
  // `trashRel` is by definition `<trashRoot>/...`, so `phase: 'inside'` makes
  // `resolveInVault` itself prove that the CANONICAL source is inside the
  // CANONICAL trash root. `assertInTrash` still runs below as the lexical
  // second opinion. The destination is deliberately resolved strictly, so a
  // legacy trash entry recorded under a dot directory cannot be used to write
  // back into one.
  const absFrom = await resolveInVault(trashRel, { trash: { phase: 'inside', trashRoot } });
  const relInTrash = assertInTrash(absFrom, trashRoot);
  const baseRel = relInTrash.split(path.sep).join('/');
  // Don't clobber a file that was recreated at the same path after deletion, and
  // don't decide that with an existence check either: see `renameNoClobber`, and
  // see `trash()` for why the suffix carries randomness as well as a timestamp.
  const ext = path.posix.extname(baseRel);
  const stem = baseRel.slice(0, baseRel.length - ext.length);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const destRel =
      attempt === 0
        ? baseRel
        : `${stem}.restored-${Date.now()}-${randomBytes(4).toString('hex')}${ext}`;
    const absTo = await resolveForMutation(destRel);
    await fs.mkdir(path.dirname(absTo), { recursive: true });
    if (await renameNoClobber(absFrom, absTo)) {
      await pruneEmptyDirs(path.dirname(absFrom), trashRoot);
      return destRel;
    }
  }
  throw Object.assign(new Error('Could not restore that item'), { status: 409 });
}

/** Permanently delete a single trashed item. */
export async function deleteFromTrash(trashRel: string): Promise<void> {
  const trashRoot = await getTrashRoot();
  // Same reasoning as restoreFromTrash, and it matters most here because this
  // ends in `fs.rm(recursive, force)`: `phase: 'inside'` makes the resolution
  // itself prove the canonical target is inside the canonical trash root, which
  // is the check `assertInTrash` cannot make (it compares lexical strings, so a
  // junction planted inside the trash folder passed it).
  const abs = await resolveInVault(trashRel, { trash: { phase: 'inside', trashRoot } });
  assertInTrash(abs, trashRoot);
  await fs.rm(abs, { recursive: true, force: true });
  await pruneEmptyDirs(path.dirname(abs), trashRoot);
}

/** Permanently delete everything in the trash. */
export async function emptyTrash(): Promise<void> {
  const trashRoot = await getTrashRoot();
  let entries;
  try {
    entries = await fs.readdir(trashRoot);
  } catch {
    return; // nothing to empty
  }
  for (const name of entries) {
    await fs.rm(path.join(trashRoot, name), { recursive: true, force: true });
  }
}

/** List all markdown files (vault-relative) for indexing. */
export async function listMarkdownFiles(): Promise<string[]> {
  const root = await getVaultRoot();
  const out: string[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      // Skip dotfiles/dot-dirs (`.trash`, `.obsidian`, …) like the tree view and
      // file index do: a note moved to `.trash` must not stay a live link target
      // (and would otherwise shadow a real file with the same basename).
      if (IGNORED.has(e.name) || e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) out.push(toRel(root, abs));
    }
  }
  await walk(root);
  return out;
}
