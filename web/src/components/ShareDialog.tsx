import { useEffect } from 'react';
import { useStore } from '../lib/store';
import { useEscapeToClose } from '../lib/useEscapeToClose';
import { api, apiErrorMessage, sharePasswordError, MIN_PASSWORD_LEN } from '../lib/api';
import Icon from './Icon';

/**
 * Per-note share settings popup (FR-10), opened from the file-tree context
 * menu ("Share…"). Create/copy the public URL, toggle it on/off, manage the
 * password, or delete the link. The centralized list lives in Settings → Sharing.
 */
export default function ShareDialog() {
  const path = useStore((s) => s.shareDialogPath);
  const setShareDialog = useStore((s) => s.setShareDialog);
  const shares = useStore((s) => s.shares);
  const loadShares = useStore((s) => s.loadShares);
  const notify = useStore((s) => s.notify);

  useEffect(() => {
    if (path) loadShares();
  }, [path, loadShares]);

  /*
   * Escape closes, and the header ✕ added below is the touch half of the same
   * fix. "Done" in the footer used to be the only in-dialog way out, and it is
   * not reliably reachable: .modal is `overflow: hidden` with `max-height:
   * 70vh` and this dialog puts its rows straight into that flex column with no
   * scroll container, so anything past 70vh is clipped with no way to scroll it
   * back. On a short phone the head plus three stacked .setting-row blocks
   * (the media query turns each into a two-line column) plus a long path that
   * wraps over several lines already gets close to that, and the first thing
   * off the bottom edge is the footer. Tapping the backdrop still worked, but
   * that leaves ~12px of exposed .modal-bg either side on a phone, which is not
   * a control anybody should have to find.
   *
   * Via the shared hook rather than a local window listener: every dialog owning
   * its own listener meant one Escape dismissed all of them at once, so opening
   * the command palette over this dialog and backing out of the palette closed
   * this too. See lib/useEscapeToClose.ts.
   */
  useEscapeToClose(Boolean(path), () => setShareDialog(null));

  if (!path) return null;
  const close = () => setShareDialog(null);
  const share = shares.find((s) => s.path === path) ?? null;
  const url = share ? `${location.origin}/share/${share.id}` : '';

  // Every call below is wrapped, and that is the point rather than tidiness.
  // `api.req()` throws on any non-OK status and there is no error boundary and no
  // unhandledrejection handler anywhere in web/src, so a bare `await api.x()`
  // turns a 400/403/404/500 into literally nothing: the toast never fires, the
  // share list never reloads, and the button reads as broken. Every one of these
  // endpoints has a reachable failure (the note was renamed out from under an
  // open dialog, the session expired, the password was refused), so silence is
  // the normal case, not the exotic one.
  const create = async () => {
    try {
      await api.createShare(path);
    } catch (e) {
      notify(apiErrorMessage(e, 'Could not create the public link'));
      return;
    }
    await loadShares();
    notify('Public link created');
  };
  const toggle = async () => {
    if (!share) return;
    try {
      await api.setShareEnabled(share.id, !share.enabled);
    } catch (e) {
      notify(apiErrorMessage(e, 'Could not change the public link'));
      return;
    }
    await loadShares();
  };
  const copy = () => {
    navigator.clipboard?.writeText(url).catch(() => {});
    notify('Public link copied');
  };
  const password = async () => {
    if (!share) return;
    const pw = prompt(
      (share.hasPassword
        ? 'New password for this link (leave empty to REMOVE the password):'
        : 'Password for this link:') + `\nAt least ${MIN_PASSWORD_LEN} characters.`,
    );
    if (pw === null) return;
    // Client-side length check, stated plainly: this is a UX affordance, NOT the
    // security boundary. PATCH /api/shares/:id applies the same rule server-side
    // and is the only thing that decides; this exists so that a password the
    // server will refuse is refused here, with the reason, instead of vanishing
    // into an unhandled rejection. The prompt above carries the minimum too, so
    // reaching this branch should be rare.
    const invalid = sharePasswordError(pw);
    if (invalid) {
      notify(invalid);
      return;
    }
    try {
      await api.setSharePassword(share.id, pw || null);
    } catch (e) {
      notify(apiErrorMessage(e, 'Could not set the password'));
      return;
    }
    await loadShares();
    notify(pw ? 'Password set' : 'Password removed');
  };
  const remove = async () => {
    if (!share) return;
    if (!confirm('Delete this public link? The URL stops working permanently.')) return;
    try {
      await api.deleteShare(share.id);
    } catch (e) {
      notify(apiErrorMessage(e, 'Could not delete the public link'));
      return;
    }
    await loadShares();
    notify('Public link deleted');
  };

  return (
    <div className="modal-bg" onClick={close}>
      <div className="modal share-dialog" onClick={(e) => e.stopPropagation()}>
        {/*
          The head is pinned (`flex-shrink: 0`) and carries the close control,
          so the one way out of this dialog sits in the one element that is
          always on screen. Everything that can grow with the vault (the path,
          the share rows) is inside .share-dialog-body, which is the only part
          that scrolls.
        */}
        <div className="share-dialog-head">
          <Icon name="globe" size={18} />
          <div className="share-dialog-heading">
            <div className="share-dialog-title">{/\.canvas$/i.test(path) ? 'Share canvas' : 'Share note'}</div>
            <div className="share-dialog-path">{path}</div>
          </div>
          <button
            className="tool-btn"
            onClick={close}
            aria-label="Close share dialog"
            title="Close share dialog (Esc)"
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="share-dialog-body">
          {!share && (
            <>
              <p className="share-dialog-hint">
                Create a public link so <b>anyone with the URL</b> can read this note without login.
              </p>
              <button className="btn" onClick={create}>
                <Icon name="globe" size={14} /> Create public link
              </button>
            </>
          )}

          {share && (
            <>
              <div className="setting-row">
                <div className="info">
                  <div className="name">Public link</div>
                  <div className="desc">{share.enabled ? 'Anyone with the URL can view this note' : 'Sharing is paused: the URL returns 404'}</div>
                </div>
                <button className={`graph-switch ${share.enabled ? 'on' : ''}`} onClick={toggle} aria-label="Toggle public link">
                  <span className="graph-knob" />
                </button>
              </div>

              {share.enabled && (
                <div className="share-url">
                  <input className="text-input" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
                  <button className="btn" onClick={copy}><Icon name="link" size={14} /> Copy</button>
                </div>
              )}

              <div className="setting-row">
                <div className="info">
                  <div className="name">Password protection</div>
                  <div className="desc">{share.hasPassword ? 'Visitors must enter a password' : 'Anyone with the link can open it'}</div>
                </div>
                <button className="btn secondary" onClick={password}>
                  {share.hasPassword ? 'Change…' : 'Set password…'}
                </button>
              </div>

              <div className="setting-row">
                <div className="info">
                  <div className="name">Delete link</div>
                  <div className="desc">Revokes the URL permanently</div>
                </div>
                <button className="btn danger" onClick={remove}>Delete</button>
              </div>
            </>
          )}
        </div>

        <div className="share-dialog-foot">
          <button className="btn secondary" onClick={close}>Done</button>
        </div>
      </div>
    </div>
  );
}
