// `posts` package — response readers: write acknowledgements, outcome shapes,
// result verdicts and failure classification shared by the write tools.

import { extname } from 'node:path';
import { GraphApiError } from '../../core/index.js';
import { MediaSourceError, MultiPhotoUploadError } from '../../api/media-photos.js';
import { isReelPublishError } from '../../api/media-reels.js';
import {
  CarouselPostError,
  PostValidationError,
  VIDEO_CREATED_NOT_READY_NOTE,
  type PublishState,
} from '../../api/posts-write.js';
import { StoryPublishError } from '../../api/stories.js';
import {
  APPLIED_VERDICT,
  ATTEMPTED_VERDICT,
  REFUSED_VERDICT,
  type WriteResultVerdict,
} from '../../mcp/index.js';
import { CarouselPostUnconfirmedError } from './errors.js';

// ---------------------------------------------------------------------------
// 6. Response readers
// ---------------------------------------------------------------------------

/**
 * Every reader below starts from `unknown`, because `fbRequest<T>` CASTS the
 * parsed body to `T` without validating it (`data as T`, src/core/http.ts). The
 * declared type is a hope, not a guarantee: a 2xx can arrive with no body at all
 * (parsed as `undefined`), as a raw non-JSON string, or with fields of the wrong
 * type. Reading a property straight off `res.data` therefore throws a TypeError
 * on the SUCCESS path of a bodiless 2xx — the write landed and the model is told
 * it failed, which invites a retry that duplicates a post or hunts for a post
 * that is already gone.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The acknowledgement as it actually arrives — never assumed to be a record. */
export function ackOf(body: unknown): Record<string, unknown> {
  return isRecord(body) ? body : {};
}

/** A Graph id counts only when it is a non-empty string; anything else is absent. */
export function ackId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Did Facebook confirm this write?
 *
 * Absence still confirms — the transport has already turned an error payload
 * into a throw, so a bodiless 2xx on these edges is Facebook saying "done", and
 * reading it as a failure would report a completed publish or delete as failed.
 * What must NOT confirm is a `success` that is PRESENT and is anything other
 * than `true`: `false`, `"false"` and `0` are all Facebook saying no, and the
 * old `?? true` accepted two of those three — on the delete that is a verdict
 * telling the model the post is gone when Facebook declined to remove it.
 */
export function confirmsWrite(body: unknown): boolean {
  if (body === undefined || body === true) return true;
  // A bare `false`, a `null` or a non-JSON text body is not a confirmation: the
  // transport keeps a 2xx literal as-is, and reading `false` as "done" reported
  // a declined update or delete as completed.
  if (!isRecord(body)) return false;
  const flag: unknown = body.success;
  return flag === undefined || flag === true;
}

/** What `facebook_update_post` hands back from a resolved `POST /{post-id}`. */
export interface UpdatePostOutcome extends Record<string, unknown> {
  readonly success: boolean;
}

/** What `facebook_delete_post` hands back from a resolved `DELETE /{post-id}`. */
export interface DeletePostOutcome extends Record<string, unknown> {
  readonly deleted: boolean;
  readonly alreadyAbsent: boolean;
}

/**
 * What `facebook_create_video_post` hands back from a resolved perform, on
 * either delivery. `accepted` exists on the resumable-upload delivery only: it
 * is the `finish` phase's own verdict, and the `file_url` delivery has no
 * counterpart (a refusal there arrives as a Graph error and throws).
 */
export interface CreateVideoOutcome extends Record<string, unknown> {
  readonly accepted?: boolean;
  readonly videoId: string | null;
}

/**
 * The `processingNote` for a video create whose `finish` Graph declined.
 * {@link VIDEO_CREATED_NOT_READY_NOTE} describes a COMMITTED upload that Meta is
 * transcoding; beside `accepted:false` that is false — the upload was not
 * committed. The object from the `start` phase still exists, so name it.
 */
function videoFinishDeclinedNote(videoId: string | null): string {
  const id = videoId ?? 'the video created by the start phase';
  return `Graph DECLINED the finish phase: the upload was NOT committed, so this is not a video Meta is preparing to publish. The video object ${id} still exists from the start phase — check it with facebook_get_video_status, then delete it or leave it; do not re-run the upload blindly, it creates a duplicate (CC-MEDIA-3).`;
}

/**
 * The `processingNote` for a `file_url` create whose 2xx named no video id: the
 * create may or may not have landed, and there is no id to poll.
 */
const VIDEO_NO_ID_NOTE =
  'Graph answered but named no video id, so this call cannot confirm a video was created and there is no id to poll. Verify on the Page (its videos, or the newest items of facebook_list_posts by created_time) before retrying — a blind retry may create a duplicate (CC-PUB-1).';

/**
 * {@link VIDEO_NO_ID_NOTE} for a scheduled or draft video, which no feed listing
 * shows: pointing there reads as "it did not land" and invites the duplicate.
 */
const VIDEO_UNPUBLISHED_NO_ID_NOTE =
  "Graph answered but named no video id, so this call cannot confirm a video was created and there is no id to poll. A scheduled or unpublished video does not appear among the published posts, so check the Page's video library in Meta Business Suite before retrying — a blind retry may create a duplicate (CC-PUB-1).";

/** Pick the processing note that is true for this video create's outcome. */
export function videoProcessingNote(
  accepted: boolean | undefined,
  videoId: string | null,
  publishState: PublishState,
): string {
  if (accepted === false) return videoFinishDeclinedNote(videoId);
  if (videoId === null) {
    return publishState === 'published' ? VIDEO_NO_ID_NOTE : VIDEO_UNPUBLISHED_NO_ID_NOTE;
  }
  return VIDEO_CREATED_NOT_READY_NOTE;
}

/** What `facebook_create_post` hands back from a resolved `POST /{page}/feed`. */
export interface CreatePostOutcome extends Record<string, unknown> {
  readonly postId: string | null;
}

/**
 * Tell the write gate what a resolved video create achieved. A `finish` Graph
 * declined (`accepted:false`) is NOT a refusal: the video object exists from
 * the `start` phase on, so the operator has something to reconcile — verify,
 * then publish or delete — which is what `attempted` is defined for. Stamping
 * it `applied` puts `status:"applied"` beside `accepted:false`; stamping it
 * `failed` invites the retry that creates a duplicate (CC-PUB-1). The
 * `file_url` delivery carries no flag; its ack is the video id, and a 2xx that
 * named none is the same unconfirmed state (see {@link createPostVerdict}).
 */
export function createVideoVerdict(outcome: CreateVideoOutcome): WriteResultVerdict {
  return outcome.accepted === false || outcome.videoId === null
    ? ATTEMPTED_VERDICT
    : APPLIED_VERDICT;
}

/**
 * Tell the write gate what a resolved `POST /{page}/feed` achieved. A create's
 * ack IS its id: Graph answers `{ id }` (or `post_id` on media). A 2xx that
 * names no usable post — `{}`, `{ success: true }`, an empty body, an id of the
 * wrong type — is exactly the state the http layer files as C2-ambiguous when
 * the body is lost after the status line: a post may now exist, and this call
 * cannot vouch for it. `applied` beside `postId:null` reads as "published" and
 * invites the retry that duplicates it; `attempted` says "verify first".
 */
export function createPostVerdict(outcome: CreatePostOutcome): WriteResultVerdict {
  return outcome.postId === null ? ATTEMPTED_VERDICT : APPLIED_VERDICT;
}

/**
 * Tell the write gate whether a resolved `POST /{post-id}` actually changed the
 * post (`WriteAction.classifyResult`).
 *
 * A 2xx whose body carries `success:false` (or any non-`true` flag) is Graph
 * declining the edit: the post is untouched. Without this hook the gate would
 * stamp the very same call `applied` in the envelope and journal it as a
 * change, beside a `result.success:false` that says the opposite — two answers
 * to the one question the envelope exists to answer.
 */
export function updatePostVerdict(outcome: UpdatePostOutcome): WriteResultVerdict {
  return outcome.success ? APPLIED_VERDICT : REFUSED_VERDICT;
}

/**
 * The delete counterpart of {@link updatePostVerdict}. The already-absent path
 * (CC-PUB-5) stays `applied`: the post is gone, which is the end state the
 * operator asked for, and `alreadyAbsent:true` already says this call did not
 * do the removing. Only a present post whose delete Graph refused is a failure.
 */
export function deletePostVerdict(outcome: DeletePostOutcome): WriteResultVerdict {
  return outcome.deleted || outcome.alreadyAbsent ? APPLIED_VERDICT : REFUSED_VERDICT;
}

/** The id of a freshly created post: `post_id` on the feed edge, `id` on media. */
export function createdPostId(body: unknown): string | null {
  const ack = ackOf(body);
  return ackId(ack.post_id) ?? ackId(ack.id) ?? null;
}

/**
 * Journal classification for a failed publish (C2 / CC-LIFE-2).
 *
 * Graph offers no idempotency key for a create, so the journal is the only
 * record of "a request reached the wire and we do not know whether it landed".
 * A 5xx, a timeout or an abort is exactly that case — recording it as a clean
 * `failed` would invite a blind retry that publishes the post twice. A 4xx is a
 * genuine rejection: nothing was created, so `failed` is honest.
 */
export function classifyPublishFailure(err: unknown): 'attempted' | 'failed' {
  // The Reels layer already decided this: `ambiguous` means a phase returned
  // something that neither confirms nor denies it. Only the finish phase can
  // publish, so an ambiguous start or transfer leaves no Reel that may be live.
  if (isReelPublishError(err)) {
    return err.reel.kind === 'ambiguous' && err.reel.phase === 'finish'
      ? 'attempted'
      : 'failed';
  }
  // The story layer already decided: a clean refusal or a story that may be live.
  if (err instanceof StoryPublishError) return err.outcome;
  // Raised precisely because the carousel post may have landed.
  if (err instanceof CarouselPostUnconfirmedError) return 'attempted';
  // A carousel wraps the underlying feed failure; classify what actually failed.
  const inner = err instanceof CarouselPostError ? err.cause : err;
  if (inner instanceof GraphApiError) {
    // The http and media layers stamp `ambiguous` on outcomes the status line
    // cannot classify — a body lost after HTTP 200, a 2xx photo upload that
    // carried no id. Their `httpStatus` is the 2xx that was read, so the status
    // rule alone would file a "may have landed" as a clean failure.
    if (inner.action?.category === 'ambiguous') return 'attempted';
    return inner.httpStatus >= 500 || inner.httpStatus === 0 ? 'attempted' : 'failed';
  }
  // These are all raised before or instead of the create request.
  if (
    inner instanceof MultiPhotoUploadError ||
    inner instanceof PostValidationError ||
    inner instanceof MediaSourceError
  ) {
    return 'failed';
  }
  // Anything unrecognised (transport abort, timeout, socket reset) may well have
  // reached the wire — assume it did, so the journal never invites a blind retry.
  return 'attempted';
}

/**
 * Journal outcome for a failed `facebook_update_post` / `facebook_delete_post`.
 *
 * A Graph error keeps the gate's default: the http layer stamps `ambiguous` on
 * a 5xx or a mid-flight fault on a write, and anything else it throws (a 4xx
 * refusal, a provably connect-phase fault) is a clean `failed`. What escapes the
 * client WITHOUT that classification is the caller's cancellation, re-thrown raw
 * — and it can fire after the request was sent, even while the response body is
 * arriving, i.e. after Graph applied the edit or the delete. Filing that as
 * `failed` invites a second delete or a re-edit of a write that landed, so any
 * non-Graph failure is `attempted`: verify before retrying.
 */
export function classifyMutationFailure(err: unknown): 'attempted' | 'failed' {
  if (err instanceof GraphApiError) {
    return err.action?.category === 'ambiguous' ? 'attempted' : 'failed';
  }
  return 'attempted';
}

/**
 * Whether this call needs an explicit `plan_id` on top of its tier (doc 06 §
 * "Publishing is plan-bound").
 *
 * Reaching a live audience is the one write in this package that a single
 * unreviewed call must not be able to do. The tier stays `reversible` — deleting
 * the post really is one call — but the impressions it collects before the delete
 * are not recallable, so publishing is bound to a prior plan step exactly as an
 * `irreversible` write would be. A draft or a scheduled post is NOT bound: it
 * reaches nobody yet, and `facebook_update_post` can still cancel it.
 */
export function publishesNow(state: PublishState): boolean {
  return state === 'published';
}

/** Best-effort content type for a local video; Meta sniffs the container itself. */
export function videoContentType(filename: string): string {
  switch (extname(filename).toLowerCase()) {
    case '.mp4':
      return 'video/mp4';
    case '.mov':
      return 'video/quicktime';
    case '.m4v':
      return 'video/x-m4v';
    case '.webm':
      return 'video/webm';
    default:
      return 'application/octet-stream';
  }
}
