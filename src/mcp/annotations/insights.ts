// Annotation fragment for package `insights` — read-only.
//
// Part of the frozen annotation manifest asserted by `../annotations.test.ts`
// (see `./index.ts`). Owned by the `insights` lane: changing a hint on one of this
// package's tools means editing the matching row here — that edit is the review.

import type { AnnotationRow } from './row.js';

export const ANNOTATIONS_INSIGHTS: readonly AnnotationRow[] = [
  ['facebook_page_insights', true, false, true, true, undefined],
  ['facebook_post_insights', true, false, true, true, undefined],
  ['facebook_reel_insights', true, false, true, true, undefined],
  ['facebook_get_page_report', true, false, true, true, undefined],
  ['facebook_get_posts_insights', true, false, true, true, undefined],
];
