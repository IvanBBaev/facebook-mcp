// Tests for the `posts` tool package: path containment, update / delete failure
// classification, Page-token eviction and organic targeting.
//
// Split out of `posts.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/posts.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fbErr, fbOk } from '../core/fakes/index.js';
import { GraphApiError, ambiguousWriteAction } from '../core/index.js';
import { createPostsPackage } from './posts.js';
import {
  PAGE_ID,
  POST_ID,
  body,
  findJson,
  isWrite,
  jsonBody,
  makeCtx,
  makeSettings,
  mediaFixture,
  record,
  strings,
  stubPostState,
  stubVideoUploadPhases,
  tool,
} from '../testing/harness/posts.js';

// ---------------------------------------------------------------------------
// Path containment — an id must never be able to address another Graph node
// ---------------------------------------------------------------------------

test('update_post and delete_post refuse a post id that would address another Graph node', async () => {
  // `containPathname` receives the path ALREADY joined, so a `/` inside an
  // interpolated id becomes a new SEGMENT rather than an escaped character: a
  // `post_id` of "{page-id}/conversations" turns an advertised post write into a
  // request against the inbox, under the same Page token and the same HTTP
  // method. The fake below answers ANY path, so a regression shows up as the
  // call the last assertion says must not exist.
  for (const name of ['facebook_update_post', 'facebook_delete_post']) {
    const { fb, ctx } = makeCtx();
    fb.on(() => true, fbOk({ id: POST_ID, is_published: true, success: true }));

    for (const escaped of [
      `${PAGE_ID}/conversations`,
      'me/accounts',
      `${POST_ID}/comments?filter=stream`,
      '..',
      '.',
    ]) {
      const args =
        name === 'facebook_update_post'
          ? { post_id: escaped, action: 'edit', message: 'edited' }
          : { post_id: escaped };
      await assert.rejects(
        () => tool(name).handler(args, ctx),
        /bare Graph ID/,
        `${name} must refuse post_id ${JSON.stringify(escaped)}`,
      );
    }
    assert.equal(fb.calls.length, 0, `${name} let an escaped post id reach Graph`);
  }
});

test('the post-id shape still accepts every id Graph actually mints', () => {
  // Regression coverage: containment must not narrow Graph's ID space. These
  // shapes passed before the check existed and must keep passing after it.
  for (const name of ['facebook_update_post', 'facebook_delete_post']) {
    for (const ok of [
      POST_ID,
      '100200300_999888777',
      '1234567890',
      'act_123',
      't_1234567890',
      'v1.2-3_4',
    ]) {
      const args =
        name === 'facebook_update_post'
          ? { post_id: ok, action: 'edit', message: 'edited' }
          : { post_id: ok };
      assert.equal(
        tool(name).inputSchema.safeParse(args).success,
        true,
        `${name} must accept post_id ${JSON.stringify(ok)}`,
      );
    }
  }
});

test('feed schedule descriptions state the minimum lead the validator enforces', () => {
  // resolveSchedule accepts a time exactly 10 minutes ahead (the feed window is
  // inclusive), so "more than 10 minutes" makes the model pad a valid time or
  // doubt an accepted one. Reels are different: their window is strictly more
  // than 10 minutes, and their descriptions name 29 days, not 75.
  const feedFields: string[] = [];
  for (const spec of createPostsPackage().tools) {
    const { shape } = spec.inputSchema as unknown as {
      readonly shape: Record<string, { readonly description?: string } | undefined>;
    };
    const description = shape.scheduled_publish_time?.description ?? '';
    if (!/75 days/.test(description)) continue;
    feedFields.push(spec.name);
    assert.doesNotMatch(description, /more than 10 minutes/, spec.name);
    assert.match(description, /at least 10 minutes/, spec.name);
  }
  assert.ok(
    feedFields.length >= 2,
    `expected create and reschedule fields, got ${feedFields.join(',')}`,
  );
});

// ---------------------------------------------------------------------------
// update/delete failure classification — a write that may have landed
// ---------------------------------------------------------------------------

// The http client re-throws the caller's cancellation RAW (it is terminal and
// never retried) — including when it fires while the response body is still
// arriving, i.e. after Graph has already processed the request. That error is
// not a GraphApiError, so it carries no `ambiguous` stamp: without a classifier
// of its own, the gate files it as `failed`, and a journal that says a DELETE
// failed invites a second delete of a post the first one already removed.
function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError');
}

test('delete_post journals a delete cancelled in flight as attempted, not failed', async () => {
  const { fb, ctx, journal } = makeCtx();
  stubPostState(fb, { id: POST_ID, message: 'still here' });
  fb.on(
    (req) => req.method === 'DELETE' && req.path === `/${POST_ID}`,
    fbErr(abortError()),
  );

  await tool('facebook_delete_post').handler({ post_id: POST_ID }, ctx);
  await assert.rejects(
    () =>
      tool('facebook_delete_post').handler(
        { post_id: POST_ID, apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    /aborted/,
  );

  assert.equal(journal.entries.length, 1);
  assert.equal(
    journal.entries[0]?.outcome,
    'attempted',
    'a cancelled DELETE may already have removed the post; `failed` invites a second delete',
  );
});

test('update_post journals an edit cancelled in flight as attempted, not failed', async () => {
  const { fb, ctx, journal } = makeCtx();
  stubPostState(fb, { id: POST_ID, message: 'before' });
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
    fbErr(abortError()),
  );

  await tool('facebook_update_post').handler(
    { post_id: POST_ID, action: 'edit', message: 'after' },
    ctx,
  );
  await assert.rejects(
    () =>
      tool('facebook_update_post').handler(
        {
          post_id: POST_ID,
          action: 'edit',
          message: 'after',
          apply: true,
          plan_id: 'plan-1',
        },
        ctx,
      ),
    /aborted/,
  );

  assert.equal(journal.entries.length, 1);
  assert.equal(
    journal.entries[0]?.outcome,
    'attempted',
    'a cancelled edit may already have overwritten the text; `failed` asserts it did not',
  );
});

test('update_post and delete_post still journal a clean Graph refusal or a provably unsent write as failed', async () => {
  const refusals: readonly [string, Error][] = [
    [
      '4xx refusal',
      new GraphApiError('(#200) Permissions error', { code: 200, httpStatus: 400 }),
    ],
    [
      'connect-phase network fault',
      new GraphApiError('network error: connect ECONNREFUSED', {
        code: 0,
        httpStatus: 0,
      }),
    ],
  ];
  for (const [label, error] of refusals) {
    {
      const { fb, ctx, journal } = makeCtx();
      stubPostState(fb, { id: POST_ID, message: 'still here' });
      fb.on((req) => req.method === 'DELETE' && req.path === `/${POST_ID}`, fbErr(error));
      await tool('facebook_delete_post').handler({ post_id: POST_ID }, ctx);
      await tool('facebook_delete_post')
        .handler({ post_id: POST_ID, apply: true, plan_id: 'plan-1' }, ctx)
        .catch(() => undefined);
      assert.equal(journal.entries[0]?.outcome, 'failed', `delete, ${label}`);
    }
    {
      const { fb, ctx, journal } = makeCtx();
      stubPostState(fb, { id: POST_ID, message: 'before' });
      fb.on((req) => req.method === 'POST' && req.path === `/${POST_ID}`, fbErr(error));
      await tool('facebook_update_post').handler(
        { post_id: POST_ID, action: 'edit', message: 'after' },
        ctx,
      );
      await tool('facebook_update_post')
        .handler(
          {
            post_id: POST_ID,
            action: 'edit',
            message: 'after',
            apply: true,
            plan_id: 'plan-1',
          },
          ctx,
        )
        .catch(() => undefined);
      assert.equal(journal.entries[0]?.outcome, 'failed', `update, ${label}`);
    }
  }
});

test('get_video_status names the field facebook_create_video_post actually returns', () => {
  // The create result carries the id as `videoId`; a model told to look for
  // `video_id` in it finds nothing and may conclude no video was created.
  const { description } = tool('facebook_get_video_status');
  assert.doesNotMatch(description, /returns a video_id/);
  assert.match(description, /`videoId`/);
});

// ---------------------------------------------------------------------------
// Page-token eviction on a failure this package shapes itself (C1)
// ---------------------------------------------------------------------------

// The server evicts a derived Page token when a tool THROWS a token-dead Graph
// error (190, 102, or 100 with a stale-object subcode). The failures below are
// caught here and returned as an `isError` record, so the server never sees
// them: unless this package evicts the token itself, every retry for the next
// cache TTL replays the same dead token and fails the same way.
function tokenDeadErrors(): readonly [string, GraphApiError][] {
  return [
    [
      '190',
      new GraphApiError('Error validating access token', { code: 190, httpStatus: 400 }),
    ],
    ['102', new GraphApiError('Session has expired', { code: 102, httpStatus: 400 })],
    [
      '100/33',
      new GraphApiError('Unsupported post request', {
        code: 100,
        subcode: 33,
        httpStatus: 400,
      }),
    ],
  ];
}

test('create_reel drops the cached Page token when a phase fails on a dead token', async (t) => {
  const media = await mediaFixture(t, 'reel.mp4', 512);
  for (const [label, error] of tokenDeadErrors()) {
    const { fb, ctx, pages } = makeCtx({
      settings: makeSettings({ mediaDir: media.dir }),
    });
    fb.on(
      (req) => req.protocol === 'json' && req.path === `/${PAGE_ID}/video_reels`,
      fbErr(error),
    );
    await tool('facebook_create_reel').handler({ video: media.name }, ctx);
    const result = await tool('facebook_create_reel').handler(
      { video: media.name, apply: true, plan_id: 'plan-1' },
      ctx,
    );
    assert.equal(result.isError, true, label);
    assert.match(String(body(result)['reason']), /^reel_/, label);
    assert.deepEqual(pages.invalidated, [PAGE_ID], `${label}: Page token evicted`);
  }
});

test('create_reel keeps the cached Page token on a phase failure that is not token-dead', async (t) => {
  const media = await mediaFixture(t, 'reel.mp4', 512);
  const { fb, ctx, pages } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  fb.on(
    (req) => req.protocol === 'json' && req.path === `/${PAGE_ID}/video_reels`,
    fbErr(
      new GraphApiError('Invalid parameter', {
        code: 100,
        subcode: 1363040,
        httpStatus: 400,
      }),
    ),
  );
  await tool('facebook_create_reel').handler({ video: media.name }, ctx);
  const result = await tool('facebook_create_reel').handler(
    { video: media.name, apply: true, plan_id: 'plan-1' },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.deepEqual(
    pages.invalidated,
    [],
    'a content refusal says nothing about the token',
  );
});

test('create_post drops the cached Page token when the carousel post fails on a dead token', async () => {
  for (const [label, error] of tokenDeadErrors()) {
    const { fb, ctx, pages } = makeCtx();
    fb.on(
      (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`,
      fbOk({ id: 'ph-1' }),
      1,
    );
    fb.on(
      (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`,
      fbOk({ id: 'ph-2' }),
      1,
    );
    fb.on(
      (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
      fbErr(error),
    );
    fb.on((req) => req.method === 'DELETE', fbOk({ success: true }));

    const photos = ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'];
    await tool('facebook_create_post').handler({ message: 'Gallery', photos }, ctx);
    const result = await tool('facebook_create_post').handler(
      { message: 'Gallery', photos, apply: true, plan_id: 'plan-1' },
      ctx,
    );
    assert.equal(result.isError, true, label);
    assert.equal(body(result)['reason'], 'carousel_post_failed', label);
    assert.deepEqual(pages.invalidated, [PAGE_ID], `${label}: Page token evicted`);
  }
});

test('create_post drops the cached Page token when a carousel child upload fails on a dead token', async () => {
  for (const [label, error] of tokenDeadErrors()) {
    const { fb, ctx, pages } = makeCtx();
    fb.on(
      (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`,
      fbOk({ id: 'ph-1' }),
      1,
    );
    fb.on(
      (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`,
      fbErr(error),
      1,
    );
    fb.on((req) => req.method === 'DELETE', fbOk({ success: true }));

    const photos = ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'];
    await tool('facebook_create_post').handler({ photos }, ctx);
    const result = await tool('facebook_create_post').handler(
      { photos, apply: true, plan_id: 'plan-1' },
      ctx,
    );
    assert.equal(result.isError, true, label);
    assert.equal(body(result)['reason'], 'multi_photo_upload_failed', label);
    assert.deepEqual(pages.invalidated, [PAGE_ID], `${label}: Page token evicted`);
  }
});

// ---------------------------------------------------------------------------
// update/delete — a 5xx the http layer stamped ambiguous
// ---------------------------------------------------------------------------

test('update_post and delete_post journal a 5xx the transport stamped ambiguous as attempted', async () => {
  const ambiguous = (): GraphApiError =>
    new GraphApiError('ambiguous write outcome (HTTP 502) — do NOT retry; verify first', {
      code: 1,
      httpStatus: 502,
      action: ambiguousWriteAction({ detail: 'HTTP 502' }),
    });
  {
    const { fb, ctx, journal } = makeCtx();
    stubPostState(fb, { id: POST_ID, message: 'still here' });
    fb.on(
      (req) => req.method === 'DELETE' && req.path === `/${POST_ID}`,
      fbErr(ambiguous()),
    );
    await tool('facebook_delete_post').handler({ post_id: POST_ID }, ctx);
    await assert.rejects(() =>
      tool('facebook_delete_post').handler(
        { post_id: POST_ID, apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    );
    assert.equal(journal.entries.length, 1);
    assert.equal(
      journal.entries[0]?.outcome,
      'attempted',
      'a 5xx DELETE may have removed the post; `failed` invites a second delete',
    );
  }
  {
    const { fb, ctx, journal } = makeCtx();
    stubPostState(fb, { id: POST_ID, message: 'before' });
    fb.on(
      (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
      fbErr(ambiguous()),
    );
    await tool('facebook_update_post').handler(
      { post_id: POST_ID, action: 'edit', message: 'after' },
      ctx,
    );
    await assert.rejects(() =>
      tool('facebook_update_post').handler(
        {
          post_id: POST_ID,
          action: 'edit',
          message: 'after',
          apply: true,
          plan_id: 'plan-1',
        },
        ctx,
      ),
    );
    assert.equal(journal.entries.length, 1);
    assert.equal(
      journal.entries[0]?.outcome,
      'attempted',
      'a 5xx edit may have landed; `failed` asserts it did not',
    );
  }
});

// ---------------------------------------------------------------------------
// Organic targeting on the three create tools
// ---------------------------------------------------------------------------

const TARGETING = { geo_locations: { countries: ['BG', 'RO'] }, age_min: 18 } as const;
const TARGETING_WIRE = '{"geo_locations":{"countries":["BG","RO"]},"age_min":18}';

test('create_post previews the audience line and both targeting notes', async () => {
  const { fb, ctx } = makeCtx();
  const preview = body(
    await tool('facebook_create_post').handler(
      { message: 'Regional offer', targeting: TARGETING },
      ctx,
    ),
  );
  assert.equal(preview['status'], 'preview');
  assert.match(String(preview['summary']), /Audience: countries BG, RO; age 18\+/);
  const warnings = strings(preview['warnings']);
  assert.ok(warnings.some((w) => /not a privacy control/.test(w)));
  assert.ok(warnings.some((w) => /Meta location ids/.test(w)));
  assert.equal(fb.calls.filter(isWrite).length, 0);
});

test('create_post sends the bound targeting and echoes it in the result', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
    fbOk({ id: '100_2001' }),
  );
  await tool('facebook_create_post').handler(
    { message: 'Hi', targeting: TARGETING },
    ctx,
  );
  const applied = body(
    await tool('facebook_create_post').handler(
      { message: 'Hi', targeting: TARGETING, apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'applied');
  const feed = findJson(
    fb,
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
  );
  assert.equal(jsonBody(feed)['targeting'], TARGETING_WIRE);
  assert.deepEqual(record(applied['result'])['targetingEcho'], TARGETING);
});

test('create_post refuses an apply whose targeting changed since the preview', async () => {
  const { fb, ctx } = makeCtx();
  await tool('facebook_create_post').handler(
    { message: 'Hi', targeting: TARGETING },
    ctx,
  );
  const result = await tool('facebook_create_post').handler(
    {
      message: 'Hi',
      targeting: { ...TARGETING, age_min: 21 },
      apply: true,
      plan_id: 'plan-1',
    },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.equal(body(result)['reason'], 'plan_mismatch');
  assert.equal(fb.calls.filter(isWrite).length, 0);
});

test('create_photo_post passes targeting through to the photo upload', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`,
    fbOk({ id: 'ph-1', post_id: '100_3001' }),
  );
  const applied = body(
    await tool('facebook_create_photo_post').handler(
      {
        photo: 'https://cdn.example/a.jpg',
        published: false,
        targeting: TARGETING,
        apply: true,
      },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'applied');
  const upload = findJson(fb, (req) => req.path === `/${PAGE_ID}/photos`);
  assert.equal(jsonBody(upload)['targeting'], TARGETING_WIRE);
  assert.deepEqual(record(applied['result'])['targetingEcho'], TARGETING);
});

test('create_video_post sends targeting on the finish phase of a local upload', async (t) => {
  const media = await mediaFixture(t, 'clip.mp4', 64);
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  stubVideoUploadPhases(fb, { video_id: 'vid-1', success: true });
  const applied = body(
    await tool('facebook_create_video_post').handler(
      { video: media.name, published: false, targeting: TARGETING, apply: true },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'applied');
  const finish = findJson(fb, (req) => record(req.body)['upload_phase'] === 'finish');
  assert.equal(jsonBody(finish)['targeting'], TARGETING_WIRE);
  const start = findJson(fb, (req) => record(req.body)['upload_phase'] === 'start');
  assert.equal(jsonBody(start)['targeting'], undefined, 'only the finish carries it');
});

test('the targeting schema refuses age 16, lowercase codes and an empty restriction', () => {
  const schema = tool('facebook_create_post').inputSchema;
  for (const targeting of [
    { age_min: 16 },
    { geo_locations: { countries: ['bg'] } },
    { geo_locations: {} },
    {},
    { geo_locations: { countries: ['BG'], zips: ['1000'] } },
  ]) {
    assert.equal(
      schema.safeParse({ message: 'x', targeting }).success,
      false,
      JSON.stringify(targeting),
    );
  }
  for (const name of ['facebook_create_photo_post', 'facebook_create_video_post']) {
    assert.equal(
      tool(name).inputSchema.safeParse({
        [name.includes('photo') ? 'photo' : 'video']: 'a',
        targeting: TARGETING,
      }).success,
      true,
      name,
    );
  }
  assert.equal(
    tool('facebook_update_post').inputSchema.safeParse({
      post_id: POST_ID,
      action: 'edit',
      message: 'x',
      targeting: TARGETING,
    }).success,
    false,
    'update_post does not take targeting',
  );
});
