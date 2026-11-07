// Ad-account health (CC-ADS-6) (X11 split of `ads-read.ts`).

import { GraphApiError } from '../../core/index.js';
import type { FbRequestFn } from '../../core/index.js';
import { formatMinor } from '../ads-money.js';
import { AD_ACCOUNT_FIELDS, MARKETING_API } from './levels.js';
import type { AdsRequestOptions } from './model.js';
import { isRecord, readString } from './normalize.js';

// ---------------------------------------------------------------------------
// 7. Ad-account health (CC-ADS-6)
// ---------------------------------------------------------------------------

/** Documented `account_status` codes. Unknown codes are reported as unknown. */
export const AD_ACCOUNT_STATUS_LABELS: Readonly<Record<number, string>> = {
  1: 'ACTIVE',
  2: 'DISABLED',
  3: 'UNSETTLED',
  7: 'PENDING_RISK_REVIEW',
  8: 'PENDING_SETTLEMENT',
  9: 'IN_GRACE_PERIOD',
  100: 'PENDING_CLOSURE',
  101: 'CLOSED',
  201: 'ANY_ACTIVE',
  202: 'ANY_CLOSED',
};

/** Documented `disable_reason` codes. */
export const AD_ACCOUNT_DISABLE_REASONS: Readonly<Record<number, string>> = {
  0: 'NONE',
  1: 'ADS_INTEGRITY_POLICY',
  2: 'ADS_IP_REVIEW',
  3: 'RISK_PAYMENT',
  4: 'GRAY_ACCOUNT_SHUT_DOWN',
  5: 'ADS_AFC_REVIEW',
  6: 'BUSINESS_INTEGRITY_RAR',
  7: 'PERMANENT_CLOSE',
  8: 'UNUSED_RESELLER_ACCOUNT',
  9: 'UNUSED_ACCOUNT',
};

/** Status codes under which Meta still serves ads for the account. */
const SERVING_ACCOUNT_STATUSES: ReadonlySet<number> = new Set([1, 201]);

/** Serving, but with a payment problem that will stop delivery if ignored. */
const AT_RISK_ACCOUNT_STATUSES: ReadonlySet<number> = new Set([3, 8, 9]);

/**
 * A code outside {@link AD_ACCOUNT_STATUS_LABELS}. Meta adds statuses without
 * notice; one this server has never heard of is not evidence that the account
 * is dead, only that nothing can be said about it from here.
 */
function isUndocumentedStatus(status: number | undefined): boolean {
  return status !== undefined && AD_ACCOUNT_STATUS_LABELS[status] === undefined;
}

export interface AdAccountInfo {
  /** Normalised `act_<id>`. */
  readonly id: string;
  readonly name?: string;
  /** Raw `account_status` code, when Graph returned one. */
  readonly accountStatus?: number;
  /** Decoded label, or `UNKNOWN(<code>)` / `UNKNOWN` when undecodable. */
  readonly statusLabel: string;
  readonly disableReason?: number;
  readonly disableReasonLabel?: string;
  /** ISO currency the account is billed in — the unit for every `*_minor` value. */
  readonly currency?: string;
  readonly timezone?: string;
  /**
   * True when Graph reports a HEALTHY serving state (`ACTIVE` / `ANY_ACTIVE`).
   * Not the same question as "is it delivering right now": an {@link atRisk}
   * account is `serving: false` and still spending money.
   */
  readonly serving: boolean;
  /**
   * True for the payment-problem statuses (`UNSETTLED`, `PENDING_SETTLEMENT`,
   * `IN_GRACE_PERIOD`). Meta keeps delivering — and keeps charging — until the
   * balance is settled, so these accounts are the ones where stopping delivery
   * is most urgent. See {@link assertAdAccountUsable}.
   */
  readonly atRisk: boolean;
  /**
   * Account spend limit in minor units; `0` means the account has no limit.
   * Graph returns it as a numeric string (the account-level WRITE takes major
   * units, the READ is documented as minor units — unverified on a live account).
   */
  readonly spendCapMinor?: number;
  /** Lifetime amount spent, minor units. */
  readonly amountSpentMinor?: number;
  /** Outstanding bill amount, minor units. */
  readonly balanceMinor?: number;
  /** `spendCap − amountSpent` when the account has a limit; absent otherwise. */
  readonly headroomMinor?: number;
  /** Smallest daily budget Meta accepts on this account, minor units. */
  readonly minDailyBudgetMinor?: number;
  /** Smallest campaign spend cap Meta accepts on this account, minor units. */
  readonly minCampaignSpendCapMinor?: number;
  /** "Account spend limit: X, spent: Y, remaining: Z" — present when Graph returned the amounts. */
  readonly moneySummary?: string;
  /** Operator-facing explanation; always present. */
  readonly summary: string;
}

/**
 * A minor-unit amount Graph returned as a numeric string (or, for the `min_*`
 * fields, a number). Anything that is not a non-negative safe integer is
 * treated as absent rather than guessed at.
 */
function readMinor(value: unknown): number | undefined {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : undefined;
  return n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

interface AccountMoney {
  readonly spendCapMinor?: number;
  readonly amountSpentMinor?: number;
  readonly balanceMinor?: number;
  readonly headroomMinor?: number;
  readonly minDailyBudgetMinor?: number;
  readonly minCampaignSpendCapMinor?: number;
  readonly moneySummary?: string;
}

/** Decode the account's money headroom (backlog A1). Pure. */
function describeAccountMoney(
  src: Record<string, unknown>,
  currency: string | undefined,
): AccountMoney {
  const spendCapMinor = readMinor(src.spend_cap);
  const amountSpentMinor = readMinor(src.amount_spent);
  const balanceMinor = readMinor(src.balance);
  const minDailyBudgetMinor = readMinor(src.min_daily_budget);
  const minCampaignSpendCapMinor = readMinor(src.min_campaign_group_spend_cap);
  const headroomMinor =
    spendCapMinor !== undefined && spendCapMinor > 0 && amountSpentMinor !== undefined
      ? Math.max(0, spendCapMinor - amountSpentMinor)
      : undefined;

  let moneySummary: string | undefined;
  if (spendCapMinor !== undefined || amountSpentMinor !== undefined) {
    const limit =
      spendCapMinor === undefined
        ? 'unknown'
        : spendCapMinor === 0
          ? 'none'
          : formatMinor(spendCapMinor, currency);
    const spent =
      amountSpentMinor === undefined
        ? 'unknown'
        : formatMinor(amountSpentMinor, currency);
    const remaining =
      headroomMinor !== undefined
        ? formatMinor(headroomMinor, currency)
        : spendCapMinor === 0
          ? 'unlimited (no account spend limit)'
          : 'unknown';
    moneySummary = `Account spend limit: ${limit}, spent: ${spent}, remaining: ${remaining}.`;
  }

  return {
    ...(spendCapMinor !== undefined ? { spendCapMinor } : {}),
    ...(amountSpentMinor !== undefined ? { amountSpentMinor } : {}),
    ...(balanceMinor !== undefined ? { balanceMinor } : {}),
    ...(headroomMinor !== undefined ? { headroomMinor } : {}),
    ...(minDailyBudgetMinor !== undefined ? { minDailyBudgetMinor } : {}),
    ...(minCampaignSpendCapMinor !== undefined ? { minCampaignSpendCapMinor } : {}),
    ...(moneySummary !== undefined ? { moneySummary } : {}),
  };
}

/**
 * Read the account's health and currency in one call. Used by the doctor check
 * (CC-ADS-6) and as the pre-flight for every write, where it doubles as the
 * source of the currency echo (CC-ADS-3).
 */
export async function readAdAccount(
  fbRequest: FbRequestFn,
  opts: AdsRequestOptions & { readonly accountId: string },
): Promise<AdAccountInfo> {
  const res = await fbRequest<unknown>({
    protocol: 'json',
    method: 'GET',
    host: 'graph',
    api: MARKETING_API,
    path: `/${opts.accountId}`,
    params: { fields: AD_ACCOUNT_FIELDS },
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  return describeAdAccount(opts.accountId, res.data);
}

/** Decode a raw ad-account node into {@link AdAccountInfo}. Pure. */
export function describeAdAccount(accountId: string, raw: unknown): AdAccountInfo {
  const src: Record<string, unknown> = isRecord(raw) ? raw : {};
  const status = typeof src.account_status === 'number' ? src.account_status : undefined;
  const disableReason =
    typeof src.disable_reason === 'number' ? src.disable_reason : undefined;
  const statusLabel =
    status === undefined
      ? 'UNKNOWN'
      : (AD_ACCOUNT_STATUS_LABELS[status] ?? `UNKNOWN(${String(status)})`);
  const disableReasonLabel =
    disableReason === undefined
      ? undefined
      : (AD_ACCOUNT_DISABLE_REASONS[disableReason] ??
        `UNKNOWN(${String(disableReason)})`);
  const serving = status !== undefined && SERVING_ACCOUNT_STATUSES.has(status);
  const atRisk = status !== undefined && AT_RISK_ACCOUNT_STATUSES.has(status);

  let summary: string;
  if (status === undefined) {
    summary =
      'Ad account status unknown: Graph returned no `account_status`. The token may lack ads_read on this account.';
  } else if (serving) {
    summary = 'Ad account is active and can serve ads.';
  } else if (atRisk) {
    summary = `Ad account is ${statusLabel}: billing is unsettled or in a grace period. It is STILL DELIVERING and still spending; Meta will stop delivery once the grace period ends — settle the balance or fix the payment method in Ads Manager. Pausing an object is still allowed from here; resuming and budget changes are not.`;
  } else if (isUndocumentedStatus(status)) {
    // Not "cannot serve ads": that is a guess, and the doctor prints it verbatim.
    summary = `Ad account status code ${String(status)} is not one this server knows${
      disableReasonLabel !== undefined && disableReasonLabel !== 'NONE'
        ? ` (disable reason: ${disableReasonLabel})`
        : ''
    }, so whether it can serve ads cannot be told from here — check the account in Ads Manager. Writes are attempted and Graph decides.`;
  } else {
    summary = `Ad account is ${statusLabel}${
      disableReasonLabel !== undefined && disableReasonLabel !== 'NONE'
        ? ` (disable reason: ${disableReasonLabel})`
        : ''
    }: it cannot serve ads and write calls will fail. This cannot be fixed from the API — resolve it in Ads Manager / Business Manager.`;
  }

  const name = readString(src.name);
  const currency = readString(src.currency);
  const timezone = readString(src.timezone_name);

  return {
    id: accountId,
    ...(name !== undefined ? { name } : {}),
    ...(status !== undefined ? { accountStatus: status } : {}),
    statusLabel,
    ...(disableReason !== undefined ? { disableReason } : {}),
    ...(disableReasonLabel !== undefined ? { disableReasonLabel } : {}),
    ...(currency !== undefined ? { currency } : {}),
    ...(timezone !== undefined ? { timezone } : {}),
    serving,
    atRisk,
    ...describeAccountMoney(src, currency),
    summary,
  };
}

/**
 * Turn a blocked ad account into an error carrying the `account` category
 * (CC-ADS-6). Built by hand because the shared error matrix keys on Graph error
 * codes, and a disabled account is discovered by READING a field successfully —
 * there is no Graph error to classify.
 */
export function adAccountBlockedError(info: AdAccountInfo): GraphApiError {
  // An at-risk account is not a dead account: it is delivering as this error is
  // raised. Saying "cannot serve ads" about it would contradict the very summary
  // appended one sentence later, and would send the operator to fix a permission
  // problem that does not exist.
  const headline = info.atRisk
    ? `Ad account ${info.id} is ${info.statusLabel} and only delivery-stopping changes are accepted, so this change was NOT attempted.`
    : `Ad account ${info.id} is ${info.statusLabel} and cannot serve ads, so this change was NOT attempted.`;
  const operatorText = info.atRisk
    ? `Ad account ${info.id} is ${info.statusLabel}: it is still delivering and still spending. Settle the balance in Ads Manager to restore full control. Until then this server accepts only writes that STOP delivery — pause the object with status:"PAUSED" and no budget field — so spending can always be halted.`
    : `Ad account ${info.id} is ${info.statusLabel}${
        info.disableReasonLabel !== undefined && info.disableReasonLabel !== 'NONE'
          ? ` (${info.disableReasonLabel})`
          : ''
      }. Restore it in Ads Manager (billing, policy appeal or reactivation) before retrying — no API call can clear this state.`;
  return new GraphApiError(`${headline} ${info.summary}`, {
    code: 100,
    httpStatus: 400,
    action: { category: 'account', retryable: false, operatorText },
  });
}

/** What the pending write would do to delivery, as far as the gate cares. */
export interface AdWriteIntent {
  /**
   * True only when the write can do nothing but REDUCE spend — pause, and no
   * budget change riding along. A budget edit never qualifies, not even a
   * decrease: it leaves the object delivering.
   */
  readonly stopsDelivery?: boolean;
}

/**
 * Pre-flight for ads WRITES: refuse before the wire when the account cannot
 * serve. Accounts whose status is unknown are allowed through — an absent field
 * is not evidence of a problem, and Graph will reject the write if it is. The
 * same goes for a status code this server cannot decode: refusing on it would
 * turn every new Meta status into a lock-out, pause included.
 *
 * The one deliberate hole is for at-risk accounts (`UNSETTLED`,
 * `PENDING_SETTLEMENT`, `IN_GRACE_PERIOD`). Those are `serving: false` yet still
 * delivering and still being charged, so a blanket refusal locks the operator
 * out of the single action that reduces the damage — a guardrail against
 * spending that forbids stopping the spending. Pausing is therefore let through;
 * resuming and budget writes stay refused, so the hole cannot be used to spend
 * more on an account that is already in payment trouble.
 */
export function assertAdAccountUsable(
  info: AdAccountInfo,
  intent: AdWriteIntent = {},
): void {
  if (info.accountStatus === undefined) return;
  if (isUndocumentedStatus(info.accountStatus)) return;
  if (info.serving) return;
  if (info.atRisk && intent.stopsDelivery === true) return;
  throw adAccountBlockedError(info);
}
