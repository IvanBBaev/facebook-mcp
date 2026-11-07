// Tests for the `ads` tool package: facebook_update_ad_object — tiers, ceilings, plan
// binding, account checks and journal outcomes.
//
// Split out of `ads.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/ads.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fbErr, fbOk } from '../core/fakes/index.js';
import {
  GraphApiError,
  ambiguousWriteAction,
  classifyNetworkError,
} from '../core/index.js';
import type { FbRequest } from '../core/index.js';
import { createWriteGate } from '../mcp/index.js';
import type { WriteToolContext } from './shared.js';
import {
  ACCOUNT_ID,
  ADSET_ID,
  ALWAYS_CONFIRMS,
  BARE_ACCOUNT_ID,
  CAMPAIGN_ID,
  OTHER_ACCOUNT_ID,
  PACKAGE,
  arr,
  body,
  campaignNode,
  isJson,
  makeHarness,
  obj,
  str,
  stubWriteReads,
  tool,
  writes,
} from '../testing/harness/ads.js';

test('a pause with no apply is a preview that changes nothing', async () => {
  const { fb, ctx, journal } = makeHarness();
  stubWriteReads(fb, {
    object: campaignNode({ status: 'ACTIVE', effective_status: 'ACTIVE' }),
  });

  const result = body(
    await tool('facebook_update_ad_object').handler(
      { object_id: CAMPAIGN_ID, level: 'campaign', status: 'PAUSED' },
      ctx,
    ),
  );

  assert.equal(result.status, 'preview');
  assert.equal(result.applied, false);
  // Pausing cannot spend money, so it stays at the lower of the two gated tiers.
  assert.equal(result.tier, 'irreversible');
  assert.ok(str(result.summary).includes('ACTIVE -> PAUSED'));
  assert.equal(writes(fb).length, 0, 'a dry run may not POST');
  assert.equal(journal.entries.length, 0);
});

test('the ads write stays plan-first under FB_WRITE_MODE=apply, by tier not default', async () => {
  // The package comment used to credit `writeModeDefault: 'plan'` for this. It
  // is not the reason: an explicitly set FB_WRITE_MODE=apply overrides a package
  // default outright (`effectiveWriteMode`). The tier the handler hands the gate
  // is what ignores the mode — and it is the PLAN's tier, so this pauses a
  // campaign to pin the `irreversible` branch specifically. Built with a gate
  // the way that operator's server would build one.
  const { fb, ctx } = makeHarness();
  stubWriteReads(fb, {
    object: campaignNode({ status: 'ACTIVE', effective_status: 'ACTIVE' }),
  });
  const applyMode: WriteToolContext = {
    ...ctx,
    writeGate: createWriteGate({
      confirmer: ALWAYS_CONFIRMS,
      clock: ctx.clock,
      journal: ctx.journal,
      defaultWriteMode: 'apply',
      newPlanId: () => 'plan-apply-1',
    }),
  };

  const result = body(
    await tool('facebook_update_ad_object').handler(
      { object_id: CAMPAIGN_ID, level: 'campaign', status: 'PAUSED', apply: true },
      applyMode,
    ),
  );

  assert.equal(result.status, 'preview');
  assert.equal(result.applied, false);
  assert.equal(
    writes(fb).length,
    0,
    'an unbound apply must not reach Graph, whatever FB_WRITE_MODE says',
  );
});

test('resuming is classified as a spend write, not merely irreversible', async () => {
  const { fb, ctx } = makeHarness();
  stubWriteReads(fb);

  const result = body(
    await tool('facebook_update_ad_object').handler(
      { object_id: CAMPAIGN_ID, level: 'campaign', status: 'ACTIVE' },
      ctx,
    ),
  );

  assert.equal(result.tier, 'spend');
  assert.ok(
    arr(result.warnings).some((w) => str(w).includes('effective_status')),
    'the preview must say that resuming is not the same as delivering',
  );
});

test('a budget raise is a spend write and echoes both values in the account currency', async () => {
  const { fb, ctx } = makeHarness();
  stubWriteReads(fb, { currency: 'USD' });

  const result = body(
    await tool('facebook_update_ad_object').handler(
      { object_id: CAMPAIGN_ID, level: 'campaign', daily_budget_minor: 9000 },
      ctx,
    ),
  );

  assert.equal(result.tier, 'spend');
  const summary = str(result.summary);
  assert.ok(summary.includes('5000 minor units of USD'), summary);
  assert.ok(summary.includes('9000 minor units of USD'), summary);
  assert.equal(writes(fb).length, 0);
});

test('a budget above FB_ADS_BUDGET_CEILING is refused, never clamped', async () => {
  const { fb, ctx } = makeHarness({ adsBudgetCeiling: 10_000 });
  stubWriteReads(fb);

  await assert.rejects(
    () =>
      tool('facebook_update_ad_object').handler(
        { object_id: CAMPAIGN_ID, level: 'campaign', daily_budget_minor: 25_000 },
        ctx,
      ),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.ok(message.includes('FB_ADS_BUDGET_CEILING'), message);
      assert.ok(message.includes('NOT reduced'), 'a silent clamp would be worse');
      return true;
    },
  );
  assert.equal(writes(fb).length, 0);
});

test('lowering an already over-ceiling budget is allowed', async () => {
  const { fb, ctx } = makeHarness({ adsBudgetCeiling: 4000 });
  stubWriteReads(fb);

  const result = body(
    await tool('facebook_update_ad_object').handler(
      { object_id: CAMPAIGN_ID, level: 'campaign', daily_budget_minor: 4500 },
      ctx,
    ),
  );

  assert.equal(result.status, 'preview');
});

test('an archived object is refused before the wire (CC-ADS-4)', async () => {
  const { fb, ctx } = makeHarness();
  stubWriteReads(fb, {
    object: campaignNode({ status: 'ARCHIVED', effective_status: 'ARCHIVED' }),
  });

  await assert.rejects(
    () =>
      tool('facebook_update_ad_object').handler(
        { object_id: CAMPAIGN_ID, level: 'campaign', status: 'ACTIVE' },
        ctx,
      ),
    /read-only/,
  );
  assert.equal(writes(fb).length, 0);
});

test('a disabled ad account refuses the write before the object is even read', async () => {
  const { fb, ctx } = makeHarness();
  // account_status 2 = DISABLED.
  stubWriteReads(fb, { accountStatus: 2 });

  await assert.rejects(
    () =>
      tool('facebook_update_ad_object').handler(
        { object_id: CAMPAIGN_ID, level: 'campaign', status: 'PAUSED' },
        ctx,
      ),
    /cannot serve ads/,
  );
  assert.equal(fb.calls.length, 1, 'only the account read may happen');
});

test('an account in payment trouble can still be paused', async () => {
  const { fb, ctx } = makeHarness();
  // account_status 3 = UNSETTLED: still delivering, still being charged.
  stubWriteReads(fb, {
    accountStatus: 3,
    object: campaignNode({ status: 'ACTIVE', effective_status: 'ACTIVE' }),
  });

  const result = body(
    await tool('facebook_update_ad_object').handler(
      { object_id: CAMPAIGN_ID, level: 'campaign', status: 'PAUSED' },
      ctx,
    ),
  );

  // Refusing here would lock the operator out of the only action that reduces
  // the spend — a guardrail against overspending that forbids stopping it.
  assert.equal(result.status, 'preview');
  assert.ok(str(result.summary).includes('ACTIVE -> PAUSED'));
});

test('an account in payment trouble is refused every write that keeps it spending', async () => {
  for (const input of [
    { status: 'ACTIVE' as const },
    // A budget edit never qualifies as delivery-stopping, not even riding along
    // with a pause: it leaves the object configured to deliver.
    { status: 'PAUSED' as const, daily_budget_minor: 1000 },
    { daily_budget_minor: 1000 },
  ]) {
    const { fb, ctx } = makeHarness();
    stubWriteReads(fb, { accountStatus: 3 });

    await assert.rejects(
      () =>
        tool('facebook_update_ad_object').handler(
          { object_id: CAMPAIGN_ID, level: 'campaign', ...input },
          ctx,
        ),
      /only delivery-stopping changes are accepted/,
      JSON.stringify(input),
    );
    assert.equal(fb.calls.length, 1, 'only the account read may happen');
  }
});

test('an empty change set is refused with an actionable message', async () => {
  const { fb, ctx } = makeHarness();
  stubWriteReads(fb);

  await assert.rejects(
    () =>
      tool('facebook_update_ad_object').handler(
        { object_id: CAMPAIGN_ID, level: 'campaign' },
        ctx,
      ),
    /Nothing to change/,
  );
  assert.equal(writes(fb).length, 0);
});

test('a budget on an ad is refused and points at the ad set', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${ACCOUNT_ID}`,
    fbOk({ id: ACCOUNT_ID, account_status: 1, currency: 'EUR' }),
  );
  fb.on((r) => r.method === 'GET', fbOk({ id: ADSET_ID, status: 'ACTIVE' }));

  await assert.rejects(
    () =>
      tool('facebook_update_ad_object').handler(
        { object_id: ADSET_ID, level: 'ad', daily_budget_minor: 1000 },
        ctx,
      ),
    /ad set/,
  );
  assert.equal(writes(fb).length, 0);
});

// ---------------------------------------------------------------------------
// 7. The write tool — applying (V10)
// ---------------------------------------------------------------------------

test('apply:true without a plan_id is still only a preview', async () => {
  const { fb, ctx } = makeHarness();
  stubWriteReads(fb);

  const result = body(
    await tool('facebook_update_ad_object').handler(
      { object_id: CAMPAIGN_ID, level: 'campaign', status: 'ACTIVE', apply: true },
      ctx,
    ),
  );

  assert.equal(result.status, 'preview');
  assert.equal(result.applied, false);
  assert.ok(arr(result.warnings).some((w) => str(w).includes('plan_id')));
  assert.equal(writes(fb).length, 0, 'no spend without a bound plan');
});

test('apply bound to the preview plan_id performs the update', async () => {
  const { fb, ctx, journal } = makeHarness();
  stubWriteReads(fb);
  fb.on((r) => r.method === 'POST', fbOk({ success: true }));

  const update = tool('facebook_update_ad_object');
  const args = { object_id: CAMPAIGN_ID, level: 'campaign', status: 'ACTIVE' };

  const preview = body(await update.handler(args, ctx));
  const applied = body(
    await update.handler({ ...args, apply: true, plan_id: str(preview.planId) }, ctx),
  );

  assert.equal(applied.status, 'applied');
  assert.equal(applied.applied, true);
  assert.equal(obj(applied.result).objectId, CAMPAIGN_ID);

  const post = writes(fb)[0];
  assert.ok(post && isJson(post));
  assert.equal(post.path, `/${CAMPAIGN_ID}`);
  assert.deepEqual(post.body, { status: 'ACTIVE' });
  assert.equal(journal.entries.at(-1)?.outcome, 'applied');
});

test('a refused ad update is enveloped and journaled as not applied, never as applied', async () => {
  // `applyAdObjectUpdate` RETURNS `{ success:false, applied: [] }` on a 2xx
  // whose flag is not `true` (it does not throw), so without a verdict the gate
  // would stamp the very same call `applied` and journal it as a budget move
  // that never happened — beside a result that says the opposite.
  const refusals: readonly unknown[] = [
    { success: false },
    { success: 'false' },
    { success: 0 },
    { success: null },
  ];

  for (const ack of refusals) {
    const { fb, ctx, journal } = makeHarness();
    stubWriteReads(fb);
    fb.on((r) => r.method === 'POST', fbOk(ack));

    const update = tool('facebook_update_ad_object');
    const args = { object_id: CAMPAIGN_ID, level: 'campaign', status: 'ACTIVE' };
    const preview = body(await update.handler(args, ctx));
    const applied = body(
      await update.handler({ ...args, apply: true, plan_id: str(preview.planId) }, ctx),
    );

    const label = JSON.stringify(ack);
    assert.equal(applied.status, 'not_applied', `${label}: envelope status`);
    assert.equal(applied.applied, false, `${label}: envelope applied flag`);
    assert.equal(applied.outcome, 'failed', `${label}: envelope outcome`);
    const result = obj(applied.result);
    assert.equal(result.success, false, `${label}: result success`);
    assert.deepEqual(result.applied, [], `${label}: no change is claimed`);
    assert.equal(writes(fb).length, 1, `${label}: the write was issued exactly once`);
    assert.equal(journal.entries.length, 1, `${label}: exactly one journal entry`);
    assert.equal(journal.entries.at(-1)?.outcome, 'failed', `${label}: journal outcome`);
    assert.match(str(applied.notPerformedNotice), /nothing landed/, label);
  }
});

test('a confirmed ad update stays applied in the envelope and the journal', async () => {
  // Regression guard for the verdict above: a `success:true` (and a bodiless
  // 2xx, which this edge treats as confirmation) must not be demoted.
  for (const ack of [{ success: true }, undefined]) {
    const { fb, ctx, journal } = makeHarness();
    stubWriteReads(fb);
    fb.on((r) => r.method === 'POST', fbOk(ack));

    const update = tool('facebook_update_ad_object');
    const args = { object_id: CAMPAIGN_ID, level: 'campaign', status: 'ACTIVE' };
    const preview = body(await update.handler(args, ctx));
    const applied = body(
      await update.handler({ ...args, apply: true, plan_id: str(preview.planId) }, ctx),
    );

    const label = JSON.stringify(ack ?? null);
    assert.equal(applied.status, 'applied', `${label}: envelope status`);
    assert.equal(applied.applied, true, `${label}: envelope applied flag`);
    assert.equal(applied.outcome, 'applied', `${label}: envelope outcome`);
    assert.equal(obj(applied.result).success, true, `${label}: result success`);
    assert.equal(journal.entries.at(-1)?.outcome, 'applied', `${label}: journal outcome`);
  }
});

test('a plan_id cannot be replayed against different arguments', async () => {
  const { fb, ctx } = makeHarness();
  stubWriteReads(fb);
  fb.on((r) => r.method === 'POST', fbOk({ success: true }));

  const update = tool('facebook_update_ad_object');
  const preview = body(
    await update.handler(
      { object_id: CAMPAIGN_ID, level: 'campaign', daily_budget_minor: 6000 },
      ctx,
    ),
  );

  await assert.rejects(
    () =>
      update.handler(
        {
          object_id: CAMPAIGN_ID,
          level: 'campaign',
          daily_budget_minor: 60_000,
          apply: true,
          plan_id: str(preview.planId),
        },
        ctx,
      ),
    /differ from the planned params/,
  );
  assert.equal(writes(fb).length, 0);
});

test('a plan cannot be re-aimed at a different ad account between preview and apply', async () => {
  const { fb, ctx } = makeHarness();
  stubWriteReads(fb, { currency: 'EUR' });
  // A second, healthy account in a different currency. `ad_account_id` decides
  // which one the budget is read against and which currency the confirmed
  // sentence is denominated in, so it is part of what a preview promised.
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${OTHER_ACCOUNT_ID}`,
    fbOk({
      id: OTHER_ACCOUNT_ID,
      account_status: 1,
      currency: 'JPY',
      name: 'Other account',
    }),
  );
  fb.on((r) => r.method === 'POST', fbOk({ success: true }));

  const update = tool('facebook_update_ad_object');
  const preview = body(
    await update.handler(
      { object_id: CAMPAIGN_ID, level: 'campaign', daily_budget_minor: 6000 },
      ctx,
    ),
  );

  await assert.rejects(
    () =>
      update.handler(
        {
          object_id: CAMPAIGN_ID,
          level: 'campaign',
          daily_budget_minor: 6000,
          ad_account_id: OTHER_ACCOUNT_ID,
          apply: true,
          plan_id: str(preview.planId),
        },
        ctx,
      ),
    /differ from the planned params/,
  );
  assert.equal(writes(fb).length, 0);
});

test('the account a plan resolved by default may be named explicitly on apply', async () => {
  const { fb, ctx, journal } = makeHarness();
  stubWriteReads(fb);
  fb.on((r) => r.method === 'POST', fbOk({ success: true }));

  const update = tool('facebook_update_ad_object');
  const args = { object_id: CAMPAIGN_ID, level: 'campaign', status: 'ACTIVE' };

  // The preview took the account from `FB_AD_ACCOUNT_ID`; the apply spells the
  // same account out, in the bare form the resolver normalises. Same account,
  // so the pin must not read it as a re-aiming.
  const preview = body(await update.handler(args, ctx));
  const applied = body(
    await update.handler(
      {
        ...args,
        ad_account_id: BARE_ACCOUNT_ID,
        apply: true,
        plan_id: str(preview.planId),
      },
      ctx,
    ),
  );

  assert.equal(applied.status, 'applied');
  assert.equal(journal.entries.at(-1)?.outcome, 'applied');
});

test('an object changed between preview and apply diverges instead of overwriting', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${ACCOUNT_ID}`,
    fbOk({ id: ACCOUNT_ID, account_status: 1, currency: 'EUR' }),
  );
  // First object read (the preview) sees a 5000 budget; the apply-time read sees
  // 7000 — someone raised it in Ads Manager in between. The requested change
  // (resume) is the same in both, so the plan still binds; only the world moved.
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${CAMPAIGN_ID}`,
    fbOk(campaignNode()),
    1,
  );
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${CAMPAIGN_ID}`,
    fbOk(campaignNode({ daily_budget: '7000' })),
  );
  fb.on((r) => r.method === 'POST', fbOk({ success: true }));

  const update = tool('facebook_update_ad_object');
  const args = { object_id: CAMPAIGN_ID, level: 'campaign', status: 'ACTIVE' };
  const preview = body(await update.handler(args, ctx));
  const result = body(
    await update.handler({ ...args, apply: true, plan_id: str(preview.planId) }, ctx),
  );

  assert.equal(result.status, 'diverged');
  assert.equal(result.applied, false);
  assert.equal(writes(fb).length, 0, 'a diverged apply must not write');
});

test('a change that lowers the tier between plan and apply unbinds the plan', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${ACCOUNT_ID}`,
    fbOk({ id: ACCOUNT_ID, account_status: 1, currency: 'EUR' }),
  );
  // Planned as a raise (5000 -> 6000, tier "spend"); by apply time the budget is
  // already 7000, so the same request is now a CUT ("irreversible"). The gate
  // refuses rather than performing a write the user never previewed.
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${CAMPAIGN_ID}`,
    fbOk(campaignNode()),
    1,
  );
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${CAMPAIGN_ID}`,
    fbOk(campaignNode({ daily_budget: '7000' })),
  );
  fb.on((r) => r.method === 'POST', fbOk({ success: true }));

  const update = tool('facebook_update_ad_object');
  const args = { object_id: CAMPAIGN_ID, level: 'campaign', daily_budget_minor: 6000 };
  const preview = body(await update.handler(args, ctx));

  await assert.rejects(
    () => update.handler({ ...args, apply: true, plan_id: str(preview.planId) }, ctx),
    /different tool\/tier/,
  );
  assert.equal(writes(fb).length, 0);
});

test('the preview reuses the pre-read instead of hitting the object edge twice', async () => {
  const { fb, ctx } = makeHarness();
  stubWriteReads(fb);

  await tool('facebook_update_ad_object').handler(
    { object_id: CAMPAIGN_ID, level: 'campaign', status: 'PAUSED' },
    ctx,
  );

  const objectReads = fb.calls.filter((r) => r.path === `/${CAMPAIGN_ID}`);
  assert.equal(objectReads.length, 1, 'the planner read doubles as the before-state');
});

test('an unconfigured ad account still allows a status write, without a currency echo', async () => {
  const { fb, ctx } = makeHarness({ adAccountId: undefined });
  fb.on((r) => r.method === 'GET', fbOk(campaignNode()));

  const result = body(
    await tool('facebook_update_ad_object').handler(
      { object_id: CAMPAIGN_ID, level: 'campaign', status: 'ACTIVE' },
      ctx,
    ),
  );

  assert.equal(result.status, 'preview');
  assert.equal(fb.calls.length, 1, 'no account read when no account is known');
});

test('an unconfigured ad account takes the currency from the account the object names', async () => {
  // No FB_AD_ACCOUNT_ID and no ad_account_id argument, but the object read
  // carries its own `account_id`. Previewing a budget without reading that
  // account states "6000 minor units" for a JPY account — a figure the model
  // reads as 60.00 when the write sets 6000 JPY — and omits the zero-decimal
  // warning the configured path would have attached.
  const { fb, ctx } = makeHarness({ adAccountId: undefined });
  stubWriteReads(fb, {
    currency: 'JPY',
    object: campaignNode({ account_id: BARE_ACCOUNT_ID }),
  });

  const preview = body(
    await tool('facebook_update_ad_object').handler(
      { object_id: CAMPAIGN_ID, level: 'campaign', daily_budget_minor: 6000 },
      ctx,
    ),
  );

  assert.equal(preview.status, 'preview');
  assert.match(str(preview.summary), /6000 JPY \(whole units\)/);
  assert.ok(
    arr(preview.warnings).some((w) => /JPY has no minor unit/.test(String(w))),
    'the zero-decimal warning must reach the preview',
  );
});

test('an unconfigured ad account still gets the health check of the account the object names', async () => {
  // CC-ADS-6 refuses a spend-increasing write on a disabled account before the
  // wire. Skipping the account read whenever no account was configured let a
  // resume on a DISABLED account through to a preview that could never apply.
  const { fb, ctx, journal } = makeHarness({ adAccountId: undefined });
  stubWriteReads(fb, {
    accountStatus: 2,
    object: campaignNode({ account_id: BARE_ACCOUNT_ID }),
  });

  await assert.rejects(() =>
    tool('facebook_update_ad_object').handler(
      { object_id: CAMPAIGN_ID, level: 'campaign', status: 'ACTIVE' },
      ctx,
    ),
  );
  assert.equal(writes(fb).length, 0);
  assert.equal(journal.entries.length, 0);
});

test('an unconfigured ad account whose owner cannot be read still previews a pause', async () => {
  const { fb, ctx } = makeHarness({ adAccountId: undefined });
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${ACCOUNT_ID}`,
    fbErr(new GraphApiError('(#200) Permissions error', { code: 200, httpStatus: 403 })),
  );
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${CAMPAIGN_ID}`,
    fbOk(campaignNode({ status: 'ACTIVE', account_id: BARE_ACCOUNT_ID })),
  );

  const preview = body(
    await tool('facebook_update_ad_object').handler(
      { object_id: CAMPAIGN_ID, level: 'campaign', status: 'PAUSED' },
      ctx,
    ),
  );
  assert.equal(preview.status, 'preview');
});

test('a cancel during the owner-account read is rethrown, not swallowed as "unreadable"', async () => {
  // An unreadable owner account is tolerated (the write proceeds without a
  // currency echo), but a caller cancel must still stop the call: swallowing
  // it would build and journal a preview the caller already walked away from.
  const { fb, ctx, journal } = makeHarness({ adAccountId: undefined });
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${CAMPAIGN_ID}`,
    fbOk(campaignNode({ status: 'ACTIVE', account_id: BARE_ACCOUNT_ID })),
  );
  const controller = new AbortController();
  const cancellingCtx: WriteToolContext = {
    ...ctx,
    signal: controller.signal,
    fbRequest: async <T>(req: FbRequest) => {
      if (req.path === `/${ACCOUNT_ID}`) {
        controller.abort();
        throw Object.assign(new Error('This operation was aborted'), {
          name: 'AbortError',
        });
      }
      return fb.fn<T>(req);
    },
  };

  await assert.rejects(
    () =>
      tool('facebook_update_ad_object').handler(
        { object_id: CAMPAIGN_ID, level: 'campaign', status: 'PAUSED' },
        cancellingCtx,
      ),
    (err: unknown) => err instanceof Error && err.name === 'AbortError',
  );
  assert.equal(writes(fb).length, 0);
  assert.equal(journal.entries.length, 0);
});

test('an account_id already in act_ form is compared as-is against the resolved account', async () => {
  const { fb, ctx } = makeHarness();
  stubWriteReads(fb, { object: campaignNode({ account_id: ACCOUNT_ID }) });

  const preview = body(
    await tool('facebook_update_ad_object').handler(
      { object_id: CAMPAIGN_ID, level: 'campaign', status: 'PAUSED' },
      ctx,
    ),
  );
  assert.equal(preview.status, 'preview');

  const other = makeHarness();
  stubWriteReads(other.fb, { object: campaignNode({ account_id: OTHER_ACCOUNT_ID }) });
  await assert.rejects(
    () =>
      tool('facebook_update_ad_object').handler(
        { object_id: CAMPAIGN_ID, level: 'campaign', status: 'PAUSED' },
        other.ctx,
      ),
    (err: unknown) =>
      err instanceof GraphApiError && err.message.includes(`${OTHER_ACCOUNT_ID},`),
  );
});

test('a lifetime-budget update without a level previews and applies', async () => {
  const { fb, ctx, journal } = makeHarness();
  stubWriteReads(fb, {
    object: campaignNode({ daily_budget: undefined, lifetime_budget: '9000' }),
  });
  fb.on((r) => r.method === 'POST', fbOk({ success: true }));

  const update = tool('facebook_update_ad_object');
  const args = { object_id: CAMPAIGN_ID, lifetime_budget_minor: 8000 };
  const preview = body(await update.handler(args, ctx));
  assert.equal(preview.status, 'preview');

  const applied = body(
    await update.handler({ ...args, apply: true, plan_id: str(preview.planId) }, ctx),
  );
  assert.equal(applied.status, 'applied');
  const post = writes(fb)[0];
  assert.ok(post && isJson(post));
  assert.deepEqual(post.body, { lifetime_budget: 8000 });
  const metadata = obj(journal.entries.at(-1)?.metadata);
  assert.equal(metadata.level, undefined, 'no level was given, so none is journaled');
  assert.deepEqual(metadata.changedFields, ['lifetime_budget']);
});

test('no budget text tells the model that a minor unit is always one hundredth', () => {
  // `formatMinor` in the api layer was corrected to stop calling a JPY amount
  // "minor units"; the model-facing text is the other half of the same truth.
  // A minor unit is the smallest unit the AD ACCOUNT currency has, and sixteen
  // of the currencies an ad account can be denominated in (JPY, KRW, CLP, VND,
  // ...) have no sub-unit at all: on one of those, `daily_budget_minor: 1000`
  // is 1000 whole units, not 10.00. A description that states the 1/100 rule
  // without naming that exception invites a hundredfold budget error, and the
  // model has no other place to learn the difference.
  const update = tool('facebook_update_ad_object');
  const { shape } = update.inputSchema as unknown as {
    readonly shape: Record<string, { readonly description?: string }>;
  };

  const texts: Array<readonly [string, string]> = [
    ['daily_budget_minor', shape.daily_budget_minor?.description ?? ''],
    ['lifetime_budget_minor', shape.lifetime_budget_minor?.description ?? ''],
    ...PACKAGE.tools.map((spec) => [spec.name, spec.description] as const),
  ];

  for (const [where, textValue] of texts) {
    if (!/1000\s+(?:=|means)\s+10\.00/.test(textValue)) continue;
    assert.match(
      textValue,
      /zero-decimal|JPY/,
      `${where} states the 1/100 rule without naming a zero-decimal currency, so a ` +
        `JPY account reads its own budget as one hundredth of the real amount`,
    );
  }
});

test('no budget text defines the minor unit as the ISO subunit Meta does not use', () => {
  // Meta counts budgets in its own currency offset, not the ISO 4217 subunit:
  // TWD, HUF, IDR, COP and CRC have an ISO subunit yet Meta counts them whole
  // (1000 = 1000), and BHD/JOD have an ISO 1/1000 yet Meta counts hundredths.
  // "The smallest unit that currency has" is therefore wrong by 100x or 10x
  // for those accounts.
  const update = tool('facebook_update_ad_object');
  const { shape } = update.inputSchema as unknown as {
    readonly shape: Record<string, { readonly description?: string }>;
  };

  const texts: Array<readonly [string, string]> = [
    ['daily_budget_minor', shape.daily_budget_minor?.description ?? ''],
    ['lifetime_budget_minor', shape.lifetime_budget_minor?.description ?? ''],
    ...PACKAGE.tools.map((spec) => [spec.name, spec.description] as const),
  ];

  for (const [where, textValue] of texts) {
    if (!/MINOR currency units/.test(textValue)) continue;
    assert.doesNotMatch(textValue, /smallest unit/, `${where} defines the unit by ISO`);
    assert.match(textValue, /currency offset/, `${where} does not name Meta's offset`);
  }
});

test('an update whose answer was lost is journaled attempted, a Graph refusal failed', async () => {
  // The POST reached Graph and the answer never came back: the budget raise or
  // resume may be live and spending. A `failed` entry tells the operator
  // reconciling the journal that nothing moved — the dangerous direction of the
  // two lies. A received 4xx envelope, by contrast, proves nothing landed.
  const cases: ReadonlyArray<readonly [string, unknown, 'attempted' | 'failed']> = [
    [
      'ambiguous after a 200',
      new GraphApiError(
        'ambiguous write outcome (body lost) — do NOT retry; verify first',
        {
          code: 0,
          httpStatus: 200,
          action: ambiguousWriteAction({ detail: 'body lost' }),
        },
      ),
      'attempted',
    ],
    [
      'HTTP 503',
      new GraphApiError('Service temporarily unavailable', { code: 2, httpStatus: 503 }),
      'attempted',
    ],
    [
      'status-0 network fault',
      new GraphApiError('socket hang up', { code: 0, httpStatus: 0 }),
      'attempted',
    ],
    [
      'abort',
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
      'attempted',
    ],
    [
      'Graph 4xx refusal',
      new GraphApiError('(#100) Param daily_budget must be a positive integer', {
        code: 100,
        httpStatus: 400,
      }),
      'failed',
    ],
  ];

  for (const [label, err, expected] of cases) {
    const { fb, ctx, journal } = makeHarness();
    stubWriteReads(fb);
    fb.on((r) => r.method === 'POST', fbErr(err as Error));

    const update = tool('facebook_update_ad_object');
    const args = { object_id: CAMPAIGN_ID, level: 'campaign', status: 'ACTIVE' };
    const preview = body(await update.handler(args, ctx));
    await assert.rejects(
      () => update.handler({ ...args, apply: true, plan_id: str(preview.planId) }, ctx),
      label,
    );

    assert.equal(writes(fb).length, 1, `${label}: the write was issued exactly once`);
    assert.equal(journal.entries.length, 1, `${label}: exactly one journal entry`);
    assert.equal(journal.entries.at(-1)?.outcome, expected, `${label}: journal outcome`);
  }
});

test('an update that provably never left the machine is journaled failed, not attempted', async () => {
  // A connect-phase fault (ECONNREFUSED, DNS) is the one transport failure the
  // http layer can PROVE sent no byte of the write: it surfaces as a status-0
  // error whose `cause` carries the connect code, and it is retried rather than
  // stamped `ambiguous`. Journaling it `attempted` tells the operator
  // reconciling spend that a resume or budget raise "may be live" when the
  // account provably never saw it.
  const { fb, ctx, journal } = makeHarness();
  stubWriteReads(fb);
  const cause = Object.assign(new Error('connect ECONNREFUSED 157.240.1.1:443'), {
    code: 'ECONNREFUSED',
  });
  const err = new GraphApiError(
    'network request failed: connect ECONNREFUSED 157.240.1.1:443',
    {
      code: 0,
      httpStatus: 0,
      action: classifyNetworkError({ phase: 'connect', isWrite: true }),
      cause,
    },
  );
  fb.on((r) => r.method === 'POST', fbErr(err));

  const update = tool('facebook_update_ad_object');
  const args = { object_id: CAMPAIGN_ID, level: 'campaign', status: 'ACTIVE' };
  const preview = body(await update.handler(args, ctx));
  await assert.rejects(() =>
    update.handler({ ...args, apply: true, plan_id: str(preview.planId) }, ctx),
  );

  assert.equal(journal.entries.length, 1);
  assert.equal(
    journal.entries.at(-1)?.outcome,
    'failed',
    'a write that provably never reached Graph cannot have landed',
  );
});

test('an update cancelled before the POST was sent is journaled failed, not attempted', async () => {
  // The caller cancels after the gate's last re-read and before `perform` issues
  // the POST. `fetch` refuses an already-aborted signal before a byte leaves the
  // machine, and the transport rethrows that AbortError raw — so a classifier
  // that reads only the error cannot tell it from a mid-flight abort and
  // journals "may be live" about a resume or budget raise Graph never saw.
  const { fb, ctx, journal } = makeHarness();
  stubWriteReads(fb);
  fb.on((r) => r.method === 'POST', fbOk({ success: true }));

  const update = tool('facebook_update_ad_object');
  const args = { object_id: CAMPAIGN_ID, level: 'campaign', status: 'ACTIVE' };
  const preview = body(await update.handler(args, ctx));

  const controller = new AbortController();
  let objectReads = 0;
  let postsSent = 0;
  const cancellingCtx: WriteToolContext = {
    ...ctx,
    signal: controller.signal,
    fbRequest: async <T>(req: FbRequest) => {
      // Mirror fetch: an already-aborted signal rejects before anything is sent.
      if (req.method !== 'GET' && req.signal?.aborted === true) {
        throw Object.assign(new Error('This operation was aborted'), {
          name: 'AbortError',
        });
      }
      if (req.method !== 'GET') postsSent += 1;
      const res = await fb.fn<T>(req);
      // Handler pre-read, then the gate's post-confirmation re-read: cancel
      // right after the second, i.e. after authorization and before the POST.
      if (req.method === 'GET' && req.path === `/${CAMPAIGN_ID}`) {
        objectReads += 1;
        if (objectReads === 2) controller.abort();
      }
      return res;
    },
  };

  await assert.rejects(() =>
    update.handler({ ...args, apply: true, plan_id: str(preview.planId) }, cancellingCtx),
  );

  assert.equal(postsSent, 0, 'the POST never left the machine');
  assert.equal(journal.entries.length, 1, 'exactly one journal entry');
  assert.equal(
    journal.entries.at(-1)?.outcome,
    'failed',
    'a write cancelled before it was sent cannot have landed',
  );
});

test('an object that belongs to another ad account is refused, not previewed in the wrong currency', async () => {
  // FB_AD_ACCOUNT_ID is a EUR account; the campaign lives in a different
  // account. The currency echo and the CC-ADS-6 health check both come from
  // the account read, so previewing against the default would denominate the
  // confirmed sentence — and judge the account's health — for an account the
  // write never touches.
  const { fb, ctx, journal } = makeHarness();
  stubWriteReads(fb, {
    currency: 'EUR',
    object: campaignNode({ account_id: OTHER_ACCOUNT_ID.slice('act_'.length) }),
  });

  await assert.rejects(
    () =>
      tool('facebook_update_ad_object').handler(
        { object_id: CAMPAIGN_ID, level: 'campaign', daily_budget_minor: 6000 },
        ctx,
      ),
    (err: unknown) =>
      err instanceof GraphApiError &&
      err.message.includes(OTHER_ACCOUNT_ID) &&
      err.message.includes(ACCOUNT_ID) &&
      /ad_account_id/.test(err.message),
  );
  assert.equal(writes(fb).length, 0);
  assert.equal(journal.entries.length, 0);
});

test('an object whose account_id matches the resolved account previews normally', async () => {
  const { fb, ctx } = makeHarness();
  stubWriteReads(fb, {
    currency: 'EUR',
    object: campaignNode({ account_id: BARE_ACCOUNT_ID }),
  });

  const preview = body(
    await tool('facebook_update_ad_object').handler(
      { object_id: CAMPAIGN_ID, level: 'campaign', daily_budget_minor: 6000 },
      ctx,
    ),
  );
  assert.equal(preview.status, 'preview');
  assert.match(str(preview.summary), /EUR/);
});

test('an update without a level still reads account_id, so ownership is checked', async () => {
  // Without `level` the pre-read falls back to the common field list. Graph
  // answers only the fields asked for, so unless that list names account_id
  // the ownership check has nothing to compare and the object is previewed in
  // the default account's currency.
  const { fb, ctx, journal } = makeHarness();
  fb.on(
    (r) =>
      r.method === 'GET' &&
      r.path === `/${CAMPAIGN_ID}` &&
      isJson(r) &&
      String(obj(r.params).fields).split(',').includes('account_id'),
    fbOk(campaignNode({ account_id: OTHER_ACCOUNT_ID.slice('act_'.length) })),
  );
  stubWriteReads(fb, { currency: 'EUR' });

  await assert.rejects(
    () =>
      tool('facebook_update_ad_object').handler(
        { object_id: CAMPAIGN_ID, status: 'PAUSED' },
        ctx,
      ),
    (err: unknown) =>
      err instanceof GraphApiError && err.message.includes(OTHER_ACCOUNT_ID),
  );
  assert.equal(writes(fb).length, 0);
  assert.equal(journal.entries.length, 0);
});

test('the insights description does not read an empty page with a forward cursor as "did not deliver"', () => {
  // Graph can answer `data: []` beside `paging.next` (CC-PAGE-1); the api layer
  // notes it (EMPTY_INSIGHTS_PAGE_MORE_FOLLOWS_NOTE). An unconditional "Empty rows
  // mean the object did not deliver" in the description contradicts that note.
  const { description } = tool('facebook_ads_insights');
  assert.doesNotMatch(description, /Empty rows mean the object did not deliver/);
  assert.match(description, /no `nextCursor`/);
});

test('the insights description names the currency and unit of money metrics', () => {
  // The api layer pins `account_currency` onto every money read; without saying so
  // here, a caller reads "48.10" as dollars on a JPY account, or as minor units the
  // way budgets are reported.
  const { description } = tool('facebook_ads_insights');
  assert.match(description, /`account_currency`/);
  assert.match(description, /not minor units/);
});
