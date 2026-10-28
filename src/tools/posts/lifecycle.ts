// `posts` package — post lifecycle: facebook_update_post (content edits and
// the scheduled-post verbs) and facebook_delete_post.

import { z } from 'zod';
import { errorMessageOf } from '../../core/index.js';
import type { ToolContext } from '../../core/index.js';
import {
  DELETE_ALREADY_ABSENT_NOTE,
  DELETE_PERMANENT_NOTE,
  EDIT_OWN_APP_NOTE,
  PUBLISH_NOW_VERIFY_NOTE,
  UPDATE_POST_ACTIONS,
  createdAtMsOf,
  deletePostRequest,
  isPostAbsentError,
  planDeletePost,
  planUpdatePost,
  readPinnedPostId,
  readPostState,
  updatePostRequest,
  type PostState,
  type RequestScope,
  type UpdatePostAction,
} from '../../api/posts-write.js';
import { defineTool } from '../../mcp/index.js';
import { confirmableWriteArgs, executeWrite, gateArgs, writeArgs } from '../shared.js';
import { MUTATE_ANNOTATIONS, pageTimezoneArg, postIdArg } from './args.js';
import { planWarnings, prepareBase, requestScope, toTimeEcho } from './context.js';
import { ToolInputError, guarded } from './errors.js';
import {
  DeletePostOutcome,
  UpdatePostOutcome,
  classifyMutationFailure,
  confirmsWrite,
  deletePostVerdict,
  updatePostVerdict,
} from './outcomes.js';

// ---------------------------------------------------------------------------
// 11. facebook_update_post
// ---------------------------------------------------------------------------

/**
 * The pre-read plus the `readState` closure the write gate uses.
 *
 * `update` needs the post's `created_time` to enforce the 29-day reschedule
 * window, and the gate needs a before-state for divergence detection — the same
 * read serves both, so the first `readState()` call is answered from the
 * pre-read instead of issuing a duplicate GET. This is correct in BOTH modes:
 * in plan mode the pre-read IS the captured before-state, and in apply mode it
 * is the fresh state the plan is compared against.
 */
function memoizedPostState(
  ctx: ToolContext,
  postId: string,
  scope: RequestScope,
  first: PostState,
): () => Promise<PostState> {
  let cached: PostState | undefined = first;
  return async (): Promise<PostState> => {
    if (cached !== undefined) {
      const state = cached;
      cached = undefined;
      return state;
    }
    return await readPostState(ctx.fbRequest, postId, scope);
  };
}

/**
 * The applied `verifyNote` of a post update. Only `publish_now` is a publish; an
 * edit or a reschedule is not on the published listing's terms — a changed text
 * or a moved time shows on the post itself, and a rescheduled post sits on the
 * scheduled queue, not the published listing (CC-PUB-1).
 */
function updateVerifyNote(action: UpdatePostAction, postId: string): string {
  if (action === 'publish_now') return PUBLISH_NOW_VERIFY_NOTE;
  if (action === 'reschedule') {
    return `A reschedule that times out may still have moved the post. Never re-send it blindly — verify with facebook_list_scheduled_posts (or facebook_get_post with post_id "${postId}"), comparing its scheduled_publish_time with the time in this plan.`;
  }
  return `An edit that times out may still have been applied. Never re-send it blindly — verify with facebook_get_post with post_id "${postId}", comparing it with the change in this plan.`;
}

function absentPostError(postId: string): ToolInputError {
  return new ToolInputError(
    'post_id',
    `post ${postId} could not be read: it does not exist, was already deleted, or is not visible to this app's token.`,
    `${EDIT_OWN_APP_NOTE} Confirm the id with facebook_list_scheduled_posts (for a scheduled post) or a feed listing before retrying.`,
  );
}

export function buildUpdatePost() {
  return defineTool({
    name: 'facebook_update_post',
    title: 'Update Post',
    description:
      'Edit a Page post the app itself created, or move it through the scheduled-post ' +
      'lifecycle. action:"edit" changes message/is_hidden/is_pinned; "publish_now" ' +
      'publishes a draft or scheduled post immediately; "reschedule" moves the publish ' +
      'time; "cancel_schedule" is not a Graph transition and is answered with the ' +
      'delete path to use instead. Dry run by default; an edit OVERWRITES the previous ' +
      'text, which Graph does not keep. Pinning is undocumented Graph behaviour and ' +
      'replaces the currently pinned post; the dry run names that post.',
    inputSchema: z.object({
      ...writeArgs,
      post_id: postIdArg,
      action: z
        .enum(UPDATE_POST_ACTIONS)
        .describe(
          'edit ⇒ change content (needs at least one of message, is_hidden, is_pinned). publish_now ⇒ publish a draft/scheduled post immediately, no other fields. reschedule ⇒ move the publish time, needs scheduled_publish_time and no content fields. cancel_schedule ⇒ NOT supported by Graph; the call explains that removing a scheduled post means deleting it with facebook_delete_post.',
        ),
      message: z
        .string()
        .optional()
        .describe(
          'Replacement post text (action:"edit" only). This REPLACES the old text; the previous version is not recoverable through the API.',
        ),
      is_hidden: z
        .boolean()
        .optional()
        .describe(
          'action:"edit" only. true ⇒ hide the post from the Page timeline without deleting it.',
        ),
      is_pinned: z
        .boolean()
        .optional()
        .describe('action:"edit" only. true ⇒ pin the post to the top of the Page.'),
      scheduled_publish_time: z
        .string()
        .min(1)
        .optional()
        .describe(
          'action:"reschedule" only. ISO-8601 WITH an explicit offset. Must be at least 10 minutes and at most 75 days ahead, and at most 29 days after the post was originally created.',
        ),
      page_timezone: pageTimezoneArg,
    }),
    annotations: MUTATE_ANNOTATIONS,
    writeTier: 'reversible',
    // `action` IS the mutation: an edit overwrites text Graph does not keep, a
    // publish_now reaches an audience, a reschedule moves the moment it does.
    // The replacement `message` stays off the list — it is the content — while
    // the two visibility booleans are state rather than content, and they are
    // what a later "why is this post hidden/pinned" question needs.
    logFields: [
      'profile',
      'apply',
      'plan_id',
      'post_id',
      'action',
      'is_hidden',
      'is_pinned',
      'scheduled_publish_time',
    ],
    handler: (input, ctx) =>
      guarded(ctx, async () => {
        const base = await prepareBase(ctx, input, {
          needTimezone: input.action === 'reschedule',
        });
        const scope = requestScope(ctx, base.page);

        const before = await readPostState(ctx.fbRequest, input.post_id, scope);
        if (!before.present) throw absentPostError(input.post_id);
        // is_published:true on a live post is a no-op; previewing it as
        // "Publish ... right now" and applying it would claim a publish that
        // this call never caused.
        if (input.action === 'publish_now' && before.isPublished === true) {
          throw new ToolInputError(
            'action',
            `post ${input.post_id} is already published — publish_now has nothing to publish.`,
            'Use action:"edit" to change a live post, or facebook_get_post to confirm its state.',
          );
        }
        // A live post has no publish time left to move. Previewing "Move post … to
        // <time>" and applying it would tell the operator the post now waits for
        // that instant while it stays in front of the audience.
        if (input.action === 'reschedule' && before.isPublished === true) {
          throw new ToolInputError(
            'action',
            `post ${input.post_id} is already published — reschedule only moves a post that is still waiting to go live.`,
            'To show this content at a later time, create a new scheduled post (facebook_create_post with scheduled_publish_time) and remove this one with facebook_delete_post.',
          );
        }

        const action: UpdatePostAction = input.action;
        const createdAtMs = createdAtMsOf(before);
        const plan = planUpdatePost(
          {
            postId: input.post_id,
            action,
            ...(input.message !== undefined ? { message: input.message } : {}),
            ...(input.is_hidden !== undefined ? { isHidden: input.is_hidden } : {}),
            ...(input.is_pinned !== undefined ? { isPinned: input.is_pinned } : {}),
            ...(input.scheduled_publish_time !== undefined
              ? { scheduledPublishTime: input.scheduled_publish_time }
              : {}),
          },
          {
            nowMs: base.nowMs,
            ...(base.pageTimezone !== undefined
              ? { pageTimezone: base.pageTimezone }
              : {}),
            ...(createdAtMs !== undefined ? { createdAtMs } : {}),
          },
        );

        // F7: a Page holds one pinned post, so pinning replaces the current one.
        // Its id joins the before-state (a different pin at apply time diverges)
        // and the journal metadata (what to re-pin to undo).
        const probesPin = action === 'edit' && input.is_pinned === true;
        const readPinned = () => readPinnedPostId(ctx.fbRequest, base.page.pageId, scope);
        const pinnedNow = probesPin ? await readPinned() : undefined;
        const replacedPin =
          pinnedNow !== undefined && pinnedNow !== input.post_id ? pinnedNow : undefined;
        const readPostOnly = memoizedPostState(ctx, input.post_id, scope, before);
        let pinnedCached = probesPin;
        const readState = probesPin
          ? async () => {
              const post = await readPostOnly();
              const pinned = pinnedCached ? pinnedNow : await readPinned();
              pinnedCached = false;
              return { ...post, pinnedPostId: pinned ?? null };
            }
          : readPostOnly;

        const echo = plan.schedule !== undefined ? toTimeEcho(plan.schedule) : undefined;
        return executeWrite(ctx, {
          tool: 'facebook_update_post',
          tier: 'reversible',
          // `publish_now` reaches a live audience exactly as `facebook_create_post`
          // with published:true does — the post can be deleted afterwards, but the
          // impressions it collects in the meantime cannot be recalled. Binding it
          // to a plan_id keeps the one rule in one place; edits, reschedules and
          // the cancel_schedule explainer reach nobody new and stay ungated.
          requirePlanId: action === 'publish_now',
          pageId: base.page.pageId,
          params: { post_id: input.post_id, action, ...plan.params },
          ...(input.apply !== undefined ? { apply: input.apply } : {}),
          ...(input.plan_id !== undefined ? { planId: input.plan_id } : {}),
          summary: plan.summary,
          warnings: [
            ...planWarnings(plan, echo),
            ...(replacedPin !== undefined
              ? [
                  `Pinning replaces the currently pinned post ${replacedPin}; pin it again to undo.`,
                ]
              : []),
          ],
          resolvedPage: base.page,
          notPerformedNotice: 'This was a dry run — the post was NOT changed.',
          metadata: {
            action,
            ...(replacedPin !== undefined ? { previouslyPinnedPostId: replacedPin } : {}),
          },
          readState,
          classifyOutcome: classifyMutationFailure,
          classifyResult: updatePostVerdict,
          perform: async (): Promise<UpdatePostOutcome> => {
            let res;
            try {
              res = await ctx.fbRequest<unknown>(
                updatePostRequest(input.post_id, plan.params, scope),
              );
            } catch (err) {
              // 100/33 on a write is also "cannot be loaded due to missing
              // permissions, or does not support this operation" — Graph's
              // answer for a post another app created. Propagated raw it is
              // mapped `not_found` ("treat it as already gone") about a post
              // this call just read. Only a re-read that still finds the post
              // may replace that verdict; any other outcome keeps the original.
              if (!isPostAbsentError(err) || !before.present) throw err;
              const after = await readPostState(
                ctx.fbRequest,
                input.post_id,
                scope,
              ).catch(() => {
                throw err;
              });
              if (!after.present) throw err;
              return {
                postId: input.post_id,
                action,
                success: false,
                changed: {},
                note: `Graph refused the ${action} (${errorMessageOf(err)}), and post ${input.post_id} is still readable — it was NOT changed. ${EDIT_OWN_APP_NOTE}`,
              };
            }
            return {
              postId: input.post_id,
              action,
              success: confirmsWrite(res.data),
              changed: plan.params,
              ...(echo !== undefined ? { schedule: echo } : {}),
              verifyNote: updateVerifyNote(action, input.post_id),
            };
          },
        });
      }),
  });
}

// ---------------------------------------------------------------------------
// 12. facebook_delete_post
// ---------------------------------------------------------------------------

export function buildDeletePost() {
  return defineTool({
    name: 'facebook_delete_post',
    title: 'Delete Post',
    description:
      'Permanently delete a Page post the app itself created — including a ' +
      'scheduled one, which is the only way to cancel it. There is no undo and no ' +
      'trash: the text, comments, reactions and shares are gone. Irreversible tier, ' +
      'so applying ALWAYS needs both apply:true and the plan_id of a preceding dry ' +
      'run, whatever FB_WRITE_MODE says. Reels: whether a Reel can be deleted here ' +
      'by its video ID is UNVERIFIED against the live API — Reels are invisible on ' +
      'post endpoints, so assume neither outcome and re-read the Page afterwards.',
    inputSchema: z.object({
      ...confirmableWriteArgs,
      post_id: postIdArg,
    }),
    annotations: MUTATE_ANNOTATIONS,
    writeTier: 'irreversible',
    // The one write with no undo gets the fullest record — and still not
    // `confirm_token`. That value is the operator's out-of-band secret; the
    // redactor would mask a known token, but an allowlist must not depend on the
    // redactor having seen it first.
    logFields: ['profile', 'apply', 'plan_id', 'post_id'],
    handler: (input, ctx) =>
      guarded(ctx, async () => {
        const base = await prepareBase(ctx, input, { needTimezone: false });
        const scope = requestScope(ctx, base.page);
        const before = await readPostState(ctx.fbRequest, input.post_id, scope);
        const plan = planDeletePost({ postId: input.post_id });

        return executeWrite(ctx, {
          tool: 'facebook_delete_post',
          tier: 'irreversible',
          pageId: base.page.pageId,
          params: plan.params,
          ...gateArgs(input),
          summary: plan.summary,
          warnings: before.present
            ? plan.warnings
            : [
                ...plan.warnings,
                `Post ${input.post_id} could not be read before this plan was built, so it may already be gone or invisible to this app's token.`,
              ],
          resolvedPage: base.page,
          notPerformedNotice:
            'This was a dry run — the post was NOT deleted and still exists.',
          metadata: { presentAtPlanTime: before.present },
          readState: memoizedPostState(ctx, input.post_id, scope, before),
          classifyOutcome: classifyMutationFailure,
          classifyResult: deletePostVerdict,
          perform: async (): Promise<DeletePostOutcome> => {
            try {
              const res = await ctx.fbRequest<unknown>(
                deletePostRequest(input.post_id, scope),
              );
              return {
                postId: input.post_id,
                deleted: confirmsWrite(res.data),
                alreadyAbsent: false,
                note: DELETE_PERMANENT_NOTE,
              };
            } catch (err) {
              // CC-PUB-5: "already gone" is the intended end state, not a failure
              // — but say plainly that THIS call deleted nothing.
              if (!isPostAbsentError(err)) throw err;
              // 100/33 also means "cannot be loaded due to missing permissions,
              // or does not support this operation" — Graph's answer for a post
              // another app created. A post this call just read is only "already
              // absent" once a re-read agrees; one that is still readable was
              // NOT deleted, and calling it gone would hide a live post.
              if (before.present) {
                // A re-read that itself fails proves nothing either way, so the
                // delete's own error stands instead of an unproven "gone".
                const after = await readPostState(
                  ctx.fbRequest,
                  input.post_id,
                  scope,
                ).catch(() => {
                  throw err;
                });
                if (after.present) {
                  return {
                    postId: input.post_id,
                    deleted: false,
                    alreadyAbsent: false,
                    note: `Graph refused the delete (${errorMessageOf(err)}), and post ${input.post_id} is still readable — it was NOT deleted and still exists. ${EDIT_OWN_APP_NOTE}`,
                  };
                }
              }
              return {
                postId: input.post_id,
                deleted: false,
                alreadyAbsent: true,
                note: DELETE_ALREADY_ABSENT_NOTE,
              };
            }
          },
        });
      }),
  });
}
