#!/usr/bin/env node
// fixture-shape-diff.mjs — structural diff of two Graph fixture sets.
//
// Purpose
//   The `FB_API_VERSION` bump procedure (docs/runbooks/app-upkeep.md §2 step 3)
//   requires shape-diffing the recorded fixtures under `test/fixtures/` against
//   the new version's responses: a field that disappeared or changed type is the
//   whole point of the step. This script does that comparison mechanically.
//
// What it compares
//   SHAPES, never values. Every JSON document is reduced to a structural shape:
//   objects → their keys and each key's shape, arrays → the union of their
//   element shapes, scalars → their JSON type (`string`, `number`, `boolean`,
//   `null`). All strings are one type: a Graph id, a numeric string such as a
//   count Graph returns quoted, an ISO timestamp and a URL are all `string`, so
//   ordinary value churn between recordings never shows up as a diff. A string
//   becoming a real JSON number (or the reverse) IS reported — code that parses
//   one breaks on the other. Object keys that are themselves ids (a `?ids=`
//   response is keyed by object id) collapse into a single `<id>` key, so a key
//   set is compared as a map, not as a list of specific ids.
//
//   Nothing a fixture holds is ever printed: the report names paths (built from
//   key names, with ids collapsed as above) and type names only. Fixtures can
//   carry real Page ids and message text; this output can go in a PR.
//
// Diff categories
//   removed                 a field present in the baseline is gone     BREAKING
//   type-changed            a field's non-null JSON type(s) changed     BREAKING
//   array-element-changed   an array's element type(s) changed          BREAKING
//   nullability-changed     a field became (or stopped being) nullable  warning
//   added                   a field new in the candidate                info
//   Differences INSIDE array elements (e.g. `$.data[].story` removed) are
//   reported under their own category with a `[]` path segment.
//
//   Shapes are inferred from samples, so a candidate recorded against a Page
//   with fewer post kinds can "lose" an optional field that is merely absent
//   from that sample. Read every `removed` before acting on it.
//
// Usage
//   node scripts/fixture-shape-diff.mjs --baseline <dir|file> --candidate <dir|file>
//   npm run fixtures:shape-diff -- --baseline <dir> --candidate test/fixtures
//
//   --baseline <path>   the known-good fixture set (a directory of *.json, or one
//                       file)
//   --candidate <path>  the set recorded against the new version. Two
//                       directories are matched by file name (non-recursive);
//                       two files are compared directly; mixing is refused.
//   --json              machine-readable report on stdout
//   --help              usage, exit 0
//
//   Offline only: the script reads files and never touches the network. The
//   candidate set is produced with `scripts/record-fixture.mjs` (gated by
//   `FB_RECORD_FIXTURE=1`) — see test/fixtures/README.md.
//
// Exit status
//   0  no breaking difference (added fields and nullability warnings do not fail)
//   1  at least one breaking difference
//   2  usage or input error — bad arguments, unreadable path, invalid JSON, or no
//      file name common to both directories. Nothing was compared.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** Documented exit statuses (see the header). */
export const EXIT = Object.freeze({ ok: 0, breaking: 1, usage: 2 });

/** Category → severity. Only `breaking` severities fail the run. */
export const SEVERITY = Object.freeze({
  removed: 'breaking',
  'type-changed': 'breaking',
  'array-element-changed': 'breaking',
  'nullability-changed': 'warning',
  added: 'info',
});

/** Thrown for operator-actionable input problems: reported without a stack. */
export class ShapeDiffError extends Error {
  name = 'ShapeDiffError';

  constructor(message, exitCode = EXIT.usage) {
    super(message);
    this.exitCode = exitCode;
  }
}

const USAGE = `facebook-mcp fixture shape-diff

  node scripts/fixture-shape-diff.mjs --baseline <dir|file> --candidate <dir|file> [--json]

Options
  --baseline <path>   known-good fixture set: a directory of *.json, or one file
  --candidate <path>  set recorded against the new API version (same kind of path)
  --json              machine-readable report on stdout
  --help              show this text and exit 0

Compares structural shapes only (keys and JSON types), never values.
Exit: 0 no breaking diff, 1 breaking diff (removed / type changed), 2 usage error.
`;

// ---------------------------------------------------------------------------
// Shape inference (pure)
// ---------------------------------------------------------------------------

/**
 * A key that is itself an object id: all digits, or Graph's `{page}_{post}`
 * compound form. Such keys are collapsed to `ID_KEY` so the report never echoes
 * an id and a `?ids=` map is compared as a map.
 */
const ID_KEY_RE = /^\d+(?:_\d+)*$/;
export const ID_KEY = '<id>';

/** JSON type name of one value. */
function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'object') return t;
  // undefined / bigint / function cannot come out of JSON.parse.
  throw new TypeError(`not a JSON value (${t})`);
}

/**
 * Shape of a JSON value. A shape is a plain, JSON-serialisable object:
 *   { kinds: string[] (sorted, e.g. ["null","string"]),
 *     fields?: { [key]: Shape }            — present when kinds has "object"
 *     element?: Shape | null }             — present when kinds has "array";
 *                                            null means "only empty arrays seen"
 * No scalar value is ever retained.
 */
export function shapeOf(value) {
  const kind = kindOf(value);
  if (kind === 'object') {
    const fields = {};
    for (const [key, child] of Object.entries(value)) {
      const name = ID_KEY_RE.test(key) ? ID_KEY : key;
      const shape = shapeOf(child);
      fields[name] = name in fields ? mergeShapes(fields[name], shape) : shape;
    }
    return { kinds: ['object'], fields };
  }
  if (kind === 'array') {
    let element = null;
    for (const item of value) {
      const shape = shapeOf(item);
      element = element === null ? shape : mergeShapes(element, shape);
    }
    return { kinds: ['array'], element };
  }
  return { kinds: [kind] };
}

/** Union of two shapes (used for array elements and collapsed id keys). */
export function mergeShapes(a, b) {
  const kinds = [...new Set([...a.kinds, ...b.kinds])].sort();
  const out = { kinds };
  if (kinds.includes('object')) {
    const fields = { ...(a.fields ?? {}) };
    for (const [key, shape] of Object.entries(b.fields ?? {})) {
      fields[key] = key in fields ? mergeShapes(fields[key], shape) : shape;
    }
    out.fields = fields;
  }
  if (kinds.includes('array')) {
    const ea = a.element ?? null;
    const eb = b.element ?? null;
    out.element = ea === null ? eb : eb === null ? ea : mergeShapes(ea, eb);
  }
  return out;
}

/** Short, value-free description of a shape, e.g. `string|null`, `array<object>`. */
export function describeShape(shape) {
  if (shape === null) return 'unknown';
  return shape.kinds
    .map((kind) => {
      if (kind !== 'array') return kind;
      const element = shape.element ?? null;
      return element === null ? 'array<empty>' : `array<${describeShape(element)}>`;
    })
    .join('|');
}

// ---------------------------------------------------------------------------
// Shape diff (pure)
// ---------------------------------------------------------------------------

const nonNull = (shape) => shape.kinds.filter((k) => k !== 'null');
const sameSet = (a, b) => a.length === b.length && a.every((k) => b.includes(k));

/** Child path for an object key (dot form when the key is a plain identifier). */
function keyPath(path, key) {
  return /^[A-Za-z_$<][\w$<>]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

/**
 * Diff two shapes. Returns an array of
 *   { category, severity, path, baseline, candidate }
 * where `baseline`/`candidate` are value-free type descriptions (or null when
 * the side has no such field). Sorted by path, then category.
 */
export function diffShapes(baseline, candidate, path = '$') {
  const diffs = [];
  walk(baseline, candidate, path, false, diffs);
  return diffs.sort(
    (x, y) => x.path.localeCompare(y.path) || x.category.localeCompare(y.category),
  );
}

function push(diffs, category, path, baseline, candidate) {
  diffs.push({
    category,
    severity: SEVERITY[category],
    path,
    baseline: baseline === null ? null : describeShape(baseline),
    candidate: candidate === null ? null : describeShape(candidate),
  });
}

function walk(base, cand, path, isArrayElement, diffs) {
  const baseKinds = nonNull(base);
  const candKinds = nonNull(cand);

  // Nullability. A side that was ONLY ever null carries no type information, so
  // the type comparison below is skipped for it; the change is still reported.
  if (base.kinds.includes('null') !== cand.kinds.includes('null')) {
    push(diffs, 'nullability-changed', path, base, cand);
  }
  if (baseKinds.length === 0 || candKinds.length === 0) return;

  if (!sameSet(baseKinds, candKinds)) {
    push(
      diffs,
      isArrayElement ? 'array-element-changed' : 'type-changed',
      path,
      base,
      cand,
    );
  }

  if (baseKinds.includes('object') && candKinds.includes('object')) {
    const bf = base.fields ?? {};
    const cf = cand.fields ?? {};
    for (const key of Object.keys(bf)) {
      const child = keyPath(path, key);
      if (key in cf) {
        walk(bf[key], cf[key], child, false, diffs);
      } else {
        push(diffs, 'removed', child, bf[key], null);
      }
    }
    for (const key of Object.keys(cf)) {
      if (!(key in bf)) push(diffs, 'added', keyPath(path, key), null, cf[key]);
    }
  }

  if (baseKinds.includes('array') && candKinds.includes('array')) {
    const be = base.element ?? null;
    const ce = cand.element ?? null;
    // An empty array on either side says nothing about its elements.
    if (be !== null && ce !== null) walk(be, ce, `${path}[]`, true, diffs);
  }
}

/** True when any diff is breaking. */
export function hasBreaking(diffs) {
  return diffs.some((d) => d.severity === 'breaking');
}

// ---------------------------------------------------------------------------
// Fixture sets (filesystem)
// ---------------------------------------------------------------------------

/** Parse CLI arguments. Throws ShapeDiffError (exit 2) on misuse. */
export function parseCliArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        baseline: { type: 'string' },
        candidate: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    throw new ShapeDiffError(
      `${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`,
    );
  }
  if (values.help) return { help: true, json: false };
  if (!values.baseline || !values.candidate) {
    throw new ShapeDiffError(
      'usage: fixture-shape-diff.mjs --baseline <dir|file> --candidate <dir|file> [--json]',
    );
  }
  return {
    help: false,
    baseline: values.baseline,
    candidate: values.candidate,
    json: values.json,
  };
}

function statKind(path, flag) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new ShapeDiffError(`${flag} ${path}: no such file or directory`);
  }
  if (stat.isDirectory()) return 'dir';
  if (stat.isFile()) return 'file';
  throw new ShapeDiffError(`${flag} ${path}: not a regular file or directory`);
}

function readJson(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ShapeDiffError(
      `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    // The parser's message can quote file content; name the file only.
    throw new ShapeDiffError(`${path} is not valid JSON`);
  }
}

const jsonFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name)
    .sort();

/**
 * Compare two fixture sets. Returns
 *   { files: [{ file, diffs }], baselineOnly: string[], candidateOnly: string[] }
 * Throws ShapeDiffError for usage/input errors.
 */
export function compareSets(baselinePath, candidatePath) {
  const bk = statKind(baselinePath, '--baseline');
  const ck = statKind(candidatePath, '--candidate');
  if (bk !== ck) {
    throw new ShapeDiffError(
      '--baseline and --candidate must both be directories or both be files ' +
        `(got a ${bk} and a ${ck})`,
    );
  }

  if (bk === 'file') {
    const diffs = diffShapes(
      shapeOf(readJson(baselinePath)),
      shapeOf(readJson(candidatePath)),
    );
    const file =
      basename(baselinePath) === basename(candidatePath)
        ? basename(baselinePath)
        : `${basename(baselinePath)} -> ${basename(candidatePath)}`;
    return { files: [{ file, diffs }], baselineOnly: [], candidateOnly: [] };
  }

  const baseNames = jsonFiles(baselinePath);
  const candNames = jsonFiles(candidatePath);
  const common = baseNames.filter((n) => candNames.includes(n));
  if (common.length === 0) {
    throw new ShapeDiffError(
      `no *.json file name is common to ${baselinePath} and ${candidatePath}; ` +
        'fixture sets are matched by file name',
    );
  }
  const files = common.map((file) => ({
    file,
    diffs: diffShapes(
      shapeOf(readJson(join(baselinePath, file))),
      shapeOf(readJson(join(candidatePath, file))),
    ),
  }));
  return {
    files,
    baselineOnly: baseNames.filter((n) => !candNames.includes(n)),
    candidateOnly: candNames.filter((n) => !baseNames.includes(n)),
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** Machine report (the `--json` output). */
export function jsonReport(result) {
  const all = result.files.flatMap((f) => f.diffs);
  const count = (sev) => all.filter((d) => d.severity === sev).length;
  return {
    ok: !hasBreaking(all),
    summary: {
      compared: result.files.length,
      breaking: count('breaking'),
      warning: count('warning'),
      info: count('info'),
    },
    files: result.files,
    baselineOnly: result.baselineOnly,
    candidateOnly: result.candidateOnly,
  };
}

/** Human report. */
export function textReport(result) {
  const report = jsonReport(result);
  const lines = [];
  for (const { file, diffs } of result.files) {
    if (diffs.length === 0) {
      lines.push(`${file}: same shape`);
      continue;
    }
    lines.push(`${file}:`);
    for (const d of diffs) {
      const change =
        d.category === 'removed'
          ? `was ${d.baseline}`
          : d.category === 'added'
            ? d.candidate
            : `${d.baseline} -> ${d.candidate}`;
      lines.push(
        `  ${d.severity.toUpperCase().padEnd(8)} ${d.category.padEnd(21)} ${d.path}  (${change})`,
      );
    }
  }
  for (const f of result.baselineOnly) {
    lines.push(`${f}: only in baseline — not compared (record it for the new version)`);
  }
  for (const f of result.candidateOnly)
    lines.push(`${f}: only in candidate — not compared`);
  const s = report.summary;
  lines.push(
    '',
    `compared ${String(s.compared)} fixture(s): ${String(s.breaking)} breaking, ` +
      `${String(s.warning)} warning, ${String(s.info)} info — ` +
      (report.ok ? 'OK' : 'BREAKING'),
  );
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export function main(argv = process.argv.slice(2), out = process.stdout) {
  const options = parseCliArgs(argv);
  if (options.help) {
    out.write(USAGE);
    return EXIT.ok;
  }
  const result = compareSets(options.baseline, options.candidate);
  const report = jsonReport(result);
  out.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : textReport(result));
  return report.ok ? EXIT.ok : EXIT.breaking;
}

// Run only as the process entry point, never on import (the tests import it).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (err) {
    if (err instanceof ShapeDiffError) {
      process.stderr.write(`fixture-shape-diff: ${err.message}\n`);
      process.exitCode = err.exitCode;
    } else {
      process.stderr.write(
        `fixture-shape-diff: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exitCode = EXIT.usage;
    }
  }
}
