// `posts` package — feed publishing: facebook_create_post (text / link /
// link carousel / multi-photo carousel) and facebook_create_photo_post.

import { z } from 'zod';
import type { ParamValue } from '../../core/index.js';
import {
  albumUploadRefusal,
  readAlbumUploadCheck,
  type AlbumUploadCheck,
} from '../../api/albums.js';
import {
  cleanupUnpublishedPhotos,
  preparePhotoSource,
  preparePhotoSources,
  uploadPhoto,
  uploadUnpublishedPhotos,
  type PhotoSource,
} from '../../api/media-photos.js';
import {
  CarouselPostError,
  publishVerifyNote,
  feedPostRequest,
  planCreatePost,
  toMediaSource,
  type PostPlan,
} from '../../api/posts-write.js';
import { defineTool } from '../../mcp/index.js';
import { executeWrite, graphNodeIdArg, writeArgs } from '../shared.js';
import {
  CREATE_ANNOTATIONS,
  altTextArg,
  altTextLine,
  carouselAltTextLine,
  pageTimezoneArg,
  publishedArg,
  scheduledPublishTimeArg,
  targetingArg,
  withAltTextLine,
} from './args.js';
import {
  bindLocalPhotoContent,
  mediaDeps,
  planWarnings,
  prepareBase,
  report,
  requestScope,
  targetingMeta,
  toTimeEcho,
} from './context.js';
import { CarouselPostUnconfirmedError, ToolInputError, guarded } from './errors.js';
import {
  CreatePostOutcome,
  classifyPublishFailure,
  createPostVerdict,
  createdPostId,
  publishesNow,
} from './outcomes.js';

// ---------------------------------------------------------------------------
// 7. facebook_create_post
// ---------------------------------------------------------------------------

export function buildCreatePost() {
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
        .array(
          z.union([
            z.string().min(1),
            z
              .object({
                source: z
                  .string()
                  .min(1)
                  .describe('The photo source, as in the string form.'),
                alt_text: altTextArg,
              })
              .strict(),
          ]),
        )
        .min(1)
        .optional()
        .describe(
          'Photo sources for a photo post: each is an https:// URL Meta fetches itself, or a local file path inside FB_MEDIA_DIR — either as a plain string or as {source, alt_text}. Uploaded sequentially as UNPUBLISHED children, then attached to one feed post. Cannot be combined with link or child_attachments.',
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
      targeting: targetingArg,
    }),
    annotations: CREATE_ANNOTATIONS,
    writeTier: 'reversible',
    // Every write in this package records the same three things on stderr: which
    // Page it was aimed at, whether it was armed (`apply`, and the `plan_id`
    // that bound it), and whether it reaches an audience now, later or never.
    // The post CONTENT is absent by design — `message`, `link`, `photos` and
    // `child_attachments` are model-composed text, URLs and file paths, and the
    // log line is not a place to reprint them (04 §"Log hygiene"). What is left
    // still answers the question an operator actually asks of a log: did this
    // call put something in front of an audience, and when.
    logFields: ['profile', 'apply', 'plan_id', 'published', 'scheduled_publish_time'],
    handler: (input, ctx) =>
      guarded(ctx, async () => {
        const base = await prepareBase(ctx, input, {
          needTimezone: input.scheduled_publish_time !== undefined,
        });
        const photoEntries = (input.photos ?? []).map((entry) =>
          typeof entry === 'string' ? { source: entry } : entry,
        );
        const sources: PhotoSource[] = photoEntries.map((entry) =>
          toMediaSource(entry.source),
        );
        const altTexts = photoEntries.map((entry) => entry.alt_text);

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
            ...(input.targeting !== undefined ? { targeting: input.targeting } : {}),
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
        const prepared =
          sources.length > 0 ? await preparePhotoSources(sources, media) : [];
        // Each local photo's content hash joins the plan: the apply uploads
        // exactly the bytes the preview described, or refuses (`file_changed`).
        const boundSources = await bindLocalPhotoContent(sources, prepared, media);
        const photoHashes = boundSources.map((source) =>
          source.kind === 'local' ? (source.sha256 ?? null) : null,
        );

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
            ...(photoHashes.some((hash) => hash !== null)
              ? { photo_sha256: photoHashes }
              : {}),
          },
          ...(input.apply !== undefined ? { apply: input.apply } : {}),
          ...(input.plan_id !== undefined ? { planId: input.plan_id } : {}),
          summary: withAltTextLine(plan.summary, carouselAltTextLine(altTexts)),
          warnings: planWarnings(plan, echo),
          resolvedPage: base.page,
          notPerformedNotice:
            'This was a dry run — nothing was posted and no photo was uploaded.',
          classifyOutcome: classifyPublishFailure,
          classifyResult: createPostVerdict,
          metadata: {
            publishState: plan.publishState,
            photoCount: sources.length,
            ...targetingMeta(plan),
          },
          perform: async (): Promise<CreatePostOutcome> => {
            const scope = requestScope(ctx, base.page);
            let attachedMedia: Readonly<Record<string, string>> = {};
            let photoIds: string[] = [];

            if (sources.length > 0) {
              const uploaded = await uploadUnpublishedPhotos(media, {
                pageId: base.page.pageId,
                sources: boundSources,
                ...(altTexts.some((text) => text !== undefined) ? { altTexts } : {}),
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
              const res = await ctx.fbRequest<unknown>(
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
                ...targetingMeta(plan),
                verifyNote: publishVerifyNote(plan.publishState),
              };
            } catch (err) {
              // On a clean rejection the children exist but nothing references
              // them: this call owns their cleanup (CC-MEDIA-10). The cleanup runs WITHOUT the call's
              // signal so a cancelled post still tidies up after itself.
              if (photoIds.length === 0) throw err;
              // A failure that may have landed leaves a post that may reference
              // every child: deleting them would gut it, so hand the ids back.
              if (classifyPublishFailure(err) === 'attempted') {
                throw new CarouselPostUnconfirmedError({
                  cause: err,
                  photoIds,
                  publishState: plan.publishState,
                });
              }
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

/** Graph documents `published` on the album photos edge but not scheduling. */
const ALBUM_SCHEDULE_UNVERIFIED =
  'Scheduling a photo into an album is not documented on the album photos edge and is unverified — check the post time with facebook_list_scheduled_posts after applying.';

export function buildCreatePhotoPost() {
  return defineTool({
    name: 'facebook_create_photo_post',
    title: 'Create Photo Post',
    description:
      'Publish ONE photo to a Page, optionally with a caption, as a draft, or ' +
      'scheduled, and optionally into one of the Page albums (album_id). The photo ' +
      'is either an https:// URL Meta fetches itself or a local file inside ' +
      'FB_MEDIA_DIR. Dry run by default.',
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
      alt_text: altTextArg,
      published: publishedArg,
      scheduled_publish_time: scheduledPublishTimeArg,
      page_timezone: pageTimezoneArg,
      targeting: targetingArg,
      album_id: graphNodeIdArg({
        hint: 'Album ids come from facebook_list_albums.',
      })
        .optional()
        .describe(
          "Upload into this album instead of the Page's default Timeline Photos album. The album must belong to the Page, accept uploads, and be a normal or app album (not profile/cover).",
        ),
    }),
    annotations: CREATE_ANNOTATIONS,
    writeTier: 'reversible',
    // `photo` is a URL or a path inside FB_MEDIA_DIR and `caption` is composed
    // text; neither belongs on stderr, and the scheduling pair already says
    // whether this became visible.
    logFields: ['profile', 'apply', 'plan_id', 'published', 'scheduled_publish_time'],
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
            ...(input.targeting !== undefined ? { targeting: input.targeting } : {}),
          },
          {
            nowMs: base.nowMs,
            ...(base.pageTimezone !== undefined
              ? { pageTimezone: base.pageTimezone }
              : {}),
          },
        );

        const media = mediaDeps(ctx);
        // Same contract as the carousel: the source is proven usable in the dry
        // run, and a local file's content hash is bound into the plan.
        const [boundSource] = await bindLocalPhotoContent(
          [source],
          [await preparePhotoSource(source, media)],
          media,
        );
        const photoSha256 =
          boundSource?.kind === 'local' ? boundSource.sha256 : undefined;

        // F4: the album is checked at plan time, so a wrong album is refused in
        // the dry run rather than after the upload.
        let album: AlbumUploadCheck | undefined;
        if (input.album_id !== undefined) {
          album = await readAlbumUploadCheck(ctx.fbRequest, {
            albumId: input.album_id,
            token: base.page.token,
            ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
          });
          const refusal = albumUploadRefusal(album, base.page.pageId);
          if (refusal !== undefined) {
            throw new ToolInputError(
              'album_id',
              refusal,
              "Pick an album with can_upload:true from facebook_list_albums, or omit album_id to use the Page's Timeline Photos.",
            );
          }
        }
        const albumLabel =
          album === undefined
            ? undefined
            : album.name !== undefined
              ? `"${album.name}" (${album.albumId})`
              : album.albumId;

        const echo = plan.schedule !== undefined ? toTimeEcho(plan.schedule) : undefined;
        const extraParams: Record<string, ParamValue> = {
          ...(plan.schedule !== undefined
            ? { scheduled_publish_time: plan.schedule.epochSeconds }
            : {}),
          ...(plan.params['targeting'] !== undefined
            ? { targeting: plan.params['targeting'] }
            : {}),
        };

        return executeWrite(ctx, {
          tool: 'facebook_create_photo_post',
          tier: 'reversible',
          requirePlanId: publishesNow(plan.publishState),
          pageId: base.page.pageId,
          params: {
            ...plan.params,
            photo: input.photo,
            ...(input.alt_text !== undefined ? { alt_text: input.alt_text } : {}),
            ...(photoSha256 !== undefined ? { photo_sha256: photoSha256 } : {}),
            ...(album !== undefined ? { album_id: album.albumId } : {}),
          },
          ...(input.apply !== undefined ? { apply: input.apply } : {}),
          ...(input.plan_id !== undefined ? { planId: input.plan_id } : {}),
          summary: withAltTextLine(
            albumLabel === undefined
              ? plan.summary
              : `Publish a photo to album ${albumLabel} on Page ${base.page.pageId}. ${plan.summary}`,
            input.alt_text !== undefined ? altTextLine(input.alt_text) : undefined,
          ),
          warnings: [
            ...planWarnings(plan, echo),
            ...(album !== undefined && plan.schedule !== undefined
              ? [ALBUM_SCHEDULE_UNVERIFIED]
              : []),
          ],
          resolvedPage: base.page,
          notPerformedNotice: 'This was a dry run — no photo was uploaded or posted.',
          classifyOutcome: classifyPublishFailure,
          metadata: {
            publishState: plan.publishState,
            ...targetingMeta(plan),
            ...(album !== undefined ? { albumId: album.albumId } : {}),
          },
          perform: async (): Promise<Record<string, unknown>> => {
            const uploaded = await uploadPhoto(media, {
              pageId: base.page.pageId,
              source: boundSource ?? source,
              ...(album !== undefined
                ? { targetEdge: { kind: 'album' as const, albumId: album.albumId } }
                : {}),
              ...(input.caption !== undefined ? { caption: input.caption } : {}),
              ...(input.alt_text !== undefined ? { altText: input.alt_text } : {}),
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
              ...(album !== undefined ? { albumId: album.albumId } : {}),
              ...(echo !== undefined ? { schedule: echo } : {}),
              ...targetingMeta(plan),
              verifyNote: publishVerifyNote(plan.publishState),
            };
          },
        });
      }),
  });
}
