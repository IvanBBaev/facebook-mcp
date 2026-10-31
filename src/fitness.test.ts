// Structural fitness functions (R14; review findings ARC-01, ARC-02, ARC-04,
// decision D-ARC-7).
//
// `scripts/fitness.mjs` measures the TypeScript sources and this file pins the
// measurement to the checked-in baselines:
//
//   1. lane graph: every cross-lane import is listed in
//      `docs/analysis/v3/lane-graph.json`; new edges fail, gone edges must be
//      removed;
//   2. orphan modules: every production module is reachable from an entry,
//      except the allowlisted expand-only modules;
//   3. file-size soft gate: production <= 1,200 lines, test <= 2,500; the
//      allowlist of files already over the limit only shrinks;
//   4. tool-name literals in non-test `src/core` / `src/api`: the per-file counts
//      only go down, and every literal names a tool in `manifest.json`.
//
// Same import convention as `src/schema-budget.test.ts`: the script lives
// outside `rootDir`, so it is loaded the way Node loads it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This file compiles to `build/fitness.test.js`, so the root is one level up. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'fitness.mjs');

type Lanes = Readonly<Record<string, string>>;

interface LaneGraph {
  readonly entries: Readonly<Record<string, string>>;
  readonly lanes: Lanes;
  readonly edges: Readonly<Record<string, string>>;
}

interface Budget {
  readonly orphans: Readonly<Record<string, string>>;
  readonly fileSize: {
    readonly limits: { readonly production: number; readonly test: number };
    readonly slack: number;
    readonly allowlist: Readonly<Record<string, number>>;
  };
  readonly toolNameLiterals: Readonly<Record<string, number>>;
}

interface Measurement {
  readonly files: number;
  readonly edges: Readonly<Record<string, string>>;
  readonly orphans: readonly string[];
  readonly oversized: Readonly<Record<string, number>>;
  readonly literals: Readonly<Record<string, number>>;
  readonly unknownToolNames: readonly string[];
}

interface FileLines {
  readonly file: string;
  readonly lines: number;
  readonly ceiling?: number;
}

interface FileCount {
  readonly file: string;
  readonly count: number;
  readonly ceiling: number;
}

interface Check {
  readonly newEdges: readonly string[];
  readonly goneEdges: readonly string[];
  readonly newOrphans: readonly string[];
  readonly staleOrphans: readonly string[];
  readonly grownFiles: readonly FileLines[];
  readonly newOversized: readonly FileLines[];
  readonly tightenFiles: readonly FileLines[];
  readonly staleFiles: readonly string[];
  readonly newLiterals: readonly FileCount[];
  readonly fewerLiterals: readonly FileCount[];
  readonly unknownToolNames: readonly string[];
}

interface FitnessModule {
  readonly LANE_GRAPH_PATH: string;
  readonly BUDGET_PATH: string;
  readSources(root?: string): Map<string, string>;
  importGraph(sources: Map<string, string>): Map<string, string[]>;
  laneOf(file: string, lanes: Lanes): string | undefined;
  findOrphans(graph: Map<string, string[]>, entries: readonly string[]): string[];
  countLines(text: string): number;
  readLaneGraph(path?: string): LaneGraph;
  readBudget(path?: string): Budget;
  measure(input?: {
    sources?: Map<string, string>;
    laneGraph?: LaneGraph;
    budget?: Budget;
    toolNames?: Set<string>;
  }): Measurement;
  checkFitness(measured: Measurement, laneGraph: LaneGraph, budget: Budget): Check;
  describeViolations(check: Check): string[];
  ratchet(
    measured: Measurement,
    laneGraph: LaneGraph,
    budget: Budget,
    options?: { allowGrowth?: boolean },
  ): { laneGraph: LaneGraph; budget: Budget };
  formatJson(value: unknown): string;
}

const fitness = (await import(pathToFileURL(SCRIPT).href)) as FitnessModule;

const laneGraph = fitness.readLaneGraph();
const budget = fitness.readBudget();
const sources = fitness.readSources();

/** The eight lanes of doc 05 §3. */
const DOC_05_LANES = [
  'core',
  'reader',
  'posts',
  'insights',
  'moderation',
  'messages',
  'ads',
  'page-admin',
];

// ---------------------------------------------------------------------------
// The live tree against the committed baselines
// ---------------------------------------------------------------------------

test('the source tree meets every fitness function', (t) => {
  const measured = fitness.measure({ sources, laneGraph, budget });
  t.diagnostic(
    `${Object.keys(measured.edges).length} cross-lane edges, ${measured.orphans.length} allowlisted orphans, ` +
      `${Object.keys(measured.oversized).length} files over the size limit, ` +
      `${Object.values(measured.literals).reduce((a, b) => a + b, 0)} tool-name literals`,
  );
  assert.deepEqual(
    fitness.describeViolations(fitness.checkFitness(measured, laneGraph, budget)),
    [],
  );
});

test('the baseline files are in canonical form', () => {
  // `--write` emits this exact shape; a hand edit that drifts from it would make
  // the next `--write` produce an unrelated diff.
  assert.equal(
    readFileSync(fitness.LANE_GRAPH_PATH, 'utf8'),
    fitness.formatJson(laneGraph),
  );
  assert.equal(readFileSync(fitness.BUDGET_PATH, 'utf8'), fitness.formatJson(budget));
});

test('the lane map covers the doc 05 lanes and every pattern matches a file', () => {
  assert.deepEqual(
    [...new Set(Object.values(laneGraph.lanes))].sort(),
    [...DOC_05_LANES].sort(),
  );
  const files = [...sources.keys()];
  for (const pattern of Object.keys(laneGraph.lanes)) {
    const lane = laneGraph.lanes[pattern] ?? '';
    assert.ok(
      files.some((f) => fitness.laneOf(f, { [pattern]: lane }) === lane),
      `lane pattern ${pattern} matches no file`,
    );
  }
  for (const entry of Object.keys(laneGraph.entries)) {
    assert.ok(sources.has(entry), `entry ${entry} does not exist`);
  }
});

test('every allowlisted orphan says when it gets an importer', () => {
  for (const [file, reason] of Object.entries(budget.orphans)) {
    assert.match(
      reason,
      /wave \d/,
      `${file}: name the wave by which it gets an importer`,
    );
  }
});

test('the file-size limits are the D-ARC-7 values', () => {
  assert.deepEqual(budget.fileSize.limits, { production: 1200, test: 2500 });
});

// ---------------------------------------------------------------------------
// The rules, on a synthetic tree
// ---------------------------------------------------------------------------

const LANES: Lanes = {
  'src/tools/a.ts': 'alpha',
  'src/api/a-*.ts': 'alpha',
  'src/tools/b/*': 'beta',
};

const GRAPH: LaneGraph = {
  entries: { 'src/index.ts': 'entry' },
  lanes: LANES,
  edges: {},
};

const BUDGET: Budget = {
  orphans: {},
  fileSize: { limits: { production: 5, test: 8 }, slack: 1, allowlist: {} },
  toolNameLiterals: {},
};

const TOOLS = new Set(['facebook_known']);

function tree(files: Readonly<Record<string, string>>): Map<string, string> {
  return new Map(Object.entries(files));
}

const BASE = {
  'src/index.ts': "import './tools/a.js';\nimport './tools/b/index.js';\n",
  'src/tools/a.ts': "import { x } from '../api/a-read.js';\nexport const a = x;\n",
  'src/api/a-read.ts': 'export const x = 1;\n',
  'src/tools/b/index.ts': "import { s } from '../shared.js';\nexport const b = s;\n",
  'src/tools/shared.ts': 'export const s = 2;\n',
};

function run(files: Readonly<Record<string, string>>, graph = GRAPH, budget = BUDGET) {
  const measured = fitness.measure({
    sources: tree(files),
    laneGraph: graph,
    budget,
    toolNames: TOOLS,
  });
  return { measured, check: fitness.checkFitness(measured, graph, budget) };
}

test('laneOf: `*` stays inside one path segment, unmatched files are shared', () => {
  assert.equal(fitness.laneOf('src/api/a-read.ts', LANES), 'alpha');
  assert.equal(fitness.laneOf('src/tools/b/deep.ts', LANES), 'beta');
  assert.equal(fitness.laneOf('src/tools/b/x/deep.ts', LANES), undefined);
  assert.equal(fitness.laneOf('src/tools/shared.ts', LANES), undefined);
});

test('importGraph: resolves .js specifiers, directories, re-exports and dynamic imports', () => {
  const graph = fitness.importGraph(
    tree({
      'src/a.ts':
        "import type { T } from './t.js';\nexport * from './d';\nconst m = await import('./lazy.js');\nimport 'node:fs';\n",
      'src/t.ts': '',
      'src/d/index.ts': '',
      'src/lazy.ts': '',
    }),
  );
  assert.deepEqual(graph.get('src/a.ts'), ['src/d/index.ts', 'src/lazy.ts', 'src/t.ts']);
});

test('lane graph: a cross-lane import is a new edge; shared modules are not lanes', () => {
  const clean = run(BASE);
  assert.deepEqual(clean.measured.edges, {});
  assert.deepEqual(fitness.describeViolations(clean.check), []);

  const crossed = run({
    ...BASE,
    'src/tools/b/index.ts': "import '../../api/a-read.js';\n",
  });
  assert.deepEqual(crossed.measured.edges, {
    'src/tools/b/index.ts -> src/api/a-read.ts': 'beta -> alpha',
  });
  assert.deepEqual(crossed.check.newEdges, ['src/tools/b/index.ts -> src/api/a-read.ts']);
  assert.match(
    fitness.describeViolations(crossed.check)[0] ?? '',
    /new cross-lane import .*--allow-growth/,
  );
});

test('lane graph: an allowlisted edge that is gone must be removed', () => {
  const graph = {
    ...GRAPH,
    edges: { 'src/tools/a.ts -> src/tools/b/index.ts': 'alpha -> beta' },
  };
  const { check } = run(BASE, graph);
  assert.deepEqual(check.goneEdges, ['src/tools/a.ts -> src/tools/b/index.ts']);
  assert.match(fitness.describeViolations(check)[0] ?? '', /no longer exists.*--write/);
});

test('lane graph: test files may cross lanes', () => {
  const { measured } = run({
    ...BASE,
    'src/tools/a.test.ts': "import './b/index.js';\n",
  });
  assert.deepEqual(measured.edges, {});
});

test('orphans: an unreachable production module fails, test code does not', () => {
  const { check } = run({
    ...BASE,
    'src/api/a-unused.ts': 'export const u = 0;\n',
    'src/api/a-read.test.ts': "import './a-read.js';\n",
    'src/testing/helper.ts': '',
  });
  assert.deepEqual(check.newOrphans, ['src/api/a-unused.ts']);
});

test('orphans: an allowlisted orphan that became reachable is stale', () => {
  const budget = { ...BUDGET, orphans: { 'src/api/a-read.ts': 'wave 2' } };
  const { check } = run(BASE, GRAPH, budget);
  assert.deepEqual(check.staleOrphans, ['src/api/a-read.ts']);
});

test('countLines: a trailing newline adds no line', () => {
  assert.equal(fitness.countLines(''), 0);
  assert.equal(fitness.countLines('a'), 1);
  assert.equal(fitness.countLines('a\nb\n'), 2);
  assert.equal(fitness.countLines('a\nb'), 2);
});

test('file size: production and test files have separate limits', () => {
  const six = 'x\n'.repeat(6);
  const { check } = run({
    ...BASE,
    'src/tools/shared.ts': six,
    'src/tools/a.test.ts': six,
  });
  assert.deepEqual(check.newOversized, [{ file: 'src/tools/shared.ts', lines: 6 }]);
});

test('file size: allowlisted files may not grow, must lock in shrinks past slack, and expire', () => {
  const budget = (allowlist: Record<string, number>): Budget => ({
    ...BUDGET,
    fileSize: { ...BUDGET.fileSize, allowlist },
  });
  const files = { ...BASE, 'src/tools/shared.ts': 'x\n'.repeat(8) };

  assert.deepEqual(
    run(files, GRAPH, budget({ 'src/tools/shared.ts': 7 })).check.grownFiles,
    [{ file: 'src/tools/shared.ts', lines: 8, ceiling: 7 }],
  );
  assert.deepEqual(
    fitness.describeViolations(
      run(files, GRAPH, budget({ 'src/tools/shared.ts': 9 })).check,
    ),
    [],
  );
  assert.deepEqual(
    run(files, GRAPH, budget({ 'src/tools/shared.ts': 10 })).check.tightenFiles,
    [{ file: 'src/tools/shared.ts', lines: 8, ceiling: 10 }],
  );
  assert.deepEqual(
    run(BASE, GRAPH, budget({ 'src/tools/shared.ts': 10 })).check.staleFiles,
    ['src/tools/shared.ts'],
  );
});

test('tool-name literals: counted in core/api production code only, comments ignored', () => {
  const { measured } = run({
    ...BASE,
    'src/api/a-read.ts':
      "// see 'facebook_known'\nexport const x = 'facebook_known';\nexport const y = `facebook_known`;\nexport const z = 'call facebook_known next';\n",
    'src/api/a-read.test.ts': "const t = 'facebook_known';\n",
    'src/tools/a.ts': "export const a = 'facebook_known';\n",
  });
  assert.deepEqual(measured.literals, { 'src/api/a-read.ts': 2 });
});

test('tool-name literals: counts only go down, and the module C10 adds is exempt', () => {
  const budget = { ...BUDGET, toolNameLiterals: { 'src/api/a-read.ts': 1 } };
  const two = {
    ...BASE,
    'src/api/a-read.ts': "const a = 'facebook_known', b = 'facebook_known';\n",
  };
  assert.deepEqual(run(two, GRAPH, budget).check.newLiterals, [
    { file: 'src/api/a-read.ts', count: 2, ceiling: 1 },
  ]);
  assert.deepEqual(run(BASE, GRAPH, budget).check.fewerLiterals, [
    { file: 'src/api/a-read.ts', count: 0, ceiling: 1 },
  ]);
  const exempt = run({
    ...BASE,
    'src/core/tool-names.ts': "export const N = 'facebook_known';\n",
  });
  assert.deepEqual(exempt.measured.literals, {});
});

test('tool-name literals: a name missing from manifest.json is a violation', () => {
  const { check } = run({
    ...BASE,
    'src/core/x.ts': "export const n = 'facebook_gone';\n",
  });
  assert.deepEqual(check.unknownToolNames, ['src/core/x.ts: facebook_gone']);
  assert.match(
    fitness.describeViolations(check).at(-1) ?? '',
    /not a tool in manifest\.json/,
  );
});

test('ratchet: takes gains, refuses growth unless allowGrowth, never records unknown names', () => {
  const graph = {
    ...GRAPH,
    edges: { 'src/tools/a.ts -> src/tools/b/index.ts': 'alpha -> beta' },
  };
  const gone = run(BASE, graph);
  assert.deepEqual(fitness.ratchet(gone.measured, graph, BUDGET).laneGraph.edges, {});

  const grown = run({ ...BASE, 'src/api/a-unused.ts': '' });
  assert.throws(
    () => fitness.ratchet(grown.measured, GRAPH, BUDGET),
    /refusing to record growth without --allow-growth: src\/api\/a-unused\.ts/,
  );
  const next = fitness.ratchet(grown.measured, GRAPH, BUDGET, { allowGrowth: true });
  assert.deepEqual(Object.keys(next.budget.orphans), ['src/api/a-unused.ts']);

  const unknown = run({
    ...BASE,
    'src/core/x.ts': "export const n = 'facebook_gone';\n",
  });
  assert.throws(
    () => fitness.ratchet(unknown.measured, GRAPH, BUDGET, { allowGrowth: true }),
    /refusing to record unknown tool names/,
  );
});
