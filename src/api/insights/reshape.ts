// The pure insights reshape and row cap (X09 split of `insights.ts`).

import { canonicalMetricName } from './deprecations.js';
import { DATE_PREFIX, MAX_BREAKDOWN_DEPTH } from './limits.js';
import type {
  InsightRow,
  MetricAggregation,
  MetricKind,
  MetricSummary,
  ReshapedInsights,
} from './model.js';

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

/** True when `a` is strictly earlier than `b`; string order when unparseable. */
function endBefore(a: string, b: string): boolean {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  return Number.isFinite(aMs) && Number.isFinite(bMs) ? aMs < bMs : a < b;
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

/** A breakdown map (or list) with no entries at all: `{}` / `[]`. */
function isEmptyMap(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return isRecord(value) && Object.keys(value).length === 0;
}

interface RawValuePoint {
  readonly value?: unknown;
  readonly end_time?: unknown;
}

/**
 * Metrics whose points are disjoint counts that add up over day / month
 * buckets. Deliberately a SMALL allow-list: an unknown metric with several
 * points is safer left unaggregated than silently double-counted.
 */
const FLOW_METRICS: ReadonlySet<string> = new Set([
  'page_media_view',
  'page_views_total',
  'page_post_engagements',
  'page_daily_follows',
  'page_daily_follows_unique',
  'page_daily_unfollows',
  'page_daily_unfollows_unique',
  'page_video_views',
  'page_video_view_time',
  // Post / Reel counters are flows in day / month buckets and cumulative as
  // lifetime; the period decides which (see safeRollup).
  'post_media_view',
  'post_clicks',
  'post_video_views',
  'post_video_view_time',
  'blue_reels_play_count',
]);

/**
 * Stock metrics — a level read at the end of each bucket, whatever period
 * Graph echoes. Summing seven daily `page_follows` turned a live 881 → 882
 * week into "6166" (PR #41).
 */
const GAUGE_METRICS: ReadonlySet<string> = new Set(['page_follows']);

/**
 * Unique-audience metrics: a person seen on two days counts once per day, so
 * daily uniques overlap and do not add up to a window reach.
 */
const UNIQUE_METRICS = /_unique$|_total_media_view_unique$/;

/**
 * Unique FLOWS that stay additive over disjoint days: each day's uniques are a
 * per-day count of follow (unfollow) events, so the sum is follower-days.
 */
const UNIQUE_FLOWS: ReadonlySet<string> = new Set([
  'page_daily_follows_unique',
  'page_daily_unfollows_unique',
]);

function metricKind(metric: string): MetricKind {
  const canonical = canonicalMetricName(metric);
  if (GAUGE_METRICS.has(canonical)) return 'gauge';
  if (UNIQUE_METRICS.test(canonical) && !UNIQUE_FLOWS.has(canonical)) return 'unique';
  if (FLOW_METRICS.has(canonical)) return 'flow';
  return 'unknown';
}

interface SafeRollup {
  readonly kind: MetricKind;
  readonly aggregation: MetricAggregation;
  readonly value?: number;
  readonly firstValue?: number;
  readonly lastValue?: number;
  readonly change?: number;
  readonly note?: string;
}

const GAUGE_NOTE =
  'Gauge/snapshot metric: value is the latest observation; summing observations would double-count the stock.';
const UNIQUE_NOTE =
  'Unique-audience metric: daily uniques overlap and are not additive. Use period=week or days_28 for a window reach.';
const UNKNOWN_NOTE =
  'No scalar roll-up: this metric has several observations but its additivity is not in the verified semantics table. Read firstValue/lastValue or the per-point rows.';
const NON_NUMERIC_NOTE =
  'No scalar roll-up: at least one returned point is non-numeric, so a roll-up of only the numeric subset would misstate the range.';
const BREAKDOWN_NOTE =
  'No scalar roll-up: this metric is a breakdown map whose keys may overlap and are not assumed additive. Read the per-key rows with aggregate:false.';

/** A numeric scalar point; dated ones are ordered oldest → newest. */
type ScalarRow = InsightRow & { readonly value: number };

/**
 * Produce one scalar only when the point semantics make it safe:
 *   - a breakdown map, an empty-map point or a non-numeric point ⇒ none;
 *   - one numeric point ⇒ single;
 *   - a gauge ⇒ latest, with the change over the window;
 *   - week / days_28 points are rolling windows ⇒ latest_window;
 *   - lifetime / total_over_range are already cumulative ⇒ latest;
 *   - a known flow over disjoint day / month buckets ⇒ sum;
 *   - anything else (unique or unknown day / month series) ⇒ none.
 *
 * "Latest" is chosen by date, not array position: Graph documents oldest-first,
 * but a reversed body must not hand back the OLDEST window as the current one.
 */
function safeRollup(
  metric: string,
  period: string,
  rows: readonly InsightRow[],
  breakdowns: number,
  nonNumeric: boolean,
  hasEmptyMap: boolean,
): SafeRollup {
  const kind = metricKind(metric);
  const numeric = rows
    .filter(
      (row): row is ScalarRow =>
        row.breakdown === undefined && typeof row.value === 'number',
    )
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) => (a.row.date ?? '').localeCompare(b.row.date ?? '') || a.index - b.index,
    )
    .map(({ row }) => row);
  const firstValue = numeric[0]?.value;
  const lastValue = numeric[numeric.length - 1]?.value;
  const ends = {
    ...(firstValue !== undefined ? { firstValue } : {}),
    ...(lastValue !== undefined ? { lastValue } : {}),
  };

  if (breakdowns > 0 || hasEmptyMap) {
    return { kind, aggregation: 'none', ...ends, note: BREAKDOWN_NOTE };
  }
  if (nonNumeric) return { kind, aggregation: 'none', ...ends, note: NON_NUMERIC_NOTE };
  if (firstValue === undefined || lastValue === undefined) {
    return { kind, aggregation: 'none' };
  }
  if (numeric.length === 1) {
    return { kind, aggregation: 'single', value: lastValue, ...ends };
  }
  if (kind === 'gauge') {
    return {
      kind,
      aggregation: 'latest',
      value: lastValue,
      ...ends,
      change: lastValue - firstValue,
      note: GAUGE_NOTE,
    };
  }
  if (period === 'week' || period === 'days_28') {
    return {
      kind,
      aggregation: 'latest_window',
      value: lastValue,
      ...ends,
      note: `${period} points are rolling windows and overlap; value is the latest window, not the sum of all windows.`,
    };
  }
  if (period === 'lifetime' || period === 'total_over_range') {
    return {
      kind,
      aggregation: 'latest',
      value: lastValue,
      ...ends,
      note: `${period} is already a cumulative period; value is the latest observation, never a sum of observations.`,
    };
  }
  if (kind === 'flow' && (period === 'day' || period === 'month')) {
    return {
      kind,
      aggregation: 'sum',
      value: numeric.reduce((sum, row) => sum + row.value, 0),
      ...ends,
    };
  }
  return {
    kind,
    aggregation: 'none',
    ...ends,
    note: kind === 'unique' ? UNIQUE_NOTE : UNKNOWN_NOTE,
  };
}

function summarize(
  metric: string,
  period: string,
  rows: readonly InsightRow[],
  ends: readonly string[],
  nonNumeric: boolean,
  hasEmptyMap = false,
): MetricSummary {
  const breakdowns = new Set(
    rows.filter((r) => r.breakdown !== undefined).map((r) => r.breakdown),
  ).size;
  const rollup = safeRollup(metric, period, rows, breakdowns, nonNumeric, hasEmptyMap);
  // Boundaries by time, not array position: Graph documents oldest-first, but
  // a reversed body must not report a `firstEnd` later than its `lastEnd`.
  let first: string | undefined;
  let last: string | undefined;
  for (const end of ends) {
    if (first === undefined || endBefore(end, first)) first = end;
    if (last === undefined || endBefore(last, end)) last = end;
  }
  return {
    metric,
    period,
    points: rows.length,
    kind: rollup.kind,
    aggregation: rollup.aggregation,
    ...(rollup.value !== undefined ? { value: rollup.value } : {}),
    ...(rollup.firstValue !== undefined ? { firstValue: rollup.firstValue } : {}),
    ...(rollup.lastValue !== undefined ? { lastValue: rollup.lastValue } : {}),
    ...(rollup.change !== undefined ? { change: rollup.change } : {}),
    ...(first !== undefined ? { firstEnd: first } : {}),
    ...(last !== undefined ? { lastEnd: last } : {}),
    ...(breakdowns > 0 ? { breakdowns } : {}),
    ...(nonNumeric ? { nonNumeric: true } : {}),
    ...(rollup.note !== undefined ? { aggregationNote: rollup.note } : {}),
  };
}

/**
 * Reshape a raw Graph insights body into flat rows plus one summary per metric.
 * Pure and defensive: any field may be absent or the wrong type (CC-NET-2), a
 * missing `data` array yields an empty reshape, and `title`/`description`/`id`
 * boilerplate is dropped on the floor.
 */
export function reshapeInsights(body: unknown): ReshapedInsights {
  const { rows, metrics } = reshapeWithEnds(body);
  return { rows, metrics };
}

/**
 * One data point of a file export (v2 insights F5): the inline row plus the raw
 * `end_time` it was read from, which the inline shape keeps only once per metric.
 */
export interface InsightExportRow extends InsightRow {
  readonly endTime?: string;
}

/** {@link reshapeInsights} plus each row's raw `end_time`, index-aligned. */
export function reshapeWithEnds(
  body: unknown,
): ReshapedInsights & { readonly rowEnds: readonly (string | undefined)[] } {
  const rawData: unknown = isRecord(body) ? body.data : undefined;
  const entries: readonly unknown[] = Array.isArray(rawData) ? rawData : [];

  const rows: InsightRow[] = [];
  const rowEnds: (string | undefined)[] = [];
  const metrics: MetricSummary[] = [];

  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const name = typeof entry.name === 'string' ? entry.name : undefined;
    if (name === undefined) continue;
    const period = typeof entry.period === 'string' ? entry.period : 'unknown';
    const points: readonly unknown[] = Array.isArray(entry.values) ? entry.values : [];

    const metricRows: InsightRow[] = [];
    const metricRowEnds: (string | undefined)[] = [];
    const ends: string[] = [];
    const emptyMapEnds: string[] = [];
    let nonNumeric = false;

    for (const point of points) {
      if (!isRecord(point)) continue;
      const typed = point as RawValuePoint;
      const endTime = typeof typed.end_time === 'string' ? typed.end_time : undefined;
      const flattened: FlatValue[] = [];
      flattenValue(typed.value, [], 0, flattened);
      if (flattened.length > 0 && endTime !== undefined) ends.push(endTime);
      if (flattened.length === 0 && endTime !== undefined && isEmptyMap(typed.value)) {
        emptyMapEnds.push(endTime);
      }
      for (const flat of flattened) {
        if (typeof flat.value !== 'number') nonNumeric = true;
        metricRows.push({
          metric: name,
          ...(endTime !== undefined ? { date: endDate(endTime) } : {}),
          ...(flat.breakdown !== undefined ? { breakdown: flat.breakdown } : {}),
          value: flat.value,
        });
        metricRowEnds.push(endTime);
      }
    }

    for (const row of metricRows) rows.push(row);
    for (const end of metricRowEnds) rowEnds.push(end);
    // Empty-map points only shape a series that has data at all: a metric whose
    // every point is `{}` stays an empty series (emptyMetrics), with no invented
    // boundaries. A `{}` point is a breakdown with no keys, so the series is a
    // breakdown series and gets no scalar roll-up.
    const hasEmptyMap = metricRows.length > 0 && emptyMapEnds.length > 0;
    if (hasEmptyMap) for (const endTime of emptyMapEnds) ends.push(endTime);
    metrics.push(summarize(name, period, metricRows, ends, nonNumeric, hasEmptyMap));
  }

  return { rows, metrics, rowEnds };
}

/** Row-cap outcome: the kept prefix plus how many points were dropped. */
export interface CappedRows {
  readonly rows: readonly InsightRow[];
  readonly dropped: number;
  readonly truncated: boolean;
}

/**
 * Apply the row cap, keeping the FIRST rows (matching the pagination
 * contract's "truncation keeps the first items" rule). Rows are metric-major —
 * chronological within a metric — so a multi-metric cut keeps leading metrics
 * whole and trailing ones partially or not at all; `fetchInsights` names them.
 */
export function capRows(rows: readonly InsightRow[], maxRows: number): CappedRows {
  const cap = Number.isFinite(maxRows) && maxRows > 0 ? Math.floor(maxRows) : 1;
  if (rows.length <= cap) return { rows, dropped: 0, truncated: false };
  return { rows: rows.slice(0, cap), dropped: rows.length - cap, truncated: true };
}
