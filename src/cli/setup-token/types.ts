// Public types of the `setup-token` flow: the parsed invocation, the result
// shapes the report renders, and the injected dependencies of `runSetupToken`.

import type {
  AtomicWriteResult,
  Clock,
  FbRequestFn,
  Logger,
  PackageName,
  Redactor,
  Settings,
  TokenExpiry,
  TokenType,
} from '../../core/index.js';

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
  /**
   * The concrete command to run next: `doctor` under the launch form the
   * operator used ({@link SetupTokenDeps.launchCommand}).
   */
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
  /**
   * How the operator launched this binary (`npx -y <package>`, `facebook-mcp`,
   * `node build/index.js` — see `resolveLaunchCommand`). Every command the
   * report tells them to run is rendered with it. Defaults to `facebook-mcp`.
   */
  readonly launchCommand?: string;
  readonly signal?: AbortSignal;
}
