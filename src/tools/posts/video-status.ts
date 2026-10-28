// `posts` package — read-only poll of an uploaded video: facebook_get_video_status.

import { z } from 'zod';
import { getVideoStatus, type VideoStatus } from '../../api/media-video.js';
import { defineTool, shapeEnvelope } from '../../mcp/index.js';
import { profileArg, shapeOptionsOf } from '../shared.js';
import { READ_ONLY_ANNOTATIONS, statusVideoIdArg } from './args.js';
import { prepareBase } from './context.js';
import { guarded } from './errors.js';

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

export function buildGetVideoStatus() {
  return defineTool({
    name: 'facebook_get_video_status',
    title: 'Get Video Status',
    description:
      "Poll where one video stands in Meta's pipeline: uploading, processing, " +
      'ready or error. facebook_create_video_post returns its `videoId` long before ' +
      'the video is playable, so read the state here instead of assuming a fresh ' +
      'video is live — `uploading` and `processing` are not terminal, so wait a ' +
      'few seconds and call again. Takes a video ID, never a post ID; whether a ' +
      'Reel ID resolves on this edge is UNVERIFIED against the live API.',
    inputSchema: z.object({
      profile: profileArg,
      video_id: statusVideoIdArg,
    }),
    outputSchema: videoStatusOutputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
    // No `logFields`: this tool exists to be POLLED until an upload finishes, so
    // one line per call is volume, not evidence — and the upload it polls was
    // already recorded when facebook_create_video_post armed it.
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
