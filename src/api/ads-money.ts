// Marketing API MONEY helpers (`api` layer — imports only from `core`).
//
// Pure functions shared by every ads write that carries an amount: the budget
// update, the campaign spend cap and the planned boost and copy flows. Nothing
// here touches the network. Amounts are integer MINOR units of the ad account
// currency as Meta defines them (its currency offset), end to end (CC-ADS-3),
// and every limit refuses rather than clamps (CC-ADS-7).

import { GraphApiError, classifyGraphError } from '../core/index.js';

function validationError(message: string): GraphApiError {
  return new GraphApiError(message, {
    code: 100,
    httpStatus: 400,
    action: classifyGraphError({ code: 100, message }),
  });
}

// ---------------------------------------------------------------------------
// 1. Currencies
// ---------------------------------------------------------------------------

/**
 * Ad-account currencies Meta counts in WHOLE units (offset 1 in Meta's currency
 * table, marketing-api/currencies), plus the ISO 4217 exponent-0 currencies.
 *
 * Meta takes every budget in the account currency's smallest unit AS META
 * DEFINES IT, and for these that unit IS the currency: `daily_budget=1000` on a
 * JPY account is 1000 JPY, not 10.00. That is not the same list as ISO 4217:
 * COP, CRC, HUF, IDR and TWD have two ISO decimals but a Meta offset of 1, so
 * `daily_budget=1000` on a TWD account is 1000 TWD, not 10.00. Calling such an amount "minor units" states the money at
 * a hundredth of its size in the one line an operator confirms before a
 * spend-tier write, so the preview names the currency in whole units instead.
 * The amount on the wire is untouched either way — this is what the number is
 * CALLED, never what is sent.
 */
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'BIF',
  'CLP',
  'COP',
  'CRC',
  'DJF',
  'GNF',
  'HUF',
  'IDR',
  'ISK',
  'JPY',
  'KMF',
  'KRW',
  'PYG',
  'RWF',
  'TWD',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

/**
 * Ad-account currencies whose ISO 4217 minor unit is a THOUSANDTH but that Meta
 * counts in HUNDREDTHS (offset 100 in Meta's currency table). `daily_budget=2500`
 * on a BHD account is 25.00 BHD; calling it "2500 minor units of BHD" reads as
 * 2.500 BHD (2500 fils) to anyone who knows the currency — a tenfold
 * understatement — so the preview names the hundredths and the major amount.
 */
export const HUNDREDTH_OFFSET_THREE_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'BHD',
  'JOD',
]);

// ---------------------------------------------------------------------------
// 2. Validation and wording
// ---------------------------------------------------------------------------

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
      `\`${field}\` must be a whole number of MINOR currency units, not ${String(value)}. ` +
        'A minor unit is the unit Meta counts for the AD ACCOUNT currency (its currency ' +
        'offset), not always the ISO subunit: for USD, 1000 means 10.00, not 1000.00; in a ' +
        'zero-decimal currency such as JPY or TWD, the same 1000 means 1000. Either way ' +
        'there is no float budget.',
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

/**
 * Name an amount the way the account's currency actually works. A currency with
 * no subunit ({@link ZERO_DECIMAL_CURRENCIES}) is stated in whole units, because
 * "N minor units of JPY" reads as N/100 to anyone who knows the term.
 */
export function formatMinor(value: number, currency: string | undefined): string {
  if (currency === undefined) return `${String(value)} minor units`;
  const code = currency.trim().toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) {
    return `${String(value)} ${currency} (whole units)`;
  }
  if (HUNDREDTH_OFFSET_THREE_DECIMAL_CURRENCIES.has(code)) {
    return `${String(value)} hundredths of ${currency} (${hundredthsAsMajor(value)} ${currency})`;
  }
  return `${String(value)} minor units of ${currency}`;
}

/** An integer count of hundredths as a two-decimal major amount, without float math. */
export function hundredthsAsMajor(value: number): string {
  const whole = Math.trunc(value / 100);
  const cents = value % 100;
  return `${String(whole)}.${String(cents).padStart(2, '0')}`;
}

/** The warning a three-decimal currency Meta counts in hundredths gets beside every budget change. */
export function hundredthOffsetNote(
  argName: string,
  value: number,
  currency: string,
): string {
  return (
    `${currency}'s ISO minor unit is 1/1000, but Meta counts ${currency} budgets in ` +
    `1/100: \`${argName}\` of ${String(value)} is ${hundredthsAsMajor(value)} ${currency}, ` +
    `not ${String(value)} thousandths. The number is sent to Graph exactly as given.`
  );
}

/** The warning a zero-decimal account gets beside every budget change. */
export function zeroDecimalNote(
  argName: string,
  value: number,
  currency: string,
): string {
  return (
    `${currency} has no minor unit on a Meta ad account: \`${argName}\` of ${String(value)} is ` +
    `${String(value)} ${currency}, not one hundredth of it. The number is sent to ` +
    `Graph exactly as given — confirm the amount in whole ${currency}.`
  );
}

/**
 * Enforce `FB_ADS_BUDGET_CEILING` (or another minor-unit ceiling such as
 * `FB_ADS_CAMPAIGN_SPEND_CAP_MAX`) BEFORE the request exists (CC-ADS-7).
 *
 * The ceiling blocks RAISES above the cap. A change that lowers an already
 * over-cap budget is allowed — refusing it would trap an operator above their
 * own ceiling with no way down through the API.
 *
 * @throws GraphApiError (validation) naming both numbers and both ways forward.
 *   Never clamps: a silently reduced budget is worse than a refusal.
 */
export function enforceCeiling(input: {
  readonly field: string;
  readonly requested: number;
  readonly current: number | undefined;
  readonly ceiling: number;
  readonly currency: string | undefined;
  readonly objectId: string;
  /** The setting that holds the ceiling; defaults to `FB_ADS_BUDGET_CEILING`. */
  readonly setting?: string;
}): void {
  const setting = input.setting ?? 'FB_ADS_BUDGET_CEILING';
  if (input.requested <= input.ceiling) return;
  const isLowering = input.current !== undefined && input.requested < input.current;
  if (isLowering) return;
  throw validationError(
    `Refused: \`${input.field}\` of ${formatMinor(input.requested, input.currency)} exceeds ${setting} (${formatMinor(
      input.ceiling,
      input.currency,
    )}). NOTHING was changed on ${input.objectId} and the amount was NOT reduced to the ceiling. Either request ${String(
      input.ceiling,
    )} or less, or raise ${setting} in the server configuration and restart.`,
  );
}

// ---------------------------------------------------------------------------
// 3. Campaign spend cap
// ---------------------------------------------------------------------------

/**
 * The value Meta documents for "remove the campaign spend cap". This server
 * never removes a cap: an uncapped campaign is bounded only by its budgets,
 * which is exactly the exposure the cap exists to close.
 */
export const SPEND_CAP_REMOVAL_SENTINEL = 922_337_203_685_478;

/**
 * Validate a campaign `spend_cap` in minor units. The removal sentinel, and
 * anything at or above it or beyond exact integer range, is refused as a removal
 * before the generic checks could call it merely "too large".
 */
export function validateSpendCapMinor(field: string, value: number): number {
  if (Number.isFinite(value) && value >= Math.min(SPEND_CAP_REMOVAL_SENTINEL, 2 ** 53)) {
    throw validationError(
      `\`${field}\` of ${String(value)} is Meta's "remove the spend cap" value: removing a campaign spend cap is out of scope for this server. Nothing was changed.`,
    );
  }
  return validateBudgetMinor(field, value);
}

/**
 * Enforce `FB_ADS_CAMPAIGN_SPEND_CAP_MAX` for a cap the write would SET. Unset
 * means no write may set a cap at all: there is no implicit maximum.
 */
export function enforceSpendCapMax(input: {
  readonly field: string;
  readonly requested: number;
  readonly current: number | undefined;
  readonly max: number | undefined;
  readonly currency: string | undefined;
  readonly objectId: string;
}): void {
  if (input.max === undefined) {
    throw validationError(
      `Refused: \`${input.field}\` needs FB_ADS_CAMPAIGN_SPEND_CAP_MAX, which is not set. NOTHING was changed on ${input.objectId}. Set FB_ADS_CAMPAIGN_SPEND_CAP_MAX (minor units of the ad account currency) in the server configuration and restart.`,
    );
  }
  enforceCeiling({
    field: input.field,
    requested: input.requested,
    current: input.current,
    ceiling: input.max,
    currency: input.currency,
    objectId: input.objectId,
    setting: 'FB_ADS_CAMPAIGN_SPEND_CAP_MAX',
  });
}

/**
 * Refuse when `FB_ADS_CAMPAIGN_SPEND_CAP_MAX` is below the account's
 * `min_campaign_group_spend_cap`: every cap the server could set would then be
 * one Meta rejects.
 */
export function assertSpendCapMaxReachable(
  max: number,
  metaMinimum: number | undefined,
  currency: string | undefined,
): void {
  if (metaMinimum === undefined || max >= metaMinimum) return;
  throw validationError(
    `Your FB_ADS_CAMPAIGN_SPEND_CAP_MAX (${formatMinor(max, currency)}) is below Meta's minimum campaign spend cap (${formatMinor(metaMinimum, currency)}) for this account. Nothing was changed. Raise FB_ADS_CAMPAIGN_SPEND_CAP_MAX to at least ${String(metaMinimum)} and restart.`,
  );
}

// ---------------------------------------------------------------------------
// 4. Worst-case spend envelope
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** What the worst-case total is bounded by. */
export type EnvelopeBound = 'spend_cap' | 'lifetime_budget' | 'daily_flex';

export interface SpendEnvelopeInput {
  readonly dailyBudgetMinor?: number;
  readonly lifetimeBudgetMinor?: number;
  /** ISO-8601 or epoch ms. */
  readonly startTime: string | number;
  /** ISO-8601 or epoch ms; absent ⇒ the campaign runs until stopped. */
  readonly endTime?: string | number;
  /** The campaign spend cap: always the absolute ceiling of the envelope. */
  readonly spendCapMinor: number;
}

export interface SpendEnvelope {
  /** Most one day can spend; absent for a lifetime budget (Meta paces it). */
  readonly perDayMaxMinor?: number;
  /** Most one calendar week can spend; absent for a lifetime budget. */
  readonly perWeekMaxMinor?: number;
  /** Most the whole run can spend. Never above the spend cap. */
  readonly totalMaxMinor: number;
  readonly boundBy: EnvelopeBound;
  readonly spendCapMinor: number;
}

function parseInstant(field: string, value: string | number): number {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw validationError(`\`${field}\` is not a valid time: ${JSON.stringify(value)}.`);
  }
  return ms;
}

/**
 * The most money a campaign can spend, in minor units, under Meta's pacing
 * rules: a daily budget may spend up to 175% of itself on one day but no more
 * than 7× itself in a calendar week; a lifetime budget is spent over the run
 * and may front-load. The spend cap bounds everything.
 */
export function worstCaseEnvelope(input: SpendEnvelopeInput): SpendEnvelope {
  const cap = validateSpendCapMinor('spend_cap_minor', input.spendCapMinor);
  const daily =
    input.dailyBudgetMinor !== undefined
      ? validateBudgetMinor('daily_budget_minor', input.dailyBudgetMinor)
      : undefined;
  const lifetime =
    input.lifetimeBudgetMinor !== undefined
      ? validateBudgetMinor('lifetime_budget_minor', input.lifetimeBudgetMinor)
      : undefined;
  if (daily !== undefined && lifetime !== undefined) {
    throw validationError(
      'Pass either `daily_budget_minor` or `lifetime_budget_minor`, not both: Meta runs an object on one budget kind.',
    );
  }
  const start = parseInstant('start_time', input.startTime);
  const end =
    input.endTime !== undefined ? parseInstant('end_time', input.endTime) : undefined;
  if (end !== undefined && end <= start) {
    throw validationError('`end_time` must be after `start_time`.');
  }

  if (daily !== undefined) {
    const perDayMaxMinor = Math.ceil((daily * 7) / 4);
    const perWeekMaxMinor = daily * 7;
    if (end === undefined) {
      return {
        perDayMaxMinor,
        perWeekMaxMinor,
        totalMaxMinor: cap,
        boundBy: 'spend_cap',
        spendCapMinor: cap,
      };
    }
    const weeks = Math.ceil(Math.ceil((end - start) / DAY_MS) / 7);
    const byBudget = perWeekMaxMinor * weeks;
    return byBudget < cap
      ? {
          perDayMaxMinor,
          perWeekMaxMinor,
          totalMaxMinor: byBudget,
          boundBy: 'daily_flex',
          spendCapMinor: cap,
        }
      : {
          perDayMaxMinor,
          perWeekMaxMinor,
          totalMaxMinor: cap,
          boundBy: 'spend_cap',
          spendCapMinor: cap,
        };
  }
  if (lifetime !== undefined && lifetime < cap) {
    return { totalMaxMinor: lifetime, boundBy: 'lifetime_budget', spendCapMinor: cap };
  }
  return { totalMaxMinor: cap, boundBy: 'spend_cap', spendCapMinor: cap };
}

/** The envelope as preview lines. The spend cap is always named as the ceiling. */
export function describeEnvelope(
  envelope: SpendEnvelope,
  currency: string | undefined,
): readonly string[] {
  const lines: string[] = [];
  if (envelope.perDayMaxMinor !== undefined && envelope.perWeekMaxMinor !== undefined) {
    lines.push(
      `Worst case per day: ${formatMinor(envelope.perDayMaxMinor, currency)} (Meta may spend up to 175% of a daily budget on one day).`,
      `Worst case per week: ${formatMinor(envelope.perWeekMaxMinor, currency)} (7 × the daily budget).`,
    );
  } else {
    lines.push(
      'A lifetime budget has no per-day bound: Meta paces it over the run and may front-load.',
    );
  }
  const by =
    envelope.boundBy === 'daily_flex'
      ? 'the daily budget over the scheduled weeks'
      : envelope.boundBy === 'lifetime_budget'
        ? 'the lifetime budget'
        : 'the campaign spend cap';
  lines.push(
    `Worst case in total: ${formatMinor(envelope.totalMaxMinor, currency)}, bounded by ${by}.`,
    `Absolute ceiling: the campaign spend cap of ${formatMinor(envelope.spendCapMinor, currency)}.`,
  );
  return lines;
}
