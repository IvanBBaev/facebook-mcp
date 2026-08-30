// The `insights` tool package (task V02) — Page-, post- and Reel-level Graph
// insights, reshaped into a compact, flat, model-readable row shape.
//
//   * facebook_page_insights — `/{page-id}/insights`: a metric list over a
//     since/until window (max 90 days), as flat rows or semantics-aware summaries.
//   * facebook_post_insights — `/{post-id}/insights`: the same reshape for one
//     published post.
//   * facebook_reel_insights — `/{video-id}/video_insights`: the same reshape
//     for one Reel (G-TOOL-2).
//
// All three tools are READ-ONLY — `readOnlyHint:true` ⇔ no `writeTier`, the
// quadruple doc 06 "Package `insights`" pins (RO true / D false / I true /
// OW true) — so this package never touches the write gate.
//
// Division of labour with `../api/insights.js` follows the layer rule
// (core ← api ← mcp ← tools): the api module owns the Graph call, the RESHAPE
// CONTRACT (flat rows + one summary per metric), the row cap, the 90-day window
// check, the metric rename/deprecation table and the honesty notes; this module
// owns the zod schemas, the model-facing prose and the result shaping. Nothing
// is re-derived here, and no date/metric validation is duplicated — a malformed
// `since` produces the api module's one actionable message, not a zod issue and
// an api message that disagree with each other.
//
// Reels get their OWN tool rather than ID-sniffing inside `post_insights`
// (G-TOOL-2, the routing decision doc 10 left open). Three reasons, all of them
// about not surprising the caller: the ID space is different (a bare video ID,
// not a `{page-id}_{post-id}` composite), the metric vocabularies are disjoint,
// and a tool that silently reads a different edge than the one its name promises
// is exactly the behaviour this server avoids elsewhere. The post tool keeps
// saying where Reel metrics live, because a Reel ID on the post edge answers
// with empty series — and an empty series is what a model reads as "no
// engagement" (CC-INS-6).
//
// Not verified live yet: like every other tool here, the Reel path is exercised
// against fixtures only until the 1.0 verification pass runs it against a real
// Page (doc 10 §1). The metric names in the description are therefore examples
// from Meta's reference, not a whitelist — the api module passes unknown names
// straight through and reports the ones Graph never mentions.

import { z } from 'zod';

import type {
  PackageSpec,
  ToolAnnotations,
  ToolContext,
  ToolResult,
} from '../core/index.js';
import {
  INSIGHTS_MAX_ROWS,
  INSIGHTS_MAX_WINDOW_DAYS,
  fetchInsights,
  type InsightsScope,
} from '../api/insights.js';
import { defineTool } from '../mcp/index.js';
import { profileArg, shapeFor } from './shared.js';

// ---------------------------------------------------------------------------
// Shared annotation quadruple — both insights tools are read-only (doc 06).
// ---------------------------------------------------------------------------

/**
 * The MCP annotation quadruple shared by both `insights` tools: read-only,
 * non-destructive, idempotent, open-world (both read a live external system).
 * `readOnlyHint:true` ⇔ `writeTier` absent, which `defineTool` enforces.
 */
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

// ---------------------------------------------------------------------------
// Input fields
// ---------------------------------------------------------------------------

/**
 * Metric names Graph accepts on the insights edge, as a closed vocabulary. This
 * IS a whitelist — unlike the metric list, `period` is a small fixed set Graph
 * has not extended in years, and an invented value ("daily", "monthly") is a
 * far more likely model error than a genuinely new period.
 */
const INSIGHTS_PERIODS = [
  'day',
  'week',
  'days_28',
  'month',
  'lifetime',
  'total_over_range',
] as const;

/**
 * Cap on metric names per call. Graph fails the WHOLE call over one invalid
 * name, so a huge list is also a huge blast radius; a bounded list keeps the
 * result inside the char budget and keeps isolation cheap.
 */
const MAX_METRICS = 20;

/**
 * Metric names to read. Trimmed and lower-cased before anything else looks at
 * them: Graph's metric names are lower-case snake_case, so a stray "Page_Fans "
 * would otherwise miss the rename table AND be reported as an unknown metric
 * after Graph echoed the canonical name back.
 */
const metricsArg = z
  .array(z.string().trim().toLowerCase().min(1))
  .min(1)
  .max(MAX_METRICS)
  .describe(
    `Graph insights metric names to read, e.g. ["page_media_view","page_follows"] (1-${String(MAX_METRICS)} per call; trimmed and lower-cased). Names are Graph-version dependent and Meta renamed most of them in the 2024-09, 2025-11 and 2026-06 waves: pre-wave names such as "page_impressions" or "page_fans" are dropped before the request and answered with their replacement instead of an error. Graph fails the WHOLE call when one surviving name is invalid, so isolate a suspect name by requesting it alone.`,
  );

const periodArg = z
  .enum(INSIGHTS_PERIODS)
  .optional()
  .describe(
    'Aggregation window Graph applies per data point. "day" is a daily series (the Page default); "lifetime" is one cumulative value per metric (the post default); "week"/"days_28" are rolling windows; "month" is calendar-monthly; "total_over_range" collapses since..until into a single value. Not every metric supports every period — a metric queried with an unsupported period comes back empty, which the notes call out.',
  );

const sinceArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    `Start boundary as a calendar date "YYYY-MM-DD" (inclusive). Insights uses a [since, until) range; Page period=day boundaries are Pacific Time. Omitted ⇒ Graph's own default window. The elapsed since..until span may not exceed ${String(INSIGHTS_MAX_WINDOW_DAYS)} days per call (checked before the request); read longer histories in slices.`,
  );

const untilArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Exclusive end boundary as a calendar date "YYYY-MM-DD". Insights uses [since, until): for Page period=day, an until of 2026-08-30 includes the 2026-08-29 Pacific day but not 2026-08-30. Each returned `date` is Graph\'s exclusive end boundary. Omitted ⇒ Graph\'s default/live tail.',
  );

const aggregateArg = z
  .boolean()
  .optional()
  .describe(
    'True ⇒ return per-metric summaries only and NO per-point rows. The summary is semantics-aware: non-overlapping flow buckets may be summed, gauge/snapshot metrics use the latest value, rolling windows are not double-counted, and unknown multi-point metrics are left unaggregated rather than guessed. Use it for wide windows or many metrics when the daily rows would otherwise be truncated.',
  );

const maxRowsArg = z
  .number()
  .int()
  .min(1)
  .max(INSIGHTS_MAX_ROWS)
  .optional()
  .describe(
    `Lower the per-point row cap for this call (1-${String(INSIGHTS_MAX_ROWS)}; the default and the ceiling are both ${String(INSIGHTS_MAX_ROWS)} — this argument can only shrink it). Rows past the cap are dropped and the result reports how many; prefer aggregate:true over a tiny cap when you only need per-metric summaries.`,
  );

/**
 * Post IDs are `{page-id}_{post-id}`; a permalink URL is the classic mistake.
 *
 * The `(?=.*\w)` lookahead is PATH CONTAINMENT, not cosmetics: the ID is
 * interpolated into `/{objectId}/insights`, and the WHATWG URL parser resolves
 * dot segments when that path is assigned — `".."` would turn `/v23.0/../insights`
 * into `/insights`, silently escaping the pinned API version, and `"."` would
 * drop the segment entirely. `/` and `%` are already outside the class, so
 * demanding one word character rules out every dot-segment spelling that is
 * left ("." and ".." and nothing else).
 */
const POST_ID_SHAPE = /^(?=.*\w)[\w.-]+$/;

const postIdArg = z
  .string()
  .trim()
  .min(1)
  .regex(
    POST_ID_SHAPE,
    'Expected a post ID such as "111222333_999", not a URL, a permalink or a query string. Get the ID from facebook_list_posts or facebook_get_post.',
  )
  .describe(
    'The published post to read, as Graph\'s "{page-id}_{post-id}" ID (as returned by facebook_list_posts / facebook_get_post). Permalink URLs are rejected. The post must belong to the resolved Page, whose token authorizes the read.',
  );

/**
 * Reel/video IDs are bare decimal Graph node IDs. Digits-only is both the true
 * shape and the strictest possible path containment for `/{videoId}/…` — no dot
 * segment, no slash, no percent-escape can survive it — and it rejects the one
 * mistake this edge invites: handing it the `{page-id}_{post-id}` composite,
 * which addresses a POST and answers `/video_insights` with nothing useful.
 */
const VIDEO_ID_SHAPE = /^\d+$/;

const videoIdArg = z
  .string()
  .trim()
  .min(1)
  .regex(
    VIDEO_ID_SHAPE,
    'Expected the bare VIDEO id (digits only, e.g. "1234567890"), not a "{page-id}_{post-id}" post ID, a permalink or a URL. facebook_create_reel returns it as `videoId`; facebook_list_posts does NOT list Reels at all, so there is no post ID to convert.',
  )
  .describe(
    'The Reel to read, as its VIDEO id — the `videoId` returned by facebook_create_reel (also echoed by facebook_get_video_status). A "{page-id}_{post-id}" value is a post, not a video, and does not resolve on the /video_insights edge. The Reel must belong to the resolved Page, whose token authorizes the read.',
  );

/** The fields all three tools share, spread into each tool's own `z.object`. */
const insightsArgs = {
  profile: profileArg,
  metrics: metricsArg,
  period: periodArg,
  since: sinceArg,
  until: untilArg,
  aggregate: aggregateArg,
  max_rows: maxRowsArg,
} as const;

// ---------------------------------------------------------------------------
// Shared handler
// ---------------------------------------------------------------------------

/**
 * The parsed input both handlers consume. Optional members are written
 * `T | undefined` rather than a bare `?:` because `exactOptionalPropertyTypes`
 * makes zod's inferred `{ x?: T | undefined }` incompatible with `{ x?: T }`.
 */
interface InsightsInput {
  readonly profile?: string | undefined;
  readonly metrics: readonly string[];
  readonly period?: string | undefined;
  readonly since?: string | undefined;
  readonly until?: string | undefined;
  readonly aggregate?: boolean | undefined;
  readonly max_rows?: number | undefined;
}

/**
 * The result key each scope reports its object under. A Reel is addressed by a
 * VIDEO id, not a post ID, and echoing it as `postId` would hand the model back
 * the very confusion the input schema just refused.
 */
const OBJECT_KEY: Readonly<Record<InsightsScope, 'pageId' | 'postId' | 'videoId'>> = {
  page: 'pageId',
  post: 'postId',
  reel: 'videoId',
};

/**
 * Resolve the Page, read the insights edge and shape the reshaped result.
 *
 * `objectId` selects the object: absent ⇒ the resolved Page itself, present ⇒
 * that post or Reel — the Page token still authorizes the read either way (C1),
 * which is why the post and Reel tools resolve a profile too. Errors (an
 * over-wide window, a Graph metric rejection) propagate: the server maps them
 * through the F06 matrix into a redacted error result, so swallowing them here
 * would only hide the actionable text the api module worked to produce.
 */
async function readInsights(
  ctx: ToolContext,
  input: InsightsInput,
  scope: InsightsScope,
  objectId?: string,
): Promise<ToolResult> {
  const resolved = await ctx.pages.resolvePage(input.profile);
  const result = await fetchInsights(ctx.fbRequest, {
    scope,
    objectId: objectId ?? resolved.pageId,
    metrics: input.metrics,
    ...(input.period !== undefined ? { period: input.period } : {}),
    ...(input.since !== undefined ? { since: input.since } : {}),
    ...(input.until !== undefined ? { until: input.until } : {}),
    ...(input.aggregate !== undefined ? { aggregate: input.aggregate } : {}),
    ...(input.max_rows !== undefined ? { maxRows: input.max_rows } : {}),
    token: resolved.token,
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    // The injected clock, never Date.now(): the freshness note and the span of
    // a lone `since` both depend on "now" and must stay testable.
    nowMs: ctx.clock.now(),
  });
  return shapeFor(ctx, {
    profile: input.profile ?? null,
    pageId: resolved.pageId,
    ...(objectId !== undefined ? { [OBJECT_KEY[scope]]: objectId } : {}),
    ...result,
  });
}

// ---------------------------------------------------------------------------
// Package factory
// ---------------------------------------------------------------------------

/**
 * Build the `insights` package: two read-only tools, on by default (doc 06 —
 * `insights` is part of the default profile expansion).
 */
export function createInsightsPackage(): PackageSpec {
  const pageInsights = defineTool({
    name: 'facebook_page_insights',
    title: 'Page Insights',
    description:
      'Read Graph insights for one Page in a compact flat shape: one row per ' +
      'metric per data point ({metric, date, value}, plus `breakdown` for ' +
      'by-action-type metrics) and one semantics-aware summary per metric. ' +
      'Summaries state their aggregation method; follower stock/gauges are never ' +
      'summed, rolling windows are not double-counted, and unknown multi-point ' +
      'metrics are left unaggregated rather than guessed. Set aggregate:true to ' +
      'omit rows and return summaries only. The window is [since, until), with ' +
      `calendar dates, at most ${String(INSIGHTS_MAX_WINDOW_DAYS)} days per call. ` +
      'Metric names renamed by the 2024-09 / 2025-11 / 2026-06 waves are answered ' +
      'with their replacement instead of a Graph error, and a metric Graph ' +
      'accepts but has no data for is reported separately from a name Graph does ' +
      'not know. Empty series usually mean the eligibility floor (a Page under ' +
      '100 followers) or a token missing read_insights + the ANALYZE Page task — ' +
      'not zero engagement; the result says which. Reel metrics are NOT available ' +
      'here: they live on /{video-id}/video_insights — use facebook_reel_insights ' +
      'for those.',
    inputSchema: z.object(insightsArgs),
    annotations: READ_ONLY,
    handler: async (input, ctx) => readInsights(ctx, input, 'page'),
  });

  const postInsights = defineTool({
    name: 'facebook_post_insights',
    title: 'Post Insights',
    description:
      'Read Graph insights for one published post (post_media_view, post_clicks, ' +
      'post_reactions_by_type_total, video metrics, ...) in the same compact flat ' +
      'shape as facebook_page_insights: rows plus semantics-aware per-metric ' +
      'summaries, or summaries only with aggregate:true. The default period is ' +
      '"lifetime" — one ' +
      'cumulative value per metric. Post metrics lag minutes to hours after ' +
      'publishing, so empty series on a fresh post are normal and are flagged as ' +
      'such rather than reported as zeros. Reel metrics are NOT reachable through ' +
      'this tool: they live on /{video-id}/video_insights, a different edge — a ' +
      'Reel ID here returns empty series, never Reel numbers. Use ' +
      'facebook_reel_insights with the VIDEO id instead.',
    inputSchema: z.object({ ...insightsArgs, post_id: postIdArg }),
    annotations: READ_ONLY,
    handler: async (input, ctx) => readInsights(ctx, input, 'post', input.post_id),
  });

  const reelInsights = defineTool({
    name: 'facebook_reel_insights',
    title: 'Reel Insights',
    description:
      'Read Graph insights for one Reel from /{video-id}/video_insights — the ' +
      'edge Reel metrics actually live on, which facebook_post_insights cannot ' +
      'reach. Takes the VIDEO id (digits only, as returned by ' +
      'facebook_create_reel), NOT a "{page-id}_{post-id}" post ID. Same compact ' +
      'shape as the other insights tools: flat rows plus one semantics-aware ' +
      'summary per metric, or summaries only with aggregate:true. The default ' +
      'period is "lifetime", ' +
      'because plays and watch time are cumulative counters rather than a daily ' +
      'series. Metric names are their own vocabulary — page/post names do not ' +
      "transfer — and Meta's reference lists blue_reels_play_count, " +
      'post_video_avg_time_watched, post_video_view_time, ' +
      'post_video_likes_by_reaction_type and post_video_social_actions among ' +
      'others; they are examples, not a whitelist, so a name Graph never mentions ' +
      'is reported as unavailable rather than silently dropped. Empty series ' +
      'usually mean the wrong ID, a Reel that is not PUBLISHED yet, or the usual ' +
      'insights lag — the result says which to check.',
    inputSchema: z.object({ ...insightsArgs, video_id: videoIdArg }),
    annotations: READ_ONLY,
    handler: async (input, ctx) => readInsights(ctx, input, 'reel', input.video_id),
  });

  return {
    name: 'insights',
    title: 'Insights',
    description:
      'Page, post and Reel insights: compact reshaped metric series, aggregate ' +
      'totals and post-2025 metric-rename guidance (read-only).',
    tools: [pageInsights, postInsights, reelInsights],
    enabledByDefault: true,
  };
}
