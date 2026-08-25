// Marketing API READ plumbing (task V09, `api` layer — imports only from `core`
// and sibling `api` modules).
//
// Scope, deliberately narrow (doc 06, A12): campaign/ad-set/ad listings, a
// single-object read, and insights (sync with an automatic async fallback plus
// an explicit job-status probe). Nothing here creates, edits or deletes — the
// control half lives in `./ads-control.js`.
//
// The five things this module owns, all pure except the GET/POST calls:
//
//   1. AD-ACCOUNT ID NORMALISATION. Graph edges hang off `act_<digits>`; humans
//      and models routinely pass the bare digits, the `act_` form, or a URL
//      fragment. One normaliser, one actionable validation error naming
//      `FB_AD_ACCOUNT_ID`, so a typo never becomes a confusing Graph 400.
//   2. `effective_status` TRUTH (CC-ADS-2). `status: ACTIVE` is a CONFIGURATION,
//      not delivery. Every record carries `effective_status` plus a derived
//      `delivering` boolean and a one-line explanation of what the effective
//      status actually means (PENDING_REVIEW, CAMPAIGN_PAUSED, DISAPPROVED …),
//      because a model that reads only `status` will report a disapproved ad as
//      "running".
//   3. MINOR-UNIT BUDGETS (CC-ADS-3). Graph returns budgets as decimal STRINGS
//      of minor units ("1000" = $10.00). Those keys are replaced by integer
//      `*_minor` fields so nothing downstream is tempted to do float math on a
//      string; unparseable values are left exactly as Graph sent them.
//   4. ASYNC REPORT RUNS (CC-ADS-5). Oversized sync insights fail with error 100
//      / subcode 1487534. Rather than surfacing that as a dead end, the sync
//      path falls back to `POST /<id>/insights`, returns the `report_run_id`,
//      and a separate status probe maps `async_status` onto a small terminal-
//      state machine with polling and TIMEOUT advice. Nothing here ever sleeps
//      or loops waiting on a job.
//   5. AD-ACCOUNT HEALTH (CC-ADS-6). `account_status` / `disable_reason` are
//      decoded into labels, and a blocked account is turned into a `GraphApiError`
//      carrying the `account` error category — the shared error matrix has no
//      row that can produce it, because the signal is a successful read of a
//      field, not a Graph error.
//
// Pagination rides the shared cursor helper (`./shared.js`); usage headers
// (including `x-fb-ads-insights-throttle`) are parsed centrally by the HTTP
// client on every response and surfaced by `facebook_usage`, so this module
// adds guidance about dev-tier limits (CC-ADS-1) rather than re-parsing headers.

import { GraphApiError, classifyGraphError } from '../core/index.js';
import type { Cursor, FbRequestFn, ParamValue } from '../core/index.js';
import { fetchPage } from './shared.js';
import type { EdgeRequest } from './shared.js';

// ---------------------------------------------------------------------------
// 1. Levels, edges and field sets
// ---------------------------------------------------------------------------

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
    'id,name,status,effective_status,objective,buying_type,daily_budget,lifetime_budget,budget_remaining,spend_cap,bid_strategy,start_time,stop_time,created_time,updated_time,account_id',
  adset:
    'id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,budget_remaining,optimization_goal,billing_event,bid_strategy,bid_amount,start_time,end_time,created_time,updated_time,account_id',
  ad: 'id,name,status,effective_status,adset_id,campaign_id,created_time,updated_time,account_id,creative{id,name}',
};

/**
 * Fields read when the level is unknown. Graph object ids do not encode their
 * level, so a caller that omits `level` gets the intersection that every level
 * answers plus the parent ids that reveal what it actually is.
 */
export const AD_OBJECT_COMMON_FIELDS =
  'id,name,status,effective_status,created_time,updated_time';

/** Ad-account fields backing the health check and the currency echo. */
export const AD_ACCOUNT_FIELDS =
  'id,account_id,name,account_status,disable_reason,currency,timezone_name';

/** Explains why `targeting` / `creative` specs are absent from a detail read. */
export const OMITTED_BLOB_NOTE =
  'Ad-set `targeting` and the full ad `creative` spec are not read: either can be larger than the entire result budget. Read them directly in Ads Manager when needed.';

/** Dev-tier call-budget guidance (CC-ADS-1). */
export const ADS_RATE_LIMIT_NOTE =
  'Marketing API calls are metered per ad account and the development tier is small (roughly 300 + 40 x active ads per hour). Check headroom with facebook_usage before a polling loop; on a rate-limit error the message carries how many minutes until access returns.';

// ---------------------------------------------------------------------------
// 2. Ad-account id normalisation
// ---------------------------------------------------------------------------

const ACT_ID = /^act_\d+$/;
const DIGITS = /^\d+$/;

/** A client-side parameter error, classified through the shared matrix (code 100). */
function validationError(message: string): GraphApiError {
  return new GraphApiError(message, {
    code: 100,
    httpStatus: 400,
    action: classifyGraphError({ code: 100, message }),
  });
}

/**
 * Normalise an ad-account identifier to Graph's `act_<digits>` form. Accepts the
 * bare numeric id as well, because that is what Ads Manager shows in its UI.
 *
 * @throws GraphApiError (validation) on anything else — a Page id, a URL, or a
 *   name would otherwise reach Graph and come back as an opaque 400.
 */
export function normalizeAdAccountId(raw: string): string {
  const trimmed = raw.trim();
  const candidate = DIGITS.test(trimmed) ? `act_${trimmed}` : trimmed;
  if (!ACT_ID.test(candidate)) {
    throw validationError(
      `Invalid ad account id: "${raw}". Use the numeric account id or its \`act_<id>\` form (for example act_1234567890) — a Page id or a Business id will not work here.`,
    );
  }
  return candidate;
}

/**
 * Pick the ad account for a call: the explicit argument, else the configured
 * default. The failure message names the env var because "no ad account" is
 * almost always a configuration gap rather than a bad call.
 */
export function resolveAdAccountId(
  explicit: string | undefined,
  configured: string | undefined,
): string {
  const chosen = explicit ?? configured;
  if (chosen === undefined || chosen.trim() === '') {
    throw validationError(
      'No ad account specified. Pass `ad_account_id`, or set FB_AD_ACCOUNT_ID so the ads tools have a default.',
    );
  }
  return normalizeAdAccountId(chosen);
}

// ---------------------------------------------------------------------------
// 3. effective_status truth (CC-ADS-2)
// ---------------------------------------------------------------------------

/**
 * Model-facing pin repeated in every ads tool description. `status` is what the
 * account holder configured; `effective_status` is what Meta is actually doing
 * with the object once review, parent status and schedule are folded in.
 */
export const EFFECTIVE_STATUS_NOTE =
  '`status` is the configured setting; `effective_status` is the real delivery state after review and parent status are applied. ACTIVE in `status` does NOT mean the object is delivering — read `effective_status` and the `delivering` flag.';

/** Effective statuses under which Meta can actually deliver the object. */
const DELIVERING_STATUSES: ReadonlySet<string> = new Set(['ACTIVE']);

/**
 * One line per effective status explaining what it means for delivery. Keys are
 * the documented values; anything unknown falls back to an explicit
 * "unrecognised" line rather than being silently treated as fine.
 */
export const EFFECTIVE_STATUS_EXPLANATIONS: Readonly<Record<string, string>> = {
  ACTIVE: 'Delivering (subject to schedule, budget and parent status).',
  PAUSED: 'Paused on this object — not delivering until it is resumed.',
  DELETED: 'Deleted — read-only, cannot be edited or resumed.',
  ARCHIVED: 'Archived — read-only, cannot be edited or resumed.',
  CAMPAIGN_PAUSED:
    'The parent CAMPAIGN is paused, so this object is not delivering even though its own status may be ACTIVE. Resume the campaign, not this object.',
  ADSET_PAUSED:
    'The parent AD SET is paused, so this ad is not delivering even though its own status may be ACTIVE. Resume the ad set, not this ad.',
  PENDING_REVIEW: 'Awaiting Meta ad review — not delivering yet.',
  IN_PROCESS: 'Meta is still processing this object — not delivering yet.',
  PENDING_BILLING_INFO: 'Blocked on billing information — not delivering.',
  PREAPPROVED: 'Provisionally approved ahead of its start time — not delivering yet.',
  DISAPPROVED:
    'Rejected by ad review — not delivering. The creative or targeting must change.',
  WITH_ISSUES:
    'Delivery is restricted by a policy or setup issue (partial or stopped). Check the object in Ads Manager for the specific issue.',
  ADSET_PAUSED_BY_AD_RULE: 'Paused automatically by an ad rule — not delivering.',
};

/** True when the effective status means Meta can deliver right now (CC-ADS-2). */
export function isDelivering(effectiveStatus: string | undefined): boolean {
  return effectiveStatus !== undefined && DELIVERING_STATUSES.has(effectiveStatus);
}

/**
 * Explain the effective status, calling out the common trap explicitly: a
 * configured `ACTIVE` that is not delivering because of a parent or review.
 */
export function describeEffectiveStatus(
  effectiveStatus: string | undefined,
  configuredStatus?: string,
): string {
  if (effectiveStatus === undefined) {
    return 'Delivery state unknown: Graph returned no `effective_status` for this object (the `fields` override may have dropped it).';
  }
  const base =
    EFFECTIVE_STATUS_EXPLANATIONS[effectiveStatus] ??
    `Unrecognised effective status "${effectiveStatus}" — treat delivery as unknown and check Ads Manager.`;
  if (
    configuredStatus === 'ACTIVE' &&
    effectiveStatus !== 'ACTIVE' &&
    EFFECTIVE_STATUS_EXPLANATIONS[effectiveStatus] !== undefined
  ) {
    return `${base} Configured status is ACTIVE, so this object is NOT delivering despite its own setting.`;
  }
  return base;
}

// ---------------------------------------------------------------------------
// 4. Node normalisation (minor-unit budgets — CC-ADS-3)
// ---------------------------------------------------------------------------

/** One ads object, unknown fields passed through, `id` guaranteed present. */
export interface AdRecord {
  readonly id: string;
  /** Configured status, as Graph returned it. */
  readonly status?: string;
  /** Real delivery state (CC-ADS-2). */
  readonly effective_status?: string;
  /** Derived: whether Meta can deliver this object right now. */
  readonly delivering: boolean;
  /** Derived: what the effective status means, in one line. */
  readonly status_explanation: string;
  readonly [key: string]: unknown;
}

/** Budget keys Graph returns as minor-unit strings; rewritten to `<key>_minor`. */
const BUDGET_KEYS = [
  'daily_budget',
  'lifetime_budget',
  'budget_remaining',
  'spend_cap',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Parse a minor-unit amount Graph sent as a decimal string (or, rarely, a
 * number). Returns `undefined` for anything that is not a safe integer, so a
 * surprising value is passed through untouched instead of being rounded.
 */
export function parseMinorUnits(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : undefined;
  }
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Normalise one ads node: pass unknown fields through, guarantee a string `id`,
 * add the derived delivery truth (CC-ADS-2), and replace minor-unit budget
 * strings with integer `*_minor` fields (CC-ADS-3). `paging` is dropped — nested
 * edge paging carries the access token and must never travel further (C3).
 * The input is never mutated.
 */
export function normalizeAdNode(raw: unknown): AdRecord {
  const src: Record<string, unknown> = isRecord(raw) ? raw : {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    if (key === 'paging') continue;
    if ((BUDGET_KEYS as readonly string[]).includes(key)) continue;
    out[key] = src[key];
  }
  out.id = readString(src.id) ?? '';

  for (const key of BUDGET_KEYS) {
    if (!(key in src)) continue;
    const minor = parseMinorUnits(src[key]);
    if (minor !== undefined) {
      out[`${key}_minor`] = minor;
    } else {
      // Not an integer string — keep Graph's value verbatim rather than invent one.
      out[key] = src[key];
    }
  }

  const effective = readString(src.effective_status);
  const configured = readString(src.status);
  out.delivering = isDelivering(effective);
  out.status_explanation = describeEffectiveStatus(effective, configured);

  return out as AdRecord;
}

/**
 * Normalise one INSIGHTS row. An insights row is a bag of metrics, not an ads
 * object: it has no `id`, no `status` and no `effective_status`, so running it
 * through {@link normalizeAdNode} would stamp it with `id: ''` and
 * `delivering: false` — labelling a row that is itself proof of delivery
 * ("12000 impressions, 48.10 spent") as not delivering. Metrics pass through
 * untouched; only `paging` is dropped, because nested edge paging carries the
 * access token and must never travel further (C3).
 */
export function normalizeInsightsRow(raw: unknown): AdRecord {
  const src: Record<string, unknown> = isRecord(raw) ? raw : {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    if (key === 'paging') continue;
    out[key] = src[key];
  }
  return out as AdRecord;
}

/**
 * Fields this module's own contract depends on, whatever the caller asked for.
 * `effective_status` is declared non-negotiable on every level (CC-ADS-2) and
 * every record is documented as carrying a derived `delivering` flag — but
 * `fields` is caller-supplied, so without pinning, `fields:'id,name,status'`
 * silently strips the evidence and every record comes back `delivering: false`.
 * Reporting a running ad as stopped is the exact failure CC-ADS-2 exists to
 * prevent, so the field is pinned on the request rather than hoped for. `status`
 * rides along because the explanation needs the configured value to call out the
 * ACTIVE-but-not-delivering trap, and `id` because the record guarantees one.
 */
export const PINNED_AD_FIELDS = ['id', 'status', 'effective_status'] as const;

/** Union a caller-supplied `fields` list with {@link PINNED_AD_FIELDS}. */
export function withPinnedAdFields(fields: string): string {
  const pinned = [...PINNED_AD_FIELDS];
  if (fields.trim() === '') return pinned.join(',');
  // Nested selections (`creative{id,name}`) are stripped before the membership
  // test, so an inner `id` is not mistaken for the top-level one.
  const present = new Set(
    fields
      .replace(/\{[^}]*\}/g, '')
      .split(',')
      .map((field) => field.trim())
      .filter((field) => field !== ''),
  );
  const missing = pinned.filter((field) => !present.has(field));
  return missing.length === 0 ? fields : `${fields},${missing.join(',')}`;
}

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
interface AdPagedResult {
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
  /** True when at least one object carries a budget (drives the currency echo). */
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

// ---------------------------------------------------------------------------
// 6. Listings and single-object reads
// ---------------------------------------------------------------------------

function adsEdge(
  path: string,
  params: Record<string, ParamValue>,
  opts: AdsRequestOptions,
): EdgeRequest {
  return {
    host: 'graph',
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
  if (opts.effectiveStatus !== undefined && opts.effectiveStatus.length > 0) {
    // Graph expects a JSON array literal for this filter.
    params.effective_status = JSON.stringify([...opts.effectiveStatus]);
  }

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
  if (objects.length === 0 && !page.truncated) {
    notes.push(
      opts.effectiveStatus === undefined
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
  /** Operator-facing explanation; always present. */
  readonly summary: string;
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
 * is not evidence of a problem, and Graph will reject the write if it is.
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
  if (info.serving) return;
  if (info.atRisk && intent.stopsDelivery === true) return;
  throw adAccountBlockedError(info);
}

// ---------------------------------------------------------------------------
// 8. Insights — sync, with an async report-run fallback (CC-ADS-5)
// ---------------------------------------------------------------------------

/** Default insights fields: spend plus the four numbers every report starts from. */
export const ADS_INSIGHTS_DEFAULT_FIELDS =
  'impressions,clicks,spend,reach,cpc,ctr,date_start,date_stop';

/** Hard row cap for one insights read, sized to stay inside the result budget. */
export const ADS_INSIGHTS_MAX_ROWS = 200;

/** Graph's "this query is too large for a synchronous read" subcode. */
export const OVERSIZED_SYNC_SUBCODE = 1487534;

/** A `report_run_id` is only resolvable for 30 days after the run started. */
export const REPORT_RUN_TTL_DAYS = 30;

/** How long a run may sit without finishing before the advice turns into "give up". */
export const REPORT_STALL_MS = 15 * 60 * 1000;

/** Suggested wait between two status probes — polling is metered (CC-ADS-1). */
export const REPORT_POLL_INTERVAL_MS = 10_000;

/** True when Graph rejected a sync insights read purely for being too large. */
export function isOversizedSyncError(err: unknown): boolean {
  return (
    err instanceof GraphApiError &&
    err.code === 100 &&
    err.subcode === OVERSIZED_SYNC_SUBCODE
  );
}

export interface AdsInsightsQuery {
  /** `act_<id>` or a campaign / ad set / ad id. */
  readonly objectId: string;
  /** Aggregation level Graph reports at. */
  readonly level?: 'account' | 'campaign' | 'adset' | 'ad';
  readonly fields?: string;
  /** Graph date preset (e.g. `last_7d`). Ignored when `since`/`until` are given. */
  readonly datePreset?: string;
  readonly since?: string;
  readonly until?: string;
  readonly breakdowns?: readonly string[];
  /** `1` for a daily series, `all_days` for one aggregate row. */
  readonly timeIncrement?: string;
}

export interface AdsInsightsOptions extends AdsRequestOptions, AdsInsightsQuery {
  readonly limit?: number;
  readonly after?: Cursor;
  readonly maxRows?: number;
  /** True ⇒ skip the sync attempt and start an async report run immediately. */
  readonly forceAsync?: boolean;
}

export interface AdsInsightsResult extends AdPagedResult {
  readonly mode: 'sync' | 'async';
  readonly objectId: string;
  /** Present in `sync` mode; absent when an async run was started instead. */
  readonly rows?: readonly AdRecord[];
  readonly rowCount?: number;
  /** Present in `async` mode — poll it with the report-status tool. */
  readonly reportRunId?: string;
  readonly notes: readonly string[];
}

function insightsParams(query: AdsInsightsQuery): Record<string, ParamValue> {
  const params: Record<string, ParamValue> = {
    fields: query.fields ?? ADS_INSIGHTS_DEFAULT_FIELDS,
  };
  if (query.level !== undefined) params.level = query.level;
  if (query.since !== undefined || query.until !== undefined) {
    // Graph takes the window as a JSON object literal; a lone end is invalid.
    if (query.since === undefined || query.until === undefined) {
      throw validationError(
        'Insights window incomplete: pass BOTH `since` and `until` (YYYY-MM-DD), or neither and use `date_preset` instead.',
      );
    }
    params.time_range = JSON.stringify({ since: query.since, until: query.until });
  } else if (query.datePreset !== undefined) {
    params.date_preset = query.datePreset;
  }
  if (query.breakdowns !== undefined && query.breakdowns.length > 0) {
    params.breakdowns = query.breakdowns.join(',');
  }
  if (query.timeIncrement !== undefined) params.time_increment = query.timeIncrement;
  return params;
}

function capRows(
  rows: readonly AdRecord[],
  maxRows: number,
): {
  readonly kept: readonly AdRecord[];
  readonly note?: string;
} {
  if (rows.length <= maxRows) return { kept: rows };
  return {
    kept: rows.slice(0, maxRows),
    note: `Row cap reached: kept the first ${String(maxRows)} of ${String(rows.length)} rows. Narrow the window, drop a breakdown, or set time_increment=all_days for totals.`,
  };
}

/**
 * Start an async report run and return its id. This is the escape hatch for
 * queries Graph refuses to answer synchronously (CC-ADS-5); the run is polled
 * with {@link getReportRunStatus} and read with {@link fetchReportResults}.
 */
export async function startAdsReport(
  fbRequest: FbRequestFn,
  opts: AdsRequestOptions & AdsInsightsQuery,
): Promise<string> {
  const res = await fbRequest<unknown>({
    protocol: 'json',
    method: 'POST',
    host: 'graph',
    path: `/${opts.objectId}/insights`,
    body: insightsParams(opts),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  const body: Record<string, unknown> = isRecord(res.data) ? res.data : {};
  const raw = body.report_run_id;
  const id = typeof raw === 'number' ? String(raw) : readString(raw);
  if (id === undefined || id === '') {
    throw new GraphApiError(
      'Async insights run was accepted but Graph returned no `report_run_id`, so there is nothing to poll. Retry the request; if it repeats, narrow the query and use the synchronous path.',
      {
        code: 1,
        httpStatus: 200,
        action: classifyGraphError({ code: 1, message: 'no report_run_id' }),
      },
    );
  }
  return id;
}

/**
 * Read insights synchronously, falling back to an async report run when Graph
 * says the query is too large (error 100 / subcode 1487534). The fallback does
 * NOT wait: it returns the `report_run_id` plus polling instructions, because a
 * report run can take minutes and a tool call must not hold the connection.
 */
export async function fetchAdsInsights(
  fbRequest: FbRequestFn,
  opts: AdsInsightsOptions,
): Promise<AdsInsightsResult> {
  const maxRows = opts.maxRows ?? ADS_INSIGHTS_MAX_ROWS;

  if (opts.forceAsync === true) {
    const reportRunId = await startAdsReport(fbRequest, opts);
    return asyncStarted(opts.objectId, reportRunId, false);
  }

  let page;
  try {
    page = await fetchPage<unknown>(
      fbRequest,
      adsEdge(`/${opts.objectId}/insights`, insightsParams(opts), opts),
      {
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.after !== undefined ? { after: opts.after } : {}),
      },
    );
  } catch (err) {
    if (!isOversizedSyncError(err)) throw err;
    const reportRunId = await startAdsReport(fbRequest, opts);
    return asyncStarted(opts.objectId, reportRunId, true);
  }

  const rows = page.data.map((row) => normalizeInsightsRow(row));
  const capped = capRows(rows, maxRows);
  const notes: string[] = [];
  if (capped.note !== undefined) notes.push(capped.note);
  if (rows.length === 0 && !page.truncated) {
    notes.push(
      'No insights rows for this object and window. Insights are empty (not an error) when the object never delivered in the window; attribution also lags, so the last day or two can be incomplete.',
    );
  }

  return {
    mode: 'sync',
    objectId: opts.objectId,
    rows: capped.kept,
    rowCount: capped.kept.length,
    truncated: page.truncated || capped.note !== undefined,
    ...(page.nextCursor !== undefined && capped.note === undefined
      ? { nextCursor: page.nextCursor }
      : {}),
    ...(page.note !== undefined ? { note: page.note } : {}),
    notes,
  };
}

function asyncStarted(
  objectId: string,
  reportRunId: string,
  fellBack: boolean,
): AdsInsightsResult {
  return {
    mode: 'async',
    objectId,
    reportRunId,
    truncated: false,
    notes: [
      fellBack
        ? `Graph refused this query synchronously because it is too large, so an async report run was started instead (report_run_id ${reportRunId}). NO rows were read yet.`
        : `Async report run ${reportRunId} started. NO rows were read yet.`,
      `Poll facebook_ads_report_status with report_run_id=${reportRunId} — wait about ${String(
        REPORT_POLL_INTERVAL_MS / 1000,
      )}s between probes, and stop polling after ~${String(
        REPORT_STALL_MS / 60_000,
      )} minutes without progress rather than looping. The id resolves for ${String(
        REPORT_RUN_TTL_DAYS,
      )} days.`,
      ADS_RATE_LIMIT_NOTE,
    ],
  };
}

// ---------------------------------------------------------------------------
// 9. Report-run status machine (CC-ADS-5)
// ---------------------------------------------------------------------------

/** Terminal-state machine over Graph's `async_status` strings. */
export type ReportRunPhase =
  'pending' | 'running' | 'complete' | 'failed' | 'skipped' | 'unknown';

/** Documented `async_status` values, lowercased, mapped onto {@link ReportRunPhase}. */
const ASYNC_STATUS_PHASES: Readonly<Record<string, ReportRunPhase>> = {
  'job not started': 'pending',
  'job started': 'running',
  'job running': 'running',
  'job completed': 'complete',
  'job failed': 'failed',
  'job skipped': 'skipped',
};

/** Phases after which nothing more will happen to the run. */
const TERMINAL_PHASES: ReadonlySet<ReportRunPhase> = new Set([
  'complete',
  'failed',
  'skipped',
]);

/**
 * Map Graph's `async_status` onto a phase. An unrecognised value becomes
 * `unknown` (and is treated as NON-terminal but reported verbatim) rather than
 * being optimistically read as "still running".
 */
export function classifyAsyncStatus(raw: unknown): ReportRunPhase {
  const text = readString(raw);
  if (text === undefined) return 'unknown';
  return ASYNC_STATUS_PHASES[text.trim().toLowerCase()] ?? 'unknown';
}

export function isTerminalPhase(phase: ReportRunPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

export interface ReportRunStatus {
  readonly reportRunId: string;
  readonly phase: ReportRunPhase;
  /** Graph's raw `async_status` string, echoed for unrecognised values. */
  readonly rawStatus?: string;
  readonly percentComplete?: number;
  /** Epoch ms the run started, when Graph reported `time_ref`. */
  readonly startedAtMs?: number;
  readonly ageMs?: number;
  readonly terminal: boolean;
  /** True ⇒ results can be read now. */
  readonly resultsReady: boolean;
  /** True ⇒ the run has been alive past {@link REPORT_STALL_MS} without finishing. */
  readonly stalled: boolean;
  readonly advice: string;
}

function readEpochMs(value: unknown): number | undefined {
  // Graph reports `time_ref` / `time_completed` as unix SECONDS.
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    return undefined;
  return Math.round(value * 1000);
}

/** Build the operator/model advice for a phase. Pure — exported for testing. */
export function reportRunAdvice(input: {
  readonly phase: ReportRunPhase;
  readonly rawStatus?: string;
  readonly percentComplete?: number;
  readonly stalled: boolean;
}): string {
  const pct =
    input.percentComplete !== undefined
      ? ` (${String(input.percentComplete)}% complete)`
      : '';
  switch (input.phase) {
    case 'complete':
      return 'The run finished. Read the rows with facebook_ads_report_status by passing fetch_results=true, or re-run the query synchronously over a narrower window.';
    case 'failed':
      return "The run FAILED on Meta's side and produced nothing. Do not keep polling this id — start a new run over a narrower window or with fewer breakdowns.";
    case 'skipped':
      return 'Meta SKIPPED this run (usually a duplicate of a run already in flight, or an unsupported query). It produced nothing; start a new run.';
    case 'pending':
    case 'running':
      return input.stalled
        ? `The run is still ${input.phase}${pct} after more than ${String(
            REPORT_STALL_MS / 60_000,
          )} minutes. Stop polling and start a new, narrower run — very large runs can hang indefinitely and there is no cancel API.`
        : `The run is ${input.phase}${pct}. Wait about ${String(
            REPORT_POLL_INTERVAL_MS / 1000,
          )}s and probe again; stop after ~${String(
            REPORT_STALL_MS / 60_000,
          )} minutes without progress instead of polling forever.`;
    case 'unknown':
      return `Graph returned an unrecognised async_status${
        input.rawStatus !== undefined ? ` ("${input.rawStatus}")` : ''
      }, so the run's state is UNKNOWN — do not assume it is still running. Probe once more, then start a new run.`;
  }
}

/**
 * Probe one async report run. Never sleeps and never loops: one call, one
 * answer, plus explicit advice about when to stop polling (CC-ADS-5).
 */
export async function getReportRunStatus(
  fbRequest: FbRequestFn,
  opts: AdsRequestOptions & { readonly reportRunId: string; readonly nowMs: number },
): Promise<ReportRunStatus> {
  const res = await fbRequest<unknown>({
    protocol: 'json',
    method: 'GET',
    host: 'graph',
    path: `/${opts.reportRunId}`,
    params: {
      fields:
        'async_status,async_percent_completion,time_ref,time_completed,date_start,date_stop',
    },
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });

  const body: Record<string, unknown> = isRecord(res.data) ? res.data : {};
  const phase = classifyAsyncStatus(body.async_status);
  const rawStatus = readString(body.async_status);
  const percentComplete =
    typeof body.async_percent_completion === 'number'
      ? body.async_percent_completion
      : undefined;
  const startedAtMs = readEpochMs(body.time_ref);
  const ageMs =
    startedAtMs !== undefined ? Math.max(0, opts.nowMs - startedAtMs) : undefined;
  const terminal = isTerminalPhase(phase);
  const stalled = !terminal && ageMs !== undefined && ageMs > REPORT_STALL_MS;

  return {
    reportRunId: opts.reportRunId,
    phase,
    ...(rawStatus !== undefined ? { rawStatus } : {}),
    ...(percentComplete !== undefined ? { percentComplete } : {}),
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    ...(ageMs !== undefined ? { ageMs } : {}),
    terminal,
    resultsReady: phase === 'complete',
    stalled,
    advice: reportRunAdvice({
      phase,
      ...(rawStatus !== undefined ? { rawStatus } : {}),
      ...(percentComplete !== undefined ? { percentComplete } : {}),
      stalled,
    }),
  };
}

export interface ReportResultsOptions extends AdsRequestOptions {
  readonly reportRunId: string;
  readonly limit?: number;
  readonly after?: Cursor;
  readonly maxRows?: number;
}

export interface ReportResults extends AdPagedResult {
  readonly reportRunId: string;
  readonly rows: readonly AdRecord[];
  readonly rowCount: number;
  readonly notes: readonly string[];
}

/**
 * Read the rows of a COMPLETED report run. Callers must check the phase first —
 * reading an unfinished run returns an empty page, which is indistinguishable
 * from "the query genuinely has no data" without the status probe.
 */
export async function fetchReportResults(
  fbRequest: FbRequestFn,
  opts: ReportResultsOptions,
): Promise<ReportResults> {
  const page = await fetchPage<unknown>(
    fbRequest,
    adsEdge(`/${opts.reportRunId}/insights`, {}, opts),
    {
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.after !== undefined ? { after: opts.after } : {}),
    },
  );
  const rows = page.data.map((row) => normalizeInsightsRow(row));
  const capped = capRows(rows, opts.maxRows ?? ADS_INSIGHTS_MAX_ROWS);
  const notes: string[] = [];
  if (capped.note !== undefined) notes.push(capped.note);

  return {
    reportRunId: opts.reportRunId,
    rows: capped.kept,
    rowCount: capped.kept.length,
    truncated: page.truncated || capped.note !== undefined,
    ...(page.nextCursor !== undefined && capped.note === undefined
      ? { nextCursor: page.nextCursor }
      : {}),
    ...(page.note !== undefined ? { note: page.note } : {}),
    notes,
  };
}
