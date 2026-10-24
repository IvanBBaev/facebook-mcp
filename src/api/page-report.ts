// Page report (v2 insights F2) — one read that answers "how did my Page do over
// the last N days, compared with the N days before?".
//
// The report is assembled from reads the server already makes elsewhere:
//
//   1–2. `GET /{page}/insights?period=day` for the current and previous window:
//        follower stock + daily flows (reconciled by F1), views, engagement and
//        Page views — every one of them a disjoint daily flow, so a sum is safe.
//   3–4. `GET /{page}/insights?metric=page_total_media_view_unique` with the
//        rolling `week` / `days_28` period ending at `until`. Reach is a unique
//        audience: daily uniques overlap, so they are NEVER summed or averaged.
//        Any other span has no exact reach, and the report says so.
//   5–8. `GET /{page}/published_posts` (newest first, ≤4 pages of 50), stopped
//        once a post predates the window, filtered to `[since, until)`.
//   +K.  Lifetime post insights for the top K posts, three at a time.
//
// Failure isolation: only the current-window insights read is load-bearing.
// The comparison, the reach, the post scan and each post's insights degrade to
// a note or a per-section error instead of failing the whole report.

import { GraphApiError, classifyGraphError } from '../core/index.js';
import type { FbRequestFn } from '../core/index.js';
import {
  INSIGHTS_MAX_WINDOW_DAYS,
  PAGE_ELIGIBILITY_NOTE,
  checkWindow,
  fetchInsights,
  insightsDate,
  previousWindow,
  type FollowerReconciliation,
  type InsightsResult,
  type InsightsWindow,
  type MetricSummary,
} from './insights.js';
import { normalizeNode, type GraphRecord } from './posts-read.js';
import { fetchPage } from './shared.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const REPORT_WINDOWS = [
  'last_7_days',
  'last_28_days',
  'last_90_days',
  'custom',
] as const;

export type ReportWindow = (typeof REPORT_WINDOWS)[number];

export const DEFAULT_REPORT_WINDOW: ReportWindow = 'last_28_days';

const PRESET_DAYS: Readonly<Record<Exclude<ReportWindow, 'custom'>, number>> = {
  last_7_days: 7,
  last_28_days: 28,
  last_90_days: 90,
};

export const TOP_POST_RANKINGS = [
  'engagement',
  'reactions',
  'comments',
  'shares',
] as const;

export type TopPostRanking = (typeof TOP_POST_RANKINGS)[number];

export const DEFAULT_TOP_POSTS = 5;
export const MAX_TOP_POSTS = 10;

/** The daily-period Page metrics read for each window. */
export const REPORT_DAY_METRICS = [
  'page_follows',
  'page_daily_follows',
  'page_daily_unfollows',
  'page_daily_unfollows_unique',
  'page_media_view',
  'page_post_engagements',
  'page_views_total',
] as const;

export const REACH_METRIC = 'page_total_media_view_unique';

/** Lifetime metrics read for each top post. */
export const TOP_POST_METRICS = [
  'post_media_view',
  'post_total_media_view_unique',
  'post_clicks',
] as const;

export const TOP_POST_FIELDS =
  'id,created_time,message,permalink_url,shares,' +
  'comments.limit(0).summary(total_count),reactions.limit(0).summary(total_count)';

const POSTS_PAGE_LIMIT = 50;
const POSTS_MAX_PAGES = 4;
const POST_INSIGHTS_CONCURRENCY = 3;
const EXCERPT_CHARS = 120;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const TOP_POSTS_NOTE =
  'Top posts are posts PUBLISHED in the window, ranked by lifetime counts as of now — not engagement that happened inside the window.';

export function reachNote(period: 'week' | 'days_28'): string {
  return `Reach is a unique-audience count from Meta's rolling ${period} window ending at \`until\`; daily uniques are never summed.`;
}

export function reachUnavailableNote(days: number): string {
  return `There is no exact reach for a ${String(days)}-day window: Meta exposes unique reach only as 1/7/28-day rolling windows, and daily uniques cannot be added up. Use last_7_days or last_28_days for a reach figure.`;
}

export const SCAN_TRUNCATED_NOTE = `The published_posts scan stopped after ${String(POSTS_MAX_PAGES * POSTS_PAGE_LIMIT)} posts before reaching the start of the window, so older posts in the window were not ranked.`;

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface ReportDelta {
  readonly abs: number;
  /** Percent change, one decimal; `null` when the previous value is 0. */
  readonly pct: number | null;
}

export interface ReportWindowView {
  readonly since: string;
  readonly until: string;
  readonly days: number;
}

export interface FollowersSection extends FollowerReconciliation {
  readonly previous?: { readonly stockChange?: number; readonly netFlow?: number };
  readonly delta?: ReportDelta;
}

export interface ReachSection {
  readonly method: 'rolling_window' | 'unavailable';
  readonly metric: typeof REACH_METRIC;
  readonly period?: 'week' | 'days_28';
  readonly value?: number;
  readonly previous?: number;
  readonly delta?: ReportDelta;
  readonly note?: string;
}

export interface FlowSection {
  readonly value: number;
  readonly method: 'sum';
  readonly metric: string;
  readonly previous?: number;
  readonly delta?: ReportDelta;
}

export interface TopPost {
  readonly postId: string;
  readonly createdTime: string;
  readonly permalinkUrl?: string;
  readonly excerpt?: string;
  readonly reactions: number;
  readonly comments: number;
  readonly shares: number;
  readonly engagement: number;
  readonly insights?: Readonly<Record<string, number>>;
  readonly insightsError?: { readonly code: number };
}

export type TopPostsSection =
  | {
      readonly rankedBy: TopPostRanking;
      readonly scanned: number;
      readonly scanTruncated: boolean;
      readonly items: readonly TopPost[];
    }
  | { readonly error: { readonly code: number; readonly message: string } };

export interface PageReport {
  readonly window: InsightsWindow;
  readonly previousWindow?: ReportWindowView;
  readonly followers?: FollowersSection;
  readonly reach: ReachSection;
  readonly views?: FlowSection;
  readonly engagement?: FlowSection;
  readonly pageViews?: FlowSection;
  readonly topPosts?: TopPostsSection;
  readonly eligible: boolean;
  readonly notes: readonly string[];
}

export interface PageReportOptions {
  readonly pageId: string;
  readonly token?: string;
  readonly window: InsightsWindow;
  readonly compare: boolean;
  readonly topPosts: number;
  readonly topBy: TopPostRanking;
  readonly nowMs: number;
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** A client-side parameter error, classified through the shared matrix (code 100). */
function validationError(message: string): GraphApiError {
  return new GraphApiError(message, {
    code: 100,
    httpStatus: 400,
    action: classifyGraphError({ code: 100, message }),
  });
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/**
 * Resolve the report window. A preset ends at today in Pacific Time
 * (exclusive), so the partial current day is never part of it; `custom` takes
 * `since` and `until` verbatim and needs both.
 *
 * @throws GraphApiError (validation) on a bad combination or span.
 */
export function resolveReportWindow(input: {
  readonly window: ReportWindow;
  readonly since?: string;
  readonly until?: string;
  readonly nowMs: number;
}): InsightsWindow {
  if (input.window === 'custom') {
    if (input.since === undefined || input.until === undefined) {
      throw validationError(
        'window "custom" needs both `since` (inclusive) and `until` (exclusive), as YYYY-MM-DD.',
      );
    }
    return checkWindow({
      scope: 'page',
      since: input.since,
      until: input.until,
      nowMs: input.nowMs,
      maxDays: INSIGHTS_MAX_WINDOW_DAYS,
    });
  }
  if (input.since !== undefined || input.until !== undefined) {
    throw validationError(
      `\`since\` and \`until\` are only accepted with window "custom"; "${input.window}" sets its own dates.`,
    );
  }
  const until = insightsDate(input.nowMs);
  return checkWindow({
    scope: 'page',
    since: shiftDate(until, -PRESET_DAYS[input.window]),
    until,
    nowMs: input.nowMs,
  });
}

export { previousWindow };

/** Period-over-period change. `pct` is one decimal, `null` when `previous` is 0. */
export function deltaOf(current: number, previous: number): ReportDelta {
  const abs = current - previous;
  const pct = previous === 0 ? null : Math.round((abs / Math.abs(previous)) * 1000) / 10;
  return { abs, pct };
}

/** The rolling period that matches a span exactly, if Meta has one. */
export function reachPeriodFor(days: number): 'week' | 'days_28' | undefined {
  if (days === 7) return 'week';
  if (days === 28) return 'days_28';
  return undefined;
}

/** Order posts by the ranking metric, then newest first, then by post id. */
export function rankPosts(posts: readonly TopPost[], by: TopPostRanking): TopPost[] {
  return [...posts].sort(
    (a, b) =>
      b[by] - a[by] ||
      Date.parse(b.createdTime) - Date.parse(a.createdTime) ||
      (a.postId < b.postId ? -1 : a.postId > b.postId ? 1 : 0),
  );
}

function excerptOf(message: unknown): string | undefined {
  if (typeof message !== 'string' || message.length === 0) return undefined;
  return message.length <= EXCERPT_CHARS
    ? message
    : `${message.slice(0, EXCERPT_CHARS - 1)}…`;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** A normalised published_posts row as a ranked candidate (no insights yet). */
function toTopPost(node: GraphRecord): TopPost | undefined {
  const createdTime = node.created_time;
  if (node.id === '' || typeof createdTime !== 'string') return undefined;
  const reactions = count(node.reaction_count);
  const comments = count(node.comment_count);
  const shares = count(node.share_count);
  const permalinkUrl =
    typeof node.permalink_url === 'string' ? node.permalink_url : undefined;
  const excerpt = excerptOf(node.message);
  return {
    postId: node.id,
    createdTime,
    ...(permalinkUrl !== undefined ? { permalinkUrl } : {}),
    ...(excerpt !== undefined ? { excerpt } : {}),
    reactions,
    comments,
    shares,
    engagement: reactions + comments + shares,
  };
}

/** The Pacific-Time calendar date a Graph timestamp falls on. */
function pacificDateOf(time: string): string | undefined {
  const ms = Date.parse(time);
  return Number.isNaN(ms) ? undefined : insightsDate(ms);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function errorCode(err: unknown): number {
  return err instanceof GraphApiError ? err.code : 0;
}

/** Abort is the caller's decision, never a section to degrade. */
function rethrowIfAborted(err: unknown, signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw err;
}

function summaryOf(result: InsightsResult, metric: string): MetricSummary | undefined {
  return result.metrics.find((summary) => summary.metric === metric);
}

function sumOf(result: InsightsResult | undefined, metric: string): number | undefined {
  const summary = result !== undefined ? summaryOf(result, metric) : undefined;
  return summary?.aggregation === 'sum' ? summary.value : undefined;
}

/** The one rolling-window observation a reach read returns. */
function windowValueOf(result: InsightsResult | undefined): number | undefined {
  const summary = result !== undefined ? summaryOf(result, REACH_METRIC) : undefined;
  if (summary === undefined) return undefined;
  return summary.aggregation === 'latest_window' || summary.aggregation === 'single'
    ? summary.value
    : undefined;
}

function isMissing(result: InsightsResult, metric: string): boolean {
  return (
    result.unavailableMetrics.includes(metric) ||
    (result.rejectedMetrics ?? []).some((rejected) => rejected.metric === metric)
  );
}

async function readDay(
  fbRequest: FbRequestFn,
  opts: PageReportOptions,
  window: { readonly since: string; readonly until: string },
): Promise<InsightsResult> {
  return fetchInsights(fbRequest, {
    scope: 'page',
    objectId: opts.pageId,
    metrics: REPORT_DAY_METRICS,
    period: 'day',
    since: window.since,
    until: window.until,
    aggregate: true,
    nowMs: opts.nowMs,
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
}

async function readReach(
  fbRequest: FbRequestFn,
  opts: PageReportOptions,
  period: 'week' | 'days_28',
  until: string,
): Promise<InsightsResult> {
  return fetchInsights(fbRequest, {
    scope: 'page',
    objectId: opts.pageId,
    metrics: [REACH_METRIC],
    period,
    since: shiftDate(until, -1),
    until,
    aggregate: true,
    nowMs: opts.nowMs,
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
}

interface PostScan {
  readonly candidates: readonly TopPost[];
  readonly scanned: number;
  readonly truncated: boolean;
}

/**
 * Walk `published_posts` newest first until a post predates `since` or the
 * page budget runs out, keeping the posts created inside `[since, until)`.
 */
async function scanPosts(
  fbRequest: FbRequestFn,
  opts: PageReportOptions,
  since: string,
  until: string,
): Promise<PostScan> {
  const candidates: TopPost[] = [];
  let scanned = 0;
  let after: string | undefined;
  for (let pageNo = 0; pageNo < POSTS_MAX_PAGES; pageNo += 1) {
    const page = await fetchPage<unknown>(
      fbRequest,
      {
        host: 'graph',
        path: `/${opts.pageId}/published_posts`,
        params: { fields: TOP_POST_FIELDS },
        pageId: opts.pageId,
        ...(opts.token !== undefined ? { token: opts.token } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      },
      { limit: POSTS_PAGE_LIMIT, ...(after !== undefined ? { after } : {}) },
    );
    let reachedStart = false;
    for (const raw of page.data) {
      scanned += 1;
      const post = toTopPost(normalizeNode(raw));
      if (post === undefined) continue;
      const date = pacificDateOf(post.createdTime);
      if (date === undefined) continue;
      if (date < since) {
        reachedStart = true;
        continue;
      }
      if (date < until) candidates.push(post);
    }
    if (reachedStart) return { candidates, scanned, truncated: false };
    if (page.nextCursor === undefined) {
      return { candidates, scanned, truncated: page.truncated };
    }
    after = page.nextCursor;
  }
  return { candidates, scanned, truncated: true };
}

async function withPostInsights(
  fbRequest: FbRequestFn,
  opts: PageReportOptions,
  posts: readonly TopPost[],
): Promise<TopPost[]> {
  const out: TopPost[] = new Array<TopPost>(posts.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < posts.length) {
      const index = next;
      next += 1;
      const post = posts[index] as TopPost;
      try {
        const result = await fetchInsights(fbRequest, {
          scope: 'post',
          objectId: post.postId,
          metrics: TOP_POST_METRICS,
          period: 'lifetime',
          aggregate: true,
          nowMs: opts.nowMs,
          ...(opts.token !== undefined ? { token: opts.token } : {}),
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        });
        const insights: Record<string, number> = {};
        for (const summary of result.metrics) {
          if (summary.value !== undefined) insights[summary.metric] = summary.value;
        }
        out[index] = { ...post, insights };
      } catch (err) {
        rethrowIfAborted(err, opts.signal);
        out[index] = { ...post, insightsError: { code: errorCode(err) } };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(POST_INSIGHTS_CONCURRENCY, posts.length) }, worker),
  );
  return out;
}

async function buildTopPosts(
  fbRequest: FbRequestFn,
  opts: PageReportOptions,
  since: string,
  until: string,
): Promise<TopPostsSection> {
  let scan: PostScan;
  try {
    scan = await scanPosts(fbRequest, opts, since, until);
  } catch (err) {
    rethrowIfAborted(err, opts.signal);
    return {
      error: {
        code: errorCode(err),
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
  const top = rankPosts(scan.candidates, opts.topBy).slice(0, opts.topPosts);
  return {
    rankedBy: opts.topBy,
    scanned: scan.scanned,
    scanTruncated: scan.truncated,
    items: await withPostInsights(fbRequest, opts, top),
  };
}

const FLOW_SECTIONS = [
  ['views', 'page_media_view'],
  ['engagement', 'page_post_engagements'],
  ['pageViews', 'page_views_total'],
] as const;

function followersSection(
  current: FollowerReconciliation | undefined,
  previous: FollowerReconciliation | undefined,
): FollowersSection | undefined {
  if (current === undefined) return undefined;
  if (previous === undefined) return current;
  const prev = {
    ...(previous.stockChange !== undefined ? { stockChange: previous.stockChange } : {}),
    ...(previous.netFlow !== undefined ? { netFlow: previous.netFlow } : {}),
  };
  const delta =
    current.netFlow !== undefined && previous.netFlow !== undefined
      ? deltaOf(current.netFlow, previous.netFlow)
      : current.stockChange !== undefined && previous.stockChange !== undefined
        ? deltaOf(current.stockChange, previous.stockChange)
        : undefined;
  return { ...current, previous: prev, ...(delta !== undefined ? { delta } : {}) };
}

/**
 * Build the report. Only the current-window insights read may fail the call;
 * everything else degrades to a note or a per-section error.
 */
export async function buildPageReport(
  fbRequest: FbRequestFn,
  opts: PageReportOptions,
): Promise<PageReport> {
  const { since, until, days } = opts.window;
  if (since === undefined || until === undefined || days === undefined) {
    throw validationError('A Page report needs a window with both `since` and `until`.');
  }
  const notes: string[] = [];

  const current = await readDay(fbRequest, opts, { since, until });

  const prevWindow = opts.compare ? previousWindow(opts.window) : undefined;
  let previous: InsightsResult | undefined;
  if (prevWindow?.since !== undefined && prevWindow.until !== undefined) {
    try {
      previous = await readDay(fbRequest, opts, {
        since: prevWindow.since,
        until: prevWindow.until,
      });
    } catch (err) {
      rethrowIfAborted(err, opts.signal);
      notes.push(`comparison unavailable: ${String(errorCode(err))}`);
    }
  }

  // Reach: a rolling unique window, or nothing at all.
  const reachPeriod = reachPeriodFor(days);
  let reach: ReachSection;
  let reachCurrent: InsightsResult | undefined;
  if (reachPeriod === undefined) {
    const note = reachUnavailableNote(days);
    reach = { method: 'unavailable', metric: REACH_METRIC, note };
  } else {
    try {
      reachCurrent = await readReach(fbRequest, opts, reachPeriod, until);
    } catch (err) {
      rethrowIfAborted(err, opts.signal);
    }
    const value = windowValueOf(reachCurrent);
    if (value === undefined) {
      reach = {
        method: 'unavailable',
        metric: REACH_METRIC,
        period: reachPeriod,
        note: `Reach (${REACH_METRIC}, ${reachPeriod}) came back without a value for this window.`,
      };
    } else {
      let prevValue: number | undefined;
      if (previous !== undefined && prevWindow?.until !== undefined) {
        try {
          prevValue = windowValueOf(
            await readReach(fbRequest, opts, reachPeriod, prevWindow.until),
          );
        } catch (err) {
          rethrowIfAborted(err, opts.signal);
        }
      }
      reach = {
        method: 'rolling_window',
        metric: REACH_METRIC,
        period: reachPeriod,
        value,
        ...(prevValue !== undefined
          ? { previous: prevValue, delta: deltaOf(value, prevValue) }
          : {}),
      };
      notes.push(reachNote(reachPeriod));
    }
  }

  // Day-period flows: safe to sum.
  const flows: Partial<Record<(typeof FLOW_SECTIONS)[number][0], FlowSection>> = {};
  for (const [key, metric] of FLOW_SECTIONS) {
    const value = sumOf(current, metric);
    if (value === undefined) {
      notes.push(
        isMissing(current, metric)
          ? `${key} omitted: ${metric} is not available for this Page.`
          : `${key} omitted: ${metric} returned no data for this window.`,
      );
      continue;
    }
    const prevValue = sumOf(previous, metric);
    flows[key] = {
      value,
      method: 'sum',
      metric,
      ...(prevValue !== undefined
        ? { previous: prevValue, delta: deltaOf(value, prevValue) }
        : {}),
    };
  }

  const followers = followersSection(
    current.derived?.followers,
    previous?.derived?.followers,
  );

  const topPosts =
    opts.topPosts > 0 ? await buildTopPosts(fbRequest, opts, since, until) : undefined;
  if (topPosts !== undefined && 'items' in topPosts) {
    notes.push(TOP_POSTS_NOTE);
    if (topPosts.scanTruncated) notes.push(SCAN_TRUNCATED_NOTE);
  }

  const insightsSummaries = [...current.metrics, ...(reachCurrent?.metrics ?? [])];
  const eligible = insightsSummaries.some((summary) => summary.points > 0);
  if (!eligible) notes.push(PAGE_ELIGIBILITY_NOTE);

  return {
    window: opts.window,
    ...(prevWindow?.since !== undefined &&
    prevWindow.until !== undefined &&
    previous !== undefined
      ? {
          previousWindow: {
            since: prevWindow.since,
            until: prevWindow.until,
            days,
          },
        }
      : {}),
    ...(followers !== undefined ? { followers } : {}),
    reach,
    ...flows,
    ...(topPosts !== undefined ? { topPosts } : {}),
    eligible,
    notes,
  };
}
