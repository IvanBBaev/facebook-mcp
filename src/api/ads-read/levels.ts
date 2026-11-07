// Ad levels, Graph edges and field sets (X11 split of `ads-read.ts`).

import type { ApiFamily } from '../../core/index.js';

// ---------------------------------------------------------------------------
// 1. Levels, edges and field sets
// ---------------------------------------------------------------------------

/**
 * Every request this package (and `./ads-control.ts`) sends is a Marketing API
 * call, so it is versioned by `Settings.adsApiVersion` (`FB_ADS_API_VERSION`),
 * not by the Graph pin: a Marketing API version retires years before the Graph
 * API version of the same number.
 */
export const MARKETING_API: ApiFamily = 'marketing';

/** The three object levels this package reads and controls. */
export const AD_LEVELS = ['campaign', 'adset', 'ad'] as const;

export type AdLevel = (typeof AD_LEVELS)[number];

export function isAdLevel(value: string): value is AdLevel {
  return (AD_LEVELS as readonly string[]).includes(value);
}

/** Edge under `/act_<id>` that lists each level. */
export const AD_LEVEL_EDGES: Readonly<Record<AdLevel, string>> = {
  campaign: 'campaigns',
  adset: 'adsets',
  ad: 'ads',
};

/**
 * Fields requested for a LISTING. Deliberately small: a listing is a scan, and
 * every extra field multiplies by the page size against the result budget.
 * `effective_status` is non-negotiable on every level (CC-ADS-2).
 */
export const AD_LEVEL_LIST_FIELDS: Readonly<Record<AdLevel, string>> = {
  campaign:
    'id,name,status,effective_status,objective,daily_budget,lifetime_budget,updated_time',
  adset:
    'id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,optimization_goal,updated_time',
  ad: 'id,name,status,effective_status,adset_id,campaign_id,updated_time',
};

/**
 * Fields requested for a SINGLE object read. Wider than the listing set, but
 * still excludes the two genuinely unbounded blobs — ad-set `targeting` and ad
 * `creative` spec — which can each dwarf the whole result budget on their own.
 */
export const AD_LEVEL_DETAIL_FIELDS: Readonly<Record<AdLevel, string>> = {
  campaign:
    'id,name,status,effective_status,objective,buying_type,daily_budget,lifetime_budget,budget_remaining,spend_cap,bid_strategy,start_time,stop_time,created_time,updated_time,account_id,advantage_state_info',
  adset:
    'id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,budget_remaining,optimization_goal,billing_event,bid_strategy,bid_amount,start_time,end_time,created_time,updated_time,account_id',
  ad: 'id,name,status,effective_status,adset_id,campaign_id,created_time,updated_time,account_id,creative{id,name}',
};

/**
 * Fields read when the level is unknown. Graph object ids do not encode their
 * level, so a caller that omits `level` gets the intersection that every level
 * answers plus the parent ids that reveal what it actually is. `account_id` is
 * in that intersection and a write's ownership check depends on it.
 */
export const AD_OBJECT_COMMON_FIELDS =
  'id,name,status,effective_status,created_time,updated_time,account_id';

/**
 * Ad-account fields backing the health check, the currency echo and the money
 * headroom (backlog A1). The DSA payor/beneficiary defaults are deliberately NOT
 * here: whether `ads_read` may read them is unverified, and one unreadable field
 * fails the whole read — and with it every write's pre-flight.
 */
export const AD_ACCOUNT_FIELDS =
  'id,account_id,name,account_status,disable_reason,currency,timezone_name,spend_cap,amount_spent,balance,min_daily_budget,min_campaign_group_spend_cap';

/** Explains why `targeting` / `creative` specs are absent from a detail read. */
export const OMITTED_BLOB_NOTE =
  'Ad-set `targeting` and the full ad `creative` spec are not read: either can be larger than the entire result budget. Read them directly in Ads Manager when needed.';

/** Dev-tier call-budget guidance (CC-ADS-1). */
export const ADS_RATE_LIMIT_NOTE =
  'Marketing API calls are metered per ad account and the development tier is small (roughly 300 + 40 x active ads per hour). Check headroom with facebook_usage before a polling loop; on a rate-limit error the message carries how many minutes until access returns.';
