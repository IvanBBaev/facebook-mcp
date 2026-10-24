// Tests for facebook_get_page_report (v2 insights F2) at the tool boundary: the
// schema defaults, the window validation that runs before the Page is resolved,
// the result envelope and the token / paging hygiene of the serialized output.
// The report's derivations are covered in `../api/page-report.test.ts`.
// Every Graph call is served by `createFakeFbRequest`. Placeholder tokens only.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFakeClock,
  createFakeFbRequest,
  createFakePageResolver,
  createFakeRedactor,
  createMemoryJournal,
  fbOk,
  type FakeFbRequest,
  type FakePageResolver,
} from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import type {
  FbRequest,
  Logger,
  Settings,
  ToolContext,
  ToolResult,
  ToolSpec,
} from '../core/index.js';
import { INSIGHTS_CONTRACT_VERSION } from '../api/insights.js';
import { REACH_METRIC } from '../api/page-report.js';
import { createInsightsPackage } from './insights.js';

const PAGE_ID = '111222333';
const PAGE_TOKEN = 'EAA-PAGE-TOKEN-0123456789';
/** 2026-10-24 05:00 Pacific. */
const NOW = Date.parse('2026-10-24T12:00:00Z');

function makeSettings(): Settings {
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
  };
}

function makeLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function makeCtx(): { fb: FakeFbRequest; pages: FakePageResolver; ctx: ToolContext } {
  const fb = createFakeFbRequest();
  const pages = createFakePageResolver({
    default: { pageId: PAGE_ID, name: 'Default', token: PAGE_TOKEN },
  });
  const clock = createFakeClock(NOW);
  const ctx: ToolContext = {
    settings: makeSettings(),
    fbRequest: fb.fn,
    pages,
    logger: makeLogger(),
    // A pass-through redactor: the token assertions below are not satisfied
    // vacuously by a `[REDACTED]` substitution.
    redactor: createFakeRedactor(),
    clock,
    journal: createMemoryJournal(clock),
  };
  return { fb, pages, ctx };
}

function tool(): ToolSpec {
  const spec = createInsightsPackage().tools.find(
    (t) => t.name === 'facebook_get_page_report',
  );
  assert.ok(spec, 'expected facebook_get_page_report in the insights package');
  return spec;
}

function body(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '') as Record<string, unknown>;
}

function param(req: FbRequest, key: string): unknown {
  return req.protocol === 'json' ? req.params?.[key] : undefined;
}

const isPageInsights = (req: FbRequest): boolean => req.path === `/${PAGE_ID}/insights`;

function series(
  name: string,
  period: string,
  points: readonly [string, number][],
): unknown {
  return {
    name,
    period,
    id: `/${PAGE_ID}/insights/${name}/${period}`,
    values: points.map(([date, value]) => ({ value, end_time: `${date}T07:00:00+0000` })),
  };
}

function withPaging(data: unknown, path: string): unknown {
  return {
    ...(data as Record<string, unknown>),
    paging: {
      cursors: { after: 'CURSOR' },
      next: `https://graph.facebook.com/v26.0${path}?after=CURSOR&access_token=${PAGE_TOKEN}`,
    },
  };
}

function serveHappy(fb: FakeFbRequest): void {
  fb.on(
    (req) => isPageInsights(req) && param(req, 'period') === 'day',
    fbOk(
      withPaging(
        {
          data: [
            series('page_follows', 'day', [
              ['2026-10-22', 100],
              ['2026-10-23', 104],
            ]),
            series('page_daily_follows', 'day', [['2026-10-23', 5]]),
            series('page_daily_unfollows', 'day', [['2026-10-23', 1]]),
            series('page_media_view', 'day', [['2026-10-23', 900]]),
            series('page_post_engagements', 'day', [['2026-10-23', 40]]),
            series('page_views_total', 'day', [['2026-10-23', 12]]),
          ],
        },
        `/${PAGE_ID}/insights`,
      ),
    ),
  );
  fb.on(
    isPageInsights,
    fbOk({ data: [series(REACH_METRIC, 'days_28', [['2026-10-24', 640]])] }),
  );
  fb.on(
    (req) => req.path === `/${PAGE_ID}/published_posts`,
    fbOk(
      withPaging(
        {
          data: [
            {
              id: `${PAGE_ID}_1`,
              created_time: '2026-10-20T09:00:00+0000',
              message: 'Hello',
              shares: { count: 2 },
              comments: { data: [], summary: { total_count: 3 } },
              reactions: { data: [], summary: { total_count: 10 } },
            },
            {
              id: `${PAGE_ID}_0`,
              created_time: '2026-08-01T09:00:00+0000',
              shares: { count: 0 },
            },
          ],
        },
        `/${PAGE_ID}/published_posts`,
      ),
    ),
  );
  fb.on(
    (req) => req.path === `/${PAGE_ID}_1/insights`,
    fbOk({
      data: [{ name: 'post_media_view', period: 'lifetime', values: [{ value: 77 }] }],
    }),
  );
}

test('get_page_report: defaults to last_28_days with comparison and top posts', async () => {
  const { fb, ctx } = makeCtx();
  serveHappy(fb);
  const parsed = body(await tool().handler({}, ctx));

  assert.equal(parsed.profile, null);
  assert.equal(parsed.pageId, PAGE_ID);
  assert.equal(parsed.contractVersion, INSIGHTS_CONTRACT_VERSION);
  const window = parsed.window as Record<string, unknown>;
  assert.equal(window.since, '2026-09-26');
  assert.equal(window.until, '2026-10-24');
  assert.deepEqual(parsed.previousWindow, {
    since: '2026-08-29',
    until: '2026-09-26',
    days: 28,
  });
  const reach = parsed.reach as Record<string, unknown>;
  assert.equal(reach.value, 640);
  assert.equal(reach.method, 'rolling_window');
  const top = parsed.topPosts as { rankedBy: string; items: { postId: string }[] };
  assert.equal(top.rankedBy, 'engagement');
  assert.deepEqual(
    top.items.map((p) => p.postId),
    [`${PAGE_ID}_1`],
  );
  assert.equal(parsed.eligible, true);
  assert.ok(fb.calls.length <= 18);
  for (const req of fb.calls) {
    assert.equal(req.token, PAGE_TOKEN, `${req.path} carries the Page token`);
  }
});

test('get_page_report: the output never carries paging, access_token or the token', async () => {
  const { fb, ctx } = makeCtx();
  serveHappy(fb);
  const text = (await tool().handler({}, ctx)).content[0]?.text ?? '';
  assert.ok(!text.includes('paging'));
  assert.ok(!text.includes('access_token'));
  assert.ok(!text.includes(PAGE_TOKEN));
});

test('get_page_report: top_posts 0 and compare false skip those reads', async () => {
  const { fb, ctx } = makeCtx();
  serveHappy(fb);
  const parsed = body(
    await tool().handler({ window: 'last_7_days', compare: false, top_posts: 0 }, ctx),
  );
  assert.equal(parsed.topPosts, undefined);
  assert.equal(parsed.previousWindow, undefined);
  assert.ok(!fb.calls.some((req) => req.path.endsWith('/published_posts')));
  // One day read + one rolling reach read.
  assert.equal(fb.calls.length, 2);
});

test('get_page_report: a bad window is rejected before the Page is resolved', async () => {
  const cases: Record<string, unknown>[] = [
    { window: 'custom', since: '2026-10-01' },
    { window: 'last_7_days', since: '2026-10-01', until: '2026-10-08' },
    { window: 'custom', since: '2026-06-01', until: '2026-10-01' },
  ];
  for (const input of cases) {
    const { fb, pages, ctx } = makeCtx();
    const spec = tool();
    await assert.rejects(
      spec.handler(spec.inputSchema.parse(input), ctx),
      (err: unknown) => err instanceof GraphApiError && err.code === 100,
      JSON.stringify(input),
    );
    assert.equal(pages.resolveCalls.length, 0);
    assert.equal(fb.calls.length, 0);
  }
});

test('get_page_report: the schema bounds top_posts and validates date shape', () => {
  const schema = tool().inputSchema;
  assert.equal(schema.safeParse({ top_posts: 11 }).success, false);
  assert.equal(schema.safeParse({ top_posts: -1 }).success, false);
  assert.equal(
    schema.safeParse({ window: 'custom', since: '2026/10/01' }).success,
    false,
  );
  const parsed = schema.parse({}) as Record<string, unknown>;
  assert.equal(parsed.window, 'last_28_days');
  assert.equal(parsed.compare, true);
  assert.equal(parsed.top_posts, 5);
  assert.equal(parsed.top_by, 'engagement');
});
