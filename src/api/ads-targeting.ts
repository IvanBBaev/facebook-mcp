// Narrow ad-set targeting read / edit (v2 ads §8).
//
//   * read  ⇒ `GET /{adset_id}?fields=id,name,account_id,targeting`, summarised
//             into plain terms; the raw blob rides along only on request and
//             only under RAW_TARGETING_CAP_BYTES.
//   * write ⇒ `POST /{adset_id}` `targeting=<the full current blob with only
//             geo_locations.countries / age_min / age_max replaced>`.
//
// The write is a read-modify-write of a blob this server does not fully model,
// so it is allowed only on an audience simple enough that replacing three keys
// cannot silently change anything else: no custom audiences, no detailed
// targeting, no sub-country geography, no exclusions, Advantage+ audience off.
// Every other key is carried over byte-identical, with one exception: an
// unset `targeting_automation.advantage_audience` is written explicitly as 0,
// because from Graph v23 Meta may default an absent value to 1 (audience
// expansion on). The planner is PURE; the reads it needs are made by the caller.

import { createHash } from 'node:crypto';

import { GraphApiError, classifyGraphError } from '../core/index.js';
import type { ErrorAction, FbRequestFn, JsonRequest } from '../core/index.js';
import { MARKETING_API } from './ads-read.js';
import { confirmsAdUpdate, mapUpdateError } from './ads-control.js';

// ---------------------------------------------------------------------------
// 1. Constants and shapes
// ---------------------------------------------------------------------------

export const ADSET_TARGETING_FIELDS = 'id,name,account_id,targeting';

/** Above this size the raw blob is never returned, only the summary. */
export const RAW_TARGETING_CAP_BYTES = 64 * 1024;

export const MAX_TARGETING_COUNTRIES = 25;
export const MIN_TARGETING_AGE = 13;
export const MAX_TARGETING_AGE = 65;

export const TOO_COMPLEX_MESSAGE =
  "This ad set's audience is more complex than this tool edits; change it in Ads Manager.";

export const LEARNING_PHASE_NOTE =
  'Changing the audience can reset the learning phase; delivery and cost per result may fluctuate for a few days.';

export const DELIVERY_IMPACT_NOTE =
  'A narrower audience can lower reach or raise costs; a wider one spends the same budget over more people. The budget itself is unchanged.';

/** Member states of the EU, where adding targeting needs DSA payor / beneficiary info. */
export const EU_COUNTRIES: ReadonlySet<string> = new Set([
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
]);

/** The only `geo_locations` keys an editable audience may carry. */
const SIMPLE_GEO_KEYS: ReadonlySet<string> = new Set(['countries', 'location_types']);

/** Top-level keys that make up detailed targeting. */
const DETAILED_KEYS: readonly string[] = [
  'flexible_spec',
  'interests',
  'behaviors',
  'demographics',
  'life_events',
  'industries',
  'income',
  'family_statuses',
  'relationship_statuses',
  'education_schools',
  'education_majors',
  'education_statuses',
  'work_employers',
  'work_positions',
  'college_years',
  'user_adclusters',
];

/** Top-level keys that exclude people or places. */
const EXCLUSION_KEYS: readonly string[] = [
  'exclusions',
  'excluded_geo_locations',
  'excluded_custom_audiences',
  'excluded_connections',
];

export type Targeting = Readonly<Record<string, unknown>>;

/** Advantage+ audience as stored; `unset` when the blob does not carry it. */
export type AdvantageAudienceState = 'on' | 'off' | 'unset';

export interface AdSetTargetingRead {
  readonly id: string;
  readonly name?: string;
  readonly accountId?: string;
  readonly targeting: Targeting;
}

export interface TargetingSummary {
  readonly countries: readonly string[];
  readonly regions_count: number;
  readonly cities_count: number;
  readonly age_min: number | null;
  readonly age_max: number | null;
  readonly genders: readonly number[];
  readonly locales_count: number;
  readonly advantage_audience: boolean | null;
  /** The same as a tri-state: `unset` means Meta may default it on (v23+). */
  readonly advantage_audience_state: AdvantageAudienceState;
  readonly has_detailed_targeting: boolean;
  readonly has_custom_audiences: boolean;
  readonly has_exclusions: boolean;
  readonly publisher_platforms: readonly string[];
  readonly editable_by_this_server: boolean;
  /** Why it is not editable; empty when it is. */
  readonly not_editable_because: readonly string[];
}

function validationError(message: string): GraphApiError {
  return new GraphApiError(message, {
    code: 100,
    httpStatus: 400,
    action: classifyGraphError({ code: 100, message }),
  });
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}

function age(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) ? n : null;
}

// ---------------------------------------------------------------------------
// 2. The summariser and the refusal matrix
// ---------------------------------------------------------------------------

/** The countries an audience targets, upper-cased, in Graph's order. */
export function targetingCountries(targeting: Targeting): readonly string[] {
  return strings(asRecord(targeting.geo_locations)?.countries).map((c) =>
    c.toUpperCase(),
  );
}

function advantageAudience(targeting: Targeting): boolean | null {
  const raw = asRecord(targeting.targeting_automation)?.advantage_audience;
  if (raw === 1 || raw === '1' || raw === true) return true;
  if (raw === 0 || raw === '0' || raw === false) return false;
  return null;
}

/** {@link advantageAudience} as a tri-state; `unset` covers an unreadable value too. */
export function advantageAudienceState(targeting: Targeting): AdvantageAudienceState {
  const on = advantageAudience(targeting);
  return on === null ? 'unset' : on ? 'on' : 'off';
}

/**
 * Why a read-modify-write of this blob could drop or change something this
 * server does not model. Empty means the narrow edit is safe.
 */
export function complexityReasons(targeting: Targeting): readonly string[] {
  const reasons: string[] = [];
  if (nonEmpty(targeting.custom_audiences)) reasons.push('custom audiences');
  if (DETAILED_KEYS.some((key) => nonEmpty(targeting[key]))) {
    reasons.push('detailed targeting');
  }
  const geo = asRecord(targeting.geo_locations);
  const otherGeo = Object.keys(geo ?? {}).filter(
    (key) => !SIMPLE_GEO_KEYS.has(key) && nonEmpty(geo?.[key]),
  );
  if (otherGeo.length > 0) {
    reasons.push(`locations other than whole countries (${otherGeo.join(', ')})`);
  }
  if (EXCLUSION_KEYS.some((key) => nonEmpty(targeting[key]))) reasons.push('exclusions');
  if (advantageAudience(targeting) === true) reasons.push('Advantage+ audience on');
  return reasons;
}

export function isNarrowEditable(targeting: Targeting): boolean {
  return complexityReasons(targeting).length === 0;
}

export function summarizeTargeting(targeting: Targeting): TargetingSummary {
  const geo = asRecord(targeting.geo_locations);
  const reasons = complexityReasons(targeting);
  return {
    countries: targetingCountries(targeting),
    regions_count: count(geo?.regions),
    cities_count: count(geo?.cities),
    age_min: age(targeting.age_min),
    age_max: age(targeting.age_max),
    genders: Array.isArray(targeting.genders)
      ? targeting.genders.filter((g): g is number => typeof g === 'number')
      : [],
    locales_count: count(targeting.locales),
    advantage_audience: advantageAudience(targeting),
    advantage_audience_state: advantageAudienceState(targeting),
    has_detailed_targeting: DETAILED_KEYS.some((key) => nonEmpty(targeting[key])),
    has_custom_audiences: nonEmpty(targeting.custom_audiences),
    has_exclusions: EXCLUSION_KEYS.some((key) => nonEmpty(targeting[key])),
    publisher_platforms: strings(targeting.publisher_platforms),
    editable_by_this_server: reasons.length === 0,
    not_editable_because: reasons,
  };
}

/** UTF-8 size of the blob as Graph would send it back. */
export function targetingBytes(targeting: Targeting): number {
  return Buffer.byteLength(JSON.stringify(targeting), 'utf8');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const record = asRecord(value);
  if (record === undefined) return value;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonical(record[key])]),
  );
}

/** Key-order-insensitive SHA-256 of the blob: the divergence snapshot. */
export function targetingFingerprint(targeting: Targeting): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(targeting)))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// 3. The pure planner
// ---------------------------------------------------------------------------

export interface TargetingEditRequest {
  readonly countries?: readonly string[];
  readonly ageMin?: number;
  readonly ageMax?: number;
}

export interface TargetingEditPlan {
  readonly next: Targeting;
  readonly before: {
    readonly countries: readonly string[];
    readonly ageMin: number | null;
    readonly ageMax: number | null;
  };
  readonly after: {
    readonly countries: readonly string[];
    readonly ageMin: number | null;
    readonly ageMax: number | null;
  };
  readonly changedFields: readonly ('countries' | 'age_min' | 'age_max')[];
  /** EU countries this edit adds to an audience that had none. */
  readonly euAdded: readonly string[];
  /** Advantage+ audience was unset and the edit writes it explicitly as 0. */
  readonly advantageAudienceSetOff: boolean;
}

/** Upper-case and de-duplicate, keeping the caller's order. */
export function normalizeCountries(countries: readonly string[]): readonly string[] {
  return [...new Set(countries.map((c) => c.trim().toUpperCase()))];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((c) => b.includes(c));
}

/**
 * Plan the narrow edit. Refuses an audience that is too complex, a no-op, an
 * age range that inverts, and an audience left with no country.
 */
export function planTargetingEdit(
  current: Targeting,
  request: TargetingEditRequest,
): TargetingEditPlan {
  const reasons = complexityReasons(current);
  if (reasons.length > 0) {
    throw validationError(
      `Refused: ${TOO_COMPLEX_MESSAGE} It has ${reasons.join(', ')}.`,
    );
  }

  const beforeCountries = targetingCountries(current);
  const beforeMin = age(current.age_min);
  const beforeMax = age(current.age_max);

  const afterCountries =
    request.countries !== undefined
      ? normalizeCountries(request.countries)
      : beforeCountries;
  const afterMin = request.ageMin ?? beforeMin;
  const afterMax = request.ageMax ?? beforeMax;

  if (afterCountries.length === 0) {
    throw validationError(
      'Refused: the audience would have no country. Pass at least one ISO-2 country code.',
    );
  }
  if (afterMin !== null && afterMax !== null && afterMin > afterMax) {
    throw validationError(
      `Refused: age_min ${String(afterMin)} would be above age_max ${String(afterMax)}.`,
    );
  }

  const changedFields: ('countries' | 'age_min' | 'age_max')[] = [];
  if (!sameSet(afterCountries, beforeCountries)) changedFields.push('countries');
  if (afterMin !== beforeMin) changedFields.push('age_min');
  if (afterMax !== beforeMax) changedFields.push('age_max');
  if (changedFields.length === 0) {
    throw validationError(
      'Nothing to change: the ad set already targets these countries and ages.',
    );
  }

  // Replace only the three keys; every other key keeps its value and position.
  const next: Record<string, unknown> = { ...current };
  if (changedFields.includes('countries')) {
    next.geo_locations = {
      ...asRecord(current.geo_locations),
      countries: [...afterCountries],
    };
  }
  if (changedFields.includes('age_min')) next.age_min = afterMin;
  if (changedFields.includes('age_max')) next.age_max = afterMax;
  // An absent value may default to 1 on write (v23+); pin it off explicitly.
  const advantageAudienceSetOff = advantageAudienceState(current) === 'unset';
  if (advantageAudienceSetOff) {
    next.targeting_automation = {
      ...asRecord(current.targeting_automation),
      advantage_audience: 0,
    };
  }

  const hadEu = beforeCountries.some((c) => EU_COUNTRIES.has(c));
  const euAdded = hadEu ? [] : afterCountries.filter((c) => EU_COUNTRIES.has(c));

  return {
    next,
    before: { countries: beforeCountries, ageMin: beforeMin, ageMax: beforeMax },
    after: { countries: afterCountries, ageMin: afterMin, ageMax: afterMax },
    changedFields,
    euAdded,
    advantageAudienceSetOff,
  };
}

function ageRange(min: number | null, max: number | null): string {
  return `${min === null ? '?' : String(min)}–${max === null ? '?' : String(max)}`;
}

export function targetingEditSummary(adsetId: string, plan: TargetingEditPlan): string {
  const parts: string[] = [];
  if (plan.changedFields.includes('countries')) {
    parts.push(
      `countries ${plan.before.countries.join(', ') || '(none)'} → ${plan.after.countries.join(', ')}`,
    );
  }
  if (plan.changedFields.includes('age_min') || plan.changedFields.includes('age_max')) {
    parts.push(
      `ages ${ageRange(plan.before.ageMin, plan.before.ageMax)} → ${ageRange(plan.after.ageMin, plan.after.ageMax)}`,
    );
  }
  const advantage = plan.advantageAudienceSetOff
    ? ' Advantage+ audience: set explicitly OFF (was unset).'
    : '';
  return `Change the audience of ad set ${adsetId}: ${parts.join('; ')}. Everything else in its targeting is kept as is.${advantage}`;
}

// ---------------------------------------------------------------------------
// 4. Reads
// ---------------------------------------------------------------------------

/**
 * Read one ad set's targeting blob alone. A missing blob reads as `{}`, which
 * the planner then refuses for having no country.
 */
export async function readAdSetTargeting(
  fbRequest: FbRequestFn,
  adsetId: string,
  signal?: AbortSignal,
): Promise<AdSetTargetingRead> {
  const res = await fbRequest<unknown>({
    protocol: 'json',
    method: 'GET',
    host: 'graph',
    api: MARKETING_API,
    path: `/${adsetId}`,
    params: { fields: ADSET_TARGETING_FIELDS },
    ...(signal !== undefined ? { signal } : {}),
  });
  const body = asRecord(res.data) ?? {};
  const name = typeof body.name === 'string' ? body.name : undefined;
  const rawAccount = body.account_id;
  const accountId =
    typeof rawAccount === 'string' || typeof rawAccount === 'number'
      ? String(rawAccount)
      : undefined;
  return {
    id: typeof body.id === 'string' ? body.id : adsetId,
    ...(name !== undefined ? { name } : {}),
    ...(accountId !== undefined ? { accountId } : {}),
    targeting: asRecord(body.targeting) ?? {},
  };
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Whether DSA payor and beneficiary are known for the ad set: on the ad set
 * itself, or as the ad account's defaults. Best effort — a read that fails
 * counts as "not set", so the edit is refused rather than sent blind.
 */
export async function hasDsaInfo(
  fbRequest: FbRequestFn,
  adsetId: string,
  accountId: string | undefined,
  signal?: AbortSignal,
): Promise<boolean> {
  const read = async (path: string, fields: string): Promise<Record<string, unknown>> => {
    try {
      const res = await fbRequest<unknown>({
        protocol: 'json',
        method: 'GET',
        host: 'graph',
        api: MARKETING_API,
        path,
        params: { fields },
        ...(signal !== undefined ? { signal } : {}),
      });
      return { ...asRecord(res.data) };
    } catch (err) {
      if (signal?.aborted === true) throw err;
      return {};
    }
  };
  const adset = await read(`/${adsetId}`, 'dsa_payor,dsa_beneficiary');
  if (hasText(adset.dsa_payor) && hasText(adset.dsa_beneficiary)) return true;
  if (accountId === undefined) return false;
  const account = await read(
    `/${accountId}`,
    'default_dsa_payor,default_dsa_beneficiary',
  );
  return hasText(account.default_dsa_payor) && hasText(account.default_dsa_beneficiary);
}

export function dsaRefusal(adsetId: string, euAdded: readonly string[]): GraphApiError {
  return validationError(
    `Refused: this edit adds EU targeting (${euAdded.join(', ')}) to ad set ${adsetId}, and ` +
      'EU ads need DSA payor and beneficiary info. Neither the ad set nor the ad account ' +
      'defaults carry it (or it could not be read). Set it in Ads Manager, then try again. ' +
      'Nothing was changed.',
  );
}

// ---------------------------------------------------------------------------
// 5. The write
// ---------------------------------------------------------------------------

export function updateTargetingRequest(
  adsetId: string,
  targeting: Targeting,
  signal?: AbortSignal,
): JsonRequest {
  return {
    protocol: 'json',
    method: 'POST',
    host: 'graph',
    api: MARKETING_API,
    path: `/${adsetId}`,
    body: { targeting },
    verifyTool: 'facebook_get_ad_set_targeting',
    ...(signal !== undefined ? { signal } : {}),
  };
}

const DSA_MESSAGE_RE = /\b(dsa|beneficiary|payor)\b/i;
const ADVANTAGE_PLUS_RE = /advantage\+|advantage plus|\basc\b|\baac\b/i;

/**
 * Restate the targeting refusals Graph is known to give. Anything else keeps
 * its own words via {@link mapUpdateError}.
 */
export function mapTargetingError(err: unknown, adsetId: string): unknown {
  if (!(err instanceof GraphApiError)) return err;
  let guidance: string | undefined;
  if (DSA_MESSAGE_RE.test(err.message)) {
    guidance =
      'Meta wants DSA payor / beneficiary info for this audience. Set it on the ad set or as the ad account default in Ads Manager, then try again.';
  } else if (ADVANTAGE_PLUS_RE.test(err.message)) {
    guidance =
      'This ad set belongs to an Advantage+ campaign, whose audience Meta manages; this server does not edit it. Change it in Ads Manager.';
  } else if (err.code === 613 || err.subcode === 4841018) {
    guidance =
      'Meta is limiting how often this ad set can be edited. Wait before trying again; do not retry in a loop.';
  }
  if (guidance === undefined) return mapUpdateError(err, adsetId);
  const action: ErrorAction = {
    ...(err.action ??
      classifyGraphError({
        code: err.code,
        ...(err.subcode !== undefined ? { error_subcode: err.subcode } : {}),
        message: err.message,
      })),
    operatorText: `${err.message} ${guidance}`,
  };
  return new GraphApiError(`${err.message} ${guidance} Nothing was changed.`, {
    code: err.code,
    ...(err.subcode !== undefined ? { subcode: err.subcode } : {}),
    ...(err.type !== undefined ? { type: err.type } : {}),
    ...(err.fbtraceId !== undefined ? { fbtraceId: err.fbtraceId } : {}),
    httpStatus: err.httpStatus,
    action,
    ...(err.userTitle !== undefined ? { userTitle: err.userTitle } : {}),
    ...(err.userMessage !== undefined ? { userMessage: err.userMessage } : {}),
    cause: err,
  });
}

export interface TargetingEditOutcome {
  readonly adsetId: string;
  readonly success: boolean;
  readonly before: TargetingEditPlan['before'];
  /** What the ad set now targets; omitted when Graph did not confirm. */
  readonly after?: TargetingEditPlan['after'];
}

/** Perform the planned edit. Only ever called by the write gate after apply. */
export async function applyTargetingEdit(
  fbRequest: FbRequestFn,
  adsetId: string,
  plan: TargetingEditPlan,
  signal?: AbortSignal,
): Promise<TargetingEditOutcome> {
  try {
    const res = await fbRequest<unknown>(
      updateTargetingRequest(adsetId, plan.next, signal),
    );
    const success = confirmsAdUpdate(res.data);
    return {
      adsetId,
      success,
      before: plan.before,
      ...(success ? { after: plan.after } : {}),
    };
  } catch (err) {
    throw mapTargetingError(err, adsetId);
  }
}
