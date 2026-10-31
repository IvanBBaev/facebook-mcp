// Boost one Page post as a PAUSED campaign → ad set → creative → ad chain
// (v2 ads §1, owner decision D3 = B: the narrow chain).
//
//   POST /act_<id>/campaigns    status PAUSED, special_ad_categories [], spend_cap
//   POST /act_<id>/adsets       status PAUSED, one budget, countries + ages only,
//                               Advantage+ audience explicitly 0
//   POST /act_<id>/adcreatives  object_story_id, Meta's creative enhancements OPT_OUT
//   POST /act_<id>/ads          status PAUSED
//
// Every object is created PAUSED and nothing spends until the operator
// activates the campaign through facebook_update_ad_object. The campaign is
// always capped within `FB_ADS_CAMPAIGN_SPEND_CAP_MAX`, the ad set budget within
// `FB_ADS_BUDGET_CEILING`, and no special ad category is ever declared, so the
// chain refuses rather than creates anything the control tools would refuse.
//
// Declaring no special ad category is the OPERATOR's statement, not this
// server's (LEG-04): the caller must pass `special_ad_category: "none"`
// explicitly, the preview repeats it, and it is bound into the plan. Meta's
// AI features are never left to a server-side default: the ad set pins
// Advantage+ audience to 0 and the creative opts out of every creative
// enhancement (Self-Serve Ad Terms, 2026-11-20).
//
// The planner is PURE: the caller reads the account and the post and passes
// them in, so every refusal happens with certainty that nothing was created.
// The chain runs sequentially with no retries. A step that fails rolls back
// the objects already created (ad, ad set, campaign; the creative is kept, it
// cannot spend). An answer lost in transit is reconciled by the plan tag in
// the object names, never by re-sending.

import { GraphApiError, classifyGraphError, isProvablyNotSent } from '../core/index.js';
import type { FbRequestFn, JsonRequest } from '../core/index.js';
import { MARKETING_API } from './ads-read.js';
import { deleteAdObjectRequest } from './ads-lifecycle.js';
import { EU_COUNTRIES } from './ads-targeting.js';
import {
  describeEnvelope,
  enforceCeiling,
  enforceSpendCapMax,
  formatMinor,
  validateBudgetMinor,
  validateSpendCapMinor,
  worstCaseEnvelope,
} from './ads-money.js';
import type { SpendEnvelope } from './ads-money.js';

// ---------------------------------------------------------------------------
// 1. Constants and shapes
// ---------------------------------------------------------------------------

export const BOOST_OBJECTIVES = [
  'OUTCOME_ENGAGEMENT',
  'OUTCOME_TRAFFIC',
  'OUTCOME_AWARENESS',
] as const;
export type BoostObjective = (typeof BOOST_OBJECTIVES)[number];

export const BOOST_BID_STRATEGIES = [
  'LOWEST_COST_WITHOUT_CAP',
  'LOWEST_COST_WITH_BID_CAP',
  'COST_CAP',
] as const;
export type BoostBidStrategy = (typeof BOOST_BID_STRATEGIES)[number];

/** The ad set optimisation goal each objective maps to. */
export const OPTIMIZATION_GOALS: Readonly<Record<BoostObjective, string>> = {
  OUTCOME_ENGAGEMENT: 'POST_ENGAGEMENT',
  OUTCOME_TRAFFIC: 'LINK_CLICKS',
  OUTCOME_AWARENESS: 'REACH',
};

/** EU member states plus the EEA states DSA transparency also covers. */
export const EU_DSA_COUNTRIES: ReadonlySet<string> = new Set([
  ...EU_COUNTRIES,
  'IS',
  'LI',
  'NO',
]);

export const BOOST_STEPS = ['campaign', 'adset', 'creative', 'ad'] as const;
export type BoostStep = (typeof BOOST_STEPS)[number];

/** Default start offset when the caller gives none: ten minutes from now. */
export const DEFAULT_START_OFFSET_MS = 10 * 60_000;

/** Rollback and reconcile requests ignore the call's abort signal and use this. */
export const ROLLBACK_TIMEOUT_MS = 15_000;

export const MAX_BOOST_NAME_LENGTH = 200;
export const MAX_DSA_LENGTH = 512;

const DAY_MS = 86_400_000;

export const BOOST_PAUSED_NOTE =
  'Every object is created PAUSED: nothing spends until the campaign is activated with facebook_update_ad_object status:"ACTIVE" (a separate spend-tier call).';

export const BOOST_ROLLBACK_NOTE =
  'If a step fails, the objects already created are deleted again; deleted objects stay visible in Ads Manager with status DELETED.';

export const BOOST_CREATIVE_NOTE =
  'The ad creative is never deleted by a rollback: it points at the post, is reusable and cannot spend on its own.';

export const BOOST_REVIEW_NOTE =
  'The ad goes through Meta ad review after activation; review can reject or limit it.';

export const BOOST_NO_RETRY_NOTE =
  'Never retry an apply whose outcome is unknown: every call creates another campaign. Look for the plan tag (fbmcp:<plan>) in facebook_list_campaigns first.';

export const CREATIVE_KEPT_NOTE = 'creative kept (shared/idempotent, does not spend)';

/**
 * The only special-ad-category attestation this server accepts (LEG-04). Meta
 * requires housing, employment, credit and social issues / elections /
 * politics ads to declare their category; this server never declares one, so
 * the operator must state that the ad is in none of them.
 */
export const NO_SPECIAL_AD_CATEGORY = 'none';
export type SpecialAdCategoryAttestation = typeof NO_SPECIAL_AD_CATEGORY;

/** The categories the attestation rules out, as the preview and refusals name them. */
export const SPECIAL_AD_CATEGORIES_TEXT =
  'housing, employment, credit, or social issues / elections / politics';

export const SPECIAL_AD_CATEGORY_REFUSAL =
  `Refused: this server does not support special-category ads (${SPECIAL_AD_CATEGORIES_TEXT}). ` +
  'Meta requires those to declare their category and to follow its restricted-targeting rules; create them in Ads Manager. ' +
  'If the ad is in none of those categories, pass special_ad_category:"none" to attest it. Nothing was created.';

export const SPECIAL_AD_CATEGORY_MISSING =
  'Required: special_ad_category. Pass special_ad_category:"none" only after the operator confirms the ad is NOT about ' +
  `${SPECIAL_AD_CATEGORIES_TEXT}; this server declares no special ad category to Meta and does not support those ads. Nothing was created.`;

/** The preview line that repeats the operator's attestation. */
export const SPECIAL_AD_CATEGORY_ATTESTATION_LINE = `Special ad category: none — the operator attests the ad is not about ${SPECIAL_AD_CATEGORIES_TEXT}; declared to Meta as special_ad_categories [].`;

/** The preview line naming the AI features the chain pins off. */
export const BOOST_AI_FEATURES_LINE =
  "Meta AI features: Advantage+ audience off (advantage_audience 0) and every creative enhancement OPT_OUT; none is left to Meta's default.";

/** What the planner needs from the post read. */
export interface BoostPost {
  /** `<page-id>_<post-id>`, Graph's `object_story_id`. */
  readonly id: string;
  readonly permalinkUrl?: string;
  readonly message?: string;
  /** `is_eligible_for_promotion`; undefined when Graph did not answer it. */
  readonly eligible?: boolean;
  /** True when an attachment carries a link (`unshimmed_url`). */
  readonly hasLink: boolean;
}

/** What the planner needs from the ad account read. */
export interface BoostAccount {
  readonly id: string;
  readonly currency?: string;
  readonly timezone?: string;
  readonly statusLabel: string;
  readonly minDailyBudgetMinor?: number;
  readonly minCampaignSpendCapMinor?: number;
}

export type BoostBudget =
  | { readonly kind: 'daily'; readonly amountMinor: number }
  | { readonly kind: 'lifetime'; readonly amountMinor: number };

export interface BoostDsa {
  readonly payor: string;
  readonly beneficiary: string;
}

export interface BoostPlanInput {
  readonly account: BoostAccount;
  readonly pageId: string;
  readonly post: BoostPost;
  readonly objective: BoostObjective;
  readonly name?: string;
  readonly budget: BoostBudget;
  readonly spendCapMinor: number;
  readonly bidStrategy: BoostBidStrategy;
  readonly bidAmountMinor?: number;
  /** ISO-8601 with offset; absent ⇒ {@link DEFAULT_START_OFFSET_MS} from now. */
  readonly startTime?: string;
  readonly endTime?: string;
  readonly countries: readonly string[];
  readonly ageMin: number;
  readonly ageMax: number;
  readonly dsa?: BoostDsa;
  /**
   * The operator's attestation that the ad is in no special ad category
   * (LEG-04). Typed as the literal, and re-checked at run time for callers
   * that bypass the tool schema.
   */
  readonly specialAdCategory: SpecialAdCategoryAttestation;
  /** True when the account carries both DSA defaults (best-effort read). */
  readonly accountHasDsaDefaults: boolean;
  readonly spendCapMaxMinor?: number;
  readonly budgetCeilingMinor?: number;
  readonly now: number;
}

/** One planned POST, as the preview prints it. */
export interface PlannedStep {
  readonly step: BoostStep;
  readonly method: 'POST';
  readonly path: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface BoostPlan {
  readonly accountId: string;
  readonly currency?: string;
  readonly pageId: string;
  readonly objectStoryId: string;
  readonly objective: BoostObjective;
  readonly optimizationGoal: string;
  readonly baseName: string;
  readonly startTime: string;
  readonly endTime?: string;
  readonly budget: BoostBudget;
  readonly spendCapMinor: number;
  readonly bidStrategy: BoostBidStrategy;
  readonly bidAmountMinor?: number;
  readonly countries: readonly string[];
  readonly ageMin: number;
  readonly ageMax: number;
  /** DSA fields set on the ad set; absent when the account defaults apply. */
  readonly dsa?: BoostDsa;
  /** The operator's special-ad-category attestation; always "none". */
  readonly specialAdCategory: SpecialAdCategoryAttestation;
  readonly euTargeted: boolean;
  readonly envelope: SpendEnvelope;
  readonly summary: string;
  readonly warnings: readonly string[];
}

function validationError(message: string): GraphApiError {
  return new GraphApiError(message, {
    code: 100,
    httpStatus: 400,
    action: classifyGraphError({ code: 100, message }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function idString(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return typeof value === 'string' && /^\d+$/.test(value.trim())
    ? value.trim()
    : undefined;
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

// ---------------------------------------------------------------------------
// 2. Reads behind the plan
// ---------------------------------------------------------------------------

export const BOOST_POST_FIELDS =
  'id,permalink_url,message,is_eligible_for_promotion,attachments{unshimmed_url,type}';

/**
 * The `object_story_id` for a post id given bare or as `<page>_<post>`. A
 * compound id that names another Page is refused: the boost would promote a
 * post the configured Page does not own.
 */
export function boostStoryId(pageId: string, postId: string): string {
  const trimmed = postId.trim();
  if (/^\d+$/.test(trimmed)) return `${pageId}_${trimmed}`;
  const match = /^(\d+)_(\d+)$/.exec(trimmed);
  if (match === null) {
    throw validationError(
      `\`post_id\` must be digits or "<page-id>_<post-id>"; got ${JSON.stringify(postId)}. Nothing was created.`,
    );
  }
  if (match[1] !== pageId) {
    throw validationError(
      `Refused: post ${trimmed} belongs to Page ${String(match[1])}, not ${pageId}. Nothing was created. Pass the post's own Page as page_id.`,
    );
  }
  return trimmed;
}

function attachmentHasLink(attachments: unknown): boolean {
  if (!isRecord(attachments) || !Array.isArray(attachments.data)) return false;
  return (attachments.data as unknown[]).some(
    (entry) => isRecord(entry) && hasText(entry.unshimmed_url),
  );
}

/** Parse the post read. Exported for tests. */
export function parseBoostPost(objectStoryId: string, body: unknown): BoostPost {
  const record = isRecord(body) ? body : {};
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (id !== '' && id !== objectStoryId) {
    throw validationError(
      `Refused: Graph answered post ${id} for ${objectStoryId}; the post is not on that Page. Nothing was created.`,
    );
  }
  const eligible = record.is_eligible_for_promotion;
  return {
    id: objectStoryId,
    ...(typeof record.permalink_url === 'string'
      ? { permalinkUrl: record.permalink_url }
      : {}),
    ...(typeof record.message === 'string' ? { message: record.message } : {}),
    ...(typeof eligible === 'boolean' ? { eligible } : {}),
    hasLink: attachmentHasLink(record.attachments),
  };
}

/**
 * Read the post with the Page's own token: the read doubles as the proof the
 * post is on that Page.
 */
export async function readBoostPost(
  fbRequest: FbRequestFn,
  opts: {
    readonly pageId: string;
    readonly token: string;
    readonly objectStoryId: string;
    readonly signal?: AbortSignal;
  },
): Promise<BoostPost> {
  const res = await fbRequest<unknown>({
    protocol: 'json',
    method: 'GET',
    host: 'graph',
    path: `/${opts.objectStoryId}`,
    params: { fields: BOOST_POST_FIELDS },
    token: opts.token,
    pageId: opts.pageId,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  return parseBoostPost(opts.objectStoryId, res.data);
}

/**
 * Whether the account carries both DSA defaults. Best effort: a refused read
 * counts as "no defaults", so an EU boost then needs the `dsa` argument.
 */
export async function readDsaDefaults(
  fbRequest: FbRequestFn,
  accountId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const res = await fbRequest<unknown>({
      protocol: 'json',
      method: 'GET',
      host: 'graph',
      api: MARKETING_API,
      path: `/${accountId}`,
      params: { fields: 'default_dsa_payor,default_dsa_beneficiary' },
      ...(signal !== undefined ? { signal } : {}),
    });
    const record = isRecord(res.data) ? res.data : {};
    return hasText(record.default_dsa_payor) && hasText(record.default_dsa_beneficiary);
  } catch (err) {
    if (signal?.aborted === true) throw err;
    return false;
  }
}

// ---------------------------------------------------------------------------
// 3. The plan (pure)
// ---------------------------------------------------------------------------

function parseTime(field: string, value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw validationError(`\`${field}\` is not a valid time: ${JSON.stringify(value)}.`);
  }
  return ms;
}

function excerpt(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  const flat = message.replace(/\s+/g, ' ').trim();
  if (flat === '') return undefined;
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

/**
 * Build the boost plan. Pure: every refusal is thrown here, before anything is
 * created.
 *
 * @throws GraphApiError (validation) for every refusal of v2 ads §1.6.
 */
export function planBoost(input: BoostPlanInput): BoostPlan {
  const { account, post } = input;
  const currency = account.currency;
  const accountId = account.id;

  // LEG-04: the operator, not this server, states that the ad is in no
  // special ad category. Anything but the explicit "none" is refused.
  const attestation: unknown = input.specialAdCategory;
  if (attestation === undefined || attestation === null || attestation === '') {
    throw validationError(SPECIAL_AD_CATEGORY_MISSING);
  }
  if (attestation !== NO_SPECIAL_AD_CATEGORY) {
    throw validationError(SPECIAL_AD_CATEGORY_REFUSAL);
  }

  // Spend cap: mandatory, never the removal sentinel, within the configured
  // maximum and at or above Meta's minimum.
  const spendCap = validateSpendCapMinor('spend_cap_minor', input.spendCapMinor);
  enforceSpendCapMax({
    field: 'spend_cap_minor',
    requested: spendCap,
    current: undefined,
    max: input.spendCapMaxMinor,
    currency,
    objectId: accountId,
  });
  if (
    account.minCampaignSpendCapMinor !== undefined &&
    spendCap < account.minCampaignSpendCapMinor
  ) {
    throw validationError(
      `Refused: \`spend_cap_minor\` of ${formatMinor(spendCap, currency)} is below Meta's minimum campaign spend cap for this account (${formatMinor(account.minCampaignSpendCapMinor, currency)}). Nothing was created.`,
    );
  }

  // Budget: within the ceiling and, for a daily budget, at or above Meta's floor.
  const budgetField =
    input.budget.kind === 'daily' ? 'daily_budget_minor' : 'lifetime_budget_minor';
  const budgetAmount = validateBudgetMinor(budgetField, input.budget.amountMinor);
  if (input.budgetCeilingMinor !== undefined) {
    enforceCeiling({
      field: budgetField,
      requested: budgetAmount,
      current: undefined,
      ceiling: input.budgetCeilingMinor,
      currency,
      objectId: accountId,
    });
  }
  if (
    input.budget.kind === 'daily' &&
    account.minDailyBudgetMinor !== undefined &&
    budgetAmount < account.minDailyBudgetMinor
  ) {
    throw validationError(
      `Refused: \`daily_budget_minor\` of ${formatMinor(budgetAmount, currency)} is below Meta's minimum daily budget for this account (${formatMinor(account.minDailyBudgetMinor, currency)}). Nothing was created.`,
    );
  }

  // Bid: an amount exactly when the strategy caps the bid.
  const needsBid = input.bidStrategy !== 'LOWEST_COST_WITHOUT_CAP';
  if (needsBid && input.bidAmountMinor === undefined) {
    throw validationError(
      `\`bid_amount_minor\` is required with bid_strategy ${input.bidStrategy}. Nothing was created.`,
    );
  }
  if (!needsBid && input.bidAmountMinor !== undefined) {
    throw validationError(
      '`bid_amount_minor` only applies to LOWEST_COST_WITH_BID_CAP and COST_CAP; drop it or change bid_strategy. Nothing was created.',
    );
  }
  const bidAmount =
    input.bidAmountMinor !== undefined
      ? validateBudgetMinor('bid_amount_minor', input.bidAmountMinor)
      : undefined;

  // Schedule.
  const startMs =
    input.startTime !== undefined
      ? parseTime('start_time', input.startTime)
      : input.now + DEFAULT_START_OFFSET_MS;
  const endMs =
    input.endTime !== undefined ? parseTime('end_time', input.endTime) : undefined;
  if (input.budget.kind === 'lifetime' && endMs === undefined) {
    throw validationError(
      'A lifetime budget needs `end_time`: Meta paces it over a fixed run. Nothing was created.',
    );
  }
  if (endMs !== undefined && endMs <= startMs) {
    throw validationError('`end_time` must be after `start_time`. Nothing was created.');
  }
  if (input.budget.kind === 'daily' && endMs !== undefined && endMs - startMs <= DAY_MS) {
    throw validationError(
      'With a daily budget, `end_time` must be more than 24 hours after `start_time`. Nothing was created.',
    );
  }
  const startTime = new Date(startMs).toISOString();
  const endTime = endMs !== undefined ? new Date(endMs).toISOString() : undefined;

  // Targeting.
  if (input.ageMin > input.ageMax) {
    throw validationError('`age_min` must not be above `age_max`. Nothing was created.');
  }
  const countries = [...new Set(input.countries.map((c) => c.trim().toUpperCase()))];
  const euCountries = countries.filter((c) => EU_DSA_COUNTRIES.has(c));
  const euTargeted = euCountries.length > 0;
  if (euTargeted && input.dsa === undefined && !input.accountHasDsaDefaults) {
    throw validationError(
      `Refused: the targeting includes EU/EEA countries (${euCountries.join(', ')}), and EU ads need DSA payor and beneficiary info. Pass \`dsa\` {payor, beneficiary} or set the ad account defaults in Ads Manager. Nothing was created.`,
    );
  }

  // Post.
  if (post.eligible === false) {
    throw validationError(
      `Refused: Meta reports post ${post.id} as not eligible for promotion (is_eligible_for_promotion:false). Nothing was created.`,
    );
  }
  if (input.objective === 'OUTCOME_TRAFFIC' && !post.hasLink) {
    throw validationError(
      `Refused: OUTCOME_TRAFFIC optimises for link clicks, and post ${post.id} carries no link. Use OUTCOME_ENGAGEMENT or OUTCOME_AWARENESS. Nothing was created.`,
    );
  }

  const envelope = worstCaseEnvelope({
    ...(input.budget.kind === 'daily'
      ? { dailyBudgetMinor: budgetAmount }
      : { lifetimeBudgetMinor: budgetAmount }),
    startTime: startMs,
    ...(endMs !== undefined ? { endTime: endMs } : {}),
    spendCapMinor: spendCap,
  });

  const baseName = (input.name ?? `Boost ${post.id}`)
    .trim()
    .slice(0, MAX_BOOST_NAME_LENGTH);

  const warnings: string[] = [
    BOOST_PAUSED_NOTE,
    BOOST_ROLLBACK_NOTE,
    BOOST_CREATIVE_NOTE,
    BOOST_REVIEW_NOTE,
    BOOST_NO_RETRY_NOTE,
  ];
  if (post.eligible === undefined) {
    warnings.push(
      'Meta did not say whether the post is eligible for promotion; the ad creative step may be refused.',
    );
  }
  if (input.budget.kind === 'lifetime' && budgetAmount > spendCap) {
    warnings.push(
      `The lifetime budget (${formatMinor(budgetAmount, currency)}) is above the spend cap (${formatMinor(spendCap, currency)}): delivery stops at the cap.`,
    );
  }
  if (bidAmount !== undefined) {
    warnings.push(
      `bid_amount_minor ${formatMinor(bidAmount, currency)} is per 1000 impressions.`,
    );
  }

  const budgetLine =
    input.budget.kind === 'daily'
      ? `daily budget ${formatMinor(budgetAmount, currency)}`
      : `lifetime budget ${formatMinor(budgetAmount, currency)}`;
  const summary = [
    `Boost post ${post.id}${excerpt(post.message) !== undefined ? ` ("${String(excerpt(post.message))}")` : ''} on ad account ${accountId} as ${input.objective}: a PAUSED campaign, ad set, creative and ad.`,
    `Campaign spend cap ${formatMinor(spendCap, currency)}; ${budgetLine}; bid strategy ${input.bidStrategy}${bidAmount !== undefined ? ` at ${formatMinor(bidAmount, currency)} per 1000 impressions` : ''}.`,
    `Schedule: from ${startTime}${endTime !== undefined ? ` to ${endTime}` : ', no end'}${account.timezone !== undefined ? ` (account time zone ${account.timezone})` : ''}.`,
    `Audience: ${countries.join(', ')}, ages ${String(input.ageMin)}–${String(input.ageMax)}, Advantage+ audience off.`,
    SPECIAL_AD_CATEGORY_ATTESTATION_LINE,
    BOOST_AI_FEATURES_LINE,
    ...describeEnvelope(envelope, currency),
  ].join('\n');

  return {
    accountId,
    ...(currency !== undefined ? { currency } : {}),
    pageId: input.pageId,
    objectStoryId: post.id,
    objective: input.objective,
    optimizationGoal: OPTIMIZATION_GOALS[input.objective],
    baseName,
    startTime,
    ...(endTime !== undefined ? { endTime } : {}),
    budget: { kind: input.budget.kind, amountMinor: budgetAmount },
    spendCapMinor: spendCap,
    bidStrategy: input.bidStrategy,
    ...(bidAmount !== undefined ? { bidAmountMinor: bidAmount } : {}),
    countries,
    ageMin: input.ageMin,
    ageMax: input.ageMax,
    ...(euTargeted && input.dsa !== undefined ? { dsa: input.dsa } : {}),
    specialAdCategory: NO_SPECIAL_AD_CATEGORY,
    euTargeted,
    envelope,
    summary,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 4. The step requests
// ---------------------------------------------------------------------------

/** The plan tag in every object name: `fbmcp:` plus the first 8 plan-id chars. */
export function boostPlanTag(planId: string): string {
  return `fbmcp:${planId.replace(/-/g, '').slice(0, 8)}`;
}

function taggedName(plan: BoostPlan, step: BoostStep, tag: string): string {
  const suffix = step === 'campaign' ? '' : ` ${step}`;
  return `${plan.baseName}${suffix} [${tag}]`;
}

/** Ids created by earlier steps, as later steps reference them. */
export interface BoostIds {
  readonly campaign?: string;
  readonly adset?: string;
  readonly creative?: string;
  readonly ad?: string;
}

const STEP_EDGE: Readonly<Record<BoostStep, string>> = {
  campaign: 'campaigns',
  adset: 'adsets',
  creative: 'adcreatives',
  ad: 'ads',
};

/** The body of one step's POST. `ids` placeholders appear in the preview. */
export function boostStepBody(
  plan: BoostPlan,
  step: BoostStep,
  tag: string,
  ids: BoostIds,
): Record<string, unknown> {
  const name = taggedName(plan, step, tag);
  switch (step) {
    case 'campaign':
      return {
        name,
        objective: plan.objective,
        status: 'PAUSED',
        // The operator attested "none" (LEG-04); planBoost refuses anything else.
        special_ad_categories: [],
        buying_type: 'AUCTION',
        bid_strategy: plan.bidStrategy,
        spend_cap: plan.spendCapMinor,
        is_adset_budget_sharing_enabled: false,
      };
    case 'adset':
      return {
        name,
        campaign_id: ids.campaign ?? '<campaign_id>',
        status: 'PAUSED',
        ...(plan.budget.kind === 'daily'
          ? { daily_budget: plan.budget.amountMinor }
          : { lifetime_budget: plan.budget.amountMinor }),
        ...(plan.bidAmountMinor !== undefined ? { bid_amount: plan.bidAmountMinor } : {}),
        billing_event: 'IMPRESSIONS',
        optimization_goal: plan.optimizationGoal,
        ...(plan.objective === 'OUTCOME_ENGAGEMENT'
          ? { destination_type: 'ON_POST' }
          : {}),
        promoted_object: { page_id: plan.pageId },
        start_time: plan.startTime,
        ...(plan.endTime !== undefined ? { end_time: plan.endTime } : {}),
        targeting: {
          geo_locations: { countries: plan.countries },
          age_min: plan.ageMin,
          age_max: plan.ageMax,
          targeting_automation: { advantage_audience: 0 },
        },
        ...(plan.dsa !== undefined
          ? { dsa_payor: plan.dsa.payor, dsa_beneficiary: plan.dsa.beneficiary }
          : {}),
      };
    case 'creative':
      return {
        name,
        object_story_id: plan.objectStoryId,
        degrees_of_freedom_spec: {
          creative_features_spec: {
            image_template: { enroll_status: 'OPT_OUT' },
            image_touchups: { enroll_status: 'OPT_OUT' },
            text_optimizations: { enroll_status: 'OPT_OUT' },
            inline_comment: { enroll_status: 'OPT_OUT' },
            video_auto_crop: { enroll_status: 'OPT_OUT' },
          },
        },
      };
    case 'ad':
      return {
        name,
        adset_id: ids.adset ?? '<adset_id>',
        creative: { creative_id: ids.creative ?? '<creative_id>' },
        status: 'PAUSED',
      };
  }
}

export function boostStepRequest(
  plan: BoostPlan,
  step: BoostStep,
  tag: string,
  ids: BoostIds,
  signal?: AbortSignal,
): JsonRequest {
  return {
    protocol: 'json',
    method: 'POST',
    host: 'graph',
    api: MARKETING_API,
    path: `/${plan.accountId}/${STEP_EDGE[step]}`,
    body: boostStepBody(plan, step, tag, ids),
    verifyTool: 'facebook_list_campaigns',
    ...(signal !== undefined ? { signal } : {}),
  };
}

/** The four POSTs as the preview prints them, with placeholder ids and tag. */
export function plannedSteps(plan: BoostPlan): readonly PlannedStep[] {
  return BOOST_STEPS.map((step) => ({
    step,
    method: 'POST' as const,
    path: `/${plan.accountId}/${STEP_EDGE[step]}`,
    params: boostStepBody(plan, step, 'fbmcp:<plan>', {}),
  }));
}

// ---------------------------------------------------------------------------
// 5. The chain
// ---------------------------------------------------------------------------

/** One journal-worthy event of the chain. */
export interface BoostStepEvent {
  /** A {@link BoostStep}, or `rollback:<step>`. */
  readonly step: string;
  readonly seq: number;
  readonly outcome: 'attempted' | 'applied' | 'failed';
  readonly objectId?: string;
  readonly code?: number;
  readonly subcode?: number;
  readonly reconciled?: boolean;
}

export interface BoostStepRef {
  readonly step: BoostStep;
  readonly id: string;
  readonly note?: string;
}

export interface BoostOrphan {
  readonly step: BoostStep;
  readonly id?: string;
  readonly reason: string;
}

export interface BoostFailure {
  readonly step: BoostStep;
  readonly error: {
    readonly code?: number;
    readonly subcode?: number;
    readonly message: string;
    readonly user_message?: string;
  };
}

export type BoostOutcomeKind = 'applied' | 'rolled_back' | 'partial';

export interface BoostOutcome {
  readonly outcome: BoostOutcomeKind;
  readonly planTag: string;
  readonly campaign_id?: string;
  readonly adset_id?: string;
  readonly creative_id?: string;
  readonly ad_id?: string;
  readonly applied: readonly BoostStepRef[];
  readonly rolled_back: readonly BoostStepRef[];
  readonly orphaned: readonly BoostOrphan[];
  readonly failed_step?: BoostFailure;
  readonly next_steps: readonly string[];
  readonly ads_manager_url: string;
  readonly currency?: string;
  readonly spend_cap_minor: number;
}

/**
 * How a failed step POST is treated. `rejected`: Graph answered and refused,
 * or the request provably never left — nothing was created. `ambiguous`: the
 * answer was lost after the request went out — the object may exist.
 */
export function stepFailureClass(err: unknown): 'rejected' | 'ambiguous' {
  if (!(err instanceof GraphApiError)) return 'ambiguous';
  if (err.action?.category === 'ambiguous') return 'ambiguous';
  if (err.httpStatus === 0 && isProvablyNotSent(err.cause)) return 'rejected';
  return err.httpStatus === 0 || err.httpStatus >= 500 ? 'ambiguous' : 'rejected';
}

function failureOf(step: BoostStep, err: unknown): BoostFailure {
  if (err instanceof GraphApiError) {
    return {
      step,
      error: {
        code: err.code,
        ...(err.subcode !== undefined ? { subcode: err.subcode } : {}),
        message: err.message,
        ...(err.userMessage !== undefined ? { user_message: err.userMessage } : {}),
      },
    };
  }
  return { step, error: { message: err instanceof Error ? err.message : String(err) } };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Find the object a lost answer may have created, by the plan tag in its name.
 * Returns the ids found; throws when the read itself fails.
 */
export async function reconcileByTag(
  fbRequest: FbRequestFn,
  plan: BoostPlan,
  step: BoostStep,
  tag: string,
): Promise<readonly string[]> {
  const isCreative = step === 'creative';
  const res = await fbRequest<unknown>({
    protocol: 'json',
    method: 'GET',
    host: 'graph',
    api: MARKETING_API,
    path: `/${plan.accountId}/${STEP_EDGE[step]}`,
    params: isCreative
      ? { fields: 'id,name,object_story_id', limit: 100 }
      : {
          fields: 'id,name',
          filtering: JSON.stringify([{ field: 'name', operator: 'CONTAIN', value: tag }]),
        },
    timeoutMs: ROLLBACK_TIMEOUT_MS,
  });
  const body = isRecord(res.data) ? res.data : {};
  const rows = Array.isArray(body.data) ? (body.data as unknown[]) : [];
  const ids: string[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const name = typeof row.name === 'string' ? row.name : '';
    if (!name.includes(tag)) continue;
    if (isCreative && row.object_story_id !== plan.objectStoryId) continue;
    const id = idString(row.id);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

function adsManagerUrl(accountId: string, campaignId: string | undefined): string {
  const act = accountId.replace(/^act_/, '');
  return `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${act}${
    campaignId !== undefined ? `&selected_campaign_ids=${campaignId}` : ''
  }`;
}

const LEVEL_OF: Readonly<
  Record<Exclude<BoostStep, 'creative'>, 'campaign' | 'adset' | 'ad'>
> = { campaign: 'campaign', adset: 'adset', ad: 'ad' };

export interface BoostChainOptions {
  readonly planTag: string;
  readonly signal?: AbortSignal;
  /** Called for every step and rollback event; must not throw. */
  readonly onEvent?: (event: BoostStepEvent) => Promise<unknown>;
}

/**
 * Run the four POSTs in order, with no retries. On a failure, reconcile a lost
 * answer by the plan tag, then delete what was created in reverse order (the
 * creative is kept). Never throws for a Graph failure: the outcome says what
 * happened; only a fault before the first POST escapes.
 */
export async function runBoostChain(
  fbRequest: FbRequestFn,
  plan: BoostPlan,
  options: BoostChainOptions,
): Promise<BoostOutcome> {
  const tag = options.planTag;
  const signal = options.signal;
  const emit = async (event: BoostStepEvent): Promise<void> => {
    if (options.onEvent !== undefined) await options.onEvent(event);
  };
  let seq = 0;
  const ids: { -readonly [K in keyof BoostIds]: BoostIds[K] } = {};
  const created: BoostStepRef[] = [];
  const orphaned: BoostOrphan[] = [];
  let failure: BoostFailure | undefined;

  for (const step of BOOST_STEPS) {
    seq += 1;
    if (signal?.aborted === true) {
      failure = failureOf(
        step,
        new Error('The call was cancelled before this step was sent.'),
      );
      await emit({ step, seq, outcome: 'failed' });
      break;
    }
    await emit({ step, seq, outcome: 'attempted' });
    let id: string | undefined;
    let error: unknown;
    try {
      const res = await fbRequest<unknown>(
        boostStepRequest(plan, step, tag, ids, signal),
      );
      id = isRecord(res.data) ? idString(res.data.id) : undefined;
      if (id === undefined) {
        error = new Error(`Graph answered the ${step} POST without an id.`);
      }
    } catch (err) {
      error = err;
    }
    if (id !== undefined) {
      ids[step] = id;
      created.push({ step, id });
      await emit({ step, seq, outcome: 'applied', objectId: id });
      continue;
    }

    failure = failureOf(step, error);
    if (stepFailureClass(error) === 'rejected') {
      await emit({
        step,
        seq,
        outcome: 'failed',
        ...(error instanceof GraphApiError ? { code: error.code } : {}),
        ...(error instanceof GraphApiError && error.subcode !== undefined
          ? { subcode: error.subcode }
          : {}),
      });
      break;
    }
    // Ambiguous: the object may exist. Look for it by the plan tag.
    try {
      const found = await reconcileByTag(fbRequest, plan, step, tag);
      if (found.length === 1) {
        const foundId = String(found[0]);
        ids[step] = foundId;
        created.push({ step, id: foundId });
        await emit({
          step,
          seq,
          outcome: 'attempted',
          reconciled: true,
          objectId: foundId,
        });
      } else if (found.length === 0) {
        await emit({ step, seq, outcome: 'attempted', reconciled: true });
      } else {
        for (const extra of found) {
          orphaned.push({
            step,
            id: extra,
            reason: `several objects carry ${tag}; check Ads Manager for names containing ${tag}`,
          });
        }
        await emit({ step, seq, outcome: 'attempted', reconciled: false });
      }
    } catch {
      orphaned.push({
        step,
        reason: `unknown — check Ads Manager for names containing ${tag}`,
      });
      await emit({ step, seq, outcome: 'attempted', reconciled: false });
    }
    break;
  }

  if (failure === undefined) {
    return {
      outcome: 'applied',
      planTag: tag,
      ...(ids.campaign !== undefined ? { campaign_id: ids.campaign } : {}),
      ...(ids.adset !== undefined ? { adset_id: ids.adset } : {}),
      ...(ids.creative !== undefined ? { creative_id: ids.creative } : {}),
      ...(ids.ad !== undefined ? { ad_id: ids.ad } : {}),
      applied: created,
      rolled_back: [],
      orphaned: [],
      next_steps: [
        `Review the PAUSED objects in Ads Manager, then activate the campaign with facebook_update_ad_object object_id:"${String(ids.campaign)}" level:"campaign" status:"ACTIVE" (a spend-tier call).`,
      ],
      ads_manager_url: adsManagerUrl(plan.accountId, ids.campaign),
      ...(plan.currency !== undefined ? { currency: plan.currency } : {}),
      spend_cap_minor: plan.spendCapMinor,
    };
  }

  // Roll back in reverse. The creative is kept; the call's abort signal is
  // ignored so a cancellation cannot leave half a chain behind.
  const rolledBack: BoostStepRef[] = [];
  const kept: BoostStepRef[] = [];
  for (const ref of [...created].reverse()) {
    if (ref.step === 'creative') {
      kept.push({ ...ref, note: CREATIVE_KEPT_NOTE });
      continue;
    }
    seq += 1;
    const label = `rollback:${ref.step}`;
    try {
      await fbRequest<unknown>({
        ...deleteAdObjectRequest(ref.id, LEVEL_OF[ref.step]),
        timeoutMs: ROLLBACK_TIMEOUT_MS,
      });
      rolledBack.push(ref);
      await emit({ step: label, seq, outcome: 'applied', objectId: ref.id });
    } catch (err) {
      orphaned.push({
        step: ref.step,
        id: ref.id,
        reason: `delete failed: ${errorMessage(err)}; it is PAUSED and will not spend`,
      });
      await emit({
        step: label,
        seq,
        outcome: 'failed',
        objectId: ref.id,
        ...(err instanceof GraphApiError ? { code: err.code } : {}),
      });
    }
  }

  const outcome: BoostOutcomeKind = orphaned.length > 0 ? 'partial' : 'rolled_back';
  const nextSteps =
    outcome === 'rolled_back'
      ? [
          `Fix the cause of the ${failure.step} failure, then preview the boost again (a new plan).`,
        ]
      : [
          `Open Ads Manager and look for names containing ${tag}; delete what is left with facebook_delete_ad_object. Everything left is PAUSED and spends nothing.`,
        ];
  return {
    outcome,
    planTag: tag,
    ...(kept.length > 0 ? { creative_id: kept[0]?.id } : {}),
    applied: kept,
    rolled_back: rolledBack,
    orphaned,
    failed_step: failure,
    next_steps: nextSteps,
    ads_manager_url: adsManagerUrl(plan.accountId, undefined),
    ...(plan.currency !== undefined ? { currency: plan.currency } : {}),
    spend_cap_minor: plan.spendCapMinor,
  };
}

/** One-paragraph report of a chain outcome (v2 ads §1.9). */
export function boostReport(outcome: BoostOutcome): string {
  if (outcome.outcome === 'applied') {
    return `Created a PAUSED campaign ${String(outcome.campaign_id)}, ad set ${String(outcome.adset_id)}, creative ${String(outcome.creative_id)} and ad ${String(outcome.ad_id)} (${outcome.planTag}). Nothing spends until the campaign is activated.`;
  }
  const failed = outcome.failed_step;
  const head = `The ${String(failed?.step)} step failed${failed !== undefined ? `: ${failed.error.message}` : ''}.`;
  if (outcome.outcome === 'rolled_back') {
    return `${head} Everything created before it was deleted again${outcome.applied.length > 0 ? ' (the creative is kept; it cannot spend)' : ''}. No ad can spend.`;
  }
  return `${head} Some objects could not be cleaned up (${String(outcome.orphaned.length)} left, see orphaned). They are PAUSED and spend nothing; look for ${outcome.planTag} in Ads Manager.`;
}
