// `facebook-mcp setup-token` — the guided onboarding subcommand (task R05).
//
// Meta onboarding is the single biggest drop-off in this project: create an app,
// tick the right scopes in the Graph API Explorer, exchange the short-lived user
// token server-side, walk `/me/accounts` to find the Page, derive a Page token,
// and finally put four secrets in a file with the right permissions. This module
// collapses that into one command — three Graph calls (`/debug_token`,
// `/oauth/access_token`, `/me/accounts`, plus a fourth only when the listing
// omits the Page token) and an atomic 0600 file write — and reports every step
// honestly.
//
// Shape mirrors `doctor.ts` deliberately:
//
//   * `runSetupToken(deps)` is PURE and dependency-injected. It reads no argv, no
//     env, no process streams, and it NEVER throws for a credential problem — a
//     dead token, a missing scope, a refused overwrite are all REPORTED in the
//     returned {@link SetupTokenResult}. A broken credential must still produce a
//     readable explanation.
//   * `renderSetupTokenReport(result)` turns that result into operator-readable
//     text ending with the concrete next command (`facebook-mcp doctor`).
//   * `parseSetupTokenArgs(argv, env)` is the (equally pure) argument reader, so
//     the bootstrap's wiring stays three statements and the process concerns
//     (argv, stderr, exit codes) stay entirely in the bootstrap.
//
// Secret discipline (doc 04):
//   * The pasted token is registered with the value-based redactor the moment it
//     exists, before any Graph call or log, so it can never survive an error
//     message. Same for the long-lived token and every derived Page token.
//   * NO token value ever enters the result or the rendered report — only key
//     NAMES, the file path, and metadata. The only place a token value lands is
//     the env file itself, written through `core`'s atomic 0600 helper.
//   * Passing the token as a shell ARGUMENT makes it visible in the process list;
//     the parser flags that and points at `FB_SETUP_TOKEN` instead.
//
// Layer 2 (`mcp`): imports the frozen `core` contracts + `core.debugToken` +
// `core.atomicWriteFile`, and the same-layer package/permission tables. No
// `api` / `tools` import, no runtime Zod.

import dotenv from 'dotenv';

import {
  atomicWriteFile,
  debugToken,
  envFilePath as defaultEnvFilePath,
  errorMessageOf,
  type AtomicWriteResult,
  type Clock,
  type FbRequestFn,
  type Logger,
  type PackageName,
  type Redactor,
  type Settings,
  type TokenExpiry,
  type TokenType,
} from '../core/index.js';
import { PACKAGE_PERMISSIONS } from './doctor.js';
import {
  DEFAULT_PROFILE_PACKAGES,
  expandSelection,
  sortByCanonical,
} from './packages.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Env var carrying the pasted short-lived token (preferred over an argument). */
export const SETUP_TOKEN_ENV_VAR = 'FB_SETUP_TOKEN';

/** The concrete command the report ends with. */
export const SETUP_NEXT_COMMAND = 'facebook-mcp doctor';

/**
 * Scopes without which the flow cannot complete at all: `/me/accounts` needs
 * `pages_show_list`, so a token missing it can neither list Pages nor derive a
 * Page token. Package scopes (`pages_manage_posts`, `read_insights`, …) are NOT
 * in this list — a token missing them still yields a working install with a
 * smaller tool surface, so they are reported as warnings naming the exact scope
 * and the exact package, not as a refusal.
 */
export const REQUIRED_SETUP_SCOPES: readonly string[] = ['pages_show_list'];

/** How the operator mints the only genuinely non-expiring credential (doc 04). */
export const SYSTEM_USER_GUIDANCE =
  'A System-User token is the ONLY non-expiring option: claim the app into a ' +
  'Business portfolio, create an admin system user, assign the Page (and ad ' +
  'account) as assets, generate the token, then set FB_SYSTEM_TOKEN. Meta still ' +
  'recommends the 60-day expiring variant plus scheduled rotation.';

/**
 * The widest epoch (ms) a JavaScript `Date` can represent: ±100,000,000 days
 * from 1970. Beyond it `new Date(ms)` is an Invalid Date, so a value past this
 * bound is not a very distant expiry — it is not a date at all.
 */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

/** `expires_in` Graph returns for a long-lived user token (~60 days), in seconds. */
const LONG_LIVED_SECONDS = 60 * 24 * 60 * 60;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

/**
 * `/me/accounts` page size. The flow reads exactly one page — no cursor is
 * followed — so this is also the hard ceiling on the Pages it can discover or
 * pin with `--page=<id>`; beyond it the operator is told the listing was cut,
 * never that their Page does not exist.
 */
const PAGE_LIST_LIMIT = 100;

// ---------------------------------------------------------------------------
// Input (produced by `parseSetupTokenArgs`, consumed by `runSetupToken`)
// ---------------------------------------------------------------------------

/** Where the pasted token came from — drives the process-list advisory. */
export type SetupTokenSource = 'argument' | 'env' | 'none';

/** Everything the flow needs from the invocation, already parsed. */
export interface SetupTokenInput {
  /** The short-lived User token pasted from the Graph API Explorer. */
  readonly token?: string;
  readonly tokenSource: SetupTokenSource;
  /** Page the operator selected (`--page=<id>`); omitted ⇒ auto-select if unique. */
  readonly pageId?: string;
  /** `false` for a dry run (`--no-write`): report what WOULD be written. */
  readonly write: boolean;
  /** `--force`: overwrite an existing env file (it is replaced, never merged). */
  readonly force: boolean;
  /** Override the env-file path (`--env-file=<path>`). */
  readonly envFilePath?: string;
  /** Parser advisories folded into the result's warnings. */
  readonly notes: readonly string[];
}

function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const out = value.trim();
  return out.length > 0 ? out : undefined;
}

/**
 * Parse the arguments FOLLOWING the subcommand (`process.argv.slice(3)`) plus the
 * environment. Pure: it reads neither `process.argv` nor `process.env` itself.
 *
 * Token precedence: an explicit positional argument wins over
 * `FB_SETUP_TOKEN`, but doing so is flagged — a token on the command line is
 * visible to every process on the machine (`ps`) and lands in shell history.
 */
export function parseSetupTokenArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = {},
): SetupTokenInput {
  const notes: string[] = [];
  const envToken = trimmed(env[SETUP_TOKEN_ENV_VAR]);

  let argToken: string | undefined;
  let pageId: string | undefined;
  let envFile: string | undefined;
  let write = true;
  let force = false;

  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index] ?? '';
    if (raw === '--force') {
      force = true;
    } else if (raw === '--no-write' || raw === '--dry-run') {
      write = false;
    } else if (raw.startsWith('--page=')) {
      pageId = trimmed(raw.slice('--page='.length));
    } else if (raw.startsWith('--env-file=')) {
      envFile = trimmed(raw.slice('--env-file='.length));
    } else if (raw === '--page' || raw === '--env-file') {
      // The space-separated form. Left to the positional branch below, the
      // VALUE became the token: FB_SETUP_TOKEN was dropped and a Page ID or a
      // path was sent to Graph as the credential.
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('-')) {
        index++;
        if (raw === '--page') pageId = trimmed(next);
        else envFile = trimmed(next);
      } else {
        notes.push(`Ignored ${raw}: it needs a value (${raw}=<value>).`);
      }
    } else if (raw.startsWith('-')) {
      // Echo the option NAME only, never its value. `--token=EAAB…` is exactly
      // what an operator reaches for when the positional form is not obvious, and
      // it lands here — quoting the raw argument would print the token into the
      // rendered report, which by this file's contract never carries one.
      const eq = raw.indexOf('=');
      const name = eq === -1 ? raw : raw.slice(0, eq);
      notes.push(
        `Ignored unknown option ${JSON.stringify(name)}. Supported: --page=<id>, ` +
          `--env-file=<path>, --force, --no-write.`,
      );
    } else {
      argToken = trimmed(raw);
    }
  }

  if (argToken !== undefined) {
    notes.push(
      'The token was passed as a command-line argument, so it is visible in the ' +
        `process list and your shell history. Prefer ${SETUP_TOKEN_ENV_VAR}=… ` +
        'facebook-mcp setup-token, and clear the history entry.',
    );
    if (envToken !== undefined) {
      notes.push(
        `Both ${SETUP_TOKEN_ENV_VAR} and a command-line token were supplied; the ` +
          'command-line token was used.',
      );
    }
  }

  const token = argToken ?? envToken;
  const tokenSource: SetupTokenSource =
    argToken !== undefined ? 'argument' : envToken !== undefined ? 'env' : 'none';

  return {
    ...(token !== undefined ? { token } : {}),
    tokenSource,
    ...(pageId !== undefined ? { pageId } : {}),
    write,
    force,
    ...(envFile !== undefined ? { envFilePath: envFile } : {}),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** The five stages of the flow, in order. */
export type SetupStepId = 'input' | 'classify' | 'exchange' | 'pages' | 'write';

export type SetupStepStatus = 'ok' | 'skipped' | 'failed';

/** One stage outcome. A `failed` stage carries the actionable fix in `detail`. */
export interface SetupTokenStep {
  readonly id: SetupStepId;
  readonly status: SetupStepStatus;
  readonly summary: string;
  /** Operator-actionable next move when the stage failed or was skipped. */
  readonly detail?: string;
}

/** `debug_token` classification of the PASTED token (never its value). */
export interface SetupTokenClassification {
  readonly valid: boolean;
  readonly type: TokenType;
  readonly appId?: string;
  readonly scopes: readonly string[];
  /**
   * Whether Graph said when the token expires (see {@link TokenExpiry}). Only
   * `never` (Graph `expires_at` 0) is a non-expiring token; an answer with no
   * usable `expires_at` is `unknown`, and it must not be filed as `never`.
   */
  readonly expiry: TokenExpiry;
  /** Epoch ms when {@link SetupTokenClassification.expiry} is `known`. */
  readonly expiresAt?: number;
  readonly userId?: string;
  /** Redacted failure message when `debug_token` itself could not run. */
  readonly error?: string;
}

/** Outcome of the `fb_exchange_token` step. */
export interface SetupTokenExchange {
  /** `false` when skipped (already a System-User token) or when it failed. */
  readonly performed: boolean;
  /** Env key the resulting runtime token is written under. */
  readonly envKey: 'FB_ACCESS_TOKEN' | 'FB_SYSTEM_TOKEN';
  /** Epoch ms the long-lived token expires; absent ⇒ unknown or never. */
  readonly expiresAt?: number;
  /** Whole days until expiry (honest ~60 for the standard exchange). */
  readonly expiresInDays?: number;
  /** True only for a token Graph reports with no expiry (System-User shape). */
  readonly neverExpiring: boolean;
}

/** A Page discovered on `/me/accounts`. Page tokens are never included. */
export interface SetupTokenPage {
  readonly id: string;
  readonly name: string;
  readonly category?: string;
  readonly tasks: readonly string[];
  /** Whether Graph returned a Page token for it (value dropped immediately). */
  readonly hasToken: boolean;
  readonly selected: boolean;
}

/** A package-level scope the pasted token lacks, with the packages that need it. */
export interface MissingPackageScope {
  readonly scope: string;
  readonly packages: readonly PackageName[];
}

/** What happened (or would happen) to the env file. */
export interface SetupTokenWriteReport {
  /**
   * `written` — the file was replaced atomically at 0600.
   * `skipped` — a dry run, or an earlier stage failed; `keys` still lists what
   *   WOULD be written.
   * `needs-force` — the file exists and `--force` was not given. The decision to
   *   prompt belongs to the bootstrap; the module only reports the choice.
   * `failed` — the write itself errored (redacted message in `error`).
   */
  readonly status: 'written' | 'skipped' | 'needs-force' | 'failed';
  readonly path: string;
  /** Key NAMES written (or that would be written) — never values. */
  readonly keys: readonly string[];
  /** True iff owner-only permissions were actually enforced (POSIX only). */
  readonly restricted: boolean;
  /** Honest platform note (e.g. Windows cannot enforce POSIX 0600). */
  readonly note?: string;
  readonly error?: string;
  /**
   * Key NAMES the existing file holds that this run does not write, so the
   * replacement drops them (a confirm token, a write mode, a package
   * selection…). Present only when the file exists, was readable, and at least
   * one key would be lost. Never values.
   */
  readonly droppedKeys?: readonly string[];
}

/** The full machine-readable setup result (rendered by {@link renderSetupTokenReport}). */
export interface SetupTokenResult {
  /** True iff the flow completed everything it was asked to do. */
  readonly ok: boolean;
  readonly generatedAt: number;
  readonly apiVersion: string;
  readonly tokenSource: SetupTokenSource;
  readonly steps: readonly SetupTokenStep[];
  readonly token: SetupTokenClassification;
  readonly exchange?: SetupTokenExchange;
  readonly pages: readonly SetupTokenPage[];
  readonly selectedPageId?: string;
  /** Setup-blocking scopes the token lacks (see {@link REQUIRED_SETUP_SCOPES}). */
  readonly missingRequiredScopes: readonly string[];
  /** Non-blocking scope gaps, each naming the packages that need the scope. */
  readonly missingPackageScopes: readonly MissingPackageScope[];
  readonly write: SetupTokenWriteReport;
  readonly warnings: readonly string[];
  /** Always {@link SETUP_NEXT_COMMAND} — the concrete command to run next. */
  readonly nextCommand: string;
}

// ---------------------------------------------------------------------------
// Injected inputs
// ---------------------------------------------------------------------------

/** Writes the env file; defaults to `core`'s atomic 0600 helper. */
export type EnvFileWriter = (
  path: string,
  contents: string,
) => Promise<AtomicWriteResult>;

/** Injected inputs for {@link runSetupToken}. */
export interface SetupTokenDeps {
  readonly fbRequest: FbRequestFn;
  readonly settings: Settings;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly redactor: Redactor;
  /** The parsed invocation (see {@link parseSetupTokenArgs}). */
  readonly input: SetupTokenInput;
  /** Default env-file path override (the input's `--env-file` still wins). */
  readonly envFilePath?: string;
  /** Defaults to `process.platform`; drives the 0600 / Windows-honesty branch. */
  readonly platform?: NodeJS.Platform;
  /** Injected so tests never touch the real config dir. */
  readonly writeEnvFile?: EnvFileWriter;
  /**
   * Injected existence probe. Defaults to an `lstat` on the env-file path, which
   * also refuses a symbolic link there (an injected probe cannot report one).
   */
  readonly fileExists?: (path: string) => Promise<boolean>;
  /**
   * Injected reader for the EXISTING env file, used only to name the keys a
   * replacement drops. Resolves `undefined` when the file cannot be read.
   * Defaults to a UTF-8 read of the path.
   */
  readonly readEnvFile?: (path: string) => Promise<string | undefined>;
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * One `/me/accounts` entry. Every field is `unknown` on purpose: this is
 * untrusted Graph JSON, not a validated shape, and it is parsed defensively
 * (CC-NET-2) — a `tasks` that is not an array must not reach the renderer,
 * which joins that list.
 */
interface RawPageAccount {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly category?: unknown;
  readonly tasks?: unknown;
  readonly access_token?: unknown;
}

/** A non-empty trimmed string, or `undefined` for any other JSON shape. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? trimmed(value) : undefined;
}

/** Graph sends `tasks` as strings; anything else is dropped, never rendered. */
function normalizeTasks(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return (value as readonly unknown[]).filter(
    (task): task is string => typeof task === 'string',
  );
}

const UNKNOWN_TOKEN: SetupTokenClassification = {
  valid: false,
  type: 'UNKNOWN',
  scopes: [],
  expiry: 'unknown',
};

/** The credential authorizing `debug_token` (Graph wants one distinct from the input). */
function debugCredential(settings: Settings, token: string): string {
  return settings.appId !== undefined && settings.appSecret !== undefined
    ? `${settings.appId}|${settings.appSecret}`
    : token;
}

/**
 * The packages this install will actually run, for the scope cross-reference.
 *
 * An unparseable `FB_TOOL_PACKAGES` is not this command's job to fix — the server
 * refuses to start on it and says so. But it IS this command's job to stop
 * claiming otherwise: falling back to the default profile silently means the whole
 * scope cross-reference below is computed against a package set the install will
 * never load, and the operator finishes onboarding believing they are configured.
 * The fallback stays (a scope report is still worth more than an aborted setup);
 * the silence does not.
 */
function targetPackages(
  settings: Settings,
  warnings: string[],
  redact: (err: unknown) => string,
): readonly PackageName[] {
  const selection = settings.toolPackages;
  if (selection === undefined || selection.length === 0) {
    return DEFAULT_PROFILE_PACKAGES;
  }
  try {
    return sortByCanonical(expandSelection([...selection], 'FB_TOOL_PACKAGES'));
  } catch (err) {
    warnings.push(
      `FB_TOOL_PACKAGES could not be read (${redact(err)}); the scope report below ` +
        'covers the default package set instead. Fix that variable before starting ' +
        'the server — it will refuse to start until you do.',
    );
    return DEFAULT_PROFILE_PACKAGES;
  }
}

/** Scope → packages that need it, for every scope the token did not grant. */
function findMissingPackageScopes(
  packages: readonly PackageName[],
  granted: ReadonlySet<string>,
): MissingPackageScope[] {
  const byScope = new Map<string, PackageName[]>();
  for (const name of packages) {
    for (const scope of PACKAGE_PERMISSIONS[name] ?? []) {
      if (granted.has(scope)) continue;
      const owners = byScope.get(scope) ?? [];
      owners.push(name);
      byScope.set(scope, owners);
    }
  }
  return [...byScope.entries()]
    .map(([scope, owners]) => ({ scope, packages: owners }))
    .sort((a, b) => a.scope.localeCompare(b.scope));
}

/** What already sits at the env-file path, as far as the overwrite guard cares. */
type EnvTargetKind = 'absent' | 'present' | 'symlink';

/**
 * Default existence probe (kept off the hot path so tests can replace it).
 *
 * `lstat`, not `stat`: the write is a `rename` onto the path, which replaces a
 * symbolic link ITSELF rather than the file it points to. `stat` follows the
 * link, so a dangling one (`.env -> <a volume not mounted yet>`) read as
 * "absent" and was replaced without --force, and a live one was replaced under
 * --force while the file the operator actually manages kept the old token.
 */
async function probeEnvTarget(filePath: string): Promise<EnvTargetKind> {
  const { lstat } = await import('node:fs/promises');
  try {
    return (await lstat(filePath)).isSymbolicLink() ? 'symlink' : 'present';
  } catch {
    return 'absent';
  }
}

/** Default reader for the existing env file: its text, or `undefined`. */
async function readExistingEnvFile(filePath: string): Promise<string | undefined> {
  const { readFile } = await import('node:fs/promises');
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Key names the existing env file holds that `written` does not, in file order.
 * Parsed with dotenv — the same parser the loader uses — so a key is named
 * exactly when the server would have read it. Only NAMES leave this function.
 */
function keysDroppedFrom(
  contents: string | undefined,
  written: readonly string[],
): readonly string[] {
  if (contents === undefined) return [];
  let existing: readonly string[];
  try {
    existing = Object.keys(dotenv.parse(contents));
  } catch {
    return [];
  }
  const kept = new Set(written);
  return existing.filter((key) => !kept.has(key));
}

/** The sentence naming dropped keys, or `''` when none are lost. */
function describeDroppedKeys(dropped: readonly string[]): string {
  if (dropped.length === 0) return '';
  return (
    ` Replacing it drops ${dropped.join(', ')} (keys it holds that this run does ` +
    'not write; values are not printed): set them again afterwards if you still need them.'
  );
}

/**
 * Encode one `KEY=value` line the way the loader will actually read it back.
 *
 * dotenv strips ONE layer of quotes, and inside DOUBLE quotes it turns the two
 * characters `\n` / `\r` into real control characters — but it never unescapes
 * `\\` or `\"`. Escaping those on the way out therefore corrupts the value on the
 * way in: a secret containing `a\b` used to be written `a\\b` and loaded as
 * `a\\b`. Single quotes are taken literally by dotenv, so they carry a value with
 * a backslash or a double quote unharmed — except a TRAILING backslash: dotenv
 * matches `'(?:\\'|[^'])*'`, so the closing `\'` reads as an escaped quote and
 * the value runs on through the following lines, whose contents are then parsed
 * as keys of their own. Such a value is written bare when a bare value reads
 * back unchanged. dotenv also folds every CR in the file to LF before parsing;
 * only double quotes bring it back, through the escape `\r`.
 *
 * Anything left has no env-file representation at all and is refused loudly
 * instead of being written wrong, because a silently mangled secret fails later
 * as an unexplainable Graph auth error.
 */
function encodeEnvLine(key: string, value: string): string {
  if (!/["\\]/.test(value)) return `${key}="${value.replace(/\r/g, '\\r')}"`;
  if (!value.endsWith('\\')) {
    if (!/['\r]/.test(value)) return `${key}='${value}'`;
  } else if (BARE_ENV_VALUE.test(value)) {
    return `${key}=${value}`;
  }
  throw new Error(
    `${key} cannot be written to an env file: no env-file quoting reads its value ` +
      'back unchanged (a single quote or a carriage return next to a double quote ' +
      'or a backslash, or a trailing backslash on a value that cannot stand ' +
      `unquoted). Set ${key} in your environment by hand instead — the value is ` +
      'not printed here.',
  );
}

/**
 * A value dotenv reads back verbatim WITHOUT quotes: it opens with no quote,
 * `#` or whitespace (dotenv trims a bare value) and carries no `#` (a comment)
 * and no line break. Only used for values ending in a backslash, so trailing
 * whitespace cannot occur.
 */
const BARE_ENV_VALUE = /^[^\s'"`#][^#\r\n]*$/;

/**
 * Render the env file. Values are quoted so a token containing `#`, `$` or
 * whitespace can never be mis-parsed or re-expanded; see {@link encodeEnvLine}
 * for which quote is picked and why nothing is escaped.
 */
export function renderEnvFile(
  entries: readonly (readonly [string, string])[],
  generatedAt: number,
): string {
  const lines = [
    `# facebook-mcp configuration — written by \`facebook-mcp setup-token\``,
    `# ${new Date(generatedAt).toISOString()}`,
    '#',
    '# CONTAINS SECRETS. Keep it owner-readable only (mode 0600 on POSIX).',
    '# Re-running setup-token REPLACES this file; it is never merged.',
    '',
  ];
  for (const [key, value] of entries) {
    lines.push(encodeEnvLine(key, value));
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

/**
 * Run the guided setup: classify the pasted token, exchange it for a long-lived
 * one, discover Pages, derive the selected Page's token, and write the env file
 * atomically at 0600. Never throws for a credential, scope, Graph or file
 * problem — every failure is a reported step, so a broken credential still
 * produces a readable explanation.
 */
export async function runSetupToken(deps: SetupTokenDeps): Promise<SetupTokenResult> {
  const now = deps.clock.now();
  const { input, settings, redactor } = deps;
  const steps: SetupTokenStep[] = [];
  const warnings: string[] = [...input.notes];
  // Warnings composed BEFORE the write step that describe its outcome. Their
  // final wording is only known once that step has answered (written, dry run,
  // refused, failed), so each is rendered in `finish`, at the position it was
  // pushed — never as a past-tense "was written" for a file nothing touched.
  const writeDependentWarnings = new Map<
    number,
    (write: SetupTokenWriteReport) => string
  >();
  const pushWriteDependentWarning = (
    render: (write: SetupTokenWriteReport) => string,
  ): void => {
    writeDependentWarnings.set(warnings.length, render);
    warnings.push('');
  };
  const envPath =
    input.envFilePath ??
    deps.envFilePath ??
    defaultEnvFilePath(deps.platform !== undefined ? { platform: deps.platform } : {});

  const redact = (err: unknown): string => redactor.redactString(errorMessageOf(err));

  const finish = (parts: {
    token?: SetupTokenClassification;
    exchange?: SetupTokenExchange;
    pages?: readonly SetupTokenPage[];
    selectedPageId?: string;
    missingRequiredScopes?: readonly string[];
    missingPackageScopes?: readonly MissingPackageScope[];
    write: SetupTokenWriteReport;
  }): SetupTokenResult => ({
    ok: !steps.some((step) => step.status === 'failed'),
    generatedAt: now,
    apiVersion: settings.apiVersion,
    tokenSource: input.tokenSource,
    steps,
    token: parts.token ?? UNKNOWN_TOKEN,
    ...(parts.exchange !== undefined ? { exchange: parts.exchange } : {}),
    pages: parts.pages ?? [],
    ...(parts.selectedPageId !== undefined
      ? { selectedPageId: parts.selectedPageId }
      : {}),
    missingRequiredScopes: parts.missingRequiredScopes ?? [],
    missingPackageScopes: parts.missingPackageScopes ?? [],
    write: parts.write,
    warnings: warnings.map(
      (warning, index) => writeDependentWarnings.get(index)?.(parts.write) ?? warning,
    ),
    nextCommand: SETUP_NEXT_COMMAND,
  });

  const skippedWrite = (keys: readonly string[] = []): SetupTokenWriteReport => ({
    status: 'skipped',
    path: envPath,
    keys,
    restricted: false,
  });

  // --- 1. Input -------------------------------------------------------------
  const pasted = trimmed(input.token);
  if (pasted === undefined) {
    steps.push({
      id: 'input',
      status: 'failed',
      summary: 'no short-lived token supplied',
      // Name the blocking scope inline: `docs/` is not part of the published
      // package, so an operator who installed from npm cannot open a runbook
      // path, and this is the very first message the flow ever prints.
      detail:
        'Open the Graph API Explorer (developers.facebook.com/tools/explorer), ' +
        'select your app and the "User Token" dropdown, tick at least ' +
        `${REQUIRED_SETUP_SCOPES.join(', ')} (plus the scopes of the packages you ` +
        'enable — the README\'s "Permissions you need to grant" table lists ' +
        'them), generate the token, then run: ' +
        `${SETUP_TOKEN_ENV_VAR}=<token> facebook-mcp setup-token`,
    });
    return finish({ write: skippedWrite() });
  }

  // Register BEFORE anything can log or fail with it in the message (C3).
  redactor.addSecret(pasted);
  deps.logger.debug('setup-token: token received', { source: input.tokenSource });
  steps.push({
    id: 'input',
    status: 'ok',
    summary: `short-lived token received (source: ${input.tokenSource})`,
  });

  // --- 2. Classify ----------------------------------------------------------
  let classification: SetupTokenClassification;
  try {
    const info = await debugToken(pasted, {
      fbRequest: deps.fbRequest,
      accessToken: debugCredential(settings, pasted),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    });
    classification = {
      valid: info.valid,
      type: info.type,
      ...(info.appId !== undefined ? { appId: info.appId } : {}),
      scopes: info.scopes,
      expiry: info.expiry,
      ...(info.expiresAt !== undefined ? { expiresAt: info.expiresAt } : {}),
      ...(info.userId !== undefined ? { userId: info.userId } : {}),
    };
  } catch (err) {
    const message = redact(err);
    steps.push({
      id: 'classify',
      status: 'failed',
      summary: 'debug_token failed',
      detail:
        `Graph could not classify the token: ${message}. Check FB_APP_ID / ` +
        'FB_APP_SECRET (App settings → Basic) and that the token belongs to that app.',
    });
    return finish({ token: { ...UNKNOWN_TOKEN, error: message }, write: skippedWrite() });
  }

  if (!classification.valid) {
    steps.push({
      id: 'classify',
      status: 'failed',
      summary: `token is not valid (type ${classification.type})`,
      detail:
        'Graph API Explorer tokens live 1–2 hours. Generate a fresh User token ' +
        'in the Explorer and re-run. If it was just generated, confirm you picked ' +
        'the same app as FB_APP_ID.',
    });
    return finish({ token: classification, write: skippedWrite() });
  }

  if (classification.type === 'PAGE') {
    steps.push({
      id: 'classify',
      status: 'failed',
      summary: 'this is already a Page token, not a User token',
      detail:
        'setup-token exchanges a USER token. A Page token needs no exchange: set ' +
        'FB_PAGE_TOKEN (and FB_PAGE_ID) directly, then run `facebook-mcp doctor`. ' +
        'To run the guided flow, generate a User token in the Graph API Explorer.',
    });
    return finish({ token: classification, write: skippedWrite() });
  }

  if (classification.type !== 'USER' && classification.type !== 'SYSTEM_USER') {
    steps.push({
      id: 'classify',
      status: 'failed',
      summary: `unsupported token type ${classification.type}`,
      detail:
        'Expected a User token from the Graph API Explorer (or a System-User ' +
        'token). An App token (`{app-id}|{app-secret}`) cannot act on a Page.',
    });
    return finish({ token: classification, write: skippedWrite() });
  }

  const granted = new Set(classification.scopes);
  const missingRequiredScopes = REQUIRED_SETUP_SCOPES.filter(
    (scope) => !granted.has(scope),
  );
  const missingPackageScopes = findMissingPackageScopes(
    targetPackages(settings, warnings, redact),
    granted,
  );

  if (missingRequiredScopes.length > 0) {
    steps.push({
      id: 'classify',
      status: 'failed',
      summary: `token is missing required scope(s): ${missingRequiredScopes.join(', ')}`,
      detail:
        `The core package needs ${missingRequiredScopes.join(', ')} to read ` +
        '/me/accounts — without it no Page can be discovered or given a token. ' +
        'Re-generate the Explorer token with that permission ticked and re-run.',
    });
    return finish({
      token: classification,
      missingRequiredScopes,
      missingPackageScopes,
      write: skippedWrite(),
    });
  }

  steps.push({
    id: 'classify',
    status: 'ok',
    summary: `valid ${classification.type} token, ${String(classification.scopes.length)} scope(s)`,
  });

  for (const missing of missingPackageScopes) {
    warnings.push(
      `Scope ${missing.scope} was not granted; the ${missing.packages.join(', ')} ` +
        `package(s) that need it will be blocked (\`${SETUP_NEXT_COMMAND}\` shows the full matrix).`,
    );
  }

  // --- 3. Exchange ----------------------------------------------------------
  let runtimeToken = pasted;
  let exchange: SetupTokenExchange;

  if (classification.type === 'SYSTEM_USER') {
    // A System-User token is already the long-lived (or non-expiring) credential
    // route A produces — exchanging it would be a downgrade, so skip honestly.
    exchange = {
      performed: false,
      envKey: 'FB_SYSTEM_TOKEN',
      ...(classification.expiresAt !== undefined
        ? {
            expiresAt: classification.expiresAt,
            expiresInDays: Math.max(
              0,
              Math.floor((classification.expiresAt - now) / MS_PER_DAY),
            ),
          }
        : {}),
      // Only Graph's explicit `expires_at: 0` is "never"; an answer that named no
      // expiry is a token whose lifetime nobody knows, and it is still written.
      neverExpiring: classification.expiry === 'never',
    };
    if (classification.expiry === 'unknown') {
      warnings.push(
        'Graph did not report an expiry for this System-User token, so whether it ' +
          `expires is unknown; it is written verbatim — verify with \`${SETUP_NEXT_COMMAND}\` ` +
          "and check the token in the Graph API Explorer's Access Token Debugger.",
      );
    }
    steps.push({
      id: 'exchange',
      status: 'skipped',
      summary: 'System-User token needs no exchange',
      detail: 'It is written as FB_SYSTEM_TOKEN and used verbatim.',
    });
  } else {
    const appId = settings.appId;
    const appSecret = settings.appSecret;
    if (appId === undefined || appSecret === undefined) {
      steps.push({
        id: 'exchange',
        status: 'failed',
        summary: 'cannot exchange without app credentials',
        detail:
          'The long-lived exchange is server-side and needs both FB_APP_ID and ' +
          'FB_APP_SECRET (App settings → Basic). Export them and re-run — an ' +
          'unexchanged Explorer token expires in 1–2 hours, so nothing was written.',
      });
      return finish({
        token: classification,
        missingPackageScopes,
        write: skippedWrite(),
      });
    }

    try {
      // NOTE: `/oauth/access_token` is the one Graph edge that REQUIRES the app
      // secret and the input token as query params — Meta's contract, and a
      // one-time setup call, never a runtime one. Everything else uses Bearer.
      const res = await deps.fbRequest<{
        access_token?: string;
        expires_in?: number;
      }>({
        protocol: 'json',
        method: 'GET',
        host: 'graph',
        path: '/oauth/access_token',
        params: {
          grant_type: 'fb_exchange_token',
          client_id: appId,
          client_secret: appSecret,
          fb_exchange_token: pasted,
        },
        token: pasted,
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      });
      const longLived = trimmed(res.data.access_token);
      if (longLived === undefined) {
        steps.push({
          id: 'exchange',
          status: 'failed',
          summary: 'Graph returned no long-lived token',
          detail:
            'The exchange succeeded but carried no access_token. Verify FB_APP_ID / ' +
            'FB_APP_SECRET belong to the same app as the pasted token, then re-run.',
        });
        return finish({
          token: classification,
          missingPackageScopes,
          write: skippedWrite(),
        });
      }
      redactor.addSecret(longLived);
      runtimeToken = longLived;

      const expiresIn = res.data.expires_in;
      // `expires_in` is untrusted wire data reached through a cast, and it does
      // not take a malicious Graph to break this — only a wrong one:
      // `JSON.parse('{"expires_in":1e400}')` yields `Infinity`, and a merely
      // enormous finite value lands past {@link MAX_EPOCH_MS}, where a `Date`
      // stops existing. An expiry that cannot be expressed as a date is an
      // expiry we did not get, and the branch below already says that honestly.
      const candidate =
        typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
          ? now + expiresIn * 1000
          : undefined;
      const expiresAt =
        candidate !== undefined && candidate <= MAX_EPOCH_MS ? candidate : undefined;
      exchange = {
        performed: true,
        envKey: 'FB_ACCESS_TOKEN',
        ...(expiresAt !== undefined
          ? {
              expiresAt,
              expiresInDays: Math.floor((expiresAt - now) / MS_PER_DAY),
            }
          : {}),
        neverExpiring: false,
      };
      if (expiresAt === undefined) {
        warnings.push(
          'Graph did not report an expiry for the exchanged token; assume the ' +
            `standard ~${String(LONG_LIVED_SECONDS / 86_400)} days and verify with \`${SETUP_NEXT_COMMAND}\`.`,
        );
      }
      // "Long-lived" is a claim about the wire, not about the endpoint: Graph
      // can answer the exchange with a token that dies within hours (a pasted
      // token that was already long-lived and near its end, for one). Calling
      // that "long-lived token obtained (~0 days)" and writing it in silence
      // hands the operator a credential that is dead by the time they run doctor.
      const shortLifetime =
        expiresAt !== undefined && expiresAt - now < MS_PER_DAY
          ? describeShortLifetime(expiresAt - now)
          : undefined;
      if (shortLifetime !== undefined) {
        warnings.push(
          `Graph reported the exchanged token expires in ${shortLifetime} — that is ` +
            `not a long-lived token (expected ~${String(LONG_LIVED_SECONDS / 86_400)} days). ` +
            'It works until then; generate a fresh User token in the Graph API ' +
            'Explorer and re-run to obtain a long-lived one.',
        );
      }
      steps.push({
        id: 'exchange',
        status: 'ok',
        summary:
          shortLifetime !== undefined
            ? `token obtained, but it expires in ${shortLifetime}`
            : exchange.expiresInDays !== undefined
              ? `long-lived token obtained (~${String(exchange.expiresInDays)} days)`
              : 'long-lived token obtained (expiry not reported)',
      });
    } catch (err) {
      const message = redact(err);
      steps.push({
        id: 'exchange',
        status: 'failed',
        summary: 'fb_exchange_token failed',
        detail:
          `Graph refused the exchange: ${message}. The usual causes are a stale ` +
          'Explorer token (they live 1–2 hours), or FB_APP_ID / FB_APP_SECRET ' +
          'belonging to a different app than the token.',
      });
      return finish({
        token: classification,
        missingPackageScopes,
        write: skippedWrite(),
      });
    }
  }

  // --- 4. Pages -------------------------------------------------------------
  let pages: SetupTokenPage[] = [];
  let selectedPageId: string | undefined;
  let pageToken: string | undefined;

  try {
    const res = await deps.fbRequest<{
      data?: readonly RawPageAccount[];
      paging?: { readonly next?: unknown };
    }>({
      protocol: 'json',
      method: 'GET',
      host: 'graph',
      path: '/me/accounts',
      params: {
        fields: 'id,name,category,tasks,access_token',
        limit: PAGE_LIST_LIMIT,
      },
      token: runtimeToken,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    });
    const raw = (res.data.data ?? []).filter(
      (account): account is RawPageAccount & { id: string } =>
        typeof account.id === 'string' && account.id.length > 0,
    );

    // EVERY entry carries a live Page token, not only the one we go on to
    // select. Register them all here — before any later step can fail with the
    // payload in its message — so the header's "every derived Page token" holds
    // for the Pages the operator did not pick.
    for (const account of raw) {
      const token = asString(account.access_token);
      if (token !== undefined) redactor.addSecret(token);
    }

    // One page of results only — this flow does NOT follow `paging.next`, so
    // when Graph says there is more, every count and every "not among your
    // Pages" verdict below is about the first PAGE_LIST_LIMIT entries, and must
    // say so rather than claim the operator's Page does not exist.
    const truncated = asString(res.data.paging?.next) !== undefined;

    // Pick the Page: an explicit --page wins; a single Page auto-selects — but
    // only when it is single: a truncated listing with one visible entry is NOT
    // a unique Page, and pinning it would write FB_PAGE_ID for a Page the
    // operator never chose.
    const requested = input.pageId;
    if (requested !== undefined) {
      const match = raw.find((account) => account.id === requested);
      if (match === undefined) {
        steps.push({
          id: 'pages',
          status: 'failed',
          summary: truncated
            ? `Page ${requested} is not among the first ${String(PAGE_LIST_LIMIT)} ` +
              'Pages this token can see (Graph reported more)'
            : `Page ${requested} is not among the Pages this token can see`,
          detail:
            raw.length > 0
              ? `Available Page IDs: ${raw.map((account) => account.id).join(', ')}.`
              : 'This token sees no Pages at all, and pages_show_list IS granted ' +
                '(classify verified it, or the run would have stopped there). ' +
                'Check that the token holder has a role on the Page — for a ' +
                'System-User token, that the Page is assigned to it as an asset.',
        });
        pages = raw.map((account) => toPage(account, undefined));
        return finish({
          token: classification,
          exchange,
          pages,
          missingPackageScopes,
          write: skippedWrite(),
        });
      }
      selectedPageId = match.id;
    } else if (raw.length === 1 && !truncated) {
      selectedPageId = raw[0]?.id;
    }

    pages = raw.map((account) => toPage(account, selectedPageId));

    if (raw.length === 0) {
      pushWriteDependentWarning(
        (write) =>
          'No Pages were returned by /me/accounts, and pages_show_list IS granted ' +
          '(classify verified it), so the scope is not the cause. Either the ' +
          'token holder has no role on any Page, or — for a System-User token — ' +
          'the Page is not assigned to it as an asset, or the token was ' +
          'generated for a different app than the one the Page runs through. ' +
          capitalize(
            writeOutcome(write, {
              written: 'The runtime token is still written',
              planned: 'A real run still writes the runtime token',
              pending: 'it still carries the runtime token',
            }),
          ) +
          '; re-run setup-token once a Page is visible.',
      );
    } else if (truncated) {
      warnings.push(
        `Graph reported more Pages than the ${String(raw.length)} this run listed ` +
          `(it reads one window of up to ${String(PAGE_LIST_LIMIT)}); only that ` +
          'window was considered, so a Page outside it cannot be discovered or ' +
          'pinned with --page=<id> here.',
      );
    }
    if (raw.length > 0 && selectedPageId === undefined) {
      warnings.push(
        `${String(raw.length)} Page(s) found${truncated ? ' of more' : ''} and none ` +
          'selected, so no FB_PAGE_ID / ' +
          'FB_PAGE_TOKEN is included. Re-run with --page=<id> to pin one, and add ' +
          '--force: an env file that already exists — including the one this run ' +
          'leaves behind — is refused without it, and replaced, never merged.',
      );
    }

    let deriveError: string | undefined;
    if (selectedPageId !== undefined) {
      const selected = raw.find((account) => account.id === selectedPageId);
      pageToken = asString(selected?.access_token);
      if (pageToken === undefined) {
        // Graph omits access_token when the field is not returned for this token;
        // derive it explicitly rather than silently writing a Page-token-less config.
        const derived = await derivePageToken(deps, selectedPageId, runtimeToken, redact);
        pageToken = derived.token;
        deriveError = derived.error;
      }
      if (pageToken !== undefined) redactor.addSecret(pageToken);
    }

    steps.push({
      id: 'pages',
      status: 'ok',
      summary:
        selectedPageId !== undefined
          ? `${String(raw.length)} Page(s) found; selected ${selectedPageId}${
              pageToken !== undefined ? ' (Page token derived)' : ' (no Page token)'
            }`
          : `${String(raw.length)} Page(s) found; none selected`,
    });
    if (selectedPageId !== undefined && pageToken === undefined) {
      const pageId = selectedPageId;
      pushWriteDependentWarning(
        (write) =>
          `No Page token could be derived for Page ${pageId}` +
          (deriveError !== undefined ? ` (${deriveError})` : '') +
          '; ' +
          writeOutcome(write, {
            written: 'only the runtime token was written',
            planned: 'a real run writes only the runtime token',
            pending: 'it carries only the runtime token',
          }) +
          '. ' +
          (deriveError !== undefined
            ? 'Resolve that cause (a missing role on the Page is the usual one), then re-run.'
            : 'Confirm your role on the Page, then re-run.'),
      );
    }
  } catch (err) {
    const message = redact(err);
    steps.push({
      id: 'pages',
      status: 'failed',
      summary: '/me/accounts failed',
      detail:
        `Graph refused the Page listing: ${message}. classify already verified ` +
        "pages_show_list is granted, so suspect the token holder's Page role " +
        '(for a System-User token, the Page asset assignment) or an expired ' +
        'token rather than the scope.',
    });
    return finish({
      token: classification,
      exchange,
      missingPackageScopes,
      write: skippedWrite(),
    });
  }

  // --- 5. Write -------------------------------------------------------------
  const entries: (readonly [string, string])[] = [];
  if (settings.appId !== undefined) entries.push(['FB_APP_ID', settings.appId]);
  if (settings.appSecret !== undefined) {
    entries.push(['FB_APP_SECRET', settings.appSecret]);
  }
  entries.push([exchange.envKey, runtimeToken]);
  if (selectedPageId !== undefined) entries.push(['FB_PAGE_ID', selectedPageId]);
  if (pageToken !== undefined) entries.push(['FB_PAGE_TOKEN', pageToken]);
  const keys = entries.map(([key]) => key);

  // Render BEFORE the dry-run branch: the real run refuses a value no env file
  // can hold, so a dry run must not report success and promise the write.
  let contents: string;
  try {
    contents = renderEnvFile(entries, now);
  } catch (err) {
    const message = redact(err);
    steps.push({
      id: 'write',
      status: 'failed',
      summary: 'a value cannot be written to an env file',
      detail: message,
    });
    return finish({
      token: classification,
      exchange,
      pages,
      ...(selectedPageId !== undefined ? { selectedPageId } : {}),
      missingPackageScopes,
      write: { status: 'failed', path: envPath, keys, restricted: false, error: message },
    });
  }

  // Probe BEFORE the dry-run branch, for the same reason the render happens
  // first: a dry run answers "what will the real run do?", and promising a
  // write that run refuses (a symbolic link — refused even with --force — or an
  // existing file without --force) sends the operator into a failing command.
  // The probe is read-only (`lstat`), so a dry run still touches nothing.
  const target: EnvTargetKind =
    deps.fileExists !== undefined
      ? (await deps.fileExists(envPath))
        ? 'present'
        : 'absent'
      : await probeEnvTarget(envPath);

  // Name (never print) what a replacement would lose: the file is replaced
  // wholesale, so a hand-set FB_CONFIRM_TOKEN / FB_WRITE_MODE / FB_TOOL_PACKAGES
  // otherwise vanishes without a word and the next start runs differently.
  const droppedKeys =
    target === 'present'
      ? keysDroppedFrom(await (deps.readEnvFile ?? readExistingEnvFile)(envPath), keys)
      : [];
  const dropped = describeDroppedKeys(droppedKeys);
  const droppedField = droppedKeys.length > 0 ? { droppedKeys } : {};

  if (!input.write && target !== 'symlink') {
    const existing =
      target === 'present'
        ? input.force
          ? ` ${envPath} already exists and will be REPLACED (never merged).${dropped}`
          : ` ${envPath} already exists: add --force to replace it (it is ` +
            `replaced, never merged), or point elsewhere with --env-file=<path>.${dropped}`
        : '';
    steps.push({
      id: 'write',
      status: 'skipped',
      summary: 'dry run — nothing was written',
      detail: `Re-run without --no-write to write ${keys.join(', ')} to ${envPath}.${existing}`,
    });
    return finish({
      token: classification,
      exchange,
      pages,
      ...(selectedPageId !== undefined ? { selectedPageId } : {}),
      missingPackageScopes,
      write: { ...skippedWrite(keys), ...droppedField },
    });
  }

  if (target === 'symlink') {
    // Refused even with --force: replacing the link is never what was asked
    // for, and following it would write the credential wherever the link
    // points. The operator names the real file instead.
    const error = `${envPath} is a symbolic link; refusing to replace it`;
    steps.push({
      id: 'write',
      status: 'failed',
      summary: 'env file path is a symbolic link',
      detail:
        `${error}. An atomic write would replace the LINK, not the file it points ` +
        'to. Pass --env-file=<path> with the real file (the link target) instead.',
    });
    return finish({
      token: classification,
      exchange,
      pages,
      ...(selectedPageId !== undefined ? { selectedPageId } : {}),
      missingPackageScopes,
      write: { status: 'failed', path: envPath, keys, restricted: false, error },
    });
  }
  if (target === 'present' && !input.force) {
    steps.push({
      id: 'write',
      status: 'failed',
      summary: 'env file already exists',
      detail:
        `${envPath} exists and would be REPLACED (never merged). Re-run with ` +
        `--force to overwrite, or point elsewhere with --env-file=<path>.${dropped}`,
    });
    return finish({
      token: classification,
      exchange,
      pages,
      ...(selectedPageId !== undefined ? { selectedPageId } : {}),
      missingPackageScopes,
      write: {
        status: 'needs-force',
        path: envPath,
        keys,
        restricted: false,
        ...droppedField,
      },
    });
  }

  const write = deps.writeEnvFile ?? defaultWriter(deps.platform);
  try {
    const result = await write(envPath, contents);
    const writtenDetail = `${result.note ?? ''}${dropped}`.trim();
    steps.push({
      id: 'write',
      status: 'ok',
      summary: `wrote ${String(keys.length)} key(s) to ${result.path}`,
      ...(writtenDetail !== '' ? { detail: writtenDetail } : {}),
    });
    return finish({
      token: classification,
      exchange,
      pages,
      ...(selectedPageId !== undefined ? { selectedPageId } : {}),
      missingPackageScopes,
      write: {
        status: 'written',
        path: result.path,
        keys,
        restricted: result.restricted,
        ...(result.note !== undefined ? { note: result.note } : {}),
        ...droppedField,
      },
    });
  } catch (err) {
    const message = redact(err);
    steps.push({
      id: 'write',
      status: 'failed',
      summary: 'could not write the env file',
      detail:
        `${envPath}: ${message}. Check the directory exists and is writable, or ` +
        'pass --env-file=<path> to write elsewhere.',
    });
    return finish({
      token: classification,
      exchange,
      pages,
      ...(selectedPageId !== undefined ? { selectedPageId } : {}),
      missingPackageScopes,
      write: {
        status: 'failed',
        path: envPath,
        keys,
        restricted: false,
        error: message,
      },
    });
  }
}

/**
 * The outcome clause of a warning composed before the write step: `written`
 * when the file was written, `planned` plus "this dry run wrote nothing" for a
 * dry run (the only `skipped` write that reaches a warning — every earlier
 * failure returns before one is composed), and an explicit "nothing was
 * written" when the write was refused or failed.
 */
function writeOutcome(
  write: SetupTokenWriteReport,
  wording: {
    readonly written: string;
    readonly planned: string;
    readonly pending: string;
  },
): string {
  switch (write.status) {
    case 'written':
      return wording.written;
    case 'skipped':
      return `${wording.planned} — this dry run wrote nothing`;
    case 'needs-force':
    case 'failed':
      return (
        'nothing was written (see the Env file section); once the write ' +
        `succeeds, ${wording.pending}`
      );
  }
}

/** Upper-case the first character, for a clause that opens a sentence. */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function toPage(
  account: RawPageAccount & { id: string },
  selectedPageId: string | undefined,
): SetupTokenPage {
  const name = asString(account.name);
  const category = asString(account.category);
  return {
    id: account.id,
    name: name ?? '(unnamed Page)',
    ...(category !== undefined ? { category } : {}),
    tasks: normalizeTasks(account.tasks),
    // Presence only — the value is dropped here and never enters the result
    // (it is registered with the redactor at the listing, see runSetupToken).
    hasToken: asString(account.access_token) !== undefined,
    selected: account.id === selectedPageId,
  };
}

/**
 * Derive a Page token explicitly; a failure is a warning, never a throw. The
 * failure's (redacted) reason is handed back: a timeout or a dead token is not
 * fixed by checking the Page role, and the operator needs Graph's own words to
 * tell which one it was.
 */
async function derivePageToken(
  deps: SetupTokenDeps,
  pageId: string,
  baseToken: string,
  redact: (err: unknown) => string,
): Promise<{ readonly token?: string; readonly error?: string }> {
  try {
    const res = await deps.fbRequest<{ access_token?: string }>({
      protocol: 'json',
      method: 'GET',
      host: 'graph',
      path: `/${pageId}`,
      params: { fields: 'access_token' },
      token: baseToken,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    });
    const token = trimmed(res.data.access_token);
    return token !== undefined ? { token } : {};
  } catch (err) {
    return { error: redact(err) };
  }
}

/** The production writer: `core`'s atomic 0600 helper, no permission logic here. */
function defaultWriter(platform: NodeJS.Platform | undefined): EnvFileWriter {
  return (filePath, contents) =>
    atomicWriteFile(filePath, contents, {
      mode: 0o600,
      ...(platform !== undefined ? { platform } : {}),
    });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STEP_LABEL: Record<SetupStepStatus, string> = {
  ok: 'OK',
  skipped: 'SKIP',
  failed: 'FAIL',
};

/**
 * Render an epoch, or say plainly that it could not be read. `new Date(ms)` is
 * an Invalid Date for a `NaN` or out-of-range epoch, and `toISOString()` on one
 * throws `RangeError: Invalid time value` — from inside the renderer, so a
 * single unreadable number costs the operator not that line but the entire
 * report, at the exact moment they ran this command to find out what was wrong.
 * A bad line is still a diagnosis; a renderer that throws is not.
 */
/** `~N hour(s)` / `~N minute(s)` for a lifetime under a day, never `~0`. */
function describeShortLifetime(ms: number): string {
  if (ms >= MS_PER_HOUR) {
    const hours = Math.floor(ms / MS_PER_HOUR);
    return `~${String(hours)} hour${hours === 1 ? '' : 's'}`;
  }
  const minutes = Math.max(1, Math.floor(ms / MS_PER_MINUTE));
  return `~${String(minutes)} minute${minutes === 1 ? '' : 's'}`;
}

function iso(ms: number): string {
  const at = new Date(ms);
  return Number.isNaN(at.getTime()) ? '(unreadable timestamp)' : at.toISOString();
}

function describeExchange(result: SetupTokenResult): string[] {
  const exchange = result.exchange;
  if (exchange === undefined) return ['  not reached'];
  const lines: string[] = [];
  if (exchange.neverExpiring) {
    lines.push('  long-lived token: non-expiring (System-User token, used verbatim)');
  } else if (exchange.expiresAt !== undefined) {
    const days = exchange.expiresInDays ?? 0;
    lines.push(
      exchange.performed && days === 0
        ? // The exchange handed back a token that dies within the day — the
          // warnings say how soon; the label must not call it long-lived.
          `  token:            expires ${iso(exchange.expiresAt)} (under a day — NOT long-lived)`
        : `  long-lived token: expires ${iso(exchange.expiresAt)} (~${String(days)} days)`,
    );
  } else if (exchange.performed) {
    lines.push('  long-lived token: obtained, expiry not reported by Graph');
  } else {
    // A System-User token Graph answered without a usable `expires_at`: not
    // exchanged, not known to be non-expiring, and not to be labelled either.
    lines.push('  System-User token: used verbatim, expiry not reported by Graph');
  }
  lines.push(`  written as:       ${exchange.envKey}`);
  if (!exchange.neverExpiring) {
    lines.push(`  note:             ${SYSTEM_USER_GUIDANCE}`);
  }
  return lines;
}

function renderPage(page: SetupTokenPage): string {
  const marker = page.selected ? '*' : ' ';
  const category = page.category !== undefined ? ` [${page.category}]` : '';
  const tasks = page.tasks.length > 0 ? ` tasks: ${page.tasks.join(',')}` : '';
  return `  ${marker} ${page.id.padEnd(18)} ${page.name}${category}${tasks}`;
}

function describeWrite(write: SetupTokenWriteReport): string[] {
  const lines = [`  path:   ${write.path}`];
  switch (write.status) {
    case 'written':
      lines.push(
        `  status: written atomically${write.restricted ? ' (mode 0600, owner only)' : ''}`,
      );
      break;
    case 'skipped':
      lines.push('  status: not written (dry run or an earlier step failed)');
      break;
    case 'needs-force':
      lines.push('  status: NOT written — the file exists; re-run with --force');
      break;
    case 'failed':
      lines.push(`  status: FAILED — ${write.error ?? 'unknown error'}`);
      break;
  }
  lines.push(
    `  keys:   ${write.keys.length > 0 ? write.keys.join(', ') : '(none)'} (values are never printed)`,
  );
  if (write.droppedKeys !== undefined && write.droppedKeys.length > 0) {
    lines.push(
      `  ${write.status === 'written' ? 'dropped' : 'drops'}:  ${write.droppedKeys.join(', ')} ` +
        '(held by the old file, not rewritten — set them again if needed)',
    );
  }
  if (write.note !== undefined) lines.push(`  note:   ${write.note}`);
  return lines;
}

/** Render a {@link SetupTokenResult} as operator-readable text. */
export function renderSetupTokenReport(result: SetupTokenResult): string {
  const lines: string[] = [
    'facebook-mcp setup-token',
    '========================',
    '',
    'Run',
    `  status:       ${result.ok ? 'completed' : 'INCOMPLETE'}`,
    `  API version:  ${result.apiVersion}`,
    `  token source: ${result.tokenSource}`,
    `  generated at: ${iso(result.generatedAt)}`,
    '',
    'Steps',
  ];
  for (const step of result.steps) {
    lines.push(
      `  [${STEP_LABEL[step.status].padEnd(4)}] ${step.id.padEnd(8)} ${step.summary}`,
    );
    if (step.detail !== undefined) lines.push(`           -> ${step.detail}`);
  }

  lines.push(
    '',
    'Token',
    `  type:    ${result.token.type}`,
    `  valid:   ${result.token.valid ? 'yes' : 'no'}`,
    `  app id:  ${result.token.appId ?? '-'}`,
    `  scopes:  ${result.token.scopes.length > 0 ? result.token.scopes.join(', ') : '(none)'}`,
  );
  if (result.missingRequiredScopes.length > 0) {
    lines.push(`  MISSING: ${result.missingRequiredScopes.join(', ')} (setup-blocking)`);
  }
  for (const missing of result.missingPackageScopes) {
    lines.push(`  missing: ${missing.scope} — needed by ${missing.packages.join(', ')}`);
  }

  lines.push('', 'Exchange', ...describeExchange(result));

  lines.push('', 'Pages');
  if (result.pages.length === 0) {
    lines.push('  (none found)');
  } else {
    for (const page of result.pages) lines.push(renderPage(page));
  }

  lines.push('', 'Env file', ...describeWrite(result.write));

  if (result.warnings.length > 0) {
    lines.push('', 'Warnings');
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }

  lines.push('', 'Next step:', `  ${result.nextCommand}`);
  return lines.join('\n');
}
