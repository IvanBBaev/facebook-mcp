// Option and result shapes of the ads reads (X11 split of `ads-read.ts`).

import type { Cursor } from '../../core/index.js';
import type { AdLevel } from './levels.js';
import type { AdRecord } from './normalize.js';

// ---------------------------------------------------------------------------
// 5. Option / result shapes
// ---------------------------------------------------------------------------

/** Abort seam every ads read carries. Ads calls use the user/system token, so
 * no page token is threaded here — a Page token cannot read an ad account. */
export interface AdsRequestOptions {
  readonly signal?: AbortSignal;
}

export interface ListAdObjectsOptions extends AdsRequestOptions {
  /** Normalised `act_<id>`; pass the output of {@link resolveAdAccountId}. */
  readonly accountId: string;
  readonly level: AdLevel;
  readonly limit?: number;
  readonly after?: Cursor;
  /** Overrides {@link AD_LEVEL_LIST_FIELDS} for this level. */
  readonly fields?: string;
  /**
   * `effective_status` values to keep, applied SERVER-side by Graph. Graph's
   * default hides archived/deleted objects entirely.
   */
  readonly effectiveStatus?: readonly string[];
}

/** Cursor-pagination fields shared by ads listings. */
export interface AdPagedResult {
  readonly nextCursor?: Cursor;
  /** True when the page is PARTIAL (cursor expiry), not complete. */
  readonly truncated: boolean;
  readonly note?: string;
}

export interface AdListResult extends AdPagedResult {
  readonly accountId: string;
  readonly level: AdLevel;
  readonly objects: readonly AdRecord[];
  readonly count: number;
  /**
   * True when at least one object in this page carries a budget. The listing
   * itself does NOT carry the account currency: `*_minor` values are in the ad
   * account's currency, which only {@link readAdAccount} reports.
   */
  readonly hasBudgets: boolean;
  readonly notes: readonly string[];
}

export interface GetAdObjectOptions extends AdsRequestOptions {
  readonly objectId: string;
  /** Known level ⇒ the richer per-level field set; omitted ⇒ common fields. */
  readonly level?: AdLevel;
  readonly fields?: string;
}

export interface AdObjectResult {
  readonly objectId: string;
  readonly level?: AdLevel;
  readonly object: AdRecord;
  readonly notes: readonly string[];
}
