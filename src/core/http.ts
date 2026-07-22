// HTTP client — the JSON / query-string protocol of `fbRequest` (task F07).
//
// `createFbRequest` returns the frozen `FbRequestFn` seam. This file implements
// only the `protocol: 'json'` branch of the `FbRequest` union (GETs and simple
// query/form writes); the multipart and raw-binary rupload protocols are built
// on top of the seams exported here by `core/http-upload.ts` (task F08), which
// this factory delegates to through the optional `uploadHandler` dep.
//
// Design invariants enforced here (see docs/analysis/05-architecture.md §2,
// docs/reviews/SUMMARY.md C2/C3, docs/analysis/09-corner-cases.md CC-NET-1..7):
//   * Auth via `Authorization: Bearer <token>` — the token is NEVER placed in the
//     query string, because Graph echoes query params into `paging.next` URLs, a
//     token-leak vector (C3). `appsecret_proof` (an HMAC, not the token) is added
//     as a param: query for GET/DELETE, body for POST.
//   * Fixed host allowlist (graph / graph-video / rupload); any other host, an
//     absolute-URL path, or a redirect to another host is rejected (CC-NET-7).
//   * Throttle arrives as HTTP 400 with a BODY code (4/17/32/613 or 80000–80099),
//     not HTTP 429 — the retry matrix keys on the body code (CC-NET-1).
//   * 5xx / transient network faults retry on GET only; writes whose body may
//     have reached the wire are NEVER auto-retried on a lost response — they
//     surface an `ambiguous` GraphApiError ("verify first") (C2 / CC-NET-5).
//   * Usage headers (`X-App-Usage`, `X-Business-Use-Case-Usage`,
//     `x-fb-ads-insights-throttle`) are parsed defensively on every response
//     (CC-NET-2); the raw headers are always on the response envelope and an
//     optional `onUsage` sink receives the parsed snapshot.
//   * Backoff honors `estimated_time_to_regain_access` but never sleeps beyond a
//     60s cap (CC-NET-3), and every wait goes through the injected `Clock.sleep`
//     so tests drive it deterministically with `createFakeClock`.
//   * Per-host concurrency semaphore (default 4).

import { createHmac } from 'node:crypto';

import { GraphApiError, USAGE_HEADERS } from './types.js';
import type {
  Clock,
  ErrorAction,
  ErrorCategory,
  FbRequest,
  FbRequestFn,
  FbResponse,
  FbResponseHeaders,
  GraphHost,
  HostAllowlist,
  JsonRequest,
  Logger,
  Redactor,
  Settings,
  UsageSnapshot,
} from './types.js';

// ---------------------------------------------------------------------------
// Public factory surface
// ---------------------------------------------------------------------------

/** Tunable retry-loop parameters; all default to the constants below. */
export interface RetryConfig {
  /** Max retries AFTER the first attempt (default 4 ⇒ up to 5 attempts). */
  readonly maxRetries: number;
  /** Base backoff delay in ms for exponential growth (default 500). */
  readonly baseDelayMs: number;
  /** Hard cap on any single backoff wait in ms (default 60_000, CC-NET-3). */
  readonly maxDelayMs: number;
}

/** Injected dependencies for {@link createFbRequest}. */
export interface FbRequestDeps {
  readonly settings: Settings;
  readonly clock: Clock;
  readonly redactor: Redactor;
  readonly logger: Logger;
  /**
   * Shared per-host semaphore set. Pass the same instance to F08's upload client
   * so both protocols honor one concurrency budget per host. Defaults to a fresh
   * set sized by `settings.hostConcurrency`.
   */
  readonly semaphores?: HostSemaphores;
  /**
   * Handler for the `multipart` / `rupload` protocols (F08's `http-upload.ts`).
   * When absent, a non-JSON request rejects with a clear error.
   */
  readonly uploadHandler?: FbRequestFn;
  /** Sink fed the parsed usage snapshot on every response (proactive backoff). */
  readonly onUsage?: (snapshot: UsageSnapshot) => void;
  /** Deterministic RNG seam for backoff jitter (default `Math.random`). */
  readonly rng?: () => number;
  /** Retry-loop overrides. */
  readonly retry?: Partial<RetryConfig>;
}

const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 60_000;
const ERROR_BODY_SNIPPET = 200;

// ---------------------------------------------------------------------------
// Host allowlist (CC-NET-7)
// ---------------------------------------------------------------------------

const HOST_KEYS: Readonly<Record<GraphHost, keyof HostAllowlist>> = {
  graph: 'graph',
  'graph-video': 'graphVideo',
  rupload: 'rupload',
};

/**
 * Resolve a symbolic {@link GraphHost} to its allowlisted hostname. Any key
 * outside the fixed allowlist is rejected (there is exactly one vendor — no
 * user-configurable hosts). Exported so F08's upload client shares one policy.
 */
export function resolveHostBase(hosts: HostAllowlist, host: GraphHost): string {
  const key = HOST_KEYS[host];
  // `host` may be cast from an untrusted string upstream; guard defensively.
  if (key === undefined) {
    throw new Error(
      `fbRequest: host '${String(host)}' is not on the allowlist (graph, graph-video, rupload)`,
    );
  }
  const hostname = hosts[key];
  if (typeof hostname !== 'string' || hostname.length === 0) {
    throw new Error(`fbRequest: no hostname configured for host '${host}'`);
  }
  return hostname;
}

/**
 * Build the request URL from a trusted hostname + a relative edge path. Rejects
 * absolute-URL / protocol-relative paths so a crafted `path` can never redirect
 * the request off the allowlisted host (CC-NET-7). The API version is prepended
 * unless the path already carries a `/vNN.N` segment.
 */
function buildUrl(
  hostname: string,
  path: string,
  apiVersion: string,
  query: URLSearchParams,
): string {
  if (path.includes('://') || path.startsWith('//')) {
    throw new Error(
      `fbRequest: path must be a relative edge path, not an absolute URL ('${path}')`,
    );
  }
  let pathname = path.startsWith('/') ? path : `/${path}`;
  if (!/^\/v\d+(?:\.\d+)?(?:\/|$)/.test(pathname)) {
    pathname = `/${apiVersion}${pathname}`;
  }
  const url = new URL(`https://${hostname}`);
  url.pathname = pathname;
  const qs = query.toString();
  if (qs.length > 0) {
    url.search = qs;
  }
  // Belt-and-braces: the resolved host must still be exactly the allowlisted one.
  if (url.hostname !== hostname || url.protocol !== 'https:') {
    throw new Error(`fbRequest: refusing off-allowlist URL for host '${hostname}'`);
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * `appsecret_proof` = HMAC-SHA256 of the access token keyed by the app secret,
 * hex-encoded (the untimestamped variant — no clock-skew failure, CC-AUTH-8).
 * Exported for reuse by F08's upload protocols.
 */
export function computeAppSecretProof(token: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(token).digest('hex');
}

/**
 * Resolve the bearer token for a request. An explicit `req.token` wins; otherwise
 * the settings tokens are tried in precedence order (system > primary > page —
 * CC-AUTH-9). Per-page token resolution happens upstream (F09) and arrives as
 * `req.token`; this is the single-token convenience fallback.
 */
function resolveToken(req: JsonRequest, settings: Settings): string {
  const token =
    req.token ?? settings.systemToken ?? settings.accessToken ?? settings.pageToken;
  if (token === undefined || token.length === 0) {
    throw new Error(
      'fbRequest: no access token available (set req.token or FB_SYSTEM_TOKEN / FB_ACCESS_TOKEN / FB_PAGE_TOKEN)',
    );
  }
  return token;
}

/** Encode a body value the way Graph expects (objects/arrays as JSON strings). */
function encodeBodyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Usage-header parsing (defensive — CC-NET-2)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function strOr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function maxPct(
  rec: Record<string, unknown>,
  fields: readonly string[],
): number | undefined {
  let max: number | undefined;
  for (const field of fields) {
    const n = numOr(rec[field]);
    if (n !== undefined) {
      max = max === undefined ? n : Math.max(max, n);
    }
  }
  return max;
}

const APP_USAGE_FIELDS = ['call_count', 'total_cputime', 'total_time'] as const;
const ADS_THROTTLE_FIELDS = ['app_id_util_pct', 'acc_id_util_pct'] as const;

function parseAppUsage(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const rec = asRecord(parseJson(raw));
  return rec ? maxPct(rec, APP_USAGE_FIELDS) : undefined;
}

function parseBusinessUseCase(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const rec = asRecord(parseJson(raw));
  if (!rec) return undefined;
  let max: number | undefined;
  for (const bucket of Object.values(rec)) {
    if (!Array.isArray(bucket)) continue;
    for (const entry of bucket) {
      const entryRec = asRecord(entry);
      if (!entryRec) continue;
      const pct = maxPct(entryRec, APP_USAGE_FIELDS);
      if (pct !== undefined) {
        max = max === undefined ? pct : Math.max(max, pct);
      }
    }
  }
  return max;
}

function parseAdsThrottle(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const rec = asRecord(parseJson(raw));
  return rec ? maxPct(rec, ADS_THROTTLE_FIELDS) : undefined;
}

/**
 * Parse the three usage headers into a {@link UsageSnapshot}. Every field is
 * best-effort: an absent or malformed header yields `undefined` rather than a
 * throw (CC-NET-2). `raw` carries only the usage headers actually present, so an
 * empty `raw` is an honest "no data". Exported for reuse (F08 / F16).
 */
export function parseUsageHeaders(
  headers: FbResponseHeaders,
  seenAt: number,
): UsageSnapshot {
  const raw: Record<string, string> = {};
  for (const key of Object.values(USAGE_HEADERS)) {
    const value = headers[key];
    if (value !== undefined) {
      raw[key] = value;
    }
  }
  const snapshot: {
    appUsagePct?: number;
    businessUseCasePct?: number;
    adsInsightsThrottlePct?: number;
    raw: FbResponseHeaders;
    seenAt: number;
  } = { raw, seenAt };
  const appUsagePct = parseAppUsage(headers[USAGE_HEADERS.appUsage]);
  if (appUsagePct !== undefined) snapshot.appUsagePct = appUsagePct;
  const businessUseCasePct = parseBusinessUseCase(
    headers[USAGE_HEADERS.businessUseCaseUsage],
  );
  if (businessUseCasePct !== undefined) snapshot.businessUseCasePct = businessUseCasePct;
  const adsInsightsThrottlePct = parseAdsThrottle(
    headers[USAGE_HEADERS.adsInsightsThrottle],
  );
  if (adsInsightsThrottlePct !== undefined)
    snapshot.adsInsightsThrottlePct = adsInsightsThrottlePct;
  return snapshot;
}

/** Lowercased response-header bag (`FbResponseHeaders`). Exported for F08. */
export function extractResponseHeaders(response: Response): FbResponseHeaders {
  const out: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Retry classification (pure — table-tested)
// ---------------------------------------------------------------------------

const THROTTLE_CODES = new Set([4, 17, 32, 613]);

/** Throttle codes: families 4/17/32/613 plus the 80000–80099 range. */
export function isThrottleCode(code: number | undefined): boolean {
  if (code === undefined) return false;
  return THROTTLE_CODES.has(code) || (code >= 80000 && code <= 80099);
}

/** Coarse failure kind of an HTTP error response, keyed on the BODY code. */
export type HttpFailureKind = 'throttle' | 'transient' | 'terminal';

/**
 * Classify a Graph HTTP error response. Throttle is matched on the body code
 * (Meta ships it as HTTP 400, so the status line cannot be trusted — CC-NET-1);
 * 5xx is transient; everything else is a terminal application error.
 */
export function classifyHttpError(
  status: number,
  code: number | undefined,
): HttpFailureKind {
  if (isThrottleCode(code)) return 'throttle';
  if (status >= 500 && status <= 599) return 'transient';
  return 'terminal';
}

/** The full set of failure kinds the retry decision reasons about. */
export type FailureKind = HttpFailureKind | 'network';

/** What the retry loop should do with a failed attempt. */
export type RetryVerdict = 'retry' | 'ambiguous' | 'terminal';

/**
 * The GET-vs-write retry matrix as a pure function (CC-NET-5). Throttle is
 * provably-not-processed so it is always retried; a 5xx or mid-flight network
 * fault on a write is ambiguous (the body may have landed — C2) and never
 * retried; a write network fault that is *provably* connect-phase is safe to
 * retry. Reads retry on any transient/network fault.
 */
export function retryVerdict(
  kind: FailureKind,
  isWrite: boolean,
  provablyNotSent = false,
): RetryVerdict {
  switch (kind) {
    case 'throttle':
      return 'retry';
    case 'transient':
      return isWrite ? 'ambiguous' : 'retry';
    case 'network':
      return !isWrite || provablyNotSent ? 'retry' : 'ambiguous';
    case 'terminal':
      return 'terminal';
  }
}

/** undici/Node error codes that prove the request body never reached the wire. */
const CONNECT_PHASE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function errorCode(err: unknown): string | undefined {
  const rec = asRecord(err);
  const direct = rec ? strOr(rec.code) : undefined;
  if (direct !== undefined) return direct;
  const cause = rec ? asRecord(rec.cause) : undefined;
  return cause ? strOr(cause.code) : undefined;
}

function isProvablyNotSent(err: unknown): boolean {
  const code = errorCode(err);
  return code !== undefined && CONNECT_PHASE_CODES.has(code);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown error';
}

// ---------------------------------------------------------------------------
// Graph error envelope → GraphApiError
// ---------------------------------------------------------------------------

interface ParsedGraphError {
  readonly code?: number;
  readonly subcode?: number;
  readonly message?: string;
  readonly type?: string;
  readonly fbtraceId?: string;
  readonly etaSeconds?: number;
}

/** Parse the `{error: {...}}` envelope defensively; `undefined` if not present. */
function parseGraphErrorEnvelope(bodyText: string): ParsedGraphError | undefined {
  const root = asRecord(parseJson(bodyText));
  const err = root ? asRecord(root.error) : undefined;
  if (!err) return undefined;
  const errorData = asRecord(err.error_data);
  return {
    code: numOr(err.code),
    subcode: numOr(err.error_subcode),
    message: strOr(err.message),
    type: strOr(err.type),
    fbtraceId: strOr(err.fbtrace_id),
    etaSeconds:
      numOr(err.estimated_time_to_regain_access) ??
      (errorData ? numOr(errorData.estimated_time_to_regain_access) : undefined),
  };
}

/** Best-effort coarse category; F06's matrix is the definitive one downstream. */
export function bestEffortCategory(
  status: number,
  code: number | undefined,
): ErrorCategory {
  if (isThrottleCode(code)) return 'rate_limit';
  if (code === 190) return 'auth';
  if (code === 200 || code === 10 || code === 803) return 'permission';
  if (code === 506) return 'duplicate';
  if (code === 100) return 'not_found';
  if (status >= 500 && status <= 599) return 'transient';
  if (code !== undefined) return 'validation';
  return 'unknown';
}

function operatorTextFor(category: ErrorCategory): string {
  switch (category) {
    case 'auth':
      return 'access token invalid or expired — refresh the credential and retry';
    case 'permission':
      return 'missing permission or Page role — check scopes/role, do not retry';
    case 'rate_limit':
      return 'rate limited — back off and retry later';
    case 'transient':
      return 'transient server error — safe to retry a read';
    case 'duplicate':
      return 'identical content already exists — a previous attempt may have succeeded; do not retry';
    case 'not_found':
      return 'object not found or already gone';
    case 'ambiguous':
      return 'unknown outcome — the write may have landed; do NOT retry, verify first (e.g. facebook_list_posts / facebook_get_conversation)';
    case 'validation':
      return 'request rejected by validation — fix the parameters, do not retry';
    default:
      return 'request failed';
  }
}

interface GraphErrorOptions {
  readonly category?: ErrorCategory;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

/**
 * Construct a {@link GraphApiError} from a raw error response, redacting the
 * surfaced message. Exported so F08 raises errors through the same path.
 */
export function graphErrorFromResponse(
  status: number,
  bodyText: string,
  redactor: Redactor,
  options: GraphErrorOptions = {},
): GraphApiError {
  const parsed = parseGraphErrorEnvelope(bodyText);
  const category = options.category ?? bestEffortCategory(status, parsed?.code);
  const rawMessage =
    parsed?.message ??
    (bodyText.length > 0 ? bodyText.slice(0, ERROR_BODY_SNIPPET) : `HTTP ${status}`);
  const message = redactor.redactString(
    `Graph API error (HTTP ${status}): ${rawMessage}`,
  );
  const action: ErrorAction = {
    category,
    retryable:
      options.retryable ?? (category === 'rate_limit' || category === 'transient'),
    operatorText: operatorTextFor(category),
    ...(options.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}),
  };
  return new GraphApiError(message, {
    code: parsed?.code ?? 0,
    subcode: parsed?.subcode,
    type: parsed?.type,
    fbtraceId: parsed?.fbtraceId,
    httpStatus: status,
    action,
    cause: options.cause,
  });
}

function ambiguousError(status: number, detail: string, cause?: unknown): GraphApiError {
  const action: ErrorAction = {
    category: 'ambiguous',
    retryable: false,
    operatorText: operatorTextFor('ambiguous'),
  };
  return new GraphApiError(
    `ambiguous write outcome (${detail}) — do NOT retry; verify first`,
    { code: 0, httpStatus: status, action, cause },
  );
}

function networkError(err: unknown, redactor: Redactor): GraphApiError {
  const action: ErrorAction = {
    category: 'transient',
    retryable: true,
    operatorText: operatorTextFor('transient'),
  };
  return new GraphApiError(
    redactor.redactString(`network request failed: ${errorMessage(err)}`),
    { code: 0, httpStatus: 0, action, cause: err },
  );
}

// ---------------------------------------------------------------------------
// Per-host concurrency semaphore
// ---------------------------------------------------------------------------

/** Per-host concurrency limiter shared between the JSON and upload clients. */
export interface HostSemaphores {
  /** Acquire a slot for `host`; the returned function releases it (idempotent). */
  acquire(host: GraphHost): Promise<() => void>;
}

class AsyncSemaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.available = Math.max(1, permits);
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return this.makeRelease();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return this.makeRelease();
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next(); // hand the permit straight to the next waiter
      } else {
        this.available += 1;
      }
    };
  }
}

class HostSemaphoreSet implements HostSemaphores {
  private readonly map = new Map<GraphHost, AsyncSemaphore>();

  constructor(private readonly limit: number) {}

  acquire(host: GraphHost): Promise<() => void> {
    let sem = this.map.get(host);
    if (sem === undefined) {
      sem = new AsyncSemaphore(this.limit);
      this.map.set(host, sem);
    }
    return sem.acquire();
  }
}

/** Create a per-host semaphore set sized to `limit` permits per host. */
export function createHostSemaphores(limit: number): HostSemaphores {
  return new HostSemaphoreSet(limit);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function isRedirect(response: Response): boolean {
  return (
    (response.status >= 300 && response.status < 400) ||
    response.type === 'opaqueredirect'
  );
}

/**
 * Create an {@link FbRequestFn} for the JSON / query-string protocol. Non-JSON
 * protocols are delegated to `deps.uploadHandler` (F08) when provided.
 */
export function createFbRequest(deps: FbRequestDeps): FbRequestFn {
  const { settings, clock, redactor, logger } = deps;
  const rng = deps.rng ?? Math.random;
  const semaphores = deps.semaphores ?? createHostSemaphores(settings.hostConcurrency);
  const retry: RetryConfig = {
    maxRetries: deps.retry?.maxRetries ?? DEFAULT_MAX_RETRIES,
    baseDelayMs: deps.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    maxDelayMs: deps.retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
  };

  const feedUsage = (headers: FbResponseHeaders): void => {
    if (deps.onUsage !== undefined) {
      deps.onUsage(parseUsageHeaders(headers, clock.now()));
    }
  };

  const backoff = async (
    attempt: number,
    etaMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    const exp = Math.min(retry.baseDelayMs * 2 ** (attempt - 1), retry.maxDelayMs);
    // Honor the server's regain-access ETA when present, but never above the cap.
    const base = etaMs !== undefined ? Math.min(etaMs, retry.maxDelayMs) : exp;
    // Equal jitter: at least half the base, never above the base (⇒ ≤ cap).
    const delay = Math.floor(base / 2 + rng() * (base / 2));
    await clock.sleep(delay, signal);
  };

  const doFetch = async (
    url: string,
    method: string,
    headers: Record<string, string>,
    body: URLSearchParams | undefined,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<Response> => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined =
      signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    return fetch(url, {
      method,
      headers,
      body,
      redirect: 'manual', // never follow a redirect off the allowlisted host (CC-NET-7)
      signal: combined,
    });
  };

  const jsonRequest = async <T>(req: JsonRequest): Promise<FbResponse<T>> => {
    // --- Pre-flight (may throw before any slot is taken) ---
    const hostname = resolveHostBase(settings.hosts, req.host);
    const token = resolveToken(req, settings);
    const proof =
      settings.appSecret !== undefined && settings.appSecret.length > 0
        ? computeAppSecretProof(token, settings.appSecret)
        : undefined;

    // Register secrets so any accidental logging downstream scrubs them (C3).
    redactor.addSecret(token);
    if (proof !== undefined) redactor.addSecret(proof);
    if (settings.appSecret !== undefined && settings.appSecret.length > 0) {
      redactor.addSecret(settings.appSecret);
    }

    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(req.params ?? {})) {
      if (value !== undefined) query.set(key, String(value));
    }

    let body: URLSearchParams | undefined;
    if (req.method === 'POST') {
      // Proof rides in the body on POST so it stays out of any echoed URL.
      body = new URLSearchParams();
      for (const [key, value] of Object.entries(req.body ?? {})) {
        if (value !== undefined) body.set(key, encodeBodyValue(value));
      }
      if (proof !== undefined) body.set('appsecret_proof', proof);
    } else {
      if (proof !== undefined) query.set('appsecret_proof', proof);
      if (req.method === 'DELETE' && req.body !== undefined) {
        body = new URLSearchParams();
        for (const [key, value] of Object.entries(req.body)) {
          if (value !== undefined) body.set(key, encodeBodyValue(value));
        }
      }
    }

    const url = buildUrl(hostname, req.path, settings.apiVersion, query);
    const headers: Record<string, string> = {
      // Token via Bearer header ONLY — never the query string (C3).
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
    }

    const timeoutMs = req.timeoutMs ?? settings.requestTimeoutMs;
    const isWrite = req.method !== 'GET';

    logger.debug('fbRequest.json', {
      host: req.host,
      method: req.method,
      path: req.path,
    });

    const release = await semaphores.acquire(req.host);
    try {
      let attempt = 0;
      for (;;) {
        attempt += 1;
        let response: Response;
        try {
          response = await doFetch(url, req.method, headers, body, timeoutMs, req.signal);
        } catch (err) {
          // Caller cancellation / shutdown: terminal, never retried.
          if (req.signal?.aborted === true) throw err;
          // Our own terminal errors (e.g. a redirect violation) must not be
          // re-interpreted as a network fault.
          if (err instanceof GraphApiError) throw err;

          const verdict = retryVerdict('network', isWrite, isProvablyNotSent(err));
          if (verdict === 'ambiguous') {
            throw ambiguousError(0, `network fault: ${errorMessage(err)}`, err);
          }
          if (attempt <= retry.maxRetries) {
            logger.warn('fbRequest.retry', {
              host: req.host,
              method: req.method,
              path: req.path,
              attempt,
              reason: 'network',
            });
            await backoff(attempt, undefined, req.signal);
            continue;
          }
          throw networkError(err, redactor);
        }

        const responseHeaders = extractResponseHeaders(response);
        feedUsage(responseHeaders);

        if (isRedirect(response)) {
          const action: ErrorAction = {
            category: 'unknown',
            retryable: false,
            operatorText: 'redirect off the allowlisted host refused (host allowlist)',
          };
          throw new GraphApiError(
            `fbRequest: refusing redirect (HTTP ${response.status}) off host '${req.host}'`,
            { code: 0, httpStatus: response.status, action },
          );
        }

        if (response.ok) {
          const text = await response.text();
          const data: unknown = text.length === 0 ? undefined : (parseJson(text) ?? text);
          return { data: data as T, headers: responseHeaders, status: response.status };
        }

        // --- Error response ---
        const status = response.status;
        const bodyText = await response.text();
        const parsed = parseGraphErrorEnvelope(bodyText);
        const kind = classifyHttpError(status, parsed?.code);
        const verdict = retryVerdict(kind, isWrite);

        if (verdict === 'ambiguous') {
          // 5xx on a write: the mutation may have landed (C2).
          throw ambiguousError(status, `HTTP ${status} on ${req.method}`, bodyText);
        }

        if (verdict === 'terminal') {
          throw graphErrorFromResponse(status, bodyText, redactor);
        }

        // verdict === 'retry'
        if (attempt <= retry.maxRetries) {
          const etaMs =
            kind === 'throttle' && parsed?.etaSeconds !== undefined
              ? parsed.etaSeconds * 1000
              : undefined;
          logger.warn('fbRequest.retry', {
            host: req.host,
            method: req.method,
            path: req.path,
            attempt,
            reason: kind,
            status,
          });
          await backoff(attempt, etaMs, req.signal);
          continue;
        }

        // Retries exhausted.
        if (kind === 'throttle') {
          const etaMs =
            parsed?.etaSeconds !== undefined ? parsed.etaSeconds * 1000 : undefined;
          throw graphErrorFromResponse(status, bodyText, redactor, {
            category: 'rate_limit',
            retryable: false,
            ...(etaMs !== undefined ? { retryAfterMs: etaMs } : {}),
          });
        }
        throw graphErrorFromResponse(status, bodyText, redactor, {
          category: 'transient',
        });
      }
    } finally {
      release();
    }
  };

  const fbRequest: FbRequestFn = <T = unknown>(
    req: FbRequest,
  ): Promise<FbResponse<T>> => {
    if (req.protocol === 'json') {
      return jsonRequest<T>(req);
    }
    if (deps.uploadHandler !== undefined) {
      return deps.uploadHandler<T>(req);
    }
    return Promise.reject(
      new Error(
        `fbRequest: protocol '${req.protocol}' is handled by core/http-upload.ts (F08); ` +
          `provide it via the 'uploadHandler' dependency`,
      ),
    );
  };

  return fbRequest;
}
