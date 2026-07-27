import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { createRateLimiter, clientIp } from '../middleware/ratelimit.js';
import { credentialCookieOpts } from '../lib/cookies.js';
import * as vault from '../services/vault.js';
import { resolveFile } from '../services/fileindex.js';
import { hashPassword, verifyPassword, MIN_PASSWORD_LEN } from '../services/auth.js';
import { getSettings } from '../services/settings.js';
import {
  listShares, createShare, setShareEnabled, setSharePassword, deleteShare, getActiveShare,
  type ShareRecord,
} from '../services/shares.js';
import { canvasEmbedTargets } from '../services/rendercanvas.js';
import { mimeFor } from '../services/mime.js';
import { sendFileWithRange } from '../services/httpfile.js';

const isMd = (p: string) => /\.(md|markdown)$/i.test(p);
const isCanvas = (p: string) => /\.canvas$/i.test(p);
const isShareable = (p: string) => isMd(p) || isCanvas(p);

/** Never send the password hash to the client: expose `hasPassword` only. */
function redact(rec: ShareRecord) {
  const { passwordHash, ...rest } = rec;
  return { ...rest, hasPassword: Boolean(passwordHash) };
}

/**
 * Upper bound on a share password, enforced when it is SET and again when it is
 * offered at unlock.
 *
 * `express.json({ limit: '32mb' })` is applied app-wide, so without this the
 * unauthenticated unlock endpoint would happily run scrypt over a 32 MB string
 * on demand. scrypt is deliberately expensive (that is the point), and its
 * initial PBKDF2 pass is linear in the password length, so a single request
 * could be turned into seconds of CPU plus the scrypt memory cost: a very cheap
 * amplifier for knocking the whole single-process server over. The rate limiter
 * below bounds how OFTEN that work can be requested; this bounds how MUCH work
 * one request can ask for. Both are needed.
 *
 * Checked at unlock BEFORE the hash comparison, which is the only placement
 * that achieves anything: rejecting after scrypt has run has already paid the
 * cost the bound exists to avoid.
 *
 * On the residual, stated honestly rather than argued away. An earlier version
 * of this comment claimed an over-long candidate "cannot possibly be the stored
 * password because the same bound applies at set time". That is only true of
 * passwords set after this bound existed. A share whose password was set by an
 * older build (which accepted any non-empty string) or written straight into
 * shares.json by hand can legitimately exceed 1024 characters, and for that
 * record the correct password now fails. Two things keep this acceptable:
 *
 *  - It is recoverable, and by the owner, not by us. The authenticated
 *    management API (PATCH /api/shares/:id) sets or clears the password with no
 *    reference to the old one, so the share is never stranded: the fix is one
 *    click in the UI that already exists.
 *  - It is diagnosable. The unlock handler answers 400 with the actual reason
 *    for an over-long candidate instead of folding it into the generic 401, so
 *    the owner sees "too long" rather than chasing a password they are typing
 *    correctly. This gives an attacker nothing: MAX_SHARE_PASSWORD_LEN is a
 *    public constant in an open-source repo, the check runs before any
 *    comparison, and its answer is a function of the submitted length alone,
 *    never of the stored hash.
 *
 * The alternative (verify anyway, however long the candidate) reopens the
 * amplifier for every request, to protect a record that may not exist. Bounding
 * the work and giving the rare affected owner a clear message and a working
 * reset is the better trade.
 */
const MAX_SHARE_PASSWORD_LEN = 1024;

/**
 * A share page is served to whoever holds (or does not hold) an unlock cookie,
 * so every response on this surface is per-visitor and must never be reused by a
 * shared cache. The project explicitly supports running behind a reverse proxy,
 * and a proxy that cached an unlocked response would serve the note's contents
 * to the next visitor, who supplied no password at all: the credential check
 * would be bypassed without anyone touching the app.
 *
 * `no-store` rather than a short private max-age, and applied unconditionally
 * rather than only to password-protected shares, because revocation matters for
 * the unprotected ones too: disabling or deleting a share has to take effect
 * immediately, and a cached copy would keep answering after the owner believed
 * they had pulled the link. `Vary: Cookie` is belt and braces for caches that
 * ignore `private`.
 */
export function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Cookie');
}

/** ---- Management API (session auth): /api/shares ------------------------- */

export const sharesRouter = Router();
sharesRouter.use(requireAuth);

sharesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ shares: (await listShares()).map(redact) });
  }),
);

sharesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const rel = String(req.body?.path ?? '');
    if (!rel || !isShareable(rel)) {
      res.status(400).json({ error: 'path to a .md or .canvas note required' });
      return;
    }
    if (!(await vault.exists(rel))) {
      res.status(404).json({ error: 'note not found' });
      return;
    }
    res.json({ share: redact(await createShare(rel)) });
  }),
);

// Update a share: { enabled?: boolean, password?: string | null }.
// password: non-empty string sets it (scrypt-hashed); null/'' removes it.
sharesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { enabled, password } = req.body ?? {};
    const hasEnabled = typeof enabled === 'boolean';
    const hasPassword = password !== undefined;
    if (!hasEnabled && !hasPassword) {
      res.status(400).json({ error: 'enabled (boolean) or password (string|null) required' });
      return;
    }
    if (hasPassword && password !== null && typeof password !== 'string') {
      res.status(400).json({ error: 'password must be a string or null' });
      return;
    }
    // A share password guards a note that is published to the open internet, so
    // it needs at least the strength policy the owner's own login password gets.
    // Previously any non-empty string was accepted here while /auth/change-password
    // enforced MIN_PASSWORD_LEN, which meant the credential protecting the more
    // exposed surface was the weaker of the two: a one-character password on a
    // public URL. '' and null still mean "remove the password" and are exempt.
    if (typeof password === 'string' && password.length > 0) {
      if (password.length < MIN_PASSWORD_LEN) {
        res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters` });
        return;
      }
      if (password.length > MAX_SHARE_PASSWORD_LEN) {
        res.status(400).json({ error: `Password must be at most ${MAX_SHARE_PASSWORD_LEN} characters` });
        return;
      }
    }
    let rec = hasEnabled ? await setShareEnabled(req.params.id, enabled) : null;
    if (hasPassword) {
      const hash = password ? await hashPassword(password) : null;
      rec = await setSharePassword(req.params.id, hash);
    }
    if (!rec) {
      res.status(404).json({ error: 'share not found' });
      return;
    }
    res.json({ share: redact(rec) });
  }),
);

sharesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ok = await deleteShare(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'share not found' });
      return;
    }
    res.json({ ok: true });
  }),
);

/** ---- Public API (NO auth): /public/shares ------------------------------- */

/**
 * Files the shared note embeds (`![[target]]` and `![](relative-url)`): the
 * only paths the public file endpoint is allowed to serve. Mirrors the
 * client-side markdown preprocessing in web/src/lib/markdown.ts.
 */
function embedTargets(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(/!\[\[([^\]]+?)\]\]/g)) {
    const t = m[1].split('|')[0].split('#')[0].trim();
    if (t) out.add(t);
  }
  for (const m of content.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    const url = m[1].replace(/\s+"[^"]*"$/, '').trim();
    // web-loadable URLs are loaded directly by the browser, not via the vault
    if (url && !/^(https?|data|blob|file):/i.test(url)) {
      // decodeURIComponent THROWS on a malformed sequence ('%zz', a lone '%').
      // Unguarded, one stray '%' in a shared note turned every request to this
      // unauthenticated endpoint into a 500, so no image on that page loaded.
      // Falling back to the raw text is not a widening: undecoded text only
      // resolves if it genuinely is the file's name.
      const name = url.split('/').pop() || url;
      try {
        out.add(decodeURIComponent(name));
      } catch {
        out.add(name);
      }
    }
  }
  return [...out];
}

/** Resolve a path/basename the same way GET /api/files/content does. */
async function resolveVaultPath(rel: string): Promise<string | null> {
  if (await vault.exists(rel)) return rel;
  return resolveFile(rel) ?? null;
}

export const publicSharesRouter = Router();

const UNLOCK_TTL = '12h';
const UNLOCK_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const unlockCookie = (id: string) => `wo_share_${id}`;

/**
 * Options for the unlock cookie, from the one module that owns the rule
 * (lib/cookies.ts). The session cookie in routes/auth.ts is built from the same
 * function, which is the point: these two cookies are the same kind of thing and
 * must not be allowed to drift apart.
 *
 * Why the `Secure` half matters here specifically. The unlock cookie once
 * shipped with no `secure` flag at all. On an HTTPS deployment that meant a
 * bearer token good for 12 hours of access to a private note was also attached
 * to any plain-http:// request to the same host, in cleartext, where anyone on
 * the path could lift it. It is scoped `path: '/'` (so the SSR page and the file
 * endpoint both receive it), which makes that exposure broad rather than narrow:
 * every request to the origin carries it.
 */
function unlockCookieOpts(req: Request) {
  return credentialCookieOpts(req, UNLOCK_MAX_AGE_MS);
}

const UNLOCK_WINDOW_MS = 15 * 60 * 1000;
const UNLOCK_THROTTLE_MESSAGE = 'Too many unlock attempts. Try again later.';

/**
 * Brute-force guard for the unlock endpoint, in two stages. This is the outer,
 * client-wide half; `unlockShareRateLimit` below is the per-share half.
 *
 * This is the only credential check standing between the open internet and a
 * note its owner chose to publish privately, and it is unauthenticated, so it
 * needs at least the protection /auth/login already has. Without it a share
 * password could be ground down at whatever rate the box can compute scrypt,
 * from anywhere, silently.
 *
 * WHY TWO LIMITERS RATHER THAN ONE. The natural key is (client, share), so that
 * hammering one share cannot exhaust a visitor's budget for unrelated shares,
 * and so that an attacker cannot lock every legitimate visitor out of a share by
 * burning its single bucket. That was the whole design, and as route-level
 * middleware it had a defect it could not see: the share half of the key was
 * `req.params.id`, an arbitrary attacker-supplied path segment, evaluated BEFORE
 * anything had checked that a share by that name exists. The key space of a
 * limiter whose key is chosen by the caller is not a key space at all. One
 * unauthenticated client could mint a distinct bucket per request, each key as
 * long as Node's 16 KB header limit allows, and every one of them retained for
 * the full 15-minute window. The limiter's own store became the cheapest denial
 * of service on the box, reachable by exactly the traffic the limiter exists to
 * absorb.
 *
 * Shape-checking the id would not have fixed it. A share id is
 * `randomBytes(16).toString('base64url')` (services/shares.ts), so "looks like a
 * share id" is a 128-bit space the attacker can enumerate for free. The only
 * bound that actually holds is EXISTENCE: key on the id only once the store has
 * confirmed a share by that id, which caps the key space at (clients x shares
 * the owner actually created).
 *
 * So the check splits along the same seam as the knowledge required to perform
 * it:
 *
 *  - `unlockClientRateLimit` runs as route middleware, before any I/O, keyed on
 *    the client alone (the default `clientIp` rule, so there is nothing to keep
 *    in step by hand). One bucket per client, so the key space is bounded by
 *    definition. It also meters the cost of the lookup itself, which would
 *    otherwise be a free stat-and-parse per request for any id at all.
 *  - `unlockShareRateLimit` runs inside the handler, after `getActiveShare` has
 *    returned a record, keyed on (client, share). This is the real brute-force
 *    guard and it keeps the per-share granularity the original design wanted.
 *
 * The tradeoff this introduces, stated rather than discovered later: an attacker
 * sharing an apparent client address with real visitors can now burn a budget
 * that spans shares, where before each share was independent. That is why the
 * outer number is 100 and not 20. It is five shares' worth of full inner budget,
 * so it only trips under abuse, and the alternative (no client-wide cap) is what
 * left the store unbounded. The inner limit of 20, rather than login's 10,
 * leaves room for the availability caveat inherited from the keying rule: when
 * no trust boundary is configured the client half can collapse to the reverse
 * proxy's socket address, so every visitor of one share may share a bucket.
 *
 * The client half is `clientIp` imported from middleware/ratelimit.ts rather
 * than transcribed. This file used to carry its own copy of the client-keying
 * rule with a comment asking the next person to keep the two in step by hand,
 * and they did not stay in step: that module replaced its old heuristic with the
 * `ThrottleKeySource` model, under which a bare `trust proxy: true` no longer
 * licenses believing `req.ip` at all, while the copy here still did. That left
 * the only unauthenticated credential check in the app as the single one keyed
 * on a forgeable value. Importing means that class of drift cannot recur.
 */
const unlockClientRateLimit = createRateLimiter({
  windowMs: UNLOCK_WINDOW_MS,
  max: 100,
  message: UNLOCK_THROTTLE_MESSAGE,
});

/**
 * Keyed on `req.params.id`, which is safe ONLY because this limiter is invoked
 * by hand after `getActiveShare(req.params.id)` returned a record.
 * `getActiveShare` matches with `s.id === id` (services/shares.ts), so at that
 * point the path segment is byte-identical to a stored share id: bounded in
 * length, and bounded in count by the number of shares that exist. Registering
 * this as route middleware would silently undo that and restore the unbounded
 * key space described above.
 */
const unlockShareRateLimit = createRateLimiter({
  windowMs: UNLOCK_WINDOW_MS,
  max: 20,
  keyFn: (req) => `${clientIp(req)}|${req.params.id}`,
  message: UNLOCK_THROTTLE_MESSAGE,
});

/**
 * Run a rate limiter from inside a handler and report whether it let the request
 * through.
 *
 * This depends on one property of `createRateLimiter`: its handler is fully
 * synchronous, so by the time it returns it has either called `next()` or
 * already written the 429. That is true of middleware/ratelimit.ts (no await, no
 * I/O, a Map lookup and a timestamp array) and it is the same assumption
 * middleware/apikey.ts already makes when it invokes its own limiter directly,
 * so the coupling is at least consistent across the codebase rather than novel
 * here.
 *
 * It is still an assumption about someone else's module, so the caller checks
 * `res.headersSent` before returning. If the limiter ever became asynchronous
 * this would read "not allowed" for a request that was in fact allowed, and
 * without that check the handler would return having sent nothing at all: the
 * request would hang until the client gave up, which is a far worse failure than
 * a spurious 429.
 */
function passesLimiter(limiter: RequestHandler, req: Request, res: Response): boolean {
  let allowed = false;
  limiter(req, res, () => {
    allowed = true;
  });
  return allowed;
}

/** True when the share has no password, or the visitor carries a valid unlock cookie. */
export async function isUnlocked(req: Request, share: ShareRecord): Promise<boolean> {
  if (!share.passwordHash) return true;
  const token = req.cookies?.[unlockCookie(share.id)];
  if (!token) return false;
  try {
    const s = await getSettings();
    const payload = jwt.verify(token, s.auth.jwtSecret, { algorithms: ['HS256'] }) as {
      sub?: string;
      share?: string;
    };
    return payload.sub === 'share' && payload.share === share.id;
  } catch {
    return false;
  }
}

// Exchange the share password for an unlock cookie scoped to this share's
// public endpoints (httpOnly so embedded <img> requests send it automatically).
publicSharesRouter.post(
  '/:id/unlock',
  // An unlock outcome is per-visitor and must not be cached or revalidated from
  // a shared cache, same reasoning as the pages themselves. Set BEFORE the rate
  // limiter, not inside the handler: the limiter answers its own 429 and returns
  // without ever reaching the handler, so a limiter placed first produced the one
  // response on this route with no Cache-Control and no Vary at all. That is the
  // same oversight round 2 found on the file endpoint's 404 branches, and it
  // matters for the same reason: the response varies on the client, and a shared
  // cache that pinned one visitor's 429 would hand it to visitors who had not
  // exhausted anything.
  (_req, res, next) => {
    noStore(res);
    next();
  },
  unlockClientRateLimit,
  asyncHandler(async (req, res) => {
    const share = await getActiveShare(req.params.id);
    if (!share || !share.passwordHash) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    // The per-share brute-force guard, applied here and not as route middleware
    // so that its key is a share id the store confirmed rather than one the
    // caller invented. See unlockShareRateLimit for why that ordering is the
    // whole point.
    //
    // It runs BEFORE the length check below, deliberately, so that every attempt
    // is counted whatever its outcome: a cheap 400 must not be a free pass
    // around the throttle.
    if (!passesLimiter(unlockShareRateLimit, req, res)) {
      // The limiter answered with the 429 itself. This is the belt-and-braces
      // half described on passesLimiter: never return without a response.
      if (!res.headersSent) res.status(429).json({ error: UNLOCK_THROTTLE_MESSAGE });
      return;
    }
    // Reject a non-string or over-long candidate BEFORE scrypt runs, so a 32 MB
    // body (see MAX_SHARE_PASSWORD_LEN and the app-wide express.json limit)
    // cannot buy an attacker seconds of key-derivation work per request.
    //
    // The over-long case answers 400 with its real reason rather than hiding
    // inside the 401. It used to fold into "wrong password" on the theory that
    // an over-long candidate could never be the stored one, which is false for a
    // record whose password predates this bound: that owner would have seen
    // nothing but "wrong password" forever, for a password they were typing
    // correctly, with no way to tell the difference. Separating the two leaks
    // nothing, because this branch is decided purely by the length of what the
    // caller sent and never touches the stored hash. The rate limiter has
    // already counted the request either way, so the cheap path is not a free
    // pass around the throttle.
    const raw: unknown = req.body?.password;
    const password = typeof raw === 'string' ? raw : '';
    if (password.length > MAX_SHARE_PASSWORD_LEN) {
      res
        .status(400)
        .json({ error: `Password must be at most ${MAX_SHARE_PASSWORD_LEN} characters` });
      return;
    }
    if (!password || !(await verifyPassword(password, share.passwordHash))) {
      res.status(401).json({ error: 'wrong password' });
      return;
    }
    const s = await getSettings();
    const token = jwt.sign({ sub: 'share', share: share.id }, s.auth.jwtSecret, {
      expiresIn: UNLOCK_TTL,
      algorithm: 'HS256',
    });
    // Path '/' so both /public/shares/<id>/* (content, files) AND the SSR page
    // at /share/<id> receive it. The JWT is bound to this share id only.
    res.cookie(unlockCookie(share.id), token, unlockCookieOpts(req));
    res.json({ ok: true });
  }),
);

publicSharesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    // Set before any branch: the 404, the "password required" 401 and the
    // content response are all per-visitor, and it is the cached CONTENT
    // response that would hand a note to someone who never unlocked it.
    noStore(res);
    const share = await getActiveShare(req.params.id);
    if (!share || !(await vault.exists(share.path))) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (!(await isUnlocked(req, share))) {
      res.status(401).json({ error: 'password required', passwordRequired: true });
      return;
    }
    const title = (share.path.split('/').pop() ?? share.path).replace(/\.(md|markdown|canvas)$/i, '');
    // NOTE: only title + content. The vault path/structure is not exposed.
    res.json({ title, content: await vault.readFileText(share.path) });
  }),
);

publicSharesRouter.get(
  '/:id/file',
  asyncHandler(async (req, res) => {
    // Default the whole handler to no-store, before any branch, then let the
    // success path below opt back in where it can justify it.
    //
    // The earlier version only set cache headers on the success path, which left
    // every 404 (`:id` unknown, `path` missing, not in the allowlist) and every
    // 401 (locked) with no Cache-Control and no Vary at all. A 404 is
    // heuristically cacheable (RFC 9111 4.2.2) and the response varies on the
    // unlock cookie, so a shared cache could pin the 404 a locked visitor
    // produced and then serve it to a visitor who was entitled to the file.
    // That is denial rather than disclosure, but it contradicts the rule the
    // rest of this surface follows, and the fix is one line.
    noStore(res);
    const share = await getActiveShare(req.params.id);
    const requested = String(req.query.path ?? '');
    if (!share || !requested || !(await vault.exists(share.path))) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (!(await isUnlocked(req, share))) {
      res.status(401).json({ error: 'password required', passwordRequired: true });
      return;
    }
    const target = await resolveVaultPath(requested);
    if (!target || isMd(target)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    // Allowlist check: the resolved file must be one the shared note/canvas embeds.
    const content = await vault.readFileText(share.path);
    const targets = isCanvas(share.path) ? await canvasEmbedTargets(content) : embedTargets(content);
    const allowed = new Set<string>();
    for (const t of targets) {
      const r = await resolveVaultPath(t);
      if (r) allowed.add(r);
    }
    if (!allowed.has(target)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    // Stream with Range support so shared <video>/<audio> can seek. These
    // headers deliberately overwrite the handler-wide no-store set above;
    // res.setHeader replaces, so the last writer wins and this is it.
    //
    // A password-protected share's attachments keep `no-store`: they are gated
    // on the unlock cookie exactly like the note body, so a cached copy is the
    // same credential bypass, and browser-cached media outliving the 12h unlock
    // window on a shared machine is a real exposure. Unprotected shares get a
    // 5-minute PRIVATE cache, which is what makes video scrubbing (many Range
    // requests) tolerable. `Vary: Cookie` on both, because whether the response
    // exists at all depends on the cookie.
    //
    // The bounded cost of that 5 minutes, named rather than left to be
    // rediscovered: if the owner adds a password to (or revokes) an unprotected
    // share, a visitor who already loaded an attachment can still read their own
    // cached copy of it until the entry expires. It is bounded to 300s, it is
    // one visitor's own browser (`private` keeps it out of shared caches), and
    // it never covers the note body or a canvas, both of which are `no-store` on
    // every branch. Dropping to no-store here would make every seek in a shared
    // video refetch from disk, which is a real cost paid on every legitimate
    // view to shorten a five-minute window on content that was public anyway at
    // the moment it was fetched.
    const abs = await vault.resolveInVault(target);
    await sendFileWithRange(req, res, abs, mimeFor(target), {
      'Cache-Control': share.passwordHash ? 'private, no-store' : 'private, max-age=300',
      Vary: 'Cookie',
    });
  }),
);
