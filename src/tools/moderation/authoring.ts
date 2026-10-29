// The Page's own comment lifecycle in the `moderation` package:
// facebook_comment_on_post, facebook_edit_comment and facebook_delete_comment.

import { z } from 'zod';

import type { JournalOutcome } from '../../core/index.js';
import { GraphApiError } from '../../core/index.js';
import {
  moderateCommentStep,
  commentOnObject,
  editComment,
  messageFingerprint,
  readCommentTarget,
  readEditableComment,
  runBulk,
  type CommentTarget,
  type CommentState,
  type EditableComment,
} from '../../api/comments.js';
import { APPLIED_VERDICT, defineTool, renderTainted, taint } from '../../mcp/index.js';

import {
  confirmableWriteArgs,
  executeWrite,
  gateArgs,
  graphNodeIdArg,
  writeArgs,
} from '../shared.js';

import {
  REPLY_ANNOTATIONS,
  REVERSIBLE_ANNOTATIONS,
  DELETE_ANNOTATIONS,
  TIERS,
  commentIdArg,
  commentIdsArg,
  isSafeHttpsUrl,
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
import { type ReplyOutcome, replyVerdict, emptyCommentError } from './replies.js';

/**
 * The post a top-level comment lands on. Interpolated into `/{post_id}/comments`,
 * so the shared containment shape applies (see {@link commentIdArg}).
 */
const postIdArg = graphNodeIdArg({
  hint: 'Pass the `id` facebook_list_posts returns, verbatim.',
  description:
    'The post ID, normally "{page-id}_{post-id}" as returned by facebook_list_posts. Not a comment ID — reply to a comment with facebook_reply_to_comment.',
});

/**
 * A photo for a comment: an https:// URL Facebook fetches itself. Credentials
 * in the URL are refused — Facebook would receive them, and so would a log.
 */
const attachmentUrlArg = z
  .string()
  .url()
  .refine(
    isSafeHttpsUrl,
    'attachment_url must be an https:// URL without embedded credentials.',
  )
  .describe(
    'Optional photo for the comment: a public https:// image URL Facebook fetches itself (no credentials in the URL).',
  );

/** The `facebook_comment_on_post` counterpart of {@link REPLY_UNCONFIRMED_NOTE}. */
const COMMENT_UNCONFIRMED_NOTE =
  'Facebook accepted the request but returned no comment id, so the comment is ' +
  'UNCONFIRMED: it may already be public. Check the post with ' +
  'facebook_list_comments before doing anything else, and do not post it again blindly.';

/** How much of the target post a comment preview quotes. */
const POST_EXCERPT_CHARS = 80;

/**
 * Preview warnings derived from the post read at plan time. The Page's own
 * post is quoted as-is; a post someone else wrote is quoted only inside a
 * taint envelope, because its text is not the Page's (rule 1 above).
 */
function commentTargetWarnings(target: CommentTarget, pageId: string): string[] {
  const excerpt =
    target.message !== undefined && target.message.length > 0
      ? truncate(target.message, POST_EXCERPT_CHARS)
      : undefined;
  if (target.fromId === pageId) {
    return excerpt !== undefined ? [`The post being commented on: "${excerpt}"`] : [];
  }
  return [
    "Commenting on another Page's or user's post: the post must be visible to the " +
      'Page, and the comment appears under content the Page does not control.',
    ...(excerpt !== undefined
      ? [`The post being commented on: ${renderTainted(taint('visitor_post', excerpt))}`]
      : []),
  ];
}

/**
 * The terminal refusal for an edit of a comment the Page did not write. Graph
 * only lets a Page edit its own comments, so this is decided locally from the
 * pre-flight read rather than spent on a call that cannot succeed. A comment
 * whose author the token could not read is refused too: ownership unproven is
 * not ownership.
 */
function notOwnCommentError(
  commentId: string,
  fromId: string | undefined,
): GraphApiError {
  const why =
    fromId === undefined
      ? 'its author could not be read, so it cannot be shown to be the Page'
      : 'it was written by someone other than the Page';
  const text =
    `Edit of comment ${commentId} refused: ${why}. Only the Page's own comments can ` +
    'be edited — do NOT retry. To act on a visitor comment use facebook_hide_comment ' +
    'or facebook_reply_to_comment.';
  return new GraphApiError(text, {
    code: 0,
    httpStatus: 400,
    action: {
      category: 'validation',
      retryable: false,
      nextTool: 'facebook_get_comment',
      operatorText: text,
    },
  });
}

/** How much of each side an edit preview quotes. */
const EDIT_EXCERPT_CHARS = 500;

/**
 * The UGC-free state an edit plan binds to: the comment's fingerprint. A
 * concurrent edit changes it, so a stale plan diverges instead of overwriting
 * text nobody reviewed (CC-MOD-6); the text itself stays out (CC-MOD-8).
 */
function editableState(comment: EditableComment): CommentState {
  return {
    id: comment.id,
    gone: false,
    fingerprint: messageFingerprint(comment.message ?? ''),
  };
}

/**
 * What `facebook_edit_comment` returns: the comment id plus whether Facebook
 * confirmed the edit, with a `note` when it did not.
 */
interface EditOutcome {
  readonly id: string;
  readonly edited: boolean;
  readonly note?: string;
}

const EDIT_REFUSED_NOTE =
  'Facebook answered the edit with success:false, so the comment text was NOT ' +
  'changed. Read it with facebook_get_comment before trying again.';

/** An edit Facebook explicitly declined changed nothing: `failed`, not `applied`. */
function editVerdict(outcome: EditOutcome): {
  readonly outcome: JournalOutcome;
  readonly applied: boolean;
} {
  return outcome.edited ? APPLIED_VERDICT : { outcome: 'failed', applied: false };
}

// -------------------------------------------------------------------------
// facebook_comment_on_post (reversible)
// -------------------------------------------------------------------------
export function createCommentOnPostTool() {
  return defineTool({
    name: 'facebook_comment_on_post',
    title: 'Comment on post',
    description:
      'Post a PUBLIC top-level comment as the Page on a post — e.g. a first comment ' +
      'with a link. Takes `message`, an https `attachment_url` photo, or both. To ' +
      'answer a comment use facebook_reply_to_comment instead. @[page-id] mentions ' +
      'are passed through but Facebook reviews them. Always previews first: apply ' +
      'needs the `plan_id` of that preview. Reversible by deleting the ' +
      'comment, but NOT idempotent: if the response is lost, verify with ' +
      'facebook_list_comments before retrying, or you will post twice. Needs a PAGE ' +
      'token with pages_manage_engagement and the MODERATE task.',
    inputSchema: z.object({
      ...writeArgs,
      post_id: postIdArg,
      message: messageArg.optional(),
      attachment_url: attachmentUrlArg.optional(),
    }),
    annotations: REPLY_ANNOTATIONS,
    writeTier: TIERS.facebook_comment_on_post,
    // Where the comment went and how it was armed; never the text or the URL.
    logFields: ['profile', 'apply', 'plan_id', 'post_id'],
    handler: async (input, ctx) => {
      if (input.message === undefined && input.attachment_url === undefined) {
        throw emptyCommentError();
      }
      const resolved = await ctx.pages.resolvePage(input.profile);
      const scope = scopeOf(ctx, resolved);
      const what =
        input.message !== undefined
          ? `"${truncate(input.message, POST_EXCERPT_CHARS)}"`
          : '(photo only)';
      return executeWrite(ctx, {
        tool: 'facebook_comment_on_post',
        tier: TIERS.facebook_comment_on_post,
        // A public comment with free text and a URL Facebook fetches (SEC-01):
        // plan-first whatever the package default, like a reply.
        requirePlanId: true,
        pageId: resolved.pageId,
        resolvedPage: resolved,
        params: {
          post_id: input.post_id,
          ...(input.message !== undefined ? { message: input.message } : {}),
          ...(input.attachment_url !== undefined
            ? { attachment_url: input.attachment_url }
            : {}),
        },
        ...(input.apply !== undefined ? { apply: input.apply } : {}),
        ...(input.plan_id !== undefined ? { planId: input.plan_id } : {}),
        summary:
          `Comment as ${resolved.name} (${resolved.pageId}) on post ${input.post_id}: ${what}` +
          (input.attachment_url !== undefined && input.message !== undefined
            ? ' with a photo'
            : ''),
        warnings: [
          'The comment is PUBLIC — everyone who can see the post can see it.',
          'Posting twice is possible: if this call fails without a clear answer, check ' +
            'facebook_list_comments before retrying.',
        ],
        notPerformedNotice: 'This was a dry run — no comment was posted.',
        // Plan mode reads the post so the preview can say what is being
        // answered and whose post it is. A post edited between plan and apply
        // diverges, which is the point: the comment would answer other text.
        readState: () =>
          readCommentTarget(ctx.fbRequest, { ...scope, postId: input.post_id }),
        stateWarnings: (before) =>
          commentTargetWarnings(before as CommentTarget, resolved.pageId),
        perform: async (): Promise<ReplyOutcome> => {
          const ack = await commentOnObject(ctx.fbRequest, {
            ...scope,
            objectId: input.post_id,
            ...(input.message !== undefined ? { message: input.message } : {}),
            ...(input.attachment_url !== undefined
              ? { attachmentUrl: input.attachment_url }
              : {}),
          });
          return ack.id !== undefined
            ? { id: ack.id }
            : { note: COMMENT_UNCONFIRMED_NOTE };
        },
        classifyOutcome: classifyWriteFailure,
        classifyResult: replyVerdict,
        metadata: {
          postId: input.post_id,
          messageChars: input.message?.length ?? 0,
          withPhoto: input.attachment_url !== undefined,
        },
      });
    },
  });
}

// -------------------------------------------------------------------------
// facebook_edit_comment (reversible)
// -------------------------------------------------------------------------
export function createEditCommentTool() {
  return defineTool({
    name: 'facebook_edit_comment',
    title: 'Edit own comment',
    description:
      'Replace the text of a comment the Page itself wrote — e.g. fix a typo in a ' +
      'reply. Comments by anyone else are refused before any write. Always previews ' +
      'first: apply needs the `plan_id` of that preview, which shows the current ' +
      'and the new text, so the old text can be restored ' +
      'with a second edit; a comment edited by someone else after the preview makes ' +
      'the plan diverge. Needs a PAGE token with pages_manage_engagement.',
    inputSchema: z.object({
      ...writeArgs,
      comment_id: commentIdArg,
      message: messageArg,
    }),
    annotations: REVERSIBLE_ANNOTATIONS,
    writeTier: TIERS.facebook_edit_comment,
    // Which comment was rewritten and how the call was armed; never the text.
    logFields: ['profile', 'apply', 'plan_id', 'comment_id'],
    handler: async (input, ctx) => {
      const resolved = await ctx.pages.resolvePage(input.profile);
      const scope = scopeOf(ctx, resolved);
      const read = () =>
        readEditableComment(ctx.fbRequest, { ...scope, commentId: input.comment_id });
      // Ownership is checked on every call, not only in plan mode: a plan for a
      // comment the Page did not write must never be issued, let alone applied.
      const current = await read();
      if (current.fromId !== resolved.pageId) {
        throw notOwnCommentError(input.comment_id, current.fromId);
      }
      const before = current.message ?? '';
      // The first snapshot is the pre-flight itself; later ones (the gate's
      // divergence re-read before a plan-bound apply) go back to Facebook.
      let preflight: EditableComment | undefined = current;
      return executeWrite(ctx, {
        tool: 'facebook_edit_comment',
        tier: TIERS.facebook_edit_comment,
        // The new text is public under the Page's name (SEC-01): plan-first
        // whatever the package default, like a reply.
        requirePlanId: true,
        pageId: resolved.pageId,
        resolvedPage: resolved,
        params: { comment_id: input.comment_id, message: input.message },
        ...(input.apply !== undefined ? { apply: input.apply } : {}),
        ...(input.plan_id !== undefined ? { planId: input.plan_id } : {}),
        summary:
          `Edit comment ${input.comment_id} of Page ${resolved.pageId}: ` +
          `${String(before.length)} → ${String(input.message.length)} chars.`,
        warnings: [
          'The edited comment is PUBLIC — everyone who can see the thread sees the new text.',
          ...(before === input.message
            ? ['The new text is identical to the current text; the edit changes nothing.']
            : []),
        ],
        notPerformedNotice: 'This was a dry run — the comment was not edited.',
        readState: async () => {
          const snapshot = preflight ?? (await read());
          preflight = undefined;
          return editableState(snapshot);
        },
        stateWarnings: () => [
          `Current text: ${renderTainted(taint('comment', truncate(before, EDIT_EXCERPT_CHARS)))}`,
          `New text: ${renderTainted(taint('comment', truncate(input.message, EDIT_EXCERPT_CHARS)))}`,
        ],
        perform: async (): Promise<EditOutcome> => {
          const ok = await editComment(ctx.fbRequest, {
            ...scope,
            commentId: input.comment_id,
            message: input.message,
          });
          return ok
            ? { id: input.comment_id, edited: true }
            : { id: input.comment_id, edited: false, note: EDIT_REFUSED_NOTE };
        },
        classifyOutcome: classifyWriteFailure,
        classifyResult: editVerdict,
        // Hashes only: the journal records that the text changed, never what it said.
        metadata: {
          commentId: input.comment_id,
          messageChars: input.message.length,
          previousFingerprint: messageFingerprint(before),
          messageFingerprint: messageFingerprint(input.message),
        },
      });
    },
  });
}

// -------------------------------------------------------------------------
// facebook_delete_comment (irreversible, bulk)
// -------------------------------------------------------------------------
export function createDeleteCommentTool() {
  return defineTool({
    name: 'facebook_delete_comment',
    title: 'Delete comments',
    description:
      'PERMANENTLY delete up to 50 comments. This cannot be undone — prefer ' +
      'facebook_hide_comment, which is reversible. Always requires an explicit ' +
      'apply:true together with the plan_id from a dry run; the server default ' +
      'never applies a delete on its own. Each id gets its own outcome and a ' +
      "comment that is already gone counts as done. Deleting the Page's OWN " +
      'comment needs pages_manage_engagement; deleting a comment left BY a user ' +
      'also needs pages_read_user_content.',
    inputSchema: z.object({
      ...confirmableWriteArgs,
      comment_ids: commentIdsArg,
    }),
    annotations: DELETE_ANNOTATIONS,
    writeTier: TIERS.facebook_delete_comment,
    // Never `confirm_token`, and `comment_ids` would log as "[array]" anyway, so
    // what remains is the fact that a destructive apply was armed on this Page.
    // The per-id outcomes are the journal's record to keep, not the log line's.
    logFields: ['profile', 'apply', 'plan_id'],
    handler: async (input, ctx) => {
      const resolved = await ctx.pages.resolvePage(input.profile);
      const scope = scopeOf(ctx, resolved);
      const states = trackedCommentStates(ctx.fbRequest, scope, input.comment_ids);
      return executeWrite(ctx, {
        tool: 'facebook_delete_comment',
        tier: TIERS.facebook_delete_comment,
        pageId: resolved.pageId,
        resolvedPage: resolved,
        params: { comment_ids: input.comment_ids },
        ...gateArgs(input),
        summary:
          `PERMANENTLY delete ${String(new Set(input.comment_ids).size)} comment(s) of Page ` +
          `${resolved.pageId}. This cannot be undone; facebook_hide_comment is the ` +
          'reversible alternative.',
        warnings: [
          'Deletion is PERMANENT — the comments cannot be restored.',
          ...bulkPreviewWarnings(new Set(input.comment_ids).size, 'deleted'),
        ],
        notPerformedNotice: 'This was a dry run — no comment was deleted.',
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
                    op: 'delete',
                    commentId: id,
                  }),
            ),
          );
        },
        classifyResult: bulkVerdict,
        metadata: { commentIds: input.comment_ids },
      });
    },
  });
}
