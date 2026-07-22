// Public contract surface for facebook-mcp (task F02).
//
// This file is the single source of truth for the shared TypeScript contracts
// that every downstream task (F04–F16, V01–V10) builds against. After Wave 1
// merges these shapes are FROZEN — changes go through the integration owner.
//
// Only shapes live here: interfaces, type aliases, a handful of contract
// constants, and the one concrete class that a contract requires to exist
// (`GraphApiError`, since an Error subclass cannot be an interface). All real
// implementations arrive in later tasks (the file names they own are noted at
// each section). `core` is layer 0 — this file imports nothing from api/, mcp/
// or tools/, and depends only on external packages (zod types, node built-ins).

import type { ZodTypeAny } from 'zod';

// ---------------------------------------------------------------------------
// 1. Clock (injectable time seam — QA #6 / G3)
// ---------------------------------------------------------------------------

/**
 * Injectable time seam. Every retry/backoff/expiry decision reads time through
 * this interface so tests can drive time deterministically (see `fakeClock`).
 * `sleep` honors an `AbortSignal` so in-flight waits abort on shutdown /
 * cancellation (CC-MCP-5).
 */
export interface Clock {
  /** Current wall-clock time in epoch milliseconds. */
  now(): number;
  /** Resolve after `ms` milliseconds, or reject with an AbortError if `signal` aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

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
  readonly apiVersion: string;
  readonly hosts: HostAllowlist;
  /** Default per-request timeout in ms. */
  readonly requestTimeoutMs: number;
  /** Per-host concurrency semaphore size (default 4). */
  readonly hostConcurrency: number;

  // Write gating & media
  readonly writeMode: WriteMode;
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
  readonly logLevel: LogLevel;

  // Ads (opt-in, 1.1)
  readonly adAccountId?: string;
  /** `FB_ADS_BUDGET_CEILING` in minor currency units; refuses raises above this (CC-ADS-7). */
  readonly adsBudgetCeiling?: number;

  // Out-of-band confirmation fallback (B1)
  /** Operator confirmation token for the OOB gate when elicitation is unavailable (CC-MCP-6). */
  readonly confirmToken?: string;
}

// ---------------------------------------------------------------------------
// 3. Errors — GraphApiError + error→action classification (F06 fills the table)
// ---------------------------------------------------------------------------

/**
 * Coarse category a Graph error maps to. F06 owns the `{code, subcode}` → action
 * matrix (`core/errors.ts`); this union is the shape it classifies into and is
 * consumed by tools for actionable messaging. NOTE (freeze review): if F06 needs
 * a category not listed here, that is a contract change — flag it at integration.
 */
export type ErrorCategory =
  | 'auth' // 190 + 460/463/467/102 — token dead/invalid; refresh credential
  | 'permission' // 200/10/803 — missing scope or Page role
  | 'rate_limit' // throttle families 4/17/32/613 + 80000–80099
  | 'transient' // 5xx / network fault — retryable on GET only
  | 'duplicate' // 506 — duplicate post; never retried
  | 'not_found' // 100 (object gone / already deleted)
  | 'validation' // client/param error; not retryable
  | 'ambiguous' // C2 — request may have landed; NEVER retry, verify instead
  | 'cursor_expired' // pagination cursor expiry (CC-PAGE-2)
  | 'account' // ads account disabled / payment failure (CC-ADS-6)
  | 'unsupported' // retired/unknown API version or edge
  | 'unknown';

/**
 * The result F06's error→action matrix produces for a given `{code, subcode}`.
 * The four core fields are the frozen contract; `retryAfterMs` is an optional
 * surfaced ETA (from `estimated_time_to_regain_access`) that the model may show
 * but the server never sleeps on beyond the 60s internal cap (CC-NET-3).
 */
export interface ErrorAction {
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  /** Suggested next tool for the model, e.g. `facebook_whoami` or `facebook_list_posts`. */
  readonly nextTool?: string;
  /** Human-actionable guidance ("permission X missing — run facebook_whoami"). */
  readonly operatorText: string;
  /** Surfaced retry-after estimate in ms; never a sleep instruction. */
  readonly retryAfterMs?: number;
}

/** Constructor inputs for {@link GraphApiError}. */
export interface GraphApiErrorInit {
  readonly code: number;
  readonly subcode?: number;
  readonly type?: string;
  readonly fbtraceId?: string;
  readonly httpStatus: number;
  /** Classification attached by the F06 matrix once known. */
  readonly action?: ErrorAction;
  readonly cause?: unknown;
}

/**
 * Error subclass carrying the Graph error envelope
 * (`{error: {message, type, code, error_subcode, fbtrace_id}}`) plus the HTTP
 * status and the machine-readable {@link ErrorAction} used for retry/next-tool
 * classification. Concrete because an Error subclass cannot be an interface; the
 * F06 matrix (`core/errors.ts`) constructs these and populates `action`.
 */
export class GraphApiError extends Error {
  readonly code: number;
  readonly subcode?: number;
  readonly type?: string;
  readonly fbtraceId?: string;
  readonly httpStatus: number;
  readonly action?: ErrorAction;

  constructor(message: string, init: GraphApiErrorInit) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'GraphApiError';
    this.code = init.code;
    this.subcode = init.subcode;
    this.type = init.type;
    this.fbtraceId = init.fbtraceId;
    this.httpStatus = init.httpStatus;
    this.action = init.action;
    // Restore the prototype chain so `instanceof GraphApiError` holds after
    // transpilation to a target that breaks native subclassing.
    Object.setPrototypeOf(this, GraphApiError.prototype);
  }
}

// ---------------------------------------------------------------------------
// 4. FbRequest / FbRequestFn — the three wire protocols (C7)
// ---------------------------------------------------------------------------

/** Symbolic host key resolved against {@link HostAllowlist}. */
export type GraphHost = 'graph' | 'graph-video' | 'rupload';

export type HttpMethod = 'GET' | 'POST' | 'DELETE';

/** Query/body param scalar accepted by JSON requests. */
export type ParamValue = string | number | boolean | undefined;

/** Fields common to all three protocols. */
export interface FbRequestBase {
  /** Target host key; the client resolves it against the fixed allowlist. */
  readonly host: GraphHost;
  /** Edge path, e.g. `/{page-id}/feed` or `/{version}/act_{id}/campaigns`. */
  readonly path: string;
  /** Per-request timeout override in ms (falls back to `Settings.requestTimeoutMs`). */
  readonly timeoutMs?: number;
  /** Abort seam for shutdown / MCP cancellation. */
  readonly signal?: AbortSignal;
  /** Explicit token override; otherwise resolved from `pageId` / settings. */
  readonly token?: string;
  /** Page whose token should be resolved (per-page token resolver — C1). */
  readonly pageId?: string;
}

/** JSON / query-string protocol: GETs and simple writes. */
export interface JsonRequest extends FbRequestBase {
  readonly protocol: 'json';
  readonly method: HttpMethod;
  /** Query-string params (GET, or POST params Graph reads from the query). */
  readonly params?: Readonly<Record<string, ParamValue>>;
  /** Form/JSON body for writes. */
  readonly body?: Readonly<Record<string, unknown>>;
}

/** A single binary part of a multipart upload. */
export interface MultipartPart {
  readonly name: string;
  readonly data: Uint8Array;
  readonly filename?: string;
  readonly contentType?: string;
}

/** multipart/form-data protocol: direct binary uploads (photos, small video). */
export interface MultipartRequest extends FbRequestBase {
  readonly protocol: 'multipart';
  readonly method: 'POST';
  /** Non-file form fields. */
  readonly fields?: Readonly<Record<string, string>>;
  /** File parts. */
  readonly files: readonly MultipartPart[];
}

/**
 * Raw-binary rupload protocol: chunked resumable uploads. Auth is header-based
 * (`Authorization: OAuth <token>` + `file_offset`); chunk POSTs bypass the
 * generic retry matrix and resume by re-reading the server offset (CC-MEDIA-2).
 */
export interface RuploadRequest extends FbRequestBase {
  readonly protocol: 'rupload';
  readonly method: 'POST';
  /** `file_offset` header value — byte offset this chunk begins at. */
  readonly fileOffset: number;
  /** Raw binary chunk body. */
  readonly chunk: Uint8Array;
  /** Extra rupload headers (e.g. `file_size`, `Content-Type`). */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Discriminated union over the three wire protocols; discriminant is `protocol`. */
export type FbRequest = JsonRequest | MultipartRequest | RuploadRequest;

/**
 * Response header bag, keys LOWERCASED. Kept as a plain record (rather than
 * named accessors) so parsing stays defensive: any header may be absent or
 * malformed (CC-NET-2). Read the usage headers via {@link USAGE_HEADERS}.
 */
export type FbResponseHeaders = Readonly<Record<string, string>>;

/**
 * Response ENVELOPE. Design choice (required justification): `fbRequest` returns
 * `{ data, headers, status }` rather than the bare `data`, because downstream
 * needs response headers on every call — `X-App-Usage` /
 * `X-Business-Use-Case-Usage` drive the usage tool and proactive soft-backoff
 * (C7 / architecture §2), and the status/headers back error mapping. The parsed
 * `data` is the caller's typed payload; the shaper (F12) strips paging/tokens
 * from it before anything leaves the process (C3).
 */
export interface FbResponse<T = unknown> {
  readonly data: T;
  readonly headers: FbResponseHeaders;
  readonly status: number;
}

/** The single HTTP entry point covering all three protocols (F07/F08 implement). */
export type FbRequestFn = <T = unknown>(req: FbRequest) => Promise<FbResponse<T>>;

/** Canonical (lowercased) usage-header names parsed defensively on every response. */
export const USAGE_HEADERS = {
  appUsage: 'x-app-usage',
  businessUseCaseUsage: 'x-business-use-case-usage',
  adsInsightsThrottle: 'x-fb-ads-insights-throttle',
} as const;

/** Parsed rate-limit usage snapshot exposed via `facebook_usage` (F07/F16 populate). */
export interface UsageSnapshot {
  /** Highest percentage seen across X-App-Usage buckets, if parseable. */
  readonly appUsagePct?: number;
  /** Highest percentage across X-Business-Use-Case-Usage buckets, if parseable. */
  readonly businessUseCasePct?: number;
  /** Ads-insights throttle percentage, if present. */
  readonly adsInsightsThrottlePct?: number;
  /** Raw header bag the snapshot was derived from (honest "no data" when empty). */
  readonly raw: FbResponseHeaders;
  /** When the snapshot was taken (epoch ms). */
  readonly seenAt: number;
}

// ---------------------------------------------------------------------------
// 5. Redactor — value-based secret scrubbing choke-point (C3, F05 implements)
// ---------------------------------------------------------------------------

/** Construction config for a {@link Redactor}. */
export interface RedactorConfig {
  /** Known secret VALUES registered at construction (tokens, app secret, proof, http token). */
  readonly secrets?: readonly string[];
  /** Replacement placeholder (default implementation uses `[REDACTED]`). */
  readonly placeholder?: string;
}

/**
 * Value-based redaction choke-point. Primary strategy scrubs registered secret
 * VALUES wherever they appear (logs, errors, results, journal); the real F05
 * implementation adds a defensive pattern scan (EAA tokens, 32-hex app secret,
 * `{app-id}|{app-secret}`) as backup only.
 */
export interface Redactor {
  /** Deep-redact any value, returning a scrubbed clone (strings, arrays, objects). */
  redact(value: unknown): unknown;
  /** Redact a single string. */
  redactString(s: string): string;
  /**
   * Register a secret value discovered at runtime — e.g. a per-Page token derived
   * after startup (C1) must be scrubbable the moment it exists.
   */
  addSecret(value: string): void;
}

// ---------------------------------------------------------------------------
// 6. Page resolution (C1 / C14) — no AsyncLocalStorage anywhere
// ---------------------------------------------------------------------------

/**
 * The value of the auto-injected optional `profile` tool argument: a profile
 * key (e.g. "brand-a") OR a raw Page ID. Resolved by {@link PageResolver}; never
 * an ambient context (C14).
 */
export type PageRef = string;

/** A fully resolved Page: its ID, display name, and the token to act as it. */
export interface ResolvedPage {
  readonly pageId: string;
  readonly name: string;
  readonly token: string;
}

/**
 * Resolves a `profile` argument to a concrete Page + token and owns the per-page
 * token cache. `invalidate` is the error-190 hook (C1): on token death the cache
 * entry is dropped so the next `resolvePage` re-derives once. Ambiguous profile
 * names are refused rather than guessed (CC-AUTH-6) — the implementation throws.
 */
export interface PageResolver {
  /** Resolve a profile key / Page ID (or the default when omitted). */
  resolvePage(profile?: PageRef): Promise<ResolvedPage>;
  /** Drop the cached token for a Page ID after error 190 (invalidate-on-190). */
  invalidate(pageId: string): void;
}

// ---------------------------------------------------------------------------
// 7. Pagination (F10 implements — api/shared.ts)
// ---------------------------------------------------------------------------

/** Opaque forward cursor (Graph's `after`); never persisted, never token-bearing. */
export type Cursor = string;

/** Request params for a single edge page. */
export interface PageRequest {
  /** Page size; defaults small to protect the result budget (CC-PAGE-5). */
  readonly limit?: number;
  /** Forward cursor from a previous page's {@link Page.nextCursor}. */
  readonly after?: Cursor;
}

/**
 * One shaped page of edge results. `truncated` signals the caller stopped early
 * (budget hit or cursor expiry); `note` carries model-facing guidance such as
 * "cursor expired — restart listing" (CC-PAGE-2).
 */
export interface Page<T> {
  readonly data: readonly T[];
  readonly nextCursor?: Cursor;
  readonly truncated: boolean;
  readonly note?: string;
}

/** Hard budget for `fetchAll`; stops at whichever cap is hit first (CC-PAGE-5). */
export interface FetchAllBudget {
  /** Max total items to accumulate. */
  readonly maxItems?: number;
  /** Max edge pages to walk (guards empty-page-with-next loops — CC-PAGE-1). */
  readonly maxPages?: number;
}

// ---------------------------------------------------------------------------
// 8. Tools-as-data — ToolSpec / PackageSpec (C5, F11 implements define/registry)
// ---------------------------------------------------------------------------

/**
 * The full MCP annotation quadruple, all four hints REQUIRED and explicit. The
 * spec defaults `destructiveHint:true` / `idempotentHint:false` when an
 * annotations object is present, so a partial object silently misreports intent
 * (doc 06) — this interface makes omission a type error. `openWorldHint` is
 * `true` for every tool here (all touch a live external system).
 */
export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

/** A single text content block returned to the client (v1 emits text only). */
export interface ToolTextContent {
  readonly type: 'text';
  readonly text: string;
}

export type ToolContent = ToolTextContent;

/** What a tool handler returns — a lean projection of MCP's CallToolResult. */
export interface ToolResult {
  readonly content: readonly ToolContent[];
  /** Only for server-owned envelopes (whoami, usage) — CC-MCP-7. */
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

/** Progress update forwarded to the client when a `progressToken` is present (CC-MCP-1). */
export interface ProgressUpdate {
  readonly progress: number;
  readonly total?: number;
  readonly message?: string;
}

export type ProgressReporter = (update: ProgressUpdate) => void;

/**
 * The injectable seam bundle passed to every tool handler. This is the ambient
 * capability set a handler is allowed to touch — no globals, no ALS (C14).
 *
 * FREEZE NOTE: this is the shape most likely to gain fields at I1 (write-mode /
 * plan-apply helpers, taint wrapper, confirmer). Downstream should treat added
 * fields as additive-only.
 */
export interface ToolContext {
  readonly settings: Settings;
  readonly fbRequest: FbRequestFn;
  readonly pages: PageResolver;
  readonly logger: Logger;
  readonly redactor: Redactor;
  readonly clock: Clock;
  readonly journal: Journal;
  /** Abort seam for this call (shutdown / cancellation). */
  readonly signal?: AbortSignal;
  /** Progress reporter, present only when the client supplied a progressToken. */
  readonly reportProgress?: ProgressReporter;
  /** The resolved `profile` argument for this call, when the tool is page-scoped. */
  readonly profile?: PageRef;
}

/**
 * A tool handler receives the RAW input (validation/typing happens inside F11's
 * generic `defineTool`, which parses `inputSchema` before calling this) plus the
 * capability context, and returns a {@link ToolResult}.
 */
export type ToolHandler = (input: unknown, ctx: ToolContext) => Promise<ToolResult>;

/**
 * Tools-as-data (C5). Deliberately NON-generic so heterogeneous specs live in a
 * single `ToolSpec[]` without variance gymnastics; the generic, type-safe
 * authoring wrapper (`defineTool`, which infers handler args from the schema)
 * is owned by F11. `inputSchema` is `.strict()` and every field `.describe()`d
 * at registration; `outputSchema` is present only for server-owned envelopes.
 */
export interface ToolSpec {
  /** `facebook_<verb>_<noun>`. */
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  /** Owning package name; the registry may set this from the PackageSpec. */
  readonly package?: string;
  readonly inputSchema: ZodTypeAny;
  readonly outputSchema?: ZodTypeAny;
  readonly annotations: ToolAnnotations;
  /** Write blast-radius tier; absent ⇒ a read-only tool. */
  readonly writeTier?: WriteTier;
  /** Whitelisted field names safe to log for this tool (redaction-audited). */
  readonly logFields?: readonly string[];
  readonly handler: ToolHandler;
}

/** A package groups tools and carries selection + write-mode defaults (C5). */
export interface PackageSpec {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly tools: readonly ToolSpec[];
  /** Whether the package is part of the default profile expansion (F11 authoritative). */
  readonly enabledByDefault: boolean;
  /** Per-package write-mode default to avoid confirmation stacking (C4). */
  readonly writeModeDefault?: WriteMode;
}

/**
 * The seven canonical package names. This is a convenience contract constant;
 * F11 (`mcp/packages.ts`) owns the authoritative PACKAGES manifest and the
 * snapshot-tested DEFAULT PROFILE EXPANSION. The default expansion set is
 * intentionally NOT defined here (single source of truth stays with F11's
 * snapshot test): default `FB_TOOL_PACKAGES` ⇒
 * core + posts + reader + insights + moderation + messages (ads excluded).
 */
export const PACKAGE_NAMES = [
  'core',
  'reader',
  'posts',
  'insights',
  'moderation',
  'messages',
  'ads',
] as const;

export type PackageName = (typeof PACKAGE_NAMES)[number];

// ---------------------------------------------------------------------------
// 9. Write gating — tiered plan-and-apply (C4, F13 implements)
// ---------------------------------------------------------------------------

/**
 * Blast-radius tier. `irreversible` (delete) and `spend` (ads) are NEVER covered
 * by the `FB_WRITE_MODE=apply` env bypass — they always require a per-call
 * `apply:true` (and the highest-consequence tools bind it to a `plan_id`).
 */
export type WriteTier = 'safe' | 'reversible' | 'irreversible' | 'spend';

/**
 * Effective write mode. `plan` returns a validating dry-run preview with zero
 * network mutations; `apply` performs the mutation (subject to per-tier gating).
 */
export type WriteMode = 'plan' | 'apply';

/** Short-lived opaque id binding an `apply` call to a specific preview (C4). */
export type PlanId = string;

/**
 * The stored plan record produced by a plan-mode call and consumed by the bound
 * apply call. Internal to the write-mode layer; the model sees {@link PlanPreview}.
 */
export interface Plan {
  readonly planId: PlanId;
  readonly tool: string;
  readonly tier: WriteTier;
  readonly pageId?: string;
  /** The validated params the apply is bound to. */
  readonly params: Readonly<Record<string, unknown>>;
  /** Captured before-state for update/delete divergence checks. */
  readonly beforeState?: unknown;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** Model-facing preview returned by a plan-mode (dry-run) write call. */
export interface PlanPreview {
  readonly planId: PlanId;
  readonly tool: string;
  readonly tier: WriteTier;
  /** Human summary of the intended action. */
  readonly summary: string;
  readonly warnings: readonly string[];
  /** Explicit anti-hallucination line, e.g. "The post was NOT published." (C4/UX). */
  readonly notPerformedNotice: string;
  readonly resolvedPage?: ResolvedPage;
  readonly beforeState?: unknown;
  readonly expiresAt: number;
}

/** One field-level divergence detected at apply time (C4 divergence semantics). */
export interface DivergenceDiff {
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

/**
 * Outcome envelope of an apply call. If `diverged` is present the state changed
 * since the preview and the mutation was NOT performed (fail-with-diff, C4).
 */
export interface ApplyResult<T = unknown> {
  readonly applied: boolean;
  readonly result?: T;
  readonly diverged?: readonly DivergenceDiff[];
  readonly journalStatus?: JournalStatus;
}

// ---------------------------------------------------------------------------
// 10. Journal — redaction-aware, rotation-aware write log (F13 implements)
// ---------------------------------------------------------------------------

export type JournalStatus = 'ok' | 'failed';

/**
 * `attempted` = the request reached the wire but the outcome is ambiguous
 * (C2 / CC-LIFE-2); recorded so an operator can reconcile.
 */
export type JournalOutcome = 'applied' | 'attempted' | 'failed';

/** Caller-supplied journal fields; the journal stamps `timestamp` itself. */
export interface JournalEntryInput {
  readonly tool: string;
  readonly tier: WriteTier;
  readonly pageId?: string;
  readonly planId?: PlanId;
  readonly outcome: JournalOutcome;
  readonly summary: string;
  /** Structured metadata ONLY — passed through the redactor (no tokens/PII). */
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

export interface JournalEntry extends JournalEntryInput {
  /** Epoch ms, stamped by the journal on append. */
  readonly timestamp: number;
}

/**
 * Append-only write journal. `append` is non-blocking and NEVER throws — a
 * journal failure returns `'failed'` so it cannot block the real write
 * (CC-LIFE-1). Implementations redact metadata and rotate at ~5 MB (0600).
 */
export interface Journal {
  append(entry: JournalEntryInput): Promise<JournalStatus>;
}

// ---------------------------------------------------------------------------
// 11. Logger — stderr JSON logger (F05 implements)
// ---------------------------------------------------------------------------

export type LogFields = Readonly<Record<string, unknown>>;

/**
 * Structured stderr logger. stdout is the stdio JSON-RPC channel, so all log
 * output goes to stderr as JSON. `fields` are redacted at the choke-point before
 * emission (C3).
 */
export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

// ---------------------------------------------------------------------------
// 12. Taint (B1) — tainted UGC envelope + out-of-band confirmation seam
// ---------------------------------------------------------------------------

/** Origin of untrusted user-generated content. */
export type TaintSource =
  'comment' | 'message' | 'visitor_post' | 'user_profile' | 'unknown';

/**
 * Envelope wrapping attacker-controllable UGC (comments, DMs, visitor posts) so
 * it is clearly delimited and carries an injection warning before it enters the
 * model session (B1 / CC-MOD-8). The `__tainted` brand makes accidental
 * unwrapping detectable. F15 (`mcp/taint.ts`) implements the wrapper.
 */
export interface TaintedContent<T = string> {
  readonly __tainted: true;
  readonly source: TaintSource;
  /** The untrusted content itself. */
  readonly content: T;
  /** Injection warning shown alongside the content. */
  readonly warning: string;
}

/** Request for out-of-band confirmation of a destructive/spend action (B1). */
export interface ConfirmationRequest {
  readonly tool: string;
  readonly tier: WriteTier;
  readonly planId?: PlanId;
  readonly summary: string;
  /** Why confirmation is required (e.g. "irreversible delete"). */
  readonly reason: string;
}

/** How the confirmation was obtained; the gate never silently downgrades (CC-MCP-6). */
export type ConfirmationMethod = 'elicitation' | 'operator_token' | 'denied';

export interface ConfirmationResponse {
  readonly confirmed: boolean;
  readonly method: ConfirmationMethod;
  readonly note?: string;
}

/**
 * Out-of-band confirmation seam: MCP elicitation where supported, operator-token
 * fallback otherwise, never bypassable by `FB_WRITE_MODE` (B1). F15
 * (`mcp/confirm.ts`) implements it.
 */
export interface Confirmer {
  confirm(request: ConfirmationRequest): Promise<ConfirmationResponse>;
}
