// Plain-text rendering of a doctor report (shared).

import { type GranularScope } from '../../core/index.js';
import { describePageBinding } from './credentials.js';
import { APP_CREDENTIAL_REJECTION, STARTUP_CODES_JUDGED_ELSEWHERE } from './findings.js';
import { STATUS_LABEL, fmtList, matrixRowDetail } from './format.js';
import {
  type AssetAccess,
  type CredentialFileReport,
  type CredentialSource,
  type DoctorReport,
  type DoctorTokenReport,
  type DoctorVerdict,
  type MetricSetVerdict,
  type MetricVerdictStatus,
  type PackageMatrixRow,
} from './types.js';

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render an epoch, or say plainly that it could not be read. `new Date(ms)` is
 * an Invalid Date for a `NaN` or out-of-range epoch, and `toISOString()` on one
 * throws `RangeError: Invalid time value` — from inside the renderer, so a
 * single unreadable number costs the operator not that line but the entire
 * report, at the exact moment they ran this command to find out what was wrong.
 * A bad line is still a diagnosis; a renderer that throws is not.
 */
function iso(ms: number): string {
  const at = new Date(ms);
  return Number.isNaN(at.getTime()) ? '(unreadable timestamp)' : at.toISOString();
}

function describeExpiry(token: DoctorTokenReport): string {
  if (!token.configured) return 'n/a (no token configured)';
  if (token.neverExpiring) {
    return 'never (non-expiring token — typical for a System-User token; keep it secret)';
  }
  if (token.expiryUnknown) {
    return "unknown — Graph's debug_token answer carried no usable expires_at";
  }
  // Invalid or unchecked token: there is no expiry to describe, and the
  // diagnosis line above already says why.
  if (token.expiresAt === undefined) return 'unknown';
  const when = iso(token.expiresAt);
  return token.expiringSoon ? `${when} (EXPIRING SOON — refresh the token)` : when;
}

function describeDataAccess(token: DoctorTokenReport): string {
  if (token.dataAccessExpiresAt === undefined) return '-';
  const when = iso(token.dataAccessExpiresAt);
  return token.dataAccessExpiringSoon === true
    ? `${when} (EXPIRING SOON — re-authorize, then re-issue the token)`
    : when;
}

/** Human wording for {@link CredentialSource}, including the "which one won" part. */
const CREDENTIAL_LABEL: Record<CredentialSource, string> = {
  FB_SYSTEM_TOKEN: 'FB_SYSTEM_TOKEN (system-user token)',
  FB_ACCESS_TOKEN: 'FB_ACCESS_TOKEN (user token)',
  FB_PAGE_TOKEN: 'FB_PAGE_TOKEN (long-lived Page token)',
  none: 'none (no credential configured)',
};

/** The CC-AUTH-5 verdict in operator language — what to actually go and fix. */
function describeDiagnosis(token: DoctorTokenReport): string {
  switch (token.diagnosis) {
    case 'ok':
      return 'ok';
    case 'no_token':
      return 'no token configured';
    case 'token_malformed':
      if (token.debugCallRejected?.authenticatedWith === 'app_credential') {
        return `TOKEN OR APP CREDENTIAL REJECTED — ${APP_CREDENTIAL_REJECTION}`;
      }
      return (
        'TOKEN MALFORMED OR INVALID — debug_token did not accept this token. ' +
        'Re-issue it and update the credential env var; this is not an asset ' +
        'permission problem.'
      );
    case 'token_check_failed':
      return (
        'TOKEN NOT CHECKED — debug_token could not be reached, so nothing is ' +
        'known about this credential either way. Do NOT re-issue it yet: fix ' +
        'the connection first (see the error line below — it carries the ' +
        'proxy hint), then re-run the doctor.'
      );
    case 'asset_access_revoked':
      return (
        'ASSET ACCESS REVOKED — the token itself is valid and still carries ' +
        'asset-scoped permissions, but granular_scopes names no target asset. ' +
        'The system user was deleted, the app was removed from the Business, or ' +
        'the Page / ad-account grant was withdrawn. Re-grant the assets in ' +
        'Business settings — re-issuing the token alone will not fix it.'
      );
  }
}

/** Render `granular_scopes` as `scope -> id,id`, keeping empty grants visible. */
function fmtGranularScopes(scopes: readonly GranularScope[]): string {
  if (scopes.length === 0) return '(not reported)';
  return scopes.map((entry) => `${entry.scope} -> ${fmtGrantTargets(entry)}`).join('; ');
}

/** A grant with no `target_ids` covers every asset; an empty list covers none. */
function fmtGrantTargets(entry: GranularScope): string {
  if (entry.appliesToAllTargets === true) return '(all assets)';
  return entry.targetIds.length > 0 ? entry.targetIds.join(',') : '(no assets)';
}

const ASSET_ACCESS_LABEL: Record<AssetAccess, string> = {
  ok: 'ok (at least one asset still granted)',
  revoked: 'REVOKED (asset-scoped permissions with no target asset)',
  not_reported: 'not reported by Graph',
};

/** Describe the credential file honestly — observed bits, never a claimed 0600. */
function describeCredentialFile(file: CredentialFileReport): string {
  if (!file.exists) return file.note;
  if (!file.posixPermissions) return `WARNING: ${file.note}`;
  const octal =
    file.mode !== undefined ? `0${file.mode.toString(8).padStart(3, '0')}` : '?';
  return file.ownerOnly === true
    ? `${octal} — owner-only, as intended`
    : `${octal} — WARNING: group/other can read this file; run chmod 600 on it`;
}

function renderMatrixRow(row: PackageMatrixRow): string {
  return `  [${STATUS_LABEL[row.status]}] ${row.package.padEnd(11)} ${matrixRowDetail(row)}`;
}

const METRIC_VERDICT_LABEL: Record<MetricVerdictStatus, string> = {
  accepted: 'OK',
  empty: 'EMPTY',
  rejected: 'REJECTED',
  unknown: 'UNKNOWN',
};

function metricVerdictDetail(verdict: MetricSetVerdict): string {
  switch (verdict.status) {
    case 'accepted':
      return `${String(verdict.points ?? 0)} data point(s)`;
    case 'empty':
      return 'accepted by Graph, no data in this window';
    case 'rejected':
      return verdict.error ?? 'refused by Graph';
    case 'unknown':
      return verdict.suggestion ?? 'not established';
  }
}

function renderMetricVerdict(verdict: MetricSetVerdict): string[] {
  const lines = [
    `  [${METRIC_VERDICT_LABEL[verdict.status].padEnd(8)}] ${verdict.metric.padEnd(
      28,
    )} ${metricVerdictDetail(verdict)}`,
  ];
  // Only `rejected` has BOTH an error and advice; `unknown` prints its advice as
  // the detail, so repeating it here would just be noise.
  if (verdict.status === 'rejected' && verdict.suggestion !== undefined) {
    lines.push(`             -> ${verdict.suggestion}`);
  }
  return lines;
}

/** The verdict headline — says what it means, and what `--strict` would do. */
const VERDICT_LINE: Record<DoctorVerdict, string> = {
  ok: 'OK — nothing needs attention.',
  warn: 'WARN — the server will run, but the findings below are worth fixing (--strict exits 1).',
  unknown:
    'UNKNOWN — a check could not be completed, so this configuration is unverified (--strict exits 1).',
  fail: 'FAIL — this configuration cannot serve requests (--strict exits 2).',
};

/**
 * The identity Graph calls are made as. A Page token's `debug_token` answer
 * names BOTH the Page it acts as (`profile_id`) and the user it was issued
 * through (`user_id`); the Page is the identity every call carries, so it leads
 * and the user is kept as provenance. Preferring `user_id` reported a Page token
 * as "acting as: user N" — false on the wire, and contradicted by the page
 * binding line rendered right under it.
 */
function describeActing(t: DoctorTokenReport): string {
  if (t.actingPageId !== undefined) {
    return t.actingUserId !== undefined
      ? `page ${t.actingPageId} (issued to user ${t.actingUserId})`
      : `page ${t.actingPageId}`;
  }
  return t.actingUserId !== undefined ? `user ${t.actingUserId}` : '-';
}

/** Render a {@link DoctorReport} as a plain-text operator report. */
export function renderDoctorReport(report: DoctorReport): string {
  const t = report.token;
  const acting = describeActing(t);

  const lines: string[] = [
    'facebook-mcp doctor',
    '===================',
    '',
    'Server',
    `  version:      ${report.serverVersion}`,
    `  API version:  ${report.apiVersion}`,
    `  Ads API:      ${report.adsApiVersion} (Marketing API, ads package)`,
    `  generated at: ${iso(report.generatedAt)}`,
  ];
  for (const signal of report.versionDrift ?? []) {
    // Under the pins they contradict: the operator reads "Ads API: v26.0" and,
    // directly beneath it, that Meta answered on something else.
    lines.push(
      `  VERSION DRIFT: ${signal.header}: "${signal.value}" (requested ${signal.requestedVersion})`,
    );
  }
  // The same set the findings use, so the block and the verdict name the same
  // blockers (a missing credential is the token block's line, not this one's).
  const startupErrors = (report.startupProblems ?? []).filter(
    (problem) =>
      problem.severity === 'error' && !STARTUP_CODES_JUDGED_ELSEWHERE.has(problem.code),
  );
  if (report.packageSelectionError !== undefined || startupErrors.length > 0) {
    // Above the token block on purpose: nothing below it can be acted on until
    // the server starts, and these are the reasons it will not. (Startup
    // warnings are not blockers; they surface as findings under the verdict.)
    lines.push('', 'Configuration');
    if (report.packageSelectionError !== undefined) {
      lines.push(`  packages:     WILL NOT START — ${report.packageSelectionError}`);
    }
    for (const problem of startupErrors) {
      const label = `${problem.field ?? problem.code}:`.padEnd(13);
      lines.push(`  ${label} WILL NOT START — ${problem.message}`);
    }
  }
  lines.push(
    '',
    'Token',
    `  configured:   ${t.configured ? 'yes' : 'no'}`,
    `  credential:   ${CREDENTIAL_LABEL[t.credentialSource]}`,
  );
  if (t.shadowedCredentials.length > 0) {
    // Silent precedence is the whole trap of CC-AUTH-9 — name the losers.
    lines.push(
      `  shadowed:     ${t.shadowedCredentials.join(', ')} (also set, NOT used)`,
    );
  }
  // debug_token never answered: validity, scopes and asset grants were never
  // observed, and "no" / "(none)" / "not reported by Graph" would each state
  // something Graph was never asked.
  const unchecked = t.diagnosis === 'token_check_failed';
  // Graph refused the call itself: no scope or grant list came back, and under
  // the app credential it is not even known which credential was refused.
  const scopesUnseen = unchecked || t.debugCallRejected !== undefined;
  const validityUnseen =
    unchecked || t.debugCallRejected?.authenticatedWith === 'app_credential';
  const UNCHECKED = 'unknown (not checked)';
  lines.push(
    `  type:         ${t.type}`,
    `  valid:        ${validityUnseen ? UNCHECKED : t.valid ? 'yes' : 'no'}`,
    `  app id:       ${t.appId ?? '-'}`,
    `  acting as:    ${acting}`,
  );
  const binding =
    t.pageBinding !== undefined ? describePageBinding(t.pageBinding) : undefined;
  if (binding !== undefined) {
    // Next to the identity it is about: the operator is reading "acting as:
    // page N" when they need to know that N is the id to configure.
    lines.push(`  page binding: ${binding}`);
  }
  lines.push(
    `  scopes:       ${scopesUnseen ? UNCHECKED : fmtList(t.scopes)}`,
    `  granular:     ${scopesUnseen ? UNCHECKED : fmtGranularScopes(t.granularScopes)}`,
    `  asset access: ${scopesUnseen ? UNCHECKED : ASSET_ACCESS_LABEL[t.assetAccess]}`,
    `  diagnosis:    ${describeDiagnosis(t)}`,
  );
  if (t.error !== undefined) lines.push(`  error:        ${t.error}`);
  lines.push(
    '',
    'Credential / expiry',
    `  token expiry: ${describeExpiry(t)}`,
    `  data access:  ${describeDataAccess(t)}`,
    `  cred file:    ${report.credentialFile.path}`,
    `  protection:   ${describeCredentialFile(report.credentialFile)}`,
    ...(report.activityStateFile !== undefined
      ? [
          `  state file:   ${report.activityStateFile.path}`,
          `  protection:   ${describeCredentialFile(report.activityStateFile)}`,
        ]
      : []),
    '',
    'Permission x package matrix',
  );
  if (report.matrix.length === 0) {
    lines.push('  (no packages loaded)');
  } else {
    for (const row of report.matrix) lines.push(renderMatrixRow(row));
  }
  if (report.overScopePermissions.length > 0) {
    lines.push(
      '',
      `  over-scope (granted but unused by loaded packages): ${report.overScopePermissions.join(
        ', ',
      )}`,
    );
  }
  lines.push('', 'Metric probe', `  ${report.metricProbe.summary}`);

  lines.push('', 'Insights metric set', `  ${report.metricSet.summary}`);
  for (const verdict of report.metricSet.verdicts) {
    lines.push(...renderMetricVerdict(verdict));
  }
  if (report.metricSet.notes.length > 0) {
    lines.push('');
    for (const note of report.metricSet.notes) lines.push(`  ${note}`);
  }

  lines.push('', 'Ad account', `  ${report.adAccount.summary}`);

  // The verdict goes LAST: it summarises what was just printed, and in a
  // terminal the end of the report is the part sitting next to the prompt.
  lines.push('', 'Verdict', `  ${VERDICT_LINE[report.summary.verdict]}`);
  for (const finding of report.summary.findings) {
    lines.push(
      `  [${finding.severity.toUpperCase().padEnd(7)}] ${finding.area}: ${finding.detail}`,
    );
  }
  return lines.join('\n');
}
