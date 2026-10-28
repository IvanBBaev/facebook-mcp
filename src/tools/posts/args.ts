// `posts` package — annotation quadruples and the input fields the posts
// tools share (schedule, publish state, alt text, ids, organic targeting).

import { z } from 'zod';
import type { ToolAnnotations } from '../../core/index.js';
import { TARGETING_LIMITS } from '../../api/posts-write.js';
import { graphNodeIdArg, videoIdArg } from '../shared.js';

// ---------------------------------------------------------------------------
// 1. Annotation quadruples (doc 06 — SSOT; all four hints always explicit)
// ---------------------------------------------------------------------------

/**
 * The create-family quadruple: writes, does not destroy prior state, and is NOT
 * idempotent (a repeated call publishes a second post — Graph offers no
 * idempotency key, which is exactly why C2 forbids blind retries).
 */
export const CREATE_ANNOTATIONS: ToolAnnotations = {
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
export const MUTATE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

/** The read-only quadruple — no `writeTier`, which `defineTool` cross-checks. */
export const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

// ---------------------------------------------------------------------------
// 2. Shared input fields
// ---------------------------------------------------------------------------

export const scheduledPublishTimeArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    'When to publish, as an ISO-8601 instant WITH an explicit offset — "2026-08-01T09:30:00+03:00" or "2026-08-01T06:30:00Z". A bare local time ("2026-08-01T09:30:00") and a raw epoch number are both REFUSED, because they have no unambiguous meaning. Must be at least 10 minutes and at most 75 days ahead. Setting this creates the post unpublished; do NOT also pass published:true.',
  );

export const pageTimezoneArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    'IANA timezone name of the Page (e.g. "Europe/Sofia"), used only to echo a scheduled instant in Page-local time next to UTC. Omitted ⇒ the server reads the Page\'s own timezone; if that read fails the echo is UTC-only.',
  );

export const publishedArg = z
  .boolean()
  .optional()
  .describe(
    'false ⇒ create the post UNPUBLISHED (a draft that stays invisible until facebook_update_post action:"publish_now"). Omitted or true ⇒ publish immediately. Must be omitted when scheduled_publish_time is set.',
  );

/** F10: Graph's `alt_text_custom` on a photo upload. */
export const altTextArg = z
  .string()
  .min(1)
  .max(1000)
  .optional()
  .describe(
    'Alt text for screen readers, up to 1000 characters. Omitted ⇒ no custom alt text is sent.',
  );

export function altTextLine(text: string): string {
  return `Alt text: yes (${String(text.length)} chars).`;
}

/** Undefined when no photo carries alt text, so the summary stays unchanged. */
export function carouselAltTextLine(
  altTexts: readonly (string | undefined)[],
): string | undefined {
  const withAlt = altTexts.filter((text) => text !== undefined).length;
  if (withAlt === 0) return undefined;
  return `Alt text: ${String(withAlt)} of ${String(altTexts.length)} photos.`;
}

export function withAltTextLine(summary: string, line: string | undefined): string {
  return line === undefined ? summary : `${summary} ${line}`;
}

/**
 * The post id argument for the two lifecycle writes. The SHAPE is the shared one
 * (`./shared.js`): `/{post_id}` is built by interpolation, so an id carrying a
 * `/` would aim an advertised post edit or delete at a different Graph node
 * under the same Page token — see `GRAPH_NODE_ID_SHAPE` for why the HTTP layer
 * cannot catch that on its own.
 */
export const postIdArg = graphNodeIdArg({
  hint: 'Pass the `id` facebook_list_posts or facebook_list_scheduled_posts returns, verbatim.',
  description:
    'The post ID, normally "{page-id}_{post-id}". Only posts this same app created can be edited or deleted — a post made in the Facebook UI or by another app is not addressable here.',
});

/**
 * The video id argument for the status poll. The SHAPE and the rejection
 * wording are the shared ones (`./shared.js`): a `{page-id}_{post-id}` composite
 * addresses a POST and cannot resolve on this edge, so it is refused here —
 * locally, with a message that names the mistake — instead of being spent on a
 * Graph round-trip that can only fail.
 */
export const statusVideoIdArg = videoIdArg({
  hint: 'facebook_create_video_post returns it as `videoId`.',
  description:
    'The VIDEO ID — the `videoId` facebook_create_video_post returned, not a post ID. A "{page-id}_{post-id}" value is a post, not a video, and does not resolve on this edge.',
});

/**
 * The organic audience restriction shared by the three create tools. Graph
 * documents only `age_min` and `geo_locations` on the publishing object; the
 * list caps are this server's guardrails, not Graph limits.
 */
const locationKeysArg = (max: number) =>
  z
    .array(
      z
        .object({
          key: z.string().regex(/^\d+$/, 'a Meta location id is digits only'),
        })
        .strict(),
    )
    .max(max);

export const targetingArg = z
  .object({
    age_min: z
      .union([z.literal(13), z.literal(15), z.literal(18), z.literal(21), z.literal(25)])
      .optional()
      .describe('Minimum viewer age: 13, 15, 18, 21 or 25.'),
    geo_locations: z
      .object({
        countries: z
          .array(z.string().regex(/^[A-Z]{2}$/, 'an uppercase ISO 3166-1 alpha-2 code'))
          .min(1)
          .max(TARGETING_LIMITS.countries)
          .optional()
          .describe('Uppercase ISO country codes, e.g. ["BG","RO"].'),
        regions: locationKeysArg(TARGETING_LIMITS.regions)
          .optional()
          .describe(
            'Region location ids as [{key:"..."}], from Ads Manager targeting search.',
          ),
        cities: locationKeysArg(TARGETING_LIMITS.cities)
          .optional()
          .describe(
            'City location ids as [{key:"..."}], from Ads Manager targeting search.',
          ),
      })
      .strict()
      .refine(
        (g) =>
          g.countries !== undefined || g.regions !== undefined || g.cities !== undefined,
        'geo_locations needs at least one list',
      )
      .optional(),
  })
  .strict()
  .refine(
    (t) => t.age_min !== undefined || t.geo_locations !== undefined,
    'targeting needs age_min or geo_locations',
  )
  .optional()
  .describe(
    'Who sees the post in Feed: geo_locations and/or age_min. Narrows distribution only — the post stays publicly reachable by link and on the Page.',
  );
