# PRD: WebObsidian

> Product Requirements Document
> Version: 1.6 · Updated: 2026-07-27 · Status: Draft
> Changelog 1.6 (FR-15: native OIDC single sign-on, requested by the user): adds **FR-15**, signing in with an
> external **OpenID Connect** identity provider instead of (or beside) the master password. The entire
> authorization-code flow runs **server side**: the browser hits `GET /auth/oidc/login`, the server discovers the
> issuer, builds the authorization URL (`response_type=code`, `response_mode=query`, **S256 PKCE sent explicitly
> even when the IdP's metadata does not advertise it**) and 302s the browser to the IdP; the callback validates
> the response and exchanges the code itself. That is not a preference: the CSP in `server/src/index.ts`
> (`formAction 'self'`, `connectSrc 'self'`) blocks both browser-side options, and `express.urlencoded()` is
> registered nowhere, so a `form_post` response body would arrive empty. `state`, `nonce`, the PKCE verifier and
> the redirect URI travel in **one** signed, single-use, 10-minute cookie (`sub: 'oidc-tx'`, path `/auth/oidc`,
> `SameSite=Lax`). The session token keeps `sub: 'owner'` and carries the IdP identity in a **nested `idp`
> claim**, because the top-level `sub` is the token KIND and is the only thing separating a share-unlock cookie
> from an owner session; `cv` is still set, so a password change evicts federated sessions too. An SSO session is
> **exempt from `mustChangePassword`**, whose only remedy is typing `123456`, which a federated user has never
> been issued. Access is an **allowlist of IdP subjects and groups, and an empty allowlist lets NOBODY in**. Every
> accepted login is recorded in `data/oidc-users.json` (issuer, subject, first/last seen, display claims), which
> is the whole reason this is native rather than a reverse-proxy forward-auth: an implementation that
> authenticates and then discards the subject leaves no groundwork behind it. **This is not multi-user**: every
> allowlisted identity maps onto the single existing owner account, and password login stays enabled by default
> because the Electron desktop shell logs itself in with a shared secret. New APIs: `GET /auth/oidc/login`,
> `GET /auth/oidc/callback`; `GET /auth/status` gains `ssoEnabled`, `GET /auth/me` gains `sso`, and
> `POST /auth/login` reports `sso: false`.
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
  stored in `auth.userPasswordHash`. An empty field means the default password `123456` is still accepted, but
  **only while no override is configured either**: setting `auth.passwordHash` or `WEBOBSIDIAN_PASSWORD` retires
  `123456` immediately, without any UI step. (Before that rule existed, an operator who seeded a strong password
  through the environment and never opened the UI still had `123456` accepted as a full owner session.)
- **Override password (recovery when the password is forgotten):** `auth.passwordHash` in `data/settings.json`
  (edited by hand, as a scrypt hash) **or** the `WEBOBSIDIAN_PASSWORD` environment variable (plaintext). Login
  accepts the override password **whether or not** the user has already changed their password. There is no override by default.
- Log in with one password → a JWT in an httpOnly cookie.
- Every web route and file API requires auth (except `/login` and the healthcheck).
- **Optionally, an external OIDC identity provider mints the same owner session** (FR-15). It is a second door
  onto the one existing account, not a user system, and the password door stays open by default because the
  Electron desktop shell logs itself in with a shared secret.

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
- Groups: vault, auth, git, oidc, search, api, ui, plugins.
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
  sitting behind a reverse proxy; set it to `false` when exposed directly with no proxy. Only the subnet/preset form
  gives the rate limiters a per-client bucket instead of one shared bucket for everyone arriving from the proxy, and
  only when the range names proxies exclusively; a hop count does not, see NFR Security), `PUBLIC_ORIGIN` (optional:
  the origin(s) users type into the browser, used as the exact allowlist for the `/ws` upgrade when the proxy does not
  forward the original `Host`).
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

### FR-15 · Native OIDC single sign-on
Goal: let the owner sign in through an external **OpenID Connect** identity provider (Pocket ID, Authentik,
Keycloak, Authelia, Zitadel, …) instead of, or beside, the master password of FR-3.

**Why native, and why not a forward-auth proxy.** Putting Authelia/Authentik/tinyauth in front of the app was
considered and rejected. A forward-auth gate tells this process that *somebody* authenticated and nothing more,
so every visitor collapses into the one owner session and no per-user state can ever be built on top of it; and
it only covers browsers, leaving the `/api/v1` agent API, the Electron shell talking to `127.0.0.1` and the `/ws`
upgrade unserved. The requirement is therefore to **persist the identity**, not merely to gate the door: an
implementation that authenticates and then throws the IdP subject away gives working SSO and zero groundwork,
which is the specific failure this feature exists to avoid.

- **The flow is entirely server side.** `GET /auth/oidc/login` → the server performs OIDC discovery against
  `oidc.issuer`, builds the authorization URL and 302s the browser to the IdP. `GET /auth/oidc/callback` → the
  server validates the response, exchanges the code at the token endpoint and validates the ID token. The
  browser never talks to the IdP through this app's own code. Two independent walls in `server/src/index.ts`
  make that the only workable shape: the CSP sets `formAction: 'self'` (so a `<form action="https://idp/…">` is
  refused) and `connectSrc: 'self'` (so a browser-side `fetch()` to the IdP is refused), while CSP governs
  neither `location.assign()` nor a server-issued 302.
- **`response_mode=query`, never `form_post`.** Two reasons, either fatal on its own: the server registers
  `express.json()` and no `express.urlencoded()` anywhere, so a `form_post` body arrives empty; and a
  `SameSite=Lax` cookie is not sent on a cross-site top-level POST, so the transaction cookie would be invisible
  on exactly the request that must read it. `query` is also the spec default when the issuer publishes no
  `response_modes_supported`, which the reference IdP does not.
- **One signed, single-use transaction cookie.** `state`, `nonce`, the PKCE verifier and the exact
  `redirect_uri` are sealed into `webobsidian_oidc_tx`: an HS256 JWT signed with `auth.jwtSecret`, TTL 10 minutes
  (long enough for a TOTP prompt or a passkey), `httpOnly`, `SameSite=Lax` (the callback is a cross-site
  top-level GET, so `strict` would withhold it), scoped to the path `/auth/oidc` so it rides on nothing else. Its
  `sub` is `oidc-tx`, which keeps it in a different token-kind namespace from `owner` sessions and `share` unlock
  cookies signed with the same secret. Replay is refused on both halves: the callback clears the cookie before
  anything can fail, and the transaction's `jti` is recorded in an in-memory single-use set for its own TTL.
- **PKCE is sent explicitly, and what it does and does not buy is stated.** The reference IdP publishes no
  `code_challenge_methods_supported`, so any helper that gates PKCE on server metadata concludes the server does
  not support it and silently omits the challenge. `code_challenge`/`code_challenge_method=S256` are therefore
  passed to `buildAuthorizationUrl()` by hand and the verifier is passed to `authorizationCodeGrant()` by hand;
  openid-client v6's `supportsPKCE()` belief is advisory and is not consulted on either path, so S256 PKCE really
  is on the wire. An IdP that does not advertise the method is however not obliged to *enforce* it, so PKCE here
  is defence in depth. What actually binds the callback to the browser that started it is the signed, single-use
  transaction: `state` must match, `nonce` must appear inside the signed ID token, and the `jti` must be unused.
- **Token validation.** The ID token's signature is checked against the discovered `jwks_uri` with the algorithm
  pinned to `RS256` (`id_token_signed_response_alg`), along with `iss`, `aud`, `exp` and `nonce`; an ID token is
  required, so an access token alone cannot produce a session. `userinfo` is fetched only when a claim an
  allowlist depends on is missing from the ID token (or when there is nothing human-readable at all), and the ID
  token wins on every field it carried. The expected subject is passed to the userinfo call, so a response for a
  different user cannot be merged into the identity.
- **Access control: an allowlist of subjects and groups, empty means nobody.** `oidc.allowedSubjects` and
  `oidc.allowedGroups` are a union (any one match admits), because a real deployment mixes them: a group for the
  team, a subject for the break-glass account. Subjects compare exactly (`sub` is opaque and case-sensitive by
  specification); groups compare case-insensitively. **An entirely empty allowlist fails closed and admits
  nobody.** The convenient default would be "empty means everyone", and on a shared IdP with self-registration
  that turns a half-finished settings page into open registration on a private note vault. A locked-out operator
  can still use the password door; a world-readable vault cannot be un-read. Saving `allowedGroups` without the
  `groups` scope is refused with a 400, because the claim is only issued when the scope is requested and an
  allowlist that can never match is not a boundary.
- **The session keeps `sub: 'owner'` and nests the identity.** `issueToken()` mints
  `{ sub: 'owner', cv, idp: { iss, sub } }`. The top-level `sub` is a token KIND, and it is the only thing
  stopping a `sub: 'share'` unlock cookie from being replayed as a full owner session, so an IdP-controlled
  string must never land there: an account named `owner` or `share` would otherwise mint the wrong kind of token
  entirely. `cv` (the credential fingerprint) is set on federated sessions too, so changing the password still
  evicts them, which is the only session-eviction mechanism this app has. `readSession()` was added beside
  `verifyToken()` rather than changing its signature, so the two hot call sites (the auth middleware and the
  `/ws` upgrade) keep their boolean contract.
- **SSO sessions are exempt from `mustChangePassword`.** That flag gates the entire app in `web/src/App.tsx` and
  its only remedy submits `changePassword('123456', …)`. A federated user on an instance that never moved off
  the default password would face a wall whose exit is a password they were never issued. The exemption is
  computed on the server (`GET /auth/me` returns `mustChangePassword: !sso && !hasCustomPassword`) so that a
  client that has never heard of SSO keeps working and no future client has to re-derive it. It does not weaken
  the password, disable the local login, or mark the instance as having a custom password: it is a property of
  the session, so a password session on the same instance still sees the prompt.
- **The identity is persisted.** Every accepted login is recorded in `data/oidc-users.json` (`iss`, `sub`,
  `firstSeen`, `lastSeen`, and the display claims as of the last login), written debounced and atomically at mode
  `0600`, deliberately outside `settings.json` so record-keeping never queues behind a password change. It
  authorizes nothing today: no read of it gates a request and adding a row by hand does not create a user. It
  exists so that the day a real user model arrives, "who has used this instance, under what identity" is a
  migration rather than a rewrite. One `[audit]` line per federated login records `iss|sub` (never the display
  claims, which have no audit value the subject does not already provide).
- **Failures are opaque to the browser and precise in the log.** Every failure path 302s to
  `/?sso_error=<code>` with `code` drawn from a closed set (`not_configured`, `discovery_failed`,
  `invalid_state`, `idp_rejected`, `exchange_failed`, `no_identity`, `not_allowed`, `internal`); the detail,
  which can contain the issuer URL or a token-endpoint response body, is logged server side only, because an
  unauthenticated visitor can drive this whole path by visiting `/auth/oidc/login`. Discovery is lazy (a
  misconfigured or unreachable IdP never delays or fails startup), cached per configuration (issuer + client id +
  secret, so a settings change invalidates it with no restart), and **a failed discovery is not cached**, so a
  transient DNS blip does not leave the SSO button permanently broken. Both SSO endpoints are rate limited (30
  per 15 minutes, per surface, with separate stores so a login and its callback do not share one budget).
- **Settings and UI.** A new `oidc` block in `data/settings.json` (§6) holds `enabled`, `issuer`, `clientId`,
  `clientSecret`, `redirectUri`, `scopes`, `allowedSubjects`, `allowedGroups` and `allowPasswordLogin`, edited
  under **Settings → the OIDC tab**. `clientSecret` is write-only over the API: it is masked with the shared
  `••••••••` sentinel by `redactSettings()` and is only overwritten when the incoming value is non-empty and is
  not the sentinel, so saving a form that loaded redacted values cannot wipe it. The issuer must be `https`
  (plain `http` only for a loopback host, because the client secret, the authorization code and the ID token all
  cross that connection), neither URL may embed credentials or carry a fragment, and `redirectUri` must end with
  `/auth/oidc/callback`, which is the path this server answers on. The login screen offers the SSO entry point
  only when `GET /auth/status` reports `ssoEnabled`, which is one public bit ("this instance can federate") and
  discloses no issuer, client id or allowlist shape.
- **Password login stays on.** `oidc.allowPasswordLogin` defaults to **true**, and that default is a
  compatibility requirement rather than a taste: the Electron desktop shell starts the server itself and logs in
  without a human, by posting a per-machine shared secret (`WEBOBSIDIAN_PASSWORD`) to `/auth/login`. It has no
  browser to send to an IdP, so turning password login off does not harden the desktop app, it bricks it. The
  same is true of any scripted client. Turning the flag off while OIDC is unusable is refused by the API (400)
  and healed on load, because it would otherwise lock every door at once with the only remedy being a hand edit
  of `settings.json`. **Status:** the flag is stored, validated and healed, but `POST /auth/login` does not yet
  consult it, so in this build the password door is always open; see IMPLEMENTATION_PLAN Phase 28.
- **Scope (non-goals), stated so nobody deploys this expecting team access control**:
  - **This is not multi-user.** Every allowlisted IdP identity maps onto the **single existing owner account**.
    The app has no user model: no roles, no permissions, no per-user vaults, no per-user workspace state, no
    per-user shares or API keys. Two people admitted by the allowlist are the same owner with the same full read
    and write over every note, and nothing distinguishes their sessions except a claim nobody dispatches on.
  - No RP-initiated logout: `POST /auth/logout` clears the local cookie only and does not call the IdP's
    `end_session_endpoint`, so the IdP session survives.
  - No refresh tokens and no tracking of the IdP's session lifetime. The 30-day owner cookie is the session, and
    an account disabled at the IdP keeps its existing cookie until it expires, is evicted by a password change,
    or is removed from the allowlist (which takes effect on the next login, not on the current session).
  - No device-code or hybrid flows, no dynamic client registration, no JIT/SCIM provisioning, no group-to-role
    mapping (there are no roles), and no OIDC path for the `/api/v1` agent API, which continues to use API keys.

---

## 4. Non-functional requirements (NFR)
- **Security**: scrypt password hash, a self-generated JWT secret, API keys hashed at rest, path traversal guards
  (blocking `..`, the `.git` segment, and symlinks escaping the vault), restricted CORS, rate limiting (including on `/auth/login`:
  10 attempts per 15 minutes). **A limiter believes a forwarded address only when Express itself attested it, which is
  only the subnet/preset form of `trust proxy`**: that is the one form where proxy-addr tests the *address* of each hop
  and truncates at the first one outside the list, so it is self-validating and an entry the client wrote itself is
  discarded. Every other form, including the default bare `true`, `false`, and **any hop count**, keys on the **TCP
  socket address**, which cannot be forged; a hop count buys nothing here, because for that form Express only counts
  hops and never checks who the peer is, so its answer is not used. The default stays `true` rather than `false` so
  `X-Forwarded-Proto`/Secure cookies keep working behind a proxy out of the box. **The accepted cost:** a proxied
  deployment left at the default collapses every visitor into one bucket, so a stranger's ten failed logins keep the
  owner out for the rest of the 15-minute window. That is availability, not integrity, and it is bounded because
  refused attempts are never recorded, so a lockout cannot be held open by continued hammering. The subnet form buys
  per-client buckets back but carries its own precondition, stated in `SECURITY.md` and `.env.example`: the range must
  contain proxies only, since a range that also covers real clients lets each of them mint a bucket per request.
  `middleware/ratelimit.ts` additionally ships a second layer, `createFailureLimiter`, keyed on the caller's identity
  rather than the network and charging only failed attempts with a success clearing the counter, which is the intended
  remedy for the shared bucket; **it is a primitive with no call site yet**, so no route currently benefits from it.
  The default
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
# (removed) POST /auth/setup  # unauthenticated: it set the owner password and returned a session
#                             # cookie, guarded only by a function that always returned true. One
#                             # edit to that guard would have made it a public account takeover, so
#                             # it was deleted rather than re-guarded. First run is now: log in with
#                             # the default password (or WEBOBSIDIAN_PASSWORD), then
#                             # POST /auth/change-password (forced by `mustChangePassword`).
POST   /auth/login            # login → cookie; → { ok, sso:false, mustChangePassword }
POST   /auth/logout           # clears the local cookie only (no RP-initiated logout at the IdP)
POST   /auth/change-password  # change pass: { currentPassword, newPassword } (auth required)
GET    /auth/me               # → { authenticated, sso, mustChangePassword } (auth required)
GET    /auth/status           # unauthenticated → { passwordSet, ssoEnabled }; deliberately says nothing
                              # about mustChangePassword (see NFR Security)
GET    /auth/oidc/login       # FR-15: 302 → the IdP authorization endpoint, sets the transaction cookie
GET    /auth/oidc/callback    # FR-15: authorization response → session cookie + 302 /,
                              # or 302 /?sso_error=<code> (closed set of codes, detail only in the log)
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
  // Schema version. Current is 2 (`CURRENT_SETTINGS_VERSION` in services/settings.ts); a file with no
  // `version` key predates the `auth.userPasswordHash` split and is migrated once, then stamped.
  "version": 2,
  // Password hashes are `scrypt$N=131072,r=8,p=1$<saltHex>$<hashHex>`: the cost parameters are
  // stored IN the string, so they can be raised later without invalidating existing hashes. The
  // old 3-field form `scrypt$<saltHex>$<hashHex>` (implicitly N=16384) still verifies forever.
  // `userPasswordHash` is upgraded to the current cost on the next successful login, the one
  // moment the plaintext is in hand; `passwordHash` is deliberately never rewritten, because the
  // operator hand-edited it and the file must keep matching what they wrote. Either form is
  // accepted when hand-writing a recovery hash, but produce the 4-field one.
  // `123456` is accepted only when NONE of userPasswordHash / passwordHash / WEBOBSIDIAN_PASSWORD is
  // set, so an empty `userPasswordHash` on its own no longer means the default is live.
  "auth":   { "userPasswordHash": "scrypt$N=131072,r=8,p=1$<saltHex>$<hashHex> (the changed pass; empty = never changed in the UI)",
              "passwordHash": "scrypt$N=131072,r=8,p=1$<saltHex>$<hashHex> (recovery override; empty = none)",
              "jwtSecret": "..." },
  "vault":  { "path": "/vault", "allowedRoots": ["/vault"], "trash": ".trash", "attachmentDir": "attachments",
              "deleteMode": "trash" },
  "git":    { "enabled": false, "remote": "", "branch": "main",
              "token": "", "authorName": "", "authorEmail": "",
              "autoSync": false, "intervalSec": 300,
              "lfsPatterns": ["*.png","*.jpg","*.pdf","*.mp4"] },
  // FR-15. `enabled` off by default, so this block appearing in an existing install changes nothing.
  // `issuer` is stored WITHOUT a trailing slash (discovery is `issuer + "/.well-known/openid-configuration"`
  // string concatenation, and the value is compared against the id_token's `iss`); https is required except
  // for a loopback host. `clientSecret` is write-only over the API: redactSettings() masks it with the shared
  // `••••••••` sentinel and a PUT only overwrites it when the incoming value is non-empty AND is not that
  // sentinel, so saving a form that loaded redacted values cannot destroy it. Empty is a legitimate value for
  // a public (PKCE-only) client as far as the schema and the API are concerned. `redirectUri` must end with
  // `/auth/oidc/callback`; empty means "derive it from the arriving request", which is correct for a single-host
  // install and wrong the moment a proxy rewrites the host or the path. `allowedSubjects`/`allowedGroups` are a
  // union and AN EMPTY ALLOWLIST ADMITS NOBODY; `allowedGroups` requires the `groups` scope (the API answers 400
  // otherwise, because the claim is only issued when it is requested). `allowPasswordLogin` defaults to true and
  // must stay true while OIDC is unusable, or the Electron shell's automatic login breaks with no way back in.
  "oidc":   { "enabled": false, "issuer": "", "clientId": "", "clientSecret": "",
              "redirectUri": "", "scopes": ["openid","profile","email"],
              "allowedSubjects": [], "allowedGroups": [], "allowPasswordLogin": true },
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
    "passwordHash": "scrypt$N=131072,r=8,p=1$...salt...$...hash..." } // optional: omit the field for a share with no password
    // Same format as auth.*. Share hashes are NOT rehashed opportunistically (the unlock path
    // never rewrites the record), so a share created before the cost bump keeps its old
    // parameters and stays verifiable through the legacy 3-field branch.
]
```

### `data/oidc-users.json` (federated identities seen, FR-15)
```jsonc
// Keyed by `<iss>|<sub>`. Written debounced (10s) and atomically at mode 0600, and kept OUT of
// settings.json on purpose: it is telemetry-grade record-keeping written on the login path, and it has no
// business queueing behind (or ahead of) a password change over one shared cache and one shared file.
//
// IT AUTHORIZES NOTHING. Every allowlisted identity maps onto the single owner account, so no read of this
// file gates a request, no absence of a record denies one, and adding a row by hand does not create a user.
// It exists so that the day a real user model arrives, "who has used this instance and under what identity"
// is answerable from data already on disk: a migration rather than a rewrite that asks everyone to re-enrol.
// Best effort by design (a hard kill can lose up to 10s of updates); the identity is re-recorded next login.
{
  "https://auth.example.com|8f3c…": {
    "iss": "https://auth.example.com",
    "sub": "8f3c…",                       // opaque, stable, never reassigned by the IdP
    "firstSeen": "2026-07-27T10:00:00.000Z",
    "lastSeen":  "2026-07-27T18:22:41.000Z",
    // Display claims as of the MOST RECENT login (any of them may be empty): overwritten every time, because
    // they are the IdP's current answer. The subject is what stays fixed.
    "name": "Ada Lovelace", "email": "ada@example.com", "preferredUsername": "ada"
  }
}
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
