// Ad image upload (v2 ads §2) — add one local image to an ad account's image
// library and return its `hash`, the handle creatives reference it by.
//
//   * `POST /act_{id}/adimages`, multipart, the file part named `filename`.
//   * The response nests the image under its file name:
//     `{"images":{"<name>":{"hash","url","width","height","name"}}}` — the first
//     value is read defensively.
//
// The file goes through the same `FB_MEDIA_DIR` containment, symlink and size
// checks as Page photos (`media-photos.ts`); only the format allowlist and the
// size ceiling are ads-specific. Uploading creates no ad and changes no
// delivery, and Meta deduplicates by content hash, so a re-run lands on the
// same library entry.

import { extname } from 'node:path';

import { GraphApiError, classifyGraphError } from '../core/index.js';
import type { FbRequestFn, MultipartRequest } from '../core/index.js';
import { MARKETING_API } from './ads-read.js';
import {
  MediaSourceError,
  detectPhotoContentType,
  multipartFilename,
  readLocalPhoto,
} from './media-photos.js';
import type { LocalMediaOptions, LocalPhotoBytes } from './media-photos.js';

// ---------------------------------------------------------------------------
// 1. Constants and shapes
// ---------------------------------------------------------------------------

/** Meta's ad image guidance; the adimages reference page states no limit. */
export const MAX_AD_IMAGE_BYTES = 30 * 1024 * 1024;

/** The multipart part the adimages edge reads the bytes from. */
export const AD_IMAGE_FILE_FIELD = 'filename';

/** Content types the ad image library accepts. */
export const AD_IMAGE_CONTENT_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/bmp',
  'image/tiff',
  'image/webp',
];

const AD_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.bmp',
  '.tif',
  '.tiff',
  '.webp',
]);

export const AD_IMAGE_LIBRARY_NOTE =
  'Uploading adds the image to the account library; it does not create or change any ad.';

/** Shown when the upload outcome is unknown: the edge is idempotent by hash. */
export const AD_IMAGE_RERUN_NOTE =
  'Ad image uploads are deduplicated by content hash, so re-running this upload is safe; it is not retried automatically.';

/** One image in the account library, as the upload answered it. */
export interface AdImage {
  readonly hash: string;
  readonly url?: string;
  readonly width?: number;
  readonly height?: number;
  readonly name?: string;
}

/** What the tool reports for an upload. `hash` absent ⇒ unconfirmed. */
export interface AdImageUploadOutcome {
  readonly adAccountId: string;
  readonly image?: AdImage;
}

// ---------------------------------------------------------------------------
// 2. Validation
// ---------------------------------------------------------------------------

/**
 * Refuse a file whose extension is not an ad image format, before any byte is
 * read. The upload re-checks the sniffed content type on the buffered bytes.
 */
export function assertAdImageExtension(requested: string, filename: string): void {
  if (AD_IMAGE_EXTENSIONS.has(extname(filename).toLowerCase())) return;
  throw new MediaSourceError(
    'unsupported_format',
    requested,
    `"${filename}" is not an ad image format. Ad images must be JPEG, PNG, GIF, BMP, TIFF or WEBP.`,
  );
}

/**
 * Refuse bytes that carry no ad image signature. The sniff runs on the bytes
 * alone (an empty filename), so a renamed non-image cannot pass on its
 * extension.
 */
function assertAdImageContent(file: LocalPhotoBytes, requested: string): void {
  const sniffed = detectPhotoContentType(file.data, '');
  if (AD_IMAGE_CONTENT_TYPES.includes(sniffed)) return;
  throw new MediaSourceError(
    'unsupported_format',
    requested,
    `"${file.filename}" does not contain a JPEG, PNG, GIF, BMP, TIFF or WEBP image (detected ${sniffed}), so it was not uploaded.`,
  );
}

// ---------------------------------------------------------------------------
// 3. Request and response
// ---------------------------------------------------------------------------

/** `POST /act_{id}/adimages` with the bytes in the `filename` part. */
export function uploadAdImageRequest(
  accountId: string,
  file: {
    readonly data: Uint8Array;
    readonly filename: string;
    readonly contentType: string;
  },
  name: string | undefined,
  signal?: AbortSignal,
): MultipartRequest {
  return {
    protocol: 'multipart',
    method: 'POST',
    host: 'graph',
    api: MARKETING_API,
    path: `/${accountId}/adimages`,
    files: [
      {
        name: AD_IMAGE_FILE_FIELD,
        data: file.data,
        filename: multipartFilename(name ?? file.filename),
        contentType: file.contentType,
      },
    ],
    ...(signal !== undefined ? { signal } : {}),
  };
}

function finiteNumber(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/**
 * The first image of an adimages answer, or undefined when the body carries no
 * usable `hash` (the upload is then unconfirmed, not refused).
 */
export function parseAdImageResponse(body: unknown): AdImage | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const images: unknown = (body as Record<string, unknown>).images;
  if (typeof images !== 'object' || images === null) return undefined;
  const first: unknown = Object.values(images as Record<string, unknown>)[0];
  if (typeof first !== 'object' || first === null) return undefined;
  const node = first as Record<string, unknown>;
  const hash = node.hash;
  if (typeof hash !== 'string' || hash.trim() === '') return undefined;
  const width = finiteNumber(node.width);
  const height = finiteNumber(node.height);
  return {
    hash,
    ...(typeof node.url === 'string' ? { url: node.url } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(typeof node.name === 'string' ? { name: node.name } : {}),
  };
}

// ---------------------------------------------------------------------------
// 4. The write
// ---------------------------------------------------------------------------

export interface AdImageUploadRequest {
  readonly accountId: string;
  /** The path as the caller gave it, resolved again under `FB_MEDIA_DIR`. */
  readonly requested: string;
  /** The size and content hash the plan bound. */
  readonly bound: { readonly bytes: number; readonly sha256: string };
  readonly name?: string;
  readonly signal?: AbortSignal;
}

/**
 * Read the bound file, refuse it if it changed or is not an image, and upload
 * it. Meta's `error_user_msg` on a code-100 refusal (an unreadable image) is
 * surfaced as the message.
 */
export async function uploadAdImage(
  fbRequest: FbRequestFn,
  opts: LocalMediaOptions,
  req: AdImageUploadRequest,
): Promise<AdImageUploadOutcome> {
  const file = await readLocalPhoto(
    req.requested,
    { ...opts, maxBytes: MAX_AD_IMAGE_BYTES },
    req.bound.sha256,
  );
  if (file.bytes !== req.bound.bytes) {
    throw new MediaSourceError(
      'file_changed',
      req.requested,
      `"${req.requested}" is now ${String(file.bytes)} bytes, but the plan was built for ${String(req.bound.bytes)} bytes — the file changed after it was validated, so it was not uploaded. Preview the call again to bind the current file.`,
    );
  }
  assertAdImageContent(file, req.requested);
  try {
    const res = await fbRequest<unknown>(
      uploadAdImageRequest(req.accountId, file, req.name, req.signal),
    );
    const image = parseAdImageResponse(res.data);
    return { adAccountId: req.accountId, ...(image !== undefined ? { image } : {}) };
  } catch (err) {
    throw mapAdImageError(err);
  }
}

/** A code-100 image refusal, restated with Meta's user-facing reason. */
function mapAdImageError(err: unknown): unknown {
  if (!(err instanceof GraphApiError) || err.code !== 100) return err;
  const reason = err.userMessage ?? err.message;
  const message = `Meta refused the image: ${reason} Nothing was added to the library; fix the file and preview again.`;
  return new GraphApiError(message, {
    code: 100,
    httpStatus: err.httpStatus,
    action: classifyGraphError({ code: 100, message }),
  });
}
