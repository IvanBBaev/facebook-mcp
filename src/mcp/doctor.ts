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
  createPagesRegistry,
  debugToken,
  envFilePath,
  errorMessageOf,
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
  type StartupProblem,
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
  // pages_read_engagement is facebook_list_comments' own requirement and
  // pages_messaging facebook_private_reply's; without them a row blocked only by
  // one of those read "missing: (none)" and named nothing to grant.
  moderation: [
    'pages_read_engagement',
    'pages_read_user_content',
    'pages_manage_engagement',
    'pages_messaging',
  ],
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
  // A read of the Page's own video (`/{video-id}?fields=status`, doc 04 "read own
  // posts"): unmapped, it inherited pages_manage_posts and read as blocked.
  facebook_get_video_status: ['pages_read_engagement'],

  // insights (V02)
  facebook_page_insights: ['read_insights'],
  facebook_post_insights: ['read_insights'],
  facebook_reel_insights: ['read_insights'],

  // moderation (V05/V06) — the delete/private-reply split (doc 04, CC-AUTH-4)
  // The tool's description: pages_read_engagement, plus pages_read_user_content
  // for visitor content.
  facebook_list_comments: ['pages_read_engagement', 'pages_read_user_content'],
  // Same read as the listing: pages_read_engagement, plus pages_read_user_content
  // for a visitor's comment (the tool's description).
  facebook_get_comment: ['pages_read_engagement', 'pages_read_user_content'],
  facebook_reply_to_comment: ['pages_manage_engagement'],
  facebook_hide_comment: ['pages_manage_engagement'],
  facebook_delete_comment: ['pages_manage_engagement', 'pages_read_user_content'],
  // Meta's Private Replies doc: sending needs pages_messaging (+ MESSAGING task),
  // not pages_manage_engagement; the pre-flight comment GET that checks the
  // 7-day window needs the facebook_get_comment set.
  facebook_private_reply: [
    'pages_messaging',
    'pages_read_engagement',
    'pages_read_user_content',
  ],
  // `/{page-id}/blocked` needs only pages_manage_engagement (the tools' own
  // descriptions say so); unmapped, they inherited pages_read_user_content too.
  facebook_block_user: ['pages_manage_engagement'],
  facebook_unblock_user: ['pages_manage_engagement'],

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
  /**
   * The probe was configured, Graph answered, and the answer is unhealthy: a
   * configured ad account that cannot serve, a Page that returns no insights.
   * `available: false` alone cannot carry this — an UNCONFIGURED probe reports
   * the same thing, and that one must stay silent (an ad account nobody set on
   * a non-ads install is not a fault). Set it and the verdict warns; leave it
   * off and the line is informational.
   */
  readonly degraded?: boolean;
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

/**
 * Per-package cross-reference verdict.
 *
 * `unverified` is the row when `debug_token` never answered: the scopes were
 * not learned, so the row is judged against nothing and says so. Judging it
 * against the empty default instead printed "BLOCKED — missing: <every
 * permission>" under a DNS fault, which is a permission verdict inferred from
 * the absence of a response (CC-NET-6).
 */
export type PackageUsability =
  'usable' | 'partial' | 'blocked' | 'unknown' | 'unverified';

/**
 * Which env var actually supplied the runtime token (CC-AUTH-9). The precedence
 * is `FB_SYSTEM_TOKEN` > `FB_ACCESS_TOKEN` > `FB_PAGE_TOKEN`; setting two is
 * legal and silent, so the doctor names the winner instead of leaving the
 * operator to guess which of their tokens is under test.
 */
export type CredentialSource =
  'FB_SYSTEM_TOKEN' | 'FB_ACCESS_TOKEN' | 'FB_PAGE_TOKEN' | 'none';

/**
 * How the acting Page token relates to `FB_PAGE_ID`. A long-lived Page token is
 * the credential of exactly one Page, and `FB_PAGE_ID` is the only setting that
 * says which (pages-registry `buildTokenPlan` registers `FB_PAGE_TOKEN` as the
 * override for `defaultPageId` alone). `debug_token` names that Page as
 * `profile_id`, so the doctor can say which id to set instead of only that one
 * is missing — and can catch the quieter mistake, an `FB_PAGE_ID` that names a
 * different Page than the token was issued for, where every Page-scoped call
 * goes to one Page carrying another Page's token.
 *
 *   * `bound` — `FB_PAGE_ID` is the token's Page: nothing to do;
 *   * `unbound` — `FB_PAGE_ID` is unset, so no Page-scoped tool can use the token;
 *   * `mismatch` — `FB_PAGE_ID` names a Page the token does not belong to.
 *
 * Only judged when `FB_PAGE_TOKEN` is the credential actually acting (a shadowed
 * Page token is not used with or without `FB_PAGE_ID`, CC-AUTH-9) and Graph
 * attributed the token to a Page; absent otherwise, never guessed.
 */
export type PageTokenBinding =
  | { readonly status: 'bound'; readonly tokenPageId: string }
  | { readonly status: 'unbound'; readonly tokenPageId: string }
  | {
      readonly status: 'mismatch';
      readonly tokenPageId: string;
      readonly configuredPageId: string;
    };

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
  /**
   * True when the path could not be stat'd for a reason OTHER than "no such
   * file". Both cases report `exists: false`, but only this one is a finding:
   * an absent file is the normal env-only setup, whereas a file whose
   * protection cannot be read is a question left unanswered.
   */
  readonly unreadable?: boolean;
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
  /** Epoch ms; absent for a never-expiring token AND for an unknown expiry. */
  readonly expiresAt?: number;
  /**
   * `true` only for a VALID token Graph reported with `expires_at: 0` — the
   * System-User signature. An answer that said nothing about expiry is NOT this
   * (see {@link DoctorTokenReport.expiryUnknown}).
   */
  readonly neverExpiring: boolean;
  /**
   * `true` only for a VALID token whose `debug_token` answer carried no usable
   * `expires_at`: the doctor cannot tell the operator when this credential
   * stops working, and says so instead of promoting silence to "never".
   */
  readonly expiryUnknown: boolean;
  /** Within {@link EXPIRY_SOON_MS} of expiry (or already past). */
  readonly expiringSoon: boolean;
  readonly dataAccessExpiresAt?: number;
  /**
   * `data_access_expires_at` is within {@link EXPIRY_SOON_MS} (or already past).
   * Independent of the token's own expiry: a never-expiring Page token still
   * stops reading once the issuing user's data access lapses, so "never" alone
   * is not "nothing to do". Absent when Graph reported no data-access expiry.
   */
  readonly dataAccessExpiringSoon?: boolean;
  /** Graph `user_id`: the acting user, or for a Page token the user it was issued through. */
  readonly actingUserId?: string;
  /** Graph `profile_id`: the Page a Page token acts as — the identity Graph calls see. */
  readonly actingPageId?: string;
  /** `FB_PAGE_TOKEN` vs `FB_PAGE_ID`; only present when there is a Page to judge. */
  readonly pageBinding?: PageTokenBinding;
  /**
   * Set when Graph REFUSED the `debug_token` call itself (a 4xx ruling) instead
   * of answering it. Two facts follow that the rest of the report must respect:
   * no scope list came back, so nothing is known about the token's permissions;
   * and the refusal is about whichever credential AUTHENTICATED the call. With
   * `FB_APP_ID` + `FB_APP_SECRET` set that is the app credential, not the token
   * under test — a wrong app secret is refused exactly like a dead token.
   */
  readonly debugCallRejected?: {
    readonly authenticatedWith: 'token' | 'app_credential';
  };
  /**
   * Set when no token is configured or `debug_token` failed (redacted). Carries
   * the error's operator remedy after the message when there is one — for a
   * network fault that is the proxy hint the `token_check_failed` diagnosis
   * refers to.
   */
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
  /**
   * The probe threw. `available: false` alone cannot carry this: an unwired probe
   * reports the same thing, so without a separate flag the verdict counted a
   * check that blew up as a check that was never asked for.
   */
  readonly failed?: boolean;
  /**
   * The probe answered "configured but unhealthy" (see
   * {@link MetricProbeResult.degraded}); copied through from the probe so the
   * verdict can warn on it while a plain `available: false` stays silent.
   */
  readonly degraded?: boolean;
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
 *                metric at all (the name is not valid for this object/version,
 *                OR the metric does not serve the probed period — Graph omits
 *                an unsupported metric/period pair instead of failing the call),
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
  /**
   * Insights calls this check actually spent. Bounded by `1 + metrics.length`.
   * The Page-token derivation that may precede them is not counted.
   */
  readonly requests: number;
  readonly verdicts: readonly MetricSetVerdict[];
  /** Plain-language caveats; always safe to print verbatim. */
  readonly notes: readonly string[];
}

/**
 * Severity of one thing the doctor found, least to most urgent.
 *
 * `unknown` outranks `warn` deliberately: a degraded-but-understood setup is a
 * smaller problem than a check that never answered, and burying "nothing was
 * established" under a warning is how a broken network passes for healthy.
 */
export type DoctorSeverity = 'warn' | 'unknown' | 'fail';

/** The overall answer, for a caller that reads exactly one line. */
export type DoctorVerdict = 'ok' | DoctorSeverity;

/** One reason the verdict is not `ok`. */
export interface DoctorFinding {
  readonly severity: DoctorSeverity;
  /** Which section raised it — `token`, `packages`, `credential file`, ... */
  readonly area: string;
  /** Operator-facing sentence. Built from already-redacted report text. */
  readonly detail: string;
}

/**
 * The one-line verdict and every reason behind it.
 *
 * The doctor still reports everything it found; this only says which of those
 * findings a script should act on. `findings` is empty iff the verdict is `ok`.
 */
export interface DoctorSummary {
  readonly verdict: DoctorVerdict;
  readonly findings: readonly DoctorFinding[];
}

/** The full machine-readable doctor result (rendered by {@link renderDoctorReport}). */
export interface DoctorReport {
  readonly serverVersion: string;
  readonly apiVersion: string;
  readonly generatedAt: number;
  /**
   * Set when the configured package selection does not resolve. The matrix below
   * is then built over the FULL package list — it describes an install that
   * cannot start, so this field is what stops the report reading as a verdict on
   * the operator's actual configuration.
   */
  readonly packageSelectionError?: string;
  /**
   * What `loadSettings()` found wrong with the environment this doctor ran in
   * (messages redacted). An `error` is a server `assertStartupOk` refuses to
   * start; a `warning` is what the real start logs first. Absent when the
   * caller did not load settings through the reporting loader.
   */
  readonly startupProblems?: readonly StartupProblem[];
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
  /** The one-line verdict over everything above, derived by {@link summarizeDoctor}. */
  readonly summary: DoctorSummary;
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
  /**
   * Why the package selection could not be resolved, if it could not be
   * (redacted, ready to print). The bootstrap resolves `FB_TOOL_PACKAGES` /
   * `FB_PACKAGES_DENY` / `FB_PACKAGES_READONLY` and passes this in; the doctor
   * only folds it into the verdict, because a selection that does not resolve is
   * a server that does not start, and the doctor is what an operator runs to
   * find that out.
   */
  readonly packageSelectionError?: string;
  /**
   * The problems `loadSettings()` reported for this environment. The bootstrap
   * already computes them on every path; the doctor folds them into the
   * verdict for the same reason it folds the package selection in — a startup
   * error is a server that never starts, and `doctor --strict` exiting 0 on it
   * was the one answer worse than no doctor at all.
   */
  readonly startupProblems?: readonly StartupProblem[];
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
  return assetScoped.some(
    (entry) => entry.appliesToAllTargets === true || entry.targetIds.length > 0,
  )
    ? 'ok'
    : 'revoked';
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

function usesAppCredential(settings: Settings): boolean {
  return settings.appId !== undefined && settings.appSecret !== undefined;
}

function debugCredential(settings: Settings, token: string): string {
  return usesAppCredential(settings) ? `${settings.appId}|${settings.appSecret}` : token;
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
      expiryUnknown: false,
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
    const binding = bindPageToken(
      credential.source,
      info.profileId,
      settings.defaultPageId,
    );
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
      // Only the wire's literal `expires_at: 0` reads as "never". An answer that
      // said nothing used to land here as the same `undefined` and print the
      // never-expiring line for a token nobody knows the lifetime of.
      neverExpiring: info.valid && info.expiry === 'never',
      expiryUnknown: info.valid && info.expiry === 'unknown',
      expiringSoon:
        info.expiresAt !== undefined && info.expiresAt - now <= EXPIRY_SOON_MS,
      dataAccessExpiresAt: info.dataAccessExpiresAt,
      ...(info.dataAccessExpiresAt !== undefined
        ? {
            dataAccessExpiringSoon: info.dataAccessExpiresAt - now <= EXPIRY_SOON_MS,
          }
        : {}),
      actingUserId: info.userId,
      actingPageId: info.profileId,
      ...(binding !== undefined ? { pageBinding: binding } : {}),
      // Graph rejects a token INSIDE a 200, so this branch — not the catch below
      // — is where most malformed-token verdicts are reached. Without the reason
      // the report printed the verdict and an empty `error:` line. Redacted like
      // every other error string: Graph's message can quote the credential back.
      ...(info.invalidReason !== undefined
        ? { error: deps.redactor.redactString(info.invalidReason) }
        : {}),
    };
  } catch (err) {
    const message = errorMessageOf(err);
    // `core/http` puts the remedy — the CC-NET-6 proxy self-diagnosis for a
    // connection that never opened, the back-off for a throttle — in
    // `action.operatorText`, never in the message. The `error:` line is the one
    // place the report shows this failure, and the diagnosis below sends the
    // operator there for the proxy hint, so the hint has to be on that line.
    const operatorText =
      err instanceof GraphApiError ? err.action?.operatorText : undefined;
    const detail = operatorText !== undefined ? `${message} — ${operatorText}` : message;
    // Did Graph actually rule on this token, or did the call never get an answer?
    // Only a 4xx that is a real rejection is Facebook's verdict. Anything else —
    // `httpStatus: 0` (the network-fault shape), a timeout, a body that would not
    // parse — means the credential was never assessed, and so do the two shapes
    // that arrive wearing a status code without being a ruling: a 5xx is Meta's
    // own outage (or a proxy's 502), and a throttle reaches us as HTTP 400 with a
    // body code (CC-NET-1), so status alone convicted healthy credentials and
    // sent operators off to rotate them.
    const category = err instanceof GraphApiError ? err.action?.category : undefined;
    const answered =
      err instanceof GraphApiError &&
      err.httpStatus >= 400 &&
      err.httpStatus < 500 &&
      category !== 'transient' &&
      category !== 'rate_limit';
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
      ...(answered
        ? {
            debugCallRejected: {
              authenticatedWith: usesAppCredential(settings)
                ? ('app_credential' as const)
                : ('token' as const),
            },
          }
        : {}),
      neverExpiring: false,
      expiryUnknown: false,
      expiringSoon: false,
      error: deps.redactor.redactString(detail),
    };
  }
}

/**
 * Relate the acting Page token to `FB_PAGE_ID` (see {@link PageTokenBinding}).
 * `undefined` whenever there is nothing to judge: another credential is acting,
 * or Graph did not name a Page — the doctor never invents one. `FB_PAGE_ID` is
 * compared trimmed, the same way {@link resolveProbePage} reads it, so a stray
 * space around a matching id is not reported as a different Page.
 */
export function bindPageToken(
  source: CredentialSource,
  tokenPageId: string | undefined,
  configuredPageId: string | undefined,
): PageTokenBinding | undefined {
  if (source !== 'FB_PAGE_TOKEN' || tokenPageId === undefined) return undefined;
  const configured = configuredPageId?.trim();
  if (configured === undefined || configured === '') {
    return { status: 'unbound', tokenPageId };
  }
  if (configured === tokenPageId) return { status: 'bound', tokenPageId };
  return { status: 'mismatch', tokenPageId, configuredPageId: configured };
}

/**
 * The one message for a binding that needs the operator (`undefined` for a
 * bound token): it is printed next to `acting as:` in the Token block AND is
 * the detail of the verdict finding, so the report says it once, the same way.
 */
function describePageBinding(binding: PageTokenBinding): string | undefined {
  switch (binding.status) {
    case 'bound':
      return undefined;
    case 'unbound':
      return `this Page token belongs to Page ${binding.tokenPageId}; set FB_PAGE_ID=${binding.tokenPageId} so Page-scoped tools can use it`;
    case 'mismatch':
      return `this Page token belongs to Page ${binding.tokenPageId}, but FB_PAGE_ID names ${binding.configuredPageId} — Page-scoped tools will call Page ${binding.configuredPageId} with a token for Page ${binding.tokenPageId}; set FB_PAGE_ID=${binding.tokenPageId}`;
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
    const message = errorMessageOf(err);
    return {
      path: filePath,
      exists: false,
      posixPermissions,
      unreadable: true,
      note: `Could not read file protection: ${deps.redactor.redactString(message)}`,
    };
  }
}

/**
 * Cross-reference every loaded package against the granted scopes.
 *
 * `scopesObserved` is false when the token check never got an answer. The
 * granted set is then the empty default, not a fact from the wire, and a row
 * judged against it would name every permission as missing — so each mapped
 * package is reported `unverified` with nothing missing and nothing blocked.
 */
function buildMatrix(
  packages: readonly PackageSpec[],
  granted: ReadonlySet<string>,
  scopesObserved: boolean,
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
    if (!scopesObserved) {
      return {
        package: pkg.name,
        status: 'unverified',
        requiredPermissions: required,
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
  /** The profile key when the Page came from a profile; absent ⇒ the default Page. */
  readonly profile?: string;
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
  return { pageId: named[1], source: `profile "${named[0]}"`, profile: named[0] };
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
 * The Page token the insights tools would read this Page with.
 *
 * A Page insights edge wants a Page access token; sent bare, the transport
 * falls back to FB_SYSTEM_TOKEN / FB_ACCESS_TOKEN and Graph either refuses the
 * call or answers it empty (CC-AUTH-2), so the probe would condemn a metric set
 * the tools read fine. Resolved through the same registry the tools use: a
 * profile's own token verbatim, FB_PAGE_TOKEN for the default Page when there
 * is no base token, otherwise one derivation from the base token. The registry
 * registers every token it hands out with the redactor.
 */
async function resolveProbeToken(deps: DoctorDeps, target: ProbeTarget): Promise<string> {
  const registry = createPagesRegistry({
    settings: deps.settings,
    fbRequest: deps.fbRequest,
    clock: deps.clock,
    redactor: deps.redactor,
  });
  const resolved = await registry.resolvePage(target.profile);
  return resolved.token;
}

/** One insights read through the injected client, under the probed Page's token. */
async function requestMetricWindow(
  deps: DoctorDeps,
  pageId: string,
  pageToken: string,
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
    token: pageToken,
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
  const message = deps.redactor.redactString(errorMessageOf(err));
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

/**
 * Graph answered, but never mentioned this metric.
 *
 * An absent entry has two causes Graph does not tell apart: a name that is not
 * valid for this Page or API version, and a live metric that does not serve the
 * probed period (Graph omits an unsupported metric/period pair rather than
 * failing the call — the api layer documents the same). Asserting the first
 * sent the operator to drop a name that may be perfectly current.
 */
function silentSuggestion(metric: string, apiVersion: string): string {
  return `Graph answered without a "${metric}" entry. Graph omits a name that is not valid for this Page or for ${apiVersion}, and equally a metric that does not serve period="${METRIC_PROBE_PERIOD}" — the probe cannot tell which. This is NOT the same as a valid metric with no data: check the name and its supported periods in Meta's metric reference for ${apiVersion} before changing PROBED_PAGE_METRICS.`;
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
  pageToken: string,
  metrics: readonly ProbedMetric[],
  since: string,
  until: string,
): Promise<{ requests: number; verdicts: MetricSetVerdict[]; notProbed: number }> {
  const verdicts: MetricSetVerdict[] = [];
  // The batched attempt is already spent; count it.
  let requests = 1;
  let halted: string | undefined;
  // Names Graph never ruled on because the pass failed or stopped: `unknown`
  // like a silent omission, but they say nothing about the metric set.
  let notProbed = 0;

  for (const entry of metrics) {
    if (halted !== undefined) {
      notProbed += 1;
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
      const body = await requestMetricWindow(
        deps,
        pageId,
        pageToken,
        [entry.metric],
        since,
        until,
      );
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
      notProbed += 1;
      verdicts.push({
        metric: entry.metric,
        status: 'unknown',
        ...replacesOf(entry),
        suggestion: `Not probed — ${reason}`,
      });
    }
  }
  return { requests, verdicts, notProbed };
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
  notProbed = 0,
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
  }
  if (countStatus(verdicts, 'empty') + countStatus(verdicts, 'unknown') - notProbed > 0) {
    notes.push(
      `The probe asks for period="${METRIC_PROBE_PERIOD}" only. A metric that exists but does not support daily buckets is left out of Graph's answer altogether, so it reads as unknown above — not as empty.`,
    );
  }
  // A name the pass never got an answer for is `unknown` too, but counting it
  // here told the operator to edit a metric list Graph was never asked about —
  // after a rate limit, that is every name behind the throttled one.
  const broken =
    countStatus(verdicts, 'rejected') + countStatus(verdicts, 'unknown') - notProbed;
  if (broken > 0) {
    notes.push(
      `ACTION: ${String(broken)} of ${String(verdicts.length)} shipped metric name(s) did not check out against the live API. Fix PROBED_PAGE_METRICS and re-generate the README metric table before trusting any insights output.`,
    );
  }
  if (notProbed > 0) {
    notes.push(
      `${String(notProbed)} of ${String(verdicts.length)} shipped metric name(s) were not probed — the isolation pass stopped on a failure that is not about metric names (see their lines). They say nothing about the metric set; fix that failure and re-run the doctor.`,
    );
  }
  if (broken === 0 && notProbed === 0) {
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

  let pageToken: string;
  try {
    pageToken = await resolveProbeToken(deps, target);
  } catch (err) {
    return {
      outcome: 'failed',
      summary: `metric set: probe failed (could not obtain a Page token for Page ${target.pageId}: ${describeGraphFailure(deps, err)})`,
      ...window,
      requests: 0,
      verdicts: [],
      notes: [
        'No insights call was made, so this says nothing about whether the metric names are still valid — fix the error above and re-run the doctor.',
      ],
    };
  }

  let requests = 1;
  let verdicts: readonly MetricSetVerdict[];
  let isolated = false;
  let notProbed = 0;
  try {
    const body = await requestMetricWindow(
      deps,
      target.pageId,
      pageToken,
      names,
      since,
      until,
    );
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
    const pass = await isolateMetrics(
      deps,
      target.pageId,
      pageToken,
      metrics,
      since,
      until,
    );
    requests = pass.requests;
    verdicts = pass.verdicts;
    notProbed = pass.notProbed;
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
    notes: metricSetNotes(verdicts, isolated, notProbed),
  };
}

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
const APP_CREDENTIAL_REJECTION =
  'debug_token refused the call, which was authenticated with FB_APP_ID|FB_APP_SECRET ' +
  '— the refusal may be about that app credential rather than the token: verify ' +
  'FB_APP_ID / FB_APP_SECRET first, and re-issue the token only if they are right.';

/** Token findings — the CC-AUTH-5 diagnosis, mapped to severity. */
function tokenFindings(token: DoctorTokenReport): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  switch (token.diagnosis) {
    case 'no_token':
      findings.push({
        severity: 'fail',
        area: 'token',
        detail:
          'No credential is configured — set FB_SYSTEM_TOKEN (or FB_ACCESS_TOKEN / FB_PAGE_TOKEN).',
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
function credentialFileFindings(file: CredentialFileReport): DoctorFinding[] {
  if (file.unreadable === true) {
    return [{ severity: 'warn', area: 'credential file', detail: file.note }];
  }
  if (file.exists && file.posixPermissions && file.ownerOnly === false) {
    return [
      {
        severity: 'warn',
        area: 'credential file',
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
const STARTUP_CODES_JUDGED_ELSEWHERE: ReadonlySet<string> = new Set([
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
 * Reduce a finished report to one verdict.
 *
 * Exported (and taking the report minus its own summary) so the rule set is
 * testable without a Graph double, and so a caller holding a report from
 * elsewhere can re-derive the verdict rather than trust a stored one.
 */
export function summarizeDoctor(report: Omit<DoctorReport, 'summary'>): DoctorSummary {
  const findings = [
    ...configurationFindings(report.packageSelectionError, report.startupProblems),
    ...tokenFindings(report.token),
    ...matrixFindings(report.matrix),
    ...credentialFileFindings(report.credentialFile),
    ...metricSetFindings(report.metricSet),
    ...probeFindings(report.metricProbe, 'metric probe'),
    ...probeFindings(report.adAccount, 'ad account'),
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

  const report: Omit<DoctorReport, 'summary'> = {
    serverVersion: deps.serverVersion,
    apiVersion: deps.settings.apiVersion,
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
  return { ...report, summary: summarizeDoctor(report) };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<PackageUsability, string> = {
  usable: 'OK',
  partial: 'PARTIAL',
  blocked: 'BLOCKED',
  unknown: 'UNKNOWN',
  unverified: 'NOT CHECKED',
};

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

function fmtList(items: readonly string[]): string {
  return items.length > 0 ? items.join(', ') : '(none)';
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
    case 'unverified':
      return `required: ${fmtList(
        row.requiredPermissions,
      )} — not checked (the token's scopes were never learned; see Token above)`;
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
    `  generated at: ${iso(report.generatedAt)}`,
  ];
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
