// Tests for the MCP result shaper (F12): structural token/paging strip
// (C3 / CC-PAGE-4), structure-aware truncation (CC-MCP-4), the server-owned
// envelope / structuredContent path (CC-MCP-7), and cycle safety.
//
// Placeholder tokens only — never a real secret in a fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor } from '../core/index.js';
import { createFakeRedactor } from '../core/fakes/index.js';
import { shapeResult, shapeEnvelope, stripPagingAndTokens } from './result.js';

// A syntactically EAA-shaped placeholder — long enough to trip the redactor's
// pattern scan, but obviously fake.
const FAKE_TOKEN = 'EAAtestPlaceholderToken0123456789';
const BIG_BUDGET = 1_000_000;

function parseObj(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

test('strips nested paging + neutralizes access_token recursively (CC-PAGE-4 / C3)', () => {
  const redactor = createFakeRedactor({ secrets: [FAKE_TOKEN] });
  const payload = {
    data: [
      {
        id: '1',
        // A registered secret in an ordinary field — must be value-redacted.
        message: `ping ${FAKE_TOKEN} pong`,
        comments: {
          data: [{ id: 'c1', text: 'hi' }],
          // Nested field-expansion paging carrying the live token.
          paging: {
            next: `https://graph.facebook.com/v19.0/1/comments?after=abc&access_token=${FAKE_TOKEN}`,
            cursors: { after: 'abc', before: 'xyz' },
          },
        },
      },
    ],
    // Top-level paging carrying the live token.
    paging: {
      next: `https://graph.facebook.com/v19.0/me/feed?access_token=${FAKE_TOKEN}`,
      previous: `https://graph.facebook.com/v19.0/me/feed?access_token=${FAKE_TOKEN}`,
    },
  };

  const result = shapeResult(payload, { maxResultChars: BIG_BUDGET, redactor });
  const text = result.content[0]?.text ?? '';

  // Structural strip: no paging objects survive anywhere.
  assert.equal(text.includes('paging'), false, 'paging keys removed');
  assert.equal(text.includes('access_token'), false, 'no access_token= survives');
  // Value redaction ran as the choke-point: the registered secret is gone.
  assert.equal(text.includes(FAKE_TOKEN), false, 'raw token never leaves the process');
  assert.equal(redactor.calls.length, 1, 'the injected redactor was the final pass');

  // Payload data is otherwise intact and valid JSON.
  const parsed = parseObj(text);
  const data = parsed.data;
  assert.ok(Array.isArray(data));
  const first = data[0] as {
    id: string;
    message: string;
    comments: Record<string, unknown>;
  };
  assert.equal(first.id, '1');
  assert.equal(first.message, 'ping [REDACTED] pong', 'secret value redacted in place');
  assert.equal('paging' in first.comments, false, 'nested paging dropped');
  assert.ok(Array.isArray(first.comments.data), 'nested edge data preserved');
});

test('token-bearing URL outside paging is neutralized (C3)', () => {
  // Real redactor, no registered secrets: prove the STRUCTURAL strip alone kills
  // the token inside a non-paging URL field.
  const redactor = createRedactor();
  const payload = {
    link: `https://example.test/x?foo=1&access_token=${FAKE_TOKEN}&bar=2`,
  };

  const result = shapeResult(payload, { maxResultChars: BIG_BUDGET, redactor });
  const text = result.content[0]?.text ?? '';

  assert.equal(text.includes(FAKE_TOKEN), false, 'token stripped from the URL');
  const parsed = parseObj(text);
  const link = parsed.link;
  assert.equal(typeof link, 'string');
  assert.ok((link as string).includes('access_token=[STRIPPED_TOKEN]'));
  assert.ok((link as string).includes('foo=1'), 'non-secret query params preserved');
  assert.ok((link as string).includes('bar=2'));
});

test('a field literally named access_token is neutralized (C3)', () => {
  const redactor = createRedactor();
  const payload = { debug: { access_token: FAKE_TOKEN, scopes: ['pages_show_list'] } };
  const result = shapeResult(payload, { maxResultChars: BIG_BUDGET, redactor });
  const text = result.content[0]?.text ?? '';
  assert.equal(text.includes(FAKE_TOKEN), false);
  const parsed = parseObj(text);
  const debug = parsed.debug as { access_token: string; scopes: string[] };
  assert.equal(debug.access_token, '[STRIPPED_TOKEN]');
  assert.deepEqual(debug.scopes, ['pages_show_list']);
});

test('over-budget payload is truncated to valid JSON with a note (CC-MCP-4)', () => {
  const redactor = createFakeRedactor();
  const payload = {
    data: Array.from({ length: 500 }, (_v, i) => ({
      id: String(i),
      text: 'x'.repeat(20),
    })),
  };
  const budget = 2_000;

  const result = shapeResult(payload, { maxResultChars: budget, redactor });
  const text = result.content[0]?.text ?? '';

  assert.ok(
    text.length <= budget,
    `within budget (${String(text.length)} <= ${String(budget)})`,
  );
  assert.equal(text.includes('\n'), false, 'compact JSON, no whitespace');

  // Valid JSON, structurally truncated (not a mid-string slice).
  const parsed = parseObj(text);
  const data = parsed.data;
  assert.ok(Array.isArray(data));
  assert.ok(data.length > 0 && data.length < 500, 'array trimmed, prefix kept');
  const first = data[0] as { id: string };
  assert.equal(first.id, '0', 'kept the FIRST items');

  const note = parsed._truncation;
  assert.equal(typeof note, 'string');
  assert.ok((note as string).includes('truncated'));
  assert.ok((note as string).includes('list item'));
});

test('a payload within budget is rendered compact and text-only (CC-MCP-7)', () => {
  const redactor = createFakeRedactor();
  const result = shapeResult(
    { a: 1, b: ['x'] },
    { maxResultChars: BIG_BUDGET, redactor },
  );
  assert.equal(result.content[0]?.text, '{"a":1,"b":["x"]}');
  assert.equal(result.structuredContent, undefined, 'ordinary results are text-only');
  assert.equal(result.isError, undefined);
});

test('server-owned envelope carries structuredContent, un-truncated (CC-MCP-7)', () => {
  const redactor = createFakeRedactor({ secrets: [FAKE_TOKEN] });
  const envelope = {
    ok: true,
    page: { id: '123', name: 'Brand Page' },
    scopes: ['pages_manage_posts', 'pages_read_engagement'],
    // Defense in depth: even a server envelope gets the token strip + redaction.
    access_token: FAKE_TOKEN,
  };

  const result = shapeEnvelope(envelope, { maxResultChars: BIG_BUDGET, redactor });

  assert.ok(result.structuredContent, 'envelope exposes structuredContent');
  const sc = result.structuredContent;
  assert.equal(sc.ok, true);
  assert.equal(
    sc.access_token,
    '[STRIPPED_TOKEN]',
    'token field stripped in structuredContent',
  );
  assert.deepEqual(sc.page, { id: '123', name: 'Brand Page' });

  // The text mirror is the compact JSON of the same structured object.
  assert.equal(result.content[0]?.text, JSON.stringify(sc));
  assert.equal(result.content[0]?.text.includes(FAKE_TOKEN), false);
});

test('cycle-safe input does not hang', () => {
  // Direct strip: a self-referential object collapses the back-edge.
  const cyclic: Record<string, unknown> = { name: 'root' };
  cyclic.self = cyclic;
  const stripped = stripPagingAndTokens(cyclic) as { name: string; self: unknown };
  assert.equal(stripped.name, 'root');
  assert.equal(stripped.self, '[CIRCULAR]');

  // Full pipeline over the same input still terminates and yields valid JSON.
  const redactor = createFakeRedactor();
  const result = shapeResult(cyclic, { maxResultChars: BIG_BUDGET, redactor });
  const parsed = parseObj(result.content[0]?.text ?? '');
  assert.equal(parsed.name, 'root');
  assert.equal(parsed.self, '[CIRCULAR]');
});

test('the input payload is never mutated', () => {
  const redactor = createFakeRedactor({ secrets: [FAKE_TOKEN] });
  const payload = {
    message: `hi ${FAKE_TOKEN}`,
    paging: { next: `https://x/y?access_token=${FAKE_TOKEN}` },
    data: [{ id: '1' }],
  };
  const snapshot = structuredClone(payload);
  shapeResult(payload, { maxResultChars: 10, redactor });
  assert.deepEqual(payload, snapshot, 'strip/redact/truncate operate on clones');
});

test('isError flag propagates to the ToolResult', () => {
  const redactor = createFakeRedactor();
  const result = shapeResult(
    { error: 'boom' },
    {
      maxResultChars: BIG_BUDGET,
      redactor,
      isError: true,
    },
  );
  assert.equal(result.isError, true);
});
