// Tests for comment triage (v2 messaging F6): keyword folding, the stop-at-since
// paging rule, the zero-reply shortcut, the reply-scan budget, stream-mode Page
// reply detection and the per-post / rate-limit / permission degradation.
// Placeholder tokens only.

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
  RATE_LIMITED_NOTE,
  matchKeywords,
  scanRecentComments,
  type TriageOptions,
} from './comment-triage.js';

const PAGE_ID = '1234567890';
const PAGE_TOKEN = 'EAA-PAGE-TOKEN-PLACEHOLDER';
const NOW = Date.parse('2026-10-24T12:00:00Z');
const HOUR = 60 * 60 * 1000;

const graphTime = (ms: number): string =>
  new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+0000');

function param(req: FbRequest, key: string): unknown {
  return req.protocol === 'json' ? req.params?.[key] : undefined;
}

function graphError(code: number): GraphApiError {
  return new GraphApiError(`(#${String(code)}) failure`, { code, httpStatus: 400 });
}

function comment(id: string, ms: number, extra: Record<string, unknown> = {}): unknown {
  return {
    id,
    message: `body ${id}`,
    created_time: graphTime(ms),
    from: { id: '42', name: `Author ${id}` },
    like_count: 0,
    comment_count: 0,
    is_hidden: false,
    can_reply_privately: true,
    ...extra,
  };
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

function options(overrides: Partial<TriageOptions> = {}): TriageOptions {
  return {
    pageId: PAGE_ID,
    token: PAGE_TOKEN,
    posts: 10,
    status: 'unanswered',
    includeReplies: false,
    maxComments: 100,
    ...overrides,
  };
}

const isPosts = (req: FbRequest): boolean => req.path === `/${PAGE_ID}/published_posts`;
const commentsOf =
  (id: string) =>
  (req: FbRequest): boolean =>
    req.path === `/${id}/comments`;

function servePosts(fb: FakeFbRequest, ids: readonly string[]): void {
  fb.on(isPosts, fbOk({ data: ids.map((id) => ({ id, created_time: graphTime(NOW) })) }));
}

const callsTo = (fb: FakeFbRequest, path: string): FbRequest[] =>
  fb.calls.filter((req) => req.path === path);

// ---------------------------------------------------------------------------
// matchKeywords
// ---------------------------------------------------------------------------

test('matchKeywords: NFKC + case folding, any keyword, caller spelling returned', () => {
  // Fullwidth "ＲＥＦＵＮＤ" folds to "refund" under NFKC.
  assert.deepEqual(matchKeywords('I want a ＲＥＦＵＮＤ now', ['Refund', 'scam']), [
    'Refund',
  ]);
  assert.deepEqual(matchKeywords('SCAM! refund!', ['refund', 'Scam', 'REFUND']), [
    'refund',
    'Scam',
  ]);
  assert.deepEqual(matchKeywords('nothing here', ['refund']), []);
  assert.deepEqual(matchKeywords(undefined, ['refund']), []);
  // A regex metacharacter is a literal, never a pattern.
  assert.deepEqual(matchKeywords('price (a+)+ b', ['(a+)+']), ['(a+)+']);
});

// ---------------------------------------------------------------------------
// scanRecentComments
// ---------------------------------------------------------------------------

test('scan: reads newest first, pages, and stops at the first comment before since', async () => {
  const fb = createFakeFbRequest();
  servePosts(fb, ['p1']);
  fb.on(
    (req) => commentsOf('p1')(req) && param(req, 'after') === undefined,
    fbOk(withNext([comment('c1', NOW - HOUR), comment('c2', NOW - 2 * HOUR)], 'k1')),
  );
  fb.on(
    (req) => commentsOf('p1')(req) && param(req, 'after') === 'k1',
    fbOk(withNext([comment('c3', NOW - 3 * HOUR), comment('old', NOW - 9 * HOUR)], 'k2')),
  );
  const scan = await scanRecentComments(
    fb.fn,
    options({ sinceMs: NOW - 4 * HOUR, status: 'all' }),
  );
  assert.deepEqual(
    scan.items.map((i) => i.commentId),
    ['c1', 'c2', 'c3'],
  );
  assert.equal(scan.scannedComments, 3);
  assert.equal(scan.truncated, false);
  const pages = callsTo(fb, '/p1/comments');
  assert.equal(pages.length, 2, 'the k2 page is never requested');
  assert.equal(param(pages[0] as FbRequest, 'order'), 'reverse_chronological');
  assert.equal(param(pages[0] as FbRequest, 'filter'), 'toplevel');
});

test('scan: a comment with no replies is unanswered without a reply read', async () => {
  const fb = createFakeFbRequest();
  servePosts(fb, ['p1']);
  fb.on(commentsOf('p1'), fbOk({ data: [comment('c1', NOW - HOUR)] }));
  const scan = await scanRecentComments(fb.fn, options());
  assert.equal(scan.items.length, 1);
  assert.equal(scan.items[0]?.pageReplied, false);
  assert.equal(callsTo(fb, '/c1/comments').length, 0);
});

test('scan: unanswered drops a thread the Page replied in and keeps the others', async () => {
  const fb = createFakeFbRequest();
  servePosts(fb, ['p1']);
  fb.on(
    commentsOf('p1'),
    fbOk({
      data: [
        comment('answered', NOW - HOUR, { comment_count: 2 }),
        comment('ignored', NOW - 2 * HOUR, { comment_count: 1 }),
        comment('mine', NOW - 3 * HOUR, { from: { id: PAGE_ID, name: 'Page' } }),
      ],
    }),
  );
  fb.on(
    commentsOf('answered'),
    fbOk({ data: [{ from: { id: '77' } }, { from: { id: PAGE_ID } }] }),
  );
  fb.on(commentsOf('ignored'), fbOk({ data: [{ from: { id: '77' } }] }));
  const scan = await scanRecentComments(fb.fn, options());
  assert.deepEqual(
    scan.items.map((i) => [i.commentId, i.pageReplied]),
    [['ignored', false]],
  );
  const replyRead = callsTo(fb, '/answered/comments')[0] as FbRequest;
  assert.equal(param(replyRead, 'fields'), 'from{id}');
  assert.equal(param(replyRead, 'limit'), 25);
});

test('scan: over the reply-scan budget pageReplied is null with a note', async () => {
  const fb = createFakeFbRequest();
  servePosts(fb, ['p1']);
  fb.on(
    commentsOf('p1'),
    fbOk({
      data: [
        comment('a', NOW - HOUR, { comment_count: 1 }),
        comment('b', NOW - 2 * HOUR, { comment_count: 1 }),
        comment('c', NOW - 3 * HOUR, { comment_count: 1 }),
      ],
    }),
  );
  for (const id of ['a', 'b', 'c']) {
    fb.on(commentsOf(id), fbOk({ data: [{ from: { id: '77' } }] }));
  }
  const scan = await scanRecentComments(fb.fn, options({ maxReplyScans: 2 }));
  assert.deepEqual(
    scan.items.map((i) => [i.commentId, i.pageReplied]),
    [
      ['a', false],
      ['b', false],
      ['c', null],
    ],
  );
  assert.equal(callsTo(fb, '/c/comments').length, 0);
  assert.ok(scan.notes.some((n) => n.includes('Reply scan skipped for 1 thread')));
});

test('scan: a reply page with more rows and no Page reply is unknown, not false', async () => {
  const fb = createFakeFbRequest();
  servePosts(fb, ['p1']);
  fb.on(
    commentsOf('p1'),
    fbOk({ data: [comment('a', NOW - HOUR, { comment_count: 40 })] }),
  );
  fb.on(commentsOf('a'), fbOk(withNext([{ from: { id: '77' } }], 'r1')));
  const scan = await scanRecentComments(fb.fn, options());
  assert.equal(scan.items[0]?.pageReplied, null);
});

test('scan: stream mode decides pageReplied locally from newer Page replies', async () => {
  const fb = createFakeFbRequest();
  servePosts(fb, ['p1']);
  fb.on(
    commentsOf('p1'),
    fbOk({
      data: [
        comment('page-r', NOW - HOUR, {
          from: { id: PAGE_ID, name: 'Page' },
          parent: { id: 'top1' },
        }),
        comment('r2', NOW - 2 * HOUR, { parent: { id: 'top2' } }),
        comment('top1', NOW - 3 * HOUR, { comment_count: 1 }),
        comment('r1', NOW - 4 * HOUR, { parent: { id: 'top1' } }),
        comment('top2', NOW - 5 * HOUR, { comment_count: 1 }),
      ],
    }),
  );
  const scan = await scanRecentComments(fb.fn, options({ includeReplies: true }));
  // top1 has a direct Page reply; r1 is older than that Page reply in the same
  // thread; r2 and top2 have none.
  assert.deepEqual(
    scan.items.map((i) => i.commentId),
    ['r2', 'top2'],
  );
  assert.equal(param(callsTo(fb, '/p1/comments')[0] as FbRequest, 'filter'), 'stream');
  assert.equal(
    fb.calls.filter((req) => req.path !== '/p1/comments' && !isPosts(req)).length,
    0,
    'no reply reads in stream mode',
  );
});

test('scan: keywords and the hidden status filter before the reply read', async () => {
  const fb = createFakeFbRequest();
  servePosts(fb, ['p1']);
  fb.on(
    commentsOf('p1'),
    fbOk({
      data: [
        comment('spam', NOW - HOUR, { message: 'Cheap PILLS here', is_hidden: true }),
        comment('ok', NOW - 2 * HOUR, { message: 'nice post', comment_count: 3 }),
      ],
    }),
  );
  const scan = await scanRecentComments(fb.fn, options({ keywords: ['pills'] }));
  assert.deepEqual(
    scan.items.map((i) => [i.commentId, i.matchedKeywords]),
    [['spam', ['pills']]],
  );
  assert.equal(callsTo(fb, '/ok/comments').length, 0);

  const hidden = await scanRecentComments(fb.fn, options({ status: 'hidden' }));
  assert.deepEqual(
    hidden.items.map((i) => i.commentId),
    ['spam'],
  );
});

test('scan: max_comments stops the scan and sets truncated', async () => {
  const fb = createFakeFbRequest();
  servePosts(fb, ['p1']);
  fb.on(
    commentsOf('p1'),
    fbOk({ data: [comment('a', NOW - HOUR), comment('b', NOW - 2 * HOUR)] }),
  );
  const scan = await scanRecentComments(fb.fn, options({ maxComments: 1 }));
  assert.equal(scan.items.length, 1);
  assert.equal(scan.truncated, true);
  assert.ok(scan.notes.some((n) => n.includes('max_comments')));
});

test('scan: a failing post becomes a note and truncated; the others are kept', async () => {
  const fb = createFakeFbRequest();
  servePosts(fb, ['p1', 'p2']);
  fb.on(commentsOf('p1'), fbErr(graphError(100)));
  fb.on(commentsOf('p2'), fbOk({ data: [comment('c2', NOW - HOUR)] }));
  const scan = await scanRecentComments(fb.fn, options());
  assert.deepEqual(
    scan.items.map((i) => i.commentId),
    ['c2'],
  );
  assert.equal(scan.truncated, true);
  assert.ok(scan.notes.some((n) => n.startsWith('post p1: (#100)')));
});

test('scan: every post failing throws the first error', async () => {
  const fb = createFakeFbRequest();
  servePosts(fb, ['p1']);
  fb.on(commentsOf('p1'), fbErr(graphError(1)));
  await assert.rejects(
    scanRecentComments(fb.fn, options()),
    (err: unknown) => err instanceof GraphApiError && err.code === 1,
  );
});

test('scan: a permission refusal fails the whole call', async () => {
  const fb = createFakeFbRequest();
  servePosts(fb, ['p1', 'p2']);
  fb.on(commentsOf('p1'), fbErr(graphError(10)));
  fb.on(commentsOf('p2'), fbOk({ data: [comment('c2', NOW - HOUR)] }));
  await assert.rejects(
    scanRecentComments(fb.fn, options()),
    (err: unknown) => err instanceof GraphApiError && err.code === 10,
  );
});

test('scan: a rate limit stops the scan with partial results', async () => {
  const fb = createFakeFbRequest();
  servePosts(fb, ['p1']);
  fb.on(
    commentsOf('p1'),
    fbOk({
      data: [
        comment('a', NOW - HOUR),
        comment('b', NOW - 2 * HOUR, { comment_count: 1 }),
        comment('c', NOW - 3 * HOUR),
      ],
    }),
  );
  fb.on(commentsOf('b'), fbErr(graphError(613)));
  const scan = await scanRecentComments(fb.fn, options());
  assert.deepEqual(
    scan.items.map((i) => i.commentId),
    ['a'],
  );
  assert.equal(scan.truncated, true);
  assert.ok(scan.notes.includes(RATE_LIMITED_NOTE));
});

test('scan: no published posts reports noPosts', async () => {
  const fb = createFakeFbRequest();
  servePosts(fb, []);
  const scan = await scanRecentComments(fb.fn, options());
  assert.equal(scan.noPosts, true);
  assert.equal(scan.items.length, 0);
});
