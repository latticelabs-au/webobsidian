// Package entry.
//
// The import order below is load-bearing and must not be reordered or merged:
// ESM evaluates dependencies depth-first in source order, so `./shim.js` (and
// therefore the `navigator` shim) is fully evaluated before `./bundle/engine.js`
// or any of engine.js's own external imports. commonlib reads `navigator` at
// module top level; get this backwards and importing this package throws on
// Node 20.
//
// Related: package.json deliberately has NO "sideEffects" field. The default
// (assume side effects) is what keeps this side-effect-only import alive when a
// downstream bundler flattens the package, and desktop/scripts/build.mjs does
// exactly that. Adding "sideEffects": false here would let the shim be
// tree-shaken and break the desktop build at runtime, not at build time.
import "./shim.js";

export * from "./bundle/engine.js";
