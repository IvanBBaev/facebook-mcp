// Sweeper for marked comments on the test Page (CC-LIFE-3, vertical V07).
//
// This is the cleanup half of `moderation/reply-and-delete`, which posts a
// top-level comment AND a nested reply as the Page. Both outlive any run that
// dies before its own cleanup block, which is what this sweeper is for.
//
// Same shape as `sweepers/posts.sweep.mjs`, for the same reason: marker-driven,
// not ledger-driven. It re-reads the test Page and deletes every comment whose
// body carries `[FBMCP-SMOKE …]`, whichever run wrote it — a ledger of "what I
// created" dies with the crashed process, the marker does not.
//
// WHERE COMMENTS HIDE. A comment is not listable on its own: it hangs off a host
// object, so the hosts have to be enumerated first. The scan covers the newest
// MAX_HOST_PAGES × PAGE_SIZE posts of the test Page's `published_posts` edge,
// marked or not — a marked comment can sit on a perfectly ordinary post, and a
// smoke that comments on a pre-existing post would otherwise be invisible here.
// `filter: 'stream'` flattens replies into the same listing, so a nested reply
// is found without walking the replies edge by hand. Photos, videos, Reels and
// the `feed`/`tagged` edges are deliberately NOT scanned: nothing in this
// harness can leave a comment on one (a Page token cannot author a visitor post
// either), and scanning every edge would cost an API call per object on every
// sweep, twice per run.
//
// SWEEP ORDER. Sweepers run in id order, so `comments` runs before `posts` —
// which is the order that helps: deleting a post takes its comments with it, so
// the other way round would quietly swallow comments this sweep should have
// named by id.
//
// THE MARKER LIVES INSIDE THE TAINT ENVELOPE. `renderComment`
// (src/tools/moderation.ts) returns the body as a RENDERED envelope string under
// `content`, never as a plain `message` field, and the marker rides along inside
// it. So the marker search runs over that field — but strictly over the
// comment's OWN text, never over the whole node: a marked reply must never make
// its unmarked parent look deletable.
//
// CONFIRMATION (scripts/smoke/README.md, "Confirmation"). `facebook_delete_comment`
// is `irreversible`-tier, so the server consults its out-of-band gate before
// applying. The smoke client advertises no `elicitation` capability — a headless
// harness has no human to prompt — so the only route left is the operator's
// `FB_CONFIRM_TOKEN`, which `applyWrite` forwards as `confirm_token` on exactly
// this tier. Nothing is minted here: with the variable unset the server answers
// `code: "confirmation_denied"` and each comment is reported as a leak naming that
// code, exactly like the posts sweeper does, and the run exits non-zero.

import { registerSweeper } from '../registry.mjs';

/** Stop paging eventually, whatever Graph's ranked edges decide to return. */
const MAX_HOST_PAGES = 2;
const MAX_COMMENT_PAGES = 10;
const PAGE_SIZE = 25;

function reasonOf(err) {
  const code = typeof err?.code === 'string' ? err.code : undefined;
  const message = err instanceof Error ? err.message : String(err);
  if (code === 'confirmation_denied') {
    return (
      `${message} — FB_CONFIRM_TOKEN is not set, so the server refused the ` +
      'irreversible apply (scripts/smoke/README.md, "Confirmation"). Set it to the ' +
      'value the server is configured with, or delete this comment by hand.'
    );
  }
  return message;
}

/** One report record for a marked comment that is still on the Page. */
function leak(candidate, reason) {
  return { ...candidate, deleted: false, label: `on ${candidate.host}`, reason };
}

/** One report record for a marked comment that is gone. */
function swept(candidate, alreadyGone) {
  return {
    ...candidate,
    deleted: true,
    ...(alreadyGone ? { label: 'already gone' } : {}),
  };
}

/** The newest posts of the test Page — the objects comments can hang off. */
async function collectHostPosts(ctx, profile) {
  const hosts = [];
  let after;
  for (let page = 0; page < MAX_HOST_PAGES; page += 1) {
    const result = await ctx.callTool('facebook_list_posts', {
      profile,
      edge: 'published_posts',
      limit: PAGE_SIZE,
      ...(after === undefined ? {} : { after }),
    });
    for (const post of ctx.unwrap(result.posts) ?? []) {
      if (typeof post?.id === 'string') {
        hosts.push(post.id);
      }
    }
    after = result.nextCursor ?? undefined;
    if (after === undefined || after === null) {
      break;
    }
  }
  return hosts;
}

/** Collect the marked comments on one host object, replies included. */
async function collectMarked(ctx, { profile, objectId }) {
  const found = [];
  let after;
  for (let page = 0; page < MAX_COMMENT_PAGES; page += 1) {
    const result = await ctx.callTool('facebook_list_comments', {
      profile,
      object_id: objectId,
      // Replies inline, oldest first: a parent is then attempted before its own
      // replies, which turns the replies Graph removes with it into a clean
      // "already gone" instead of a failure.
      filter: 'stream',
      order: 'chronological',
      limit: PAGE_SIZE,
      ...(after === undefined ? {} : { after }),
    });
    for (const comment of ctx.unwrap(result.comments) ?? []) {
      // The comment's own text only. `content` is the rendered taint envelope
      // the marker travels inside; `message` is the plain field it would be if
      // that envelope ever changed shape. `unwrap` covers the object form.
      const text = [ctx.unwrap(comment?.content), comment?.message];
      // Two questions, in this order: may this be touched at all, and which run
      // left it behind. Anything unmarked is someone else's comment — skip it.
      if (!ctx.isMarked(text) || typeof comment?.id !== 'string') {
        continue;
      }
      found.push({
        kind: 'comment',
        id: comment.id,
        nonce: ctx.findMarkerNonce(text),
        host: objectId,
      });
    }
    after = result.nextCursor ?? undefined;
    if (after === undefined || after === null) {
      break;
    }
  }
  return found;
}

registerSweeper({
  id: 'comments',
  title: 'Marked comments on the newest posts of the test Page (replies included)',
  packages: ['reader', 'moderation'],
  sweep: async (ctx) => {
    const profile = ctx.pages.testProfile;
    const items = [];

    // Deduplicated by comment id: the same comment can be reached twice when a
    // host post shows up on two cursor pages of a ranked edge.
    const candidates = new Map();
    for (const host of await collectHostPosts(ctx, profile)) {
      try {
        for (const candidate of await collectMarked(ctx, { profile, objectId: host })) {
          if (!candidates.has(candidate.id)) {
            candidates.set(candidate.id, candidate);
          }
        }
      } catch (err) {
        // Not a leak that can be named, but not a clean Page either: report the
        // host that was never checked rather than a sweep that silently skipped
        // it. The remaining hosts are still swept.
        items.push({
          kind: 'unscanned post',
          id: host,
          deleted: false,
          reason:
            `could not list its comments: ${err instanceof Error ? err.message : String(err)} ` +
            '— a marked comment on this post would have been missed',
        });
      }
    }

    if (candidates.size > 0) {
      const mine = [...candidates.values()].filter(
        (candidate) => candidate.nonce === ctx.nonce,
      ).length;
      ctx.log.step(
        `${candidates.size} marked comment(s) found: ${mine} from this run, ` +
          `${candidates.size - mine} left by an earlier run`,
      );
    }

    let deletions = 0;
    for (const candidate of candidates.values()) {
      if (deletions >= ctx.deleteCap) {
        items.push(
          leak(
            candidate,
            `sweep delete cap (${ctx.deleteCap}) reached — re-run with --sweep-only`,
          ),
        );
        continue;
      }
      deletions += 1;
      try {
        // One id per call, although the verb takes 50: a sweep owes a per-artifact
        // verdict, and a single-id call makes the outcome unambiguous.
        //
        // `marker: 'none'` — this call references EXISTING comments by id and
        // creates nothing, so there is no artifact for a marker to ride on. The
        // test-Page assertion inside applyWrite still applies.
        const { applied } = await ctx.applyWrite(
          'facebook_delete_comment',
          { comment_ids: [candidate.id] },
          { marker: 'none' },
        );
        // CC-MOD-5: the bulk verbs answer with one outcome per id, and this call
        // sent exactly one. A `note` on a success means the comment was already
        // gone (a reply Graph removed together with its parent).
        const outcome = (applied.result?.outcomes ?? [])[0] ?? {};
        items.push(
          outcome.ok === true
            ? swept(candidate, outcome.note !== undefined)
            : leak(candidate, outcome.error ?? 'the server did not report a deletion'),
        );
      } catch (err) {
        items.push(leak(candidate, reasonOf(err)));
      }
    }
    return items;
  },
});
