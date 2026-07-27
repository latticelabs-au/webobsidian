// Bundles the vendored livesync-commonlib source into one Node-consumable ESM
// file at `bundle/engine.js`.
//
// The output is COMMITTED. Nothing in the deploy path rebuilds it: the Dockerfile
// runtime stage runs `npm install --omit=dev` (which does not run this package's
// build script), and `desktop/scripts/build.mjs` re-bundles the already-compiled
// `server/dist/index.js`. Re-run `npm run build:engine` from the repo root after
// touching `upstream/src`, `src/entry.ts` or this file, and commit the result.
//
// Why a prebuilt bundle rather than compiling the sources in with the server:
//   - `server/tsconfig.json` sets rootDir "src" and outDir "dist", so vendored TS
//     outside src/ cannot be part of that program.
//   - the Dockerfile ships only `server/dist` and `server/public`.
//   - the desktop build bundles `server/dist/index.js`, so a relative `../vendor/`
//     import from dist/ would not survive. A real node_modules package does.
//
// FOUR upstream properties this build has to work around; all four are load
// bearing, and three of them fail in ways that are not obvious at build time.

import { build } from "esbuild";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8"));
const outfile = path.join(here, "bundle", "engine.js");

// (1) MODULE SPECIFIERS.
// upstream mixes `.ts`-suffixed relative imports (233 of them) with extensionless
// ones (120), *within the same directories*, e.g. `pouchdb/encryption.ts` imports
// "../common/logger" on one line and "../string_and_binary/path.ts" on another.
// Deno resolves this via `unstable: ["sloppy-imports"]`; neither Node ESM nor tsc
// resolves the union of both spellings. So: `resolveExtensions` handles the
// extensionless half, and the plugin below strips a trailing `.ts` so the other
// half falls through to the same resolver.
//
// (2) bgWorker MUST be aliased to bgWorker.mock.
// The real `worker/bgWorker.ts` imports the Vite-only specifier
// "./bg.worker.ts?worker" and spawns Workers at import time; neither works in Node.
// The mock implements the same algorithms with bit-identical output, losing only
// parallelism. upstream imports it under BOTH spellings:
//     ".ts":          pouchdb/encryption.ts:17, ContentSplitter/ContentSplitterV2.ts:3,
//                     ContentSplitter/ContentSplitterRabinKarp.ts:3
//     extensionless:  encryption/encryptHKDF.ts:1, ContentSplitter/ContentSplitterV1.ts:3
// Aliasing only one spelling yields TWO module instances of the worker facade, one
// of which is the real (exploding) one. Note this is not just about chunking: the
// encryption path imports it unconditionally, so it is on the critical path for
// any E2EE write.
const BG_WORKER = /(^|\/)bgWorker(\.ts)?$/;

const importFixPlugin = {
    name: "livesync-import-fix",
    setup(b) {
        b.onResolve({ filter: /^\.\.?\// }, async (args) => {
            // build.resolve() re-enters onResolve; the marker breaks the loop.
            if (args.pluginData?.livesyncResolved) return null;

            let spec = args.path;
            let rewritten = false;

            if (BG_WORKER.test(spec)) {
                spec = spec.replace(BG_WORKER, "$1bgWorker.mock.ts");
                rewritten = true;
            }
            if (spec.endsWith(".ts")) {
                // Drop the extension and let resolveExtensions re-add it, so both
                // spellings converge on one canonical path (and one module instance).
                spec = spec.slice(0, -3);
                rewritten = true;
            }
            if (!rewritten) return null;

            return await b.resolve(spec, {
                kind: args.kind,
                importer: args.importer,
                resolveDir: args.resolveDir,
                pluginData: { livesyncResolved: true },
            });
        });
    },
};

// Runtime deps stay external and are declared in package.json, so npm manages
// their versions and security updates rather than freezing them into the bundle.
// Wildcards are required: esbuild's `external` matches whole specifiers, so
// "octagonal-wheels" alone would not cover "octagonal-wheels/common/logger".
// Anything NOT listed here fails the build loudly, which is the point: a bare
// specifier we did not plan for should never be silently externalised into a
// runtime MODULE_NOT_FOUND.
const external = Object.keys(pkg.dependencies).flatMap((d) => [d, `${d}/*`]);

rmSync(path.join(here, "bundle"), { recursive: true, force: true });
mkdirSync(path.join(here, "bundle"), { recursive: true });

const result = await build({
    entryPoints: [path.join(here, "src", "entry.ts")],
    outfile,
    // Pin the working directory. esbuild embeds cwd-relative module paths in the
    // output (one `// <path>` comment per bundled module) and in the metafile, so
    // without this the bundle's BYTES depend on where you invoked the script:
    // `npm run build:engine` from the repo root produced a different file than
    // `node build.mjs` from here (159533 vs 158243 bytes). That would make the
    // committed artifact spuriously dirty depending on who built it.
    absWorkingDir: here,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    external,
    // (1), continued.
    resolveExtensions: [".ts", ".js"],
    plugins: [importFixPlugin],
    metafile: true,
    legalComments: "inline",
    // Pinned explicitly instead of letting esbuild discover a tsconfig, so the
    // output does not change based on what happens to sit above this directory.
    //   useDefineForClassFields: true  matches upstream's own build
    //     (lib/apps/webpeer/tsconfig.app.json) and Deno's default at this target.
    //     It changes class-field semantics, so it is not a free choice.
    //   verbatimModuleSyntax is deliberately LEFT OFF: turning it on keeps
    //     type-only imports alive, which drags ~240KB of i18n JSON
    //     (common/messagesJson/*) into the bundle via common/types.ts ->
    //     rosetta.ts.
    tsconfigRaw: {
        compilerOptions: {
            target: "es2022",
            useDefineForClassFields: true,
            verbatimModuleSyntax: false,
        },
    },
    banner: {
        js:
            `// livesync-engine, bundled from vrtmrz/livesync-commonlib @ ${pkg.vendored.shortCommit}\n` +
            `// ${pkg.vendored.upstream}\n` +
            `// ${pkg.vendored.license}, ${pkg.vendored.copyright}\n` +
            `// GENERATED FILE. Do not edit; run \`npm run build:engine\` at the repo root.\n`,
    },
    logLevel: "info",
});

// --- Post-build assertions ---------------------------------------------------
// A green esbuild run does not prove the two silent failure modes above were
// actually avoided, so check the metafile and the output directly.
const inputs = Object.keys(result.metafile.inputs).map((p) => p.replace(/\\/g, "/"));
const problems = [];

// (2) The real worker must be absent and the mock present. If the alias missed a
// spelling, the real bgWorker.ts (and its bg.worker.ts?worker import) shows up here.
const realWorker = inputs.filter((p) => /\/worker\/bgWorker\.ts$/.test(p));
const mockWorker = inputs.filter((p) => /\/worker\/bgWorker\.mock\.ts$/.test(p));
if (realWorker.length) problems.push(`real bgWorker.ts was bundled: ${realWorker.join(", ")}`);
if (mockWorker.length !== 1) problems.push(`expected exactly 1 bgWorker.mock.ts, got ${mockWorker.length}`);

// The Vite-only worker specifier must never reach the output.
const out = readFileSync(outfile, "utf8");
if (out.includes("?worker")) problems.push('output contains a Vite "?worker" specifier');

// The i18n payload must not have been dragged in (see verbatimModuleSyntax note).
const i18n = inputs.filter((p) => /messagesJson|messagesYAML/.test(p));
if (i18n.length) problems.push(`i18n message files were bundled: ${i18n.join(", ")}`);

// No local PouchDB adapter: the CouchDB path uses pouchdb-http (adapter-http only).
// A leveldb/memory/indexeddb adapter appearing here means something pulled in the
// browser bundle, `pouchdb/pouchdb-browser.ts`.
const browserPouch = inputs.filter((p) => /pouchdb-browser\.ts$/.test(p));
if (browserPouch.length) problems.push(`browser PouchDB bundle was pulled in: ${browserPouch.join(", ")}`);

// Deno-only platform code must not be reachable from a Node bundle.
if (/\bDeno\./.test(out)) problems.push("output references Deno.*");

// Nothing from node_modules may be inlined. Every third-party package must stay
// external AND be declared in `dependencies`. Without this, a future upstream
// change that reaches for a package we did not list would be silently inlined
// (because it happens to be installed as someone else's transitive dep) instead
// of failing here.
const inlined = inputs.filter((p) => p.includes("node_modules"));
if (inlined.length) problems.push(`node_modules code was inlined: ${inlined.join(", ")}`);

if (problems.length) {
    console.error("\n[livesync-engine] BUILD ASSERTIONS FAILED:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
}

// Committed alongside the bundle so a reviewer can see exactly which upstream
// modules and which npm packages the opaque bundle is made of, without rebuilding.
writeFileSync(
    path.join(here, "bundle", "meta.json"),
    JSON.stringify(
        {
            commit: pkg.vendored.commit,
            bytes: out.length,
            moduleCount: inputs.length,
            modules: inputs.sort(),
            externals: [
                ...new Set(
                    Object.values(result.metafile.inputs)
                        .flatMap((v) => v.imports.map((i) => i.path))
                        .filter((p) => p && !p.startsWith(".") && !inputs.includes(p.replace(/\\/g, "/"))),
                ),
            ].sort(),
        },
        null,
        2,
    ),
);

console.log(
    `[livesync-engine] ok: ${inputs.length} modules, ${(out.length / 1024).toFixed(0)}KB, ` +
        `commonlib @ ${pkg.vendored.shortCommit}`,
);
