// Tests for the `posts` tool package: facebook_list_scheduled_posts,
// facebook_get_video_status and Reels lifecycle honesty.
//
// Split out of `posts.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/posts.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFakePageResolver,
  fbErr,
  fbOk,
  type FakeFbRequest,
} from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import type { ToolResult } from '../core/index.js';
import { VIDEO_ID_MESSAGE } from './shared.js';
import {
  PAGE_ID,
  PAGE_TOKEN,
  POST_ID,
  body,
  findJson,
  isWrite,
  makeCtx,
  record,
  stubPageTimezone,
  tool,
} from '../testing/harness/posts.js';

/**
 * A bare video id — deliberately NOT a "{page}_{post}" post id (CC-MEDIA-7),
 * and digits-only, which is the shape Graph's video node ids actually take and
 * the shape `video_id` arguments enforce.
 */
const VIDEO_ID = '987654321';

// ---------------------------------------------------------------------------
// facebook_list_scheduled_posts
// ---------------------------------------------------------------------------

test('list_scheduled_posts returns the queue with a dual UTC + Page-local echo', async () => {
  const { fb, ctx } = makeCtx();
  stubPageTimezone(fb, 'Europe/Sofia');
  fb.on(
    (req) => req.path === `/${PAGE_ID}/scheduled_posts`,
    fbOk({
      data: [
        {
          id: '100_1',
          message: 'Queued',
          created_time: '2025-12-30T08:00:00+0000',
          scheduled_publish_time: 1_767_614_400,
          is_published: false,
        },
      ],
      paging: { cursors: { after: 'CUR2' }, next: 'https://graph.facebook.com/next' },
    }),
  );

  const result = await tool('facebook_list_scheduled_posts').handler({ limit: 5 }, ctx);
  assert.equal(result.isError, undefined);
  const parsed = body(result);
  assert.equal(parsed['pageId'], PAGE_ID);
  assert.equal(parsed['pageTimezone'], 'Europe/Sofia');
  assert.equal(parsed['nextCursor'], 'CUR2');

  const posts = parsed['posts'];
  assert.ok(Array.isArray(posts) && posts.length === 1);
  const post = record(posts[0]);
  assert.equal(post['id'], '100_1');
  assert.equal(post['isPublished'], false);
  const when = record(post['scheduledPublishTime']);
  assert.equal(when['epochSeconds'], 1_767_614_400);
  assert.equal(when['utc'], new Date(1_767_614_400 * 1000).toISOString());
  assert.equal(when['pageTimezone'], 'Europe/Sofia');
  assert.ok(typeof when['pageLocal'] === 'string' && when['pageLocal'].length > 0);

  const edge = findJson(fb, (req) => req.path === `/${PAGE_ID}/scheduled_posts`);
  assert.equal(record(edge.params)['limit'], 5);
  assert.equal(edge.token, PAGE_TOKEN);
});

test('list_scheduled_posts forwards the cursor and performs no write', async () => {
  const { fb, ctx } = makeCtx();
  stubPageTimezone(fb);
  fb.on((req) => req.path === `/${PAGE_ID}/scheduled_posts`, fbOk({ data: [] }));

  const parsed = body(
    await tool('facebook_list_scheduled_posts').handler({ after: 'CUR1' }, ctx),
  );
  assert.deepEqual(parsed['posts'], []);
  assert.equal(parsed['nextCursor'], null);
  assert.match(String(parsed['timezoneCaveat']), /\S/);

  const edge = findJson(fb, (req) => req.path === `/${PAGE_ID}/scheduled_posts`);
  assert.equal(record(edge.params)['after'], 'CUR1');
  assert.equal(fb.calls.filter(isWrite).length, 0);
});

test('list_scheduled_posts still lists the queue when the Page timezone is unreadable', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'GET' && req.path === `/${PAGE_ID}`,
    fbErr(new Error('no timezone for you')),
  );
  fb.on(
    (req) => req.path === `/${PAGE_ID}/scheduled_posts`,
    fbOk({ data: [{ id: '100_2', scheduled_publish_time: '1767614400' }] }),
  );

  const parsed = body(await tool('facebook_list_scheduled_posts').handler({}, ctx));
  assert.equal(parsed['pageTimezone'], null);
  const posts = parsed['posts'];
  assert.ok(Array.isArray(posts));
  const when = record(record(posts[0])['scheduledPublishTime']);
  assert.equal(when['epochSeconds'], 1_767_614_400, 'a string epoch is normalized');
  assert.equal(when['pageLocal'], null);
});

test('list_scheduled_posts honours the profile selector', async () => {
  const pages = createFakePageResolver({
    default: { pageId: PAGE_ID, name: 'Test Page', token: PAGE_TOKEN },
    pages: { 'brand-b': { pageId: '200', name: 'Brand B', token: 'EAA-B' } },
  });
  const { fb, ctx } = makeCtx({ pages });
  fb.on((req) => req.method === 'GET' && req.path === '/200', fbOk({ id: '200' }));
  fb.on((req) => req.path === '/200/scheduled_posts', fbOk({ data: [] }));

  const parsed = body(
    await tool('facebook_list_scheduled_posts').handler({ profile: 'brand-b' }, ctx),
  );
  assert.equal(parsed['pageId'], '200');
  assert.deepEqual(pages.resolveCalls, ['brand-b']);
});

// ---------------------------------------------------------------------------
// facebook_get_video_status
// ---------------------------------------------------------------------------

/** Stub the one probe the status tool makes (`GET /{video-id}?fields=status`). */
function stubVideoStatus(
  fb: FakeFbRequest,
  status: Record<string, unknown>,
  videoId = VIDEO_ID,
): void {
  fb.on(
    (req) => req.method === 'GET' && req.path === `/${videoId}`,
    fbOk({ id: videoId, status }),
  );
}

/** Assert the envelope really validates against the tool's declared outputSchema. */
function assertStatusEnvelope(result: ToolResult): Record<string, unknown> {
  const schema = tool('facebook_get_video_status').outputSchema;
  assert.ok(schema, 'the status envelope declares an outputSchema (CC-MCP-7)');
  const structured = result.structuredContent;
  assert.ok(structured, 'a server-owned envelope emits structuredContent');
  schema.parse(structured);
  return record(structured);
}

test('get_video_status probes GET /{video-id}?fields=status with the Page token', async () => {
  const { fb, ctx } = makeCtx();
  stubVideoStatus(fb, {
    video_status: 'processing',
    uploading_phase: { status: 'in_progress', bytes_transferred: 1024 },
  });

  const result = await tool('facebook_get_video_status').handler(
    { video_id: VIDEO_ID },
    ctx,
  );
  assert.equal(result.isError, undefined);

  const probe = findJson(fb, (req) => req.path === `/${VIDEO_ID}`);
  assert.equal(probe.method, 'GET');
  assert.equal(probe.host, 'graph', 'status reads go to the ordinary graph edge');
  assert.equal(record(probe.params)['fields'], 'status');
  assert.equal(probe.token, PAGE_TOKEN);
  assert.equal(probe.pageId, PAGE_ID);
  assert.equal(fb.calls.filter(isWrite).length, 0);
});

test('get_video_status reports an in-flight upload as non-terminal with the byte offset', async () => {
  const { fb, ctx } = makeCtx();
  stubVideoStatus(fb, {
    video_status: 'upload',
    uploading_phase: { status: 'in_progress', bytes_transferred: 4096 },
  });

  const result = await tool('facebook_get_video_status').handler(
    { video_id: VIDEO_ID },
    ctx,
  );
  const envelope = assertStatusEnvelope(result);
  assert.deepEqual(body(result), envelope, 'text body and structuredContent agree');
  assert.equal(envelope['videoId'], VIDEO_ID);
  assert.equal(envelope['pageId'], PAGE_ID);
  assert.equal(envelope['state'], 'uploading');
  assert.equal(envelope['terminal'], false);
  assert.equal(envelope['bytesTransferred'], 4096);
  assert.match(String(envelope['note']), /\S/);
  assert.equal(envelope['error'], undefined);
});

test('get_video_status reports a ready video as terminal and echoes the publishing phase', async () => {
  const { fb, ctx } = makeCtx();
  stubVideoStatus(fb, {
    video_status: 'ready',
    processing_phase: { status: 'complete' },
    publishing_phase: { status: 'complete', publish_status: 'published' },
  });

  const envelope = assertStatusEnvelope(
    await tool('facebook_get_video_status').handler({ video_id: VIDEO_ID }, ctx),
  );
  assert.equal(envelope['state'], 'ready');
  assert.equal(envelope['terminal'], true);
  assert.equal(envelope['publishStatus'], 'published');
  assert.equal(envelope['bytesTransferred'], undefined);
});

test('get_video_status surfaces the failure message on an errored video', async () => {
  const { fb, ctx } = makeCtx();
  stubVideoStatus(fb, {
    video_status: 'error',
    processing_phase: { status: 'error', errors: [{ message: 'codec unsupported' }] },
  });

  const envelope = assertStatusEnvelope(
    await tool('facebook_get_video_status').handler({ video_id: VIDEO_ID }, ctx),
  );
  assert.equal(envelope['state'], 'error');
  assert.equal(envelope['terminal'], true);
  assert.equal(envelope['error'], 'codec unsupported');
});

test('get_video_status treats an unrecognized status as still processing, never as done', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'GET' && req.path === `/${VIDEO_ID}`,
    fbOk({ id: VIDEO_ID }),
  );

  const envelope = assertStatusEnvelope(
    await tool('facebook_get_video_status').handler({ video_id: VIDEO_ID }, ctx),
  );
  assert.equal(envelope['state'], 'processing');
  assert.equal(envelope['terminal'], false, 'unknown means "poll again", not "ready"');
});

test('get_video_status honours the profile selector', async () => {
  const pages = createFakePageResolver({
    default: { pageId: PAGE_ID, name: 'Test Page', token: PAGE_TOKEN },
    pages: { 'brand-b': { pageId: '200', name: 'Brand B', token: 'EAA-B' } },
  });
  const { fb, ctx } = makeCtx({ pages });
  stubVideoStatus(fb, { video_status: 'ready' });

  const envelope = assertStatusEnvelope(
    await tool('facebook_get_video_status').handler(
      { video_id: VIDEO_ID, profile: 'brand-b' },
      ctx,
    ),
  );
  assert.equal(envelope['pageId'], '200');
  assert.deepEqual(pages.resolveCalls, ['brand-b']);
  assert.equal(findJson(fb, (req) => req.path === `/${VIDEO_ID}`).token, 'EAA-B');
});

test('get_video_status never invents a state when the probe itself fails', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'GET' && req.path === `/${VIDEO_ID}`,
    fbErr(new GraphApiError('Unsupported get request', { code: 100, httpStatus: 400 })),
  );

  // Same contract as every other tool here: the Graph error envelope belongs to
  // the server bootstrap, so a bare GraphApiError travels out untouched rather
  // than being flattened into a fifth, invented status.
  await assert.rejects(
    () => tool('facebook_get_video_status').handler({ video_id: VIDEO_ID }, ctx),
    GraphApiError,
  );
});

test('get_video_status refuses a {page-id}_{post-id} composite before any Graph call', async () => {
  const { fb, ctx } = makeCtx();
  // Stub the edge anyway: if the guard ever regresses, the call succeeds and
  // `fb.calls` proves the composite was spent on a request that cannot resolve.
  stubVideoStatus(fb, { video_status: 'ready' }, POST_ID);

  await assert.rejects(
    () => tool('facebook_get_video_status').handler({ video_id: POST_ID }, ctx),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      // Both substrings are asserted by the live `reels/status-guardrail` smoke,
      // so they are contract, not prose.
      assert.match(message, /VIDEO id/);
      assert.match(message, /digits only/);
      return true;
    },
  );
  assert.equal(fb.calls.length, 0, 'the composite never reached Graph');
});

test('get_video_status refuses every id shape that could escape the path', async () => {
  const { fb, ctx } = makeCtx();

  for (const videoId of ['..', '.', 'me/videos', '123?fields=id', 'vid-777', '12 34']) {
    await assert.rejects(
      () => tool('facebook_get_video_status').handler({ video_id: videoId }, ctx),
      /VIDEO id/,
      `"${videoId}" must not be accepted as a video id`,
    );
  }
  assert.equal(fb.calls.length, 0, 'nothing but a bare numeric id is sent');
});

test('get_video_status and reel_insights enforce one shared video-id contract', () => {
  // One definition, two tools: the divergence this collapses is what let a post
  // composite through `facebook_get_video_status` while `facebook_reel_insights`
  // rejected it locally.
  const schema = tool('facebook_get_video_status').inputSchema;
  const rejected = schema.safeParse({ video_id: POST_ID });
  assert.equal(rejected.success, false);
  assert.equal(
    rejected.success ? '' : (rejected.error.issues[0]?.message ?? ''),
    `${VIDEO_ID_MESSAGE} facebook_create_video_post returns it as \`videoId\`.`,
  );
  // A pasted id with stray whitespace is judged on its digits, not its padding.
  assert.equal(schema.safeParse({ video_id: `  ${VIDEO_ID} ` }).success, true);
});

// ---------------------------------------------------------------------------
// G-TOOL-3 — Reels lifecycle honesty (doc 10 §2)
// ---------------------------------------------------------------------------

test('delete_post and list_scheduled_posts state the Reels answer as unverified', () => {
  for (const name of ['facebook_delete_post', 'facebook_list_scheduled_posts']) {
    const description = tool(name).description;
    assert.match(description, /Reels/, `${name} must speak about Reels at all`);
    assert.match(
      description,
      /UNVERIFIED/,
      `${name} must not imply a verified Reels answer`,
    );
  }
});
