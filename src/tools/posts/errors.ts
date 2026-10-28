// `posts` package — local error types, the typed-failure → result mapping and
// the `guarded` handler wrapper every posts tool runs its body in.

import { GraphApiError, errorMessageOf, isPageTokenDead } from '../../core/index.js';
import type { ToolContext, ToolResult } from '../../core/index.js';
import {
  MediaSourceError,
  MultiPhotoUploadError,
  describeOrphans,
  type OrphanCleanupReport,
} from '../../api/media-photos.js';
import { isReelPublishError } from '../../api/media-reels.js';
import {
  CarouselPostError,
  PostValidationError,
  SCHEDULE_FORMAT_HELP,
  type PublishState,
} from '../../api/posts-write.js';
import { STORY_VERIFY_TOOL, StoryPublishError } from '../../api/stories.js';
import {
  PLAN_IN_PROGRESS_MESSAGE,
  WriteGateError,
  shapeResult,
} from '../../mcp/index.js';
import { graphErrorFields, shapeOptionsOf } from '../shared.js';

// ---------------------------------------------------------------------------
// 3. Local error types and the error → result mapping
// ---------------------------------------------------------------------------

/** A refusal this layer raises for an argument no API-layer planner owns. */
export class ToolInputError extends Error {
  override readonly name = 'ToolInputError';
  readonly field: string;
  readonly hint: string;

  constructor(field: string, message: string, hint: string) {
    super(message);
    this.field = field;
    this.hint = hint;
    Object.setPrototypeOf(this, ToolInputError.prototype);
  }
}

/**
 * The carousel `POST /feed` failed in a way that may still have landed (a 5xx,
 * a transport fault, a lost response — C2). The post may exist and reference
 * every child photo, so the children are deliberately NOT cleaned up: deleting
 * them would gut a live post. The caller gets their ids to reconcile instead.
 */
export class CarouselPostUnconfirmedError extends Error {
  override readonly name = 'CarouselPostUnconfirmedError';
  readonly photoIds: readonly string[];
  /** Where the post would be if it landed — it decides where to verify. */
  readonly publishState: PublishState;

  constructor(opts: {
    readonly cause: unknown;
    readonly photoIds: readonly string[];
    readonly publishState: PublishState;
  }) {
    super(
      `the photos uploaded but the carousel post outcome is unknown: ${errorMessageOf(opts.cause)}`,
      { cause: opts.cause },
    );
    this.photoIds = opts.photoIds;
    this.publishState = opts.publishState;
    Object.setPrototypeOf(this, CarouselPostUnconfirmedError.prototype);
  }
}

/**
 * Where an unconfirmed carousel post can be seen if it landed. A scheduled post
 * sits only on the scheduled queue and a draft on no listing this server reads;
 * sending either to facebook_list_posts reads as "it did not land" and invites
 * deleting the photos of a live post or re-sending it (CC-PUB-1).
 */
function carouselVerifyStep(publishState: PublishState): string {
  if (publishState === 'scheduled') {
    return 'Verify with facebook_list_scheduled_posts (a scheduled post is not on the published listing until its publish time)';
  }
  if (publishState === 'draft') {
    return "Verify in the Page's drafts in Meta Business Suite (an unpublished draft is on neither the published listing nor the scheduled queue)";
  }
  return "Verify with facebook_list_posts, matching each item's created_time and message text (the tool has no time filter; the newest posts come first)";
}

/** The operator-facing projection of a best-effort orphan cleanup (CC-MEDIA-10). */
function cleanupPayload(report: OrphanCleanupReport): Record<string, unknown> {
  return {
    deleted: report.deleted,
    orphans: report.orphans,
    failures: report.failures.map((failure) => ({
      id: failure.id,
      error: failure.message,
    })),
    // Uploads that may have created a photo whose id never came back: nothing
    // to DELETE, so they are not in `orphans`, but they may still be on the Page.
    // `photo` is 1-based, matching the operator notice.
    ...(report.unconfirmedUploads !== undefined && report.unconfirmedUploads.length > 0
      ? {
          unconfirmedUploads: report.unconfirmedUploads.map((upload) => ({
            photo: upload.index + 1,
            error: upload.message,
          })),
        }
      : {}),
    operatorNotice:
      describeOrphans(report) ??
      'Every unpublished child photo was cleaned up; nothing was left behind on the Page.',
  };
}

/**
 * Translate a typed, expected failure into an `isError` result the model can act
 * on. Returns `undefined` for anything unrecognised so it propagates to the
 * server's own error mapper — swallowing an unknown error here would hide it.
 */
function errorRecord(err: unknown): Record<string, unknown> | undefined {
  if (err instanceof PostValidationError) {
    return {
      applied: false,
      error: err.message,
      reason: err.reason,
      ...(err.field !== undefined ? { field: err.field } : {}),
      ...(err.reason.startsWith('schedule_') ? { help: SCHEDULE_FORMAT_HELP } : {}),
    };
  }
  if (err instanceof ToolInputError) {
    return {
      applied: false,
      error: err.message,
      reason: 'invalid_argument',
      field: err.field,
      hint: err.hint,
    };
  }
  if (err instanceof MediaSourceError) {
    return {
      applied: false,
      error: err.message,
      reason: err.reason,
      source: err.source,
      hint: 'Local files are read only from inside FB_MEDIA_DIR; remote sources must be https:// URLs without credentials. Nothing was uploaded.',
    };
  }
  if (err instanceof MultiPhotoUploadError) {
    return {
      applied: false,
      error: err.message,
      reason: 'multi_photo_upload_failed',
      failedIndex: err.failedIndex,
      total: err.total,
      cleanup: cleanupPayload(err.cleanup),
    };
  }
  if (err instanceof CarouselPostError) {
    return {
      applied: false,
      error: err.message,
      reason: 'carousel_post_failed',
      cleanup: cleanupPayload(err.cleanup),
      hint: 'The photos uploaded but no post references them. Any id under `cleanup.orphans` is still in the Page photo library and must be deleted by hand.',
    };
  }
  if (err instanceof CarouselPostUnconfirmedError) {
    return {
      applied: false,
      outcome: 'attempted',
      error: err.message,
      reason: 'carousel_post_unconfirmed',
      photoIds: err.photoIds,
      hint: `The carousel post may have been created and may reference these photos, so none was deleted. ${carouselVerifyStep(err.publishState)} before doing anything: if the post exists, leave the photos alone; if it does not, the ids under photoIds are unpublished orphans in the Page photo library to delete by hand. Never re-send the post blindly — it can publish twice (CC-PUB-1).`,
    };
  }
  if (err instanceof StoryPublishError) {
    const graph = err.cause instanceof GraphApiError ? err.cause : undefined;
    return {
      applied: false,
      ...(err.outcome === 'attempted' ? { outcome: 'attempted' } : {}),
      error: err.message,
      ...(graph !== undefined ? graphErrorFields(graph) : {}),
      reason: err.outcome === 'attempted' ? 'story_unconfirmed' : 'story_rejected',
      mediaType: err.mediaType,
      mediaId: err.mediaId,
      ...(err.cleanup !== undefined ? { cleanup: cleanupPayload(err.cleanup) } : {}),
      hint:
        err.outcome === 'attempted'
          ? `The story may be live. Check ${STORY_VERIFY_TOOL} before doing anything else, and never re-send it blindly — it can publish twice.`
          : err.mediaType === 'photo'
            ? 'No story was published. The unpublished photo was deleted unless it is listed under `cleanup.orphans`. If Graph says the media was used before, use a fresh photo.'
            : `No story was published. Video ${err.mediaId} stays unpublished on Meta's side. If Graph says the media was used before, use a fresh video.`,
    };
  }
  if (isReelPublishError(err)) {
    const { reel } = err;
    return {
      applied: false,
      error: err.message,
      // A locally raised refusal (code 0, HTTP 0) had no Graph round trip, so it
      // carries no Graph identity; a phase failure keeps Meta's own explanation.
      ...(err.code !== 0 || err.httpStatus !== 0 ? graphErrorFields(err) : {}),
      reason: `reel_${reel.kind}`,
      phase: reel.phase,
      category: reel.category,
      retryable: reel.retryable,
      operatorText: reel.operatorText,
      /** false ⇒ the mapping rests on an inferred, not doc-confirmed, signature. */
      verified: reel.verified,
      ...(reel.retryAfterMs !== undefined ? { retryAfterMs: reel.retryAfterMs } : {}),
      ...(reel.nextTool !== undefined ? { nextTool: reel.nextTool } : {}),
      ...(reel.signatureId !== undefined ? { signatureId: reel.signatureId } : {}),
      /** Set once bytes reached Meta: the video exists there and can be inspected or deleted. */
      ...(reel.videoId !== undefined ? { videoId: reel.videoId } : {}),
    };
  }
  if (err instanceof WriteGateError) {
    return {
      applied: false,
      error: err.message,
      reason: err.code,
      tool: err.tool,
      tier: err.tier,
      // Re-planning a plan another call is still applying is the duplicate
      // write the gate refused to cause; the only safe step is to wait.
      hint:
        err.message === PLAN_IN_PROGRESS_MESSAGE
          ? 'Another call is applying this plan right now. Wait for its result before doing anything else — do not re-plan or re-apply, or the write may happen twice.'
          : "Run the tool once WITHOUT apply to get a fresh preview, then repeat the identical arguments with apply:true and that preview's plan_id.",
    };
  }
  return undefined;
}

/**
 * The Pages each in-flight {@link guarded} call resolved, keyed by its context.
 * {@link prepareBase} records into it; `guarded` reads it when it swallows a
 * token-dead failure.
 */
export const resolvedPagesOf = new WeakMap<ToolContext, Set<string>>();

/**
 * Whether Graph called the Page token dead anywhere in `err`'s `cause` chain
 * (bounded at depth 4): {@link isPageTokenDead}, the one predicate the server hub
 * and the resolver cache apply too. A Reels phase failure is the Graph error
 * itself; a carousel or multi-photo wrapper keeps the original as `cause`.
 */
function pageTokenDeadBehind(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
    if (isPageTokenDead(current)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/**
 * Run a handler body, shaping the expected failures instead of throwing them.
 *
 * A shaped failure never reaches the server's invalidate-on-190 hook (C1), so a
 * token-dead one evicts the resolved Page token here: otherwise every retry for
 * the cache's lifetime replays the dead token and fails the same way.
 */
export async function guarded(
  ctx: ToolContext,
  run: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const resolved = new Set<string>();
  resolvedPagesOf.set(ctx, resolved);
  try {
    return await run();
  } catch (err) {
    const record = errorRecord(err);
    if (record === undefined) throw err;
    if (pageTokenDeadBehind(err)) {
      for (const pageId of resolved) ctx.pages.invalidate(pageId);
    }
    return shapeResult(record, { ...shapeOptionsOf(ctx), isError: true });
  } finally {
    if (resolvedPagesOf.get(ctx) === resolved) resolvedPagesOf.delete(ctx);
  }
}
