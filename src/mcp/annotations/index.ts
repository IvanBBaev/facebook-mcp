// The frozen annotation manifest, assembled from one fragment per tool package.
//
// Each `<pkg>.ts` file in this directory holds the rows of exactly one package
// and is owned by that package's lane, so lanes working in parallel never edit
// the same list. This loader only concatenates the fragments, in canonical
// package order; `../annotations.test.ts` is the only consumer and asserts the
// result against the live registry. No production module imports this
// directory.

import { ANNOTATIONS_ADS } from './ads.js';
import { ANNOTATIONS_CORE } from './core.js';
import { ANNOTATIONS_INSIGHTS } from './insights.js';
import { ANNOTATIONS_MESSAGES } from './messages.js';
import { ANNOTATIONS_MODERATION } from './moderation.js';
import { ANNOTATIONS_PAGE_ADMIN } from './page-admin.js';
import { ANNOTATIONS_POSTS } from './posts.js';
import { ANNOTATIONS_READER } from './reader.js';
import type { AnnotationRow } from './row.js';

export type { AnnotationRow } from './row.js';

/**
 * Every registered tool's annotation row, grouped by package in canonical
 * order for reading only — the assertions compare by name, not by position.
 */
export const ANNOTATION_MANIFEST: readonly AnnotationRow[] = [
  ...ANNOTATIONS_CORE,
  ...ANNOTATIONS_READER,
  ...ANNOTATIONS_POSTS,
  ...ANNOTATIONS_INSIGHTS,
  ...ANNOTATIONS_MODERATION,
  ...ANNOTATIONS_MESSAGES,
  ...ANNOTATIONS_ADS,
  ...ANNOTATIONS_PAGE_ADMIN,
];
