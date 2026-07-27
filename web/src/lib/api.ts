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
