// `posts` package — scheduled-queue inspection: facebook_list_scheduled_posts.

import { z } from 'zod';
import {
  SCHEDULE_TIMEZONE_CAVEAT,
  formatInTimeZone,
  scheduledPostsEdge,
} from '../../api/posts-write.js';
import { fetchPage } from '../../api/shared.js';
import { defineTool } from '../../mcp/index.js';
import { listArgs, shapeFor } from '../shared.js';
import { READ_ONLY_ANNOTATIONS, pageTimezoneArg } from './args.js';
import { prepareBase, requestScope } from './context.js';
import { guarded } from './errors.js';

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

export function buildListScheduledPosts() {
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
    // No `logFields`: the arguments here are the profile selector and paging, so
    // the line could only say that a Page read its own drafts. The writes above
    // are where the record earns its place.
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
