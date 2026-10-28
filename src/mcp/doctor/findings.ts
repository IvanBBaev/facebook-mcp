// Overall verdict: every report slice reduced to findings and one verdict (shared).

import {
  describeVersionDrift,
  type StartupProblem,
  type VersionDriftSignal,
} from '../../core/index.js';
import { DEFAULT_LAUNCH_COMMAND, subcommandHint } from '../launch-command.js';
import { describePageBinding } from './credentials.js';
import { fmtList, matrixRowDetail, STATUS_LABEL } from './format.js';
import {
  type CredentialFileReport,
  type DoctorFinding,
  type DoctorReport,
  type DoctorSeverity,
  type DoctorSummary,
  type DoctorTokenReport,
  type DoctorVerdict,
  type MetricProbeReport,
  type MetricSetReport,
  type PackageMatrixRow,
} from './types.js';

// ---------------------------------------------------------------------------
// Overall verdict
// ---------------------------------------------------------------------------

/** Most-urgent-wins ordering for {@link DoctorSeverity}. */
const SEVERITY_RANK: Record<DoctorSeverity, number> = { warn: 1, unknown: 2, fail: 3 };

/**
 * A `debug_token` call authenticated with the app credential and refused by
 * Graph: the refusal may be about the app credential, so the token is not the
 * only suspect and must not be the only remedy.
 */
export const APP_CREDENTIAL_REJECTION =
  'debug_token refused the call, which was authenticated with FB_APP_ID|FB_APP_SECRET ' +
  '— the refusal may be about that app credential rather than the token: verify ' +
  'FB_APP_ID / FB_APP_SECRET first, and re-issue the token only if they are right.';

/** Token findings — the CC-AUTH-5 diagnosis, mapped to severity. */
function tokenFindings(token: DoctorTokenReport, launch: string): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  switch (token.diagnosis) {
    case 'no_token':
      findings.push({
        severity: 'fail',
        area: 'token',
        detail:
          'No credential is configured — set FB_SYSTEM_TOKEN (or FB_ACCESS_TOKEN / FB_PAGE_TOKEN), ' +
          `or run \`FB_SETUP_TOKEN=<token> ${subcommandHint(launch, 'setup-token')}\` with a ` +
          'Graph API Explorer user token to mint a long-lived one and write the env file for you.',
      });
      break;
    case 'token_malformed':
      findings.push({
        severity: 'fail',
        area: 'token',
        detail:
          token.debugCallRejected?.authenticatedWith === 'app_credential'
            ? APP_CREDENTIAL_REJECTION
            : 'debug_token did not accept this token — re-issue it.',
      });
      break;
    case 'asset_access_revoked':
      findings.push({
        severity: 'fail',
        area: 'token',
        detail:
          'granular_scopes names no target asset — re-grant the assets in Business settings.',
      });
      break;
    case 'token_check_failed':
      // Not a failure: nothing was learned either way (CC-NET-6).
      findings.push({
        severity: 'unknown',
        area: 'token',
        detail:
          'debug_token could not be reached, so nothing was established about the credential — fix the connection, then re-run.',
      });
      break;
    case 'ok':
      break;
  }
  if (token.expiringSoon) {
    findings.push({
      severity: 'warn',
      area: 'token',
      detail: 'The token expires within 7 days (or already has) — refresh it.',
    });
  }
  // Checked on its own: a token that never expires (or expires later) still
  // loses data access at `data_access_expires_at`, and the report used to print
  // that date under "never" and verdict OK.
  if (token.dataAccessExpiringSoon === true) {
    findings.push({
      severity: 'warn',
      area: 'token',
      detail:
        "The token's data access ends within 7 days (or already has) — Graph stops serving data to it after that, whatever the token expiry says; have the issuing user re-authorize the app, then re-issue the token.",
    });
  }
  // A warning, not silence: the doctor cannot tell the operator when this
  // credential stops working, and an install whose credential lifetime nobody
  // knows is not one that has "nothing needing attention". Graph normally
  // states `expires_at` (0 for a non-expiring token), so an answer without it
  // is itself worth a look.
  if (token.expiryUnknown) {
    findings.push({
      severity: 'warn',
      area: 'token',
      detail:
        "The token's expiry is unknown — Graph's debug_token answer carried no usable expires_at, so the doctor cannot tell when this credential stops working. Re-check the token in the Graph API Explorer's Access Token Debugger.",
    });
  }
  // The same severity `loadSettings` gives `page-token-unbound` at startup: the
  // server runs (whoami and the doctor itself work), Page-scoped tools do not.
  const binding =
    token.pageBinding !== undefined ? describePageBinding(token.pageBinding) : undefined;
  if (binding !== undefined) {
    findings.push({ severity: 'warn', area: 'token', detail: `${binding}.` });
  }
  return findings;
}

/** Package findings: everything blocked is a failure, anything less is a warning. */
function matrixFindings(matrix: readonly PackageMatrixRow[]): DoctorFinding[] {
  if (matrix.length === 0) return [];
  if (matrix.every((row) => row.status === 'blocked')) {
    return [
      {
        severity: 'fail',
        area: 'packages',
        detail: `No loaded package can run under the granted scopes (missing: ${fmtList([
          ...new Set(matrix.flatMap((row) => row.missingPermissions)),
        ])}).`,
      },
    ];
  }
  const findings: DoctorFinding[] = [];
  for (const row of matrix) {
    if (row.status === 'usable') continue;
    // Nothing was established about an unverified row, and the token finding
    // already carries that as `unknown`; a "missing" warning here would be the
    // very inference the row exists to avoid.
    if (row.status === 'unverified') continue;
    findings.push({
      severity: 'warn',
      area: 'packages',
      detail: `${row.package}: ${STATUS_LABEL[row.status]} — ${matrixRowDetail(row)}`,
    });
  }
  return findings;
}

/**
 * Credential-file findings.
 *
 * A platform that does not carry POSIX bits raises nothing: the rendered report
 * already says the protection was not verified, and there is no chmod an
 * operator could run to make it verifiable. A finding no action can clear is
 * noise that would make `--strict` permanently red on Windows.
 */
function credentialFileFindings(
  file: CredentialFileReport | undefined,
  area = 'credential file',
): DoctorFinding[] {
  if (file === undefined) return [];
  if (file.unreadable === true) {
    return [{ severity: 'warn', area, detail: file.note }];
  }
  if (file.exists && file.posixPermissions && file.ownerOnly === false) {
    return [
      {
        severity: 'warn',
        area,
        detail: `${file.path}: group/other can read this file — run chmod 600 on it.`,
      },
    ];
  }
  return [];
}

/**
 * Metric-set findings. `skipped` raises nothing — running without a Page is a
 * normal configuration, not a defect; a REJECTED name is the actionable one,
 * because it means the shipped metric set has drifted from the live API.
 *
 * An `unknown` name raises a finding too. Graph answering 200 and omitting the
 * name is the silent half of the same drift, and reading only the rejections
 * left the notes counting it under "did not check out" while the verdict beneath
 * them said `ok` — the one shape where `--strict` waves a stale metric set
 * through. A probe that died before judging any name is `unknown` rather than
 * `warn` for the same reason the ladder ranks them that way: nothing about the
 * names was established, and that is the larger problem, not the smaller one.
 */
function metricSetFindings(metricSet: MetricSetReport): DoctorFinding[] {
  if (metricSet.outcome === 'failed') {
    return [{ severity: 'unknown', area: 'insights', detail: metricSet.summary }];
  }
  const findings: DoctorFinding[] = [];
  const rejected = metricSet.verdicts
    .filter((verdict) => verdict.status === 'rejected')
    .map((verdict) => verdict.metric);
  if (rejected.length > 0) {
    findings.push({
      severity: 'warn',
      area: 'insights',
      detail: `Graph refused ${String(rejected.length)} shipped metric name(s): ${fmtList(
        rejected,
      )} — the metric set has drifted from the live API.`,
    });
  }
  const unverified = metricSet.verdicts
    .filter((verdict) => verdict.status === 'unknown')
    .map((verdict) => verdict.metric);
  if (unverified.length > 0) {
    findings.push({
      severity: 'unknown',
      area: 'insights',
      detail: `Graph answered without ruling on ${String(
        unverified.length,
      )} shipped metric name(s): ${fmtList(unverified)} — the names were never verified.`,
    });
  }
  return findings;
}

/**
 * Probe findings. An injected probe that threw has to reach the verdict, and
 * `available: false` cannot carry it: an unwired probe reports the same field,
 * so both were read as healthy and a report could print "ad account: failed
 * (...)" directly above "OK — nothing needs attention". Not wiring a probe stays
 * silent; a probe that blew up established nothing, which is `unknown`.
 *
 * The same field could not carry "configured but unhealthy" either: an ad
 * account that IS set and that Graph says cannot serve — the one situation the
 * probe exists to surface (CC-ADS-6) — answered the same `available: false` as
 * an account nobody configured, so it never moved the verdict and `--strict`
 * could not see it. A probe that marks its answer `degraded` is a `warn`: Graph
 * answered, and the answer is something the operator has to act on. A plain
 * `available: false` stays silent, so an unconfigured ad account on a non-ads
 * install cannot redden `--strict`.
 */
function probeFindings(probe: MetricProbeReport, area: string): DoctorFinding[] {
  if (probe.failed === true)
    return [{ severity: 'unknown', area, detail: probe.summary }];
  if (probe.degraded === true) return [{ severity: 'warn', area, detail: probe.summary }];
  return [];
}

/**
 * Startup problems the doctor already judges in its own, more specific words.
 * Echoing them as configuration findings would print the same defect twice
 * with two different remedies:
 *   * `no-access-token` — the token block's "No credential is configured" fail;
 *   * `page-token-unbound` — the token block's page-binding check, which also
 *     names the Page the token belongs to;
 *   * `no-page` — the metric probes deliberately stay quiet without a Page,
 *     and the report says so in the probe line.
 */
export const STARTUP_CODES_JUDGED_ELSEWHERE: ReadonlySet<string> = new Set([
  'no-access-token',
  'page-token-unbound',
  'no-page',
]);

/**
 * Configuration findings. A package selection that does not resolve is a `fail`
 * and outranks everything else in the report: the server refuses to start on it,
 * so no amount of healthy token or usable packages makes the install serviceable.
 * A startup error from `loadSettings()` is the same kind of thing (the server
 * throws before it listens) and is a `fail` too; a startup warning is the
 * loader's own severity, kept as `warn`.
 */
function configurationFindings(
  packageSelectionError: string | undefined,
  startupProblems: readonly StartupProblem[] | undefined,
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  if (packageSelectionError !== undefined) {
    findings.push({
      severity: 'fail',
      area: 'configuration',
      detail:
        `The tool package selection does not resolve (${packageSelectionError}) — the ` +
        'server will refuse to start until it is fixed, and the package matrix below ' +
        'was built over every package rather than the ones this install selects.',
    });
  }
  for (const problem of startupProblems ?? []) {
    if (STARTUP_CODES_JUDGED_ELSEWHERE.has(problem.code)) continue;
    findings.push(
      problem.severity === 'error'
        ? {
            severity: 'fail',
            area: 'configuration',
            detail: `${problem.message} The server will refuse to start until this is fixed.`,
          }
        : { severity: 'warn', area: 'configuration', detail: problem.message },
    );
  }
  return findings;
}

/**
 * A version header is a `warn`, never a `fail`: the call it rode on was
 * answered. But it is the last notice before Meta stops answering on that
 * version — the Marketing API rejects a changed endpoint with `#2635` once it
 * has auto-upgraded the call — so `--strict` must not wave it through as `ok`.
 */
function versionDriftFindings(
  signals: readonly VersionDriftSignal[] | undefined,
): DoctorFinding[] {
  return (signals ?? []).map((signal) => ({
    severity: 'warn',
    area: 'api version',
    detail: describeVersionDrift(signal),
  }));
}

/**
 * Reduce a finished report to one verdict.
 *
 * Exported (and taking the report minus its own summary) so the rule set is
 * testable without a Graph double, and so a caller holding a report from
 * elsewhere can re-derive the verdict rather than trust a stored one.
 */
export function summarizeDoctor(
  report: Omit<DoctorReport, 'summary'>,
  launchCommand: string = DEFAULT_LAUNCH_COMMAND,
): DoctorSummary {
  const findings = [
    ...configurationFindings(report.packageSelectionError, report.startupProblems),
    ...tokenFindings(report.token, launchCommand),
    ...matrixFindings(report.matrix),
    ...credentialFileFindings(report.credentialFile),
    ...credentialFileFindings(report.activityStateFile, 'activity state file'),
    ...metricSetFindings(report.metricSet),
    ...probeFindings(report.metricProbe, 'metric probe'),
    ...probeFindings(report.adAccount, 'ad account'),
    ...versionDriftFindings(report.versionDrift),
  ].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

  const verdict = findings.reduce<DoctorVerdict>(
    (worst, finding) =>
      worst === 'ok' || SEVERITY_RANK[finding.severity] > SEVERITY_RANK[worst]
        ? finding.severity
        : worst,
    'ok',
  );
  return { verdict, findings };
}

/**
 * Process exit code for a verdict.
 *
 * Without `--strict` the doctor is a report, and a report that exits non-zero
 * breaks every wrapper that runs it for the text — so the default stays 0 no
 * matter what it found. `--strict` is the opt-in that turns it into a gate:
 * 2 for a configuration that cannot work, 1 for one that is degraded or was
 * never established.
 */
export function doctorExitCode(verdict: DoctorVerdict, strict: boolean): number {
  if (!strict || verdict === 'ok') return 0;
  return verdict === 'fail' ? 2 : 1;
}
