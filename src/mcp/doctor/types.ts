// Doctor report shapes, probe seams and injected dependencies (shared).

import {
  type Clock,
  type FbRequestFn,
  type GranularScope,
  type Logger,
  type PackageSpec,
  type Redactor,
  type Settings,
  type StartupProblem,
  type TokenType,
  type VersionDriftSignal,
} from '../../core/index.js';

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
  /** Marketing API version the `ads` package calls (`FB_ADS_API_VERSION`). */
  readonly adsApiVersion: string;
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
  /**
   * Observed permissions of facebook_get_activity_since's local state file
   * (`FB_ACTIVITY_STATE_PATH`). Absent when the settings carry no path.
   */
  readonly activityStateFile?: CredentialFileReport;
  /**
   * API-version drift the doctor's own Graph calls saw (redacted): an
   * `X-Ad-Api-Version-Warning` from the Marketing API, or a served
   * `facebook-api-version` that differs from the pin. Absent when no monitor
   * was wired; empty when the probes saw none.
   */
  readonly versionDrift?: readonly VersionDriftSignal[];
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
   * The process's version-drift monitor — the SAME instance the `fbRequest`
   * transport observes into. Read after every probe has run, so the report
   * names any version header the doctor's own calls carried. Absent ⇒ the
   * report has no `versionDrift` field.
   */
  readonly versionDrift?: { signals(): readonly VersionDriftSignal[] };
  /**
   * How the operator launched this binary (`npx -y <package>`, `facebook-mcp`,
   * `node build/index.js` — see `resolveLaunchCommand`), so a finding that
   * names a command names one their shell can run. Defaults to `facebook-mcp`.
   */
  readonly launchCommand?: string;
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
