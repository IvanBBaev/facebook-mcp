// Control tools of the `ads` package: plan-gated status, budget and spend-cap
// changes (facebook_update_ad_object) and single-object archive / delete.

import { z } from 'zod';

import { ADS_RATE_LIMIT_NOTE, type AdRecord, getAdObject } from '../../api/ads-read.js';
import type { AdWriteIntent } from '../../api/ads-read.js';
import {
  SETTABLE_STATUSES,
  applyAdObjectUpdate,
  planAdObjectUpdate,
} from '../../api/ads-control.js';
import type { AdUpdateOutcome, SettableStatus } from '../../api/ads-control.js';
import {
  applyLifecycleChange,
  childrenTotal,
  planLifecycleChange,
  readChildCounts,
  readDelivered28d,
} from '../../api/ads-lifecycle.js';
import type { LifecycleOutcome, LifecycleTarget } from '../../api/ads-lifecycle.js';
import {
  APPLIED_VERDICT,
  REFUSED_VERDICT,
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
import {
  UPDATE_ANNOTATIONS,
  assertObjectInAccount,
  levelArg,
  objectIdArg,
  ownerAccountForWrite,
} from './common.js';

// ---------------------------------------------------------------------------
// Input fields
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Handlers
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
export function lifecycleTool(target: LifecycleTarget) {
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
        `object is refused. ${ADS_TERMS_NOTE}`
      : 'Delete one campaign, ad set or ad by id — permanently. Its ad sets and ads are deleted with ' +
        'it, and a deleted object cannot be restored or edited. Plan-first: without apply:true this ' +
        'returns a preview (current status, children affected, a warning when it delivered in the ' +
        'last 28 days) and changes NOTHING; applying requires apply:true plus the plan_id from that ' +
        'preview. An archived object can be deleted; an already deleted one is refused. Pass `level` ' +
        `so the children can be counted. Never deletes more than this one object tree. ${ADS_TERMS_NOTE}`,
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

/**
 * Build `facebook_update_ad_object`. Called once per `createAdsPackage()` so
 * every package instance gets its own tool object, exactly as before the split.
 */
export function createUpdateAdObjectTool() {
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
      'delivers. This tool never creates ads objects (a boost uses facebook_boost_post); to archive or ' +
      `delete one, use facebook_archive_ad_object / facebook_delete_ad_object. ${ADS_TERMS_NOTE}`,
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

  return updateAdObject;
}
