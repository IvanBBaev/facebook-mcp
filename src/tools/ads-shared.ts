// Helpers shared by the ads tool modules (`ads.ts`, `ads-create.ts`). They live
// apart so `ads.ts` can register tools from sibling modules without a circular
// import: a sibling that imported `ads.ts` would read `adAccountIdArg` before
// it is initialised.

import { z } from 'zod';
import { GraphApiError, isProvablyNotSent } from '../core/index.js';
import type { ToolContext } from '../core/index.js';
import {
  assertAdAccountUsable,
  normalizeAdAccountId,
  readAdAccount,
  type AdAccountInfo,
} from '../api/ads-read.js';
import type { AdWriteIntent } from '../api/ads-read.js';

export const adAccountIdArg = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    'Ad account to read, as "act_1234567890" or the bare digits. Omitted ⇒ the account configured in FB_AD_ACCOUNT_ID. A Page id or a Business id will not work here.',
  );

/**
 * The sentence every ads write-tool description ends with (Meta's Self-Serve
 * Ad Terms, 2026-11-20: the advertiser answers for third-party software). One
 * constant so the wording, and its share of the schema budget, stays single.
 */
export const ADS_TERMS_NOTE =
  "Changes are made in the operator's ad account under Meta's Self-Serve Ad Terms; the operator is billed and responsible for the result.";

/** `signal` spread, present only when the call carries an abort seam. */
export function signalOf(ctx: ToolContext): { signal?: AbortSignal } {
  return ctx.signal !== undefined ? { signal: ctx.signal } : {};
}

/**
 * Journal classification for an update whose `perform` REJECTED (C2 /
 * CC-LIFE-2), the same rule `moderation.ts` applies to its writes. A received
 * Graph error envelope proves Facebook processed the POST and refused it, so
 * nothing landed (`failed`). An `ambiguous` error (the answer was lost after
 * the request went out), a 5xx or status-0 fault, or anything that is not a
 * Graph error at all (an abort, a transport fault) leaves the outcome UNKNOWN:
 * the resume or budget raise may be live and spending, so the honest entry is
 * `attempted`. Without this hook the gate journals every rejection `failed`,
 * telling the operator reconciling spend that nothing moved. An abort whose
 * signal had already fired before the POST was issued is the exception, and
 * the handler (which alone can see that moment) journals it `failed`.
 */
export function classifyUpdateFailure(err: unknown): 'attempted' | 'failed' {
  if (!(err instanceof GraphApiError)) return 'attempted';
  if (err.action?.category === 'ambiguous') return 'attempted';
  // A connect-phase fault (DNS, ECONNREFUSED) provably put no byte of the POST
  // on the wire — the http layer retries it for exactly that reason — so the
  // write cannot have landed and "may be live" would be false.
  if (err.httpStatus === 0 && isProvablyNotSent(err.cause)) return 'failed';
  return err.httpStatus === 0 || err.httpStatus >= 500 ? 'attempted' : 'failed';
}

/**
 * Read the ad account behind a write, when one is known: it carries the currency
 * every `*_minor` value is denominated in, and its health decides whether the
 * write is attempted at all (CC-ADS-6). An unconfigured account is NOT an error
 * here — the object id alone is enough to write; only the currency echo is lost.
 */
export async function accountForWrite(
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
