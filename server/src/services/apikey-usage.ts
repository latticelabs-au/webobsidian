import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';

/**
 * "Last used" timestamps for API keys, kept OUT of settings.json.
 *
 * Why this file exists at all: the timestamp is pure telemetry (the UI prints it
 * next to each key) but it is written on the request path, once per authenticated
 * API call. It used to live in settings.json, which also holds the key list, the
 * password hashes, the JWT secret and the git token. That put a high-frequency,
 * unimportant write in direct contention with the most security-critical state in
 * the process: a revocation and a lastUsed bump would race over one shared cache
 * and one shared file, and if the bump landed second it rewrote the whole
 * pre-revocation key array back to disk. The revoked key then worked again, and
 * survived a restart. Settings mutations are serialized now, but a telemetry
 * write should not be queueing behind (or ahead of) a revocation in the first
 * place, so the two stores are simply separate.
 *
 * The trade is deliberate: this store is best-effort. Writes are debounced and
 * coalesced, and a hard kill can lose up to FLUSH_DEBOUNCE_MS of timestamps. That
 * is the correct failure mode for telemetry, and nothing else reads it.
 *
 * On that last point, explicitly, because it looks like an oversight otherwise:
 * nothing flushes on shutdown, so a SIGTERM (a `docker stop`, a systemd restart)
 * drops up to FLUSH_DEBOUNCE_MS of timestamps. That is accepted rather than
 * missed. Closing it from inside this module would mean installing a process
 * SIGTERM listener, and Node removes its own default terminate-on-SIGTERM
 * behaviour the moment a listener exists: a telemetry file would be buying its
 * durability by making the server ignore `docker stop` until the runtime escalates
 * to SIGKILL. A `process.on('exit')` handler does not help either, since 'exit'
 * is not emitted for a signal-terminated process. The right seam is a real
 * shutdown sequence in index.ts calling flushApiKeyUsage(), which is exported and
 * ready for it; until that exists, losing a display-only timestamp is the cheaper
 * of the two failures.
 */

const USAGE_FILE = path.join(config.dataDir, 'apikey-usage.json');

/** Long enough that a busy agent hammering the API produces one write, short
 *  enough that the value on disk is never meaningfully behind. */
const FLUSH_DEBOUNCE_MS = 10_000;

/** keyId -> ISO timestamp. Authoritative in memory; the file is just durability. */
const lastUsed = new Map<string, string>();

let flushTimer: ReturnType<typeof setTimeout> | null = null;
// Same shape as the settings queue: chained promise, never overlapping, a
// rejecting flush does not poison the next one. Two concurrent flushes would
// otherwise interleave their tmp-write/rename pairs and could rename a file that
// the other flush already replaced.
let flushQueue: Promise<unknown> = Promise.resolve();

/**
 * Hydration is fire-and-forget on module load rather than awaited by a caller,
 * because getApiKeyLastUsed() has to stay synchronous: redactSettings() is a
 * sync function on the settings response path and turning it async would ripple
 * through every caller for a display-only field. The only consequence of a read
 * landing before hydration finishes is that the UI briefly shows the seed value
 * from settings.json instead of the newer one, which is harmless.
 */
const hydration: Promise<void> = hydrate();

async function hydrate(): Promise<void> {
  try {
    const raw = await fs.readFile(USAGE_FILE, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      // Defensive: the file is ours, but a truncated or hand-mangled entry must
      // not put a non-string into a Map that the settings response serializes.
      if (typeof value !== 'string' || !value) continue;
      // Never overwrite what the running process already knows. Hydration is
      // fire-and-forget (see above), so a request authenticated in the window
      // before the read lands has already written a FRESHER timestamp into the
      // map. An unconditional set() replaced it with the stale value from disk,
      // and because that request's recordApiKeyUsage() had also armed the flush
      // timer, the stale value was then written back out: the key's "last used"
      // could go backwards across a restart, which is the one thing the field is
      // supposed to be able to tell you. In-memory is authoritative by design;
      // the file only seeds ids this process has not seen yet.
      if (!lastUsed.has(id)) lastUsed.set(id, value);
    }
  } catch {
    /* absent or unreadable: start empty, the store is rebuilt by use */
  }
}

/** Await the initial read. Only useful for tests and for a deterministic boot. */
export function whenApiKeyUsageReady(): Promise<void> {
  return hydration;
}

/** Last-use timestamp for a key, or null if this store has never seen it.
 *  Synchronous by design (see the note on hydration above). */
export function getApiKeyLastUsed(keyId: string): string | null {
  return lastUsed.get(keyId) ?? null;
}

/** Record a use. Returns immediately: the disk write is debounced. */
export function recordApiKeyUsage(keyId: string, at: string = new Date().toISOString()): void {
  lastUsed.set(keyId, at);
  scheduleFlush();
}

/** Drop a revoked key's telemetry so the file does not grow forever with ids
 *  that no longer exist. Purely hygiene: nothing authorizes off this store. */
export function forgetApiKeyUsage(keyId: string): void {
  if (lastUsed.delete(keyId)) scheduleFlush();
}

function scheduleFlush(): void {
  // Trailing-edge debounce with coalescing: the first change after an idle
  // period arms the timer and every change within the window rides along on it,
  // so a burst of API calls costs exactly one write.
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushApiKeyUsage();
  }, FLUSH_DEBOUNCE_MS);
  // Never hold the process open for a telemetry write. Without unref, a pending
  // debounce keeps the event loop alive and delays a clean shutdown (which the
  // Electron shell notices) for no benefit.
  flushTimer.unref?.();
}

/** Write the current map atomically (tmp file, then rename). Serialized. */
export function flushApiKeyUsage(): Promise<void> {
  const result = flushQueue.then(async () => {
    // Snapshot inside the queued step so the JSON matches what the Map held at
    // write time, not at schedule time.
    const json = JSON.stringify(Object.fromEntries(lastUsed), null, 2);
    await fs.mkdir(config.dataDir, { recursive: true });
    const tmp = `${USAGE_FILE}.tmp-${randomBytes(4).toString('hex')}`;
    // 0600: not secret (no key material here, only ids and timestamps) but it
    // reveals which keys are in active use, and it sits beside settings.json.
    await fs.writeFile(tmp, json, { mode: 0o600 });
    await fs.rename(tmp, USAGE_FILE);
  });
  flushQueue = result.then(
    () => undefined,
    () => undefined,
  );
  // Swallow: a failed telemetry write must never surface as a failed API request.
  return result.catch((err: unknown) => {
    console.warn('[apikey-usage] could not persist last-used timestamps:', String(err));
  });
}
