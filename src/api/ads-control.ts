// Marketing API CONTROL plumbing (task V10, `api` layer — imports only from
// `core` and sibling `api` modules).
//
// The 1.1 ads scope is read + STATUS and BUDGET control only (doc 06, A12):
// no creation, no deletion, no creative uploads. That leaves exactly one write
// edge — `POST /<object-id>` with `status` and/or a budget — and this module
// exists to make that one call safe:
//
//   * PLANNING IS PURE. `planAdObjectUpdate` takes the object as it is right now
//     plus the requested change and returns the wire params, a human summary,
//     the warnings and the write TIER — or throws. Nothing here touches the
//     network, so the whole risk surface is unit-testable and the plan/apply
//     gate can run it during a dry run without any chance of a write.
//   * BUDGETS ARE INTEGER MINOR UNITS, END TO END (CC-ADS-3). The tool argument
//     is `*_budget_minor`, the validator rejects anything that is not a
//     non-negative safe integer (a float would be a silent 100x error), and the
//     plan echoes the ad account's currency so "1000" is never read as dollars.
//   * THE CEILING REFUSES, IT NEVER CLAMPS (CC-ADS-7). `FB_ADS_BUDGET_CEILING`
//     is checked here, BEFORE the request is built, and an over-ceiling raise
//     throws with the numbers and the two ways forward. Silently lowering the
//     requested amount would be the worst possible outcome: the operator would
//     believe a budget was set that was not.
//   * ARCHIVED/DELETED OBJECTS ARE READ-ONLY (CC-ADS-4). Refused locally with a
//     clear reason, and a Graph 100 on the write is re-mapped to "gone or
//     archived" instead of the generic "invalid parameter".
//
// Tier assignment (both tiers are high-consequence, so both summon the
// out-of-band confirmer — the distinction is honesty about WHY):
//   * anything that can INCREASE spend — resuming to ACTIVE, or raising a
//     budget — is `spend`;
//   * anything else that overwrites state irrecoverably — pausing, or lowering
//     a budget (the previous value is gone) — is `irreversible`.
// A mixed change takes the higher of the two. No env var bypasses either tier
// (CC-ADS-7).

import { GraphApiError, classifyGraphError } from '../core/index.js';
import type { FbRequestFn, JsonRequest, ParamValue, WriteTier } from '../core/index.js';
import type { AdLevel, AdRecord } from './ads-read.js';

// ---------------------------------------------------------------------------
// 1. Constants
// ---------------------------------------------------------------------------

/** The only status values this package will SET (delete/archive are out of scope). */
export const SETTABLE_STATUSES = ['ACTIVE', 'PAUSED'] as const;

export type SettableStatus = (typeof SETTABLE_STATUSES)[number];

/** Statuses that make an object read-only — no status or budget edit lands (CC-ADS-4). */
export const READ_ONLY_STATUSES: ReadonlySet<string> = new Set(['DELETED', 'ARCHIVED']);

/** Levels that own a budget. An ad never does — its ad set does. */
export const BUDGET_LEVELS: ReadonlySet<AdLevel> = new Set<AdLevel>([
  'campaign',
  'adset',
]);

/** Emitted whenever a resume is planned: ACTIVE is a request, not a promise. */
export const RESUME_NOT_DELIVERY_NOTE =
  'Setting status=ACTIVE only clears the pause on THIS object. It will still not deliver if a parent campaign/ad set is paused, if review has not passed, or if the schedule has ended — re-read effective_status after applying.';

/** Emitted whenever a budget is overwritten: the previous value is not recoverable. */
export const BUDGET_OVERWRITE_NOTE =
  'A budget write OVERWRITES the current value; Meta keeps no history the API can restore, so record the previous amount before applying.';

/** Emitted when a budget change is planned on an object whose parent may own the budget. */
export const CBO_CONFLICT_NOTE =
  'Budgets live either on the campaign (campaign budget optimisation) or on its ad sets, never both. If this account uses campaign budgets, an ad-set budget write is rejected by Graph — set it on the campaign instead.';

/** Emitted when a lifetime budget is set on an object with no end time. */
export const LIFETIME_NEEDS_END_NOTE =
  'A lifetime budget requires an end time on the ad set. This object has none, so Graph will reject the change until an end time is set (which this server cannot do in the 1.1 scope).';

// ---------------------------------------------------------------------------
// 2. Errors
// ---------------------------------------------------------------------------

function validationError(message: string): GraphApiError {
  return new GraphApiError(message, {
    code: 100,
    httpStatus: 400,
    action: classifyGraphError({ code: 100, message }),
  });
}

/**
 * Re-map the write's Graph failure when it is the "object is gone or archived"
 * case (CC-ADS-4). Graph answers a status/budget write on a deleted or archived
 * object with a bare code 100, whose stock text ("Unsupported post request")
 * sends a model looking for a bad parameter that does not exist.
 */
export function mapUpdateError(err: unknown, objectId: string): unknown {
  if (!(err instanceof GraphApiError)) return err;
  if (err.code !== 100 || err.subcode !== undefined) return err;
  return new GraphApiError(
    `${err.message} The object ${objectId} may be DELETED or ARCHIVED (archived objects are read-only), or it may not exist on this ad account. Nothing was changed. Re-read it with facebook_get_ad_object — if it is archived, it cannot be edited or resumed through the API.`,
    {
      code: err.code,
      ...(err.type !== undefined ? { type: err.type } : {}),
      ...(err.fbtraceId !== undefined ? { fbtraceId: err.fbtraceId } : {}),
      httpStatus: err.httpStatus,
      ...(err.action !== undefined ? { action: err.action } : {}),
      cause: err,
    },
  );
}

// ---------------------------------------------------------------------------
// 3. Validation helpers
// ---------------------------------------------------------------------------

/** Normalise and validate a requested status. Case-insensitive on input. */
export function resolveSettableStatus(raw: string): SettableStatus {
  const upper = raw.trim().toUpperCase();
  if ((SETTABLE_STATUSES as readonly string[]).includes(upper)) {
    return upper as SettableStatus;
  }
  if (READ_ONLY_STATUSES.has(upper)) {
    throw validationError(
      `status="${raw}" is not settable here: this server's ads scope is status and budget control only. Deleting or archiving an ads object is deliberately out of scope — do it in Ads Manager.`,
    );
  }
  throw validationError(
    `Invalid status "${raw}". Use ACTIVE to resume or PAUSED to pause; nothing else can be set through this tool.`,
  );
}

/**
 * Validate one budget amount. Minor units only, integers only (CC-ADS-3) — a
 * float here would mean the caller is thinking in major units, which is exactly
 * the 100x mistake this package refuses to make.
 */
export function validateBudgetMinor(field: string, value: number): number {
  if (!Number.isFinite(value)) {
    throw validationError(`\`${field}\` must be a number of minor currency units.`);
  }
  if (!Number.isInteger(value)) {
    throw validationError(
      `\`${field}\` must be a whole number of MINOR currency units (cents), not ${String(
        value,
      )}. For example 1000 means 10.00, not 1000.00 — there is no float budget.`,
    );
  }
  if (value < 0) {
    throw validationError(`\`${field}\` must not be negative (got ${String(value)}).`);
  }
  if (!Number.isSafeInteger(value)) {
    throw validationError(`\`${field}\` is too large to represent exactly.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 4. Plan shapes
// ---------------------------------------------------------------------------

export type AdUpdateKind = 'status' | 'budget';

/** One field being written, with the value it is replacing when known. */
export interface AdUpdateChange {
  readonly kind: AdUpdateKind;
  /** Wire field name (`status`, `daily_budget`, `lifetime_budget`). */
  readonly field: string;
  /** Current value, when it could be read off the object. */
  readonly from?: string | number;
  readonly to: string | number;
}

export interface AdUpdateRequest {
  readonly objectId: string;
  readonly level?: AdLevel;
  /** ACTIVE or PAUSED; anything else is refused. */
  readonly status?: string;
  readonly dailyBudgetMinor?: number;
  readonly lifetimeBudgetMinor?: number;
}

export interface AdUpdateContext {
  /** The object as it is RIGHT NOW (normalised by `ads-read`). */
  readonly current: AdRecord;
  /** ISO currency from the ad account — the unit of every `*_minor` value. */
  readonly currency?: string;
  /** `FB_ADS_BUDGET_CEILING`, in minor units. Absent ⇒ no local ceiling. */
  readonly budgetCeilingMinor?: number;
}

export interface AdUpdatePlan {
  readonly objectId: string;
  readonly level?: AdLevel;
  /** Wire params for `POST /<object-id>`. */
  readonly params: Readonly<Record<string, ParamValue>>;
  readonly changes: readonly AdUpdateChange[];
  /** Highest tier across the requested changes. */
  readonly tier: WriteTier;
  readonly summary: string;
  readonly warnings: readonly string[];
  readonly currency?: string;
  /** True when at least one change can increase spend. */
  readonly increasesSpend: boolean;
}

// ---------------------------------------------------------------------------
// 5. The planner (pure)
// ---------------------------------------------------------------------------

function currentString(record: AdRecord, key: string): string | undefined {
  const value: unknown = record[key];
  return typeof value === 'string' ? value : undefined;
}

function currentMinor(record: AdRecord, key: string): number | undefined {
  const value: unknown = record[`${key}_minor`];
  return typeof value === 'number' ? value : undefined;
}

function formatMinor(value: number, currency: string | undefined): string {
  return currency !== undefined
    ? `${String(value)} minor units of ${currency}`
    : `${String(value)} minor units`;
}

/**
 * Enforce `FB_ADS_BUDGET_CEILING` BEFORE the request exists (CC-ADS-7).
 *
 * The ceiling blocks RAISES above the cap. A change that lowers an already
 * over-cap budget is allowed — refusing it would trap an operator above their
 * own ceiling with no way down through the API.
 *
 * @throws GraphApiError (validation) naming both numbers and both ways forward.
 *   Never clamps: a silently reduced budget is worse than a refusal.
 */
function enforceCeiling(input: {
  readonly field: string;
  readonly requested: number;
  readonly current: number | undefined;
  readonly ceiling: number;
  readonly currency: string | undefined;
  readonly objectId: string;
}): void {
  if (input.requested <= input.ceiling) return;
  const isLowering = input.current !== undefined && input.requested < input.current;
  if (isLowering) return;
  throw validationError(
    `Refused: \`${input.field}\` of ${formatMinor(input.requested, input.currency)} exceeds FB_ADS_BUDGET_CEILING (${formatMinor(
      input.ceiling,
      input.currency,
    )}). NOTHING was changed on ${input.objectId} and the amount was NOT reduced to the ceiling. Either request ${String(
      input.ceiling,
    )} or less, or raise FB_ADS_BUDGET_CEILING in the server configuration and restart.`,
  );
}

const TIER_RANK: Readonly<Record<string, number>> = { irreversible: 1, spend: 2 };

function higherTier(a: WriteTier, b: WriteTier): WriteTier {
  return (TIER_RANK[a] ?? 0) >= (TIER_RANK[b] ?? 0) ? a : b;
}

/**
 * Turn a requested change into a validated, tier-classified plan. Pure: it makes
 * no request, so the write gate can build it during a dry run with no chance of
 * a write reaching Graph.
 *
 * @throws GraphApiError (validation) for an empty change set, a read-only
 *   object (CC-ADS-4), a non-integer or negative budget (CC-ADS-3), both budget
 *   kinds at once, or a ceiling breach (CC-ADS-7).
 */
export function planAdObjectUpdate(
  req: AdUpdateRequest,
  ctx: AdUpdateContext,
): AdUpdatePlan {
  const params: Record<string, ParamValue> = {};
  const changes: AdUpdateChange[] = [];
  const warnings: string[] = [];
  let tier: WriteTier = 'irreversible';
  let increasesSpend = false;

  if (
    req.status === undefined &&
    req.dailyBudgetMinor === undefined &&
    req.lifetimeBudgetMinor === undefined
  ) {
    throw validationError(
      'Nothing to change: pass `status` (ACTIVE or PAUSED) and/or a budget in minor units (`daily_budget_minor` or `lifetime_budget_minor`).',
    );
  }

  // CC-ADS-4 — archived/deleted objects are read-only, refused before the wire.
  const effective = currentString(ctx.current, 'effective_status');
  const configured = currentString(ctx.current, 'status');
  const blocking = [effective, configured].find(
    (value) => value !== undefined && READ_ONLY_STATUSES.has(value),
  );
  if (blocking !== undefined) {
    throw validationError(
      `${req.objectId} is ${blocking} and is read-only: archived and deleted ads objects cannot be edited or resumed through the API. Nothing was changed. Restore it in Ads Manager first.`,
    );
  }

  if (req.status !== undefined) {
    const status = resolveSettableStatus(req.status);
    if (configured === status) {
      warnings.push(
        `Status is already ${status}; applying will re-send it, which is harmless but changes nothing.`,
      );
    }
    params.status = status;
    changes.push({
      kind: 'status',
      field: 'status',
      ...(configured !== undefined ? { from: configured } : {}),
      to: status,
    });
    if (status === 'ACTIVE') {
      // A resume can start spending money again ⇒ the higher tier.
      tier = higherTier(tier, 'spend');
      increasesSpend = true;
      warnings.push(RESUME_NOT_DELIVERY_NOTE);
    }
  }

  if (req.dailyBudgetMinor !== undefined && req.lifetimeBudgetMinor !== undefined) {
    throw validationError(
      'Set either `daily_budget_minor` or `lifetime_budget_minor`, not both — an object carries one budget kind, and sending both makes the result ambiguous.',
    );
  }

  const budgets: readonly (readonly [string, number | undefined])[] = [
    ['daily_budget', req.dailyBudgetMinor],
    ['lifetime_budget', req.lifetimeBudgetMinor],
  ];

  for (const [field, requested] of budgets) {
    if (requested === undefined) continue;
    const argName = `${field}_minor`;
    validateBudgetMinor(argName, requested);

    if (req.level !== undefined && !BUDGET_LEVELS.has(req.level)) {
      throw validationError(
        `An ad has no budget of its own: set \`${argName}\` on its ad set (or on the campaign when campaign budget optimisation is on).`,
      );
    }

    const current = currentMinor(ctx.current, field);
    if (ctx.budgetCeilingMinor !== undefined) {
      enforceCeiling({
        field: argName,
        requested,
        current,
        ceiling: ctx.budgetCeilingMinor,
        currency: ctx.currency,
        objectId: req.objectId,
      });
    }

    params[field] = requested;
    changes.push({
      kind: 'budget',
      field,
      ...(current !== undefined ? { from: current } : {}),
      to: requested,
    });
    warnings.push(BUDGET_OVERWRITE_NOTE);
    if (req.level === 'adset') warnings.push(CBO_CONFLICT_NOTE);
    if (field === 'lifetime_budget' && ctx.current.end_time === undefined) {
      warnings.push(LIFETIME_NEEDS_END_NOTE);
    }
    if (current === undefined || requested > current) {
      // Unknown current value is treated as a raise: assume the costlier reading.
      tier = higherTier(tier, 'spend');
      increasesSpend = true;
    }
    if (current !== undefined && requested === current) {
      warnings.push(
        `\`${argName}\` is already ${formatMinor(current, ctx.currency)}; applying changes nothing.`,
      );
    }
  }

  return {
    objectId: req.objectId,
    ...(req.level !== undefined ? { level: req.level } : {}),
    params,
    changes,
    tier,
    summary: summarizePlan(req.objectId, req.level, changes, ctx.currency),
    warnings,
    ...(ctx.currency !== undefined ? { currency: ctx.currency } : {}),
    increasesSpend,
  };
}

/** One-line, value-explicit summary for the plan preview. */
export function summarizePlan(
  objectId: string,
  level: AdLevel | undefined,
  changes: readonly AdUpdateChange[],
  currency: string | undefined,
): string {
  const what = changes
    .map((change) => {
      const to =
        change.kind === 'budget' && typeof change.to === 'number'
          ? formatMinor(change.to, currency)
          : String(change.to);
      const from =
        change.from === undefined
          ? 'unknown'
          : change.kind === 'budget' && typeof change.from === 'number'
            ? formatMinor(change.from, currency)
            : String(change.from);
      return `${change.field}: ${from} -> ${to}`;
    })
    .join('; ');
  return `Update ${level ?? 'ads object'} ${objectId} — ${what}`;
}

// ---------------------------------------------------------------------------
// 6. The single write call
// ---------------------------------------------------------------------------

/** `POST /<object-id>` with the planned params. */
export function updateAdObjectRequest(
  objectId: string,
  params: Readonly<Record<string, ParamValue>>,
  signal?: AbortSignal,
): JsonRequest {
  return {
    protocol: 'json',
    method: 'POST',
    host: 'graph',
    path: `/${objectId}`,
    body: params,
    ...(signal !== undefined ? { signal } : {}),
  };
}

export interface AdUpdateOutcome {
  readonly objectId: string;
  /** Graph's `success` flag when it sent one. */
  readonly success: boolean;
  readonly applied: readonly AdUpdateChange[];
}

/**
 * Perform the planned update. Only ever called by the write gate AFTER an
 * explicit apply — never during a dry run.
 *
 * @throws the mapped Graph error; a bare 100 becomes the "gone or archived"
 *   explanation (CC-ADS-4).
 */
export async function applyAdObjectUpdate(
  fbRequest: FbRequestFn,
  plan: AdUpdatePlan,
  signal?: AbortSignal,
): Promise<AdUpdateOutcome> {
  try {
    const res = await fbRequest<unknown>(
      updateAdObjectRequest(plan.objectId, plan.params, signal),
    );
    const body: Record<string, unknown> =
      typeof res.data === 'object' && res.data !== null
        ? (res.data as Record<string, unknown>)
        : {};
    // Graph answers `{ "success": true }`; a 2xx without the flag is still a
    // success on this edge, so absence is not treated as failure.
    const success = body.success !== false;
    return { objectId: plan.objectId, success, applied: plan.changes };
  } catch (err) {
    throw mapUpdateError(err, plan.objectId);
  }
}
