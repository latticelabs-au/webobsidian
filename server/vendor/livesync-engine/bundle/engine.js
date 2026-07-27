// livesync-engine, bundled from vrtmrz/livesync-commonlib @ 8ed9bcd
// https://github.com/vrtmrz/livesync-commonlib
// MIT, Copyright (c) 2022 vorotamoroz
// GENERATED FILE. Do not edit; run `npm run build:engine` at the repo root.

var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __reExport = (target, mod, secondTarget) => (__copyProps(target, mod, "default"), secondTarget && __copyProps(secondTarget, mod, "default"));

// upstream/src/string_and_binary/path.ts
import { minimatch } from "minimatch";

// upstream/src/mods.ts
var webcrypto;
async function getWebCrypto() {
  if (webcrypto) {
    return webcrypto;
  }
  if (globalThis.crypto) {
    webcrypto = globalThis.crypto;
    return webcrypto;
  } else {
    const module = await import("crypto");
    webcrypto = module.webcrypto;
    return webcrypto;
  }
}

// upstream/src/common/types.ts
import {
  LOG_LEVEL_DEBUG,
  LOG_LEVEL_INFO,
  LOG_LEVEL_NOTICE,
  LOG_LEVEL_URGENT,
  LOG_LEVEL_VERBOSE
} from "octagonal-wheels/common/logger";
import { RESULT_NOT_FOUND, RESULT_TIMED_OUT } from "octagonal-wheels/common/const";
var MAX_DOC_SIZE_BIN = 102400;
var LEAF_WAIT_TIMEOUT = 3e4;
var LEAF_WAIT_ONLY_REMOTE = 5e3;
var LEAF_WAIT_TIMEOUT_SEQUENTIAL_REPLICATOR = 5e3;
var CANCELLED = Symbol("cancelled");
var AUTO_MERGED = Symbol("auto_merged");
var NOT_CONFLICTED = Symbol("not_conflicted");
var MISSING_OR_ERROR = Symbol("missing_or_error");
var LEAVE_TO_SUBSEQUENT = Symbol("leave_to_subsequent_proc");
var TIME_ARGUMENT_INFINITY = Symbol("infinity");
var VERSIONING_DOCID = "obsydian_livesync_version";
var SETTING_VERSION_SUPPORT_CASE_INSENSITIVE = 10;
var CURRENT_SETTING_VERSION = SETTING_VERSION_SUPPORT_CASE_INSENSITIVE;
var RemoteTypes = {
  REMOTE_COUCHDB: "",
  REMOTE_MINIO: "MINIO",
  REMOTE_P2P: "ONLY_P2P"
};
var REMOTE_COUCHDB = RemoteTypes.REMOTE_COUCHDB;
var REMOTE_MINIO = RemoteTypes.REMOTE_MINIO;
var REMOTE_P2P = RemoteTypes.REMOTE_P2P;
var P2P_DEFAULT_SETTINGS = {
  P2P_Enabled: false,
  P2P_AutoAccepting: 0 /* NONE */,
  P2P_AppID: "self-hosted-livesync",
  P2P_roomID: "",
  P2P_passphrase: "",
  P2P_relays: "wss://exp-relay.vrtmrz.net/",
  P2P_AutoBroadcast: false,
  P2P_AutoStart: false,
  P2P_AutoSyncPeers: "",
  P2P_AutoWatchPeers: "",
  P2P_SyncOnReplication: "",
  P2P_RebuildFrom: "",
  P2P_AutoAcceptingPeers: "",
  P2P_AutoDenyingPeers: "",
  P2P_IsHeadless: false
};
var E2EEAlgorithms = {
  V1: "",
  V2: "v2",
  ForceV1: "forceV1"
};
var HashAlgorithms = {
  XXHASH32: "xxhash32",
  XXHASH64: "xxhash64",
  MIXED_PUREJS: "mixed-purejs",
  SHA1: "sha1",
  LEGACY: ""
};
var ChunkAlgorithms = {
  V1: "v1",
  V2: "v2",
  V2Segmenter: "v2-segmenter",
  RabinKarp: "v3-rabin-karp"
};
var DEFAULT_SETTINGS = {
  remoteType: REMOTE_COUCHDB,
  useCustomRequestHandler: false,
  couchDB_URI: "",
  couchDB_USER: "",
  couchDB_PASSWORD: "",
  couchDB_DBNAME: "",
  liveSync: false,
  syncOnSave: false,
  syncOnStart: false,
  savingDelay: 200,
  lessInformationInLog: false,
  gcDelay: 300,
  versionUpFlash: "",
  minimumChunkSize: 20,
  longLineThreshold: 250,
  showVerboseLog: false,
  suspendFileWatching: false,
  trashInsteadDelete: true,
  periodicReplication: false,
  periodicReplicationInterval: 60,
  syncOnFileOpen: false,
  encrypt: false,
  passphrase: "",
  usePathObfuscation: false,
  doNotDeleteFolder: false,
  resolveConflictsByNewerFile: false,
  batchSave: false,
  batchSaveMinimumDelay: 5,
  batchSaveMaximumDelay: 60,
  deviceAndVaultName: "",
  usePluginSettings: false,
  showOwnPlugins: false,
  showStatusOnEditor: true,
  showStatusOnStatusbar: true,
  showOnlyIconsOnEditor: false,
  hideFileWarningNotice: false,
  usePluginSync: false,
  autoSweepPlugins: false,
  autoSweepPluginsPeriodic: false,
  notifyPluginOrSettingUpdated: false,
  checkIntegrityOnSave: false,
  batch_size: 25,
  batches_limit: 25,
  useHistory: false,
  disableRequestURI: false,
  skipOlderFilesOnSync: true,
  checkConflictOnlyOnOpen: false,
  showMergeDialogOnlyOnActive: false,
  syncInternalFiles: false,
  syncInternalFilesBeforeReplication: false,
  syncInternalFilesIgnorePatterns: "\\/node_modules\\/, \\/\\.git\\/, \\/obsidian-livesync\\/",
  syncInternalFilesTargetPatterns: "",
  syncInternalFilesInterval: 60,
  additionalSuffixOfDatabaseName: "",
  ignoreVersionCheck: false,
  lastReadUpdates: 0,
  deleteMetadataOfDeletedFiles: false,
  syncIgnoreRegEx: "",
  syncOnlyRegEx: "",
  customChunkSize: 0,
  readChunksOnline: true,
  watchInternalFileChanges: true,
  automaticallyDeleteMetadataOfDeletedFiles: 0,
  disableMarkdownAutoMerge: false,
  writeDocumentsIfConflicted: false,
  useDynamicIterationCount: false,
  syncAfterMerge: false,
  configPassphraseStore: "",
  encryptedPassphrase: "",
  encryptedCouchDBConnection: "",
  permitEmptyPassphrase: false,
  useIndexedDBAdapter: true,
  useTimeouts: false,
  writeLogToTheFile: false,
  doNotPaceReplication: false,
  hashCacheMaxCount: 300,
  hashCacheMaxAmount: 50,
  concurrencyOfReadChunksOnline: 40,
  minimumIntervalOfReadChunksOnline: 50,
  hashAlg: "xxhash64",
  suspendParseReplicationResult: false,
  doNotSuspendOnFetching: false,
  useIgnoreFiles: false,
  ignoreFiles: ".gitignore",
  syncOnEditorSave: false,
  pluginSyncExtendedSetting: {},
  syncMaxSizeInMB: 50,
  settingSyncFile: "",
  writeCredentialsForSettingSync: false,
  notifyAllSettingSyncFile: false,
  isConfigured: void 0,
  settingVersion: CURRENT_SETTING_VERSION,
  enableCompression: false,
  accessKey: "",
  bucket: "",
  endpoint: "",
  region: "auto",
  secretKey: "",
  useEden: false,
  maxChunksInEden: 10,
  maxTotalLengthInEden: 1024,
  maxAgeInEden: 10,
  disableCheckingConfigMismatch: false,
  displayLanguage: "",
  /**
   * @deprecated
   */
  enableChunkSplitterV2: false,
  disableWorkerForGeneratingChunks: false,
  processSmallFilesInUIThread: false,
  notifyThresholdOfRemoteStorageSize: -1,
  usePluginSyncV2: false,
  usePluginEtc: false,
  handleFilenameCaseSensitive: void 0,
  doNotUseFixedRevisionForChunks: true,
  showLongerLogInsideEditor: false,
  sendChunksBulk: false,
  sendChunksBulkMaxSize: 1,
  /**
   * @deprecated
   * This setting is no longer used and will be removed in the future.
   */
  useSegmenter: false,
  useAdvancedMode: false,
  usePowerUserMode: false,
  useEdgeCaseMode: false,
  enableDebugTools: false,
  suppressNotifyHiddenFilesChange: false,
  syncMinimumInterval: 2e3,
  ...P2P_DEFAULT_SETTINGS,
  doctorProcessedVersion: "",
  bucketCustomHeaders: "",
  couchDB_CustomHeaders: "",
  useJWT: false,
  jwtAlgorithm: "",
  jwtKey: "",
  jwtKid: "",
  jwtSub: "",
  jwtExpDuration: 5,
  useRequestAPI: false,
  bucketPrefix: "",
  chunkSplitterVersion: "",
  E2EEAlgorithm: E2EEAlgorithms.V1,
  processSizeMismatchedFiles: false,
  forcePathStyle: true
};
var PREFERRED_BASE = {
  syncMaxSizeInMB: 50,
  chunkSplitterVersion: "v3-rabin-karp",
  doNotUseFixedRevisionForChunks: false,
  usePluginSyncV2: true,
  handleFilenameCaseSensitive: false,
  E2EEAlgorithm: E2EEAlgorithms.V2
};
var PREFERRED_SETTING_CLOUDANT = {
  ...PREFERRED_BASE,
  customChunkSize: 0,
  sendChunksBulkMaxSize: 1,
  concurrencyOfReadChunksOnline: 100,
  minimumIntervalOfReadChunksOnline: 333
};
var PREFERRED_SETTING_SELF_HOSTED = {
  ...PREFERRED_BASE,
  customChunkSize: 50,
  sendChunksBulkMaxSize: 1,
  concurrencyOfReadChunksOnline: 30,
  minimumIntervalOfReadChunksOnline: 25
};
var PREFERRED_JOURNAL_SYNC = {
  ...PREFERRED_BASE,
  customChunkSize: 10,
  concurrencyOfReadChunksOnline: 30,
  minimumIntervalOfReadChunksOnline: 25
};
var EntryTypes = {
  NOTE_LEGACY: "notes",
  NOTE_BINARY: "newnote",
  NOTE_PLAIN: "plain",
  INTERNAL_FILE: "internalfile",
  CHUNK: "leaf",
  CHUNK_PACK: "chunkpack",
  VERSION_INFO: "versioninfo",
  SYNC_INFO: "syncinfo",
  SYNC_PARAMETERS: "sync-parameters",
  MILESTONE_INFO: "milestoneinfo",
  NODE_INFO: "nodeinfo"
};
var NoteTypes = [EntryTypes.NOTE_LEGACY, EntryTypes.NOTE_BINARY, EntryTypes.NOTE_PLAIN];
var ChunkTypes = [EntryTypes.CHUNK, EntryTypes.CHUNK_PACK];
function isMetaEntry(entry) {
  return "children" in entry;
}
var TweakValuesShouldMatchedTemplate = {
  minimumChunkSize: 20,
  longLineThreshold: 250,
  encrypt: false,
  usePathObfuscation: false,
  enableCompression: false,
  useEden: false,
  customChunkSize: 0,
  useDynamicIterationCount: false,
  hashAlg: "xxhash64",
  enableChunkSplitterV2: true,
  maxChunksInEden: 10,
  maxTotalLengthInEden: 1024,
  maxAgeInEden: 10,
  usePluginSyncV2: false,
  handleFilenameCaseSensitive: false,
  doNotUseFixedRevisionForChunks: true,
  useSegmenter: false,
  E2EEAlgorithm: E2EEAlgorithms.V2,
  chunkSplitterVersion: ChunkAlgorithms.RabinKarp
};
var TweakValuesRecommendedTemplate = {
  useIgnoreFiles: false,
  useCustomRequestHandler: false,
  batch_size: 25,
  batches_limit: 25,
  useIndexedDBAdapter: true,
  useTimeouts: false,
  readChunksOnline: true,
  hashCacheMaxCount: 300,
  hashCacheMaxAmount: 50,
  concurrencyOfReadChunksOnline: 40,
  minimumIntervalOfReadChunksOnline: 50,
  ignoreFiles: ".gitignore",
  syncMaxSizeInMB: 50,
  enableChunkSplitterV2: true,
  usePluginSyncV2: true,
  handleFilenameCaseSensitive: false,
  doNotUseFixedRevisionForChunks: false,
  E2EEAlgorithm: E2EEAlgorithms.V2,
  chunkSplitterVersion: ChunkAlgorithms.RabinKarp
};
var TweakValuesDefault = {
  usePluginSyncV2: false,
  E2EEAlgorithm: DEFAULT_SETTINGS.E2EEAlgorithm,
  chunkSplitterVersion: DEFAULT_SETTINGS.chunkSplitterVersion
};
var TweakValuesTemplate = { ...TweakValuesRecommendedTemplate, ...TweakValuesShouldMatchedTemplate };
var PREFIXMD_LOGFILE = "livesync_log_";
var PREFIXMD_LOGFILE_UC = "LIVESYNC_LOG_";
var FlagFilesOriginal = {
  SUSPEND_ALL: "redflag.md",
  REBUILD_ALL: "redflag2.md",
  FETCH_ALL: "redflag3.md"
};
var FlagFilesHumanReadable = {
  REBUILD_ALL: "flag_rebuild.md",
  FETCH_ALL: "flag_fetch.md"
};
var FLAGMD_REDFLAG = FlagFilesOriginal.SUSPEND_ALL;
var FLAGMD_REDFLAG2 = FlagFilesOriginal.REBUILD_ALL;
var FLAGMD_REDFLAG2_HR = FlagFilesHumanReadable.REBUILD_ALL;
var FLAGMD_REDFLAG3 = FlagFilesOriginal.FETCH_ALL;
var FLAGMD_REDFLAG3_HR = FlagFilesHumanReadable.FETCH_ALL;
var SYNCINFO_ID = "syncinfo";
var SALT_OF_ID = "a83hrf7fy7sa8g31";
var SEED_MURMURHASH = 305419896;
var IDPrefixes = {
  Obfuscated: "f:",
  Chunk: "h:",
  EncryptedChunk: "h:+"
};
var PREFIX_OBFUSCATED = "f:";
var PREFIX_ENCRYPTED_CHUNK = "h:+";
var ProtocolVersions = {
  UNSET: void 0,
  LEGACY: 1,
  ADVANCED_E2EE: 2
};
var DOCID_SYNC_PARAMETERS = "_local/obsidian_livesync_sync_parameters";
var DEFAULT_SYNC_PARAMETERS = {
  _id: DOCID_SYNC_PARAMETERS,
  type: EntryTypes["SYNC_PARAMETERS"],
  protocolVersion: ProtocolVersions.ADVANCED_E2EE,
  pbkdf2salt: ""
};

// upstream/src/memory/LRUCache.ts
var LRUCache_exports = {};
__reExport(LRUCache_exports, LRUCache_star);
import * as LRUCache_star from "octagonal-wheels/memory/LRUCache";

// upstream/src/common/utils.ts
import { Semaphore } from "octagonal-wheels/concurrency/semaphore";

// upstream/src/string_and_binary/convert.ts
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  base64ToArrayBufferInternalBrowser,
  arrayBufferToBase64Single,
  readString,
  writeString,
  tryConvertBase64ToArrayBuffer
} from "octagonal-wheels/binary";
import { uint8ArrayToHexString, hexStringToUint8Array } from "octagonal-wheels/binary/hex";
import { encodeBinaryEach, decodeToArrayBuffer } from "octagonal-wheels/binary/encodedUTF16";
import { decodeBinary, encodeBinary } from "octagonal-wheels/binary";
import { escapeStringToHTML } from "octagonal-wheels/string";

// upstream/src/pouchdb/utils_couchdb.ts
function isErrorOfMissingDoc(ex) {
  return (ex && ex?.status) == 404;
}

// upstream/src/common/utils.ts
import { replaceAll, replaceAllPairs } from "octagonal-wheels/string";
import { concatUInt8Array } from "octagonal-wheels/binary";
import { delay, fireAndForget } from "octagonal-wheels/promises";
import { arrayToChunkedArray, unique } from "octagonal-wheels/collection";
import { extractObject, isObjectDifferent } from "octagonal-wheels/object";
import { sendValue, sendSignal, waitForSignal, waitForValue } from "octagonal-wheels/messagepassing/signal";
import { throttle } from "octagonal-wheels/function";
import { sizeToHumanReadable } from "octagonal-wheels/number";
function getDocData(doc) {
  return typeof doc == "string" ? doc : doc.join("");
}
function isTextBlob(blob) {
  return blob.type === "text/plain";
}
function createTextBlob(data) {
  const d = Array.isArray(data) ? data : [data];
  return new Blob(d, { endings: "transparent", type: "text/plain" });
}
function createBinaryBlob(data) {
  return new Blob([data], { endings: "transparent", type: "application/octet-stream" });
}
function createBlob(data) {
  if (data instanceof Blob) return data;
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) return createBinaryBlob(data);
  return createTextBlob(data);
}
var isIndexDBCmpExist = typeof globalThis?.indexedDB?.cmp !== "undefined";
function isObfuscatedEntry(doc) {
  if (doc._id.startsWith(PREFIX_OBFUSCATED)) {
    return true;
  }
  return false;
}
function isEncryptedChunkEntry(doc) {
  if (doc._id.startsWith(PREFIX_ENCRYPTED_CHUNK)) {
    return true;
  }
  return false;
}
function isSyncInfoEntry(doc) {
  if (doc._id == SYNCINFO_ID) {
    return true;
  }
  return false;
}
function memorizeFuncWithLRUCache(func) {
  const cache = new LRUCache_exports.LRUCache(100, 1e5, true);
  return (key) => {
    const isExists = cache.has(key);
    if (isExists) return cache.get(key);
    const value = func(key);
    cache.set(key, value);
    return value;
  };
}
var globalConcurrencyController = Semaphore(50);
function determineTypeFromBlob(data) {
  return isTextBlob(data) ? "plain" : "newnote";
}
function isSensibleMargeApplicable(path) {
  if (path.endsWith(".md")) return true;
  return false;
}
function isObjectMargeApplicable(path) {
  if (path.endsWith(".canvas")) return true;
  if (path.endsWith(".json")) return true;
  return false;
}
function tryParseJSON(str, fallbackValue) {
  try {
    return JSON.parse(str);
  } catch {
    return fallbackValue;
  }
}
var MARK_OPERATOR = ``;
var MARK_DELETED = `${MARK_OPERATOR}__DELETED`;
var MARK_ISARRAY = `${MARK_OPERATOR}__ARRAY`;
var MARK_SWAPPED = `${MARK_OPERATOR}__SWAP`;
function unorderedArrayToObject(obj) {
  return obj.map((e) => ({ [e.id]: e })).reduce((p, c) => ({ ...p, ...c }), {});
}
function objectToUnorderedArray(obj) {
  const entries = Object.entries(obj);
  if (entries.some((e) => e[0] != e[1]?.id)) throw new Error("Item looks like not unordered array");
  return entries.map((e) => e[1]);
}
function generatePatchUnorderedArray(from, to) {
  if (from.every((e) => typeof e == "object" && "id" in e) && to.every((e) => typeof e == "object" && "id" in e)) {
    const fObj = unorderedArrayToObject(from);
    const tObj = unorderedArrayToObject(to);
    const diff = generatePatchObj(fObj, tObj);
    if (Object.keys(diff).length > 0) {
      return { [MARK_ISARRAY]: diff };
    } else {
      return {};
    }
  }
  return { [MARK_SWAPPED]: to };
}
function generatePatchObj(from, to) {
  const entries = Object.entries(from);
  const tempMap = new Map(entries);
  const ret = {};
  const newEntries = Object.entries(to);
  for (const [key, value] of newEntries) {
    if (!tempMap.has(key)) {
      ret[key] = value;
      tempMap.delete(key);
    } else {
      const v = tempMap.get(key);
      if (typeof v !== typeof value || Array.isArray(v) !== Array.isArray(value)) {
        ret[key] = { [MARK_SWAPPED]: value };
      } else {
        if (v === null && value === null) {
        } else if (v === null && value !== null) {
          ret[key] = { [MARK_SWAPPED]: value };
        } else if (v !== null && value === null) {
          ret[key] = { [MARK_SWAPPED]: value };
        } else if (typeof v == "object" && typeof value == "object" && !Array.isArray(v) && !Array.isArray(value)) {
          const wk = generatePatchObj(v, value);
          if (Object.keys(wk).length > 0) ret[key] = wk;
        } else if (typeof v == "object" && typeof value == "object" && Array.isArray(v) && Array.isArray(value)) {
          const wk = generatePatchUnorderedArray(v, value);
          if (Object.keys(wk).length > 0) ret[key] = wk;
        } else if (typeof v != "object" && typeof value != "object") {
          if (JSON.stringify(tempMap.get(key)) !== JSON.stringify(value)) {
            ret[key] = value;
          }
        } else {
          if (JSON.stringify(tempMap.get(key)) !== JSON.stringify(value)) {
            ret[key] = { [MARK_SWAPPED]: value };
          }
        }
      }
      tempMap.delete(key);
    }
  }
  for (const [key] of tempMap) {
    ret[key] = MARK_DELETED;
  }
  return ret;
}
function applyPatch(from, patch) {
  const ret = from;
  const patches = Object.entries(patch);
  for (const [key, value] of patches) {
    if (value == MARK_DELETED) {
      delete ret[key];
      continue;
    }
    if (value === null) {
      ret[key] = null;
      continue;
    }
    if (typeof value == "object") {
      if (MARK_SWAPPED in value) {
        ret[key] = value[MARK_SWAPPED];
        continue;
      }
      if (MARK_ISARRAY in value) {
        if (!(key in ret)) ret[key] = [];
        if (!Array.isArray(ret[key])) {
          throw new Error("Patch target type is mismatched (array to something)");
        }
        const orgArrayObject = unorderedArrayToObject(ret[key]);
        const appliedObject = applyPatch(orgArrayObject, value[MARK_ISARRAY]);
        const appliedArray = objectToUnorderedArray(appliedObject);
        ret[key] = [...appliedArray];
      } else {
        if (!(key in ret)) {
          ret[key] = value;
          continue;
        }
        ret[key] = applyPatch(ret[key], value);
      }
    } else {
      ret[key] = value;
    }
  }
  return ret;
}
function flattenObject(obj, path = []) {
  if (typeof obj != "object") return [[path.join("."), obj]];
  if (obj === null) return [[path.join("."), null]];
  if (Array.isArray(obj)) return [[path.join("."), JSON.stringify(obj)]];
  const e = Object.entries(obj);
  const ret = [];
  for (const [key, value] of e) {
    const p = flattenObject(value, [...path, key]);
    ret.push(...p);
  }
  return ret;
}
function parseCustomRegExp(regexp) {
  if (regexp.startsWith("!!")) {
    return [true, regexp.slice(2)];
  }
  return [false, regexp];
}
function parseCustomRegExpList(list, flags, delimiter) {
  const d = delimiter ?? ",";
  const items = list.replace(/\n| /g, "").split(d).filter((e) => e);
  return items.map((e) => new CustomRegExp(e, flags));
}
var CustomRegExp = class {
  regexp;
  negate;
  pattern;
  constructor(regexp, flags) {
    const [negate, exp] = parseCustomRegExp(regexp);
    this.pattern = exp;
    this.regexp = new RegExp(exp, flags);
    this.negate = negate;
  }
  test(str) {
    return this.negate ? !this.regexp.test(str) : this.regexp.test(str);
  }
};
function getFileRegExp(settings, key) {
  const flagCase = settings.handleFilenameCaseSensitive ? "" : "i";
  if (key === "syncInternalFilesIgnorePatterns" || key === "syncInternalFilesTargetPatterns") {
    const regExp2 = settings[key];
    return parseCustomRegExpList(regExp2, flagCase, ",");
  }
  const regExp = settings[key];
  return parseCustomRegExpList(regExp, flagCase, "|[]|");
}

// upstream/src/string_and_binary/path.ts
import { unique as unique2 } from "octagonal-wheels/collection.js";
function isFilePath(path) {
  if (path.indexOf(":") === -1) return true;
  return false;
}
function stripAllPrefixes(prefixedPath) {
  if (isFilePath(prefixedPath)) return prefixedPath;
  const [, body] = expandFilePathPrefix(prefixedPath);
  return stripAllPrefixes(body);
}
function addPrefix(path, prefix) {
  if (prefix && path.startsWith(prefix)) return path;
  return `${prefix ?? ""}${path}`;
}
function expandFilePathPrefix(path) {
  let [prefix, body] = path.split(":", 2);
  if (!body) {
    body = prefix;
    prefix = "";
  } else {
    prefix = prefix + ":";
  }
  return [prefix, body];
}
function expandDocumentIDPrefix(id) {
  let [prefix, body] = id.split(":", 2);
  if (!body) {
    body = prefix;
    prefix = "";
  } else {
    prefix = prefix + ":";
  }
  return [prefix, body];
}
var _hashString = memorizeFuncWithLRUCache(async (key) => {
  const buff = writeString(key);
  const webcrypto2 = await getWebCrypto();
  let digest = await webcrypto2.subtle.digest("SHA-256", buff);
  const len = key.length;
  for (let i = 0; i < len; i++) {
    digest = await webcrypto2.subtle.digest("SHA-256", buff);
  }
  return uint8ArrayToHexString(new Uint8Array(digest));
});
function hashString(key) {
  return _hashString(key);
}
async function path2id_base(filenameSrc, obfuscatePassphrase, caseInsensitive) {
  if (filenameSrc.startsWith(PREFIX_OBFUSCATED)) return `${filenameSrc}`;
  let filename = `${filenameSrc}`;
  const newPrefix = obfuscatePassphrase ? PREFIX_OBFUSCATED : "";
  if (caseInsensitive) {
    filename = filename.toLowerCase();
  }
  let x = filename;
  if (x.startsWith("_")) x = "/" + x;
  if (!obfuscatePassphrase) {
    return newPrefix + x;
  }
  const [prefix, body] = expandFilePathPrefix(x);
  if (body.startsWith(PREFIX_OBFUSCATED)) return newPrefix + x;
  const hashedPassphrase = await hashString(obfuscatePassphrase);
  const out = await hashString(`${hashedPassphrase}:${filename}`);
  return prefix + newPrefix + out;
}
function id2path_base(id, entry) {
  if (entry && entry?.path) {
    return id2path_base(entry.path);
  }
  if (id.startsWith(PREFIX_OBFUSCATED)) throw new Error("Entry has been obfuscated!");
  const [prefix, body] = expandDocumentIDPrefix(id);
  if (body.startsWith(PREFIX_OBFUSCATED)) throw new Error("Entry has been obfuscated!");
  if (body.startsWith("/")) {
    return body.substring(1);
  }
  return prefix + body;
}
function getPath(entry) {
  return id2path_base(entry._id, entry);
}
function getPathWithoutPrefix(entry) {
  const f = getPath(entry);
  return stripAllPrefixes(f);
}
function stripPrefix(prefixedPath) {
  const [prefix, body] = prefixedPath.split(":", 2);
  if (!body) {
    return prefix;
  }
  return body;
}
function shouldBeIgnored(filename) {
  if (filename == FLAGMD_REDFLAG) {
    return true;
  }
  if (filename == FLAGMD_REDFLAG2) {
    return true;
  }
  if (filename == FLAGMD_REDFLAG2_HR) {
    return true;
  }
  if (filename == FLAGMD_REDFLAG3) {
    return true;
  }
  if (filename == FLAGMD_REDFLAG3_HR) {
    return true;
  }
  if (filename.startsWith(PREFIXMD_LOGFILE)) {
    return true;
  }
  if (filename.startsWith(PREFIXMD_LOGFILE_UC)) {
    return true;
  }
  return false;
}
function isPlainText(filename) {
  if (filename.endsWith(".md")) return true;
  if (filename.endsWith(".txt")) return true;
  if (filename.endsWith(".svg")) return true;
  if (filename.endsWith(".html")) return true;
  if (filename.endsWith(".csv")) return true;
  if (filename.endsWith(".css")) return true;
  if (filename.endsWith(".js")) return true;
  if (filename.endsWith(".xml")) return true;
  if (filename.endsWith(".canvas")) return true;
  return false;
}
function shouldSplitAsPlainText(filename) {
  if (filename.endsWith(".md")) return true;
  if (filename.endsWith(".txt")) return true;
  if (filename.endsWith(".canvas")) return true;
  return false;
}
var matchOpts = { platform: "linux", dot: true, flipNegate: true, nocase: true };
function isAccepted(path, ignore) {
  if (path.indexOf("./") !== -1 || path.indexOf("../") !== -1) {
    return false;
  }
  const patterns = ignore.map((e) => e.trim()).filter((e) => e.length > 0 && !e.startsWith("#"));
  let result = void 0;
  for (const pattern of patterns) {
    if (pattern.endsWith("/")) {
      if (minimatch(path, `${pattern}**`, matchOpts)) {
        return false;
      }
    }
    const newResult = pattern.startsWith("!");
    const matched = minimatch(path, pattern, matchOpts) || !pattern.endsWith("/") && minimatch(path, pattern + "/**", matchOpts);
    if (matched) {
      result = newResult;
    }
  }
  return result;
}
async function isAcceptedAll(path, ignoreFiles, getList) {
  const pathBase = path.substring(0, path.lastIndexOf("/"));
  const intermediatePaths = unique2(
    pathBase.split("/").reduce((p, c) => [...p, p[p.length - 1] + "/" + c], [""]).map((e) => e.substring(1))
  ).reverse();
  for (const intermediatePath of intermediatePaths) {
    for (const ignoreFile of ignoreFiles) {
      const ignoreFilePath = intermediatePath + "/" + ignoreFile;
      const list = await getList(ignoreFilePath);
      if (list === false) continue;
      const result = isAccepted(path.substring(intermediatePath.length ? intermediatePath.length + 1 : 0), list);
      if (result !== void 0) {
        return result;
      }
    }
  }
  return true;
}

// upstream/src/pouchdb/pouchdb-http.ts
import PouchDB from "pouchdb-core";
import HttpPouch from "pouchdb-adapter-http";
import mapreduce from "pouchdb-mapreduce";
import replication from "pouchdb-replication";
import find from "pouchdb-find";
import transform from "transform-pouch";
import { findPathToLeaf } from "pouchdb-merge";
import { adapterFun } from "pouchdb-utils";
import { createError, MISSING_DOC, UNKNOWN_ERROR } from "pouchdb-errors";
import { mapAllTasksWithConcurrencyLimit, unwrapTaskResult } from "octagonal-wheels/concurrency/task";
PouchDB.plugin(HttpPouch).plugin(mapreduce).plugin(replication).plugin(find).plugin(transform);
function appendPurgeSeqs(db, docs) {
  return db.get("_local/purges").then(function(doc) {
    for (const [docId, rev$$1] of docs) {
      const purgeSeq = doc.purgeSeq + 1;
      doc.purges.push({
        docId,
        rev: rev$$1,
        purgeSeq
      });
      if (doc.purges.length > db.purged_infos_limit) {
        doc.purges.splice(0, doc.purges.length - db.purged_infos_limit);
      }
      doc.purgeSeq = purgeSeq;
    }
    return doc;
  }).catch(function(err) {
    if (err.status !== 404) {
      throw err;
    }
    return {
      _id: "_local/purges",
      purges: docs.map(([docId, rev$$1], idx) => ({
        docId,
        rev: rev$$1,
        purgeSeq: idx
      })),
      purgeSeq: docs.length
    };
  }).then(function(doc) {
    return db.put(doc);
  });
}
PouchDB.prototype.purgeMulti = adapterFun(
  "_purgeMulti",
  function(docs, callback) {
    if (typeof this._purge === "undefined") {
      return callback(
        //@ts-ignore: this ts-ignore might be hiding a `this` bug where we don't have "this" conext.
        createError(UNKNOWN_ERROR, "Purge is not implemented in the " + this.adapter + " adapter.")
      );
    }
    const self = this;
    const tasks = docs.map(
      (param) => () => new Promise((res, rej) => {
        const [docId, rev$$1] = param;
        self._getRevisionTree(docId, (error, revs) => {
          if (error) {
            return res([param, error]);
          }
          if (!revs) {
            return res([param, createError(MISSING_DOC)]);
          }
          let path;
          try {
            path = findPathToLeaf(revs, rev$$1);
          } catch (error2) {
            return res([param, error2.message || error2]);
          }
          self._purge(docId, path, (error2, result) => {
            if (error2) {
              return res([param, error2]);
            } else {
              return res([param, result]);
            }
          });
        });
      })
    );
    (async () => {
      const ret = await mapAllTasksWithConcurrencyLimit(1, tasks);
      const retAll = ret.map((e) => unwrapTaskResult(e));
      await appendPurgeSeqs(
        self,
        retAll.filter((e) => "ok" in e[1]).map((e) => e[0])
      );
      const result = Object.fromEntries(retAll.map((e) => [e[0][0], e[1]]));
      return result;
    })().then((result) => callback(void 0, result)).catch((error) => callback(error));
  }
);

// upstream/src/common/logger.ts
var logger_exports = {};
__reExport(logger_exports, logger_star);
import * as logger_star from "octagonal-wheels/common/logger";

// upstream/src/managers/ChunkManager.ts
import { FallbackWeakRef } from "octagonal-wheels/common/polyfill";
import { promiseWithResolver } from "octagonal-wheels/promises";

// upstream/src/common/LSError.ts
var LiveSyncError = class _LiveSyncError extends Error {
  name = this.constructor.name;
  cause;
  overrideStatus;
  /**
   * Returns the HTTP status code associated with the error, if available.
   * If the error has a status property, it returns that; otherwise, it defaults to 500 (Internal Server Error).
   * @returns {number} The HTTP status code.
   */
  get status() {
    if (this.overrideStatus !== void 0) {
      return this.overrideStatus;
    }
    if (this.cause && "status" in this.cause) {
      return this.cause.status;
    }
    return 500;
  }
  /**
   * Constructs a new LiveSyncError instance.
   * @param message The error message to be displayed.
   */
  constructor(message, options) {
    super(message);
    if (options?.cause) {
      this.cause = options.cause instanceof Error ? options.cause : new Error(`${options.cause}`);
    }
    if (options?.status !== void 0) {
      this.overrideStatus = options.status;
    }
  }
  /**
   * Determines whether an error is caused by a specific error class.
   * @param error The error to examine.
   * @param errorClass The error class to compare against.
   * @returns True if the error is caused by the specified error class; otherwise, false.
   * @example
   * LiveSyncError.isCausedBy(someSyncParamsFetchError, SyncParamsNotFoundError); // Returns true if the error is caused by SyncParamsNotFoundError; this is usually represented as SyncParamsFetchError at the uppermost layer.
   */
  static isCausedBy(error, errorClass) {
    if (!error) {
      return false;
    }
    if (error instanceof errorClass) {
      return true;
    }
    if (error.cause) {
      return _LiveSyncError.isCausedBy(error.cause, errorClass);
    }
    return false;
  }
  /**
   * Creates a new instance of the error class from an existing error.
   * @param error The error to wrap.
   * @returns A new instance of the error class with the original error's message and stack trace.
   */
  static fromError(error) {
    if (error instanceof this) {
      return error;
    }
    const instance = new this(`${this.name}: ${error?.message}`, { cause: error });
    if (error?.stack) {
      instance.stack = error.stack;
    } else {
      instance.stack = new Error().stack;
    }
    return instance;
  }
};
var LiveSyncFatalError = class extends LiveSyncError {
};

// upstream/src/managers/ChunkFetcher.ts
import { delay as delay2 } from "octagonal-wheels/promises";
import { unique as unique3 } from "octagonal-wheels/collection";
var EVENT_MISSING_CHUNKS = "missingChunks";
var EVENT_MISSING_CHUNK_REMOTE = "missingChunkRemote";
var BATCH_SIZE = 100;
var ChunkFetcher = class {
  options;
  get chunkManager() {
    return this.options.chunkManager;
  }
  queue = [];
  get interval() {
    return this.options.settings.minimumIntervalOfReadChunksOnline || DEFAULT_SETTINGS.minimumIntervalOfReadChunksOnline;
  }
  get concurrency() {
    return this.options.settings.concurrencyOfReadChunksOnline || DEFAULT_SETTINGS.concurrencyOfReadChunksOnline;
  }
  abort = new AbortController();
  constructor(options) {
    this.options = options;
    this.chunkManager.addListener(EVENT_MISSING_CHUNKS, this.onEventHandler, {
      signal: this.abort.signal
    });
  }
  destroy() {
    this.abort.abort();
    this.queue = [];
  }
  onEventHandler = this.onEvent.bind(this);
  onEvent(ids) {
    this.queue = unique3([...this.queue, ...ids]);
    if (this.canRequestMore()) {
      setTimeout(() => void this.requestMissingChunks(), 1);
    }
  }
  /**
   * Processing requests
   */
  currentProcessing = 0;
  /**
   * Time of the last request to the remote server.
   * This is used to manage the interval between requests.
   * Even if concurrency allows, every start of a request will ensure that the interval is respected.
   */
  previousRequestTime = 0;
  canRequestMore() {
    return this.currentProcessing < this.concurrency && this.queue.length > 0;
  }
  async requestMissingChunks() {
    if (!this.canRequestMore()) {
      return;
    }
    try {
      this.currentProcessing++;
      const requestIDs = this.queue.splice(0, BATCH_SIZE);
      const now = Date.now();
      const timeSinceLastRequest = now - this.previousRequestTime;
      this.previousRequestTime = now;
      const timeToWait = Math.max(this.interval - timeSinceLastRequest, 0);
      if (timeToWait > 0) await delay2(timeToWait);
      const replicator = this.options.getActiveReplicator();
      if (!replicator) {
        (0, logger_exports.Logger)("No active replicator was found to request missing chunks.");
        return;
      }
      const chunks = await replicator.fetchRemoteChunks(requestIDs, false);
      if (!chunks) {
        (0, logger_exports.Logger)(`No chunks were found for the following IDs: ${requestIDs.join(", ")}`);
        for (const chunkID of requestIDs) {
          this.chunkManager.emitEvent(EVENT_MISSING_CHUNK_REMOTE, chunkID);
        }
        return;
      }
      try {
        (0, logger_exports.Logger)(`Writing fetched chunks (${chunks.length}) to the database...`);
        const result = await this.chunkManager.write(
          chunks,
          {
            skipCache: true,
            force: true
            // Force writing to ensure the chunks with existing _rev.
          },
          "ChunkFetcher"
        );
        if (result.result === true) {
          for (const chunk of chunks) {
            this.chunkManager.emitEvent(EVENT_CHUNK_FETCHED, chunk);
          }
        } else {
          (0, logger_exports.Logger)(
            `The fetched chunks could not be stored: ${chunks.map((chunk) => chunk._id).join(", ")}`,
            logger_exports.LOG_LEVEL_VERBOSE
          );
          for (const chunkID of requestIDs) {
            this.chunkManager.emitEvent(EVENT_MISSING_CHUNK_REMOTE, chunkID);
          }
        }
      } catch (error) {
        (0, logger_exports.Logger)(`An error occurred while storing fetched chunks: ${error}`, logger_exports.LOG_LEVEL_VERBOSE);
        for (const chunkID of requestIDs) {
          this.chunkManager.emitEvent(EVENT_MISSING_CHUNK_REMOTE, chunkID);
        }
      }
    } finally {
      this.currentProcessing--;
      this.previousRequestTime = Date.now();
      if (this.queue.length > 0) {
        setTimeout(() => void this.requestMissingChunks(), 0);
      }
    }
  }
};

// upstream/src/managers/ChunkManager.ts
var DEFAULT_MAX_CACHE_SIZE = 1e5;
var HotPackProcessResults = {
  OK: true,
  FAILED: false,
  FALLBACK: Symbol("fallback")
  // Fallback if hot pack fails
};
function buildChunkMap(chunks) {
  const map = /* @__PURE__ */ new Map();
  for (const chunk of chunks) {
    map.set(chunk._id, chunk);
  }
  return map;
}
var DEFAULT_TIMEOUT = 15e3;
function withTimeout(proc, timeout, onTimedOut) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(onTimedOut());
    }, timeout);
    proc.then(resolve).catch(reject).finally(() => {
      clearTimeout(timer);
    });
  });
}
function getError(error) {
  if (error instanceof Error) {
    return error;
  }
  if ("error" in error && error.error instanceof Error) {
    return error.error;
  }
  return void 0;
}
function isMissingError(error) {
  if ("status" in error && error.status === 404) {
    return true;
  }
  if ("error" in error && error.error === "not_found") {
    return true;
  }
  if ("error" in error) {
    return isMissingError(error.error);
  }
  return false;
}
function isChunkDoc(doc) {
  return doc && typeof doc._id === "string" && doc.type === "leaf";
}
var EVENT_CHUNK_FETCHED = "chunkFetched";
var ChunkManager = class {
  options;
  eventTarget = new EventTarget();
  get changeManager() {
    return this.options.changeManager;
  }
  get database() {
    return this.options.database;
  }
  maxCacheSize = DEFAULT_MAX_CACHE_SIZE;
  // Maximum cache size
  caches = /* @__PURE__ */ new Map();
  // Map for cache
  addListener(type, listener, options) {
    const callback = (ev) => {
      listener.call(this, ev.detail);
    };
    this.eventTarget.addEventListener(type, callback, options);
    return () => {
      this.eventTarget.removeEventListener(type, callback, options);
    };
  }
  emitEvent(type, detail) {
    const event = new CustomEvent(type, { detail });
    this.eventTarget.dispatchEvent(event);
  }
  waitingMap = /* @__PURE__ */ new Map();
  // Queue for pending reads
  allocCount = 0;
  // Count of allocated chunks
  derefCount = 0;
  // Count of dereferenced chunks
  clearCaches() {
    this.caches.clear();
    this.allocCount = 0;
    this.derefCount = 0;
  }
  getCachedChunk(id) {
    if (!this.caches.has(id)) {
      return false;
    }
    const weakRef = this.caches.get(id);
    if (weakRef) {
      const cachedChunk = weakRef.deref();
      if (cachedChunk) {
        return cachedChunk;
      } else {
        this.derefCount++;
        this.deleteCachedChunk(id);
        return false;
      }
    }
    return false;
  }
  getChunkIDFromCache(data) {
    for (const [id, weakRef] of this.caches) {
      const chunk = weakRef.deref();
      if (chunk) {
        if (chunk.data === data) {
          return id;
        }
      } else {
        this.derefCount++;
        this.deleteCachedChunk(id);
      }
    }
    return false;
  }
  cacheChunk(chunk) {
    if (this.getCachedChunk(chunk._id)) {
      this.reorderChunk(chunk._id);
      return;
    }
    this.caches.set(chunk._id, new FallbackWeakRef(chunk));
    this.allocCount++;
    const maxCacheSize = this.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE;
    if (this.caches.size > maxCacheSize) {
      do {
        const firstKey = this.caches.keys().next().value;
        if (firstKey) {
          this.caches.delete(firstKey);
        }
      } while (this.caches.size > maxCacheSize);
    }
  }
  reorderChunk(id) {
    const chunk = this.getCachedChunk(id);
    if (chunk) {
      this.caches.delete(id);
      this.caches.set(id, new FallbackWeakRef(chunk));
    }
  }
  deleteCachedChunk(id) {
    if (this.caches.has(id)) {
      this.caches.delete(id);
    }
  }
  _enqueueWaiting(id, timeout) {
    const previous = this.waitingMap.get(id);
    if (previous) {
      return previous.resolver.promise;
    }
    const resolver = promiseWithResolver();
    this.waitingMap.set(id, { resolver });
    return withTimeout(resolver.promise, timeout, () => {
      const current = this.waitingMap.get(id);
      if (current && current.resolver === resolver) {
        this.waitingMap.delete(id);
      }
      return false;
    });
  }
  onChunkArrived(doc, deleted = false) {
    const id = doc._id;
    if (this.waitingMap.has(id)) {
      const queue = this.waitingMap.get(id);
      this.waitingMap.delete(id);
      if (doc._deleted || deleted) {
        queue.resolver.resolve(false);
      } else {
        queue.resolver.resolve(doc);
        this.cacheChunk(doc);
      }
    } else {
    }
  }
  onChunkArrivedHandler = this.onChunkArrived.bind(this);
  onChange(change) {
    const doc = change.doc;
    if (!doc || !doc._id) {
      return;
    }
    if (doc.type !== "leaf") {
      return;
    }
    this.onChunkArrived(doc, change.deleted);
  }
  onChangeHandler = this.onChange.bind(this);
  onMissingChunkRemote(id) {
    if (this.waitingMap.has(id)) {
      const queue = this.waitingMap.get(id);
      this.waitingMap.delete(id);
      queue.resolver.resolve(false);
    }
  }
  onMissingChunkRemoteHandler = this.onMissingChunkRemote.bind(this);
  abort = new AbortController();
  changeHandler;
  initialised = Promise.resolve();
  async _initialise() {
    (0, logger_exports.Logger)("ChunkManager initialised", logger_exports.LOG_LEVEL_VERBOSE);
    return await Promise.resolve();
  }
  constructor(options) {
    this.options = options;
    this.caches = /* @__PURE__ */ new Map();
    this.changeHandler = this.changeManager.addCallback(this.onChangeHandler);
    this.addListener(EVENT_CHUNK_FETCHED, this.onChunkArrivedHandler, { signal: this.abort.signal });
    this.addListener(EVENT_MISSING_CHUNK_REMOTE, this.onMissingChunkRemoteHandler, { signal: this.abort.signal });
    this.initialised = this._initialise();
  }
  destroy() {
    this.abort.abort();
    this.changeHandler();
    this.caches.clear();
    this.waitingMap.clear();
  }
  async readSingle(id, options) {
    if (!options.skipCache) {
      const cachedChunk = this.getCachedChunk(id);
      if (cachedChunk) {
        this.reorderChunk(id);
        return cachedChunk;
      }
    }
    try {
      const result = await this.database.get(id);
      if (result && isChunkDoc(result)) {
        this.cacheChunk(result);
        return result;
      }
    } catch (error) {
      if (!isMissingError(error)) {
        throw new LiveSyncError(`Failed to read chunk ${id}`, { status: 404, cause: error });
      }
    }
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    if (timeout > 0) {
      const ret = this._enqueueWaiting(id, timeout);
      if (!options.preventRemoteRequest) {
        this.emitEvent(EVENT_MISSING_CHUNKS, [id]);
      }
      return ret;
    }
    return false;
  }
  _readFromCache(readIds, resultMap) {
    const cachedChunks = [...readIds].map((id) => this.getCachedChunk(id)).filter((chunk) => chunk !== false);
    for (const chunk of cachedChunks) {
      this.reorderChunk(chunk._id);
      resultMap.set(chunk._id, chunk);
      readIds.delete(chunk._id);
    }
  }
  async _readFromDatabase(readIds, resultMap) {
    const results = await this.database.allDocs({ keys: [...readIds], include_docs: true });
    for (const row of results.rows) {
      if ("doc" in row && row.doc) {
        const chunk = row.doc;
        resultMap.set(chunk._id, chunk);
        readIds.delete(chunk._id);
        this.cacheChunk(chunk);
      } else if (!isMissingError(row)) {
        throw new LiveSyncError(`Failed to read chunk ${row.key}`, { status: 404, cause: getError(row) });
      }
    }
  }
  async _waitForArrival(options, readIds, resultMap) {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    if (timeout > 0) {
      const tasks = [...readIds].map((id) => {
        return this._enqueueWaiting(id, timeout);
      });
      if (!options.preventRemoteRequest) {
        this.emitEvent(EVENT_MISSING_CHUNKS, [...readIds]);
      }
      const results = await Promise.all(tasks);
      for (const chunk of results) {
        if (chunk) {
          resultMap.set(chunk._id, chunk);
          readIds.delete(chunk._id);
          this.cacheChunk(chunk);
        }
      }
    }
  }
  _readPreloadedChunks(preloadedChunks, readIds, resultMap) {
    for (const [id, chunk] of Object.entries(preloadedChunks)) {
      if (isChunkDoc(chunk)) {
        this.cacheChunk(chunk);
        resultMap.set(id, chunk);
        readIds.delete(id);
      }
    }
  }
  async read(ids, options, preloadedChunks) {
    const order = [...ids];
    const resultMap = new Map(ids.map((id) => [id, false]));
    const readIds = /* @__PURE__ */ new Set([...resultMap.keys()]);
    if (preloadedChunks) {
      this._readPreloadedChunks(preloadedChunks, readIds, resultMap);
    }
    if (!options.skipCache) {
      this._readFromCache(readIds, resultMap);
    }
    if (readIds.size > 0) {
      await this._readFromDatabase(readIds, resultMap);
    }
    if (readIds.size > 0) {
      await this._waitForArrival(options, readIds, resultMap);
    }
    return order.map((id) => resultMap.get(id) || false);
  }
  async write(chunks, options, origin) {
    let storeChunks = chunks;
    const writeResult = {
      result: true,
      processed: {
        cached: 0,
        hotPack: 0,
        written: 0,
        duplicated: 0
      }
    };
    const total = storeChunks.length;
    if (!options.skipCache) {
      storeChunks = storeChunks.filter((chunk) => {
        const cached = this.getCachedChunk(chunk._id);
        if (cached) {
          this.reorderChunk(chunk._id);
          return false;
        }
        return true;
      });
    }
    const afterPhase1 = storeChunks.length;
    writeResult.processed.cached = total - afterPhase1;
    if (storeChunks.length === 0) {
      return writeResult;
    }
    const result = await this.database.bulkDocs(storeChunks, { new_edits: !options?.force });
    const failed = result.filter((res) => "error" in res);
    if (failed.some((res) => res.status !== 409)) {
      throw new LiveSyncError(`Failed to write chunks: ${failed.map((res) => res.error).join(", ")}`, {
        status: 500
      });
    }
    const conflictedChunkIDs = failed.filter((res) => typeof res.id === "string").map((res) => res.id);
    if (conflictedChunkIDs.length > 0) {
      writeResult.processed.duplicated = conflictedChunkIDs.length;
      const conflictedChunks = (await this.read(conflictedChunkIDs, { skipCache: false, timeout: 0 })).filter(
        (chunk) => chunk !== false
      );
      const originalChunks = buildChunkMap(chunks);
      for (const chunk of conflictedChunks) {
        const originalChunk = originalChunks.get(chunk._id);
        if (originalChunk && originalChunk.data === chunk.data) {
          this.cacheChunk(chunk);
        } else {
          this.deleteCachedChunk(chunk._id);
          throw new LiveSyncFatalError(
            `Inconsistent chunk data for ${chunk._id}: local data differs from remote data. This is a fatal error.`
          );
        }
      }
    }
    const writeCount = result.length - failed.length;
    writeResult.processed.written = writeCount;
    for (const chunk of storeChunks) {
      this.cacheChunk(chunk);
    }
    return writeResult;
  }
  concurrentTransactions = 0;
  stabilised = Promise.resolve();
  async transaction(callback) {
    await this.initialised;
    await this.stabilised;
    this.concurrentTransactions++;
    try {
      const result = await callback();
      return result;
    } finally {
      this.concurrentTransactions--;
      if (this.concurrentTransactions === 0) {
        (0, logger_exports.Logger)(`All transactions completed. Performing stabilisation.`, logger_exports.LOG_LEVEL_VERBOSE);
        await this._stabilise();
      } else {
        (0, logger_exports.Logger)(`Transaction completed. Remaining: ${this.concurrentTransactions}`, logger_exports.LOG_LEVEL_VERBOSE);
      }
    }
  }
  async _stabilise() {
    const pr = promiseWithResolver();
    this.stabilised = pr.promise;
    try {
      await this.__stabilise();
    } finally {
      pr.resolve();
    }
  }
  __stabilise() {
    return Promise.resolve();
  }
};

// upstream/src/hub/hub.ts
import { EventHub } from "octagonal-wheels/events";
var eventHub = new EventHub();

// upstream/src/pouchdb/LiveSyncLocalDB.ts
import { FallbackWeakRef as FallbackWeakRef2 } from "octagonal-wheels/common/polyfill";
var REMOTE_CHUNK_FETCHED = "remote-chunk-fetched";
function getNoFromRev(rev) {
  if (!rev) return 0;
  return parseInt(rev.split("-")[0]);
}
var LiveSyncLocalDB = class {
  auth;
  dbname;
  settings;
  localDatabase;
  get managers() {
    return this.env.managers;
  }
  isReady = false;
  needScanning = false;
  env;
  clearCaches() {
    this.managers.clearCaches();
  }
  async _prepareHashFunctions() {
    await this.managers?.prepareHashFunction();
  }
  onunload() {
    this.env.$allOnDBUnload(this);
    this.localDatabase.removeAllListeners();
  }
  refreshSettings() {
    const settings = this.env.getSettings();
    this.settings = settings;
    void this._prepareHashFunctions();
  }
  offRemoteChunkFetchedHandler;
  constructor(dbname, env) {
    this.auth = {
      username: "",
      password: ""
    };
    this.dbname = dbname;
    this.env = env;
    this.refreshSettings();
  }
  async close() {
    (0, logger_exports.Logger)("Database closed (by close)");
    this.isReady = false;
    this.offRemoteChunkFetchedHandler?.();
    if (this.localDatabase != null) {
      await this.localDatabase.close();
    }
    this.env.$allOnDBClose(this);
  }
  onNewLeaf(chunk) {
    this.managers.chunkManager?.emitEvent(EVENT_CHUNK_FETCHED, chunk);
  }
  async initializeDatabase() {
    await this._prepareHashFunctions();
    if (this.localDatabase != null) await this.localDatabase.close();
    this.localDatabase = null;
    this.localDatabase = this.env.$$createPouchDBInstance(this.dbname + "-livesync-v2", {
      auto_compaction: false,
      revs_limit: 100,
      deterministic_revs: true
    });
    if (!await this.env.$everyOnInitializeDatabase(this)) {
      (0, logger_exports.Logger)("Initializing Database has been failed on some module", LOG_LEVEL_NOTICE);
    }
    (0, logger_exports.Logger)("Opening Database...");
    (0, logger_exports.Logger)("Database info", LOG_LEVEL_VERBOSE);
    (0, logger_exports.Logger)(await this.localDatabase.info(), LOG_LEVEL_VERBOSE);
    await this.managers.initManagers();
    this.localDatabase.on("close", () => {
      (0, logger_exports.Logger)("Database closed.");
      this.isReady = false;
      this.localDatabase.removeAllListeners();
      this.env.$$getReplicator()?.closeReplication();
      void this.managers.teardownManagers();
    });
    const _instance = new FallbackWeakRef2(this);
    const unload = eventHub.onEvent(REMOTE_CHUNK_FETCHED, (chunk) => {
      if (_instance.deref() == null) {
        unload();
      }
      _instance.deref()?.onNewLeaf(chunk);
    });
    this.offRemoteChunkFetchedHandler = unload;
    this.isReady = true;
    (0, logger_exports.Logger)("Database is now ready.");
    return true;
  }
  /**
   * Retrieve all used and existing chunks in the database.
   * @param includeDeleted  include deleted chunks in the result.
   * @returns {used: Set<string>, existing: Map<string, EntryLeaf>} used: Set of chunk ids that are used in the database. existing: Map of chunk id and EntryLeaf that are existing in the database.
   */
  async allChunks(includeDeleted = false) {
    const used = /* @__PURE__ */ new Set();
    const existing = /* @__PURE__ */ new Map();
    let since = 0;
    do {
      const changes = await this.localDatabase.changes({
        since,
        limit: 100,
        include_docs: true,
        conflicts: true,
        style: includeDeleted ? "all_docs" : "main_only"
      });
      if (changes.results.length == 0) {
        break;
      }
      for (const change of changes.results) {
        const doc = change.doc;
        if (doc.type == "leaf") {
          if (doc._deleted) {
            if (!includeDeleted) {
              continue;
            }
          }
          existing.set(doc._id, doc);
        }
        if ("children" in doc) {
          if (change.deleted) {
            if (!doc._conflicts || doc._conflicts.length == 0) {
              continue;
            }
          }
          doc.children.forEach((e) => used.add(e));
          if (doc._conflicts) {
            const revs = await this.localDatabase.get(doc._id, { revs: true, revs_info: true });
            const mineRevInfo = revs._revs_info || [];
            const keepRevs = /* @__PURE__ */ new Set();
            for (const conflict of doc._conflicts) {
              const conflictedRevs = await this.localDatabase.get(doc._id, {
                rev: conflict,
                revs: true,
                revs_info: true
              });
              const conflictedRevInfo = conflictedRevs._revs_info || [];
              const diffRevs = mineRevInfo.filter(
                (e) => !conflictedRevInfo.some((f) => f.rev == e.rev && f.status == e.status)
              );
              const diffRevs2 = conflictedRevInfo.filter(
                (e) => !mineRevInfo.some((f) => f.rev == e.rev && f.status == e.status)
              );
              const diffRevs3 = diffRevs.concat(diffRevs2);
              const sameRevs = mineRevInfo.filter((e) => conflictedRevInfo.some((f) => f.rev == e.rev && f.status == e.status)).filter((e) => e.status == "available").sort((a, b) => getNoFromRev(b.rev) - getNoFromRev(a.rev));
              const sameRevsTop = sameRevs.length > 0 ? [sameRevs[0].rev] : [];
              const keepRevList = [
                ...diffRevs3.filter((e) => e.status == "available").map((e) => e.rev),
                ...sameRevsTop
              ];
              keepRevList.forEach((e) => keepRevs.add(e));
            }
            const detail = await this.localDatabase.bulkGet({
              docs: [...keepRevs.values()].map((e) => ({ id: doc._id, rev: e }))
            });
            for (const e of detail.results) {
              if ("docs" in e) {
                const docs = e.docs;
                for (const doc2 of docs) {
                  if ("ok" in doc2) {
                    if ("children" in doc2.ok) {
                      doc2.ok.children.forEach((e2) => used.add(e2));
                    }
                  }
                }
              }
            }
          }
        }
      }
      since = changes.results[changes.results.length - 1].seq;
    } while (true);
    return { used, existing };
  }
  async resetDatabase() {
    await this.managers.teardownManagers();
    this.env.$$getReplicator().closeReplication();
    if (!await this.env.$everyOnResetDatabase(this)) {
      (0, logger_exports.Logger)("Database reset has been prevented or failed on some modules.", LOG_LEVEL_NOTICE);
      return false;
    }
    (0, logger_exports.Logger)("Database closed for reset Database.");
    this.isReady = false;
    await this.localDatabase.destroy();
    this.localDatabase = null;
    await this.initializeDatabase();
    (0, logger_exports.Logger)("Local Database Reset", LOG_LEVEL_NOTICE);
  }
  async *findEntries(startKey, endKey, opt) {
    const pageLimit = 100;
    let nextKey = startKey;
    if (endKey == "") endKey = "\u{10FFFF}";
    let req = this.allDocsRaw({ limit: pageLimit, startkey: nextKey, endkey: endKey, include_docs: true, ...opt });
    do {
      const docs = await req;
      if (docs.rows.length === 0) {
        break;
      }
      nextKey = `${docs.rows[docs.rows.length - 1].id}`;
      req = this.allDocsRaw({
        limit: pageLimit,
        skip: 1,
        startkey: nextKey,
        endkey: endKey,
        include_docs: true,
        ...opt
      });
      for (const row of docs.rows) {
        const doc = row.doc;
        if (!("type" in doc)) {
          continue;
        }
        if (doc.type == "newnote" || doc.type == "plain") {
          yield doc;
        }
      }
    } while (nextKey != "");
  }
  async *findAllDocs(opt) {
    const targets = [
      () => this.findEntries("", "_", opt ?? {}),
      () => this.findEntries("_\u{10FFFF}", "h:", opt ?? {}),
      () => this.findEntries(`h:\u{10FFFF}`, "", opt ?? {})
    ];
    for (const targetFun of targets) {
      yield* targetFun();
    }
  }
  async *findEntryNames(startKey, endKey, opt) {
    const pageLimit = 100;
    let nextKey = startKey;
    if (endKey == "") endKey = "\u{10FFFF}";
    let req = this.allDocsRaw({ limit: pageLimit, startkey: nextKey, endkey: endKey, ...opt });
    do {
      const docs = await req;
      if (docs.rows.length == 0) {
        nextKey = "";
        break;
      }
      nextKey = `${docs.rows[docs.rows.length - 1].key}`;
      req = this.allDocsRaw({ limit: pageLimit, skip: 1, startkey: nextKey, endkey: endKey, ...opt });
      for (const row of docs.rows) {
        yield row.id;
      }
    } while (nextKey != "");
  }
  async *findAllDocNames(opt) {
    const targets = [
      () => this.findEntryNames("", "_", opt ?? {}),
      () => this.findEntryNames("_\u{10FFFF}", "h:", opt ?? {}),
      () => this.findEntryNames(`h:\u{10FFFF}`, "i:", opt ?? {}),
      () => this.findEntryNames(`i:\u{10FFFF}`, "ix:", opt ?? {}),
      () => this.findEntryNames(`ix:\u{10FFFF}`, "ps:", opt ?? {}),
      () => this.findEntryNames(`ps:\u{10FFFF}`, "", opt ?? {})
    ];
    for (const targetFun of targets) {
      const target = targetFun();
      for await (const f of target) {
        if (f.startsWith("_")) continue;
        if (f == VERSIONING_DOCID) continue;
        yield f;
      }
    }
  }
  async *findAllNormalDocs(opt) {
    const targets = [
      () => this.findEntries("", "_", opt ?? {}),
      () => this.findEntries("_\u{10FFFF}", "h:", opt ?? {}),
      () => this.findEntries(`h:\u{10FFFF}`, "i:", opt ?? {}),
      () => this.findEntries(`i:\u{10FFFF}`, "ix:", opt ?? {}),
      () => this.findEntries(`ix:\u{10FFFF}`, "ps:", opt ?? {}),
      () => this.findEntries(`ps:\u{10FFFF}`, "", opt ?? {})
    ];
    for (const targetFun of targets) {
      const target = targetFun();
      for await (const f of target) {
        if (f._id.startsWith("_")) continue;
        if (f.type != "newnote" && f.type != "plain") continue;
        yield f;
      }
    }
  }
  async removeRevision(docId, revision) {
    try {
      const doc = await this.localDatabase.get(docId, { rev: revision });
      doc._deleted = true;
      await this.localDatabase.put(doc);
      return true;
    } catch (ex) {
      if (isErrorOfMissingDoc(ex)) {
        (0, logger_exports.Logger)(`Remove revision: Missing target revision, ${docId}-${revision}`, LOG_LEVEL_VERBOSE);
      }
    }
    return false;
  }
  getRaw(docId, options) {
    return this.localDatabase.get(docId, options || {});
  }
  removeRaw(docId, revision, options) {
    return this.localDatabase.remove(docId, revision, options || {});
  }
  putRaw(doc, options) {
    return this.localDatabase.put(doc, options || {});
  }
  allDocsRaw(options) {
    return this.localDatabase.allDocs(options);
  }
  bulkDocsRaw(docs, options) {
    return this.localDatabase.bulkDocs(docs, options || {});
  }
  // For compatibility
  isTargetFile(filenameSrc) {
    return this.managers.entryManager.isTargetFile(filenameSrc);
  }
  async getDBEntryMeta(path, opt, includeDeleted = false) {
    return await this.managers.entryManager.getDBEntryMeta(path, opt, includeDeleted);
  }
  async getDBEntry(path, opt, dump = false, waitForReady = true, includeDeleted = false) {
    return await this.managers.entryManager.getDBEntry(path, opt, dump, waitForReady, includeDeleted);
  }
  async getDBEntryFromMeta(meta, dump = false, waitForReady = true) {
    return await this.managers.entryManager.getDBEntryFromMeta(meta, dump, waitForReady);
  }
  async deleteDBEntry(path, opt) {
    return await this.managers.entryManager.deleteDBEntry(path, opt);
  }
  async putDBEntry(note, onlyChunks) {
    return await this.managers.entryManager.putDBEntry(note, onlyChunks);
  }
  async getConflictedDoc(path, rev) {
    return await this.managers.conflictManager.getConflictedDoc(path, rev);
  }
  async tryAutoMerge(path, enableMarkdownAutoMerge) {
    return await this.managers.conflictManager.tryAutoMerge(path, enableMarkdownAutoMerge);
  }
};

// upstream/src/pouchdb/compress.ts
import * as fflate from "fflate";
async function _compressText(text) {
  const converted = tryConvertBase64ToArrayBuffer(text);
  const data = new Uint8Array(
    converted || await new Blob([text], { type: "application/octet-stream" }).arrayBuffer()
  );
  if (data.buffer.byteLength == 0) {
    return "";
  }
  const df = await wrappedDeflate(new Uint8Array(data), { consume: true, level: 8 });
  const deflateResult = (converted ? "~" : "") + await arrayBufferToBase64Single(df);
  return deflateResult;
}
var wrappedInflate = wrapFflateFunc(fflate.inflate);
var wrappedDeflate = wrapFflateFunc(fflate.deflate);
async function _decompressText(compressed, _useUTF16 = false) {
  if (compressed.length == 0) {
    return "";
  }
  const converted = compressed[0] == "~";
  const src = compressed.substring(converted ? 1 : 0);
  if (src.length == 0) {
    return "";
  }
  const ab = new Uint8Array(base64ToArrayBuffer(src));
  if (ab.length == 0) {
    return "";
  }
  const ret = await wrappedInflate(new Uint8Array(ab), { consume: true });
  if (converted) {
    return await arrayBufferToBase64Single(ret);
  }
  const response = new Blob([ret]);
  const text = await response.text();
  return text;
}
async function compressDoc(doc) {
  if (!("data" in doc)) {
    return doc;
  }
  if (typeof doc.data !== "string") return doc;
  if (doc.data.startsWith(MARK_SHIFT_COMPRESSED)) return doc;
  const oldData = doc.data;
  const compressed = await _compressText(oldData);
  const newData = MARK_SHIFT_COMPRESSED + compressed;
  if (doc.data.length > newData.length) doc.data = newData;
  return doc;
}
async function decompressDoc(doc) {
  if (!("data" in doc)) {
    return doc;
  }
  if (typeof doc.data !== "string") return doc;
  if (doc.data.startsWith(MARK_SHIFT_COMPRESSED)) {
    doc.data = await _decompressText(doc.data.substring(MARK_SHIFT_COMPRESSED.length));
  }
  return doc;
}
function wrapFflateFunc(func) {
  return (data, opts) => {
    return new Promise((res, rej) => {
      func(data, opts, (err, result) => {
        if (err) rej(err);
        else res(result);
      });
    });
  };
}
var replicationFilter = (db, compress) => {
  db.transform({
    //@ts-ignore
    async incoming(doc) {
      if (!compress) return doc;
      return await compressDoc(doc);
    },
    //@ts-ignore
    async outgoing(doc) {
      return await decompressDoc(doc);
    }
  });
};
var MARK_SHIFT = `L`;
var MARK_SHIFT_COMPRESSED = `${MARK_SHIFT}Z`;

// upstream/src/encryption/e2ee_v2.ts
var e2ee_v2_exports = {};
__reExport(e2ee_v2_exports, encryption_star);
__reExport(e2ee_v2_exports, encryptionv3_star);
import * as encryption_star from "octagonal-wheels/encryption/encryption";
import * as encryptionv3_star from "octagonal-wheels/encryption/encryptionv3";

// upstream/src/worker/bgWorker.mock.ts
import { decrypt, encrypt } from "octagonal-wheels/encryption/index.js";
import { encrypt as encryptHKDF, decrypt as decryptHKDF } from "octagonal-wheels/encryption/hkdf";

// upstream/src/string_and_binary/chunks.ts
function isTextBlob2(blob) {
  return blob.type === "text/plain";
}
function* pickPiece(leftData, minimumChunkSize) {
  let buffer = "";
  L1: do {
    const curLine = leftData.shift();
    if (typeof curLine === "undefined") {
      yield buffer;
      break L1;
    }
    if (curLine.startsWith("```") || curLine.startsWith(" ```") || curLine.startsWith("  ```") || curLine.startsWith("   ```")) {
      yield buffer;
      buffer = curLine + (leftData.length != 0 ? "\n" : "");
      L2: do {
        const curPx = leftData.shift();
        if (typeof curPx === "undefined") {
          break L2;
        }
        buffer += curPx + (leftData.length != 0 ? "\n" : "");
      } while (leftData.length > 0 && !(leftData[0].startsWith("```") || leftData[0].startsWith(" ```") || leftData[0].startsWith("  ```") || leftData[0].startsWith("   ```")));
      const isLooksLikeBASE64 = buffer.endsWith("=");
      const maybeUneditable = buffer.length > 2048;
      const endOfCodeBlock = leftData.shift();
      if (typeof endOfCodeBlock !== "undefined") {
        buffer += endOfCodeBlock;
        buffer += leftData.length != 0 ? "\n" : "";
      }
      if (!isLooksLikeBASE64 && !maybeUneditable) {
        const splitExpr = /(.*?[;,:<])/g;
        const sx = buffer.split(splitExpr).filter((e) => e != "");
        for (const v of sx) {
          yield v;
        }
      } else {
        yield buffer;
      }
      buffer = "";
    } else {
      buffer += curLine + (leftData.length != 0 ? "\n" : "");
      if (buffer.length >= minimumChunkSize || leftData.length == 0 || leftData[0] == "#" || buffer[0] == "#") {
        yield buffer;
        buffer = "";
      }
    }
  } while (leftData.length > 0);
}
var charNewLine = "\n".charCodeAt(0);
var segmenter = "Segmenter" in Intl ? new Intl.Segmenter(navigator.language, { granularity: "sentence" }) : void 0;
function* splitStringWithinLength(text, pieceSize) {
  let leftData = text;
  do {
    const splitSize = pieceSize;
    const piece = leftData.substring(0, splitSize);
    leftData = leftData.substring(splitSize);
    yield piece;
  } while (leftData != "");
}
function* splitTextInSegment(text, pieceSize, minimumChunkSize) {
  const segments = segmenter.segment(text);
  let prev = "";
  let buf = "";
  for (const seg of segments) {
    const buffer = seg.segment;
    if (prev == buffer || buf.length < minimumChunkSize) {
      buf += buffer;
      prev = buffer;
    } else {
      prev = buffer;
      if (buf.length > 0) {
        yield* splitStringWithinLength(buf, pieceSize);
      }
      buf = buffer;
    }
  }
  if (buf.length > 0) {
    yield* splitStringWithinLength(buf, pieceSize);
  }
}
function* splitInNewLine(texts) {
  for (const text of texts) {
    let start = -1;
    let end = -1;
    do {
      end = text.indexOf("\n", start);
      if (end == -1) {
        yield text.substring(start);
        break;
      }
      while (text[end] == "\n") {
        end++;
      }
      yield text.substring(start, end);
      start = end;
    } while (end != -1);
  }
  return;
}
function splitPiecesTextV2(dataSrc, pieceSize, minimumChunkSize) {
  const dataListAllArray = typeof dataSrc == "string" ? [dataSrc] : dataSrc;
  const dataListAll = splitInNewLine(dataListAllArray);
  let inCodeBlock = 0;
  let flush = false;
  let flushBefore = false;
  return function* () {
    const buf = [];
    for (const line of dataListAll) {
      if (line.startsWith("````")) {
        if (inCodeBlock == 0) {
          inCodeBlock = 4;
          flushBefore = true;
        } else if (inCodeBlock == 4) {
          inCodeBlock = 0;
          flush = true;
        }
      } else if (line.startsWith("```")) {
        if (inCodeBlock == 0) {
          inCodeBlock = 3;
          flushBefore = true;
        } else if (inCodeBlock == 3) {
          inCodeBlock = 0;
          flush = true;
        }
      }
      if (flushBefore) {
        if (buf.length > 0) {
          yield* splitTextInSegment(buf.join(""), pieceSize, minimumChunkSize);
          buf.length = 0;
        }
        flushBefore = false;
      }
      buf.push(line);
      if (flush) {
        if (buf.length > 0) {
          yield* splitStringWithinLength(buf.join(""), pieceSize);
          buf.length = 0;
        }
        flush = false;
      }
    }
    if (buf.length > 0) {
      if (inCodeBlock == 0) {
        yield* splitTextInSegment(buf.join(""), pieceSize, minimumChunkSize);
      } else {
        yield* splitStringWithinLength(buf.join(""), pieceSize);
      }
    }
  };
}
function binaryTextSplit(data, pieceSize, minimumChunkSize) {
  return function* pieces() {
    yield* splitStringWithinLength(data, pieceSize);
  };
}
function splitPiecesText(dataSrc, pieceSize, plainSplit, minimumChunkSize, useSegmenter) {
  if (!useSegmenter || !segmenter) {
    return splitPiecesTextV1(dataSrc, pieceSize, plainSplit, minimumChunkSize);
  }
  if (!plainSplit) {
    return binaryTextSplit(dataSrc, pieceSize, minimumChunkSize);
  }
  return splitPiecesTextV2(dataSrc, pieceSize, minimumChunkSize);
}
function splitPiecesTextV1(dataSrc, pieceSize, plainSplit, minimumChunkSize) {
  const dataList = typeof dataSrc == "string" ? [dataSrc] : dataSrc;
  return function* pieces() {
    for (const data of dataList) {
      if (plainSplit) {
        const leftData = data.split("\n");
        const f = pickPiece(leftData, minimumChunkSize);
        for (const piece of f) {
          let buffer = piece;
          do {
            let ps = pieceSize;
            if (buffer.charCodeAt(ps - 1) != buffer.codePointAt(ps - 1)) {
              ps++;
            }
            yield buffer.substring(0, ps);
            buffer = buffer.substring(ps);
          } while (buffer != "");
        }
      } else {
        let leftData = data;
        do {
          const splitSize = pieceSize;
          const piece = leftData.substring(0, splitSize);
          leftData = leftData.substring(splitSize);
          yield piece;
        } while (leftData != "");
      }
    }
  };
}
function* splitByDelimiterWithMinLength(sources, delimiter, minimumChunkLength = 25, splitThreshold) {
  let buf = "";
  let last = false;
  const dl = delimiter.length;
  for (const source of sources) {
    const max = source.length;
    if (splitThreshold && max > splitThreshold) {
      yield buf + source;
      last = false;
      buf = "";
      continue;
    }
    let i = -1;
    let prev = 0;
    L1: do {
      i = source.indexOf(delimiter, prev);
      if (i == -1) break L1;
      buf += source.slice(prev, i) + delimiter;
      if (buf.length > minimumChunkLength) {
        yield buf;
        buf = "";
        last = false;
      } else {
        last = true;
      }
      prev = i + dl;
    } while (i < max);
    if (prev != i || prev == -1 && i == -1) {
      buf += source.slice(prev);
      last = true;
    }
  }
  if (last) {
    yield buf;
  }
}
function* chunkStringGenerator(source, maxLength) {
  const strLen = source.length;
  if (strLen > maxLength) {
    let from = 0;
    do {
      let end = from + maxLength;
      if (end > strLen) {
        yield source.substring(from);
        break;
      }
      while (source.charCodeAt(end - 1) != source.codePointAt(end - 1)) {
        end++;
      }
      yield source.substring(from, end);
      from = end;
    } while (from < strLen);
  } else {
    yield source;
  }
}
function* chunkStringGeneratorFromGenerator(sources, maxLength) {
  for (const source of sources) {
    yield* chunkStringGenerator(source, maxLength);
  }
}
function* stringGenerator(sources) {
  for (const str of sources) {
    yield str;
  }
}
var MAX_ITEMS = 100;
async function splitPieces2V2(dataSrc, pieceSize, plainSplit, minimumChunkSize, filename, useSegmenter) {
  if (dataSrc.size == 0) {
    return function* noItems() {
      return;
    };
  }
  if (isTextBlob2(dataSrc)) {
    const text = await dataSrc.text();
    if (!plainSplit) {
      const gen2 = chunkStringGenerator(text, pieceSize);
      return function* pieces() {
        yield* gen2;
      };
    }
    const textLen = text.length;
    let xMinimumChunkSize = minimumChunkSize;
    while (textLen / xMinimumChunkSize > MAX_ITEMS) {
      xMinimumChunkSize += minimumChunkSize;
    }
    const org = stringGenerator([text]);
    const gen1 = splitByDelimiterWithMinLength(org, "\n", xMinimumChunkSize);
    const gen = chunkStringGeneratorFromGenerator(gen1, pieceSize);
    return function* pieces() {
      yield* gen;
    };
  }
  let canBeSmall = false;
  let delimiter = 0;
  if (filename && filename.endsWith(".pdf")) {
    delimiter = "/".charCodeAt(0);
  } else if (filename && filename.endsWith(".json")) {
    canBeSmall = true;
    delimiter = ",".charCodeAt(0);
  }
  const clampMin = canBeSmall ? 100 : 1e5;
  const clampMax = 1e8;
  const clampedSize = Math.max(clampMin, Math.min(clampMax, dataSrc.size));
  let step = 1;
  let w = clampedSize;
  while (w > 10) {
    w /= 12.5;
    step++;
  }
  minimumChunkSize = Math.floor(10 ** (step - 1));
  return async function* piecesBlob() {
    const size = dataSrc.size;
    let i = 0;
    const buf = new Uint8Array(await dataSrc.arrayBuffer());
    do {
      const findStart = i + minimumChunkSize;
      const defaultSplitEnd = i + pieceSize;
      let splitEnd;
      let i1 = buf.indexOf(delimiter, findStart);
      if (i1 == -1) {
        i1 = buf.indexOf(charNewLine, findStart);
      }
      if (i1 == -1) {
        splitEnd = defaultSplitEnd;
      } else {
        splitEnd = i1 < defaultSplitEnd ? i1 : defaultSplitEnd;
      }
      yield await arrayBufferToBase64Single(buf.slice(i, splitEnd));
      i = splitEnd;
    } while (i < size);
  };
}
async function splitPieces2(dataSrc, pieceSize, plainSplit, minimumChunkSize, filename, useSegmenter) {
  if (isTextBlob2(dataSrc)) {
    return splitPiecesText(await dataSrc.text(), pieceSize, plainSplit, minimumChunkSize, useSegmenter ?? false);
  }
  let delimiter = 0;
  let canBeSmall = false;
  if (filename && filename.endsWith(".pdf")) {
    delimiter = "/".charCodeAt(0);
  } else if (filename && filename.endsWith(".json")) {
    canBeSmall = true;
    delimiter = ",".charCodeAt(0);
  }
  const clampMin = canBeSmall ? 100 : 1e5;
  const clampMax = 1e8;
  const clampedSize = Math.max(clampMin, Math.min(clampMax, dataSrc.size));
  let step = 1;
  let w = clampedSize;
  while (w > 10) {
    w /= 12.5;
    step++;
  }
  minimumChunkSize = Math.floor(10 ** (step - 1));
  return async function* piecesBlob() {
    const size = dataSrc.size;
    let i = 0;
    do {
      let splitSize = pieceSize;
      const currentData = new Uint8Array(await dataSrc.slice(i, i + pieceSize).arrayBuffer());
      let nextIdx = currentData.indexOf(delimiter, minimumChunkSize);
      splitSize = nextIdx == -1 ? pieceSize : Math.min(pieceSize, nextIdx);
      if (nextIdx == -1) nextIdx = currentData.indexOf(charNewLine, minimumChunkSize);
      const piece = currentData.slice(0, splitSize);
      i += piece.length;
      const b64 = await arrayBufferToBase64Single(piece);
      yield b64;
    } while (i < size);
  };
}
async function splitPiecesRabinKarp(dataSrc, absoluteMaxPieceSize, doPlainSplit, minimumChunkSize, _filename, _useSegmenter) {
  const plainSplit = doPlainSplit || isTextBlob2(dataSrc);
  const minPieceSize = plainSplit ? 128 : 1024 * 4;
  const splitPieceCount = plainSplit ? 20 : 12;
  const avgChunkSize = Math.max(minPieceSize, Math.floor(dataSrc.size / splitPieceCount));
  const maxChunkSize = Math.min(absoluteMaxPieceSize, avgChunkSize * 5);
  const minChunkSize = Math.min(Math.max(Math.floor(avgChunkSize / 4), minimumChunkSize), maxChunkSize);
  const windowSize = 48;
  const hashModulus = avgChunkSize;
  const boundaryPattern = 1;
  const PRIME = 31;
  let P_pow_w = 1;
  for (let i = 0; i < windowSize - 1; i++) {
    P_pow_w = Math.imul(P_pow_w, PRIME);
  }
  const buffer = new Uint8Array(await dataSrc.arrayBuffer());
  let pos = 0;
  let hash = 0;
  let start = 0;
  const isText = isTextBlob2(dataSrc);
  const length = buffer.length;
  return async function* piecesBlob() {
    while (pos < length) {
      const byte = buffer[pos];
      if (pos >= start + windowSize) {
        const oldByte = buffer[pos - windowSize];
        const oldByteTerm = Math.imul(oldByte, P_pow_w);
        hash = hash - oldByteTerm | 0;
        hash = Math.imul(hash, PRIME);
        hash = hash + byte | 0;
      } else {
        hash = Math.imul(hash, PRIME);
        hash = hash + byte | 0;
      }
      const currentChunkSize = pos - start + 1;
      let isBoundaryCandidate = false;
      if (currentChunkSize >= minChunkSize) {
        if ((hash >>> 0) % hashModulus === boundaryPattern) {
          isBoundaryCandidate = true;
        }
      }
      if (currentChunkSize >= maxChunkSize) {
        isBoundaryCandidate = true;
      }
      if (isBoundaryCandidate) {
        let isSafeBoundary = true;
        if (isText) {
          if (pos + 1 < length && (buffer[pos + 1] & 192) === 128) {
            isSafeBoundary = false;
          }
        }
        if (isSafeBoundary) {
          if (isText) {
            yield Promise.resolve(readString(buffer.subarray(start, pos + 1)));
          } else {
            yield await arrayBufferToBase64Single(buffer.subarray(start, pos + 1));
          }
          start = pos + 1;
        }
      }
      pos++;
    }
    if (start < length) {
      if (isText) {
        yield Promise.resolve(readString(buffer.subarray(start, length)));
      } else {
        yield await arrayBufferToBase64Single(buffer.subarray(start, length));
      }
    }
  };
}

// upstream/src/worker/bgWorker.mock.ts
function splitPieces2Worker(dataSrc, pieceSize, plainSplit, minimumChunkSize, filename, useSegmenter) {
  return splitPieces2(dataSrc, pieceSize, plainSplit, minimumChunkSize, filename, useSegmenter ?? false);
}
function splitPieces2WorkerV2(dataSrc, pieceSize, plainSplit, minimumChunkSize, filename, useSegmenter) {
  return splitPieces2V2(dataSrc, pieceSize, plainSplit, minimumChunkSize, filename, useSegmenter ?? false);
}
function splitPieces2WorkerRabinKarp(dataSrc, pieceSize, plainSplit, minimumChunkSize, filename, useSegmenter) {
  return splitPiecesRabinKarp(dataSrc, pieceSize, plainSplit, minimumChunkSize, filename, useSegmenter ?? false);
}
function encryptWorker(input, passphrase, autoCalculateIterations) {
  return encrypt(input, passphrase, autoCalculateIterations);
}
function decryptWorker(input, passphrase, autoCalculateIterations) {
  return decrypt(input, passphrase, autoCalculateIterations);
}
function encryptHKDFWorker(input, passphrase, pbkdf2Salt) {
  return encryptHKDF(input, passphrase, pbkdf2Salt);
}
function decryptHKDFWorker(input, passphrase, pbkdf2Salt) {
  return decryptHKDF(input, passphrase, pbkdf2Salt);
}

// upstream/src/pouchdb/encryption.ts
var encrypt2 = encryptWorker;
var decrypt2 = decryptWorker;
var encryptHKDF2 = encryptHKDFWorker;
var decryptHKDF2 = decryptHKDFWorker;
var Encrypt_HKDF_Header = "%=";
var Encrypt_OLD_Header = "%";
var EncryptionVersions = {
  UNENCRYPTED: 0,
  ENCRYPTED: 1,
  HKDF: 2,
  UNKNOWN: 99
};
function getEncryptionVersion(data) {
  if ("e_" in data && data.e_ === true) {
    if (data.data.startsWith(Encrypt_HKDF_Header)) {
      return EncryptionVersions.HKDF;
    } else if (data.data.startsWith(Encrypt_OLD_Header)) {
      return EncryptionVersions.ENCRYPTED;
    }
    return EncryptionVersions.UNKNOWN;
  }
  return EncryptionVersions.UNENCRYPTED;
}
async function tryDecryptV1AsFallback(encryptedData, passphrase, useDynamicIterationCount) {
  try {
    return await decrypt2(encryptedData, passphrase, useDynamicIterationCount);
  } catch (ex) {
    try {
      (0, logger_exports.Logger)(
        "Failed to decrypt with V1 method. Fallback to disable useDynamicIterationCount.",
        logger_exports.LOG_LEVEL_VERBOSE
      );
      (0, logger_exports.Logger)(ex, logger_exports.LOG_LEVEL_VERBOSE);
      return await decrypt2(encryptedData, passphrase, false);
    } catch (ex2) {
      (0, logger_exports.Logger)("Completely failed to decrypt with V1 method.", logger_exports.LOG_LEVEL_VERBOSE);
      (0, logger_exports.Logger)(ex2, logger_exports.LOG_LEVEL_VERBOSE);
      return false;
    }
  }
}
var ENCRYPTED_META_PREFIX = "/\\:";
function isEncryptedMeta(doc) {
  return "path" in doc && doc.path.startsWith(ENCRYPTED_META_PREFIX);
}
async function encryptMetaWithHKDF(doc, passphrase, pbkdf2Salt) {
  if (isEncryptedMeta(doc)) {
    return doc.path;
  }
  const props = {
    path: getPath(doc),
    mtime: doc.mtime,
    ctime: doc.ctime,
    size: doc.size,
    children: isMetaEntry(doc) ? doc.children : void 0
  };
  const propStr = JSON.stringify(props);
  const encryptedMeta = await encryptHKDFWorker(propStr, passphrase, pbkdf2Salt);
  return ENCRYPTED_META_PREFIX + encryptedMeta;
}
async function decryptMetaWithHKDF(meta, passphrase, pbkdf2Salt) {
  if (!meta.startsWith(ENCRYPTED_META_PREFIX)) {
    throw new Error("Meta is not encrypted with HKDF.");
  }
  const encryptedMeta = meta.slice(ENCRYPTED_META_PREFIX.length);
  const props = await decryptHKDF2(encryptedMeta, passphrase, pbkdf2Salt);
  const parsedProps = JSON.parse(props);
  return parsedProps;
}
var MESSAGE_FALLBACK_DECRYPT_FAILED = "Failed to decrypt the data with V1 method. Cannot encrypt with HKDF.";
var ENCRYPTION_HKDF_FAILED = "Encryption with HKDF failed.";
var DECRYPTION_HKDF_FAILED = "Decryption with HKDF failed.";
var DECRYPTION_FALLBACK_FAILED = "Decryption with fallback failed.";
async function incomingEncryptHKDF(doc, passphrase, useDynamicIterationCount, getPBKDF2Salt) {
  const saveDoc = {
    ...doc
  };
  if (isEncryptedChunkEntry(saveDoc) || isSyncInfoEntry(saveDoc)) {
    try {
      const encryptionVersion = getEncryptionVersion(saveDoc);
      if (encryptionVersion === EncryptionVersions.ENCRYPTED) {
        const decrypted = await tryDecryptV1AsFallback(saveDoc.data, passphrase, useDynamicIterationCount);
        if (decrypted === false) {
          (0, logger_exports.Logger)(MESSAGE_FALLBACK_DECRYPT_FAILED, logger_exports.LOG_LEVEL_NOTICE);
          throw new Error(MESSAGE_FALLBACK_DECRYPT_FAILED);
        }
        const pbkdf2salt = await getPBKDF2Salt();
        saveDoc.data = await encryptHKDF2(saveDoc.data, passphrase, pbkdf2salt);
        saveDoc.e_ = true;
      }
      if (encryptionVersion === EncryptionVersions.HKDF) {
      } else if (encryptionVersion === EncryptionVersions.UNENCRYPTED) {
        const pbkdf2salt = await getPBKDF2Salt();
        saveDoc.data = await encryptHKDF2(saveDoc.data, passphrase, pbkdf2salt);
        saveDoc.e_ = true;
      }
    } catch (ex) {
      (0, logger_exports.Logger)(ENCRYPTION_HKDF_FAILED, logger_exports.LOG_LEVEL_NOTICE);
      (0, logger_exports.Logger)(ex);
      throw ex;
    }
  }
  if (shouldEncryptEdenHKDF(saveDoc)) {
    const pbkdf2salt = await getPBKDF2Salt();
    try {
      saveDoc.eden = {
        [EDEN_ENCRYPTED_KEY_HKDF]: {
          data: await encryptHKDF2(JSON.stringify(saveDoc.eden), passphrase, pbkdf2salt),
          epoch: 999999
        }
      };
    } catch (ex) {
      (0, logger_exports.Logger)(`${ENCRYPTION_HKDF_FAILED} on Eden`, logger_exports.LOG_LEVEL_NOTICE);
      (0, logger_exports.Logger)(ex);
      throw ex;
    }
  }
  if (isObfuscatedEntry(saveDoc)) {
    const pbkdf2salt = await getPBKDF2Salt();
    if (!isEncryptedMeta(saveDoc)) {
      try {
        saveDoc.path = await encryptMetaWithHKDF(
          saveDoc,
          passphrase,
          pbkdf2salt
        );
        saveDoc.mtime = 0;
        saveDoc.ctime = 0;
        saveDoc.size = 0;
        if ("children" in saveDoc) saveDoc.children = [];
      } catch (ex) {
        (0, logger_exports.Logger)(`${ENCRYPTION_HKDF_FAILED} on Metadata`, logger_exports.LOG_LEVEL_NOTICE);
        (0, logger_exports.Logger)(ex);
        throw ex;
      }
    }
  }
  return saveDoc;
}
async function outgoingDecryptHKDF(doc, migrationDecrypt, decrypted, passphrase, useDynamicIterationCount, getPBKDF2Salt) {
  const loadDoc = {
    ...doc
  };
  if (isEncryptedChunkEntry(loadDoc) || isSyncInfoEntry(loadDoc)) {
    try {
      const encryptionVersion = getEncryptionVersion(loadDoc);
      if (encryptionVersion === EncryptionVersions.HKDF) {
        const pbkdf2salt = await getPBKDF2Salt();
        loadDoc.data = await decryptHKDF2(loadDoc.data, passphrase, pbkdf2salt);
        delete loadDoc.e_;
      } else if (encryptionVersion === EncryptionVersions.ENCRYPTED) {
        const decryptedData = await tryDecryptV1AsFallback(loadDoc.data, passphrase, useDynamicIterationCount);
        if (decryptedData === false) {
          (0, logger_exports.Logger)(MESSAGE_FALLBACK_DECRYPT_FAILED, logger_exports.LOG_LEVEL_NOTICE);
          throw new Error(MESSAGE_FALLBACK_DECRYPT_FAILED);
        }
        loadDoc.data = decryptedData;
        delete loadDoc.e_;
      } else if (encryptionVersion === EncryptionVersions.UNENCRYPTED) {
      } else {
        (0, logger_exports.Logger)("Unknown encryption version. Cannot decrypt.", logger_exports.LOG_LEVEL_NOTICE);
        throw new Error("Unknown encryption version. Cannot decrypt.");
      }
    } catch (ex) {
      (0, logger_exports.Logger)(DECRYPTION_HKDF_FAILED, logger_exports.LOG_LEVEL_NOTICE);
      (0, logger_exports.Logger)(ex);
      throw ex;
    }
  }
  if (isObfuscatedEntry(loadDoc)) {
    const path = getPath(loadDoc);
    if (isEncryptedMeta(loadDoc)) {
      const pbkdf2salt = await getPBKDF2Salt();
      try {
        const metadata = await decryptMetaWithHKDF(path, passphrase, pbkdf2salt);
        for (const key of Object.keys(metadata)) {
          loadDoc[key] = metadata[key];
        }
      } catch (ex) {
        (0, logger_exports.Logger)(`${DECRYPTION_HKDF_FAILED} on Path`, logger_exports.LOG_LEVEL_NOTICE);
        (0, logger_exports.Logger)(ex);
        throw ex;
      }
    } else if ((0, e2ee_v2_exports.isPathProbablyObfuscated)(path)) {
      const decryptedPath = await tryDecryptV1AsFallback(path, passphrase, useDynamicIterationCount);
      if (decryptedPath === false) {
        (0, logger_exports.Logger)(`${MESSAGE_FALLBACK_DECRYPT_FAILED} on Path`, logger_exports.LOG_LEVEL_NOTICE);
        throw new Error(MESSAGE_FALLBACK_DECRYPT_FAILED);
      }
      loadDoc.path = decryptedPath;
    }
  }
  let readEden = {};
  let edenDecrypted = false;
  if (shouldDecryptEden(loadDoc)) {
    try {
      const decryptedEden = await tryDecryptV1AsFallback(
        loadDoc.eden[EDEN_ENCRYPTED_KEY].data,
        passphrase,
        useDynamicIterationCount
      );
      if (decryptedEden === false) throw new Error(MESSAGE_FALLBACK_DECRYPT_FAILED);
      readEden = {
        ...readEden,
        ...JSON.parse(decryptedEden)
      };
      edenDecrypted = true;
    } catch (ex) {
      (0, logger_exports.Logger)(`${DECRYPTION_FALLBACK_FAILED} on Eden`, logger_exports.LOG_LEVEL_NOTICE);
      (0, logger_exports.Logger)(ex);
      throw ex;
    }
  }
  if (shouldDecryptEdenHKDF(loadDoc)) {
    const pbkdf2salt = await getPBKDF2Salt();
    try {
      const decryptedEdenData = await decryptHKDF2(
        loadDoc.eden[EDEN_ENCRYPTED_KEY_HKDF].data,
        passphrase,
        pbkdf2salt
      );
      readEden = {
        ...readEden,
        ...JSON.parse(decryptedEdenData)
      };
      edenDecrypted = true;
    } catch (ex) {
      (0, logger_exports.Logger)(`${DECRYPTION_HKDF_FAILED} on Eden`, logger_exports.LOG_LEVEL_NOTICE);
      (0, logger_exports.Logger)(ex);
      throw ex;
    }
  }
  if (edenDecrypted) {
    loadDoc.eden = readEden;
  } else {
  }
  return loadDoc;
}
async function incomingEncryptV1(doc, passphrase, useDynamicIterationCount) {
  const saveDoc = {
    ...doc
  };
  if (isEncryptedChunkEntry(saveDoc) || isSyncInfoEntry(saveDoc)) {
    try {
      if (!("e_" in saveDoc)) {
        saveDoc.data = await encrypt2(saveDoc.data, passphrase, useDynamicIterationCount);
        saveDoc.e_ = true;
      }
    } catch (ex) {
      (0, logger_exports.Logger)("Encryption failed.", logger_exports.LOG_LEVEL_NOTICE);
      (0, logger_exports.Logger)(ex);
      throw ex;
    }
  }
  if (shouldEncryptEden(saveDoc)) {
    saveDoc.eden = {
      [EDEN_ENCRYPTED_KEY]: {
        data: await encrypt2(JSON.stringify(saveDoc.eden), passphrase, useDynamicIterationCount),
        epoch: 999999
      }
    };
  }
  if (isObfuscatedEntry(saveDoc)) {
    try {
      const path = getPath(saveDoc);
      if (!(0, e2ee_v2_exports.isPathProbablyObfuscated)(path)) {
        saveDoc.path = await (0, e2ee_v2_exports.obfuscatePath)(
          path,
          passphrase,
          useDynamicIterationCount
        );
      }
    } catch (ex) {
      (0, logger_exports.Logger)("Encryption failed.", logger_exports.LOG_LEVEL_NOTICE);
      (0, logger_exports.Logger)(ex);
      throw ex;
    }
  }
  return saveDoc;
}
async function outgoingDecryptV1(doc, migrationDecrypt, decrypted, passphrase, useDynamicIterationCount) {
  const loadDoc = {
    ...doc
  };
  const _isChunkOrSyncInfo = isEncryptedChunkEntry(loadDoc) || isSyncInfoEntry(loadDoc);
  const _isObfuscatedEntry = isObfuscatedEntry(loadDoc);
  const _shouldDecryptEden = shouldDecryptEden(loadDoc);
  if (_isChunkOrSyncInfo || _isObfuscatedEntry || _shouldDecryptEden) {
    if (migrationDecrypt && decrypted.has(loadDoc._id)) {
      return loadDoc;
    }
    try {
      if (_isChunkOrSyncInfo) {
        loadDoc.data = await decrypt2(loadDoc.data, passphrase, useDynamicIterationCount);
        delete loadDoc.e_;
      } else if ("e_" in loadDoc) {
        loadDoc.data = await decrypt2(loadDoc.data, passphrase, useDynamicIterationCount);
        delete loadDoc.e_;
      }
      if (_isObfuscatedEntry) {
        const path = getPath(loadDoc);
        if ((0, e2ee_v2_exports.isPathProbablyObfuscated)(path)) {
          loadDoc.path = await decrypt2(
            path,
            passphrase,
            useDynamicIterationCount
          );
        }
      }
      if (_shouldDecryptEden) {
        loadDoc.eden = JSON.parse(
          await decrypt2(loadDoc.eden[EDEN_ENCRYPTED_KEY].data, passphrase, useDynamicIterationCount)
        );
      }
      if (migrationDecrypt) {
        decrypted.set(loadDoc._id, true);
      }
    } catch (ex) {
      if (useDynamicIterationCount) {
        try {
          if (_isChunkOrSyncInfo) {
            loadDoc.data = await decrypt2(loadDoc.data, passphrase, false);
          }
          if (_isObfuscatedEntry) {
            const path = getPath(loadDoc);
            if ((0, e2ee_v2_exports.isPathProbablyObfuscated)(path)) {
              loadDoc.path = await decrypt2(path, passphrase, false);
            }
          }
          if (_shouldDecryptEden) {
            loadDoc.eden = JSON.parse(
              await decrypt2(loadDoc.eden[EDEN_ENCRYPTED_KEY].data, passphrase, false)
            );
          }
          if (migrationDecrypt) {
            decrypted.set(loadDoc._id, true);
          }
        } catch (ex2) {
          if (migrationDecrypt && ex2.name == "SyntaxError") {
            return loadDoc;
          }
          (0, logger_exports.Logger)("Decryption failed.", logger_exports.LOG_LEVEL_NOTICE);
          (0, logger_exports.Logger)(ex2, logger_exports.LOG_LEVEL_VERBOSE);
          (0, logger_exports.Logger)(`id:${loadDoc._id}-${loadDoc._rev?.substring(0, 10)}`, logger_exports.LOG_LEVEL_VERBOSE);
          throw ex2;
        }
      } else {
        (0, logger_exports.Logger)("Decryption failed.", logger_exports.LOG_LEVEL_NOTICE);
        (0, logger_exports.Logger)(ex, logger_exports.LOG_LEVEL_VERBOSE);
        (0, logger_exports.Logger)(`id:${loadDoc._id}-${loadDoc._rev?.substring(0, 10)}`, logger_exports.LOG_LEVEL_VERBOSE);
        throw ex;
      }
    }
  }
  return loadDoc;
}
var preprocessOutgoing = async (doc) => {
  return await Promise.resolve(doc);
};
var preprocessIncoming = async (doc) => {
  return await Promise.resolve(doc);
};
var enableEncryption = (db, passphrase, useDynamicIterationCount, migrationDecrypt, getPBKDF2Salt, algorithm) => {
  const decrypted = /* @__PURE__ */ new Map();
  const incoming = (doc) => algorithm === E2EEAlgorithms.V2 ? incomingEncryptHKDF(doc, passphrase, useDynamicIterationCount, getPBKDF2Salt) : incomingEncryptV1(doc, passphrase, useDynamicIterationCount);
  const outgoing = (doc) => algorithm !== E2EEAlgorithms.ForceV1 ? outgoingDecryptHKDF(doc, migrationDecrypt, decrypted, passphrase, useDynamicIterationCount, getPBKDF2Salt) : outgoingDecryptV1(doc, migrationDecrypt, decrypted, passphrase, useDynamicIterationCount);
  preprocessOutgoing = incoming;
  preprocessIncoming = outgoing;
  db.transform({
    incoming,
    outgoing
  });
};
function disableEncryption() {
  preprocessOutgoing = async (doc) => {
    return await Promise.resolve(doc);
  };
  preprocessIncoming = async (doc) => {
    return await Promise.resolve(doc);
  };
}
var EDEN_ENCRYPTED_KEY = "h:++encrypted";
var EDEN_ENCRYPTED_KEY_HKDF = "h:++encrypted-hkdf";
function shouldEncryptEden(doc) {
  if ("eden" in doc && !(EDEN_ENCRYPTED_KEY in doc.eden)) {
    return true;
  }
  return false;
}
function shouldEncryptEdenHKDF(doc) {
  if ("eden" in doc && !(EDEN_ENCRYPTED_KEY_HKDF in doc.eden)) {
    if (Object.keys(doc.eden).length === 0) {
      return false;
    }
    return true;
  }
  return false;
}
function shouldDecryptEden(doc) {
  if ("eden" in doc && EDEN_ENCRYPTED_KEY in doc.eden) {
    return true;
  }
  return false;
}
function shouldDecryptEdenHKDF(doc) {
  if ("eden" in doc && EDEN_ENCRYPTED_KEY_HKDF in doc.eden) {
    return true;
  }
  return false;
}

// upstream/src/API/DirectFileManipulatorV2.ts
import {
  LEVEL_INFO,
  LEVEL_VERBOSE,
  LOG_LEVEL_INFO as LOG_LEVEL_INFO4,
  LOG_LEVEL_NOTICE as LOG_LEVEL_NOTICE4,
  LOG_LEVEL_VERBOSE as LOG_LEVEL_VERBOSE10,
  Logger as Logger10
} from "octagonal-wheels/common/logger";
import { promiseWithResolver as promiseWithResolver2 } from "octagonal-wheels/promises";

// upstream/src/replication/SyncParamsHandler.ts
import { createPBKDF2Salt } from "octagonal-wheels/encryption/hkdf";
var _handlers = /* @__PURE__ */ new Map();
function createSyncParamsHanderForServer(key, options) {
  if (_handlers.has(key)) {
    return _handlers.get(key);
  }
  const handler = createSyncParamsHandler(options);
  _handlers.set(key, handler);
  return handler;
}
var SyncParamsHandlerError = class extends LiveSyncError {
};
var SyncParamsFetchError = class extends SyncParamsHandlerError {
};
var SyncParamsNotFoundError = class extends SyncParamsHandlerError {
};
var SyncParamsUpdateError = class extends SyncParamsHandlerError {
};
function createSyncParamsHandler({ put, get, create }) {
  let taskFetchParameters = void 0;
  const _fetchSyncParameters = async () => {
    let syncParams = void 0;
    try {
      let shouldRetry = false;
      do {
        shouldRetry = false;
        try {
          syncParams = await get();
          (0, logger_exports.Logger)(`Fetched synchronisation parameters`, logger_exports.LOG_LEVEL_INFO);
        } catch (ex) {
          if (LiveSyncError.isCausedBy(ex, SyncParamsNotFoundError)) {
            (0, logger_exports.Logger)(`Synchronisation parameters not found, creating new ones`, logger_exports.LOG_LEVEL_INFO);
            const newSyncParams = await create();
            const putResult = await put(newSyncParams);
            if (!putResult) {
              (0, logger_exports.Logger)(`Failed to store initial synchronisation parameters`, logger_exports.LOG_LEVEL_INFO);
              throw new SyncParamsUpdateError(`Failed to store initial synchronisation parameters`);
            }
            (0, logger_exports.Logger)(
              `Initial synchronisation parameters stored successfully, retrying fetch`,
              logger_exports.LOG_LEVEL_INFO
            );
            shouldRetry = true;
          } else {
            throw ex;
          }
        }
      } while (shouldRetry);
      if (!syncParams) {
        throw new SyncParamsFetchError(`Unexpected empty synchronisation parameters`);
      }
      if (!syncParams.pbkdf2salt) {
        (0, logger_exports.Logger)(`Synchronisation parameters do not have PBKDF2 salt, generating a new salt`, logger_exports.LOG_LEVEL_INFO);
        const salt = await arrayBufferToBase64Single(createPBKDF2Salt());
        if (!salt) {
          (0, logger_exports.Logger)(`Failed to generate PBKDF2 salt`, logger_exports.LOG_LEVEL_INFO);
          throw new SyncParamsFetchError(`Failed to generate PBKDF2 salt`);
        }
        syncParams.pbkdf2salt = salt;
        const putResult = await put(syncParams);
        if (!putResult) {
          (0, logger_exports.Logger)(`Failed to store synchronisation parameters with new PBKDF2 salt`, logger_exports.LOG_LEVEL_INFO);
          throw new SyncParamsUpdateError(`Failed to store synchronisation parameters with new PBKDF2 salt`);
        }
        syncParams = await get();
      }
      if (!syncParams) {
        throw new Error(`Failed to prepare synchronisation key in synchronisation parameters`);
      }
      (0, logger_exports.Logger)(`Synchronisation parameters fetched successfully`, logger_exports.LOG_LEVEL_INFO);
      if (!syncParams.pbkdf2saltDecoded) {
        const decodedSalt = new Uint8Array(base64ToArrayBufferInternalBrowser(syncParams.pbkdf2salt));
        if (!decodedSalt) {
          throw new SyncParamsFetchError(`Failed to decode PBKDF2 salt`);
        }
        syncParams.pbkdf2saltDecoded = decodedSalt;
      }
      return syncParams;
    } catch (ex) {
      (0, logger_exports.Logger)(`Failed to fetch synchronisation parameters`, logger_exports.LOG_LEVEL_INFO);
      (0, logger_exports.Logger)(ex, logger_exports.LOG_LEVEL_VERBOSE);
      taskFetchParameters = void 0;
      return false;
    }
  };
  const fetchSyncParameters = (refresh = false) => {
    if (taskFetchParameters && !refresh) {
      return taskFetchParameters;
    }
    taskFetchParameters = _fetchSyncParameters();
    return taskFetchParameters;
  };
  return {
    fetch: fetchSyncParameters,
    getPBKDF2Salt: async (refresh = false) => {
      const syncParams = await fetchSyncParameters(refresh);
      if (!syncParams) {
        (0, logger_exports.Logger)(`Failed to fetch synchronisation parameters`, logger_exports.LOG_LEVEL_INFO);
        throw new SyncParamsFetchError(`Failed to fetch synchronisation parameters`);
      }
      return syncParams.pbkdf2saltDecoded;
    }
  };
}

// upstream/src/ContentSplitter/ContentSplitter.ts
var MAX_CHUNKS_SIZE_ON_UI = 1024;

// upstream/src/ContentSplitter/ContentSplitterBase.ts
var ContentSplitterCore = class {
  /**
   * Options for the content splitter.
   * These settings include the chunk splitter version and other configurations.
   */
  options;
  /**
   * Task for initialising the content splitter.
   * This ensures that the splitter is initialised before any operations are performed.
   */
  initialised;
  /**
   * Constructor for the content splitter core.
   * @param params Content splitter options
   */
  constructor(params) {
    this.options = params;
    this.initialised = this.initialise(params);
  }
};
var ContentSplitterBase = class extends ContentSplitterCore {
  initialise(_options) {
    return Promise.resolve(true);
  }
  /**
   * Check whether the content splitter is available for the given settings.
   * @param setting Content splitter options
   * @returns True if the content splitter is available; false otherwise
   */
  static isAvailableFor(setting) {
    return false;
  }
  getParamsFor(entry) {
    const maxChunkSize = Math.floor(MAX_DOC_SIZE_BIN * ((this.options.settings.customChunkSize || 0) * 1 + 1));
    const pieceSize = maxChunkSize;
    const minimumChunkSize = this.options.settings.minimumChunkSize;
    const path = entry.path;
    const plainSplit = shouldSplitAsPlainText(path);
    const maxSize = MAX_CHUNKS_SIZE_ON_UI;
    const blob = entry.data instanceof Blob ? entry.data : createTextBlob(entry.data);
    let useWorker = true;
    if (this.options.settings.disableWorkerForGeneratingChunks) {
      useWorker = false;
    }
    if (useWorker && this.options.settings.processSmallFilesInUIThread) {
      if (blob.size <= maxSize) {
        useWorker = false;
      }
    }
    const useSegmenter = this.options.settings.chunkSplitterVersion === ChunkAlgorithms.V2Segmenter;
    return {
      blob,
      path,
      pieceSize,
      plainSplit,
      minimumChunkSize,
      useWorker,
      useSegmenter
    };
  }
  /**
   * Split the content of the loaded entry into chunks.
   * This method waits for the initialisation task to complete before proceeding.
   * @param entry The loaded entry to be split into chunks
   * @returns A generator that yields the split chunks
   */
  async splitContent(entry) {
    await this.initialised;
    const options = this.getParamsFor(entry);
    const generator = await this.processSplit(options);
    return generator;
  }
};

// upstream/src/ContentSplitter/ContentSplitterRabinKarp.ts
var ContentSplitterRabinKarp = class extends ContentSplitterBase {
  static isAvailableFor(setting) {
    return setting.settings.chunkSplitterVersion === ChunkAlgorithms.RabinKarp;
  }
  async processSplit(options) {
    if (options.useWorker) {
      return splitPieces2WorkerRabinKarp(
        options.blob,
        options.pieceSize,
        options.plainSplit,
        options.minimumChunkSize,
        options.path
      )();
    } else {
      return (await splitPiecesRabinKarp(
        options.blob,
        options.pieceSize,
        options.plainSplit,
        options.minimumChunkSize,
        options.path
      ))();
    }
  }
};

// upstream/src/ContentSplitter/ContentSplitterV1.ts
var ContentSplitterV1 = class extends ContentSplitterBase {
  static isAvailableFor(setting) {
    return setting.settings.chunkSplitterVersion === ChunkAlgorithms.V1 || setting.settings.chunkSplitterVersion === "";
  }
  async processSplit(options) {
    if (options.useWorker) {
      return splitPieces2Worker(
        options.blob,
        options.pieceSize,
        options.plainSplit,
        options.minimumChunkSize,
        options.path,
        options.useSegmenter
      )();
    } else {
      return (await splitPieces2(
        options.blob,
        options.pieceSize,
        options.plainSplit,
        options.minimumChunkSize,
        options.path,
        options.useSegmenter
      ))();
    }
  }
};

// upstream/src/ContentSplitter/ContentSplitterV2.ts
var ContentSplitterV2 = class extends ContentSplitterBase {
  static isAvailableFor(setting) {
    return setting.settings.chunkSplitterVersion === ChunkAlgorithms.V2 || setting.settings.chunkSplitterVersion === ChunkAlgorithms.V2Segmenter;
  }
  async processSplit(options) {
    if (options.useWorker) {
      return splitPieces2WorkerV2(
        options.blob,
        options.pieceSize,
        options.plainSplit,
        options.minimumChunkSize,
        options.path,
        options.useSegmenter
      )();
    } else {
      return (await splitPieces2V2(
        options.blob,
        options.pieceSize,
        options.plainSplit,
        options.minimumChunkSize,
        options.path,
        options.useSegmenter
      ))();
    }
  }
};

// upstream/src/ContentSplitter/ContentSplitters.ts
var ContentSplitters = [ContentSplitterV1, ContentSplitterV2, ContentSplitterRabinKarp];
var ContentSplitter = class extends ContentSplitterCore {
  _activeSplitter;
  constructor(options) {
    super(options);
  }
  initialise(options) {
    for (const Splitter of ContentSplitters) {
      if (Splitter.isAvailableFor(options)) {
        this._activeSplitter = new Splitter(options);
        break;
      }
    }
    if (!this._activeSplitter) {
      throw new Error(`ContentSplitter: No available splitter for settings!!`);
    }
    return this._activeSplitter.initialise(options);
  }
  async splitContent(entry) {
    await this.initialised;
    return this._activeSplitter.splitContent(entry);
  }
};

// upstream/src/managers/ChangeManager.ts
import { FallbackWeakRef as FallbackWeakRef3 } from "octagonal-wheels/common/polyfill";
var ChangeManager = class {
  /**
   * The PouchDB database instance being monitored.
   */
  _database;
  /**
   * Creates a new instance of the ChangeManager.
   *
   * @param options - Configuration options for the ChangeManager.
   */
  constructor(options) {
    this._database = options.database;
    this.setupListener();
  }
  /**
   * A list of registered callbacks wrapped in WeakRefs to avoid memory leaks.
   */
  _callbacks = [];
  /**
   * Registers a new callback to be invoked when a change occurs.
   *
   * @param callback - The callback function to register.
   */
  addCallback(callback) {
    const callbackHandler = new FallbackWeakRef3(callback);
    this._callbacks.push(callbackHandler);
    return () => {
      this._callbacks = this._callbacks.filter((cb) => cb !== callbackHandler);
    };
  }
  removeCallback(callback) {
    this._callbacks = this._callbacks.filter((cb) => cb.deref() !== callback);
  }
  /**
   * The PouchDB changes feed instance, if active.
   */
  _changes;
  /**
   * Handles a change event from the PouchDB changes feed.
   *
   * @param changeResponse - The change response object from the PouchDB changes feed.
   */
  _onChange(changeResponse) {
    if (!this._callbacks.length) {
      return;
    }
    this._callbacks = this._callbacks.filter((callback) => callback.deref() !== void 0);
    for (const callback of this._callbacks) {
      const cb = callback.deref();
      if (!cb) {
        continue;
      }
      void cb(changeResponse);
    }
  }
  /**
   * Sets up the PouchDB changes feed listener to monitor for database changes.
   */
  setupListener() {
    if (this._changes) {
      void this._changes?.removeAllListeners();
      this._changes?.cancel();
      this._changes = void 0;
    }
    const changes = this._database.changes({
      since: "now",
      live: true,
      include_docs: true
    });
    void changes.on("change", (change) => {
      void this._onChange(change);
    });
    void changes.on("error", (err) => {
      (0, logger_exports.Logger)("ChangeManager Error watching changes");
      (0, logger_exports.Logger)(err, logger_exports.LOG_LEVEL_VERBOSE);
    });
    this._changes = changes;
  }
  /**
   * Tears down the PouchDB changes feed listener and cleans up resources.
   */
  teardown() {
    void this._changes?.removeAllListeners();
    this._changes?.cancel();
    this._changes = void 0;
  }
  /**
   * Restarts the PouchDB changes feed listener.
   */
  restartWatch() {
    void this.teardown();
    void this.setupListener();
  }
};

// upstream/src/managers/ConflictManager.ts
import { diff_match_patch, DIFF_DELETE, DIFF_INSERT, DIFF_EQUAL } from "diff-match-patch";
import { readString as readString2, decodeBinary as decodeBinary2 } from "octagonal-wheels/binary";
import { Logger as Logger7, LOG_LEVEL_VERBOSE as LOG_LEVEL_VERBOSE7, LOG_LEVEL_INFO as LOG_LEVEL_INFO3 } from "octagonal-wheels/common/logger";
var ConflictManager = class {
  options;
  constructor(options) {
    this.options = options;
  }
  get database() {
    return this.options.database;
  }
  async getConflictedDoc(path, rev) {
    try {
      const doc = await this.options.entryManager.getDBEntry(path, { rev }, false, true, true);
      if (doc === false) return false;
      let data = getDocData(doc.data);
      if (doc.datatype == "newnote") {
        data = readString2(new Uint8Array(decodeBinary2(doc.data)));
      } else if (doc.datatype == "plain") {
      }
      return {
        deleted: doc.deleted || doc._deleted,
        ctime: doc.ctime,
        mtime: doc.mtime,
        rev,
        data
      };
    } catch (ex) {
      if (isErrorOfMissingDoc(ex)) {
        return false;
      }
    }
    return false;
  }
  async mergeSensibly(path, baseRev, currentRev, conflictedRev) {
    const baseLeaf = await this.getConflictedDoc(path, baseRev);
    const leftLeaf = await this.getConflictedDoc(path, currentRev);
    const rightLeaf = await this.getConflictedDoc(path, conflictedRev);
    let autoMerge = false;
    if (baseLeaf == false || leftLeaf == false || rightLeaf == false) {
      return false;
    }
    if (leftLeaf.deleted && rightLeaf.deleted) {
      return false;
    }
    const dmp = new diff_match_patch();
    const mapLeft = dmp.diff_linesToChars_(baseLeaf.data, leftLeaf.data);
    const diffLeftSrc = dmp.diff_main(mapLeft.chars1, mapLeft.chars2, false);
    dmp.diff_charsToLines_(diffLeftSrc, mapLeft.lineArray);
    const mapRight = dmp.diff_linesToChars_(baseLeaf.data, rightLeaf.data);
    const diffRightSrc = dmp.diff_main(mapRight.chars1, mapRight.chars2, false);
    dmp.diff_charsToLines_(diffRightSrc, mapRight.lineArray);
    function splitDiffPiece(src) {
      const ret = [];
      do {
        const d = src.shift();
        if (d === void 0) {
          return ret;
        }
        const pieces = d[1].split(/([^\n]*\n)/).filter((f) => f != "");
        if (typeof d == "undefined") {
          break;
        }
        if (d[0] != DIFF_DELETE) {
          ret.push(...pieces.map((e) => [d[0], e]));
        }
        if (d[0] == DIFF_DELETE) {
          const nd = src.shift();
          if (typeof nd != "undefined") {
            const piecesPair = nd[1].split(/([^\n]*\n)/).filter((f) => f != "");
            if (nd[0] == DIFF_INSERT) {
              for (const pt of pieces) {
                ret.push([d[0], pt]);
                const pairP = piecesPair.shift();
                if (typeof pairP != "undefined") ret.push([DIFF_INSERT, pairP]);
              }
              ret.push(...piecesPair.map((e) => [nd[0], e]));
            } else {
              ret.push(...pieces.map((e) => [d[0], e]));
              ret.push(...piecesPair.map((e) => [nd[0], e]));
            }
          } else {
            ret.push(...pieces.map((e) => [0, e]));
          }
        }
      } while (src.length > 0);
      return ret;
    }
    const diffLeft = splitDiffPiece(diffLeftSrc);
    const diffRight = splitDiffPiece(diffRightSrc);
    let rightIdx = 0;
    let leftIdx = 0;
    const merged = [];
    autoMerge = true;
    LOOP_MERGE: do {
      if (leftIdx >= diffLeft.length && rightIdx >= diffRight.length) {
        break LOOP_MERGE;
      }
      const leftItem = diffLeft[leftIdx] ?? [0, ""];
      const rightItem = diffRight[rightIdx] ?? [0, ""];
      leftIdx++;
      rightIdx++;
      if (leftItem[0] == DIFF_EQUAL && rightItem[0] == DIFF_EQUAL && leftItem[1] == rightItem[1]) {
        merged.push(leftItem);
        continue;
      }
      if (leftItem[0] == DIFF_DELETE && rightItem[0] == DIFF_DELETE && leftItem[1] == rightItem[1]) {
        const nextLeftIdx = leftIdx;
        const nextRightIdx = rightIdx;
        const [nextLeftItem, nextRightItem] = [
          diffLeft[nextLeftIdx] ?? [0, ""],
          diffRight[nextRightIdx] ?? [0, ""]
        ];
        if (nextLeftItem[0] == DIFF_INSERT && nextRightItem[0] == DIFF_INSERT && nextLeftItem[1] != nextRightItem[1]) {
          autoMerge = false;
          break;
        } else {
          merged.push(leftItem);
          continue;
        }
      }
      if (leftItem[0] == DIFF_INSERT && rightItem[0] == DIFF_INSERT) {
        if (leftItem[1] == rightItem[1]) {
          merged.push(leftItem);
          continue;
        } else {
          if (leftLeaf.mtime <= rightLeaf.mtime) {
            merged.push(leftItem);
            merged.push(rightItem);
            continue;
          } else {
            merged.push(rightItem);
            merged.push(leftItem);
            continue;
          }
        }
      }
      if (leftItem[0] == DIFF_INSERT) {
        rightIdx--;
        merged.push(leftItem);
        continue;
      }
      if (rightItem[0] == DIFF_INSERT) {
        leftIdx--;
        merged.push(rightItem);
        continue;
      }
      if (rightItem[1] != leftItem[1]) {
        Logger7(
          `MERGING PANIC:${leftItem[0]},${leftItem[1]} == ${rightItem[0]},${rightItem[1]}`,
          LOG_LEVEL_VERBOSE7
        );
        autoMerge = false;
        break LOOP_MERGE;
      }
      if (leftItem[0] == DIFF_DELETE) {
        if (rightItem[0] == DIFF_EQUAL) {
          merged.push(leftItem);
          continue;
        } else {
          autoMerge = false;
          break LOOP_MERGE;
        }
      }
      if (rightItem[0] == DIFF_DELETE) {
        if (leftItem[0] == DIFF_EQUAL) {
          merged.push(rightItem);
          continue;
        } else {
          autoMerge = false;
          break LOOP_MERGE;
        }
      }
      Logger7(
        `Weird condition:${leftItem[0]},${leftItem[1]} == ${rightItem[0]},${rightItem[1]}`,
        LOG_LEVEL_VERBOSE7
      );
      break LOOP_MERGE;
    } while (leftIdx < diffLeft.length || rightIdx < diffRight.length);
    if (autoMerge) {
      Logger7(`Sensibly merge available`, LOG_LEVEL_VERBOSE7);
      return merged;
    } else {
      return false;
    }
  }
  async mergeObject(path, baseRev, currentRev, conflictedRev) {
    try {
      const baseLeaf = await this.getConflictedDoc(path, baseRev);
      const leftLeaf = await this.getConflictedDoc(path, currentRev);
      const rightLeaf = await this.getConflictedDoc(path, conflictedRev);
      if (baseLeaf == false || leftLeaf == false || rightLeaf == false) {
        Logger7(`Could not load leafs for merge`, LOG_LEVEL_VERBOSE7);
        Logger7(
          `${baseLeaf ? "base" : "missing base"}, ${leftLeaf ? "left" : "missing left"}, ${rightLeaf ? "right" : "missing right"} }`,
          LOG_LEVEL_VERBOSE7
        );
        return false;
      }
      if (leftLeaf.deleted && rightLeaf.deleted) {
        Logger7(`Both are deleted`, LOG_LEVEL_VERBOSE7);
        return false;
      }
      const baseObj = { data: tryParseJSON(baseLeaf.data, {}) };
      const leftObj = { data: tryParseJSON(leftLeaf.data, {}) };
      const rightObj = { data: tryParseJSON(rightLeaf.data, {}) };
      const diffLeft = generatePatchObj(baseObj, leftObj);
      const diffRight = generatePatchObj(baseObj, rightObj);
      const diffSetLeft = new Map(flattenObject(diffLeft));
      const diffSetRight = new Map(flattenObject(diffRight));
      for (const [key, value] of diffSetLeft) {
        if (diffSetRight.has(key)) {
          if (diffSetRight.get(key) == value) {
            diffSetRight.delete(key);
          }
        }
      }
      for (const [key, value] of diffSetRight) {
        if (diffSetLeft.has(key) && diffSetLeft.get(key) != value) {
          Logger7(`Conflicted key:${key}`, LOG_LEVEL_VERBOSE7);
          return false;
        }
      }
      const patches = [
        { mtime: leftLeaf.mtime, patch: diffLeft },
        { mtime: rightLeaf.mtime, patch: diffRight }
      ].sort((a, b) => a.mtime - b.mtime);
      let newObj = { ...baseObj };
      for (const patch of patches) {
        newObj = applyPatch(newObj, patch.patch);
      }
      Logger7(`Object merge is applicable!`, LOG_LEVEL_VERBOSE7);
      return JSON.stringify(newObj.data);
    } catch (ex) {
      Logger7("Could not merge object");
      Logger7(ex, LOG_LEVEL_VERBOSE7);
      return false;
    }
  }
  async tryAutoMergeSensibly(path, test, conflicts) {
    const conflictedRev = conflicts[0];
    const conflictedRevNo = Number(conflictedRev.split("-")[0]);
    const revFrom = await this.database.get(await this.options.entryManager.path2id(path), {
      revs_info: true
    });
    const commonBase = (revFrom._revs_info || []).filter(
      (e) => e.status == "available" && Number(e.rev.split("-")[0]) < conflictedRevNo
    )?.[0]?.rev ?? "";
    let p = void 0;
    if (commonBase) {
      if (isSensibleMargeApplicable(path)) {
        const result = await this.mergeSensibly(path, commonBase, test._rev, conflictedRev);
        if (result) {
          p = result.filter((e) => e[0] != DIFF_DELETE).map((e) => e[1]).join("");
          Logger7(`Sensible merge:${path}`, LOG_LEVEL_INFO3);
        } else {
          Logger7(`Sensible merge is not applicable.`, LOG_LEVEL_VERBOSE7);
        }
      } else if (isObjectMargeApplicable(path)) {
        const result = await this.mergeObject(path, commonBase, test._rev, conflictedRev);
        if (result) {
          Logger7(`Object merge:${path}`, LOG_LEVEL_INFO3);
          p = result;
        } else {
          Logger7(`Object merge is not applicable..`, LOG_LEVEL_VERBOSE7);
        }
      }
      if (p !== void 0) {
        return { result: p, conflictedRev };
      }
    }
    return false;
  }
  async tryAutoMerge(path, enableMarkdownAutoMerge) {
    const test = await this.options.entryManager.getDBEntry(
      path,
      { conflicts: true, revs_info: true },
      false,
      false,
      true
    );
    if (test === false) return { ok: MISSING_OR_ERROR };
    if (test == null) return { ok: MISSING_OR_ERROR };
    if (!test._conflicts) return { ok: NOT_CONFLICTED };
    if (test._conflicts.length == 0) return { ok: NOT_CONFLICTED };
    const conflicts = test._conflicts.sort((a, b) => Number(a.split("-")[0]) - Number(b.split("-")[0]));
    if ((isSensibleMargeApplicable(path) || isObjectMargeApplicable(path)) && enableMarkdownAutoMerge) {
      const autoMergeResult = await this.tryAutoMergeSensibly(path, test, conflicts);
      if (autoMergeResult !== false) {
        return autoMergeResult;
      }
    }
    const leftLeaf = await this.getConflictedDoc(path, test._rev);
    const rightLeaf = await this.getConflictedDoc(path, conflicts[0]);
    return { leftRev: test._rev, rightRev: conflicts[0], leftLeaf, rightLeaf };
  }
};

// upstream/src/managers/EntryManager/EntryManager.ts
import { Logger as Logger8, LOG_LEVEL_NOTICE as LOG_LEVEL_NOTICE3, LOG_LEVEL_VERBOSE as LOG_LEVEL_VERBOSE8 } from "octagonal-wheels/common/logger";
import { serialized } from "octagonal-wheels/concurrency/lock_v2";
var EntryManager = class {
  options;
  constructor(options) {
    this.options = options;
  }
  get localDatabase() {
    return this.options.database;
  }
  get hashManager() {
    return this.options.hashManager;
  }
  get chunkManager() {
    return this.options.chunkManager;
  }
  get chunkFetcher() {
    return this.options.chunkFetcher;
  }
  get splitter() {
    return this.options.splitter;
  }
  get settings() {
    return this.options.settings;
  }
  id2path(id, entry, stripPrefix2) {
    return this.options.$$id2path(id, entry, stripPrefix2);
  }
  async path2id(filename, prefix) {
    return await this.options.$$path2id(filename, prefix);
  }
  get isOnDemandChunkEnabled() {
    if (this.settings.remoteType !== REMOTE_COUCHDB) {
      return false;
    }
    return this.settings.readChunksOnline;
  }
  isTargetFile(filenameSrc) {
    const file = filenameSrc.startsWith("i:") ? filenameSrc.substring(2) : filenameSrc;
    if (file.startsWith("ix:")) return true;
    if (file.startsWith("ps:")) return true;
    if (file.includes(":")) {
      return false;
    }
    if (this.settings.syncOnlyRegEx) {
      const syncOnly = getFileRegExp(this.settings, "syncOnlyRegEx");
      if (syncOnly.length > 0 && !syncOnly.some((e) => e.test(file))) return false;
    }
    if (this.settings.syncIgnoreRegEx) {
      const syncIgnore = getFileRegExp(this.settings, "syncIgnoreRegEx");
      if (syncIgnore.some((e) => e.test(file))) return false;
    }
    return true;
  }
  async prepareChunk(piece) {
    const cachedChunkId = this.chunkManager.getChunkIDFromCache(piece);
    if (cachedChunkId !== false) {
      return { isNew: false, id: cachedChunkId, piece };
    }
    const chunkId = await this.hashManager.computeHash(piece);
    return { isNew: true, id: `${IDPrefixes.Chunk}${chunkId}`, piece };
  }
  async getDBEntryMeta(path, opt, includeDeleted = false) {
    if (!this.isTargetFile(path)) {
      return false;
    }
    const id = await this.path2id(path);
    try {
      let obj = null;
      if (opt) {
        obj = await this.localDatabase.get(id, opt);
      } else {
        obj = await this.localDatabase.get(id);
      }
      const deleted = obj?.deleted ?? obj._deleted ?? void 0;
      if (!includeDeleted && deleted) return false;
      if (obj.type && obj.type == "leaf") {
        return false;
      }
      if (!obj.type || obj.type && obj.type == "notes" || obj.type == "newnote" || obj.type == "plain") {
        const note = obj;
        let children = [];
        let type = "plain";
        if (obj.type == "newnote" || obj.type == "plain") {
          children = obj.children;
          type = obj.type;
        }
        const doc = {
          data: "",
          _id: note._id,
          path,
          ctime: note.ctime,
          mtime: note.mtime,
          size: note.size,
          // _deleted: obj._deleted,
          _rev: obj._rev,
          _conflicts: obj._conflicts,
          children,
          datatype: type,
          deleted,
          type,
          eden: "eden" in obj ? obj.eden : {}
        };
        return doc;
      }
    } catch (ex) {
      if (isErrorOfMissingDoc(ex)) {
        return false;
      }
      throw ex;
    }
    return false;
  }
  async getDBEntry(path, opt, dump = false, waitForReady = true, includeDeleted = false) {
    const meta = await this.getDBEntryMeta(path, opt, includeDeleted);
    if (meta) {
      return await this.getDBEntryFromMeta(meta, dump, waitForReady);
    } else {
      return false;
    }
  }
  async getDBEntryFromMeta(meta, dump = false, waitForReady = true) {
    const filename = this.id2path(meta._id, meta);
    if (!this.isTargetFile(filename)) {
      return false;
    }
    const dispFilename = stripAllPrefixes(filename);
    const deleted = meta.deleted ?? meta._deleted ?? void 0;
    if (!meta.type || meta.type && meta.type == "notes") {
      const note = meta;
      const doc = {
        data: note.data,
        path: note.path,
        _id: note._id,
        ctime: note.ctime,
        mtime: note.mtime,
        size: note.size,
        // _deleted: obj._deleted,
        _rev: meta._rev,
        _conflicts: meta._conflicts,
        children: [],
        datatype: "newnote",
        deleted,
        type: "newnote",
        eden: "eden" in meta ? meta.eden : {}
      };
      if (dump) {
        Logger8(`--Old fashioned document--`);
        Logger8(doc);
      }
      return doc;
    }
    if (meta.type == "newnote" || meta.type == "plain") {
      if (dump) {
        const conflicts = await this.localDatabase.get(meta._id, {
          rev: meta._rev,
          conflicts: true,
          revs_info: true
        });
        Logger8("-- Conflicts --");
        Logger8(conflicts._conflicts ?? "No conflicts");
        Logger8("-- Revs info -- ");
        Logger8(conflicts._revs_info);
      }
      try {
        if (dump) {
          Logger8(`--Bare document--`);
          Logger8(meta);
        }
        let edenChunks = {};
        if (meta.eden && Object.keys(meta.eden).length > 0) {
          const chunks2 = Object.entries(meta.eden).map(([id, data]) => ({
            _id: id,
            data: data.data,
            type: "leaf"
          }));
          edenChunks = Object.fromEntries(chunks2.map((e) => [e._id, e]));
        }
        const isChunksCorrectedIncrementally = this.settings.remoteType !== RemoteTypes.REMOTE_MINIO;
        const isNetworkEnabled = this.isOnDemandChunkEnabled && this.settings.remoteType !== RemoteTypes.REMOTE_MINIO;
        const timeout = waitForReady ? isChunksCorrectedIncrementally ? LEAF_WAIT_TIMEOUT : LEAF_WAIT_TIMEOUT_SEQUENTIAL_REPLICATOR : isNetworkEnabled ? LEAF_WAIT_ONLY_REMOTE : 0;
        const childrenKeys = [...meta.children];
        const chunks = await this.chunkManager.read(
          childrenKeys,
          {
            skipCache: false,
            timeout,
            preventRemoteRequest: !isNetworkEnabled
          },
          edenChunks
        );
        if (chunks.some((e) => e === false)) {
          throw new Error("Load failed");
        }
        const doc = {
          data: chunks.map((e) => e.data),
          path: meta.path,
          _id: meta._id,
          ctime: meta.ctime,
          mtime: meta.mtime,
          size: meta.size,
          _rev: meta._rev,
          children: meta.children,
          datatype: meta.type,
          _conflicts: meta._conflicts,
          eden: meta.eden,
          deleted,
          type: meta.type
        };
        if (dump) {
          Logger8(`--Loaded Document--`);
          Logger8(doc);
        }
        return doc;
      } catch (ex) {
        if (isErrorOfMissingDoc(ex)) {
          Logger8(
            `Missing document content!, could not read ${dispFilename}(${meta._id.substring(0, 8)}) from database.`,
            LOG_LEVEL_NOTICE3
          );
          return false;
        }
        Logger8(
          `Something went wrong on reading ${dispFilename}(${meta._id.substring(0, 8)}) from database:`,
          LOG_LEVEL_NOTICE3
        );
        Logger8(ex);
      }
    }
    return false;
  }
  async deleteDBEntry(path, opt) {
    if (!this.isTargetFile(path)) {
      return false;
    }
    const id = await this.path2id(path);
    try {
      return await serialized("file:" + path, async () => {
        let obj = null;
        if (opt) {
          obj = await this.localDatabase.get(id, opt);
        } else {
          obj = await this.localDatabase.get(id);
        }
        const revDeletion = opt && ("rev" in opt ? opt.rev : "") != "";
        if (obj.type && obj.type == "leaf") {
          return false;
        }
        if (!obj.type || obj.type && obj.type == "notes") {
          obj._deleted = true;
          const r = await this.localDatabase.put(obj, { force: !revDeletion });
          Logger8(`Entry removed:${path} (${obj._id.substring(0, 8)}-${r.rev})`);
          return true;
        }
        if (obj.type == "newnote" || obj.type == "plain") {
          if (revDeletion) {
            obj._deleted = true;
          } else {
            obj.deleted = true;
            obj.mtime = Date.now();
            if (this.settings.deleteMetadataOfDeletedFiles) {
              obj._deleted = true;
            }
          }
          const r = await this.localDatabase.put(obj, { force: !revDeletion });
          Logger8(`Entry removed:${path} (${obj._id.substring(0, 8)}-${r.rev})`);
          return true;
        } else {
          return false;
        }
      }) ?? false;
    } catch (ex) {
      if (isErrorOfMissingDoc(ex)) {
        return false;
      }
      throw ex;
    }
  }
  async putDBEntry(note, onlyChunks) {
    const filename = this.id2path(note._id, note);
    const dispFilename = stripAllPrefixes(filename);
    if (!note.eden) note.eden = {};
    if (!this.isTargetFile(filename)) {
      Logger8(`File skipped:${dispFilename}`, LOG_LEVEL_VERBOSE8);
      return false;
    }
    const data = note.data instanceof Blob ? note.data : createTextBlob(note.data);
    note.data = data;
    note.type = isTextBlob(data) ? "plain" : "newnote";
    note.datatype = note.type;
    await this.splitter.initialised;
    const result = await this.chunkManager.transaction(async () => {
      let bufferedChunk = [];
      let bufferedSize = 0;
      let writeCount = 0;
      let newCount = 0;
      let cachedCount = 0;
      let resultCachedCount = 0;
      let duplicatedCount = 0;
      let totalWritingCount = 0;
      let createChunkCount = 0;
      const MAX_WRITE_SIZE = 1e3 * 1024 * 2;
      const chunks = [];
      let writeChars = 0;
      const flushBufferedChunks = async () => {
        if (bufferedChunk.length === 0) {
          Logger8(`No chunks to flush for ${dispFilename}`, LOG_LEVEL_VERBOSE8);
          return true;
        }
        const writeBuf = [...bufferedChunk];
        bufferedSize = 0;
        bufferedChunk = [];
        const result2 = await this.chunkManager.write(
          writeBuf,
          {
            skipCache: false,
            timeout: 0
          },
          note._id
        );
        if (result2.result === false) {
          Logger8(`Failed to write buffered chunks for ${dispFilename}`, LOG_LEVEL_NOTICE3);
          return false;
        }
        totalWritingCount++;
        writeCount += result2.processed.written;
        resultCachedCount += result2.processed.cached;
        duplicatedCount += result2.processed.duplicated;
        writeChars += writeBuf.map((e) => e.data.length).reduce((a, b) => a + b, 0);
        Logger8(`Flushed ${writeBuf.length} (${writeChars}) chunks for ${dispFilename}`, LOG_LEVEL_VERBOSE8);
        return true;
      };
      const flushIfNeeded = async () => {
        if (bufferedSize > MAX_WRITE_SIZE) {
          if (!await flushBufferedChunks()) {
            Logger8(`Failed to flush buffered chunks for ${dispFilename}`, LOG_LEVEL_NOTICE3);
            return false;
          }
        }
        return true;
      };
      const addBuffer = async (id, data2) => {
        const chunk = {
          _id: id,
          data: data2,
          type: "leaf"
        };
        bufferedChunk.push(chunk);
        chunks.push(chunk._id);
        bufferedSize += chunk.data.length;
        return await flushIfNeeded();
      };
      const pieces = await this.splitter.splitContent(note);
      let totalChunkCount = 0;
      try {
        for await (const piece of pieces) {
          totalChunkCount++;
          if (piece.length === 0) {
            continue;
          }
          createChunkCount++;
          const chunk = await this.prepareChunk(piece);
          cachedCount += chunk.isNew ? 0 : 1;
          newCount += chunk.isNew ? 1 : 0;
          if (!await addBuffer(chunk.id, chunk.piece)) {
            return false;
          }
        }
      } catch (ex) {
        Logger8(`Error processing pieces for ${dispFilename}`);
        Logger8(ex, LOG_LEVEL_VERBOSE8);
        return false;
      }
      if (!await flushBufferedChunks()) {
        return false;
      }
      const dataSize = note.data.size;
      const stats = `(\u2728: ${newCount}, \u{1F5C3}\uFE0F: ${cachedCount} (${resultCachedCount}) / \u{1F5C4}\uFE0F: ${writeCount}, \u267B:${duplicatedCount})`;
      Logger8(
        `Chunks processed for ${dispFilename} (${dataSize}): \u{1F4DA}:${totalChunkCount} (${createChunkCount}) , \u{1F4E5}:${totalWritingCount} ${stats}`,
        LOG_LEVEL_VERBOSE8
      );
      if (dataSize > 0 && totalWritingCount === 0) {
        Logger8(
          `No data to save in ${dispFilename}!! This document may be corrupted in the local database! Please back it up immediately, and report an issue!`,
          LOG_LEVEL_NOTICE3
        );
      }
      if (onlyChunks) {
        return {
          id: note._id,
          ok: true,
          rev: "dummy"
        };
      }
      const newDoc = {
        children: chunks,
        _id: note._id,
        path: note.path,
        ctime: note.ctime,
        mtime: note.mtime,
        size: note.size,
        type: note.datatype,
        eden: {}
      };
      return await serialized("file:" + filename, async () => {
        try {
          const old = await this.localDatabase.get(newDoc._id);
          newDoc._rev = old._rev;
        } catch (ex) {
          if (isErrorOfMissingDoc(ex)) {
          } else {
            throw ex;
          }
        }
        const r = await this.localDatabase.put(newDoc, { force: true });
        if (r.ok) {
          return r;
        } else {
          return false;
        }
      }) ?? false;
    });
    if (result === false) {
      Logger8(`Failed to write document ${dispFilename}`, LOG_LEVEL_NOTICE3);
      return false;
    }
    Logger8(`Document saved: ${dispFilename} (${result.id.substring(0, 8)}-${result.rev})`, LOG_LEVEL_VERBOSE8);
    return result;
  }
};

// upstream/src/managers/HashManager/HashManagerCore.ts
import { fallbackMixedHashEach, mixedHash } from "octagonal-wheels/hash/purejs";
var HashEncryptedPrefix = "+";
var HashManagerCore = class {
  /**
   * Remote database settings.
   */
  settings;
  /**
   * Indicates whether encryption is enabled for hash computation.
   */
  useEncryption = false;
  /**
   * Hashed passphrase as a string, used for hash operations.
   */
  hashedPassphrase = "";
  /**
   * Hashed passphrase as a 32-bit number, used for hash operations.
   */
  hashedPassphrase32 = 0;
  /**
   * Options used for initialisation and configuration.
   */
  options;
  /**
   * Constructs a new {@link HashManagerCore} instance.
   *
   * @param options - Configuration options for hash management.
   */
  constructor(options) {
    this.options = options;
    this.settings = options.settings;
    this.applyOptions(options);
  }
  /**
   * Applies the given options to the hash manager.
   *
   * Updates encryption settings and computes passphrase hashes.
   *
   * @param options - Optional configuration to apply.
   */
  applyOptions(options) {
    if (options) {
      this.options = options;
    }
    this.settings = this.options.settings;
    this.useEncryption = this.settings.encrypt ?? false;
    const passphrase = this.settings.passphrase || "";
    const usingLetters = ~~(passphrase.length / 4 * 3);
    const passphraseForHash = SALT_OF_ID + passphrase.substring(0, usingLetters);
    this.hashedPassphrase = fallbackMixedHashEach(passphraseForHash);
    this.hashedPassphrase32 = mixedHash(passphraseForHash, SEED_MURMURHASH)[0];
  }
  /**
   * Task representing the initialisation process.
   */
  initialiseTask;
  /**
   * Ensures the hash manager is initialised.
   *
   * Returns a promise that resolves when initialisation is complete.
   *
   * @returns Promise resolving to true if initialisation succeeds.
   */
  initialise() {
    if (this.initialiseTask) {
      return this.initialiseTask;
    }
    this.initialiseTask = this.processInitialise();
    return this.initialiseTask;
  }
  /**
   * Computes a hash for the given string.
   *
   * If encryption is enabled, the hash is computed with encryption and prefixed.
   * Otherwise, a plain hash is computed.
   *
   * @param piece - The input string to hash.
   * @returns Promise resolving to the computed hash string.
   */
  async computeHash(piece) {
    await this.initialiseTask;
    if (this.useEncryption) {
      return HashEncryptedPrefix + await this.computeHashWithEncryption(piece);
    }
    return await this.computeHashWithoutEncryption(piece);
  }
  /**
   * Determines whether the hash manager is available for the specified algorithm.
   *
   * Subclasses should override this method to indicate supported algorithms.
   *
   * @param hashAlg - The hash algorithm to check.
   * @returns True if available, false otherwise.
   */
  static isAvailableFor(hashAlg) {
    return false;
  }
};

// upstream/src/string_and_binary/hash.ts
var hash_exports = {};
__reExport(hash_exports, xxhash_star);
import * as xxhash_star from "octagonal-wheels/hash/xxhash.js";

// upstream/src/managers/HashManager/XXHashHashManager.ts
var XXHashHashManager = class extends HashManagerCore {
  /**
   * Instance of XXHash API used for hashing operations.
   */
  xxhash;
  /**
   * Constructs a new XXHashHashManager.
   * @param options - Options for the hash manager core.
   */
  constructor(options) {
    super(options);
  }
  /**
   * Initialises the XXHash API instance.
   * @returns A promise resolving to true when initialisation is complete.
   */
  async processInitialise() {
    this.xxhash = await (0, hash_exports.xxhashNew)();
    return true;
  }
};
var XXHash32RawHashManager = class extends XXHashHashManager {
  /**
   * Determines whether this manager is available for the specified algorithm.
   * @param hashAlg - The hash algorithm to check.
   * @returns True if available, false otherwise.
   */
  static isAvailableFor(hashAlg) {
    return hashAlg === HashAlgorithms.LEGACY;
  }
  /**
   * Computes a hash for the given piece using encryption.
   * @param piece - The input string to hash.
   * @returns A promise resolving to the hash string.
   */
  computeHashWithEncryption(piece) {
    return Promise.resolve(
      (this.xxhash.h32Raw(new TextEncoder().encode(piece)) ^ this.hashedPassphrase32 ^ piece.length).toString(36)
    );
  }
  /**
   * Computes a hash for the given piece without encryption.
   * @param piece - The input string to hash.
   * @returns A promise resolving to the hash string.
   */
  computeHashWithoutEncryption(piece) {
    return Promise.resolve((this.xxhash.h32Raw(new TextEncoder().encode(piece)) ^ piece.length).toString(36));
  }
};
var XXHash64HashManager = class extends XXHashHashManager {
  /**
   * Determines whether this manager is available for the specified algorithm.
   * @param hashAlg - The hash algorithm to check.
   * @returns True if available, false otherwise.
   */
  static isAvailableFor(hashAlg) {
    return hashAlg === HashAlgorithms.XXHASH64;
  }
  /**
   * Computes a hash for the given piece using encryption.
   * @param piece - The input string to hash.
   * @returns A promise resolving to the hash string.
   */
  computeHashWithEncryption(piece) {
    return Promise.resolve(this.xxhash.h64(`${piece}-${this.hashedPassphrase}-${piece.length}`).toString(36));
  }
  /**
   * Computes a hash for the given piece without encryption.
   * @param piece - The input string to hash.
   * @returns A promise resolving to the hash string.
   */
  computeHashWithoutEncryption(piece) {
    return Promise.resolve(this.xxhash.h64(`${piece}-${piece.length}`).toString(36));
  }
};
var FallbackWasmHashManager = class extends XXHashHashManager {
  /**
   * Determines whether this manager is available for the specified algorithm.
   * Always returns true as a fallback.
   * @param hashAlg - The hash algorithm to check.
   * @returns True.
   */
  static isAvailableFor(hashAlg) {
    return true;
  }
  /**
   * Computes a hash for the given piece using encryption.
   * @param piece - The input string to hash.
   * @returns A promise resolving to the hash string.
   */
  computeHashWithEncryption(piece) {
    return Promise.resolve(this.xxhash.h32(`${piece}-${this.hashedPassphrase}-${piece.length}`).toString(36));
  }
  /**
   * Computes a hash for the given piece without encryption.
   * @param piece - The input string to hash.
   * @returns A promise resolving to the hash string.
   */
  computeHashWithoutEncryption(piece) {
    return Promise.resolve(this.xxhash.h32(`${piece}-${piece.length}`).toString(36));
  }
};

// upstream/src/managers/HashManager/PureJSHashManager.ts
import { fallbackMixedHashEach as fallbackMixedHashEach2, sha1 } from "octagonal-wheels/hash/purejs";
var PureJSHashManager = class extends HashManagerCore {
  /**
   * Determines whether this manager is available for the specified algorithm.
   * @param hashAlg The hash algorithm to check.
   * @returns True if the algorithm is "mixed-purejs".
   */
  static isAvailableFor(hashAlg) {
    return hashAlg === HashAlgorithms.MIXED_PUREJS;
  }
  /**
   * Initialises the hash manager.
   * @returns Always resolves to true.
   */
  processInitialise() {
    return Promise.resolve(true);
  }
  /**
   * Computes a hash for the given input, including encryption.
   * @param input The input string to hash.
   * @returns The computed hash as a promise.
   */
  computeHashWithEncryption(input) {
    return Promise.resolve(fallbackMixedHashEach2(`${input}${this.hashedPassphrase}${input.length}`));
  }
  /**
   * Computes a hash for the given input, without encryption.
   * @param input The input string to hash.
   * @returns The computed hash as a promise.
   */
  computeHashWithoutEncryption(input) {
    return Promise.resolve(fallbackMixedHashEach2(`${input}-${input.length}`));
  }
};
var SHA1HashManager = class extends HashManagerCore {
  /**
   * Determines whether this manager is available for the specified algorithm.
   * @param hashAlg The hash algorithm to check.
   * @returns True if the algorithm is "sha1".
   */
  static isAvailableFor(hashAlg) {
    return hashAlg === HashAlgorithms.SHA1;
  }
  /**
   * Initialises the hash manager.
   * @returns Always resolves to true.
   */
  processInitialise() {
    return Promise.resolve(true);
  }
  /**
   * Computes a SHA-1 hash for the given input, including encryption.
   * @param input The input string to hash.
   * @returns The computed SHA-1 hash as a promise.
   */
  computeHashWithEncryption(input) {
    return sha1(`${input}-${this.hashedPassphrase}-${input.length}`);
  }
  /**
   * Computes a SHA-1 hash for the given input, without encryption.
   * @param input The input string to hash.
   * @returns The computed SHA-1 hash as a promise.
   */
  computeHashWithoutEncryption(input) {
    return sha1(`${input}-${input.length}`);
  }
};
var FallbackPureJSHashManager = class extends PureJSHashManager {
  /**
   * Always returns true, indicating this manager is available for any algorithm.
   * @param _hashAlg The hash algorithm (ignored).
   * @returns True.
   */
  static isAvailableFor(_hashAlg) {
    return true;
  }
};

// upstream/src/managers/HashManager/HashManager.ts
var HashManagers = [
  XXHash64HashManager,
  XXHash32RawHashManager,
  SHA1HashManager,
  PureJSHashManager,
  // Please retain these fallback managers, as they are essential for compatibility.
  FallbackWasmHashManager,
  FallbackPureJSHashManager
];
var HashManager = class extends HashManagerCore {
  /**
   * Instance of the hash manager currently in use.
   */
  manager = void 0;
  /**
   * Checks whether the specified hash algorithm is available.
   *
   * @param hashAlg The hash algorithm to check
   * @returns True if available
   */
  static isAvailableFor(hashAlg) {
    return HashManagers.some((manager) => manager.isAvailableFor(hashAlg));
  }
  /**
   * Selects and initialises an available hash manager.
   *
   * @returns True if initialisation is successful
   * @throws Throws an error if no available manager exists
   */
  async setManager() {
    for (const Manager of HashManagers) {
      if (Manager.isAvailableFor(this.settings.hashAlg)) {
        this.manager = new Manager(this.options);
        return await this.manager.initialise();
      }
    }
    throw new Error(`HashManager for ${this.settings.hashAlg} is not available`);
  }
  /**
   * Constructs a new HashManager.
   *
   * @param options Initialisation options
   */
  constructor(options) {
    super(options);
  }
  /**
   * Initialises the hash manager.
   *
   * @returns True if initialisation is successful
   * @throws Throws an error if initialisation fails
   */
  async processInitialise() {
    if (await this.setManager()) {
      (0, logger_exports.Logger)(`HashManager for ${this.settings.hashAlg} has been initialised`, logger_exports.LOG_LEVEL_VERBOSE);
      return true;
    }
    (0, logger_exports.Logger)(`HashManager for ${this.settings.hashAlg} failed to initialise`);
    throw new Error(`HashManager for ${this.settings.hashAlg} failed to initialise`);
  }
  /**
   * Computes the hash value for the specified string.
   *
   * @param piece The string to be hashed
   * @returns The hash value (returned as a Promise)
   */
  computeHash(piece) {
    return this.manager.computeHash(piece);
  }
  /**
   * Computes the hash value without encryption.
   *
   * @param piece The string to be hashed
   * @returns The hash value (returned as a Promise)
   */
  computeHashWithoutEncryption(piece) {
    return this.manager.computeHashWithoutEncryption(piece);
  }
  /**
   * Computes the hash value with encryption.
   *
   * @param piece The string to be hashed
   * @returns The hash value (returned as a Promise)
   */
  computeHashWithEncryption(piece) {
    return this.manager.computeHashWithEncryption(piece);
  }
};

// upstream/src/managers/NetworkManager.ts
var NetworkManager = class {
};
var NetworkManagerBrowser = class extends NetworkManager {
  get isOnline() {
    return navigator.onLine;
  }
};

// upstream/src/managers/LiveSyncManagers.ts
var LiveSyncManagers = class {
  hashManager;
  chunkFetcher;
  changeManager;
  chunkManager;
  splitter;
  entryManager;
  conflictManager;
  networkManager;
  options;
  constructor(options) {
    this.options = options;
    if (options.networkManager) {
      this.networkManager = options.networkManager;
    } else {
      if ("navigator" in globalThis) {
        this.networkManager = new NetworkManagerBrowser();
      } else {
        throw new LiveSyncError("No NetworkManager available");
      }
    }
  }
  get settings() {
    return this.options.settings;
  }
  async teardownManagers() {
    if (this.changeManager) {
      this.changeManager.teardown();
      this.changeManager = void 0;
    }
    if (this.chunkFetcher) {
      this.chunkFetcher.destroy();
      this.chunkFetcher = void 0;
    }
    if (this.chunkManager) {
      this.chunkManager.destroy();
      this.chunkManager = void 0;
    }
    return await Promise.resolve();
  }
  getProxy() {
    const getDB = () => this.options.database;
    const getChangeManager = () => this.changeManager;
    const getChunkManager = () => this.chunkManager;
    const getReplicator = () => this.options.getActiveReplicator();
    const getSettings = () => this.options.settings;
    const getEntryManager = () => this.entryManager;
    const getHashManager = () => this.hashManager;
    const getChunkFetcher = () => this.chunkFetcher;
    const getSplitter = () => this.splitter;
    const proxy = {
      get database() {
        return getDB();
      },
      get changeManager() {
        return getChangeManager();
      },
      get chunkManager() {
        return getChunkManager();
      },
      getActiveReplicator() {
        return getReplicator();
      },
      get settings() {
        return getSettings();
      },
      get entryManager() {
        return getEntryManager();
      },
      get hashManager() {
        return getHashManager();
      },
      $$path2id: (filename, prefix) => {
        return this.options.path2id(filename, prefix);
      },
      $$id2path: (id, entry, stripPrefix2) => {
        return this.options.id2path(id, entry, stripPrefix2);
      },
      get chunkFetcher() {
        return getChunkFetcher();
      },
      get splitter() {
        return getSplitter();
      }
    };
    return proxy;
  }
  async initManagers() {
    await this.teardownManagers();
    const proxy = this.getProxy();
    this.hashManager = new HashManager({
      ...proxy
    });
    this.splitter = new ContentSplitter({
      ...proxy
    });
    await this.splitter.initialise(
      proxy
    );
    await this.hashManager.initialise();
    this.changeManager = new ChangeManager(proxy);
    this.chunkManager = new ChunkManager({
      ...proxy,
      maxCacheSize: this.settings.hashCacheMaxCount * 10
    });
    this.chunkFetcher = new ChunkFetcher(proxy);
    this.entryManager = new EntryManager({
      ...proxy
    });
    this.conflictManager = new ConflictManager({
      ...proxy
    });
  }
  clearCaches() {
    this.chunkManager?.clearCaches();
  }
  async prepareHashFunction() {
    const proxy = this.getProxy();
    this.hashManager = new HashManager(proxy);
    await this.hashManager.initialise();
  }
};

// upstream/src/API/DirectFileManipulatorV2.ts
function isNoteEntry(doc) {
  if (!doc) return false;
  return doc.type == "newnote" || doc.type == "plain";
}
function isReadyEntry(doc) {
  if (!doc) return false;
  return "data" in doc;
}
var DirectFileManipulator = class {
  liveSyncLocalDB;
  managers;
  options;
  ready = promiseWithResolver2();
  constructor(options) {
    this.options = options;
    const getDB = () => this.liveSyncLocalDB.localDatabase;
    const getSettings = () => this.settings;
    this.managers = new LiveSyncManagers({
      get database() {
        return getDB();
      },
      getActiveReplicator: () => this.$$getReplicator(),
      id2path: this.$$id2path.bind(this),
      path2id: this.$$path2id.bind(this),
      get settings() {
        return getSettings();
      }
    });
    this.liveSyncLocalDB = new LiveSyncLocalDB(this.options.url, this);
    void this.liveSyncLocalDB.initializeDatabase().then(() => {
      this.ready.resolve();
      this.liveSyncLocalDB.refreshSettings();
    });
  }
  $$id2path(id, entry, stripPrefix2) {
    const path = id2path_base(id, entry);
    if (stripPrefix2) {
      return stripAllPrefixes(path);
    }
    return path;
  }
  async $$path2id(filename, prefix) {
    const fileName = prefix ? addPrefix(filename, prefix) : filename;
    const id = await path2id_base(
      fileName,
      this.options.obfuscatePassphrase ?? false,
      !this.options.handleFilenameCaseSensitive
    );
    return id;
  }
  $$createPouchDBInstance(_name, _options) {
    return new PouchDB(this.options.url + "/" + this.options.database, {
      auth: { username: this.options.username, password: this.options.password }
    });
  }
  $allOnDBUnload(_db) {
    return;
  }
  $allOnDBClose(_db) {
    return;
  }
  getInitialSyncParameters(setting) {
    return Promise.resolve({
      ...DEFAULT_SYNC_PARAMETERS,
      protocolVersion: ProtocolVersions.ADVANCED_E2EE
    });
  }
  async getSyncParameters(setting) {
    try {
      const downloadedSyncParams = await this.rawGet(DOCID_SYNC_PARAMETERS);
      if (!downloadedSyncParams) {
        throw new SyncParamsNotFoundError(`Sync parameters have not been found in the database.`);
      }
      return downloadedSyncParams;
    } catch (ex) {
      Logger10(`Could not retrieve remote sync parameters`, LOG_LEVEL_INFO4);
      throw SyncParamsFetchError.fromError(ex);
    }
  }
  async putSyncParameters(setting, params) {
    try {
      const ret = await this.liveSyncLocalDB.putRaw(params);
      if (ret.ok) {
        return true;
      }
      throw new SyncParamsUpdateError(`Could not store remote sync parameters`);
    } catch (ex) {
      Logger10(`Could not store remote sync parameters`, LOG_LEVEL_INFO4);
      throw SyncParamsUpdateError.fromError(ex);
    }
  }
  async getReplicationPBKDF2Salt(setting, refresh) {
    const server = `${setting.couchDB_URI}/${setting.couchDB_DBNAME}`;
    const manager = createSyncParamsHanderForServer(server, {
      put: (params) => this.putSyncParameters(setting, params),
      get: () => this.getSyncParameters(setting),
      create: () => this.getInitialSyncParameters(setting)
    });
    return await manager.getPBKDF2Salt(refresh);
  }
  $everyOnInitializeDatabase(db) {
    replicationFilter(db.localDatabase, this.options.enableCompression ?? false);
    disableEncryption();
    if (this.options.passphrase && typeof this.options.passphrase === "string") {
      enableEncryption(
        db.localDatabase,
        this.options.passphrase,
        this.options.useDynamicIterationCount ?? false,
        false,
        async () => await this.getReplicationPBKDF2Salt(this.getSettings()),
        this.options.E2EEAlgorithm ?? E2EEAlgorithms.V2
      );
    }
    return Promise.resolve(true);
  }
  $everyOnResetDatabase(_db) {
    throw new Error("Method not implemented.");
  }
  $$getReplicator = () => {
    throw new Error("Method not implemented.");
  };
  getSettings() {
    return this.settings;
  }
  async close() {
    await this.liveSyncLocalDB.close();
    return this.liveSyncLocalDB.onunload();
  }
  async path2id(filename, prefix) {
    const fileName = prefix ? addPrefix(filename, prefix) : filename;
    const id = await path2id_base(
      fileName,
      this.options.obfuscatePassphrase ?? false,
      !this.options.handleFilenameCaseSensitive
    );
    return id;
  }
  get settings() {
    const retObj = {
      ...DEFAULT_SETTINGS,
      ...{
        minimumChunkSize: this.options.minimumChunkSize ?? DEFAULT_SETTINGS.minimumChunkSize,
        encrypt: this.options.passphrase ? true : false,
        passphrase: this.options.passphrase ?? "",
        deleteMetadataOfDeletedFiles: DEFAULT_SETTINGS.deleteMetadataOfDeletedFiles,
        customChunkSize: this.options.customChunkSize ?? DEFAULT_SETTINGS.customChunkSize,
        doNotPaceReplication: DEFAULT_SETTINGS.doNotPaceReplication,
        hashAlg: this.options.hashAlg ?? DEFAULT_SETTINGS.hashAlg,
        useEden: this.options.useEden ?? DEFAULT_SETTINGS.useEden,
        maxChunksInEden: this.options.maxChunksInEden ?? DEFAULT_SETTINGS.maxChunksInEden,
        maxTotalLengthInEden: this.options.maxTotalLengthInEden ?? DEFAULT_SETTINGS.maxTotalLengthInEden,
        maxAgeInEden: this.options.maxAgeInEden ?? DEFAULT_SETTINGS.maxAgeInEden,
        enableChunkSplitterV2: this.options.enableChunkSplitterV2 ?? DEFAULT_SETTINGS.enableChunkSplitterV2,
        chunkSplitterVersion: this.options.chunkSplitterVersion ?? DEFAULT_SETTINGS.chunkSplitterVersion,
        disableWorkerForGeneratingChunks: true,
        processSmallFilesInUIThread: true,
        doNotUseFixedRevisionForChunks: this.options.doNotUseFixedRevisionForChunks ?? DEFAULT_SETTINGS.doNotUseFixedRevisionForChunks,
        couchDB_URI: this.options.url,
        couchDB_DBNAME: this.options.database,
        couchDB_USER: this.options.username,
        couchDB_PASSWORD: this.options.password,
        accessKey: "",
        secretKey: "",
        bucket: "",
        region: "",
        endpoint: "",
        enableCompression: this.options.enableCompression ?? DEFAULT_SETTINGS.enableCompression,
        handleFilenameCaseSensitive: this.options.handleFilenameCaseSensitive ?? DEFAULT_SETTINGS.handleFilenameCaseSensitive,
        E2EEAlgorithm: this.options.E2EEAlgorithm ?? E2EEAlgorithms.V2
      }
    };
    return retObj;
  }
  /**
   * Get specific document from the Remote Database by path.
   * @param path
   * @param metaOnly if it has been enabled, the note does not contains the content.
   * @returns
   */
  async get(path, metaOnly = false) {
    if (metaOnly) {
      return await this.liveSyncLocalDB.getDBEntryMeta(path);
    } else {
      return await this.liveSyncLocalDB.getDBEntry(path);
    }
  }
  /**
   * Get specific document from the Remote Database by ID.
   * @param path
   * @param metaOnly if it has been enabled, the note does not contains the content.
   * @returns
   */
  async getById(id, metaOnly = false) {
    const meta = await this.liveSyncLocalDB.getRaw(id);
    if (!isNoteEntry(meta)) return false;
    if (metaOnly) {
      return meta;
    }
    return this.getByMeta(meta);
  }
  async getByMeta(doc) {
    const docX = await this.liveSyncLocalDB.getDBEntryFromMeta(doc);
    if (!isReadyEntry(docX)) {
      throw new Error(`Corrupted document: ${doc.path}`);
    }
    return docX;
  }
  async rawGet(id) {
    try {
      const doc = await this.liveSyncLocalDB.getRaw(id);
      return doc;
    } catch (ex) {
      if (isErrorOfMissingDoc(ex)) {
        return false;
      }
      throw ex;
    }
  }
  /**
   * Put a note to the remote database
   * @param path
   * @param data
   * @param info
   * @param type
   * @returns
   */
  async put(path, data, info, _type = "plain") {
    const id = await this.path2id(path);
    const saveData = data instanceof Blob ? data : createBlob(data);
    const datatype = determineTypeFromBlob(saveData);
    const putDoc = {
      _id: id,
      path,
      data: saveData,
      ctime: info.ctime,
      mtime: info.mtime,
      size: info.size,
      type: datatype,
      eden: {},
      children: [],
      datatype
    };
    Logger10(`PUT: UPLOADING: ${path}`, LOG_LEVEL_VERBOSE10);
    const ret = await this.liveSyncLocalDB.putDBEntry(putDoc);
    if (ret) {
      Logger10(`PUT: DONE: ${path}`, LOG_LEVEL_INFO4);
      return true;
    } else {
      Logger10(`PUT: FAILED: ${path}`, LOG_LEVEL_NOTICE4);
      return false;
    }
  }
  async delete(path) {
    Logger10(`DELETE: START: ${path}`, LOG_LEVEL_VERBOSE10);
    const ret = await this.liveSyncLocalDB.deleteDBEntry(path);
    if (ret) {
      Logger10(`DELETE: DONE: ${path}`, LOG_LEVEL_INFO4);
      return true;
    } else {
      Logger10(`DELETE: FAILED: ${path}`, LOG_LEVEL_INFO4);
      return false;
    }
  }
  // Untested
  async *enumerate(_cond) {
  }
  async *_enumerate(startKey, endKey, opt) {
    if (opt.metaOnly) return this.liveSyncLocalDB.findEntries(startKey, endKey, {});
    for await (const f of this.liveSyncLocalDB.findEntries(startKey, endKey, {})) {
      yield await this.getByMeta(f);
    }
  }
  async *enumerateAllNormalDocs(opt) {
    const targets = [
      this._enumerate("", "h:", opt),
      this._enumerate(`h:\u{10FFFF}`, "i:", opt),
      this._enumerate(`i:\u{10FFFF}`, "ix:", opt),
      this._enumerate(`ix:\u{10FFFF}`, "ps:", opt),
      this._enumerate(`ps:\u{10FFFF}`, "\u{10FFFF}", opt)
    ];
    for (const target of targets) {
      for await (const f of target) {
        yield f;
      }
    }
  }
  watching = false;
  // _abortController?: AbortController;
  changes;
  since = "";
  beginWatch(callback, checkIsInterested) {
    if (this.watching) return false;
    this.watching = true;
    this.changes = this.liveSyncLocalDB.localDatabase.changes({
      include_docs: true,
      since: this.since,
      selector: {
        type: { $ne: "leaf" }
      },
      live: true
    }).on("change", async (change) => {
      const doc = change.doc;
      if (!doc) {
        return;
      }
      if (!isNoteEntry(doc)) {
        return;
      }
      if (checkIsInterested) {
        if (!checkIsInterested(doc)) {
          Logger10(`WATCH: SKIP ${doc.path}: OUT OF TARGET FOLDER`, LOG_LEVEL_VERBOSE10, "watch");
          return;
        }
      }
      Logger10(`WATCH: PROCESSING: ${doc.path}`, LEVEL_VERBOSE, "watch");
      const docX = await this.getByMeta(doc);
      try {
        await callback(docX, change.seq);
        Logger10(`WATCH: PROCESS DONE: ${doc.path}`, LEVEL_INFO, "watch");
      } catch (ex) {
        Logger10(`WATCH: PROCESS FAILED`, LEVEL_INFO, "watch");
        Logger10(ex, LEVEL_VERBOSE, "watch");
      }
    }).on("complete", () => {
      Logger10(`WATCH: FINISHED`, LEVEL_INFO, "watch");
      this.watching = false;
      this.changes = void 0;
    }).on("error", (err) => {
      Logger10(`WATCH: ERROR: `, LEVEL_INFO, "watch");
      Logger10(err, LEVEL_VERBOSE, "watch");
      if (this.watching) {
        Logger10(`WATCH: CONNECTION HAS BEEN CLOSED, RECONNECTING...`, LEVEL_INFO, "watch");
        this.watching = false;
        this.changes = void 0;
        setTimeout(() => {
          this.beginWatch(callback, checkIsInterested);
        }, 1e4);
      } else {
        Logger10(`WATCH: CONNECTION HAS BEEN CLOSED.`, LEVEL_INFO, "watch");
      }
    });
  }
  endWatch() {
    if (this.changes) {
      Logger10(`WATCH: CANCELLING PROCESS.`, LEVEL_INFO, "watch");
      this.changes.cancel();
      Logger10(`WATCH: CANCELLING SIGNAL HAS BEEN SENT.`, LEVEL_INFO, "watch");
    }
  }
  async followUpdates(callback, checkIsInterested) {
    try {
      if (this.since == "") {
        this.since = "0";
      }
      Logger10(`FOLLOW: START: (since:${this.since})`, LEVEL_INFO, "followUpdates");
      const last = await this.liveSyncLocalDB.localDatabase.changes({
        include_docs: true,
        since: this.since,
        filter: "replicate/pull",
        live: false
      }).on("change", async (change) => {
        const doc = change.doc;
        if (!doc) {
          return;
        }
        if (!isNoteEntry(doc)) {
          return;
        }
        if (checkIsInterested) {
          if (!checkIsInterested(doc)) {
            Logger10(`FOLLOW: SKIP ${doc._id}: OUT OF TARGET FOLDER`, LOG_LEVEL_VERBOSE10, "watch");
            return;
          }
        }
        Logger10(`FOLLOW: PROCESSING: ${doc.path}`, LEVEL_VERBOSE, "watch");
        const docX = await this.getByMeta(doc);
        try {
          await callback(docX, change.seq);
          Logger10(`FOLLOW: PROCESS DONE: ${doc.path}`, LEVEL_INFO, "watch");
        } catch (ex) {
          Logger10(`FOLLOW: PROCESS FAILED`, LEVEL_INFO, "watch");
          Logger10(ex, LEVEL_VERBOSE, "watch");
        }
      }).on("complete", () => {
        Logger10(`FOLLOW: FINISHED AT ${this.since}`, LEVEL_INFO, "watch");
        this.watching = false;
        this.changes = void 0;
      }).on("error", (err) => {
        Logger10(`FOLLOW: ERROR at ${this.since}: ${err}`, LEVEL_INFO, "watch");
      });
      return last.last_seq;
    } catch (e) {
      Logger10(`FOLLOW: ERROR: ${e}`, LEVEL_INFO, "watch");
    }
    return this.since;
  }
};
var export_Logger = logger_exports.Logger;
var export_defaultLoggerEnv = logger_exports.defaultLoggerEnv;
export {
  DirectFileManipulator,
  LOG_LEVEL_DEBUG,
  LOG_LEVEL_INFO,
  LOG_LEVEL_NOTICE,
  LOG_LEVEL_URGENT,
  LOG_LEVEL_VERBOSE,
  export_Logger as Logger,
  addPrefix,
  createBlob,
  createTextBlob,
  export_defaultLoggerEnv as defaultLoggerEnv,
  determineTypeFromBlob,
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
  uint8ArrayToHexString
};
