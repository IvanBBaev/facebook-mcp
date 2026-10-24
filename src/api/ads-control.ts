// Marketing API CONTROL plumbing (task V10, `api` layer — imports only from
// `core` and sibling `api` modules).
//
// The 1.1 ads scope is read + STATUS and BUDGET control only (doc 06, A12):
// no creation, no deletion, no creative uploads. That leaves exactly one write
// edge — `POST /<object-id>` with `status` and/or a budget — and this module
// exists to make that one call safe:
//
//   * PLANNING IS PURE. `planAdObjectUpdate` takes the object as it is right now
//     plus the requested change and returns the wire params, a human summary,
//     the warnings and the write TIER — or throws. Nothing here touches the
//     network, so the whole risk surface is unit-testable and the plan/apply
//     gate can run it during a dry run without any chance of a write.
//   * BUDGETS ARE INTEGER MINOR UNITS, END TO END (CC-ADS-3). The tool argument
//     is `*_budget_minor`, the validator rejects anything that is not a
//     non-negative safe integer (a float would be a silent 100x error), and the
//     plan echoes the ad account's currency so "1000" is never read as dollars.
//   * THE CEILING REFUSES, IT NEVER CLAMPS (CC-ADS-7). `FB_ADS_BUDGET_CEILING`
//     is checked here, BEFORE the request is built, and an over-ceiling raise
//     throws with the numbers and the two ways forward. Silently lowering the
//     requested amount would be the worst possible outcome: the operator would
//     believe a budget was set that was not.
//   * ARCHIVED/DELETED OBJECTS ARE READ-ONLY (CC-ADS-4). Refused locally with a
//     clear reason, and a Graph 100 on the write is re-mapped to "gone or
//     archived" instead of the generic "invalid parameter".
//
// Tier assignment (both tiers are high-consequence, so both summon the
// out-of-band confirmer — the distinction is honesty about WHY):
//   * anything that can INCREASE spend — resuming to ACTIVE, or raising a
//     budget — is `spend`;
//   * anything else that overwrites state irrecoverably — pausing, or lowering
//     a budget (the previous value is gone) — is `irreversible`.
// A mixed change takes the higher of the two. No env var bypasses either tier
// (CC-ADS-7).

import { GraphApiError, classifyGraphError } from '../core/index.js';
import type {
  ErrorAction,
  FbRequestFn,
  JsonRequest,
  ParamValue,
  WriteTier,
} from '../core/index.js';
import { MARKETING_API } from './ads-read.js';
import type { AdLevel, AdRecord } from './ads-read.js';
import {
  HUNDREDTH_OFFSET_THREE_DECIMAL_CURRENCIES,
  SPEND_CAP_REMOVAL_SENTINEL,
  ZERO_DECIMAL_CURRENCIES,
  assertSpendCapMaxReachable,
  enforceCeiling,
  enforceSpendCapMax,
  formatMinor,
  hundredthOffsetNote,
  validateBudgetMinor,
  validateSpendCapMinor,
  zeroDecimalNote,
} from './ads-money.js';

// The money helpers moved to `./ads-money.js`; re-exported so existing imports
// of this module keep working.
export {
  HUNDREDTH_OFFSET_THREE_DECIMAL_CURRENCIES,
  ZERO_DECIMAL_CURRENCIES,
  validateBudgetMinor,
} from './ads-money.js';

// ---------------------------------------------------------------------------
// 1. Constants
// ---------------------------------------------------------------------------

/** The only status values this tool will SET (archive/delete have their own tools). */
export const SETTABLE_STATUSES = ['ACTIVE', 'PAUSED'] as const;

export type SettableStatus = (typeof SETTABLE_STATUSES)[number];

/** Statuses that make an object read-only — no status or budget edit lands (CC-ADS-4). */
export const READ_ONLY_STATUSES: ReadonlySet<string> = new Set(['DELETED', 'ARCHIVED']);

/** Levels that own a budget. An ad never does — its ad set does. */
export const BUDGET_LEVELS: ReadonlySet<AdLevel> = new Set<AdLevel>([
  'campaign',
  'adset',
]);

/** Emitted whenever a resume is planned: ACTIVE is a request, not a promise. */
export const RESUME_NOT_DELIVERY_NOTE =
  'Setting status=ACTIVE only clears the pause on THIS object. It will still not deliver if a parent campaign/ad set is paused, if review has not passed, or if the schedule has ended — re-read effective_status after applying.';

/** Emitted whenever a budget is overwritten: the previous value is not recoverable. */
export const BUDGET_OVERWRITE_NOTE =
  'A budget write OVERWRITES the current value; Meta keeps no history the API can restore, so record the previous amount before applying.';

/** Emitted when a budget change is planned on an object whose parent may own the budget. */
export const CBO_CONFLICT_NOTE =
  'Budgets live either on the campaign (campaign budget optimisation) or on its ad sets, never both. If this account uses campaign budgets, an ad-set budget write is rejected by Graph — set it on the campaign instead.';

/**
 * Emitted when a lifetime budget is set on an object whose read shows no end
 * time. The key is per level (`end_time` on an ad set, `stop_time` on a
 * campaign), so the note names both rather than blame "the ad set" for a
 * campaign's missing `stop_time`.
 */
export const LIFETIME_NEEDS_END_NOTE =
  'A lifetime budget requires an end time (`end_time` on an ad set, `stop_time` on a campaign). This object has none, so Graph will reject the change until an end time is set (which this server cannot do in the 1.1 scope).';

/**
 * Emitted when a lifetime budget is planned on an object whose read did not
 * include an end-time field, so its presence could not be checked.
 */
export const LIFETIME_END_UNVERIFIED_NOTE =
  'A lifetime budget requires an end time (`end_time` on an ad set, `stop_time` on a campaign). It could not be checked: no `level` was given, so the object was read with the common field set, which carries neither. Pass level=campaign|adset to have the preview verify it; if the object has no end time, Graph rejects the write.';

/** Emitted whenever a campaign spend cap is written: it is a hard stop on delivery. */
export const SPEND_CAP_STOP_NOTE =
  'A campaign spend cap is a hard stop: once the campaign has spent this much in total (lifetime, not per day), Meta stops delivering it. The previous cap is overwritten and this server cannot remove a cap afterwards.';

/**
 * Emitted when the campaign's lifetime spend could not be compared with the new
 * cap: a cap at or below what the campaign has already spent stops it at once.
 */
export const SPEND_CAP_SPENT_UNKNOWN_NOTE =
  "The campaign's lifetime spend was not read for this preview. If it has already spent the new cap or more, the campaign stops delivering immediately — check the campaign's lifetime spend in facebook_ads_insights (date_preset=maximum) before applying.";

// ---------------------------------------------------------------------------
// 2. Errors
// ---------------------------------------------------------------------------

/** The read that shows an ads object's current status and budgets. */
const AD_OBJECT_READ_TOOL = 'facebook_get_ad_object';

function validationError(message: string): GraphApiError {
  return new GraphApiError(message, {
    code: 100,
    httpStatus: 400,
    action: classifyGraphError({ code: 100, message }),
  });
}

/**
 * Graph's stock text for a write against an object that is gone, archived or
 * invisible to this token: "Unsupported post request. Object with ID '...' does
 * not exist, cannot be loaded due to missing permissions, or does not support
 * this operation." A bare code 100 that does NOT read like this is a genuine
 * parameter fault and keeps its own words.
 */
const OBJECT_GONE_MESSAGE_RE =
  /unsupported (?:post|get) request|does not exist|cannot be loaded|does not support this operation/i;

/**
 * Re-map the write's Graph failure when it is the "object is gone or archived"
 * case (CC-ADS-4). Graph answers a status/budget write on a deleted or archived
 * object with a bare code 100, whose stock text ("Unsupported post request")
 * sends a model looking for a bad parameter that does not exist.
 *
 * The bare-100/no-subcode shape alone does NOT establish that case — Graph
 * spends the same code on real parameter faults ("Param daily_budget must be a
 * positive integer"). Re-diagnosing those as "the object may be DELETED or
 * ARCHIVED" would assert a cause nothing here established and send the model to
 * re-read a live object instead of fixing its request, so the message has to
 * look like the gone/archived answer too.
 */
export function mapUpdateError(err: unknown, objectId: string): unknown {
  if (!(err instanceof GraphApiError)) return err;
  if (err.code !== 100) return err;
  // Graph's real wire shape for this refusal is 100 WITH error_subcode 33 —
  // the subcode itself names "object does not exist / cannot be loaded / does
  // not support this operation". Left to the generic 100/33 row, the model is
  // told to "treat it as already gone", which is false for an archived object.
  // Any other subcode keeps its own, more specific diagnosis.
  if (err.subcode === 33) {
    // fall through to the re-map
  } else if (err.subcode !== undefined || !OBJECT_GONE_MESSAGE_RE.test(err.message)) {
    return err;
  }
  // The model reads the action as flat fields beside the message. Keeping the
  // bare-100 validation action would pair "the object may be gone or archived —
  // re-read it" with "fix the arguments" and no next tool, the very wrong turn
  // this re-map exists to prevent. Keep the core retry facts, restate the rest.
  const action: ErrorAction = {
    ...(err.action ?? { retryable: false }),
    category: 'not_found',
    nextTool: AD_OBJECT_READ_TOOL,
    operatorText:
      `The ads object ${objectId} may be DELETED or ARCHIVED, not on this ad account, or this token may lack permission to edit it (ads_management on the ad account) (code 100). ` +
      `Do not retry unchanged — re-read it with ${AD_OBJECT_READ_TOOL}; an archived object cannot be edited, and if the re-read shows it live, the token needs ads_management and an ad account role that allows editing.`,
  };
  return new GraphApiError(
    `${err.message} The object ${objectId} may be DELETED or ARCHIVED (archived objects are read-only), it may not exist on this ad account, or this token may lack permission to edit it (ads_management on the ad account). Nothing was changed. Re-read it with facebook_get_ad_object — if it is archived, it cannot be edited or resumed through the API; if it reads as live, grant the token ads_management and an ad account role that allows editing.`,
    {
      code: err.code,
      ...(err.subcode !== undefined ? { subcode: err.subcode } : {}),
      ...(err.type !== undefined ? { type: err.type } : {}),
      ...(err.fbtraceId !== undefined ? { fbtraceId: err.fbtraceId } : {}),
      httpStatus: err.httpStatus,
      action,
      // Graph's human-readable refusal rides on the top-level error only — the
      // error record the model sees does not render `cause`.
      ...(err.userTitle !== undefined ? { userTitle: err.userTitle } : {}),
      ...(err.userMessage !== undefined ? { userMessage: err.userMessage } : {}),
      cause: err,
    },
  );
}

// ---------------------------------------------------------------------------
// 3. Validation helpers
// ---------------------------------------------------------------------------

/** Normalise and validate a requested status. Case-insensitive on input. */
export function resolveSettableStatus(raw: string): SettableStatus {
  const upper = raw.trim().toUpperCase();
  if ((SETTABLE_STATUSES as readonly string[]).includes(upper)) {
    return upper as SettableStatus;
  }
  if (READ_ONLY_STATUSES.has(upper)) {
    throw validationError(
      `status="${raw}" is not settable through this tool. To archive or delete an ads object, use facebook_archive_ad_object / facebook_delete_ad_object.`,
    );
  }
  throw validationError(
    `Invalid status "${raw}". Use ACTIVE to resume or PAUSED to pause; nothing else can be set through this tool.`,
  );
}

// ---------------------------------------------------------------------------
// 4. Plan shapes
// ---------------------------------------------------------------------------

export type AdUpdateKind = 'status' | 'budget' | 'spend_cap';

/** One field being written, with the value it is replacing when known. */
export interface AdUpdateChange {
  readonly kind: AdUpdateKind;
  /** Wire field name (`status`, `daily_budget`, `lifetime_budget`, `spend_cap`). */
  readonly field: string;
  /** Current value, when it could be read off the object. */
  readonly from?: string | number;
  readonly to: string | number;
}

export interface AdUpdateRequest {
  readonly objectId: string;
  readonly level?: AdLevel;
  /** ACTIVE or PAUSED; anything else is refused. */
  readonly status?: string;
  readonly dailyBudgetMinor?: number;
  readonly lifetimeBudgetMinor?: number;
  /** Campaign spend cap in minor units; campaign level only, never removed. */
  readonly spendCapMinor?: number;
}

export interface AdUpdateContext {
  /** The object as it is RIGHT NOW (normalised by `ads-read`). */
  readonly current: AdRecord;
  /** ISO currency from the ad account — the unit of every `*_minor` value. */
  readonly currency?: string;
  /** `FB_ADS_BUDGET_CEILING`, in minor units. Absent ⇒ no local ceiling. */
  readonly budgetCeilingMinor?: number;
  /** `FB_ADS_CAMPAIGN_SPEND_CAP_MAX`, in minor units. Absent ⇒ no cap may be set or raised. */
  readonly spendCapMaxMinor?: number;
  /** The ad account's `min_campaign_group_spend_cap`, in minor units. */
  readonly minCampaignSpendCapMinor?: number;
  /** The campaign's lifetime spend so far, in minor units, when it was read. */
  readonly amountSpentMinor?: number;
}

export interface AdUpdatePlan {
  readonly objectId: string;
  readonly level?: AdLevel;
  /** Wire params for `POST /<object-id>`. */
  readonly params: Readonly<Record<string, ParamValue>>;
  readonly changes: readonly AdUpdateChange[];
  /** Highest tier across the requested changes. */
  readonly tier: WriteTier;
  readonly summary: string;
  readonly warnings: readonly string[];
  readonly currency?: string;
  /** True when at least one change can increase spend. */
  readonly increasesSpend: boolean;
}

// ---------------------------------------------------------------------------
// 5. The planner (pure)
// ---------------------------------------------------------------------------

/** Advantage+ campaign states whose edits this server refuses (A5). */
export const OUT_OF_SCOPE_ADVANTAGE_STATES: ReadonlySet<string> = new Set([
  'ADVANTAGE_PLUS_SALES',
  'ADVANTAGE_PLUS_APP',
]);

/** The normalised `advantage.state` of a record, upper-cased; absent when not read. */
function advantageStateOf(record: AdRecord): string | undefined {
  const advantage: unknown = record['advantage'];
  if (typeof advantage !== 'object' || advantage === null) return undefined;
  const state: unknown = (advantage as Record<string, unknown>)['state'];
  return typeof state === 'string' ? state.trim().toUpperCase() : undefined;
}

function currentString(record: AdRecord, key: string): string | undefined {
  const value: unknown = record[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * A wire status field (`status`, `effective_status`) normalized for comparison.
 *
 * Both arrive as an unvalidated cast off a Graph body — the declared `string`
 * was a hope, not a check — and every comparison this file makes against them
 * is a safety decision: the CC-ADS-4 refusal that stops an archived object from
 * being resumed, and the notice that tells an operator a spend-tier confirm
 * would change nothing. Meta documents these upper-case and sends them
 * upper-case today, so an exact-case membership test looked fine; it fails open.
 * One `"archived"` or `" ARCHIVED "` from a future API version, a partner proxy
 * or an edge that answers in its own casing, and the guard simply does not
 * fire — the plan is built, the spend gate is armed, and the operator confirms
 * a write Graph refuses anyway. {@link resolveSettableStatus} already folds the
 * OPERATOR's input this way; the wire deserves the same distrust. An empty or
 * blank value is Graph saying nothing, so it reads back as absent rather than
 * as a status named `''`.
 */
function normalizedStatus(record: AdRecord, key: string): string | undefined {
  const raw = currentString(record, key);
  if (raw === undefined) return undefined;
  const folded = raw.trim().toUpperCase();
  return folded === '' ? undefined : folded;
}

/**
 * The wire key that carries an object's end date. It differs by level: an ad
 * set has `end_time`; a campaign has `stop_time` (the merge of its ad sets' end
 * times), and `end_time` is not a campaign field at all — so reading `end_time`
 * off a campaign told a campaign that HAS a stop date "this object has none".
 */
const END_TIME_KEYS: Readonly<Record<AdLevel, readonly string[]>> = {
  campaign: ['stop_time'],
  adset: ['end_time'],
  ad: ['end_time'],
};

/**
 * Whether the object a lifetime budget is planned for has an end date.
 *
 * `end_time === undefined` once meant "Graph did not mention one" — but Graph
 * answers a field it was ASKED for and that is unset with `null`, and null is
 * not undefined; anything that is not a non-blank string is no end time. The
 * other half of that truth: a read that never ASKED for the key cannot vouch
 * that it is missing. With no `level`, `getAdObject` reads the common field
 * set, which carries neither `end_time` nor `stop_time`, so "this object has
 * none" would be a claim about a field nobody read — that case is `unverified`
 * unless the record happens to carry one of the keys anyway.
 */
function lifetimeEndState(
  record: AdRecord,
  level: AdLevel | undefined,
): 'present' | 'missing' | 'unverified' {
  const keys =
    level !== undefined ? END_TIME_KEYS[level] : (['end_time', 'stop_time'] as const);
  const present = keys.some((key) => {
    const value = currentString(record, key)?.trim();
    return value !== undefined && value !== '';
  });
  if (present) return 'present';
  return level !== undefined ? 'missing' : 'unverified';
}

function currentMinor(record: AdRecord, key: string): number | undefined {
  const value: unknown = record[`${key}_minor`];
  return typeof value === 'number' ? value : undefined;
}

/**
 * The warning a budget write gets when the object runs on the OTHER budget
 * kind. Graph reads the unused kind back as `"0"` (or omits it), so the preview
 * line alone says "daily_budget: 0 -> N" — adding a budget to an object that
 * has none — while the object is spending against a lifetime budget, and Meta
 * does not switch a published campaign or ad set between budget kinds.
 */
function budgetKindNote(
  field: string,
  otherField: string,
  otherCurrent: number,
  currency: string | undefined,
): string {
  return (
    `This object runs on a ${otherField} of ${formatMinor(otherCurrent, currency)}, not a ` +
    `${field}: the current ${field} shown in the preview (0 or unknown) is the unused ` +
    `budget kind, not a missing budget. ` +
    `Meta does not switch a published campaign or ad set between daily and lifetime ` +
    `budgets, so expect Graph to reject this write — change \`${otherField}_minor\` ` +
    `instead, or change the budget kind in Ads Manager.`
  );
}

const TIER_RANK: Readonly<Record<string, number>> = { irreversible: 1, spend: 2 };

function higherTier(a: WriteTier, b: WriteTier): WriteTier {
  return (TIER_RANK[a] ?? 0) >= (TIER_RANK[b] ?? 0) ? a : b;
}

/**
 * Turn a requested change into a validated, tier-classified plan. Pure: it makes
 * no request, so the write gate can build it during a dry run with no chance of
 * a write reaching Graph.
 *
 * @throws GraphApiError (validation) for an empty change set, a read-only
 *   object (CC-ADS-4), a non-integer or negative budget (CC-ADS-3), both budget
 *   kinds at once, or a ceiling breach (CC-ADS-7).
 */
export function planAdObjectUpdate(
  req: AdUpdateRequest,
  ctx: AdUpdateContext,
): AdUpdatePlan {
  const params: Record<string, ParamValue> = {};
  const changes: AdUpdateChange[] = [];
  const warnings: string[] = [];
  let tier: WriteTier = 'irreversible';
  let increasesSpend = false;

  if (
    req.status === undefined &&
    req.dailyBudgetMinor === undefined &&
    req.lifetimeBudgetMinor === undefined &&
    req.spendCapMinor === undefined
  ) {
    throw validationError(
      'Nothing to change: pass `status` (ACTIVE or PAUSED), a budget in minor units (`daily_budget_minor` or `lifetime_budget_minor`) and/or a campaign `spend_cap_minor`.',
    );
  }

  // CC-ADS-4 — archived/deleted objects are read-only, refused before the wire.
  const effective = normalizedStatus(ctx.current, 'effective_status');
  const configured = normalizedStatus(ctx.current, 'status');
  // DELETED wins over ARCHIVED: its next step differs (deletion is final).
  const blocking = [effective, configured].includes('DELETED')
    ? 'DELETED'
    : [effective, configured].find(
        (value) => value !== undefined && READ_ONLY_STATUSES.has(value),
      );
  if (blocking !== undefined) {
    // Meta cannot restore a deleted campaign, ad set or ad. An archived one
    // cannot be resumed through the API either, and Ads Manager does not offer
    // a restore for every archived object, so the advice must not promise one.
    const nextStep =
      blocking === 'DELETED'
        ? 'Deletion is permanent and it cannot be restored — create or duplicate a replacement in Ads Manager instead.'
        : 'Archived objects cannot be resumed through the API; if Ads Manager offers to restore it, do that there, otherwise create or duplicate a replacement.';
    throw validationError(
      `${req.objectId} is ${blocking} and is read-only: archived and deleted ads objects cannot be edited or resumed through the API. Nothing was changed. ${nextStep}`,
    );
  }

  // A5 — Advantage+ sales/app campaigns are out of scope for edits, refused
  // before Graph can reject them with a subcode no row maps yet. Pausing stays
  // allowed: a guardrail that forbids stopping the spend is worse than none.
  const advantageState = advantageStateOf(ctx.current);
  const pauseOnly =
    req.status !== undefined &&
    resolveSettableStatus(req.status) === 'PAUSED' &&
    req.dailyBudgetMinor === undefined &&
    req.lifetimeBudgetMinor === undefined &&
    req.spendCapMinor === undefined;
  if (
    advantageState !== undefined &&
    OUT_OF_SCOPE_ADVANTAGE_STATES.has(advantageState) &&
    !pauseOnly
  ) {
    throw validationError(
      `${req.objectId} is an Advantage+ ${advantageState === 'ADVANTAGE_PLUS_APP' ? 'app' : 'shopping'} campaign (${advantageState}): Advantage+ shopping/app campaigns are out of scope for this server. Nothing was changed. Edit it in Ads Manager; pausing it with status:"PAUSED" and no budget field is still allowed here.`,
    );
  }

  if (req.status !== undefined) {
    const status = resolveSettableStatus(req.status);
    if (configured === status) {
      warnings.push(
        `Status is already ${status}; applying will re-send it, which is harmless but changes nothing.`,
      );
    }
    params.status = status;
    changes.push({
      kind: 'status',
      field: 'status',
      ...(configured !== undefined ? { from: configured } : {}),
      to: status,
    });
    if (status === 'ACTIVE') {
      // A resume can start spending money again ⇒ the higher tier.
      tier = higherTier(tier, 'spend');
      increasesSpend = true;
      warnings.push(RESUME_NOT_DELIVERY_NOTE);
    }
  }

  if (req.dailyBudgetMinor !== undefined && req.lifetimeBudgetMinor !== undefined) {
    throw validationError(
      'Set either `daily_budget_minor` or `lifetime_budget_minor`, not both — an object carries one budget kind, and sending both makes the result ambiguous.',
    );
  }

  const budgets: readonly (readonly [string, number | undefined])[] = [
    ['daily_budget', req.dailyBudgetMinor],
    ['lifetime_budget', req.lifetimeBudgetMinor],
  ];

  for (const [field, requested] of budgets) {
    if (requested === undefined) continue;
    const argName = `${field}_minor`;
    validateBudgetMinor(argName, requested);

    if (req.level !== undefined && !BUDGET_LEVELS.has(req.level)) {
      throw validationError(
        `An ad has no budget of its own: set \`${argName}\` on its ad set (or on the campaign when campaign budget optimisation is on).`,
      );
    }

    const current = currentMinor(ctx.current, field);
    if (ctx.budgetCeilingMinor !== undefined) {
      enforceCeiling({
        field: argName,
        requested,
        current,
        ceiling: ctx.budgetCeilingMinor,
        currency: ctx.currency,
        objectId: req.objectId,
      });
    }

    params[field] = requested;
    changes.push({
      kind: 'budget',
      field,
      ...(current !== undefined ? { from: current } : {}),
      to: requested,
    });
    warnings.push(BUDGET_OVERWRITE_NOTE);
    if (
      ctx.currency !== undefined &&
      ZERO_DECIMAL_CURRENCIES.has(ctx.currency.trim().toUpperCase())
    ) {
      warnings.push(zeroDecimalNote(argName, requested, ctx.currency));
    }
    if (
      ctx.currency !== undefined &&
      HUNDREDTH_OFFSET_THREE_DECIMAL_CURRENCIES.has(ctx.currency.trim().toUpperCase())
    ) {
      warnings.push(hundredthOffsetNote(argName, requested, ctx.currency));
    }
    const otherField = field === 'daily_budget' ? 'lifetime_budget' : 'daily_budget';
    const otherCurrent = currentMinor(ctx.current, otherField);
    if (otherCurrent !== undefined && otherCurrent > 0 && (current ?? 0) === 0) {
      warnings.push(budgetKindNote(field, otherField, otherCurrent, ctx.currency));
    }
    if (req.level === 'adset') warnings.push(CBO_CONFLICT_NOTE);
    if (field === 'lifetime_budget') {
      const endState = lifetimeEndState(ctx.current, req.level);
      if (endState === 'missing') warnings.push(LIFETIME_NEEDS_END_NOTE);
      else if (endState === 'unverified') warnings.push(LIFETIME_END_UNVERIFIED_NOTE);
    }
    if (current === undefined || requested > current) {
      // Unknown current value is treated as a raise: assume the costlier reading.
      tier = higherTier(tier, 'spend');
      increasesSpend = true;
    }
    if (current !== undefined && requested === current) {
      warnings.push(
        `\`${argName}\` is already ${formatMinor(current, ctx.currency)}; applying changes nothing.`,
      );
    }
  }

  if (req.spendCapMinor !== undefined) {
    const raise = planSpendCap(req, ctx, params, changes, warnings);
    // Setting a first cap or lowering one can only stop delivery sooner, but it
    // overwrites the previous value: irreversible. A raise lets it spend more.
    tier = higherTier(tier, raise ? 'spend' : 'irreversible');
    if (raise) increasesSpend = true;
  }

  return {
    objectId: req.objectId,
    ...(req.level !== undefined ? { level: req.level } : {}),
    params,
    changes,
    tier,
    summary: summarizePlan(req.objectId, req.level, changes, ctx.currency),
    warnings,
    ...(ctx.currency !== undefined ? { currency: ctx.currency } : {}),
    increasesSpend,
  };
}

/**
 * The campaign's current spend cap: a positive minor-unit value, or `undefined`
 * when it has none (absent, `null` — the normaliser's reading of Meta's removal
 * sentinel — or `0`).
 */
function currentSpendCap(record: AdRecord): number | undefined {
  const value = currentMinor(record, 'spend_cap');
  return value !== undefined && value > 0 && value < SPEND_CAP_REMOVAL_SENTINEL
    ? value
    : undefined;
}

/**
 * Validate and plan the `spend_cap` part of an update, pushing its param,
 * change and warnings. Returns whether it RAISES an existing cap — the one case
 * that lets the campaign spend more.
 */
function planSpendCap(
  req: AdUpdateRequest,
  ctx: AdUpdateContext,
  params: Record<string, ParamValue>,
  changes: AdUpdateChange[],
  warnings: string[],
): boolean {
  const requested = req.spendCapMinor ?? 0;
  const argName = 'spend_cap_minor';
  if (req.level !== 'campaign') {
    throw validationError(
      `spend_cap is a campaign field: pass level="campaign" with \`${argName}\`. Ad sets and ads have no spend cap of their own. Nothing was changed.`,
    );
  }
  validateSpendCapMinor(argName, requested);
  if (requested <= 0) {
    throw validationError(
      `\`${argName}\` must be a positive integer in minor units; removing a campaign spend cap is out of scope for this server. Nothing was changed.`,
    );
  }

  const current = currentSpendCap(ctx.current);
  if (current !== undefined && requested === current) {
    throw validationError(
      `Nothing to change: the campaign spend cap of ${req.objectId} is already ${formatMinor(current, ctx.currency)}.`,
    );
  }
  const lowering = current !== undefined && requested < current;
  if (!lowering) {
    // A first cap or a raise is bounded by the operator's maximum. Lowering only
    // reduces exposure, so it stays allowed even above the max or without one.
    // A max below Meta's minimum is named first: no cap could ever pass both.
    if (ctx.spendCapMaxMinor !== undefined) {
      assertSpendCapMaxReachable(
        ctx.spendCapMaxMinor,
        ctx.minCampaignSpendCapMinor,
        ctx.currency,
      );
    }
    enforceSpendCapMax({
      field: argName,
      requested,
      current,
      max: ctx.spendCapMaxMinor,
      currency: ctx.currency,
      objectId: req.objectId,
    });
  }
  if (
    ctx.minCampaignSpendCapMinor !== undefined &&
    requested < ctx.minCampaignSpendCapMinor
  ) {
    throw validationError(
      `Refused: \`${argName}\` of ${formatMinor(requested, ctx.currency)} is below Meta's minimum campaign spend cap (${formatMinor(ctx.minCampaignSpendCapMinor, ctx.currency)}) for this account. Nothing was changed on ${req.objectId}. Request ${String(ctx.minCampaignSpendCapMinor)} or more.`,
    );
  }

  params.spend_cap = requested;
  changes.push({
    kind: 'spend_cap',
    field: 'spend_cap',
    ...(current !== undefined ? { from: current } : {}),
    to: requested,
  });
  warnings.push(SPEND_CAP_STOP_NOTE);
  if (ctx.amountSpentMinor === undefined) {
    warnings.push(SPEND_CAP_SPENT_UNKNOWN_NOTE);
  } else if (requested <= ctx.amountSpentMinor) {
    warnings.push(
      `The campaign has already spent ${formatMinor(ctx.amountSpentMinor, ctx.currency)}, at or above the new cap of ${formatMinor(requested, ctx.currency)}: the campaign stops delivering immediately after this write.`,
    );
  }
  if (
    ctx.currency !== undefined &&
    ZERO_DECIMAL_CURRENCIES.has(ctx.currency.trim().toUpperCase())
  ) {
    warnings.push(zeroDecimalNote(argName, requested, ctx.currency));
  }
  if (
    ctx.currency !== undefined &&
    HUNDREDTH_OFFSET_THREE_DECIMAL_CURRENCIES.has(ctx.currency.trim().toUpperCase())
  ) {
    warnings.push(hundredthOffsetNote(argName, requested, ctx.currency));
  }
  return current !== undefined && requested > current;
}

/** One-line, value-explicit summary for the plan preview. */
export function summarizePlan(
  objectId: string,
  level: AdLevel | undefined,
  changes: readonly AdUpdateChange[],
  currency: string | undefined,
): string {
  const what = changes
    .map((change) => {
      const money = change.kind === 'budget' || change.kind === 'spend_cap';
      const to =
        money && typeof change.to === 'number'
          ? formatMinor(change.to, currency)
          : String(change.to);
      const from =
        change.from === undefined
          ? change.kind === 'spend_cap'
            ? 'none'
            : 'unknown'
          : money && typeof change.from === 'number'
            ? formatMinor(change.from, currency)
            : String(change.from);
      return `${change.field}: ${from} -> ${to}`;
    })
    .join('; ');
  return `Update ${level ?? 'ads object'} ${objectId} — ${what}`;
}

// ---------------------------------------------------------------------------
// 6. The single write call
// ---------------------------------------------------------------------------

/** `POST /<object-id>` with the planned params. */
export function updateAdObjectRequest(
  objectId: string,
  params: Readonly<Record<string, ParamValue>>,
  signal?: AbortSignal,
): JsonRequest {
  return {
    protocol: 'json',
    method: 'POST',
    host: 'graph',
    api: MARKETING_API,
    path: `/${objectId}`,
    body: params,
    // `/<object-id>` does not say what the id is, so the transport cannot infer
    // the read that shows whether a lost write landed. Name it here: the ambiguous
    // (C2) guidance then sends the model to the ad-object read, the one tool that
    // shows the object's status and budgets.
    verifyTool: AD_OBJECT_READ_TOOL,
    ...(signal !== undefined ? { signal } : {}),
  };
}

export interface AdUpdateOutcome {
  readonly objectId: string;
  /** Graph's `success` flag when it sent one. */
  readonly success: boolean;
  /**
   * The changes Facebook CONFIRMED. Empty when `success` is false — this list
   * is what the write gate journals and shows the model, so filling it in from
   * the plan on a refused write is the server reporting a budget move that
   * never happened. What was ASKED for survives in the gate's own metadata
   * (`changedFields`) and in the echoed params, so nothing is lost by staying
   * honest here.
   */
  readonly applied: readonly AdUpdateChange[];
}

/**
 * Whether a 2xx update answer confirms the write: an empty body, a bare `true`,
 * or a record whose `success` is absent or exactly `true`. Anything else — a
 * bare `false`/`null`/`0`, or a present flag that is not `true` — is a refusal.
 */
export function confirmsAdUpdate(body: unknown): boolean {
  if (body === undefined || body === true) return true;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const flag: unknown = (body as Record<string, unknown>).success;
  return flag === undefined || flag === true;
}

/**
 * Perform the planned update. Only ever called by the write gate AFTER an
 * explicit apply — never during a dry run.
 *
 * @throws the mapped Graph error; a bare 100 that reads like Graph's
 *   nonexistent-object answer becomes the "gone or archived" explanation
 *   (CC-ADS-4). Any other failure keeps its own words.
 */
export async function applyAdObjectUpdate(
  fbRequest: FbRequestFn,
  plan: AdUpdatePlan,
  signal?: AbortSignal,
): Promise<AdUpdateOutcome> {
  try {
    const res = await fbRequest<unknown>(
      updateAdObjectRequest(plan.objectId, plan.params, signal),
    );
    // Graph answers `{ "success": true }`; a 2xx without the flag is still a
    // success on this edge, so absence is not treated as failure. A flag that is
    // PRESENT but is not that boolean (`"false"`, `0`, `null`) is Facebook
    // saying no: `!== false` read every one of those as done and handed back an
    // `applied` change list the account never took. A bare non-record body
    // (`false`, `null`, `0`) is a refusal too — collapsing it to `{}` made the
    // missing flag read as "absent, so fine" — so only an empty body or a bare
    // `true` confirms without a record (the comments/posts `confirmsWrite` rule).
    const success = confirmsAdUpdate(res.data);
    // The boolean was fixed; the change list was not. `applied: plan.changes`
    // is the list we ASKED for, and handing it back beside `success: false`
    // says "here is what changed" about an account that changed nothing — the
    // one lie a spend-tier tool cannot afford to tell. On a refusal the
    // confirmed set is empty, and it is the gate's metadata, not this field,
    // that records what was attempted.
    return {
      objectId: plan.objectId,
      success,
      applied: success ? plan.changes : [],
    };
  } catch (err) {
    throw mapUpdateError(err, plan.objectId);
  }
}
