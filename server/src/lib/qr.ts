/**
 * A minimal QR Code encoder (ISO/IEC 18004), byte mode, error-correction level M.
 *
 * It exists for exactly one job: turning an encrypted Setup URI into something a
 * phone camera can read, so that joining device N+1 is "point the camera at the
 * screen" rather than "retype a CouchDB URL, a username, a password and two
 * passphrases".
 *
 * ---------------------------------------------------------------------------
 * WHY HAND-WRITTEN RATHER THAN A DEPENDENCY
 *
 * The alternative was a bundled npm QR library, which the security review
 * explicitly permits (a bundled package is served from our own origin and so
 * satisfies `script-src 'self'` with no CSP change). It was not taken because
 * this encoder is small, has no configuration surface, and -- crucially -- is
 * TESTABLE HERE. `web/` has no test runner; `server/` does. Putting the encoder
 * on the server side means every claim below is pinned by
 * `src/__tests__/qr.test.ts`, including an independent decoder that reads the
 * matrix back. A QR that scans to garbage is a silent failure, so "we can test
 * it" was the deciding argument rather than dependency count.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * The output is a boolean MATRIX, not an image and not markup. Two reasons, both
 * about the boundary this crosses:
 *
 *  - No SVG or HTML string is ever built here and injected there, so the client
 *    never needs `dangerouslySetInnerHTML` and there is no markup-injection
 *    question to reason about at all. The client turns the matrix into one SVG
 *    `<path>` via React, which is data, not markup.
 *  - There is no image ENDPOINT. An image URL would be cacheable, prefetchable,
 *    `Referer`-leaking and "save image as"-able into a synced photo library. The
 *    matrix rides in the same one-shot POST response as the URI itself and lives
 *    exactly as long.
 *
 * Only byte mode is implemented. Numeric and alphanumeric modes are denser, but
 * a Setup URI is base64 inside a percent-encoded query, which is neither, so
 * they would be dead code on the one input this encoder has.
 *
 * ---------------------------------------------------------------------------
 * WHY LEVEL M, AND WHY ONLY ONE LEVEL
 *
 * M (~15% recovery) is the usual default and the right trade for a code being
 * read off a bright screen at close range, where the damage a higher level
 * protects against does not occur; L would buy density we do not need and Q/H
 * would cost a larger, denser code for nothing. Supporting one level keeps the
 * block table to 40 rows of two numbers, which matters because a transcription
 * error in that table is exactly the kind of defect that produces a valid-looking
 * QR that no reader accepts.
 */

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * Per version (index 0 = version 1): the number of error-correction codewords
 * PER BLOCK, and the number of blocks, at level M.
 *
 * These two numbers are all that is needed. The rest of the block structure is
 * DERIVED by the specification's own rule rather than transcribed:
 *
 *     totalDataCodewords = totalCodewords - blocks * ecPerBlock
 *     shortBlocks        = blocks - (totalDataCodewords mod blocks)
 *
 * so `shortBlocks` blocks carry `floor(totalDataCodewords / blocks)` data
 * codewords and the remainder carry one more. Deriving it removes ~120 hand
 * transcribed numbers, and `totalCodewords` itself is COMPUTED FROM THE MATRIX
 * GEOMETRY (see `totalCodewordsForVersion`) rather than being a third table.
 *
 * That geometric derivation is what makes this table self-checking: the test
 * suite asserts, for every one of the 40 versions, that the codeword accounting
 * closes exactly against the number of free modules the matrix builder actually
 * leaves. A wrong row cannot satisfy that by accident.
 */
const EC_M: ReadonlyArray<readonly [ecPerBlock: number, blocks: number]> = [
  [10, 1], [16, 1], [26, 1], [18, 2], [24, 2], [16, 4], [18, 4], [22, 4],
  [22, 5], [26, 5], [30, 5], [22, 8], [22, 9], [24, 9], [24, 10], [28, 10],
  [28, 11], [26, 13], [26, 14], [26, 16], [26, 17], [28, 17], [28, 18], [28, 20],
  [28, 21], [28, 23], [28, 25], [28, 26], [28, 28], [28, 29], [28, 31], [28, 33],
  [28, 35], [28, 37], [28, 38], [28, 40], [28, 43], [28, 45], [28, 47], [28, 49],
];

/**
 * Alignment-pattern centre coordinates per version (index 0 = version 1).
 *
 * Every pairing of these coordinates is an alignment centre EXCEPT the three
 * that collide with a finder pattern (top-left, top-right, bottom-left), which
 * `placeAlignmentPatterns` skips. Version 1 has none.
 */
const ALIGNMENT: ReadonlyArray<readonly number[]> = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
  [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66],
  [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86],
  [6, 34, 62, 90], [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106], [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146], [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170],
];

/** Level M's two-bit indicator in the format information. Not 0b00 by accident: the levels are ordered L,M,Q,H as 01,00,11,10. */
const EC_LEVEL_BITS_M = 0b00;

const MAX_VERSION = 40;

// ---------------------------------------------------------------------------
// GF(256) arithmetic for Reed-Solomon
// ---------------------------------------------------------------------------

/**
 * Exponent/log tables for GF(2^8) with the QR primitive polynomial
 * x^8 + x^4 + x^3 + x^2 + 1 (0x11D) and generator 2.
 *
 * Built at module load rather than written out, because a generated table cannot
 * contain a transcription error and the generation is three lines.
 */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  // Duplicated into the upper half so a product of two logs (max 254+254=508)
  // can be looked up without a modulo on the hot path.
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/**
 * The generator polynomial for `degree` error-correction codewords:
 * (x - 2^0)(x - 2^1)...(x - 2^(degree-1)).
 */
function generatorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/**
 * Reed-Solomon remainder: polynomial long division of the data (shifted left by
 * `ecLength`) by the generator, in GF(256). The remainder IS the EC codewords.
 */
export function reedSolomon(data: Uint8Array, ecLength: number): Uint8Array {
  const gen = generatorPoly(ecLength);
  const remainder = new Uint8Array(data.length + ecLength);
  remainder.set(data, 0);
  for (let i = 0; i < data.length; i += 1) {
    const factor = remainder[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j += 1) {
      remainder[i + j] ^= gfMul(gen[j], factor);
    }
  }
  return remainder.subarray(data.length);
}

// ---------------------------------------------------------------------------
// BCH codes for the format and version information
// ---------------------------------------------------------------------------

/** Bit length of `value`, i.e. position of its highest set bit plus one. */
function bitLength(value: number): number {
  let n = 0;
  while (value >>> n) n += 1;
  return n;
}

/**
 * BCH remainder of `value` under `generator`.
 *
 * Used for both the (15,5) format information and the (18,6) version
 * information. Computing them means the notorious 32-entry format table and the
 * 34-entry version table are never transcribed at all.
 */
function bchRemainder(value: number, generator: number): number {
  const genBits = bitLength(generator);
  let v = value;
  while (bitLength(v) >= genBits) {
    v ^= generator << (bitLength(v) - genBits);
  }
  return v;
}

/**
 * The 15-bit format information: 5 data bits (2 EC level + 3 mask) followed by a
 * 10-bit BCH remainder, the whole XORed with 0b101010000010010.
 *
 * The XOR mask is not decoration: without it, level M with mask 0 would be all
 * zeros, and a reader cannot distinguish an all-zero format area from a blank
 * one.
 */
function formatBits(mask: number): number {
  const data = (EC_LEVEL_BITS_M << 3) | mask;
  const bch = bchRemainder(data << 10, 0b10100110111);
  return ((data << 10) | bch) ^ 0b101010000010010;
}

/** The 18-bit version information (versions 7+): 6 version bits + 12-bit BCH. */
function versionBits(version: number): number {
  return (version << 12) | bchRemainder(version << 12, 0b1111100100101);
}

// ---------------------------------------------------------------------------
// Matrix geometry
// ---------------------------------------------------------------------------

export const enum Module {
  Empty = 0,
  Light = 1,
  Dark = 2,
  /** A function-pattern module: reserved, never carries data, never masked. */
  FunctionLight = 3,
  FunctionDark = 4,
}

const isDark = (m: Module) => m === Module.Dark || m === Module.FunctionDark;
const isFunction = (m: Module) => m === Module.FunctionLight || m === Module.FunctionDark;

const sizeForVersion = (version: number) => version * 4 + 17;

type Grid = Module[][];

function blankGrid(version: number): Grid {
  const size = sizeForVersion(version);
  return Array.from({ length: size }, () => new Array<Module>(size).fill(Module.Empty));
}

/** The 7x7 finder pattern plus its one-module separator, anchored at (row, col). */
function placeFinder(grid: Grid, row: number, col: number): void {
  const size = grid.length;
  // -1..7 rather than 0..6 so the separator ring is written in the same pass.
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
      const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      grid[rr][cc] = inRing || inCore ? Module.FunctionDark : Module.FunctionLight;
    }
  }
}

function placeAlignmentPatterns(grid: Grid, version: number): void {
  const centres = ALIGNMENT[version - 1];
  const size = grid.length;
  for (const r of centres) {
    for (const c of centres) {
      // Skip the three that would sit on a finder pattern.
      const onFinder =
        (r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6);
      if (onFinder) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          grid[r + dr][c + dc] = ring === 1 ? Module.FunctionLight : Module.FunctionDark;
        }
      }
    }
  }
}

function placeTimingPatterns(grid: Grid): void {
  const size = grid.length;
  for (let i = 8; i < size - 8; i += 1) {
    const m = i % 2 === 0 ? Module.FunctionDark : Module.FunctionLight;
    grid[6][i] = m;
    grid[i][6] = m;
  }
}

/**
 * Reserve the format-information areas and set the permanently dark module.
 *
 * The reservation has to happen BEFORE data placement even though the real bits
 * are written afterwards, otherwise the zigzag walk would happily fill those
 * cells with payload.
 */
function reserveFormatAreas(grid: Grid): void {
  const size = grid.length;
  for (let i = 0; i < 9; i += 1) {
    if (grid[8][i] === Module.Empty) grid[8][i] = Module.FunctionLight;
    if (grid[i][8] === Module.Empty) grid[i][8] = Module.FunctionLight;
  }
  for (let i = 0; i < 8; i += 1) {
    grid[8][size - 1 - i] = Module.FunctionLight;
    grid[size - 1 - i][8] = Module.FunctionLight;
  }
  // The "dark module", always dark, always at (4*version + 9, 8).
  grid[size - 8][8] = Module.FunctionDark;
}

/** Version information blocks (versions 7 and up only). */
function placeVersionInfo(grid: Grid, version: number): void {
  if (version < 7) return;
  const size = grid.length;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i += 1) {
    const bit = (bits >> i) & 1 ? Module.FunctionDark : Module.FunctionLight;
    const r = Math.floor(i / 3);
    const c = i % 3;
    grid[r][size - 11 + c] = bit;
    grid[size - 11 + c][r] = bit;
  }
}

function buildFunctionPatterns(version: number): Grid {
  const grid = blankGrid(version);
  const size = grid.length;
  placeFinder(grid, 0, 0);
  placeFinder(grid, 0, size - 7);
  placeFinder(grid, size - 7, 0);
  placeAlignmentPatterns(grid, version);
  placeTimingPatterns(grid);
  reserveFormatAreas(grid);
  placeVersionInfo(grid, version);
  return grid;
}

/**
 * Total codewords a version holds, derived from the geometry rather than looked
 * up: build the function patterns, count what is left, divide by eight.
 *
 * Doing it this way makes the EC_M table self-checking (see its note) and means
 * the "remainder bits" that the specification tabulates per version fall out
 * automatically as the leftover modules that `floor` discards.
 */
export function totalCodewordsForVersion(version: number): number {
  const grid = buildFunctionPatterns(version);
  let free = 0;
  for (const row of grid) for (const m of row) if (m === Module.Empty) free += 1;
  return Math.floor(free / 8);
}

// ---------------------------------------------------------------------------
// Data encoding
// ---------------------------------------------------------------------------

/** The byte-mode character-count indicator is 8 bits below version 10, else 16. */
const countBits = (version: number) => (version < 10 ? 8 : 16);

function dataCapacityBytes(version: number): number {
  const [ecPerBlock, blocks] = EC_M[version - 1];
  const dataCodewords = totalCodewordsForVersion(version) - ecPerBlock * blocks;
  // 4 bits of mode indicator plus the character count, rounded up to whole bytes.
  return dataCodewords - Math.ceil((4 + countBits(version)) / 8);
}

/** The smallest version that fits `byteLength` bytes at level M, or null. */
function chooseVersion(byteLength: number): number | null {
  for (let v = 1; v <= MAX_VERSION; v += 1) {
    if (byteLength <= dataCapacityBytes(v)) return v;
  }
  return null;
}

class BitWriter {
  private readonly bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }

  /** Pad to a byte boundary and emit codewords. */
  toBytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, i) => {
      if (bit) out[i >> 3] |= 0x80 >> (i & 7);
    });
    return out;
  }
}

/**
 * Mode indicator, length, payload, terminator, then the specification's
 * alternating 0xEC / 0x11 pad bytes.
 */
function encodeData(bytes: Uint8Array, version: number): Uint8Array {
  const [ecPerBlock, blocks] = EC_M[version - 1];
  const dataCodewords = totalCodewordsForVersion(version) - ecPerBlock * blocks;

  const writer = new BitWriter();
  writer.push(0b0100, 4); // byte mode
  writer.push(bytes.length, countBits(version));
  for (const b of bytes) writer.push(b, 8);
  // Terminator: up to four zero bits, truncated if the capacity ends sooner.
  writer.push(0, Math.min(4, dataCodewords * 8 - writer.length));

  const out = new Uint8Array(dataCodewords);
  out.set(writer.toBytes(), 0);
  for (let i = writer.toBytes().length; i < dataCodewords; i += 1) {
    out[i] = (i - writer.toBytes().length) % 2 === 0 ? 0xec : 0x11;
  }
  return out;
}

/**
 * Split into blocks, compute each block's EC codewords, then INTERLEAVE.
 *
 * The interleaving is what makes the error correction useful: a scratch across
 * the symbol damages one codeword from many blocks rather than many codewords
 * from one block, and each block can only repair `ecPerBlock / 2` errors.
 */
function interleave(data: Uint8Array, version: number): Uint8Array {
  const [ecPerBlock, blocks] = EC_M[version - 1];
  const shortBlocks = blocks - (data.length % blocks);
  const shortLength = Math.floor(data.length / blocks);

  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < blocks; i += 1) {
    const length = shortLength + (i < shortBlocks ? 0 : 1);
    const block = data.subarray(offset, offset + length);
    offset += length;
    dataBlocks.push(block);
    ecBlocks.push(reedSolomon(block, ecPerBlock));
  }

  const out = new Uint8Array(data.length + ecPerBlock * blocks);
  let at = 0;
  // Column-major over the data blocks. The longer blocks contribute one extra
  // codeword in the final column, which is why the bounds check is per block.
  for (let i = 0; i < shortLength + 1; i += 1) {
    for (const block of dataBlocks) if (i < block.length) out[at++] = block[i];
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const block of ecBlocks) out[at++] = block[i];
  }
  return out;
}

/**
 * Walk the symbol placing bits: two-module-wide columns, right to left,
 * alternating upward and downward, skipping the vertical timing column.
 */
function placeData(grid: Grid, codewords: Uint8Array): void {
  const size = grid.length;
  let bitIndex = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern; the two-wide columns to its left
    // are shifted by one. Without this the walk desynchronises for every version.
    const rightCol = right <= 6 ? right - 1 : right;
    for (let i = 0; i < size; i += 1) {
      const row = upward ? size - 1 - i : i;
      for (const col of [rightCol, rightCol - 1]) {
        if (grid[row][col] !== Module.Empty) continue;
        const bit =
          bitIndex < codewords.length * 8
            ? (codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1
            : 0;
        bitIndex += 1;
        grid[row][col] = bit ? Module.Dark : Module.Light;
      }
    }
    upward = !upward;
  }
}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

const MASKS: ReadonlyArray<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** Apply a mask to every non-function module, in place. */
function applyMask(grid: Grid, mask: number): void {
  const fn = MASKS[mask];
  for (let r = 0; r < grid.length; r += 1) {
    for (let c = 0; c < grid.length; c += 1) {
      if (isFunction(grid[r][c]) || grid[r][c] === Module.Empty) continue;
      if (fn(r, c)) grid[r][c] = grid[r][c] === Module.Dark ? Module.Light : Module.Dark;
    }
  }
}

function writeFormatInfo(grid: Grid, mask: number): void {
  const size = grid.length;
  const bits = formatBits(mask);
  const at = (i: number) => ((bits >> i) & 1 ? Module.FunctionDark : Module.FunctionLight);

  // Copy 1, around the top-left finder. The two gaps at row/col 6 are the timing
  // patterns, which is why the indices jump.
  for (let i = 0; i <= 5; i += 1) grid[8][i] = at(i);
  grid[8][7] = at(6);
  grid[8][8] = at(7);
  grid[7][8] = at(8);
  for (let i = 9; i <= 14; i += 1) grid[14 - i][8] = at(i);

  /*
   * Copy 2, split between the other two finders so the format survives damage to
   * any one corner: bits 0-6 run UP column 8 from the bottom, bits 7-14 run right
   * along row 8 to the edge.
   *
   * The 7/8 split is load-bearing and easy to get wrong as 8/7. Column 8's run
   * stops at row `size - 7`, because `(size - 8, 8)` is the DARK MODULE, which is
   * not part of the format information and must stay dark. Writing eight bits
   * down this column both misplaces every bit of copy 2 and overwrites that
   * module, and neither fault is visible to a reader that happens to use copy 1
   * (the top-left one) -- which is what most do, which is why this survived a
   * full round-trip test before the geometry assertions caught it.
   */
  for (let i = 0; i <= 6; i += 1) grid[size - 1 - i][8] = at(i);
  for (let i = 7; i <= 14; i += 1) grid[8][size - 15 + i] = at(i);
}

/**
 * The specification's four penalty rules. Lower is better; the encoder tries all
 * eight masks and keeps the best.
 */
function penalty(grid: Grid): number {
  const size = grid.length;
  let score = 0;

  // Rule 1: runs of five or more same-coloured modules in a row or column.
  for (let i = 0; i < size; i += 1) {
    for (const readRow of [true, false]) {
      let run = 1;
      for (let j = 1; j < size; j += 1) {
        const prev = readRow ? grid[i][j - 1] : grid[j - 1][i];
        const cur = readRow ? grid[i][j] : grid[j][i];
        if (isDark(cur) === isDark(prev)) {
          run += 1;
        } else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      if (run >= 5) score += run - 2;
    }
  }

  // Rule 2: every 2x2 block of one colour.
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const a = isDark(grid[r][c]);
      if (a === isDark(grid[r][c + 1]) && a === isDark(grid[r + 1][c]) && a === isDark(grid[r + 1][c + 1])) {
        score += 3;
      }
    }
  }

  // Rule 3: the finder-like 1:1:3:1:1 pattern with four light modules on either
  // side, which a reader could mistake for a finder pattern.
  const P1 = [true, false, true, true, true, false, true, false, false, false, false];
  const P2 = [false, false, false, false, true, false, true, true, true, false, true];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c + 11 <= size; c += 1) {
      let m1 = true;
      let m2 = true;
      let v1 = true;
      let v2 = true;
      for (let k = 0; k < 11; k += 1) {
        const h = isDark(grid[r][c + k]);
        const v = isDark(grid[c + k][r]);
        if (h !== P1[k]) m1 = false;
        if (h !== P2[k]) m2 = false;
        if (v !== P1[k]) v1 = false;
        if (v !== P2[k]) v2 = false;
      }
      if (m1) score += 40;
      if (m2) score += 40;
      if (v1) score += 40;
      if (v2) score += 40;
    }
  }

  // Rule 4: deviation of the dark-module proportion from 50%.
  let dark = 0;
  for (const row of grid) for (const m of row) if (isDark(m)) dark += 1;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface QrCode {
  /** Module count per side, i.e. `version * 4 + 17`. */
  size: number;
  /** 1-40. */
  version: number;
  /** The chosen mask pattern, 0-7. Reported for testability. */
  mask: number;
  /** One string per row, '1' = dark, '0' = light. Rows are top to bottom. */
  rows: string[];
}

/**
 * The largest payload this encoder will accept, in UTF-8 bytes.
 *
 * Version 40 at level M. A scoped Setup URI is well under a kilobyte, so this
 * ceiling exists to fail loudly rather than to be approached: a caller that hits
 * it is passing something that was never going to be scannable anyway (a
 * version-40 symbol is 177 modules per side and needs a very good camera).
 */
export const QR_MAX_BYTES = 2334 - 3;

export class QrTooLargeError extends Error {
  constructor(byteLength: number) {
    super(`content is ${byteLength} bytes, which exceeds the ${QR_MAX_BYTES}-byte QR capacity`);
    this.name = 'QrTooLargeError';
  }
}

/**
 * Encode `text` as a QR code at error-correction level M.
 *
 * The mask is chosen by trying all eight and keeping the lowest penalty score,
 * which is what the specification requires and what makes the result readable by
 * cameras at an angle.
 */
export function encodeQr(text: string): QrCode {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  if (version === null) throw new QrTooLargeError(bytes.length);

  const codewords = interleave(encodeData(bytes, version), version);

  let best: { grid: Grid; mask: number; score: number } | null = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const grid = buildFunctionPatterns(version);
    placeData(grid, codewords);
    applyMask(grid, mask);
    writeFormatInfo(grid, mask);
    const score = penalty(grid);
    if (!best || score < best.score) best = { grid, mask, score };
  }
  // `best` cannot be null: the loop runs eight times and assigns on the first.
  const chosen = best as { grid: Grid; mask: number; score: number };

  return {
    size: chosen.grid.length,
    version,
    mask: chosen.mask,
    rows: chosen.grid.map((row) => row.map((m) => (isDark(m) ? '1' : '0')).join('')),
  };
}
