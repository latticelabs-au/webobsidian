/**
 * HAND-MAINTAINED DECLARATIONS.
 *
 * These are NOT generated from `upstream/src`. Generating real `.d.ts` from the
 * vendored source is not currently practical: upstream mixes `.ts`-suffixed and
 * extensionless relative imports within the same directories (233 vs 120), which
 * `tsc` cannot resolve under any single `moduleResolution` setting. That mixture
 * is precisely why this package is built with esbuild and a resolver plugin
 * rather than compiled with `tsc`.
 *
 * Consequence: THESE TYPES CAN DRIFT FROM THE BUNDLE. They are checked by review,
 * not by the compiler. When bumping the pinned commit in package.json, re-read
 * `upstream/src/API/DirectFileManipulatorV2.ts` and reconcile this file by hand.
 *
 * Scope: only the surface `src/entry.ts` actually exports. Members present on the
 * upstream class but deliberately omitted here (the `$$`/`$every`/`$all`
 * `LiveSyncLocalDBEnv` hooks, `enumerate`, `_enumerate`) are internal plumbing;
 * `$$createPouchDBInstance` is declared because callers must override it (see
 * below), and `liveSyncLocalDB` is declared with exactly one member on it,
 * because the class exposes `rawGet` and no raw WRITE (see its own note).
 *
 * Source of truth: vrtmrz/livesync-commonlib @ 8ed9bcd,
 * src/API/DirectFileManipulatorV2.ts and src/pouchdb/LiveSyncDBFunctions.ts
 */

// DELIBERATELY NO `/// <reference types="pouchdb" />`.
//
// It is tempting, because the real signatures use PouchDB's global namespace.
// But `server/tsconfig.json` sets `"types": ["node"]` and `"lib": ["ES2022"]`,
// and a triple-slash reference bypasses that allowlist: it pulls @types/pouchdb
// and its DOM lib into the consumer's program, at which point @types/node's
// `Buffer<ArrayBufferLike>` stops being assignable to the DOM's
// `ArrayBufferView<ArrayBuffer>` and pre-existing, unrelated server code
// (services/auth.ts, services/vault.ts) fails to compile. Measured: adding the
// reference took `npm run typecheck` from 0 errors to 4.
//
// So the PouchDB surface is described structurally below instead. A consumer
// that wants the real types can depend on @types/pouchdb itself and cast.

// --- Minimal structural PouchDB surface --------------------------------------

/**
 * The underlying PouchDB handle. Structural on purpose (see above): this is
 * whatever `$$createPouchDBInstance` returns. Cast to `PouchDB.Database<T>` if
 * you have @types/pouchdb in scope.
 */
export interface PouchDatabaseHandle<T extends object = object> {
    readonly __pouchDatabase?: T;
    [key: string]: unknown;
}

/** Configuration accepted by the PouchDB constructor. */
export interface PouchDatabaseConfiguration {
    adapter?: string;
    auth?: { username?: string; password?: string };
    fetch?: (url: unknown, opts?: unknown) => Promise<unknown>;
    [key: string]: unknown;
}

/** The live `changes` feed handle held by {@link DirectFileManipulator.changes}. */
export interface ChangesHandle {
    cancel(): void;
    on(event: string, listener: (...args: unknown[]) => void): ChangesHandle;
}

// --- Tagged primitive types --------------------------------------------------
// Upstream brands these via a `TaggedType` helper so a raw string cannot be
// passed where a path or id is expected. Reproduced structurally here.
declare const __tag: unique symbol;
type TaggedType<T, Tag extends string> = T & { [__tag]?: Tag };

export type FilePath = TaggedType<string, "FilePath">;
export type FilePathWithPrefixLC = TaggedType<string, "FilePathWithPrefixLC">;
export type FilePathWithPrefix = TaggedType<string, "FilePathWithPrefix"> | FilePath | FilePathWithPrefixLC;
export type DocumentID = TaggedType<string, "documentId">;

// --- Log levels --------------------------------------------------------------
export const LOG_LEVEL_DEBUG: -1;
export const LOG_LEVEL_VERBOSE: 1;
export const LOG_LEVEL_INFO: 10;
export const LOG_LEVEL_NOTICE: 100;
export const LOG_LEVEL_URGENT: 1000;
export type LOG_LEVEL =
    | typeof LOG_LEVEL_DEBUG
    | typeof LOG_LEVEL_VERBOSE
    | typeof LOG_LEVEL_INFO
    | typeof LOG_LEVEL_NOTICE
    | typeof LOG_LEVEL_URGENT;

/**
 * The global log sink. Assign `defaultLoggerEnv.logger` to route commonlib's
 * output somewhere; without that every PUT/GET/WATCH line is dropped, which makes
 * a wedged sync indistinguishable from an idle one.
 */
export const defaultLoggerEnv: {
    logger?: (message: unknown, level?: LOG_LEVEL, key?: string) => void;
};
export function Logger(message: unknown, level?: LOG_LEVEL, key?: string): void;

// --- Entry / document shapes -------------------------------------------------
export type EntryHasPath = { path: FilePathWithPrefix | FilePath };

export interface EntryBase {
    _id: DocumentID;
    _rev?: string;
    _deleted?: boolean;
    _conflicts?: string[];
    ctime: number;
    mtime: number;
    size: number;
    deleted?: boolean;
    path: FilePathWithPrefix;
    eden?: Record<string, unknown>;
}

/** A note stored as chunk references (`children`). */
export interface NewEntry extends EntryBase {
    type: "newnote";
    children: string[];
    datatype?: "newnote" | "plain";
}

/** A note stored as chunk references, plaintext variant. */
export interface PlainEntry extends EntryBase {
    type: "plain";
    children: string[];
    datatype?: "newnote" | "plain";
}

/** Any document the engine may hand back, including chunk leaves. */
export type EntryDoc = NewEntry | PlainEntry | ({ _id: DocumentID; type: string } & Record<string, unknown>);

/** A document whose content has been resolved from its chunks. */
export type ReadyEntry = (NewEntry | PlainEntry) & { data: string[] };
/** A document with only its chunk references resolved. */
export type MetaEntry = (NewEntry | PlainEntry) & { children: string[] };
export type LoadedEntry = ReadyEntry;

export type FileInfo = {
    ctime: number;
    mtime: number;
    size: number;
};

export type EnumerateConditions = {
    startKey?: string;
    endKey?: string;
    ids?: string[];
    metaOnly: boolean;
};

export type HashAlgorithm = "" | "xxhash32" | "xxhash64" | "mixed-purejs" | "sha1";

/*
 * The next two MUST stay byte-identical to the unions upstream derives from its
 * E2EEAlgorithms and ChunkAlgorithms constants (upstream/src/common/types.ts).
 * This file is hand-maintained, so nothing enforces that automatically, and both
 * of these had already drifted:
 *
 *   E2EEAlgorithm      declared "" | "v2" | "v3"   -- "v3" does not exist
 *                      upstream                    "" | "v2" | "forceV1"
 *   ChunkSplitterVersion declared number           -- it is a string union
 *
 * Neither drift produced a compile error, which is the whole problem. Both types
 * are used for the RemoteTweaks fields that mergeRemoteTweaks() ADOPTS from the
 * remote database and then hands to the engine, so a wrong declaration removes
 * type checking from exactly the values that decide how bytes are encrypted and
 * split. `number` in particular accepted anything at all while the engine was
 * comparing against strings.
 *
 * The guard is a type-level test (src/__tests__/vendor-types.test.ts) that
 * assigns every upstream constant to these unions and back, so a future drift
 * fails `npm run typecheck` in CI rather than silently at runtime.
 */
export type E2EEAlgorithm = "" | "v2" | "forceV1";
export type ChunkSplitterVersion = "" | "v1" | "v2" | "v2-segmenter" | "v3-rabin-karp";

/**
 * The full settings object the engine derives from
 * {@link DirectFileManipulatorOptions}. Upstream's `RemoteDBSettings` has ~150
 * fields (it is the plugin's entire settings surface); only the ones reachable
 * through this package's API are named. Indexed access covers the rest rather
 * than pretending this file enumerates them.
 */
export type RemoteDBSettings = {
    couchDB_URI: string;
    couchDB_DBNAME: string;
    couchDB_USER: string;
    couchDB_PASSWORD: string;
    encrypt: boolean;
    passphrase: string;
    useDynamicIterationCount: boolean;
    hashAlg: HashAlgorithm;
    minimumChunkSize: number;
    customChunkSize: number;
    enableCompression: boolean;
    handleFilenameCaseSensitive: boolean;
    E2EEAlgorithm: E2EEAlgorithm;
    [key: string]: unknown;
};

/**
 * The subset of the plugin's settings that is published in the milestone
 * document, i.e. what every client on the cluster tells every other client about
 * how it encodes documents.
 *
 * Upstream derives it as `typeof TweakValuesTemplate`, the union of
 * `TweakValuesRecommendedTemplate` and `TweakValuesShouldMatchedTemplate` (about
 * thirty keys off the plugin's ~150-field settings object). Only the fields this
 * server reads or writes are named; the index signature covers the rest rather
 * than pretending this file enumerates them.
 *
 * SECURITY NOTE, load-bearing: neither template contains `passphrase`,
 * `couchDB_PASSWORD` nor `couchDB_URI`, so the milestone this server writes
 * carries no credential. `encrypt` (a boolean) is published, exactly as every
 * Obsidian client publishes it. Anything added to this type must be checked
 * against that, because the document is world-readable to every client on the
 * cluster.
 */
export type TweakValues = {
    minimumChunkSize?: number;
    customChunkSize?: number;
    longLineThreshold?: number;
    encrypt?: boolean;
    usePathObfuscation?: boolean;
    enableCompression?: boolean;
    useEden?: boolean;
    maxAgeInEden?: number;
    maxTotalLengthInEden?: number;
    maxChunksInEden?: number;
    useDynamicIterationCount?: boolean;
    hashAlg?: HashAlgorithm;
    enableChunkSplitterV2?: boolean;
    chunkSplitterVersion?: ChunkSplitterVersion;
    E2EEAlgorithm?: E2EEAlgorithm;
    doNotUseFixedRevisionForChunks?: boolean;
    handleFilenameCaseSensitive?: boolean;
    usePluginSyncV2?: boolean;
    useSegmenter?: boolean;
    [key: string]: unknown;
};

/** A client's compatible chunk-format range, plus the version it writes. */
export interface ChunkVersionRange {
    /** Lowest chunk format version this client can read. */
    min: number;
    /** Highest chunk format version this client can read. */
    max: number;
    /** The version it writes. */
    current: number;
}

/**
 * `_local/obsydian_livesync_milestone`: the cluster's shared handshake document.
 *
 * A `type` ALIAS rather than an `interface`, deliberately. TypeScript gives a
 * type alias of an object literal an implicit index signature and an interface
 * none, so only the alias form is assignable to {@link EntryDoc}'s
 * `Record<string, unknown>` member, which is what `putRaw` takes. Changing this
 * to an interface breaks the write path with an assignability error that reads as
 * unrelated.
 *
 * `_local/` is not replicated and does not appear in `_changes`, so the only way
 * to observe it is a direct GET. That is why a peer that never reads it also
 * never notices it appearing, and why `locked`/`cleaned` can be set by another
 * client without anything in a changes feed reporting it.
 */
export type EntryMilestoneInfo = {
    _id: DocumentID;
    _rev?: string;
    type: "milestoneinfo";
    /** Creation timestamp. A CHANGE here means the database was rebuilt. */
    created: number;
    /** Nodes allowed to replicate while `locked` is set. */
    accepted_nodes: string[];
    /** Set by a rebuild or a chunk clean-up. Non-accepted nodes must not write. */
    locked: boolean;
    /** The lock came from a chunk clean-up specifically. */
    cleaned?: boolean;
    node_chunk_info: { [nodeId: string]: ChunkVersionRange };
    /** Per node id, plus the reserved {@link DEVICE_ID_PREFERRED} key. */
    tweak_values: { [nodeId: string]: TweakValues };
};

/**
 * The verdict of {@link ensureRemoteIsCompatible}.
 *
 * `LOCKED` means locked but this node is accepted (the engine's own consumer
 * proceeds); `NODE_LOCKED` and `NODE_CLEANED` mean locked and NOT accepted, and
 * neither heals by waiting.
 */
export type ENSURE_DB_RESULT =
    | "OK"
    | "INCOMPATIBLE"
    | "LOCKED"
    | "NODE_LOCKED"
    | "NODE_CLEANED"
    | ["MISMATCHED", TweakValues];

/**
 * Every tweak key published in the milestone document (the union of upstream's
 * recommended and should-be-matched templates). Values in the template are
 * placeholders: {@link extractObject} uses only its KEYS.
 */
export const TweakValuesTemplate: TweakValues;

/**
 * The subset whose disagreement makes `ensureRemoteIsCompatible` report
 * MISMATCHED. Note that it contains keys `DirectFileManipulatorOptions` has no
 * field for, so a consumer of this package cannot make all of them agree.
 */
export const TweakValuesShouldMatchedTemplate: TweakValues;

/** Fallbacks applied to both sides before comparison, for documents written by older clients. */
export const TweakValuesDefault: TweakValues;

/** Copies the template's KEYS out of `obj`. Keys absent from `obj` come back as `undefined`. */
export function extractObject<T extends Record<string, unknown>>(template: T, obj: Record<string, unknown>): T;

/**
 * Deep inequality. With `ignoreUndefined`, any key that is `undefined` on either
 * side is skipped entirely rather than treated as a difference, which is how a
 * document written by an older client avoids mismatching on keys it never had.
 */
export function isObjectDifferent(a: unknown, b: unknown, ignoreUndefined?: boolean): boolean;

/** The milestone document's id. Note upstream's "obsydian" misspelling: it is a wire identifier. */
export const MILESTONE_DOCID: DocumentID;

/** The reserved `tweak_values` key holding the cluster's authoritative settings. */
export const DEVICE_ID_PREFERRED: "PREFERRED";

/**
 * Reconcile this client with the remote's milestone document, writing it if this
 * client is not represented in it yet (which includes the case where it does not
 * exist at all, i.e. a database no LiveSync client has ever initialised).
 *
 * Pass `false` for `infoSrc` when the document is missing: that is exactly what
 * {@link DirectFileManipulator.rawGet} returns, and the function synthesises a
 * base milestone from it.
 *
 * `updateCallback` is invoked with the document to write, and only when a write
 * is actually needed. It must perform a raw put (see
 * {@link DirectFileManipulator.liveSyncLocalDB}); do not transform the document
 * on the way, since its shape is the wire contract.
 */
export function ensureRemoteIsCompatible(
    infoSrc: EntryMilestoneInfo | false,
    setting: RemoteDBSettings,
    deviceNodeID: string,
    currentVersionRange: ChunkVersionRange,
    updateCallback: (info: EntryMilestoneInfo) => Promise<void>,
): Promise<ENSURE_DB_RESULT>;

// --- Options -----------------------------------------------------------------
export type DirectFileManipulatorOptions = {
    url: string;
    username: string;
    password: string;
    database: string;
    /** Enables E2EE. Omit/undefined disables encryption entirely. */
    passphrase: string | undefined;
    /**
     * Enables path obfuscation. When set, document ids become opaque `f:<sha256
     * hex>` instead of the readable path, so CouchDB never sees the vault layout.
     */
    obfuscatePassphrase: string | undefined;
    useDynamicIterationCount?: boolean;
    customChunkSize?: number;
    minimumChunkSize?: number;
    hashAlg?: HashAlgorithm;
    useEden?: boolean;
    maxChunksInEden?: number;
    maxTotalLengthInEden?: number;
    maxAgeInEden?: number;
    /** @deprecated use chunkSplitterVersion instead. */
    enableChunkSplitterV2?: boolean;
    enableCompression?: boolean;
    handleFilenameCaseSensitive?: boolean;
    doNotUseFixedRevisionForChunks?: boolean;
    chunkSplitterVersion?: ChunkSplitterVersion;
    E2EEAlgorithm?: E2EEAlgorithm;
};

// --- The engine --------------------------------------------------------------
export declare class DirectFileManipulator {
    constructor(options: DirectFileManipulatorOptions);

    options: DirectFileManipulatorOptions;

    /**
     * Resolves once the constructor's fire-and-forget database init has finished.
     *
     * IMPORTANT: if CouchDB is unreachable, this promise never settles (and its
     * internal rejection is unhandled). Await it with a timeout, and on failure
     * build a FRESH DirectFileManipulator rather than retrying against this one:
     * the init is one-shot. The reference bridge does exactly this in
     * `PeerCouchDB._buildManipulator()`.
     */
    ready: {
        promise: Promise<void>;
        resolve: (value: void | PromiseLike<void>) => void;
        reject: (reason?: unknown) => void;
    };

    /** The settings derived from {@link options}. Recomputed on every access. */
    readonly settings: RemoteDBSettings;

    /**
     * Factory for the underlying PouchDB handle. Overridable, and normally worth
     * overriding: the default omits an explicit `fetch`, and the bridge replaces
     * it to force the platform's native fetch because node:http shims broke
     * long-polling behind a reverse proxy.
     */
    $$createPouchDBInstance<T extends object>(
        name?: string,
        options?: PouchDatabaseConfiguration,
    ): PouchDatabaseHandle<T>;

    /** Maps a vault path to its CouchDB document id, applying path obfuscation. */
    path2id(filename: FilePathWithPrefix | FilePath, prefix?: string): Promise<DocumentID>;

    /** Reads a document by path. `metaOnly` skips chunk resolution. */
    get(path: FilePathWithPrefix, metaOnly?: boolean): Promise<false | MetaEntry | ReadyEntry>;

    /** Reads a document by its (possibly obfuscated) id. */
    getById(id: string, metaOnly?: boolean): Promise<false | MetaEntry | ReadyEntry>;

    /** Resolves a metadata-only entry's chunks into its content. Throws if corrupt. */
    getByMeta(doc: MetaEntry): Promise<ReadyEntry>;

    /** Reads a raw document, bypassing chunk resolution. `false` if missing. */
    rawGet<T>(id: DocumentID): Promise<false | T>;

    /**
     * The underlying local database wrapper. ONE member is declared, and only
     * because there is no other way to write a document the class has no method
     * for.
     *
     * `rawGet` exists; a `rawPut` does not. The milestone document
     * ({@link ensureRemoteIsCompatible}) has to be written as-is, so the write has
     * to reach `putRaw`. Declaring the member is not the same thing as reaching
     * through an internal with a cast: this is a public property on the upstream
     * class (`DirectFileManipulatorV2.ts:106`), the engine's own
     * `putSyncParameters` writes through exactly this path, and naming it here
     * means a version bump that removes it fails the typecheck instead of failing
     * at runtime.
     *
     * Nothing else on `LiveSyncLocalDB` is declared, deliberately. Chunk
     * resolution, entry decoding and the change feed all have supported entry
     * points on the class above; use those.
     */
    liveSyncLocalDB: {
        /**
         * Write a document with no chunking, no path mapping and no id
         * derivation. It still passes through the `transform-pouch` transforms,
         * which for a milestone document are provably no-ops: `compressDoc`
         * returns any document without a `data` field unchanged, and
         * `incomingEncryptHKDF` only rewrites documents matching
         * `isEncryptedChunkEntry` (`h:`), `isSyncInfoEntry` (the syncinfo id),
         * `isObfuscatedEntry` (`f:`) or a non-empty `eden`. The Obsidian plugin
         * writes the same document through the same transforms.
         */
        putRaw(doc: EntryDoc, options?: Record<string, unknown>): Promise<{ ok: boolean; id: string; rev: string }>;
    };

    /** Writes a file. Returns false if the write did not take. */
    put(
        path: string,
        data: string[] | Blob,
        info: FileInfo,
        type?: "newnote" | "plain",
    ): Promise<boolean>;

    /** Deletes a file. Returns false if the delete did not take. */
    delete(path: string): Promise<boolean>;

    /** Iterates every non-chunk document in the database. */
    enumerateAllNormalDocs(opt: { metaOnly: boolean }): AsyncGenerator<MetaEntry | ReadyEntry>;

    // --- Change following ---
    /** True while a live `changes` feed is attached. */
    watching: boolean;
    changes: ChangesHandle | undefined;
    /**
     * The replication checkpoint. Persist this across restarts; the bridge stores
     * it in `localStorage`, which Node does not have, so a Node port must give it
     * real storage or every restart rescans (or resumes from "now" and loses
     * changes).
     */
    since: string;

    /**
     * Attaches a live `changes` feed. Returns false if already watching.
     * Reconnects itself after a feed error.
     */
    beginWatch(
        callback: (doc: ReadyEntry, seq?: string | number) => Promise<unknown> | void,
        checkIsInterested?: (doc: MetaEntry) => boolean,
    ): false | void;

    /** Cancels the live feed started by {@link beginWatch}. */
    endWatch(): void;

    /** One-shot catch-up from {@link since}; resolves to the new last sequence. */
    followUpdates(
        callback: (doc: ReadyEntry, seq?: string | number) => Promise<unknown> | void,
        checkIsInterested?: (doc: MetaEntry) => boolean,
    ): Promise<string | number | undefined>;

    /** Closes the underlying database handle and unloads it. */
    close(): Promise<void>;
}

// --- Path / id helpers -------------------------------------------------------
/**
 * NOTE: `path2id_base`/`id2path_base` already handle a leading `_` in paths.
 * Do NOT add a second rule on top: doing so double-mangles `_attachments` on
 * round-trip.
 */
export function path2id_base(
    filename: FilePathWithPrefix | FilePath,
    obfuscatePassphrase: string | false,
    caseInsensitive?: boolean,
): Promise<DocumentID>;
export function id2path_base(id: DocumentID, entry?: EntryHasPath): FilePathWithPrefix;
export function addPrefix(path: FilePath | FilePathWithPrefix, prefix: string): FilePathWithPrefix;
export function stripPrefix(prefixedPath: FilePathWithPrefix): FilePath;
export function stripAllPrefixes(prefixedPath: FilePathWithPrefix): FilePath;
export function getPath(entry: EntryHasPath): FilePathWithPrefix;
export function getPathWithoutPrefix(entry: EntryHasPath): FilePath;
export function shouldBeIgnored(filename: string): boolean;
export function isPlainText(filename: string): boolean;
export function shouldSplitAsPlainText(filename: string): boolean;
export function isAccepted(path: string, ignore: string[]): boolean | undefined;
export function isAcceptedAll(path: string, ignores: string[][]): Promise<boolean>;

// --- Content helpers ---------------------------------------------------------
export function createBlob(data: string | string[] | Uint8Array | ArrayBuffer | Blob): Blob;
export function createTextBlob(data: string | string[]): Blob;
export function determineTypeFromBlob(data: Blob): "newnote" | "plain";
export function uint8ArrayToHexString(src: Uint8Array): string;
