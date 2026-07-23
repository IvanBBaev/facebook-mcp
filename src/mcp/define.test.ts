// Tests for `defineTool` (task F11): strict-parse rejection, the annotation
// quadruple requirement, the writeTier↔readOnlyHint consistency invariant, and
// faithful ToolSpec construction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { defineTool } from './define.js';
import type { ToolAnnotations, ToolContext, ToolResult } from '../core/index.js';

// The handler never touches the context in these unit tests, so an empty stand-in
// typed as ToolContext is sufficient (the wrapper only parses + forwards).
const ctx = {} as ToolContext;

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

function ok(text = 'ok'): ToolResult {
  return { content: [{ type: 'text', text }] };
}

// ---------------------------------------------------------------------------
// Strict-parse: unknown keys rejected BEFORE the handler runs
// ---------------------------------------------------------------------------

test('defineTool forces .strict(): unknown keys reject before the handler runs', async () => {
  let handlerCalls = 0;
  const spec = defineTool({
    name: 'facebook_get_thing',
    description: 'read a thing',
    inputSchema: z.object({ id: z.string().describe('the id') }),
    annotations: READ_ONLY,
    handler: (input) => {
      handlerCalls += 1;
      return Promise.resolve(ok(input.id));
    },
  });

  // Extra key `extra` is rejected — the handler is never entered.
  await assert.rejects(
    spec.handler({ id: 'abc', extra: 'nope' }, ctx),
    (err: unknown) => err instanceof z.ZodError,
  );
  assert.equal(handlerCalls, 0);
});

test('defineTool parses valid input and forwards the typed value to the handler', async () => {
  const seen: unknown[] = [];
  const spec = defineTool({
    name: 'facebook_get_thing',
    description: 'read a thing',
    inputSchema: z.object({ id: z.string(), limit: z.number().default(10) }),
    annotations: READ_ONLY,
    handler: (input) => {
      seen.push(input);
      return Promise.resolve(ok(String(input.limit)));
    },
  });

  const result = await spec.handler({ id: 'x' }, ctx);
  assert.deepEqual(result, ok('10')); // default applied by the strict schema
  assert.deepEqual(seen, [{ id: 'x', limit: 10 }]);
});

test('defineTool rejects a missing required field', async () => {
  const spec = defineTool({
    name: 'facebook_get_thing',
    description: 'read a thing',
    inputSchema: z.object({ id: z.string() }),
    annotations: READ_ONLY,
    handler: () => Promise.resolve(ok()),
  });
  await assert.rejects(
    spec.handler({}, ctx),
    (err: unknown) => err instanceof z.ZodError,
  );
});

// ---------------------------------------------------------------------------
// Annotation quadruple: all four hints required (compile-time + runtime)
// ---------------------------------------------------------------------------

test('defineTool carries the full annotation quadruple onto the spec', () => {
  const spec = defineTool({
    name: 'facebook_get_thing',
    description: 'read a thing',
    inputSchema: z.object({}),
    annotations: READ_ONLY,
    handler: () => Promise.resolve(ok()),
  });
  assert.deepEqual(spec.annotations, READ_ONLY);
  // Every hint is an explicit boolean — no field is undefined.
  for (const key of [
    'readOnlyHint',
    'destructiveHint',
    'idempotentHint',
    'openWorldHint',
  ] as const) {
    assert.equal(typeof spec.annotations[key], 'boolean');
  }
});

// Compile-time proof (verified by `tsc` in `npm run check`): omitting any hint
// from the quadruple is a type error. If the omission ever compiled, the unused
// expect-error directive below would itself fail the build.
function _annotationsQuadrupleIsRequired(): unknown {
  return defineTool({
    name: 'facebook_probe',
    description: 'probe',
    inputSchema: z.object({}),
    // @ts-expect-error openWorldHint is missing — the full quadruple is required.
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    handler: () => Promise.resolve(ok()),
  });
}
void _annotationsQuadrupleIsRequired;

// ---------------------------------------------------------------------------
// writeTier ↔ readOnlyHint consistency (absent tier ⇒ read-only)
// ---------------------------------------------------------------------------

test('defineTool defaults to read-only when writeTier is absent', () => {
  const spec = defineTool({
    name: 'facebook_list_thing',
    description: 'list things',
    inputSchema: z.object({}),
    annotations: READ_ONLY,
    handler: () => Promise.resolve(ok()),
  });
  assert.equal(spec.writeTier, undefined);
  assert.equal(spec.annotations.readOnlyHint, true);
});

test('defineTool keeps writeTier for a write tool', () => {
  const spec = defineTool({
    name: 'facebook_create_thing',
    description: 'create a thing',
    inputSchema: z.object({}),
    annotations: WRITE,
    writeTier: 'reversible',
    handler: () => Promise.resolve(ok()),
  });
  assert.equal(spec.writeTier, 'reversible');
  assert.equal(spec.annotations.readOnlyHint, false);
});

test('defineTool throws when readOnlyHint disagrees with writeTier', () => {
  // read-only hint but a write tier present.
  assert.throws(
    () =>
      defineTool({
        name: 'facebook_bad_a',
        description: 'bad',
        inputSchema: z.object({}),
        annotations: READ_ONLY,
        writeTier: 'safe',
        handler: () => Promise.resolve(ok()),
      }),
    /readOnlyHint=true disagrees with writeTier=safe/,
  );
  // write hint but no tier.
  assert.throws(
    () =>
      defineTool({
        name: 'facebook_bad_b',
        description: 'bad',
        inputSchema: z.object({}),
        annotations: WRITE,
        handler: () => Promise.resolve(ok()),
      }),
    /readOnlyHint=false disagrees with writeTier=absent/,
  );
});

// ---------------------------------------------------------------------------
// ToolSpec construction: optional fields, no `package` stamp, empty guards
// ---------------------------------------------------------------------------

test('defineTool omits absent optional fields and leaves `package` unset', () => {
  const spec = defineTool({
    name: 'facebook_get_thing',
    description: 'read a thing',
    inputSchema: z.object({}),
    annotations: READ_ONLY,
    handler: () => Promise.resolve(ok()),
  });
  assert.equal('title' in spec, false);
  assert.equal('outputSchema' in spec, false);
  assert.equal('writeTier' in spec, false);
  assert.equal('logFields' in spec, false);
  assert.equal(spec.package, undefined); // stamped later by the registry
});

test('defineTool passes through title, outputSchema and logFields when given', () => {
  const outputSchema = z.object({ ok: z.boolean() });
  const spec = defineTool({
    name: 'facebook_whoami',
    title: 'Who am I',
    description: 'server-owned envelope',
    inputSchema: z.object({}),
    outputSchema,
    annotations: READ_ONLY,
    logFields: ['name'],
    handler: () => Promise.resolve(ok()),
  });
  assert.equal(spec.title, 'Who am I');
  assert.equal(spec.outputSchema, outputSchema);
  assert.deepEqual(spec.logFields, ['name']);
});

test('defineTool rejects an empty name or description', () => {
  assert.throws(
    () =>
      defineTool({
        name: '  ',
        description: 'x',
        inputSchema: z.object({}),
        annotations: READ_ONLY,
        handler: () => Promise.resolve(ok()),
      }),
    /`name` must be a non-empty string/,
  );
  assert.throws(
    () =>
      defineTool({
        name: 'facebook_x',
        description: '',
        inputSchema: z.object({}),
        annotations: READ_ONLY,
        handler: () => Promise.resolve(ok()),
      }),
    /`description` must be non-empty/,
  );
});
