// Shared building blocks of the `ads` package: the annotation quadruples, the
// input fields more than one tool takes, and the ad-account ownership checks
// every write runs before it builds a plan.

import { z } from 'zod';

import { GraphApiError, classifyGraphError } from '../../core/index.js';
import type { ToolAnnotations, ToolContext } from '../../core/index.js';
import {
  AD_LEVELS,
  type AdAccountInfo,
  readAdAccount,
  assertAdAccountUsable,
} from '../../api/ads-read.js';
import type { AdWriteIntent } from '../../api/ads-read.js';
import { signalOf } from '../ads-shared.js';

// ---------------------------------------------------------------------------
// Annotation quadruples (doc 06, one line per tool)
// ---------------------------------------------------------------------------

/** Every read tool in this package: read-only, non-destructive, idempotent, open-world. */
export const READ_ONLY: ToolAnnotations = {
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
export const UPDATE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

// ---------------------------------------------------------------------------
// Input fields
// ---------------------------------------------------------------------------

/**
 * Object ids are interpolated into `/{objectId}` and `/{objectId}/insights`, so
 * the shape check is PATH CONTAINMENT, not cosmetics: the WHATWG URL parser
 * resolves dot segments when the path is assigned, and `".."` would climb out of
 * the pinned API version. Ads ids are digits, but `act_<id>` is legal on the
 * insights edge, hence the underscore.
 */
export const AD_OBJECT_ID_SHAPE = /^[A-Za-z0-9_]+$/;

export const objectIdArg = z
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

export const levelArg = z
  .enum(AD_LEVELS)
  .optional()
  .describe(
    'Which kind of object this id is: "campaign", "adset" or "ad". Optional but recommended — with it the read returns the richer per-level field set and a budget write is validated against the level (an ad has no budget of its own).',
  );

export const fieldsArg = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    'Comma-separated Graph field list overriding this tool\'s default selection (e.g. "id,name,status,effective_status,daily_budget"). Creative blobs and targeting specs are deliberately outside the defaults because they blow the result budget; request them explicitly if you need them.',
  );

// ---------------------------------------------------------------------------
// Ad-account ownership
// ---------------------------------------------------------------------------

/**
 * The ad account an object names as its owner (`account_id`, bare digits or
 * `act_<id>`), as an `act_<id>` id — or undefined when the read carried none.
 */
export function ownerAccountOf(
  record: Readonly<Record<string, unknown>>,
): string | undefined {
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
export function assertObjectInAccount(
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
 * The fallback when no account was configured: read the account the object
 * names as its owner. Best effort for the READ only — this path used to make no
 * account request at all, so a token that can edit the object but not read its
 * account keeps writing as before, just without the currency echo. A health
 * verdict the read DID return is enforced like the configured path's.
 */
export async function ownerAccountForWrite(
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
