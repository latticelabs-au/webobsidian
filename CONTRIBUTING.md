# Contributing to WebObsidian

Thanks for your interest in improving WebObsidian! This project is self-hosted, single-user,
and design-driven: please read the few rules below before opening a PR.

## Ground rules (from [CLAUDE.md](CLAUDE.md))

1. **[PRD.md](PRD.md) is the source of truth for design.** Before building a feature, check
   the matching FR/NFR/API/data-model section. If your change shifts scope or architecture,
   **update PRD.md first** (state the reason, bump the version/changelog), then write code.
2. **Keep [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) in sync.** Flip checkboxes
   (`[ ]` → `[~]` → `[x]`), update the "last updated" line, and add a progress-log entry.
   Only mark `[x]` when the code actually runs / is verified.
3. **Docs are the source of truth.** When scope changes, update PRD.md *and*
   IMPLEMENTATION_PLAN.md in the same change.

## Technical conventions

- **TypeScript** for both server and web. Avoid `any` where possible.
- **Runtime config is JSON only** (`data/settings.json`): do not add a DB engine.
- **Security:** never log secrets/tokens/API keys; hash before storing; guard against path
  traversal.
- Match the style, naming, and comment density of the surrounding code.

## Development setup

Requires **Node ≥ 22.12** and `git` (+ `git-lfs` if you use LFS). `npm install` at the root
also installs the desktop workspace's Electron toolchain, which declares Node 22.12 or later.

```bash
npm install
npm run dev          # server :8787 + web dev server :5173 (proxied)
```

Before opening a PR:

```bash
npm run typecheck    # must pass, CI runs this
npm run build        # must succeed, CI runs this
```

## Changing dependencies

Use **npm 11.6 or later** to change `package-lock.json`. npm 10 (the version Node 22 ships)
and every npm before 11.6.0 crash with `Cannot read properties of null (reading 'edgesOut')`
whenever they have to resolve vitest 4.1's peer dependencies: a bare `npm update`, installing
or upgrading `vitest` / `@vitest/coverage-v8`, or regenerating the lockfile from scratch. vitest
4.1.12 cannot be avoided: it is the first release clear of the critical advisories on vitest 3.x
and 4.0.x. npm 10 still installs the committed lockfile (`npm ci`, `npm install`) and handles
small edits such as adding an unrelated package, which is why CI and the Docker image keep the
npm their Node version ships.

You do not need to change your global npm:

```bash
npx -y npm@11 install --package-lock-only -w server -D vitest@^4.1.12   # or: npx -y npm@11 update --package-lock-only
npm install    # then install with your usual npm
```

npm 10 marks the `@esbuild/*` platform entries `"peer": true` and npm 11 does not; both install
the same tree. The committed lockfile uses the npm 10 form, so run that final `npm install` with
the npm 10 that Node 22 ships before committing, and a plain `npm install` on Node 22 stays a
no-op. `devEngines` in the root `package.json` records the npm requirement with
`"onFail": "ignore"`: `"warn"` would print on every install in CI and in the Docker build, where
npm 10 is fine.

## Pull requests

1. Fork and create a topic branch off `main`.
2. Make your change; keep commits focused and the diff minimal.
3. Ensure `npm run typecheck` and `npm run build` pass.
4. Update PRD.md / IMPLEMENTATION_PLAN.md if your change touches design or scope.
5. Open the PR using the template; describe the *what* and the *why*.

## Reporting bugs & requesting features

Use the GitHub issue templates. For security issues, **do not** open a public issue:
see [SECURITY.md](SECURITY.md).

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
