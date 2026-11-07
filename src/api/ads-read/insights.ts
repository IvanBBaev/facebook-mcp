// Ads insights — sync, with an async report-run fallback (CC-ADS-5) (X11 split of `ads-read.ts`).

import { GraphApiError, classifyGraphError } from '../../core/index.js';
import type { Cursor, FbRequestFn, ParamValue } from '../../core/index.js';
import { DEFAULT_PAGE_LIMIT, fetchPage } from '../shared.js';
import { validationError } from './account-id.js';
import { ADS_RATE_LIMIT_NOTE, MARKETING_API } from './levels.js';
import { adsEdge } from './listings.js';
import type { AdPagedResult, AdsRequestOptions } from './model.js';
import {
  EMPTY_INSIGHTS_PAGE_MORE_FOLLOWS_NOTE,
  isRecord,
  normalizeInsightsRow,
  readString,
  topLevelFieldNames,
} from './normalize.js';
import type { AdRecord } from './normalize.js';

// ---------------------------------------------------------------------------
// 8. Insights — sync, with an async report-run fallback (CC-ADS-5)
// ---------------------------------------------------------------------------

/**
 * Default insights fields: spend plus the four numbers every report starts from,
 * and `account_currency` so `spend`/`cpc` are never a bare, unit-less number.
 */
export const ADS_INSIGHTS_DEFAULT_FIELDS =
  'impressions,clicks,spend,reach,cpc,ctr,account_currency,date_start,date_stop';

/**
 * Insights money metrics. Graph returns them as decimal strings in the ad
 * account's currency (major units, unlike the `*_minor` budgets), and the row
 * says nothing about which currency unless `account_currency` is asked for.
 */
const INSIGHTS_MONEY_FIELD =
  /^(?:spend|social_spend|cpc|cpm|cpp|action_values|conversion_values)$|^cost_per_|_values?$/;

/**
 * Pin `account_currency` onto a fields list that asks for any money metric, so
 * a caller-chosen `fields:'spend'` cannot come back as "48.10" of nothing.
 */
function withInsightsCurrency(fields: string): string {
  const names = topLevelFieldNames(fields);
  if (names.includes('account_currency')) return fields;
  if (!names.some((name) => INSIGHTS_MONEY_FIELD.test(name))) return fields;
  return `${fields},account_currency`;
}

/** Hard row cap for one insights read, sized to stay inside the result budget. */
export const ADS_INSIGHTS_MAX_ROWS = 200;

/** Graph's "this query is too large for a synchronous read" subcode. */
export const OVERSIZED_SYNC_SUBCODE = 1487534;

/**
 * A `report_run_id` off the wire. Graph sends it as a string on some builds and
 * as a bare JSON number on others, so a number is worth coercing — but only when
 * it is exactly representable. A real run id is around nineteen digits, well
 * past `Number.MAX_SAFE_INTEGER`, which means `JSON.parse` has already rounded
 * it; `String(n)` would then hand back an id that polls forever and resolves to
 * nothing, while the run that was actually started is orphaned. Refusing is the
 * only honest answer, and the caller already turns `undefined` into an error
 * that tells the operator to retry (CC-NET-2).
 */
function readReportRunId(raw: unknown): string | undefined {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) ? String(raw) : undefined;
  }
  return readString(raw);
}

/** A `report_run_id` is only resolvable for 30 days after the run started. */
export const REPORT_RUN_TTL_DAYS = 30;

/** How long a run may sit without finishing before the advice turns into "give up". */
export const REPORT_STALL_MS = 15 * 60 * 1000;

/** Suggested wait between two status probes — polling is metered (CC-ADS-1). */
export const REPORT_POLL_INTERVAL_MS = 10_000;

/** True when Graph rejected a sync insights read purely for being too large. */
export function isOversizedSyncError(err: unknown): boolean {
  return (
    err instanceof GraphApiError &&
    err.code === 100 &&
    err.subcode === OVERSIZED_SYNC_SUBCODE
  );
}

export interface AdsInsightsQuery {
  /** `act_<id>` or a campaign / ad set / ad id. */
  readonly objectId: string;
  /** Aggregation level Graph reports at. */
  readonly level?: 'account' | 'campaign' | 'adset' | 'ad';
  readonly fields?: string;
  /** Graph date preset (e.g. `last_7d`). Ignored when `since`/`until` are given. */
  readonly datePreset?: string;
  readonly since?: string;
  readonly until?: string;
  readonly breakdowns?: readonly string[];
  /** `1` for a daily series, `all_days` for one aggregate row. */
  readonly timeIncrement?: string;
}

export interface AdsInsightsOptions extends AdsRequestOptions, AdsInsightsQuery {
  readonly limit?: number;
  readonly after?: Cursor;
  readonly maxRows?: number;
  /** True ⇒ skip the sync attempt and start an async report run immediately. */
  readonly forceAsync?: boolean;
}

export interface AdsInsightsResult extends AdPagedResult {
  readonly mode: 'sync' | 'async';
  readonly objectId: string;
  /** Present in `sync` mode; absent when an async run was started instead. */
  readonly rows?: readonly AdRecord[];
  readonly rowCount?: number;
  /** Present in `async` mode — poll it with the report-status tool. */
  readonly reportRunId?: string;
  readonly notes: readonly string[];
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse one end of the insights window as a calendar date. Graph answers a
 * malformed or reversed `time_range` with a bare 400 "Invalid parameter" that
 * names neither end, so the shape is checked here, before the request. Mirrors
 * the Page-insights guard (`api/insights.ts`) minus its 90-day ceiling: ads
 * insights are not capped per call. Totals reach back up to 37 months; since
 * 2026-01-12 unique-count fields and hourly breakdowns reach 13 months and
 * frequency breakdowns 6, which Graph enforces itself.
 */
function parseWindowDate(label: 'since' | 'until', value: string): number {
  if (!DATE_ONLY.test(value)) {
    throw validationError(
      `Invalid \`${label}\`: "${value}". Use a calendar date in YYYY-MM-DD form.`,
    );
  }
  const ms = Date.parse(`${value}T00:00:00Z`);
  // `Date.parse` accepts 2026-02-30 by rolling over; the round-trip catches it.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw validationError(`Invalid \`${label}\`: "${value}" is not a real date.`);
  }
  return ms;
}

function insightsParams(query: AdsInsightsQuery): Record<string, ParamValue> {
  const params: Record<string, ParamValue> = {
    fields: withInsightsCurrency(query.fields ?? ADS_INSIGHTS_DEFAULT_FIELDS),
  };
  if (query.level !== undefined) params.level = query.level;
  if (query.since !== undefined || query.until !== undefined) {
    // Graph takes the window as a JSON object literal; a lone end is invalid.
    if (query.since === undefined || query.until === undefined) {
      throw validationError(
        'Insights window incomplete: pass BOTH `since` and `until` (YYYY-MM-DD), or neither and use `date_preset` instead.',
      );
    }
    const sinceMs = parseWindowDate('since', query.since);
    const untilMs = parseWindowDate('until', query.until);
    if (sinceMs > untilMs) {
      throw validationError(
        `Invalid window: \`since\` (${query.since}) is after \`until\` (${query.until}).`,
      );
    }
    params.time_range = JSON.stringify({ since: query.since, until: query.until });
  } else if (query.datePreset !== undefined) {
    params.date_preset = query.datePreset;
  }
  if (query.breakdowns !== undefined && query.breakdowns.length > 0) {
    params.breakdowns = query.breakdowns.join(',');
  }
  if (query.timeIncrement !== undefined) params.time_increment = query.timeIncrement;
  return params;
}

/**
 * The page size to ask Graph for, never more than the row cap. Rows past the cap
 * are dropped AND the cursor withheld (it would resume past them), so a page
 * larger than the cap turns into rows nobody can reach; asking for at most the
 * cap keeps the cursor walk intact. An explicit `limit` inside the cap, or none
 * at all when the default page already fits, is sent unchanged.
 */
export function cappedPageLimit(
  limit: number | undefined,
  maxRows: number,
): number | undefined {
  const requested = limit ?? DEFAULT_PAGE_LIMIT;
  return requested > maxRows ? maxRows : limit;
}

export function capRows(
  rows: readonly AdRecord[],
  maxRows: number,
): {
  readonly kept: readonly AdRecord[];
  readonly note?: string;
} {
  if (rows.length <= maxRows) return { kept: rows };
  return {
    kept: rows.slice(0, maxRows),
    note: `Row cap reached: kept the first ${String(maxRows)} of ${String(rows.length)} rows. Narrow the window, drop a breakdown, or set time_increment=all_days for totals.`,
  };
}

/**
 * Start an async report run and return its id. This is the escape hatch for
 * queries Graph refuses to answer synchronously (CC-ADS-5); the run is polled
 * with {@link getReportRunStatus} and read with {@link fetchReportResults}.
 */
export async function startAdsReport(
  fbRequest: FbRequestFn,
  opts: AdsRequestOptions & AdsInsightsQuery,
): Promise<string> {
  const res = await fbRequest<unknown>({
    protocol: 'json',
    method: 'POST',
    host: 'graph',
    api: MARKETING_API,
    path: `/${opts.objectId}/insights`,
    body: insightsParams(opts),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  const body: Record<string, unknown> = isRecord(res.data) ? res.data : {};
  const id = readReportRunId(body.report_run_id);
  if (id === undefined || id === '') {
    throw new GraphApiError(
      'Async insights run was accepted but Graph returned no `report_run_id`, so there is nothing to poll. Retry the request; if it repeats, narrow the query and use the synchronous path.',
      {
        code: 1,
        httpStatus: 200,
        action: classifyGraphError({ code: 1, message: 'no report_run_id' }),
      },
    );
  }
  return id;
}

/**
 * Read insights synchronously, falling back to an async report run when Graph
 * says the query is too large (error 100 / subcode 1487534). The fallback does
 * NOT wait: it returns the `report_run_id` plus polling instructions, because a
 * report run can take minutes and a tool call must not hold the connection.
 */
export async function fetchAdsInsights(
  fbRequest: FbRequestFn,
  opts: AdsInsightsOptions,
): Promise<AdsInsightsResult> {
  const maxRows = opts.maxRows ?? ADS_INSIGHTS_MAX_ROWS;

  if (opts.forceAsync === true) {
    const reportRunId = await startAdsReport(fbRequest, opts);
    return asyncStarted(opts.objectId, reportRunId, false);
  }

  const limit = cappedPageLimit(opts.limit, maxRows);
  let page;
  try {
    page = await fetchPage<unknown>(
      fbRequest,
      adsEdge(`/${opts.objectId}/insights`, insightsParams(opts), opts),
      {
        ...(limit !== undefined ? { limit } : {}),
        ...(opts.after !== undefined ? { after: opts.after } : {}),
      },
    );
  } catch (err) {
    if (!isOversizedSyncError(err)) throw err;
    const reportRunId = await startAdsReport(fbRequest, opts);
    return asyncStarted(opts.objectId, reportRunId, true);
  }

  const rows = page.data.map((row) => normalizeInsightsRow(row));
  const capped = capRows(rows, maxRows);
  const notes: string[] = [];
  if (capped.note !== undefined) notes.push(capped.note);
  if (rows.length === 0 && !page.truncated && page.nextCursor !== undefined) {
    // An empty slice beside a forward cursor (CC-PAGE-1): rows may follow, so
    // neither "never delivered" nor "end of the walk" below is true here.
    notes.push(EMPTY_INSIGHTS_PAGE_MORE_FOLLOWS_NOTE);
  } else if (rows.length === 0 && !page.truncated) {
    // Same distinction `listAdObjects` draws: a page fetched WITH a forward
    // cursor is a continuation of a page that HAD rows, so an empty answer is
    // the end of the walk — not evidence that the object "never delivered",
    // which would contradict the rows the caller is already holding.
    notes.push(
      opts.after !== undefined
        ? 'No further insights rows. This page was fetched with a forward cursor, so the read has run past the last row — this says nothing about whether the object delivered in the window.'
        : 'No insights rows for this object and window. Insights are empty (not an error) when the object never delivered in the window; attribution also lags, so the last day or two can be incomplete.',
    );
  }

  return {
    mode: 'sync',
    objectId: opts.objectId,
    rows: capped.kept,
    rowCount: capped.kept.length,
    truncated: page.truncated || capped.note !== undefined,
    ...(page.nextCursor !== undefined && capped.note === undefined
      ? { nextCursor: page.nextCursor }
      : {}),
    ...(page.note !== undefined ? { note: page.note } : {}),
    notes,
  };
}

function asyncStarted(
  objectId: string,
  reportRunId: string,
  fellBack: boolean,
): AdsInsightsResult {
  return {
    mode: 'async',
    objectId,
    reportRunId,
    truncated: false,
    notes: [
      fellBack
        ? `Graph refused this query synchronously because it is too large, so an async report run was started instead (report_run_id ${reportRunId}). NO rows were read yet.`
        : `Async report run ${reportRunId} started. NO rows were read yet.`,
      `Poll facebook_ads_report_status with report_run_id=${reportRunId} — wait about ${String(
        REPORT_POLL_INTERVAL_MS / 1000,
      )}s between probes, and stop polling after ~${String(
        REPORT_STALL_MS / 60_000,
      )} minutes without progress rather than looping. The id resolves for ${String(
        REPORT_RUN_TTL_DAYS,
      )} days.`,
      ADS_RATE_LIMIT_NOTE,
    ],
  };
}
