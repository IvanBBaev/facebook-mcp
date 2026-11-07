// Metric rename / deprecation table of the insights read (X09 split of `insights.ts`).

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
 * changed 2024–2026)", doc 12 "Graph API changelog check, 2026-10"):
 *
 *   * 2024-09 — the engaged-users and consumptions names went away.
 *   * 2025-11 — the FANS family became the FOLLOWS family, and the IMPRESSIONS
 *     family became the MEDIA-VIEW family with the organic/paid/viral splits
 *     removed along with it (Pages API changelog, 2025-11-15).
 *   * 2026-06-15 — the remaining UNIQUE variants were removed, together with the
 *     `page_posts_impressions*` and `total_video_impressions*` families and the
 *     unique video-views names (Graph v25.0 changelog), some with no replacement.
 *
 * Training data is full of the pre-wave names, which is exactly why an explicit
 * table beats "pass it through and let Graph 400".
 */
const SPLIT_GONE_PAGE = 'The organic/paid/viral split is gone; use "page_media_view".';
const SPLIT_GONE_POST = 'The organic/paid/viral split is gone; use "post_media_view".';
const PAGE_UNIQUE_GONE =
  'No unique or split variant survived; "page_total_media_view_unique" counts unique media viewers of the whole Page.';
const POST_UNIQUE_GONE =
  'No unique or split variant survived; "post_total_media_view_unique" counts unique media viewers of the post.';
const PAGE_POSTS_GONE =
  'The Page-wide post impressions family is gone; use "page_media_view" (or "page_total_media_view_unique" for unique viewers).';

/** Meta names no replacement for the video impressions / unique video views family. */
const TOTAL_VIDEO_REMOVED = [
  'total_video_impressions',
  'total_video_impressions_unique',
  'total_video_impressions_paid',
  'total_video_impressions_paid_unique',
  'total_video_impressions_organic',
  'total_video_impressions_organic_unique',
  'total_video_impressions_viral',
  'total_video_impressions_viral_unique',
  'total_video_impressions_fan',
  'total_video_impressions_fan_unique',
  'total_video_impressions_fan_paid',
  'total_video_impressions_fan_paid_unique',
  'total_video_views_unique',
  'total_video_views_organic_unique',
  'total_video_views_paid_unique',
] as const;

const DEPRECATIONS: readonly DeprecatedMetric[] = [
  // --- 2024-09: engaged users / consumptions ------------------------------
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

  // --- 2025-11: fans -> follows -------------------------------------------
  { metric: 'page_fans', replacement: 'page_follows', removedOn: '2025-11' },
  { metric: 'page_fan_adds', replacement: 'page_daily_follows', removedOn: '2025-11' },
  {
    metric: 'page_fan_adds_unique',
    replacement: 'page_daily_follows_unique',
    removedOn: '2025-11',
  },
  {
    metric: 'page_fan_removes',
    replacement: 'page_daily_unfollows',
    removedOn: '2025-11',
    hint: 'Meta\'s current metric reference lists only "page_daily_unfollows_unique"; if Graph rejects "page_daily_unfollows", use that instead.',
  },
  {
    metric: 'page_fan_removes_unique',
    replacement: 'page_daily_unfollows_unique',
    removedOn: '2025-11',
  },
  { metric: 'page_fans_locale', removedOn: '2025-11' },
  { metric: 'page_fans_city', removedOn: '2025-11' },
  { metric: 'page_fans_country', removedOn: '2025-11' },

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
  { metric: 'page_impressions_viral', removedOn: '2025-11', hint: SPLIT_GONE_PAGE },
  { metric: 'page_impressions_nonviral', removedOn: '2025-11', hint: SPLIT_GONE_PAGE },
  { metric: 'post_impressions', replacement: 'post_media_view', removedOn: '2025-11' },
  { metric: 'post_impressions_organic', removedOn: '2025-11', hint: SPLIT_GONE_POST },
  { metric: 'post_impressions_paid', removedOn: '2025-11', hint: SPLIT_GONE_POST },
  { metric: 'post_impressions_viral', removedOn: '2025-11', hint: SPLIT_GONE_POST },
  { metric: 'post_impressions_nonviral', removedOn: '2025-11', hint: SPLIT_GONE_POST },
  { metric: 'post_impressions_fan', removedOn: '2025-11', hint: SPLIT_GONE_POST },

  // --- 2026-06-15: unique variants, Page-posts and video impressions ------
  {
    metric: 'page_impressions_unique',
    replacement: 'page_total_media_view_unique',
    removedOn: '2026-06-15',
    deprecatedAbove: 'v25.0',
    hint: '"page_media_view" is the non-deduplicated alternative.',
  },
  {
    metric: 'page_impressions_paid_unique',
    removedOn: '2026-06-15',
    hint: PAGE_UNIQUE_GONE,
  },
  {
    metric: 'page_impressions_viral_unique',
    removedOn: '2026-06-15',
    hint: PAGE_UNIQUE_GONE,
  },
  {
    metric: 'page_impressions_nonviral_unique',
    removedOn: '2026-06-15',
    hint: PAGE_UNIQUE_GONE,
  },
  { metric: 'page_posts_impressions', removedOn: '2026-06-15', hint: PAGE_POSTS_GONE },
  {
    metric: 'page_posts_impressions_unique',
    removedOn: '2026-06-15',
    hint: PAGE_POSTS_GONE,
  },
  {
    metric: 'page_posts_impressions_paid',
    removedOn: '2026-06-15',
    hint: PAGE_POSTS_GONE,
  },
  {
    metric: 'page_posts_impressions_paid_unique',
    removedOn: '2026-06-15',
    hint: PAGE_POSTS_GONE,
  },
  {
    metric: 'page_posts_impressions_organic_unique',
    removedOn: '2026-06-15',
    hint: PAGE_POSTS_GONE,
  },
  {
    metric: 'page_posts_impressions_viral',
    removedOn: '2026-06-15',
    hint: PAGE_POSTS_GONE,
  },
  {
    metric: 'page_posts_impressions_viral_unique',
    removedOn: '2026-06-15',
    hint: PAGE_POSTS_GONE,
  },
  {
    metric: 'page_posts_impressions_nonviral',
    removedOn: '2026-06-15',
    hint: PAGE_POSTS_GONE,
  },
  {
    metric: 'page_posts_impressions_nonviral_unique',
    removedOn: '2026-06-15',
    hint: PAGE_POSTS_GONE,
  },
  {
    metric: 'post_impressions_unique',
    replacement: 'post_total_media_view_unique',
    removedOn: '2026-06-15',
    deprecatedAbove: 'v25.0',
    hint: '"post_media_view" is the non-deduplicated alternative.',
  },
  {
    metric: 'post_impressions_paid_unique',
    removedOn: '2026-06-15',
    hint: POST_UNIQUE_GONE,
  },
  {
    metric: 'post_impressions_fan_unique',
    removedOn: '2026-06-15',
    hint: POST_UNIQUE_GONE,
  },
  {
    metric: 'post_impressions_organic_unique',
    removedOn: '2026-06-15',
    hint: POST_UNIQUE_GONE,
  },
  {
    metric: 'post_impressions_viral_unique',
    removedOn: '2026-06-15',
    hint: POST_UNIQUE_GONE,
  },
  {
    metric: 'post_impressions_nonviral_unique',
    removedOn: '2026-06-15',
    hint: POST_UNIQUE_GONE,
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
  ...TOTAL_VIDEO_REMOVED.map((metric): DeprecatedMetric => ({
    metric,
    removedOn: '2026-06-15',
  })),
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
