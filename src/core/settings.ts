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

import { homedir } from 'node:os';
import path from 'node:path';
import { DEFAULT_PROFILE_KEY } from './types.js';
import type {
  HostAllowlist,
  LogLevel,
  PageProfileConfig,
  Settings,
  TransportKind,
  WriteMode,
} from './types.js';
import {
  defaultJournalPath,
  envFilePath,
  loadEnvFile,
  type LoadEnvFileResult,
} from './config.js';

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
/**
 * Shortest `FB_CONFIRM_TOKEN` that can be called a secret.
 *
 * The confirmation gate compares in constant time, so there is no timing oracle
 * to widen — but there is also nothing that rate-limits `confirm_token`, and the
 * party retrying it is the model the gate exists to restrain. At one character
 * the first guess wins; at sixteen an online guessing attack is not the cheapest
 * way in. This is the floor, not a recommendation: mint the value with
 * `openssl rand -hex 32`.
 */
export const MIN_CONFIRM_TOKEN_CHARS = 16;
/** Floor for FB_HTTP_TOKEN — same reasoning as {@link MIN_CONFIRM_TOKEN_CHARS}. */
const MIN_HTTP_TOKEN_CHARS = MIN_CONFIRM_TOKEN_CHARS;
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
const PROFILE_TOKEN_RE = /^FB_PROFILE_(.+)_TOKEN$/;
const PROFILE_NAME_RE = /^[A-Za-z0-9_-]+$/;
const API_VERSION_RE = /^v\d+\.\d+$/;

/**
 * Every `FB_*` name something in this project reads. `loadSettings` reads the
 * server's settings; `FB_SETUP_TOKEN` is read by the `setup-token` subcommand.
 * Profile variables are matched by shape ({@link PROFILE_PAGE_RE} /
 * {@link PROFILE_TOKEN_RE}), not listed.
 */
const SETTING_NAMES: readonly string[] = [
  'FB_APP_ID',
  'FB_APP_SECRET',
  'FB_ACCESS_TOKEN',
  'FB_SYSTEM_TOKEN',
  'FB_PAGE_TOKEN',
  'FB_PAGE_ID',
  'FB_API_VERSION',
  'FB_REQUEST_TIMEOUT_MS',
  'FB_HOST_CONCURRENCY',
  'FB_WRITE_MODE',
  'FB_MEDIA_DIR',
  'FB_MAX_RESULT_CHARS',
  'FB_TRANSPORT',
  'FB_HTTP_TOKEN',
  'FB_HTTP_PORT',
  'FB_TOOL_PACKAGES',
  'FB_PACKAGES_DENY',
  'FB_PACKAGES_READONLY',
  'FB_JOURNAL_PATH',
  'FB_LOG_LEVEL',
  'FB_AD_ACCOUNT_ID',
  'FB_ADS_BUDGET_CEILING',
  'FB_CONFIRM_TOKEN',
];
/**
 * The repository's smoke and fixture scripts (`scripts/`) read their own gate
 * variables and spawn the server with them still in its environment, so they are
 * known too. Spelled from suffixes on purpose: `metadata.test.ts` treats every
 * literal `FB_*` name in this file as a variable the running server reads (the
 * authority for `server.json` and `.env.example`), and these are not.
 */
const TOOLING_SUFFIXES: readonly string[] = ['SMOKE', 'RECORD_FIXTURE'];
const TOOLING_PREFIX = `FB_${'SMOKE'}_`;
const KNOWN_NAMES: ReadonlySet<string> = new Set([
  ...SETTING_NAMES,
  'FB_SETUP_TOKEN',
  ...TOOLING_SUFFIXES.map((suffix) => `FB_${suffix}`),
]);

/**
 * Resolve the full {@link Settings} from the environment, aggregating every
 * config problem into the returned {@link StartupReport}. Never throws.
 */
export function loadSettings(options: LoadSettingsOptions = {}): LoadSettingsResult {
  const env = options.env ?? process.env;
  const usingProcessEnv = env === process.env;

  const problems: StartupProblem[] = [];
  const err: Report = (code, message, field) => {
    problems.push({ severity: 'error', code, message, ...(field ? { field } : {}) });
  };
  const warn: Report = (code, message, field) => {
    problems.push({ severity: 'warning', code, message, ...(field ? { field } : {}) });
  };

  // Env-first: the file is loaded (into process.env) only when we are reading
  // process.env; dotenv's override:false keeps client-passed values winning.
  // The reporters are built above this on purpose — a file that fails to load is
  // a config problem like any other, and used to be dropped on the floor here.
  if (usingProcessEnv && (options.loadEnvFile ?? true)) {
    const filePath =
      options.envFilePath ??
      envFilePath({ platform: options.platform, env, homeDir: options.homeDir });
    reportEnvFile(loadEnvFile({ path: filePath }), filePath, warn);
  }

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
  reportOrphanProfileTokens(env, warn);
  // Windows environment names are case-insensitive, so `fb_access_token` in the
  // real process env IS read as FB_ACCESS_TOKEN there; a plain object is not.
  reportUnknownSettings(env, usingProcessEnv && process.platform === 'win32', warn);

  if (defaultPageId === undefined && Object.keys(profiles).length === 0) {
    warn(
      'no-page',
      'No default Page configured (FB_PAGE_ID unset, no FB_PROFILE_<NAME>_PAGE_ID). Page-scoped tools will require an explicit profile argument.',
      'FB_PAGE_ID',
    );
  }

  // A long-lived Page token is the credential of exactly one Page, and FB_PAGE_ID
  // is the only setting that names which one (pages-registry `buildTokenPlan`
  // registers FB_PAGE_TOKEN as the override for `defaultPageId` alone; profiles
  // use FB_PROFILE_<NAME>_TOKEN). FB_PAGE_TOKEN without FB_PAGE_ID is therefore
  // bound to nothing: no Page-scoped call can resolve a token from it. It still
  // serves as the bare fallback credential (whoami, doctor), so this is a warning,
  // not an error. It deliberately stays silent when a base token is also set: the
  // base token wins outright (CC-AUTH-9), FB_PAGE_TOKEN is ignored with or without
  // FB_PAGE_ID, and the doctor already reports it as `shadowed`; telling that
  // operator to set FB_PAGE_ID would not make the token used.
  if (
    systemToken === undefined &&
    accessToken === undefined &&
    pageToken !== undefined &&
    defaultPageId === undefined
  ) {
    warn(
      'page-token-unbound',
      'FB_PAGE_TOKEN is the only credential configured and FB_PAGE_ID is unset, so the Page token belongs to no configured Page: no Page-scoped tool can use it, and a Page without its own FB_PROFILE_<NAME>_TOKEN cannot resolve a token at all (credential-level calls such as facebook_whoami still work). Set FB_PAGE_ID to the Page the token was issued for (the doctor / facebook_whoami reports it as the acting Page), or use FB_SYSTEM_TOKEN / FB_ACCESS_TOKEN and let the server derive Page tokens.',
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
  // A value that was *present* counts as explicit even when it was rejected as
  // invalid: the operator did intend to govern write gating globally, and the
  // fallback they land on is the safe one (`plan`). Letting a package default
  // override it in that case would answer a typo by loosening the gate.
  const writeModeExplicit = str('FB_WRITE_MODE') !== undefined;
  const pathOpts = {
    platform: options.platform ?? process.platform,
    homeDir: options.homeDir,
  };
  const mediaDir = resolveOperatorPath(
    'FB_MEDIA_DIR',
    str('FB_MEDIA_DIR'),
    pathOpts,
    (key, raw) =>
      err(
        'relative-media-dir',
        `${key} must be an absolute path; got ${JSON.stringify(raw)}. A relative directory ` +
          "resolves against whatever working directory the MCP client spawned the server in (often '/'), " +
          'so it would allowlist an unknown part of the filesystem for uploads. Local file uploads stay ' +
          'disabled until it is set to an absolute path (a leading ~ is expanded to the home directory).',
        key,
      ),
  );

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
  const rawHttpToken = str('FB_HTTP_TOKEN');
  const httpToken = resolveHttpToken(rawHttpToken, transport === 'http' ? err : warn);
  const httpHost = transport === 'http' ? HTTP_LOOPBACK_HOST : undefined;
  const httpPort =
    transport === 'http'
      ? intIn('FB_HTTP_PORT', DEFAULT_HTTP_PORT, 1, 65_535)
      : undefined;
  if (transport === 'http' && rawHttpToken === undefined) {
    err(
      'http-no-token',
      'FB_TRANSPORT=http requires FB_HTTP_TOKEN; the HTTP transport fails closed without it (binds 127.0.0.1 only, validates Origin).',
      'FB_HTTP_TOKEN',
    );
  }

  // --- Packages (F11 owns name validity / default expansion — CC-CFG-3) ---
  // Deliberately the RAW value, not `str(...)`: `str` folds a present-but-empty
  // value to `undefined`, which is the "not configured" answer, and an operator
  // who set FB_TOOL_PACKAGES= did configure something.
  const toolPackages = resolveToolPackages(env.FB_TOOL_PACKAGES, csv, warn);
  const packagesDeny = csv('FB_PACKAGES_DENY');
  const packagesReadonly = csv('FB_PACKAGES_READONLY');

  // --- Journal & logging ---
  const defaultJournal = (): string =>
    defaultJournalPath({ platform: options.platform, env, homeDir: options.homeDir });
  const journalPath =
    resolveOperatorPath('FB_JOURNAL_PATH', str('FB_JOURNAL_PATH'), pathOpts, (key, raw) =>
      warn(
        'relative-journal-path',
        `${key} must be an absolute path; got ${JSON.stringify(raw)}. A relative path resolves ` +
          'against whatever working directory the MCP client spawned the server in, so the write ' +
          `journal would land somewhere unpredictable. Using the default ${defaultJournal()} instead ` +
          '(a leading ~ is expanded to the home directory).',
        key,
      ),
    ) ?? defaultJournal();
  const logLevel = enumOf<LogLevel>(
    'FB_LOG_LEVEL',
    ['debug', 'info', 'warn', 'error'],
    DEFAULT_LOG_LEVEL,
  );

  // --- Ads (opt-in, 1.1) ---
  const adAccountId = str('FB_AD_ACCOUNT_ID');
  const adsBudgetCeiling = resolveBudgetCeiling(str('FB_ADS_BUDGET_CEILING'), err);

  // --- Out-of-band confirmation fallback (B1 / CC-MCP-6) ---
  const confirmToken = resolveConfirmToken(str('FB_CONFIRM_TOKEN'), err);

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
    writeModeExplicit,
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

/**
 * Parse every `FB_PROFILE_<NAME>_PAGE_ID` (+ optional `_TOKEN`) into profiles.
 *
 * Profile keys are case-INSENSITIVE (they are lowercased here), so two spellings
 * of one name are the same profile — and silently keeping the last one would
 * point a Page-scoped WRITE at whichever Page the environment happened to
 * enumerate last. Both hazards are refused loudly instead:
 *   * `FB_PROFILE_DEFAULT_PAGE_ID` collides with the reserved key the registry
 *     mints for `FB_PAGE_ID` ({@link DEFAULT_PROFILE_KEY}), where an exact-key
 *     match would resolve to the FB_PAGE_ID Page and this profile would never be
 *     reachable;
 *   * `FB_PROFILE_Acme_…` next to `FB_PROFILE_ACME_…` is one key, two Pages;
 *   * `FB_PROFILE___proto___…` would replace the result's prototype instead of
 *     adding a key, so the profile would vanish without a reported problem.
 * A rejected profile is dropped, so a startup that reports errors never resolves
 * an ambiguous key to a guess (CC-AUTH-6).
 */
function parseProfiles(
  env: NodeJS.ProcessEnv,
  err: Report,
): Record<string, PageProfileConfig> {
  const out: Record<string, PageProfileConfig> = {};
  const claimedBy = new Map<string, string>();
  const tokenVars = indexProfileTokens(env);
  for (const key of Object.keys(env)) {
    const match = PROFILE_PAGE_RE.exec(key);
    if (match === null) continue;
    const rawName = match[1];
    if (rawName === undefined) continue;
    if (!PROFILE_NAME_RE.test(rawName)) {
      err(
        'invalid-profile-name',
        `Profile env var ${key} has an invalid profile name; use only letters, digits, underscores and hyphens.`,
        key,
      );
      continue;
    }
    const name = rawName.toLowerCase();
    if (name === DEFAULT_PROFILE_KEY) {
      err(
        'reserved-profile-name',
        `${key} uses the reserved profile name "${DEFAULT_PROFILE_KEY}", which always ` +
          'refers to the FB_PAGE_ID Page. Rename the profile; a Page configured under ' +
          'this name would never be selectable.',
        key,
      );
      continue;
    }
    if (name === '__proto__') {
      err(
        'reserved-profile-name',
        `${key} uses the reserved profile name "__proto__", which cannot be stored ` +
          'as a profile key. Rename the profile.',
        key,
      );
      continue;
    }
    const claimed = claimedBy.get(name);
    if (claimed !== undefined) {
      err(
        'duplicate-profile-name',
        `${key} and ${claimed} both define the profile "${name}" (profile names are ` +
          'case-insensitive). Both are ignored — rename one, so a page-scoped call ' +
          'cannot silently act as the wrong Page.',
        key,
      );
      delete out[name];
      continue;
    }
    const pageId = env[key]?.trim();
    if (pageId === undefined || pageId.length === 0) {
      err('empty-profile-page-id', `${key} is set but empty; provide a Page ID.`, key);
      continue;
    }
    claimedBy.set(name, key);
    const tokenOverride = resolveProfileToken(env, name, tokenVars, err);
    out[name] = {
      pageId,
      ...(tokenOverride !== undefined ? { tokenOverride } : {}),
    };
  }
  return out;
}

/** Group every `FB_PROFILE_<NAME>_TOKEN` env key by its lowercased profile name. */
function indexProfileTokens(env: NodeJS.ProcessEnv): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const key of Object.keys(env)) {
    const rawName = PROFILE_TOKEN_RE.exec(key)?.[1];
    if (rawName === undefined) continue;
    const name = rawName.toLowerCase();
    const keys = byName.get(name);
    if (keys === undefined) byName.set(name, [key]);
    else keys.push(key);
  }
  return byName;
}

/**
 * Warn about every `FB_PROFILE_<NAME>_TOKEN` that no `FB_PROFILE_<NAME>_PAGE_ID`
 * (in any spelling) pairs with.
 *
 * Such a token belongs to no profile and is never used. The likely cause is the
 * natural misspelling `FB_PROFILE_ACME_PAGE_TOKEN`, which parses as the token of
 * a profile named `acme_page`: profile `acme` then runs with no override and
 * derives its Page token from the base credential — the one the operator
 * configured it not to use — and nothing said so. A warning, not an error: the
 * configuration still resolves, and the message names the var it expected. A
 * page-id var that was itself rejected still counts as a pairing; that var's own
 * error already covers it.
 */
function reportOrphanProfileTokens(env: NodeJS.ProcessEnv, warn: Report): void {
  const pageNames = new Set<string>();
  for (const key of Object.keys(env)) {
    const rawName = PROFILE_PAGE_RE.exec(key)?.[1];
    if (rawName !== undefined) pageNames.add(rawName.toLowerCase());
  }
  for (const [name, keys] of indexProfileTokens(env)) {
    if (pageNames.has(name)) continue;
    for (const key of keys) {
      if ((env[key]?.trim() ?? '').length === 0) continue;
      const rawName = PROFILE_TOKEN_RE.exec(key)?.[1] ?? name;
      warn(
        'orphan-profile-token',
        `${key} is set but no FB_PROFILE_${rawName}_PAGE_ID defines the profile ` +
          `"${name}", so the token is never used. If it was meant for an existing ` +
          "profile, rename it to FB_PROFILE_<NAME>_TOKEN with that profile's exact name.",
        key,
      );
    }
  }
}

/**
 * Warn about every non-blank `FB_*` variable nothing reads.
 *
 * Every setting is optional, so a misspelt name is not missing — it is simply
 * never read, and the server starts on the default: a budget-ceiling variable
 * missing one letter runs the ads tools with no ceiling at all while the
 * operator believes one is enforced, and a misspelt deny-list leaves the package
 * it meant to deny loaded. A warning, not an error: another tool may
 * legitimately share the prefix. Only the NAME is echoed — the value of a
 * misspelt access-token variable is a credential. A blank value is skipped, as it is unset everywhere else here.
 */
function reportUnknownSettings(
  env: NodeJS.ProcessEnv,
  caseInsensitive: boolean,
  warn: Report,
): void {
  for (const key of Object.keys(env)) {
    if (!key.toUpperCase().startsWith('FB_')) continue;
    if ((env[key]?.trim() ?? '').length === 0) continue;
    const name = caseInsensitive ? key.toUpperCase() : key;
    if (KNOWN_NAMES.has(name) || name.startsWith(TOOLING_PREFIX)) continue;
    if (PROFILE_PAGE_RE.test(name) || PROFILE_TOKEN_RE.test(name)) continue;
    warn(
      'unknown-setting',
      `${key} is set but is not a setting this server reads, so it has no effect` +
        `${unknownSettingHint(key)}.`,
      key,
    );
  }
}

/** A ` — did you mean …?` suffix naming the setting `key` most likely meant. */
function unknownSettingHint(key: string): string {
  const upper = key.toUpperCase();
  if (upper.startsWith('FB_PROFILE_')) {
    return ' — did you mean FB_PROFILE_<NAME>_PAGE_ID or FB_PROFILE_<NAME>_TOKEN?';
  }
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const name of SETTING_NAMES) {
    const d = editDistance(upper, name);
    if (d < bestDistance) {
      best = name;
      bestDistance = d;
    }
  }
  return best !== undefined && bestDistance <= 2 ? ` — did you mean ${best}?` : '';
}

/** Levenshtein distance; the inputs are short env-var names. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/**
 * The token override configured for profile `name`, matched case-INSENSITIVELY.
 *
 * Profile names are case-insensitive everywhere else in this module (the page-id
 * var is lowercased into the profile key, and two spellings of one name are
 * refused as duplicates), so the token var must be matched the same way:
 * `FB_PROFILE_Acme_PAGE_ID` next to `FB_PROFILE_ACME_TOKEN` is one profile with
 * one token. Matching `FB_PROFILE_${rawName}_TOKEN` exactly instead dropped the
 * token without a word, leaving the profile to derive a Page token from the base
 * credential — exactly the credential the operator configured it not to use.
 *
 * Two spellings of the same token var are refused rather than ranked, mirroring
 * `duplicate-profile-name`: acting with an arbitrarily chosen credential is worse
 * than acting with none.
 */
function resolveProfileToken(
  env: NodeJS.ProcessEnv,
  name: string,
  tokenVars: Map<string, string[]>,
  err: Report,
): string | undefined {
  const keys = tokenVars.get(name) ?? [];
  const first = keys[0];
  if (first === undefined) return undefined;
  if (keys.length > 1) {
    err(
      'duplicate-profile-token',
      `${keys.join(' and ')} all define the token for profile "${name}" (profile ` +
        'names are case-insensitive). None is used — rename them to one spelling, ' +
        'so the profile cannot act with an arbitrarily chosen credential.',
      first,
    );
    return undefined;
  }
  const value = env[first]?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * An operator-supplied filesystem path (`FB_JOURNAL_PATH`, `FB_MEDIA_DIR`), made
 * absolute or refused.
 *
 * No shell ever sees these values: an MCP client's JSON `env` block and the env
 * file both hand `~/…` over verbatim, so a leading `~` (alone, or followed by a
 * separator) is expanded to the home directory here. Anything still relative
 * after that would resolve against the cwd the client happened to spawn the
 * server in — the same hazard `config.envBaseDir` refuses for an XDG base — so it
 * is reported through `onRelative` and dropped (`undefined`), letting the caller
 * fall back to its safe default. `~user/…` is not expanded and counts as relative.
 */
function resolveOperatorPath(
  key: string,
  raw: string | undefined,
  o: { readonly platform: NodeJS.Platform; readonly homeDir?: string },
  onRelative: (key: string, raw: string) => void,
): string | undefined {
  if (raw === undefined) return undefined;
  const p = o.platform === 'win32' ? path.win32 : path.posix;
  let value = raw;
  const tilde = o.platform === 'win32' ? /^~(?:[\\/]|$)/ : /^~(?:\/|$)/;
  if (tilde.test(raw)) {
    value = p.join(o.homeDir ?? homedir(), raw.slice(1));
  }
  // path.win32 already calls drive-relative `C:media` non-absolute.
  if (!p.isAbsolute(value)) {
    onRelative(key, raw);
    return undefined;
  }
  return value;
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

/**
 * Surface an env file that is THERE but unreadable.
 *
 * A missing file is the normal case: the file is optional, and ENOENT only says
 * the operator configures the server another way. Any OTHER error means the file
 * exists and its contents never reached `process.env` — after which validation
 * reports whatever is now missing, so an operator who put FB_ACCESS_TOKEN in
 * that very file is told to set FB_ACCESS_TOKEN, with nothing naming the file
 * the server could not read. A warning rather than an error: the config may
 * still be complete from the ambient env, and the aggregated report prints
 * warnings alongside any error it does produce.
 */
function reportEnvFile(result: LoadEnvFileResult, filePath: string, warn: Report): void {
  const { error } = result;
  if (error === undefined || error.code === 'ENOENT') return;
  warn(
    'env-file-unreadable',
    `The env file ${filePath} exists but could not be read (${error.code ?? error.name}); ` +
      'nothing in it was applied — any value configured there is missing below.',
  );
}

/**
 * B1: an operator token short enough to guess is refused, not quietly armed.
 *
 * Dropping the value is the safe fallback, the way `plan` is for a bad
 * FB_WRITE_MODE: with no configured token the gate denies every token-route
 * confirmation instead of accepting a secret the caller can brute-force.
 */
function resolveConfirmToken(raw: string | undefined, err: Report): string | undefined {
  if (raw === undefined) return undefined;
  if (raw.length < MIN_CONFIRM_TOKEN_CHARS) {
    err(
      'weak-confirm-token',
      `FB_CONFIRM_TOKEN must be at least ${String(MIN_CONFIRM_TOKEN_CHARS)} characters ` +
        `(got ${String(raw.length)}). Nothing rate-limits confirm_token and the caller ` +
        'retrying it is the model the gate exists to restrain, so a short token arms the ' +
        'gate with a secret one call can guess. Ignored until it is replaced.',
      'FB_CONFIRM_TOKEN',
    );
    return undefined;
  }
  return raw;
}

/**
 * The HTTP transport's bearer token gets the same floor as the operator token.
 *
 * It is the only credential in front of the HTTP transport, nothing rate-limits
 * it, and any local process can retry it — so a short value is guessed, not
 * presented. It is also registered as a redaction secret, and a common short
 * string would be rewritten to [REDACTED] wherever it appears in logs, results
 * and the journal. Under `http` a short token fails startup (with no token the
 * transport would refuse to start anyway); under `stdio` the value is unused, so
 * it is dropped with a warning instead.
 */
function resolveHttpToken(raw: string | undefined, report: Report): string | undefined {
  if (raw === undefined) return undefined;
  if (raw.length < MIN_HTTP_TOKEN_CHARS) {
    report(
      'weak-http-token',
      `FB_HTTP_TOKEN must be at least ${String(MIN_HTTP_TOKEN_CHARS)} characters ` +
        `(got ${String(raw.length)}). It is the only credential on the HTTP transport ` +
        'and nothing rate-limits it, so a short token is one a local process can guess. ' +
        'Ignored until it is replaced; mint one with `openssl rand -hex 32`.',
      'FB_HTTP_TOKEN',
    );
    return undefined;
  }
  return raw;
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
