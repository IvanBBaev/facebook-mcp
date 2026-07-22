import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeRedactor } from './fakeRedactor.js';

const TOKEN = 'EAABsecrettoken123';
const PROOF = 'abcdef0123456789';

test('redactString replaces every occurrence of a registered secret', () => {
  const r = createFakeRedactor({ secrets: [TOKEN] });
  const out = r.redactString(`url?access_token=${TOKEN}&x=${TOKEN}`);
  assert.equal(out, 'url?access_token=[REDACTED]&x=[REDACTED]');
  assert.deepEqual([...r.stringCalls], [`url?access_token=${TOKEN}&x=${TOKEN}`]);
});

test('redact deep-scrubs strings, values, keys, and array elements', () => {
  const r = createFakeRedactor({ secrets: [TOKEN, PROOF] });
  const input = {
    note: `bearer ${TOKEN}`,
    nested: { proof: PROOF, list: [TOKEN, 'clean'] },
    [TOKEN]: 'value-under-secret-key',
  };
  const out = r.redact(input) as Record<string, unknown>;

  assert.equal(out.note, 'bearer [REDACTED]');
  const nested = out.nested as { proof: string; list: string[] };
  assert.equal(nested.proof, '[REDACTED]');
  assert.deepEqual(nested.list, ['[REDACTED]', 'clean']);
  assert.equal(out['[REDACTED]'], 'value-under-secret-key');
  assert.equal(r.calls.length, 1);
});

test('addSecret registers runtime-derived secrets; empty values are ignored', () => {
  const r = createFakeRedactor();
  r.addSecret('');
  assert.deepEqual([...r.secrets], []);
  r.addSecret(TOKEN);
  r.addSecret(TOKEN); // dedup
  assert.deepEqual([...r.secrets], [TOKEN]);
  assert.equal(r.redactString(TOKEN), '[REDACTED]');
});

test('non-string primitives pass through untouched', () => {
  const r = createFakeRedactor({ secrets: [TOKEN] });
  assert.equal(r.redact(42), 42);
  assert.equal(r.redact(true), true);
  assert.equal(r.redact(null), null);
});

test('cyclic structures do not cause infinite recursion', () => {
  const r = createFakeRedactor({ secrets: [TOKEN] });
  const cyclic: Record<string, unknown> = { token: TOKEN };
  cyclic.self = cyclic;
  const out = r.redact(cyclic) as Record<string, unknown>;
  assert.equal(out.token, '[REDACTED]');
});

test('a custom placeholder is honored', () => {
  const r = createFakeRedactor({ secrets: [TOKEN], placeholder: '***' });
  assert.equal(r.redactString(TOKEN), '***');
});
