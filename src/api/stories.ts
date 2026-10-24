// Graph-shaped helpers for Page Stories, `api` layer:
//   * READ (organic F2): the `/{page-id}/stories` edge, its row mapping and the
//     client-side status filter. The tool wiring lives in `src/tools/reader.ts`.
//   * WRITE (organic F1): publishing a photo story (`/photo_stories`) or a video
//     story (`/video_stories`, the Reels start/transfer protocol on another
//     edge). The tool wiring lives in `src/tools/posts.ts`.
// No zod, no `defineTool`.
//
// Design decisions:
//   * Rows are MAPPED to a fixed camelCase shape rather than passed through: the
//     edge documents exactly six fields and no `fields` selection, so there is
//     nothing for an override to reach.
//   * `status` has no documented query parameter, so it is filtered after the
//     fetch. A filter that drops rows says so (`filteredOut`), because a short
//     page must not read as the end of the listing.
//   * ARCHIVED stories only exist while the Page's story archive is enabled, so
//     an empty listing carries that hint instead of reading as "no stories".

import { extname } from 'node:path';

import { GraphApiError } from '../core/index.js';
import type { Cursor, FbRequestFn, PageRequest, ParamValue } from '../core/index.js';
import {
  cleanupUnpublishedPhotos,
  uploadPhoto,
  type MediaPhotoDeps,
  type OrphanCleanupReport,
  type PhotoSource,
} from './media-photos.js';
import { startReelUpload, uploadReelBinary, type ReelsDeps } from './media-reels.js';
import { fetchPage, type EdgeRequest } from './shared.js';

/** The story lifecycle states the edge reports. */
export const STORY_STATUSES = ['PUBLISHED', 'ARCHIVED'] as const;

export type StoryStatus = (typeof STORY_STATUSES)[number];

/** The `/{page-id}/stories` edge. */
export const STORIES_EDGE = 'stories';

/** Emitted on an empty listing: archived stories need the Page's archive on. */
export const EMPTY_STORIES_NOTE =
  'No stories came back. Stories expire after 24 hours; ARCHIVED stories are listed only ' +
  "while the Page's story archive is enabled, so an empty result is not proof the Page " +
  'never posted one.';

/** Emitted when the status filter dropped rows from this page. */
export function storiesFilteredNote(filteredOut: number, status: StoryStatus): string {
  return (
    `${String(filteredOut)} story row(s) on this page were not ${status} and were left out. ` +
    'A short page is not the end of the listing — follow nextCursor while it is present.'
  );
}

/** One mapped story row. Fields Graph did not send are absent, never invented. */
export interface StoryItem {
  readonly postId: string;
  readonly status?: string;
  /** ISO 8601, converted from Graph's epoch seconds (or passed through when already ISO). */
  readonly createdTime?: string;
  readonly mediaType?: string;
  readonly mediaId?: string;
  readonly url?: string;
}

export interface ListStoriesOptions {
  readonly pageId: string;
  readonly token?: string;
  readonly signal?: AbortSignal;
  /** Unix seconds, inclusive lower bound on the story's creation time. */
  readonly since?: number;
  /** Unix seconds, upper bound on the story's creation time. */
  readonly until?: number;
  /** Client-side filter on the row's `status`. */
  readonly status?: StoryStatus;
  readonly limit?: number;
  readonly after?: Cursor;
}

export interface StoryListResult {
  readonly pageId: string;
  readonly stories: readonly StoryItem[];
  readonly count: number;
  /** Rows on this page the status filter dropped; present only when a filter was given. */
  readonly filteredOut?: number;
  readonly nextCursor?: Cursor;
  readonly truncated: boolean;
  readonly notes: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * Graph's `creation_time` as ISO 8601. The edge documents epoch seconds, sent as
 * a number or a digit string; an ISO value passes through unchanged, and
 * anything unreadable is dropped rather than guessed.
 */
export function storyTimeToIso(value: unknown): string | undefined {
  const raw = stringOf(value);
  if (raw === undefined) return undefined;
  if (/^\d+$/.test(raw)) {
    const ms = Number(raw) * 1000;
    return Number.isSafeInteger(ms) ? new Date(ms).toISOString() : undefined;
  }
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** Map one raw story row; `undefined` when it carries no `post_id` to act on. */
export function mapStory(raw: unknown): StoryItem | undefined {
  if (!isRecord(raw)) return undefined;
  const postId = stringOf(raw.post_id);
  if (postId === undefined) return undefined;
  const status = stringOf(raw.status);
  const createdTime = storyTimeToIso(raw.creation_time);
  const mediaType = stringOf(raw.media_type);
  const mediaId = stringOf(raw.media_id);
  const url = stringOf(raw.url);
  return {
    postId,
    ...(status !== undefined ? { status: status.toUpperCase() } : {}),
    ...(createdTime !== undefined ? { createdTime } : {}),
    ...(mediaType !== undefined ? { mediaType: mediaType.toLowerCase() } : {}),
    ...(mediaId !== undefined ? { mediaId } : {}),
    ...(url !== undefined ? { url } : {}),
  };
}

/** The edge descriptor for one stories page. */
export function listStoriesRequest(opts: ListStoriesOptions): EdgeRequest {
  return {
    host: 'graph',
    path: `/${opts.pageId}/${STORIES_EDGE}`,
    params: {
      ...(opts.since !== undefined ? { since: opts.since } : {}),
      ...(opts.until !== undefined ? { until: opts.until } : {}),
    },
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };
}

/**
 * Read one cursor page of a Page's Stories, mapped and optionally filtered by
 * status. Graph errors (permissions, an unknown Page) propagate to the matrix.
 */
export async function listStories(
  fbRequest: FbRequestFn,
  opts: ListStoriesOptions,
): Promise<StoryListResult> {
  const page: PageRequest = {
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.after !== undefined ? { after: opts.after } : {}),
  };
  const res = await fetchPage<unknown>(fbRequest, listStoriesRequest(opts), page);
  const mapped = res.data.map(mapStory).filter((s): s is StoryItem => s !== undefined);
  const stories =
    opts.status === undefined ? mapped : mapped.filter((s) => s.status === opts.status);
  const filteredOut = mapped.length - stories.length;
  const notes = [
    res.note,
    opts.status !== undefined && filteredOut > 0
      ? storiesFilteredNote(filteredOut, opts.status)
      : undefined,
    res.data.length === 0 && res.note === undefined ? EMPTY_STORIES_NOTE : undefined,
  ].filter((n): n is string => n !== undefined);
  return {
    pageId: opts.pageId,
    stories,
    count: stories.length,
    ...(opts.status !== undefined ? { filteredOut } : {}),
    ...(res.nextCursor !== undefined ? { nextCursor: res.nextCursor } : {}),
    truncated: res.truncated,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Publishing (organic F1)
// ---------------------------------------------------------------------------

export const PHOTO_STORIES_EDGE = 'photo_stories';
export const VIDEO_STORIES_EDGE = 'video_stories';

/** The read that shows whether a story landed. */
export const STORY_VERIFY_TOOL = 'facebook_list_stories';

export const STORY_MEDIA_TYPES = ['photo', 'video'] as const;

export type StoryMediaType = (typeof STORY_MEDIA_TYPES)[number];

/** Meta's documented photo story ceiling. */
export const MAX_STORY_PHOTO_BYTES = 10 * 1024 * 1024;

/** Documented photo story formats: jpeg, bmp, png, gif, tiff. */
export const STORY_PHOTO_EXTENSIONS: readonly string[] = [
  '.jpg',
  '.jpeg',
  '.bmp',
  '.png',
  '.gif',
  '.tif',
  '.tiff',
];

/** Documented video story format. */
export const STORY_VIDEO_EXTENSIONS: readonly string[] = ['.mp4'];

export const STORY_VISIBILITY_WARNING =
  "A story is public as soon as it lands and stays visible for 24 hours; after that it moves to the Page's story archive only if the archive is on. It cannot be scheduled, and this server has no tool to delete it.";

export const STORY_VIDEO_SPEC_WARNING =
  'Video story limits are not checked locally: 9:16, 1080x1920 recommended (at least 540x960), 24-60 fps, at most 60 seconds. Meta rejects a video outside them at the finish step.';

export const STORY_MEDIA_REUSE_WARNING =
  'Media already used in a previous post is rejected by Meta; use a fresh photo or video.';

export const STORY_REMOTE_PHOTO_WARNING = `The photo is fetched by Meta, so its size (at most ${String(MAX_STORY_PHOTO_BYTES / (1024 * 1024))} MB) and format are checked only by Meta.`;

/** A refusal of the story arguments, raised before any plan is built. */
export interface StoryMediaProblem {
  readonly field: 'media' | 'is_ai_generated';
  readonly message: string;
}

export interface StoryMediaInput {
  readonly mediaType: StoryMediaType;
  readonly source: PhotoSource;
  readonly isAiGenerated?: boolean;
}

/** The lowercase extension of a local path or of a URL's path; '' when none. */
function sourceExtension(source: PhotoSource): string {
  if (source.kind === 'local') return extname(source.path).toLowerCase();
  try {
    return extname(new URL(source.url).pathname).toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Check the story arguments that can be checked without I/O. Sizes are checked
 * by the local-media resolver (its `maxBytes`), and URLs by the remote resolver.
 * A URL without an extension passes: CDNs often serve images from bare paths.
 */
export function validateStoryMedia(
  input: StoryMediaInput,
): StoryMediaProblem | undefined {
  if (input.isAiGenerated !== undefined && input.mediaType === 'photo') {
    return { field: 'is_ai_generated', message: 'only supported for video stories' };
  }
  const ext = sourceExtension(input.source);
  if (input.mediaType === 'video') {
    if (input.source.kind === 'url') {
      return {
        field: 'media',
        message:
          'A video story must be a local .mp4 file inside FB_MEDIA_DIR: its bytes are uploaded from this server. A hosted video URL is not supported yet.',
      };
    }
    if (!STORY_VIDEO_EXTENSIONS.includes(ext)) {
      return {
        field: 'media',
        message: `A video story must be an .mp4 file; got "${ext === '' ? 'no extension' : ext}".`,
      };
    }
    return undefined;
  }
  if (ext !== '' && !STORY_PHOTO_EXTENSIONS.includes(ext)) {
    return {
      field: 'media',
      message: `A photo story must be jpeg, bmp, png, gif or tiff; got "${ext}".`,
    };
  }
  if (ext === '' && input.source.kind === 'local') {
    return {
      field: 'media',
      message: 'A photo story file needs a jpeg, bmp, png, gif or tiff extension.',
    };
  }
  return undefined;
}

/** The plan warnings of one story publish. */
export function storyPlanWarnings(
  mediaType: StoryMediaType,
  sourceKind: PhotoSource['kind'],
): string[] {
  return [
    STORY_VISIBILITY_WARNING,
    ...(mediaType === 'video' ? [STORY_VIDEO_SPEC_WARNING] : []),
    ...(mediaType === 'photo' && sourceKind === 'url'
      ? [STORY_REMOTE_PHOTO_WARNING]
      : []),
    STORY_MEDIA_REUSE_WARNING,
  ];
}

/** What a published story hands back. */
export interface StoryPublishResult {
  /** The story's post id, when Graph returned one. */
  readonly storyPostId?: string;
  /** The photo or video id the story was made from. */
  readonly mediaId: string;
  readonly mediaType: StoryMediaType;
}

/**
 * The story step failed after the media was uploaded.
 *
 *   * `failed`    — Graph refused the story cleanly; nothing was published.
 *   * `attempted` — the story may have landed (timeout, 5xx, a lost or
 *                   unconfirming response). Never retried automatically:
 *                   verify with {@link STORY_VERIFY_TOOL} first.
 */
export class StoryPublishError extends Error {
  override readonly name = 'StoryPublishError';
  readonly mediaType: StoryMediaType;
  readonly mediaId: string;
  readonly outcome: 'failed' | 'attempted';
  /** The unpublished photo cleanup, after a clean photo story refusal. */
  readonly cleanup?: OrphanCleanupReport;

  constructor(
    message: string,
    init: {
      readonly mediaType: StoryMediaType;
      readonly mediaId: string;
      readonly outcome: 'failed' | 'attempted';
      readonly cleanup?: OrphanCleanupReport;
      readonly cause?: unknown;
    },
  ) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.mediaType = init.mediaType;
    this.mediaId = init.mediaId;
    this.outcome = init.outcome;
    if (init.cleanup !== undefined) this.cleanup = init.cleanup;
    Object.setPrototypeOf(this, StoryPublishError.prototype);
  }
}

/** A 4xx Graph refusal the transport did not mark ambiguous: nothing landed. */
function isCleanRejection(err: unknown): err is GraphApiError {
  return (
    err instanceof GraphApiError &&
    err.action?.category !== 'ambiguous' &&
    err.httpStatus >= 400 &&
    err.httpStatus < 500
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The story post id of a confirming response; `null` when nothing confirms. */
function confirmedStory(data: unknown): { readonly postId?: string } | null {
  if (typeof data !== 'object' || data === null) return null;
  const rec = data as Record<string, unknown>;
  const postId = typeof rec['post_id'] === 'string' ? rec['post_id'] : undefined;
  const success = rec['success'];
  if (success === true || (success === undefined && postId !== undefined)) {
    return postId !== undefined ? { postId } : {};
  }
  return null;
}

/** The story POST (`photo_stories` or the video `finish`), with its verdicts. */
async function postStory(
  fbRequest: FbRequestFn,
  input: {
    readonly pageId: string;
    readonly edge: string;
    readonly params: Readonly<Record<string, ParamValue>>;
    readonly mediaType: StoryMediaType;
    readonly mediaId: string;
    readonly token?: string;
    readonly signal?: AbortSignal;
  },
  onRejected: (err: GraphApiError) => Promise<OrphanCleanupReport | undefined>,
): Promise<StoryPublishResult> {
  const what = `${input.mediaType} story`;
  let data: unknown;
  try {
    const res = await fbRequest<unknown>({
      protocol: 'json',
      method: 'POST',
      host: 'graph',
      path: `/${input.pageId}/${input.edge}`,
      params: input.params,
      pageId: input.pageId,
      verifyTool: STORY_VERIFY_TOOL,
      ...(input.token !== undefined ? { token: input.token } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    data = res.data;
  } catch (err) {
    if (isCleanRejection(err)) {
      const cleanup = await onRejected(err);
      throw new StoryPublishError(`Graph refused the ${what}: ${err.message}`, {
        mediaType: input.mediaType,
        mediaId: input.mediaId,
        outcome: 'failed',
        ...(cleanup !== undefined ? { cleanup } : {}),
        cause: err,
      });
    }
    throw new StoryPublishError(
      `The ${what} may have been published: ${messageOf(err)}`,
      {
        mediaType: input.mediaType,
        mediaId: input.mediaId,
        outcome: 'attempted',
        cause: err,
      },
    );
  }
  const confirmed = confirmedStory(data);
  if (confirmed === null) {
    throw new StoryPublishError(
      `Graph answered the ${what} request without confirming it, so it may or may not have been published.`,
      { mediaType: input.mediaType, mediaId: input.mediaId, outcome: 'attempted' },
    );
  }
  return {
    ...(confirmed.postId !== undefined ? { storyPostId: confirmed.postId } : {}),
    mediaId: input.mediaId,
    mediaType: input.mediaType,
  };
}

export interface PublishPhotoStoryInput {
  readonly pageId: string;
  readonly source: PhotoSource;
  readonly token?: string;
  readonly signal?: AbortSignal;
}

/**
 * Upload the photo unpublished, then publish it as a story. A clean refusal of
 * the story step deletes the unpublished photo (best effort); a story step that
 * may have landed keeps it, since the story may reference it.
 */
export async function publishPhotoStory(
  deps: MediaPhotoDeps,
  input: PublishPhotoStoryInput,
): Promise<StoryPublishResult> {
  const photo = await uploadPhoto(deps, {
    pageId: input.pageId,
    source: input.source,
    published: false,
    ...(input.token !== undefined ? { token: input.token } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  return postStory(
    deps.fbRequest,
    {
      pageId: input.pageId,
      edge: PHOTO_STORIES_EDGE,
      params: { photo_id: photo.id },
      mediaType: 'photo',
      mediaId: photo.id,
      ...(input.token !== undefined ? { token: input.token } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    },
    () =>
      cleanupUnpublishedPhotos(deps, [photo.id], {
        ...(input.token !== undefined ? { token: input.token } : {}),
      }),
  );
}

export interface PublishVideoStoryInput {
  readonly pageId: string;
  readonly data: Uint8Array;
  readonly contentType?: string;
  readonly isAiGenerated?: boolean;
  readonly token?: string;
}

/**
 * The video story flow: start on `video_stories`, transfer the bytes to the
 * rupload host, then finish. Start and transfer publish nothing, so their
 * failures pass through as Reels phase errors; the finish is the write.
 */
export async function publishVideoStory(
  deps: ReelsDeps,
  input: PublishVideoStoryInput,
): Promise<StoryPublishResult> {
  const token = input.token !== undefined ? { token: input.token } : {};
  const session = await startReelUpload(deps, {
    pageId: input.pageId,
    edge: VIDEO_STORIES_EDGE,
    label: 'Video story',
    ...token,
  });
  await uploadReelBinary(deps, {
    session,
    data: input.data,
    pageId: input.pageId,
    ...(input.contentType !== undefined ? { contentType: input.contentType } : {}),
    ...token,
  });
  return postStory(
    deps.fbRequest,
    {
      pageId: input.pageId,
      edge: VIDEO_STORIES_EDGE,
      params: {
        upload_phase: 'finish',
        video_id: session.videoId,
        ...(input.isAiGenerated !== undefined
          ? { is_ai_generated: input.isAiGenerated }
          : {}),
      },
      mediaType: 'video',
      mediaId: session.videoId,
      ...token,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    },
    // A refused video stays on Meta's side unpublished; there is no cleanup.
    () => Promise.resolve(undefined),
  );
}
