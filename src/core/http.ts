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
//     not HTTP 429 — the retry matrix keys on the body code (CC-NET-1). A bare
//     HTTP 429 from a hop in front of Graph is a throttle too: rejected, not
//     processed, so it backs off instead of surfacing as a terminal error.
//   * The converse holds as well: a 2xx whose body is a Graph `{error}` envelope
//     is an error, not data — it takes the same classification as a 4xx (with
//     its real status), so a throttle in a 200 still backs off and a refusal in
//     a 200 still throws instead of reaching the api layer as an empty node.
//   * 5xx / transient network faults retry on GET only; writes whose body may
//     have reached the wire are NEVER auto-retried on a lost response — they
//     surface an `ambiguous` GraphApiError ("verify first") (C2 / CC-NET-5).
//   * Usage headers (`X-App-Usage`, `X-Business-Use-Case-Usage`,
//     `x-fb-ads-insights-throttle`) are parsed defensively on every response
//     (CC-NET-2); the raw headers are always on the response envelope and an
//     optional `onUsage` sink receives the parsed snapshot.
//   * Backoff honors the wait the server asked for — the `Retry-After` header in
//     either RFC 9110 spelling and `estimated_time_to_regain_access`, the longer
//     of the two when both arrive — but never sleeps beyond a 60s cap (CC-NET-3):
//     a server-named wait longer than the cap fails fast, carrying the real
//     wait as `retryAfterMs`, instead of re-hitting a blocked endpoint early.
//     Every wait goes through the injected `Clock.sleep` so tests drive it
//     deterministically with `createFakeClock`.
//   * Per-host concurrency semaphore (default 4).

import { createHmac } from 'node:crypto';

import { ETA_MINUTES_TO_MS } from './error-matrix.js';
import {
  ambiguousWriteAction,
  classifyGraphError,
  classifyNetworkError,
  DEFAULT_VERIFY_TOOL,
  errorMessageOf,
  isCursorRejection,
  matchErrorRow,
  nonJsonBodyAction,
  toGraphApiError,
  NON_JSON_BODY_MAX,
  type GraphErrorEnvelope,
} from './errors.js';
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
 * Is this path segment a relative-traversal segment?
 *
 * The WHATWG URL parser resolves `.` and `..` when `pathname` is assigned, and it
 * treats the percent-encoded spellings as equivalent — `%2e%2e` walks up exactly
 * like `..` does. So the check has to run over a decoded view, and encoding the
 * segment cannot substitute for it: `encodeURIComponent('..')` is `'..'`.
 */
function isDotSegment(segment: string): boolean {
  const decoded = segment.replace(/%2e/gi, '.');
  return decoded === '.' || decoded === '..';
}

/**
 * Escape every segment of a normalised pathname and refuse traversal segments.
 *
 * Edge paths are built by interpolating ids the model supplies — `/{post_id}`,
 * `/{comment_id}`, `/{conversation_id}` — and those ids routinely originate in
 * untrusted content (a comment body, a Page name). Without containment here, an
 * id of `../../me/accounts` retargets the request at a completely different edge
 * while keeping the method: `DELETE /{post_id}` becomes `DELETE /me/accounts`.
 * A tool-level allowlist cannot catch that, because the tool really did call the
 * edge it said it would. Two call sites already carry their own shape regex
 * (`POST_ID_SHAPE` in `../api/insights.ts`, `ACT_ID` in `../api/ads-read.ts`);
 * this makes the guarantee hold for every path, including the ones nobody
 * remembered to constrain.
 *
 * Exported so the upload protocols contain their paths identically — rupload and
 * multipart ids come from exactly the same untrusted places (`./http-upload.ts`).
 */
export function containPathname(pathname: string, who: string): string {
  // `slice(1)` drops the empty string the leading '/' produces. Empty inner
  // segments are preserved as-is: they make a malformed edge Graph will reject,
  // not a different one.
  const safeSegments = pathname
    .split('/')
    .slice(1)
    .map((segment) => {
      if (isDotSegment(segment)) {
        throw new Error(
          `${who}: path segment '${segment}' would traverse outside its edge ('${pathname}')`,
        );
      }
      // No caller pre-encodes (there is no other encodeURIComponent on a path in
      // this tree), so this cannot double-encode. `-`, `_`, `.` and `~` are left
      // alone, which covers every real Graph id shape: `123_456`, `act_123`, `v23.0`.
      return encodeURIComponent(segment);
    });
  return `/${safeSegments.join('/')}`;
}

/**
 * Build the request URL from a trusted hostname + a relative edge path. Rejects
 * absolute-URL / protocol-relative paths so a crafted `path` can never redirect
 * the request off the allowlisted host (CC-NET-7), and contains every segment
 * (see {@link containPathname}). The API version is prepended unless the path
 * already carries a `/vNN.N` segment.
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
  url.pathname = containPathname(pathname, 'fbRequest');
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

/**
 * An integer, or a string that is exactly one (`"190"`): Graph sends its error
 * `code` / `error_subcode` as numbers, but a hop that re-serialises the body can
 * hand them back quoted, and a dropped code leaves an expired token classified
 * as `unknown`. Only these two fields use it — a padded, fractional or exponent
 * form is not a code, and the ETA keeps its strict number type.
 */
function intOr(value: unknown): number | undefined {
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  return numOr(value);
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

const THROTTLE_CODES = new Set([4, 17, 32, 341, 613]);

/** Throttle codes: families 4/17/32/341/613 plus the 80000–80099 range. */
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
  // Graph ships its own throttles as HTTP 400 + a body code, which is why the
  // matrix keys on the body — but that is a statement about Graph, not about
  // every hop in front of it. An edge, a CDN or a corporate proxy answers with a
  // bare 429 and a `Retry-After`, and with no body code to key on that fell
  // through to `terminal`: never retried, surfaced as a non-retryable `unknown`,
  // with the one status HTTP defines as "come back later" thrown away. A 429
  // means the request was REJECTED rather than processed (RFC 9110 §15.5.30), so
  // it carries the same provably-not-processed guarantee a body-code throttle
  // does and is safe to retry on a write as well as a read.
  if (status === 429) return 'throttle';
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

/**
 * True when a `fetch` rejection provably never put a byte of the request on the
 * wire (DNS / connect-phase failure, keyed on the undici/Node error `code` —
 * direct, or on its `cause` when the rejection itself carries no string code).
 * Such a write can be retried safely: nothing reached Graph, so nothing can have
 * landed (CC-NET-5). Exported so the upload transport can share this predicate
 * instead of keeping its own copy of the code set.
 */
export function isProvablyNotSent(err: unknown): boolean {
  const code = errorCode(err);
  return code !== undefined && CONNECT_PHASE_CODES.has(code);
}

/**
 * The operator-facing reason of a transport fault. undici rejects every fault
 * as `TypeError: fetch failed` and carries the actionable reason (`getaddrinfo
 * ENOTFOUND host`, `connect ECONNREFUSED`, a TLS error) on `cause`; the outer
 * message alone names nothing an operator can act on. The cause's message is
 * appended when it adds information, else its string `code` (undici's
 * `AggregateError` for a multi-address connect failure has an empty message).
 * Non-`Error` rejections keep their `{ message }` via {@link errorMessageOf}.
 * Never throws.
 */
export function describeFault(err: unknown): string {
  const raw = errorMessageOf(err);
  // An object with no message stringifies as `[object Object]`, which names
  // nothing; its `code` (below) is the only reason it carries.
  const message =
    typeof err === 'object' && err !== null && raw.startsWith('[object ')
      ? 'unknown error'
      : raw;
  let detail: string | undefined;
  try {
    const rec = asRecord(err);
    const cause = asRecord(rec?.cause);
    if (cause) {
      detail =
        typeof cause.message === 'string' && cause.message.length > 0
          ? cause.message
          : strOr(cause.code);
    } else if (message === 'unknown error' && rec) {
      detail = strOr(rec.code);
    }
  } catch {
    // A throwing `cause` / `message` getter: the outer message is all there is.
  }
  if (detail === undefined || detail.length === 0 || message.includes(detail)) {
    return message;
  }
  return message.length > 0 ? `${message} (${detail})` : detail;
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
  /**
   * `estimated_time_to_regain_access` verbatim. Graph's documented unit is
   * MINUTES — see `ETA_MINUTES_TO_MS` in `./error-matrix.js`, CC-NET-3, and the
   * matching conversion in `./errors.js`. Reading it as seconds under-reports a
   * block by 60×: a 30-minute lockout surfaces to the operator as half a minute.
   */
  readonly etaMinutes?: number;
  /**
   * Graph's own retry verdict on a code the matrix does not know. Only the
   * boolean `true` counts; a `"true"`, a `1`, or a missing field is no verdict.
   */
  readonly isTransient?: boolean;
  /** `error_user_title` / `error_user_msg`: the human-readable refusal, when sent. */
  readonly userTitle?: string;
  readonly userMessage?: string;
}

/** Parse the `{error: {...}}` envelope defensively; `undefined` if not present. */
function parseGraphErrorEnvelope(bodyText: string): ParsedGraphError | undefined {
  const root = asRecord(parseJson(bodyText));
  const err = root ? asRecord(root.error) : undefined;
  if (!err) return undefined;
  const errorData = asRecord(err.error_data);
  return {
    code: intOr(err.code),
    subcode: intOr(err.error_subcode),
    message: strOr(err.message),
    type: strOr(err.type),
    fbtraceId: strOr(err.fbtrace_id),
    etaMinutes:
      numOr(err.estimated_time_to_regain_access) ??
      (errorData ? numOr(errorData.estimated_time_to_regain_access) : undefined),
    ...(typeof err.is_transient === 'boolean' ? { isTransient: err.is_transient } : {}),
    userTitle: strOr(err.error_user_title),
    userMessage: strOr(err.error_user_msg),
  };
}

/**
 * Does a parsed envelope actually READ as a Graph error? The parse above is
 * deliberately loose — on a non-2xx the absence of a body code is itself a
 * signal, and every field is optional — but on a 2xx it has to be strict: a
 * legitimate node may carry an `error` field of its own (a per-PSID block entry,
 * a video phase status), and misreading one of those as a refusal would turn a
 * successful call into a thrown error. A Graph envelope always carries a string
 * `message` and a numeric `code` (and almost always a string `type`); the
 * `parseGraphErrorEnvelope` fields are typed, so `!== undefined` here means
 * "was present with the right type", never merely "was present" (an integer
 * `code` re-serialised as `"190"` counts — see `intOr`; `"E100"` does not).
 * The user-facing `error_user_*` text never makes an envelope on its own.
 */
function isGraphErrorEnvelope(
  parsed: ParsedGraphError | undefined,
): parsed is ParsedGraphError {
  return (
    parsed !== undefined &&
    parsed.message !== undefined &&
    (parsed.code !== undefined || parsed.type !== undefined)
  );
}

/**
 * Does a raw response body carry a Graph error envelope? The one-call form of
 * `parseGraphErrorEnvelope` + `isGraphErrorEnvelope` for callers outside this
 * module (the upload handlers) that only need the verdict, not the fields — a
 * 2xx whose body is `{error: {...}}` is the error, never data (CC-NET-1).
 */
export function bodyIsGraphErrorEnvelope(bodyText: string): boolean {
  return isGraphErrorEnvelope(parseGraphErrorEnvelope(bodyText));
}

/**
 * The regain-access ETA as a sleepable duration in ms, or `undefined` when the
 * envelope's value is not one.
 *
 * `estimated_time_to_regain_access` is only ever read off the wire, and the wire
 * is not bound to Graph's documentation: `numOr` accepts any finite number, so a
 * 0 or a negative reaches here intact. Multiplied through unguarded, a 0 becomes
 * a 0 ms backoff — {@link backoff} makes it the base, and equal jitter of 0 is 0
 * — so the whole retry budget fires back to back into an endpoint that has just
 * said "you are blocked", which is exactly how a soft throttle is escalated into
 * a hard one. A negative value is worse still: it produces a negative sleep,
 * i.e. no wait at all, and surfaces to the operator as a retry-after that is not
 * a duration. Neither value is an instruction the server actually gave, so
 * neither replaces the exponential schedule or the matrix's own throttle
 * default. `./errors.js` guards its own conversion the same way (`eta > 0`) —
 * this keeps the two readings of the same field consistent.
 */
function throttleEtaMs(etaMinutes: number | undefined): number | undefined {
  if (etaMinutes === undefined || !(etaMinutes > 0)) return undefined;
  return etaMinutes * ETA_MINUTES_TO_MS;
}

/** Business-use-case throttle codes: the 80000–80099 range. */
function isBusinessUseCaseCode(code: number | undefined): boolean {
  return code !== undefined && code >= 80000 && code <= 80099;
}

/**
 * The regain-access wait a business-use-case throttle names in its
 * `X-Business-Use-Case-Usage` header, in ms, or `undefined` when the response is
 * not such a throttle or the header names no positive wait.
 *
 * A 80000–80099 envelope carries no `estimated_time_to_regain_access` of its
 * own: Graph states that wait per business object in this header instead (in
 * MINUTES, like the envelope field). Ignored, the client re-hit an endpoint
 * blocked for 25 minutes on the exponential schedule and then surfaced the
 * matrix's 60s default — telling the caller to come back 24 minutes early.
 * The longest bucket wins: a request touching several objects is blocked until
 * the last of them regains access. Parsed with the same {@link throttleEtaMs}
 * guards, so a `0`, a negative or a non-number is no instruction at all.
 */
export function businessUseCaseEtaMs(
  code: number | undefined,
  headers: FbResponseHeaders,
): number | undefined {
  if (!isBusinessUseCaseCode(code)) return undefined;
  const raw = headers[USAGE_HEADERS.businessUseCaseUsage];
  if (raw === undefined) return undefined;
  const rec = asRecord(parseJson(raw));
  if (!rec) return undefined;
  let max: number | undefined;
  for (const bucket of Object.values(rec)) {
    if (!Array.isArray(bucket)) continue;
    for (const entry of bucket) {
      const ms = throttleEtaMs(
        numOr(asRecord(entry)?.['estimated_time_to_regain_access']),
      );
      if (ms !== undefined && Number.isFinite(ms)) {
        max = max === undefined ? ms : Math.max(max, ms);
      }
    }
  }
  return max;
}

/** The longer of two optional waits (either may be absent). */
function longerWait(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/**
 * The `Retry-After` response header as a sleepable duration in ms, or
 * `undefined` when the header is absent, unparseable, or is not a wait that
 * still lies in the future.
 *
 * Both spellings RFC 9110 §10.2.3 defines are accepted, because both appear in
 * the wild on the hops in front of Graph: `delay-seconds` (a non-negative
 * integer) and `HTTP-date` (an absolute instant, so the wait is what remains of
 * it against `nowMs` — read off the injected clock, never `Date.now()`).
 *
 * The guards mirror {@link throttleEtaMs} exactly, for the same reason. A `0`, a
 * value that is not a number at all, and a date already in the past are not
 * waits the server asked for; honored as a backoff base each one makes the delay
 * 0 and fires the whole retry budget back to back into an endpoint that has just
 * said "come back later" — the way a soft throttle becomes a hard block. Falling
 * through to `undefined` leaves the exponential schedule standing.
 */
export function parseRetryAfterMs(
  raw: string | undefined,
  nowMs: number,
): number | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value.length === 0) return undefined;
  if (/^\d+$/.test(value)) {
    const ms = Number(value) * 1000;
    // A digit run past ~309 characters is `Infinity`: not a duration, and
    // surfaced it would serialise to `null` — the caller would be told nothing.
    return Number.isFinite(ms) && ms > 0 ? ms : undefined;
  }
  const dueMs = Date.parse(value);
  if (Number.isNaN(dueMs)) return undefined;
  const remaining = dueMs - nowMs;
  return remaining > 0 ? remaining : undefined;
}

/**
 * The wait this error response actually asked for: the longer of its
 * `Retry-After` header and the envelope's regain-access ETA, or `undefined` when
 * it asked for neither.
 *
 * The two are independent statements of the same thing and neither is
 * authoritative over the other — the header is what the answering hop wants, the
 * ETA is Graph's own estimate of when access returns — so the reading that
 * satisfies both is the longer one. RFC 9110 reads `Retry-After` as a MINIMUM
 * wait, so waiting past it stays compliant; under-waiting on a block is the
 * expensive mistake, and {@link RetryConfig.maxDelayMs} bounds the other
 * direction (CC-NET-3).
 */
function serverBackoffMs(
  headers: FbResponseHeaders,
  etaMs: number | undefined,
  nowMs: number,
): number | undefined {
  const retryAfterMs = parseRetryAfterMs(headers['retry-after'], nowMs);
  if (retryAfterMs === undefined) return etaMs;
  if (etaMs === undefined) return retryAfterMs;
  return Math.max(retryAfterMs, etaMs);
}

/**
 * Coarse category for a body code the F06 matrix does NOT recognize. The matrix
 * is the authority for every code it knows (see {@link actionForResponse}); this
 * fallback only has to keep an unclassified error from surfacing as `unknown`
 * when the HTTP status alone already says something useful (5xx ⇒ transient).
 */
export function bestEffortCategory(
  status: number,
  code: number | undefined,
): ErrorCategory {
  if (isThrottleCode(code)) return 'rate_limit';
  if (code === 190) return 'auth';
  if (code === 200 || code === 10) return 'permission';
  if (code === 506) return 'duplicate';
  if (code === 100 || code === 803) return 'not_found';
  // Checked after the body codes so a 429 that does carry a recognizable code is
  // still described by it, and before the 5xx rule so a bare 429 reaches the
  // operator as the rate limit it is rather than as `unknown`.
  if (status === 429) return 'rate_limit';
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
      return 'unknown outcome — the write may have landed; do NOT retry, re-read the object you wrote (or the listing it belongs to) first';
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
 * The F06 classification for a parsed envelope, or `undefined` when the matrix
 * does not recognize the code. `classifyGraphError` is total (an unknown code
 * yields the `unknown` action), so the row has to be probed separately — an
 * unrecognized code must fall through to {@link bestEffortCategory}, which still
 * reads the HTTP status, rather than collapse to `unknown`.
 */
function matrixAction(parsed: ParsedGraphError | undefined): ErrorAction | undefined {
  if (parsed?.code === undefined) return undefined;
  const envelope = toEnvelope(parsed);
  // A rejected pagination cursor has no row of its own — it arrives under codes
  // the table already claims for other meanings (CC-PAGE-2, see
  // `isCursorRejection` in ./errors.js) — so the row probe must not veto it, or
  // a cursor rejected as code 1 would fall through to `bestEffortCategory` and
  // surface as a retryable `transient` that can never succeed.
  //
  // A code Graph itself flags `is_transient: true` has no row either, but it is
  // not unclassified: the classifier turns the flag into a retryable transient,
  // and it can only do that if the envelope is allowed through to it.
  if (
    !isCursorRejection(envelope) &&
    !matchErrorRow(parsed.code, parsed.subcode) &&
    parsed.isTransient !== true
  ) {
    return undefined;
  }
  return classifyGraphError(envelope);
}

/**
 * The parsed wire fields in the F06 {@link GraphErrorEnvelope} shape. Single
 * conversion, shared by the classifier and by the surfaced error, so the two can
 * never disagree about what Graph actually said.
 *
 * `message` matters beyond display: it is the only evidence a rejected cursor
 * leaves on the wire, and it must reach the classifier RAW — the surfaced text is
 * redacted (C3) and prefixed with a status line before an operator ever sees it.
 */
function toEnvelope(parsed: ParsedGraphError | undefined): GraphErrorEnvelope {
  return {
    code: parsed?.code ?? 0,
    ...(parsed?.subcode !== undefined ? { error_subcode: parsed.subcode } : {}),
    ...(parsed?.message !== undefined ? { message: parsed.message } : {}),
    ...(parsed?.type !== undefined ? { type: parsed.type } : {}),
    ...(parsed?.fbtraceId !== undefined ? { fbtrace_id: parsed.fbtraceId } : {}),
    // The matrix converts this to ms itself (Graph's unit is MINUTES).
    ...(parsed?.etaMinutes !== undefined
      ? { estimated_time_to_regain_access: parsed.etaMinutes }
      : {}),
    ...(parsed?.isTransient !== undefined ? { is_transient: parsed.isTransient } : {}),
    ...(parsed?.userTitle !== undefined ? { error_user_title: parsed.userTitle } : {}),
    ...(parsed?.userMessage !== undefined ? { error_user_msg: parsed.userMessage } : {}),
  };
}

/**
 * Build the {@link ErrorAction} for a real Graph error response.
 *
 * Every code the F06 matrix knows is classified BY the matrix, so a live error
 * carries the same category/retryable/nextTool/operator guidance the matrix
 * already defines for it — including the next tool to run (`facebook_whoami`,
 * `facebook_usage`, `facebook_list_posts`) and the ETA computed from the
 * envelope. Without this the transport re-derived a coarse category of its own
 * and no live error ever reached the model with a next step.
 *
 * A response with no Graph envelope at all is classified by
 * `nonJsonBodyAction` (CC-NET-4/CC-NET-6) rather than by the status alone, which
 * is how an HTML proxy interstitial reaches the operator with the proxy-env hint
 * instead of a bare "request failed".
 *
 * The retry loop's `options` still win where it knows better than the table:
 * once retries are exhausted a throttle is no longer `retryable` no matter what
 * the row says. An overridden category discards the row's text, because guidance
 * written for a different category would misdescribe the error.
 */
function actionForResponse(
  status: number,
  parsed: ParsedGraphError | undefined,
  options: GraphErrorOptions,
): ErrorAction {
  // No Graph envelope at all — HTML from an edge or a corporate proxy, a body
  // that is not an error envelope, an empty 5xx (CC-NET-4): the ABSENCE is the
  // signal, and `nonJsonBodyAction` is what puts the CC-NET-6 proxy self-
  // diagnosis in front of the operator. Feeding it through the same `row` slot a
  // matrix hit uses keeps one rule for how `options` override table guidance.
  const classified =
    parsed === undefined ? nonJsonBodyAction(status) : matrixAction(parsed);
  const category =
    options.category ?? classified?.category ?? bestEffortCategory(status, parsed?.code);
  const row = classified?.category === category ? classified : undefined;
  const retryAfterMs = options.retryAfterMs ?? row?.retryAfterMs;
  const retryable =
    options.retryable ??
    row?.retryable ??
    (category === 'rate_limit' || category === 'transient');
  return {
    category,
    retryable,
    operatorText: row?.operatorText ?? operatorTextFor(category),
    ...(row?.nextTool !== undefined ? { nextTool: row.nextTool } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
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
  // The snippet is redacted BEFORE it is cut: a cut through a secret (a proxy
  // page echoing a URL that carries `appsecret_proof`) leaves a partial value
  // that neither the exact-value scan nor the hex/`EAA` patterns can recognise.
  const rawMessage =
    parsed?.message ??
    (bodyText.length > 0
      ? redactor.redactString(bodyText).slice(0, NON_JSON_BODY_MAX)
      : `HTTP ${status}`);
  const message = redactor.redactString(
    `Graph API error (HTTP ${status}): ${rawMessage}`,
  );
  // The user-facing text echoes request parameters just as `message` can, so
  // it passes the same redaction choke-point (C3) before it is surfaced.
  const envelope = toEnvelope(parsed);
  const redacted: GraphErrorEnvelope = {
    ...envelope,
    ...(envelope.error_user_title !== undefined
      ? { error_user_title: redactor.redactString(envelope.error_user_title) }
      : {}),
    ...(envelope.error_user_msg !== undefined
      ? { error_user_msg: redactor.redactString(envelope.error_user_msg) }
      : {}),
  };
  // The envelope -> GraphApiError field mapping lives in F06 and is reused here
  // rather than repeated; only the two things this layer knows better are passed
  // as overrides — the redacted, status-prefixed message and the action, which
  // the retry loop may have downgraded now that its attempts are spent.
  return toGraphApiError(redacted, status, {
    message,
    action: actionForResponse(status, parsed, options),
    ...(options.cause !== undefined ? { cause: options.cause } : {}),
  });
}

/**
 * Usage snapshots of the responses Graph errors were raised for. A side table
 * rather than a field: `GraphApiError`'s shape is frozen in `./types.js`, and a
 * WeakMap keeps the snapshot alive exactly as long as the error it belongs to.
 */
const errorUsage = new WeakMap<GraphApiError, UsageSnapshot>();

/**
 * The rate-limit usage snapshot parsed from the response a {@link GraphApiError}
 * was raised for, or `undefined` when that response carried no usage header (or
 * `err` is not such an error).
 *
 * A throttle names the bucket that is full (`X-App-Usage`,
 * `X-Business-Use-Case-Usage`, `x-fb-ads-insights-throttle`) on the very
 * response that refuses the call. Every throttle row sends the caller to
 * `facebook_usage`, whose own probe is refused by the same throttle — so this
 * response is the only place those figures ever exist.
 */
export function usageOfGraphError(err: unknown): UsageSnapshot | undefined {
  // A layer that re-words a transport error (a reclassified send refusal, a
  // re-stamped verify tool) builds a new GraphApiError with the original as its
  // `cause`; the snapshot stays on the original, so follow that chain.
  let current: unknown = err;
  for (let depth = 0; depth < USAGE_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof GraphApiError)) return undefined;
    const usage = errorUsage.get(current);
    if (usage !== undefined) return usage;
    current = current.cause;
  }
  return undefined;
}

/** How many re-wrapped GraphApiErrors {@link usageOfGraphError} looks through. */
const USAGE_CAUSE_DEPTH = 4;

/** Attach the response's usage snapshot to `err` when it carried any usage header. */
function withUsage(
  err: GraphApiError,
  headers: FbResponseHeaders,
  nowMs: number,
): GraphApiError {
  const snapshot = parseUsageHeaders(headers, nowMs);
  if (Object.keys(snapshot.raw).length > 0) errorUsage.set(err, snapshot);
  return err;
}

/** A `POST /{page-id}/feed` edge path: the one write core can name a verify tool for. */
const FEED_POST_PATH = /^\/[^/]+\/feed$/;

/**
 * The read that can show whether an ambiguous write landed, when the request
 * alone proves it — else `undefined`, and the guidance names no tool.
 *
 * Only a feed post qualifies: every other write path is `/{id}` or an edge
 * shared by unrelated objects (a comment id and a post id have the same
 * shape), so any tool named for them would be a guess. Within the feed, a
 * `published: false` post never reaches the published listing: a scheduled one
 * sits on the scheduled queue, and a draft is on no listing at all.
 */
function verifyToolFor(req: JsonRequest): string | undefined {
  if (req.verifyTool !== undefined) return req.verifyTool;
  if (req.method !== 'POST' || !FEED_POST_PATH.test(req.path)) return undefined;
  const body = req.body ?? {};
  if (body['published'] === false || body['published'] === 'false') {
    return body['scheduled_publish_time'] !== undefined
      ? 'facebook_list_scheduled_posts'
      : undefined;
  }
  return DEFAULT_VERIFY_TOOL;
}

/**
 * The C2 ambiguous-write error. The action comes from F06 so the surfaced
 * guidance names the verify-tool (`nextTool`) — when the request proves which
 * read can show the outcome (see {@link verifyToolFor}) — instead of only
 * saying "verify".
 */
function ambiguousError(
  status: number,
  detail: string,
  redactor: Redactor,
  cause: unknown,
  verifyTool: string | undefined,
): GraphApiError {
  // `detail` is wire text: the call sites interpolate `describeFault(err)`, and a
  // transport fault routinely quotes the URL it failed on — which carries
  // `appsecret_proof` on a DELETE, and can carry a token echoed back by a
  // middlebox or an upstream helper. It lands in TWO places at once, the
  // surfaced message and the F06 operator guidance built from it, and both are
  // logged and handed to the model. Redacted exactly the way `networkError`
  // below does it: once into the action's text, once over the whole message.
  const action = ambiguousWriteAction({
    detail: redactor.redactString(detail),
    ...(verifyTool !== undefined ? { verifyTool } : {}),
  });
  return new GraphApiError(
    redactor.redactString(
      `ambiguous write outcome (${detail}) — do NOT retry; verify first`,
    ),
    { code: 0, httpStatus: status, action, cause },
  );
}

/**
 * A network fault with no Graph envelope, classified by F06 (CC-NET-5). Routing
 * it through `classifyNetworkError` is what puts the CC-NET-6 proxy self-
 * diagnosis in front of the operator — a TLS-interception middlebox produces
 * exactly these connect failures and resets, and the hint names the env vars to
 * check. Reached only when retries are exhausted; a write whose request may have
 * been sent never gets here (it throws {@link ambiguousError} first).
 */
function networkError(err: unknown, redactor: Redactor, isWrite: boolean): GraphApiError {
  const action = classifyNetworkError({
    phase: isProvablyNotSent(err) ? 'connect' : 'response',
    isWrite,
    reason: redactor.redactString(describeFault(err)),
  });
  return new GraphApiError(
    redactor.redactString(`network request failed: ${describeFault(err)}`),
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
 * Consume and discard the body of a response we are refusing, so its connection
 * is released rather than pinned. `redirect: 'manual'` does NOT hand back an
 * empty opaque-redirect response under Node/undici: it hands back a normal
 * response carrying the origin's 3xx body, and a body left unread keeps its
 * socket out of the pool (measured on Node 22: five refused redirects in a row
 * open five sockets and release none, against one reused socket when the body
 * is read). Every other exit in this module reads the body; this one does too.
 *
 * The read is advisory. A body that fails mid-read must not replace the refusal
 * the caller has to see, so the rejection is swallowed.
 */
async function discardBody(response: Response): Promise<void> {
  await response.text().catch(() => undefined);
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
    if (deps.onUsage === undefined) return;
    try {
      deps.onUsage(parseUsageHeaders(headers, clock.now()));
    } catch (err) {
      // The sink is ADVISORY — it exists so a caller can back off proactively.
      // Usage headers are parsed defensively (CC-NET-2) and the observer must be
      // just as defensive: a sink that throws cannot be allowed to fail a
      // request the server has already answered, nor to be mistaken for the
      // transport fault whose classification runs around it.
      logger.warn('usage sink threw — the response is unaffected', {
        reason: redactor.redactString(describeFault(err)),
      });
    }
  };

  const backoff = async (
    attempt: number,
    serverDelayMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    const exp = Math.min(retry.baseDelayMs * 2 ** (attempt - 1), retry.maxDelayMs);
    // Honor the wait the server asked for (`Retry-After` / the regain-access ETA)
    // when there is one, but never above the cap (CC-NET-3).
    const base =
      serverDelayMs !== undefined ? Math.min(serverDelayMs, retry.maxDelayMs) : exp;
    // A server-named wait is a MINIMUM (RFC 9110 §10.2.3; the ETA is when access
    // returns), so it is slept in full — jitter would retry inside the window the
    // server just asked us to sit out. Only the local exponential schedule is
    // jittered. Equal jitter: at least half the base, never above it (⇒ ≤ cap).
    const delay =
      serverDelayMs !== undefined ? base : Math.floor(base / 2 + rng() * (base / 2));
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
            throw ambiguousError(
              0,
              `network fault: ${describeFault(err)}`,
              redactor,
              err,
              verifyToolFor(req),
            );
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
          throw networkError(err, redactor, isWrite);
        }

        const responseHeaders = extractResponseHeaders(response);
        feedUsage(responseHeaders);

        if (isRedirect(response)) {
          await discardBody(response);
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

        // The body is read INSIDE the transport-fault classification, not after
        // it. `fetch` settles on the response HEAD; the body is still arriving
        // over the same connection when it does, so a connection cut between the
        // head and the last byte rejects HERE rather than from `doFetch` (undici
        // spells it `TypeError: terminated`, and a TLS-interception middlebox
        // that truncates a large page produces exactly this). Read outside the
        // classification, that rejection escaped `jsonRequest` raw: no category,
        // no operator text, no `nextTool`, and — on a GET, where re-reading costs
        // nothing and is safe — no retry, though a truncated stream is the
        // textbook transient the matrix says to retry. It is the same mid-flight
        // fault as a lost response, so it takes the same verdict: a read retries,
        // and a write is AMBIGUOUS. The write case is the one that matters most:
        // a 200 whose body was lost means the post exists and only its id went
        // missing, and surfacing that as a plain failure invites a retry that
        // publishes it twice (C2).
        //
        // Ordering is deliberate: the redirect refusal above runs first, so
        // `discardBody`'s advisory read stays swallowed and CC-NET-7 still
        // surfaces the refusal rather than a body-read fault.
        let bodyText: string;
        try {
          bodyText = await response.text();
        } catch (err) {
          if (req.signal?.aborted === true) throw err;
          if (retryVerdict('network', isWrite) === 'ambiguous') {
            throw ambiguousError(
              response.status,
              `response body lost after HTTP ${response.status}: ${describeFault(err)}`,
              redactor,
              err,
              verifyToolFor(req),
            );
          }
          if (attempt <= retry.maxRetries) {
            logger.warn('fbRequest.retry', {
              host: req.host,
              method: req.method,
              path: req.path,
              attempt,
              reason: 'body',
              status: response.status,
            });
            await backoff(attempt, undefined, req.signal);
            continue;
          }
          throw networkError(err, redactor, isWrite);
        }

        // The status line is not trusted on its own: Graph ships application
        // errors inside an HTTP 200 on some paths, exactly as it ships its
        // throttles as HTTP 400 (CC-NET-1) — the BODY is the verdict. Returned
        // as `data`, a 200 `{error}` envelope reaches the api layer as a node
        // with none of the fields it asked for and degrades into "unconfirmed"
        // outcomes, and on a write the caller can no longer tell "Graph refused
        // it" (fix and retry) from "the wire did not say" (verify first). So a
        // 2xx whose body reads as an envelope — strictly, see
        // `isGraphErrorEnvelope` — takes the error path below with its REAL
        // status: a throttle backs off and retries, everything else throws the
        // classified GraphApiError. Anything looser stays data.
        const parsed = parseGraphErrorEnvelope(bodyText);
        if (response.ok && !isGraphErrorEnvelope(parsed)) {
          // `parseJson` yields `undefined` only for text that is not JSON (no
          // JSON value parses to `undefined`), so that is the one signal that
          // the body is not JSON: a literal `null` body stays `null`, and an
          // empty body stays `undefined`. A NON-empty body that is not JSON is not Graph's answer: it is a
          // proxy or captive-portal page served with a 200, or a JSON body cut
          // short. Handed back as a string `data`, every api reader misreads
          // it — a list edge as a page with no rows ("no posts"), a node as
          // not found, a write confirmation (`{success:true}` / `{id}`) as
          // Graph saying "no". So it is never data. On a write the mutation
          // may have landed and the answer is lost: ambiguous (C2), never
          // re-sent. On a read it is the classified no-envelope error, carrying
          // the proxy hint and the body snippet, and not retried automatically
          // (`nonJsonBodyAction`).
          const json = parseJson(bodyText);
          if (bodyText.length > 0 && json === undefined) {
            throw withUsage(
              isWrite
                ? ambiguousError(
                    response.status,
                    `HTTP ${response.status} on ${req.method}, but the body is not JSON`,
                    redactor,
                    bodyText,
                    verifyToolFor(req),
                  )
                : graphErrorFromResponse(response.status, bodyText, redactor),
              responseHeaders,
              clock.now(),
            );
          }
          return { data: json as T, headers: responseHeaders, status: response.status };
        }

        // --- Error response (or a 2xx carrying an envelope) ---
        const status = response.status;
        const kind = classifyHttpError(status, parsed?.code);
        // On a 2xx `kind` can only be `throttle` (body code) or `terminal` — the
        // status is neither 429 nor 5xx — so the status alone never makes a
        // write `ambiguous`. A transient Graph code (1/2, `is_transient`) can:
        // see the terminal branch below.
        const verdict = retryVerdict(kind, isWrite);

        if (verdict === 'ambiguous') {
          // 5xx on a write: the mutation may have landed (C2). The response
          // still carries its usage headers, like every other terminal throw.
          throw withUsage(
            ambiguousError(
              status,
              `HTTP ${status} on ${req.method}`,
              redactor,
              bodyText,
              verifyToolFor(req),
            ),
            responseHeaders,
            clock.now(),
          );
        }

        if (verdict === 'terminal') {
          const err = graphErrorFromResponse(status, bodyText, redactor);
          if (isWrite && err.action?.category === 'transient') {
            // Code 1/2 (or a code Graph flags `is_transient`) is Graph's own
            // server-side fault, shipped at HTTP 400 or inside a 200. On a
            // write it is exactly as ambiguous as a 5xx — the mutation may have
            // landed — so the matrix's `retryable: true` must not reach the
            // caller as an invitation to repeat it (C2).
            throw withUsage(
              ambiguousError(
                status,
                `HTTP ${status}, transient Graph code ${String(parsed?.code)} on ${req.method}`,
                redactor,
                bodyText,
                verifyToolFor(req),
              ),
              responseHeaders,
              clock.now(),
            );
          }
          throw withUsage(err, responseHeaders, clock.now());
        }

        // verdict === 'retry'
        // `Retry-After` is read on every retryable failure, not only a
        // throttle: a 503 + `Retry-After` is the classic maintenance signal,
        // and the header is the one instruction on the response that says when
        // to come back rather than guessing.
        const serverDelayMs = serverBackoffMs(
          responseHeaders,
          kind === 'throttle'
            ? longerWait(
                throttleEtaMs(parsed?.etaMinutes),
                businessUseCaseEtaMs(parsed?.code, responseHeaders),
              )
            : undefined,
          clock.now(),
        );
        // A named wait beyond `maxDelayMs` is not slept: sleeping the capped
        // figure would re-hit an endpoint that said it is blocked for longer,
        // hold a host permit for minutes, and deliver the real wait only after
        // the MCP client may have timed out. It fails fast below instead.
        const waitFits = serverDelayMs === undefined || serverDelayMs <= retry.maxDelayMs;
        if (attempt <= retry.maxRetries && waitFits) {
          logger.warn('fbRequest.retry', {
            host: req.host,
            method: req.method,
            path: req.path,
            attempt,
            reason: kind,
            status,
          });
          await backoff(attempt, serverDelayMs, req.signal);
          continue;
        }

        // Retries exhausted, or the named wait exceeds the cap (see above). The
        // wait the server asked for stops being something
        // we sleep on here and becomes the only concrete number the caller has
        // left: the same `serverBackoffMs` reading is therefore surfaced as
        // `retryAfterMs`, uncapped. `maxDelayMs` bounds how long THIS process
        // will block (CC-NET-3); it says nothing about when the endpoint will
        // actually answer, and clamping the surfaced figure to 60s would tell a
        // caller holding a five-minute block to come back in one minute — which
        // is how a soft throttle is escalated into a hard one by a client that
        // was told better and rounded it down.
        const serverWaitMs = serverDelayMs;
        if (kind === 'throttle') {
          throw withUsage(
            graphErrorFromResponse(status, bodyText, redactor, {
              category: 'rate_limit',
              retryable: false,
              ...(serverWaitMs !== undefined ? { retryAfterMs: serverWaitMs } : {}),
            }),
            responseHeaders,
            clock.now(),
          );
        }
        // A 503 carrying a `Retry-After` is the classic maintenance signal, and
        // an exhausted transient is retryable by the caller — so the window it
        // named is worth passing on rather than leaving them to guess.
        throw withUsage(
          graphErrorFromResponse(status, bodyText, redactor, {
            category: 'transient',
            ...(serverWaitMs !== undefined ? { retryAfterMs: serverWaitMs } : {}),
          }),
          responseHeaders,
          clock.now(),
        );
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
