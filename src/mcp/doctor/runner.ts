// Doctor orchestration: runs every check in report order and builds the report.

import { adAccountProbeReport } from './ads.js';
import {
  inspectActivityStateFile,
  inspectCredentialFile,
  inspectToken,
} from './credentials.js';
import { summarizeDoctor } from './findings.js';
import { insightsMetricProbe, probeMetricSet } from './insights.js';
import { buildMatrix, computeOverScope } from './permissions.js';
import { type DoctorDeps, type DoctorReport } from './types.js';

/**
 * Run the doctor: classify the token, cross-reference scopes against the loaded
 * packages, and (optionally) fold in a metric probe. Never throws for an
 * auth/scope problem — those are reported, not raised — so the command always
 * yields a report an operator can read.
 */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const now = deps.clock.now();
  deps.logger.debug('doctor: collecting token + permission diagnostics', {
    packages: deps.packages.map((pkg) => pkg.name),
  });

  const token = await inspectToken(deps, now);
  const granted = new Set(token.scopes);
  const checkUnanswered = token.diagnosis === 'token_check_failed';

  const activityStateFile = await inspectActivityStateFile(deps);
  const report: Omit<DoctorReport, 'summary'> = {
    serverVersion: deps.serverVersion,
    apiVersion: deps.settings.apiVersion,
    adsApiVersion: deps.settings.adsApiVersion,
    generatedAt: now,
    ...(deps.packageSelectionError !== undefined
      ? { packageSelectionError: deps.packageSelectionError }
      : {}),
    // Loader messages quote the offending value where it helps the operator;
    // the report is printed, so they go through the same redactor as the rest.
    ...(deps.startupProblems !== undefined
      ? {
          startupProblems: deps.startupProblems.map((problem) => ({
            ...problem,
            message: deps.redactor.redactString(problem.message),
          })),
        }
      : {}),
    token,
    // A token check that never answered — or that Graph refused outright —
    // learned no scopes; the matrix must not read that silence as "nothing
    // granted". Nor may a 200 that ruled the token invalid: Graph then reports
    // no usable grants, so "missing: pages_show_list" would send the operator
    // off to re-grant permissions when the token itself is what is broken.
    // No token at all is the same silence: debug_token was never asked.
    matrix: buildMatrix(
      deps.packages,
      granted,
      token.configured &&
        token.diagnosis !== 'token_check_failed' &&
        token.debugCallRejected === undefined &&
        !(token.configured && !token.valid),
    ),
    overScopePermissions: computeOverScope(deps.packages, granted),
    // Each lane's probe is evaluated here, in report order, so the Graph calls
    // run in the same sequence as before the split.
    metricProbe: await insightsMetricProbe(deps, token),
    metricSet: await probeMetricSet(deps, token, now),
    adAccount: await adAccountProbeReport(deps, checkUnanswered),
    credentialFile: await inspectCredentialFile(deps),
    ...(activityStateFile !== undefined ? { activityStateFile } : {}),
    // Last on purpose: every Graph call above has been made, so the monitor
    // holds whatever version headers they carried.
    ...(deps.versionDrift !== undefined
      ? { versionDrift: deps.versionDrift.signals() }
      : {}),
  };
  return { ...report, summary: summarizeDoctor(report, deps.launchCommand) };
}
