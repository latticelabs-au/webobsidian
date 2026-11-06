# Changelog

All notable changes to WebObsidian are documented here. This project tracks its product
design and version history in [PRD.md](PRD.md); the entries below summarize user-facing
changes. The format is loosely based on [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

### Added
- Open-source repository scaffolding: `README.md` (with logo), `LICENSE` (MIT),
  `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, GitHub issue/PR templates and a
  CI workflow (typecheck, build, Docker image).
- File tree **Copy / Cut / Paste** for files and folders (session-local clipboard;
  `POST /api/files/copy` for recursive copy). *(PRD 0.9)*

### Changed
- ⋯ **More options** menu rebuilt for parity with Obsidian Desktop: backlinks-in-document,
  open linked view, open in new window, add file property, in-note Find, export to PDF,
  reveal file in navigation, and per-file version history. *(PRD 0.8)*
- **Desktop app now needs macOS 12 (Monterey) or later.** It ships Electron 43, and Electron
  38 dropped macOS 11. Windows (10 and later) and the Linux targets are unchanged, ia32
  included.
- **Desktop vault picker opens in Downloads.** Electron 43 starts file dialogs in the Downloads
  folder (or the home folder) when no folder is given, and the OS no longer reopens the last
  one used. This affects the first-run picker and **Switch Vault…**; cancelling still falls
  back to `~/Documents/WebObsidianVault`.
- **Linux desktop packages: the executable is now `webobsidiandesktop`** (it was
  `@webobsidiandesktop`, derived from the npm package name). electron-builder 26 refuses to
  build an AppImage whose executable name contains `@`. The `.desktop` entry, the icon name and
  the `/usr/bin` command the deb installs follow it; the deb package name (`webobsidian`) and
  the app data folder do not depend on it and are unchanged.
- **Building the desktop app: `npm install` no longer downloads Electron.** Since Electron 42
  the binary is downloaded the first time `electron` runs (`npm run desktop`), which needs
  network access once. Packaging with electron-builder is unaffected.
- **Git sync no longer passes ambient git environment variables to git.** simple-git 4 removes
  `GIT_*` plus `EDITOR`, `VISUAL`, `PAGER`, `PREFIX` and `SSH_ASKPASS` from the environment of
  every git process it starts. WebObsidian sets none of them (remote auth uses the token in the
  remote URL), but a deployment that relied on one, such as `GIT_SSH_COMMAND`, loses it.
- **Node 22.12 or later is required to develop and build** (the desktop workspace's Electron
  toolchain declares it), and CI plus the release workflow now run on Node 22, like the Docker
  image. Changing `package-lock.json` needs npm 11.6 or later (see CONTRIBUTING.md).
- CI packages the desktop app on macOS, Windows and Ubuntu for every pull request, with
  publishing disabled, so the release targets are exercised before a tag is pushed.

### Fixed
- A non-numeric or non-finite `git.intervalSec` or `search.fuzzy` in `settings.json` (for
  example `1e999`, which JSON reads as Infinity) now heals to its default (300 and 0.2) instead
  of failing the whole file, which made the server rewrite `settings.json` from defaults: new
  `jwtSecret`, password hashes cleared (default password active again), API keys and git token
  dropped. The settings API refuses such a value with a 400.

### Security
- Dependency upgrades clear every critical and high `npm audit` advisory, including the
  majors simple-git 4, zod 4, Electron 43 and electron-builder 26, plus vitest 4.1 and vite 6
  for development. The remaining moderate and low advisories each need a breaking major or a
  non-semver override.

## Highlights by PRD revision

- **0.9**: File tree Copy/Cut/Paste; recursive copy endpoint.
- **0.8**: ⋯ menu parity with Obsidian Desktop; per-file Git version history (FR-4).
- **0.7**: Per-note **Share dialog** (create/copy/toggle/password/delete) + globe badge.
- **0.6**: Deploy hardening for self-hosting: all deploy params via `.env`, watcher polling
  fallback on inotify limits, longer healthcheck `start_period` (FR-9).
- **0.5**: Graph node search with smooth fly-to and highlighting (FR-2).
- **0.4**: Mobile / responsive UI: drawer sidebars, edge-swipe, on-keyboard formatting
  toolbar, touch targets, safe-area insets (FR-11).
- **0.3**: Per-pane ⋯ menu (split, bookmark, rename/move, etc.) and a redesigned right
  sidebar tab strip (Backlinks incl. unlinked mentions · Outgoing links · Tags · Outline).
- **0.2**: Deep-link URLs (`/note/...`), public read-only share links with central
  management, server-side rendering for SEO (FR-10).

## Core (v1 baseline)

- Obsidian-compatible vault (works on existing `.obsidian/` vaults).
- CodeMirror 6 editor with live/source/reading views; wikilinks, embeds, tags, callouts,
  tasks, KaTeX, Mermaid; backlinks, outline, graph view.
- QMD full-text + fielded search (MiniSearch), incremental indexing, disk persistence.
- GitHub sync (pull/commit/push) with Git LFS.
- Single master password login (scrypt + JWT cookie).
- Scoped Agent API at `/api/v1` with hashed API keys and rate limiting.
- Community-plugin loader against an Obsidian-API shim (subset).
- Pure-JSON config (`data/settings.json`); one-command Docker stack.

---

> Note: WebObsidian is pre-1.0 and has not cut tagged releases yet. Once releases begin,
> each version will get its own dated section here.
