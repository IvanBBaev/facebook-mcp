// Sweeper for Page posts — published AND scheduled (CC-LIFE-3).
//
// This is the reference implementation of a sweeper; the ads/moderation/message
// verticals should follow the same shape.
//
// It is deliberately marker-driven rather than ledger-driven: it re-reads the
// test Page and deletes every post whose visible text carries `[FBMCP-SMOKE …]`,
// no matter WHICH run created it. That is what makes a crashed run recoverable
// — the ledger of "what I created" dies with the process, the marker does not.
//
// Scheduled posts matter as much as published ones: a scheduled post left
// behind does not just sit there, it eventually PUBLISHES itself to a real
// audience. `facebook_delete_post` is the only way to cancel one, which is
// exactly why the delete path is smoked here.

import { registerSweeper } from '../registry.mjs';

/** Stop paging eventually, whatever Graph's ranked edges decide to return. */
const MAX_PAGES = 10;
const PAGE_SIZE = 25;

function reasonOf(err) {
  const code = typeof err?.code === 'string' ? err.code : undefined;
  const message = err instanceof Error ? err.message : String(err);
  if (code === 'confirmation_denied') {
    return (
      `${message} — FB_CONFIRM_TOKEN is not set, so the server refused the ` +
      'irreversible apply (scripts/smoke/README.md, "Confirmation"). Set it to the ' +
      'value the server is configured with, or delete this post by hand.'
    );
  }
  return message;
}

/** Collect marked posts from one cursor-paginated tool. */
async function collectMarked(ctx, { tool, args, kind }) {
  const found = [];
  let after;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await ctx.callTool(tool, {
      ...args,
      limit: PAGE_SIZE,
      ...(after === undefined ? {} : { after }),
    });
    const posts = ctx.unwrap(result.posts) ?? [];
    for (const post of posts) {
      const nonce = ctx.findMarkerNonce([post.message, post.story]);
      if (nonce !== undefined && typeof post.id === 'string') {
        found.push({ kind, id: post.id, nonce });
      }
    }
    after = result.nextCursor ?? undefined;
    if (after === undefined || after === null) {
      break;
    }
  }
  return found;
}

registerSweeper({
  id: 'posts',
  title: 'Marked Page posts on the test Page (published + scheduled)',
  packages: ['reader', 'posts'],
  sweep: async (ctx) => {
    const profile = ctx.pages.testProfile;

    // Both listings, deduplicated: a scheduled post can surface on either edge
    // depending on how close it is to its publish time.
    const candidates = new Map();
    for (const item of [
      ...(await collectMarked(ctx, {
        tool: 'facebook_list_posts',
        args: { profile, edge: 'published_posts' },
        kind: 'post',
      })),
      ...(await collectMarked(ctx, {
        tool: 'facebook_list_scheduled_posts',
        args: { profile },
        kind: 'scheduled post',
      })),
    ]) {
      if (!candidates.has(item.id)) {
        candidates.set(item.id, item);
      }
    }

    const items = [];
    let deletions = 0;
    for (const candidate of candidates.values()) {
      if (deletions >= ctx.deleteCap) {
        items.push({
          ...candidate,
          deleted: false,
          reason: `sweep delete cap (${ctx.deleteCap}) reached — re-run with --sweep-only`,
        });
        continue;
      }
      deletions += 1;
      try {
        // `marker: 'none'` — this call references an EXISTING object by id and
        // creates nothing, so there is no artifact for a marker to ride on. The
        // test-Page assertion inside applyWrite still applies.
        const { applied } = await ctx.applyWrite(
          'facebook_delete_post',
          { post_id: candidate.id },
          { marker: 'none' },
        );
        const outcome = applied.result ?? {};
        items.push({
          ...candidate,
          deleted: outcome.deleted === true || outcome.alreadyAbsent === true,
          ...(outcome.alreadyAbsent === true ? { label: 'already gone' } : {}),
          ...(outcome.deleted === true || outcome.alreadyAbsent === true
            ? {}
            : { reason: 'the server did not report a deletion' }),
        });
      } catch (err) {
        items.push({ ...candidate, deleted: false, reason: reasonOf(err) });
      }
    }
    return items;
  },
});
