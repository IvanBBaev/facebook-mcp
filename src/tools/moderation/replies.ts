// Public replies in the `moderation` package: facebook_reply_to_comment and
// the reply plumbing (attachments, local photos, the reply verdict) that
// facebook_comment_on_post and facebook_reply_and_hide_comment reuse.

import { z } from 'zod';

import type { FbRequestFn } from '../../core/index.js';
import { GraphApiError } from '../../core/index.js';
import { replyToComment, type CommentScope } from '../../api/comments.js';
import {
  MediaSourceError,
  digestLocalMedia,
  readLocalPhoto,
  resolveLocalMediaPath,
  type LocalMediaOptions,
} from '../../api/media-photos.js';
import { APPLIED_VERDICT, ATTEMPTED_VERDICT, defineTool } from '../../mcp/index.js';

import { executeWrite, writeArgs } from '../shared.js';
import { messageOrSavedReply, savedReplyIdArg } from '../saved-replies.js';

import {
  REPLY_ANNOTATIONS,
  TIERS,
  commentIdArg,
  isSafeHttpsUrl,
  MAX_COMMENT_MESSAGE_CHARS,
  messageArg,
  classifyWriteFailure,
  truncate,
  scopeOf,
} from './common.js';

/**
 * The one attachment a reply can carry next to (or instead of) its text (V14).
 * Which of `url` / `path` goes with which `kind` is checked in the handler —
 * a `.refine` here would turn the object into a ZodEffects and hide its shape
 * from the JSON schema the client sees.
 */
export const replyAttachmentArg = z
  .object({
    kind: z
      .enum(['image_url', 'gif_url', 'photo_path'])
      .describe(
        'image_url ⇒ `url` is a photo Facebook fetches (attachment_url); gif_url ⇒ `url` is a ' +
          'GIF link (attachment_share_url); photo_path ⇒ `path` is a local image under ' +
          'FB_MEDIA_DIR, uploaded with the reply.',
      ),
    url: z
      .string()
      .url()
      .max(2048)
      .optional()
      .describe('For image_url / gif_url: a public https:// URL without credentials.'),
    path: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .describe('For photo_path: a file path inside FB_MEDIA_DIR.'),
  })
  .strict()
  .describe(
    'Optional photo or GIF for the reply. Pass `url` with image_url / gif_url, `path` with photo_path.',
  );

type ReplyAttachmentInput = z.infer<typeof replyAttachmentArg>;

/** A reply attachment after its local checks; a local photo is bound by content. */
type ReplyAttachment =
  | { readonly kind: 'image_url' | 'gif_url'; readonly url: string }
  | {
      readonly kind: 'photo_path';
      readonly path: string;
      readonly bytes: number;
      readonly sha256: string;
    };

/**
 * What `facebook_reply_to_comment` returns. The confirmed shape is exactly the
 * API's `{ id }`; an acknowledgement without a usable id carries a `note`
 * instead, because there is no handle to hand back and the reply is
 * unconfirmed rather than done.
 */
export type ReplyOutcome =
  { readonly id: string } | { readonly id?: undefined; readonly note: string };

const REPLY_UNCONFIRMED_NOTE =
  'Facebook accepted the request but returned no reply id, so the reply is ' +
  'UNCONFIRMED: it may already be public. Check the thread with ' +
  'facebook_list_comments before doing anything else, and do not post it again blindly.';

/**
 * The gate's verdict for a public reply: only an acknowledgement that names the
 * new reply proves it exists. Anything else is `attempted` — journalled as such
 * and reported `not_applied` with the ATTEMPTED notice, never `applied`.
 */
export function replyVerdict(outcome: ReplyOutcome) {
  return outcome.id === undefined ? ATTEMPTED_VERDICT : APPLIED_VERDICT;
}

/**
 * A comment needs a message, a photo or both. Refused before any call, with
 * the same client-side shape as the package's other local refusals.
 */
export function emptyCommentError(attachmentArg = 'attachment_url'): GraphApiError {
  return localValidationError(
    `A comment needs \`message\`, \`${attachmentArg}\` or both — neither was given. ` +
      'Nothing was sent; add the text or photo and call again.',
  );
}

/** A client-side, non-retryable refusal: nothing was sent to Facebook. */
function localValidationError(text: string): GraphApiError {
  return new GraphApiError(text, {
    code: 0,
    httpStatus: 400,
    action: { category: 'validation', retryable: false, operatorText: text },
  });
}

/** `FB_MEDIA_DIR` policy for a reply's local photo, straight from settings (C11). */
export function localMediaOptions(mediaDir: string | undefined): LocalMediaOptions {
  return mediaDir !== undefined ? { mediaDir } : {};
}

/** A local-media refusal, re-shaped as this package's local validation error. */
function mediaRefusal(err: unknown): unknown {
  return err instanceof MediaSourceError
    ? localValidationError(
        `${err.message} Local files are read only from inside FB_MEDIA_DIR. Nothing was sent.`,
      )
    : err;
}

/**
 * Check a reply attachment locally, before any preview: the `url`/`path` that
 * goes with its `kind`, the https rule for URLs, and — for a local photo — the
 * file itself, hashed so the plan binds its content and a file rewritten
 * between preview and apply is refused instead of uploaded.
 */
export async function prepareReplyAttachment(
  attachment: ReplyAttachmentInput,
  opts: LocalMediaOptions,
): Promise<ReplyAttachment> {
  if (attachment.kind === 'photo_path') {
    if (attachment.path === undefined || attachment.url !== undefined) {
      throw localValidationError(
        'attachment kind photo_path takes `path` (a file inside FB_MEDIA_DIR) and no `url`. ' +
          'Nothing was sent.',
      );
    }
    try {
      const resolved = await resolveLocalMediaPath(attachment.path, opts);
      const digest = await digestLocalMedia(resolved, attachment.path, opts);
      return {
        kind: 'photo_path',
        path: attachment.path,
        bytes: digest.bytes,
        sha256: digest.sha256,
      };
    } catch (err) {
      throw mediaRefusal(err);
    }
  }
  if (attachment.url === undefined || attachment.path !== undefined) {
    throw localValidationError(
      `attachment kind ${attachment.kind} takes \`url\` and no \`path\`. Nothing was sent.`,
    );
  }
  if (!isSafeHttpsUrl(attachment.url)) {
    throw localValidationError(
      'attachment.url must be an https:// URL without embedded credentials. Nothing was sent.',
    );
  }
  return { kind: attachment.kind, url: attachment.url };
}

/** How a preview names a reply attachment: its kind, never the URL or the bytes. */
export function attachmentLabel(attachment: ReplyAttachment): string {
  if (attachment.kind !== 'photo_path') {
    return attachment.kind === 'image_url' ? 'a photo (by URL)' : 'a GIF (by URL)';
  }
  return `the local photo ${attachment.path} (${String(attachment.bytes)} bytes)`;
}

/**
 * Post one public reply: the text, the attachment, or both. A local photo is
 * read here, at apply time, and its hash is checked on the very buffer that is
 * uploaded. An acknowledgement without an id is reported, never assumed.
 */
export async function postReply(
  fbRequest: FbRequestFn,
  scope: CommentScope,
  opts: LocalMediaOptions,
  input: {
    readonly commentId: string;
    readonly message?: string;
    readonly attachment?: ReplyAttachment;
  },
): Promise<ReplyOutcome> {
  const { attachment } = input;
  let photo: Awaited<ReturnType<typeof readLocalPhoto>> | undefined;
  if (attachment?.kind === 'photo_path') {
    try {
      photo = await readLocalPhoto(attachment.path, opts, attachment.sha256);
    } catch (err) {
      throw mediaRefusal(err);
    }
  }
  const ack = await replyToComment(fbRequest, {
    ...scope,
    commentId: input.commentId,
    ...(input.message !== undefined ? { message: input.message } : {}),
    ...(attachment?.kind === 'image_url' ? { attachmentUrl: attachment.url } : {}),
    ...(attachment?.kind === 'gif_url' ? { attachmentShareUrl: attachment.url } : {}),
    ...(photo !== undefined
      ? {
          photo: {
            data: photo.data,
            filename: photo.filename,
            contentType: photo.contentType,
          },
        }
      : {}),
  });
  return ack.id !== undefined ? { id: ack.id } : { note: REPLY_UNCONFIRMED_NOTE };
}

// -------------------------------------------------------------------------
// facebook_reply_to_comment (reversible)
// -------------------------------------------------------------------------
export function createReplyToCommentTool() {
  return defineTool({
    name: 'facebook_reply_to_comment',
    title: 'Reply to comment',
    description:
      'Post a PUBLIC reply under a comment — visible to everyone who can see the ' +
      'thread. Takes `message`, an `attachment` (photo URL, GIF URL or a local ' +
      'photo under FB_MEDIA_DIR), or both. For a private message to the commenter use facebook_private_reply ' +
      'instead. Additive and reversible by deleting the reply, but NOT idempotent: ' +
      'if the response is lost, verify with facebook_list_comments before retrying, ' +
      'or you will post twice. Needs a PAGE token with pages_manage_engagement and ' +
      'the MODERATE task.',
    inputSchema: z.object({
      ...writeArgs,
      comment_id: commentIdArg,
      message: messageArg.optional(),
      saved_reply_id: savedReplyIdArg.optional(),
      attachment: replyAttachmentArg.optional(),
    }),
    annotations: REPLY_ANNOTATIONS,
    writeTier: TIERS.facebook_reply_to_comment,
    // A public reply is externally visible, so the record is: under which
    // comment, and armed how. `message` never appears — it is the content, and
    // it is also the argument most likely to have been shaped by the very
    // comment being answered.
    logFields: ['profile', 'apply', 'plan_id', 'comment_id'],
    handler: async (input, ctx) => {
      if (
        input.message === undefined &&
        input.saved_reply_id === undefined &&
        input.attachment === undefined
      ) {
        throw emptyCommentError('attachment');
      }
      const opts = localMediaOptions(ctx.settings.mediaDir);
      // Checked before the preview: a missing file or an http:// URL is refused
      // before anyone approves anything.
      const attachment =
        input.attachment !== undefined
          ? await prepareReplyAttachment(input.attachment, opts)
          : undefined;
      const resolved = await ctx.pages.resolvePage(input.profile);
      const scope = scopeOf(ctx, resolved);
      // A saved reply's text, not its id, is bound to the plan.
      const message = await messageOrSavedReply(
        ctx,
        resolved,
        input,
        MAX_COMMENT_MESSAGE_CHARS,
      );
      const savedReplyId = input.saved_reply_id;
      const text = message !== undefined ? `"${truncate(message, 300)}"` : '(no text)';
      return executeWrite(ctx, {
        tool: 'facebook_reply_to_comment',
        tier: TIERS.facebook_reply_to_comment,
        pageId: resolved.pageId,
        resolvedPage: resolved,
        // A local photo's size and hash join the bound params, so a plan built
        // for one file cannot upload another.
        params: {
          comment_id: input.comment_id,
          ...(message !== undefined ? { message } : {}),
          ...(attachment !== undefined ? { attachment } : {}),
        },
        ...(input.apply !== undefined ? { apply: input.apply } : {}),
        ...(input.plan_id !== undefined ? { planId: input.plan_id } : {}),
        summary:
          `Post a public reply to comment ${input.comment_id} as Page ` +
          `${resolved.pageId}: ${text}` +
          (attachment !== undefined ? ` with ${attachmentLabel(attachment)}` : ''),
        warnings: [
          'The reply is PUBLIC — everyone who can see the comment can see it.',
          'Posting twice is possible: if this call fails without a clear answer, check ' +
            'facebook_list_comments before retrying.',
        ],
        notPerformedNotice: 'This was a dry run — no reply was posted.',
        // Additive: there is no prior state to diverge from. A comment deleted in
        // the meantime is a hard error, not a no-op — there is nothing to reply to.
        perform: () =>
          postReply(ctx.fbRequest, scope, opts, {
            commentId: input.comment_id,
            ...(message !== undefined ? { message } : {}),
            ...(attachment !== undefined ? { attachment } : {}),
          }),
        // A lost answer may have left the reply public: `attempted`, not `failed`.
        classifyOutcome: classifyWriteFailure,
        // A 200 without a reply id is the wire saying "maybe": the reply may be
        // public already, so it is `attempted`, not `applied` — the response,
        // never the request, decides what the journal records.
        classifyResult: replyVerdict,
        // The attachment's kind only — never its URL or path.
        metadata: {
          commentId: input.comment_id,
          messageChars: message?.length ?? 0,
          ...(savedReplyId !== undefined ? { savedReplyId } : {}),
          ...(attachment !== undefined ? { attachmentKind: attachment.kind } : {}),
        },
      });
    },
  });
}
