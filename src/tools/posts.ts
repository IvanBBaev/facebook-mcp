// The `posts` tool package (task V03) — publishing, scheduling and the
// scheduled-post lifecycle of a Facebook Page.
//
//   * facebook_create_post           — text / link / multi-link card carousel /
//                                      multi-photo carousel (reversible).
//   * facebook_create_photo_post     — one photo, published or scheduled.
//   * facebook_create_video_post     — resumable upload of a local file, or a
//                                      `file_url` Meta fetches itself.
//   * facebook_create_reel           — the three-phase Reels flow, with the
//                                      video_state lifecycle and the 24 h cap.
//   * facebook_update_post           — content edits PLUS the scheduled-post
//                                      lifecycle verbs (destructive, idempotent).
//   * facebook_delete_post           — permanent removal (irreversible).
//   * facebook_list_scheduled_posts  — read-only queue inspection.
//   * facebook_get_video_status      — read-only poll of an uploaded video's
//                                      processing state (created != ready).
//
// The package is plan-first (`writeModeDefault: 'plan'`): publishing is visible
// to an audience the moment it lands, so every write returns a preview until the
// caller repeats it with `apply:true` (plus a `plan_id` for the irreversible
// delete, which `FB_WRITE_MODE=apply` can never waive).
//
// Layer 3 (`tools`): this module OWNS no validation of its own. Every rule about
// schedules, field combinations, carousel bounds and message ceilings lives in
// `../api/posts-write.js` as pure functions, and the media protocols live in
// `../api/media-*.js`. The handlers here resolve the Page, call those planners
// BEFORE returning a preview (so an approved dry run cannot fail at apply time
// on something checkable locally), hand the mutation to the write gate, and
// translate the layer's typed failures into model-actionable results.

import { extname } from 'node:path';

import { z } from 'zod';

import { GraphApiError } from '../core/index.js';
import type {
  PackageSpec,
  ParamValue,
  ResolvedPage,
  ToolAnnotations,
  ToolContext,
  ToolResult,
} from '../core/index.js';
import {
  MediaSourceError,
  MultiPhotoUploadError,
  cleanupUnpublishedPhotos,
  describeOrphans,
  preparePhotoSource,
  preparePhotoSources,
  readLocalPhoto,
  resolveLocalMediaPath,
  resolveRemoteMediaUrl,
  uploadPhoto,
  uploadUnpublishedPhotos,
  type LocalMediaOptions,
  type MediaPhotoDeps,
  type OrphanCleanupReport,
  type PhotoSource,
} from '../api/media-photos.js';
import {
  REEL_VIDEO_STATES,
  isReelPublishError,
  planReelPublish,
  publishReel,
  type ReelScheduleEcho,
  type ReelsDeps,
} from '../api/media-reels.js';
import {
  createUploadSessionRegistry,
  getVideoStatus,
  uploadVideo,
  type VideoStatus,
} from '../api/media-video.js';
import {
  CarouselPostError,
  DELETE_ALREADY_ABSENT_NOTE,
  DELETE_PERMANENT_NOTE,
  EDIT_OWN_APP_NOTE,
  MAX_LOCAL_VIDEO_BYTES,
  PUBLISH_VERIFY_NOTE,
  PostValidationError,
  SCHEDULE_FORMAT_HELP,
  SCHEDULE_TIMEZONE_CAVEAT,
  UPDATE_POST_ACTIONS,
  VIDEO_CREATED_NOT_READY_NOTE,
  assertLocalMediaSource,
  createdAtMsOf,
  deletePostRequest,
  feedPostRequest,
  formatInTimeZone,
  isPostAbsentError,
  parseScheduledPublishTime,
  planCreatePost,
  planDeletePost,
  planUpdatePost,
  planVideoPost,
  readPageTimezone,
  readPostState,
  resolvePageTimezone,
  scheduledPostsEdge,
  toMediaSource,
  updatePostRequest,
  videoByUrlRequest,
  type PostPlan,
  type PostState,
  type PublishState,
  type RequestScope,
  type ScheduleEcho,
  type UpdatePostAction,
} from '../api/posts-write.js';
import { fetchPage } from '../api/shared.js';
import { WriteGateError, defineTool, shapeEnvelope, shapeResult } from '../mcp/index.js';
import {
  confirmableWriteArgs,
  executeWrite,
  gateArgs,
  listArgs,
  profileArg,
  shapeFor,
  shapeOptionsOf,
  writeArgs,
} from './shared.js';

// ---------------------------------------------------------------------------
// 1. Annotation quadruples (doc 06 — SSOT; all four hints always explicit)
// ---------------------------------------------------------------------------

/**
 * The create-family quadruple: writes, does not destroy prior state, and is NOT
 * idempotent (a repeated call publishes a second post — Graph offers no
 * idempotency key, which is exactly why C2 forbids blind retries).
 */
const CREATE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * The mutate-family quadruple (update / delete): destructive because it
 * overwrites or removes state the operator already had, idempotent because
 * repeating the same call converges on the same end state.
 */
const MUTATE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

/** The read-only quadruple — no `writeTier`, which `defineTool` cross-checks. */
const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

// ---------------------------------------------------------------------------
// 2. Shared input fields
// ---------------------------------------------------------------------------

const scheduledPublishTimeArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    'When to publish, as an ISO-8601 instant WITH an explicit offset — "2026-08-01T09:30:00+03:00" or "2026-08-01T06:30:00Z". A bare local time ("2026-08-01T09:30:00") and a raw epoch number are both REFUSED, because they have no unambiguous meaning. Must be more than 10 minutes and at most 75 days ahead. Setting this creates the post unpublished; do NOT also pass published:true.',
  );

const pageTimezoneArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    'IANA timezone name of the Page (e.g. "Europe/Sofia"), used only to echo a scheduled instant in Page-local time next to UTC. Omitted ⇒ the server reads the Page\'s own timezone; if that read fails the echo is UTC-only.',
  );

const publishedArg = z
  .boolean()
  .optional()
  .describe(
    'false ⇒ create the post UNPUBLISHED (a draft that stays invisible until facebook_update_post action:"publish_now"). Omitted or true ⇒ publish immediately. Must be omitted when scheduled_publish_time is set.',
  );

const postIdArg = z
  .string()
  .min(1)
  .describe(
    'The post ID, normally "{page-id}_{post-id}". Only posts this same app created can be edited or deleted — a post made in the Facebook UI or by another app is not addressable here.',
  );

const videoIdArg = z
  .string()
  .min(1)
  .describe(
    'The VIDEO ID — the `videoId` facebook_create_video_post returned, not a post ID. A "{page-id}_{post-id}" value is a post, not a video, and does not resolve on this edge.',
  );

// ---------------------------------------------------------------------------
// 3. Local error types and the error → result mapping
// ---------------------------------------------------------------------------

/** A refusal this layer raises for an argument no API-layer planner owns. */
class ToolInputError extends Error {
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

/** The operator-facing projection of a best-effort orphan cleanup (CC-MEDIA-10). */
function cleanupPayload(report: OrphanCleanupReport): Record<string, unknown> {
  return {
    deleted: report.deleted,
    orphans: report.orphans,
    failures: report.failures.map((failure) => ({
      id: failure.id,
      error: failure.message,
    })),
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
  if (isReelPublishError(err)) {
    const { reel } = err;
    return {
      applied: false,
      error: err.message,
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
    };
  }
  if (err instanceof WriteGateError) {
    return {
      applied: false,
      error: err.message,
      reason: err.code,
      tool: err.tool,
      tier: err.tier,
      hint: "Run the tool once WITHOUT apply to get a fresh preview, then repeat the identical arguments with apply:true and that preview's plan_id.",
    };
  }
  return undefined;
}

/** Run a handler body, shaping the expected failures instead of throwing them. */
async function guarded(
  ctx: ToolContext,
  run: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    const record = errorRecord(err);
    if (record === undefined) throw err;
    return shapeResult(record, { ...shapeOptionsOf(ctx), isError: true });
  }
}

// ---------------------------------------------------------------------------
// 4. Context helpers
// ---------------------------------------------------------------------------

/** The Page, the clock reading and the (optional) timezone one call works with. */
interface PostsBase {
  readonly page: ResolvedPage;
  readonly nowMs: number;
  readonly pageTimezone?: string;
}

/** Token + abort seams for every Graph call this package makes (C1 / CC-MCP-2). */
function requestScope(ctx: ToolContext, page: ResolvedPage): RequestScope {
  return {
    token: page.token,
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  };
}

/** `FB_MEDIA_DIR` policy, straight from settings (C11). */
function localMediaOptions(ctx: ToolContext): LocalMediaOptions {
  return ctx.settings.mediaDir !== undefined ? { mediaDir: ctx.settings.mediaDir } : {};
}

function mediaDeps(ctx: ToolContext): MediaPhotoDeps {
  return { fbRequest: ctx.fbRequest, logger: ctx.logger, ...localMediaOptions(ctx) };
}

/**
 * Resolve the Page and, when a schedule is involved, its timezone.
 *
 * The timezone is display-only: an explicit `page_timezone` is validated (a
 * typo must not silently degrade to a UTC-only echo), while the Graph read
 * behind it never throws, so an unreadable Page timezone downgrades the echo
 * instead of blocking the write (CC-SCHED-2).
 */
async function prepareBase(
  ctx: ToolContext,
  input: { readonly profile?: string; readonly page_timezone?: string },
  opts: { readonly needTimezone: boolean },
): Promise<PostsBase> {
  const page = await ctx.pages.resolvePage(input.profile);
  const nowMs = ctx.clock.now();

  let pageTimezone: string | undefined;
  if (input.page_timezone !== undefined) {
    pageTimezone = resolvePageTimezone(input.page_timezone);
    if (pageTimezone === undefined) {
      throw new ToolInputError(
        'page_timezone',
        `page_timezone "${input.page_timezone}" is not a timezone this runtime recognises.`,
        'Pass an IANA name such as "Europe/Sofia" or "America/New_York", or omit the argument and let the server read the Page timezone.',
      );
    }
  } else if (opts.needTimezone) {
    pageTimezone = await readPageTimezone(
      ctx.fbRequest,
      page.pageId,
      requestScope(ctx, page),
    );
  }

  return {
    page,
    nowMs,
    ...(pageTimezone !== undefined ? { pageTimezone } : {}),
  };
}

/** Forward a byte/child counter to the MCP client when it asked for progress. */
function report(
  ctx: ToolContext,
  progress: number,
  total: number,
  message: string,
): void {
  ctx.reportProgress?.({ progress, total, message });
}

// ---------------------------------------------------------------------------
// 5. The dual UTC + Page-local schedule echo
// ---------------------------------------------------------------------------

/**
 * One normalized publish-time echo. Both echo producers in the `api` layer
 * (`ScheduleEcho` for feed posts, `ReelScheduleEcho` for Reels) collapse into
 * this, so a preview and its result state the instant identically and an
 * operator comparing two tools never sees two wordings for one fact.
 */
interface TimeEcho {
  readonly utc: string;
  readonly epochSeconds: number;
  readonly leadMs: number;
  readonly pageTimezone: string | null;
  readonly pageLocal: string | null;
  readonly windowNote: string;
  readonly timezoneCaveat: string;
}

function toTimeEcho(echo: ScheduleEcho): TimeEcho {
  return {
    utc: echo.utc,
    epochSeconds: echo.epochSeconds,
    leadMs: echo.leadMs,
    pageTimezone: echo.pageTimezone ?? null,
    pageLocal: echo.pageLocal ?? null,
    windowNote: echo.windowNote,
    timezoneCaveat: echo.timezoneCaveat,
  };
}

function toReelTimeEcho(echo: ReelScheduleEcho, pageTimezone?: string): TimeEcho {
  const zone = pageTimezone ?? echo.pageTimezone;
  const local =
    zone !== undefined ? formatInTimeZone(echo.epochSeconds * 1000, zone) : undefined;
  return {
    utc: echo.utc,
    epochSeconds: echo.epochSeconds,
    leadMs: echo.leadMs,
    pageTimezone: zone ?? null,
    pageLocal: local ?? null,
    windowNote: echo.windowNote,
    timezoneCaveat: echo.timezoneCaveat,
  };
}

/**
 * The one-line rendering of an echo, added to a preview's warnings. A preview is
 * text an operator approves, so the instant must be legible there and not only
 * in the applied result.
 */
function echoLine(echo: TimeEcho): string {
  const local =
    echo.pageLocal !== null && echo.pageTimezone !== null
      ? `${echo.pageLocal} (${echo.pageTimezone})`
      : 'not available — the Page timezone is unknown';
  return `Publish time: ${echo.utc} (UTC, epoch seconds ${String(echo.epochSeconds)}); in Page-local time: ${local}.`;
}

/** Preview warnings for a create-style plan, with the echo line appended. */
function planWarnings(plan: { readonly warnings: readonly string[] }, echo?: TimeEcho) {
  return echo === undefined ? plan.warnings : [...plan.warnings, echoLine(echo)];
}

// ---------------------------------------------------------------------------
// 6. Response readers
// ---------------------------------------------------------------------------

interface FeedPostResponse {
  readonly id?: string;
  readonly post_id?: string;
}

function createdPostId(data: FeedPostResponse): string | null {
  return data.post_id ?? data.id ?? null;
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
function classifyPublishFailure(err: unknown): 'attempted' | 'failed' {
  // The Reels layer already decided this: `ambiguous` means the finish phase
  // returned something that neither confirms nor denies the publish.
  if (isReelPublishError(err)) {
    return err.reel.kind === 'ambiguous' ? 'attempted' : 'failed';
  }
  // A carousel wraps the underlying feed failure; classify what actually failed.
  const inner = err instanceof CarouselPostError ? err.cause : err;
  if (inner instanceof GraphApiError) {
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
function publishesNow(state: PublishState): boolean {
  return state === 'published';
}

/** Best-effort content type for a local video; Meta sniffs the container itself. */
function videoContentType(filename: string): string {
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

// ---------------------------------------------------------------------------
// 7. facebook_create_post
// ---------------------------------------------------------------------------

function buildCreatePost() {
  return defineTool({
    name: 'facebook_create_post',
    title: 'Create Post',
    description:
      'Create a Page post: plain text, a link, a multi-link card carousel, or a ' +
      'multi-photo carousel. Publishes now, keeps it as a draft (published:false), ' +
      'or schedules it (scheduled_publish_time). Dry run by default — repeat the ' +
      'call with apply:true to actually publish.',
    inputSchema: z.object({
      ...writeArgs,
      message: z
        .string()
        .optional()
        .describe(
          'The post text (up to 63206 characters). Unicode and emoji pass through byte-for-byte; no escaping is applied. At least one of message, link or photos is required.',
        ),
      link: z
        .string()
        .min(1)
        .optional()
        .describe(
          "A URL to attach. Facebook renders its own preview from the URL's Open Graph tags — the title/image cannot be overridden here. Cannot be combined with photos.",
        ),
      photos: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe(
          'Photo sources for a photo post: each is an https:// URL Meta fetches itself, or a local file path inside FB_MEDIA_DIR. Uploaded sequentially as UNPUBLISHED children, then attached to one feed post. Cannot be combined with link or child_attachments.',
        ),
      child_attachments: z
        .array(
          z
            .object({
              link: z.string().min(1).describe('Destination URL of this card.'),
              name: z.string().optional().describe('Card headline.'),
              description: z.string().optional().describe('Card subtitle.'),
              picture: z
                .string()
                .optional()
                .describe('Absolute image URL for this card.'),
            })
            .strict(),
        )
        .optional()
        .describe(
          'Cards of a multi-LINK carousel (a different post type from photos): between 2 and 5 entries, and the parent `link` must be set as well.',
        ),
      published: publishedArg,
      scheduled_publish_time: scheduledPublishTimeArg,
      page_timezone: pageTimezoneArg,
    }),
    annotations: CREATE_ANNOTATIONS,
    writeTier: 'reversible',
    handler: (input, ctx) =>
      guarded(ctx, async () => {
        const base = await prepareBase(ctx, input, {
          needTimezone: input.scheduled_publish_time !== undefined,
        });
        const sources: PhotoSource[] = (input.photos ?? []).map(toMediaSource);

        const plan: PostPlan = planCreatePost(
          {
            pageId: base.page.pageId,
            ...(input.message !== undefined ? { message: input.message } : {}),
            ...(input.link !== undefined ? { link: input.link } : {}),
            ...(input.published !== undefined ? { published: input.published } : {}),
            ...(input.scheduled_publish_time !== undefined
              ? { scheduledPublishTime: input.scheduled_publish_time }
              : {}),
            ...(input.child_attachments !== undefined
              ? { childAttachments: input.child_attachments }
              : {}),
            photoCount: sources.length,
          },
          {
            nowMs: base.nowMs,
            ...(base.pageTimezone !== undefined
              ? { pageTimezone: base.pageTimezone }
              : {}),
          },
        );

        // Local media validation runs BEFORE the preview is returned: a bad path
        // or a non-https URL must fail the dry run, never the approved apply.
        const media = mediaDeps(ctx);
        if (sources.length > 0) await preparePhotoSources(sources, media);

        const echo = plan.schedule !== undefined ? toTimeEcho(plan.schedule) : undefined;
        return executeWrite(ctx, {
          tool: 'facebook_create_post',
          tier: 'reversible',
          requirePlanId: publishesNow(plan.publishState),
          pageId: base.page.pageId,
          // The photo list joins the bound params so an apply that swaps the
          // sources is a plan mismatch rather than a different post.
          params: {
            ...plan.params,
            ...(input.photos !== undefined ? { photos: input.photos } : {}),
          },
          ...(input.apply !== undefined ? { apply: input.apply } : {}),
          ...(input.plan_id !== undefined ? { planId: input.plan_id } : {}),
          summary: plan.summary,
          warnings: planWarnings(plan, echo),
          resolvedPage: base.page,
          notPerformedNotice:
            'This was a dry run — nothing was posted and no photo was uploaded.',
          classifyOutcome: classifyPublishFailure,
          metadata: { publishState: plan.publishState, photoCount: sources.length },
          perform: async (): Promise<Record<string, unknown>> => {
            const scope = requestScope(ctx, base.page);
            let attachedMedia: Readonly<Record<string, string>> = {};
            let photoIds: string[] = [];

            if (sources.length > 0) {
              const uploaded = await uploadUnpublishedPhotos(media, {
                pageId: base.page.pageId,
                sources,
                token: base.page.token,
                ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
                onProgress: (done, total) => {
                  report(
                    ctx,
                    done,
                    total,
                    `uploaded ${String(done)}/${String(total)} carousel photos`,
                  );
                },
              });
              attachedMedia = uploaded.attachedMedia;
              photoIds = uploaded.children.map((child) => child.id);
            }

            try {
              const res = await ctx.fbRequest<FeedPostResponse>(
                feedPostRequest(
                  base.page.pageId,
                  { ...plan.params, ...attachedMedia },
                  scope,
                ),
              );
              return {
                postId: createdPostId(res.data),
                pageId: base.page.pageId,
                publishState: plan.publishState,
                ...(photoIds.length > 0 ? { photoIds } : {}),
                ...(echo !== undefined ? { schedule: echo } : {}),
                verifyNote: PUBLISH_VERIFY_NOTE,
              };
            } catch (err) {
              // The children exist but nothing references them: this call owns
              // their cleanup (CC-MEDIA-10). The cleanup runs WITHOUT the call's
              // signal so a cancelled post still tidies up after itself.
              if (photoIds.length === 0) throw err;
              const cleanup = await cleanupUnpublishedPhotos(media, photoIds, {
                token: base.page.token,
              });
              throw new CarouselPostError({ cause: err, cleanup });
            }
          },
        });
      }),
  });
}

// ---------------------------------------------------------------------------
// 8. facebook_create_photo_post
// ---------------------------------------------------------------------------

function buildCreatePhotoPost() {
  return defineTool({
    name: 'facebook_create_photo_post',
    title: 'Create Photo Post',
    description:
      'Publish ONE photo to a Page, optionally with a caption, as a draft, or ' +
      'scheduled. The photo is either an https:// URL Meta fetches itself or a ' +
      'local file inside FB_MEDIA_DIR. Dry run by default.',
    inputSchema: z.object({
      ...writeArgs,
      photo: z
        .string()
        .min(1)
        .describe(
          'The image: an https:// URL Meta fetches itself (no credentials in the URL), or a local file path inside FB_MEDIA_DIR whose bytes this server uploads.',
        ),
      caption: z
        .string()
        .optional()
        .describe('Text shown with the photo. Unicode and emoji pass through unchanged.'),
      published: publishedArg,
      scheduled_publish_time: scheduledPublishTimeArg,
      page_timezone: pageTimezoneArg,
    }),
    annotations: CREATE_ANNOTATIONS,
    writeTier: 'reversible',
    handler: (input, ctx) =>
      guarded(ctx, async () => {
        const base = await prepareBase(ctx, input, {
          needTimezone: input.scheduled_publish_time !== undefined,
        });
        const source = toMediaSource(input.photo);

        const plan = planCreatePost(
          {
            pageId: base.page.pageId,
            ...(input.caption !== undefined ? { message: input.caption } : {}),
            ...(input.published !== undefined ? { published: input.published } : {}),
            ...(input.scheduled_publish_time !== undefined
              ? { scheduledPublishTime: input.scheduled_publish_time }
              : {}),
            photoCount: 1,
          },
          {
            nowMs: base.nowMs,
            ...(base.pageTimezone !== undefined
              ? { pageTimezone: base.pageTimezone }
              : {}),
          },
        );

        const media = mediaDeps(ctx);
        // Same contract as the carousel: the source is proven usable in the dry run.
        await preparePhotoSource(source, media);

        const echo = plan.schedule !== undefined ? toTimeEcho(plan.schedule) : undefined;
        const extraParams: Record<string, ParamValue> =
          plan.schedule !== undefined
            ? { scheduled_publish_time: plan.schedule.epochSeconds }
            : {};

        return executeWrite(ctx, {
          tool: 'facebook_create_photo_post',
          tier: 'reversible',
          requirePlanId: publishesNow(plan.publishState),
          pageId: base.page.pageId,
          params: { ...plan.params, photo: input.photo },
          ...(input.apply !== undefined ? { apply: input.apply } : {}),
          ...(input.plan_id !== undefined ? { planId: input.plan_id } : {}),
          summary: plan.summary,
          warnings: planWarnings(plan, echo),
          resolvedPage: base.page,
          notPerformedNotice: 'This was a dry run — no photo was uploaded or posted.',
          classifyOutcome: classifyPublishFailure,
          metadata: { publishState: plan.publishState },
          perform: async (): Promise<Record<string, unknown>> => {
            const uploaded = await uploadPhoto(media, {
              pageId: base.page.pageId,
              source,
              ...(input.caption !== undefined ? { caption: input.caption } : {}),
              published: plan.publishState === 'published',
              token: base.page.token,
              ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
              ...(Object.keys(extraParams).length > 0 ? { extraParams } : {}),
            });
            return {
              photoId: uploaded.id,
              postId: uploaded.postId ?? null,
              pageId: base.page.pageId,
              publishState: plan.publishState,
              ...(echo !== undefined ? { schedule: echo } : {}),
              verifyNote: PUBLISH_VERIFY_NOTE,
            };
          },
        });
      }),
  });
}

// ---------------------------------------------------------------------------
// 9. facebook_create_video_post
// ---------------------------------------------------------------------------

function buildCreateVideoPost() {
  return defineTool({
    name: 'facebook_create_video_post',
    title: 'Create Video Post',
    description:
      'Upload a video to a Page. A local path inside FB_MEDIA_DIR is streamed ' +
      'chunk-by-chunk through the resumable protocol (progress is reported); an ' +
      'https:// URL is handed to Meta to fetch. A completed upload is a CREATED ' +
      'video, not yet an encoded, published one. Dry run by default.',
    inputSchema: z.object({
      ...writeArgs,
      video: z
        .string()
        .min(1)
        .describe(
          'The video: a local file path inside FB_MEDIA_DIR (streamed from here, resumable, up to 256 MB) or an https:// URL Meta fetches from its own network.',
        ),
      description: z
        .string()
        .optional()
        .describe('The post text shown with the video (the video caption).'),
      title: z.string().optional().describe('Video title, shown in the video library.'),
      published: publishedArg,
      scheduled_publish_time: scheduledPublishTimeArg,
      page_timezone: pageTimezoneArg,
    }),
    annotations: CREATE_ANNOTATIONS,
    writeTier: 'reversible',
    handler: (input, ctx) =>
      guarded(ctx, async () => {
        const base = await prepareBase(ctx, input, {
          needTimezone: input.scheduled_publish_time !== undefined,
        });
        const source = toMediaSource(input.video);
        const opts: LocalMediaOptions = {
          ...localMediaOptions(ctx),
          maxBytes: MAX_LOCAL_VIDEO_BYTES,
        };

        // Resolve the source in the dry run too: a missing file or an http:// URL
        // must be refused before an operator approves anything.
        const resolved =
          source.kind === 'local'
            ? await resolveLocalMediaPath(source.path, opts)
            : undefined;
        const sourceLabel =
          source.kind === 'url' ? resolveRemoteMediaUrl(source.url) : source.path;

        const plan = planVideoPost(
          {
            pageId: base.page.pageId,
            delivery: source.kind === 'url' ? 'file-url' : 'resumable-upload',
            sourceLabel,
            ...(input.description !== undefined
              ? { description: input.description }
              : {}),
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.published !== undefined ? { published: input.published } : {}),
            ...(input.scheduled_publish_time !== undefined
              ? { scheduledPublishTime: input.scheduled_publish_time }
              : {}),
            ...(resolved !== undefined ? { byteLength: resolved.bytes } : {}),
          },
          {
            nowMs: base.nowMs,
            ...(base.pageTimezone !== undefined
              ? { pageTimezone: base.pageTimezone }
              : {}),
          },
        );

        const echo = plan.schedule !== undefined ? toTimeEcho(plan.schedule) : undefined;
        return executeWrite(ctx, {
          tool: 'facebook_create_video_post',
          tier: 'reversible',
          requirePlanId: publishesNow(plan.publishState),
          pageId: base.page.pageId,
          // The size joins the bound params: if the file changes between preview
          // and apply, the plan no longer describes what would be uploaded.
          params: {
            ...plan.params,
            source: sourceLabel,
            ...(resolved !== undefined ? { byte_length: resolved.bytes } : {}),
          },
          ...(input.apply !== undefined ? { apply: input.apply } : {}),
          ...(input.plan_id !== undefined ? { planId: input.plan_id } : {}),
          summary: plan.summary,
          warnings: planWarnings(plan, echo),
          resolvedPage: base.page,
          notPerformedNotice:
            'This was a dry run — no bytes were uploaded and no video was created.',
          classifyOutcome: classifyPublishFailure,
          metadata: {
            publishState: plan.publishState,
            delivery: source.kind === 'url' ? 'file-url' : 'resumable-upload',
          },
          perform: async (): Promise<Record<string, unknown>> => {
            const common = {
              pageId: base.page.pageId,
              publishState: plan.publishState,
              ...(echo !== undefined ? { schedule: echo } : {}),
              // CC-MEDIA-7: "uploaded" is not "live".
              isPublishedAndProcessed: false,
              processingNote: VIDEO_CREATED_NOT_READY_NOTE,
              verifyNote: PUBLISH_VERIFY_NOTE,
            };

            if (source.kind === 'url') {
              const res = await ctx.fbRequest<FeedPostResponse>(
                videoByUrlRequest(
                  base.page.pageId,
                  plan.params,
                  requestScope(ctx, base.page),
                ),
              );
              return {
                videoId: res.data.id ?? null,
                delivery: 'file-url',
                ...common,
              };
            }

            const file = await readLocalPhoto(source.path, opts);
            const result = await uploadVideo(
              {
                fbRequest: ctx.fbRequest,
                clock: ctx.clock,
                sessions: createUploadSessionRegistry({ clock: ctx.clock }),
                settings: ctx.settings,
                logger: ctx.logger,
              },
              {
                pageId: base.page.pageId,
                data: file.data,
                fileName: file.filename,
                ...(input.description !== undefined
                  ? { description: input.description }
                  : {}),
                ...(input.title !== undefined ? { title: input.title } : {}),
                ...(plan.publishState === 'published' ? {} : { published: false }),
                ...(plan.schedule !== undefined
                  ? { scheduledPublishTime: plan.schedule.epochSeconds }
                  : {}),
                token: base.page.token,
                ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
                onProgress: (sent, total) => {
                  report(
                    ctx,
                    sent,
                    total,
                    `uploaded ${String(sent)}/${String(total)} video bytes`,
                  );
                },
              },
            );

            return {
              videoId: result.videoId,
              delivery: 'resumable-upload',
              uploadSessionId: result.uploadSessionId,
              totalBytes: result.totalBytes,
              bytesSent: result.bytesSent,
              resumes: result.resumes,
              accepted: result.success,
              ...common,
            };
          },
        });
      }),
  });
}

// ---------------------------------------------------------------------------
// 10. facebook_create_reel
// ---------------------------------------------------------------------------

function buildCreateReel() {
  return defineTool({
    name: 'facebook_create_reel',
    title: 'Create Reel',
    description:
      'Publish a Facebook Reel through the three-phase upload (start → transfer ' +
      '→ finish) with an explicit video_state: PUBLISHED, DRAFT or SCHEDULED. ' +
      'The file must be local (the protocol streams the bytes from this server). ' +
      "Each publish consumes one of the Page's 30 API Reels per rolling 24 h. " +
      'Dry run by default.',
    inputSchema: z.object({
      ...writeArgs,
      video: z
        .string()
        .min(1)
        .describe(
          'Local file path inside FB_MEDIA_DIR. A remote URL is REFUSED here: the Reels upload protocol has no "fetch this URL" mode, so the bytes must be readable by this server. Meta enforces 9:16 aspect, at least 540x960, 3-90 s, MP4/MOV — none of which is checked locally.',
        ),
      description: z
        .string()
        .optional()
        .describe('The Reel caption. Omitted ⇒ the Reel is published without one.'),
      title: z.string().optional().describe('Internal title for the video object.'),
      video_state: z
        .enum(REEL_VIDEO_STATES)
        .default('PUBLISHED')
        .describe(
          "PUBLISHED ⇒ goes live as soon as encoding finishes (there is no unpublish step in this flow). DRAFT ⇒ stays in the Page's draft area. SCHEDULED ⇒ requires scheduled_publish_time, more than 10 minutes and at most 29 days ahead.",
        ),
      scheduled_publish_time: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Only with video_state:"SCHEDULED". ISO-8601 WITH an explicit offset ("2026-08-01T09:30:00+03:00" / "...Z"); naive local times and raw epoch numbers are refused. Reels accept a shorter window than feed posts: more than 10 minutes and at most 29 days ahead.',
        ),
      page_timezone: pageTimezoneArg,
    }),
    annotations: CREATE_ANNOTATIONS,
    writeTier: 'reversible',
    handler: (input, ctx) =>
      guarded(ctx, async () => {
        const base = await prepareBase(ctx, input, {
          needTimezone: input.scheduled_publish_time !== undefined,
        });

        const path = assertLocalMediaSource(
          input.video,
          'video',
          'The Reels upload protocol streams the bytes from this server, so `video` must be a local file inside FB_MEDIA_DIR — a remote URL cannot be used. Download the file first, or publish it as a normal video with facebook_create_video_post.',
        );
        const opts: LocalMediaOptions = {
          ...localMediaOptions(ctx),
          maxBytes: MAX_LOCAL_VIDEO_BYTES,
        };
        const resolved = await resolveLocalMediaPath(path, opts);

        // The Reels window is validated in SECONDS by the api layer, while the
        // ISO parser answers in milliseconds — convert once, here.
        const epochSeconds =
          input.scheduled_publish_time !== undefined
            ? Math.floor(parseScheduledPublishTime(input.scheduled_publish_time) / 1000)
            : undefined;

        const plan = planReelPublish(
          {
            pageId: base.page.pageId,
            byteLength: resolved.bytes,
            videoState: input.video_state,
            ...(input.description !== undefined
              ? { description: input.description }
              : {}),
            ...(epochSeconds !== undefined ? { scheduledPublishTime: epochSeconds } : {}),
            ...(base.pageTimezone !== undefined
              ? { pageTimezone: base.pageTimezone }
              : {}),
          },
          base.nowMs,
        );

        const echo =
          plan.schedule !== undefined
            ? toReelTimeEcho(plan.schedule, base.pageTimezone)
            : undefined;

        return executeWrite(ctx, {
          tool: 'facebook_create_reel',
          tier: 'reversible',
          requirePlanId: input.video_state === 'PUBLISHED',
          pageId: base.page.pageId,
          params: {
            video: resolved.path,
            byte_length: resolved.bytes,
            video_state: input.video_state,
            ...(input.description !== undefined
              ? { description: input.description }
              : {}),
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(epochSeconds !== undefined
              ? { scheduled_publish_time: epochSeconds }
              : {}),
          },
          ...(input.apply !== undefined ? { apply: input.apply } : {}),
          ...(input.plan_id !== undefined ? { planId: input.plan_id } : {}),
          summary: plan.summary,
          warnings: [
            ...plan.warnings,
            ...plan.lifecycle.map((note) =>
              note.verification === 'verified' ? note.text : `${note.text} (assumed)`,
            ),
            ...(echo !== undefined ? [echoLine(echo)] : []),
          ],
          resolvedPage: base.page,
          notPerformedNotice:
            'This was a dry run — no Reel was created and no quota slot was consumed.',
          classifyOutcome: classifyPublishFailure,
          metadata: { videoState: input.video_state, byteLength: resolved.bytes },
          perform: async (): Promise<Record<string, unknown>> => {
            const file = await readLocalPhoto(path, opts);
            const deps: ReelsDeps = {
              fbRequest: ctx.fbRequest,
              logger: ctx.logger,
              clock: ctx.clock,
              settings: {
                apiVersion: ctx.settings.apiVersion,
                hosts: ctx.settings.hosts,
              },
              ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
              ...(ctx.reportProgress !== undefined
                ? { onProgress: ctx.reportProgress }
                : {}),
            };
            const published = await publishReel(deps, {
              pageId: base.page.pageId,
              data: file.data,
              videoState: input.video_state,
              ...(input.description !== undefined
                ? { description: input.description }
                : {}),
              ...(input.title !== undefined ? { title: input.title } : {}),
              ...(epochSeconds !== undefined
                ? { scheduledPublishTime: epochSeconds }
                : {}),
              ...(base.pageTimezone !== undefined
                ? { pageTimezone: base.pageTimezone }
                : {}),
              contentType: videoContentType(file.filename),
              token: base.page.token,
            });

            const { finish, transfer } = published;
            return {
              videoId: finish.videoId,
              videoState: finish.videoState,
              postId: finish.postId ?? null,
              accepted: finish.success,
              isPublishedAndProcessed: false,
              bytesSent: transfer.finalOffset,
              chunks: transfer.chunks,
              resumes: transfer.resumes,
              elapsedMs: published.elapsedMs,
              ...(finish.schedule !== undefined
                ? { schedule: toReelTimeEcho(finish.schedule, base.pageTimezone) }
                : {}),
              readEdge: finish.readEdge,
              lifecycle: finish.lifecycle,
              processingNote: finish.processingNote,
              quotaNote: finish.quotaNote,
            };
          },
        });
      }),
  });
}

// ---------------------------------------------------------------------------
// 11. facebook_update_post
// ---------------------------------------------------------------------------

/**
 * The pre-read plus the `readState` closure the write gate uses.
 *
 * `update` needs the post's `created_time` to enforce the 29-day reschedule
 * window, and the gate needs a before-state for divergence detection — the same
 * read serves both, so the first `readState()` call is answered from the
 * pre-read instead of issuing a duplicate GET. This is correct in BOTH modes:
 * in plan mode the pre-read IS the captured before-state, and in apply mode it
 * is the fresh state the plan is compared against.
 */
function memoizedPostState(
  ctx: ToolContext,
  postId: string,
  scope: RequestScope,
  first: PostState,
): () => Promise<PostState> {
  let cached: PostState | undefined = first;
  return async (): Promise<PostState> => {
    if (cached !== undefined) {
      const state = cached;
      cached = undefined;
      return state;
    }
    return await readPostState(ctx.fbRequest, postId, scope);
  };
}

function absentPostError(postId: string): ToolInputError {
  return new ToolInputError(
    'post_id',
    `post ${postId} could not be read: it does not exist, was already deleted, or is not visible to this app's token.`,
    `${EDIT_OWN_APP_NOTE} Confirm the id with facebook_list_scheduled_posts (for a scheduled post) or a feed listing before retrying.`,
  );
}

function buildUpdatePost() {
  return defineTool({
    name: 'facebook_update_post',
    title: 'Update Post',
    description:
      'Edit a Page post the app itself created, or move it through the scheduled-post ' +
      'lifecycle. action:"edit" changes message/is_hidden/is_pinned; "publish_now" ' +
      'publishes a draft or scheduled post immediately; "reschedule" moves the publish ' +
      'time; "cancel_schedule" is not a Graph transition and is answered with the ' +
      'delete path to use instead. Dry run by default; an edit OVERWRITES the previous ' +
      'text, which Graph does not keep.',
    inputSchema: z.object({
      ...writeArgs,
      post_id: postIdArg,
      action: z
        .enum(UPDATE_POST_ACTIONS)
        .describe(
          'edit ⇒ change content (needs at least one of message, is_hidden, is_pinned). publish_now ⇒ publish a draft/scheduled post immediately, no other fields. reschedule ⇒ move the publish time, needs scheduled_publish_time and no content fields. cancel_schedule ⇒ NOT supported by Graph; the call explains that removing a scheduled post means deleting it with facebook_delete_post.',
        ),
      message: z
        .string()
        .optional()
        .describe(
          'Replacement post text (action:"edit" only). This REPLACES the old text; the previous version is not recoverable through the API.',
        ),
      is_hidden: z
        .boolean()
        .optional()
        .describe(
          'action:"edit" only. true ⇒ hide the post from the Page timeline without deleting it.',
        ),
      is_pinned: z
        .boolean()
        .optional()
        .describe('action:"edit" only. true ⇒ pin the post to the top of the Page.'),
      scheduled_publish_time: z
        .string()
        .min(1)
        .optional()
        .describe(
          'action:"reschedule" only. ISO-8601 WITH an explicit offset. Must be more than 10 minutes and at most 75 days ahead, and at most 29 days after the post was originally created.',
        ),
      page_timezone: pageTimezoneArg,
    }),
    annotations: MUTATE_ANNOTATIONS,
    writeTier: 'reversible',
    handler: (input, ctx) =>
      guarded(ctx, async () => {
        const base = await prepareBase(ctx, input, {
          needTimezone: input.action === 'reschedule',
        });
        const scope = requestScope(ctx, base.page);

        const before = await readPostState(ctx.fbRequest, input.post_id, scope);
        if (!before.present) throw absentPostError(input.post_id);

        const action: UpdatePostAction = input.action;
        const createdAtMs = createdAtMsOf(before);
        const plan = planUpdatePost(
          {
            postId: input.post_id,
            action,
            ...(input.message !== undefined ? { message: input.message } : {}),
            ...(input.is_hidden !== undefined ? { isHidden: input.is_hidden } : {}),
            ...(input.is_pinned !== undefined ? { isPinned: input.is_pinned } : {}),
            ...(input.scheduled_publish_time !== undefined
              ? { scheduledPublishTime: input.scheduled_publish_time }
              : {}),
          },
          {
            nowMs: base.nowMs,
            ...(base.pageTimezone !== undefined
              ? { pageTimezone: base.pageTimezone }
              : {}),
            ...(createdAtMs !== undefined ? { createdAtMs } : {}),
          },
        );

        const echo = plan.schedule !== undefined ? toTimeEcho(plan.schedule) : undefined;
        return executeWrite(ctx, {
          tool: 'facebook_update_post',
          tier: 'reversible',
          // `publish_now` reaches a live audience exactly as `facebook_create_post`
          // with published:true does — the post can be deleted afterwards, but the
          // impressions it collects in the meantime cannot be recalled. Binding it
          // to a plan_id keeps the one rule in one place; edits, reschedules and
          // the cancel_schedule explainer reach nobody new and stay ungated.
          requirePlanId: action === 'publish_now',
          pageId: base.page.pageId,
          params: { post_id: input.post_id, action, ...plan.params },
          ...(input.apply !== undefined ? { apply: input.apply } : {}),
          ...(input.plan_id !== undefined ? { planId: input.plan_id } : {}),
          summary: plan.summary,
          warnings: planWarnings(plan, echo),
          resolvedPage: base.page,
          notPerformedNotice: 'This was a dry run — the post was NOT changed.',
          metadata: { action },
          readState: memoizedPostState(ctx, input.post_id, scope, before),
          perform: async (): Promise<Record<string, unknown>> => {
            const res = await ctx.fbRequest<{ success?: boolean }>(
              updatePostRequest(input.post_id, plan.params, scope),
            );
            return {
              postId: input.post_id,
              action,
              success: res.data.success ?? true,
              changed: plan.params,
              ...(echo !== undefined ? { schedule: echo } : {}),
              verifyNote: PUBLISH_VERIFY_NOTE,
            };
          },
        });
      }),
  });
}

// ---------------------------------------------------------------------------
// 12. facebook_delete_post
// ---------------------------------------------------------------------------

function buildDeletePost() {
  return defineTool({
    name: 'facebook_delete_post',
    title: 'Delete Post',
    description:
      'Permanently delete a Page post the app itself created — including a ' +
      'scheduled one, which is the only way to cancel it. There is no undo and no ' +
      'trash: the text, comments, reactions and shares are gone. Irreversible tier, ' +
      'so applying ALWAYS needs both apply:true and the plan_id of a preceding dry ' +
      'run, whatever FB_WRITE_MODE says. Reels: whether a Reel can be deleted here ' +
      'by its video ID is UNVERIFIED against the live API — Reels are invisible on ' +
      'post endpoints, so assume neither outcome and re-read the Page afterwards.',
    inputSchema: z.object({
      ...confirmableWriteArgs,
      post_id: postIdArg,
    }),
    annotations: MUTATE_ANNOTATIONS,
    writeTier: 'irreversible',
    handler: (input, ctx) =>
      guarded(ctx, async () => {
        const base = await prepareBase(ctx, input, { needTimezone: false });
        const scope = requestScope(ctx, base.page);
        const before = await readPostState(ctx.fbRequest, input.post_id, scope);
        const plan = planDeletePost({ postId: input.post_id });

        return executeWrite(ctx, {
          tool: 'facebook_delete_post',
          tier: 'irreversible',
          pageId: base.page.pageId,
          params: plan.params,
          ...gateArgs(input),
          summary: plan.summary,
          warnings: before.present
            ? plan.warnings
            : [
                ...plan.warnings,
                `Post ${input.post_id} could not be read before this plan was built, so it may already be gone or invisible to this app's token.`,
              ],
          resolvedPage: base.page,
          notPerformedNotice:
            'This was a dry run — the post was NOT deleted and still exists.',
          metadata: { presentAtPlanTime: before.present },
          readState: memoizedPostState(ctx, input.post_id, scope, before),
          perform: async (): Promise<Record<string, unknown>> => {
            try {
              const res = await ctx.fbRequest<{ success?: boolean }>(
                deletePostRequest(input.post_id, scope),
              );
              return {
                postId: input.post_id,
                deleted: res.data.success ?? true,
                alreadyAbsent: false,
                note: DELETE_PERMANENT_NOTE,
              };
            } catch (err) {
              // CC-PUB-5: "already gone" is the intended end state, not a failure
              // — but say plainly that THIS call deleted nothing.
              if (!isPostAbsentError(err)) throw err;
              return {
                postId: input.post_id,
                deleted: false,
                alreadyAbsent: true,
                note: DELETE_ALREADY_ABSENT_NOTE,
              };
            }
          },
        });
      }),
  });
}

// ---------------------------------------------------------------------------
// 13. facebook_list_scheduled_posts
// ---------------------------------------------------------------------------

interface RawScheduledPost {
  readonly id?: unknown;
  readonly message?: unknown;
  readonly story?: unknown;
  readonly created_time?: unknown;
  readonly scheduled_publish_time?: unknown;
  readonly is_published?: unknown;
  readonly permalink_url?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Graph reports `scheduled_publish_time` as seconds, sometimes as a string. */
function epochSecondsOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function mapScheduledPost(
  raw: RawScheduledPost,
  pageTimezone: string | undefined,
): Record<string, unknown> {
  const epochSeconds = epochSecondsOf(raw.scheduled_publish_time);
  const pageLocal =
    epochSeconds !== null && pageTimezone !== undefined
      ? (formatInTimeZone(epochSeconds * 1000, pageTimezone) ?? null)
      : null;
  return {
    id: text(raw.id),
    message: text(raw.message),
    story: text(raw.story),
    createdTime: text(raw.created_time),
    isPublished: typeof raw.is_published === 'boolean' ? raw.is_published : null,
    permalinkUrl: text(raw.permalink_url),
    scheduledPublishTime: {
      epochSeconds,
      utc: epochSeconds !== null ? new Date(epochSeconds * 1000).toISOString() : null,
      pageTimezone: pageTimezone ?? null,
      pageLocal,
    },
  };
}

function buildListScheduledPosts() {
  return defineTool({
    name: 'facebook_list_scheduled_posts',
    title: 'List Scheduled Posts',
    description:
      'List the Page posts that are queued to publish later, each with its publish ' +
      'time echoed in UTC and in Page-local time. Read-only: use it to find the ' +
      'post_id to hand to facebook_update_post (reschedule / publish now) or to ' +
      'facebook_delete_post (the only way to cancel a scheduled post). Reels: ' +
      'whether a scheduled Reel appears in this queue is UNVERIFIED against the ' +
      'live API — Reels are invisible on post endpoints, so an empty or Reel-less ' +
      'result is not evidence that no Reel is scheduled.',
    inputSchema: z.object({
      ...listArgs,
      page_timezone: pageTimezoneArg,
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: (input, ctx) =>
      guarded(ctx, async () => {
        const base = await prepareBase(ctx, input, { needTimezone: true });
        const page = await fetchPage<RawScheduledPost>(
          ctx.fbRequest,
          scheduledPostsEdge(base.page.pageId, requestScope(ctx, base.page)),
          {
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
            ...(input.after !== undefined ? { after: input.after } : {}),
          },
        );

        return shapeFor(ctx, {
          pageId: base.page.pageId,
          pageTimezone: base.pageTimezone ?? null,
          posts: page.data.map((post) => mapScheduledPost(post, base.pageTimezone)),
          nextCursor: page.nextCursor ?? null,
          truncated: page.truncated,
          ...(page.note !== undefined ? { note: page.note } : {}),
          timezoneCaveat: SCHEDULE_TIMEZONE_CAVEAT,
        });
      }),
  });
}

// ---------------------------------------------------------------------------
// 14. facebook_get_video_status
// ---------------------------------------------------------------------------

/**
 * The status envelope is SERVER-OWNED, which is why this read declares an
 * `outputSchema` where the Graph-shaped reads deliberately do not (CC-MCP-7).
 * Nothing here is a Graph node passed through: `mapVideoStatus` mints every
 * field from the raw `status` object, and its `kind` set is closed — an
 * unrecognized or missing Graph status maps onto `processing`, never onto a
 * fifth value — so the schema cannot drift when Meta reshapes the edge.
 */
const videoStatusOutputSchema = z.object({
  videoId: z.string(),
  pageId: z.string(),
  state: z.enum(['uploading', 'processing', 'ready', 'error']),
  /** `false` ⇒ the answer will still change; poll again. */
  terminal: z.boolean(),
  note: z.string(),
  bytesTransferred: z.number().optional(),
  publishStatus: z.string().optional(),
  error: z.string().optional(),
});

/** Only `ready` and `error` end a poll; the other two mean "call again". */
const TERMINAL_VIDEO_STATES: ReadonlySet<VideoStatus['kind']> = new Set([
  'ready',
  'error',
]);

/**
 * Project the API layer's discriminated union onto the model-facing envelope.
 *
 * No taint envelope, matching every other tool in this package: each string
 * here is either server-authored (`note`) or Meta's own processing text — none
 * of it is user-generated content the way a comment body or a display name is
 * (B1 / CC-MOD-8).
 */
function videoStatusPayload(
  pageId: string,
  status: VideoStatus,
): Record<string, unknown> {
  return {
    videoId: status.videoId,
    pageId,
    state: status.kind,
    terminal: TERMINAL_VIDEO_STATES.has(status.kind),
    note: status.note,
    ...(status.kind === 'uploading' && status.bytesTransferred !== undefined
      ? { bytesTransferred: status.bytesTransferred }
      : {}),
    ...(status.kind === 'ready' && status.publishStatus !== undefined
      ? { publishStatus: status.publishStatus }
      : {}),
    ...(status.kind === 'error' ? { error: status.message } : {}),
  };
}

function buildGetVideoStatus() {
  return defineTool({
    name: 'facebook_get_video_status',
    title: 'Get Video Status',
    description:
      "Poll where one video stands in Meta's pipeline: uploading, processing, " +
      'ready or error. facebook_create_video_post returns a video_id long before ' +
      'the video is playable, so read the state here instead of assuming a fresh ' +
      'video is live — `uploading` and `processing` are not terminal, so wait a ' +
      'few seconds and call again. Takes a video ID, never a post ID; whether a ' +
      'Reel ID resolves on this edge is UNVERIFIED against the live API.',
    inputSchema: z.object({
      profile: profileArg,
      video_id: videoIdArg,
    }),
    outputSchema: videoStatusOutputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
    handler: (input, ctx) =>
      guarded(ctx, async () => {
        const base = await prepareBase(ctx, input, { needTimezone: false });
        const status = await getVideoStatus(
          { fbRequest: ctx.fbRequest, logger: ctx.logger },
          {
            videoId: input.video_id,
            // Both seams are passed: the resolved Page token authorizes the read,
            // and `pageId` keeps the per-page resolver on the same Page (C1).
            pageId: base.page.pageId,
            token: base.page.token,
            ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
          },
        );
        return shapeEnvelope(
          videoStatusPayload(base.page.pageId, status),
          shapeOptionsOf(ctx),
        );
      }),
  });
}

// ---------------------------------------------------------------------------
// 15. Package factory
// ---------------------------------------------------------------------------

/**
 * Build the `posts` package.
 *
 * `writeModeDefault: 'plan'` makes publishing plan-first even when the server
 * runs with `FB_WRITE_MODE=apply`: a post is visible to an audience the instant
 * it lands, so the preview is the operator's last checkpoint. The irreversible
 * delete ignores the mode entirely and always demands an explicit `plan_id`.
 */
export function createPostsPackage(): PackageSpec {
  return {
    name: 'posts',
    title: 'Posts',
    description:
      'Publish, schedule, edit and delete Page posts, photos, videos and Reels ' +
      '(plan-first: every write previews before it applies).',
    tools: [
      buildCreatePost(),
      buildCreatePhotoPost(),
      buildCreateVideoPost(),
      buildCreateReel(),
      buildUpdatePost(),
      buildDeletePost(),
      buildListScheduledPosts(),
      buildGetVideoStatus(),
    ],
    enabledByDefault: true,
    writeModeDefault: 'plan',
  };
}
