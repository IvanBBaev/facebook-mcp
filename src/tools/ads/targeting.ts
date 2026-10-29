// Ad-set targeting tools of the `ads` package: read an ad set's audience, and
// edit only its countries and age range.

import { z } from 'zod';

import { GraphApiError, classifyGraphError } from '../../core/index.js';
import { ADS_RATE_LIMIT_NOTE, normalizeAdAccountId } from '../../api/ads-read.js';
import type { AdWriteIntent } from '../../api/ads-read.js';
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
} from '../../api/ads-targeting.js';
import type { TargetingEditOutcome } from '../../api/ads-targeting.js';
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
  shapeFor,
} from '../shared.js';
import { accountForWrite, adAccountIdArg, classifyUpdateFailure } from '../ads-shared.js';
import {
  READ_ONLY,
  UPDATE_ANNOTATIONS,
  assertObjectInAccount,
  ownerAccountForWrite,
  ownerAccountOf,
} from './common.js';

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
export const getAdSetTargetingTool = defineTool({
  name: 'facebook_get_ad_set_targeting',
  title: 'Get Ad Set Targeting',
  description:
    "Read one ad set's audience and summarise it in plain terms: countries, counts of regions / cities / locales, age range, genders, placements, and flags for detailed targeting, custom audiences, exclusions and Advantage+ audience (`advantage_audience_state` is on / off / unset; unset may default to on at Meta). `editable_by_this_server` says whether facebook_update_ad_set_targeting can change it, and `not_editable_because` says why not. Pass include_raw:true to also get the raw targeting spec (omitted above 64 KB).",
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
export const updateAdSetTargetingTool = defineTool({
  name: 'facebook_update_ad_set_targeting',
  title: 'Update Ad Set Targeting',
  description:
    "Change only the countries and/or the age range of one ad set's audience; everything else in its targeting is kept exactly as it is, except that an unset Advantage+ audience is written explicitly OFF so Meta cannot default it on. Refused when the audience is more complex than that (custom audiences, detailed targeting, regions/cities/zips, exclusions, Advantage+ audience on) — check editable_by_this_server with facebook_get_ad_set_targeting first. Adding EU countries to an audience that had none needs DSA payor/beneficiary info on the ad set or the account. Plan-first: without apply:true this returns a preview (before → after) and changes NOTHING; applying requires apply:true plus the plan_id from that preview, and is refused if the targeting changed in between.",
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
        advantageAudienceSetOff: plan.advantageAudienceSetOff,
      },
    });
  },
});
