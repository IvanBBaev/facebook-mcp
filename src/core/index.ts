// Compatibility barrel for the `core` layer (tasks F02 + F04–F09).
//
// Deprecated for new code: import from the specific module (`../core/<module>.js`,
// e.g. `../core/http.js`) instead of this barrel. The barrel is kept so the
// existing importers keep compiling; its public surface is listed explicitly
// below, grouped by source module, so additions and removals are visible in
// review. Do not add `export *` lines here: every new symbol is opt-in.
//
// Deprecation is documented here rather than with per-symbol `@deprecated`
// tags: a tag on a re-export specifier would flag every existing barrel import
// (100+ files) in editors, and a tag on the whole `export { … }` statement is
// ignored by TypeScript.
//
// It re-exports the frozen contracts from `./types.js` plus the concrete core
// implementations (config/settings, logging/redaction, error mapping, the
// fbRequest HTTP client, auth + the pages registry). The in-memory fakes live
// under `./fakes/` and are imported directly by tests only — they are
// intentionally NOT part of this production barrel. The `api`-layer pagination
// helper (`../api/shared.js`, task F10) is likewise not re-exported here.

export {
  DEFAULT_PROFILE_KEY,
  GraphApiError,
  PACKAGE_NAMES,
  USAGE_HEADERS,
} from './types.js';
export type {
  ActivityCursorStore,
  ActivityMarks,
  ApiFamily,
  ApplyResult,
  Clock,
  ConfirmationMethod,
  ConfirmationRequest,
  ConfirmationResponse,
  Confirmer,
  Cursor,
  DivergenceDiff,
  ErrorAction,
  ErrorCategory,
  FbRequest,
  FbRequestBase,
  FbRequestFn,
  FbResponse,
  FbResponseHeaders,
  FetchAllBudget,
  GraphApiErrorInit,
  GraphHost,
  HostAllowlist,
  HttpMethod,
  Journal,
  JournalEntry,
  JournalEntryInput,
  JournalOutcome,
  JournalStatus,
  JsonRequest,
  LogFields,
  LogLevel,
  Logger,
  MultipartPart,
  MultipartRequest,
  PackageName,
  PackageSpec,
  Page,
  PageProfileConfig,
  PageRef,
  PageRequest,
  PageResolver,
  ParamValue,
  Plan,
  PlanId,
  PlanPreview,
  ProgressReporter,
  ProgressUpdate,
  Redactor,
  RedactorConfig,
  ResolvedPage,
  RuploadRequest,
  SavedReply,
  SavedReplyStore,
  SavedReplyWrite,
  Settings,
  TaintSource,
  TaintedContent,
  ToolAnnotations,
  ToolContent,
  ToolContext,
  ToolHandler,
  ToolResult,
  ToolSpec,
  ToolTextContent,
  TransportKind,
  UsageSnapshot,
  WriteMode,
  WriteTier,
} from './types.js';

// F04 — configuration & settings resolution.
export {
  ACTIVITY_STATE_FILE_NAME,
  APP_DIR_NAME,
  ENV_FILE_NAME,
  EXPORT_DIR_NAME,
  JOURNAL_FILE_NAME,
  SAVED_REPLIES_FILE_NAME,
  atomicWriteFile,
  configDir,
  defaultActivityStatePath,
  defaultExportDir,
  defaultJournalPath,
  describeFileProtection,
  envFilePath,
  isWindows,
  loadEnvFile,
  savedRepliesPath,
  statFileProtection,
  stateDir,
} from './config.js';
export type {
  AtomicWriteOptions,
  AtomicWriteResult,
  FileProtection,
  LoadEnvFileOptions,
  LoadEnvFileResult,
  PathOptions,
  ProtectionClaim,
} from './config.js';

export {
  DEFAULT_ADS_API_VERSION,
  DEFAULT_API_VERSION,
  DEFAULT_HOST_CONCURRENCY,
  DEFAULT_HTTP_PORT,
  DEFAULT_LOG_LEVEL,
  DEFAULT_MAX_RESULT_CHARS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_TRANSPORT,
  DEFAULT_WRITE_MODE,
  GRAPH_HOSTS,
  HTTP_LOOPBACK_HOST,
  MIN_CONFIRM_TOKEN_CHARS,
  StartupConfigError,
  assertStartupOk,
  formatStartupReport,
  loadSettings,
} from './settings.js';
export type {
  LoadSettingsOptions,
  LoadSettingsResult,
  StartupProblem,
  StartupReport,
  StartupSeverity,
} from './settings.js';

// v2 messaging F10 — operator-curated local reply templates.
export {
  MAX_SAVED_REPLIES,
  MAX_SAVED_REPLY_CHARS,
  MAX_SAVED_REPLY_TAGS,
  MAX_SAVED_REPLY_TITLE_CHARS,
  SAVED_REPLIES_VERSION,
  SAVED_REPLY_ID_RE,
  SAVED_REPLY_PLACEHOLDERS,
  SAVED_REPLY_TAG_RE,
  SavedRepliesError,
  createSavedReplyStore,
  fillSavedReply,
  loadSavedReplies,
  parseSavedReplies,
  slugifyTitle,
  unknownPlaceholders,
  writeSavedReplies,
} from './saved-replies.js';
export type {
  SavedRepliesData,
  SavedRepliesErrorCode,
  SavedReplyStoreDeps,
} from './saved-replies.js';

// F05 — stderr JSON logging + value-based redaction choke-point (C3).
export { createRedactor } from './redact.js';

export { createLogger } from './log.js';
export type { LoggerConfig } from './log.js';

// F06 — error→action matrix (C2/C9).
export {
  DEFAULT_THROTTLE_RETRY_AFTER_MS,
  ERROR_MATRIX,
  ETA_MINUTES_TO_MS,
} from './error-matrix.js';
export type { ErrorMatrixRow } from './error-matrix.js';

export {
  DEFAULT_HINT_LAUNCH_COMMAND,
  DEFAULT_VERIFY_TOOL,
  NON_JSON_BODY_MAX,
  NO_ERROR_MESSAGE,
  PROXY_ENV_HINT,
  ambiguousWriteAction,
  classifyGraphError,
  classifyNetworkError,
  cursorExpiredAction,
  errorMessageOf,
  isCursorRejection,
  matchErrorRow,
  nonJsonBodyAction,
  setHintLaunchCommand,
  toGraphApiError,
} from './errors.js';
export type { GraphErrorEnvelope, NetworkPhase } from './errors.js';

// F07 — fbRequest JSON/query protocol (Bearer + appsecret_proof, retry matrix).
export {
  apiVersionFor,
  bestEffortCategory,
  bodyIsGraphErrorEnvelope,
  businessUseCaseEtaMs,
  classifyHttpError,
  computeAppSecretProof,
  containPathname,
  createFbRequest,
  createHostSemaphores,
  describeFault,
  extractResponseHeaders,
  graphErrorFromResponse,
  isProvablyNotSent,
  isThrottleCode,
  parseRetryAfterMs,
  parseUsageHeaders,
  resolveHostBase,
  retryVerdict,
  usageOfGraphError,
} from './http.js';
export type {
  FailureKind,
  FbRequestDeps,
  HostSemaphores,
  HttpFailureKind,
  RetryConfig,
  RetryVerdict,
} from './http.js';

// F08 — fbRequest upload protocols (multipart FormData + rupload offset-resume).
export {
  createUploadHandler,
  parseFileOffset,
  planRuploadChunks,
} from './http-upload.js';
export type { RuploadChunkPlan, UploadHandlerDeps } from './http-upload.js';

// API-version drift signals (X-Ad-Api-Version-Warning, served-version mismatch).
export {
  VERSION_DRIFT_LOG_MSG,
  VERSION_HEADERS,
  createVersionDriftMonitor,
  describeVersionDrift,
  detectVersionDrift,
  pathApiVersion,
} from './version-drift.js';
export type {
  VersionDriftKind,
  VersionDriftMonitor,
  VersionDriftSignal,
} from './version-drift.js';

// F09 — auth (debug_token, per-page token resolver) + pages registry (C1/C14).
export {
  ERROR_CODE_INVALID_PARAM,
  ERROR_CODE_PAGE_MIGRATED,
  ERROR_CODE_SESSION,
  ERROR_CODE_TOKEN_INVALID,
  STALE_OBJECT_SUBCODES,
  createPageTokenResolver,
  debugToken,
  isPageTokenDead,
} from './auth.js';
export type {
  DebugTokenDeps,
  DebugTokenInfo,
  GranularScope,
  PageTokenResolver,
  PageTokenResolverDeps,
  TokenExpiry,
  TokenType,
} from './auth.js';

export { createPagesRegistry } from './pages-registry.js';
export type { PagesRegistryDeps } from './pages-registry.js';
