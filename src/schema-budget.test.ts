// Schema-budget ratchet (R13; review finding AUX-01, decision OD-4).
//
// The `tools/list` payload is paid for in context on every uncached turn. This
// file measures it per profile with `scripts/measure-schema.mjs` and pins it to
// `scripts/schema-budget.json`:
//
//   1. no profile may grow past its recorded ceiling (raising one is a
//      deliberate `--write --allow-growth`, explained in the commit);
//   2. a profile that shrinks by more than `slack` must have its ceiling lowered
//      (`--write`), so a gain cannot be given back silently;
//   3. every named profile has a ceiling and an OD-4 target, and no budget entry
//      outlives its profile;
//   4. the OD-4 targets (default <= 90 KB, `all` <= 110 KB, personas <= 40 KB) are
//      reported as the remaining gap and never fail.
//
// Same import convention as `src/fold-changes.test.ts`: the script lives outside
// `rootDir`, so it is loaded the way Node loads it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PROFILES } from './mcp/index.js';

/** This file compiles to `build/schema-budget.test.js`, so the root is one level up. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'measure-schema.mjs');

interface Measurement {
  readonly profile: string;
  readonly tools: number;
  readonly bytes: number;
  readonly descriptionBytes: number;
  readonly inputSchemaBytes: number;
  readonly outputSchemaBytes: number;
}

interface Budget {
  readonly slack: number;
  readonly targets: Readonly<Record<string, number>>;
  readonly ceilings: Readonly<Record<string, number>>;
}

interface Entry {
  readonly profile: string;
  readonly bytes: number;
  readonly ceiling: number;
}

interface Check {
  readonly grown: readonly Entry[];
  readonly tighten: readonly Entry[];
  readonly unbudgeted: readonly string[];
  readonly stale: readonly string[];
  readonly gaps: readonly {
    profile: string;
    bytes: number;
    target: number;
    over: number;
  }[];
}

interface MeasureModule {
  measureProfiles(buildDir?: string): Promise<Measurement[]>;
  readBudget(path?: string): Budget;
  checkBudget(measured: readonly Measurement[], budget: Budget): Check;
  ratchetBudget(
    measured: readonly Measurement[],
    budget: Budget,
    options?: { allowGrowth?: boolean },
  ): Budget;
  describeViolations(check: Check): string[];
  formatBudget(budget: Budget): string;
}

const measure = (await import(pathToFileURL(SCRIPT).href)) as MeasureModule;

const measured = await measure.measureProfiles();
const budget = measure.readBudget();

const m = (profile: string, bytes: number): Measurement => ({
  profile,
  tools: 1,
  bytes,
  descriptionBytes: 0,
  inputSchemaBytes: 0,
  outputSchemaBytes: 0,
});

const BUDGET: Budget = {
  slack: 100,
  targets: { core: 500, all: 800 },
  ceilings: { core: 1000, all: 2000 },
};

// ---------------------------------------------------------------------------
// The live surface against the committed budget
// ---------------------------------------------------------------------------

test('every named profile is measured, and the default profile is non-empty', () => {
  assert.deepEqual(
    measured.map((x) => x.profile),
    Object.keys(PROFILES),
  );
  const core = measured.find((x) => x.profile === 'core');
  assert.ok(core !== undefined && core.tools > 0 && core.bytes > 0);
  for (const x of measured) {
    assert.ok(
      x.descriptionBytes + x.inputSchemaBytes + x.outputSchemaBytes < x.bytes,
      `${x.profile}: the parts cannot outweigh the whole payload`,
    );
  }
});

test('the tools/list surface stays within its ratcheting ceiling', (t) => {
  const check = measure.checkBudget(measured, budget);
  for (const gap of check.gaps) {
    t.diagnostic(
      `${gap.profile}: ${gap.bytes} B, target ${gap.target} B, ${gap.over} B over target`,
    );
  }
  assert.deepEqual(measure.describeViolations(check), []);
});

test('the budget file is in canonical form', () => {
  // `--write` emits this exact shape; a hand edit that drifts from it would make
  // the next `--write` produce an unrelated diff.
  const raw = readFileSync(join(REPO_ROOT, 'scripts', 'schema-budget.json'), 'utf8');
  assert.equal(raw, measure.formatBudget(budget));
  for (const [profile, target] of Object.entries(budget.targets)) {
    assert.ok(Number.isInteger(target) && target > 0, `${profile}: target must be > 0`);
  }
});

// ---------------------------------------------------------------------------
// The ratchet rules, on synthetic budgets
// ---------------------------------------------------------------------------

test('checkBudget: growth past a ceiling is a violation', () => {
  const check = measure.checkBudget([m('core', 1001), m('all', 2000)], BUDGET);
  assert.deepEqual(check.grown, [{ profile: 'core', bytes: 1001, ceiling: 1000 }]);
  assert.deepEqual(check.tighten, []);
  assert.match(
    measure.describeViolations(check)[0] ?? '',
    /core: 1001 B is over .*--allow-growth/,
  );
});

test('checkBudget: a shrink within slack passes, past slack asks to tighten', () => {
  const within = measure.checkBudget([m('core', 900), m('all', 2000)], BUDGET);
  assert.deepEqual(measure.describeViolations(within), []);

  const past = measure.checkBudget([m('core', 899), m('all', 2000)], BUDGET);
  assert.deepEqual(past.tighten, [{ profile: 'core', bytes: 899, ceiling: 1000 }]);
  assert.match(measure.describeViolations(past)[0] ?? '', /Lock the gain in/);
});

test('checkBudget: unbudgeted and stale profiles are violations', () => {
  const check = measure.checkBudget([m('core', 1000), m('reader', 10)], BUDGET);
  assert.deepEqual(check.unbudgeted, ['reader']);
  assert.deepEqual(check.stale, ['all']);
  assert.equal(measure.describeViolations(check).length, 2);
});

test('checkBudget: targets are reported as a gap, never as a violation', () => {
  const check = measure.checkBudget([m('core', 1000), m('all', 700)], {
    ...BUDGET,
    ceilings: { core: 1000, all: 700 },
  });
  assert.deepEqual(measure.describeViolations(check), []);
  assert.deepEqual(check.gaps, [
    { profile: 'core', bytes: 1000, target: 500, over: 500 },
    { profile: 'all', bytes: 700, target: 800, over: 0 },
  ]);
});

test('ratchetBudget: lowers ceilings freely and keeps slack and targets', () => {
  const next = measure.ratchetBudget([m('core', 950), m('all', 1500)], BUDGET);
  assert.deepEqual(next, { ...BUDGET, ceilings: { core: 950, all: 1500 } });
});

test('ratchetBudget: refuses growth unless allowGrowth is set', () => {
  assert.throws(
    () => measure.ratchetBudget([m('core', 1200), m('all', 1500)], BUDGET),
    /refusing to raise the ceiling of core \(1000 -> 1200 B\)/,
  );
  const next = measure.ratchetBudget([m('core', 1200), m('all', 1500)], BUDGET, {
    allowGrowth: true,
  });
  assert.equal(next.ceilings.core, 1200);
});

test('ratchetBudget: a profile without a target is refused', () => {
  assert.throws(
    () => measure.ratchetBudget([m('core', 900), m('reader', 10)], BUDGET),
    /no target for profile\(s\) reader/,
  );
});
