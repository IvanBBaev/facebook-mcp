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
//   * an ambiguous perform failure journals `attempted` before re-throwing (CC-LIFE-2);
//   * a perform that RESOLVES without changing anything can say so, and is
//     journaled as what it was rather than as `applied` (CC-LIFE-2).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeClock } from '../core/fakes/fakeClock.js';
import { createMemoryJournal } from '../core/fakes/memoryJournal.js';
import { ambiguousWriteAction, GraphApiError } from '../core/index.js';
import type {
  ConfirmationRequest,
  Confirmer,
  Journal,
  JournalOutcome,
  JournalStatus,
  WriteTier,
} from '../core/index.js';
import {
  authorize,
  computeDivergence,
  createWriteGate,
  PLAN_TTL_MS,
  APPLIED_VERDICT,
  ATTEMPTED_VERDICT,
  REFUSED_VERDICT,
  WriteGateError,
  type WriteAction,
  type WriteGateDeps,
  type WriteResultVerdict,
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
    // The seam is REQUIRED, so every gate gets one; the tests that care about
    // what it answers override it. A default that approves keeps the pre-existing
    // expectations of the tiers that never consult it unchanged.
    confirmer: {
      confirm: () => Promise.resolve({ confirmed: true, method: 'operator_token' }),
    },
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

test('authorize: requirePlanId gives a low tier the two-step gate without raising it', () => {
  const base = { tier: 'reversible', requirePlanId: true } as const;

  // The env default no longer covers the call, and neither does apply:true alone.
  assert.equal(authorize({ ...base, defaultWriteMode: 'apply' }).mode, 'plan');
  assert.equal(
    authorize({ ...base, apply: true, defaultWriteMode: 'apply' }).mode,
    'plan',
  );
  assert.equal(
    authorize({ ...base, apply: true, planId: 'p1', defaultWriteMode: 'plan' }).mode,
    'apply',
  );
  // An empty plan_id is not a plan_id.
  assert.equal(
    authorize({ ...base, apply: true, planId: '', defaultWriteMode: 'apply' }).mode,
    'plan',
  );
  // requirePlanId:false is the same as omitting it — no accidental escalation.
  assert.equal(
    authorize({ tier: 'reversible', requirePlanId: false, defaultWriteMode: 'apply' })
      .mode,
    'apply',
  );
});

test('requirePlanId does not summon the out-of-band confirmer — that stays tier-driven', async () => {
  let confirmations = 0;
  const approver: Confirmer = {
    confirm: () => {
      confirmations += 1;
      return Promise.resolve({ confirmed: true, method: 'operator_token' as const });
    },
  };
  const { gate } = makeGate({ confirmer: approver });

  const action = makeAction({
    tool: 'facebook_create_post',
    tier: 'reversible',
    requirePlanId: true,
    perform: () => Promise.resolve({ id: 'published' }),
  });

  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');
  const applied = await gate.execute({
    ...action,
    apply: true,
    planId: planned.preview.planId,
  });

  assert.ok(applied.kind === 'result' && applied.result.applied);
  assert.equal(confirmations, 0, 'publishing is plan-bound, not confirmation-bound');
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

test('a params key named `__proto__` is pinned, so an apply that drops it is caught', async () => {
  // `JSON.parse` is what makes `__proto__` an OWN enumerable property, and it is
  // the path params travel whenever a caller forwards a raw tool payload or a
  // Graph node. The pinning clone walks those keys with `Object.entries`, so a
  // plain `copy[key] = ...` runs the inherited setter instead of storing a field
  // — and a string value is swallowed outright. The pinned fingerprint would then
  // be MISSING a param the preview was approved with, and an apply that omits it
  // would compare equal: the gate would perform a write nobody previewed.
  const { gate } = makeGate();
  let performed = 0;
  const previewed = JSON.parse('{"message":"Hi","__proto__":"tenant-a"}') as Record<
    string,
    unknown
  >;
  const base = makeAction({
    tool: 'facebook_create_post',
    tier: 'reversible',
    requirePlanId: true,
    pageId: '111',
    params: previewed,
    perform: (): Promise<string> => {
      performed += 1;
      return Promise.resolve('x');
    },
  });
  const planned = await gate.execute(base);
  assert.ok(planned.kind === 'preview');

  await assert.rejects(
    gate.execute({
      ...base,
      params: { message: 'Hi' },
      apply: true,
      planId: planned.preview.planId,
    }),
    (err: unknown) => err instanceof WriteGateError && err.code === 'plan_mismatch',
  );
  assert.equal(performed, 0, 'a param the preview carried cannot vanish from the pin');
});

test('a plan whose params carry an object `__proto__` can still apply to itself', async () => {
  // The other half of the same defect: an OBJECT value is not swallowed, it
  // re-parents the clone. `isPlainObject` then reports false for the pinned copy
  // and `deepEqual` refuses to walk it, so the plan becomes permanently
  // unappliable — rejected against the very params it was minted from.
  const { gate } = makeGate();
  let performed = 0;
  const previewed = JSON.parse('{"message":"Hi","__proto__":{"tenant":"a"}}') as Record<
    string,
    unknown
  >;
  const base = makeAction({
    tool: 'facebook_create_post',
    tier: 'reversible',
    requirePlanId: true,
    pageId: '111',
    params: previewed,
    perform: (): Promise<string> => {
      performed += 1;
      return Promise.resolve('x');
    },
  });
  const planned = await gate.execute(base);
  assert.ok(planned.kind === 'preview');

  const applied = await gate.execute({
    ...base,
    apply: true,
    planId: planned.preview.planId,
  });
  assert.ok(applied.kind === 'result');
  assert.equal(performed, 1, 'a plan must apply to the params it was minted from');
});

test('a before-state field named `__proto__` is pinned, so an unchanged world does not diverge', async () => {
  // `beforeState` is pinned by the same clone, and it comes straight off the
  // wire — the one input a Graph response fully controls. Losing a field from the
  // snapshot makes the apply-time re-read look like a world that moved, so an
  // untouched Page reports a phantom divergence and the write never happens.
  const { gate } = makeGate();
  let performed = 0;
  const readState = (): Promise<unknown> =>
    Promise.resolve(JSON.parse('{"message":"Hi","__proto__":"tenant-a"}'));
  const base = makeAction({
    tool: 'facebook_update_post',
    tier: 'reversible',
    requirePlanId: true,
    pageId: '111',
    params: { postId: '1', message: 'Bye' },
    readState,
    perform: (): Promise<string> => {
      performed += 1;
      return Promise.resolve('x');
    },
  });
  const planned = await gate.execute(base);
  assert.ok(planned.kind === 'preview');

  const applied = await gate.execute({
    ...base,
    apply: true,
    planId: planned.preview.planId,
  });
  assert.ok(applied.kind === 'result');
  assert.deepEqual(
    applied.result.diverged ?? [],
    [],
    'nothing changed between the two reads',
  );
  assert.equal(performed, 1, 'a world that did not move must not block the apply');
});

test('an apply against a different Page than the plan is rejected as plan_mismatch', async () => {
  // The Page is bound identity, not a parameter: `params` is byte-identical here
  // and only the resolved Page differs, which is exactly the cross-talk the
  // plan_id binding exists to stop (same tool, same tier, same payload, wrong
  // audience). `profile` is a per-call argument the model picks, so nothing else
  // in the apply call would catch this.
  const { gate } = makeGate();
  let performed = 0;
  const base = makeAction({
    tool: 'facebook_create_post',
    tier: 'reversible',
    requirePlanId: true,
    pageId: '111',
    params: { message: 'Hi', published: true },
    perform: (): Promise<string> => {
      performed += 1;
      return Promise.resolve('x');
    },
  });
  const planned = await gate.execute(base);
  assert.ok(planned.kind === 'preview');

  await assert.rejects(
    gate.execute({
      ...base,
      pageId: '222',
      apply: true,
      planId: planned.preview.planId,
    }),
    (err: unknown) => err instanceof WriteGateError && err.code === 'plan_mismatch',
  );
  assert.equal(performed, 0, 'a plan minted for another Page must not publish');

  // The plan is untouched by the rejection: the original Page can still apply it.
  const applied = await gate.execute({
    ...base,
    apply: true,
    planId: planned.preview.planId,
  });
  assert.ok(applied.kind === 'result');
  assert.equal(applied.result.applied, true);
  assert.equal(performed, 1);
});

// --- single-use under concurrency (CC-MCP-3) --------------------------------

test('two concurrent applies bound to one plan_id perform exactly once', async () => {
  // The realistic shape of this: an MCP client puts several tools/call requests
  // in flight at once. Both applies resolve the same plan before either reaches
  // the mutation, so a plan claimed only after `perform` would authorize two.
  const { gate, journal } = makeGate();
  let performed = 0;
  let releasePerform = (): void => {};
  const held = new Promise<void>((resolve) => {
    releasePerform = resolve;
  });
  const action = makeAction({
    tool: 'facebook_create_ad_set',
    tier: 'spend',
    params: { dailyBudget: 1000 },
    perform: async (): Promise<string> => {
      performed += 1;
      await held; // keep the first apply inside perform while the second arrives
      return 'adset-1';
    },
  });

  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');
  const { planId } = planned.preview;

  const first = gate.execute({ ...action, apply: true, planId });
  const second = gate.execute({ ...action, apply: true, planId });
  releasePerform();

  const results = await Promise.allSettled([first, second]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');

  assert.equal(performed, 1, 'one authorization must never fund two mutations');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(
    rejected[0]?.status === 'rejected' &&
      rejected[0].reason instanceof WriteGateError &&
      rejected[0].reason.code === 'plan_not_found',
    'the loser of the race must be refused, not queued',
  );
  assert.equal(journal.entries.length, 1);
});

test('a denied confirmation hands the plan back so the same preview can be retried', async () => {
  // Claiming the plan up front must not turn a fixable refusal into a re-plan:
  // a wrong or missing confirm_token is the operator's to correct, and the
  // preview they approved is still valid.
  let approve = false;
  const confirmer: Confirmer = {
    confirm: () =>
      Promise.resolve(
        approve
          ? ({ confirmed: true, method: 'operator_token' } as const)
          : ({ confirmed: false, method: 'denied' } as const),
      ),
  };
  const { gate } = makeGate({ confirmer });
  let performed = 0;
  const action = makeAction({
    tier: 'irreversible',
    perform: (): Promise<string> => {
      performed += 1;
      return Promise.resolve('x');
    },
  });

  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');
  const { planId } = planned.preview;

  await assert.rejects(
    gate.execute({ ...action, apply: true, planId }),
    (err: unknown) => err instanceof WriteGateError && err.code === 'confirmation_denied',
  );
  assert.equal(performed, 0);

  approve = true;
  const applied = await gate.execute({ ...action, apply: true, planId });
  assert.ok(applied.kind === 'result');
  assert.equal(applied.result.applied, true);
  assert.equal(performed, 1);
});

test('an ambiguous perform failure spends the plan — a retry cannot duplicate the write', async () => {
  // The mutation may well have landed (socket written, response lost). Handing
  // the plan back here would invite exactly the duplicate the journal exists to
  // let an operator reconcile.
  const { gate, journal } = makeGate();
  let performed = 0;
  const action = makeAction({
    tier: 'irreversible',
    perform: (): Promise<string> => {
      performed += 1;
      return Promise.reject(new Error('socket hang up'));
    },
    classifyOutcome: (): 'attempted' => 'attempted',
  });

  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');
  const { planId } = planned.preview;

  await assert.rejects(
    gate.execute({ ...action, apply: true, planId }),
    /socket hang up/,
  );
  assert.equal(journal.entries[0]?.outcome, 'attempted');

  await assert.rejects(
    gate.execute({ ...action, apply: true, planId }),
    (err: unknown) => err instanceof WriteGateError && err.code === 'plan_not_found',
  );
  assert.equal(performed, 1, 'the ambiguous attempt must not be silently repeated');
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

// --- per-call confirm_token threading (D12) ---------------------------------

// Placeholder operator token — never a real secret.
const CONFIRM_TOKEN = 'confirm-token-PLACEHOLDER';

/** A confirmer that approves and records both arguments it was called with. */
function recordingConfirmer(): {
  confirmer: Confirmer;
  calls: { request: ConfirmationRequest; operatorToken: string | undefined }[];
} {
  const calls: { request: ConfirmationRequest; operatorToken: string | undefined }[] = [];
  return {
    calls,
    confirmer: {
      confirm: (request: ConfirmationRequest, operatorToken?: string) => {
        calls.push({ request, operatorToken });
        return Promise.resolve({ confirmed: true, method: 'operator_token' as const });
      },
    },
  };
}

test('a gated apply hands confirm_token to the confirmer as a SEPARATE argument (D12)', async () => {
  const { confirmer, calls } = recordingConfirmer();
  const { gate } = makeGate({ confirmer });
  const action = makeAction({
    tier: 'irreversible',
    summary: 'Delete post 123',
    confirmToken: CONFIRM_TOKEN,
    perform: (): Promise<string> => Promise.resolve('gone'),
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

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.operatorToken, CONFIRM_TOKEN);
  // The ConfirmationRequest is forwarded verbatim to the MCP client by the
  // elicitation path, so the secret must not travel inside it — not under any
  // key, not embedded in the summary.
  const request = calls[0]?.request;
  assert.ok(request !== undefined);
  assert.ok(
    !JSON.stringify(request).includes(CONFIRM_TOKEN),
    'the confirmation request must not carry the operator token',
  );
});

test('an apply without a confirm_token passes undefined as the second argument (D12)', async () => {
  const { confirmer, calls } = recordingConfirmer();
  const { gate } = makeGate({ confirmer });
  const action = makeAction({
    tier: 'spend',
    tool: 'facebook_update_ad_budget',
    params: { adSetId: 'a1', dailyBudget: 5000 },
    summary: 'Raise daily budget to 5000',
    perform: (): Promise<string> => Promise.resolve('ok'),
  });

  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');
  await gate.execute({ ...action, apply: true, planId: planned.preview.planId });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.operatorToken, undefined);
});

test('the per-call confirm_token is never written to the journal (D12)', async () => {
  const { confirmer } = recordingConfirmer();
  const { gate, journal } = makeGate({ confirmer });
  const action = makeAction({
    tier: 'spend',
    tool: 'facebook_update_ad_budget',
    params: { adSetId: 'a1', dailyBudget: 5000 },
    summary: 'Raise daily budget to 5000',
    metadata: { adSetId: 'a1' },
    confirmToken: CONFIRM_TOKEN,
    perform: (): Promise<string> => Promise.resolve('ok'),
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

  assert.equal(journal.entries.length, 1);
  for (const entry of journal.entries) {
    assert.ok(
      !JSON.stringify(entry).includes(CONFIRM_TOKEN),
      'the journal is an audit trail, not a secret store',
    );
  }
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

test('with no classifyOutcome, a failure the transport stamped ambiguous journals `attempted`', async () => {
  // `facebook_delete_post` and `facebook_update_post` hand the gate no
  // `classifyOutcome`. The http layer already decided what a 5xx or a
  // mid-flight network fault on a write means — `category: 'ambiguous'`, the
  // mutation may have landed (C2) — and the gate must not overrule it with its
  // own `failed` default: the journal would then assert that a delete which may
  // well have happened did not.
  for (const httpStatus of [0, 503]) {
    const { gate, journal } = makeGate();
    const action = makeAction({
      params: { postId: '123' },
      readState: () => Promise.resolve({ present: true }),
      perform: (): Promise<string> =>
        Promise.reject(
          new GraphApiError(`HTTP ${String(httpStatus)} on DELETE`, {
            code: 0,
            httpStatus,
            action: ambiguousWriteAction(),
          }),
        ),
    });
    const planned = await gate.execute(action);
    assert.ok(planned.kind === 'preview');
    await assert.rejects(
      gate.execute({ ...action, apply: true, planId: planned.preview.planId }),
      GraphApiError,
    );
    assert.equal(journal.entries.length, 1);
    assert.equal(
      journal.entries[0]?.outcome,
      'attempted',
      `an ambiguous HTTP ${String(httpStatus)} write may have landed — it is not a failure`,
    );
  }
});

test('regression: with no classifyOutcome, a non-ambiguous Graph refusal still journals `failed`', async () => {
  const { gate, journal } = makeGate();
  const action = makeAction({
    tier: 'reversible',
    params: { x: 1 },
    perform: (): Promise<string> =>
      Promise.reject(
        new GraphApiError('(#100) Invalid parameter', {
          code: 100,
          httpStatus: 400,
          action: {
            category: 'validation',
            retryable: false,
            operatorText: 'fix the parameters',
          },
        }),
      ),
  });
  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');
  await assert.rejects(
    gate.execute({ ...action, apply: true, planId: planned.preview.planId }),
    /Invalid parameter/,
  );
  assert.equal(journal.entries[0]?.outcome, 'failed');
});

// --- journal outcomes on a resolved perform (classifyResult) -----------------

test('a resolved perform that changed nothing journals `failed`, not `applied`', async () => {
  const { gate, journal } = makeGate();
  // The shape of every bulk verb: it collects per-id outcomes and RETURNS them,
  // failures included, because one bad id must not fail the batch (CC-MOD-5).
  // The gate cannot read that result, so the action has to hand down the verdict.
  const action = makeAction({
    tier: 'reversible',
    params: { ids: ['a', 'b'] },
    perform: (): Promise<{ failed: number }> => Promise.resolve({ failed: 2 }),
    classifyResult: (r: { failed: number }) =>
      r.failed === 2 ? { outcome: 'failed' as const, applied: false } : APPLIED_VERDICT,
  });

  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');
  const applied = await gate.execute({
    ...action,
    apply: true,
    planId: planned.preview.planId,
  });

  assert.ok(applied.kind === 'result');
  assert.equal(applied.result.applied, false, 'the caller must not be told it landed');
  assert.equal(journal.entries.length, 1);
  assert.equal(
    journal.entries[0]?.outcome,
    'failed',
    'the journal is what an operator reconciles against — it may not invent a mutation',
  );
});

test('an action with no classifyResult still journals `applied` (unchanged default)', async () => {
  const { gate, journal } = makeGate();
  const action = makeAction({
    tier: 'reversible',
    params: { x: 1 },
    perform: (): Promise<string> => Promise.resolve('ok'),
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
  assert.equal(journal.entries[0]?.outcome, 'applied');
});

test('an ambiguous verdict reaches the caller as outcome:attempted and is journaled attempted', async () => {
  const { gate, journal } = makeGate();
  // The shape of a multi-phase upload whose `finish` was declined AFTER the
  // object was created: the action can vouch neither that the write landed nor
  // that it did not. `applied:false` alone reads as a refusal; only `outcome`
  // lets the envelope say "verify before retrying" instead of "fix and retry".
  const action = makeAction({
    tier: 'reversible',
    params: { video: 'clip.mp4' },
    perform: (): Promise<{ accepted: boolean }> => Promise.resolve({ accepted: false }),
    classifyResult: (r: { accepted: boolean }) =>
      r.accepted ? APPLIED_VERDICT : ATTEMPTED_VERDICT,
  });

  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');
  const applied = await gate.execute({
    ...action,
    apply: true,
    planId: planned.preview.planId,
  });

  assert.ok(applied.kind === 'result');
  assert.equal(applied.result.applied, false, 'the caller must not be told it landed');
  assert.equal(
    applied.result.outcome,
    'attempted',
    'the caller must be able to tell an ambiguous write from a refused one',
  );
  assert.equal(journal.entries.length, 1);
  assert.equal(
    journal.entries[0]?.outcome,
    'attempted',
    'the journal records the ambiguity so an operator can reconcile (CC-LIFE-2)',
  );
});

test('the journaled outcome rides on the result for the default and the refused verdicts too', async () => {
  // `outcome` is the same fact the journal received, handed to the caller: it
  // must agree with the entry for every verdict, not only the ambiguous one.
  const cases: readonly { readonly ok: boolean; readonly expected: string }[] = [
    { ok: true, expected: 'applied' },
    { ok: false, expected: 'failed' },
  ];
  for (const { ok, expected } of cases) {
    const { gate, journal } = makeGate();
    const action = makeAction({
      tier: 'reversible',
      params: { postId: '123' },
      perform: (): Promise<{ ok: boolean }> => Promise.resolve({ ok }),
      classifyResult: (r: { ok: boolean }) => (r.ok ? APPLIED_VERDICT : REFUSED_VERDICT),
    });
    const planned = await gate.execute(action);
    assert.ok(planned.kind === 'preview');
    const applied = await gate.execute({
      ...action,
      apply: true,
      planId: planned.preview.planId,
    });
    assert.ok(applied.kind === 'result');
    assert.equal(applied.result.applied, ok, `${expected}: applied flag`);
    assert.equal(applied.result.outcome, expected, `${expected}: result outcome`);
    assert.equal(journal.entries[0]?.outcome, expected, `${expected}: journal outcome`);
  }
});

test('the shared verdicts are frozen and say what their names say', () => {
  // Every action that classifies its result hands back one of these by
  // reference, so a mutation would rewrite the verdict of every write at once.
  assert.deepEqual(REFUSED_VERDICT, { outcome: 'failed', applied: false });
  assert.deepEqual(ATTEMPTED_VERDICT, { outcome: 'attempted', applied: false });
  assert.equal(Object.isFrozen(REFUSED_VERDICT), true);
  assert.equal(Object.isFrozen(ATTEMPTED_VERDICT), true);
});

// --- the mutation outweighs the bookkeeping around it -----------------------

/** A journal that cannot write — a full disk, a read-only mount, a bad path. */
function brokenJournal(onAppend?: () => void): Journal {
  return {
    append: (): Promise<JournalStatus> => {
      onAppend?.();
      return Promise.reject(new Error('ENOSPC: no space left on device'));
    },
  };
}

test('a journal fault after a successful perform is reported, not thrown', async () => {
  // The dangerous shape is on the SUCCESS path: the post is already deleted at
  // Graph, and the only thing that went wrong afterwards is the local record of
  // it. Turning that into a thrown error tells the model the delete failed, and
  // the obvious next move — retry — is a second mutation the operator never
  // authorized (the plan is already spent, so it re-plans and re-applies).
  // `ApplyResult.journalStatus` exists precisely to carry this as a fact about
  // the record rather than a fact about the write.
  let appends = 0;
  const { gate } = makeGate({
    journal: brokenJournal(() => {
      appends += 1;
    }),
  });
  let performed = 0;
  const action = makeAction({
    perform: (): Promise<string> => {
      performed += 1;
      return Promise.resolve('deleted');
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
  assert.equal(
    applied.result.applied,
    true,
    'the mutation landed and must be reported so',
  );
  assert.equal(applied.result.journalStatus, 'failed');
  assert.equal(performed, 1);
  assert.equal(appends, 1, 'a landed write must not fall through to the failure path');
});

test('a journal fault on the failure path does not replace the real cause', async () => {
  // Both the perform and the journal are broken. The operator needs the Graph
  // error — it is what says whether the write landed; the journal error is
  // secondary bookkeeping and must never be the one that surfaces.
  const { gate } = makeGate({ journal: brokenJournal() });
  const action = makeAction({
    tier: 'reversible',
    params: { x: 1 },
    perform: (): Promise<string> =>
      Promise.reject(new Error('graph rejected: (#200) insufficient permission')),
  });

  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');
  await assert.rejects(
    gate.execute({ ...action, apply: true, planId: planned.preview.planId }),
    /insufficient permission/,
  );
});

test('a classifyResult that throws cannot unsay a mutation that already landed', async () => {
  // `classifyResult` is caller-supplied and reads a response shape it did not
  // build (`r.failed` on a payload Graph shaped differently today). A throw
  // there is a bug in the verdict, not evidence that the mutation did not
  // happen — so it degrades to the documented default verdict and is recorded
  // in the entry, instead of re-throwing and journaling `failed` for a write
  // that succeeded.
  const { gate, journal } = makeGate();
  const action = makeAction({
    tier: 'reversible',
    params: { ids: ['a'] },
    perform: (): Promise<{ failed?: number }> => Promise.resolve({}),
    classifyResult: (r: { failed?: number }): { outcome: 'failed'; applied: false } => {
      throw new Error(`cannot read outcomes of ${String(r.failed?.toFixed(0))}`);
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
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0]?.outcome, 'applied');
  assert.ok(
    journal.entries[0]?.error?.includes('classification'),
    'the entry must admit the verdict was not computed',
  );
});

// --- fail-closed on an unrecognised tier ------------------------------------

// Not in the `WriteTier` union: the shape a JS caller of the published
// `authorize`/`createWriteGate` can hand in, and the shape a tier added to the
// union later has for any gate compiled before it existed.
const unknownTier = 'destructive' as unknown as WriteTier;

test('a tier the gate does not recognise is gated like a high-consequence one', () => {
  // The env bypass is stated as an allowlist of the tiers it MAY cover, so an
  // unknown tier lands on the guarded side. Stated the other way round — "not
  // irreversible and not spend" — `FB_WRITE_MODE=apply` would perform an
  // unknown-blast-radius write on sight, with no plan and no confirmation.
  assert.equal(authorize({ tier: unknownTier, defaultWriteMode: 'apply' }).mode, 'plan');
  assert.equal(
    authorize({ tier: unknownTier, apply: true, defaultWriteMode: 'apply' }).mode,
    'plan',
  );
  assert.equal(
    authorize({ tier: unknownTier, apply: true, planId: 'p1', defaultWriteMode: 'plan' })
      .mode,
    'apply',
  );
});

test('an unrecognised tier still has to pass the out-of-band confirmer', async () => {
  const seen: ConfirmationRequest[] = [];
  const confirmer: Confirmer = {
    confirm: (request) => {
      seen.push(request);
      return Promise.resolve({ confirmed: false, method: 'denied' as const });
    },
  };
  const { gate } = makeGate({ confirmer, defaultWriteMode: 'apply' });
  let performed = 0;
  const action = makeAction({
    tier: unknownTier,
    perform: (): Promise<string> => {
      performed += 1;
      return Promise.resolve('done');
    },
  });

  const planned = await gate.execute({ ...action, apply: true });
  assert.ok(
    planned.kind === 'preview',
    'apply:true alone must not cover an unknown tier',
  );
  await assert.rejects(
    gate.execute({ ...action, apply: true, planId: planned.preview.planId }),
    (err: unknown) => err instanceof WriteGateError && err.code === 'confirmation_denied',
  );
  assert.equal(seen.length, 1);
  assert.equal(performed, 0);
});

// --- the plan is pinned, not aliased ----------------------------------------

test('the plan pins a snapshot of its params — a later mutation cannot re-aim it', async () => {
  // The action object a tool handler builds is its own; nothing stops it (or a
  // shared params object it was handed) from changing between the two
  // `tools/call` requests. If the gate stores that object BY REFERENCE, the
  // plan_id fingerprint mutates with it: the apply's `deepEqual` compares the
  // params against themselves, always matches, and the gate applies a write the
  // operator never previewed — under the previewed summary, no less.
  const { gate } = makeGate();
  let deleted: string | undefined;
  const params: { postId: string } = { postId: '123' };
  const action = makeAction({
    params,
    summary: 'Delete post 123',
    perform: (): Promise<string> => {
      deleted = params.postId;
      return Promise.resolve('deleted');
    },
  });

  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');
  params.postId = '999';

  await assert.rejects(
    gate.execute({ ...action, apply: true, planId: planned.preview.planId }),
    (err: unknown) => err instanceof WriteGateError && err.code === 'plan_mismatch',
  );
  assert.equal(deleted, undefined, 'nothing may be deleted under a re-aimed plan');
});

test('a gate built with no confirmer refuses a high-consequence apply instead of performing it', async () => {
  // The confirmation seam is the ONLY control the `spend` and `irreversible`
  // tiers have that `FB_WRITE_MODE` cannot bypass. Leaving the dependency
  // optional made the control optional too: a gate constructed without it ran
  // those tiers on sight. `createWriteGate` is exported from the package barrel,
  // so a JS consumer reaches this with no type checker in the way, and so does
  // any TS caller that has the field spread in from a partial. The gate has to
  // hold the line itself.
  const clock = createFakeClock(1000);
  const journal = createMemoryJournal(clock);
  const gate = createWriteGate({
    clock,
    journal,
    defaultWriteMode: 'apply',
  } as unknown as WriteGateDeps);

  let performed = false;
  const action = makeAction({
    tool: 'facebook_update_ad_object',
    tier: 'spend',
    perform: () => {
      performed = true;
      return Promise.resolve({ ok: true });
    },
  });

  // Walk the real two-step: a bare `spend` call only ever previews, so the apply
  // path — the one the seam guards — is reached exactly the way a caller reaches
  // it, with the plan_id the preview handed back.
  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');

  await assert.rejects(
    () => gate.execute({ ...action, apply: true, planId: planned.preview.planId }),
    (err: unknown) =>
      err instanceof WriteGateError && err.code === 'confirmation_unavailable',
    'a spend write with no way to confirm it must be refused, not performed',
  );
  assert.equal(performed, false, 'the mutation must never have run');
});

// --- adversarial: what a plan_id actually binds -----------------------------

test('a param the comparison treats as opaque is bound by identity, not flattened away', async () => {
  // The attack, as a caller can really run it: preview a write whose params
  // carry a non-JSON value (a Date, a Buffer, a Map, a class instance — any
  // object with no own enumerable keys), show the human the preview, then apply
  // the SAME plan_id with a different one of those values in the same slot.
  //
  // `pinValue` documents that such a value is SHARED rather than copied, "since
  // copying it could not preserve the identity `deepEqual` compares it by". If
  // the snapshot instead flattens it to `{}`, every opaque value in the codebase
  // compares equal to every other, the plan matches whatever the apply call
  // brings, and the confirmation earned by the preview is spent on a write
  // nobody previewed. That is the worst failure this gate can have.
  const { gate } = makeGate();
  const performed: unknown[] = [];
  const previewed = new Date('2020-01-01T00:00:00.000Z');
  const swapped = new Date('2031-12-31T00:00:00.000Z');
  const action = makeAction({
    tool: 'facebook_schedule_post',
    tier: 'irreversible',
    params: { message: 'hello', when: previewed },
    perform: (): Promise<string> => {
      performed.push('ran');
      return Promise.resolve('ok');
    },
  });

  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');

  await assert.rejects(
    gate.execute({
      ...action,
      params: { message: 'hello', when: swapped },
      apply: true,
      planId: planned.preview.planId,
    }),
    (err: unknown) => err instanceof WriteGateError && err.code === 'plan_mismatch',
    'a different Date in the same slot is a different write',
  );
  assert.equal(performed.length, 0, 'nothing may be performed on a mismatch');
});

test('an opaque param that is the SAME object still applies (the pin does not over-refuse)', async () => {
  // The other half of the property: binding by identity must not make an
  // honest two-step call impossible. A handler that hands the gate the same
  // value on both calls — the normal case, since the apply call rebuilds params
  // from the same validated input — still matches.
  const { gate } = makeGate();
  const when = new Date('2020-01-01T00:00:00.000Z');
  const action = makeAction({
    tier: 'irreversible',
    params: { when },
    perform: (): Promise<string> => Promise.resolve('ok'),
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
});

test('the human-readable summary that is confirmed and journaled comes from the PLAN', async () => {
  // `params` is what the gate compares; `summary` is what a PERSON reads — in
  // the out-of-band confirmation prompt, and afterwards in the journal an
  // operator reconciles a mutation against. Taken from the apply call, that text
  // is chosen by the same untrusted turn that is asking to be approved: preview
  // one sentence, get the human to approve a different one. A plan_id that binds
  // the machine-readable half and lets the human-readable half be rewritten is
  // only half a binding.
  const requests: ConfirmationRequest[] = [];
  const { gate, journal } = makeGate({
    confirmer: {
      confirm: (r: ConfirmationRequest) => {
        requests.push(r);
        return Promise.resolve({ confirmed: true, method: 'operator_token' as const });
      },
    },
  });
  const action = makeAction({
    tool: 'facebook_update_ad_object',
    tier: 'spend',
    params: { object_id: 'act_1', daily_budget_minor: 500000 },
    summary: 'Raise daily budget to 5000.00 USD',
    perform: (): Promise<string> => Promise.resolve('ok'),
  });

  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');

  const applied = await gate.execute({
    ...action,
    summary: 'Raise daily budget to 5000 JPY',
    apply: true,
    planId: planned.preview.planId,
  });
  assert.ok(applied.kind === 'result');
  assert.equal(applied.result.applied, true);

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.summary,
    'Raise daily budget to 5000.00 USD',
    'the confirmer must describe the write that was previewed',
  );
  assert.equal(journal.entries.length, 1);
  assert.equal(
    journal.entries[0]?.summary,
    'Raise daily budget to 5000.00 USD',
    "the audit trail records the approved sentence, not the apply call's",
  );
});

test('an apply cannot drop readState to skip the divergence check it was planned with', async () => {
  // The plan captured a before-state, so this write was previewed as one that
  // fails with a diff if the world moved. The divergence check runs only when
  // the APPLY call also supplies `readState` — a caller who simply omits it on
  // the second call keeps the plan, keeps the params, and loses the check. The
  // world here has changed underneath, which is exactly the case the preview
  // promised would be refused.
  const { gate } = makeGate();
  let performed = 0;
  let state = { message: 'original' };
  const action = makeAction({
    tier: 'irreversible',
    params: { postId: '123' },
    readState: (): Promise<unknown> => Promise.resolve({ ...state }),
    perform: (): Promise<string> => {
      performed += 1;
      return Promise.resolve('ok');
    },
  });

  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');
  state = { message: 'edited by someone else' };

  // Identical to the planned call in every bound field; it simply cannot re-read.
  const withoutReadState = makeAction({
    tier: 'irreversible',
    params: { postId: '123' },
    perform: action.perform,
  });
  await assert.rejects(
    gate.execute({ ...withoutReadState, apply: true, planId: planned.preview.planId }),
    (err: unknown) => err instanceof WriteGateError && err.code === 'plan_mismatch',
    'a plan that pinned a before-state may only be applied by a call that can re-read it',
  );
  assert.equal(performed, 0);
});

test('a confirmer answering with a truthy non-boolean is a refusal, not an approval', async () => {
  // `Confirmer` is an injected seam exported from the package barrel, and
  // `createWriteGate` is exported beside it, so the object answering here is not
  // necessarily one a type checker ever saw. A gate that tests the answer for
  // truthiness approves on `'no'`, `'denied'`, `{}` and `'false'` alike. The
  // only defensible reading of a high-consequence confirmation is that nothing
  // but an explicit `true` is a yes.
  for (const answer of ['no', 'false', 0, {}, []] as const) {
    const { gate } = makeGate({
      confirmer: {
        confirm: () =>
          Promise.resolve({
            confirmed: answer as unknown as boolean,
            method: 'elicitation' as const,
          }),
      },
    });
    let performed = 0;
    const action = makeAction({
      tier: 'spend',
      perform: (): Promise<string> => {
        performed += 1;
        return Promise.resolve('ok');
      },
    });
    const planned = await gate.execute(action);
    assert.ok(planned.kind === 'preview');
    await assert.rejects(
      gate.execute({ ...action, apply: true, planId: planned.preview.planId }),
      (err: unknown) =>
        err instanceof WriteGateError && err.code === 'confirmation_denied',
      `answer ${JSON.stringify(answer)} must not authorize a spend write`,
    );
    assert.equal(performed, 0);
  }
});

// --- regression coverage: attacks the gate ALREADY refuses ------------------
//
// Nothing below was ever red. These are the bypasses this audit tried and did
// not land, pinned so a later refactor has to break a named test to reopen one.

test('regression: a spent plan_id cannot be replayed to perform the write twice', async () => {
  // The sequential half of the replay attack (the concurrent half is covered
  // above): apply, watch it succeed, then send the very same `plan_id` again —
  // a double-post, a double-send, a second budget raise off one approval.
  const { gate } = makeGate();
  let performed = 0;
  const action = makeAction({
    tier: 'irreversible',
    perform: (): Promise<string> => {
      performed += 1;
      return Promise.resolve('ok');
    },
  });

  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');
  const apply = { ...action, apply: true, planId: planned.preview.planId };

  const first = await gate.execute(apply);
  assert.ok(first.kind === 'result');
  assert.equal(first.result.applied, true);

  await assert.rejects(
    gate.execute(apply),
    (err: unknown) => err instanceof WriteGateError && err.code === 'plan_not_found',
  );
  assert.equal(performed, 1, 'one authorization, one mutation');
});

test('regression: expiry is enforced on the apply itself, not merely recorded', async () => {
  // A TTL that is only written into the record and never re-read is a comment.
  // The boundary matters too: `expiresAt` is the first instant the plan is dead,
  // so a plan is usable at ttl-1 and refused at exactly ttl.
  for (const [elapsed, expectUsable] of [
    [PLAN_TTL_MS - 1, true],
    [PLAN_TTL_MS, false],
  ] as const) {
    const { gate, clock } = makeGate();
    const action = makeAction({
      tier: 'irreversible',
      perform: (): Promise<string> => Promise.resolve('ok'),
    });
    const planned = await gate.execute(action);
    assert.ok(planned.kind === 'preview');
    clock.advance(elapsed);
    const apply = { ...action, apply: true, planId: planned.preview.planId };

    if (expectUsable) {
      const out = await gate.execute(apply);
      assert.ok(out.kind === 'result');
      assert.equal(out.result.applied, true);
    } else {
      await assert.rejects(
        gate.execute(apply),
        (err: unknown) => err instanceof WriteGateError && err.code === 'plan_expired',
      );
    }
  }
});

test('regression: malformed gating arguments fail CLOSED, never open', async () => {
  // `apply` and `plan_id` arrive as JSON from the model's `tools/call`, and the
  // barrel exports `createWriteGate` to callers no schema stands in front of. A
  // wrong-typed, empty, null or absurd value must land on the refusing side of
  // every branch: an `apply` that is not the boolean `true` is not an apply, and
  // a `plan_id` that is not a live minted id is not a binding.
  const notApply = ['true', 1, {}, null] as const;
  for (const apply of notApply) {
    const { gate } = makeGate();
    let performed = 0;
    const out = await gate.execute(
      makeAction({
        tier: 'irreversible',
        apply: apply as unknown as boolean,
        planId: 'plan-1',
        perform: (): Promise<string> => {
          performed += 1;
          return Promise.resolve('ok');
        },
      }),
    );
    assert.equal(out.kind, 'preview', `apply:${JSON.stringify(apply)} is not an apply`);
    assert.equal(performed, 0);
  }

  const notAPlanId = ['', null, 0, {}, 'x'.repeat(100_000)] as const;
  for (const planId of notAPlanId) {
    const { gate } = makeGate();
    let performed = 0;
    const action = makeAction({
      tier: 'spend',
      apply: true,
      planId: planId as unknown as string,
      perform: (): Promise<string> => {
        performed += 1;
        return Promise.resolve('ok');
      },
    });
    // Either a dry-run preview (no usable binding ⇒ never an apply) or a hard
    // refusal. What must never happen is the mutation.
    await gate
      .execute(action)
      .then((out) => {
        assert.equal(out.kind, 'preview', `plan_id:${JSON.stringify(planId)}`);
      })
      .catch((err: unknown) => {
        assert.ok(err instanceof WriteGateError);
      });
    assert.equal(performed, 0, `plan_id:${JSON.stringify(planId)} must not perform`);
  }
});

test('regression: a plan cannot be re-aimed at a higher tier than it was minted for', async () => {
  // Tier is bound, so an approval earned by previewing something the gate calls
  // `reversible` cannot be carried into the `spend` path — where it would be the
  // plan_id half of a confirmation the human never saw a spend prompt for.
  const { gate } = makeGate();
  const action = makeAction({
    tier: 'reversible',
    requirePlanId: true,
    perform: (): Promise<string> => Promise.resolve('ok'),
  });
  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');

  await assert.rejects(
    gate.execute({
      ...action,
      tier: 'spend',
      apply: true,
      planId: planned.preview.planId,
    }),
    (err: unknown) => err instanceof WriteGateError && err.code === 'plan_mismatch',
  );
});

// --- the caller-supplied verdict hooks are seams, not sources of truth -------

test('a classifyResult that returns no verdict cannot unsay a mutation that already landed', async () => {
  // Sibling of the throwing-classifier case above, and the more common shape of
  // the same bug: a hook with a branch that falls off the end, or a JS caller of
  // the barrel-exported `createWriteGate`, hands back something that is not a
  // verdict. `perform` has already resolved at that point — the mutation is at
  // Graph — so reading `.outcome` off it must not be what decides whether the
  // caller is told the write succeeded. An unusable verdict is the same
  // situation as a verdict that threw: it was never computed.
  const { gate, journal } = makeGate();
  let performed = 0;
  const action = makeAction({
    tier: 'reversible',
    params: { ids: ['a'] },
    perform: (): Promise<{ ok: boolean }> => {
      performed += 1;
      return Promise.resolve({ ok: true });
    },
    classifyResult: (() => undefined) as unknown as (r: {
      ok: boolean;
    }) => WriteResultVerdict,
  });

  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');
  const applied = await gate.execute({
    ...action,
    apply: true,
    planId: planned.preview.planId,
  });

  assert.ok(applied.kind === 'result');
  assert.equal(performed, 1);
  assert.equal(
    applied.result.applied,
    true,
    'the mutation landed and must be reported so',
  );
  assert.equal(journal.entries.length, 1, 'the landed write must still be journaled');
  assert.equal(journal.entries[0]?.outcome, 'applied');
  assert.ok(
    journal.entries[0]?.error?.includes('classification'),
    'the entry must admit the verdict was not computed',
  );
});

test('a malformed verdict never puts a non-boolean `applied` on the result envelope', async () => {
  // `ApplyResult.applied` is the one field every tool renders into its
  // `applied`/`not_applied` envelope. A hook that answers `applied: 'yes'`
  // currently passes that string straight through, and the envelope then states
  // something no consumer can read as a yes or a no.
  const { gate } = makeGate();
  const action = makeAction({
    tier: 'reversible',
    params: { ids: ['a'] },
    perform: (): Promise<{ ok: boolean }> => Promise.resolve({ ok: true }),
    classifyResult: (() => ({ outcome: 'failed', applied: 'yes' })) as unknown as (r: {
      ok: boolean;
    }) => WriteResultVerdict,
  });

  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');
  const applied = await gate.execute({
    ...action,
    apply: true,
    planId: planned.preview.planId,
  });

  assert.ok(applied.kind === 'result');
  assert.equal(
    typeof applied.result.applied,
    'boolean',
    'the envelope flag must be a boolean whatever the hook answered',
  );
});

test('a perform that REJECTED is never journaled as `applied`, whatever the classifier says', async () => {
  // `classifyOutcome` is typed to exclude `applied` precisely because the gate
  // is re-throwing the Graph error on this path — it already knows the write did
  // not come back confirmed. The type is not the control, though: the hook is an
  // injected seam and `createWriteGate` is exported from the package barrel. An
  // entry reading `applied` is the single worst line the journal can hold: it is
  // what an operator reconciles a mutation against, and it would be asserting a
  // change that the very same call reported as a failure.
  const { gate, journal } = makeGate();
  const action = makeAction({
    tier: 'reversible',
    params: { x: 1 },
    perform: (): Promise<string> =>
      Promise.reject(new Error('graph rejected: (#100) invalid parameter')),
    classifyOutcome: (() => 'applied') as unknown as (
      err: unknown,
    ) => Exclude<JournalOutcome, 'applied'>,
  });

  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');
  await assert.rejects(
    gate.execute({ ...action, apply: true, planId: planned.preview.planId }),
    /invalid parameter/,
  );

  assert.equal(journal.entries.length, 1);
  assert.equal(
    journal.entries[0]?.outcome,
    'attempted',
    'an unusable classification means the outcome is unknown, not confirmed',
  );
});

/** Types a deliberately non-Error throwable so it can be thrown or rejected. */
function notAnError(value: object): Error {
  return value as Error;
}

// --- non-Error throwables on the journaling paths ---------------------------

test('a non-Error perform rejection is journaled with its text and re-thrown unchanged', async () => {
  for (const [failure, expected] of [
    [{ message: 'graph said no' }, 'graph said no'],
    [Object.create(null) as object, 'unknown error (no message)'],
  ] as const) {
    const { gate, journal } = makeGate();
    const action = makeAction({
      tier: 'reversible',
      params: { x: 1 },
      perform: (): Promise<string> => Promise.reject(notAnError(failure)),
    });
    const planned = await gate.execute(action);
    assert.ok(planned.kind === 'preview');
    // The caller must see the ORIGINAL rejection, not a TypeError raised while
    // the gate was describing it for the journal.
    await assert.rejects(
      gate.execute({ ...action, apply: true, planId: planned.preview.planId }),
      (err: unknown) => err === failure,
    );
    assert.equal(journal.entries.length, 1);
    assert.equal(journal.entries[0]?.outcome, 'failed');
    assert.equal(journal.entries[0]?.error, expected);
  }
});

test('a classifyResult that throws a non-Error still leaves the landed write applied and journaled', async () => {
  for (const [thrown, expected] of [
    [{ message: 'bad shape' }, 'result classification failed: bad shape'],
    [
      Object.create(null) as object,
      'result classification failed: unknown error (no message)',
    ],
  ] as const) {
    const { gate, journal } = makeGate();
    const action = makeAction({
      tier: 'reversible',
      params: { ids: ['a'] },
      perform: (): Promise<Record<string, never>> => Promise.resolve({}),
      classifyResult: (): WriteResultVerdict => {
        throw notAnError(thrown);
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
    assert.equal(journal.entries.length, 1);
    assert.equal(journal.entries[0]?.outcome, 'applied');
    assert.equal(journal.entries[0]?.error, expected);
  }
});

test('a world that changes while the out-of-band confirmation is pending blocks the mutation', async () => {
  // The confirmation is the one await in the apply path that waits on a HUMAN:
  // an elicitation prompt can sit open for minutes. The divergence check the
  // preview promised has to hold at the moment the mutation runs, not merely at
  // the moment the prompt was raised — otherwise an approval given for the
  // previewed world is spent on a world nobody compared.
  let world = { message: 'original' };
  let confirmations = 0;
  const confirmer: Confirmer = {
    confirm: () => {
      confirmations += 1;
      // Someone edits the object while the operator is reading the prompt.
      world = { message: 'edited while the prompt was open' };
      return Promise.resolve({ confirmed: true, method: 'elicitation' as const });
    },
  };
  const { gate, journal } = makeGate({ confirmer });
  let performed = 0;
  const action = makeAction({
    tier: 'irreversible',
    readState: (): Promise<{ message: string }> => Promise.resolve({ ...world }),
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

  assert.equal(confirmations, 1);
  assert.equal(
    performed,
    0,
    'a world that moved during confirmation must not be mutated',
  );
  assert.ok(applied.kind === 'result');
  assert.equal(applied.result.applied, false);
  assert.deepEqual(applied.result.diverged, [
    {
      field: 'message',
      expected: 'original',
      actual: 'edited while the prompt was open',
    },
  ]);
  assert.equal(journal.entries.length, 0, 'nothing was sent, so nothing is journaled');
});

test('regression: an unchanged world is re-read after confirmation and the write still applies', async () => {
  let reads = 0;
  const { gate } = makeGate();
  let performed = 0;
  const action = makeAction({
    tier: 'spend',
    readState: (): Promise<{ budget: number }> => {
      reads += 1;
      return Promise.resolve({ budget: 100 });
    },
    perform: (): Promise<string> => {
      performed += 1;
      return Promise.resolve('ok');
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
  assert.ok(reads >= 2);
});

test('an apply that races an in-flight apply of the same plan is told the truth, not "expired"', async () => {
  // The first apply has claimed the plan and is waiting on the operator's
  // confirmation prompt, which can sit open for minutes; an MCP client that
  // times the request out and re-sends it lands here. Told the plan is
  // "expired, already applied, or never created", the model's move is to
  // re-plan and apply again — a second write racing the first. The plan is
  // neither: it is in use, and it comes back if the operator declines.
  let answer: (confirmed: boolean) => void = () => undefined;
  const confirmer: Confirmer = {
    confirm: () =>
      new Promise((resolve) => {
        answer = (confirmed): void => {
          resolve(
            confirmed
              ? { confirmed: true, method: 'elicitation' }
              : { confirmed: false, method: 'denied' },
          );
        };
      }),
  };
  const { gate } = makeGate({ confirmer });
  let performed = 0;
  const action = makeAction({
    tier: 'irreversible',
    perform: (): Promise<string> => {
      performed += 1;
      return Promise.resolve('gone');
    },
  });
  const planned = await gate.execute(action);
  assert.ok(planned.kind === 'preview');
  const { planId } = planned.preview;

  const first = gate.execute({ ...action, apply: true, planId });
  // Let the first apply reach the (pending) confirmation.
  await new Promise<void>((resolve) => setImmediate(resolve));

  await assert.rejects(
    gate.execute({ ...action, apply: true, planId }),
    (err: unknown) => {
      assert.ok(err instanceof WriteGateError);
      assert.equal(err.code, 'plan_not_found');
      assert.match(err.message, /in progress/);
      assert.doesNotMatch(err.message, /expired|already applied|never created/);
      return true;
    },
  );

  // The operator declines: the plan is handed back, so it was never spent.
  answer(false);
  await assert.rejects(
    first,
    (err: unknown) => err instanceof WriteGateError && err.code === 'confirmation_denied',
  );
  const retried = gate.execute({ ...action, apply: true, planId });
  await new Promise<void>((resolve) => setImmediate(resolve));
  answer(true);
  const applied = await retried;
  assert.ok(applied.kind === 'result');
  assert.equal(applied.result.applied, true);
  assert.equal(performed, 1);

  // Once the plan is really spent, the ordinary answer returns.
  await assert.rejects(
    gate.execute({ ...action, apply: true, planId }),
    (err: unknown) =>
      err instanceof WriteGateError &&
      err.code === 'plan_not_found' &&
      /already applied/.test(err.message),
  );
});
