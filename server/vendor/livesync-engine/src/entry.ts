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
