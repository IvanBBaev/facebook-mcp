// The `moderation` tool package (task V07) — reading and moderating the comments
// on a Page's content, plus the Page's blocked-users list (doc 06 "Package
// `moderation`").
//
//   * facebook_list_comments    — cursor-paginated comments edge (filter/order).
//   * facebook_get_comment      — one comment with its replies.
//   * facebook_triage_comments  — unanswered / hidden / keyword queue.
//   * facebook_reply_to_comment — public reply            (tier: reversible).
//   * facebook_comment_on_post  — top-level Page comment  (tier: reversible).
//   * facebook_hide_comment     — is_hidden true/false    (tier: reversible).
//   * facebook_like_comment     — like / unlike as Page   (tier: reversible).
//   * facebook_delete_comment   — permanent delete        (tier: irreversible).
//   * facebook_private_reply    — the ONE private reply   (tier: irreversible).
//   * facebook_block_user       — add PSIDs to /blocked   (tier: reversible).
//   * facebook_unblock_user     — remove PSIDs            (tier: reversible).
//
// Three cross-cutting rules shape every line below.
//
// 1. UNTRUSTED CONTENT (B1 / CC-MOD-8). A comment body and an author's display
//    name are written by strangers. Every one of them leaves this module inside a
//    taint envelope (`taint('comment', …)` rendered by `renderTainted`), and no
//    raw body ever reaches a plain string field: not the payload, not a preview
//    `summary`, not a divergence diff, not the journal. Ids, counts and flags are
//    machine-generated, so they stay outside the envelope where the model can
//    actually use them.
//
// 2. APPLY-BY-DEFAULT, EXCEPT WHERE IT MATTERS (A6 / UX #6). Moderation is
//    high-volume: a 20-comment sweep behind a plan preview plus a client confirm
//    is dozens of prompts, so the package declares `writeModeDefault: 'apply'`
//    and keeps `destructiveHint:false` on the reversible verbs. That default can
//    never reach `facebook_delete_comment` or `facebook_private_reply` — the
//    `irreversible` tier demands `apply:true` AND a `plan_id` from a preview,
//    whatever the mode says (C4).
//
// 3. NEVER ALL-OR-NOTHING (CC-MOD-5). The bulk verbs take up to 50 ids, run them
//    one at a time and return a per-id outcome array. A comment someone deleted
//    a second ago is a success-with-note, a permission failure is recorded
//    against its own id, and the other 49 ids still run.
//
// Layer 3 (`tools`): the Graph plumbing lives in `../../api/comments.js`, the taint
// envelope and the write gate in `../../mcp/`. Everything is driven off the injected
// `ToolContext` — `ctx.clock` for the 7-day window, `ctx.pages` for the Page
// token, `ctx.fbRequest` for every call (C14: no globals).

// This directory splits the package by responsibility, behind the facade
// `../moderation.ts`:
//   * common.ts        — annotations, write tiers, shared input fields/helpers.
//   * bulk.ts          — bulk-sweep fencing, per-id state reads, bulk verdicts.
//   * comments.ts      — list / get / triage (read-only).
//   * replies.ts       — public reply + the reply plumbing others reuse.
//   * authoring.ts     — comment on a post, edit, delete.
//   * visibility.ts    — hide, reply-and-hide, like.
//   * private-reply.ts — the one private reply.
//   * blocking.ts      — block / unblock users.

import type { PackageSpec } from '../../core/index.js';

import { createModerationSettingsTools } from '../moderation-settings.js';

import {
  createDeleteCommentTool,
  createCommentOnPostTool,
  createEditCommentTool,
} from './authoring.js';
import { createBlockedTool } from './blocking.js';
import {
  createGetCommentTool,
  createListCommentsTool,
  createTriageCommentsTool,
} from './comments.js';
import { createPrivateReplyTool } from './private-reply.js';
import { createReplyToCommentTool } from './replies.js';
import {
  createHideCommentTool,
  createLikeCommentTool,
  createReplyAndHideCommentTool,
} from './visibility.js';

/**
 * Build the `moderation` package. `writeModeDefault: 'apply'` covers only the
 * `reversible` verbs (reply / hide / block / unblock); `facebook_delete_comment`
 * and `facebook_private_reply` are `irreversible` and therefore always require
 * an explicit `apply:true` plus a `plan_id` from a preview.
 */
export function createModerationPackage(): PackageSpec {
  return {
    name: 'moderation',
    title: 'Moderation',
    description:
      'Read and moderate comments on Page content (list, reply, comment on a post, ' +
      "edit the Page's own comments, hide, like, delete, private reply) and maintain the " +
      'blocked-users list and the Page moderation settings (blocked words, profanity filter).',
    tools: [
      createListCommentsTool(),
      createGetCommentTool(),
      createTriageCommentsTool(),
      createReplyToCommentTool(),
      createCommentOnPostTool(),
      createEditCommentTool(),
      createHideCommentTool(),
      createReplyAndHideCommentTool(),
      createLikeCommentTool(),
      createDeleteCommentTool(),
      createPrivateReplyTool(),
      createBlockedTool(true),
      createBlockedTool(false),
      ...createModerationSettingsTools(),
    ],
    enabledByDefault: true,
    // Reversible, high-volume day-to-day work must not stack a plan preview and a
    // client confirm on every comment (A6 / UX #6). The `irreversible` delete and
    // private reply are unaffected — their tier overrides any default (C4).
    writeModeDefault: 'apply',
  };
}
