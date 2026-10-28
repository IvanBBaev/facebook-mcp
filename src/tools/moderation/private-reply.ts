// facebook_private_reply — the ONE private reply a comment allows, with the
// local journal checks that refuse a repeat or a reply to the Page itself.

import { z } from 'zod';

import type { Journal, JournalEntry } from '../../core/index.js';
import { GraphApiError } from '../../core/index.js';
import {
  getComment,
  getPrivateReplyPostFacts,
  privateReplyRefusalError,
  privateReplyTargetLabel,
  privateReplyWindow,
  sendPrivateReply,
  type PrivateReplyReceipt,
  type PrivateReplyRecipient,
} from '../../api/comments.js';
import { attachmentSourceOf, type OutboundContent } from '../../api/messaging.js';
import { APPLIED_VERDICT, ATTEMPTED_VERDICT, defineTool } from '../../mcp/index.js';

import {
  confirmableWriteArgs,
  executeWrite,
  gateArgs,
  graphNodeIdArg,
} from '../shared.js';
import { messageOrSavedReply, savedReplyIdArg } from '../saved-replies.js';
import {
  ATTACHMENT_FETCH_WARNING,
  attachmentArg,
  outboundAttachmentOf,
} from '../message-attachment.js';

import {
  PRIVATE_REPLY_ANNOTATIONS,
  TIERS,
  commentIdArg,
  MAX_COMMENT_MESSAGE_CHARS,
  messageArg,
  classifyWriteFailure,
  truncate,
  scopeOf,
} from './common.js';

/**
 * What `facebook_private_reply` returns: the receipt as the API read it, plus a
 * `note` when it carried no message id — the one-shot may be spent and the
 * message may be in the inbox, but nothing on the wire says so.
 */
type PrivateReplyOutcome = PrivateReplyReceipt & { readonly note?: string };

const PRIVATE_REPLY_UNCONFIRMED_NOTE =
  'Facebook accepted the request but returned no message id, so delivery is ' +
  'UNCONFIRMED: the single private reply for this comment or post may already be spent ' +
  'and the message may be in the Page inbox. Check with ' +
  'facebook_list_conversations before doing anything else; do not resend blindly.';

/** Same rule as `replyVerdict`: no message id, no confirmation. */
function privateReplyVerdict(outcome: PrivateReplyOutcome) {
  return outcome.messageId === undefined ? ATTEMPTED_VERDICT : APPLIED_VERDICT;
}

/** A client-side (code 0), non-retryable private-reply refusal. */
function privateReplyLocalRefusal(text: string, nextTool: string): GraphApiError {
  return new GraphApiError(text, {
    code: 0,
    httpStatus: 400,
    action: { category: 'validation', retryable: false, nextTool, operatorText: text },
  });
}

/**
 * The terminal refusal for a private reply to a comment or post the Page itself
 * wrote, pointing at the public reply — the same shape as the api layer's
 * window refusals.
 */
function ownTargetRefusalError(recipient: PrivateReplyRecipient): GraphApiError {
  const kind = 'commentId' in recipient ? 'comment' : 'post';
  return privateReplyLocalRefusal(
    `Private reply to ${privateReplyTargetLabel(recipient)} refused: the ${kind} was ` +
      'written by the Page itself, so there is no other person to send a private reply ' +
      'to. This can never succeed — do NOT retry. Private replies go to comments and ' +
      'posts left by visitors.',
    'facebook_reply_to_comment',
  );
}

/** What the local journal says about earlier private replies to one target. */
type PriorPrivateReplies =
  | { readonly known: true; readonly entries: readonly JournalEntry[] }
  | { readonly known: false };

/**
 * Earlier `applied` or `attempted` private replies from this Page to the same
 * comment or post, from the local journal (V10). The journal only knows what
 * this install sent, so an empty answer is not proof that none was sent.
 */
async function priorPrivateReplies(
  journal: Journal,
  pageId: string,
  recipient: PrivateReplyRecipient,
): Promise<PriorPrivateReplies> {
  const history = journal.history ? await journal.history() : 'unreadable';
  if (history === 'unreadable') return { known: false };
  const [key, id] =
    'commentId' in recipient
      ? (['commentId', recipient.commentId] as const)
      : (['postId', recipient.postId] as const);
  return {
    known: true,
    entries: history.filter(
      (entry) =>
        entry.tool === 'facebook_private_reply' &&
        entry.pageId === pageId &&
        (entry.outcome === 'applied' || entry.outcome === 'attempted') &&
        entry.metadata?.[key] === id,
    ),
  };
}

/**
 * Refuse a second private reply the journal already records (V10). An applied
 * one is final; an attempted one (outcome unknown) may be overridden with
 * `allow_repeat` once the inbox shows it never arrived.
 */
function repeatRefusalError(
  recipient: PrivateReplyRecipient,
  prior: readonly JournalEntry[],
): GraphApiError {
  const latest = prior.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
  const when = new Date(latest.timestamp).toISOString();
  const head =
    `Private reply to ${privateReplyTargetLabel(recipient)} refused: a private reply ` +
    `was already sent (or attempted) on ${when}; Meta allows one.`;
  return prior.some((entry) => entry.outcome === 'applied')
    ? privateReplyLocalRefusal(
        `${head} The local journal records it as delivered, so this can never ` +
          'succeed — do NOT retry. Continue in the Messenger thread instead.',
        'facebook_list_conversations',
      )
    : privateReplyLocalRefusal(
        `${head} Its outcome was never confirmed. Check the Page inbox with ` +
          'facebook_list_conversations; only if it never arrived, call again with ' +
          'allow_repeat:true.',
        'facebook_list_conversations',
      );
}

// -------------------------------------------------------------------------
// facebook_private_reply (irreversible, one shot)
// -------------------------------------------------------------------------
export function createPrivateReplyTool() {
  return defineTool({
    name: 'facebook_private_reply',
    title: 'Private reply to comment',
    description:
      'Send a private message to the author of a comment, or of a visitor post on ' +
      'the Page (post_id). TWO hard limits, both checked before anything is sent: ' +
      'exactly ONE private reply is possible per comment or post (there is no second ' +
      'attempt, ever — the local journal is checked too) and only within 7 DAYS of ' +
      'it. The message carries text or ONE attachment (a public https URL or a ' +
      'reusable attachment id). It appears in the Page inbox and cannot be unsent, so ' +
      'it always requires apply:true plus the plan_id from a dry run. Do not retry a ' +
      'failed call blindly — a lost response may already have delivered the ' +
      'message. Sending needs a PAGE token with pages_messaging and the MESSAGING ' +
      'task; the comment or post is read first to check the window, which also needs ' +
      "pages_read_engagement (plus pages_read_user_content for a visitor's comment).",
    inputSchema: z.object({
      ...confirmableWriteArgs,
      comment_id: commentIdArg.optional(),
      post_id: graphNodeIdArg({
        hint: 'facebook_list_posts returns it as `id`.',
        description:
          'Visitor post id (pageid_postid) to answer privately. Use instead of comment_id.',
      }).optional(),
      message: messageArg.optional(),
      saved_reply_id: savedReplyIdArg.optional(),
      attachment: attachmentArg.optional(),
      allow_repeat: z
        .boolean()
        .optional()
        .describe(
          'Send even though the local journal records an earlier ATTEMPTED (unconfirmed) ' +
            'private reply to the same comment or post — only after the inbox shows it ' +
            'never arrived. Never overrides one recorded as delivered.',
        ),
    }),
    annotations: PRIVATE_REPLY_ANNOTATIONS,
    writeTier: TIERS.facebook_private_reply,
    // The comment or post id is the one identity in this call that is not the
    // recipient's: Graph puts it in the URL either way, and it is what answers
    // the "has this target already had its one private reply" question later.
    // `message`, the attachment URL and `confirm_token` stay off.
    logFields: ['profile', 'apply', 'plan_id', 'comment_id', 'post_id', 'allow_repeat'],
    handler: async (input, ctx) => {
      if ((input.comment_id === undefined) === (input.post_id === undefined)) {
        throw new Error(
          'Nothing was sent: pass exactly one of `comment_id` or `post_id`.',
        );
      }
      const contentArgs = [input.message, input.saved_reply_id, input.attachment].filter(
        (arg) => arg !== undefined,
      ).length;
      if (contentArgs === 0) {
        throw new Error('Pass `message`, `saved_reply_id` or `attachment`.');
      }
      if (input.attachment !== undefined && contentArgs > 1) {
        throw new Error(
          'Nothing was sent: pass exactly one of `message`, `saved_reply_id` or ' +
            '`attachment` (a message carries text or one attachment, never both).',
        );
      }
      const recipient: PrivateReplyRecipient =
        input.comment_id !== undefined
          ? { commentId: input.comment_id }
          : { postId: input.post_id ?? '' };
      const isComment = 'commentId' in recipient;
      const targetId = input.comment_id ?? input.post_id ?? '';
      const kind = isComment ? 'comment' : 'post';
      const resolved = await ctx.pages.resolvePage(input.profile);
      const scope = scopeOf(ctx, resolved);
      // Resolved before the target read, so an unknown id or a bad URL spends no
      // Graph call.
      const attachment = outboundAttachmentOf(input.attachment);
      const content: OutboundContent =
        attachment !== undefined
          ? { attachment }
          : {
              text:
                (await messageOrSavedReply(
                  ctx,
                  resolved,
                  input,
                  MAX_COMMENT_MESSAGE_CHARS,
                )) ?? '',
            };
      const savedReplyId = input.saved_reply_id;

      // Client-side pre-flight (CC-MOD-2). Done in BOTH modes and before the
      // gate: a preview that promises a send which can never succeed is worse
      // than a refusal, and the single attempt must not be spent on a call that
      // is guaranteed to fail.
      const facts = isComment
        ? await getComment(ctx.fbRequest, { ...scope, commentId: targetId })
        : await getPrivateReplyPostFacts(ctx.fbRequest, { ...scope, postId: targetId });
      const window = privateReplyWindow(facts.createdTime, ctx.clock.now());
      if (!window.open) {
        throw privateReplyRefusalError(
          window.reason === 'expired' ? 'window_closed' : 'unknown_age',
          recipient,
        );
      }

      // The Page wrote this itself, so there is nobody to message: the send can
      // never succeed, and a preview promising it would be false. The author id
      // is machine-generated, so comparing it is safe (CC-MOD-8).
      if (facts.authorId !== undefined && facts.authorId === resolved.pageId) {
        throw ownTargetRefusalError(recipient);
      }

      // One shot (V10): Facebook refuses a second private reply, and a lost
      // answer may have spent the first, so the local journal is consulted too.
      const prior = await priorPrivateReplies(ctx.journal, resolved.pageId, recipient);
      const repeatWarnings: string[] = [];
      if (!prior.known) {
        repeatWarnings.push(
          'The local journal could not be read, so an earlier private reply from this ' +
            `install to this ${kind} cannot be ruled out. Facebook still refuses a second one.`,
        );
      } else if (prior.entries.length > 0) {
        const delivered = prior.entries.some((entry) => entry.outcome === 'applied');
        if (delivered || input.allow_repeat !== true) {
          throw repeatRefusalError(recipient, prior.entries);
        }
        repeatWarnings.push(
          `allow_repeat: the journal records an unconfirmed private reply to this ${kind}; ` +
            'if it was in fact delivered, Facebook will refuse this one.',
        );
      }

      // Facebook's own eligibility flag is advisory — it can be absent, and it is
      // not authoritative about the one-shot rule — so it is surfaced as a
      // warning rather than used to refuse.
      const eligibilityWarning =
        facts.canReplyPrivately === false
          ? [
              `Facebook reports can_reply_privately=false for this ${kind}, so the send ` +
                'will most likely be rejected. Check that the Page has pages_messaging and ' +
                'the MESSAGING task before applying.',
            ]
          : [];

      const target = privateReplyTargetLabel(recipient);
      const what =
        'text' in content
          ? `"${truncate(content.text, 300)}"`
          : `a ${content.attachment.type} attachment (by ` +
            `${attachmentSourceOf(content.attachment) === 'url' ? 'URL' : 'attachment id'})`;
      return executeWrite(ctx, {
        tool: 'facebook_private_reply',
        tier: TIERS.facebook_private_reply,
        pageId: resolved.pageId,
        resolvedPage: resolved,
        params: {
          ...(isComment ? { comment_id: targetId } : { post_id: targetId }),
          ...('text' in content
            ? { message: content.text }
            : { attachment: input.attachment }),
        },
        ...gateArgs(input),
        summary:
          `Send the ONE allowed private reply to the author of ${target} ` +
          `from Page ${resolved.pageId}: ${what}`,
        warnings: [
          `This consumes the single private reply allowed for this ${kind} — there is ` +
            'no second attempt and no unsend.',
          `The 7-day window closes at ${new Date(window.closesAtMs).toISOString()}.`,
          ...eligibilityWarning,
          ...repeatWarnings,
          ...(attachment !== undefined && attachmentSourceOf(attachment) === 'url'
            ? [ATTACHMENT_FETCH_WARNING]
            : []),
        ],
        notPerformedNotice: 'This was a dry run — no private message was sent.',
        perform: async (): Promise<PrivateReplyOutcome> => {
          const receipt = await sendPrivateReply(ctx.fbRequest, {
            ...scope,
            pageId: resolved.pageId,
            recipient,
            content,
          });
          return receipt.messageId !== undefined
            ? receipt
            : { ...receipt, note: PRIVATE_REPLY_UNCONFIRMED_NOTE };
        },
        // The request may have been delivered even though the answer was lost, so
        // such a failure is journaled attempted rather than failed (C2). A refusal
        // Facebook actually sent back (the one-shot already used, the window
        // closed, a missing permission) proves nothing went out: `failed`.
        classifyOutcome: classifyWriteFailure,
        // Likewise a 200 with no message id: the one-shot may be spent and the
        // message may be in the inbox, but nothing on the wire confirms it.
        classifyResult: privateReplyVerdict,
        metadata: {
          ...(isComment
            ? { commentId: targetId, commentAgeMs: window.ageMs }
            : { postId: targetId, postAgeMs: window.ageMs }),
          ...('text' in content
            ? { messageChars: content.text.length }
            : {
                attachmentType: content.attachment.type,
                attachmentSource: attachmentSourceOf(content.attachment),
              }),
          ...(savedReplyId !== undefined ? { savedReplyId } : {}),
          ...(input.allow_repeat === true ? { allowRepeat: true } : {}),
        },
      });
    },
  });
}
