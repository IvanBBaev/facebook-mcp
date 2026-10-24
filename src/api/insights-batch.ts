// Batch post-level insights (v2 insights F4) — "compare views, reach, clicks and
// reactions for my last 10 posts" in one call instead of ten.
//
// One lifetime `GET /{post}/insights` per post, three at a time, through the
// same `fetchInsights` every other insights tool uses, so deprecations,
// positional drops and the semantics-aware summaries behave identically.
//
// VET ONCE. The metric list is vetted on the first post that answers: names the
// rename table killed or Graph rejected by position are removed there, and the
// rest of the posts are read with the reduced list. A bad metric then costs one
// extra call, not one per post.
//
// ROW ISOLATION. A post on another Page, or a post Graph refuses, becomes a row
// `error`; one bad id must not sink 24 good ones. Only when EVERY row failed
// does the call throw (the first row's error), because then there is no table.

import { GraphApiError, classifyGraphError } from '../core/index.js';
import type { FbRequestFn } from '../core/index.js';
import {
  fetchInsights,
  type InsightsResult,
  type MetricVerdict,
  type RejectedMetric,
} from './insights.js';
import { fetchPage } from './shared.js';

/** Most posts one call reads (`post_ids` or `latest`). */
export const POSTS_INSIGHTS_MAX = 25;

/** Most metric names one call reads. */
export const POSTS_INSIGHTS_MAX_METRICS = 10;

/** Posts read at once after the vetting read. */
export const POSTS_INSIGHTS_CONCURRENCY = 3;

/** The default columns: views, unique viewers, clicks and reactions by type. */
export const DEFAULT_POSTS_INSIGHTS_METRICS: readonly string[] = [
  'post_media_view',
  'post_total_media_view_unique',
  'post_clicks',
  'post_reactions_by_type_total',
];

export const POSTS_LIFETIME_NOTE =
  'Post metrics are lifetime totals and lag minutes to hours after publishing; a ' +
  'recent post can read lower than it will.';

/** A post to read, with its creation time when the caller already knows it. */
export interface PostTarget {
  readonly postId: string;
  readonly createdTime?: string;
}

export interface RowError {
  readonly code: number;
  readonly message: string;
  readonly hint?: string;
}

/** One table row: scalar `values` plus unaggregated `breakdowns`, or an `error`. */
export interface PostInsightsRow {
  readonly postId: string;
  readonly createdTime?: string;
  readonly values?: Readonly<Record<string, number>>;
  readonly breakdowns?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly error?: RowError;
}

export interface PostsInsightsTable {
  readonly period: 'lifetime';
  /** The vetted metric names every row after the first was read with. */
  readonly columns: readonly string[];
  readonly posts: readonly PostInsightsRow[];
  readonly deprecatedMetrics: readonly MetricVerdict[];
  readonly rejectedMetrics: readonly RejectedMetric[];
  /** Columns that came back with no data point on every post that answered. */
  readonly emptyMetrics: readonly string[];
  readonly notes: readonly string[];
}

export interface PostsInsightsOptions {
  readonly pageId: string;
  readonly token?: string;
  readonly posts: readonly PostTarget[];
  readonly metrics: readonly string[];
  readonly nowMs: number;
  readonly signal?: AbortSignal;
  /** Defaults to {@link POSTS_INSIGHTS_CONCURRENCY}. */
  readonly concurrency?: number;
}

function validationError(message: string): GraphApiError {
  return new GraphApiError(message, {
    code: 100,
    httpStatus: 400,
    action: classifyGraphError({ code: 100, message }),
  });
}

function rowErrorOf(err: unknown): RowError {
  const code = err instanceof GraphApiError ? err.code : 0;
  const message = err instanceof Error ? err.message : String(err);
  const hint = err instanceof GraphApiError ? err.action?.operatorText : undefined;
  return { code, message, ...(hint !== undefined ? { hint } : {}) };
}

/** Abort is the caller's decision, never a row to degrade. */
function rethrowIfAborted(err: unknown, signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw err;
}

/** A `{page-id}_{post-id}` composite whose halves are both numeric. */
const NUMERIC_COMPOSITE = /^(\d+)_\d+$/;

/**
 * The error for a post whose composite id names another Page: the resolved
 * Page's token cannot read it, and Graph's own answer would not say why.
 */
export function foreignPostError(
  postId: string,
  pageId: string,
): GraphApiError | undefined {
  const postPageId = NUMERIC_COMPOSITE.exec(postId)?.[1];
  if (postPageId === undefined || !/^\d+$/.test(pageId) || postPageId === pageId) {
    return undefined;
  }
  return validationError(
    `Post "${postId}" belongs to Page ${postPageId}, but the resolved Page is ${pageId}; its token cannot read another Page's post insights. Pass \`profile\` for Page ${postPageId}, or leave this post out.`,
  );
}

/** The N most recent published posts: one `published_posts` read. */
export async function latestPostTargets(
  fbRequest: FbRequestFn,
  opts: {
    readonly pageId: string;
    readonly token?: string;
    readonly limit: number;
    readonly signal?: AbortSignal;
  },
): Promise<PostTarget[]> {
  const page = await fetchPage<unknown>(
    fbRequest,
    {
      host: 'graph',
      path: `/${opts.pageId}/published_posts`,
      params: { fields: 'id,created_time' },
      pageId: opts.pageId,
      ...(opts.token !== undefined ? { token: opts.token } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    },
    { limit: opts.limit },
  );
  return page.data.slice(0, opts.limit).flatMap((raw) => {
    const node = raw as { id?: unknown; created_time?: unknown } | null;
    if (typeof node?.id !== 'string' || node.id.length === 0) return [];
    return [
      {
        postId: node.id,
        ...(typeof node.created_time === 'string'
          ? { createdTime: node.created_time }
          : {}),
      },
    ];
  });
}

/** Scalars into `values`, breakdown maps into `breakdowns` (never rolled up). */
function rowOf(target: PostTarget, result: InsightsResult): PostInsightsRow {
  const values: Record<string, number> = {};
  const breakdowns: Record<string, Record<string, number>> = {};
  for (const summary of result.metrics) {
    if (summary.breakdowns !== undefined && summary.breakdowns > 0) {
      const map: Record<string, number> = {};
      for (const row of result.rows ?? []) {
        if (
          row.metric === summary.metric &&
          row.breakdown !== undefined &&
          typeof row.value === 'number'
        ) {
          map[row.breakdown] = row.value;
        }
      }
      breakdowns[summary.metric] = map;
    } else if (summary.value !== undefined) {
      values[summary.metric] = summary.value;
    }
  }
  return {
    postId: target.postId,
    ...(target.createdTime !== undefined ? { createdTime: target.createdTime } : {}),
    values,
    ...(Object.keys(breakdowns).length > 0 ? { breakdowns } : {}),
  };
}

function readPost(
  fbRequest: FbRequestFn,
  opts: PostsInsightsOptions,
  postId: string,
  metrics: readonly string[],
): Promise<InsightsResult> {
  return fetchInsights(fbRequest, {
    scope: 'post',
    objectId: postId,
    metrics,
    period: 'lifetime',
    nowMs: opts.nowMs,
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
}

/**
 * Read lifetime insights for every post and assemble one table. See the module
 * header for the vet-once and row-isolation rules.
 */
export async function fetchPostsInsights(
  fbRequest: FbRequestFn,
  opts: PostsInsightsOptions,
): Promise<PostsInsightsTable> {
  const rows: (PostInsightsRow | undefined)[] = new Array<PostInsightsRow | undefined>(
    opts.posts.length,
  ).fill(undefined);
  const errors: unknown[] = new Array<unknown>(opts.posts.length).fill(undefined);
  const results: (InsightsResult | undefined)[] = new Array<InsightsResult | undefined>(
    opts.posts.length,
  ).fill(undefined);

  const fail = (index: number, err: unknown): void => {
    errors[index] = err;
    const target = opts.posts[index] as PostTarget;
    rows[index] = {
      postId: target.postId,
      ...(target.createdTime !== undefined ? { createdTime: target.createdTime } : {}),
      error: rowErrorOf(err),
    };
  };

  const pending: number[] = [];
  opts.posts.forEach((target, index) => {
    const foreign = foreignPostError(target.postId, opts.pageId);
    if (foreign !== undefined) fail(index, foreign);
    else pending.push(index);
  });

  // Vet: read posts one at a time until one answers; its result decides the
  // columns for the rest.
  let vetting: InsightsResult | undefined;
  while (vetting === undefined && pending.length > 0) {
    const index = pending.shift() as number;
    try {
      const result = await readPost(
        fbRequest,
        opts,
        (opts.posts[index] as PostTarget).postId,
        opts.metrics,
      );
      results[index] = result;
      vetting = result;
    } catch (err) {
      rethrowIfAborted(err, opts.signal);
      fail(index, err);
    }
  }

  const rejected = new Map<string, RejectedMetric>();
  for (const r of vetting?.rejectedMetrics ?? []) rejected.set(r.metric, r);
  const columns = (vetting?.queriedMetrics ?? []).filter((m) => !rejected.has(m));

  if (columns.length > 0) {
    const concurrency = Math.max(1, opts.concurrency ?? POSTS_INSIGHTS_CONCURRENCY);
    const worker = async (): Promise<void> => {
      for (let index = pending.shift(); index !== undefined; index = pending.shift()) {
        try {
          results[index] = await readPost(
            fbRequest,
            opts,
            (opts.posts[index] as PostTarget).postId,
            columns,
          );
        } catch (err) {
          rethrowIfAborted(err, opts.signal);
          fail(index, err);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, pending.length) }, worker),
    );
  }

  results.forEach((result, index) => {
    if (result !== undefined)
      rows[index] = rowOf(opts.posts[index] as PostTarget, result);
  });
  // Every post left unread (all names dead) still gets a row, with no values.
  opts.posts.forEach((target, index) => {
    if (rows[index] === undefined) {
      rows[index] = {
        postId: target.postId,
        ...(target.createdTime !== undefined ? { createdTime: target.createdTime } : {}),
        values: {},
      };
    }
  });

  if (vetting === undefined) {
    // Every row failed: there is no table, so the first row's error is the answer.
    const first: unknown = errors.find((err) => err !== undefined);
    throw first instanceof Error ? first : new Error(String(first));
  }

  // A later post can still see a positional rejection of its own.
  for (const result of results) {
    for (const r of result?.rejectedMetrics ?? []) {
      if (!rejected.has(r.metric)) rejected.set(r.metric, r);
    }
  }
  const answered = results.filter((r): r is InsightsResult => r !== undefined);
  const emptyMetrics = columns.filter(
    (metric) =>
      answered.length > 0 &&
      answered.every((result) => {
        const summary = result.metrics.find((s) => s.metric === metric);
        return summary === undefined || summary.points === 0;
      }),
  );

  const notes: string[] = [POSTS_LIFETIME_NOTE];
  if (vetting.deprecatedMetrics.length > 0) {
    notes.push(
      `${vetting.deprecatedMetrics.map((v) => `"${v.metric}"`).join(', ')} ${vetting.deprecatedMetrics.length === 1 ? 'is' : 'are'} no longer served and ${vetting.deprecatedMetrics.length === 1 ? 'was' : 'were'} not requested; see deprecatedMetrics for replacements.`,
    );
  }
  if (rejected.size > 0) {
    notes.push(
      `Graph rejected ${[...rejected.keys()].map((m) => `"${m}"`).join(', ')}, so ${rejected.size === 1 ? 'that name was' : 'those names were'} left out of the columns; see rejectedMetrics.`,
    );
  }
  if (columns.length === 0) {
    notes.push('No requested metric is still served, so no post insights were read.');
  }

  return {
    period: 'lifetime',
    columns,
    posts: rows as PostInsightsRow[],
    deprecatedMetrics: vetting.deprecatedMetrics,
    rejectedMetrics: [...rejected.values()],
    emptyMetrics,
    notes,
  };
}
