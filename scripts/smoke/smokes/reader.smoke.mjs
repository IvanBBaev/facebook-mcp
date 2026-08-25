// Phase-1 smoke for the V01 read vertical (`reader` package).
//
// Read-only by construction: it runs against the READ Page (production is fine
// — nothing here mutates anything) and creates no artifacts, so the sweeper has
// nothing to do for it.
//
// What it actually proves, beyond "the call did not throw":
//   * the resolved Page is the one the harness asked for (profile resolution
//     works end to end, not just in unit tests);
//   * `count` matches the array length (the shaping layer did not silently
//     truncate the array out from under the count);
//   * post ids ROUND-TRIP: the composite id from the listing is accepted
//     verbatim by `facebook_get_post` and comes back identical (UX #19). This
//     is the contract most likely to break against a live Graph version bump,
//     and the one a fixture-based unit test cannot really prove.

import { registerSmoke } from '../registry.mjs';

registerSmoke({
  id: 'reader/timeline',
  phase: 1,
  title: 'List published posts, then read one back by its composite id',
  page: 'read',
  writes: false,
  packages: ['reader'],
  run: async (ctx) => {
    const listed = await ctx.callTool('facebook_list_posts', {
      profile: ctx.profile,
      edge: 'published_posts',
      limit: 3,
    });

    ctx.assert(
      listed.pageId === ctx.pages.readPageId,
      `listing resolved Page ${listed.pageId}, expected ${ctx.pages.readPageId}`,
    );
    ctx.assert(listed.edge === 'published_posts', `unexpected edge: ${listed.edge}`);

    // `published_posts` is Page-authored, so the array is NOT taint-wrapped —
    // unwrap defensively anyway so this smoke keeps working if the edge default
    // ever changes.
    const posts = ctx.unwrap(listed.posts);
    ctx.assert(Array.isArray(posts), `posts is not an array: ${typeof posts}`);
    ctx.assert(
      listed.count === posts.length,
      `count ${listed.count} disagrees with the array length ${posts.length}`,
    );
    ctx.log.step(`${posts.length} post(s), truncated=${String(listed.truncated)}`);
    if (typeof listed.note === 'string') {
      ctx.log.step(`note: ${listed.note}`);
    }

    if (posts.length === 0) {
      ctx.log.step('read Page has no published posts — id round-trip not exercised');
      return;
    }

    const first = posts[0];
    ctx.assert(
      typeof first.id === 'string' && first.id.length > 0,
      'the first post carries no id',
    );

    const detail = await ctx.callTool('facebook_get_post', {
      profile: ctx.profile,
      post_id: first.id,
    });
    ctx.assert(
      detail.pageId === ctx.pages.readPageId,
      `get_post resolved Page ${detail.pageId}, expected ${ctx.pages.readPageId}`,
    );
    ctx.assert(
      detail.postId === first.id,
      `post id did not round-trip: sent ${first.id}, got back ${detail.postId}`,
    );
    const post = ctx.unwrap(detail.post);
    ctx.assert(
      post?.id === first.id,
      `fetched node has id ${post?.id}, expected ${first.id}`,
    );
    ctx.log.step(`round-tripped ${first.id}`);
  },
});
