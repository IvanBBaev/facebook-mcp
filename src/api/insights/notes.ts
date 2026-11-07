// Model-facing honesty notes of the insights read (X09 split of `insights.ts`).

import { META_INSIGHTS_TIMEZONE, PAGE_INSIGHTS_LIKES_FLOOR } from './limits.js';
import type { InsightRow, InsightsScope } from './model.js';

// ---------------------------------------------------------------------------
// 2. Model-facing honesty notes (CC-INS-2, CC-INS-3, CC-INS-5, CC-INS-6)
// ---------------------------------------------------------------------------

/** Insights lag: a same-day zero usually means "not computed yet" (CC-INS-6). */
export const FRESHNESS_NOTE =
  'Data freshness: Graph computes insights with a lag (minutes to hours, ' +
  'occasionally a full day). A zero or a missing point in the still-open current ' +
  'bucket is normally "not computed yet", NOT "no engagement" — re-read later ' +
  'before concluding.';

/** Empty Page series are usually an eligibility floor, not an error (CC-INS-2). */
export const PAGE_ELIGIBILITY_NOTE = `Every requested metric came back empty. This is usually an eligibility floor, not an error: a Page with fewer than ${String(PAGE_INSIGHTS_LIKES_FLOOR)} likes/followers returns empty insights. Check fan_count/followers_count with facebook_get_page, and confirm the token carries read_insights plus the ANALYZE Page task.`;

/** Empty post series: publish lag, or the ID is a Reel (CC-INS-6, G-TOOL-2). */
export const POST_EMPTY_NOTE =
  'Every requested metric came back empty. On a just-published post that is ' +
  'normal — post insights lag minutes to hours. If the ID is a Reel, its ' +
  'metrics are NOT on this edge at all: they live on /{video-id}/video_insights, ' +
  'so re-read it with facebook_reel_insights and the VIDEO id ' +
  '(facebook_list_reels lists it as each item `id`).';

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
export const EMPTY_SCOPE_NOTE: Readonly<Record<InsightsScope, string>> = {
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

/** Graph reports end_time as the exclusive boundary of each returned period. */
export const PERIOD_BOUNDARY_NOTE =
  "`date` is the calendar date of Graph's `end_time`, the EXCLUSIVE end boundary " +
  'of the period. Days with no data are absent; nothing is zero-filled.';

/** Page daily Insights use midnight Pacific Time boundaries. */
export const PAGE_TIMEZONE_NOTE =
  `Page period=day buckets use Pacific Time (${META_INSIGHTS_TIMEZONE}). ` +
  'For example, an end boundary dated 2026-08-30 covers the 2026-08-29 Pacific day.';

/** One metric whose per-point rows the cap cut short (or cut entirely). */
interface CutSeries {
  readonly metric: string;
  readonly kept: number;
  readonly available: number;
}

/**
 * Rows are emitted metric by metric in Graph's order, so the cap keeps the
 * leading metrics whole and cuts the trailing ones — partially or entirely.
 * Naming them is the difference between "this series ends early" (false) and
 * "this series was cut here" (true); a wholly cut metric would otherwise look
 * like one with no rows at all.
 */
export function truncationNote(
  kept: number,
  dropped: number,
  cut: readonly CutSeries[],
): string {
  const detail =
    cut.length > 0
      ? ` Rows are kept metric by metric in response order, so these series are incomplete in rows (their summaries in metrics are still whole): ${cut
          .map((c) => `${c.metric} (kept ${String(c.kept)} of ${String(c.available)})`)
          .join(', ')}.`
      : '';
  return `Row cap reached: kept the first ${String(kept)} of ${String(kept + dropped)} data points and dropped ${String(dropped)}.${detail} Re-run with aggregate:true for per-metric summaries, or narrow the window (since/until) or the metric list.`;
}

/** Per-metric kept-vs-available counts for every metric the cap cut short. */
export function cutSeries(
  all: readonly InsightRow[],
  kept: readonly InsightRow[],
): CutSeries[] {
  const available = new Map<string, number>();
  for (const row of all) available.set(row.metric, (available.get(row.metric) ?? 0) + 1);
  const keptCounts = new Map<string, number>();
  for (const row of kept)
    keptCounts.set(row.metric, (keptCounts.get(row.metric) ?? 0) + 1);
  const cut: CutSeries[] = [];
  for (const [metric, count] of available) {
    const k = keptCounts.get(metric) ?? 0;
    if (k < count) cut.push({ metric, kept: k, available: count });
  }
  return cut;
}

export function droppedMetricsNote(count: number): string {
  return `Dropped ${String(count)} deprecated metric name(s) from the request — Graph fails the whole call when a single metric name is invalid. See deprecatedMetrics for the replacement names, then re-run with those.`;
}

export function unavailableNote(
  metrics: readonly string[],
  scope: InsightsScope,
  period: string,
): string {
  // The doctor's metric probe speaks the `/insights` edge only, so pointing a
  // Reel read at it would be advice that cannot work — say what does instead.
  const probe =
    scope === 'reel'
      ? 'Metric names are version-dependent, and the /video_insights vocabulary is its own — page/post metric names do not transfer. Request one name at a time to find which ones this video answers.'
      : 'Metric names are version-dependent; run the doctor to probe which names this Page answers.';
  return `Graph returned no entry for: ${metrics.join(', ')}. An absent entry means the name is not valid for this object or for the pinned Graph API version, or that the metric does not serve period "${period}" (Graph omits an unsupported metric/period pair instead of failing the call) — that is different from a valid metric with no data (see emptyMetrics). ${probe}`;
}

export const ALL_METRICS_DEPRECATED_NOTE =
  'No live metric name remained after dropping deprecated ones, so nothing was ' +
  'queried. Re-run with the replacement names listed in deprecatedMetrics.';

const EMPTY_METRICS_NOTE_PREFIX =
  'Valid but empty (Graph accepted the metric and returned no data points): ';

/** An unsupported period also comes back empty — say so rather than "no data". */
export function emptyMetricsNote(metrics: readonly string[], period: string): string {
  return `${EMPTY_METRICS_NOTE_PREFIX}${metrics.join(', ')}. A metric queried with a period it does not serve (here period "${period}") comes back the same way; re-read it with another period before concluding there was no activity.`;
}
