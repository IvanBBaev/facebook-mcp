// `facebook_duplicate_ad_object`: copy one campaign, ad set or ad into a PAUSED
// copy, refused when the campaign in the tree is uncapped or over the limits.

import { z } from 'zod';

import type { ToolAnnotations } from '../../core/index.js';
import { ADS_RATE_LIMIT_NOTE, AD_LEVELS } from '../../api/ads-read.js';
import type { AdWriteIntent } from '../../api/ads-read.js';
import {
  MAX_RENAME_SUFFIX_LENGTH,
  applyCopy,
  planCopy,
  readCopyTree,
} from '../../api/ads-copy.js';
import type { CopyOutcome, CopyTree } from '../../api/ads-copy.js';
import {
  APPLIED_VERDICT,
  ATTEMPTED_VERDICT,
  defineTool,
  type WriteResultVerdict,
} from '../../mcp/index.js';
import {
  applyArg,
  confirmTokenArg,
  executeWrite,
  gateArgs,
  planIdArg,
} from '../shared.js';
import {
  ADS_TERMS_NOTE,
  accountForWrite,
  adAccountIdArg,
  classifyUpdateFailure,
  signalOf,
} from '../ads-shared.js';
import { assertObjectInAccount, objectIdArg, ownerAccountForWrite } from './common.js';

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
export const duplicateAdObjectTool = defineTool({
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
    `plus the plan_id. Never retry an apply whose outcome is unknown — every call makes another copy. ${ADS_TERMS_NOTE}`,
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
