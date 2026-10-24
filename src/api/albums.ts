// Graph-shaped READ helpers for Page photo albums and photos (organic F3, `api`
// layer): the `/{page-id}/albums`, `/{page-id}/photos` and `/{album-id}/photos`
// edges, their documented field sets and the row mapping. No zod, no
// `defineTool` — the tool wiring lives in `src/tools/reader.ts`.
//
// Design decisions:
//   * Rows are MAPPED to a fixed camelCase shape. The photo listing is the
//     input to other tools (a photo id for insights or a re-share), so a stable
//     shape matters more than pass-through here, and the field sets are short.
//   * The Page photo path DEFAULTS to `type=uploaded`. Graph's own default is
//     `profile` (profile pictures only), which answers "what photos did we
//     post" with a handful of avatars — the wrong answer that looks like a
//     right one.
//   * An album id Graph does not recognise is re-thrown with
//     `facebook_list_albums` as the next tool, because the model's usual
//     mistake is passing a post or photo id where an album id belongs.

import { GraphApiError } from '../core/index.js';
import type { Cursor, FbRequestFn, PageRequest } from '../core/index.js';
import { fetchPage, type EdgeRequest } from './shared.js';

/** The `/{page-id}/albums` edge. */
export const ALBUMS_EDGE = 'albums';

/** The `/{node}/photos` edge (Page or album). */
export const PHOTOS_LIST_EDGE = 'photos';

/** The album field set (organic F3). */
export const ALBUM_FIELDS =
  'id,name,description,type,count,can_upload,cover_photo,link,created_time,updated_time';

/** The photo listing field set (organic F3). */
export const PHOTO_LIST_FIELDS = 'id,created_time,name,link,width,height,album';

/** The Page photo listings Graph offers through `type`. */
export const PHOTO_LIST_TYPES = ['uploaded', 'profile', 'tagged'] as const;

export type PhotoListType = (typeof PHOTO_LIST_TYPES)[number];

/** This server's default — Graph's own (`profile`) lists profile pictures only. */
export const DEFAULT_PHOTO_LIST_TYPE: PhotoListType = 'uploaded';

/** Operator text for an album id Graph does not recognise. */
export const UNKNOWN_ALBUM_TEXT =
  'Graph does not recognise this album id. Album ids come from facebook_list_albums — a post id or a photo id is not an album id.';

/** One mapped album row. Fields Graph did not send are absent, never invented. */
export interface AlbumItem {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly type?: string;
  readonly count?: number;
  readonly canUpload?: boolean;
  readonly coverPhotoId?: string;
  readonly link?: string;
  readonly createdTime?: string;
  readonly updatedTime?: string;
}

/** One mapped photo row. */
export interface PhotoItem {
  readonly id: string;
  readonly createdTime?: string;
  readonly name?: string;
  readonly link?: string;
  readonly width?: number;
  readonly height?: number;
  readonly albumId?: string;
}

interface ScopedOptions {
  readonly token?: string;
  readonly signal?: AbortSignal;
  readonly limit?: number;
  readonly after?: Cursor;
}

export interface ListAlbumsOptions extends ScopedOptions {
  readonly pageId: string;
}

/**
 * Exactly one source: an album, or one of the Page listings. Both absent ⇒ the
 * Page's uploaded photos.
 */
export interface ListPhotosOptions extends ScopedOptions {
  readonly pageId: string;
  readonly albumId?: string;
  readonly type?: PhotoListType;
}

interface PagedListResult {
  readonly nextCursor?: Cursor;
  readonly truncated: boolean;
  readonly notes: readonly string[];
}

export interface AlbumListResult extends PagedListResult {
  readonly pageId: string;
  readonly albums: readonly AlbumItem[];
  readonly count: number;
}

export interface PhotoListResult extends PagedListResult {
  readonly pageId: string;
  /** Set on the album path. */
  readonly albumId?: string;
  /** Set on the Page path: the listing that was actually read. */
  readonly type?: PhotoListType;
  readonly photos: readonly PhotoItem[];
  readonly count: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/** The id of a `{id}` reference object, or of a bare id. */
function refId(value: unknown): string | undefined {
  return isRecord(value) ? stringOf(value.id) : stringOf(value);
}

/** Map one raw album row; `undefined` when it carries no id. */
export function mapAlbum(raw: unknown): AlbumItem | undefined {
  if (!isRecord(raw)) return undefined;
  const id = stringOf(raw.id);
  if (id === undefined) return undefined;
  const name = stringOf(raw.name);
  const description = stringOf(raw.description);
  const type = stringOf(raw.type);
  const count = numberOf(raw.count);
  const coverPhotoId = refId(raw.cover_photo);
  const link = stringOf(raw.link);
  const createdTime = stringOf(raw.created_time);
  const updatedTime = stringOf(raw.updated_time);
  return {
    id,
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(count !== undefined ? { count } : {}),
    ...(typeof raw.can_upload === 'boolean' ? { canUpload: raw.can_upload } : {}),
    ...(coverPhotoId !== undefined ? { coverPhotoId } : {}),
    ...(link !== undefined ? { link } : {}),
    ...(createdTime !== undefined ? { createdTime } : {}),
    ...(updatedTime !== undefined ? { updatedTime } : {}),
  };
}

/** Map one raw photo row; `undefined` when it carries no id. */
export function mapPhoto(raw: unknown): PhotoItem | undefined {
  if (!isRecord(raw)) return undefined;
  const id = stringOf(raw.id);
  if (id === undefined) return undefined;
  const createdTime = stringOf(raw.created_time);
  const name = stringOf(raw.name);
  const link = stringOf(raw.link);
  const width = numberOf(raw.width);
  const height = numberOf(raw.height);
  const albumId = refId(raw.album);
  return {
    id,
    ...(createdTime !== undefined ? { createdTime } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(link !== undefined ? { link } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(albumId !== undefined ? { albumId } : {}),
  };
}

function edgeOf(
  path: string,
  params: EdgeRequest['params'],
  opts: ScopedOptions,
): EdgeRequest {
  return {
    host: 'graph',
    path,
    ...(params !== undefined ? { params } : {}),
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };
}

function pageOf(opts: ScopedOptions): PageRequest {
  return {
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.after !== undefined ? { after: opts.after } : {}),
  };
}

function mapped<T>(rows: readonly unknown[], map: (raw: unknown) => T | undefined): T[] {
  return rows.map(map).filter((row): row is T => row !== undefined);
}

function pagingOf(res: {
  readonly nextCursor?: Cursor;
  readonly truncated: boolean;
  readonly note?: string;
}): PagedListResult {
  return {
    ...(res.nextCursor !== undefined ? { nextCursor: res.nextCursor } : {}),
    truncated: res.truncated,
    notes: res.note !== undefined ? [res.note] : [],
  };
}

/** Read one cursor page of a Page's photo albums. */
export async function listAlbums(
  fbRequest: FbRequestFn,
  opts: ListAlbumsOptions,
): Promise<AlbumListResult> {
  const res = await fetchPage<unknown>(
    fbRequest,
    edgeOf(`/${opts.pageId}/${ALBUMS_EDGE}`, { fields: ALBUM_FIELDS }, opts),
    pageOf(opts),
  );
  const albums = mapped(res.data, mapAlbum);
  return { pageId: opts.pageId, albums, count: albums.length, ...pagingOf(res) };
}

/**
 * Re-throw a not-found on the album path with `facebook_list_albums` as the next
 * tool. Every other error propagates unchanged.
 */
function withAlbumHint(err: unknown): never {
  if (err instanceof GraphApiError && err.action?.category === 'not_found') {
    throw new GraphApiError(`${err.message} — ${UNKNOWN_ALBUM_TEXT}`, {
      code: err.code,
      httpStatus: err.httpStatus,
      ...(err.subcode !== undefined ? { subcode: err.subcode } : {}),
      ...(err.type !== undefined ? { type: err.type } : {}),
      ...(err.fbtraceId !== undefined ? { fbtraceId: err.fbtraceId } : {}),
      action: {
        ...err.action,
        nextTool: 'facebook_list_albums',
        operatorText: UNKNOWN_ALBUM_TEXT,
      },
      cause: err,
    });
  }
  throw err;
}

/**
 * Read one cursor page of photos: an album's when `albumId` is given, otherwise
 * the Page listing named by `type` (default {@link DEFAULT_PHOTO_LIST_TYPE}).
 * Passing both is a caller error.
 */
export async function listPhotos(
  fbRequest: FbRequestFn,
  opts: ListPhotosOptions,
): Promise<PhotoListResult> {
  if (opts.albumId !== undefined && opts.type !== undefined) {
    throw new Error(
      '`album_id` and `type` are mutually exclusive: an album lists its own photos, `type` selects a Page listing.',
    );
  }
  if (opts.albumId !== undefined) {
    const albumId = opts.albumId;
    const res = await fetchPage<unknown>(
      fbRequest,
      edgeOf(`/${albumId}/${PHOTOS_LIST_EDGE}`, { fields: PHOTO_LIST_FIELDS }, opts),
      pageOf(opts),
    ).catch(withAlbumHint);
    const photos = mapped(res.data, mapPhoto);
    return {
      pageId: opts.pageId,
      albumId,
      photos,
      count: photos.length,
      ...pagingOf(res),
    };
  }
  const type = opts.type ?? DEFAULT_PHOTO_LIST_TYPE;
  const res = await fetchPage<unknown>(
    fbRequest,
    edgeOf(
      `/${opts.pageId}/${PHOTOS_LIST_EDGE}`,
      { type, fields: PHOTO_LIST_FIELDS },
      opts,
    ),
    pageOf(opts),
  );
  const photos = mapped(res.data, mapPhoto);
  return { pageId: opts.pageId, type, photos, count: photos.length, ...pagingOf(res) };
}
