// Structural invariants for the error -> action MATRIX (task F06, data half).
//
// These tests guard the TABLE as data: they freeze its membership (ids + count),
// prove the rows are well-formed and non-overlapping, and check the cross-field
// invariants the classifier in `./errors.ts` relies on (every category is a real
// ErrorCategory; ranges are ordered; honor-ETA rows carry a default). The full
// per-row behavioural snapshot lives in `./errors.test.ts`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ErrorCategory } from './index.js';
import {
  DEFAULT_THROTTLE_RETRY_AFTER_MS,
  ERROR_MATRIX,
  ETA_MINUTES_TO_MS,
} from './error-matrix.js';

// Frozen membership: the exact ids, in order. Adding/removing/renaming a row is a
// visible diff here (and in the behavioural snapshot). Count is asserted too so a
// duplicate id cannot sneak the length up while the list still "looks" right.
const EXPECTED_IDS = [
  'auth-190-460',
  'auth-190-463',
  'auth-190-467',
  'auth-190',
  'auth-102',
  'auth-460',
  'auth-463',
  'auth-467',
  'blocked-368',
  'permission-200',
  'permission-10',
  'permission-803',
  'rate-4',
  'rate-17',
  'rate-32',
  'rate-613',
  'rate-buc',
  'duplicate-506',
  'not-found-100-33',
  'validation-100',
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

test('honor-ETA rows carry the default surfaced retry-after (so an ETA-less throttle still hints)', () => {
  for (const r of ERROR_MATRIX) {
    if (!r.honorEta) continue;
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

test('ETA_MINUTES_TO_MS converts minutes to milliseconds', () => {
  assert.equal(ETA_MINUTES_TO_MS, 60_000);
});
