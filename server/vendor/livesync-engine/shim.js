// Global shims that livesync-commonlib requires but Node does not provide.
//
// This module MUST be fully evaluated before any of the engine bundle (or any of
// its npm dependencies) is evaluated. That ordering is what `index.js` buys us:
// ESM evaluates a module's dependencies depth-first in source order, so
// `import "./shim.js"` on the first line of index.js runs to completion before
// `./bundle/engine.js` and its own import subgraph are touched. A build-time
// `banner` would NOT be sufficient here, because ESM hoists a bundle's remaining
// external `import` statements above any prepended text.
//
// Why each of these is needed (all read at MODULE TOP LEVEL, i.e. before any
// caller gets a chance to configure anything):
//
//   navigator.language
//     `string_and_binary/chunks.ts` builds `new Intl.Segmenter(navigator.language,
//     ...)` at module scope. Without `navigator` the import itself throws.
//
//   "navigator" in globalThis
//     `managers/LiveSyncManagers.ts` hard-throws unless navigator exists.
//
//   navigator.onLine
//     `managers/NetworkManager.ts` reads it to decide whether the network is up.
//     Node has no equivalent signal, so we report `true` and let the real request
//     fail and surface a proper error, rather than short-circuiting on a guess.
//
//   navigator.hardwareConcurrency
//     Only read by the real `worker/bgWorker.ts`, which the build aliases away to
//     `bgWorker.mock.ts`. Provided anyway so the shim stays valid if that alias is
//     ever dropped.
//
// Node added a built-in `navigator` in 21.2. This repo's `engines` field says
// >=20 and CI runs Node 20, so the shim is mandatory. `??=` means we defer to the
// real one on newer Node instead of shadowing it.

if (!("navigator" in globalThis)) {
    Object.defineProperty(globalThis, "navigator", {
        value: Object.freeze({
            language: "en",
            languages: Object.freeze(["en"]),
            hardwareConcurrency: 4,
            onLine: true,
            userAgent: `Node.js/${process.versions.node}`,
        }),
        configurable: true,
        writable: true,
        enumerable: false,
    });
}

// Node's built-in navigator (21.2+) is a getter-only object with no `onLine`.
// NetworkManager reads it unconditionally, so fill the gap without replacing the
// platform object.
if (typeof globalThis.navigator === "object" && globalThis.navigator !== null) {
    if (!("onLine" in globalThis.navigator)) {
        try {
            Object.defineProperty(globalThis.navigator, "onLine", {
                value: true,
                configurable: true,
                enumerable: false,
            });
        } catch {
            // Frozen/exotic navigator: nothing safe to do. NetworkManager will read
            // `undefined`, which is falsy, so a caller would see "offline". Surface
            // that loudly rather than silently mis-reporting connectivity.
            console.warn(
                "[livesync-engine] could not install navigator.onLine; " +
                    "NetworkManager may report the process as offline.",
            );
        }
    }
}
