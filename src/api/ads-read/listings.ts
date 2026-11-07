// Campaign / ad-set / ad listings and single-object reads (X11 split of `ads-read.ts`).

import type { FbRequestFn, ParamValue } from '../../core/index.js';
import { fetchPage } from '../shared.js';
import type { EdgeRequest } from '../shared.js';
import { EFFECTIVE_STATUS_NOTE } from './effective-status.js';
import {
  AD_LEVEL_DETAIL_FIELDS,
  AD_LEVEL_EDGES,
  AD_LEVEL_LIST_FIELDS,
  AD_OBJECT_COMMON_FIELDS,
  MARKETING_API,
  OMITTED_BLOB_NOTE,
} from './levels.js';
import type {
  AdListResult,
  AdObjectResult,
  AdsRequestOptions,
  GetAdObjectOptions,
  ListAdObjectsOptions,
} from './model.js';
import {
  BUDGET_KEYS,
  EMPTY_ADS_PAGE_MORE_FOLLOWS_NOTE,
  normalizeAdNode,
  withPinnedAdFields,
} from './normalize.js';
import type { AdRecord } from './normalize.js';

// ---------------------------------------------------------------------------
// 6. Listings and single-object reads
// ---------------------------------------------------------------------------

export function adsEdge(
  path: string,
  params: Record<string, ParamValue>,
  opts: AdsRequestOptions,
): EdgeRequest {
  return {
    host: 'graph',
    api: MARKETING_API,
    path,
    params,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };
}

function hasBudget(record: AdRecord): boolean {
  return BUDGET_KEYS.some(
    (key) => record[`${key}_minor`] !== undefined || record[key] !== undefined,
  );
}

/**
 * List campaigns, ad sets or ads under one ad account, a single cursor page at a
 * time. Every record carries the effective-status truth (CC-ADS-2) and
 * minor-unit budgets (CC-ADS-3).
 */
export async function listAdObjects(
  fbRequest: FbRequestFn,
  opts: ListAdObjectsOptions,
): Promise<AdListResult> {
  const params: Record<string, ParamValue> = {
    fields: withPinnedAdFields(opts.fields ?? AD_LEVEL_LIST_FIELDS[opts.level]),
  };
  // One local decides both the wire filter and the empty-page explanation: an
  // EMPTY array is no filter at all, and reporting it as one would send the
  // operator hunting for a status that was never sent.
  const statusFilter =
    opts.effectiveStatus !== undefined && opts.effectiveStatus.length > 0
      ? [...opts.effectiveStatus]
      : undefined;
  // Graph expects a JSON array literal for this filter.
  if (statusFilter !== undefined) params.effective_status = JSON.stringify(statusFilter);

  const page = await fetchPage<unknown>(
    fbRequest,
    adsEdge(`/${opts.accountId}/${AD_LEVEL_EDGES[opts.level]}`, params, opts),
    {
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.after !== undefined ? { after: opts.after } : {}),
    },
  );

  const objects = page.data.map((node) => normalizeAdNode(node));
  const notes = [EFFECTIVE_STATUS_NOTE];
  if (objects.length === 0 && !page.truncated && page.nextCursor !== undefined) {
    // Graph applies effective_status server-side and can answer a slice with
    // `data: []` beside `paging.next` (CC-PAGE-1). Every "no objects" line
    // below would be false here: the objects may be one call away.
    notes.push(EMPTY_ADS_PAGE_MORE_FOLLOWS_NOTE);
  } else if (objects.length === 0 && !page.truncated) {
    // A page fetched WITH a forward cursor is a continuation: that cursor came
    // out of a successful earlier page, so an empty result here is the end of
    // the walk, not a statement about the account. Advising a re-list with
    // effective_status would burn the metered ads edge for nothing.
    notes.push(
      opts.after !== undefined
        ? 'No further objects. This page was fetched with a forward cursor, so the listing has run past its last object — this says nothing about how many objects the account has.'
        : statusFilter === undefined
          ? 'No objects returned. Graph hides ARCHIVED and DELETED objects by default — pass effective_status to include them.'
          : 'No objects matched the requested effective_status filter.',
    );
  }

  return {
    accountId: opts.accountId,
    level: opts.level,
    objects,
    count: objects.length,
    hasBudgets: objects.some(hasBudget),
    truncated: page.truncated,
    ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    ...(page.note !== undefined ? { note: page.note } : {}),
    notes,
  };
}

/** Read a single campaign / ad set / ad by id. */
export async function getAdObject(
  fbRequest: FbRequestFn,
  opts: GetAdObjectOptions,
): Promise<AdObjectResult> {
  const fields = withPinnedAdFields(
    opts.fields ??
      (opts.level !== undefined
        ? AD_LEVEL_DETAIL_FIELDS[opts.level]
        : AD_OBJECT_COMMON_FIELDS),
  );

  const res = await fbRequest<unknown>({
    protocol: 'json',
    method: 'GET',
    host: 'graph',
    api: MARKETING_API,
    path: `/${opts.objectId}`,
    params: { fields },
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });

  const object = normalizeAdNode(res.data);
  const notes = [EFFECTIVE_STATUS_NOTE];
  if (opts.level !== undefined) notes.push(OMITTED_BLOB_NOTE);
  else
    notes.push(
      'No `level` was given, so only the fields common to every ads object were read. Pass level=campaign|adset|ad for the full per-level field set.',
    );

  return {
    objectId: opts.objectId,
    ...(opts.level !== undefined ? { level: opts.level } : {}),
    object,
    notes,
  };
}
