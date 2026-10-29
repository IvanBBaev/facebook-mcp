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
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import {
  GraphApiError,
  ambiguousWriteAction,
  classifyNetworkError,
} from '../core/index.js';
import type {
  Confirmer,
  FbRequest,
  JsonRequest,
  Logger,
  Settings,
  ToolResult,
  ToolSpec,
} from '../core/index.js';
import { createWriteGate } from '../mcp/index.js';
import { planAdObjectUpdate } from '../api/ads-control.js';
import { createAdsPackage } from './ads.js';
import type { WriteToolContext } from './shared.js';

/**
 * The gate requires an out-of-band confirmation seam to exist. These suites never
 * reach a high-consequence apply, so they hand in one that always approves rather
 * than leaving the seam missing — which the gate now (correctly) refuses.
 */
const ALWAYS_CONFIRMS: Confirmer = {
  confirm: () => Promise.resolve({ confirmed: true, method: 'operator_token' }),
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACCOUNT_ID = 'act_1234567890';
const BARE_ACCOUNT_ID = '1234567890';
const OTHER_ACCOUNT_ID = 'act_9876543210';
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
    adsApiVersion: 'v26.0',
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
      confirmer: ALWAYS_CONFIRMS,
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
    facebook_boost_post: ['page_id', 'post_id', 'objective', 'apply', 'plan_id'],
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

// ---------------------------------------------------------------------------
// Campaign spend cap (v2 ads §4)
// ---------------------------------------------------------------------------

test('a spend cap raise is a spend write that applies spend_cap and journals it', async () => {
  const { fb, ctx, journal } = makeHarness({ adsCampaignSpendCapMax: 100_000 });
  stubWriteReads(fb, { object: campaignNode({ spend_cap: '40000' }), currency: 'USD' });
  fb.on((r) => r.method === 'POST', fbOk({ success: true }));

  const update = tool('facebook_update_ad_object');
  const args = { object_id: CAMPAIGN_ID, level: 'campaign', spend_cap_minor: 60_000 };
  const preview = body(await update.handler(args, ctx));
  assert.equal(preview.status, 'preview');
  assert.equal(preview.tier, 'spend');
  assert.ok(
    str(preview.summary).includes('spend_cap: 40000 minor units of USD -> 60000'),
  );
  assert.equal(writes(fb).length, 0);

  const applied = body(
    await update.handler({ ...args, apply: true, plan_id: str(preview.planId) }, ctx),
  );
  assert.equal(applied.status, 'applied');
  const post = writes(fb)[0];
  assert.ok(post && isJson(post));
  assert.deepEqual(post.body, { spend_cap: 60_000 });
  const metadata = obj(journal.entries.at(-1)?.metadata);
  assert.deepEqual(metadata.changedFields, ['spend_cap']);
  assert.equal(metadata.increasesSpend, true);
});

test('a first spend cap is irreversible and refused when FB_ADS_CAMPAIGN_SPEND_CAP_MAX is unset', async () => {
  const set = makeHarness({ adsCampaignSpendCapMax: 100_000 });
  stubWriteReads(set.fb);
  const preview = body(
    await tool('facebook_update_ad_object').handler(
      { object_id: CAMPAIGN_ID, level: 'campaign', spend_cap_minor: 50_000 },
      set.ctx,
    ),
  );
  assert.equal(preview.tier, 'irreversible');

  const unset = makeHarness();
  stubWriteReads(unset.fb);
  await assert.rejects(
    () =>
      tool('facebook_update_ad_object').handler(
        { object_id: CAMPAIGN_ID, level: 'campaign', spend_cap_minor: 50_000 },
        unset.ctx,
      ),
    /needs FB_ADS_CAMPAIGN_SPEND_CAP_MAX/,
  );
  assert.equal(writes(unset.fb).length, 0);
});

test('a spend cap below the account minimum is refused before the wire', async () => {
  const { fb, ctx } = makeHarness({ adsCampaignSpendCapMax: 100_000 });
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${ACCOUNT_ID}`,
    fbOk({
      id: ACCOUNT_ID,
      account_status: 1,
      currency: 'USD',
      min_campaign_group_spend_cap: '10000',
    }),
  );
  fb.on((r) => r.method === 'GET' && r.path === `/${CAMPAIGN_ID}`, fbOk(campaignNode()));
  await assert.rejects(
    () =>
      tool('facebook_update_ad_object').handler(
        { object_id: CAMPAIGN_ID, level: 'campaign', spend_cap_minor: 5_000 },
        ctx,
      ),
    /below Meta's minimum campaign spend cap/,
  );
  assert.equal(writes(fb).length, 0);
});

test('a spend cap change made elsewhere between preview and apply diverges', async () => {
  const { fb, ctx } = makeHarness({ adsCampaignSpendCapMax: 100_000 });
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${ACCOUNT_ID}`,
    fbOk({ id: ACCOUNT_ID, account_status: 1, currency: 'EUR' }),
  );
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${CAMPAIGN_ID}`,
    fbOk(campaignNode({ spend_cap: '40000' })),
    1,
  );
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${CAMPAIGN_ID}`,
    fbOk(campaignNode({ spend_cap: '45000' })),
  );
  fb.on((r) => r.method === 'POST', fbOk({ success: true }));

  const update = tool('facebook_update_ad_object');
  const args = { object_id: CAMPAIGN_ID, level: 'campaign', status: 'PAUSED' };
  const preview = body(await update.handler(args, ctx));
  const result = body(
    await update.handler({ ...args, apply: true, plan_id: str(preview.planId) }, ctx),
  );
  assert.equal(result.status, 'diverged');
  assert.equal(writes(fb).length, 0);
});

test('spend_cap_minor must be a positive integer', () => {
  const schema = tool('facebook_update_ad_object').inputSchema;
  for (const bad of [0, -1, 1.5]) {
    assert.equal(
      schema.safeParse({ object_id: CAMPAIGN_ID, spend_cap_minor: bad }).success,
      false,
      String(bad),
    );
  }
});

// ---------------------------------------------------------------------------
// Lifecycle tools (v2 ads §3) — archive / delete
// ---------------------------------------------------------------------------

/** Serve the child counts and the 28-day spend the lifecycle preview reads. */
function stubLifecycleReads(
  fb: FakeFbRequest,
  opts: { readonly adsets?: number; readonly ads?: number; readonly spend?: string } = {},
): void {
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${CAMPAIGN_ID}/adsets`,
    fbOk({ data: [], summary: { total_count: opts.adsets ?? 2 } }),
  );
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${CAMPAIGN_ID}/ads`,
    fbOk({ data: [], summary: { total_count: opts.ads ?? 5 } }),
  );
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${CAMPAIGN_ID}/insights`,
    fbOk({ data: opts.spend !== undefined ? [{ spend: opts.spend }] : [] }),
  );
}

test('archive and delete are irreversible previews that change nothing', async () => {
  for (const name of ['facebook_archive_ad_object', 'facebook_delete_ad_object']) {
    const { fb, ctx, journal } = makeHarness();
    stubWriteReads(fb);
    stubLifecycleReads(fb);

    const result = body(
      await tool(name).handler({ object_id: CAMPAIGN_ID, level: 'campaign' }, ctx),
    );

    assert.equal(result.status, 'preview', name);
    assert.equal(result.tier, 'irreversible', name);
    assert.match(str(result.summary), /children affected: 7/, name);
    assert.ok(
      arr(result.warnings).some((w) => str(w).includes('2 ad sets and 5 ads under it')),
      name,
    );
    assert.equal(writes(fb).length, 0, `${name}: a dry run may not write`);
    assert.equal(journal.entries.length, 0, name);
  }
});

test('an applied archive POSTs status=ARCHIVED and journals from/to/childCount', async () => {
  const { fb, ctx, journal } = makeHarness();
  stubWriteReads(fb);
  stubLifecycleReads(fb);
  fb.on((r) => r.method === 'POST', fbOk({ success: true }));

  const archive = tool('facebook_archive_ad_object');
  const args = { object_id: CAMPAIGN_ID, level: 'campaign' };
  const preview = body(await archive.handler(args, ctx));
  const applied = body(
    await archive.handler({ ...args, apply: true, plan_id: str(preview.planId) }, ctx),
  );

  assert.equal(applied.status, 'applied');
  const result = obj(applied.result);
  assert.equal(result.toStatus, 'ARCHIVED');
  assert.equal(result.fromStatus, 'PAUSED');
  assert.equal(result.childrenAffected, 7);
  const post = writes(fb)[0];
  assert.ok(post && isJson(post));
  assert.equal(post.method, 'POST');
  assert.deepEqual(post.body, { status: 'ARCHIVED' });
  const entry = journal.entries.at(-1);
  assert.equal(entry?.outcome, 'applied');
  assert.deepEqual(
    {
      from: entry?.metadata?.from,
      to: entry?.metadata?.to,
      childCount: entry?.metadata?.childCount,
    },
    { from: 'PAUSED', to: 'ARCHIVED', childCount: 7 },
  );
});

test('an applied campaign delete uses DELETE /{id}; an ad set uses status=DELETED', async () => {
  const campaign = makeHarness();
  stubWriteReads(campaign.fb);
  stubLifecycleReads(campaign.fb);
  campaign.fb.on((r) => r.method === 'DELETE', fbOk({ success: true }));
  const del = tool('facebook_delete_ad_object');
  const args = { object_id: CAMPAIGN_ID, level: 'campaign' };
  const preview = body(await del.handler(args, campaign.ctx));
  const applied = body(
    await del.handler(
      { ...args, apply: true, plan_id: str(preview.planId) },
      campaign.ctx,
    ),
  );
  assert.equal(applied.status, 'applied');
  const sent = writes(campaign.fb);
  assert.equal(sent.length, 1);
  const deleted = sent[0];
  assert.ok(deleted && isJson(deleted));
  assert.equal(deleted.method, 'DELETE');
  assert.equal(deleted.path, `/${CAMPAIGN_ID}`);

  const adset = makeHarness();
  stubWriteReads(adset.fb);
  adset.fb.on(
    (r) => r.method === 'GET' && r.path === `/${ADSET_ID}`,
    fbOk({ id: ADSET_ID, status: 'PAUSED', effective_status: 'PAUSED' }),
  );
  adset.fb.on(
    (r) => r.method === 'GET' && r.path === `/${ADSET_ID}/ads`,
    fbOk({ data: [], summary: { total_count: 3 } }),
  );
  adset.fb.on(
    (r) => r.method === 'GET' && r.path === `/${ADSET_ID}/insights`,
    fbOk({ data: [] }),
  );
  adset.fb.on((r) => r.method === 'POST', fbOk({ success: true }));
  const adsetArgs = { object_id: ADSET_ID, level: 'adset' };
  const adsetPreview = body(await del.handler(adsetArgs, adset.ctx));
  await del.handler(
    { ...adsetArgs, apply: true, plan_id: str(adsetPreview.planId) },
    adset.ctx,
  );
  const post = writes(adset.fb)[0];
  assert.ok(post && isJson(post));
  assert.equal(post.method, 'POST');
  assert.deepEqual(post.body, { status: 'DELETED' });
});

test('delete warns about recent delivery from 28-day spend', async () => {
  const { fb, ctx } = makeHarness();
  stubWriteReads(fb);
  stubLifecycleReads(fb, { spend: '12.50' });
  const result = body(
    await tool('facebook_delete_ad_object').handler(
      { object_id: CAMPAIGN_ID, level: 'campaign' },
      ctx,
    ),
  );
  assert.ok(
    arr(result.warnings).some((w) => str(w).includes('delivered in the last 28 days')),
  );
});

test('an at-risk ad account may still archive (it stops delivery)', async () => {
  const { fb, ctx } = makeHarness();
  stubWriteReads(fb, { accountStatus: 3 });
  stubLifecycleReads(fb);
  const result = body(
    await tool('facebook_archive_ad_object').handler(
      { object_id: CAMPAIGN_ID, level: 'campaign', ad_account_id: ACCOUNT_ID },
      ctx,
    ),
  );
  assert.equal(result.status, 'preview');
});

test('an already deleted object is refused before the wire', async () => {
  const { fb, ctx } = makeHarness();
  stubWriteReads(fb, {
    object: campaignNode({ status: 'DELETED', effective_status: 'DELETED' }),
  });
  stubLifecycleReads(fb);
  await assert.rejects(
    () =>
      tool('facebook_delete_ad_object').handler(
        { object_id: CAMPAIGN_ID, level: 'campaign' },
        ctx,
      ),
    /already deleted/,
  );
  assert.equal(writes(fb).length, 0);
});

test('a status change between archive preview and apply diverges', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${ACCOUNT_ID}`,
    fbOk({ id: ACCOUNT_ID, account_status: 1, currency: 'EUR' }),
  );
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${CAMPAIGN_ID}`,
    fbOk(campaignNode()),
    1,
  );
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${CAMPAIGN_ID}`,
    fbOk(campaignNode({ status: 'ACTIVE', effective_status: 'ACTIVE' })),
  );
  stubLifecycleReads(fb);
  fb.on((r) => r.method === 'POST', fbOk({ success: true }));

  const archive = tool('facebook_archive_ad_object');
  const args = { object_id: CAMPAIGN_ID, level: 'campaign' };
  const preview = body(await archive.handler(args, ctx));
  const result = body(
    await archive.handler({ ...args, apply: true, plan_id: str(preview.planId) }, ctx),
  );
  assert.equal(result.status, 'diverged');
  assert.equal(writes(fb).length, 0);
});

// ---------------------------------------------------------------------------
// Ad image upload (v2 ads §2)
// ---------------------------------------------------------------------------

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7,
]);

async function withAdMedia(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fbmcp-ads-')));
  try {
    await writeFile(join(dir, 'banner.png'), PNG_BYTES);
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const AD_IMAGE_RESPONSE = {
  images: {
    'banner.png': {
      hash: 'abc123hash',
      url: 'https://scontent.example/b.png',
      width: 10,
      height: 10,
      name: 'banner.png',
    },
  },
};

test('upload_ad_image previews the bound file and uploads nothing', async () => {
  await withAdMedia(async (dir) => {
    const { fb, ctx, journal } = makeHarness({ mediaDir: dir });
    stubWriteReads(fb);

    const result = body(
      await tool('facebook_upload_ad_image').handler({ file_path: 'banner.png' }, ctx),
    );

    assert.equal(result.status, 'preview');
    assert.equal(result.tier, 'reversible');
    assert.match(
      str(result.summary),
      /Upload banner\.png \(11 bytes, sha256 [0-9a-f]{12}\) to the image library of act_1234567890/,
    );
    assert.ok(
      arr(result.warnings).some((w) =>
        str(w).includes('does not create or change any ad'),
      ),
    );
    assert.ok(
      arr(result.warnings).some((w) => str(w).includes('re-running this upload is safe')),
    );
    assert.equal(writes(fb).length, 0);
    assert.equal(journal.entries.length, 0);
  });
});

test('an applied upload POSTs to adimages and journals account, hash and bytes', async () => {
  await withAdMedia(async (dir) => {
    const { fb, ctx, journal } = makeHarness({ mediaDir: dir });
    stubWriteReads(fb);
    fb.on((r) => r.method === 'POST', fbOk(AD_IMAGE_RESPONSE));
    const upload = tool('facebook_upload_ad_image');

    const preview = body(
      await upload.handler({ file_path: 'banner.png', name: 'Hero' }, ctx),
    );
    const applied = body(
      await upload.handler(
        {
          file_path: 'banner.png',
          name: 'Hero',
          apply: true,
          plan_id: str(preview.planId),
        },
        ctx,
      ),
    );

    assert.equal(applied.status, 'applied');
    assert.equal(obj(obj(applied.result).image).hash, 'abc123hash');
    const post = writes(fb)[0];
    assert.ok(post && post.protocol === 'multipart');
    assert.equal(post.path, `/${ACCOUNT_ID}/adimages`);
    assert.equal(post.files[0]?.filename, 'Hero');
    const entry = journal.entries.at(-1);
    assert.equal(entry?.outcome, 'applied');
    assert.deepEqual(entry?.metadata, {
      accountId: ACCOUNT_ID,
      bytes: 11,
      hash: 'abc123hash',
    });
  });
});

test('an upload answered without a hash is attempted, with the re-run note', async () => {
  await withAdMedia(async (dir) => {
    const { fb, ctx, journal } = makeHarness({ mediaDir: dir });
    stubWriteReads(fb);
    fb.on((r) => r.method === 'POST', fbOk({ images: {} }));
    const upload = tool('facebook_upload_ad_image');

    const preview = body(await upload.handler({ file_path: 'banner.png' }, ctx));
    const applied = body(
      await upload.handler(
        { file_path: 'banner.png', apply: true, plan_id: str(preview.planId) },
        ctx,
      ),
    );

    assert.equal(applied.status, 'not_applied');
    assert.equal(applied.outcome, 'attempted');
    assert.match(str(obj(applied.result).unconfirmed), /re-running this upload is safe/);
    assert.equal(journal.entries.at(-1)?.outcome, 'attempted');
  });
});

test('a file rewritten after the preview no longer matches the plan and is not uploaded', async () => {
  await withAdMedia(async (dir) => {
    const { fb, ctx } = makeHarness({ mediaDir: dir });
    stubWriteReads(fb);
    const upload = tool('facebook_upload_ad_image');

    const preview = body(await upload.handler({ file_path: 'banner.png' }, ctx));
    const changed = new Uint8Array(PNG_BYTES);
    changed[10] = 0;
    await writeFile(join(dir, 'banner.png'), changed);

    await assert.rejects(
      upload.handler(
        { file_path: 'banner.png', apply: true, plan_id: str(preview.planId) },
        ctx,
      ),
      /apply params differ from the planned params/,
    );
    assert.equal(writes(fb).length, 0);
  });
});

test('upload_ad_image refuses a non-image extension and a path outside FB_MEDIA_DIR', async () => {
  await withAdMedia(async (dir) => {
    await writeFile(join(dir, 'clip.mp4'), PNG_BYTES);
    const { fb, ctx } = makeHarness({ mediaDir: dir });
    stubWriteReads(fb);
    const upload = tool('facebook_upload_ad_image');

    await assert.rejects(
      upload.handler({ file_path: 'clip.mp4' }, ctx),
      /not an ad image format/,
    );
    await assert.rejects(upload.handler({ file_path: '../x.png' }, ctx));
    assert.equal(writes(fb).length, 0);
  });
});

// ---------------------------------------------------------------------------
// Ad-set targeting read and narrow edit (v2 ads §8)
// ---------------------------------------------------------------------------

/** A simple audience the narrow edit may touch. */
function simpleTargeting(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    age_min: 25,
    age_max: 54,
    geo_locations: { countries: ['US'], location_types: ['home'] },
    publisher_platforms: ['facebook'],
    targeting_automation: { advantage_audience: 0 },
    ...overrides,
  };
}

function adsetTargetingNode(
  targeting: Record<string, unknown>,
  accountId = BARE_ACCOUNT_ID,
): Record<string, unknown> {
  return { id: ADSET_ID, name: 'Lookalikes', account_id: accountId, targeting };
}

/** Serve the account read and the ad-set targeting read(s), in order. */
function stubTargetingReads(
  fb: FakeFbRequest,
  ...targetings: readonly Record<string, unknown>[]
): void {
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${ACCOUNT_ID}`,
    fbOk({ id: ACCOUNT_ID, account_status: 1, currency: 'EUR', name: 'Test account' }),
  );
  const isTargetingRead = (r: FbRequest): boolean =>
    r.method === 'GET' &&
    r.path === `/${ADSET_ID}` &&
    isJson(r) &&
    r.params?.fields === 'id,name,account_id,targeting';
  targetings.slice(0, -1).forEach((t) => {
    fb.on(isTargetingRead, fbOk(adsetTargetingNode(t)), 1);
  });
  fb.on(isTargetingRead, fbOk(adsetTargetingNode(targetings.at(-1) ?? {})));
}

test('get targeting returns the summary, the raw blob only on request', async () => {
  const { fb, ctx } = makeHarness();
  stubTargetingReads(fb, simpleTargeting());
  const get = tool('facebook_get_ad_set_targeting');

  const plain = body(
    await get.handler(get.inputSchema.parse({ adset_id: ADSET_ID }), ctx),
  );
  assert.equal(plain.adsetId, ADSET_ID);
  assert.equal(obj(plain.summary).editable_by_this_server, true);
  assert.deepEqual(obj(plain.summary).countries, ['US']);
  assert.equal(plain.targeting, undefined);
  assert.equal(typeof plain.raw_bytes, 'number');

  const raw = body(
    await get.handler(
      get.inputSchema.parse({ adset_id: ADSET_ID, include_raw: true }),
      ctx,
    ),
  );
  assert.deepEqual(raw.targeting, simpleTargeting());
});

test('get targeting says when Advantage+ audience is unset', async () => {
  const { fb, ctx } = makeHarness();
  stubTargetingReads(fb, simpleTargeting({ targeting_automation: undefined }));
  const get = tool('facebook_get_ad_set_targeting');

  const summary = obj(
    body(await get.handler(get.inputSchema.parse({ adset_id: ADSET_ID }), ctx)).summary,
  );
  assert.equal(summary.advantage_audience_state, 'unset');
  assert.equal(summary.advantage_audience, null);
});

test('get targeting refuses an ad set from another explicitly named account', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(
    (r) => r.method === 'GET',
    fbOk(adsetTargetingNode(simpleTargeting(), '9876543210')),
  );
  const get = tool('facebook_get_ad_set_targeting');
  await assert.rejects(
    () =>
      get.handler(
        get.inputSchema.parse({ adset_id: ADSET_ID, ad_account_id: ACCOUNT_ID }),
        ctx,
      ),
    new RegExp(`belongs to ad account ${OTHER_ACCOUNT_ID}`),
  );
});

test('a targeting edit previews before → after as a spend write and changes nothing', async () => {
  const { fb, ctx, journal } = makeHarness();
  stubTargetingReads(fb, simpleTargeting());
  const update = tool('facebook_update_ad_set_targeting');

  const preview = body(
    await update.handler(
      update.inputSchema.parse({
        adset_id: ADSET_ID,
        countries: ['us', 'ca'],
        age_max: 65,
      }),
      ctx,
    ),
  );
  assert.equal(preview.status, 'preview');
  assert.equal(preview.tier, 'spend');
  assert.match(str(preview.summary), /countries US → US, CA/);
  assert.match(str(preview.summary), /ages 25–54 → 25–65/);
  assert.ok(arr(preview.warnings).some((w) => /learning phase/.test(str(w))));
  assert.equal(writes(fb).length, 0);
  assert.equal(journal.entries.length, 0);
});

test('applying a targeting edit posts the whole blob with only the owned keys changed', async () => {
  const { fb, ctx, journal } = makeHarness();
  const current = simpleTargeting({ device_platforms: ['mobile'] });
  stubTargetingReads(fb, current);
  fb.on((r) => r.method === 'POST', fbOk({ success: true }));
  const update = tool('facebook_update_ad_set_targeting');
  const args = { adset_id: ADSET_ID, age_min: 30 };

  const preview = body(await update.handler(update.inputSchema.parse(args), ctx));
  const applied = body(
    await update.handler(
      update.inputSchema.parse({ ...args, apply: true, plan_id: str(preview.planId) }),
      ctx,
    ),
  );

  assert.equal(applied.status, 'applied');
  const [post] = writes(fb);
  assert.ok(post && isJson(post));
  assert.equal(post.path, `/${ADSET_ID}`);
  assert.deepEqual(post.body, { targeting: { ...current, age_min: 30 } });
  assert.deepEqual(obj(applied.result).after, {
    countries: ['US'],
    ageMin: 30,
    ageMax: 54,
  });
  const entry = journal.entries.at(-1);
  assert.equal(entry?.outcome, 'applied');
  assert.deepEqual(obj(entry?.metadata).changedFields, ['age_min']);
});

test('a targeting edit diverges when any key changed after the preview', async () => {
  const { fb, ctx } = makeHarness();
  stubTargetingReads(
    fb,
    simpleTargeting(),
    simpleTargeting({ publisher_platforms: ['facebook', 'instagram'] }),
  );
  fb.on((r) => r.method === 'POST', fbOk({ success: true }));
  const update = tool('facebook_update_ad_set_targeting');
  const args = { adset_id: ADSET_ID, age_min: 30 };

  const preview = body(await update.handler(update.inputSchema.parse(args), ctx));
  const result = body(
    await update.handler(
      update.inputSchema.parse({ ...args, apply: true, plan_id: str(preview.planId) }),
      ctx,
    ),
  );
  assert.equal(result.status, 'diverged');
  assert.equal(writes(fb).length, 0);
});

test('a complex audience is refused before any preview', async () => {
  const { fb, ctx } = makeHarness();
  stubTargetingReads(fb, simpleTargeting({ custom_audiences: [{ id: '1' }] }));
  const update = tool('facebook_update_ad_set_targeting');
  await assert.rejects(
    () =>
      update.handler(update.inputSchema.parse({ adset_id: ADSET_ID, age_min: 30 }), ctx),
    /more complex than this tool edits.*custom audiences/,
  );
  assert.equal(writes(fb).length, 0);
});

test('adding EU countries without DSA info is refused; with account defaults it previews', async () => {
  const update = tool('facebook_update_ad_set_targeting');
  const args: unknown = update.inputSchema.parse({
    adset_id: ADSET_ID,
    countries: ['US', 'DE'],
  });
  const isDsaRead = (r: FbRequest): boolean =>
    isJson(r) && /dsa/.test(String(r.params?.fields ?? ''));

  const missing = makeHarness();
  missing.fb.on(isDsaRead, fbOk({}));
  stubTargetingReads(missing.fb, simpleTargeting());
  await assert.rejects(() => update.handler(args, missing.ctx), /EU targeting \(DE\)/);
  assert.equal(writes(missing.fb).length, 0);

  const known = makeHarness();
  known.fb.on(
    (r) => isDsaRead(r) && r.path === `/${ACCOUNT_ID}`,
    fbOk({ default_dsa_payor: 'Acme', default_dsa_beneficiary: 'Acme' }),
  );
  known.fb.on(isDsaRead, fbOk({}));
  stubTargetingReads(known.fb, simpleTargeting());
  const preview = body(await update.handler(args, known.ctx));
  assert.equal(preview.status, 'preview');
});

test('a targeting edit with nothing to change is refused', async () => {
  const { fb, ctx } = makeHarness();
  stubTargetingReads(fb, simpleTargeting());
  const update = tool('facebook_update_ad_set_targeting');
  await assert.rejects(
    () => update.handler(update.inputSchema.parse({ adset_id: ADSET_ID }), ctx),
    /Nothing to change/,
  );
  await assert.rejects(
    () =>
      update.handler(update.inputSchema.parse({ adset_id: ADSET_ID, age_min: 25 }), ctx),
    /Nothing to change/,
  );
  assert.throws(() =>
    update.inputSchema.parse({ adset_id: ADSET_ID, countries: ['USA'] }),
  );
  assert.throws(() => update.inputSchema.parse({ adset_id: 'act_1', age_min: 30 }));
});

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
