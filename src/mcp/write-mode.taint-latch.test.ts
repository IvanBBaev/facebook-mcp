// The outbound taint latch at the gate (SEC-01, C08): once untrusted content
// has entered the session, an `outbound` write is plan-bound and out-of-band
// confirmed whatever its tier; before that, and for a write not marked
// outbound, the gate behaves exactly as it did.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeClock } from '../core/fakes/fakeClock.js';
import { createMemoryJournal } from '../core/fakes/memoryJournal.js';
import type { ConfirmationRequest, Confirmer } from '../core/index.js';
import {
  createWriteGate,
  TAINT_LATCH_WARNING,
  WriteGateError,
  type WriteAction,
  type WriteGateDeps,
} from './write-mode.js';

function recorder(confirmed = true): {
  confirmer: Confirmer;
  calls: ConfirmationRequest[];
} {
  const calls: ConfirmationRequest[] = [];
  return {
    calls,
    confirmer: {
      confirm: (request) => {
        calls.push(request);
        return Promise.resolve(
          confirmed
            ? { confirmed: true, method: 'operator_token' as const }
            : { confirmed: false, method: 'denied' as const },
        );
      },
    },
  };
}

function makeGate(overrides: Partial<WriteGateDeps>): ReturnType<typeof createWriteGate> {
  const clock = createFakeClock(1000);
  let seq = 0;
  return createWriteGate({
    clock,
    journal: createMemoryJournal(clock),
    defaultWriteMode: 'apply',
    newPlanId: (): string => `plan-${(seq += 1)}`,
    confirmer: recorder().confirmer,
    ...overrides,
  });
}

function reply(
  over: Partial<WriteAction<{ id: string }>> = {},
): WriteAction<{ id: string }> & { performed: () => number } {
  let performed = 0;
  return {
    tool: 'facebook_reply_to_comment',
    tier: 'reversible',
    params: { commentId: '1_2', message: 'Thanks!' },
    summary: 'Reply to comment 1_2',
    outbound: true,
    perform: () => {
      performed += 1;
      return Promise.resolve({ id: 'r1' });
    },
    performed: () => performed,
    ...over,
  };
}

test('an outbound write in an untainted session applies on the env default, unconfirmed', async () => {
  const { confirmer, calls } = recorder();
  const gate = makeGate({ confirmer, sessionTainted: () => false });
  const action = reply();
  const outcome = await gate.execute(action);
  assert.ok(outcome.kind === 'result' && outcome.result.applied);
  assert.equal(action.performed(), 1);
  assert.equal(calls.length, 0);
});

test('a tainted session turns an outbound write into plan + confirmed apply', async () => {
  const { confirmer, calls } = recorder();
  const gate = makeGate({ confirmer, sessionTainted: () => true });
  const action = reply();

  // The env default (apply) no longer covers it, and neither does apply:true alone.
  const first = await gate.execute(action);
  assert.ok(first.kind === 'preview');
  assert.ok(first.preview.warnings.includes(TAINT_LATCH_WARNING));
  const bare = await gate.execute({ ...action, apply: true });
  assert.ok(bare.kind === 'preview');
  assert.equal(action.performed(), 0);

  const applied = await gate.execute({
    ...action,
    apply: true,
    planId: first.preview.planId,
  });
  assert.ok(applied.kind === 'result' && applied.result.applied);
  assert.equal(action.performed(), 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.tier, 'reversible');
  assert.equal(calls[0]?.summary, 'Reply to comment 1_2');
  assert.match(calls[0]?.reason ?? '', /untrusted content/);
});

test('a denied confirmation refuses the latched outbound write without performing it', async () => {
  const gate = makeGate({
    confirmer: recorder(false).confirmer,
    sessionTainted: () => true,
  });
  const action = reply();
  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');
  await assert.rejects(
    gate.execute({ ...action, apply: true, planId: planned.preview.planId }),
    (err: unknown) => err instanceof WriteGateError && err.code === 'confirmation_denied',
  );
  assert.equal(action.performed(), 0);
});

test('the latch is read per call: tainted between plan and apply, the apply is confirmed', async () => {
  let tainted = false;
  const { confirmer, calls } = recorder();
  const gate = makeGate({
    confirmer,
    defaultWriteMode: 'plan',
    sessionTainted: () => tainted,
  });
  const action = reply();
  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');
  assert.ok(!planned.preview.warnings.includes(TAINT_LATCH_WARNING));
  tainted = true;
  const applied = await gate.execute({
    ...action,
    apply: true,
    planId: planned.preview.planId,
  });
  assert.ok(applied.kind === 'result' && applied.result.applied);
  assert.equal(calls.length, 1);
});

test('fail closed: a gate without the hook, or with a throwing one, treats the session as tainted', async () => {
  const hooks: Array<WriteGateDeps['sessionTainted']> = [
    undefined,
    () => {
      throw new Error('latch unavailable');
    },
  ];
  for (const sessionTainted of hooks) {
    const gate = makeGate(sessionTainted === undefined ? {} : { sessionTainted });
    const action = reply();
    const outcome = await gate.execute(action);
    assert.ok(outcome.kind === 'preview', 'an outbound write must not auto-apply');
    assert.equal(action.performed(), 0);
  }
});

test('a write not marked outbound is untouched by a tainted session', async () => {
  const { confirmer, calls } = recorder();
  const gate = makeGate({ confirmer, sessionTainted: () => true });
  for (const outbound of [undefined, false]) {
    const action = reply({ outbound, tool: 'facebook_hide_comment' });
    const outcome = await gate.execute(action);
    assert.ok(outcome.kind === 'result' && outcome.result.applied);
    assert.equal(action.performed(), 1);
  }
  assert.equal(calls.length, 0);
});

test('a high-consequence outbound write keeps its tier reason for the confirmer', async () => {
  const { confirmer, calls } = recorder();
  const gate = makeGate({ confirmer, sessionTainted: () => true });
  const action = reply({ tier: 'irreversible', tool: 'facebook_block_user' });
  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');
  await gate.execute({ ...action, apply: true, planId: planned.preview.planId });
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.reason ?? '', /irreversible write requires/);
});
