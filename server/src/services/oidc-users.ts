import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';

/**
 * A record of every IdP identity that has ever signed in, kept OUT of
 * settings.json.
 *
 * WHAT THIS IS FOR, stated plainly because it grants nothing and would otherwise
 * look like dead code. Today this app has exactly one account. Every allowlisted
 * IdP subject maps onto that single owner, so NOTHING in this file authorizes
 * anything: no read of it gates a request, no absence of a record denies one, and
 * adding a row by hand does not create a user. It exists so that the day a real
 * user model arrives, the question "who has actually used this instance, and
 * under what identity?" is answerable from data we already have. That turns the
 * multi-user step into a MIGRATION (walk these records, mint a user row per key,
 * carry the display claims across) instead of a REWRITE that starts from an empty
 * table and asks every existing user to re-enrol.
 *
 * That is the specific failure this project set out to avoid: a reverse-proxy
 * forward-auth authenticates and then discards the subject, so the app never
 * learns an identity and there is one owner session forever with no groundwork
 * under it. An SSO implementation that authenticates and then throws the subject
 * away is the same failure wearing different clothes. Persisting the identity is
 * the whole point of doing this natively.
 *
 * WHY A SEPARATE FILE rather than a block in settings.json, for the same reason
 * services/apikey-usage.ts is separate: this is written on the login path and is
 * pure record-keeping, while settings.json holds the password hashes, the JWT
 * secret and the sync credentials. A telemetry-grade write has no business
 * queueing behind (or ahead of) a password change over one shared cache and one
 * shared file.
 *
 * The trade is the same one apikey-usage makes, deliberately: this store is
 * best-effort. Writes are debounced and coalesced, and a hard kill can lose up to
 * FLUSH_DEBOUNCE_MS of updates. Losing a `lastSeen` timestamp costs nothing,
 * because nothing authorizes off it; the identity is re-recorded on the next
 * login. Nothing flushes on shutdown, for the reason spelled out at length in
 * apikey-usage.ts (installing a SIGTERM listener would make the server ignore
 * `docker stop` in order to persist a timestamp). `flushOidcUsers()` is exported
 * and ready for a real shutdown sequence in index.ts.
 */

const USERS_FILE = path.join(config.dataDir, 'oidc-users.json');

/** Long enough to coalesce a burst, short enough that disk is never far behind. */
const FLUSH_DEBOUNCE_MS = 10_000;

/** The persisted shape. Deliberately flat and boring: this is a migration source. */
export interface OidcUserRecord {
  /** The issuer identifier the identity was verified against. */
  iss: string;
  /** The IdP's subject identifier. Opaque, stable, never reassigned. */
  sub: string;
  /** ISO timestamp of the first login ever seen for this identity. */
  firstSeen: string;
  /** ISO timestamp of the most recent login. */
  lastSeen: string;
  /** Display claims, as of the most recent login. Any of them may be empty. */
  name: string;
  email: string;
  preferredUsername: string;
}

/** The claims a caller hands in. A subset of services/oidc.ts's OidcIdentity. */
export interface OidcUserClaims {
  iss: string;
  sub: string;
  name?: string;
  email?: string;
  preferredUsername?: string;
}

/**
 * Composite key -> record. Authoritative in memory; the file is durability only.
 *
 * The key is `${iss}|${sub}`. In principle a pipe inside a subject could collide
 * with a pipe in an issuer, but it cannot happen here: the issuer is a single
 * configured URL that the library has already validated the ID token's `iss`
 * against, so every key in this store shares one `iss` prefix and the remainder
 * is the subject verbatim. The record keeps `iss` and `sub` as separate fields
 * anyway, so if this ever does become a multi-issuer store the key can be
 * changed to an unambiguous encoding without losing a single row.
 */
const users = new Map<string, OidcUserRecord>();

let flushTimer: ReturnType<typeof setTimeout> | null = null;
// Same shape as the settings queue and the apikey-usage queue: one chained
// promise, flushes never overlap, and a rejecting flush does not poison the next
// one. Two concurrent flushes would interleave their tmp-write/rename pairs and
// could rename a file the other flush had already replaced.
let flushQueue: Promise<unknown> = Promise.resolve();

/** Build the store key for an identity. Exported so callers never hand-roll it. */
export function oidcUserKey(iss: string, sub: string): string {
  return `${iss}|${sub}`;
}

/**
 * Hydration is fire-and-forget on module load, matching apikey-usage.ts. The only
 * consequence of a login landing before the read completes is that the login's
 * own (fresher) record is kept and the file's older copy is ignored, which is
 * exactly what the guard in hydrate() enforces and exactly what we want.
 */
const hydration: Promise<void> = hydrate();

async function hydrate(): Promise<void> {
  try {
    const raw = await fs.readFile(USERS_FILE, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const record = toRecord(value);
      // Never overwrite what the running process already knows. A login that
      // landed in the window before this read completed has written a FRESHER
      // record, and it also armed the flush timer, so an unconditional set()
      // would write the stale copy back out and make `lastSeen` go backwards
      // across a restart. In-memory is authoritative by design; the file only
      // seeds identities this process has not seen yet.
      if (record && !users.has(key)) users.set(key, record);
    }
  } catch {
    /* absent or unreadable: start empty, the store is rebuilt by use */
  }
}

/**
 * Coerce one on-disk entry into a record, or null.
 *
 * The file is ours, but it sits in a directory an operator can edit and a
 * truncated write can leave half an object behind. A row without `iss`/`sub` is
 * not identifiable and is dropped rather than being carried forward as a
 * half-record that a future migration would have to guess about.
 */
function toRecord(value: unknown): OidcUserRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const str = (key: string): string => (typeof v[key] === 'string' ? (v[key] as string) : '');
  const iss = str('iss');
  const sub = str('sub');
  if (!iss || !sub) return null;
  const lastSeen = str('lastSeen') || str('firstSeen');
  const firstSeen = str('firstSeen') || lastSeen;
  if (!firstSeen || !lastSeen) return null;
  return {
    iss,
    sub,
    firstSeen,
    lastSeen,
    name: str('name'),
    email: str('email'),
    preferredUsername: str('preferredUsername'),
  };
}

/** Await the initial read. Only useful for tests and for a deterministic boot. */
export function whenOidcUsersReady(): Promise<void> {
  return hydration;
}

/**
 * Record a successful SSO login. Returns immediately: the disk write is debounced.
 *
 * `firstSeen` is preserved across every subsequent login, which is the one field
 * here that cannot be reconstructed after the fact. The display claims are
 * overwritten each time, on purpose: they are the IdP's current answer, and an
 * identity whose name or email changed at the IdP should not keep showing the
 * value it had at enrolment. The subject is what stays fixed.
 */
export function recordOidcLogin(
  claims: OidcUserClaims,
  at: string = new Date().toISOString(),
): OidcUserRecord {
  const key = oidcUserKey(claims.iss, claims.sub);
  const existing = users.get(key);
  const record: OidcUserRecord = {
    iss: claims.iss,
    sub: claims.sub,
    firstSeen: existing?.firstSeen ?? at,
    lastSeen: at,
    name: claims.name ?? '',
    email: claims.email ?? '',
    preferredUsername: claims.preferredUsername ?? '',
  };
  users.set(key, record);
  scheduleFlush();
  return record;
}

/** Look one identity up. Synchronous: the map is authoritative. */
export function getOidcUser(iss: string, sub: string): OidcUserRecord | null {
  return users.get(oidcUserKey(iss, sub)) ?? null;
}

/** Every identity this instance has seen, newest login first. */
export function listOidcUsers(): OidcUserRecord[] {
  return [...users.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

function scheduleFlush(): void {
  // Trailing-edge debounce with coalescing: the first change after an idle
  // period arms the timer and every change inside the window rides along on it.
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushOidcUsers();
  }, FLUSH_DEBOUNCE_MS);
  // Never hold the process open for a record-keeping write. Without unref, a
  // pending debounce keeps the event loop alive and delays a clean shutdown
  // (which the Electron shell notices) for no benefit.
  flushTimer.unref?.();
}

/** Write the current map atomically (tmp file, then rename). Serialized. */
export function flushOidcUsers(): Promise<void> {
  const result = flushQueue.then(async () => {
    // Snapshot inside the queued step so the JSON matches what the Map held at
    // write time, not at schedule time.
    const json = JSON.stringify(Object.fromEntries(users), null, 2);
    await fs.mkdir(config.dataDir, { recursive: true });
    const tmp = `${USERS_FILE}.tmp-${randomBytes(4).toString('hex')}`;
    // 0600, and here it is more than hygiene: no key material is in this file,
    // but it is a list of the real names and email addresses of everyone who has
    // signed in, and it sits beside settings.json.
    await fs.writeFile(tmp, json, { mode: 0o600 });
    await fs.rename(tmp, USERS_FILE);
  });
  flushQueue = result.then(
    () => undefined,
    () => undefined,
  );
  // Swallow: a failed record-keeping write must never surface as a failed login.
  // The identity is re-recorded on the next sign-in.
  return result.catch((err: unknown) => {
    console.warn('[oidc-users] could not persist identity records:', String(err));
  });
}
