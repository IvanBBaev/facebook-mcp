// Tests for the stable insights schema (task C05).
//
// Most tests drive the pure projection with hand-built reads; one block runs it
// on real `fetchInsights` results (fake Graph) to prove the input contract is
// the shape the api layer returns. Drift guards keep the stable map in step with
// the deprecation table and with the metric lists the insights code reads.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeFbRequest, fbErr, fbOk } from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';

import { classifyMetric, fetchInsights, type MetricSummary } from './insights.js';
import { DEFAULT_POSTS_INSIGHTS_METRICS } from './insights-batch.js';
import { REACH_METRIC, REPORT_DAY_METRICS, TOP_POST_METRICS } from './page-report.js';
import {
  INSIGHTS_SCHEMA_VERSION,
  STABLE_INSIGHTS_SCHEMA,
  stableKeyFor,
  stableMetric,
  stableMetricsFor,
  toStableInsights,
  type StableInsightEntry,
  type StableInsightsInput,
  type StableMetricLevel,
} from './insights-schema.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function summary(
  metric: string,
  points: number,
  value?: number,
  period = 'day',
): MetricSummary {
  return {
    metric,
    period,
    points,
    kind: 'flow',
    aggregation: value === undefined ? 'none' : 'sum',
    ...(value !== undefined ? { value } : {}),
  };
}

function read(overrides: Partial<StableInsightsInput> = {}): StableInsightsInput {
  return {
    queriedMetrics: [],
    metrics: [],
    deprecatedMetrics: [],
    emptyMetrics: [],
    ...overrides,
  };
}

function entry(
  entries: readonly StableInsightEntry[],
  key: string,
): StableInsightEntry | undefined {
  return entries.find((e) => e.key === key);
}

const LEVELS: readonly StableMetricLevel[] = ['page', 'post', 'reel'];

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

test('a source metric with data points is ok and carries the safe scalar', () => {
  const stable = toStableInsights(
    'page',
    read({
      queriedMetrics: ['page_media_view'],
      metrics: [summary('page_media_view', 7, 140)],
    }),
  );

  assert.equal(stable.schema_version, INSIGHTS_SCHEMA_VERSION);
  assert.equal(stable.level, 'page');
  assert.deepEqual(stable.entries, [
    {
      key: 'views',
      value: 140,
      source_metric: 'page_media_view',
      status: 'ok',
      period: 'day',
    },
  ]);
  assert.deepEqual(stable.unmapped, []);
});

test('ok with no safe roll-up keeps value null instead of guessing', () => {
  // A breakdown map or overlapping daily uniques: the reshape refused to roll up.
  const stable = toStableInsights(
    'post',
    read({
      queriedMetrics: ['post_reactions_by_type_total'],
      metrics: [summary('post_reactions_by_type_total', 3, undefined, 'lifetime')],
    }),
  );

  assert.deepEqual(entry(stable.entries, 'reactions'), {
    key: 'reactions',
    value: null,
    source_metric: 'post_reactions_by_type_total',
    status: 'ok',
    period: 'lifetime',
  });
});

test('a valid metric with no data points is empty, not removed', () => {
  const stable = toStableInsights(
    'page',
    read({
      queriedMetrics: ['page_daily_follows'],
      metrics: [summary('page_daily_follows', 0)],
      emptyMetrics: ['page_daily_follows'],
    }),
  );

  assert.deepEqual(stable.entries, [
    {
      key: 'follows',
      value: null,
      source_metric: 'page_daily_follows',
      status: 'empty',
      period: 'day',
    },
  ]);
});

test('a requested legacy name is removed (deprecated) under its stable key', () => {
  // `page_impressions` never reached Graph: the deprecation table dropped it.
  const stable = toStableInsights(
    'page',
    read({
      deprecatedMetrics: [
        { metric: 'page_impressions', status: 'renamed', replacement: 'page_media_view' },
      ],
    }),
  );

  assert.deepEqual(stable.entries, [
    {
      key: 'views',
      value: null,
      source_metric: 'page_impressions',
      status: 'removed',
      reason: 'deprecated',
    },
  ]);
  assert.deepEqual(stable.unmapped, []);
});

test('a legacy name removed with no replacement still lands on its key', () => {
  const stable = toStableInsights(
    'post',
    read({
      deprecatedMetrics: [{ metric: 'POST_VIDEO_VIEWS_UNIQUE', status: 'removed' }],
    }),
  );

  assert.deepEqual(entry(stable.entries, 'video_views'), {
    key: 'video_views',
    value: null,
    source_metric: 'post_video_views_unique',
    status: 'removed',
    reason: 'deprecated',
  });
});

test('the current source wins over a legacy name of the same key', () => {
  const stable = toStableInsights(
    'page',
    read({
      queriedMetrics: ['page_follows'],
      metrics: [summary('page_follows', 3, 882)],
      deprecatedMetrics: [
        { metric: 'page_fans', status: 'renamed', replacement: 'page_follows' },
      ],
    }),
  );

  assert.equal(stable.entries.length, 1);
  assert.equal(entry(stable.entries, 'followers')?.status, 'ok');
  assert.equal(entry(stable.entries, 'followers')?.source_metric, 'page_follows');
  assert.equal(entry(stable.entries, 'followers')?.value, 882);
});

test('a source metric Graph rejected by position is removed (rejected)', () => {
  const stable = toStableInsights(
    'page',
    read({
      queriedMetrics: ['page_daily_unfollows', 'page_media_view'],
      metrics: [summary('page_media_view', 2, 10)],
      rejectedMetrics: [{ metric: 'page_daily_unfollows', reason: 'Graph rejected it.' }],
    }),
  );

  assert.deepEqual(entry(stable.entries, 'unfollows'), {
    key: 'unfollows',
    value: null,
    source_metric: 'page_daily_unfollows',
    status: 'removed',
    reason: 'rejected',
  });
  assert.equal(entry(stable.entries, 'views')?.status, 'ok');
});

test('a source metric Graph omitted from its reply is removed (unavailable)', () => {
  // This is how a future Meta removal of a current source shows up: the key
  // stays, its status changes.
  const stable = toStableInsights(
    'page',
    read({
      queriedMetrics: ['page_media_view', 'page_views_total'],
      metrics: [summary('page_media_view', 2, 10)],
    }),
  );

  assert.deepEqual(entry(stable.entries, 'page_views'), {
    key: 'page_views',
    value: null,
    source_metric: 'page_views_total',
    status: 'removed',
    reason: 'unavailable',
  });
});

test('reason is present only for removed entries', () => {
  const stable = toStableInsights(
    'page',
    read({
      queriedMetrics: ['page_media_view', 'page_daily_follows', 'page_views_total'],
      metrics: [summary('page_media_view', 2, 10), summary('page_daily_follows', 0)],
      emptyMetrics: ['page_daily_follows'],
    }),
  );

  for (const e of stable.entries) {
    assert.equal(e.reason !== undefined, e.status === 'removed', e.key);
    if (e.status !== 'ok') assert.equal(e.value, null, e.key);
  }
});

// ---------------------------------------------------------------------------
// Passthrough policy, ordering, purity
// ---------------------------------------------------------------------------

test('unknown and other-level names are unmapped, never dropped or rejected', () => {
  const stable = toStableInsights(
    'page',
    read({
      queriedMetrics: ['page_media_view', 'page_brand_new_metric', 'post_clicks'],
      metrics: [
        summary('page_media_view', 1, 5),
        summary('page_brand_new_metric', 1, 9),
        summary('post_clicks', 1, 3),
      ],
      deprecatedMetrics: [{ metric: 'page_fans_city', status: 'removed' }],
    }),
  );

  assert.deepEqual(
    stable.entries.map((e) => e.key),
    ['views'],
  );
  assert.deepEqual(stable.unmapped, [
    'page_brand_new_metric',
    'post_clicks',
    'page_fans_city',
  ]);
});

test('names are matched case- and space-insensitively', () => {
  const stable = toStableInsights(
    'page',
    read({
      queriedMetrics: [' Page_Media_View '],
      metrics: [summary('PAGE_MEDIA_VIEW', 1, 4)],
    }),
  );

  assert.equal(entry(stable.entries, 'views')?.status, 'ok');
  assert.equal(entry(stable.entries, 'views')?.value, 4);
  assert.deepEqual(stable.unmapped, []);
});

test('entries follow table order, not request order', () => {
  const stable = toStableInsights(
    'page',
    read({
      queriedMetrics: ['page_views_total', 'page_follows', 'page_media_view'],
      metrics: [
        summary('page_views_total', 1, 1),
        summary('page_follows', 1, 2),
        summary('page_media_view', 1, 3),
      ],
    }),
  );

  assert.deepEqual(
    stable.entries.map((e) => e.key),
    ['views', 'followers', 'page_views'],
  );
});

test('a request that touches no stable key yields no entries', () => {
  const stable = toStableInsights('reel', read());

  assert.deepEqual(stable.entries, []);
  assert.deepEqual(stable.unmapped, []);
});

test('the projection leaves its input untouched', () => {
  const input = read({
    queriedMetrics: ['page_media_view', 'page_daily_follows'],
    metrics: [summary('page_media_view', 2, 10), summary('page_daily_follows', 0)],
    emptyMetrics: ['page_daily_follows'],
    deprecatedMetrics: [{ metric: 'page_fans', status: 'renamed' }],
  });
  const before = structuredClone(input);

  toStableInsights('page', input);

  assert.deepEqual(input, before);
});

// ---------------------------------------------------------------------------
// On real fetchInsights results
// ---------------------------------------------------------------------------

const PAGE_ID = '1234567890';
const NOW = Date.parse('2026-07-10T12:00:00Z');

function series(name: string, period: string, values: readonly number[]): unknown {
  return {
    name,
    period,
    values: values.map((value, index) => ({
      value,
      end_time: `2026-07-0${String(index + 2)}T07:00:00+0000`,
    })),
  };
}

test('fetchInsights output projects onto ok, empty, removed and unmapped', async () => {
  const fake = createFakeFbRequest();
  fake.on(
    () => true,
    fbOk({
      data: [
        series('page_media_view', 'day', [3, 4]),
        series('page_daily_follows', 'day', []),
        series('page_some_new_metric', 'day', [1]),
      ],
    }),
  );

  const result = await fetchInsights(fake.fn, {
    scope: 'page',
    objectId: PAGE_ID,
    metrics: [
      'page_media_view',
      'page_daily_follows',
      'page_views_total',
      'page_some_new_metric',
      'page_fans',
    ],
    since: '2026-07-01',
    until: '2026-07-04',
    nowMs: NOW,
  });
  const rawMetrics = structuredClone(result.metrics);

  const stable = toStableInsights('page', result);

  assert.deepEqual(stable.entries, [
    {
      key: 'views',
      value: 7,
      source_metric: 'page_media_view',
      status: 'ok',
      period: 'day',
    },
    {
      key: 'followers',
      value: null,
      source_metric: 'page_fans',
      status: 'removed',
      reason: 'deprecated',
    },
    {
      key: 'follows',
      value: null,
      source_metric: 'page_daily_follows',
      status: 'empty',
      period: 'day',
    },
    {
      key: 'page_views',
      value: null,
      source_metric: 'page_views_total',
      status: 'removed',
      reason: 'unavailable',
    },
  ]);
  assert.deepEqual(stable.unmapped, ['page_some_new_metric']);
  assert.deepEqual(result.metrics, rawMetrics, 'raw metrics are untouched');
});

test('fetchInsights positional rejection projects onto removed (rejected)', async () => {
  const fake = createFakeFbRequest();
  fake.enqueue(
    fbErr(
      new GraphApiError('(#100) metric[1] must be one of the following values', {
        code: 100,
        httpStatus: 400,
      }),
    ),
  );
  fake.on(() => true, fbOk({ data: [series('post_media_view', 'lifetime', [42])] }));

  const result = await fetchInsights(fake.fn, {
    scope: 'post',
    objectId: `${PAGE_ID}_987`,
    metrics: ['post_media_view', 'post_clicks'],
    nowMs: NOW,
  });

  assert.deepEqual(
    result.rejectedMetrics?.map((r) => r.metric),
    ['post_clicks'],
    'precondition: Graph rejected post_clicks by position',
  );
  const stable = toStableInsights('post', result);
  assert.deepEqual(
    stable.entries.map((e) => [e.key, e.status, e.reason ?? null, e.value]),
    [
      ['views', 'ok', null, 42],
      ['clicks', 'removed', 'rejected', null],
    ],
  );
});

// ---------------------------------------------------------------------------
// The table and its lookups
// ---------------------------------------------------------------------------

test('lookups find a key by source or legacy name, per level', () => {
  assert.equal(stableKeyFor('page', 'page_media_view'), 'views');
  assert.equal(stableKeyFor('page', 'PAGE_IMPRESSIONS'), 'views');
  assert.equal(stableKeyFor('post', 'post_media_view'), 'views');
  assert.equal(stableKeyFor('page', 'post_media_view'), undefined);
  assert.equal(stableKeyFor('reel', 'blue_reels_play_count'), 'plays');
  assert.equal(stableKeyFor('page', 'page_fans_city'), undefined);
  assert.equal(stableMetric('post', 'clicks')?.sourceMetric, 'post_clicks');
  assert.equal(stableMetric('page', 'clicks'), undefined);
  assert.deepEqual(
    stableMetricsFor('reel').map((d) => d.key),
    ['plays', 'video_view_time', 'avg_watch_time', 'reactions', 'social_actions'],
  );
});

test('every key is unique per level and every name maps to one key per level', () => {
  for (const level of LEVELS) {
    const defs = stableMetricsFor(level);
    const keys = defs.map((d) => d.key);
    assert.equal(new Set(keys).size, keys.length, `duplicate key on ${level}`);
    const names = defs.flatMap((d) => [d.sourceMetric, ...d.legacyMetrics]);
    assert.equal(new Set(names).size, names.length, `name on two keys on ${level}`);
  }
});

test('every table row is well formed', () => {
  for (const def of STABLE_INSIGHTS_SCHEMA) {
    const label = `${def.level}.${def.key}`;
    assert.ok(def.periods.length > 0, label);
    assert.ok(def.description.length > 0, label);
    for (const name of [def.sourceMetric, ...def.legacyMetrics]) {
      assert.equal(name, name.trim().toLowerCase(), `${label}: ${name} not canonical`);
    }
    if (def.level === 'page') assert.match(def.sourceMetric, /^page_/, label);
    if (def.level === 'post') assert.match(def.sourceMetric, /^post_/, label);
  }
});

test('drift guard: no source metric is in the deprecation table', () => {
  for (const def of STABLE_INSIGHTS_SCHEMA) {
    assert.equal(
      classifyMetric(def.sourceMetric).status,
      'ok',
      `${def.level}.${def.key} reads a dead name: ${def.sourceMetric}`,
    );
  }
});

test('drift guard: every legacy name is dead and points at its key', () => {
  for (const def of STABLE_INSIGHTS_SCHEMA) {
    for (const legacy of def.legacyMetrics) {
      const verdict = classifyMetric(legacy);
      assert.notEqual(verdict.status, 'ok', `${legacy} is not in the deprecation table`);
      if (verdict.replacement !== undefined) {
        assert.equal(
          verdict.replacement,
          def.sourceMetric,
          `${legacy} is renamed to another metric than ${def.level}.${def.key} reads`,
        );
      }
    }
  }
});

test('drift guard: every metric the report and the posts table read has a key', () => {
  const page = [...REPORT_DAY_METRICS, REACH_METRIC];
  const post = [...TOP_POST_METRICS, ...DEFAULT_POSTS_INSIGHTS_METRICS];
  for (const name of page) assert.ok(stableKeyFor('page', name), name);
  for (const name of post) assert.ok(stableKeyFor('post', name), name);
});
