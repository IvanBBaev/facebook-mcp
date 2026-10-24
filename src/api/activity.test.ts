// Tests for "activity since" (v2 insights F3): the pure window / mark helpers
// and `collectActivity` against a routed fake Graph — the strict `since <
// time ≤ horizon` cutoff, the stop-at-first-older rule, the budgets and the
// per-section failure isolation. Placeholder tokens only.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFakeFbRequest,
  fbErr,
  fbOk,
  type FakeFbRequest,
} from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import type { FbRequest } from '../core/index.js';
import {
  ACTIVITY_DEFAULT_LOOKBACK_MS,
  ACTIVITY_MAX_COMMENT_CALLS,
  checkActivitySince,
  collectActivity,
  inActivityWindow,
  isSectionFailure,
  planMarkAdvance,
  resolveActivitySince,
  type ActivityOptions,
  type CommentsCollected,
  type ConversationsCollected,
} from './activity.js';

const PAGE_ID = '1234567890';
const PAGE_TOKEN = 'EAA-PAGE-TOKEN-PLACEHOLDER';
const NOW = Date.parse('2026-10-24T12:00:00Z');
const SINCE = Date.parse('2026-10-24T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const iso = (ms: number): string => new Date(ms).toISOString();
/** Graph's `+0000` time format. */
const graphTime = (ms: number): string => iso(ms).replace(/\.\d{3}Z$/, '+0000');

function param(req: FbRequest, key: string): unknown {
  return req.protocol === 'json' ? req.params?.[key] : undefined;
}

function graphError(code: number): GraphApiError {
  return new GraphApiError(`(#${String(code)}) failure`, { code, httpStatus: 400 });
}

function withNext(data: unknown[], cursor: string): unknown {
  return {
    data,
    paging: {
      cursors: { after: cursor },
      next: `https://graph.facebook.com/v26.0/x?after=${cursor}`,
    },
  };
}

function comment(id: string, ms: number, extra: Record<string, unknown> = {}): unknown {
  return {
    id,
    message: `body ${id}`,
    created_time: graphTime(ms),
    from: { id: '42', name: `Author ${id}` },
    like_count: 0,
    comment_count: 0,
    ...extra,
  };
}

function conversation(id: string, ms: number, unread = 0): unknown {
  return {
    id,
    updated_time: graphTime(ms),
    unread_count: unread,
    message_count: 3,
    can_reply: true,
    snippet: `snippet ${id}`,
    participants: { data: [{ id: '42', name: `Person ${id}` }] },
  };
}

function options(overrides: Partial<ActivityOptions> = {}): ActivityOptions {
  return {
    pageId: PAGE_ID,
    token: PAGE_TOKEN,
    commentsSinceMs: SINCE,
    conversationsSinceMs: SINCE,
    horizonMs: NOW,
    posts: 10,
    maxComments: 50,
    includeComments: true,
    includeConversations: true,
    ...overrides,
  };
}

const isPosts = (req: FbRequest): boolean => req.path === `/${PAGE_ID}/published_posts`;
const isConversations = (req: FbRequest): boolean =>
  req.path === `/${PAGE_ID}/conversations`;
const commentsOf =
  (postId: string) =>
  (req: FbRequest): boolean =>
    req.path === `/${postId}/comments`;

function servePosts(fb: FakeFbRequest, ids: readonly string[]): void {
  fb.on(
    isPosts,
    fbOk({ data: ids.map((id) => ({ id, created_time: graphTime(SINCE) })) }),
  );
}

function asComments(value: unknown): CommentsCollected {
  assert.ok(!isSectionFailure(value), 'comments section succeeded');
  return value as CommentsCollected;
}

function asConversations(value: unknown): ConversationsCollected {
  assert.ok(!isSectionFailure(value), 'conversations section succeeded');
  return value as ConversationsCollected;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('inActivityWindow: strict on since, inclusive on horizon', () => {
  assert.equal(inActivityWindow(SINCE, SINCE, NOW), false);
  assert.equal(inActivityWindow(SINCE + 1, SINCE, NOW), true);
  assert.equal(inActivityWindow(NOW, SINCE, NOW), true);
  assert.equal(inActivityWindow(NOW + 1, SINCE, NOW), false);
});

test('checkActivitySince: rejects the future and more than 90 days back', () => {
  assert.equal(checkActivitySince(iso(SINCE), NOW), SINCE);
  assert.equal(checkActivitySince(iso(NOW - 90 * DAY), NOW), NOW - 90 * DAY);
  for (const bad of [iso(NOW + 1), iso(NOW - 90 * DAY - 1), 'yesterday']) {
    assert.throws(
      () => checkActivitySince(bad, NOW),
      (err: unknown) => err instanceof GraphApiError && err.code === 100,
      bad,
    );
  }
});

test('resolveActivitySince: argument, per-section stored marks, default', () => {
  const both = ['comments', 'conversations'] as const;
  const arg = resolveActivitySince({
    sinceMs: SINCE,
    stored: undefined,
    nowMs: NOW,
    sections: both,
  });
  assert.equal(arg.sinceSource, 'argument');
  assert.equal(arg.commentsSinceMs, SINCE);
  assert.equal(arg.conversationsSinceMs, SINCE);

  const none = resolveActivitySince({ stored: undefined, nowMs: NOW, sections: both });
  assert.equal(none.sinceSource, 'default_24h');
  assert.equal(none.commentsSinceMs, NOW - ACTIVITY_DEFAULT_LOOKBACK_MS);
  assert.deepEqual(none.notes, []);

  const stored = resolveActivitySince({
    stored: { commentsSeenAt: iso(SINCE), conversationsSeenAt: iso(SINCE - 1000) },
    nowMs: NOW,
    sections: both,
  });
  assert.equal(stored.sinceSource, 'stored');
  assert.equal(stored.commentsSinceMs, SINCE);
  assert.equal(stored.conversationsSinceMs, SINCE - 1000);
});

test('resolveActivitySince: unreadable, too-old and future marks degrade with a note', () => {
  const sections = ['comments', 'conversations'] as const;
  const unreadable = resolveActivitySince({ stored: 'unreadable', nowMs: NOW, sections });
  assert.equal(unreadable.sinceSource, 'default_24h');
  assert.equal(unreadable.notes.length, 1);

  const old = resolveActivitySince({
    stored: { commentsSeenAt: iso(NOW - 200 * DAY) },
    nowMs: NOW,
    sections,
  });
  assert.equal(old.sinceSource, 'stored');
  assert.equal(old.commentsSinceMs, NOW - 90 * DAY);
  assert.equal(old.conversationsSinceMs, NOW - ACTIVITY_DEFAULT_LOOKBACK_MS);
  assert.equal(old.notes.length, 1);

  const future = resolveActivitySince({
    stored: { commentsSeenAt: iso(NOW + DAY) },
    nowMs: NOW,
    sections,
  });
  assert.equal(future.sinceSource, 'default_24h');
  assert.equal(future.commentsSinceMs, NOW - ACTIVITY_DEFAULT_LOOKBACK_MS);
  assert.equal(future.notes.length, 1);
});

test('planMarkAdvance: only complete sections advance, to the horizon', () => {
  const plan = planMarkAdvance({
    sinceSource: 'stored',
    stored: { commentsSeenAt: iso(SINCE), conversationsSeenAt: iso(SINCE) },
    horizonMs: NOW,
    sections: {
      comments: { complete: true, truncated: false },
      conversations: { complete: false, truncated: true },
    },
  });
  assert.deepEqual(plan.marks, { commentsSeenAt: iso(NOW), updatedAt: iso(NOW) });
  assert.equal(plan.notes.length, 1, 'the truncated section says why it kept its mark');

  const failed = planMarkAdvance({
    sinceSource: 'stored',
    stored: undefined,
    horizonMs: NOW,
    sections: { comments: { complete: false, truncated: false } },
  });
  assert.equal(failed.marks, undefined);
});

test('planMarkAdvance: an explicit since later than the stored mark does not advance', () => {
  const later = planMarkAdvance({
    sinceSource: 'argument',
    argumentSinceMs: SINCE + 1000,
    stored: { commentsSeenAt: iso(SINCE) },
    horizonMs: NOW,
    sections: {
      comments: { complete: true, truncated: false },
      conversations: { complete: true, truncated: false },
    },
  });
  // Comments keep their mark (the gap was never read); conversations had none.
  assert.deepEqual(later.marks, { conversationsSeenAt: iso(NOW), updatedAt: iso(NOW) });
  assert.equal(later.notes.length, 1);

  const earlier = planMarkAdvance({
    sinceSource: 'argument',
    argumentSinceMs: SINCE - 1000,
    stored: { commentsSeenAt: iso(SINCE) },
    horizonMs: NOW,
    sections: { comments: { complete: true, truncated: false } },
  });
  assert.equal(earlier.marks?.commentsSeenAt, iso(NOW));
});

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

test('collectActivity: comments in (since, horizon] only, newest first', async () => {
  const fb = createFakeFbRequest();
  servePosts(fb, ['p1', 'p2']);
  fb.on(
    commentsOf('p1'),
    fbOk({
      data: [
        comment('late', NOW + 1000), // arrived mid-scan: the next call's
        comment('c3', NOW),
        comment('c1', SINCE + 1000),
        comment('edge', SINCE), // exactly since: already reported
        comment('old', SINCE - 1000),
      ],
    }),
  );
  fb.on(
    commentsOf('p2'),
    fbOk({ data: [comment('c2', SINCE + 5000, { parent: { id: 'c1' } })] }),
  );
  const result = await collectActivity(fb.fn, options({ includeConversations: false }));
  const comments = asComments(result.comments);
  assert.deepEqual(
    comments.items.map((c) => c.commentId),
    ['c3', 'c2', 'c1'],
  );
  assert.equal(comments.truncated, false);
  assert.equal(comments.postsScanned, 2);
  const reply = comments.items.find((c) => c.commentId === 'c2');
  assert.equal(reply?.isReply, true);
  assert.equal(reply?.parentId, 'c1');
  assert.equal(result.conversations, undefined);

  const commentReq = fb.calls.find(commentsOf('p1'));
  assert.ok(commentReq);
  assert.equal(param(commentReq, 'filter'), 'stream');
  assert.equal(param(commentReq, 'order'), 'reverse_chronological');
  const postsReq = fb.calls.find(isPosts);
  assert.ok(postsReq);
  assert.equal(param(postsReq, 'limit'), 10);
  for (const req of fb.calls) assert.equal(req.token, PAGE_TOKEN);
});

test('collectActivity: the comments read stops at the first older comment', async () => {
  const fb = createFakeFbRequest();
  servePosts(fb, ['p1']);
  fb.on(
    commentsOf('p1'),
    fbOk(withNext([comment('new', SINCE + 1000), comment('old', SINCE - 1000)], 'NEXT')),
  );
  const result = await collectActivity(fb.fn, options({ includeConversations: false }));
  assert.equal(asComments(result.comments).items.length, 1);
  assert.equal(fb.calls.filter(commentsOf('p1')).length, 1, 'no second page requested');
});

test('collectActivity: max_comments truncates the comments section', async () => {
  const fb = createFakeFbRequest();
  servePosts(fb, ['p1']);
  fb.on(
    commentsOf('p1'),
    fbOk({ data: [1, 2, 3, 4].map((n) => comment(`c${String(n)}`, NOW - n * 1000)) }),
  );
  const result = await collectActivity(
    fb.fn,
    options({ includeConversations: false, maxComments: 2 }),
  );
  const comments = asComments(result.comments);
  assert.equal(comments.items.length, 2);
  assert.equal(comments.truncated, true);
});

test('collectActivity: the comment-call cap truncates and bounds the requests', async () => {
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ data: [{ id: 'p1' }] }));
  // Every page is new and advertises another one.
  for (let n = 0; n <= ACTIVITY_MAX_COMMENT_CALLS; n += 1) {
    fb.enqueue(fbOk(withNext([comment(`c${String(n)}`, NOW - 1000)], `C${String(n)}`)));
  }
  const result = await collectActivity(
    fb.fn,
    options({ includeConversations: false, maxComments: 100 }),
  );
  assert.equal(asComments(result.comments).truncated, true);
  assert.equal(fb.calls.filter(commentsOf('p1')).length, ACTIVITY_MAX_COMMENT_CALLS);
});

test('collectActivity: one failing post is counted, the others still read', async () => {
  const fb = createFakeFbRequest();
  servePosts(fb, ['p1', 'p2']);
  fb.on(commentsOf('p1'), fbErr(graphError(10)));
  fb.on(commentsOf('p2'), fbOk({ data: [comment('c', NOW - 1000)] }));
  const result = await collectActivity(fb.fn, options({ includeConversations: false }));
  const comments = asComments(result.comments);
  assert.deepEqual(comments.postErrors, [{ postId: 'p1', code: 10 }]);
  assert.equal(comments.items.length, 1);
});

test('collectActivity: every post failing makes the comments section an error', async () => {
  const fb = createFakeFbRequest();
  servePosts(fb, ['p1', 'p2']);
  fb.on(commentsOf('p1'), fbErr(graphError(10)));
  fb.on(commentsOf('p2'), fbErr(graphError(10)));
  fb.on(isConversations, fbOk({ data: [] }));
  const result = await collectActivity(fb.fn, options());
  assert.ok(isSectionFailure(result.comments));
  assert.equal(result.comments.error.code, 10);
  asConversations(result.conversations);
});

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

test('collectActivity: conversations newer than since, plus older unread ones', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    isConversations,
    fbOk(
      withNext(
        [
          conversation('t_late', NOW + 1000, 1),
          conversation('t_new', SINCE + 1000, 0),
          conversation('t_edge', SINCE, 0),
          conversation('t_unread', SINCE - 1000, 2),
          conversation('t_read', SINCE - 2000, 0),
        ],
        'NEXT',
      ),
    ),
  );
  const result = await collectActivity(fb.fn, options({ includeComments: false }));
  const conversations = asConversations(result.conversations);
  assert.deepEqual(
    conversations.items.map((c) => c.conversationId),
    ['t_new', 't_unread'],
  );
  assert.equal(conversations.unreadTotal, 2);
  assert.equal(conversations.truncated, false);
  assert.equal(fb.calls.length, 1, 'the walk stopped at the first older conversation');
  assert.deepEqual(conversations.items[0]?.participantNames, ['Person t_new']);
});

test('collectActivity: the conversation page cap marks the section truncated', async () => {
  const fb = createFakeFbRequest();
  for (let n = 0; n < 4; n += 1) {
    fb.enqueue(
      fbOk(withNext([conversation(`t${String(n)}`, NOW - 1000)], `C${String(n)}`)),
    );
  }
  const result = await collectActivity(fb.fn, options({ includeComments: false }));
  const conversations = asConversations(result.conversations);
  assert.equal(conversations.truncated, true);
  assert.equal(fb.calls.length, 3);
});

// ---------------------------------------------------------------------------
// Failure isolation
// ---------------------------------------------------------------------------

test('collectActivity: a conversations permission error keeps the comments', async () => {
  const fb = createFakeFbRequest();
  servePosts(fb, ['p1']);
  fb.on(commentsOf('p1'), fbOk({ data: [comment('c', NOW - 1000)] }));
  fb.on(isConversations, fbErr(graphError(200)));
  const result = await collectActivity(fb.fn, options());
  assert.equal(asComments(result.comments).items.length, 1);
  assert.ok(isSectionFailure(result.conversations));
  assert.equal(result.conversations.error.code, 200);
});

test('collectActivity: both sections failing throws the comments error', async () => {
  const fb = createFakeFbRequest();
  fb.on(isPosts, fbErr(graphError(100)));
  fb.on(isConversations, fbErr(graphError(200)));
  await assert.rejects(
    collectActivity(fb.fn, options()),
    (err: unknown) => err instanceof GraphApiError && err.code === 100,
  );
});

test('collectActivity: an abort propagates instead of degrading a section', async () => {
  const fb = createFakeFbRequest();
  const controller = new AbortController();
  controller.abort();
  const abort = new Error('aborted');
  fb.on(isPosts, fbErr(abort));
  fb.on(isConversations, fbOk({ data: [] }));
  await assert.rejects(
    collectActivity(fb.fn, options({ signal: controller.signal })),
    (err: unknown) => err === abort,
  );
});
