// Tests for the `posts` tool package: package invariants and facebook_create_post (plan /
// apply, scheduling).
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
  PAGE_TOKEN,
  SOON,
  body,
  findJson,
  isWrite,
  jsonBody,
  jsonCalls,
  makeCtx,
  record,
  strings,
  stubPageTimezone,
  tool,
} from '../testing/harness/posts.js';

// ---------------------------------------------------------------------------
// Package invariants
// ---------------------------------------------------------------------------

test('createPostsPackage builds the plan-first posts package with nine tools', () => {
  const pkg = createPostsPackage();
  assert.equal(pkg.name, 'posts');
  assert.equal(pkg.enabledByDefault, true);
  assert.equal(pkg.writeModeDefault, 'plan');
  assert.deepEqual(
    pkg.tools.map((t) => t.name),
    [
      'facebook_create_post',
      'facebook_create_photo_post',
      'facebook_create_video_post',
      'facebook_create_reel',
      'facebook_create_story',
      'facebook_update_post',
      'facebook_delete_post',
      'facebook_list_scheduled_posts',
      'facebook_get_video_status',
    ],
  );
});

test('every posts tool carries the exact doc-06 annotation quadruple and tier', () => {
  const expected = new Map<
    string,
    {
      readOnlyHint: boolean;
      destructiveHint: boolean;
      idempotentHint: boolean;
      openWorldHint: boolean;
      writeTier: string | undefined;
    }
  >([
    [
      'facebook_create_post',
      {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        writeTier: 'reversible',
      },
    ],
    [
      'facebook_create_photo_post',
      {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        writeTier: 'reversible',
      },
    ],
    [
      'facebook_create_video_post',
      {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        writeTier: 'reversible',
      },
    ],
    [
      'facebook_create_reel',
      {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        writeTier: 'reversible',
      },
    ],
    [
      'facebook_create_story',
      {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        writeTier: 'irreversible',
      },
    ],
    [
      'facebook_update_post',
      {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
        writeTier: 'reversible',
      },
    ],
    [
      'facebook_delete_post',
      {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
        writeTier: 'irreversible',
      },
    ],
    [
      'facebook_list_scheduled_posts',
      {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        writeTier: undefined,
      },
    ],
    [
      'facebook_get_video_status',
      {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        writeTier: undefined,
      },
    ],
  ]);

  for (const spec of createPostsPackage().tools) {
    const want = expected.get(spec.name);
    assert.ok(want, `unexpected tool ${spec.name}`);
    assert.equal(spec.annotations.readOnlyHint, want.readOnlyHint, spec.name);
    assert.equal(spec.annotations.destructiveHint, want.destructiveHint, spec.name);
    assert.equal(spec.annotations.idempotentHint, want.idempotentHint, spec.name);
    assert.equal(spec.annotations.openWorldHint, want.openWorldHint, spec.name);
    assert.equal(spec.writeTier, want.writeTier, spec.name);
  }
});

test('every posts tool describes each of its own input fields for a model', () => {
  for (const spec of createPostsPackage().tools) {
    // `inputSchema` is typed as `ZodTypeAny`; every tool must in fact be an object.
    const view = spec.inputSchema as unknown as {
      shape?: Record<string, { description?: string }>;
    };
    assert.ok(view.shape, `${spec.name} must declare an object input schema`);
    for (const [field, schema] of Object.entries(view.shape)) {
      assert.ok(
        (schema.description ?? '').length > 20,
        `${spec.name}.${field} needs a useful .describe()`,
      );
    }
  }
});

/**
 * The arguments this package has cleared for the per-call stderr line: the Page
 * selector, the write-gate flags, the ids Graph itself puts in a URL, and the
 * enum/boolean knobs that say WHICH mutation was armed. Every model-composed
 * value — post text, captions, links, file paths — and the operator's
 * `confirm_token` are absent by construction, so a new allowlist entry has to be
 * argued into this set before the audit below will accept it.
 */
const SAFE_TO_LOG: ReadonlySet<string> = new Set([
  'profile',
  'apply',
  'plan_id',
  'post_id',
  'action',
  'published',
  'scheduled_publish_time',
  'video_state',
  'is_hidden',
  'is_pinned',
  'media_type',
]);

test('every posts log allowlist names real, non-content arguments', () => {
  // `logFields` is the ONLY thing that reaches the per-call log line
  // (04 §"Log hygiene"), so the declarations are audited rather than trusted:
  // this table IS the reviewed decision, and a tool missing from it must stay
  // silent. Both silent tools are reads whose arguments are the profile selector
  // and paging, which is why they say nothing at all.
  const created = ['profile', 'apply', 'plan_id', 'published', 'scheduled_publish_time'];
  const expected: Record<string, readonly string[]> = {
    facebook_create_post: created,
    facebook_create_photo_post: created,
    facebook_create_video_post: created,
    facebook_create_reel: [
      'profile',
      'apply',
      'plan_id',
      'video_state',
      'scheduled_publish_time',
    ],
    facebook_create_story: ['profile', 'apply', 'plan_id', 'media_type'],
    facebook_update_post: [
      'profile',
      'apply',
      'plan_id',
      'post_id',
      'action',
      'is_hidden',
      'is_pinned',
      'scheduled_publish_time',
    ],
    facebook_delete_post: ['profile', 'apply', 'plan_id', 'post_id'],
  };

  for (const spec of createPostsPackage().tools) {
    const want = expected[spec.name];
    if (want === undefined) {
      assert.equal(
        spec.logFields,
        undefined,
        `${spec.name} started logging without being audited here`,
      );
      continue;
    }
    assert.deepEqual(
      [...(spec.logFields ?? [])],
      [...want],
      `${spec.name}'s allowlist changed without this audit changing with it`,
    );

    // The zod shape is the argument list: a key that is not in it would log
    // nothing at all while reading like a control.
    const { shape } = spec.inputSchema as unknown as {
      readonly shape: Record<string, unknown>;
    };
    for (const key of want) {
      assert.ok(key in shape, `${spec.name} logs ${key}, which is not an argument`);
      assert.ok(
        SAFE_TO_LOG.has(key),
        `${spec.name} logs ${key}, which is not cleared for stderr`,
      );
    }
  }

  // The named dangers, spelled out so the reason survives a refactor of the set:
  // the operator's out-of-band secret, and every argument that carries text a
  // model composed or a path into FB_MEDIA_DIR.
  for (const banned of [
    'confirm_token',
    'message',
    'caption',
    'description',
    'title',
    'link',
    'photo',
    'photos',
    'video',
    'child_attachments',
  ]) {
    assert.ok(!SAFE_TO_LOG.has(banned), `${banned} must never be cleared for stderr`);
  }
});

// ---------------------------------------------------------------------------
// facebook_create_post — plan then apply
// ---------------------------------------------------------------------------

test('create_post publishing stays plan-bound under FB_WRITE_MODE=apply', async () => {
  // The package comment used to credit `writeModeDefault: 'plan'` for this. It
  // is not the reason: an explicitly set FB_WRITE_MODE=apply overrides a package
  // default outright (`effectiveWriteMode`). `requirePlanId: publishesNow(...)`
  // is, which is why a bare apply:true still only previews here — while the same
  // tool applies in one call when the post reaches nobody (published:false).
  const { fb, ctx } = makeCtx({ writeMode: 'apply' });

  const preview = body(
    await tool('facebook_create_post').handler(
      { message: 'One shot', published: true, apply: true },
      ctx,
    ),
  );
  assert.equal(preview['status'], 'preview');
  assert.equal(preview['applied'], false);
  assert.ok(
    strings(preview['warnings']).some((w) => w.includes('plan_id')),
    'the caller is told WHY the apply degraded to a preview',
  );
  assert.equal(
    jsonCalls(fb).filter((req) => req.method === 'POST').length,
    0,
    'no write mode may publish to an audience without a plan id',
  );
});

test('create_post previews without touching the wire, then applies with the plan id', async () => {
  const { fb, ctx } = makeCtx();

  const preview = body(
    await tool('facebook_create_post').handler({ message: 'Hello world' }, ctx),
  );
  assert.equal(preview['status'], 'preview');
  assert.equal(preview['applied'], false);
  assert.equal(preview['planId'], 'plan-1');
  assert.equal(preview['tier'], 'reversible');
  assert.equal(preview['pageId'], PAGE_ID);
  assert.match(String(preview['nextStep']), /apply:true and plan_id:"plan-1"/);
  assert.equal(fb.calls.length, 0, 'a dry run performs no Graph call at all');

  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
    fbOk({ id: '100_777', post_id: '100_777' }),
  );

  const applied = body(
    await tool('facebook_create_post').handler(
      { message: 'Hello world', apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'applied');
  assert.equal(applied['applied'], true);
  const result = record(applied['result']);
  assert.equal(result['postId'], '100_777');
  assert.equal(result['publishState'], 'published');

  const feed = findJson(fb, (req) => req.path === `/${PAGE_ID}/feed`);
  assert.deepEqual(jsonBody(feed), { message: 'Hello world' });
  assert.equal(feed.token, PAGE_TOKEN);
});

// CC-LIFE-2 / C2: Graph offers no idempotency key for a create, so a 5xx must be
// journaled as `attempted` — recording it as a clean `failed` would invite a
// blind retry that publishes the same post twice.
test('create_post journals a 5xx publish failure as attempted, not failed', async () => {
  const { fb, ctx, journal } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
    fbErr(new GraphApiError('upstream is unavailable', { code: 2, httpStatus: 503 })),
  );

  await tool('facebook_create_post').handler({ message: 'Maybe posted' }, ctx);

  // A bare GraphApiError is deliberately re-thrown: the server bootstrap owns the
  // Graph error envelope, so this package must not swallow it into a plain record.
  await assert.rejects(
    () =>
      tool('facebook_create_post').handler(
        { message: 'Maybe posted', apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    /unavailable/,
  );

  assert.equal(journal.entries.length, 1);
  const entry = journal.entries[0];
  assert.ok(entry);
  assert.equal(entry.tool, 'facebook_create_post');
  assert.equal(
    entry.outcome,
    'attempted',
    'an ambiguous wire failure must never be journaled as a clean failure',
  );
  assert.match(String(entry.error), /unavailable/);
});

test('create_post journals a 4xx publish rejection as failed', async () => {
  const { fb, ctx, journal } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
    fbErr(new GraphApiError('(#200) Permissions error', { code: 200, httpStatus: 400 })),
  );

  await tool('facebook_create_post').handler({ message: 'Rejected outright' }, ctx);

  await assert.rejects(
    () =>
      tool('facebook_create_post').handler(
        { message: 'Rejected outright', apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    /Permissions error/,
  );

  const entry = journal.entries[0];
  assert.ok(entry);
  assert.equal(
    entry.outcome,
    'failed',
    'a 4xx created nothing, so a clean failure is the honest record',
  );
});

// C2: the http layer can hand back a GraphApiError whose `httpStatus` is a 2xx
// and whose action is `ambiguous` (the body was lost after the status line was
// read). Its status says nothing about whether the post landed — the category
// does — so the journal must record `attempted`, exactly as it does for a 5xx.
test('create_post journals an ambiguous 2xx (lost body) as attempted, not failed', async () => {
  const { fb, ctx, journal } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
    fbErr(
      new GraphApiError(
        'ambiguous write outcome (response body lost after HTTP 200) — do NOT retry; verify first',
        {
          code: 0,
          httpStatus: 200,
          action: ambiguousWriteAction({ detail: 'response body lost after HTTP 200' }),
        },
      ),
    ),
  );

  await tool('facebook_create_post').handler({ message: 'Maybe posted' }, ctx);

  await assert.rejects(
    () =>
      tool('facebook_create_post').handler(
        { message: 'Maybe posted', apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    /do NOT retry/,
  );

  const entry = journal.entries[0];
  assert.ok(entry);
  assert.equal(
    entry.outcome,
    'attempted',
    'an ambiguous outcome is ambiguous whatever its HTTP status; a clean failure invites a duplicate',
  );
});

// Same shape on the photo edge: `uploadPhoto` turns a 2xx without a photo id into
// an ambiguous GraphApiError carrying the 2xx status. A photo may now exist.
test('create_photo_post journals a 2xx with no photo id as attempted, not failed', async () => {
  const { fb, ctx, journal } = makeCtx();
  fb.on((req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`, fbOk({}));

  await tool('facebook_create_photo_post').handler(
    { photo: 'https://cdn.example/a.jpg', caption: 'Look' },
    ctx,
  );

  await assert.rejects(
    () =>
      tool('facebook_create_photo_post').handler(
        {
          photo: 'https://cdn.example/a.jpg',
          caption: 'Look',
          apply: true,
          plan_id: 'plan-1',
        },
        ctx,
      ),
    /returned no photo id/,
  );

  const entry = journal.entries[0];
  assert.ok(entry);
  assert.equal(entry.tool, 'facebook_create_photo_post');
  assert.equal(
    entry.outcome,
    'attempted',
    'a 2xx that carried no id may have created a photo; it must not be journaled as failed',
  );
});

// Doc 06: publishing to a live audience is plan-bound. The tier stays
// `reversible` (deleting the post is one call), so the binding comes from the
// per-call `requirePlanId` rather than from a tier promotion — which is why the
// same tool still applies in one call when nothing reaches an audience.
test('create_post refuses to publish on apply:true alone — a plan_id is required', async () => {
  const { fb, ctx } = makeCtx();

  const result = await tool('facebook_create_post').handler(
    { message: 'One shot', published: true, apply: true },
    ctx,
  );

  const preview = body(result);
  assert.equal(preview['status'], 'preview');
  assert.ok(
    strings(preview['warnings']).some((w) => w.includes('plan_id')),
    'the downgrade tells the agent what it still owes',
  );
  assert.equal(fb.calls.length, 0, 'nothing reached Graph');
});

test('create_post publishes once the apply is bound to the plan it previewed', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
    fbOk({ id: '100_1001' }),
  );
  await tool('facebook_create_post').handler(
    { message: 'One shot', published: true },
    ctx,
  );

  const applied = body(
    await tool('facebook_create_post').handler(
      { message: 'One shot', published: true, apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'applied');
  assert.equal(record(applied['result'])['postId'], '100_1001');
});

test('a draft is NOT plan-bound — it reaches no audience, so one call is enough', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
    fbOk({ id: '100_1002' }),
  );

  const applied = body(
    await tool('facebook_create_post').handler(
      { message: 'Draft', published: false, apply: true },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'applied');
  assert.equal(record(applied['result'])['postId'], '100_1002');
});

test('create_post refuses an apply whose params no longer match the plan', async () => {
  const { fb, ctx } = makeCtx();
  await tool('facebook_create_post').handler({ message: 'first' }, ctx);

  const result = await tool('facebook_create_post').handler(
    { message: 'second', apply: true, plan_id: 'plan-1' },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.equal(body(result)['reason'], 'plan_mismatch');
  assert.equal(fb.calls.length, 0, 'a mismatched apply never reaches Graph');
});

test('create_post surfaces the empty-post refusal instead of previewing nothing', async () => {
  const { fb, ctx } = makeCtx();
  const result = await tool('facebook_create_post').handler({}, ctx);
  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'empty_post');
  assert.equal(parsed['applied'], false);
  assert.equal(fb.calls.length, 0);
});

test('create_post rejects a carousel of one card before any preview is minted', async () => {
  const { ctx } = makeCtx();
  const result = await tool('facebook_create_post').handler(
    { link: 'https://example.com', child_attachments: [{ link: 'https://a.example' }] },
    ctx,
  );
  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'child_attachments_range');
  assert.equal(parsed['field'], 'child_attachments');
});

test('create_post refuses a message past the 63206-character ceiling', async () => {
  const { fb, ctx } = makeCtx();
  const result = await tool('facebook_create_post').handler(
    { message: 'a'.repeat(63_207) },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.equal(body(result)['reason'], 'message_too_long');
  assert.equal(fb.calls.length, 0);
});

// ---------------------------------------------------------------------------
// facebook_create_post — scheduling
// ---------------------------------------------------------------------------

test('create_post refuses published:true together with a schedule', async () => {
  const { fb, ctx } = makeCtx();
  const result = await tool('facebook_create_post').handler(
    { message: 'x', published: true, scheduled_publish_time: SOON },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.equal(body(result)['reason'], 'conflicting_params');
  assert.equal(fb.calls.filter(isWrite).length, 0);
});

test('create_post refuses a schedule beyond the 75-day ceiling', async () => {
  const { fb, ctx } = makeCtx();
  stubPageTimezone(fb);
  const result = await tool('facebook_create_post').handler(
    { message: 'x', scheduled_publish_time: '2026-06-01T00:00:00Z' },
    ctx,
  );
  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'schedule_too_far');
  assert.match(String(parsed['help']), /ISO-8601/);
  assert.equal(fb.calls.filter(isWrite).length, 0);
});

test('create_post echoes the publish time in UTC and Page-local time in preview AND result', async () => {
  const { fb, ctx } = makeCtx();
  stubPageTimezone(fb, 'Europe/Sofia');

  const preview = body(
    await tool('facebook_create_post').handler(
      { message: 'Later', scheduled_publish_time: SOON },
      ctx,
    ),
  );
  const warnings = strings(preview['warnings']);
  const echoed = warnings.find((w) => w.startsWith('Publish time:'));
  assert.ok(echoed, 'the preview states the resolved publish time');
  assert.match(echoed, /2026-01-05T12:00:00\.000Z \(UTC/);
  assert.match(echoed, /Europe\/Sofia/);

  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
    fbOk({ id: '100_778' }),
  );
  const applied = body(
    await tool('facebook_create_post').handler(
      { message: 'Later', scheduled_publish_time: SOON, apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  const schedule = record(record(applied['result'])['schedule']);
  assert.equal(schedule['utc'], '2026-01-05T12:00:00.000Z');
  assert.equal(schedule['epochSeconds'], Date.parse(SOON) / 1000);
  assert.equal(schedule['pageTimezone'], 'Europe/Sofia');
  assert.ok(
    typeof schedule['pageLocal'] === 'string' && schedule['pageLocal'].length > 0,
    'the applied result repeats the Page-local echo, not only the preview',
  );

  const feed = findJson(fb, (req) => req.path === `/${PAGE_ID}/feed`);
  assert.equal(jsonBody(feed)['scheduled_publish_time'], Date.parse(SOON) / 1000);
  assert.equal(jsonBody(feed)['published'], false);
});

test('create_post never tells a scheduled post or a draft to verify on the published listing', async () => {
  const cases = [
    {
      input: { message: 'Later', scheduled_publish_time: SOON },
      tool: /facebook_list_scheduled_posts/,
    },
    { input: { message: 'Draft', published: false }, tool: /Meta Business Suite/ },
  ];
  for (const { input, tool: expected } of cases) {
    const { fb, ctx } = makeCtx();
    fb.on(
      (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
      fbOk({ id: '100_779' }),
    );
    await tool('facebook_create_post').handler(input, ctx);
    const applied = body(
      await tool('facebook_create_post').handler(
        { ...input, apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    );
    assert.equal(applied['status'], 'applied');
    const note = String(record(applied['result'])['verifyNote']);
    assert.doesNotMatch(note, /facebook_list_posts/, `${input.message}: ${note}`);
    assert.match(note, expected);
  }
});

test('create_post falls back to a UTC-only echo when the Page timezone is unreadable', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'GET' && req.path === `/${PAGE_ID}`,
    fbErr(new Error('timezone read failed')),
  );

  const preview = body(
    await tool('facebook_create_post').handler(
      { message: 'Later', scheduled_publish_time: SOON },
      ctx,
    ),
  );
  const warnings = strings(preview['warnings']);
  assert.ok(
    warnings.some((w) => w.includes('the Page timezone is unknown')),
    'the preview says plainly that the Page-local echo is unavailable',
  );
  assert.ok(
    warnings.some((w) => w.includes('page_timezone')),
    'and tells the model how to supply it',
  );
});

test('create_post surfaces a too-soon schedule with actionable format help', async () => {
  const { fb, ctx } = makeCtx();
  stubPageTimezone(fb);
  const result = await tool('facebook_create_post').handler(
    { message: 'Too soon', scheduled_publish_time: '2026-01-01T00:05:00Z' },
    ctx,
  );
  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'schedule_too_soon');
  assert.match(String(parsed['help']), /ISO-8601/);
  assert.equal(fb.calls.filter(isWrite).length, 0, 'nothing was written');
});

test('create_post refuses a schedule without an explicit UTC offset', async () => {
  const { ctx } = makeCtx();
  const result = await tool('facebook_create_post').handler(
    { message: 'Ambiguous', scheduled_publish_time: '2026-01-05T12:00:00' },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.equal(body(result)['reason'], 'schedule_format');
});

test('create_post rejects an unrecognised page_timezone rather than degrading silently', async () => {
  const { fb, ctx } = makeCtx();
  const result = await tool('facebook_create_post').handler(
    { message: 'x', scheduled_publish_time: SOON, page_timezone: 'Mars/Olympus' },
    ctx,
  );
  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'invalid_argument');
  assert.equal(parsed['field'], 'page_timezone');
  assert.match(String(parsed['hint']), /Europe\/Sofia/);
  assert.equal(fb.calls.length, 0);
});
