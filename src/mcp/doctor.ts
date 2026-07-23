// `facebook doctor` diagnostic (task F16).
//
// A single pre-flight command that answers "will my token actually let these
// tools work?" without touching a real Page. It produces three things:
//
//   1. A TOKEN report — type / validity / granted scopes / credential + expiry,
//      including never-expiring detection (Graph `expires_at` 0 ⇒ undefined,
//      the System-User signature — doc 04) and an "expiring soon" flag.
//   2. A PERMISSION x PACKAGE matrix — cross-references the granted scopes
//      against the LOADED packages (injected via `deps.packages`, not a
//      hard-coded import, so the matrix auto-expands when the Wave-4 verticals
//      land). Each package is usable / partially-usable (which tools blocked) /
//      blocked (missing scope) / unknown (no mapping). Granted scopes no loaded
//      package needs are flagged as over-scope (doc 04: business_management is
//      setup-only and should not ride on a runtime token).
//   3. An optional METRIC PROBE — a seam the insights package (V02) plugs into.
//      Absent ⇒ a plain "unavailable" line; this module never imports insights,
//      which would violate the layer rules and couple the doctor to a vertical.
//
// Layer 2 (`mcp`): imports the frozen `core` contracts + `core.debugToken`, and
// receives everything else (packages, fbRequest, clock, ...) injected. No
// runtime Zod here (quarantined to `define.ts`). No `tools` import.

import {
  debugToken,
  type Clock,
  type FbRequestFn,
  type Logger,
  type PackageName,
  type PackageSpec,
  type Redactor,
  type Settings,
  type TokenType,
} from '../core/index.js';

// ---------------------------------------------------------------------------
// Static permission tables (the corpus's permission -> capability map, doc 04/06)
// ---------------------------------------------------------------------------

/**
 * The Meta permissions each PACKAGE requires (union across its tools) — the
 * headline scope list the doctor cross-references. A package absent from this
 * table renders as `unknown`. `business_management` is deliberately NOT here:
 * it is a setup-only permission that should not ride on a runtime token (doc
 * 04), so a granted `business_management` surfaces as over-scope instead.
 */
export const PACKAGE_PERMISSIONS: Partial<Record<PackageName, readonly string[]>> = {
  core: ['pages_show_list', 'pages_read_engagement'],
  reader: ['pages_read_engagement', 'pages_read_user_content'],
  posts: ['pages_manage_posts', 'pages_read_engagement'],
  insights: ['read_insights'],
  moderation: ['pages_read_user_content', 'pages_manage_engagement'],
  messages: ['pages_messaging', 'pages_manage_metadata'],
  ads: ['ads_read', 'ads_management'],
};

/**
 * Finer per-TOOL permission requirements, keyed by tool name, refining the
 * package-level table so the matrix can report exactly which tools are blocked
 * (doc 06 "reports exactly which tools will and won't work"). A tool absent
 * from this table inherits its package's full required set. Entries beyond the
 * `core` tools are inferred from the doc 04/06 capability map for the Wave-4
 * verticals so the matrix is meaningful the moment those packages are injected.
 */
export const TOOL_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  // core (this task)
  facebook_whoami: [],
  facebook_list_pages: ['pages_show_list'],
  facebook_get_page: ['pages_read_engagement'],
  facebook_usage: [],

  // reader (V01)
  facebook_list_posts: ['pages_read_engagement'],
  facebook_get_post: ['pages_read_engagement'],
  facebook_list_reels: ['pages_read_engagement'],
  facebook_get_reactions: ['pages_read_engagement'],

  // posts (V03/V04)
  facebook_create_post: ['pages_manage_posts'],
  facebook_create_photo_post: ['pages_manage_posts'],
  facebook_create_video_post: ['pages_manage_posts'],
  facebook_create_reel: ['pages_manage_posts'],
  facebook_update_post: ['pages_manage_posts'],
  facebook_delete_post: ['pages_manage_posts'],
  facebook_list_scheduled_posts: ['pages_read_engagement'],

  // insights (V02)
  facebook_page_insights: ['read_insights'],
  facebook_post_insights: ['read_insights'],

  // moderation (V05/V06) — the delete/private-reply split (doc 04, CC-AUTH-4)
  facebook_list_comments: ['pages_read_user_content'],
  facebook_get_comment: ['pages_read_user_content'],
  facebook_reply_to_comment: ['pages_manage_engagement'],
  facebook_hide_comment: ['pages_manage_engagement'],
  facebook_delete_comment: ['pages_manage_engagement', 'pages_read_user_content'],
  facebook_private_reply: ['pages_messaging', 'pages_manage_engagement'],

  // messages (V07)
  facebook_list_conversations: ['pages_messaging', 'pages_manage_metadata'],
  facebook_get_conversation: ['pages_messaging', 'pages_manage_metadata'],
  facebook_send_message: ['pages_messaging'],

  // ads (V08/V09/V10)
  facebook_list_campaigns: ['ads_read'],
  facebook_list_adsets: ['ads_read'],
  facebook_list_ads: ['ads_read'],
  facebook_get_ad_object: ['ads_read'],
  facebook_ads_insights: ['ads_read'],
  facebook_update_ad_object: ['ads_management'],
};

/** A token within this window of expiry (or already past it) is "expiring soon". */
export const EXPIRY_SOON_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Metric-probe seam (insights V02 plugs in here; the doctor never imports it)
// ---------------------------------------------------------------------------

/** Context handed to an injected {@link MetricProbe}. */
export interface MetricProbeContext {
  readonly fbRequest: FbRequestFn;
  readonly settings: Settings;
  readonly clock: Clock;
  readonly signal?: AbortSignal;
}

/** What a {@link MetricProbe} returns; folded verbatim into the report. */
export interface MetricProbeResult {
  readonly available: boolean;
  readonly summary: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Optional insights-metric probe seam (V02). */
export type MetricProbe = (ctx: MetricProbeContext) => Promise<MetricProbeResult>;

// ---------------------------------------------------------------------------
// Report shapes
// ---------------------------------------------------------------------------

/** Per-package cross-reference verdict. */
export type PackageUsability = 'usable' | 'partial' | 'blocked' | 'unknown';

/** Token slice of the doctor report. */
export interface DoctorTokenReport {
  /** Whether any runtime token is configured at all. */
  readonly configured: boolean;
  readonly type: TokenType;
  readonly valid: boolean;
  readonly appId?: string;
  readonly scopes: readonly string[];
  /** Epoch ms; absent ⇒ never-expiring (Graph `expires_at` 0). */
  readonly expiresAt?: number;
  /** `true` only for a VALID token with no expiry — the System-User signature. */
  readonly neverExpiring: boolean;
  /** Within {@link EXPIRY_SOON_MS} of expiry (or already past). */
  readonly expiringSoon: boolean;
  readonly dataAccessExpiresAt?: number;
  readonly actingUserId?: string;
  readonly actingPageId?: string;
  /** Set when no token is configured or `debug_token` failed (redacted). */
  readonly error?: string;
}

/** One row of the permission x package matrix. */
export interface PackageMatrixRow {
  readonly package: string;
  readonly status: PackageUsability;
  readonly requiredPermissions: readonly string[];
  readonly missingPermissions: readonly string[];
  /** Tools that cannot run under the granted scopes (populated for `partial`). */
  readonly blockedTools: readonly string[];
}

/** Metric-probe slice of the report. */
export interface MetricProbeReport {
  readonly available: boolean;
  readonly summary: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** The full machine-readable doctor result (rendered by {@link renderDoctorReport}). */
export interface DoctorReport {
  readonly serverVersion: string;
  readonly apiVersion: string;
  readonly generatedAt: number;
  readonly token: DoctorTokenReport;
  readonly matrix: readonly PackageMatrixRow[];
  /** Granted scopes no loaded package needs (e.g. setup-only business_management). */
  readonly overScopePermissions: readonly string[];
  readonly metricProbe: MetricProbeReport;
}

/** Injected inputs for {@link runDoctor}. */
export interface DoctorDeps {
  readonly fbRequest: FbRequestFn;
  readonly settings: Settings;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly redactor: Redactor;
  /** The LOADED packages (injected by I1); the matrix is built over these. */
  readonly packages: readonly PackageSpec[];
  readonly serverVersion: string;
  /** Optional insights probe (V02). Absent ⇒ "metric probe: unavailable". */
  readonly metricProbe?: MetricProbe;
}

// ---------------------------------------------------------------------------
// Token credential helpers (mirror `tools/core.ts` — both are layer-isolated)
// ---------------------------------------------------------------------------

function runtimeToken(settings: Settings): string | undefined {
  return settings.systemToken ?? settings.accessToken ?? settings.pageToken;
}

function debugCredential(settings: Settings, token: string): string {
  return settings.appId !== undefined && settings.appSecret !== undefined
    ? `${settings.appId}|${settings.appSecret}`
    : token;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

async function inspectToken(deps: DoctorDeps, now: number): Promise<DoctorTokenReport> {
  const { settings } = deps;
  const runtime = runtimeToken(settings);
  if (runtime === undefined) {
    return {
      configured: false,
      type: 'UNKNOWN',
      valid: false,
      scopes: [],
      neverExpiring: false,
      expiringSoon: false,
      error:
        'No access token configured — set FB_ACCESS_TOKEN, FB_SYSTEM_TOKEN, or FB_PAGE_TOKEN.',
    };
  }
  try {
    const info = await debugToken(runtime, {
      fbRequest: deps.fbRequest,
      accessToken: debugCredential(settings, runtime),
    });
    return {
      configured: true,
      type: info.type,
      valid: info.valid,
      appId: info.appId,
      scopes: info.scopes,
      expiresAt: info.expiresAt,
      neverExpiring: info.valid && info.expiresAt === undefined,
      expiringSoon:
        info.expiresAt !== undefined && info.expiresAt - now <= EXPIRY_SOON_MS,
      dataAccessExpiresAt: info.dataAccessExpiresAt,
      actingUserId: info.userId,
      actingPageId: info.profileId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      configured: true,
      type: 'UNKNOWN',
      valid: false,
      scopes: [],
      neverExpiring: false,
      expiringSoon: false,
      error: deps.redactor.redactString(message),
    };
  }
}

function buildMatrix(
  packages: readonly PackageSpec[],
  granted: ReadonlySet<string>,
): PackageMatrixRow[] {
  return packages.map((pkg) => {
    const required = PACKAGE_PERMISSIONS[pkg.name as PackageName];
    if (required === undefined) {
      return {
        package: pkg.name,
        status: 'unknown',
        requiredPermissions: [],
        missingPermissions: [],
        blockedTools: [],
      };
    }
    const missingPermissions = required.filter((perm) => !granted.has(perm));
    const blockedTools = pkg.tools
      .filter((tool) => {
        const toolReq = TOOL_PERMISSIONS[tool.name] ?? required;
        return toolReq.some((perm) => !granted.has(perm));
      })
      .map((tool) => tool.name);

    const total = pkg.tools.length;
    const blocked = blockedTools.length;
    let status: PackageUsability;
    if (total === 0) {
      status = missingPermissions.length === 0 ? 'usable' : 'blocked';
    } else if (blocked === 0) {
      status = 'usable';
    } else if (blocked === total) {
      status = 'blocked';
    } else {
      status = 'partial';
    }
    return {
      package: pkg.name,
      status,
      requiredPermissions: required,
      missingPermissions,
      blockedTools,
    };
  });
}

function computeOverScope(
  packages: readonly PackageSpec[],
  granted: ReadonlySet<string>,
): string[] {
  const needed = new Set<string>();
  for (const pkg of packages) {
    for (const perm of PACKAGE_PERMISSIONS[pkg.name as PackageName] ?? []) {
      needed.add(perm);
    }
    for (const tool of pkg.tools) {
      for (const perm of TOOL_PERMISSIONS[tool.name] ?? []) {
        needed.add(perm);
      }
    }
  }
  return [...granted].filter((scope) => !needed.has(scope)).sort();
}

async function runMetricProbe(deps: DoctorDeps): Promise<MetricProbeReport> {
  if (deps.metricProbe === undefined) {
    return {
      available: false,
      summary:
        'metric probe: unavailable (no insights probe wired — enable the insights package to surface Page/Post reach diagnostics).',
    };
  }
  try {
    const result = await deps.metricProbe({
      fbRequest: deps.fbRequest,
      settings: deps.settings,
      clock: deps.clock,
    });
    return {
      available: result.available,
      summary: result.summary,
      ...(result.details !== undefined ? { details: result.details } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      summary: `metric probe: failed (${deps.redactor.redactString(message)})`,
    };
  }
}

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

  return {
    serverVersion: deps.serverVersion,
    apiVersion: deps.settings.apiVersion,
    generatedAt: now,
    token,
    matrix: buildMatrix(deps.packages, granted),
    overScopePermissions: computeOverScope(deps.packages, granted),
    metricProbe: await runMetricProbe(deps),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<PackageUsability, string> = {
  usable: 'OK',
  partial: 'PARTIAL',
  blocked: 'BLOCKED',
  unknown: 'UNKNOWN',
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function fmtList(items: readonly string[]): string {
  return items.length > 0 ? items.join(', ') : '(none)';
}

function describeExpiry(token: DoctorTokenReport): string {
  if (!token.configured) return 'n/a (no token configured)';
  if (token.neverExpiring) {
    return 'never (non-expiring token — typical for a System-User token; keep it secret)';
  }
  if (token.expiresAt === undefined) return 'unknown';
  const when = iso(token.expiresAt);
  return token.expiringSoon ? `${when} (EXPIRING SOON — refresh the token)` : when;
}

function matrixRowDetail(row: PackageMatrixRow): string {
  switch (row.status) {
    case 'usable':
      return `required: ${fmtList(row.requiredPermissions)}`;
    case 'blocked':
      return `missing: ${fmtList(row.missingPermissions)}`;
    case 'partial':
      return `missing: ${fmtList(row.missingPermissions)}; blocked tools: ${fmtList(
        row.blockedTools,
      )}`;
    case 'unknown':
      return 'no permission mapping (package not in PACKAGE_PERMISSIONS)';
  }
}

function renderMatrixRow(row: PackageMatrixRow): string {
  return `  [${STATUS_LABEL[row.status]}] ${row.package.padEnd(11)} ${matrixRowDetail(row)}`;
}

/** Render a {@link DoctorReport} as a plain-text operator report. */
export function renderDoctorReport(report: DoctorReport): string {
  const t = report.token;
  const acting =
    t.actingUserId !== undefined
      ? `user ${t.actingUserId}`
      : t.actingPageId !== undefined
        ? `page ${t.actingPageId}`
        : '-';

  const lines: string[] = [
    'facebook-mcp doctor',
    '===================',
    '',
    'Server',
    `  version:      ${report.serverVersion}`,
    `  API version:  ${report.apiVersion}`,
    `  generated at: ${iso(report.generatedAt)}`,
    '',
    'Token',
    `  configured:   ${t.configured ? 'yes' : 'no'}`,
    `  type:         ${t.type}`,
    `  valid:        ${t.valid ? 'yes' : 'no'}`,
    `  app id:       ${t.appId ?? '-'}`,
    `  acting as:    ${acting}`,
    `  scopes:       ${fmtList(t.scopes)}`,
  ];
  if (t.error !== undefined) lines.push(`  error:        ${t.error}`);
  lines.push(
    '',
    'Credential / expiry',
    `  token expiry: ${describeExpiry(t)}`,
    `  data access:  ${t.dataAccessExpiresAt !== undefined ? iso(t.dataAccessExpiresAt) : '-'}`,
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
  return lines.join('\n');
}
