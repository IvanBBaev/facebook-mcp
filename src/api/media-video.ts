// Resumable video upload for Page videos (task V05, `api` layer).
//
// A three-phase state machine over the Graph video edge, driven entirely through
// an injected `FbRequestFn` + `Clock`. It owns no HTTP, no ambient context and no
// knowledge of MCP — the tools layer maps `onProgress` onto a progress token and
// shapes the result (CC-MCP-1); this module only reports numbers.
//
//   start     POST /{page-id}/videos  `upload_phase=start`  -> `upload_session_id`,
//             `video_id` and the FIRST byte window the server asks for
//   transfer  POST /video-upload/{version}/{upload-session-id} on the rupload
//             host — raw binary chunk bodies, each carrying its own
//             `file_offset`, until the server-declared window closes
//   finish    POST /{page-id}/videos  `upload_phase=finish` -> the video id
//
// Design decisions (justified against the corpus):
//   * PROTOCOL SHAPE. `start`/`finish` are ordinary form POSTs on the legacy video
//     edge (`graph-video`), while the bytes ride the raw-binary rupload protocol
//     (`RuploadRequest`) so chunk transfer reuses F08's offset-resume transport
//     instead of a second chunker. ✎ verify: doc 03 also documents the modern
//     Resumable Upload API (`POST /{app-id}/uploads` -> chunked -> a
//     `fbuploader_video_file_chunk` handle passed to the publish call). The two
//     differ only in WHERE the session is created; the state machine below is
//     identical, so switching is a change to `startVideoUpload`'s request only.
//   * SERVER-AUTHORITATIVE OFFSETS (CC-MEDIA-2). The next chunk is always the
//     window the SERVER last declared (`start_offset`/`end_offset`), never a
//     client-side running count. A transient chunk failure therefore does not
//     restart the upload and does not replay a chunk: it re-reads the current
//     offset from the server (the status probe's `bytes_transferred`) and
//     continues from there. Chunks are offset-idempotent, so a re-sent chunk is
//     harmless if the fault happened after the write landed.
//   * BOUNDED AND ALWAYS TERMINATING. One resume counter spans the whole
//     transfer and never resets. Every loop iteration either strictly advances
//     the server-confirmed offset or consumes one resume attempt, so a server
//     that keeps answering with the same offset cannot spin the loop — it exhausts
//     the budget and fails loudly.
//   * NO SILENT RE-CREATE (CC-MEDIA-3). A lost or desynced session surfaces as a
//     "restart the upload" error. Re-creating a session behind the caller's back
//     would risk a duplicate video, so it is never done here.
//   * SESSIONS ARE PROCESS-LOCAL (CC-MEDIA-1). The registry is an in-memory Map
//     created per factory call — no module-level mutable state, nothing survives a
//     restart, and nothing is persisted to disk. A server restart mid-upload means
//     the upload must be restarted, and the note says so.
//   * TIME IS INJECTED. Every timestamp and every backoff wait reads the injected
//     `Clock`; `Date.now()` is never called, so TTL eviction is testable.
//   * FINISHED != PUBLISHED (CC-MEDIA-3/-7). `finish` returns a video id, not a
//     playable video. Results carry an explicit note and `getVideoStatus` maps the
//     `status` object onto a small discriminated union so a caller can poll
//     instead of assuming success.

import { GraphApiError, parseFileOffset, planRuploadChunks } from '../core/index.js';
import type {
  Clock,
  ErrorAction,
  FbResponse,
  FbRequestFn,
  GraphHost,
  JsonRequest,
  Logger,
  RuploadChunkPlan,
  RuploadRequest,
  Settings,
} from '../core/index.js';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Default chunk size (4 MiB) — small enough to resume cheaply, large enough to be efficient. */
export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;

/** Floor for a caller-supplied chunk size (64 KiB); smaller means pathological round-trip counts. */
export const MIN_CHUNK_SIZE = 64 * 1024;

/** Ceiling for a caller-supplied chunk size (64 MiB); larger means a single failure costs too much. */
export const MAX_CHUNK_SIZE = 64 * 1024 * 1024;

/**
 * Default bound on resume attempts for ONE transfer (not per chunk). Mirrors
 * F08's `DEFAULT_MAX_RESUME_ATTEMPTS` intent: enough to ride out a blip, few
 * enough that a broken session fails fast instead of hammering the edge.
 */
export const DEFAULT_MAX_RESUME_ATTEMPTS = 4;

/** Base wait before a resume attempt; scaled linearly by the attempt number. */
export const DEFAULT_RESUME_BACKOFF_MS = 250;

/**
 * How long an untouched upload session is kept before eviction (1 hour).
 * Eviction is keyed on the LAST ACTIVITY timestamp, which starts equal to
 * `createdAt` — so a session nobody touches disappears exactly `ttlMs` after
 * creation (the documented TTL), while a large in-flight upload is not evicted
 * out from under its own state machine. ✎ verify empirically: Graph's real
 * server-side session lifetime is undocumented; when it expires first, the
 * transfer surfaces {@link SESSION_DESYNC_NOTE} from the edge instead (CC-MEDIA-3).
 */
export const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;

/** Model-facing note when the in-process session is gone (restart, TTL, wrong id) — CC-MEDIA-1. */
export const SESSION_LOST_NOTE = 'upload session lost — restart the upload';

/** Model-facing note when client and server disagree about the session/offsets — CC-MEDIA-3. */
export const SESSION_DESYNC_NOTE =
  'upload session desynced — restart the upload (do not re-create silently)';

/** Model-facing note attached to every successful create: created is not ready — CC-MEDIA-7. */
export const CREATED_NOT_READY_NOTE =
  'video created but not necessarily ready — poll the video status before treating it as published';

/** `fields` value for the status probe. Kept minimal: the status object only. */
export const VIDEO_STATUS_FIELDS = 'status';

/** Model-facing note per mapped status kind (UX #7: every terminal state says what to do next). */
export const STATUS_NOTES = {
  uploading: 'upload still in progress — bytes are still being transferred',
  processing: 'video is still processing — not playable yet; poll again',
  ready: 'video is ready — check the publishing phase for whether it is live',
  error: 'video upload/processing failed — read the error before re-uploading',
  unknown: 'video status unavailable or unrecognized — poll again',
} as const;

// Hosts are fixed per phase (C7 host allowlist): the legacy video edge creates and
// finalizes the session, the rupload edge takes the bytes, and status reads go to
// the ordinary graph edge like any other node read.
const VIDEO_EDGE_HOST: GraphHost = 'graph-video';
const RUPLOAD_HOST: GraphHost = 'rupload';
const STATUS_HOST: GraphHost = 'graph';

/** First path segment of the rupload target for video, per Meta's upload URL. */
export const VIDEO_UPLOAD_PATH_PREFIX = 'video-upload';

/**
 * Build the rupload path for a transfer chunk.
 *
 * The rupload host does not use the Graph layout: its paths are
 * `/{api-name}/{version}/{id}`, so the version is the SECOND segment. Core
 * validates this path but deliberately never injects a version into it (doing so
 * would emit `/{version}/video-upload/{version}/{id}`), which is why the version
 * has to be composed here.
 */
export function ruploadPathForSession(
  uploadSessionId: string,
  apiVersion: string,
): string {
  return `/${VIDEO_UPLOAD_PATH_PREFIX}/${apiVersion}/${uploadSessionId}`;
}

// ---------------------------------------------------------------------------
// Public types — session registry
// ---------------------------------------------------------------------------

/** Where an upload session currently is. `transferred` = all bytes in, `finish` not yet called. */
export type VideoUploadPhase =
  'started' | 'transferring' | 'transferred' | 'finished' | 'failed';

/**
 * Progress sink: `sent` is the byte count the SERVER has confirmed, `total` the
 * file size. Called once per accepted chunk. Deliberately a bare callback — the
 * `api` layer must not know that a progress token exists (CC-MCP-1).
 */
export type UploadProgress = (sent: number, total: number) => void;

/** One in-flight (or just-finished) resumable upload. Immutable snapshot. */
export interface VideoUploadSession {
  readonly uploadSessionId: string;
  readonly pageId: string;
  /** Known as soon as `start` returns it; confirmed again by `finish`. */
  readonly videoId?: string;
  readonly totalBytes: number;
  /** Server-confirmed `start_offset` — also the number of bytes transferred so far. */
  readonly startOffset: number;
  /** Server-declared `end_offset` for the NEXT chunk (exclusive upper bound). */
  readonly endOffset: number;
  readonly chunkSize: number;
  readonly phase: VideoUploadPhase;
  /** Resume attempts consumed so far by this session. */
  readonly resumes: number;
  /** Creation time, from the injected clock. */
  readonly createdAt: number;
  /** Last-activity time, from the injected clock; drives TTL eviction. */
  readonly updatedAt: number;
  /** Last failure message seen, for progress/diagnostic reporting. */
  readonly lastError?: string;
}

/** Fields needed to register a session; offsets default to the start of the file. */
export interface UploadSessionInit {
  readonly uploadSessionId: string;
  readonly pageId: string;
  readonly totalBytes: number;
  readonly chunkSize: number;
  readonly startOffset?: number;
  readonly endOffset?: number;
  readonly videoId?: string;
}

/** Mutable subset of a session. Absent keys are left untouched. */
export interface UploadSessionPatch {
  readonly startOffset?: number;
  readonly endOffset?: number;
  readonly phase?: VideoUploadPhase;
  readonly resumes?: number;
  readonly videoId?: string;
  readonly lastError?: string;
}

/**
 * In-memory session store. Reads (`get`/`list`/`size`) evict expired entries
 * first, so an expired session is indistinguishable from an unknown one — the
 * caller gets one behaviour ("restart the upload") for both (CC-MEDIA-1).
 */
export interface UploadSessionRegistry {
  /** Register (or replace) a session, stamping `createdAt`/`updatedAt` from the clock. */
  create(init: UploadSessionInit): VideoUploadSession;
  /** Look a session up, evicting expired entries first. */
  get(uploadSessionId: string): VideoUploadSession | undefined;
  /** Apply a patch and refresh `updatedAt`; `undefined` when the session is gone. */
  update(
    uploadSessionId: string,
    patch: UploadSessionPatch,
  ): VideoUploadSession | undefined;
  /** Drop a session; `true` when one was actually removed. */
  remove(uploadSessionId: string): boolean;
  /** Every live session, insertion-ordered. */
  list(): readonly VideoUploadSession[];
  /** Evict every session idle longer than the TTL; returns the evicted ids. */
  evictExpired(): readonly string[];
  /** Number of live sessions. */
  size(): number;
  /** The configured TTL in ms (documented, so a caller can report it). */
  readonly ttlMs: number;
}

/** Registry dependencies. Time is injected; `Date.now()` is never used. */
export interface UploadSessionRegistryDeps {
  readonly clock: Clock;
  /** Override the idle TTL; non-finite/non-positive values fall back to the default. */
  readonly ttlMs?: number;
}

// ---------------------------------------------------------------------------
// Public types — state machine
// ---------------------------------------------------------------------------

/** Dependencies of the upload state machine. No ambient context, no HTTP. */
export interface VideoUploadDeps {
  readonly fbRequest: FbRequestFn;
  readonly clock: Clock;
  readonly sessions: UploadSessionRegistry;
  /**
   * The configured API version, needed because the rupload path carries it as
   * its SECOND segment ({@link ruploadPathForSession}) and core deliberately
   * does not inject one for this protocol.
   */
  readonly settings: Pick<Settings, 'apiVersion'>;
  readonly logger?: Logger;
  /** Bound on resume attempts for one transfer (default {@link DEFAULT_MAX_RESUME_ATTEMPTS}). */
  readonly maxResumeAttempts?: number;
  /** Base backoff before a resume attempt (default {@link DEFAULT_RESUME_BACKOFF_MS}); 0 disables waiting. */
  readonly resumeBackoffMs?: number;
}

/** Per-request scoping shared by every phase (token/page/timeout/abort seams). */
interface RequestScope {
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface StartVideoUploadInput extends RequestScope {
  readonly pageId: string;
  /** Total size of the file being uploaded, in bytes. Must be a positive integer. */
  readonly totalBytes: number;
  /** Preferred chunk size; clamped into [{@link MIN_CHUNK_SIZE}, {@link MAX_CHUNK_SIZE}]. */
  readonly chunkSize?: number;
  /** Optional original file name, passed through as `file_name`. */
  readonly fileName?: string;
}

export interface TransferVideoUploadInput extends RequestScope {
  readonly uploadSessionId: string;
  /** The whole file. Must match the session's `totalBytes`; views are not copied. */
  readonly data: Uint8Array;
  readonly onProgress?: UploadProgress;
}

export interface FinishVideoUploadInput extends RequestScope {
  readonly uploadSessionId: string;
  readonly description?: string;
  readonly title?: string;
  /** `false` to create an unpublished video; omitted means the edge default. */
  readonly published?: boolean;
  /** Unix seconds for a scheduled publish. */
  readonly scheduledPublishTime?: number;
}

/** What `finish` produced. `note` is always present: created is not ready (CC-MEDIA-7). */
export interface FinishVideoUploadResult {
  readonly videoId: string;
  readonly uploadSessionId: string;
  readonly totalBytes: number;
  /** Resume attempts the transfer consumed — worth surfacing on a flaky network. */
  readonly resumes: number;
  /** The edge's own `success` flag when it sent one, else `true` (a video id came back). */
  readonly success: boolean;
  readonly note: string;
}

export interface UploadVideoInput extends RequestScope {
  readonly pageId: string;
  readonly data: Uint8Array;
  readonly description?: string;
  readonly title?: string;
  readonly published?: boolean;
  readonly scheduledPublishTime?: number;
  readonly chunkSize?: number;
  readonly fileName?: string;
  readonly onProgress?: UploadProgress;
}

/** One-call result: the `finish` result plus the byte count actually transferred. */
export interface UploadVideoResult extends FinishVideoUploadResult {
  readonly bytesSent: number;
}

// ---------------------------------------------------------------------------
// Public types — status probe
// ---------------------------------------------------------------------------

/** Status-probe dependencies — a structural subset of {@link VideoUploadDeps}. */
export interface VideoStatusDeps {
  readonly fbRequest: FbRequestFn;
  readonly logger?: Logger;
}

export interface VideoStatusInput extends RequestScope {
  readonly videoId: string;
  /** Page whose token should be resolved for the read (per-page token resolver — C1). */
  readonly pageId?: string;
}

/** Bytes are still arriving; the upload is not complete. */
export interface VideoUploadingStatus {
  readonly kind: 'uploading';
  readonly videoId: string;
  /** Server-reported `bytes_transferred`, when present. */
  readonly bytesTransferred?: number;
  readonly note: string;
}

/** Bytes are in; Meta is transcoding. NOT playable yet (CC-MEDIA-7). */
export interface VideoProcessingStatus {
  readonly kind: 'processing';
  readonly videoId: string;
  readonly note: string;
}

/** Processing finished. Whether it is LIVE is the publishing phase's business. */
export interface VideoReadyStatus {
  readonly kind: 'ready';
  readonly videoId: string;
  /** Raw publishing-phase status/publish_status, when present. */
  readonly publishStatus?: string;
  readonly note: string;
}

/** A phase reported an error. Terminal — re-uploading is a caller decision. */
export interface VideoErrorStatus {
  readonly kind: 'error';
  readonly videoId: string;
  readonly message: string;
  readonly note: string;
}

/** The four states a caller must distinguish. Discriminant is `kind`. */
export type VideoStatus =
  VideoUploadingStatus | VideoProcessingStatus | VideoReadyStatus | VideoErrorStatus;

// ---------------------------------------------------------------------------
// Internal: defensive value readers (every Graph field may be absent/typed oddly)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readId(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw.trim().length > 0 ? raw.trim() : undefined;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return undefined;
}

/** Non-negative integer offsets, whether Graph sent them as numbers or strings. */
function readOffset(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 0 ? raw : undefined;
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown error';
}

/** `JSON.stringify` that never throws (a cyclic body must not break offset parsing). */
function safeStringify(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * The server-confirmed next offset after a chunk write, read through F08's ONE
 * offset parser: response headers first, then the JSON body
 * (`file_offset`/`offset`/`start_offset`). The body arrives already parsed, so it
 * is re-serialized for the parser rather than duplicating its key list here.
 */
function offsetFromResponse(res: FbResponse<unknown>): number | undefined {
  const fromHeaders = parseFileOffset(res.headers);
  if (fromHeaders !== undefined) return fromHeaders;
  const text = safeStringify(res.data);
  return text === undefined ? undefined : parseFileOffset(res.headers, text);
}

function endOffsetFromResponse(res: FbResponse<unknown>): number | undefined {
  return readOffset(asRecord(res.data)?.['end_offset']);
}

// ---------------------------------------------------------------------------
// Internal: error construction (F06's `makeAction` is private — mirror the shape)
// ---------------------------------------------------------------------------

function uploadError(
  message: string,
  action: ErrorAction,
  httpStatus = 0,
  cause?: unknown,
): GraphApiError {
  return new GraphApiError(message, {
    code: 0,
    httpStatus,
    action,
    ...(cause !== undefined ? { cause } : {}),
  });
}

/** The in-process session is unknown or expired: nothing to resume (CC-MEDIA-1). */
function sessionLostError(uploadSessionId: string): GraphApiError {
  return uploadError(
    `unknown upload session '${uploadSessionId}' — ${SESSION_LOST_NOTE}`,
    {
      category: 'not_found',
      retryable: false,
      operatorText: SESSION_LOST_NOTE,
    },
  );
}

/** Client and server disagree; re-creating silently could duplicate the video (CC-MEDIA-3). */
function desyncError(detail: string): GraphApiError {
  return uploadError(`cannot continue upload (${detail}) — ${SESSION_DESYNC_NOTE}`, {
    category: 'validation',
    retryable: false,
    operatorText: SESSION_DESYNC_NOTE,
  });
}

/** A caller-side argument problem — never retryable, never a wire call. */
function invalidInputError(detail: string): GraphApiError {
  return uploadError(`invalid video upload input (${detail})`, {
    category: 'validation',
    retryable: false,
    operatorText: `fix the request and try again: ${detail}`,
  });
}

/** The resume budget is spent. Not retryable HERE — the caller must check status first. */
function resumeExhaustedError(
  detail: string,
  resumes: number,
  cause?: unknown,
): GraphApiError {
  return uploadError(
    `video upload could not be resumed after ${resumes} attempt(s) (${detail})`,
    {
      category: 'transient',
      retryable: false,
      operatorText:
        'the upload kept failing — check the video status before re-uploading, then restart the upload',
    },
    0,
    cause,
  );
}

/**
 * True when a failed chunk write may be retried by re-reading the server offset.
 * Prefers F06's authoritative `ErrorAction.category`: `transient` is an explicit
 * blip, and `ambiguous` is safe here — unlike a one-shot write, a chunk is
 * offset-idempotent, so re-sending the tail after re-reading the offset cannot
 * duplicate anything (CC-MEDIA-2). Falls back to the HTTP status for errors
 * raised before the matrix ran. Everything else (auth, permission, validation,
 * not_found) propagates untouched.
 */
export function isResumableUploadError(err: unknown): boolean {
  if (!(err instanceof GraphApiError)) return false;
  const category = err.action?.category;
  if (category === 'transient' || category === 'ambiguous') return true;
  if (category !== undefined) return false;
  return err.httpStatus >= 500;
}

/** Abort must win over every retry decision: cancellation is not a fault (CC-MCP-2). */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

// ---------------------------------------------------------------------------
// Internal: normalization + chunk windowing
// ---------------------------------------------------------------------------

function normalizeTtl(ttlMs: number | undefined): number {
  return ttlMs !== undefined && Number.isFinite(ttlMs) && ttlMs > 0
    ? Math.floor(ttlMs)
    : DEFAULT_SESSION_TTL_MS;
}

function normalizeChunkSize(chunkSize: number | undefined): number {
  if (chunkSize === undefined || !Number.isFinite(chunkSize) || chunkSize <= 0) {
    return DEFAULT_CHUNK_SIZE;
  }
  return Math.min(Math.max(Math.floor(chunkSize), MIN_CHUNK_SIZE), MAX_CHUNK_SIZE);
}

function normalizeMaxResumes(max: number | undefined): number {
  if (max === undefined || !Number.isFinite(max) || max < 0) {
    return DEFAULT_MAX_RESUME_ATTEMPTS;
  }
  return Math.floor(max);
}

function normalizeBackoff(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0)
    return DEFAULT_RESUME_BACKOFF_MS;
  return Math.floor(ms);
}

/**
 * The byte window to send next. The server-declared `end` wins whenever it is
 * sane (past `start`, no further than the file end) — the legacy edge expects
 * exactly the range it asked for. Nonsense or missing values fall back to one
 * `chunkSize` step, so a malformed response degrades instead of stalling
 * (CC-NET-2).
 */
function clampWindow(
  start: number,
  end: number,
  total: number,
  chunkSize: number,
): number {
  const fallback = Math.min(start + chunkSize, total);
  if (!Number.isInteger(end) || end <= start || end > total) return fallback;
  return end;
}

/**
 * The chunk covering `[start, start + size)`. Slicing is delegated to F08's
 * `planRuploadChunks` (one chunker in the codebase) over just the current window,
 * then rebased onto the absolute file offset — O(1) per iteration, and the plan's
 * `fileOffset` is exactly the `file_offset` header the chunk must carry.
 */
function nextChunk(data: Uint8Array, start: number, size: number): RuploadChunkPlan {
  const window = data.subarray(start, start + size);
  const plan = planRuploadChunks(window, Math.max(1, size))[0];
  if (plan === undefined) {
    throw desyncError(`empty chunk window at offset ${start}`);
  }
  return {
    fileOffset: start + plan.fileOffset,
    chunk: plan.chunk,
    index: plan.index,
    isLast: start + window.byteLength >= data.byteLength,
  };
}

/**
 * Feed the progress sink, defensively. A sink is ADVISORY: the tools layer
 * bridges it onto an MCP `progressToken` notification (CC-MCP-1), and that
 * notification can fail on a closing transport. A throwing sink must never fail
 * an upload whose bytes are already on Meta's side, so the throw is contained —
 * and logged, never silently dropped.
 */
function reportProgress(
  deps: VideoUploadDeps,
  onProgress: UploadProgress | undefined,
  sent: number,
  total: number,
): void {
  if (onProgress === undefined) return;
  try {
    onProgress(sent, total);
  } catch (err) {
    deps.logger?.warn('progress sink threw — the upload continues', {
      sent,
      total,
      error: errorMessage(err),
    });
  }
}

function scopeOf(scope: RequestScope): RequestScope {
  return {
    ...(scope.token !== undefined ? { token: scope.token } : {}),
    ...(scope.timeoutMs !== undefined ? { timeoutMs: scope.timeoutMs } : {}),
    ...(scope.signal !== undefined ? { signal: scope.signal } : {}),
  };
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

/**
 * Create an in-memory upload session registry. State lives in the closure, so two
 * factories never share sessions and nothing survives the process (CC-MEDIA-1).
 */
export function createUploadSessionRegistry(
  deps: UploadSessionRegistryDeps,
): UploadSessionRegistry {
  const ttlMs = normalizeTtl(deps.ttlMs);
  const sessions = new Map<string, VideoUploadSession>();

  const evictExpired = (): readonly string[] => {
    const now = deps.clock.now();
    const evicted: string[] = [];
    for (const [id, session] of sessions) {
      if (now - session.updatedAt > ttlMs) {
        sessions.delete(id);
        evicted.push(id);
      }
    }
    return evicted;
  };

  return {
    ttlMs,

    create(init: UploadSessionInit): VideoUploadSession {
      const now = deps.clock.now();
      const startOffset = init.startOffset ?? 0;
      const session: VideoUploadSession = {
        uploadSessionId: init.uploadSessionId,
        pageId: init.pageId,
        totalBytes: init.totalBytes,
        startOffset,
        endOffset:
          init.endOffset ?? Math.min(startOffset + init.chunkSize, init.totalBytes),
        chunkSize: init.chunkSize,
        phase: 'started',
        resumes: 0,
        createdAt: now,
        updatedAt: now,
        ...(init.videoId !== undefined ? { videoId: init.videoId } : {}),
      };
      sessions.set(session.uploadSessionId, session);
      return session;
    },

    get(uploadSessionId: string): VideoUploadSession | undefined {
      evictExpired();
      return sessions.get(uploadSessionId);
    },

    update(
      uploadSessionId: string,
      patch: UploadSessionPatch,
    ): VideoUploadSession | undefined {
      evictExpired();
      const current = sessions.get(uploadSessionId);
      if (current === undefined) return undefined;
      const next: VideoUploadSession = {
        ...current,
        ...(patch.startOffset !== undefined ? { startOffset: patch.startOffset } : {}),
        ...(patch.endOffset !== undefined ? { endOffset: patch.endOffset } : {}),
        ...(patch.phase !== undefined ? { phase: patch.phase } : {}),
        ...(patch.resumes !== undefined ? { resumes: patch.resumes } : {}),
        ...(patch.videoId !== undefined ? { videoId: patch.videoId } : {}),
        ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
        updatedAt: deps.clock.now(),
      };
      sessions.set(uploadSessionId, next);
      return next;
    },

    remove(uploadSessionId: string): boolean {
      return sessions.delete(uploadSessionId);
    },

    list(): readonly VideoUploadSession[] {
      evictExpired();
      return [...sessions.values()];
    },

    evictExpired,

    size(): number {
      evictExpired();
      return sessions.size;
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 1 — start
// ---------------------------------------------------------------------------

function requireSession(
  sessions: UploadSessionRegistry,
  uploadSessionId: string,
): VideoUploadSession {
  const session = sessions.get(uploadSessionId);
  if (session === undefined) throw sessionLostError(uploadSessionId);
  return session;
}

function requireUpdate(
  sessions: UploadSessionRegistry,
  uploadSessionId: string,
  patch: UploadSessionPatch,
): VideoUploadSession {
  const session = sessions.update(uploadSessionId, patch);
  if (session === undefined) throw sessionLostError(uploadSessionId);
  return session;
}

/**
 * Open an upload session: `upload_phase=start` on the Page's video edge. Returns
 * the registered session, carrying the session id, the video id the edge already
 * assigned, and the first byte window the server wants.
 */
export async function startVideoUpload(
  deps: VideoUploadDeps,
  input: StartVideoUploadInput,
): Promise<VideoUploadSession> {
  if (input.pageId.trim().length === 0) {
    throw invalidInputError('pageId is required');
  }
  if (!Number.isInteger(input.totalBytes) || input.totalBytes <= 0) {
    throw invalidInputError(
      `totalBytes must be a positive integer (got ${String(input.totalBytes)})`,
    );
  }

  const chunkSize = normalizeChunkSize(input.chunkSize);
  const req: JsonRequest = {
    protocol: 'json',
    method: 'POST',
    host: VIDEO_EDGE_HOST,
    path: `/${input.pageId}/videos`,
    body: {
      upload_phase: 'start',
      file_size: input.totalBytes,
      ...(input.fileName !== undefined ? { file_name: input.fileName } : {}),
    },
    pageId: input.pageId,
    ...scopeOf(input),
  };

  const res = await deps.fbRequest<unknown>(req);
  const rec = asRecord(res.data);
  const uploadSessionId = readId(rec?.['upload_session_id']);
  if (uploadSessionId === undefined) {
    throw desyncError('start returned no upload_session_id');
  }

  const startOffset = readOffset(rec?.['start_offset']) ?? 0;
  const endOffset = clampWindow(
    startOffset,
    readOffset(rec?.['end_offset']) ?? -1,
    input.totalBytes,
    chunkSize,
  );
  const videoId = readId(rec?.['video_id']);

  const session = deps.sessions.create({
    uploadSessionId,
    pageId: input.pageId,
    totalBytes: input.totalBytes,
    chunkSize,
    startOffset,
    endOffset,
    ...(videoId !== undefined ? { videoId } : {}),
  });

  deps.logger?.debug('video upload session started', {
    uploadSessionId,
    totalBytes: input.totalBytes,
    chunkSize,
    startOffset,
    endOffset,
  });
  return session;
}

// ---------------------------------------------------------------------------
// Phase 2 — transfer
// ---------------------------------------------------------------------------

/** Wait before a resume attempt, honouring the caller's abort signal (CC-MCP-2). */
async function backoff(
  deps: VideoUploadDeps,
  attempt: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const base = normalizeBackoff(deps.resumeBackoffMs);
  if (base === 0) return;
  await deps.clock.sleep(base * attempt, signal);
}

/**
 * Push the file's bytes, resuming from the SERVER's offset on a transient fault.
 * Idempotent per call: it always starts from the session's server-confirmed
 * offset, so calling it again after a failure continues instead of restarting
 * (CC-MEDIA-2). Returns the session once every byte is confirmed (`transferred`).
 */
export async function transferVideoUpload(
  deps: VideoUploadDeps,
  input: TransferVideoUploadInput,
): Promise<VideoUploadSession> {
  const opened = requireSession(deps.sessions, input.uploadSessionId);
  if (input.data.byteLength !== opened.totalBytes) {
    throw desyncError(
      `data is ${input.data.byteLength} byte(s) but the session declared ${opened.totalBytes}`,
    );
  }

  const total = opened.totalBytes;
  const maxResumes = normalizeMaxResumes(deps.maxResumeAttempts);
  const scope = scopeOf(input);
  let session = requireUpdate(deps.sessions, input.uploadSessionId, {
    phase: total > opened.startOffset ? 'transferring' : 'transferred',
  });
  let start = session.startOffset;
  let end = session.endOffset;
  let resumes = session.resumes;

  // Termination: each iteration either strictly increases `start` (bounded by
  // `total`) or consumes one of the finitely many resume attempts. Neither a
  // never-advancing offset nor an endlessly failing edge can loop forever.
  while (start < total) {
    const window = clampWindow(start, end, total, session.chunkSize);
    const plan = nextChunk(input.data, start, window - start);
    const req: RuploadRequest = {
      protocol: 'rupload',
      method: 'POST',
      host: RUPLOAD_HOST,
      path: ruploadPathForSession(session.uploadSessionId, deps.settings.apiVersion),
      fileOffset: plan.fileOffset,
      chunk: plan.chunk,
      headers: { file_size: String(total) },
      pageId: session.pageId,
      ...scope,
    };

    let res: FbResponse<unknown>;
    try {
      res = await deps.fbRequest<unknown>(req);
    } catch (err) {
      // Cancellation: keep the session exactly as it is so the caller can resume
      // or report progress. Whether the in-flight chunk landed is unknowable, but
      // chunks are offset-idempotent, so re-reading the offset later resolves it.
      if (isAbortError(err)) {
        deps.sessions.update(input.uploadSessionId, { lastError: errorMessage(err) });
        throw err;
      }
      if (!isResumableUploadError(err)) {
        deps.sessions.update(input.uploadSessionId, {
          phase: 'failed',
          lastError: errorMessage(err),
        });
        throw err;
      }
      if (resumes >= maxResumes) {
        deps.sessions.update(input.uploadSessionId, {
          phase: 'failed',
          lastError: errorMessage(err),
        });
        throw resumeExhaustedError(`offset ${start} of ${total}`, resumes, err);
      }

      resumes += 1;
      session = requireUpdate(deps.sessions, input.uploadSessionId, {
        resumes,
        lastError: errorMessage(err),
      });
      deps.logger?.warn('video chunk failed — resuming from the server offset', {
        uploadSessionId: session.uploadSessionId,
        attempt: resumes,
        offset: start,
      });
      await backoff(deps, resumes, input.signal);

      // Re-read the authoritative offset instead of replaying the chunk. A probe
      // fault leaves `start` alone (the same window is simply re-sent) so a broken
      // probe never masks the upload fault it was called about. Without a video id
      // there is nothing to probe, so the current window is simply re-sent.
      const videoId = session.videoId;
      if (videoId !== undefined) {
        const probed = await readUploadOffset(deps, {
          videoId,
          pageId: session.pageId,
          ...scope,
        });
        if (probed !== undefined && probed <= total) {
          start = probed;
          // Persist the server's word at once. A progress read, a `finish`, or a
          // second `transfer` call must see the offset this loop is about to
          // resume from — not the pre-failure one it has already superseded.
          session = requireUpdate(deps.sessions, input.uploadSessionId, {
            startOffset: start,
          });
        }
      }
      end = 0; // force the chunkSize fallback window until the server declares one
      continue;
    }

    const acked = offsetFromResponse(res) ?? window;
    if (acked <= start) {
      // No forward progress. Treat it exactly like a transient failure so the
      // resume budget — not the loop — decides when to give up.
      if (resumes >= maxResumes) {
        deps.sessions.update(input.uploadSessionId, {
          phase: 'failed',
          lastError: `server offset did not advance past ${start}`,
        });
        throw resumeExhaustedError(
          `server offset stuck at ${start} of ${total}`,
          resumes,
        );
      }
      resumes += 1;
      session = requireUpdate(deps.sessions, input.uploadSessionId, {
        resumes,
        lastError: `server offset did not advance past ${start}`,
      });
      await backoff(deps, resumes, input.signal);
      end = 0;
      continue;
    }

    start = Math.min(acked, total);
    end = clampWindow(start, endOffsetFromResponse(res) ?? -1, total, session.chunkSize);
    session = requireUpdate(deps.sessions, input.uploadSessionId, {
      startOffset: start,
      endOffset: end,
      resumes,
      phase: start >= total ? 'transferred' : 'transferring',
    });
    reportProgress(deps, input.onProgress, start, total);
  }

  return requireUpdate(deps.sessions, input.uploadSessionId, {
    startOffset: start,
    endOffset: start,
    resumes,
    phase: 'transferred',
  });
}

// ---------------------------------------------------------------------------
// Phase 3 — finish
// ---------------------------------------------------------------------------

/**
 * Close the session: `upload_phase=finish` with the description/title. Returns the
 * video id — which is NOT a promise that the video is playable or live
 * (CC-MEDIA-7); poll {@link getVideoStatus} for that.
 */
export async function finishVideoUpload(
  deps: VideoUploadDeps,
  input: FinishVideoUploadInput,
): Promise<FinishVideoUploadResult> {
  const session = requireSession(deps.sessions, input.uploadSessionId);
  if (session.startOffset < session.totalBytes) {
    throw desyncError(
      `only ${session.startOffset} of ${session.totalBytes} byte(s) transferred`,
    );
  }

  const req: JsonRequest = {
    protocol: 'json',
    method: 'POST',
    host: VIDEO_EDGE_HOST,
    path: `/${session.pageId}/videos`,
    body: {
      upload_phase: 'finish',
      upload_session_id: session.uploadSessionId,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.published !== undefined ? { published: input.published } : {}),
      ...(input.scheduledPublishTime !== undefined
        ? { scheduled_publish_time: input.scheduledPublishTime }
        : {}),
    },
    pageId: session.pageId,
    ...scopeOf(input),
  };

  let res: FbResponse<unknown>;
  try {
    res = await deps.fbRequest<unknown>(req);
  } catch (err) {
    // The session is KEPT (marked failed) rather than dropped: the bytes are
    // already on Meta's side, so a caller may legitimately re-issue `finish`
    // without re-uploading. Silently re-creating the session would risk a
    // duplicate video (CC-MEDIA-3).
    deps.sessions.update(input.uploadSessionId, {
      phase: 'failed',
      lastError: errorMessage(err),
    });
    throw err;
  }

  const rec = asRecord(res.data);
  const videoId = readId(rec?.['video_id']) ?? readId(rec?.['id']) ?? session.videoId;
  if (videoId === undefined) {
    deps.sessions.update(input.uploadSessionId, {
      phase: 'failed',
      lastError: 'finish returned no video id',
    });
    throw desyncError('finish returned no video id');
  }

  const rawSuccess = rec?.['success'];
  const success = typeof rawSuccess === 'boolean' ? rawSuccess : true;
  const finished = requireUpdate(deps.sessions, input.uploadSessionId, {
    phase: 'finished',
    videoId,
  });
  deps.logger?.info('video upload finished', {
    uploadSessionId: finished.uploadSessionId,
    videoId,
    resumes: finished.resumes,
  });

  return {
    videoId,
    uploadSessionId: finished.uploadSessionId,
    totalBytes: finished.totalBytes,
    resumes: finished.resumes,
    success,
    note: CREATED_NOT_READY_NOTE,
  };
}

// ---------------------------------------------------------------------------
// One-call convenience: start -> transfer -> finish
// ---------------------------------------------------------------------------

/**
 * Run all three phases. A failure anywhere leaves the session in the registry so
 * the caller can report progress or resume; only the phases themselves decide
 * what is retryable.
 */
export async function uploadVideo(
  deps: VideoUploadDeps,
  input: UploadVideoInput,
): Promise<UploadVideoResult> {
  const started = await startVideoUpload(deps, {
    pageId: input.pageId,
    totalBytes: input.data.byteLength,
    ...(input.chunkSize !== undefined ? { chunkSize: input.chunkSize } : {}),
    ...(input.fileName !== undefined ? { fileName: input.fileName } : {}),
    ...scopeOf(input),
  });

  const transferred = await transferVideoUpload(deps, {
    uploadSessionId: started.uploadSessionId,
    data: input.data,
    ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
    ...scopeOf(input),
  });

  const finished = await finishVideoUpload(deps, {
    uploadSessionId: started.uploadSessionId,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.published !== undefined ? { published: input.published } : {}),
    ...(input.scheduledPublishTime !== undefined
      ? { scheduledPublishTime: input.scheduledPublishTime }
      : {}),
    ...scopeOf(input),
  });

  return { ...finished, bytesSent: transferred.startOffset };
}

// ---------------------------------------------------------------------------
// Status probe (CC-MEDIA-7) — a finished upload is not a published video
// ---------------------------------------------------------------------------

const STATUS_KEYS = [
  'video_status',
  'uploading_phase',
  'processing_phase',
  'publishing_phase',
] as const;

/**
 * Locate the `status` object in a probe response. Accepts either the full node
 * body (`{id, status: {...}}`) or a bare status object, so the mapping is usable
 * on whatever shape a caller already has.
 */
function statusRecord(raw: unknown): Record<string, unknown> | undefined {
  const rec = asRecord(raw);
  if (rec === undefined) return undefined;
  const nested = asRecord(rec['status']);
  if (nested !== undefined) return nested;
  return STATUS_KEYS.some((key) => key in rec) ? rec : undefined;
}

/** First human-readable error message a phase carries (`errors[]` or `error`). */
function phaseErrorMessage(phase: unknown): string | undefined {
  const rec = asRecord(phase);
  if (rec === undefined) return undefined;
  const errors = rec['errors'];
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      const message = asRecord(entry)?.['message'];
      if (typeof message === 'string' && message.length > 0) return message;
    }
  }
  const single = asRecord(rec['error'])?.['message'];
  if (typeof single === 'string' && single.length > 0) return single;
  return undefined;
}

function phaseStatus(phase: unknown): string | undefined {
  const raw = asRecord(phase)?.['status'];
  return typeof raw === 'string' ? raw.toLowerCase() : undefined;
}

/** `uploading_phase.bytes_transferred` — the server's authoritative resume offset. */
function readBytesTransferred(raw: unknown): number | undefined {
  const status = statusRecord(raw);
  if (status === undefined) return undefined;
  return readOffset(asRecord(status['uploading_phase'])?.['bytes_transferred']);
}

/**
 * Map a raw `status` payload onto the four states a caller must distinguish.
 * Pure, so every branch is testable without a wire call.
 *
 * Precedence (deliberate): an error in ANY phase wins, because a failed video
 * that still reports `processing` elsewhere must not read as "in progress". Then
 * `ready`, then an explicitly in-flight upload, and finally `processing` as the
 * safe default — an unrecognized or missing status means "poll again", never
 * "done" (CC-MEDIA-7 / CC-NET-2).
 */
export function mapVideoStatus(videoId: string, raw: unknown): VideoStatus {
  const status = statusRecord(raw);
  if (status === undefined) {
    return { kind: 'processing', videoId, note: STATUS_NOTES.unknown };
  }

  const videoStatus =
    typeof status['video_status'] === 'string'
      ? status['video_status'].toLowerCase()
      : undefined;
  const uploading = status['uploading_phase'];
  const processing = status['processing_phase'];
  const publishing = status['publishing_phase'];

  const failed =
    videoStatus === 'error' ||
    videoStatus === 'upload_failed' ||
    videoStatus === 'failed' ||
    phaseStatus(uploading) === 'error' ||
    phaseStatus(processing) === 'error' ||
    phaseStatus(publishing) === 'error';
  if (failed) {
    const message =
      phaseErrorMessage(processing) ??
      phaseErrorMessage(uploading) ??
      phaseErrorMessage(publishing) ??
      'video upload or processing failed';
    return { kind: 'error', videoId, message, note: STATUS_NOTES.error };
  }

  if (videoStatus === 'ready' || phaseStatus(processing) === 'complete') {
    const publishStatus =
      asRecord(publishing)?.['publish_status'] ?? phaseStatus(publishing);
    return {
      kind: 'ready',
      videoId,
      ...(typeof publishStatus === 'string' ? { publishStatus } : {}),
      note: STATUS_NOTES.ready,
    };
  }

  const uploadingStatus = phaseStatus(uploading);
  if (uploadingStatus === 'not_started' || uploadingStatus === 'in_progress') {
    const bytesTransferred = readBytesTransferred(status);
    return {
      kind: 'uploading',
      videoId,
      ...(bytesTransferred !== undefined ? { bytesTransferred } : {}),
      note: STATUS_NOTES.uploading,
    };
  }

  return { kind: 'processing', videoId, note: STATUS_NOTES.processing };
}

/** `GET /{video-id}?fields=status` — the one wire call both probes share. */
async function fetchVideoStatus(
  deps: VideoStatusDeps,
  input: VideoStatusInput,
): Promise<unknown> {
  if (input.videoId.trim().length === 0) {
    throw invalidInputError('videoId is required');
  }
  const req: JsonRequest = {
    protocol: 'json',
    method: 'GET',
    host: STATUS_HOST,
    path: `/${input.videoId}`,
    params: { fields: VIDEO_STATUS_FIELDS },
    ...(input.pageId !== undefined ? { pageId: input.pageId } : {}),
    ...scopeOf(input),
  };
  const res = await deps.fbRequest<unknown>(req);
  return res.data;
}

/**
 * Read a video's status. Separate from the upload phases on purpose: a finished
 * upload is not a published video, so the caller must be able to poll
 * (CC-MEDIA-3/-7).
 */
export async function getVideoStatus(
  deps: VideoStatusDeps,
  input: VideoStatusInput,
): Promise<VideoStatus> {
  return mapVideoStatus(input.videoId, await fetchVideoStatus(deps, input));
}

/**
 * The server's current byte offset for a video still uploading (CC-MEDIA-2), or
 * `undefined` when it cannot be determined. Never throws: it is called from the
 * resume path, where a failing probe must not replace the upload error the caller
 * actually needs to see.
 */
export async function readUploadOffset(
  deps: VideoStatusDeps,
  input: VideoStatusInput,
): Promise<number | undefined> {
  try {
    return readBytesTransferred(await fetchVideoStatus(deps, input));
  } catch (err) {
    deps.logger?.debug('upload offset probe failed — keeping the current offset', {
      videoId: input.videoId,
      error: errorMessage(err),
    });
    return undefined;
  }
}
