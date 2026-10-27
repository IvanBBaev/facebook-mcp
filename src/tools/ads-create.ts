// `facebook_boost_post` (v2 ads §1, owner decision D3 = B): boost one Page
// post as a PAUSED campaign → ad set → creative → ad chain. The planning,
// refusals and the chain with its rollback live in `../api/ads-create.js`;
// this module resolves the Page, reads the account and the post, and runs the
// chain through the write gate as an irreversible, plan-bound write.

import { z } from 'zod';
import { GraphApiError, classifyGraphError } from '../core/index.js';
import type { ToolAnnotations } from '../core/index.js';
import { ADS_RATE_LIMIT_NOTE } from '../api/ads-read.js';
import type { AdWriteIntent } from '../api/ads-read.js';
import {
  MAX_TARGETING_AGE,
  MAX_TARGETING_COUNTRIES,
  MIN_TARGETING_AGE,
} from '../api/ads-targeting.js';
import {
  BOOST_BID_STRATEGIES,
  BOOST_OBJECTIVES,
  MAX_BOOST_NAME_LENGTH,
  MAX_DSA_LENGTH,
  boostPlanTag,
  boostReport,
  boostStoryId,
  plannedSteps,
  planBoost,
  readBoostPost,
  readDsaDefaults,
  runBoostChain,
} from '../api/ads-create.js';
import type {
  BoostOutcome,
  BoostPlan,
  BoostPost,
  BoostStepEvent,
} from '../api/ads-create.js';
import {
  APPLIED_VERDICT,
  ATTEMPTED_VERDICT,
  REFUSED_VERDICT,
  defineTool,
  type WriteResultVerdict,
} from '../mcp/index.js';
import {
  applyArg,
  confirmTokenArg,
  executeWrite,
  gateArgs,
  planIdArg,
} from './shared.js';
import {
  accountForWrite,
  adAccountIdArg,
  classifyUpdateFailure,
  signalOf,
} from './ads-shared.js';

const TOOL = 'facebook_boost_post';

/**
 * Every call creates new objects and overwrites nothing, so it is neither
 * destructive nor idempotent: a repeat creates another campaign.
 */
const BOOST_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

function validationError(message: string): GraphApiError {
  return new GraphApiError(message, {
    code: 100,
    httpStatus: 400,
    action: classifyGraphError({ code: 100, message }),
  });
}

const minorArg = (what: string) =>
  z
    .number()
    .int()
    .positive()
    .describe(`${what}, in minor units of the ad account currency (USD 1000 = 10.00).`);

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

const timeArg = (what: string) =>
  z
    .string()
    .trim()
    .regex(ISO_TIME, 'Use ISO-8601 with an offset, e.g. "2026-11-01T09:00:00+02:00".')
    .optional()
    .describe(what);

function verdictOf(outcome: BoostOutcome): WriteResultVerdict {
  if (outcome.outcome === 'applied') return APPLIED_VERDICT;
  return outcome.outcome === 'rolled_back' ? REFUSED_VERDICT : ATTEMPTED_VERDICT;
}

/** The subset of the reads the gate compares for divergence. */
function boostState(
  post: BoostPost,
  currency: string | undefined,
): Record<string, unknown> {
  return {
    post_id: post.id,
    eligible: post.eligible ?? null,
    has_link: post.hasLink,
    currency: currency ?? null,
  };
}

/** The four POSTs as preview lines; ids and the plan tag are filled at apply. */
function stepLines(plan: BoostPlan): readonly string[] {
  return plannedSteps(plan).map(
    (step, i) =>
      `Step ${String(i + 1)}: ${step.method} ${step.path} (${step.step}${'status' in step.params ? `, ${String(step.params.status)}` : ''}).`,
  );
}

export const boostPostTool = defineTool({
  name: TOOL,
  title: 'Boost Page Post',
  description:
    'Boost one existing Page post: create a campaign, ad set, ad creative and ad that promote it. ' +
    'Everything is created PAUSED; nothing spends until the campaign is activated with a separate ' +
    'facebook_update_ad_object call. Requires a campaign spend cap (spend_cap_minor) within ' +
    'FB_ADS_CAMPAIGN_SPEND_CAP_MAX and a budget within FB_ADS_BUDGET_CEILING; never declares a ' +
    'special ad category (housing, employment, credit, politics are out of scope). Audience is ' +
    'countries plus an age range only. EU/EEA targeting needs DSA payor/beneficiary info. ' +
    'Plan-first: without apply:true this returns the four planned requests, the worst-case spend ' +
    'once activated, and creates NOTHING (facebook_get_ad_preview renders the ad); applying requires apply:true plus ' +
    'the plan_id. If a step fails, the objects already created are deleted again. Never retry an ' +
    'apply whose outcome is unknown — every call creates another campaign.',
  inputSchema: z.object({
    page_id: z
      .string()
      .trim()
      .min(1)
      .describe('The Page that owns the post: a profile key or a raw Page ID.'),
    post_id: z
      .string()
      .trim()
      .min(1)
      .describe('The post to boost: its id, bare or as "<page-id>_<post-id>".'),
    objective: z
      .enum(BOOST_OBJECTIVES)
      .default('OUTCOME_ENGAGEMENT')
      .describe(
        'OUTCOME_ENGAGEMENT (post engagement, default), OUTCOME_TRAFFIC (link clicks; the post must carry a link) or OUTCOME_AWARENESS (reach).',
      ),
    name: z
      .string()
      .trim()
      .min(1)
      .max(MAX_BOOST_NAME_LENGTH)
      .optional()
      .describe(
        'Base name for the four objects. Default "Boost <post id>". A plan tag is appended.',
      ),
    daily_budget_minor: minorArg('Ad set daily budget').optional(),
    lifetime_budget_minor: minorArg('Ad set lifetime budget (needs end_time)').optional(),
    spend_cap_minor: minorArg(
      'Campaign spend cap — REQUIRED; the hard limit on what the campaign can ever spend',
    ),
    bid_strategy: z
      .enum(BOOST_BID_STRATEGIES)
      .default('LOWEST_COST_WITHOUT_CAP')
      .describe(
        'Campaign bid strategy. Default LOWEST_COST_WITHOUT_CAP (no bid amount).',
      ),
    bid_amount_minor: minorArg(
      'Bid cap / cost cap per 1000 impressions; required with LOWEST_COST_WITH_BID_CAP or COST_CAP',
    ).optional(),
    start_time: timeArg(
      'When delivery may start once activated. Default: ten minutes from now.',
    ),
    end_time: timeArg('When delivery ends. Required with a lifetime budget.'),
    countries: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[A-Za-z]{2}$/, 'Two-letter ISO country code.'),
      )
      .min(1)
      .max(MAX_TARGETING_COUNTRIES)
      .describe('Countries to target, as two-letter ISO codes (e.g. ["BG", "RO"]).'),
    age_min: z
      .number()
      .int()
      .min(MIN_TARGETING_AGE)
      .max(MAX_TARGETING_AGE)
      .default(MIN_TARGETING_AGE)
      .describe(
        `Minimum age, ${String(MIN_TARGETING_AGE)}–${String(MAX_TARGETING_AGE)}.`,
      ),
    age_max: z
      .number()
      .int()
      .min(MIN_TARGETING_AGE)
      .max(MAX_TARGETING_AGE)
      .default(MAX_TARGETING_AGE)
      .describe(
        `Maximum age, ${String(MIN_TARGETING_AGE)}–${String(MAX_TARGETING_AGE)}.`,
      ),
    dsa: z
      .object({
        payor: z.string().trim().min(1).max(MAX_DSA_LENGTH),
        beneficiary: z.string().trim().min(1).max(MAX_DSA_LENGTH),
      })
      .optional()
      .describe(
        'EU Digital Services Act info: who pays for the ad and who benefits. Needed for EU/EEA targeting unless the ad account has defaults.',
      ),
    ad_account_id: adAccountIdArg,
    apply: applyArg,
    plan_id: planIdArg,
    confirm_token: confirmTokenArg,
  }),
  annotations: BOOST_ANNOTATIONS,
  writeTier: 'irreversible',
  logFields: ['page_id', 'post_id', 'objective', 'apply', 'plan_id'],
  handler: async (input, ctx) => {
    // The chain creates objects that can spend once activated: an account in
    // payment trouble is refused before anything is read further (CC-ADS-6).
    if (
      (input.daily_budget_minor === undefined) ===
      (input.lifetime_budget_minor === undefined)
    ) {
      throw validationError(
        'Pass exactly one of daily_budget_minor and lifetime_budget_minor. Nothing was created.',
      );
    }
    const intent: AdWriteIntent = { stopsDelivery: false };
    const account = await accountForWrite(ctx, input.ad_account_id, intent);
    if (account === undefined) {
      throw validationError(
        'facebook_boost_post needs an ad account: pass ad_account_id or set FB_AD_ACCOUNT_ID. Nothing was created.',
      );
    }
    const resolved = await ctx.pages.resolvePage(input.page_id);
    const objectStoryId = boostStoryId(resolved.pageId, input.post_id);
    const readPost = () =>
      readBoostPost(ctx.fbRequest, {
        pageId: resolved.pageId,
        token: resolved.token,
        objectStoryId,
        ...signalOf(ctx),
      });
    const post = await readPost();
    const accountHasDsaDefaults = await readDsaDefaults(
      ctx.fbRequest,
      account.id,
      ctx.signal,
    );

    // Pure: every refusal happens before anything is created.
    const plan = planBoost({
      account,
      pageId: resolved.pageId,
      post,
      objective: input.objective,
      ...(input.name !== undefined ? { name: input.name } : {}),
      budget:
        input.daily_budget_minor !== undefined
          ? { kind: 'daily', amountMinor: input.daily_budget_minor }
          : { kind: 'lifetime', amountMinor: input.lifetime_budget_minor ?? 0 },
      spendCapMinor: input.spend_cap_minor,
      bidStrategy: input.bid_strategy,
      ...(input.bid_amount_minor !== undefined
        ? { bidAmountMinor: input.bid_amount_minor }
        : {}),
      ...(input.start_time !== undefined ? { startTime: input.start_time } : {}),
      ...(input.end_time !== undefined ? { endTime: input.end_time } : {}),
      countries: input.countries,
      ageMin: input.age_min,
      ageMax: input.age_max,
      ...(input.dsa !== undefined ? { dsa: input.dsa } : {}),
      accountHasDsaDefaults,
      ...(ctx.settings.adsCampaignSpendCapMax !== undefined
        ? { spendCapMaxMinor: ctx.settings.adsCampaignSpendCapMax }
        : {}),
      ...(ctx.settings.adsBudgetCeiling !== undefined
        ? { budgetCeilingMinor: ctx.settings.adsBudgetCeiling }
        : {}),
      now: ctx.clock.now(),
    });

    let pending: BoostPost | undefined = post;
    const readState = async (): Promise<unknown> => {
      if (pending !== undefined) {
        const snapshot = pending;
        pending = undefined;
        return boostState(snapshot, account.currency);
      }
      return boostState(await readPost(), account.currency);
    };

    let cancelledBeforeSend = false;

    return executeWrite(ctx, {
      tool: TOOL,
      tier: 'irreversible',
      pageId: resolved.pageId,
      resolvedPage: resolved,
      // The params bind the apply to the caller's own choices. Values derived at
      // call time (the default start time) stay out: they
      // differ between the dry run and the apply and would refuse every apply.
      params: {
        ad_account_id: account.id,
        post_id: objectStoryId,
        objective: plan.objective,
        ...(input.name !== undefined ? { name: input.name } : {}),
        spend_cap_minor: plan.spendCapMinor,
        ...(plan.budget.kind === 'daily'
          ? { daily_budget_minor: plan.budget.amountMinor }
          : { lifetime_budget_minor: plan.budget.amountMinor }),
        bid_strategy: plan.bidStrategy,
        ...(plan.bidAmountMinor !== undefined
          ? { bid_amount_minor: plan.bidAmountMinor }
          : {}),
        ...(input.start_time !== undefined ? { start_time: input.start_time } : {}),
        ...(input.end_time !== undefined ? { end_time: input.end_time } : {}),
        countries: plan.countries,
        age_min: plan.ageMin,
        age_max: plan.ageMax,
        ...(input.dsa !== undefined ? { dsa: input.dsa } : {}),
      },
      ...gateArgs(input),
      summary: [
        plan.summary,
        ...stepLines(plan),
        `To see the ad, call facebook_get_ad_preview with source {kind:"post", id:"${objectStoryId}"}.`,
      ].join('\n'),
      warnings: [...plan.warnings, ADS_RATE_LIMIT_NOTE],
      notPerformedNotice: 'This was a dry run — nothing was created.',
      readState,
      perform: async () => {
        cancelledBeforeSend = ctx.signal?.aborted === true;
        // Irreversible: the gate has validated plan_id before perform runs.
        const planTag = boostPlanTag(input.plan_id ?? '');
        const onEvent = async (event: BoostStepEvent): Promise<void> => {
          await ctx.journal.append({
            tool: TOOL,
            tier: 'irreversible',
            pageId: resolved.pageId,
            ...(input.plan_id !== undefined ? { planId: input.plan_id } : {}),
            outcome: event.outcome,
            summary: `Boost ${objectStoryId}: ${event.step} ${event.outcome}${event.objectId !== undefined ? ` (${event.objectId})` : ''}.`,
            metadata: {
              chain: 'boost',
              planTag,
              step: event.step,
              seq: event.seq,
              ...(event.objectId !== undefined ? { objectId: event.objectId } : {}),
              ...(event.code !== undefined ? { code: event.code } : {}),
              ...(event.subcode !== undefined ? { subcode: event.subcode } : {}),
              ...(event.reconciled !== undefined ? { reconciled: event.reconciled } : {}),
            },
          });
        };
        const outcome = await runBoostChain(ctx.fbRequest, plan, {
          planTag,
          ...signalOf(ctx),
          onEvent,
        });
        return { ...outcome, report: boostReport(outcome) };
      },
      classifyResult: verdictOf,
      classifyOutcome: (err) =>
        cancelledBeforeSend ? 'failed' : classifyUpdateFailure(err),
      metadata: {
        postId: objectStoryId,
        accountId: account.id,
        objective: plan.objective,
        spendCapMinor: plan.spendCapMinor,
      },
    });
  },
});
