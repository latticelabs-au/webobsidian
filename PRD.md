# PRD: WebObsidian

> Product Requirements Document
> Version: 1.5 · Updated: 2026-06-22 · Status: Draft
> Changelog 1.5 (FR-13: cross-platform Electron desktop app, requested by the user): adds **FR-13**,
> packaging WebObsidian into an **installable app** for macOS/Windows/Linux (arm64/x64/ia32). The new
> `desktop/` workspace is an **Electron shell** that spawns the exact same existing Express server as a child
> process (via `ELECTRON_RUN_AS_NODE`, bound to `127.0.0.1` + a random port) and loads the SPA in a
> `BrowserWindow`. The server is bundled by esbuild into **a single `.mjs` file** (no native runtime modules,
> so going cross-arch is just a matter of swapping the Electron binary). On first run the user **picks a
> vault**, data goes into `userData`, and **auto-login** uses a random per-machine password (no forced
> password change). Packaged with **electron-builder** (dmg/zip · nsis/portable · AppImage/deb); the new
> `release.yml` CI builds a macOS/Windows/Ubuntu matrix on `v*` tag pushes and publishes a **GitHub
> Release**. No server/web code changes.
> Changelog 1.4 (FR-2: audio/video embeds, playable like Obsidian, requested by the user): the embeds
> `![[clip.mp4]]` / `![[song.mp3]]` now render a **real HTML5 player** (`<video controls>` / `<audio
> controls>`) in **all** of Live Preview, Reading view and the public share page, where previously they only
> showed a blue link. Opening a media file straight from the file tree shows a player too (just like images).
> Video support: `mp4/webm/ogv/mov/mkv`, audio: `mp3/wav/m4a/3gp/flac/ogg/oga/opus` (matching Obsidian's own
> extension set). The size param `![[clip.mp4|W]]` sets the video width. **Important:** the routes that serve
> binaries (`GET /api/files/content`, raw share) now **stream and support HTTP Range** (206 Partial Content),
> so the video scrubber works and Safari can play at all, instead of reading the whole file into RAM. The
> MIME map and the extension sets are consolidated into `server/services/mime.ts` &
> `web/lib/media.ts`. No new APIs.
> Changelog 1.3 (FR-1: file explorer header toolbar parity with Obsidian, requested by the user): the
> **Files** sidebar header gains the full Obsidian button set: **New note**, **New canvas**, **New folder**,
> **Change sort order** (a dropdown with 6 modes: File name A→Z/Z→A, Modified time new↔old, Created time
> new↔old), **Auto reveal current file** (toggle: expands the parent folder and scrolls to the file being
> viewed), **Collapse all / Expand all**. Sorting by time is fast thanks to an **in-RAM stat cache** on the
> server (`listTree` fills it once, the watcher invalidates changed files → 0 syscalls at steady state);
> `TreeNode` gains `ctime`. No new APIs (the existing tree now carries `mtime`/`ctime`). Canvas (FR-12):
> fixed double-tap editing on Android Chrome not saving the text (commit via a doc-level pointerdown +
> double-tap detection).
> Changelog 1.2 (FR-2: images, resize + zoom, requested by the user): images embedded in a note can now be
> **dragged to resize** (two handle bars on the left/right that appear on hover in Live Preview), writing the
> size back into the source as an Obsidian size param: `![[img|W]]` for wikilink embeds, `![alt|W](url)` for
> plain markdown images (aspect ratio preserved, height auto). The size param `|300` / `|300x200` now applies
> to markdown images `![](…)` **as well** (previously only `![[…]]`), in Live as well as Reading.
> **Click an image → full-screen lightbox** (in both modes): scroll wheel/pinch to zoom (centred on the
> cursor / the midpoint of the two fingers), drag or one finger to pan, double-click to reset, Esc or a click
> on the backdrop to close. No new APIs.
> Changelog 1.1 (FR-1: trash UI + delete mode, requested by the user): adds a **Trash UI** for viewing,
> **restoring** and **permanently deleting** individual deleted files, plus an **Empty trash** button. Open
> Trash from the 🗑 button in the Files sidebar header or from the command palette ("Open trash"). Adds the
> `vault.deleteMode` setting (`trash` = move into `.trash`, restorable [default] · `permanent` = delete
> permanently right away) under Settings → Vault & Files. New APIs: `GET /api/files/trash`,
> `POST /api/files/trash/restore`, `DELETE /api/files/trash/item`, `DELETE /api/files/trash`. Restore avoids
> name collisions on its own (suffix `.restored-<ts>`) and cleans up empty folders inside `.trash`; every
> trash operation guards against path traversal (it can only touch things inside `.trash`).
> Changelog 1.0 (FR-12: Canvas, requested by the user): clones Obsidian's **Canvas** feature. An infinite
> drawing surface (pan/zoom) holding nodes (markdown text, file embeds/links to a note or an image, URL
> links, groups) and edges connecting node sides with arrows + labels. Reads/writes the open **JSON Canvas**
> format correctly (`.canvas`, compatible with Obsidian). Create/move/resize/recolour/delete nodes, connect
> edges by dragging from a side dot, multi-select + marquee, double-click the background to create a text
> node, double-click a text node to edit it. Debounced autosave like the editor (via the store's
> `content`/`save`). Create a new canvas from the file tree context menu + the command palette. No new APIs
> (it uses `/api/files/content`).
> Changelog 0.9 (FR-1: copy/cut/paste in the file tree context menu, requested by the user): the file/folder
> right-click menu gains **Copy**, **Cut**, **Paste** (a session-local clipboard, not persisted or broadcast).
> Cut uses `rename` (move) for files and folders alike; Copy uses the new endpoint **POST `/api/files/copy`**,
> which copies files/folders recursively (via recursive `fs.cp`, reindexing the new `.md` files). Paste goes
> into the destination folder (the folder that was clicked, or the parent folder of a file): it picks a
> non-colliding name automatically (`… copy`/`… copy N`), refuses to paste a folder into itself or one of its
> own subfolders, and pasting a Cut item back exactly where it already was is a no-op; the row being Cut is
> dimmed while it waits to be pasted; the **Paste** item only appears when the clipboard has data.
> Right-clicking empty space in the file tree also brings up the app's context menu (New note / New folder /
> Paste into the vault root) instead of the browser's native menu.
> Changelog 0.8 (FR-2/FR-4: ⋯ menu parity with Obsidian, requested by the user): the **More options (⋯)**
> menu is rebuilt to follow Obsidian Desktop's structure and gains: **Backlinks in document** + **Open linked
> view** (Backlinks/Outgoing links/Outline → opens the right panel); **Open in new window** (opens the
> deep-link `/note/<path>` in a new tab); **Add file property** (inserts an empty property into the YAML
> frontmatter); **Find…** inside a note (`@codemirror/search`, ⌘F/⌘⇧F/⌘G); **Export to PDF…** (Reading view +
> `window.print()` driven by `@media print` CSS); **Reveal file in navigation** (expands the ancestor folders
> + scrolls to/flashes the row in the file tree); **Open version history** (FR-4): `git log`/`git show` per
> file via `/api/git/log|/show`, with a modal listing the commits + a preview + Restore version. Drops
> "Reveal in Finder"/"Open in default app" (desktop-only).
> Changelog 0.7 (FR-10 UX, from feedback): the "Copy public link" menu item becomes "Share…", opening a
> per-note **Share dialog** (create a link, copy the URL, toggle it on/off, set/change the password, delete
> the link) in both the file tree context menu and the pane's ⋯ menu; a note that is shared publicly gets a
> **globe icon** (in the accent colour) next to its name in the file tree; the share list is cached in the
> store (kept in sync between the dialog, Settings → Sharing and the badge).
> Changelog 0.6 (FR-9 deploy hardening for open-source self-hosting): every deploy parameter moves into
> `.env` (`VAULT_HOST_PATH`/`HTTP_BIND`/`HTTP_PORT`/`WEBOBSIDIAN_WATCH`), so `docker-compose.yml` is no
> longer clobbered on redeploy; the file watcher falls back to polling on its own when it hits the inotify
> limit; healthcheck `start_period=90s`.
> Changelog 0.5: Graph (FR-2) gains keyword node search: a search box floating over the Graph view, typing
> keywords shows the list of candidate notes/tags (matching label/path, tags always ranked first, then prefix > label > path + degree), and clicking
> (or Enter for the first result) flies the camera (a smooth pan+zoom fly animation) to the node and
> highlights it (the node lights up in the accent colour, everything unconnected dims) until the mouse
> moves; Esc closes the list.
> Changelog 0.4: adds FR-11 (mobile / responsive UI for touchscreen smartphones): the left/right sidebars
> become sliding drawer overlays (hamburger + edge-swipe + backdrop), the workspace goes full-width, a
> mobile editing toolbar sits above the keyboard (bold/italic/heading/list/checkbox/link/…), touch targets
> ≥44px, safe-area insets. UX reference: the Obsidian Mobile app. Usability NFR updated.
> Changelog 0.3: expands FR-2 following user feedback: (a) a "More options" (⋯) menu on each pane header
> (Split right/Split down, Copy screenshot for Graph, Bookmark, Copy public link, Make a copy, Rename/Move/
> Copy path/Delete, Close tab/Close others) like Obsidian; (b) the right sidebar is overhauled into an icon
> tab strip (Backlinks · Outgoing links · Tags · Outline) with Linked mentions + **Unlinked mentions** and
> **Outgoing links** (resolved/unresolved), where before there were only 2 fixed panels.
> Changelog 0.2: adds FR-10 (deep-link URL `/note/...` + readonly public share links + a central share management page), the `/api/shares` + `/public/shares` APIs, and the `data/shares.json` data model.

---

## 1. Overview

**WebObsidian** is a self-hosted web app that comprehensively clones the functionality of [Obsidian](https://obsidian.md), runs on a server (Docker), and operates directly on a Vault directory containing Markdown files. The goal is to let users reach and edit their "second brain" from any browser, while also exposing an API for AI Agents to interact with.

### 1.1 Goals
- A Markdown authoring/reading experience on par with Obsidian desktop (editor, live preview, wikilinks, graph, backlinks).
- The vault is a real directory on the server, 100% compatible with an existing Obsidian vault (including `.obsidian/`).
- Two-way sync through a **native GitHub repo** (git), with **Git LFS** support for large files (images, pdf, audio, and so on).
- A simple **login gate**: a single password protects the whole app.
- Configuration stored in a **plain `.json` file** (no DB engine needed).
- An **API Gate** with API keys so AI Agents can read/write/search the vault over REST.
- A built-in **QMD search engine**: fast full-text + fielded search across the whole vault.
- Support for installing **Obsidian community plugins** the way the real app does (via a plugin loader + an Obsidian API shim).
- A **Docker stack** that comes up with one command.

### 1.2 Out of scope (non-goals, v1)
- Realtime multi-user collaborative editing (CRDT). v1 is single-user (1 password).
- Obsidian's proprietary Sync/Publish (replaced by Git sync).
- A native mobile app (responsive web only).
- 100% compatibility with every plugin that uses internal Electron/Node APIs (only the common subset of the Obsidian API is supported).

### 1.3 Target users
- Individuals self-hosting a knowledge base who want access from any device over the web.
- Users who want an AI Agent to read/write the vault through a safe API.

---

## 2. System architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser (SPA)                          │
│   React + CodeMirror 6 · Live Preview · File Tree · Graph     │
└───────────────▲───────────────────────────┬──────────────────┘
                │ REST + WebSocket           │ static assets
┌───────────────┴───────────────────────────▼──────────────────┐
│                   Server (Node + Express + TS)                │
│  Auth gate │ Vault FS │ QMD Search │ Git Sync │ API Gate │     │
│            │          │            │          │ Plugins  │     │
└───┬─────────────┬──────────┬────────────┬──────────────┬──────┘
    │             │          │            │              │
 settings.json   Vault dir  Search index  GitHub repo   plugins dir
 (JSON db)       (.md+attach) (in-mem/disk) (git+LFS)    (.obsidian/plugins)
```

### 2.1 Tech stack
| Layer | Choice | Why |
|-------|----------|-------|
| Backend | Node 20+, Express, TypeScript | One language throughout, a rich git/markdown ecosystem |
| Frontend | React + Vite + TypeScript | Fast builds, SPA |
| Editor | CodeMirror 6 | Obsidian's own editing engine |
| Markdown | unified/remark + rehype | Safe rendering, plugin support |
| Search | QMD (an in-house module on top of MiniSearch) | Full-text + fielded, in-process, no external service needed |
| Sync | simple-git + git-lfs | Native git, large file support |
| Auth | Hashed password (scrypt) + JWT cookie | Simple, no DB needed |
| Storage cfg | `data/settings.json` | The "plain JSON" requirement |
| Container | Docker + docker-compose | One-command deploy |

### 2.2 Project directory layout
```
webobsidian/
├── server/           # API backend
│   └── src/
│       ├── routes/       # auth, files, search, sync, api(agent), plugins
│       ├── services/     # vault, search(QMD), git, settings, auth, plugins
│       ├── middleware/   # auth guard, apikey guard, error handler
│       └── plugins/      # Obsidian API shim + loader
├── web/              # React SPA
│   └── src/
│       ├── components/   # FileTree, Editor, Preview, SearchPanel, Settings…
│       ├── lib/          # api client, store, markdown
│       └── styles/
├── data/             # runtime: settings.json, apikeys, sessions (gitignored)
├── docs/
├── docker-compose.yml
└── Dockerfile
```

---

## 3. Functional requirements

### FR-1 · Vault management
- Pick/change the Vault directory from Settings (a server-side path, with a safe folder browser confined to the allowed roots).
- File & folder CRUD: create, read, write, rename, move, delete. The delete mode is configured through
  `vault.deleteMode`: `trash` (→ `.trash`, restorable, the default) or `permanent` (deleted outright).
- **Trash**: a UI listing the deleted files, **Restore** back to the original location, **permanent delete**
  per file, and **Empty trash**. Trash is hidden from the file tree (dotfile) and from the watcher; open it from the 🗑 button in the Files header or from the command palette.
- **Copy/Cut/Paste** in the file tree context menu (files & folders): a session-local clipboard; Cut = move (`rename`),
  Copy = recursive copy (`POST /api/files/copy`, recursive `fs.cp`); Paste into the destination folder, avoiding name collisions on its own, refusing to paste a
  folder into itself or one of its own subfolders.
- Attachment support (images/pdf/…); upload from the web. The upload destination directory resolves
  **case-insensitively** against existing folders (`vault.resolveDirCaseInsensitive`), which avoids creating a
  duplicate folder differing only in case (for example `attachments` next to an existing `Attachments`) on a case-sensitive filesystem (Linux).
- Watch the filesystem (chokidar) to reflect outside changes (git pull, direct edits).
- Compatible with the `.obsidian/` structure (config, plugins, themes).

### FR-2 · Editor & rendering
- CodeMirror 6: Markdown syntax highlighting, basic keybindings.
- Switching between Live preview and Reading view.
- Wikilinks `[[note]]`, embeds `![[file]]`, tags `#tag`, callouts, tasks `- [ ]`.
- **Embedded images, resize & zoom**: drag the handles on either side (left/right) of an image in Live Preview to change its width,
  writing it back into the source as an Obsidian size param `![[img|W]]` / `![alt|W](url)` (aspect ratio preserved, height auto).
  The size param `|W` / `|WxH` applies to **both** `![[…]]` and markdown images `![](…)`, in Live as well as Reading.
  Click an image → **full-screen lightbox**: wheel/pinch zoom (centred on the cursor/midpoint), drag or one finger to pan,
  double-click to reset, Esc or a backdrop click to close (see §22 on mobile: pinch-zoom for images in reading).
- **Embedded audio/video**: `![[clip.mp4]]` → `<video controls>`, `![[song.mp3]]` → `<audio controls>`
  (Live Preview, Reading, public share). Video: `mp4/webm/ogv/mov/mkv`; audio: `mp3/wav/m4a/3gp/flac/ogg/
  oga/opus`. `![[clip.mp4|W]]` sets the video width. Opening a media file straight from the file tree → shows a player.
  Binaries are served over HTTP Range (206) so seeking and Safari work; MIME + extensions: `services/mime.ts` /
  `lib/media.ts`.
- Backlinks panel, outline, tag pane.
- The right sidebar is an **icon tab strip** (like Obsidian): Backlinks · Outgoing links · Tags · Outline.
  - Backlinks: "Linked mentions" (count + list) **and** "Unlinked mentions" (notes that mention the current note's name
    as plain text without linking it, found via QMD search, excluding notes that already link).
  - Outgoing links: every wikilink in the current note, split into resolved/unresolved, click to open or create.
- A **More options (⋯)** menu on each pane header (note panes and the Graph view alike), built to follow Obsidian Desktop's structure:
  - Note: Backlinks in document, Split right / Split down, Open in new window, Rename / Move file to / Make a
    copy, Bookmark, Add file property, Export to PDF…, Find…, Copy path, Open version history, Open linked view
    (Backlinks / Outgoing links / Outline), Reveal file in navigation, Share…, Close tab / Close other tabs, Delete.
  - Graph view: Copy screenshot (PNG to the clipboard), Close tab.
  - Split panes support 2 directions: right (to the right-hand side) and down (below); the split direction persists in uistate.
  - **Find/Replace inside a note**: `@codemirror/search` integrated (panel at the top, ⌘F opens Find, ⌘⇧F Replace, ⌘G next).
  - **Reveal file in navigation**: expands the ancestor folders + scrolls to/flashes the row in the file tree.
  - **Add file property**: inserts an empty property into the YAML frontmatter (creating the block if there is none) → rendered in the Properties widget.
  - **Export to PDF**: switches to Reading view and then uses the browser's print dialog (`@media print` CSS prints only the note content).
  - **Open in new window**: opens the deep-link `/note/<path>` in a new browser tab/window.
  - Note: Obsidian Desktop's "Reveal in Finder" / "Open in default app" do not apply to a web app, so they are absent.
- Graph view (force-directed, from wikilinks).
  - Finding a node on the graph: a floating search box (top-left corner), type keywords → a list of candidate nodes
    (the notes/tags/attachments currently displayed on the graph); click or Enter → the camera flies (smooth pan+zoom)
    to the node, and the node is highlighted the way hover does it (accent colour + everything unconnected dimmed) until the mouse moves.

### FR-3 · Login gate
- **Default password at install time: `123456`**, so there is no setup step, you can log in right away
  with the default password. By default settings.json contains **no** password at all.
- The user changes the password in Settings → Account (enter the current password + the new one). The new hash is
  stored in `auth.userPasswordHash`. An empty field means the default password `123456` is still in use.
- **Override password (recovery when the password is forgotten):** `auth.passwordHash` in `data/settings.json`
  (edited by hand, as a scrypt hash) **or** the `WEBOBSIDIAN_PASSWORD` environment variable (plaintext). Login
  accepts the override password **whether or not** the user has already changed their password. There is no override by default.
- Log in with one password → a JWT in an httpOnly cookie.
- Every web route and file API requires auth (except `/login` and the healthcheck).

### FR-4 · GitHub sync
- Configuration: repo URL, branch, token (PAT) or deploy key, commit name/email.
- Operations: init/clone, pull, commit-all, push; displays the status (ahead/behind/dirty).
- Optional auto-sync on an interval + a debounced sync on save.
- Git LFS: configure `.gitattributes` for the large-file patterns; track/push LFS.
- **Per-file version history**: `git log` (the commits touching the file, newest first) + `git show <hash>:<path>` via
  `GET /api/git/log` & `/api/git/show`; a modal UI lists the versions, previews the content, and offers "Restore this version"
  (overwrite + reload). Empty while the vault is not a git repo yet / Git Sync is not enabled yet.
- Conflicts: detect them, tell the user, basic merge strategy (prefer asking).

### FR-5 · Settings (JSON db)
- All configuration lives in `data/settings.json` (atomic write, with a backup).
- Groups: vault, auth, git, search, api, ui, plugins.
- A Settings UI to view/edit it; validated with a schema (zod).

### FR-6 · API Gate (AI Agent)
- Manage multiple **API keys** (create/revoke, scopes: read / write / search).
- REST endpoints under `/api/v1/*` authenticated with the `Authorization: Bearer <key>` header or `X-API-Key`.
- Capabilities: list notes, read note, create/update/delete note, search, get backlinks, append.
- Rate limit + audit log per key.

### FR-7 · QMD Search engine
- Index every `.md`: content, title, headings, tags, path, frontmatter.
- Queries: full-text, prefix, fuzzy, fielded (`tag:`, `path:`, `title:`), boolean.
- Incremental updates when a file changes (via the watcher).
- The index is persisted to and restored from disk (`data/qmd-index.json`) for a fast startup.

### FR-8 · Community plugins
- Read the plugin list from `.obsidian/plugins/*` (manifest.json, main.js).
- The plugin loader runs `main.js` in a sandbox with an **Obsidian API shim** (App, Vault, Workspace, Plugin, Notice, Setting…).
- Browse & install plugins from the community list (via GitHub releases), downloaded into the plugins directory.
- Enable/disable plugins; the state is stored in settings.

### FR-9 · Docker
- A multi-stage `Dockerfile` (build web + server → a compact image).
- `docker-compose.yml`: mounts the vault volume and the data volume, env for the password/secret.
- Healthcheck (`start_period` long enough to index a large vault the first time), restart policy.
- **Self-deploy without editing tracked files**: every deploy parameter is set through `.env` (git-ignored):
  `VAULT_HOST_PATH` (host vault → `/vault`), `HTTP_BIND`/`HTTP_PORT` (publish), `WEBOBSIDIAN_PASSWORD`,
  `WEBOBSIDIAN_WATCH`, `TRUST_PROXY` (default `true`: trust the adjacent hop so `X-Forwarded-Proto` works when
  sitting behind a reverse proxy; set it to `false` when exposed directly with no proxy, or to a subnet list/hop count to tighten it).
  `docker-compose.yml` only references `${VAR:-default}`, so a `git pull`/redeploy
  does not clobber a self-hoster's configuration. `cp .env.example .env && docker compose up -d --build`.
- **A file watcher that tolerates inotify limits**: a fresh VPS usually has a low `fs.inotify.max_user_watches`, so
  native watching fails with `ENOSPC/EMFILE`. The watcher degrades to **polling** on its own (`WEBOBSIDIAN_WATCH=auto`),
  logging how to raise the `sysctl` in order to keep native watching (lower CPU).

### FR-10 · Deep-link URL & Public share
- **Deep-link**: the browser URL reflects the note that is open: `/note/<vault-relative-path>`
  (each segment URL-encoded); the Graph view is `/graph`. Opening a URL directly (after login) opens exactly that
  note; the browser's back/forward work (popstate ↔ the app's history stack).
- **Public share (readonly, no login needed)**:
  - Create a share link for a `.md` note **or a `.canvas` canvas** → a random token (16 bytes, base64url),
    giving a URL of the form `/share/<token>`.
  - **Canvas share**: the server renders the `.canvas` into **static HTML** (a snapshot): nodes are positioned
    absolutely by coordinate, edges are drawn SSR as SVG Béziers (the same geometry as the editor), text and
    embedded notes render through the markdown pipeline; the page is full-width (the narrow markdown column is
    dropped). The public file allowlist is taken from the images in the canvas's file nodes
    (`rendercanvas.canvasEmbedTargets`). Non-interactive (no pan/zoom) in v1.
  - The public page renders Reading view (markdown → sanitized HTML), with **no** sidebar/editor and
    no auth required. Wikilinks in the note appear as static text (they do not navigate).
  - **SEO / SSR**: `GET /share/{id}` is **server-rendered into complete HTML** (no JS needed
    to read the content → Google indexable). The head contains: `<title>` (the note name), a meta description
    (the first ~160 characters of the body, with markdown stripped), canonical, Open Graph
    (`og:title/description/type=article/url/site_name/image`, the image being the first image the note
    embeds or the first web image URL), a Twitter card (`summary_large_image`/`summary`), `robots: index,follow`.
    A password-protected share → SSRs a password entry page (**noindex**, with none of the note content, and an
    unlock form driven by inline JS); a disabled/nonexistent share → 404 (noindex). Server-side markdown rendering
    uses the same unified/remark/rehype + sanitize pipeline (ported from web, with CSS inlined from the bundle).
  - Files embedded in the note (images/pdf/video) are served through a public endpoint **limited to exactly the
    files that note embeds** (`![[...]]` / `![](...)`), so the vault cannot be read at will. `.md` files are not
    served through this endpoint (no transclusion on the public page).
  - Share record: `{ id, path, enabled, createdAt, passwordHash? }` stored in `data/shares.json`
    (JSON, atomic write). At most 1 share record per note (creating it again → returns the existing record + enables it).
  - Disable (keeping the token, so it can be re-enabled) or delete outright. A disabled/deleted token → the public page returns 404.
  - **Optional password per share**: set/remove it on the management page (scrypt hash, the hash is never returned
    to the client, only `hasPassword`). When a share has a password: the public endpoint returns 401
    `{passwordRequired: true}`; the visitor enters the password → `POST /public/shares/{id}/unlock` → a JWT
    (signed with `jwtSecret`, TTL 12h, the payload carrying the share id) set in an httpOnly cookie scoped exactly to
    `/public/shares/{id}`, so embedded images send the cookie automatically. Changing/removing the password does not
    invalidate cookies that were already issued (the short TTL makes that acceptable for v1).
- **Per-note Share dialog**: the "Share…" menu item (file tree context menu + the pane's ⋯ menu, for `.md` notes
  **and `.canvas` canvases**) opens a popup with that note's share settings: create the public link, a URL box + a Copy button, a toggle to
  enable/disable the link, set/change/remove the password, delete the link permanently.
- **Recognition badge**: a note that is shared publicly (enabled) shows a **globe icon** in the accent colour next to its name
  in the file tree. The share list is cached in the store, loaded after login and refreshed after every operation
  (the dialog and Settings share the same one), so the badge is always correct.
- **Central management**: Settings → the "Sharing" tab lists every shared note, with a search box
  to filter by path, a quick enable/disable toggle, copy link, and delete.

---

### FR-11 · Mobile / responsive UI (touchscreen smartphones)
Goal: a comfortable **note reading** and **note editing** experience on a touchscreen phone,
referencing Obsidian Mobile's UX. Activated by breakpoint (`max-width: 768px`), so it is not a separate app,
just the same React codebase.
- **Drawer layout**: the ribbon + left sidebar and the right sidebar become **drawer overlays** that slide over
  the content (they do not push the layout). Closed by default → the editor fills the whole screen. Open them with: the hamburger button (☰)
  on the tab bar, **a swipe from the left/right edge** (edge-swipe), or the panel toggle buttons. There is a dimmed **backdrop**;
  touching the backdrop or picking a note → the drawer closes itself. The left drawer holds the ribbon strip (switching between the Files/Search/
  Graph/Bookmarks/Tags/Settings panels) + the content panel.
- **Drawer state is per-device** (not persisted, not broadcast over the WebSocket) → opening/closing a drawer
  on the phone does not affect the sidebar state of a desktop that shares the same `uistate`.
- **Touch targets**: file tree rows, tool buttons and tabs are ≥ 44px; more touch padding; no hover-only affordances
  (the close-tab button is always visible on mobile).
- **Format toolbar**: a formatting toolbar while editing (Live/Source): bold, italic, heading, list,
  checklist, quote, link, internal link `[[`, code, tag, indent/outdent, undo/redo. Each button acts directly
  on the currently active editor. **Mobile**: it floats above the keyboard (anchored via visualViewport) like Obsidian
  Mobile. **Desktop**: an in-flow bar right below the view-header (requested by the user).
- **Viewport & safe-area**: `viewport-fit=cover`; leave room for `env(safe-area-inset-*)` for the notch/home indicator;
  disable double-tap zoom (app-like) but keep pinch-zoom for images in reading.

### FR-12 · Canvas (infinite drawing surface, JSON Canvas)
Goal: clone Obsidian's **Canvas** feature, an infinite plane for arranging cards/notes/images/links and connecting
them with arrowed lines, used for brainstorming, moodboards and diagrams. UX reference: Obsidian Canvas.

- **The `.canvas` file format**: follows the open **JSON Canvas** standard (jsoncanvas.org) for two-way compatibility with
  Obsidian. The file is JSON `{ "nodes": [...], "edges": [...] }`.
  - **Node** (common fields): `id`, `type`, `x`, `y`, `width`, `height`, `color?`. `color` is a preset `"1".."6"`
    (red/orange/yellow/green/blue/purple) or a hex `"#RRGGBB"`.
    - `type:"text"` → `text` (markdown).
    - `type:"file"` → `file` (a vault-relative path), `subpath?` (heading/block).
    - `type:"link"` → `url`.
    - `type:"group"` → `label?`, `background?`, `backgroundStyle?`.
  - **Edge**: `id`, `fromNode`, `fromSide?`(top/right/bottom/left), `fromEnd?`(none/arrow), `toNode`,
    `toSide?`, `toEnd?`(none/arrow, default arrow), `color?`, `label?`.
- **Canvas interaction**: **left-dragging on the background = pan**; **Shift+drag = a marquee selecting several nodes**; panning also
  works with Space+drag and with a middle/right button drag; one-finger touch pans. Zoom with the scroll wheel (the cursor is the centre), plus
  zoom in/out/fit/100% buttons. Dotted grid background.
- **Nodes**: double-click the background → creates a **text node** and enters edit mode immediately; double-click a text node to edit it
  (textarea), Esc/blur to leave. Drag a node to move it; 8 handles to resize. Drop a note/image file from the tree (or
  the button) → creates a **file node** rendering an embed (a note = a markdown preview, an image = `<img>`). Recolour from a 6-colour palette +
  default. Delete (Delete/Backspace).
- **Edges**: hovering a node shows 4 side dots; drag from one dot to another node/side → creates an edge. Edges are drawn as Bézier
  curves following the side directions, with an arrow at the `to` end. Double-click the middle of an edge to add/edit its **label**. Select an edge
  to recolour/delete it.
- **Select**: click to select one node/edge; drag a marquee on the background to select several; Shift+click to add/remove; move/delete
  as a group. A floating context toolbar appears when there is a selection (recolour, delete).
- **Alignment snap (guide lines)**: while dragging a node, its edges/centre snap themselves to the edges/centres of the other nodes and
  **guide lines** appear (a port of Obsidian's `getSnapping/O3/P3` algorithm: the snap points are the 4 corners + the centre, with a threshold of
  `ceil(15/scale)` canvas units). Hold **Alt** (⌃ on macOS) to drag freely (snapping off); hold **Shift** to lock the axis.
- **Formatting inside a text card**: the same shortcuts as the main editor (`obsidianKeymap`): ⌘B bold, ⌘I italic, ⌘K insert link,
  ⌘L task, `⌘/` comment (toggles the marker); the right-click menu opens **exactly at the cursor** and shifts itself back on screen.
- **Text alignment** (an extension beyond the JSON Canvas spec): `TextNode.textAlign` = `left|center|right`, chosen from a button in the
  selection menu (when a text node is selected) or from the "Align" submenu of the right-click menu; it applies to the textarea as well as the rendered content.
  *Note: real Obsidian ignores this field when it reopens the file.*
- **Saving**: debounced autosave (~900ms) like the editor, written via `PUT /api/files/content` (store `content`/`save`,
  `.canvas` is already in `TEXT_RE`). No new endpoints.
- **Creating a new canvas**: the file tree context menu ("New canvas") + the command palette; a non-colliding
  `Untitled.canvas` name, initialised with `{"nodes":[],"edges":[]}`.
- **v1 scope (non-goals)**: no realtime collaborative cursors; groups do not auto-resize around their members;
  no portals/canvas-in-canvas embeds; no backlink graph links from a file node (keeping it simple).

### FR-13 · Desktop app (Electron, multi-platform)
Goal: package WebObsidian into an **app installed on the machine** (macOS/Windows/Linux) so users can download it and use it
like a native app, with no server or Docker to stand up themselves. It is fundamentally an **Electron shell** wrapped around the exact same
existing Express server + SPA (no code fork, no architecture change), so every web feature behaves identically.

- **Architecture**: Electron `main` **spawns the existing server as a child process** via `ELECTRON_RUN_AS_NODE`
  (reusing the Node embedded in Electron, so no Node installation is needed on the machine), bound to **`127.0.0.1` + a random free
  port** (localhost only, nothing opened to the network), and then `BrowserWindow` loads `http://127.0.0.1:<port>`.
  The server is **bundled into a single `.mjs` file** by esbuild (all deps inlined; `fsevents` is left
  external because it is optional). The SPA build (`server/public`) ships alongside it in `resources/server/public`.
- **Data & vault**: the first run shows a **vault folder picker** dialog (defaulting to `~/Documents/WebObsidianVault`
  if it is skipped). `DATA_DIR` (settings.json, index) lives in Electron's per-user `userData` directory. The
  **File → Switch Vault…** menu changes vault (relaunching to re-index), plus **Open Vault/Data Folder** and **Open Logs**.
- **Seamless login**: the app generates a **random per-machine password** stored in `userData` and passes it via
  `WEBOBSIDIAN_PASSWORD` (as the override) → **auto-login** (seeding the JWT cookie into the window's session), and marks the
  password as customised so the user is **not forced to change it** on first run. The user never has to type a password; they can still
  change it in Settings.
- **Multi-platform / multi-arch**: because the server **has no native runtime modules**, going cross-arch is only a matter of packaging
  the corresponding Electron binary. Packaged with **electron-builder**: macOS `dmg`+`zip` (arm64/x64), Windows
  `nsis`(installer)+`portable` (x64/arm64/ia32), Linux `AppImage`+`deb` (x64/arm64).
- **Releasing**: the `release.yml` GitHub Actions workflow runs on `v*` tag pushes: a macOS/Windows/Ubuntu matrix where
  each runner builds natively for its own OS and then **publishes to a GitHub Release** (draft) for users to download.
- **External dependencies**: the Git sync feature needs `git` on the machine (PATH is extended with the usual locations); without
  git the app still runs normally for editing notes locally, it just disables sync. The app is **not code-signed/notarized yet** (expect a
  Gatekeeper/SmartScreen warning, which is acceptable for a free self-hosted app).
- **Scope (non-goals)**: no auto-update yet (users download new builds by hand); no code signing yet; no bundled portable
  git; no running several windows/vaults in parallel within one instance (single-instance lock).

---

## 4. Non-functional requirements (NFR)
- **Security**: scrypt password hash, a self-generated JWT secret, API keys hashed at rest, path traversal guards
  (blocking `..`, the `.git` segment, and symlinks escaping the vault), restricted CORS, rate limiting (including on `/auth/login`:
  10 attempts per 15 minutes, **keyed on the real TCP socket address, not on `req.ip`/`X-Forwarded-For`**, so it
  cannot be bypassed by rotating XFF, **regardless of the `trust proxy` configuration**; that is why `trust proxy` is
  left enabled by default (`true`, via `TRUST_PROXY`) so `X-Forwarded-Proto`/Secure cookies work behind a proxy). The default
  password (`123456`) is **only accepted when no other credential has been configured**
  (`auth.userPasswordHash`, `auth.passwordHash`, or the `WEBOBSIDIAN_PASSWORD` env var); only then is changing it
  mandatory right after the first login (`mustChangePassword`). That flag is **not** returned by
  `GET /auth/status` (an unauthenticated route), so it cannot be used to discover which instances still accept
  the default; clients read it from `/auth/login` and `/auth/me`. Security headers via `helmet` + CSP (script-src 'self'+nonce; HTTPS is not forced,
  so HTTP self-hosting stays possible). Git tokens/PATs are redacted from every error message returned to the client and from the logs. The WebSocket
  `/ws` requires a valid login session. A plugin `id` is validated before it becomes a path segment; changing
  `vault.path` through the API is confined to `allowedRoots`.
- **Performance**: search < 100ms on a vault of ~10k notes; lazy loading for large file trees.
- **Reliability**: atomic writes for settings & notes; a backup before overwriting; git ops never lose data.
- **Portability**: runs on Linux/macOS, ARM & x86.
- **Usability**: responsive (desktop/tablet/mobile), dark/light theme.

---

## 5. API surface (summary)

### Web/session API (cookie auth)
```
POST   /auth/setup            # (legacy) set the password the first time; disabled once a default pass exists
POST   /auth/login            # login → cookie
POST   /auth/logout
POST   /auth/change-password  # change pass: { currentPassword, newPassword } (auth required)
GET    /auth/me
GET    /api/files            # directory tree
GET    /api/files/*path      # read a file (md/binary)
PUT    /api/files/*path      # write
POST   /api/files/*path      # create / upload
PATCH  /api/files            # rename/move
POST   /api/files/copy       # recursive file/folder copy {from,to} (Paste after Copy)
DELETE /api/files/*path      # delete → .trash or outright (per vault.deleteMode)
GET    /api/files/trash      # list the files in .trash
POST   /api/files/trash/restore   # restore {path} to its original location
DELETE /api/files/trash/item # permanently delete 1 item in the trash
DELETE /api/files/trash      # empty trash (delete everything outright)
GET    /api/search?q=...
GET    /api/backlinks?path=...
GET    /api/git/status | POST /api/git/{pull,commit,push,sync}
GET/PUT /api/settings
GET/POST/DELETE /api/keys     # API key management
GET    /api/plugins | POST /api/plugins/install | PATCH enable
GET    /api/shares            # list shares (management)
POST   /api/shares            # create a share for 1 note {path} → {id,...}
PATCH  /api/shares/{id}       # enable/disable {enabled}
DELETE /api/shares/{id}       # delete the share
```

### Public share (no auth): `/public` & `/share`
```
GET    /public/shares/{id}        # content of the shared note {title, content} (404 if disabled,
                                  # 401 {passwordRequired} if password-protected & not unlocked yet)
POST   /public/shares/{id}/unlock # {password} → sets the httpOnly unlock cookie (JWT 12h)
GET    /public/shares/{id}/file?path=  # a file embedded in the note (only files that note references)
GET    /share/{id}                # public HTML page: SERVER-RENDERED (SEO meta + OG + the note
                                  # content in the HTML; locked → noindex password form)
```

### Agent API (API-key auth): `/api/v1`
```
GET    /api/v1/notes                 # list (paginate)
GET    /api/v1/notes/{path}          # read
PUT    /api/v1/notes/{path}          # create/update
PATCH  /api/v1/notes/{path}/append   # append content
DELETE /api/v1/notes/{path}
GET    /api/v1/search?q=...&limit=
GET    /api/v1/backlinks?path=
GET    /api/v1/tags
```

---

## 6. Data model: `settings.json`
```jsonc
{
  "version": 1,
  "auth":   { "userPasswordHash": "scrypt$... (the changed pass; empty = using the default 123456)",
              "passwordHash": "scrypt$... (recovery override; empty = none)",
              "jwtSecret": "..." },
  "vault":  { "path": "/vault", "allowedRoots": ["/vault"], "trash": ".trash", "deleteMode": "trash" },
  "git":    { "enabled": false, "remote": "", "branch": "main",
              "token": "", "authorName": "", "authorEmail": "",
              "autoSync": false, "intervalSec": 300,
              "lfsPatterns": ["*.png","*.jpg","*.pdf","*.mp4"] },
  "search": { "fuzzy": 0.2, "indexFrontmatter": true },
  "api":    { "keys": [ { "id": "...", "name": "agent1",
                          "hash": "...", "scopes": ["read","search"],
                          "createdAt": "...", "lastUsed": "..." } ],
              "rateLimitPerMin": 120 },
  "ui":     { "theme": "obsidian-dark", "defaultView": "live" },
  "plugins":{ "enabled": ["dataview"], "installed": [] }
}
```

### `data/shares.json` (public share links, FR-10)
```jsonc
[
  { "id": "base64url-16-bytes", "path": "Folder/Note.md",
    "enabled": true, "createdAt": "2026-06-10T00:00:00.000Z",
    "passwordHash": "scrypt$...salt...$...hash..." } // optional: omit the field for a share with no password
]
```

---

## 7. Risks and decisions
- **Plugin compatibility**: many plugins use Electron-specific APIs/DOM → only a subset can be guaranteed. Decision: shim the common APIs, fail softly on the missing ones, log a warning.
- **Git token / API key security**: stored server-side in settings.json (chmod 600); mounting them from a dedicated secret/volume is recommended.
- **Large files**: Git LFS is mandatory; warn when committing a file over the threshold that is not LFS-tracked.
- **Sync conflicts**: v1 prefers notifying + manual resolution over an auto-merge that destroys data.

---

## 8. Definition of done for v1
1. Log in with 1 password, open the vault, browse the directory tree.
2. Open/edit/create/delete notes with the editor + live preview + wikilinks/backlinks.
3. Search returns QMD results in < 100ms on the sample vault.
4. Configure git and sync (pull/commit/push) successfully, LFS files included.
5. Create an API key and have an AI Agent call `/api/v1` to read/write/search successfully.
6. Install & enable at least 1 simple community plugin.
7. `docker compose up` runs the whole stack.
