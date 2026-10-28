// Annotation fragment for package `messages` — Page inbox.
//
// Part of the frozen annotation manifest asserted by `../annotations.test.ts`
// (see `./index.ts`). Owned by the `messages` lane: changing a hint on one of this
// package's tools means editing the matching row here — that edit is the review.

import type { AnnotationRow } from './row.js';

export const ANNOTATIONS_MESSAGES: readonly AnnotationRow[] = [
  ['facebook_list_conversations', true, false, true, true, undefined],
  ['facebook_get_conversation', true, false, true, true, undefined],
  ['facebook_send_message', false, true, false, true, 'reversible'],
  ['facebook_react_to_message', false, false, true, true, 'reversible'],
  ['facebook_upload_message_attachment', false, false, false, true, 'reversible'],
  ['facebook_get_activity_since', true, false, false, true, undefined],
  // Local saved replies: a file on this machine, so the world is closed.
  ['facebook_list_saved_replies', true, false, true, false, undefined],
  ['facebook_save_reply', false, false, true, false, 'reversible'],
  ['facebook_delete_saved_reply', false, false, true, false, 'reversible'],
  // Custom inbox labels (v2 F11): invisible to the person; delete is permanent.
  ['facebook_list_labels', true, false, true, true, undefined],
  ['facebook_create_label', false, false, false, true, 'reversible'],
  ['facebook_assign_label', false, false, true, true, 'reversible'],
  ['facebook_delete_label', false, true, true, true, 'irreversible'],
];
