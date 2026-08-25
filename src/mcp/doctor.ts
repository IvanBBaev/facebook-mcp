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
//   4. An INSIGHTS METRIC-SET PROBE (C6 / CC-INS-1) — asks the live API, name by
//      name, whether the metric set this server documents still exists. Meta
//      renames and retires Page-insights metrics constantly and the failure mode
//      is SILENT: a retired name makes Graph fail the whole call, and a name
//      that survives but has no data returns an empty series that reads exactly
//      like "your Page is dead". The probe separates the three cases so the
//      operator learns which of them they are in. Unlike (3) it needs no
//      injection: it speaks Graph's `/insights` edge directly through the
//      injected `fbRequest`, so it stays free of api-layer imports.
//
// Layer 2 (`mcp`): imports the frozen `core` contracts + `core.debugToken`, and
// receives everything else (packages, fbRequest, clock, ...) injected. No
// runtime Zod here (quarantined to `define.ts`). No `tools` import.

import {
  GraphApiError,
  debugToken,
  envFilePath,
  statFileProtection,
  type Clock,
  type FbRequestFn,
  type GranularScope,
  type Logger,
  type PackageName,
  type PackageSpec,
  type ParamValue,
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
  facebook_reel_insights: ['read_insights'],

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
  facebook_ads_report_status: ['ads_read'],
  facebook_update_ad_object: ['ads_management'],
};

/** A token within this window of expiry (or already past it) is "expiring soon". */
export const EXPIRY_SOON_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Insights metric set (C6 / CC-INS-1) — what the probe asks the live API about
// ---------------------------------------------------------------------------

/**
 * One Page-insights metric this server ships as live, plus the dead names Meta's
 * rename waves mapped onto it.
 *
 * `replaces` is the lineage, newest-last: if Graph now rejects `metric` itself,
 * the operator learns that the wave which produced it has moved on AGAIN, and
 * that hunting for the old name in Meta's changelog is the way to find the new
 * one. It is deliberately the mirror image of the api layer's deprecation table
 * — the doctor may not import that layer, so a test asserts the two agree.
 */
export interface ProbedMetric {
  readonly metric: string;
  /** Retired names this metric took over from, oldest first. */
  readonly replaces?: readonly string[];
  /** Anything the operator should know even when the name is accepted. */
  readonly note?: string;
}

/**
 * The Page metric set the server documents and the doctor verifies.
 *
 * Keep this list, the api layer's deprecation table and the README metric table
 * in step — that is exactly the drift this probe exists to catch.
 */
export const PROBED_PAGE_METRICS: readonly ProbedMetric[] = [
  { metric: 'page_media_view', replaces: ['page_impressions'] },
  { metric: 'page_post_engagements', replaces: ['page_engaged_users'] },
  { metric: 'page_follows', replaces: ['page_fans'] },
  { metric: 'page_daily_follows', replaces: ['page_fan_adds'] },
  { metric: 'page_daily_follows_unique', replaces: ['page_fan_adds_unique'] },
  { metric: 'page_daily_unfollows', replaces: ['page_fan_removes'] },
  { metric: 'page_daily_unfollows_unique', replaces: ['page_fan_removes_unique'] },
  {
    metric: 'page_video_views',
    note: 'the *_unique variant was retired with no deduplicated replacement',
  },
];

/**
 * The probe asks for one period only. `day` is what the api layer defaults to
 * for Page scope, so this measures the metric set as callers actually meet it.
 */
export const METRIC_PROBE_PERIOD = 'day';

/** A health check, not a data pull: three days is enough to prove a name lives. */
export const METRIC_PROBE_WINDOW_DAYS = 3;

/** Graph refuses Page-insights windows wider than this; we stay far inside it. */
export const METRIC_PROBE_MAX_WINDOW_DAYS = 90;

/**
 * Below roughly this many likes/followers a Page is not eligible for insights and
 * Graph answers every metric with an empty series (CC-INS-2). Mirrors the api
 * layer's constant of the same meaning; a test asserts the two agree.
 */
export const METRIC_PROBE_LIKES_FLOOR = 100;

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

/**
 * Optional ad-account health seam (V09, CC-ADS-6). Same shape and the same
 * reason as {@link MetricProbe}: the doctor must not import the ads api module,
 * so the bootstrap injects the read. A blocked or unfunded ad account fails
 * every ads write with an error that looks like a permission problem but is not
 * fixable from the API — surfacing it here turns a confusing runtime failure
 * into a startup diagnostic.
 */
export type AdAccountProbe = (ctx: MetricProbeContext) => Promise<MetricProbeResult>;

// ---------------------------------------------------------------------------
// Report shapes
// ---------------------------------------------------------------------------

/** Per-package cross-reference verdict. */
export type PackageUsability = 'usable' | 'partial' | 'blocked' | 'unknown';

/**
 * Which env var actually supplied the runtime token (CC-AUTH-9). The precedence
 * is `FB_SYSTEM_TOKEN` > `FB_ACCESS_TOKEN` > `FB_PAGE_TOKEN`; setting two is
 * legal and silent, so the doctor names the winner instead of leaving the
 * operator to guess which of their tokens is under test.
 */
export type CredentialSource =
  'FB_SYSTEM_TOKEN' | 'FB_ACCESS_TOKEN' | 'FB_PAGE_TOKEN' | 'none';

/**
 * What `granular_scopes` says about the token's asset grants (CC-AUTH-5):
 *   * `ok` — at least one asset-scoped permission still names a target asset;
 *   * `revoked` — asset-scoped permissions are present but NONE names a target;
 *     the system user was deleted or the app lost the Business asset;
 *   * `not_reported` — Graph listed no asset-scoped granular entry at all, so
 *     the question cannot be answered (not the same as "revoked").
 */
export type AssetAccess = 'ok' | 'revoked' | 'not_reported';

/**
 * The single verdict CC-AUTH-5 asks for: a token that does not parse is a
 * different repair job from a token that parses but has lost its assets.
 *
 * `token_check_failed` is the fourth, easily-lost case: `debug_token` never
 * answered at all (DNS, proxy, TLS interception, timeout — CC-NET-6). Nothing was
 * learned about the credential, so it must NOT be reported as bad: the doctor is
 * what an operator runs when the network is already broken, and telling them to
 * re-issue a perfectly healthy token sends them off to rotate credentials while
 * the real fault sits in their proxy configuration.
 */
export type TokenDiagnosis =
  'ok' | 'no_token' | 'token_malformed' | 'token_check_failed' | 'asset_access_revoked';

/** Observed protection of the on-disk credential file (CC-CFG-4). */
export interface CredentialFileReport {
  readonly path: string;
  readonly exists: boolean;
  /** True iff no group/other permission bits are set. Absent when unreadable. */
  readonly ownerOnly?: boolean;
  /** `mode & 0o777`, absent when the file could not be stat'd. */
  readonly mode?: number;
  /** Whether this platform enforces POSIX bits at all (false on Windows). */
  readonly posixPermissions: boolean;
  /** The OBSERVED state in words — never a claimed 0600. */
  readonly note: string;
}

/** Token slice of the doctor report. */
export interface DoctorTokenReport {
  /** Whether any runtime token is configured at all. */
  readonly configured: boolean;
  readonly type: TokenType;
  readonly valid: boolean;
  readonly appId?: string;
  readonly scopes: readonly string[];
  /** Which credential env var won the precedence race (CC-AUTH-9). */
  readonly credentialSource: CredentialSource;
  /** Credential env vars that are set but LOST that race — silent otherwise. */
  readonly shadowedCredentials: readonly string[];
  /** Per-asset grants behind `scopes` (CC-AUTH-5); empty when Graph reported none. */
  readonly granularScopes: readonly GranularScope[];
  readonly assetAccess: AssetAccess;
  /** Malformed token vs revoked asset access vs healthy (CC-AUTH-5). */
  readonly diagnosis: TokenDiagnosis;
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

/**
 * What the live API said about ONE metric name.
 *
 * - `accepted` — Graph knows the name and returned data points for it.
 * - `empty`    — Graph knows the name and returned no data. This is DATA, not a
 *                defect: an ineligible Page (CC-INS-2) answers this for every
 *                metric, and so does a quiet window.
 * - `rejected` — Graph refused the name outright. The actionable one: the
 *                shipped metric set has drifted from the live API.
 * - `unknown`  — Not established. Either Graph answered without mentioning the
 *                metric at all (the name is not valid for this object/version),
 *                or the probe stopped before it got that far.
 */
export type MetricVerdictStatus = 'accepted' | 'empty' | 'rejected' | 'unknown';

/** One line of the metric-set probe. */
export interface MetricSetVerdict {
  readonly metric: string;
  readonly status: MetricVerdictStatus;
  /** Non-null data points returned (`accepted` / `empty` only). */
  readonly points?: number;
  /** Graph's own words, redacted (`rejected` only). */
  readonly error?: string;
  /** What the operator should do about it (`rejected` / `unknown` only). */
  readonly suggestion?: string;
  /** Retired names this metric replaced, copied from {@link ProbedMetric}. */
  readonly replaces?: readonly string[];
}

/**
 * Metric-set slice of the report.
 *
 * `skipped` is a first-class outcome, not a failure: the doctor collects every
 * configuration problem in one pass, so a missing token or Page downgrades this
 * check to a stated reason instead of aborting the run.
 */
export type MetricSetOutcome = 'skipped' | 'probed' | 'failed';

/** Result of probing the shipped metric set against the live API (C6/CC-INS-1). */
export interface MetricSetReport {
  readonly outcome: MetricSetOutcome;
  readonly summary: string;
  readonly pageId?: string;
  readonly period?: string;
  /** Window start, `YYYY-MM-DD` UTC. */
  readonly since?: string;
  /** Window end, `YYYY-MM-DD` UTC. */
  readonly until?: string;
  /** Graph calls this check actually spent. Bounded by `1 + metrics.length`. */
  readonly requests: number;
  readonly verdicts: readonly MetricSetVerdict[];
  /** Plain-language caveats; always safe to print verbatim. */
  readonly notes: readonly string[];
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
  /** Live verdict on the shipped Page-insights metric set (C6/CC-INS-1). */
  readonly metricSet: MetricSetReport;
  readonly adAccount: MetricProbeReport;
  /** Observed permissions of the credential file on disk (CC-CFG-4). */
  readonly credentialFile: CredentialFileReport;
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
  /** Optional ad-account health probe (V09). Absent ⇒ "not checked". */
  readonly adAccountProbe?: AdAccountProbe;
  /**
   * Metric names the metric-set probe verifies. Defaults to
   * {@link PROBED_PAGE_METRICS}; injectable so tests (and a future generated
   * README table) can drive the check from their own list.
   */
  readonly metricSet?: readonly ProbedMetric[];
  /**
   * Credential file whose REAL permissions are reported (CC-CFG-4). Defaults to
   * the XDG / `%APPDATA%` env-file path; injectable so the check is testable
   * without touching the operator's own config.
   */
  readonly credentialFilePath?: string;
  /** Platform used to judge file protection; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /**
   * Cancels the diagnostic Graph calls (token debug + both probes). Without it
   * `MetricProbeContext.signal` has no producer, so a probe that hangs on a
   * slow Graph edge cannot be abandoned — a doctor run is several network calls
   * and is the one command an operator reaches for when Graph is misbehaving.
   */
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Token credential helpers (mirror `tools/core.ts` — both are layer-isolated)
// ---------------------------------------------------------------------------

function runtimeToken(settings: Settings): string | undefined {
  return settings.systemToken ?? settings.accessToken ?? settings.pageToken;
}

/** The credential precedence, highest first — must mirror {@link runtimeToken}. */
const CREDENTIAL_PRECEDENCE: readonly (readonly [
  CredentialSource,
  (s: Settings) => string | undefined,
])[] = [
  ['FB_SYSTEM_TOKEN', (s) => s.systemToken],
  ['FB_ACCESS_TOKEN', (s) => s.accessToken],
  ['FB_PAGE_TOKEN', (s) => s.pageToken],
];

/**
 * Name the credential that actually won, plus the ones that are set and lost
 * (CC-AUTH-9). Two tokens configured is legal and produces no error anywhere —
 * naming the winner is the only way an operator can tell which token the rest
 * of this report is about.
 */
export function activeCredential(settings: Settings): {
  source: CredentialSource;
  shadowed: readonly string[];
} {
  const set = CREDENTIAL_PRECEDENCE.filter(([, read]) => read(settings) !== undefined);
  const winner = set[0];
  if (winner === undefined) return { source: 'none', shadowed: [] };
  return { source: winner[0], shadowed: set.slice(1).map(([name]) => name) };
}

/**
 * Permission families Meta grants PER ASSET, and therefore the ones that appear
 * in `granular_scopes` with `target_ids`. A token holding one of these with no
 * target left is the CC-AUTH-5 fingerprint.
 */
const ASSET_SCOPED_PREFIXES = ['pages_', 'ads_', 'instagram_', 'leads_', 'catalog_'];

/** Non-prefixed permissions that are nonetheless granted per asset. */
const ASSET_SCOPED_EXACT = new Set(['business_management', 'read_insights']);

function isAssetScopedPermission(scope: string): boolean {
  return (
    ASSET_SCOPED_EXACT.has(scope) ||
    ASSET_SCOPED_PREFIXES.some((prefix) => scope.startsWith(prefix))
  );
}

/**
 * Read `granular_scopes` for the CC-AUTH-5 verdict. Only asset-scoped
 * permissions are consulted: a user-level permission legitimately has no
 * `target_ids`, so counting it would report a healthy token as revoked.
 */
export function classifyAssetAccess(
  granularScopes: readonly GranularScope[],
): AssetAccess {
  const assetScoped = granularScopes.filter((entry) =>
    isAssetScopedPermission(entry.scope),
  );
  if (assetScoped.length === 0) return 'not_reported';
  return assetScoped.some((entry) => entry.targetIds.length > 0) ? 'ok' : 'revoked';
}

/** Collapse validity + asset access into the one verdict CC-AUTH-5 asks for. */
function diagnose(input: {
  configured: boolean;
  valid: boolean;
  assetAccess: AssetAccess;
}): TokenDiagnosis {
  if (!input.configured) return 'no_token';
  if (!input.valid) return 'token_malformed';
  return input.assetAccess === 'revoked' ? 'asset_access_revoked' : 'ok';
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
  const credential = activeCredential(settings);
  if (runtime === undefined) {
    return {
      configured: false,
      type: 'UNKNOWN',
      valid: false,
      scopes: [],
      credentialSource: credential.source,
      shadowedCredentials: credential.shadowed,
      granularScopes: [],
      assetAccess: 'not_reported',
      diagnosis: 'no_token',
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
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    });
    const granularScopes = info.granularScopes ?? [];
    const assetAccess = classifyAssetAccess(granularScopes);
    return {
      configured: true,
      type: info.type,
      valid: info.valid,
      appId: info.appId,
      scopes: info.scopes,
      credentialSource: credential.source,
      shadowedCredentials: credential.shadowed,
      granularScopes,
      assetAccess,
      diagnosis: diagnose({ configured: true, valid: info.valid, assetAccess }),
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
    // Did Graph actually rule on this token, or did the call never get an answer?
    // A `GraphApiError` carrying an HTTP status is Facebook's verdict; anything
    // else — `httpStatus: 0` (the network-fault shape), a timeout, a body that
    // would not parse — means the credential was never assessed.
    const answered = err instanceof GraphApiError && err.httpStatus >= 400;
    return {
      configured: true,
      type: 'UNKNOWN',
      valid: false,
      scopes: [],
      credentialSource: credential.source,
      shadowedCredentials: credential.shadowed,
      granularScopes: [],
      assetAccess: 'not_reported',
      // debug_token never answered, so asset access is unknowable either way; the
      // two verdicts differ in what the operator should go and fix.
      diagnosis: answered ? 'token_malformed' : 'token_check_failed',
      neverExpiring: false,
      expiringSoon: false,
      error: deps.redactor.redactString(message),
    };
  }
}

/**
 * Report the file protection actually observed on the credential file, not the
 * 0600 the writer claims (CC-CFG-4). A missing file is normal (env-only setups),
 * and a stat failure is reported rather than thrown: the doctor is the command
 * an operator runs when things are already broken.
 */
async function inspectCredentialFile(deps: DoctorDeps): Promise<CredentialFileReport> {
  const platform = deps.platform ?? process.platform;
  const filePath = deps.credentialFilePath ?? envFilePath({ platform });
  try {
    const protection = await statFileProtection(filePath, platform);
    return {
      path: filePath,
      exists: true,
      ownerOnly: protection.ownerOnly,
      mode: protection.mode,
      posixPermissions: protection.posixPermissions,
      note: protection.note,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const posixPermissions = platform !== 'win32';
    if (code === 'ENOENT') {
      return {
        path: filePath,
        exists: false,
        posixPermissions,
        note: 'No credential file — credentials come from the environment only.',
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      path: filePath,
      exists: false,
      posixPermissions,
      note: `Could not read file protection: ${deps.redactor.redactString(message)}`,
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

/**
 * Run one injected probe. A probe that throws is REPORTED, never propagated —
 * the doctor's whole value is that it still prints a report when something is
 * broken, and a probe hitting a blocked account is exactly such a case.
 */
async function runProbe(
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
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      summary: `${label}: failed (${deps.redactor.redactString(message)})`,
    };
  }
}

// ---------------------------------------------------------------------------
// Insights metric-set probe (C6 / CC-INS-1)
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` in UTC — the form Graph accepts for `since` / `until`. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The Page the probe runs against, and where that Page came from. */
interface ProbeTarget {
  readonly pageId: string;
  readonly source: string;
}

/**
 * Pick a Page to probe WITHOUT calling Graph: the default Page if configured,
 * otherwise the alphabetically first profile. Deterministic on purpose — a
 * health check that probes a different Page on every run is not a health check.
 */
function resolveProbePage(settings: Settings): ProbeTarget | undefined {
  const direct = settings.defaultPageId?.trim();
  if (direct !== undefined && direct !== '') {
    return { pageId: direct, source: 'FB_PAGE_ID' };
  }
  const named = Object.entries(settings.profiles)
    .map(([name, profile]) => [name, profile.pageId.trim()] as const)
    .filter(([, pageId]) => pageId !== '')
    .sort(([a], [b]) => a.localeCompare(b))[0];
  if (named === undefined) return undefined;
  return { pageId: named[1], source: `profile "${named[0]}"` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Count the non-null data points Graph returned per metric name.
 *
 * A name ABSENT from the map was never mentioned in the response — that is the
 * silent failure this whole check exists to expose. A name present with 0 is a
 * live metric with nothing to say.
 */
function readMetricPoints(body: unknown): Map<string, number> {
  const points = new Map<string, number>();
  const rows: readonly unknown[] =
    isRecord(body) && Array.isArray(body.data) ? body.data : [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const name = row.name;
    if (typeof name !== 'string') continue;
    const values: readonly unknown[] = Array.isArray(row.values) ? row.values : [];
    const filled = values.filter(
      (point) => isRecord(point) && point.value !== null && point.value !== undefined,
    ).length;
    points.set(name, (points.get(name) ?? 0) + filled);
  }
  return points;
}

/**
 * One insights read through the injected client.
 *
 * No `token` field: the client resolves the credential itself, so the doctor
 * never handles the secret — and nothing here can leak one.
 */
async function requestMetricWindow(
  deps: DoctorDeps,
  pageId: string,
  metrics: readonly string[],
  since: string,
  until: string,
): Promise<unknown> {
  const params: Record<string, ParamValue> = {
    metric: metrics.join(','),
    period: METRIC_PROBE_PERIOD,
    since,
    until,
  };
  const res = await deps.fbRequest<unknown>({
    protocol: 'json',
    method: 'GET',
    host: 'graph',
    path: `/${pageId}/insights`,
    params,
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
  });
  return res.data;
}

/**
 * Did Graph refuse a METRIC NAME, as opposed to the call as a whole?
 *
 * Meta reports a dead metric as a generic `#100` (or `#3001`) whose message
 * names the metric, so the message is the only discriminator available. Same
 * heuristic the api layer uses.
 */
function isMetricRejection(err: unknown): err is GraphApiError {
  return (
    err instanceof GraphApiError &&
    (err.code === 100 || err.code === 3001) &&
    /metric/i.test(err.message)
  );
}

/** Graph's own words, redacted, plus its operator guidance when the taxonomy has any. */
function describeGraphFailure(deps: DoctorDeps, err: unknown): string {
  const message = deps.redactor.redactString(
    err instanceof Error ? err.message : String(err),
  );
  if (!(err instanceof GraphApiError)) return message;
  const subcode = err.subcode !== undefined ? `/${String(err.subcode)}` : '';
  // Meta usually opens its own message with "(#code)". Repeating it reads like a
  // bug, so the prefix is added only when Graph left it out (the subcode rides
  // along with it — Meta's self-labelled messages do not carry one).
  const head = message.includes(`#${String(err.code)}`)
    ? message
    : `(#${String(err.code)}${subcode}) ${message}`;
  const operatorText = err.action?.operatorText;
  return operatorText !== undefined ? `${head} — ${operatorText}` : head;
}

function replacesOf(entry: ProbedMetric): { replaces?: readonly string[] } {
  return entry.replaces !== undefined && entry.replaces.length > 0
    ? { replaces: entry.replaces }
    : {};
}

/** What to tell the operator when Graph refuses a name this server ships. */
function driftSuggestion(entry: ProbedMetric): string {
  const lineage =
    entry.replaces !== undefined && entry.replaces.length > 0
      ? ` It is this server's replacement for ${entry.replaces.join(', ')}, so that rename wave has moved on again — search Meta's Graph API changelog for the old name to find the current one.`
      : " Search Meta's Graph API changelog for this name to find its replacement.";
  return `Meta no longer accepts "${entry.metric}".${lineage} Then update PROBED_PAGE_METRICS and the README metric table.`;
}

/** Graph answered, but never mentioned this metric. */
function silentSuggestion(metric: string, apiVersion: string): string {
  return `Graph answered without a "${metric}" entry, so the name is not valid for this Page or for ${apiVersion}. This is NOT the same as a valid metric with no data — drop or rename it in PROBED_PAGE_METRICS.`;
}

function classifyPoints(
  entry: ProbedMetric,
  points: number | undefined,
  apiVersion: string,
): MetricSetVerdict {
  if (points === undefined) {
    return {
      metric: entry.metric,
      status: 'unknown',
      ...replacesOf(entry),
      suggestion: silentSuggestion(entry.metric, apiVersion),
    };
  }
  return {
    metric: entry.metric,
    status: points > 0 ? 'accepted' : 'empty',
    points,
    ...replacesOf(entry),
  };
}

/**
 * Fallback when the batched call died on a metric name: ask each name ALONE, so
 * one dead metric cannot hide the health of the other seven.
 *
 * Strictly bounded — every metric is asked at most once and a rejected metric is
 * never retried, so the whole check costs at most `1 + metrics.length` calls. A
 * non-metric failure (auth, rate limit, outage) stops the pass immediately: the
 * remaining names stay `unknown` with the reason attached rather than pounding a
 * Graph edge that has already said no.
 */
async function isolateMetrics(
  deps: DoctorDeps,
  pageId: string,
  metrics: readonly ProbedMetric[],
  since: string,
  until: string,
): Promise<{ requests: number; verdicts: MetricSetVerdict[] }> {
  const verdicts: MetricSetVerdict[] = [];
  // The batched attempt is already spent; count it.
  let requests = 1;
  let halted: string | undefined;

  for (const entry of metrics) {
    if (halted !== undefined) {
      verdicts.push({
        metric: entry.metric,
        status: 'unknown',
        ...replacesOf(entry),
        suggestion: `Not probed — the isolation pass stopped earlier: ${halted}`,
      });
      continue;
    }
    requests += 1;
    try {
      const body = await requestMetricWindow(deps, pageId, [entry.metric], since, until);
      verdicts.push(
        classifyPoints(
          entry,
          readMetricPoints(body).get(entry.metric),
          deps.settings.apiVersion,
        ),
      );
    } catch (err) {
      const reason = describeGraphFailure(deps, err);
      if (isMetricRejection(err)) {
        verdicts.push({
          metric: entry.metric,
          status: 'rejected',
          ...replacesOf(entry),
          error: reason,
          suggestion: driftSuggestion(entry),
        });
        continue;
      }
      halted = reason;
      verdicts.push({
        metric: entry.metric,
        status: 'unknown',
        ...replacesOf(entry),
        suggestion: `Not probed — ${reason}`,
      });
    }
  }
  return { requests, verdicts };
}

function countStatus(
  verdicts: readonly MetricSetVerdict[],
  status: MetricVerdictStatus,
): number {
  return verdicts.filter((verdict) => verdict.status === status).length;
}

/** Caveats the numbers alone would mislead the operator about. */
function metricSetNotes(
  verdicts: readonly MetricSetVerdict[],
  isolated: boolean,
): string[] {
  const notes: string[] = [];
  if (isolated) {
    notes.push(
      'Graph rejected the batched request because of a metric name, so every name was re-asked on its own. One dead name fails the whole call, which is why a single rename reads as "insights are broken".',
    );
  }
  if (countStatus(verdicts, 'empty') > 0) {
    notes.push(
      `An empty series is DATA, not a failure: Graph accepted the name and had nothing to report. A Page below roughly ${String(METRIC_PROBE_LIKES_FLOOR)} likes/followers is not eligible for insights and legitimately returns nothing for every metric, and a genuinely quiet ${String(METRIC_PROBE_WINDOW_DAYS)}-day window looks identical.`,
    );
    notes.push(
      `The probe asks for period="${METRIC_PROBE_PERIOD}" only, so a metric that exists but does not support daily buckets also answers empty here.`,
    );
  }
  const broken = countStatus(verdicts, 'rejected') + countStatus(verdicts, 'unknown');
  if (broken > 0) {
    notes.push(
      `ACTION: ${String(broken)} of ${String(verdicts.length)} shipped metric name(s) did not check out against the live API. Fix PROBED_PAGE_METRICS and re-generate the README metric table before trusting any insights output.`,
    );
  } else {
    notes.push(
      'Every shipped metric name is still accepted by this API version — the documented metric set is current.',
    );
  }
  notes.push(
    'Today\'s bucket is still being computed, so a missing or zero point at the end of the window means "not aggregated yet", not "no activity".',
  );
  return notes;
}

function skippedMetricSet(reason: string): MetricSetReport {
  return {
    outcome: 'skipped',
    summary: `metric set: skipped (${reason})`,
    requests: 0,
    verdicts: [],
    notes: [],
  };
}

/**
 * Ask the live API whether the metric set this server documents still exists
 * (C6 / CC-INS-1).
 *
 * One batched call in the happy path; a bounded per-metric pass only when Graph
 * refuses a name. Skipped — never failed — when a prerequisite is missing, so
 * the doctor still reports everything else it learned.
 */
async function probeMetricSet(
  deps: DoctorDeps,
  token: DoctorTokenReport,
  now: number,
): Promise<MetricSetReport> {
  const metrics = deps.metricSet ?? PROBED_PAGE_METRICS;
  if (!token.configured) {
    return skippedMetricSet(
      'no token configured — set FB_ACCESS_TOKEN (or FB_SYSTEM_TOKEN / FB_PAGE_TOKEN) and re-run',
    );
  }
  if (!token.valid) {
    return skippedMetricSet(
      token.diagnosis === 'token_check_failed'
        ? 'the token could not be checked (see Token above) — a probe over the same broken connection would only repeat the failure'
        : 'the configured token did not check out (see Token above) — probing metric names with a dead token proves nothing',
    );
  }
  if (metrics.length === 0) {
    return skippedMetricSet('the metric set is empty — nothing to verify');
  }
  const target = resolveProbePage(deps.settings);
  if (target === undefined) {
    return skippedMetricSet(
      'no Page configured — set FB_PAGE_ID or a profile Page, then re-run (the doctor probes the configured Page, it does not go shopping for one)',
    );
  }

  const until = utcDay(now);
  const since = utcDay(now - (METRIC_PROBE_WINDOW_DAYS - 1) * MS_PER_DAY);
  const names = metrics.map((entry) => entry.metric);
  const window = { pageId: target.pageId, period: METRIC_PROBE_PERIOD, since, until };

  let requests = 1;
  let verdicts: readonly MetricSetVerdict[];
  let isolated = false;
  try {
    const body = await requestMetricWindow(deps, target.pageId, names, since, until);
    const points = readMetricPoints(body);
    verdicts = metrics.map((entry) =>
      classifyPoints(entry, points.get(entry.metric), deps.settings.apiVersion),
    );
  } catch (err) {
    if (!isMetricRejection(err)) {
      return {
        outcome: 'failed',
        summary: `metric set: probe failed (${describeGraphFailure(deps, err)})`,
        ...window,
        requests,
        verdicts: [],
        notes: [
          'The call never reached the metric names, so this says nothing about whether they are still valid — fix the error above and re-run the doctor.',
        ],
      };
    }
    isolated = true;
    const pass = await isolateMetrics(deps, target.pageId, metrics, since, until);
    requests = pass.requests;
    verdicts = pass.verdicts;
  }

  const summary =
    `metric set: ${String(countStatus(verdicts, 'accepted'))} accepted, ` +
    `${String(countStatus(verdicts, 'empty'))} empty, ` +
    `${String(countStatus(verdicts, 'rejected'))} rejected, ` +
    `${String(countStatus(verdicts, 'unknown'))} unknown ` +
    `of ${String(verdicts.length)} on Page ${target.pageId} (${target.source}), ` +
    `period=${METRIC_PROBE_PERIOD} ${since}..${until}, ${String(requests)} request(s)`;

  return {
    outcome: 'probed',
    summary,
    ...window,
    requests,
    verdicts,
    notes: metricSetNotes(verdicts, isolated),
  };
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
    metricProbe: await runProbe(
      deps,
      deps.metricProbe,
      'metric probe',
      'metric probe: unavailable (no insights probe wired — enable the insights package to surface Page/Post reach diagnostics).',
    ),
    metricSet: await probeMetricSet(deps, token, now),
    adAccount: await runProbe(
      deps,
      deps.adAccountProbe,
      'ad account',
      'ad account: not checked (the ads package is off — enable it and set FB_AD_ACCOUNT_ID to diagnose ad-account health).',
    ),
    credentialFile: await inspectCredentialFile(deps),
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
      return (
        'TOKEN MALFORMED OR INVALID — debug_token did not accept this token. ' +
        'Re-issue it and update the credential env var; this is not an asset ' +
        'permission problem.'
      );
    case 'token_check_failed':
      return (
        'TOKEN NOT CHECKED — debug_token could not be reached, so nothing is ' +
        'known about this credential either way. Do NOT re-issue it yet: fix ' +
        'the connection first (see the error line above and the proxy hint), ' +
        'then re-run the doctor.'
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
  return scopes
    .map(
      (entry) =>
        `${entry.scope} -> ${entry.targetIds.length > 0 ? entry.targetIds.join(',') : '(no assets)'}`,
    )
    .join('; ');
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
    `  credential:   ${CREDENTIAL_LABEL[t.credentialSource]}`,
  ];
  if (t.shadowedCredentials.length > 0) {
    // Silent precedence is the whole trap of CC-AUTH-9 — name the losers.
    lines.push(
      `  shadowed:     ${t.shadowedCredentials.join(', ')} (also set, NOT used)`,
    );
  }
  lines.push(
    `  type:         ${t.type}`,
    `  valid:        ${t.valid ? 'yes' : 'no'}`,
    `  app id:       ${t.appId ?? '-'}`,
    `  acting as:    ${acting}`,
    `  scopes:       ${fmtList(t.scopes)}`,
    `  granular:     ${fmtGranularScopes(t.granularScopes)}`,
    `  asset access: ${ASSET_ACCESS_LABEL[t.assetAccess]}`,
    `  diagnosis:    ${describeDiagnosis(t)}`,
  );
  if (t.error !== undefined) lines.push(`  error:        ${t.error}`);
  lines.push(
    '',
    'Credential / expiry',
    `  token expiry: ${describeExpiry(t)}`,
    `  data access:  ${t.dataAccessExpiresAt !== undefined ? iso(t.dataAccessExpiresAt) : '-'}`,
    `  cred file:    ${report.credentialFile.path}`,
    `  protection:   ${describeCredentialFile(report.credentialFile)}`,
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
  return lines.join('\n');
}
