// Structural invariants for the error -> action MATRIX (task F06, data half).
//
// These tests guard the TABLE as data: they freeze its membership (ids + count),
// prove the rows are well-formed and non-overlapping, and check the cross-field
// invariants the classifier in `./errors.ts` relies on (every category is a real
// ErrorCategory; ranges are ordered; honor-ETA rows carry a default). The full
// per-row behavioural snapshot lives in `./errors.test.ts`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ErrorCategory } from './index.js';
import {
  DEFAULT_THROTTLE_RETRY_AFTER_MS,
  ERROR_MATRIX,
  ETA_MINUTES_TO_MS,
} from './error-matrix.js';
import { matchErrorRow } from './errors.js';
import { isThrottleCode } from './http.js';

// Frozen membership: the exact ids, in order. Adding/removing/renaming a row is a
// visible diff here (and in the behavioural snapshot). Count is asserted too so a
// duplicate id cannot sneak the length up while the list still "looks" right.
const EXPECTED_IDS = [
  'auth-190-460',
  'auth-190-463',
  'auth-190-467',
  'permission-190-492',
  'auth-190-459',
  'auth-190-464',
  'auth-190',
  'auth-102',
  'auth-460',
  'auth-463',
  'auth-467',
  'blocked-368',
  'permission-200',
  'permission-10',
  'permission-2xx',
  'rate-4',
  'rate-17',
  'rate-32',
  'rate-613',
  'rate-341',
  'rate-buc',
  'duplicate-506',
  'not-found-100-21',
  'not-found-21',
  'not-found-803',
  'not-found-100-33',
  'validation-100',
  'validation-324',
  'transient-1',
  'transient-2',
  'unsupported-12',
  'unsupported-2635',
] as const;

// The frozen ErrorCategory union (types.ts). Kept here as a literal set so a typo
// in a matrix row's category is caught structurally, independent of the classifier.
const VALID_CATEGORIES: ReadonlySet<ErrorCategory> = new Set<ErrorCategory>([
  'auth',
  'permission',
  'rate_limit',
  'transient',
  'duplicate',
  'not_found',
  'validation',
  'ambiguous',
  'cursor_expired',
  'account',
  'unsupported',
  'unknown',
]);

test('matrix membership is frozen (ids + count)', () => {
  assert.equal(ERROR_MATRIX.length, EXPECTED_IDS.length);
  assert.deepStrictEqual(
    ERROR_MATRIX.map((r) => r.id),
    [...EXPECTED_IDS],
  );
});

test('row ids are unique', () => {
  const ids = ERROR_MATRIX.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('no two exact-code rows share the same (code, subcode) matcher', () => {
  const seen = new Set<string>();
  for (const r of ERROR_MATRIX) {
    if (r.codeMax !== undefined) continue;
    const key = `${r.code}:${r.subcode ?? '*'}`;
    assert.ok(!seen.has(key), `duplicate matcher ${key} (${r.id})`);
    seen.add(key);
  }
});

test('range rows are well-formed: codeMax > code and no subcode constraint', () => {
  for (const r of ERROR_MATRIX) {
    if (r.codeMax === undefined) continue;
    assert.ok(r.codeMax > r.code, `${r.id}: codeMax must exceed code`);
    assert.equal(r.subcode, undefined, `${r.id}: a range row must not pin a subcode`);
  }
});

test('every row uses a category from the frozen ErrorCategory union', () => {
  for (const r of ERROR_MATRIX) {
    assert.ok(
      VALID_CATEGORIES.has(r.category),
      `${r.id}: unexpected category ${r.category}`,
    );
  }
});

test('every row has substantial, sentence-like operator text', () => {
  for (const r of ERROR_MATRIX) {
    assert.ok(r.operatorText.length >= 40, `${r.id}: operator text too short`);
    assert.match(
      r.operatorText,
      /\.$/,
      `${r.id}: operator text should end with a period`,
    );
  }
});

test('honor-ETA throttle rows carry the default surfaced retry-after (so an ETA-less throttle still hints)', () => {
  for (const r of ERROR_MATRIX) {
    if (!r.honorEta || r.category !== 'rate_limit') continue;
    assert.equal(
      typeof r.retryAfterMs,
      'number',
      `${r.id}: honorEta needs a default retryAfterMs`,
    );
    assert.equal(r.retryAfterMs, DEFAULT_THROTTLE_RETRY_AFTER_MS, `${r.id}`);
  }
});

test('a row that surfaces a retryAfterMs also honors the envelope ETA', () => {
  for (const r of ERROR_MATRIX) {
    if (r.retryAfterMs === undefined) continue;
    assert.equal(r.honorEta, true, `${r.id}: retryAfterMs present but honorEta not set`);
  }
});

test('throttle families 4/17/32/613 and the 80000-80099 range are present and retryable', () => {
  for (const code of [4, 17, 32, 613]) {
    const r = ERROR_MATRIX.find((x) => x.code === code && x.codeMax === undefined);
    assert.ok(r, `missing throttle row for code ${code}`);
    assert.equal(r?.category, 'rate_limit');
    assert.equal(r?.retryable, true);
    assert.equal(r?.nextTool, 'facebook_usage');
  }
  const buc = ERROR_MATRIX.find((x) => x.code === 80000 && x.codeMax === 80099);
  assert.ok(buc, 'missing business-use-case range row');
  assert.equal(buc?.category, 'rate_limit');
  assert.equal(buc?.retryable, true);
});

test('only a throttle row invents a default cool-down; any other row surfaces an ETA only when Graph names one', () => {
  // The 60 s default is a throttle heuristic. On a policy block (368) — hours to
  // days, extended by every attempt — it is a false number sitting next to
  // "Do NOT auto-retry".
  for (const r of ERROR_MATRIX) {
    if (r.retryAfterMs === undefined) continue;
    assert.equal(
      r.category,
      'rate_limit',
      `${r.id}: a ${r.category} row must not carry a default retryAfterMs`,
    );
  }
});

test('ETA_MINUTES_TO_MS converts minutes to milliseconds', () => {
  assert.equal(ETA_MINUTES_TO_MS, 60_000);
});

test('CC-NET-1: every retryable rate_limit row is a code the transport actually retries', () => {
  // The matrix is a promise made to the operator and to the model ("retry after
  // the cool-down"); the transport's retry loop is what keeps it. A rate_limit
  // row the loop does not recognise as a throttle promises a back-off that never
  // happens — worse than saying nothing, because the model is told to wait and
  // the call it repeats is spaced by nothing at all. The two tables are edited in
  // different files, so the invariant has to be asserted rather than remembered.
  for (const row of ERROR_MATRIX) {
    if (row.category !== 'rate_limit' || !row.retryable) continue;
    for (const code of [row.code, row.codeMax ?? row.code]) {
      assert.equal(
        isThrottleCode(code),
        true,
        `matrix row ${row.id} promises a retry for code ${code} the transport does not throttle`,
      );
    }
  }
});

// The registered tool names, read from the generated `manifest.json` (kept in
// sync with the tool registry by `metadata.test.ts`). core may not import tools/,
// so the manifest is the one registry view this layer can consult.
function registeredToolNames(): ReadonlySet<string> {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'manifest.json'), 'utf8')) as {
    readonly tools?: readonly { readonly name?: unknown }[];
  };
  const names = (manifest.tools ?? [])
    .map((t) => t.name)
    .filter((n): n is string => typeof n === 'string');
  assert.ok(names.length > 0, 'manifest.json lists no tools');
  return new Set(names);
}

test('every nextTool and every tool named in operator text is a registered tool', () => {
  // A nextTool the server does not register sends the model to call a tool
  // that does not exist — the one piece of advice it cannot act on at all.
  const registered = registeredToolNames();
  for (const row of ERROR_MATRIX) {
    if (row.nextTool !== undefined) {
      assert.ok(
        registered.has(row.nextTool),
        `${row.id}: nextTool ${row.nextTool} is not registered`,
      );
    }
    for (const named of row.operatorText.match(/\bfacebook_[a-z_]+/g) ?? []) {
      assert.ok(
        registered.has(named),
        `${row.id}: operator text names unregistered tool ${named}`,
      );
    }
  }
});

test('range rows never overlap one another (a first-wins overlap would hide a family)', () => {
  const ranges = ERROR_MATRIX.filter((r) => r.codeMax !== undefined);
  for (const [i, a] of ranges.entries()) {
    for (const b of ranges.slice(i + 1)) {
      const disjoint = (a.codeMax ?? a.code) < b.code || (b.codeMax ?? b.code) < a.code;
      assert.ok(disjoint, `range rows ${a.id} and ${b.id} overlap`);
    }
  }
});

test('an undocumented subcode under a family code falls back to that family, never to unknown', () => {
  // Meta adds subcodes under existing codes without notice; the lookup must keep
  // the family's advice (throttle stays a throttle, a policy block stays a block)
  // rather than dropping to `unknown` because the pair has no dedicated row.
  const UNSEEN = 987_654_321;
  const expected: readonly (readonly [number, string])[] = [
    [4, 'rate-4'],
    [17, 'rate-17'],
    [32, 'rate-32'],
    [613, 'rate-613'],
    [341, 'rate-341'],
    [80001, 'rate-buc'],
    [80099, 'rate-buc'],
    [368, 'blocked-368'],
    [100, 'validation-100'],
    [190, 'auth-190'],
    [200, 'permission-200'],
    [294, 'permission-2xx'],
    [10, 'permission-10'],
  ];
  for (const [code, id] of expected) {
    assert.equal(matchErrorRow(code, UNSEEN)?.id, id, `code ${code} + unseen subcode`);
  }
});
