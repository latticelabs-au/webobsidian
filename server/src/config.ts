import path from 'node:path';

/** Runtime configuration derived from environment variables. */
export interface RuntimeConfig {
  port: number;
  host: string;
  dataDir: string;
  /** Default vault path used on first run if settings has none. */
  defaultVaultPath: string;
  /** Roots the folder browser is allowed to traverse. */
  allowedRoots: string[];
  initialPassword?: string;
  isProd: boolean;
  /**
   * Express `trust proxy` setting. Controls whether `X-Forwarded-*` headers are
   * honoured (and thus whether `req.ip`/`req.secure` derive from them). Defaults
   * to `true` (trust the immediate hop) so the common reverse-proxy deployment
   * keeps `X-Forwarded-Proto`-based `Secure` cookies working out of the box.
   *
   * This value also decides how the rate limiters key their buckets
   * (`middleware/ratelimit.ts`), so it is worth setting accurately. The three
   * forms are not interchangeable, because only one of them makes Express
   * validate WHO the peer is:
   *   - A subnet/preset list ('loopback', '10.0.0.0/8', the proxy's CIDR):
   *     Express tests each hop's address and stops at the first one outside the
   *     list, so `req.ip` is genuinely proxy-attested and the limiters use it
   *     verbatim. This is the exact form and the one to prefer, and it is the
   *     only form that resolves a multi-proxy chain correctly.
   *   - A hop count >= 1: Express only counts hops, it never checks the peer's
   *     address, so `req.ip` is whatever X-Forwarded-For says as soon as anyone
   *     can reach the port directly. The limiters therefore key on the TCP
   *     socket address under this form, exactly as they do for bare `true`.
   *   - Bare `true` (the default) or `false`: `req.ip` would be the leftmost,
   *     fully client-supplied XFF entry, so it is never used for throttling.
   *     Both key on the TCP socket address.
   * So the rule is two-valued: the subnet/preset list is the ONLY form that
   * yields per-client throttling buckets, and every other form is safe but
   * coarse. Behind a reverse proxy set `TRUST_PROXY=<proxy CIDR>` (or
   * `loopback` when the proxy is on the same host) if you want per-client
   * buckets. A hop count is NOT a shortcut to them: under `TRUST_PROXY=1` all
   * clients arriving through the proxy share one bucket, because from the
   * server's side that is a single socket address.
   *
   * Sharing a bucket is an availability tradeoff rather than a bypass, and it is
   * deliberately the direction we fail. `routes/auth.ts` adds a second,
   * identity-keyed failure limiter on top, which charges only failed attempts and
   * is cleared by a success, so a shared network bucket cannot lock out an owner
   * who knows their password. See middleware/ratelimit.ts, which owns both rules.
   */
  trustProxy: boolean | number | string;
}

function resolveRoots(): string[] {
  const raw = process.env.ALLOWED_ROOTS?.trim();
  if (raw) {
    return raw.split(',').map((p) => path.resolve(p.trim())).filter(Boolean);
  }
  return [];
}

/**
 * Parse the `TRUST_PROXY` env into an Express `trust proxy` value. Default is
 * `true` (trust the immediate hop) so the common reverse-proxy deployment keeps
 * `X-Forwarded-Proto`-based `Secure` cookies working without extra config.
 *
 * F-03 (bypassing the login limit by rotating X-Forwarded-For) is closed by the
 * limiters' keying rule rather than by this default. They only believe `req.ip`
 * when the value below is a subnet/preset list, which is the only form that
 * makes Express check the peer's ADDRESS rather than merely count hops. For a
 * hop count or a bare `true` they fall back to their own rule: the nearest
 * hop's X-Forwarded-For entry when the TCP peer is on a non-routable network,
 * and otherwise the unforgeable socket address. Every form is therefore safe
 * against an attacker reaching the port from the internet, and every form
 * except `false` still gives per-client buckets behind a real proxy. Accepts:
 *   - unset / 'true' / 'on'              → true (trust the immediate peer)
 *   - 'false' / 'off' / '0'             → false (no proxy → ignore X-Forwarded-*)
 *   - a non-negative integer             → number of trusted proxy hops
 *   - anything else                      → passed through as a subnet/preset
 *                                          list (e.g. 'loopback, 10.0.0.0/8').
 */
function resolveTrustProxy(): boolean | number | string {
  const raw = process.env.TRUST_PROXY?.trim();
  if (!raw) return true;
  const lower = raw.toLowerCase();
  if (lower === 'false' || lower === 'off' || lower === '0') return false;
  if (lower === 'true' || lower === 'on') return true;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0) return n;
  return raw;
}

export const config: RuntimeConfig = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir: path.resolve(process.env.DATA_DIR ?? './data'),
  defaultVaultPath: path.resolve(process.env.VAULT_PATH ?? './sample-vault'),
  allowedRoots: resolveRoots(),
  initialPassword: process.env.WEBOBSIDIAN_PASSWORD || undefined,
  isProd: process.env.NODE_ENV === 'production',
  trustProxy: resolveTrustProxy(),
};

export const SETTINGS_FILE = path.join(config.dataDir, 'settings.json');
export const INDEX_FILE = path.join(config.dataDir, 'qmd-index.json');
