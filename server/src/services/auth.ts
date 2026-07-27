import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import { getSettings, updateSettings } from './settings.js';
import { isDefaultPasswordActive } from './password-policy.js';
import { config } from '../config.js';

const scryptAsync = promisify(scrypt);
const KEYLEN = 64;

/** Default password at install time: usable right away, with no setup step. */
export const DEFAULT_PASSWORD = '123456';
export const MIN_PASSWORD_LEN = 6;

/** Timing-safe string comparison (for the plaintext override password). */
function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** scrypt$<saltHex>$<hashHex> */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, KEYLEN)) as Buffer;
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const derived = (await scryptAsync(password, salt, KEYLEN)) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Always true: the system always has an effective login password (at minimum the
 * default 123456). Kept around for `/auth/status` and the legacy setup endpoint.
 */
export async function isPasswordSet(): Promise<boolean> {
  return true;
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

/**
 * Check a login password. Accepts:
 *  1) The user password (userPasswordHash), or the default 123456, but ONLY when
 *     no other credential has been configured.
 *  2) A recovery override password: auth.passwordHash (a hash, edited in by hand)
 *     or the WEBOBSIDIAN_PASSWORD env var (plaintext). Both are always accepted.
 */
export async function checkPassword(password: string): Promise<boolean> {
  const s = await getSettings();

  // (1) The effective login password. The default branch must go through
  // isDefaultPasswordActive(): it previously tested `userPasswordHash` alone, so
  // setting WEBOBSIDIAN_PASSWORD without ever opening the UI still let `123456` in.
  if (s.auth.userPasswordHash) {
    if (await verifyPassword(password, s.auth.userPasswordHash)) return true;
  } else if (isDefaultPasswordActive(s.auth) && safeEqualStr(password, DEFAULT_PASSWORD)) {
    return true;
  }

  // (2) Override (recovery) password: always checked, even after a password change.
  if (s.auth.passwordHash && (await verifyPassword(password, s.auth.passwordHash))) return true;
  if (config.initialPassword && safeEqualStr(password, config.initialPassword)) return true;

  return false;
}

/** Change the password: verify the current one, then store the new one. */
export async function changePassword(current: string, next: string): Promise<void> {
  if (!(await checkPassword(current))) throw new Error('Current password is incorrect');
  await setUserPassword(next);
}

const TOKEN_TTL = '30d';

export async function issueToken(): Promise<string> {
  const s = await getSettings();
  return jwt.sign({ sub: 'owner' }, s.auth.jwtSecret, {
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
 */
export async function verifyToken(token: string): Promise<boolean> {
  try {
    const s = await getSettings();
    const payload = jwt.verify(token, s.auth.jwtSecret, { algorithms: ['HS256'] });
    return typeof payload === 'object' && payload !== null && payload.sub === 'owner';
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
