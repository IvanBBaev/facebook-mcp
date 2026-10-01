// Fixture shape-diff (`scripts/fixture-shape-diff.mjs`).
//
// The script is the mechanical form of app-upkeep.md §2 step 3: on an
// `FB_API_VERSION` bump, the recorded fixtures are shape-diffed against the new
// version's responses. Three properties matter and are pinned here:
//
//   1. the shape is structural only — value churn (a different id, a numeric
//      string with other digits, a new timestamp) is never a diff, while a real
//      type change is;
//   2. the categories map to the documented exit status: removed / type /
//      array-element changes fail, added fields and nullability do not;
//   3. no fixture VALUE ever reaches the report, including ids used as keys.
//
// Same import convention as `src/record-fixture.test.ts`: the script lives
// outside `rootDir`, so it is loaded the way Node loads it. Nothing here touches
// the network; the one child process reads temp files only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This file compiles to `build/fixture-shape-diff.test.js`, so the root is one level up. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'fixture-shape-diff.mjs');

interface Shape {
  readonly kinds: string[];
  readonly fields?: Record<string, Shape>;
  readonly element?: Shape | null;
}

interface Diff {
  readonly category: string;
  readonly severity: 'breaking' | 'warning' | 'info';
  readonly path: string;
  readonly baseline: string | null;
  readonly candidate: string | null;
}

interface SetResult {
  readonly files: { file: string; diffs: Diff[] }[];
  readonly baselineOnly: string[];
  readonly candidateOnly: string[];
}

interface ShapeDiff {
  readonly EXIT: {
    readonly ok: number;
    readonly breaking: number;
    readonly usage: number;
  };
  readonly ID_KEY: string;
  readonly shapeOf: (value: unknown) => Shape;
  readonly mergeShapes: (a: Shape, b: Shape) => Shape;
  readonly describeShape: (shape: Shape | null) => string;
  readonly diffShapes: (baseline: Shape, candidate: Shape) => Diff[];
  readonly hasBreaking: (diffs: readonly Diff[]) => boolean;
  readonly parseCliArgs: (argv: readonly string[]) => {
    help: boolean;
    baseline?: string;
    candidate?: string;
    json: boolean;
  };
  readonly compareSets: (baseline: string, candidate: string) => SetResult;
  readonly textReport: (result: SetResult) => string;
}

const sd = (await import(pathToFileURL(SCRIPT).href)) as ShapeDiff;
const { EXIT, ID_KEY, shapeOf, describeShape, diffShapes, hasBreaking, parseCliArgs } =
  sd;

const diff = (a: unknown, b: unknown): Diff[] => diffShapes(shapeOf(a), shapeOf(b));
const summary = (diffs: readonly Diff[]): string[] =>
  diffs.map((d) => `${d.category} ${d.path}`);

/** Assert `fn` throws a ShapeDiffError whose message mentions `expected`. */
function refuses(fn: () => unknown, expected: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'ShapeDiffError');
    assert.match(err.message, expected);
    return true;
  });
}

// ---------------------------------------------------------------------------
// 1. Shape inference
// ---------------------------------------------------------------------------

test('shapeOf reduces scalars to their JSON type and keeps no value', () => {
  assert.deepEqual(shapeOf('100000000000001'), { kinds: ['string'] });
  assert.deepEqual(shapeOf(42), { kinds: ['number'] });
  assert.deepEqual(shapeOf(false), { kinds: ['boolean'] });
  assert.deepEqual(shapeOf(null), { kinds: ['null'] });
  const shape = shapeOf({ id: '123', message: 'private text', n: 7 });
  const serialised = JSON.stringify(shape);
  assert.doesNotMatch(serialised, /123|private text|7/);
});

test('array shape is the union of element shapes; empty arrays have no element', () => {
  assert.equal(describeShape(shapeOf([1, 'a', null])), 'array<null|number|string>');
  assert.equal(describeShape(shapeOf([])), 'array<empty>');
  const posts = shapeOf([
    { id: '1_2', message: 'x' },
    { id: '1_3', story: 'y' },
  ]);
  assert.deepEqual(Object.keys(posts.element?.fields ?? {}).sort(), [
    'id',
    'message',
    'story',
  ]);
});

test('id-shaped object keys collapse into one map key', () => {
  const shape = shapeOf({ '100000000000001': { name: 'a' }, '1_2': { name: 'b', x: 1 } });
  assert.deepEqual(Object.keys(shape.fields ?? {}), [ID_KEY]);
  assert.deepEqual(Object.keys(shape.fields?.[ID_KEY]?.fields ?? {}).sort(), [
    'name',
    'x',
  ]);
});

// ---------------------------------------------------------------------------
// 2. Diff categories
// ---------------------------------------------------------------------------

test('identical shapes with different values produce no diff', () => {
  assert.deepEqual(
    diff(
      { id: '1', count: '12', created_time: '2026-01-01T00:00:00+0000', ok: true },
      { id: '999', count: '7', created_time: '2027-05-05T10:10:10+0000', ok: false },
    ),
    [],
  );
});

test('a removed field is breaking', () => {
  const diffs = diff({ id: '1', name: 'a' }, { id: '1' });
  assert.deepEqual(summary(diffs), ['removed $.name']);
  assert.equal(diffs[0]?.severity, 'breaking');
  assert.equal(diffs[0]?.baseline, 'string');
  assert.equal(hasBreaking(diffs), true);
});

test('a numeric string turning into a number is a breaking type change', () => {
  const diffs = diff({ count: '12' }, { count: 12 });
  assert.deepEqual(summary(diffs), ['type-changed $.count']);
  assert.equal(diffs[0]?.baseline, 'string');
  assert.equal(diffs[0]?.candidate, 'number');
  assert.equal(hasBreaking(diffs), true);
});

test('an added field is informational and does not fail', () => {
  const diffs = diff({ id: '1' }, { id: '1', new_field: { a: 1 } });
  assert.deepEqual(summary(diffs), ['added $.new_field']);
  assert.equal(diffs[0]?.severity, 'info');
  assert.equal(hasBreaking(diffs), false);
});

test('nullability changes are warnings in both directions', () => {
  const became = diff({ v: 'a' }, { v: null });
  assert.deepEqual(summary(became), ['nullability-changed $.v']);
  assert.equal(became[0]?.severity, 'warning');
  const mixed = diff({ data: [{ v: 'a' }] }, { data: [{ v: 'a' }, { v: null }] });
  assert.deepEqual(summary(mixed), ['nullability-changed $.data[].v']);
  assert.equal(hasBreaking(mixed), false);
});

test('array element type change is its own breaking category', () => {
  const diffs = diff({ tasks: ['ANALYZE'] }, { tasks: [{ name: 'ANALYZE' }] });
  assert.deepEqual(summary(diffs), ['array-element-changed $.tasks[]']);
  assert.equal(diffs[0]?.baseline, 'string');
  assert.equal(diffs[0]?.candidate, 'object');
  assert.equal(hasBreaking(diffs), true);
});

test('field diffs inside array elements carry a [] path segment', () => {
  const diffs = diff(
    { data: [{ id: '1', story: 's', created_time: 't' }] },
    { data: [{ id: '2', created_time: 3, from: {} }] },
  );
  assert.deepEqual(summary(diffs), [
    'type-changed $.data[].created_time',
    'added $.data[].from',
    'removed $.data[].story',
  ]);
});

test('an empty array on either side is not an element change', () => {
  assert.deepEqual(diff({ data: [{ id: '1' }] }, { data: [] }), []);
  assert.deepEqual(diff({ data: [] }, { data: [1] }), []);
});

test('a whole-body error replaces the success shape as breaking removals', () => {
  const diffs = diff({ id: '1', name: 'a' }, { error: { message: 'm', code: 100 } });
  assert.equal(hasBreaking(diffs), true);
  assert.deepEqual(summary(diffs), ['added $.error', 'removed $.id', 'removed $.name']);
});

// ---------------------------------------------------------------------------
// 3. CLI
// ---------------------------------------------------------------------------

test('parseCliArgs requires both paths and refuses unknown flags', () => {
  refuses(() => parseCliArgs([]), /usage/);
  refuses(() => parseCliArgs(['--baseline', 'a']), /usage/);
  refuses(() => parseCliArgs(['--baseline', 'a', '--candidate', 'b', '--x']), /Unknown/);
  assert.deepEqual(parseCliArgs(['--baseline', 'a', '--candidate', 'b', '--json']), {
    help: false,
    baseline: 'a',
    candidate: 'b',
    json: true,
  });
  assert.equal(parseCliArgs(['--help']).help, true);
});

test('CLI: directory sets are matched by name, exit codes and report hold no values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fixture-shape-diff-'));
  try {
    const base = join(root, 'base');
    const cand = join(root, 'cand');
    const same = join(root, 'same');
    await Promise.all([mkdir(base), mkdir(cand), mkdir(same)]);
    const SECRET_ID = '100000000000987';
    const me = { id: SECRET_ID, name: 'Private Page Name', tasks: ['ANALYZE'] };
    await writeFile(join(base, 'graph-me.json'), JSON.stringify(me));
    await writeFile(join(base, 'only-base.json'), '{}');
    await writeFile(join(same, 'graph-me.json'), JSON.stringify({ ...me, extra: 1 }));
    await writeFile(
      join(cand, 'graph-me.json'),
      JSON.stringify({ id: Number(SECRET_ID), tasks: ['ANALYZE'], [SECRET_ID]: 'x' }),
    );
    await writeFile(join(cand, 'only-cand.json'), '[]');

    const run = (...args: string[]) =>
      spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

    const breaking = run('--baseline', base, '--candidate', cand);
    assert.equal(breaking.status, EXIT.breaking, breaking.stderr);
    assert.match(breaking.stdout, /BREAKING\s+removed\s+\$\.name/);
    assert.match(
      breaking.stdout,
      /BREAKING\s+type-changed\s+\$\.id\s+\(string -> number\)/,
    );
    assert.match(breaking.stdout, /only-base\.json: only in baseline/);
    assert.match(breaking.stdout, /only-cand\.json: only in candidate/);
    assert.doesNotMatch(breaking.stdout, new RegExp(`${SECRET_ID}|Private Page Name`));

    const json = run('--baseline', base, '--candidate', cand, '--json');
    assert.equal(json.status, EXIT.breaking);
    const report = JSON.parse(json.stdout) as {
      ok: boolean;
      summary: { compared: number; breaking: number; info: number };
    };
    assert.equal(report.ok, false);
    assert.equal(report.summary.compared, 1);
    assert.equal(report.summary.breaking, 2);
    assert.equal(report.summary.info, 1);
    assert.doesNotMatch(json.stdout, new RegExp(`${SECRET_ID}|Private Page Name`));

    const addedOnly = run('--baseline', base, '--candidate', same);
    assert.equal(addedOnly.status, EXIT.ok, addedOnly.stdout);
    assert.match(addedOnly.stdout, /INFO\s+added\s+\$\.extra/);

    const files = run(
      '--baseline',
      join(base, 'graph-me.json'),
      '--candidate',
      join(base, 'graph-me.json'),
    );
    assert.equal(files.status, EXIT.ok);
    assert.match(files.stdout, /graph-me\.json: same shape/);

    assert.equal(run('--baseline', base).status, EXIT.usage);
    assert.equal(
      run('--baseline', base, '--candidate', join(base, 'graph-me.json')).status,
      EXIT.usage,
    );
    assert.equal(
      run('--baseline', base, '--candidate', join(root, 'nope')).status,
      EXIT.usage,
    );
    await writeFile(join(same, 'only-base.json'), '{not json');
    const invalid = run('--baseline', base, '--candidate', same);
    assert.equal(invalid.status, EXIT.usage);
    assert.match(invalid.stderr, /only-base\.json is not valid JSON/);
    assert.equal(run('--help').status, EXIT.ok);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI: the committed fixtures have the same shape as themselves', () => {
  const dir = join(REPO_ROOT, 'test', 'fixtures');
  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--baseline', dir, '--candidate', dir],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, EXIT.ok, result.stderr);
  assert.doesNotMatch(result.stdout, /BREAKING|WARNING|INFO /);
});
