// Ad previews (v2 ads §6) — how an existing ad, an existing creative, or a Page
// post used as an ad would render in one placement, without creating anything.
//
//   * ad / creative ⇒ `GET /{id}/previews?ad_format=…`
//   * post          ⇒ `GET /act_{id}/generatepreviews?ad_format=…&creative=
//                      {"object_story_id":"<page>_<post>"}`
//
// Graph answers `{data:[{body:"<iframe src=… …></iframe>"}]}`. Only the iframe's
// `src` is handed on: the HTML around it is Meta's markup, and nothing that
// could carry script ever reaches the model. The `src` embeds a short-lived
// view token (roughly a day), so callers must not log it; it is returned only
// because opening it is the whole point of the read.

import { GraphApiError, classifyGraphError } from '../core/index.js';
import type { FbRequestFn, JsonRequest, ParamValue } from '../core/index.js';
import { MARKETING_API } from './ads-read.js';

/**
 * A curated subset of the v26 `ad_format` enum (70+ values): the placements an
 * operator actually asks about. A short list keeps the schema small.
 */
export const PREVIEW_FORMATS = [
  'DESKTOP_FEED_STANDARD',
  'MOBILE_FEED_STANDARD',
  'FACEBOOK_STORY_MOBILE',
  'FACEBOOK_REELS_MOBILE',
  'INSTAGRAM_STANDARD',
  'INSTAGRAM_STORY',
  'INSTAGRAM_REELS',
  'RIGHT_COLUMN_STANDARD',
  'MARKETPLACE_MOBILE',
] as const;

export type PreviewFormat = (typeof PREVIEW_FORMATS)[number];

export const DEFAULT_PREVIEW_FORMAT: PreviewFormat = 'MOBILE_FEED_STANDARD';

/** How long Meta keeps a preview URL usable (documented as about 24 hours). */
export const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;

/** What is being previewed. */
export type PreviewSource =
  | { readonly kind: 'ad'; readonly adId: string }
  | { readonly kind: 'creative'; readonly creativeId: string }
  | {
      readonly kind: 'post';
      /** Normalised `act_<id>`; generatepreviews hangs off an ad account. */
      readonly accountId: string;
      /** `<page-id>_<post-id>`, Graph's `object_story_id`. */
      readonly objectStoryId: string;
    };

export interface AdPreviewOptions {
  readonly source: PreviewSource;
  readonly adFormat: PreviewFormat;
  /** Wall-clock now, for {@link AdPreview.validUntil}. */
  readonly nowMs: number;
  readonly signal?: AbortSignal;
}

export interface AdPreview {
  readonly adFormat: PreviewFormat;
  /** The preview iframe URL. Carries a short-lived view token — never log it. */
  readonly iframeSrc: string;
  /** ISO time after which Meta stops serving {@link iframeSrc}. */
  readonly validUntil: string;
  readonly note: string;
}

export const PREVIEW_NOTE =
  'Open iframeSrc in a browser to see the preview. The link carries a short-lived ' +
  'view token: it stops working after about 24 hours, and it should not be pasted ' +
  'anywhere public.';

/** Hosts a preview iframe may point at; anything else is not handed on. */
const PREVIEW_HOST = /(^|\.)facebook\.com$/;

/** A preview answer that holds no usable iframe. */
function malformedPreviewError(detail: string): GraphApiError {
  const message =
    `Facebook answered the preview request without a usable preview (${detail}). ` +
    'Nothing was created. Try another ad_format — not every creative renders in every placement.';
  return new GraphApiError(message, {
    code: 0,
    httpStatus: 502,
    action: {
      category: 'unknown',
      retryable: false,
      operatorText: message,
    },
  });
}

/** A client-side parameter error, classified through the shared matrix (code 100). */
function validationError(message: string): GraphApiError {
  return new GraphApiError(message, {
    code: 100,
    httpStatus: 400,
    action: classifyGraphError({ code: 100, message }),
  });
}

/** The single GET a preview takes. Pure: no request is made. */
export function previewRequest(
  source: PreviewSource,
  adFormat: PreviewFormat,
  signal?: AbortSignal,
): JsonRequest {
  let path: string;
  const params: Record<string, ParamValue> = { ad_format: adFormat };
  if (source.kind === 'post') {
    path = `/${source.accountId}/generatepreviews`;
    params.creative = JSON.stringify({ object_story_id: source.objectStoryId });
  } else {
    path = `/${source.kind === 'ad' ? source.adId : source.creativeId}/previews`;
  }
  return {
    protocol: 'json',
    method: 'GET',
    host: 'graph',
    api: MARKETING_API,
    path,
    params,
    ...(signal !== undefined ? { signal } : {}),
  };
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&quot;': '"',
  '&#039;': "'",
  '&#39;': "'",
  '&lt;': '<',
  '&gt;': '>',
};

function unescapeHtml(value: string): string {
  return value.replace(
    /&(?:amp|quot|#0?39|lt|gt);/g,
    (entity) => HTML_ENTITIES[entity] ?? entity,
  );
}

/**
 * Pull the iframe `src` out of a previews answer. Only an https URL on a
 * facebook.com host is accepted; anything else is refused rather than passed on.
 *
 * @throws GraphApiError when the answer holds no usable iframe.
 */
export function parsePreview(raw: unknown): string {
  const data =
    typeof raw === 'object' && raw !== null
      ? (raw as { data?: unknown }).data
      : undefined;
  const first = Array.isArray(data) ? (data[0] as unknown) : undefined;
  const body =
    typeof first === 'object' && first !== null
      ? (first as { body?: unknown }).body
      : undefined;
  if (typeof body !== 'string') throw malformedPreviewError('no preview body');

  const match = /<iframe\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(body);
  const src = match?.[1] ?? match?.[2];
  if (src === undefined) throw malformedPreviewError('no iframe in the preview body');

  let url: URL;
  try {
    url = new URL(unescapeHtml(src));
  } catch {
    throw malformedPreviewError('the iframe src is not a URL');
  }
  if (url.protocol !== 'https:' || !PREVIEW_HOST.test(url.hostname)) {
    throw malformedPreviewError('the iframe points outside facebook.com');
  }
  return url.toString();
}

/** `<page-id>_<post-id>` — the only post id form generatepreviews accepts. */
const OBJECT_STORY_ID = /^\d+_\d+$/;

/**
 * Check a post id for {@link PreviewSource} `post`.
 *
 * @throws GraphApiError (validation) on anything but `<page-id>_<post-id>`.
 */
export function normalizeObjectStoryId(raw: string): string {
  const trimmed = raw.trim();
  if (!OBJECT_STORY_ID.test(trimmed)) {
    throw validationError(
      `Invalid post id: "${raw}". Use the full "<page-id>_<post-id>" form that facebook_list_posts returns.`,
    );
  }
  return trimmed;
}

/** Render a preview of an existing ad or creative, or of a Page post as an ad. */
export async function generateAdPreview(
  fbRequest: FbRequestFn,
  opts: AdPreviewOptions,
): Promise<AdPreview> {
  const res = await fbRequest<unknown>(
    previewRequest(opts.source, opts.adFormat, opts.signal),
  );
  return {
    adFormat: opts.adFormat,
    iframeSrc: parsePreview(res.data),
    validUntil: new Date(opts.nowMs + PREVIEW_TTL_MS).toISOString(),
    note: PREVIEW_NOTE,
  };
}
