// Tests for the tiered plan-and-apply write gate (task F13).
//
// The security-critical properties under test:
//   * plan mode never performs the mutation; apply mode performs it exactly once
//     when bound to a live plan_id (happy path);
//   * a world that changed since the preview blocks the mutation (fail-with-diff);
//   * `irreversible` / `spend` are NEVER satisfied by FB_WRITE_MODE=apply — they
//     always require an explicit per-call apply:true bound to a plan_id (Sec #3);
//   * expired / unknown / mismatched plans are rejected;
//   * the out-of-band confirmer gates high-consequence applies (B1 / F15 seam);
//   * an ambiguous perform failure journals `attempted` before re-throwing (CC-LIFE-2).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeClock } from '../core/fakes/fakeClock.js';
import { createMemoryJournal } from '../core/fakes/memoryJournal.js';
import type { ConfirmationRequest, Confirmer } from '../core/index.js';
import {
  authorize,
  computeDivergence,
  createWriteGate,
  PLAN_TTL_MS,
  WriteGateError,
  type WriteAction,
  type WriteGateDeps,
} from './write-mode.js';

// --- fixtures ---------------------------------------------------------------

function makeGate(overrides: Partial<WriteGateDeps> = {}): {
  gate: ReturnType<typeof createWriteGate>;
  clock: ReturnType<typeof createFakeClock>;
  journal: ReturnType<typeof createMemoryJournal>;
} {
  const clock = createFakeClock(1000);
  const journal = createMemoryJournal(clock);
  let seq = 0;
  const gate = createWriteGate({
    clock,
    journal,
    defaultWriteMode: 'plan',
    newPlanId: (): string => `plan-${(seq += 1)}`,
    ...overrides,
  });
  return { gate, clock, journal };
}

type ActionOverride<T> = Partial<Omit<WriteAction<T>, 'perform'>> &
  Pick<WriteAction<T>, 'perform'>;

function makeAction<T>(over: ActionOverride<T>): WriteAction<T> {
  return {
    tool: 'facebook_delete_post',
    tier: 'irreversible',
    params: { postId: '123' },
    summary: 'Delete post 123',
    ...over,
  };
}

// --- pure authorize decision (Security #3 heart of the gate) ----------------

test('authorize: irreversible/spend never honor the FB_WRITE_MODE=apply default (Security #3)', () => {
  for (const tier of ['irreversible', 'spend'] as const) {
    // env default apply, but no explicit per-call apply → still a dry-run.
    assert.equal(authorize({ tier, defaultWriteMode: 'apply' }).mode, 'plan');
    // explicit apply but not bound to a plan_id → still a dry-run.
    assert.equal(
      authorize({ tier, apply: true, defaultWriteMode: 'apply' }).mode,
      'plan',
    );
    // explicit apply bound to a plan_id → apply (even when the env default is plan).
    assert.equal(
      authorize({ tier, apply: true, planId: 'p1', defaultWriteMode: 'plan' }).mode,
      'apply',
    );
  }
});

test('authorize: safe/reversible honor the FB_WRITE_MODE default and an explicit apply', () => {
  for (const tier of ['safe', 'reversible'] as const) {
    assert.equal(authorize({ tier, defaultWriteMode: 'apply' }).mode, 'apply');
    assert.equal(authorize({ tier, defaultWriteMode: 'plan' }).mode, 'plan');
    assert.equal(
      authorize({ tier, apply: true, defaultWriteMode: 'plan' }).mode,
      'apply',
    );
  }
  assert.equal(PLAN_TTL_MS, 5 * 60 * 1000);
});

// --- plan → apply happy path (plan_id binding) ------------------------------

test('plan then apply performs the mutation exactly once when bound to its plan_id', async () => {
  const { gate, journal } = makeGate();
  let performed = 0;
  const perform = (): Promise<{ id: string }> => {
    performed += 1;
    return Promise.resolve({ id: 'deleted' });
  };

  // Plan step: no apply flag → validating dry-run, zero mutation.
  const planned = await gate.execute(makeAction({ perform }));
  assert.equal(planned.kind, 'preview');
  assert.ok(planned.kind === 'preview');
  const { planId } = planned.preview;
  assert.match(planId, /^plan-/);
  assert.equal(performed, 0, 'plan mode must not perform the mutation');
  assert.ok(planned.preview.notPerformedNotice.length > 0);
  assert.equal(planned.preview.expiresAt, 1000 + PLAN_TTL_MS);
  assert.equal(journal.entries.length, 0, 'plan mode must not journal');

  // Apply step: explicit apply bound to the plan_id → performs once.
  const applied = await gate.execute(makeAction({ perform, apply: true, planId }));
  assert.ok(applied.kind === 'result');
  assert.equal(applied.result.applied, true);
  assert.deepEqual(applied.result.result, { id: 'deleted' });
  assert.equal(applied.result.journalStatus, 'ok');
  assert.equal(performed, 1);
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0]?.outcome, 'applied');
  assert.equal(journal.entries[0]?.planId, planId);

  // A second apply against the now-spent plan is rejected (single-use).
  await assert.rejects(
    gate.execute(makeAction({ perform, apply: true, planId })),
    (err: unknown) => err instanceof WriteGateError && err.code === 'plan_not_found',
  );
  assert.equal(performed, 1, 'a spent plan must not perform again');
});

// --- gate honors env bypass rules per tier ----------------------------------

test('gate: high-consequence tiers under FB_WRITE_MODE=apply still only preview (no mutation)', async () => {
  for (const tier of ['irreversible', 'spend'] as const) {
    const { gate, journal } = makeGate({ defaultWriteMode: 'apply' });
    let performed = 0;
    const out = await gate.execute(
      makeAction({
        tier,
        perform: (): Promise<string> => {
          performed += 1;
          return Promise.resolve('x');
        },
      }),
    );
    assert.ok(
      out.kind === 'preview',
      `${tier} under env=apply must degrade to a preview`,
    );
    assert.equal(performed, 0);
    assert.equal(journal.entries.length, 0);
  }
});

test('gate: safe/reversible apply directly under the FB_WRITE_MODE=apply default', async () => {
  for (const tier of ['safe', 'reversible'] as const) {
    const { gate } = makeGate({ defaultWriteMode: 'apply' });
    let performed = 0;
    const out = await gate.execute(
      makeAction({
        tier,
        params: { message: 'hi' },
        perform: (): Promise<string> => {
          performed += 1;
          return Promise.resolve('ok');
        },
      }),
    );
    assert.ok(out.kind === 'result');
    assert.equal(out.result.applied, true);
    assert.equal(performed, 1);
  }
});

test('gate: an explicit apply that cannot be honored explains the downgrade in warnings', async () => {
  const { gate } = makeGate();
  // irreversible + apply:true but no plan_id → degrades to a preview.
  const out = await gate.execute(
    makeAction({
      tier: 'irreversible',
      apply: true,
      perform: (): Promise<string> => Promise.resolve('x'),
    }),
  );
  assert.ok(out.kind === 'preview');
  assert.ok(out.preview.warnings.some((w) => w.includes('plan_id')));
});

// --- divergence (fail-with-diff) --------------------------------------------

test('divergence between preview and apply blocks the mutation (fail-with-diff)', async () => {
  const { gate } = makeGate();
  let world = { message: 'original' };
  let performed = 0;
  const readState = (): Promise<{ message: string }> => Promise.resolve({ ...world });
  const action = makeAction({
    tool: 'facebook_update_post',
    tier: 'reversible',
    params: { postId: '123', message: 'new' },
    readState,
    perform: (): Promise<string> => {
      performed += 1;
      return Promise.resolve('ok');
    },
  });

  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');
  assert.deepEqual(planned.preview.beforeState, { message: 'original' });

  // The world changes underneath the plan.
  world = { message: 'edited by someone else' };

  const applied = await gate.execute({
    ...action,
    apply: true,
    planId: planned.preview.planId,
  });
  assert.ok(applied.kind === 'result');
  assert.equal(applied.result.applied, false);
  assert.ok(
    applied.result.diverged !== undefined && applied.result.diverged.length === 1,
  );
  assert.equal(applied.result.diverged?.[0]?.field, 'message');
  assert.equal(performed, 0, 'a diverged apply must not perform the mutation');
});

test('computeDivergence: field-level diffs, empty on equality, whole-value for non-objects', () => {
  assert.deepEqual(computeDivergence({ a: 1, b: 2 }, { a: 1, b: 2 }), []);
  const diffs = computeDivergence({ a: 1, b: 2 }, { a: 1, b: 3 });
  assert.equal(diffs.length, 1);
  assert.deepEqual(diffs[0], { field: 'b', expected: 2, actual: 3 });
  assert.deepEqual(computeDivergence('x', 'y'), [
    { field: '(state)', expected: 'x', actual: 'y' },
  ]);
});

// --- plan lifecycle rejections ----------------------------------------------

test('an expired plan_id is rejected at apply time', async () => {
  const { gate, clock } = makeGate({ planTtlMs: 1000 });
  const action = makeAction({
    tier: 'reversible',
    params: { x: 1 },
    perform: (): Promise<string> => Promise.resolve('ok'),
  });
  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');
  clock.advance(1001); // step past the TTL
  await assert.rejects(
    gate.execute({ ...action, apply: true, planId: planned.preview.planId }),
    (err: unknown) => err instanceof WriteGateError && err.code === 'plan_expired',
  );
});

test('an unknown plan_id is rejected as plan_not_found', async () => {
  const { gate } = makeGate();
  await assert.rejects(
    gate.execute(
      makeAction({
        tier: 'irreversible',
        apply: true,
        planId: 'never-created',
        perform: (): Promise<string> => Promise.resolve('x'),
      }),
    ),
    (err: unknown) => err instanceof WriteGateError && err.code === 'plan_not_found',
  );
});

test('an apply whose params differ from the plan is rejected as plan_mismatch', async () => {
  const { gate } = makeGate();
  const base = makeAction({
    tier: 'irreversible',
    params: { postId: '1' },
    perform: (): Promise<string> => Promise.resolve('x'),
  });
  const planned = await gate.execute(base);
  assert.ok(planned.kind === 'preview');
  await assert.rejects(
    gate.execute({
      ...base,
      params: { postId: '2' },
      apply: true,
      planId: planned.preview.planId,
    }),
    (err: unknown) => err instanceof WriteGateError && err.code === 'plan_mismatch',
  );
});

// --- out-of-band confirmation (B1 / F15 seam) -------------------------------

test('high-tier apply consults the confirmer and refuses when denied (B1)', async () => {
  const denier: Confirmer = {
    confirm: (): Promise<{ confirmed: false; method: 'denied' }> =>
      Promise.resolve({ confirmed: false, method: 'denied' }),
  };
  const { gate, journal } = makeGate({ confirmer: denier });
  let performed = 0;
  const action = makeAction({
    tier: 'spend',
    perform: (): Promise<string> => {
      performed += 1;
      return Promise.resolve('x');
    },
  });
  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');
  await assert.rejects(
    gate.execute({ ...action, apply: true, planId: planned.preview.planId }),
    (err: unknown) => err instanceof WriteGateError && err.code === 'confirmation_denied',
  );
  assert.equal(performed, 0, 'a denied confirmation must not perform');
  assert.equal(journal.entries.length, 0);
});

test('high-tier apply proceeds and passes tier/summary to the confirmer when approved', async () => {
  const requests: ConfirmationRequest[] = [];
  const approver: Confirmer = {
    confirm: (r: ConfirmationRequest) => {
      requests.push(r);
      return Promise.resolve({ confirmed: true, method: 'operator_token' as const });
    },
  };
  const { gate } = makeGate({ confirmer: approver });
  let performed = 0;
  const action = makeAction({
    tier: 'irreversible',
    summary: 'Delete post 777',
    perform: (): Promise<string> => {
      performed += 1;
      return Promise.resolve('gone');
    },
  });
  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');
  const applied = await gate.execute({
    ...action,
    apply: true,
    planId: planned.preview.planId,
  });
  assert.ok(applied.kind === 'result');
  assert.equal(applied.result.applied, true);
  assert.equal(performed, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.tier, 'irreversible');
  assert.equal(requests[0]?.summary, 'Delete post 777');
});

// --- journal outcomes on perform failure ------------------------------------

test('an ambiguous perform failure journals `attempted` and re-throws (CC-LIFE-2)', async () => {
  const { gate, journal } = makeGate();
  const action = makeAction({
    tier: 'reversible',
    params: { x: 1 },
    perform: (): Promise<string> => Promise.reject(new Error('socket hang up')),
    classifyOutcome: (): 'attempted' => 'attempted',
  });
  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');
  await assert.rejects(
    gate.execute({ ...action, apply: true, planId: planned.preview.planId }),
    /socket hang up/,
  );
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0]?.outcome, 'attempted');
  assert.ok(journal.entries[0]?.error?.includes('socket hang up'));
});

test('a plain perform failure defaults to journaling `failed` and re-throws', async () => {
  const { gate, journal } = makeGate();
  const action = makeAction({
    tier: 'reversible',
    params: { x: 1 },
    perform: (): Promise<string> => Promise.reject(new Error('boom')),
  });
  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');
  await assert.rejects(
    gate.execute({ ...action, apply: true, planId: planned.preview.planId }),
    /boom/,
  );
  assert.equal(journal.entries[0]?.outcome, 'failed');
});
