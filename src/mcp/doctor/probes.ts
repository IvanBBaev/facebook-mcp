// Shared plumbing for the lane probes: running an injected probe safely.

import { errorMessageOf } from '../../core/index.js';
import { type DoctorDeps, type MetricProbe, type MetricProbeReport } from './types.js';

/**
 * Run one injected probe. A probe that throws is REPORTED, never propagated —
 * the doctor's whole value is that it still prints a report when something is
 * broken, and a probe hitting a blocked account is exactly such a case.
 */
export async function runProbe(
  deps: DoctorDeps,
  probe: MetricProbe | undefined,
  label: string,
  absentSummary: string,
): Promise<MetricProbeReport> {
  if (probe === undefined) return { available: false, summary: absentSummary };
  try {
    const result = await probe({
      fbRequest: deps.fbRequest,
      settings: deps.settings,
      clock: deps.clock,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    });
    return {
      available: result.available,
      summary: result.summary,
      ...(result.details !== undefined ? { details: result.details } : {}),
      ...(result.degraded === true ? { degraded: true } : {}),
    };
  } catch (err) {
    const message = errorMessageOf(err);
    return {
      available: false,
      summary: `${label}: failed (${deps.redactor.redactString(message)})`,
      failed: true,
    };
  }
}

/**
 * Why a Graph probe is skipped when `debug_token` itself never got an answer.
 * Shared with the metric-set probe's wording so the report tells one story.
 */
export const UNANSWERED_SKIP_REASON =
  'the token could not be checked (see Token above) — a probe over the same broken connection would only repeat the failure';
