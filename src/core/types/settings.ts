// Resolved settings shape (X08 split of `core/types.ts`). F04 implements
// resolution in `core/config.ts` + `core/settings.ts`.

import type { WriteMode } from './write.js';

// ---------------------------------------------------------------------------
// 2. Settings (resolved config TYPE only — F04 implements resolution)
// ---------------------------------------------------------------------------

export type TransportKind = 'stdio' | 'http';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Fixed Graph-API host allowlist (C7 / CC-NET-7). No user-configurable hosts. */
export interface HostAllowlist {
  /** graph.facebook.com — JSON/query-string edge. */
  readonly graph: string;
  /** graph-video.facebook.com — legacy video edge. */
  readonly graphVideo: string;
  /** rupload.facebook.com — raw-binary resumable upload edge. */
  readonly rupload: string;
}

/** A named Page profile resolved from `FB_PROFILE_<NAME>_PAGE_ID` (+ optional token). */
export interface PageProfileConfig {
  readonly pageId: string;
  /** Optional per-profile token override; otherwise the resolver derives one (C1). */
  readonly tokenOverride?: string;
}

/**
 * Fully resolved configuration. Produced by F04 (`core/config.ts` +
 * `core/settings.ts`) from env-first sources; consumers never read env directly.
 * This is a pure data shape — no methods, no I/O.
 */
export interface Settings {
  // Credentials
  readonly appId?: string;
  readonly appSecret?: string;
  /** Primary user / system-user access token (`FB_ACCESS_TOKEN`). */
  readonly accessToken?: string;
  /** System-user token (`FB_SYSTEM_TOKEN`); wins over `pageToken` when both set (CC-AUTH-9). */
  readonly systemToken?: string;
  /** Long-lived Page token fallback (`FB_PAGE_TOKEN`) — first-class, not a footnote (C1). */
  readonly pageToken?: string;

  // Page topology (no ALS — C14)
  /** Default Page ID (`FB_PAGE_ID`) used when no `profile` argument is supplied. */
  readonly defaultPageId?: string;
  /** Additional named profiles; keyed by profile name. */
  readonly profiles: Readonly<Record<string, PageProfileConfig>>;

  // Wire
  /** Graph API version prepended to every non-ads edge path (`FB_API_VERSION`). */
  readonly apiVersion: string;
  /**
   * Marketing API version prepended to every ads edge path (`FB_ADS_API_VERSION`).
   * Pinned separately because Marketing API versions retire years before the
   * Graph API version of the same number.
   */
  readonly adsApiVersion: string;
  readonly hosts: HostAllowlist;
  /** Default per-request timeout in ms. */
  readonly requestTimeoutMs: number;
  /** Per-host concurrency semaphore size (default 4). */
  readonly hostConcurrency: number;

  // Write gating & media
  readonly writeMode: WriteMode;
  /**
   * Whether `FB_WRITE_MODE` was actually set by the operator, as opposed to
   * falling back to the compiled-in default. A package's `writeModeDefault`
   * applies only while this is false: an operator who typed the variable has
   * spoken about every package, which is what keeps `FB_WRITE_MODE=plan` a
   * working kill switch over a package that ships `apply`. Absent ⇒ not set.
   */
  readonly writeModeExplicit?: boolean;
  /** `FB_MEDIA_DIR`; `undefined` ⇒ local file access disabled, URL-only (C11). */
  readonly mediaDir?: string;

  // Result shaping
  /** `FB_MAX_RESULT_CHARS` structure-aware truncation budget (~25k default). */
  readonly maxResultChars: number;

  // Transport
  readonly transport: TransportKind;
  /** Loopback bind host for HTTP transport (127.0.0.1 only — Sec #4). */
  readonly httpHost?: string;
  readonly httpPort?: number;
  /** `FB_HTTP_TOKEN`; HTTP transport fails closed without it (CC-CFG-6). */
  readonly httpToken?: string;

  // Packages (F11 authoritative; see PACKAGE_NAMES)
  /** `FB_TOOL_PACKAGES`; `undefined` ⇒ the default profile expansion (owned by F11). */
  readonly toolPackages?: readonly string[];
  /** `FB_PACKAGES_DENY`. */
  readonly packagesDeny: readonly string[];
  /** `FB_PACKAGES_READONLY`. */
  readonly packagesReadonly: readonly string[];

  // Journal & logging
  readonly journalPath: string;
  /**
   * `FB_JOURNAL_RETENTION_DAYS`: journal entries older than this many days are
   * dropped; `0` = no age limit. Absent ⇒ `DEFAULT_JOURNAL_RETENTION_DAYS` (config.ts).
   */
  readonly journalRetentionDays?: number;
  /** `FB_ACTIVITY_STATE_PATH`; absent ⇒ `defaultActivityStatePath()` (config.ts). */
  readonly activityStatePath?: string;
  /** `FB_EXPORT_DIR`; absent ⇒ `defaultExportDir()` (config.ts). */
  readonly exportDir?: string;
  readonly logLevel: LogLevel;

  // Ads (opt-in, 1.1)
  readonly adAccountId?: string;
  /** `FB_ADS_BUDGET_CEILING` in minor currency units; refuses raises above this (CC-ADS-7). */
  readonly adsBudgetCeiling?: number;
  /**
   * `FB_ADS_CAMPAIGN_SPEND_CAP_MAX` in minor currency units; the largest campaign
   * `spend_cap` an ads write may set. Unset ⇒ writes that set a cap are refused.
   */
  readonly adsCampaignSpendCapMax?: number;

  // Out-of-band confirmation fallback (B1)
  /** Operator confirmation token for the OOB gate when elicitation is unavailable (CC-MCP-6). */
  readonly confirmToken?: string;
}
