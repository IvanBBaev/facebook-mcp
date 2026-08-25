// Tests for the insights api module (task V02): the reshape contract, aggregate
// mode, the row cap, window validation and the metric rename/deprecation table.
// Every Graph call goes through the injected fake — no network, ever.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeFbRequest, fbOk, fbErr } from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import type { FbRequest, ParamValue } from '../core/index.js';

import {
  INSIGHTS_MAX_ROWS,
  INSIGHTS_MAX_WINDOW_DAYS,
  INSIGHTS_TOKEN_EMPTY_HINT,
  PAGE_ELIGIBILITY_NOTE,
  PERIOD_BOUNDARY_NOTE,
  POST_EMPTY_NOTE,
  REEL_EMPTY_NOTE,
  FRESHNESS_NOTE,
  capRows,
  checkWindow,
  classifyMetric,
  classifyMetrics,
  fetchInsights,
  reshapeInsights,
  type InsightsRequest,
} from './insights.js';

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-07-20T12:00:00Z');
const PAGE_ID = '111222333';
const POST_ID = '111222333_999';

/** A Graph insights entry, complete with the boilerplate the reshape must drop. */
function series(
  name: string,
  period: string,
  points: readonly (readonly [string, unknown])[],
): unknown {
  return {
    name,
    period,
    title: `Human title for ${name}`,
    description: 'Long prose that Graph repeats for every single metric entry.',
    id: `/${PAGE_ID}/insights/${name}/${period}`,
    values: points.map(([endTime, value]) => ({ value, end_time: endTime })),
  };
}

/** A full insights body, including the paging block the reshape ignores. */
function insightsBody(...entries: unknown[]): unknown {
  return {
    data: entries,
    paging: { previous: 'https://x/prev', next: 'https://x/next' },
  };
}

function end(date: string): string {
  return `${date}T07:00:00+0000`;
}

/** Day-by-day points starting at `2026-07-01`, all carrying the same value. */
function days(count: number, value: number): readonly (readonly [string, unknown])[] {
  return Array.from({ length: count }, (_unused, index) => {
    const ms = Date.parse('2026-07-01T00:00:00Z') + index * 86_400_000;
    return [end(new Date(ms).toISOString().slice(0, 10)), value] as const;
  });
}

function paramsOf(call: FbRequest | undefined): Record<string, ParamValue> {
  assert.ok(call, 'expected a captured request');
  assert.equal(call.protocol, 'json');
  return call.protocol === 'json' ? { ...call.params } : {};
}

function pageRequest(overrides: Partial<InsightsRequest> = {}): InsightsRequest {
  return {
    scope: 'page',
    objectId: PAGE_ID,
    metrics: ['page_media_view'],
    nowMs: NOW,
    ...overrides,
  };
}

/** Capture a synchronously thrown GraphApiError so its fields can be asserted. */
function throwsGraph(fn: () => unknown): GraphApiError {
  try {
    fn();
  } catch (err) {
    assert.ok(
      err instanceof GraphApiError,
      `expected a GraphApiError, got ${String(err)}`,
    );
    return err;
  }
  assert.fail('expected the call to throw');
}

/** Capture a rejected GraphApiError so its fields can be asserted. */
async function rejectsGraph(promise: Promise<unknown>): Promise<GraphApiError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(
      err instanceof GraphApiError,
      `expected a GraphApiError, got ${String(err)}`,
    );
    return err;
  }
  assert.fail('expected the call to reject');
}

// ---------------------------------------------------------------------------
// 1. reshapeInsights — the flat row shape
// ---------------------------------------------------------------------------

test('reshapeInsights flattens values into compact rows and drops Graph boilerplate', () => {
  const out = reshapeInsights(
    insightsBody(
      series('page_media_view', 'day', [
        [end('2026-07-01'), 120],
        [end('2026-07-02'), 90],
      ]),
    ),
  );

  assert.deepEqual(out.rows, [
    { metric: 'page_media_view', date: '2026-07-01', value: 120 },
    { metric: 'page_media_view', date: '2026-07-02', value: 90 },
  ]);
  // No title / description / id / end_time / period survives onto a row.
  assert.deepEqual(Object.keys(out.rows[0] ?? {}), ['metric', 'date', 'value']);
});

test('reshapeInsights carries period, totals and exact boundaries once per metric', () => {
  const out = reshapeInsights(
    insightsBody(
      series('page_media_view', 'day', [
        [end('2026-07-01'), 120],
        [end('2026-07-02'), 90],
      ]),
      series('page_follows', 'week', [[end('2026-07-07'), 4]]),
    ),
  );

  assert.deepEqual(out.metrics, [
    {
      metric: 'page_media_view',
      period: 'day',
      points: 2,
      total: 210,
      firstEnd: end('2026-07-01'),
      lastEnd: end('2026-07-02'),
    },
    {
      metric: 'page_follows',
      period: 'week',
      points: 1,
      total: 4,
      firstEnd: end('2026-07-07'),
      lastEnd: end('2026-07-07'),
    },
  ]);
});

test('reshapeInsights flattens breakdown maps into breakdown paths', () => {
  const out = reshapeInsights(
    insightsBody(
      series('post_activity_by_action_type', 'lifetime', [
        [end('2026-07-01'), { like: 5, love: 2, share: 1 }],
      ]),
    ),
  );

  assert.deepEqual(out.rows, [
    {
      metric: 'post_activity_by_action_type',
      date: '2026-07-01',
      breakdown: 'like',
      value: 5,
    },
    {
      metric: 'post_activity_by_action_type',
      date: '2026-07-01',
      breakdown: 'love',
      value: 2,
    },
    {
      metric: 'post_activity_by_action_type',
      date: '2026-07-01',
      breakdown: 'share',
      value: 1,
    },
  ]);
  assert.equal(out.metrics[0]?.breakdowns, 3);
  assert.equal(out.metrics[0]?.total, 8);
  assert.equal(out.metrics[0]?.points, 3);
});

test('reshapeInsights joins nested breakdown keys and guards excessive depth', () => {
  const out = reshapeInsights(
    insightsBody(
      series('page_media_view_by_x', 'day', [
        [end('2026-07-01'), { mobile: { feed: 7 }, deep: { a: { b: { c: 1 } } } }],
      ]),
    ),
  );

  const paths = out.rows.map((row) => row.breakdown);
  assert.ok(paths.includes('mobile/feed'), 'nested keys are joined with a slash');
  assert.ok(
    paths.includes('deep/a/b'),
    'flattening stops at the depth guard instead of exploding',
  );
  assert.equal(
    out.rows.find((row) => row.breakdown === 'deep/a/b')?.value,
    '[nested breakdown omitted]',
  );
  assert.equal(out.metrics[0]?.total, 7, 'the placeholder stays out of the total');
  assert.equal(out.metrics[0]?.nonNumeric, true);
});

test('reshapeInsights omits null values instead of zero-filling absent days', () => {
  const out = reshapeInsights(
    insightsBody(
      series('page_media_view', 'day', [
        [end('2026-07-01'), 10],
        [end('2026-07-02'), null],
        [end('2026-07-03'), 0],
      ]),
    ),
  );

  assert.deepEqual(
    out.rows.map((row) => [row.date, row.value]),
    [
      ['2026-07-01', 10],
      ['2026-07-03', 0],
    ],
  );
  // A real zero is data and is kept; the null day is simply absent.
  assert.equal(out.metrics[0]?.points, 2);
  assert.equal(out.metrics[0]?.total, 10);
  assert.equal(out.metrics[0]?.lastEnd, end('2026-07-03'));
});

test('reshapeInsights keeps non-numeric values as strings and flags them', () => {
  const out = reshapeInsights(
    insightsBody(
      series('page_media_view', 'day', [
        [end('2026-07-01'), 5],
        [end('2026-07-02'), 'n/a'],
      ]),
    ),
  );

  assert.equal(out.rows[1]?.value, 'n/a');
  assert.equal(out.metrics[0]?.nonNumeric, true);
  assert.equal(out.metrics[0]?.total, 5, 'non-numeric points stay out of the total');
});

test('reshapeInsights records a metric with no values as an empty series', () => {
  const out = reshapeInsights(insightsBody(series('page_media_view', 'day', [])));

  assert.equal(out.metrics[0]?.total, undefined, 'no points means no invented total');
  assert.equal(out.metrics[0]?.firstEnd, undefined);
  assert.deepEqual(out.rows, []);
  assert.deepEqual(out.metrics, [
    { metric: 'page_media_view', period: 'day', points: 0 },
  ]);
});

test('reshapeInsights survives malformed bodies without throwing', () => {
  const junk: unknown[] = [
    undefined,
    null,
    42,
    'nope',
    {},
    { data: 'x' },
    { data: [1, null] },
  ];
  for (const body of junk) {
    const out = reshapeInsights(body);
    assert.deepEqual(out.rows, []);
    assert.deepEqual(out.metrics, []);
  }
  const unnamed = reshapeInsights({ data: [{ period: 'day', values: [] }] });
  assert.deepEqual(unnamed.metrics, [], 'an entry with no name is skipped');
  const noValues = reshapeInsights({ data: [{ name: 'm', values: 'x' }] });
  assert.deepEqual(noValues.metrics, [{ metric: 'm', period: 'unknown', points: 0 }]);
});

// ---------------------------------------------------------------------------
// 2. capRows — the documented row cap
// ---------------------------------------------------------------------------

test('capRows keeps the first rows and reports how many were dropped', () => {
  const rows = reshapeInsights(insightsBody(series('m', 'day', days(10, 1)))).rows;

  const under = capRows(rows, 10);
  assert.equal(under.truncated, false);
  assert.equal(under.dropped, 0);
  assert.equal(under.rows.length, 10);

  const over = capRows(rows, 4);
  assert.equal(over.truncated, true);
  assert.equal(over.dropped, 6);
  assert.equal(over.rows.length, 4);
  assert.equal(over.rows[0]?.date, '2026-07-01', 'the kept prefix is chronological');
  assert.equal(over.rows[3]?.date, '2026-07-04');
});

test('capRows never emits a zero-row cap for a nonsense limit', () => {
  const rows = reshapeInsights(insightsBody(series('m', 'day', days(3, 1)))).rows;
  assert.equal(capRows(rows, 0).rows.length, 1);
  assert.equal(capRows(rows, Number.NaN).rows.length, 1);
});

// ---------------------------------------------------------------------------
// 3. checkWindow — the 90-day ceiling (CC-INS-5)
// ---------------------------------------------------------------------------

test('checkWindow echoes the window and computes an inclusive day span', () => {
  const window = checkWindow({ since: '2026-07-01', until: '2026-07-10', nowMs: NOW });
  assert.deepEqual(window, { since: '2026-07-01', until: '2026-07-10', days: 10 });
});

test('checkWindow measures a lone since against today and omits days without since', () => {
  assert.equal(checkWindow({ since: '2026-07-18', nowMs: NOW }).days, 3);
  assert.deepEqual(checkWindow({ until: '2026-07-10', nowMs: NOW }), {
    until: '2026-07-10',
  });
  assert.deepEqual(checkWindow({ nowMs: NOW }), {});
});

test('checkWindow rejects a malformed date as a validation error', () => {
  const err = throwsGraph(() => checkWindow({ since: '01/07/2026', nowMs: NOW }));
  assert.equal(err.code, 100);
  assert.equal(err.httpStatus, 400);
  assert.equal(err.action?.category, 'validation');
  assert.match(err.message, /YYYY-MM-DD/);
  throwsGraph(() => checkWindow({ until: '2026-13-45', nowMs: NOW }));
});

test('checkWindow rejects a reversed window', () => {
  const err = throwsGraph(() =>
    checkWindow({ since: '2026-07-10', until: '2026-07-01', nowMs: NOW }),
  );
  assert.match(err.message, /is after/);
  assert.equal(err.action?.category, 'validation');
});

test('checkWindow enforces the documented day ceiling with actionable text', () => {
  const err = throwsGraph(() =>
    checkWindow({ since: '2026-01-01', until: '2026-07-01', nowMs: NOW }),
  );
  assert.match(err.message, /Window too wide/);
  assert.match(err.message, new RegExp(String(INSIGHTS_MAX_WINDOW_DAYS)));
  assert.match(err.message, /slices/);
  assert.equal(err.action?.category, 'validation');

  // Exactly at the ceiling is fine; one day more is not.
  const edge = checkWindow({
    since: '2026-07-01',
    until: '2026-07-03',
    nowMs: NOW,
    maxDays: 3,
  });
  assert.equal(edge.days, 3);
  throwsGraph(() =>
    checkWindow({ since: '2026-07-01', until: '2026-07-04', nowMs: NOW, maxDays: 3 }),
  );
});

// ---------------------------------------------------------------------------
// 4. The metric rename / deprecation table (C6, CC-INS-1)
// ---------------------------------------------------------------------------

test('classifyMetric suggests the replacement for a renamed metric', () => {
  const verdict = classifyMetric('page_impressions');
  assert.equal(verdict.status, 'renamed');
  assert.equal(verdict.replacement, 'page_media_view');
  assert.match(verdict.suggestion ?? '', /renamed/);
  assert.match(verdict.suggestion ?? '', /page_media_view/);
  assert.match(verdict.suggestion ?? '', /2025-11/);

  const fans = classifyMetric('page_fans');
  assert.equal(fans.replacement, 'page_follows');
  assert.match(fans.suggestion ?? '', /2024-09/);
});

test('classifyMetric explains a removed metric that has no replacement', () => {
  const verdict = classifyMetric('page_impressions_unique');
  assert.equal(verdict.status, 'removed');
  assert.equal(verdict.replacement, undefined);
  assert.match(verdict.suggestion ?? '', /no drop-in replacement/);
  assert.match(verdict.suggestion ?? '', /v25\.0/);
  assert.match(verdict.suggestion ?? '', /page_media_view/, 'names the closest figure');
});

test('classifyMetric passes unknown names through — the table is not a whitelist', () => {
  assert.deepEqual(classifyMetric('page_metric_invented_next_year'), {
    metric: 'page_metric_invented_next_year',
    status: 'ok',
  });
});

test('classifyMetric normalizes case and surrounding space but echoes the input', () => {
  const verdict = classifyMetric('  Page_Impressions ');
  assert.equal(verdict.status, 'renamed');
  assert.equal(verdict.metric, '  Page_Impressions ', 'the caller sees what it sent');
});

test('classifyMetrics preserves the requested order', () => {
  const verdicts = classifyMetrics(['page_media_view', 'page_fans', 'post_impressions']);
  assert.deepEqual(
    verdicts.map((verdict) => verdict.status),
    ['ok', 'renamed', 'renamed'],
  );
});

// ---------------------------------------------------------------------------
// 5. fetchInsights — the request it issues
// ---------------------------------------------------------------------------

test('fetchInsights GETs the insights edge with a comma-joined metric list', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk(insightsBody(series('page_media_view', 'day', days(2, 3)))));

  await fetchInsights(
    fake.fn,
    pageRequest({
      metrics: ['page_media_view', 'page_follows'],
      period: 'day',
      since: '2026-07-01',
      until: '2026-07-02',
      token: 'page-token',
    }),
  );

  const call = fake.lastRequest();
  assert.equal(call?.method, 'GET');
  assert.equal(call?.host, 'graph');
  assert.equal(call?.path, `/${PAGE_ID}/insights`);
  assert.equal(call?.token, 'page-token');
  assert.deepEqual(paramsOf(call), {
    metric: 'page_media_view,page_follows',
    period: 'day',
    since: '2026-07-01',
    until: '2026-07-02',
  });
});

test('fetchInsights defaults the period per scope and omits an unset window', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk(insightsBody(series('page_media_view', 'day', days(1, 1)))));

  const page = await fetchInsights(fake.fn, pageRequest());
  assert.equal(paramsOf(fake.lastRequest()).period, 'day');
  assert.equal(page.period, 'day');
  assert.equal(Object.hasOwn(page, 'window'), false, 'no window key without since/until');

  fake.reset();
  fake.on(() => true, fbOk(insightsBody(series('post_media_view', 'lifetime', []))));
  const post = await fetchInsights(fake.fn, {
    scope: 'post',
    objectId: POST_ID,
    metrics: ['post_media_view'],
    nowMs: NOW,
  });
  assert.equal(paramsOf(fake.lastRequest()).period, 'lifetime');
  assert.equal(post.period, 'lifetime');
});

test('fetchInsights de-duplicates the metric list it sends', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk(insightsBody(series('page_media_view', 'day', days(1, 1)))));

  const result = await fetchInsights(
    fake.fn,
    pageRequest({ metrics: ['page_media_view', 'page_media_view'] }),
  );

  assert.equal(paramsOf(fake.lastRequest()).metric, 'page_media_view');
  assert.deepEqual(result.queriedMetrics, ['page_media_view']);
});

test('fetchInsights validates the window before touching the network', async () => {
  const fake = createFakeFbRequest();
  const err = await rejectsGraph(
    fetchInsights(fake.fn, pageRequest({ since: '2020-01-01', until: '2026-01-01' })),
  );
  assert.match(err.message, /Window too wide/);
  assert.equal(fake.calls.length, 0, 'no request is issued for an invalid window');
});

// ---------------------------------------------------------------------------
// 6. fetchInsights — series, aggregate mode and the row cap (CC-INS-4)
// ---------------------------------------------------------------------------

test('fetchInsights returns flat rows plus summaries in series mode', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk(insightsBody(series('page_media_view', 'day', days(3, 5)))));

  const result = await fetchInsights(fake.fn, pageRequest({ since: '2026-07-01' }));

  assert.equal(result.mode, 'series');
  assert.equal(result.rowsAvailable, 3);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.rows, [
    { metric: 'page_media_view', date: '2026-07-01', value: 5 },
    { metric: 'page_media_view', date: '2026-07-02', value: 5 },
    { metric: 'page_media_view', date: '2026-07-03', value: 5 },
  ]);
  assert.equal(result.metrics[0]?.total, 15);
  assert.deepEqual(result.window, { since: '2026-07-01', days: 20 });
  assert.ok(result.notes.includes(PERIOD_BOUNDARY_NOTE));
  assert.deepEqual(result.deprecatedMetrics, []);
  assert.deepEqual(result.unavailableMetrics, []);
  assert.deepEqual(result.emptyMetrics, []);
});

test('fetchInsights aggregate mode returns totals only, with no per-point rows', async () => {
  const fake = createFakeFbRequest();
  fake.on(
    () => true,
    fbOk(
      insightsBody(
        series('page_media_view', 'day', days(60, 2)),
        series('page_follows', 'day', days(60, 1)),
      ),
    ),
  );

  const result = await fetchInsights(
    fake.fn,
    pageRequest({
      metrics: ['page_media_view', 'page_follows'],
      aggregate: true,
      // A cap that would bite hard in series mode is irrelevant here.
      maxRows: 10,
    }),
  );

  assert.equal(result.mode, 'aggregate');
  assert.equal(result.rows, undefined);
  assert.equal(Object.hasOwn(result, 'rows'), false, 'the rows key is absent, not empty');
  assert.equal(result.rowsAvailable, 120);
  assert.equal(result.truncated, false, 'aggregate mode never reports row truncation');
  assert.deepEqual(
    result.metrics.map((metric) => [metric.metric, metric.points, metric.total]),
    [
      ['page_media_view', 60, 120],
      ['page_follows', 60, 60],
    ],
  );
  assert.equal(
    result.notes.some((note) => note.includes('Row cap reached')),
    false,
  );
});

test('fetchInsights caps rows and says so, with actionable advice', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk(insightsBody(series('page_media_view', 'day', days(30, 1)))));

  const result = await fetchInsights(fake.fn, pageRequest({ maxRows: 10 }));

  assert.equal(result.truncated, true);
  assert.equal(result.rows?.length, 10);
  assert.equal(result.rowsAvailable, 30, 'the honest available count is still reported');
  const note = result.notes.find((entry) => entry.includes('Row cap reached'));
  assert.ok(note, 'a truncation note is emitted');
  assert.match(note, /kept the first 10 of 30 data points and dropped 20/);
  assert.match(note, /aggregate:true/);
  assert.match(note, /narrow the window/);
});

test('fetchInsights leaves a result inside the default row cap untruncated', async () => {
  const fake = createFakeFbRequest();
  const pointCount = 90;
  assert.ok(pointCount < INSIGHTS_MAX_ROWS, 'fixture must fit inside the default cap');
  fake.on(
    () => true,
    fbOk(insightsBody(series('page_media_view', 'day', days(pointCount, 1)))),
  );

  const result = await fetchInsights(fake.fn, pageRequest());
  assert.equal(result.truncated, false);
  assert.equal(result.rows?.length, pointCount);
  assert.equal(
    result.notes.some((note) => note.includes('Row cap reached')),
    false,
  );
});

// ---------------------------------------------------------------------------
// 7. fetchInsights — dead metrics, empty metrics, unavailable metrics
// ---------------------------------------------------------------------------

test('fetchInsights drops a renamed metric and returns the rename suggestion', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk(insightsBody(series('page_media_view', 'day', days(2, 4)))));

  const result = await fetchInsights(
    fake.fn,
    pageRequest({ metrics: ['page_impressions', 'page_media_view'] }),
  );

  assert.equal(
    paramsOf(fake.lastRequest()).metric,
    'page_media_view',
    'the dead name never reaches Graph — it would fail the whole call',
  );
  assert.deepEqual(result.queriedMetrics, ['page_media_view']);
  assert.equal(result.deprecatedMetrics.length, 1);
  assert.equal(result.deprecatedMetrics[0]?.metric, 'page_impressions');
  assert.equal(result.deprecatedMetrics[0]?.status, 'renamed');
  assert.match(result.deprecatedMetrics[0]?.suggestion ?? '', /page_media_view/);
  assert.ok(
    result.notes.some((note) => note.includes('Dropped 1 deprecated metric name(s)')),
  );
  assert.equal(result.rows?.length, 2, 'the live metric is still read');
});

test('a metric typed in the wrong case is answered, not declared unavailable', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk(insightsBody(series('page_media_view', 'day', days(2, 5)))));

  const result = await fetchInsights(
    fake.fn,
    pageRequest({ metrics: ['Page_Media_View'] }),
  );

  // Graph speaks lower-case snake_case and echoes that spelling back in `name`.
  // Matching the caller's casing against the reply would hand the model the rows
  // AND a note saying the metric does not exist.
  assert.equal(paramsOf(fake.lastRequest()).metric, 'page_media_view');
  assert.deepEqual(result.queriedMetrics, ['page_media_view']);
  assert.deepEqual(result.unavailableMetrics, []);
  assert.equal(result.rows?.length, 2);
});

test('both spellings of one metric are requested once, not twice', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk(insightsBody(series('page_media_view', 'day', days(1, 3)))));

  const result = await fetchInsights(
    fake.fn,
    pageRequest({ metrics: ['page_media_view', 'PAGE_MEDIA_VIEW'] }),
  );

  assert.equal(paramsOf(fake.lastRequest()).metric, 'page_media_view');
  assert.deepEqual(result.queriedMetrics, ['page_media_view']);
  assert.deepEqual(result.unavailableMetrics, []);
});

test('a deprecated metric is recognised whatever case it was typed in', () => {
  const verdict = classifyMetric('PAGE_IMPRESSIONS');

  assert.equal(verdict.status, 'renamed');
  assert.equal(verdict.replacement, 'page_media_view');
  // The suggestion is read by whoever typed the name, so the verdict echoes
  // their spelling rather than the canonical one.
  assert.equal(verdict.metric, 'PAGE_IMPRESSIONS');
});

test('fetchInsights answers a fully deprecated request without any HTTP call', async () => {
  const fake = createFakeFbRequest();

  const result = await fetchInsights(
    fake.fn,
    pageRequest({ metrics: ['page_impressions', 'page_fans'] }),
  );

  assert.equal(fake.calls.length, 0, 'nothing live to ask for, so nothing is asked');
  assert.deepEqual(result.queriedMetrics, []);
  assert.deepEqual(result.rows, []);
  assert.equal(result.rowsAvailable, 0);
  assert.deepEqual(
    result.deprecatedMetrics.map((verdict) => verdict.replacement),
    ['page_media_view', 'page_follows'],
  );
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0] ?? '', /No live metric name remained/);
});

test('fetchInsights separates a valid-but-empty metric from an invalid one', async () => {
  const fake = createFakeFbRequest();
  fake.on(
    () => true,
    fbOk(
      insightsBody(
        series('page_media_view', 'day', days(2, 7)),
        // Graph accepted this metric and answered with no data points at all.
        series('page_daily_follows', 'day', []),
        // `page_views_total` is simply absent from the response.
      ),
    ),
  );

  const result = await fetchInsights(
    fake.fn,
    pageRequest({
      metrics: ['page_media_view', 'page_daily_follows', 'page_views_total'],
    }),
  );

  assert.deepEqual(result.emptyMetrics, ['page_daily_follows']);
  assert.deepEqual(result.unavailableMetrics, ['page_views_total']);

  const emptyNote = result.notes.find((note) => note.startsWith('Valid but empty'));
  assert.ok(emptyNote, 'the valid-but-no-data case is called out');
  assert.match(emptyNote, /page_daily_follows/);

  const invalidNote = result.notes.find((note) =>
    note.startsWith('Graph returned no entry'),
  );
  assert.ok(invalidNote, 'the invalid-name case is called out separately');
  assert.match(invalidNote, /page_views_total/);
  assert.match(
    invalidNote,
    /not valid for this object or for the pinned Graph API version/,
  );
  assert.match(invalidNote, /different from a valid metric with no data/);
});

test('fetchInsights explains an all-empty Page result with the eligibility floor', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk(insightsBody(series('page_media_view', 'day', []))));

  const result = await fetchInsights(fake.fn, pageRequest());

  assert.ok(result.notes.includes(PAGE_ELIGIBILITY_NOTE));
  assert.match(PAGE_ELIGIBILITY_NOTE, /fewer than 100 likes\/followers/);
  assert.match(PAGE_ELIGIBILITY_NOTE, /read_insights/);
  assert.match(PAGE_ELIGIBILITY_NOTE, /ANALYZE/);
});

test('fetchInsights explains an all-empty post result as lag, or a Reel', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk(insightsBody(series('post_media_view', 'lifetime', []))));

  const result = await fetchInsights(fake.fn, {
    scope: 'post',
    objectId: POST_ID,
    metrics: ['post_media_view'],
    nowMs: NOW,
  });

  assert.ok(result.notes.includes(POST_EMPTY_NOTE));
  assert.ok(!result.notes.includes(PAGE_ELIGIBILITY_NOTE));
  assert.match(POST_EMPTY_NOTE, /video_insights/, 'Reels are named as living elsewhere');
  assert.match(
    POST_EMPTY_NOTE,
    /facebook_reel_insights/,
    'and the tool that actually reaches them is named',
  );
});

test('an all-empty series also names the user-token trap, in both scopes (CC-AUTH-2)', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk(insightsBody(series('page_media_view', 'day', []))));

  const page = await fetchInsights(fake.fn, pageRequest());
  assert.ok(page.notes.includes(INSIGHTS_TOKEN_EMPTY_HINT));

  fake.reset();
  fake.on(() => true, fbOk(insightsBody(series('post_media_view', 'lifetime', []))));

  const post = await fetchInsights(fake.fn, {
    scope: 'post',
    objectId: POST_ID,
    metrics: ['post_media_view'],
    nowMs: NOW,
  });
  assert.ok(post.notes.includes(INSIGHTS_TOKEN_EMPTY_HINT));
  assert.match(INSIGHTS_TOKEN_EMPTY_HINT, /facebook_whoami/, 'it names the check to run');
  assert.match(INSIGHTS_TOKEN_EMPTY_HINT, /does not error/, 'the failure is silent');
});

test('a series with data carries no user-token hint', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk(insightsBody(series('page_media_view', 'day', days(3, 1)))));

  const result = await fetchInsights(fake.fn, pageRequest());

  assert.ok(!result.notes.includes(INSIGHTS_TOKEN_EMPTY_HINT));
});

// ---------------------------------------------------------------------------
// 8. fetchInsights — freshness (CC-INS-6) and metric-error enrichment
// ---------------------------------------------------------------------------

test('fetchInsights warns about the insights lag when the window reaches today', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk(insightsBody(series('page_media_view', 'day', days(3, 1)))));

  const open = await fetchInsights(fake.fn, pageRequest());
  assert.ok(open.notes.includes(FRESHNESS_NOTE), 'an open-ended window may still lag');

  fake.reset();
  fake.on(
    () => true,
    fbOk(
      insightsBody(
        series('page_media_view', 'day', [
          [end('2026-07-01'), 1],
          [end('2026-07-10'), 2],
        ]),
      ),
    ),
  );
  const closed = await fetchInsights(
    fake.fn,
    pageRequest({ since: '2026-07-01', until: '2026-07-10' }),
  );
  assert.equal(
    closed.notes.includes(FRESHNESS_NOTE),
    false,
    'a window that ended in the past is already settled',
  );
});

test('fetchInsights enriches a Graph metric error and preserves its identity', async () => {
  const fake = createFakeFbRequest();
  const original = new GraphApiError(
    '(#100) metric[0] must be one of the following values',
    {
      code: 100,
      subcode: 1_234,
      type: 'OAuthException',
      fbtraceId: 'trace-xyz',
      httpStatus: 400,
      action: {
        category: 'validation',
        retryable: false,
        operatorText: 'fix the arguments',
      },
    },
  );
  fake.on(() => true, fbErr(original));

  const err = await rejectsGraph(
    fetchInsights(fake.fn, pageRequest({ metrics: ['page_media_view', 'page_views'] })),
  );

  assert.match(err.message, /must be one of the following values/);
  assert.match(err.message, /NO metric was read/);
  assert.match(err.message, /one metric at a time/);
  assert.match(err.message, /rename table/, 'no known-dead name was in the request');
  assert.equal(err.code, 100);
  assert.equal(err.subcode, 1_234);
  assert.equal(err.type, 'OAuthException');
  assert.equal(err.fbtraceId, 'trace-xyz');
  assert.equal(err.httpStatus, 400);
  assert.equal(err.action?.category, 'validation');
  assert.equal(err.cause, original, 'the original error stays reachable as the cause');
});

test('fetchInsights names known-dead metrics when Graph rejects the metric list', async () => {
  const fake = createFakeFbRequest();
  fake.on(
    () => true,
    fbErr(
      new GraphApiError('(#3001) The value for metric is invalid', {
        code: 3_001,
        httpStatus: 400,
      }),
    ),
  );

  // `page_fans` is dropped before the call; `page_vieuws_total` is a typo the
  // table cannot know, so Graph is the one that objects — and the rejection
  // still carries the rename advice for the name we do recognize.
  const err = await rejectsGraph(
    fetchInsights(fake.fn, pageRequest({ metrics: ['page_fans', 'page_vieuws_total'] })),
  );

  assert.equal(paramsOf(fake.lastRequest()).metric, 'page_vieuws_total');
  assert.equal(err.code, 3_001);
  assert.match(err.message, /Graph rejected the metric list/);
  assert.match(err.message, /Known-dead names in this request/);
  assert.match(err.message, /page_follows/);
});

test('fetchInsights passes a non-metric Graph error through untouched', async () => {
  const fake = createFakeFbRequest();
  const original = new GraphApiError('(#190) Error validating access token', {
    code: 190,
    httpStatus: 401,
  });
  fake.on(() => true, fbErr(original));

  const err = await rejectsGraph(fetchInsights(fake.fn, pageRequest()));
  assert.equal(err, original, 'only metric-validation failures are rewritten');
});

// ---------------------------------------------------------------------------
// The `reel` scope — /video_insights (G-TOOL-2)
// ---------------------------------------------------------------------------

/** A Reel is addressed by its bare video ID, never a `{page}_{post}` composite. */
const VIDEO_ID = '987654321';

function reelRequest(overrides: Partial<InsightsRequest> = {}): InsightsRequest {
  return {
    scope: 'reel',
    objectId: VIDEO_ID,
    metrics: ['blue_reels_play_count'],
    nowMs: NOW,
    ...overrides,
  };
}

test('the reel scope reads /video_insights and defaults to lifetime', async () => {
  const fake = createFakeFbRequest();
  fake.on(
    () => true,
    fbOk(
      insightsBody(
        series('blue_reels_play_count', 'lifetime', [[end('2026-07-01'), 42]]),
      ),
    ),
  );

  const result = await fetchInsights(fake.fn, reelRequest());

  const call = fake.lastRequest();
  assert.ok(call, 'expected a captured request');
  assert.equal(call.path, `/${VIDEO_ID}/video_insights`);
  assert.equal(paramsOf(call).period, 'lifetime');
  assert.equal(result.period, 'lifetime');
});

test('the page and post scopes keep reading /insights', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk(insightsBody(series('page_media_view', 'day', []))));

  await fetchInsights(fake.fn, pageRequest());
  assert.equal(fake.lastRequest()?.path, `/${PAGE_ID}/insights`);

  await fetchInsights(fake.fn, {
    scope: 'post',
    objectId: POST_ID,
    metrics: ['post_media_view'],
    nowMs: NOW,
  });
  assert.equal(fake.lastRequest()?.path, `/${POST_ID}/insights`);
});

test('an explicit period still wins on the reel scope', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk(insightsBody(series('blue_reels_play_count', 'day', []))));

  await fetchInsights(fake.fn, reelRequest({ period: 'day' }));
  assert.equal(paramsOf(fake.lastRequest()).period, 'day');
});

test('an all-empty reel result is explained by ID, publish state and lag', async () => {
  const fake = createFakeFbRequest();
  fake.on(
    () => true,
    fbOk(insightsBody(series('blue_reels_play_count', 'lifetime', []))),
  );

  const result = await fetchInsights(fake.fn, reelRequest());

  assert.ok(result.notes.includes(REEL_EMPTY_NOTE));
  assert.ok(
    !result.notes.includes(POST_EMPTY_NOTE),
    'the post explanation does not leak',
  );
  assert.ok(
    !result.notes.includes(PAGE_ELIGIBILITY_NOTE),
    'the Page floor does not leak',
  );
  // The user-token trap is scope-independent: a USER token answers empty here too.
  assert.ok(result.notes.includes(INSIGHTS_TOKEN_EMPTY_HINT));
  assert.match(REEL_EMPTY_NOTE, /VIDEO id/);
  assert.match(REEL_EMPTY_NOTE, /PUBLISHED/);
});

test('an unavailable reel metric is sent to the video vocabulary, not the doctor', async () => {
  const fake = createFakeFbRequest();
  fake.on(
    () => true,
    fbOk(
      insightsBody(series('blue_reels_play_count', 'lifetime', [[end('2026-07-01'), 1]])),
    ),
  );

  const result = await fetchInsights(
    fake.fn,
    reelRequest({ metrics: ['blue_reels_play_count', 'page_media_view'] }),
  );

  assert.deepEqual(result.unavailableMetrics, ['page_media_view']);
  const note = result.notes.find((entry) => entry.includes('no entry for'));
  assert.ok(note, 'the unavailable metric is reported');
  assert.match(note, /video_insights vocabulary/);
  assert.doesNotMatch(note, /run the doctor/);
});

test('the doctor probe hint survives on the page and post scopes', async () => {
  const fake = createFakeFbRequest();
  fake.on(
    () => true,
    fbOk(insightsBody(series('page_media_view', 'day', [[end('2026-07-01'), 1]]))),
  );

  const result = await fetchInsights(
    fake.fn,
    pageRequest({ metrics: ['page_media_view', 'page_bogus_metric'] }),
  );

  const note = result.notes.find((entry) => entry.includes('no entry for'));
  assert.ok(note, 'the unavailable metric is reported');
  assert.match(note, /run the doctor/);
});

test('the reel scope shares the reshape contract: rows, cap and aggregate', async () => {
  const fake = createFakeFbRequest();
  fake.on(
    () => true,
    fbOk(insightsBody(series('post_video_view_time', 'lifetime', days(40, 3)))),
  );

  const capped = await fetchInsights(fake.fn, reelRequest({ maxRows: 5 }));
  assert.equal(capped.rows?.length, 5);
  assert.equal(capped.rowsAvailable, 40);
  assert.equal(capped.truncated, true);

  const totals = await fetchInsights(fake.fn, reelRequest({ aggregate: true }));
  assert.equal(totals.mode, 'aggregate');
  assert.equal(totals.rows, undefined);
  assert.deepEqual(
    totals.metrics.map((metric) => [metric.metric, metric.points, metric.total]),
    [['post_video_view_time', 40, 120]],
  );
});
