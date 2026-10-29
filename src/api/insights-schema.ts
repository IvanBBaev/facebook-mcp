// Stable insights schema (task C05, owner decision V3-D10).
//
// Meta renames and removes insights metric names across every Graph version
// without a version bump (the 2024-09, 2025-11 and 2026-06-15 waves). A caller
// that keys its dashboards on `page_impressions` breaks the day Meta drops it.
// This module is the server-owned answer: a small map of STABLE keys (`views`,
// `viewers`, `engagements`, `follows`, ...) to the Graph metric each one is
// read from today, plus a pure projection from an insights read onto those
// keys with an explicit status per key.
//
// When Meta renames a metric again, the server changes `sourceMetric` in the
// table below (and moves the old name into `legacyMetrics`); callers that read
// the stable view see the same key with the same meaning. When Meta removes a
// metric outright, the key's status becomes `removed` — a status change, never
// a breaking change.
//
// Expand only: nothing here changes the raw `metrics` / `rows` an insights read
// returns. Callers (lane L2.insights) put the stable view ALONGSIDE them. The
// spec for adopting it is `docs/insights-schema.md`.
//
// Layering: api layer. Imports only TYPES from `./insights.js`, so the table and
// the projection carry no runtime dependency on the insights read itself.

import type { InsightsResult, InsightsScope } from './insights.js';

// ---------------------------------------------------------------------------
// 1. Types
// ---------------------------------------------------------------------------

/**
 * Version of the stable schema. Bumped only when a key is removed or its
 * meaning changes — never when a `sourceMetric` is swapped for Meta's new name
 * of the same quantity, and never when a key is added.
 */
export const INSIGHTS_SCHEMA_VERSION = 1;

/** The object a stable key is read on. Same vocabulary as {@link InsightsScope}. */
export type StableMetricLevel = InsightsScope;

/**
 * Every stable key the server defines. A key names a QUANTITY, not a Graph
 * metric: the same key may exist on several levels (`views` on a Page and on a
 * post), each with its own source metric.
 */
export type StableMetricKey =
  | 'views'
  | 'viewers'
  | 'engagements'
  | 'followers'
  | 'follows'
  | 'follows_unique'
  | 'unfollows'
  | 'unfollows_unique'
  | 'page_views'
  | 'clicks'
  | 'reactions'
  | 'video_views'
  | 'video_view_time'
  | 'plays'
  | 'avg_watch_time'
  | 'social_actions';

/**
 * How a key's points combine over a window — mirrors the api layer's
 * `MetricKind` for the source metric, stated here so the spec is self-contained.
 * `breakdown` is a map per point (e.g. reactions by type) with no scalar total.
 */
export type StableMetricKind = 'flow' | 'gauge' | 'unique' | 'breakdown';

/** One row of the stable map. */
export interface StableMetricDefinition {
  /** The stable key callers read. Unique per level. */
  readonly key: StableMetricKey;
  /** The object the key is read on (and so the Graph edge). */
  readonly level: StableMetricLevel;
  /** The Graph metric name the key is read from at the pinned Graph version. */
  readonly sourceMetric: string;
  /** Periods the server reads this metric with. The first is the usual one. */
  readonly periods: readonly string[];
  readonly kind: StableMetricKind;
  /**
   * Older Graph names of the SAME quantity, now dead. A request that names one
   * of them is answered on this key with status `removed`.
   */
  readonly legacyMetrics: readonly string[];
  /**
   * True when the source name comes from the code and Meta's reference but has
   * not been confirmed by a live read on the pinned version (doc 12, M1). The
   * status projection treats it like any other key; the flag is for the doc and
   * the 1.0 live pass.
   */
  readonly unverified?: boolean;
  /** One sentence on what the key counts. */
  readonly description: string;
}

/**
 * Status of one stable key in one read.
 *
 * - `ok` — Graph returned the source metric with at least one data point.
 * - `empty` — Graph accepted the source metric and returned no data points
 *   (eligibility floor, insights lag, a quiet window, or a period the metric
 *   does not serve with points). Valid name, no data.
 * - `removed` — the key could not be read because its metric is gone: a dead
 *   legacy name was requested (dropped before the request), or Graph rejected or
 *   omitted the source metric. See {@link StableInsightEntry.reason}.
 */
export type StableInsightStatus = 'ok' | 'removed' | 'empty';

/** Why a key is `removed`. Present only with that status. */
export type StableRemovedReason =
  /** A legacy name of the key was requested; the deprecation table dropped it. */
  | 'deprecated'
  /** Graph rejected the source metric by position (`metric[N]`). */
  | 'rejected'
  /** Graph accepted the call but returned no entry for the source metric. */
  | 'unavailable';

/** One stable key in one read. Additive: the raw metric summaries are untouched. */
export interface StableInsightEntry {
  readonly key: StableMetricKey;
  /**
   * The safe scalar of the source metric (`MetricSummary.value`): the sum of
   * disjoint flow buckets, the latest gauge or rolling-window value, or the one
   * lifetime point. `null` when the status is not `ok`, or when the server
   * refused to roll the series up (unique audiences over several days, breakdown
   * maps, non-numeric points) — read the raw `metrics` / `rows` then.
   */
  readonly value: number | null;
  /** The Graph metric name this entry was read from (or requested as). */
  readonly source_metric: string;
  readonly status: StableInsightStatus;
  /** Graph's echoed period for the source metric, when Graph returned it. */
  readonly period?: string;
  /** Present iff `status` is `removed`. */
  readonly reason?: StableRemovedReason;
}

/**
 * The fields of an insights read the projection needs. A structural subset of
 * {@link InsightsResult}, so `fetchInsights`' result can be passed as is.
 */
export type StableInsightsInput = Pick<
  InsightsResult,
  'queriedMetrics' | 'metrics' | 'deprecatedMetrics' | 'emptyMetrics' | 'rejectedMetrics'
>;

/** The stable view of one insights read. */
export interface StableInsights {
  readonly schema_version: typeof INSIGHTS_SCHEMA_VERSION;
  readonly level: StableMetricLevel;
  /** One entry per stable key the request touched, in table order. */
  readonly entries: readonly StableInsightEntry[];
  /**
   * Requested metric names (canonical form) that map to no stable key at this
   * level. Their data, if any, is only in the raw `metrics` / `rows` — the
   * passthrough policy: an unknown name is never dropped or rejected here.
   */
  readonly unmapped: readonly string[];
}

// ---------------------------------------------------------------------------
// 2. The stable map
// ---------------------------------------------------------------------------

const PAGE_WINDOW_PERIODS = ['day', 'week', 'days_28'] as const;
const PAGE_DAY = ['day'] as const;
const LIFETIME = ['lifetime'] as const;

/**
 * The server-owned stable map at Graph v26.0. Source names are the ones the code
 * reads today (`page-report.ts`, `insights-batch.ts`, the doctor's probe set and
 * the reshape semantics table in `insights.ts`); legacy names come from the
 * deprecation table in `insights.ts`. A test keeps both in step.
 */
export const STABLE_INSIGHTS_SCHEMA: readonly StableMetricDefinition[] = [
  // --- Page (`/{page-id}/insights`) ---------------------------------------
  {
    key: 'views',
    level: 'page',
    sourceMetric: 'page_media_view',
    periods: PAGE_WINDOW_PERIODS,
    kind: 'flow',
    legacyMetrics: [
      'page_impressions',
      'page_impressions_organic',
      'page_impressions_paid',
      'page_impressions_viral',
      'page_impressions_nonviral',
      'page_posts_impressions',
    ],
    description: 'Times the Page’s content was viewed (media views).',
  },
  {
    key: 'viewers',
    level: 'page',
    sourceMetric: 'page_total_media_view_unique',
    periods: PAGE_WINDOW_PERIODS,
    kind: 'unique',
    legacyMetrics: [
      'page_impressions_unique',
      'page_impressions_paid_unique',
      'page_impressions_viral_unique',
      'page_impressions_nonviral_unique',
      'page_posts_impressions_unique',
    ],
    description:
      'Unique people who viewed the Page’s media. Never summed over days; read with week or days_28 for a window reach.',
  },
  {
    key: 'engagements',
    level: 'page',
    sourceMetric: 'page_post_engagements',
    periods: PAGE_WINDOW_PERIODS,
    kind: 'flow',
    legacyMetrics: ['page_engaged_users'],
    description: 'Interactions with the Page’s posts.',
  },
  {
    key: 'followers',
    level: 'page',
    sourceMetric: 'page_follows',
    periods: PAGE_DAY,
    kind: 'gauge',
    legacyMetrics: ['page_fans'],
    description: 'Follower count (a stock); the value is the latest observation.',
  },
  {
    key: 'follows',
    level: 'page',
    sourceMetric: 'page_daily_follows',
    periods: PAGE_DAY,
    kind: 'flow',
    legacyMetrics: ['page_fan_adds'],
    description: 'New follows in the window.',
  },
  {
    key: 'follows_unique',
    level: 'page',
    sourceMetric: 'page_daily_follows_unique',
    periods: PAGE_DAY,
    kind: 'flow',
    legacyMetrics: ['page_fan_adds_unique'],
    description: 'People who followed, counted once per day; additive over days.',
  },
  {
    key: 'unfollows',
    level: 'page',
    sourceMetric: 'page_daily_unfollows',
    periods: PAGE_DAY,
    kind: 'flow',
    legacyMetrics: ['page_fan_removes'],
    unverified: true,
    description: 'Unfollows in the window.',
  },
  {
    key: 'unfollows_unique',
    level: 'page',
    sourceMetric: 'page_daily_unfollows_unique',
    periods: PAGE_DAY,
    kind: 'flow',
    legacyMetrics: ['page_fan_removes_unique'],
    description: 'People who unfollowed, counted once per day; additive over days.',
  },
  {
    key: 'page_views',
    level: 'page',
    sourceMetric: 'page_views_total',
    periods: PAGE_WINDOW_PERIODS,
    kind: 'flow',
    legacyMetrics: [],
    description: 'Views of the Page itself (profile visits).',
  },
  {
    key: 'video_views',
    level: 'page',
    sourceMetric: 'page_video_views',
    periods: PAGE_WINDOW_PERIODS,
    kind: 'flow',
    legacyMetrics: ['page_video_views_unique'],
    description: 'Video views across the Page’s videos.',
  },
  {
    key: 'video_view_time',
    level: 'page',
    sourceMetric: 'page_video_view_time',
    periods: PAGE_DAY,
    kind: 'flow',
    legacyMetrics: [],
    unverified: true,
    description: 'Total time the Page’s videos were watched.',
  },

  // --- Post (`/{post-id}/insights`) -----------------------------------------
  {
    key: 'views',
    level: 'post',
    sourceMetric: 'post_media_view',
    periods: LIFETIME,
    kind: 'flow',
    legacyMetrics: [
      'post_impressions',
      'post_impressions_organic',
      'post_impressions_paid',
      'post_impressions_viral',
      'post_impressions_nonviral',
      'post_impressions_fan',
    ],
    description: 'Times the post was viewed (media views).',
  },
  {
    key: 'viewers',
    level: 'post',
    sourceMetric: 'post_total_media_view_unique',
    periods: LIFETIME,
    kind: 'unique',
    legacyMetrics: [
      'post_impressions_unique',
      'post_impressions_paid_unique',
      'post_impressions_fan_unique',
      'post_impressions_organic_unique',
      'post_impressions_viral_unique',
      'post_impressions_nonviral_unique',
    ],
    description: 'Unique people who viewed the post.',
  },
  {
    key: 'clicks',
    level: 'post',
    sourceMetric: 'post_clicks',
    periods: LIFETIME,
    kind: 'flow',
    legacyMetrics: [],
    description: 'Clicks anywhere on the post.',
  },
  {
    key: 'reactions',
    level: 'post',
    sourceMetric: 'post_reactions_by_type_total',
    periods: LIFETIME,
    kind: 'breakdown',
    legacyMetrics: [],
    description:
      'Reactions by type (a map). No scalar: the value is null; the per-type counts are in the raw rows.',
  },
  {
    key: 'video_views',
    level: 'post',
    sourceMetric: 'post_video_views',
    periods: LIFETIME,
    kind: 'flow',
    legacyMetrics: [
      'post_video_views_unique',
      'post_video_views_organic_unique',
      'post_video_views_paid_unique',
    ],
    description: 'Video views of a video post.',
  },
  {
    key: 'video_view_time',
    level: 'post',
    sourceMetric: 'post_video_view_time',
    periods: LIFETIME,
    kind: 'flow',
    legacyMetrics: [],
    description: 'Total time the post’s video was watched.',
  },

  // --- Reel (`/{video-id}/video_insights`) ----------------------------------
  {
    key: 'plays',
    level: 'reel',
    sourceMetric: 'blue_reels_play_count',
    periods: LIFETIME,
    kind: 'flow',
    legacyMetrics: [],
    description: 'Times the Reel started playing.',
  },
  {
    key: 'video_view_time',
    level: 'reel',
    sourceMetric: 'post_video_view_time',
    periods: LIFETIME,
    kind: 'flow',
    legacyMetrics: [],
    unverified: true,
    description: 'Total time the Reel was watched.',
  },
  {
    key: 'avg_watch_time',
    level: 'reel',
    sourceMetric: 'post_video_avg_time_watched',
    periods: LIFETIME,
    kind: 'gauge',
    legacyMetrics: [],
    unverified: true,
    description: 'Average watch time per play.',
  },
  {
    key: 'reactions',
    level: 'reel',
    sourceMetric: 'post_video_likes_by_reaction_type',
    periods: LIFETIME,
    kind: 'breakdown',
    legacyMetrics: [],
    unverified: true,
    description: 'Reactions by type (a map). No scalar: the value is null.',
  },
  {
    key: 'social_actions',
    level: 'reel',
    sourceMetric: 'post_video_social_actions',
    periods: LIFETIME,
    kind: 'breakdown',
    legacyMetrics: [],
    unverified: true,
    description: 'Comments and shares (a map). No scalar: the value is null.',
  },
];

// ---------------------------------------------------------------------------
// 3. Lookups
// ---------------------------------------------------------------------------

/** Graph's spelling of a metric name; same rule as `canonicalMetricName`. */
function canonical(metric: string): string {
  return metric.trim().toLowerCase();
}

/** The stable keys defined on one level, in table order. */
export function stableMetricsFor(
  level: StableMetricLevel,
): readonly StableMetricDefinition[] {
  return STABLE_INSIGHTS_SCHEMA.filter((def) => def.level === level);
}

/** The definition of one key on one level, or undefined when it has none there. */
export function stableMetric(
  level: StableMetricLevel,
  key: StableMetricKey,
): StableMetricDefinition | undefined {
  return STABLE_INSIGHTS_SCHEMA.find((def) => def.level === level && def.key === key);
}

/**
 * The stable key a Graph metric name feeds on one level — as its current source
 * or as a legacy name. Case- and space-insensitive. Undefined ⇒ unmapped.
 */
export function stableKeyFor(
  level: StableMetricLevel,
  metric: string,
): StableMetricKey | undefined {
  const name = canonical(metric);
  return STABLE_INSIGHTS_SCHEMA.find(
    (def) =>
      def.level === level &&
      (def.sourceMetric === name || def.legacyMetrics.includes(name)),
  )?.key;
}

// ---------------------------------------------------------------------------
// 4. The pure projection
// ---------------------------------------------------------------------------

function entryForSource(
  def: StableMetricDefinition,
  read: StableInsightsInput,
): StableInsightEntry {
  const base = { key: def.key, source_metric: def.sourceMetric } as const;
  const rejected = (read.rejectedMetrics ?? []).some(
    (r) => canonical(r.metric) === def.sourceMetric,
  );
  if (rejected) return { ...base, value: null, status: 'removed', reason: 'rejected' };

  const summary = read.metrics.find((m) => canonical(m.metric) === def.sourceMetric);
  const empty = read.emptyMetrics.some((m) => canonical(m) === def.sourceMetric);
  if (summary === undefined) {
    // Sent, answered, and never mentioned: Graph does not serve the name for
    // this object/version (or this period) any more.
    return { ...base, value: null, status: 'removed', reason: 'unavailable' };
  }
  if (empty || summary.points === 0) {
    return { ...base, value: null, status: 'empty', period: summary.period };
  }
  return {
    ...base,
    value: summary.value ?? null,
    status: 'ok',
    period: summary.period,
  };
}

/**
 * Project one insights read onto the stable keys of `level`.
 *
 * Pure and additive: it reads `read` and returns a new object; the raw
 * `metrics` / `rows` stay exactly as Graph's reshape produced them, and callers
 * place the result alongside them (e.g. as `stable`).
 *
 * Per key, in table order:
 *
 * 1. Its `sourceMetric` was sent (`queriedMetrics`):
 *    - rejected by position (`rejectedMetrics`) → `removed`, reason `rejected`;
 *    - no entry in Graph's reply (it is in `unavailableMetrics`) → `removed`, reason
 *      `unavailable`;
 *    - an entry with no points (`emptyMetrics`) → `empty`, value `null`;
 *    - otherwise → `ok`, value = the summary's safe scalar or `null`.
 * 2. Else, one of its `legacyMetrics` was requested (it is in
 *    `deprecatedMetrics`, so the server dropped it before the request) →
 *    `removed`, reason `deprecated`, `source_metric` = that legacy name.
 * 3. Else the request did not touch the key → no entry.
 *
 * Every requested name that feeds no key at this level — an unknown name, a
 * metric of another level, a dead name with no stable key — is listed in
 * `unmapped` and otherwise ignored (passthrough: never dropped from the raw
 * view, never an error).
 */
export function toStableInsights(
  level: StableMetricLevel,
  read: StableInsightsInput,
): StableInsights {
  const queried = new Set(read.queriedMetrics.map(canonical));
  const deprecated = read.deprecatedMetrics.map((v) => canonical(v.metric));
  const rejected = (read.rejectedMetrics ?? []).map((r) => canonical(r.metric));
  const defs = stableMetricsFor(level);

  const entries: StableInsightEntry[] = [];
  for (const def of defs) {
    if (queried.has(def.sourceMetric)) {
      entries.push(entryForSource(def, read));
      continue;
    }
    const legacy = deprecated.find((name) => def.legacyMetrics.includes(name));
    if (legacy !== undefined) {
      entries.push({
        key: def.key,
        value: null,
        source_metric: legacy,
        status: 'removed',
        reason: 'deprecated',
      });
    }
  }

  // Everything the caller asked for, as far as the read records it: what was
  // sent (`queriedMetrics` still lists names Graph later rejected by position)
  // plus what the deprecation table dropped before sending.
  const requested = [...new Set([...queried, ...rejected, ...deprecated])];
  const unmapped = requested.filter((name) => stableKeyFor(level, name) === undefined);

  return { schema_version: INSIGHTS_SCHEMA_VERSION, level, entries, unmapped };
}
