// SSR page for public share links (FR-10): GET /share/:id returns a complete
// HTML document: note content, <title>, meta description, Open Graph + Twitter
// tags, so crawlers (Google, FB, Zalo…) index/preview it without running JS.
import { Router } from 'express';
import type { Request } from 'express';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { asyncHandler } from '../middleware/error.js';
import * as vault from '../services/vault.js';
import { getActiveShare } from '../services/shares.js';
import { isUnlocked, noStore } from './shares.js';
import { renderNoteHtml, metaDescription, firstImage, escapeHtml } from '../services/renderhtml.js';
import { renderCanvasHtml, canvasDescription, canvasFirstImage, canvasViewerScript } from '../services/rendercanvas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Inline the built SPA stylesheet so the SSR page matches the Reading view. */
let cssCache: { file: string; css: string } | null = null;
async function appCss(): Promise<string> {
  const assets = path.join(__dirname, '..', '..', 'public', 'assets');
  try {
    const files = (await fs.readdir(assets)).filter((f) => /^index-.*\.css$/.test(f)).sort();
    const file = files.at(-1);
    if (!file) return '';
    if (cssCache?.file !== file) {
      cssCache = { file, css: await fs.readFile(path.join(assets, file), 'utf8') };
    }
    return cssCache.css;
  } catch {
    return '';
  }
}

function baseUrl(req: Request): string {
  return `${req.protocol}://${req.get('host')}`;
}

/**
 * `firstImage()` behind a guard, because it can throw and this page must not.
 *
 * `renderhtml.ts`'s `firstImage()` percent-decodes the last path segment of a
 * markdown image URL, and `decodeURIComponent` throws `URIError` on a malformed
 * sequence. `![shot](Attachments/100%.png)` is enough to trigger it, and a bare
 * `%` in an attachment name is an ordinary thing for a human to type, not a
 * crafted payload. The result feeds exactly one thing: the `og:image` meta tag.
 * So the right behaviour when it cannot be computed is to ship the page without
 * a social-preview image, not to answer 500 for the whole note.
 *
 * The guard belongs here in addition to (not instead of) failing soft at the
 * source, because this is the boundary where a decorative extra becomes
 * load-bearing for the entire response. This route is unauthenticated, so
 * anything that throws on the way to it is a remote denial of service on a URL
 * the owner deliberately published, triggered by the content of their own note.
 *
 * Deliberately narrow: `renderNoteHtml` / `renderCanvasHtml` are NOT wrapped. If
 * the body cannot be rendered there is no page to serve and a 500 is the honest
 * answer. Only the optional metadata fails soft.
 */
function firstImageSafe(content: string): { vault?: string; url?: string } | null {
  try {
    return firstImage(content);
  } catch {
    return null;
  }
}

function page(opts: {
  title: string;
  head?: string;
  body: string;
  css: string;
  noindex?: boolean;
  /** Skip the narrow markdown-preview column (used by the full-width canvas view). */
  bare?: boolean;
}): string {
  const inner = opts.bare
    ? opts.body
    : `<div class="markdown-preview">
<div class="preview-inner">
${opts.body}
</div>
</div>`;
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="${opts.noindex ? 'noindex, nofollow' : 'index, follow'}" />
<title>${escapeHtml(opts.title)}</title>
${opts.head ?? ''}<style>${opts.css}</style>
</head>
<body>
<div class="theme-light public-page${opts.bare ? ' public-canvas' : ''}">
${inner}
</div>
</body>
</html>`;
}

export const sharePageRouter = Router();

sharePageRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const share = await getActiveShare(req.params.id);
    const css = await appCss();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Per-visitor on the unlock cookie, on every branch below: the same URL
    // returns either the unlock form or the note itself depending on the cookie.
    // This project supports reverse-proxy deployment, and a cache that stored
    // the unlocked variant would then serve a private note to a visitor who
    // never supplied the password. See noStore() in routes/shares.ts for why it
    // is unconditional rather than password-only.
    noStore(res);

    if (!share || !(await vault.exists(share.path))) {
      res.status(404).send(
        page({
          title: 'Note not found',
          noindex: true,
          css,
          body: '<div class="public-error">This note is not available.</div>',
        }),
      );
      return;
    }

    const pageUrl = `${baseUrl(req)}/share/${share.id}`;

    // Password-protected & not unlocked: render the unlock form only, never
    // leak content or descriptive metadata to crawlers.
    //
    // On the form's error handling below, which is deliberately not "any failure
    // means wrong password": that phrasing is a lie in the two cases that
    // matter. A rate-limited visitor (429 from unlockRateLimit) was told to try
    // again, so they kept hammering a bucket that only refills with silence, and
    // could not tell a throttle from a bad guess. An over-long candidate (400,
    // see MAX_SHARE_PASSWORD_LEN in routes/shares.ts) is the one case where an
    // owner whose password predates that bound is typing it CORRECTLY and needs
    // to be told why it can never work; without this the diagnosability that
    // constant's comment promises does not actually reach anyone.
    //
    // 401 keeps the friendly wording on purpose. It is the only branch whose
    // outcome depends on the stored hash, so it is the only one where being
    // vague costs nothing, and "wrong password" from the API is worse copy than
    // what we write here. The message is assigned through textContent, never
    // innerHTML: it is server-authored today, but that is a property of the
    // handler and not of this sink, and a sink that cannot inject is one less
    // thing to re-verify if the error strings ever change.
    if (!(await isUnlocked(req, share))) {
      res.send(
        page({
          title: 'Protected note',
          noindex: true,
          css,
          body: `
<form class="public-unlock" id="unlock-form">
  <div class="public-unlock-title">This note is password-protected</div>
  <input class="text-input" type="password" id="unlock-pw" placeholder="Password" autofocus />
  <button class="btn" type="submit">Open note</button>
  <div class="public-unlock-error" id="unlock-err"></div>
</form>
<script nonce="${res.locals.cspNonce}">
document.getElementById('unlock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('unlock-err');
  err.textContent = '';
  const r = await fetch('/public/shares/${share.id}/unlock', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('unlock-pw').value }),
  }).catch(() => null);
  if (r && r.ok) { location.reload(); return; }
  // Server's own reason for every status except 401 (see the handler comment).
  let msg = 'Wrong password, try again.';
  if (r && r.status !== 401) {
    const body = await r.json().catch(() => null);
    if (body && typeof body.error === 'string' && body.error) msg = body.error;
  }
  err.textContent = msg;
});
</script>`,
        }),
      );
      return;
    }

    const content = await vault.readFileText(share.path);
    const isCanvas = /\.canvas$/i.test(share.path);
    const title = (share.path.split('/').pop() ?? share.path).replace(/\.(md|markdown|canvas)$/i, '');
    const fileUrl = (p: string) => `/public/shares/${share.id}/file?path=${encodeURIComponent(p)}`;
    const desc = isCanvas ? canvasDescription(content) : metaDescription(content);
    const imgVault = isCanvas ? canvasFirstImage(content) : null;
    const img = isCanvas ? null : firstImageSafe(content);
    const ogImage = img?.url ?? (img?.vault ?? imgVault
      ? `${baseUrl(req)}/public/shares/${share.id}/file?path=${encodeURIComponent((img?.vault ?? imgVault) as string)}`
      : null);

    const html = isCanvas
      ? await renderCanvasHtml(content, fileUrl)
      : await renderNoteHtml(content, fileUrl);

    const head = [
      `<meta name="description" content="${escapeHtml(desc)}" />`,
      `<link rel="canonical" href="${escapeHtml(pageUrl)}" />`,
      `<meta property="og:type" content="article" />`,
      `<meta property="og:site_name" content="WebObsidian" />`,
      `<meta property="og:title" content="${escapeHtml(title)}" />`,
      `<meta property="og:description" content="${escapeHtml(desc)}" />`,
      `<meta property="og:url" content="${escapeHtml(pageUrl)}" />`,
      ...(ogImage ? [
        `<meta property="og:image" content="${escapeHtml(ogImage)}" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:image" content="${escapeHtml(ogImage)}" />`,
      ] : [
        `<meta name="twitter:card" content="summary" />`,
      ]),
      `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
      `<meta name="twitter:description" content="${escapeHtml(desc)}" />`,
    ].join('\n') + '\n';

    res.send(
      page({
        title,
        head,
        css,
        bare: isCanvas,
        body: isCanvas
          ? `<div class="public-canvas-title">${escapeHtml(title)}</div>\n${html}\n${canvasViewerScript(res.locals.cspNonce)}`
          : `<div class="inline-title">${escapeHtml(title)}</div>\n${html}`,
      }),
    );
  }),
);
