// Report-run status machine (CC-ADS-5) (X11 split of `ads-read.ts`).

import { classifyGraphError } from '../../core/index.js';
import type { Cursor, ErrorAction, FbRequestFn } from '../../core/index.js';
import { fetchPage } from '../shared.js';
import {
  ADS_INSIGHTS_MAX_ROWS,
  REPORT_POLL_INTERVAL_MS,
  REPORT_STALL_MS,
  capRows,
  cappedPageLimit,
} from './insights.js';
import { MARKETING_API } from './levels.js';
import { adsEdge } from './listings.js';
import type { AdPagedResult, AdsRequestOptions } from './model.js';
import { isRecord, normalizeInsightsRow, readString } from './normalize.js';
import type { AdRecord } from './normalize.js';

// ---------------------------------------------------------------------------
// 9. Report-run status machine (CC-ADS-5)
// ---------------------------------------------------------------------------

/** Terminal-state machine over Graph's `async_status` strings. */
export type ReportRunPhase =
  'pending' | 'running' | 'complete' | 'failed' | 'skipped' | 'unknown';

/** Documented `async_status` values, lowercased, mapped onto {@link ReportRunPhase}. */
const ASYNC_STATUS_PHASES: Readonly<Record<string, ReportRunPhase>> = {
  'job not started': 'pending',
  'job started': 'running',
  'job running': 'running',
  'job completed': 'complete',
  'job failed': 'failed',
  'job skipped': 'skipped',
};

/** Phases after which nothing more will happen to the run. */
const TERMINAL_PHASES: ReadonlySet<ReportRunPhase> = new Set([
  'complete',
  'failed',
  'skipped',
]);

/**
 * Map Graph's `async_status` onto a phase. An unrecognised value becomes
 * `unknown` (and is treated as NON-terminal but reported verbatim) rather than
 * being optimistically read as "still running".
 */
export function classifyAsyncStatus(raw: unknown): ReportRunPhase {
  const text = readString(raw);
  if (text === undefined) return 'unknown';
  return ASYNC_STATUS_PHASES[text.trim().toLowerCase()] ?? 'unknown';
}

export function isTerminalPhase(phase: ReportRunPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

/**
 * Fields read off one report run. The `error_*` five exist since Marketing API
 * v25.0 (`error_code` became an int there); an older pin, or a run that did
 * not fail, simply omits them, so every one is optional on the way in.
 */
export const REPORT_RUN_FIELDS =
  'async_status,async_percent_completion,time_ref,time_completed,date_start,date_stop,' +
  'error_code,error_message,error_subcode,error_user_title,error_user_msg';

/** Hard cap on the surfaced failure reason, ellipsis included. */
export const REPORT_RUN_REASON_MAX_CHARS = 300;

/**
 * Why Meta failed or skipped a run, as far as Graph said. Present only on a
 * `failed` / `skipped` run that carried at least one `error_*` field.
 */
export interface ReportRunFailure {
  /**
   * One redacted, whitespace-collapsed, length-capped line: the user-facing
   * title/message when Graph sent one, otherwise `error_message`.
   */
  readonly reason?: string;
  readonly code?: number;
  readonly subcode?: number;
  /**
   * The error matrix's verdict for `{code, subcode}` — the same advice a
   * synchronous Graph error with that pair gets. Present whenever `code` is.
   */
  readonly action?: ErrorAction;
}

/** A Graph error number: an int since v25.0, a numeric string on older pins. */
function readErrorNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value === 'string' && /^\d{1,15}$/.test(value.trim()))
    return Number(value.trim());
  return undefined;
}

function readErrorText(value: unknown): string | undefined {
  const text = readString(value)?.replace(/\s+/g, ' ').trim();
  return text !== undefined && text.length > 0 ? text : undefined;
}

/**
 * Build the {@link ReportRunFailure} for a run body. Pure — exported for
 * testing. Redaction runs BEFORE the cap: a secret cut in half by the cap would
 * no longer match its registered value and could leak its first half.
 */
export function readReportRunFailure(
  body: Readonly<Record<string, unknown>>,
  redactString: (s: string) => string = (s) => s,
): ReportRunFailure | undefined {
  const code = readErrorNumber(body.error_code);
  const subcode = readErrorNumber(body.error_subcode);
  const userTitle = readErrorText(body.error_user_title);
  const userMsg = readErrorText(body.error_user_msg);
  const message = readErrorText(body.error_message);

  let reason: string | undefined;
  if (userTitle !== undefined && userMsg !== undefined) {
    reason = userMsg.startsWith(userTitle) ? userMsg : `${userTitle}: ${userMsg}`;
  } else {
    reason = userMsg ?? userTitle ?? message;
  }
  if (reason !== undefined) {
    reason = redactString(reason);
    if (reason.length > REPORT_RUN_REASON_MAX_CHARS)
      reason = `${reason.slice(0, REPORT_RUN_REASON_MAX_CHARS - 1)}…`;
  }

  if (reason === undefined && code === undefined && subcode === undefined)
    return undefined;
  const action =
    code !== undefined
      ? classifyGraphError({
          code,
          ...(subcode !== undefined ? { error_subcode: subcode } : {}),
          ...(message !== undefined ? { message } : {}),
        })
      : undefined;
  return {
    ...(reason !== undefined ? { reason } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(subcode !== undefined ? { subcode } : {}),
    ...(action !== undefined ? { action } : {}),
  };
}

export interface ReportRunStatus {
  readonly reportRunId: string;
  readonly phase: ReportRunPhase;
  /** Graph's raw `async_status` string, echoed for unrecognised values. */
  readonly rawStatus?: string;
  readonly percentComplete?: number;
  /** Epoch ms the run started, when Graph reported `time_ref`. */
  readonly startedAtMs?: number;
  readonly ageMs?: number;
  readonly terminal: boolean;
  /** True ⇒ results can be read now. */
  readonly resultsReady: boolean;
  /** True ⇒ the run has been alive past {@link REPORT_STALL_MS} without finishing. */
  readonly stalled: boolean;
  readonly advice: string;
  /** Meta's stated reason, on a failed or skipped run that carried one. */
  readonly failure?: ReportRunFailure;
}

function readEpochMs(value: unknown): number | undefined {
  // Graph reports `time_ref` / `time_completed` as unix SECONDS.
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    return undefined;
  return Math.round(value * 1000);
}

/** Build the operator/model advice for a phase. Pure — exported for testing. */
export function reportRunAdvice(input: {
  readonly phase: ReportRunPhase;
  readonly rawStatus?: string;
  readonly percentComplete?: number;
  readonly stalled: boolean;
}): string {
  const pct =
    input.percentComplete !== undefined
      ? ` (${String(input.percentComplete)}% complete)`
      : '';
  switch (input.phase) {
    case 'complete':
      return 'The run finished. Read the rows with facebook_ads_report_status by passing fetch_results=true, or re-run the query synchronously over a narrower window.';
    case 'failed':
      return "The run FAILED on Meta's side and produced nothing. Do not keep polling this id — start a new run over a narrower window or with fewer breakdowns.";
    case 'skipped':
      return 'Meta SKIPPED this run (usually a duplicate of a run already in flight, or an unsupported query). It produced nothing; start a new run.';
    case 'pending':
    case 'running':
      return input.stalled
        ? `The run is still ${input.phase}${pct} after more than ${String(
            REPORT_STALL_MS / 60_000,
          )} minutes. Stop polling and start a new, narrower run — very large runs can hang indefinitely and there is no cancel API.`
        : `The run is ${input.phase}${pct}. Wait about ${String(
            REPORT_POLL_INTERVAL_MS / 1000,
          )}s and probe again; stop after ~${String(
            REPORT_STALL_MS / 60_000,
          )} minutes without progress instead of polling forever.`;
    case 'unknown':
      return `Graph returned an unrecognised async_status${
        input.rawStatus !== undefined ? ` ("${input.rawStatus}")` : ''
      }, so the run's state is UNKNOWN — do not assume it is still running. Probe once more, then start a new run.`;
  }
}

/**
 * Probe one async report run. Never sleeps and never loops: one call, one
 * answer, plus explicit advice about when to stop polling (CC-ADS-5).
 */
export async function getReportRunStatus(
  fbRequest: FbRequestFn,
  opts: AdsRequestOptions & {
    readonly reportRunId: string;
    readonly nowMs: number;
    /** Scrubs the failure reason before it is capped (the tool passes its redactor). */
    readonly redactString?: (s: string) => string;
  },
): Promise<ReportRunStatus> {
  const res = await fbRequest<unknown>({
    protocol: 'json',
    method: 'GET',
    host: 'graph',
    api: MARKETING_API,
    path: `/${opts.reportRunId}`,
    params: { fields: REPORT_RUN_FIELDS },
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });

  const body: Record<string, unknown> = isRecord(res.data) ? res.data : {};
  const phase = classifyAsyncStatus(body.async_status);
  const rawStatus = readString(body.async_status);
  const percentComplete =
    typeof body.async_percent_completion === 'number'
      ? body.async_percent_completion
      : undefined;
  const startedAtMs = readEpochMs(body.time_ref);
  const ageMs =
    startedAtMs !== undefined ? Math.max(0, opts.nowMs - startedAtMs) : undefined;
  const terminal = isTerminalPhase(phase);
  const stalled = !terminal && ageMs !== undefined && ageMs > REPORT_STALL_MS;
  const failure =
    phase === 'failed' || phase === 'skipped'
      ? readReportRunFailure(body, opts.redactString)
      : undefined;

  return {
    reportRunId: opts.reportRunId,
    phase,
    ...(rawStatus !== undefined ? { rawStatus } : {}),
    ...(percentComplete !== undefined ? { percentComplete } : {}),
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    ...(ageMs !== undefined ? { ageMs } : {}),
    terminal,
    resultsReady: phase === 'complete',
    stalled,
    advice: reportRunAdvice({
      phase,
      ...(rawStatus !== undefined ? { rawStatus } : {}),
      ...(percentComplete !== undefined ? { percentComplete } : {}),
      stalled,
    }),
    ...(failure !== undefined ? { failure } : {}),
  };
}

export interface ReportResultsOptions extends AdsRequestOptions {
  readonly reportRunId: string;
  readonly limit?: number;
  readonly after?: Cursor;
  readonly maxRows?: number;
}

export interface ReportResults extends AdPagedResult {
  readonly reportRunId: string;
  readonly rows: readonly AdRecord[];
  readonly rowCount: number;
  readonly notes: readonly string[];
}

/**
 * Read the rows of a COMPLETED report run. Callers must check the phase first —
 * reading an unfinished run returns an empty page, which is indistinguishable
 * from "the query genuinely has no data" without the status probe.
 */
export async function fetchReportResults(
  fbRequest: FbRequestFn,
  opts: ReportResultsOptions,
): Promise<ReportResults> {
  const maxRows = opts.maxRows ?? ADS_INSIGHTS_MAX_ROWS;
  const limit = cappedPageLimit(opts.limit, maxRows);
  const page = await fetchPage<unknown>(
    fbRequest,
    adsEdge(`/${opts.reportRunId}/insights`, {}, opts),
    {
      ...(limit !== undefined ? { limit } : {}),
      ...(opts.after !== undefined ? { after: opts.after } : {}),
    },
  );
  const rows = page.data.map((row) => normalizeInsightsRow(row));
  const capped = capRows(rows, maxRows);
  const notes: string[] = [];
  if (capped.note !== undefined) notes.push(capped.note);

  return {
    reportRunId: opts.reportRunId,
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
