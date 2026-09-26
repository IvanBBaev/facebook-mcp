// Reels three-phase publish flow for a Facebook Page (task V06, `api` layer).
//
// Reels are NOT "a video post with a flag". Meta gives them their own edge
// (`/{page-id}/video_reels`) and their own three-phase protocol, so this module
// is deliberately separate from the resumable *video* upload (task V05). The
// three phases:
//
//   1. start    POST /{page-id}/video_reels?upload_phase=start
//               → { video_id, upload_url }
//   2. transfer POST <upload_url on rupload.facebook.com>
//               raw binary, `Authorization: OAuth <token>` + offset headers,
//               resuming from the SERVER-reported offset (CC-MEDIA-2)
//   3. finish   POST /{page-id}/video_reels?upload_phase=finish
//               &video_id=…&video_state=PUBLISHED|DRAFT|SCHEDULED&description=…
//
// Design decisions (justified against the corpus):
//   * Dependency-injected, no module-level mutable state. Every function takes
//     {@link ReelsDeps} (an `FbRequestFn`, a `Logger`, a `Clock` and the two wire
//     settings it needs) so the tool layer owns lifetime and the tests own the
//     wire. The only module-level values are frozen constants and lookup tables.
//   * Every phase result is an EXPLICIT exported type. The tool layer (V03) maps
//     them to a `ToolResult`; this layer never shapes, truncates or redacts.
//   * The transfer loop follows the server's offset, not its own arithmetic. A
//     successful chunk response may report `file_offset`; when it does, that
//     number — not `offset + chunk.byteLength` — decides where the next chunk
//     starts, and a transient failure resumes from the last server-reported
//     offset (CC-MEDIA-2). `core/http-upload.ts` already resumes *inside* one
//     chunk POST; this loop resumes *across* chunks once that inner bound is
//     exhausted, so the two layers agree instead of competing.
//   * No local media probe (C10 / CC-MEDIA-9). We do not decode the file to
//     pre-check 9:16 / 540×960 / 3–90 s. Meta enforces the spec and we surface
//     its verdict with the PHASE NAMED, because "upload failed" without a phase
//     is unactionable: a start failure means permissions/params, a transfer
//     failure means bytes/session, a finish failure means the media or the
//     schedule was rejected.
//   * Scheduling is validated, never silently accepted (CC-SCHED-2/3). Graph
//     stores `scheduled_publish_time` as a UTC Unix timestamp; the Page's own
//     timezone only changes how Meta DISPLAYS it. We therefore echo the instant
//     back plus an explicit Page-timezone caveat rather than doing any local-time
//     arithmetic on the server.
//   * The rolling per-Page Reels publishing cap (CC-MEDIA-8) is MAPPED, not
//     swallowed: a cap error becomes a {@link ReelPublishError} whose
//     `reel.kind === 'quota'` and whose operator text names the cap and the
//     reset estimate, so the tool layer can say "quota exhausted, retry after …"
//     instead of "publish failed".
//
// Verified-vs-assumed boundary (read this before trusting a lifecycle claim):
// each {@link ReelLifecycleNote} and each quota signature row carries its own
// `verification` / `verified` flag. Anything marked `assumed` is an open Phase-2
// question (G-TOOL-3) and is written down here rather than guessed silently.

import {
  DEFAULT_THROTTLE_RETRY_AFTER_MS,
  errorMessageOf,
  GraphApiError,
  parseFileOffset,
} from '../core/index.js';
import type {
  Clock,
  ErrorAction,
  ErrorCategory,
  FbResponse,
  FbRequestFn,
  GraphApiErrorInit,
  Logger,
  ProgressReporter,
  ProgressUpdate,
  Settings,
} from '../core/index.js';

// ---------------------------------------------------------------------------
// 1. Constants — the Reels contract in one scannable block
// ---------------------------------------------------------------------------

/** The Page edge that owns the whole Reels lifecycle (publish AND read). */
export const REEL_EDGE = 'video_reels';

/** First path segment of the rupload target, per Meta's `upload_url`. */
export const REEL_UPLOAD_PATH_PREFIX = 'video-upload';

/**
 * `video_state` values the finish phase accepts. Frozen tuple so the tool layer
 * can build its enum from the same source instead of re-typing the strings.
 */
export const REEL_VIDEO_STATES = ['PUBLISHED', 'DRAFT', 'SCHEDULED'] as const;

/** Publish disposition passed to the finish phase. */
export type ReelVideoState = (typeof REEL_VIDEO_STATES)[number];

/** The three phases, in order. Every failure is attributed to exactly one. */
export const REEL_PHASES = ['start', 'transfer', 'finish'] as const;

/** Which phase a failure happened in (CC-MEDIA-9 — always surfaced). */
export type ReelPhase = (typeof REEL_PHASES)[number];

/** Default rupload chunk size. Overridable per call via {@link ReelsDeps}. */
export const REEL_CHUNK_BYTES = 4 * 1024 * 1024;

/** How many times the transfer loop may resume before giving up. */
export const REEL_MAX_RESUME_ATTEMPTS = 5;

/**
 * Base wait before a transfer re-drive (a resumed chunk after a transient fault,
 * or a re-send after a POST that left the offset where it was); scaled linearly
 * by the attempt number. Without it the whole resume budget burns in
 * milliseconds against the very outage it is meant to ride out.
 */
export const REEL_RESUME_BACKOFF_MS = 250;

/**
 * Longest server-named wait (`retryAfterMs`, from a `Retry-After`) the transfer
 * loop sleeps through before a re-drive. A longer one surfaces at once with the
 * wait attached, so the caller schedules the retry instead of this call holding
 * the upload open — or, worse, re-driving straight into the announced window.
 */
export const REEL_MAX_RESUME_WAIT_MS = 30_000;

/**
 * Reels scheduling window: strictly MORE than 10 minutes ahead and no more than
 * 29 days out. Tighter than the feed's 10 min – 75 days window — a Reels-specific
 * rule, which is exactly why this module does not reuse the feed scheduler.
 */
export const REEL_SCHEDULE_MIN_LEAD_MS = 10 * 60 * 1000;

/** Upper bound of the Reels scheduling window (29 days). */
export const REEL_SCHEDULE_MAX_LEAD_MS = 29 * 24 * 60 * 60 * 1000;

/** Documented cap: 30 API-published Reels per Page per rolling 24 h (CC-MEDIA-8). */
export const REEL_QUOTA_PER_24H = 30;

/**
 * Fallback reset hint when Graph supplies no `estimated_time_to_regain_access`.
 * The window is ROLLING, so a slot frees when the oldest of the last
 * {@link REEL_QUOTA_PER_24H} publishes ages out — i.e. at most 24 h, usually less.
 */
export const REEL_QUOTA_DEFAULT_RESET_MS = 24 * 60 * 60 * 1000;

/** The Page-timezone caveat echoed with every SCHEDULED result (CC-SCHED-2/3). */
export const REEL_TIMEZONE_CAVEAT =
  'Graph stores scheduled_publish_time as a UTC Unix timestamp; the Page timezone only changes how Meta DISPLAYS it. Confirm the echoed UTC instant is the one you meant — this server performs no local-time arithmetic.';

/**
 * Why `success: true` from the finish phase is not "it is live" (CC-MEDIA-7).
 */
export const REEL_PROCESSING_NOTE =
  'Graph ACCEPTED the finish call; encoding and publishing continue asynchronously. success:true is acceptance, not visibility — poll GET /{video-id}?fields=status before reporting the Reel as live.';

// ---------------------------------------------------------------------------
// 2. Injected dependencies
// ---------------------------------------------------------------------------

/**
 * Everything this module needs from the outside. `settings` is a `Pick` rather
 * than the whole `Settings` so a caller can pass `ctx.settings` directly while a
 * test builds a two-field literal — no fake config object required.
 */
export interface ReelsDeps {
  readonly fbRequest: FbRequestFn;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly settings: Pick<Settings, 'apiVersion' | 'hosts'>;
  /** Cancellation seam (MCP cancel / shutdown); forwarded to every request. */
  readonly signal?: AbortSignal;
  /** Optional byte-level progress for long transfers. */
  readonly onProgress?: ProgressReporter;
  /** Chunk size override; defaults to {@link REEL_CHUNK_BYTES}. */
  readonly chunkBytes?: number;
  /** Resume budget override; defaults to {@link REEL_MAX_RESUME_ATTEMPTS}. */
  readonly maxResumeAttempts?: number;
  /** Base re-drive backoff; defaults to {@link REEL_RESUME_BACKOFF_MS}. 0 disables the local backoff (a server-named wait is still honoured). */
  readonly resumeBackoffMs?: number;
}

// ---------------------------------------------------------------------------
// 3. Failure classification (CC-MEDIA-8 / CC-MEDIA-9)
// ---------------------------------------------------------------------------

/**
 * The Reels-level meaning of a failure. This is FINER than the frozen
 * `ErrorCategory` in `core/types.ts`, which has no `quota` member — we do not
 * widen a frozen contract from the `api` layer, so the Reels-specific verdict
 * rides here and the frozen `ErrorAction.category` keeps its nearest legal value.
 *
 *   * `quota`       — the rolling Reels publishing cap (CC-MEDIA-8).
 *   * `schedule`    — a `scheduled_publish_time` this module rejected locally.
 *   * `constraint`  — Meta rejected the media or the params (spec violation).
 *   * `session`     — the upload session desynced/expired; restart from `start`.
 *   * `transient`   — transport fault; the same phase may be retried.
 *   * `ambiguous`   — the write may have landed; verify, never re-publish (C2).
 *   * `passthrough` — no Reels-specific meaning; read `error.action.category`.
 */
export type ReelFailureKind =
  | 'quota'
  | 'schedule'
  | 'constraint'
  | 'session'
  | 'transient'
  | 'ambiguous'
  | 'passthrough';

/** The mapped verdict for one failure. Attached to every {@link ReelPublishError}. */
export interface ReelFailure {
  readonly kind: ReelFailureKind;
  readonly phase: ReelPhase;
  /** Nearest legal member of the frozen `ErrorCategory` union. */
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly operatorText: string;
  /** Surfaced estimate only — never a sleep instruction (CC-NET-3). */
  readonly retryAfterMs?: number;
  /** Suggested next tool for the model, when this module can improve on Graph's. */
  readonly nextTool?: string;
  /** Id of the matched quota signature (only when `kind === 'quota'`). */
  readonly signatureId?: string;
  /** false ⇒ the mapping rests on an inferred, not doc-confirmed, signature. */
  readonly verified: boolean;
  /**
   * The reserved `video_id` the failure concerns, once one exists (finish
   * phase). It is the only handle that addresses the Reel on
   * `GET /{video-id}?fields=status`, so an operator verifying an ambiguous
   * publish needs it.
   */
  readonly videoId?: string;
}

/**
 * A `{code, subcode}` family the rolling Reels cap is known or expected to
 * arrive on.
 *
 * `codeOnly: false` means the code family is SHARED with unrelated throttles, so
 * the row only fires when the message also names the Reels cap. That gate is
 * deliberate: mapping a bare 60-second app throttle to "Reels quota exhausted"
 * would tell the operator to wait a day for something that clears in a minute.
 *
 * Today every row is message-gated, because no `{code, subcode}` pair is
 * documented as Reels-cap-exclusive. ✎ Phase 2: once a live run pins one down,
 * flip its `codeOnly` to true and the mapping stops depending on Meta's wording.
 */
interface ReelQuotaSignature {
  readonly id: string;
  readonly code: number;
  /** Inclusive upper bound for a code RANGE; omitted ⇒ exact `code` match. */
  readonly codeMax?: number;
  /** Exact subcode requirement; omitted ⇒ any subcode. */
  readonly subcode?: number;
  readonly codeOnly: boolean;
  /** true ⇒ the code family itself is documented; false ⇒ inferred. */
  readonly verified: boolean;
  readonly note: string;
}

const REEL_QUOTA_SIGNATURES: readonly ReelQuotaSignature[] = [
  {
    id: 'quota-buc-family',
    code: 80000,
    codeMax: 80099,
    codeOnly: false,
    verified: true,
    note: 'Business-use-case rate-limit family; the Reels bucket reports here.',
  },
  {
    id: 'quota-page-throttle',
    code: 32,
    codeOnly: false,
    verified: true,
    note: 'Page-level throttle; shared with non-Reels traffic, hence message-gated.',
  },
  {
    id: 'quota-app-throttle',
    code: 4,
    codeOnly: false,
    verified: true,
    note: 'App-level throttle; shared with non-Reels traffic, hence message-gated.',
  },
  {
    id: 'quota-policy-block',
    code: 368,
    codeOnly: false,
    verified: false,
    note: 'Temporary policy block; ✎ assumed to be one of the shapes the cap takes.',
  },
];

/**
 * Message shapes Graph uses for the cap. ✎ Assumed (wording is not a contract) —
 * which is why {@link ReelFailure.verified} is false for a message-only match.
 */
const REEL_QUOTA_MESSAGE_PATTERNS: readonly RegExp[] = [
  /reach(?:ed|ing)?[^.]{0,80}(?:limit|maximum|max|cap|quota)[^.]{0,80}reels?/i,
  /reels?[^.]{0,80}(?:limit|cap|quota)[^.]{0,80}(?:reach(?:ed)?|exceed(?:ed)?|hit)/i,
  /(?:daily|24[\s-]?hours?|per[\s-]?day)[^.]{0,60}reels?[^.]{0,60}(?:limit|cap|quota)/i,
  /reels?[^.]{0,60}(?:per|in)[^.]{0,20}24[\s-]?hours?/i,
];

function namesReelCap(message: string): boolean {
  return REEL_QUOTA_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

function matchQuotaSignature(
  code: number,
  subcode: number | undefined,
): ReelQuotaSignature | undefined {
  return REEL_QUOTA_SIGNATURES.find((row) => {
    const upper = row.codeMax ?? row.code;
    if (code < row.code || code > upper) return false;
    return row.subcode === undefined || row.subcode === subcode;
  });
}

/**
 * True when this error is the rolling Reels publishing cap rather than a generic
 * failure. Exported so the tool layer can branch without re-deriving the rules.
 */
export function isReelQuotaError(err: unknown): boolean {
  if (err instanceof ReelPublishError) return err.reel.kind === 'quota';
  if (!(err instanceof GraphApiError)) return false;
  const row = matchQuotaSignature(err.code, err.subcode);
  if (row?.codeOnly === true) return true;
  if (!namesReelCap(err.message)) return false;
  if (row !== undefined) return true;

  // No code family corroborates the wording, so the message is the only signal
  // left - and Meta rejects an out-of-spec Reel in the cap's own vocabulary
  // ("the Reels duration limit ... reached"). The cap itself always arrives as a
  // throttle, a policy block or an undocumented code; it is never reported as a
  // parameter validation failure. So when core has already read the error as
  // validation/not_found, that verdict outranks the wording: the file is out of
  // spec, and answering "wait ~24 h" would bury a fix that takes a minute.
  // Anything else keeps the message-only path, which is what catches a genuine
  // cap on a code Meta has not documented (`quota-message-only`).
  const category = err.action?.category;
  return category !== 'validation' && category !== 'not_found';
}

function quotaOperatorText(retryAfterMs: number | undefined, estimated: boolean): string {
  const window = `Reels publishing quota exhausted for this Page: Meta caps API-published Reels at ${String(REEL_QUOTA_PER_24H)} per rolling 24 h.`;
  const when =
    retryAfterMs === undefined
      ? 'Graph gave no reset estimate.'
      : estimated
        ? `Graph did not supply an ETA, so assume at most ${String(Math.round(REEL_QUOTA_DEFAULT_RESET_MS / 60_000))} minutes — a slot frees as the oldest recent publish ages out of the window.`
        : `Graph estimates access returns in about ${String(Math.round(retryAfterMs / 60_000))} minutes.`;
  return `${window} ${when} Nothing was published by this call. Do not retry in a loop — check facebook_usage and re-run once a slot is free.`;
}

/** Text for a session that can no longer be resumed (CC-MEDIA-1/3). */
const REEL_SESSION_TEXT =
  'The Reels upload session can no longer be resumed (offset desync or expiry). Upload state lives in memory for one server lifetime only — restart from the start phase with a fresh session; do not silently re-create one mid-flight.';

function constraintText(phase: ReelPhase, message: string): string {
  const spec =
    'Reels constraints Meta enforces server-side: 9:16 aspect, at least 540×960, 3–90 s duration, MP4/MOV.';
  const where =
    phase === 'finish'
      ? 'The bytes transferred but the finish phase rejected the media or the parameters.'
      : phase === 'start'
        ? 'The start phase rejected the request before any bytes moved — check the Page id, the token and the pages_manage_posts permission.'
        : 'The transfer phase rejected the bytes.';
  return `Reels ${phase} phase rejected: ${message} ${where} ${spec} This server does not decode the file locally, so Meta's verdict is the only spec check.`;
}

/**
 * The ambiguous verdict WITHOUT a read instruction. The finish phase appends
 * its own, keyed on the requested `video_state` (see {@link reelVerifyToolFor}
 * and `withReelVideoId`), so the text and the surfaced `nextTool` can never
 * name two different reads.
 */
const REEL_AMBIGUOUS_BASE_TEXT =
  'The Reels write may or may not have landed and Graph offers no idempotency key, so it is NEVER retried automatically. Verify before acting: a Reel does NOT appear on /feed, /posts or /published_posts (facebook_list_posts), so a feed listing will look empty even on success.';

/**
 * A lost response on the start or transfer POST. Core stamps every such write
 * `ambiguous` because it cannot know what the POST does, but here we do: start
 * only reserves an upload session and a rupload chunk only stores bytes, so no
 * Reel can be live and no listing can show the outcome. Telling the caller the
 * Reel "may have landed" and to verify on `/video_reels` sends them to a read
 * that is always empty and withholds the one safe move — re-running the
 * publish, which reserves a fresh `video_id`.
 */
function preFinishAmbiguousText(phase: ReelPhase, message: string): string {
  const what =
    phase === 'start'
      ? 'the start POST only reserves an upload session, so at worst an unreturned video_id was reserved and left unfinished'
      : 'a chunk POST only stores bytes in an upload session that was never finished';
  return `The Reels ${phase} request lost its response (${message}). Nothing was published: only the finish phase publishes a Reel, and ${what}. There is nothing to verify on /video_reels or any other listing, so the generic "verify first" advice does not apply here. Re-running the publish is safe — it reserves a fresh video_id and re-uploads.`;
}

/**
 * The read that can show whether a finish with this `video_state` landed.
 *
 *   * `PUBLISHED` — `facebook_list_reels` (the `/video_reels` edge, the only
 *     listing a published Reel is on).
 *   * `DRAFT` / `SCHEDULED` — whether such a Reel is listed on `/video_reels`
 *     is unverified (see the lifecycle notes), so an empty listing proves
 *     nothing. The finish error carries the reserved `video_id`, which
 *     `facebook_get_video_status` reads directly (`GET /{video-id}?fields=status`).
 *
 * Start and transfer name none: start only reserves an id no listing shows, and
 * a rupload chunk is offset-idempotent, never an ambiguous write.
 */
export function reelVerifyToolFor(videoState: ReelVideoState): string {
  return videoState === 'PUBLISHED' ? 'facebook_list_reels' : 'facebook_get_video_status';
}

/**
 * Map any thrown value to a Reels-level verdict. Pure and idempotent: passing a
 * {@link ReelPublishError} back in returns the verdict it already carries.
 */
export function classifyReelFailure(err: unknown, phase: ReelPhase): ReelFailure {
  if (err instanceof ReelPublishError) return err.reel;

  if (!(err instanceof GraphApiError)) {
    // The transport rethrows the CALLER's abort untouched (it is the one fault
    // core does not classify), so it reaches here as a plain non-Graph throw.
    // In the finish phase that is not "nothing happened": the finish POST is
    // the write that publishes, and cancelling a request already on the wire
    // loses the response, not the write. Same verdict as a 5xx or a timeout on
    // this POST (C2): ambiguous, never retried, verify on the read edge. A
    // `passthrough` here would be journaled as a clean failure and invite a
    // re-run that publishes a second Reel. Start and transfer keep the
    // passthrough: nothing is published before finish.
    if (phase === 'finish' && isAbortError(err)) {
      return {
        kind: 'ambiguous',
        phase,
        category: 'ambiguous',
        retryable: false,
        operatorText: `${REEL_AMBIGUOUS_BASE_TEXT} (phase: finish; the finish request was aborted by the caller after it may have reached Graph)`,
        verified: true,
      };
    }
    return {
      kind: 'passthrough',
      phase,
      category: 'unknown',
      retryable: false,
      operatorText: `Reels ${phase} phase failed with a non-Graph error: ${messageOf(err)}`,
      verified: false,
    };
  }

  const action = err.action;

  // 1. Quota first — it is the one verdict a generic category would hide.
  if (isReelQuotaError(err)) {
    const row = matchQuotaSignature(err.code, err.subcode);
    // Core's throttle rows stamp a generic 60 s default into `retryAfterMs`
    // when the envelope carries no ETA, and the documented throttle cap families
    // (4, 32, 80000-80099) are such rows (368 is a policy row and carries no
    // default, so it arrives here as "no ETA" already). That figure is core's guess, not Graph's
    // estimate: echoing it as "Graph estimates about 1 minute" for a rolling 24 h
    // cap sends the operator back 1439 minutes early. The error does not carry
    // the raw envelope ETA, so an exact match on the default is read as "no ETA";
    // a genuine 1-minute ETA then falls back to the 24 h upper bound, which is
    // still a true statement ("at most"), whereas the opposite mistake is not.
    const fromGraph =
      action?.retryAfterMs === DEFAULT_THROTTLE_RETRY_AFTER_MS
        ? undefined
        : action?.retryAfterMs;
    const retryAfterMs = fromGraph ?? REEL_QUOTA_DEFAULT_RESET_MS;
    return {
      kind: 'quota',
      phase,
      // `ErrorCategory` has no `quota` member and is frozen; `rate_limit` is its
      // nearest legal value. `reel.kind` carries the precise verdict.
      category: 'rate_limit',
      // Deliberately NOT retryable: a rolling-24h wait must never become an
      // in-process sleep. The operator (or the model) re-runs later.
      retryable: false,
      operatorText: quotaOperatorText(retryAfterMs, fromGraph === undefined),
      retryAfterMs,
      nextTool: action?.nextTool ?? 'facebook_usage',
      signatureId: row?.id ?? 'quota-message-only',
      // Verified only when a documented code family AND the message agree.
      verified: row?.verified === true,
    };
  }

  // 2. A desynced/expired upload session — core raises this as a validation-class
  //    error whose message asks for a restart.
  if (/restart the upload|upload session|outside chunk window/i.test(err.message)) {
    return {
      kind: 'session',
      phase,
      category: action?.category ?? 'validation',
      retryable: false,
      operatorText: REEL_SESSION_TEXT,
      verified: true,
    };
  }

  switch (action?.category) {
    case 'transient':
      return {
        kind: 'transient',
        phase,
        category: 'transient',
        retryable: true,
        operatorText: `Transport fault during the Reels ${phase} phase: ${err.message}. The ${phase} phase is safe to re-drive — a chunk POST is offset-idempotent.`,
        ...(action.retryAfterMs !== undefined
          ? { retryAfterMs: action.retryAfterMs }
          : {}),
        verified: true,
      };
    case 'ambiguous':
      if (phase !== 'finish') {
        // Unknown outcome, but of a write that publishes nothing: safe to re-run.
        return {
          kind: 'ambiguous',
          phase,
          category: 'ambiguous',
          retryable: true,
          operatorText: preFinishAmbiguousText(phase, err.message),
          verified: true,
        };
      }
      return {
        kind: 'ambiguous',
        phase,
        category: 'ambiguous',
        retryable: false,
        operatorText: `${REEL_AMBIGUOUS_BASE_TEXT} (phase: ${phase}; Graph said: ${err.message})`,
        ...(action.nextTool !== undefined ? { nextTool: action.nextTool } : {}),
        verified: true,
      };
    case 'validation':
    case 'not_found':
      return {
        kind: 'constraint',
        phase,
        category: action.category,
        retryable: false,
        operatorText: constraintText(phase, err.message),
        verified: true,
      };
    default:
      return {
        kind: 'passthrough',
        phase,
        category: action?.category ?? 'unknown',
        retryable: action?.retryable ?? false,
        operatorText:
          action?.operatorText ?? `Reels ${phase} phase failed: ${err.message}`,
        ...(action?.retryAfterMs !== undefined
          ? { retryAfterMs: action.retryAfterMs }
          : {}),
        ...(action?.nextTool !== undefined ? { nextTool: action.nextTool } : {}),
        verified: true,
      };
  }
}

/**
 * A Reels failure carrying its phase and its Reels-level verdict.
 *
 * Subclasses `GraphApiError` so the existing server-side error rendering keeps
 * working unchanged; the extra `reel` field is what lets the tool layer say
 * "quota exhausted, retry after …" instead of "publish failed". The base
 * constructor pins the prototype to `GraphApiError.prototype`, so the prototype
 * is re-pinned here — without that, `instanceof ReelPublishError` would be false.
 */
export class ReelPublishError extends GraphApiError {
  override readonly name = 'ReelPublishError';

  readonly reel: ReelFailure;

  constructor(message: string, init: GraphApiErrorInit & { readonly reel: ReelFailure }) {
    super(message, init);
    this.reel = init.reel;
    Object.setPrototypeOf(this, ReelPublishError.prototype);
  }
}

/** Type guard for {@link ReelPublishError}. */
export function isReelPublishError(err: unknown): err is ReelPublishError {
  return err instanceof ReelPublishError;
}

function actionFor(failure: ReelFailure): ErrorAction {
  return {
    category: failure.category,
    retryable: failure.retryable,
    operatorText: failure.operatorText,
    ...(failure.nextTool !== undefined ? { nextTool: failure.nextTool } : {}),
    ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
  };
}

/**
 * Wrap whatever a phase threw into a {@link ReelPublishError}, preserving the
 * original code/subcode/type/fbtrace id and keeping it as `cause`. Mapping, not
 * swallowing: nothing about Graph's answer is discarded.
 */
export function wrapReelError(err: unknown, phase: ReelPhase): ReelPublishError {
  if (err instanceof ReelPublishError) return err;
  const failure = classifyReelFailure(err, phase);
  const base = err instanceof GraphApiError ? err : undefined;
  return new ReelPublishError(`Reels ${phase} phase failed: ${messageOf(err)}`, {
    code: base?.code ?? 0,
    ...(base?.subcode !== undefined ? { subcode: base.subcode } : {}),
    ...(base?.type !== undefined ? { type: base.type } : {}),
    ...(base?.fbtraceId !== undefined ? { fbtraceId: base.fbtraceId } : {}),
    ...(base?.userTitle !== undefined ? { userTitle: base.userTitle } : {}),
    ...(base?.userMessage !== undefined ? { userMessage: base.userMessage } : {}),
    httpStatus: base?.httpStatus ?? 0,
    action: actionFor(failure),
    cause: err,
    reel: failure,
  });
}

/** Build a locally raised (no Graph round trip) Reels failure. */
function localReelError(
  phase: ReelPhase,
  kind: ReelFailureKind,
  category: ErrorCategory,
  message: string,
): ReelPublishError {
  const failure: ReelFailure = {
    kind,
    phase,
    category,
    retryable: false,
    operatorText: message,
    verified: true,
  };
  return new ReelPublishError(message, {
    code: 0,
    httpStatus: 0,
    action: actionFor(failure),
    reel: failure,
  });
}

/**
 * Re-raise a finish-phase failure naming the `video_id` it concerns.
 *
 * By the finish phase a `video_id` is reserved and every byte is on Meta's side,
 * and that id is the only direct handle on the Reel. An `ambiguous` finish tells
 * the operator to verify before acting; without the id they are left scanning
 * the Page's whole Reels edge for a video they cannot identify. The Graph
 * envelope (code, subcode, type, trace id, status, cause) is carried over.
 */
function withReelVideoId(
  err: ReelPublishError,
  videoId: string,
  verifyTool: string,
): ReelPublishError {
  if (err.reel.videoId !== undefined) return err;
  const ambiguous = err.reel.kind === 'ambiguous';
  const handle = !ambiguous
    ? `The upload reserved video_id ${videoId} (all bytes transferred); read GET /${videoId}?fields=status to inspect it.`
    : verifyTool === 'facebook_list_reels'
      ? `This Reel is video_id ${videoId}: verify via facebook_list_reels (GET /{page-id}/video_reels; an item with id ${videoId} means it was published) before doing anything else. facebook_get_video_status (GET /${videoId}?fields=status) then reads its processing state.`
      : `This Reel is video_id ${videoId}: verify via facebook_get_video_status with video_id ${videoId} (GET /${videoId}?fields=status) before doing anything else. Whether a DRAFT or SCHEDULED Reel is listed on facebook_list_reels (/video_reels) is unverified, so an empty listing is not proof the write was lost.`;
  const reel: ReelFailure = {
    ...err.reel,
    operatorText: `${err.reel.operatorText} ${handle}`,
    // Only the ambiguous verdict asks for verification; the other kinds keep
    // whatever next step they already carried.
    ...(ambiguous ? { nextTool: verifyTool } : {}),
    videoId,
  };
  return new ReelPublishError(`${err.message} (video_id ${videoId})`, {
    code: err.code,
    ...(err.subcode !== undefined ? { subcode: err.subcode } : {}),
    ...(err.type !== undefined ? { type: err.type } : {}),
    ...(err.fbtraceId !== undefined ? { fbtraceId: err.fbtraceId } : {}),
    httpStatus: err.httpStatus,
    action: actionFor(reel),
    ...(err.userTitle !== undefined ? { userTitle: err.userTitle } : {}),
    ...(err.userMessage !== undefined ? { userMessage: err.userMessage } : {}),
    ...(err.cause !== undefined ? { cause: err.cause } : {}),
    reel,
  });
}

// ---------------------------------------------------------------------------
// 4. Lifecycle notes — the verified/assumed boundary (CC-MEDIA-9, G-TOOL-3)
// ---------------------------------------------------------------------------

/**
 * One durable fact (or open question) about how a Reel behaves after publishing.
 * `verification` is part of the payload on purpose: an operator acting on an
 * `assumed` note needs to know it is assumed.
 */
export interface ReelLifecycleNote {
  readonly id: string;
  readonly verification: 'verified' | 'assumed';
  readonly text: string;
}

/** Notes that apply to every Reel regardless of `video_state`. */
export const REEL_LIFECYCLE_NOTES: readonly ReelLifecycleNote[] = [
  {
    id: 'reel-read-edge',
    verification: 'verified',
    text: `A Reel is invisible to the post read endpoints: it does not appear on /feed, /posts or /published_posts. List Reels via GET /{page-id}/${REEL_EDGE}.`,
  },
  {
    id: 'reel-is-a-video-object',
    verification: 'verified',
    text: 'A Reel is a VIDEO object identified by a bare video id, not a {page-id}_{post-id} feed pair. Anything keyed on the feed-post id shape will not address it.',
  },
  {
    id: 'reel-delete-path',
    verification: 'assumed',
    text: '✎ UNVERIFIED (G-TOOL-3, Phase 2): whether facebook_delete_post accepts a Reel video id, or whether Reels need their own delete path. The docs are ambiguous here; do not assume the feed delete path works.',
  },
  {
    id: 'reel-processing-async',
    verification: 'verified',
    text: REEL_PROCESSING_NOTE,
  },
];

const REEL_STATE_NOTES: Readonly<Record<ReelVideoState, readonly ReelLifecycleNote[]>> = {
  PUBLISHED: [
    {
      id: 'reel-published',
      verification: 'verified',
      text: 'video_state=PUBLISHED goes live as soon as Meta finishes encoding; there is no second confirm step, so this is effectively irreversible from the model side.',
    },
  ],
  DRAFT: [
    {
      id: 'reel-draft',
      verification: 'verified',
      text: 'video_state=DRAFT is not publicly visible; it waits in Meta Business Suite for a human to publish it.',
    },
    {
      id: 'reel-draft-readback',
      verification: 'assumed',
      text: `✎ UNVERIFIED (G-TOOL-3, Phase 2): whether a DRAFT Reel is readable via GET /{page-id}/${REEL_EDGE} or only in Business Suite. If a read-back comes up empty, that is not proof the draft was lost.`,
    },
  ],
  SCHEDULED: [
    {
      id: 'reel-scheduled-window',
      verification: 'verified',
      text: 'video_state=SCHEDULED requires scheduled_publish_time strictly more than 10 minutes ahead and within 29 days — a tighter window than a scheduled feed post (10 min – 75 days).',
    },
    {
      id: 'reel-scheduled-visibility',
      verification: 'assumed',
      text: `✎ UNVERIFIED (G-TOOL-3, Phase 2): where a SCHEDULED Reel is listed before it goes live — /scheduled_posts, /${REEL_EDGE}, or both. The docs do not settle it; check both edges rather than assuming /scheduled_posts.`,
    },
  ],
};

/** The lifecycle notes relevant to one `video_state`, general notes first. */
export function reelLifecycleNotes(state: ReelVideoState): readonly ReelLifecycleNote[] {
  return [...REEL_LIFECYCLE_NOTES, ...REEL_STATE_NOTES[state]];
}

// ---------------------------------------------------------------------------
// 5. Scheduling (CC-SCHED-2/3)
// ---------------------------------------------------------------------------

/** What the caller asked for, echoed back with the caveats attached. */
export interface ReelScheduleEcho {
  /** Exactly what goes on the wire as `scheduled_publish_time` (Unix SECONDS). */
  readonly epochSeconds: number;
  /** The same instant in UTC ISO-8601, for the operator to sanity-check. */
  readonly utc: string;
  /** Milliseconds from "now" to the requested instant. */
  readonly leadMs: number;
  readonly windowNote: string;
  /** The Page's IANA timezone when the caller knew it; display-only. */
  readonly pageTimezone?: string;
  readonly timezoneCaveat: string;
}

const REEL_SCHEDULE_WINDOW_NOTE = `Accepted Reels scheduling window: strictly more than ${String(REEL_SCHEDULE_MIN_LEAD_MS / 60_000)} minutes ahead and at most ${String(REEL_SCHEDULE_MAX_LEAD_MS / (24 * 60 * 60 * 1000))} days out.`;

/**
 * Upper bound on a value that can still plausibly be Unix SECONDS (year 5138).
 *
 * Unit confusion is the classic scheduling bug, and a millisecond timestamp is a
 * perfectly valid safe integer, so the range check is what catches it: any epoch
 * expressed in milliseconds for a date after 1973 is far above this bound. The
 * value is rejected rather than divided by 1000, because guessing the caller's
 * unit is how a Reel gets published at the wrong time.
 */
const REEL_MAX_PLAUSIBLE_EPOCH_SECONDS = 100_000_000_000;

function toUtcIso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

/**
 * Validate the requested publish time against the Reels window and build the
 * echo. Returns `undefined` for the non-scheduled states.
 *
 * Throws when the state and the time disagree, so a "SCHEDULED with no time" or
 * a past timestamp is rejected here — before any bytes move — rather than being
 * quietly forwarded to Graph.
 */
export function validateReelSchedule(
  videoState: ReelVideoState,
  scheduledPublishTime: number | undefined,
  nowMs: number,
  pageTimezone?: string,
): ReelScheduleEcho | undefined {
  if (videoState !== 'SCHEDULED') {
    if (scheduledPublishTime !== undefined) {
      throw localReelError(
        'finish',
        'schedule',
        'validation',
        `scheduled_publish_time is only meaningful with video_state=SCHEDULED (got ${videoState}). Either drop the time or switch the state — silently ignoring it would publish immediately.`,
      );
    }
    return undefined;
  }

  if (scheduledPublishTime === undefined) {
    throw localReelError(
      'finish',
      'schedule',
      'validation',
      `video_state=SCHEDULED requires scheduled_publish_time (Unix seconds). ${REEL_SCHEDULE_WINDOW_NOTE}`,
    );
  }
  if (
    !Number.isSafeInteger(scheduledPublishTime) ||
    scheduledPublishTime <= 0 ||
    scheduledPublishTime > REEL_MAX_PLAUSIBLE_EPOCH_SECONDS
  ) {
    throw localReelError(
      'finish',
      'schedule',
      'validation',
      `scheduled_publish_time must be a positive integer count of Unix SECONDS below ${String(REEL_MAX_PLAUSIBLE_EPOCH_SECONDS)} (got ${String(scheduledPublishTime)}). Passing milliseconds is the likely mistake — read as seconds it lands tens of thousands of years out, so it is rejected rather than divided by 1000 behind your back.`,
    );
  }

  const leadMs = scheduledPublishTime * 1000 - nowMs;
  const requested = toUtcIso(scheduledPublishTime);
  const now = new Date(nowMs).toISOString();

  if (leadMs <= 0) {
    throw localReelError(
      'finish',
      'schedule',
      'validation',
      `scheduled_publish_time ${requested} is in the past (now ${now}). ${REEL_SCHEDULE_WINDOW_NOTE} ${REEL_TIMEZONE_CAVEAT}`,
    );
  }
  if (leadMs <= REEL_SCHEDULE_MIN_LEAD_MS) {
    throw localReelError(
      'finish',
      'schedule',
      'validation',
      `scheduled_publish_time ${requested} is only ${String(Math.round(leadMs / 60_000))} minutes ahead (now ${now}). ${REEL_SCHEDULE_WINDOW_NOTE} ${REEL_TIMEZONE_CAVEAT}`,
    );
  }
  if (leadMs > REEL_SCHEDULE_MAX_LEAD_MS) {
    throw localReelError(
      'finish',
      'schedule',
      'validation',
      `scheduled_publish_time ${requested} is ${String(Math.round(leadMs / (24 * 60 * 60 * 1000)))} days ahead (now ${now}), beyond the Reels window. ${REEL_SCHEDULE_WINDOW_NOTE}`,
    );
  }

  return {
    epochSeconds: scheduledPublishTime,
    utc: requested,
    leadMs,
    windowNote: REEL_SCHEDULE_WINDOW_NOTE,
    ...(pageTimezone !== undefined ? { pageTimezone } : {}),
    timezoneCaveat:
      pageTimezone === undefined
        ? `${REEL_TIMEZONE_CAVEAT} The Page timezone was not supplied, so no local-time rendering is offered.`
        : `${REEL_TIMEZONE_CAVEAT} The Page reports timezone "${pageTimezone}"; Meta's UI will show this instant in that zone.`,
  };
}

// ---------------------------------------------------------------------------
// 6. Defensive response parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/**
 * A string field off the wire — strings only, and never coerced (CC-NET-2).
 *
 * `fbRequest` CASTS the body, so a `video_id` or a `post_id` arriving as a JSON
 * number is a thing this edge can do, and a number cannot be rescued: Graph ids
 * run past the safe-integer range, so the low digits are gone before
 * `JSON.parse` hands the value over. `String(n)` would mint a plausible-looking
 * id for a video that does not exist — and on this edge that id is the upload
 * target, so the whole file would be transferred and then committed against
 * somebody else's node. Reporting no id is the only honest answer; the start
 * phase fails closed on it before a single byte moves.
 */
function stringField(
  rec: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = rec?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Did the finish response NAME an id, whatever shape it arrived in?
 *
 * This is deliberately not the same question as "can we hand that id back".
 * `stringField` refuses a rounded numeric id, and that refusal must not be
 * re-read as "Graph confirmed nothing": a numeric `post_id` is Graph
 * ACKNOWLEDGING the publish, it is simply not a handle we can trust. Conflating
 * the two would raise the `ambiguous` failure below for a write Graph has
 * already confirmed, sending the operator to verify a live Reel over an optional
 * field they do not need — a Reel is addressed by its `video_id`, which this
 * module has held since the start phase.
 */
function namesAnId(rec: Record<string, unknown> | undefined): boolean {
  const value = rec?.['post_id'] ?? rec?.['id'];
  return value !== undefined && value !== null && value !== '';
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** The caller's own cancellation, rethrown raw by the transport (`AbortError`). */
function isAbortError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * Reject a payload there is no point uploading.
 *
 * Shared by the dry run, the transfer loop and the full publish so all three
 * agree: a plan that happily previews a 0-byte Reel the apply step then refuses
 * is worse than no plan at all.
 */
function assertReelPayload(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    throw localReelError(
      'transfer',
      'constraint',
      'validation',
      `The Reel binary is empty (${String(byteLength)} bytes). Nothing was uploaded; supply the video file.`,
    );
  }
}

/**
 * Validate a numeric tuning knob from {@link ReelsDeps} before it can reach the
 * transfer loop.
 *
 * This is not defensive noise: `NaN` is the dangerous input. `Math.max(1, NaN)`
 * is `NaN`, and a `NaN` chunk size makes every offset `NaN`, so `while (offset <
 * total)` is false on the first test and the loop would return "uploaded"
 * having sent nothing. A `NaN` resume budget is worse — `resumes >= NaN` is
 * always false, so the resume loop would never end. Both are rejected loudly
 * here, before a single byte moves.
 */
function intOption(
  value: number | undefined,
  fallback: number,
  min: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min) {
    throw localReelError(
      'transfer',
      'constraint',
      'validation',
      `\`${name}\` must be a safe integer of at least ${String(min)}; received ${String(value)}. Nothing was uploaded.`,
    );
  }
  return value;
}

/**
 * Read the server's offset out of a chunk response.
 *
 * Headers go through core's `parseFileOffset` verbatim. The body is handed to the
 * SAME parser (re-serialised, since the client already parsed the JSON) so there
 * is exactly one interpretation of the wire's offset fields in the codebase — a
 * second hand-rolled reader here is how the two layers would drift apart.
 */
function serverOffsetOf(res: FbResponse<unknown>): number | undefined {
  const fromHeaders = parseFileOffset(res.headers);
  if (fromHeaders !== undefined) return fromHeaders;
  const rec = asRecord(res.data);
  if (rec === undefined) return undefined;
  try {
    return parseFileOffset({}, JSON.stringify(rec));
  } catch {
    // Non-serialisable payload (BigInt, cycle): treat as "server said nothing".
    return undefined;
  }
}

/**
 * Did a 2xx chunk response explicitly decline the bytes? `fbRequest` casts the
 * body unvalidated, so only a `success` flag that is present and not `true`
 * (`false`, `"false"`, `0`, `null`) counts as a refusal — the rule the finish
 * phase already applies to its own `success`.
 */
function chunkRefused(res: FbResponse<unknown>): boolean {
  const rec = asRecord(res.data);
  if (rec === undefined || !('success' in rec)) return false;
  return rec['success'] !== true;
}

/**
 * Derive the relative rupload path from Meta's `upload_url`.
 *
 * The URL is treated as untrusted input: its host must be exactly the
 * allowlisted rupload host, otherwise the binary would be shipped somewhere the
 * host allowlist never approved (CC-NET-7). Only the hostname is ever surfaced —
 * never the full URL.
 *
 * Only `pathname` is kept, which normalises any `..` segments away and drops the
 * query string. Dropping the query is deliberate on both counts: core's rupload
 * builder takes a path (auth rides in a header), and an upload URL's query is
 * exactly where a credential would sit — it must never be echoed onto our wire
 * URL or into a log (C3).
 *
 * The path is returned exactly as Meta gave it. Its layout is
 * `/video-upload/{version}/{video-id}` — the version is the SECOND segment,
 * unlike a Graph edge path — and `core/http-upload.ts` honours that by never
 * injecting a version into a rupload path.
 */
export function ruploadPathForReel(
  uploadUrl: string | undefined,
  videoId: string,
  apiVersion: string,
  ruploadHost: string,
): string {
  const fallback = `/${REEL_UPLOAD_PATH_PREFIX}/${apiVersion}/${videoId}`;
  if (uploadUrl === undefined || uploadUrl.length === 0) return fallback;

  let parsed: URL;
  try {
    parsed = new URL(uploadUrl);
  } catch {
    return fallback;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== ruploadHost) {
    throw localReelError(
      'start',
      'constraint',
      'validation',
      `The Reels start phase returned an upload target on host "${parsed.hostname}" (${parsed.protocol}), which is not the allowlisted rupload host "${ruploadHost}". Refusing to upload off the allowlist.`,
    );
  }
  return parsed.pathname.length > 1 ? parsed.pathname : fallback;
}

// ---------------------------------------------------------------------------
// 7. Phase 1 — start
// ---------------------------------------------------------------------------

export interface StartReelInput {
  readonly pageId: string;
  /** Explicit Page token; omitted ⇒ the client resolves one from `pageId`. */
  readonly token?: string;
}

/**
 * The handle phase 1 hands to phases 2 and 3. Deliberately NOT persisted: upload
 * state lives for one server lifetime (CC-MEDIA-1/3), and a stale session must
 * fail loudly rather than be silently re-created.
 */
export interface ReelUploadSession {
  readonly videoId: string;
  /** Relative rupload path for the binary POSTs. */
  readonly uploadPath: string;
  /** Hostname only — the full upload URL is never surfaced. */
  readonly uploadHost: string;
  readonly startedAtMs: number;
}

/**
 * Feed the progress sink, defensively. A sink is ADVISORY: the tools layer
 * bridges it onto an MCP `progressToken` notification (CC-MCP-1), and that
 * notification can fail on a closing transport. A throwing sink must never fail
 * an upload whose bytes are already on Meta's side — on this edge the damage is
 * worse than a lost notification, because a reserved `video_id` lives for one
 * server lifetime (CC-MEDIA-1) and only `finishReelUpload` names it, so a throw
 * in front of the commit strands the whole transfer where nothing can find it.
 * The throw is contained, and logged rather than silently dropped.
 *
 * `media-video.ts` states and keeps the same contract for the legacy resumable
 * edge; the two upload paths must not disagree about whether reporting is fatal.
 */
function reportReelProgress(deps: ReelsDeps, update: ProgressUpdate): void {
  if (deps.onProgress === undefined) return;
  try {
    deps.onProgress(update);
  } catch (err) {
    deps.logger.warn('reels.progress.failed', {
      progress: update.progress,
      ...(update.total !== undefined ? { total: update.total } : {}),
      error: errorMessageOf(err),
    });
  }
}

/** Phase 1: reserve a `video_id` and an upload target. Mutates nothing visible. */
export async function startReelUpload(
  deps: ReelsDeps,
  input: StartReelInput,
): Promise<ReelUploadSession> {
  reportReelProgress(deps, { progress: 0, message: 'reels: start phase' });

  let res: FbResponse<unknown>;
  try {
    res = await deps.fbRequest<unknown>({
      protocol: 'json',
      method: 'POST',
      host: 'graph',
      path: `/${input.pageId}/${REEL_EDGE}`,
      params: { upload_phase: 'start' },
      pageId: input.pageId,
      ...(input.token !== undefined ? { token: input.token } : {}),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    });
  } catch (err) {
    throw wrapReelError(err, 'start');
  }

  const rec = asRecord(res.data);
  const videoId = stringField(rec, 'video_id');
  if (videoId === undefined) {
    throw localReelError(
      'start',
      'passthrough',
      'unknown',
      'The Reels start phase returned no video_id, so there is no session to upload into. Nothing was created; re-run the start phase.',
    );
  }

  const uploadPath = ruploadPathForReel(
    stringField(rec, 'upload_url'),
    videoId,
    deps.settings.apiVersion,
    deps.settings.hosts.rupload,
  );

  deps.logger.debug('reels.start', {
    pageId: input.pageId,
    videoId,
    uploadPath,
  });

  return {
    videoId,
    uploadPath,
    uploadHost: deps.settings.hosts.rupload,
    startedAtMs: deps.clock.now(),
  };
}

// ---------------------------------------------------------------------------
// 8. Phase 2 — transfer the binary (server-offset driven, CC-MEDIA-2)
// ---------------------------------------------------------------------------

export interface UploadReelBinaryInput {
  readonly session: ReelUploadSession;
  readonly data: Uint8Array;
  readonly token?: string;
  readonly pageId?: string;
  /** Overrides the default `application/octet-stream` chunk content type. */
  readonly contentType?: string;
}

export interface ReelTransferResult {
  readonly videoId: string;
  readonly byteLength: number;
  /** Chunk POSTs that succeeded. */
  readonly chunks: number;
  /** How many times the loop resumed after a transient failure. */
  readonly resumes: number;
  /** Offset the loop finished at (equals `byteLength` on a clean run). */
  readonly finalOffset: number;
  /** true ⇒ at least one offset came from the server, not from our arithmetic. */
  readonly serverReportedOffset: boolean;
}

/**
 * Phase 2: push the bytes to the rupload host.
 *
 * Offset discipline, in order of authority:
 *   1. the offset the server reported on the last response,
 *   2. our own `offset + bytes sent` arithmetic (only when the server was silent).
 *
 * On a transient failure the loop rewinds to the last ACKNOWLEDGED offset — the
 * offset left by the most recent successful chunk POST, which is the server's own
 * number whenever the server gave one. Rewinding to the newest server offset
 * instead would be wrong on a mixed stream: if the server reports an offset for
 * chunk 1 and then stays silent through chunk 2, the newest server offset is
 * stale by a whole chunk and the loop would re-send bytes the server has already
 * acknowledged taking. Chunk POSTs are offset-idempotent, so a rewind can never
 * duplicate bytes; when the server has never reported an offset the same chunk is
 * simply re-sent from its own start, which is what core's in-call resume does too.
 *
 * A `session`-class failure (offset desync / expired session) is terminal here by
 * design — resuming an unknown session state is exactly the silent re-create
 * CC-MEDIA-1/3 forbids.
 */
/**
 * Wait before a transfer re-drive: the longer of the linear local backoff and a
 * server-named wait (RFC 9110: a minimum), on the injected clock and honouring
 * the caller's abort. A cancelled wait is wrapped like any transfer fault.
 */
async function reelResumeBackoff(
  deps: ReelsDeps,
  baseMs: number,
  attempt: number,
  serverWaitMs?: number,
): Promise<void> {
  const waitMs = Math.max(baseMs * attempt, serverWaitMs ?? 0);
  if (waitMs === 0) return;
  try {
    await deps.clock.sleep(waitMs, deps.signal);
  } catch (err) {
    throw wrapReelError(err, 'transfer');
  }
}

export async function uploadReelBinary(
  deps: ReelsDeps,
  input: UploadReelBinaryInput,
): Promise<ReelTransferResult> {
  const total = input.data.byteLength;
  assertReelPayload(total);

  const chunkBytes = intOption(deps.chunkBytes, REEL_CHUNK_BYTES, 1, 'chunkBytes');
  const maxResumes = intOption(
    deps.maxResumeAttempts,
    REEL_MAX_RESUME_ATTEMPTS,
    0,
    'maxResumeAttempts',
  );
  // Validated up front, like the other knobs, so a bad value refuses before a byte moves.
  const backoffMs = intOption(
    deps.resumeBackoffMs,
    REEL_RESUME_BACKOFF_MS,
    0,
    'resumeBackoffMs',
  );

  let offset = 0;
  let chunks = 0;
  let resumes = 0;
  let stalled = 0;
  /**
   * Furthest offset the server has ever acknowledged. The stall guard measures
   * progress against THIS, not against the previous chunk: a server that
   * alternates between acknowledging and rewinding advances on every other POST
   * and would otherwise reset the guard forever.
   */
  let highWater = 0;
  /** Offset left by the last successful chunk POST — the rewind point. */
  let acknowledged = 0;
  let lastServerOffset: number | undefined;

  while (offset < total) {
    const end = Math.min(offset + chunkBytes, total);
    // `subarray` is a view — the source buffer is never copied per chunk.
    const chunk = input.data.subarray(offset, end);

    let res: FbResponse<unknown>;
    try {
      res = await deps.fbRequest<unknown>({
        protocol: 'rupload',
        method: 'POST',
        host: 'rupload',
        path: input.session.uploadPath,
        fileOffset: offset,
        chunk,
        // `file_size` is stable for the whole transfer, so it is safe to pin per
        // chunk. We deliberately do NOT pass a duplicate `offset` header even
        // though Meta's Reels doc names it that way: core forces `file_offset`
        // and updates it on its own in-call resume, so a caller-supplied `offset`
        // would go stale mid-request. If Phase 2 shows this edge insists on
        // `offset`, core/http-upload.ts is the place that changes, not here.
        headers: {
          file_size: String(total),
          ...(input.contentType !== undefined
            ? { 'content-type': input.contentType }
            : {}),
        },
        ...(input.pageId !== undefined ? { pageId: input.pageId } : {}),
        ...(input.token !== undefined ? { token: input.token } : {}),
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      });
    } catch (err) {
      const failure = classifyReelFailure(err, 'transfer');
      if (failure.kind !== 'transient' || resumes >= maxResumes) {
        throw wrapReelError(err, 'transfer');
      }
      // A server-named wait longer than this call may hold the upload open is
      // surfaced with the wait attached, never re-driven into: the next chunk
      // would land inside the very window the server just announced.
      const serverWaitMs =
        failure.retryAfterMs !== undefined &&
        Number.isFinite(failure.retryAfterMs) &&
        failure.retryAfterMs > 0
          ? failure.retryAfterMs
          : undefined;
      if (serverWaitMs !== undefined && serverWaitMs > REEL_MAX_RESUME_WAIT_MS) {
        throw wrapReelError(err, 'transfer');
      }
      resumes += 1;
      // Rewind to the last acknowledged offset. Before the first successful chunk
      // that is 0, i.e. the same chunk is re-sent from its own start.
      offset = acknowledged;
      deps.logger.warn('reels.transfer.resume', {
        videoId: input.session.videoId,
        resumeFrom: offset,
        attempt: resumes,
        reason: failure.kind,
      });
      await reelResumeBackoff(deps, backoffMs, resumes, serverWaitMs);
      continue;
    }

    chunks += 1;
    const previous = offset;
    const reported = serverOffsetOf(res);
    if (reported !== undefined && reported > total) {
      // Past the end of the file the server cannot possibly hold more bytes than
      // we own. Trusting it would exit the loop with `finalOffset > byteLength`
      // and report a clean upload for a transfer whose state we do not know.
      throw localReelError(
        'transfer',
        'session',
        'validation',
        `The rupload host reported offset ${String(reported)} for a ${String(total)}-byte Reel, which is past the end of the file. ${REEL_SESSION_TEXT}`,
      );
    }
    if (reported !== undefined) {
      lastServerOffset = reported;
      if (reported < previous) {
        // The server rewound us: it never durably took the bytes we thought it
        // had. Honour it — arguing with the server's offset is how duplicate or
        // missing bytes happen.
        deps.logger.warn('reels.transfer.rewind', {
          videoId: input.session.videoId,
          from: previous,
          to: reported,
        });
      }
      offset = reported;
    } else if (chunkRefused(res)) {
      // A 2xx that says the chunk was NOT taken, with no offset to follow: the
      // bytes stay unacknowledged and the same chunk is re-sent. Advancing by our
      // own arithmetic would report a complete transfer — and let publishReel
      // finish a Reel — for bytes the host declined. The stall guard bounds it.
      offset = previous;
    } else {
      offset = end;
    }
    acknowledged = offset;

    reportReelProgress(deps, {
      progress: Math.min(offset, total),
      total,
      message: `reels: uploaded ${String(Math.min(offset, total))}/${String(total)} bytes`,
    });

    // Termination guard: a server offset that never advances would otherwise
    // hammer the edge forever. Bounded like the pagination loop guard — the loop
    // ALWAYS terminates, either by reaching `total` or by failing loudly here.
    if (offset > highWater) {
      highWater = offset;
      stalled = 0;
    } else {
      stalled += 1;
    }
    if (stalled > maxResumes) {
      throw localReelError(
        'transfer',
        'session',
        'validation',
        `The rupload host stopped advancing: ${String(stalled)} consecutive chunk POSTs left the offset at ${String(offset)} of ${String(total)} without passing its furthest acknowledged offset ${String(highWater)}. ${REEL_SESSION_TEXT}`,
      );
    }
    // A POST that did not move the offset forward is re-sent after a pause,
    // not back-to-back: a host that is not taking bytes is not helped by more.
    if (stalled > 0 && offset < total) {
      await reelResumeBackoff(deps, backoffMs, stalled);
    }
  }

  return {
    videoId: input.session.videoId,
    byteLength: total,
    chunks,
    resumes,
    finalOffset: offset,
    serverReportedOffset: lastServerOffset !== undefined,
  };
}

// ---------------------------------------------------------------------------
// 9. Phase 3 — finish
// ---------------------------------------------------------------------------

export interface FinishReelInput {
  readonly pageId: string;
  readonly videoId: string;
  readonly videoState: ReelVideoState;
  readonly description?: string;
  readonly title?: string;
  /** Unix SECONDS; required for `SCHEDULED`, rejected for the other states. */
  readonly scheduledPublishTime?: number;
  /** The Page's IANA timezone, for the echoed caveat. Display-only. */
  readonly pageTimezone?: string;
  readonly token?: string;
}

export interface ReelFinishResult {
  readonly videoId: string;
  /**
   * The state that was REQUESTED (`video_state` on the finish call), echoed
   * from the input — Graph's finish response carries no state to read back
   * (it acknowledges with `success`, at most an id). The live state is only
   * observable afterwards via `GET /{video-id}?fields=status`.
   */
  readonly videoState: ReelVideoState;
  /**
   * Graph confirmed acceptance. Always `true` on a returned result — a finish
   * response that confirms nothing raises an `ambiguous` failure instead of
   * returning `success: false`. `true` means ACCEPTED, not live (CC-MEDIA-7).
   */
  readonly success: boolean;
  /** Present only when Graph returns one; a Reel is addressed by `videoId`. */
  readonly postId?: string;
  readonly schedule?: ReelScheduleEcho;
  readonly lifecycle: readonly ReelLifecycleNote[];
  /** Where to read this Reel back — NOT /feed (see the lifecycle notes). */
  readonly readEdge: string;
  readonly processingNote: string;
  /** The rolling-cap fact, surfaced on success so the budget stays visible. */
  readonly quotaNote: string;
}

/** The rolling-cap fact, stated on every finish result (CC-MEDIA-8). */
export const REEL_QUOTA_NOTE = `This publish consumes one of the Page's ${String(REEL_QUOTA_PER_24H)} API-published Reels per rolling 24 h. Exhausting the window surfaces as a mapped quota error, not a generic failure.`;

/** Phase 3: commit the upload with a `video_state`. This is the visible mutation. */
export async function finishReelUpload(
  deps: ReelsDeps,
  input: FinishReelInput,
): Promise<ReelFinishResult> {
  // Validate BEFORE the call: a bad schedule must not reach Graph at all.
  const schedule = validateReelSchedule(
    input.videoState,
    input.scheduledPublishTime,
    deps.clock.now(),
    input.pageTimezone,
  );

  reportReelProgress(deps, { progress: 1, total: 1, message: 'reels: finish phase' });
  const verifyTool = reelVerifyToolFor(input.videoState);

  let res: FbResponse<unknown>;
  try {
    res = await deps.fbRequest<unknown>({
      protocol: 'json',
      method: 'POST',
      host: 'graph',
      path: `/${input.pageId}/${REEL_EDGE}`,
      // Never sent to Graph: core names it on an ambiguous outcome.
      verifyTool,
      params: {
        upload_phase: 'finish',
        video_id: input.videoId,
        video_state: input.videoState,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(schedule !== undefined
          ? { scheduled_publish_time: schedule.epochSeconds }
          : {}),
      },
      pageId: input.pageId,
      ...(input.token !== undefined ? { token: input.token } : {}),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    });
  } catch (err) {
    throw withReelVideoId(wrapReelError(err, 'finish'), input.videoId, verifyTool);
  }

  const rec = asRecord(res.data);
  const postId = stringField(rec, 'post_id') ?? stringField(rec, 'id');
  // Only an explicit `true` confirms; an id confirms only when Graph said
  // nothing about success at all. An explicit `false` (or any non-`true`
  // value) next to an id is Graph's verdict, and the id is a reference to
  // the video, not a contradiction of that verdict.
  const rawSuccess = rec?.['success'];
  const success = rawSuccess === true || (rawSuccess === undefined && namesAnId(rec));
  if (!success) {
    // A 2xx whose payload confirms nothing (`{"success": false}`, or a shape we
    // do not recognise). Returning this as a result with `success: false` is how
    // a failed publish gets rendered as a completed one, so it is raised instead
    // — as `ambiguous`, because the bytes did reach Graph and the write may still
    // have landed. Never re-published automatically: verify first (C2).
    throw withReelVideoId(
      localReelError('finish', 'ambiguous', 'ambiguous', REEL_AMBIGUOUS_BASE_TEXT),
      input.videoId,
      verifyTool,
    );
  }

  deps.logger.info('reels.finish', {
    pageId: input.pageId,
    videoId: input.videoId,
    videoState: input.videoState,
    success,
  });

  return {
    videoId: input.videoId,
    videoState: input.videoState,
    success,
    ...(postId !== undefined ? { postId } : {}),
    ...(schedule !== undefined ? { schedule } : {}),
    lifecycle: reelLifecycleNotes(input.videoState),
    readEdge: `/${input.pageId}/${REEL_EDGE}`,
    processingNote: REEL_PROCESSING_NOTE,
    quotaNote: REEL_QUOTA_NOTE,
  };
}

// ---------------------------------------------------------------------------
// 10. Dry-run plan + the full three-phase orchestration
// ---------------------------------------------------------------------------

/** Everything a preview needs, without holding the bytes. */
export interface ReelPlanInput {
  readonly pageId: string;
  readonly byteLength: number;
  readonly videoState: ReelVideoState;
  readonly description?: string;
  readonly scheduledPublishTime?: number;
  readonly pageTimezone?: string;
}

export interface ReelPlan {
  readonly summary: string;
  readonly warnings: readonly string[];
  readonly schedule?: ReelScheduleEcho;
  readonly lifecycle: readonly ReelLifecycleNote[];
  readonly readEdge: string;
  readonly quotaNote: string;
}

/**
 * Everything the write can be checked for without touching the network — so the
 * tool layer's dry run rejects a bad schedule before an operator confirms it,
 * and validation cannot diverge between preview and apply (both call
 * {@link validateReelSchedule}).
 */
export function planReelPublish(input: ReelPlanInput, nowMs: number): ReelPlan {
  assertReelPayload(input.byteLength);
  const schedule = validateReelSchedule(
    input.videoState,
    input.scheduledPublishTime,
    nowMs,
    input.pageTimezone,
  );

  const warnings: string[] = [
    // C10 / CC-MEDIA-9: state the absence of a local probe rather than implying one.
    'The video file is not decoded locally, so aspect ratio (9:16), resolution (>= 540x960), duration (3-90 s) and codec are checked only by Meta — a violation surfaces as a finish-phase rejection after the bytes have already been uploaded.',
    REEL_QUOTA_NOTE,
  ];
  if (input.videoState === 'PUBLISHED') {
    warnings.push(
      'video_state=PUBLISHED publishes as soon as encoding completes; there is no unpublish step in this flow.',
    );
  }
  if (input.description === undefined) {
    warnings.push(
      'No description supplied — the Reel will be published without a caption.',
    );
  }

  const scheduleSuffix =
    schedule === undefined ? '' : ` scheduled for ${schedule.utc} (UTC)`;

  return {
    summary: `Publish a ${String(input.byteLength)}-byte Reel to Page ${input.pageId} with video_state=${input.videoState}${scheduleSuffix}.`,
    warnings,
    ...(schedule !== undefined ? { schedule } : {}),
    lifecycle: reelLifecycleNotes(input.videoState),
    readEdge: `/${input.pageId}/${REEL_EDGE}`,
    quotaNote: REEL_QUOTA_NOTE,
  };
}

export interface PublishReelInput {
  readonly pageId: string;
  readonly data: Uint8Array;
  readonly videoState: ReelVideoState;
  readonly description?: string;
  readonly title?: string;
  readonly scheduledPublishTime?: number;
  readonly pageTimezone?: string;
  readonly contentType?: string;
  readonly token?: string;
}

export interface PublishReelResult {
  readonly session: ReelUploadSession;
  readonly transfer: ReelTransferResult;
  readonly finish: ReelFinishResult;
  readonly elapsedMs: number;
}

/**
 * Re-raise a finish-phase schedule rejection that the upload itself caused.
 *
 * `finishReelUpload` re-validates the schedule against a FRESH clock, which is
 * right — the lead that matters is the one at the commit, not the one at
 * submission. But by that point a `video_id` is reserved and every byte is on
 * Meta's side, so the plain message ("only N minutes ahead") reads as if the
 * operator submitted a bad time when in fact they submitted a good one and the
 * upload outran it. Reported as-is it sends them to fix the wrong thing and says
 * nothing about the session they now own (CC-MEDIA-9).
 */
function scheduleOutrunError(
  original: ReelPublishError,
  session: ReelUploadSession,
  transfer: ReelTransferResult,
  elapsedMs: number,
): ReelPublishError {
  return localReelError(
    'finish',
    'schedule',
    'validation',
    `The upload outran the requested schedule: scheduled_publish_time was inside the Reels window when this publish started, and was not ${String(Math.round(elapsedMs / 1000))} s later when the ${String(transfer.byteLength)}-byte upload finished. ${original.reel.operatorText} Nothing was published and the finish call was never made, but video_id ${session.videoId} is reserved with all bytes already uploaded. Re-running the publish reserves a NEW video_id and re-uploads — choose a scheduled_publish_time with enough lead to cover the upload itself. ✎ UNVERIFIED (G-TOOL-3, Phase 2): whether a reserved-but-never-finished session expires on its own or leaves a visible artefact — read GET /${session.videoId}?fields=status before assuming it is gone.`,
  );
}

/**
 * Drive all three phases.
 *
 * The schedule is validated FIRST, before the start call, so an invalid publish
 * time costs no Graph write and no uploaded bytes. That check is not the last
 * word: the lead Graph enforces is the one at the FINISH call, so a slow upload
 * can carry a legal time out of the window — and THAT rejection is not free, so
 * it is re-raised naming the cause and the session left behind. Failures keep
 * their phase name (CC-MEDIA-9) so the operator learns whether the parameters,
 * the bytes or the media spec was the problem.
 */
export async function publishReel(
  deps: ReelsDeps,
  input: PublishReelInput,
): Promise<PublishReelResult> {
  const startedAtMs = deps.clock.now();

  // Fail before mutating anything. Both checks are cheap and local, and the start
  // phase already reserves a `video_id` server-side — so an unusable payload or a
  // bad publish time must be caught here, not one Graph write later.
  assertReelPayload(input.data.byteLength);
  validateReelSchedule(
    input.videoState,
    input.scheduledPublishTime,
    startedAtMs,
    input.pageTimezone,
  );

  const session = await startReelUpload(deps, {
    pageId: input.pageId,
    ...(input.token !== undefined ? { token: input.token } : {}),
  });

  const transfer = await uploadReelBinary(deps, {
    session,
    data: input.data,
    pageId: input.pageId,
    ...(input.token !== undefined ? { token: input.token } : {}),
    ...(input.contentType !== undefined ? { contentType: input.contentType } : {}),
  });

  let finish: ReelFinishResult;
  try {
    finish = await finishReelUpload(deps, {
      pageId: input.pageId,
      videoId: session.videoId,
      videoState: input.videoState,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.scheduledPublishTime !== undefined
        ? { scheduledPublishTime: input.scheduledPublishTime }
        : {}),
      ...(input.pageTimezone !== undefined ? { pageTimezone: input.pageTimezone } : {}),
      ...(input.token !== undefined ? { token: input.token } : {}),
    });
  } catch (err) {
    if (err instanceof ReelPublishError && err.reel.kind === 'schedule') {
      throw scheduleOutrunError(err, session, transfer, deps.clock.now() - startedAtMs);
    }
    throw err;
  }

  return {
    session,
    transfer,
    finish,
    elapsedMs: deps.clock.now() - startedAtMs,
  };
}
