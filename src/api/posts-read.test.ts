// Tests for the post/Reel/reaction READ helpers (task V01, `api` layer).
//
// Covered: edge-name selection and validation, the documented default field
// sets, the hand-off to `fetchPage` (limit/after in, nextCursor out), the
// cursor-expiry note propagation (CC-PAGE-2), the empty-page-with-next case
// (CC-PAGE-1), the ranking-cap honesty note (CC-PUB-3 / UX #4), node
// normalisation, and the two-request reaction read (per-type totals + the
// permission-limited reactor list).
//
// Every Graph call is served by `createFakeFbRequest`; an unstubbed request
// rejects, so each expected call is programmed explicitly. Placeholder tokens
// only — never a real secret in a fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeFbRequest, fbErr, fbOk } from '../core/fakes/index.js';
import type { FakeFbRequest } from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import type { FbRequest, JsonRequest, ParamValue } from '../core/index.js';

import {
  CURSOR_EXPIRED_NOTE,
  DEFAULT_PAGE_LIMIT,
  NO_LIST_RETURNED_NOTE,
} from './shared.js';
import {
  CARE_FOLDED_NOTE,
  DEFAULT_POST_LIST_EDGE,
  EMPTY_POSTS_PAGE_MORE_FOLLOWS_NOTE,
  EMPTY_REELS_PAGE_MORE_FOLLOWS_NOTE,
  POST_DETAIL_FIELDS,
  POST_LIST_EDGES,
  POST_LIST_FIELDS,
  RANKING_CAP_NOTE,
  REACTION_IDENTITY_NOTE,
  REACTION_TYPES,
  REACTION_USER_FIELDS,
  REEL_LIST_FIELDS,
  REELS_EDGE,
  REELS_NOT_LISTED_NOTE,
  getPost,
  getReactions,
  isPostListEdge,
  isReactionType,
  isVisitorContentEdge,
  listPosts,
  listReels,
  normalizeNode,
  normalizeReactionUser,
  reactionSummaryFields,
  resolvePostListEdge,
  resolveReactionType,
} from './posts-read.js';

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const PAGE_ID = '100200300';
const POST_ID = `${PAGE_ID}_555`;
const PAGE_TOKEN = 'EAA-PAGE-PLACEHOLDER';

/** A Graph list page whose `paging.next` carries the opaque `after` cursor. */
function pageWithNext(data: readonly unknown[], after: string): unknown {
  return {
    data,
    paging: {
      next: `https://graph.facebook.com/v23.0/${PAGE_ID}/published_posts?after=${after}`,
      cursors: { after },
    },
  };
}

/** A terminal Graph list page — no `paging.next`, so the listing ends here. */
function lastPage(data: readonly unknown[]): unknown {
  return { data, paging: { cursors: { before: 'b0' } } };
}

/**
 * A page Graph paginates by TIME: `paging.next` exists — so a further page
 * demonstrably exists — but it carries no `after`, so nothing resumable can be
 * extracted from it. Real behaviour on `/feed`, which Graph pages with
 * `until` + `__paging_token`.
 */
function pageWithUnusableNext(data: readonly unknown[]): unknown {
  return {
    data,
    paging: {
      next: `https://graph.facebook.com/v23.0/${PAGE_ID}/feed?until=1700000000&__paging_token=T`,
    },
  };
}

function cursorExpired(): GraphApiError {
  return new GraphApiError('Please provide a valid cursor', {
    code: 100,
    subcode: 33,
    httpStatus: 400,
    action: { category: 'cursor_expired', retryable: false, operatorText: 'restart' },
  });
}

/** Narrow the nth captured request to a JSON request. */
function jsonAt(fb: FakeFbRequest, index: number): JsonRequest {
  const call: FbRequest | undefined = fb.calls[index];
  if (call === undefined || call.protocol !== 'json') {
    throw new Error(
      `expected a json request at index ${String(index)}, got ${call?.protocol ?? 'none'}`,
    );
  }
  return call;
}

/** Read the query params of the nth captured request. */
function paramsAt(fb: FakeFbRequest, index: number): Record<string, ParamValue> {
  return { ...(jsonAt(fb, index).params ?? {}) };
}

/** A summary sub-object as returned by `reactions…limit(0).summary(total_count)`. */
function summary(total: number): unknown {
  return { data: [], summary: { total_count: total } };
}

// ---------------------------------------------------------------------------
// Edge selection & validation
// ---------------------------------------------------------------------------

test('the four post listing edges are exposed and published_posts is the default', () => {
  assert.deepEqual(POST_LIST_EDGES, ['published_posts', 'feed', 'posts', 'tagged']);
  assert.equal(DEFAULT_POST_LIST_EDGE, 'published_posts');
  assert.equal(resolvePostListEdge(undefined), 'published_posts');
  for (const edge of POST_LIST_EDGES) {
    assert.equal(isPostListEdge(edge), true);
    assert.equal(resolvePostListEdge(edge), edge);
  }
});

test('resolvePostListEdge rejects an unknown edge name with a listing of the valid ones', () => {
  assert.equal(isPostListEdge('timeline'), false);
  assert.throws(() => resolvePostListEdge('timeline'), {
    name: 'RangeError',
    message:
      /unknown post listing edge "timeline".*published_posts, feed, posts, tagged/s,
  });
});

test('only feed and tagged are flagged as visitor-authorable content edges', () => {
  assert.equal(isVisitorContentEdge('feed'), true);
  assert.equal(isVisitorContentEdge('tagged'), true);
  assert.equal(isVisitorContentEdge('published_posts'), false);
  assert.equal(isVisitorContentEdge('posts'), false);
});

// ---------------------------------------------------------------------------
// listPosts
// ---------------------------------------------------------------------------

test('listPosts reads published_posts by default with the documented field set', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk(lastPage([{ id: POST_ID, message: 'hello' }])));

  const res = await listPosts(fb.fn, { pageId: PAGE_ID, token: PAGE_TOKEN });

  assert.equal(res.pageId, PAGE_ID);
  assert.equal(res.edge, 'published_posts');
  assert.equal(res.visitorContent, false);
  assert.equal(res.count, 1);
  assert.deepEqual(res.posts, [{ id: POST_ID, message: 'hello' }]);

  const req = jsonAt(fb, 0);
  assert.equal(req.method, 'GET');
  assert.equal(req.host, 'graph');
  assert.equal(req.path, `/${PAGE_ID}/published_posts`);
  assert.equal(req.token, PAGE_TOKEN);
  assert.deepEqual(paramsAt(fb, 0), {
    fields: POST_LIST_FIELDS,
    limit: DEFAULT_PAGE_LIMIT,
  });
  // The field set stays lean but must carry authorship for the feed edges.
  assert.ok(POST_LIST_FIELDS.includes('from{id,name}'));
  assert.ok(POST_LIST_FIELDS.includes('permalink_url'));
});

test('listPosts targets the requested edge and flags visitor-authorable content', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk(lastPage([])));

  const res = await listPosts(fb.fn, { pageId: PAGE_ID, edge: 'feed' });

  assert.equal(res.edge, 'feed');
  assert.equal(res.visitorContent, true);
  assert.equal(jsonAt(fb, 0).path, `/${PAGE_ID}/feed`);
});

test('listPosts rejects an unknown edge before issuing any request', async () => {
  const fb = createFakeFbRequest();

  await assert.rejects(listPosts(fb.fn, { pageId: PAGE_ID, edge: 'wall' }), RangeError);
  assert.equal(fb.calls.length, 0);
});

test('listPosts honours an explicit fields override and page-size limit', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk(lastPage([])));

  await listPosts(fb.fn, { pageId: PAGE_ID, fields: 'id,message', limit: 7 });

  assert.deepEqual(paramsAt(fb, 0), { fields: 'id,message', limit: 7 });
});

test('listPosts hands the cursor to fetchPage and returns the next one', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk(pageWithNext([{ id: 'p1' }], 'CURSOR_2')));

  const res = await listPosts(fb.fn, { pageId: PAGE_ID, after: 'CURSOR_1' });

  assert.equal(paramsAt(fb, 0).after, 'CURSOR_1');
  assert.equal(res.nextCursor, 'CURSOR_2');
  assert.equal(res.truncated, false);
});

test('listPosts never surfaces the token-bearing paging.next URL', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    () => true,
    fbOk(pageWithNext([{ id: 'p1', paging: { next: 'https://x' } }], 'C2')),
  );

  const res = await listPosts(fb.fn, { pageId: PAGE_ID });

  assert.equal(JSON.stringify(res).includes('graph.facebook.com'), false);
  assert.equal(JSON.stringify(res).includes('paging'), false);
});

test('listPosts adds the ranking-cap note once no forward cursor comes back', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk(lastPage([{ id: 'p1' }])));

  const res = await listPosts(fb.fn, { pageId: PAGE_ID });

  assert.equal(res.nextCursor, undefined);
  assert.ok(res.note);
  assert.ok(res.note.includes(RANKING_CAP_NOTE), 'end of listing ≠ full history');
  assert.match(res.note, /~600 posts per year/);
});

test('listPosts never claims the listing ended when the forward cursor was unusable', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk(pageWithUnusableNext([{ id: 'p1' }])));

  const res = await listPosts(fb.fn, { pageId: PAGE_ID, edge: 'feed' });

  // Graph said there IS another page and handed back nothing to reach it, so
  // there is no cursor to return and the listing must not read as terminal.
  assert.equal(res.nextCursor, undefined);
  assert.equal(res.truncated, true);
  // Still capped: `truncated` says the remaining rows are unreachable, the cap
  // note says the history was never fully in reach.
  assert.ok(res.note?.includes(RANKING_CAP_NOTE));
  assert.equal(
    /no further pages|has no more pages|end of the listing/i.test(res.note ?? ''),
    false,
    'the note must not assert completeness it cannot establish',
  );
  assert.match(String(res.note), /partial/i);
});

test('listPosts omits the ranking-cap note while more pages remain', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk(pageWithNext([{ id: 'p1' }], 'C2')));

  const res = await listPosts(fb.fn, { pageId: PAGE_ID });

  assert.equal(res.note?.includes(RANKING_CAP_NOTE), false);
  assert.equal(res.note, REELS_NOT_LISTED_NOTE);
});

test('listPosts always tells the caller Reels live on a different tool', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk(lastPage([])));

  const res = await listPosts(fb.fn, { pageId: PAGE_ID });

  assert.ok(res.note?.includes(REELS_NOT_LISTED_NOTE));
  assert.match(String(res.note), /facebook_list_reels/);
});

test('listPosts tells the caller scheduled posts and drafts are not on any post edge', async () => {
  // The write tools send a timed-out scheduled create to facebook_list_scheduled_posts
  // and a draft to Business Suite precisely because no post edge shows them. A
  // listing whose only in-band exclusion is Reels implies everything else is
  // there, so an absent scheduled post reads as "it was never created".
  for (const edge of POST_LIST_EDGES) {
    const fb = createFakeFbRequest();
    fb.on(() => true, fbOk(lastPage([])));

    const res = await listPosts(fb.fn, { pageId: PAGE_ID, edge });

    assert.match(String(res.note), /scheduled/i, `${edge}: scheduled posts disclosed`);
    assert.match(
      String(res.note),
      /facebook_list_scheduled_posts/,
      `${edge}: queue named`,
    );
    assert.match(String(res.note), /draft/i, `${edge}: drafts disclosed`);
  }
});

test('listPosts keeps an empty page that still has a next cursor as "keep going"', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk(pageWithNext([], 'C9')));

  const res = await listPosts(fb.fn, { pageId: PAGE_ID });

  // CC-PAGE-1: empty data + paging.next is NOT the end, so no cap note.
  assert.equal(res.count, 0);
  assert.equal(res.nextCursor, 'C9');
  assert.equal(res.note?.includes(RANKING_CAP_NOTE), false);
});

test('listPosts propagates the cursor-expiry note ahead of its own notes', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbErr(cursorExpired()));

  const res = await listPosts(fb.fn, { pageId: PAGE_ID, after: 'STALE' });

  assert.equal(res.truncated, true);
  assert.equal(res.count, 0);
  assert.equal(res.nextCursor, undefined);
  assert.ok(res.note?.startsWith(CURSOR_EXPIRED_NOTE));
  // A truncated page is not the end of the listing, so no cap note.
  assert.equal(res.note?.includes(RANKING_CAP_NOTE), false);
  assert.ok(res.note?.includes(REELS_NOT_LISTED_NOTE));
});

test('listPosts lets a non-expiry Graph error propagate untouched', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    () => true,
    fbErr(new GraphApiError('permission denied', { code: 200, httpStatus: 403 })),
  );

  await assert.rejects(listPosts(fb.fn, { pageId: PAGE_ID }), {
    name: 'GraphApiError',
    message: /permission denied/,
  });
});

test('listPosts forwards the abort signal to the request', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk(lastPage([])));
  const controller = new AbortController();

  await listPosts(fb.fn, { pageId: PAGE_ID, signal: controller.signal });

  assert.equal(jsonAt(fb, 0).signal, controller.signal);
});

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

test('normalizeNode flattens the nested count objects into scalars', () => {
  const node = normalizeNode({
    id: 'p1',
    message: 'hi',
    shares: { count: 4 },
    comments: { data: [], summary: { total_count: 12 } },
    reactions: { data: [], summary: { total_count: 33 } },
  });

  assert.deepEqual(node, {
    id: 'p1',
    message: 'hi',
    share_count: 4,
    comment_count: 12,
    reaction_count: 33,
  });
});

test('normalizeNode passes unknown fields through and drops nested paging', () => {
  const node = normalizeNode({
    id: 'p1',
    some_future_field: { a: 1 },
    paging: { next: 'https://graph.facebook.com/...?access_token=SECRET' },
  });

  assert.deepEqual(node, { id: 'p1', some_future_field: { a: 1 } });
});

test('normalizeNode drops the paging of an EXPANDED edge, not just the top level', () => {
  // `attachments{...}` (and any other `fields` expansion) comes back as
  // `{ data, paging }`, so the token-bearing URL sits one level down.
  const node = normalizeNode({
    id: 'p1',
    attachments: {
      data: [{ media_type: 'photo', title: 'x' }],
      paging: {
        cursors: { after: 'A1' },
        next: 'https://graph.facebook.com/v23.0/p1/attachments?access_token=SECRET',
      },
    },
  });

  assert.equal(JSON.stringify(node).includes('access_token'), false);
  assert.equal(JSON.stringify(node).includes('paging'), false);
  // The fixture's paging advertises a further page, so the stripped expansion
  // says so instead of passing its first page off as the whole edge.
  assert.deepEqual(node, {
    id: 'p1',
    attachments: { data: [{ media_type: 'photo', title: 'x' }], has_more: true },
  });
});

test('normalizeNode keeps an expansion that actually returned rows', () => {
  // `comments` / `reactions` / `shares` were dropped unconditionally, because the
  // DEFAULT field sets ask for them as `.limit(0).summary(total_count)` — an
  // empty `data` whose entire content is the count. But `fields` is an OVERRIDE,
  // not a whitelist: ask for `comments{message,from}` and Graph returns the
  // comments themselves, which then vanished on the way out. The caller was
  // handed a post with a `comment_count` and no comments, and told the operator
  // the post had none — about a post whose comments Graph had just delivered.
  const node = normalizeNode({
    id: 'p1',
    comments: {
      data: [{ id: 'c1', message: 'first' }],
      summary: { total_count: 1 },
      paging: {
        next: 'https://graph.facebook.com/v23.0/p1/comments?access_token=SECRET',
      },
    },
  });

  assert.deepEqual(node, {
    id: 'p1',
    comments: {
      data: [{ id: 'c1', message: 'first' }],
      summary: { total_count: 1 },
      // The fixture's paging carries a `next`: Graph advertised more rows.
      has_more: true,
    },
    comment_count: 1,
  });
  // The kept expansion still crosses this boundary without its token-bearing
  // nested paging (C3) — that strip is what makes keeping it safe at all.
  assert.equal(JSON.stringify(node).includes('access_token'), false);
});

test('normalizeNode tolerates a missing id and malformed count objects', () => {
  assert.deepEqual(normalizeNode({ message: 'no id' }), { id: '', message: 'no id' });
  assert.deepEqual(normalizeNode(undefined), { id: '' });
  assert.deepEqual(normalizeNode('nonsense'), { id: '' });
  assert.deepEqual(
    normalizeNode({ id: 'p1', shares: 'nope', comments: { summary: 7 } }),
    {
      id: 'p1',
    },
  );
});

test('an own `__proto__` key on a node becomes a field, never the record prototype', () => {
  // `JSON.parse` is exactly how a Graph response reaches the shaper, and it makes
  // `__proto__` an OWN enumerable property — so the key loop hands it to a plain
  // assignment, which runs the inherited setter and re-parents the record instead
  // of storing a field. The caller then sees a node silently missing a field it
  // was told the API returned.
  const node = normalizeNode(JSON.parse('{"id":"p1","__proto__":{"injected":true}}'));
  assert.equal(
    Object.getPrototypeOf(node),
    Object.prototype,
    'record must keep its prototype',
  );
  assert.equal((node as Record<string, unknown>).injected, undefined);
  assert.deepEqual(Object.keys(node).sort(), ['__proto__', 'id']);
});

test('an own `__proto__` key NESTED inside a node is a field too', () => {
  // The same loop runs at every depth through `stripNestedPaging`.
  const node = normalizeNode(
    JSON.parse('{"id":"p1","from":{"name":"Page","__proto__":{"injected":true}}}'),
  );
  const from = node.from as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(from), Object.prototype);
  assert.equal(from.injected, undefined);
  assert.deepEqual(Object.keys(from).sort(), ['__proto__', 'name']);
});

test('normalizeNode does not mutate its input', () => {
  const raw = { id: 'p1', shares: { count: 2 } };
  normalizeNode(raw);
  assert.deepEqual(raw, { id: 'p1', shares: { count: 2 } });
});

test('normalizeReactionUser keeps only the three documented fields', () => {
  assert.deepEqual(normalizeReactionUser({ id: 'u1', name: 'Ann', type: 'LOVE', x: 1 }), {
    id: 'u1',
    name: 'Ann',
    type: 'LOVE',
  });
  assert.deepEqual(normalizeReactionUser({ type: 'LIKE' }), { type: 'LIKE' });
  assert.deepEqual(normalizeReactionUser(null), {});
});

// ---------------------------------------------------------------------------
// getPost
// ---------------------------------------------------------------------------

test('getPost fetches one node with the documented detail fields', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    (req) => req.path === `/${POST_ID}`,
    fbOk({
      id: POST_ID,
      message: 'body',
      permalink_url: 'https://www.facebook.com/x',
      shares: { count: 2 },
      comments: { summary: { total_count: 5 } },
    }),
  );

  const res = await getPost(fb.fn, { postId: POST_ID, token: PAGE_TOKEN });

  assert.equal(res.postId, POST_ID);
  assert.deepEqual(res.post, {
    id: POST_ID,
    message: 'body',
    permalink_url: 'https://www.facebook.com/x',
    share_count: 2,
    comment_count: 5,
  });
  const req = jsonAt(fb, 0);
  assert.equal(req.method, 'GET');
  assert.equal(req.path, `/${POST_ID}`);
  assert.equal(req.token, PAGE_TOKEN);
  assert.deepEqual(paramsAt(fb, 0), { fields: POST_DETAIL_FIELDS });
  // Counts arrive as summaries so no comment/reaction bodies are pulled in.
  assert.ok(POST_DETAIL_FIELDS.includes('comments.limit(0).summary(total_count)'));
  assert.ok(POST_DETAIL_FIELDS.includes('reactions.limit(0).summary(total_count)'));
  assert.ok(POST_DETAIL_FIELDS.includes('attachments{'));
});

test('getPost honours a fields override', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk({ id: POST_ID }));

  await getPost(fb.fn, { postId: POST_ID, fields: 'id,created_time' });

  assert.deepEqual(paramsAt(fb, 0), { fields: 'id,created_time' });
});

test('getPost returns the expanded rows a fields override asked for', async () => {
  // The tool description invites `fields` overrides; asking for the reactor rows
  // and getting back a post without them is a silent no-op the caller cannot
  // distinguish from a post nobody reacted to.
  const fb = createFakeFbRequest();
  fb.on(
    () => true,
    fbOk({
      id: POST_ID,
      message: 'body',
      reactions: { data: [{ id: 'u1', type: 'LOVE' }] },
    }),
  );

  const res = await getPost(fb.fn, {
    postId: POST_ID,
    fields: 'id,message,reactions{id,type}',
  });

  assert.deepEqual(res.post, {
    id: POST_ID,
    message: 'body',
    reactions: { data: [{ id: 'u1', type: 'LOVE' }] },
  });
});

test('getPost says the default comment_count counts top-level comments only', async () => {
  // The default field set asks for `comments.limit(0).summary(total_count)` with
  // no filter, i.e. Graph's `toplevel` view, whose total_count leaves replies
  // out. Emitted bare, `comment_count: 5` reads as "5 comments" on a post whose
  // thread holds 12.
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk({ id: POST_ID, comments: { summary: { total_count: 5 } } }));

  const res = await getPost(fb.fn, { postId: POST_ID });

  assert.equal(res.post.comment_count, 5);
  assert.match(String(res.note), /top-level/i);
  assert.match(String(res.note), /repl(y|ies)/i);
  assert.match(String(res.note), /facebook_list_comments/);
});

test('getPost adds no comment-count note when no count or a fields override came back', async () => {
  const bare = createFakeFbRequest();
  bare.on(() => true, fbOk({ id: POST_ID, message: 'body' }));
  // No top-level wording without a count; the missing counts are reported as
  // unknown instead (see "getPost marks a default-set count … as unknown").
  const bareNote = String((await getPost(bare.fn, { postId: POST_ID })).note);
  assert.equal(/top-level/i.test(bareNote), false);
  assert.match(bareNote, /UNKNOWN, not zero/);

  // An override chose its own comments view; this layer cannot say what it counts.
  const override = createFakeFbRequest();
  override.on(
    () => true,
    fbOk({ id: POST_ID, comments: { summary: { total_count: 9 } } }),
  );
  const res = await getPost(override.fn, {
    postId: POST_ID,
    fields: 'id,comments.filter(stream).limit(0).summary(total_count)',
  });
  assert.equal(res.post.comment_count, 9);
  assert.equal(res.note, undefined);
});

test('getPost propagates a Graph error to the caller', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    () => true,
    fbErr(new GraphApiError('Unsupported get request', { code: 100, httpStatus: 400 })),
  );

  await assert.rejects(getPost(fb.fn, { postId: POST_ID }), {
    name: 'GraphApiError',
  });
});

test('getPost refuses a 200 whose body is not a node instead of reporting an empty post', async () => {
  // Graph answers some reads of an object the token cannot see with a bare
  // `false`, and a proxy can hand back an empty 200. Normalised, either becomes
  // `{ id: "" }` — a "successful" read of a post with no content at all, which
  // the model then reports as an empty post rather than as a failed lookup.
  for (const bodyValue of [false, null, undefined, 'OK', []]) {
    const fb = createFakeFbRequest();
    fb.on(() => true, fbOk(bodyValue));

    await assert.rejects(
      getPost(fb.fn, { postId: POST_ID }),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError, `body ${JSON.stringify(bodyValue)}`);
        assert.equal(err.action?.category, 'not_found');
        assert.equal(err.action?.retryable, false);
        assert.ok(err.message.includes(POST_ID), 'the error names the id it looked up');
        return true;
      },
      `body ${JSON.stringify(bodyValue) ?? 'undefined'} must not read as a post`,
    );
  }
});

// ---------------------------------------------------------------------------
// listReels
// ---------------------------------------------------------------------------

test('listReels reads the video_reels edge with the video field set', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk(lastPage([{ id: 'r1', title: 'Reel one', length: 12.5 }])));

  const res = await listReels(fb.fn, { pageId: PAGE_ID, token: PAGE_TOKEN });

  assert.equal(res.pageId, PAGE_ID);
  assert.equal(res.count, 1);
  assert.deepEqual(res.reels, [{ id: 'r1', title: 'Reel one', length: 12.5 }]);
  assert.equal(jsonAt(fb, 0).path, `/${PAGE_ID}/${REELS_EDGE}`);
  assert.equal(REELS_EDGE, 'video_reels');
  assert.deepEqual(paramsAt(fb, 0), {
    fields: REEL_LIST_FIELDS,
    limit: DEFAULT_PAGE_LIMIT,
  });
});

test('listReels paginates like the post edges but carries no ranking-cap note', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk(pageWithNext([{ id: 'r1' }], 'RC2')));

  const res = await listReels(fb.fn, { pageId: PAGE_ID, after: 'RC1', limit: 50 });

  assert.equal(paramsAt(fb, 0).after, 'RC1');
  assert.equal(paramsAt(fb, 0).limit, 50);
  assert.equal(res.nextCursor, 'RC2');
  assert.equal(res.truncated, false);
  assert.equal(res.note, undefined);
});

test('listReels reports an expired cursor as a truncated page with a restart note', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbErr(cursorExpired()));

  const res = await listReels(fb.fn, { pageId: PAGE_ID, after: 'STALE' });

  assert.equal(res.truncated, true);
  assert.equal(res.count, 0);
  assert.equal(res.note, CURSOR_EXPIRED_NOTE);
});

test('listReels: an empty page with a forward cursor says more pages follow', async () => {
  // `count: 0` beside a cursor reads as "this Page has no Reels" when the next
  // page is one call away (CC-PAGE-1) — the post listing already says so.
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk(pageWithNext([], 'RC2')));

  const res = await listReels(fb.fn, { pageId: PAGE_ID });

  assert.equal(res.count, 0);
  assert.equal(res.nextCursor, 'RC2');
  assert.equal(res.note, EMPTY_REELS_PAGE_MORE_FOLLOWS_NOTE);
});

test('listReels: an empty terminal page carries no more-follows note', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk(lastPage([])));

  const res = await listReels(fb.fn, { pageId: PAGE_ID });

  assert.equal(res.count, 0);
  assert.equal(res.note, undefined);
});

test('listPosts: a 200 answer with no list is not reported as a Page with no posts', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk({}));

  const res = await listPosts(fb.fn, { pageId: PAGE_ID });

  assert.equal(res.count, 0);
  assert.equal(res.truncated, true, 'nothing was read, so the listing is not complete');
  assert.ok(res.note?.includes(NO_LIST_RETURNED_NOTE), res.note);
});

test('listReels honours a fields override', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk(lastPage([])));

  await listReels(fb.fn, { pageId: PAGE_ID, fields: 'id,permalink_url' });

  assert.equal(paramsAt(fb, 0).fields, 'id,permalink_url');
});

// ---------------------------------------------------------------------------
// Reaction types & summary field expansion
// ---------------------------------------------------------------------------

test('the seven reaction types are exposed and validated', () => {
  assert.deepEqual(REACTION_TYPES, [
    'LIKE',
    'LOVE',
    'CARE',
    'HAHA',
    'WOW',
    'SAD',
    'ANGRY',
  ]);
  assert.equal(resolveReactionType(undefined), undefined);
  for (const type of REACTION_TYPES) {
    assert.equal(isReactionType(type), true);
    assert.equal(resolveReactionType(type), type);
  }
  assert.equal(isReactionType('THANKFUL'), false);
  assert.throws(() => resolveReactionType('THANKFUL'), {
    name: 'RangeError',
    message: /unknown reaction type "THANKFUL"/,
  });
});

test('reactionSummaryFields asks for the overall total plus one alias per type', () => {
  assert.equal(
    reactionSummaryFields(['LOVE']),
    'reactions.limit(0).summary(total_count).as(total),' +
      'reactions.type(LOVE).limit(0).summary(total_count).as(love)',
  );
  const all = reactionSummaryFields(REACTION_TYPES);
  assert.equal(all.split(',').length, REACTION_TYPES.length + 1);
  // limit(0) keeps the user arrays empty — only the summaries are wanted.
  assert.equal(all.includes('.limit(0).summary(total_count)'), true);
});

// ---------------------------------------------------------------------------
// getReactions
// ---------------------------------------------------------------------------

test('getReactions reads all per-type totals in one call, then the reactor list', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    (req) => req.path === `/${POST_ID}`,
    fbOk({ id: POST_ID, total: summary(40), like: summary(30), love: summary(10) }),
  );
  fb.on(
    (req) => req.path === `/${POST_ID}/reactions`,
    fbOk(lastPage([{ id: 'u1', name: 'Ann', type: 'LOVE' }])),
  );

  const res = await getReactions(fb.fn, { postId: POST_ID, token: PAGE_TOKEN });

  assert.equal(fb.calls.length, 2, 'exactly two requests: totals, then the list');
  assert.equal(res.postId, POST_ID);
  assert.equal(res.type, undefined);
  assert.equal(res.total, 40);
  assert.deepEqual(res.totals, { LIKE: 30, LOVE: 10 });
  assert.deepEqual(res.users, [{ id: 'u1', name: 'Ann', type: 'LOVE' }]);
  assert.equal(res.userCount, 1);
  assert.equal(res.truncated, false);

  // 1: the node read carries every type alias.
  assert.equal(jsonAt(fb, 0).path, `/${POST_ID}`);
  assert.equal(paramsAt(fb, 0).fields, reactionSummaryFields(REACTION_TYPES));
  assert.equal(jsonAt(fb, 0).token, PAGE_TOKEN);
  // 2: the reactor list is a paginated edge read, unfiltered.
  assert.equal(jsonAt(fb, 1).path, `/${POST_ID}/reactions`);
  assert.deepEqual(paramsAt(fb, 1), {
    fields: REACTION_USER_FIELDS,
    limit: DEFAULT_PAGE_LIMIT,
  });
});

test('getReactions with a type filter narrows both the totals and the list', async () => {
  const fb = createFakeFbRequest();
  fb.on((req) => req.path === `/${POST_ID}`, fbOk({ id: POST_ID, love: summary(9) }));
  fb.on((req) => req.path === `/${POST_ID}/reactions`, fbOk(lastPage([])));

  const res = await getReactions(fb.fn, { postId: POST_ID, type: 'LOVE', limit: 5 });

  assert.equal(res.type, 'LOVE');
  assert.deepEqual(res.totals, { LOVE: 9 });
  assert.equal(res.total, undefined, 'no overall summary in the response ⇒ absent');
  assert.equal(paramsAt(fb, 0).fields, reactionSummaryFields(['LOVE']));
  assert.deepEqual(paramsAt(fb, 1), {
    fields: REACTION_USER_FIELDS,
    type: 'LOVE',
    limit: 5,
  });
});

test('getReactions always warns that the reactor list is permission-limited', async () => {
  const fb = createFakeFbRequest();
  fb.on((req) => req.path === `/${POST_ID}`, fbOk({ id: POST_ID, love: summary(1200) }));
  fb.on((req) => req.path === `/${POST_ID}/reactions`, fbOk(lastPage([])));

  const res = await getReactions(fb.fn, { postId: POST_ID, type: 'LOVE' });

  assert.ok(res.note?.includes(REACTION_IDENTITY_NOTE));
  assert.equal(res.userCount, 0);
  assert.equal(res.totals.LOVE, 1200, 'totals are trustworthy even with an empty list');
});

test('getReactions discloses the CARE-into-LIKE fold whenever a LIKE total is involved', async () => {
  const fb = createFakeFbRequest();
  fb.on((req) => req.path === `/${POST_ID}`, fbOk({ id: POST_ID }));
  fb.on((req) => req.path === `/${POST_ID}/reactions`, fbOk(lastPage([])));

  const unfiltered = await getReactions(fb.fn, { postId: POST_ID });
  assert.ok(unfiltered.note?.includes(CARE_FOLDED_NOTE));

  fb.reset();
  fb.on((req) => req.path === `/${POST_ID}`, fbOk({ id: POST_ID }));
  fb.on((req) => req.path === `/${POST_ID}/reactions`, fbOk(lastPage([])));
  const care = await getReactions(fb.fn, { postId: POST_ID, type: 'CARE' });
  assert.ok(care.note?.includes(CARE_FOLDED_NOTE));

  fb.reset();
  fb.on((req) => req.path === `/${POST_ID}`, fbOk({ id: POST_ID }));
  fb.on((req) => req.path === `/${POST_ID}/reactions`, fbOk(lastPage([])));
  const haha = await getReactions(fb.fn, { postId: POST_ID, type: 'HAHA' });
  assert.equal(haha.note?.includes(CARE_FOLDED_NOTE), false);
});

test('getReactions tolerates missing or malformed summaries', async () => {
  const fb = createFakeFbRequest();
  fb.on((req) => req.path === `/${POST_ID}`, fbOk({ id: POST_ID, like: { summary: 3 } }));
  fb.on((req) => req.path === `/${POST_ID}/reactions`, fbOk({}));

  const res = await getReactions(fb.fn, { postId: POST_ID });

  assert.deepEqual(res.totals, {});
  assert.equal(res.total, undefined);
  assert.deepEqual(res.users, []);
  assert.equal(res.userCount, 0);
});

test('getReactions carries the cursor through the reactor list and returns the next one', async () => {
  const fb = createFakeFbRequest();
  fb.on((req) => req.path === `/${POST_ID}`, fbOk({ id: POST_ID, total: summary(2) }));
  fb.on(
    (req) => req.path === `/${POST_ID}/reactions`,
    fbOk(pageWithNext([{ id: 'u1', type: 'LIKE' }], 'RX2')),
  );

  const res = await getReactions(fb.fn, { postId: POST_ID, after: 'RX1' });

  assert.equal(paramsAt(fb, 1).after, 'RX1');
  assert.equal(res.nextCursor, 'RX2');
});

test('getReactions reports an expired reactor cursor as truncated with a restart note', async () => {
  const fb = createFakeFbRequest();
  fb.on((req) => req.path === `/${POST_ID}`, fbOk({ id: POST_ID, total: summary(2) }));
  fb.on((req) => req.path === `/${POST_ID}/reactions`, fbErr(cursorExpired()));

  const res = await getReactions(fb.fn, { postId: POST_ID, after: 'STALE' });

  assert.equal(res.truncated, true);
  assert.equal(res.total, 2, 'the totals survive an expired reactor cursor');
  assert.ok(res.note?.startsWith(CURSOR_EXPIRED_NOTE));
});

test('getReactions rejects an unknown type before issuing any request', async () => {
  const fb = createFakeFbRequest();

  await assert.rejects(
    getReactions(fb.fn, { postId: POST_ID, type: 'THANKFUL' }),
    RangeError,
  );
  assert.equal(fb.calls.length, 0);
});

test('getReactions does not fetch the reactor list when the totals call fails', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    (req) => req.path === `/${POST_ID}`,
    fbErr(new GraphApiError('Unsupported get request', { code: 100, httpStatus: 400 })),
  );

  await assert.rejects(getReactions(fb.fn, { postId: POST_ID }), {
    name: 'GraphApiError',
  });
  assert.equal(fb.calls.length, 1);
});

test('getReactions refuses a 200 whose totals body is not a node, before reading the reactor list', async () => {
  // A bare `false` for the totals read means Graph showed nothing of the post.
  // Tolerating it yields `totals: {}` beside an empty reactor list — which the
  // model, told to trust the totals, reports as "no reactions".
  const fb = createFakeFbRequest();
  fb.on((req) => req.path === `/${POST_ID}`, fbOk(false));
  fb.on((req) => req.path === `/${POST_ID}/reactions`, fbOk(lastPage([])));

  await assert.rejects(getReactions(fb.fn, { postId: POST_ID }), (err: unknown) => {
    assert.ok(err instanceof GraphApiError);
    assert.equal(err.action?.category, 'not_found');
    return true;
  });
  assert.equal(fb.calls.length, 1, 'the reactor list is not read for an unseen post');
});

test('getReactions marks totals Graph did not report as unknown, never as zero', async () => {
  // Unfiltered: the overall total and four of the seven per-type totals are
  // missing from the node. Absent keys next to an empty reactor list otherwise
  // read as "nobody reacted", which is a claim nothing on the wire made.
  const fb = createFakeFbRequest();
  fb.on(
    (req) => req.path === `/${POST_ID}`,
    fbOk({ id: POST_ID, like: summary(3), love: summary(1), wow: summary(0) }),
  );
  fb.on((req) => req.path === `/${POST_ID}/reactions`, fbOk(lastPage([])));

  const res = await getReactions(fb.fn, { postId: POST_ID });

  assert.deepEqual(res.totals, { LIKE: 3, LOVE: 1, WOW: 0 });
  assert.match(res.note ?? '', /unknown, not zero/i);
  assert.match(res.note ?? '', /overall total/);
  for (const missing of ['CARE', 'HAHA', 'SAD', 'ANGRY']) {
    assert.match(res.note ?? '', new RegExp(`\\b${missing}\\b`), `${missing} is named`);
  }
  assert.doesNotMatch(res.note ?? '', /\bWOW\b/, 'a reported 0 is a real 0');

  // Filtered: the one requested total missing is named too.
  fb.reset();
  fb.on((req) => req.path === `/${POST_ID}`, fbOk({ id: POST_ID }));
  fb.on((req) => req.path === `/${POST_ID}/reactions`, fbOk(lastPage([])));
  const angry = await getReactions(fb.fn, { postId: POST_ID, type: 'ANGRY' });
  assert.deepEqual(angry.totals, {});
  assert.match(angry.note ?? '', /unknown, not zero/i);
  assert.match(angry.note ?? '', /\bANGRY\b/);
});

test('getReactions adds no unknown-totals note when every requested total came back', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    (req) => req.path === `/${POST_ID}`,
    fbOk({
      id: POST_ID,
      total: summary(4),
      ...Object.fromEntries(REACTION_TYPES.map((t) => [t.toLowerCase(), summary(0)])),
    }),
  );
  fb.on((req) => req.path === `/${POST_ID}/reactions`, fbOk(lastPage([])));
  const all = await getReactions(fb.fn, { postId: POST_ID });
  assert.doesNotMatch(all.note ?? '', /unknown/i);

  // A filtered read does not need the all-types figure, so its absence is no gap.
  fb.reset();
  fb.on((req) => req.path === `/${POST_ID}`, fbOk({ id: POST_ID, love: summary(9) }));
  fb.on((req) => req.path === `/${POST_ID}/reactions`, fbOk(lastPage([])));
  const love = await getReactions(fb.fn, { postId: POST_ID, type: 'LOVE' });
  assert.doesNotMatch(love.note ?? '', /unknown/i);
});

// ---------------------------------------------------------------------------
// Expanded edges that Graph paginated
// ---------------------------------------------------------------------------

/** An expansion Graph cut at its first page: rows plus a `paging.next`. */
function firstPageOfExpansion(rows: readonly unknown[]): unknown {
  return {
    data: rows,
    paging: {
      cursors: { before: 'B', after: 'A' },
      next: 'https://graph.facebook.com/v23.0/p1/comments?access_token=SECRET&after=A',
    },
  };
}

test('getPost says when an expanded edge returned only its first page of rows', async () => {
  // `fields: "comments{message}"` returns Graph's first page of comments (25 by
  // default) with a `paging.next`. Stripping that paging (C3) is required, but
  // stripping it silently hands the caller 25 comments that read as the whole
  // thread — the model then reports "this post has 25 comments".
  const fb = createFakeFbRequest();
  fb.on(
    () => true,
    fbOk({
      id: POST_ID,
      comments: firstPageOfExpansion([
        { id: 'c1', message: 'a' },
        { id: 'c2', message: 'b' },
      ]),
    }),
  );

  const res = await getPost(fb.fn, { postId: POST_ID, fields: 'id,comments{message}' });

  const comments = res.post.comments as Record<string, unknown>;
  assert.equal(comments.has_more, true);
  assert.match(String(res.note), /comments/);
  assert.match(String(res.note), /first page/i);
  assert.equal(JSON.stringify(res).includes('SECRET'), false);
});

test('listPosts says when a row’s expanded edge returned only its first page', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    () => true,
    fbOk(
      lastPage([
        { id: 'p1', comments: firstPageOfExpansion([{ id: 'c1', message: 'a' }]) },
        { id: 'p2', message: 'plain' },
      ]),
    ),
  );

  const res = await listPosts(fb.fn, { pageId: PAGE_ID, fields: 'id,comments{message}' });

  const comments = res.posts[0]?.comments as Record<string, unknown>;
  assert.equal(comments.has_more, true);
  assert.match(String(res.note), /first page/i);
  assert.equal(res.posts[1]?.has_more, undefined);
});

test('an expansion Graph returned in full carries no has_more marker and no note', async () => {
  // Regression guard: no `paging.next` ⇒ the rows are the whole expansion.
  const fb = createFakeFbRequest();
  fb.on(
    () => true,
    fbOk({
      id: POST_ID,
      comments: {
        data: [{ id: 'c1' }],
        paging: { cursors: { before: 'B', after: 'A' } },
      },
    }),
  );

  const res = await getPost(fb.fn, { postId: POST_ID, fields: 'id,comments{message}' });

  assert.deepEqual(res.post.comments, { data: [{ id: 'c1' }] });
  assert.equal(res.note, undefined);
});

test('getPost marks a default-set count Graph did not report as unknown, never as zero', async () => {
  // The default field set asks for both summaries. Graph answers a post with no
  // comments with `summary.total_count: 0`, so a MISSING `comments` means the
  // figure was not reported — typically withheld from this token. Emitted as a
  // post with simply no `comment_count`, it reads as "no comments", the same
  // misreading getReactions already guards against for its totals.
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk({ id: POST_ID, message: 'body', shares: { count: 1 } }));

  const res = await getPost(fb.fn, { postId: POST_ID });

  assert.equal(res.post.comment_count, undefined);
  assert.equal(res.post.reaction_count, undefined);
  assert.match(String(res.note), /comment_count, reaction_count/);
  assert.match(String(res.note), /UNKNOWN, not zero/);
});

test('getPost names only the default-set count that is missing', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    () => true,
    fbOk({ id: POST_ID, reactions: { data: [], summary: { total_count: 0 } } }),
  );

  const res = await getPost(fb.fn, { postId: POST_ID });

  assert.equal(res.post.reaction_count, 0, 'a reported zero stays a zero');
  assert.match(String(res.note), /did not report comment_count:/);
  assert.equal(String(res.note).includes('reaction_count'), false);
});

test('listPosts says an empty page with a forward cursor is not the end of the posts', async () => {
  // CC-PAGE-1: Graph can hand back `data: []` next to `paging.next`. Bare, that
  // is `count: 0` beside a note that ends "a post missing here may still exist
  // as a scheduled post or a draft" — which reads as "this Page has no posts".
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk(pageWithNext([], 'C9')));

  const res = await listPosts(fb.fn, { pageId: PAGE_ID });

  assert.equal(res.count, 0);
  assert.equal(res.nextCursor, 'C9');
  assert.ok(res.note?.startsWith(EMPTY_POSTS_PAGE_MORE_FOLLOWS_NOTE), res.note);
});

test('listPosts adds no more-follows note to a non-empty page or a terminal empty page', async () => {
  const withRows = createFakeFbRequest();
  withRows.on(() => true, fbOk(pageWithNext([{ id: POST_ID }], 'C1')));
  const a = await listPosts(withRows.fn, { pageId: PAGE_ID });
  assert.equal(a.note?.includes(EMPTY_POSTS_PAGE_MORE_FOLLOWS_NOTE), false);

  const terminal = createFakeFbRequest();
  terminal.on(() => true, fbOk(lastPage([])));
  const b = await listPosts(terminal.fn, { pageId: PAGE_ID });
  assert.equal(b.note?.includes(EMPTY_POSTS_PAGE_MORE_FOLLOWS_NOTE), false);
});
