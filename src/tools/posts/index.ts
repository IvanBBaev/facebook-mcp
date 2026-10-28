// The `posts` tool package (task V03) — publishing, scheduling and the
// scheduled-post lifecycle of a Facebook Page.
//
//   * facebook_create_post           — text / link / multi-link card carousel /
//                                      multi-photo carousel (reversible).
//   * facebook_create_photo_post     — one photo, published or scheduled.
//   * facebook_create_video_post     — resumable upload of a local file, or a
//                                      `file_url` Meta fetches itself.
//   * facebook_create_reel           — the three-phase Reels flow, with the
//                                      video_state lifecycle and the 24 h cap.
//   * facebook_create_story          — a photo or video Page story (irreversible:
//                                      public at once, no delete tool).
//   * facebook_update_post           — content edits PLUS the scheduled-post
//                                      lifecycle verbs (destructive, idempotent).
//   * facebook_delete_post           — permanent removal (irreversible).
//   * facebook_list_scheduled_posts  — read-only queue inspection.
//   * facebook_get_video_status      — read-only poll of an uploaded video's
//                                      processing state (created != ready).
//
// The package is plan-first (`writeModeDefault: 'plan'`): publishing is visible
// to an audience the moment it lands, so every write returns a preview until the
// caller repeats it with `apply:true` (plus a `plan_id` for the irreversible
// delete, which `FB_WRITE_MODE=apply` can never waive).
//
// Layer 3 (`tools`): this package OWNS no validation of its own. Every rule about
// schedules, field combinations, carousel bounds and message ceilings lives in
// `../../api/posts-write.js` as pure functions, and the media protocols live in
// `../../api/media-*.js`. The handlers resolve the Page, call those planners
// BEFORE returning a preview (so an approved dry run cannot fail at apply time
// on something checkable locally), hand the mutation to the write gate, and
// translate the layer's typed failures into model-actionable results.
//
// Layout of this directory (each tool's builder lives with its responsibility):
//   * publish.ts      — facebook_create_post, facebook_create_photo_post
//   * media.ts        — facebook_create_video_post, facebook_create_reel,
//                       facebook_create_story
//   * lifecycle.ts    — facebook_update_post, facebook_delete_post
//   * queue.ts        — facebook_list_scheduled_posts
//   * video-status.ts — facebook_get_video_status
//   * args.ts, errors.ts, context.ts, outcomes.ts — the shared annotations,
//     input fields, error mapping, context helpers and response readers.

import type { PackageSpec } from '../../core/index.js';
import { buildDeletePost, buildUpdatePost } from './lifecycle.js';
import { buildCreateReel, buildCreateStory, buildCreateVideoPost } from './media.js';
import { buildCreatePhotoPost, buildCreatePost } from './publish.js';
import { buildListScheduledPosts } from './queue.js';
import { buildGetVideoStatus } from './video-status.js';

// ---------------------------------------------------------------------------
// 15. Package factory
// ---------------------------------------------------------------------------

/**
 * Build the `posts` package.
 *
 * `writeModeDefault: 'plan'` is only the default for a server that did not
 * choose: an explicitly set `FB_WRITE_MODE=apply` overrides a package default
 * outright (see `effectiveWriteMode`), so the default is NOT what keeps an
 * unattended publish off the timeline. The per-call `requirePlanId` is: every
 * create passes `publishesNow(...)` (the Reel spells it `video_state ===
 * 'PUBLISHED'`) and the update passes `action === 'publish_now'`. A post is
 * visible to an audience the instant it lands, so a `plan_id` from a preceding
 * preview is required whatever mode the server runs in, and no write mode can
 * substitute for it. The irreversible delete arrives at the same guarantee by a
 * different route — its tier ignores the mode entirely and always demands an
 * explicit `plan_id`.
 */
export function createPostsPackage(): PackageSpec {
  return {
    name: 'posts',
    title: 'Posts',
    description:
      'Publish, schedule, edit and delete Page posts, photos, videos, Reels and ' +
      'stories (plan-first: every write previews before it applies).',
    tools: [
      buildCreatePost(),
      buildCreatePhotoPost(),
      buildCreateVideoPost(),
      buildCreateReel(),
      buildCreateStory(),
      buildUpdatePost(),
      buildDeletePost(),
      buildListScheduledPosts(),
      buildGetVideoStatus(),
    ],
    enabledByDefault: true,
    writeModeDefault: 'plan',
  };
}
