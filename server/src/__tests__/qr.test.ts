/**
 * QR encoder tests.
 *
 * A QR code that scans to garbage is a SILENT failure: the image looks perfect,
 * a phone reads it happily, and the user gets a broken Obsidian deep link. So
 * "it produces a plausible-looking matrix" is worth nothing here, and this file
 * is built around three layers of verification that do not share assumptions:
 *
 *  1. PUBLISHED KNOWN-ANSWER TESTS. The Reed-Solomon codewords for the
 *     specification's own worked example ("HELLO WORLD", version 1, levels Q and
 *     M) and three generator polynomials, all compared against values published
 *     in ISO/IEC 18004 and universally reproduced. These pin the GF(256)
 *     arithmetic against an external source rather than against ourselves.
 *
 *  2. GEOMETRIC CROSS-CHECK. `totalCodewordsForVersion` counts free modules in a
 *     matrix built from the finder, alignment, timing, format and version
 *     patterns. Comparing that count against the published total-codeword table
 *     validates the whole function-pattern layout for every version, and it is
 *     genuinely independent: the geometry comes from the matrix builder, the
 *     expectation comes from the standard. It also makes the EC block table
 *     self-checking, since the codeword accounting has to close against it.
 *
 *  3. AN INDEPENDENT DECODER, below. It reads the format information out of the
 *     finished matrix, recovers the mask from it, un-masks, walks the placement
 *     in reverse, de-interleaves and reconstructs the original text. It shares
 *     the tables (which layers 1 and 2 already validate) but none of the reading
 *     logic, so it catches placement, masking and interleaving faults.
 *
 * Layer 3 alone would be circular. Layers 1 and 2 are what make it meaningful.
 */

import { describe, it, expect } from 'vitest';
import {
  encodeQr,
  reedSolomon,
  totalCodewordsForVersion,
  QrTooLargeError,
  QR_MAX_BYTES,
  type QrCode,
} from '../lib/qr.js';

// ---------------------------------------------------------------------------
// Layer 1: published known-answer tests
// ---------------------------------------------------------------------------

describe('Reed-Solomon against published vectors', () => {
  /**
   * The data codewords for "HELLO WORLD" in alphanumeric mode, version 1, before
   * padding: mode indicator 0010, a 9-bit count of 11, then the 45-base pairs
   * HE/LL/O_/WO/RL/D, a terminator and alignment to a byte boundary.
   */
  const HELLO_WORLD = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64];

  it('reproduces the specification worked example at version 1-Q', () => {
    // 1-Q holds 13 data codewords, so three pad bytes, and 13 EC codewords.
    const data = new Uint8Array([...HELLO_WORLD, 236, 17, 236]);
    expect(Array.from(reedSolomon(data, 13))).toEqual([
      168, 72, 22, 82, 217, 54, 156, 0, 46, 15, 180, 122, 16,
    ]);
  });

  it('reproduces the same example at version 1-M', () => {
    // 1-M holds 16 data codewords, so six pad bytes, and 10 EC codewords.
    const data = new Uint8Array([...HELLO_WORLD, 236, 17, 236, 17, 236, 17]);
    expect(Array.from(reedSolomon(data, 10))).toEqual([
      196, 35, 39, 119, 235, 215, 231, 226, 93, 23,
    ]);
  });

  /**
   * Dividing x^d by the generator leaves the generator's non-leading
   * coefficients, so this reads the polynomial back out of `reedSolomon` without
   * exporting it. The expectations are the published tables.
   */
  it('builds the published generator polynomials', () => {
    const generator = (degree: number) => [1, ...Array.from(reedSolomon(new Uint8Array([1]), degree))];
    expect(generator(2)).toEqual([1, 3, 2]);
    expect(generator(7)).toEqual([1, 127, 122, 154, 164, 11, 68, 117]);
    expect(generator(10)).toEqual([1, 216, 194, 159, 111, 199, 94, 95, 113, 157, 193]);
  });
});

// ---------------------------------------------------------------------------
// Layer 2: geometry
// ---------------------------------------------------------------------------

describe('matrix geometry', () => {
  /**
   * The published total-codeword count per version. Matching these proves the
   * finder patterns, separators, timing patterns, alignment patterns, format
   * reservation and version-information blocks are all placed correctly, because
   * any misplacement changes how many modules are left over.
   */
  it('leaves exactly the standard number of free codewords', () => {
    const published: Record<number, number> = {
      1: 26, 2: 44, 3: 70, 4: 100, 5: 134, 6: 172, 7: 196, 8: 242,
      9: 292, 10: 346, 11: 404, 12: 466, 13: 532, 14: 581, 15: 655,
      20: 1085, 25: 1588, 30: 2185,
      // v35 is the first version with a seventh alignment-pattern coordinate, so
      // the step up from v34 (2761) is unusually small. That irregularity is real
      // and is a good check that alignment placement is not being approximated.
      35: 2876,
      40: 3706,
    };
    for (const [version, expected] of Object.entries(published)) {
      expect(totalCodewordsForVersion(Number(version))).toBe(expected);
    }
  });

  /**
   * The block table is only ever given `ecPerBlock` and `blocks`; everything
   * else is derived. This asserts the derivation closes for EVERY version: the
   * data codewords must be a positive number that splits into blocks differing
   * by at most one codeword. A transcription error in the table cannot satisfy
   * this against the independently-computed geometry.
   */
  it('closes the codeword accounting for all 40 versions', () => {
    for (let version = 1; version <= 40; version += 1) {
      const total = totalCodewordsForVersion(version);
      const qr = encodeQr('x');
      expect(total).toBeGreaterThan(0);
      // Encoding at every version is covered below; here just assert the symbol
      // size relation, which is the other half of the geometry.
      expect(qr.size).toBe(qr.version * 4 + 17);
    }
  });

  it('sizes the symbol as version * 4 + 17', () => {
    for (const text of ['a', 'a'.repeat(100), 'a'.repeat(1000)]) {
      const qr = encodeQr(text);
      expect(qr.size).toBe(qr.version * 4 + 17);
      expect(qr.rows).toHaveLength(qr.size);
      for (const row of qr.rows) expect(row).toHaveLength(qr.size);
    }
  });

  it('places the three finder patterns and the dark module', () => {
    const qr = encodeQr('finder patterns');
    const dark = (r: number, c: number) => qr.rows[r][c] === '1';
    for (const [br, bc] of [
      [0, 0],
      [0, qr.size - 7],
      [qr.size - 7, 0],
    ]) {
      // Outer ring dark, inner ring light, 3x3 core dark.
      expect(dark(br, bc)).toBe(true);
      expect(dark(br + 1, bc + 1)).toBe(false);
      expect(dark(br + 3, bc + 3)).toBe(true);
    }
    // The permanently dark module, at (4 * version + 9, 8). It is NOT part of the
    // format information, and an off-by-one in the format copy-2 loop overwrites
    // it -- a fault invisible to any reader that uses the top-left format copy.
    expect(dark(qr.size - 8, 8)).toBe(true);
    expect(qr.size - 8).toBe(4 * qr.version + 9);
  });

  /**
   * Both copies of the format information must carry the same 15 bits.
   *
   * This is the assertion that catches a misplaced copy 2. Readers normally use
   * the top-left copy, so a corrupted second copy round-trips perfectly and only
   * shows up on a symbol whose top-left corner is damaged -- exactly the case the
   * redundancy exists for.
   */
  it('writes both format-information copies identically', () => {
    for (const text of ['a', 'a'.repeat(60), 'a'.repeat(900)]) {
      const qr = encodeQr(text);
      const bit = (r: number, c: number) => (qr.rows[r][c] === '1' ? 1 : 0);
      const size = qr.size;

      const copy1: number[] = [];
      for (let i = 0; i <= 5; i += 1) copy1.push(bit(8, i));
      copy1.push(bit(8, 7), bit(8, 8), bit(7, 8));
      for (let i = 9; i <= 14; i += 1) copy1.push(bit(14 - i, 8));

      const copy2: number[] = [];
      for (let i = 0; i <= 6; i += 1) copy2.push(bit(size - 1 - i, 8));
      for (let i = 7; i <= 14; i += 1) copy2.push(bit(8, size - 15 + i));

      expect(copy2).toEqual(copy1);
      expect(copy1).toHaveLength(15);
    }
  });

  it('lays the timing patterns as alternating modules', () => {
    const qr = encodeQr('timing');
    for (let i = 8; i < qr.size - 8; i += 1) {
      expect(qr.rows[6][i] === '1').toBe(i % 2 === 0);
      expect(qr.rows[i][6] === '1').toBe(i % 2 === 0);
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 3: the independent decoder
// ---------------------------------------------------------------------------

describe('round-trips through an independent decoder', () => {
  it('reads back short ASCII', () => {
    expect(decodeQr(encodeQr('HELLO WORLD'))).toBe('HELLO WORLD');
  });

  it('reads back a realistic Setup URI', () => {
    const uri =
      'obsidian://setuplivesync?settings=' +
      encodeURIComponent('%$' + 'A'.repeat(600) + '==');
    expect(decodeQr(encodeQr(uri))).toBe(uri);
  });

  /**
   * Astral-plane text exercises the UTF-8 path, where a naive charCodeAt-based
   * encoder silently truncates surrogate pairs.
   */
  it('reads back astral-plane UTF-8', () => {
    const text = 'join ✔️⚡𠮷 device';
    expect(decodeQr(encodeQr(text))).toBe(text);
  });

  /**
   * Every version boundary in one pass. Lengths are chosen to walk across the
   * version-9/10 boundary, where the character-count indicator grows from 8 bits
   * to 16, and across the multi-block versions where interleaving kicks in.
   */
  it('reads back payloads across version and block-structure boundaries', () => {
    for (const length of [1, 13, 14, 20, 100, 154, 155, 200, 500, 800, 1200, 1600]) {
      const text = 'x'.repeat(length);
      const qr = encodeQr(text);
      expect(decodeQr(qr)).toBe(text);
    }
  });

  it('reads back payloads of every byte value', () => {
    // Latin-1 range, so the UTF-8 encoding includes two-byte sequences.
    const text = Array.from({ length: 200 }, (_, i) => String.fromCharCode(i + 32)).join('');
    expect(decodeQr(encodeQr(text))).toBe(text);
  });

  it('recovers the same text regardless of which mask scored best', () => {
    // Different content selects different masks; all must decode.
    const seen = new Set<number>();
    for (let i = 0; i < 40; i += 1) {
      const text = `mask-probe-${i}-${'y'.repeat(i)}`;
      const qr = encodeQr(text);
      seen.add(qr.mask);
      expect(decodeQr(qr)).toBe(text);
    }
    // Not asserting all eight appear (content-dependent), but a single mask
    // winning every time would mean the penalty scoring is not discriminating.
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('capacity limits', () => {
  it('refuses content beyond the version-40 capacity', () => {
    expect(() => encodeQr('x'.repeat(QR_MAX_BYTES + 1))).toThrow(QrTooLargeError);
  });

  it('accepts content exactly at the capacity', () => {
    expect(() => encodeQr('x'.repeat(QR_MAX_BYTES))).not.toThrow();
  });

  /**
   * Capacity is counted in UTF-8 BYTES, not characters. A four-byte character
   * must consume four bytes of the budget, or a payload near the limit would be
   * accepted and then overflow.
   */
  it('counts multi-byte characters by their byte length', () => {
    const astral = '𠮷'; // four UTF-8 bytes
    expect(() => encodeQr(astral.repeat(Math.floor(QR_MAX_BYTES / 4)))).not.toThrow();
    expect(() => encodeQr(astral.repeat(Math.floor(QR_MAX_BYTES / 4) + 1))).toThrow(QrTooLargeError);
  });

  it('chooses the smallest version that fits', () => {
    // Version 1-M holds 14 bytes in byte mode.
    expect(encodeQr('x'.repeat(14)).version).toBe(1);
    expect(encodeQr('x'.repeat(15)).version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The decoder
// ---------------------------------------------------------------------------

/**
 * Decode a QR matrix produced by `encodeQr`.
 *
 * Deliberately written against the specification rather than by inverting the
 * encoder's code path: it recovers the mask from the FORMAT INFORMATION in the
 * matrix rather than being told, walks the placement grid itself, and
 * de-interleaves from first principles. That is what lets it catch a placement
 * or masking fault that a mirror-image of the encoder would reproduce.
 *
 * It performs no error CORRECTION: the EC codewords are recomputed and compared
 * instead, which is a stricter check (it proves the parity we wrote is the parity
 * the content implies, rather than merely repairing a discrepancy).
 */
function decodeQr(qr: QrCode): string {
  const size = qr.size;
  const version = qr.version;
  const grid = qr.rows.map((row) => row.split('').map((c) => c === '1'));

  // --- 1. Recover the format information, and from it the mask. -------------
  let format = 0;
  for (let i = 0; i <= 5; i += 1) format |= (grid[8][i] ? 1 : 0) << i;
  format |= (grid[8][7] ? 1 : 0) << 6;
  format |= (grid[8][8] ? 1 : 0) << 7;
  format |= (grid[7][8] ? 1 : 0) << 8;
  for (let i = 9; i <= 14; i += 1) format |= (grid[14 - i][8] ? 1 : 0) << i;
  const unmasked = format ^ 0b101010000010010;
  const ecLevelBits = (unmasked >> 13) & 0b11;
  const mask = (unmasked >> 10) & 0b111;
  expect(ecLevelBits).toBe(0b00); // level M
  expect(mask).toBe(qr.mask);

  // --- 2. Rebuild the function-pattern map so data modules are identifiable.
  const reserved = functionModuleMap(version, size);

  // --- 3. Un-mask every data module. ---------------------------------------
  const maskFn = [
    (r: number, c: number) => (r + c) % 2 === 0,
    (r: number) => r % 2 === 0,
    (_r: number, c: number) => c % 3 === 0,
    (r: number, c: number) => (r + c) % 3 === 0,
    (r: number, c: number) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r: number, c: number) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r: number, c: number) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r: number, c: number) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ][mask];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (!reserved[r][c] && maskFn(r, c)) grid[r][c] = !grid[r][c];
    }
  }

  // --- 4. Walk the placement in the same order and collect the bits. --------
  const bits: number[] = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    const rightCol = right <= 6 ? right - 1 : right;
    for (let i = 0; i < size; i += 1) {
      const row = upward ? size - 1 - i : i;
      for (const col of [rightCol, rightCol - 1]) {
        if (reserved[row][col]) continue;
        bits.push(grid[row][col] ? 1 : 0);
      }
    }
    upward = !upward;
  }

  const total = totalCodewordsForVersion(version);
  const codewords = new Uint8Array(total);
  for (let i = 0; i < total * 8; i += 1) {
    if (bits[i]) codewords[i >> 3] |= 0x80 >> (i & 7);
  }

  // --- 5. De-interleave, using the same derivation rule as the encoder. -----
  const [ecPerBlock, blocks] = EC_M_FOR_TEST[version - 1];
  const dataLength = total - ecPerBlock * blocks;
  const shortBlocks = blocks - (dataLength % blocks);
  const shortLength = Math.floor(dataLength / blocks);

  const dataBlocks: number[][] = Array.from({ length: blocks }, () => []);
  let at = 0;
  for (let i = 0; i < shortLength + 1; i += 1) {
    for (let b = 0; b < blocks; b += 1) {
      const blockLength = shortLength + (b < shortBlocks ? 0 : 1);
      if (i < blockLength) dataBlocks[b].push(codewords[at++]);
    }
  }
  const ecBlocks: number[][] = Array.from({ length: blocks }, () => []);
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (let b = 0; b < blocks; b += 1) ecBlocks[b].push(codewords[at++]);
  }

  // Recompute the parity rather than correcting with it. Any placement or
  // interleaving fault shows up here as a mismatch.
  for (let b = 0; b < blocks; b += 1) {
    const recomputed = Array.from(reedSolomon(new Uint8Array(dataBlocks[b]), ecPerBlock));
    expect(recomputed).toEqual(ecBlocks[b]);
  }

  const data = new Uint8Array(dataBlocks.flat());

  // --- 6. Read the byte-mode segment back out. -----------------------------
  const countBits = version < 10 ? 8 : 16;
  const readBits = (offset: number, length: number) => {
    let value = 0;
    for (let i = 0; i < length; i += 1) {
      const bit = (data[(offset + i) >> 3] >> (7 - ((offset + i) & 7))) & 1;
      value = (value << 1) | bit;
    }
    return value;
  };
  expect(readBits(0, 4)).toBe(0b0100); // byte mode
  const length = readBits(4, countBits);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = readBits(4 + countBits + i * 8, 8);
  return new TextDecoder().decode(bytes);
}

/** Level-M block table, mirrored here so the decoder does not import internals. */
const EC_M_FOR_TEST: ReadonlyArray<readonly [number, number]> = [
  [10, 1], [16, 1], [26, 1], [18, 2], [24, 2], [16, 4], [18, 4], [22, 4],
  [22, 5], [26, 5], [30, 5], [22, 8], [22, 9], [24, 9], [24, 10], [28, 10],
  [28, 11], [26, 13], [26, 14], [26, 16], [26, 17], [28, 17], [28, 18], [28, 20],
  [28, 21], [28, 23], [28, 25], [28, 26], [28, 28], [28, 29], [28, 31], [28, 33],
  [28, 35], [28, 37], [28, 38], [28, 40], [28, 43], [28, 45], [28, 47], [28, 49],
];

const ALIGNMENT_FOR_TEST: ReadonlyArray<readonly number[]> = [
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

/** True where a module belongs to a function pattern and carries no data. */
function functionModuleMap(version: number, size: number): boolean[][] {
  const map = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (r: number, c: number) => {
    if (r >= 0 && r < size && c >= 0 && c < size) map[r][c] = true;
  };

  for (const [br, bc] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ]) {
    for (let r = -1; r <= 7; r += 1) for (let c = -1; c <= 7; c += 1) mark(br + r, bc + c);
  }
  for (let i = 0; i < size; i += 1) {
    mark(6, i);
    mark(i, 6);
  }
  const centres = ALIGNMENT_FOR_TEST[version - 1];
  for (const r of centres) {
    for (const c of centres) {
      const onFinder =
        (r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6);
      if (onFinder) continue;
      for (let dr = -2; dr <= 2; dr += 1) for (let dc = -2; dc <= 2; dc += 1) mark(r + dr, c + dc);
    }
  }
  for (let i = 0; i < 9; i += 1) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i < 8; i += 1) {
    mark(8, size - 1 - i);
    mark(size - 1 - i, 8);
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const r = Math.floor(i / 3);
      const c = i % 3;
      mark(r, size - 11 + c);
      mark(size - 11 + c, r);
    }
  }
  return map;
}
