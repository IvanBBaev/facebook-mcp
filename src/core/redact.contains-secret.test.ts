// `containsSecret` — the SEC-06 predicate `executeWrite` uses to refuse a
// payload that would carry a credential off the box (C08).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor } from './redact.js';

// Obviously-fake placeholders, the same style as redact.test.ts.
const TOKEN = 'hunter2-not-a-pattern-value';
const SPACED = 'two words & more';
const FAKE_EAA = 'EAAtestFAKE0123456789abcdefGHIJ';
const FAKE_APP_TOKEN = '1234567|0123456789abcdef0123456789abcdef';
const FAKE_32HEX = '0123456789abcdef0123456789abcdef';

test('a registered value is found anywhere in a payload, keys included', () => {
  const r = createRedactor({ secrets: [TOKEN] });
  assert.equal(r.containsSecret?.({ message: `post this: ${TOKEN}` }), true);
  assert.equal(r.containsSecret?.({ a: [{ b: TOKEN }] }), true);
  assert.equal(r.containsSecret?.({ [TOKEN]: 'x' }), true);
  assert.equal(r.containsSecret?.(TOKEN), true);
});

test('a runtime-registered secret is found in any of its wire forms', () => {
  const r = createRedactor();
  assert.equal(r.containsSecret?.({ link: encodeURIComponent(SPACED) }), false);
  r.addSecret(SPACED);
  assert.equal(
    r.containsSecret?.({ link: `https://x.test/?q=${encodeURIComponent(SPACED)}` }),
    true,
  );
});

test('token-shaped values are refused even when not registered', () => {
  const r = createRedactor();
  assert.equal(r.containsSecret?.({ message: FAKE_EAA }), true);
  assert.equal(r.containsSecret?.({ message: `creds ${FAKE_APP_TOKEN}` }), true);
});

test('ordinary write payloads, bare hex ids included, are not secrets', () => {
  const r = createRedactor({ secrets: [TOKEN] });
  assert.equal(
    r.containsSecret?.({
      image_hash: FAKE_32HEX,
      message: 'Hello world',
      count: 3,
      when: new Date(0),
      bytes: new Uint8Array([1, 2]),
      none: null,
    }),
    false,
  );
});

test('a cycle is walked once; a payload deeper than the walk fails closed', () => {
  const r = createRedactor({ secrets: [TOKEN] });
  const cyclic: Record<string, unknown> = { message: 'hi' };
  cyclic.self = cyclic;
  assert.equal(r.containsSecret?.(cyclic), false);

  let deep: Record<string, unknown> = { leaf: 'hi' };
  for (let i = 0; i < 250; i += 1) deep = { next: deep };
  assert.equal(r.containsSecret?.(deep), true);
});
