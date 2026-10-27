// Tests for the paused-copy module (v2 ads §7): the planner's refusals, the
// synchronous deep-copy limit, `status_option=PAUSED` on the wire, the answer
// parser and the post-copy pause verification. Every Graph call goes through
// the injected fake — no network, ever. The `/copies` answer shape is
// hand-written from the shape verified for campaigns on 2026-10-24.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeFbRequest, fbErr, fbOk } from '../core/fakes/index.js';
import { GraphApiError, classifyGraphError, type JsonRequest } from '../core/index.js';
import { normalizeAdNode } from './ads-read.js';

import {
  COPY_PAUSED_NOTE,
  DEFAULT_RENAME_SUFFIX,
  applyCopy,
  copyRequest,
  parseCopyResult,
  pauseAlert,
  planCopy,
  readCopyTree,
  verifyPaused,
  type CopyPlanInput,
  type CopyTree,
} from './ads-copy.js';

const CAMPAIGN_ID = '23851234567890123';
const ADSET_ID = '23859876543210987';
const AD_ID = '23850000000000001';
const NOW = Date.parse('2026-10-27T00:00:00Z');

function campaign(overrides: Record<string, unknown> = {}) {
  return normalizeAdNode({
    id: CAMPAIGN_ID,
    name: 'Spring',
    status: 'ACTIVE',
    effective_status: 'ACTIVE',
    daily_budget: '5000',
    spend_cap: '100000',
    special_ad_categories: [],
    account_id: '1234567890',
    ...overrides,
  });
}

function adset(overrides: Record<string, unknown> = {}) {
  return normalizeAdNode({
    id: ADSET_ID,
    name: 'EU',
    status: 'PAUSED',
    effective_status: 'PAUSED',
    campaign_id: CAMPAIGN_ID,
    daily_budget: '2000',
    account_id: '1234567890',
    ...overrides,
  });
}

function input(overrides: Partial<CopyPlanInput> = {}): CopyPlanInput {
  const tree: CopyTree = { source: campaign(), campaign: campaign() };
  return {
    objectId: CAMPAIGN_ID,
    level: 'campaign',
    deepCopy: false,
    tree,
    currency: 'USD',
    budgetCeilingMinor: 10_000,
    spendCapMaxMinor: 500_000,
    now: NOW,
    ...overrides,
  };
}

function graphError(code: number, message: string): GraphApiError {
  return new GraphApiError(message, {
    code,
    httpStatus: 400,
    action: classifyGraphError({ code, message }),
  });
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

test('a capped campaign within the limits plans a paused shallow copy', () => {
  const plan = planCopy(input());
  assert.equal(plan.renameSuffix, DEFAULT_RENAME_SUFFIX);
  assert.equal(plan.copiedCount, 1);
  assert.match(plan.summary, /PAUSED copy/);
  assert.ok(plan.warnings.includes(COPY_PAUSED_NOTE));
  assert.ok(
    plan.warnings.some((w) =>
      /Campaign .* budget: daily 5000 minor units of USD/.test(w),
    ),
  );
  assert.ok(plan.warnings.some((w) => /spend cap: 100000 minor units of USD/.test(w)));
  assert.ok(plan.warnings.some((w) => /^If activated: Worst case per day/.test(w)));
  assert.ok(plan.warnings.some((w) => /Shallow copy/.test(w)));
});

test('an uncapped campaign is refused', () => {
  const uncapped = campaign({ spend_cap: undefined });
  assert.throws(
    () => planCopy(input({ tree: { source: uncapped, campaign: uncapped } })),
    /has no spend cap/,
  );
  const zero = campaign({ spend_cap: '0' });
  assert.throws(
    () => planCopy(input({ tree: { source: zero, campaign: zero } })),
    /has no spend cap/,
  );
});

test('a cap above the maximum, or no maximum at all, is refused', () => {
  assert.throws(
    () => planCopy(input({ spendCapMaxMinor: 50_000 })),
    /exceeds FB_ADS_CAMPAIGN_SPEND_CAP_MAX/,
  );
  const rest: CopyPlanInput = { ...input() };
  delete (rest as { spendCapMaxMinor?: number }).spendCapMaxMinor;
  assert.throws(() => planCopy(rest), /needs FB_ADS_CAMPAIGN_SPEND_CAP_MAX/);
});

test('a copied budget above the ceiling is refused, never clamped', () => {
  assert.throws(
    () => planCopy(input({ budgetCeilingMinor: 4_000 })),
    /exceeds FB_ADS_BUDGET_CEILING/,
  );
  // An ad set copy checks the ad set's own budget.
  const tree = { source: adset({ daily_budget: '9000' }), campaign: campaign() };
  assert.throws(
    () =>
      planCopy(
        input({ objectId: ADSET_ID, level: 'adset', tree, budgetCeilingMinor: 8_000 }),
      ),
    /ad set 23859876543210987 daily_budget/,
  );
});

test('special ad categories and Advantage+ shopping/app campaigns are refused', () => {
  const housing = campaign({ special_ad_categories: ['HOUSING'] });
  assert.throws(
    () => planCopy(input({ tree: { source: housing, campaign: housing } })),
    /special ad categories \(HOUSING\)/,
  );
  const none = campaign({ special_ad_categories: ['NONE'] });
  assert.doesNotThrow(() => planCopy(input({ tree: { source: none, campaign: none } })));
  const asc = campaign({
    advantage_state_info: { advantage_state: 'ADVANTAGE_PLUS_SALES' },
  });
  assert.throws(
    () => planCopy(input({ tree: { source: asc, campaign: asc } })),
    /Advantage\+ shopping campaign/,
  );
});

test('an ad copy checks its parent campaign', () => {
  const ad = normalizeAdNode({
    id: AD_ID,
    status: 'ACTIVE',
    campaign_id: CAMPAIGN_ID,
    adset_id: ADSET_ID,
  });
  const uncapped = campaign({ spend_cap: undefined });
  assert.throws(
    () =>
      planCopy(
        input({ objectId: AD_ID, level: 'ad', tree: { source: ad, campaign: uncapped } }),
      ),
    /campaign 23851234567890123 has no spend cap/,
  );
  // An ad carries no budget: the campaign's is not re-checked against the ceiling.
  const plan = planCopy(
    input({
      objectId: AD_ID,
      level: 'ad',
      tree: { source: ad, campaign: campaign() },
      budgetCeilingMinor: 1,
    }),
  );
  assert.equal(plan.copiedCount, 1);
  assert.throws(
    () =>
      planCopy(
        input({
          objectId: AD_ID,
          level: 'ad',
          deepCopy: true,
          tree: { source: ad, campaign: campaign() },
        }),
      ),
    /an ad has no children/,
  );
});

test('a deleted source is refused; an archived one is warned about', () => {
  const gone = campaign({ status: 'DELETED' });
  assert.throws(
    () => planCopy(input({ tree: { source: gone, campaign: gone } })),
    /cannot be copied/,
  );
  const archived = campaign({ status: 'ARCHIVED', effective_status: 'ARCHIVED' });
  const plan = planCopy(input({ tree: { source: archived, campaign: archived } }));
  assert.ok(plan.warnings.some((w) => /archived.*PROBE/.test(w)));
});

test('the synchronous deep-copy limit is enforced and unknown counts refuse', () => {
  const base = { source: campaign(), campaign: campaign() };
  assert.throws(
    () =>
      planCopy(
        input({ deepCopy: true, tree: { ...base, childAds: 4, childAdSets: [] } }),
      ),
    /has 4 ads; a deep copy here copies at most 3/,
  );
  assert.throws(
    () => planCopy(input({ deepCopy: true, tree: { ...base, childAdSets: [] } })),
    /could not be counted/,
  );
  assert.throws(
    () => planCopy(input({ deepCopy: true, tree: { ...base, childAds: 2 } })),
    /ad sets under campaign .* could not all be read/,
  );
  const plan = planCopy(
    input({
      deepCopy: true,
      tree: {
        ...base,
        childAds: 3,
        childAdSets: [{ id: '1', dailyBudgetMinor: 1_000 }, { id: '2' }],
      },
    }),
  );
  assert.equal(plan.copiedCount, 6);
  assert.ok(plan.warnings.some((w) => /2 ad sets and 3 ads are copied/.test(w)));
});

test('a deep copy refuses a child ad set budget above the ceiling', () => {
  const base = { source: campaign(), campaign: campaign() };
  assert.throws(
    () =>
      planCopy(
        input({
          deepCopy: true,
          tree: {
            ...base,
            childAds: 1,
            childAdSets: [{ id: '7', lifetimeBudgetMinor: 99_999 }],
          },
        }),
      ),
    /ad set 7 lifetime_budget/,
  );
});

test('the rename suffix is bounded and must be visible', () => {
  assert.throws(() => planCopy(input({ renameSuffix: '   ' })), /visible text/);
  assert.throws(() => planCopy(input({ renameSuffix: 'x'.repeat(51) })), /at most 50/);
  assert.equal(planCopy(input({ renameSuffix: ' v2' })).renameSuffix, ' v2');
});

test('an ended schedule is flagged rather than failing the envelope', () => {
  const ended = campaign({ stop_time: '2026-01-01T00:00:00+0000' });
  const plan = planCopy(input({ tree: { source: ended, campaign: ended } }));
  assert.ok(plan.warnings.some((w) => /schedule has already ended/.test(w)));
});

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------

test('the copy request always sends status_option=PAUSED', () => {
  for (const deepCopy of [false, true]) {
    const plan = planCopy(
      input({
        deepCopy,
        tree: { source: campaign(), campaign: campaign(), childAds: 0, childAdSets: [] },
      }),
    );
    const req = copyRequest(plan);
    assert.equal(req.method, 'POST');
    assert.equal(req.path, `/${CAMPAIGN_ID}/copies`);
    assert.deepEqual(req.body, {
      status_option: 'PAUSED',
      deep_copy: deepCopy,
      rename_options: {
        rename_strategy: 'DEEP_RENAME',
        rename_suffix: DEFAULT_RENAME_SUFFIX,
      },
    });
  }
  const ad = normalizeAdNode({ id: AD_ID, campaign_id: CAMPAIGN_ID });
  const adPlan = planCopy(
    input({ objectId: AD_ID, level: 'ad', tree: { source: ad, campaign: campaign() } }),
  );
  const body = copyRequest(adPlan).body as Record<string, unknown>;
  assert.equal(body.status_option, 'PAUSED');
  assert.equal('deep_copy' in body, false);
  assert.equal('parameter_overrides' in body, false);
  assert.equal('migrate_to_advantage_plus' in body, false);
});

test('the answer parser reads the copied id and the copied objects', () => {
  const parsed = parseCopyResult('campaign', {
    copied_campaign_id: '900',
    ad_object_ids: [
      { ad_object_type: 'campaign', source_id: CAMPAIGN_ID, copied_id: '900' },
      { ad_object_type: 'ad_set', source_id: ADSET_ID, copied_id: 901 },
      { ad_object_type: 'ad', source_id: 'bad', copied_id: '902' },
      'junk',
    ],
  });
  assert.equal(parsed.copiedId, '900');
  assert.deepEqual(parsed.copiedObjects, [
    { type: 'campaign', source_id: CAMPAIGN_ID, copied_id: '900' },
    { type: 'ad_set', source_id: ADSET_ID, copied_id: '901' },
  ]);
  assert.equal(parseCopyResult('adset', { copied_adset_id: '5' }).copiedId, '5');
  assert.equal(parseCopyResult('ad', { copied_campaign_id: '5' }).copiedId, undefined);
  assert.deepEqual(parseCopyResult('ad', null), { copiedObjects: [] });
});

test('the tree read checks the parent campaign and counts children for a deep copy', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    (r) => r.path === `/${ADSET_ID}`,
    fbOk({ id: ADSET_ID, campaign_id: CAMPAIGN_ID, status: 'PAUSED', account_id: '1' }),
  );
  fb.on(
    (r) => r.path === `/${CAMPAIGN_ID}`,
    fbOk({ id: CAMPAIGN_ID, spend_cap: '100000', special_ad_categories: [] }),
  );
  fb.on(
    (r) => r.path === `/${ADSET_ID}/ads`,
    fbOk({ data: [], summary: { total_count: 2 } }),
  );
  const tree = await readCopyTree(fb.fn, {
    objectId: ADSET_ID,
    level: 'adset',
    deepCopy: true,
  });
  assert.equal(tree.campaign.id, CAMPAIGN_ID);
  assert.equal(tree.childAds, 2);
  assert.equal(tree.childAdSets, undefined);
  const campaignRead = fb.calls[1] as JsonRequest;
  assert.match(String(campaignRead.params?.fields), /special_ad_categories/);
  assert.match(String(campaignRead.params?.fields), /spend_cap/);
});

test('a campaign deep copy reads every ad set budget, or none', async () => {
  const fb = createFakeFbRequest();
  fb.on((r) => r.path === `/${CAMPAIGN_ID}`, fbOk({ id: CAMPAIGN_ID }));
  fb.on((r) => r.path === `/${CAMPAIGN_ID}/ads`, fbOk({ summary: { total_count: 1 } }));
  fb.on(
    (r) => r.path === `/${CAMPAIGN_ID}/adsets`,
    fbOk({
      data: [
        { id: '11', daily_budget: '700' },
        { id: '12', lifetime_budget: '0' },
      ],
      summary: { total_count: 2 },
    }),
  );
  const tree = await readCopyTree(fb.fn, {
    objectId: CAMPAIGN_ID,
    level: 'campaign',
    deepCopy: true,
  });
  assert.deepEqual(tree.childAdSets, [{ id: '11', dailyBudgetMinor: 700 }, { id: '12' }]);

  const partial = createFakeFbRequest();
  partial.on((r) => r.path === `/${CAMPAIGN_ID}`, fbOk({ id: CAMPAIGN_ID }));
  partial.on((r) => r.path === `/${CAMPAIGN_ID}/ads`, fbErr(graphError(17, 'throttled')));
  partial.on(
    (r) => r.path === `/${CAMPAIGN_ID}/adsets`,
    fbOk({ data: [{ id: '11' }], summary: { total_count: 60 } }),
  );
  const unknown = await readCopyTree(partial.fn, {
    objectId: CAMPAIGN_ID,
    level: 'campaign',
    deepCopy: true,
  });
  assert.equal(unknown.childAds, undefined);
  assert.equal(unknown.childAdSets, undefined);
});

test('a tree read whose source names no campaign refuses', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk({ id: AD_ID }));
  await assert.rejects(
    readCopyTree(fb.fn, { objectId: AD_ID, level: 'ad', deepCopy: false }),
    /did not name its campaign/,
  );
});

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

test('verification re-pauses a copy that came back active and reports it', async () => {
  const fb = createFakeFbRequest();
  fb.on((r) => r.method === 'GET' && r.path === '/900', fbOk({ status: 'PAUSED' }));
  fb.on((r) => r.method === 'GET' && r.path === '/901', fbOk({ status: 'ACTIVE' }));
  fb.on((r) => r.method === 'GET' && r.path === '/902', fbErr(graphError(100, 'nope')));
  fb.on((r) => r.method === 'POST' && r.path === '/901', fbOk({ success: true }));
  const out = await verifyPaused(fb.fn, ['900', '901', '902']);
  assert.deepEqual(out.paused, ['900']);
  assert.deepEqual(out.repaused, [{ id: '901', found: 'ACTIVE', repaused: true }]);
  assert.deepEqual(out.unreadable, ['902']);
  const repause = fb.calls.find((c) => c.method === 'POST') as JsonRequest;
  assert.deepEqual(repause.body, { status: 'PAUSED' });
  assert.match(
    String(pauseAlert(out)),
    /^WARNING: .*901 came back ACTIVE and was paused again.*902/,
  );
  assert.equal(pauseAlert({ paused: ['1'], repaused: [], unreadable: [] }), undefined);
});

test('apply copies, verifies every copied id and maps a gone source', async () => {
  const plan = planCopy(
    input({
      deepCopy: true,
      tree: { source: campaign(), campaign: campaign(), childAds: 0, childAdSets: [] },
    }),
  );
  const fb = createFakeFbRequest();
  fb.on(
    (r) => r.method === 'POST' && r.path === `/${CAMPAIGN_ID}/copies`,
    fbOk({
      copied_campaign_id: '900',
      ad_object_ids: [
        { ad_object_type: 'ad_set', source_id: ADSET_ID, copied_id: '901' },
      ],
    }),
  );
  fb.on((r) => r.method === 'GET', fbOk({ status: 'PAUSED' }));
  const out = await applyCopy(fb.fn, plan);
  assert.equal(out.copiedId, '900');
  assert.equal(out.status, 'PAUSED');
  assert.deepEqual(out.verification.paused, ['900', '901']);
  assert.equal(out.alert, undefined);

  const gone = createFakeFbRequest();
  gone.on(() => true, fbErr(graphError(100, 'Unsupported post request.')));
  await assert.rejects(applyCopy(gone.fn, plan), /may be DELETED or ARCHIVED/);
});
