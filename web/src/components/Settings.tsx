import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { useEscapeToClose } from '../lib/useEscapeToClose';
import {
  api,
  apiErrorMessage,
  sharePasswordError,
  vaultPathError,
  liveSyncE2eeError,
  liveSyncToneColor,
  liveSyncVerdict,
  secretWillBeSet,
  ssoRedirectUri,
  loginLimitError,
  LOGIN_RATE_LIMIT_BOUNDS,
  MIN_PASSWORD_LEN,
  REDACTED_SECRET,
  SSO_CALLBACK_PATH,
  type LiveSyncSecretKey,
  type LiveSyncStatus,
  type SecretChange,
} from '../lib/api';
import Icon from './Icon';

// The three literals below (this union, the nav array in Settings() and the
// `labels` map) are parallel and have to stay in step: the union decides what
// can be selected, the array decides what is rendered, and the map decides what
// it is called. A section added to only one or two of them either cannot be
// reached or renders a blank tab with no label, and nothing warns about it.
type Section =
  | 'vault'
  | 'git'
  | 'livesync'
  | 'api'
  | 'sharing'
  | 'plugins'
  | 'appearance'
  | 'sso'
  | 'account'
  | 'about';

export default function Settings() {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettings);
  const [section, setSection] = useState<Section>('vault');
  const [settings, setSettings] = useState<any>(null);

  useEffect(() => {
    if (open) api.getSettings().then(setSettings).catch(() => {});
  }, [open]);

  /*
   * Escape closes. Until this existed, the ONLY way out of this dialog was
   * clicking the backdrop, and on mobile the backdrop is not reachable: the
   * media query promotes .settings-modal to `position: fixed; inset: 0`, so it
   * covers the click target completely and the settings screen becomes a dead
   * end with no way back to the vault. The explicit close button below is the
   * real fix for that; this is the keyboard half, and it also brings the dialog
   * in line with the command palette and the context menu, which both close on
   * Escape already.
   */
  useEscapeToClose(open, () => setOpen(false));

  if (!open) return null;

  return (
    <div className="modal-bg" onClick={() => setOpen(false)}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-layout">
          <div className="settings-nav">
            {/*
              Pinned to the start of the nav strip rather than floated over the
              content, because the strip is the one element that is always
              visible: it scrolls horizontally on mobile, and a close control
              that scrolled away with the tabs would reintroduce the dead end it
              exists to fix. `position: sticky` keeps it parked at the left edge
              while the tabs slide underneath.
            */}
            <button
              className="settings-close"
              onClick={() => setOpen(false)}
              aria-label="Close settings"
              title="Close settings (Esc)"
            >
              ✕
            </button>
            {(['vault', 'git', 'livesync', 'api', 'sharing', 'plugins', 'appearance', 'sso', 'account', 'about'] as Section[]).map((s) => (
              <button key={s} className={section === s ? 'active' : ''} onClick={() => setSection(s)}>
                {labels[s]}
              </button>
            ))}
          </div>
          <div className="settings-content">
            {settings && section === 'vault' && <VaultSettings s={settings} reload={() => api.getSettings().then(setSettings)} />}
            {settings && section === 'git' && <GitSettings s={settings} reload={() => api.getSettings().then(setSettings)} />}
            {settings && section === 'livesync' && <LiveSyncSettings s={settings} reload={() => api.getSettings().then(setSettings)} />}
            {section === 'api' && <ApiKeys />}
            {section === 'sharing' && <Shares />}
            {section === 'plugins' && <Plugins />}
            {settings && section === 'appearance' && <Appearance s={settings} />}
            {settings && section === 'sso' && <SsoSettings s={settings} reload={() => api.getSettings().then(setSettings)} />}
            {section === 'account' && <AccountSettings s={settings} reload={() => api.getSettings().then(setSettings)} />}
            {section === 'about' && <About />}
          </div>
        </div>
      </div>
    </div>
  );
}

const labels: Record<Section, string> = {
  vault: 'Vault & Files',
  git: 'GitHub Sync',
  livesync: 'LiveSync (CouchDB)',
  api: 'API Keys',
  sharing: 'Sharing',
  plugins: 'Community Plugins',
  appearance: 'Appearance',
  sso: 'Single Sign-On (OIDC)',
  account: 'Account',
  about: 'About',
};

function Row({ name, desc, children }: { name: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <div className="info">
        <div className="name">{name}</div>
        {desc && <div className="desc">{desc}</div>}
      </div>
      <div className="control">{children}</div>
    </div>
  );
}

function VaultSettings({ s, reload }: { s: any; reload: () => void }) {
  const [path, setPath] = useState(s.vault.path);
  const [deleteMode, setDeleteMode] = useState(s.vault.deleteMode ?? 'trash');
  const [browser, setBrowser] = useState<any>(null);
  const [err, setErr] = useState('');
  // The vault path is the field with the largest blast radius in the whole app:
  // it IS the root the files API reads and writes. The server now refuses empty,
  // whitespace-only, relative and NUL-bearing values with a 400, and refuses a
  // path outside the operator's allowed roots with a 403. Neither answer was
  // visible before: `api.putSettings` throws and this handler swallowed it, so
  // clearing the box and pressing Save produced no error, no alert and no
  // reload. The pre-flight check below is a UX affordance only; requireVaultRoot
  // and assertVaultPathAllowed in server/src/routes/settings.ts remain the gate,
  // and the 403 in particular cannot be evaluated here at all because the
  // allowed roots are operator configuration the browser never sees.
  const save = async () => {
    setErr('');
    const invalid = vaultPathError(path);
    if (invalid) {
      setErr(invalid);
      return;
    }
    try {
      await api.putSettings({ vault: { path } });
    } catch (e) {
      setErr(apiErrorMessage(e, 'Could not save the vault path'));
      return;
    }
    await reload();
    alert('Vault path saved. Reindex from the command palette if needed.');
  };
  // The select is updated optimistically so the control does not feel laggy, so
  // a rejected save has to put it back: leaving the UI showing "Permanently
  // delete" while the server still holds "trash" would misreport what the next
  // delete actually does, which is the one place in this panel where a stale
  // reading is dangerous rather than merely wrong.
  const saveDeleteMode = async (mode: string) => {
    const previous = deleteMode;
    setErr('');
    setDeleteMode(mode);
    try {
      await api.putSettings({ vault: { deleteMode: mode } });
    } catch (e) {
      setDeleteMode(previous);
      setErr(apiErrorMessage(e, 'Could not save the delete mode'));
      return;
    }
    await reload();
  };
  const browse = async (dir?: string) => setBrowser(await api.browse(dir).catch((e) => ({ error: e.message })));
  return (
    <div>
      <h2>Vault & Files</h2>
      <Row name="Vault path" desc="Absolute path on the server to your notes folder">
        <input className="text-input" style={{ width: 260 }} value={path} onChange={(e) => setPath(e.target.value)} />
      </Row>
      <div style={{ display: 'flex', gap: 8, margin: '8px 0' }}>
        <button className="btn secondary" onClick={() => browse()}>Browse…</button>
        <button className="btn" onClick={save}>Save vault path</button>
      </div>
      {err && <div style={{ color: '#e5534b', margin: '6px 0' }}>{err}</div>}
      {browser && !browser.error && (
        <div style={{ border: '1px solid var(--bg-modifier-border)', borderRadius: 6, padding: 8, marginTop: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>{browser.dir}</div>
          <div className="result" onClick={() => browse(browser.parent)} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="folder" size={15} /> ..
          </div>
          {browser.folders.map((f: any) => (
            <div className="result" key={f.path} onClick={() => browse(f.path)} onDoubleClick={() => setPath(f.path)} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon name="folder" size={15} /> {f.name}
              <button className="btn secondary" style={{ float: 'right', padding: '2px 8px' }} onClick={(e) => { e.stopPropagation(); setPath(f.path); }}>
                Select
              </button>
            </div>
          ))}
        </div>
      )}
      {browser?.error && <div style={{ color: '#e5534b' }}>{browser.error}</div>}
      <Row
        name="When deleting a file"
        desc="Move to .trash keeps a recoverable copy (Open trash to restore). Permanently delete removes it immediately."
      >
        <select
          className="text-input"
          style={{ width: 220 }}
          value={deleteMode}
          onChange={(e) => saveDeleteMode(e.target.value)}
        >
          <option value="trash">Move to .trash (recoverable)</option>
          <option value="permanent">Permanently delete</option>
        </select>
      </Row>
    </div>
  );
}

function GitSettings({ s, reload }: { s: any; reload: () => void }) {
  const [g, setG] = useState({ ...s.git });
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLTextAreaElement>(null);
  const set = (k: string, v: any) => setG((p: any) => ({ ...p, [k]: v }));
  // Append timestamped lines to the running log instead of replacing it, so the
  // textarea keeps a history of every git action across clicks.
  const append = (lines: string[]) => {
    const ts = new Date().toLocaleTimeString();
    setLog((prev) => [...prev, ...lines.map((l, i) => (i === 0 ? `[${ts}] ${l}` : `         ${l}`))]);
  };
  // Auto-scroll to the newest line whenever the log grows.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);
  // Reported through the same log the git actions below use, rather than
  // swallowed. `run()` already catches for every git operation; Save was the one
  // button in this panel that did not, so a rejected settings write (session
  // expired, or any future validation on the git block) appended nothing and the
  // log's silence read as success.
  const save = async () => {
    try {
      await api.putSettings({ git: g });
    } catch (e) {
      append([`Error: ${apiErrorMessage(e, 'Could not save git settings')}`]);
      return;
    }
    await reload();
    append(['Saved git settings']);
  };
  const run = async (fn: () => Promise<any>, label: string) => {
    append([`${label}…`]);
    try {
      const r = await fn();
      // sync returns { ok, log: string[] }; others return { message }. Split any
      // embedded newlines so multi-line git output renders one line per row.
      const lines: string[] = Array.isArray(r?.log)
        ? [`${label} ${r.ok ? 'ok' : 'NOT ok'}`, ...r.log]
        : [String(r?.message ?? JSON.stringify(r))];
      append(lines.flatMap((l) => String(l).split('\n')));
    } catch (e: any) { append([`Error: ${e.message}`]); }
  };
  return (
    <div>
      <h2>GitHub Sync</h2>
      {/*
        Stated here rather than only on the LiveSync page, because this is the
        page whose controls stop doing anything. `sync.backend` holds ONE value:
        git and LiveSync resolve conflicts in incompatible ways (git at commit
        granularity over a working tree it assumes it alone mutates, LiveSync per
        document against CouchDB revision history), so two writers over one vault
        churn between two histories that cannot afterwards be merged. Without
        this line the checkboxes below read as live settings that are quietly
        ignored, which is the kind of thing that gets debugged as a server bug.
      */}
      {s.sync?.backend === 'livesync' && (
        <div style={{ color: '#d29922', margin: '6px 0 12px' }}>
          LiveSync currently owns this vault, so nothing on this page runs. The sync backend is
          one choice, not a set. Switch it back under LiveSync (CouchDB) to use git again.
        </div>
      )}
      <Row name="Enable git sync"><input type="checkbox" checked={g.enabled} onChange={(e) => set('enabled', e.target.checked)} /></Row>
      <Row name="Remote URL" desc="https://github.com/owner/repo.git">
        <input className="text-input" style={{ width: 260 }} value={g.remote} onChange={(e) => set('remote', e.target.value)} />
      </Row>
      <Row name="Branch"><input className="text-input" style={{ width: 120 }} value={g.branch} onChange={(e) => set('branch', e.target.value)} /></Row>
      <Row name="Access token (PAT)" desc="Stored server-side; leave masked to keep current">
        <input className="text-input" type="password" style={{ width: 260 }} value={g.token} onChange={(e) => set('token', e.target.value)} />
      </Row>
      <Row name="Author name"><input className="text-input" value={g.authorName} onChange={(e) => set('authorName', e.target.value)} /></Row>
      <Row name="Author email"><input className="text-input" value={g.authorEmail} onChange={(e) => set('authorEmail', e.target.value)} /></Row>
      <Row name="Auto-sync" desc="Periodic pull+commit+push on the interval below"><input type="checkbox" checked={g.autoSync} onChange={(e) => set('autoSync', e.target.checked)} /></Row>
      <Row name="Auto-commit on save" desc="Commit (+push) ~5s after each edit"><input type="checkbox" checked={g.autoCommitOnSave} onChange={(e) => set('autoCommitOnSave', e.target.checked)} /></Row>
      <Row name="Interval (sec)"><input className="text-input" type="number" style={{ width: 90 }} value={g.intervalSec} onChange={(e) => set('intervalSec', Number(e.target.value))} /></Row>
      <Row name="Git LFS patterns" desc="Space-separated globs tracked via LFS">
        <input className="text-input" style={{ width: 260 }} value={(g.lfsPatterns || []).join(' ')} onChange={(e) => set('lfsPatterns', e.target.value.split(/\s+/).filter(Boolean))} />
      </Row>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <button className="btn" onClick={save}>Save</button>
        <button className="btn secondary" onClick={() => run(api.gitInit, 'Init')}>Init repo</button>
        <button className="btn secondary" onClick={() => run(api.gitClone, 'Clone')}>Clone</button>
        <button className="btn secondary" onClick={() => run(api.gitPull, 'Pull')}>Pull</button>
        <button className="btn secondary" onClick={() => run(() => api.gitCommit(), 'Commit')}>Commit</button>
        <button className="btn secondary" onClick={() => run(api.gitPush, 'Push')}>Push</button>
        <button className="btn" onClick={() => run(() => api.gitSync(), 'Sync')}>Sync now</button>
      </div>
      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Sync log</span>
          {log.length > 0 && (
            <button className="btn secondary" style={{ padding: '2px 8px' }} onClick={() => setLog([])}>Clear</button>
          )}
        </div>
        <textarea
          ref={logRef}
          readOnly
          value={log.length ? log.join('\n') : 'No git activity yet. Click an action above (Sync now, Pull, Push…) to see logs here.'}
          style={{
            width: '100%', height: 200, boxSizing: 'border-box', resize: 'vertical',
            background: 'var(--bg-primary)', color: 'var(--text-normal)',
            border: '1px solid var(--bg-modifier-border, #444)', borderRadius: 6, padding: 10,
            fontFamily: 'var(--font-monospace, monospace)', fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre',
          }}
        />
      </div>
    </div>
  );
}

/**
 * The three LiveSync credential fields, in the order they are rendered.
 *
 * Kept as data rather than three copies of the same JSX because all three obey
 * the identical, and easy to get wrong, round-trip rule described on
 * `SecretRow`: the server serves a mask in place of a stored secret and treats
 * that mask coming back as "unchanged". Writing the rule once, next to the list
 * of fields it applies to, is what keeps a fourth field from being added later
 * with a plain `<input>` that wipes the credential on the next save.
 */
const LIVESYNC_SECRETS: { key: LiveSyncSecretKey; name: string; desc: string }[] = [
  {
    key: 'password',
    name: 'CouchDB password',
    desc: 'Stored server-side, never sent back to this page.',
  },
  {
    key: 'passphrase',
    name: 'Encryption passphrase',
    desc: 'End-to-end encryption. Must match every other peer on this database, exactly, including any spaces.',
  },
  {
    key: 'obfuscatePassphrase',
    name: 'Path obfuscation passphrase',
    desc: 'Hashes document ids in CouchDB. Requires the encryption passphrase above.',
  },
];

/**
 * One credential input, plus the two affordances the round-trip rule needs.
 *
 * Shared by the three LiveSync secrets and by the OIDC client secret, because
 * the rule below is a property of the settings API rather than of any one block:
 * every secret field in `PUT /api/settings` goes through the same `readSecret()`
 * and therefore has the same three states and the same trap.
 *
 * The server sends `REDACTED_SECRET` in place of a stored secret and reads that
 * same string back as "the client did not change this" (see `readSecret` in
 * server/src/routes/settings.ts). That makes a naive password box actively
 * dangerous in two directions, and both are handled here:
 *
 *  - Typing INTO the mask. The box is rendered holding eight bullet characters,
 *    so an operator who clicks at the end and types their passphrase submits
 *    "••••••••hunter2", which is not the mask, so the server stores it verbatim
 *    as the passphrase. Nothing reports an error: the vault is simply encrypted
 *    under a key that exists nowhere else, and it is discovered as an entire
 *    remote database that no other peer can decrypt. The mask is therefore
 *    cleared on first focus, once, so an edit always starts from empty.
 *  - No way to REMOVE a secret. Blank means "leave it alone" (a password box is
 *    conventionally blank even when a value is stored, so a blank field is the
 *    normal state of a save that was not about the credential), which leaves an
 *    instance holding an obfuscation passphrase and no encryption passphrase
 *    with no way out: every save is refused by the pairing check, and the one
 *    field that has to change cannot be changed. `Clear` sends an explicit JSON
 *    null, which is the server's documented signal and one no text input can
 *    produce by accident.
 */
function SecretRow({
  name,
  desc,
  value,
  stored,
  cleared,
  onFocus,
  onChange,
  onToggleClear,
}: {
  name: string;
  desc: string;
  value: string;
  stored: boolean;
  cleared: boolean;
  onFocus: () => void;
  onChange: (v: string) => void;
  onToggleClear: () => void;
}) {
  const state = cleared
    ? 'Will be removed when you save.'
    : stored
      ? 'A value is stored. Leave blank to keep it.'
      : 'Not set.';
  return (
    <Row name={name} desc={`${desc} ${state}`}>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          className="text-input"
          type="password"
          style={{ width: 200 }}
          autoComplete="new-password"
          disabled={cleared}
          value={cleared ? '' : value}
          onFocus={onFocus}
          onChange={(e) => onChange(e.target.value)}
        />
        {(stored || cleared) && (
          <button className="btn secondary" style={{ padding: '2px 8px' }} onClick={onToggleClear}>
            {cleared ? 'Keep' : 'Clear'}
          </button>
        )}
      </span>
    </Row>
  );
}

/**
 * Replace one key of a per-secret record, keeping the record's exact key set.
 *
 * A one-liner with a signature, rather than an inline spread at each of the six
 * call sites, so the three parallel records (value, touched, cleared) can only
 * ever be updated in the same shape and a typo in a computed key is a type error
 * instead of a fourth, silently ignored entry.
 */
function withSecret<T>(
  base: Record<LiveSyncSecretKey, T>,
  key: LiveSyncSecretKey,
  value: T,
): Record<LiveSyncSecretKey, T> {
  return { ...base, [key]: value };
}

/** True for the `{ ok, log }` shape that `POST /api/livesync/sync` answers with. */
function isSyncResult(r: unknown): r is { ok: boolean; log: string[] } {
  return typeof r === 'object' && r !== null && Array.isArray((r as { log?: unknown }).log);
}

/**
 * The LiveSync (CouchDB) backend panel, built on GitSettings' shape: the same
 * `Row` helper, the same append-only timestamped log, the same action-button
 * row. Two operators looking at the two sync backends should not have to learn
 * two pages.
 *
 * What is different is that this backend can be running, wedged or refusing to
 * start, and those are three different things. Git's status is a question about
 * a working tree and is answered by looking; a replication peer that has gone
 * silent looks exactly like a replication peer with nothing to do. So the panel
 * polls `GET /api/livesync/status` and renders the verdict, rather than only
 * showing what the last button press returned.
 */
function LiveSyncSettings({ s, reload }: { s: any; reload: () => void }) {
  const [backend, setBackend] = useState<'none' | 'git' | 'livesync'>(s.sync?.backend ?? 'none');
  const [cfg, setCfg] = useState({
    // The URI arrives already masked by redactUrlCreds() in case a hand-edited
    // settings.json embedded credentials in it. Round-tripping that mask is
    // safe: the settings PUT recognises "the masked form of what is stored" as
    // "unchanged" and leaves the stored URL alone, precisely so a form that
    // shows what it read cannot replace a working URL with a broken one.
    uri: s.livesync?.uri ?? '',
    database: s.livesync?.database ?? '',
    username: s.livesync?.username ?? '',
    liveMode: Boolean(s.livesync?.liveMode),
    intervalSec: Number(s.livesync?.intervalSec ?? 30),
  });
  const includeInternal: string[] = s.livesync?.includeInternal ?? [];
  const blank: Record<LiveSyncSecretKey, boolean> = {
    password: false,
    passphrase: false,
    obfuscatePassphrase: false,
  };
  // What the server sent for each secret: the mask when a value is stored, the
  // empty string when it is not. Rendered as-is, so "configured" and "not
  // configured" stay visibly different states.
  const [sec, setSec] = useState<Record<LiveSyncSecretKey, string>>({
    password: s.livesync?.password ?? '',
    passphrase: s.livesync?.passphrase ?? '',
    obfuscatePassphrase: s.livesync?.obfuscatePassphrase ?? '',
  });
  const [stored, setStored] = useState<Record<LiveSyncSecretKey, boolean>>({
    password: s.livesync?.password === REDACTED_SECRET,
    passphrase: s.livesync?.passphrase === REDACTED_SECRET,
    obfuscatePassphrase: s.livesync?.obfuscatePassphrase === REDACTED_SECRET,
  });
  const [touched, setTouched] = useState<Record<LiveSyncSecretKey, boolean>>(blank);
  const [cleared, setCleared] = useState<Record<LiveSyncSecretKey, boolean>>(blank);
  const [status, setStatus] = useState<LiveSyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLTextAreaElement>(null);

  const append = (lines: string[]) => {
    const ts = new Date().toLocaleTimeString();
    setLog((prev) => [...prev, ...lines.map((l, i) => (i === 0 ? `[${ts}] ${l}` : `         ${l}`))]);
  };
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  /**
   * What this save will do to one stored secret, in the settings API's own three
   * cases. `touched` matters: an untouched field still holds the mask, and the
   * mask is never a new value.
   */
  const changeOf = (k: LiveSyncSecretKey): SecretChange => {
    if (cleared[k]) return 'clear';
    return touched[k] && sec[k] ? 'set' : 'keep';
  };

  const refresh = async () => {
    try {
      setStatus(await api.liveSyncStatus());
    } catch (e) {
      setStatus(null);
      append([`Error: ${apiErrorMessage(e, 'Could not read the LiveSync status')}`]);
    }
  };
  // Polled while the panel is open, not only after a button press. Connecting is
  // asynchronous by design (the connect call returns once the FIRST attempt has
  // settled, with the supervised retry loop continuing behind it), so a panel
  // that only refreshed on demand would show "not started" for a peer that came
  // up two seconds later, and the operator would press Connect again.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      try {
        const next = await api.liveSyncStatus();
        if (alive) setStatus(next);
      } catch {
        /* a transient failure is reported by the explicit actions, not by the poll */
      }
    };
    void tick();
    const id = setInterval(tick, 10000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const save = async () => {
    // Refused here as well as at the server, because the server's 400 for this
    // arrives as a paragraph under a Save button with no indication of which of
    // the two fields to change, and because the rule itself is counter-intuitive
    // enough that stating it before the round trip is worth the duplication. The
    // server remains the gate: it applies the identical rule to the merged draft
    // and the backend refuses to start on it regardless of what this page thinks.
    const e2ee = liveSyncE2eeError(
      { stored: stored.passphrase, change: changeOf('passphrase') },
      { stored: stored.obfuscatePassphrase, change: changeOf('obfuscatePassphrase') },
    );
    if (e2ee) {
      append([`Not saved: ${e2ee}`]);
      return;
    }
    // Same bound the settings PUT applies, and for the same reason: at 0 or a
    // negative value the poll timer degenerates into a hot loop against CouchDB,
    // and the value is persisted, so the damage survives a restart.
    if (!Number.isInteger(cfg.intervalSec) || cfg.intervalSec < 1) {
      append(['Not saved: interval must be a whole number of seconds, at least 1']);
      return;
    }
    const livesync: Record<string, unknown> = {
      uri: cfg.uri,
      database: cfg.database,
      username: cfg.username,
      liveMode: cfg.liveMode,
      intervalSec: cfg.intervalSec,
    };
    const changes: Record<LiveSyncSecretKey, SecretChange> = {
      password: changeOf('password'),
      passphrase: changeOf('passphrase'),
      obfuscatePassphrase: changeOf('obfuscatePassphrase'),
    };
    for (const { key } of LIVESYNC_SECRETS) {
      // 'keep' sends nothing at all. The mask would be ignored by the server
      // anyway, but omitting the key says what is meant and keeps the mask out
      // of the request body entirely.
      if (changes[key] === 'set') livesync[key] = sec[key];
      else if (changes[key] === 'clear') livesync[key] = null;
    }
    try {
      await api.putSettings({ sync: { backend }, livesync });
    } catch (e) {
      append([`Error: ${apiErrorMessage(e, 'Could not save the LiveSync settings')}`]);
      return;
    }
    // Re-derive the credential editors from what was just applied rather than
    // from a re-read, because a re-read cannot tell us anything the request did
    // not already decide (the server either applied exactly this patch or threw)
    // and the props this component was built from do not update in place.
    const nextStored = { ...stored };
    const nextSec = { ...sec };
    for (const { key } of LIVESYNC_SECRETS) {
      nextStored[key] = secretWillBeSet(stored[key], changes[key]);
      nextSec[key] = nextStored[key] ? REDACTED_SECRET : '';
    }
    setStored(nextStored);
    setSec(nextSec);
    setTouched(blank);
    setCleared(blank);
    reload();
    append(['Saved LiveSync settings']);
    await refresh();
  };

  const run = async (fn: () => Promise<unknown>, label: string) => {
    if (busy) return;
    setBusy(true);
    append([`${label}…`]);
    try {
      const r = await fn();
      // sync answers { ok, log } exactly as the git backend does; connect and
      // disconnect answer a status snapshot that is stale the moment it is taken
      // (see the note in lib/api.ts), so it is deliberately not rendered. The
      // refresh below is the honest answer to "what happened".
      append(
        isSyncResult(r)
          ? [`${label} ${r.ok ? 'ok' : 'NOT ok'}`, ...r.log].flatMap((l) => String(l).split('\n'))
          : [`${label} requested`],
      );
    } catch (e) {
      append([`Error: ${apiErrorMessage(e, `${label} failed`)}`]);
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  /** Drop a ported bridge config's `includeInternal` list. See the row below. */
  const clearIncludeInternal = async () => {
    try {
      await api.putSettings({ livesync: { includeInternal: [] } });
    } catch (e) {
      append([`Error: ${apiErrorMessage(e, 'Could not clear the internal-files list')}`]);
      return;
    }
    reload();
    append(['Cleared livesync.includeInternal']);
    await refresh();
  };

  const verdict = status ? liveSyncVerdict(status) : null;

  return (
    <div>
      <h2>LiveSync (CouchDB)</h2>
      <p style={{ color: 'var(--text-muted)' }}>
        Replicate this vault into a Self-hosted LiveSync CouchDB database, as a peer alongside the
        Obsidian plugin on your other devices.
      </p>
      {/*
        The mutual exclusivity is a data-integrity rule, not a UI simplification,
        so it is stated where the choice is made. Git resolves conflicts at commit
        granularity over a working tree it assumes it alone mutates; LiveSync
        resolves them per document against CouchDB revision history. Run both and
        each reads the other's writes as an unexplained local edit: a checkout
        reverts a replicated change, LiveSync replicates the revert back out, the
        next tick reverts it again, and there is no merge that repairs it
        afterwards. The settings model makes the bad state unrepresentable (one
        enum, no "both"), and this select is that enum.
      */}
      <Row
        name="Sync backend"
        desc="Which backend owns this vault. One at a time: git and LiveSync have incompatible conflict models, and running both over one vault corrupts it."
      >
        <select
          className="text-input"
          style={{ width: 220 }}
          value={backend}
          onChange={(e) => setBackend(e.target.value as 'none' | 'git' | 'livesync')}
        >
          <option value="none">No sync</option>
          <option value="git">Git</option>
          <option value="livesync">LiveSync (CouchDB)</option>
        </select>
      </Row>
      <Row name="CouchDB URL" desc="Base URL without the database name, e.g. https://couchdb.example:6984">
        <input
          className="text-input"
          style={{ width: 260 }}
          value={cfg.uri}
          onChange={(e) => setCfg((p) => ({ ...p, uri: e.target.value }))}
        />
      </Row>
      <Row name="Database" desc="Lowercase, starting with a letter. The same database the other peers use.">
        <input
          className="text-input"
          style={{ width: 200 }}
          value={cfg.database}
          onChange={(e) => setCfg((p) => ({ ...p, database: e.target.value }))}
        />
      </Row>
      <Row name="Username">
        <input
          className="text-input"
          style={{ width: 200 }}
          value={cfg.username}
          onChange={(e) => setCfg((p) => ({ ...p, username: e.target.value }))}
        />
      </Row>
      {LIVESYNC_SECRETS.map((f) => (
        <SecretRow
          key={f.key}
          name={f.name}
          desc={f.desc}
          value={sec[f.key]}
          stored={stored[f.key]}
          cleared={cleared[f.key]}
          onFocus={() => {
            if (touched[f.key] || cleared[f.key]) return;
            setTouched((p) => withSecret(p, f.key, true));
            setSec((p) => withSecret(p, f.key, ''));
          }}
          onChange={(v) => setSec((p) => withSecret(p, f.key, v))}
          onToggleClear={() => {
            const next = !cleared[f.key];
            setCleared((p) => withSecret(p, f.key, next));
            // Leaving a half-typed value behind a "will be removed" flag is
            // ambiguous about what the save will do, so the editor resets.
            if (next) {
              setTouched((p) => withSecret(p, f.key, false));
              setSec((p) => withSecret(p, f.key, stored[f.key] ? REDACTED_SECRET : ''));
            }
          }}
        />
      ))}
      {/*
        Off by default and NOT interval polling's default, deliberately: live mode
        holds an open changes feed and applies remote writes into the vault the
        moment they arrive, so a mistyped database name is discovered by having
        someone else's vault written over this one in real time. Interval polling
        reaches the same steady state one tick later, with a window in which the
        mistake can still be noticed.
      */}
      <Row name="Live mode" desc="Continuous replication. Turn it on once the pairing is proven.">
        <input
          type="checkbox"
          checked={cfg.liveMode}
          onChange={(e) => setCfg((p) => ({ ...p, liveMode: e.target.checked }))}
        />
      </Row>
      <Row name="Interval (sec)" desc="Poll interval when live mode is off">
        <input
          className="text-input"
          type="number"
          min={1}
          style={{ width: 90 }}
          value={cfg.intervalSec}
          onChange={(e) => setCfg((p) => ({ ...p, intervalSec: Number(e.target.value) }))}
        />
      </Row>
      {/*
        Read-only on purpose, and shown at all only so an operator who ported a
        bridge config can see why their backend refuses to start. The reference
        bridge's implementation of this feature strips the base directory BEFORE
        adding the `i:` prefix (mangling the stored name) and never re-adds the
        prefix on the way back out (producing a second, divergent document), and
        WebObsidian's own watcher deliberately ignores .obsidian/ because desktop
        Obsidian rewrites those files constantly. So the backend treats a
        non-empty list as a configuration error rather than shipping the defect.
        There is no control to switch it on because there is nothing here worth
        switching on.
      */}
      <Row
        name="Internal files"
        desc="Replicating .obsidian internals is not supported; a non-empty list stops the backend from starting."
      >
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ color: includeInternal.length ? '#e5534b' : 'var(--text-faint)' }}>
            {includeInternal.length ? includeInternal.join(' ') : 'none'}
          </span>
          {includeInternal.length > 0 && (
            <button className="btn secondary" style={{ padding: '2px 8px' }} onClick={clearIncludeInternal}>
              Clear
            </button>
          )}
        </span>
      </Row>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <button className="btn" onClick={save}>Save</button>
        <button className="btn secondary" disabled={busy} onClick={() => run(api.liveSyncConnect, 'Connect')}>
          Connect
        </button>
        <button className="btn" disabled={busy} onClick={() => run(api.liveSyncSync, 'Sync')}>
          Sync now
        </button>
        <button className="btn secondary" disabled={busy} onClick={() => run(api.liveSyncDisconnect, 'Disconnect')}>
          Disconnect
        </button>
        <button className="btn secondary" onClick={() => void refresh()}>
          Refresh status
        </button>
      </div>
      {verdict && status && (
        <div
          style={{
            border: '1px solid var(--bg-modifier-border, #444)',
            borderRadius: 6,
            padding: 10,
            marginTop: 12,
          }}
        >
          <div style={{ color: liveSyncToneColor(verdict.tone), fontWeight: 600 }}>{verdict.text}</div>
          {/*
            pre-wrap because the verdict's detail carries one line per peer and
            per error. Those lines are the whole point of the three-valued health
            model: "vault (storage): syncing" next to "couchdb (couchdb): not
            syncing, connecting" is what separates idle from wedged at a glance.
          */}
          <div style={{ whiteSpace: 'pre-wrap', color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
            {verdict.detail}
          </div>
          <div style={{ color: 'var(--text-faint)', fontSize: 12, marginTop: 6 }}>
            backend {status.backend} · {status.running ? 'running' : 'stopped'} ·{' '}
            {status.connected ? 'connected' : 'not connected'} ·{' '}
            {status.liveMode ? 'live' : `every ${status.intervalSec}s`} · {status.trackedFiles} tracked ·
            ↑{status.applied?.pushed ?? 0} ↓{status.applied?.pulled ?? 0}
          </div>
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Sync log</span>
          {log.length > 0 && (
            <button className="btn secondary" style={{ padding: '2px 8px' }} onClick={() => setLog([])}>Clear</button>
          )}
        </div>
        <textarea
          ref={logRef}
          readOnly
          value={log.length ? log.join('\n') : 'No LiveSync activity yet. Save, then Connect, then Sync now.'}
          style={{
            width: '100%', height: 200, boxSizing: 'border-box', resize: 'vertical',
            background: 'var(--bg-primary)', color: 'var(--text-normal)',
            border: '1px solid var(--bg-modifier-border, #444)', borderRadius: 6, padding: 10,
            fontFamily: 'var(--font-monospace, monospace)', fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre',
          }}
        />
      </div>
    </div>
  );
}

/**
 * Split a textarea the operator pastes one entry per line into a list.
 *
 * Newlines rather than spaces, and only for the two allowlists. A group name may
 * legitimately contain a space ("Vault Admins"), so splitting those on
 * whitespace would silently turn one entry into two that match nothing, and the
 * symptom is a lockout that looks identical to a working configuration when you
 * read the settings page. Scopes are the opposite case and are split on
 * whitespace instead: a space is the OAuth scope delimiter by specification, so
 * a scope cannot contain one, and the server refuses an entry that does.
 *
 * Blank lines and padding are dropped here as well as on the server, which
 * de-duplicates and trims identically (`normalizeOidcList`). Doing it on both
 * sides means the value the operator reads back after a save is the value that
 * was sent, rather than a tidied version of it that looks like an edit.
 */
function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Native OIDC single sign-on (FR-15), built on the same shape as the Git and
 * LiveSync panels: the `Row` helper, one Save button, one message line.
 *
 * WHY THIS BLOCK EXISTS AT ALL, since a reverse-proxy forward-auth (Authelia,
 * Authentik, tinyauth) is the usual answer and would need no settings page: a
 * forward-auth gate tells this server that SOMEBODY authenticated and nothing
 * else, so every visitor collapses into the single owner session and no per-user
 * state can ever be built on it. It also only covers browsers, leaving the
 * /api/v1 agent API, the Electron shell talking to 127.0.0.1 and the /ws upgrade
 * unserved. Configuring the issuer here means the identity is something this
 * server learns and keeps.
 *
 * The three fields most likely to be got wrong are called out on screen rather
 * than left to documentation: the redirect URI (exact string matching at the
 * IdP, no near misses), the allowlists (empty means any account the IdP will
 * authenticate) and password sign-in (turning it off breaks the desktop shell).
 */
/** Stored rules -> one `claim = value` line per value, grouped by claim. */
function claimRulesToText(rules: unknown): string {
  if (!Array.isArray(rules)) return '';
  const lines: string[] = [];
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    const claim = String((rule as any).claim ?? '').trim();
    const values = Array.isArray((rule as any).values) ? (rule as any).values : [];
    for (const v of values) if (claim && typeof v === 'string') lines.push(`${claim} = ${v}`);
  }
  return lines.join('\n');
}

/**
 * `claim = value` lines -> stored rules, merging repeated claim names.
 *
 * Split on the FIRST `=` only: claim names never contain one, and a value might
 * (base64 padding, a query string in a URL-shaped claim). Splitting on the last
 * one, or on all of them, would silently corrupt exactly those values.
 */
function claimRulesFromText(text: string): { claim: string; values: string[] }[] {
  const byClaim = new Map<string, string[]>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const claim = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!claim || !value) continue;
    const existing = byClaim.get(claim);
    if (existing) existing.push(value);
    else byClaim.set(claim, [value]);
  }
  return [...byClaim].map(([claim, values]) => ({ claim, values }));
}

function SsoSettings({ s, reload }: { s: any; reload: () => void }) {
  const o = s.oidc ?? {};
  const [cfg, setCfg] = useState({
    enabled: Boolean(o.enabled),
    // The issuer and the redirect URI arrive already masked by redactUrlCreds()
    // in case a hand-edited settings.json embedded credentials in one of them.
    // Round-tripping that mask is safe: the settings PUT recognises "the masked
    // form of what is stored" as "unchanged" and leaves the stored URL alone,
    // precisely so a form that shows what it read cannot replace a working URL
    // with a broken one.
    issuer: o.issuer ?? '',
    clientId: o.clientId ?? '',
    redirectUri: o.redirectUri ?? '',
    scopes: (o.scopes ?? ['openid', 'profile', 'email']).join(' '),
    allowedSubjects: (o.allowedSubjects ?? []).join('\n'),
    allowedGroups: (o.allowedGroups ?? []).join('\n'),
    allowedEmails: (o.allowedEmails ?? []).join('\n'),
    // Defaults TRUE when absent, matching the schema. Reading a missing value as
    // false would render a settings page claiming the password door is shut on
    // an install where it is wide open.
    allowPasswordLogin: o.allowPasswordLogin !== false,
    // Same "absent means the schema default" reasoning as allowPasswordLogin:
    // reading a missing value as 'off' would render a page claiming PKCE is
    // disabled on an install where it is on.
    pkce: (o.pkce ?? 'auto') as 'auto' | 'force' | 'off',
    // Stored as [{claim, values[]}] but edited as `claim = value` lines, because
    // a repeating two-field record editor is a lot of UI for a list most people
    // will have one entry in, and the line form is the shape an operator can
    // paste straight out of a decoded token.
    allowedClaims: claimRulesToText(o.allowedClaims),
  });
  const set = <K extends keyof typeof cfg>(k: K, v: (typeof cfg)[K]) =>
    setCfg((p) => ({ ...p, [k]: v }));

  // The client secret obeys the same round-trip rule as the LiveSync secrets, so
  // it uses the same editor and the same three-state change model. It is the one
  // field on this page where a mistake is silent: the server stores whatever
  // non-sentinel string arrives, and the failure surfaces later as the token
  // endpoint refusing every login with nothing pointing back at this save.
  const [secret, setSecret] = useState<string>(o.clientSecret ?? '');
  const [secretStored, setSecretStored] = useState(o.clientSecret === REDACTED_SECRET);
  const [secretTouched, setSecretTouched] = useState(false);
  const [secretCleared, setSecretCleared] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState(false);

  const secretChange: SecretChange = secretCleared
    ? 'clear'
    : secretTouched && secret
      ? 'set'
      : 'keep';

  const suggestedRedirectUri = ssoRedirectUri();

  /**
   * Copy the redirect URI, and say so honestly when it could not be copied.
   *
   * `navigator.clipboard` is undefined outside a secure context, which is
   * exactly the plain-http self-hosted deployment this app is built for, so a
   * button that reported success unconditionally would leave the operator
   * pasting whatever was in the clipboard before into their IdP. The value is
   * also rendered in a selectable read-only input for that reason: the button is
   * the convenience, the field is the guarantee.
   */
  const copyRedirectUri = async () => {
    setErr('');
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(suggestedRedirectUri);
      setCopied(true);
    } catch {
      setCopied(false);
      setErr('Could not reach the clipboard. Select the address above and copy it by hand.');
    }
  };

  const save = async () => {
    setErr('');
    setMsg('');
    const issuer = cfg.issuer.trim().replace(/\/+$/, '');
    const clientId = cfg.clientId.trim();
    const redirectUri = cfg.redirectUri.trim().replace(/\/+$/, '');
    const scopes = cfg.scopes.split(/\s+/).filter(Boolean);
    const allowedSubjects = splitLines(cfg.allowedSubjects);
    const allowedGroups = splitLines(cfg.allowedGroups);
    const allowedEmails = splitLines(cfg.allowedEmails).map((e) => e.toLowerCase());

    // Everything from here to the request is a user-experience affordance and
    // never the control. `assertUsableOidc` in server/src/routes/settings.ts
    // applies every one of these rules to the MERGED settings draft and is what
    // actually decides; the schema heals a hand-edited file on top of that. What
    // the local copies buy is a sentence naming the field to change, because the
    // server's 400 arrives as a paragraph under a Save button and three of these
    // four rules are counter-intuitive enough that an operator would not guess
    // which box caused it.
    if (cfg.enabled && !issuer) {
      setErr('Issuer is required when single sign-on is enabled.');
      return;
    }
    if (cfg.enabled && !clientId) {
      setErr('Client ID is required when single sign-on is enabled.');
      return;
    }
    if (redirectUri && !redirectUri.endsWith(SSO_CALLBACK_PATH)) {
      setErr(`Redirect URI must end with ${SSO_CALLBACK_PATH}, which is the path this server answers on.`);
      return;
    }
    if (!scopes.includes('openid')) {
      // The server refuses this with a 400 rather than silently adding the
      // scope, and so does this page, for the same reason: without `openid` the
      // authorization request is plain OAuth 2.0, the IdP is entitled to return
      // an access token and no id_token at all, and there is then no signed
      // subject to attach a session to. Quietly fixing it would leave the
      // operator debugging a consent screen they did not ask for.
      setErr("Scopes must include 'openid', or the identity provider is not required to say who you are.");
      return;
    }
    if (allowedGroups.length > 0 && !scopes.includes('groups')) {
      setErr(
        "Allowed groups requires the 'groups' scope: the identity provider only issues the groups " +
          'claim when it is asked for, so an allowlist of groups that are never requested can never ' +
          'match. Add groups to the scopes, or clear the group allowlist.',
      );
      return;
    }
    if (!cfg.allowPasswordLogin && !(cfg.enabled && issuer && clientId)) {
      setErr(
        'Password sign-in cannot be turned off while single sign-on is incomplete: with SSO not ' +
          'enabled, or the issuer or client ID missing, there would be no way to sign in at all, ' +
          'including the desktop app. Finish the SSO settings in this same save, or leave password ' +
          'sign-in on.',
      );
      return;
    }

    const oidc: Record<string, unknown> = {
      enabled: cfg.enabled,
      issuer,
      clientId,
      redirectUri,
      scopes,
      allowedSubjects,
      allowedGroups,
      allowedEmails,
      allowPasswordLogin: cfg.allowPasswordLogin,
      pkce: cfg.pkce,
      allowedClaims: claimRulesFromText(cfg.allowedClaims),
    };
    // 'keep' sends nothing at all. The sentinel would be ignored by the server
    // anyway, but omitting the key says what is meant and keeps the mask out of
    // the request body entirely. 'clear' sends an explicit JSON null, which is
    // the server's documented signal for "remove this" and the only thing a text
    // input cannot produce by accident.
    if (secretChange === 'set') oidc.clientSecret = secret;
    else if (secretChange === 'clear') oidc.clientSecret = null;

    try {
      await api.putSettings({ oidc });
    } catch (e) {
      setErr(apiErrorMessage(e, 'Could not save the single sign-on settings'));
      return;
    }
    // Re-derive the credential editor from what was just applied rather than
    // from a re-read: the server either applied exactly this patch or threw, so
    // a re-read cannot say anything the request did not already decide, and the
    // props this component was built from do not update in place.
    const nowStored = secretWillBeSet(secretStored, secretChange);
    setSecretStored(nowStored);
    setSecret(nowStored ? REDACTED_SECRET : '');
    setSecretTouched(false);
    setSecretCleared(false);
    reload();
    setMsg('Saved single sign-on settings');
  };

  return (
    <div>
      <h2>Single Sign-On (OIDC)</h2>
      <p style={{ color: 'var(--text-muted)' }}>
        Sign in with an OpenID Connect provider instead of the vault password. This server runs the
        authorization code flow itself and records who signed in, rather than sitting behind a proxy
        that only reports that somebody did.
      </p>
      <Row name="Enable single sign-on" desc="The login screen shows a Sign in with SSO button once this block is complete.">
        <input type="checkbox" checked={cfg.enabled} onChange={(e) => set('enabled', e.target.checked)} />
      </Row>
      <Row name="Issuer" desc="The provider's issuer identifier, e.g. https://auth.example.com. No trailing slash, no query string.">
        <input
          className="text-input"
          style={{ width: 260 }}
          value={cfg.issuer}
          onChange={(e) => set('issuer', e.target.value)}
        />
      </Row>
      <Row name="Client ID" desc="From the client you registered at the provider">
        <input
          className="text-input"
          style={{ width: 260 }}
          value={cfg.clientId}
          onChange={(e) => set('clientId', e.target.value)}
        />
      </Row>
      {/*
        The one place this page can disagree with the login screen, so it says so
        rather than leaving it to be discovered.

        The settings API accepts an empty secret (a public client authenticating
        with PKCE alone is a legitimate registration, and the schema documents it
        as such), but `isOidcAvailable()` in server/src/services/oidc.ts, which is
        what /auth/status answers and therefore what decides whether the button
        is drawn, treats a missing secret as "not configured". So a block saved
        without one is stored happily, reports no error, and produces a login
        screen with no SSO button on it: exactly the silent, self-inflicted
        failure this panel exists to prevent.
      */}
      {cfg.enabled && !secretWillBeSet(secretStored, secretChange) && (
        <div style={{ color: '#d29922', margin: '6px 0' }}>
          Single sign-on is enabled with no client secret stored. The login screen only offers the
          SSO button once a secret is saved, so add the one your provider issued for this client.
        </div>
      )}
      <SecretRow
        name="Client secret"
        desc="Stored server-side, never sent back to this page. Issued by the provider alongside the client ID."
        value={secret}
        stored={secretStored}
        cleared={secretCleared}
        onFocus={() => {
          if (secretTouched || secretCleared) return;
          setSecretTouched(true);
          setSecret('');
        }}
        onChange={setSecret}
        onToggleClear={() => {
          const next = !secretCleared;
          setSecretCleared(next);
          if (next) {
            setSecretTouched(false);
            setSecret(secretStored ? REDACTED_SECRET : '');
          }
        }}
      />
      {/*
        Shown, not described, and shown before the field that holds it. Redirect
        URI matching at an authorization server is an EXACT string comparison, so
        a difference of one character is not a near miss: the provider refuses
        the whole request before the user ever reaches a consent screen, with an
        error page that names nothing this operator can act on. It is the single
        most common OIDC setup failure, and the fix is always "copy this string
        into the provider", so the string is on screen.

        It is derived from the address this page was loaded from, because the
        server genuinely cannot know its own external origin from inside the
        process: a reverse proxy, a container port mapping and the Electron
        shell's 127.0.0.1 all disagree with what Node sees, while the browser is
        holding the address that actually reached the app.
      */}
      <Row
        name="Redirect URI to register"
        desc="Copy this into the provider's client registration, exactly. If a proxy serves this app under a sub-path, add that prefix in front of /auth."
      >
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            className="text-input"
            readOnly
            style={{ width: 260 }}
            value={suggestedRedirectUri}
            onFocus={(e) => e.currentTarget.select()}
          />
          <button className="btn secondary" style={{ padding: '2px 8px' }} onClick={copyRedirectUri}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </span>
      </Row>
      <Row
        name="Redirect URI override"
        desc={`Leave empty to use the address each request arrives on. Set it when a proxy rewrites the host or path. Must end with ${SSO_CALLBACK_PATH}.`}
      >
        <input
          className="text-input"
          style={{ width: 260 }}
          placeholder={suggestedRedirectUri}
          value={cfg.redirectUri}
          onChange={(e) => set('redirectUri', e.target.value)}
        />
      </Row>
      <Row
        name="Scopes"
        desc="Space-separated. openid is required. Add groups only if you use the group allowlist below."
      >
        <input
          className="text-input"
          style={{ width: 260 }}
          value={cfg.scopes}
          onChange={(e) => set('scopes', e.target.value)}
        />
      </Row>
      {/*
        The allowlists are the boundary, and their empty state is the opposite of
        the intuitive one, so it is stated on screen rather than left in a
        comment. On a single-account homelab provider, empty is exactly right and
        an allowlist would be busywork. On anything shared (a work SSO, a family
        instance, a provider with self-registration) empty means every account in
        the directory can sign in as the owner of this vault, with full read and
        write over every note.
      */}
      <Row
        name="Allowed subjects"
        desc="One per line. Empty means any account the provider will authenticate. Subjects are opaque and case-sensitive, but never reassigned to a different person."
      >
        <textarea
          className="text-input"
          rows={3}
          style={{ width: 260, resize: 'vertical', fontFamily: 'var(--font-monospace, monospace)' }}
          value={cfg.allowedSubjects}
          onChange={(e) => set('allowedSubjects', e.target.value)}
        />
      </Row>
      <Row
        name="Allowed groups"
        desc="One per line. Empty means no group restriction. Needs the groups scope above, and puts the membership decision in the provider where it belongs."
      >
        <textarea
          className="text-input"
          rows={3}
          style={{ width: 260, resize: 'vertical', fontFamily: 'var(--font-monospace, monospace)' }}
          value={cfg.allowedGroups}
          onChange={(e) => set('allowedGroups', e.target.value)}
        />
      </Row>
      {/*
        The weakest of the fixed axes, and labelled as such rather than left for
        the operator to work out. Addresses get recycled when a person leaves,
        and at a provider that allows self-service address changes they can be
        claimed outright, so an entry here only matches when the provider says
        email_verified is true. Prefer groups or subjects where either will do.
      */}
      <Row
        name="Allowed emails"
        desc="One per line, matched case-insensitively. Only counts when the provider marks the address verified. The weakest axis: addresses get reassigned, subjects never do."
      >
        <textarea
          className="text-input"
          rows={3}
          style={{ width: 260, resize: 'vertical', fontFamily: 'var(--font-monospace, monospace)' }}
          value={cfg.allowedEmails}
          onChange={(e) => set('allowedEmails', e.target.value)}
        />
      </Row>
      {/*
        The escape hatch from the four fixed axes, and the reason it exists is
        that standardised claims are not what most providers key identity on. A
        real Pocket ID token carries preferred_username, nextcloud_username and
        portainer_username side by side, because it lets you define custom claims
        per client, and only you know which one means "the user here".
      */}
      <Row
        name="Allowed claims"
        desc="One `claim = value` per line, e.g. preferred_username = addie. Repeat a claim name to allow several values. Matches alongside the lists above: any one entry anywhere is enough."
      >
        <textarea
          className="text-input"
          rows={3}
          placeholder="preferred_username = addie"
          style={{ width: 260, resize: 'vertical', fontFamily: 'var(--font-monospace, monospace)' }}
          value={cfg.allowedClaims}
          onChange={(e) => set('allowedClaims', e.target.value)}
        />
      </Row>
      {/*
        Default on, and the default is a compatibility requirement rather than a
        preference. The Electron desktop shell starts the server itself and logs
        in with no human present: it injects a shared secret as
        WEBOBSIDIAN_PASSWORD and posts it to /auth/login on startup. That path
        has no browser to send to a provider and no way to complete an
        authorization code flow, so turning this off does not harden the desktop
        app, it bricks it. The same is true of any script that signs in with the
        owner password.
      */}
      <Row
        name="Allow password sign-in"
        desc="Keep the password form working alongside SSO. Turning it off breaks the desktop app and any script that signs in with the owner password."
      >
        <input
          type="checkbox"
          checked={cfg.allowPasswordLogin}
          onChange={(e) => set('allowPasswordLogin', e.target.checked)}
        />
      </Row>
      {/*
        Exposed rather than hardcoded because both hardcodings are wrong for
        somebody. Always-on locks out a provider that rejects the parameter, with
        no recourse; always-off is a silent downgrade. 'Automatic' is the answer
        for every provider we know of, including the awkward case it was written
        for: Pocket ID supports S256 per client but omits
        code_challenge_methods_supported from its discovery document, so reading
        that metadata strictly would quietly turn PKCE off on a deployment where
        it works. Automatic treats silence as consent and only stands down when
        the provider publishes a method list that excludes S256.
      */}
      <Row
        name="PKCE"
        desc="Proof Key for Code Exchange. Leave on Automatic unless a provider rejects the challenge outright; the server logs which branch it took, so this is never a silent guess."
      >
        <select
          className="text-input"
          style={{ width: 260 }}
          value={cfg.pkce}
          onChange={(e) => set('pkce', e.target.value as 'auto' | 'force' | 'off')}
        >
          <option value="auto">Automatic (recommended)</option>
          <option value="force">Always send</option>
          <option value="off">Never send</option>
        </select>
      </Row>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn" onClick={save}>Save</button>
      </div>
      {err && <div style={{ color: '#e5534b', margin: '6px 0' }}>{err}</div>}
      {msg && <div style={{ color: 'var(--text-accent, #4caf50)', margin: '6px 0' }}>{msg}</div>}
      <p style={{ color: 'var(--text-faint)', fontSize: 12, marginTop: 16 }}>
        A failed sign-in returns to the login screen with a short reason. The full detail, including
        the issuer and anything the provider said, stays in the server log: an unauthenticated
        visitor can start this flow, so nothing beyond that reason is shown in the browser.
      </p>
    </div>
  );
}

function ApiKeys() {
  const [keys, setKeys] = useState<any[]>([]);
  const [name, setName] = useState('my-agent');
  const [scopes, setScopes] = useState<string[]>(['read', 'search']);
  const [created, setCreated] = useState('');
  const [err, setErr] = useState('');
  const load = () => api.listKeys().then((r) => setKeys(r.keys)).catch(() => {});
  useEffect(() => { load(); }, []);
  const toggle = (sc: string) => setScopes((p) => (p.includes(sc) ? p.filter((x) => x !== sc) : [...p, sc]));
  // A failed create must not leave the previous key's raw value on screen under a
  // button the user just pressed: they would copy a string that is not the key
  // they think they just made. Clearing first, then surfacing the error, is the
  // only ordering that cannot mislead.
  const create = async () => {
    setErr('');
    setCreated('');
    try {
      const r = await api.createKey(name, scopes);
      setCreated(r.key);
    } catch (e) {
      setErr(apiErrorMessage(e, 'Could not create the key'));
      return;
    }
    await load();
  };
  const revoke = async (id: string) => {
    setErr('');
    try {
      await api.revokeKey(id);
    } catch (e) {
      setErr(apiErrorMessage(e, 'Could not revoke the key'));
      return;
    }
    load();
  };
  return (
    <div>
      <h2>API Keys</h2>
      <p style={{ color: 'var(--text-muted)' }}>Keys let AI agents call <code>/api/v1</code>. The raw key is shown once.</p>
      <Row name="Name"><input className="text-input" value={name} onChange={(e) => setName(e.target.value)} /></Row>
      <Row name="Scopes">
        <span>
          {['read', 'write', 'search'].map((sc) => (
            <label key={sc} style={{ marginRight: 10 }}>
              <input type="checkbox" checked={scopes.includes(sc)} onChange={() => toggle(sc)} /> {sc}
            </label>
          ))}
        </span>
      </Row>
      <button className="btn" onClick={create}>Create key</button>
      {err && <div style={{ color: '#e5534b', margin: '6px 0' }}>{err}</div>}
      {created && (
        <pre style={{ background: 'var(--bg-primary)', padding: 10, borderRadius: 6, marginTop: 10, wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
          {created}
          {'\n'}⚠ Copy now: it will not be shown again.
        </pre>
      )}
      <div style={{ marginTop: 16 }}>
        {keys.map((k) => (
          <div className="setting-row" key={k.id}>
            <div className="info">
              <div className="name">{k.name} <span style={{ color: 'var(--text-faint)' }}>{k.prefix}…</span></div>
              <div className="desc">scopes: {k.scopes.join(', ')} · used: {k.lastUsed ?? 'never'}</div>
            </div>
            <button className="btn danger" onClick={() => revoke(k.id)}>Revoke</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Shares() {
  const notify = useStore((s) => s.notify);
  const openFile = useStore((s) => s.openFile);
  const setOpen = useStore((s) => s.setSettings);
  // Shared with the store so the file tree's globe badges refresh on changes.
  const shares = useStore((s) => s.shares);
  const load = useStore((s) => s.loadShares);
  const [query, setQuery] = useState('');
  useEffect(() => { load(); }, [load]);

  const url = (id: string) => `${location.origin}/share/${id}`;
  const copy = (id: string) => {
    navigator.clipboard?.writeText(url(id)).catch(() => {});
    notify('Public link copied');
  };
  // Same reasoning as ShareDialog.tsx, and the same three operations: `req()`
  // throws on any non-OK status, nothing in web/src catches an unhandled
  // rejection, so an unwrapped call turns a server refusal into a button that
  // does nothing at all. This panel and the per-note dialog are two entry points
  // onto one endpoint, so they have to agree: fixing only one of them leaves the
  // same silent failure one click away.
  const toggle = async (s: any) => {
    try {
      await api.setShareEnabled(s.id, !s.enabled);
    } catch (e) {
      notify(apiErrorMessage(e, 'Could not change the public link'));
      return;
    }
    load();
  };
  const remove = async (s: any) => {
    if (!confirm(`Delete the public link for "${s.path}"? The URL stops working permanently.`)) return;
    try {
      await api.deleteShare(s.id);
    } catch (e) {
      notify(apiErrorMessage(e, 'Could not delete the public link'));
      return;
    }
    load();
  };
  const setPassword = async (s: any) => {
    const pw = prompt(
      (s.hasPassword
        ? 'New password for this link (leave empty to REMOVE the password):'
        : 'Password for this link:') + `\nAt least ${MIN_PASSWORD_LEN} characters.`,
    );
    if (pw === null) return;
    // UX affordance, not the security boundary: PATCH /api/shares/:id applies
    // the identical rule and is what actually decides. Checking here only means
    // the user is told the rule instead of watching the dialog close and nothing
    // change. An empty string is not "too short", it is the documented way to
    // remove the password, which is why sharePasswordError() exempts it.
    const invalid = sharePasswordError(pw);
    if (invalid) {
      notify(invalid);
      return;
    }
    try {
      await api.setSharePassword(s.id, pw || null);
    } catch (e) {
      notify(apiErrorMessage(e, 'Could not set the password'));
      return;
    }
    notify(pw ? 'Password set' : 'Password removed');
    load();
  };

  const q = query.trim().toLowerCase();
  const filtered = q ? shares.filter((s) => s.path.toLowerCase().includes(q)) : shares;

  return (
    <div>
      <h2>Sharing</h2>
      <p style={{ color: 'var(--text-muted)' }}>
        Notes shared via a public link are readable by <b>anyone with the URL</b>, without login.
        Create a link from a note's context menu ("Share…"). Disable keeps the URL for
        re-enabling later; delete revokes it permanently.
      </p>
      <input
        className="text-input"
        style={{ width: '100%', margin: '6px 0 12px' }}
        placeholder="Search shared notes…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {filtered.length === 0 && (
        <div style={{ color: 'var(--text-faint)' }}>
          {shares.length === 0 ? 'No notes are shared publicly.' : 'No shared note matches the search.'}
        </div>
      )}
      {filtered.map((s) => (
        <div className="setting-row" key={s.id}>
          <div className="info" style={{ minWidth: 0 }}>
            <div
              className="name"
              style={{ cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: s.enabled ? 1 : 0.55 }}
              title={`Open ${s.path}`}
              onClick={() => { openFile(s.path); setOpen(false); }}
            >
              {s.path}
            </div>
            <div className="desc">
              {s.enabled ? 'active' : 'disabled'}
              {s.hasPassword ? ' · password-protected' : ''} · created {new Date(s.createdAt).toLocaleDateString()}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
            <button className="btn secondary" disabled={!s.enabled} onClick={() => copy(s.id)} title={url(s.id)}>
              <Icon name="link" size={14} /> Copy link
            </button>
            <button className="btn secondary" onClick={() => setPassword(s)} title={s.hasPassword ? 'Change or remove password' : 'Require a password to open the link'}>
              {s.hasPassword ? 'Password ✓' : 'Password…'}
            </button>
            <button className={`btn ${s.enabled ? 'secondary' : ''}`} onClick={() => toggle(s)}>
              {s.enabled ? 'Disable' : 'Enable'}
            </button>
            <button className="btn danger" onClick={() => remove(s)}>Delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Plugins() {
  const [plugins, setPlugins] = useState<any[]>([]);
  const [repo, setRepo] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api.listPlugins().then((r) => setPlugins(r.plugins)).catch(() => {});
  useEffect(() => { load(); }, []);
  const install = async () => {
    setMsg('Installing…');
    try { await api.installPlugin(repo); setMsg('Installed ✓'); setRepo(''); await load(); }
    catch (e) { setMsg(`Error: ${apiErrorMessage(e, 'Could not install the plugin')}`); }
  };
  // The checkbox was the last unwrapped call in this panel. A rejected toggle
  // used to leave the box rendered in its new position (React re-renders from
  // `plugins`, which load() never refreshed) while the plugin's real state was
  // unchanged: the UI then disagreed with the server about whether a plugin was
  // running, which is exactly the kind of quiet lie that gets debugged as a
  // server bug. load() runs on both paths so the rendered state comes back from
  // the server either way.
  const setEnabled = async (id: string, enabled: boolean) => {
    setMsg('');
    try {
      await api.setPluginEnabled(id, enabled);
    } catch (e) {
      setMsg(`Error: ${apiErrorMessage(e, 'Could not change the plugin')}`);
    }
    await load();
  };
  return (
    <div>
      <h2>Community Plugins</h2>
      <Row name="Install from GitHub" desc="owner/repo: pulls manifest.json + main.js from latest release">
        <span style={{ display: 'flex', gap: 8 }}>
          <input className="text-input" placeholder="blacksmithgu/obsidian-dataview" value={repo} onChange={(e) => setRepo(e.target.value)} />
          <button className="btn" onClick={install}>Install</button>
        </span>
      </Row>
      {msg && <div style={{ color: 'var(--text-muted)', margin: '6px 0' }}>{msg}</div>}
      <div style={{ marginTop: 12 }}>
        {plugins.length === 0 && <div style={{ color: 'var(--text-faint)' }}>No plugins installed in .obsidian/plugins</div>}
        {plugins.map((p) => (
          <div className="setting-row" key={p.id}>
            <div className="info">
              <div className="name">{p.name} <span style={{ color: 'var(--text-faint)' }}>v{p.version}</span></div>
              <div className="desc">{p.description}</div>
            </div>
            <label>
              <input type="checkbox" checked={p.enabled} onChange={(e) => setEnabled(p.id, e.target.checked)} /> enabled
            </label>
          </div>
        ))}
      </div>
      <p style={{ color: 'var(--text-faint)', fontSize: 12, marginTop: 14 }}>
        Note: WebObsidian supports a subset of the Obsidian plugin API. Most metadata/markdown plugins work; plugins relying on Electron/Node internals may not.
      </p>
    </div>
  );
}

function Appearance({ s }: { s: any }) {
  const [theme, setTheme] = useState(s.ui.theme);
  const [err, setErr] = useState('');
  // location.reload() only on success. Reloading after a rejected save is the
  // worst of both: the page comes back showing the OLD theme with no error
  // anywhere, so the control looks like it silently reverted itself rather than
  // like the request failed. On failure the select is put back instead, so what
  // is shown still matches what is stored.
  const save = async (t: string) => {
    const previous = theme;
    setErr('');
    setTheme(t);
    try {
      await api.putSettings({ ui: { theme: t } });
    } catch (e) {
      setTheme(previous);
      setErr(apiErrorMessage(e, 'Could not save the theme'));
      return;
    }
    location.reload();
  };
  return (
    <div>
      <h2>Appearance</h2>
      <Row name="Theme">
        <select className="text-input" value={theme} onChange={(e) => save(e.target.value)}>
          <option value="obsidian-dark">Obsidian Dark</option>
          <option value="obsidian-light">Obsidian Light</option>
        </select>
      </Row>
      {err && <div style={{ color: '#e5534b', margin: '6px 0' }}>{err}</div>}
    </div>
  );
}

function AccountSettings({ s, reload }: { s: any; reload: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const usingDefault = !s?.auth?.hasCustomPassword;

  const save = async () => {
    setErr('');
    setMsg('');
    // Worded from the shared constant rather than from a literal 6. This check
    // was already here and already correct; what it was not was tied to the
    // server's rule, so a future change to MIN_PASSWORD_LEN in
    // server/src/services/auth.ts would have left this branch quietly claiming
    // the old number. As everywhere else on this surface, the server re-checks
    // (routes/auth.ts and setUserPassword both do) and remains the gate: this
    // only saves a round trip and states the rule where the user is typing.
    if (next.length < MIN_PASSWORD_LEN) {
      setErr(`New password must be at least ${MIN_PASSWORD_LEN} characters`);
      return;
    }
    if (next !== confirm) {
      setErr('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setMsg('Password changed ✓');
      setCurrent('');
      setNext('');
      setConfirm('');
      await reload();
    } catch (e) {
      // The server's own string is worth showing verbatim here: it distinguishes
      // "Current password is incorrect" (401) from the length 400, and those are
      // two very different things for the user to do next.
      setErr(apiErrorMessage(e, 'Failed to change password'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h2>Account</h2>
      <p style={{ color: 'var(--text-muted)' }}>
        The password you sign in to WebObsidian with.
        {usingDefault && (
          <>
            {' '}You are still using the <b>default password <code>123456</code></b>. Change it to
            secure your vault.
          </>
        )}
      </p>
      <Row name="Current password" desc={usingDefault ? 'The default is 123456' : undefined}>
        <input className="text-input" type="password" style={{ width: 240 }} value={current}
          onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
      </Row>
      <Row name="New password" desc={`At least ${MIN_PASSWORD_LEN} characters`}>
        <input className="text-input" type="password" style={{ width: 240 }} value={next}
          onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
      </Row>
      <Row name="Confirm new password">
        <input className="text-input" type="password" style={{ width: 240 }} value={confirm}
          onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
      </Row>
      {err && <div style={{ color: '#e5534b', margin: '6px 0' }}>{err}</div>}
      {msg && <div style={{ color: 'var(--text-accent, #4caf50)', margin: '6px 0' }}>{msg}</div>}
      <button className="btn" onClick={save} disabled={busy || !current || !next}>
        {busy ? 'Saving…' : 'Change password'}
      </button>
      <p style={{ color: 'var(--text-faint)', fontSize: 12, marginTop: 16 }}>
        Forgot your password? Set <code>auth.passwordHash</code> in <code>data/settings.json</code>, or
        the <code>WEBOBSIDIAN_PASSWORD</code> environment variable, as a recovery password (it
        overrides the stored one), then sign in again to set a new one.
      </p>
      {/*
        Guarded on the data being present rather than rendered unconditionally.
        AccountSettings is mounted without the `settings &&` guard its siblings
        have, so `s` can legitimately be null here, and the child below seeds
        useState from its props exactly once: mounting it early would freeze four
        empty boxes that never pick up the loaded values.
      */}
      {s?.auth?.rateLimit && <LoginRateLimitSettings s={s} reload={reload} />}
    </div>
  );
}

/**
 * The login throttle, on the Account panel rather than anywhere else.
 *
 * WHY HERE. It governs the password door and only that door: the server mounts
 * these limiters on `POST /auth/login` alone, and the single sign-on endpoints
 * carry their own separate budget that is deliberately not exposed. Account is
 * the panel about the password a person signs in with, so the limit on how often
 * they may try it is the same subject one paragraph later. The SSO panel would be
 * actively misleading: an operator reading these numbers there would reasonably
 * conclude they throttle the SSO button, and they do not.
 *
 * WHY IT IS CONFIGURABLE. The shipped numbers are sensible and are still wrong
 * for somebody. A single-user instance behind a VPN wants them loose; a public
 * instance wants them tight; an operator running a script that signs in
 * repeatedly trips the network-keyed layer with nothing to do about it. That was
 * previously a source edit.
 *
 * The two layers are presented as two groups rather than flattened into four
 * boxes, because the difference between them decides which one an operator
 * should be reaching for and it is not guessable from the field names. Layer 1
 * charges EVERY attempt against the caller's network address, which behind a
 * reverse proxy is usually one shared bucket for the whole instance. Layer 2
 * charges only FAILED attempts against the account, and a correct password wipes
 * the counter, which is what stops a stranger's guessing from locking the owner
 * out.
 */
function LoginRateLimitSettings({ s, reload }: { s: any; reload: () => void }) {
  const stored = s.auth.rateLimit;
  const [cfg, setCfg] = useState({
    loginWindowSec: Number(stored.loginWindowSec),
    loginMaxAttempts: Number(stored.loginMaxAttempts),
    loginFailureWindowSec: Number(stored.loginFailureWindowSec),
    loginFailureMaxAttempts: Number(stored.loginFailureMaxAttempts),
  });
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof cfg, v: string) =>
    // parseInt rather than Number, so that clearing the box gives NaN (which the
    // validator names as "must be a whole number") instead of Number('') === 0,
    // which is the one value in this whole panel that would lock the instance and
    // which would otherwise sail through looking deliberate.
    setCfg((p) => ({ ...p, [k]: parseInt(v, 10) }));

  const b = LOGIN_RATE_LIMIT_BOUNDS;

  const save = async () => {
    setErr('');
    setMsg('');
    // Every check below is a user-experience affordance and never the control.
    // `sanitizeAuth` in server/src/routes/settings.ts applies the same four
    // bounds and is what actually decides; the schema heals a hand-edited file on
    // top of that. What the local copies buy is a sentence naming the box to fix,
    // because the server's 400 arrives phrased in JSON keys.
    const problems = [
      loginLimitError('Attempt window', cfg.loginWindowSec, b.minWindowSec, b.maxWindowSec),
      loginLimitError('Attempts allowed', cfg.loginMaxAttempts, b.minAttempts, b.maxAttempts),
      loginLimitError('Failure window', cfg.loginFailureWindowSec, b.minWindowSec, b.maxWindowSec),
      loginLimitError(
        'Failures allowed',
        cfg.loginFailureMaxAttempts,
        b.minAttempts,
        b.maxAttempts,
      ),
    ].filter(Boolean);
    if (problems.length > 0) {
      setErr(problems[0] as string);
      return;
    }
    setBusy(true);
    try {
      await api.putSettings({ auth: { rateLimit: cfg } });
      setMsg('Saved sign-in limits. They apply to the next attempt: no restart needed.');
      await reload();
    } catch (e) {
      setErr(apiErrorMessage(e, 'Could not save the sign-in limits'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 24, borderTop: '1px solid var(--bg-modifier-border)', paddingTop: 16 }}>
      <h3>Sign-in limits</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        How often the password form may be tried before it starts refusing. These govern password
        sign-in only; single sign-on has its own separate budget.
      </p>
      {/*
        The warning is not decoration. A cap of zero is not "unlimited", it refuses
        the very first attempt, and the page that undoes it is behind the sign-in
        it just closed. The server refuses anything under the floor outright, so
        this explains the refusal the operator is about to meet rather than
        standing in for it.
      */}
      <p style={{ color: '#d29922', fontSize: 12 }}>
        Setting these too low locks you out of your own vault, and the only way back is editing{' '}
        <code>data/settings.json</code> on the server by hand: the limit is checked before your
        password is, so the recovery password does not get you past it. The minimum accepted is{' '}
        {b.minAttempts} attempts, which leaves room for one typo, one success, and one other client
        (a second tab, or the desktop app signing itself in).
      </p>
      <Row
        name="Attempts allowed"
        desc={`Every attempt counts, right or wrong, and behind a reverse proxy this is usually one shared budget for everyone. Default 10, minimum ${b.minAttempts}.`}
      >
        <input
          className="text-input"
          type="number"
          min={b.minAttempts}
          max={b.maxAttempts}
          style={{ width: 120 }}
          value={Number.isInteger(cfg.loginMaxAttempts) ? cfg.loginMaxAttempts : ''}
          onChange={(e) => set('loginMaxAttempts', e.target.value)}
        />
      </Row>
      <Row
        name="Attempt window (seconds)"
        desc={`How long an attempt is remembered for. Default 900 (15 minutes), maximum ${b.maxWindowSec} (24 hours): past a day a throttle stops being a pause and becomes an outage.`}
      >
        <input
          className="text-input"
          type="number"
          min={b.minWindowSec}
          max={b.maxWindowSec}
          style={{ width: 120 }}
          value={Number.isInteger(cfg.loginWindowSec) ? cfg.loginWindowSec : ''}
          onChange={(e) => set('loginWindowSec', e.target.value)}
        />
      </Row>
      <Row
        name="Failures allowed"
        desc={`Wrong passwords only, counted against this account. A correct password clears the count immediately, so you can always get in even while someone else is guessing. Default 25, minimum ${b.minAttempts}.`}
      >
        <input
          className="text-input"
          type="number"
          min={b.minAttempts}
          max={b.maxAttempts}
          style={{ width: 120 }}
          value={Number.isInteger(cfg.loginFailureMaxAttempts) ? cfg.loginFailureMaxAttempts : ''}
          onChange={(e) => set('loginFailureMaxAttempts', e.target.value)}
        />
      </Row>
      <Row
        name="Failure window (seconds)"
        desc={`How long a failed attempt is held against the account. Default 900 (15 minutes).`}
      >
        <input
          className="text-input"
          type="number"
          min={b.minWindowSec}
          max={b.maxWindowSec}
          style={{ width: 120 }}
          value={Number.isInteger(cfg.loginFailureWindowSec) ? cfg.loginFailureWindowSec : ''}
          onChange={(e) => set('loginFailureWindowSec', e.target.value)}
        />
      </Row>
      {err && <div style={{ color: '#e5534b', margin: '6px 0' }}>{err}</div>}
      {msg && <div style={{ color: 'var(--text-accent, #4caf50)', margin: '6px 0' }}>{msg}</div>}
      <button className="btn" onClick={save} disabled={busy}>
        {busy ? 'Saving…' : 'Save sign-in limits'}
      </button>
    </div>
  );
}

function About() {
  const [err, setErr] = useState('');
  // Deliberately does NOT reload when the request fails. The session cookie is
  // cleared server-side by POST /auth/logout, so reloading after a failed call
  // would drop the user back into a fully authenticated app with no explanation:
  // they would believe they had logged out on a machine where they had not.
  // Telling them it failed, and leaving them signed in visibly, is the only
  // honest outcome.
  const logout = async () => {
    setErr('');
    try {
      await api.logout();
    } catch (e) {
      setErr(`${apiErrorMessage(e, 'Could not log out')}. You are still signed in.`);
      return;
    }
    location.reload();
  };
  return (
    <div>
      <h2>About WebObsidian</h2>
      <p style={{ color: 'var(--text-muted)' }}>
        A self-hosted, Obsidian-compatible web app. Vault, QMD search, GitHub sync (with LFS),
        agent API and community plugins.
      </p>
      <button className="btn danger" onClick={logout}>Log out</button>
      {err && <div style={{ color: '#e5534b', margin: '6px 0' }}>{err}</div>}
    </div>
  );
}
