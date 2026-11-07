#!/usr/bin/env node
// coverage-ratchet.mjs — per-file coverage ratchet (R11; review findings
// QA-08, ARC-12, decision D-QA-2).
//
// Purpose
//   The global c8 thresholds in `.c8rc.json` only see the totals. With ~130
//   production files, a lane can drop every test of one file and the totals
//   barely move. This script compares the per-file result of the run that just
//   finished (`coverage/coverage-summary.json`, the c8 `json-summary` reporter)
//   with the checked-in baseline `scripts/coverage-baseline.json`, which is the
//   per-file coverage of `main`. Because the baseline lives on `main`, a branch
//   is compared with `main` mechanically: a drop fails `npm run check`, and the
//   only way to accept one is a visible baseline change in the diff.
//
// What is ratcheted
//   The UNCOVERED count per file of lines, branches and functions (statements
//   equal lines under V8 coverage). A count, not a percentage: a file that grows
//   with fully tested code keeps its count, a file that loses tests or gains
//   untested code raises it, and a one-branch difference in a small file is one,
//   not ten points.
//
// Rules (per file and metric)
//   1. The uncovered count may not exceed the baseline by more than `tolerance`.
//   2. It may not fall more than `tolerance` below the baseline without the gain
//      being recorded (`--write`): the ratchet only ever tightens.
//   3. A production file that is measured but not in the baseline is new; it is
//      recorded with `--write`, and must reach the `newFileFloor` percentages.
//   4. A baseline entry whose file is no longer measured is stale (the file was
//      deleted, renamed or excluded); `--write` removes it.
//   `tolerance` absorbs the differences between the Node versions of the CI
//   matrix (V8 on Node 22 counts a function or a branch more in a few files than
//   on Node 26); it is not a budget.
//
// Windows
//   The baseline is a POSIX measurement. The Windows CI leg skips the tests
//   that only run on POSIX (file modes, signals), so its counts are higher by
//   construction; on win32 `--check` reports and does not fail. The global
//   thresholds in `.c8rc.json` still apply there.
//
// Usage
//   node scripts/coverage-ratchet.mjs                  report
//   node scripts/coverage-ratchet.mjs --check          exit 1 on a violation
//   node scripts/coverage-ratchet.mjs --write          record gains, new files
//                                                      and removals
//   node scripts/coverage-ratchet.mjs --write --allow-decrease
//                                                      also record drops and new
//                                                      files under the floor (say
//                                                      why in the commit)
//   --summary <path>                                   another summary file
//
// Exit codes: 0 ok, 1 violation or refused write, 2 usage error or no summary.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE_PATH = resolve(REPO_ROOT, 'scripts', 'coverage-baseline.json');
export const SUMMARY_PATH = resolve(REPO_ROOT, 'coverage', 'coverage-summary.json');

/** The tracked metrics, in the column order of a baseline entry. */
export const METRICS = /** @type {const} */ (['lines', 'branches', 'functions']);

/**
 * Reduce a c8 `json-summary` object to
 * `{ "src/x.ts": { uncovered: [l, b, f], pct: [l, b, f] } }` with repo-relative
 * POSIX paths. The `total` row is dropped.
 */
export function perFile(summary, root = REPO_ROOT) {
  const out = {};
  for (const [key, entry] of Object.entries(summary)) {
    if (key === 'total') continue;
    const rel = relative(root, key).split(sep).join('/');
    out[rel] = {
      uncovered: METRICS.map((m) => entry[m].total - entry[m].covered),
      pct: METRICS.map((m) => entry[m].pct),
    };
  }
  return out;
}

/** Compare a measurement with the baseline; returns the violations by kind. */
export function compare(measured, baseline) {
  const { tolerance, newFileFloor, files } = baseline;
  const floor = METRICS.map((m) => newFileFloor[m]);
  const dropped = [];
  const raised = [];
  const added = [];
  const stale = [];
  for (const [file, { uncovered, pct }] of Object.entries(measured)) {
    const base = files[file];
    if (base === undefined) {
      const under = METRICS.filter((_, i) => pct[i] < floor[i]);
      added.push({ file, uncovered, under });
      continue;
    }
    METRICS.forEach((metric, i) => {
      const delta = uncovered[i] - base[i];
      const change = { file, metric, from: base[i], to: uncovered[i] };
      if (delta > tolerance) dropped.push(change);
      else if (delta < -tolerance) raised.push(change);
    });
  }
  for (const file of Object.keys(files)) {
    if (!(file in measured)) stale.push(file);
  }
  return { dropped, raised, added, stale };
}

/** True when the comparison has anything that `--check` refuses. */
export function hasViolations(result) {
  return (
    result.dropped.length > 0 ||
    result.raised.length > 0 ||
    result.added.length > 0 ||
    result.stale.length > 0
  );
}

/** Human-readable lines for a comparison, empty when it is clean. */
export function describe(result) {
  const lines = [];
  for (const d of result.dropped) {
    lines.push(`dropped  ${d.file} uncovered ${d.metric} ${d.from} -> ${d.to}`);
  }
  for (const r of result.raised) {
    lines.push(
      `raised   ${r.file} uncovered ${r.metric} ${r.from} -> ${r.to} (record it: --write)`,
    );
  }
  for (const a of result.added) {
    const note =
      a.under.length > 0
        ? `under the new-file floor on ${a.under.join(', ')}`
        : 'record it: --write';
    lines.push(`new      ${a.file} uncovered [${a.uncovered.join(', ')}] (${note})`);
  }
  for (const s of result.stale) {
    lines.push(`stale    ${s} (no longer measured; remove it: --write)`);
  }
  return lines;
}

/**
 * The baseline that `--write` would store, or the reasons it refuses. Without
 * `allowDecrease`, a drop or a new file under the floor is refused; gains, new
 * files and removals are always recorded.
 */
export function ratchet(measured, baseline, { allowDecrease = false } = {}) {
  const result = compare(measured, baseline);
  if (!allowDecrease) {
    const refused = [
      ...result.dropped.map((d) => `dropped ${d.file} ${d.metric}`),
      ...result.added
        .filter((a) => a.under.length > 0)
        .map((a) => `new ${a.file} under the floor`),
    ];
    if (refused.length > 0) return { refused };
  }
  const files = {};
  for (const file of Object.keys(measured).sort()) files[file] = measured[file].uncovered;
  return { baseline: { ...baseline, files } };
}

/** Serialise a baseline as Prettier formats it (one file per line). */
export function formatBaseline(baseline) {
  const { files, ...head } = baseline;
  const headJson = JSON.stringify(head, null, 2).slice(0, -2);
  const rows = Object.entries(files).map(
    ([file, values]) => `    ${JSON.stringify(file)}: [${values.join(', ')}]`,
  );
  return `${headJson},\n  "files": {\n${rows.join(',\n')}\n  }\n}\n`;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main() {
  let args;
  try {
    args = parseArgs({
      options: {
        check: { type: 'boolean', default: false },
        write: { type: 'boolean', default: false },
        'allow-decrease': { type: 'boolean', default: false },
        summary: { type: 'string', default: SUMMARY_PATH },
      },
    }).values;
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    return 2;
  }
  if (!existsSync(args.summary)) {
    console.error(
      `coverage-ratchet: no ${relative(REPO_ROOT, args.summary)}; run \`npm run coverage\` first.`,
    );
    return 2;
  }
  const measured = perFile(readJson(args.summary));
  const baseline = readJson(BASELINE_PATH);

  if (args.write) {
    const out = ratchet(measured, baseline, { allowDecrease: args['allow-decrease'] });
    if (out.refused !== undefined) {
      console.error(
        'coverage-ratchet: refusing to record a decrease without --allow-decrease:',
      );
      for (const r of out.refused) console.error(`  ${r}`);
      return 1;
    }
    writeFileSync(BASELINE_PATH, formatBaseline(out.baseline));
    console.log(
      `coverage-ratchet: wrote ${relative(REPO_ROOT, BASELINE_PATH)} (${Object.keys(out.baseline.files).length} files)`,
    );
    return 0;
  }

  const result = compare(measured, baseline);
  const lines = describe(result);
  if (lines.length === 0) {
    console.log(
      `coverage-ratchet: ${Object.keys(measured).length} files at or above the baseline - ok`,
    );
    return 0;
  }
  for (const line of lines) console.log(line);
  if (args.check && hasViolations(result)) {
    if (process.platform === 'win32') {
      console.log('coverage-ratchet: win32 run, the POSIX baseline is advisory here.');
      return 0;
    }
    console.error(
      'coverage-ratchet: coverage differs from scripts/coverage-baseline.json (see above).',
    );
    return 1;
  }
  return 0;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main();
}
