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

import { CURSOR_EXPIRED_NOTE, DEFAULT_PAGE_LIMIT } from './shared.js';
import {
  CARE_FOLDED_NOTE,
  DEFAULT_POST_LIST_EDGE,
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
