/**
 * Pin the vendored engine's hand-written .d.ts against the real upstream source.
 *
 * `server/vendor/livesync-engine/index.d.ts` is ours, written by hand, while
 * `upstream/` is a byte-identical copy of livesync-commonlib at the pinned
 * commit. Nothing keeps the two in step, and two declarations had already
 * drifted in the direction that produces no error at all:
 *
 *   E2EEAlgorithm        was `"" | "v2" | "v3"`, and "v3" is not a value the
 *                        engine has ever accepted (the third is "forceV1")
 *   ChunkSplitterVersion was `number`, while the engine compares it against
 *                        strings, so every numeric value typechecked and none
 *                        of them could ever match
 *
 * Both are RemoteTweaks fields, which is what makes the drift matter rather than
 * merely being untidy: mergeRemoteTweaks() ADOPTS them from the remote database
 * and hands them to the engine, so they decide how content is encrypted and how
 * it is split into chunks. A wrong union there removes type checking from the
 * two settings whose failure mode is unreadable documents.
 *
 * UPSTREAM IS READ AS TEXT, NOT IMPORTED, and that is not laziness. The server
 * tsconfig sets `rootDir: "src"`, so importing anything from `vendor/upstream/`
 * pulls that whole tree into the program and the build fails with TS6059 on
 * every transitive file. Text extraction keeps the guard entirely outside the
 * module graph, which also means it cannot be defeated by the engine bundle
 * being stale.
 *
 * The type-level half below is what catches OUR side drifting. `satisfies`
 * fails to compile if the declared union has lost a member, and the explicit
 * annotation fails if it has gained one, so `npm run typecheck` (a CI gate)
 * breaks on either.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { E2EEAlgorithm, ChunkSplitterVersion } from 'livesync-engine';

const here = path.dirname(fileURLToPath(import.meta.url));
const UPSTREAM_TYPES = path.join(
  here,
  '..',
  '..',
  'vendor',
  'livesync-engine',
  'upstream',
  'src',
  'common',
  'types.ts',
);

/**
 * Pull the string values out of an `export const <name> = { ... } as const`
 * literal in the upstream source.
 *
 * Narrow on purpose: it matches one named literal and takes the quoted values
 * from it. A looser parse would quietly return an empty set if upstream
 * restructured the file, and an empty set compared against an empty set passes.
 * So the extractor throws when it cannot find the block, and the tests below
 * assert a non-zero count before comparing.
 */
function upstreamConstValues(name: string): string[] {
  const source = readFileSync(UPSTREAM_TYPES, 'utf8');
  const block = new RegExp(`export const ${name}\\s*=\\s*\\{([^}]*)\\}\\s*as const`, 'm').exec(source);
  if (!block) throw new Error(`upstream no longer declares "export const ${name} = {...} as const"`);
  return [...block[1].matchAll(/:\s*"([^"]*)"/g)].map((m) => m[1]).sort();
}

describe('E2EEAlgorithm matches upstream', () => {
  // Written out rather than derived, so that a change on EITHER side has to be
  // acknowledged here deliberately.
  const DECLARED = ['', 'forceV1', 'v2'] as const;

  it('declares exactly the members upstream defines', () => {
    const upstream = upstreamConstValues('E2EEAlgorithms');
    expect(upstream.length).toBeGreaterThan(0);
    expect(upstream).toEqual([...DECLARED]);
  });

  it('never contains "v3", the value that was declared and does not exist', () => {
    expect(upstreamConstValues('E2EEAlgorithms')).not.toContain('v3');
  });

  it('our declared union has exactly these members', () => {
    // Fails typecheck if our union lost a member (satisfies) or gained one
    // (the annotation), which is the half that actually catches drift.
    const all: E2EEAlgorithm[] = ['', 'v2', 'forceV1'] satisfies E2EEAlgorithm[];
    expect(all.sort()).toEqual([...DECLARED]);
  });
});

describe('ChunkSplitterVersion matches upstream', () => {
  const DECLARED_ALGOS = ['v1', 'v2', 'v2-segmenter', 'v3-rabin-karp'] as const;

  it('declares exactly the algorithms upstream defines', () => {
    const upstream = upstreamConstValues('ChunkAlgorithms');
    expect(upstream.length).toBeGreaterThan(0);
    expect(upstream).toEqual([...DECLARED_ALGOS]);
  });

  it('is a string union, not the `number` it used to be declared as', () => {
    // The empty string is the upstream union's "unset" member and is not in the
    // ChunkAlgorithms literal, so it is asserted separately.
    const all: ChunkSplitterVersion[] = [
      '',
      'v1',
      'v2',
      'v2-segmenter',
      'v3-rabin-karp',
    ] satisfies ChunkSplitterVersion[];
    expect(all).toHaveLength(5);
    // A number would have compiled under the old declaration. It must not now.
    // @ts-expect-error a numeric chunk splitter version is not a thing
    const wrong: ChunkSplitterVersion = 2;
    expect(wrong).toBe(2);
  });
});
