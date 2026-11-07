// The insights Graph read (X09 split of `insights.ts`).

import { GraphApiError } from '../../core/index.js';
import type { FbRequestFn, ParamValue } from '../../core/index.js';
import { canonicalMetricName, classifyMetrics } from './deprecations.js';
import type { MetricVerdict } from './deprecations.js';
import { deriveFollowerReconciliation } from './followers.js';
import type { InsightsDerived } from './followers.js';
import { INSIGHTS_MAX_ROWS } from './limits.js';
import type { InsightRow, InsightsScope, MetricSummary } from './model.js';
import {
  ALL_METRICS_DEPRECATED_NOTE,
  EMPTY_SCOPE_NOTE,
  FRESHNESS_NOTE,
  INSIGHTS_TOKEN_EMPTY_HINT,
  PAGE_TIMEZONE_NOTE,
  PERIOD_BOUNDARY_NOTE,
  cutSeries,
  droppedMetricsNote,
  emptyMetricsNote,
  truncationNote,
  unavailableNote,
} from './notes.js';
import { capRows, reshapeWithEnds } from './reshape.js';
import type { CappedRows, InsightExportRow } from './reshape.js';
import { checkWindow, scopeToday } from './window.js';
import type { InsightsWindow } from './window.js';

// ---------------------------------------------------------------------------
// 7. The Graph read
// ---------------------------------------------------------------------------

/** Everything one insights read needs. `nowMs` keeps freshness logic testable. */
export interface InsightsRequest {
  readonly scope: InsightsScope;
  /** Page ID, post ID (`{page-id}_{post-id}`) or — for `reel` — the video ID. */
  readonly objectId: string;
  /** Requested metric names, in the caller's order. */
  readonly metrics: readonly string[];
  readonly period?: string;
  readonly since?: string;
  readonly until?: string;
  /** True ⇒ per-metric totals only, no per-point rows (CC-INS-4). */
  readonly aggregate?: boolean;
  /** Row-cap override; defaults to {@link INSIGHTS_MAX_ROWS}. */
  readonly maxRows?: number;
  /**
   * True ⇒ also return the full, UNCAPPED series in `exportRows` for a file
   * export (v2 insights F5). The inline `rows` and the cap are unaffected.
   */
  readonly exportRows?: boolean;
  /** Page access token (always pass the resolved Page token — C1). */
  readonly token?: string;
  readonly signal?: AbortSignal;
  /** Wall clock used for the freshness note and a lone-`since` window span. */
  readonly nowMs: number;
}

/** The reshaped, capped, annotated result a tool hands to the shaper. */
export interface InsightsResult {
  readonly mode: 'series' | 'aggregate';
  /** The period actually requested (Graph's echoed period is per metric). */
  readonly period: string;
  /** Present for a Page always, for a post / Reel only when a window was passed. */
  readonly window?: InsightsWindow;
  /** Metric names actually sent to Graph (deprecated names removed). */
  readonly queriedMetrics: readonly string[];
  readonly metrics: readonly MetricSummary[];
  /** Cross-metric checks (Page scope, follower metrics queried). */
  readonly derived?: InsightsDerived;
  /** Per-point rows; absent in `aggregate` mode. */
  readonly rows?: readonly InsightRow[];
  /** Data points Graph returned, before the row cap. */
  readonly rowsAvailable: number;
  readonly truncated: boolean;
  /** Every data point, uncapped, with its raw `end_time`; only with `exportRows`. */
  readonly exportRows?: readonly InsightExportRow[];
  /** Requested names that are dead, each with a replacement suggestion. */
  readonly deprecatedMetrics: readonly MetricVerdict[];
  /** Sent but never mentioned in the response ⇒ invalid for this object/version. */
  readonly unavailableMetrics: readonly string[];
  /** Accepted by Graph with zero data points ⇒ valid, no data. */
  readonly emptyMetrics: readonly string[];
  /**
   * Names Graph rejected by position (`metric[N]`) — dropped so the rest of the
   * list could be re-read. Absent when Graph rejected nothing.
   */
  readonly rejectedMetrics?: readonly RejectedMetric[];
  readonly notes: readonly string[];
}

/** One metric name Graph rejected by position, and why this server says so. */
export interface RejectedMetric {
  readonly metric: string;
  readonly reason: string;
}

/**
 * Default period per scope: a daily series for a Page, lifetime totals for a
 * post or a Reel. `/video_insights` in particular is a lifetime edge — plays and
 * watch time are cumulative counters, not a series — so `day` there returns
 * nothing at all, which is precisely the silent-empty failure this module exists
 * to prevent.
 */
function defaultPeriod(scope: InsightsScope): string {
  return scope === 'page' ? 'day' : 'lifetime';
}

/**
 * The Graph edge each scope reads. Reels metrics are not a subset of the post
 * edge: they are a different edge on a different object (G-TOOL-2).
 */
function insightsEdge(scope: InsightsScope): string {
  return scope === 'reel' ? 'video_insights' : 'insights';
}

/**
 * True for a Graph failure that is about the metric LIST (code 100 / 3001 whose
 * text mentions a metric) rather than the token, the object or the window.
 */
function isMetricRejection(err: unknown): err is GraphApiError {
  return (
    err instanceof GraphApiError &&
    (err.code === 100 || err.code === 3001) &&
    /metric/i.test(err.message)
  );
}

/**
 * The name a positional rejection (`metric[N]`) points at, resolved against the
 * list Graph actually RECEIVED — deprecated names already dropped, case folded,
 * duplicates merged — so read against the caller's own list it can point at a
 * perfectly valid name. Undefined when Graph named no index or an index outside
 * that list.
 */
function locatedRejection(
  err: GraphApiError,
  sent: readonly string[],
): { readonly index: string; readonly metric: string } | undefined {
  const index = /metric\[(\d+)\]/.exec(err.message)?.[1];
  if (index === undefined) return undefined;
  const metric = sent[Number(index)];
  return metric !== undefined ? { index, metric } : undefined;
}

/**
 * A metric name that belongs to another insights edge than the one this scope
 * reads. Graph rejects such a name exactly like a typo, so without this the
 * caller is told the name is misspelled or too new for the pinned version while
 * the real fix is a different tool. Prefix-based on purpose: every Page-edge
 * metric is `page_*` and no post or video metric is, and no Page-edge metric is
 * `post_*`.
 */
function scopeMismatch(scope: InsightsScope, metric: string): string | undefined {
  if (scope !== 'page' && metric.startsWith('page_')) {
    return `"${metric}" is a Page-level metric, which the ${insightsEdge(scope)} edge of a ${scope === 'post' ? 'post' : 'Reel'} does not serve — read it with facebook_page_insights.`;
  }
  if (scope === 'page' && metric.startsWith('post_')) {
    return `"${metric}" is a post-level metric, which the Page edge does not serve — read it with facebook_post_insights and a post ID (or facebook_reel_insights and a video ID for a Reel).`;
  }
  return undefined;
}

/** One name Graph rejected by position, with the list it was rejected from. */
interface LocatedRejection extends RejectedMetric {
  readonly index: string;
  readonly sent: readonly string[];
}

function rejectedReason(
  scope: InsightsScope,
  metric: string,
  index: string,
  sent: readonly string[],
): string {
  const where = `Graph rejected metric[${index}] of the list sent ("${sent.join(',')}").`;
  return `${where} ${scopeMismatch(scope, metric) ?? 'The name is not valid for this object or for the pinned Graph API version.'}`;
}

/**
 * Re-throw a Graph metric-validation failure with the table's suggestions
 * attached. Graph's own text ("metric[0] must be one of the following values")
 * lists hundreds of names — useless to a model — so the enriched message names
 * the dead metrics we recognize and how to isolate the rest. The
 * {@link GraphApiError} identity, codes and action are preserved so the server's
 * error mapping is unchanged.
 *
 * `metrics` is the caller's ORIGINAL list, not the live subset that was sent:
 * when a request mixed a dead name with an unknown-but-invalid one, naming the
 * rename is the most useful thing we can say about the rejection. `earlier`
 * lists names Graph already rejected by position in this call, which were
 * dropped before the attempt that failed here.
 */
function enrichMetricError(
  err: unknown,
  metrics: readonly string[],
  sent: readonly string[],
  scope: InsightsScope,
  earlier: readonly LocatedRejection[],
): unknown {
  if (!isMetricRejection(err)) return err;

  const suggestions = classifyMetrics(metrics)
    .filter((verdict) => verdict.suggestion !== undefined)
    .map((verdict) => verdict.suggestion);
  const located = locatedRejection(err, sent);
  const locatedText =
    located !== undefined
      ? ` Graph's index counts the list actually sent ("${sent.join(',')}"), so metric[${located.index}] is "${located.metric}".`
      : '';
  const earlierText =
    earlier.length > 0
      ? ` Earlier in this call Graph also rejected ${earlier.map((r) => `"${r.metric}" (metric[${r.index}] of "${r.sent.join(',')}")`).join(', ')}, dropped before this attempt.`
      : '';
  // A name from another edge is the likeliest invalid one, and "typo or too
  // new" would send the caller hunting in the wrong place.
  const mismatches = [...new Set([...sent, ...earlier.map((r) => r.metric)])]
    .map((metric) => scopeMismatch(scope, metric))
    .filter((text): text is string => text !== undefined);
  const parts: string[] = [];
  if (mismatches.length > 0) parts.push(` ${mismatches.join(' ')}`);
  if (suggestions.length > 0) {
    parts.push(` Known-dead names in this request: ${suggestions.join(' ')}`);
  }
  if (parts.length === 0) {
    parts.push(
      ' None of the requested names appears in the rename table of this server, so the invalid one is either a typo or unsupported by the pinned Graph API version.',
    );
  }
  return new GraphApiError(
    `${err.message} Graph rejected the metric list, so NO metric was read.${locatedText}${earlierText} Request one metric at a time to isolate the invalid name.${parts.join('')}`,
    {
      code: err.code,
      ...(err.subcode !== undefined ? { subcode: err.subcode } : {}),
      ...(err.type !== undefined ? { type: err.type } : {}),
      ...(err.fbtraceId !== undefined ? { fbtraceId: err.fbtraceId } : {}),
      httpStatus: err.httpStatus,
      ...(err.action !== undefined ? { action: err.action } : {}),
      // Graph's own human-readable reason rides on these two fields and the
      // server surfaces them to the caller; the rebuilt error must not drop it.
      ...(err.userTitle !== undefined ? { userTitle: err.userTitle } : {}),
      ...(err.userMessage !== undefined ? { userMessage: err.userMessage } : {}),
      cause: err,
    },
  );
}

async function requestInsights(
  fbRequest: FbRequestFn,
  req: InsightsRequest,
  metrics: readonly string[],
  period: string,
): Promise<unknown> {
  const params: Record<string, ParamValue> = { metric: metrics.join(','), period };
  if (req.since !== undefined) params.since = req.since;
  if (req.until !== undefined) params.until = req.until;
  const res = await fbRequest<unknown>({
    protocol: 'json',
    method: 'GET',
    host: 'graph',
    path: `/${req.objectId}/${insightsEdge(req.scope)}`,
    params,
    ...(req.token !== undefined ? { token: req.token } : {}),
    ...(req.signal !== undefined ? { signal: req.signal } : {}),
  });
  return res.data;
}

/**
 * Most names one read will drop on positional rejections before giving up and
 * reporting the rejection instead: each drop costs one more GET.
 */
const MAX_POSITIONAL_DROPS = 5;

/** The answered body, the names it answers for, and the names Graph rejected. */
interface TolerantRead {
  readonly body: unknown;
  readonly answered: readonly string[];
  readonly rejected: readonly LocatedRejection[];
}

/**
 * GET the live list; when Graph rejects it by POSITION (`metric[N]`), drop that
 * one name and re-read the rest. Graph fails the whole call over one invalid
 * name, but a positional rejection proves which name it was — failing the read
 * would throw away every other metric's numbers for a fault that is not theirs.
 * An unlocated rejection, a lone remaining name, or too many drops ends the
 * loop with the enriched error.
 */
async function readTolerant(
  fbRequest: FbRequestFn,
  req: InsightsRequest,
  live: readonly string[],
  period: string,
): Promise<TolerantRead> {
  let sent = live;
  const rejected: LocatedRejection[] = [];
  for (;;) {
    try {
      const body = await requestInsights(fbRequest, req, sent, period);
      return { body, answered: sent, rejected };
    } catch (err) {
      const located = isMetricRejection(err) ? locatedRejection(err, sent) : undefined;
      if (
        located === undefined ||
        sent.length <= 1 ||
        rejected.length >= MAX_POSITIONAL_DROPS
      ) {
        throw enrichMetricError(err, req.metrics, sent, req.scope, rejected);
      }
      rejected.push({
        metric: located.metric,
        reason: rejectedReason(req.scope, located.metric, located.index, sent),
        index: located.index,
        sent,
      });
      sent = sent.filter((metric) => metric !== located.metric);
    }
  }
}

function rejectedNote(rejected: readonly RejectedMetric[]): string {
  return `Graph rejected ${rejected.map((r) => `"${r.metric}"`).join(', ')} by position, so ${rejected.length === 1 ? 'that name was' : 'those names were'} dropped and the remaining metrics re-read; rows and summaries cover only the remaining names. See rejectedMetrics for why each was rejected.`;
}

/**
 * True when the freshness caveat is worth printing: nothing came back at all, a
 * point for today is present (partial bucket), or the window reaches today but
 * the tail is missing (Graph has not computed it yet) — CC-INS-6.
 */
function needsFreshnessNote(
  scope: InsightsScope,
  rows: readonly InsightRow[],
  until: string | undefined,
  nowMs: number,
): boolean {
  if (rows.length === 0) return true;
  const today = scopeToday(scope, nowMs);
  let latest: string | undefined;
  for (const row of rows) {
    if (row.date !== undefined && (latest === undefined || row.date > latest)) {
      latest = row.date;
    }
  }
  // `date` is an exclusive end boundary: one later than today means the
  // series holds the still-open current day.
  if (latest === undefined || latest > today) return true;
  // An omitted `until` lets Graph pick a live tail. An explicit `until` equal
  // to today excludes today under [since, until); a later one does not.
  return until === undefined || until > today;
}

function buildNotes(input: {
  readonly scope: InsightsScope;
  readonly period: string;
  readonly rows: readonly InsightRow[];
  readonly metrics: readonly MetricSummary[];
  readonly emptyMetrics: readonly string[];
  readonly unavailableMetrics: readonly string[];
  readonly deprecated: readonly MetricVerdict[];
  readonly rejected: readonly RejectedMetric[];
  readonly capped: CappedRows;
  readonly until?: string;
  readonly nowMs: number;
}): readonly string[] {
  const notes: string[] = [];
  if (input.deprecated.length > 0)
    notes.push(droppedMetricsNote(input.deprecated.length));
  if (input.rejected.length > 0) notes.push(rejectedNote(input.rejected));
  if (input.capped.truncated) {
    notes.push(
      truncationNote(
        input.capped.rows.length,
        input.capped.dropped,
        cutSeries(input.rows, input.capped.rows),
      ),
    );
  }
  if (input.unavailableMetrics.length > 0) {
    notes.push(unavailableNote(input.unavailableMetrics, input.scope, input.period));
  }

  // `[].every(...)` is true on purpose: "silent empty data" (CC-AUTH-2) and the
  // eligibility floor (CC-INS-2) can surface either as entries whose `values`
  // are empty OR as a body with no entries at all, and doc 09 pins neither wire
  // shape. Requiring at least one entry here made the second shape skip the
  // whole explanation and leave only the unavailable-metric note, which says the
  // metric NAMES are invalid — the one reading that is almost certainly wrong,
  // since Graph rejects an invalid name outright (see `enrichMetricError`).
  // `buildNotes` is only reached with a non-empty `live` list, so this cannot
  // fire for a request that asked for nothing.
  const allEmpty = input.metrics.every((metric) => metric.points === 0);
  if (allEmpty) {
    notes.push(EMPTY_SCOPE_NOTE[input.scope]);
    // The eligibility/lag explanations above are the LIKELY cause; the silent
    // user-token read is the other one, and only the caller can tell them apart.
    notes.push(INSIGHTS_TOKEN_EMPTY_HINT);
  } else if (input.emptyMetrics.length > 0) {
    notes.push(emptyMetricsNote(input.emptyMetrics, input.period));
  }

  if (needsFreshnessNote(input.scope, input.rows, input.until, input.nowMs))
    notes.push(FRESHNESS_NOTE);
  notes.push(PERIOD_BOUNDARY_NOTE);
  if (input.scope === 'page') notes.push(PAGE_TIMEZONE_NOTE);
  return notes;
}

/**
 * Read `/{page-id|post-id}/insights`, reshape it and annotate it.
 *
 * Order of operations: validate the window → classify the requested metric names
 * → drop the dead ones (Graph fails the whole call over one) → GET what is left
 * → reshape → cap rows → assemble notes. When EVERY requested name is dead no
 * request is made at all: the result carries the replacement suggestions, which
 * is strictly more useful than an empty series (C6, CC-INS-1).
 */
export async function fetchInsights(
  fbRequest: FbRequestFn,
  req: InsightsRequest,
): Promise<InsightsResult> {
  const period = req.period ?? defaultPeriod(req.scope);
  const window = checkWindow({
    scope: req.scope,
    ...(req.since !== undefined ? { since: req.since } : {}),
    ...(req.until !== undefined ? { until: req.until } : {}),
    nowMs: req.nowMs,
  });
  const mode: 'series' | 'aggregate' = req.aggregate === true ? 'aggregate' : 'series';
  // A Page always states its timezone; a post / Reel echoes only a real window.
  const hasWindow =
    req.scope === 'page' || window.since !== undefined || window.until !== undefined;

  const verdicts = classifyMetrics(req.metrics);
  const deprecated = verdicts.filter((verdict) => verdict.status !== 'ok');
  // Canonicalised, not echoed: `live` is both what goes on the wire and what the
  // reply is checked against below. Graph answers in lower-case snake_case, so a
  // requested "Post_Impressions" compared raw would come back as "unavailable"
  // while its own data sits in `rows` — the model would be handed the numbers
  // and a note saying the name is invalid. Dedup happens after folding, so a
  // list carrying both spellings is also only requested once.
  const live = [
    ...new Set(
      verdicts.filter((v) => v.status === 'ok').map((v) => canonicalMetricName(v.metric)),
    ),
  ];

  if (live.length === 0) {
    return {
      mode,
      period,
      ...(hasWindow ? { window } : {}),
      queriedMetrics: [],
      metrics: [],
      ...(mode === 'series' ? { rows: [] } : {}),
      rowsAvailable: 0,
      truncated: false,
      ...(req.exportRows === true ? { exportRows: [] } : {}),
      deprecatedMetrics: deprecated,
      unavailableMetrics: [],
      emptyMetrics: [],
      notes: [ALL_METRICS_DEPRECATED_NOTE],
    };
  }

  const { body, answered, rejected } = await readTolerant(fbRequest, req, live, period);
  const reshaped = reshapeWithEnds(body);
  // Aggregate mode emits no rows at all, so the row cap simply does not apply —
  // and must not raise a truncation note about rows nobody asked for.
  const capped: CappedRows =
    mode === 'series'
      ? capRows(reshaped.rows, req.maxRows ?? INSIGHTS_MAX_ROWS)
      : { rows: [], dropped: 0, truncated: false };

  // Folded on BOTH sides. `live` was already canonicalised so the request and
  // this check would speak one vocabulary, but the reply half stayed verbatim:
  // `metric.metric` is Graph's `name` straight off the wire, a declared string
  // that nothing has folded. One entry echoed as `Page_Media_View` and the
  // comparison misses — the metric lands in `unavailableMetrics` and the model
  // is handed that metric's own rows next to a note insisting the name is not
  // valid for this object. The reply is not more trustworthy than the request.
  const returned = new Set(
    reshaped.metrics.map((metric) => canonicalMetricName(metric.metric)),
  );
  // Against the names the answered request carried: a name Graph rejected by
  // position is reported in rejectedMetrics, not again as "no entry returned".
  const unavailableMetrics = answered.filter((metric) => !returned.has(metric));
  const emptyMetrics = reshaped.metrics
    .filter((metric) => metric.points === 0)
    .map((metric) => metric.metric);
  const followers =
    req.scope === 'page'
      ? deriveFollowerReconciliation(reshaped.metrics, live)
      : undefined;

  return {
    mode,
    period,
    ...(hasWindow ? { window } : {}),
    queriedMetrics: live,
    metrics: reshaped.metrics,
    ...(followers !== undefined ? { derived: { followers } } : {}),
    ...(mode === 'series' ? { rows: capped.rows } : {}),
    rowsAvailable: reshaped.rows.length,
    truncated: capped.truncated,
    ...(req.exportRows === true
      ? {
          exportRows: reshaped.rows.map((row, index) => {
            const endTime = reshaped.rowEnds[index];
            return endTime !== undefined ? { ...row, endTime } : row;
          }),
        }
      : {}),
    deprecatedMetrics: deprecated,
    unavailableMetrics,
    emptyMetrics,
    ...(rejected.length > 0
      ? {
          rejectedMetrics: rejected.map(({ metric, reason }) => ({ metric, reason })),
        }
      : {}),
    notes: buildNotes({
      scope: req.scope,
      period,
      // Freshness is judged on the FULL series, not the capped prefix — a cap
      // that lopped off the tail must not hide that the tail may be stale.
      rows: reshaped.rows,
      metrics: reshaped.metrics,
      emptyMetrics,
      unavailableMetrics,
      deprecated,
      rejected,
      capped,
      ...(req.until !== undefined ? { until: req.until } : {}),
      nowMs: req.nowMs,
    }),
  };
}
