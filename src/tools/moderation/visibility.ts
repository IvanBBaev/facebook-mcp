// What a comment shows on the Page in the `moderation` package:
// facebook_hide_comment, facebook_reply_and_hide_comment and
// facebook_like_comment.

import { z } from 'zod';

import { GraphApiError, errorMessageOf } from '../../core/index.js';
import {
  moderateCommentStep,
  likeCommentStep,
  runBulk,
  type CommentState,
} from '../../api/comments.js';
import { APPLIED_VERDICT, ATTEMPTED_VERDICT, defineTool } from '../../mcp/index.js';

import { executeWrite, writeArgs } from '../shared.js';

import {
  REPLY_ANNOTATIONS,
  REVERSIBLE_ANNOTATIONS,
  TIERS,
  commentIdArg,
  commentIdsArg,
  messageArg,
  classifyWriteFailure,
  truncate,
  scopeOf,
} from './common.js';
import {
  sweepFbRequest,
  pageTokenFence,
  UNREADABLE_NOT_ACTED_ERROR,
  unreadableWarnings,
  trackedCommentStates,
  bulkSummary,
  bulkVerdict,
  bulkPreviewWarnings,
} from './bulk.js';
import {
  replyAttachmentArg,
  localMediaOptions,
  prepareReplyAttachment,
  attachmentLabel,
  postReply,
} from './replies.js';

/** One step of facebook_reply_and_hide_comment, as the result reports it. */
interface ReplyAndHideStep {
  readonly outcome: 'applied' | 'attempted' | 'failed' | 'skipped';
  readonly replyId?: string;
  readonly note?: string;
  readonly error?: string;
}

/** What facebook_reply_and_hide_comment returns (v2 F7, per-step as CC-MOD-5). */
interface ReplyAndHideOutcome {
  readonly commentId: string;
  /** `applied` when every step that ran was confirmed, `attempted` otherwise. */
  readonly outcome: 'applied' | 'attempted';
  readonly reply: ReplyAndHideStep;
  readonly hide: ReplyAndHideStep;
  /** The follow-up that finishes the job when the hide did not land. */
  readonly nextStep?: string;
}

const ALREADY_HIDDEN_WARNING =
  'The comment is already hidden; only the reply will be posted.';

const ALREADY_HIDDEN_NOTE = 'already hidden when the plan was applied — no hide was sent';

/** A partial reply-and-hide is unconfirmed as a whole, never `applied`. */
function replyAndHideVerdict(outcome: ReplyAndHideOutcome) {
  return outcome.outcome === 'applied' ? APPLIED_VERDICT : ATTEMPTED_VERDICT;
}

// -------------------------------------------------------------------------
// facebook_hide_comment (reversible, bulk)
// -------------------------------------------------------------------------
export function createHideCommentTool() {
  return defineTool({
    name: 'facebook_hide_comment',
    title: 'Hide or unhide comments',
    description:
      'Hide or unhide up to 50 comments in one call (`hidden:true` hides, ' +
      '`hidden:false` restores). Hiding is the reversible moderation verb: the ' +
      'comment stays visible to its author and their friends but not to everyone ' +
      'else, and nothing is destroyed — prefer it over facebook_delete_comment. ' +
      'Each id gets its own outcome; a comment already deleted counts as done. ' +
      'Needs a PAGE token with pages_manage_engagement and the MODERATE task.',
    inputSchema: z.object({
      ...writeArgs,
      comment_ids: commentIdsArg,
      hidden: z
        .boolean()
        .describe(
          'true ⇒ hide the comments; false ⇒ unhide them. Required — no default.',
        ),
    }),
    annotations: REVERSIBLE_ANNOTATIONS,
    writeTier: TIERS.facebook_hide_comment,
    // `hidden` is the whole verb here (hide vs restore) and is worth more than
    // the ids: `comment_ids` is an array, and the log projection can only render
    // an array as "[array]", so naming it would add a key that says nothing.
    logFields: ['profile', 'apply', 'plan_id', 'hidden'],
    handler: async (input, ctx) => {
      const resolved = await ctx.pages.resolvePage(input.profile);
      const scope = scopeOf(ctx, resolved);
      const verb = input.hidden ? 'hidden' : 'unhidden';
      const states = trackedCommentStates(ctx.fbRequest, scope, input.comment_ids);
      return executeWrite(ctx, {
        tool: 'facebook_hide_comment',
        tier: TIERS.facebook_hide_comment,
        pageId: resolved.pageId,
        resolvedPage: resolved,
        params: { comment_ids: input.comment_ids, hidden: input.hidden },
        ...(input.apply !== undefined ? { apply: input.apply } : {}),
        ...(input.plan_id !== undefined ? { planId: input.plan_id } : {}),
        summary:
          `Set is_hidden=${String(input.hidden)} on ${String(new Set(input.comment_ids).size)} ` +
          `comment(s) of Page ${resolved.pageId}. Reversible with the opposite flag.`,
        warnings: bulkPreviewWarnings(new Set(input.comment_ids).size, verb),
        notPerformedNotice: `This was a dry run — no comment was ${verb}.`,
        // Fingerprints only: the divergence diff is shown to the model, so the
        // before/after state must not carry comment text (CC-MOD-6 + CC-MOD-8).
        readState: states.readState,
        stateWarnings: unreadableWarnings,
        perform: async () => {
          const fenced = pageTokenFence(
            sweepFbRequest(ctx.fbRequest, ctx.signal),
            ctx,
            resolved.pageId,
          );
          return bulkSummary(
            await runBulk(input.comment_ids, (id) =>
              states.unread(id)
                ? Promise.resolve({ ok: false, error: UNREADABLE_NOT_ACTED_ERROR })
                : moderateCommentStep(fenced, {
                    ...scope,
                    op: 'hide',
                    commentId: id,
                    hidden: input.hidden,
                  }),
            ),
          );
        },
        classifyResult: bulkVerdict,
        metadata: { commentIds: input.comment_ids, hidden: input.hidden },
      });
    },
  });
}

// -------------------------------------------------------------------------
// facebook_reply_and_hide_comment (reversible, two steps)
// -------------------------------------------------------------------------
export function createReplyAndHideCommentTool() {
  return defineTool({
    name: 'facebook_reply_and_hide_comment',
    title: 'Reply to and hide a comment',
    description:
      'Post a PUBLIC reply under a comment and then hide that comment, in one ' +
      'approved step — e.g. "We have sent you a DM" under spam or abuse. The reply ' +
      'goes first, so a failed reply hides nothing; a comment that is already ' +
      'hidden only gets the reply. Always previews first: apply needs the ' +
      '`plan_id` of that preview, and a comment edited or hidden in between makes ' +
      'the apply diverge. Each step reports its own outcome; if the hide fails, ' +
      'finish with facebook_hide_comment. Both steps are reversible (delete the ' +
      'reply, unhide the comment), but the reply is NOT idempotent — never retry ' +
      'blindly. Needs a PAGE token with pages_manage_engagement and the MODERATE task.',
    inputSchema: z.object({
      ...writeArgs,
      comment_id: commentIdArg,
      message: messageArg,
      attachment: replyAttachmentArg.optional(),
    }),
    annotations: REPLY_ANNOTATIONS,
    writeTier: TIERS.facebook_reply_and_hide_comment,
    // The same record as a plain reply: which comment, armed how. The text stays
    // off the log for the reasons given on facebook_reply_to_comment.
    logFields: ['profile', 'apply', 'plan_id', 'comment_id'],
    handler: async (input, ctx) => {
      const opts = localMediaOptions(ctx.settings.mediaDir);
      const attachment =
        input.attachment !== undefined
          ? await prepareReplyAttachment(input.attachment, opts)
          : undefined;
      const resolved = await ctx.pages.resolvePage(input.profile);
      const scope = scopeOf(ctx, resolved);
      const commentId = input.comment_id;
      const states = trackedCommentStates(ctx.fbRequest, scope, [commentId]);
      return executeWrite(ctx, {
        tool: 'facebook_reply_and_hide_comment',
        tier: TIERS.facebook_reply_and_hide_comment,
        // The reply is public under the Page's name, so the package's apply
        // default must not post it unseen: apply is bound to a previewed plan.
        requirePlanId: true,
        pageId: resolved.pageId,
        resolvedPage: resolved,
        params: {
          comment_id: commentId,
          message: input.message,
          ...(attachment !== undefined ? { attachment } : {}),
        },
        ...(input.apply !== undefined ? { apply: input.apply } : {}),
        ...(input.plan_id !== undefined ? { planId: input.plan_id } : {}),
        summary:
          `Reply publicly to comment ${commentId} (${String(input.message.length)} chars` +
          (attachment !== undefined ? `, with ${attachmentLabel(attachment)}` : '') +
          `), then hide comment ${commentId}, as Page ${resolved.pageId}: ` +
          `"${truncate(input.message, 300)}"`,
        warnings: [
          'The reply is PUBLIC — everyone who can see the comment can see it.',
          'The reply is posted first and the hide second; neither step is retried, and ' +
            'a failed hide is reported with the follow-up call.',
        ],
        notPerformedNotice:
          'This was a dry run — no reply was posted and nothing was hidden.',
        // The fingerprint and the hidden flag bind the plan: an edit or a hide in
        // between makes the apply diverge instead of acting on an unseen comment.
        readState: states.readState,
        stateWarnings: (before) => {
          const state = (before as Record<string, CommentState> | undefined)?.[commentId];
          if (state?.gone === true) {
            return [
              'The comment no longer exists (or this token cannot see it); the reply will fail.',
            ];
          }
          return [
            ...unreadableWarnings(before),
            ...(state?.hidden === true ? [ALREADY_HIDDEN_WARNING] : []),
          ];
        },
        perform: async (): Promise<ReplyAndHideOutcome> => {
          // Step 1. A throw here is the whole call's failure: nothing was hidden.
          const reply = await postReply(ctx.fbRequest, scope, opts, {
            commentId,
            message: input.message,
            ...(attachment !== undefined ? { attachment } : {}),
          });
          const replyStep: ReplyAndHideStep =
            reply.id !== undefined
              ? { outcome: 'applied', replyId: reply.id }
              : { outcome: 'attempted', note: reply.note };

          // Step 2, against the state the apply was cleared on.
          let hideStep: ReplyAndHideStep;
          if (states.stateOf(commentId)?.hidden === true) {
            hideStep = { outcome: 'skipped', note: ALREADY_HIDDEN_NOTE };
          } else {
            const fenced = pageTokenFence(
              sweepFbRequest(ctx.fbRequest, ctx.signal),
              ctx,
              resolved.pageId,
            );
            try {
              const step = await moderateCommentStep(fenced, {
                ...scope,
                op: 'hide',
                commentId,
                hidden: true,
              });
              hideStep = step.ok
                ? {
                    outcome: 'applied',
                    ...(step.note !== undefined ? { note: step.note } : {}),
                  }
                : {
                    outcome: 'failed',
                    error: step.error ?? 'the hide was not confirmed',
                  };
            } catch (err) {
              if (ctx.signal?.aborted === true && !(err instanceof GraphApiError))
                throw err;
              hideStep = {
                outcome: classifyWriteFailure(err),
                error: errorMessageOf(err),
              };
            }
          }

          const hideDone =
            hideStep.outcome === 'applied' || hideStep.outcome === 'skipped';
          return {
            commentId,
            outcome:
              replyStep.outcome === 'applied' && hideDone ? 'applied' : 'attempted',
            reply: replyStep,
            hide: hideStep,
            ...(hideDone
              ? {}
              : {
                  nextStep: `facebook_hide_comment {"comment_ids":["${commentId}"],"hidden":true}`,
                }),
          };
        },
        // A failed reply with a lost answer may still be public: `attempted`.
        classifyOutcome: classifyWriteFailure,
        classifyResult: replyAndHideVerdict,
        metadata: {
          commentId,
          messageChars: input.message.length,
          ...(attachment !== undefined ? { attachmentKind: attachment.kind } : {}),
        },
      });
    },
  });
}

// -------------------------------------------------------------------------
// facebook_like_comment (reversible, bulk)
// -------------------------------------------------------------------------
export function createLikeCommentTool() {
  return defineTool({
    name: 'facebook_like_comment',
    title: 'Like or unlike comments as the Page',
    description:
      'Like up to 50 comments as the Page, or unlike them with `unlike:true`. ' +
      'Reversible with the opposite flag. A comment the Page has already liked ' +
      '(or, for unlike, has not liked) is skipped without a write; each id gets ' +
      'its own outcome. Needs a PAGE token with pages_manage_engagement.',
    inputSchema: z.object({
      ...writeArgs,
      comment_ids: commentIdsArg,
      unlike: z
        .boolean()
        .optional()
        .describe("true ⇒ remove the Page's like instead of adding one. Default false."),
    }),
    annotations: REVERSIBLE_ANNOTATIONS,
    writeTier: TIERS.facebook_like_comment,
    // `unlike` is the whole verb (like vs unlike); `comment_ids` would log as
    // "[array]", so it is left out as on facebook_hide_comment.
    logFields: ['profile', 'apply', 'plan_id', 'unlike'],
    handler: async (input, ctx) => {
      const resolved = await ctx.pages.resolvePage(input.profile);
      const scope = scopeOf(ctx, resolved);
      const liked = input.unlike !== true;
      const verb = liked ? 'liked' : 'unliked';
      const count = new Set(input.comment_ids).size;
      const states = trackedCommentStates(ctx.fbRequest, scope, input.comment_ids, true);
      return executeWrite(ctx, {
        tool: 'facebook_like_comment',
        tier: TIERS.facebook_like_comment,
        pageId: resolved.pageId,
        resolvedPage: resolved,
        params: { comment_ids: input.comment_ids, unlike: !liked },
        ...(input.apply !== undefined ? { apply: input.apply } : {}),
        ...(input.plan_id !== undefined ? { planId: input.plan_id } : {}),
        summary:
          `${liked ? 'Like' : 'Unlike'} ${String(count)} comment(s) as Page ` +
          `${resolved.pageId}. Reversible with the opposite flag.`,
        warnings: bulkPreviewWarnings(count, verb),
        notPerformedNotice: `This was a dry run — no comment was ${verb}.`,
        // Fingerprints and flags only — no comment text in the diff (CC-MOD-8).
        readState: states.readState,
        stateWarnings: unreadableWarnings,
        perform: async () => {
          const fenced = pageTokenFence(
            sweepFbRequest(ctx.fbRequest, ctx.signal),
            ctx,
            resolved.pageId,
          );
          // A direct apply (no plan) never ran the snapshot, and the snapshot is
          // what lets an id already in the target state be skipped without a
          // write — so take it here. A plan-bound apply reuses the divergence read.
          if (!states.observed()) await states.readState();
          return bulkSummary(
            await runBulk(input.comment_ids, (id) =>
              states.unread(id)
                ? Promise.resolve({ ok: false, error: UNREADABLE_NOT_ACTED_ERROR })
                : likeCommentStep(fenced, {
                    ...scope,
                    commentId: id,
                    liked,
                    state: states.stateOf(id),
                  }),
            ),
          );
        },
        classifyResult: bulkVerdict,
        metadata: { commentIds: input.comment_ids, unlike: !liked },
      });
    },
  });
}
