import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import path from 'node:path';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import * as vault from '../services/vault.js';
import { getSettings } from '../services/settings.js';
import { qmd } from '../services/search.js';
import { updateLinkGraphForFile } from '../services/links.js';
import { scheduleAutoCommitOnSave } from '../services/git.js';
import { resolveFile } from '../services/fileindex.js';
import { onFileRenamed } from '../services/shares.js';
import { mimeFor } from '../services/mime.js';
import { sendFileWithRange } from '../services/httpfile.js';

export const filesRouter = Router();
filesRouter.use(requireAuth);

/**
 * Attachment upload. `memoryStorage` buffers the whole body in the process heap
 * before the handler ever runs, so every limit here is a memory limit, not a
 * politeness setting.
 *
 * `fileSize` alone was not enough: without `files`/`fields`/`parts` a single
 * multipart request could carry an unbounded number of parts, and multer would
 * accumulate every one of them (and every field name and value) in memory before
 * anything downstream got a chance to reject the request. One authenticated
 * client could push the server into an OOM kill with a request that never even
 * reaches a route handler. The caps below match what the UI actually sends: one
 * file, plus the `dir` and `overwrite` fields.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 512 * 1024 * 1024,
    files: 1, // one `file` part; extra file parts are rejected outright
    fields: 8, // `dir` + `overwrite` today, with room to grow
    parts: 12, // fields + files, belt and braces
    fieldNameSize: 100,
    fieldSize: 8 * 1024, // no file content smuggled in as a "field"
    headerPairs: 100,
  },
});

/**
 * Runs the single-file multer middleware and translates its limit violations
 * into status codes the client can act on. Without this they reach the generic
 * error middleware with no `status` and come back as 500, which reads as "the
 * server is broken" for what is really "your request was too big", and which
 * buries genuine 500s in the logs. The multer error `code` is a fixed enum
 * (`LIMIT_FILE_SIZE`, `LIMIT_PART_COUNT`, ...), never user input, so it is safe
 * to echo.
 */
function uploadSingleFile(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      res.status(status).json({ error: `Upload rejected: ${err.code}` });
      return;
    }
    next(err);
  });
}

/**
 * Characters Windows refuses in a filename. The colon is the security-relevant
 * one and the reason this set exists at all (see `safeUploadFilename`); the
 * others ride along so that an attachment minted on a Linux server still checks
 * out on a Windows or macOS client. `/` and `\` are absent on purpose: the split
 * in `safeUploadFilename` has already consumed them, and listing them here would
 * suggest this regex is what keeps the value to one component when it is not.
 */
const WINDOWS_ILLEGAL_CHARS = /[<>:"|?*]/g;

/**
 * Windows reserves these device names with or without an extension, so `CON`,
 * `con.md` and `COM1.png` are all reserved. The capture groups exist so the
 * suffix can be inserted after the reserved word rather than at the end of the
 * name: what Windows treats as the device is the part before the FIRST dot, so
 * `con.tar.gz` is reserved and `con.tar.gz-file` still is. `con-file.tar.gz` is
 * not, and it keeps the extension the file actually has, which `mimeFor` and
 * every client need in order to open it.
 */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * Characters that must not survive into a filename because of what they do to
 * whoever displays it, rather than because of what they do to the filesystem.
 *
 * C0/DEL: a NUL truncates the path inside native calls, and the rest make the
 * name unusable in a terminal or a shell.
 *
 * Bidirectional formatting (U+200E/200F, the U+202A-202E overrides, the
 * U+2066-2069 isolates): these reorder the glyphs that follow them without
 * changing any bytes, so a name ending in a right-to-left override and then
 * `gnp.js` is displayed as though it ended in `.png`: in the file tree, in the
 * share page, and in the operator's own file manager alike, while remaining a
 * `.js`. Nothing legitimate needs them in an attachment name, and stripping them
 * costs a user writing in a right-to-left script nothing, because that script's
 * own characters carry their direction inherently and are untouched here.
 *
 * Written with escapes rather than literal characters on purpose. These are
 * precisely the characters that make text lie about its own order, so a literal
 * one in this file would reorder the line it sits on.
 */
const UNSAFE_NAME_CHARS = /[\u0000-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * Byte budget for a minted attachment name.
 *
 * Almost every filesystem in use caps one path component at 255 BYTES, not
 * characters, so a 90-character name in a non-Latin script is already over it.
 * Exceeding it produces ENAMETOOLONG out of the write, which carries no `status`
 * and therefore surfaced as a 500: "the server is broken" for what is really "a
 * screenshot with a very long name". 200 leaves room for the `-<n>` uniquifier
 * that `writeUploadPreservingExisting` appends on a collision.
 */
const MAX_UPLOAD_NAME_BYTES = 200;

/** Cut a string to a UTF-8 byte budget without splitting a code point. */
function truncateUtf8(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, 'utf8');
  if (buf.length <= maxBytes) return value;
  // Decoding a buffer cut mid-sequence yields a trailing U+FFFD for the partial
  // code point; drop it rather than minting a name with a replacement character
  // in it.
  const cut = buf.subarray(0, maxBytes).toString('utf8');
  return cut.endsWith('\uFFFD') ? cut.slice(0, -1) : cut;
}

/**
 * Bring a name inside MAX_UPLOAD_NAME_BYTES, keeping the extension.
 *
 * The extension is what decides whether the file can be opened at all, so it
 * survives and the stem gives way. A pathologically long "extension" (a name
 * with one dot near the front and 250 characters after it) is not worth
 * preserving and is treated as part of the stem instead.
 */
function clampNameLength(name: string): string {
  if (Buffer.byteLength(name, 'utf8') <= MAX_UPLOAD_NAME_BYTES) return name;
  const ext = path.posix.extname(name);
  const keepExt = ext.length > 1 && Buffer.byteLength(ext, 'utf8') <= 24 ? ext : '';
  const stem = name.slice(0, name.length - keepExt.length);
  const budget = MAX_UPLOAD_NAME_BYTES - Buffer.byteLength(keepExt, 'utf8');
  // Re-strip trailing dots and spaces: the cut can expose new ones, and they
  // are the same portability problem the caller already removed once.
  return truncateUtf8(stem, budget).replace(/[. ]+$/, '') + keepExt;
}

/**
 * Reduce a client-supplied `originalname` to a single safe path component.
 *
 * multer passes `originalname` through verbatim: it is whatever string was in
 * the multipart headers, not a validated filename. It was then joined straight
 * onto the target directory, so `../../.obsidian/plugins/x/main.js` (or its
 * backslash form, which `path.posix` treats as an ordinary character while
 * Windows treats it as a separator) walked out of the attachments folder.
 *
 * `path.basename` on its own is not sufficient, because on POSIX it does not
 * treat a backslash as a separator: split on both and keep the last component.
 * A leading dot is refused for the same reason `resolveInVault` refuses one, and
 * so an upload cannot create a file the tree view will never show again.
 *
 * Splitting and refusing a leading dot is necessary but was not sufficient,
 * because it left the colon, and on Windows a colon does not name a file. An
 * upload called `note.md:hidden.js` into `attachments/` writes an NTFS alternate
 * data stream hanging off the existing `attachments/note.md`. Measured: the host
 * note's own content is untouched, `readdir` does not list the stream (so
 * neither the tree, nor the search index, nor git ever sees it), and the stream
 * reads back in full afterwards. The `wx` flag does not catch it, because the
 * stream really did not exist, so `writeUploadPreservingExisting` believes it
 * created a fresh file. `resolveInVault` now rejects the same spelling as a
 * second line of defence; it is stopped here as well so the caller gets a 400
 * that names the actual problem instead of a generic path refusal.
 *
 * Uploads sanitise where `resolveInVault` rejects, and the asymmetry is
 * deliberate. `resolveInVault` addresses files that already exist, so silently
 * rewriting a name there would hand the caller a different file than the one it
 * asked for. An upload is minting a new name, and the flows that reach here are
 * clipboard paste and drag-and-drop, where a hard error costs the user the
 * screenshot they just took. The rewrite is applied on every platform rather
 * than only on Windows: an attachment is expected to survive a git checkout or a
 * LiveSync replica onto a Windows client, and a name that cannot be written
 * there is a permanently broken embed for that user, not a cosmetic detail.
 */
function safeUploadFilename(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? '';
  // Strip control characters and bidirectional formatting: a NUL can truncate a
  // path inside native calls, controls make the resulting name unusable in a
  // shell, and the bidi overrides make it lie about its own extension wherever
  // it is displayed. See UNSAFE_NAME_CHARS.
  let name = base.replace(UNSAFE_NAME_CHARS, '').replace(WINDOWS_ILLEGAL_CHARS, '-').trim();
  // Windows strips trailing dots and spaces when it canonicalises a name, so
  // `report.md.` and `report.md ` are two more spellings of `report.md` there.
  // Node does not go through that canonicalisation (it addresses files with the
  // extended-length `\\?\` syntax), so it creates a genuinely separate entry:
  // measured and confirmed, the vault then holds a `report.md.` that the tree
  // lists but Explorer, git and Obsidian desktop cannot open. Strip them so one
  // upload means one file that is reachable from every client.
  name = name.replace(/[. ]+$/, '');
  // Reserved device names get the suffix spliced in after the device word, not
  // appended to the whole name. Not a server-side hazard: because Node uses the
  // `\\?\` syntax, `NUL` lands as an ordinary visible file rather than reaching
  // the device (measured, and the reason `resolveInVault` deliberately carries
  // no rule for these). It is still unusable on any Windows client that later
  // syncs the vault, so it is rewritten rather than refused. Appending instead
  // of splicing was the round-2 shape and it was wrong twice over: `con.md`
  // became `con.md-file`, whose extension no longer matches anything `mimeFor`
  // knows, and `con.tar.gz` became `con.tar.gz-file`, which Windows still reads
  // as the CON device because the device is the part before the FIRST dot.
  name = name.replace(WINDOWS_RESERVED_NAME, '$1-file$2');
  // Length last, so it measures the name that will actually be written rather
  // than one that later steps still grow.
  name = clampNameLength(name);
  // `.` and `..` are both reduced to the empty string by the trailing-dot strip
  // above, so the emptiness test covers them, as it covers a name that clamped
  // away to nothing. A leading dot stays a hard refusal rather than a rewrite:
  // silently renaming `.env` into something visible is more surprising than
  // telling the caller no.
  if (!name || name.startsWith('.')) {
    throw Object.assign(new Error('Invalid file name'), { status: 400 });
  }
  return name;
}

/**
 * Write an upload without ever destroying an existing file.
 *
 * `writeFileBuffer` refuses to clobber (it writes with the `wx` flag), so a
 * collision comes back as a 409 and we retry under a suffixed name, Obsidian
 * style. Uniquifying rather than erroring is deliberate: clipboard paste hands
 * every screenshot the same `image.png`, so a hard 409 would break the paste
 * flow, and a silent overwrite would delete the previously pasted image with no
 * error and no trash copy. Retrying against `wx` also means the uniqueness is
 * decided by the filesystem, not by a check-then-write that two concurrent
 * uploads could both pass.
 */
async function writeUploadPreservingExisting(dirRel: string, filename: string, buf: Buffer): Promise<string> {
  const ext = path.posix.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  for (let i = 0; i < 100; i += 1) {
    const candidate = path.posix.join(dirRel, i === 0 ? filename : `${stem}-${i}${ext}`);
    try {
      await vault.writeFileBuffer(candidate, buf);
      return candidate;
    } catch (e: unknown) {
      if ((e as { status?: number })?.status !== 409) throw e;
    }
  }
  throw Object.assign(new Error('Too many files with that name'), { status: 409 });
}

const isMd = (p: string) => /\.(md|markdown)$/i.test(p);

// Refresh derived indexes after a mutation (best-effort, non-blocking).
// Incremental: only the touched file(s) are reparsed, not the whole vault.
function reindex(opts: { upsert?: string; added?: string; removed?: string } = {}) {
  if (opts.upsert) void qmd.upsert(opts.upsert).catch(() => {});
  if (opts.added && isMd(opts.added)) void updateLinkGraphForFile(opts.added).catch(() => {});
  if (opts.removed && isMd(opts.removed)) void updateLinkGraphForFile(opts.removed, true).catch(() => {});
  scheduleAutoCommitOnSave();
}

filesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await vault.listTree());
  }),
);

filesRouter.get(
  '/content',
  asyncHandler(async (req, res) => {
    let rel = String(req.query.path ?? '');
    if (!rel) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    // Obsidian-style resolution: if the exact path doesn't exist (e.g. an embed
    // `![[image.jpg]]` that lives in Attachments/), resolve it by basename.
    if (!(await vault.exists(rel))) {
      const resolved = resolveFile(rel);
      if (resolved) rel = resolved;
    }
    if (vault.isTextFile(rel)) {
      res.json({ path: rel, content: await vault.readFileText(rel), encoding: 'utf8' });
    } else {
      // Stream with Range support so embedded <video>/<audio> can seek.
      const abs = await vault.resolveInVault(rel);
      await sendFileWithRange(req, res, abs, mimeFor(rel));
    }
  }),
);

filesRouter.put(
  '/content',
  asyncHandler(async (req, res) => {
    const { path: rel, content } = req.body ?? {};
    if (typeof rel !== 'string' || typeof content !== 'string') {
      res.status(400).json({ error: 'path and content required' });
      return;
    }
    await vault.writeFileText(rel, content);
    reindex({ upsert: rel, added: rel });
    res.json({ ok: true, path: rel });
  }),
);

filesRouter.post(
  '/folder',
  asyncHandler(async (req, res) => {
    const { path: rel } = req.body ?? {};
    if (typeof rel !== 'string') {
      res.status(400).json({ error: 'path required' });
      return;
    }
    await vault.createFolder(rel);
    res.json({ ok: true, path: rel });
  }),
);

filesRouter.post(
  '/upload',
  uploadSingleFile,
  asyncHandler(async (req, res) => {
    const dir = String(req.body?.dir ?? '');
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'file required' });
      return;
    }
    // Both halves of the destination are client-controlled, so both are checked
    // before anything touches the disk: `resolveDirCaseInsensitive` now rejects
    // traversal in `dir` BEFORE it starts probing directories, and
    // `safeUploadFilename` collapses the multipart-supplied name to one
    // component. `vault.writeFileBuffer` re-resolves the joined path strictly
    // afterwards, so a mistake here is still contained.
    const filename = safeUploadFilename(file.originalname);
    // Reuse an existing folder that differs only in case (e.g. an Obsidian vault's
    // "Attachments") instead of creating a duplicate "attachments". See vault.ts.
    const resolvedDir = dir ? await vault.resolveDirCaseInsensitive(dir) : '';
    // Overwriting an existing attachment now has to be asked for in the request.
    // Anything else picks a free name, so an upload can never silently replace a
    // file that other notes already embed.
    const overwrite = String(req.body?.overwrite ?? '') === 'true';
    let rel: string;
    if (overwrite) {
      rel = path.posix.join(resolvedDir, filename);
      await vault.writeFileBuffer(rel, file.buffer, { overwrite: true });
    } else {
      rel = await writeUploadPreservingExisting(resolvedDir, filename, file.buffer);
    }
    res.json({ ok: true, path: rel, size: file.size });
  }),
);

filesRouter.patch(
  '/rename',
  asyncHandler(async (req, res) => {
    const { from, to } = req.body ?? {};
    if (typeof from !== 'string' || typeof to !== 'string') {
      res.status(400).json({ error: 'from and to required' });
      return;
    }
    await vault.rename(from, to);
    await qmd.rename(from, to);
    await onFileRenamed(from, to).catch(() => {}); // keep public share links pointing at the note
    reindex({ added: to, removed: from });
    res.json({ ok: true, from, to });
  }),
);

filesRouter.post(
  '/copy',
  asyncHandler(async (req, res) => {
    const { from, to } = req.body ?? {};
    if (typeof from !== 'string' || typeof to !== 'string') {
      res.status(400).json({ error: 'from and to required' });
      return;
    }
    const copied = await vault.copy(from, to);
    for (const f of copied) {
      if (isMd(f)) {
        void qmd.upsert(f).catch(() => {});
        void updateLinkGraphForFile(f).catch(() => {});
      }
    }
    scheduleAutoCommitOnSave();
    res.json({ ok: true, from, to });
  }),
);

// --- Trash (FR-1) -----------------------------------------------------------
// Listed/mutated via dedicated /trash* routes; the plain DELETE / below either
// trashes or permanently removes depending on settings.vault.deleteMode.

filesRouter.get(
  '/trash',
  asyncHandler(async (_req, res) => {
    res.json({ items: await vault.listTrash() });
  }),
);

filesRouter.post(
  '/trash/restore',
  asyncHandler(async (req, res) => {
    const rel = String(req.body?.path ?? '');
    if (!rel) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    const restored = await vault.restoreFromTrash(rel);
    reindex({ upsert: restored, added: restored });
    res.json({ ok: true, restored });
  }),
);

// Permanently delete one trashed item.
filesRouter.delete(
  '/trash/item',
  asyncHandler(async (req, res) => {
    const rel = String(req.query.path ?? '');
    if (!rel) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    await vault.deleteFromTrash(rel);
    res.json({ ok: true });
  }),
);

// Empty the whole trash.
filesRouter.delete(
  '/trash',
  asyncHandler(async (_req, res) => {
    await vault.emptyTrash();
    res.json({ ok: true });
  }),
);

filesRouter.delete(
  '/',
  asyncHandler(async (req, res) => {
    const rel = String(req.query.path ?? '');
    if (!rel) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    const s = await getSettings();
    qmd.remove(rel);
    if (s.vault.deleteMode === 'permanent') {
      await vault.remove(rel);
      reindex({ removed: rel });
      res.json({ ok: true, deleted: rel });
      return;
    }
    const dest = await vault.trash(rel);
    reindex({ removed: rel });
    res.json({ ok: true, trashed: dest });
  }),
);
