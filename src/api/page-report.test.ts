// Tests for the Page report (v2 insights F2): the pure window / delta / reach /
// ranking helpers and `buildPageReport` against a routed fake Graph — the
// failure isolation per section, the published_posts stop condition and the
// never-summed reach. Placeholder tokens only.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFakeFbRequest,
  fbErr,
  fbOk,
  type FakeFbRequest,
} from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import type { FbRequest, FbRequestFn, JsonRequest } from '../core/index.js';
import { PAGE_ELIGIBILITY_NOTE } from './insights.js';
import {
  REACH_METRIC,
  SCAN_TRUNCATED_NOTE,
  TOP_POSTS_NOTE,
  buildPageReport,
  deltaOf,
  previousWindow,
  rankPosts,
  reachPeriodFor,
  resolveReportWindow,
  type PageReport,
  type PageReportOptions,
  type TopPost,
} from './page-report.js';

const PAGE_ID = '1234567890';
const PAGE_TOKEN = 'EAA-PAGE-TOKEN-PLACEHOLDER';
/** 2026-10-24 05:00 Pacific — today in PT is 2026-10-24. */
const NOW = Date.parse('2026-10-24T12:00:00Z');

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('resolveReportWindow: presets end at today in Pacific Time (exclusive)', () => {
  const w = resolveReportWindow({ window: 'last_28_days', nowMs: NOW });
  assert.equal(w.since, '2026-09-26');
  assert.equal(w.until, '2026-10-24');
  assert.equal(w.days, 28);
  assert.equal(w.boundary, '[since, until)');
  assert.equal(w.timezone, 'America/Los_Angeles');

  assert.equal(
    resolveReportWindow({ window: 'last_7_days', nowMs: NOW }).since,
    '2026-10-17',
  );
  assert.equal(resolveReportWindow({ window: 'last_90_days', nowMs: NOW }).days, 90);
});

test('resolveReportWindow: 2026-10-24T05:00Z is still 2026-10-23 in Pacific Time', () => {
  const w = resolveReportWindow({
    window: 'last_7_days',
    nowMs: Date.parse('2026-10-24T05:00:00Z'),
  });
  assert.equal(w.until, '2026-10-23');
  assert.equal(w.since, '2026-10-16');
});

test('resolveReportWindow: custom needs both dates, presets accept neither', () => {
  const custom = resolveReportWindow({
    window: 'custom',
    since: '2026-10-01',
    until: '2026-10-11',
    nowMs: NOW,
  });
  assert.equal(custom.days, 10);

  const isValidation = (err: unknown): boolean =>
    err instanceof GraphApiError && err.code === 100;
  assert.throws(
    () => resolveReportWindow({ window: 'custom', since: '2026-10-01', nowMs: NOW }),
    isValidation,
  );
  assert.throws(
    () => resolveReportWindow({ window: 'last_7_days', since: '2026-10-01', nowMs: NOW }),
    isValidation,
  );
  assert.throws(
    () =>
      resolveReportWindow({
        window: 'custom',
        since: '2026-06-01',
        until: '2026-10-01',
        nowMs: NOW,
      }),
    isValidation,
    'a span over 90 days is rejected',
  );
});

test('previousWindow is the equal-length window ending at since', () => {
  const prev = previousWindow(
    resolveReportWindow({ window: 'last_28_days', nowMs: NOW }),
  );
  assert.equal(prev?.since, '2026-08-29');
  assert.equal(prev?.until, '2026-09-26');
  assert.equal(prev?.days, 28);
});

test('deltaOf: one-decimal pct, null pct over a zero previous, negative changes', () => {
  assert.deepEqual(deltaOf(22, 14), { abs: 8, pct: 57.1 });
  assert.deepEqual(deltaOf(612, 700), { abs: -88, pct: -12.6 });
  assert.deepEqual(deltaOf(5, 0), { abs: 5, pct: null });
  assert.deepEqual(deltaOf(0, 0), { abs: 0, pct: null });
  assert.deepEqual(deltaOf(-2, -4), { abs: 2, pct: 50 });
});

test('reachPeriodFor maps only exact rolling spans', () => {
  assert.equal(reachPeriodFor(7), 'week');
  assert.equal(reachPeriodFor(28), 'days_28');
  assert.equal(reachPeriodFor(30), undefined);
  assert.equal(reachPeriodFor(90), undefined);
});

test('rankPosts breaks ties by createdTime desc, then postId', () => {
  const post = (postId: string, createdTime: string, engagement: number): TopPost => ({
    postId,
    createdTime,
    reactions: engagement,
    comments: 0,
    shares: 0,
    engagement,
  });
  const ranked = rankPosts(
    [
      post('1_3', '2026-10-01T00:00:00+0000', 5),
      post('1_2', '2026-10-02T00:00:00+0000', 5),
      post('1_1', '2026-10-02T00:00:00+0000', 5),
      post('1_9', '2026-09-30T00:00:00+0000', 9),
    ],
    'engagement',
  );
  assert.deepEqual(
    ranked.map((p) => p.postId),
    ['1_9', '1_1', '1_2', '1_3'],
  );
});

// ---------------------------------------------------------------------------
// Routed fake Graph
// ---------------------------------------------------------------------------

function end(date: string): string {
  return `${date}T07:00:00+0000`;
}

function series(
  name: string,
  period: string,
  points: readonly [string, number][],
): unknown {
  return {
    name,
    period,
    title: name,
    id: `/${PAGE_ID}/insights/${name}/${period}`,
    values: points.map(([date, value]) => ({ value, end_time: end(date) })),
  };
}

function insightsBody(...entries: unknown[]): unknown {
  return {
    data: entries,
    paging: {
      next: `https://graph.facebook.com/v26.0/${PAGE_ID}/insights?after=X&access_token=${PAGE_TOKEN}`,
    },
  };
}

interface DayValues {
  readonly followsStart: number;
  readonly followsEnd: number;
  readonly follows: number;
  readonly unfollows: number;
  readonly views: number;
  readonly engagement: number;
  readonly pageViews: number;
}

/** A two-point daily series per metric; flows split their sum over the two days. */
function dayBody(d1: string, d2: string, v: DayValues): unknown {
  const flow = (name: string, total: number): unknown =>
    series(name, 'day', [
      [d1, Math.floor(total / 2)],
      [d2, total - Math.floor(total / 2)],
    ]);
  return insightsBody(
    series('page_follows', 'day', [
      [d1, v.followsStart],
      [d2, v.followsEnd],
    ]),
    flow('page_daily_follows', v.follows),
    flow('page_daily_unfollows', v.unfollows),
    flow('page_daily_unfollows_unique', v.unfollows),
    flow('page_media_view', v.views),
    flow('page_post_engagements', v.engagement),
    flow('page_views_total', v.pageViews),
  );
}

const CURRENT: DayValues = {
  followsStart: 860,
  followsEnd: 882,
  follows: 31,
  unfollows: 9,
  views: 9840,
  engagement: 612,
  pageViews: 140,
};
const PREVIOUS: DayValues = {
  followsStart: 846,
  followsEnd: 860,
  follows: 20,
  unfollows: 6,
  views: 8800,
  engagement: 700,
  pageViews: 120,
};

function json(req: FbRequest): JsonRequest | undefined {
  return req.protocol === 'json' ? req : undefined;
}

function param(req: FbRequest, key: string): unknown {
  return json(req)?.params?.[key];
}

const isPageInsights = (req: FbRequest): boolean =>
  json(req)?.path === `/${PAGE_ID}/insights`;
const isDay = (since: string) => (req: FbRequest) =>
  isPageInsights(req) && param(req, 'period') === 'day' && param(req, 'since') === since;
const isReach = (until: string) => (req: FbRequest) =>
  isPageInsights(req) && param(req, 'period') !== 'day' && param(req, 'until') === until;
const isPosts = (req: FbRequest): boolean =>
  json(req)?.path === `/${PAGE_ID}/published_posts`;
const isPostInsights = (postId: string) => (req: FbRequest) =>
  json(req)?.path === `/${postId}/insights`;

interface RawPost {
  readonly id: string;
  readonly created_time: string;
  readonly message?: string;
  readonly reactions: number;
  readonly comments: number;
  readonly shares: number;
}

function rawPost(p: RawPost): unknown {
  return {
    id: p.id,
    created_time: p.created_time,
    ...(p.message !== undefined ? { message: p.message } : {}),
    permalink_url: `https://www.facebook.com/${p.id}`,
    shares: { count: p.shares },
    comments: { data: [], summary: { total_count: p.comments } },
    reactions: { data: [], summary: { total_count: p.reactions } },
  };
}

function postsPage(posts: readonly RawPost[], after?: string): unknown {
  return {
    data: posts.map(rawPost),
    ...(after !== undefined
      ? {
          paging: {
            cursors: { after },
            next: `https://graph.facebook.com/v26.0/${PAGE_ID}/published_posts?after=${after}&access_token=${PAGE_TOKEN}`,
          },
        }
      : {}),
  };
}

const POSTS: readonly RawPost[] = [
  {
    id: `${PAGE_ID}_111`,
    created_time: '2026-10-20T09:12:00+0000',
    message: 'x'.repeat(300),
    reactions: 140,
    comments: 22,
    shares: 9,
  },
  {
    id: `${PAGE_ID}_112`,
    created_time: '2026-10-10T09:12:00+0000',
    message: 'Short post',
    reactions: 10,
    comments: 2,
    shares: 1,
  },
  {
    id: `${PAGE_ID}_113`,
    // 2026-09-26T05:00Z is still 2026-09-25 in Pacific Time: outside the window.
    created_time: '2026-09-26T05:00:00+0000',
    reactions: 999,
    comments: 0,
    shares: 0,
  },
];

function postInsightsBody(postId: string): unknown {
  return {
    data: [
      {
        name: 'post_media_view',
        period: 'lifetime',
        values: [{ value: 3100 }],
        id: postId,
      },
      {
        name: 'post_total_media_view_unique',
        period: 'lifetime',
        values: [{ value: 2400 }],
        id: postId,
      },
      { name: 'post_clicks', period: 'lifetime', values: [{ value: 85 }], id: postId },
    ],
  };
}

function happyGraph(): FakeFbRequest {
  const fb = createFakeFbRequest();
  fb.on(isDay('2026-09-26'), fbOk(dayBody('2026-10-22', '2026-10-23', CURRENT)));
  fb.on(isDay('2026-08-29'), fbOk(dayBody('2026-09-24', '2026-09-25', PREVIOUS)));
  fb.on(
    isReach('2026-10-24'),
    fbOk(insightsBody(series(REACH_METRIC, 'days_28', [['2026-10-24', 5120]]))),
  );
  fb.on(
    isReach('2026-09-26'),
    fbOk(insightsBody(series(REACH_METRIC, 'days_28', [['2026-09-26', 4410]]))),
  );
  fb.on(isPosts, fbOk(postsPage(POSTS, 'NEXT')));
  for (const p of POSTS) fb.on(isPostInsights(p.id), fbOk(postInsightsBody(p.id)));
  return fb;
}

function options(overrides: Partial<PageReportOptions> = {}): PageReportOptions {
  return {
    pageId: PAGE_ID,
    token: PAGE_TOKEN,
    window: resolveReportWindow({ window: 'last_28_days', nowMs: NOW }),
    compare: true,
    topPosts: 5,
    topBy: 'engagement',
    nowMs: NOW,
    ...overrides,
  };
}

function graphError(code: number): GraphApiError {
  return new GraphApiError(`(#${String(code)}) failure`, { code, httpStatus: 400 });
}

function items(report: PageReport): readonly TopPost[] {
  const top = report.topPosts;
  assert.ok(top !== undefined && 'items' in top, 'expected a top-posts listing');
  return top.items;
}

// ---------------------------------------------------------------------------
// buildPageReport
// ---------------------------------------------------------------------------

test('buildPageReport: happy path with comparison, reach and top posts', async () => {
  const fb = happyGraph();
  const report = await buildPageReport(fb.fn, options());

  assert.deepEqual(report.previousWindow, {
    since: '2026-08-29',
    until: '2026-09-26',
    days: 28,
  });

  const f = report.followers;
  assert.equal(f?.start, 860);
  assert.equal(f?.end, 882);
  assert.equal(f?.stockChange, 22);
  assert.equal(f?.netFlow, 22);
  assert.equal(f?.consistent, true);
  assert.deepEqual(f?.previous, { stockChange: 14, netFlow: 14 });
  assert.deepEqual(f?.delta, { abs: 8, pct: 57.1 });

  assert.equal(report.reach.method, 'rolling_window');
  assert.equal(report.reach.period, 'days_28');
  assert.equal(report.reach.value, 5120);
  assert.equal(report.reach.previous, 4410);
  assert.deepEqual(report.reach.delta, { abs: 710, pct: 16.1 });

  assert.deepEqual(report.views, {
    value: 9840,
    method: 'sum',
    metric: 'page_media_view',
    previous: 8800,
    delta: { abs: 1040, pct: 11.8 },
  });
  assert.deepEqual(report.engagement?.delta, { abs: -88, pct: -12.6 });
  assert.equal(report.pageViews?.value, 140);

  const top = items(report);
  assert.deepEqual(
    top.map((p) => p.postId),
    [`${PAGE_ID}_111`, `${PAGE_ID}_112`],
    'the post dated 2026-09-25 PT is outside the window',
  );
  assert.equal(top[0]?.engagement, 171);
  assert.equal(top[0]?.excerpt?.length, 120);
  assert.deepEqual(top[0]?.insights, {
    post_media_view: 3100,
    post_total_media_view_unique: 2400,
    post_clicks: 85,
  });
  assert.equal(report.eligible, true);
  assert.ok(report.notes.includes(TOP_POSTS_NOTE));

  // 2 day reads + 2 reach reads + 1 posts page + 2 post insights.
  assert.equal(fb.calls.length, 7);
  assert.ok(fb.calls.length <= 18);
});

test('buildPageReport: reach is read as a rolling window, never a summed daily unique', async () => {
  const fb = happyGraph();
  await buildPageReport(fb.fn, options());
  const reachCalls = fb.calls.filter(
    (req) => isPageInsights(req) && String(param(req, 'metric')).includes(REACH_METRIC),
  );
  assert.equal(reachCalls.length, 2);
  for (const req of reachCalls) {
    assert.equal(param(req, 'period'), 'days_28');
    assert.equal(param(req, 'metric'), REACH_METRIC);
  }
  assert.equal(param(reachCalls[0] as FbRequest, 'since'), '2026-10-23');
  assert.equal(param(reachCalls[0] as FbRequest, 'until'), '2026-10-24');
  for (const req of fb.calls.filter(isDay('2026-09-26'))) {
    assert.ok(!String(param(req, 'metric')).includes(REACH_METRIC));
  }
});

test('buildPageReport: a span with no rolling period reports reach as unavailable', async () => {
  const fb = happyGraph();
  fb.on(isDay('2026-09-14'), fbOk(dayBody('2026-10-22', '2026-10-23', CURRENT)));
  fb.on(isDay('2026-08-05'), fbOk(dayBody('2026-09-12', '2026-09-13', PREVIOUS)));
  const report = await buildPageReport(
    fb.fn,
    options({
      window: resolveReportWindow({
        window: 'custom',
        since: '2026-09-14',
        until: '2026-10-24',
        nowMs: NOW,
      }),
    }),
  );
  assert.equal(report.reach.method, 'unavailable');
  assert.equal(report.reach.value, undefined);
  assert.match(report.reach.note ?? '', /no exact reach for a 40-day window/);
  assert.ok(!fb.calls.some((req) => param(req, 'metric') === REACH_METRIC));
});

test('buildPageReport: week reach for a 7-day window', async () => {
  const fb = createFakeFbRequest();
  fb.on(isDay('2026-10-17'), fbOk(dayBody('2026-10-22', '2026-10-23', CURRENT)));
  fb.on(
    isReach('2026-10-24'),
    fbOk(insightsBody(series(REACH_METRIC, 'week', [['2026-10-24', 700]]))),
  );
  fb.on(isPosts, fbOk(postsPage([])));
  const report = await buildPageReport(
    fb.fn,
    options({
      compare: false,
      window: resolveReportWindow({ window: 'last_7_days', nowMs: NOW }),
    }),
  );
  assert.equal(report.reach.period, 'week');
  assert.equal(report.reach.value, 700);
  assert.equal(report.previousWindow, undefined);
  assert.equal(report.views?.previous, undefined);
});

test('buildPageReport: a failed current-window read fails the whole report', async () => {
  const fb = happyGraph();
  fb.reset();
  fb.on(isDay('2026-09-26'), fbErr(graphError(10)));
  await assert.rejects(buildPageReport(fb.fn, options()), (err: unknown) => {
    assert.ok(err instanceof GraphApiError);
    assert.equal(err.code, 10);
    return true;
  });
});

test('buildPageReport: a failed previous-window read drops only the comparison', async () => {
  const fb = createFakeFbRequest();
  fb.on(isDay('2026-08-29'), fbErr(graphError(200)));
  fb.on(isDay('2026-09-26'), fbOk(dayBody('2026-10-22', '2026-10-23', CURRENT)));
  fb.on(
    isReach('2026-10-24'),
    fbOk(insightsBody(series(REACH_METRIC, 'days_28', [['2026-10-24', 5120]]))),
  );
  fb.on(isPosts, fbOk(postsPage([])));
  const report = await buildPageReport(fb.fn, options());
  assert.ok(report.notes.includes('comparison unavailable: 200'));
  assert.equal(report.previousWindow, undefined);
  assert.equal(report.views?.value, 9840);
  assert.equal(report.views?.delta, undefined);
  assert.equal(report.followers?.delta, undefined);
  assert.equal(report.reach.value, 5120);
  assert.equal(report.reach.previous, undefined);
});

test('buildPageReport: a failed published_posts read isolates the top-posts section', async () => {
  const fb = createFakeFbRequest();
  fb.on(isPosts, fbErr(graphError(190)));
  for (const [match, result] of [
    [isDay('2026-09-26'), fbOk(dayBody('2026-10-22', '2026-10-23', CURRENT))],
    [isDay('2026-08-29'), fbOk(dayBody('2026-09-24', '2026-09-25', PREVIOUS))],
  ] as const) {
    fb.on(match, result);
  }
  fb.on(
    isPageInsights,
    fbOk(insightsBody(series(REACH_METRIC, 'days_28', [['2026-10-24', 1]]))),
  );
  const report = await buildPageReport(fb.fn, options());
  assert.deepEqual(report.topPosts, { error: { code: 190, message: '(#190) failure' } });
  assert.equal(report.views?.value, 9840);
});

test('buildPageReport: a failed post-insights read is reported per item', async () => {
  const happy = happyGraph();
  const failing = isPostInsights(`${PAGE_ID}_112`);
  const fn: FbRequestFn = (req) =>
    failing(req) ? Promise.reject(graphError(100)) : happy.fn(req);
  const report = await buildPageReport(fn, options());
  const top = items(report);
  assert.ok(top[0]?.insights !== undefined);
  assert.deepEqual(top[1]?.insightsError, { code: 100 });
  assert.equal(top[1]?.insights, undefined);
});

test('buildPageReport: all-empty insights mark the report ineligible, posts still render', async () => {
  const fb = createFakeFbRequest();
  const empty = insightsBody(
    ...[
      'page_follows',
      'page_daily_follows',
      'page_daily_unfollows',
      'page_daily_unfollows_unique',
      'page_media_view',
      'page_post_engagements',
      'page_views_total',
    ].map((name) => series(name, 'day', [])),
  );
  fb.on(isPosts, fbOk(postsPage(POSTS)));
  fb.on(
    (req) => isPageInsights(req) && param(req, 'period') !== 'day',
    fbOk(insightsBody(series(REACH_METRIC, 'days_28', []))),
  );
  fb.on(isPageInsights, fbOk(empty));
  fb.on(() => true, fbOk(postInsightsBody('x')));
  const report = await buildPageReport(fb.fn, options());
  assert.equal(report.eligible, false);
  assert.ok(report.notes.includes(PAGE_ELIGIBILITY_NOTE));
  assert.equal(report.reach.method, 'unavailable');
  assert.equal(report.views, undefined);
  assert.equal(items(report).length, 2);
});

function inWindow(n: number): RawPost {
  return {
    id: `${PAGE_ID}_${String(n)}`,
    created_time: '2026-10-15T12:00:00+0000',
    reactions: n,
    comments: 0,
    shares: 0,
  };
}

const postsAfter = (after: string | undefined) => (req: FbRequest) =>
  isPosts(req) && param(req, 'after') === after;

test('buildPageReport: the published_posts walk stops at since, not at the page budget', async () => {
  const fb = createFakeFbRequest();
  // Pages 1 and 2 lie entirely in the window; page 3 crosses since.
  fb.on(postsAfter(undefined), fbOk(postsPage([inWindow(1), inWindow(2)], 'P2')));
  fb.on(postsAfter('P2'), fbOk(postsPage([inWindow(3)], 'P3')));
  fb.on(postsAfter('P3'), fbOk(postsPage([inWindow(4), POSTS[2] as RawPost], 'P4')));
  fb.on(isPageInsights, fbOk(insightsBody()));
  fb.on(() => true, fbOk(postInsightsBody('x')));
  const report = await buildPageReport(fb.fn, options({ compare: false }));
  const top = report.topPosts;
  assert.ok(top !== undefined && 'items' in top);
  assert.equal(fb.calls.filter(isPosts).length, 3);
  assert.equal(top.scanned, 5);
  assert.equal(top.scanTruncated, false);
  assert.deepEqual(
    top.items.map((p) => p.postId),
    [4, 3, 2, 1].map((n) => `${PAGE_ID}_${String(n)}`),
  );
  assert.ok(!report.notes.includes(SCAN_TRUNCATED_NOTE));
});

test('buildPageReport: a scan that never reaches since is flagged truncated', async () => {
  const fb = createFakeFbRequest();
  const cursors = [undefined, 'C1', 'C2', 'C3'];
  cursors.forEach((after, i) => {
    fb.on(postsAfter(after), fbOk(postsPage([inWindow(i + 1)], `C${String(i + 1)}`)));
  });
  fb.on(isPageInsights, fbOk(insightsBody()));
  fb.on(() => true, fbOk(postInsightsBody('x')));
  const report = await buildPageReport(fb.fn, options({ compare: false }));
  const top = report.topPosts;
  assert.ok(top !== undefined && 'items' in top);
  assert.equal(fb.calls.filter(isPosts).length, 4);
  assert.equal(top.scanTruncated, true);
  assert.ok(report.notes.includes(SCAN_TRUNCATED_NOTE));
});

test('buildPageReport: top_posts 0 skips the post scan', async () => {
  const fb = happyGraph();
  const report = await buildPageReport(fb.fn, options({ topPosts: 0 }));
  assert.equal(report.topPosts, undefined);
  assert.ok(!fb.calls.some(isPosts));
});
