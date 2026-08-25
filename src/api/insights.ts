// Page / Post Insights plumbing plus the insights RESHAPE CONTRACT (task V02,
// `api` layer — imports only from `core`).
//
// Why this module exists at all: Graph answers `/{id}/insights` with a deeply
// nested, boilerplate-heavy shape —
//
//   { data: [ { name, period, title, description, id,
//               values: [ { value, end_time }, ... ] } ] }
//
// A 90-day daily window over five metrics is ~450 value objects plus per-metric
// `title`/`description` prose: easily 10–30k characters, which the result
// shaper would then have to truncate MID-SERIES (doc 09 CC-INS-4, UX #11). So
// this module owns four things, all pure except the single GET:
//
//   1. RESHAPE — flatten to compact rows `{ metric, date, breakdown?, value }`
//      plus one summary row per metric (period, points, total). `title`,
//      `description` and `id` are dropped; `period` is carried once per metric
//      instead of once per data point. Days Graph omits stay omitted — no
//      gap-filling invention (CC-INS-3).
//   2. AGGREGATE mode — same summaries, no per-point rows: the headline numbers
//      only, for when a wide window would otherwise truncate (CC-INS-4).
//   3. ROW CAP — a hard, documented cap on emitted rows with an explicit
//      truncation note that says how many points were dropped and what to do
//      about it (never a silent short answer).
//   4. METRIC-RENAME HANDLING — an explicit, commented deprecation table.
//      Graph fails the WHOLE call when one metric name is dead, so known-dead
//      names are dropped from the request and reported with a "renamed to X" /
//      "removed on <wave>" suggestion (C6, CC-INS-1). A metric Graph accepts but
//      answers with no points ("valid, no data") is reported separately from a
//      metric Graph never mentions ("not valid for this object/version").
//
// Three scopes share all of that: a Page, a published post, and a Reel. The Reel
// scope (G-TOOL-2) is the reason `scope` exists as more than a note switch —
// Reels metrics are NOT on `/{id}/insights` at all, they live on
// `/{video-id}/video_insights`, keyed by the VIDEO id rather than a
// `{page-id}_{post-id}` composite. The envelope Graph answers with is the same,
// so reshape/cap/notes are shared and only the edge and the empty-series
// explanation differ.
//
// No pagination helper is used: `/insights` returns one entry per requested
// metric, not a cursor stream, so there is nothing to walk — and `paging.next`
// (token-bearing) is never read or followed.

import { GraphApiError, classifyGraphError } from '../core/index.js';
import type { FbRequestFn, ParamValue } from '../core/index.js';

// ---------------------------------------------------------------------------
// 1. Documented limits
// ---------------------------------------------------------------------------

/**
 * Hard cap on the number of per-point rows a single insights read emits. Sized
 * so a full result (rows + summaries + notes) stays well inside the default
 * ~25k `FB_MAX_RESULT_CHARS` budget, leaving the shaper's structure-aware
 * truncation as a backstop rather than the primary defense (CC-INS-4).
 */
export const INSIGHTS_MAX_ROWS = 250;

/** Longest `since`..`until` window Graph serves for Page insights (doc 03). */
export const INSIGHTS_MAX_WINDOW_DAYS = 90;

/** Follower/like floor below which a Page returns empty insights (CC-INS-2). */
export const PAGE_INSIGHTS_LIKES_FLOOR = 100;

/** `YYYY-MM-DD` — the only date form these tools accept for `since`/`until`. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Leading calendar date of a Graph `end_time` (`2026-07-01T07:00:00+0000`). */
const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})/;

const MS_PER_DAY = 86_400_000;

/** Deepest breakdown nesting flattened into `breakdown` paths before giving up. */
const MAX_BREAKDOWN_DEPTH = 3;

// ---------------------------------------------------------------------------
// 2. Model-facing honesty notes (CC-INS-2, CC-INS-3, CC-INS-5, CC-INS-6)
// ---------------------------------------------------------------------------

/** Insights lag: a same-day zero usually means "not computed yet" (CC-INS-6). */
export const FRESHNESS_NOTE =
  'Data freshness: Graph computes insights with a lag (minutes to hours, ' +
  'occasionally a full day). A zero or a missing point for today is normally ' +
  '"not computed yet", NOT "no engagement" — re-read later before concluding.';

/** Empty Page series are usually an eligibility floor, not an error (CC-INS-2). */
export const PAGE_ELIGIBILITY_NOTE = `Every requested metric came back empty. This is usually an eligibility floor, not an error: a Page with fewer than ${String(PAGE_INSIGHTS_LIKES_FLOOR)} likes/followers returns empty insights. Check fan_count/followers_count with facebook_get_page, and confirm the token carries read_insights plus the ANALYZE Page task.`;

/** Empty post series: publish lag, or the ID is a Reel (CC-INS-6, G-TOOL-2). */
export const POST_EMPTY_NOTE =
  'Every requested metric came back empty. On a just-published post that is ' +
  'normal — post insights lag minutes to hours. If the ID is a Reel, its ' +
  'metrics are NOT on this edge at all: they live on /{video-id}/video_insights, ' +
  'so re-read it with facebook_reel_insights and the VIDEO id.';

/**
 * Empty Reel series (G-TOOL-2). Two causes dominate and they need different
 * fixes, so both are named: the wrong ID (a post composite addresses a post,
 * never a video) and a Reel that is not PUBLISHED yet — a DRAFT or a SCHEDULED
 * Reel has no audience, so every play metric is legitimately zero.
 */
export const REEL_EMPTY_NOTE =
  'Every requested metric came back empty. Check three things before reading ' +
  'this as "no plays": the ID must be the VIDEO id (a "{page-id}_{post-id}" ' +
  'composite is a post and does not resolve on /video_insights); the Reel must ' +
  'be PUBLISHED (a DRAFT or SCHEDULED Reel has no audience yet); and Reel ' +
  'metrics lag minutes to hours after publishing, like every other insight.';

/**
 * The "everything came back empty" explanation, per scope. A total map rather
 * than a ternary: adding a scope without deciding what an empty result MEANS
 * there is the exact mistake that turns a silent zero into "no engagement".
 */
const EMPTY_SCOPE_NOTE: Readonly<Record<InsightsScope, string>> = {
  page: PAGE_ELIGIBILITY_NOTE,
  post: POST_EMPTY_NOTE,
  reel: REEL_EMPTY_NOTE,
};

/**
 * CC-AUTH-2 on the insights path: `/insights` answers a call made with a USER
 * token exactly the way it answers a Page with nothing to report — an empty
 * series, no error. Attached to an all-empty result so the ambiguity is stated
 * rather than read as "engagement really was zero".
 *
 * Like {@link EMPTY_PAGE_TOKEN_HINT} in the comments module this ANNOTATES and
 * does not refuse: with the C1 per-page resolver a base USER token is the
 * supported configuration (the Page token is derived from it per call), so the
 * configured token type is not grounds to refuse the read up front.
 */
export const INSIGHTS_TOKEN_EMPTY_HINT =
  'An empty series is also what Graph returns when the read ran with a USER ' +
  "token instead of this Page's Page token — it does not error. Run " +
  'facebook_whoami to confirm a Page token is available for this Page before ' +
  'concluding the numbers are genuinely zero.';

/** Period boundaries are Page-timezone based; end_time is the END of the period. */
export const PERIOD_BOUNDARY_NOTE =
  "`date` is the calendar date of Graph's `end_time`, i.e. the END of the " +
  'period the value covers, in the Page timezone — so the current day is a ' +
  'partial bucket. Days with no data are absent; nothing is zero-filled.';

function truncationNote(kept: number, dropped: number): string {
  return `Row cap reached: kept the first ${String(kept)} of ${String(kept + dropped)} data points and dropped ${String(dropped)}. Re-run with aggregate:true for per-metric totals, or narrow the window (since/until) or the metric list.`;
}

function droppedMetricsNote(count: number): string {
  return `Dropped ${String(count)} deprecated metric name(s) from the request — Graph fails the whole call when a single metric name is invalid. See deprecatedMetrics for the replacement names, then re-run with those.`;
}

function unavailableNote(metrics: readonly string[], scope: InsightsScope): string {
  // The doctor's metric probe speaks the `/insights` edge only, so pointing a
  // Reel read at it would be advice that cannot work — say what does instead.
  const probe =
    scope === 'reel'
      ? 'Metric names are version-dependent, and the /video_insights vocabulary is its own — page/post metric names do not transfer. Request one name at a time to find which ones this video answers.'
      : 'Metric names are version-dependent; run the doctor to probe which names this Page answers.';
  return `Graph returned no entry for: ${metrics.join(', ')}. An absent entry means the name is not valid for this object or for the pinned Graph API version — that is different from a valid metric with no data (see emptyMetrics). ${probe}`;
}

const ALL_METRICS_DEPRECATED_NOTE =
  'No live metric name remained after dropping deprecated ones, so nothing was ' +
  'queried. Re-run with the replacement names listed in deprecatedMetrics.';

const EMPTY_METRICS_NOTE_PREFIX =
  'Valid but empty (Graph accepted the metric and returned no data points): ';

// ---------------------------------------------------------------------------
// 3. Metric rename / deprecation table (C6, CC-INS-1)
// ---------------------------------------------------------------------------

/**
 * One dead metric name and what to do instead. A STATIC best-effort snapshot of
 * Meta's deprecation waves, deliberately not a whitelist: names Meta still
 * serves are passed through untouched (doc 03 — "do not hardcode a strict
 * metric whitelist"). Validity is also version-dependent, so `deprecatedAbove`
 * records the Graph version the reference marks the name dead above.
 */
export interface DeprecatedMetric {
  /** The dead metric name, lower-case. */
  readonly metric: string;
  /** Direct replacement, when Meta shipped one. Absent ⇒ removed outright. */
  readonly replacement?: string;
  /** The deprecation wave that removed it (wave date, per doc 03). */
  readonly removedOn?: string;
  /** Graph version the reference marks the name deprecated above. */
  readonly deprecatedAbove?: string;
  /** Extra guidance when there is no drop-in replacement. */
  readonly hint?: string;
}

/**
 * The rename/deprecation table. Three waves matter (doc 03 "Insights (heavily
 * changed 2024–2026)"):
 *
 *   * 2024-09 — the FANS family became the FOLLOWS family.
 *   * 2025-11 — the IMPRESSIONS family became the MEDIA-VIEW family and the
 *     organic/paid/viral splits went away with it.
 *   * 2026-06-15 — the remaining UNIQUE variants were removed, and the wave hit
 *     the video-views family too, some names with no replacement at all.
 *
 * Training data is full of the pre-wave names, which is exactly why an explicit
 * table beats "pass it through and let Graph 400".
 */
const DEPRECATIONS: readonly DeprecatedMetric[] = [
  // --- 2024-09: fans -> follows -------------------------------------------
  { metric: 'page_fans', replacement: 'page_follows', removedOn: '2024-09' },
  { metric: 'page_fan_adds', replacement: 'page_daily_follows', removedOn: '2024-09' },
  {
    metric: 'page_fan_adds_unique',
    replacement: 'page_daily_follows_unique',
    removedOn: '2024-09',
  },
  {
    metric: 'page_fan_removes',
    replacement: 'page_daily_unfollows',
    removedOn: '2024-09',
  },
  {
    metric: 'page_fan_removes_unique',
    replacement: 'page_daily_unfollows_unique',
    removedOn: '2024-09',
  },
  {
    metric: 'page_engaged_users',
    replacement: 'page_post_engagements',
    removedOn: '2024-09',
  },
  {
    metric: 'page_consumptions',
    removedOn: '2024-09',
    hint: 'Closest surviving signal: "page_post_engagements" (engagement count, not click consumptions).',
  },
  {
    metric: 'page_consumptions_unique',
    removedOn: '2024-09',
    hint: 'Closest surviving signal: "page_post_engagements"; there is no deduplicated variant.',
  },

  // --- 2025-11: impressions -> media view (splits removed with it) --------
  { metric: 'page_impressions', replacement: 'page_media_view', removedOn: '2025-11' },
  {
    metric: 'page_impressions_organic',
    removedOn: '2025-11',
    hint: 'The organic/paid split is gone; use "page_media_view" for the combined figure.',
  },
  {
    metric: 'page_impressions_paid',
    removedOn: '2025-11',
    hint: 'The organic/paid split is gone; paid delivery now lives in the ads insights surface.',
  },
  { metric: 'post_impressions', replacement: 'post_media_view', removedOn: '2025-11' },
  {
    metric: 'post_impressions_organic',
    removedOn: '2025-11',
    hint: 'The organic/paid/viral split is gone; use "post_media_view".',
  },
  {
    metric: 'post_impressions_paid',
    removedOn: '2025-11',
    hint: 'The organic/paid/viral split is gone; use "post_media_view".',
  },
  {
    metric: 'post_impressions_viral',
    removedOn: '2025-11',
    hint: 'The organic/paid/viral split is gone; use "post_media_view".',
  },

  // --- 2026-06-15: unique variants + the video-views family ---------------
  {
    metric: 'page_impressions_unique',
    removedOn: '2026-06-15',
    deprecatedAbove: 'v25.0',
    hint: 'No deduplicated replacement shipped; "page_media_view" is the closest figure (not unique).',
  },
  {
    metric: 'post_impressions_unique',
    removedOn: '2026-06-15',
    deprecatedAbove: 'v25.0',
    hint: 'No deduplicated replacement shipped; "post_media_view" is the closest figure (not unique).',
  },
  {
    metric: 'page_video_views_unique',
    removedOn: '2026-06-15',
    hint: 'Use "page_video_views" (not deduplicated); no unique variant survived the wave.',
  },
  {
    metric: 'post_video_views_unique',
    removedOn: '2026-06-15',
    hint: 'Use "post_video_views" (not deduplicated); no unique variant survived the wave.',
  },
  {
    metric: 'post_video_views_organic_unique',
    removedOn: '2026-06-15',
    hint: 'Neither the unique variant nor the organic/paid split survived; use "post_video_views".',
  },
  {
    metric: 'post_video_views_paid_unique',
    removedOn: '2026-06-15',
    hint: 'Neither the unique variant nor the organic/paid split survived; use "post_video_views".',
  },
];

const DEPRECATION_INDEX: ReadonlyMap<string, DeprecatedMetric> = new Map(
  DEPRECATIONS.map((entry) => [entry.metric, entry]),
);

/** How a requested metric name looks against the deprecation table. */
export type MetricStatus =
  /** Not in the table ⇒ passed through to Graph. NOT a validity guarantee. */
  | 'ok'
  /** Dead, with a documented replacement name. */
  | 'renamed'
  /** Dead, with no drop-in replacement. */
  | 'removed';

/** The table's verdict on one requested metric name. */
export interface MetricVerdict {
  readonly metric: string;
  readonly status: MetricStatus;
  /** Present only for `renamed`. */
  readonly replacement?: string;
  /** Actionable sentence for the model; present for `renamed` and `removed`. */
  readonly suggestion?: string;
}

function suggestionFor(entry: DeprecatedMetric): string {
  const parts: string[] = [
    entry.replacement !== undefined
      ? `"${entry.metric}" was renamed — use "${entry.replacement}" instead.`
      : `"${entry.metric}" was removed with no drop-in replacement.`,
  ];
  if (entry.removedOn !== undefined) {
    parts.push(`Removed in the ${entry.removedOn} Meta deprecation wave.`);
  }
  if (entry.deprecatedAbove !== undefined) {
    parts.push(`Meta's reference marks it deprecated above ${entry.deprecatedAbove}.`);
  }
  if (entry.hint !== undefined) parts.push(entry.hint);
  return parts.join(' ');
}

/**
 * The form of a metric name Graph itself speaks: every insights metric is
 * lower-case snake_case, and Graph echoes that canonical spelling back in each
 * entry's `name`. Requested names are matched against the deprecation table and
 * against Graph's reply in this form, so a caller who writes `Post_Impressions`
 * is answered about `post_impressions` rather than told their name is unknown.
 */
export function canonicalMetricName(metric: string): string {
  return metric.trim().toLowerCase();
}

/**
 * Look one metric name up in the deprecation table. Case- and space-insensitive.
 * An unknown name is `ok` — the table is a rename ORACLE, never a whitelist, so
 * names Meta added after this snapshot still reach Graph unchanged (doc 03).
 *
 * `metric` echoes the caller's spelling verbatim, because the suggestion text is
 * read by whoever typed it. Anything that has to MATCH — the outgoing request,
 * the comparison against Graph's reply — must use {@link canonicalMetricName}.
 */
export function classifyMetric(metric: string): MetricVerdict {
  const entry = DEPRECATION_INDEX.get(canonicalMetricName(metric));
  if (entry === undefined) return { metric, status: 'ok' };
  return {
    metric,
    status: entry.replacement !== undefined ? 'renamed' : 'removed',
    ...(entry.replacement !== undefined ? { replacement: entry.replacement } : {}),
    suggestion: suggestionFor(entry),
  };
}

/** Classify a whole requested metric list, preserving order. */
export function classifyMetrics(metrics: readonly string[]): readonly MetricVerdict[] {
  return metrics.map((metric) => classifyMetric(metric));
}

// ---------------------------------------------------------------------------
// 4. The reshaped row / summary shapes
// ---------------------------------------------------------------------------

/**
 * One flattened data point. `period` deliberately does NOT repeat here — it is
 * uniform per metric and lives on {@link MetricSummary}, which keeps a 250-row
 * result thousands of characters smaller.
 */
export interface InsightRow {
  readonly metric: string;
  /** Calendar date of Graph's `end_time` (period END, Page timezone). */
  readonly date?: string;
  /** Breakdown key path (`by_action_type` maps, `/`-joined when nested). */
  readonly breakdown?: string;
  readonly value: number | string;
}

/** Per-metric header: the boilerplate Graph repeats per point, carried once. */
export interface MetricSummary {
  readonly metric: string;
  /** Graph's echoed period (`day`, `week`, `days_28`, `lifetime`, ...). */
  readonly period: string;
  /** Number of flattened data points Graph returned for this metric. */
  readonly points: number;
  /** Sum of the numeric points (across breakdown keys). Absent ⇒ none numeric. */
  readonly total?: number;
  /** Raw `end_time` of the first/last point — the exact boundary, kept once. */
  readonly firstEnd?: string;
  readonly lastEnd?: string;
  /** Distinct breakdown keys seen; absent ⇒ a plain scalar series. */
  readonly breakdowns?: number;
  /** True when at least one point was not numeric (excluded from `total`). */
  readonly nonNumeric?: boolean;
}

/** Output of the pure reshape step. */
export interface ReshapedInsights {
  readonly rows: readonly InsightRow[];
  readonly metrics: readonly MetricSummary[];
}

// ---------------------------------------------------------------------------
// 5. The pure reshape
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Calendar-date prefix of an `end_time`; the raw string when it is not a date. */
function endDate(endTime: string): string {
  return DATE_PREFIX.exec(endTime)?.[1] ?? endTime;
}

interface FlatValue {
  readonly breakdown?: string;
  readonly value: number | string;
}

function flatValue(path: readonly string[], value: number | string): FlatValue {
  return path.length === 0 ? { value } : { breakdown: path.join('/'), value };
}

/**
 * Flatten one `values[].value` into scalar leaves. Graph uses three shapes:
 * a bare number, a breakdown MAP (`{like: 5, love: 2}`), and occasionally a
 * nested map. Non-numeric leaves are kept as strings (never dropped silently)
 * and excluded from totals; `null`/`undefined` leaves are absent days and yield
 * no row (CC-INS-3). Nesting deeper than {@link MAX_BREAKDOWN_DEPTH} collapses
 * to an explicit placeholder rather than exploding the row count.
 */
function flattenValue(
  raw: unknown,
  path: readonly string[],
  depth: number,
  out: FlatValue[],
): void {
  if (raw === null || raw === undefined) return;
  if (typeof raw === 'number') {
    if (Number.isFinite(raw)) out.push(flatValue(path, raw));
    return;
  }
  if (typeof raw === 'string' || typeof raw === 'boolean') {
    out.push(flatValue(path, String(raw)));
    return;
  }
  if (!isRecord(raw)) return;
  if (depth >= MAX_BREAKDOWN_DEPTH) {
    out.push(flatValue(path, '[nested breakdown omitted]'));
    return;
  }
  const entries = Array.isArray(raw)
    ? raw.map((item, index) => [String(index), item] as const)
    : Object.entries(raw);
  for (const [key, nested] of entries) {
    flattenValue(nested, [...path, key], depth + 1, out);
  }
}

interface RawValuePoint {
  readonly value?: unknown;
  readonly end_time?: unknown;
}

function summarize(
  metric: string,
  period: string,
  rows: readonly InsightRow[],
  ends: readonly string[],
  nonNumeric: boolean,
): MetricSummary {
  let total: number | undefined;
  for (const row of rows) {
    if (typeof row.value === 'number') total = (total ?? 0) + row.value;
  }
  const breakdowns = new Set(
    rows.filter((r) => r.breakdown !== undefined).map((r) => r.breakdown),
  ).size;
  const first = ends[0];
  const last = ends[ends.length - 1];
  return {
    metric,
    period,
    points: rows.length,
    ...(total !== undefined ? { total } : {}),
    ...(first !== undefined ? { firstEnd: first } : {}),
    ...(last !== undefined ? { lastEnd: last } : {}),
    ...(breakdowns > 0 ? { breakdowns } : {}),
    ...(nonNumeric ? { nonNumeric: true } : {}),
  };
}

/**
 * Reshape a raw Graph insights body into flat rows plus one summary per metric.
 * Pure and defensive: any field may be absent or the wrong type (CC-NET-2), a
 * missing `data` array yields an empty reshape, and `title`/`description`/`id`
 * boilerplate is dropped on the floor.
 */
export function reshapeInsights(body: unknown): ReshapedInsights {
  const rawData: unknown = isRecord(body) ? body.data : undefined;
  const entries: readonly unknown[] = Array.isArray(rawData) ? rawData : [];

  const rows: InsightRow[] = [];
  const metrics: MetricSummary[] = [];

  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const name = typeof entry.name === 'string' ? entry.name : undefined;
    if (name === undefined) continue;
    const period = typeof entry.period === 'string' ? entry.period : 'unknown';
    const points: readonly unknown[] = Array.isArray(entry.values) ? entry.values : [];

    const metricRows: InsightRow[] = [];
    const ends: string[] = [];
    let nonNumeric = false;

    for (const point of points) {
      if (!isRecord(point)) continue;
      const typed = point as RawValuePoint;
      const endTime = typeof typed.end_time === 'string' ? typed.end_time : undefined;
      const flattened: FlatValue[] = [];
      flattenValue(typed.value, [], 0, flattened);
      if (flattened.length > 0 && endTime !== undefined) ends.push(endTime);
      for (const flat of flattened) {
        if (typeof flat.value !== 'number') nonNumeric = true;
        metricRows.push({
          metric: name,
          ...(endTime !== undefined ? { date: endDate(endTime) } : {}),
          ...(flat.breakdown !== undefined ? { breakdown: flat.breakdown } : {}),
          value: flat.value,
        });
      }
    }

    for (const row of metricRows) rows.push(row);
    metrics.push(summarize(name, period, metricRows, ends, nonNumeric));
  }

  return { rows, metrics };
}

/** Row-cap outcome: the kept prefix plus how many points were dropped. */
export interface CappedRows {
  readonly rows: readonly InsightRow[];
  readonly dropped: number;
  readonly truncated: boolean;
}

/**
 * Apply the row cap, keeping the FIRST rows (chronological, matching the
 * pagination contract's "truncation keeps the first items" rule).
 */
export function capRows(rows: readonly InsightRow[], maxRows: number): CappedRows {
  const cap = Number.isFinite(maxRows) && maxRows > 0 ? Math.floor(maxRows) : 1;
  if (rows.length <= cap) return { rows, dropped: 0, truncated: false };
  return { rows: rows.slice(0, cap), dropped: rows.length - cap, truncated: true };
}

// ---------------------------------------------------------------------------
// 6. Window validation (90-day cap, CC-INS-5)
// ---------------------------------------------------------------------------

/** The validated query window echoed back to the caller. */
export interface InsightsWindow {
  readonly since?: string;
  readonly until?: string;
  /** Inclusive span in days, when both ends are known (`until` defaults to today). */
  readonly days?: number;
}

/** A client-side parameter error, classified through the F06 matrix (code 100). */
function validationError(message: string): GraphApiError {
  return new GraphApiError(message, {
    code: 100,
    httpStatus: 400,
    action: classifyGraphError({ code: 100, message }),
  });
}

function parseDate(label: string, value: string): number {
  if (!DATE_ONLY.test(value)) {
    throw validationError(
      `Invalid \`${label}\`: "${value}". Use a calendar date in YYYY-MM-DD form.`,
    );
  }
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) {
    throw validationError(`Invalid \`${label}\`: "${value}" is not a real date.`);
  }
  return ms;
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Validate `since`/`until` and compute the span. Enforces the documented
 * {@link INSIGHTS_MAX_WINDOW_DAYS} ceiling client-side so an over-wide query
 * fails with an actionable message instead of a Graph 400 (or, worse, a
 * silently clipped series). A lone `since` is measured against today.
 *
 * @throws GraphApiError (validation) on a malformed date, a reversed window, or
 *   a span over the ceiling.
 */
export function checkWindow(input: {
  readonly since?: string;
  readonly until?: string;
  readonly nowMs: number;
  readonly maxDays?: number;
}): InsightsWindow {
  const maxDays = input.maxDays ?? INSIGHTS_MAX_WINDOW_DAYS;
  const sinceMs = input.since !== undefined ? parseDate('since', input.since) : undefined;
  const untilMs = input.until !== undefined ? parseDate('until', input.until) : undefined;

  let days: number | undefined;
  if (sinceMs !== undefined) {
    const endMs = untilMs ?? parseDate('until', utcDate(input.nowMs));
    if (endMs < sinceMs) {
      throw validationError(
        `Invalid window: \`since\` (${String(input.since)}) is after \`until\` (${String(input.until ?? utcDate(input.nowMs))}).`,
      );
    }
    days = Math.round((endMs - sinceMs) / MS_PER_DAY) + 1;
    if (days > maxDays) {
      throw validationError(
        `Window too wide: ${String(days)} days requested but Graph serves at most ${String(maxDays)} days of insights per query (2-year retention overall). Narrow since/until, or read the window in ${String(maxDays)}-day slices.`,
      );
    }
  }

  return {
    ...(input.since !== undefined ? { since: input.since } : {}),
    ...(input.until !== undefined ? { until: input.until } : {}),
    ...(days !== undefined ? { days } : {}),
  };
}

// ---------------------------------------------------------------------------
// 7. The Graph read
// ---------------------------------------------------------------------------

/**
 * Which object the insights edge hangs off. This picks the EDGE as well as the
 * honesty notes: `reel` reads `/video_insights`, the other two read `/insights`.
 */
export type InsightsScope = 'page' | 'post' | 'reel';

/** Everything one insights read needs. `nowMs` keeps freshness logic testable. */
export interface InsightsRequest {
  readonly scope: InsightsScope;
  /** Page ID, post ID (`{page-id}_{post-id}`) or — for `reel` — the video ID. */
  readonly objectId: string;
  /** Requested metric names, in the caller's order. */
  readonly metrics: readonly string[];
  readonly period?: string;
  readonly since?: string;
  readonly until?: string;
  /** True ⇒ per-metric totals only, no per-point rows (CC-INS-4). */
  readonly aggregate?: boolean;
  /** Row-cap override; defaults to {@link INSIGHTS_MAX_ROWS}. */
  readonly maxRows?: number;
  /** Page access token (always pass the resolved Page token — C1). */
  readonly token?: string;
  readonly signal?: AbortSignal;
  /** Wall clock used for the freshness note and a lone-`since` window span. */
  readonly nowMs: number;
}

/** The reshaped, capped, annotated result a tool hands to the shaper. */
export interface InsightsResult {
  readonly mode: 'series' | 'aggregate';
  /** The period actually requested (Graph's echoed period is per metric). */
  readonly period: string;
  readonly window?: InsightsWindow;
  /** Metric names actually sent to Graph (deprecated names removed). */
  readonly queriedMetrics: readonly string[];
  readonly metrics: readonly MetricSummary[];
  /** Per-point rows; absent in `aggregate` mode. */
  readonly rows?: readonly InsightRow[];
  /** Data points Graph returned, before the row cap. */
  readonly rowsAvailable: number;
  readonly truncated: boolean;
  /** Requested names that are dead, each with a replacement suggestion. */
  readonly deprecatedMetrics: readonly MetricVerdict[];
  /** Sent but never mentioned in the response ⇒ invalid for this object/version. */
  readonly unavailableMetrics: readonly string[];
  /** Accepted by Graph with zero data points ⇒ valid, no data. */
  readonly emptyMetrics: readonly string[];
  readonly notes: readonly string[];
}

/**
 * Default period per scope: a daily series for a Page, lifetime totals for a
 * post or a Reel. `/video_insights` in particular is a lifetime edge — plays and
 * watch time are cumulative counters, not a series — so `day` there returns
 * nothing at all, which is precisely the silent-empty failure this module exists
 * to prevent.
 */
function defaultPeriod(scope: InsightsScope): string {
  return scope === 'page' ? 'day' : 'lifetime';
}

/**
 * The Graph edge each scope reads. Reels metrics are not a subset of the post
 * edge: they are a different edge on a different object (G-TOOL-2).
 */
function insightsEdge(scope: InsightsScope): string {
  return scope === 'reel' ? 'video_insights' : 'insights';
}

/**
 * Re-throw a Graph metric-validation failure with the table's suggestions
 * attached. Graph's own text ("metric[0] must be one of the following values")
 * lists hundreds of names — useless to a model — so the enriched message names
 * the dead metrics we recognize and how to isolate the rest. The
 * {@link GraphApiError} identity, codes and action are preserved so the server's
 * error mapping is unchanged.
 *
 * `metrics` is the caller's ORIGINAL list, not the live subset that was sent:
 * when a request mixed a dead name with an unknown-but-invalid one, naming the
 * rename is the most useful thing we can say about the rejection.
 */
function enrichMetricError(err: unknown, metrics: readonly string[]): unknown {
  if (!(err instanceof GraphApiError)) return err;
  const looksMetricRelated =
    (err.code === 100 || err.code === 3001) && /metric/i.test(err.message);
  if (!looksMetricRelated) return err;

  const suggestions = classifyMetrics(metrics)
    .filter((verdict) => verdict.suggestion !== undefined)
    .map((verdict) => verdict.suggestion);
  const tail =
    suggestions.length > 0
      ? ` Known-dead names in this request: ${suggestions.join(' ')}`
      : ' None of the requested names appears in the rename table of this server, so the invalid one is either a typo or unsupported by the pinned Graph API version.';
  return new GraphApiError(
    `${err.message} Graph rejected the metric list, so NO metric was read. Request one metric at a time to isolate the invalid name.${tail}`,
    {
      code: err.code,
      ...(err.subcode !== undefined ? { subcode: err.subcode } : {}),
      ...(err.type !== undefined ? { type: err.type } : {}),
      ...(err.fbtraceId !== undefined ? { fbtraceId: err.fbtraceId } : {}),
      httpStatus: err.httpStatus,
      ...(err.action !== undefined ? { action: err.action } : {}),
      cause: err,
    },
  );
}

async function requestInsights(
  fbRequest: FbRequestFn,
  req: InsightsRequest,
  metrics: readonly string[],
  period: string,
): Promise<unknown> {
  const params: Record<string, ParamValue> = { metric: metrics.join(','), period };
  if (req.since !== undefined) params.since = req.since;
  if (req.until !== undefined) params.until = req.until;
  try {
    const res = await fbRequest<unknown>({
      protocol: 'json',
      method: 'GET',
      host: 'graph',
      path: `/${req.objectId}/${insightsEdge(req.scope)}`,
      params,
      ...(req.token !== undefined ? { token: req.token } : {}),
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
    });
    return res.data;
  } catch (err) {
    throw enrichMetricError(err, req.metrics);
  }
}

/**
 * True when the freshness caveat is worth printing: nothing came back at all, a
 * point for today is present (partial bucket), or the window reaches today but
 * the tail is missing (Graph has not computed it yet) — CC-INS-6.
 */
function needsFreshnessNote(
  rows: readonly InsightRow[],
  until: string | undefined,
  nowMs: number,
): boolean {
  if (rows.length === 0) return true;
  const today = utcDate(nowMs);
  let latest: string | undefined;
  for (const row of rows) {
    if (row.date !== undefined && (latest === undefined || row.date > latest)) {
      latest = row.date;
    }
  }
  if (latest === undefined || latest >= today) return true;
  return until === undefined || until >= today;
}

function buildNotes(input: {
  readonly scope: InsightsScope;
  readonly rows: readonly InsightRow[];
  readonly metrics: readonly MetricSummary[];
  readonly emptyMetrics: readonly string[];
  readonly unavailableMetrics: readonly string[];
  readonly deprecated: readonly MetricVerdict[];
  readonly capped: CappedRows;
  readonly until?: string;
  readonly nowMs: number;
}): readonly string[] {
  const notes: string[] = [];
  if (input.deprecated.length > 0)
    notes.push(droppedMetricsNote(input.deprecated.length));
  if (input.capped.truncated) {
    notes.push(truncationNote(input.capped.rows.length, input.capped.dropped));
  }
  if (input.unavailableMetrics.length > 0) {
    notes.push(unavailableNote(input.unavailableMetrics, input.scope));
  }

  const allEmpty =
    input.metrics.length > 0 && input.metrics.every((metric) => metric.points === 0);
  if (allEmpty) {
    notes.push(EMPTY_SCOPE_NOTE[input.scope]);
    // The eligibility/lag explanations above are the LIKELY cause; the silent
    // user-token read is the other one, and only the caller can tell them apart.
    notes.push(INSIGHTS_TOKEN_EMPTY_HINT);
  } else if (input.emptyMetrics.length > 0) {
    notes.push(`${EMPTY_METRICS_NOTE_PREFIX}${input.emptyMetrics.join(', ')}.`);
  }

  if (needsFreshnessNote(input.rows, input.until, input.nowMs))
    notes.push(FRESHNESS_NOTE);
  notes.push(PERIOD_BOUNDARY_NOTE);
  return notes;
}

/**
 * Read `/{page-id|post-id}/insights`, reshape it and annotate it.
 *
 * Order of operations: validate the window → classify the requested metric names
 * → drop the dead ones (Graph fails the whole call over one) → GET what is left
 * → reshape → cap rows → assemble notes. When EVERY requested name is dead no
 * request is made at all: the result carries the replacement suggestions, which
 * is strictly more useful than an empty series (C6, CC-INS-1).
 */
export async function fetchInsights(
  fbRequest: FbRequestFn,
  req: InsightsRequest,
): Promise<InsightsResult> {
  const period = req.period ?? defaultPeriod(req.scope);
  const window = checkWindow({
    ...(req.since !== undefined ? { since: req.since } : {}),
    ...(req.until !== undefined ? { until: req.until } : {}),
    nowMs: req.nowMs,
  });
  const mode: 'series' | 'aggregate' = req.aggregate === true ? 'aggregate' : 'series';
  const hasWindow = window.since !== undefined || window.until !== undefined;

  const verdicts = classifyMetrics(req.metrics);
  const deprecated = verdicts.filter((verdict) => verdict.status !== 'ok');
  // Canonicalised, not echoed: `live` is both what goes on the wire and what the
  // reply is checked against below. Graph answers in lower-case snake_case, so a
  // requested "Post_Impressions" compared raw would come back as "unavailable"
  // while its own data sits in `rows` — the model would be handed the numbers
  // and a note saying the name is invalid. Dedup happens after folding, so a
  // list carrying both spellings is also only requested once.
  const live = [
    ...new Set(
      verdicts.filter((v) => v.status === 'ok').map((v) => canonicalMetricName(v.metric)),
    ),
  ];

  if (live.length === 0) {
    return {
      mode,
      period,
      ...(hasWindow ? { window } : {}),
      queriedMetrics: [],
      metrics: [],
      ...(mode === 'series' ? { rows: [] } : {}),
      rowsAvailable: 0,
      truncated: false,
      deprecatedMetrics: deprecated,
      unavailableMetrics: [],
      emptyMetrics: [],
      notes: [ALL_METRICS_DEPRECATED_NOTE],
    };
  }

  const body = await requestInsights(fbRequest, req, live, period);
  const reshaped = reshapeInsights(body);
  // Aggregate mode emits no rows at all, so the row cap simply does not apply —
  // and must not raise a truncation note about rows nobody asked for.
  const capped: CappedRows =
    mode === 'series'
      ? capRows(reshaped.rows, req.maxRows ?? INSIGHTS_MAX_ROWS)
      : { rows: [], dropped: 0, truncated: false };

  const returned = new Set(reshaped.metrics.map((metric) => metric.metric));
  const unavailableMetrics = live.filter((metric) => !returned.has(metric));
  const emptyMetrics = reshaped.metrics
    .filter((metric) => metric.points === 0)
    .map((metric) => metric.metric);

  return {
    mode,
    period,
    ...(hasWindow ? { window } : {}),
    queriedMetrics: live,
    metrics: reshaped.metrics,
    ...(mode === 'series' ? { rows: capped.rows } : {}),
    rowsAvailable: reshaped.rows.length,
    truncated: capped.truncated,
    deprecatedMetrics: deprecated,
    unavailableMetrics,
    emptyMetrics,
    notes: buildNotes({
      scope: req.scope,
      // Freshness is judged on the FULL series, not the capped prefix — a cap
      // that lopped off the tail must not hide that the tail may be stale.
      rows: reshaped.rows,
      metrics: reshaped.metrics,
      emptyMetrics,
      unavailableMetrics,
      deprecated,
      capped,
      ...(req.until !== undefined ? { until: req.until } : {}),
      nowMs: req.nowMs,
    }),
  };
}
