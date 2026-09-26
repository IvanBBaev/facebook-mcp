// Phase-1 smokes for the V01 read vertical (`reader` package): the timeline
// round-trip, and `reader/reactions` at the bottom of this file.
//
// Read-only by construction: they run against the READ Page (production is fine
// — nothing here mutates anything) and create no artifacts, so the sweeper has
// nothing to do for this file.
//
// What the timeline smoke actually proves, beyond "the call did not throw":
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
      ctx.log.step('read Page has no published posts');
      ctx.notExercised(
        'the composite-id round-trip (UX #19) never ran: with no published post ' +
          'there is no id to hand back to facebook_get_post, so nothing here proves ' +
          'that a listed id is accepted verbatim and echoed unchanged',
      );
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

// ---------------------------------------------------------------------------
// reader/reactions — the last uncovered reader tool, and a counting trap
// ---------------------------------------------------------------------------
//
// `facebook_get_reactions` had no live coverage at all. Like the core reads it is
// a free, read-only GET, so it is covered rather than registered as an accepted
// gap — that label belongs to contracts that cannot be exercised, not to ones
// nobody had written yet.
//
// It gets its own registration rather than riding on `reader/timeline` above so a
// reaction-shaping regression cannot take the id round-trip down with it, and so
// `--only reader/reactions` is a thing an operator can run. The cost is one extra
// listing GET.
//
// What it proves, beyond "the call did not throw":
//   * `userCount` is the length of the disclosed list, NOT the reaction count.
//     Graph withholds most reactor identities from third-party apps, so the two
//     legitimately disagree (UX #20a) — a live Page is the only place that gap
//     actually appears, and the model is told to trust `total`, never `userCount`;
//   * reactor display names are user-chosen text, so `users` leaves the server
//     inside the taint envelope even when the list is empty — the shape must not
//     depend on whether Graph disclosed anybody (B1 / CC-MOD-8);
//   * the permission limit is EXPLAINED in-band rather than left to be discovered.
registerSmoke({
  id: 'reader/reactions',
  phase: 1,
  title: 'Read reactions on a published post: totals, taint envelope, and the count trap',
  page: 'read',
  writes: false,
  packages: ['reader'],
  run: async (ctx) => {
    const listed = await ctx.callTool('facebook_list_posts', {
      profile: ctx.profile,
      edge: 'published_posts',
      limit: 1,
    });
    const posts = ctx.unwrap(listed.posts);
    ctx.assert(Array.isArray(posts), `posts is not an array: ${typeof posts}`);

    if (posts.length === 0) {
      ctx.log.step('read Page has no published posts');
      ctx.notExercised(
        'facebook_get_reactions was never called: with no post to read reactions on, ' +
          'nothing proved that reactor display names arrive inside the taint envelope ' +
          '(B1 / CC-MOD-8), that `userCount` is the length of the DISCLOSED list rather ' +
          'than the reaction count (UX #20a), or that the permission limit is explained ' +
          'in-band',
      );
      return;
    }

    const postId = posts[0].id;
    ctx.assert(
      typeof postId === 'string' && postId.length > 0,
      'the newest post carries no id',
    );

    const reactions = await ctx.callTool('facebook_get_reactions', {
      profile: ctx.profile,
      post_id: postId,
      limit: 10,
    });

    ctx.assert(
      reactions.pageId === ctx.pages.readPageId,
      `get_reactions resolved Page ${String(reactions.pageId)}, expected ${ctx.pages.readPageId}`,
    );
    ctx.assert(
      reactions.postId === postId,
      `post id did not round-trip: sent ${postId}, got back ${String(reactions.postId)}`,
    );
    ctx.assert(
      reactions.totals !== null && typeof reactions.totals === 'object',
      `totals is not an object: ${typeof reactions.totals}`,
    );

    // The envelope is asserted BEFORE unwrapping, and regardless of length: an
    // empty reactor list must still be wrapped, or the shape would silently
    // depend on what Graph felt like disclosing.
    ctx.assert(
      reactions.users?.__tainted === true,
      'the reactor list arrived outside the taint envelope — display names are ' +
        'user-chosen text and are never trusted content',
    );
    const users = ctx.unwrap(reactions.users);
    ctx.assert(Array.isArray(users), `users is not an array: ${typeof users}`);
    ctx.assert(
      reactions.userCount === users.length,
      `userCount ${reactions.userCount} disagrees with the disclosed list length ${users.length}`,
    );

    // The trap this tool exists to defuse: `userCount` is what Graph disclosed,
    // `total` is how many reactions there are. The list can never be LONGER.
    if (typeof reactions.total === 'number') {
      ctx.assert(
        reactions.userCount <= reactions.total,
        `${reactions.userCount} disclosed reactor(s) against a total of ${reactions.total} — ` +
          'the identity list can never exceed the count',
      );
    }
    // The permission limit has to be stated, not discovered: a short list next to
    // a large total is exactly what an unwarned reader would misreport.
    ctx.assert(
      typeof reactions.note === 'string' && reactions.note.length > 0,
      'reactions came back without the note that explains the identity limit',
    );

    ctx.log.step(
      `post ${postId}: total=${String(reactions.total ?? 'n/a')}, ` +
        `${reactions.userCount} reactor identit(ies) disclosed, list wrapped`,
    );
  },
});
