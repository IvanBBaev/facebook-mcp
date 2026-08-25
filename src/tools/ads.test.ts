// Tests for the `ads` tool package (tasks V09 read / V10 control): the six
// read-only tools, the plan-gated write tool, the ad-account resolution the
// whole package hangs off, the async report-run path (CC-ADS-5), the ceiling
// refusal (CC-ADS-7) and the package invariants doc 06 pins.
//
// Every Graph call is served by `createFakeFbRequest` — the network fence
// guarantees no real fetch escapes. Placeholder tokens only.
//
// The api-layer behaviour (minor-unit rewriting, effective-status explanations,
// the planner's tier arithmetic) is covered by `../api/ads-*.test.ts`; what is
// asserted here is the WIRING: which edge each tool hits, which arguments reach
// the api layer, that a dry run touches nothing, and that the tier the gate sees
// is the PLAN's tier rather than a constant.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFakeClock,
  createFakeFbRequest,
  createFakePageResolver,
  createFakeRedactor,
  createMemoryJournal,
  fbErr,
  fbOk,
  type FakeFbRequest,
  type MemoryJournal,
} from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import type {
  FbRequest,
  JsonRequest,
  Logger,
  Settings,
  ToolResult,
  ToolSpec,
} from '../core/index.js';
import { createWriteGate } from '../mcp/index.js';
import { createAdsPackage } from './ads.js';
import type { WriteToolContext } from './shared.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACCOUNT_ID = 'act_1234567890';
const BARE_ACCOUNT_ID = '1234567890';
const CAMPAIGN_ID = '23851234567890123';
const ADSET_ID = '23859876543210987';
const REPORT_RUN_ID = '6123456789012';

/** Fixed "now" — the run-age and stall verdicts must never read the wall clock. */
const NOW_MS = Date.parse('2026-08-07T09:00:00Z');

function makeLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    profiles: {},
    apiVersion: 'v23.0',
    hosts: {
      graph: 'graph.facebook.com',
      graphVideo: 'graph-video.facebook.com',
      rupload: 'rupload.facebook.com',
    },
    requestTimeoutMs: 30_000,
    hostConcurrency: 4,
    writeMode: 'plan',
    maxResultChars: 25_000,
    transport: 'stdio',
    packagesDeny: [],
    packagesReadonly: [],
    journalPath: '/tmp/journal.ndjson',
    logLevel: 'info',
    ...overrides,
  };
}

interface Harness {
  readonly fb: FakeFbRequest;
  readonly journal: MemoryJournal;
  readonly ctx: WriteToolContext;
}

/**
 * A tool context equipped exactly the way the server bootstrap equips one: a
 * real write gate over a fake clock and a memory journal. `writeMode` stays
 * `'plan'` — the package declares `writeModeDefault: 'plan'`, and every tier the
 * write tool can reach ignores the env default anyway.
 */
function makeHarness(settingsOverrides: Partial<Settings> = {}): Harness {
  const fb = createFakeFbRequest();
  const clock = createFakeClock(NOW_MS);
  const journal = createMemoryJournal(clock);
  let planSeq = 0;
  const ctx: WriteToolContext = {
    settings: makeSettings({ adAccountId: ACCOUNT_ID, ...settingsOverrides }),
    fbRequest: fb.fn,
    pages: createFakePageResolver({
      default: { pageId: '111222333', name: 'Default', token: 'EAA-PAGE-TOKEN-01234' },
    }),
    logger: makeLogger(),
    redactor: createFakeRedactor(),
    clock,
    journal,
    writeGate: createWriteGate({
      clock,
      journal,
      defaultWriteMode: 'plan',
      newPlanId: () => `plan-${String(++planSeq)}`,
    }),
  };
  return { fb, journal, ctx };
}

const PACKAGE = createAdsPackage();

/** Look a tool up in the built package by name (fails loudly if renamed). */
function tool(name: string): ToolSpec {
  const spec = PACKAGE.tools.find((t) => t.name === name);
  assert.ok(spec, `expected a tool named ${name}`);
  return spec;
}

function text(result: ToolResult): string {
  return result.content[0]?.text ?? '';
}

function body(result: ToolResult): Record<string, unknown> {
  return JSON.parse(text(result)) as Record<string, unknown>;
}

function obj(value: unknown): Record<string, unknown> {
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'expected an object',
  );
  return value as Record<string, unknown>;
}

function arr(value: unknown): readonly unknown[] {
  assert.ok(Array.isArray(value), 'expected an array');
  return value as readonly unknown[];
}

function str(value: unknown): string {
  assert.equal(typeof value, 'string', 'expected a string');
  return value as string;
}

function isJson(req: FbRequest): req is JsonRequest {
  return req.protocol === 'json';
}

function writes(fb: FakeFbRequest): readonly FbRequest[] {
  return fb.calls.filter((r) => r.method !== 'GET');
}

/** A campaign node as Graph sends it: budgets are decimal STRINGS of minor units. */
function campaignNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CAMPAIGN_ID,
    name: 'Summer sale',
    status: 'PAUSED',
    effective_status: 'PAUSED',
    daily_budget: '5000',
    ...overrides,
  };
}

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
    facebook_ads_insights: [true, false, true, true],
    facebook_ads_report_status: [true, false, true, true],
    facebook_update_ad_object: [false, true, true, true],
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

test('only facebook_update_ad_object can write, and it never claims to be read-only', () => {
  const writers = PACKAGE.tools.filter((t) => t.writeTier !== undefined);
  assert.deepEqual(
    writers.map((t) => t.name),
    ['facebook_update_ad_object'],
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

// ---------------------------------------------------------------------------
// 6. The write tool — dry runs (V10)
// ---------------------------------------------------------------------------

/** Serve the object read and the ad-account read a write does before planning. */
function stubWriteReads(
  fb: FakeFbRequest,
  opts: {
    readonly object?: Record<string, unknown>;
    readonly accountStatus?: number;
    readonly currency?: string;
  } = {},
): void {
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${ACCOUNT_ID}`,
    fbOk({
      id: ACCOUNT_ID,
      account_status: opts.accountStatus ?? 1,
      currency: opts.currency ?? 'EUR',
      name: 'Test account',
    }),
  );
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${CAMPAIGN_ID}`,
    fbOk(opts.object ?? campaignNode()),
  );
}

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
