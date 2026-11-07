// Tests for the `posts` tool package: the multi-photo carousel and
// facebook_create_photo_post.
//
// Split out of `posts.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/posts.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fbErr, fbOk, type FakeFbRequest } from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import {
  PAGE_ID,
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
// facebook_create_post — the multi-photo carousel
// ---------------------------------------------------------------------------

test('create_post accepts photos as strings and {source, alt_text} objects', async () => {
  const { fb, ctx } = makeCtx();
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
    fbOk({ id: '100_900' }),
  );

  const photos = [
    'https://cdn.example/a.jpg',
    { source: 'https://cdn.example/b.jpg', alt_text: 'A lemon tart' },
  ];
  const preview = body(
    await tool('facebook_create_post').handler({ message: 'Gallery', photos }, ctx),
  );
  assert.match(String(preview['summary']), /Alt text: 1 of 2 photos\./);

  await tool('facebook_create_post').handler(
    { message: 'Gallery', photos, apply: true, plan_id: 'plan-1' },
    ctx,
  );
  const uploads = jsonCalls(fb).filter((req) => req.path === `/${PAGE_ID}/photos`);
  assert.equal(uploads.length, 2);
  assert.equal(jsonBody(uploads[0]!)['url'], 'https://cdn.example/a.jpg');
  assert.equal(jsonBody(uploads[0]!)['alt_text_custom'], undefined);
  assert.equal(jsonBody(uploads[1]!)['url'], 'https://cdn.example/b.jpg');
  assert.equal(jsonBody(uploads[1]!)['alt_text_custom'], 'A lemon tart');
});

test('create_post refuses alt_text longer than 1000 characters', () => {
  const schema = tool('facebook_create_post').inputSchema;
  const ok = schema.safeParse({
    photos: [{ source: 'https://cdn.example/a.jpg', alt_text: 'x'.repeat(1000) }],
  });
  assert.equal(ok.success, true);
  const tooLong = schema.safeParse({
    photos: [{ source: 'https://cdn.example/a.jpg', alt_text: 'x'.repeat(1001) }],
  });
  assert.equal(tooLong.success, false);
});

test('create_post uploads carousel children unpublished and attaches them to one post', async () => {
  const { fb, ctx, progress } = makeCtx();
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
    fbOk({ id: '100_900' }),
  );

  const photos = ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'];
  const preview = body(
    await tool('facebook_create_post').handler({ message: 'Gallery', photos }, ctx),
  );
  assert.equal(preview['status'], 'preview');
  assert.equal(fb.calls.length, 0, 'a carousel dry run uploads nothing');

  const applied = body(
    await tool('facebook_create_post').handler(
      { message: 'Gallery', photos, apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  const result = record(applied['result']);
  assert.deepEqual(result['photoIds'], ['ph-1', 'ph-2']);

  const uploads = jsonCalls(fb).filter((req) => req.path === `/${PAGE_ID}/photos`);
  assert.equal(uploads.length, 2);
  for (const upload of uploads) {
    assert.equal(jsonBody(upload)['published'], false, 'children stay unpublished');
  }
  const feed = findJson(fb, (req) => req.path === `/${PAGE_ID}/feed`);
  assert.deepEqual(jsonBody(feed)['attached_media[0]'], '{"media_fbid":"ph-1"}');
  assert.deepEqual(jsonBody(feed)['attached_media[1]'], '{"media_fbid":"ph-2"}');
  assert.deepEqual(
    progress.map((p) => p.progress),
    [1, 2],
    'each uploaded child is reported',
  );
});

test('create_post reports orphaned children to the operator when the feed call fails', async () => {
  // A 4xx is Graph REJECTING the carousel post: nothing references the
  // children, so this call owns their cleanup. (A 5xx or a lost response is a
  // different case — see the unconfirmed-carousel test below.)
  const { fb, ctx } = makeCtx();
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
    fbErr(new GraphApiError('feed write failed', { code: 100, httpStatus: 400 })),
  );
  // The first child is cleaned up; the second survives and must be named.
  fb.on(
    (req) => req.method === 'DELETE' && req.path === '/ph-1',
    fbOk({ success: true }),
  );
  fb.on(
    (req) => req.method === 'DELETE' && req.path === '/ph-2',
    fbErr(new Error('delete refused')),
  );

  const photos = ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'];
  await tool('facebook_create_post').handler({ message: 'Gallery', photos }, ctx);
  const result = await tool('facebook_create_post').handler(
    { message: 'Gallery', photos, apply: true, plan_id: 'plan-1' },
    ctx,
  );

  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'carousel_post_failed');
  const cleanup = record(parsed['cleanup']);
  assert.deepEqual(cleanup['deleted'], ['ph-1']);
  assert.deepEqual(cleanup['orphans'], ['ph-2']);
  assert.match(String(cleanup['operatorNotice']), /ph-2/);
  assert.match(String(parsed['hint']), /photo library/);
});

test('create_post never deletes the children of a carousel post that may have landed', async () => {
  // A 5xx or a transport fault on POST /feed is the C2-ambiguous case: the
  // carousel post may exist and reference every child photo. Deleting those
  // photos would gut a live post, and "no post references them" would be false.
  // The journal already files this as `attempted`; the error record must agree,
  // keep the photos, and hand back their ids to reconcile.
  const failures: readonly GraphApiError[] = [
    new GraphApiError('feed write failed', { code: 1, httpStatus: 500 }),
    new GraphApiError('socket hang up', { code: 1, httpStatus: 0 }),
  ];
  for (const failure of failures) {
    const { fb, ctx, journal } = makeCtx();
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
      fbErr(failure),
    );
    fb.on((req) => req.method === 'DELETE', fbOk({ success: true }));

    const photos = ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'];
    await tool('facebook_create_post').handler({ message: 'Gallery', photos }, ctx);
    const result = await tool('facebook_create_post').handler(
      { message: 'Gallery', photos, apply: true, plan_id: 'plan-1' },
      ctx,
    );

    const label = `HTTP ${String(failure.httpStatus)}`;
    assert.equal(
      fb.calls.filter((req) => req.method === 'DELETE').length,
      0,
      `${label}: no child photo of a possibly-live post is deleted`,
    );
    assert.equal(result.isError, true, label);
    const parsed = body(result);
    assert.equal(parsed['reason'], 'carousel_post_unconfirmed', label);
    assert.equal(parsed['outcome'], 'attempted', label);
    assert.deepEqual(parsed['photoIds'], ['ph-1', 'ph-2'], label);
    assert.doesNotMatch(String(parsed['hint']), /no post references them/, label);
    assert.match(String(parsed['hint']), /[Vv]erify/, label);
    assert.equal(journal.entries[0]?.outcome, 'attempted', `${label}: journal outcome`);
  }
});

test('create_post points an unconfirmed carousel at the listing that can show it', async () => {
  // A scheduled carousel sits on the scheduled queue and a draft on no listing
  // this server reads: sending either to facebook_list_posts reads as "it did not
  // land", and the model then deletes the photos of a live post or re-sends it.
  const cases = [
    {
      input: {},
      expected: /facebook_list_posts\b[^.]*created_time/,
      absent: /filtered to/,
    },
    {
      input: { scheduled_publish_time: SOON },
      expected: /facebook_list_scheduled_posts/,
      absent: /facebook_list_posts\b/,
    },
    {
      input: { published: false },
      expected: /Meta Business Suite/,
      absent: /facebook_list_posts\b/,
    },
  ];
  for (const { input, expected, absent } of cases) {
    const { fb, ctx } = makeCtx();
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
      fbErr(new GraphApiError('feed write failed', { code: 1, httpStatus: 500 })),
    );

    const photos = ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'];
    const args = { message: 'Gallery', photos, ...input };
    await tool('facebook_create_post').handler(args, ctx);
    const result = await tool('facebook_create_post').handler(
      { ...args, apply: true, plan_id: 'plan-1' },
      ctx,
    );

    const label = JSON.stringify(input);
    const parsed = body(result);
    assert.equal(parsed['reason'], 'carousel_post_unconfirmed', label);
    const hint = String(parsed['hint']);
    assert.match(hint, expected, `${label}: ${hint}`);
    if (absent !== undefined) assert.doesNotMatch(hint, absent, `${label}: ${hint}`);
  }
});

test('create_post reports the child upload that failed mid-carousel', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`,
    fbOk({ id: 'ph-1' }),
    1,
  );
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`,
    fbErr(new GraphApiError('photo rejected', { code: 1, httpStatus: 400 })),
    1,
  );
  fb.on(
    (req) => req.method === 'DELETE' && req.path === '/ph-1',
    fbOk({ success: true }),
  );

  const photos = ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'];
  await tool('facebook_create_post').handler({ photos }, ctx);
  const result = await tool('facebook_create_post').handler(
    { photos, apply: true, plan_id: 'plan-1' },
    ctx,
  );

  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'multi_photo_upload_failed');
  assert.equal(parsed['failedIndex'], 1);
  assert.equal(parsed['total'], 2);
  assert.deepEqual(record(parsed['cleanup'])['deleted'], ['ph-1']);
  assert.equal(
    jsonCalls(fb).filter((req) => req.path === `/${PAGE_ID}/feed`).length,
    0,
    'no post is created when a child upload fails',
  );
});

test('create_post names a child upload of unknown outcome as a structured field, not only in prose', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`,
    fbOk({ id: 'ph-1' }),
    1,
  );
  // A non-Graph fault mid-request: the photo may exist, its id never came back.
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`,
    fbErr(new Error('socket hang up')),
    1,
  );
  fb.on(
    (req) => req.method === 'DELETE' && req.path === '/ph-1',
    fbOk({ success: true }),
  );

  const photos = ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'];
  await tool('facebook_create_post').handler({ photos }, ctx);
  const result = await tool('facebook_create_post').handler(
    { photos, apply: true, plan_id: 'plan-1' },
    ctx,
  );

  assert.equal(result.isError, true);
  const cleanup = record(body(result)['cleanup']);
  // `orphans` is empty — there is no id to delete — so a caller reading the
  // structured fields alone would conclude nothing was left behind.
  assert.deepEqual(cleanup['orphans'], []);
  assert.deepEqual(cleanup['unconfirmedUploads'], [
    { photo: 2, error: 'socket hang up' },
  ]);
  assert.match(String(cleanup['operatorNotice']), /photo 2/);
});

test('create_post refuses a non-https photo source in the dry run', async () => {
  const { fb, ctx } = makeCtx();
  const result = await tool('facebook_create_post').handler(
    { photos: ['ftp://cdn.example/a.jpg'] },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.match(String(body(result)['hint']), /https:\/\//);
  assert.equal(fb.calls.length, 0);
});

// ---------------------------------------------------------------------------
// facebook_create_photo_post
// ---------------------------------------------------------------------------

test('create_photo_post posts one remote photo and reports both ids', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`,
    fbOk({ id: 'ph-9', post_id: '100_909' }),
  );

  const preview = body(
    await tool('facebook_create_photo_post').handler(
      { photo: 'https://cdn.example/a.jpg', caption: 'Look' },
      ctx,
    ),
  );
  assert.equal(preview['status'], 'preview');
  assert.equal(fb.calls.length, 0);

  const applied = body(
    await tool('facebook_create_photo_post').handler(
      {
        photo: 'https://cdn.example/a.jpg',
        caption: 'Look',
        apply: true,
        plan_id: 'plan-1',
      },
      ctx,
    ),
  );
  const result = record(applied['result']);
  assert.equal(result['photoId'], 'ph-9');
  assert.equal(result['postId'], '100_909');
  const upload = findJson(fb, (req) => req.path === `/${PAGE_ID}/photos`);
  assert.equal(jsonBody(upload)['caption'], 'Look');
  assert.equal(jsonBody(upload)['published'], true);
});

test('create_photo_post sends alt_text as alt_text_custom and marks it in the summary', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`,
    fbOk({ id: 'ph-9', post_id: '100_909' }),
  );
  const altText = 'Plate of grilled sea bass with lemon';
  const input = { photo: 'https://cdn.example/a.jpg', alt_text: altText };

  const preview = body(await tool('facebook_create_photo_post').handler(input, ctx));
  assert.match(String(preview['summary']), /Alt text: yes \(36 chars\)\./);
  assert.equal(
    strings(preview['warnings']).some((w) => /alt/i.test(w)),
    false,
    'alt text never warns',
  );

  await tool('facebook_create_photo_post').handler(
    { ...input, apply: true, plan_id: 'plan-1' },
    ctx,
  );
  const upload = findJson(fb, (req) => req.path === `/${PAGE_ID}/photos`);
  assert.equal(jsonBody(upload)['alt_text_custom'], altText);
});

test('create_photo_post without alt_text sends none and does not mention it', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`,
    fbOk({ id: 'ph-9', post_id: '100_909' }),
  );
  const input = { photo: 'https://cdn.example/a.jpg' };
  const preview = body(await tool('facebook_create_photo_post').handler(input, ctx));
  assert.doesNotMatch(String(preview['summary']), /alt text/i);

  await tool('facebook_create_photo_post').handler(
    { ...input, apply: true, plan_id: 'plan-1' },
    ctx,
  );
  const upload = findJson(fb, (req) => req.path === `/${PAGE_ID}/photos`);
  assert.equal(jsonBody(upload)['alt_text_custom'], undefined);
});

test('create_photo_post keeps a scheduled photo unpublished and passes the epoch through', async () => {
  const { fb, ctx } = makeCtx();
  stubPageTimezone(fb);
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`,
    fbOk({ id: 'ph-10' }),
  );

  await tool('facebook_create_photo_post').handler(
    { photo: 'https://cdn.example/a.jpg', scheduled_publish_time: SOON },
    ctx,
  );
  const applied = body(
    await tool('facebook_create_photo_post').handler(
      {
        photo: 'https://cdn.example/a.jpg',
        scheduled_publish_time: SOON,
        apply: true,
        plan_id: 'plan-1',
      },
      ctx,
    ),
  );
  assert.equal(record(applied['result'])['publishState'], 'scheduled');
  const upload = findJson(fb, (req) => req.path === `/${PAGE_ID}/photos`);
  assert.equal(jsonBody(upload)['published'], false);
  assert.equal(jsonBody(upload)['scheduled_publish_time'], Date.parse(SOON) / 1000);
});

const ALBUM_ID = '4242';

/** Stub the F4 album pre-check (`GET /{album-id}?fields=…`). */
function stubAlbum(fb: FakeFbRequest, node: Record<string, unknown>): void {
  fb.on(
    (req) => req.method === 'GET' && req.path === `/${ALBUM_ID}`,
    fbOk({ id: ALBUM_ID, ...node }),
  );
}

test('create_photo_post with album_id names the album and uploads to the album edge', async () => {
  const { fb, ctx } = makeCtx();
  stubAlbum(fb, {
    name: 'Menu',
    type: 'normal',
    can_upload: true,
    from: { id: PAGE_ID },
  });
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${ALBUM_ID}/photos`,
    fbOk({ id: 'ph-11', post_id: '100_911' }),
  );
  const args = {
    photo: 'https://cdn.example/a.jpg',
    caption: 'Lunch',
    album_id: ALBUM_ID,
  };

  const preview = body(await tool('facebook_create_photo_post').handler(args, ctx));
  assert.equal(preview['status'], 'preview');
  assert.match(
    String(preview['summary']),
    new RegExp(
      `^Publish a photo to album "Menu" \\(${ALBUM_ID}\\) on Page ${PAGE_ID}\\.`,
    ),
  );
  const check = findJson(fb, (req) => req.path === `/${ALBUM_ID}`);
  assert.equal(check.params?.['fields'], 'id,name,type,can_upload,from');
  assert.equal(fb.calls.filter(isWrite).length, 0);

  const applied = body(
    await tool('facebook_create_photo_post').handler(
      { ...args, apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  const result = record(applied['result']);
  assert.equal(result['photoId'], 'ph-11');
  assert.equal(result['albumId'], ALBUM_ID);
  const upload = findJson(fb, (req) => req.method === 'POST');
  assert.equal(upload.path, `/${ALBUM_ID}/photos`);
  assert.equal(jsonBody(upload)['caption'], 'Lunch');
  assert.equal(jsonBody(upload)['aid'], undefined);
});

test('create_photo_post refuses an album that does not accept uploads', async () => {
  const { fb, ctx } = makeCtx();
  stubAlbum(fb, {
    name: 'Menu',
    type: 'normal',
    can_upload: false,
    from: { id: PAGE_ID },
  });
  const result = await tool('facebook_create_photo_post').handler(
    { photo: 'https://cdn.example/a.jpg', album_id: ALBUM_ID },
    ctx,
  );
  assert.equal(result.isError, true);
  const refusal = body(result);
  assert.equal(refusal['field'], 'album_id');
  assert.match(String(refusal['error']), /does not accept uploads/);
  assert.equal(fb.calls.filter(isWrite).length, 0);
});

test("create_photo_post refuses another owner's album", async () => {
  const { fb, ctx } = makeCtx();
  stubAlbum(fb, {
    name: 'Theirs',
    type: 'normal',
    can_upload: true,
    from: { id: '999' },
  });
  const result = await tool('facebook_create_photo_post').handler(
    { photo: 'https://cdn.example/a.jpg', album_id: ALBUM_ID },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.match(String(body(result)['error']), /belongs to 999, not to Page/);
  assert.equal(fb.calls.filter(isWrite).length, 0);
});

test('create_photo_post refuses a Meta-managed system album', async () => {
  const { fb, ctx } = makeCtx();
  stubAlbum(fb, {
    name: 'Cover photos',
    type: 'cover',
    can_upload: true,
    from: { id: PAGE_ID },
  });
  const result = await tool('facebook_create_photo_post').handler(
    { photo: 'https://cdn.example/a.jpg', album_id: ALBUM_ID },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.match(String(body(result)['error']), /"cover" album/);
});

test('create_photo_post warns that scheduling into an album is unverified', async () => {
  const { fb, ctx } = makeCtx();
  stubPageTimezone(fb);
  stubAlbum(fb, { name: 'Menu', type: 'app', can_upload: true, from: { id: PAGE_ID } });
  const preview = body(
    await tool('facebook_create_photo_post').handler(
      {
        photo: 'https://cdn.example/a.jpg',
        album_id: ALBUM_ID,
        scheduled_publish_time: SOON,
      },
      ctx,
    ),
  );
  assert.ok(strings(preview['warnings']).some((w) => /album .*unverified/.test(w)));
});

test('create_photo_post refuses a local file when FB_MEDIA_DIR is not configured', async () => {
  const { fb, ctx } = makeCtx();
  const result = await tool('facebook_create_photo_post').handler(
    { photo: 'holiday.jpg' },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.match(String(body(result)['hint']), /FB_MEDIA_DIR/);
  assert.equal(fb.calls.length, 0);
});
