// Annotation fragment for package `moderation` — comment triage.
//
// Part of the frozen annotation manifest asserted by `../annotations.test.ts`
// (see `./index.ts`). Owned by the `moderation` lane: changing a hint on one of this
// package's tools means editing the matching row here — that edit is the review.

import type { AnnotationRow } from './row.js';

export const ANNOTATIONS_MODERATION: readonly AnnotationRow[] = [
  ['facebook_list_comments', true, false, true, true, undefined],
  ['facebook_get_comment', true, false, true, true, undefined],
  ['facebook_triage_comments', true, false, true, true, undefined],
  ['facebook_reply_to_comment', false, false, false, true, 'reversible'],
  ['facebook_comment_on_post', false, false, false, true, 'reversible'],
  ['facebook_edit_comment', false, false, true, true, 'reversible'],
  ['facebook_hide_comment', false, false, true, true, 'reversible'],
  ['facebook_reply_and_hide_comment', false, false, false, true, 'reversible'],
  ['facebook_like_comment', false, false, true, true, 'reversible'],
  ['facebook_delete_comment', false, true, true, true, 'irreversible'],
  ['facebook_private_reply', false, true, false, true, 'irreversible'],
  ['facebook_block_user', false, false, true, true, 'reversible'],
  ['facebook_unblock_user', false, false, true, true, 'reversible'],
  ['facebook_get_moderation_settings', true, false, true, true, undefined],
  ['facebook_set_moderation_settings', false, false, true, true, 'reversible'],
];
