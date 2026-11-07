// Tests for the `posts` tool package: facebook_create_video_post, facebook_create_reel
// and facebook_create_story.
//
// Split out of `posts.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/posts.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fbErr, fbOk, type FakeFbRequest } from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import type { FbRequest, ToolContext } from '../core/index.js';
import { type WriteToolContext } from './shared.js';
import {
  PAGE_ID,
  SOON,
  body,
  findJson,
  isWrite,
  jsonBody,
  makeCtx,
  makeSettings,
  mediaFixture,
  record,
  strings,
  stubPageTimezone,
  stubVideoUploadPhases,
  tool,
} from '../testing/harness/posts.js';

/** Register the three Reels phases; the start phase can be overridden first. */
function stubReelPhases(fb: FakeFbRequest, finish: Record<string, unknown>): void {
  fb.on(
    (req) =>
      req.protocol === 'json' &&
      req.path === `/${PAGE_ID}/video_reels` &&
      record(req.params)['upload_phase'] === 'start',
    fbOk({ video_id: 'reel-1', upload_url: 'https://rupload.facebook.com/x/reel-1' }),
  );
  fb.on((req) => req.protocol === 'rupload', fbOk({ success: true }));
  fb.on(
    (req) =>
      req.protocol === 'json' &&
      req.path === `/${PAGE_ID}/video_reels` &&
      record(req.params)['upload_phase'] === 'finish',
    fbOk(finish),
  );
}

// ---------------------------------------------------------------------------
// facebook_create_video_post
// ---------------------------------------------------------------------------

test('create_video_post bridges resumable upload progress to the MCP client', async (t) => {
  const media = await mediaFixture(t, 'clip.mp4', 4096);
  const { fb, ctx, progress } = makeCtx({
    settings: makeSettings({ mediaDir: media.dir }),
  });
  fb.on(
    (req) =>
      req.protocol === 'json' &&
      req.host === 'graph-video' &&
      record(req.body)['upload_phase'] === 'start',
    fbOk({ upload_session_id: 'sess-1', video_id: 'vid-1', start_offset: 0 }),
  );
  fb.on((req) => req.protocol === 'rupload', fbOk({}));
  fb.on(
    (req) =>
      req.protocol === 'json' &&
      req.host === 'graph-video' &&
      record(req.body)['upload_phase'] === 'finish',
    fbOk({ video_id: 'vid-1' }),
  );

  const preview = body(
    await tool('facebook_create_video_post').handler(
      { video: media.name, description: 'A clip' },
      ctx,
    ),
  );
  assert.equal(preview['status'], 'preview');
  assert.equal(fb.calls.length, 0, 'the dry run streams no bytes');
  assert.equal(progress.length, 0, 'and therefore reports no upload progress');

  const applied = body(
    await tool('facebook_create_video_post').handler(
      { video: media.name, description: 'A clip', apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  const result = record(applied['result']);
  assert.equal(result['videoId'], 'vid-1');
  assert.equal(result['delivery'], 'resumable-upload');
  assert.equal(result['bytesSent'], media.bytes);
  assert.equal(
    result['isPublishedAndProcessed'],
    false,
    'a finished upload is explicitly NOT a published, processed video',
  );
  assert.match(String(result['processingNote']), /\S/);

  assert.ok(progress.length > 0, 'the upload reported progress');
  const last = progress[progress.length - 1];
  assert.equal(last?.progress, media.bytes);
  assert.equal(last?.total, media.bytes);
  assert.match(String(last?.message), /video bytes/);
});

test('create_video_post hands a remote URL to Meta instead of streaming it', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) =>
      req.protocol === 'json' &&
      req.host === 'graph-video' &&
      req.path === `/${PAGE_ID}/videos`,
    fbOk({ id: 'vid-2' }),
  );

  await tool('facebook_create_video_post').handler(
    { video: 'https://cdn.example/clip.mp4' },
    ctx,
  );
  const applied = body(
    await tool('facebook_create_video_post').handler(
      { video: 'https://cdn.example/clip.mp4', apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  const result = record(applied['result']);
  assert.equal(result['delivery'], 'file-url');
  assert.equal(result['videoId'], 'vid-2');
  assert.equal(result['isPublishedAndProcessed'], false);
  const req = findJson(fb, (r) => r.path === `/${PAGE_ID}/videos`);
  assert.equal(jsonBody(req)['file_url'], 'https://cdn.example/clip.mp4');
  assert.equal(
    fb.calls.filter((r) => r.protocol === 'rupload').length,
    0,
    'no bytes leave this process for a file_url delivery',
  );
});

test('create_video_post tells a scheduled or draft video where it can be verified', async () => {
  // Regression coverage: a scheduled or unpublished video is not on the
  // published post listing, so its verify note must not send the model there.
  const cases = [{ scheduled_publish_time: SOON }, { published: false }];
  for (const input of cases) {
    const { fb, ctx } = makeCtx();
    fb.on(
      (req) =>
        req.protocol === 'json' &&
        req.host === 'graph-video' &&
        req.path === `/${PAGE_ID}/videos`,
      fbOk({ id: 'vid-3' }),
    );
    const args = { video: 'https://cdn.example/clip.mp4', ...input };
    await tool('facebook_create_video_post').handler(args, ctx);
    const applied = body(
      await tool('facebook_create_video_post').handler(
        { ...args, apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    );
    const label = JSON.stringify(input);
    assert.equal(applied['status'], 'applied', label);
    const note = String(record(applied['result'])['verifyNote']);
    assert.doesNotMatch(note, /facebook_list_posts/, `${label}: ${note}`);
    assert.match(note, /facebook_get_video_status/, `${label}: ${note}`);
  }
});

test('create_video_post does not send an id-less scheduled or draft video to a feed listing', async () => {
  // A file_url create whose 2xx named no id may still have created the video.
  // A scheduled or draft video is on no feed listing, so "check a feed listing"
  // reads as "it did not land" and invites the duplicate CC-PUB-1 exists to stop.
  const cases = [{ scheduled_publish_time: SOON }, { published: false }];
  for (const input of cases) {
    const { fb, ctx } = makeCtx();
    fb.on(
      (req) =>
        req.protocol === 'json' &&
        req.host === 'graph-video' &&
        req.path === `/${PAGE_ID}/videos`,
      fbOk(undefined),
    );
    const args = { video: 'https://cdn.example/clip.mp4', ...input };
    await tool('facebook_create_video_post').handler(args, ctx);
    const applied = body(
      await tool('facebook_create_video_post').handler(
        { ...args, apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    );
    const label = JSON.stringify(input);
    assert.equal(applied['outcome'], 'attempted', label);
    const note = String(record(applied['result'])['processingNote']);
    assert.doesNotMatch(note, /feed listing/, `${label}: ${note}`);
    assert.match(note, /Meta Business Suite/, `${label}: ${note}`);
  }
});

test('create_video_post refuses a local file outside FB_MEDIA_DIR before previewing', async (t) => {
  const media = await mediaFixture(t, 'clip.mp4', 16);
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  const result = await tool('facebook_create_video_post').handler(
    { video: '../escape.mp4' },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.match(String(body(result)['hint']), /FB_MEDIA_DIR/);
  assert.equal(fb.calls.length, 0);
});

// ---------------------------------------------------------------------------
// facebook_create_reel
// ---------------------------------------------------------------------------

test('create_reel publishes through the three phases and exposes video_state', async (t) => {
  const media = await mediaFixture(t, 'reel.mp4', 1024);
  const { fb, ctx, progress } = makeCtx({
    settings: makeSettings({ mediaDir: media.dir }),
  });
  stubReelPhases(fb, { success: true, post_id: '100_reel' });

  const preview = body(
    await tool('facebook_create_reel').handler(
      { video: media.name, description: 'Reel', video_state: 'PUBLISHED' },
      ctx,
    ),
  );
  assert.equal(preview['status'], 'preview');
  assert.equal(fb.calls.length, 0);
  assert.ok(
    strings(preview['warnings']).some((w) => w.includes('video_reels')),
    'the preview states where a Reel is readable back from',
  );

  const applied = body(
    await tool('facebook_create_reel').handler(
      {
        video: media.name,
        description: 'Reel',
        video_state: 'PUBLISHED',
        apply: true,
        plan_id: 'plan-1',
      },
      ctx,
    ),
  );
  const result = record(applied['result']);
  assert.equal(result['videoState'], 'PUBLISHED');
  assert.equal(result['videoId'], 'reel-1');
  assert.equal(result['postId'], '100_reel');
  assert.equal(result['bytesSent'], media.bytes);
  assert.equal(result['isPublishedAndProcessed'], false);
  assert.match(String(result['quotaNote']), /24 h/);
  assert.match(String(result['readEdge']), /video_reels/);
  assert.ok(
    progress.some((p) => /start phase/.test(p.message ?? '')),
    'the three-phase flow reports its phases to the MCP client',
  );
  assert.ok(progress.some((p) => /finish phase/.test(p.message ?? '')));
});

test('create_reel is plan-bound when PUBLISHED and one-call when DRAFT', async (t) => {
  const media = await mediaFixture(t, 'reel.mp4', 1024);
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  stubReelPhases(fb, { success: true });

  const refused = body(
    await tool('facebook_create_reel').handler(
      { video: media.name, video_state: 'PUBLISHED', apply: true },
      ctx,
    ),
  );
  assert.equal(refused['status'], 'preview');
  assert.equal(fb.calls.length, 0, 'a Reel that would go live never uploads on one call');

  const applied = body(
    await tool('facebook_create_reel').handler(
      { video: media.name, video_state: 'DRAFT', apply: true },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'applied');
  assert.equal(record(applied['result'])['videoState'], 'DRAFT');
});

test('create_reel refuses video_state:"SCHEDULED" with no publish time', async (t) => {
  const media = await mediaFixture(t, 'reel.mp4', 512);
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  const result = await tool('facebook_create_reel').handler(
    { video: media.name, video_state: 'SCHEDULED' },
    ctx,
  );
  assert.equal(result.isError, true);
  const parsed = body(result);
  // The Reels planner owns its own window, so this is a reel-kind refusal
  // rather than the feed planner's `schedule_missing`.
  assert.equal(parsed['reason'], 'reel_schedule');
  assert.equal(parsed['retryable'], false);
  assert.match(String(parsed['operatorText']), /\S/);
  assert.equal(fb.calls.length, 0);
});

test('create_reel keeps Meta\u2019s own explanation and trace id on a phase failure', async (t) => {
  const media = await mediaFixture(t, 'reel.mp4', 512);
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  fb.on(
    (req) => req.protocol === 'json' && req.path === `/${PAGE_ID}/video_reels`,
    fbErr(
      new GraphApiError('Invalid parameter', {
        code: 100,
        subcode: 1363040,
        httpStatus: 400,
        fbtraceId: 'AbCtrace',
        userTitle: 'Video Too Long',
        userMessage: 'Reels must be 90 seconds or shorter.',
      }),
    ),
  );

  await tool('facebook_create_reel').handler({ video: media.name }, ctx);
  const result = await tool('facebook_create_reel').handler(
    { video: media.name, apply: true, plan_id: 'plan-1' },
    ctx,
  );

  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.match(String(parsed['reason']), /^reel_/);
  // "Invalid parameter" alone is not actionable: Meta's own title and message
  // are the reason the model can act on, and the trace id is what support asks for.
  assert.equal(parsed['userMessage'], 'Reels must be 90 seconds or shorter.');
  assert.equal(parsed['userTitle'], 'Video Too Long');
  assert.equal(parsed['subcode'], 1363040);
  assert.equal(parsed['fbtraceId'], 'AbCtrace');
});

test('create_reel does not invent a Graph code for a locally raised refusal', async (t) => {
  const media = await mediaFixture(t, 'reel.mp4', 512);
  const { ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  const parsed = body(
    await tool('facebook_create_reel').handler(
      { video: media.name, video_state: 'SCHEDULED' },
      ctx,
    ),
  );
  assert.equal(parsed['reason'], 'reel_schedule');
  assert.equal(
    Object.hasOwn(parsed, 'code'),
    false,
    'no Graph round trip, so no Graph code',
  );
  assert.equal(Object.hasOwn(parsed, 'httpStatus'), false);
});

test('create_reel maps the rolling 24 h quota error instead of leaking a generic failure', async (t) => {
  const media = await mediaFixture(t, 'reel.mp4', 512);
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  fb.on(
    (req) => req.protocol === 'json' && req.path === `/${PAGE_ID}/video_reels`,
    fbErr(
      new GraphApiError(
        'You have reached the limit of Reels you can publish per 24 hours',
        { code: 32, httpStatus: 400 },
      ),
    ),
  );

  await tool('facebook_create_reel').handler({ video: media.name }, ctx);
  const result = await tool('facebook_create_reel').handler(
    { video: media.name, apply: true, plan_id: 'plan-1' },
    ctx,
  );

  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'reel_quota');
  assert.equal(parsed['phase'], 'start');
  assert.equal(parsed['category'], 'rate_limit');
  assert.equal(
    parsed['retryable'],
    false,
    'a rolling-24 h quota must never become an in-process retry',
  );
  assert.ok(Number(parsed['retryAfterMs']) > 0, 'the caller is told how long to wait');
  assert.equal(parsed['nextTool'], 'facebook_usage');
  assert.match(String(parsed['operatorText']), /\S/);
  assert.equal(typeof parsed['verified'], 'boolean');
  assert.equal(
    fb.calls.filter((req) => req.protocol === 'rupload').length,
    0,
    'a quota refusal at the start phase streams no bytes',
  );
});

test('create_reel names the uploaded video_id when the finish phase fails', async (t) => {
  const media = await mediaFixture(t, 'reel.mp4', 512);
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  fb.on(
    (req) =>
      req.protocol === 'json' &&
      req.path === `/${PAGE_ID}/video_reels` &&
      record(req.params)['upload_phase'] === 'finish',
    fbErr(new GraphApiError('An unknown error occurred', { code: 1, httpStatus: 500 })),
  );
  stubReelPhases(fb, { success: true });

  await tool('facebook_create_reel').handler({ video: media.name }, ctx);
  const result = await tool('facebook_create_reel').handler(
    { video: media.name, apply: true, plan_id: 'plan-1' },
    ctx,
  );

  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['phase'], 'finish');
  assert.equal(
    parsed['videoId'],
    'reel-1',
    'the uploaded video exists at Meta, so the caller gets its id to inspect or delete it',
  );
});

// Only the finish phase can publish a Reel. An ambiguous start leaves at most an
// unused upload reservation, so journaling it as `attempted` would tell the
// operator a Reel may be live when none can be.
test('create_reel journals an ambiguous start as failed and an ambiguous finish as attempted', async (t) => {
  const media = await mediaFixture(t, 'reel.mp4', 512);
  const ambiguous = (): GraphApiError =>
    new GraphApiError('network fault: socket hang up', {
      code: 0,
      httpStatus: 0,
      action: {
        category: 'ambiguous',
        retryable: false,
        operatorText: 'outcome unknown',
      },
    });
  for (const phase of ['start', 'finish'] as const) {
    const { fb, ctx, journal } = makeCtx({
      settings: makeSettings({ mediaDir: media.dir }),
    });
    fb.on(
      (req) =>
        req.protocol === 'json' &&
        req.path === `/${PAGE_ID}/video_reels` &&
        record(req.params)['upload_phase'] === phase,
      fbErr(ambiguous()),
    );
    stubReelPhases(fb, { success: true });

    await tool('facebook_create_reel').handler({ video: media.name }, ctx);
    const result = await tool('facebook_create_reel').handler(
      { video: media.name, apply: true, plan_id: 'plan-1' },
      ctx,
    );

    assert.equal(result.isError, true, phase);
    assert.equal(body(result)['phase'], phase);
    const entry = journal.entries.at(-1);
    assert.ok(entry, phase);
    assert.equal(entry.outcome, phase === 'finish' ? 'attempted' : 'failed', phase);
  }
});

test('create_reel validates the shorter Reels schedule window in the dry run', async (t) => {
  const media = await mediaFixture(t, 'reel.mp4', 512);
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  stubPageTimezone(fb);

  const result = await tool('facebook_create_reel').handler(
    {
      video: media.name,
      video_state: 'SCHEDULED',
      // 40 days out: legal for a feed post (75 d) but past the 29 d Reels cap.
      scheduled_publish_time: '2026-02-10T12:00:00Z',
    },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.match(String(body(result)['error']), /29/);
  assert.equal(fb.calls.filter(isWrite).length, 0);
});

test('create_reel echoes a scheduled instant in UTC and Page-local time', async (t) => {
  const media = await mediaFixture(t, 'reel.mp4', 512);
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  stubPageTimezone(fb, 'Europe/Sofia');
  stubReelPhases(fb, { success: true });

  const preview = body(
    await tool('facebook_create_reel').handler(
      { video: media.name, video_state: 'SCHEDULED', scheduled_publish_time: SOON },
      ctx,
    ),
  );
  const echoed = strings(preview['warnings']).find((w) => w.startsWith('Publish time:'));
  assert.ok(echoed, 'the Reels preview carries the same echo line as a feed post');
  assert.match(echoed, /2026-01-05T12:00:00\.000Z \(UTC/);
  assert.match(echoed, /Europe\/Sofia/);

  const applied = body(
    await tool('facebook_create_reel').handler(
      {
        video: media.name,
        video_state: 'SCHEDULED',
        scheduled_publish_time: SOON,
        apply: true,
        plan_id: 'plan-1',
      },
      ctx,
    ),
  );
  const schedule = record(record(applied['result'])['schedule']);
  assert.equal(schedule['epochSeconds'], Date.parse(SOON) / 1000);
  assert.equal(schedule['pageTimezone'], 'Europe/Sofia');
  assert.ok(typeof schedule['pageLocal'] === 'string');
  const finish = findJson(fb, (req) => record(req.params)['upload_phase'] === 'finish');
  assert.equal(record(finish.params)['video_state'], 'SCHEDULED');
});

test('create_reel refuses a remote URL because the protocol streams local bytes', async () => {
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: '/tmp' }) });
  const result = await tool('facebook_create_reel').handler(
    { video: 'https://cdn.example/reel.mp4' },
    ctx,
  );
  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'unsupported_media_source');
  assert.match(String(parsed['error']), /facebook_create_video_post/);
  assert.equal(fb.calls.length, 0);
});

/**
 * A context whose write gate rewrites the media file after the handler has
 * resolved (and bound) its size, but before `perform()` reads the bytes — the
 * window in which an apply would otherwise upload a file the plan never showed.
 */
function withFileSwappedBeforePerform(
  ctx: ToolContext,
  path: string,
  bytes: number,
): ToolContext {
  const inner = (ctx as WriteToolContext).writeGate;
  const writeGate = {
    execute: async <T>(action: Parameters<typeof inner.execute<T>>[0]) => {
      await writeFile(path, Buffer.alloc(bytes, 9));
      return inner.execute(action);
    },
  };
  return { ...ctx, writeGate } as WriteToolContext;
}

test('create_video_post refuses to upload a local file whose size changed after it was bound', async (t) => {
  const media = await mediaFixture(t, 'clip.mp4', 64);
  const { fb, ctx, journal } = makeCtx({
    settings: makeSettings({ mediaDir: media.dir }),
  });
  stubVideoUploadPhases(fb, { video_id: 'vid-1', success: true });

  await tool('facebook_create_video_post').handler({ video: media.name }, ctx);
  const result = await tool('facebook_create_video_post').handler(
    { video: media.name, apply: true, plan_id: 'plan-1' },
    withFileSwappedBeforePerform(ctx, join(media.dir, media.name), 128),
  );

  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'file_changed');
  assert.equal(fb.calls.length, 0, 'no upload session is opened for unapproved bytes');
  assert.equal(journal.entries[0]?.outcome, 'failed');
});

test('create_reel refuses to upload a local file whose size changed after it was bound', async (t) => {
  const media = await mediaFixture(t, 'reel.mp4', 512);
  const { fb, ctx, journal } = makeCtx({
    settings: makeSettings({ mediaDir: media.dir }),
  });
  stubReelPhases(fb, { success: true });

  await tool('facebook_create_reel').handler({ video: media.name }, ctx);
  const result = await tool('facebook_create_reel').handler(
    { video: media.name, apply: true, plan_id: 'plan-1' },
    withFileSwappedBeforePerform(ctx, join(media.dir, media.name), 1024),
  );

  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'file_changed');
  assert.equal(fb.calls.length, 0, 'no Reel is started for unapproved bytes');
  assert.equal(journal.entries[0]?.outcome, 'failed');
});

// The same-size rewrites below keep the byte length the plan bound: a size
// check alone cannot see them, only the bound content hash can.

test('create_video_post refuses a same-size rewrite between the bound preview and the upload', async (t) => {
  const media = await mediaFixture(t, 'clip.mp4', 64);
  const { fb, ctx, journal } = makeCtx({
    settings: makeSettings({ mediaDir: media.dir }),
  });
  stubVideoUploadPhases(fb, { video_id: 'vid-1', success: true });

  await tool('facebook_create_video_post').handler({ video: media.name }, ctx);
  const result = await tool('facebook_create_video_post').handler(
    { video: media.name, apply: true, plan_id: 'plan-1' },
    withFileSwappedBeforePerform(ctx, join(media.dir, media.name), 64),
  );

  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'file_changed');
  assert.match(String(parsed['error']), /SHA-256/);
  assert.equal(fb.calls.length, 0, 'no upload session is opened for unapproved bytes');
  assert.equal(journal.entries[0]?.outcome, 'failed');
});

test('create_reel refuses a same-size rewrite between the bound preview and the upload', async (t) => {
  const media = await mediaFixture(t, 'reel.mp4', 512);
  const { fb, ctx, journal } = makeCtx({
    settings: makeSettings({ mediaDir: media.dir }),
  });
  stubReelPhases(fb, { success: true });

  await tool('facebook_create_reel').handler({ video: media.name }, ctx);
  const result = await tool('facebook_create_reel').handler(
    { video: media.name, apply: true, plan_id: 'plan-1' },
    withFileSwappedBeforePerform(ctx, join(media.dir, media.name), 512),
  );

  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'file_changed');
  assert.equal(fb.calls.length, 0, 'no Reel is started for unapproved bytes');
  assert.equal(journal.entries[0]?.outcome, 'failed');
});

test('create_photo_post refuses a same-size rewrite of a local photo between preview and upload', async (t) => {
  const media = await mediaFixture(t, 'shot.png', 96);
  const { fb, ctx, journal } = makeCtx({
    settings: makeSettings({ mediaDir: media.dir }),
  });
  fb.on((req) => req.protocol === 'multipart', fbOk({ id: 'photo-1', post_id: 'p_1' }));

  await tool('facebook_create_photo_post').handler({ photo: media.name }, ctx);
  const result = await tool('facebook_create_photo_post').handler(
    { photo: media.name, apply: true, plan_id: 'plan-1' },
    withFileSwappedBeforePerform(ctx, join(media.dir, media.name), 96),
  );

  assert.equal(result.isError, true);
  assert.equal(body(result)['reason'], 'file_changed');
  assert.equal(fb.calls.length, 0, 'no photo is uploaded for unapproved bytes');
  assert.equal(journal.entries[0]?.outcome, 'failed');
});

test('create_post refuses a same-size rewrite of a local carousel photo between preview and upload', async (t) => {
  const media = await mediaFixture(t, 'one.png', 96);
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  fb.on((req) => req.protocol === 'multipart', fbOk({ id: 'photo-1' }));

  await tool('facebook_create_post').handler(
    { message: 'Two photos', photos: [media.name, 'https://cdn.example/b.jpg'] },
    ctx,
  );
  const result = await tool('facebook_create_post').handler(
    {
      message: 'Two photos',
      photos: [media.name, 'https://cdn.example/b.jpg'],
      apply: true,
      plan_id: 'plan-1',
    },
    withFileSwappedBeforePerform(ctx, join(media.dir, media.name), 96),
  );

  // The carousel reports through its multi-photo envelope, which leads with
  // the original failure: the bound-hash refusal of the first child.
  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'multi_photo_upload_failed');
  assert.equal(parsed['failedIndex'], 0);
  assert.match(String(parsed['error']), /SHA-256/);
  assert.equal(fb.calls.length, 0, 'no carousel child is uploaded for unapproved bytes');
});

test('a same-size rewrite between preview and apply no longer matches the plan', async (t) => {
  // The content hash is part of what the preview binds, so the confirm of a
  // plan built for other bytes is a plan mismatch before anything is read.
  const media = await mediaFixture(t, 'clip.mp4', 64);
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  stubVideoUploadPhases(fb, { video_id: 'vid-1', success: true });

  await tool('facebook_create_video_post').handler({ video: media.name }, ctx);
  await writeFile(join(media.dir, media.name), Buffer.alloc(64, 9));
  const result = await tool('facebook_create_video_post').handler(
    { video: media.name, apply: true, plan_id: 'plan-1' },
    ctx,
  );

  assert.equal(result.isError, true);
  assert.equal(body(result)['reason'], 'plan_mismatch');
  assert.equal(fb.calls.length, 0);
});

test('an unchanged local video still applies under the plan its preview bound', async (t) => {
  const media = await mediaFixture(t, 'clip.mp4', 64);
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  stubVideoUploadPhases(fb, { video_id: 'vid-1', success: true });

  await tool('facebook_create_video_post').handler({ video: media.name }, ctx);
  const result = await tool('facebook_create_video_post').handler(
    { video: media.name, apply: true, plan_id: 'plan-1' },
    ctx,
  );

  assert.notEqual(result.isError, true, JSON.stringify(body(result)));
  assert.ok(fb.calls.length > 0);
});

// ---------------------------------------------------------------------------
// facebook_create_story
// ---------------------------------------------------------------------------

const isPagePost =
  (edge: string) =>
  (req: FbRequest): boolean =>
    req.method === 'POST' && req.path === `/${PAGE_ID}/${edge}`;

test('create_story previews with no mutation and applies the photo flow on its plan', async (t) => {
  const media = await mediaFixture(t, 'story.jpg', 256);
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  fb.on(isPagePost('photos'), fbOk({ id: 'ph-1' }));
  fb.on(isPagePost('photo_stories'), fbOk({ success: true, post_id: '100_story' }));

  const preview = body(
    await tool('facebook_create_story').handler(
      { media_type: 'photo', media: media.name },
      ctx,
    ),
  );
  assert.equal(preview['status'], 'preview');
  assert.equal(preview['tier'], 'irreversible');
  assert.equal(fb.calls.filter(isWrite).length, 0, 'a preview never uploads');
  assert.ok(strings(preview['warnings']).some((w) => /24 hours/.test(w)));

  const refused = body(
    await tool('facebook_create_story').handler(
      { media_type: 'photo', media: media.name, apply: true },
      ctx,
    ),
  );
  assert.equal(refused['status'], 'preview', 'an irreversible apply needs its plan_id');
  assert.equal(fb.calls.filter(isWrite).length, 0);

  const applied = body(
    await tool('facebook_create_story').handler(
      { media_type: 'photo', media: media.name, apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'applied', JSON.stringify(applied));
  const result = record(applied['result']);
  assert.equal(result['storyPostId'], '100_story');
  assert.equal(result['mediaId'], 'ph-1');
  assert.equal(result['verifyTool'], 'facebook_list_stories');
  const story = findJson(fb, (req) => req.path === `/${PAGE_ID}/photo_stories`);
  assert.deepEqual(story.params, { photo_id: 'ph-1' });
});

test('create_story refuses a path outside FB_MEDIA_DIR and AI labelling on a photo', async (t) => {
  const media = await mediaFixture(t, 'story.jpg', 256);
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });

  const outside = await tool('facebook_create_story').handler(
    { media_type: 'photo', media: '../../etc/passwd.jpg' },
    ctx,
  );
  assert.equal(outside.isError, true);

  const labelled = await tool('facebook_create_story').handler(
    { media_type: 'photo', media: media.name, is_ai_generated: true },
    ctx,
  );
  assert.equal(labelled.isError, true);
  assert.match(JSON.stringify(body(labelled)), /is_ai_generated/);

  const hosted = await tool('facebook_create_story').handler(
    { media_type: 'video', media: 'https://cdn.example.invalid/v.mp4' },
    ctx,
  );
  assert.equal(hosted.isError, true);
  assert.equal(fb.calls.length, 0);
});

test('create_story publishes a video story through start, transfer and finish', async (t) => {
  const media = await mediaFixture(t, 'story.mp4', 1024);
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  const phase = (name: string) => (req: FbRequest) =>
    req.protocol === 'json' &&
    req.path === `/${PAGE_ID}/video_stories` &&
    record(req.params)['upload_phase'] === name;
  fb.on(
    phase('start'),
    fbOk({ video_id: 'vs-1', upload_url: 'https://rupload.facebook.com/x/vs-1' }),
  );
  fb.on((req) => req.protocol === 'rupload', fbOk({ success: true }));
  fb.on(phase('finish'), fbOk({ success: true, post_id: '100_vs' }));

  await tool('facebook_create_story').handler(
    { media_type: 'video', media: media.name, is_ai_generated: false },
    ctx,
  );
  const applied = body(
    await tool('facebook_create_story').handler(
      {
        media_type: 'video',
        media: media.name,
        is_ai_generated: false,
        apply: true,
        plan_id: 'plan-1',
      },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'applied', JSON.stringify(applied));
  assert.equal(record(applied['result'])['mediaId'], 'vs-1');
  const finish = findJson(fb, phase('finish'));
  assert.equal(record(finish.params)['is_ai_generated'], false);
});

test('create_story reports an unconfirmed story step as attempted, never applied', async (t) => {
  const media = await mediaFixture(t, 'story.jpg', 256);
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  fb.on(isPagePost('photos'), fbOk({ id: 'ph-1' }));
  fb.on(isPagePost('photo_stories'), fbOk({}));

  await tool('facebook_create_story').handler(
    { media_type: 'photo', media: media.name },
    ctx,
  );
  const result = await tool('facebook_create_story').handler(
    { media_type: 'photo', media: media.name, apply: true, plan_id: 'plan-1' },
    ctx,
  );
  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['outcome'], 'attempted');
  assert.equal(parsed['reason'], 'story_unconfirmed');
  assert.equal(parsed['mediaId'], 'ph-1');
  assert.equal(
    fb.calls.filter((req) => req.method === 'DELETE').length,
    0,
    'a story that may have landed keeps its photo',
  );
});
