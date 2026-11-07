// Tests for the R11 runner guards: the per-file coverage ratchet
// (`scripts/coverage-ratchet.mjs`, QA-08 / D-QA-2) and the stale-build guard
// (`scripts/build-fresh.mjs`, QA-04).
//
// Same import convention as `src/fitness.test.ts`: the scripts live outside
// `rootDir`, so they are loaded the way Node loads them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This file compiles to `build/coverage-ratchet.test.js`, so the root is one level up. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

type Triple = readonly [number, number, number];

interface Baseline {
  readonly tolerance: number;
  readonly newFileFloor: {
    readonly lines: number;
    readonly branches: number;
    readonly functions: number;
  };
  readonly files: Readonly<Record<string, Triple>>;
}

type Measured = Readonly<
  Record<string, { readonly uncovered: Triple; readonly pct: Triple }>
>;

interface Change {
  readonly file: string;
  readonly metric: string;
  readonly from: number;
  readonly to: number;
}

interface Comparison {
  readonly dropped: readonly Change[];
  readonly raised: readonly Change[];
  readonly added: readonly { readonly file: string; readonly under: readonly string[] }[];
  readonly stale: readonly string[];
}

interface RatchetModule {
  readonly BASELINE_PATH: string;
  perFile(summary: unknown, root: string): Measured;
  compare(measured: Measured, baseline: Baseline): Comparison;
  hasViolations(result: Comparison): boolean;
  describe(result: Comparison): string[];
  ratchet(
    measured: Measured,
    baseline: Baseline,
    options?: { allowDecrease?: boolean },
  ): { readonly refused?: readonly string[]; readonly baseline?: Baseline };
  formatBaseline(baseline: Baseline): string;
}

interface FreshModule {
  staleReason(root: string): string | undefined;
}

const ratchetModule = (await import(
  pathToFileURL(join(REPO_ROOT, 'scripts', 'coverage-ratchet.mjs')).href
)) as RatchetModule;
const fresh = (await import(
  pathToFileURL(join(REPO_ROOT, 'scripts', 'build-fresh.mjs')).href
)) as FreshModule;

const BASE: Baseline = {
  tolerance: 1,
  newFileFloor: { lines: 95, branches: 85, functions: 95 },
  files: { 'src/a.ts': [2, 4, 0], 'src/b.ts': [0, 0, 0] },
};

function measured(
  entries: Record<string, Triple>,
  pct: Triple = [100, 100, 100],
): Measured {
  return Object.fromEntries(
    Object.entries(entries).map(([f, u]) => [f, { uncovered: u, pct }]),
  );
}

test('ratchet: perFile turns a c8 json-summary into repo-relative uncovered counts', () => {
  const metric = (total: number, covered: number) => ({
    total,
    covered,
    pct: (covered / total) * 100,
  });
  const summary = {
    total: { lines: metric(1, 1), branches: metric(1, 1), functions: metric(1, 1) },
    [join(REPO_ROOT, 'src', 'core', 'x.ts')]: {
      lines: metric(10, 8),
      branches: metric(4, 3),
      functions: metric(2, 2),
    },
  };
  assert.deepEqual(ratchetModule.perFile(summary, REPO_ROOT), {
    'src/core/x.ts': { uncovered: [2, 1, 0], pct: [80, 75, 100] },
  });
});

test('ratchet: a measurement within the tolerance of the baseline is clean', () => {
  const result = ratchetModule.compare(
    measured({ 'src/a.ts': [3, 3, 1], 'src/b.ts': [0, 0, 0] }),
    BASE,
  );
  assert.equal(ratchetModule.hasViolations(result), false);
  assert.deepEqual(ratchetModule.describe(result), []);
});

test('ratchet: a drop beyond the tolerance fails and names the file and metric', () => {
  const result = ratchetModule.compare(
    measured({ 'src/a.ts': [2, 6, 0], 'src/b.ts': [0, 0, 0] }),
    BASE,
  );
  assert.deepEqual(result.dropped, [
    { file: 'src/a.ts', metric: 'branches', from: 4, to: 6 },
  ]);
  assert.equal(ratchetModule.hasViolations(result), true);
  assert.match(
    ratchetModule.describe(result).join('\n'),
    /dropped {2}src\/a\.ts uncovered branches 4 -> 6/,
  );
});

test('ratchet: an unrecorded gain, a new file and a stale entry are all violations', () => {
  const result = ratchetModule.compare(
    measured({ 'src/a.ts': [0, 4, 0], 'src/c.ts': [0, 0, 0] }),
    BASE,
  );
  assert.deepEqual(result.raised, [
    { file: 'src/a.ts', metric: 'lines', from: 2, to: 0 },
  ]);
  assert.deepEqual(result.added, [{ file: 'src/c.ts', uncovered: [0, 0, 0], under: [] }]);
  assert.deepEqual(result.stale, ['src/b.ts']);
  assert.equal(ratchetModule.describe(result).length, 3);
});

test('ratchet: a new file under the floor is reported per metric', () => {
  const result = ratchetModule.compare(
    {
      ...measured({ 'src/a.ts': [2, 4, 0], 'src/b.ts': [0, 0, 0] }),
      'src/c.ts': { uncovered: [5, 1, 0], pct: [90, 90, 100] },
    },
    BASE,
  );
  assert.deepEqual(result.added[0]?.under, ['lines']);
  assert.match(
    ratchetModule.describe(result).join('\n'),
    /under the new-file floor on lines/,
  );
});

test('ratchet: --write records gains, new files and removals but refuses a drop', () => {
  const gain = ratchetModule.ratchet(
    measured({ 'src/c.ts': [0, 0, 0], 'src/a.ts': [0, 1, 0] }),
    BASE,
  );
  assert.equal(gain.refused, undefined);
  assert.deepEqual(gain.baseline?.files, {
    'src/a.ts': [0, 1, 0],
    'src/c.ts': [0, 0, 0],
  });
  assert.equal(gain.baseline?.tolerance, 1);

  const drop = measured({ 'src/a.ts': [9, 4, 0], 'src/b.ts': [0, 0, 0] });
  assert.deepEqual(ratchetModule.ratchet(drop, BASE).refused, ['dropped src/a.ts lines']);
  assert.deepEqual(
    ratchetModule.ratchet(drop, BASE, { allowDecrease: true }).baseline?.files[
      'src/a.ts'
    ],
    [9, 4, 0],
  );
});

test('ratchet: the checked-in baseline is in the format --write produces', () => {
  const text = readFileSync(ratchetModule.BASELINE_PATH, 'utf8');
  const baseline = JSON.parse(text) as Baseline;
  assert.equal(ratchetModule.formatBaseline(baseline), text);
  assert.equal(baseline.tolerance, 1);
  assert.ok(Object.keys(baseline.files).length > 0);
  assert.deepEqual(Object.keys(baseline.files), Object.keys(baseline.files).sort());
});

test('build-fresh: a missing build, a stale build and a fresh build', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'build-fresh-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'tsconfig.json'), '{}');
  writeFileSync(join(root, 'src', 'a.ts'), '');
  assert.match(fresh.staleReason(root) ?? '', /no build output/);

  mkdirSync(join(root, 'build', 'nested'), { recursive: true });
  const built = join(root, 'build', 'nested', 'a.js');
  writeFileSync(built, '');
  const past = new Date(Date.now() - 60_000);
  const now = new Date();
  utimesSync(join(root, 'tsconfig.json'), past, past);
  utimesSync(join(root, 'src', 'a.ts'), past, past);
  utimesSync(built, now, now);
  assert.equal(fresh.staleReason(root), undefined);

  const later = new Date(Date.now() + 60_000);
  utimesSync(join(root, 'src', 'a.ts'), later, later);
  assert.match(fresh.staleReason(root) ?? '', /build\/ is older than src[\\/]a\.ts/);
});
