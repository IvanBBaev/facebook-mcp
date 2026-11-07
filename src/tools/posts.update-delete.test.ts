// Tests for the `posts` tool package: facebook_update_post and facebook_delete_post.
//
// Split out of `posts.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/posts.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fbErr, fbOk, type FakeFbRequest } from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import {
  PAGE_ID,
  POST_ID,
  SOON,
  body,
  findJson,
  isWrite,
  jsonBody,
  makeCtx,
  record,
  strings,
  stubPageTimezone,
  stubPostGoneAfterDelete,
  stubPostState,
  tool,
} from '../testing/harness/posts.js';

// ---------------------------------------------------------------------------
// facebook_update_post
// ---------------------------------------------------------------------------

test('update_post previews an edit, then applies it against the unchanged post', async () => {
  const { fb, ctx } = makeCtx();
  stubPostState(fb, {
    id: POST_ID,
    message: 'old text',
    is_published: true,
    created_time: '2025-12-20T10:00:00+0000',
  });
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
    fbOk({ success: true }),
  );

  const preview = body(
    await tool('facebook_update_post').handler(
      { post_id: POST_ID, action: 'edit', message: 'new text' },
      ctx,
    ),
  );
  assert.equal(preview['status'], 'preview');
  assert.equal(
    fb.calls.filter(isWrite).length,
    0,
    'the dry run reads the post but writes nothing',
  );

  const applied = body(
    await tool('facebook_update_post').handler(
      {
        post_id: POST_ID,
        action: 'edit',
        message: 'new text',
        apply: true,
        plan_id: 'plan-1',
      },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'applied');
  const result = record(applied['result']);
  assert.equal(result['action'], 'edit');
  assert.deepEqual(result['changed'], { message: 'new text' });
  const write = findJson(
    fb,
    (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
  );
  assert.deepEqual(jsonBody(write), { message: 'new text' });
});

test('update_post detects divergence when the post changed after the preview', async () => {
  const { fb, ctx } = makeCtx();
  stubPostState(
    fb,
    { id: POST_ID, message: 'old text', is_published: true },
    1, // the plan-time read
  );
  stubPostState(fb, {
    id: POST_ID,
    message: 'someone else edited it',
    is_published: true,
  });

  await tool('facebook_update_post').handler(
    { post_id: POST_ID, action: 'edit', message: 'new text' },
    ctx,
  );
  const applied = body(
    await tool('facebook_update_post').handler(
      {
        post_id: POST_ID,
        action: 'edit',
        message: 'new text',
        apply: true,
        plan_id: 'plan-1',
      },
      ctx,
    ),
  );

  assert.equal(applied['status'], 'diverged');
  assert.equal(applied['applied'], false);
  const diverged = applied['diverged'];
  assert.ok(Array.isArray(diverged) && diverged.length > 0, 'the diff is reported');
  assert.match(String(applied['notPerformedNotice']), /nothing was written/);
  assert.equal(
    fb.calls.filter(isWrite).length,
    0,
    'a diverged apply performs no mutation',
  );
});

/** Stub the F7 single-pin probe (`GET /{page-id}/feed?fields=id,is_pinned`). */
function stubFeedPins(
  fb: FakeFbRequest,
  rows: readonly Record<string, unknown>[],
  times?: number,
): void {
  fb.on(
    (req) => req.method === 'GET' && req.path === `/${PAGE_ID}/feed`,
    fbOk({ data: rows }),
    times,
  );
}

test('update_post pinning names the post it replaces and journals it', async () => {
  const { fb, ctx, journal } = makeCtx();
  stubPostState(fb, { id: POST_ID, message: 'hi', is_published: true });
  stubFeedPins(fb, [
    { id: POST_ID, is_pinned: false },
    { id: '100_444', is_pinned: true },
  ]);
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
    fbOk({ success: true }),
  );
  const args = { post_id: POST_ID, action: 'edit', is_pinned: true };

  const preview = body(await tool('facebook_update_post').handler(args, ctx));
  const warnings = strings(preview['warnings']);
  assert.ok(
    warnings.some((w) => w.includes('replaces the currently pinned post 100_444')),
  );
  assert.ok(warnings.some((w) => /no longer documents/.test(w)));
  const probe = findJson(fb, (req) => req.path === `/${PAGE_ID}/feed`);
  assert.equal(probe.params?.['fields'], 'id,is_pinned');
  assert.equal(probe.params?.['limit'], 25);

  const applied = body(
    await tool('facebook_update_post').handler(
      { ...args, apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'applied');
  assert.deepEqual(jsonBody(findJson(fb, (req) => req.method === 'POST')), {
    is_pinned: true,
  });
  assert.equal(journal.entries.at(-1)?.metadata?.['previouslyPinnedPostId'], '100_444');
});

test('update_post pinning warns about nothing when no other post is pinned', async () => {
  const { fb, ctx } = makeCtx();
  stubPostState(fb, { id: POST_ID, is_published: true });
  stubFeedPins(fb, [
    { id: POST_ID, is_pinned: true },
    { id: '100_444', is_pinned: false },
  ]);
  const preview = body(
    await tool('facebook_update_post').handler(
      { post_id: POST_ID, action: 'edit', is_pinned: true },
      ctx,
    ),
  );
  assert.ok(
    !strings(preview['warnings']).some((w) => w.includes('replaces the currently')),
  );
});

test('update_post pinning survives a failed pin probe', async () => {
  const { fb, ctx } = makeCtx();
  stubPostState(fb, { id: POST_ID, is_published: true });
  fb.on(
    (req) => req.method === 'GET' && req.path === `/${PAGE_ID}/feed`,
    fbErr(new GraphApiError('nope', { code: 100, httpStatus: 400 })),
  );
  const preview = body(
    await tool('facebook_update_post').handler(
      { post_id: POST_ID, action: 'edit', is_pinned: true },
      ctx,
    ),
  );
  assert.equal(preview['status'], 'preview');
});

test('update_post diverges when another post was pinned after the preview', async () => {
  const { fb, ctx } = makeCtx();
  stubPostState(fb, { id: POST_ID, is_published: true });
  stubFeedPins(fb, [{ id: '100_444', is_pinned: true }], 1);
  stubFeedPins(fb, [{ id: '100_333', is_pinned: true }]);
  const args = { post_id: POST_ID, action: 'edit', is_pinned: true };

  await tool('facebook_update_post').handler(args, ctx);
  const applied = body(
    await tool('facebook_update_post').handler(
      { ...args, apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'diverged');
  assert.equal(fb.calls.filter(isWrite).length, 0);
});

test('update_post unpinning does not probe the feed', async () => {
  const { fb, ctx } = makeCtx();
  stubPostState(fb, { id: POST_ID, is_published: true });
  await tool('facebook_update_post').handler(
    { post_id: POST_ID, action: 'edit', is_pinned: false },
    ctx,
  );
  assert.equal(fb.calls.filter((req) => req.path === `/${PAGE_ID}/feed`).length, 0);
});

test('update_post publish_now flips is_published and warns about the race', async () => {
  const { fb, ctx } = makeCtx();
  stubPostState(fb, {
    id: POST_ID,
    is_published: false,
    scheduled_publish_time: 1_800_000_000,
  });
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
    fbOk({ success: true }),
  );

  const preview = body(
    await tool('facebook_update_post').handler(
      { post_id: POST_ID, action: 'publish_now' },
      ctx,
    ),
  );
  assert.ok(
    strings(preview['warnings']).length > 0,
    'publishing early carries operator notes',
  );

  const applied = body(
    await tool('facebook_update_post').handler(
      { post_id: POST_ID, action: 'publish_now', apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'applied');
  const write = findJson(
    fb,
    (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
  );
  assert.equal(jsonBody(write)['is_published'], true);
});

test('update_post publish_now is plan-bound, an edit under the same mode is not', async () => {
  // publish_now reaches a live audience exactly as create_post published:true
  // does, so no write mode may perform it from a bare apply:true; an edit
  // reaches nobody new and stays ungated, which is what keeps the gate honest.
  const { fb, ctx } = makeCtx({ writeMode: 'apply' });
  stubPostState(fb, {
    id: POST_ID,
    is_published: false,
    scheduled_publish_time: 1_800_000_000,
  });
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
    fbOk({ success: true }),
  );

  const bare = body(
    await tool('facebook_update_post').handler(
      { post_id: POST_ID, action: 'publish_now', apply: true },
      ctx,
    ),
  );
  assert.equal(bare['status'], 'preview');
  assert.ok(
    strings(bare['warnings']).some((w) => w.includes('plan_id')),
    'the preview must say what the call still owes',
  );
  assert.equal(
    fb.calls.filter((r) => r.protocol === 'json' && r.method === 'POST').length,
    0,
    'nothing may be published',
  );

  const edited = body(
    await tool('facebook_update_post').handler(
      { post_id: POST_ID, action: 'edit', message: 'Fixed a typo.', apply: true },
      ctx,
    ),
  );
  assert.equal(edited['status'], 'applied');
});

test('update_post names the read that shows the change it applied, not a publish note', async () => {
  // An edit or a reschedule is not a publish: "A publish that times out ...
  // verify with facebook_list_posts" sends the model to a listing that cannot
  // show a changed text or a moved time (a rescheduled post is not on it at all).
  const cases = [
    {
      input: { action: 'edit', message: 'new text' },
      state: { id: POST_ID, message: 'old', is_published: true },
      expected: /facebook_get_post/,
    },
    {
      input: { action: 'reschedule', scheduled_publish_time: SOON },
      state: {
        id: POST_ID,
        is_published: false,
        created_time: '2025-12-20T10:00:00+0000',
      },
      expected: /facebook_list_scheduled_posts/,
    },
  ];
  for (const { input, state, expected } of cases) {
    const { fb, ctx } = makeCtx();
    stubPageTimezone(fb, 'Europe/Sofia');
    stubPostState(fb, state);
    fb.on(
      (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
      fbOk({ success: true }),
    );
    const args = { post_id: POST_ID, ...input };
    await tool('facebook_update_post').handler(args, ctx);
    const applied = body(
      await tool('facebook_update_post').handler(
        { ...args, apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    );
    assert.equal(applied['status'], 'applied', input.action);
    const note = String(record(applied['result'])['verifyNote']);
    assert.doesNotMatch(note, /A publish/, `${input.action}: ${note}`);
    assert.doesNotMatch(note, /facebook_list_posts/, `${input.action}: ${note}`);
    assert.match(note, expected, `${input.action}: ${note}`);
  }
});

test('update_post publish_now keeps the publish verify note', async () => {
  const { fb, ctx } = makeCtx();
  stubPostState(fb, {
    id: POST_ID,
    is_published: false,
    scheduled_publish_time: 1_800_000_000,
  });
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
    fbOk({ success: true }),
  );
  const args = { post_id: POST_ID, action: 'publish_now' };
  await tool('facebook_update_post').handler(args, ctx);
  const applied = body(
    await tool('facebook_update_post').handler(
      { ...args, apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'applied');
  const note = String(record(applied['result'])['verifyNote']);
  assert.match(note, /A publish_now/);
  assert.match(note, /facebook_get_post/);
});

test('update_post publish_now names a check the caller can actually run on the plan it holds', async () => {
  // publish_now sends only is_published:true — the plan carries no message text
  // and no created_time to match on a listing, and the post id is known. The
  // one read that shows whether it went live is the post itself.
  const { fb, ctx } = makeCtx();
  stubPostState(fb, {
    id: POST_ID,
    is_published: false,
    scheduled_publish_time: 1_800_000_000,
  });
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
    fbOk({ success: true }),
  );
  const args = { post_id: POST_ID, action: 'publish_now' };
  const preview = body(await tool('facebook_update_post').handler(args, ctx));
  const applied = body(
    await tool('facebook_update_post').handler(
      { ...args, apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'applied');
  const note = String(record(applied['result'])['verifyNote']);
  const warning = strings(preview['warnings']).find((w) => /times out/.test(w));
  for (const [label, text] of [
    ['verifyNote', note],
    ['preview warning', String(warning)],
  ] as const) {
    assert.match(text, /facebook_get_post/, `${label}: ${text}`);
    assert.match(text, /is_published/, `${label}: ${text}`);
    assert.doesNotMatch(text, /message text/, `${label}: ${text}`);
  }
});

test('update_post reschedules within the window and echoes both timezones', async () => {
  const { fb, ctx } = makeCtx();
  stubPageTimezone(fb, 'Europe/Sofia');
  stubPostState(fb, {
    id: POST_ID,
    is_published: false,
    created_time: '2025-12-20T10:00:00+0000',
  });
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
    fbOk({ success: true }),
  );

  const preview = body(
    await tool('facebook_update_post').handler(
      { post_id: POST_ID, action: 'reschedule', scheduled_publish_time: SOON },
      ctx,
    ),
  );
  const echoed = strings(preview['warnings']).find((w) => w.startsWith('Publish time:'));
  assert.ok(echoed);
  assert.match(echoed, /Europe\/Sofia/);

  const applied = body(
    await tool('facebook_update_post').handler(
      {
        post_id: POST_ID,
        action: 'reschedule',
        scheduled_publish_time: SOON,
        apply: true,
        plan_id: 'plan-1',
      },
      ctx,
    ),
  );
  const write = findJson(
    fb,
    (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
  );
  assert.equal(jsonBody(write)['scheduled_publish_time'], Date.parse(SOON) / 1000);
  assert.equal(
    record(record(applied['result'])['schedule'])['pageTimezone'],
    'Europe/Sofia',
  );
});

test('update_post refuses a reschedule past 29 days from the original creation', async () => {
  const { fb, ctx } = makeCtx();
  stubPageTimezone(fb);
  stubPostState(fb, {
    id: POST_ID,
    is_published: false,
    // Created 25 days before "now": only 4 days of the 29-day allowance remain.
    created_time: '2025-12-07T00:00:00+0000',
  });

  const result = await tool('facebook_update_post').handler(
    {
      post_id: POST_ID,
      action: 'reschedule',
      scheduled_publish_time: '2026-02-01T12:00:00Z',
    },
    ctx,
  );
  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'schedule_reschedule_window');
  assert.match(String(parsed['help']), /ISO-8601/);
  assert.equal(fb.calls.filter(isWrite).length, 0);
});

test('update_post answers cancel_schedule with the delete path Graph actually offers', async () => {
  const { fb, ctx } = makeCtx();
  stubPostState(fb, { id: POST_ID, is_published: false });

  const result = await tool('facebook_update_post').handler(
    { post_id: POST_ID, action: 'cancel_schedule' },
    ctx,
  );
  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'unsupported_transition');
  assert.match(String(parsed['error']), /facebook_delete_post/);
  assert.match(String(parsed['error']), /plan_id/);
  assert.equal(fb.calls.filter(isWrite).length, 0);
});

test('update_post refuses an edit with no field to change', async () => {
  const { fb, ctx } = makeCtx();
  stubPostState(fb, { id: POST_ID, message: 'text' });
  const result = await tool('facebook_update_post').handler(
    { post_id: POST_ID, action: 'edit' },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.equal(body(result)['reason'], 'no_update_fields');
  assert.equal(fb.calls.filter(isWrite).length, 0);
});

test('update_post refuses to plan against a post it cannot read', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'GET' && req.path === `/${POST_ID}`,
    fbErr(
      new GraphApiError('Unsupported get request. Object does not exist', {
        code: 100,
        subcode: 33,
        httpStatus: 400,
      }),
    ),
  );

  const result = await tool('facebook_update_post').handler(
    { post_id: POST_ID, action: 'edit', message: 'new' },
    ctx,
  );
  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['field'], 'post_id');
  assert.match(String(parsed['hint']), /facebook_list_scheduled_posts/);
});

test('update_post publish_now refuses a post that is already live instead of claiming it published it', async () => {
  // is_published:true on a live post changes nothing; a preview saying
  // "Publish scheduled/draft post ... right now" and an `applied` result would
  // tell the operator this call put the post in front of the audience.
  const { fb, ctx } = makeCtx();
  stubPostState(fb, {
    id: POST_ID,
    message: 'live since yesterday',
    is_published: true,
    created_time: '2025-12-31T10:00:00+0000',
  });
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
    fbOk({ success: true }),
  );

  const result = await tool('facebook_update_post').handler(
    { post_id: POST_ID, action: 'publish_now' },
    ctx,
  );
  const parsed = body(result);
  assert.equal(
    result.isError,
    true,
    `expected a refusal, got ${String(parsed['summary'])}`,
  );
  assert.equal(parsed['field'], 'action');
  assert.match(String(parsed['message'] ?? parsed['error']), /already published/);
  assert.equal(fb.calls.filter(isWrite).length, 0);
});

test('update_post reschedule refuses a post that is already live instead of claiming it moved it', async () => {
  // A live post has no publish time left to move: previewing "Move post ... to
  // <time>" and applying it would tell the operator the post now waits for that
  // instant, while it stays in front of the audience.
  const { fb, ctx } = makeCtx();
  stubPageTimezone(fb);
  stubPostState(fb, {
    id: POST_ID,
    message: 'live since yesterday',
    is_published: true,
    created_time: '2025-12-31T10:00:00+0000',
  });
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
    fbOk({ success: true }),
  );

  const result = await tool('facebook_update_post').handler(
    { post_id: POST_ID, action: 'reschedule', scheduled_publish_time: SOON },
    ctx,
  );
  const parsed = body(result);
  assert.equal(
    result.isError,
    true,
    `expected a refusal, got ${String(parsed['summary'])}`,
  );
  assert.equal(parsed['field'], 'action');
  assert.match(String(parsed['error']), /already published/);
  assert.match(String(parsed['hint']), /facebook_delete_post/);
  assert.equal(fb.calls.filter(isWrite).length, 0);
});

// ---------------------------------------------------------------------------
// facebook_delete_post
// ---------------------------------------------------------------------------

test('delete_post refuses to apply without a plan_id even with apply:true', async () => {
  const { fb, ctx } = makeCtx({ writeMode: 'apply' });
  stubPostState(fb, { id: POST_ID, message: 'still here' });

  const result = body(
    await tool('facebook_delete_post').handler({ post_id: POST_ID, apply: true }, ctx),
  );
  assert.equal(result['status'], 'preview');
  assert.equal(result['applied'], false);
  assert.equal(result['tier'], 'irreversible');
  assert.ok(
    strings(result['warnings']).some((w) => w.includes('plan_id')),
    'the caller is told WHY the apply degraded to a preview, not just that it did',
  );
  assert.equal(
    fb.calls.filter((req) => req.method === 'DELETE').length,
    0,
    'an unbound irreversible apply deletes nothing, even in FB_WRITE_MODE=apply',
  );
});

test('delete_post applies only when apply:true is bound to the plan id', async () => {
  const { fb, ctx } = makeCtx();
  stubPostState(fb, { id: POST_ID, message: 'still here' });
  fb.on(
    (req) => req.method === 'DELETE' && req.path === `/${POST_ID}`,
    fbOk({ success: true }),
  );

  const preview = body(
    await tool('facebook_delete_post').handler({ post_id: POST_ID }, ctx),
  );
  assert.equal(preview['planId'], 'plan-1');
  assert.match(String(preview['notPerformedNotice']), /still exists/);
  assert.ok(
    strings(preview['warnings']).some((w) => /permanent|cannot be undone/i.test(w)),
    'the preview states that the deletion is permanent',
  );

  const applied = body(
    await tool('facebook_delete_post').handler(
      { post_id: POST_ID, apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'applied');
  const result = record(applied['result']);
  assert.equal(result['deleted'], true);
  assert.equal(result['alreadyAbsent'], false);
  assert.equal(fb.calls.filter((req) => req.method === 'DELETE').length, 1);
});

test('delete_post reports an already-absent post as done without claiming it deleted it', async () => {
  const { fb, ctx } = makeCtx();
  // The re-read after the refused DELETE agrees the post is gone.
  stubPostGoneAfterDelete(fb);
  stubPostState(fb, { id: POST_ID, message: 'here for now' }, 1);
  stubPostState(fb, { id: POST_ID, message: 'here for now' });
  fb.on(
    (req) => req.method === 'DELETE' && req.path === `/${POST_ID}`,
    fbErr(
      new GraphApiError('Unsupported delete request. Object does not exist', {
        code: 100,
        subcode: 33,
        httpStatus: 400,
      }),
    ),
  );

  await tool('facebook_delete_post').handler({ post_id: POST_ID }, ctx);
  const applied = body(
    await tool('facebook_delete_post').handler(
      { post_id: POST_ID, apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  const result = record(applied['result']);
  assert.equal(result['deleted'], false);
  assert.equal(result['alreadyAbsent'], true);
  assert.match(String(result['note']), /\S/);
});

test('delete_post diverges when the post disappears between preview and apply', async () => {
  const { fb, ctx } = makeCtx();
  stubPostState(fb, { id: POST_ID, message: 'here for now' }, 1);
  fb.on(
    (req) => req.method === 'GET' && req.path === `/${POST_ID}`,
    fbErr(
      new GraphApiError('Unsupported get request. Object does not exist', {
        code: 100,
        subcode: 33,
        httpStatus: 400,
      }),
    ),
  );

  await tool('facebook_delete_post').handler({ post_id: POST_ID }, ctx);
  const applied = body(
    await tool('facebook_delete_post').handler(
      { post_id: POST_ID, apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'diverged');
  assert.equal(
    fb.calls.filter((req) => req.method === 'DELETE').length,
    0,
    'divergence stops the delete',
  );
});

test('delete_post rejects a stale plan id instead of deleting on a guess', async () => {
  const { fb, ctx } = makeCtx();
  stubPostState(fb, { id: POST_ID, message: 'still here' });

  const result = await tool('facebook_delete_post').handler(
    { post_id: POST_ID, apply: true, plan_id: 'plan-does-not-exist' },
    ctx,
  );
  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'plan_not_found');
  assert.equal(parsed['tier'], 'irreversible');
  assert.equal(fb.calls.filter((req) => req.method === 'DELETE').length, 0);
});
