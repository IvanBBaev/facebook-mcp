// Annotation fragment for package `core` — always on, read-only.
//
// Part of the frozen annotation manifest asserted by `../annotations.test.ts`
// (see `./index.ts`). Owned by the `core` lane: changing a hint on one of this
// package's tools means editing the matching row here — that edit is the review.

import type { AnnotationRow } from './row.js';

export const ANNOTATIONS_CORE: readonly AnnotationRow[] = [
  ['facebook_whoami', true, false, true, true, undefined],
  ['facebook_list_pages', true, false, true, true, undefined],
  ['facebook_get_page', true, false, true, true, undefined],
  ['facebook_usage', true, false, true, true, undefined],
];
