# Obsidian Desktop 1.12.7: Reverse Engineering Notes

> **Purpose:** This document records the results of reverse engineering the Obsidian Desktop App (version 1.12.7, macOS)
> so that WebObsidian can **reproduce Obsidian exactly**: its behaviour, its data formats, and its interface.
> Every regex, default value, JSON schema, and formula below was **extracted verbatim from the real code**
> (the extracted asar), not from the public documentation.
>
> **Source:** `/Applications/Obsidian.app/Contents/Resources/obsidian.asar`, extracted with
> `npx @electron/asar extract` → `app.js` (3.6MB renderer), `app.css` (588KB), `main.js` (60KB Electron main),
> `worker.js` (239KB Metadata Cache Worker), `sim.js` (Graph physics worker), `starter.js` (vault chooser),
> plus the real vault at `~/ObsidianVault-Trilium/.obsidian/`.
>
> **Bundled libraries (lib/):** CodeMirror 6 (bundled inside app.js; lib/codemirror is CM5, used only for sandbox/legacy),
> PixiJS (graph render), Mermaid, MathJax (tex-chtml-full), Prism (syntax highlight), PDF.js, moment,
> i18next, turndown (HTML→MD), readability, DOMPurify (bundled inside app.js).
>
> Last updated: 2026-06-10.

## Table of contents

1. [Electron shell, vault registry, obsidian:// protocol](#1-electron-shell)
2. [Core object model & event system](#2-object-model)
3. [Registry of core plugins & view types](#3-core-plugins)
4. [Default commands & hotkeys](#4-commands--hotkeys)
5. [Settings schema (.obsidian/): the complete set](#5-settings-schema)
6. [workspace.json format](#6-workspacejson)
7. [Markdown dialect: the exact regexes](#7-markdown-dialect)
8. [Link resolution & MetadataCache](#8-link-resolution--metadatacache)
9. [Editor: CodeMirror 6, Live Preview, suggesters, fuzzy search](#9-editor)
10. [Reading view & pipeline post-processing](#10-reading-view)
11. [Global Search: grammar & operators](#11-global-search)
12. [Quick Switcher](#12-quick-switcher)
13. [Graph view: physics & graph.json](#13-graph-view)
14. [Canvas (.canvas format)](#14-canvas)
15. [Bases (.base format)](#15-bases)
16. [Daily notes / Templates / Unique note](#16-daily-notes--templates)
17. [File handling: attachments, rename, trash, recovery](#17-file-handling)
18. [Per-device storage: localStorage & IndexedDB](#18-per-device-state)
19. [CSS/theming system: design tokens](#19-css-theming)
20. [DOM class structure](#20-dom-classes)
21. [Callouts: the complete table](#21-callouts)
22. [Checklist for cloning a feature](#22-checklist-clone)

---

## 1. Electron shell

### Vault window

```js
new BrowserWindow({
  width: 800, height: 600, minWidth: 200, minHeight: 150,
  backgroundColor: "#00000000",
  trafficLightPosition: { x: 19, y: 12 },
  show: false,
  frame: <true only when config.frame === "native">,
  titleBarStyle: <"default" for a native frame, otherwise "hidden">,
  webPreferences: { contextIsolation: false, nodeIntegration: true,
    nodeIntegrationInWorker: true, spellcheck: true, webviewTag: true },
  ...savedWindowState  // x,y,width,height restored per vault
})
```

- The app loads through the custom protocol `app://obsidian.md/index.html` (serves files out of the asar, supports Range,
  `X-Frame-Options: DENY`); a second, random origin `app://<36 random hex>/` serves arbitrary local files
  (vault resources).
- Per-vault window state is stored in `<userData>/<vaultId>.json`: `{x, y, width, height, isMaximized, devTools, zoom}`
  (debounced 100ms on move/resize). Restoring clamps to a minimum of 300×200 and checks visibility across every display.
- Vault chooser (starter): frameless 800×650, not resizable, bg `#1e1e1e`. Help window: 600×680.
- Startup: opens every vault with `open: true` in the registry; if there are none, it shows the starter.

### Vault registry: `<userData>/obsidian.json`

```jsonc
{
  "vaults": {
    "<vaultId>": { "path": "/abs/path", "ts": 1780115021752, "open": true }
  },
  // other keys: "frame", "insider", "cli", "updateDisabled", "disableGpu",
  // "adblock", "adblockFrequency", "icon", "openSchemes"
}
```
- `vaultId` = 16 random hex characters (`(Math.random()*16|0).toString(16)` × 16).
- `ts` = `Date.now()` on every vault open (the "recency" value).
- `open: true` while the vault has a window (removed on close, except during quit); this is what drives restore on launch.
- Vault lookup is by id **or** by folder basename (case-insensitive).

### Protocol `obsidian://`

Parsed in the main process; the payload is injected into the renderer through `window.OBS_ACT` (called if it is
already a function, assigned if not, so the SPA picks it up at boot). A web clone can reuse this contract as is.

| URL | Action |
|---|---|
| `obsidian:///abs/path` | `{action:"open", path}` → find the vault containing path |
| `obsidian://vault/<nameOrId>/<file...>` | `{action:"open", vault, file}` |
| `obsidian://<action>?k=v&...#hash` | `{action, ...query, hash}` (a param with no value → `"true"`) |

Renderer-side handlers (the `protocolHandlers` Map, extensible through `registerObsidianProtocolHandler`):
- **`open`**: file + subpath via `getFirstLinkpathDest`, plus the `paneType` param
- **`search`**: `query` → global-search
- **`new`**: params `file`/`name`, `content` | `clipboard`, `append`/`prepend`/`overwrite`, `silent`, `paneType`; creates folders as needed
- **`show-plugin`** (`id`), **`show-theme`** (`name`), **`show-release-notes`**, **`debug-info`**,
  **`publish-sites`**, **`sync-setup`**, **`vault-setup`**, **`hook-get-address`** (x-callback-url, gated by the `uriCallbacks` config)
- Generic x-callback-url support through the `x-success`/`x-error` params.

### Main IPC channels

`is-dev, version, file-url, print-to-pdf, vault, vault-list, vault-remove, vault-move, vault-open,
vault-message, starter, help, sandbox, context-menu, request-url (proxy net.request), open-url,
trash (shell.trashItem), set-menu/render-menu, create-browser-session`, plus a CLI server over a local socket
(the `obsidian` CLI command, gated by the `cli` setting).

---

## 2. Object model

### App (singleton, constructed with `(adapter, appId)`)

`appId` = the vault id, used as the namespace for localStorage (`<appId>-<key>`), IndexedDB (`<appId>-cache`, `<appId>-backup`),
and the webview partition (`persist:vault-<appId>`).

Components: `keymap` (Keymap), `scope` (root Scope), `commands`, `hotkeyManager`, `dragManager`, `customCss`,
`embedRegistry`, `viewRegistry`, then `vault`, `workspace`, `fileManager`, `statusBar`, `metadataCache`,
`metadataTypeManager` (property types → `types.json`), `setting` (the settings modal), `foldManager`
(fold state → localStorage `<appId>-note-fold-<path>`), `internalPlugins`, `plugins` (community).

**Boot order:** vault adapter → `vault.setupConfig` → Workspace/FileManager/StatusBar/MetadataCache/
MetadataTypeManager/Setting/FoldManager → apply theme/font/css → register the built-in commands → load every
internal plugin → `internalPlugins.enable()` → community plugins → `workspace.loadLayout()` →
`trigger("layout-ready")`.

### Vault + DataAdapter

- `fileMap: {path → TAbstractFile}` (TFile / TFolder), root `""`/`"/"`; `configDir` defaults to `".obsidian"`
  (changeable, must start with `.`; the replacement name is stored in localStorage `<appId>-config`).
- The adapter's raw watcher → Vault maps the events: `folder-created`/`file-created` → `create`, `modified` → `modify`,
  `file-removed`/`folder-removed` → `delete`, `renamed` → `rename(file, oldPath)`, `closed` (the vault folder disappeared),
  `raw(path)` (dotfiles, which drive hot-reload of `app.json`, `appearance.json`, `hotkeys.json`, `core-plugins.json`,
  and a plugin's `data.json` → this is what lets it coexist with sync and multi-window).
- API adapter: `read/readBinary/write/writeBinary/append/process/mkdir/rmdir/remove/rename/copy/stat/exists/list/watch/getResourcePath`, `trashSystem` (OS trash) and `trashLocal` (moves into `<vault>/.trash/`).
- Config: merges `appearance.json` and then `app.json` (app wins); `setConfig` debounce-saves after 1s and triggers
  `config-changed`; on save the keys are split back into the two files according to the appearance whitelist (§5).

### MetadataCache

- Parsing happens in `worker.js` (a dedicated Worker named "Metadata Cache Worker"). Protocol: post
  `{metadataCache: <ArrayBuffer of the file bytes>}` → returns `CachedMetadata` (§8).
- Persistent cache: IndexedDB **`<appId>-cache`** (version **19**), 2 stores:
  - `file`: path → `{hash, mtime, size}`
  - `metadata`: hash → CachedMetadata; `hash` = **the SHA-256 hex of the raw bytes**.
  - On boot it revalidates using `mtime`+`size`; a mismatch means a reparse. Deleted paths are swept every 600s.
- Maintains `resolvedLinks` / `unresolvedLinks`: `{sourcePath: {targetPath|linktext: count}}`, the source of truth for graph/backlinks.
- Events: `changed` (a file's metadata changed), `deleted`, `resolve` (the links of one file), `resolved` (the whole vault is done), `finished` (the first index pass).
- API: `getFileCache, getCache, getFirstLinkpathDest, getLinkpathDest, fileToLinktext, iterateAllRefs, isUnresolved`.

### Workspace

- Item tree: `WorkspaceItem → WorkspaceParent → WorkspaceSplit / WorkspaceTabs / WorkspaceLeaf`,
  root split, left/right sidebars, floating (popout), mobile drawers.
- Fields: `rootSplit, leftSplit, rightSplit, floatingSplit, leftRibbon, activeLeaf, activeTabGroup,
  recentFileTracker (lastOpenFiles), undoHistory (Mod+Shift+T), protocolHandlers, hoverLinkSources`
  (pre-registered: `editor, preview, search, graph, outline, properties, file-explorer, bases, tab-header`).
- `requestSaveLayout` is debounced 1s. Leaf: `setViewState({type, state, active, pinned, group})`, back/forward
  history (serializable), **deferred views** (a "DeferredView" placeholder while the tab is not visible,
  loaded through `loadIfDeferred`), pin, group (linked panes).

### Keymap & Scope

- The Keymap is global with a scope **stack** (`pushScope/popScope`), catching `keydown` in the capture phase on window;
  modifiers are normalised into the sorted string `"Alt,Ctrl,Meta,Shift"`; `"Mod"` = Meta on macOS, Ctrl elsewhere.
  A handler returning `false` → `preventDefault`.
- `Scope.register(modifiers, key, func)`; the scope chain walks up to the parent.

### Commands & HotkeyManager

- `addCommand({id, name, icon, callback | checkCallback | editorCallback | editorCheckCallback, hotkeys, ...})`.
- HotkeyManager: `defaultKeys` (from addCommand) + `customKeys` from `<configDir>/hotkeys.json` (hot-reloaded).

### Every `trigger("...")` event name found

```
active-leaf-change, bookmarks:bookmarks-menu, canvas:edge-menu, canvas:node-connection-drop-menu,
canvas:node-menu, canvas:selection-menu, change, changed, closed, config-changed, create, css-change,
delete, deleted, editor-change, editor-drop, editor-menu, editor-paste, editor-selection-change,
extensions-updated, file-created, file-menu, file-open, file-removed, files-menu, finished,
folder-created, folder-removed, group-change, history-change, hover-link, input, layout-change,
layout-ready, leaf-menu, markdown-properties-menu, markdown-scroll, markdown-viewport-menu, modified,
modify, navigated, new-log, options-updated, pinned-change, post-processor-change, quick-preview,
quit, raw, receive-files-menu, receive-text-menu, rename, renamed, resize, resolve, resolved,
search:results-menu, status-change, swipe, tab-group-menu, url-menu, view-changed, view-registered,
view-unregistered, webviewer:update-history, window-close, window-frame-change, window-open
```
(Vault: `create/modify/delete/rename/raw/closed/config-changed`; MetadataCache: `changed/deleted/resolve/resolved/finished`;
Workspace: `active-leaf-change/file-open/layout-change/layout-ready/css-change/resize/quick-preview/hover-link/...`).

---

## 3. Core plugins

31 internal plugins. Their on/off state lives in `core-plugins.json` (`{id: bool}`); a missing key falls back to `defaultOn`.
Legacy id `starred` → `bookmarks`.

| id | default | registered view types | notes |
|---|---|---|---|
| `audio-recorder` | off | none | writes `Recording YYYYMMDDHHmmss.<ext>` into attachments |
| `backlink` | **on** | `backlink` | + "backlinks in document" |
| `bases` | **on** | `bases` (+ ext `.base`); internal layouts `table`, `cards`, `list` | DB views |
| `bookmarks` | **on** | `bookmarks` | `bookmarks.json` |
| `canvas` | **on** | `canvas` (+ ext `.canvas`) | |
| `command-palette` | **on** | none (modal) | `recentCommands` |
| `daily-notes` | **on** | none | |
| `editor-status` | **on** (hidden from the list) | none | status bar Editing/Reading |
| `file-explorer` | **on** | `file-explorer` | |
| `file-recovery` | **on** | none | snapshot → IndexedDB |
| `footnotes` | off | `footnotes` | footnotes panel (new in 1.12) |
| `global-search` | **on** | `search` | |
| `graph` | **on** | `graph`, `localgraph` | |
| `markdown-importer` | off | none | |
| `note-composer` | **on** | none | extract/merge/split |
| `outgoing-link` | **on** | `outgoing-link` | |
| `outline` | **on** | `outline` | |
| `page-preview` | **on** | none | hover popover, per-source `overrides` |
| `properties` | **on** | `all-properties`, `file-properties` | |
| `publish` | off | none | |
| `random-note` | off | none | |
| `slash-command` | off | none | `/` suggest |
| `slides` | off | none | |
| `switcher` | **on** | none (modal) | |
| `sync` | **on** (idle until configured) | `sync` | IndexedDB `<appId>-sync` |
| `tag-pane` | **on** | `tag` | |
| `templates` | **on** | none | |
| `webviewer` | off (desktop only) | `webviewer`, `webviewer-history` | |
| `word-count` | **on** | none | status bar |
| `workspaces` | off | none | `workspaces.json` |
| `zk-prefixer` | off | none | Unique note creator |

### Built-in ViewRegistry (always registered)

| view type | extensions |
|---|---|
| `markdown` | `md` |
| `image` | `bmp, png, jpg, jpeg, gif, svg, webp, avif` |
| `audio` | `mp3, wav, m4a, 3gp, flac, ogg, oga, opus` |
| `video` | `mp4, webm, ogv, mov, mkv` |
| `pdf` | `pdf` |
| `release-notes`, `empty` | none |

An unregistered extension → opened with the OS default app (unless `showUnsupportedFiles`).

---

## 4. Commands & hotkeys

~196 namespaced command ids. `Mod` = Cmd (macOS) / Ctrl. **Bold** = has a default hotkey.

**App:** `app:delete-file`, **`app:go-back`** (Mod+Alt+←), **`app:go-forward`** (Mod+Alt+→),
`app:open-another-vault`, **`app:open-help`** (F1), `app:open-sandbox-vault`, **`app:open-settings`** (Mod+,),
`app:open-vault`, `app:reload`, `app:show-debug-info`, `app:show-release-notes`, `app:show-tab-switcher`,
`app:switch-vault`, `app:toggle-left-sidebar`, `app:toggle-right-sidebar`, `app:toggle-ribbon`,
`theme:switch`, `theme:toggle-light-dark`, `window:zoom-in/out`, `window:reset-zoom`, `window:toggle-always-on-top`.

**Editor:** `editor:add-cursor-above/below`, `editor:attach-file`, `editor:clear-formatting`,
`editor:cycle-list-checklist`, **`editor:delete-paragraph`** (Mod+D), `editor:focus(-left/right/up/down)`,
`editor:fold-all/fold-less/fold-more/unfold-all`, **`editor:follow-link`** (Alt+Enter),
`editor:insert-callout/codeblock/embed/footnote/horizontal-rule/mathblock/table/tag/wikilink`,
**`editor:insert-link`** (Mod+K), **`editor:open-link-in-new-leaf`** (Mod+Enter),
**`editor:open-link-in-new-split`** (Mod+Alt+Enter), **`editor:open-link-in-new-window`** (Mod+Alt+Shift+Enter),
**`editor:open-search`** (Mod+F), **`editor:open-search-replace`** (Mod+H), `editor:redo/undo`,
`editor:rename-heading`, **`editor:save-file`** (Mod+S), `editor:set-heading(-0..6)`, `editor:swap-line-up/down`,
`editor:table-*` (row/column operations), `editor:toggle-blockquote`, **`editor:toggle-bold`** (Mod+B),
`editor:toggle-bullet-list`, **`editor:toggle-checklist-status`** (Mod+L), `editor:toggle-code`,
**`editor:toggle-comments`** (Mod+/), `editor:toggle-fold`, `editor:toggle-highlight`,
`editor:toggle-inline-math`, **`editor:toggle-italics`** (Mod+I), `editor:toggle-line-numbers`,
`editor:toggle-numbered-list`, `editor:toggle-readable-line-length`, `editor:toggle-source`,
`editor:toggle-spellcheck`, `editor:toggle-strikethrough`, `editor:indent-list/unindent-list`,
`markdown:add-alias`, **`markdown:add-metadata-property`** (Mod+;), `markdown:clear-metadata-properties`,
**`markdown:toggle-preview`** (Mod+E).

**Workspace:** **`workspace:close`** (Mod+W), `workspace:close-others`, `workspace:close-tab-group`,
**`workspace:close-window`** (Mod+Shift+W), `workspace:copy-path/copy-full-path/copy-url`,
**`workspace:edit-file-title`** (F2), `workspace:export-pdf`, **`workspace:goto-tab-1…8`** (Mod+1…8),
**`workspace:goto-last-tab`** (Mod+9), `workspace:move-to-new-window`, **`workspace:new-tab`** (Mod+T),
`workspace:new-window`, **`workspace:next-tab`** (Ctrl+Tab; on macOS also Meta+Shift+]),
**`workspace:previous-tab`** (Ctrl+Shift+Tab; macOS Meta+Shift+[), `workspace:show-trash` (when trashOption=local),
`workspace:split-horizontal/vertical`, `workspace:toggle-pin`, `workspace:toggle-stacked-tabs`,
**`workspace:undo-close-pane`** (Mod+Shift+T).

**Plugin:** **`command-palette:open`** (Mod+P); **`switcher:open`** (Mod+O); **`global-search:open`** (Mod+Shift+F);
**`graph:open`** (Mod+G), `graph:open-local`, `graph:animate`; **`file-explorer:new-file`** (Mod+N),
**`file-explorer:new-file-in-new-pane`** (Mod+Shift+N), `file-explorer:new-folder/duplicate-file/move-file/reveal-active-file`;
`backlink:open(-backlinks)`, `backlink:toggle-backlinks-in-document`; `bookmarks:open`,
`bookmarks:bookmark-current-view/-search/-section/-heading`, `bookmarks:bookmark-all-tabs`;
`canvas:new-file/convert-to-file/export-as-image/jump-to-group`; `daily-notes`, `daily-notes:goto-prev/next`;
`note-composer:extract-heading/merge-file/split-file`; `outline:open(-for-current)`; `outgoing-links:open(-for-current)`;
`properties:open(-local)`; `random-note`; `tag-pane:open`; `templates:insert-template`;
`workspaces:load/save/open-modal`; `file-recovery:open`; `open-with-default-app:open/show`;
`audio-recorder:start/stop`; `slides:start`; `sync:*`; `webviewer:*`; `bases:*`.

Character pairs used by the formatting toggles: bold `**` (alt `__`), italic `*` (alt `_`), code `` ` ``, highlight `==`,
strikethrough `~~`, comment `%%`, math `$`.

Custom hotkeys: `.obsidian/hotkeys.json`, shaped `{ "<command-id>": [{ "modifiers": ["Mod"], "key": "F" }] }`;
**an empty array `[]` removes the default hotkey**.

---

## 5. Settings schema

A single defaults object; on save, keys in the appearance whitelist are written to **`appearance.json`**,
the rest to **`app.json`**. **Only keys that differ from the default are written** (a fresh vault ⇒ `{}`).

### appearance.json

| key | type | default | meaning |
|---|---|---|---|
| `accentColor` | string | `""` | hex; empty = the default purple |
| `theme` | string | `"system"` | `"system"` \| `"obsidian"` (dark) \| `"moonstone"` (light) |
| `cssTheme` | string | `""` | name of the theme folder inside `.obsidian/themes/` |
| `enabledCssSnippets` | string[] | `[]` | file names (without `.css`) inside `snippets/` |
| `showViewHeader` | bool | `true` | |
| `showRibbon` | bool | `true` | |
| `nativeMenus` | bool\|null | `null` | |
| `translucency` | bool | `false` | |
| `textFontFamily` / `interfaceFontFamily` / `monospaceFontFamily` | string | `""` | (legacy `editorFontFamily` → `textFontFamily`) |
| `baseFontSize` | number | `16` | px |
| `baseFontSizeAction` | bool | `false` | |
| `slidingSidebar` / `floatingNavigation` / `autoFullScreen` | bool | `true` | mobile |

### app.json

| key | type | default | meaning |
|---|---|---|---|
| `alwaysUpdateLinks` | bool | `false` | update links on rename automatically, without asking |
| `spellcheck` | bool | `true` | |
| `spellcheckLanguages` | string[]\|null | `null` | |
| `readableLineLength` | bool | `true` | caps the line width |
| `strictLineBreaks` | bool | `false` | |
| `propertiesInDocument` | string | `"visible"` | `"visible"\|"hidden"\|"source"` |
| `showInlineTitle` | bool | `true` | |
| `showUnsupportedFiles` | bool | `false` | |
| `autoPairBrackets` / `autoPairMarkdown` | bool | `true` | |
| `smartIndentList` | bool | `true` | |
| `foldHeading` / `foldIndent` | bool | `true` | |
| `showLineNumber` | bool | `false` | |
| `showIndentGuide` | bool | `true` | |
| `useTab` | bool | `true` | |
| `tabSize` | number | `4` | |
| `rightToLeft` | bool | `false` | |
| `autoConvertHtml` | bool | `true` | paste HTML → MD |
| `vimMode` | bool | `false` | |
| `livePreview` | bool | `true` | the default edit mode is LP |
| `defaultViewMode` | string | `"source"` | `"source"` (edit) \| `"preview"` (reading) |
| `useMarkdownLinks` | bool | `false` | `[]()` instead of wikilinks |
| `newLinkFormat` | string | `"shortest"` | `"shortest"\|"relative"\|"absolute"` |
| `attachmentFolderPath` | string | `"/"` | `"/"`=root, `"./"`=beside the note, `"./sub"`=subfolder beside the note, `"name"`=a fixed folder |
| `newFileLocation` | string | `"root"` | `"root"\|"current"\|"folder"` |
| `newFileFolderPath` | string | `"/"` | used when `newFileLocation==="folder"` |
| `userIgnoreFilters` | string[]\|null | `null` | Excluded files |
| `focusNewTab` | bool | `true` | |
| `promptDelete` | bool | `true` | |
| `trashOption` | string | `"system"` | `"system"\|"local"(.trash/)\|"none"` |
| `deleteUnlinkedAttachments` | string | `"ask"` | `"ask"\|"always"\|"never"` |
| `openBehavior` | string | `""` | `"daily"` = open the daily note at launch |
| `pdfExportSettings` | object | `{pageSize:"Letter",landscape:false,margin:"0",downscalePercent:100}` | |
| `uriCallbacks` | bool | `false` | allows `hook-get-address` |

### Every file inside `.obsidian/`

| File | Schema |
|---|---|
| `app.json`, `appearance.json` | above |
| `core-plugins.json` | `{ "<plugin-id>": bool }` |
| `community-plugins.json` | an **array** of the enabled plugin ids |
| `hotkeys.json` | `{ "<command-id>": [{modifiers, key}] }`; `[]` = remove the default |
| `graph.json` | §13 |
| `canvas.json` | `{ "snapToObjects": bool, "snapToGrid": bool }` |
| `switcher.json` | `{ showExistingOnly:false, showAttachments:true, showAllFileTypes:false }` |
| `daily-notes.json` | `{ format:"" (moment, defaults to "YYYY-MM-DD"), folder:"", template:"" }` |
| `templates.json` | `{ folder:"", dateFormat:"" ("YYYY-MM-DD"), timeFormat:"" ("HH:mm") }` |
| `zk-prefixer.json` | `{ format:"" ("YYYYMMDDHHmm"), folder:"", template:"" }` |
| `bookmarks.json` | `{ items: [...] }`; types: `file` (`{type,ctime,path,subpath?,title?}`, where a heading/block bookmark is file+subpath), `folder`, `group` (`{items:[...], title}`, nestable), `search` (`{query}`), `graph` (`{title, options:<same shape as graph.json>}`), `url` |
| `workspace.json` / `workspace-mobile.json` | §6 |
| `workspaces.json` | `{ workspaces: { "<name>": <the full layout> }, active: "<name>" }` |
| `types.json` | `{ types: { "<PropertyName>": "<widget>" } }`; widget: `text, multitext, number, checkbox, date, datetime, tags, aliases` (forced: `aliases→aliases`, `cssclasses→multitext`, `tags→tags`) |
| `snippets/` | `<name>.css` files |
| `themes/<Name>/` | `manifest.json` (`{name, version, minAppVersion, author, authorUrl}`) + `theme.css` |
| `plugins/<id>/` | `manifest.json` (`{id,name,version,minAppVersion,description,author,authorUrl,isDesktopOnly}`), `main.js`, `styles.css`, `data.json` |
| other `<plugin-id>.json` | core plugin settings, following the `<id>.json` pattern (`backlink.json`, `note-composer.json`, `page-preview.json`, …) |

---

## 6. workspace.json

Written by `Workspace.saveLayout()` (debounced 1s), pretty-printed JSON:

```jsonc
{
  "main":  { /* root split */ },
  "left":  { /* left sidebar */ },
  "right": { /* right sidebar */ },
  "left-ribbon": { "hiddenItems": { "<pluginId>:<Title>": false } }, // display order = key order
  "floating": { "type": "floating", "children": [ /* popout windows */ ] }, // only when a popout exists
  "active": "<leaf id>",
  "lastOpenFiles": ["path1", "..."]
}
```

Nodes (all carry a random hex `id`, plus an optional `dimension` = flex-grow %):
- **split**: `{id, type:"split", direction:"vertical"|"horizontal", children:[...]}`. The root is forced to `vertical`;
  sidebars are `horizontal` and additionally carry `width` (px) and `collapsed: true`.
- **tabs**: `{id, type:"tabs", children:[leaf...], currentTab?: n (omitted when 0), stacked?: true}`.
- **leaf**: `{id, type:"leaf", state:{type:"<viewType>", state:{file, mode:"source"|"preview", source:bool, ...}, pinned?, icon, title}, group?, pinned?}`
  where `icon`/`title` are stored so a deferred view can draw its tab header without instantiating the view. Leaf history
  (back/forward) is serialized too, for undo-close.
- **window** (inside floating): `{id, type:"window", children, x, y, width, height, maximize, zoom}`.

Deserialize rules: a bare leaf sitting directly under a split → wrapped in `tabs` automatically; empty containers are pruned; an
unknown view type → a "plugin missing" placeholder; a missing `main` → a fresh tabs+empty leaf, reopening `lastOpenFiles[0]`.

Example of a live search view state: `{"type":"search","state":{"query":"...","matchingCase":false,"explainSearch":false,"collapseAll":false,"extraContext":false,"sortOrder":"alphabeticalReverse"}}`.

---

## 7. Markdown dialect

The reading-view/metadata parser is a **remark** fork with `{breaks: true, commonmark: true}`, so
**a single line break renders as `<br>`**. The same parser code is duplicated inside `worker.js`.
The editor uses the **HyperMD** stream mode (CM5-style) adapted onto CM6, with the options:
`{front_matter, math, table, toc, hashtag, fencedCodeBlockHighlighting, highlightFormatting, taskLists,
strikethrough, highlight, headers, blockquotes, indentedCode, lists, hr, blockId: true; emoji: false}`.

### Wikilink & embed

- Inline regex (takes priority over `link`): locator `/!?\[\[/g`, match **`/^(!?)\[\[(.+?)]]/`**.
  The contents are `.trim()`ed; **rejected if they contain a nested `[[`**. `!` → embed (`<span class="internal-embed" src alt>`),
  otherwise → `<a class="internal-link" href data-href>`.
- Alias split: the alias is whatever follows the **first** `|` (at index > 0), trimmed; the href is everything before that `|`, with a trailing `\` stripped, then
  `href.replace(/ /g," ").trim().normalize("NFC")`.
- **Default display text** (no alias): `href.split("#").filter(Boolean).join(" > ")`, so
  `[[Note#Head]]` displays as `Note > Head`. A link with an alias also gets `aria-label` = that default display text.
- Subpath: split at the first `#` → `{path, subpath}`. `#^` = block, `#[^` = footnote, anything else is a heading;
  a multi-level heading `#H1#H2` is resolved step by step.
- **Image size param**: the last `|` segment of the alt matching `/^\s*([0-9]+)\s*(?:x\s*([0-9]+)\s*)?$/` becomes the
  `width` (and `height`) attribute and is dropped from the alt. Applies to `![[img|300]]`, `![[img|300x200]]`, `![alt|300](url)`.
- Embeddable extensions: image/audio/video/pdf (the table in §3) plus `md`, `canvas`, `base`. PDF supports `#page=N`
  (`&selection=...`, `&annotation=ID`).
- A markdown link `[]()` pointing inside the vault → converted into the same ilink/iembed node (decodeURI + NFC).
- Characters **forbidden in link text**: `#^[]|`; forbidden in filenames: (Windows) `*"\/<>:|?`, (elsewhere) `\/:`.

### Block ID `^id`

- Inline: `/^\^([a-zA-Z0-9\-]+)$/` (must be preceded by whitespace, and must end the run).
- End of paragraph: `/^\^([a-zA-Z0-9\-]+)(?=$|\n$|\n\n)/`, so an id on a line of its own attaches to the **preceding** block.
- **The charset is only `[a-zA-Z0-9-]`.** The cache key is lowercased.
- **Auto-generated**: 6 random hex characters, inserting `#^<id>` into the link and ` ^<id>` at the end of the line.

### Tag

- Regex reading/metadata: **`/^#[^ -⁯⸀-⹿'!"#$%&()*+,.:;<=>?@^`{|}~\[\]\\\s]+/`**
  (must be preceded by whitespace or the start of the text); **rejected if purely numeric** `/^#\d+$/`. Renders `<a class="tag" href="#tag">`.
- The editor adds the condition that it must contain at least 1 letter (`/[a-z]/i`).
- Allowed: letters, digits, `_`, `-`, `/` (nested `a/b`), emoji, non-ASCII.
- Frontmatter tags: key `/^tags$/i` (migrates `tag`), strings split on `/[ ,\n]/`, entries containing a space are dropped, the `#` is added automatically.

### Callout

- Regex (the first line of a blockquote, in both the editor and reading view): **`/^\[!([^\]]+)\]([+\-]?)(?:\s|$)/`**
  - Group 1 is split at the first `|`: before it is the type, after it is metadata (`data-callout-metadata`).
  - Type normalisation: `.trim().toLowerCase().replace(/\s+/g,"-")`.
  - Group 2: `+` is foldable and starts open, `-` starts folded, empty means not foldable.
- DOM: `div.callout[data-callout][data-callout-fold][data-callout-metadata]` →
  `div.callout-title` (`div.callout-icon` + `div.callout-title-inner`) + `div.callout-content`.
- Default title: the type with `-`→space and the first letter capitalised. The title is the rest of the first line.
- Custom colour: a `color` of the form `#rgb/#rrggbb` in the data → inline `--callout-color: "r,g,b"`.
- The full type table: §21.

### Frontmatter / Properties

- Block tokenizer `onlyAtStart`: the document must start with exactly `---\n`; the closing `---` must come after a `\n`;
  parsed with the yaml lib; kept only if the result is a plain object.
- Reserved keys (forced widgets): `aliases → aliases`, `cssclasses → multitext`, `tags → tags`.
  Migration (case-insensitive): `tag→tags`, `alias→aliases`, `cssclass→cssclasses`; strings split on `/[ ,\n]/`;
  a `cssclasses` entry containing a space is dropped.
- **Type inference**: `null→text`; a string matching `/^\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d$/`→`datetime`,
  `/^\d{4}-[01]\d-[0-3]\d$/`→`date`, anything else `text`; number→`number`; boolean→`checkbox`;
  array→`multitext`; anything else→`unknown`.
- Accepted datetime display formats: `YYYY-MM-DD[T]HH:mm:ss`, `YYYY-MM-DD[T]HH:mm`,
  `YYYY-MM-DD HH:mm:ss`, `YYYY-MM-DD HH:mm`.
- Types assigned by the user are stored in `.obsidian/types.json` (watched + hot reloaded).

### Other inline syntax

- **Highlight** `==...==`: opens with a `==` that is not followed by whitespace and is not part of `====`; closes at the next `==` → `<mark>`.
- **Strikethrough** `~~...~~` (GFM).
- **Comment** `%%...%%`: inline `/^%%(.+?)%%/`, which is **dropped from the output**; block-level `%%` fences by line.
- **Footnote**: a ref `[^id]` → `<sup class="footnote-ref" data-footnote-id="fnref-N">` (numbered in order,
  with `-k` for a repeated ref); definition `[^id]: ...` (continuation lines indented 4 spaces/a tab); **inline `^[note]`**
  (scans for `\\` escapes and counts nested `[`). Editor footref regex: `/^\[\^([^\]\s]*?)\](:?)/`.
- **Math**: character-by-character scanning (not a single regex): `\$` escapes; inline `$...$`, where the opener must not be
  followed by a space/tab and the closer must not follow a space/tab nor precede a digit; `$$...$$` for blocks. Rendered with **MathJax** (lazy).
- **Code fence**: ``` or `~~~`; info-string `/^\s*(~~~+|```+)[ \t]*([\w\/+#-]*)[^\n`]*$/`;
  renders `<pre><code class="language-X">` + **Prism** (lazy). Indented code is supported.
- **Mermaid**: a fence whose language is exactly `"mermaid"` → lazy load, rendered into `div.mermaid`; a label containing
  an internal link is post-processed into `a.internal-link`.
- **HTML**: allowed, but **every section goes through DOMPurify** with the config:
  `{ALLOW_UNKNOWN_PROTOCOLS:true, RETURN_DOM_FRAGMENT:true, FORBID_TAGS:["style"], ADD_TAGS:["iframe"],
  ADD_ATTR:["frameborder","allowfullscreen","allow","sandbox","data-tooltip-position"]}`.
  Hooks: every `<a>` → `target="_blank" rel="noopener nofollow"`; every `<iframe>` is forced to
  `sandbox="allow-forms allow-modals allow-presentation allow-same-origin allow-scripts"`.
- **External link**: `class="external-link" target="_blank" rel="noopener nofollow"`.

### Task list

- A list item starting with `[c]` where `c` is **any single character**: `checked = c !== " "`; the DOM is
  `li.task-list-item[data-task="c"]` (+ `.is-checked`) containing `input.task-list-item-checkbox`.
- **There is no hard-coded list of custom states.** The `/ - > < ? !...` states are a theme convention
  (core CSS only styles `data-task="x"|"X"`). Clicking the checkbox toggles `" "` ↔ `"x"`;
  Mod+L cycles through them using the regex `/\[.\]/`.

---

## 8. Link resolution & MetadataCache

### `getFirstLinkpathDest(linkpath, sourcePath)`: the rules, step by step

1. An empty linkpath plus a sourcePath ⇒ the source file itself (self-link `[[#heading]]`).
2. Lowercase the linkpath; take the basename; if it contains a `.` → look it up in `uniqueFileLookup` (multi-map key =
   **the lowercased filename including its extension**). A miss → try `linkpath + ".md"`. Still a miss ⇒ unresolved.
3. A linkpath with no folder plus exactly 1 candidate ⇒ done (the happy shortest-path case).
4. A `./` / `../` prefix: resolved against `dirname(sourcePath)`, accepting only an exact path match.
5. A `/` prefix ⇒ vault-absolute: only an exact full-path match counts.
6. Otherwise: a full-path match wins; failing that, collect every candidate whose lowercased path **ends with**
   the linkpath, split them into 2 groups (candidates in the same folder as the source come first), **sort each group by ascending path length**, then concatenate.

- **Everything is case-insensitive**; ties break as "same folder first, then the shortest path".
- Unresolved keys are normalised by stripping a trailing `.md`.
- `fileToLinktext` follows `newLinkFormat`: absolute = the full path (minus `.md`); relative = a `../` path from the source folder;
  shortest = the basename, but if resolving that basename back does not land on the intended target → it falls back to the full path.
- A heading inserted into a link is sanitized: `heading.replace(/([:#|^\\\r\n]|%%|\[\[|]])/g," ").replace(/\s+/g," ").trim()`.

### CachedMetadata structure (worker.js)

Positions everywhere are `{line: 0-based, col: 0-based, offset: 0-based}`; `position = {start, end}`.

```js
{
  frontmatter?: object,
  frontmatterPosition?: Pos,
  frontmatterLinks?: [{key:"prop"|"prop.0", link, original, displayText}],
  links?:    [{position, link, original, displayText}],
  embeds?:   [{position, link, original, displayText}],
  tags?:     [{position, tag /* includes the # */}],
  headings?: [{position, heading /* raw text */, level}],
  footnotes?: [{position, id}], footnoteRefs?: [{position, id}],
  referenceLinks?: [{position, id, link}],
  sections?: [{type /* paragraph|heading|list|code|blockquote|callout|yaml|... */, position, id? /* block id */}],
  listItems?: [{position, parent /* 1-based line of the parent item; negative = root list */, task? /* the [c] character */, id?}],
  blocks?:   { [idLowercase]: {position, id} }
}
```
Empty arrays are removed.

`resolveSubpath(cache, subpath)`: splits on `#` and drops the empties. `^id` ⇒ block (the id is matched case-insensitively,
searching listItems as well); `[^id]` ⇒ footnote; anything else walks the headings in order, comparing through
`h.replace(/[!"#$%&()*+,.:;<=>?@^`{|}~\/\[\]\\\r\n]/g," ").replace(/\s+/g," ").trim()` lowercase,
each following heading must be deeper than the one before it; returns `{type:"heading", current, next, start, end}`.

---

## 9. Editor

### Stack

- **CodeMirror 6** bundled inside app.js (`@codemirror/state|view|language|commands|search|autocomplete|collab|lint`,
  `@lezer/*`), with a module map exposed to plugins.
- Markdown in the editor is **not** Lezer-markdown but the **HyperMD stream mode** adapted onto CM6.
- Root editor: class `markdown-source-view cm-s-obsidian mod-cm6`, plus `is-live-preview` when LP is on.

### Live Preview: how it works

- A single CM6 StateField/decoration set walks the tokens of the visible lines. The syntax-revealing predicate:
  **if any selection range touches a token's range → show the raw source**; otherwise the formatting characters are
  hidden with `Decoration.replace`, links become `Decoration.mark({class:"cm-underline"})`, and embeds/images/math/
  code blocks/HRs/callouts/tables become block or inline **widgets**. Widgets are recycled by `sourcePath`+`href`.
- The inline nodes treated as "formatting context that has to be revealed":
  `["em","strong","inline-code","strikethrough","highlight","link","image","hmd-internal-link","hmd-embed","formatting-link","footref"]`.
- Toggles: `editor:toggle-source` (LP ↔ raw source inside the edit view); `markdown:toggle-preview` Mod+E
  (edit ↔ reading). Per-leaf view state: `state.mode` (`source`/`preview`) + `state.source` (bool: LP or raw).
- **Vim**: a complete codemirror-vim port is bundled (`.cm-vimMode`, fat cursor, the `:` command panel).

### Suggesters

| Trigger | Condition | Behaviour |
|---|---|---|
| `[[` link | `lastIndexOf("[[") > lastIndexOf("]")` over the line text up to the cursor | the query is whatever follows `[[`; a `#` → heading mode, `#^` → block mode; ending in `\|` → display-text mode; by default a fuzzy match over every linkable file plus frontmatter aliases (aliases carry the `lucide-forward` icon). `![[` behaves the same and adds the `!` itself |
| `#` tag | `/(^|\s)#[^...tag charset...]*$/g` and the character after the cursor is not `#` | suggests existing tags, Tab completes |
| `[^` footnote | `/(?:^|[^\[])(\[\^)([^\]]*)$/` (skipped if it is a definition) | |
| `/` slash | `/(^|\s)\/([^\s\/]*)$/` (the `slash-command` plugin, off by default) | runs a command |
| Property | inside the Properties UI | fuzzy match on property names (with a type icon); values follow the widget |

### Fuzzy search (`prepareQuery` / `fuzzySearch`): the exact algorithm

- `prepareQuery`: lowercase; `tokens` = split on whitespace, with every punctuation character
  (`/[ -⁯⸀-⹿\\'!"#$%&()*+,\-.\/:;<=>?@\[\]^_`{|}~]/`) and every CJK character
  (`/[ༀ-࿿぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/`) counting as its own token;
  `fuzzy` = each individual non-space character.
- `fuzzySearch`: (1) try the **token pass**: each token is `indexOf`-ed in order, starting from the end of the previous match; a match
  that starts mid-word (not on a word boundary or a camelCase hump) → bumps the penalty counter; (2) on a miss → the **per-char
  fuzzy pass**: every character must appear in order, and a mid-word match only counts when it is adjacent to the previous match.
- **Score** (0 is perfect, the more negative the worse):
  ```
  score = 0 − max(0, numRanges − 1)            // fragmentation
            − midWordPenalties / 10
            − (matchSpan − queryLen) / 100      // how scattered the match is in the span
            − firstMatchOffset / 1000           // an earlier match is better
            − targetLen / 10000                 // a shorter target wins
  ```
- `prepareSimpleSearch`: splits on spaces, every word has to appear (as a substring), the same scoring formula, no boundary penalty.
- Filename search: tries the basename first; a match on the full path only → **score −1**.

---

## 10. Reading view

- Renders **each top-level mdast node as its own section** (an HTML string; headings carry `depth` so they can fold).
  A section stores `{html, pos, level}`.
- Each section: `el.appendChild(DOMPurify.sanitize(html, config §7))` plus an `el-<tagName>` class on the wrapper.
- **Virtualized**: sections are measured; sections under a folded heading are hidden; only sections near the
  viewport are attached; rendering runs through a queue and **recycles** (reusing an `.internal-embed.is-loaded` whose src/width/height/alt match).
- **Post-processor pipeline**: `registerPostProcessor(fn, sortOrder)`, sorted ascending by `sortOrder||0`,
  running `fn(sectionEl, context)` (which may return a Promise). Built-ins (order 0, in registration order): the
  internal-link resolver, tag links, embeds, checkbox wiring, callout icon/fold wiring, RTL/scroll table wrapping,
  image handling, the code copy button, Prism, mermaid, the `query` block, and footnote backrefs.
- **Internal link**: an anchor carrying `data-href` and the class `internal-link` (+ `is-unresolved` via
  `metadataCache.isUnresolved`). Click: `openLinkText(href, sourcePath, Keymap.isModEvent(e))`, where
  Mod = new tab, Mod+Alt = split, Mod+Alt+Shift = new window. `mouseover` → triggers
  `hover-link` (page preview).
- **Heading**: carries `data-heading` = the raw source text. Subpath navigation uses `resolveSubpath` + scroll
  (it does not use the URL fragment).
- **Embed**: finds `.internal-embed:not(.is-loaded)` and loads it with depth tracking through a WeakMap.
  **Nesting is capped at depth ≤ 5**; past that it renders a fallback link. A markdown embed re-enters the renderer itself.

---

## 11. Global Search

### Architecture

- **There is no inverted index.** Search is a **linear scan** over `vault.getFiles()` (an async, cancellable queue),
  skipping Excluded files; it only `cachedRead`s `md`/`canvas` files when the query needs the content. It runs on the **main thread**
  (worker.js is only the metadata parser). Tag/heading/listItem/frontmatter offsets come from the metadata cache.
- `.canvas` files: the query runs over the text of every `type:"text"` node (result key `canvas-<nodeId>`) plus the filename;
  the canvas plugin keeps a per-node metadata cache, which is why `tag:`/`task:` work inside a card.

### Tokenizer

Tokens: `quote` (`"..."` with `\"` escapes), `regex` (`/.../` with `\/` escapes), `not` (`-`), `bracket` `[` `]`,
`parenthesis` `(` `)`, `colon` `:`, `greaterthan` `>`, `lessthan` `<`, and bare text split on spaces.
A bare word spelled exactly `OR`, `TRUE`, `FALSE`, or `EMPTY` becomes a token of its own.

### Grammar

```
query      := andGroup (OR andGroup)*       // AND (space) binds tighter than OR
andGroup   := primary+
primary    := operator ":" primary          // file:foo
            | "[" query (":" query)? "]"    // [name] or [name:value]
            | "-" primary                   // negation
            | ">" primary | "<" primary     // comparison (inside [prop:>x])
            | "(" query ")"
            | TRUE | FALSE | EMPTY
            | text | "phrase" | /regex/
```
- An unknown operator before `:` → the error `Operator "x" not recognized`.
- "Exclusive" operators cannot be nested inside one another (e.g. `line:(file:x)` is an error), except `section:`, which can nest inside itself.
  `match-case:`/`ignore-case:` nest freely. `[prop]` does not nest inside `[...]`.

### Match semantics

- **Bare text**: substring (regex-escaped), flags `gmi` (case-insensitive) / `gm` (sensitive).
  Default keys: `filename` (md/canvas/base) + `content` (md).
- **"Phrase"**: on `content` it uses word boundaries at both ends (when the first/last character is a word character); on
  `filename`/`filepath` it is a plain substring; on a propertyName it is a case-insensitive equality comparison.
- **Regex**: compiled as written, dropping zero-length matches.
- A match comes back as an `[start,end]` offset pair, merged and sorted per key.

### The complete operator table

| Operator | Behaviour |
|---|---|
| `match-case:X` / `ignore-case:X` | forces the case sensitivity of the sub-expression |
| `path:X` | matches the full path (exclusive) |
| `file:X` | matches the filename (exclusive) |
| `content:X` | the body only (exclusive) |
| `line:X` | the sub-query must match within **1 line** |
| `block:X` | within 1 block (sections + listItems from the cache) |
| `section:X` | within 1 section (between headings); can nest inside itself |
| `task:X` | within a task item; `task:""` = every task |
| `task-todo:X` | task status `" "` |
| `task-done:X` | task status ≠ `" "` (**every non-space character counts as done**) |
| `tag:X` | tags from the cache + frontmatter; the `#` is added automatically; matches `^tag($|/)` case-insensitively (`tag:#a` matches `#a/b`) |
| `[name]` | has a property whose name matches |
| `[name:value]` | the name AND the value must match (for an array: any element); the value supports TRUE/FALSE/EMPTY/quote/regex/`>`/`<` |

### View state, sort, context

- Sort (shared with the file explorer): `alphabetical`, `alphabeticalReverse`, `byModifiedTime`,
  `byModifiedTimeReverse`, `byCreatedTime`, `byCreatedTimeReverse`. **There is no relevance sort.**
- **Default context**: the match is expanded out to the line boundaries, up to **100 characters** on each side (truncation → `…`);
  overlapping matches inside that window are merged into a single result row.
- **Extra context**: a match inside a list item → the whole item subtree; inside a section → the whole section; otherwise
  up to 1000 characters on each side, stopped by a blank line or a heading.
- Highlighting uses a `search-result-file-matched-text` span; the query history lives in localStorage `recent-searches`.

---

## 12. Quick Switcher

Settings `switcher.json`: `{showExistingOnly:false, showAttachments:true, showAllFileTypes:false}`.
Limited to **20** suggestions; `Shift+Enter` creates a note; `Tab` autocompletes the path.

Suggestion sources:
1. An empty query → recent files (not scored).
2. **Files**: the match target is `the path minus .md`; it tries the **basename first**, and on failure the full path with **score −1**.
3. Frontmatter **aliases** (always on) → `{type:"alias", alias, file}`.
4. **Unresolved links** (unless `showExistingOnly`) → choosing one creates the note.
5. **Bookmarks** (if enabled): matches `groupPath + title`; non-file bookmarks show up too.
6. **Headings are NOT in the switcher.**
7. Files matching Excluded files → **score −10** plus the class `mod-downranked`.
8. Sorted by descending score; at **≥ 10000 files** it switches from fuzzy to simple word search.

---

## 13. Graph view

### Engine

- **Render**: PixiJS onto a `<canvas>`; the colours are read out of the CSS with a probe div
  (`graph-view color-fill`, `color-fill-focused`, `color-fill-tag`, `color-fill-unresolved`,
  `color-fill-attachment`, `color-arrow`, `color-circle`, `color-line`, `color-text`,
  `color-fill-highlight`, `color-line-highlight`) reading the computed `color`+`opacity`.
- **Physics**: the `sim.js` worker, a **d3-force** fork (forceX/Y + forceLink + forceManyBody + forceCollide,
  Barnes-Hut quadtree) with a **WASM fast path** and a JS fallback.

### sim.js protocol & constants

Incoming message: `{nodes: {id: [x,y]|null}, links: [[src,dst],...], forceNode: {id,x,y}|null (pinned while dragging),
forces: {centerStrength, linkStrength, linkDistance, repelStrength}, alpha, alphaTarget, run}`.

Defaults: `alpha=1`, `alphaDecay = 1 − 0.001^(1/300)` (~300 ticks), `alphaMin=0.001` (below that it stops),
`centerStrength=0.1`, `linkStrength=1`, `linkDistance=250`, `repel=-1000`, **`velocityDecay=0.6`**, ~60fps.

Forces: `forceX(0)`+`forceY(0)` with strength = centerStrength (**not** d3's forceCenter);
`forceLink.distance(linkDistance)`, strength = linkStrength × the d3 default (`1/min(degree(src),degree(dst))`);
`forceManyBody.strength(repel).distanceMin(30)`, where the app sends `repel = −(slider³)`;
`forceCollide(radius=60, strength=0.5)`. New data reheats with `alpha: 0.3`.
Output: transferable Float32 positions on every tick.

### graph.json: the complete schema

```jsonc
{
  "collapse-filter": false,        // the Filters section is folded (generated as "collapse-"+sectionId:
  "search": "",                    //   filter|color-groups|display|forces)
  "showTags": false,               // default false
  "showAttachments": false,        // default false
  "hideUnresolved": false,         // default false
  "showOrphans": true,             // default true
  "collapse-color-groups": false,
  "colorGroups": [ { "query": "...", "color": { "a": 1, "rgb": 16711680 } } ],
  "collapse-display": false,
  "showArrow": false,
  "textFadeMultiplier": 0,         // slider -3..3 in steps of 0.1
  "nodeSizeMultiplier": 1,         // slider 0.1..5
  "lineSizeMultiplier": 1,         // slider 0.1..5
  "collapse-forces": false,
  "centerStrength": 0.5187...,     // slider 0..1; default = inverse-curve(0.1) ≈ 0.5187
  "repelStrength": 10,             // slider 0..20; the worker receives -(v³)
  "linkStrength": 1,               // slider 0..1; the worker receives curve(v)
  "linkDistance": 250,             // slider 30..500, raw
  "scale": 0.0289,                 // the saved zoom level (clamped 1/128..8)
  "close": true                    // the controls panel is closed
}
```
**The slider curve**: the stored value is the slider position; the worker receives
`curve(v, 0.01) = (0.01^(1−v) − 0.01)/(1 − 0.01)` for centerStrength/linkStrength (exponential,
curve(0)=0, curve(1)=1); repel receives `−v³`.

### Building the graph, node sizes, colours

- A node is a cached file (plus tag nodes when `showTags`; attachments; unresolved links). Edges come from
  `metadataCache.resolvedLinks` (plus unresolved ones when they are shown). Excluded files are dropped.
- **Color groups**: evaluated **in array order, first match wins**.
- **Node colour precedence**: focused (hover/selected, when the CSS alpha>0) → group color → tag → unresolved →
  attachment → the default fill.
- **Node radius**: `nodeSizeMult × clamp(3·sqrt(weight+1), 8, 30)`, where `weight` = the number of outgoing+incoming links
  (global) or the BFS weight (local).
- **Text fade**: `textAlpha = clamp(log2(scale) + 1 − textFadeMultiplier, 0, 1)`; scale label = `sqrt(1/scale)`.
- **Zoom**: clamped to `[1/128, 8]`, exponential lerp at 0.85/frame.
- **Animate (timelapse)**: nodes are re-added in `min(ctime,mtime)` order.
- **Local graph** defaults: `{showAttachments:false, hideUnresolved:false, showOrphans:true, showTags:false,
  localJumps:1 (slider 1..5), localInterlinks:false, localForelinks:true, localBacklinks:true}`:
  a BFS out from the origin file, starting at weight 30 and decaying with each hop; stored in the view state, not in graph.json.

---

## 14. Canvas

### The `.canvas` format (JSON Canvas)

Top level: `{ "nodes": [...], "edges": [...] }`. Unknown keys survive the round-trip untouched (`unknownData`).

**Fields common to every node**: `{ "id": "<16 hex>", "x": int, "y": int, "width": int, "height": int, "color"?: string }`.
Coordinates and sizes are **rounded to int**; `color` is omitted when empty; its value is `"1"`..`"6"`
(1 red, 2 orange, 3 yellow, 4 green, 5 cyan, 6 purple, mapping onto CSS `--canvas-color-N`) **or** `"#RRGGBB"`
(a legacy `"r,g,b"` is converted to hex on load).

| type | extra fields |
|---|---|
| `"text"` | `"text": "<markdown>"` |
| `"file"` | `"file": "<vault path>", "subpath"?: "#Heading" \| "#^block"` (omitted when empty) |
| `"link"` | `"url": "https://..."` (rendered in a webview) |
| `"group"` | `"label"?: string, "background"?: "<vault image path>", "backgroundStyle"?: "ratio"\|"repeat"` (omitted for the `"cover"` default) |

**Edge**:
```json
{ "id": "<hex>", "fromNode": "<nodeId>", "fromSide": "top|right|bottom|left",
  "fromEnd": "none|arrow",   // omitted when "none" (the default)
  "toNode": "<nodeId>", "toSide": "top|right|bottom|left",
  "toEnd": "none|arrow",     // omitted when "arrow" (the default)
  "color"?: "1".."6"|"#hex", "label"?: "text" }
```
A missing side is computed from the relative positions of the two nodes.

### Behaviour

- Dragging a group drags the nodes inside it; group labels are searchable.
- A text node → "Convert to file" turns it into a `.md` file node.
- **The viewport (zoom/pan) is not in the file.** It is stored in localStorage `canvas-<filepath>`, per vault.
- Plugin settings in `.obsidian/canvas.json`: `{snapToObjects:true, snapToGrid:true}`.
- Text nodes are indexed for global search.

---

## 15. Bases

`.base` = **YAML**. An empty file → 1 `table` view named "Table". Unknown keys are kept in `unrecognizedData`.

```yaml
filters:            # global filter: a formula string OR {and:[...]}, {or:[...]}, {not:[...]} (recursive, exactly 1 key per object)
  and:
    - 'status != "done"'
    - or:
        - file.hasTag("project")
        - note.priority > 2
formulas:           # name -> formula string
  ppu: "(price / age).toFixed(2)"
properties:         # per-property configuration
  note.price:
    displayName: Price
newItemFolder: "x"
newItemTemplate: "t.md"
views:              # array; the first view is the default
  - type: table     # required; types: "table", "cards", "list" (plugins can add more)
    name: My view   # required, must not be empty
    filters: ...    # the same and/or/not shape, scoped to this view
    order: [file.name, note.price]        # column order (property ids)
    sort: [{property: note.price, direction: DESC}]   # ASC|DESC
    groupBy: {property: note.status, direction: ASC}
    summaries: {note.price: "Average"}
    limit: 10
```

**Property id namespaces**: a bare `name` → `note.name` (frontmatter); the `file.` prefix (file metadata:
name, path, size, mtime, tags…), `formula.` (defined in `formulas`), `note.` (frontmatter).
A filter string is a formula expression (`file.hasTag(...)`, comparison operators, `.toFixed()`…).
The currently active view is ephemeral (workspace state); it is not saved into the file.

---

## 16. Daily notes / Templates

**The template variable engine** (shared): substitutes `{{key}}` **case-insensitively**, then `{{date}}` / `{{time}}` /
`{{date:FORMAT}}` / `{{time:FORMAT}}` against a single `moment()` snapshot; defaults `date → "YYYY-MM-DD"`,
`time → "HH:mm"`, overridable through the options `{dateFormat, timeFormat}`.

- **Daily notes**: the name is `moment().format(format || "YYYY-MM-DD")`; the folder comes from the option, falling back to
  newFileLocation; the template is expanded with `{title: <the date string>}`. `openBehavior:"daily"` opens it at launch.
- **Templates**: pick a file under `folder`; provides `{{title}}` (the basename of the active file), `{{date}}`, `{{time}}`.
- **Note composer**: the merge/extract templates support `{{fromTitle}}`, `{{newTitle}}`, `{{content}}`
  (`\n\n{{content}}` is appended automatically when it is missing).
- **Unique note creator (zk-prefixer)**: the name is `moment().format(format || "YYYYMMDDHHmm")`; collision handling:
  if a file already starts with the generated string → add time in the smallest unit out of `m,h,d,w,M,y`
  that actually changes the formatted string, repeating until it is unique; opens with the cursor in rename mode.

---

## 17. File handling

- **Attachments**: `getAvailablePathForAttachments(name, ext, sourceFile)` follows `attachmentFolderPath`:
  `"."`/`"./"` → the note's parent folder; `"./sub"` → `<noteParent>/sub`; anything else is a literal path;
  the folder is created automatically (after a case-insensitive lookup first); the filename is sanitized and cut to 250 characters; a collision gets the suffix
  `name 1.ext`, `name 2.ext`… Used by paste/drop, the audio recorder, and URL downloads (extension from the content-type).
- **Rename + link update**: `renameFile` is wrapped in `runAsyncLinkUpdate`, which waits for the metadata cache to settle,
  **snapshots every resolved ref** (`iterateAllRefs`), performs the rename, then rewrites the wikilinks/mdlinks
  in the affected source files (regenerated through `fileToLinktext`, honouring `newLinkFormat`/`useMarkdownLinks`);
  heading/block renames go through the `renameSubpath` updater. `alwaysUpdateLinks:false` → the user is asked.
- **Delete**: confirmation follows `promptDelete` (the same dialog also handles `deleteUnlinkedAttachments`, deleting
  attachments that are referenced only by the note being deleted). The destination follows `trashOption`: `system` → the OS trash
  (falling back to local if that fails), `local` → `<vault>/.trash/` (with an anti-collision suffix), `none` → deleted outright.
- **File recovery**: IndexedDB **`<appId>-backup`** v1, store `backups` (autoIncrement,
  indexes `path`, `ts`), records `{path, ts, data}`. Triggered on vault `modify`, `file-open`, and `create`;
  a 60s resave timer, cleanup every hour (options: interval in minutes + retention in days). The UI diffs snapshots.
- **Watching from outside**: recursive `fs.watch` (plus a hidden watch on configDir); a change to `.obsidian/*.json` → hot-reload.

---

## 18. Per-device state

`loadLocalStorage(k)` = `JSON.parse(localStorage["<appId>-" + k])`, i.e. **per vault and per device**.

Per-vault keys (prefix `<appId>-`): `config` (the replacement configDir name), `note-fold-<path>` (fold state,
swept when the file is deleted), `tag-pane-fold`, `canvas-<path>` (the canvas viewport), `recent-searches`,
`recent-commands`, `page-preview-unfold-properties`, `last-plugin-update-check`,
`enable-plugin-<appId>` ("true" = restricted mode is off).

Global keys: `theme`, `local-themes`, `communityPluginSortOrder`, `communityThemeSortOrder`,
`most-recently-installed-version`, `spellcheck-languages`, `vim`, `mobile-selected-vault`,
`history-show-diff`, `MathJax-Menu-Settings`.

IndexedDB:
| DB | version | stores | used for |
|---|---|---|---|
| `<appId>-cache` | 19 | `file`, `metadata` | metadata index (§8) |
| `<appId>-backup` | 1 | `backups` | File Recovery |
| `<appId>-sync` | 1 | `data` | Sync (deleted after 30s if Sync is off) |
| `<appId>-webview` | 1 | `icons`, `history` | Web Viewer |

---

## 19. CSS theming

`app.css` is ~20,600 lines. **Layered architecture:**
1. `:root`: the heading weights only (so themes can override them): `--h1-weight:700`, h2..h6 600
   (variable fonts: 700/680/660/640/620/600).
2. **`body`**: the main token block (~840 lines), holding every component variable plus the "Color mappings" that map the
   semantic tokens onto the `--color-base-*` ramp.
3. `.theme-light` / `.theme-dark` (on `<body>`): the real palette definitions plus a few dark overrides.
4. `body` again: font stacks + `--font-text-size: 16px`.

> **The specificity lesson:** tokens are set on `body` (not `:root`), and the palette on
> `body.theme-light/.theme-dark`. Community themes and snippets rely on exactly this ordering.

### Accent system

```css
--accent-h: 258; --accent-s: 88%; --accent-l: 66%;  /* the default purple ≈ #8a5cf5 */
--color-accent: hsl(var(--accent-h), var(--accent-s), var(--accent-l));
/* light */ --color-accent-1: hsl(calc(h−1), calc(s*1.01), calc(l*1.075)); --color-accent-2: hsl(calc(h−3), calc(s*1.02), calc(l*1.15));
/* dark  */ --color-accent-1: hsl(calc(h−3), calc(s*1.02), calc(l*1.15));  --color-accent-2: hsl(calc(h−5), calc(s*1.05), calc(l*1.29));
--text-accent: var(--color-accent) /* dark: accent-1 */;
--interactive-accent: var(--color-accent-1) /* dark: accent */;
--interactive-accent-hover: var(--color-accent-2) /* dark: accent-1 */;
```

### Color ramp

| Var | Light | Dark |
|---|---|---|
| `--color-base-00` | `#ffffff` | `#1e1e1e` |
| `--color-base-05` | `#fcfcfc` | `#212121` |
| `--color-base-10` | `#fafafa` | `#242424` |
| `--color-base-20` | `#f6f6f6` | `#262626` |
| `--color-base-25` | `#e3e3e3` | `#2a2a2a` |
| `--color-base-30` | `#e0e0e0` | `#363636` |
| `--color-base-35` | `#d4d4d4` | `#3f3f3f` |
| `--color-base-40` | `#bdbdbd` | `#555555` |
| `--color-base-50` | `#ababab` | `#666666` |
| `--color-base-60` | `#707070` | `#999999` |
| `--color-base-70` | `#5c5c5c` | `#b3b3b3` |
| `--color-base-100` | `#222222` | `#dadada` |

`--mono-rgb-0`: `255,255,255` / `0,0,0`; `--mono-rgb-100`: `0,0,0` / `255,255,255`;
`--highlight-mix-blend-mode`: `darken` / `lighten`; `color-scheme` set to match.

### Extended colors

| Var | Light | Dark |
|---|---|---|
| `--color-red` | `#e93147` (233,49,71) | `#fb464c` (251,70,76) |
| `--color-orange` | `#ec7500` (236,117,0) | `#e9973f` (233,151,63) |
| `--color-yellow` | `#e0ac00` (224,172,0) | `#e0de71` (224,222,113) |
| `--color-green` | `#08b94e` (8,185,78) | `#44cf6e` (68,207,110) |
| `--color-cyan` | `#00bfbc` (0,191,188) | `#53dfdd` (83,223,221) |
| `--color-blue` | `#086ddd` (8,109,221) | `#027aff` (2,122,255) |
| `--color-purple` | `#7852ee` (120,82,238) | `#a882ff` (168,130,255) |
| `--color-pink` | `#d53984` (213,57,132) | `#fa99cd` (250,153,205) |

(each colour comes with a matching `-rgb` variable)

### The main semantic tokens

| Token | Definition | Light | Dark |
|---|---|---|---|
| `--background-primary` | base-00 | `#ffffff` | `#1e1e1e` |
| `--background-primary-alt` | base-10 | `#fafafa` | `#242424` |
| `--background-secondary` | base-20 | `#f6f6f6` | `#262626` |
| `--background-secondary-alt` | theme | base-05 `#fcfcfc` | base-30 `#363636` |
| `--background-modifier-hover` | `rgba(mono-100, .067)` | | |
| `--background-modifier-active-hover` | accent @10% | | |
| `--background-modifier-border` | base-30 | `#e0e0e0` | `#363636` |
| `--background-modifier-border-hover` | base-35 | `#d4d4d4` | `#3f3f3f` |
| `--background-modifier-border-focus` | base-40 | `#bdbdbd` | `#555555` |
| `--background-modifier-error` | red | | |
| `--background-modifier-success` | green | | |
| `--background-modifier-message` | `rgba(0,0,0,0.9)` | | |
| `--background-modifier-form-field` | base-00 | `#ffffff` | base-25 `#2a2a2a` |
| `--background-modifier-cover` | theme | `rgba(220,220,220,.4)` | `rgba(10,10,10,.4)` |
| `--text-normal` | base-100 | `#222222` | `#dadada` |
| `--text-muted` | base-70 | `#5c5c5c` | `#b3b3b3` |
| `--text-faint` | base-50 | `#ababab` | `#666666` |
| `--text-on-accent` | `white` | | |
| `--text-error/warning/success` | red/orange/green | | |
| `--text-selection` | accent @20% | | dark: accent @33% |
| `--text-highlight-bg` | `rgba(255,208,0,0.4)` | | |
| `--interactive-normal` | base-00 | `#ffffff` | base-30 `#363636` |
| `--interactive-hover` | base-10 | `#fafafa` | base-35 `#3f3f3f` |

### Typography

```css
--font-default: ui-sans-serif, -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI",
  "Google Sans Flex", Roboto, "Inter Variable", "Inter", "Apple Color Emoji",
  "Segoe UI Emoji", "Segoe UI Symbol", sans-serif;
--font-monospace-default: ui-monospace, SFMono-Regular, "Cascadia Mono", "Roboto Mono",
  "DejaVu Sans Mono", "Liberation Mono", Menlo, Monaco, "Consolas", "Source Code Pro", monospace;
--font-interface: var(--font-interface-override), var(--font-interface-theme), var(--default-font,'??'), var(--font-default);
--font-text: var(--font-text-override), var(--font-text-theme), var(--font-default);
--font-monospace: var(--font-monospace-override), var(--font-monospace-theme), var(--font-monospace-default);
--font-text-size: 16px;
```
`'??'` is a deliberately invalid font name used as a placeholder; the app overwrites the `-override`/`-theme` slots at runtime from the settings.

- Relative sizes: `--font-smallest: 0.8em; --font-smaller: 0.875em; --font-small: 0.933em`
- UI: `--font-ui-smaller: 12px; --font-ui-small: 13px; --font-ui-medium: 15px; --font-ui-large: 20px`
- Weight: `--font-thin:100` … `--font-black:900`; `--font-weight: var(--font-normal)`
- Line height: `--line-height-normal: 1.5; --line-height-tight: 1.3`

### Spacing / radius / z-index

- `--size-2-1: 2px; --size-2-2: 4px; --size-2-3: 6px`
- `--size-4-1: 4px; -2: 8px; -3: 12px; -4: 16px; -5: 20px; -6: 24px; -8: 32px; -9: 36px; -10: 40px; -12: 48px; -16: 64px; -18: 72px`
- `--radius-s: 4px; --radius-m: 8px; --radius-l: 12px; --radius-xl: 16px`
- `--border-width: 1px`
- Z: `--layer-cover:5; sidedock:10; status-bar:15; popover:30; slides:45; modal:50; notice:60; menu:65; tooltip:70; dragged-item:80`

### Shadow (light / dark)

```css
/* light */
--shadow-s: 0px 1px 2px rgba(0,0,0,.028), 0px 3.4px 6.7px rgba(0,0,0,.042), 0px 15px 30px rgba(0,0,0,.07);
--shadow-l: 0px 1.8px 7.3px rgba(0,0,0,.071), 0px 6.3px 24.7px rgba(0,0,0,.112), 0px 15px 30px rgba(0,0,0,.1);
/* dark */
--shadow-s: 0px 1px 2px rgba(0,0,0,.121), 0px 3.4px 6.7px rgba(0,0,0,.179), 0px 15px 30px rgba(0,0,0,.3);
--shadow-l: 0px 1.8px 7.3px rgba(0,0,0,.071), 0px 6.3px 24.7px rgba(0,0,0,.112), 0px 30px 90px rgba(0,0,0,.2);
```

### Chrome metrics

- `--header-height: 40px` (view header, tab bar, titlebar offset)
- Ribbon: `--ribbon-width: 44px`, bg `--background-secondary`
- Tabs: `--tab-width: 200px; --tab-max-width: 320px; --tab-curve: 6px; --tab-radius-active: 6px 6px 0 0;
  --tab-font-size: var(--font-ui-small)`; text: faint → muted (active/focused) → normal (focused-active-current);
  stacked: `--tab-stacked-pane-width: 700px`
- Status bar: bg secondary, border `1px 0 0 1px`, radius `8px 0 0 0` (a pill floating in the bottom-right corner),
  font `--font-ui-smaller`, `position: fixed`
- Scrollbar: 12px, thumb `rgba(mono-100, .1)` (active .2), only when `body.styled-scrollbars`
- Divider splitter: `--divider-color: var(--background-modifier-border)`; hover →
  `--interactive-accent`, width 1px → 3px
- Icon: `--icon-xs:14px; s:16px; m/l:18px; xl:32px`; stroke 2/2/1.75/1.75/1.25; by default
  `--icon-color: var(--text-muted)`, opacity 0.85
- Input: `--input-height: 30px; --input-radius: 5px`; Toggle: 40×18px with a white thumb
- Modal: `--modal-radius: 12px`, dialog 560px (max 80vw), settings 90vw×85vh max 1100×1000
- Prompt (switcher/palette): width 700px, max 80vw/70vh, input 40px, `border-radius: var(--radius-l)`,
  `box-shadow: var(--shadow-l)`, top 80px
- Popover: 450×400px; Menu: bg `--background-secondary`, radius 8px, padding 6px
- Animation: `--anim-duration-superfast: 70ms; fast: 140ms; moderate: 300ms; slow: 560ms`

### Notable editor/markdown variables

- `--file-line-width: 700px` (readable line length); `--file-margins: 32px`
- Heading size: h1 `1.618em`, h2 `1.462em`, h3 `1.318em`, h4 `1.188em`, h5 `1.076em`, h6 `1em`;
  letter-spacing −0.015/−0.011/−0.008/−0.005/−0.002/0 em; inline-title alias h1
- `--p-spacing: 1rem` (source mode: 0); `--indent-size: 4` (also the `tab-size`)
- **Bold**: `b, strong { font-weight: calc(var(--font-weight) + var(--bold-modifier)) }` with
  `--bold-modifier: 200`
- Code: `--code-size: var(--font-smaller)`, bg `--background-primary-alt`; syntax colours:
  comment=faint, function=yellow, keyword=pink, string=green, operator/tag=red, property=cyan,
  value=purple, important=orange
- Blockquote: border-left 2px `--interactive-accent`, padding-left 24px
- Link: internal and external are both accent + underline; unresolved: opacity 0.7
- Tag pill: bg accent@10%, radius `2em`, padding `0.25em 0.65em`, size `--font-smaller`
- Embed: border-left `2px solid var(--interactive-accent)`, padding-left 24px, max-height 4000px
- Checkbox: size = `--font-text-size`, radius 4px, checked bg `--interactive-accent`;
  done: line-through + `--text-muted`
- Table: border 1px `--background-modifier-border`, header weight bold-modifier
- Nav (file explorer): item size `--font-ui-small`, padding `4px 8px 4px 24px`, radius 4px,
  selected bg accent@15%, children margin-left 12px + indent guide 1px
- Graph: `--graph-text: var(--text-normal); --graph-line: base-35; --graph-node: var(--text-muted);
  --graph-node-unresolved: var(--text-faint); --graph-node-focused: var(--text-accent);
  --graph-node-tag: var(--color-green); --graph-node-attachment: var(--color-yellow)`
- Canvas: `--canvas-background: var(--background-primary); --canvas-dot-pattern: base-30;
  --canvas-color-1..6` = red/orange/yellow/green/cyan/purple rgb

### Body feature classes

| Class | Effect |
|---|---|
| `.theme-light` / `.theme-dark` | swaps the palette |
| `.mod-macos/.mod-windows/.mod-linux` | OS-specific chrome |
| `.is-frameless` / `.is-hidden-frameless` | custom titlebar |
| `.is-focused` | the window is focused → focused titlebar/tab colours |
| `.is-fullscreen`, `.is-maximized`, `.is-popout-window`, `.is-translucent` | |
| `.is-grabbing` | a drag is in progress: forces the cursor, disables hover |
| `.is-mobile/.is-phone/.is-tablet/.is-ios` | mobile layout |
| `.show-ribbon` | **absent** → `--ribbon-width: 0` + the ribbon is hidden |
| `.show-inline-title` | absent → the inline title is hidden |
| `.show-view-header` | absent → `.view-header` is hidden entirely |
| `.styled-scrollbars` | enables the custom scrollbars |
| `.mod-rtl` | RTL |

Note: "Readable line length" is **not** a body class. It toggles `.is-readable-line-width` on
`.markdown-preview-view` / `.markdown-source-view.mod-cm6` (capping `--file-line-width: 700px`).

---

## 20. DOM classes

### Shell

```
body.theme-dark.mod-macos.is-frameless.is-focused.show-ribbon.show-inline-title…
├── .titlebar  (fixed top, app-region: drag)
│   └── .titlebar-inner > .titlebar-button-container.mod-left/.mod-right > .titlebar-button
├── .app-container  (flex column 100%)
│   ├── .horizontal-main-container  (flex row)
│   │   └── .workspace
│   │       ├── .workspace-ribbon.mod-left  (44px, flex column; .side-dock-actions > .side-dock-ribbon-action.clickable-icon)
│   │       ├── .workspace-split.mod-horizontal.mod-left-split
│   │       ├── .workspace-split.mod-vertical.mod-root  (bg --background-primary)
│   │       └── .workspace-split.mod-horizontal.mod-right-split
│   └── .status-bar  (fixed bottom-right) > .status-bar-item(.mod-clickable)
└── overlays, siblings of .app-container:
    .modal-container > .modal-bg + (.modal | .prompt)
    .suggestion-container, .popover.hover-popover, .menu, .tooltip, .notice-container, .drag-ghost
```

### Split / tabs / leaf

- `.workspace-split`: `.mod-vertical` (row, children `flex:1 0 0; width:0`), `.mod-horizontal` (column),
  `.mod-root/.mod-left-split/.mod-right-split` (sidebars are `flex:0 0 auto`, sized inline by JS).
  Children carry `.workspace-leaf-resize-handle` (a 3px strip, accent on hover, cursor col/row-resize).
- `.workspace-tabs` (.mod-top = touching the top of the window, .mod-active = the focused group, .mod-stacked)
  - `.workspace-tab-header-container` (height 40px) > `-inner` (drag region)
    - `.workspace-tab-header[data-type]`: `.is-active` gets the `--tab-background-active` background plus
      the **inverted rounded-corner effect** built from `::before/::after` (a `--tab-curve` circle + clip-path +
      a box-shadow fill; copy it verbatim to be pixel-perfect)
      - `.workspace-tab-header-inner` > `-icon` + `-title` + `-close-button`
    - controls: `.workspace-tab-header-new-tab`, `.workspace-tab-header-tab-list`
  - `.workspace-tab-container`
    - `.workspace-leaf` (`contain: strict`; `.mod-active`; `.is-highlighted::before` accent overlay 25%)
      - `.workspace-leaf-content[data-type][data-mode]`
        - `.view-header` (40px; hidden when body lacks `.show-view-header`) → `.view-header-nav-buttons`,
          `.view-header-title-container` (breadcrumb), `.view-actions > .view-action.clickable-icon`
        - `.view-content` (`height: calc(100% - var(--header-height))`)

Root split: leaf bg `--background-primary`; sidebar: bg `--background-secondary`, view-content padding `12px 12px 32px`.

### Markdown views

- **Edit**: `.markdown-source-view.mod-cm6` (+`.is-live-preview`, `.is-readable-line-width`, `.is-folding`)
  → CM6: `.cm-editor > .cm-scroller > .cm-sizer > .cm-contentContainer > .cm-content > .cm-line`;
  theme class `.cm-s-obsidian`.
  - Line classes: `HyperMD-header(-1..6)`, `HyperMD-list-line`, `HyperMD-quote`,
    `HyperMD-codeblock(-begin/-end/-bg)`, `HyperMD-task-line[data-task]`, `HyperMD-table-row`,
    `HyperMD-footnote`, `HyperMD-hr`
  - Span classes: `cm-header-1..6`, `cm-strong`, `cm-em`, `cm-highlight`, `cm-strikethrough`,
    `cm-inline-code`, `cm-hmd-internal-link`, `cm-link`, `cm-url`, `cm-hashtag(-begin/-end)`,
    `cm-formatting(-link/-list/-task/-quote/-header/-code)`, `cm-hmd-frontmatter`, `cm-hmd-footnote`,
    `cm-comment`, `cm-math`, `cm-footref`, `cm-blockquote-border`, `cm-embed-block`, `cm-callout`,
    `cm-table-widget`, `cm-fold-indicator`, `cm-indent`, `cm-active`
- **Reading**: `.markdown-reading-view > .markdown-preview-view.markdown-rendered`
  (padding 32px, scroll, `scrollbar-gutter: stable`) > `.markdown-preview-sizer.markdown-preview-section`
  (capped at 700px when readable) > `.markdown-preview-pusher` + one div per block.
- `.inline-title` (the document title above the content), `.internal-embed/.inline-embed/.image-embed/.markdown-embed`.

### Tree (shared by explorer/outline/bookmarks/search)

```
.tree-item (.nav-folder/.nav-file)
├── .tree-item-self (.nav-folder-title/.nav-file-title)
│     [.is-clickable .mod-collapsible .is-active .is-selected .has-focus .is-being-dragged
│      .is-being-dragged-over .is-being-renamed .is-cut .has-active-menu]
│   ├── .tree-item-icon.collapse-icon  (absolute, margin-inline-start −20px)
│   ├── .tree-item-inner (-text/-subtext)
│   ├── .nav-file-tag  (extension badge: 9px uppercase, letter-spacing .05em)
│   └── .tree-item-flair-outer > .tree-item-flair  (the count)
└── .tree-item-children  (margin-left 12px + indent guide border-left)
```
Header pane: `.nav-header > .nav-buttons-container > .clickable-icon.nav-action-button(.is-active)`;
container `.nav-files-container`.

### Modal / prompt / suggestion / menu / tooltip

- `.modal-container(.mod-dim)` → `.modal-bg` + `.modal` (radius 12px, border 1px, padding 16px)
  → `.modal-close-button`, `.modal-header > .modal-title`, `.modal-content`, `.modal-button-container`.
- `.prompt` → `.prompt-input-container > input.prompt-input`, `.prompt-results` (containing `.suggestion-item`),
  `.prompt-instructions > .prompt-instruction > .prompt-instruction-command`.
- `.suggestion-container`/`.popover`: bg primary, border 1px, shadow-s, radius 8px; inside it
  `.suggestion > .suggestion-item` (padding 6px 12px; `.is-selected` bg hover; `.mod-complex` →
  `.suggestion-content > .suggestion-title (.suggestion-highlight=bold) + .suggestion-note`,
  `.suggestion-icon`, `.suggestion-aux > .suggestion-hotkey/.suggestion-flair`); `.suggestion-empty`.
- `.menu` (fixed, bg secondary, radius 8px) > `.menu-scroll` > `.menu-item` (`.selected`, `.is-disabled`,
  `.is-warning`, `.is-label`; `.menu-item-icon` + `.menu-item-title`; `.mod-submenu`); `.menu-separator`.
- `.tooltip` (fixed, bg `rgba(0,0,0,.9)`, **hardcoded color #FAFAFA**, radius 4px, max-width 300px,
  pop-down animation 200ms).

---

## 21. Callouts

The colour slot is an **RGB triplet** (not a colour) so that both `rgba(var(--callout-color), 0.1)` (the background)
and `rgb(var(--callout-color))` (title/icon) work. Box: bg `rgba(color, 0.1)`, border
`var(--callout-border-width)=0px solid rgba(color, 0.25)`, radius 4px, padding `12px 12px 12px 24px`,
margin `1em 0`, `mix-blend-mode: var(--highlight-mix-blend-mode)`.

| `data-callout` | Slot | Light RGB | Dark RGB | Icon |
|---|---|---|---|---|
| (default / `note` / unrecognised) | `--callout-default` (blue) | 8,109,221 | 2,122,255 | `lucide-pencil` |
| `abstract`, `summary`, `tldr` | `--callout-summary` (cyan) | 0,191,188 | 83,223,221 | `lucide-clipboard-list` |
| `info` | `--callout-info` (blue) | 8,109,221 | 2,122,255 | `lucide-info` |
| `todo` | `--callout-todo` (blue) | 8,109,221 | 2,122,255 | `lucide-check-circle-2` |
| `important` | `--callout-important` (cyan) | 0,191,188 | 83,223,221 | `lucide-flame` |
| `tip`, `hint` | `--callout-tip` (cyan) | 0,191,188 | 83,223,221 | `lucide-flame` |
| `success`, `check`, `done` | `--callout-success` (green) | 8,185,78 | 68,207,110 | `lucide-check` |
| `question`, `help`, `faq` | `--callout-question` (orange) | 236,117,0 | 233,151,63 | `help-circle` |
| `warning`, `caution`, `attention` | `--callout-warning` (orange) | 236,117,0 | 233,151,63 | `lucide-alert-triangle` |
| `failure`, `fail`, `missing` | `--callout-fail` (red) | 233,49,71 | 251,70,76 | `lucide-x` |
| `danger`, `error` | `--callout-error` (red) | 233,49,71 | 251,70,76 | `lucide-zap` |
| `bug` | `--callout-bug` (red) | 233,49,71 | 251,70,76 | `lucide-bug` |
| `example` | `--callout-example` (purple) | 120,82,238 | 168,130,255 | `lucide-list` |
| `quote`, `cite` | `--callout-quote` | 158,158,158 (both themes) | none | `quote-glyph` |

---

## 22. Checklist clone

When cloning a feature, check it against these easy-to-get-wrong points:

1. **Markdown**: use the exact regexes from §7 (especially the tag charset, callouts, and the block id `[a-zA-Z0-9-]`);
   remember `breaks: true` (a single newline = `<br>`); the default display text `Note > Head`; the image size param.
2. **Link resolution**: the 6 steps in §8, case-insensitive throughout, tie-broken by "same folder, then shortest path".
3. **Search**: the grammar + the operator table in §11; context of 100 characters stopped at the line boundary; 6 sort modes
   (no relevance); exclusive operators do not nest.
4. **Fuzzy**: port the scoring formula in §9 verbatim so switcher ranking matches exactly; penalty −1 path-only,
   −10 excluded.
5. **Graph**: d3-force with forceX/Y (not forceCenter), `velocityDecay 0.6`, repel `−slider³`
   `distanceMin 30`, collide(60, 0.5), reheat alpha 0.3, radius `clamp(3√(w+1), 8, 30)`,
   text fade `clamp(log2(scale)+1−fade, 0, 1)`, slider curve `(0.01^(1−v) − 0.01)/0.99`.
6. **Canvas**: round x/y/w/h to int; obey the rules for omitting default fields (`fromEnd:"none"`, `toEnd:"arrow"`,
   `backgroundStyle:"cover"`); keep unknown keys through the round-trip, which is what byte-identical output requires.
7. **Settings**: write only the keys that differ from the default; split app/appearance by the correct whitelist; hot-reload when
   `.obsidian/*.json` is changed from outside.
8. **CSS**: tokens on `body`, palette on `.theme-light/.theme-dark`; bold = font-weight + 200;
   callout color = RGB triplet; the active tab uses the inverted-corner trick; the tooltip text colour is hardcoded.
9. **Embed depth ≤ 5**; all HTML is rendered through DOMPurify with the config from §7.
10. **Task**: every non-space character = done; do not hard-code a list of states.
