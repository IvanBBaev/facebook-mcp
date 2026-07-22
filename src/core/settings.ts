// Settings resolution for facebook-mcp (task F04).
//
// Turns the `FB_*` environment surface into the frozen {@link Settings} value —
// the single source of truth every consumer reads instead of touching env.
// Resolution is env-first (client-passed env beats the env file; see
// `config.loadEnvFile`) and NEVER fail-fast: validation collects *all* problems
// into one aggregated {@link StartupReport} (CC-CFG-2) so an operator fixes the
// whole config in one pass rather than one error at a time. `loadSettings`
// therefore never throws — it always returns a best-effort `Settings` (defaults
// substituted for invalid values) plus the report; a caller that wants
// fail-closed calls {@link assertStartupOk}.

import type {
  HostAllowlist,
  LogLevel,
  PageProfileConfig,
  Settings,
  TransportKind,
  WriteMode,
} from './types.js';
import { defaultJournalPath, envFilePath, loadEnvFile } from './config.js';

// --- Defaults (F04 owns these; the manifest snapshot pins the API version, R01) ---

/** Pinned default Graph API version. Overridable verbatim via `FB_API_VERSION`. */
export const DEFAULT_API_VERSION = 'v23.0';
/** Structure-aware truncation budget default (~25k chars). */
export const DEFAULT_MAX_RESULT_CHARS = 25_000;
/** Per-host concurrency semaphore default (doc 05 §2). */
export const DEFAULT_HOST_CONCURRENCY = 4;
/** Default per-request timeout in ms (aligns with the 60s retry cap). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** Default HTTP-transport port (only used when `FB_TRANSPORT=http`). */
export const DEFAULT_HTTP_PORT = 3000;
/** The only permitted HTTP bind host — loopback (Sec #4). Not env-configurable. */
export const HTTP_LOOPBACK_HOST = '127.0.0.1';
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';
export const DEFAULT_WRITE_MODE: WriteMode = 'plan';
export const DEFAULT_TRANSPORT: TransportKind = 'stdio';

/** Fixed Graph-API host allowlist (C7 / CC-NET-7) — no user-configurable hosts. */
export const GRAPH_HOSTS: HostAllowlist = {
  graph: 'graph.facebook.com',
  graphVideo: 'graph-video.facebook.com',
  rupload: 'rupload.facebook.com',
};

// --- Aggregated startup report ---

export type StartupSeverity = 'error' | 'warning';

/** One config problem. `error` blocks fail-closed startup; `warning` does not. */
export interface StartupProblem {
  readonly severity: StartupSeverity;
  /** Stable machine code, e.g. `'no-access-token'`. */
  readonly code: string;
  /** Human-actionable message. */
  readonly message: string;
  /** The env var most associated with the problem, when applicable. */
  readonly field?: string;
}

/** Aggregated result of validating the whole `FB_*` surface at once (CC-CFG-2). */
export interface StartupReport {
  /** True iff there are zero `error`-severity problems (warnings are allowed). */
  readonly ok: boolean;
  readonly problems: readonly StartupProblem[];
  readonly errors: readonly StartupProblem[];
  readonly warnings: readonly StartupProblem[];
}

/** Return value of {@link loadSettings}. */
export interface LoadSettingsResult {
  readonly settings: Settings;
  readonly report: StartupReport;
}

/** Options for {@link loadSettings}. */
export interface LoadSettingsOptions {
  /** Env to read from; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Whether to load the env file first. Default `true`, but the file is only
   * loaded when reading `process.env` (a custom `env` object is used verbatim).
   */
  readonly loadEnvFile?: boolean;
  /** Override the env-file path (defaults to the XDG/%APPDATA% config path). */
  readonly envFilePath?: string;
  /** Platform for path resolution; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Home dir for path resolution; defaults to `os.homedir()`. */
  readonly homeDir?: string;
}

type Report = (code: string, message: string, field?: string) => void;

const PROFILE_PAGE_RE = /^FB_PROFILE_(.+)_PAGE_ID$/;
const PROFILE_NAME_RE = /^[A-Za-z0-9-]+$/;
const API_VERSION_RE = /^v\d+\.\d+$/;

/**
 * Resolve the full {@link Settings} from the environment, aggregating every
 * config problem into the returned {@link StartupReport}. Never throws.
 */
export function loadSettings(options: LoadSettingsOptions = {}): LoadSettingsResult {
  const env = options.env ?? process.env;
  const usingProcessEnv = env === process.env;

  // Env-first: the file is loaded (into process.env) only when we are reading
  // process.env; dotenv's override:false keeps client-passed values winning.
  if (usingProcessEnv && (options.loadEnvFile ?? true)) {
    const filePath =
      options.envFilePath ??
      envFilePath({ platform: options.platform, env, homeDir: options.homeDir });
    loadEnvFile({ path: filePath });
  }

  const problems: StartupProblem[] = [];
  const err: Report = (code, message, field) => {
    problems.push({ severity: 'error', code, message, ...(field ? { field } : {}) });
  };
  const warn: Report = (code, message, field) => {
    problems.push({ severity: 'warning', code, message, ...(field ? { field } : {}) });
  };

  const str = (key: string): string | undefined => {
    const v = env[key];
    if (v === undefined) return undefined;
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  const intIn = (key: string, def: number, min: number, max: number): number => {
    const raw = str(key);
    if (raw === undefined) return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      err(
        'invalid-number',
        `${key} must be an integer in [${String(min)}, ${String(max)}]; got ${JSON.stringify(raw)}. Using default ${String(def)}.`,
        key,
      );
      return def;
    }
    return n;
  };

  const csv = (key: string): string[] => {
    const raw = str(key);
    if (raw === undefined) return [];
    return raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
  };

  const enumOf = <T extends string>(key: string, allowed: readonly T[], def: T): T => {
    const raw = str(key);
    if (raw === undefined) return def;
    const lower = raw.toLowerCase() as T;
    if (allowed.includes(lower)) return lower;
    err(
      'invalid-enum',
      `${key} must be one of ${allowed.join(' | ')}; got ${JSON.stringify(raw)}. Using default ${def}.`,
      key,
    );
    return def;
  };

  // --- Credentials ---
  const appId = str('FB_APP_ID');
  const appSecret = str('FB_APP_SECRET');
  const accessToken = str('FB_ACCESS_TOKEN');
  const systemToken = str('FB_SYSTEM_TOKEN');
  const pageToken = str('FB_PAGE_TOKEN');

  if (accessToken === undefined && systemToken === undefined && pageToken === undefined) {
    err(
      'no-access-token',
      'No access token configured. Set at least one of FB_ACCESS_TOKEN, FB_SYSTEM_TOKEN, or FB_PAGE_TOKEN.',
      'FB_ACCESS_TOKEN',
    );
  }
  if (appSecret === undefined) {
    warn(
      'no-app-secret',
      'FB_APP_SECRET is not set; appsecret_proof will not be attached. Enable "Require App Secret" and set FB_APP_SECRET so a stolen bare token is unusable.',
      'FB_APP_SECRET',
    );
  }

  // --- Page topology (no ALS — C14) ---
  const defaultPageId = str('FB_PAGE_ID');
  const profiles = parseProfiles(env, err);

  if (defaultPageId === undefined && Object.keys(profiles).length === 0) {
    warn(
      'no-page',
      'No default Page configured (FB_PAGE_ID unset, no FB_PROFILE_<NAME>_PAGE_ID). Page-scoped tools will require an explicit profile argument.',
      'FB_PAGE_ID',
    );
  }

  // --- Wire ---
  const apiVersion = resolveApiVersion(str('FB_API_VERSION'), warn);
  const requestTimeoutMs = intIn(
    'FB_REQUEST_TIMEOUT_MS',
    DEFAULT_REQUEST_TIMEOUT_MS,
    1,
    600_000,
  );
  const hostConcurrency = intIn('FB_HOST_CONCURRENCY', DEFAULT_HOST_CONCURRENCY, 1, 64);

  // --- Write gating & media ---
  const writeMode = enumOf<WriteMode>(
    'FB_WRITE_MODE',
    ['plan', 'apply'],
    DEFAULT_WRITE_MODE,
  );
  const mediaDir = str('FB_MEDIA_DIR');

  // --- Result shaping ---
  const maxResultChars = intIn(
    'FB_MAX_RESULT_CHARS',
    DEFAULT_MAX_RESULT_CHARS,
    500,
    10_000_000,
  );

  // --- Transport (CC-CFG-6: http fails closed without a token) ---
  const transport = enumOf<TransportKind>(
    'FB_TRANSPORT',
    ['stdio', 'http'],
    DEFAULT_TRANSPORT,
  );
  const httpToken = str('FB_HTTP_TOKEN');
  const httpHost = transport === 'http' ? HTTP_LOOPBACK_HOST : undefined;
  const httpPort =
    transport === 'http'
      ? intIn('FB_HTTP_PORT', DEFAULT_HTTP_PORT, 1, 65_535)
      : undefined;
  if (transport === 'http' && httpToken === undefined) {
    err(
      'http-no-token',
      'FB_TRANSPORT=http requires FB_HTTP_TOKEN; the HTTP transport fails closed without it (binds 127.0.0.1 only, validates Origin).',
      'FB_HTTP_TOKEN',
    );
  }

  // --- Packages (F11 owns name validity / default expansion — CC-CFG-3) ---
  const toolPackages = resolveToolPackages(str('FB_TOOL_PACKAGES'), csv, warn);
  const packagesDeny = csv('FB_PACKAGES_DENY');
  const packagesReadonly = csv('FB_PACKAGES_READONLY');

  // --- Journal & logging ---
  const journalPath =
    str('FB_JOURNAL_PATH') ??
    defaultJournalPath({ platform: options.platform, env, homeDir: options.homeDir });
  const logLevel = enumOf<LogLevel>(
    'FB_LOG_LEVEL',
    ['debug', 'info', 'warn', 'error'],
    DEFAULT_LOG_LEVEL,
  );

  // --- Ads (opt-in, 1.1) ---
  const adAccountId = str('FB_AD_ACCOUNT_ID');
  const adsBudgetCeiling = resolveBudgetCeiling(str('FB_ADS_BUDGET_CEILING'), err);

  // --- Out-of-band confirmation fallback (B1 / CC-MCP-6) ---
  const confirmToken = str('FB_CONFIRM_TOKEN');

  const settings: Settings = {
    appId,
    appSecret,
    accessToken,
    systemToken,
    pageToken,
    defaultPageId,
    profiles,
    apiVersion,
    hosts: GRAPH_HOSTS,
    requestTimeoutMs,
    hostConcurrency,
    writeMode,
    mediaDir,
    maxResultChars,
    transport,
    httpHost,
    httpPort,
    httpToken,
    toolPackages,
    packagesDeny,
    packagesReadonly,
    journalPath,
    logLevel,
    adAccountId,
    adsBudgetCeiling,
    confirmToken,
  };

  const errors = problems.filter((p) => p.severity === 'error');
  const warnings = problems.filter((p) => p.severity === 'warning');
  const report: StartupReport = {
    ok: errors.length === 0,
    problems,
    errors,
    warnings,
  };
  return { settings, report };
}

/** Parse every `FB_PROFILE_<NAME>_PAGE_ID` (+ optional `_TOKEN`) into profiles. */
function parseProfiles(
  env: NodeJS.ProcessEnv,
  err: Report,
): Record<string, PageProfileConfig> {
  const out: Record<string, PageProfileConfig> = {};
  for (const key of Object.keys(env)) {
    const match = PROFILE_PAGE_RE.exec(key);
    if (match === null) continue;
    const rawName = match[1];
    if (rawName === undefined) continue;
    if (!PROFILE_NAME_RE.test(rawName)) {
      err(
        'invalid-profile-name',
        `Profile env var ${key} has an invalid profile name; use only letters, digits and hyphens.`,
        key,
      );
      continue;
    }
    const pageId = env[key]?.trim();
    if (pageId === undefined || pageId.length === 0) {
      err('empty-profile-page-id', `${key} is set but empty; provide a Page ID.`, key);
      continue;
    }
    const tokenOverride = env[`FB_PROFILE_${rawName}_TOKEN`]?.trim();
    out[rawName.toLowerCase()] = {
      pageId,
      ...(tokenOverride !== undefined && tokenOverride.length > 0
        ? { tokenOverride }
        : {}),
    };
  }
  return out;
}

/** CC-CFG-5: accept any version verbatim (escape hatch); warn when it's off the tested default. */
function resolveApiVersion(raw: string | undefined, warn: Report): string {
  if (raw === undefined) return DEFAULT_API_VERSION;
  if (!API_VERSION_RE.test(raw)) {
    warn(
      'api-version-format',
      `FB_API_VERSION ${JSON.stringify(raw)} is not in the expected vNN.N form; accepted verbatim as an escape hatch.`,
      'FB_API_VERSION',
    );
  } else if (raw !== DEFAULT_API_VERSION) {
    warn(
      'api-version-nondefault',
      `FB_API_VERSION ${raw} differs from the tested default ${DEFAULT_API_VERSION}; accepted, but behavior is only verified against the default.`,
      'FB_API_VERSION',
    );
  }
  return raw;
}

/** `undefined` ⇒ default expansion (F11). A present-but-empty value warns and falls back. */
function resolveToolPackages(
  raw: string | undefined,
  csv: (key: string) => string[],
  warn: Report,
): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  const names = csv('FB_TOOL_PACKAGES');
  if (names.length === 0) {
    warn(
      'empty-tool-packages',
      'FB_TOOL_PACKAGES is set but lists no package names; falling back to the default package expansion.',
      'FB_TOOL_PACKAGES',
    );
    return undefined;
  }
  return names;
}

/** Ads budget ceiling in minor currency units — non-negative integer (CC-ADS-7). */
function resolveBudgetCeiling(raw: string | undefined, err: Report): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    err(
      'invalid-number',
      `FB_ADS_BUDGET_CEILING must be a non-negative integer (minor currency units); got ${JSON.stringify(raw)}.`,
      'FB_ADS_BUDGET_CEILING',
    );
    return undefined;
  }
  return n;
}

/** Render an aggregated report as a human-readable multi-line string. */
export function formatStartupReport(report: StartupReport): string {
  const lines: string[] = [];
  if (report.errors.length > 0) {
    lines.push(`Configuration errors (${String(report.errors.length)}):`);
    for (const p of report.errors) lines.push(`  - [${p.code}] ${p.message}`);
  }
  if (report.warnings.length > 0) {
    lines.push(`Configuration warnings (${String(report.warnings.length)}):`);
    for (const p of report.warnings) lines.push(`  - [${p.code}] ${p.message}`);
  }
  if (lines.length === 0) lines.push('Configuration OK.');
  return lines.join('\n');
}

/** Thrown by {@link assertStartupOk}; carries the full aggregated report. */
export class StartupConfigError extends Error {
  readonly report: StartupReport;
  constructor(report: StartupReport) {
    super(`Invalid configuration:\n${formatStartupReport(report)}`);
    this.name = 'StartupConfigError';
    this.report = report;
    Object.setPrototypeOf(this, StartupConfigError.prototype);
  }
}

/** Fail-closed helper: throw {@link StartupConfigError} when the report has errors. */
export function assertStartupOk(report: StartupReport): void {
  if (!report.ok) throw new StartupConfigError(report);
}
