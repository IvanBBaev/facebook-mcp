// The `ads` tool package (tasks V09 read / V10 control) — Marketing API access,
// deliberately rescoped for 1.1 to READ plus status/budget CONTROL (doc 06,
// A12). The ad create-chain, deletion and image upload are out of scope, so
// nothing here can bring a new spending object into existence: every write
// targets an object the operator already created in Ads Manager.
//
//   * facebook_list_campaigns / _adsets / _ads — one cursor page of objects under
//     an ad account, at the level the tool name names.
//   * facebook_get_ad_object      — any campaign / ad set / ad by id.
//   * facebook_ads_insights       — sync insights with an automatic async
//     fallback for queries Graph refuses to answer synchronously.
//   * facebook_ads_report_status  — probe one async run and, on request, read its
//     rows once it is complete.
//   * facebook_update_ad_object   — pause/resume and budget changes, plan-gated.
//
// Division of labour with `../api/ads-read.js` and `../api/ads-control.js`
// follows the layer rule (core ← api ← mcp ← tools). The api modules own the
// Graph calls, the ad-account id normalisation, the `effective_status` truth
// (CC-ADS-2), minor-unit budgets (CC-ADS-3), the async report-run state machine
// (CC-ADS-5), ad-account health (CC-ADS-6), the ceiling refusal (CC-ADS-7) and
// the PURE planner. This module owns the zod schemas, the model-facing prose and
// the write-gate wiring — it re-derives none of that logic, so a refused budget
// or a read-only object produces the api module's one actionable message rather
// than a zod issue that disagrees with it.
//
// Three things worth knowing before reading further:
//
//   1. NO `profile` ARGUMENT. Ads objects hang off an AD ACCOUNT, not a Page, and
//      they are authorized by the user/system token rather than a Page token
//      (C1). The Page selector every other package carries would be a lie here,
//      so these tools take `ad_account_id` (defaulting to `FB_AD_ACCOUNT_ID`)
//      and nothing else.
//   2. THE PLAN IS BUILT BY THE API LAYER, PURELY. `planAdObjectUpdate` makes no
//      request, so the dry run classifies the tier, computes the warnings and
//      refuses over-ceiling budgets with no chance of a write reaching Graph.
//      The tier is the PLAN's tier, not a constant: pausing is `irreversible`,
//      resuming or raising a budget is `spend`.
//   3. THE PRE-READ IS REUSED AS THE DIVERGENCE SNAPSHOT. The handler must read
//      the object anyway (the planner needs the current values), so that same
//      read answers the gate's first `readState()` call instead of a second GET.
//      A later call — the gate comparing at apply time — re-reads for real.

import { z } from 'zod';

import type {
  PackageSpec,
  ToolAnnotations,
  ToolContext,
  ToolResult,
} from '../core/index.js';
import {
  ADS_INSIGHTS_MAX_ROWS,
  ADS_RATE_LIMIT_NOTE,
  AD_LEVELS,
  EFFECTIVE_STATUS_NOTE,
  REPORT_RUN_TTL_DAYS,
  type AdAccountInfo,
  type AdLevel,
  type AdRecord,
  fetchAdsInsights,
  fetchReportResults,
  getAdObject,
  getReportRunStatus,
  listAdObjects,
  normalizeAdAccountId,
  readAdAccount,
  resolveAdAccountId,
  assertAdAccountUsable,
} from '../api/ads-read.js';
import type { AdWriteIntent } from '../api/ads-read.js';
import {
  SETTABLE_STATUSES,
  applyAdObjectUpdate,
  planAdObjectUpdate,
} from '../api/ads-control.js';
import type { SettableStatus } from '../api/ads-control.js';
import { defineTool } from '../mcp/index.js';
import {
  afterArg,
  applyArg,
  confirmTokenArg,
  executeWrite,
  gateArgs,
  limitArg,
  planIdArg,
  shapeFor,
} from './shared.js';

// ---------------------------------------------------------------------------
// 1. Annotation quadruples (doc 06, one line per tool)
// ---------------------------------------------------------------------------

/** Every read tool in this package: read-only, non-destructive, idempotent, open-world. */
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * `facebook_update_ad_object` (doc 06). A budget write OVERWRITES the previous
 * value and the API cannot give it back, so `destructiveHint:true`; both writes
 * set a field to a fixed value, so repeating the call lands on the same state
 * and `idempotentHint:true`.
 */
const UPDATE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

// ---------------------------------------------------------------------------
// 2. Input fields
// ---------------------------------------------------------------------------

const adAccountIdArg = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    'Ad account to read, as "act_1234567890" or the bare digits. Omitted ⇒ the account configured in FB_AD_ACCOUNT_ID. A Page id or a Business id will not work here.',
  );

/**
 * Object ids are interpolated into `/{objectId}` and `/{objectId}/insights`, so
 * the shape check is PATH CONTAINMENT, not cosmetics: the WHATWG URL parser
 * resolves dot segments when the path is assigned, and `".."` would climb out of
 * the pinned API version. Ads ids are digits, but `act_<id>` is legal on the
 * insights edge, hence the underscore.
 */
const AD_OBJECT_ID_SHAPE = /^[A-Za-z0-9_]+$/;

const objectIdArg = z
  .string()
  .trim()
  .min(1)
  .regex(
    AD_OBJECT_ID_SHAPE,
    'Expected a numeric ads object id (or an "act_<id>" ad account id), not a URL, a name or an Ads Manager link. Get ids from facebook_list_campaigns / facebook_list_adsets / facebook_list_ads.',
  )
  .describe(
    'The campaign, ad set or ad to act on, by id. Ids come from the listing tools; Ads Manager URLs are rejected.',
  );

const levelArg = z
  .enum(AD_LEVELS)
  .optional()
  .describe(
    'Which kind of object this id is: "campaign", "adset" or "ad". Optional but recommended — with it the read returns the richer per-level field set and a budget write is validated against the level (an ad has no budget of its own).',
  );

const fieldsArg = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    'Comma-separated Graph field list overriding this tool\'s default selection (e.g. "id,name,status,effective_status,daily_budget"). Creative blobs and targeting specs are deliberately outside the defaults because they blow the result budget; request them explicitly if you need them.',
  );

const effectiveStatusArg = z
  .array(z.string().trim().min(1))
  .min(1)
  .max(12)
  .optional()
  .describe(
    'Filter applied SERVER-side by Graph, e.g. ["ACTIVE"] or ["PAUSED","CAMPAIGN_PAUSED"]. Graph\'s own default already hides archived and deleted objects, so pass ["ARCHIVED"] explicitly to see them.',
  );

const insightsLevelArg = z
  .enum(['account', 'campaign', 'adset', 'ad'])
  .optional()
  .describe(
    'Aggregation level Graph reports at — one row per object of that level under the requested id. Omitted ⇒ Graph aggregates at the level of the id itself.',
  );

const datePresetArg = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    'Graph date preset, e.g. "today", "yesterday", "last_7d", "last_30d", "this_month". Ignored when both `since` and `until` are given.',
  );

const sinceArg = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    'Window start as "YYYY-MM-DD" (inclusive, ad-account timezone). Must be paired with `until` — a lone end is rejected before the request.',
  );

const untilArg = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    'Window end as "YYYY-MM-DD" (inclusive). Must be paired with `since`. Attribution lags, so the last day or two of any window is still moving.',
  );

const breakdownsArg = z
  .array(z.string().trim().min(1))
  .min(1)
  .max(4)
  .optional()
  .describe(
    'Graph breakdown dimensions, e.g. ["age","gender"] or ["publisher_platform"]. Each breakdown MULTIPLIES the row count, which is the fastest way to hit the row cap or to push the query onto the async path — add them one at a time.',
  );

const timeIncrementArg = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    'Row granularity: "1" for a daily series, "all_days" for a single aggregate row, or a number of days. Use "all_days" when you only need totals — it is the cheapest way to stay inside the result budget.',
  );

const maxRowsArg = z
  .number()
  .int()
  .min(1)
  .max(ADS_INSIGHTS_MAX_ROWS)
  .optional()
  .describe(
    `Lower the row cap for this call (1-${String(ADS_INSIGHTS_MAX_ROWS)}; the default and the ceiling are both ${String(ADS_INSIGHTS_MAX_ROWS)} — this argument can only shrink it). Rows past the cap are dropped and the result says so.`,
  );

const forceAsyncArg = z
  .boolean()
  .optional()
  .describe(
    'True ⇒ skip the synchronous attempt and start an async report run immediately. Use it when a query already failed as too large. The call returns a report_run_id and NO rows — it never waits for the run.',
  );

const reportRunIdArg = z
  .string()
  .trim()
  .min(1)
  .regex(
    /^[0-9]+$/,
    'Expected the numeric `reportRunId` returned by facebook_ads_insights when it fell back to the async path.',
  )
  .describe(
    `The async run to probe, as returned by facebook_ads_insights (\`reportRunId\`). Ids resolve for about ${String(REPORT_RUN_TTL_DAYS)} days.`,
  );

const fetchResultsArg = z
  .boolean()
  .optional()
  .describe(
    'True ⇒ also read the rows when (and only when) the run has completed. On an unfinished run nothing is read and the phase is reported instead, because an unfinished run answers with an EMPTY page that is indistinguishable from "this query genuinely has no data".',
  );

const statusArg = z
  .enum(SETTABLE_STATUSES)
  .optional()
  .describe(
    'New configured status: "PAUSED" stops delivery, "ACTIVE" resumes it. Resuming SPENDS MONEY. Note this sets `status`, the configuration — the object still may not deliver afterwards (parent paused, still in review, disapproved); read `effective_status` after applying. DELETED and ARCHIVED are not settable here.',
  );

const dailyBudgetMinorArg = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe(
    'New daily budget in MINOR currency units of the ad account (1000 = 10.00, not 1000.00). Integers only — there is no float budget. Campaign or ad-set level only; an ad has no budget of its own. The previous value is overwritten and cannot be recovered through the API.',
  );

const lifetimeBudgetMinorArg = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe(
    'New lifetime budget in MINOR currency units of the ad account (1000 = 10.00). Mutually exclusive with `daily_budget_minor`. A lifetime budget requires the object to have an end time — without one Graph rejects the write.',
  );

/** The fields the three listing tools share, spread into each tool's own object. */
const listAdArgs = {
  ad_account_id: adAccountIdArg,
  limit: limitArg,
  after: afterArg,
  effective_status: effectiveStatusArg,
  fields: fieldsArg,
} as const;

// ---------------------------------------------------------------------------
// 3. Parsed-input shapes
// ---------------------------------------------------------------------------

// Optional members are written `T | undefined` rather than a bare `?:` because
// `exactOptionalPropertyTypes` makes zod's inferred `{ x?: T | undefined }`
// incompatible with `{ x?: T }`.

interface ListAdInput {
  readonly ad_account_id?: string | undefined;
  readonly limit?: number | undefined;
  readonly after?: string | undefined;
  readonly effective_status?: readonly string[] | undefined;
  readonly fields?: string | undefined;
}

// ---------------------------------------------------------------------------
// 4. Handlers
// ---------------------------------------------------------------------------

/** `signal` spread, present only when the call carries an abort seam. */
function signalOf(ctx: ToolContext): { signal?: AbortSignal } {
  return ctx.signal !== undefined ? { signal: ctx.signal } : {};
}

/**
 * One cursor page of campaigns / ad sets / ads. The three listing tools differ
 * only in the level they pin, so they share this handler — a per-level copy
 * would be three chances for the effective-status contract to drift.
 */
async function listLevel(
  ctx: ToolContext,
  input: ListAdInput,
  level: AdLevel,
): Promise<ToolResult> {
  const accountId = resolveAdAccountId(input.ad_account_id, ctx.settings.adAccountId);
  const result = await listAdObjects(ctx.fbRequest, {
    accountId,
    level,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.after !== undefined ? { after: input.after } : {}),
    ...(input.effective_status !== undefined
      ? { effectiveStatus: input.effective_status }
      : {}),
    ...(input.fields !== undefined ? { fields: input.fields } : {}),
    ...signalOf(ctx),
  });
  return shapeFor(ctx, result);
}

/**
 * The subset of an ads object the gate compares for divergence: the two fields a
 * write can target, plus the delivery state. Deliberately narrow — a full node
 * diverges on every `updated_time` tick, which would make every apply fail.
 */
function divergenceState(record: AdRecord): Record<string, unknown> {
  return {
    status: record.status ?? null,
    effective_status: record.effective_status ?? null,
    daily_budget_minor: record.daily_budget_minor ?? null,
    lifetime_budget_minor: record.lifetime_budget_minor ?? null,
  };
}

/**
 * Read the ad account behind a write, when one is known: it carries the currency
 * every `*_minor` value is denominated in, and its health decides whether the
 * write is attempted at all (CC-ADS-6). An unconfigured account is NOT an error
 * here — the object id alone is enough to write; only the currency echo is lost.
 */
async function accountForWrite(
  ctx: ToolContext,
  explicit: string | undefined,
  intent: AdWriteIntent,
): Promise<AdAccountInfo | undefined> {
  const chosen = explicit ?? ctx.settings.adAccountId;
  if (chosen === undefined || chosen.trim() === '') return undefined;
  const info = await readAdAccount(ctx.fbRequest, {
    accountId: normalizeAdAccountId(chosen),
    ...signalOf(ctx),
  });
  // Refuse before the wire when the account cannot serve. Throws for a blocked
  // account in DRY RUN too, which is the point: "would this work?" is answered
  // honestly rather than with a preview that could never be applied.
  assertAdAccountUsable(info, intent);
  return info;
}

/**
 * Classify the pending update for {@link assertAdAccountUsable}. Pausing with no
 * budget field attached is the only shape that can only ever reduce spend, and
 * it is the one an account in payment trouble must never be locked out of.
 */
function writeIntent(input: {
  readonly status?: SettableStatus | undefined;
  readonly daily_budget_minor?: number | undefined;
  readonly lifetime_budget_minor?: number | undefined;
}): AdWriteIntent {
  const stopsDelivery =
    input.status === 'PAUSED' &&
    input.daily_budget_minor === undefined &&
    input.lifetime_budget_minor === undefined;
  return { stopsDelivery };
}

// ---------------------------------------------------------------------------
// 5. Package factory
// ---------------------------------------------------------------------------

/**
 * Build the `ads` package: six read tools and one write tool. OFF by default
 * (doc 06 — `ads` is excluded from the `core` profile and reached through the
 * `ads`/`all` profiles or an explicit `FB_TOOL_PACKAGES`), because a server that
 * can move money should be opted into rather than out of.
 */
export function createAdsPackage(): PackageSpec {
  const listCampaigns = defineTool({
    name: 'facebook_list_campaigns',
    title: 'List Campaigns',
    description:
      'List campaigns under one ad account, a cursor page at a time. Each record ' +
      `carries the delivery truth, not just the configuration: ${EFFECTIVE_STATUS_NOTE} ` +
      'Budgets come back as integer `*_minor` fields in the account currency ' +
      '(1000 = 10.00), never as floats. Filter server-side with effective_status; ' +
      'archived and deleted campaigns are hidden by Graph unless you ask for them. ' +
      `${ADS_RATE_LIMIT_NOTE}`,
    inputSchema: z.object(listAdArgs),
    annotations: READ_ONLY,
    handler: async (input, ctx) => listLevel(ctx, input, 'campaign'),
  });

  const listAdsets = defineTool({
    name: 'facebook_list_adsets',
    title: 'List Ad Sets',
    description:
      'List ad sets under one ad account, a cursor page at a time. Ad sets are ' +
      'where budget, schedule and targeting live, so this is the level most ' +
      'budget questions are answered at. Each record carries `effective_status` ' +
      'plus a derived `delivering` flag and a one-line explanation — an ad set ' +
      'with status ACTIVE under a PAUSED campaign is NOT delivering, and the ' +
      'record says exactly that. Budgets are integer `*_minor` fields in the ' +
      'account currency. Targeting specs are omitted from the default field set ' +
      'because they are large; request them with `fields` if you need them.',
    inputSchema: z.object(listAdArgs),
    annotations: READ_ONLY,
    handler: async (input, ctx) => listLevel(ctx, input, 'adset'),
  });

  const listAds = defineTool({
    name: 'facebook_list_ads',
    title: 'List Ads',
    description:
      'List individual ads under one ad account, a cursor page at a time. This is ' +
      'the level where review outcomes surface: `effective_status` values such as ' +
      'PENDING_REVIEW, DISAPPROVED and WITH_ISSUES appear here, each with a ' +
      'one-line explanation, so a rejected ad is never reported as "running". ' +
      'Ads have no budget of their own — budgets live on the ad set (or the ' +
      'campaign under campaign budget optimisation). Creative blobs are omitted ' +
      'from the default field set.',
    inputSchema: z.object(listAdArgs),
    annotations: READ_ONLY,
    handler: async (input, ctx) => listLevel(ctx, input, 'ad'),
  });

  const getAdObjectTool = defineTool({
    name: 'facebook_get_ad_object',
    title: 'Get Ad Object',
    description:
      'Read one campaign, ad set or ad by id. Pass `level` when you know it — the ' +
      'read then uses the richer per-level field set instead of the fields common ' +
      'to every ads object. The record carries `effective_status`, a `delivering` ' +
      'flag and an explanation of what that status means, and budgets as integer ' +
      '`*_minor` values in the account currency. Use `fields` to request anything ' +
      'outside the defaults (targeting, creative), remembering that large blobs ' +
      'are what truncate a result.',
    inputSchema: z.object({
      object_id: objectIdArg,
      level: levelArg,
      fields: fieldsArg,
    }),
    annotations: READ_ONLY,
    handler: async (input, ctx) => {
      const result = await getAdObject(ctx.fbRequest, {
        objectId: input.object_id,
        ...(input.level !== undefined ? { level: input.level } : {}),
        ...(input.fields !== undefined ? { fields: input.fields } : {}),
        ...signalOf(ctx),
      });
      return shapeFor(ctx, result);
    },
  });

  const adsInsights = defineTool({
    name: 'facebook_ads_insights',
    title: 'Ads Insights',
    description:
      'Read performance numbers (impressions, clicks, spend, reach, cpc, ctr) for ' +
      'an ad account, campaign, ad set or ad. The call is tried SYNCHRONOUSLY ' +
      'first; when Graph refuses the query for being too large, an async report ' +
      'run is started automatically and the result comes back with mode:"async" ' +
      'and a `reportRunId` and NO rows — poll it with facebook_ads_report_status ' +
      'rather than retrying this tool. Windows are either a `date_preset` or a ' +
      'since/until pair (both or neither). Breakdowns multiply rows, so add them ' +
      'one at a time; use time_increment:"all_days" for totals. Empty rows mean ' +
      'the object did not deliver in the window — that is data, not an error, and ' +
      'attribution lags leave the last day or two incomplete.',
    inputSchema: z.object({
      ad_account_id: adAccountIdArg,
      object_id: objectIdArg.optional(),
      level: insightsLevelArg,
      fields: fieldsArg,
      date_preset: datePresetArg,
      since: sinceArg,
      until: untilArg,
      breakdowns: breakdownsArg,
      time_increment: timeIncrementArg,
      limit: limitArg,
      after: afterArg,
      max_rows: maxRowsArg,
      force_async: forceAsyncArg,
    }),
    // READ_ONLY despite the async escape hatch issuing a POST. `readOnlyHint`
    // is about the caller's assets, and a report run changes none of them: it
    // creates a short-lived server-side result set that expires on its own
    // (REPORT_RUN_TTL_DAYS) and is the only way Graph will answer a query it
    // refuses synchronously. Giving this tool a write tier instead would gate
    // large insights queries behind FB_WRITE_MODE and make a read-only server
    // unable to read — the opposite of what the tier protects.
    annotations: READ_ONLY,
    handler: async (input, ctx) => {
      // No object_id ⇒ account-level insights, which is the question most people
      // mean by "how are the ads doing".
      const objectId =
        input.object_id ??
        resolveAdAccountId(input.ad_account_id, ctx.settings.adAccountId);
      const result = await fetchAdsInsights(ctx.fbRequest, {
        objectId,
        ...(input.level !== undefined ? { level: input.level } : {}),
        ...(input.fields !== undefined ? { fields: input.fields } : {}),
        ...(input.date_preset !== undefined ? { datePreset: input.date_preset } : {}),
        ...(input.since !== undefined ? { since: input.since } : {}),
        ...(input.until !== undefined ? { until: input.until } : {}),
        ...(input.breakdowns !== undefined ? { breakdowns: input.breakdowns } : {}),
        ...(input.time_increment !== undefined
          ? { timeIncrement: input.time_increment }
          : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.after !== undefined ? { after: input.after } : {}),
        ...(input.max_rows !== undefined ? { maxRows: input.max_rows } : {}),
        ...(input.force_async !== undefined ? { forceAsync: input.force_async } : {}),
        ...signalOf(ctx),
      });
      return shapeFor(ctx, result);
    },
  });

  const reportStatus = defineTool({
    name: 'facebook_ads_report_status',
    title: 'Ads Report Status',
    description:
      'Probe one async insights report run and, with fetch_results:true, read its ' +
      'rows once it has completed. One call, one answer: this tool NEVER sleeps ' +
      'and never loops — the result says which phase the run is in (pending, ' +
      'running, complete, failed, skipped), how far along it is, and when to stop ' +
      'polling. Wait about 10s between probes and give up after ~15 minutes ' +
      'without progress: very large runs can hang indefinitely and there is no ' +
      'cancel API, so the way out is a narrower run, not more polling. A FAILED ' +
      'or SKIPPED run produced nothing — start a new one instead of re-probing.',
    inputSchema: z.object({
      report_run_id: reportRunIdArg,
      fetch_results: fetchResultsArg,
      limit: limitArg,
      after: afterArg,
      max_rows: maxRowsArg,
    }),
    annotations: READ_ONLY,
    handler: async (input, ctx) => {
      const status = await getReportRunStatus(ctx.fbRequest, {
        reportRunId: input.report_run_id,
        // The injected clock, never Date.now(): the run's age and the stall
        // verdict both depend on "now" and must stay testable.
        nowMs: ctx.clock.now(),
        ...signalOf(ctx),
      });

      if (input.fetch_results !== true) return shapeFor(ctx, status);

      if (!status.resultsReady) {
        return shapeFor(ctx, {
          ...status,
          rowsRead: false,
          // Spelled out because an unfinished run answers with an empty page,
          // which a model otherwise reads as "the campaign got nothing".
          note: `fetch_results was requested but the run is ${status.phase}, so NO rows were read. An unfinished run returns an empty page that looks exactly like a query with no data — probe again once the phase is "complete".`,
        });
      }

      const results = await fetchReportResults(ctx.fbRequest, {
        reportRunId: input.report_run_id,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.after !== undefined ? { after: input.after } : {}),
        ...(input.max_rows !== undefined ? { maxRows: input.max_rows } : {}),
        ...signalOf(ctx),
      });
      return shapeFor(ctx, { ...status, rowsRead: true, ...results });
    },
  });

  const updateAdObject = defineTool({
    name: 'facebook_update_ad_object',
    title: 'Update Ad Object',
    description:
      'Pause or resume an ads object, or change its budget. Plan-first: without ' +
      'apply:true this returns a preview naming the exact before → after values ' +
      'and changes NOTHING. Applying requires apply:true plus the plan_id from ' +
      'that preview, because both writes move money — resuming starts spending ' +
      'again, and a budget write OVERWRITES the previous value with no way to ' +
      'read it back afterwards. Budgets are MINOR currency units of the ad ' +
      'account (1000 = 10.00, integers only) and are refused, never clamped, when ' +
      'they exceed FB_ADS_BUDGET_CEILING. Only campaigns and ad sets have ' +
      'budgets; archived and deleted objects are read-only and are refused before ' +
      'the request. Setting status:"ACTIVE" sets the CONFIGURATION — check ' +
      '`effective_status` afterwards to learn whether the object actually ' +
      'delivers. Creating and deleting ads objects is out of scope for this ' +
      'server; do that in Ads Manager.',
    inputSchema: z.object({
      object_id: objectIdArg,
      level: levelArg,
      ad_account_id: adAccountIdArg,
      status: statusArg,
      daily_budget_minor: dailyBudgetMinorArg,
      lifetime_budget_minor: lifetimeBudgetMinorArg,
      apply: applyArg,
      plan_id: planIdArg,
      confirm_token: confirmTokenArg,
    }),
    annotations: UPDATE_ANNOTATIONS,
    writeTier: 'irreversible',
    logFields: ['object_id', 'level', 'status'],
    handler: async (input, ctx) => {
      // The account read comes first: a disabled account refuses the whole call
      // (CC-ADS-6) before an object read that could not lead anywhere.
      const account = await accountForWrite(ctx, input.ad_account_id, writeIntent(input));
      const current = await getAdObject(ctx.fbRequest, {
        objectId: input.object_id,
        ...(input.level !== undefined ? { level: input.level } : {}),
        ...signalOf(ctx),
      });

      // Pure: no request, so a refusal (read-only object, both budget kinds,
      // over-ceiling amount) happens with certainty that nothing was written.
      const plan = planAdObjectUpdate(
        {
          objectId: input.object_id,
          ...(input.level !== undefined ? { level: input.level } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.daily_budget_minor !== undefined
            ? { dailyBudgetMinor: input.daily_budget_minor }
            : {}),
          ...(input.lifetime_budget_minor !== undefined
            ? { lifetimeBudgetMinor: input.lifetime_budget_minor }
            : {}),
        },
        {
          current: current.object,
          ...(account?.currency !== undefined ? { currency: account.currency } : {}),
          ...(ctx.settings.adsBudgetCeiling !== undefined
            ? { budgetCeilingMinor: ctx.settings.adsBudgetCeiling }
            : {}),
        },
      );

      // The gate calls readState once per execute. In plan mode that is the read
      // we just did, so the first call is answered from it; the apply call runs
      // in a later process/turn and re-reads for real.
      let pending: AdRecord | undefined = current.object;
      const readState = async (): Promise<unknown> => {
        if (pending !== undefined) {
          const snapshot = pending;
          pending = undefined;
          return divergenceState(snapshot);
        }
        const fresh = await getAdObject(ctx.fbRequest, {
          objectId: input.object_id,
          ...(input.level !== undefined ? { level: input.level } : {}),
          ...signalOf(ctx),
        });
        return divergenceState(fresh.object);
      };

      return executeWrite(ctx, {
        tool: 'facebook_update_ad_object',
        // The PLAN's tier, not a constant: pausing is irreversible, resuming or
        // raising a budget is `spend` and pulls in the out-of-band confirmer.
        tier: plan.tier,
        params: {
          object_id: input.object_id,
          ...(input.level !== undefined ? { level: input.level } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.daily_budget_minor !== undefined
            ? { daily_budget_minor: input.daily_budget_minor }
            : {}),
          ...(input.lifetime_budget_minor !== undefined
            ? { lifetime_budget_minor: input.lifetime_budget_minor }
            : {}),
        },
        ...gateArgs(input),
        summary: plan.summary,
        warnings: [...plan.warnings, ADS_RATE_LIMIT_NOTE],
        notPerformedNotice:
          'This was a dry run — nothing was changed on the ads object and no money was spent.',
        readState,
        perform: () => applyAdObjectUpdate(ctx.fbRequest, plan, ctx.signal),
        metadata: {
          objectId: input.object_id,
          ...(input.level !== undefined ? { level: input.level } : {}),
          changedFields: plan.changes.map((change) => change.field),
          increasesSpend: plan.increasesSpend,
          ...(plan.currency !== undefined ? { currency: plan.currency } : {}),
        },
      });
    },
  });

  return {
    name: 'ads',
    title: 'Ads',
    description:
      'Marketing API access: campaign / ad-set / ad listings with delivery truth, ' +
      'single-object reads, insights with async report runs, and plan-gated ' +
      'status and budget control. Off by default.',
    tools: [
      listCampaigns,
      listAdsets,
      listAds,
      getAdObjectTool,
      adsInsights,
      reportStatus,
      updateAdObject,
    ],
    enabledByDefault: false,
    // Plan-first regardless of FB_WRITE_MODE (doc 06): `FB_WRITE_MODE=apply` is
    // a convenience for cheap Page writes, and it must never silently promote a
    // budget change into a one-shot spend.
    writeModeDefault: 'plan',
  };
}
