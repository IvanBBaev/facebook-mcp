// The `insights` tool package (task V02) — Page-, post- and Reel-level Graph
// insights, reshaped into a compact, flat, model-readable row shape.
//
//   * facebook_page_insights — `/{page-id}/insights`: a metric list over a
//     since/until window (max 90 days), as flat rows or per-metric totals.
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
// is re-derived here, and no date/metric validation is duplicated (the one date
// rule added here — a window starting after tomorrow — is one the api module
// does not make; see `assertWindowHasPast`) — a malformed
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

import { GraphApiError, classifyGraphError } from '../core/index.js';
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
import { profileArg, shapeFor, videoIdArg } from './shared.js';

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
 * name (the api module re-reads the rest only when Graph names the rejected
 * entry), so a huge list is also a huge blast radius; a bounded list keeps the
 * result inside the char budget and keeps isolation cheap.
 */
const MAX_METRICS = 20;

/** Rejection for a comma-packed metric entry (see {@link metricsArg}). */
const PACKED_METRIC_MESSAGE =
  'Pass one metric name per array entry, e.g. ["page_media_view","page_follows"], not a comma-separated string: a packed entry skips the renamed-metric check (one dead name then fails the whole Graph call) and cannot be matched against the metrics Graph returns.';

/**
 * Metric names to read. Trimmed and lower-cased before anything else looks at
 * them: Graph's metric names are lower-case snake_case, so a stray "Page_Fans "
 * would otherwise miss the rename table AND be reported as an unknown metric
 * after Graph echoed the canonical name back.
 */
const metricsArg = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .min(1)
      // The api module joins the list with commas for the wire, so a comma
      // inside one entry is several names the rename table, the cap and the
      // returned-name check each see as one — the reply would carry the rows
      // next to a note calling the (packed) name invalid.
      .refine((name) => !name.includes(','), PACKED_METRIC_MESSAGE),
  )
  .min(1)
  .max(MAX_METRICS)
  .describe(
    `Graph insights metric names to read, e.g. ["page_media_view","page_follows"] (1-${String(MAX_METRICS)} per call; trimmed and lower-cased). Names are Graph-version dependent and Meta renamed most of them in the 2024-09, 2025-11 and 2026-06 waves: pre-wave names such as "page_impressions" or "page_fans" are dropped before the request and answered with their replacement instead of an error. Graph fails the WHOLE call when one surviving name is invalid: when Graph says which entry it rejected, that name is dropped, the rest are re-read and it is reported in rejectedMetrics; otherwise isolate a suspect name by requesting it alone. Page metrics (page_*) are read on the Page, post metrics (post_*) on a post or Reel.`,
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
    `Start of the window as a calendar date "YYYY-MM-DD" (inclusive, Page timezone). Omitted ⇒ Graph's own default window. The since..until span may not exceed ${String(INSIGHTS_MAX_WINDOW_DAYS)} days per call (checked before the request); read longer histories in slices.`,
  );

const untilArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    'End of the window as a calendar date "YYYY-MM-DD". Each returned `date` is the END of the period the value covers, so a window reaching today ends in a partial, still-being-computed bucket. Omitted ⇒ today.',
  );

const aggregateArg = z
  .boolean()
  .optional()
  .describe(
    'True ⇒ return per-metric totals only (period, points, total, first/last boundary) and NO per-point rows. Use it for wide windows or many metrics: it is the cheapest way to stay inside the result budget when a daily series would otherwise be truncated. `total` is a sum for disjoint periods (day, month, total_over_range); for the overlapping ones (week, days_28, lifetime) it is the latest point, flagged totalIsLatest.',
  );

const maxRowsArg = z
  .number()
  .int()
  .min(1)
  .max(INSIGHTS_MAX_ROWS)
  .optional()
  .describe(
    `Lower the per-point row cap for this call (1-${String(INSIGHTS_MAX_ROWS)}; the default and the ceiling are both ${String(INSIGHTS_MAX_ROWS)} — this argument can only shrink it). Rows past the cap are dropped and the result reports how many; prefer aggregate:true over a tiny cap when you only need totals.`,
  );

/**
 * Post IDs are `{page-id}_{post-id}`; a permalink URL is the classic mistake.
 *
 * Digits only, optionally joined by one `_`. This is PATH CONTAINMENT, not
 * cosmetics: the ID is interpolated into `/{objectId}/insights`, so a Page
 * username (`mybrandpage`) would resolve to the PAGE's insights edge, and a
 * dot segment (`..`) would be normalized by the WHATWG URL parser into a path
 * outside the pinned API version. Every post ID Graph issues is numeric, so no
 * real ID is refused. A bare number passes the shape and is refused just below
 * with its own message.
 */
const POST_ID_SHAPE = /^\d+(?:_\d+)?$/;

/**
 * A bare number is never a Page post on `/{id}/insights`: it is the un-prefixed
 * half of a composite ID, or a video / photo object ID. Graph answers it with a
 * generic "Unsupported get request" (code 100) or an empty series that says
 * nothing about the shape, so it is refused here — the mirror of the Reel tool
 * refusing a composite (`VIDEO_ID_SHAPE` in `./shared.js`).
 */
const BARE_NUMERIC_ID = /^\d+$/;

const BARE_POST_ID_MESSAGE =
  'Expected the composite "{page-id}_{post-id}" post ID (e.g. "111222333_999"), not a bare number: a bare number is a video or photo ID, or the post half without its Page prefix, and does not resolve on /insights. Pass the `id` facebook_list_posts / facebook_get_post return verbatim; for a Reel or video use facebook_reel_insights with its video ID.';

const postIdArg = z
  .string()
  .trim()
  .min(1)
  .regex(
    POST_ID_SHAPE,
    'Expected a numeric post ID such as "111222333_999", not a Page username, a URL, a permalink or a query string. Get the ID from facebook_list_posts or facebook_get_post.',
  )
  .refine((id) => !BARE_NUMERIC_ID.test(id), BARE_POST_ID_MESSAGE)
  .describe(
    'The published post to read, as Graph\'s "{page-id}_{post-id}" ID (as returned by facebook_list_posts / facebook_get_post). Permalink URLs and bare numeric IDs are rejected before any request — a bare number is a video/photo ID (see facebook_reel_insights), not a post. The post must belong to the resolved Page, whose token authorizes the read.',
  );

/**
 * The Reel id argument. The SHAPE and the rejection wording come from
 * `./shared.js` so that every video edge in the server — this one and
 * `facebook_get_video_status` — refuses exactly the same ids for exactly the
 * same stated reason; only the prose below is specific to `/video_insights`.
 */
const reelVideoIdArg = videoIdArg({
  hint: 'List existing Reels with facebook_list_reels (each item `id` is the video id); facebook_create_reel returns it as `videoId`; facebook_list_posts does NOT list Reels at all, so there is no post ID to convert.',
  description:
    'The Reel to read, as its VIDEO id — the item `id` from facebook_list_reels, or the `videoId` returned by facebook_create_reel (also echoed by facebook_get_video_status). A "{page-id}_{post-id}" value is a post, not a video, and does not resolve on the /video_insights edge. The Reel must belong to the resolved Page, whose token authorizes the read.',
});

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

/** A `{page-id}_{post-id}` composite whose halves are both numeric. */
const NUMERIC_COMPOSITE = /^(\d+)_\d+$/;

/**
 * Refuse a post whose composite ID names a different Page than the one the
 * profile resolved to. The read runs with the RESOLVED Page's token, which
 * cannot read another Page's post: Graph answers with a generic permission or
 * "object does not exist" error that never says the profile is the problem, so
 * the model is sent to re-check permissions instead of switching `profile`.
 * Only a fully numeric composite against a numeric Page ID is compared — any
 * other shape is left for Graph to judge rather than refused on a guess.
 */
function assertPostOnResolvedPage(postId: string, pageId: string): void {
  const postPageId = NUMERIC_COMPOSITE.exec(postId)?.[1];
  if (postPageId === undefined || !/^\d+$/.test(pageId) || postPageId === pageId) return;
  throw new Error(
    `Post "${postId}" belongs to Page ${postPageId}, but the resolved Page is ${pageId}; its token cannot read another Page's post insights. Pass \`profile\` for Page ${postPageId} (a configured profile key or the raw Page ID — facebook_list_pages lists the Pages this token manages), or pass a post ID of Page ${pageId}.`,
  );
}

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` — the only date form the api module accepts for `since`. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Refuse a window that starts after tomorrow (UTC) — before any request.
 *
 * Graph does not reject such a window: it answers with empty series, and an
 * all-empty result is exactly what the api module's notes explain as the
 * eligibility floor, publish lag or a missing permission. For days that have
 * not happened yet every one of those explanations is false, and the model is
 * sent to check follower counts and token scopes over a typo in the year.
 *
 * The api module's window check does not catch it: a lone `since` is measured
 * against today there, but an explicit future `until` makes the window
 * well-ordered and inside the cap. Tomorrow (UTC) is still allowed because the
 * dates are read in the Page's timezone, which can be up to 14 hours ahead of
 * UTC — "tomorrow" there may already be today. A malformed or impossible date
 * is left alone so the api module's one validation message reports it.
 */
function assertWindowHasPast(since: string | undefined, nowMs: number): void {
  if (since === undefined || !DATE_ONLY.test(since)) return;
  const sinceMs = Date.parse(`${since}T00:00:00Z`);
  if (Number.isNaN(sinceMs) || new Date(sinceMs).toISOString().slice(0, 10) !== since) {
    return;
  }
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const tomorrowMs = Date.parse(`${today}T00:00:00Z`) + MS_PER_DAY;
  if (sinceMs <= tomorrowMs) return;
  const message = `Invalid window: \`since\` (${since}) is in the future — today is ${today} (UTC), so no day in the window has happened yet and Graph would answer with empty series that read like an ineligible Page or zero engagement. Pass a \`since\` on or before today.`;
  throw new GraphApiError(message, {
    code: 100,
    httpStatus: 400,
    action: classifyGraphError({ code: 100, message }),
  });
}

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
  // Before the Page is resolved: a window with no past day in it needs no
  // token, and no request should be spent on it.
  assertWindowHasPast(input.since, ctx.clock.now());
  const resolved = await ctx.pages.resolvePage(input.profile);
  if (scope === 'post' && objectId !== undefined) {
    assertPostOnResolvedPage(objectId, resolved.pageId);
  }
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
  // No tool in this package declares `logFields`, for a structural reason
  // rather than squeamishness: the argument that identifies an insights call is
  // `metrics`, and the log projection can only render an array as "[array]"
  // (see the bootstrap's field projection). A line carrying a period and a date
  // window with no subject is not evidence, and these reads touch neither
  // visitor-authored content nor money — so silence is the honest posture.
  const pageInsights = defineTool({
    name: 'facebook_page_insights',
    title: 'Page Insights',
    description:
      'Read Graph insights for one Page in a compact flat shape: one row per ' +
      'metric per data point ({metric, date, value}, plus `breakdown` for ' +
      'by-action-type metrics) and one summary per metric (period, points, ' +
      'total). Set aggregate:true for totals only. The window is since/until ' +
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
      'shape as facebook_page_insights: rows plus per-metric summaries, or totals ' +
      'only with aggregate:true. The default period is "lifetime" — one ' +
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
      'reach. Takes the VIDEO id (digits only, as listed by facebook_list_reels ' +
      'or returned by facebook_create_reel), NOT a "{page-id}_{post-id}" post ID. Same compact ' +
      'shape as the other insights tools: flat rows plus one summary per metric, ' +
      'or totals only with aggregate:true. The default period is "lifetime", ' +
      'because plays and watch time are cumulative counters rather than a daily ' +
      'series. Metric names are their own vocabulary — page/post names do not ' +
      "transfer — and Meta's reference lists blue_reels_play_count, " +
      'post_video_avg_time_watched, post_video_view_time, ' +
      'post_video_likes_by_reaction_type and post_video_social_actions among ' +
      'others; they are examples, not a whitelist, so a name Graph never mentions ' +
      'is reported as unavailable rather than silently dropped. Empty series ' +
      'usually mean the wrong ID, a Reel that is not PUBLISHED yet, or the usual ' +
      'insights lag — the result says which to check.',
    inputSchema: z.object({ ...insightsArgs, video_id: reelVideoIdArg }),
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
