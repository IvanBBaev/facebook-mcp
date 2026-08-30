// Tests for the `insights` tool package (task V02): the three read-only tools
// (facebook_page_insights / facebook_post_insights / facebook_reel_insights),
// the reshape contract they share, aggregate mode, the row cap and its
// truncation note, the metric rename handling, the honesty notes (CC-INS-1..6),
// the /video_insights edge split (G-TOOL-2) and the package invariants.
// Every Graph call is served by `createFakeFbRequest` — the network fence
// guarantees no real fetch escapes. Placeholder tokens only.

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
  type FakePageResolver,
} from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import type {
  JsonRequest,
  Logger,
  Settings,
  ToolContext,
  ToolResult,
  ToolSpec,
} from '../core/index.js';
import { INSIGHTS_MAX_ROWS, INSIGHTS_MAX_WINDOW_DAYS } from '../api/insights.js';
import { createInsightsPackage } from './insights.js';

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const PAGE_ID = '111222333';
const POST_ID = '111222333_999';
/** A Reel is addressed by its bare video ID — deliberately not a post composite. */
const VIDEO_ID = '987654321';
const PAGE_TOKEN = 'EAA-PAGE-TOKEN-0123456789';

/** Fixed "now" for every test — the freshness logic must never read the wall clock. */
const NOW = Date.parse('2026-07-20T12:00:00Z');

/** A recording no-op logger (satisfies the contract without side effects). */
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

interface CtxParts {
  readonly fb: FakeFbRequest;
  readonly pages: FakePageResolver;
  readonly ctx: ToolContext;
}

function makeCtx(
  opts: {
    settings?: Settings;
    pages?: FakePageResolver;
    nowMs?: number;
  } = {},
): CtxParts {
  const fb = createFakeFbRequest();
  const pages =
    opts.pages ??
    createFakePageResolver({
      default: { pageId: PAGE_ID, name: 'Default', token: PAGE_TOKEN },
    });
  const clock = createFakeClock(opts.nowMs ?? NOW);
  const settings = opts.settings ?? makeSettings();
  const ctx: ToolContext = {
    settings,
    fbRequest: fb.fn,
    pages,
    logger: makeLogger(),
    // Deliberately seeded with NO secrets: a pass-through redactor is what makes
    // the "the token never reaches the model" assertions meaningful instead of
    // vacuously satisfied by a `[REDACTED]` substitution.
    redactor: createFakeRedactor(),
    clock,
    journal: createMemoryJournal(clock),
  };
  return { fb, pages, ctx };
}

/** Look a tool up in the built package by name (fails loudly if renamed). */
function tool(name: string): ToolSpec {
  const spec = createInsightsPackage().tools.find((t) => t.name === name);
  assert.ok(spec, `expected a tool named ${name}`);
  return spec;
}

/** Parse a text-only ToolResult body as an object. */
function body(result: ToolResult): Record<string, unknown> {
  const text = result.content[0]?.text ?? '';
  return JSON.parse(text) as Record<string, unknown>;
}

function lastJson(fb: FakeFbRequest): JsonRequest {
  const req = fb.lastRequest();
  if (req === undefined || req.protocol !== 'json') {
    throw new Error(`expected a json request, got ${req?.protocol ?? 'none'}`);
  }
  return req;
}

function rowsOf(parsed: Record<string, unknown>): readonly Record<string, unknown>[] {
  const value = parsed.rows;
  assert.ok(Array.isArray(value), 'expected a `rows` array in the payload');
  return value as readonly Record<string, unknown>[];
}

function summariesOf(
  parsed: Record<string, unknown>,
): readonly Record<string, unknown>[] {
  const value = parsed.metrics;
  assert.ok(Array.isArray(value), 'expected a `metrics` array in the payload');
  return value as readonly Record<string, unknown>[];
}

function notesOf(parsed: Record<string, unknown>): readonly string[] {
  const value = parsed.notes;
  assert.ok(Array.isArray(value), 'expected a `notes` array in the payload');
  return value as readonly string[];
}

function noteMatching(
  parsed: Record<string, unknown>,
  pattern: RegExp,
): string | undefined {
  return notesOf(parsed).find((note) => pattern.test(note));
}

/** Assert a handler call rejects, and that its message matches `pattern`. */
async function rejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof Error, `expected an Error, got ${String(err)}`);
    assert.match(err.message, pattern);
    return true;
  });
}

// --- Graph fixtures --------------------------------------------------------

function end(date: string): string {
  return `${date}T07:00:00+0000`;
}

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
    description: 'Long prose Graph repeats for every single metric entry.',
    id: `/${PAGE_ID}/insights/${name}/${period}`,
    values: points.map(([endTime, value]) => ({ value, end_time: endTime })),
  };
}

/**
 * A full insights body. The `paging` block carries a live-looking token exactly
 * as Graph does, so the tests can prove neither the reshape nor the shaper ever
 * lets it reach the model (C3 / CC-PAGE-4).
 */
function insightsBody(...entries: unknown[]): unknown {
  return {
    data: entries,
    paging: {
      next: `https://graph.facebook.com/v23.0/${PAGE_ID}/insights?after=CURSOR&access_token=${PAGE_TOKEN}`,
    },
  };
}

/** Day-by-day points starting at `2026-07-01`, all carrying the same value. */
function days(count: number, value: number): readonly (readonly [string, unknown])[] {
  return Array.from({ length: count }, (_unused, index) => {
    const ms = Date.parse('2026-07-01T00:00:00Z') + index * 86_400_000;
    return [end(new Date(ms).toISOString().slice(0, 10)), value] as const;
  });
}

/** Stub every request with one insights body. */
function serve(fb: FakeFbRequest, ...entries: unknown[]): void {
  fb.on(() => true, fbOk(insightsBody(...entries)));
}

// ---------------------------------------------------------------------------
// Package invariants
// ---------------------------------------------------------------------------

test('createInsightsPackage builds the default-on, read-only package with three tools', () => {
  const pkg = createInsightsPackage();
  assert.equal(pkg.name, 'insights');
  assert.equal(pkg.enabledByDefault, true);
  assert.equal(
    pkg.writeModeDefault,
    undefined,
    'a read-only package needs no write mode',
  );
  assert.deepEqual(
    pkg.tools.map((t) => t.name),
    ['facebook_page_insights', 'facebook_post_insights', 'facebook_reel_insights'],
  );
  for (const t of pkg.tools) {
    // The exact quadruple doc 06 pins for every insights tool: RO/D/I/OW.
    assert.deepEqual(
      t.annotations,
      {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      `${t.name} annotation quadruple`,
    );
    assert.equal(t.writeTier, undefined, `${t.name} must carry no write tier`);
    assert.equal(
      t.outputSchema,
      undefined,
      `${t.name} is an ordinary tool, not a server-owned envelope`,
    );
    assert.ok(t.title !== undefined && t.title.length > 0, `${t.name} has a title`);
  }
});

test('the page/post descriptions send Reel metrics to the Reel tool (G-TOOL-2)', () => {
  const byName = new Map(createInsightsPackage().tools.map((t) => [t.name, t]));
  const post = byName.get('facebook_post_insights')?.description ?? '';
  const page = byName.get('facebook_page_insights')?.description ?? '';
  assert.match(post, /video_insights/);
  assert.match(post, /Reel metrics are NOT reachable/);
  assert.match(page, /Reel metrics are NOT available/);
  // Naming the edge is not enough: a model that reads "not here" needs to be
  // told where "here" is, or it retries the same tool with the same ID.
  for (const description of [post, page]) {
    assert.match(description, /facebook_reel_insights/);
  }
  // The lag caveat is stated up front, not only after an empty answer.
  assert.match(post, /lag minutes to hours/);
});

test('the input schemas are strict and demand at least one metric', async () => {
  const { ctx } = makeCtx();
  await rejects(
    tool('facebook_page_insights').handler(
      { metrics: ['page_media_view'], bogus: 1 },
      ctx,
    ),
    /Unrecognized key/,
  );
  await rejects(
    tool('facebook_page_insights').handler({ metrics: [] }, ctx),
    /at least 1/,
  );
  await rejects(tool('facebook_page_insights').handler({}, ctx), /metrics/);
  await rejects(
    tool('facebook_post_insights').handler({ metrics: ['post_media_view'] }, ctx),
    /post_id/,
  );
  // `period` is the one closed vocabulary here — an invented value is rejected
  // with the allowed set, while the metric list stays deliberately open.
  await rejects(
    tool('facebook_page_insights').handler(
      { metrics: ['page_media_view'], period: 'daily' },
      ctx,
    ),
    /days_28/,
  );
});

test('the metric list is bounded and max_rows can only shrink the row cap', async () => {
  const { ctx, fb } = makeCtx();
  const many = Array.from({ length: 21 }, (_unused, i) => `page_metric_${String(i)}`);
  await rejects(
    tool('facebook_page_insights').handler({ metrics: many }, ctx),
    /at most 20/,
  );
  await rejects(
    tool('facebook_page_insights').handler(
      { metrics: ['page_media_view'], max_rows: INSIGHTS_MAX_ROWS + 1 },
      ctx,
    ),
    new RegExp(String(INSIGHTS_MAX_ROWS)),
  );
  await rejects(
    tool('facebook_page_insights').handler(
      { metrics: ['page_media_view'], max_rows: 0 },
      ctx,
    ),
    /greater than or equal to 1/,
  );
  assert.equal(fb.calls.length, 0, 'a schema rejection never reaches Graph');
});

// ---------------------------------------------------------------------------
// facebook_page_insights — the reshape contract
// ---------------------------------------------------------------------------

test('page_insights reads the resolved Page with its token and flattens the series', async () => {
  const pages = createFakePageResolver({
    default: { pageId: PAGE_ID, name: 'Default', token: 'EAA-DEF' },
    pages: { 'brand-a': { pageId: '200', name: 'Brand A', token: 'EAA-BRAND' } },
  });
  const { fb, ctx } = makeCtx({ pages });
  serve(
    fb,
    series('page_media_view', 'day', [
      [end('2026-07-01'), 120],
      [end('2026-07-02'), 90],
    ]),
  );

  const result = await tool('facebook_page_insights').handler(
    {
      profile: 'brand-a',
      metrics: ['page_media_view'],
      period: 'day',
      since: '2026-07-01',
      until: '2026-07-02',
    },
    ctx,
  );

  assert.equal(result.structuredContent, undefined, 'ordinary tool is text-only');
  assert.deepEqual(pages.resolveCalls, ['brand-a']);
  const req = lastJson(fb);
  assert.equal(req.method, 'GET');
  assert.equal(req.host, 'graph');
  assert.equal(req.path, '/200/insights');
  assert.equal(req.token, 'EAA-BRAND', 'the per-Page token authorizes the read (C1)');
  assert.deepEqual(
    { ...req.params },
    {
      metric: 'page_media_view',
      period: 'day',
      since: '2026-07-01',
      until: '2026-07-02',
    },
  );

  const parsed = body(result);
  assert.equal(parsed.profile, 'brand-a');
  assert.equal(parsed.pageId, '200');
  assert.equal(parsed.mode, 'series');
  assert.equal(parsed.truncated, false);
  assert.equal(parsed.rowsAvailable, 2);
  // The flat row shape: no title, no description, no id, no per-row period.
  assert.deepEqual(rowsOf(parsed), [
    { metric: 'page_media_view', date: '2026-07-01', value: 120 },
    { metric: 'page_media_view', date: '2026-07-02', value: 90 },
  ]);
  assert.deepEqual(Object.keys(rowsOf(parsed)[0] ?? {}), ['metric', 'date', 'value']);
  assert.deepEqual(summariesOf(parsed), [
    {
      metric: 'page_media_view',
      period: 'day',
      points: 2,
      kind: 'flow',
      aggregation: 'sum',
      value: 210,
      total: 210,
      firstValue: 120,
      lastValue: 90,
      firstEnd: end('2026-07-01'),
      lastEnd: end('2026-07-02'),
      aggregationNote:
        'Known flow metric over non-overlapping day buckets: value is the sum of the returned buckets.',
    },
  ]);
  assert.deepEqual(parsed.window, { since: '2026-07-01', until: '2026-07-02', days: 1 });
});

test('page_insights with no profile resolves the default Page and echoes profile null', async () => {
  const { fb, ctx, pages } = makeCtx();
  serve(fb, series('page_media_view', 'day', days(2, 1)));

  const parsed = body(
    await tool('facebook_page_insights').handler({ metrics: ['page_media_view'] }, ctx),
  );
  assert.deepEqual(pages.resolveCalls, [undefined]);
  assert.equal(parsed.profile, null);
  assert.equal(parsed.pageId, PAGE_ID);
  assert.equal(lastJson(fb).path, `/${PAGE_ID}/insights`);
  assert.equal(lastJson(fb).params?.period, 'day', 'a Page defaults to the daily series');
});

test('page_insights flattens a breakdown map into breakdown rows', async () => {
  const { fb, ctx } = makeCtx();
  serve(
    fb,
    series('page_actions_post_reactions_by_type_total', 'day', [
      [end('2026-07-01'), { like: 5, love: 2 }],
    ]),
  );

  const parsed = body(
    await tool('facebook_page_insights').handler(
      { metrics: ['page_actions_post_reactions_by_type_total'] },
      ctx,
    ),
  );
  assert.deepEqual(
    rowsOf(parsed).map((row) => [row.breakdown, row.value]),
    [
      ['like', 5],
      ['love', 2],
    ],
  );
  assert.equal(summariesOf(parsed)[0]?.breakdowns, 2);
  assert.equal(summariesOf(parsed)[0]?.aggregation, 'none');
  assert.equal(
    summariesOf(parsed)[0]?.total,
    undefined,
    'breakdown dimensions are not assumed to be additive',
  );
});

test('page_insights never lets the token-bearing paging block reach the model', async () => {
  const { fb, ctx } = makeCtx();
  serve(fb, series('page_media_view', 'day', days(2, 1)));

  const result = await tool('facebook_page_insights').handler(
    { metrics: ['page_media_view'] },
    ctx,
  );
  const text = result.content[0]?.text ?? '';
  assert.equal(text.includes(PAGE_TOKEN), false, 'no raw token in the rendered result');
  assert.equal(text.includes('access_token'), false);
  assert.equal(text.includes('CURSOR'), false, 'the paging block is dropped entirely');
  assert.equal(Object.hasOwn(body(result), 'paging'), false);
});

// ---------------------------------------------------------------------------
// Aggregate mode and the row cap (CC-INS-4)
// ---------------------------------------------------------------------------

test('page_insights aggregate mode returns per-metric totals and no rows at all', async () => {
  const { fb, ctx } = makeCtx();
  serve(
    fb,
    series('page_media_view', 'day', days(60, 2)),
    series('page_follows', 'day', days(60, 1)),
  );

  const parsed = body(
    await tool('facebook_page_insights').handler(
      { metrics: ['page_media_view', 'page_follows'], aggregate: true },
      ctx,
    ),
  );

  assert.equal(parsed.mode, 'aggregate');
  assert.equal(Object.hasOwn(parsed, 'rows'), false, 'the rows key is absent, not empty');
  assert.equal(parsed.rowsAvailable, 120, 'the honest available count is still reported');
  assert.equal(parsed.truncated, false, 'aggregate mode never reports row truncation');
  assert.deepEqual(
    summariesOf(parsed).map((m) => [m.metric, m.points, m.aggregation, m.value, m.total]),
    [
      ['page_media_view', 60, 'sum', 120, 120],
      ['page_follows', 60, 'latest', 1, undefined],
    ],
  );
  assert.equal(noteMatching(parsed, /Row cap reached/), undefined);
});

test('page_insights enforces the default row cap and says exactly what was dropped', async () => {
  const { fb, ctx } = makeCtx();
  const available = INSIGHTS_MAX_ROWS + 50;
  serve(fb, series('page_media_view', 'day', days(available, 1)));

  const parsed = body(
    await tool('facebook_page_insights').handler({ metrics: ['page_media_view'] }, ctx),
  );

  assert.equal(rowsOf(parsed).length, INSIGHTS_MAX_ROWS);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.rowsAvailable, available);
  // The kept prefix is chronological — the first rows, not an arbitrary slice.
  assert.equal(rowsOf(parsed)[0]?.date, '2026-07-01');
  const note = noteMatching(parsed, /Row cap reached/);
  assert.ok(note, 'the truncation note is explicit, never a silently short answer');
  assert.match(
    note,
    new RegExp(
      `kept the first ${String(INSIGHTS_MAX_ROWS)} of ${String(available)} data points and dropped 50`,
    ),
  );
  assert.match(note, /aggregate:true/);
  // The per-metric summary still reports the full, untruncated point count.
  assert.equal(summariesOf(parsed)[0]?.points, available);
});

test('page_insights honours a lowered max_rows and stays untruncated below it', async () => {
  const { fb, ctx } = makeCtx();
  serve(fb, series('page_media_view', 'day', days(30, 1)));

  const capped = body(
    await tool('facebook_page_insights').handler(
      { metrics: ['page_media_view'], max_rows: 10 },
      ctx,
    ),
  );
  assert.equal(rowsOf(capped).length, 10);
  assert.equal(capped.truncated, true);

  const roomy = body(
    await tool('facebook_page_insights').handler(
      { metrics: ['page_media_view'], max_rows: 30 },
      ctx,
    ),
  );
  assert.equal(rowsOf(roomy).length, 30);
  assert.equal(roomy.truncated, false);
  assert.equal(noteMatching(roomy, /Row cap reached/), undefined);
});

// ---------------------------------------------------------------------------
// Metric rename handling (CC-INS-1) and valid-vs-invalid metrics
// ---------------------------------------------------------------------------

test('page_insights drops a renamed metric and answers with the replacement name', async () => {
  const { fb, ctx } = makeCtx();
  serve(fb, series('page_media_view', 'day', days(2, 4)));

  const parsed = body(
    await tool('facebook_page_insights').handler(
      { metrics: ['page_impressions', 'page_media_view'] },
      ctx,
    ),
  );

  assert.equal(
    lastJson(fb).params?.metric,
    'page_media_view',
    'the dead name never reaches Graph — it would fail the whole call',
  );
  assert.deepEqual(parsed.queriedMetrics, ['page_media_view']);
  assert.deepEqual(parsed.deprecatedMetrics, [
    {
      metric: 'page_impressions',
      status: 'renamed',
      replacement: 'page_media_view',
      suggestion:
        '"page_impressions" was renamed — use "page_media_view" instead. Removed in the 2025-11 Meta deprecation wave.',
    },
  ]);
  assert.ok(noteMatching(parsed, /Dropped 1 deprecated metric name/));
  assert.equal(rowsOf(parsed).length, 2, 'the live metric is still read');
});

test('page_insights answers a fully deprecated request without any Graph call', async () => {
  const { fb, ctx } = makeCtx();

  const parsed = body(
    await tool('facebook_page_insights').handler(
      { metrics: ['page_impressions', 'page_fans'] },
      ctx,
    ),
  );

  assert.equal(fb.calls.length, 0, 'nothing live to ask for, so nothing is asked');
  assert.deepEqual(parsed.queriedMetrics, []);
  assert.deepEqual(rowsOf(parsed), []);
  assert.equal(parsed.rowsAvailable, 0);
  assert.deepEqual(notesOf(parsed).length, 1);
  assert.match(notesOf(parsed)[0] ?? '', /No live metric name remained/);
  const replacements = (
    parsed.deprecatedMetrics as readonly { replacement?: string }[]
  ).map((verdict) => verdict.replacement);
  assert.deepEqual(replacements, ['page_media_view', 'page_follows']);
});

test('page_insights lower-cases and trims metric names before the table and Graph see them', async () => {
  const { fb, ctx } = makeCtx();
  serve(fb, series('page_media_view', 'day', days(1, 1)));

  const parsed = body(
    await tool('facebook_page_insights').handler(
      { metrics: ['  PAGE_Impressions ', ' Page_Media_View'] },
      ctx,
    ),
  );

  // Without normalization the rename table would miss and Graph would 400 on
  // both names; with it, one is renamed away and the other is queried cleanly.
  assert.equal(lastJson(fb).params?.metric, 'page_media_view');
  assert.equal(
    (parsed.deprecatedMetrics as readonly { metric?: string }[])[0]?.metric,
    'page_impressions',
  );
  assert.deepEqual(
    parsed.unavailableMetrics,
    [],
    'the echoed name matches what was sent',
  );
});

test('page_insights separates a valid-but-empty metric from a name Graph does not know', async () => {
  const { fb, ctx } = makeCtx();
  serve(
    fb,
    series('page_media_view', 'day', days(2, 7)),
    // Graph accepted this one and answered with no data points at all.
    series('page_daily_follows', 'day', []),
    // `page_views_total` is simply absent from the response.
  );

  const parsed = body(
    await tool('facebook_page_insights').handler(
      { metrics: ['page_media_view', 'page_daily_follows', 'page_views_total'] },
      ctx,
    ),
  );

  assert.deepEqual(parsed.emptyMetrics, ['page_daily_follows']);
  assert.deepEqual(parsed.unavailableMetrics, ['page_views_total']);
  const emptyNote = noteMatching(parsed, /^Valid but empty/);
  assert.ok(emptyNote, 'the valid-but-no-data case is called out');
  assert.match(emptyNote, /page_daily_follows/);
  const invalidNote = noteMatching(parsed, /^Graph returned no entry/);
  assert.ok(invalidNote, 'the unknown-name case is a different note');
  assert.match(invalidNote, /page_views_total/);
  assert.match(invalidNote, /different from a valid metric with no data/);
});

// ---------------------------------------------------------------------------
// Honesty notes (CC-INS-2, CC-INS-3, CC-INS-6)
// ---------------------------------------------------------------------------

test('page_insights explains an all-empty Page result with the eligibility floor', async () => {
  const { fb, ctx } = makeCtx();
  serve(fb, series('page_media_view', 'day', []));

  const parsed = body(
    await tool('facebook_page_insights').handler({ metrics: ['page_media_view'] }, ctx),
  );

  const note = noteMatching(parsed, /eligibility floor/);
  assert.ok(note, 'an empty Page series is explained, not reported as zero engagement');
  assert.match(note, /fewer than 100 likes\/followers/);
  assert.match(note, /read_insights/);
  assert.match(note, /ANALYZE/);
  assert.deepEqual(rowsOf(parsed), [], 'no invented zero rows');
});

test('page_insights states the freshness caveat only while the window can still move', async () => {
  const { fb, ctx } = makeCtx();
  serve(fb, series('page_media_view', 'day', days(3, 1)));

  const open = body(
    await tool('facebook_page_insights').handler({ metrics: ['page_media_view'] }, ctx),
  );
  assert.ok(
    noteMatching(open, /not computed yet/),
    'an open-ended window reaches today and may still lag',
  );

  fb.reset();
  fb.on(
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
  const settled = body(
    await tool('facebook_page_insights').handler(
      { metrics: ['page_media_view'], since: '2026-07-01', until: '2026-07-10' },
      ctx,
    ),
  );
  assert.equal(
    noteMatching(settled, /not computed yet/),
    undefined,
    'a window that ended before today is already settled',
  );
  // The period-boundary note is unconditional: `date` is Graph's exclusive end boundary.
  assert.ok(noteMatching(settled, /EXCLUSIVE end boundary/));
});

test('page_insights measures a lone `since` against the INJECTED clock, not the wall clock', async () => {
  const { fb, ctx } = makeCtx({ nowMs: NOW });
  serve(fb, series('page_media_view', 'day', days(3, 1)));

  const parsed = body(
    await tool('facebook_page_insights').handler(
      { metrics: ['page_media_view'], since: '2026-07-18' },
      ctx,
    ),
  );
  // With an omitted until, the injected clock supplies today's exclusive boundary:
  // [2026-07-18, 2026-07-20) = 2 daily buckets.
  assert.deepEqual(parsed.window, { since: '2026-07-18', days: 2 });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

test('page_insights rejects an over-wide window before issuing any request', async () => {
  const { fb, ctx } = makeCtx();

  await rejects(
    tool('facebook_page_insights').handler(
      { metrics: ['page_media_view'], since: '2026-01-01', until: '2026-07-01' },
      ctx,
    ),
    new RegExp(`Window too wide.*${String(INSIGHTS_MAX_WINDOW_DAYS)} days`, 's'),
  );
  assert.equal(fb.calls.length, 0, 'the ceiling is enforced client-side');
});

test('page_insights surfaces a malformed date as one actionable validation error', async () => {
  const { fb, ctx } = makeCtx();

  await rejects(
    tool('facebook_page_insights').handler(
      { metrics: ['page_media_view'], since: '01/07/2026' },
      ctx,
    ),
    /Invalid `since`.*YYYY-MM-DD/s,
  );
  await rejects(
    tool('facebook_page_insights').handler(
      { metrics: ['page_media_view'], since: '2026-07-10', until: '2026-07-01' },
      ctx,
    ),
    /is after/,
  );
  assert.equal(fb.calls.length, 0);
});

test('page_insights propagates an enriched Graph metric rejection', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    () => true,
    fbErr(
      new GraphApiError('(#100) metric[0] must be one of the following values', {
        code: 100,
        httpStatus: 400,
      }),
    ),
  );

  await rejects(
    tool('facebook_page_insights').handler(
      { metrics: ['page_fans', 'page_vieuws_total'] },
      ctx,
    ),
    /NO metric was read.*one metric at a time.*Known-dead names.*page_follows/s,
  );
  assert.equal(
    lastJson(fb).params?.metric,
    'page_vieuws_total',
    'the dead name was still dropped; Graph objected to the typo',
  );
});

test('page_insights lets a non-metric Graph error through unchanged', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    () => true,
    fbErr(
      new GraphApiError('(#190) Error validating access token', {
        code: 190,
        httpStatus: 401,
      }),
    ),
  );

  await rejects(
    tool('facebook_page_insights').handler({ metrics: ['page_media_view'] }, ctx),
    /^\(#190\) Error validating access token$/,
  );
});

test('page_insights propagates a page-resolution failure instead of guessing a Page', async () => {
  const { fb, ctx } = makeCtx();

  await rejects(
    tool('facebook_page_insights').handler(
      { profile: 'nope', metrics: ['page_media_view'] },
      ctx,
    ),
    /no page configured for profile "nope"/,
  );
  assert.equal(fb.calls.length, 0);
});

// ---------------------------------------------------------------------------
// facebook_post_insights
// ---------------------------------------------------------------------------

test('post_insights reads the post edge with the Page token and defaults to lifetime', async () => {
  const { fb, ctx, pages } = makeCtx();
  serve(fb, series('post_media_view', 'lifetime', [[end('2026-07-19'), 4210]]));

  const parsed = body(
    await tool('facebook_post_insights').handler(
      { post_id: POST_ID, metrics: ['post_media_view'] },
      ctx,
    ),
  );

  assert.deepEqual(pages.resolveCalls, [undefined]);
  const req = lastJson(fb);
  assert.equal(req.path, `/${POST_ID}/insights`);
  assert.equal(req.token, PAGE_TOKEN, 'a post is read with its Page token');
  assert.deepEqual({ ...req.params }, { metric: 'post_media_view', period: 'lifetime' });

  assert.equal(parsed.postId, POST_ID);
  assert.equal(parsed.pageId, PAGE_ID, 'the Page whose token authorized the read');
  assert.equal(parsed.profile, null);
  assert.equal(parsed.period, 'lifetime');
  assert.deepEqual(rowsOf(parsed), [
    { metric: 'post_media_view', date: '2026-07-19', value: 4210 },
  ]);
});

test('post_insights honours an explicit profile and an explicit period', async () => {
  const pages = createFakePageResolver({
    default: { pageId: PAGE_ID, name: 'Default', token: 'EAA-DEF' },
    pages: { 'brand-a': { pageId: '200', name: 'Brand A', token: 'EAA-BRAND' } },
  });
  const { fb, ctx } = makeCtx({ pages });
  serve(fb, series('post_video_views', 'day', [[end('2026-07-19'), 12]]));

  const parsed = body(
    await tool('facebook_post_insights').handler(
      {
        profile: 'brand-a',
        post_id: '200_777',
        metrics: ['post_video_views'],
        period: 'day',
      },
      ctx,
    ),
  );

  assert.deepEqual(pages.resolveCalls, ['brand-a']);
  assert.equal(lastJson(fb).token, 'EAA-BRAND');
  assert.equal(lastJson(fb).path, '/200_777/insights');
  assert.equal(lastJson(fb).params?.period, 'day');
  assert.equal(parsed.pageId, '200');
  assert.equal(parsed.postId, '200_777');
});

test('post_insights refuses a permalink URL as a post ID with an actionable message', async () => {
  const { fb, ctx } = makeCtx();

  await rejects(
    tool('facebook_post_insights').handler(
      {
        post_id: 'https://www.facebook.com/brand/posts/999',
        metrics: ['post_media_view'],
      },
      ctx,
    ),
    /not a URL, a permalink or a query string/,
  );
  await rejects(
    tool('facebook_post_insights').handler(
      { post_id: '111 999', metrics: ['post_media_view'] },
      ctx,
    ),
    /not a URL, a permalink or a query string/,
  );
  assert.equal(fb.calls.length, 0, 'a malformed ID never reaches Graph');
});

test('post_insights refuses a dot-segment post ID that would escape the API version', async () => {
  const { fb, ctx } = makeCtx();

  // `/v23.0/../insights` normalizes to `/insights` when the client assigns the
  // pathname, so ".." must never survive validation; "." would drop the segment.
  for (const postId of ['..', '.', '...']) {
    await rejects(
      tool('facebook_post_insights').handler(
        { post_id: postId, metrics: ['post_media_view'] },
        ctx,
      ),
      /not a URL, a permalink or a query string/,
    );
  }
  // A dot inside an otherwise ordinary ID stays legal — this is containment,
  // not a ban on the character.
  serve(fb, series('post_media_view', 'lifetime', [[end('2026-07-19'), 1]]));
  await tool('facebook_post_insights').handler(
    { post_id: '111.999', metrics: ['post_media_view'] },
    ctx,
  );
  assert.equal(lastJson(fb).path, '/111.999/insights');
  assert.equal(fb.calls.length, 1, 'only the legal ID reached Graph');
});

test('post_insights explains an empty post result as publish lag, or a Reel', async () => {
  const { fb, ctx } = makeCtx();
  serve(fb, series('post_media_view', 'lifetime', []));

  const parsed = body(
    await tool('facebook_post_insights').handler(
      { post_id: POST_ID, metrics: ['post_media_view'] },
      ctx,
    ),
  );

  const note = noteMatching(parsed, /just-published post/);
  assert.ok(note, 'an empty post series is explained rather than read as zero');
  assert.match(note, /video_insights/, 'Reels are named as living off this edge');
  assert.equal(
    noteMatching(parsed, /eligibility floor/),
    undefined,
    'the Page-only floor note must not leak onto a post',
  );
});

test('post_insights aggregate mode collapses a long series to totals', async () => {
  const { fb, ctx } = makeCtx();
  serve(fb, series('post_video_views', 'day', days(40, 3)));

  const parsed = body(
    await tool('facebook_post_insights').handler(
      { post_id: POST_ID, metrics: ['post_video_views'], aggregate: true },
      ctx,
    ),
  );

  assert.equal(parsed.mode, 'aggregate');
  assert.equal(Object.hasOwn(parsed, 'rows'), false);
  assert.deepEqual(
    summariesOf(parsed).map((m) => [m.metric, m.points, m.total]),
    [['post_video_views', 40, 120]],
  );
});

// ---------------------------------------------------------------------------
// facebook_reel_insights — the /video_insights edge (G-TOOL-2)
// ---------------------------------------------------------------------------

test('reel_insights reads /video_insights, not /insights', async () => {
  const { fb, ctx } = makeCtx();
  serve(fb, series('blue_reels_play_count', 'lifetime', [[end('2026-07-19'), 4200]]));

  const parsed = body(
    await tool('facebook_reel_insights').handler(
      { video_id: VIDEO_ID, metrics: ['blue_reels_play_count'] },
      ctx,
    ),
  );

  const req = lastJson(fb);
  assert.equal(req.path, `/${VIDEO_ID}/video_insights`);
  assert.equal(req.token, PAGE_TOKEN, 'the resolved Page token authorizes the read');
  assert.equal(parsed.videoId, VIDEO_ID, 'the object is echoed as a video, not a post');
  assert.equal(
    Object.hasOwn(parsed, 'postId'),
    false,
    'a Reel must never be reported under a post key',
  );
  assert.deepEqual(
    summariesOf(parsed).map((m) => [m.metric, m.aggregation, m.value, m.total]),
    [['blue_reels_play_count', 'single', 4200, undefined]],
  );
});

test('reel_insights defaults to the lifetime period, not a daily series', async () => {
  const { fb, ctx } = makeCtx();
  serve(fb, series('post_video_view_time', 'lifetime', [[end('2026-07-19'), 9]]));

  await tool('facebook_reel_insights').handler(
    { video_id: VIDEO_ID, metrics: ['post_video_view_time'] },
    ctx,
  );

  // `day` on this edge returns nothing at all, so the default is load-bearing.
  assert.equal(lastJson(fb).params?.period, 'lifetime');
});

test('reel_insights rejects a post ID before any Graph call', async () => {
  const { fb, ctx } = makeCtx();
  serve(fb, series('blue_reels_play_count', 'lifetime', []));

  await rejects(
    tool('facebook_reel_insights').handler(
      { video_id: POST_ID, metrics: ['blue_reels_play_count'] },
      ctx,
    ),
    /VIDEO id/,
  );
  assert.equal(fb.calls.length, 0, 'the composite ID never reached Graph');
});

test('reel_insights refuses every ID shape that could escape the path', async () => {
  const { fb, ctx } = makeCtx();
  serve(fb, series('blue_reels_play_count', 'lifetime', []));

  for (const videoId of ['..', '.', 'me/videos', '123?fields=id', 'v123', '12 34']) {
    await rejects(
      tool('facebook_reel_insights').handler(
        { video_id: videoId, metrics: ['blue_reels_play_count'] },
        ctx,
      ),
      /VIDEO id/,
    );
  }
  assert.equal(fb.calls.length, 0, 'nothing but a bare numeric ID is sent');
});

test('reel_insights explains an empty result by ID, publish state and lag', async () => {
  const { fb, ctx } = makeCtx();
  serve(fb, series('blue_reels_play_count', 'lifetime', []));

  const parsed = body(
    await tool('facebook_reel_insights').handler(
      { video_id: VIDEO_ID, metrics: ['blue_reels_play_count'] },
      ctx,
    ),
  );

  const note = noteMatching(parsed, /VIDEO id/);
  assert.ok(note, 'an empty Reel series is explained rather than read as zero plays');
  assert.match(note, /PUBLISHED/, 'a draft/scheduled Reel is named as a cause');
  assert.match(note, /lag minutes to hours/, 'the insights lag is named as a cause');
  assert.equal(
    noteMatching(parsed, /eligibility floor/),
    undefined,
    'the Page-only follower floor must not leak onto a Reel',
  );
  assert.equal(
    noteMatching(parsed, /just-published post/),
    undefined,
    'the post-only explanation must not leak onto a Reel',
  );
});

test('reel_insights points an unknown metric at the video vocabulary, not the doctor', async () => {
  const { fb, ctx } = makeCtx();
  serve(fb, series('blue_reels_play_count', 'lifetime', [[end('2026-07-19'), 7]]));

  const parsed = body(
    await tool('facebook_reel_insights').handler(
      { video_id: VIDEO_ID, metrics: ['blue_reels_play_count', 'page_media_view'] },
      ctx,
    ),
  );

  assert.deepEqual(parsed.unavailableMetrics, ['page_media_view']);
  const note = noteMatching(parsed, /no entry for/);
  assert.ok(note, 'the unavailable metric is reported');
  assert.match(note, /video_insights vocabulary/);
  assert.doesNotMatch(
    note,
    /run the doctor/,
    "the doctor probes /insights only, so it cannot answer a video metric's validity",
  );
});

test('reel_insights shares the reshape contract: rows, cap and aggregate mode', async () => {
  const { fb, ctx } = makeCtx();
  serve(fb, series('post_video_view_time', 'lifetime', days(40, 3)));

  const capped = body(
    await tool('facebook_reel_insights').handler(
      { video_id: VIDEO_ID, metrics: ['post_video_view_time'], max_rows: 5 },
      ctx,
    ),
  );
  assert.equal(rowsOf(capped).length, 5);
  assert.equal(capped.rowsAvailable, 40);
  assert.equal(capped.truncated, true);

  const totals = body(
    await tool('facebook_reel_insights').handler(
      { video_id: VIDEO_ID, metrics: ['post_video_view_time'], aggregate: true },
      ctx,
    ),
  );
  assert.equal(totals.mode, 'aggregate');
  assert.equal(Object.hasOwn(totals, 'rows'), false);
  assert.deepEqual(
    summariesOf(totals).map((m) => [m.metric, m.points, m.aggregation, m.value, m.total]),
    [['post_video_view_time', 40, 'latest', 3, undefined]],
  );
});

test('reel_insights description names the edge, the ID and the metric caveat', () => {
  const description = tool('facebook_reel_insights').description;
  assert.match(description, /video_insights/);
  assert.match(description, /VIDEO id/);
  assert.match(description, /facebook_create_reel/);
  // The metric list is a snapshot of Meta's reference, not a validated set —
  // saying otherwise would be the exact overclaim this server avoids.
  assert.match(description, /examples, not a whitelist/);
});
