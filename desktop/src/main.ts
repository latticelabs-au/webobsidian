import { app, BrowserWindow, Menu, dialog, net, session, shell, type MenuItemConstructorOptions } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Paths & persisted desktop config
// ---------------------------------------------------------------------------
// Everything user-specific lives under Electron's per-user userData dir:
//   <userData>/desktop-config.json  : { vaultPath, secret, dataDir }
//   <userData>/server-data/         : the server's DATA_DIR (settings.json, index)
//   <userData>/logs/server.log      : server child stdout/stderr (debugging)
const CONFIG_FILE = () => path.join(app.getPath('userData'), 'desktop-config.json');
const DATA_DIR = () => path.join(app.getPath('userData'), 'server-data');
const LOG_FILE = () => path.join(app.getPath('userData'), 'logs', 'server.log');

interface DesktopConfig {
  vaultPath?: string;
  /** Random per-install password, passed to the server as WEBOBSIDIAN_PASSWORD. */
  secret: string;
}

let serverProc: ChildProcess | null = null;
let serverPort = 0;
let mainWindow: BrowserWindow | null = null;

async function readConfig(): Promise<DesktopConfig> {
  try {
    const raw = await fs.readFile(CONFIG_FILE(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<DesktopConfig>;
    if (parsed && typeof parsed.secret === 'string' && parsed.secret.length >= 12) {
      return parsed as DesktopConfig;
    }
  } catch {
    /* first run / corrupt: fall through to fresh config */
  }
  return { secret: randomBytes(24).toString('hex') };
}

/**
 * Persist the desktop config.
 *
 * The 0600 mode is load-bearing, not hygiene. This file holds `secret`, which is
 * handed to the server as WEBOBSIDIAN_PASSWORD, and that value is an override
 * credential: always accepted, never expiring, valid even after the owner has
 * changed their password. Written at the umask default (0644 on Linux/macOS) the
 * file was readable by every other local account, so any user on the machine
 * could read the secret out of it and sign in as the vault owner.
 *
 * The explicit chmod matters as much as the `mode` option: `mode` is only applied
 * when the file is created, so an install that already wrote a 0644 config would
 * otherwise keep those permissions forever, and the fix would only protect fresh
 * installs. On Windows chmod is close to a no-op (there, the ACL inherited from
 * the per-user AppData directory is what protects the file), which is why a
 * failure here is tolerated rather than fatal.
 */
async function writeConfig(cfg: DesktopConfig): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_FILE()), { recursive: true });
  await fs.writeFile(CONFIG_FILE(), JSON.stringify(cfg, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    await fs.chmod(CONFIG_FILE(), 0o600);
  } catch {
    /* platform/filesystem without POSIX modes: the create-time mode is best effort */
  }
}

// ---------------------------------------------------------------------------
// Server entry / runtime layout
// ---------------------------------------------------------------------------
// Packaged: extraResources puts the bundle at <resources>/server/dist/index.mjs.
// Dev (electron dist/main.js): it lives at <desktop>/.gen/server/dist/index.mjs.
function serverEntry(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'server', 'dist', 'index.mjs');
  }
  return path.join(__dirname, '..', '.gen', 'server', 'dist', 'index.mjs');
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

// GUI-launched apps (esp. macOS Finder) inherit a minimal PATH, so `git` (needed
// by the optional vault-sync feature) is often not found. Prepend the usual spots.
function augmentedPath(): string {
  const extra = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const current = process.env.PATH ?? '';
  const parts = current.split(path.delimiter).filter(Boolean);
  for (const p of extra) if (!parts.includes(p)) parts.push(p);
  return parts.join(path.delimiter);
}

async function startServer(cfg: DesktopConfig): Promise<void> {
  serverPort = await freePort();
  await fs.mkdir(DATA_DIR(), { recursive: true });
  await fs.mkdir(path.dirname(LOG_FILE()), { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(serverPort),
    DATA_DIR: DATA_DIR(),
    VAULT_PATH: cfg.vaultPath,
    // Let the in-app folder browser roam the user's home (single-user desktop).
    ALLOWED_ROOTS: os.homedir(),
    // Per-install recovery/override password → enables seamless auto-login.
    WEBOBSIDIAN_PASSWORD: cfg.secret,
    // Cookies must not be Secure over plain http://127.0.0.1.
    COOKIE_SECURE: 'false',
    PATH: augmentedPath(),
  };

  // Run the bundled server with Electron's own Node (no external node needed).
  serverProc = spawn(process.execPath, [serverEntry()], { env, stdio: ['ignore', 'pipe', 'pipe'] });

  const log = (await fs.open(LOG_FILE(), 'a')).createWriteStream();
  serverProc.stdout?.pipe(log);
  serverProc.stderr?.pipe(log);
  serverProc.on('exit', (code, signal) => {
    if (!app.isPackaged) console.error(`[server] exited code=${code} signal=${signal}`);
    serverProc = null;
  });

  await waitForHealth(serverPort);
  await autoLogin(serverPort, cfg.secret);
}

function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await apiRequest('GET', `${baseUrl(port)}/healthz`);
      if (res.status === 200) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('Server did not become healthy in time.');
    await delay(250);
  }
}

interface ApiResult {
  status: number;
  json: unknown;
  setCookie: string[];
}

function apiRequest(
  method: string,
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<ApiResult> {
  return new Promise((resolve, reject) => {
    const req = net.request({ method, url });
    if (body !== undefined) req.setHeader('Content-Type', 'application/json');
    for (const [k, v] of Object.entries(headers ?? {})) req.setHeader(k, v);
    let data = '';
    req.on('response', (res) => {
      const raw = (res.headers['set-cookie'] ?? []) as string | string[];
      const setCookie = Array.isArray(raw) ? raw : raw ? [raw] : [];
      res.on('data', (chunk) => (data += chunk.toString()));
      res.on('end', () => {
        let json: unknown = null;
        try {
          json = data ? JSON.parse(data) : null;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, json, setCookie });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const TOKEN_COOKIE = 'webobsidian_token';

function tokenFromSetCookie(setCookie: string[]): string | undefined {
  for (const c of setCookie) {
    const m = /(?:^|;\s*)webobsidian_token=([^;]+)/.exec(c);
    if (m) return decodeURIComponent(m[1]);
  }
  return undefined;
}

/**
 * Set when auto-login did not produce a working session, so the user is told why
 * instead of being dropped at a login screen with no explanation. On desktop
 * that screen is close to a dead end: the only password that works is the
 * per-install secret, which the user has never seen.
 */
let autoLoginError: string | null = null;

/** Append a line to the server log file, which File > Open Logs surfaces. */
async function appendLog(line: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(LOG_FILE()), { recursive: true });
    await fs.appendFile(LOG_FILE(), `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    /* logging must never be the thing that breaks startup */
  }
}

/**
 * Record an auto-login failure. Never include `secret` or the token in `reason`:
 * this text goes to a log file on disk and into a dialog on screen.
 */
async function failAutoLogin(reason: string): Promise<void> {
  autoLoginError = reason;
  console.error(`[desktop] auto-login failed: ${reason}`);
  await appendLog(`[desktop] auto-login failed: ${reason}`);
}

// Log in with the per-install secret (always accepted as the override password),
// then seed the JWT into the window's session cookie jar so the BrowserWindow is
// authenticated with no login prompt. If still on the default password, promote
// the secret to the custom password (via Bearer auth) so the UI doesn't force a
// password change on first launch.
//
// That promotion is why this cannot just reuse the first token. Owner tokens are
// now bound to a fingerprint of the current credentials (see credentialFingerprint
// in server/src/services/auth.ts), which is what makes a password change evict
// stolen sessions. The change therefore invalidates the very token we just
// obtained, and seeding that dead token into the cookie jar would leave the
// window looking at a login screen it cannot get past. The server re-issues a
// cookie on a successful change-password precisely so this flow can pick the new
// token up; the re-login is the fallback for a server that did not.
//
// Every exit path reports a reason. The previous empty catch turned any failure
// here (server not reachable, secret rejected, cookie jar write refused) into a
// silent "please log in" prompt with no recoverable password.
async function autoLogin(port: number, secret: string): Promise<void> {
  try {
    const login = await apiRequest('POST', `${baseUrl(port)}/auth/login`, { password: secret });
    if (login.status !== 200) {
      await failAutoLogin(`the server rejected the per-install password (HTTP ${login.status})`);
      return;
    }
    let token = tokenFromSetCookie(login.setCookie);
    if (!token) {
      await failAutoLogin('the server did not return a session cookie on login');
      return;
    }

    const mustChange = Boolean(
      login.json && typeof login.json === 'object' && (login.json as { mustChangePassword?: boolean }).mustChangePassword,
    );
    if (mustChange) {
      const changed = await apiRequest(
        'POST',
        `${baseUrl(port)}/auth/change-password`,
        { currentPassword: secret, newPassword: secret },
        { Authorization: `Bearer ${token}` },
      );
      if (changed.status !== 200) {
        await failAutoLogin(
          `could not adopt the per-install password as the account password (HTTP ${changed.status})`,
        );
        return;
      }
      const refreshed = tokenFromSetCookie(changed.setCookie);
      if (refreshed) {
        token = refreshed;
      } else {
        const relogin = await apiRequest('POST', `${baseUrl(port)}/auth/login`, { password: secret });
        const retoken = tokenFromSetCookie(relogin.setCookie);
        if (relogin.status !== 200 || !retoken) {
          await failAutoLogin(
            `could not re-authenticate after the password change (HTTP ${relogin.status})`,
          );
          return;
        }
        token = retoken;
      }
    }

    // Prove the token actually authenticates before handing it to the window.
    // Cheap, and it converts "the UI mysteriously shows the login screen" into a
    // specific line in the log.
    const me = await apiRequest('GET', `${baseUrl(port)}/auth/me`, undefined, {
      Authorization: `Bearer ${token}`,
    });
    if (me.status !== 200) {
      await failAutoLogin(`the session token was not accepted by /auth/me (HTTP ${me.status})`);
      return;
    }

    await session.defaultSession.cookies.set({
      url: baseUrl(port),
      name: TOKEN_COOKIE,
      value: token,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000),
    });
  } catch (err) {
    await failAutoLogin(String(err instanceof Error ? err.message : err));
  }
}

// ---------------------------------------------------------------------------
// Vault selection
// ---------------------------------------------------------------------------
async function ensureVault(cfg: DesktopConfig): Promise<DesktopConfig> {
  if (cfg.vaultPath) {
    try {
      const st = await fs.stat(cfg.vaultPath);
      if (st.isDirectory()) return cfg;
    } catch {
      /* configured vault vanished: re-pick */
    }
  }
  const picked = await pickVaultDialog(true);
  cfg.vaultPath = picked;
  await writeConfig(cfg);
  return cfg;
}

// Prompt for a folder. On first run (no window yet) we also offer a sensible
// default so the user can get going with one click.
async function pickVaultDialog(firstRun: boolean): Promise<string> {
  const result = await dialog.showOpenDialog({
    title: 'Choose your vault folder',
    message: 'Select a folder to use as your WebObsidian vault',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Use this folder',
  });
  if (!result.canceled && result.filePaths[0]) return result.filePaths[0];

  // Cancelled: fall back to (and create) a default vault under Documents.
  const fallback = path.join(app.getPath('documents'), 'WebObsidianVault');
  await fs.mkdir(fallback, { recursive: true });
  if (firstRun) {
    await dialog.showMessageBox({
      type: 'info',
      message: 'Using a default vault',
      detail: `No folder chosen, your notes will live in:\n${fallback}\n\nYou can switch vaults later from the menu.`,
      buttons: ['OK'],
    });
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Window + menu
// ---------------------------------------------------------------------------
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#1e1e1e',
    title: 'WebObsidian',
    icon: app.isPackaged ? undefined : path.join(__dirname, '..', 'buildResources', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(baseUrl(serverPort));

  // Open external links (http/https not on our origin) in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(baseUrl(serverPort))) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function switchVault(): Promise<void> {
  const cfg = await readConfig();
  const picked = await pickVaultDialog(false);
  if (picked === cfg.vaultPath) return;
  cfg.vaultPath = picked;
  await writeConfig(cfg);
  // Restart cleanly so the server re-indexes against the new vault.
  app.relaunch();
  app.exit(0);
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Switch Vault…', click: () => void switchVault() },
        {
          label: 'Open Vault Folder',
          click: async () => {
            const cfg = await readConfig();
            if (cfg.vaultPath) shell.openPath(cfg.vaultPath);
          },
        },
        { type: 'separator' },
        { label: 'Open Data Folder', click: () => shell.openPath(DATA_DIR()) },
        { label: 'Open Logs', click: () => shell.openPath(LOG_FILE()) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'WebObsidian on GitHub',
          click: () => shell.openExternal('https://github.com/xnohat/webobsidian'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      let cfg = await readConfig();
      cfg = await ensureVault(cfg);
      await writeConfig(cfg); // persist freshly-generated secret on first run
      await startServer(cfg);
      buildMenu();
      createWindow();
      // Shown after the window exists, and not awaited, so a failed auto-login
      // never blocks startup. The app is still usable if the user knows the
      // password; the point is that they are told sign-in failed and where to
      // look, instead of silently facing a login prompt.
      if (autoLoginError) {
        void dialog.showMessageBox({
          type: 'warning',
          message: 'Automatic sign-in failed',
          detail: `WebObsidian could not sign in to its local server, so you will see the login screen.\n\nReason: ${autoLoginError}\n\nDetails are in File > Open Logs.`,
          buttons: ['OK'],
        });
      }
    } catch (err) {
      dialog.showErrorBox('WebObsidian failed to start', String(err instanceof Error ? err.stack ?? err.message : err));
      app.quit();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && serverPort) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    if (serverProc) {
      serverProc.kill();
      serverProc = null;
    }
  });
}
