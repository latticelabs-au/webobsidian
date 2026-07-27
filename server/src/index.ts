import express, { type Response } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { TLSSocket } from 'node:tls';
import { WebSocketServer, WebSocket } from 'ws';
import chokidar from 'chokidar';

import { config } from './config.js';
import { loadSettings, getSettings, setPasswordIfInitial } from './bootstrap.js';
import { errorHandler } from './middleware/error.js';
import { COOKIE_NAME } from './middleware/auth.js';
import { verifyToken } from './services/auth.js';
import { authRouter } from './routes/auth.js';
import { filesRouter } from './routes/files.js';
import { searchRouter } from './routes/search.js';
import { settingsRouter } from './routes/settings.js';
import { gitRouter } from './routes/git.js';
import { keysRouter } from './routes/keys.js';
import { pluginsRouter } from './routes/plugins.js';
import { agentRouter } from './routes/agent.js';
import { uiStateRouter } from './routes/uistate.js';
import { sharesRouter, publicSharesRouter } from './routes/shares.js';
import { sharePageRouter } from './routes/sharepage.js';
import { initSearch, qmd } from './services/search.js';
import { buildLinkGraph, updateLinkGraphForFile } from './services/links.js';
import { buildFileIndex, indexFile, unindexFile } from './services/fileindex.js';
import { setBroadcaster, broadcast } from './services/realtime.js';
import { getVaultRoot, ensureVault, invalidateStat } from './services/vault.js';
import { startAutoSync } from './services/autosync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Keep the local server alive on stray async errors (e.g. a deferred library task
// throwing) instead of crashing the whole process: log loudly so bugs aren't hidden.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

async function main() {
  await loadSettings();
  await setPasswordIfInitial();
  await ensureVault();

  const app = express();
  // Honour X-Forwarded-* per the deployment's proxy topology (TRUST_PROXY).
  // Default true (trust the immediate hop) so X-Forwarded-Proto-based `Secure`
  // cookies work behind the recommended reverse-proxy setup without extra config.
  // This is safe against F-03 because the rate limiters do not ask Express for
  // the client address under this setting: bare `true` makes `req.ip` the
  // leftmost, fully client-written X-Forwarded-For entry, so the limiters key on
  // the TCP socket address instead. They only use `req.ip` when TRUST_PROXY is a
  // subnet or preset list, which is the one form Express validates by address.
  // Set TRUST_PROXY to the proxy's subnet for per-client throttling; a hop count
  // is not a shortcut to it and behaves like bare `true` here. See
  // middleware/ratelimit.ts, which owns that rule and documents every form.
  app.set('trust proxy', config.trustProxy);
  app.use(express.json({ limit: '32mb' }));
  app.use(cookieParser());

  // Per-request CSP nonce: used by the SSR share page's inline <script>.
  app.use((_req, res, next) => {
    res.locals.cspNonce = randomBytes(16).toString('base64');
    next();
  });
  // Security headers. The CSP intentionally does NOT emit `upgrade-insecure-requests`
  // (it would break plain-HTTP self-hosting). `script-src` is 'self' + per-request
  // nonce; `style-src` allows inline styles (React inline styles + the SSR page's
  // <style>). Note: inline <script> inside ```html render-blocks won't execute under
  // this policy, acceptable for the marginal XSS hardening it buys.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", (_req, res) => `'nonce-${(res as Response).locals.cspNonce}'`],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          objectSrc: ["'none'"],
          frameSrc: ["'self'", 'blob:'],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: null,
        },
      },
      // Allow social crawlers / other sites to load public share og:images.
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // Credentialed cross-origin access: OFF unless an operator explicitly names the
  // allowed origin in DEV_CORS_ORIGIN.
  //
  // This used to be gated on `!config.isProd`, i.e. on the ABSENCE of
  // NODE_ENV=production, which fails OPEN. .env.example leaves NODE_ENV commented
  // out on the bare-metal path, so an operator running `npm run start` without
  // exporting it shipped production with `Access-Control-Allow-Origin:
  // http://localhost:5173` plus `Access-Control-Allow-Credentials: true`. Any page
  // reachable at localhost:5173 on a victim's machine (a stray dev server, or
  // anything an attacker can get to listen on that port) could then issue
  // credentialed fetches against the whole authenticated API AND read the
  // responses, which is exactly what the SameSite=Lax session cookie is supposed
  // to prevent. A security control must not depend on an env var being set; it
  // must depend on one being set deliberately.
  //
  // Nothing in the normal workflow needs this: the Vite dev server proxies /api,
  // /auth, /public, /share and /ws to this server (web/vite.config.ts), so even
  // `npm run dev` is same-origin from the browser's point of view. Set
  // DEV_CORS_ORIGIN only when running the SPA against the API cross-origin by hand.
  const devCorsOrigin = resolveDevCorsOrigin();
  if (devCorsOrigin) {
    app.use(cors({ origin: devCorsOrigin, credentials: true }));
    console.warn(
      `[security] credentialed CORS is ENABLED for ${devCorsOrigin} (DEV_CORS_ORIGIN). ` +
      `Do not set this in production: any page on that origin can read authenticated API responses.`,
    );
  }

  // Health (no auth): for docker healthcheck
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  // Routes. NOTE: specific /api/* routers must be registered BEFORE the broad
  // '/api' search router, whose router-level requireAuth middleware would
  // otherwise gate every /api/* path (incl. /api/v1 and /api/keys) by prefix.
  app.use('/auth', authRouter);
  app.use('/api/v1', agentRouter); // agent API (api-key auth)
  app.use('/api/files', filesRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/git', gitRouter);
  app.use('/api/keys', keysRouter);
  app.use('/api/plugins', pluginsRouter);
  app.use('/api/uistate', uiStateRouter);
  app.use('/api/shares', sharesRouter); // manage public share links (auth)
  app.use('/public/shares', publicSharesRouter); // shared-note content (NO auth)
  app.use('/share', sharePageRouter); // SSR public share page (NO auth, SEO/OG meta)
  app.use('/api', searchRouter); // /api/search, /api/tags, /api/backlinks, /api/graph...

  // Static SPA (built into server/public)
  const publicDir = path.join(__dirname, '..', 'public');
  if (await dirExists(publicDir)) {
    app.use(express.static(publicDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/public')) return next();
      res.sendFile(path.join(publicDir, 'index.html'));
    });
  }

  app.use(errorHandler);

  // Build search index + link graph
  console.log('[boot] indexing vault...');
  await initSearch();
  await buildLinkGraph();
  await buildFileIndex();
  console.log('[boot] index ready');

  const server = http.createServer(app);
  setupWebsocket(server, resolveUpgradeOriginAllowlist(devCorsOrigin));
  await setupWatcher();
  startAutoSync();

  server.listen(config.port, config.host, () => {
    console.log(`\n  WebObsidian server → http://${config.host}:${config.port}`);
    console.log(`  Vault: ${config.defaultVaultPath}`);
    console.log(`  Data:  ${config.dataDir}\n`);
  });
}

// --- WebSocket: broadcast filesystem & UI-state events to connected clients ----
// Auth-gated: the WS stream leaks vault structure (paths of created/changed/deleted
// files), so the upgrade is rejected unless the request carries a valid session.
// Origin-gated too: see originAllowedForUpgrade() for why the session check alone
// is not enough.

/** What we remember about an accepted socket so it can be re-checked later. */
interface SocketState {
  /**
   * The exact credential this socket was accepted on.
   *
   * A WebSocket sends its headers once, at the handshake, and never again. There
   * is no second request to hang a middleware off, so if we do not keep the
   * token we have nothing left to re-verify and the connection is authenticated
   * forever by an event that happened once, possibly weeks ago.
   */
  token: string;
  /**
   * Did the peer answer the last ping? Set false when a ping goes out and true
   * when the pong comes back, so one missed round trip across a sweep interval
   * marks the socket dead.
   */
  awake: boolean;
}

/**
 * How often every open socket is re-authenticated and pinged.
 *
 * WHY THIS EXISTS AT ALL. `verifyToken` used to be consulted exactly once, on
 * the HTTP upgrade, and never again for the life of the connection. Session
 * tokens carry a `cv` claim bound to the current credential state
 * (credentialFingerprint in services/auth.ts), so changing the password evicts
 * every other session on its next HTTP request. That eviction stopped at the
 * socket boundary: an attacker holding a stolen pre-change cookie who already
 * had /ws open kept receiving the full `{ type:'fs', event, path }` feed
 * indefinitely, which is a live map of the vault's structure and a real-time
 * record of what the owner is editing. The owner would have done everything the
 * UI asked of them, seen "password changed", and still be watched. A session
 * invalidation that the most sensitive stream in the app ignores is worse than
 * no invalidation, because it is believed.
 *
 * The same sweep also covers token EXPIRY (a 30-day JWT on a socket that has
 * been open for 31 days is no longer a credential) and REVOCATION by rotating
 * the recovery override, both of which `verifyToken` already answers correctly.
 *
 * 30 seconds is the bound on how long a revoked session keeps streaming. It is
 * not zero, and the honest way to make it zero is an explicit invalidation
 * signal from the credential change itself rather than a shorter poll. That
 * would mean services/auth.ts emitting an event this file subscribes to; it is
 * the right shape and it belongs in a change that owns both files. Until then
 * this is a bounded window, not an open one, and the cost of the poll is a JWT
 * HMAC per socket per 30s, which is nothing next to what the sockets themselves
 * are doing.
 */
const WS_SWEEP_INTERVAL_MS = 30 * 1000;

/**
 * How long a socket asked to leave is given to answer before it is severed.
 *
 * `close()` is the polite half of a WebSocket teardown: it sends a close frame
 * and waits for the peer to send one back. A peer that never answers leaves the
 * socket parked in CLOSING, still holding a file descriptor. That matters here
 * because the peer we are closing on is, in the case this whole mechanism exists
 * for, hostile: "ignore the close frame" is a free way to keep the connection
 * table occupied. `terminate()` after a grace period is what turns "asked to
 * leave" into "left".
 */
const WS_CLOSE_GRACE_MS = 5 * 1000;

/**
 * Close a socket for a policy reason and make sure it actually goes away.
 *
 * Note what happens the instant `close()` is called: `readyState` leaves OPEN,
 * and the broadcaster below only writes to sockets in OPEN. So the data stream
 * stops at this call, not when the peer eventually acknowledges. The grace timer
 * is about reclaiming the descriptor, not about containing the leak.
 */
function closeSocket(ws: WebSocket, code: number, reason: string): void {
  ws.close(code, reason);
  const kill = setTimeout(() => {
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  }, WS_CLOSE_GRACE_MS);
  // A teardown timer must never be the reason the process refuses to exit.
  kill.unref();
}

function setupWebsocket(server: http.Server, allowedOrigins: ReadonlySet<string>) {
  const wss = new WebSocketServer({ noServer: true });

  // Keyed on the socket itself and weak, so a connection that closes takes its
  // token out of memory with it whether or not any of our own bookkeeping fired.
  const sockets = new WeakMap<WebSocket, SocketState>();

  server.on('upgrade', (req, socket, head) => {
    // Everything in this handler runs on an UNAUTHENTICATED path, so a throw
    // here is a denial of service rather than a bug report: 'upgrade' is emitted
    // synchronously from the HTTP parser, an exception unwinds into the
    // process-wide uncaughtException handler at the top of this file, and that
    // handler logs and returns without ever touching the socket. The connection
    // is then leaked, still open, with no request in flight. One malformed
    // header per socket would be enough to exhaust the file descriptor table, so
    // the whole body is wrapped and any escape closes the socket it came from.
    try {
      let pathname = '';
      try {
        pathname = new URL(req.url ?? '', 'http://localhost').pathname;
      } catch {
        pathname = '';
      }
      if (pathname !== '/ws') {
        socket.destroy();
        return;
      }
      // Cross-origin check BEFORE the (async) token verification, so a cross-site
      // handshake is refused without doing any work on its behalf.
      const decision = originAllowedForUpgrade(req, allowedOrigins);
      if (!decision.allow) {
        // Log it. A silently refused upgrade is the worst possible failure here:
        // the SPA registers no onerror/onclose handler, so a rejected handshake
        // means the file tree simply stops refreshing and cross-tab UI state
        // stops syncing, with nothing anywhere to explain why. The operator gets
        // both halves of the comparison and the remedy.
        warnUpgradeOrigin(
          'rejected',
          `[security] WebSocket upgrade refused: ${decision.reason}. ` +
          `Origin=${JSON.stringify(req.headers.origin ?? null)} Host=${JSON.stringify(req.headers.host ?? null)} ` +
          `X-Forwarded-Host=${JSON.stringify(req.headers['x-forwarded-host'] ?? null)}. ` +
          `If this is your own deployment, set PUBLIC_ORIGIN to the origin(s) users type into the browser.`,
        );
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (decision.warn) warnUpgradeOrigin(decision.warn.code, decision.warn.message);
      const token = cookieValue(req.headers.cookie, COOKIE_NAME) ?? bearerToken(req.headers.authorization);
      void (async () => {
        if (!token || !(await verifyToken(token))) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          // Record the credential BEFORE emitting 'connection', so there is no
          // instant at which a socket is in `wss.clients` without the state the
          // sweep needs. The sweep treats a socket with no state as
          // unauthenticatable and severs it, so getting this order wrong would
          // manifest as connections dropping 30 seconds after they open.
          sockets.set(ws, { token, awake: true });
          wss.emit('connection', ws, req);
        });
      })().catch((err) => {
        // Same reasoning as the outer try, for the async half: an unhandled
        // rejection here would leave the socket open forever.
        console.error('[ws] upgrade failed:', err);
        socket.destroy();
      });
    } catch (err) {
      console.error('[ws] upgrade handler threw:', err);
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    // The pong is the only evidence a peer is still there. Browsers answer a
    // ping frame from inside the network stack, with no JS involvement and no
    // API to opt out, so this works against every client without the SPA
    // knowing the mechanism exists.
    ws.on('pong', () => {
      const state = sockets.get(ws);
      if (state) state.awake = true;
    });
    // A socket-level error is not fatal to the process and must not be allowed
    // to become one: `ws` emits 'error' on the socket, and an EventEmitter with
    // no 'error' listener throws. On this path that throw unwinds into the
    // process-wide uncaughtException handler at the top of this file, which logs
    // and returns, leaving the socket in an unknown state. Handling it here
    // keeps the failure local to the one connection.
    ws.on('error', (err) => {
      console.error('[ws] client socket error:', err);
    });
    ws.send(JSON.stringify({ type: 'hello' }));
  });

  /**
   * Re-authenticate and liveness-check every open socket.
   *
   * Iterates a SNAPSHOT of `wss.clients`. The set is mutated by every close and
   * terminate below, and the loop awaits `verifyToken`, so connections can also
   * arrive mid-pass; copying first makes "the sockets this sweep considers" a
   * fixed, obvious set rather than something that depends on Set iteration
   * semantics under concurrent mutation.
   *
   * Every socket is wrapped individually. One socket in a strange state must not
   * abort the pass, because the sockets that would then go unchecked are exactly
   * the ones an attacker would want left alone.
   */
  async function sweepConnections(): Promise<void> {
    for (const ws of [...wss.clients]) {
      try {
        if (ws.readyState !== WebSocket.OPEN) continue;
        const state = sockets.get(ws);
        if (!state) {
          // Fail closed. The only route into `wss.clients` is the handleUpgrade
          // callback above, which registers state first, so this is
          // unreachable by construction. If it ever happens, the socket is one
          // we cannot re-authenticate, and an unauthenticatable socket on this
          // stream is precisely what must not be kept.
          ws.terminate();
          continue;
        }
        if (!state.awake) {
          // No pong since the previous sweep: the peer is gone, or wedged, or
          // behind a half-open TCP connection that will never report itself.
          // Left alone these accumulate for the process's lifetime, and the
          // broadcaster keeps serialising every filesystem event into their
          // send buffers.
          ws.terminate();
          continue;
        }
        if (!(await verifyToken(state.token))) {
          // 1008 is 'policy violation', the closest standard code to "the
          // credential this connection was accepted on is no longer valid".
          //
          // KNOWN CONSEQUENCE FOR THE LEGITIMATE OWNER, stated because it is
          // not obvious and it is not free. Changing the password rotates the
          // credential fingerprint, so it invalidates the token held by the
          // owner's OWN open socket too. routes/auth.ts mints a fresh cookie for
          // the caller, so their HTTP side keeps working seamlessly, but the
          // socket was accepted on the old token and this sweep closes it within
          // WS_SWEEP_INTERVAL_MS. web/src/App.tsx opens the socket once from a
          // useEffect and registers no onclose handler, so it does not
          // reconnect: after a password change the file tree stops
          // auto-refreshing and cross-tab UI state stops syncing until the page
          // is reloaded.
          //
          // That is accepted rather than worked around, for two reasons. Any
          // scheme that kept this socket alive would have to decide that SOME
          // holders of a revoked token may keep streaming, and the socket layer
          // cannot tell the owner's browser from the attacker's, which is the
          // entire premise of the eviction. And the remedy is a client change,
          // not a server one: an `onclose` that reconnects with backoff in
          // web/src/App.tsx turns this into an invisible blip and would also fix
          // the pre-existing case where any dropped connection silently kills
          // live updates. That belongs in a change that owns the web workspace.
          closeSocket(ws, 1008, 'session no longer valid');
          continue;
        }
        state.awake = false;
        ws.ping();
      } catch (err) {
        console.error('[ws] sweep failed for a client:', err);
      }
    }
  }

  /**
   * Chain the next sweep off the end of the previous one, rather than using
   * `setInterval`.
   *
   * This is not stylistic. `setInterval` fires on a wall clock and does not care
   * whether the previous pass finished, so a slow pass (many sockets, or a
   * `getSettings()` that has to touch disk) can have a second pass start while
   * the first is still awaiting. Two overlapping passes race on `awake`: pass A
   * pings a healthy socket and clears the flag, pass B runs before the pong can
   * possibly arrive, sees the cleared flag and terminates a connection that was
   * never in trouble. Self-scheduling makes the overlap impossible by
   * construction instead of unlikely, which is the same reason the reference
   * bridge writes its heartbeat off a chained timer.
   *
   * `.unref()` so this timer is never the reason the process refuses to exit. It
   * exists to police connections; with no connections there is nothing to
   * police, and a server held open by its own janitor is a worse bug than the
   * one this closes.
   */
  const scheduleSweep = (): void => {
    setTimeout(() => {
      void sweepConnections()
        // The loop guards every socket individually, so this can only fire for a
        // failure of the pass itself. Catching it here keeps a bad sweep from
        // becoming an unhandled rejection, which the process-wide handler would
        // log with nothing to say which subsystem produced it. `finally` rather
        // than `then`, because a pass that failed must still schedule the next
        // one: a sweep loop that stops on one bad pass leaves every socket
        // unchecked forever, silently.
        .catch((err) => console.error('[ws] sweep failed:', err))
        .finally(scheduleSweep);
    }, WS_SWEEP_INTERVAL_MS).unref();
  };
  scheduleSweep();

  setBroadcaster((msg) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      // OPEN only. A socket the sweep has just asked to close is in CLOSING and
      // must stop receiving vault events immediately, which is what makes the
      // close itself the moment the leak stops.
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  });
}

/**
 * Read DEV_CORS_ORIGIN into a single exact origin, or undefined (the safe default).
 *
 * Deliberately strict: one origin, no list, no wildcard. `*` is meaningless with
 * credentials (browsers reject the combination), and accepting a comma-separated
 * list here would invite a config where one careless entry opens the whole API to
 * a third party. A malformed value is refused rather than silently ignored, so a
 * typo cannot masquerade as "CORS is configured".
 */
function resolveDevCorsOrigin(): string | undefined {
  const raw = process.env.DEV_CORS_ORIGIN?.trim();
  if (!raw) return undefined;
  if (raw === '*' || raw.includes(',')) {
    console.error('[security] DEV_CORS_ORIGIN must be a single exact origin (no "*", no list). Ignoring it.');
    return undefined;
  }
  try {
    const u = new URL(raw);
    // `origin` normalises away any path/trailing slash the operator typed, which
    // matters because the cors package compares the Origin header literally.
    if (u.origin === 'null') throw new Error('opaque origin');
    return u.origin;
  } catch {
    console.error(`[security] DEV_CORS_ORIGIN is not a valid origin (${raw}). Ignoring it.`);
    return undefined;
  }
}

/**
 * The origins this deployment is served at, as the browser sees them.
 *
 * PUBLIC_ORIGIN is the operator's authoritative answer to the one question the
 * upgrade check cannot always work out for itself: "what does the address bar
 * say when someone opens this app?". When it is set, it is the ONLY thing
 * consulted, and both of the ambiguities documented on
 * originAllowedForUpgrade() disappear.
 *
 * A comma-separated list is accepted here, unlike DEV_CORS_ORIGIN which insists
 * on exactly one value. The two settings grant different things and the
 * strictness follows the grant: DEV_CORS_ORIGIN hands a named origin the right
 * to make credentialed cross-origin reads of the entire authenticated API, so
 * every extra entry is another party that can read the vault. PUBLIC_ORIGIN only
 * declares which front doors are our own, and a real deployment genuinely has
 * several (a public hostname, a LAN address, a Tailscale name), so refusing a
 * list would push those operators back onto a setting that fails open.
 *
 * DEV_CORS_ORIGIN is folded in for the same reason it was before: a cross-origin
 * dev setup that gets an API which answers but a live-update stream that never
 * connects is the confusing half-broken state this whole area exists to avoid.
 */
function resolveUpgradeOriginAllowlist(devCorsOrigin?: string): ReadonlySet<string> {
  const allowed = new Set<string>();
  if (devCorsOrigin) allowed.add(devCorsOrigin);

  const raw = process.env.PUBLIC_ORIGIN?.trim();
  if (raw) {
    for (const entry of raw.split(',').map((e) => e.trim()).filter(Boolean)) {
      if (entry === '*') {
        // A wildcard here would disable the check entirely while looking like
        // configuration, which is the failure mode this file has already been
        // bitten by once (the CORS block above).
        console.error('[security] PUBLIC_ORIGIN does not accept "*". Ignoring that entry.');
        continue;
      }
      try {
        const u = new URL(entry);
        if (u.origin === 'null') throw new Error('opaque origin');
        allowed.add(u.origin); // normalises away any path or trailing slash
      } catch {
        console.error(`[security] PUBLIC_ORIGIN entry is not a valid origin (${entry}). Ignoring it.`);
      }
    }
  }

  if (allowed.size > 0) {
    console.log(`[security] WebSocket upgrades accept these origins: ${[...allowed].join(', ')}`);
  }
  return allowed;
}

/** Why an upgrade was refused, or why it was allowed with a caveat. */
type UpgradeWarningCode = 'authority-rewritten' | 'no-forwarded-proto' | 'rejected';

type UpgradeDecision =
  | { allow: true; warn?: { code: UpgradeWarningCode; message: string } }
  | { allow: false; reason: string };

/**
 * Reject cross-origin WebSocket upgrades.
 *
 * WHY THIS EXISTS. The session check on /ws proves the request carries a valid
 * cookie; it does NOT prove the request came from our own page. Browsers attach
 * cookies to a WebSocket handshake regardless of the initiating origin, and the
 * handshake is not subject to the same-origin policy or to a CORS preflight, so
 * `SameSite=Lax` was the only thing standing between an attacker's page and this
 * stream. Lax is a weak control here: it is scoped to the registrable domain,
 * not to the port or the scheme, and this app explicitly supports plain-HTTP LAN
 * deployments where another origin on the same host can meet it. Whoever gets
 * through receives the live `{ type:'fs', event, path }` feed: a complete map of
 * the vault's structure plus a real-time record of what the user is editing.
 *
 * WHY IT IS NOT A STRING COMPARE. The previous revision compared the Origin's
 * `host:port` against the Host header and stripped `:80`/`:443` from both
 * without regard to scheme. That collapsed distinct origins onto each other
 * (`http://host:443` equalled `http://host:80`, and `https://host` equalled a
 * plain-HTTP deployment on port 80), and it assumed the Host header still says
 * what the browser typed. Behind a reverse proxy it very often does not: nginx's
 * default is `proxy_set_header Host $proxy_host`, which rewrites it to
 * `127.0.0.1:8787`, and in that deployment the old check refused EVERY upgrade
 * from the real site. That failure was invisible from both ends, which is worse
 * than the hole it was closing.
 *
 * So the comparison is built from the strongest evidence available, and the
 * strictness follows the evidence:
 *
 *  1. PUBLIC_ORIGIN (or DEV_CORS_ORIGIN) is set: exact origin equality against
 *     that list, nothing else consulted. Scheme, host and port all count.
 *  2. A proxy attested the authority (X-Forwarded-Host / -Proto / -Port): those
 *     win over Host, and the comparison is exact. Trusting them is safe against
 *     the threat this check exists to stop, and that is not an accident of
 *     configuration: the attacker is a web page, and a page cannot set ANY
 *     header on a WebSocket handshake. The WebSocket API has no header option at
 *     all. A non-browser client can forge them, but a non-browser client has no
 *     ambient cookie to borrow and can already omit Origin entirely (see below),
 *     so forging them buys nothing.
 *  3. We terminate TLS ourselves (`socket.encrypted`): scheme is known, exact
 *     comparison against the Host header.
 *  4. Plain HTTP with nothing forwarded: we know our own scheme is http and the
 *     Host header is the browser's own authority, so a same-scheme Origin is
 *     compared exactly, host and port. An `https:` Origin is the one genuinely
 *     undecidable case and is handled where it arises, below.
 *
 * A MISSING Origin is allowed, deliberately. Browsers always send Origin on a
 * WebSocket handshake (it is required by the HTML spec's WebSocket algorithm,
 * and unlike fetch it cannot be suppressed), so an absent Origin means a
 * non-browser client: a script, the CLI, a test harness. Those are not
 * vulnerable to the attack this check exists to stop, because there is no
 * ambient cookie for an attacker's page to borrow. They also make real use of
 * the `Bearer` branch in the token lookup. An `Origin: null` header (sandboxed
 * iframe, `file://`, some cross-origin redirects) is NOT the missing case and is
 * refused: it parses to the opaque origin, which is nobody's deployment.
 */
function originAllowedForUpgrade(
  req: http.IncomingMessage,
  configuredOrigins: ReadonlySet<string>,
): UpgradeDecision {
  const rawOrigin: string | string[] | undefined = req.headers.origin;
  if (rawOrigin === undefined) return { allow: true }; // non-browser client, see above
  // Two Origin headers arrive here as an array or as one comma-joined string
  // depending on the header, and neither is anything our own page sends. Reject
  // on the shape rather than relying on `new URL` to fail, because it does not
  // always: `new URL('http://a,http://b')` parses happily in Node and yields the
  // host `a,http`. The outcome was right before, the stated mechanism was not.
  if (typeof rawOrigin !== 'string' || rawOrigin.includes(',')) {
    return { allow: false, reason: 'malformed or duplicated Origin header' };
  }

  let origin: URL;
  try {
    origin = new URL(rawOrigin);
  } catch {
    return { allow: false, reason: 'unparseable Origin header' };
  }
  if (origin.origin === 'null') {
    return { allow: false, reason: 'opaque Origin (sandboxed iframe, file://, or a cross-origin redirect)' };
  }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
    return { allow: false, reason: `Origin scheme ${origin.protocol} is not http(s)` };
  }

  // (1) The operator has told us what our own origins are. Believe them, and
  // only them: an explicit allowlist must not be silently widened by anything
  // inferred from the request.
  if (configuredOrigins.size > 0) {
    if (configuredOrigins.has(origin.origin)) return { allow: true };
    return { allow: false, reason: `Origin ${origin.origin} is not in PUBLIC_ORIGIN` };
  }

  const expected = expectedDeploymentAuthority(req);
  if (!expected) {
    return { allow: false, reason: 'the upgrade request carries no usable Host or X-Forwarded-Host' };
  }

  const originHostname = normaliseHostname(origin.hostname);
  const originScheme = origin.protocol === 'https:' ? 'https' : 'http';
  const originPort = origin.port ? Number(origin.port) : defaultPortFor(originScheme);

  if (originHostname !== expected.hostname) {
    // The hostnames disagree. Before calling that an attack, rule out the
    // deployment that cannot possibly agree: a reverse proxy that forwarded the
    // request without preserving the authority. nginx's default `$proxy_host`
    // gives us `127.0.0.1:8787`, and a compose file with `proxy_pass
    // http://webobsidian:8787` gives us a bare container name. Neither is an
    // authority any browser could have in its address bar, so an Origin naming a
    // routable, dotted host is evidence of an intermediary, not of an attacker.
    //
    // This branch is a deliberate, bounded fail-open, and the bound is worth
    // stating because it is what makes it acceptable. It can only fire when our
    // observed authority is internal AND the Origin is not, and those two can
    // never be same-site with each other: an internal authority is an IP literal
    // or a single-label name, whose registrable domain is itself, so a dotted
    // public Origin is always cross-site with it. For a genuinely local install
    // (the case an attacker would want to reach through this branch) the session
    // cookie is scoped to that internal name, SameSite=Lax does not attach it to
    // a cross-site handshake, and the upgrade dies at the token check instead.
    // What the branch really covers is the proxied deployment, where the cookie
    // is scoped to the PUBLIC name we cannot see: there we degrade to
    // SameSite-only, exactly the protection that existed before this check was
    // added, and we say so loudly every ten minutes until someone fixes it.
    if (looksLikeInternalAuthority(expected.hostname) && !looksLikeInternalAuthority(originHostname)) {
      return {
        allow: true,
        warn: {
          code: 'authority-rewritten',
          message:
            `[security] WebSocket upgrade from ${origin.origin} allowed even though this server sees ` +
            `Host=${JSON.stringify(req.headers.host ?? null)}, which is an internal address no browser can ` +
            `reach directly. Your reverse proxy is not preserving the original authority, so cross-origin ` +
            `upgrades cannot be distinguished from your own page and only the SameSite cookie attribute is ` +
            `protecting this stream. Fix it with 'proxy_set_header Host $host;' (nginx) or by setting ` +
            `PUBLIC_ORIGIN to the origin(s) users type into the browser.`,
        },
      };
    }
    return {
      allow: false,
      reason: `Origin host ${originHostname} does not match this deployment's host ${expected.hostname}`,
    };
  }

  // Same hostname. Everything from here is about the two parts of an origin that
  // the previous revision threw away, and that a sibling origin on the same host
  // is exactly built out of.
  if (expected.schemeAttested) {
    if (originScheme !== expected.scheme) {
      return { allow: false, reason: `Origin scheme ${originScheme} does not match this deployment's scheme ${expected.scheme}` };
    }
    if (expected.portStated && originPort !== expected.port) {
      return { allow: false, reason: `Origin port ${originPort} does not match this deployment's port ${expected.port}` };
    }
    return { allow: true };
  }

  // Plain HTTP, and nothing forwarded a scheme to us. Before comparing the two
  // remaining components we have to answer a prior question: is the Host header
  // the authority the BROWSER used, or one an invisible intermediary wrote?
  //
  // Two worlds produce an `https:` Origin here, byte for byte:
  //
  //   (a) a TLS-terminating proxy in front of us that sets Host but not
  //       X-Forwarded-Proto (the minimal nginx snippet everybody copies), where
  //       this IS our own page, or
  //   (b) no proxy at all, and a sibling `https://` origin on the same hostname
  //       attacking our plain-HTTP deployment. Same site, so the cookie IS
  //       attached, which is the attack this whole function exists to stop.
  //
  // The one signal that separates them is which port the browser reached. In (b)
  // the browser connected to this process directly, so the authority it used
  // names the port we are listening on. In (a) it connected to the proxy, so the
  // authority names the proxy's port (443 by default, hence absent from Host,
  // hence defaulted to 80 here) while we listen somewhere else entirely. The
  // same test rescues plain-HTTP proxied deployments on a non-default port,
  // where nginx's `$host` drops the `:8080` the browser actually used and a
  // naive port compare would refuse every upgrade from the real site.
  //
  // It is not perfect: a deployment where the app itself listens on the very
  // port the public URL names, behind a proxy that sends no X-Forwarded-Proto,
  // lands in the refusing branch. PUBLIC_ORIGIN is the answer for that one, and
  // the refusal is logged with that remedy in it.
  const reachedUsDirectly = expected.port === config.port;
  if (!reachedUsDirectly) {
    if (originScheme !== 'http' || originPort !== expected.port) {
      return {
        allow: true,
        warn: {
          code: 'no-forwarded-proto',
          message:
            `[security] WebSocket upgrade from ${origin.origin} allowed on hostname match alone. This server ` +
            `speaks plain HTTP on port ${config.port} but the request arrived with ` +
            `Host=${JSON.stringify(req.headers.host ?? null)}, so something is proxying it and neither the ` +
            `scheme nor the port of the original request can be verified. Add ` +
            `'proxy_set_header X-Forwarded-Proto $scheme;' (and X-Forwarded-Host), or set PUBLIC_ORIGIN to the ` +
            `origin(s) users type into the browser, to make this check exact.`,
        },
      };
    }
    return { allow: true };
  }

  // The browser reached this process directly, so the Host header is its own
  // authority and both components are comparable.
  if (originScheme !== 'http') {
    return {
      allow: false,
      reason: `Origin ${origin.origin} is https but this deployment was reached directly over plain HTTP on port ${expected.port}`,
    };
  }
  if (originPort !== expected.port) {
    return { allow: false, reason: `Origin port ${originPort} does not match this deployment's port ${expected.port}` };
  }
  return { allow: true };
}

/** What this server believes its own browser-visible authority to be. */
interface DeploymentAuthority {
  hostname: string;
  port: number;
  scheme: 'http' | 'https';
  /** A proxy stated the scheme, or we terminated TLS ourselves. */
  schemeAttested: boolean;
  /** The port is known rather than guessed, so it is safe to compare. */
  portStated: boolean;
}

function expectedDeploymentAuthority(req: http.IncomingMessage): DeploymentAuthority | undefined {
  const forwardedHost = firstForwardedValue(req.headers['x-forwarded-host']);
  const forwardedProto = firstForwardedValue(req.headers['x-forwarded-proto'])?.toLowerCase();
  const forwardedPort = firstForwardedValue(req.headers['x-forwarded-port']);
  const proxied = forwardedHost !== undefined || forwardedProto !== undefined || forwardedPort !== undefined;

  // `encrypted` only exists on a TLSSocket; on a plain socket the property is
  // absent, which reads as undefined and is exactly the answer we want.
  const encrypted = (req.socket as TLSSocket).encrypted === true;
  const scheme: 'http' | 'https' =
    forwardedProto === 'https' || forwardedProto === 'http' ? forwardedProto : encrypted ? 'https' : 'http';
  const schemeAttested = forwardedProto === 'https' || forwardedProto === 'http' || encrypted;

  const authority = forwardedHost ?? req.headers.host;
  if (!authority) return undefined; // HTTP/1.1 requires Host; without it there is nothing to compare
  const parsed = parseAuthority(authority, scheme);
  if (!parsed) return undefined;

  const explicitPort = forwardedPort && /^\d{1,5}$/.test(forwardedPort) ? Number(forwardedPort) : undefined;
  return {
    hostname: parsed.hostname,
    port: explicitPort ?? parsed.port,
    scheme,
    schemeAttested,
    // A port nobody stated is a guess, and guesses must not decide a refusal.
    // When the request did NOT come through a proxy the absence of a port in
    // Host is itself information (a browser omits the port precisely when it is
    // the scheme default), so the default counts as stated in that case only.
    portStated: explicitPort !== undefined || parsed.portStated || !proxied,
  };
}

/**
 * Split an authority into hostname and port.
 *
 * Parsed through `URL` rather than by hand so that IPv6 literals (`[::1]:8787`)
 * and IDNs normalise the same way both sides of the comparison do. The shape
 * guard in front of it matters: a Host of `evil.com@real.com` would otherwise
 * parse as userinfo plus a host and quietly compare against the wrong name.
 */
function parseAuthority(
  authority: string,
  scheme: 'http' | 'https',
): { hostname: string; port: number; portStated: boolean } | undefined {
  if (/[/\\@\s]/.test(authority)) return undefined;
  try {
    const u = new URL(`${scheme}://${authority}`);
    if (!u.hostname) return undefined;
    return {
      hostname: normaliseHostname(u.hostname),
      port: u.port ? Number(u.port) : defaultPortFor(scheme),
      portStated: u.port !== '',
    };
  } catch {
    return undefined;
  }
}

/**
 * The leftmost entry of an X-Forwarded-* header.
 *
 * Proxy chains append, so `X-Forwarded-Host: public.example.com, inner:8787` is
 * legal and the leftmost entry is the one the browser actually used. Duplicate
 * headers arrive as an array; the first is the outermost hop for the same
 * reason.
 */
function firstForwardedValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const first = raw.split(',')[0]?.trim();
  return first ? first : undefined;
}

function defaultPortFor(scheme: 'http' | 'https'): number {
  return scheme === 'https' ? 443 : 80;
}

/**
 * Lowercase a hostname, drop the brackets `URL` keeps around IPv6 literals, and
 * drop a trailing root dot so that `example.com.` and `example.com` compare
 * equal. Both sides of every comparison go through this, so the only thing that
 * matters is that it is applied consistently.
 */
function normaliseHostname(hostname: string): string {
  const lower = hostname.trim().toLowerCase().replace(/\.$/, '');
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

/**
 * Is this an address that a browser could not have had in its address bar for a
 * deployment reachable under some other name?
 *
 * Used for exactly one decision: whether a hostname mismatch is better explained
 * by a proxy that did not preserve the authority than by a cross-origin attack.
 * See the call site for why the answer is safe there. Covers loopback, the
 * unspecified address, RFC1918 and link-local ranges, IPv6 unique-local and
 * link-local, and single-label names (container and compose service names, plus
 * `localhost` itself).
 */
function looksLikeInternalAuthority(hostname: string): boolean {
  if (!hostname.includes('.') && !hostname.includes(':')) return true; // 'localhost', 'webobsidian', 'web'
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (v4) {
    const octets = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])];
    if (octets.some((octet) => octet > 255)) return false;
    const [a, b] = octets;
    if (a === 0 || a === 127) return true; // 0.0.0.0/8 unspecified, 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link local
    return false;
  }
  if (!hostname.includes(':')) return false; // a dotted DNS name
  // IPv6 literal (brackets already stripped by normaliseHostname).
  const v6 = hostname.split('%')[0];
  if (v6 === '::1' || v6 === '::') return true;
  const firstHextet = v6.split(':')[0];
  if (firstHextet.length === 0 || !/^[0-9a-f]{1,4}$/.test(firstHextet)) return false;
  const head = Number.parseInt(firstHextet, 16);
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7  unique local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  return false;
}

/**
 * Log an upgrade-origin event at most once per ten minutes per reason.
 *
 * Throttled because these lines are written from an unauthenticated path, so an
 * unthrottled `console.warn` would be a log-flooding primitive. Keyed on the
 * fixed reason code and NOT on anything from the request: an attacker who could
 * mint new keys by rotating the Origin header would either flood the log anyway
 * or, if the map were capped, evict the operator's own message before they ever
 * saw it. The message body still names the observed values, JSON-encoded so a
 * hostile header cannot forge structure in a log line.
 */
const upgradeWarnedAt = new Map<UpgradeWarningCode, number>();
const UPGRADE_WARN_INTERVAL_MS = 10 * 60 * 1000;

function warnUpgradeOrigin(code: UpgradeWarningCode, message: string): void {
  const now = Date.now();
  const last = upgradeWarnedAt.get(code);
  if (last !== undefined && now - last < UPGRADE_WARN_INTERVAL_MS) return;
  upgradeWarnedAt.set(code, now);
  console.warn(message);
}

/** Parse a single cookie value out of a raw `Cookie:` header (no cookie-parser on upgrade). */
function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    // decodeURIComponent throws URIError on a malformed escape ('%', '%zz'),
    // and this runs on the unauthenticated upgrade path, where a throw leaks the
    // socket rather than returning an error (see the handler's own comment).
    // A JWT is base64url plus dots, so nothing in a real token needs decoding at
    // all; on a malformed escape we hand back the raw value and let verifyToken
    // reject it, which is the same outcome by a route that cannot throw.
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

function bearerToken(header: string | undefined): string | undefined {
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

// --- chokidar watcher: reflect external changes (git pull, direct edits) ---
async function setupWatcher() {
  const root = await getVaultRoot();
  // WEBOBSIDIAN_WATCH: 'auto' (default) = native inotify with automatic polling
  // fallback when the host watch limit is exceeded; 'polling' = force polling.
  const forcePolling = (process.env.WEBOBSIDIAN_WATCH ?? 'auto').toLowerCase() === 'polling';
  startWatcher(root, forcePolling);
}

function startWatcher(root: string, usePolling: boolean) {
  const watcher = chokidar.watch(root, {
    // Ignore VCS/dep/trash dirs AND `.obsidian`: the desktop Obsidian app
    // rewrites its workspace/state files constantly, which otherwise floods the
    // server with events (→ broadcasts → full tree refetches) and pins the CPU.
    ignored: (p) => /(^|[/\\])(\.git|\.obsidian|node_modules|\.trash)([/\\]|$)/.test(p),
    ignoreInitial: true,
    persistent: true,
    usePolling,
    interval: 1000,
    binaryInterval: 3000,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  // On a fresh VPS the kernel's `fs.inotify.max_user_watches` is often far below
  // the file count of a large vault, so native watching fails with ENOSPC/EMFILE.
  // Self-heal by transparently switching to polling (no inotify), and tell the
  // operator how to restore native (cheaper) watching.
  let degraded = false;
  watcher.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (!usePolling && !degraded && (code === 'ENOSPC' || code === 'EMFILE')) {
      degraded = true;
      console.warn(
        `[watcher] native file watching hit ${code} (host inotify limit too low ` +
        `for this vault). Falling back to polling. For lower CPU, raise the limit: ` +
        `sudo sysctl -w fs.inotify.max_user_watches=524288`,
      );
      watcher.close().catch(() => {});
      startWatcher(root, true);
      return;
    }
    console.error('[watcher] error:', err);
  });

  const onChange = async (absPath: string, type: string) => {
    const rel = path.relative(root, absPath).split(path.sep).join('/');
    // keep the attachment/file index in sync for embed resolution
    if (type === 'add') indexFile(rel);
    else if (type === 'unlink') unindexFile(rel);
    // Drop the cached mtime/ctime so the next listTree re-stats just this file.
    invalidateStat(rel);
    if (/\.(md|markdown)$/i.test(rel)) {
      // Update only the changed file in the search + link indexes (O(1)): a full
      // buildLinkGraph() re-reads every note in the vault and was the main CPU sink
      // when Obsidian touched files in the background.
      if (type === 'unlink') {
        qmd.remove(rel);
        await updateLinkGraphForFile(rel, true).catch(() => {});
      } else {
        await qmd.upsert(rel).catch(() => {});
        await updateLinkGraphForFile(rel).catch(() => {});
      }
    }
    broadcast({ type: 'fs', event: type, path: rel });
  };
  watcher
    .on('add', (p) => onChange(p, 'add'))
    .on('change', (p) => onChange(p, 'change'))
    .on('unlink', (p) => onChange(p, 'unlink'))
    .on('addDir', (p) => onChange(p, 'addDir'))
    .on('unlinkDir', (p) => onChange(p, 'unlinkDir'));
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
