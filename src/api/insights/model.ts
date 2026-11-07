// Row, summary and scope shapes of the insights read (X09 split of `insights.ts`).

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
  /** Calendar date of Graph's `end_time`: the EXCLUSIVE end of the period. */
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
  /** Semantic class that decides whether a multi-point roll-up is safe. */
  readonly kind: MetricKind;
  /** How `value` was derived. `none` ⇒ the server deliberately refused to guess. */
  readonly aggregation: MetricAggregation;
  /**
   * The one recommended scalar. Present iff `aggregation` is not `none`: the
   * sum of disjoint flow buckets, the latest gauge / rolling-window / lifetime
   * observation, or the single point Graph returned.
   */
  readonly value?: number;
  /** Oldest / newest numeric scalar point (by date), whenever there is one. */
  readonly firstValue?: number;
  readonly lastValue?: number;
  /** `lastValue − firstValue`; gauges only — a stock's change over the window. */
  readonly change?: number;
  /** Raw `end_time` of the first/last point — the exact boundary, kept once. */
  readonly firstEnd?: string;
  readonly lastEnd?: string;
  /** Distinct breakdown keys seen; absent ⇒ a plain scalar series. */
  readonly breakdowns?: number;
  /** True when at least one point was not numeric (no roll-up is then made). */
  readonly nonNumeric?: boolean;
  /** Why this aggregation was chosen, especially when none was safe. */
  readonly aggregationNote?: string;
}

/** `flow` adds up over disjoint buckets; a `gauge` is a level; `unique` overlaps. */
export type MetricKind = 'flow' | 'gauge' | 'unique' | 'unknown';
export type MetricAggregation = 'sum' | 'latest' | 'latest_window' | 'single' | 'none';

/** Output of the pure reshape step. */
export interface ReshapedInsights {
  readonly rows: readonly InsightRow[];
  readonly metrics: readonly MetricSummary[];
}

/**
 * Which object the insights edge hangs off. This picks the EDGE as well as the
 * honesty notes: `reel` reads `/video_insights`, the other two read `/insights`.
 */
export type InsightsScope = 'page' | 'post' | 'reel';
