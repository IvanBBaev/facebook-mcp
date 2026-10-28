// Shared chunked-upload state machine (task X06, `api` layer, expand only).
//
// `media-video.ts` (legacy resumable video edge) and `media-reels.ts` (Reels /
// video stories) each drive their own server-offset transfer loop over the
// rupload host, and `media-photos.ts` shares the advisory progress-sink rule
// with both. This module holds the part those loops genuinely have in common,
// as pure functions over an immutable cursor plus two tiny I/O seams (a
// `Clock` for waits and a caller-supplied progress sink). It performs no HTTP,
// builds no request and raises no Graph error: every wire call, every error
// message and every bookkeeping write stays with the media module that drives
// it. The media modules adopt it in a later wave (expand -> migrate -> contract).
//
// The machine, per chunk:
//
//   window = nextChunkWindow(cursor)          // server-declared end, else one chunk step
//   send window ->
//     2xx  -> applyChunkAck(cursor, readChunkAck(res), policy)
//               advanced | stalled | rewound  -> continue (after `waitMs`)
//               exhausted                     -> the driver fails the transfer
//               overrun                       -> the driver raises a desync
//     fault-> applyChunkFault(cursor, err, policy)
//               resume                        -> continue (after `waitMs`)
//               abort | fatal | deferred | exhausted -> the driver rethrows/wraps
//
// Invariants (CC-MEDIA-2/-3, CC-MCP-2):
//   * SERVER-AUTHORITATIVE OFFSETS. The cursor offset only ever moves to an
//     offset the server named, or — when a 2xx is silent — to the end of the
//     window just sent. A 2xx that refuses the chunk (`success` present and not
//     `true`) with no offset stays where it was.
//   * BOUNDED AND ALWAYS TERMINATING. Every transition either strictly advances
//     the counter that drives termination or consumes one unit of a finite
//     budget; non-finite or negative policy knobs are refused up front, because
//     `resumes >= NaN` is never true.
//   * NO SILENT RE-CREATE. An offset past the file end is reported as `overrun`,
//     never clamped to "done".
//   * ABORT WINS. A cancellation is never classified as a resumable fault.

import { GraphApiError, parseFileOffset } from '../core/index.js';
import type { Clock, FbResponse } from '../core/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Longest server-named wait (`retryAfterMs`, from a `Retry-After`) a resume
 * sleeps through before re-driving a chunk. A longer one is surfaced at once
 * with the wait attached, so the caller schedules the retry instead of the
 * transfer re-driving into the window the server just announced. Equal to the
 * transport's own cap and to both media modules' current value.
 */
export const UPLOAD_MAX_SERVER_WAIT_MS = 30_000;

// ---------------------------------------------------------------------------
// Wire readers (every Graph field may be absent or oddly typed — CC-NET-2)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A non-negative integer offset off the wire, whether Graph sent it as a number
 * or as a numeric string; anything else is `undefined`.
 */
export function readWireOffset(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 0 ? raw : undefined;
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  }
  return undefined;
}

/**
 * The server-confirmed next offset after a chunk write, read through core's ONE
 * offset parser: response headers first, then the JSON body. The body arrives
 * already parsed, so it is re-serialized for the parser rather than duplicating
 * its key list; a body that cannot be serialized (cycle, BigInt) says nothing.
 */
export function serverOffsetOf(res: FbResponse<unknown>): number | undefined {
  const fromHeaders = parseFileOffset(res.headers);
  if (fromHeaders !== undefined) return fromHeaders;
  const rec = asRecord(res.data);
  if (rec === undefined) return undefined;
  let text: string;
  try {
    text = JSON.stringify(rec);
  } catch {
    return undefined;
  }
  return parseFileOffset({}, text);
}

/**
 * Did a 2xx chunk response explicitly decline the bytes? `fbRequest` casts the
 * body unvalidated, so only a `success` flag that is present and not `true`
 * (`false`, `"false"`, `0`, `null`) counts as a refusal.
 */
export function isChunkRefused(res: FbResponse<unknown>): boolean {
  const rec = asRecord(res.data);
  if (rec === undefined || !('success' in rec)) return false;
  return rec['success'] !== true;
}

/** What one accepted (2xx) chunk response says, normalized. */
export interface ChunkAck {
  /** Server-confirmed next offset, when the response named one. */
  readonly offset?: number;
  /** Server-declared exclusive end of the NEXT window (`end_offset`), when sane-typed. */
  readonly declaredEnd?: number;
  /** The response explicitly refused the chunk (see {@link isChunkRefused}). */
  readonly refused: boolean;
}

/**
 * Normalize a chunk response into a {@link ChunkAck}. A driver whose edge does
 * not declare windows simply drops `declaredEnd` before applying the ack.
 */
export function readChunkAck(res: FbResponse<unknown>): ChunkAck {
  const offset = serverOffsetOf(res);
  const declaredEnd = readWireOffset(asRecord(res.data)?.['end_offset']);
  return {
    ...(offset !== undefined ? { offset } : {}),
    ...(declaredEnd !== undefined ? { declaredEnd } : {}),
    refused: isChunkRefused(res),
  };
}

// ---------------------------------------------------------------------------
// Fault classification
// ---------------------------------------------------------------------------

/** The caller's own cancellation, rethrown raw by the transport (CC-MCP-2). */
export function isAbortError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'AbortError';
}

/** The server-named wait a fault carries (`Retry-After`), when it names a positive finite one. */
export function serverWaitMsOf(err: unknown): number | undefined {
  if (!(err instanceof GraphApiError)) return undefined;
  const ms = err.action?.retryAfterMs;
  return ms !== undefined && Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * The resumability rule of the legacy video edge: `transient` and `ambiguous`
 * categories resume (a chunk is offset-idempotent, so re-sending its tail after
 * re-reading the offset cannot duplicate anything), any other category does
 * not, and an uncategorized Graph error falls back to `httpStatus >= 500`.
 * Non-Graph errors never resume. A driver with a stricter rule (Reels resumes
 * `transient` only) injects its own predicate through {@link TransferPolicy}.
 */
export function isResumableChunkFault(err: unknown): boolean {
  if (!(err instanceof GraphApiError)) return false;
  const category = err.action?.category;
  if (category === 'transient' || category === 'ambiguous') return true;
  if (category !== undefined) return false;
  return err.httpStatus >= 500;
}

// ---------------------------------------------------------------------------
// Waits and progress (the two I/O seams)
// ---------------------------------------------------------------------------

/**
 * How long to wait before re-drive number `attempt` (1-based): the linear local
 * backoff `baseMs * attempt`, or the server-named wait when that is longer — a
 * server wait is a minimum (RFC 9110) and is honoured even with `baseMs` 0.
 */
export function resumeWaitMs(
  baseMs: number,
  attempt: number,
  serverWaitMs?: number,
): number {
  return Math.max(baseMs * attempt, serverWaitMs ?? 0);
}

/**
 * Sleep `waitMs` on the injected clock, honouring the caller's abort signal.
 * A zero (or negative) wait returns at once without touching the clock. An
 * abort rejects with the clock's `AbortError`; wrapping it is the driver's job.
 */
export async function waitBeforeResume(
  clock: Pick<Clock, 'sleep'>,
  waitMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!(waitMs > 0)) return;
  await clock.sleep(waitMs, signal);
}

/**
 * Feed an advisory progress sink, defensively. The tools layer bridges a sink
 * onto an MCP `progressToken` notification (CC-MCP-1), which can fail on a
 * closing transport; a throwing sink must never fail an upload whose bytes are
 * already on Meta's side. The throw is handed to `onSinkError` (normally a log
 * line), and a throw from that handler is contained in turn — bookkeeping never
 * becomes the reported upload failure. Returns `true` when the sink ran cleanly,
 * `false` when there was no sink or it threw.
 */
export function notifyProgressSink<A extends readonly unknown[]>(
  sink: ((...args: A) => void) | undefined,
  args: A,
  onSinkError: (err: unknown) => void,
): boolean {
  if (sink === undefined) return false;
  try {
    sink(...args);
    return true;
  } catch (err) {
    try {
      onSinkError(err);
    } catch {
      // The reporter itself is broken; there is nothing left to report with.
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Transfer cursor + policy
// ---------------------------------------------------------------------------

/**
 * How non-advancing 2xx acks (a stall at the same offset, or a rewind) are
 * bounded:
 *
 *   * `resume-budget` (legacy video edge): stalls and rewinds consume the same
 *     `resumes` budget as transport faults; the budget never resets. A stall
 *     waits the local backoff; a rewind re-sends at once.
 *   * `high-water` (Reels): progress is measured against the furthest offset
 *     ever acknowledged, so a server that alternates between acknowledging and
 *     rewinding cannot reset the guard. Consecutive acks that do not pass the
 *     high-water mark count as `stalls`; more than `maxResumes` of them exhausts
 *     the transfer. Each one waits the local backoff (scaled by the stall count)
 *     unless the transfer is complete. Transport faults spend `resumes` only.
 */
export type StallAccounting = 'resume-budget' | 'high-water';

/** The knobs one transfer runs under. Validated by every transition. */
export interface TransferPolicy {
  /** Finite budget of re-drives (a non-negative safe integer; 0 = never resume). */
  readonly maxResumes: number;
  /** Base backoff in ms, scaled linearly by the attempt (a non-negative safe integer). */
  readonly backoffMs: number;
  /** Server-named waits above this are surfaced, not slept through. */
  readonly maxServerWaitMs: number;
  readonly stallAccounting: StallAccounting;
  /** Which faults may be re-driven by re-reading the offset. */
  readonly isResumable: (err: unknown) => boolean;
}

/** Immutable position of one transfer. Every transition returns a new cursor. */
export interface TransferCursor {
  /** File size in bytes (a positive safe integer). */
  readonly total: number;
  /** Fallback window size when the server declares none (a positive safe integer). */
  readonly chunkSize: number;
  /** Last acknowledged offset: where the next window starts. */
  readonly offset: number;
  /** Server-declared exclusive end of the next window; `undefined` = one chunk step. */
  readonly declaredEnd?: number;
  /** Re-drives spent so far (faults; plus stalls/rewinds under `resume-budget`). */
  readonly resumes: number;
  /** Furthest offset ever acknowledged. */
  readonly highWater: number;
  /** Consecutive acks that did not pass {@link highWater}. */
  readonly stalls: number;
}

/** Seed of a cursor; offsets default to the start of the file. */
export interface TransferCursorInit {
  readonly total: number;
  readonly chunkSize: number;
  readonly offset?: number;
  readonly declaredEnd?: number;
  readonly resumes?: number;
}

function assertSafeInt(name: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(
      `upload-session: ${name} must be a safe integer of at least ${String(min)} (got ${String(value)})`,
    );
  }
}

function assertPolicy(policy: TransferPolicy): void {
  assertSafeInt('maxResumes', policy.maxResumes, 0);
  assertSafeInt('backoffMs', policy.backoffMs, 0);
  if (Number.isNaN(policy.maxServerWaitMs) || policy.maxServerWaitMs < 0) {
    throw new RangeError(
      `upload-session: maxServerWaitMs must be a non-negative number (got ${String(policy.maxServerWaitMs)})`,
    );
  }
}

/**
 * Open a cursor. Throws a `RangeError` on a programming error (a non-integer or
 * out-of-range size/offset) — every media module validates caller input with
 * its own error shape before it gets here.
 */
export function createTransferCursor(init: TransferCursorInit): TransferCursor {
  assertSafeInt('total', init.total, 1);
  assertSafeInt('chunkSize', init.chunkSize, 1);
  const offset = init.offset ?? 0;
  assertSafeInt('offset', offset, 0);
  if (offset > init.total) {
    throw new RangeError(
      `upload-session: offset ${String(offset)} is past the ${String(init.total)}-byte file end`,
    );
  }
  const resumes = init.resumes ?? 0;
  assertSafeInt('resumes', resumes, 0);
  return {
    total: init.total,
    chunkSize: init.chunkSize,
    offset,
    ...(init.declaredEnd !== undefined ? { declaredEnd: init.declaredEnd } : {}),
    resumes,
    highWater: offset,
    stalls: 0,
  };
}

/** The cursor without a declared window (the next send is one fallback step). */
function withoutDeclaredEnd(cursor: TransferCursor): TransferCursor {
  return {
    total: cursor.total,
    chunkSize: cursor.chunkSize,
    offset: cursor.offset,
    resumes: cursor.resumes,
    highWater: cursor.highWater,
    stalls: cursor.stalls,
  };
}

/** `true` once every byte is acknowledged. */
export function isTransferComplete(cursor: TransferCursor): boolean {
  return cursor.offset >= cursor.total;
}

/** A byte window `[start, end)` of the file. */
export interface ChunkWindow {
  readonly start: number;
  readonly end: number;
}

/**
 * The window to send next. A server-declared end wins whenever it is sane (an
 * integer past `offset`, no further than the file end) — the legacy edge
 * expects exactly the range it asked for. Anything else falls back to one
 * `chunkSize` step, so a malformed response degrades instead of stalling. A
 * complete cursor yields the empty window `[total, total)`.
 */
export function nextChunkWindow(cursor: TransferCursor): ChunkWindow {
  const start = cursor.offset;
  const fallback = Math.min(start + cursor.chunkSize, cursor.total);
  const declared = cursor.declaredEnd;
  const end =
    declared === undefined ||
    !Number.isInteger(declared) ||
    declared <= start ||
    declared > cursor.total
      ? fallback
      : declared;
  return { start, end };
}

/**
 * Move a cursor to an externally probed server offset (the legacy edge re-reads
 * `bytes_transferred` before a re-drive). A probe value that is not an integer
 * in `[0, total]` is ignored. The declared window is dropped either way, so the
 * next chunk is one fallback step from the (possibly new) offset. Budgets are
 * untouched.
 */
export function rebaseTransferCursor(
  cursor: TransferCursor,
  probedOffset: number | undefined,
): TransferCursor {
  const usable =
    probedOffset !== undefined &&
    Number.isSafeInteger(probedOffset) &&
    probedOffset >= 0 &&
    probedOffset <= cursor.total;
  const rest = withoutDeclaredEnd(cursor);
  return usable ? { ...rest, offset: probedOffset } : rest;
}

// ---------------------------------------------------------------------------
// Transition: a 2xx chunk response
// ---------------------------------------------------------------------------

/** How the acknowledged offset relates to the window's start. */
export type AckMovement = 'advanced' | 'stalled' | 'rewound';

/** Outcome of {@link applyChunkAck}. */
export type ChunkAckOutcome =
  | {
      /** Keep going from `cursor` after sleeping `waitMs` (0 = at once). */
      readonly kind: 'continue';
      readonly movement: AckMovement;
      /** The acknowledged offset (server's word, or the window end on a silent 2xx). */
      readonly acked: number;
      /** The window start the ack is measured against. */
      readonly previous: number;
      /** `true` when the offset came from the server rather than from arithmetic. */
      readonly serverReported: boolean;
      readonly cursor: TransferCursor;
      readonly waitMs: number;
    }
  | {
      /** The non-advancing budget is spent; the driver fails the transfer. */
      readonly kind: 'exhausted';
      /**
       * Relative to the window start. Under `high-water` this can be `advanced`
       * (climbing back after a rewind without passing the high-water mark).
       */
      readonly movement: AckMovement;
      readonly acked: number;
      readonly previous: number;
      readonly serverReported: boolean;
      /**
       * Under `resume-budget`: the cursor BEFORE the ack (the offset was not
       * moved). Under `high-water`: the cursor AFTER it (the offset follows the
       * server's word; only the guard trips).
       */
      readonly cursor: TransferCursor;
    }
  | {
      /** The server named an offset past the file end: a desync, never "done". */
      readonly kind: 'overrun';
      readonly acked: number;
      readonly previous: number;
      readonly cursor: TransferCursor;
    };

/**
 * Apply one accepted chunk response to the cursor that produced the window.
 *
 * The acknowledged offset is the server's (`ack.offset`) when it named one;
 * otherwise a refusal stays at the window start and a silent 2xx is taken as
 * "the sent window landed". Past the file end is an `overrun`. Then:
 *
 *   * advanced past the window start — move there, adopt `ack.declaredEnd`;
 *   * stalled / rewound — bounded per {@link StallAccounting}.
 */
export function applyChunkAck(
  cursor: TransferCursor,
  ack: ChunkAck,
  policy: TransferPolicy,
): ChunkAckOutcome {
  assertPolicy(policy);
  const previous = cursor.offset;
  const window = nextChunkWindow(cursor);
  const serverReported = ack.offset !== undefined;
  const acked = ack.offset ?? (ack.refused ? previous : window.end);

  if (acked > cursor.total) {
    return { kind: 'overrun', acked, previous, cursor };
  }

  const movement: AckMovement =
    acked > previous ? 'advanced' : acked === previous ? 'stalled' : 'rewound';
  const passesHighWater = acked > cursor.highWater;
  const highWater = passesHighWater ? acked : cursor.highWater;
  const stalls = passesHighWater ? 0 : cursor.stalls + 1;
  const moved = (): TransferCursor => {
    const rest = withoutDeclaredEnd(cursor);
    return {
      ...rest,
      offset: acked,
      ...(ack.declaredEnd !== undefined ? { declaredEnd: ack.declaredEnd } : {}),
      highWater,
      stalls,
    };
  };

  if (policy.stallAccounting === 'high-water') {
    const next = moved();
    if (movement === 'advanced' && passesHighWater) {
      return {
        kind: 'continue',
        movement,
        acked,
        previous,
        serverReported,
        cursor: next,
        waitMs: 0,
      };
    }
    if (stalls > policy.maxResumes) {
      return {
        kind: 'exhausted',
        movement,
        acked,
        previous,
        serverReported,
        cursor: next,
      };
    }
    return {
      kind: 'continue',
      movement,
      acked,
      previous,
      serverReported,
      cursor: next,
      waitMs: acked < cursor.total ? resumeWaitMs(policy.backoffMs, stalls) : 0,
    };
  }

  // resume-budget
  if (movement === 'advanced') {
    return {
      kind: 'continue',
      movement,
      acked,
      previous,
      serverReported,
      cursor: moved(),
      waitMs: 0,
    };
  }
  if (cursor.resumes >= policy.maxResumes) {
    return { kind: 'exhausted', movement, acked, previous, serverReported, cursor };
  }
  const resumes = cursor.resumes + 1;
  if (movement === 'stalled') {
    const rest = withoutDeclaredEnd(cursor);
    return {
      kind: 'continue',
      movement,
      acked,
      previous,
      serverReported,
      cursor: { ...rest, resumes, highWater, stalls },
      waitMs: resumeWaitMs(policy.backoffMs, resumes),
    };
  }
  return {
    kind: 'continue',
    movement,
    acked,
    previous,
    serverReported,
    cursor: { ...moved(), resumes },
    waitMs: 0,
  };
}

// ---------------------------------------------------------------------------
// Transition: a failed chunk request
// ---------------------------------------------------------------------------

/** Outcome of {@link applyChunkFault}. Only `resume` continues the loop. */
export type ChunkFaultOutcome =
  /** The caller cancelled: rethrow untouched, keep the session resumable. */
  | { readonly kind: 'abort' }
  /** Not resumable under the policy: fail the transfer with this fault. */
  | { readonly kind: 'fatal' }
  /** Resumable, but the server-named wait exceeds the cap: surface it, no budget spent. */
  | { readonly kind: 'deferred'; readonly waitMs: number }
  /** Resumable, but the budget is spent. */
  | { readonly kind: 'exhausted'; readonly resumes: number }
  /**
   * Re-drive from `cursor.offset` (the last acknowledged offset, never a stale
   * server one) after sleeping `waitMs`. The declared window is dropped, so the
   * re-drive is one fallback step; a driver that probes the server offset first
   * applies {@link rebaseTransferCursor} to `cursor`.
   */
  | {
      readonly kind: 'resume';
      readonly cursor: TransferCursor;
      readonly attempt: number;
      readonly waitMs: number;
      readonly serverWaitMs?: number;
    };

/**
 * Decide what a failed chunk request means. Order: abort, then resumability,
 * then the server-wait cap (which spends no budget), then the budget.
 */
export function applyChunkFault(
  cursor: TransferCursor,
  err: unknown,
  policy: TransferPolicy,
): ChunkFaultOutcome {
  assertPolicy(policy);
  if (isAbortError(err)) return { kind: 'abort' };
  if (!policy.isResumable(err)) return { kind: 'fatal' };
  const serverWaitMs = serverWaitMsOf(err);
  if (serverWaitMs !== undefined && serverWaitMs > policy.maxServerWaitMs) {
    return { kind: 'deferred', waitMs: serverWaitMs };
  }
  if (cursor.resumes >= policy.maxResumes) {
    return { kind: 'exhausted', resumes: cursor.resumes };
  }
  const attempt = cursor.resumes + 1;
  const rest = withoutDeclaredEnd(cursor);
  return {
    kind: 'resume',
    cursor: { ...rest, resumes: attempt },
    attempt,
    waitMs: resumeWaitMs(policy.backoffMs, attempt, serverWaitMs),
    ...(serverWaitMs !== undefined ? { serverWaitMs } : {}),
  };
}
