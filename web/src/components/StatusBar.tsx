import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { api, apiErrorMessage, liveSyncToneColor, liveSyncVerdict, type LiveSyncStatus } from '../lib/api';
import Icon from './Icon';

/**
 * How often the indicator re-reads the backend's status.
 *
 * Unchanged from the git-only version at 15s, and deliberately not shortened for
 * the LiveSync case even though a broken peer is the interesting one. The
 * server's health probe only reaches out to CouchDB when a peer is NOT ok (a
 * healthy peer's probe is synchronous and does no I/O), so polling faster while
 * something is wrong would add a network request per tick to a machine that is
 * already having a bad time, and would tell the operator nothing they will not
 * see within fifteen seconds anyway.
 */
const POLL_MS = 15000;

/**
 * The vault-sync indicator, for whichever backend owns the vault.
 *
 * It reads `GET /api/livesync/status` FIRST, not because LiveSync is the
 * default but because that response is the only one that says which backend is
 * in charge (`backend`/`enabled` come straight from `sync.backend`). Asking git
 * first would mean asking a question the answer to which might be irrelevant,
 * and asking both every tick would spend a `git status` on every instance that
 * does not use git.
 *
 * Why this is not one boolean: the bar used to say "No vault sync" whenever git
 * reported no repository, which for a LiveSync instance is both true and
 * completely wrong. Worse, the state that actually matters here has no git
 * equivalent. A replication peer that is idle and a replication peer that is
 * wedged look identical from outside: no writes are flowing in either case.
 * KICKOFF section 7 describes exactly that, a bridge that stayed up, did one
 * full push and then went silent forever, and calls telling those two apart the
 * most important requirement in the project. So the label comes from
 * `liveSyncVerdict`, which is shared with the settings panel so the two surfaces
 * cannot disagree, and it distinguishes "offline" (CouchDB is down, the peer is
 * retrying, nothing here is broken) from "wedged" (CouchDB answers, this process
 * has not synced for over a minute, and that is a fault).
 *
 * On polling rather than the websocket: `broadcast({type:'livesync'})` reaches
 * the browser through the single socket App.tsx owns, and this component has no
 * access to it. Opening a SECOND authenticated socket per tab for a status
 * widget would double the upgrade load and add a reconnect/backoff loop to
 * maintain, to save one small request every fifteen seconds. When the socket's
 * dispatch grows a subscription hook, this should move onto it; until then the
 * poll is the cheaper of the two in every sense that matters.
 */
export default function StatusBar() {
  const content = useStore((s) => s.content);
  const activePath = useStore((s) => s.activePath);
  const dirty = useStore((s) => s.dirty);
  const loadTree = useStore((s) => s.loadTree);
  const notify = useStore((s) => s.notify);
  const [git, setGit] = useState<any>(null);
  const [live, setLive] = useState<LiveSyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  // Guards the poll against a response that arrives after unmount, and against
  // the two overlapping refreshes a manual sync can create (the click's own
  // refresh plus the interval landing mid-flight).
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    let status: LiveSyncStatus | null = null;
    try {
      status = await api.liveSyncStatus();
    } catch {
      // A failing LiveSync status endpoint must not cost the git indicator: the
      // git backend is what most installs use, it is unaffected by anything
      // happening over here, and a bar that goes blank because an unrelated
      // route answered 500 is a regression on a working feature.
      status = null;
    }
    if (!alive.current) return;
    setLive(status);
    if (status?.enabled) {
      // LiveSync owns the vault, so `git status` cannot describe it. Clearing
      // rather than leaving the last git reading in place matters: the two
      // backends are mutually exclusive, and a stale "3 unsaved changes" from
      // before the switch would be a claim about a backend that is not running.
      setGit(null);
      return;
    }
    try {
      const g = await api.gitStatus();
      if (alive.current) setGit(g);
    } catch {
      if (alive.current) setGit(null);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, [refresh]);

  const verdict = live?.enabled ? liveSyncVerdict(live) : null;

  /**
   * Run one sync pass on whichever backend owns the vault.
   *
   * Both endpoints answer `{ ok, log }`, which is what makes one handler
   * possible: `services/livesync.ts` mirrors `services/git.ts`'s contract
   * deliberately so that callers do not branch on the backend.
   */
  const sync = async () => {
    if (syncing) return;
    setSyncing(true);
    notify('Syncing…');
    try {
      const r = verdict ? await api.liveSyncSync() : await api.gitSync();
      notify(r.ok ? 'Synced ✓' : `Sync: ${r.log.at(-1)}`);
      await loadTree();
      await refresh();
    } catch (e) {
      notify(`Sync failed: ${apiErrorMessage(e, 'the sync request did not complete')}`);
    } finally {
      setSyncing(false);
    }
  };

  const isText = activePath && /\.(md|markdown|txt)$/i.test(activePath);
  const words = isText ? content.trim().split(/\s+/).filter(Boolean).length : 0;

  const gitLabel = !git?.isRepo
    ? 'No vault sync'
    : git.clean
      ? `git ${git.branch}${git.ahead ? ` ↑${git.ahead}` : ''}${git.behind ? ` ↓${git.behind}` : ''}`
      : `${git.modified + git.notAdded} unsaved changes`;

  // The tooltip is where the full verdict goes: peer-by-peer detail, the last
  // error (already redacted server-side, since a CouchDB URL carries
  // user:password) and, for the states that are not this instance's fault, the
  // sentence saying so. The label alone cannot carry that and should not try.
  const label = verdict ? verdict.text : gitLabel;
  const title = verdict ? `${verdict.text}\n${verdict.detail}` : 'Git sync';
  const color = verdict && verdict.tone !== 'ok' ? liveSyncToneColor(verdict.tone) : undefined;

  return (
    <div className="status-bar">
      {dirty && <span>Saving…</span>}
      {isText && <span>{words} words</span>}
      {isText && <span>{content.length} characters</span>}
      <span className="clickable" title={title} style={color ? { color } : undefined} onClick={sync}>
        <Icon name="refresh-cw" size={13} style={syncing ? { animation: 'spin 1s linear infinite' } : undefined} />
        {label}
      </span>
    </div>
  );
}
