// Graph-shaped READ helpers for Page Stories (organic F2, `api` layer): the
// `/{page-id}/stories` edge, its row mapping and the client-side status filter.
// No zod, no `defineTool` — the tool wiring lives in `src/tools/reader.ts`.
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

import type { Cursor, FbRequestFn, PageRequest } from '../core/index.js';
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
