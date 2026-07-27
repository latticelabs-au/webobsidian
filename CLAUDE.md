# CLAUDE.md: working guide for Claude Code on the WebObsidian project

## Context
WebObsidian is a self-hosted web app that is a full clone of Obsidian. The official design lives in
[PRD.md](PRD.md). Development progress is tracked in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

## Mandatory rules (read before every working session)

1. **Always stay aligned with PRD.md.** Before coding a feature, check it against the matching
   FR/NFR/API/data model section in the PRD. Do not change the architecture or the scope on your
   own. If you decide you need to deviate from the PRD, **update PRD.md first** (state the reason,
   bump the version/changelog), and only then write code.

2. **Always update IMPLEMENTATION_PLAN.md.** Whenever you start or finish an item:
   - Flip the checkbox: `[ ]` → `[~]` (in progress) → `[x]` (done).
   - Update the "Last updated" line and add a line to the "Progress log" (date + summary).
   - Only mark an item `[x]` when the code actually runs / has been verified, not when you have
     merely finished writing it.

3. **Keep in sync with the session todo list.** The internal todos must reflect the items in the plan.

4. **The docs are the source of truth.** When the scope changes as requested by the user: update
   PRD.md (design) and IMPLEMENTATION_PLAN.md (add/edit items) in the same change.

## Technical conventions
- Language: TypeScript for both server and web. Avoid `any` where possible.
- Runtime config: JSON files only (`data/settings.json`); do not add a DB engine.
- Security: never log secrets/tokens/API keys; hash before storing; guard against path traversal.
- Git commit/push **only when the user asks for it**.

## Useful commands
```bash
npm install            # install deps across the whole workspace
npm run dev            # run server + web (dev)
npm run build          # build web, then server
npm run start          # run production (server serves the built web)
npm run typecheck      # type-check both workspaces
docker compose up      # run the full stack
```

## Structure (see PRD §2.2)
- `server/`: Express API (routes, services, middleware, plugins shim).
- `web/`: React SPA (components, lib, styles).
- `data/`: runtime config & index (gitignored).
- `docs/`: additional documentation.
