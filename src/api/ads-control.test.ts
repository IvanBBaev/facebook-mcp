// Tests for the ads CONTROL api module (task V10): the pure planner, the budget
// ceiling refusal (CC-ADS-7), minor-unit validation (CC-ADS-3), the read-only
// archived/deleted guard (CC-ADS-4) and the single write call. Every Graph call
// goes through the injected fake — no network, ever.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeFbRequest, fbOk, fbErr } from '../core/fakes/index.js';
import { GraphApiError, classifyGraphError } from '../core/index.js';

import { normalizeAdNode, type AdRecord } from './ads-read.js';
import {
  BUDGET_OVERWRITE_NOTE,
  CBO_CONFLICT_NOTE,
  LIFETIME_NEEDS_END_NOTE,
  RESUME_NOT_DELIVERY_NOTE,
  applyAdObjectUpdate,
  mapUpdateError,
  planAdObjectUpdate,
  resolveSettableStatus,
  updateAdObjectRequest,
  validateBudgetMinor,
  type AdUpdateContext,
} from './ads-control.js';

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const OBJECT_ID = '23851234567890123';

function current(overrides: Record<string, unknown> = {}): AdRecord {
  return normalizeAdNode({
    id: OBJECT_ID,
    name: 'Summer sale',
    status: 'PAUSED',
    effective_status: 'PAUSED',
    daily_budget: '1000',
    ...overrides,
  });
}

function ctx(overrides: Partial<AdUpdateContext> = {}): AdUpdateContext {
  return { current: current(), currency: 'USD', ...overrides };
}

function graphError(code: number, message: string, subcode?: number): GraphApiError {
  return new GraphApiError(message, {
    code,
    ...(subcode !== undefined ? { subcode } : {}),
    httpStatus: 400,
    action: classifyGraphError({
      code,
      message,
      ...(subcode !== undefined ? { error_subcode: subcode } : {}),
    }),
  });
}

function throwsGraph(fn: () => unknown): GraphApiError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof GraphApiError, `expected GraphApiError, got ${String(err)}`);
    return err;
  }
  throw new Error('expected the call to throw');
}

async function rejectsGraph(promise: Promise<unknown>): Promise<GraphApiError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof GraphApiError, `expected GraphApiError, got ${String(err)}`);
    return err;
  }
  throw new Error('expected the promise to reject');
}

// ---------------------------------------------------------------------------
// Status validation
// ---------------------------------------------------------------------------

test('resolveSettableStatus accepts ACTIVE/PAUSED in any case', () => {
  assert.equal(resolveSettableStatus('active'), 'ACTIVE');
  assert.equal(resolveSettableStatus(' Paused '), 'PAUSED');
});

test('deleting or archiving through the status field is refused as out of scope', () => {
  for (const status of ['DELETED', 'ARCHIVED']) {
    const err = throwsGraph(() => resolveSettableStatus(status));
    assert.match(err.message, /out of scope/);
  }
  const err = throwsGraph(() => resolveSettableStatus('RUNNING'));
  assert.match(err.message, /ACTIVE to resume or PAUSED to pause/);
});

// ---------------------------------------------------------------------------
// CC-ADS-3 — minor units, integers only
// ---------------------------------------------------------------------------

test('CC-ADS-3: a fractional budget is refused with the 100x mistake spelled out', () => {
  const err = throwsGraph(() => validateBudgetMinor('daily_budget_minor', 10.5));
  assert.match(err.message, /MINOR currency units/);
  assert.match(err.message, /1000 means 10\.00/);
});

test('CC-ADS-3: a negative budget is refused', () => {
  const err = throwsGraph(() => validateBudgetMinor('daily_budget_minor', -1));
  assert.match(err.message, /must not be negative/);
});

test('CC-ADS-3: the plan echoes the ad account currency alongside the minor amount', () => {
  const plan = planAdObjectUpdate(
    { objectId: OBJECT_ID, level: 'campaign', dailyBudgetMinor: 2500 },
    ctx(),
  );
  assert.equal(plan.currency, 'USD');
  assert.match(plan.summary, /2500 minor units of USD/);
  assert.equal(plan.params.daily_budget, 2500);
  // The wire value is the integer itself — no float, no formatting.
  assert.equal(typeof plan.params.daily_budget, 'number');
});

// ---------------------------------------------------------------------------
// CC-ADS-7 — the budget ceiling refuses, never clamps
// ---------------------------------------------------------------------------

test('CC-ADS-7: a raise above FB_ADS_BUDGET_CEILING is refused, not clamped', () => {
  const err = throwsGraph(() =>
    planAdObjectUpdate(
      { objectId: OBJECT_ID, level: 'campaign', dailyBudgetMinor: 50_000 },
      ctx({ budgetCeilingMinor: 20_000 }),
    ),
  );
  assert.match(err.message, /FB_ADS_BUDGET_CEILING/);
  assert.match(err.message, /50000 minor units of USD/);
  assert.match(err.message, /20000 minor units of USD/);
  assert.match(err.message, /NOT reduced to the ceiling/);
  assert.match(err.message, /NOTHING was changed/);
});

test('CC-ADS-7: a budget exactly at the ceiling is allowed', () => {
  const plan = planAdObjectUpdate(
    { objectId: OBJECT_ID, level: 'campaign', dailyBudgetMinor: 20_000 },
    ctx({ budgetCeilingMinor: 20_000 }),
  );
  assert.equal(plan.params.daily_budget, 20_000);
});

test('CC-ADS-7: lowering an already over-ceiling budget is allowed (no trap above the cap)', () => {
  const plan = planAdObjectUpdate(
    { objectId: OBJECT_ID, level: 'campaign', dailyBudgetMinor: 40_000 },
    ctx({ current: current({ daily_budget: '90000' }), budgetCeilingMinor: 20_000 }),
  );
  assert.equal(plan.params.daily_budget, 40_000);
});

test('CC-ADS-7: with no ceiling configured the raise goes through', () => {
  const plan = planAdObjectUpdate(
    { objectId: OBJECT_ID, level: 'campaign', dailyBudgetMinor: 999_999 },
    ctx(),
  );
  assert.equal(plan.params.daily_budget, 999_999);
});

// ---------------------------------------------------------------------------
// Tier assignment (both tiers are high-consequence and never env-bypassed)
// ---------------------------------------------------------------------------

test('resuming to ACTIVE is spend-tier and warns that ACTIVE is not delivery', () => {
  const plan = planAdObjectUpdate({ objectId: OBJECT_ID, status: 'ACTIVE' }, ctx());
  assert.equal(plan.tier, 'spend');
  assert.equal(plan.increasesSpend, true);
  assert.ok(plan.warnings.includes(RESUME_NOT_DELIVERY_NOTE));
});

test('pausing is irreversible-tier (it still summons the confirmer, but spends nothing)', () => {
  const plan = planAdObjectUpdate(
    { objectId: OBJECT_ID, status: 'PAUSED' },
    ctx({ current: current({ status: 'ACTIVE', effective_status: 'ACTIVE' }) }),
  );
  assert.equal(plan.tier, 'irreversible');
  assert.equal(plan.increasesSpend, false);
});

test('a budget raise is spend-tier; a budget cut is irreversible-tier', () => {
  const raise = planAdObjectUpdate(
    { objectId: OBJECT_ID, level: 'campaign', dailyBudgetMinor: 5000 },
    ctx(),
  );
  assert.equal(raise.tier, 'spend');

  const cut = planAdObjectUpdate(
    { objectId: OBJECT_ID, level: 'campaign', dailyBudgetMinor: 500 },
    ctx(),
  );
  assert.equal(cut.tier, 'irreversible');
  assert.ok(cut.warnings.includes(BUDGET_OVERWRITE_NOTE));
});

test('an unknown current budget is treated as a raise (the costlier reading)', () => {
  const plan = planAdObjectUpdate(
    { objectId: OBJECT_ID, level: 'campaign', dailyBudgetMinor: 100 },
    ctx({ current: current({ daily_budget: undefined }) }),
  );
  assert.equal(plan.tier, 'spend');
});

test('a mixed pause + raise takes the higher tier', () => {
  const plan = planAdObjectUpdate(
    { objectId: OBJECT_ID, level: 'campaign', status: 'PAUSED', dailyBudgetMinor: 9000 },
    ctx({ current: current({ status: 'ACTIVE', effective_status: 'ACTIVE' }) }),
  );
  assert.equal(plan.tier, 'spend');
  assert.equal(plan.changes.length, 2);
});

// ---------------------------------------------------------------------------
// CC-ADS-4 — archived / deleted objects are read-only
// ---------------------------------------------------------------------------

test('CC-ADS-4: an ARCHIVED object is refused before anything reaches the wire', () => {
  const err = throwsGraph(() =>
    planAdObjectUpdate(
      { objectId: OBJECT_ID, status: 'ACTIVE' },
      ctx({ current: current({ status: 'ARCHIVED', effective_status: 'ARCHIVED' }) }),
    ),
  );
  assert.match(err.message, /read-only/);
  assert.match(err.message, /Nothing was changed/);
});

test('CC-ADS-4: a DELETED object is refused even when only the effective status says so', () => {
  const err = throwsGraph(() =>
    planAdObjectUpdate(
      { objectId: OBJECT_ID, dailyBudgetMinor: 100, level: 'campaign' },
      ctx({ current: current({ status: 'PAUSED', effective_status: 'DELETED' }) }),
    ),
  );
  assert.match(err.message, /DELETED/);
});

test('CC-ADS-4: a bare Graph 100 on the write is re-mapped to "gone or archived"', () => {
  const mapped = mapUpdateError(graphError(100, 'Unsupported post request.'), OBJECT_ID);
  assert.ok(mapped instanceof GraphApiError);
  assert.match(mapped.message, /DELETED or ARCHIVED/);
  assert.match(mapped.message, /Nothing was changed/);
  assert.equal(mapped.code, 100);
});

test('CC-ADS-4: an error that already has a subcode keeps its own diagnosis', () => {
  const original = graphError(100, 'Invalid parameter', 1487534);
  assert.equal(mapUpdateError(original, OBJECT_ID), original);
  const other = graphError(190, 'Invalid OAuth access token');
  assert.equal(mapUpdateError(other, OBJECT_ID), other);
  const plain = new Error('socket hang up');
  assert.equal(mapUpdateError(plain, OBJECT_ID), plain);
});

// ---------------------------------------------------------------------------
// Planner guards
// ---------------------------------------------------------------------------

test('an empty change set is refused rather than sending a no-op write', () => {
  const err = throwsGraph(() => planAdObjectUpdate({ objectId: OBJECT_ID }, ctx()));
  assert.match(err.message, /Nothing to change/);
});

test('daily and lifetime budgets cannot be set in the same call', () => {
  const err = throwsGraph(() =>
    planAdObjectUpdate(
      {
        objectId: OBJECT_ID,
        level: 'adset',
        dailyBudgetMinor: 100,
        lifetimeBudgetMinor: 200,
      },
      ctx(),
    ),
  );
  assert.match(err.message, /not both/);
});

test('an ad has no budget of its own and the error says where to set it', () => {
  const err = throwsGraph(() =>
    planAdObjectUpdate(
      { objectId: OBJECT_ID, level: 'ad', dailyBudgetMinor: 100 },
      ctx(),
    ),
  );
  assert.match(err.message, /ad set/);
});

test('an ad-set budget change warns about campaign budget optimisation', () => {
  const plan = planAdObjectUpdate(
    { objectId: OBJECT_ID, level: 'adset', dailyBudgetMinor: 100 },
    ctx(),
  );
  assert.ok(plan.warnings.includes(CBO_CONFLICT_NOTE));
});

test('a lifetime budget without an end time warns that Graph will reject it', () => {
  const plan = planAdObjectUpdate(
    { objectId: OBJECT_ID, level: 'adset', lifetimeBudgetMinor: 100_000 },
    ctx(),
  );
  assert.ok(plan.warnings.includes(LIFETIME_NEEDS_END_NOTE));

  const withEnd = planAdObjectUpdate(
    { objectId: OBJECT_ID, level: 'adset', lifetimeBudgetMinor: 100_000 },
    ctx({ current: current({ end_time: '2026-09-01T00:00:00+0000' }) }),
  );
  assert.equal(withEnd.warnings.includes(LIFETIME_NEEDS_END_NOTE), false);
});

test('a no-op status change is planned but flagged as changing nothing', () => {
  const plan = planAdObjectUpdate({ objectId: OBJECT_ID, status: 'PAUSED' }, ctx());
  assert.ok(plan.warnings.some((warning) => /already PAUSED/.test(warning)));
});

test('the summary states both the old and the new value of every change', () => {
  const plan = planAdObjectUpdate(
    { objectId: OBJECT_ID, level: 'campaign', status: 'ACTIVE', dailyBudgetMinor: 2000 },
    ctx(),
  );
  assert.match(plan.summary, /status: PAUSED -> ACTIVE/);
  assert.match(
    plan.summary,
    /daily_budget: 1000 minor units of USD -> 2000 minor units of USD/,
  );
});

// ---------------------------------------------------------------------------
// The write call
// ---------------------------------------------------------------------------

test('updateAdObjectRequest POSTs the planned params to the object id', () => {
  const req = updateAdObjectRequest(OBJECT_ID, { status: 'PAUSED' });
  assert.equal(req.method, 'POST');
  assert.equal(req.host, 'graph');
  assert.equal(req.path, `/${OBJECT_ID}`);
  assert.deepEqual(req.body, { status: 'PAUSED' });
  // No page id and no token override: ad accounts are read with the user or
  // system token, never a Page token.
  assert.equal(req.pageId, undefined);
  assert.equal(req.token, undefined);
});

test('applyAdObjectUpdate performs the write and reports the applied changes', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk({ success: true }));

  const plan = planAdObjectUpdate({ objectId: OBJECT_ID, status: 'ACTIVE' }, ctx());
  const outcome = await applyAdObjectUpdate(fake.fn, plan);

  assert.equal(fake.calls.length, 1);
  assert.equal(outcome.success, true);
  assert.equal(outcome.applied.length, 1);
  assert.equal(outcome.applied[0]?.to, 'ACTIVE');
});

test('applyAdObjectUpdate maps a bare 100 failure through the archived diagnosis', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbErr(graphError(100, 'Unsupported post request.')));

  const plan = planAdObjectUpdate({ objectId: OBJECT_ID, status: 'ACTIVE' }, ctx());
  const err = await rejectsGraph(applyAdObjectUpdate(fake.fn, plan));

  assert.match(err.message, /DELETED or ARCHIVED/);
});

test('a Graph success:false is reported as a failed write rather than assumed fine', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk({ success: false }));

  const plan = planAdObjectUpdate({ objectId: OBJECT_ID, status: 'ACTIVE' }, ctx());
  const outcome = await applyAdObjectUpdate(fake.fn, plan);

  assert.equal(outcome.success, false);
});
