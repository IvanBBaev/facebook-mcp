// Doctor probe for the `ads` lane: the injected ad-account health check.

import type { Settings } from '../../core/index.js';
import { UNANSWERED_SKIP_REASON, runProbe } from './probes.js';
import type { DoctorDeps, MetricProbeReport } from './types.js';

/** Is an ad account configured, i.e. would the ad-account probe call Graph? */
export function adAccountConfigured(settings: Settings): boolean {
  return settings.adAccountId !== undefined && settings.adAccountId.trim() !== '';
}

/**
 * The ad-account slice of the report. Only a probe that would actually call
 * Graph is skipped when the token check never answered: without
 * FB_AD_ACCOUNT_ID the wired probe answers "not configured" offline, and that
 * line is still worth printing.
 */
export async function adAccountProbeReport(
  deps: DoctorDeps,
  checkUnanswered: boolean,
): Promise<MetricProbeReport> {
  return checkUnanswered &&
    deps.adAccountProbe !== undefined &&
    adAccountConfigured(deps.settings)
    ? { available: false, summary: `ad account: skipped (${UNANSWERED_SKIP_REASON})` }
    : await runProbe(
        deps,
        deps.adAccountProbe,
        'ad account',
        'ad account: not checked (the ads package is off — enable it and set FB_AD_ACCOUNT_ID to diagnose ad-account health).',
      );
}
