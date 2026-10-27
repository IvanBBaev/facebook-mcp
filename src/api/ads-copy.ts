// Duplicate one campaign, ad set or ad into a PAUSED copy (v2 ads §7).
//
//   POST /{id}/copies  status_option=PAUSED, deep_copy, rename_options
//
// `status_option` is ALWAYS `PAUSED`: never `ACTIVE`, never
// `INHERITED_FROM_SOURCE`. No `parameter_overrides`, no schedule override and
// never `migrate_to_advantage_plus` — the copy inherits the source as-is. Even
// paused, a copy carries the source's budget, so a copy must never mint an
// object the update tool would refuse to create: the campaign in the copy tree
// needs a spend cap within `FB_ADS_CAMPAIGN_SPEND_CAP_MAX`, and every budget
// that is copied must sit within `FB_ADS_BUDGET_CEILING`.
//
// The planner is PURE: the caller reads the copy tree ({@link readCopyTree})
// and passes it in, so a refusal happens with certainty that nothing was
// created. A copy cannot be retried safely (a retry duplicates again), so an
// ambiguous answer is reconciled by the rename suffix, never by re-sending.

import { GraphApiError, classifyGraphError } from '../core/index.js';
import type { FbRequestFn, JsonRequest } from '../core/index.js';
import { MARKETING_API, getAdObject } from './ads-read.js';
import type { AdLevel, AdRecord } from './ads-read.js';
import { OUT_OF_SCOPE_ADVANTAGE_STATES, mapUpdateError } from './ads-control.js';
import {
  SPEND_CAP_REMOVAL_SENTINEL,
  describeEnvelope,
  enforceCeiling,
  enforceSpendCapMax,
  formatMinor,
  worstCaseEnvelope,
} from './ads-money.js';

// ---------------------------------------------------------------------------
// 1. Constants and shapes
// ---------------------------------------------------------------------------

/** The suffix a copy's name gets when the caller passes none. */
export const DEFAULT_RENAME_SUFFIX = ' [fbmcp copy]';

export const MAX_RENAME_SUFFIX_LENGTH = 50;

/** Meta copies at most this many ads synchronously in one deep copy. */
export const MAX_SYNC_DEEP_COPY_ADS = 3;

/** Ad sets read to check a campaign deep copy's ad-set budgets. */
export const MAX_CHECKED_ADSETS = 50;

export const COPY_PAUSED_NOTE =
  'The copy is created PAUSED; activating it is a separate spend-tier call (facebook_update_ad_object status:"ACTIVE").';

export const COPY_NO_RETRY_NOTE =
  'A copy cannot be retried safely: every retry creates another copy. If the outcome is unknown, look for the rename suffix in facebook_list_campaigns / _adsets / _ads before trying again.';

/** Fields the copy checks read, per level. */
export const COPY_FIELDS: Readonly<Record<AdLevel, string>> = {
  campaign:
    'id,name,status,effective_status,objective,daily_budget,lifetime_budget,spend_cap,start_time,stop_time,account_id,special_ad_categories,advantage_state_info',
  adset:
    'id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,start_time,end_time,account_id',
  ad: 'id,name,status,effective_status,adset_id,campaign_id,account_id',
};

/** One ad set's budgets, as read for a campaign deep copy. */
export interface AdSetBudget {
  readonly id: string;
  readonly dailyBudgetMinor?: number;
  readonly lifetimeBudgetMinor?: number;
}

/** What the planner needs to know about the tree being copied. */
export interface CopyTree {
  readonly source: AdRecord;
  /** The campaign in the tree: the source itself for a campaign copy. */
  readonly campaign: AdRecord;
  /** Child ads a deep copy would copy; undefined when not counted or unreadable. */
  readonly childAds?: number;
  /** A campaign deep copy's ad sets; undefined when not read or incomplete. */
  readonly childAdSets?: readonly AdSetBudget[];
}

export interface CopyPlanInput {
  readonly objectId: string;
  readonly level: AdLevel;
  readonly deepCopy: boolean;
  readonly renameSuffix?: string;
  readonly tree: CopyTree;
  readonly currency?: string;
  readonly budgetCeilingMinor?: number;
  readonly spendCapMaxMinor?: number;
  /** Epoch ms; the earliest the copy could start delivering. */
  readonly now: number;
}

export interface CopyPlan {
  readonly objectId: string;
  readonly level: AdLevel;
  readonly deepCopy: boolean;
  readonly renameSuffix: string;
  /** Ads a deep copy copies (0 for a shallow copy or an ad). */
  readonly childAds: number;
  /** Objects the copy creates: the copy itself plus any copied children. */
  readonly copiedCount: number;
  readonly summary: string;
  readonly warnings: readonly string[];
}

function validationError(message: string): GraphApiError {
  return new GraphApiError(message, {
    code: 100,
    httpStatus: 400,
    action: classifyGraphError({ code: 100, message }),
  });
}

function upper(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toUpperCase();
  return trimmed === '' ? undefined : trimmed;
}

function minorOf(record: AdRecord, key: string): number | undefined {
  const value: unknown = record[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function stringOf(record: AdRecord, key: string): string | undefined {
  const value: unknown = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** The normalised `advantage.state` of a campaign, upper-cased. */
function advantageStateOf(record: AdRecord): string | undefined {
  const advantage: unknown = record.advantage;
  if (typeof advantage !== 'object' || advantage === null) return undefined;
  return upper((advantage as Record<string, unknown>).state);
}

/**
 * The campaign's special ad categories, upper-cased, `NONE` dropped. Undefined
 * when the read did not carry the field.
 */
function specialCategoriesOf(campaign: AdRecord): readonly string[] | undefined {
  const raw: unknown = campaign.special_ad_categories;
  if (raw === undefined) return undefined;
  const list: readonly unknown[] = Array.isArray(raw) ? raw : [raw];
  return list
    .map((entry) => upper(entry))
    .filter((entry): entry is string => entry !== undefined && entry !== 'NONE');
}

// ---------------------------------------------------------------------------
// 2. The pure planner
// ---------------------------------------------------------------------------

function checkBudgets(
  label: string,
  record: { dailyBudgetMinor?: number; lifetimeBudgetMinor?: number },
  input: CopyPlanInput,
): void {
  if (input.budgetCeilingMinor === undefined) return;
  const pairs: readonly [string, number | undefined][] = [
    ['daily_budget', record.dailyBudgetMinor],
    ['lifetime_budget', record.lifetimeBudgetMinor],
  ];
  for (const [field, value] of pairs) {
    if (value === undefined) continue;
    // A copy is a NEW object: there is no current value it could be lowering.
    enforceCeiling({
      field: `${label} ${field}`,
      requested: value,
      current: undefined,
      ceiling: input.budgetCeilingMinor,
      currency: input.currency,
      objectId: input.objectId,
    });
  }
}

function budgetsOf(record: AdRecord): {
  dailyBudgetMinor?: number;
  lifetimeBudgetMinor?: number;
} {
  const daily = minorOf(record, 'daily_budget_minor');
  const lifetime = minorOf(record, 'lifetime_budget_minor');
  return {
    ...(daily !== undefined && daily > 0 ? { dailyBudgetMinor: daily } : {}),
    ...(lifetime !== undefined && lifetime > 0 ? { lifetimeBudgetMinor: lifetime } : {}),
  };
}

function describeBudgets(
  label: string,
  budgets: { dailyBudgetMinor?: number; lifetimeBudgetMinor?: number },
  currency: string | undefined,
): string | undefined {
  const parts: string[] = [];
  if (budgets.dailyBudgetMinor !== undefined) {
    parts.push(`daily ${formatMinor(budgets.dailyBudgetMinor, currency)}`);
  }
  if (budgets.lifetimeBudgetMinor !== undefined) {
    parts.push(`lifetime ${formatMinor(budgets.lifetimeBudgetMinor, currency)}`);
  }
  return parts.length === 0 ? undefined : `${label} budget: ${parts.join(', ')}.`;
}

function instantOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Plan a copy. Refuses locally: a deleted source; a campaign with special ad
 * categories or an Advantage+ shopping/app state; a campaign without a spend
 * cap or with one above `FB_ADS_CAMPAIGN_SPEND_CAP_MAX`; any copied budget
 * above `FB_ADS_BUDGET_CEILING`; a deep copy of an ad, or one whose children
 * could not be counted or exceed the synchronous limit.
 */
export function planCopy(input: CopyPlanInput): CopyPlan {
  const { tree, level, objectId } = input;
  const suffix = input.renameSuffix ?? DEFAULT_RENAME_SUFFIX;
  if (suffix.length > MAX_RENAME_SUFFIX_LENGTH) {
    throw validationError(
      `\`rename_suffix\` is ${String(suffix.length)} characters; at most ${String(MAX_RENAME_SUFFIX_LENGTH)} are allowed.`,
    );
  }
  if (suffix.trim() === '') {
    throw validationError(
      '`rename_suffix` must contain visible text: it is how a copy is told apart from its source and found again after an ambiguous outcome.',
    );
  }

  const status = upper(tree.source.status);
  const effective = upper(tree.source.effective_status);
  if (status === 'DELETED' || effective === 'DELETED') {
    throw validationError(
      `${objectId} is deleted; a deleted object cannot be copied. Nothing was created.`,
    );
  }

  if (input.deepCopy && level === 'ad') {
    throw validationError(
      '`deep_copy` applies to a campaign or an ad set: an ad has no children. Nothing was created.',
    );
  }

  const campaign = tree.campaign;
  const campaignId = campaign.id;

  const categories = specialCategoriesOf(campaign);
  if (categories !== undefined && categories.length > 0) {
    throw validationError(
      `Campaign ${campaignId} has special ad categories (${categories.join(', ')}); copying special-category campaigns is out of scope for this server. Nothing was created. Copy it in Ads Manager.`,
    );
  }
  const advantage = advantageStateOf(campaign);
  if (advantage !== undefined && OUT_OF_SCOPE_ADVANTAGE_STATES.has(advantage)) {
    throw validationError(
      `Campaign ${campaignId} is an Advantage+ ${advantage === 'ADVANTAGE_PLUS_APP' ? 'app' : 'shopping'} campaign (${advantage}): Advantage+ shopping/app campaigns are out of scope for this server. Nothing was created. Copy it in Ads Manager.`,
    );
  }

  const spendCap = minorOf(campaign, 'spend_cap_minor');
  if (spendCap === undefined || spendCap <= 0 || spendCap >= SPEND_CAP_REMOVAL_SENTINEL) {
    throw validationError(
      `Refused: campaign ${campaignId} has no spend cap, so a copy would be bounded only by its budgets. Nothing was created. Set a spend cap on it first (facebook_update_ad_object spend_cap_minor), then copy.`,
    );
  }
  enforceSpendCapMax({
    field: `campaign ${campaignId} spend_cap`,
    requested: spendCap,
    current: undefined,
    max: input.spendCapMaxMinor,
    currency: input.currency,
    objectId,
  });

  // The budgets the copy carries. A shallow campaign copy copies only the
  // campaign; an ad copy copies no budget at all.
  const campaignBudgets = budgetsOf(campaign);
  const sourceBudgets = level === 'adset' ? budgetsOf(tree.source) : undefined;
  if (level === 'campaign')
    checkBudgets(`campaign ${campaignId}`, campaignBudgets, input);
  if (sourceBudgets !== undefined)
    checkBudgets(`ad set ${objectId}`, sourceBudgets, input);

  let childAds = 0;
  if (input.deepCopy) {
    if (tree.childAds === undefined) {
      throw validationError(
        `Refused: the ads under ${objectId} could not be counted, so the synchronous deep-copy limit (${String(MAX_SYNC_DEEP_COPY_ADS)} ads) cannot be checked. Nothing was created. Retry, or copy without deep_copy.`,
      );
    }
    if (tree.childAds > MAX_SYNC_DEEP_COPY_ADS) {
      throw validationError(
        `Refused: ${objectId} has ${String(tree.childAds)} ads; a deep copy here copies at most ${String(MAX_SYNC_DEEP_COPY_ADS)}. Nothing was created. Copy it in Ads Manager, or copy its ad sets individually.`,
      );
    }
    childAds = tree.childAds;
    if (level === 'campaign') {
      if (tree.childAdSets === undefined) {
        throw validationError(
          `Refused: the ad sets under campaign ${objectId} could not all be read, so their budgets cannot be checked against FB_ADS_BUDGET_CEILING. Nothing was created. Retry, or copy without deep_copy.`,
        );
      }
      for (const adset of tree.childAdSets)
        checkBudgets(`ad set ${adset.id}`, adset, input);
    }
  }

  // Preview: what money the copy could spend once someone activates it.
  const warnings: string[] = [];
  const budgetLines = [
    describeBudgets(`Campaign ${campaignId}`, campaignBudgets, input.currency),
    sourceBudgets !== undefined
      ? describeBudgets(`Ad set ${objectId}`, sourceBudgets, input.currency)
      : undefined,
  ].filter((line): line is string => line !== undefined);
  if (input.deepCopy && level === 'campaign' && tree.childAdSets !== undefined) {
    for (const adset of tree.childAdSets) {
      const line = describeBudgets(`Ad set ${adset.id}`, adset, input.currency);
      if (line !== undefined) budgetLines.push(line);
    }
  }
  warnings.push(...budgetLines);
  warnings.push(
    `Campaign ${campaignId} spend cap: ${formatMinor(spendCap, input.currency)} — ${level === 'campaign' ? 'the copy carries it' : 'the copy lands under this campaign and shares its cap'}.`,
  );

  const envelopeBudget =
    level === 'campaign'
      ? campaignBudgets
      : sourceBudgets !== undefined &&
          (sourceBudgets.dailyBudgetMinor !== undefined ||
            sourceBudgets.lifetimeBudgetMinor !== undefined)
        ? sourceBudgets
        : campaignBudgets;
  const startMs = instantOf(
    stringOf(level === 'adset' ? tree.source : campaign, 'start_time'),
  );
  const endMs = instantOf(
    level === 'adset'
      ? stringOf(tree.source, 'end_time')
      : stringOf(campaign, 'stop_time'),
  );
  const start = Math.max(startMs ?? input.now, input.now);
  const scheduleEnded = endMs !== undefined && endMs <= start;
  if (scheduleEnded) {
    warnings.push(
      'The source schedule has already ended and the copy inherits it: change its dates in Ads Manager before activating the copy.',
    );
  }
  if (
    envelopeBudget.dailyBudgetMinor === undefined ||
    envelopeBudget.lifetimeBudgetMinor === undefined
  ) {
    const envelope = worstCaseEnvelope({
      ...(envelopeBudget.dailyBudgetMinor !== undefined
        ? { dailyBudgetMinor: envelopeBudget.dailyBudgetMinor }
        : {}),
      ...(envelopeBudget.lifetimeBudgetMinor !== undefined
        ? { lifetimeBudgetMinor: envelopeBudget.lifetimeBudgetMinor }
        : {}),
      startTime: start,
      ...(endMs !== undefined && !scheduleEnded ? { endTime: endMs } : {}),
      spendCapMinor: spendCap,
    });
    warnings.push(
      ...describeEnvelope(envelope, input.currency).map(
        (line) => `If activated: ${line}`,
      ),
    );
  }

  if (input.deepCopy) {
    warnings.push(
      level === 'campaign'
        ? `Deep copy: the campaign's ${String(tree.childAdSets?.length ?? 0)} ad sets and ${String(childAds)} ads are copied with it, all PAUSED.`
        : `Deep copy: the ad set's ${String(childAds)} ads are copied with it, all PAUSED.`,
    );
  } else if (level !== 'ad') {
    warnings.push(
      `Shallow copy: only the ${level === 'campaign' ? 'campaign' : 'ad set'} itself is copied; pass deep_copy:true to copy its children too.`,
    );
  }
  if (status === 'ARCHIVED' || effective === 'ARCHIVED') {
    warnings.push(
      'The source is archived; whether Meta allows copying it is unverified (PROBE). If the copy is refused, nothing was created.',
    );
  }
  if (categories === undefined) {
    warnings.push(
      `Campaign ${campaignId}'s special ad categories were not returned by the read; this copy assumes NONE.`,
    );
  }
  warnings.push(COPY_PAUSED_NOTE, COPY_NO_RETRY_NOTE);

  const name = stringOf(tree.source, 'name');
  const summary =
    `Copy ${level} ${objectId}${name !== undefined ? ` "${name}"` : ''}` +
    `${input.deepCopy ? ' with its children' : ''} into a PAUSED copy named with the suffix "${suffix}".`;

  return {
    objectId,
    level,
    deepCopy: input.deepCopy,
    renameSuffix: suffix,
    childAds,
    copiedCount:
      1 +
      (input.deepCopy
        ? childAds + (level === 'campaign' ? (tree.childAdSets?.length ?? 0) : 0)
        : 0),
    summary,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 3. Reads behind the plan
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function totalCountOf(body: unknown): number | undefined {
  if (!isRecord(body) || !isRecord(body.summary)) return undefined;
  const total: unknown = body.summary.total_count;
  return typeof total === 'number' && Number.isInteger(total) && total >= 0
    ? total
    : undefined;
}

async function countAds(
  fbRequest: FbRequestFn,
  objectId: string,
  signal?: AbortSignal,
): Promise<number | undefined> {
  try {
    const res = await fbRequest<unknown>({
      protocol: 'json',
      method: 'GET',
      host: 'graph',
      api: MARKETING_API,
      path: `/${objectId}/ads`,
      params: { summary: 'total_count', limit: 0 },
      ...(signal !== undefined ? { signal } : {}),
    });
    return totalCountOf(res.data);
  } catch (err) {
    if (signal?.aborted === true) throw err;
    return undefined;
  }
}

function minorField(value: unknown): number | undefined {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return undefined;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * Every ad set of a campaign with its budgets. Undefined when the read failed,
 * could not be parsed, or the campaign has more ad sets than one page holds —
 * an unchecked budget is not a checked one.
 */
async function readAdSetBudgets(
  fbRequest: FbRequestFn,
  campaignId: string,
  signal?: AbortSignal,
): Promise<readonly AdSetBudget[] | undefined> {
  try {
    const res = await fbRequest<unknown>({
      protocol: 'json',
      method: 'GET',
      host: 'graph',
      api: MARKETING_API,
      path: `/${campaignId}/adsets`,
      params: {
        fields: 'id,daily_budget,lifetime_budget',
        summary: 'total_count',
        limit: MAX_CHECKED_ADSETS,
      },
      ...(signal !== undefined ? { signal } : {}),
    });
    const body = res.data;
    if (!isRecord(body) || !Array.isArray(body.data)) return undefined;
    const total = totalCountOf(body);
    if (total === undefined || total > body.data.length) return undefined;
    const out: AdSetBudget[] = [];
    for (const row of body.data as unknown[]) {
      if (!isRecord(row)) return undefined;
      const id: unknown = row.id;
      if (typeof id !== 'string' || id === '') return undefined;
      const daily = minorField(row.daily_budget);
      const lifetime = minorField(row.lifetime_budget);
      out.push({
        id,
        ...(daily !== undefined ? { dailyBudgetMinor: daily } : {}),
        ...(lifetime !== undefined ? { lifetimeBudgetMinor: lifetime } : {}),
      });
    }
    return out;
  } catch (err) {
    if (signal?.aborted === true) throw err;
    return undefined;
  }
}

/**
 * Read what {@link planCopy} needs: the source, the campaign in its tree and,
 * for a deep copy, the children. The source and campaign reads throw (no plan
 * without them); the child reads are best effort and leave their field out.
 */
export async function readCopyTree(
  fbRequest: FbRequestFn,
  opts: {
    readonly objectId: string;
    readonly level: AdLevel;
    readonly deepCopy: boolean;
    readonly signal?: AbortSignal;
  },
): Promise<CopyTree> {
  const signal = opts.signal !== undefined ? { signal: opts.signal } : {};
  const source = (
    await getAdObject(fbRequest, {
      objectId: opts.objectId,
      level: opts.level,
      fields: COPY_FIELDS[opts.level],
      ...signal,
    })
  ).object;

  let campaign = source;
  if (opts.level !== 'campaign') {
    const campaignId = stringOf(source, 'campaign_id');
    if (campaignId === undefined || !/^\d+$/.test(campaignId)) {
      throw validationError(
        `Refused: the read of ${opts.objectId} did not name its campaign, so the campaign spend cap and budgets cannot be checked. Nothing was created. Check that level:"${opts.level}" is right.`,
      );
    }
    campaign = (
      await getAdObject(fbRequest, {
        objectId: campaignId,
        level: 'campaign',
        fields: COPY_FIELDS.campaign,
        ...signal,
      })
    ).object;
  }

  if (!opts.deepCopy || opts.level === 'ad') return { source, campaign };
  const childAds = await countAds(fbRequest, opts.objectId, opts.signal);
  const childAdSets =
    opts.level === 'campaign'
      ? await readAdSetBudgets(fbRequest, opts.objectId, opts.signal)
      : undefined;
  return {
    source,
    campaign,
    ...(childAds !== undefined ? { childAds } : {}),
    ...(childAdSets !== undefined ? { childAdSets } : {}),
  };
}

// ---------------------------------------------------------------------------
// 4. The write
// ---------------------------------------------------------------------------

/** `POST /{id}/copies` — `status_option` is always `PAUSED`. */
export function copyRequest(plan: CopyPlan, signal?: AbortSignal): JsonRequest {
  return {
    protocol: 'json',
    method: 'POST',
    host: 'graph',
    api: MARKETING_API,
    path: `/${plan.objectId}/copies`,
    body: {
      status_option: 'PAUSED',
      ...(plan.level !== 'ad' ? { deep_copy: plan.deepCopy } : {}),
      rename_options: {
        rename_strategy: 'DEEP_RENAME',
        rename_suffix: plan.renameSuffix,
      },
    },
    verifyTool: 'facebook_get_ad_object',
    ...(signal !== undefined ? { signal } : {}),
  };
}

export interface CopiedObject {
  readonly type: string;
  readonly source_id: string;
  readonly copied_id: string;
}

export interface CopyResult {
  /** The top-level copy; undefined when the answer did not name it. */
  readonly copiedId?: string;
  readonly copiedObjects: readonly CopiedObject[];
}

const COPIED_ID_KEY: Readonly<Record<AdLevel, string>> = {
  campaign: 'copied_campaign_id',
  adset: 'copied_adset_id',
  ad: 'copied_ad_id',
};

function idString(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return typeof value === 'string' && /^\d+$/.test(value.trim())
    ? value.trim()
    : undefined;
}

/** Parse a `/copies` answer. Unknown or malformed entries are skipped. */
export function parseCopyResult(level: AdLevel, body: unknown): CopyResult {
  if (!isRecord(body)) return { copiedObjects: [] };
  const copiedId = idString(body[COPIED_ID_KEY[level]]);
  const objects: CopiedObject[] = [];
  const raw: unknown = body.ad_object_ids;
  if (Array.isArray(raw)) {
    for (const entry of raw as unknown[]) {
      if (!isRecord(entry)) continue;
      const sourceId = idString(entry.source_id);
      const copied = idString(entry.copied_id);
      if (sourceId === undefined || copied === undefined) continue;
      const type =
        typeof entry.ad_object_type === 'string' ? entry.ad_object_type : 'unknown';
      objects.push({ type, source_id: sourceId, copied_id: copied });
    }
  }
  return { ...(copiedId !== undefined ? { copiedId } : {}), copiedObjects: objects };
}

/** One copied object whose status was not PAUSED after the copy. */
export interface RepauseRecord {
  readonly id: string;
  /** The status the read returned. */
  readonly found: string;
  /** Whether the follow-up `status=PAUSED` was confirmed. */
  readonly repaused: boolean;
}

export interface PauseVerification {
  /** Ids read back as PAUSED. */
  readonly paused: readonly string[];
  /** Ids found not PAUSED, and whether pausing them worked. */
  readonly repaused: readonly RepauseRecord[];
  /** Ids whose status could not be read. */
  readonly unreadable: readonly string[];
}

/**
 * Read each copied id's `status`; pause any that is not PAUSED (this should not
 * happen — `status_option=PAUSED` was sent). Pausing only stops delivery, so it
 * is safe to do unasked. Never throws, except on abort.
 */
export async function verifyPaused(
  fbRequest: FbRequestFn,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<PauseVerification> {
  const paused: string[] = [];
  const repaused: RepauseRecord[] = [];
  const unreadable: string[] = [];
  const sig = signal !== undefined ? { signal } : {};
  for (const id of ids) {
    let status: string | undefined;
    try {
      const res = await fbRequest<unknown>({
        protocol: 'json',
        method: 'GET',
        host: 'graph',
        api: MARKETING_API,
        path: `/${id}`,
        params: { fields: 'status' },
        ...sig,
      });
      status = isRecord(res.data) ? upper(res.data.status) : undefined;
    } catch (err) {
      if (signal?.aborted === true) throw err;
    }
    if (status === undefined) {
      unreadable.push(id);
      continue;
    }
    if (status === 'PAUSED') {
      paused.push(id);
      continue;
    }
    let ok = false;
    try {
      const res = await fbRequest<unknown>({
        protocol: 'json',
        method: 'POST',
        host: 'graph',
        api: MARKETING_API,
        path: `/${id}`,
        body: { status: 'PAUSED' },
        ...sig,
      });
      ok =
        !isRecord(res.data) ||
        res.data.success === undefined ||
        res.data.success === true;
    } catch (err) {
      if (signal?.aborted === true) throw err;
    }
    repaused.push({ id, found: status, repaused: ok });
  }
  return { paused, repaused, unreadable };
}

export interface CopyOutcome {
  readonly sourceId: string;
  readonly level: AdLevel;
  readonly deepCopy: boolean;
  readonly copiedId?: string;
  readonly copiedObjects: readonly CopiedObject[];
  readonly status: 'PAUSED';
  readonly verification: PauseVerification;
  /** Present when a copy was found not PAUSED or could not be read back. */
  readonly alert?: string;
}

/** The loud line for a verification that found anything but PAUSED copies. */
export function pauseAlert(verification: PauseVerification): string | undefined {
  const parts: string[] = [];
  for (const entry of verification.repaused) {
    parts.push(
      entry.repaused
        ? `copy ${entry.id} came back ${entry.found} and was paused again`
        : `copy ${entry.id} came back ${entry.found} and pausing it FAILED — pause it now in Ads Manager or with facebook_update_ad_object status:"PAUSED"`,
    );
  }
  if (verification.unreadable.length > 0) {
    parts.push(
      `the status of ${verification.unreadable.join(', ')} could not be read back — check it with facebook_get_ad_object`,
    );
  }
  return parts.length === 0
    ? undefined
    : `WARNING: status_option=PAUSED was sent, but ${parts.join('; ')}.`;
}

/**
 * Perform the planned copy, then verify every copy is PAUSED. Only ever called
 * by the write gate AFTER an explicit apply.
 *
 * @throws the mapped Graph error of the copy POST.
 */
export async function applyCopy(
  fbRequest: FbRequestFn,
  plan: CopyPlan,
  signal?: AbortSignal,
): Promise<CopyOutcome> {
  let body: unknown;
  try {
    body = (await fbRequest<unknown>(copyRequest(plan, signal))).data;
  } catch (err) {
    throw mapUpdateError(err, plan.objectId);
  }
  const parsed = parseCopyResult(plan.level, body);
  const ids = new Set<string>();
  if (parsed.copiedId !== undefined) ids.add(parsed.copiedId);
  for (const entry of parsed.copiedObjects) ids.add(entry.copied_id);
  const verification = await verifyPaused(fbRequest, [...ids], signal);
  const alert = pauseAlert(verification);
  return {
    sourceId: plan.objectId,
    level: plan.level,
    deepCopy: plan.deepCopy,
    ...(parsed.copiedId !== undefined ? { copiedId: parsed.copiedId } : {}),
    copiedObjects: parsed.copiedObjects,
    status: 'PAUSED',
    verification,
    ...(alert !== undefined ? { alert } : {}),
  };
}
