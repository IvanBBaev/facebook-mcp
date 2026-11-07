// Follower stock-vs-flow reconciliation of the insights read (X09 split of `insights.ts`).

import { canonicalMetricName } from './deprecations.js';
import type { MetricSummary } from './model.js';

/** Follower stock change checked against the daily follow / unfollow flows. */
export interface FollowerReconciliation {
  /** First and last `page_follows` snapshots in the returned series. */
  readonly start?: number;
  readonly end?: number;
  readonly stockChange?: number;
  /** Sums of the disjoint daily flow buckets, when requested and returned. */
  readonly follows?: number;
  readonly unfollows?: number;
  /** Which unfollow metric `unfollows` was read from. */
  readonly unfollowsMetric?: 'page_daily_unfollows' | 'page_daily_unfollows_unique';
  readonly netFlow?: number;
  /** `stockChange − netFlow`. Zero ⇒ the two independent views reconcile. */
  readonly discrepancy?: number;
  readonly consistent?: boolean;
  readonly note: string;
}

export interface InsightsDerived {
  readonly followers?: FollowerReconciliation;
}

const FOLLOWER_METRICS: ReadonlySet<string> = new Set([
  'page_follows',
  'page_daily_follows',
  'page_daily_unfollows',
  'page_daily_unfollows_unique',
]);

/** The flow's sum, when its summary carries one. */
function flowSum(summary: MetricSummary | undefined): number | undefined {
  return summary?.aggregation === 'sum' ? summary.value : undefined;
}

/**
 * Reconcile the `page_follows` stock change with daily follows minus daily
 * unfollows. Prefers `page_daily_unfollows` and falls back to
 * `page_daily_unfollows_unique` when the former is absent or has no sum.
 * Undefined when no follower metric was queried.
 */
export function deriveFollowerReconciliation(
  metrics: readonly MetricSummary[],
  queried: readonly string[] = metrics.map((metric) => metric.metric),
): FollowerReconciliation | undefined {
  if (!queried.some((metric) => FOLLOWER_METRICS.has(canonicalMetricName(metric)))) {
    return undefined;
  }
  const find = (name: string): MetricSummary | undefined =>
    metrics.find((metric) => canonicalMetricName(metric.metric) === name);
  const stock = find('page_follows');
  const followFlow = flowSum(find('page_daily_follows'));
  const plain = flowSum(find('page_daily_unfollows'));
  const unique = flowSum(find('page_daily_unfollows_unique'));
  const unfollowsMetric =
    plain !== undefined
      ? ('page_daily_unfollows' as const)
      : unique !== undefined
        ? ('page_daily_unfollows_unique' as const)
        : undefined;
  const unfollowFlow = plain ?? unique;

  const start = stock?.firstValue;
  const end = stock?.lastValue;
  const stockChange = stock?.change;
  const netFlow =
    followFlow !== undefined && unfollowFlow !== undefined
      ? followFlow - unfollowFlow
      : undefined;
  const discrepancy =
    stockChange !== undefined && netFlow !== undefined
      ? stockChange - netFlow
      : undefined;

  return {
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
    ...(stockChange !== undefined ? { stockChange } : {}),
    ...(followFlow !== undefined ? { follows: followFlow } : {}),
    ...(unfollowFlow !== undefined ? { unfollows: unfollowFlow } : {}),
    ...(unfollowsMetric !== undefined ? { unfollowsMetric } : {}),
    ...(netFlow !== undefined ? { netFlow } : {}),
    ...(discrepancy !== undefined ? { discrepancy, consistent: discrepancy === 0 } : {}),
    note:
      discrepancy === undefined
        ? 'Follower reconciliation is partial: request page_follows, page_daily_follows and page_daily_unfollows (or page_daily_unfollows_unique) together with period=day to compare the stock change against net daily flows.'
        : discrepancy === 0
          ? 'Follower stock change reconciles exactly with daily follows minus daily unfollows for the returned buckets.'
          : 'Follower stock change does NOT reconcile with daily follows minus daily unfollows. This can happen around the still-open current bucket, late Meta recomputation or missing points; treat the discrepancy as a data-quality warning.',
  };
}
