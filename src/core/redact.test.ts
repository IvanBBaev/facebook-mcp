import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor } from './redact.js';

// Obviously-fake placeholder secrets. NON-pattern-shaped values are used to
// isolate the value-based strategy from the defensive pattern scan.
const TOKEN = 'hunter2-not-a-pattern-value';
const APP_SECRET = 'swordfish-app-secret-value';
const HTTP_TOKEN = 'correct-horse-battery-http';

// Fake pattern-shaped strings that are NOT registered — exercised only by the
// defense-in-depth pattern scan.
const FAKE_EAA = 'EAAtestFAKE0123456789abcdefGHIJ'; // EAA + 28 chars (>= 20)
const FAKE_32HEX = '0123456789abcdef0123456789abcdef'; // 32 hex
const FAKE_64HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // 64 hex
const FAKE_APP_ACCESS = '123456789012345|0123456789abcdef0123456789abcdef'; // {app-id}|{32-hex}

// --- Value-based (primary) ------------------------------------------------

test('redactString masks every occurrence of a registered secret VALUE', () => {
  const r = createRedactor({ secrets: [TOKEN] });
  const out = r.redactString(`a=${TOKEN}&b=${TOKEN}`);
  assert.equal(out, 'a=[REDACTED]&b=[REDACTED]');
});

test('value-based scrubbing has no false negatives across secret classes', () => {
  const r = createRedactor({ secrets: [TOKEN, APP_SECRET, HTTP_TOKEN] });
  const line = `token=${TOKEN} secret=${APP_SECRET} http=${HTTP_TOKEN}`;
  const out = r.redactString(line);
  assert.ok(!out.includes(TOKEN));
  assert.ok(!out.includes(APP_SECRET));
  assert.ok(!out.includes(HTTP_TOKEN));
  assert.equal(out, 'token=[REDACTED] secret=[REDACTED] http=[REDACTED]');
});

test('C3: an access_token embedded in a paging-style URL value is scrubbed', () => {
  const r = createRedactor({ secrets: [TOKEN] });
  const payload = {
    data: [{ id: '1' }],
    paging: {
      next: `https://graph.facebook.com/v20.0/me/feed?access_token=${TOKEN}&after=X`,
    },
  };
  const out = r.redact(payload) as typeof payload;
  assert.ok(!JSON.stringify(out).includes(TOKEN));
  assert.ok(out.paging.next.includes('[REDACTED]'));
});

test('addSecret registers a runtime-derived secret (C1 per-Page token)', () => {
  const r = createRedactor();
  const derived = 'per-page-token-derived-after-startup';
  assert.equal(r.redactString(derived), derived); // not yet known
  r.addSecret(derived);
  assert.equal(r.redactString(derived), '[REDACTED]');
});

test('empty / whitespace secrets are ignored (never blank the whole string)', () => {
  const r = createRedactor({ secrets: ['', '   '] });
  r.addSecret('');
  assert.equal(r.redactString('untouched text here'), 'untouched text here');
});

test('longest-first ordering collapses a composite secret cleanly', () => {
  // The 32-hex app secret is a substring of the app-access-token; registering
  // both must not leave a half-masked fragment.
  const appSecret = 'abcdef0123456789abcdef0123456789';
  const appAccess = `987654321098765|${appSecret}`;
  const r = createRedactor({ secrets: [appSecret, appAccess] });
  assert.equal(r.redactString(`t=${appAccess}`), 't=[REDACTED]');
});

// --- Deep structural scrub ------------------------------------------------

test('redact deep-scrubs strings, values, keys, and array elements', () => {
  const r = createRedactor({ secrets: [TOKEN, APP_SECRET] });
  const input = {
    note: `bearer ${TOKEN}`,
    nested: { proof: APP_SECRET, list: [TOKEN, 'clean'] },
    [TOKEN]: 'value-under-secret-key',
  };
  const out = r.redact(input) as Record<string, unknown>;
  assert.equal(out.note, 'bearer [REDACTED]');
  const nested = out.nested as { proof: string; list: string[] };
  assert.equal(nested.proof, '[REDACTED]');
  assert.deepEqual(nested.list, ['[REDACTED]', 'clean']);
  assert.equal(out['[REDACTED]'], 'value-under-secret-key');
});

test('non-string primitives pass through untouched', () => {
  const r = createRedactor({ secrets: [TOKEN] });
  assert.equal(r.redact(42), 42);
  assert.equal(r.redact(true), true);
  assert.equal(r.redact(null), null);
  assert.equal(r.redact(undefined), undefined);
});

test('inputs are never mutated; a fresh clone is returned', () => {
  const r = createRedactor({ secrets: [TOKEN] });
  const input = { a: `x ${TOKEN}`, b: [{ c: TOKEN }] };
  const snapshot = structuredClone(input);
  const out = r.redact(input);
  assert.notEqual(out, input);
  assert.deepEqual(input, snapshot); // original untouched
});

test('reference cycles are broken with a marker (output stays JSON-safe)', () => {
  const r = createRedactor({ secrets: [TOKEN] });
  const cyclic: Record<string, unknown> = { token: TOKEN };
  cyclic.self = cyclic;
  const out = r.redact(cyclic) as Record<string, unknown>;
  assert.equal(out.token, '[REDACTED]');
  assert.equal(out.self, '[CIRCULAR]');
  assert.doesNotThrow(() => JSON.stringify(out));
});

test('Error objects are scrubbed including the non-enumerable message', () => {
  const r = createRedactor({ secrets: [TOKEN] });
  const err = new Error(`auth failed for ${TOKEN}`);
  const out = r.redact({ err }) as { err: { name: string; message: string } };
  assert.equal(out.err.name, 'Error');
  assert.equal(out.err.message, 'auth failed for [REDACTED]');
  assert.ok(!JSON.stringify(out).includes(TOKEN));
});

// --- Pattern scan (defense-in-depth backup only) --------------------------

test('pattern backup masks an unregistered EAA-prefixed token', () => {
  const r = createRedactor(); // no registered secrets
  assert.equal(r.redactString(`t=${FAKE_EAA}`), 't=[REDACTED]');
});

test('pattern backup masks unregistered 32-hex secret and 64-hex proof', () => {
  const r = createRedactor();
  assert.equal(r.redactString(`s=${FAKE_32HEX}`), 's=[REDACTED]');
  assert.equal(r.redactString(`p=${FAKE_64HEX}`), 'p=[REDACTED]');
});

test('pattern backup masks the {app-id}|{app-secret} pipe form as one unit', () => {
  const r = createRedactor();
  assert.equal(r.redactString(`app=${FAKE_APP_ACCESS}`), 'app=[REDACTED]');
});

test('pattern scan does not over-mask ordinary short hex / text', () => {
  const r = createRedactor();
  const benign = 'trace=abc123 id=deadbeef status=ok'; // 8-hex, not 32/64
  assert.equal(r.redactString(benign), benign);
});

// --- Config ---------------------------------------------------------------

test('a custom placeholder is honored', () => {
  const r = createRedactor({ secrets: [TOKEN], placeholder: '***' });
  assert.equal(r.redactString(TOKEN), '***');
});
