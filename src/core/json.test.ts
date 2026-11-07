import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import {
  asArray,
  asRecord,
  intOr,
  isRecord,
  numOr,
  parseJsonSafe,
  strOr,
} from './json.js';

// Values of every JSON-ish shape, so each helper is checked against all of them.
const NON_RECORDS: readonly unknown[] = [
  undefined,
  null,
  0,
  1.5,
  Number.NaN,
  '',
  'x',
  true,
  false,
  [],
  [1, 2],
  () => 1,
  Symbol('s'),
  10n,
];

test('isRecord accepts plain objects and rejects null, arrays and primitives', () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord(Object.create(null)), true);
  for (const value of NON_RECORDS) {
    assert.equal(isRecord(value), false, `isRecord(${inspect(value)})`);
  }
});

test('asRecord returns the same object, or undefined for a non-record', () => {
  const obj = { id: '1' };
  assert.equal(asRecord(obj), obj);
  for (const value of NON_RECORDS) {
    assert.equal(asRecord(value), undefined, `asRecord(${inspect(value)})`);
  }
});

test('asArray returns the same array, or undefined for a non-array', () => {
  const arr = [1, 'a', null];
  assert.equal(asArray(arr), arr);
  assert.deepEqual(asArray([]), []);
  for (const value of [undefined, null, 0, '', 'abc', {}, { length: 1, 0: 'a' }]) {
    assert.equal(asArray(value), undefined);
  }
});

test('numOr keeps finite numbers only and never coerces', () => {
  assert.equal(numOr(0), 0);
  assert.equal(numOr(-3), -3);
  assert.equal(numOr(1.5), 1.5);
  for (const value of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    '12',
    '',
    null,
    undefined,
    true,
    {},
    [1],
    10n,
  ]) {
    assert.equal(numOr(value), undefined, `numOr(${inspect(value)})`);
  }
});

test('intOr accepts safe integers and exact integer strings', () => {
  assert.equal(intOr(190), 190);
  assert.equal(intOr(0), 0);
  assert.equal(intOr(-1), -1);
  assert.equal(intOr('190'), 190);
  assert.equal(intOr('-1'), -1);
  assert.equal(intOr('0'), 0);
});

test('intOr rejects fractions, padded or exponent strings and unsafe integers', () => {
  for (const value of [
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    ' 190',
    '190 ',
    '1.5',
    '1e3',
    '+1',
    '',
    '-',
    '99999999999999999999',
    null,
    undefined,
    true,
    {},
    [190],
  ]) {
    assert.equal(intOr(value), undefined, `intOr(${inspect(value)})`);
  }
});

test('strOr keeps strings, including the empty string, and never stringifies', () => {
  assert.equal(strOr('abc'), 'abc');
  assert.equal(strOr(''), '');
  for (const value of [0, 12, true, null, undefined, {}, ['a'], 10n]) {
    assert.equal(strOr(value), undefined, `strOr(${inspect(value)})`);
  }
});

test('parseJsonSafe parses valid JSON of every shape', () => {
  assert.deepEqual(parseJsonSafe('{"a":[1,"b"]}'), { a: [1, 'b'] });
  assert.deepEqual(parseJsonSafe('[1,2]'), [1, 2]);
  assert.equal(parseJsonSafe('"s"'), 's');
  assert.equal(parseJsonSafe('42'), 42);
  assert.equal(parseJsonSafe('true'), true);
  assert.equal(parseJsonSafe(' null '), null);
});

test('parseJsonSafe returns undefined for invalid JSON instead of throwing', () => {
  for (const text of ['', ' ', '{', '{"a":1', 'undefined', "{'a':1}", '<html>', 'NaN']) {
    assert.equal(
      parseJsonSafe(text),
      undefined,
      `parseJsonSafe(${JSON.stringify(text)})`,
    );
  }
});

test('the helpers compose to read a nested untrusted payload', () => {
  const body = parseJsonSafe(
    '{"error":{"code":"190","error_subcode":463,"message":"expired"},"data":[{"id":"1"}]}',
  );
  const error = asRecord(asRecord(body)?.['error']);
  assert.equal(intOr(error?.['code']), 190);
  assert.equal(intOr(error?.['error_subcode']), 463);
  assert.equal(strOr(error?.['message']), 'expired');
  const first = asRecord(asArray(asRecord(body)?.['data'])?.[0]);
  assert.equal(strOr(first?.['id']), '1');
  assert.equal(numOr(asRecord(body)?.['missing']), undefined);
});
