// Phase-2 smokes for the publish vertical (`posts` package), all on the TEST Page.
//
// Every artifact created here carries `ctx.mark(...)` in its visible text, so
// `../sweepers/posts.sweep.mjs` can reclaim whatever a crashed run leaves behind.
// The smokes still delete their own artifacts: the sweeper is the safety net,
// not the plan — and for two of these the deletion IS the thing under test.
//
// What they prove, beyond "the call did not throw":
//   * publish-and-delete — the whole lifecycle of one text post survives a live
//     round trip: the applied result carries a `{page-id}_{post-id}` composite
//     whose prefix really is the Page the preview promised; the message read
//     back through `facebook_get_post` is identical INCLUDING the marker (so the
//     post stays sweepable); an edit is visible on a RE-READ, not merely
//     reported as `success:true`; and the irreversible delete really removes it.
//   * schedule-and-cancel — a scheduled post appears on the scheduled-posts edge
//     with its marker and its echoed epoch intact, and deleting it takes it out
//     of that queue. This is the most consequential cleanup path in the harness:
//     a leaked scheduled post does not just sit there, it eventually PUBLISHES
//     ITSELF to a real audience, which is why `facebook_delete_post` (the only
//     way to cancel one) is smoked rather than assumed.
//   * photo — the URL-sourced photo path yields BOTH a photo id and a feed post
//     id, and the caption the feed reports back is the one that was sent.
//
// Deliberately NOT covered: a video post. The condition for smoking it was a
// URL-sourced upload that needs no binary fixture, and `../../src/api/media-video.ts`
// — the module that owns the video upload protocol — implements only the
// RESUMABLE LOCAL upload; the "hand Meta a URL" request builder lives elsewhere
// (`videoByUrlRequest` in ../../src/api/posts-write.ts). There is no video
// fixture in this repo, an encodable one cannot be synthesized at runtime, and a
// fresh upload needs minutes of Meta-side encoding before anything is
// assertable. So nothing is registered for it: an accepted gap, not an oversight.
//
// All three declare `requires: ['FB_CONFIRM_TOKEN']`. `facebook_delete_post` is
// irreversible-tier and this harness's MCP client advertises no elicitation
// capability, so the only confirmation route the server accepts is the
// `confirm_token` argument compared against `FB_CONFIRM_TOKEN`
// (../../src/mcp/confirm.ts, and "Confirmation" in ../README.md). The harness
// attaches it centrally in `applyWrite`, so no smoke here passes it by hand —
// but without the variable set every delete answers `confirmation_denied`, the
// delete assertions could never pass and even the photo smoke would leak.
// Refusing up front, naming the variable, beats a permanently red run.

import { registerSmoke } from '../registry.mjs';

/**
 * How far ahead the scheduled post is placed. The planner accepts more than 10
 * minutes and at most 75 days (`SCHEDULE_MIN_LEAD_MS` / `SCHEDULE_MAX_LEAD_MS`
 * in ../../src/api/posts-write.ts) and warns past 30 days. Two hours clears the
 * floor by an order of magnitude — the lead is re-checked at APPLY time, so a
 * value near the minimum could expire between preview and apply — and stays far
 * below the warning line.
 */
const SCHEDULE_LEAD_MS = 2 * 60 * 60 * 1000;

/** The only id shape a Page feed write returns: `{page-id}_{post-id}`. */
const COMPOSITE_POST_ID = /^\d+_\d+$/;

/** Graph is read-your-writes only eventually; give it a bounded chance. */
const READ_BACK_ATTEMPTS = 5;
const READ_BACK_DELAY_MS = 2000;

/** Paging bounds for the scheduled-posts queue, same shape as the sweeper. */
const QUEUE_MAX_PAGES = 10;
const QUEUE_PAGE_SIZE = 25;

/** Wait, without busy-looping. Returns early (does not throw) once aborted. */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Delete one post through the plan→apply handshake and return the tool's own
 * outcome record. `marker: 'none'` because this call only references an object
 * that already exists — there is no new artifact for a marker to ride on.
 *
 * The out-of-band confirmation is not passed here: `applyWrite` owns the whole
 * handshake and attaches `confirm_token` itself once the preview reports
 * `tier: "irreversible"` (../client.mjs).
 */
async function deletePost(ctx, postId) {
  const { applied } = await ctx.applyWrite(
    'facebook_delete_post',
    { post_id: postId },
    { marker: 'none' },
  );
  return applied.result ?? {};
}

/** Delete without ever throwing — for the cleanup of a smoke that already failed. */
async function tryDeletePost(ctx, postId) {
  try {
    const outcome = await deletePost(ctx, postId);
    const gone = outcome.deleted === true || outcome.alreadyAbsent === true;
    if (!gone) {
      ctx.log.warn(`cleanup left ${postId} on the Page: ${JSON.stringify(outcome)}`);
    }
    return gone;
  } catch (err) {
    ctx.log.warn(`cleanup could not delete ${postId}: ${errorText(err)}`);
    return false;
  }
}

/** Read a post by id, retrying while Graph has not propagated it yet. */
async function readPost(ctx, postId) {
  let last;
  for (let attempt = 0; attempt < READ_BACK_ATTEMPTS; attempt += 1) {
    const { payload, isError } = await ctx.callToolRaw('facebook_get_post', {
      profile: ctx.profile,
      post_id: postId,
    });
    if (!isError) return payload;
    last = payload;
    await sleep(READ_BACK_DELAY_MS, ctx.signal);
  }
  ctx.assert(
    false,
    `facebook_get_post never resolved ${postId}: ${JSON.stringify(last)}`,
  );
}

/**
 * Wait until the post no longer resolves. There is no "read a deleted post"
 * success shape — a removed node makes `facebook_get_post` fail, so the server's
 * own absence signal here IS the error result.
 */
async function waitUntilGone(ctx, postId) {
  for (let attempt = 0; attempt < READ_BACK_ATTEMPTS; attempt += 1) {
    const { payload, isError } = await ctx.callToolRaw('facebook_get_post', {
      profile: ctx.profile,
      post_id: postId,
    });
    if (isError) return payload;
    await sleep(READ_BACK_DELAY_MS, ctx.signal);
  }
  return undefined;
}

/** One cursor-following pass over the scheduled-posts queue. */
async function scanQueue(ctx, postId) {
  let after;
  for (let page = 0; page < QUEUE_MAX_PAGES; page += 1) {
    const result = await ctx.callTool('facebook_list_scheduled_posts', {
      profile: ctx.profile,
      limit: QUEUE_PAGE_SIZE,
      ...(after === undefined ? {} : { after }),
    });
    const posts = ctx.unwrap(result.posts) ?? [];
    const hit = posts.find((post) => post.id === postId);
    if (hit !== undefined) return hit;
    after = result.nextCursor ?? undefined;
    if (after === undefined || after === null) break;
  }
  return undefined;
}

/** Poll the queue until the post is present (or absent, for `present: false`). */
async function awaitQueueState(ctx, postId, present) {
  let found = await scanQueue(ctx, postId);
  for (
    let attempt = 1;
    attempt < READ_BACK_ATTEMPTS && (found !== undefined) !== present;
    attempt += 1
  ) {
    await sleep(READ_BACK_DELAY_MS, ctx.signal);
    found = await scanQueue(ctx, postId);
  }
  return found;
}

/** Assert the id a write returned really addresses a post on the test Page. */
function assertCompositeId(ctx, postId, tool) {
  ctx.assert(
    typeof postId === 'string' && COMPOSITE_POST_ID.test(postId),
    `${tool} returned ${JSON.stringify(postId)}, not a "{page-id}_{post-id}" composite`,
  );
  ctx.assert(
    postId.startsWith(`${ctx.pages.testPageId}_`),
    `${tool} returned ${postId}, which does not belong to the test Page ${ctx.pages.testPageId}`,
  );
}

registerSmoke({
  id: 'posts/publish-and-delete',
  phase: 2,
  title: 'Publish a text post, read it back, edit it, then delete it for real',
  page: 'test',
  writes: true,
  packages: ['reader', 'posts'],
  requires: ['FB_CONFIRM_TOKEN'],
  run: async (ctx) => {
    const original = ctx.mark('smoke: publish-and-delete');
    const { preview, applied } = await ctx.applyWrite('facebook_create_post', {
      message: original,
    });
    ctx.log.step(`plan ${preview.planId} applied on Page ${preview.pageId}`);

    const created = applied.result ?? {};
    assertCompositeId(ctx, created.postId, 'facebook_create_post');
    const postId = created.postId;
    ctx.assert(
      created.publishState === 'published',
      `expected publishState "published", got ${JSON.stringify(created.publishState)}`,
    );
    ctx.log.step(`created ${postId}`);

    try {
      const fetched = await readPost(ctx, postId);
      ctx.assert(
        fetched.postId === postId,
        `post id did not round-trip: sent ${postId}, got back ${String(fetched.postId)}`,
      );
      const node = ctx.unwrap(fetched.post);
      ctx.assert(
        node?.message === original,
        `message did not round-trip: sent ${JSON.stringify(original)}, read back ${JSON.stringify(node?.message)}`,
      );
      ctx.assert(
        String(node?.message).includes(ctx.marker),
        'the run marker did not survive publication — the sweeper could not reclaim this post',
      );

      // An edit must be visible on a RE-READ. A tool that reports success while
      // changing nothing is exactly what this assertion exists to catch.
      const edited = ctx.mark('smoke: publish-and-delete (edited)');
      const update = await ctx.applyWrite('facebook_update_post', {
        post_id: postId,
        action: 'edit',
        message: edited,
      });
      const changed = update.applied.result ?? {};
      ctx.assert(
        changed.success === true,
        `facebook_update_post did not report success: ${JSON.stringify(changed)}`,
      );
      ctx.assert(
        changed.changed?.message === edited,
        `facebook_update_post echoed ${JSON.stringify(changed.changed)}`,
      );

      const reread = ctx.unwrap((await readPost(ctx, postId)).post);
      ctx.assert(
        reread?.message === edited,
        `the edit is not visible on a re-read: ${JSON.stringify(reread?.message)}`,
      );
      ctx.log.step('edit round-tripped');
    } catch (err) {
      // Best effort only; the ORIGINAL failure is what the run must report.
      await tryDeletePost(ctx, postId);
      throw err;
    }

    // The delete is under test, not merely cleanup: leaving it to the sweeper
    // would prove nothing about the irreversible path itself.
    const outcome = await deletePost(ctx, postId);
    ctx.assert(
      outcome.deleted === true,
      `facebook_delete_post did not delete ${postId}: ${JSON.stringify(outcome)}`,
    );
    ctx.assert(
      outcome.alreadyAbsent === false,
      'the post we had just read back was reported as already absent',
    );

    const gone = await waitUntilGone(ctx, postId);
    ctx.assert(gone !== undefined, `${postId} still resolves after facebook_delete_post`);
    ctx.log.step(`deleted ${postId}; the post no longer resolves`);
  },
});

registerSmoke({
  id: 'posts/schedule-and-cancel',
  phase: 2,
  title: 'Schedule a post, find it in the queue, then cancel it by deleting it',
  page: 'test',
  writes: true,
  packages: ['reader', 'posts'],
  requires: ['FB_CONFIRM_TOKEN'],
  run: async (ctx) => {
    const message = ctx.mark('smoke: schedule-and-cancel');
    const when = new Date(Date.now() + SCHEDULE_LEAD_MS).toISOString();
    const { applied } = await ctx.applyWrite('facebook_create_post', {
      message,
      scheduled_publish_time: when,
    });

    const created = applied.result ?? {};
    assertCompositeId(ctx, created.postId, 'facebook_create_post');
    const postId = created.postId;
    ctx.assert(
      created.publishState === 'scheduled',
      `expected publishState "scheduled", got ${JSON.stringify(created.publishState)}`,
    );
    const echo = created.schedule ?? {};
    ctx.assert(
      typeof echo.epochSeconds === 'number',
      `the create result carried no schedule echo: ${JSON.stringify(created.schedule)}`,
    );
    ctx.log.step(`scheduled ${postId} for ${String(echo.utc)}`);

    try {
      const queued = await awaitQueueState(ctx, postId, true);
      ctx.assert(
        queued !== undefined,
        `${postId} never appeared in facebook_list_scheduled_posts`,
      );
      ctx.assert(
        typeof queued.message === 'string' && queued.message.includes(ctx.marker),
        `the queued post lost the marker: ${JSON.stringify(queued.message)}`,
      );
      ctx.assert(
        queued.scheduledPublishTime?.epochSeconds === echo.epochSeconds,
        `the queue reports ${String(queued.scheduledPublishTime?.epochSeconds)} but the write echoed ${String(echo.epochSeconds)}`,
      );
      ctx.assert(
        queued.isPublished !== true,
        'a post on the scheduled queue reported itself as already published',
      );
    } catch (err) {
      await tryDeletePost(ctx, postId);
      throw err;
    }

    // Graph has no "cancel" verb: deleting the post IS the cancellation, which
    // is why this path matters more than any other cleanup in the harness. A
    // scheduled post nobody removes eventually publishes itself to a real
    // audience — a leak here is not litter, it is an unintended publication.
    const outcome = await deletePost(ctx, postId);
    ctx.assert(
      outcome.deleted === true,
      `facebook_delete_post did not cancel ${postId}: ${JSON.stringify(outcome)}`,
    );

    const stillQueued = await awaitQueueState(ctx, postId, false);
    ctx.assert(
      stillQueued === undefined,
      `${postId} is still queued to publish after the delete — it WILL go live`,
    );
    ctx.log.step(`cancelled ${postId}; the scheduled queue no longer lists it`);
  },
});

registerSmoke({
  id: 'posts/photo',
  phase: 2,
  title: 'Publish a URL-sourced photo post and read its caption back',
  page: 'test',
  writes: true,
  packages: ['reader', 'posts'],
  // FB_SMOKE_PHOTO_URL: `facebook_create_photo_post` takes an https:// URL Meta
  // fetches itself, so no binary fixture and no temp file are needed — but the
  // repo ships no image URL of its own, and baking in someone else's CDN link
  // would make this smoke fail for reasons that have nothing to do with the
  // server. The operator names the image; the harness refuses clearly without it.
  requires: ['FB_CONFIRM_TOKEN', 'FB_SMOKE_PHOTO_URL'],
  run: async (ctx) => {
    const caption = ctx.mark('smoke: photo post');
    const { applied } = await ctx.applyWrite('facebook_create_photo_post', {
      photo: process.env.FB_SMOKE_PHOTO_URL,
      caption,
    });

    const created = applied.result ?? {};
    ctx.assert(
      typeof created.photoId === 'string' && created.photoId.length > 0,
      `facebook_create_photo_post returned no photoId: ${JSON.stringify(created)}`,
    );
    ctx.assert(
      created.publishState === 'published',
      `expected publishState "published", got ${JSON.stringify(created.publishState)}`,
    );
    // A published photo must also produce a feed story: without that composite
    // id there is nothing to read back and nothing the sweeper could delete.
    assertCompositeId(ctx, created.postId, 'facebook_create_photo_post');
    const postId = created.postId;
    ctx.log.step(`photo ${created.photoId} published as post ${postId}`);

    try {
      const fetched = await readPost(ctx, postId);
      ctx.assert(
        fetched.postId === postId,
        `post id did not round-trip: sent ${postId}, got back ${String(fetched.postId)}`,
      );
      const node = ctx.unwrap(fetched.post);
      ctx.assert(
        node?.message === caption,
        `the caption did not round-trip: sent ${JSON.stringify(caption)}, read back ${JSON.stringify(node?.message)}`,
      );
      ctx.assert(
        String(node?.message).includes(ctx.marker),
        'the run marker did not survive publication — the sweeper could not reclaim this post',
      );
      ctx.log.step('caption round-tripped with the marker intact');
    } finally {
      // Deleting is not what this smoke proves (publish-and-delete owns that),
      // but leaving the post behind would make every run report a leak.
      await tryDeletePost(ctx, postId);
    }
  },
});
