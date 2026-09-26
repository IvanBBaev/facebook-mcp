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
  LIFETIME_END_UNVERIFIED_NOTE,
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

function throwsGraph(
  fn: () => unknown,
  label = 'expected the call to throw',
): GraphApiError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof GraphApiError, `expected GraphApiError, got ${String(err)}`);
    return err;
  }
  throw new Error(label);
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

test('CC-ADS-3: the fractional refusal does not claim every currency divides by 100', () => {
  // The example is only true for a two-decimal currency. Stated flat, it teaches
  // an operator on a JPY account the exact 100x reading this module exists to
  // prevent, in the message they read while fixing their input.
  const err = throwsGraph(() => validateBudgetMinor('daily_budget_minor', 10.5));
  assert.match(err.message, /zero-decimal/);
  assert.match(err.message, /JPY/);
});

test('CC-ADS-3: the fractional refusal defines the unit by Meta offset, not the ISO subunit', () => {
  // TWD has an ISO subunit but Meta counts it whole; BHD has an ISO 1/1000 but
  // Meta counts hundredths. "The smallest unit the currency has" is wrong for both.
  const err = throwsGraph(() => validateBudgetMinor('daily_budget_minor', 10.5));
  assert.doesNotMatch(err.message, /smallest unit/);
  assert.match(err.message, /currency offset/);
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

test('CC-ADS-3: a zero-decimal currency amount is not labelled "minor units"', () => {
  // Meta takes the budget in the account currency's SMALLEST unit, and JPY has
  // no subunit: 2500 is 2500 JPY. "2500 minor units of JPY" reads as 25.00 to
  // anyone who knows what a minor unit is — a hundredfold understatement in the
  // single line the operator confirms before a spend-tier write.
  const plan = planAdObjectUpdate(
    { objectId: OBJECT_ID, level: 'campaign', dailyBudgetMinor: 2500 },
    ctx({ currency: 'JPY' }),
  );
  assert.doesNotMatch(plan.summary, /minor units/);
  assert.match(plan.summary, /2500 JPY/);
});

test('CC-ADS-3: a zero-decimal currency plan warns that the amount is whole units', () => {
  const plan = planAdObjectUpdate(
    { objectId: OBJECT_ID, level: 'campaign', dailyBudgetMinor: 2500 },
    ctx({ currency: 'JPY' }),
  );
  assert.ok(
    plan.warnings.some((warning) => /JPY has no minor unit/.test(warning)),
    plan.warnings.join(' | '),
  );
  assert.ok(
    plan.warnings.some((warning) => /not one hundredth/.test(warning)),
    plan.warnings.join(' | '),
  );
});

test('CC-ADS-3: a two-decimal currency keeps the minor-unit wording', () => {
  const plan = planAdObjectUpdate(
    { objectId: OBJECT_ID, level: 'campaign', dailyBudgetMinor: 2500 },
    ctx({ currency: 'EUR' }),
  );
  assert.match(plan.summary, /2500 minor units of EUR/);
  assert.equal(
    plan.warnings.some((warning) => /no minor unit/.test(warning)),
    false,
  );
});

test('CC-ADS-3: Meta offset-1 currencies with an ISO subunit (TWD, HUF, IDR, COP, CRC) are stated in whole units', () => {
  // Meta's currency table (marketing-api/currencies) gives these an offset of 1
  // although ISO 4217 gives them two decimals: `daily_budget=1000` on a TWD
  // account is 1000 TWD. Labelling it "1000 minor units of TWD" tells the
  // operator 10.00 TWD — a hundredfold understatement in the confirm line.
  for (const currency of ['TWD', 'HUF', 'IDR', 'COP', 'CRC']) {
    const plan = planAdObjectUpdate(
      { objectId: OBJECT_ID, level: 'campaign', dailyBudgetMinor: 2500 },
      ctx({ currency }),
    );
    assert.doesNotMatch(plan.summary, /minor units/, `${currency}: ${plan.summary}`);
    assert.match(
      plan.summary,
      new RegExp(`2500 ${currency}`),
      `${currency}: ${plan.summary}`,
    );
    assert.ok(
      plan.warnings.some((warning) => /not one hundredth/.test(warning)),
      `${currency}: ${plan.warnings.join(' | ')}`,
    );
  }
});

test('CC-ADS-3: a three-decimal ISO currency Meta counts in hundredths (BHD, JOD) is not called "minor units"', () => {
  // ISO 4217 gives BHD/JOD three decimals (the minor unit is 1/1000), but Meta's
  // offset for both is 100: `daily_budget=2500` is 25.00 BHD. "2500 minor units
  // of BHD" reads as 2.500 BHD — a tenfold understatement.
  for (const currency of ['BHD', 'JOD']) {
    const plan = planAdObjectUpdate(
      { objectId: OBJECT_ID, level: 'campaign', dailyBudgetMinor: 2500 },
      ctx({ currency }),
    );
    assert.doesNotMatch(plan.summary, /minor units/, `${currency}: ${plan.summary}`);
    assert.match(
      plan.summary,
      new RegExp(`2500 hundredths of ${currency} \\(25\\.00 ${currency}\\)`),
      `${currency}: ${plan.summary}`,
    );
    assert.ok(
      plan.warnings.some((warning) => warning.includes('1/1000')),
      `${currency}: ${plan.warnings.join(' | ')}`,
    );
  }
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

test('CC-ADS-7: the refusal states a zero-decimal ceiling in whole units', () => {
  const err = throwsGraph(() =>
    planAdObjectUpdate(
      { objectId: OBJECT_ID, level: 'campaign', dailyBudgetMinor: 50_000 },
      ctx({ currency: 'JPY', budgetCeilingMinor: 20_000 }),
    ),
  );
  assert.match(err.message, /50000 JPY/);
  assert.match(err.message, /20000 JPY/);
  assert.doesNotMatch(err.message, /minor units/);
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

test("CC-ADS-4: the re-mapped error keeps Graph's human-readable userTitle/userMessage", () => {
  // The error record the model sees is built from the TOP-LEVEL error's fields
  // (index.ts buildErrorRecord); `cause` is not rendered. On an ads refusal
  // `error_user_title`/`error_user_msg` are often the only concrete reason, so
  // dropping them in the re-map loses the one sentence the model could act on.
  const original = new GraphApiError('Unsupported post request.', {
    code: 100,
    httpStatus: 400,
    fbtraceId: 'AbCdEf',
    userTitle: 'Ad Set Archived',
    userMessage: 'This ad set is archived and cannot be edited.',
    action: classifyGraphError({ code: 100, message: 'Unsupported post request.' }),
  });
  const mapped = mapUpdateError(original, OBJECT_ID);
  assert.ok(mapped instanceof GraphApiError);
  assert.match(mapped.message, /DELETED or ARCHIVED/);
  assert.equal(mapped.userTitle, 'Ad Set Archived');
  assert.equal(mapped.userMessage, 'This ad set is archived and cannot be edited.');
  assert.equal(mapped.fbtraceId, 'AbCdEf');
  // The action is restated for the gone/archived diagnosis (see the next test);
  // the core retry verdict it carried is kept.
  assert.equal(mapped.action?.retryable, original.action?.retryable);
  assert.equal(mapped.cause, original);
});

test('CC-ADS-4: the re-mapped error sends the model to the ad-object read, not to fix its arguments', () => {
  // The model reads `action` / `category` / `nextTool` as flat fields beside the
  // message (index.ts buildErrorRecord). Keeping the code-100 validation action
  // pairs "the object may be DELETED or ARCHIVED — re-read it" with "fix the
  // arguments; retrying unchanged will fail identically" and no next tool: the
  // exact wrong turn the re-map exists to prevent.
  const original = graphError(100, 'Unsupported post request.');
  assert.equal(original.action?.category, 'validation');
  const mapped = mapUpdateError(original, OBJECT_ID);
  assert.ok(mapped instanceof GraphApiError);
  assert.equal(mapped.action?.nextTool, 'facebook_get_ad_object');
  assert.equal(mapped.action?.category, 'not_found');
  assert.equal(mapped.action?.retryable, false);
  assert.doesNotMatch(mapped.action?.operatorText ?? '', /fix the arguments/);
  assert.match(mapped.action?.operatorText ?? '', /facebook_get_ad_object/);
});

test('CC-ADS-4: the real wire shape of the refusal (100/33) is re-mapped too', () => {
  // Graph's "Unsupported post request ... does not exist, cannot be loaded due
  // to missing permissions, or does not support this operation" arrives as code
  // 100 WITH error_subcode 33. Left alone it hits the generic 100/33 row, which
  // tells the model to "treat it as already gone" — false for an archived
  // object that still exists — and names no read to check it with.
  const original = graphError(
    100,
    "Unsupported post request. Object with ID '23851234567890123' does not exist, cannot be loaded due to missing permissions, or does not support this operation.",
    33,
  );
  assert.match(original.action?.operatorText ?? '', /already gone/);
  const mapped = mapUpdateError(original, OBJECT_ID);
  assert.ok(mapped instanceof GraphApiError);
  assert.notEqual(mapped, original);
  assert.match(mapped.message, /DELETED or ARCHIVED/);
  assert.equal(mapped.subcode, 33);
  assert.equal(mapped.action?.nextTool, 'facebook_get_ad_object');
  assert.doesNotMatch(mapped.action?.operatorText ?? '', /already gone/);
});

test('CC-ADS-4: the re-mapped refusal names a missing edit permission as a cause', () => {
  // Graph's own text lists "missing permissions" as one of three causes, and in
  // the tool flow the pre-read already succeeded and showed the object neither
  // archived nor deleted — so a token with ads_read but not ads_management is
  // the likeliest cause. A diagnosis that names only "deleted, archived or not
  // on this account" sends the model to re-read a live object and stop there.
  const mapped = mapUpdateError(
    graphError(100, 'Unsupported post request.', 33),
    OBJECT_ID,
  );
  assert.ok(mapped instanceof GraphApiError);
  assert.match(mapped.message, /ads_management/);
  assert.match(mapped.action?.operatorText ?? '', /ads_management/);
});

test('CC-ADS-4: a DELETED object is not sent to Ads Manager to be restored', () => {
  // Meta cannot restore a deleted campaign, ad set or ad — deletion is final,
  // unlike archiving. "Restore it in Ads Manager first" is a next step that
  // does not exist for DELETED.
  const deleted = throwsGraph(() =>
    planAdObjectUpdate(
      { objectId: OBJECT_ID, status: 'ACTIVE' },
      ctx({ current: current({ status: 'DELETED', effective_status: 'DELETED' }) }),
    ),
  );
  assert.doesNotMatch(deleted.message, /Restore it/);
  assert.match(deleted.message, /cannot be restored/);
  assert.match(deleted.message, /Nothing was changed/);
  // Archived is the recoverable case and keeps its restore advice.
  const archived = throwsGraph(() =>
    planAdObjectUpdate(
      { objectId: OBJECT_ID, status: 'ACTIVE' },
      ctx({ current: current({ status: 'ARCHIVED', effective_status: 'ARCHIVED' }) }),
    ),
  );
  assert.match(archived.message, /Ads Manager/);
  assert.doesNotMatch(archived.message, /cannot be restored/);
});

test('CC-ADS-4: an error that already has a subcode keeps its own diagnosis', () => {
  const original = graphError(100, 'Invalid parameter', 1487534);
  assert.equal(mapUpdateError(original, OBJECT_ID), original);
  const other = graphError(190, 'Invalid OAuth access token');
  assert.equal(mapUpdateError(other, OBJECT_ID), other);
  const plain = new Error('socket hang up');
  assert.equal(mapUpdateError(plain, OBJECT_ID), plain);
});

test('CC-ADS-4: a bare 100 that names a bad parameter keeps its own diagnosis', () => {
  // Graph answers a genuine parameter fault with a bare code 100 and no subcode
  // too. Re-mapping THAT to "the object may be DELETED or ARCHIVED" asserts a
  // cause nothing established and sends the model to re-read a live object
  // instead of fixing its request.
  for (const message of [
    '(#100) Param daily_budget must be a positive integer',
    'Tried accessing nonexisting field (bid_amount) on node type (Campaign)',
    '(#100) The status field is required',
  ]) {
    const original = graphError(100, message);
    assert.equal(
      mapUpdateError(original, OBJECT_ID),
      original,
      `parameter fault re-diagnosed: ${message}`,
    );
  }
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

test('a budget write of the kind the object does not use names the budget it does use', () => {
  // Graph reads an ad set on a lifetime budget back with `daily_budget: "0"`.
  // Without a note the preview says "daily_budget: 0 -> 2000", which reads as
  // adding a budget to an object that has none, while the object is really
  // spending against a 50000 lifetime budget and Meta does not switch a live
  // object between budget kinds.
  const plan = planAdObjectUpdate(
    { objectId: OBJECT_ID, level: 'adset', dailyBudgetMinor: 2000 },
    ctx({ current: current({ daily_budget: '0', lifetime_budget: '50000' }) }),
  );
  assert.ok(
    plan.warnings.some(
      (w) =>
        /lifetime_budget of 50000 minor units of USD/.test(w) &&
        /daily_budget/.test(w) &&
        /reject/.test(w),
    ),
    `no budget-kind warning in ${JSON.stringify(plan.warnings)}`,
  );

  // The mirror case, and absence on an ordinary same-kind change.
  const toLifetime = planAdObjectUpdate(
    { objectId: OBJECT_ID, level: 'campaign', lifetimeBudgetMinor: 90_000 },
    ctx({ current: current({ daily_budget: '1000', stop_time: '2027-01-01' }) }),
  );
  assert.ok(
    toLifetime.warnings.some((w) => /daily_budget of 1000 minor units of USD/.test(w)),
  );
  const sameKind = planAdObjectUpdate(
    { objectId: OBJECT_ID, level: 'campaign', dailyBudgetMinor: 2000 },
    ctx({ current: current({ daily_budget: '1000', lifetime_budget: '0' }) }),
  );
  assert.equal(
    sameKind.warnings.some((w) => /budget kind/.test(w)),
    false,
  );
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

test('updateAdObjectRequest names facebook_get_ad_object as the verify tool for a lost response', () => {
  // `POST /<object-id>` says nothing about what the id is; without the api
  // layer naming the read, an ambiguous status/budget write surfaces with no
  // verify tool (or, before the wave-18 seam, facebook_list_posts — a Page feed
  // listing that can never show an ad object's status or budget).
  const req = updateAdObjectRequest(OBJECT_ID, { status: 'PAUSED' });
  assert.equal(req.verifyTool, 'facebook_get_ad_object');
});

test('applyAdObjectUpdate sends every write kind with the ad-object verify tool', async () => {
  const plans = [
    planAdObjectUpdate({ objectId: OBJECT_ID, status: 'ACTIVE' }, ctx()),
    planAdObjectUpdate({ objectId: OBJECT_ID, status: 'PAUSED' }, ctx()),
    planAdObjectUpdate(
      { objectId: OBJECT_ID, level: 'campaign', dailyBudgetMinor: 2500 },
      ctx(),
    ),
    planAdObjectUpdate(
      { objectId: OBJECT_ID, level: 'campaign', lifetimeBudgetMinor: 90000 },
      ctx(),
    ),
  ];
  for (const plan of plans) {
    const fake = createFakeFbRequest();
    fake.on(() => true, fbOk({ success: true }));
    await applyAdObjectUpdate(fake.fn, plan);
    assert.equal(fake.calls.length, 1);
    const sent = fake.lastRequest();
    assert.equal(sent?.method, 'POST');
    assert.equal(
      sent?.verifyTool,
      'facebook_get_ad_object',
      `no verify tool on ${JSON.stringify(plan.params)}`,
    );
  }
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

test('an abort mid-flight keeps its own error and reports no write at all', async () => {
  // Regression cover: `mapUpdateError` only rewrites a bare Graph 100. An abort
  // is not a GraphApiError, so it must pass through untouched — never become a
  // "gone or archived" diagnosis, and never resolve into an outcome that says a
  // budget moved while the request was cut off in flight.
  const fake = createFakeFbRequest();
  const aborted = new Error('The operation was aborted');
  aborted.name = 'AbortError';
  fake.on(() => true, fbErr(aborted));

  const plan = planAdObjectUpdate(
    { objectId: OBJECT_ID, level: 'campaign', dailyBudgetMinor: 2500 },
    ctx(),
  );
  await assert.rejects(applyAdObjectUpdate(fake.fn, plan), (thrown: unknown) => {
    assert.ok(thrown instanceof Error);
    assert.equal(thrown.name, 'AbortError');
    assert.equal(thrown instanceof GraphApiError, false);
    assert.doesNotMatch(thrown.message, /DELETED or ARCHIVED/);
    return true;
  });
});

test('a success flag that is not the documented boolean is not a confirmed write', async () => {
  const fake = createFakeFbRequest();
  // `body.success !== false` reads the STRING "false" as a success, so a budget
  // or status change Facebook refused comes back with `applied` changes it never
  // made — a write journalled as done that moved nothing.
  fake.on(() => true, fbOk({ success: 'false' }));

  const plan = planAdObjectUpdate({ objectId: OBJECT_ID, status: 'ACTIVE' }, ctx());
  const outcome = await applyAdObjectUpdate(fake.fn, plan);

  assert.equal(outcome.success, false);
});

test('a Graph success:false is reported as a failed write rather than assumed fine', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk({ success: false }));

  const plan = planAdObjectUpdate({ objectId: OBJECT_ID, status: 'ACTIVE' }, ctx());
  const outcome = await applyAdObjectUpdate(fake.fn, plan);

  assert.equal(outcome.success, false);
});

test('a refused write does not hand back a list of changes as applied', async () => {
  const fake = createFakeFbRequest();
  // `success: false` is Facebook declining the edit. The outcome object is what
  // the write gate journals and shows the model, so an `applied` list filled in
  // from the PLAN — the changes we asked for, not the ones the account took —
  // is the server telling the operator a budget moved when it did not.
  fake.on(() => true, fbOk({ success: false }));

  const plan = planAdObjectUpdate(
    { objectId: OBJECT_ID, level: 'campaign', dailyBudgetMinor: 500_000 },
    ctx(),
  );
  const outcome = await applyAdObjectUpdate(fake.fn, plan);

  assert.equal(outcome.success, false);
  assert.deepEqual(outcome.applied, []);
});

test('a bare false or null 2xx body is not a confirmed ad update', async () => {
  // A 2xx whose body is the bare JSON `false` (or `null`) is Graph declining the
  // edit, the same answer the comments and posts writes already refuse to read
  // as a confirmation. Collapsing it to `{}` made the missing `success` flag look
  // like "absent, so fine", and the gate journalled a budget change as applied.
  for (const answer of [false, null, 0, 'false']) {
    const fake = createFakeFbRequest();
    fake.on(() => true, fbOk(answer));

    const plan = planAdObjectUpdate(
      { objectId: OBJECT_ID, level: 'campaign', dailyBudgetMinor: 500_000 },
      ctx(),
    );
    const outcome = await applyAdObjectUpdate(fake.fn, plan);

    assert.equal(
      outcome.success,
      false,
      `body ${JSON.stringify(answer)} is not a confirmation`,
    );
    assert.deepEqual(outcome.applied, []);
  }
});

test('an empty 2xx body or a bare true still confirms the ad update', async () => {
  for (const answer of [undefined, true, {}, { success: true }]) {
    const fake = createFakeFbRequest();
    fake.on(() => true, fbOk(answer));

    const plan = planAdObjectUpdate({ objectId: OBJECT_ID, status: 'ACTIVE' }, ctx());
    const outcome = await applyAdObjectUpdate(fake.fn, plan);

    assert.equal(outcome.success, true, `body ${JSON.stringify(answer)} confirms`);
    assert.deepEqual(outcome.applied, plan.changes);
  }
});

test('CC-ADS-4: the read-only guard survives Graph shouting its statuses in lower case', () => {
  // `status` and `effective_status` are cast off the wire, never validated, and
  // the guard tested them against an exact-case set. One lower-cased or
  // space-padded `archived` and the refusal that exists to keep an archived
  // object from being resumed simply does not fire — the plan is built, the
  // spend gate is armed, and the operator is asked to confirm a write Graph
  // will refuse anyway.
  for (const wire of ['archived', 'Archived', ' ARCHIVED ', 'deleted']) {
    const err = throwsGraph(
      () =>
        planAdObjectUpdate(
          { objectId: OBJECT_ID, status: 'ACTIVE' },
          ctx({ current: current({ status: wire, effective_status: wire }) }),
        ),
      `expected ${JSON.stringify(wire)} to be refused as read-only`,
    );
    assert.match(err.message, /read-only/);
  }
});

test('a no-op status change is recognised through the wire casing', () => {
  const plan = planAdObjectUpdate(
    { objectId: OBJECT_ID, status: 'PAUSED' },
    ctx({ current: current({ status: 'paused', effective_status: 'paused' }) }),
  );
  assert.ok(plan.warnings.some((warning) => /already PAUSED/.test(warning)));
});

test('a null end_time is not mistaken for an ad set that has an end date', () => {
  // Graph answers a requested-but-unset field with `null`, not by omitting it.
  // Gating the warning on `=== undefined` therefore read "Facebook told me
  // nothing" as "there is an end time", and swallowed the one notice that
  // explains why the lifetime budget is about to be rejected.
  const plan = planAdObjectUpdate(
    { objectId: OBJECT_ID, level: 'adset', lifetimeBudgetMinor: 100_000 },
    ctx({ current: current({ end_time: null }) }),
  );
  assert.ok(plan.warnings.includes(LIFETIME_NEEDS_END_NOTE));
});

test('a campaign lifetime budget reads the end time from `stop_time`, the key a campaign carries', () => {
  // `end_time` is an AD SET field. A campaign's end is `stop_time` (the merge of
  // its ad sets' end times), and that is the key the campaign detail read asks
  // for — so a campaign that HAS an end date was still told "this object has
  // none, Graph will reject the change".
  const withStop = planAdObjectUpdate(
    { objectId: OBJECT_ID, level: 'campaign', lifetimeBudgetMinor: 100_000 },
    ctx({ current: current({ stop_time: '2026-12-31T23:59:59+0000' }) }),
  );
  assert.equal(
    withStop.warnings.includes(LIFETIME_NEEDS_END_NOTE),
    false,
    `a campaign with a stop_time must not be told it has no end time: ${JSON.stringify(withStop.warnings)}`,
  );
  assert.equal(withStop.warnings.includes(LIFETIME_END_UNVERIFIED_NOTE), false);

  const withoutStop = planAdObjectUpdate(
    { objectId: OBJECT_ID, level: 'campaign', lifetimeBudgetMinor: 100_000 },
    ctx({ current: current({ stop_time: null }) }),
  );
  assert.ok(withoutStop.warnings.includes(LIFETIME_NEEDS_END_NOTE));
});

test('a lifetime budget planned without a level does not claim the end time is missing', () => {
  // With no `level` the object was read with the common field set, which asks
  // for neither `end_time` nor `stop_time`. "This object has none" is then a
  // statement about a field nobody read; the honest note is "unverified".
  const plan = planAdObjectUpdate(
    { objectId: OBJECT_ID, lifetimeBudgetMinor: 100_000 },
    ctx({ current: current() }),
  );
  assert.equal(
    plan.warnings.includes(LIFETIME_NEEDS_END_NOTE),
    false,
    `an unread end time must not be reported as absent: ${JSON.stringify(plan.warnings)}`,
  );
  assert.ok(
    plan.warnings.includes(LIFETIME_END_UNVERIFIED_NOTE),
    `expected the unverified note: ${JSON.stringify(plan.warnings)}`,
  );

  // When the record does carry an end key (a caller-supplied read), it counts.
  const known = planAdObjectUpdate(
    { objectId: OBJECT_ID, lifetimeBudgetMinor: 100_000 },
    ctx({ current: current({ end_time: '2026-12-31T23:59:59+0000' }) }),
  );
  assert.equal(known.warnings.includes(LIFETIME_NEEDS_END_NOTE), false);
  assert.equal(known.warnings.includes(LIFETIME_END_UNVERIFIED_NOTE), false);
});
