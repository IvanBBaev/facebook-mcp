// `executeWrite` refuses a payload that carries a credential (SEC-06, C08):
// before the gate, on plan and apply alike, naming the field and never the value.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRedactor } from '../core/redact.js';
import type { Redactor, ToolContext } from '../core/index.js';
import {
  WriteGateError,
  type WriteAction,
  type WriteGate,
  type WriteOutcome,
} from '../mcp/index.js';
import { executeWrite } from './shared.js';

const TOKEN = 'hunter2-not-a-pattern-value';

function ctxWith(redactor: Redactor): { ctx: ToolContext; gateCalls: () => number } {
  let calls = 0;
  const gate: WriteGate = {
    execute: <T = unknown>(): Promise<WriteOutcome<T>> => {
      calls += 1;
      return Promise.resolve({
        kind: 'result',
        result: { applied: true, verdict: 'applied' },
      } as unknown as WriteOutcome<T>);
    },
  };
  const ctx = {
    settings: { maxResultChars: 25_000 },
    redactor,
    writeGate: gate,
  } as unknown as ToolContext;
  return { ctx, gateCalls: () => calls };
}

function action(params: Record<string, unknown>, apply = false): WriteAction<unknown> {
  return {
    tool: 'facebook_send_message',
    tier: 'reversible',
    params,
    summary: 'Send a message',
    ...(apply ? { apply: true, planId: 'plan-1' } : {}),
    perform: () => Promise.resolve({}),
  };
}

test('a payload carrying a registered secret is refused before the gate, plan and apply alike', async () => {
  for (const apply of [false, true]) {
    const { ctx, gateCalls } = ctxWith(createRedactor({ secrets: [TOKEN] }));
    await assert.rejects(
      executeWrite(
        ctx,
        action({ recipient: '42', message: `here you go: ${TOKEN}` }, apply),
      ),
      (err: unknown) =>
        err instanceof WriteGateError &&
        err.code === 'secret_in_payload' &&
        err.tool === 'facebook_send_message' &&
        err.message.includes('"message" field') &&
        !err.message.includes(TOKEN),
    );
    assert.equal(gateCalls(), 0, 'nothing may be planned or performed');
  }
});

test('a clean payload reaches the gate unchanged', async () => {
  const { ctx, gateCalls } = ctxWith(createRedactor({ secrets: [TOKEN] }));
  await executeWrite(
    ctx,
    action({ message: 'Hello', image_hash: '0123456789abcdef0123456789abcdef' }),
  );
  assert.equal(gateCalls(), 1);
});

test('a redactor without the predicate falls back to its string scrubber', async () => {
  const scrubbing: Redactor = {
    redact: (v) => v,
    redactString: (s) => s.split(TOKEN).join('[REDACTED]'),
    addSecret: () => {},
  };
  const { ctx, gateCalls } = ctxWith(scrubbing);
  await assert.rejects(
    executeWrite(ctx, action({ message: TOKEN })),
    (err: unknown) => err instanceof WriteGateError && err.code === 'secret_in_payload',
  );
  await executeWrite(ctx, action({ message: 'fine' }));
  assert.equal(gateCalls(), 1);

  // An unserializable payload cannot be inspected, so it is refused.
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await assert.rejects(
    executeWrite(ctx, action(cyclic)),
    (err: unknown) => err instanceof WriteGateError && err.code === 'secret_in_payload',
  );
});
