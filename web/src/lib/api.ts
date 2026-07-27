// Thin fetch wrapper around the WebObsidian server API.

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'folder';
  ext?: string;
  size?: number;
  mtime?: number;
  ctime?: number;
  children?: TreeNode[];
}

export interface TrashItem {
  name: string;
  path: string; // includes the .trash/ prefix
  original: string; // where it restores to
  ext: string;
  size: number;
  mtime: number;
}

export interface ShareRecord {
  id: string;
  path: string;
  enabled: boolean;
  createdAt: string;
  hasPassword?: boolean;
}

export interface SearchHit {
  path: string;
  title: string;
  score: number;
  tags: string[];
  snippet: string;
}

export interface MatchContext {
  text: string;
  ranges: [number, number][];
  pre: boolean;
  post: boolean;
}

export interface NoteMatches {
  path: string;
  count: number;
  contexts: MatchContext[];
}

export interface GitCommit {
  hash: string;
  date: string;
  message: string;
  author: string;
}

/**
 * One peer's health verdict, mirrored from `PeerHealth` in
 * `server/src/services/livesync/health.ts`.
 *
 * Three values rather than a boolean, and the shape is worth preserving all the
 * way out to the browser rather than being flattened into "ok / not ok" by the
 * API. `ok` says whether this peer is syncing right now; `backendUp` says
 * whether its remote answers; `restartWorthy` says whether restarting would
 * plausibly help. Only the combination separates the two states a sync daemon
 * must never confuse: nothing to do (idle) and unable to do it (wedged). A UI
 * that renders one boolean has to pick one of those to lie about.
 */
export interface LiveSyncPeerHealth {
  name: string;
  type: string;
  ok: boolean;
  detail?: string;
  backendUp: boolean;
  restartWorthy: boolean;
}

/**
 * The body of `GET /api/livesync/status`, mirrored field for field from
 * `LiveSyncStatus` in `server/src/services/livesync.ts`.
 *
 * Hand-kept in step, for the same reason as MIN_PASSWORD_LEN below: no module
 * is shared across the server/web workspace boundary. Drift here is a rendering
 * bug rather than a hole, since nothing in this file decides anything, but it is
 * still worth stating that the server owns this shape and this is a copy.
 */
export interface LiveSyncStatus {
  backend: 'none' | 'git' | 'livesync';
  /** True when `sync.backend === 'livesync'`. The backend owning the vault. */
  enabled: boolean;
  /** A peer pair exists and has been started. */
  running: boolean;
  /** The CouchDB peer has a live connection right now. */
  connected: boolean;
  liveMode: boolean;
  intervalSec: number;
  /** `<uri>/<database>` with credentials stripped by the server. */
  remote: string;
  database: string;
  /** Every peer is syncing. */
  healthy: boolean;
  /** Some peer judges that restarting the sync would plausibly help. */
  restartWorthy: boolean;
  peers: LiveSyncPeerHealth[];
  trackedFiles: number;
  applied: { pushed: number; pulled: number };
  lastSyncAt: string | null;
  /** Last failure, already redacted server-side. Cleared by a successful pass. */
  lastError: string | null;
  /** Reasons this configuration can never work. Non-empty means it will not start. */
  configErrors: string[];
  fatalReason: string | null;
}

async function req<T>(url: string, opts: RequestInit = {}): Promise<T> {
  const { headers: optHeaders, ...rest } = opts;
  const res = await fetch(url, {
    credentials: 'include',
    ...rest,
    // headers MUST be merged last: spreading ...opts after a `headers` literal
    // would drop Content-Type whenever a caller passes its own headers.
    headers: { 'Content-Type': 'application/json', ...(optHeaders ?? {}) },
  });
  if (res.status === 401) {
    throw new ApiError('Unauthorized', 401);
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* ignore */
    }
    throw new ApiError(msg, res.status);
  }
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('application/json') ? res.json() : (res.text() as unknown)) as Promise<T>;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/**
 * The message to show when an api call fails.
 *
 * `req()` above throws `ApiError` carrying the server's own `error` string, and
 * those strings are already written for a human ("Password must be at least 6
 * characters", "Vault path is outside the allowed roots"), so they are shown
 * verbatim: the server knows exactly why it refused and we do not want to
 * paraphrase it into something vaguer. Anything else arriving here is a
 * transport or programming failure whose native message ("Failed to fetch",
 * "NetworkError when attempting to fetch resource") names no action the user
 * can take and differs per browser, so the caller supplies a fallback that at
 * least names the operation that did not happen.
 */
export function apiErrorMessage(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

/**
 * Password limits mirrored from the server so the UI can refuse a value before
 * spending a round trip on it, and can say why.
 *
 * Read this before touching anything below it: these constants are a
 * user-experience affordance and never a security control. The server re-checks
 * every one of them and is the only thing that actually decides.
 * `MIN_PASSWORD_LEN` lives in `server/src/services/auth.ts` and gates
 * `/auth/change-password` and the share PATCH; `MAX_SHARE_PASSWORD_LEN` lives in
 * `server/src/routes/shares.ts` and gates both the share PATCH and (crucially,
 * before any scrypt runs) the unauthenticated public unlock endpoint, where it
 * is what stops a 32 MB request body being turned into seconds of key
 * derivation. Everything in this file runs in a browser the user controls, so it
 * can be bypassed with curl or one line in the devtools console. Nothing here
 * may ever become the only check, and no server-side check may be relaxed
 * because "the client already validates".
 *
 * What this does fix is the opposite failure. The server started answering 400
 * for a short share password while the UI still posted it blindly, and `req()`
 * throws on any non-OK status with no error boundary anywhere in `web/src` to
 * catch it, so the rejection surfaced as an unhandled promise rejection: no
 * toast, no reload, nothing at all happened when the button was pressed. A
 * hardening change that presents as a dead button is a regression on the control
 * itself, because the next person to look at it "fixes" the UI by loosening the
 * server.
 *
 * No module is shared across the server/web workspace boundary, so these are
 * kept in step by hand. Drift is not a hole (the server still refuses) and only
 * makes the message wrong, which is why the messages below are built from these
 * constants instead of spelling the numbers out again.
 */
export const MIN_PASSWORD_LEN = 6;
export const MAX_SHARE_PASSWORD_LEN = 1024;

/**
 * Validate a share password the way `PATCH /api/shares/:id` does. Returns null
 * when the value is acceptable, otherwise the message to show.
 *
 * The empty string is deliberately exempt rather than being reported as "too
 * short": on that endpoint `''` and `null` both mean "remove the password",
 * which is a legitimate operation. Callers turn it into null (`pw || null`)
 * before sending, exactly as the server documents.
 *
 * The value is NOT trimmed. A share password may legitimately begin or end with
 * a space and the server hashes precisely the bytes it receives, so trimming
 * here would measure a different string from the one we then send: it would
 * reject a six-space-padded password the server would have accepted, and the
 * user would have no way to tell why. `String.length` counts UTF-16 code units
 * in both runtimes, so the comparison is the same arithmetic on both sides.
 */
export function sharePasswordError(password: string): string | null {
  if (password.length === 0) return null;
  if (password.length < MIN_PASSWORD_LEN) {
    return `Password must be at least ${MIN_PASSWORD_LEN} characters`;
  }
  if (password.length > MAX_SHARE_PASSWORD_LEN) {
    return `Password must be at most ${MAX_SHARE_PASSWORD_LEN} characters`;
  }
  return null;
}

/**
 * Validate a vault root the way `PUT /api/settings` does, as far as a browser
 * honestly can. Returns null when the value is worth sending.
 *
 * `requireVaultRoot` in `server/src/routes/settings.ts` now rejects empty,
 * whitespace-only, NUL-bearing and relative values, because `path.resolve('')`
 * is the server's own working directory: saving an empty box used to relocate
 * the entire vault onto the install tree, which handed out `data/settings.json`
 * (jwtSecret, password hashes, git token, api key hashes) through the ordinary
 * file-read endpoint. Closing that is right. The problem it left behind is that
 * the shipped UI posts the box contents blindly and swallows the rejection, so
 * clearing the field now looks like it simply does nothing.
 *
 * The absolute-path test accepts EITHER a POSIX root or a Windows drive/UNC
 * root, because this code has no idea which OS the server runs on: the vault
 * lives on the server's filesystem, not on the machine rendering this page, and
 * the same web UI is served by the Linux container and by the Electron shell.
 * A union is the only safe direction in which to be wrong. It can pass a value
 * the server then refuses (a Windows path typed at a Linux server), which
 * arrives as the server's own 400 and is displayed; narrowing it by guessing the
 * platform would block a legitimate save with no way around it. Everything the
 * union does catch (empty, ".", "sample-vault") is invalid on every platform, so
 * nothing correct is ever turned away here.
 */
export function vaultPathError(value: string): string | null {
  const raw = value.trim();
  if (!raw) return 'Vault path must not be empty';
  if (raw.includes('\0')) return 'Vault path must not contain NUL bytes';
  const absolute =
    raw.startsWith('/') || raw.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(raw);
  if (!absolute) return 'Vault path must be an absolute path on the server';
  return null;
}

/**
 * The literal the server substitutes for every stored secret on the way out, and
 * the literal it reads back as "the client did not change this".
 *
 * Eight U+2022 BULLET characters, byte-identical to `REDACTED_SECRET` in
 * `server/src/services/settings.ts`. This copy exists because no module crosses
 * the workspace boundary, and it is load-bearing on this side of the round trip
 * too: a settings form is served the mask in place of the git token and the
 * three LiveSync secrets, and `readSecret()` in `server/src/routes/settings.ts`
 * only overwrites a stored secret when the incoming value is non-empty AND is
 * not this string. Send the mask back as if it were a new value and the server
 * refuses it (good), but let the two copies drift and the comparison stops
 * matching, so eight bullet characters are stored as the operator's CouchDB
 * password or E2EE passphrase by a save that reported success. For the
 * passphrase in particular that is unrecoverable: the remote database is then
 * full of documents encrypted under a key nobody has.
 */
export const REDACTED_SECRET = '••••••••';

/** The LiveSync credential fields, which all share the round-trip rule above. */
export type LiveSyncSecretKey = 'password' | 'passphrase' | 'obfuscatePassphrase';

/**
 * What a settings save is about to do to one stored secret.
 *
 * Three cases because the settings PUT has three, and collapsing any two of them
 * loses something real (see `readSecret` in `server/src/routes/settings.ts`):
 *
 *  - `keep`: the field is absent from the patch, or holds the mask or the empty
 *    string. The stored value is left alone. This is the normal state of a save
 *    that was not about the credential at all, which is why a blank password box
 *    cannot mean "erase it".
 *  - `set`: a real new value, sent as-is and stored byte for byte. Never
 *    trimmed anywhere in the chain: a passphrase with a trailing space derives a
 *    different key, and the symptom is not an error but a database this instance
 *    can no longer decrypt.
 *  - `clear`: an explicit JSON `null`, the only way to remove a stored secret.
 *    It exists because an instance holding `obfuscatePassphrase` with no
 *    `passphrase` is otherwise wedged: every livesync save is refused by the
 *    pairing check, and the one field that has to change could not be changed.
 */
export type SecretChange = 'keep' | 'set' | 'clear';

/** Whether a secret will be set once `change` has been applied to it. */
export function secretWillBeSet(stored: boolean, change: SecretChange): boolean {
  if (change === 'set') return true;
  if (change === 'clear') return false;
  return stored;
}

/**
 * Refuse the one LiveSync E2EE combination that looks configured and is not:
 * an obfuscation passphrase with no encryption passphrase. Returns null when the
 * pairing is acceptable, otherwise the message to show.
 *
 * As everywhere else in this file, this is a user-experience affordance and
 * never the control. `assertSafeE2eePairing` in `server/src/routes/settings.ts`
 * applies the identical rule to the MERGED settings draft and answers 400, and
 * `validateCouchDBConf` on the server refuses to start the backend at all. What
 * the local copy buys is a sentence the operator can act on: the server's 400
 * arrives here as a wall of text under a Save button, and the reason it is
 * refusing is genuinely counter-intuitive, so it is worth saying before the
 * round trip and saying it in full.
 *
 * The reason, since a shorter version of it would be useless: the engine derives
 * encryption from `passphrase` alone, while it hashes document ids from
 * `obfuscatePassphrase`. Set obfuscation only and every id in CouchDB becomes an
 * opaque `f:<hash>`, which is exactly what an operator checks to convince
 * themselves that end-to-end encryption is on, while every document BODY stays
 * in the clear: path, mtime, size and the content of every note readable by
 * anyone who can read the database. So the check passes and the property it was
 * meant to prove does not hold. That is strictly worse than plainly unencrypted
 * replication, which at least does not claim otherwise.
 *
 * Both arguments describe the MERGED result rather than the request, because
 * that is the question the server asks: a body that sets only the obfuscation
 * passphrase is safe or not depending on the passphrase already on disk, and a
 * body that clears the passphrase is safe or not depending on the obfuscation
 * passphrase already on disk. Neither can be answered from the patch alone.
 */
export function liveSyncE2eeError(
  passphrase: { stored: boolean; change: SecretChange },
  obfuscate: { stored: boolean; change: SecretChange },
): string | null {
  if (!secretWillBeSet(obfuscate.stored, obfuscate.change)) return null;
  if (secretWillBeSet(passphrase.stored, passphrase.change)) return null;
  return (
    'Path obfuscation needs an encryption passphrase. On its own it hashes every document id in ' +
    'CouchDB, which looks like end-to-end encryption, but the document bodies still carry the ' +
    'path, mtime, size and content in plaintext, so the vault only appears encrypted. Set an ' +
    'encryption passphrase, or clear the obfuscation passphrase.'
  );
}

/** How loud a LiveSync verdict is. Maps onto a colour at each call site. */
export type LiveSyncTone = 'off' | 'ok' | 'warn' | 'bad';

export interface LiveSyncVerdict {
  /** Short label for the status bar. Sentence case, no trailing period. */
  text: string;
  tone: LiveSyncTone;
  /** The long form, for a tooltip or a settings panel. May be several lines. */
  detail: string;
}

/**
 * Turn a status document into one verdict, in ONE place, because two surfaces
 * render it (the status bar and the settings panel) and a status bar that says
 * something different from the settings page is worse than either alone.
 *
 * The ordering of the branches is the whole design, so it is spelled out rather
 * than left to be inferred. KICKOFF section 7 calls a liveness signal that
 * distinguishes idle from wedged the most important requirement here, having
 * watched a bridge stay up, do one full push and then go silent forever. Every
 * branch below exists to keep two states that look identical from the outside
 * from rendering identically:
 *
 *  1. `configErrors` first. These can never be fixed by waiting, so the backend
 *     refuses to start rather than retrying. Reporting that as "offline" would
 *     leave an operator waiting for a recovery that is never coming.
 *  2. `fatalReason` next, same class of problem as judged by a peer that did
 *     start (an encryption or chunking mismatch against the remote's own
 *     settings, which no retry resolves).
 *  3. Not running, i.e. selected but never connected. Actionable, not broken.
 *  4. `restartWorthy` before anything else about the connection, because it is
 *     the wedge signal and it is the loudest thing this UI can say. It is true
 *     only when a peer was healthy once, has stayed unhealthy past a 60s grace
 *     window, AND its remote is reachable: in other words the excuses are gone
 *     and this process is at fault.
 *  5. Not connected, i.e. CouchDB is down. This is the state that must NOT read
 *     as a failure of this instance: nothing here is broken, the peer is
 *     retrying, and the acceptance criterion is precisely that this recovers
 *     without a restart.
 *  6. Not healthy but connected: starting up, or scanning. Peer `detail` says
 *     which, and it is quoted verbatim rather than paraphrased.
 */
export function liveSyncVerdict(st: LiveSyncStatus): LiveSyncVerdict {
  // The collection fields are read through `??` even though the type declares
  // them present. This function runs inside a 15-second poll behind the status
  // bar, where a TypeError does not produce a wrong label, it unmounts the bar:
  // React tears down the tree on a render-time throw, so one unexpectedly absent
  // array from a future server build would take the whole indicator off screen
  // and leave nothing to say why. Degrading to "no peers reported" is strictly
  // better, and costs three characters.
  const peers = st.peers ?? [];
  const configErrors = st.configErrors ?? [];
  const applied = st.applied ?? { pushed: 0, pulled: 0 };
  const peerLines = peers.map(
    (p) => `${p.name} (${p.type}): ${p.ok ? 'syncing' : 'not syncing'}${p.detail ? `, ${p.detail}` : ''}`,
  );
  // `lastError` is already redacted server-side (CouchDB URLs carry
  // user:password, and redactUrlCreds is applied before the string leaves the
  // process). Nothing here may add a credential back into a rendered string.
  const trailer = [st.lastError ? `Last error: ${st.lastError}` : '', ...peerLines]
    .filter(Boolean)
    .join('\n');
  const withTrailer = (head: string) => (trailer ? `${head}\n${trailer}` : head);

  if (!st.enabled) {
    return {
      text: 'LiveSync off',
      tone: 'off',
      detail: `This vault's sync backend is "${st.backend}". Select LiveSync in Settings to use it.`,
    };
  }
  if (configErrors.length > 0) {
    return {
      text: 'LiveSync misconfigured',
      tone: 'bad',
      detail: withTrailer(
        `The backend will not start until this is fixed:\n${configErrors.join('\n')}`,
      ),
    };
  }
  if (st.fatalReason) {
    return {
      text: 'LiveSync stopped',
      tone: 'bad',
      detail: withTrailer(`Stopped and not retrying: ${st.fatalReason}`),
    };
  }
  if (!st.running) {
    return {
      text: 'LiveSync not started',
      tone: 'warn',
      detail: withTrailer('Selected but not connected yet. Press Connect in Settings.'),
    };
  }
  if (st.restartWorthy) {
    return {
      text: 'LiveSync wedged',
      tone: 'bad',
      detail: withTrailer(
        'CouchDB is reachable but a peer has not synced for over a minute. This is not an ' +
          'outage and not idleness: reconnect from Settings.',
      ),
    };
  }
  if (!st.connected) {
    return {
      text: 'LiveSync offline',
      tone: 'warn',
      detail: withTrailer(
        `CouchDB (${st.remote || 'not configured'}) is not answering. The peer keeps retrying and ` +
          'recovers on its own; nothing here needs restarting.',
      ),
    };
  }
  if (!st.healthy) {
    return {
      text: 'LiveSync starting…',
      tone: 'warn',
      detail: withTrailer('Connected, not syncing yet.'),
    };
  }
  const { pushed, pulled } = applied;
  return {
    text: `LiveSync ↑${pushed} ↓${pulled}`,
    tone: 'ok',
    detail: withTrailer(
      `${st.liveMode ? 'Live' : `Every ${st.intervalSec}s`} against ${st.remote}. ` +
        `${st.trackedFiles} files tracked.` +
        (st.lastSyncAt ? ` Last pass ${new Date(st.lastSyncAt).toLocaleTimeString()}.` : ''),
    ),
  };
}

/**
 * The colour for a verdict, resolved centrally so the status bar and the
 * settings panel cannot drift into disagreeing about what counts as bad. The
 * literals are the ones already used elsewhere in web/src for the same meanings.
 */
export function liveSyncToneColor(tone: LiveSyncTone): string {
  if (tone === 'bad') return '#e5534b';
  if (tone === 'warn') return '#d29922';
  if (tone === 'ok') return 'var(--text-accent, #4caf50)';
  return 'var(--text-muted)';
}

export const api = {
  // auth
  // /auth/status is unauthenticated, so it deliberately reports nothing about
  // whether the default password is still in use. mustChangePassword comes from
  // /auth/login and /auth/me instead.
  authStatus: () => req<{ passwordSet: boolean }>('/auth/status'),
  // There is deliberately no `setup()` here any more. It posted to
  // POST /auth/setup, which server/src/routes/auth.ts removed on purpose: it was
  // an unauthenticated "set the owner password and hand me a session cookie"
  // endpoint, i.e. one request away from remote account takeover if its only
  // guard ever changed. The client method outlived the endpoint with no caller
  // left (Login.tsx no longer branches on first-run state at all), so all it
  // could still do was invite someone to wire a button onto a 404 and then
  // "fix" it by putting the route back. Removing the call site removes the
  // invitation.
  login: (password: string) =>
    req<{ ok: true; mustChangePassword: boolean }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  logout: () => req<{ ok: true }>('/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword: string, newPassword: string) =>
    req<{ ok: true }>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  me: () => req<{ authenticated: boolean; mustChangePassword: boolean }>('/auth/me'),

  // files
  tree: () => req<TreeNode>('/api/files/'),
  read: (path: string) =>
    req<{ path: string; content: string }>(`/api/files/content?path=${encodeURIComponent(path)}`),
  write: (path: string, content: string) =>
    req<{ ok: true }>('/api/files/content', { method: 'PUT', body: JSON.stringify({ path, content }) }),
  createFolder: (path: string) =>
    req<{ ok: true }>('/api/files/folder', { method: 'POST', body: JSON.stringify({ path }) }),
  rename: (from: string, to: string) =>
    req<{ ok: true }>('/api/files/rename', { method: 'PATCH', body: JSON.stringify({ from, to }) }),
  copy: (from: string, to: string) =>
    req<{ ok: true }>('/api/files/copy', { method: 'POST', body: JSON.stringify({ from, to }) }),
  remove: (path: string) =>
    req<{ ok: true; trashed?: string; deleted?: string }>(
      `/api/files/?path=${encodeURIComponent(path)}`,
      { method: 'DELETE' },
    ),
  // trash (FR-1)
  listTrash: () => req<{ items: TrashItem[] }>('/api/files/trash'),
  restoreTrash: (path: string) =>
    req<{ ok: true; restored: string }>('/api/files/trash/restore', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  deleteTrashItem: (path: string) =>
    req<{ ok: true }>(`/api/files/trash/item?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  emptyTrash: () => req<{ ok: true }>('/api/files/trash', { method: 'DELETE' }),
  uploadUrl: () => '/api/files/upload',
  upload: async (file: File, dir = 'attachments') => {
    const fd = new FormData();
    fd.append('dir', dir);
    fd.append('file', file);
    const res = await fetch('/api/files/upload', { method: 'POST', credentials: 'include', body: fd });
    if (!res.ok) throw new ApiError((await res.json().catch(() => ({}))).error ?? 'Upload failed', res.status);
    return res.json() as Promise<{ ok: true; path: string; size: number }>;
  },
  rawUrl: (path: string) => `/api/files/content?path=${encodeURIComponent(path)}`,

  // search & links
  // limit omitted → server returns every match (panel renders them incrementally)
  search: (q: string, limit?: number) =>
    req<{ hits: SearchHit[] }>(
      `/api/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ''}`,
    ),
  // per-note highlighted match contexts for the given paths (lazy, batched);
  // phrase=true matches the whole query as one needle (unlinked mentions)
  searchMatches: (query: string, paths: string[], matchCase = false, phrase = false) =>
    req<{ matches: NoteMatches[] }>('/api/search/matches', {
      method: 'POST',
      body: JSON.stringify({ query, paths, matchCase, phrase }),
    }),
  tags: () => req<{ tags: { tag: string; count: number }[] }>('/api/tags'),
  properties: () =>
    req<{ properties: { key: string; type: string; count: number }[] }>('/api/properties'),
  propertyTypes: () => req<{ types: Record<string, string> }>('/api/property-types'),
  setPropertyType: (key: string, type: string) =>
    req<{ types: Record<string, string> }>('/api/property-types', {
      method: 'POST',
      body: JSON.stringify({ key, type }),
    }),
  backlinks: (path: string) =>
    req<{ backlinks: string[] }>(`/api/backlinks?path=${encodeURIComponent(path)}`),
  resolve: (target: string) =>
    req<{ path: string | null }>(`/api/resolve?target=${encodeURIComponent(target)}`),
  graph: () =>
    req<{
      nodes: { id: string; label: string; kind: 'note' | 'attachment' | 'unresolved'; tags: string[] }[];
      edges: { source: string; target: string }[];
    }>('/api/graph'),
  reindex: () => req<{ ok: true }>('/api/reindex', { method: 'POST' }),

  // ui state (workspace persistence, shared across browsers)
  getUiState: () => req<any>('/api/uistate/'),
  putUiState: (state: any, clientId: string) =>
    req<{ ok: true }>('/api/uistate/', {
      method: 'PUT',
      headers: { 'X-Client-Id': clientId },
      body: JSON.stringify(state),
    }),

  // settings
  getSettings: () => req<any>('/api/settings/'),
  putSettings: (patch: any) => req<any>('/api/settings/', { method: 'PUT', body: JSON.stringify(patch) }),
  browse: (dir?: string) =>
    req<{ dir: string; parent: string; roots: string[]; folders: { name: string; path: string }[] }>(
      `/api/settings/browse${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`,
    ),

  // git
  gitStatus: () => req<any>('/api/git/status'),
  gitInit: () => req<any>('/api/git/init', { method: 'POST' }),
  gitClone: () => req<any>('/api/git/clone', { method: 'POST' }),
  gitPull: () => req<{ message: string }>('/api/git/pull', { method: 'POST' }),
  gitCommit: (message?: string) =>
    req<{ message: string }>('/api/git/commit', { method: 'POST', body: JSON.stringify({ message }) }),
  gitPush: () => req<{ message: string }>('/api/git/push', { method: 'POST' }),
  gitSync: (message?: string) =>
    req<{ ok: boolean; log: string[] }>('/api/git/sync', { method: 'POST', body: JSON.stringify({ message }) }),
  gitLog: (path: string) =>
    req<{ commits: GitCommit[] }>(`/api/git/log?path=${encodeURIComponent(path)}`),
  gitShow: (hash: string, path: string) =>
    req<{ content: string }>(`/api/git/show?hash=${encodeURIComponent(hash)}&path=${encodeURIComponent(path)}`),

  // livesync (CouchDB)
  //
  // The sibling of the git block above, and deliberately the same shape: one
  // read endpoint and a small set of explicit actions. `sync` answers
  // `{ ok, log }` exactly as `gitSync` does, so the settings panels can share
  // one "run this and append the output to the log" helper.
  //
  // Every one of these can fail with a CouchDB error, and a CouchDB URL carries
  // user:password. The server applies `redactUrlCreds` before an error string
  // leaves the process, so what arrives in `ApiError.message` is already safe to
  // render; nothing on this side may reconstruct a URL from the settings block
  // and put it into a message.
  liveSyncStatus: () => req<LiveSyncStatus>('/api/livesync/status'),
  // Connect and disconnect are typed `Partial<LiveSyncStatus>` rather than
  // `LiveSyncStatus`, which is not pedantry. They mirror `POST /api/git/init`
  // and `/clone`, which answer with a fresh status object, but the useful part
  // of that answer is a snapshot taken the instant the call returns: a connect
  // resolves once the FIRST attempt has settled, with the supervised retry loop
  // still running behind it, so the peers are usually still starting. Callers
  // should re-read `liveSyncStatus()` a moment later rather than render the
  // echo, and `Partial` is the type that says so, while also staying honest if
  // the route ever answers a bare acknowledgement instead.
  liveSyncConnect: () => req<Partial<LiveSyncStatus>>('/api/livesync/connect', { method: 'POST' }),
  liveSyncDisconnect: () =>
    req<Partial<LiveSyncStatus>>('/api/livesync/disconnect', { method: 'POST' }),
  liveSyncSync: () => req<{ ok: boolean; log: string[] }>('/api/livesync/sync', { method: 'POST' }),

  // api keys
  listKeys: () => req<{ keys: any[] }>('/api/keys/'),
  createKey: (name: string, scopes: string[]) =>
    req<{ key: string; record: any }>('/api/keys/', { method: 'POST', body: JSON.stringify({ name, scopes }) }),
  revokeKey: (id: string) => req<{ ok: boolean }>(`/api/keys/${id}`, { method: 'DELETE' }),

  // public shares (FR-10)
  listShares: () => req<{ shares: ShareRecord[] }>('/api/shares/'),
  createShare: (path: string) =>
    req<{ share: ShareRecord }>('/api/shares/', { method: 'POST', body: JSON.stringify({ path }) }),
  setShareEnabled: (id: string, enabled: boolean) =>
    req<{ share: ShareRecord }>(`/api/shares/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  deleteShare: (id: string) => req<{ ok: true }>(`/api/shares/${id}`, { method: 'DELETE' }),
  // password = null clears the share's password
  setSharePassword: (id: string, password: string | null) =>
    req<{ share: ShareRecord }>(`/api/shares/${id}`, { method: 'PATCH', body: JSON.stringify({ password }) }),
  // NOTE: the public-facing /share/<id> page is fully server-rendered (SSR):
  // the SPA never fetches /public/shares/* itself.

  // plugins
  listPlugins: () => req<{ plugins: any[] }>('/api/plugins/'),
  installPlugin: (repo: string) =>
    req<{ plugin: any }>('/api/plugins/install', { method: 'POST', body: JSON.stringify({ repo }) }),
  setPluginEnabled: (id: string, enabled: boolean) =>
    req<{ ok: true }>(`/api/plugins/${id}/enabled`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
};
