/**
 * Bundle entry for the vendored livesync-commonlib engine.
 *
 * This file is the ONLY hand-written TypeScript in this package. Everything under
 * `upstream/src` is an unmodified copy of vrtmrz/livesync-commonlib at the pinned
 * commit recorded in package.json; the adaptation to Node lives here, in shim.js,
 * and in build.mjs.
 *
 * The surface is deliberately curated rather than a blanket `export *`:
 * commonlib's barrel modules (`mods.ts`, `index.ts`) reach into browser-only and
 * Deno-only platform code, and pulling them in would drag IndexedDB adapters,
 * Svelte views and `Deno.*` calls into a Node bundle. What is exported here is
 * exactly the CouchDB "direct manipulation" path the bridge uses, plus the
 * logging and path helpers a caller needs in order to drive it.
 */

// --- The engine itself -------------------------------------------------------
export { DirectFileManipulator } from "../upstream/src/API/DirectFileManipulatorV2.ts";
export type {
    DirectFileManipulatorOptions,
    EnumerateConditions,
    FileInfo,
    MetaEntry,
    ReadyEntry,
} from "../upstream/src/API/DirectFileManipulatorV2.ts";

// --- Logging -----------------------------------------------------------------
// commonlib logs through octagonal-wheels' global Logger. A daemon has to be able
// to install its own sink (`defaultLoggerEnv.logger = ...`), otherwise every
// PUT/GET/WATCH line is silently dropped and a wedged sync looks identical to an
// idle one. Re-exported so callers do not need a direct octagonal-wheels dep.
export { defaultLoggerEnv, Logger } from "../upstream/src/common/logger.ts";
export {
    LOG_LEVEL_DEBUG,
    LOG_LEVEL_INFO,
    LOG_LEVEL_NOTICE,
    LOG_LEVEL_URGENT,
    LOG_LEVEL_VERBOSE,
} from "../upstream/src/common/types.ts";
export type { LOG_LEVEL } from "../upstream/src/common/types.ts";

// --- Path / id mapping -------------------------------------------------------
// `path2id_base` and `id2path_base` already handle the leading-underscore case;
// callers must NOT add a second rule on top (it double-mangles `_attachments`).
export {
    addPrefix,
    getPath,
    getPathWithoutPrefix,
    id2path_base,
    isAccepted,
    isAcceptedAll,
    isPlainText,
    path2id_base,
    shouldBeIgnored,
    shouldSplitAsPlainText,
    stripAllPrefixes,
    stripPrefix,
} from "../upstream/src/string_and_binary/path.ts";

// --- Blob / content helpers --------------------------------------------------
export { createBlob, createTextBlob, determineTypeFromBlob } from "../upstream/src/common/utils.ts";
export { uint8ArrayToHexString } from "../upstream/src/string_and_binary/convert.ts";

// --- Core document types -----------------------------------------------------
export type {
    DocumentID,
    EntryDoc,
    EntryHasPath,
    FilePath,
    FilePathWithPrefix,
    LoadedEntry,
    NewEntry,
    PlainEntry,
    RemoteDBSettings,
} from "../upstream/src/common/types.ts";

// --- The remote-compatibility handshake --------------------------------------
//
// The milestone document (`_local/obsydian_livesync_milestone`) is how every
// LiveSync client announces its chunk-format range and its tweak values to the
// rest of the cluster, and how the cluster announces back that it has been
// locked or cleaned. `DirectFileManipulator` never touches it: grep the whole of
// `DirectFileManipulatorV2.ts` for "milestone" or "ensure" and there are no hits,
// because the direct-manipulation API was written for a client joining a database
// some Obsidian plugin had already initialised.
//
// A WebObsidian server is explicitly allowed to be the FIRST client against an
// empty database, which is the case that API never had to handle, so the
// handshake has to be driven from our side. It is exported here rather than
// reimplemented because a hand-rolled milestone that disagreed with the engine's
// own format would be a worse bug than the one it fixed: the document's shape is
// a wire contract with every Obsidian client on the cluster.
//
// NOTE that `currentVersionRange` (the `{min, max, current}` this call needs) is
// a module-local const in `upstream/src/replication/couchdb/LiveSyncReplicator.ts`
// and is NOT exported, so it cannot be re-exported here. Its value is copied into
// `server/src/services/livesync/peer-couchdb.ts` with a comment marking it as a
// wire constant, and a test asserts the copy still matches the upstream source.
export { ensureRemoteIsCompatible } from "../upstream/src/pouchdb/LiveSyncDBFunctions.ts";
export type { ENSURE_DB_RESULT } from "../upstream/src/pouchdb/LiveSyncDBFunctions.ts";
export { DEVICE_ID_PREFERRED, MILESTONE_DOCID } from "../upstream/src/common/types.ts";
export type { ChunkVersionRange, EntryMilestoneInfo, TweakValues } from "../upstream/src/common/types.ts";

// The three templates and the two object helpers that `ensureRemoteIsCompatible`
// itself uses to reach its MISMATCHED verdict.
//
// Exported so the caller can ask WHICH keys mismatched, which the verdict does
// not say. That question has to be answered, because the template is scoped to
// the Obsidian plugin and contains keys this server has no option for and cannot
// make agree; treating those as fatal would refuse a cluster we can sync with.
// Re-deriving the key set by hand would be the drift-prone way to do it: a key
// added to the template upstream would silently stop being checked. Using the
// engine's own templates and comparison means the answer moves with the engine.
export {
    TweakValuesDefault,
    TweakValuesShouldMatchedTemplate,
    TweakValuesTemplate,
} from "../upstream/src/common/types.ts";
export { extractObject, isObjectDifferent } from "../upstream/src/common/utils.ts";
