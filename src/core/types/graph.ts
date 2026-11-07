// Graph-facing contract (X08 split of `core/types.ts`): the error envelope,
// the three wire protocols, Page resolution and pagination.

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
  | 'permission' // 200/10 — missing scope or Page role
  | 'rate_limit' // throttle families 4/17/32/613 + 80000–80099
  | 'transient' // 5xx / network fault — retryable on GET only
  | 'duplicate' // 506 — duplicate post; never retried
  | 'not_found' // 100/803 (object gone, already deleted, or id/alias unresolvable)
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
  /** Graph's `error_user_title`: the human-readable headline of a refusal, when sent. */
  readonly userTitle?: string;
  /** Graph's `error_user_msg`: the human-readable reason for a refusal, when sent. */
  readonly userMessage?: string;
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
  /**
   * Graph's `error_user_title` / `error_user_msg`, when the envelope carried
   * them. On an ads or publishing refusal `message` is usually the generic
   * "Invalid parameter" and these two are the only human-readable reason; they
   * ride as their own fields so `message` stays the greppable Graph line.
   */
  readonly userTitle?: string;
  readonly userMessage?: string;

  constructor(message: string, init: GraphApiErrorInit) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'GraphApiError';
    this.code = init.code;
    this.subcode = init.subcode;
    this.type = init.type;
    this.fbtraceId = init.fbtraceId;
    this.httpStatus = init.httpStatus;
    this.action = init.action;
    this.userTitle = init.userTitle;
    this.userMessage = init.userMessage;
    // Restore the prototype chain so `instanceof GraphApiError` holds after
    // transpilation to a target that breaks native subclassing.
    Object.setPrototypeOf(this, GraphApiError.prototype);
  }
}

// ---------------------------------------------------------------------------
// 4. FbRequest / FbRequestFn — the three wire protocols (C7)
// ---------------------------------------------------------------------------

/** Symbolic host key resolved against `HostAllowlist` (`./settings.ts`). */
export type GraphHost = 'graph' | 'graph-video' | 'rupload';

export type HttpMethod = 'GET' | 'POST' | 'DELETE';

/**
 * Which versioned Meta API a request speaks. Both live on the same hosts, but
 * the Marketing API (ad accounts, campaigns, ad sets, ads, ads insights and
 * report runs) has its own, much shorter version lifecycle than the Graph API,
 * so it carries its own pin: `graph` resolves to `Settings.apiVersion`,
 * `marketing` to `Settings.adsApiVersion`.
 */
export type ApiFamily = 'graph' | 'marketing';

/** Query/body param scalar accepted by JSON requests. */
export type ParamValue = string | number | boolean | undefined;

/** Fields common to all three protocols. */
export interface FbRequestBase {
  /** Target host key; the client resolves it against the fixed allowlist. */
  readonly host: GraphHost;
  /** Edge path, e.g. `/{page-id}/feed` or `/{version}/act_{id}/campaigns`. */
  readonly path: string;
  /**
   * Versioned API the edge belongs to; selects the version the client prepends
   * to `path`. Absent ⇒ `graph`. Every ads (Marketing API) request sets
   * `marketing`.
   */
  readonly api?: ApiFamily;
  /** Per-request timeout override in ms (falls back to `Settings.requestTimeoutMs`). */
  readonly timeoutMs?: number;
  /** Abort seam for shutdown / MCP cancellation. */
  readonly signal?: AbortSignal;
  /** Explicit token override; otherwise resolved from `pageId` / settings. */
  readonly token?: string;
  /** Page whose token should be resolved (per-page token resolver — C1). */
  readonly pageId?: string;
  /**
   * The read tool that can show whether this write landed, named on the C2
   * ambiguous-outcome guidance (`nextTool`) when the response is lost. Only the
   * api layer knows what a path like `/{id}` points at; absent, the transport
   * names a tool only when the request itself proves one (a feed post).
   */
  readonly verifyTool?: string;
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
  /**
   * Full rupload path, `/{api-name}/{version}/{id}` — the version is the SECOND
   * segment here, unlike a Graph edge path. The caller owns it end to end (core
   * validates but never injects a version), so pass Meta's `upload_url` pathname
   * verbatim when it gives one.
   */
  readonly path: string;
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
// 6. Page resolution (C1 / C14) — no AsyncLocalStorage anywhere
// ---------------------------------------------------------------------------

/**
 * The value of the auto-injected optional `profile` tool argument: a profile
 * key (e.g. "brand-a") OR a raw Page ID. Resolved by {@link PageResolver}; never
 * an ambient context (C14).
 */
export type PageRef = string;

/**
 * The synthetic profile key of the default Page (`FB_PAGE_ID`) when referenced
 * explicitly. Lives here because it is shared contract, not registry detail: the
 * settings loader must RESERVE it (a `FB_PROFILE_DEFAULT_PAGE_ID` would otherwise
 * define a second, silently-shadowed profile under the same key) and the registry
 * must MINT it. One literal, so the two can never drift apart.
 */
export const DEFAULT_PROFILE_KEY = 'default';

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
