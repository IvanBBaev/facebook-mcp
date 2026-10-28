// `posts` package — media publishing: facebook_create_video_post,
// facebook_create_reel and facebook_create_story.

import { z } from 'zod';
import {
  digestLocalMedia,
  resolveLocalMediaPath,
  resolveRemoteMediaUrl,
  type LocalMediaOptions,
} from '../../api/media-photos.js';
import {
  REEL_VIDEO_STATES,
  planReelPublish,
  publishReel,
  type ReelsDeps,
} from '../../api/media-reels.js';
import { createUploadSessionRegistry, uploadVideo } from '../../api/media-video.js';
import {
  MAX_LOCAL_VIDEO_BYTES,
  PUBLISH_VERIFY_NOTE,
  VIDEO_UNPUBLISHED_VERIFY_NOTE,
  VIDEO_CREATED_NOT_READY_NOTE,
  assertLocalMediaSource,
  parseScheduledPublishTime,
  planVideoPost,
  toMediaSource,
  videoByUrlRequest,
} from '../../api/posts-write.js';
import {
  MAX_STORY_PHOTO_BYTES,
  STORY_MEDIA_TYPES,
  STORY_VERIFY_TOOL,
  publishPhotoStory,
  publishVideoStory,
  storyPlanWarnings,
  validateStoryMedia,
} from '../../api/stories.js';
import { defineTool } from '../../mcp/index.js';
import { confirmableWriteArgs, executeWrite, gateArgs, writeArgs } from '../shared.js';
import {
  CREATE_ANNOTATIONS,
  pageTimezoneArg,
  publishedArg,
  scheduledPublishTimeArg,
  targetingArg,
} from './args.js';
import {
  echoLine,
  localMediaOptions,
  mediaDeps,
  planWarnings,
  prepareBase,
  readBoundLocalMedia,
  report,
  requestScope,
  targetingMeta,
  toReelTimeEcho,
  toTimeEcho,
} from './context.js';
import { ToolInputError, guarded } from './errors.js';
import {
  CreateVideoOutcome,
  ackId,
  ackOf,
  classifyPublishFailure,
  createVideoVerdict,
  publishesNow,
  videoContentType,
  videoProcessingNote,
} from './outcomes.js';

// ---------------------------------------------------------------------------
// 9. facebook_create_video_post
// ---------------------------------------------------------------------------

export function buildCreateVideoPost() {
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
      targeting: targetingArg,
    }),
    annotations: CREATE_ANNOTATIONS,
    writeTier: 'reversible',
    // An upload is the longest-running write here, so the pre-handler line is
    // often the only trace if the process dies mid-transfer. It records that a
    // transfer was armed, not what was transferred: `video` is a file path and
    // `description`/`title` are content.
    logFields: ['profile', 'apply', 'plan_id', 'published', 'scheduled_publish_time'],
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
        // Streamed, not buffered: binding a 256 MB video costs one chunk of memory.
        const digest =
          source.kind === 'local' && resolved !== undefined
            ? await digestLocalMedia(resolved, source.path, opts)
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
            ...(input.targeting !== undefined ? { targeting: input.targeting } : {}),
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
          // The size and content hash join the bound params: if the file changes
          // between preview and apply, the plan no longer describes what would
          // be uploaded.
          params: {
            ...plan.params,
            source: sourceLabel,
            ...(resolved !== undefined ? { byte_length: resolved.bytes } : {}),
            ...(digest !== undefined ? { sha256: digest.sha256 } : {}),
          },
          ...(input.apply !== undefined ? { apply: input.apply } : {}),
          ...(input.plan_id !== undefined ? { planId: input.plan_id } : {}),
          summary: plan.summary,
          warnings: planWarnings(plan, echo),
          resolvedPage: base.page,
          notPerformedNotice:
            'This was a dry run — no bytes were uploaded and no video was created.',
          classifyOutcome: classifyPublishFailure,
          classifyResult: createVideoVerdict,
          metadata: {
            publishState: plan.publishState,
            delivery: source.kind === 'url' ? 'file-url' : 'resumable-upload',
            ...targetingMeta(plan),
          },
          perform: async (): Promise<CreateVideoOutcome> => {
            const common = {
              pageId: base.page.pageId,
              publishState: plan.publishState,
              ...(echo !== undefined ? { schedule: echo } : {}),
              ...targetingMeta(plan),
              // CC-MEDIA-7: "uploaded" is not "live".
              isPublishedAndProcessed: false,
              processingNote: VIDEO_CREATED_NOT_READY_NOTE,
              verifyNote:
                plan.publishState === 'published'
                  ? PUBLISH_VERIFY_NOTE
                  : VIDEO_UNPUBLISHED_VERIFY_NOTE,
            };

            if (source.kind === 'url') {
              const res = await ctx.fbRequest<unknown>(
                videoByUrlRequest(
                  base.page.pageId,
                  plan.params,
                  requestScope(ctx, base.page),
                ),
              );
              const videoId = ackId(ackOf(res.data).id) ?? null;
              return {
                videoId,
                delivery: 'file-url',
                ...common,
                processingNote: videoProcessingNote(
                  undefined,
                  videoId,
                  plan.publishState,
                ),
              };
            }

            // `resolved`/`digest` are always set for a local source; a missing
            // one fails closed (NaN matches no size, '' no hash) rather than
            // skipping the check.
            const file = await readBoundLocalMedia(source.path, opts, {
              bytes: resolved?.bytes ?? Number.NaN,
              sha256: digest?.sha256 ?? '',
            });
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
                ...(typeof plan.params['targeting'] === 'string'
                  ? { targeting: plan.params['targeting'] }
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
              processingNote: videoProcessingNote(
                result.success,
                result.videoId,
                plan.publishState,
              ),
            };
          },
        });
      }),
  });
}

// ---------------------------------------------------------------------------
// 10. facebook_create_reel
// ---------------------------------------------------------------------------

export function buildCreateReel() {
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
    // Reels swap `published` for `video_state`, which is the argument that
    // decides whether this goes live — and the Reels flow has no unpublish step,
    // so that value is the one most worth having on stderr afterwards.
    logFields: ['profile', 'apply', 'plan_id', 'video_state', 'scheduled_publish_time'],
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
        // Streamed, not buffered: binding the content costs one chunk of memory.
        const digest = await digestLocalMedia(resolved, path, opts);

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
            sha256: digest.sha256,
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
            const file = await readBoundLocalMedia(path, opts, {
              bytes: resolved.bytes,
              sha256: digest.sha256,
            });
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
              // The state that was REQUESTED on the finish call, echoed back —
              // Graph's finish response carries no state to read, and the Reel
              // is still encoding (`isPublishedAndProcessed: false` below).
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
// 10b. facebook_create_story
// ---------------------------------------------------------------------------

export function buildCreateStory() {
  return defineTool({
    name: 'facebook_create_story',
    title: 'Create Story',
    description:
      'Publish a photo or video story on the Page. A story is public at once for ' +
      '24 hours, cannot be scheduled, and this server cannot delete it, so it is ' +
      'irreversible: applying needs apply:true and the plan_id of a preceding dry ' +
      'run, whatever FB_WRITE_MODE says. Verify with facebook_list_stories. Dry run ' +
      'by default.',
    inputSchema: z.object({
      ...confirmableWriteArgs,
      media_type: z
        .enum(STORY_MEDIA_TYPES)
        .describe('photo ⇒ jpeg/bmp/png/gif/tiff, at most 10 MB. video ⇒ a local .mp4.'),
      media: z
        .string()
        .min(1)
        .describe(
          'A photo: an https:// URL Meta fetches itself, or a local file inside FB_MEDIA_DIR. A video: a local .mp4 inside FB_MEDIA_DIR (its bytes are uploaded from this server; a URL is refused).',
        ),
      is_ai_generated: z
        .boolean()
        .optional()
        .describe('Video stories only: label the video as AI-generated.'),
    }),
    annotations: CREATE_ANNOTATIONS,
    writeTier: 'irreversible',
    logFields: ['profile', 'apply', 'plan_id', 'media_type'],
    handler: (input, ctx) =>
      guarded(ctx, async () => {
        const base = await prepareBase(ctx, input, { needTimezone: false });
        const source = toMediaSource(input.media);
        const problem = validateStoryMedia({
          mediaType: input.media_type,
          source,
          ...(input.is_ai_generated !== undefined
            ? { isAiGenerated: input.is_ai_generated }
            : {}),
        });
        if (problem !== undefined) {
          throw new ToolInputError(
            problem.field,
            problem.message,
            'Fix the argument and run the preview again. Nothing was uploaded.',
          );
        }

        const opts: LocalMediaOptions = {
          ...localMediaOptions(ctx),
          maxBytes:
            input.media_type === 'photo' ? MAX_STORY_PHOTO_BYTES : MAX_LOCAL_VIDEO_BYTES,
        };
        // The dry run proves the source usable and binds a local file's content.
        let bound:
          | { readonly path: string; readonly bytes: number; readonly sha256: string }
          | undefined;
        let from: string;
        if (source.kind === 'local') {
          const resolved = await resolveLocalMediaPath(source.path, opts);
          const digest = await digestLocalMedia(resolved, source.path, opts);
          bound = { path: resolved.path, bytes: resolved.bytes, sha256: digest.sha256 };
          from = `${resolved.filename}, ${String(resolved.bytes)} bytes, sha256 ${digest.sha256.slice(0, 12)}`;
        } else {
          from = resolveRemoteMediaUrl(source.url);
        }

        return executeWrite(ctx, {
          tool: 'facebook_create_story',
          tier: 'irreversible',
          requirePlanId: true,
          pageId: base.page.pageId,
          params: {
            media_type: input.media_type,
            media: bound?.path ?? input.media,
            ...(bound !== undefined
              ? { byte_length: bound.bytes, sha256: bound.sha256 }
              : {}),
            ...(input.is_ai_generated !== undefined
              ? { is_ai_generated: input.is_ai_generated }
              : {}),
          },
          ...gateArgs(input),
          summary: `Publish a ${input.media_type} story on ${base.page.name} (${base.page.pageId}) from ${from}`,
          warnings: storyPlanWarnings(input.media_type, source.kind),
          resolvedPage: base.page,
          notPerformedNotice:
            'This was a dry run — nothing was uploaded and no story was published.',
          classifyOutcome: classifyPublishFailure,
          metadata: {
            mediaType: input.media_type,
            sourceKind: source.kind,
            ...(bound !== undefined
              ? { byteLength: bound.bytes, sha256: bound.sha256 }
              : {}),
          },
          perform: async (): Promise<Record<string, unknown>> => {
            if (input.media_type === 'photo') {
              const story = await publishPhotoStory(
                { ...mediaDeps(ctx), maxBytes: MAX_STORY_PHOTO_BYTES },
                {
                  pageId: base.page.pageId,
                  source:
                    source.kind === 'local' && bound !== undefined
                      ? { kind: 'local', path: source.path, sha256: bound.sha256 }
                      : source,
                  token: base.page.token,
                  ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
                },
              );
              return {
                ...story,
                storyPostId: story.storyPostId ?? null,
                verifyTool: STORY_VERIFY_TOOL,
              };
            }
            if (source.kind !== 'local' || bound === undefined) {
              throw new Error('A video story needs a bound local file.');
            }
            const file = await readBoundLocalMedia(source.path, opts, bound);
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
            const story = await publishVideoStory(deps, {
              pageId: base.page.pageId,
              data: file.data,
              contentType: videoContentType(file.filename),
              ...(input.is_ai_generated !== undefined
                ? { isAiGenerated: input.is_ai_generated }
                : {}),
              token: base.page.token,
            });
            return {
              ...story,
              storyPostId: story.storyPostId ?? null,
              verifyTool: STORY_VERIFY_TOOL,
              processingNote:
                'The story is accepted; Meta may still be encoding the video, so it can take a moment to show.',
            };
          },
        });
      }),
  });
}
