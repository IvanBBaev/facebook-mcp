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
//      plus one summary row per metric (period, points, kind, aggregation and
//      the one safe scalar `value`, when there is one). `title`,
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
//
// X09 (ARC-09): the module is split by concern into src/api/insights/*; this
// barrel re-exports the public surface unchanged.

export {
  INSIGHTS_CONTRACT_VERSION,
  INSIGHTS_MAX_ROWS,
  INSIGHTS_MAX_WINDOW_DAYS,
  INSIGHTS_WINDOW_BOUNDARY,
  META_INSIGHTS_TIMEZONE,
  PAGE_INSIGHTS_LIKES_FLOOR,
} from './limits.js';
export {
  FRESHNESS_NOTE,
  INSIGHTS_TOKEN_EMPTY_HINT,
  PAGE_ELIGIBILITY_NOTE,
  PAGE_TIMEZONE_NOTE,
  PERIOD_BOUNDARY_NOTE,
  POST_EMPTY_NOTE,
  REEL_EMPTY_NOTE,
} from './notes.js';
export { canonicalMetricName, classifyMetric, classifyMetrics } from './deprecations.js';
export type { DeprecatedMetric, MetricStatus, MetricVerdict } from './deprecations.js';
export type {
  InsightRow,
  InsightsScope,
  MetricAggregation,
  MetricKind,
  MetricSummary,
  ReshapedInsights,
} from './model.js';
export { capRows, reshapeInsights } from './reshape.js';
export type { CappedRows, InsightExportRow } from './reshape.js';
export {
  checkWindow,
  insightsDate,
  insightsTimezone,
  previousWindow,
  scopeToday,
} from './window.js';
export type { InsightsWindow } from './window.js';
export { deriveFollowerReconciliation } from './followers.js';
export type { FollowerReconciliation, InsightsDerived } from './followers.js';
export { fetchInsights } from './read.js';
export type { InsightsRequest, InsightsResult, RejectedMetric } from './read.js';
