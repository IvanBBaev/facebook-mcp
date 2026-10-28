// Annotation fragment for package `reader` — read-only.
//
// Part of the frozen annotation manifest asserted by `../annotations.test.ts`
// (see `./index.ts`). Owned by the `reader` lane: changing a hint on one of this
// package's tools means editing the matching row here — that edit is the review.

import type { AnnotationRow } from './row.js';

export const ANNOTATIONS_READER: readonly AnnotationRow[] = [
  ['facebook_list_posts', true, false, true, true, undefined],
  ['facebook_get_post', true, false, true, true, undefined],
  ['facebook_list_reels', true, false, true, true, undefined],
  ['facebook_get_reactions', true, false, true, true, undefined],
  ['facebook_list_stories', true, false, true, true, undefined],
  ['facebook_list_albums', true, false, true, true, undefined],
  ['facebook_list_photos', true, false, true, true, undefined],
];
