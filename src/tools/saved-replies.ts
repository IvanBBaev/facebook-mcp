// Local saved replies (v2 messaging F10) — the three tools of the `messages`
// package that curate operator-approved reply templates, plus the resolver the
// send/reply tools use for `saved_reply_id`.
//
// No Graph call is made here. Save and delete are local writes of user-owned
// data, so they apply directly instead of going through the write gate (the F10
// recommendation): they carry the `reversible` tier, which keeps them out of a
// read-only install, and `delete` returns the record so it can be re-saved.
// The text is operator-authored, so it is not wrapped as untrusted content.

import { z } from 'zod';
import {
  MAX_SAVED_REPLY_CHARS,
  MAX_SAVED_REPLY_TAGS,
  MAX_SAVED_REPLY_TITLE_CHARS,
  SAVED_REPLY_ID_RE,
  SAVED_REPLY_PLACEHOLDERS,
  SAVED_REPLY_TAG_RE,
  SavedRepliesError,
  fillSavedReply,
  slugifyTitle,
  unknownPlaceholders,
  type ResolvedPage,
  type SavedReplyStore,
  type ToolAnnotations,
  type ToolContext,
  type ToolSpec,
} from '../core/index.js';
import { defineTool } from '../mcp/index.js';
import { profileArg, shapeFor } from './shared.js';

export const TOOL_LIST_SAVED_REPLIES = 'facebook_list_saved_replies';
export const TOOL_SAVE_REPLY = 'facebook_save_reply';
export const TOOL_DELETE_SAVED_REPLY = 'facebook_delete_saved_reply';

/** Local-only: nothing here reaches Facebook, so the world is closed. */
const LIST_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/**
 * An upsert: the same call twice leaves the same set (or is refused as a
 * conflict), and an overwrite hands back the record it replaced.
 */
const SAVE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Deletion returns the record, so it can be re-saved: not destructive. */
const DELETE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const PLACEHOLDER_LIST = SAVED_REPLY_PLACEHOLDERS.map((p) => `{{${p}}}`).join(', ');

/** The `saved_reply_id` argument the send/reply tools share. */
export const savedReplyIdArg = z
  .string()
  .regex(SAVED_REPLY_ID_RE, 'saved_reply_id must be a lowercase slug (a-z, 0-9, -).')
  .describe(
    'Id of a saved reply (facebook_list_saved_replies) to send instead of `message`. ' +
      'Its text is resolved now and bound to the plan, so editing the template after ' +
      'the preview makes the apply diverge.',
  );

const replyIdArg = z
  .string()
  .regex(
    SAVED_REPLY_ID_RE,
    'id must be a lowercase slug of at most 48 characters (a-z, 0-9, -).',
  );

const tagArg = z
  .string()
  .regex(SAVED_REPLY_TAG_RE, 'a tag must be a lowercase slug of at most 32 characters.');

/** The store, or a refusal that says why there is none. */
function storeOf(ctx: ToolContext): SavedReplyStore {
  if (ctx.savedReplies === undefined) {
    throw new Error('Saved replies are not available in this server context.');
  }
  return ctx.savedReplies;
}

/**
 * Resolve `saved_reply_id` to the text that will be sent, with `{{page_name}}`
 * filled from the resolved Page. `maxChars` is the target channel's own cap,
 * checked after filling.
 */
export async function resolveSavedReplyText(
  ctx: ToolContext,
  page: ResolvedPage,
  savedReplyId: string,
  maxChars: number,
): Promise<string> {
  const reply = await storeOf(ctx).get(page.pageId, savedReplyId);
  if (reply === undefined) {
    throw new SavedRepliesError(
      'not_found',
      `No saved reply with id "${savedReplyId}" for Page ${page.pageId}. List them with ` +
        `${TOOL_LIST_SAVED_REPLIES}.`,
    );
  }
  const text = fillSavedReply(reply.text, { pageName: page.name });
  if (text.length > maxChars) {
    throw new Error(
      `Saved reply "${savedReplyId}" is ${String(text.length)} characters once filled, ` +
        `over this tool's limit of ${String(maxChars)}.`,
    );
  }
  return text;
}

/**
 * The text to send: `message` or the resolved `saved_reply_id`, never both.
 * `undefined` only when neither was given (the caller decides whether that is
 * allowed, e.g. an attachment-only reply).
 */
export async function messageOrSavedReply(
  ctx: ToolContext,
  page: ResolvedPage,
  input: { readonly message?: string; readonly saved_reply_id?: string },
  maxChars: number,
): Promise<string | undefined> {
  if (input.message !== undefined && input.saved_reply_id !== undefined) {
    throw new Error('Pass either `message` or `saved_reply_id`, not both.');
  }
  if (input.saved_reply_id !== undefined) {
    return resolveSavedReplyText(ctx, page, input.saved_reply_id, maxChars);
  }
  return input.message;
}

/** The three saved-reply tools, in the order the package advertises them. */
export function createSavedReplyTools(): readonly ToolSpec[] {
  const listTool = defineTool({
    name: TOOL_LIST_SAVED_REPLIES,
    title: 'List saved replies',
    description:
      "List the Page's local saved replies: operator-approved reply templates kept on " +
      'this machine (no Facebook call). Use one by passing its id as `saved_reply_id` ' +
      'to facebook_send_message, facebook_reply_to_comment or facebook_private_reply, ' +
      `which fills ${PLACEHOLDER_LIST} and sends the text verbatim. Filter by \`tag\`.`,
    inputSchema: z.object({
      profile: profileArg,
      tag: tagArg.optional().describe('Return only the replies carrying this tag.'),
    }),
    annotations: LIST_ANNOTATIONS,
    handler: async (input, ctx) => {
      const store = storeOf(ctx);
      const resolved = await ctx.pages.resolvePage(input.profile);
      const all = await store.list(resolved.pageId);
      const items =
        input.tag !== undefined
          ? all.filter((r) => r.tags.includes(input.tag ?? ''))
          : all;
      return shapeFor(ctx, {
        pageId: resolved.pageId,
        items: items.map((r) => ({
          id: r.id,
          title: r.title,
          text: r.text,
          tags: r.tags,
          updatedAt: r.updatedAt,
        })),
        count: items.length,
        total: all.length,
        placeholders: SAVED_REPLY_PLACEHOLDERS,
      });
    },
  });

  const saveTool = defineTool({
    name: TOOL_SAVE_REPLY,
    title: 'Save reply template',
    description:
      'Create or update a local saved reply (no Facebook call): a reply template the ' +
      'operator approves once and the agent then sends verbatim. `id` is a lowercase ' +
      'slug and is derived from the title when omitted; an existing id is refused ' +
      'unless overwrite:true, and an overwrite returns the replaced record. The only ' +
      `placeholder is ${PLACEHOLDER_LIST}, filled from the Page; never put a ` +
      "commenter's or customer's details in a template. Applies immediately.",
    inputSchema: z.object({
      profile: profileArg,
      id: replyIdArg
        .optional()
        .describe('Reply id; derived from the title when omitted.'),
      title: z.string().trim().min(1).max(MAX_SAVED_REPLY_TITLE_CHARS),
      text: z
        .string()
        .min(1)
        .max(MAX_SAVED_REPLY_CHARS)
        .describe(
          `The reply text (1–${String(MAX_SAVED_REPLY_CHARS)} characters), sent verbatim. ` +
            `Placeholders: ${PLACEHOLDER_LIST}.`,
        ),
      tags: z.array(tagArg).max(MAX_SAVED_REPLY_TAGS).optional(),
      overwrite: z
        .boolean()
        .optional()
        .describe('Replace an existing reply with the same id. Default false.'),
    }),
    annotations: SAVE_ANNOTATIONS,
    writeTier: 'reversible',
    logFields: ['profile', 'id', 'overwrite'],
    handler: async (input, ctx) => {
      const store = storeOf(ctx);
      if (input.text.trim().length === 0) throw new Error('The reply text is blank.');
      const unknown = unknownPlaceholders(input.text);
      if (unknown.length > 0) {
        throw new Error(
          `Unknown placeholder${unknown.length > 1 ? 's' : ''} ` +
            `${unknown.map((p) => `{{${p}}}`).join(', ')}; the only supported one is ` +
            `${PLACEHOLDER_LIST}.`,
        );
      }
      const id = input.id ?? slugifyTitle(input.title);
      if (!SAVED_REPLY_ID_RE.test(id)) {
        throw new Error(
          'Could not derive an id from this title; pass `id` (a lowercase slug) explicitly.',
        );
      }
      const resolved = await ctx.pages.resolvePage(input.profile);
      const tags = [...new Set(input.tags ?? [])];
      const write = await store.save(
        resolved.pageId,
        { id, title: input.title, text: input.text, tags },
        { overwrite: input.overwrite === true },
      );
      return shapeFor(ctx, {
        pageId: resolved.pageId,
        status: write.created ? 'created' : 'updated',
        reply: write.reply,
        ...(write.previous !== undefined ? { previous: write.previous } : {}),
        file: store.path,
      });
    },
  });

  const deleteTool = defineTool({
    name: TOOL_DELETE_SAVED_REPLY,
    title: 'Delete saved reply',
    description:
      'Delete one local saved reply (no Facebook call). Returns the deleted record, so ' +
      'it can be restored with facebook_save_reply. Applies immediately.',
    inputSchema: z.object({
      profile: profileArg,
      id: replyIdArg.describe('Id of the reply to delete.'),
    }),
    annotations: DELETE_ANNOTATIONS,
    writeTier: 'reversible',
    logFields: ['profile', 'id'],
    handler: async (input, ctx) => {
      const store = storeOf(ctx);
      const resolved = await ctx.pages.resolvePage(input.profile);
      const deleted = await store.remove(resolved.pageId, input.id);
      return shapeFor(ctx, {
        pageId: resolved.pageId,
        status: 'deleted',
        deleted,
        note: `Restore it with ${TOOL_SAVE_REPLY} using the same id, title, text and tags.`,
      });
    },
  });

  return [listTool, saveTool, deleteTool];
}
