# IMPLEMENTATION PLAN: WebObsidian

> Development progress tracker. Design reference: [PRD.md](PRD.md).
> Convention: `[ ]` not started · `[~]` in progress · `[x]` done.
> Update this file **every time** an item changes state.

Last updated: 2026-07-27 (security fix: the default password stayed valid after an override was configured; removed the `mustChangePassword` oracle from `/auth/status`)

---

## Phase 0: Foundation & scaffolding
- [x] M0.1 Initialize the monorepo (root `package.json` + workspaces)
- [x] M0.2 Server scaffold: Express + TS, `tsconfig`, dev script (tsx), build (tsc)
- [x] M0.3 Web scaffold: Vite + React + TS
- [x] M0.4 Directory structure per PRD §2.2
- [x] M0.5 `.gitignore`, `.env.example` (ESLint/Prettier: deferred, does not block the build)

## Phase 1: Settings store (JSON db), FR-5
- [x] M1.1 Module `settings` reads/writes `data/settings.json` (atomic write + backup)
- [x] M1.2 Schema validated with zod, default settings, `version` migration
- [x] M1.3 Route `GET/PUT /api/settings`

## Phase 2: Auth gate, FR-3
- [x] M2.1 Hash password (scrypt), self-generated JWT secret
- [x] M2.2 `POST /auth/setup`, `/auth/login`, `/auth/logout`, `GET /auth/me`
- [x] M2.3 Middleware auth guard (httpOnly cookie), route protection
- [x] M2.4 First-run setup flow (UI + env seed `WEBOBSIDIAN_PASSWORD`)
- [x] M2.5 Default password 123456 + change password (Settings→Account) + recovery override (`auth.passwordHash`/`WEBOBSIDIAN_PASSWORD`); migrate the old password → `userPasswordHash`

## Phase 3: Vault filesystem, FR-1
- [x] M3.1 Vault service: list tree, read, write, create, rename/move, delete→trash
- [x] M3.2 Path traversal guard + allowedRoots
- [x] M3.3 Upload attachments (binary), serve binary with mime
- [x] M3.4 Safe folder browser for picking the vault path
- [x] M3.5 Filesystem watcher (chokidar) → events over WebSocket
- [x] M3.6 Trash UI + delete mode (FR-1): `vault.deleteMode` (trash/permanent) + Settings selector;
      service `listTrash/restoreFromTrash/deleteFromTrash/emptyTrash/remove`; routes `/api/files/trash*`;
      TrashView modal (Restore / delete permanently / Empty trash) opened from the Files header + command palette

## Phase 4: QMD Search engine, FR-7
- [x] M4.1 QMD module on top of MiniSearch: index content/title/headings/tags/path/frontmatter
- [x] M4.2 Build the index at startup + persist `data/qmd-index.json`
- [x] M4.3 Incremental update via the watcher + after every write
- [x] M4.4 Query: full-text, prefix, fuzzy, fielded (`tag:`,`path:`,`title:`)
- [x] M4.5 Route `GET /api/search`

## Phase 5: Links graph, FR-2
- [x] M5.1 Parser wikilinks/embeds/tags → link index
- [x] M5.2 Backlinks `GET /api/backlinks`
- [x] M5.3 Graph data endpoint `GET /api/graph`

## Phase 6: GitHub sync, FR-4
- [x] M6.1 Service git (simple-git): init/clone, status, pull, commit, push
- [x] M6.2 Git LFS: detect, `.gitattributes`, track patterns (verified lfsAvailable)
- [x] M6.3 Auth via a PAT embedded in the remote URL
- [x] M6.4 Auto-sync interval (autosync service)
- [x] M6.5 Basic conflict detection + report to the user
- [x] M6.6 Routes `/api/git/{status,init,clone,pull,commit,push,sync}`

## Phase 7: API Gate (Agent), FR-6
- [x] M7.1 API key model: create/list/revoke, hash stored in settings, scopes
- [x] M7.2 Middleware apikey guard + scope check + rate limit + audit log
- [x] M7.3 `/api/v1`: notes list/read/write/append/delete, search, backlinks, tags
- [x] M7.4 Key management route `GET/POST/DELETE /api/keys`
- [x] M7.5 Agent API documentation (`docs/AGENT_API.md`)

## Phase 8: Community plugins, FR-8
- [x] M8.1 Read `.obsidian/plugins/*` (manifest + main.js)
- [x] M8.2 Obsidian API shim (App, Vault, Workspace, Plugin, Notice, Setting…)
- [x] M8.3 Plugin loader (eval main.js) + enable/disable
- [x] M8.4 Browse + install from the community (GitHub releases)

## Phase 9: Web frontend, FR-2
- [x] M9.1 API client + auth flow + app shell (ribbon/sidebar/tabs/statusbar)
- [x] M9.2 File tree (context menu CRUD, new note/folder)
- [x] M9.3 CodeMirror 6 editor (markdown, keymap, autosave)
- [x] M9.4 Reading view (remark/rehype, wikilinks, embeds, callouts, tasks, properties)
- [x] M9.5 Search panel + command palette
- [x] M9.6 Backlinks/outline/tags panels
- [x] M9.7 Graph view (opens in a tab + Obsidian-style Filters panel)
- [x] M9.8 Settings UI (vault/git/api keys/plugins/theme)
- [x] M9.9 Theme Obsidian-like (dark/light)
- [x] M9.10 Navigation back/forward (toolbar ←/→ on every view, history stack)
- [x] M9.11 Search: filter/sort (match case, collapse, more context, sort) + sticky query box

## Phase 10: Docker & docs, FR-9
- [x] M10.1 Multi-stage `Dockerfile` (web build → server runtime, git+git-lfs)
- [x] M10.2 `docker-compose.yml` (vault + data volumes, env secrets, healthcheck)
- [x] M10.3 `README.md` quickstart + `docs/AGENT_API.md`
- [x] M10.4 Deploy hardening for self-hosting: compose is `.env`-driven (`VAULT_HOST_PATH`,
  `HTTP_BIND/HTTP_PORT`, `WEBOBSIDIAN_WATCH`) → nothing is clobbered on redeploy; the watcher
  falls back to polling by itself on inotify `ENOSPC/EMFILE`; `start_period=90s`; README Deploy-to-VPS section

## Phase 11: QA & DoD
- [x] M11.1 Smoke test end-to-end (login → edit → search → backlinks → agent API CRUD)
- [x] M11.2 Seed a sample vault for demos (`sample-vault/`)
- [x] M11.3 Check the Definition of Done (PRD §8): verified via curl + UI screenshots

## Phase 12: Parity & UI fidelity (round 2)
- [x] M12.1 Live Preview WYSIWYG (CM6): hide formatting marks, scale headings, wikilink/checkbox/image widgets
- [x] M12.2 Frontmatter → Properties block in both Live preview (StateField) and Reading
- [x] M12.3 Embeds/transclusion `![[note]]` + images `![[img]]` in Reading
- [x] M12.3b Embed audio/video `![[clip.mp4]]`/`![[song.mp3]]` → HTML5 `<video>`/`<audio>` (Live Preview `MediaWidget`, Reading `markdown.ts`, public share `renderhtml.ts`) + open a media file straight from the tree → player; binary served over HTTP Range (206) so seeking works; MIME/extension tables consolidated into `services/mime.ts` & `lib/media.ts`
- [x] M12.4 Real right-click context menu (new/rename/delete/open-to-side/bookmark)
- [x] M12.5 Drag-and-drop file moves in the tree + paste/drop an image → upload as an attachment + insert the embed
- [x] M12.6 Quick switcher (⌘O) + command palette commands + hotkeys (⌘P/⌘O/⌘N/⌘E/⌘⇧F/⌘\\/⌘S)
- [x] M12.7 Bookmarks + Recent panel; Daily note command; split pane (open to the right)
- [x] M12.8 Git auto-commit-on-save (debounced) + toggle in Settings
- [x] M12.9 Code-split bundle (react/codemirror/markdown chunks)

## Phase 13: Obsidian look & feel (from user feedback)
- [x] M13.1 Flat Lucide icon set (`Icon` component) replacing every emoji
- [x] M13.2 Default theme = Light (as in Obsidian), palette/spacing/borders follow Obsidian
- [x] M13.3 File tree with chevrons only (no icon for markdown), subtle active highlight
- [x] M13.4 Vault footer (vault name + settings); small status bar in the bottom-right corner
- [x] M13.5 Right sidebar "Linked mentions" + "Outline" matching the reference screenshot
- [x] M13.6 Tab bar with left/right sidebar toggles + a new tab button

## Phase 14: WYSIWYG editor & context menus (from user feedback)
- [x] M14.1 Live Preview renders exactly like Obsidian: clean headings (hide `#`), bold→bold,
      italic→italic, `code`→mono background, strikethrough, bullet→•, tag→pill
- [x] M14.2 Reveal raw syntax **per token at the caret** (not the whole paragraph) so editing stays smooth
- [x] M14.3 Fix the dark theme (oneDark) being applied over the light UI → highlighting follows the theme
- [x] M14.4 Callout/blockquote rendered inline in Live Preview
- [x] M14.5 Frontmatter → Properties widget (block) in Live Preview
- [x] M14.6 Editor right-click menu: Format/Paragraph/Insert (submenu) + Cut/Copy/Paste/Select all + Search
- [x] M14.7 Extended file tree right-click menu: Open/Open to right/Bookmark/Make a copy/Rename/Move/Copy path/Delete
- [x] M14.8 Reading view right-click menu: Copy/Search/Select all; ContextMenu supports submenus + icons

### Remaining / future improvements (non-blocking)
- [ ] Advanced conflict resolution UI for git
- [ ] Lazy-load extremely large folder trees; canvas/whiteboard
- [ ] ESLint/Prettier CI; live-preview rendering of deeply nested tables/lists
- [ ] Graph: port the d3-force simulation into a web worker (the way the Obsidian app runs a worker + WASM)
      so the UI does not stutter while a 5.9k-node graph is "blooming". Physics/render are already at
      parity; only the threading architecture is left (see sim.js in obsidian.asar; the web side keeps the
      same parameters, only where they run changes)

---

## Phase 15: Persist & sync workspace state (requested by the user)
- [x] M15.1 Persist UI/workspace state **to a file on the server**, `data/uistate.json` (no localStorage):
      open tabs, active note, viewMode, expanded folders, split, recent, bookmarks, panel layout
- [x] M15.2 Restore the state on load (F5 no longer loses the note; another browser/device keeps it too)
- [x] M15.3 **Real-time sync** between tabs/devices over WebSocket: one tab changes → broadcast →
      the other tab applies it (echo dropped by `originId`, unsaved content flushed before switching, re-hydrate)
- [x] M15.4 Single-click-to-edit on headings (posAtCoords precise=false); headings no longer underlined

## Phase 16: Deep-link URL & Public share, FR-10 (requested by the user)
- [x] M16.1 The URL `/note/<path>` stays in sync with the open note (pushState/popstate, the deep-link
      opens after login, Graph = `/graph`)
- [x] M16.2 Server: `shares` service (`data/shares.json`, atomic write) + routes `/api/shares`
      (list/create/toggle/delete, auth) + `/public/shares/:id{,/file}` (no auth; the guard only
      serves files that note embeds, never `.md`)
- [x] M16.3 Public page `/share/<token>`, readonly (renders the Reading view, no login required)
- [x] M16.4 UI: note context menu "Copy public link"; Settings → "Sharing" tab for central management
      (search, quick enable/disable toggle, copy link, delete)
- [x] M16.5 Optional password per share: set/remove in the Sharing tab (scrypt hash, only
      `hasPassword` is returned); public returns 401 `{passwordRequired}` → password form → unlock JWT cookie
      (httpOnly, scope `/public/shares/{id}`, 12h)
- [x] M16.6 SSR for `/share/{id}`: the server renders complete HTML (Google indexable) + SEO meta
      (title, description, canonical, Open Graph + og:image, Twitter card); locked → a noindex
      password form; replaces the React /share page (web drops PublicNote, dev proxies /share to the server)
- [x] M16.7 Per-note share dialog + badge (from feedback, PRD 0.7): a "Share…" item (file tree +
      pane ⋯ menu, replacing "Copy public link") opens a popup to create the link/copy the URL/toggle it on
      and off/set a password/delete it; an accent-colored globe icon next to the name of a shared note in the
      file tree; the shares cache in the store is shared by the dialog + Settings → Sharing + the badge

## Phase 17: Pane menu (⋯) & Right sidebar tabs (from user feedback, PRD 0.3)
- [x] M17.1 "More options" menu (⋯) on the view-header of every pane: note (Split right/down, Bookmark,
      Copy public link, Make a copy, Rename/Move/Copy path/Delete, Close tab/Close others),
      Graph (Copy screenshot PNG → clipboard, Close tab)
- [x] M17.2 Split pane in 2 directions: right + down (`splitDirection` persisted in uistate)
- [x] M17.3 Right sidebar icon tab strip (Backlinks · Outgoing links · Tags · Outline),
      the selected tab is persisted (`rightPanel`)
- [x] M17.4 Unlinked mentions (search by title and match **the whole phrase** through `/api/search/matches`
      `phrase:true`, excluding notes that already link) + Outgoing links (parse wikilinks, resolved/unresolved,
      attachments filtered out of unresolved, click to open/create)

---

## Phase 18: Markdown editor parity Obsidian Desktop (docs/obsidian-desktop-internals.md)
- [x] M18.1 CSS design tokens taken from app.css 1.12.7 (§19): accent HSL 258/88%/66% + the light/dark
      formulas for accent-1/-2, the color-base ramp at the exact values, extended colors + `-rgb`, semantic
      tokens (`--background-*`, `--text-*`, `--interactive-*`), headings 1.618/1.462/1.318/
      1.188/1.076/1em + letter-spacing, `--bold-modifier: 200`, `--file-line-width: 700px`,
      callout slots as RGB triplets (§21); the old var aliases are kept for existing components
- [x] M18.2 Standard DOM classes (§20): root `markdown-source-view cm-s-obsidian mod-cm6
      is-live-preview is-readable-line-width`; line `HyperMD-header-1..6 / -list-line /
      -task-line[data-task] / -quote / -codeblock(-begin/-end/-bg) / -hr / -footnote`; span
      `cm-hashtag(-begin/-end), cm-strikethrough, cm-inline-code, cm-hmd-internal-link,
      cm-formatting(-header/-highlight), cm-comment, cm-math, cm-footref, cm-url, cm-blockid`
- [x] M18.3 New Live Preview tokens (§7): `==highlight==` hides its markers; `%%comment%%` faint;
      footref `[^id]` superscript + the definition line rendered; block id `^abc-123` faint;
      HR widget; the ``` fence is hidden when the caret is outside the block; the `\.` escape is
      hidden (Trilium export files); any non-space character in a task = done (x/X struck through +
      muted); callout regex `/^\[!([^\]]+)\]([+-]?)(?:\s|$)/` + the full §21 color/icon table +
      default title + fold mark
- [x] M18.4 Wikilinks follow the §7 rules exactly: the alias comes after the FIRST `|`, nested `[[`
      is rejected, NBSP→space + NFC; in LP the label keeps the raw `Note#Head` (aria-label =
      `Note > Head`, like Obsidian); image size params `![[img|300]]` / `![[img|300x200]]`
- [x] M18.5 Exact §7 tag regex (unicode charset, all-numeric rejected, at least 1 letter required);
      the pill is split into cm-hashtag-begin/-end halves
- [x] M18.6 Default §4 hotkeys (lib/editorCommands.ts): Mod+B/I/K/L/D, Mod+/ (%%), Mod+E
      (edit↔reading), Mod+S, Alt+Enter to follow a link; smart pair toggling (wrap/unwrap +
      word-at-caret); Enter/Backspace continue list markup
- [x] M18.7 Suggester for `[[` (files) + `#` (tags): the §9 fuzzy scoring formula is ported verbatim
      (lib/fuzzy.ts: token pass → per-char pass, penalties for mid-word/span/offset/length,
      basename before path −1); `.suggestion-container` dropdown per §20, flipping upwards near
      the bottom; Enter/Tab/↑↓/Esc through a Prec.highest keymap (lib/suggest.ts)
- [x] M18.8 Math rendered with lazy-loaded KaTeX (inline `$..$` + single-line `$$..$$`); code block
      syntax highlighting (@codemirror/language-data); GFM base (strikethrough/table/tasklist);
      Obsidian checkbox styling (accent bg, radius 4px, size --font-text-size)
- [x] M18.9 Line spacing matches the real app.css: `.HyperMD-header { padding-top: var(--p-spacing) }`,
      inline-title margin-bottom 0.5em, scroller line-height var(--line-height-normal)
- [x] M18.10 Fix round covering the 11 bugs the user reported (compared side-by-side with the app):
      (1) a dedicated HighlightStyle (lib/highlight.ts) colors tokens with the Obsidian palette, which
      kills the odd red escape/bracket coloring that came from defaultHighlightStyle; (2) real embeds:
      `![[note]]` transclusion renders through api.resolve + renderMarkdown (NoteEmbedWidget, depth ≤3),
      and a missing image/file gives a "could not be found" box; (3) vertical indent guides for nested
      lists (one cm-indent per tab/4-space unit); (4) nested blockquotes `> >` render multiple bars
      (data-quote-depth + layered gradient); (5) checkboxes/bullets work INSIDE a callout/quote (the body
      after the marker is processed); (6) callout fold +/-: a StateField (stores the toggle, state =
      default XOR toggle → survives async loading), chevron click, `-` collapsed by default; (7) correct
      code block colors + a language label in the top-right corner (data-lang); (8) display math `$$`
      fixed by reordering the escape pass (it runs last so it no longer claims the range); (9) HR has no
      more excess margin; (10) inline-HTML lines (`<u>…`) render as HTML, and mermaid actually renders
      (lazy mermaid.js, StateField block widget); (11) multi-line `%%` block comments are grayed out
      across the whole block
- [x] M18.12 Fix round 3 (4 editor bugs + Reading parity): (1) tables inside an HTML embed use the
      same metrics as a reading table; (2) inline footnotes `^[...]` as superscript; (3) fenced code
      has padding inside its background (16px), indented code drops the background and gains an
      indent guide like the app; (4) note embeds gain `markdown-embed-title` (the file name) + a fix
      for the extra whitespace (reset `white-space: normal` inside the widget, because cm-content's
      pre-wrap turned the \n between HTML blocks into blank lines); (5) Reading mode matches Live:
      custom task states `[/] [-] [>]`… become checkboxes (remark plugin `remarkObsidianTasks`,
      data-task, only x/X is struck through), li loses its bullet, and Properties shows list values
      as pills (tags/aliases)
- [x] M18.13 Reading mode fully matches Live (from the feedback "Reading is different from Live"):
      lib/callouts.ts split out and shared; the remark pipeline gains remark-breaks (newline = <br>, §7),
      ==highlight== → <mark>, inline and block %%comment%% dropped, block ids hidden, tag pills using
      the same charset as the editor, math $/$$ → span[data-tex] rendered with KaTeX after sanitizing,
      mermaid rendered after sanitizing, callouts with the correct §20 DOM (icon + title-inner + content,
      colors from data-callout→CSS slot, fold +/- click toggle, `-` collapsed already), wikilinks shown
      as `Note > Head` (the §7 reading rule), and image size params. Sanitize bug fixed: defaultSchema
      constrains a.className (it only allows the footnote class), which dropped the internal-link/tag
      classes, so the default entry is filtered out; mark/u added to tagNames
- [x] M18.14 Reading mode IS the Live Preview editor set to readonly (requested by the user,
      replacing the two-pipeline architecture): Workspace drops <Preview/> for reading mode, the Editor
      adds an `EditorView.editable(false)` compartment + `EditorState.readOnly` + a
      `livePreviewReadonly` StateField that disables every caret-driven syntax reveal (touches/
      lineActive/htmlBlock/mermaid/calloutFold); CSS `.is-reading-mode` hides the editing affordances
      (table handles, property add/del, contenteditable), while checkboxes and links stay clickable
      just like in Obsidian. The two modes are now structurally identical and cannot drift.
      (Preview's remark pipeline is still used for the split-pane source + public share.)
- [ ] M18.11 Future: MathJax instead of KaTeX (absolute glyph parity), heading/block mode
      suggester (`#`/`#^`), multi-line `$$` blocks, click a tag → search, heading/indent folding,
      the fold chevron placed after the title (it currently sits before it)

---

## Phase 19: Mobile / responsive UI (FR-11, requested by the user)
- [x] M19.1 `useIsMobile` hook (matchMedia 768px) + a local `mobileDrawer` state ('left'|'right'|null)
      in the store (NOT persisted, not broadcast) → the phone drawer never touches the desktop `uistate` sync
- [x] M19.2 CSS `@media (max-width: 768px)`: `.app` in 1 column (full-width workspace); the ribbon + left
      sidebar become a sliding overlay drawer (translateX) and the right sidebar a right-hand drawer;
      dimmed backdrop; touch targets ≥44px
- [x] M19.3 App shell: always render the sidebars on mobile (as drawers), add a backdrop that closes the
      drawer; auto-close the drawer when a note is opened; the hamburger (☰) + panel-right button in the
      tab-bar open the drawer instead of toggling width; hide the crumbs + split button on the mobile
      view-header (to prevent overflow)
- [x] M19.4 Edge-swipe: swiping in from the left edge opens the left drawer, from the right edge the right
      drawer, and swiping back closes it
- [x] M19.5 Format toolbar (shared `FormatToolbar` component): bold/italic/heading/list/checklist/
      quote/link/internal-link/code/tag/indent/outdent/undo/redo, acting on the active editor through
      `lib/activeEditor`; only shown while editing (Live/Source) a .md note. Mobile = fixed and anchored
      above the keyboard via visualViewport; **Desktop = an in-flow bar under the view-header** (requested by the user)
- [x] M19.6 Viewport `viewport-fit=cover` + `interactive-widget=resizes-content` + safe-area insets;
      verified in Chrome device emulation at 390×844
- [x] M19.7 Mobile parity round 2 (from user feedback): (a) the note "…" menu (ContextMenu) was being
      cut off → clamp its position inside the viewport (top/left ≥8px, estimated height capped against
      `innerHeight`) + `max-height: 100dvh` so it scrolls, with taller rows for touch; (b) lock horizontal
      panning of note content (`overflow-x: hidden` on `.cm-host`/`.markdown-preview`, text wrapping with
      `overflow-wrap: anywhere`, images/code/tables shrinking or scrolling internally); (c) the Settings +
      Version history modals go full-screen on mobile (`position: fixed; inset:0`), settings-nav becomes a
      horizontally scrolling strip, `.setting-row` stacks vertically, inputs go full-width, and the
      version-history list sits above the preview; the share dialog is full-width

## Phase 20: Graph node search & jump (requested by the user, PRD 0.5)
- [x] M20.1 A floating "Find node…" box on the Graph view: type keywords → a list of candidate nodes
      (every word has to match the label/path; ranked tag-first > prefix > label > path + degree, top 50);
      click or press Enter (first result) → the camera flies (pan+zoom lerp 15%/frame, minimum zoom 2×)
      to the node and highlights it like a hover (accent + everything unconnected dimmed) until the mouse
      moves; Esc closes it; wheel/drag cancels the fly

---

## Phase 21: Pane ⋯ menu parity with Obsidian (requested by the user, PRD 0.6)
- [x] M21.1 The ⋯ menu rebuilt to follow the Obsidian Desktop structure: the Backlinks in document group →
      Split/Open in new window → Rename/Move/Make a copy/Bookmark/Add file property/Export to PDF →
      Find → Copy path/Version history/Open linked view → Reveal in navigation/Share → tabs → Delete
- [x] M21.2 Find/Replace inside a note: `@codemirror/search` integrated (search panel at the top, ⌘F/⌘⇧F/⌘G);
      the "Find…" item calls `openSearchPanel` through `editorFind()` (the activeEditor handle)
- [x] M21.3 Reveal file in navigation: `store.revealInTree` expands the ancestor folders + opens the Files
      panel, and FileTree listens for the `wo-reveal-file` event → scrollIntoView + a 1.2s flash highlight
      (data-path lookup)
- [x] M21.4 Add file property: no prompt is used. `triggerAddProperty(view)` activates the Properties
      widget's own "+ Add property" button (focusing the key field + opening the key suggestion dropdown,
      like Obsidian); it creates an empty `---` block if the note has no frontmatter yet, then polls until
      the widget mounts; the menu switches to Live first. Fixes made in the widget along the way: (a) the
      list/tags value dropdown hung after a selection (the dropdown mounts on the theme wrapper, so a
      widget rebuild does not remove it → `choose()` now always calls `cleanup()` before `mutate()`); (b) the
      Property type/Copy/Remove menu flickered on a left-click of the icon (it opened on `mousedown` and the
      following `click` closed it right away) → switched to `click` (openPropMenu already calls `stopPropagation`)
- [x] M21.5 Export to PDF: switch to the Reading view then `window.print()`; CSS `@media print` hides the
      ribbon/sidebar/tab/header/toolbar/status and prints only the note content (black on white, `@page` margin 16mm)
- [x] M21.6 Open version history (FR-4): server-side `git.log(path)` + `git.showFile(hash, path)` →
      routes `GET /api/git/log|/show`; the `VersionHistory.tsx` modal lists the commits that touched the
      file, previews a version's content, and "Restore this version" overwrites + reloads; it is empty when
      Git Sync is not enabled yet
- [x] M21.7 Open in new window: `window.open(pathToUrl(path))` opens the `/note/<path>` deep-link in a new
      tab; Open linked view submenu (Backlinks/Outgoing links/Outline → `setRightPanel`)

---

## Phase 22: Folder picker "Move file to…" + Bookmarks/Recent context menu (requested by the user)
- [x] M22.1 An Obsidian-suggester-style folder-picker modal (`FolderPicker.tsx`): type to filter folders,
      ↑↓ to navigate, ↵ to move into the selected folder, ⇧↵ to create a new folder with the typed name
      and then move, esc to close; the footer hints the keys. Driven by `store.movePath`/`setMovePath`.
      Replaces the old `prompt()` in the ⋯ menu (Workspace) and the file tree right-click menu (FileTree).
      Filters out the current folder, and when moving a folder also itself and its children.
- [x] M22.2 A right-click context menu for the Bookmarks & Recent panel (`BookmarksPanel.tsx`):
      Open/Open to right/Reveal in navigation/Move file to…/Bookmark↔Remove bookmark/Copy path;
      Recent items also get "Remove from recent" (`store.removeRecent`). Previously right-click fell
      through to the browser's native menu because the panel had no `onContextMenu`.
- [x] M22.3 Drag a Bookmark/Recent row onto a folder in the file tree to move it (reusing the
      `text/wo-path` payload FileTree already reads) + action buttons that appear on hover on each row
      (📁 Move file to… and ✕ Remove bookmark / Remove from recent).

## Phase 23: Render HTML inside a ```html code block (requested by the user)
- [x] M23.1 A "Render HTML" button on every ` ```html ` block: `htmlPreviewField` (a StateField block
      widget in `livePreview.ts`, registered in `Editor.tsx`). Because both Reading and Live are CodeMirror
      (M18.14), the button has to live inside the editor rather than in `Preview.tsx`. The widget sits
      DIRECTLY ABOVE the opening fence line (`side: -1`): an HTML block can be enormous (a whole saved page
      is ~296KB), and putting it after the block leaves the button outside the viewport (CodeMirror
      virtualizes the DOM), so it cannot be clicked. Clicking toggles an
      `<iframe sandbox="allow-scripts allow-popups allow-forms allow-modals">` (NOT same-origin, so the
      saved page's scripts run but stay isolated from the vault/cookies/app localStorage); the source is
      still displayed below it. CSS `.cm-html-preview` + a 70vh iframe that resizes vertically. The same
      button was added to `Preview.tsx` (`setupHtmlPreview`, wrapping `.html-block`) for the public
      `/share` page. Verified for real over CDP: the iframe renders the saved ChatGPT page correctly.
      Typecheck + build clean.
- [x] M23.2 (from feedback): when rendering, (a) hide the code block as well, (b) make the iframe span the
      full pane width. Added a `htmlRenderedState` state + a `toggleHtmlRender` effect (like the callout
      fold) so we know which block is rendering → when rendered, `Decoration.replace` covers the whole
      block (hiding the code + inserting the iframe); when collapsed, only the button is inserted above it
      (the code stays visible). Full width: content is centered in a `--file-line-width` 700px column, so
      `.is-rendered` uses `left:50% + translateX(-50%)` + width = `view.scrollDOM.clientWidth` (in JS,
      synced on resize) to span the whole scroller width. Verified over CDP: the iframe is 992px, matching
      the pane, the code is hidden, and toggling works both ways.

## Phase 24: Copy/Cut/Paste in the file tree context menu (FR-1, requested by the user)
- [x] M24.1 Clipboard state in the store: `clipboard: {path, mode:'copy'|'cut'} | null` + `setClipboard`
      (session-local, NOT in `PERSIST_KEYS`, so it is never saved to the server or broadcast). The file
      right-click menu gains Copy/Cut, and so does the folder menu; the Paste item only renders when the
      clipboard holds something. A row that was Cut is dimmed (`opacity .5`).
- [x] M24.2 `doPaste` (FileTree): the destination is the clicked folder, or the parent folder of a clicked
      file. Cut → `api.rename` (moves the file/folder; pasting back into the same place is a no-op; pasting
      a folder into itself or a descendant is blocked; the clipboard is cleared after pasting). Copy →
      recursive `api.copy`, with `uniqueChildName` avoiding name collisions (`… copy`/`… copy N`), keeping
      the clipboard so it can be pasted repeatedly.
- [x] M24.3 Server: `vault.copy(from,to)` uses recursive `fs.cp` (files + folders) and returns the list of
      created files for reindexing; it throws if the destination already exists. The `POST /api/files/copy`
      route upserts the search index + link graph for the new `.md` files, then schedules an auto-commit.
      Client `api.copy`. Typecheck clean for server + web.
- [x] M24.4 (from feedback): right-clicking empty space in the file tree now opens the app's context menu
      (it used to fall through to the browser's native menu). `onRootContext` on the FileTree div
      (`minHeight:100%` so it covers all of `.sidebar-body`): New note / New folder (vault root) + Paste
      (only when the clipboard holds something) → `pasteToRoot` pastes into the vault root (Cut = `rename`
      to the root, Copy = `api.copy` with collision-free naming). Applied to the "Vault is empty." branch too.

## Phase 25: Canvas (FR-12, PRD 1.0, requested by the user)
- [x] M25.1 `web/src/lib/canvas.ts`: JSON Canvas types (CanvasNode text/file/link/group, CanvasEdge),
      safe parse/serialize (defaulting to `{nodes:[],edges:[]}` when empty or corrupt), id helpers (genId),
      preset colors `1..6`→hex, edge geometry (anchor per side + Bézier path), bbox hit-testing.
- [x] M25.2 `web/src/components/CanvasView.tsx`: a self-managed view (like GraphView) that reads `content`
      from the store, parses it and renders. Pan/zoom (wheel zoom centered on the cursor, drag the
      background to pan, space+drag), dotted background grid. Nodes are absolutely positioned inside a
      transformed container; an SVG layer holds the edges (below the nodes). Toolbar zoom in/out/fit/100%.
- [x] M25.3 Node interactions: double-click the background → a text node in edit mode; drag to move;
      8 resize handles; double-click a text node → textarea editing (Esc/blur to leave); a file node renders
      an embed (note=Preview, image=`<img src=rawUrl>`); a link node is an `<a>` card; palette color change;
      Delete/Backspace to remove.
- [x] M25.4 Edge interactions: hovering shows the 4 side dots; dragging a dot→another node creates an edge
      (arrowhead at the `to` end); double-click an edge to add/edit its label; select an edge to recolor or
      delete it. Selection: click, marquee, Shift+click, moving/deleting as a group; a floating context
      toolbar (color, delete).
- [x] M25.5 Autosave debounced at ~900ms through `setContent`+`save` (mark dirty → write the `.canvas`).
      Wired into `Workspace.tsx` (render CanvasView when the path is `.canvas` and not a folder/graph).
      CSS `.canvas-*`.
- [x] M25.6 Create a new canvas: `newCanvas(dir)` in the store (Untitled.canvas with collision-free naming,
      body `{"nodes":[],"edges":[]}`); "New canvas" added to the FileTree context menu (file/folder/root) +
      the command palette. Web typecheck clean.
- [x] M25.7 **Marquee select (Shift+drag) + alignment snapping (parity with Obsidian, reverse-engineered
      from the asar):** left-dragging the background = **pan** (kept that way at the user's request; the
      marquee-by-default experiment was dropped), **Shift+drag = marquee selection**;
      panning also works with Space/middle/right-drag, and one-finger touch pans. Dragging a node: edges and
      centers snap to the other nodes (`snapMove` in canvas.ts, ported from `getSnapping/O3/P3`,
      snap points = the 4 corners + the center, dist = `ceil(15/scale)`), drawing a **guide line**
      (`.canvas-snaps`); Alt (⌃ on mac) disables snapping; Shift while dragging locks the axis. Verified over
      CDP: the marquee selects 5 nodes, and the guide appears while aligning then disappears on release.
- [x] M25.8 **Formatting shortcuts inside a text card** (mirroring `obsidianKeymap`): ⌘B/I/K(add link)/L(task)/`⌘/`(comment)
      on the textarea; `toggleWrap` turns the markers on and off. **Text alignment**: `TextNode.textAlign`
      (left/center/right), exposed as a button in the selection menu (when a text node is selected) + an
      "Align" submenu in the right-click menu; the CSS applies to both the textarea and the rendered body.
      (This goes beyond the JSON Canvas spec: real Obsidian ignores the field.)
- [x] M25.9 **UX fixes from feedback:** (1) bigger edge arrowheads (marker 14×14, refX 11). (2) the card
      right-click menu opens **exactly at the cursor**, uses `position:fixed`, and is measured then nudged
      back inside the screen (no overflow).

## Phase 26: Images: resize + zoom lightbox (FR-2, PRD 1.2, requested by the user)
- [x] M26.1 `web/src/lib/imageLightbox.ts`: a full-screen singleton lightbox (attached to `document.body`).
      Wheel zoom around the cursor + two-finger pinch around the pinch center (transform-origin 0 0, using
      the fixed-point formula), mouse-drag/one-finger panning, double-click to reset (fit ≤ natural),
      Esc/backdrop click/the × button to close; the pan listeners are attached per drag so nothing leaks.
- [x] M26.2 Live Preview `ImageWidget` (livePreview.ts): two handles on the left/right edges appear on
      hover and dragging changes the width (clamped to 40..contentDOM width, aspect ratio preserved).
      `writeImageWidth()` recovers the position via `posAtDOM`, finds the embed token covering that position
      again and writes the size param: `![[img|W]]` (wikilink) / `![alt|W](url)` (markdown), replacing the
      trailing numeric segment if there is one and appending otherwise. Clicking the image (without
      dragging) → `openLightbox`.
- [x] M26.3 Size params for markdown images `![](…)`: an alt carrying `|W`/`|WxH` sets width/height in
      **both** Live (livePreview.ts imgRe) and Reading (markdown.ts). Previously only `![[…]]` wikilinks
      supported a size.
- [x] M26.4 Reading view (Preview.tsx) click on an `<img>` → `openLightbox(currentSrc, alt)`; CSS for the
      resize handles (`.cm-image-resize`) + `.image-lightbox*` + a `zoom-in` cursor. Typecheck clean.

## Phase 27: Desktop app (Electron, multi-platform), FR-13, PRD 1.5 (requested by the user)
- [x] M27.1 The `desktop/` workspace (Electron shell). `src/main.ts`: single-instance lock; vault selection
      on first run (dialog, default `~/Documents/WebObsidianVault`); `DATA_DIR`/config/logs live in
      `userData`; **the existing server is spawned as a child process** through `ELECTRON_RUN_AS_NODE`, bound
      to `127.0.0.1` on a random free port; waits for `/healthz`; `BrowserWindow` loads
      `http://127.0.0.1:<port>`; File menu (Switch Vault / Open Vault·Data·Logs), Edit/View/Window/Help;
      external links open in the system browser; the server is killed on quit. `src/preload.ts` is minimal.
- [x] M27.2 Seamless auto-login: a random per-machine password is generated (stored in `userData`) and
      passed as `WEBOBSIDIAN_PASSWORD` (the override); login goes through Electron's `net`, the JWT is taken
      from `Set-Cookie`, the default password is changed to the secret using a Bearer token so
      `mustChangePassword` turns off, and then the **JWT cookie is seeded into `session.defaultSession`** →
      the window lands straight in the app without asking for a password. Verified: with a fresh data dir,
      `login` returns `mustChangePassword:false` and `userPasswordHash` is set.
- [x] M27.3 Build pipeline `scripts/build.mjs`: esbuild bundles `desktop/src` (main+preload, `electron`
      external) → `dist/`; esbuild bundles **the already-compiled server** (`server/dist/index.js`) into a
      single ESM file `.gen/server/dist/index.mjs` (`fsevents` external, `createRequire` banner); copies
      `server/public` → `.gen/server/public`. The bundled server passes a smoke test (healthz/login OK).
- [x] M27.4 electron-builder config (inside `desktop/package.json`): `extraResources` maps `.gen/server`→
      `resources/server`; targets macOS `dmg`+`zip` (arm64/x64), Windows `nsis`+`portable` (x64/arm64/ia32),
      Linux `AppImage`+`deb` (x64/arm64); the icon comes from `assets/logo.png`→`buildResources/icon.png`
      (1024²); `electronVersion` pinned to 33.4.11 (workspace hoisting). Verified: `electron-builder --dir`
      packages `WebObsidian.app`, and running the packaged build boots the server from
      `resources/server/dist/index.mjs` with healthz/login OK.
- [x] M27.5 CI: `.github/workflows/release.yml` triggers on `v*` tags (+ manual), with a
      macOS/Windows/Ubuntu matrix; each runner does `npm ci` → `npm run build` →
      `npm --workspace desktop run dist:publish` (electron-builder publishes a draft GitHub Release,
      `GH_TOKEN`, `CSC_IDENTITY_AUTO_DISCOVERY=false`). `ci.yml` gains the desktop typecheck + bundle build.
      Root scripts `desktop`/`desktop:dist`/`desktop:publish`; `.gitignore` gains `desktop/.gen` and
      `desktop/release`.

### Progress log
- 2026-07-27 (security fix: default password `123456` still accepted after an override was configured):
  `checkPassword()` (server/src/services/auth.ts) only skipped the default-password branch when
  `auth.userPasswordHash` was set. Configuring `WEBOBSIDIAN_PASSWORD` or a hand-edited `auth.passwordHash`
  does **not** populate that field (`bootstrap.ts` deliberately only logs), so an operator who followed the
  documented Docker path (`.env.example` calls it the "Initial master password", `docker-compose.yml` says
  "Set an initial password"), set a strong secret and never opened the UI **still had `123456` accepted as a
  full owner session**: the whole vault, `/api/settings`, `/api/keys`, `/api/git` including the stored PAT,
  and the WebSocket stream. `GET /auth/status` made this trivially discoverable: it requires no auth and
  returned `mustChangePassword`, which is exactly `userPasswordHash === ''`, so a port scan identified every
  instance that would accept the default.
  **Fix, in 4 places:** (1) new `server/src/services/password-policy.ts` exporting
  `isDefaultPasswordActive(auth)`, true only when none of `userPasswordHash` / `passwordHash` /
  `config.initialPassword` is set. It is a separate module so it can be shared without an import cycle
  between `auth.ts` and `settings.ts`. (2) `checkPassword()` now gates the default branch on it.
  (3) `hasCustomPassword()` and `redactSettings()` derive from the **same** predicate, so the "must change"
  signal can never disagree with "is the default accepted" (that drift was the actual bug, and disagreement
  would strand the user: ForceChangePassword submits `changePassword('123456', ...)`). (4) `GET /auth/status`
  now returns only `{ passwordSet }`; the client only ever read that field (`Login.tsx`), and
  `mustChangePassword` remains available post-login on `/auth/login` and `/auth/me`.
  *Side effect, deliberate:* the desktop shell injects its per-install secret as `WEBOBSIDIAN_PASSWORD`, so
  `123456` is now never valid on the loopback server even if `autoLogin()` fails, which previously left it live.
  Verified against a running server across 3 scenarios / 8 assertions: with an env password set, `123456` is
  rejected (401) and the configured password accepted (200); with only a hand-edited recovery hash, `123456`
  is rejected and the recovery password accepted; with nothing configured, `123456` still works (200) and
  login reports `mustChangePassword: true`, preserving the documented first-run flow. `/auth/status` returns
  `{"passwordSet":true}` with no `mustChangePassword` key. Typecheck + build clean.
- 2026-07-27 (chore: full English translation of docs, comments and UI strings): the repo mixed Vietnamese
  and English, and several screens rendered **entirely** in Vietnamese while their surrounding headings were
  English (the `Settings.tsx` account panel, `ForceChangePassword.tsx`), so the UI read as half-translated.
  Translated every Vietnamese comment, document and user-facing string across **67 files**, including
  `PRD.md`, this plan, `docs/obsidian-desktop-internals.md`, `CLAUDE.md`, and the whole `server/` and `web/`
  comment surface. Also removed all **383** em dashes in favour of colons, commas and parentheses, converting
  the few genuine content glyphs to words instead (Obsidian menu-divider entries became `(divider)`, and the
  "no value" cells in the core-plugins tables became `none`).
  **Prose only, no behaviour change**, and verified as such rather than assumed: every string literal in all
  86 TS/TSX files was compared before and after, and only 4 files changed a literal, each of them
  user-facing UI text (`sharepage.ts`, `RightSidebar.tsx`, `Settings.tsx`, `ShareDialog.tsx`). No route path,
  cookie name, header name, object key or enum value changed, and the redaction sentinel used by
  `redactSettings()`/`routes/settings.ts` survived byte-identical. Structural invariants on this file were
  checked too: checkbox counts (6 `[ ]` / 1 `[~]` / 155 `[x]`), all milestone ids, 103 dated log entries and
  every `FR-`/`PRD`/`§` cross-reference are unchanged. Typecheck + build clean (server, web and desktop).
- 2026-06-27 (security fix: privilege escalation through share tokens): `verifyToken()` (server/src/services/auth.ts)
  only checked the signature, so **any** token signed with `auth.jwtSecret` was accepted as an owner session. The
  public endpoint `POST /public/shares/:id/unlock` signs its unlock cookie with that same secret, so anyone the
  note was shared with (who therefore has the share password) could replay that JWT as a Bearer token and
  read/write the whole vault, `/api/settings`, `/api/keys` and the WS stream.
  **Fix:** (1) `verifyToken()` now requires `sub === 'owner'` and pins `algorithms: ['HS256']` (which also blocks
  alg=none). (2) `issueToken()` pins HS256. (3) Defense in depth: the unlock token now carries `sub: 'share'`, and
  `isUnlocked()` (shares.ts) verifies `sub === 'share'` plus the matching `share.id`, pinning HS256. Verified:
  owner=accept, share=reject, alg=none=reject. Typecheck clean. Reported privately by an end user following
  SECURITY.md (v0.1.0, commit 8c5c283).
  **Plus 2 low-severity hardening items from the same report:** (a) `rendercanvas.ts`: node geometry
  (`x/y/width/height`) and `textAlign` taken from the `.canvas` JSON were interpolated straight into `style="…"`
  with no escaping or type coercion, so a malicious `.canvas` (imported or downloaded, then shared) could break
  out of the attribute and inject HTML. Fix: coerce the geometry to finite numbers (`num()`) as soon as the nodes
  are parsed (which makes `style`, `bbox` and the `shifted` addition all safe), and whitelist `textAlign` ∈
  {left,center,right}. Tested: `<script>`/`onerror` payloads are neutralized. (b) `settings.ts#sanitizeVault`:
  `allowedRoots` now keeps only non-empty strings and `path.resolve`s them to absolute paths, so junk entries can
  no longer be persisted and crash `path.*`. **Deferred (item 1):** logging in through the API with the default
  password (`123456`) is a deliberate design decision ("usable right away", auth.ts §10-11), so it is not going to
  be changed silently; tightening it means updating the PRD first. Production already uses a custom password, so
  it is not exposed.
- 2026-06-24 (security fix F-03: login rate-limit bypass via `X-Forwarded-For`): previously
  `app.set('trust proxy', 1)` was always on ⇒ `req.ip` came from `X-Forwarded-For`; an instance exposed
  directly (bound to `0.0.0.0`) let an attacker set XFF freely on every request → one bucket per "IP" →
  the limit of 10 attempts per 15 minutes was bypassed (brute-forcing the 6-character default password).
  **Fixed in 3 places:** (1) `server/src/config.ts` gains `trustProxy`, parsed from the `TRUST_PROXY`
  env var and **defaulting to `false`** (do not trust XFF when there is no proxy); it accepts
  `true`, a hop count, or a subnet list. (2) `server/src/index.ts` uses `app.set('trust proxy', config.trustProxy)`
  instead of the hardcoded `1`. (3) `server/src/middleware/ratelimit.ts` keys the limiter on
  `req.socket.remoteAddress` (the TCP peer address, which **cannot be spoofed**) instead of `req.ip`, so the
  throttle holds regardless of the `trust proxy` configuration. PRD updated (FR-9 `TRUST_PROXY` env var +
  security NFR). Typecheck clean.
  **Adjusted 2026-06-27 (while merging PR #1):** since the TCP-socket rate-limit fix above already patches F-03
  regardless of `trust proxy`, the **`trust proxy` default stays enabled (`true`)** instead of flipping to
  `false`, which avoids inconveniencing the majority who run behind a reverse proxy (they would lose the
  cookie's `Secure` flag and need extra configuration). `TRUST_PROXY` can still be configured down to
  `false`/a hop count/subnets when needed.
- 2026-06-23 (fix: internal links to `.canvas` files): clicking a wikilink pointing at `Foo.canvas` navigated to
  a brand new markdown note `Foo.canvas.md`. Cause: the link graph (`keyToPath`) only indexes markdown files, so
  `/api/.../resolve` returned `null` for a target ending in `.canvas` → the client fell into the create-note
  branch and appended `.md`. Fixed in 2 places: (1) `server/src/routes/search.ts`: when `resolveLink` misses and
  the target has a **non-md** extension, fall back to `resolveFile` (the vault-wide file index) so the right
  canvas opens; bare `[[Foo]]` keeps its old behavior. (2) `web/src/lib/store.ts#openWikilink` only appends `.md`
  when the target **has no extension**, which avoids `Foo.canvas.md`. Typecheck clean.
  **Deploying turned up 2 more bugs:** (a) a note moved into `.trash` was still indexed in the link graph, so the
  junk file `Foo.canvas.md` (created by the original bug) **shadowed** the real canvas → `/api/resolve` returned
  a path inside `.trash`. Fix: skip dotfiles/dot-dirs in `listMarkdownFiles()` + `updateLinkGraphForFile()`
  (matching the tree view & fileindex). (b) `.dockerignore` did not exclude `obsvault` (a ~6 GB LFS bind-mount),
  so `COPY . .` swallowed the whole vault → the prod build hung for ~30 minutes; adding
  `obsvault`/`*.tsbuildinfo`/`desktop/dist|release` brought COPY down to ~1.5s. **Deployed & verified on prod**
  (`xnohat.i234.me:8787`): resolving `Agent SLM Business Model.canvas` opens the real canvas, with no regression
  for bare wikilinks or missing notes.
- 2026-06-22 (FR-13: cross-platform Electron desktop app, requested by the user): bundle WebObsidian into an
  installable mac/win/linux app (arm64/x64/ia32) downloadable from a GitHub Release. Added the `desktop/`
  workspace, an **Electron shell** that spawns the existing Express server as a child process
  (`ELECTRON_RUN_AS_NODE`, `127.0.0.1` + a random port) and then loads the SPA in a `BrowserWindow`, without
  changing a single line of server/web code. The key to packaging: the server has **no runtime native modules**
  (only the optional macOS `fsevents`), so esbuild can bundle it into **a single `.mjs` file**, and going
  cross-arch is just a matter of downloading the matching Electron binary (no rebuild/qemu/wine needed). The UX
  is seamless: pick the vault on first run, data goes into `userData`, and **auto-login** uses a random
  per-machine password (the JWT cookie is seeded into the session and a custom password is set automatically so
  nothing forces a password change). Packaged with electron-builder: dmg/zip · nsis/portable · AppImage/deb;
  the `release.yml` CI matrix over 3 OSes publishes a draft GitHub Release when a `v*` tag is pushed.
  **Verified for real on macOS arm64**: (1) the bundled server runs standalone → healthz `{ok:true}`, login
  override OK; (2) running Electron (unpacked) with a seeded config → the server boots on a random port,
  `userPasswordHash` is set, `mustChangePassword:false`, no errors; (3) `electron-builder --dir` →
  `WebObsidian.app` with the correct `resources/server/{dist,public}` layout, and running the packaged build
  boots the server from resources with healthz/login OK. Desktop typecheck clean. *Gotcha:* the shell had
  `ELECTRON_RUN_AS_NODE=1` set (from crawbot), which makes `require('electron')` return a string during tests,
  so launch tests have to run under `env -u ELECTRON_RUN_AS_NODE` (the packaged app is unaffected); and because
  electron is hoisted into the root node_modules, `electronVersion` has to be pinned for the builder.
  **Not done yet:** code-signing/notarization, auto-update.
- 2026-06-22 (fix for the Graph view under a CSP that forbids `unsafe-eval`): on the production host (e.g.
  `360of.me`) the Graph view was blank with the error `Current environment does not allow unsafe-eval, please
  use pixi.js/unsafe-eval module`. PixiJS v8 generates shader/UBO code with `new Function()`, which the CSP
  blocks. Fix: in `GraphView.tsx`, import `pixi.js/unsafe-eval` (the module installs the no-eval polyfill
  itself) before `app.init()`; add a `declare module` for that subpath in `vite-env.d.ts` (Pixi does not
  export `types` for it). Typecheck + build pass.
- 2026-06-19 (FR-2: audio/video embeds that actually play, like Obsidian; requested by the user): a `.mp4`
  note (Trilium export: frontmatter + `![[clip.mp4]]`) used to show only a blue link, and now renders a
  **real HTML5 player**. Three render paths were fixed: Live Preview (`MediaWidget` in `livePreview.ts`, the
  view that also backs read-only Reading), Reading/transclusion/canvas (`markdown.ts`) and the public share
  SSR (`renderhtml.ts`); all three add `<video>/<audio>/<source>` to the `rehype-sanitize` allowlist
  (otherwise the sanitizer strips the tags). Opening a media file straight from the tree now gives a player
  (`Workspace.tsx`, the same as for images). The extension set matches Obsidian (video
  `mp4/webm/ogv/mov/mkv`, audio `mp3/wav/m4a/3gp/flac/ogg/oga/opus`) and lives in `web/lib/media.ts` +
  `server/services/mime.ts`; the size param `![[clip.mp4|W]]` sets the video width.
  **The crux:** the binary serving route (`GET /api/files/content` + the raw share) moved from
  `readFileBuffer`→`res.send` (reading the whole file into RAM, no seeking) to a **stream + HTTP Range**
  (`services/httpfile.ts` → `sendFileWithRange`): it returns 206 Partial Content, so video scrubbing/seeking
  works and Safari can play at all. Verified for real: login `access` → `GET …/8257903_hd (2).mp4` (basename
  resolved from `Attachments/`, 17MB) returns 206 (`Content-Range: bytes 0-1023/17758055`, `video/mp4`,
  `Accept-Ranges: bytes`), a full GET returns 200, and an invalid range returns 416; the sanitizer leaves
  `<video>/<audio>` intact (tested through `renderNoteHtml`). A visual screenshot inside the app was not
  possible (the debug Chrome profile was locked by another instance, and killing it unprompted was off the
  table), so verification went through the bundle containing `cm-embed-video`/`media-embed` plus the
  server/sanitizer contract.
- 2026-06-19 (fix for 2 Files panel bugs: verified end-to-end with Chrome DevTools on a test vault):
  **(1) The Sort button did nothing:** the sort menu, opened with a **left click**, was closed immediately by that
  very click. `ContextMenu` attaches a `window 'click'` listener to close on an outside click; with a left click,
  by the time React commits the effect the click is still bubbling towards `window`, so the listener catches it
  and closes the menu. (The right-click menu was unaffected because a `contextmenu` event does not emit a
  `click`.) Fix: attach the closing listener on the **next tick** (`setTimeout(…, 0)`) in
  `web/src/components/ContextMenu.tsx`. Verified: clicking Sort → the menu shows all 6 items (exactly like the
  Obsidian app: File name A→Z/Z→A, Modified new→old/old→new, Created new→old/old→new) → choosing "File name
  (Z to A)" reverses the file order (folders are still grouped first).
  **(2) Drag-and-drop file moves did not work:** only **folder rows** accepted a drop; dropping a file onto
  **another file**, or into the **child area of an expanded folder**, let the drop event bubble to the root
  handler → a no-op (for the original file) or a wrong move to the vault root.
  Fix: file rows are drop targets too (`onDragOver/onDragLeave/onDrop` + a `drop-target` class), and dropping onto
  a file moves into **that file's parent folder** (which is Obsidian's behavior) in
  `web/src/components/FileTree.tsx`. Verified: dragging a root file onto a file inside the (expanded) Alpha folder
  moves it into Alpha for real (it used to stay put).
- 2026-06-18 (Phase 30: canvas interaction upgrades + canvas public share + a batch of UX fixes from ongoing
  feedback): **Canvas (M25.7–25.9):** marquee drag-select for multiple nodes + alignment snap-guides ported from
  Obsidian's `getSnapping/O3/P3` in the asar (snap on the 4 corners + the center, dist `ceil(15/scale)`, Alt
  disables snapping, Shift locks the axis); formatting shortcuts (⌘B/I/K/L/`⌘/`, `toggleWrap`) + text alignment
  (`TextNode.textAlign`, a selection-menu button + a submenu).
  **Canvas public share (an extension of FR-10):** `server/src/services/rendercanvas.ts` renders a `.canvas` into
  static HTML (absolutely positioned nodes + SVG edges, text/embeds through `renderNoteHtml`, images allowlisted
  through `canvasEmbedTargets`); `sharepage.ts` gains a canvas branch (`bare` layout, og:meta) and `shares.ts`
  allows `.canvas`; the client offers "Share…" for canvases too (Workspace + FileTree). Verified end-to-end over
  CDP: creating a share → `/share/:id` returns HTTP 200 and renders every node/edge/arrow + og:title.
  **UX fixes:** (a) bigger edge arrowheads; (b) the card right-click menu opens at the cursor and is clamped
  inside the screen (fixed + measured); (c) **collapsing the left panel no longer leaves a gap on the right**:
  the `.app` grid switched to columns driven by the `--sidebar-width/--right-width` variables with a pinned
  `grid-column` per column (the editor column is always `1fr`); (d) **the left sidebar can be resized by
  dragging** (`.sidebar-resizer`, clamped to 180–560px, saved in `localStorage`); (e) the redundant **Refresh**
  button was removed from the Files header (Sync below it already covers it); (f) **fixed the duplicate
  Attachments/attachments folders**: uploads now resolve the directory **case-insensitively**
  (`vault.resolveDirCaseInsensitive`), so an existing folder is reused instead of a duplicate being created.
  Typecheck + build (server + web) clean.
- 2026-06-15 (Phase 29: sort by modified/created time, kept fast by a stat cache): added 4 time-based sort
  options (Modified/Created · new→old / old→new) to the Files header dropdown. **Fast**: the server keeps a
  `statCache` (Map path→{mtime,ctime}) in RAM, which `listTree()` fills once (stat calls run in parallel per
  directory) and the steady state reads from the cache, so 0 syscalls; the watcher calls `invalidateStat(rel)`
  on file add/change/unlink, so only the file that actually changed is re-stat'ed. That completely avoids the
  27k-stats-per-fetch problem the old comment warned about. `TreeNode` gains `ctime` (the server takes
  `birthtimeMs || mtimeMs`). Sorting happens client-side, recursively per folder (folders are always grouped
  first and sorted by name; files use the chosen criterion), which matches Obsidian in sorting only the items
  **currently present** in the panel (collapsed ones are not rendered). `treeSort` grew to 6 values and is
  persisted. Typecheck + build clean.
- 2026-06-14 (Phase 28: file tree header toolbar parity with Obsidian, requested by the user): rebuilt the
  Files sidebar header with the full set of Obsidian buttons: **New note** (`square-pen` icon), **New canvas**
  (`layout-dashboard`), **New folder** (`folder-plus`), **Change sort order** (dropdown: File name A→Z / Z→A,
  with a ✓ on the current item; `treeSort` is persisted, sorting is recursive and client-side, folders always
  first), **Auto reveal current file** (the persisted `autoReveal` toggle, which expands ancestors and scrolls
  to the active file whenever the file changes), **Collapse all / Expand all** (a single button that flips
  based on `expanded.length`; expand-all collects every folder path through `collectFolderPaths`), plus the
  existing Refresh/Trash. Store: `setExpanded`, `treeSort/setTreeSort`, `autoReveal/toggleAutoReveal` (added to
  PERSIST_KEYS + applyPersisted). CSS: `.nav-header` gets `flex-wrap` (so 8 buttons do not overflow on mobile),
  `.nav-action.active` gets the accent color. NOTE: sorting by modified/created time is not done yet because
  the server deliberately does not stat the mtime of every file (~27k files → 27k syscalls on every tree
  fetch). Typecheck + build clean; the bundle contains all the button strings.
- 2026-06-14 (Phase 27: canvas mobile edit-save + a New canvas button, from user feedback): (1) **fixed
  Android Chrome losing text when a node was edited by double-tap**: the cause is that a `<textarea>` blur
  usually does NOT fire when the Android soft keyboard closes, so the edit was lost. Added
  `commitTextEdit()` (idempotent, guarded by `editingNodeRef`) to funnel every save path, plus a
  **capture-phase `pointerdown` listener on document** (active while editing): a tap/click outside the textarea
  (except on `.canvas-textmenu/.canvas-linkpicker/.canvas-notepicker`) commits. onBlur and linkPicker-dismiss
  now route through `commitTextEdit` as well. (2) **touch double-tap is detected manually** in `beginNodeDrag`
  (2 taps under 350ms on the same node) → `activateNode` (text→edit, file→open, link→open), because Android
  does not emit a reliable `dblclick`. (3) a **"New canvas" button** (`layout-dashboard` icon) in the Files
  sidebar header next to New note/New folder, since a canvas could previously only be created through
  right-click, which is not available on mobile. Typecheck + build clean; the bundle contains the tap-outside
  selector and the 350ms threshold.
- 2026-06-14 (Phase 26: images: resize + zoom lightbox, requested by the user): (1) **drag to resize** an
  embedded image: two handle bars on the left/right appear on hover in Live Preview, dragging changes the width
  (clamped to 40..the content width, with the aspect ratio kept by leaving height auto) and the result is
  **written back into the source** as an Obsidian size param through `writeImageWidth()`: `![[img|W]]` for a
  wikilink embed, `![alt|W](url)` for a markdown image (the widget position is recovered through `posAtDOM` and
  the token covering it is re-matched). (2) **Size params for markdown images** `![](…)`: an alt carrying
  `|W`/`|WxH` now applies width/height in both Live (imgRe) and Reading (markdown.ts), whereas only `![[…]]`
  supported it before. (3) **Lightbox zoom** (`lib/imageLightbox.ts`): clicking an image in either mode opens a
  full-screen overlay; wheel zoom around the cursor, two-finger pinch around the pinch center, drag/one-finger
  panning, double-click to reset, Esc/backdrop click/× to close. Typecheck clean. Built + deployed to prod.
- 2026-06-13 (Phase 25s: canvas drag handle + fix for nodes clipped on the left on mobile): (1) a **drag
  handle** (a dotted grip) floating above every node, so a tap/press-and-drag moves the node (handy for touch);
  it shows on hover/selection and is **always visible on mobile**; `onPointerDown→beginNodeDrag`,
  `touch-action:none`. (2) **fixed a slice being cut off the left of nodes at certain zoom levels on mobile
  Safari**: `.canvas-world` was `width:0;height:0`, so Safari clipped scaled descendants that sat left of or
  above the origin; it is now `width:100%;height:100%;overflow:visible`. Smoke test (390px viewport): nodes
  render with their full left border; the grip drags a node by touch +200/+150 and by mouse −150/−100;
  background panning still gives +120; no console errors. Typecheck + build clean. Deployed to prod.
- 2026-06-12 (Phase 25r: canvas on mobile: pinch-zoom + non-overlapping toolbars): on a phone the canvas
  could not be pinch-zoomed (`touch-action:none` blocks the browser gesture) and the two bottom toolbars
  overlapped. Fix: (1) **pinch-to-zoom + two-finger pan** through a **capture-phase** pointer listener on the
  viewport (the second finger cancels the one-finger drag and starts the pinch, and it works even when the
  fingers land on a node); one-finger panning still uses the old pointer drag. (2) `@media
  (max-width:768px)`: the **zoom toolbar (bottom-left)** and the **add toolbar (bottom-right)** are separated,
  with bigger touch targets. Smoke test (390px viewport, synthetic touch): pinch scales 1.5→4 and 4→0.8;
  one-finger panning gives the right Δx; the toolbars sit in two corners; no console errors. Typecheck + build
  clean. Deployed to prod.
- 2026-06-12 (M3.6: Trash UI + deleteMode, requested by the user): added the `vault.deleteMode` setting
  (`trash` by default | `permanent`), so DELETE `/api/files/` branches between trash and `vault.remove()` for a
  real delete. Vault service: `listTrash/restoreFromTrash/deleteFromTrash/emptyTrash` (+ `pruneEmptyDirs` and
  the `assertInTrash` guard, which prevents operating outside `.trash`). Routes `/api/files/trash` (GET list ·
  POST restore · DELETE item · DELETE empty). Frontend: `api.listTrash/restoreTrash/deleteTrashItem/emptyTrash`,
  the `trashOpen/setTrash` store entries, and a `TrashView` modal (Restore / delete permanently / Empty trash)
  opened from the 🗑 button in the Files header or the "Open trash" command in the palette. Settings → Vault &
  Files gains a delete-mode select. The confirm/notify text in the file tree + pane menu switched to a generic
  "Delete" and reports "Moved to trash" / "Deleted permanently" based on the response. Verified end-to-end with
  curl on a temporary vault: the trash listing preserves the directory structure, restore avoids name
  collisions and prunes empty dirs, permanent mode really deletes (no copy is kept), empty trash works, the
  "Not a trash item" guard fires, and a PUT of deleteMode leaves `vault.path` untouched. Typecheck clean in
  both workspaces.
- 2026-06-12 (Phase 25q: canvas external links open in a new tab + zoom-to-fit on open, from feedback):
  (1) an **external link** (`http(s)://`) inside a card → `onClickCapture` on the node calls
  `window.open(href,'_blank')` to open a new browser tab (a wikilink with href="#" still falls through to
  openWikilink). (2) **Opening a canvas now zooms to fit**: the hard view reset to {60,60,1} was dropped and a
  `fittedFor` effect calls `zoomFit()` once per canvas (on a rAF after the data is parsed and the viewport has
  a size). Smoke test: a canvas with 2 far-apart nodes opens at 53%, fitting both; clicking an external link
  calls window.open with _blank; no console errors. Typecheck + build clean.
- 2026-06-12 (Phase 25p: fix for clicking a wikilink inside a canvas card): clicking `[[link]]` in a text card
  did not navigate, because a real click jitters by more than 1px, which triggered the lazy
  `setPointerCapture` (node move) and retargeted the click away from the link. Fix: in `beginNodeDrag`, if the
  pointerdown landed on `[data-wikilink]`/`a`, **return early** (no drag/capture is started and no
  stopPropagation happens), letting the click reach Preview.onClick → `openWikilink`; the viewport still does
  not pan (the target is inside .canvas-node). Smoke test: a real CDP click on the "NoteA" link in a card
  navigates to `/note/NoteA.md`; no console errors. Build clean.
- 2026-06-12 (Phase 25o: canvas "Add link" opens a note search dropdown, like Obsidian): "Add link" now opens
  a **note search dropdown** (reusing the notepicker style) at the caret instead of merely wrapping the text in
  `[[]]`. The caret is saved (`linkInsertPos`), `onBlur` is guarded while the dropdown is open (so the card
  stays in editing mode), and picking a note inserts `[[basename]]` at the caret and refocuses; Esc/clicking
  the background closes and commits. The search filters on path; Enter picks the first item; items use
  `onMouseDown preventDefault`. Smoke test: Add link → the dropdown lists the notes (K.canvas/NoteA/Task);
  typing "task" narrows it to Task; picking it inserts `[[Task]]`; no console errors. Build clean.
- 2026-06-12 (Phase 25n: canvas text menu: Add link/external promoted to the top level): in Obsidian,
  **Add link** (`[[…]]`) and **Add external link** (`[…](https://)`) are first-level items at the top of the
  menu rather than living under Insert, so they were moved to the top level and removed from the Insert
  submenu. Smoke test: the top-level menu is Add link/Add external link/(divider)/Format/Paragraph/Insert/(divider)/
  Cut/Copy/Paste/Select all; Add link produces `[[word]]`; no console errors. Build clean.
- 2026-06-12 (Phase 25m: easier canvas resizing, from feedback): the mid-edge handles used to be **covered by
  the connection ports** (z-order), so only the 4 small corners could be dragged. Now it matches Obsidian:
  **4 clear corner handles** (12px, white background + accent border, z8 above the ports) for diagonal
  resizing + **edge drag strips** (`.canvas-edge-resize` n/s/e/w, inset 12px from the corners, z6 below the
  ports so the mid-edge dots remain available for connecting). Also fixed resizes not being saved (the commit
  used `dataRef`, which lagged by a frame): `resizeRect()` was split out to compute from the event
  coordinates, and the commit happens on pointerup from the event (robust). Smoke test: selecting a node shows
  4 corners + 4 edge strips; dragging the SE corner +120/+80 goes 240×140 → 360×220 and autosaves correctly;
  no console errors. Typecheck + build clean.
- 2026-06-12 (Phase 25l: hierarchical canvas text-card menu cloned from the Obsidian bundle): the
  `obsidian.asar` i18n was reverse-engineered to get the exact editor menu structure, and the menu is now
  **hierarchical** (`TextFormatMenu`, with submenus opening to the right on hover) and matches Obsidian
  exactly: **Format›** (Bold/Italic/Strikethrough/Highlight/Code/Math/Comment/(divider)/Clear formatting),
  **Paragraph›** (Bullet/Numbered/Task list/(divider)/Heading 1-6/Body/(divider)/Quote), **Insert›** (Add link/Add external
  link/(divider)/Table/Callout/Code block/Math block/Horizontal rule/Footnote), (divider), Cut/Copy/Paste/Select all.
  Helpers: `setLinePrefix` (replaces the heading/list/quote prefix at the start of the line),
  `insertAtCaret`, `clearFormatting`, and clipboard execCommand. The textarea keeps focus as before
  (mousedown preventDefault). Smoke test: right-clicking a "hello world" card shows the 3 submenus +
  clipboard items; Paragraph›Heading 2 gives `## hello world`, which renders as `<h2>` on blur; no console
  errors. Typecheck + build clean.
- 2026-06-12 (Phase 25k: canvas text-card format menu, from feedback): right-clicking **inside a text card
  that is being edited** opens a markdown formatting menu like Obsidian's: Bold/Italic/Strikethrough/
  Highlight/Code (wrapping the selection in `**`/`*`/`~~`/`==`/`` ` ``), Heading/Bullet list/Quote/Checkbox
  (line prefixes), Link/Wikilink. The menu uses `onMouseDown=preventDefault` so the textarea **does not blur**
  (keeping focus + selection); `applyFormat` edits `textarea.value` directly (uncontrolled, committed on blur).
  The menu closes on a background click or on blur. Smoke test: editing the "hello world" card, selecting all
  and right-clicking shows all 11 items; Bold gives `**hello world**`, which renders as `<strong>` on blur and
  autosaves correctly; no console errors. Typecheck + build clean.
- 2026-06-12 (Phase 25j: canvas colored-node styling + a node right-click menu, from feedback): (1) a colored
  node now shows a **uniform 3px colored border around the node + a light tinted background**
  (`color-mix --c 10%`) instead of a left-edge stripe, scoped with `:not(.canvas-group)` so groups are not
  overridden. (2) **right-clicking a node opens a full context menu** (through the store's `openContextMenu`):
  Edit/Open/Open link (depending on the node type), **Set color** (a submenu with Default + the 6 colors),
  **Duplicate** (copies the node + its internal edges, offset by 40px, with new ids), Zoom to selection,
  **Bring to front/Send to back** (z-order is the array order), **Align** (left/center-h/right/top/center-v/
  bottom, when several are selected), Remove. Added `selRef` (always the current selection) so the menu
  callbacks/handlers act on the right selection (fixing the stale case when right-clicking an unselected
  node). Smoke test: colored nodes have a 3px border + tinted background; the menu shows every item;
  Duplicate goes 2→3 nodes and autosaves correctly; no console errors. Typecheck + build clean.
- 2026-06-12 (Phase 25i: proper canvas color picker + custom colors, following Obsidian): the color palette
  now has **default (gray) + 6 preset colors + a custom button (a rainbow ring)** wrapping an
  `<input type=color>` for picking an arbitrary color (the hex is stored in `color`, which JSON Canvas
  supports and Obsidian can read). The selected swatch gets an **accent ring** (matched against the color of
  the selected node/edge; a hex value puts the ring on the custom button). Smoke test: opening the palette
  shows 8 swatches + the color input, with the ring on "Color 2" (a color-2 node); setting the custom
  `#1e90ff` writes `color:"#1e90ff"` correctly and the card turns blue; no console errors. Typecheck + build
  clean.
- 2026-06-12 (Phase 25h: canvas fixes from feedback): (1) the canvas background is white
  (`--background-primary` instead of `--background-secondary`). (2) connector labels **lost their border**
  (just text on the line, still with a translucent background for readability). (3) **the bug where
  double-clicking a card created a new card** instead of editing it: the cause was `beginNodeDrag` calling
  `setPointerCapture` right at pointerdown, which retargeted click/dblclick to `.canvas-view`, so the node's
  `onDoubleClick` (edit) never ran and the background handler created a new card instead. Fix: **capture
  lazily**, only calling `setPointerCapture` on the first real move (mode 'move') rather than at pointerdown.
  Double-clicking the background still creates a node at the click point (as in the Obsidian app). Smoke test:
  double-clicking a card edits it and nodeCount stays 1; double-clicking the background creates a new card in
  edit mode; label border=none; white background; no console errors. Typecheck + build clean.
- 2026-06-12 (Phase 25g: canvas connect-to-anchor parity, reverse-engineered from Obsidian): the user
  reported that dragging from an anchor to another node "only shows a dashed line". Testing confirmed the edge
  WAS still created, but the UX was missing: the target node showed no anchors and the line did not snap.
  Reverse-engineering `app.css` showed that Obsidian has an **`is-connecting`** canvas state in which every
  node shows its `canvas-node-connection-point` and the target anchor lights up. Cloned: a `connecting` state
  (turned on when a connect/reconnect begins) makes **every node show its 4 anchors** while dragging; move
  computes the `nearestSide` of the target node so the preview line **snaps to that anchor**, which also gets
  the `.active` class (bright + glow); the drop connects to the anchor nearest the cursor (both connect and
  reconnect use `nearestSide(over, cursor)`). The old inline `reconnectEdge` was removed. Smoke test: mid-drag
  there are 8 anchors (2 nodes), B.left is `.active` and the preview snaps; releasing creates the edge
  `a:right→b:left` on the right anchors; no console errors. Typecheck + build clean.
- 2026-06-12 (Phase 25f: canvas bidirectional arrows + dragging endpoints to reconnect, from feedback):
  (1) **the double-headed arrow did not show**: `orient="auto"` on the marker made the arrowhead at the `from`
  end point the wrong way and hide behind the node → switching to `orient="auto-start-reverse"` (the SVG
  standard for double-ended lines) makes bidirectional edges show arrows at both ends. (2) **arrow ends can
  now be dragged** like in Obsidian: a selected edge shows 2 endpoint dots (circles with
  vector-effect non-scaling-stroke); dragging an endpoint and dropping it on another node **reconnects** it
  (changing from/to-Node + the nearest side); dropping it on empty space opens an **Add card / Add note from
  vault** menu that creates a new node at the drop point and connects it immediately (a card goes straight
  into edit mode; a note opens the picker through `pendingConnect`). The dragged line previews in real time.
  The pointerup connect/reconnect path was refactored to compute the target from the event coordinates
  (dropping the dependency on the `connectTo` state, which lagged by a frame, making it robust). The drop menu
  is clamped inside the viewport. Smoke test: zoom-fit shows arrows at both ends; dragging an endpoint onto
  Other reconnects it (toNode=c); dragging into empty space → menu → Add card creates a connected node
  (4 nodes, edge.toNode = the new node) and autosaves correctly; no console errors. Typecheck + build clean.
- 2026-06-12 (Phase 25e: canvas arrow-direction dropdown matching Obsidian): the arrow-direction button used
  to cycle on each press and is now a **3-option dropdown**, exactly like Obsidian: **Nondirectional**
  (no arrow), **Unidirectional** (→ arrow at the `to` end), **Bidirectional** (⇄ both ends), with a ✓ on the
  current item; the toolbar button icon follows the state. Added the `minus` icon. CSS
  `.canvas-dir-menu/.canvas-dir-item`. Smoke test: selecting an edge and opening the dropdown shows 3 items
  with ✓ on Unidirectional; picking Bidirectional gives 2 arrow markers, closes the dropdown and autosaves
  `fromEnd/toEnd=arrow`; no console errors. Typecheck + build clean.
- 2026-06-12 (Phase 25d: canvas edge label/menu fixes, from feedback): (1) **the label now sits exactly in the
  middle of the line**: it used to use the Bézier t=0.5 point (which is off-center) and now uses the
  **arc-length midpoint** (`bezierArcMidpoint`, sampling 24 segments and walking half the arc length); a
  200×32 foreignObject + a flex-centered wrapper puts the chip dead center on the curve (verified
  distToLine=0). (2) added a **Remove label (X)** button to the edge menu when the edge has a label (matching
  Obsidian: trash·palette·zoom·⇄·X·pencil). (3) the arrow-direction button switched to the
  **⇄ (arrow-left-right)** icon, and the toggle can now produce arrowheads on both ends (verified
  marker-start+end). Clicking a label selects the edge, double-clicking edits it. Smoke test: the label is
  0px off center, direction→bidirectional works, remove label hides the button and deletes the label,
  autosave is correct, no console errors. Typecheck + build clean.
- 2026-06-12 (Phase 25c: deep canvas parity, reverse-engineering the Obsidian app as requested): extracted
  `obsidian.asar` (`app.css`/`i18n.js`) to get the exact Canvas menu vocabulary (`actionRemove`/
  `actionSetColor`/`actionZoomToSelection`/`actionEditLabel`/arrow ends `none|arrow`) and to confirm that the
  6 preset colors are red/orange/yellow/green/cyan/purple (they already matched). **(1) An Obsidian-style
  selection menu** floats above the selection and works for nodes as well as **edges** (edges previously had
  no delete button, hence "can't delete the connector"): Remove, Set color (the palette opens a row of
  swatches), Zoom to selection; edges additionally get **Arrow direction** (cycling
  toEnd→both→fromEnd→none) and **Edit label**. The menu position is computed from the selection bbox,
  including edge endpoints. **(2) Undo/redo**: a serialized stack (≤200), where `commit` pushes history and
  clears the redo stack; `undo`/`redo` plus the **⌘Z/⌘⇧Z/⌘Y** keys, ↶↷ buttons in the zoom bar (disabled when
  empty), and the stack is cleared when the file changes. Added the `palette` + `zoom-in` icons (Lucide) to
  Icon.tsx. Smoke test: selecting an edge shows every button; Remove deletes the edge, Undo restores it, Redo
  deletes it again; no console errors. Typecheck + web build clean.
- 2026-06-12 (Phase 25b: canvas UX from user feedback): (1) an **add** bar at the bottom center, like
  Obsidian's, with 3 buttons: **Add card / Add card from note / Add image** (split away from the zoom cluster
  in the bottom-left). "Add card from note" opens a search popup listing the vault files (notes + images) and
  inserts a file node at the center of the view; "Add image" opens a file dialog → `api.upload` → inserts an
  image node. (2) **Drag the background to pan the viewport** (Space used to be required): dragging empty
  background pans, **Shift+drag** marquee-selects, and clicking the background without dragging clears the
  selection; the cursor is `grab`/`grabbing`. `setPointerCapture` is wrapped in try/catch (robust against
  synthetic/inactive pointers). Browser smoke test: panning changes the transform by the right delta, Add note
  inserts an embed, Add image renders an image node, and autosave writes the text node plus both file nodes;
  no console errors. Typecheck + web build clean.
- 2026-06-12 (Phase 25: Canvas FR-12, cloning Obsidian Canvas): added `web/src/lib/canvas.ts` (reads/writes
  the open **JSON Canvas** `.canvas` format, tab-indented exactly like Obsidian, parses safely down to
  `{nodes:[],edges:[]}`, the 6 preset colors, Bézier edge geometry per side + auto-side + nearest-side,
  bbox/fit) and `web/src/components/CanvasView.tsx` (~620 lines): an infinite pan/zoom surface (wheel zoom
  centered on the cursor, background drag/space+drag to pan) with a dotted background grid that scales with
  zoom; nodes are absolutely positioned DOM inside a transform layer, edges are drawn in SVG (the layer below)
  as curves with `marker` arrowheads; node types are **text** (Preview markdown / textarea editing), **file**
  (note=Preview embed, image=`<img>`), **link** (a card) and **group** (a translucent background behind
  everything); cards are created by double-clicking the background or with the + button, and there is group
  drag-move, 8 resize handles, 4 edge dots to drag out an edge, double-click on an edge to edit its label,
  marquee + Shift multi-select, a floating color/delete toolbar, and Delete/Backspace to remove. Autosave is
  debounced at 900ms through the store's `content`/`save` (`.canvas` is already in `TEXT_RE`), so no new API
  was needed. Wired `Workspace` to render CanvasView for `.canvas`; the `newCanvas` store action; "New canvas"
  in the FileTree context menu (file/folder/vault root) + the command palette. CSS `.canvas-*` in obsidian.css.
  Typecheck + web build clean; browser smoke test (on a temporary vault): groups/edges with arrows/labels/note
  embeds render correctly, zoom-to-fit works, creating a card and changing its color works, and autosave
  round-trips valid JSON Canvas (keeping the existing nodes/edges intact); no console errors. PRD bumped to 1.0
  + FR-12.
- 2026-06-12 (security hardening: repo-wide audit): no secrets are exposed in git (history + tracked files
  are clean; `data/`/`.env`/`.claude/skills/` are gitignored). Nine things were fixed: **(1)** force a password
  change while the default `123456` is still in use: `/auth/login`+`/me`+`/status` return
  `mustChangePassword` and the web app blocks with `ForceChangePassword` (it still binds 0.0.0.0).
  **(2)** redact the git PAT (`https://<token>@…`) from every error returned to the client and from the logs
  (`lib/redact.ts`, used in `errorHandler` and in `git.ts` sync/autosync). **(3)** `helmet` + a CSP
  (script-src 'self'+nonce; NO `upgrade-insecure-requests`, so plain HTTP self-hosting keeps working; a nonce
  for the inline script on the `/share` page). **(4)** rate-limit `/auth/login` to 10 attempts per 15 minutes
  per IP (`middleware/ratelimit.ts`). **(5/6)** validate the plugin `id` (`^[a-zA-Z0-9._-]+$`) both at install
  time (where manifest.id is remote) and when serving assets → blocks path traversal on read and write.
  **(7)** `/ws` now requires the auth cookie at the upgrade step. **(8)** `resolveInVault` rejects a `.git`
  segment (RCE through hooks) and has a realpath guard against symlinks escaping the vault. **(9)** changing
  `vault.path` through the API requires a path inside allowedRoots that is an existing directory. Typecheck +
  build clean; a smoke test verified all of it. PRD §Security updated.
- 2026-06-12 (Phase 24: Copy/Cut/Paste for files & folders in the file tree context menu): the store gains
  `clipboard {path, mode}` + `setClipboard` (session-local). FileTree: `doClipboard('copy'|'cut')` sets the
  clipboard and shows a toast; `doPaste` pastes into the target folder, where Cut = `api.rename` (a move, with
  folder support, blocking a paste into itself or a descendant, and a paste back into the same place is a
  no-op) and Copy = recursive `api.copy` with `uniqueChildName` avoiding name collisions. File menu:
  Copy/Cut/Paste; folder menu: Copy/Cut/Paste. A row that was Cut is dimmed, and Paste only appears when the
  clipboard holds something. Server: `vault.copy` (recursive `fs.cp` returning the list of created files) +
  the `POST /api/files/copy` route (reindexes the new `.md` files, auto-commits); client `api.copy`. PRD 0.9
  (FR-1 + an API row). Follow-up (M24.4): right-clicking empty space in the file tree opens the app menu
  (New note/New folder/Paste into the vault root) instead of the browser's native menu. Typecheck clean for
  server + web.
- 2026-06-12 (New folder without a prompt + inline rename in the folder tree): the `newFolder(dir?)` store
  action creates an "Untitled" folder directly (incrementing to "Untitled 1/2…" on collisions), expands the
  ancestors, opens the Files panel and then sets `renamingPath` to the new path. FileTree gains a
  `RenameInput` component (an accent-bordered input replacing `.name`): autofocus with the name part
  preselected (keeping the file extension), Enter/blur → `api.rename`, Escape → cancel; stopPropagation keeps
  a click/pointerdown from toggling or opening the row. The store gains the `renamingPath` state +
  `setRenamingPath`. The "New folder" menu item (FileTree) and the New folder button (Sidebar) call
  `newFolder()`, dropping `prompt('Folder name')`. While at it, "Rename…" for files/folders switched to inline
  renaming (dropping the path prompt); "Move to…" remains for changing the folder. CSS `.tree-rename`.
  Typecheck + web build clean.
- 2026-06-12 (New note without a prompt + tab-bar controls no longer hidden by the scrollbar): (1) added the
  `newNote(dir?)` store action, which creates an "Untitled.md" note directly (incrementing to
  "Untitled 1/2…" on collisions within the target folder) with an empty body, so the inline-title shows the
  file name the way Obsidian does and `prompt('Note name')` is gone. Every call site was updated: ⌘N
  (App.tsx), the command palette, the tab-bar "+", the Sidebar Files header, the FileTree context menu (New
  note inside a folder → `newNote(node.path)`) and the FolderView header. The prompt is kept for New folder
  and for auto-creating by name when clicking a wikilink that does not exist yet. (2) Tab-bar: the tab list is
  wrapped in `.tab-scroll` (overflow-x:auto with the scrollbar hidden via `scrollbar-width:none`), and the
  control buttons (left/right toggles, "+" new note) get the `tab-ctl` class with flex-shrink:0 and sit
  outside the scrolling area, so the scrollbar no longer eats their height and they do not scroll out of view
  when there are many tabs. Web typecheck clean.
- 2026-06-12 (Phase 23: Render HTML block): notes imported from Trilium contain a full HTML page (SingleFile)
  inside a ` ```html ` fence, and a button to render the block was requested. The first attempt wrongly
  patched `Preview.tsx` (that component is now used ONLY for the share page; the real Reading mode is the
  readonly CodeMirror editor, M18.14). The correct fix: add `htmlPreviewField` (a StateField widget) to
  `livePreview.ts` and register it in `Editor.tsx`. The button goes above the block (side:-1) because
  CodeMirror virtualizes the DOM, so a button placed after an enormous block would be outside the viewport.
  The iframe is sandboxed with `allow-scripts` but not same-origin (isolated). The button in `Preview.tsx` was
  kept for `/share`. Verified end-to-end with chrome-devtools (login pw 123456): the button appears and
  clicking it renders the page in the iframe. Build clean.
- 2026-06-12 (folder deep-link → Folder view): opening a URL pointing at a folder (`/note/<folder>`) used to
  render an empty note (the Editor) named after the folder. Added `lib/tree.ts` (`findNode`/`isFolderPath`) +
  a `FolderView.tsx` component that lists the folder's contents (subfolders + notes, folders sorted first;
  image thumbnails; drag-and-drop enabled; a + button to create a note inside the folder). `store.openFile`
  detects a folder through the tree, skips `api.read` and does not add it to Recent. Workspace renders
  FolderView when `isFolderPath(tree, activePath)` and hides the ⋯ button (the file menu does not apply to a
  folder). Typecheck + build clean.
- 2026-06-12 (Phase 22: Move file to… + Bookmarks/Recent context menu): "Move file to…" used to be a
  `prompt()` where the path had to be typed by hand, and it is now an Obsidian-style folder-picker modal
  (`FolderPicker.tsx`, mounted in App next to ContextMenu): type to filter folders, ↑↓ to select, ↵ to move,
  ⇧↵ to create a new folder with the typed name and then move (vault.rename creates the parent directories
  itself), esc to close. State goes through `store.movePath`/`setMovePath` (not persisted). The ⋯ menu
  (Workspace) and the file tree right-click menu (FileTree) now only call `setMovePath(path)`. The
  Bookmarks/Recent panel (`BookmarksPanel.tsx`) gains `onContextMenu` → `openContextMenu` (right-click used to
  fall through to the browser's native menu): Open/Open to right/Reveal/Move file to…/Bookmark/Copy path;
  Recent also gets "Remove from recent" (`store.removeRecent`). Also added: Bookmark/Recent rows are
  `draggable` (drag onto a folder in the file tree to move, sharing the `text/wo-path` payload) + hover
  buttons on each row (📁 Move / ✕ Remove). Typecheck + web build clean.
- 2026-06-12 (Copy path → Copy URL path): the file right-click menu (FileTree), the ⋯ menu (Workspace) and the
  Bookmarks/Recent panel changed "Copy path" to "Copy URL path", copying the full deep-link
  `${location.origin}${pathToUrl(path)}` (e.g. `http://localhost:8787/note/...`) instead of the vault path.
  The folder right-click menu keeps "Copy path" (a folder has no note URL). Typecheck + build clean.
- 2026-06-12 (a toast for "Rebuild search index"): the reindex command (~12s on a 6000+ note vault) used to
  run silently with no UI feedback. `notify()` (store.ts) gains an `ms` parameter (default 2500, `0` = keep
  until it is replaced). CommandPalette shows "Rebuilding search index…" (persistent) when it starts and
  switches to "Search index rebuilt" when it finishes (or "Failed to rebuild…" on error). Typecheck + web
  build clean; the output goes to server/public, so only a reload is needed, not a server restart.
- 2026-06-11 (fix for "Path outside allowed roots" when browsing for a vault): the folder browser
  (`/api/settings/browse`) only allows navigation inside `vault.allowedRoots`, but the default roots are
  derived from `sample-vault`, so a vault outside that (e.g. `~/ObsidianVault-Trilium`) got a 403. Root fix:
  added `ensureVaultBrowsable()` (services/settings.ts), which adds the vault's parent directory to
  `allowedRoots` when it is not already covered. It is called when the vault path is saved
  (routes/settings.ts) and backfilled in `loadSettings` to heal older files. Rebuilt + restarted the server;
  settings healed themselves (`allowedRoots` gained `/Users/xnohat`).
- 2026-06-11 (fix for search returning 0 results): server/data/qmd-index.json had been persisted empty
  (`documentCount: 0`, probably because the build ran while the temporary vault was unreadable).
  `QmdEngine.restore()` loaded that empty index and then set `ready=true`, so every query returned 0 and it
  never rebuilt. Fix: `restore()` now treats a 0-document index as a cache miss (`return false`) so
  `initSearch()` rebuilds from the vault. Reindexed live (6048 docs). Server typecheck clean.
- 2026-06-11 (M2.5: change password + default password + override): a new auth model. The default login
  password is `123456` (no setup step needed); a changed password is stored in `auth.userPasswordHash` (empty
  = still the default). `auth.passwordHash` (in settings.json, edited by hand) and the `WEBOBSIDIAN_PASSWORD`
  env var are now recovery override passwords that login always accepts. Server: `checkPassword` checks the
  effective password plus the 2 override sources (`auth.ts`); a `POST /auth/change-password` endpoint
  (requireAuth, verifies the old password); bootstrap no longer seeds a password; `redactSettings` returns
  `hasCustomPassword`/`hasOverridePassword`. Migration in `loadSettings`: an older file with `passwordHash`
  gets it moved to `userPasswordHash` (so 123456 is not left as a backdoor) and re-persisted. Web:
  `api.changePassword`, a Settings→Account tab with the change-password form + a warning while the default
  password is still in use. Typecheck clean in both workspaces. PRD FR-3 + data model updated.
- 2026-06-11 (M19.7: mobile parity round 2): patched the 3 mobile bugs the user reported. (1) The note "…"
  menu was cut off at the bottom of the screen: `ContextMenu.tsx` clamps `x/y ≥ 8px` and caps the estimated
  height against the viewport (so top is never pushed negative), and the mobile CSS adds
  `max-height: 100dvh; overflow-y:auto` to `.context-menu` (desktop hover submenus are unaffected thanks to
  the media query) plus 9px rows that are easier to tap. (2) Note content could be dragged sideways
  (panning/skewing the layout): locked with `overflow-x:hidden` + `max-width:100vw` on
  `.cm-host`/`.markdown-preview`, text wrapping with `overflow-wrap:anywhere`, images at `max-width:100%`,
  tables at `display:block; overflow-x:auto`, and code keeping its internal scroll; `.prop-key` gets
  min-width 92px and prop-row wraps. (3) The Settings & Version history modals overflowed the right edge:
  `position:fixed; inset:0` full-screen, settings-nav becomes a horizontally scrolling strip, `.setting-row`
  stacks vertically with full-width inputs (overriding the inline widths 260/120), the version-history list
  sits above the preview, and the share dialog is full-width; safe-area top for nav/head. Web build clean
  (7.4s).
- 2026-06-11 (descriptive commit messages): vault commits now generate a title that names which notes changed
  instead of the generic "WebObsidian auto-sync". `describeChanges(StatusResult)` groups files by
  Added/Modified/Deleted/Renamed into a one-line subject (`Add <note>` /
  `Sync N notes (3 new, 2 edited): a, b, c +X more`) plus a body listing every path (capped at 100).
  `commitAll()` uses the generated subject when no manual message is given; the generic messages were removed
  from autosync/auto-commit-on-save/the Commit button. This also feeds the Version History UI.
- 2026-06-11 (Phase 21: pane ⋯ menu parity): filled in the three-dot menu in the note's top-right corner to
  match the Obsidian app (requested by the user). New: **Find/Replace** inside a note (`@codemirror/search`,
  panel at the top, the "Find…" item → `editorFind()`); **Reveal file in navigation** (`store.revealInTree`
  opens the ancestor folders + scrollIntoView + flash, FileTree listens for `wo-reveal-file`, rows carry
  `data-path`); **Add file property** (inserts an empty key into the YAML frontmatter, creating the block if
  there is none); **Export to PDF** (Reading view → `window.print()` + CSS `@media print` that prints only the
  note content); **Open version history** (server-side `git.log`/`git.showFile` + routes
  `/api/git/log|/show`, the `VersionHistory.tsx` modal listing commits + preview + Restore); **Open in new
  window** (`window.open(/note/<path>)`); **Backlinks in document** + an **Open linked view** submenu
  (→ `setRightPanel`). The menu was rebuilt in Obsidian Desktop's group order. "Reveal in Finder"/"Open in
  default app" were skipped (desktop-only, not meaningful on the web). Typecheck clean in both workspaces.
  PRD bumped to 0.6 (FR-2/FR-4).
- 2026-06-11 (deploy hardening for open-source self-hosting): reviewed what breaks when deploying to a clean
  VPS (hit for real while deploying to a Synology NAS). (1) `docker-compose.yml` hardcoded `./sample-vault` and
  the port, so self-hosters had to edit a tracked file and every redeploy clobbered it. Fix: switched to
  `${VAULT_HOST_PATH:-./sample-vault}` / `${HTTP_BIND}:${HTTP_PORT}` / `${WEBOBSIDIAN_WATCH}`, with the values
  living in `.env` (git-ignored), so a redeploy no longer loses the configuration. (2) Watcher `ENOSPC`: a
  clean VPS has `fs.inotify.max_user_watches=8192`, which is less than the file count of a large vault, so the
  native watch died. Fix: `startWatcher()` was split out and given an `.on('error')` handler that, on
  `ENOSPC/EMFILE`, calls `close()` and restarts in `usePolling` mode while logging instructions for raising the
  sysctl; `WEBOBSIDIAN_WATCH=polling` forces polling from the start. (3) `.env.example` was rewritten around
  the real docker flow. (4) healthcheck `start_period=90s` for the first index of a large vault. README gains
  a "Deploy to a VPS" section + the sysctl command. PRD ↑0.6, FR-9 extended. Server typecheck passes.
- 2026-06-15 (Git Sync fix: the `index.lock` wedge, a.k.a. "completely dead"): Git Sync died outright, with
  the log repeating `fatal: Unable to create '/vault/.git/index.lock': File exists`. Root cause: **3 sources
  ran git concurrently on the SAME repo with no coordination**: the autosync tick (30s), the debounced
  commit-on-save (5s after a save), and the manual `/api/git/*` route. Every `git()` call created **a new
  simple-git instance**, so the per-instance task queue did not serialize across them → two `git add .` runs
  collided on `.git/index.lock`; and a command killed or crashed halfway through left a **stale lock**, after
  which every subsequent op was dead forever. Fix (server/src/services/git.ts): (1) **`withGitLock`**, one
  global async queue that every write op (status/pull/push/commitAll/init/clone/sync) goes through, so they
  never overlap and a failing op does not poison the queue. The public functions (which take the lock) were
  split from the `*Impl` functions (which run inside the lock and call each other directly to avoid a
  deadlock). (2) **`clearStaleLocks`** at the start of every op, deleting
  `index.lock`/`HEAD.lock`/`config.lock` when their mtime is ≥15s old (wide enough not to steal the lock from
  an external Obsidian-git run, fast enough to self-heal after a crash). (3) **`timeout.block: 120s`** for
  simple-git, so a dead network op does not hang the queue forever. On prod (Synology): found a 0-byte
  `index.lock` with an mtime ~10h old → deleted it → `git status` worked again → `/api/git/sync` returned
  `{ok:true, [Committed, Pulled, Pushed]}`. Deployed the fix so it cannot happen again. Typecheck clean in
  both workspaces.
- 2026-06-11 (Git Sync fix: `spawn EBADF`): the "Git Sync doesn't work" bug turned out to be a `spawn EBADF`
  error. The root cause was NOT in git: **chokidar v4** on macOS watches each file through kqueue, holding
  **1 fd per file**, so a ~11k-file vault left the process with ~11k open fds; when `simple-git` spawned
  `git`, libuv ran out of fds to build the stdio pipes → `spawn EBADF` (reproduced by holding 11k fds and
  then spawning, which gives exactly that error). Fix: downgraded to **chokidar ^3.6.0** (FSEvents on mac =
  1 fd for the whole tree; per-directory inotify on Linux/Docker) → fds went from 11,003 to ~20. Added
  `--allow-unrelated-histories` to `pull()` (a locally initialized vault versus a remote that already has
  commits). `[git]` logging in the routes + autosync (for monitoring). UI: the log `<pre>` became a
  **scrolling textarea that accumulates entries, with timestamps + Clear** (Settings ▸ GitHub Sync); plus a
  **Sync now** button on the left Ribbon (only shown when git sync is enabled, with a spinning icon while
  syncing and a notification on error). Did a one-off reconcile of vault↔obsvault.git (their histories had
  diverged): a union with no data loss (`merge -s ours --allow-unrelated-histories` joins the histories and
  restores the 2,646 remote-only files, with local winning on conflicts). Verified: `/api/git/sync` →
  `{ok:true, [Committed, Pulled, Pushed]}`, HEAD==origin/main, 0 files lost on either side. Backup refs
  `backup/pre-union-{local,remote}` are kept in the vault (deletable once we are confident).
- 2026-06-11 (Phase 19: mobile UI): made the app friendly for touch smartphones (using Obsidian Mobile as
  the reference). `useIsMobile` (matchMedia 768px) + a local `mobileDrawer` state (NOT persisted or broadcast,
  so it never touches the desktop uistate sync). CSS `@media ≤768px`: full-width workspace, with the
  ribbon+left sidebar and the right sidebar turning into sliding overlay drawers (translateX) + a dimmed
  backdrop; a hamburger (☰) in the tab-bar + left/right edge-swipe to open/close the drawers; the drawer
  auto-closes when a note is opened; touch targets ≥36–44px; crumbs+split hidden so the view-header does not
  overflow; the status bar is hidden to make room for the toolbar. The `FormatToolbar` format toolbar is
  shared through `lib/activeEditor` (a singleton EditorView) and has 14 buttons:
  bold/italic/heading/list/checklist/quote/link/[[ /code/tag/indent/outdent/undo/redo. Following user
  feedback it is **enabled on desktop too** (as an in-flow bar under the view-header); on mobile it is
  anchored above the keyboard through visualViewport. Viewport `viewport-fit=cover` +
  `interactive-widget=resizes-content` + safe-area insets. Verified in Chrome at 390×844: the left/right
  drawers slide with a backdrop, the hamburger works, the toolbar's Bold writes `**` and Undo reverts it,
  Reading hides the toolbar; desktop at 1440 shows no regression and Bold/Undo work there too. Typecheck +
  web build clean.
- 2026-06-11 (round 5): changed the Reading mode architecture as requested: Reading is the Live Preview
  editor in readonly mode (a single renderer), along with callout fold chevrons + code syntax highlighting
  (CM grammar) for the remaining Preview pipeline. Verified: reading is a .cm-editor with
  contenteditable=false, and callout/checkbox/fold/code/math/footnote/HTML render exactly as in Live.
- 2026-06-11 (round 4): Reading mode parity with Live: shared callout constants, plus KaTeX, mermaid,
  highlighting, tag pills, comment stripping, breaks:true and callout folding in Reading. Debugged the
  sanitizer with a node repro: defaultSchema restricts the allowed values of a.className, so that entry is
  filtered out. Verified in Reading: 4 tag pills, 2 marks, 8 internal-links, 3 katex, 1 mermaid svg,
  1 collapsed callout, 17 callout icons.
- 2026-06-11 (round 3): fixed 4 editor bugs (HTML tables, inline footnotes, code block padding + the
  indented-code guide, embed note titles/whitespace) + brought Reading mode in line with Live (custom task
  states, bullets, property pills). Verified both modes with screenshots.
- 2026-06-11: Phase 18 round 2: fixed the 11 rendering bugs the user reported while comparing the "Markdown
  Test" note side-by-side with the Obsidian app (M18.10): a dedicated highlight style got rid of the red
  escape coloring; real note-embed transclusion + a "could not be found" box; indent guides; nested quotes
  with multiple bars; checkboxes inside callouts; callout fold +/- working (collapsed by default with -,
  toggled by the chevron); code blocks in the Obsidian palette + a language label; display math $$ rendering
  (KaTeX); HR without excess margin; inline-HTML lines + real mermaid rendering (lazy); multi-line %% block
  comments grayed out. New deps: katex, mermaid, @codemirror/language-data (all lazy-loaded into their own
  chunks). Verified each item with Chrome screenshots on the real vault; typecheck + build clean.
- 2026-06-10: Phase 18: replicated the Obsidian Desktop markdown editor following
  docs/obsidian-desktop-internals.md. CSS tokens verbatim (accent HSL + ramp + heading sizes +
  bold-modifier 200 + callout RGB slots); standard HyperMD-*/cm-* DOM classes; LP gains
  highlight/comment/math(KaTeX)/footref/blockid/HR/fence hiding + escapes; callouts with all 14 color slots +
  lucide icons + default titles; wikilinks per the §7 rules (alias after the first |, NBSP+NFC, image size
  params, raw Note#Head labels); the exact unicode tag charset; §4 hotkeys (Mod+B/I/K/L/D, Mod+/, Mod+E,
  Alt+Enter, list continuation); the [[ and # suggesters with the §9 fuzzy scoring formula ported verbatim;
  line spacing checked against the real app.css (heading padding-top --p-spacing, inline-title 0.5em).
  Verified in Chrome on the real vault side-by-side with the Obsidian app:
  heading/highlight/tag pill/callout/task/code/footnote/math/suggester all match; typecheck + build clean;
  the test note was deleted afterwards.
- 2026-06-03: Created PRD.md, IMPLEMENTATION_PLAN.md and CLAUDE.md.
- 2026-06-03: Finished Phases 0–10. Backend (auth, vault, QMD search, links/graph, git+LFS, API gate,
  plugins) + an Obsidian-like frontend (ribbon/sidebar/tabs/editor/reading/search/backlinks/outline/graph/
  settings/command-palette). Web+server build clean, typecheck passes.
- 2026-06-03: Smoke test passed: login, file tree, full-text + fielded search, backlinks, tags, agent API
  (list/read/write/append/search, 401 without a key, 403 on the wrong scope), SPA served, git status (LFS
  available). UI screenshots confirm the editor + reading view + callouts + properties + wikilinks render
  correctly.
- 2026-06-04: Phase 12: Live Preview WYSIWYG, embeds/transclusion, context menu, drag&drop + paste image,
  quick switcher + hotkeys, bookmarks/recent/daily note, split pane, git auto-commit-on-save, code-split
  bundle.
- 2026-06-04: Phase 13: UI overhaul from feedback: a flat Lucide icon set replacing the emoji, the Light
  theme as the default, a chevron-only file tree, the vault footer, the status bar in the bottom-right corner,
  and "Linked mentions". Compared against real Obsidian screenshots: the light editor + properties block +
  linked mentions match.
- 2026-06-04: Obsidian-style attachment/image resolution: added a vault-wide file index (basename→path,
  shortest path wins); the /content route falls back to the basename when the path does not match. Images are
  handled generically by protocol: URLs the browser can load (http(s)/data/blob/file) load directly, and
  everything else (a relative path or any other scheme) is resolved by basename through the file index.
  Applied in both Live preview and Reading. Verified: images display inline (naturalWidth>0). The watcher
  updates the index on add/unlink.
- 2026-06-04: Fixed OOM on a large vault (5.9k notes): the index build no longer holds every document, the
  body is capped at 100k, the link-graph + loadTree calls are debounced, and
  NODE_OPTIONS=--max-old-space-size=4096 (Dockerfile).
- 2026-06-04: Filled in the standard Markdown rendering Live Preview was still missing: `[text](url)` links
  (URL hidden, clicking opens external/internal), `![alt](url)` images (http/relative → <img>, an unusual
  scheme such as trilium-att:// → a "🖼 name" placeholder), and URLs containing spaces. Added an overlap guard
  for replace decorations (to prevent a crash).
- 2026-06-04: Rewrote the Graph view: 2D canvas + d3-force (Barnes-Hut), pan/zoom, labels appearing on
  hover/zoom, click to open a note, orphans hidden by default (689 of 5929 nodes have links) + a toggle. No
  more lag. Fixed the full-height layout (theme wrapper) + anchored the status bar to the bottom of the
  workspace (so it no longer covers the right sidebar).
- 2026-06-04: Pointed WebObsidian at the real Obsidian vault `/Users/xnohat/ObsidianVault-Trilium` (5928 md
  files, 27k files, 5.5GB). Dotfiles hidden in the tree, folders collapsed by default, the caret initialized
  after the frontmatter, and Properties rendering YAML lists as pills. The screenshots match the real
  Obsidian ones.
- 2026-06-04: Phase 14: rewrote Live Preview into a true WYSIWYG (heading/bold/italic/code/tag/callout
  rendering, syntax hidden, only the token at the caret revealed; fixed oneDark being applied over the light
  theme). Added an editor right-click menu (Format/Paragraph/Insert submenus + clipboard + search), extended
  the file tree menu and added a reading view menu. Screenshots confirm: bold renders bold when the caret is
  in another paragraph, and the Format submenu appears correctly.
- 2026-06-04: Fixed Markdown rendering that diverged from Obsidian: (1) Obsidian syntax/wikilinks/embeds
  inside inline code or a code block (e.g. `` `![[file]]` ``) were being turned into links, and are now kept
  literal in both Live (the regex is skipped when it overlaps an InlineCode/FencedCode/CodeBlock node from
  syntaxTree) and Reading (code spans are stashed before preprocessing and restored afterwards). (2) Markdown
  tables were not rendered in Live: added scanTables + TableWidget through the `tableField` StateField (a
  block widget like frontmatter), with inline rendering inside cells (code/bold/italic/link) and the raw text
  revealed when the caret is inside the table; the plugin skips lines belonging to an already-rendered table
  to avoid overlapping decorations. Verified: typecheck + build clean, and scanTables correctly recognizes the
  README table (Type/Count header, 10 rows).
- 2026-06-05: More Live Preview parity with Obsidian: (1) external http(s) links get a ↗ icon (lucide SVG) +
  an underline; internal links/wikilinks are underlined; the link widget is `inline-block` so text stuck right
  after `]]` can still wrap the way it does in Obsidian. (2) Lists: collapse the extra whitespace after the
  marker (`-   Item`→`• Item`, `1.  x`→`1. x`). (3) Blockquotes use the normal text color (they used to be
  muted). (4) Raw HTML blocks (CKEditor/Trilium `<table>`) render through the `htmlBlockField` StateField +
  sanitizing (dropping script/on*/js: URLs), and clicking a link inside the HTML opens it
  externally/internally; the plugin skips lines inside an already-rendered HTML block. Verified with Chrome
  DevTools on the real vault: the ↗ icon + link underlines, 1-space lists, blockquotes in normal weight text,
  and the "Strengths/Weaknesses" HTML table rendering with its bullets + tiktok/Google links. Note: the Obsidian
  app open on the same vault converts some HTML tables to markdown by itself and deleted a scratch file
  mid-session. That is not WebObsidian's doing (the server reads/writes verbatim and the code only adds
  decorations).
- 2026-06-05: Tweaks from feedback: (1) markdown tables render a `<br>` inside a cell as a line break
  (appendInline gained a `<br>` token), with left-aligned headers + valign top + styling from the Obsidian
  table CSS vars (in both Live and Reading). (2) Blockquotes: a purple `--interactive-accent` left border +
  padding-left 24px; fixed the bug where CodeMirror's `.cm-line` overrode the padding by using the more
  specific `.cm-line.cm-blockquote` selector (like `.cm-callout`), so the text no longer sits against the
  border. Verified with Chrome DevTools: br=3 inside a cell, left-aligned th, blockquote border
  rgb(120,82,238) + 24px padding. The server had to be restarted twice (a minisearch vacuuming crash + an OOM
  while reindexing on reload). Those are pre-existing bugs, unrelated to this change.
- 2026-06-05: An interactive Obsidian-style table editor (TableWidget rewritten). Click-to-edit cells
  (contenteditable nested inside the widget, focus reveals the raw text, blur/Enter commits, Escape cancels),
  and every operation re-serializes the model → replaces the source range → tableField rebuilds (so the DOM is
  always in sync). Hovering shows +column (right edge) / +row (bottom) buttons. Right-clicking a cell opens a
  formatting menu (the store's openContextMenu is injected through setLivePreviewMenuHandler): insert column
  left/right, insert row above/below, move column/row, align column left/center/right (a submenu), delete
  column/row. Tables now ALWAYS render as a widget (the reveal-raw-on-selection behavior was dropped), like in
  Obsidian: edit the content through the cells and the raw text through Source mode. Verified with Chrome
  DevTools on the "Test Table" note: editing a cell writes correct GFM to the file, +column goes 4→5, the
  context menu has every item, and delete column goes 5→4.
- 2026-06-05: An Obsidian-style inline title (the note name) at the top of the note body, in Live (the
  `inlineTitleField` block widget at pos 0, with the title fed in through `setNoteTitle` from the Editor) as
  well as Reading (Preview prepends `.inline-title`). Deduplication: it is skipped when the note starts with
  a `# <name>` matching the title (Trilium notes repeat the title as a heading), so it never shows twice.
  Verified: "Test Table" (no heading) shows the title; "Trilium System Notes" (which has
  `# Trilium System Notes`) does NOT show the inline title (only the heading remains).
- 2026-06-05: An interactive Obsidian-style property editor (FrontmatterWidget rewritten). A "Properties"
  header, and for each prop: a type icon (text=T / list=≣ / date=🗓 / number=# / checkbox=☑), a
  contenteditable key + value (committed on Enter/blur), lists (tags/aliases/[...]) shown as pills with a ×
  delete button and a "+" button to add an item, a × button to delete the prop on hover, and "+ Add
  property". Every operation parses → serializes YAML → replaces the frontmatter block [0,blockEnd].
  Frontmatter now ALWAYS renders as a widget (reveal-raw was dropped), like in Obsidian. YAML quoting kicks in
  when a value contains special characters. Verified with Chrome DevTools: README shows the right title/created
  icons, Add property writes `property:` to the file and then cleans up fully, and Trilium System Notes shows
  aliases as pills with an add button.
- 2026-06-05: An Obsidian-style property name suggester (dropdown) for Add property. Server: QmdEngine
  collects the vault-wide frontmatter key→type mapping (a `propMeta` map, persisted/restored alongside the
  index), and `GET /api/properties` returns {key,type,count} sorted by count; `inferPropType` classifies
  text/list/number/checkbox/date/datetime, and the core props (tags/aliases/cssclasses) are always lists and
  always present in the suggestions. Web: `api.properties()` + injection through
  `setLivePreviewPropertyProvider`; the "+ Add property" button opens an input + a dropdown filtered by name
  (excluding keys that already exist), and picking a suggestion creates a prop of the right type
  (list→pills). Fix: readProps now excludes `.prop-newrow` (the name being typed used to be committed by
  mistake). Verified with Chrome DevTools: /api/properties returns 76 keys (created 5938, aliases 5937…), the
  dropdown filters "tag"→tags/tag/taskTagNote, and picking "source" adds exactly 1 prop to the file which then
  cleans up fully. data/qmd-index.json had to be deleted and reindexed to get propMeta.
- 2026-06-05: Finished the 3 remaining items. (1) Server stability: turned off minisearch `autoVacuum` (the
  source of the TreeIterator.dive crash on discard/replace) in both newIndex and loadJSON; added process
  guards for uncaughtException/unhandledRejection (log, do not die). (2) Table handles: a column selector bar
  (along the top edge of the th) + a row selector (along the left edge of the first cell), where hovering
  highlights the whole column/row (.cm-cell-hl) and clicking opens the formatting menu scoped to it.
  (3) An Obsidian-style property type registry: a service that reads/writes `.obsidian/types.json` (format
  {types:{key:type}}, text/multitext/number/checkbox/date/datetime/tags/aliases) + a GET/POST
  `/api/property-types` route; the web side injects the registry and right-clicking a key/icon opens a
  "Property type" menu (6 types, ✓ on the current one) + Copy value + Remove; changing the type persists to
  types.json, and when the list-ness changes the YAML is converted scalar↔list and committed, otherwise only
  the icon changes in place. Verified with Chrome DevTools: the menu shows everything with ✓ Date&time for
  created; changing title→List writes types.json {"title":"multitext"} and turns the YAML into a list, and
  reverting→Text cleans up; the handles highlight 3 cells and open the menu.
- 2026-06-05: Value inputs based on the property type (as in Obsidian). `makeScalarField(dt,value)` builds the
  right control: text=a contenteditable span, number=`<input type=number>`, checkbox=`<input type=checkbox>`,
  date=`<input type=date>`, datetime=`<input type=datetime-local>`. Every field keeps `dataset.raw` = the
  canonical YAML value (readProps reads raw, so a field that was never touched is not overwritten; for example
  a `…:48.273Z` timestamp is preserved even though only `19:23` is displayed). Changing between scalar types
  swaps the control in place (fixing the earlier behavior where only the icon changed). Verified with Chrome
  DevTools: created→a datetime picker (raw keeps the seconds/Z), and dateNote (which Obsidian set to datetime
  in types.json) also gets a datetime picker, so the interop works both ways; cycling dateNote through
  number/checkbox/date/text/datetime switches the input correctly; README ends up clean and types.json
  matches.
- 2026-06-05: Editing and adding values on list properties (tags…), Obsidian style. Pills are now
  contenteditable (click to edit, blur to commit) with a × delete button; the "+" button opens an input + a
  value suggestion dropdown (vault tags through `setLivePreviewTagProvider` → /api/tags, 1302 tags), filtered
  in real time, and picking one or pressing Enter adds it. Removed the cap of 12 in the Add-property suggester
  (it now shows all ~72 keys, scrollable), which addresses the "too few props" complaint. The value dropdown
  uses position:fixed appended to body and is anchored below the input with getBoundingClientRect (fixing the
  UI bug where it used to push things down and leave a gap, with the dropdown flying off to the right).
  flushActive is called inside mutate so an in-progress edit is not lost when another operation happens.
  Verified with Chrome DevTools: 0px gap, the dropdown sits directly under the input, filtering
  "linu"→linux/linuxjournal, picking one writes `tags: - linux` to the file, editing the pill
  linux→linuxedit persists, and deleting cleans up; the Add-property dropdown has 72 items.
- 2026-06-05: The Graph view moved from a standalone modal to opening in a workspace tab, like Obsidian (the
  sentinel path `graph://view`, rendered in Workspace when activePath is the graph; setGraph/openGraph adds or
  activates the tab and it is saved with the workspace state). Added an Obsidian-style Filters overlay panel
  with individually collapsible sections: Filters (search files, Tags/Attachments/Existing files
  only/Orphans toggles), Groups (New group: a color + query → matching nodes are tinted), Display (Arrows,
  Text fade, Node size, Link thickness, Animate), Forces (Center/Repel/Link/Link distance sliders on 0..1,
  mapped onto d3-force). The backend `graphData()` was extended: nodes carry a `kind`
  (note/attachment/unresolved) + `tags`, attachment nodes are generated for embedded files and unresolved
  nodes for wikilinks with no file, which makes the toggles actually work; buildLinkGraph also stores rawLinks
  + tags. graphSettings is persisted through /api/uistate. Typecheck + web build clean (414 modules).
- 2026-06-05: Fixed the Tags toggle blanking the page. Cause: the server on 8787 was still running an OLD dist
  build (without tags), so `n.tags` was undefined and the client's `for (const tag of n.tags)` threw
  "undefined is not iterable" synchronously inside useEffect → React unmounted the whole tree (blank, and a
  refresh did not help because tags:true had already been persisted). Client fixes: guard with `n.tags ?? []`
  and skip nodes without tags, resolve links to node-object references (eliminating the chance of forceLink
  throwing "missing node"), and wrap the entire build in try/catch so a "Reset filters" overlay appears
  instead of a blank page. Rebuilt the server (tsc) + restarted `node server/dist/index.js` (PORT=8787
  DATA_DIR=./data ALLOWED_ROOTS=/Users/xnohat; the real vault comes from settings.json, and the
  "sample-vault" in the log is defaultVaultPath, which is misleading). Verified over CDP (port 9223) on the
  real vault: /api/graph returns 22718 nodes with kind+tags (3085 nodes have tags), turning on Tags gives
  tagsOn=true with NO errors or crashes, and orphans go 2533→1213 (notes now connect to tag nodes). Typecheck
  + web+server build clean.
- 2026-06-05: Performance fix: the server pegged ~88% CPU continuously and the Files panel was stuck on
  "Loading...". Three O(whole vault) causes were running in a loop: (1) chokidar did NOT ignore `.obsidian`,
  so the Obsidian app open on the same vault kept writing workspace.json/state → every event broadcast an
  `fs` message → the client refetched the entire tree. (2) `listTree` called `fs.stat()` on every file → 27k
  syscalls on every tree fetch (and the UI does not even use size/mtime). (3) onChange + the API reindex
  called `buildLinkGraph()`, re-reading and re-parsing all 5938 notes every time a single file changed. Fixes:
  ignore `.obsidian` in the watcher; drop `fs.stat` from listTree (using only the dirent); add
  `updateLinkGraphForFile(rel, removed)` to update the graph INCREMENTALLY for one file (used by the watcher's
  onChange and by the reindex in PUT content/rename/delete; the agent path and /api/reindex still do a full
  rebuild since they are rare). Verified over CDP on the real vault: CPU 88%→0% at idle, /api/files/ at
  ~190ms, and the Files panel no longer stuck on "Loading" (38 rows). RSS stays at ~1.1GB (MiniSearch + the
  index, not growing). Typecheck + server build clean.
- 2026-06-05: Graph quality + interaction improvements from feedback (compared against Obsidian). (1) Clicking
  a TAG node searches the notes: the store gains `searchFor(q)` (setting leftPanel=search + searchQuery) and
  SearchPanel adopts searchQuery; GraphView onUp does note→openFile, tag→`searchFor('tag:'+name)`. Verified
  through the API: tag:license→50 hits (the first note, "12min Lifetime License", matches Obsidian),
  tag:Android→40. (2) Smooth zooming: dropped the React onWheel (it is passive, so preventDefault is ignored)
  in favor of a native listener with {passive:false}, and the scale is now continuous
  `exp(-deltaY*speed)` instead of fixed 1.1× steps; ctrlKey amplifies for pinch. (3) Sharper graphics: the
  node radius switched to the sqrt form `(1.5+√deg*0.9)*(0.4+size)` (no more giant blobs), nodes gained a
  background-colored ring to separate them clearly, edges are pale hairlines (alpha 0.18+), and labels have a
  background halo (strokeText) for readability. (4) Zoom performance: edges outside the viewport are culled
  (skipped when both ends are off-screen on the same side). Typecheck + web build clean.
- 2026-06-05: Graph layout & label fade from feedback: (1) stronger repulsion (charge −66→−120), hubs pushing
  harder in proportion to √deg, longer links (67→100), distanceMax 480→1400, a gentler center force, and
  collision using the real radius → the graph spreads out and the "hairball" is gone. (2) Thinner lines with
  a stronger color (switched to --text-faint, alpha ~0.7). (3) Labels fade in with zoom (hubs appear first,
  small notes only when zoomed in) instead of all appearing at once.
- 2026-06-05: Switched the graph renderer from 2D canvas (CPU) to **PixiJS WebGL (GPU)**, like Obsidian (the
  user's choice). Pixi v8 is dynamically imported (a 246KB gzip chunk loaded only when the graph is opened;
  the main bundle stays ~40KB). Architecture: nodes are Sprites (a shared circular texture, tinted by
  color/group and scaled by radius), edges are Graphics, and labels live in their own screen-space Text layer
  (a pool of ≤400, with a background halo and zoom-based fading). Pan/zoom is a camera transform on the world
  Container (world.position/scale), so the geometry is NOT redrawn and it stays smooth no matter how many
  nodes there are; geometry is only redrawn on a sim tick. Rendering is on demand (ticker.stop + app.render
  batched through rAF). d3-force, the Filters/Forces panel and click-tag→search are unchanged. Verified over
  CDP on the real vault: the WebGL context stays alive (never lost), 0 console errors, the scene rebuilds
  correctly when filters change (tags off→1258 nodes), and screenshots confirm crisp node/edge/label drawing.
  Typecheck + web build clean.
- 2026-06-06: Tuned the WebGL graph to match Obsidian (over several rounds of CDP screenshots): (1) Node size
  uses a CAPPED sqrt `(3+min(√deg,11))*(0.45+size)`, so a tag hub is only ~3.5× a note (it used to be ~9×, a
  giant blob) and notes have a clearly visible base size. (2) Labels: the screen-radius threshold was lowered
  and a **greedy anti-overlap pass** was added (sorted by hover→deg, dropping any label that would cover an
  already-placed one, up to 220) → labels look as clean as Obsidian's and appear at the right zoom level
  instead of appearing late or on top of each other. (3) Auto-fit is based on the CORE REGION (the median
  center + the 82nd percentile radius, discarding far-flung orphan-cluster outliers) → a sensible default
  zoom level instead of shrinking the graph into a dot in the middle of the screen; it refits periodically
  while the layout settles and stops once the user pans/zooms. (4) Edges keep a FIXED ON-SCREEN THICKNESS
  (width=base/k, redrawn on zoom; panning is still a pure transform), so they no longer turn into fat gray
  bars when zoomed in deeply. Verified over CDP at several zoom levels: lines are uniformly thin, labels are
  legible and non-overlapping (notes+tags), nodes are balanced, and clicking a cyan tag searches. Typecheck +
  web build clean.
- 2026-06-06: Labels, following the "they appear late and look faded" feedback: lowered the rMin threshold
  (1.1−fade) so labels appear right at the default fit zoom; font 11→13 + fontWeight 600 + the --text-normal
  color (bold/black) + halo width 4 + a faster alpha ramp, so nothing looks washed out. Verified over CDP: at
  both the fit level and zoom +2 the labels are bold, black and large, do not overlap (the greedy pass still
  prevents collisions), and show the full set of tags + note names, like Obsidian.
- 2026-06-06: Smooth zoom-based label fading like Obsidian: the alpha ramp region was widened (over ~4.5px of
  screen radius), so labels appear faintly when zoomed out and gradually sharpen as you zoom in, with hubs
  becoming clear first and small notes after. Verified over CDP: at the fit level labels are faint with
  multiple opacity levels, and at zoom +4 they are fully sharp and bold.
- 2026-06-10: Obsidian-style back/forward navigation (M9.10). The store gains a history stack (`history`/
  `histIndex`, capped at 100) + `goBack`/`goForward`; openFile/openGraph push an entry through `pushHistory`
  (truncating the forward branch, and skipping while replaying thanks to the `navByHistory` flag). The
  view-header now renders for EVERY view (it used to be markdown only) with ←/→ buttons in the top-left,
  disabled and dimmed when there is nowhere to go; the Graph view has the toolbar too. Added the
  arrow-left/arrow-right icons. Typecheck clean in both workspaces + web build clean.
- 2026-06-10: Filter/sort + sticky header in the search panel (M9.11). The query area (input + the "Aa"
  match-case button + clear + options) is merged into one bordered box, and `.search-head` uses
  `position: sticky; top:0` inside `.sidebar-body` so it does NOT scroll away with the results (fixing the
  complaint). Options panel (toggled by the sliders button): Collapse results (hides the snippet), Show more
  context (removes the line-clamp). Sort dropdown: Relevance (the default = the server's order) / File name
  A→Z / Z→A / Path, sorted client-side. Match case filters client-side on the free text (excluding the
  tag:/path: operators). The limit was raised 50→100. Note: sorting by Modified/Created time is NOT done yet,
  because the search index does not store mtime/ctime; that needs a new server field + a reindex. Typecheck +
  web build clean. Not verified live yet (the CDP browser profile was in use).
- 2026-06-10: Removed the hard cap of 100 search results (from the "why is it always 100?" feedback). Server:
  the route dropped Math.min(...,100), and `limit<=0`/omitted returns EVERY match; QmdEngine.search only
  slices when limit>0 (the agent API still passes a limit, so nothing changes there). Client: api.search
  dropped the default of 100 (it calls without a limit) and SearchPanel renders INCREMENTALLY, 50 at a time,
  through an IntersectionObserver (a sentinel + rootMargin 300px), resetting to 50 when the
  query/sort/match-case changes and showing "Showing X of Y…". The count is now the real total. Verified
  through the API on the real vault: q=nginx → 166 hits (previously truncated to 100), while limit=100 still
  caps at 100. Restarted the server on the new dist. Typecheck + web+server build clean.
- 2026-06-10: Fixed the gap above the search box (results peeking out above the search field). Removed
  `position: sticky` from `.search-head` (sticky inside `.sidebar-body`, which has padding-top, leaves a
  gap). Replaced with a fixed layout: `.search-panel` is height 100% flex-column, `.search-head` is
  flex-shrink:0 (staying put), and `.search-results` is flex:1 + overflow-y:auto with its own scrolling, so
  the top of the list can never overlap the box. The IntersectionObserver root switched to `.search-results`
  (via a ref) instead of the viewport. Typecheck + web build clean.
- 2026-06-10: Phase 16 (FR-10): deep-link URLs + public sharing. The URL `/note/<path>` syncs both ways with
  the open tab (the `web/src/lib/urlsync.ts` module: pushState when the note changes, popstate → openFile,
  replaceState on the first sync; a deep-link beats the workspace restore). Public sharing: `data/shares.json`
  (1 record per note, with a 16-byte base64url token), `/api/shares` CRUD + an enabled toggle,
  `/public/shares/:id` returning {title, content} without leaking the path, and `/public/shares/:id/file`
  serving only the files that note embeds (`![[...]]`/`![](...)`, resolved by basename like the files API,
  with `.md` blocked). The `/share/<id>` page renders a standalone Reading view (a main.tsx branch before App,
  no auth) with inert wikilinks. UI: a "Copy public link" context menu item (FileTree), and Settings → the
  Sharing tab (search, Copy link, Disable/Enable, Delete; clicking a path opens the note). Renaming a note
  updates the share path automatically. Verified end-to-end with curl (401 on the file API versus 200 on the
  public one, 404 outside the allowlist, disable→404, re-enable→200) + Chrome (the share page renders the
  embedded image in an isolated, cookie-free context; the deep-link opens the right note; the browser Back
  button changes notes; the Sharing tab shows all the controls). Typecheck + build clean.
- 2026-06-10: M16.5: a separate password per share link. Server: `ShareRecord.passwordHash` (scrypt, reusing
  the auth service's hash/verify; the hash is never returned, the API returns `hasPassword`),
  PATCH /api/shares/:id accepting {password: string|null} (set/remove), and POST /public/shares/:id/unlock
  exchanging the password for an httpOnly JWT cookie scoped to `/public/shares/:id` with a 12h TTL (so
  embedded images send the cookie automatically); GET content/file returns 401 {passwordRequired} until it is
  unlocked. Web: PublicNote gains an unlock form (a wrong password shows an error, the right one renders the
  note); the Sharing tab gains a "Password…/Password ✓" button (prompting to set/change/remove) + a
  "password-protected" badge. Verified with curl (set→401→wrong unlock 401→correct unlock→cookie→200 for
  content+file, removing the password→200 again, and shares.json in mode 600 containing the scrypt hash) +
  an isolated Chrome context (the form appears, a wrong password errors, the right one opens the note with
  the image loading, and the Sharing tab shows the right state).
- 2026-06-10: M16.6: SSR + SEO for the public share page. The server renders `GET /share/:id` into complete
  HTML (the `sharepage.ts` route, mounted before static): the note content is right there in the HTML (Google
  indexable, no JS required), and the head carries title / meta description (markdown stripped, ~160
  characters) / canonical / og:type=article + og:site_name + og:title/description/url/image (the first image
  the note embeds, as an absolute URL through the public endpoint, or the first web image) /
  twitter:card summary_large_image. Rendering goes through the `renderhtml.ts` service, a port of the web
  side's unified/remark/rehype+sanitize pipeline (kept in sync), with the deps added to the server workspace;
  the SPA's CSS bundle is inlined so the look matches the Reading view. A password-protected share gets an SSR
  unlock form instead (noindex, leaking neither content nor metadata; inline JS POSTs the unlock then
  reloads); the unlock cookie's path changed to '/' so both /share/:id and /public/shares/:id accept it. The
  React PublicNote page was removed (SSR replaces it) and the vite proxy gained /share. Verified with curl:
  locked → noindex with no leaks, unlocked → full meta + content + img + inlined CSS, a wrong id → 404
  noindex; in an isolated Chrome context: a wrong password in the unlock form errors, and the right one
  reloads into a note identical to the Reading view. Typecheck + build clean.
- 2026-06-10: Graph view: fixed a layout that was far off from Obsidian's (the graph spread out into strands,
  detached clusters flew off in all directions, and tag hubs turned into spiky "dandelions"): (1) replaced
  `forceCenter` (which only translates the centroid and does not attract) with real gravity, `forceX`+`forceY`
  mapped from the Center force slider; (2) link strength switched to d3's default adaptive
  `slider/min(deg)`, so the cluster around a hub compresses into a dense disc; (3) capped the repel
  coefficient by degree (a hub is ~2× a leaf instead of ~8×) + distanceMax 900; (4) positions are initialized
  on a phyllotaxis spiral instead of putting all 5.4k nodes on a single circle of r=250; (5) the default link
  distance went 100→50 and alphaDecay 0.02; (6) tag nodes turned Obsidian's green. Verified in Chrome on the
  real 5.9k-note vault: the graph gathers into a connected sphere with the green tags evenly distributed,
  labels/zoom behave, and the console is clean. Typecheck + build clean.
- 2026-06-10: Phase 17 (PRD 0.3): the pane menu (⋯) + an overhaul of the right sidebar, from the feedback
  that "the three-dot menu is missing and the right sidebar lacks features". (1) A ⋯ "More options" button on
  the view-header of EVERY view: note = Split right/Split down + Bookmark + Copy public link + Make a copy +
  Rename/Move/Copy path/Delete + Close tab/Close other tabs; Graph = Copy screenshot (extract the Pixi stage →
  a PNG composited over the theme background → clipboard; a re-render is required because WebGL runs without
  preserveDrawingBuffer) + Close tab. (2) Split pane in 2 directions: `splitDirection` right/down persisted in
  uistate, with `.editor-area.split-down` as flex-column. (3) The right sidebar became an Obsidian-style icon
  tab strip: Backlinks (Linked mentions + **Unlinked mentions**) · Outgoing links (resolved/unresolved, with
  attachments filtered out of unresolved so a `.md` note is not created by mistake) · Tags (reusing TagsPanel,
  where a click searches the correct tag:x query) · Outline; `rightPanel` is persisted + synced. (4) Server:
  `/api/search/matches` gained `phrase:true` for whole-phrase matching, which makes unlinked mentions as
  precise as Obsidian's instead of OR-ing individual words (verified with curl: phrase=0 hits versus
  word-based=1679 on the same note). New icons: more-horizontal/rows/list/arrow-up-right/camera. Verified over
  CDP on the real vault: the note ⋯ menu has all 11 items, Split down produces a bottom pane with a
  header+close, Copy screenshot puts image/png on the clipboard, the tab strip switches panels, unlinked
  mentions went 30→0 after the phrase fix (the long title never appears verbatim), and rightPanel is restored
  after a reload. Typecheck + web+server build clean; restarted the server on the new dist. Environment note:
  the user's older client (from a previous bundle) had /graph open and kept pushing uistate over ours during
  testing, which is not a bug in the new code.
- 2026-06-10: Graph view: aligned the sliders with the Obsidian app's original units/defaults: Text fade
  -3..3=0, Node size 0.1..5=1, Link thickness 0.1..5=1, Center force 0..1=0.52, Repel force 0..20=10, Link
  force 0..1=1, Link distance 30..500=250 (mapped internally onto the calibrated d3 parameters so the
  defaults produce the layout from the tuned build). The Filters panel is collapsed by default, showing only
  the cog icon, like Obsidian. Migration: older server-persisted graphSettings (on the 0..1 scale) are
  detected through linkDistance ≤ 1 → display/forces reset to the new defaults while filters/groups are
  kept. Verified in Chrome: the panel is closed with a cog, opening it shows the right min/max/value on each
  slider, and the layout keeps its spherical shape. Typecheck + build clean.
- 2026-06-10: Graph view: ported the Obsidian app's physics EXACTLY by reverse-engineering the locally
  installed obsidian.asar (sim.js = d3-force running in a worker + WASM, app.js = the panel/renderer):
  charge = -repelSlider³ (the default 10 → -1000, distanceMin 30, theta .9, NO distanceMax); link distance =
  the slider value as-is (250); link strength = slider × 1/min(deg) (d3's adaptive form); gravity through
  forceX/Y with strength = the MJ easing (0.01^(1-e)-0.01)/0.99, so 0.52 ⇒ 0.1; collision at a fixed radius
  of 60 with strength 0.5; alphaDecay 1-0.001^(1/300); velocityDecay 0.4. The node radius follows Obsidian's
  getSize(): nodeSize × clamp(3√(deg+1), 8, 30). Edges are drawn at a fixed on-screen thickness
  (lineSizeMult/scale) in a pale color, and note nodes are gray (not accent). The result: the graph contracts
  into a single sphere just like the app. Verified in Chrome on the 5.9k-note vault + typecheck/build clean.
- 2026-06-10: Graph view: completed render parity with the Obsidian app (digging further into the renderer in
  app.js): (1) nodes are drawn using Obsidian's nodeScale = √(1/zoom) rule, so the on-screen radius is
  getSize()·√k, meaning that when zoomed out the nodes stay large and nearly touch, forming a dense honeycomb
  disc with the edges sinking behind them (previously the nodes shrank linearly with zoom, so they withered
  away and only the edges were left, looking like a "firework" burst); (2) labels use the app's global fade
  textAlpha = clamp(log₂(zoom) − textFade, 0, 1) (by default they start appearing past zoom 1× and are fully
  clear at 2×) instead of a per-node radius threshold; (3) hover/click hit-testing + the arrows + the hover
  scale multiplier all follow the new on-screen radius. No Obsidian code was copied: only the
  constants/formulas were extracted and rewritten on top of d3-force (BSD). Verified in Chrome side-by-side
  with the app on the same vault: the dense spherical cluster looks the same. Typecheck + build clean.
- 2026-06-10: Comprehensive reverse engineering of Obsidian Desktop 1.12.7 (extracting obsidian.asar: app.js
  3.6MB, app.css 588KB, main.js, worker.js, sim.js) using 4 agents in parallel. The knowledge was written to
  docs/obsidian-desktop-internals.md (22 sections): the exact Markdown dialect regexes
  (wikilink/callout/tag/block-id/footnote), the 6-step link resolution rules, the complete schemas for
  .obsidian/* + workspace.json + graph.json + .canvas + .base, the search operator grammar, the fuzzy
  algorithm including its scoring formula, the d3-force graph constants (velocityDecay 0.6, repel −slider³,
  the slider curve), how Live Preview/reading view work (DOMPurify config, embed depth ≤5), 196 command ids +
  their default hotkeys, the registry of 31 core plugins, and the full set of CSS design tokens for both
  themes + DOM classes + the table of 14 callout groups. This is the source document for cloning features
  later on.
- 2026-06-10: Graph view: replicated the Obsidian app's viewport behavior: the initial scale = 1 in DEVICE
  pixels (CSS k = 1/devicePixelRatio), the spawn center sits in the middle of the frame, and there is NO auto
  zoom-to-fit (the tick-driven fitView was removed, since it was exactly what made the zoom level differ
  between the two, so the same node appeared at a different density/spacing); nodes "big bang" out of a small
  phyllotaxis disc at the center and expand, like the app. Re-enabled Orphans in the saved uistate (Obsidian
  defaults to on; the 2,289 orphans fill the gaps between clusters, and missing them is why it previously
  looked emptier than the app). After the fix: at the same zoom level the node spacing and node sizes match
  the app, because the physics, the render rules and the viewport are all the same. Verified in Chrome by
  zooming into the #FRT hub and comparing with the app. Typecheck + build clean.
- 2026-06-10 (continued): Graph view: completed zoom/spacing/typography parity with the Obsidian app
  (digging further into app.js + reading all of sim.js): (1) every scale rule moved to DEVICE pixels like the
  app (the on-screen node radius = getSize·√scale_device, so on a Retina display nodes shrink by √dpr and the
  cluster spacing matches the app); (2) wheel zoom uses the app's exact formula: target ×= 1.5^(−ΔY/120),
  clamped to [1/128, 8], anchored on the cursor when zooming in and on the center when zooming out, with the
  scale lerping 15% per frame (as smooth as the app); (3) labels follow the app's renderer exactly: fontSize
  14 + getSize()/4, the ui-sans-serif… font stack, scale = nodeScale (shrinking with √zoom like the nodes),
  offset (getSize+5)·nodeScale, and on hover never smaller than 1/scale;
  textAlpha = clamp(log₂(scale_device) + 1 − fade, 0, 1) (the +1 and the dpr were missing before, so labels
  appeared 4× too late); the homegrown greedy declutter was dropped (the app has none); (4) edge thickness is
  exactly lineSizeMult in DEVICE px (it used to be dpr times too thick), arrows fade with
  clamp(2·(scale−0.3),0,1) at size 2√mult/scale; (5) app-style hover fading: nodes/edges not connected to the
  hovered node fade towards alpha 0.2 (lerping 0.9 per frame) and connected edges switch to the highlight
  color; the 1.25× hover enlargement was removed (the app does not enlarge); (6) sim.alpha(0.3) when the
  forces change (the app posts alpha .3); plus a window.__graphCam hook for automated UI tests. Verified in
  Chrome on the real 5.9k-note vault: the sphere + the honeycomb orphan ring, labels appearing at the right
  scale threshold of ~0.5–1, correct hover dimming, a clean console, and typecheck + build clean.
- 2026-06-11: Phase 20 (PRD 0.5): Graph "Find node": a floating search box in the top-left of the canvas,
  matching keywords against the currently displayed nodes (label/path, AND across every word, ranked
  tag-first>prefix>label>path+degree, top 50, colored by kind with green tags/yellow attachments/dimmed
  unresolved + the path as a subtitle); click/Enter → flyTo: the camera lerps pan+zoom at 15% per frame (the
  same cadence as Obsidian's updateZoom) to the node at scale ≥2, and setHover highlights it in the accent
  color while dimming everything unconnected until the mouse moves; wheel/drag cancels the fly; Esc/clear
  closes the list. Verified over CDP on the real vault: typing "docker" gives 50 correctly ranked results,
  clicking flies to a centered node at scale 2.0, the query clears itself, and the console is clean.
  Typecheck + build clean. PRD bumped to 0.5 (FR-2).
- 2026-06-11: M16.7: a per-note share dialog + a globe badge (feedback: "Copy public link" gave no
  indication of whether a note was already shared). The `ShareDialog.tsx` component (a modal): not shared yet
  → a Create public link button; already shared → an on/off toggle pill, a URL field + Copy, Set/Change
  password, and Delete link. The store gains a `shares` cache + `loadShares()` + `shareDialogPath` (loaded
  after login, refreshed after every operation); Settings → Sharing switched to the store, so the badge is
  consistent everywhere. The file tree context menu and the pane ⋯ menu changed the item to "Share…" (globe
  icon), which opens the dialog. File tree: a note with sharing enabled shows an accent-colored globe icon
  next to its name. The `globe` icon was added to the Lucide set. Verified in headless Chrome over CDP (MCP
  was held by another session): the badge appears on exactly the shared note in the accent color, the menu
  has "Share…", and the dialog opens with all the controls (the right token in the URL, the toggle on,
  Set password…, Delete). Typecheck + build clean.
