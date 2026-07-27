import { useEffect, useState } from 'react';
import { api, ApiError } from './lib/api';
import { useStore } from './lib/store';
import Login from './components/Login';
import ForceChangePassword from './components/ForceChangePassword';
import Ribbon from './components/Ribbon';
import Sidebar from './components/Sidebar';
import RightSidebar from './components/RightSidebar';
import Workspace from './components/Workspace';
import CommandPalette from './components/CommandPalette';
import Settings from './components/Settings';
import ShareDialog from './components/ShareDialog';
import VersionHistory from './components/VersionHistory';
import TrashView from './components/TrashView';
import ContextMenu from './components/ContextMenu';
import FolderPicker from './components/FolderPicker';
import { loadPlugins } from './lib/plugins';
import { initUrlSync } from './lib/urlsync';
import { useIsMobile } from './lib/useIsMobile';

export default function App() {
  const authed = useStore((s) => s.authed);
  const setAuthed = useStore((s) => s.setAuthed);
  const mustChangePassword = useStore((s) => s.mustChangePassword);
  const setMustChangePassword = useStore((s) => s.setMustChangePassword);
  const loadTree = useStore((s) => s.loadTree);
  const leftOpen = useStore((s) => s.leftOpen);
  const rightOpen = useStore((s) => s.rightOpen);
  const mobileDrawer = useStore((s) => s.mobileDrawer);
  const setMobileDrawer = useStore((s) => s.setMobileDrawer);
  const activePath = useStore((s) => s.activePath);
  const isMobile = useIsMobile();
  const setPalette = useStore((s) => s.setPalette);
  const save = useStore((s) => s.save);
  const toast = useStore((s) => s.toast);
  const [checking, setChecking] = useState(true);
  const [theme, setTheme] = useState<'theme-dark' | 'theme-light'>('theme-light');
  /**
   * Whether this session was minted by the identity provider rather than by the
   * password form (FR-15).
   *
   * Local component state rather than store state on purpose: only the gate
   * below consults it, and the store is shared with the workspace-persistence
   * machinery that syncs across tabs and devices, which is the last place a
   * property of THIS browser's session belongs.
   */
  const [sso, setSso] = useState(false);

  useEffect(() => {
    api
      .me()
      .then((r) => {
        setSso(Boolean(r.sso));
        setMustChangePassword(Boolean(r.mustChangePassword));
        setAuthed(true);
      })
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401)) console.error(e);
      })
      .finally(() => setChecking(false));
  }, [setAuthed, setMustChangePassword]);

  useEffect(() => {
    if (!authed) return;
    loadTree();
    // Deep link (/note/<path>) wins over the restored workspace's active note.
    const deepLink = initUrlSync();
    useStore
      .getState()
      .loadUiState() // restore workspace from server + open note(s)
      .then(() => {
        if (deepLink && deepLink !== useStore.getState().activePath) {
          return useStore.getState().openFile(deepLink);
        }
      })
      .catch(() => {});
    api
      .getSettings()
      .then((s) => setTheme(s?.ui?.theme === 'obsidian-dark' ? 'theme-dark' : 'theme-light'))
      .catch(() => {});
    useStore.getState().loadShares(); // badge shared notes in the file tree
    loadPlugins().catch(() => {});
    // websocket live updates, with reconnect.
    //
    // The socket MUST be able to come back on its own. The server now re-checks the
    // session on open sockets and closes any whose credential is stale (1008), which
    // fires on the mandatory first-run password change: this effect opens /ws as soon
    // as `authed` flips, which is before the mustChangePassword gate renders, so the
    // token held by that socket is invalidated moments later. Without a reconnect the
    // socket stays dead for the rest of the session and the file tree silently stops
    // refreshing on external changes (git pull, Obsidian desktop, another device),
    // with nothing in the UI to say why. That hits every new install.
    //
    // Backoff is capped and jittered so a server that is genuinely down does not get
    // hammered by every open tab in lockstep.
    let treeTimer: number | undefined;
    let retryTimer: number | undefined;
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => {
        attempt = 0; // a clean open resets the backoff
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'fs') {
            // coalesce bursts of fs events into a single tree refresh
            window.clearTimeout(treeTimer);
            treeTimer = window.setTimeout(() => loadTree(), 800);
          } else if (msg.type === 'uistate') {
            // another tab/device changed the workspace → sync live
            useStore.getState().applyRemoteState(msg.state, msg.originId);
          }
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        const backoff = Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5));
        retryTimer = window.setTimeout(connect, backoff + Math.random() * 1000);
      };
      // onerror is always followed by onclose, so reconnection is handled there.
      ws.onerror = () => {};
    };
    connect();

    return () => {
      closed = true;
      window.clearTimeout(treeTimer);
      window.clearTimeout(retryTimer);
      ws?.close();
    };
  }, [authed, loadTree]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      const s = useStore.getState();
      if (k === 'p') { e.preventDefault(); setPalette(true, e.shiftKey ? 'commands' : 'commands'); }
      else if (k === 'o') { e.preventDefault(); setPalette(true, 'files'); }
      else if (k === 's') { e.preventDefault(); save(); }
      else if (k === 'n') { e.preventDefault(); s.newNote(); }
      else if (k === 'e') { e.preventDefault(); s.setViewMode(s.viewMode === 'reading' ? 'live' : 'reading'); }
      else if (k === 'f' && e.shiftKey) { e.preventDefault(); s.setLeftPanel('search'); }
      else if (k === '\\') { e.preventDefault(); s.toggleLeft(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPalette, save]);

  // Mobile: close the overlay drawer once a note is opened (tap note → read it).
  useEffect(() => {
    if (isMobile && useStore.getState().mobileDrawer) setMobileDrawer(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath]);

  // Mobile: edge-swipe to open/close the drawers (Obsidian Mobile gesture).
  useEffect(() => {
    if (!isMobile) return;
    let sx = 0, sy = 0, fromLeftEdge = false, fromRightEdge = false, tracking = false;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      sx = t.clientX; sy = t.clientY;
      fromLeftEdge = sx <= 28;
      fromRightEdge = sx >= window.innerWidth - 28;
      tracking = true;
    };
    const onEnd = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) < 45 || Math.abs(dy) > Math.abs(dx)) return; // mostly-horizontal only
      const open = useStore.getState().mobileDrawer;
      if (dx > 0) {
        if (open === 'right') setMobileDrawer(null);
        else if (fromLeftEdge && !open) setMobileDrawer('left');
      } else {
        if (open === 'left') setMobileDrawer(null);
        else if (fromRightEdge && !open) setMobileDrawer('right');
      }
    };
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchend', onEnd);
    };
  }, [isMobile, setMobileDrawer]);

  if (checking) return <div className={theme} style={{ height: '100%' }} />;
  if (!authed) {
    return (
      <div className={theme}>
        {/*
          `setSso(false)` on the way in, because this callback only ever fires
          from a PASSWORD login (Login.tsx's SSO button navigates away instead of
          resolving a promise). Without it, a session that had been SSO-backed
          earlier in this page's life, then expired and was replaced from the
          password form, would keep the exemption below and skip a
          change-password wall that now genuinely applies.
        */}
        <Login
          onAuthed={() => {
            setSso(false);
            setAuthed(true);
          }}
        />
      </div>
    );
  }
  // Signed in but still on the default password → block the app until it's changed.
  //
  // AN SSO SESSION IS EXEMPT, and this is a lockout fix rather than a
  // convenience. ForceChangePassword's only action is
  // `changePassword('123456', ...)`: it submits the DEFAULT password as the
  // current one. A user who signed in through the IdP on an instance that never
  // moved off that default was never issued a local password and has nothing to
  // type, so the screen would be a wall with no exit at all, produced entirely
  // by a flag meaning to be helpful.
  //
  // The server already excludes SSO sessions from `mustChangePassword` on
  // /auth/me, so `!sso` is belt to those braces and the ordering of the two is
  // what makes it safe: the flag stays THE decision (a client that had never
  // heard of SSO would still behave correctly), while this clause only ever
  // removes a wall that a federated session cannot pass. It can never add one.
  if (mustChangePassword && !sso) return <div className={theme}><ForceChangePassword /></div>;

  // On mobile the sidebars are overlay drawers (always mounted, slid in/out by
  // CSS), driven by the device-local `mobileDrawer` state, not the persisted
  // leftOpen/rightOpen that sync across desktops.
  const showLeft = isMobile || leftOpen;
  const showRight = isMobile || rightOpen;
  const appCls = [
    'app',
    leftOpen ? '' : 'left-closed',
    rightOpen ? '' : 'right-closed',
    isMobile ? 'mobile' : '',
    isMobile && mobileDrawer === 'left' ? 'drawer-left-open' : '',
    isMobile && mobileDrawer === 'right' ? 'drawer-right-open' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={theme}>
      <div className={appCls}>
        <Ribbon onTheme={() => setTheme((t) => (t === 'theme-dark' ? 'theme-light' : 'theme-dark'))} />
        {showLeft && <Sidebar />}
        <Workspace />
        {showRight && <RightSidebar />}
        {isMobile && mobileDrawer && (
          <div className="drawer-backdrop" onClick={() => setMobileDrawer(null)} />
        )}
      </div>
      <CommandPalette />
      <Settings />
      <ShareDialog />
      <VersionHistory />
      <TrashView />
      <ContextMenu />
      <FolderPicker />
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
