// Marketing API READ plumbing (task V09, `api` layer — imports only from `core`
// and sibling `api` modules).
//
// Scope, deliberately narrow (doc 06, A12): campaign/ad-set/ad listings, a
// single-object read, and insights (sync with an automatic async fallback plus
// an explicit job-status probe). Nothing here creates, edits or deletes — the
// control half lives in `./ads-control.js`.
//
// The five things this module owns, all pure except the GET/POST calls:
//
//   1. AD-ACCOUNT ID NORMALISATION. Graph edges hang off `act_<digits>`; humans
//      and models routinely pass the bare digits, the `act_` form, or a URL
//      fragment. One normaliser, one actionable validation error naming
//      `FB_AD_ACCOUNT_ID`, so a typo never becomes a confusing Graph 400.
//   2. `effective_status` TRUTH (CC-ADS-2). `status: ACTIVE` is a CONFIGURATION,
//      not delivery. Every record carries `effective_status` plus a derived
//      `delivering` boolean and a one-line explanation of what the effective
//      status actually means (PENDING_REVIEW, CAMPAIGN_PAUSED, DISAPPROVED …),
//      because a model that reads only `status` will report a disapproved ad as
//      "running".
//   3. MINOR-UNIT BUDGETS (CC-ADS-3). Graph returns budgets as decimal STRINGS
//      of minor units ("1000" = $10.00). Those keys are replaced by integer
//      `*_minor` fields so nothing downstream is tempted to do float math on a
//      string; unparseable values are left exactly as Graph sent them.
//   4. ASYNC REPORT RUNS (CC-ADS-5). Oversized sync insights fail with error 100
//      / subcode 1487534. Rather than surfacing that as a dead end, the sync
//      path falls back to `POST /<id>/insights`, returns the `report_run_id`,
//      and a separate status probe maps `async_status` onto a small terminal-
//      state machine with polling and TIMEOUT advice. Nothing here ever sleeps
//      or loops waiting on a job.
//   5. AD-ACCOUNT HEALTH (CC-ADS-6). `account_status` / `disable_reason` are
//      decoded into labels, and a blocked account is turned into a `GraphApiError`
//      carrying the `account` error category — the shared error matrix has no
//      row that can produce it, because the signal is a successful read of a
//      field, not a Graph error.
//
// Pagination rides the shared cursor helper (`./shared.js`); usage headers
// (including `x-fb-ads-insights-throttle`) are parsed centrally by the HTTP
// client on every response and surfaced by `facebook_usage`, so this module
// adds guidance about dev-tier limits (CC-ADS-1) rather than re-parsing headers.
//
// X11 (ARC-09): the module is split by concern into src/api/ads-read/*; this
// barrel re-exports the public surface unchanged.

export {
  ADS_RATE_LIMIT_NOTE,
  AD_ACCOUNT_FIELDS,
  AD_LEVELS,
  AD_LEVEL_DETAIL_FIELDS,
  AD_LEVEL_EDGES,
  AD_LEVEL_LIST_FIELDS,
  AD_OBJECT_COMMON_FIELDS,
  MARKETING_API,
  OMITTED_BLOB_NOTE,
  isAdLevel,
} from './levels.js';
export type { AdLevel } from './levels.js';
export { normalizeAdAccountId, resolveAdAccountId } from './account-id.js';
export {
  EFFECTIVE_STATUS_EXPLANATIONS,
  EFFECTIVE_STATUS_NOTE,
  describeEffectiveStatus,
  isDelivering,
} from './effective-status.js';
export {
  EMPTY_ADS_PAGE_MORE_FOLLOWS_NOTE,
  EMPTY_INSIGHTS_PAGE_MORE_FOLLOWS_NOTE,
  PINNED_AD_FIELDS,
  normalizeAdNode,
  normalizeAdvantageState,
  normalizeInsightsRow,
  parseMinorUnits,
  withPinnedAdFields,
} from './normalize.js';
export type { AdRecord, AdvantageState } from './normalize.js';
export type {
  AdListResult,
  AdObjectResult,
  AdsRequestOptions,
  GetAdObjectOptions,
  ListAdObjectsOptions,
} from './model.js';
export { getAdObject, listAdObjects } from './listings.js';
export {
  AD_ACCOUNT_DISABLE_REASONS,
  AD_ACCOUNT_STATUS_LABELS,
  adAccountBlockedError,
  assertAdAccountUsable,
  describeAdAccount,
  readAdAccount,
} from './account.js';
export type { AdAccountInfo, AdWriteIntent } from './account.js';
export {
  ADS_INSIGHTS_DEFAULT_FIELDS,
  ADS_INSIGHTS_MAX_ROWS,
  OVERSIZED_SYNC_SUBCODE,
  REPORT_POLL_INTERVAL_MS,
  REPORT_RUN_TTL_DAYS,
  REPORT_STALL_MS,
  fetchAdsInsights,
  isOversizedSyncError,
  startAdsReport,
} from './insights.js';
export type {
  AdsInsightsOptions,
  AdsInsightsQuery,
  AdsInsightsResult,
} from './insights.js';
export {
  REPORT_RUN_FIELDS,
  REPORT_RUN_REASON_MAX_CHARS,
  classifyAsyncStatus,
  fetchReportResults,
  getReportRunStatus,
  isTerminalPhase,
  readReportRunFailure,
  reportRunAdvice,
} from './report-run.js';
export type {
  ReportResults,
  ReportResultsOptions,
  ReportRunFailure,
  ReportRunPhase,
  ReportRunStatus,
} from './report-run.js';
