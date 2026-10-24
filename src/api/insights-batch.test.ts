// Tests for batch post insights (v2 insights F4): vet-once, row isolation, the
// foreign-Page guard, `latest` through published_posts and the bounded
// concurrency. Placeholder tokens only.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeFbRequest, fbErr, fbOk } from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import type { FbRequest, FbRequestFn, FbResponse, JsonRequest } from '../core/index.js';
import {
  DEFAULT_POSTS_INSIGHTS_METRICS,
  POSTS_LIFETIME_NOTE,
  fetchPostsInsights,
  foreignPostError,
  latestPostTargets,
  type PostsInsightsOptions,
} from './insights-batch.js';

const PAGE_ID = '1234567890';
const PAGE_TOKEN = 'EAA-PAGE-TOKEN-PLACEHOLDER';
const NOW = Date.parse('2026-10-24T12:00:00Z');

const P1 = `${PAGE_ID}_111`;
const P2 = `${PAGE_ID}_112`;
const P3 = `${PAGE_ID}_113`;

function json(req: FbRequest): JsonRequest | undefined {
  return req.protocol === 'json' ? req : undefined;
}

const isPostInsights = (postId: string) => (req: FbRequest) =>
  json(req)?.path === `/${postId}/insights`;

function metricParam(req: FbRequest): string {
  const value = json(req)?.params?.['metric'];
  return typeof value === 'string' ? value : '';
}

function graphError(code: number, message = `(#${String(code)}) failure`): GraphApiError {
  return new GraphApiError(message, { code, httpStatus: 400 });
}

function body(postId: string, base: number): unknown {
  return {
    data: [
      {
        name: 'post_media_view',
        period: 'lifetime',
        values: [{ value: base }],
        id: postId,
      },
      {
        name: 'post_clicks',
        period: 'lifetime',
        values: [{ value: base / 10 }],
        id: postId,
      },
    ],
  };
}

function options(overrides: Partial<PostsInsightsOptions> = {}): PostsInsightsOptions {
  return {
    pageId: PAGE_ID,
    token: PAGE_TOKEN,
    posts: [{ postId: P1 }, { postId: P2 }, { postId: P3 }],
    metrics: ['post_media_view', 'post_clicks'],
    nowMs: NOW,
    ...overrides,
  };
}

test('defaults are the post-2025 names', () => {
  assert.ok(DEFAULT_POSTS_INSIGHTS_METRICS.includes('post_media_view'));
  assert.ok(!DEFAULT_POSTS_INSIGHTS_METRICS.includes('post_impressions'));
});

test('foreignPostError: flags a composite id from another Page only', () => {
  assert.equal(foreignPostError(P1, PAGE_ID), undefined);
  assert.equal(foreignPostError('999_1', 'not-numeric'), undefined);
  const err = foreignPostError('999_1', PAGE_ID);
  assert.ok(err instanceof GraphApiError);
  assert.equal(err.code, 100);
  assert.match(err.message, /belongs to Page 999/);
});

test('fetchPostsInsights: one lifetime row per post, scalars as values', async () => {
  const fb = createFakeFbRequest();
  fb.on(isPostInsights(P1), fbOk(body(P1, 1000)));
  fb.on(isPostInsights(P2), fbOk(body(P2, 2000)));
  fb.on(isPostInsights(P3), fbOk(body(P3, 3000)));

  const table = await fetchPostsInsights(
    fb.fn,
    options({
      posts: [
        { postId: P1, createdTime: '2026-10-20T10:00:00+0000' },
        { postId: P2 },
        { postId: P3 },
      ],
    }),
  );

  assert.equal(table.period, 'lifetime');
  assert.deepEqual(table.columns, ['post_media_view', 'post_clicks']);
  assert.deepEqual(
    table.posts.map((r) => r.values),
    [
      { post_media_view: 1000, post_clicks: 100 },
      { post_media_view: 2000, post_clicks: 200 },
      { post_media_view: 3000, post_clicks: 300 },
    ],
  );
  assert.equal(table.posts[0]?.createdTime, '2026-10-20T10:00:00+0000');
  assert.deepEqual(table.emptyMetrics, []);
  assert.deepEqual(table.notes, [POSTS_LIFETIME_NOTE]);
  for (const call of fb.calls) {
    assert.equal(json(call)?.params?.['period'], 'lifetime');
  }
  assert.ok(!JSON.stringify(table).includes(PAGE_TOKEN));
});

test('fetchPostsInsights: a deprecated name is vetted out once, not per post', async () => {
  const fb = createFakeFbRequest();
  for (const id of [P1, P2, P3]) fb.on(isPostInsights(id), fbOk(body(id, 1000)));

  const table = await fetchPostsInsights(
    fb.fn,
    options({ metrics: ['post_impressions', 'post_media_view', 'post_clicks'] }),
  );

  assert.equal(fb.calls.length, 3);
  for (const call of fb.calls) {
    assert.ok(!metricParam(call).includes('post_impressions'));
  }
  assert.deepEqual(
    table.deprecatedMetrics.map((v) => v.metric),
    ['post_impressions'],
  );
  assert.ok(
    table.notes.some((n) => n.includes('"post_impressions" is no longer served')),
  );
});

test('fetchPostsInsights: a positional rejection on the vetting post shrinks later reads', async () => {
  const fb = createFakeFbRequest();
  // The first post answers only after the rejected name is retried away.
  fb.on(
    (req) => isPostInsights(P1)(req) && metricParam(req).includes('post_bogus_metric'),
    fbErr(graphError(100, '(#100) metric[1] must be one of the following values: a, b')),
  );
  for (const id of [P1, P2, P3]) fb.on(isPostInsights(id), fbOk(body(id, 1000)));

  const table = await fetchPostsInsights(
    fb.fn,
    options({ metrics: ['post_media_view', 'post_bogus_metric', 'post_clicks'] }),
  );

  assert.deepEqual(table.columns, ['post_media_view', 'post_clicks']);
  assert.deepEqual(
    table.rejectedMetrics.map((r) => r.metric),
    ['post_bogus_metric'],
  );
  const later = fb.calls.filter((c) => !isPostInsights(P1)(c));
  assert.equal(later.length, 2);
  for (const call of later)
    assert.equal(metricParam(call), 'post_media_view,post_clicks');
  assert.ok(table.notes.some((n) => n.includes('Graph rejected "post_bogus_metric"')));
});

test('fetchPostsInsights: one failing post becomes a row error, the rest answer', async () => {
  const fb = createFakeFbRequest();
  fb.on(isPostInsights(P1), fbOk(body(P1, 1000)));
  fb.on(isPostInsights(P2), fbErr(graphError(10)));
  fb.on(isPostInsights(P3), fbOk(body(P3, 3000)));

  const table = await fetchPostsInsights(fb.fn, options());

  assert.equal(table.posts[1]?.postId, P2);
  assert.equal(table.posts[1]?.error?.code, 10);
  assert.equal(table.posts[1]?.values, undefined);
  assert.equal(table.posts[2]?.values?.['post_media_view'], 3000);
});

test('fetchPostsInsights: a failing first post does not decide the columns', async () => {
  const fb = createFakeFbRequest();
  fb.on(isPostInsights(P1), fbErr(graphError(100, '(#100) Unsupported get request')));
  fb.on(isPostInsights(P2), fbOk(body(P2, 2000)));
  fb.on(isPostInsights(P3), fbOk(body(P3, 3000)));

  const table = await fetchPostsInsights(fb.fn, options());

  assert.ok(table.posts[0]?.error !== undefined);
  assert.deepEqual(table.columns, ['post_media_view', 'post_clicks']);
  assert.equal(table.posts[1]?.values?.['post_media_view'], 2000);
});

test('fetchPostsInsights: a post on another Page is a row error with no Graph call', async () => {
  const fb = createFakeFbRequest();
  fb.on(isPostInsights(P1), fbOk(body(P1, 1000)));

  const table = await fetchPostsInsights(
    fb.fn,
    options({ posts: [{ postId: '999_1' }, { postId: P1 }] }),
  );

  assert.equal(fb.calls.length, 1);
  assert.equal(table.posts[0]?.error?.code, 100);
  assert.match(table.posts[0]?.error?.message ?? '', /another Page/);
  assert.equal(table.posts[1]?.values?.['post_media_view'], 1000);
});

test('fetchPostsInsights: every row failing throws the first error', async () => {
  const fb = createFakeFbRequest();
  fb.on(isPostInsights(P1), fbErr(graphError(190)));
  fb.on(isPostInsights(P2), fbErr(graphError(10)));

  await assert.rejects(
    fetchPostsInsights(fb.fn, options({ posts: [{ postId: P1 }, { postId: P2 }] })),
    (err: unknown) => err instanceof GraphApiError && err.code === 190,
  );
});

test('fetchPostsInsights: only foreign posts throws the guard error', async () => {
  const fb = createFakeFbRequest();
  await assert.rejects(
    fetchPostsInsights(fb.fn, options({ posts: [{ postId: '999_1' }] })),
    /belongs to Page 999/,
  );
  assert.equal(fb.calls.length, 0);
});

test('fetchPostsInsights: breakdown maps stay unaggregated', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    isPostInsights(P1),
    fbOk({
      data: [
        {
          name: 'post_reactions_by_type_total',
          period: 'lifetime',
          values: [{ value: { like: 12, love: 3 } }],
          id: P1,
        },
      ],
    }),
  );

  const table = await fetchPostsInsights(
    fb.fn,
    options({ posts: [{ postId: P1 }], metrics: ['post_reactions_by_type_total'] }),
  );

  assert.deepEqual(table.posts[0]?.breakdowns, {
    post_reactions_by_type_total: { like: 12, love: 3 },
  });
  assert.deepEqual(table.posts[0]?.values, {});
});

test('fetchPostsInsights: a metric empty on every answered post is reported', async () => {
  const fb = createFakeFbRequest();
  const onlyViews = (id: string): unknown => ({
    data: [
      { name: 'post_media_view', period: 'lifetime', values: [{ value: 5 }], id },
      { name: 'post_clicks', period: 'lifetime', values: [], id },
    ],
  });
  fb.on(isPostInsights(P1), fbOk(onlyViews(P1)));
  fb.on(isPostInsights(P2), fbOk(onlyViews(P2)));

  const table = await fetchPostsInsights(
    fb.fn,
    options({ posts: [{ postId: P1 }, { postId: P2 }] }),
  );

  assert.deepEqual(table.emptyMetrics, ['post_clicks']);
});

test('fetchPostsInsights: concurrency is bounded', async () => {
  let inFlight = 0;
  let peak = 0;
  const ids = Array.from({ length: 10 }, (_, i) => `${PAGE_ID}_${String(200 + i)}`);
  const fn: FbRequestFn = async <T = unknown>(req: FbRequest): Promise<FbResponse<T>> => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    const id = (json(req)?.path ?? '').split('/')[1] ?? '';
    return { data: body(id, 100) as T, headers: {}, status: 200 };
  };

  const table = await fetchPostsInsights(
    fn,
    options({ posts: ids.map((postId) => ({ postId })) }),
  );

  assert.equal(table.posts.length, 10);
  assert.ok(table.posts.every((r) => r.values?.['post_media_view'] === 100));
  assert.equal(peak, 3);
});

test('fetchPostsInsights: an abort is rethrown, not degraded to a row', async () => {
  const controller = new AbortController();
  const fn: FbRequestFn = <T = unknown>(): Promise<FbResponse<T>> => {
    controller.abort();
    return Promise.reject(new Error('aborted'));
  };
  await assert.rejects(
    fetchPostsInsights(fn, options({ signal: controller.signal })),
    /aborted/,
  );
});

test('latestPostTargets: one published_posts read with the limit', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    (req) => json(req)?.path === `/${PAGE_ID}/published_posts`,
    fbOk({
      data: [
        { id: P1, created_time: '2026-10-22T10:00:00+0000' },
        { id: P2, created_time: '2026-10-21T10:00:00+0000' },
        { created_time: 'no id' },
      ],
    }),
  );

  const targets = await latestPostTargets(fb.fn, {
    pageId: PAGE_ID,
    token: PAGE_TOKEN,
    limit: 2,
  });

  assert.equal(fb.calls.length, 1);
  assert.equal(json(fb.calls[0] as FbRequest)?.params?.['fields'], 'id,created_time');
  assert.equal(String(json(fb.calls[0] as FbRequest)?.params?.['limit']), '2');
  assert.deepEqual(targets, [
    { postId: P1, createdTime: '2026-10-22T10:00:00+0000' },
    { postId: P2, createdTime: '2026-10-21T10:00:00+0000' },
  ]);
});
