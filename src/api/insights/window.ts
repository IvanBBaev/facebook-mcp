// Insights window validation, 90-day cap (X09 split of `insights.ts`).

import { GraphApiError, classifyGraphError } from '../../core/index.js';
import {
  DATE_ONLY,
  INSIGHTS_MAX_WINDOW_DAYS,
  INSIGHTS_WINDOW_BOUNDARY,
  META_INSIGHTS_TIMEZONE,
  MS_PER_DAY,
} from './limits.js';
import type { InsightsScope } from './model.js';

// ---------------------------------------------------------------------------
// 6. Window validation (90-day cap, CC-INS-5)
// ---------------------------------------------------------------------------

/** The validated query window echoed back to the caller. */
export interface InsightsWindow {
  /** Inclusive start boundary. */
  readonly since?: string;
  /** EXCLUSIVE end boundary. */
  readonly until?: string;
  /** Boundary span `until − since` in days (`until` defaults to today). */
  readonly days?: number;
  readonly boundary: typeof INSIGHTS_WINDOW_BOUNDARY;
  /** Pacific Time for a Page's daily buckets; UTC for posts and Reels. */
  readonly timezone: string;
}

/** The timezone a scope's date boundaries are read in. */
export function insightsTimezone(scope: InsightsScope): string {
  return scope === 'page' ? META_INSIGHTS_TIMEZONE : 'UTC';
}

/** Today's calendar date in {@link META_INSIGHTS_TIMEZONE} (DST-aware). */
export function insightsDate(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: META_INSIGHTS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${read('year')}-${read('month')}-${read('day')}`;
}

/** Today's date as the implicit `until` of a scope. */
export function scopeToday(scope: InsightsScope, nowMs: number): string {
  return scope === 'page' ? insightsDate(nowMs) : utcDate(nowMs);
}

/** A client-side parameter error, classified through the F06 matrix (code 100). */
function validationError(message: string): GraphApiError {
  return new GraphApiError(message, {
    code: 100,
    httpStatus: 400,
    action: classifyGraphError({ code: 100, message }),
  });
}

function parseDate(label: string, value: string): number {
  if (!DATE_ONLY.test(value)) {
    throw validationError(
      `Invalid \`${label}\`: "${value}". Use a calendar date in YYYY-MM-DD form.`,
    );
  }
  const ms = Date.parse(`${value}T00:00:00Z`);
  // `Date.parse` rolls an impossible day over ("2026-02-29" becomes March 1st,
  // "04-31" May 1st) instead of returning NaN, and Graph's own parser does the
  // same — so without the round-trip the caller is told the window starts on a
  // date that does not exist while the data starts on the next one.
  if (Number.isNaN(ms) || utcDate(ms) !== value) {
    throw validationError(`Invalid \`${label}\`: "${value}" is not a real date.`);
  }
  return ms;
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Validate `since`/`until` and compute the span. Enforces the documented
 * {@link INSIGHTS_MAX_WINDOW_DAYS} ceiling client-side so an over-wide query
 * fails with an actionable message instead of a Graph 400 (or, worse, a
 * silently clipped series). The window is `[since, until)`: `days` is the
 * boundary span, and a lone `since` is measured against today in the scope's
 * timezone (Pacific Time for a Page, UTC otherwise).
 *
 * @throws GraphApiError (validation) on a malformed date, a reversed or empty
 *   window, or a span over the ceiling.
 */
export function checkWindow(input: {
  readonly scope: InsightsScope;
  readonly since?: string;
  readonly until?: string;
  readonly nowMs: number;
  readonly maxDays?: number;
}): InsightsWindow {
  const maxDays = input.maxDays ?? INSIGHTS_MAX_WINDOW_DAYS;
  const sinceMs = input.since !== undefined ? parseDate('since', input.since) : undefined;
  const untilMs = input.until !== undefined ? parseDate('until', input.until) : undefined;

  let days: number | undefined;
  if (sinceMs !== undefined) {
    const today = scopeToday(input.scope, input.nowMs);
    const endMs = untilMs ?? parseDate('until', today);
    if (endMs < sinceMs) {
      // A lone \`since\` is measured against today: name that, not an \`until\`
      // the caller never passed.
      const end =
        input.until !== undefined
          ? `\`until\` (${input.until})`
          : `today (${today}, the default \`until\`)`;
      throw validationError(
        `Invalid window: \`since\` (${String(input.since)}) is after ${end}.`,
      );
    }
    if (untilMs === sinceMs) {
      throw validationError(
        `Invalid window: empty window: until is exclusive, so since = until (${String(input.until)}) covers no day. Pass the day after as \`until\`.`,
      );
    }
    days = Math.round((endMs - sinceMs) / MS_PER_DAY);
    if (days > maxDays) {
      throw validationError(
        `Window too wide: a boundary span of ${String(days)} days was requested but this server reads at most ${String(maxDays)} days of insights per query (inside Graph's 93-day maximum; 2-year retention overall). Narrow since/until, or read the window in ${String(maxDays)}-day slices.`,
      );
    }
  }

  return {
    ...(input.since !== undefined ? { since: input.since } : {}),
    ...(input.until !== undefined ? { until: input.until } : {}),
    ...(days !== undefined ? { days } : {}),
    boundary: INSIGHTS_WINDOW_BOUNDARY,
    timezone: insightsTimezone(input.scope),
  };
}

/**
 * The window of the same length that ends where `window` starts — the
 * comparison period of a report. Undefined unless `since` and `days` are known.
 */
export function previousWindow(window: InsightsWindow): InsightsWindow | undefined {
  if (window.since === undefined || window.days === undefined || window.days <= 0) {
    return undefined;
  }
  const sinceMs = Date.parse(`${window.since}T00:00:00Z`);
  if (Number.isNaN(sinceMs)) return undefined;
  return {
    since: utcDate(sinceMs - window.days * MS_PER_DAY),
    until: window.since,
    days: window.days,
    boundary: window.boundary,
    timezone: window.timezone,
  };
}
