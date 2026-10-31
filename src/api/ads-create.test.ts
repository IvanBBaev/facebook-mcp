// Tests for the boost create-chain module (v2 ads §1): the planner's refusals,
// the four step bodies, and the chain — applied, rejected → rollback, lost
// answer → reconcile by plan tag, failed delete → partial, cancellation. Every
// Graph call goes through the injected fake — no network, ever. The response
// shapes are hand-written — re-check after the first live probe.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeFbRequest, fbErr, fbOk } from '../core/fakes/index.js';
import {
  GraphApiError,
  ambiguousWriteAction,
  classifyGraphError,
  type FbRequest,
  type JsonRequest,
} from '../core/index.js';

import {
  BOOST_AI_FEATURES_LINE,
  BOOST_PAUSED_NOTE,
  CREATIVE_KEPT_NOTE,
  DEFAULT_START_OFFSET_MS,
  SPECIAL_AD_CATEGORY_ATTESTATION_LINE,
  boostPlanTag,
  boostReport,
  boostStepBody,
  boostStoryId,
  parseBoostPost,
  planBoost,
  plannedSteps,
  readDsaDefaults,
  runBoostChain,
  stepFailureClass,
  type BoostPlan,
  type BoostPlanInput,
  type BoostStepEvent,
} from './ads-create.js';

const ACCOUNT_ID = 'act_1234567890';
const PAGE_ID = '111222333';
const STORY_ID = `${PAGE_ID}_444555666`;
const NOW = Date.parse('2026-10-27T00:00:00Z');
const TAG = 'fbmcp:abcd1234';

function input(overrides: Partial<BoostPlanInput> = {}): BoostPlanInput {
  return {
    account: { id: ACCOUNT_ID, currency: 'USD', statusLabel: 'ACTIVE' },
    pageId: PAGE_ID,
    post: { id: STORY_ID, message: 'Autumn menu', eligible: true, hasLink: false },
    objective: 'OUTCOME_ENGAGEMENT',
    budget: { kind: 'daily', amountMinor: 1000 },
    spendCapMinor: 10_000,
    bidStrategy: 'LOWEST_COST_WITHOUT_CAP',
    countries: ['US'],
    ageMin: 18,
    ageMax: 65,
    accountHasDsaDefaults: false,
    specialAdCategory: 'none',
    spendCapMaxMinor: 50_000,
    now: NOW,
    ...overrides,
  };
}

function plan(overrides: Partial<BoostPlanInput> = {}): BoostPlan {
  return planBoost(input(overrides));
}

function rejected(message: string, code = 100): GraphApiError {
  return new GraphApiError(message, {
    code,
    httpStatus: 400,
    action: classifyGraphError({ code, message }),
  });
}

function lost(): GraphApiError {
  return new GraphApiError('answer lost', {
    code: 0,
    httpStatus: 200,
    action: ambiguousWriteAction({ detail: 'body lost' }),
  });
}

function isJson(req: FbRequest | undefined): req is JsonRequest {
  return req?.protocol === 'json';
}

function postTo(edge: string) {
  return (r: FbRequest) => r.method === 'POST' && r.path === `/${ACCOUNT_ID}/${edge}`;
}

function stubChain(fb: ReturnType<typeof createFakeFbRequest>): void {
  fb.on(postTo('campaigns'), fbOk({ id: '100' }));
  fb.on(postTo('adsets'), fbOk({ id: '200' }));
  fb.on(postTo('adcreatives'), fbOk({ id: '300' }));
  fb.on(postTo('ads'), fbOk({ id: '400' }));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

test('boostStoryId composes bare ids and refuses a post from another Page', () => {
  assert.equal(boostStoryId(PAGE_ID, '444555666'), STORY_ID);
  assert.equal(boostStoryId(PAGE_ID, STORY_ID), STORY_ID);
  assert.throws(() => boostStoryId(PAGE_ID, '999_444555666'), /belongs to Page 999/);
  assert.throws(() => boostStoryId(PAGE_ID, 'abc'), /must be digits/);
});

test('parseBoostPost reads eligibility and link attachments, and refuses a mismatched id', () => {
  const post = parseBoostPost(STORY_ID, {
    id: STORY_ID,
    message: 'hi',
    is_eligible_for_promotion: true,
    attachments: { data: [{ unshimmed_url: 'https://example.com' }] },
  });
  assert.equal(post.eligible, true);
  assert.equal(post.hasLink, true);
  assert.equal(parseBoostPost(STORY_ID, {}).eligible, undefined);
  assert.throws(() => parseBoostPost(STORY_ID, { id: '1_2' }), /not on that Page/);
});

test('readDsaDefaults needs both defaults and treats a refused read as none', async () => {
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ default_dsa_payor: 'Acme', default_dsa_beneficiary: 'Acme' }));
  assert.equal(await readDsaDefaults(fb.fn, ACCOUNT_ID), true);
  fb.enqueue(fbOk({ default_dsa_payor: 'Acme' }));
  assert.equal(await readDsaDefaults(fb.fn, ACCOUNT_ID), false);
  fb.enqueue(fbErr(rejected('nope', 200)));
  assert.equal(await readDsaDefaults(fb.fn, ACCOUNT_ID), false);
});

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

test('a plan defaults the start to ten minutes out and carries the safety notes', () => {
  const p = plan();
  assert.equal(p.startTime, new Date(NOW + DEFAULT_START_OFFSET_MS).toISOString());
  assert.equal(p.optimizationGoal, 'POST_ENGAGEMENT');
  assert.ok(p.warnings.includes(BOOST_PAUSED_NOTE));
  assert.match(p.summary, /PAUSED campaign, ad set, creative and ad/);
  assert.equal(p.baseName, `Boost ${STORY_ID}`);
});

test('the planner refuses every unsafe or unworkable boost', () => {
  const cases: [string, Partial<BoostPlanInput>, RegExp][] = [
    ['no cap maximum', { spendCapMaxMinor: undefined }, /FB_ADS_CAMPAIGN_SPEND_CAP_MAX/],
    ['cap above maximum', { spendCapMinor: 60_000 }, /spend_cap_minor/],
    [
      'cap below Meta minimum',
      {
        account: {
          id: ACCOUNT_ID,
          currency: 'USD',
          statusLabel: 'ACTIVE',
          minCampaignSpendCapMinor: 20_000,
        },
      },
      /minimum campaign spend cap/,
    ],
    ['budget above ceiling', { budgetCeilingMinor: 500 }, /daily_budget_minor/],
    [
      'daily budget below Meta minimum',
      {
        account: {
          id: ACCOUNT_ID,
          currency: 'USD',
          statusLabel: 'ACTIVE',
          minDailyBudgetMinor: 2000,
        },
      },
      /minimum daily budget/,
    ],
    [
      'capped bid without amount',
      { bidStrategy: 'COST_CAP' },
      /bid_amount_minor` is required/,
    ],
    ['amount without capped bid', { bidAmountMinor: 100 }, /only applies to/],
    [
      'lifetime without end',
      { budget: { kind: 'lifetime', amountMinor: 5000 } },
      /lifetime budget needs `end_time`/,
    ],
    [
      'end before start',
      { startTime: '2026-11-02T00:00:00Z', endTime: '2026-11-01T00:00:00Z' },
      /must be after/,
    ],
    [
      'daily run under a day',
      { startTime: '2026-11-01T00:00:00Z', endTime: '2026-11-01T12:00:00Z' },
      /more than 24 hours/,
    ],
    ['bad time', { startTime: 'soon' }, /not a valid time/],
    ['ages inverted', { ageMin: 40, ageMax: 30 }, /age_min/],
    ['EU without DSA', { countries: ['us', 'de'] }, /EU\/EEA countries \(DE\)/],
    [
      'ineligible post',
      { post: { id: STORY_ID, eligible: false, hasLink: false } },
      /not eligible for promotion/,
    ],
    ['traffic without link', { objective: 'OUTCOME_TRAFFIC' }, /carries no link/],
  ];
  for (const [label, overrides, pattern] of cases) {
    assert.throws(() => plan(overrides), pattern, label);
  }
});

test('the plan refuses a missing or special-category attestation and shows the given one (LEG-04)', () => {
  // Callers that bypass the tool schema still meet the refusal.
  const loose = (value: unknown): Partial<BoostPlanInput> =>
    ({ specialAdCategory: value }) as unknown as Partial<BoostPlanInput>;
  assert.throws(() => plan(loose(undefined)), /Required: special_ad_category/);
  assert.throws(() => plan(loose('')), /Required: special_ad_category/);
  for (const category of [
    'housing',
    'EMPLOYMENT',
    'credit',
    'ISSUES_ELECTIONS_POLITICS',
  ]) {
    assert.throws(
      () => plan(loose(category)),
      /does not support special-category ads.*Nothing was created/,
      category,
    );
  }

  const p = plan();
  assert.equal(p.specialAdCategory, 'none');
  assert.ok(p.summary.includes(SPECIAL_AD_CATEGORY_ATTESTATION_LINE));
  assert.ok(p.summary.includes(BOOST_AI_FEATURES_LINE));
});

test('EU targeting passes with a dsa argument or account defaults', () => {
  const withDsa = plan({
    countries: ['de'],
    dsa: { payor: 'Acme GmbH', beneficiary: 'Acme GmbH' },
  });
  assert.equal(withDsa.euTargeted, true);
  assert.deepEqual(withDsa.countries, ['DE']);
  assert.equal(withDsa.dsa?.payor, 'Acme GmbH');

  const withDefaults = plan({ countries: ['FR'], accountHasDsaDefaults: true });
  assert.equal(withDefaults.dsa, undefined);
});

test('a lifetime budget above the cap warns that delivery stops at the cap', () => {
  const p = plan({
    budget: { kind: 'lifetime', amountMinor: 20_000 },
    endTime: '2026-11-10T00:00:00Z',
  });
  assert.ok(p.warnings.some((w) => /stops at the cap/.test(w)));
});

// ---------------------------------------------------------------------------
// Step bodies
// ---------------------------------------------------------------------------

test('every step is created PAUSED with no special category and the plan tag in its name', () => {
  const p = plan({
    bidStrategy: 'COST_CAP',
    bidAmountMinor: 300,
    countries: ['DE'],
    dsa: { payor: 'Acme', beneficiary: 'Acme' },
  });
  const ids = { campaign: '100', adset: '200', creative: '300' };

  const campaign = boostStepBody(p, 'campaign', TAG, ids);
  assert.equal(campaign.status, 'PAUSED');
  assert.deepEqual(campaign.special_ad_categories, []);
  assert.equal(campaign.spend_cap, 10_000);
  assert.equal(campaign.bid_strategy, 'COST_CAP');
  assert.equal(campaign.name, `Boost ${STORY_ID} [${TAG}]`);

  const adset = boostStepBody(p, 'adset', TAG, ids);
  assert.equal(adset.status, 'PAUSED');
  assert.equal(adset.campaign_id, '100');
  assert.equal(adset.daily_budget, 1000);
  assert.equal(adset.bid_amount, 300);
  assert.equal(adset.destination_type, 'ON_POST');
  assert.deepEqual(adset.promoted_object, { page_id: PAGE_ID });
  assert.equal(adset.dsa_payor, 'Acme');
  assert.deepEqual(adset.targeting, {
    geo_locations: { countries: ['DE'] },
    age_min: 18,
    age_max: 65,
    targeting_automation: { advantage_audience: 0 },
  });

  const creative = boostStepBody(p, 'creative', TAG, ids);
  assert.equal(creative.object_story_id, STORY_ID);
  // No Meta AI feature is left to a server-side default (Ad Terms 2026-11-20).
  assert.deepEqual(creative.degrees_of_freedom_spec, {
    creative_features_spec: {
      image_template: { enroll_status: 'OPT_OUT' },
      image_touchups: { enroll_status: 'OPT_OUT' },
      text_optimizations: { enroll_status: 'OPT_OUT' },
      inline_comment: { enroll_status: 'OPT_OUT' },
      video_auto_crop: { enroll_status: 'OPT_OUT' },
    },
  });

  const ad = boostStepBody(p, 'ad', TAG, ids);
  assert.equal(ad.status, 'PAUSED');
  assert.equal(ad.adset_id, '200');
  assert.deepEqual(ad.creative, { creative_id: '300' });
});

test('the preview steps carry placeholders, not ids', () => {
  const steps = plannedSteps(plan());
  assert.deepEqual(
    steps.map((s) => s.path),
    [
      `/${ACCOUNT_ID}/campaigns`,
      `/${ACCOUNT_ID}/adsets`,
      `/${ACCOUNT_ID}/adcreatives`,
      `/${ACCOUNT_ID}/ads`,
    ],
  );
  assert.equal(steps[1]?.params.campaign_id, '<campaign_id>');
  assert.match(String(steps[0]?.params.name), /\[fbmcp:<plan>\]$/);
});

test('boostPlanTag keeps eight characters of the plan id without dashes', () => {
  assert.equal(boostPlanTag('ab-cd-1234-5678-ffff'), 'fbmcp:abcd1234');
});

test('stepFailureClass separates a refusal from a lost answer', () => {
  assert.equal(stepFailureClass(rejected('bad')), 'rejected');
  assert.equal(stepFailureClass(lost()), 'ambiguous');
  assert.equal(
    stepFailureClass(new GraphApiError('down', { code: 2, httpStatus: 503 })),
    'ambiguous',
  );
  assert.equal(stepFailureClass(new Error('?')), 'ambiguous');
});

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

test('an applied chain creates four PAUSED objects in order and links them', async () => {
  const fb = createFakeFbRequest();
  stubChain(fb);
  const events: BoostStepEvent[] = [];
  const outcome = await runBoostChain(fb.fn, plan(), {
    planTag: TAG,
    onEvent: (e) => {
      events.push(e);
      return Promise.resolve();
    },
  });

  assert.equal(outcome.outcome, 'applied');
  assert.equal(outcome.campaign_id, '100');
  assert.equal(outcome.ad_id, '400');
  assert.equal(fb.calls.length, 4);
  const ad = fb.calls[3];
  assert.ok(isJson(ad));
  assert.equal((ad.body as Record<string, unknown>).adset_id, '200');
  assert.deepEqual(
    events.map((e) => `${e.step}:${e.outcome}`),
    [
      'campaign:attempted',
      'campaign:applied',
      'adset:attempted',
      'adset:applied',
      'creative:attempted',
      'creative:applied',
      'ad:attempted',
      'ad:applied',
    ],
  );
  assert.match(outcome.next_steps[0] ?? '', /object_id:"100"/);
  assert.match(outcome.ads_manager_url, /selected_campaign_ids=100/);
  assert.match(boostReport(outcome), /^Created a PAUSED campaign 100/);
});

test('a rejected step rolls back in reverse and keeps the creative', async () => {
  const fb = createFakeFbRequest();
  fb.on(postTo('campaigns'), fbOk({ id: '100' }));
  fb.on(postTo('adsets'), fbOk({ id: '200' }));
  fb.on(postTo('adcreatives'), fbOk({ id: '300' }));
  fb.on(postTo('ads'), fbErr(rejected('Ad creative is invalid', 100)));
  fb.on((r) => r.path === '/200' || r.path === '/100', fbOk({ success: true }));

  const outcome = await runBoostChain(fb.fn, plan(), { planTag: TAG });

  assert.equal(outcome.outcome, 'rolled_back');
  assert.equal(outcome.failed_step?.step, 'ad');
  assert.deepEqual(
    outcome.rolled_back.map((r) => r.id),
    ['200', '100'],
  );
  assert.deepEqual(outcome.applied, [
    { step: 'creative', id: '300', note: CREATIVE_KEPT_NOTE },
  ]);
  const deletes = fb.calls.slice(4);
  assert.equal(deletes[0]?.method, 'POST');
  assert.ok(isJson(deletes[0]));
  assert.deepEqual(deletes[0].body, { status: 'DELETED' });
  assert.equal(deletes[1]?.method, 'DELETE');
  assert.match(boostReport(outcome), /Everything created before it was deleted again/);
});

test('a rejected first step creates nothing and deletes nothing', async () => {
  const fb = createFakeFbRequest();
  fb.on(postTo('campaigns'), fbErr(rejected('Invalid spend cap')));
  const outcome = await runBoostChain(fb.fn, plan(), { planTag: TAG });
  assert.equal(outcome.outcome, 'rolled_back');
  assert.equal(fb.calls.length, 1);
  assert.deepEqual(outcome.applied, []);
});

test('a lost answer is reconciled by the plan tag before the rollback', async () => {
  const fb = createFakeFbRequest();
  fb.on(postTo('campaigns'), fbOk({ id: '100' }));
  fb.on(postTo('adsets'), fbErr(lost()));
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${ACCOUNT_ID}/adsets`,
    fbOk({ data: [{ id: '200', name: `Boost adset [${TAG}]` }] }),
  );
  fb.on((r) => r.path === '/200' || r.path === '/100', fbOk({ success: true }));
  const events: BoostStepEvent[] = [];

  const outcome = await runBoostChain(fb.fn, plan(), {
    planTag: TAG,
    onEvent: (e) => {
      events.push(e);
      return Promise.resolve();
    },
  });

  assert.equal(outcome.outcome, 'rolled_back');
  assert.deepEqual(
    outcome.rolled_back.map((r) => r.id),
    ['200', '100'],
  );
  const reconcile = fb.calls.find((r) => r.method === 'GET');
  assert.ok(isJson(reconcile));
  assert.match(String(reconcile.params?.filtering), /CONTAIN/);
  assert.ok(events.some((e) => e.reconciled === true && e.objectId === '200'));
});

test('a lost answer with nothing found rolls back what is known', async () => {
  const fb = createFakeFbRequest();
  fb.on(postTo('campaigns'), fbOk({ id: '100' }));
  fb.on(postTo('adsets'), fbErr(lost()));
  fb.on((r) => r.method === 'GET', fbOk({ data: [] }));
  fb.on((r) => r.path === '/100', fbOk({ success: true }));
  const outcome = await runBoostChain(fb.fn, plan(), { planTag: TAG });
  assert.equal(outcome.outcome, 'rolled_back');
  assert.deepEqual(
    outcome.rolled_back.map((r) => r.id),
    ['100'],
  );
});

test('a lost answer whose reconcile read fails leaves an unknown orphan', async () => {
  const fb = createFakeFbRequest();
  fb.on(postTo('campaigns'), fbErr(lost()));
  fb.on((r) => r.method === 'GET', fbErr(rejected('read refused', 200)));
  const outcome = await runBoostChain(fb.fn, plan(), { planTag: TAG });
  assert.equal(outcome.outcome, 'partial');
  assert.match(outcome.orphaned[0]?.reason ?? '', /unknown — check Ads Manager/);
  assert.match(outcome.next_steps[0] ?? '', new RegExp(TAG));
});

test('a creative lost answer is matched on object_story_id locally', async () => {
  const fb = createFakeFbRequest();
  fb.on(postTo('campaigns'), fbOk({ id: '100' }));
  fb.on(postTo('adsets'), fbOk({ id: '200' }));
  fb.on(postTo('adcreatives'), fbErr(lost()));
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${ACCOUNT_ID}/adcreatives`,
    fbOk({
      data: [
        { id: '301', name: `x [${TAG}]`, object_story_id: '1_2' },
        { id: '300', name: `y [${TAG}]`, object_story_id: STORY_ID },
      ],
    }),
  );
  fb.on((r) => r.path === '/200' || r.path === '/100', fbOk({ success: true }));
  const outcome = await runBoostChain(fb.fn, plan(), { planTag: TAG });
  assert.equal(outcome.outcome, 'rolled_back');
  assert.equal(outcome.creative_id, '300');
});

test('a 200 without an id is treated as a lost answer', async () => {
  const fb = createFakeFbRequest();
  fb.on(postTo('campaigns'), fbOk({}));
  fb.on((r) => r.method === 'GET', fbOk({ data: [] }));
  const outcome = await runBoostChain(fb.fn, plan(), { planTag: TAG });
  assert.equal(outcome.outcome, 'rolled_back');
  assert.match(outcome.failed_step?.error.message ?? '', /without an id/);
  assert.ok(fb.calls.some((r) => r.method === 'GET'));
});

test('a failed delete leaves a PAUSED orphan and a partial outcome', async () => {
  const fb = createFakeFbRequest();
  fb.on(postTo('campaigns'), fbOk({ id: '100' }));
  fb.on(postTo('adsets'), fbErr(rejected('bad targeting')));
  fb.on((r) => r.path === '/100', fbErr(rejected('delete refused', 200)));
  const outcome = await runBoostChain(fb.fn, plan(), { planTag: TAG });
  assert.equal(outcome.outcome, 'partial');
  assert.equal(outcome.orphaned[0]?.id, '100');
  assert.match(outcome.orphaned[0]?.reason ?? '', /PAUSED and will not spend/);
  assert.match(boostReport(outcome), /could not be cleaned up/);
});

test('a cancellation stops before the next step and still rolls back', async () => {
  const fb = createFakeFbRequest();
  const controller = new AbortController();
  fb.on(postTo('campaigns'), fbOk({ id: '100' }));
  fb.on((r) => r.path === '/100', fbOk({ success: true }));
  const outcome = await runBoostChain(fb.fn, plan(), {
    planTag: TAG,
    signal: controller.signal,
    onEvent: (e) => {
      if (e.step === 'campaign' && e.outcome === 'applied') controller.abort();
      return Promise.resolve();
    },
  });
  assert.equal(outcome.outcome, 'rolled_back');
  assert.equal(outcome.failed_step?.step, 'adset');
  assert.ok(!fb.calls.some((r) => r.path === `/${ACCOUNT_ID}/adsets`));
  const del = fb.calls.find((r) => r.path === '/100');
  assert.ok(isJson(del));
  assert.equal(del.signal, undefined, 'the rollback ignores the cancelled signal');
});
