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

test('C3: an own `__proto__` field survives redaction instead of being swallowed', () => {
  // Redaction is the choke-point EVERY record passes through — logs, tool
  // results, error payloads. `JSON.parse` makes `__proto__` an own enumerable
  // property, so a Graph node carrying one reaches the key loop, where a plain
  // `objCopy[key] = ...` runs the inherited setter: the scrubbed value never
  // lands and the field vanishes from the record an operator has to read. A
  // string value is dropped outright; an object value re-parents the copy, so
  // the subtree disappears from the serialised line too.
  const r = createRedactor({ secrets: [TOKEN] });
  const out = r.redact(JSON.parse(`{"__proto__":"${TOKEN}","other":"keep"}`)) as Record<
    string,
    unknown
  >;
  assert.equal(
    Object.getPrototypeOf(out),
    Object.prototype,
    'copy must keep its prototype',
  );
  assert.equal(out.other, 'keep');
  assert.deepEqual(Object.keys(out).sort(), ['__proto__', 'other']);
  assert.equal(out['__proto__'], '[REDACTED]', 'the field must survive, scrubbed');
});

test('C3: an own `__proto__` on an Error payload survives redaction too', () => {
  const r = createRedactor();
  const err = new Error('boom');
  Object.defineProperty(err, '__proto__', {
    value: 'tenant-a',
    writable: true,
    enumerable: true,
    configurable: true,
  });
  const out = r.redact(err) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(out.message, 'boom');
  assert.equal(out['__proto__'], 'tenant-a');
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

test('pattern backup masks a URL-encoded {app-id}|{app-secret} pipe form', () => {
  const r = createRedactor(); // no registered secrets — the pattern path only
  // A composite app access token that has travelled through a URL arrives with
  // its pipe percent-encoded. `%7C` ends in a word character, so the 32-hex
  // backup pattern cannot see the secret half either: left unhandled, the WHOLE
  // app secret survives into the log line.
  const encoded = encodeURIComponent(FAKE_APP_ACCESS);
  assert.equal(r.redactString(`app=${encoded}`), 'app=[REDACTED]');
  assert.equal(r.redactString(`app=${encoded.toLowerCase()}`), 'app=[REDACTED]');
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

// --- The wire forms a secret takes on its way out ------------------------
//
// The header calls value-based redaction the strategy with "no false
// negatives". That is only true while the secret reaches the log line spelled
// exactly the way it was registered. `FB_HTTP_TOKEN` and `FB_CONFIRM_TOKEN` are
// operator-chosen — a random bearer token is naturally base64, i.e. `+`, `/`
// and `=` — and both travel through URLs and JSON on their way to somewhere a
// human will read them. An exact-string match sees none of those forms.

test('a registered secret is still masked after encodeURIComponent', () => {
  const secret = 'p+aS/sw0rd=abc';
  const r = createRedactor({ secrets: [secret] });
  const out = r.redactString(`GET /mcp?tok=${encodeURIComponent(secret)}`);
  assert.ok(
    !out.includes('p%2BaS%2Fsw0rd%3Dabc'),
    `percent-encoded secret survived: ${out}`,
  );
  assert.equal(out, 'GET /mcp?tok=[REDACTED]');
});

test('a registered secret is still masked after form encoding', () => {
  // `application/x-www-form-urlencoded` spells a space `+`, not `%20`, so the
  // percent-encoded form alone does not cover a secret containing one.
  const secret = 'two words here';
  const r = createRedactor({ secrets: [secret] });
  const body = new URLSearchParams([['tok', secret]]).toString();
  const out = r.redactString(body);
  assert.ok(!out.includes('two+words+here'), `form-encoded secret survived: ${out}`);
  assert.equal(out, 'tok=[REDACTED]');
});

test('a registered secret is still masked inside a JSON string', () => {
  // The journal is NDJSON and log lines are JSON: a secret carrying a quote,
  // a backslash or a newline arrives escaped, and no longer matches itself.
  const secret = 'he said "hi"\\then\nnewline';
  const r = createRedactor({ secrets: [secret] });
  const out = r.redactString(JSON.stringify({ token: secret }));
  assert.ok(!out.includes('\\"hi\\"'), `JSON-escaped secret survived: ${out}`);
  assert.equal(out, '{"token":"[REDACTED]"}');
});

// --- Totality of the walk -------------------------------------------------

test('the redacted clone stays JSON-safe when a BigInt leaf is present', () => {
  // The header promises a JSON-safe clone, and the journal takes that at its
  // word. `JSON.stringify` REFUSES a BigInt outright, so one such leaf does not
  // degrade the record — it destroys it, and the write goes unlogged.
  const r = createRedactor({ secrets: [TOKEN] });
  const clone = r.redact({ id: 10n, ok: true });
  assert.doesNotThrow(() => JSON.stringify(clone));
  assert.deepEqual(clone, { id: '10', ok: true });
});

test('a payload deeper than the walk can recurse is truncated, not thrown', () => {
  // `JSON.parse` happily accepts nesting four thousand deep; the scrubber
  // behind it dies at a fraction of that. The parser must never be the more
  // permissive of the two, or a body the server already accepted takes the log
  // line down with a RangeError instead of being written.
  const r = createRedactor();
  const deepJson = '{"n":'.repeat(4000) + '1' + '}'.repeat(4000);
  const parsed: unknown = JSON.parse(deepJson);
  let clone: unknown;
  assert.doesNotThrow(() => {
    clone = r.redact(parsed);
  });
  assert.doesNotThrow(() => JSON.stringify(clone));
});

test('a throwing accessor cannot take the rest of the log line down with it', () => {
  // One broken getter should cost its own key and nothing more. Redaction runs
  // ON the error path, so a throw here replaces the failure the operator needed
  // to read with a failure from the machinery that was meant to report it.
  const r = createRedactor({ secrets: [TOKEN] });
  const hostile = {
    before: `tok=${TOKEN}`,
    get boom(): never {
      throw new Error('getter exploded');
    },
    after: 'still here',
  };
  let clone: Record<string, unknown> = {};
  assert.doesNotThrow(() => {
    clone = r.redact({ payload: hostile }) as Record<string, unknown>;
  });
  const payload = clone.payload as Record<string, unknown>;
  assert.equal(payload.before, 'tok=[REDACTED]');
  assert.equal(payload.after, 'still here');
  assert.ok(typeof payload.boom === 'string', 'the unreadable key is kept as a marker');
});

// --- Regression pins (wave 10) --------------------------------------------

test('a registered secret full of regex metacharacters is matched literally', () => {
  // The value path builds a RegExp out of the secret; without escaping, a
  // bearer such as `a.b*c(d)|e[f]$` would either throw or match `abc`.
  const secret = 'a.b*c(d)|e[f]$';
  const r = createRedactor({ secrets: [secret] });
  assert.equal(r.redactString(`tok=${secret}&x=1`), 'tok=[REDACTED]&x=1');
  assert.equal(
    r.redactString('tok=abbbc(d) e[f]'),
    'tok=abbbc(d) e[f]',
    'no wildcard match',
  );
});

test('leaf object types are not walked: Date copied, binary by reference, Map/Set degrade', () => {
  const r = createRedactor({ secrets: [TOKEN] });
  const when = new Date('2026-01-02T03:04:05.000Z');
  const bytes = Buffer.from(`raw ${TOKEN}`);
  const input = {
    when,
    bytes,
    map: new Map([['k', TOKEN]]),
    set: new Set([TOKEN]),
  };
  const out = r.redact(input) as Record<string, unknown>;
  assert.ok(out.when instanceof Date && out.when !== when, 'Date is copied, not shared');
  assert.equal(out.when.toISOString(), when.toISOString());
  assert.equal(
    out.bytes,
    bytes,
    'binary is returned by reference (documented, unscanned)',
  );
  assert.deepEqual(out.map, {}, 'a Map degrades to its own enumerable entries: none');
  assert.deepEqual(out.set, {}, 'a Set degrades to its own enumerable entries: none');
  assert.doesNotThrow(() => JSON.stringify(out));
});

test('a shared (non-cyclic) node is scrubbed at every reference, never marked circular', () => {
  // The walk tracks ANCESTORS, not visited nodes: the same `from` object hung
  // off two comments must come out scrubbed twice. (The test fake diverges
  // here — it returns the raw object on the second visit — so this pin lives
  // against the real redactor only.)
  const r = createRedactor({ secrets: [TOKEN] });
  const from = { note: `by ${TOKEN}` };
  const out = r.redact({ a: { from }, b: { from } }) as {
    a: { from: { note: string } };
    b: { from: { note: string } };
  };
  assert.equal(out.a.from.note, 'by [REDACTED]');
  assert.equal(out.b.from.note, 'by [REDACTED]');
});

// --- Wave 11 -----------------------------------------------------------------

test('an own toJSON cannot smuggle a registered secret past the scrub', () => {
  // The clone used to copy a function-valued `toJSON` by reference, and
  // `JSON.stringify` then called it on the clone: whatever it returned reached
  // the log line / journal without ever passing the scrub.
  const r = createRedactor({ secrets: [TOKEN] });
  const out = r.redact({ field: { toJSON: () => `bearer ${TOKEN}` } });
  const line = JSON.stringify(out);
  assert.ok(!line.includes(TOKEN), `secret leaked through toJSON: ${line}`);
  assert.equal(line, '{"field":"bearer [REDACTED]"}');
});

test('an inherited toJSON is honoured, so a URL is logged as its scrubbed href', () => {
  // A class instance with a prototype serializer (URL) used to degrade to its
  // own enumerable entries — none — and reach the operator as `{}`.
  const r = createRedactor({ secrets: [TOKEN] });
  const out = r.redact({
    url: new URL(`https://graph.facebook.com/me?access_token=${TOKEN}`),
  });
  assert.deepEqual(out, { url: 'https://graph.facebook.com/me?access_token=[REDACTED]' });
});

test('a toJSON that throws costs its own value, not the whole record', () => {
  const r = createRedactor({ secrets: [TOKEN] });
  let out: unknown;
  assert.doesNotThrow(() => {
    out = r.redact({
      ok: TOKEN,
      bad: {
        toJSON(): never {
          throw new Error('refuses');
        },
      },
    });
  });
  assert.deepEqual(out, { ok: '[REDACTED]', bad: '[UNREADABLE]' });
  assert.doesNotThrow(() => JSON.stringify(out));
});

test('an Error with a non-string name or a throwing message accessor does not make redact throw', () => {
  const r = createRedactor({ secrets: [TOKEN] });
  const numericName = Object.assign(new Error(`failed ${TOKEN}`), { name: 42 });
  const hostileMessage = new Error('placeholder');
  Object.defineProperty(hostileMessage, 'message', {
    get(): never {
      throw new Error('message getter exploded');
    },
  });
  let a: Record<string, unknown> = {};
  let b: Record<string, unknown> = {};
  assert.doesNotThrow(() => {
    a = r.redact(numericName) as Record<string, unknown>;
  });
  assert.doesNotThrow(() => {
    b = r.redact(hostileMessage) as Record<string, unknown>;
  });
  assert.equal(a.name, 42);
  assert.equal(a.message, 'failed [REDACTED]');
  assert.equal(b.message, '[UNREADABLE]');
  assert.equal(b.name, 'Error');
});

test('an AggregateError keeps its inner errors (the per-address connect failures)', () => {
  // Node's happy-eyeballs connect rejects `fetch` with an AggregateError whose
  // `errors` is an own NON-enumerable property; the copy used to drop it.
  const r = createRedactor({ secrets: [TOKEN] });
  const agg = new AggregateError(
    [new Error('connect ECONNREFUSED ::1:443'), new Error(`bad ${TOKEN}`)],
    '',
  );
  const out = r.redact(new TypeError('fetch failed', { cause: agg })) as {
    cause: { errors?: Array<{ message: string }> };
  };
  assert.deepEqual(
    out.cause.errors?.map((e) => e.message),
    ['connect ECONNREFUSED ::1:443', 'bad [REDACTED]'],
  );
});

test('pattern backup masks a hex secret that follows a percent-escape (double-encoded query)', () => {
  const r = createRedactor(); // no registered secrets — the pattern path only
  // A query string carried INSIDE another URL or a form-encoded Graph batch body
  // spells `=` as `%3D`. `3D` is itself hex, so the secret no longer starts at a
  // word boundary: the 64-hex proof becomes a 66-hex run and the 32-hex secret a
  // 34-hex run, and neither backup pattern fired — the whole value leaked.
  const batch = new URLSearchParams([
    ['batch', `[{"relative_url":"me?appsecret_proof=${FAKE_64HEX}&x=${FAKE_32HEX}"}]`],
  ]).toString();
  const out = r.redactString(batch);
  assert.ok(!out.includes(FAKE_64HEX), `proof leaked: ${out}`);
  assert.ok(!out.includes(FAKE_32HEX), `secret leaked: ${out}`);
  assert.equal(r.redactString(`next=a%3Fs%3D${FAKE_32HEX}`), 'next=a%3Fs%3D[REDACTED]');
  // The composite app access token behind a `%3D` collapses as one unit too.
  assert.equal(
    r.redactString(`u=x%3Faccess_token%3D${encodeURIComponent(FAKE_APP_ACCESS)}`),
    'u=x%3Faccess_token%3D[REDACTED]',
  );
});

test('pattern backup masks a hex secret that follows a JSON escape in already-serialised text', () => {
  const r = createRedactor();
  // A raw JSON body (a Graph error text, an NDJSON line) spells a newline `\n`
  // and a control char `\u00XX`; the escape ends in a word character, so the
  // hex that follows it was not at a word boundary and survived the scan.
  assert.equal(r.redactString(`"secret:\\n${FAKE_32HEX}"`), '"secret:\\n[REDACTED]"');
  assert.equal(r.redactString(`"p\\u0009${FAKE_64HEX}"`), '"p\\u0009[REDACTED]"');
});

test('an array element whose accessor throws costs that element, not the whole record', () => {
  const r = createRedactor({ secrets: [TOKEN] });
  const arr: unknown[] = [`a ${TOKEN}`, 'placeholder', 'c'];
  Object.defineProperty(arr, 1, {
    enumerable: true,
    get() {
      throw new Error('index getter exploded');
    },
  });
  let out: unknown;
  assert.doesNotThrow(() => {
    out = r.redact({ list: arr, keep: TOKEN });
  });
  assert.deepEqual(out, {
    list: ['a [REDACTED]', '[UNREADABLE]', 'c'],
    keep: '[REDACTED]',
  });
});
