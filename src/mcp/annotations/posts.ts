// Annotation fragment for package `posts` — publishing.
//
// Part of the frozen annotation manifest asserted by `../annotations.test.ts`
// (see `./index.ts`). Owned by the `posts` lane: changing a hint on one of this
// package's tools means editing the matching row here — that edit is the review.

import type { AnnotationRow } from './row.js';

export const ANNOTATIONS_POSTS: readonly AnnotationRow[] = [
  ['facebook_create_post', false, false, false, true, 'reversible'],
  ['facebook_create_photo_post', false, false, false, true, 'reversible'],
  ['facebook_create_video_post', false, false, false, true, 'reversible'],
  ['facebook_create_reel', false, false, false, true, 'reversible'],
  ['facebook_create_story', false, false, false, true, 'irreversible'],
  ['facebook_update_post', false, true, true, true, 'reversible'],
  ['facebook_delete_post', false, true, true, true, 'irreversible'],
  ['facebook_list_scheduled_posts', true, false, true, true, undefined],
  ['facebook_get_video_status', true, false, true, true, undefined],
];
