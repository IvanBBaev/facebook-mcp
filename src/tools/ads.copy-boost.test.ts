// Tests for the `ads` tool package: paused copies, the boost flow and the Self-Serve Ad
// Terms line.
//
// Split out of `ads.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/ads.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fbErr, fbOk, type FakeFbRequest } from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import type { FbRequest, Settings } from '../core/index.js';
import { COPY_INHERITS_AI_NOTE } from '../api/ads-copy.js';
import { ADS_TERMS_NOTE } from './ads-shared.js';
import {
  ACCOUNT_ID,
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

// ---------------------------------------------------------------------------
// Paused copies (v2 ads §7)
// ---------------------------------------------------------------------------

const COPY_SETTINGS: Partial<Settings> = {
  adsBudgetCeiling: 10_000,
  adsCampaignSpendCapMax: 500_000,
};

/** A capped campaign the copy tool may duplicate. */
function cappedCampaign(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return campaignNode({
    spend_cap: '100000',
    special_ad_categories: [],
    account_id: BARE_ACCOUNT_ID,
    ...overrides,
  });
}

test('a duplicate is an irreversible preview that copies nothing', async () => {
  const { fb, ctx, journal } = makeHarness(COPY_SETTINGS);
  stubWriteReads(fb, { object: cappedCampaign() });
  const dup = tool('facebook_duplicate_ad_object');

  const result = body(
    await dup.handler(
      dup.inputSchema.parse({ object_id: CAMPAIGN_ID, level: 'campaign' }),
      ctx,
    ),
  );

  assert.equal(result.status, 'preview');
  assert.equal(result.tier, 'irreversible');
  assert.match(str(result.summary), /PAUSED copy/);
  assert.ok(arr(result.warnings).some((w) => str(w).startsWith('If activated: ')));
  assert.ok(
    arr(result.warnings).includes(COPY_INHERITS_AI_NOTE),
    'the preview says the copy inherits the Advantage+ / creative-enhancement settings',
  );
  assert.equal(writes(fb).length, 0, 'a dry run may not copy');
  assert.equal(journal.entries.length, 0);
});

test('an applied duplicate sends status_option=PAUSED and verifies the copy', async () => {
  const { fb, ctx, journal } = makeHarness(COPY_SETTINGS);
  stubWriteReads(fb, { object: cappedCampaign() });
  fb.on(
    (r) => r.method === 'POST' && r.path === `/${CAMPAIGN_ID}/copies`,
    fbOk({ copied_campaign_id: '900' }),
  );
  fb.on((r) => r.method === 'GET' && r.path === '/900', fbOk({ status: 'PAUSED' }));
  const dup = tool('facebook_duplicate_ad_object');
  const args = { object_id: CAMPAIGN_ID, level: 'campaign' };

  const preview = body(await dup.handler(dup.inputSchema.parse(args), ctx));
  const applied = body(
    await dup.handler(
      dup.inputSchema.parse({ ...args, apply: true, plan_id: str(preview.planId) }),
      ctx,
    ),
  );

  assert.equal(applied.status, 'applied');
  const result = obj(applied.result);
  assert.equal(result.copiedId, '900');
  assert.equal(result.status, 'PAUSED');
  assert.equal(result.alert, undefined);
  const sent = writes(fb);
  assert.equal(sent.length, 1);
  const post = sent[0];
  assert.ok(post && isJson(post));
  assert.equal(obj(post.body).status_option, 'PAUSED');
  assert.equal(obj(post.body).deep_copy, false);
  const entry = journal.entries.at(-1);
  assert.equal(entry?.outcome, 'applied');
  assert.equal(entry?.metadata?.copiedCount, 1);
});

test('a copy that comes back active is re-paused and journaled separately', async () => {
  const { fb, ctx, journal } = makeHarness(COPY_SETTINGS);
  stubWriteReads(fb, { object: cappedCampaign() });
  fb.on(
    (r) => r.method === 'POST' && r.path === `/${CAMPAIGN_ID}/copies`,
    fbOk({ copied_campaign_id: '900' }),
  );
  fb.on((r) => r.method === 'GET' && r.path === '/900', fbOk({ status: 'ACTIVE' }));
  fb.on((r) => r.method === 'POST' && r.path === '/900', fbOk({ success: true }));
  const dup = tool('facebook_duplicate_ad_object');
  const args = { object_id: CAMPAIGN_ID, level: 'campaign' };

  const preview = body(await dup.handler(dup.inputSchema.parse(args), ctx));
  const applied = body(
    await dup.handler(
      dup.inputSchema.parse({ ...args, apply: true, plan_id: str(preview.planId) }),
      ctx,
    ),
  );

  assert.match(str(obj(applied.result).alert), /^WARNING: status_option=PAUSED was sent/);
  const repause = journal.entries.find((e) => /Re-paused/.test(e.summary));
  assert.equal(repause?.outcome, 'applied');
  assert.equal(journal.entries.at(-1)?.outcome, 'applied');
});

test('a duplicate of an uncapped campaign, or with no cap maximum set, is refused', async () => {
  const uncapped = makeHarness(COPY_SETTINGS);
  stubWriteReads(uncapped.fb, { object: cappedCampaign({ spend_cap: undefined }) });
  const dup = tool('facebook_duplicate_ad_object');
  const args: unknown = dup.inputSchema.parse({
    object_id: CAMPAIGN_ID,
    level: 'campaign',
  });
  await assert.rejects(() => dup.handler(args, uncapped.ctx), /has no spend cap/);
  assert.equal(writes(uncapped.fb).length, 0);

  const noMax = makeHarness({ adsBudgetCeiling: 10_000 });
  stubWriteReads(noMax.fb, { object: cappedCampaign() });
  await assert.rejects(
    () => dup.handler(args, noMax.ctx),
    /needs FB_ADS_CAMPAIGN_SPEND_CAP_MAX/,
  );
});

test('a duplicate of a campaign in another explicitly named account is refused', async () => {
  const { fb, ctx } = makeHarness(COPY_SETTINGS);
  stubWriteReads(fb, { object: cappedCampaign({ account_id: '9876543210' }) });
  const dup = tool('facebook_duplicate_ad_object');
  await assert.rejects(
    () =>
      dup.handler(
        dup.inputSchema.parse({
          object_id: CAMPAIGN_ID,
          level: 'campaign',
          ad_account_id: ACCOUNT_ID,
        }),
        ctx,
      ),
    new RegExp(`belongs to ad account ${OTHER_ACCOUNT_ID}`),
  );
  assert.equal(writes(fb).length, 0);
});

test('a duplicate requires level and bounds the rename suffix', () => {
  const dup = tool('facebook_duplicate_ad_object');
  assert.throws(() => dup.inputSchema.parse({ object_id: CAMPAIGN_ID }));
  assert.throws(() =>
    dup.inputSchema.parse({
      object_id: CAMPAIGN_ID,
      level: 'campaign',
      rename_suffix: 'x'.repeat(51),
    }),
  );
});

// ---------------------------------------------------------------------------
// 13. Boost a Page post (v2 ads §1) — the PAUSED create-chain
// ---------------------------------------------------------------------------

const BOOST_PAGE_ID = '111222333';
const BOOST_STORY_ID = `${BOOST_PAGE_ID}_444555666`;

/** The post read, as Graph answers it (hand-written — re-check after first live probe). */
function stubBoostReads(fb: FakeFbRequest, post: Record<string, unknown> = {}): void {
  stubWriteReads(fb, { currency: 'USD' });
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${BOOST_STORY_ID}`,
    fbOk({
      id: BOOST_STORY_ID,
      message: 'Autumn menu',
      is_eligible_for_promotion: true,
      ...post,
    }),
  );
}

const BOOST_ARGS = {
  page_id: BOOST_PAGE_ID,
  post_id: '444555666',
  daily_budget_minor: 1000,
  spend_cap_minor: 10_000,
  countries: ['US'],
  special_ad_category: 'none',
};

test('a boost is an irreversible preview that creates nothing', async () => {
  const { fb, ctx, journal } = makeHarness(COPY_SETTINGS);
  stubBoostReads(fb);
  const boost = tool('facebook_boost_post');

  const result = body(await boost.handler(boost.inputSchema.parse(BOOST_ARGS), ctx));

  assert.equal(result.status, 'preview');
  assert.equal(result.tier, 'irreversible');
  assert.match(str(result.summary), /PAUSED campaign, ad set, creative and ad/);
  assert.match(str(result.summary), /Step 4: POST \/act_1234567890\/ads \(ad, PAUSED\)/);
  assert.match(
    str(result.summary),
    new RegExp(`facebook_get_ad_preview .*${BOOST_STORY_ID}`),
  );
  assert.equal(writes(fb).length, 0, 'a dry run may not create anything');
  assert.equal(journal.entries.length, 0);
  const postRead = fb.calls.find((r) => r.path === `/${BOOST_STORY_ID}`);
  assert.equal(
    postRead?.token,
    'EAA-PAGE-TOKEN-01234',
    'the post is read with the Page token',
  );
});

test('an applied boost runs the four POSTs and journals every step under the plan tag', async () => {
  const { fb, ctx, journal } = makeHarness(COPY_SETTINGS);
  stubBoostReads(fb);
  const edge = (e: string) => (r: FbRequest) =>
    r.method === 'POST' && r.path === `/${ACCOUNT_ID}/${e}`;
  fb.on(edge('campaigns'), fbOk({ id: '100' }));
  fb.on(edge('adsets'), fbOk({ id: '200' }));
  fb.on(edge('adcreatives'), fbOk({ id: '300' }));
  fb.on(edge('ads'), fbOk({ id: '400' }));
  const boost = tool('facebook_boost_post');

  const preview = body(await boost.handler(boost.inputSchema.parse(BOOST_ARGS), ctx));
  const applied = body(
    await boost.handler(
      boost.inputSchema.parse({
        ...BOOST_ARGS,
        apply: true,
        plan_id: str(preview.planId),
      }),
      ctx,
    ),
  );

  assert.equal(applied.status, 'applied');
  const result = obj(applied.result);
  assert.equal(result.outcome, 'applied');
  assert.equal(result.ad_id, '400');
  assert.match(str(result.report), /^Created a PAUSED campaign 100/);
  const sent = writes(fb);
  assert.equal(sent.length, 4);
  for (const req of sent) {
    assert.ok(isJson(req));
    const sentBody = obj(req.body);
    if ('status' in sentBody) assert.equal(sentBody.status, 'PAUSED');
    assert.match(str(sentBody.name), /\[fbmcp:plan1\]$/);
  }
  const sentTo = (e: string) => {
    const req = sent.find((r) => r.path === `/${ACCOUNT_ID}/${e}`);
    assert.ok(req && isJson(req));
    return obj(req.body);
  };
  assert.deepEqual(sentTo('campaigns').special_ad_categories, []);
  assert.deepEqual(obj(sentTo('adsets').targeting).targeting_automation, {
    advantage_audience: 0,
  });
  const features = obj(
    obj(sentTo('adcreatives').degrees_of_freedom_spec).creative_features_spec,
  );
  assert.ok(Object.keys(features).length > 0);
  for (const [name, value] of Object.entries(features)) {
    assert.deepEqual(value, { enroll_status: 'OPT_OUT' }, `${name} is pinned off`);
  }
  const steps = journal.entries.filter((e) => e.metadata?.chain === 'boost');
  assert.equal(steps.length, 8);
  assert.ok(steps.every((e) => e.metadata?.planTag === 'fbmcp:plan1'));
  assert.equal(journal.entries.at(-1)?.outcome, 'applied');
});

test('a boost whose ad step is refused rolls back and reports it as not applied', async () => {
  const { fb, ctx, journal } = makeHarness(COPY_SETTINGS);
  stubBoostReads(fb);
  const edge = (e: string) => (r: FbRequest) =>
    r.method === 'POST' && r.path === `/${ACCOUNT_ID}/${e}`;
  fb.on(edge('campaigns'), fbOk({ id: '100' }));
  fb.on(edge('adsets'), fbOk({ id: '200' }));
  fb.on(edge('adcreatives'), fbOk({ id: '300' }));
  fb.on(
    edge('ads'),
    fbErr(new GraphApiError('Invalid creative', { code: 100, httpStatus: 400 })),
  );
  fb.on((r) => r.path === '/200' || r.path === '/100', fbOk({ success: true }));
  const boost = tool('facebook_boost_post');

  const preview = body(await boost.handler(boost.inputSchema.parse(BOOST_ARGS), ctx));
  const applied = body(
    await boost.handler(
      boost.inputSchema.parse({
        ...BOOST_ARGS,
        apply: true,
        plan_id: str(preview.planId),
      }),
      ctx,
    ),
  );

  const result = obj(applied.result);
  assert.equal(result.outcome, 'rolled_back');
  assert.equal(arr(result.rolled_back).length, 2);
  assert.ok(
    journal.entries.some(
      (e) => e.metadata?.step === 'rollback:campaign' && e.outcome === 'applied',
    ),
  );
});

test('a boost is refused before any write when the inputs are unsafe', async () => {
  const boost = tool('facebook_boost_post');
  const refusals: [
    Partial<Settings>,
    Record<string, unknown>,
    Record<string, unknown>,
    RegExp,
  ][] = [
    [COPY_SETTINGS, { lifetime_budget_minor: 5000 }, {}, /exactly one of/],
    [{ adsBudgetCeiling: 10_000 }, {}, {}, /FB_ADS_CAMPAIGN_SPEND_CAP_MAX/],
    [COPY_SETTINGS, { countries: ['DE'] }, {}, /EU\/EEA/],
    [COPY_SETTINGS, {}, { is_eligible_for_promotion: false }, /not eligible/],
    [COPY_SETTINGS, { post_id: '999_444555666' }, {}, /belongs to Page 999/],
  ];
  for (const [settings, extra, post, pattern] of refusals) {
    const { fb, ctx } = makeHarness(settings);
    stubBoostReads(fb, post);
    const args: unknown = boost.inputSchema.parse({ ...BOOST_ARGS, ...extra });
    await assert.rejects(() => boost.handler(args, ctx), pattern);
    assert.equal(writes(fb).length, 0);
  }
});

test('a boost needs the special-ad-category attestation, bound to the plan (LEG-04)', async () => {
  const boost = tool('facebook_boost_post');
  const withoutAttestation: Record<string, unknown> = { ...BOOST_ARGS };
  delete withoutAttestation.special_ad_category;

  assert.throws(
    () => boost.inputSchema.parse(withoutAttestation),
    /Required: special_ad_category/,
  );
  for (const category of ['housing', 'EMPLOYMENT', 'ISSUES_ELECTIONS_POLITICS', '']) {
    assert.throws(
      () => boost.inputSchema.parse({ ...BOOST_ARGS, special_ad_category: category }),
      /does not support special-category ads/,
      category,
    );
  }

  const { fb, ctx } = makeHarness(COPY_SETTINGS);
  stubBoostReads(fb);
  const preview = body(await boost.handler(boost.inputSchema.parse(BOOST_ARGS), ctx));
  assert.match(str(preview.summary), /Special ad category: none — the operator attests/);
  assert.match(str(preview.summary), /Advantage\+ audience off .* OPT_OUT/);
  // The handler re-parses strictly, so a schema-bypassing call is refused too.
  await assert.rejects(
    () => boost.handler(withoutAttestation, ctx),
    /Required: special_ad_category/,
  );
  assert.equal(writes(fb).length, 0);
});

test('every ads write tool states the Self-Serve Ad Terms line', () => {
  const writeTools = PACKAGE.tools.filter((t) => t.writeTier !== undefined);
  assert.equal(writeTools.length, 7);
  for (const spec of writeTools) {
    assert.ok(
      spec.description.includes(ADS_TERMS_NOTE),
      `${spec.name} misses the terms line`,
    );
  }
});
