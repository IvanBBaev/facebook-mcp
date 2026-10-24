// Single-object archive / delete (v2 ads §3) — retire one campaign, ad set or
// ad by id.
//
//   * archive ⇒ `POST /{id}` `status=ARCHIVED`
//   * delete  ⇒ `DELETE /{id}` for a campaign (documented, `{success:bool}`);
//               `POST /{id}` `status=DELETED` for an ad set, an ad, or an
//               object whose level was not given — documented for all three
//               levels, while DELETE on an ad set / ad is unverified.
//
// Never the account-level bulk DELETE. Both changes cascade to the object's
// children and neither can be undone through the API, so both are
// `irreversible`. The planner is PURE: the reads it needs (the object, its
// child counts, its last-28-day spend) are made by the caller and passed in,
// so a refusal happens with certainty that nothing was written.

import { GraphApiError, classifyGraphError } from '../core/index.js';
import type { FbRequestFn, JsonRequest } from '../core/index.js';
import { MARKETING_API } from './ads-read.js';
import type { AdLevel, AdRecord } from './ads-read.js';
import { confirmsAdUpdate, mapUpdateError } from './ads-control.js';

// ---------------------------------------------------------------------------
// 1. Constants and shapes
// ---------------------------------------------------------------------------

export type LifecycleTarget = 'ARCHIVED' | 'DELETED';

/** Children that inherit the change. A missing key means "could not be read". */
export interface ChildCounts {
  readonly adsets?: number;
  readonly ads?: number;
}

/** The read that shows an ads object's status after the write. */
const AD_OBJECT_READ_TOOL = 'facebook_get_ad_object';

export const ARCHIVE_NOTE =
  'Archived objects can only be renamed or deleted; the API cannot resume them.';

export const DELETE_PERMANENT_NOTE =
  'Deleting is permanent: a deleted object cannot be restored or edited, and it drops out of the default listings.';

export const DELIVERED_28D_NOTE =
  'This object delivered in the last 28 days. Meta advises waiting 28 days after last delivery before deleting; reporting for deleted objects may be limited.';

export const DELIVERED_28D_UNKNOWN_NOTE =
  'Whether this object delivered in the last 28 days could not be read. Meta advises waiting 28 days after last delivery before deleting; reporting for deleted objects may be limited.';

export const STOPS_DELIVERY_NOTE =
  'This object is delivering now (effective_status ACTIVE); this change stops it.';

const VERB: Readonly<Record<LifecycleTarget, string>> = {
  ARCHIVED: 'Archive',
  DELETED: 'Delete',
};

function validationError(message: string): GraphApiError {
  return new GraphApiError(message, {
    code: 100,
    httpStatus: 400,
    action: classifyGraphError({ code: 100, message }),
  });
}

function upper(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toUpperCase();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

// ---------------------------------------------------------------------------
// 2. The pure planner
// ---------------------------------------------------------------------------

export interface LifecycleRequest {
  readonly objectId: string;
  readonly level?: AdLevel;
  readonly current: AdRecord;
  readonly target: LifecycleTarget;
  /** Undefined when the counts could not be read at all. */
  readonly children?: ChildCounts;
  /** Whether it spent in the last 28 days; undefined when unknown or not read. */
  readonly delivered28d?: boolean;
}

export interface LifecyclePlan {
  readonly objectId: string;
  readonly level?: AdLevel;
  readonly fromStatus: string | undefined;
  readonly toStatus: LifecycleTarget;
  /** Total children that inherit the change, or `'unknown'`. */
  readonly childrenAffected: number | 'unknown';
  readonly summary: string;
  readonly warnings: readonly string[];
}

/** The children a level can have, in the order the preview names them. */
function expectedChildren(level: AdLevel | undefined): readonly (keyof ChildCounts)[] {
  if (level === 'campaign') return ['adsets', 'ads'];
  if (level === 'adset') return ['ads'];
  return [];
}

export function childrenTotal(
  level: AdLevel | undefined,
  children: ChildCounts | undefined,
): number | 'unknown' {
  if (level === 'ad') return 0;
  if (level === undefined || children === undefined) return 'unknown';
  let total = 0;
  for (const key of expectedChildren(level)) {
    const count = children[key];
    if (count === undefined) return 'unknown';
    total += count;
  }
  return total;
}

function childrenNote(
  level: AdLevel | undefined,
  children: ChildCounts | undefined,
  target: LifecycleTarget,
): string | undefined {
  if (level === 'ad') return undefined;
  const state = target.toLowerCase();
  if (level === undefined) {
    return `Any ad sets and ads under it will also be ${state}; pass level to count them.`;
  }
  const parts: string[] = [];
  for (const key of expectedChildren(level)) {
    const count = children?.[key];
    const noun = key === 'adsets' ? 'ad sets' : 'ads';
    parts.push(`${count === undefined ? 'an unknown number of' : String(count)} ${noun}`);
  }
  return `${parts.join(' and ')} under it will also be ${state}.`;
}

/**
 * Plan an archive or a delete. Refuses locally an object that is already
 * deleted, or an archive of an object that is already archived; deleting an
 * archived object is allowed.
 */
export function planLifecycleChange(req: LifecycleRequest): LifecyclePlan {
  const status = upper(req.current.status);
  const effective = upper(req.current.effective_status);
  if (status === 'DELETED' || effective === 'DELETED') {
    throw validationError(
      `${req.objectId} is already deleted; nothing to change. Deleted objects cannot be edited or restored.`,
    );
  }
  if (req.target === 'ARCHIVED' && (status === 'ARCHIVED' || effective === 'ARCHIVED')) {
    throw validationError(
      `${req.objectId} is already archived; nothing to change. To remove it for good, use facebook_delete_ad_object.`,
    );
  }

  const warnings: string[] = [];
  const children = childrenNote(req.level, req.children, req.target);
  if (children !== undefined) warnings.push(children);
  if (effective === 'ACTIVE') warnings.push(STOPS_DELIVERY_NOTE);
  if (req.target === 'ARCHIVED') {
    warnings.push(ARCHIVE_NOTE);
  } else {
    warnings.push(DELETE_PERMANENT_NOTE);
    if (effective === 'ACTIVE' || req.delivered28d === true) {
      warnings.push(DELIVERED_28D_NOTE);
    } else if (req.delivered28d === undefined) {
      warnings.push(DELIVERED_28D_UNKNOWN_NOTE);
    }
  }

  const childrenAffected = childrenTotal(req.level, req.children);
  const name = typeof req.current.name === 'string' ? ` "${req.current.name}"` : '';
  const what = req.level ?? 'ads object';
  const summary =
    `${VERB[req.target]} ${what} ${req.objectId}${name} — status: ${status ?? 'unknown'} -> ${req.target}` +
    ` (children affected: ${String(childrenAffected)}). This cannot be undone through the API.`;

  return {
    objectId: req.objectId,
    ...(req.level !== undefined ? { level: req.level } : {}),
    fromStatus: status,
    toStatus: req.target,
    childrenAffected,
    summary,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 3. Requests
// ---------------------------------------------------------------------------

/** `POST /{id}` `status=ARCHIVED`. */
export function archiveAdObjectRequest(
  objectId: string,
  signal?: AbortSignal,
): JsonRequest {
  return {
    protocol: 'json',
    method: 'POST',
    host: 'graph',
    api: MARKETING_API,
    path: `/${objectId}`,
    body: { status: 'ARCHIVED' },
    verifyTool: AD_OBJECT_READ_TOOL,
    ...(signal !== undefined ? { signal } : {}),
  };
}

/**
 * Delete one ads object: `DELETE /{id}` for a campaign, `POST /{id}`
 * `status=DELETED` otherwise (documented for every level).
 */
export function deleteAdObjectRequest(
  objectId: string,
  level: AdLevel | undefined,
  signal?: AbortSignal,
): JsonRequest {
  const base = {
    protocol: 'json' as const,
    host: 'graph' as const,
    api: MARKETING_API,
    path: `/${objectId}`,
    verifyTool: AD_OBJECT_READ_TOOL,
    ...(signal !== undefined ? { signal } : {}),
  };
  if (level === 'campaign') return { ...base, method: 'DELETE' };
  return { ...base, method: 'POST', body: { status: 'DELETED' } };
}

// ---------------------------------------------------------------------------
// 4. Best-effort reads behind the preview
// ---------------------------------------------------------------------------

function totalCountOf(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const summary: unknown = (body as Record<string, unknown>).summary;
  if (typeof summary !== 'object' || summary === null) return undefined;
  const total: unknown = (summary as Record<string, unknown>).total_count;
  return typeof total === 'number' && Number.isInteger(total) && total >= 0
    ? total
    : undefined;
}

/**
 * Count the children that inherit the change, via
 * `GET /{id}/{adsets|ads}?summary=total_count&limit=0`. A failed count is left
 * out (shown as unknown) rather than failing the preview; an abort propagates.
 */
export async function readChildCounts(
  fbRequest: FbRequestFn,
  objectId: string,
  level: AdLevel | undefined,
  signal?: AbortSignal,
): Promise<ChildCounts | undefined> {
  if (level === undefined) return undefined;
  const out: { adsets?: number; ads?: number } = {};
  for (const edge of expectedChildren(level)) {
    try {
      const res = await fbRequest<unknown>({
        protocol: 'json',
        method: 'GET',
        host: 'graph',
        api: MARKETING_API,
        path: `/${objectId}/${edge}`,
        params: { summary: 'total_count', limit: 0 },
        ...(signal !== undefined ? { signal } : {}),
      });
      const count = totalCountOf(res.data);
      if (count !== undefined) out[edge] = count;
    } catch (err) {
      if (signal?.aborted === true) throw err;
    }
  }
  return out;
}

/**
 * Whether the object spent anything in the last 28 days
 * (`GET /{id}/insights?fields=spend&date_preset=last_28d`). Undefined when the
 * read failed or its answer could not be parsed.
 */
export async function readDelivered28d(
  fbRequest: FbRequestFn,
  objectId: string,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  try {
    const res = await fbRequest<unknown>({
      protocol: 'json',
      method: 'GET',
      host: 'graph',
      api: MARKETING_API,
      path: `/${objectId}/insights`,
      params: { fields: 'spend', date_preset: 'last_28d' },
      ...(signal !== undefined ? { signal } : {}),
    });
    const body = res.data;
    if (typeof body !== 'object' || body === null) return undefined;
    const rows: unknown = (body as Record<string, unknown>).data;
    if (!Array.isArray(rows)) return undefined;
    let parsed = true;
    const spent = rows.some((row: unknown) => {
      const raw: unknown =
        typeof row === 'object' && row !== null
          ? (row as Record<string, unknown>).spend
          : undefined;
      const value =
        typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
      if (!Number.isFinite(value)) parsed = false;
      return value > 0;
    });
    // No rows is Graph's answer for "no delivery in the window".
    return spent ? true : parsed ? false : undefined;
  } catch (err) {
    if (signal?.aborted === true) throw err;
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 5. The write
// ---------------------------------------------------------------------------

export interface LifecycleOutcome {
  readonly objectId: string;
  readonly level?: AdLevel;
  readonly fromStatus: string | undefined;
  readonly toStatus: LifecycleTarget;
  readonly childrenAffected: number | 'unknown';
  readonly success: boolean;
}

/**
 * Perform the planned archive / delete. Only ever called by the write gate
 * AFTER an explicit apply.
 *
 * @throws the mapped Graph error (`mapUpdateError`: a gone object reads as
 *   `not_found` with the ad-object read as the next tool).
 */
export async function applyLifecycleChange(
  fbRequest: FbRequestFn,
  plan: LifecyclePlan,
  signal?: AbortSignal,
): Promise<LifecycleOutcome> {
  const request =
    plan.toStatus === 'ARCHIVED'
      ? archiveAdObjectRequest(plan.objectId, signal)
      : deleteAdObjectRequest(plan.objectId, plan.level, signal);
  try {
    const res = await fbRequest<unknown>(request);
    return {
      objectId: plan.objectId,
      ...(plan.level !== undefined ? { level: plan.level } : {}),
      fromStatus: plan.fromStatus,
      toStatus: plan.toStatus,
      childrenAffected: plan.childrenAffected,
      success: confirmsAdUpdate(res.data),
    };
  } catch (err) {
    throw mapUpdateError(err, plan.objectId);
  }
}
