import { Router } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import {
  getSettings,
  updateSettings,
  redactSettings,
  ensureVaultBrowsable,
  isVaultRelativeSubpath,
  isWithinRoot,
  type Settings,
} from '../services/settings.js';
import { config } from '../config.js';

/** Build an error the shared error middleware will answer with `status`. */
function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/** The subset of the settings tree this endpoint accepts. Everything arrives as
 *  unknown and is narrowed per field below; nothing is trusted by shape alone. */
interface SettingsPatchBody {
  vault?: Record<string, unknown>;
  git?: Record<string, unknown>;
  search?: Record<string, unknown>;
  ui?: Record<string, unknown>;
  api?: Record<string, unknown>;
}

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

settingsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(redactSettings(await getSettings()));
  }),
);

// Patch a subset of settings. Secret fields are only overwritten when present.
settingsRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    const body: SettingsPatchBody = req.body ?? {};
    // Validate the vault patch BEFORE opening the update, so a rejected value
    // answers 400/403 without ever taking the settings lock or half-applying the
    // rest of the body.
    const vaultPatch = body.vault ? sanitizeVault(body.vault) : null;
    // A changed vault.path turns the whole files API into read/write over that
    // tree, so constrain it to the allowed roots (same gate as Browse…) and
    // require it to be an existing directory before persisting.
    //
    // Keyed on PRESENCE, not on truthiness. The previous gate was
    // `typeof body.vault.path === 'string' && body.vault.path`, and "" is falsy,
    // so `{"vault":{"path":""}}` skipped the allowed-roots check entirely and was
    // then copied straight through to disk. getVaultRoot() is
    // `path.resolve(s.vault.path)` and `path.resolve('')` is the server's own
    // working directory, so that one request relocated the vault onto the install
    // tree: with the default DATA_DIR, `GET /api/files/content?path=data/settings.json`
    // then returns jwtSecret, both password hashes, git.token and every API key
    // hash in cleartext, and `PUT /api/files/content?path=server/dist/index.js`
    // is code execution on the next restart. It was reachable from the shipped
    // UI, which posts `{vault:{path}}` from a free-text input: clearing the box
    // and pressing Save was enough. sanitizeVault now refuses empty, relative and
    // NUL-bearing values outright, and this gate runs for every path that
    // survives it.
    //
    // It is handed the sanitised string rather than the raw body so that the
    // value which is checked is byte-for-byte the value that gets persisted.
    if (vaultPatch?.path !== undefined) await assertVaultPathAllowed(vaultPatch.path);
    // Also validated before the lock, and for the same reason as the vault fields:
    // this one is the API rate budget, and middleware/apikey.ts tests
    // `arr.length >= perMin`, so a persisted 0 or -1 429s every valid agent key
    // on its first request and keeps doing it across restarts. `typeof === 'number'`
    // was the only check, which accepts 0, -1 and 0.5 alike. The schema carries the
    // same bound with a `.catch()` for hand-edited files; here it is a loud 400.
    const rateLimit = body.api?.rateLimitPerMin;
    if (rateLimit !== undefined) {
      if (typeof rateLimit !== 'number' || !Number.isInteger(rateLimit) || rateLimit < 1) {
        throw httpError(400, 'api.rateLimitPerMin must be a whole number of at least 1');
      }
    }
    const updated = await updateSettings((d) => {
      if (vaultPatch) {
        Object.assign(d.vault, vaultPatch);
        ensureVaultBrowsable(d);
      }
      if (body.git) {
        const { token, ...rest } = body.git;
        Object.assign(d.git, rest);
        if (typeof token === 'string' && token && token !== '••••••••') d.git.token = token;
      }
      if (body.search) Object.assign(d.search, body.search);
      if (body.ui) Object.assign(d.ui, body.ui);
      if (typeof rateLimit === 'number') d.api.rateLimitPerMin = rateLimit;
    });
    res.json(redactSettings(updated));
  }),
);

/**
 * Narrow an incoming vault patch to the fields we accept, rejecting anything that
 * would let a directory setting escape the vault root.
 *
 * `trash` is joined onto the vault root and then treated as a trusted directory:
 * it backs GET /api/files/trash (lists every entry) and DELETE /api/files/trash
 * (fs.rm recursive+force over every entry), so a value like
 * "..\\..\\..\\Windows\\Temp" turned a notes setting into host directory
 * disclosure plus recursive deletion. It used to be copied straight through on a
 * `typeof === 'string'` check alone. `attachmentDir` has no consumer in this
 * build at all, so it is validated pre-emptively rather than defensively: it is
 * schema'd as a vault-relative directory and the only thing such a setting can
 * ever be used for is a join onto the vault root, so the first consumer should
 * inherit the invariant instead of rediscovering it.
 *
 * `path` is the field with the real blast radius, because it IS the vault root
 * rather than something under it. See the gate in the PUT handler.
 *
 * `allowedRoots` is deliberately NOT accepted here; see effectiveRoots().
 *
 * This throws a 400 rather than silently coercing, because a settings PUT is an
 * explicit operator action and should fail loudly. The zod schema applies the
 * same predicates as a non-destructive fallback for hand-edited files.
 */
function sanitizeVault(v: Record<string, unknown>): Partial<Settings['vault']> {
  const out: Partial<Settings['vault']> = {};
  if (v.path !== undefined) out.path = requireVaultRoot(v.path);
  if (v.trash !== undefined) out.trash = requireVaultRelative(v.trash, 'vault.trash');
  if (typeof v.deleteMode === 'string' && (v.deleteMode === 'trash' || v.deleteMode === 'permanent')) {
    out.deleteMode = v.deleteMode;
  }
  if (v.attachmentDir !== undefined) {
    out.attachmentDir = requireVaultRelative(v.attachmentDir, 'vault.attachmentDir');
  }
  return out;
}

/**
 * Accept an absolute host directory for the vault root, or reject the request.
 *
 * Every rejected form here resolves somewhere the caller did not name:
 *   - "" and "   ": `path.resolve('')` is the server's working directory, i.e.
 *     the install tree (see the long note on the gate in the PUT handler).
 *   - "." and "..": the same thing, and the parent of it.
 *   - any other relative value: resolved against whatever directory the process
 *     happened to be started in, which is not something an operator can reason
 *     about and which changes under systemd, Docker and the Electron shell.
 *   - NUL: truncates inside libuv, so the string validated here would not be the
 *     path opened at syscall time.
 * Absolute-only removes the whole class in one rule, and it costs nothing: the
 * Browse... picker returns absolute paths already.
 *
 * The value is normalised with path.resolve so that the containment check, the
 * stat and the stored value are all the same canonical string.
 */
function requireVaultRoot(value: unknown): string {
  const bad = (why: string) => httpError(400, `vault.path ${why}`);
  if (typeof value !== 'string') throw bad('must be a string');
  const raw = value.trim();
  if (!raw) throw bad('must not be empty');
  if (raw.includes('\0')) throw bad('must not contain NUL bytes');
  if (!path.isAbsolute(raw)) throw bad('must be an absolute path');
  return path.resolve(raw);
}

/** Accept a vault-relative directory or reject the whole request with a 400.
 *  The value is trimmed on the way in so " .trash " cannot smuggle whitespace
 *  into a path that later gets joined onto the vault root. The schema trims too,
 *  so both doors store the same thing. */
function requireVaultRelative(value: unknown, field: string): string {
  if (!isVaultRelativeSubpath(value)) {
    throw httpError(
      400,
      `${field} must be a directory inside the vault: no absolute paths, drive letters, UNC prefixes or ".." segments`,
    );
  }
  return value.trim();
}

/**
 * The roots a vault path may live under. Operator configuration ONLY.
 *
 * This is the single most important property in this file, so it is stated
 * plainly: nothing a request carries may influence the boundary that same request
 * is checked against. The previous version took `newAllowed` straight from the
 * PUT body and preferred it over everything else, which meant
 *
 *     PUT /api/settings {"vault":{"path":"C:\\","allowedRoots":["C:\\"]}}
 *
 * passed trivially. That is not a weak gate, it is not a gate: the request
 * supplied the rule it was measured against, so it granted itself the whole
 * filesystem as a read/write vault and, on the way, overrode the operator's
 * ALLOWED_ROOTS env, the only server-side control an operator has. Two requests
 * would have been enough even without the body preference, because
 * `vault.allowedRoots` was itself writable through the same PUT (write the roots
 * first, move the vault second), which is why sanitizeVault no longer accepts the
 * field at all and the schema documents it as operator-only.
 *
 * Precedence, all of it out of reach of the API:
 *   1. ALLOWED_ROOTS (config.allowedRoots). An operator who states a boundary
 *      explicitly gets that boundary and nothing may widen it, persisted settings
 *      included: previously the persisted list won, so a settings.json that had
 *      drifted wider silently voided the env. config.defaultVaultPath rides along
 *      because it is operator configuration too (VAULT_PATH), and without it an
 *      operator whose ALLOWED_ROOTS does not happen to contain their VAULT_PATH
 *      could not browse to their own vault.
 *   2. The persisted list, which now only ever changes through a hand edit of
 *      settings.json (filesystem access) or ensureVaultBrowsable's server-side
 *      healing, which can only ever add a path the gate already allowed.
 *   3. The home directory, unchanged, as the last-resort default for an install
 *      that has neither.
 *
 * One caveat worth stating rather than hiding: this does not retroactively narrow
 * an install whose persisted vault.path or allowedRoots were already widened by
 * exploiting the old behaviour. Case 2 keeps trusting the file. An operator who
 * suspects that should set ALLOWED_ROOTS, which case 1 makes authoritative.
 *
 * Used by both the PUT gate and GET /browse, which previously disagreed about
 * precedence. One function, one answer.
 */
async function effectiveRoots(): Promise<string[]> {
  const raw = config.allowedRoots.length
    ? [...config.allowedRoots, config.defaultVaultPath]
    : (await getSettings()).vault.allowedRoots;
  const roots = (raw.length ? raw : [os.homedir()]).map((r) => path.resolve(r));
  return [...new Set(roots)];
}

/** Confirm a candidate vault root is inside the operator's boundary and is a real
 *  directory. Throws 403/400; never returns a value the caller has to remember to
 *  check. `vaultPath` must already be absolute and normalised (requireVaultRoot). */
async function assertVaultPathAllowed(vaultPath: string): Promise<void> {
  const target = path.resolve(vaultPath);
  const roots = await effectiveRoots();
  if (!roots.some((r) => isWithinRoot(target, r))) {
    throw httpError(403, 'Vault path is outside the allowed roots');
  }
  const st = await fs.stat(target).catch(() => null);
  if (!st || !st.isDirectory()) {
    throw httpError(400, 'Vault path is not an existing directory');
  }
  // Symlink guard, mirroring assertRealpathInVault in services/vault.ts: the
  // check above is lexical, so a symlink sitting inside an allowed root and
  // pointing anywhere at all would satisfy it while the vault actually lands
  // outside the boundary (fs.stat follows the link, so it reports a directory).
  // Only done when the realpath differs, both to save the syscalls on the common
  // case and because realpath canonicalises case on Windows: comparing a
  // canonicalised target against uncanonicalised roots would 403 valid paths.
  const real = await fs.realpath(target).catch(() => target);
  if (real !== target) {
    const realRoots = await Promise.all(roots.map((r) => fs.realpath(r).catch(() => r)));
    if (!realRoots.some((r) => isWithinRoot(real, r))) {
      throw httpError(403, 'Vault path resolves outside the allowed roots');
    }
  }
}


/** Safe folder browser for picking a vault path, limited to allowed roots. */
settingsRouter.get(
  '/browse',
  asyncHandler(async (req, res) => {
    // Same roots as the PUT gate, from the same function. These two used to
    // compute the boundary independently and in a different precedence order,
    // which is how a browser could enumerate a directory the PUT would refuse
    // (and the reverse). A picker that shows a folder the save then rejects is
    // also just a bad experience, so agreeing has two payoffs.
    const roots = await effectiveRoots();
    const dir = req.query.dir ? path.resolve(String(req.query.dir)) : roots[0];

    const allowed = roots.some((r) => isWithinRoot(dir, r));
    if (!allowed) {
      res.status(403).json({ error: 'Path outside allowed roots', roots });
      return;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const folders = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ dir, parent: path.dirname(dir), roots, folders });
  }),
);
