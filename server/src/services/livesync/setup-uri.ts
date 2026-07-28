/**
 * The Setup URI codec: Self-hosted LiveSync's `obsidian://setuplivesync?settings=`
 * format, in both directions.
 *
 * This is the file that lets a phone running the REAL Obsidian plugin join a
 * vault this server is already syncing, and lets this server be configured from
 * a URI an existing device produced. Format compatibility with the plugin is the
 * entire point: a homegrown envelope that only works WebObsidian-to-WebObsidian
 * would be worthless, so every constant, offset and iteration count below is
 * taken from a verified source rather than chosen.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS HAND-WRITTEN RATHER THAN IMPORTED
 *
 * The codec upstream calls (`@vrtmrz/livesync-commonlib/compat/API/processSetting`,
 * exporting `encodeSettingsToSetupURI`) is NOT in our vendored engine. We pin
 * commonlib at 8ed9bcd and the codec module landed in a later release;
 * `configURIBase` and `configURIBaseQR` are absent from `vendor/.../upstream/src`
 * entirely (verified by grep).
 *
 * Three options existed and two were rejected:
 *
 *  1. Re-vendor a newer commonlib. REJECTED: that swaps the sync engine out from
 *     under a subsystem that was just stabilised, to gain a pure function over a
 *     settings object. The blast radius is the whole replication path; the gain
 *     is this file.
 *  2. Import the crypto from `octagonal-wheels` directly. REJECTED: it is a
 *     dependency of the VENDORED PACKAGE, not of the server, and it is hoisted
 *     to the root `node_modules`. Importing it here would be an undeclared
 *     dependency that happens to resolve today. `peer-couchdb.ts` already faced
 *     exactly this choice for `decodeBinary` and resolved it the same way, with
 *     the same reasoning written out at its `decodeEntryData`.
 *  3. Reimplement the envelope against the same specification. CHOSEN.
 *
 * The reimplementation is pinned by known-answer tests in
 * `src/__tests__/livesync-setup-uri.test.ts`: ciphertext produced by the real
 * `octagonal-wheels@0.1.51` is committed there as static fixtures, and this file
 * has to decrypt it byte-for-byte. That is a genuine interop proof rather than a
 * self-round-trip, and it needs no dependency at runtime OR at test time.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ENCRYPTED, WITH WHAT, AND WHEN
 *
 * This decides whether CouchDB credentials end up on a screen in the clear, so
 * it is stated flatly rather than left to be inferred.
 *
 *  - The `?settings=` payload IS encrypted, under a passphrase that exists SOLELY
 *    to protect the URI. It is not the E2EE vault passphrase and must not be:
 *    upstream's own documentation says "`passphrase` protects the synchronised
 *    Vault data with end-to-end encryption. `uri_passphrase` protects only the
 *    Setup URI. Use different values."
 *
 *  - The plugin's OTHER transport, `?settingsQR=`, is NOT encrypted at all. Not
 *    weakly, not under a default key. The proof is structural rather than a
 *    reading of the warning string: `encodeSettingsToQRCodeData` and
 *    `decodeSettingsFromQRCodeData` are SYNCHRONOUS and take no passphrase, and
 *    every crypto path in this stack is WebCrypto, which is promise-only. A
 *    `settingsQR` payload therefore carries `couchDB_PASSWORD` and the E2EE
 *    `passphrase` in cleartext, and in its multi-part form upstream parks that
 *    cleartext in a third-party origin's `localStorage`
 *    (`vrtmrz.github.io/obsidian-livesync/aggregator.html`).
 *
 *    THIS FILE DELIBERATELY IMPLEMENTS NEITHER DIRECTION OF `settingsQR`. A QR
 *    code is a transport for a string, and nothing forces that string to be the
 *    plaintext one: the plugin's protocol handler accepts
 *    `obsidian://setuplivesync?settings=<encrypted>` from any source INCLUDING a
 *    camera scan, and routes it into the passphrase dialog. So rendering the
 *    ENCRYPTED URI as a QR gets the "join device N+1 by scanning" win with none
 *    of the disclosure, and stays fully plugin-compatible. Consuming a plaintext
 *    QR produced by the real plugin is the only capability given up, and that is
 *    a capability whose entire content is "accept a credential bundle that
 *    travelled in the clear".
 *
 *  - `configPassphrase` / `configPassphraseStore` are a DIFFERENT feature and
 *    are not in this format. `configPassphrase` encrypts the plugin's own
 *    `data.json` at rest on one device, is stored in that device's
 *    `localStorage` under `ls-setting-passphrase`, and is documented as "This
 *    passphrase will not be copied to another device." It is not even a member
 *    of `ObsidianLiveSyncSettings`, so it is structurally incapable of appearing
 *    in a payload. Only the mode enum `configPassphraseStore` rides along.
 *
 * ---------------------------------------------------------------------------
 * LAYERING, AND A DELIBERATE DIVISION OF RESPONSIBILITY
 *
 * This module is a PURE FUNCTION over settings objects. It has no dependency on
 * the peer layer, the engine, the settings store or Express, it performs no I/O,
 * and it makes no policy decisions about who may call it.
 *
 * That matters for one specific tension. The wire format carries roughly 150
 * keys; we model 9. Faithfulness argues for preserving the other ~140 across a
 * round trip, so that a user who passes a URI through WebObsidian does not
 * silently lose their `ignoreFiles`, plugin-sync configuration or P2P settings.
 * The security policy argues the opposite for anything PERSISTED: import must
 * read a fixed allowlist rather than merging an attacker-influenced object, and
 * nothing new may be stored under `livesync`.
 *
 * Both are satisfied by putting the split here:
 *
 *   - THE CODEC (this file) is faithful. `decodeSetupUri` hands back every key it
 *     found, and `encodeSetupUri` accepts a `carryOver` of keys we do not model
 *     and re-emits them verbatim. Round-trip fidelity is a property of this
 *     module and is tested as one.
 *   - THE HTTP LAYER (`routes/livesync-setup.ts`) is strict. It reads a fixed
 *     allowlist out of the decoded object on import, builds a fresh minimal
 *     object on export, and never persists the carry-over.
 *
 * Getting this backwards in either direction is a real defect: a faithful HTTP
 * layer would be a settings-injection hole, and a strict codec would make
 * lossless round-tripping impossible to implement later without rewriting the
 * format layer.
 */

import { webcrypto } from 'node:crypto';

/*
 * `CryptoKey` is spelled out of the `webcrypto` NAMESPACE rather than used as a
 * global, and that is a constraint of this tsconfig rather than a style choice.
 *
 * `server/tsconfig.json` sets `"lib": ["ES2022"]` and `"types": ["node"]`, so
 * there is no DOM lib and no global `CryptoKey`. Pulling the DOM in to get one
 * is not an option: the vendored engine's `index.d.ts` records that doing so
 * makes @types/node's `Buffer<ArrayBufferLike>` stop being assignable to the
 * DOM's `ArrayBufferView<ArrayBuffer>`, which breaks unrelated, pre-existing
 * code in services/auth.ts and services/vault.ts. @types/node declares
 * `webcrypto` as both a const and a namespace, so this reaches the same type
 * with no lib change at all.
 */
type CryptoKey = webcrypto.CryptoKey;

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

/**
 * The Setup URI prefix, verbatim.
 *
 * CONFIRMED from four independent places in the plugin tree rather than guessed:
 * `docs/quick_setup.md` states it in prose; `setupProtocol.ts` REBUILDS the whole
 * URI as `` `${configURIBase}${encodeURIComponent(conf.settings)}` `` after
 * Obsidian has already split the query, which forces the constant to be exactly
 * scheme + path + `?settings=`; `UseSetupURI.svelte` uses it as its placeholder;
 * and the CLI's usage examples spell it out.
 *
 * The decoder's validity test upstream is `startsWith(configURIBase)`, so this
 * string is load-bearing for acceptance and not merely cosmetic.
 */
export const SETUP_URI_BASE = 'obsidian://setuplivesync?settings=';

/**
 * Envelope prefixes, from `octagonal-wheels/dist/encryption/{encryption,hkdf}.js`.
 *
 * Dispatch in this format is BY PREFIX ALONE. There is no version field, no magic
 * number and no negotiation, so these five bytes are the entire compatibility
 * mechanism and an unrecognised one is simply an error.
 */
const HKDF_SALTED_PREFIX = '%$'; // current; what `encryptString` emits
const ENCRYPT_V3_PREFIX = '%~'; // chunk format; never emitted for strings
const ENCRYPT_V2_PREFIX = '%'; // legacy
const ENCRYPT_V1_PREFIX = '['; // oldest legacy

// HKDF (`%$`) parameters. Every one of these is read off
// `octagonal-wheels/dist/encryption/hkdf.js` and a mismatch in any of them
// produces a blob the real plugin cannot open.
const IV_LENGTH = 12; // AES-GCM 96-bit IV
const HKDF_SALT_LENGTH = 32;
const PBKDF2_SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 310_000; // OWASP-recommended, per the source comment
const GCM_TAG_BITS = 128;

// Legacy (`%` / `[`) parameters.
const LEGACY_IV_LENGTH = 16;
const LEGACY_SALT_LENGTH = 16;
const LEGACY_ITERATIONS = 100_000;

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Every failure mode of this module, collapsed to one class.
 *
 * The HTTP layer answers a single indistinguishable 400 for all of them, because
 * distinguishing "wrong passphrase" from "malformed blob" from "unsupported
 * format" turns the decode endpoint into a decryption oracle. The `reason` is
 * kept for logs and tests, and MUST NOT be echoed to a client.
 */
export class SetupUriError extends Error {
  constructor(
    readonly reason:
      | 'not-a-setup-uri'
      | 'unsupported-format'
      | 'decryption-failed'
      | 'malformed-payload'
      | 'too-large'
      | 'unrepresentable',
    message: string,
  ) {
    super(message);
    this.name = 'SetupUriError';
  }
}

// ---------------------------------------------------------------------------
// Binary helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new SetupUriError('malformed-payload', 'expected hex');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * Standard base64 WITH padding, matching `btoa` / `Uint8Array.toBase64()`.
 *
 * Not URL-safe, deliberately: upstream's payload is standard base64 and the URI
 * layer wraps it in `encodeURIComponent`, which is what makes `+` and `/` safe.
 * Swapping in a URL-safe alphabet here would produce a URI the plugin cannot
 * decode, and the failure would look like a wrong passphrase.
 */
function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(b64: string): Uint8Array {
  // Buffer.from is permissive about invalid base64 (it stops at the first bad
  // character rather than throwing), so an explicit shape check comes first;
  // otherwise a corrupt payload silently becomes a short buffer and surfaces as
  // a GCM tag failure, which reads as "wrong passphrase" to the operator.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
    throw new SetupUriError('malformed-payload', 'expected base64');
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The HKDF envelope (`%$`) -- the format we EMIT
// ---------------------------------------------------------------------------

/**
 * Derive the AES-GCM content key exactly as `octagonal-wheels`' `deriveKey` does.
 *
 * Two stages, and the two-stage shape is itself part of the wire format because
 * the intermediate key is exported and re-imported as HKDF material:
 *
 *  1. PBKDF2-HMAC-SHA256 over the RAW UTF-8 PASSPHRASE BYTES (not a digest of
 *     them; that is the legacy formats' behaviour and mixing the two up yields a
 *     key that is wrong in a way no test of this function alone would catch),
 *     310_000 iterations, 32-byte salt, producing a 256-bit AES-GCM key.
 *  2. That key exported raw, re-imported as HKDF key material, then HKDF-SHA256
 *     with a 32-byte salt and an EMPTY `info` to the final AES-GCM 256 key.
 *
 * Step 1's `extractable: true` is required: the raw bytes have to come back out
 * to feed step 2.
 */
async function deriveHkdfKey(
  passphrase: string,
  pbkdf2Salt: Uint8Array,
  hkdfSalt: Uint8Array,
): Promise<CryptoKey> {
  const material = await webcrypto.subtle.importKey(
    'raw',
    utf8.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  const masterKey = await webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: pbkdf2Salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  const masterRaw = await webcrypto.subtle.exportKey('raw', masterKey);
  const hkdfKey = await webcrypto.subtle.importKey('raw', masterRaw, { name: 'HKDF' }, false, [
    'deriveKey',
  ]);
  return await webcrypto.subtle.deriveKey(
    { name: 'HKDF', salt: hkdfSalt, info: new Uint8Array(), hash: 'SHA-256' },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt to the current `%$` envelope.
 *
 * Layout, which is the one place a doc comment upstream is actively WRONG and
 * worth flagging so nobody "fixes" this to match it:
 *
 *     "%$" + base64( pbkdf2Salt[32] | iv[12] | hkdfSalt[32] | ciphertext||tag )
 *
 * `hkdf.js`'s JSDoc on `decryptWithEphemeralSaltBinary` claims the order is "IV,
 * HKDF salt, PBKDF2 salt". The CODE disagrees with its own comment: the reader
 * takes `pbkdf2Salt` first, then `iv`, then `hkdfSalt`, and the writer emits them
 * in that same order. The code is authoritative, the committed known-answer
 * vectors pin it, and the ordering above is the one that interoperates.
 *
 * One deliberate divergence from upstream, and it is a strict improvement:
 * `getSessionPBKDFSalt()` CACHES the PBKDF2 salt for the whole process lifetime
 * unless explicitly refreshed, and `encryptString` never refreshes it. We
 * generate a fresh salt per call. That is wire-compatible (the salt travels in
 * the payload, so the reader neither knows nor cares) and it removes a
 * cross-message correlation that has no upside for a one-shot encoder.
 */
async function encryptHkdf(plaintext: string, passphrase: string): Promise<string> {
  const pbkdf2Salt = webcrypto.getRandomValues(new Uint8Array(PBKDF2_SALT_LENGTH));
  const hkdfSalt = webcrypto.getRandomValues(new Uint8Array(HKDF_SALT_LENGTH));
  const iv = webcrypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveHkdfKey(passphrase, pbkdf2Salt, hkdfSalt);
  const ciphertext = new Uint8Array(
    await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: GCM_TAG_BITS },
      key,
      utf8.encode(plaintext),
    ),
  );
  return HKDF_SALTED_PREFIX + bytesToBase64(concatBytes([pbkdf2Salt, iv, hkdfSalt, ciphertext]));
}

async function decryptHkdf(encrypted: string, passphrase: string): Promise<string> {
  const body = base64ToBytes(encrypted.substring(HKDF_SALTED_PREFIX.length));
  if (body.length < PBKDF2_SALT_LENGTH + IV_LENGTH + HKDF_SALT_LENGTH) {
    throw new SetupUriError('malformed-payload', 'payload shorter than its own header');
  }
  let at = 0;
  const pbkdf2Salt = body.subarray(at, (at += PBKDF2_SALT_LENGTH));
  const iv = body.subarray(at, (at += IV_LENGTH));
  const hkdfSalt = body.subarray(at, (at += HKDF_SALT_LENGTH));
  const ciphertext = body.subarray(at);
  const key = await deriveHkdfKey(passphrase, pbkdf2Salt, hkdfSalt);
  const plain = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: GCM_TAG_BITS },
    key,
    ciphertext,
  );
  return utf8Decoder.decode(new Uint8Array(plain));
}

// ---------------------------------------------------------------------------
// The legacy envelopes (`%` and `[`) -- formats we ACCEPT but never emit
// ---------------------------------------------------------------------------

/**
 * The legacy key derivation, which differs from the HKDF one in a way that is
 * easy to miss and impossible to debug from the outside.
 *
 * PBKDF2 runs over `SHA-256(utf8(passphrase))`, i.e. over the DIGEST of the
 * passphrase, not over the passphrase bytes. Feeding it the passphrase directly
 * derives a perfectly valid key that decrypts nothing.
 *
 * `autoCalculateIterations` reproduces upstream's `useDynamicIterationCount`
 * arithmetic verbatim, including the fact that it makes SHORT passphrases cost
 * MORE (`passphraseLen` counts DOWN from 15). It looks like a bug and is not
 * ours to fix: it is on the wire, and a payload written under it can only be
 * read back by repeating it. `decryptString` upstream tries `false` then `true`,
 * and so do we.
 */
async function deriveLegacyKey(
  passphrase: string,
  salt: Uint8Array,
  autoCalculateIterations: boolean,
): Promise<CryptoKey> {
  const passphraseLen = 15 - passphrase.length;
  const iterations = autoCalculateIterations
    ? (passphraseLen > 0 ? passphraseLen : 0) * 1000 + 121 - passphraseLen
    : LEGACY_ITERATIONS;
  const digest = await webcrypto.subtle.digest({ name: 'SHA-256' }, utf8.encode(passphrase));
  const material = await webcrypto.subtle.importKey('raw', digest, { name: 'PBKDF2' }, false, [
    'deriveKey',
  ]);
  return await webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * V2 (`%`): fixed character offsets, not a delimiter scan.
 *
 *     "%" + hex(iv[16]) + hex(salt[16]) + base64(ciphertext||tag)
 *
 * Offsets `1..33`, `33..65`, `65..` are upstream's own `substring` bounds. Note
 * the 16-byte IV: AES-GCM's usual IV is 12 bytes, and WebCrypto accepts other
 * lengths by internally hashing them, which is why this interoperates at all.
 */
async function decryptV2(encrypted: string, passphrase: string, auto: boolean): Promise<string> {
  if (encrypted.length < 1 + LEGACY_IV_LENGTH * 2 + LEGACY_SALT_LENGTH * 2) {
    throw new SetupUriError('malformed-payload', 'V2 payload shorter than its own header');
  }
  const iv = hexToBytes(encrypted.substring(1, 33));
  const salt = hexToBytes(encrypted.substring(33, 65));
  const ciphertext = base64ToBytes(encrypted.substring(65));
  const key = await deriveLegacyKey(passphrase, salt, auto);
  const plain = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return utf8Decoder.decode(new Uint8Array(plain));
}

/**
 * V1 (`[`): a three-element JSON array of strings.
 *
 *     ["<base64 ciphertext>", "<32 hex chars iv>", "<32 hex chars salt>"]
 *
 * THE ASYMMETRY THAT WILL BITE ANYONE WHO SKIPS THIS COMMENT: V1 applies
 * `JSON.stringify` to the plaintext BEFORE encrypting and `JSON.parse` AFTER
 * decrypting. Those cancel, so at this function's boundary V1 returns the same
 * string the other envelopes do. Do not add a layer to "match" the others, and
 * do not remove this one: either change produces a payload that decrypts to a
 * JSON-quoted string instead of a settings object.
 *
 * Upstream parses the array with a naive `split(",")`. We use `JSON.parse`,
 * which is strictly more correct and identical on real input (neither base64 nor
 * hex contains a comma), and refuses malformed input rather than silently
 * yielding undefined elements.
 */
async function decryptV1(encrypted: string, passphrase: string, auto: boolean): Promise<string> {
  let parts: unknown;
  try {
    parts = JSON.parse(encrypted);
  } catch {
    throw new SetupUriError('malformed-payload', 'V1 envelope is not a JSON array');
  }
  if (
    !Array.isArray(parts) ||
    parts.length < 3 ||
    !parts.slice(0, 3).every((p) => typeof p === 'string')
  ) {
    throw new SetupUriError('malformed-payload', 'V1 envelope is not [data, iv, salt]');
  }
  const [data, ivHex, saltHex] = parts as [string, string, string];
  const key = await deriveLegacyKey(passphrase, hexToBytes(saltHex), auto);
  const plain = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: hexToBytes(ivHex) },
    key,
    base64ToBytes(data),
  );
  const stringified = utf8Decoder.decode(new Uint8Array(plain));
  // The inner JSON.parse. See the asymmetry note above.
  const inner: unknown = JSON.parse(stringified);
  if (typeof inner !== 'string') {
    throw new SetupUriError('malformed-payload', 'V1 inner payload is not a string');
  }
  return inner;
}

/**
 * Decrypt any envelope the plugin is capable of producing for a Setup URI.
 *
 * Dispatch order matters: `%$` and `%~` must both be tested BEFORE the bare `%`,
 * since `'%$abc'.startsWith('%')` is true. Upstream's dispatcher has the same
 * ordering requirement and satisfies it the same way.
 *
 * `%~` (V3) is recognised and refused rather than silently misrouted into V2.
 * V3 is a CHUNK encryption format: nothing in the string-encryption path emits
 * it, so a `%~` Setup URI is not something any plugin build produces. Naming it
 * explicitly means a future encounter produces an honest "unsupported format"
 * instead of a decryption failure that reads as a wrong passphrase.
 */
async function decryptEnvelope(encrypted: string, passphrase: string): Promise<string> {
  const fail = (e: unknown) =>
    new SetupUriError(
      'decryption-failed',
      `decryption failed: ${e instanceof Error ? e.message : String(e)}`,
    );

  if (encrypted.startsWith(HKDF_SALTED_PREFIX)) {
    try {
      return await decryptHkdf(encrypted, passphrase);
    } catch (e) {
      if (e instanceof SetupUriError) throw e;
      throw fail(e);
    }
  }
  if (encrypted.startsWith(ENCRYPT_V3_PREFIX)) {
    throw new SetupUriError(
      'unsupported-format',
      'V3 (%~) envelopes are a chunk format and are not produced for Setup URIs',
    );
  }
  const legacy =
    encrypted.startsWith(ENCRYPT_V2_PREFIX) || encrypted.startsWith(ENCRYPT_V1_PREFIX)
      ? encrypted.startsWith(ENCRYPT_V1_PREFIX)
        ? decryptV1
        : decryptV2
      : null;
  if (!legacy) {
    throw new SetupUriError('unsupported-format', 'unrecognised encryption envelope');
  }
  // Both iteration modes, in upstream's order. A payload carries no flag saying
  // which was used, so trying is the only available answer.
  let lastError: unknown;
  for (const auto of [false, true]) {
    try {
      return await legacy(encrypted, passphrase, auto);
    } catch (e) {
      if (e instanceof SetupUriError && e.reason === 'malformed-payload') throw e;
      lastError = e;
    }
  }
  throw fail(lastError);
}

// ---------------------------------------------------------------------------
// The settings payload
// ---------------------------------------------------------------------------

/**
 * The plugin-side keys this codec understands, as a partial view over a settings
 * object that really has ~150 of them.
 *
 * Everything is optional because absent keys are NORMAL in this format: the
 * plugin merges a decoded object over `DEFAULT_SETTINGS` and never validates for
 * completeness, so a URI legitimately omits most of the surface.
 */
export interface PluginSetupSettings {
  couchDB_URI?: unknown;
  couchDB_DBNAME?: unknown;
  couchDB_USER?: unknown;
  couchDB_PASSWORD?: unknown;
  passphrase?: unknown;
  encrypt?: unknown;
  usePathObfuscation?: unknown;
  liveSync?: unknown;
  periodicReplication?: unknown;
  periodicReplicationInterval?: unknown;
  remoteType?: unknown;
  P2P_Enabled?: unknown;
  [key: string]: unknown;
}

/** The 9-field LiveSync block this server actually stores. */
export interface LiveSyncBlockView {
  uri: string;
  database: string;
  username: string;
  password: string;
  passphrase: string;
  obfuscatePassphrase: string;
  liveMode: boolean;
  intervalSec: number;
}

/**
 * A decoded URI, split by how the caller is allowed to treat each part.
 *
 * `block` is the allowlisted, type-checked projection onto our own schema, and is
 * the ONLY part an apply path may act on. `carryOver` is every other key exactly
 * as it arrived; it exists so a round trip is lossless and MUST NOT be persisted
 * or merged into a settings draft (see the layering note at the top of the file).
 */
export interface DecodedSetupUri {
  block: LiveSyncBlockView;
  carryOver: Record<string, unknown>;
  /** True when the source URI asked for path obfuscation. */
  usePathObfuscation: boolean;
  /** True when the source URI had E2EE enabled. */
  encrypt: boolean;
}

/**
 * Hard ceiling on an accepted URI, applied BEFORE any key derivation.
 *
 * A legitimate URI carrying the plugin's entire settings surface is a few
 * kilobytes. Without a cap, a caller can hand us megabytes and make us run
 * PBKDF2 over it: the legacy branch runs the derivation twice, so the ATTACKER
 * chooses the work factor. Bounding the input first turns that from a CPU
 * amplifier into a cheap rejection.
 */
export const MAX_SETUP_URI_LENGTH = 64 * 1024;

/** Minimum length for a Setup URI passphrase. */
export const MIN_SETUP_URI_PASSPHRASE_LENGTH = 12;

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asBool(v: unknown): boolean {
  return v === true;
}

/**
 * Keys that must never survive a decode into anything we store or re-emit.
 *
 * Two groups, dropped for different reasons but with the same mechanism:
 *
 *  - DEVICE-LOCAL identity (`deviceAndVaultName`, `P2P_DevicePeerName`): copying
 *    one device's identity onto another is how two peers end up claiming the same
 *    node id. The plugin drops these itself via its `stripExtra` flag.
 *  - AT-REST SECRETS AND LOCAL STATE (`configPassphrase`, `encryptedPassphrase`,
 *    `encryptedCouchDBConnection`, `configPassphraseStore`): these describe how
 *    ONE device encrypted its own `data.json`. Transplanting them produces a
 *    device that cannot read its own configuration, and `configPassphrase` is
 *    documented as never leaving its device in the first place.
 *
 * They are dropped from `carryOver` too, not merely from `block`: carry-over is
 * re-emitted on export, and re-emitting a foreign device's at-rest key material
 * would propagate the problem to a third device.
 */
const NEVER_CARRIED = new Set([
  'deviceAndVaultName',
  'P2P_DevicePeerName',
  'configPassphrase',
  'configPassphraseStore',
  'encryptedPassphrase',
  'encryptedCouchDBConnection',
  'isConfigured',
  'useIndexedDBAdapter',
]);

/**
 * Keys we project onto our own block. Excluded from `carryOver` so that one
 * value never has two homes: if both existed, an export would emit our block's
 * value AND a stale carried copy, and which one the receiving plugin honoured
 * would depend on key order.
 */
const PROJECTED = new Set([
  'couchDB_URI',
  'couchDB_DBNAME',
  'couchDB_USER',
  'couchDB_PASSWORD',
  'passphrase',
  'encrypt',
  'usePathObfuscation',
  'liveSync',
  'periodicReplication',
  'periodicReplicationInterval',
]);

/**
 * Decode a Setup URI into our block plus everything else.
 *
 * The pipeline is upstream's, inverted, and the reference implementation is
 * written out longhand in the plugin's own wizard
 * (`UseSetupURI.svelte`), which is worth more than the opaque commonlib helper:
 *
 *     substring(configURIBase.length) -> decodeURIComponent -> decryptString -> JSON.parse
 *
 * Everything after the decrypt is treated as HOSTILE. It is `JSON.parse` over
 * attacker-controlled plaintext, so there is no spread and no `Object.assign`
 * into anything: named fields are read out and type-checked one at a time. A
 * `__proto__` key in the payload lands in `carryOver` as an own property of a
 * null-prototype object and can never reach a prototype chain.
 */
export async function decodeSetupUri(uri: string, passphrase: string): Promise<DecodedSetupUri> {
  if (typeof uri !== 'string' || uri.length > MAX_SETUP_URI_LENGTH) {
    throw new SetupUriError('too-large', 'setup URI is missing or too large');
  }
  if (!uri.startsWith(SETUP_URI_BASE)) {
    throw new SetupUriError('not-a-setup-uri', `setup URI must start with ${SETUP_URI_BASE}`);
  }
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new SetupUriError('decryption-failed', 'a passphrase is required');
  }

  const encoded = uri.substring(SETUP_URI_BASE.length);
  let envelope: string;
  try {
    envelope = decodeURIComponent(encoded);
  } catch {
    // decodeURIComponent throws URIError on a malformed escape such as "%zz".
    throw new SetupUriError('malformed-payload', 'setup URI is not correctly percent-encoded');
  }

  const json = await decryptEnvelope(envelope, passphrase);

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SetupUriError('malformed-payload', 'decrypted payload is not JSON');
  }
  // `typeof null === 'object'`, and an array is an object too. Both would pass a
  // naive check and then read as a settings object with every field undefined.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SetupUriError('malformed-payload', 'decrypted payload is not a settings object');
  }

  const src = parsed as PluginSetupSettings;
  const encrypt = asBool(src.encrypt);
  const usePathObfuscation = asBool(src.usePathObfuscation);

  /*
   * `passphrase` is adopted ONLY when `encrypt` is true.
   *
   * The plugin stores the passphrase and the enable flag separately, so a
   * settings object can perfectly well carry a leftover passphrase with
   * `encrypt: false`. Copying it into our block would flip E2EE ON for a remote
   * whose documents are written in the clear, and the resulting mismatch is the
   * `IncompatibleChanges` class: it corrupts rather than erroring.
   */
  const decodedPassphrase = encrypt ? asString(src.passphrase) : '';

  /*
   * The obfuscation shape mismatch, resolved in the only representable direction.
   *
   * The plugin has NO separate obfuscation passphrase: `usePathObfuscation` is a
   * boolean and obfuscation is keyed off the SAME `passphrase`. We store a
   * string. So an imported `usePathObfuscation: true` can only mean "obfuscate
   * using the encryption passphrase", and anything else would be inventing a
   * value the source device is not using, which yields divergent `f:` document
   * ids for the same path on the two devices.
   */
  const obfuscatePassphrase = usePathObfuscation ? decodedPassphrase : '';

  /*
   * The plugin splits "is periodic replication on" from "how often". We fold both
   * into one number, so an interval is only meaningful when the flag is on;
   * otherwise we keep our own default rather than adopting a dormant value that
   * would silently become the live one.
   */
  const rawInterval = src.periodicReplicationInterval;
  const periodicOn = asBool(src.periodicReplication);
  const intervalSec =
    periodicOn && typeof rawInterval === 'number' && Number.isFinite(rawInterval)
      ? Math.max(1, Math.floor(rawInterval))
      : 30;

  // Null prototype: `carryOver` is built from attacker-controlled keys, and this
  // makes a literal "__proto__" key inert rather than special.
  const carryOver: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(src)) {
    if (PROJECTED.has(key) || NEVER_CARRIED.has(key)) continue;
    carryOver[key] = value;
  }

  return {
    block: {
      uri: asString(src.couchDB_URI).trim().replace(/\/+$/, ''),
      database: asString(src.couchDB_DBNAME).trim(),
      username: asString(src.couchDB_USER).trim(),
      // Never trimmed: key material, byte-for-byte. Same rule as the schema's.
      password: asString(src.couchDB_PASSWORD),
      passphrase: decodedPassphrase,
      obfuscatePassphrase,
      liveMode: asBool(src.liveSync),
      intervalSec,
    },
    carryOver,
    usePathObfuscation,
    encrypt,
  };
}

/**
 * True when a decoded URI describes a remote this server cannot actually drive.
 *
 * We have exactly one backend: CouchDB. A URI describing an S3/MinIO bucket or a
 * P2P room decodes perfectly well and would apply perfectly well, and then this
 * server would sit there syncing nothing while reporting itself configured. That
 * is the silent-failure outcome the whole project is meant to rule out, so it is
 * a refusal rather than a warning.
 */
export function unsupportedRemoteReason(decoded: DecodedSetupUri): string | null {
  const remoteType = decoded.carryOver.remoteType;
  if (typeof remoteType === 'string' && remoteType && remoteType.toLowerCase() !== 'couchdb') {
    return `this Setup URI configures a "${remoteType}" remote; WebObsidian only supports CouchDB`;
  }
  if (decoded.carryOver.P2P_Enabled === true) {
    return 'this Setup URI configures peer-to-peer replication, which WebObsidian does not support';
  }
  if (!decoded.block.uri) {
    return 'this Setup URI carries no CouchDB URL';
  }
  return null;
}

/**
 * Encode our block (plus any carried keys) into a Setup URI.
 *
 * `carryOver` is written FIRST and the projected keys second, so our own values
 * always win over a stale carried copy of the same key. `NEVER_CARRIED` is
 * filtered again here rather than trusted from the decode side, because this
 * function is public and a caller can hand it any object.
 *
 * WHAT IS DELIBERATELY NOT EMITTED, and why each absence is correct:
 *
 *  - `E2EEAlgorithm` / `chunkSplitterVersion`. These look like obvious things to
 *    publish, and emitting them would be a lie. This server does not pin them:
 *    `peer-couchdb.ts` ADOPTS both from the remote milestone document, which is
 *    the cluster's authoritative statement about how its documents are encoded.
 *    The joining device does exactly the same on first contact. Emitting a
 *    locally-guessed value would hand it a tweak that may disagree with the
 *    cluster it is about to join, and disagreement on these keys is a
 *    replication-correctness fault rather than a visible error.
 *  - `syncInternalFiles`. Our `includeInternal` is a list of host directories,
 *    which is information about this server's filesystem layout that a joining
 *    phone has no use for and should not receive.
 *  - `isConfigured`. It is the receiving plugin's own view of its own state.
 */
export async function encodeSetupUri(
  block: LiveSyncBlockView,
  passphrase: string,
  carryOver: Record<string, unknown> = {},
): Promise<string> {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_SETUP_URI_PASSPHRASE_LENGTH) {
    throw new SetupUriError(
      'unrepresentable',
      `the Setup URI passphrase must be at least ${MIN_SETUP_URI_PASSPHRASE_LENGTH} characters`,
    );
  }

  /*
   * The one configuration this format cannot express, refused rather than
   * approximated.
   *
   * We store `obfuscatePassphrase` as an independent string; the plugin has only
   * the boolean `usePathObfuscation` and keys obfuscation off `passphrase`. When
   * the two differ there is no honest encoding: emitting `usePathObfuscation:
   * true` would tell the joining device to hash document ids under `passphrase`
   * while this server hashes them under a different string, so both devices would
   * write `f:<hash>` ids for the SAME path under DIFFERENT hashes. Every file
   * would silently become two permanently divergent documents.
   *
   * That is vault corruption presenting as "sync seems to be working", which is
   * precisely the failure class the refusal exists to prevent. Emitting `false`
   * instead would be no better: it would turn obfuscation off on the joining
   * device while this one keeps it on, with the same divergence.
   */
  if (block.obfuscatePassphrase && block.obfuscatePassphrase !== block.passphrase) {
    throw new SetupUriError(
      'unrepresentable',
      'livesync.obfuscatePassphrase differs from livesync.passphrase. Self-hosted LiveSync has no ' +
        'separate obfuscation passphrase: it derives path obfuscation from the encryption passphrase, ' +
        'so this configuration cannot be expressed in a Setup URI. Set both to the same value to pair ' +
        'with another device.',
    );
  }

  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(carryOver)) {
    if (PROJECTED.has(key) || NEVER_CARRIED.has(key)) continue;
    payload[key] = value;
  }

  payload.couchDB_URI = block.uri;
  payload.couchDB_DBNAME = block.database;
  payload.couchDB_USER = block.username;
  payload.couchDB_PASSWORD = block.password;
  // `encrypt` is derived from the passphrase rather than carried, for the same
  // reason the decode side gates on it: the flag and the key must agree, and the
  // presence of a key is the only fact we actually have.
  payload.encrypt = Boolean(block.passphrase);
  payload.passphrase = block.passphrase;
  payload.usePathObfuscation = Boolean(block.obfuscatePassphrase);
  payload.liveSync = block.liveMode;
  // Mutually exclusive by construction: live replication holds an open changes
  // feed, so a plugin told to do both would poll on top of a live feed.
  payload.periodicReplication = !block.liveMode;
  payload.periodicReplicationInterval = block.intervalSec;

  const envelope = await encryptHkdf(JSON.stringify(payload), passphrase);
  return SETUP_URI_BASE + encodeURIComponent(envelope);
}
