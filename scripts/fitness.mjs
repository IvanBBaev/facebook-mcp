#!/usr/bin/env node
// fitness.mjs — structural fitness functions for `src/` (R14; review findings
// ARC-01, ARC-02, ARC-04, decision D-ARC-7).
//
// Purpose
//   The lane model in docs/analysis/v3/05-parallel-task-breakdown.md (§1 rule 7,
//   §3) only works if the real import graph matches what the doc says. This
//   script measures four structural properties of `src/` and compares them with
//   checked-in baselines, so a drift fails `src/fitness.test.ts` instead of
//   being found in a review:
//
//   1. Lane graph. Every production file is mapped to a lane by the patterns in
//      `docs/analysis/v3/lane-graph.json` (files that match no pattern are
//      shared, C-owned modules). Every import from one lane into another must be
//      listed in that file's `edges`. A new edge fails; an edge that is gone
//      must be removed (`--write`), so the list stays the true edge list.
//   2. Orphan modules. Every non-test production module must be reachable from
//      an entry (`src/index.ts`) through static or dynamic imports. An
//      expand-only module may be allowlisted with the wave it must have an
//      importer by; an allowlisted module that became reachable is stale.
//   3. File-size soft gate. A production file has at most 1,200 lines and a test
//      file at most 2,500. Files already over the limit are allowlisted at their
//      current length: they may not grow, and a file that shrinks by more than
//      `slack` lines (or drops under the limit) must have its entry lowered or
//      removed. No new entry is ever added without `--allow-growth`.
//   4. Tool-name literals. String literals whose whole value is a
//      `facebook_[a-z_]+` name, in non-test `src/core` and `src/api` files, are
//      counted per file (comments do not count). The counts only go
//      down (C10 moves them into `src/core/tool-names.ts`, which is exempt), and
//      every literal must name a tool in `manifest.json`.
//
// Baselines
//   docs/analysis/v3/lane-graph.json   lanes (pattern -> lane) and edges
//   scripts/fitness-budget.json        orphans, file sizes, tool-name literals
//
// Usage
//   node scripts/fitness.mjs                        report and violations
//   node scripts/fitness.mjs --json                 the measurement as JSON
//   node scripts/fitness.mjs --check                exit 1 on a violation
//   node scripts/fitness.mjs --write                lock in the gains (drop gone
//                                                   edges, lower ceilings, remove
//                                                   stale entries)
//   node scripts/fitness.mjs --write --allow-growth
//                                                   also record new edges, new
//                                                   orphans, grown files and new
//                                                   literals (say why in the commit)
//
// Works on the TypeScript sources; no build, no network. The import scan uses
// `ts.preProcessFile` from the `typescript` dev dependency.
//
// Exit codes: 0 ok, 1 violation or refused write, 2 usage error.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import ts from 'typescript';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The lane map and edge allowlist (named by doc 05 §1 rule 7). */
export const LANE_GRAPH_PATH = join(
  REPO_ROOT,
  'docs',
  'analysis',
  'v3',
  'lane-graph.json',
);
/** Orphan, file-size and tool-name-literal baselines. */
export const BUDGET_PATH = join(REPO_ROOT, 'scripts', 'fitness-budget.json');

const TOOL_NAME_RE = /^facebook_[a-z_]+$/;
/** The module C10 adds; the one place tool-name literals are meant to live. */
const TOOL_NAMES_MODULE = 'src/core/tool-names.ts';
const LITERAL_SCOPES = ['src/core/', 'src/api/'];

// ---------------------------------------------------------------------------
// Source inventory
// ---------------------------------------------------------------------------

/** `src/a/b.test.ts` and friends. */
export function isTestFile(path) {
  return path.endsWith('.test.ts');
}

/**
 * Code that only tests load: helpers, fakes, spawn fixtures and the annotation
 * manifest fragments (all excluded from the npm package by `files`).
 */
export function isTestSupport(path) {
  return (
    path.startsWith('src/testing/') ||
    path.startsWith('src/core/fakes/') ||
    path.startsWith('src/mcp/annotations/') ||
    path.endsWith('.spawn-fixture.ts')
  );
}

/** A production module: shipped, not a test and not test support. */
export function isProduction(path) {
  return !isTestFile(path) && !isTestSupport(path);
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * Read every `.ts` file under `<root>/src`.
 *
 * @param {string} [root]
 * @returns {Map<string, string>} repo-relative POSIX path -> source text
 */
export function readSources(root = REPO_ROOT) {
  const sources = new Map();
  for (const full of walk(join(root, 'src'), []).sort()) {
    sources.set(relative(root, full).split(sep).join('/'), readFileSync(full, 'utf8'));
  }
  return sources;
}

/** Line count the way an editor shows it (a trailing newline adds no line). */
export function countLines(text) {
  if (text === '') return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

// ---------------------------------------------------------------------------
// Import graph
// ---------------------------------------------------------------------------

/**
 * Resolve the relative imports of every source to files in the inventory.
 * Bare specifiers (`node:*`, packages) are not part of the graph.
 *
 * @param {Map<string, string>} sources
 * @returns {Map<string, string[]>} file -> sorted imported files
 */
export function importGraph(sources) {
  const graph = new Map();
  for (const [file, text] of sources) {
    const targets = new Set();
    for (const { fileName } of ts.preProcessFile(text, true, true).importedFiles) {
      if (!fileName.startsWith('.')) continue;
      const joined = posix.normalize(posix.join(posix.dirname(file), fileName));
      const candidates = [
        joined.replace(/\.js$/, '.ts'),
        joined,
        `${joined}.ts`,
        `${joined}/index.ts`,
      ];
      const hit = candidates.find((c) => sources.has(c));
      if (hit !== undefined && hit !== file) targets.add(hit);
    }
    graph.set(file, [...targets].sort());
  }
  return graph;
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

function patternToRegExp(pattern) {
  const body = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${body}$`);
}

/**
 * The lane of a file, or `undefined` for a shared module. Patterns use `*` for
 * any run of characters inside one path segment; the first match wins.
 *
 * @param {Readonly<Record<string, string>>} lanes pattern -> lane
 */
export function laneOf(file, lanes) {
  for (const [pattern, lane] of Object.entries(lanes)) {
    if (patternToRegExp(pattern).test(file)) return lane;
  }
  return undefined;
}

/** Edge key used in `lane-graph.json`: `"<from> -> <to>"`. */
export const edgeKey = (from, to) => `${from} -> ${to}`;

/**
 * Every production import that crosses from one lane into another.
 *
 * @returns {Record<string, string>} edge key -> `"<fromLane> -> <toLane>"`
 */
export function laneEdges(graph, lanes) {
  const edges = {};
  for (const [from, targets] of graph) {
    if (!isProduction(from)) continue;
    const fromLane = laneOf(from, lanes);
    if (fromLane === undefined) continue;
    for (const to of targets) {
      const toLane = laneOf(to, lanes);
      if (toLane === undefined || toLane === fromLane) continue;
      edges[edgeKey(from, to)] = `${fromLane} -> ${toLane}`;
    }
  }
  return sortObject(edges);
}

// ---------------------------------------------------------------------------
// Orphans, sizes, literals
// ---------------------------------------------------------------------------

/** Production modules no entry reaches. */
export function findOrphans(graph, entries) {
  const seen = new Set();
  const queue = entries.filter((e) => graph.has(e));
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...(graph.get(file) ?? []));
  }
  return [...graph.keys()].filter((f) => isProduction(f) && !seen.has(f)).sort();
}

/** Line counts of every file over its limit. */
export function oversizedFiles(sources, limits) {
  const over = {};
  for (const [file, text] of sources) {
    const lines = countLines(text);
    if (lines > (isTestFile(file) ? limits.test : limits.production)) over[file] = lines;
  }
  return sortObject(over);
}

/** Values of the string and no-substitution template literals of a source. */
function stringLiterals(file, text) {
  const values = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      values.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS));
  return values;
}

/** Tool-name literals per non-test `src/core` / `src/api` file. */
export function toolNameLiterals(sources) {
  const found = {};
  for (const [file, text] of sources) {
    if (!isProduction(file) || file === TOOL_NAMES_MODULE) continue;
    if (!LITERAL_SCOPES.some((scope) => file.startsWith(scope))) continue;
    const names = stringLiterals(file, text).filter((v) => TOOL_NAME_RE.test(v));
    if (names.length > 0) found[file] = names;
  }
  return found;
}

/** Tool names declared in `manifest.json`. */
export function manifestToolNames(root = REPO_ROOT) {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  return new Set((manifest.tools ?? []).map((t) => t.name));
}

// ---------------------------------------------------------------------------
// Measure, check, ratchet
// ---------------------------------------------------------------------------

export function readLaneGraph(path = LANE_GRAPH_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readBudget(path = BUDGET_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Measure the tree.
 *
 * @param {{ root?: string, sources?: Map<string, string>, laneGraph?: object,
 *   budget?: object, toolNames?: Set<string> }} [input]
 */
export function measure(input = {}) {
  const root = input.root ?? REPO_ROOT;
  const sources = input.sources ?? readSources(root);
  const laneGraph = input.laneGraph ?? readLaneGraph();
  const budget = input.budget ?? readBudget();
  const graph = importGraph(sources);
  const literals = toolNameLiterals(sources);
  const toolNames = input.toolNames ?? manifestToolNames(root);
  const unknownToolNames = [];
  for (const [file, names] of Object.entries(literals)) {
    for (const name of new Set(names)) {
      if (!toolNames.has(name)) unknownToolNames.push(`${file}: ${name}`);
    }
  }
  return {
    files: sources.size,
    edges: laneEdges(graph, laneGraph.lanes),
    orphans: findOrphans(graph, Object.keys(laneGraph.entries)),
    oversized: oversizedFiles(sources, budget.fileSize.limits),
    literals: sortObject(
      Object.fromEntries(Object.entries(literals).map(([f, n]) => [f, n.length])),
    ),
    unknownToolNames: unknownToolNames.sort(),
  };
}

/**
 * Compare a measurement with the baselines.
 *
 * @returns {{ newEdges: string[], goneEdges: string[], newOrphans: string[],
 *   staleOrphans: string[], grownFiles: object[], newOversized: object[],
 *   tightenFiles: object[], staleFiles: string[], newLiterals: object[],
 *   fewerLiterals: object[], unknownToolNames: string[] }}
 */
export function checkFitness(measured, laneGraph, budget) {
  const allowedEdges = laneGraph.edges ?? {};
  const allowedOrphans = budget.orphans ?? {};
  const sizeAllow = budget.fileSize.allowlist ?? {};
  const slack = budget.fileSize.slack ?? 0;
  const literalAllow = budget.toolNameLiterals ?? {};

  const result = {
    newEdges: Object.keys(measured.edges).filter((k) => !(k in allowedEdges)),
    goneEdges: Object.keys(allowedEdges).filter((k) => !(k in measured.edges)),
    newOrphans: measured.orphans.filter((f) => !(f in allowedOrphans)),
    staleOrphans: Object.keys(allowedOrphans).filter(
      (f) => !measured.orphans.includes(f),
    ),
    grownFiles: [],
    newOversized: [],
    tightenFiles: [],
    staleFiles: Object.keys(sizeAllow).filter((f) => !(f in measured.oversized)),
    newLiterals: [],
    fewerLiterals: [],
    unknownToolNames: measured.unknownToolNames,
  };
  for (const [file, lines] of Object.entries(measured.oversized)) {
    const ceiling = sizeAllow[file];
    if (ceiling === undefined) result.newOversized.push({ file, lines });
    else if (lines > ceiling) result.grownFiles.push({ file, lines, ceiling });
    else if (ceiling - lines > slack) result.tightenFiles.push({ file, lines, ceiling });
  }
  for (const file of new Set([
    ...Object.keys(measured.literals),
    ...Object.keys(literalAllow),
  ])) {
    const count = measured.literals[file] ?? 0;
    const ceiling = literalAllow[file] ?? 0;
    if (count > ceiling) result.newLiterals.push({ file, count, ceiling });
    else if (count < ceiling) result.fewerLiterals.push({ file, count, ceiling });
  }
  result.newLiterals.sort((a, b) => a.file.localeCompare(b.file));
  result.fewerLiterals.sort((a, b) => a.file.localeCompare(b.file));
  return result;
}

/** One human-readable line per violation; empty when the tree is fit. */
export function describeViolations(check) {
  const lock = 'Lock the gain in with `node scripts/fitness.mjs --write`.';
  const grow =
    'If it is intended, record it with `node scripts/fitness.mjs --write --allow-growth` and say why in the commit.';
  return [
    ...check.newEdges.map(
      (e) => `new cross-lane import ${e} (doc 05 §1 rule 7). ${grow}`,
    ),
    ...check.goneEdges.map((e) => `cross-lane import ${e} no longer exists. ${lock}`),
    ...check.newOrphans.map((f) => `${f} is not reachable from any entry. ${grow}`),
    ...check.staleOrphans.map(
      (f) => `${f} is allowlisted as an orphan but is reachable or gone. ${lock}`,
    ),
    ...check.newOversized.map(
      ({ file, lines }) =>
        `${file}: ${lines} lines is over the file-size limit; split it. ${grow}`,
    ),
    ...check.grownFiles.map(
      ({ file, lines, ceiling }) =>
        `${file}: ${lines} lines, grew past its allowlisted ${ceiling}; shrink it. ${grow}`,
    ),
    ...check.tightenFiles.map(
      ({ file, lines, ceiling }) =>
        `${file}: ${lines} lines, allowlisted at ${ceiling}. ${lock}`,
    ),
    ...check.staleFiles.map(
      (f) => `${f} is within the limit or gone; drop its allowlist entry. ${lock}`,
    ),
    ...check.newLiterals.map(
      ({ file, count, ceiling }) =>
        `${file}: ${count} tool-name literal(s), baseline ${ceiling}; use src/core/tool-names.ts (C10). ${grow}`,
    ),
    ...check.fewerLiterals.map(
      ({ file, count, ceiling }) =>
        `${file}: ${count} tool-name literal(s), baseline ${ceiling}. ${lock}`,
    ),
    ...check.unknownToolNames.map((x) => `${x} is not a tool in manifest.json.`),
  ];
}

/**
 * The baselines that match a measurement. Gains are always taken; growth is
 * refused unless `allowGrowth` is set. Unknown tool names are never recorded.
 *
 * @returns {{ laneGraph: object, budget: object }}
 */
export function ratchet(measured, laneGraph, budget, { allowGrowth = false } = {}) {
  const check = checkFitness(measured, laneGraph, budget);
  if (check.unknownToolNames.length > 0) {
    throw new Error(
      `refusing to record unknown tool names: ${check.unknownToolNames.join(', ')}`,
    );
  }
  const growth = [
    ...check.newEdges,
    ...check.newOrphans,
    ...check.newOversized.map((x) => x.file),
    ...check.grownFiles.map((x) => x.file),
    ...check.newLiterals.map((x) => x.file),
  ];
  if (growth.length > 0 && !allowGrowth) {
    throw new Error(
      `refusing to record growth without --allow-growth: ${growth.join(', ')}`,
    );
  }
  const orphans = {};
  for (const file of measured.orphans) {
    orphans[file] =
      budget.orphans?.[file] ?? 'TODO: the wave by which it gets an importer';
  }
  return {
    laneGraph: { ...laneGraph, edges: measured.edges },
    budget: {
      ...budget,
      orphans: sortObject(orphans),
      fileSize: { ...budget.fileSize, allowlist: measured.oversized },
      toolNameLiterals: measured.literals,
    },
  };
}

/** Canonical file form: two-space JSON plus a final newline. */
export function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sortObject(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function report(measured, check) {
  const out = [
    `files scanned:         ${measured.files}`,
    `cross-lane edges:      ${Object.keys(measured.edges).length}`,
    `orphan modules:        ${measured.orphans.length}`,
    `files over the limit:  ${Object.keys(measured.oversized).length}`,
    `tool-name literals:    ${Object.values(measured.literals).reduce((a, b) => a + b, 0)} in ${Object.keys(measured.literals).length} files`,
  ];
  const violations = describeViolations(check);
  out.push(
    violations.length === 0 ? 'fit: no violations' : `${violations.length} violation(s):`,
  );
  for (const v of violations) out.push(`  - ${v}`);
  return out.join('\n');
}

async function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        json: { type: 'boolean' },
        check: { type: 'boolean' },
        write: { type: 'boolean' },
        'allow-growth': { type: 'boolean' },
      },
    }));
  } catch (err) {
    process.stderr.write(`fitness: ${err.message}\n`);
    return 2;
  }
  const laneGraph = readLaneGraph();
  const budget = readBudget();
  const measured = measure({ laneGraph, budget });
  if (values.json) {
    process.stdout.write(formatJson(measured));
    return 0;
  }
  if (values.write) {
    try {
      const next = ratchet(measured, laneGraph, budget, {
        allowGrowth: values['allow-growth'],
      });
      writeFileSync(LANE_GRAPH_PATH, formatJson(next.laneGraph));
      writeFileSync(BUDGET_PATH, formatJson(next.budget));
      process.stdout.write('fitness baselines written\n');
      return 0;
    } catch (err) {
      process.stderr.write(`fitness: ${err.message}\n`);
      return 1;
    }
  }
  const check = checkFitness(measured, laneGraph, budget);
  process.stdout.write(`${report(measured, check)}\n`);
  return values.check && describeViolations(check).length > 0 ? 1 : 0;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main(process.argv.slice(2));
}
