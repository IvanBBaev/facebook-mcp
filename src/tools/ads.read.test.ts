// Tests for the `ads` tool package: package invariants, listings, previews, insights and
// report runs.
//
// Split out of `ads.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/ads.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeRedactor, fbErr, fbOk } from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import { planAdObjectUpdate } from '../api/ads-control.js';
import {
  ACCOUNT_ID,
  BARE_ACCOUNT_ID,
  CAMPAIGN_ID,
  NOW_MS,
  PACKAGE,
  arr,
  body,
  campaignNode,
  isJson,
  makeHarness,
  obj,
  str,
  text,
  tool,
} from '../testing/harness/ads.js';

const REPORT_RUN_ID = '6123456789012';

// ---------------------------------------------------------------------------
// 1. Package invariants (doc 06)
// ---------------------------------------------------------------------------

test('the ads package is off by default and plan-first', () => {
  assert.equal(PACKAGE.name, 'ads');
  assert.equal(
    PACKAGE.enabledByDefault,
    false,
    'a package that can move money must be opted into',
  );
  assert.equal(PACKAGE.writeModeDefault, 'plan');
});

test('every tool carries the annotation quadruple doc 06 pins', () => {
  const expected: Record<string, [boolean, boolean, boolean, boolean]> = {
    // name: [readOnly, destructive, idempotent, openWorld]
    facebook_list_campaigns: [true, false, true, true],
    facebook_list_adsets: [true, false, true, true],
    facebook_list_ads: [true, false, true, true],
    facebook_get_ad_object: [true, false, true, true],
    facebook_get_ad_preview: [true, false, true, true],
    facebook_ads_insights: [true, false, true, true],
    facebook_ads_report_status: [true, false, true, true],
    facebook_update_ad_object: [false, true, true, true],
    facebook_archive_ad_object: [false, true, true, true],
    facebook_delete_ad_object: [false, true, true, true],
    facebook_upload_ad_image: [false, false, true, true],
    facebook_get_ad_set_targeting: [true, false, true, true],
    facebook_update_ad_set_targeting: [false, true, true, true],
    facebook_duplicate_ad_object: [false, false, false, true],
    facebook_boost_post: [false, false, false, true],
  };

  assert.equal(PACKAGE.tools.length, Object.keys(expected).length);
  for (const spec of PACKAGE.tools) {
    const want = expected[spec.name];
    assert.ok(want, `unexpected tool ${spec.name}`);
    assert.deepEqual(
      [
        spec.annotations.readOnlyHint,
        spec.annotations.destructiveHint,
        spec.annotations.idempotentHint,
        spec.annotations.openWorldHint,
      ],
      want,
      `annotations for ${spec.name}`,
    );
    // defineTool enforces the equivalence, but assert it here too: a read tool
    // that grew a tier would otherwise be caught only at construction time.
    assert.equal(
      spec.writeTier === undefined,
      spec.annotations.readOnlyHint,
      `writeTier ⇔ readOnlyHint for ${spec.name}`,
    );
  }
});

test('only the update, lifecycle, image upload, targeting, duplicate and boost tools can write, and none claims to be read-only', () => {
  const writers = PACKAGE.tools.filter((t) => t.writeTier !== undefined);
  assert.deepEqual(
    writers.map((t) => t.name),
    [
      'facebook_update_ad_object',
      'facebook_archive_ad_object',
      'facebook_delete_ad_object',
      'facebook_upload_ad_image',
      'facebook_update_ad_set_targeting',
      'facebook_duplicate_ad_object',
      'facebook_boost_post',
    ],
  );
});

/**
 * The arguments this package has cleared for stderr: the account and object ids
 * an operator already has in configuration and sees in Graph URLs, the enum-ish
 * knobs that describe a query, and the write-gate flags. Free text, money
 * amounts and `confirm_token` are absent by construction, so a new allowlist
 * entry has to be argued into this set before the audit below will accept it.
 */
const SAFE_TO_LOG: ReadonlySet<string> = new Set([
  'ad_account_id',
  'object_id',
  'adset_id',
  'level',
  'deep_copy',
  'status',
  'apply',
  'plan_id',
  'date_preset',
  'since',
  'until',
  'force_async',
  'page_id',
  'post_id',
  'objective',
  'special_ad_category',
]);

test('every log allowlist in the package names real, non-secret arguments', () => {
  // `logFields` is what the bootstrap will actually put in the per-call log line
  // (04 §"Log hygiene"), so the declarations are audited rather than trusted:
  // this table IS the reviewed decision, and a tool missing from it must stay
  // silent. A key that is not an argument of the tool would log nothing while
  // reading like a control, and a key outside SAFE_TO_LOG has not been reviewed
  // at all.
  const expected: Record<string, readonly string[]> = {
    facebook_ads_insights: [
      'ad_account_id',
      'object_id',
      'level',
      'date_preset',
      'since',
      'until',
      'force_async',
    ],
    facebook_update_ad_object: ['object_id', 'level', 'status', 'apply', 'plan_id'],
    facebook_archive_ad_object: ['object_id', 'level', 'apply', 'plan_id'],
    facebook_delete_ad_object: ['object_id', 'level', 'apply', 'plan_id'],
    facebook_upload_ad_image: ['ad_account_id', 'apply', 'plan_id'],
    facebook_update_ad_set_targeting: ['adset_id', 'apply', 'plan_id'],
    facebook_duplicate_ad_object: ['object_id', 'level', 'deep_copy', 'apply', 'plan_id'],
    facebook_boost_post: [
      'page_id',
      'post_id',
      'objective',
      'special_ad_category',
      'apply',
      'plan_id',
    ],
  };

  for (const spec of PACKAGE.tools) {
    const want = expected[spec.name];
    if (want === undefined) {
      assert.equal(
        spec.logFields,
        undefined,
        `${spec.name} started logging without being audited here`,
      );
      continue;
    }
    assert.deepEqual(
      [...(spec.logFields ?? [])],
      [...want],
      `${spec.name}'s allowlist changed without this audit changing with it`,
    );

    // Zod's runtime shape is the argument list; reading it keeps the audit
    // honest if an argument is ever renamed out from under an allowlist.
    const { shape } = spec.inputSchema as unknown as {
      readonly shape: Record<string, unknown>;
    };
    for (const key of want) {
      assert.ok(key in shape, `${spec.name} logs ${key}, which is not an argument`);
      assert.ok(SAFE_TO_LOG.has(key), `${spec.name} logs ${key}, which is not cleared`);
    }
  }

  // The named dangers, spelled out so the reason survives a refactor of the set:
  // the operator's out-of-band secret, the model-composed field list, and the
  // two budget amounts that are the whole point of the write gate.
  for (const banned of [
    'confirm_token',
    'fields',
    'daily_budget_minor',
    'lifetime_budget_minor',
  ]) {
    assert.ok(!SAFE_TO_LOG.has(banned), `${banned} must never be cleared for stderr`);
  }
});

test('the declared write tier is the worst tier the planner can actually reach', () => {
  // `writeTier` on the spec is a claim, not a mechanism: nothing reads its VALUE
  // to gate anything (the gate is handed `plan.tier` by the handler), and it is
  // published as the tier column of the generated README. That combination is
  // how it drifted — the literal could be changed to anything without a single
  // test noticing. So audit it against the thing it claims to summarise: the
  // real planner, driven down both of its branches.
  const base = { objectId: '23851234567890123', level: 'campaign' } as const;
  const current = {
    id: '23851234567890123',
    status: 'PAUSED',
    effective_status: 'PAUSED',
    delivering: false,
    status_explanation: 'paused',
  };
  const pause = planAdObjectUpdate({ ...base, status: 'PAUSED' }, { current });
  const resume = planAdObjectUpdate({ ...base, status: 'ACTIVE' }, { current });

  assert.equal(pause.tier, 'irreversible', 'a pause should still be the lower tier');
  assert.equal(resume.tier, 'spend', 'resuming delivery spends money');

  const spec = PACKAGE.tools.find((t) => t.name === 'facebook_update_ad_object');
  assert.ok(spec, 'facebook_update_ad_object is missing from the package');
  assert.equal(
    spec.writeTier,
    'spend',
    `facebook_update_ad_object declares '${String(spec.writeTier)}' but a call to it can ` +
      `reach 'spend'. The declaration is what the README publishes to operators, so it ` +
      `has to name the worst case, not the first branch someone thought of.`,
  );
});

// ---------------------------------------------------------------------------
// 2. Listings
// ---------------------------------------------------------------------------

test('each listing tool reads its own edge under the configured ad account', async () => {
  for (const [name, edge] of [
    ['facebook_list_campaigns', 'campaigns'],
    ['facebook_list_adsets', 'adsets'],
    ['facebook_list_ads', 'ads'],
  ] as const) {
    const { fb, ctx } = makeHarness();
    fb.on(() => true, fbOk({ data: [campaignNode()] }));

    const result = body(await tool(name).handler({}, ctx));

    const req = fb.lastRequest();
    assert.ok(req && isJson(req));
    assert.equal(req.method, 'GET');
    assert.equal(req.host, 'graph');
    assert.equal(req.path, `/${ACCOUNT_ID}/${edge}`);
    assert.equal(result.accountId, ACCOUNT_ID);
  }
});

test('a bare numeric ad account argument is normalised to its act_ form', async () => {
  const { fb, ctx } = makeHarness({ adAccountId: undefined });
  fb.on(() => true, fbOk({ data: [] }));

  await tool('facebook_list_campaigns').handler({ ad_account_id: BARE_ACCOUNT_ID }, ctx);

  const req = fb.lastRequest();
  assert.ok(req && isJson(req));
  assert.equal(req.path, `/${ACCOUNT_ID}/campaigns`);
});

test('no ad account anywhere fails with a message naming FB_AD_ACCOUNT_ID', async () => {
  const { fb, ctx } = makeHarness({ adAccountId: undefined });

  await assert.rejects(
    () => tool('facebook_list_campaigns').handler({}, ctx),
    /FB_AD_ACCOUNT_ID/,
  );
  assert.equal(fb.calls.length, 0, 'a configuration gap must not reach the wire');
});

test('a Page id in ad_account_id is refused before the request', async () => {
  const { fb, ctx } = makeHarness();

  await assert.rejects(
    () => tool('facebook_list_ads').handler({ ad_account_id: 'my-page' }, ctx),
    /Invalid ad account id/,
  );
  assert.equal(fb.calls.length, 0);
});

test('paging and the server-side effective_status filter reach Graph verbatim', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(() => true, fbOk({ data: [] }));

  await tool('facebook_list_adsets').handler(
    {
      limit: 5,
      after: 'CURSOR-1',
      effective_status: ['ACTIVE', 'CAMPAIGN_PAUSED'],
      fields: 'id,name,daily_budget',
    },
    ctx,
  );

  const req = fb.lastRequest();
  assert.ok(req && isJson(req));
  const params = obj(req.params);
  assert.equal(params.limit, 5);
  assert.equal(params.after, 'CURSOR-1');
  // The override reaches Graph verbatim, but the delivery fields are appended
  // rather than dropped: without `effective_status` every row would normalise to
  // `delivering: false` and the listing would report paused ads as the truth
  // (CC-ADS-2).
  assert.equal(params.fields, 'id,name,daily_budget,status,effective_status');
  // Graph wants this filter as a JSON array literal, not repeated keys.
  assert.equal(params.effective_status, '["ACTIVE","CAMPAIGN_PAUSED"]');
});

test('listings surface the delivery truth, not just the configured status', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(
    () => true,
    fbOk({
      data: [
        campaignNode({ status: 'ACTIVE', effective_status: 'CAMPAIGN_PAUSED' }),
        campaignNode({ id: '2', status: 'ACTIVE', effective_status: 'ACTIVE' }),
      ],
    }),
  );

  const result = body(await tool('facebook_list_campaigns').handler({}, ctx));
  const objects = arr(result.objects);

  const first = obj(objects[0]);
  assert.equal(first.delivering, false, 'ACTIVE under a paused parent is NOT delivering');
  assert.ok(str(first.status_explanation).length > 0);
  assert.equal(obj(objects[1]).delivering, true);
  // Budgets arrive as strings and must leave as integer minor units (CC-ADS-3).
  assert.equal(first.daily_budget_minor, 5000);
  assert.equal(first.daily_budget, undefined);
});

// ---------------------------------------------------------------------------
// 3. Single-object read
// ---------------------------------------------------------------------------

test('facebook_get_ad_object reads /{id} and passes the level through', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(() => true, fbOk(campaignNode()));

  const result = body(
    await tool('facebook_get_ad_object').handler(
      { object_id: CAMPAIGN_ID, level: 'campaign' },
      ctx,
    ),
  );

  const req = fb.lastRequest();
  assert.ok(req && isJson(req));
  assert.equal(req.path, `/${CAMPAIGN_ID}`);
  assert.equal(result.level, 'campaign');
  assert.equal(obj(result.object).id, CAMPAIGN_ID);
});

// ---------------------------------------------------------------------------
// 3a. facebook_get_ad_preview
// ---------------------------------------------------------------------------

const PREVIEW_SRC =
  'https://www.facebook.com/ads/api/preview_iframe.php?d=AQPLACEHOLDER&t=AQPLACEHOLDERTOKEN';

function previewAnswer(): Record<string, unknown> {
  return {
    data: [{ body: `<iframe src="${PREVIEW_SRC.replace(/&/g, '&amp;')}"></iframe>` }],
  };
}

test('facebook_get_ad_preview renders an ad in the default placement', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(() => true, fbOk(previewAnswer()));

  const result = body(
    await tool('facebook_get_ad_preview').handler(
      { source: { kind: 'ad', id: '120200000000001' } },
      ctx,
    ),
  );

  const req = fb.lastRequest();
  assert.ok(req && isJson(req));
  assert.equal(req.method, 'GET');
  assert.equal(req.path, '/120200000000001/previews');
  assert.deepEqual(req.params, { ad_format: 'MOBILE_FEED_STANDARD' });
  assert.equal(result.iframeSrc, PREVIEW_SRC);
  assert.equal(result.adFormat, 'MOBILE_FEED_STANDARD');
  assert.equal(result.validUntil, new Date(NOW_MS + 24 * 60 * 60 * 1000).toISOString());
  assert.ok(
    !text(
      await tool('facebook_get_ad_preview').handler(
        { source: { kind: 'ad', id: '120200000000001' } },
        ctx,
      ),
    ).includes('<iframe'),
    'the HTML never reaches the model',
  );
});

test('facebook_get_ad_preview renders a Page post through the ad account', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(() => true, fbOk(previewAnswer()));

  await tool('facebook_get_ad_preview').handler(
    { source: { kind: 'post', id: '900_555' }, ad_format: 'INSTAGRAM_REELS' },
    ctx,
  );

  const req = fb.lastRequest();
  assert.ok(req && isJson(req));
  assert.equal(req.path, `/${ACCOUNT_ID}/generatepreviews`);
  assert.deepEqual(req.params, {
    ad_format: 'INSTAGRAM_REELS',
    creative: '{"object_story_id":"900_555"}',
  });
});

test('facebook_get_ad_preview refuses malformed sources before any request', async () => {
  const { fb, ctx } = makeHarness();
  const refused: Record<string, unknown>[] = [
    { source: { kind: 'ad', id: '900_555' } },
    { source: { kind: 'creative', id: 'act_1' } },
    { source: { kind: 'post', id: '555' } },
    { source: { kind: 'ad', id: '..' } },
    { source: { kind: 'ad', id: '1' }, ad_format: 'BANNER' },
  ];
  for (const args of refused) {
    await assert.rejects(
      () => tool('facebook_get_ad_preview').handler(args, ctx),
      Error,
      JSON.stringify(args),
    );
  }
  assert.equal(fb.calls.length, 0);
});

test('an Ads Manager URL is rejected by the schema before any request', async () => {
  const { fb, ctx } = makeHarness();

  await assert.rejects(() =>
    tool('facebook_get_ad_object').handler(
      { object_id: 'https://adsmanager.facebook.com/adsmanager/manage/campaigns' },
      ctx,
    ),
  );
  assert.equal(fb.calls.length, 0);
});

test('a dot-segment object id cannot climb out of the pinned API version', async () => {
  const { fb, ctx } = makeHarness();

  await assert.rejects(() =>
    tool('facebook_get_ad_object').handler({ object_id: '..' }, ctx),
  );
  assert.equal(fb.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 4. Insights (CC-ADS-5)
// ---------------------------------------------------------------------------

test('insights default to the ad account and come back in sync mode', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(() => true, fbOk({ data: [{ impressions: '120', spend: '3.40' }] }));

  const result = body(await tool('facebook_ads_insights').handler({}, ctx));

  const req = fb.lastRequest();
  assert.ok(req && isJson(req));
  assert.equal(req.method, 'GET');
  assert.equal(req.path, `/${ACCOUNT_ID}/insights`);
  assert.equal(result.mode, 'sync');
  assert.equal(result.rowCount, 1);
});

test('an empty insights page reached with a cursor is not explained as "never delivered"', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(() => true, fbOk({ data: [] }));

  const result = body(
    await tool('facebook_ads_insights').handler(
      { date_preset: 'last_7d', after: 'CURSOR_2' },
      ctx,
    ),
  );

  const req = fb.lastRequest();
  assert.ok(req && isJson(req));
  assert.equal(req.params?.after, 'CURSOR_2');
  assert.equal(result.rowCount, 0);
  const notes = arr(result.notes).map(str);
  // The cursor came from a page that had rows; an empty continuation is the end
  // of the walk, not evidence that the account never delivered in the window.
  assert.equal(
    notes.some((note) => /never delivered/.test(note)),
    false,
    `an empty continuation must not claim no delivery: ${JSON.stringify(notes)}`,
  );
  assert.ok(notes.some((note) => /forward cursor/.test(note)));
});

test('the since/until window and breakdowns reach Graph in its own encoding', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(() => true, fbOk({ data: [] }));

  await tool('facebook_ads_insights').handler(
    {
      object_id: CAMPAIGN_ID,
      level: 'adset',
      since: '2026-07-01',
      until: '2026-07-31',
      breakdowns: ['age', 'gender'],
      time_increment: 'all_days',
    },
    ctx,
  );

  const req = fb.lastRequest();
  assert.ok(req && isJson(req));
  const params = obj(req.params);
  assert.equal(params.level, 'adset');
  assert.equal(params.time_range, '{"since":"2026-07-01","until":"2026-07-31"}');
  assert.equal(params.breakdowns, 'age,gender');
  assert.equal(params.time_increment, 'all_days');
});

test('a lone `until` is refused before the request instead of confusing Graph', async () => {
  const { fb, ctx } = makeHarness();

  await assert.rejects(
    () => tool('facebook_ads_insights').handler({ until: '2026-07-31' }, ctx),
    /pass BOTH/,
  );
  assert.equal(fb.calls.length, 0);
});

test('a reversed since/until window is refused before the request, on both paths', async () => {
  const { fb, ctx } = makeHarness();

  await assert.rejects(
    () =>
      tool('facebook_ads_insights').handler(
        { since: '2026-02-01', until: '2026-01-01' },
        ctx,
      ),
    /`since` \(2026-02-01\) is after `until` \(2026-01-01\)/,
  );
  await assert.rejects(
    () =>
      tool('facebook_ads_insights').handler(
        { since: '2026-02-01', until: '2026-01-01', force_async: true },
        ctx,
      ),
    /is after/,
  );
  await assert.rejects(
    () =>
      tool('facebook_ads_insights').handler(
        { since: '01/02/2026', until: '2026-02-01' },
        ctx,
      ),
    /YYYY-MM-DD/,
  );
  assert.equal(fb.calls.length, 0);
});

test('an oversized sync query falls back to an async run and reads no rows', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(
    (r) => r.method === 'GET',
    fbErr(
      new GraphApiError('Please reduce the amount of data', {
        code: 100,
        subcode: 1487534,
        httpStatus: 400,
        action: { category: 'validation', retryable: false, operatorText: 'too large' },
      }),
    ),
  );
  fb.on((r) => r.method === 'POST', fbOk({ report_run_id: REPORT_RUN_ID }));

  const result = body(
    await tool('facebook_ads_insights').handler({ breakdowns: ['age'] }, ctx),
  );

  assert.equal(result.mode, 'async');
  assert.equal(result.reportRunId, REPORT_RUN_ID);
  assert.equal(result.rows, undefined, 'an async run has read nothing yet');
  assert.ok(
    arr(result.notes).some((n) => str(n).includes('facebook_ads_report_status')),
    'the result must name the tool that finishes the job',
  );
});

test('force_async skips the sync attempt entirely', async () => {
  const { fb, ctx } = makeHarness();
  fb.on((r) => r.method === 'POST', fbOk({ report_run_id: REPORT_RUN_ID }));

  const result = body(
    await tool('facebook_ads_insights').handler({ force_async: true }, ctx),
  );

  assert.equal(result.mode, 'async');
  assert.equal(fb.calls.length, 1, 'exactly one call: the report-run POST');
  assert.equal(fb.calls[0]?.method, 'POST');
});

// ---------------------------------------------------------------------------
// 5. Report-run status (CC-ADS-5)
// ---------------------------------------------------------------------------

test('a running report is reported with advice and without fetching rows', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(
    () => true,
    fbOk({
      async_status: 'Job Running',
      async_percent_completion: 42,
      time_ref: Math.floor(NOW_MS / 1000) - 60,
    }),
  );

  const result = body(
    await tool('facebook_ads_report_status').handler(
      { report_run_id: REPORT_RUN_ID },
      ctx,
    ),
  );

  assert.equal(result.phase, 'running');
  assert.equal(result.terminal, false);
  assert.equal(result.resultsReady, false);
  assert.equal(result.stalled, false);
  assert.ok(str(result.advice).length > 0);
  assert.equal(fb.calls.length, 1);
});

test('fetch_results on an unfinished run reads nothing and says why', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(() => true, fbOk({ async_status: 'Job Started', time_ref: NOW_MS / 1000 }));

  const result = body(
    await tool('facebook_ads_report_status').handler(
      { report_run_id: REPORT_RUN_ID, fetch_results: true },
      ctx,
    ),
  );

  assert.equal(result.rowsRead, false);
  assert.equal(result.rows, undefined);
  assert.ok(
    str(result.note).includes('empty page'),
    'an empty page must not be mistakable for "no data"',
  );
  assert.equal(fb.calls.length, 1, 'the results edge must not be touched');
});

test('fetch_results on a complete run reads the rows from the run edge', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(
    (r) => r.path === `/${REPORT_RUN_ID}`,
    fbOk({ async_status: 'Job Completed', async_percent_completion: 100 }),
  );
  fb.on(
    (r) => r.path === `/${REPORT_RUN_ID}/insights`,
    fbOk({ data: [{ impressions: '10' }, { impressions: '20' }] }),
  );

  const result = body(
    await tool('facebook_ads_report_status').handler(
      { report_run_id: REPORT_RUN_ID, fetch_results: true, max_rows: 5 },
      ctx,
    ),
  );

  assert.equal(result.phase, 'complete');
  assert.equal(result.rowsRead, true);
  assert.equal(result.rowCount, 2);
  assert.equal(fb.calls.length, 2);
});

test('fetch_results forwards limit and after to the run edge', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(
    (r) => r.path === `/${REPORT_RUN_ID}`,
    fbOk({ async_status: 'Job Completed', async_percent_completion: 100 }),
  );
  fb.on(
    (r) => r.path === `/${REPORT_RUN_ID}/insights`,
    fbOk({ data: [{ impressions: '30' }] }),
  );

  await tool('facebook_ads_report_status').handler(
    { report_run_id: REPORT_RUN_ID, fetch_results: true, limit: 7, after: 'CURSOR_2' },
    ctx,
  );

  const rowsRead = fb.calls.find((r) => r.path === `/${REPORT_RUN_ID}/insights`);
  assert.ok(rowsRead && isJson(rowsRead));
  const params = obj(rowsRead.params);
  assert.equal(String(params.limit), '7');
  assert.equal(params.after, 'CURSOR_2');
});

test("a failed run returns Meta's redacted reason, code and subcode", async () => {
  const { fb, ctx } = makeHarness();
  const secret = 'EAAB-LEAKED-TOKEN-9876543210';
  const redactingCtx = { ...ctx, redactor: createFakeRedactor({ secrets: [secret] }) };
  fb.on(
    () => true,
    fbOk({
      async_status: 'Job Failed',
      error_code: 2,
      error_subcode: 1504044,
      error_message: `Service temporarily unavailable for ${secret}`,
    }),
  );

  const result = body(
    await tool('facebook_ads_report_status').handler(
      { report_run_id: REPORT_RUN_ID },
      redactingCtx,
    ),
  );

  assert.equal(result.phase, 'failed');
  assert.ok(str(result.advice).length > 0, 'the existing advice is still there');
  const failure = obj(result.failure);
  assert.equal(failure.code, 2);
  assert.equal(failure.subcode, 1504044);
  assert.ok(str(failure.reason).startsWith('Service temporarily unavailable'));
  assert.ok(
    !JSON.stringify(result).includes(secret),
    'the secret never reaches the model',
  );
  assert.ok(str(failure.reason).includes('[REDACTED]'));
});

test('a stalled run is flagged as stalled rather than reported as progressing', async () => {
  const { ctx, fb } = makeHarness();
  fb.on(
    () => true,
    fbOk({
      async_status: 'Job Running',
      // Started 30 minutes ago — past the 15-minute stall threshold.
      time_ref: Math.floor(NOW_MS / 1000) - 30 * 60,
    }),
  );

  const result = body(
    await tool('facebook_ads_report_status').handler(
      { report_run_id: REPORT_RUN_ID },
      ctx,
    ),
  );

  assert.equal(result.stalled, true);
  assert.ok(str(result.advice).includes('Stop polling'));
});
