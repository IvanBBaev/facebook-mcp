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
  computeAppSecretProof,
  containPathname,
  extractResponseHeaders,
  createHostSemaphores,
  graphErrorFromResponse,
  parseUsageHeaders,
  resolveHostBase,
  type HostSemaphores,
} from './http.js';
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

function toOffset(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 0 ? raw : undefined;
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
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

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown error';
}

// ---------------------------------------------------------------------------
// Error construction (F07's ambiguousError / networkError are private — mirror them)
// ---------------------------------------------------------------------------

/** A one-shot write with an unknown outcome (C2): NEVER auto-retried; verify first. */
function ambiguousUploadError(
  status: number,
  detail: string,
  redactor: Redactor,
  cause?: unknown,
): GraphApiError {
  const action: ErrorAction = {
    category: 'ambiguous',
    retryable: false,
    operatorText:
      'unknown outcome — the write may have landed; do NOT retry, verify first (e.g. facebook_list_posts)',
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
    if (deps.onUsage !== undefined) {
      deps.onUsage(parseUsageHeaders(headers, clock.now()));
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
        // A multipart write whose response is lost is ambiguous (C2): the upload
        // may have landed. Never auto-retried — surface for verify-first.
        throw ambiguousUploadError(
          0,
          `network fault: ${errorMessage(err)}`,
          redactor,
          err,
        );
      }

      const responseHeaders = extractResponseHeaders(response);
      feedUsage(responseHeaders);

      if (isRedirect(response)) {
        throw offAllowlistError(req.host, response.status);
      }
      if (response.ok) {
        const text = await response.text();
        return {
          data: parseBody(text) as T,
          headers: responseHeaders,
          status: response.status,
        };
      }

      const status = response.status;
      const bodyText = await response.text();
      // 5xx on a multipart write is ambiguous (the mutation may have landed, C2);
      // 4xx is a terminal application error. Neither is auto-retried.
      if (status >= 500 && status <= 599) {
        throw ambiguousUploadError(
          status,
          `HTTP ${status} on multipart POST`,
          redactor,
          bodyText,
        );
      }
      throw graphErrorFromResponse(status, bodyText, redactor);
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
        const text = await probe.text();
        return parseFileOffset(probeHeaders, text);
      } catch (err) {
        if (req.signal?.aborted === true) throw err;
        if (err instanceof GraphApiError) throw err;
        throw transientUploadError(
          0,
          `offset probe failed: ${errorMessage(err)}`,
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
              `network fault: ${errorMessage(err)}`,
              redactor,
              err,
            );
          }
          resumes += 1;
          const resumed = tailFrom(await probeServerOffset());
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
          throw offAllowlistError(req.host, response.status);
        }
        if (response.ok) {
          const text = await response.text();
          return {
            data: parseBody(text) as T,
            headers: responseHeaders,
            status: response.status,
          };
        }

        const status = response.status;
        const bodyText = await response.text();
        // Chunk POSTs bypass the generic throttle/5xx retry matrix. A 5xx is a
        // resumable transport fault: re-read the offset and resend the tail.
        if (status >= 500 && status <= 599 && resumes < maxResumeAttempts) {
          resumes += 1;
          const serverOffset =
            parseFileOffset(responseHeaders, bodyText) ?? (await probeServerOffset());
          const resumed = tailFrom(serverOffset);
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
        throw graphErrorFromResponse(status, bodyText, redactor);
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
