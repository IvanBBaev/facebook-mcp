// Phase-3 smokes for the V07 moderation vertical (`moderation` package).
//
// WHAT A PAGE TOKEN CAN AND CANNOT EXERCISE LIVE
//
// A Page cannot comment on its own post *as a visitor*. Everything this harness
// can create on the test Page is authored BY THE PAGE, so the visitor half of the
// moderation surface is structurally out of reach here. Concretely:
//
//   reachable, and smoked below
//     * facebook_list_comments    — listing + `count`/array agreement + taint
//     * facebook_get_comment      — read-back, taint envelope, 7-day window flag
//     * facebook_reply_to_comment — the ONLY comment-creating tool in the package
//     * facebook_hide_comment     — hide, read back `hidden`, then unhide
//     * facebook_delete_comment   — subject to the confirmation gap (see below)
//
//   NOT reachable with one Page token, deliberately not faked
//     * a VISITOR-authored comment. It needs a second real human account; a Page
//       cannot leave one on itself. Everything read back here is therefore the
//       Page's own text — the taint envelope is asserted on it all the same,
//       because the envelope is applied per FIELD, not per author (CC-MOD-8).
//     * facebook_private_reply. It messages the comment's AUTHOR. With only a
//       Page-authored comment the recipient would be the Page itself, and the
//       verb is one-shot (never a second attempt) AND irreversible (no unsend) —
//       so it must never be aimed at a real person from a test harness. An
//       operator who wants it covered has to do it by hand: from a second, real
//       account comment on a test-Page post, then call facebook_private_reply
//       once against that comment id and read the resulting thread in the Page
//       inbox.
//     * facebook_block_user / facebook_unblock_user. Both take PAGE-SCOPED USER
//       IDs (PSIDs). A PSID only exists for a real person who has interacted
//       with the Page; the Page has none for itself, and inventing one would
//       either be rejected by Graph or — worse for `block` — hit a real
//       stranger's PSID. So `moderation/block-roundtrip` is deliberately NOT
//       registered: this is a KNOWN, UNCOVERED part of the surface. To cover it
//       by hand, take the `authorId` of a real visitor comment from
//       facebook_list_comments, call facebook_block_user with it, confirm in
//       Page Settings → "Blocking" that the person is listed, then call
//       facebook_unblock_user with the same PSID and confirm the list is empty
//       again.
//
// TWO DIVERGENCES FROM THE SCHEMA'S OWN PROSE, VERIFIED IN THE SOURCE
//
//  1. `facebook_reply_to_comment.comment_id` is described as "Not a post ID", but
//     the schema is `z.string().min(1)` and the api layer posts to
//     `/{comment-id}/comments` (src/api/comments.ts::replyToComment) — the very
//     same Graph edge that creates a TOP-LEVEL comment when the id is a post id.
//     That is the only door into "create a comment" this package has, so the
//     smoke uses it twice: once with the seed POST id (top-level comment) and
//     once with the returned COMMENT id (a real nested reply, the documented
//     use). The description is model-facing guidance, not a constraint.
//
//  2. Comment text does NOT arrive in the object envelope `{__tainted, content,
//     warning}` that `ctx.unwrap` understands. `renderComment`
//     (src/tools/moderation.ts) calls `renderTainted(taint('comment', …))`, so
//     `comment.content` is a RENDERED STRING: warning line, `⟦BEGIN UNTRUSTED
//     CONTENT⟧`, the JSON `{"author":…,"message":…}`, `⟦END UNTRUSTED CONTENT⟧`.
//     `ctx.unwrap` is therefore a no-op here. The envelope assertion below works
//     on the raw value (as it must), and the text is recovered by parsing the
//     delimited body; `ctx.unwrap` is still applied first so the smoke keeps
//     working if the envelope ever moves to the object form.
//
// CONFIRMATION (scripts/smoke/README.md, "Confirmation")
//
// `facebook_delete_comment` and `facebook_delete_post` are `irreversible`-tier,
// so the server asks its Confirmer before applying. The smoke client advertises
// no elicitation capability — a headless harness has no human to prompt — so the
// only route left is the operator's `FB_CONFIRM_TOKEN`, which `applyWrite`
// forwards as `confirm_token` on exactly that tier. This smoke therefore declares
// `requires: ['FB_CONFIRM_TOKEN']`: without it every delete answers
// `code: "confirmation_denied"`, the delete assertions could never run, and the
// smoke would leave two real comments and a post behind on every run. Refusing up
// front, naming the variable, beats a permanently red run — and a
// `confirmation_denied` that survives that requirement means the value does not
// match the server's, which is reported as exactly that.

import { registerSmoke } from '../registry.mjs';

/**
 * The delimiters `renderTainted` puts around untrusted text (src/mcp/taint.ts).
 * Copied rather than imported on purpose — a smoke never reaches into the
 * TypeScript source or into build/, and a change to the rendered envelope IS a
 * contract change that should break this smoke loudly.
 */
const TAINT_BEGIN = '⟦BEGIN UNTRUSTED CONTENT⟧';
const TAINT_END = '⟦END UNTRUSTED CONTENT⟧';

/** How many read-Page posts `moderation/list-comments` will probe for comments. */
const READ_PROBE_POSTS = 5;

/**
 * The message for the one failure mode `requires: ['FB_CONFIRM_TOKEN']` cannot
 * rule out: the variable IS set, so the run started, but the server refused the
 * apply anyway — which means the value is not the one the server was configured
 * with. Worth naming precisely, because the generic refusal text reads like a
 * missing variable and would send the operator looking in the wrong place.
 */
function confirmationMismatch(what, message) {
  return (
    `${what} was refused with code "confirmation_denied" although FB_CONFIRM_TOKEN is ` +
    `set — the value does not match the one the server is configured with ` +
    `(scripts/smoke/README.md, "Confirmation"). The artifact was left on the Page; the ` +
    `comments sweeper will report it as a leak. Server said: ${message}`
  );
}

/**
 * Assert that a value is the RENDERED taint envelope: the injection warning
 * first, then the content between the two delimiters. Deliberately operates on
 * the raw value — unwrapping first would assert nothing at all.
 */
function assertEnvelope(ctx, raw, what) {
  ctx.assert(
    typeof raw === 'string',
    `${what}: expected a rendered taint envelope (string), got ${typeof raw}`,
  );
  const begin = raw.indexOf(TAINT_BEGIN);
  ctx.assert(
    begin > 0,
    `${what}: no ${TAINT_BEGIN} delimiter — untrusted text reached the model unwrapped`,
  );
  ctx.assert(raw.includes(TAINT_END), `${what}: the taint envelope is never closed`);
  ctx.assert(
    raw.slice(0, begin).includes('UNTRUSTED'),
    `${what}: the injection warning does not precede the content`,
  );
}

/** The text between the envelope delimiters, or the value itself when absent. */
function envelopeBody(value) {
  if (typeof value !== 'string') {
    return value;
  }
  const begin = value.indexOf(TAINT_BEGIN);
  const end = value.lastIndexOf(TAINT_END);
  if (begin === -1 || end === -1) {
    return value;
  }
  const newline = value.indexOf('\n', begin);
  return value
    .slice(newline === -1 ? begin + TAINT_BEGIN.length : newline + 1, end)
    .trim();
}

/**
 * The comment body a human would read. `ctx.unwrap` runs first so this keeps
 * working if the envelope ever becomes the object form (divergence 2 above).
 */
function commentMessage(ctx, comment) {
  const body = envelopeBody(ctx.unwrap(comment?.content));
  if (typeof body !== 'string') {
    return typeof body?.message === 'string'
      ? body.message
      : JSON.stringify(body ?? null);
  }
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.message === 'string' ? parsed.message : body;
  } catch {
    return body;
  }
}

/** Assert the CC-MOD-5 per-id contract of a bulk moderation result. */
function assertBulkOk(ctx, result, what) {
  const outcomes = Array.isArray(result?.outcomes) ? result.outcomes : undefined;
  ctx.assert(outcomes !== undefined, `${what}: no per-id outcomes came back`);
  ctx.assert(
    result.total === outcomes.length,
    `${what}: tally total ${result.total} disagrees with ${outcomes.length} outcome(s)`,
  );
  ctx.assert(
    result.failed === 0,
    `${what}: ${result.failed} of ${result.total} id(s) failed — ${JSON.stringify(outcomes)}`,
  );
  return outcomes;
}

/**
 * Apply an `irreversible`-tier write and return its `applied` envelope. Every
 * failure fails the smoke — a delete that does not happen is exactly the defect
 * this smoke exists to catch; `confirmation_denied` merely gets a message that
 * says which knob to turn.
 */
async function applyIrreversible(ctx, tool, args, what) {
  try {
    const { applied } = await ctx.applyWrite(tool, args, { marker: 'none' });
    return applied;
  } catch (err) {
    if (err !== null && typeof err === 'object' && err.code === 'confirmation_denied') {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(confirmationMismatch(what, message));
    }
    throw err;
  }
}

registerSmoke({
  id: 'moderation/reply-and-delete',
  phase: 3,
  title: 'Comment as the Page, read it back tainted, hide/unhide it, then delete it',
  page: 'test',
  writes: true,
  packages: ['reader', 'posts', 'moderation'],
  // The deletes are `irreversible`-tier and this client cannot be elicited — see
  // the CONFIRMATION note in the header. Without the token the smoke could only
  // create artifacts and never remove them.
  requires: ['FB_CONFIRM_TOKEN'],
  run: async (ctx) => {
    const profile = ctx.profile;

    // ---- 1. the seed post the comments hang off -------------------------
    const created = await ctx.applyWrite('facebook_create_post', {
      profile,
      message: ctx.mark('smoke: moderation seed post, safe to delete'),
    });
    const postId = created.applied.result?.postId;
    ctx.assert(
      typeof postId === 'string' && postId.length > 0,
      `no post id came back: ${JSON.stringify(created.applied.result)}`,
    );
    ctx.log.step(`seed post ${postId}`);

    // ---- 2. a top-level comment, authored by the Page --------------------
    // The post id on the shared `/{object-id}/comments` edge — see divergence 1.
    const commented = await ctx.applyWrite('facebook_reply_to_comment', {
      profile,
      comment_id: postId,
      message: ctx.mark('smoke: page comment'),
    });
    const commentId = commented.applied.result?.id;
    ctx.assert(
      typeof commentId === 'string' && commentId.length > 0,
      `facebook_reply_to_comment returned no comment id: ${JSON.stringify(
        commented.applied.result,
      )}`,
    );
    ctx.log.step(`comment ${commentId}`);

    // ---- 3. read it back: envelope first, then the text ------------------
    const read = await ctx.callTool('facebook_get_comment', {
      profile,
      comment_id: commentId,
      reply_limit: 5,
    });
    const comment = read.comment ?? {};
    ctx.assert(
      comment.id === commentId,
      `facebook_get_comment returned id ${comment.id}, expected ${commentId}`,
    );
    ctx.assert(
      comment.message === undefined && comment.authorName === undefined,
      'the body/author leaked into a plain, unwarned field outside the taint envelope',
    );
    assertEnvelope(ctx, comment.content, `comment ${commentId}`);
    const body = commentMessage(ctx, comment);
    ctx.assert(
      body.includes(ctx.marker),
      `the run marker did not survive the round trip; body was: ${body}`,
    );
    // A comment created seconds ago must be inside the 7-day private-reply
    // window — this checks the live clock against CC-MOD-2, without sending one.
    ctx.assert(
      read.privateReply?.windowOpen === true,
      `a comment created seconds ago reports the private-reply window closed: ${JSON.stringify(
        read.privateReply,
      )}`,
    );

    // ---- 4. a real nested reply (the documented use of the tool) ---------
    const replied = await ctx.applyWrite('facebook_reply_to_comment', {
      profile,
      comment_id: commentId,
      message: ctx.mark('smoke: nested reply'),
    });
    const replyId = replied.applied.result?.id;
    ctx.assert(
      typeof replyId === 'string' && replyId.length > 0,
      `the nested reply returned no id: ${JSON.stringify(replied.applied.result)}`,
    );

    // ---- 5. listing, folded in here rather than seeding a second post ----
    const listed = await ctx.callTool('facebook_list_comments', {
      profile,
      object_id: postId,
      filter: 'stream',
      order: 'chronological',
      limit: 25,
      include_summary: true,
    });
    const comments = ctx.unwrap(listed.comments) ?? [];
    ctx.assert(Array.isArray(comments), `comments is not an array: ${typeof comments}`);
    ctx.assert(
      listed.count === comments.length,
      `count ${listed.count} disagrees with the array length ${comments.length}`,
    );
    const ids = comments.map((item) => item?.id);
    ctx.assert(
      ids.includes(commentId),
      `the comment is missing from its own post listing`,
    );
    ctx.assert(
      ids.includes(replyId),
      'filter:"stream" did not flatten the reply into the listing',
    );
    for (const item of comments) {
      assertEnvelope(ctx, item?.content, `listed comment ${item?.id}`);
      ctx.assert(
        item?.message === undefined,
        `listed comment ${item?.id} carries a plain, unwarned message field`,
      );
    }
    const totalCount = listed.summary?.totalCount;
    if (typeof totalCount === 'number') {
      ctx.assert(
        totalCount >= comments.length,
        `summary.totalCount ${totalCount} is below the ${comments.length} listed comment(s)`,
      );
    } else {
      ctx.log.step('Graph returned no summary.total_count for this object');
    }
    ctx.log.step(`listed ${comments.length} comment(s) on the seed post`);

    // ---- 6. hide, verify, unhide, verify ---------------------------------
    const hidden = await ctx.applyWrite(
      'facebook_hide_comment',
      { profile, comment_ids: [commentId], hidden: true },
      { marker: 'none' },
    );
    assertBulkOk(ctx, hidden.applied.result, 'hide');
    const afterHide = await ctx.callTool('facebook_get_comment', {
      profile,
      comment_id: commentId,
    });
    ctx.assert(
      afterHide.comment?.hidden === true,
      `the comment reports hidden=${String(afterHide.comment?.hidden)} after a successful ` +
        'hide — either Graph refuses is_hidden on a comment the Page itself authored, or ' +
        'the flag is not read back',
    );

    const unhidden = await ctx.applyWrite(
      'facebook_hide_comment',
      { profile, comment_ids: [commentId], hidden: false },
      { marker: 'none' },
    );
    assertBulkOk(ctx, unhidden.applied.result, 'unhide');
    const afterUnhide = await ctx.callTool('facebook_get_comment', {
      profile,
      comment_id: commentId,
    });
    ctx.assert(
      afterUnhide.comment?.hidden === false,
      `the comment reports hidden=${String(afterUnhide.comment?.hidden)} after the unhide`,
    );
    ctx.log.step('hide → unhide round-tripped');

    // ---- 7. delete both comments in one bulk call ------------------------
    const deleted = await applyIrreversible(
      ctx,
      'facebook_delete_comment',
      { profile, comment_ids: [replyId, commentId] },
      `comment ${commentId} (and reply ${replyId})`,
    );
    assertBulkOk(ctx, deleted.result, 'delete');
    const gone = await ctx.callToolRaw('facebook_get_comment', {
      profile,
      comment_id: commentId,
    });
    ctx.assert(
      gone.isError === true,
      `facebook_get_comment still reads comment ${commentId} after the delete applied`,
    );
    ctx.log.step(`deleted comment ${commentId} and reply ${replyId}`);

    // ---- 8. and the seed post itself -------------------------------------
    await applyIrreversible(
      ctx,
      'facebook_delete_post',
      { profile, post_id: postId },
      `seed post ${postId}`,
    );
    ctx.log.step(`deleted seed post ${postId}`);
  },
});

registerSmoke({
  id: 'moderation/list-comments',
  phase: 3,
  title: 'List real visitor comments on the read Page and prove every body is tainted',
  // Read-only and pointed at the READ Page on purpose: it is the only place with
  // comments actually written by STRANGERS, which is the case the taint envelope
  // exists for. Creating a second seed post on the test Page would prove less and
  // leave more behind.
  page: 'read',
  writes: false,
  packages: ['reader', 'moderation'],
  run: async (ctx) => {
    const profile = ctx.profile;
    const listed = await ctx.callTool('facebook_list_posts', {
      profile,
      edge: 'published_posts',
      limit: READ_PROBE_POSTS,
    });
    const posts = ctx.unwrap(listed.posts) ?? [];
    ctx.assert(Array.isArray(posts), `posts is not an array: ${typeof posts}`);
    if (posts.length === 0) {
      ctx.log.step('the read Page has no published posts — nothing to list comments on');
      return;
    }

    for (const post of posts.slice(0, READ_PROBE_POSTS)) {
      if (typeof post?.id !== 'string') {
        continue;
      }
      const result = await ctx.callTool('facebook_list_comments', {
        profile,
        object_id: post.id,
        filter: 'stream',
        limit: 25,
        include_summary: true,
      });
      ctx.assert(
        result.objectId === post.id,
        `listing reports objectId ${result.objectId}, expected ${post.id}`,
      );
      const comments = ctx.unwrap(result.comments) ?? [];
      ctx.assert(Array.isArray(comments), `comments is not an array: ${typeof comments}`);
      // Asserted for EVERY probed post, including the empty ones: a `count` that
      // disagrees with the array is the shaping bug this smoke is here to catch.
      ctx.assert(
        result.count === comments.length,
        `count ${result.count} disagrees with the array length ${comments.length} on ${post.id}`,
      );
      if (comments.length === 0) {
        if (typeof result.note === 'string') {
          ctx.log.step(`${post.id}: ${result.note}`);
        }
        continue;
      }

      for (const comment of comments) {
        assertEnvelope(ctx, comment?.content, `comment ${comment?.id} on ${post.id}`);
        ctx.assert(
          comment?.message === undefined && comment?.authorName === undefined,
          `comment ${comment?.id} leaked visitor text outside the taint envelope`,
        );
        ctx.assert(
          typeof comment?.id === 'string' && comment.id.length > 0,
          'a listed comment carries no id outside the envelope, so it cannot be moderated',
        );
      }
      ctx.log.step(`${comments.length} tainted comment(s) on ${post.id}`);
      return;
    }

    ctx.log.step(
      `none of the ${Math.min(posts.length, READ_PROBE_POSTS)} newest read-Page post(s) ` +
        'carries a comment — the envelope assertion was not exercised against visitor text',
    );
  },
});
