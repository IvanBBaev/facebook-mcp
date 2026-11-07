// Ad-account id normalisation (X11 split of `ads-read.ts`).

import { GraphApiError, classifyGraphError } from '../../core/index.js';

// ---------------------------------------------------------------------------
// 2. Ad-account id normalisation
// ---------------------------------------------------------------------------

const ACT_ID = /^act_\d+$/;
const DIGITS = /^\d+$/;

/** A client-side parameter error, classified through the shared matrix (code 100). */
export function validationError(message: string): GraphApiError {
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
