import { scrypt, randomBytes, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { getSettings, updateSettings, type Settings } from './settings.js';
import { isDefaultPasswordActive } from './password-policy.js';
import { config } from '../config.js';

const KEYLEN = 64;

/**
 * Hand-rolled rather than `promisify(scrypt)`: `crypto.scrypt` is overloaded
 * (with and without an options object) and promisify's inference picks one of
 * those overloads, so passing explicit cost parameters through it is a coin
 * flip on the @types/node version in use. An explicit wrapper types cleanly and
 * makes the resolved buffer's type obvious at every call site.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

/** Default password at install time: usable right away, with no setup step. */
export const DEFAULT_PASSWORD = '123456';
export const MIN_PASSWORD_LEN = 6;

/** ---- scrypt cost parameters --------------------------------------------- */

interface ScryptParams {
  /** CPU/memory cost. Must be a power of two. */
  N: number;
  /** Block size. Working-set memory is 128 * N * r bytes. */
  r: number;
  /** Parallelisation. */
  p: number;
}

/**
 * Cost parameters used for every hash this build writes.
 *
 * The stored string used to be `scrypt$<salt>$<hash>` with no parameters in it,
 * which meant the hash was implicitly pinned to whatever Node's defaults were on
 * the day it was written (N=2^14). There was no way to raise the cost later: a
 * verify would have had to guess which cost produced the stored digest, so the
 * only options were "never change it" or "invalidate every password on the
 * instance". Writing the parameters into the string is what makes the cost a
 * migrateable value rather than a permanent one, see verifyPassword/needsRehash.
 *
 * N=2^17, r=8 is a 128 MiB working set per hash and roughly half a second of
 * CPU on current hardware. That is deliberately expensive: the whole point of a
 * memory-hard KDF is that an offline attacker who exfiltrates settings.json
 * cannot cheaply grind the six-character minimum password we allow.
 */
const SCRYPT_PARAMS: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };

/**
 * What Node's `scrypt` defaults to, and therefore what every stored hash in the
 * legacy 3-field format was produced with. Never used for new hashes.
 */
const LEGACY_SCRYPT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1 };

/**
 * Node refuses to allocate past `maxmem` (default 32 MiB), which is well under
 * the 128 MiB that N=2^17,r=8 needs, so the limit has to be raised explicitly
 * or every hash throws. Derived from the parameters rather than hardcoded so
 * that reading an old (or a future) hash raises exactly the headroom that hash
 * needs. The factor of two is slack for scrypt's internal buffers.
 */
function maxmemFor(p: ScryptParams): number {
  return 128 * p.N * p.r * 2;
}

/**
 * Reject parameter sets that are not plausibly a real hash's parameters.
 *
 * The values come out of a string that lives in settings.json (owner-writable)
 * and in the share records, so this is not a hostile-input boundary in the usual
 * sense: anyone who can write those files already owns the instance. It is a
 * guard against a typo turning into a multi-gigabyte allocation attempt on the
 * login path, where the failure mode would be an OOM rather than a 401.
 */
function plausibleParams(p: ScryptParams): boolean {
  if (!Number.isInteger(p.N) || !Number.isInteger(p.r) || !Number.isInteger(p.p)) return false;
  // N must be a power of two (scrypt itself requires it) and stay inside a sane
  // band: 2^14 is Node's default, 2^20 is a 1 GiB working set.
  if (p.N < 2 ** 14 || p.N > 2 ** 20 || (p.N & (p.N - 1)) !== 0) return false;
  if (p.r < 1 || p.r > 32) return false;
  if (p.p < 1 || p.p > 16) return false;
  return true;
}

/**
 * Cap how many scrypt computations run at once.
 *
 * Each one holds 128 MiB while it runs, and Node's async scrypt runs on the
 * libuv threadpool (4 threads by default), so without a cap four concurrent
 * password checks reserve half a gigabyte and simultaneously starve every
 * fs operation in the process, which on this server means the vault itself.
 * The reachable path is not the throttled login route but
 * `POST /public/shares/:id/unlock`, which is unauthenticated and calls
 * verifyPassword directly: raising the KDF cost without this cap would have
 * turned a share link into a memory-exhaustion amplifier.
 *
 * Excess callers queue rather than fail. A slow login is a far better outcome
 * than an OOM-killed process, and the queue entries themselves cost nothing.
 */
const MAX_CONCURRENT_SCRYPT = 2;
let scryptInFlight = 0;
const scryptWaiters: Array<() => void> = [];

function acquireScryptSlot(): Promise<void> {
  if (scryptInFlight < MAX_CONCURRENT_SCRYPT) {
    scryptInFlight++;
    return Promise.resolve();
  }
  // The waiter inherits the slot of whoever wakes it, so the counter is not
  // touched here. Incrementing on wake instead would let a caller that arrives
  // between the release and the wake slip past the cap.
  return new Promise<void>((resolve) => scryptWaiters.push(resolve));
}

function releaseScryptSlot(): void {
  const next = scryptWaiters.shift();
  if (next) {
    next();
    return;
  }
  scryptInFlight--;
}

async function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  await acquireScryptSlot();
  try {
    return await scryptAsync(password, salt, KEYLEN, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: maxmemFor(params),
    });
  } finally {
    releaseScryptSlot();
  }
}

/** ---- Stored hash format --------------------------------------------------- */
//
// Two formats are readable, exactly one is written:
//
//   legacy:  scrypt$<saltHex>$<hashHex>                       (params implicit)
//   current: scrypt$N=131072,r=8,p=1$<saltHex>$<hashHex>
//
// The field count disambiguates them, and the parameter field is `$`-free by
// construction, so the two can never be confused. Legacy hashes stay verifiable
// forever (a share created three versions ago must still unlock); they are
// upgraded opportunistically on the one occasion the plaintext is available,
// which is a successful login.

function encodeParams(p: ScryptParams): string {
  return `N=${p.N},r=${p.r},p=${p.p}`;
}

function parseParams(field: string): ScryptParams | null {
  const m = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(field);
  if (!m) return null;
  const parsed: ScryptParams = { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
  return plausibleParams(parsed) ? parsed : null;
}

interface StoredHash {
  params: ScryptParams;
  salt: Buffer;
  expected: Buffer;
  /** True when the string is in the old 3-field form, or its cost is not current. */
  stale: boolean;
}

const isHex = (s: string): boolean => s.length > 0 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s);

function parseStored(stored: string): StoredHash | null {
  const parts = stored.split('$');
  if (parts[0] !== 'scrypt') return null;

  let params: ScryptParams | null;
  let saltHex: string;
  let hashHex: string;
  if (parts.length === 3) {
    params = LEGACY_SCRYPT_PARAMS;
    saltHex = parts[1];
    hashHex = parts[2];
  } else if (parts.length === 4) {
    params = parseParams(parts[1]);
    saltHex = parts[2];
    hashHex = parts[3];
  } else {
    return null;
  }
  if (!params) return null;
  // Buffer.from(x, 'hex') stops silently at the first non-hex character, so a
  // corrupted field would otherwise decode to a short buffer and be compared as
  // if it were a legitimate (shorter) digest.
  if (!isHex(saltHex) || !isHex(hashHex)) return null;

  const stale =
    parts.length === 3 ||
    params.N !== SCRYPT_PARAMS.N ||
    params.r !== SCRYPT_PARAMS.r ||
    params.p !== SCRYPT_PARAMS.p;

  return { params, salt: Buffer.from(saltHex, 'hex'), expected: Buffer.from(hashHex, 'hex'), stale };
}

/** Timing-safe string comparison (for the plaintext override password). */
function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** scrypt$<params>$<saltHex>$<hashHex>, using the current cost parameters. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await derive(password, salt, SCRYPT_PARAMS);
  return `scrypt$${encodeParams(SCRYPT_PARAMS)}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const rec = parseStored(stored);
  if (!rec) return false;
  const derived = await derive(password, rec.salt, rec.params);
  return derived.length === rec.expected.length && timingSafeEqual(derived, rec.expected);
}

/**
 * True when `stored` was produced with anything other than the current cost.
 * Callers that hold the plaintext (i.e. a successful login) can use this to
 * re-hash in place; nobody else can, which is why the upgrade has to be
 * opportunistic rather than a migration.
 */
export function needsRehash(stored: string): boolean {
  const rec = parseStored(stored);
  // Unparseable means nothing can be done with it, so do not claim it is
  // upgradeable: rewriting it would destroy a hash we simply failed to read.
  return rec ? rec.stale : false;
}

/**
 * Has the instance moved off the default password yet? "Custom" here includes an
 * operator-configured override (`auth.passwordHash` / `WEBOBSIDIAN_PASSWORD`), not
 * just a password set through the UI: once an override exists, `123456` is no
 * longer accepted (see `isDefaultPasswordActive`), so we must not force the user
 * to go and change it.
 */
export async function hasCustomPassword(): Promise<boolean> {
  const s = await getSettings();
  return !isDefaultPasswordActive(s.auth);
}

/** Store a new user password (overwrites the default password / the previous one). */
export async function setUserPassword(password: string): Promise<void> {
  if (password.length < MIN_PASSWORD_LEN) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LEN} characters`);
  }
  const hash = await hashPassword(password);
  await updateSettings((d) => {
    d.auth.userPasswordHash = hash;
  });
}

/** ---- Login ---------------------------------------------------------------- */

/**
 * Which credential a successful password check matched. The distinction exists
 * so the caller can audit-log use of the recovery overrides: those are always
 * accepted, never expire, and (for `override-env`) sit in the container
 * environment for the life of the deployment, so their use has to be visible
 * somewhere rather than being indistinguishable from a normal login.
 */
export type CredentialKind = 'user' | 'default' | 'override-hash' | 'override-env';

/**
 * Check a login password and report WHICH credential matched. Accepts:
 *  1) The user password (userPasswordHash), or the default 123456, but ONLY when
 *     no other credential has been configured.
 *  2) A recovery override password: auth.passwordHash (a hash, edited in by hand)
 *     or the WEBOBSIDIAN_PASSWORD env var (plaintext). Both are always accepted.
 * Returns null when nothing matched.
 */
export async function authenticatePassword(password: string): Promise<CredentialKind | null> {
  const s = await getSettings();

  // (1) The effective login password. The default branch must go through
  // isDefaultPasswordActive(): it previously tested `userPasswordHash` alone, so
  // setting WEBOBSIDIAN_PASSWORD without ever opening the UI still let `123456` in.
  if (s.auth.userPasswordHash) {
    if (await verifyPassword(password, s.auth.userPasswordHash)) {
      await upgradeUserHash(password, s.auth.userPasswordHash);
      return 'user';
    }
  } else if (isDefaultPasswordActive(s.auth) && safeEqualStr(password, DEFAULT_PASSWORD)) {
    return 'default';
  }

  // (2) Override (recovery) password: always checked, even after a password change.
  if (s.auth.passwordHash && (await verifyPassword(password, s.auth.passwordHash))) {
    return 'override-hash';
  }
  if (config.initialPassword && safeEqualStr(password, config.initialPassword)) {
    return 'override-env';
  }

  return null;
}

/** Boolean form, for callers that do not care which credential matched. */
export async function checkPassword(password: string): Promise<boolean> {
  return (await authenticatePassword(password)) !== null;
}

/**
 * Re-hash the stored user password at the current cost, on the one occasion the
 * plaintext is in hand. Failure is deliberately non-fatal: a login must not be
 * refused because an optional cost upgrade could not be persisted.
 *
 * `auth.passwordHash` (the recovery override) is NOT upgraded here even when it
 * is in the legacy format. It is documented as a value the operator hand-edits
 * into settings.json, and silently rewriting it would make the file stop
 * matching what they wrote, which is exactly the confusion the v1 -> v2 settings
 * migration was fixed to avoid.
 */
async function upgradeUserHash(password: string, observed: string): Promise<void> {
  if (!needsRehash(observed)) return;
  try {
    const upgraded = await hashPassword(password);
    await updateSettings((d) => {
      // Compare-and-set inside the settings lock. Hashing at N=2^17 takes long
      // enough for a real password change to land in between, and an unconditional
      // assignment here would silently restore the OLD password after the user
      // had already changed it.
      if (d.auth.userPasswordHash === observed) d.auth.userPasswordHash = upgraded;
    });
  } catch (err) {
    console.warn('[auth] could not upgrade stored password hash:', (err as Error).message);
  }
}

/**
 * Record use of a recovery override credential.
 *
 * The overrides are a documented recovery path and are staying, but they are
 * permanent master credentials with no expiry: `WEBOBSIDIAN_PASSWORD` in
 * particular lives in the container environment for the whole life of the
 * deployment and is accepted forever, including after the owner has changed
 * their password. Until now the only trace of one being used was that a login
 * succeeded, which is indistinguishable from the owner logging in normally.
 * One line per use is the minimum that makes the mechanism auditable.
 *
 * Logs the credential KIND only. The password, the hash and the env value never
 * appear: this line ends up in the same log stream as everything else and,
 * on desktop, in a file on disk.
 */
export function auditCredentialUse(kind: CredentialKind, action: string, client?: string): void {
  if (kind !== 'override-hash' && kind !== 'override-env') return;
  const source = kind === 'override-env' ? 'WEBOBSIDIAN_PASSWORD env' : 'auth.passwordHash setting';
  console.warn(
    `[audit] recovery override password accepted for ${action} (source: ${source}${client ? `, client: ${client}` : ''})`,
  );
}

/** Change the password: verify the current one, then store the new one. */
export async function changePassword(current: string, next: string): Promise<void> {
  const kind = await authenticatePassword(current);
  if (!kind) throw new Error('Current password is incorrect');
  auditCredentialUse(kind, 'change-password');
  await setUserPassword(next);
}

/** ---- Session tokens ------------------------------------------------------- */

const TOKEN_TTL = '30d';

/**
 * Binds a session token to the credential state it was issued under.
 *
 * There is no server-side session store here (settings.json is the only
 * persistence and it is not a session table), so a 30-day JWT was previously
 * irrevocable: anyone who captured the cookie kept owner access for a month, and
 * neither changing the password nor pressing "Log out" evicted them. Comparing a
 * claim against a value derived from the current credentials gives us
 * invalidation-on-password-change without a store: change the password and every
 * token minted under the old one stops verifying on the next request.
 *
 * Why this rather than rotating `jwtSecret`, which would also invalidate
 * everything: the same secret signs the public share unlock cookies
 * (routes/shares.ts). Rotating it would silently log out every visitor holding a
 * link to a password-protected share, an outward-facing side effect of a private
 * action. Scoping the invalidation to the `sub: 'owner'` tokens keeps share
 * unlock cookies working exactly as before, which is the correct blast radius
 * for "the owner changed their password".
 *
 * The inputs are the three things that can authenticate as owner, so rotating
 * the recovery override (settings or env) also evicts existing sessions. HMAC
 * rather than a bare hash because the result is published inside a JWT payload,
 * which is readable by anyone holding the cookie; keyed with `jwtSecret`, it
 * discloses nothing about the password hashes it covers.
 */
function credentialFingerprint(s: Settings): string {
  const material = JSON.stringify([
    s.auth.userPasswordHash,
    s.auth.passwordHash,
    config.initialPassword ?? '',
  ]);
  return createHmac('sha256', s.auth.jwtSecret).update(material).digest('hex').slice(0, 32);
}

export async function issueToken(): Promise<string> {
  const s = await getSettings();
  return jwt.sign({ sub: 'owner', cv: credentialFingerprint(s) }, s.auth.jwtSecret, {
    expiresIn: TOKEN_TTL,
    algorithm: 'HS256',
  });
}

/**
 * Verify an OWNER session token. Beyond a valid signature, the token is required
 * to carry `sub === 'owner'` and to use exactly the HS256 algorithm. That stops
 * other tokens signed with the same `jwtSecret` (for example a public share's
 * unlock cookie, which carries `sub: 'share'`) from being replayed as a full
 * owner session.
 *
 * It must also carry a `cv` claim matching the current credential fingerprint.
 * A token minted before this claim existed has no `cv` and is rejected outright:
 * accepting one "for compatibility" would leave the exact bypass the claim is
 * there to close, since a stolen pre-upgrade cookie is precisely the token an
 * attacker would replay. The visible consequence is that every session is logged
 * out once, on the deploy that introduces this.
 */
export async function verifyToken(token: string): Promise<boolean> {
  try {
    const s = await getSettings();
    const payload = jwt.verify(token, s.auth.jwtSecret, { algorithms: ['HS256'] });
    if (typeof payload !== 'object' || payload === null) return false;
    if (payload.sub !== 'owner') return false;
    const cv = (payload as { cv?: unknown }).cv;
    return typeof cv === 'string' && safeEqualStr(cv, credentialFingerprint(s));
  } catch {
    return false;
  }
}

/** ---- API keys ----------------------------------------------------------- */

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Returns { raw, record-fields }. `raw` is shown to the user exactly once. */
export function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const raw = `wok_${randomBytes(24).toString('base64url')}`;
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, 12) };
}
