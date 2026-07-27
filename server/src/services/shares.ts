import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';

/** Public share links (FR-10): persisted as a JSON array in data/shares.json. */
export interface ShareRecord {
  id: string;
  path: string; // vault-relative note path
  enabled: boolean;
  createdAt: string;
  /** Optional scrypt hash, set when the share is password-protected. */
  passwordHash?: string;
}

const SHARES_FILE = path.join(config.dataDir, 'shares.json');

let cache: ShareRecord[] | null = null;
/** Identity of the file the current `cache` was built from: see load(). */
let cacheStamp: string | null = null;

/**
 * A cheap fingerprint of shares.json used to decide whether `cache` is still
 * the file. `null` means "no such file", which is itself a state worth
 * distinguishing (the file appearing has to invalidate an empty cache).
 *
 * mtime plus size rather than a content hash because this runs on every lookup
 * and the file is the authority, not the data: a stat is microseconds, reading
 * and parsing is not. `ino` is included where the platform provides it (it is 0
 * on Windows) so that a replace-by-rename with an identical size and a
 * coarse-grained mtime still reads as a different file.
 */
async function fileStamp(): Promise<string | null> {
  try {
    const st = await fs.stat(SHARES_FILE);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return null;
  }
}

/**
 * Read shares.json, re-reading whenever the file on disk has changed.
 *
 * This used to cache once for the lifetime of the process, which was defensible
 * while the cache only decided whether a URL resolved: this process is the only
 * writer, so its own memory was always current. `isPubliclyShared()` below
 * changed that. The cache is now a PUBLICATION decision, consulted while
 * rendering a canvas for an anonymous visitor, and a stale one keeps inlining a
 * note whose share was revoked out of band. "Out of band" is not exotic here:
 * the project stores its whole runtime state as hand-editable JSON in `data/`,
 * and deleting a line from shares.json is exactly how an operator would expect
 * to pull a link in a hurry. A revocation that silently does not take effect
 * until the next restart is the worst possible failure mode for that action.
 *
 * The stat is deliberately unconditional rather than TTL-throttled. A canvas
 * with many note cards calls this once per card, but each of those calls is
 * about to read and render a markdown file if it passes, so the stat is noise
 * next to the work it gates, and any TTL would reintroduce a window in which a
 * revoked note is still being published.
 *
 * Not a lock: `persist()` writes tmp-then-rename, so a concurrent reader sees
 * either the whole old file or the whole new one, never a torn one.
 */
async function load(): Promise<ShareRecord[]> {
  const stamp = await fileStamp();
  if (cache && stamp === cacheStamp) return cache;
  try {
    const raw = await fs.readFile(SHARES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    cache = Array.isArray(parsed)
      ? parsed.filter(
          (r): r is ShareRecord =>
            r && typeof r.id === 'string' && typeof r.path === 'string',
        )
      : [];
  } catch {
    cache = [];
  }
  cacheStamp = stamp;
  return cache;
}

/**
 * Atomic write: tmp + rename (same pattern as settings.json).
 *
 * It also adopts `shares` as the cache and re-stamps it. That is not an
 * optimisation bolted on: cache and cacheStamp have to describe the same bytes
 * or load() misbehaves in one of two ways, and doing both assignments here, in
 * the one place that changes the file, is what keeps them together. Without the
 * re-stamp every write would look like an external edit and force a re-read on
 * the next lookup; without adopting `shares` the in-memory array the callers
 * just mutated could be discarded in favour of a re-parse.
 */
async function persist(shares: ShareRecord[]): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
  const tmp = `${SHARES_FILE}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, JSON.stringify(shares, null, 2), { mode: 0o600 });
  await fs.rename(tmp, SHARES_FILE);
  cache = shares;
  cacheStamp = await fileStamp();
}

export async function listShares(): Promise<ShareRecord[]> {
  return [...(await load())];
}

/** Look up an ENABLED share by token (used by the public route). */
export async function getActiveShare(id: string): Promise<ShareRecord | null> {
  const shares = await load();
  return shares.find((s) => s.id === id && s.enabled) ?? null;
}

/**
 * Normalise a vault-relative path so two spellings of the same note compare
 * equal. Share records are written from the SPA, canvas file-nodes are written
 * by Obsidian, and the two can differ in leading `./`, a leading separator, or
 * (on a vault authored on Windows) backslashes.
 *
 * Deliberately conservative: it normalises separators and leading noise only,
 * and does NOT resolve `..`, case-fold, or fall back to basename matching. This
 * function decides whether a note may be published, so every ambiguity has to
 * resolve to "no match" (fail closed). A looser comparison here would let a
 * canvas smuggle a note past the publication gate below.
 */
function normalizeVaultPath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '');
}

/**
 * Is this exact note published to the world in its own right: enabled, and with
 * no password of its own?
 *
 * This is the gate that stops a shared canvas from republishing the notes it
 * references (see services/rendercanvas.ts). Obsidian's canvas UX invites you to
 * drag notes onto a board as preview cards, so before this gate existed,
 * publishing one canvas silently published the full text of every note on it to
 * anonymous visitors. Requiring the referenced note to carry its own share
 * record makes publication an explicit, per-note act by the owner, and it is
 * safe by construction: inlining a note that already answers to the whole
 * internet at its own /share/<id> URL discloses nothing new.
 *
 * The `!passwordHash` half matters just as much as `enabled`. A password-
 * protected note is NOT public: inlining it into a canvas page (which may itself
 * be unprotected, or protected by a different password) would hand its contents
 * to a visitor who never proved knowledge of its password, turning the canvas
 * into an oracle that bypasses the note's own credential check.
 */
export async function isPubliclyShared(relPath: string): Promise<boolean> {
  const want = normalizeVaultPath(relPath);
  if (!want) return false;
  const shares = await load();
  return shares.some(
    (s) => s.enabled && !s.passwordHash && normalizeVaultPath(s.path) === want,
  );
}

/**
 * Create a share for a note. One record per note: if the note already has a
 * share, re-enable and return it (keeps the existing public URL stable).
 */
export async function createShare(relPath: string): Promise<ShareRecord> {
  const shares = await load();
  const existing = shares.find((s) => s.path === relPath);
  if (existing) {
    if (!existing.enabled) {
      existing.enabled = true;
      await persist(shares);
    }
    return existing;
  }
  const record: ShareRecord = {
    id: randomBytes(16).toString('base64url'),
    path: relPath,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  shares.push(record);
  await persist(shares);
  return record;
}

export async function setShareEnabled(id: string, enabled: boolean): Promise<ShareRecord | null> {
  const shares = await load();
  const rec = shares.find((s) => s.id === id);
  if (!rec) return null;
  if (rec.enabled !== enabled) {
    rec.enabled = enabled;
    await persist(shares);
  }
  return rec;
}

/** Set (hash) or clear (null) the password of a share. */
export async function setSharePassword(id: string, passwordHash: string | null): Promise<ShareRecord | null> {
  const shares = await load();
  const rec = shares.find((s) => s.id === id);
  if (!rec) return null;
  if (passwordHash) rec.passwordHash = passwordHash;
  else delete rec.passwordHash;
  await persist(shares);
  return rec;
}

export async function deleteShare(id: string): Promise<boolean> {
  const shares = await load();
  const next = shares.filter((s) => s.id !== id);
  if (next.length === shares.length) return false;
  // Swap the cache in BEFORE the write, not after. persist() awaits three fs
  // operations, and a public request that lands in that window must already see
  // the share as gone: a revocation should take effect at the earliest possible
  // moment, never the latest. persist() re-stamps afterwards.
  cache = next;
  await persist(next);
  return true;
}

/** Keep share paths in sync when notes are renamed/deleted elsewhere. */
export async function onFileRenamed(from: string, to: string): Promise<void> {
  const shares = await load();
  const rec = shares.find((s) => s.path === from);
  if (rec) {
    rec.path = to;
    await persist(shares);
  }
}
