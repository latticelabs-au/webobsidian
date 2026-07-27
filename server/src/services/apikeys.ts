import { randomUUID } from 'node:crypto';
import { getSettings, updateSettings, type ApiKeyRecord } from './settings.js';
import { generateApiKey, hashApiKey } from './auth.js';
import {
  getApiKeyLastUsed,
  recordApiKeyUsage,
  forgetApiKeyUsage,
} from './apikey-usage.js';

export type Scope = 'read' | 'write' | 'search';

export async function listKeys(): Promise<Omit<ApiKeyRecord, 'hash'>[]> {
  const s = await getSettings();
  // Shape is unchanged for routes/keys.ts and the web UI; `lastUsed` just comes
  // from the separate telemetry store now, falling back to the value frozen in
  // settings.json by builds that still wrote it there.
  return s.api.keys.map(({ hash, ...rest }) => ({
    ...rest,
    lastUsed: getApiKeyLastUsed(rest.id) ?? rest.lastUsed,
  }));
}

export async function createKey(
  name: string,
  scopes: Scope[],
): Promise<{ raw: string; record: Omit<ApiKeyRecord, 'hash'> }> {
  const { raw, hash, prefix } = generateApiKey();
  const record: ApiKeyRecord = {
    id: randomUUID(),
    name: name || 'agent',
    hash,
    prefix,
    scopes: scopes.length ? scopes : ['read', 'search'],
    createdAt: new Date().toISOString(),
    lastUsed: null,
  };
  await updateSettings((d) => {
    d.api.keys.push(record);
  });
  const { hash: _omit, ...safe } = record;
  return { raw, record: safe };
}

export async function revokeKey(id: string): Promise<boolean> {
  let removed = false;
  await updateSettings((d) => {
    const before = d.api.keys.length;
    d.api.keys = d.api.keys.filter((k) => k.id !== id);
    removed = d.api.keys.length < before;
  });
  // Only after the revocation is durably on disk, so a crash between the two
  // leaves an orphan timestamp (harmless) rather than a live key with no history.
  if (removed) forgetApiKeyUsage(id);
  return removed;
}

/** Look up a raw key; returns the matching record (and bumps lastUsed). */
export async function authenticateKey(raw: string): Promise<ApiKeyRecord | null> {
  if (!raw) return null;
  const hash = hashApiKey(raw);
  const s = await getSettings();
  const match = s.api.keys.find((k) => k.hash === hash);
  if (!match) return null;
  // Telemetry only, and it no longer touches settings.json. The previous version
  // fired an unawaited updateSettings() from here, which cloned a cache snapshot
  // that could predate a concurrent revokeKey(); landing second, it rewrote the
  // pre-revocation key array back to disk and resurrected the revoked key. The
  // timestamp now lives in its own debounced store, so an authenticated request
  // can never write the key list at all.
  const now = new Date().toISOString();
  recordApiKeyUsage(match.id, now);
  // Report the bump we just made rather than the stale value from settings.json.
  return { ...match, lastUsed: now };
}
