import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../lib/store';
import { useEscapeToClose } from '../lib/useEscapeToClose';
import { api, type TreeNode } from '../lib/api';

interface Cmd {
  id: string;
  title: string;
  hint?: string;
  run: () => void;
}

function flatten(node: TreeNode | null): { path: string; title: string }[] {
  if (!node) return [];
  const out: { path: string; title: string }[] = [];
  const walk = (n: TreeNode) => {
    if (n.type === 'file' && /\.(md|markdown)$/i.test(n.ext ?? '')) {
      out.push({ path: n.path, title: n.name.replace(/\.(md|markdown)$/, '') });
    }
    n.children?.forEach(walk);
  };
  node.children?.forEach(walk);
  return out;
}

export default function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const mode = useStore((s) => s.paletteMode);
  const setOpen = useStore((s) => s.setPalette);
  const tree = useStore((s) => s.tree);
  const activePath = useStore((s) => s.activePath);
  const openFile = useStore((s) => s.openFile);
  const openToSide = useStore((s) => s.openToSide);
  const setSettings = useStore((s) => s.setSettings);
  const setTrash = useStore((s) => s.setTrash);
  const setGraph = useStore((s) => s.setGraph);
  const setLeftPanel = useStore((s) => s.setLeftPanel);
  const setViewMode = useStore((s) => s.setViewMode);
  const save = useStore((s) => s.save);
  const toggleBookmark = useStore((s) => s.toggleBookmark);
  const openDailyNote = useStore((s) => s.openDailyNote);
  const newNote = useStore((s) => s.newNote);
  const newCanvas = useStore((s) => s.newCanvas);
  const notify = useStore((s) => s.notify);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);

  const files = useMemo(() => flatten(tree), [tree]);

  const commands: Cmd[] = useMemo(
    () => [
      { id: 'new', title: 'New note', hint: '⌘N', run: () => newNote() },
      { id: 'new-canvas', title: 'New canvas', run: () => newCanvas() },
      { id: 'daily', title: 'Open today’s daily note', run: () => openDailyNote() },
      { id: 'save', title: 'Save current file', hint: '⌘S', run: () => save() },
      { id: 'bookmark', title: 'Bookmark current file', run: () => activePath && toggleBookmark(activePath) },
      { id: 'split', title: 'Open current file to the right', run: () => activePath && openToSide(activePath) },
      { id: 'search', title: 'Open search', run: () => setLeftPanel('search') },
      { id: 'bookmarks', title: 'Open bookmarks & recent', run: () => setLeftPanel('bookmarks') },
      { id: 'graph', title: 'Open graph view', run: () => setGraph(true) },
      { id: 'settings', title: 'Open settings', run: () => setSettings(true) },
      { id: 'trash', title: 'Open trash', run: () => setTrash(true) },
      { id: 'reading', title: 'View: Reading mode', run: () => setViewMode('reading') },
      { id: 'live', title: 'View: Live edit', run: () => setViewMode('live') },
      { id: 'source', title: 'View: Source', run: () => setViewMode('source') },
      { id: 'reindex', title: 'Rebuild search index', run: async () => {
          notify('Rebuilding search index…', 0);
          try {
            await api.reindex();
            notify('Search index rebuilt');
          } catch {
            notify('Failed to rebuild search index');
          }
        } },
    ],
    [save, setLeftPanel, setGraph, setSettings, setTrash, setViewMode, activePath, toggleBookmark, openToSide, openDailyNote, newNote, newCanvas, notify],
  );

  const items = useMemo(() => {
    const isCmd = mode === 'commands' || q.startsWith('>');
    const lc = q.replace(/^>/, '').trim().toLowerCase();
    const fileItems: Cmd[] = files
      .filter((f) => !lc || f.title.toLowerCase().includes(lc) || f.path.toLowerCase().includes(lc))
      .slice(0, 40)
      .map((f) => ({ id: `f:${f.path}`, title: f.title, hint: f.path, run: () => openFile(f.path) }));
    const cmdItems = commands.filter((c) => !lc || c.title.toLowerCase().includes(lc));
    if (isCmd) return cmdItems;
    if (mode === 'files') return fileItems;
    return [...cmdItems.slice(0, 3), ...fileItems];
  }, [q, mode, files, commands, openFile]);

  useEffect(() => setSel(0), [q, open]);
  useEffect(() => {
    if (!open) setQ('');
  }, [open]);

  /*
   * On the shared Escape stack, not because the palette was ever trapped (its
   * input handles Escape and the backdrop is reachable) but because the stack
   * only works if every dialog is on it. The palette opens ON TOP of the other
   * dialogs, so if it stayed off the stack, Escape would reach whatever is
   * underneath and dismiss that instead while the palette stayed open.
   *
   * The input's own handler below is kept as well: it is what makes Escape work
   * while focus is inside the field on a browser that swallows the capture-phase
   * listener, and running both is harmless because the second call closes an
   * already-closed dialog.
   */
  useEscapeToClose(open, () => setOpen(false));

  if (!open) return null;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      items[sel]?.run();
      setOpen(false);
    }
  };

  return (
    <div className="modal-bg" onClick={() => setOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          placeholder={mode === 'commands' ? 'Run a command…' : 'Search files… (prefix > for commands)'}
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="palette-list">
          {items.map((it, i) => (
            <div
              key={it.id}
              className={`palette-item ${i === sel ? 'sel' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => {
                it.run();
                setOpen(false);
              }}
            >
              <span>{it.title}</span>
              {it.hint && <span className="kbd">{it.hint}</span>}
            </div>
          ))}
          {items.length === 0 && <div className="palette-item">No matches</div>}
        </div>
      </div>
    </div>
  );
}
