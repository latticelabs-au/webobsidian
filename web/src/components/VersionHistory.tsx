import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { useEscapeToClose } from '../lib/useEscapeToClose';
import { api, type GitCommit } from '../lib/api';
import Icon from './Icon';

/** Git-backed version history for a single note (PRD FR-4 / FR-7). Lists the
 *  commits that touched the file and lets you preview/restore an older version. */
export default function VersionHistory() {
  const path = useStore((s) => s.versionHistoryPath);
  const close = useStore((s) => s.setVersionHistory);
  const notify = useStore((s) => s.notify);
  const openFile = useStore((s) => s.openFile);
  const activePath = useStore((s) => s.activePath);

  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!path) return;
    setLoading(true);
    setError('');
    setSelected(null);
    setPreview('');
    api
      .gitLog(path)
      .then((r) => {
        setCommits(r.commits);
        if (r.commits[0]) setSelected(r.commits[0].hash);
      })
      .catch((e) => setError(e.message || 'Failed to load history'))
      .finally(() => setLoading(false));
  }, [path]);

  useEffect(() => {
    if (!path || !selected) return;
    api
      .gitShow(selected, path)
      .then((r) => setPreview(r.content))
      .catch(() => setPreview('(could not load this version)'));
  }, [path, selected]);

  /*
   * Escape closes, the keyboard half of the mobile dead-end fix. The narrow
   * screen media query promotes .version-history to `position: fixed; inset: 0`,
   * which covers the .modal-bg backdrop completely, so the click-outside
   * dismissal every other dialog leans on simply does not exist on a phone.
   * Touch is already covered here, unlike Settings was: both the header ✕ and
   * the footer "Close" sit in non-scrolling flex children of the modal
   * (.vh-body is the only `flex: 1` child and owns all the scrolling), so
   * neither control can be scrolled out of reach at any viewport height. No
   * third close control is added for that reason. What was missing was Escape,
   * which Settings, the command palette and the context menu all honour.
   *
   * Via the shared hook rather than a local window listener, so that Escape
   * dismisses only the topmost dialog. See lib/useEscapeToClose.ts.
   */
  useEscapeToClose(Boolean(path), () => close(null));

  if (!path) return null;

  const restore = async () => {
    if (!selected) return;
    if (!confirm('Restore this version? The current content will be overwritten.')) return;
    try {
      await api.write(path, preview);
      if (path === activePath) await openFile(path);
      notify('Restored earlier version');
      close(null);
    } catch (e: any) {
      notify(e.message || 'Restore failed');
    }
  };

  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleString();
  };

  return (
    <div className="modal-bg" onClick={() => close(null)}>
      <div className="modal version-history" onClick={(e) => e.stopPropagation()}>
        <div className="vh-head">
          <Icon name="clock" size={16} />
          <div className="vh-title">Version history</div>
          <div className="vh-path">{path}</div>
          <button
            className="tool-btn"
            onClick={() => close(null)}
            aria-label="Close version history"
            title="Close version history (Esc)"
          >
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="vh-body">
          <div className="vh-list">
            {loading && <div className="vh-empty">Loading…</div>}
            {error && <div className="vh-empty">{error}</div>}
            {!loading && !error && commits.length === 0 && (
              <div className="vh-empty">No history. Enable Git Sync to track versions.</div>
            )}
            {commits.map((c, i) => (
              <div
                key={c.hash}
                className={`vh-item ${selected === c.hash ? 'active' : ''}`}
                onClick={() => setSelected(c.hash)}
              >
                <div className="vh-item-msg">
                  {i === 0 ? 'Latest' : c.message || '(no message)'}
                </div>
                <div className="vh-item-meta">
                  {fmtDate(c.date)} · {c.author}
                </div>
              </div>
            ))}
          </div>
          <div className="vh-preview">
            <pre>{preview}</pre>
          </div>
        </div>
        <div className="vh-foot">
          <button className="btn secondary" onClick={() => close(null)}>
            Close
          </button>
          <button className="btn" onClick={restore} disabled={!selected || commits.length === 0}>
            Restore this version
          </button>
        </div>
      </div>
    </div>
  );
}
