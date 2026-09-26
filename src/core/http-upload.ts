// HTTP client — the multipart + raw-binary rupload protocols of `fbRequest`
// (task F08). The JSON / query-string protocol lives in `core/http.ts` (F07);
// this module is the `uploadHandler` that F07's `createFbRequest` delegates to
// for every non-JSON `FbRequest`. Both clients share ONE per-host concurrency
// budget when the integrator passes the same `HostSemaphores` instance to each.
//
// Design invariants (see docs/analysis/05-architecture.md §2, docs/reviews/
// SUMMARY.md C7, docs/analysis/09-corner-cases.md CC-MEDIA-2/3):
//   * multipart (photos / small video): a `FormData` body of `fields` + file
//     `Blob`s, auth via `Authorization: Bearer <token>` + an `appsecret_proof`
//     FORM FIELD (never the URL — C3). A multipart POST is a one-shot ambiguous
//     write: on a 5xx or a lost response it is NEVER auto-retried (C2) — it
//     surfaces an `ambiguous` GraphApiError ("verify first").
//   * rupload (chunked resumable upload): header auth `Authorization: OAuth
//     <token>` (NOT Bearer) + a `file_offset` header + any caller `headers`,
//     raw-binary `chunk` body. Chunk POSTs BYPASS F07's generic throttle/5xx
//     retry matrix; a chunk is offset-idempotent, so on a resumable failure the
//     handler re-reads the server-reported `file_offset` and resends only this
//     chunk's unacknowledged tail (CC-MEDIA-2) rather than blind-retrying, up to
//     a small bound. An offset outside the chunk window surfaces as an error for
//     the caller's upload state machine (V05) to reconcile — no silent re-create
//     (CC-MEDIA-3 session-expiry discipline).
//   * Token via header only, never a query param (C3); every token / proof is
//     registered with the `Redactor` before any logging.
//   * Fixed host allowlist + `redirect: 'manual'`: a redirect off the
//     allowlisted host is refused (CC-NET-7), same policy as F07.
//   * Usage headers are parsed defensively on every response (CC-NET-2) and fed
//     to the optional `onUsage` sink; the raw headers ride the envelope.
//
// `planRuploadChunks` (buffered chunking, CC-MEDIA-3) and `parseFileOffset` are
// exported pure helpers the later video state machine (V05) drives rupload with.

import {
  bodyIsGraphErrorEnvelope,
  businessUseCaseEtaMs,
  computeAppSecretProof,
  containPathname,
  extractResponseHeaders,
  createHostSemaphores,
  describeFault,
  graphErrorFromResponse,
  isProvablyNotSent,
  parseRetryAfterMs,
  parseUsageHeaders,
  resolveHostBase,
  type HostSemaphores,
} from './http.js';
import { classifyNetworkError } from './errors.js';
import { GraphApiError } from './types.js';
import type {
  Clock,
  ErrorAction,
  FbRequest,
  FbRequestFn,
  FbResponse,
  FbResponseHeaders,
  Logger,
  MultipartRequest,
  Redactor,
  RuploadRequest,
  Settings,
  UsageSnapshot,
} from './types.js';

// ---------------------------------------------------------------------------
// Public factory surface
// ---------------------------------------------------------------------------

/** Injected dependencies for {@link createUploadHandler} (mirrors F07's shape). */
export interface UploadHandlerDeps {
  readonly settings: Settings;
  readonly clock: Clock;
  readonly redactor: Redactor;
  readonly logger: Logger;
  /**
   * Shared per-host semaphore set. Pass the SAME instance F07's `createFbRequest`
   * uses so JSON + upload traffic honor one concurrency budget per host. Defaults
   * to a fresh set sized by `settings.hostConcurrency`.
   */
  readonly semaphores?: HostSemaphores;
  /** Sink fed the parsed usage snapshot on every response (proactive backoff). */
  readonly onUsage?: (snapshot: UsageSnapshot) => void;
  /**
   * Max in-call rupload resume attempts (offset re-reads + tail resends) before a
   * chunk failure surfaces (default 5). Chunk POSTs bypass the generic retry
   * matrix, so this bound is independent of `RetryConfig`.
   */
  readonly maxResumeAttempts?: number;
}

const DEFAULT_MAX_RESUME_ATTEMPTS = 5;
/** First rupload 5xx resend backoff; doubles per resume up to the cap below. */
const RESEND_BACKOFF_BASE_MS = 500;
/** Cap on the computed (not server-named) resend backoff. */
const RESEND_BACKOFF_CAP_MS = 8_000;
/**
 * Longest server-named wait (`Retry-After`) a chunk POST sleeps through before
 * resending. A longer one surfaces immediately with the wait attached, so the
 * caller schedules the retry instead of this call holding a host slot.
 */
const MAX_RESEND_WAIT_MS = 30_000;

/**
 * Exponential backoff before the `resume`-th (1-based) rupload resend — after a
 * 5xx, a network fault, or a lost response body alike.
 */
function resendBackoffMs(resume: number): number {
  return Math.min(RESEND_BACKOFF_BASE_MS * 2 ** (resume - 1), RESEND_BACKOFF_CAP_MS);
}
const OCTET_STREAM = 'application/octet-stream';

// ---------------------------------------------------------------------------
// Buffered chunking (CC-MEDIA-3) — a pure helper V05 drives rupload with.
// ---------------------------------------------------------------------------

/** One planned rupload chunk: its `file_offset`, its bytes, and its position. */
export interface RuploadChunkPlan {
  /** Byte offset in the source buffer this chunk begins at (its `file_offset`). */
  readonly fileOffset: number;
  /** The chunk bytes — a zero-copy view into the source buffer. */
  readonly chunk: Uint8Array;
  /** Zero-based chunk index. */
  readonly index: number;
  /** `true` for the final chunk (reaches the end of the buffer). */
  readonly isLast: boolean;
}

/**
 * Split `data` into fixed-size chunks with correct offset arithmetic (CC-MEDIA-3
 * buffered chunking): chunk `i` covers `[i*chunkSize, min((i+1)*chunkSize, len))`
 * and its `fileOffset` is `i*chunkSize`. The last chunk carries the remainder;
 * an empty buffer yields no chunks. Views are zero-copy (`subarray`), so the
 * caller must not mutate `data` while uploading.
 */
export function planRuploadChunks(
  data: Uint8Array,
  chunkSize: number,
): RuploadChunkPlan[] {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(
      `planRuploadChunks: chunkSize must be a positive integer (got ${String(chunkSize)})`,
    );
  }
  const plans: RuploadChunkPlan[] = [];
  const total = data.byteLength;
  let offset = 0;
  let index = 0;
  while (offset < total) {
    const end = Math.min(offset + chunkSize, total);
    plans.push({
      fileOffset: offset,
      chunk: data.subarray(offset, end),
      index,
      isLast: end === total,
    });
    offset = end;
    index += 1;
  }
  return plans;
}

// ---------------------------------------------------------------------------
// Server-offset parsing (CC-MEDIA-2) — pure, reused by V05 to resume.
// ---------------------------------------------------------------------------

const OFFSET_HEADER_KEYS = ['file_offset', 'offset', 'upload-offset'] as const;
const OFFSET_BODY_KEYS = ['file_offset', 'offset', 'start_offset'] as const;

/**
 * An offset is an exact byte position: a non-negative SAFE integer, and on the
 * wire a plain run of decimal digits. `Number()` alone is far looser — it reads
 * `0x4`, `1e1`, `+4`, `4.0` and `0b100` as integers, and rounds digits past 2^53
 * to a neighbouring value — so each of those would become a resume point the
 * server never named, and the tail resent from it would be the wrong bytes.
 * Anything else is "no offset", which routes the caller to the probe instead.
 */
function toOffset(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined;
  }
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!/^\d+$/.test(text)) return undefined;
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Read the server-reported resume offset from a rupload response, defensively.
 * Tries the `file_offset` / `offset` / `upload-offset` response headers first,
 * then the JSON body (`{file_offset}` / `{offset}` / `{start_offset}`); returns
 * `undefined` when no valid non-negative integer offset is present. Exported so
 * V05's upload state machine reads offsets through one parser.
 */
export function parseFileOffset(
  headers: FbResponseHeaders,
  bodyText?: string,
): number | undefined {
  for (const key of OFFSET_HEADER_KEYS) {
    const value = toOffset(headers[key]);
    if (value !== undefined) return value;
  }
  if (bodyText !== undefined && bodyText.length > 0) {
    const rec = asRecord(safeJsonParse(bodyText));
    if (rec) {
      for (const key of OFFSET_BODY_KEYS) {
        const value = toOffset(rec[key]);
        if (value !== undefined) return value;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// URL / body helpers (mirror F07's private buildUrl; no query — uploads header-auth)
// ---------------------------------------------------------------------------

/**
 * Reject absolute / protocol-relative paths so a crafted `path` cannot redirect
 * off the allowlisted host (CC-NET-7), and normalise to a leading slash.
 */
function assertRelativeUploadPath(path: string): string {
  if (path.includes('://') || path.startsWith('//')) {
    throw new Error(
      `fbRequest(upload): path must be a relative edge path, not an absolute URL ('${path}')`,
    );
  }
  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * Pin an already-validated pathname onto a trusted hostname. Uploads carry no
 * query string — auth is header-based (C3).
 *
 * Every segment is contained by {@link containPathname}: an upload path
 * interpolates ids the model supplies (`/{video-id}`, `/{page-id}/photos`) just
 * like a Graph edge does, so a `..` segment would otherwise retarget the request
 * at a different edge on the same allowlisted host.
 */
function finalizeUploadUrl(hostname: string, pathname: string): string {
  const url = new URL(`https://${hostname}`);
  url.pathname = containPathname(pathname, 'fbRequest(upload)');
  if (url.hostname !== hostname || url.protocol !== 'https:') {
    throw new Error(
      `fbRequest(upload): refusing off-allowlist URL for host '${hostname}'`,
    );
  }
  return url.toString();
}

/**
 * Graph edge paths carry the API version as their FIRST segment
 * (`/v25.0/{page-id}/photos`), so it is prepended unless the caller already
 * supplied one. Multipart only — see {@link buildRuploadUrl}.
 */
function buildMultipartUrl(hostname: string, path: string, apiVersion: string): string {
  const pathname = assertRelativeUploadPath(path);
  return finalizeUploadUrl(
    hostname,
    /^\/v\d+(?:\.\d+)?(?:\/|$)/.test(pathname) ? pathname : `/${apiVersion}${pathname}`,
  );
}

/**
 * The rupload host does NOT use the Graph layout: its paths are
 * `/{api-name}/{version}/{id}` — the version is the SECOND segment
 * (`/video-upload/v25.0/{video-id}`). Prepending a version here, as the Graph
 * builder does, would emit `/v25.0/video-upload/v25.0/{video-id}`, a URL Meta
 * never documented. The caller's path is therefore authoritative: the `api`
 * layer owns the rupload layout, either verbatim from Meta's `upload_url`
 * (Reels) or composed from the api-name plus the configured version. Core only
 * validates it.
 */
function buildRuploadUrl(hostname: string, path: string): string {
  return finalizeUploadUrl(hostname, assertRelativeUploadPath(path));
}

function resolveUploadToken(
  req: MultipartRequest | RuploadRequest,
  settings: Settings,
): string {
  const token =
    req.token ?? settings.systemToken ?? settings.accessToken ?? settings.pageToken;
  if (token === undefined || token.length === 0) {
    throw new Error(
      'fbRequest(upload): no access token available (set req.token or FB_SYSTEM_TOKEN / FB_ACCESS_TOKEN / FB_PAGE_TOKEN)',
    );
  }
  return token;
}

function parseBody(text: string): unknown {
  return text.length === 0 ? undefined : (safeJsonParse(text) ?? text);
}

// ---------------------------------------------------------------------------
// Error construction (F07's ambiguousError / networkError are private — mirror them)
// ---------------------------------------------------------------------------

/** A one-shot write with an unknown outcome (C2): NEVER auto-retried; verify first. */
function ambiguousUploadError(
  status: number,
  detail: string,
  redactor: Redactor,
  cause: unknown,
  verifyTool: string | undefined,
): GraphApiError {
  const action: ErrorAction = {
    category: 'ambiguous',
    retryable: false,
    operatorText:
      verifyTool !== undefined
        ? `unknown outcome — the write may have landed; do NOT retry, verify via ${verifyTool} first`
        : 'unknown outcome — the write may have landed; do NOT retry, re-read the upload target (or the listing it belongs to) first',
    ...(verifyTool !== undefined ? { nextTool: verifyTool } : {}),
  };
  return new GraphApiError(
    redactor.redactString(
      `ambiguous upload outcome (${detail}) — do NOT retry; verify first`,
    ),
    { code: 0, httpStatus: status, action, cause },
  );
}

/** A retryable transient fault the caller (not this handler) decides to re-drive. */
function transientUploadError(
  status: number,
  detail: string,
  redactor: Redactor,
  cause?: unknown,
): GraphApiError {
  const action: ErrorAction = {
    category: 'transient',
    retryable: true,
    operatorText:
      'transient upload fault — safe to re-drive the upload from the server offset',
  };
  return new GraphApiError(redactor.redactString(`rupload transient fault (${detail})`), {
    code: 0,
    httpStatus: status,
    action,
    cause,
  });
}

/** A resume offset that fell outside the current chunk — the caller must restart. */
function restartUploadError(detail: string, redactor: Redactor): GraphApiError {
  const action: ErrorAction = {
    category: 'validation',
    retryable: false,
    operatorText:
      'upload session desynced — restart the upload (do not re-create silently)',
  };
  return new GraphApiError(redactor.redactString(`rupload cannot resume (${detail})`), {
    code: 0,
    httpStatus: 0,
    action,
  });
}

/**
 * The connect-phase code on a fetch rejection when it provably never reached the
 * wire, else `undefined`. The verdict is {@link isProvablyNotSent}, shared with
 * the JSON client so both transports read one fault the same way: the error's
 * OWN string code decides, and its `cause` is consulted only when it has none.
 * A rejection whose own code is a mid-flight reset (`ECONNRESET`) is therefore
 * ambiguous even when a stale `cause` names a connect-phase code — it was the
 * reset the caller saw, and the write may have landed. The code string is read
 * with the same precedence, only to name the fault in the message.
 */
function connectPhaseCode(err: unknown): string | undefined {
  if (!isProvablyNotSent(err)) return undefined;
  const rec = asRecord(err);
  const own = rec?.['code'];
  if (typeof own === 'string') return own;
  const viaCause = asRecord(rec?.['cause'])?.['code'];
  return typeof viaCause === 'string' ? viaCause : undefined;
}

/**
 * A multipart POST that provably never left this machine (DNS / connect
 * failure). It is NOT the C2 ambiguous write: no byte reached Meta, so nothing
 * can have landed, and "verify first" would send the operator hunting for a
 * photo that does not exist (and make the api layer report a possible orphan).
 * Classified the way F07 classifies the same fault on a JSON write — a
 * retryable transient with the proxy self-diagnosis hint (CC-NET-6).
 */
function notSentUploadError(
  code: string,
  err: unknown,
  redactor: Redactor,
): GraphApiError {
  const detail = `${code}: ${describeFault(err)}`;
  return new GraphApiError(
    redactor.redactString(`multipart upload never sent (connect-phase fault ${detail})`),
    {
      code: 0,
      httpStatus: 0,
      action: classifyNetworkError({
        phase: 'connect',
        isWrite: true,
        reason: redactor.redactString(detail),
      }),
      cause: err,
    },
  );
}

/**
 * The terminal error for an upload response, carrying the wait the server asked
 * for. `graphErrorFromResponse` alone knows only the envelope (a throttle ETA or
 * the matrix default), so a `Retry-After` header — the one instruction on a 429
 * or a 503 that says when to come back — was dropped, and a caller holding an
 * hour-long block was told to return in a minute. A business-use-case throttle's
 * regain-access ETA (its usage header) is dropped the same way and is read here
 * too. Attached only to a retryable verdict, and only when it is the longer
 * wait (RFC 9110: a minimum).
 */
function uploadErrorFromResponse(
  status: number,
  bodyText: string,
  headers: FbResponseHeaders,
  nowMs: number,
  redactor: Redactor,
): GraphApiError {
  const err = graphErrorFromResponse(status, bodyText, redactor);
  const action = err.action;
  const retryAfterMs = parseRetryAfterMs(headers['retry-after'], nowMs);
  // A business-use-case throttle names its wait in the usage header instead
  // of the envelope; the longer of the two header waits is the one to surface.
  const bucEtaMs = businessUseCaseEtaMs(err.code, headers);
  const headerMs =
    retryAfterMs === undefined || bucEtaMs === undefined
      ? (retryAfterMs ?? bucEtaMs)
      : Math.max(retryAfterMs, bucEtaMs);
  if (action === undefined || !action.retryable || headerMs === undefined) return err;
  if (action.retryAfterMs !== undefined && action.retryAfterMs >= headerMs) return err;
  return graphErrorFromResponse(status, bodyText, redactor, {
    category: action.category,
    retryAfterMs: headerMs,
  });
}

function offAllowlistError(host: string, status: number): GraphApiError {
  const action: ErrorAction = {
    category: 'unknown',
    retryable: false,
    operatorText: 'redirect off the allowlisted host refused (host allowlist)',
  };
  return new GraphApiError(
    `fbRequest(upload): refusing redirect (HTTP ${status}) off host '${host}'`,
    { code: 0, httpStatus: status, action },
  );
}

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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the {@link FbRequestFn} covering the `multipart` and `rupload`
 * protocols. Wire it into F07 as `createFbRequest({ ..., uploadHandler:
 * createUploadHandler({ ..., semaphores }) })`, passing the same `semaphores`
 * instance to both so uploads and JSON traffic share one per-host budget. A
 * `json` request is rejected here — that is F07's protocol.
 */
export function createUploadHandler(deps: UploadHandlerDeps): FbRequestFn {
  const { settings, clock, redactor, logger } = deps;
  const semaphores = deps.semaphores ?? createHostSemaphores(settings.hostConcurrency);
  const maxResumeAttempts = deps.maxResumeAttempts ?? DEFAULT_MAX_RESUME_ATTEMPTS;

  const feedUsage = (headers: FbResponseHeaders): void => {
    if (deps.onUsage === undefined) return;
    try {
      deps.onUsage(parseUsageHeaders(headers, clock.now()));
    } catch (err) {
      // The sink is ADVISORY — it exists so a caller can back off proactively.
      // A sink that throws must never fail an upload whose bytes are already on
      // Meta's side, and must never be reported as the transport fault it is
      // not: inside `probeServerOffset` this call sits within the try that
      // classifies network faults, so an unguarded throw here would surface as
      // a transient "offset probe failed" for a probe that in fact succeeded.
      logger.warn('usage sink threw — the response is unaffected', {
        reason: redactor.redactString(describeFault(err)),
      });
    }
  };

  const doFetch = async (
    url: string,
    method: string,
    headers: Record<string, string>,
    body: RequestInit['body'],
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

  // ---- multipart / form-data -------------------------------------------------

  const multipartRequest = async <T>(req: MultipartRequest): Promise<FbResponse<T>> => {
    const hostname = resolveHostBase(settings.hosts, req.host);
    const token = resolveUploadToken(req, settings);
    const hasSecret = settings.appSecret !== undefined && settings.appSecret.length > 0;
    const proof = hasSecret
      ? computeAppSecretProof(token, settings.appSecret)
      : undefined;

    // Register secrets so any accidental logging downstream scrubs them (C3).
    redactor.addSecret(token);
    if (proof !== undefined) redactor.addSecret(proof);
    if (hasSecret) redactor.addSecret(settings.appSecret);

    const form = new FormData();
    for (const [key, value] of Object.entries(req.fields ?? {})) {
      form.append(key, value);
    }
    // Proof rides as a FORM FIELD so it stays out of any URL (C3), never a query.
    if (proof !== undefined) form.append('appsecret_proof', proof);
    for (const part of req.files) {
      const blob =
        part.contentType !== undefined
          ? new Blob([part.data], { type: part.contentType })
          : new Blob([part.data]);
      // Bare Blob append when no filename, so undici does not stamp a default one.
      if (part.filename !== undefined) {
        form.append(part.name, blob, part.filename);
      } else {
        form.append(part.name, blob);
      }
    }

    const url = buildMultipartUrl(hostname, req.path, settings.apiVersion);
    // Content-Type is intentionally omitted: `fetch` derives the multipart
    // boundary from the FormData body itself.
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    const timeoutMs = req.timeoutMs ?? settings.requestTimeoutMs;

    logger.debug('fbRequest.multipart', {
      host: req.host,
      path: req.path,
      files: req.files.length,
    });

    const release = await semaphores.acquire(req.host);
    try {
      let response: Response;
      try {
        response = await doFetch(url, 'POST', headers, form, timeoutMs, req.signal);
      } catch (err) {
        if (req.signal?.aborted === true) throw err;
        if (err instanceof GraphApiError) throw err;
        const notSent = connectPhaseCode(err);
        if (notSent !== undefined) throw notSentUploadError(notSent, err, redactor);
        // A multipart write whose response is lost is ambiguous (C2): the upload
        // may have landed. Never auto-retried — surface for verify-first.
        throw ambiguousUploadError(
          0,
          `network fault: ${describeFault(err)}`,
          redactor,
          err,
          req.verifyTool,
        );
      }

      const responseHeaders = extractResponseHeaders(response);
      feedUsage(responseHeaders);

      if (isRedirect(response)) {
        await discardBody(response);
        throw offAllowlistError(req.host, response.status);
      }
      // The body is read INSIDE the C2 fault classification, not after it.
      // `fetch` settles on the response HEAD while the body is still arriving
      // over the same connection, so a cut between the two rejects HERE and not
      // from `doFetch` (undici spells it `TypeError: terminated`). Read after the
      // classification, that rejection escaped as a bare `TypeError` on the
      // WORST possible outcome this module has: a 200 whose body was lost means
      // the photo or video IS on the Page and only its id went missing. Every
      // layer above reads an unclassified error as "it did not happen", and the
      // retry that invites uploads it a second time. A lost multipart response
      // is ambiguous whether it was lost before the head or after it.
      let bodyText: string;
      try {
        bodyText = await response.text();
      } catch (err) {
        if (req.signal?.aborted === true) throw err;
        throw ambiguousUploadError(
          response.status,
          `response body lost after HTTP ${response.status}: ${describeFault(err)}`,
          redactor,
          err,
          req.verifyTool,
        );
      }

      // A 2xx whose body is a Graph error envelope is the error, never the
      // data (CC-NET-1, the `http.ts` precedent) — fall through to the
      // terminal `graphErrorFromResponse` below with the REAL status.
      if (response.ok && !bodyIsGraphErrorEnvelope(bodyText)) {
        return {
          data: parseBody(bodyText) as T,
          headers: responseHeaders,
          status: response.status,
        };
      }

      const status = response.status;
      // 5xx on a multipart write is ambiguous (the mutation may have landed, C2);
      // 4xx is a terminal application error. Neither is auto-retried.
      if (status >= 500 && status <= 599) {
        throw ambiguousUploadError(
          status,
          `HTTP ${status} on multipart POST`,
          redactor,
          bodyText,
          req.verifyTool,
        );
      }
      const err = uploadErrorFromResponse(
        status,
        bodyText,
        responseHeaders,
        clock.now(),
        redactor,
      );
      if (err.action?.category === 'transient') {
        // Code 1/2 (or `is_transient`) is Graph's own server-side fault at a
        // 4xx or 2xx status: on a one-shot write it is as ambiguous as a 5xx,
        // so the matrix's `retryable: true` must not invite a duplicate (C2).
        throw ambiguousUploadError(
          status,
          `HTTP ${status}, transient Graph code on multipart POST`,
          redactor,
          bodyText,
          req.verifyTool,
        );
      }
      throw err;
    } finally {
      release();
    }
  };

  // ---- rupload / raw-binary chunk (offset-resume, CC-MEDIA-2) -----------------

  const ruploadRequest = async <T>(req: RuploadRequest): Promise<FbResponse<T>> => {
    const hostname = resolveHostBase(settings.hosts, req.host);
    const token = resolveUploadToken(req, settings);
    redactor.addSecret(token);
    // No `appsecret_proof` here, deliberately — this is NOT an oversight, and the
    // asymmetry with `multipartRequest` above is by design. rupload is not a
    // Graph edge: Meta documents it as `Authorization: OAuth <token>` plus offset
    // headers on a raw-binary body, with no proof parameter (see
    // docs/reviews/01-software-architect.md §4). There is nowhere to put one that
    // Meta reads — the body is the file bytes, and a query param both fails to
    // apply and violates C3's keep-credentials-out-of-URLs rule. The `graph` and
    // `graph-video` hosts, which do read it, attach it on every call.

    const url = buildRuploadUrl(hostname, req.path);
    const timeoutMs = req.timeoutMs ?? settings.requestTimeoutMs;
    const chunkStart = req.fileOffset;
    const chunkEnd = chunkStart + req.chunk.byteLength;

    const buildHeaders = (offset: number): Record<string, string> => {
      const headers: Record<string, string> = { 'content-type': OCTET_STREAM };
      for (const [key, value] of Object.entries(req.headers ?? {})) {
        headers[key.toLowerCase()] = value;
      }
      // Auth invariants win over any caller header: OAuth (NOT Bearer) + offset.
      headers['authorization'] = `OAuth ${token}`;
      headers['file_offset'] = String(offset);
      return headers;
    };

    // Ask the server where it is (used when a failed response carries no offset).
    //
    // The probe is itself a network call and fails like one — a DNS blip, a
    // timeout, a mid-flight reset. Unclassified, that rejection escapes the
    // handler as a bare `TypeError`, and every layer above reads it as an
    // unknown failure: no category, no retry verdict, no operator text. It is
    // the same transport fault that sent us here, so it is classified the same
    // way — an abort and an already-classified error still pass through.
    //
    // A probe that ANSWERS can still be a refusal, and its STATUS is the only
    // thing that tells the two apart. A 401/403/400 body carries no
    // `file_offset` for the same trivial reason an empty 200 carries none, so
    // parsing one without reading the status collapses "your token was revoked
    // mid-upload" onto `undefined` — which `tailFrom` then reports as the
    // retryable `server offset unavailable to resume`. That launders a
    // PERMANENT auth failure into a transient one: the caller re-drives a
    // resume that cannot ever succeed, and the operator is told the server lost
    // its place instead of that their credential is gone. Every non-2xx is
    // therefore surfaced as the error it actually is — and so is a 2xx whose
    // body is a strict Graph envelope (CC-NET-1) — through the same
    // `graphErrorFromResponse` the terminal chunk failure uses — the F06 matrix
    // decides auth/permission/validation (permanent) against throttle/5xx
    // (retryable), and the redacted Graph message names the cause, since Graph
    // quotes the credential back in its own error text (C3). A 3xx is the
    // CC-NET-7 refusal the chunk POST gives it, never an offset source; its
    // body is consumed so the socket is released rather than pinned.
    //
    // The surfaced Graph error names the cause but not the call it came from —
    // the probe is invisible to every layer above — so the refusal is logged
    // here with the status that produced it.
    const probeServerOffset = async (): Promise<number | undefined> => {
      try {
        const probe = await doFetch(
          url,
          'GET',
          { authorization: `OAuth ${token}` },
          undefined,
          timeoutMs,
          req.signal,
        );
        const probeHeaders = extractResponseHeaders(probe);
        feedUsage(probeHeaders);
        if (isRedirect(probe)) {
          await discardBody(probe);
          throw offAllowlistError(req.host, probe.status);
        }
        const text = await probe.text();
        // A 2xx carrying a strict Graph error envelope is a refusal too
        // (CC-NET-1): the status lies and the body is the verdict, exactly as
        // the chunk POST reads it. Parsed only for an offset, that envelope
        // would yield none and the caller would be handed the retryable
        // `server offset unavailable to resume` — a revoked token laundered
        // into a resume that can never succeed.
        if (!probe.ok || bodyIsGraphErrorEnvelope(text)) {
          logger.warn('fbRequest.rupload.probe', {
            host: req.host,
            path: req.path,
            status: probe.status,
          });
          throw uploadErrorFromResponse(
            probe.status,
            text,
            probeHeaders,
            clock.now(),
            redactor,
          );
        }
        return parseFileOffset(probeHeaders, text);
      } catch (err) {
        if (req.signal?.aborted === true) throw err;
        if (err instanceof GraphApiError) throw err;
        throw transientUploadError(
          0,
          `offset probe failed: ${describeFault(err)}`,
          redactor,
          err,
        );
      }
    };

    // Map a server offset to the unacknowledged tail of THIS chunk, or refuse.
    const tailFrom = (
      serverOffset: number | undefined,
    ): { offset: number; body: Uint8Array } => {
      if (serverOffset === undefined) {
        throw transientUploadError(0, 'server offset unavailable to resume', redactor);
      }
      // `chunkEnd` is the most likely offset to see here, not an error: the
      // server took every byte and the fault hit on the way back. There is no
      // tail left to resend, so this is not a desync — treating it as one throws
      // away a chunk the server already holds (for a large video, a very
      // expensive restart of an upload that was in fact complete). It is a
      // transient fault: the api layer re-reads the server offset, sees this
      // window closed, and moves to the next one (CC-MEDIA-2).
      if (serverOffset === chunkEnd) {
        throw transientUploadError(
          0,
          `server acknowledged the whole chunk (offset ${serverOffset}) — nothing left to resend`,
          redactor,
        );
      }
      if (serverOffset < chunkStart || serverOffset > chunkEnd) {
        throw restartUploadError(
          `server offset ${serverOffset} outside chunk window [${chunkStart}, ${chunkEnd}]`,
          redactor,
        );
      }
      return {
        offset: serverOffset,
        body: req.chunk.subarray(serverOffset - chunkStart),
      };
    };

    // Resume after a transport fault (a lost POST or a lost response body):
    // wait the same growing backoff the 5xx branch uses, THEN probe, so the
    // offset read is the settled one. Resent back-to-back, a flapping link
    // burns the whole resume budget in milliseconds and never outlasts a blip.
    // No `Retry-After` exists here — there was no response to name one. An
    // abort during the wait rejects with the signal's AbortError, unwrapped.
    const pacedProbeResume = async (
      resume: number,
    ): Promise<{ offset: number; body: Uint8Array }> => {
      await clock.sleep(resendBackoffMs(resume), req.signal);
      return tailFrom(await probeServerOffset());
    };

    logger.debug('fbRequest.rupload', {
      host: req.host,
      path: req.path,
      fileOffset: req.fileOffset,
      chunkBytes: req.chunk.byteLength,
    });

    const release = await semaphores.acquire(req.host);
    try {
      let offset = chunkStart;
      let body: Uint8Array = req.chunk;
      let resumes = 0;
      for (;;) {
        let response: Response;
        try {
          response = await doFetch(
            url,
            'POST',
            buildHeaders(offset),
            body,
            timeoutMs,
            req.signal,
          );
        } catch (err) {
          if (req.signal?.aborted === true) throw err;
          if (err instanceof GraphApiError) throw err;
          // Network fault: a chunk is offset-idempotent, so re-read the server
          // offset and resend the tail rather than blind-retrying (CC-MEDIA-2).
          if (resumes >= maxResumeAttempts) {
            throw transientUploadError(
              0,
              `network fault: ${describeFault(err)}`,
              redactor,
              err,
            );
          }
          resumes += 1;
          const resumed = await pacedProbeResume(resumes);
          offset = resumed.offset;
          body = resumed.body;
          logger.warn('fbRequest.rupload.resume', {
            host: req.host,
            path: req.path,
            reason: 'network',
            offset,
            resumes,
          });
          continue;
        }

        const responseHeaders = extractResponseHeaders(response);
        feedUsage(responseHeaders);

        if (isRedirect(response)) {
          await discardBody(response);
          throw offAllowlistError(req.host, response.status);
        }
        // The body is read INSIDE the resume handling, not after it. `fetch`
        // settles on the response HEAD while the body is still arriving over the
        // same connection, so a cut between the two rejects HERE rather than
        // from `doFetch` — and on a multi-megabyte video that window is wide.
        // Read after the resume handling, that rejection escaped as a bare
        // `TypeError`: an unclassified crash that abandons an upload session the
        // server is still holding bytes for. A chunk is offset-idempotent, so
        // this is the same resumable transport fault as a mid-flight reset and
        // it takes the same route — ask the server where it actually is, then
        // resend only the unacknowledged tail (CC-MEDIA-2). When the server
        // reports the whole chunk (the likely answer after a 200), `tailFrom`
        // says so as a classified transient and the caller moves to the next
        // window instead of restarting.
        let bodyText: string;
        try {
          bodyText = await response.text();
        } catch (err) {
          if (req.signal?.aborted === true) throw err;
          if (resumes >= maxResumeAttempts) {
            throw transientUploadError(
              0,
              `response body lost after HTTP ${response.status}: ${describeFault(err)}`,
              redactor,
              err,
            );
          }
          resumes += 1;
          const resumed = await pacedProbeResume(resumes);
          offset = resumed.offset;
          body = resumed.body;
          logger.warn('fbRequest.rupload.resume', {
            host: req.host,
            path: req.path,
            reason: 'body',
            offset,
            resumes,
          });
          continue;
        }

        // Same rule as multipart: an envelope inside a 2xx is a refused chunk,
        // not a landed one (CC-NET-1).
        if (response.ok && !bodyIsGraphErrorEnvelope(bodyText)) {
          return {
            data: parseBody(bodyText) as T,
            headers: responseHeaders,
            status: response.status,
          };
        }

        const status = response.status;
        // Chunk POSTs bypass the generic throttle/5xx retry matrix. A 5xx is a
        // resumable transport fault: re-read the offset and resend the tail.
        //
        // The resend is PACED. Fired back-to-back, the whole resume budget burns
        // in milliseconds, so a 503 that clears in a second or two is never
        // outlasted and the server is hammered with the same bytes meanwhile.
        // Each resend waits a growing backoff, or the server's `Retry-After`
        // when it names a longer one (RFC 9110: a minimum). A named wait beyond
        // what one chunk POST may reasonably hold a host slot for surfaces at
        // once, carrying that wait, instead of being slept through or ignored.
        const retryAfterMs = parseRetryAfterMs(
          responseHeaders['retry-after'],
          clock.now(),
        );
        const withinWaitCap =
          retryAfterMs === undefined || retryAfterMs <= MAX_RESEND_WAIT_MS;
        if (
          status >= 500 &&
          status <= 599 &&
          resumes < maxResumeAttempts &&
          withinWaitCap
        ) {
          resumes += 1;
          const waitMs = Math.max(retryAfterMs ?? 0, resendBackoffMs(resumes));
          const headerOffset = parseFileOffset(responseHeaders, bodyText);
          let resumed: { offset: number; body: Uint8Array };
          if (headerOffset !== undefined) {
            // A desynced offset fails fast — no point waiting to refuse.
            resumed = tailFrom(headerOffset);
            await clock.sleep(waitMs, req.signal);
          } else {
            // Probe AFTER the wait, so the offset read is the settled one.
            await clock.sleep(waitMs, req.signal);
            resumed = tailFrom(await probeServerOffset());
          }
          offset = resumed.offset;
          body = resumed.body;
          logger.warn('fbRequest.rupload.resume', {
            host: req.host,
            path: req.path,
            reason: 'http-5xx',
            status,
            offset,
            resumes,
          });
          continue;
        }
        // Terminal application error (4xx incl. throttle), or resume bound hit.
        throw uploadErrorFromResponse(
          status,
          bodyText,
          responseHeaders,
          clock.now(),
          redactor,
        );
      }
    } finally {
      release();
    }
  };

  const uploadHandler: FbRequestFn = <T = unknown>(
    req: FbRequest,
  ): Promise<FbResponse<T>> => {
    switch (req.protocol) {
      case 'multipart':
        return multipartRequest<T>(req);
      case 'rupload':
        return ruploadRequest<T>(req);
      case 'json':
        return Promise.reject(
          new Error(
            "fbRequest(upload): protocol 'json' is handled by core/http.ts (F07), not the upload handler",
          ),
        );
    }
  };

  return uploadHandler;
}
