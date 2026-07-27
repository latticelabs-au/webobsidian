import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import {
  api,
  apiErrorMessage,
  sharePasswordError,
  vaultPathError,
  MIN_PASSWORD_LEN,
} from '../lib/api';
import Icon from './Icon';

type Section = 'vault' | 'git' | 'api' | 'sharing' | 'plugins' | 'appearance' | 'account' | 'about';

export default function Settings() {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettings);
  const [section, setSection] = useState<Section>('vault');
  const [settings, setSettings] = useState<any>(null);

  useEffect(() => {
    if (open) api.getSettings().then(setSettings).catch(() => {});
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-bg" onClick={() => setOpen(false)}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-layout">
          <div className="settings-nav">
            {(['vault', 'git', 'api', 'sharing', 'plugins', 'appearance', 'account', 'about'] as Section[]).map((s) => (
              <button key={s} className={section === s ? 'active' : ''} onClick={() => setSection(s)}>
                {labels[s]}
              </button>
            ))}
          </div>
          <div className="settings-content">
            {settings && section === 'vault' && <VaultSettings s={settings} reload={() => api.getSettings().then(setSettings)} />}
            {settings && section === 'git' && <GitSettings s={settings} reload={() => api.getSettings().then(setSettings)} />}
            {section === 'api' && <ApiKeys />}
            {section === 'sharing' && <Shares />}
            {section === 'plugins' && <Plugins />}
            {settings && section === 'appearance' && <Appearance s={settings} />}
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
  api: 'API Keys',
  sharing: 'Sharing',
  plugins: 'Community Plugins',
  appearance: 'Appearance',
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
