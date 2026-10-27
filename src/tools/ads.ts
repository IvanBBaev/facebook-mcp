// The `ads` tool package (tasks V09 read / V10 control) — Marketing API access,
// deliberately rescoped for 1.1 to READ plus status/budget CONTROL (doc 06,
// A12), with single-object archive/delete added in 2.0 (v2 ads §3). New objects
// come only from copying one the operator already created in Ads Manager
// (v2 ads §7) or from the narrow boost chain for one Page post (v2 ads §1,
// `./ads-create.ts`): always PAUSED and only when the campaign is capped within
// the configured maximums. A general ad create-chain stays out of scope.
//
//   * facebook_list_campaigns / _adsets / _ads — one cursor page of objects under
//     an ad account, at the level the tool name names.
//   * facebook_get_ad_object      — any campaign / ad set / ad by id.
//   * facebook_ads_insights       — sync insights with an automatic async
//     fallback for queries Graph refuses to answer synchronously.
//   * facebook_ads_report_status  — probe one async run and, on request, read its
//     rows once it is complete.
//   * facebook_get_ad_preview     — how an ad, a creative or a Page post as an
//     ad renders in one placement; creates nothing.
//   * facebook_update_ad_object   — pause/resume and budget changes, plan-gated.
//   * facebook_archive_ad_object / facebook_delete_ad_object — retire one
//     object (and, by inheritance, its children), plan-gated and irreversible.
//   * facebook_upload_ad_image    — add a local image to the account's image
//     library and return its hash; creates no ad.
//   * facebook_get_ad_set_targeting / facebook_update_ad_set_targeting — read
//     an ad set's audience; edit only its countries and age range.
//   * facebook_duplicate_ad_object — copy one object into a PAUSED copy.
//   * facebook_boost_post          — boost one Page post as a PAUSED campaign,
//     ad set, creative and ad, rolled back if a step fails.
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

import { GraphApiError, classifyGraphError } from '../core/index.js';
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
  DEFAULT_PREVIEW_FORMAT,
  PREVIEW_FORMATS,
  generateAdPreview,
  normalizeObjectStoryId,
  type PreviewSource,
} from '../api/ads-preview.js';
import {
  SETTABLE_STATUSES,
  applyAdObjectUpdate,
  planAdObjectUpdate,
} from '../api/ads-control.js';
import type { AdUpdateOutcome, SettableStatus } from '../api/ads-control.js';
import {
  applyLifecycleChange,
  childrenTotal,
  planLifecycleChange,
  readChildCounts,
  readDelivered28d,
} from '../api/ads-lifecycle.js';
import type { LifecycleOutcome, LifecycleTarget } from '../api/ads-lifecycle.js';
import {
  AD_IMAGE_LIBRARY_NOTE,
  AD_IMAGE_RERUN_NOTE,
  MAX_AD_IMAGE_BYTES,
  assertAdImageExtension,
  uploadAdImage,
} from '../api/ads-media.js';
import type { AdImageUploadOutcome } from '../api/ads-media.js';
import {
  DELIVERY_IMPACT_NOTE,
  LEARNING_PHASE_NOTE,
  MAX_TARGETING_AGE,
  MAX_TARGETING_COUNTRIES,
  MIN_TARGETING_AGE,
  RAW_TARGETING_CAP_BYTES,
  applyTargetingEdit,
  dsaRefusal,
  hasDsaInfo,
  planTargetingEdit,
  readAdSetTargeting,
  summarizeTargeting,
  targetingBytes,
  targetingEditSummary,
  targetingFingerprint,
} from '../api/ads-targeting.js';
import type { TargetingEditOutcome } from '../api/ads-targeting.js';
import {
  MAX_RENAME_SUFFIX_LENGTH,
  applyCopy,
  planCopy,
  readCopyTree,
} from '../api/ads-copy.js';
import type { CopyOutcome, CopyTree } from '../api/ads-copy.js';
import {
  MediaSourceError,
  digestLocalMedia,
  resolveLocalMediaPath,
} from '../api/media-photos.js';
import type { LocalMediaOptions } from '../api/media-photos.js';
import {
  APPLIED_VERDICT,
  ATTEMPTED_VERDICT,
  REFUSED_VERDICT,
  defineTool,
  type WriteResultVerdict,
} from '../mcp/index.js';
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
import {
  accountForWrite,
  adAccountIdArg,
  classifyUpdateFailure,
  signalOf,
} from './ads-shared.js';
import { boostPostTool } from './ads-create.js';

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

/**
 * `facebook_upload_ad_image` (v2 ads §2). It adds a library entry and overwrites
 * nothing; Meta deduplicates by content hash, so a repeat lands on the same
 * entry.
 */
const UPLOAD_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * `facebook_duplicate_ad_object` (v2 ads §7). Every call creates new objects
 * and overwrites nothing, so it is neither destructive nor idempotent: a repeat
 * makes another copy.
 */
const COPY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

// ---------------------------------------------------------------------------
// 2. Input fields
// ---------------------------------------------------------------------------

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

const previewSourceArg = z
  .object({
    kind: z
      .enum(['ad', 'creative', 'post'])
      .describe(
        'ad ⇒ an existing ad (`id` from facebook_list_ads); creative ⇒ an existing ad creative; ' +
          'post ⇒ a Page post rendered as an ad (`id` in the "<page-id>_<post-id>" form), ' +
          'read through the ad account.',
      ),
    id: z
      .string()
      .trim()
      .min(1)
      .regex(
        AD_OBJECT_ID_SHAPE,
        'Expected a numeric ad / creative id, or "<page-id>_<post-id>" for a post — not a URL.',
      )
      .describe('The ad, creative or post id.'),
  })
  .strict()
  .describe('What to preview.');

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
    'Window start as "YYYY-MM-DD" (inclusive, ad-account timezone). Must be paired with `until` and may not be after it — a lone end, a reversed window or a date in any other form is rejected before the request. No per-call span cap: totals reach back up to 37 months, but unique-count fields (possibly `reach`) and hourly breakdowns only 13 months and frequency breakdowns only 6.',
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
    'New daily budget in MINOR currency units of the ad account. The unit is the one Meta counts for that currency (its currency offset), which is not always the ISO subunit: USD or EUR 1000 = 10.00; a zero-decimal currency such as JPY, KRW, TWD, HUF, IDR, COP or CRC 1000 = 1000; BHD or JOD count hundredths, so 1000 = 10.00. Integers only — there is no float budget. Campaign or ad-set level only; an ad has no budget of its own. The previous value is overwritten and cannot be recovered through the API.',
  );

const lifetimeBudgetMinorArg = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe(
    'New lifetime budget in MINOR currency units of the ad account — the unit Meta counts for that currency, its currency offset (USD 1000 = 10.00; zero-decimal JPY or TWD 1000 = 1000). Mutually exclusive with `daily_budget_minor`. A lifetime budget requires the object to have an end time — without one Graph rejects the write.',
  );

const spendCapMinorArg = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    'New campaign spend cap — the total the campaign may spend over its lifetime — in MINOR currency units of the ad account (same unit as the budgets). Campaign level only: pass level="campaign". Setting a first cap or lowering one is irreversible (it can stop delivery); raising one is a spend write. Refused above FB_ADS_CAMPAIGN_SPEND_CAP_MAX (raise or first set; lowering is always allowed) and below the account\'s minimum campaign spend cap. Removing a cap is not offered.',
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

/**
 * Tell the write gate whether a resolved `POST /{object-id}` actually changed
 * the ads object (`WriteAction.classifyResult`). `applyAdObjectUpdate` RETURNS
 * a refusal (`success:false`, an empty `applied` list) rather than throwing, so
 * without this hook the gate would stamp the very same call `applied` and
 * journal a budget move the account never took — the one lie a spend-tier
 * tool cannot afford. A Graph "no" on this edge changes nothing, so the
 * verdict is a plain `failed`, never `attempted`.
 */
function adUpdateVerdict(outcome: AdUpdateOutcome): WriteResultVerdict {
  return outcome.success ? APPLIED_VERDICT : REFUSED_VERDICT;
}

/**
 * The ad account an object names as its owner (`account_id`, bare digits or
 * `act_<id>`), as an `act_<id>` id — or undefined when the read carried none.
 */
function ownerAccountOf(record: Readonly<Record<string, unknown>>): string | undefined {
  const raw: unknown = record.account_id;
  const owner =
    typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
  if (owner === '') return undefined;
  return /^\d+$/.test(owner) ? `act_${owner}` : owner;
}

/**
 * Refuse a write whose object, by its own `account_id`, lives in a different ad
 * account than the one resolved for the call (the explicit argument or
 * `FB_AD_ACCOUNT_ID`). That account supplies the currency every `*_minor` value
 * in the preview is denominated in and the CC-ADS-6 health verdict, so
 * previewing against the wrong one states the budget in a foreign currency
 * (EUR vs a zero-decimal JPY is a hundredfold misstatement) and judges the
 * health of an account the write never touches. Only a read that carries
 * `account_id` (the per-level field sets do) can be checked; its absence is not
 * evidence either way.
 */
function assertObjectInAccount(
  objectId: string,
  record: Readonly<Record<string, unknown>>,
  account: AdAccountInfo | undefined,
): void {
  if (account === undefined) return;
  const ownerId = ownerAccountOf(record);
  if (ownerId === undefined || ownerId === account.id) return;
  const message =
    `Refused: ${objectId} belongs to ad account ${ownerId}, not ${account.id} (the ` +
    'account this call resolved to). Its currency and health were read from the wrong ' +
    `account, so no preview was built and nothing was changed. Pass ad_account_id:"${ownerId}".`;
  throw new GraphApiError(message, {
    code: 100,
    httpStatus: 400,
    action: classifyGraphError({ code: 100, message }),
  });
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
    spend_cap_minor: record.spend_cap_minor ?? null,
  };
}

/**
 * The fallback when no account was configured: read the account the object
 * names as its owner. Best effort for the READ only — this path used to make no
 * account request at all, so a token that can edit the object but not read its
 * account keeps writing as before, just without the currency echo. A health
 * verdict the read DID return is enforced like the configured path's.
 */
async function ownerAccountForWrite(
  ctx: ToolContext,
  record: Readonly<Record<string, unknown>>,
  intent: AdWriteIntent,
): Promise<AdAccountInfo | undefined> {
  const owner = ownerAccountOf(record);
  if (owner === undefined) return undefined;
  let info: AdAccountInfo;
  try {
    info = await readAdAccount(ctx.fbRequest, { accountId: owner, ...signalOf(ctx) });
  } catch (err) {
    if (ctx.signal?.aborted === true) throw err;
    return undefined;
  }
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
  readonly spend_cap_minor?: number | undefined;
}): AdWriteIntent {
  const stopsDelivery =
    input.status === 'PAUSED' &&
    input.daily_budget_minor === undefined &&
    input.lifetime_budget_minor === undefined &&
    input.spend_cap_minor === undefined;
  return { stopsDelivery };
}

/** A lifecycle write landed only when Graph confirmed it. */
function lifecycleVerdict(outcome: LifecycleOutcome): WriteResultVerdict {
  return outcome.success ? APPLIED_VERDICT : REFUSED_VERDICT;
}

/**
 * `facebook_archive_ad_object` / `facebook_delete_ad_object` (v2 ads §3). Two
 * names rather than one `target` argument, so the irreversibility of each is
 * explicit to the model. Both stop delivery and cascade to the children; the
 * API can undo neither, so the tier is always `irreversible`.
 */
function lifecycleTool(target: LifecycleTarget) {
  const archive = target === 'ARCHIVED';
  const name = archive ? 'facebook_archive_ad_object' : 'facebook_delete_ad_object';
  return defineTool({
    name,
    title: archive ? 'Archive Ad Object' : 'Delete Ad Object',
    description: archive
      ? 'Archive one campaign, ad set or ad by id. Its ad sets and ads are archived with it. ' +
        'Archived objects stop delivering and can only be renamed or deleted afterwards — the API ' +
        'cannot resume them. Plan-first: without apply:true this returns a preview (current status, ' +
        'children affected) and changes NOTHING; applying requires apply:true plus the plan_id from ' +
        'that preview. Pass `level` so the children can be counted. An already archived or deleted ' +
        'object is refused.'
      : 'Delete one campaign, ad set or ad by id — permanently. Its ad sets and ads are deleted with ' +
        'it, and a deleted object cannot be restored or edited. Plan-first: without apply:true this ' +
        'returns a preview (current status, children affected, a warning when it delivered in the ' +
        'last 28 days) and changes NOTHING; applying requires apply:true plus the plan_id from that ' +
        'preview. An archived object can be deleted; an already deleted one is refused. Pass `level` ' +
        'so the children can be counted. Never deletes more than this one object tree.',
    inputSchema: z.object({
      object_id: objectIdArg,
      level: levelArg,
      ad_account_id: adAccountIdArg,
      apply: applyArg,
      plan_id: planIdArg,
      confirm_token: confirmTokenArg,
    }),
    annotations: UPDATE_ANNOTATIONS,
    writeTier: 'irreversible',
    logFields: ['object_id', 'level', 'apply', 'plan_id'],
    handler: async (input, ctx) => {
      // Retiring an object stops delivery, so an account in payment trouble is
      // never locked out of it (CC-ADS-6); a disabled one still refuses.
      const intent: AdWriteIntent = { stopsDelivery: true };
      const configured = await accountForWrite(ctx, input.ad_account_id, intent);
      const current = await getAdObject(ctx.fbRequest, {
        objectId: input.object_id,
        ...(input.level !== undefined ? { level: input.level } : {}),
        ...signalOf(ctx),
      });
      assertObjectInAccount(input.object_id, current.object, configured);
      const account =
        configured ?? (await ownerAccountForWrite(ctx, current.object, intent));

      const children = await readChildCounts(
        ctx.fbRequest,
        input.object_id,
        input.level,
        ctx.signal,
      );
      const delivered28d = archive
        ? undefined
        : await readDelivered28d(ctx.fbRequest, input.object_id, ctx.signal);

      // Pure: an already deleted / already archived object is refused here.
      const plan = planLifecycleChange({
        objectId: input.object_id,
        ...(input.level !== undefined ? { level: input.level } : {}),
        current: current.object,
        target,
        ...(children !== undefined ? { children } : {}),
        ...(delivered28d !== undefined ? { delivered28d } : {}),
      });

      // The first readState call is answered from the reads just made; the
      // apply call re-reads for real.
      let pending: { record: AdRecord; childCount: number | 'unknown' } | undefined = {
        record: current.object,
        childCount: plan.childrenAffected,
      };
      const lifecycleState = (record: AdRecord, childCount: number | 'unknown') => ({
        status: record.status ?? null,
        effective_status: record.effective_status ?? null,
        childCount,
      });
      const readState = async (): Promise<unknown> => {
        if (pending !== undefined) {
          const snapshot = pending;
          pending = undefined;
          return lifecycleState(snapshot.record, snapshot.childCount);
        }
        const fresh = await getAdObject(ctx.fbRequest, {
          objectId: input.object_id,
          ...(input.level !== undefined ? { level: input.level } : {}),
          ...signalOf(ctx),
        });
        const freshChildren = await readChildCounts(
          ctx.fbRequest,
          input.object_id,
          input.level,
          ctx.signal,
        );
        const childCount = childrenTotal(input.level, freshChildren);
        return lifecycleState(fresh.object, childCount);
      };

      let cancelledBeforeSend = false;

      return executeWrite(ctx, {
        tool: name,
        tier: 'irreversible',
        params: {
          ...(account !== undefined ? { ad_account_id: account.id } : {}),
          object_id: input.object_id,
          ...(input.level !== undefined ? { level: input.level } : {}),
          to_status: target,
        },
        ...gateArgs(input),
        summary: plan.summary,
        warnings: [...plan.warnings, ADS_RATE_LIMIT_NOTE],
        notPerformedNotice: `This was a dry run — nothing was ${archive ? 'archived' : 'deleted'}.`,
        readState,
        perform: () => {
          cancelledBeforeSend = ctx.signal?.aborted === true;
          return applyLifecycleChange(ctx.fbRequest, plan, ctx.signal);
        },
        classifyResult: lifecycleVerdict,
        classifyOutcome: (err) =>
          cancelledBeforeSend ? 'failed' : classifyUpdateFailure(err),
        metadata: {
          objectId: input.object_id,
          ...(input.level !== undefined ? { level: input.level } : {}),
          from: plan.fromStatus ?? null,
          to: target,
          childCount: plan.childrenAffected,
        },
      });
    },
  });
}

/** An upload landed only when the answer carried the image's hash. */
function adImageVerdict(outcome: AdImageUploadOutcome): WriteResultVerdict {
  return outcome.image !== undefined ? APPLIED_VERDICT : ATTEMPTED_VERDICT;
}

/**
 * `facebook_upload_ad_image` (v2 ads §2). The dry run resolves the file under
 * `FB_MEDIA_DIR` and binds its size and SHA-256; the apply re-reads it and
 * refuses bytes that no longer match.
 */
const uploadAdImageTool = defineTool({
  name: 'facebook_upload_ad_image',
  title: 'Upload Ad Image',
  description:
    "Upload one local image (JPEG, PNG, GIF, BMP, TIFF or WEBP, at most 30 MB, inside FB_MEDIA_DIR) to the ad account's image library and return its hash, which creatives reference it by. Creates no ad and changes no delivery. Plan-first: without apply:true this returns a preview (file, size, account) and uploads NOTHING; applying requires apply:true plus the plan_id from that preview. Uploads are deduplicated by content hash, so re-running one is safe.",
  inputSchema: z.object({
    ad_account_id: adAccountIdArg,
    file_path: z
      .string()
      .min(1)
      .describe(
        'The image file, relative to FB_MEDIA_DIR (or an absolute path inside it).',
      ),
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('The name the image gets in the library. Omitted ⇒ the file name.'),
    apply: applyArg,
    plan_id: planIdArg,
    confirm_token: confirmTokenArg,
  }),
  annotations: UPLOAD_ANNOTATIONS,
  writeTier: 'reversible',
  logFields: ['ad_account_id', 'apply', 'plan_id'],
  handler: async (input, ctx) => {
    const accountId = resolveAdAccountId(input.ad_account_id, ctx.settings.adAccountId);
    // An upload spends nothing, so only a disabled account refuses it.
    const account = await accountForWrite(ctx, accountId, { stopsDelivery: true });
    const resolvedAccount = account?.id ?? accountId;

    const opts: LocalMediaOptions = {
      ...(ctx.settings.mediaDir !== undefined ? { mediaDir: ctx.settings.mediaDir } : {}),
      maxBytes: MAX_AD_IMAGE_BYTES,
    };
    const resolved = await resolveLocalMediaPath(input.file_path, opts);
    assertAdImageExtension(input.file_path, resolved.filename);
    const digest = await digestLocalMedia(resolved, input.file_path, opts);
    const bound = { bytes: digest.bytes, sha256: digest.sha256 };

    // The hash exists only once Graph answers; the gate journals after
    // `perform` returns, so the upload fills it in here.
    const metadata: Record<string, unknown> = {
      accountId: resolvedAccount,
      bytes: bound.bytes,
    };
    let cancelledBeforeSend = false;

    return executeWrite(ctx, {
      tool: 'facebook_upload_ad_image',
      tier: 'reversible',
      params: {
        ad_account_id: resolvedAccount,
        file_path: resolved.path,
        byte_length: bound.bytes,
        sha256: bound.sha256,
        ...(input.name !== undefined ? { name: input.name } : {}),
      },
      ...gateArgs(input),
      summary:
        `Upload ${resolved.filename} (${String(bound.bytes)} bytes, sha256 ` +
        `${bound.sha256.slice(0, 12)}) to the image library of ${resolvedAccount}` +
        (input.name !== undefined ? ` as "${input.name}"` : ''),
      warnings: [AD_IMAGE_LIBRARY_NOTE, AD_IMAGE_RERUN_NOTE],
      notPerformedNotice: 'This was a dry run — nothing was uploaded.',
      perform: async (): Promise<Record<string, unknown>> => {
        cancelledBeforeSend = ctx.signal?.aborted === true;
        const outcome = await uploadAdImage(ctx.fbRequest, opts, {
          accountId: resolvedAccount,
          requested: input.file_path,
          bound,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        });
        if (outcome.image !== undefined) metadata.hash = outcome.image.hash;
        return {
          ...outcome,
          ...(outcome.image === undefined
            ? {
                unconfirmed:
                  'Graph answered without an image hash, so the upload is unconfirmed. ' +
                  AD_IMAGE_RERUN_NOTE,
              }
            : {}),
        };
      },
      classifyResult: (result: Record<string, unknown>) =>
        adImageVerdict(result as unknown as AdImageUploadOutcome),
      // A local refusal (the file changed, or is not an image) happens before the
      // POST, so nothing can have landed.
      classifyOutcome: (err) =>
        cancelledBeforeSend || err instanceof MediaSourceError
          ? 'failed'
          : classifyUpdateFailure(err),
      metadata,
    });
  },
});

/** Ad set ids are digits only; an `act_` id or a URL is never an ad set. */
const adsetIdArg = z
  .string()
  .trim()
  .regex(/^\d+$/, 'Expected a numeric ad set id. Get ids from facebook_list_adsets.')
  .describe('The ad set, by id (from facebook_list_adsets).');

const targetingAgeArg = z
  .number()
  .int()
  .min(MIN_TARGETING_AGE)
  .max(MAX_TARGETING_AGE)
  .optional();

/**
 * `facebook_get_ad_set_targeting` (v2 ads §8). Reads the targeting blob that
 * detail reads leave out and says, in plain terms, who the ad set reaches.
 */
const getAdSetTargetingTool = defineTool({
  name: 'facebook_get_ad_set_targeting',
  title: 'Get Ad Set Targeting',
  description:
    "Read one ad set's audience and summarise it in plain terms: countries, counts of regions / cities / locales, age range, genders, placements, and flags for detailed targeting, custom audiences, exclusions and Advantage+ audience. `editable_by_this_server` says whether facebook_update_ad_set_targeting can change it, and `not_editable_because` says why not. Pass include_raw:true to also get the raw targeting spec (omitted above 64 KB).",
  inputSchema: z.object({
    adset_id: adsetIdArg,
    ad_account_id: adAccountIdArg,
    include_raw: z
      .boolean()
      .optional()
      .describe('Also return the raw targeting spec. It can be large; default false.'),
  }),
  annotations: READ_ONLY,
  handler: async (input, ctx) => {
    const read = await readAdSetTargeting(ctx.fbRequest, input.adset_id, ctx.signal);
    const configured =
      input.ad_account_id !== undefined
        ? normalizeAdAccountId(input.ad_account_id)
        : undefined;
    const owner = ownerAccountOf({ account_id: read.accountId });
    if (configured !== undefined && owner !== undefined && owner !== configured) {
      const message =
        `Ad set ${input.adset_id} belongs to ad account ${owner}, not ${configured}. ` +
        `Pass ad_account_id:"${owner}" or leave it out.`;
      throw new GraphApiError(message, {
        code: 100,
        httpStatus: 400,
        action: classifyGraphError({ code: 100, message }),
      });
    }
    const rawBytes = targetingBytes(read.targeting);
    const rawFits = rawBytes <= RAW_TARGETING_CAP_BYTES;
    return shapeFor(ctx, {
      adsetId: read.id,
      ...(read.name !== undefined ? { name: read.name } : {}),
      summary: summarizeTargeting(read.targeting),
      raw_bytes: rawBytes,
      ...(input.include_raw === true && rawFits ? { targeting: read.targeting } : {}),
      ...(input.include_raw === true && !rawFits
        ? {
            notes: [
              `The raw targeting spec is ${String(rawBytes)} bytes, above the ${String(RAW_TARGETING_CAP_BYTES)}-byte cap, so only the summary is returned.`,
            ],
          }
        : {}),
    });
  },
});

/** A targeting edit landed only when Graph confirmed it. */
function targetingVerdict(outcome: TargetingEditOutcome): WriteResultVerdict {
  return outcome.success ? APPLIED_VERDICT : REFUSED_VERDICT;
}

/**
 * `facebook_update_ad_set_targeting` (v2 ads §8). A read-modify-write of the
 * full targeting blob with only countries and ages replaced, allowed only on
 * an audience simple enough that nothing else can be lost. Tier `spend`: the
 * audience decides who the budget is spent on.
 */
const updateAdSetTargetingTool = defineTool({
  name: 'facebook_update_ad_set_targeting',
  title: 'Update Ad Set Targeting',
  description:
    "Change only the countries and/or the age range of one ad set's audience; everything else in its targeting is kept exactly as it is. Refused when the audience is more complex than that (custom audiences, detailed targeting, regions/cities/zips, exclusions, Advantage+ audience on) — check editable_by_this_server with facebook_get_ad_set_targeting first. Adding EU countries to an audience that had none needs DSA payor/beneficiary info on the ad set or the account. Plan-first: without apply:true this returns a preview (before → after) and changes NOTHING; applying requires apply:true plus the plan_id from that preview, and is refused if the targeting changed in between.",
  inputSchema: z.object({
    adset_id: adsetIdArg,
    ad_account_id: adAccountIdArg,
    countries: z
      .array(
        z
          .string()
          .trim()
          .regex(
            /^[A-Za-z]{2}$/,
            'Expected an ISO 3166-1 alpha-2 country code, e.g. "DE".',
          ),
      )
      .min(1)
      .max(MAX_TARGETING_COUNTRIES)
      .optional()
      .describe(
        `The full new country list (ISO-2 codes, 1–${String(MAX_TARGETING_COUNTRIES)}). It REPLACES the current list.`,
      ),
    age_min: targetingAgeArg.describe(
      `New minimum age (${String(MIN_TARGETING_AGE)}–${String(MAX_TARGETING_AGE)}).`,
    ),
    age_max: targetingAgeArg.describe(
      `New maximum age (${String(MIN_TARGETING_AGE)}–${String(MAX_TARGETING_AGE)}).`,
    ),
    apply: applyArg,
    plan_id: planIdArg,
    confirm_token: confirmTokenArg,
  }),
  annotations: UPDATE_ANNOTATIONS,
  writeTier: 'spend',
  logFields: ['adset_id', 'apply', 'plan_id'],
  handler: async (input, ctx) => {
    if (
      input.countries === undefined &&
      input.age_min === undefined &&
      input.age_max === undefined
    ) {
      throw new GraphApiError('Nothing to change: pass countries, age_min or age_max.', {
        code: 100,
        httpStatus: 400,
        action: classifyGraphError({ code: 100, message: 'nothing to change' }),
      });
    }
    const intent: AdWriteIntent = { stopsDelivery: false };
    const configured = await accountForWrite(ctx, input.ad_account_id, intent);
    const current = await readAdSetTargeting(ctx.fbRequest, input.adset_id, ctx.signal);
    const owner = { account_id: current.accountId };
    assertObjectInAccount(input.adset_id, owner, configured);
    const account = configured ?? (await ownerAccountForWrite(ctx, owner, intent));

    // Pure: the complexity refusal, the no-op and an inverted range happen here.
    const plan = planTargetingEdit(current.targeting, {
      ...(input.countries !== undefined ? { countries: input.countries } : {}),
      ...(input.age_min !== undefined ? { ageMin: input.age_min } : {}),
      ...(input.age_max !== undefined ? { ageMax: input.age_max } : {}),
    });
    if (plan.euAdded.length > 0) {
      const accountId = account?.id ?? ownerAccountOf(owner);
      const known = await hasDsaInfo(
        ctx.fbRequest,
        input.adset_id,
        accountId,
        ctx.signal,
      );
      if (!known) throw dsaRefusal(input.adset_id, plan.euAdded);
    }

    // The first readState call is answered from the read just made; the apply
    // call re-reads, so a concurrent edit of ANY targeting key diverges.
    let pending: string | undefined = targetingFingerprint(current.targeting);
    const readState = async (): Promise<unknown> => {
      if (pending !== undefined) {
        const snapshot = pending;
        pending = undefined;
        return { targeting: snapshot };
      }
      const fresh = await readAdSetTargeting(ctx.fbRequest, input.adset_id, ctx.signal);
      return { targeting: targetingFingerprint(fresh.targeting) };
    };

    let cancelledBeforeSend = false;

    return executeWrite(ctx, {
      tool: 'facebook_update_ad_set_targeting',
      tier: 'spend',
      params: {
        ...(account !== undefined ? { ad_account_id: account.id } : {}),
        adset_id: input.adset_id,
        ...(input.countries !== undefined ? { countries: input.countries } : {}),
        ...(input.age_min !== undefined ? { age_min: input.age_min } : {}),
        ...(input.age_max !== undefined ? { age_max: input.age_max } : {}),
      },
      ...gateArgs(input),
      summary: targetingEditSummary(input.adset_id, plan),
      warnings: [LEARNING_PHASE_NOTE, DELIVERY_IMPACT_NOTE, ADS_RATE_LIMIT_NOTE],
      notPerformedNotice:
        'This was a dry run — the ad set audience was not changed and no money was spent.',
      readState,
      perform: () => {
        cancelledBeforeSend = ctx.signal?.aborted === true;
        return applyTargetingEdit(ctx.fbRequest, input.adset_id, plan, ctx.signal);
      },
      classifyResult: targetingVerdict,
      classifyOutcome: (err) =>
        cancelledBeforeSend ? 'failed' : classifyUpdateFailure(err),
      metadata: {
        adsetId: input.adset_id,
        changedFields: plan.changedFields,
        before: plan.before,
        after: plan.after,
      },
    });
  },
});

/** A copy landed only when the answer named the copied object. */
function copyVerdict(outcome: CopyOutcome): WriteResultVerdict {
  return outcome.copiedId !== undefined ? APPLIED_VERDICT : ATTEMPTED_VERDICT;
}

/** The subset of the copy tree the gate compares for divergence. */
function copyState(tree: CopyTree): Record<string, unknown> {
  return {
    status: tree.source.status ?? null,
    source_budgets: {
      daily: tree.source.daily_budget_minor ?? null,
      lifetime: tree.source.lifetime_budget_minor ?? null,
    },
    campaign_budgets: {
      daily: tree.campaign.daily_budget_minor ?? null,
      lifetime: tree.campaign.lifetime_budget_minor ?? null,
    },
    spend_cap_minor: tree.campaign.spend_cap_minor ?? null,
    child_ads: tree.childAds ?? null,
    child_adsets: tree.childAdSets ?? null,
  };
}

/**
 * `facebook_duplicate_ad_object` (v2 ads §7). Copies one campaign, ad set or ad
 * into a PAUSED copy. The copy carries the source's budgets, so it is refused
 * when the campaign in the tree is uncapped or over the configured maximums.
 */
const duplicateAdObjectTool = defineTool({
  name: 'facebook_duplicate_ad_object',
  title: 'Duplicate Ad Object',
  description:
    'Copy one campaign, ad set or ad into a new PAUSED copy (an ad set copy stays in its campaign, ' +
    'an ad copy in its ad set). The copy is ALWAYS created paused; activating it is a separate ' +
    'facebook_update_ad_object call. deep_copy:true also copies the children (at most 3 ads). ' +
    'Refused when the campaign has no spend cap or one above FB_ADS_CAMPAIGN_SPEND_CAP_MAX, when a ' +
    'copied budget is above FB_ADS_BUDGET_CEILING, and for special-ad-category or Advantage+ ' +
    'shopping/app campaigns. Plan-first: without apply:true this returns a preview (budgets, spend ' +
    'cap, worst-case spend if activated, children) and creates NOTHING; applying requires apply:true ' +
    'plus the plan_id. Never retry an apply whose outcome is unknown — every call makes another copy.',
  inputSchema: z.object({
    object_id: objectIdArg,
    level: z
      .enum(AD_LEVELS)
      .describe(
        'Which kind of object this id is: "campaign", "adset" or "ad". Required: it decides which campaign is checked and what the answer names.',
      ),
    deep_copy: z
      .boolean()
      .default(false)
      .describe(
        'Campaign / ad set only: also copy its ad sets and ads (at most 3 ads). Default false.',
      ),
    rename_suffix: z
      .string()
      .max(MAX_RENAME_SUFFIX_LENGTH)
      .optional()
      .describe(
        'Appended to every copied name. Default " [fbmcp copy]". It is how a copy is found again.',
      ),
    ad_account_id: adAccountIdArg,
    apply: applyArg,
    plan_id: planIdArg,
    confirm_token: confirmTokenArg,
  }),
  annotations: COPY_ANNOTATIONS,
  writeTier: 'irreversible',
  logFields: ['object_id', 'level', 'deep_copy', 'apply', 'plan_id'],
  handler: async (input, ctx) => {
    // A copy is created PAUSED and spends nothing until someone activates it,
    // but it still mints new objects: an account in payment trouble is not
    // let through (CC-ADS-6).
    const intent: AdWriteIntent = { stopsDelivery: false };
    const configured = await accountForWrite(ctx, input.ad_account_id, intent);
    const readTree = () =>
      readCopyTree(ctx.fbRequest, {
        objectId: input.object_id,
        level: input.level,
        deepCopy: input.deep_copy,
        ...signalOf(ctx),
      });
    const tree = await readTree();
    assertObjectInAccount(input.object_id, tree.source, configured);
    const account = configured ?? (await ownerAccountForWrite(ctx, tree.source, intent));

    // Pure: every refusal happens before anything is created.
    const plan = planCopy({
      objectId: input.object_id,
      level: input.level,
      deepCopy: input.deep_copy,
      ...(input.rename_suffix !== undefined ? { renameSuffix: input.rename_suffix } : {}),
      tree,
      ...(account?.currency !== undefined ? { currency: account.currency } : {}),
      ...(ctx.settings.adsBudgetCeiling !== undefined
        ? { budgetCeilingMinor: ctx.settings.adsBudgetCeiling }
        : {}),
      ...(ctx.settings.adsCampaignSpendCapMax !== undefined
        ? { spendCapMaxMinor: ctx.settings.adsCampaignSpendCapMax }
        : {}),
      now: ctx.clock.now(),
    });

    let pending: CopyTree | undefined = tree;
    const readState = async (): Promise<unknown> => {
      if (pending !== undefined) {
        const snapshot = pending;
        pending = undefined;
        return copyState(snapshot);
      }
      return copyState(await readTree());
    };

    let cancelledBeforeSend = false;

    return executeWrite(ctx, {
      tool: 'facebook_duplicate_ad_object',
      tier: 'irreversible',
      params: {
        ...(account !== undefined ? { ad_account_id: account.id } : {}),
        object_id: input.object_id,
        level: input.level,
        deep_copy: input.deep_copy,
        rename_suffix: plan.renameSuffix,
      },
      ...gateArgs(input),
      summary: plan.summary,
      warnings: [...plan.warnings, ADS_RATE_LIMIT_NOTE],
      notPerformedNotice: 'This was a dry run — nothing was copied.',
      readState,
      perform: async () => {
        cancelledBeforeSend = ctx.signal?.aborted === true;
        const outcome = await applyCopy(ctx.fbRequest, plan, ctx.signal);
        const { repaused } = outcome.verification;
        if (repaused.length > 0) {
          // Its own journal entry: a status write the operator did not ask for.
          await ctx.journal.append({
            tool: 'facebook_duplicate_ad_object',
            tier: 'irreversible',
            outcome: repaused.every((entry) => entry.repaused) ? 'applied' : 'failed',
            summary: `Re-paused copies of ${input.object_id} that came back not PAUSED after the copy.`,
            metadata: {
              sourceId: input.object_id,
              repaused: repaused.map((entry) => ({
                id: entry.id,
                found: entry.found,
                repaused: entry.repaused,
              })),
            },
          });
        }
        return outcome;
      },
      classifyResult: copyVerdict,
      classifyOutcome: (err) =>
        cancelledBeforeSend ? 'failed' : classifyUpdateFailure(err),
      metadata: {
        sourceId: input.object_id,
        level: input.level,
        deepCopy: input.deep_copy,
        copiedCount: plan.copiedCount,
      },
    });
  },
});

// ---------------------------------------------------------------------------
// 5. Package factory
// ---------------------------------------------------------------------------

/**
 * Build the `ads` package: eight read tools and seven write tools. OFF by default
 * (doc 06 — `ads` is excluded from the `core` profile and reached through the
 * `ads`/`all` profiles or an explicit `FB_TOOL_PACKAGES`), because a server that
 * can move money should be opted into rather than out of.
 */
export function createAdsPackage(): PackageSpec {
  // None of the four plain reads below (the three listings and
  // facebook_get_ad_object) declares `logFields`. Their arguments are the ad
  // account — a constant the operator configured — plus paging and field
  // selection, so the per-call line could only report that the configured
  // account was read. Silence is the correct posture there; a padded allowlist
  // is worse than none.
  const listCampaigns = defineTool({
    name: 'facebook_list_campaigns',
    title: 'List Campaigns',
    description:
      'List campaigns under one ad account, a cursor page at a time. Each record ' +
      `carries the delivery truth, not just the configuration: ${EFFECTIVE_STATUS_NOTE} ` +
      'Budgets come back as integer `*_minor` fields in the account currency ' +
      '(USD 1000 = 10.00; a zero-decimal currency such as JPY has no sub-unit, so ' +
      '1000 = 1000), never as floats. Filter server-side with effective_status; ' +
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

  // No `logFields`: the arguments are an object id and a placement, and the
  // answer carries a short-lived view token that must never reach a log line.
  const getAdPreview = defineTool({
    name: 'facebook_get_ad_preview',
    title: 'Get Ad Preview',
    description:
      'Show how an existing ad, an existing ad creative, or a Page post used as an ' +
      'ad would render in one placement (`ad_format`, default MOBILE_FEED_STANDARD). ' +
      'Creates nothing and spends nothing. Returns `iframeSrc`, a facebook.com link ' +
      'to open in a browser, valid for about 24 hours; it carries a view token, so ' +
      'do not post it publicly. A post preview needs the ad account ' +
      '(`ad_account_id` or FB_AD_ACCOUNT_ID). Not every creative renders in every ' +
      'placement; Meta refuses an unsupported pairing.',
    inputSchema: z.object({
      source: previewSourceArg,
      ad_format: z
        .enum(PREVIEW_FORMATS)
        .optional()
        .describe(`Placement to render. Omitted ⇒ ${DEFAULT_PREVIEW_FORMAT}.`),
      ad_account_id: adAccountIdArg,
    }),
    annotations: READ_ONLY,
    handler: async (input, ctx) => {
      let source: PreviewSource;
      if (input.source.kind === 'post') {
        source = {
          kind: 'post',
          objectStoryId: normalizeObjectStoryId(input.source.id),
          accountId: resolveAdAccountId(input.ad_account_id, ctx.settings.adAccountId),
        };
      } else {
        if (!/^\d+$/.test(input.source.id)) {
          throw new GraphApiError(
            `Invalid ${input.source.kind} id: "${input.source.id}". Ad and creative ids are digits only.`,
            {
              code: 100,
              httpStatus: 400,
              action: classifyGraphError({ code: 100, message: 'invalid id' }),
            },
          );
        }
        source =
          input.source.kind === 'ad'
            ? { kind: 'ad', adId: input.source.id }
            : { kind: 'creative', creativeId: input.source.id };
      }
      const preview = await generateAdPreview(ctx.fbRequest, {
        source,
        adFormat: input.ad_format ?? DEFAULT_PREVIEW_FORMAT,
        nowMs: ctx.clock.now(),
        ...signalOf(ctx),
      });
      return shapeFor(ctx, { source: input.source, ...preview });
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
      'one at a time; use time_increment:"all_days" for totals. Empty rows with no ' +
      '`nextCursor` mean the object did not deliver in the window — that is data, ' +
      'not an error; an empty page that still has a `nextCursor` means more pages ' +
      'follow. Money metrics (spend, cpc, cpm, cost_per_*) are decimal amounts in ' +
      "the row's `account_currency`, not minor units. Attribution lags leave the " +
      'last day or two incomplete.',
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
    // The one read in this package that earns a line on stderr. Insights is the
    // throttled edge (ADS_RATE_LIMIT_NOTE) and the only read that can leave
    // server-side state behind, since the async escape hatch POSTs a report run.
    // An operator looking at a rate-limit wall needs the SHAPE of the query that
    // built it: which object, at which level, over which window, and whether the
    // model forced the async path. `fields` is a caller-composed field list,
    // `breakdowns` an array the projection can only render as "[array]", and
    // `after` an opaque cursor — none of them is evidence.
    logFields: [
      'ad_account_id',
      'object_id',
      'level',
      'date_preset',
      'since',
      'until',
      'force_async',
    ],
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

  // No `logFields` on the poll below: the report run it polls was already
  // recorded by facebook_ads_insights when it started one, and a
  // `report_run_id` repeated every few seconds is volume, not evidence.
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
      'or SKIPPED run produced nothing — start a new one instead of re-probing; ' +
      'when Meta stated why, `failure` carries its reason, code and subcode.',
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
        // Meta's failure reason is redacted BEFORE it is capped, so a secret the
        // cap would cut in half is still recognised and scrubbed whole.
        redactString: (s) => ctx.redactor.redactString(s),
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
      'Pause or resume an ads object, change its budget, or set a campaign spend cap. Plan-first: without ' +
      'apply:true this returns a preview naming the exact before → after values ' +
      'and changes NOTHING. Applying requires apply:true plus the plan_id from ' +
      'that preview, because both writes move money — resuming starts spending ' +
      'again, and a budget write OVERWRITES the previous value with no way to ' +
      'read it back afterwards. Budgets are MINOR currency units of the ad ' +
      'account — the unit Meta counts for that currency, its currency offset ' +
      '(USD 1000 = 10.00; zero-decimal JPY or TWD 1000 = 1000), integers only — and are refused, never ' +
      'clamped, when ' +
      'they exceed FB_ADS_BUDGET_CEILING. A campaign `spend_cap_minor` is bounded by ' +
      'FB_ADS_CAMPAIGN_SPEND_CAP_MAX and is never removed. Only campaigns and ad sets have ' +
      'budgets; archived and deleted objects are read-only and are refused before ' +
      'the request. Setting status:"ACTIVE" sets the CONFIGURATION — check ' +
      '`effective_status` afterwards to learn whether the object actually ' +
      'delivers. Creating ads objects is out of scope for this server; to archive or ' +
      'delete one, use facebook_archive_ad_object / facebook_delete_ad_object.',
    inputSchema: z.object({
      object_id: objectIdArg,
      level: levelArg,
      ad_account_id: adAccountIdArg,
      status: statusArg,
      daily_budget_minor: dailyBudgetMinorArg,
      lifetime_budget_minor: lifetimeBudgetMinorArg,
      spend_cap_minor: spendCapMinorArg,
      apply: applyArg,
      plan_id: planIdArg,
      confirm_token: confirmTokenArg,
    }),
    annotations: UPDATE_ANNOTATIONS,
    // `spend`, not `irreversible`, because the declaration is a claim about the
    // WORST tier any call can reach (see ToolSpec.writeTier) and this handler
    // does not pass a constant: `planAdObjectUpdate` classifies a pause as
    // `irreversible` and a resume or a budget raise as `spend`. Both are
    // high-consequence, so the gate behaves identically either way — but this
    // value is also what gen-metadata publishes as the tier column of the README
    // table, and `irreversible` there does not tell an operator that the only
    // money-spending tool in the server is the one they are reading about.
    writeTier: 'spend',
    // `apply` and `plan_id` are here for the same reason they are on every other
    // write: the pre-handler line survives a crash the journal never gets to
    // record, and without them this tool's line is identical whether the model
    // previewed a resume or actually resumed delivery and started spending.
    // `confirm_token` stays out — it is the operator's out-of-band secret.
    logFields: ['object_id', 'level', 'status', 'apply', 'plan_id'],
    handler: async (input, ctx) => {
      // The account read comes first: a disabled account refuses the whole call
      // (CC-ADS-6) before an object read that could not lead anywhere.
      const intent = writeIntent(input);
      const configured = await accountForWrite(ctx, input.ad_account_id, intent);
      const current = await getAdObject(ctx.fbRequest, {
        objectId: input.object_id,
        ...(input.level !== undefined ? { level: input.level } : {}),
        ...signalOf(ctx),
      });
      assertObjectInAccount(input.object_id, current.object, configured);
      // No account configured anywhere: the object names its own. Reading it is
      // what supplies the currency every `*_minor` value in the preview is
      // denominated in and the CC-ADS-6 health verdict — without it a JPY
      // budget is previewed as bare "minor units" (read as hundredths) and a
      // resume on a disabled account is previewed as if it could apply.
      const account =
        configured ?? (await ownerAccountForWrite(ctx, current.object, intent));

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
          ...(input.spend_cap_minor !== undefined
            ? { spendCapMinor: input.spend_cap_minor }
            : {}),
        },
        {
          current: current.object,
          ...(account?.currency !== undefined ? { currency: account.currency } : {}),
          ...(ctx.settings.adsBudgetCeiling !== undefined
            ? { budgetCeilingMinor: ctx.settings.adsBudgetCeiling }
            : {}),
          ...(ctx.settings.adsCampaignSpendCapMax !== undefined
            ? { spendCapMaxMinor: ctx.settings.adsCampaignSpendCapMax }
            : {}),
          ...(account?.minCampaignSpendCapMinor !== undefined
            ? { minCampaignSpendCapMinor: account.minCampaignSpendCapMinor }
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

      // Whether the caller's signal was ALREADY aborted when `perform` was
      // entered. fetch refuses an aborted signal before a byte of the POST is
      // sent, and the transport rethrows that AbortError raw — indistinguishable,
      // by the error alone, from an abort that cut a request already on the
      // wire. Only this moment can tell them apart: a cancel that won the race
      // to the POST provably changed nothing, so its entry is `failed`, not
      // "may be live". A cancel that lands later stays `attempted`.
      let cancelledBeforeSend = false;

      return executeWrite(ctx, {
        tool: 'facebook_update_ad_object',
        // The PLAN's tier, not a constant: pausing is irreversible, resuming or
        // raising a budget is `spend` and pulls in the out-of-band confirmer.
        tier: plan.tier,
        params: {
          // The RESOLVED account, not `input.ad_account_id`: it is optional and
          // falls back to `FB_AD_ACCOUNT_ID`, so pinning the raw argument would
          // let a preview that took the default be applied against an account
          // named explicitly. The account decides which object the budget is
          // read against and which currency the confirmed sentence is
          // denominated in — it is part of what the preview promised, and an
          // apply that changes it is a different write.
          ...(account !== undefined ? { ad_account_id: account.id } : {}),
          object_id: input.object_id,
          ...(input.level !== undefined ? { level: input.level } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.daily_budget_minor !== undefined
            ? { daily_budget_minor: input.daily_budget_minor }
            : {}),
          ...(input.lifetime_budget_minor !== undefined
            ? { lifetime_budget_minor: input.lifetime_budget_minor }
            : {}),
          ...(input.spend_cap_minor !== undefined
            ? { spend_cap_minor: input.spend_cap_minor }
            : {}),
        },
        ...gateArgs(input),
        summary: plan.summary,
        warnings: [...plan.warnings, ADS_RATE_LIMIT_NOTE],
        notPerformedNotice:
          'This was a dry run — nothing was changed on the ads object and no money was spent.',
        readState,
        perform: () => {
          cancelledBeforeSend = ctx.signal?.aborted === true;
          return applyAdObjectUpdate(ctx.fbRequest, plan, ctx.signal);
        },
        classifyResult: adUpdateVerdict,
        classifyOutcome: (err) =>
          cancelledBeforeSend ? 'failed' : classifyUpdateFailure(err),
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
      'single-object reads, placement previews, insights with async report runs, plan-gated ' +
      'status, budget and campaign spend-cap control, single-object archive/delete, ad image ' +
      'uploads, ad-set targeting reads with a narrow countries/ages edit, paused copies of ' +
      'campaigns, ad sets and ads, and paused boosts of Page posts. Off by default.',
    tools: [
      listCampaigns,
      listAdsets,
      listAds,
      getAdObjectTool,
      getAdPreview,
      adsInsights,
      reportStatus,
      updateAdObject,
      lifecycleTool('ARCHIVED'),
      lifecycleTool('DELETED'),
      uploadAdImageTool,
      getAdSetTargetingTool,
      updateAdSetTargetingTool,
      duplicateAdObjectTool,
      boostPostTool,
    ],
    enabledByDefault: false,
    // `writeModeDefault: 'plan'` is only the default for a server that did not
    // choose: an explicitly set `FB_WRITE_MODE=apply` overrides a package
    // default outright (see `effectiveWriteMode`). What makes the single write
    // here plan-first whatever the mode says is the tier it hands the gate —
    // `irreversible` for a pause, `spend` for a resume or a budget raise, never
    // `reversible` — because both of those ignore the mode entirely and always
    // demand the `plan_id` from a preceding preview. `FB_WRITE_MODE=apply` is a
    // convenience for cheap Page writes and must never silently promote a budget
    // change into a one-shot spend (doc 06). The default still earns its place
    // for the day a reversible ads write is added, which would otherwise inherit
    // the operator's global apply.
    writeModeDefault: 'plan',
  };
}
