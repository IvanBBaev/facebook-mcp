// Tests for the `moderation` tool package: replies, photo replies, top-level comments and
// comment edits.
//
// Split out of `moderation.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/moderation.ts`; the suite-level notes are at its top.

import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fbErr, fbOk } from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import type { JsonRequest } from '../core/index.js';
import { TAINT_BEGIN, TAINT_END } from '../mcp/index.js';
import {
  INJECTION,
  PAGE,
  POST_ID,
  ambiguousWriteError,
  anyCall,
  applyViaPlan,
  arr,
  body,
  bodyOf,
  firstCall,
  goneError,
  isEditRead,
  jsonCalls,
  makeHarness,
  obj,
  ownComment,
  paramsOf,
  permissionError,
  postNode,
  str,
  text,
  tool,
} from '../testing/harness/moderation.js';

// ---------------------------------------------------------------------------
// 4. facebook_reply_to_comment — plan vs apply on a reversible tool
// ---------------------------------------------------------------------------

test('a reversible reply previews and touches nothing when the mode is plan', async () => {
  const { fb, ctx, journal } = makeHarness({ writeMode: 'plan' });

  const payload = body(
    await tool('facebook_reply_to_comment').handler(
      { comment_id: 'c1', message: 'Thanks for the feedback!' },
      ctx,
    ),
  );

  assert.equal(payload.status, 'preview');
  assert.equal(payload.applied, false);
  assert.equal(payload.tier, 'reversible');
  assert.equal(payload.planId, 'plan-1');
  assert.equal(payload.pageId, PAGE.pageId);
  assert.ok(str(payload.summary).includes('Thanks for the feedback!'));
  assert.ok(str(payload.nextStep).includes('plan_id:"plan-1"'));
  assert.ok(str(payload.notPerformedNotice).includes('no reply was posted'));
  assert.ok(arr(payload.warnings).some((w) => str(w).includes('PUBLIC')));
  assert.equal(fb.calls.length, 0, 'a dry run must not touch the network');
  assert.equal(journal.entries.length, 0, 'nothing to journal — nothing happened');
});

test('the package apply default never posts a free-text reply without a plan_id', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on((r) => r.method === 'POST' && r.path === '/c1/comments', fbOk({ id: 'c1_r1' }));
  const reply = tool('facebook_reply_to_comment');
  const args = { comment_id: 'c1', message: 'Thanks for the feedback!' };

  // SEC-01: one call steered by an injected comment must not publish as the Page.
  // 1. No apply at all, under writeModeDefault:'apply' — only a preview.
  const bare = body(await reply.handler(args, ctx));
  assert.equal(bare.status, 'preview');
  assert.equal(bare.applied, false);
  assert.equal(bare.tier, 'reversible', 'plan-bound without raising the tier');

  // 2. apply:true but no plan_id — still a preview, naming what is missing.
  const unbound = body(await reply.handler({ ...args, apply: true }, ctx));
  assert.equal(unbound.status, 'preview');
  assert.ok(arr(unbound.warnings).some((w) => str(w).includes('plan_id')));
  assert.equal(fb.calls.length, 0, 'nothing may be posted without a bound plan');
  assert.equal(journal.entries.length, 0);

  // 3. apply:true bound to the preview's plan_id — now it posts.
  const payload = body(
    await reply.handler({ ...args, apply: true, plan_id: str(unbound.planId) }, ctx),
  );

  assert.equal(payload.status, 'applied');
  assert.equal(payload.applied, true);
  assert.deepEqual(payload.result, { id: 'c1_r1' });
  assert.deepEqual(bodyOf(firstCall(fb)), { message: 'Thanks for the feedback!' });

  assert.equal(journal.entries.length, 1);
  const entry = journal.entries[0];
  assert.ok(entry);
  assert.equal(entry.tool, 'facebook_reply_to_comment');
  assert.equal(entry.outcome, 'applied');
  assert.equal(entry.pageId, PAGE.pageId);
  assert.deepEqual(entry.metadata, { commentId: 'c1', messageChars: 24 });
});

test('a reply acknowledged without an id is not applied and journalled attempted', async () => {
  const { fb, ctx, journal } = makeHarness();
  // Graph answered 200 without the new comment's id. The reply may well be
  // public by now, so this is neither a failure nor a confirmed write: the
  // gate must be told the outcome is open (C2 / CC-LIFE-2), and the model
  // must be sent to facebook_list_comments instead of a second POST.
  fb.on((r) => r.method === 'POST' && r.path === '/c1/comments', fbOk({}));

  const payload = body(
    await applyViaPlan(
      'facebook_reply_to_comment',
      { comment_id: 'c1', message: 'Thanks for the feedback!' },
      ctx,
    ),
  );

  assert.equal(payload.status, 'not_applied');
  assert.equal(payload.applied, false);
  assert.equal(payload.outcome, 'attempted');
  assert.ok(str(payload.notPerformedNotice).includes('ATTEMPTED'));
  const result = obj(payload.result);
  assert.equal(result.id, undefined, 'an id Graph never returned must not be echoed');
  assert.ok(str(result.note).includes('facebook_list_comments'));
  assert.ok(anyCall(fb, 'POST', '/c1/comments'), 'the reply was really attempted');

  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0]?.outcome, 'attempted');
});

test('a reply whose answer was lost is journaled attempted, not failed', async () => {
  const { fb, ctx, journal } = makeHarness();
  // C2: the POST reached Facebook and the response was lost, so the reply may
  // already be public. A `failed` entry tells the operator reconciling the
  // journal that nothing was posted — the dangerous direction of the two lies.
  fb.on(
    (r) => r.method === 'POST' && r.path === '/c1/comments',
    fbErr(ambiguousWriteError()),
  );

  await assert.rejects(
    () =>
      applyViaPlan(
        'facebook_reply_to_comment',
        { comment_id: 'c1', message: 'Thanks for the feedback!' },
        ctx,
      ),
    (err: unknown) =>
      err instanceof GraphApiError && err.action?.category === 'ambiguous',
  );

  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0]?.outcome, 'attempted');
});

test('a reply Facebook refused with an error envelope stays journaled failed', async () => {
  // Regression coverage for the other side of the classifier: a received error
  // envelope proves the reply was not posted.
  const { fb, ctx, journal } = makeHarness();
  fb.on(
    (r) => r.method === 'POST' && r.path === '/c1/comments',
    fbErr(permissionError()),
  );

  await assert.rejects(() =>
    applyViaPlan(
      'facebook_reply_to_comment',
      { comment_id: 'c1', message: 'Thanks for the feedback!' },
      ctx,
    ),
  );

  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0]?.outcome, 'failed');
});

// ---------------------------------------------------------------------------
// 4a. facebook_reply_to_comment — a photo or GIF on the reply (F8a)
// ---------------------------------------------------------------------------

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A real FB_MEDIA_DIR holding one small PNG. */
async function photoFixture(t: TestContext): Promise<{ dir: string; name: string }> {
  const raw = await mkdtemp(join(tmpdir(), 'fbmcp-moderation-'));
  t.after(() => rm(raw, { recursive: true, force: true }));
  const dir = await realpath(raw);
  await writeFile(join(dir, 'pic.png'), Buffer.from([...PNG_BYTES, 1, 2, 3, 4]));
  return { dir, name: 'pic.png' };
}

function isValidationRefusal(err: unknown): boolean {
  return err instanceof GraphApiError && err.action?.category === 'validation';
}

test('a reply can carry an image URL or a GIF URL instead of text', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on((r) => r.method === 'POST' && r.path === '/c1/comments', fbOk({ id: 'c1_r1' }));

  await applyViaPlan(
    'facebook_reply_to_comment',
    {
      comment_id: 'c1',
      attachment: { kind: 'image_url', url: 'https://cdn.example.com/a.jpg' },
    },
    ctx,
  );
  await applyViaPlan(
    'facebook_reply_to_comment',
    {
      comment_id: 'c1',
      message: 'ha',
      attachment: { kind: 'gif_url', url: 'https://media.giphy.com/x.gif' },
    },
    ctx,
  );

  assert.deepEqual(bodyOf(fb.calls[0] as JsonRequest), {
    attachment_url: 'https://cdn.example.com/a.jpg',
  });
  assert.deepEqual(bodyOf(fb.calls[1] as JsonRequest), {
    message: 'ha',
    attachment_share_url: 'https://media.giphy.com/x.gif',
  });
  assert.deepEqual(journal.entries[0]?.metadata, {
    commentId: 'c1',
    messageChars: 0,
    attachmentKind: 'image_url',
  });
  assert.ok(
    !JSON.stringify(journal.entries).includes('cdn.example.com'),
    'the journal names the attachment kind, never its URL',
  );
});

test('a reply uploads a local photo as the multipart source part', async (t) => {
  const media = await photoFixture(t);
  const { fb, ctx } = makeHarness({ mediaDir: media.dir });
  fb.on((r) => r.method === 'POST' && r.path === '/c1/comments', fbOk({ id: 'c1_r1' }));

  const payload = body(
    await applyViaPlan(
      'facebook_reply_to_comment',
      {
        comment_id: 'c1',
        message: 'Here',
        attachment: { kind: 'photo_path', path: media.name },
      },
      ctx,
    ),
  );

  assert.equal(payload.status, 'applied');
  const call = fb.calls[0];
  assert.ok(call && call.protocol === 'multipart');
  assert.deepEqual(call.fields, { message: 'Here' });
  assert.equal(call.files.length, 1);
  assert.equal(call.files[0]?.name, 'source');
  assert.equal(call.files[0]?.filename, 'pic.png');
  assert.equal(call.files[0]?.contentType, 'image/png');
  assert.equal(call.files[0]?.data.length, PNG_BYTES.length + 4);
});

test('a planned local photo rewritten before apply is refused, not uploaded', async (t) => {
  const media = await photoFixture(t);
  const { fb, ctx } = makeHarness({ mediaDir: media.dir, writeMode: 'plan' });
  const args = { comment_id: 'c1', attachment: { kind: 'photo_path', path: media.name } };

  const preview = body(await tool('facebook_reply_to_comment').handler(args, ctx));
  assert.equal(preview.status, 'preview');
  assert.ok(str(preview.summary).includes('pic.png'));

  await writeFile(join(media.dir, media.name), Buffer.from([...PNG_BYTES, 9, 9, 9, 9]));
  await assert.rejects(() =>
    tool('facebook_reply_to_comment').handler(
      { ...args, apply: true, plan_id: str(preview.planId) },
      ctx,
    ),
  );
  assert.equal(fb.calls.length, 0, 'a different file must never be uploaded');
});

test('reply attachments are checked locally before anything is sent', async (t) => {
  const media = await photoFixture(t);
  const refused: Record<string, unknown>[] = [
    { comment_id: 'c1' },
    {
      comment_id: 'c1',
      attachment: { kind: 'image_url', url: 'http://cdn.example.com/a.jpg' },
    },
    {
      comment_id: 'c1',
      attachment: { kind: 'gif_url', url: 'https://user:pw@cdn.example.com/a.gif' },
    },
    { comment_id: 'c1', attachment: { kind: 'image_url', path: 'pic.png' } },
    {
      comment_id: 'c1',
      attachment: {
        kind: 'photo_path',
        path: 'pic.png',
        url: 'https://cdn.example.com/a.jpg',
      },
    },
    { comment_id: 'c1', attachment: { kind: 'photo_path', path: '../outside.png' } },
    { comment_id: 'c1', attachment: { kind: 'photo_path', path: 'missing.png' } },
  ];
  for (const args of refused) {
    const { fb, ctx } = makeHarness({ mediaDir: media.dir });
    await assert.rejects(
      () => tool('facebook_reply_to_comment').handler(args, ctx),
      isValidationRefusal,
      JSON.stringify(args),
    );
    assert.equal(fb.calls.length, 0);
  }

  // Without FB_MEDIA_DIR no local file is read at all.
  const { fb, ctx } = makeHarness();
  await assert.rejects(
    () =>
      tool('facebook_reply_to_comment').handler(
        {
          comment_id: 'c1',
          attachment: { kind: 'photo_path', path: join(media.dir, media.name) },
        },
        ctx,
      ),
    isValidationRefusal,
  );
  assert.equal(fb.calls.length, 0);
});

test('a comment on a post previews the post excerpt and mutates nothing in plan mode', async () => {
  const { fb, ctx, journal } = makeHarness({ writeMode: 'plan' });
  fb.on((r) => r.method === 'GET' && r.path === `/${POST_ID}`, fbOk(postNode()));

  const payload = body(
    await tool('facebook_comment_on_post').handler(
      { post_id: POST_ID, message: 'Tickets are live — link in bio' },
      ctx,
    ),
  );

  assert.equal(payload.status, 'preview');
  assert.equal(payload.tier, 'reversible');
  assert.ok(str(payload.summary).includes(`Comment as ${PAGE.name}`));
  assert.ok(str(payload.summary).includes(`on post ${POST_ID}`));
  assert.ok(str(payload.summary).includes('Tickets are live'));
  const warnings = arr(payload.warnings).map(str);
  assert.ok(warnings.some((w) => w.includes('Our autumn tour starts on Friday')));
  assert.ok(!warnings.some((w) => w.includes("another Page's")));
  assert.deepEqual(paramsOf(firstCall(fb)), { fields: 'id,message,from,created_time' });
  assert.ok(!anyCall(fb, 'POST'), 'a dry run must not post');
  assert.ok(str(payload.notPerformedNotice).includes('no comment was posted'));
  assert.equal(journal.entries.length, 0);
});

test("a comment on another author's post warns and quotes it only inside a taint envelope", async () => {
  const { fb, ctx } = makeHarness({ writeMode: 'plan' });
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${POST_ID}`,
    fbOk(postNode({ from: { id: 'u77', name: 'Someone' }, message: INJECTION })),
  );

  const payload = body(
    await tool('facebook_comment_on_post').handler(
      { post_id: POST_ID, message: 'Thanks!' },
      ctx,
    ),
  );

  const warnings = arr(payload.warnings).map(str);
  assert.ok(warnings.some((w) => w.includes("another Page's or user's post")));
  const quoted = warnings.find((w) => w.includes('Ignore all previous'));
  assert.ok(quoted, 'the foreign post is quoted');
  assert.ok(quoted.includes(TAINT_BEGIN) && quoted.includes(TAINT_END));
  assert.ok(!str(payload.summary).includes('Ignore all previous'));
});

test('an applied comment on a post sends message and photo and journals the write', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on((r) => r.method === 'GET' && r.path === `/${POST_ID}`, fbOk(postNode()));
  fb.on(
    (r) => r.method === 'POST' && r.path === `/${POST_ID}/comments`,
    fbOk({ id: `${POST_ID}_c1` }),
  );

  const payload = body(
    await applyViaPlan(
      'facebook_comment_on_post',
      {
        post_id: POST_ID,
        message: 'Tickets are live',
        attachment_url: 'https://example.com/poster.jpg',
      },
      ctx,
    ),
  );

  assert.equal(payload.status, 'applied');
  assert.deepEqual(payload.result, { id: `${POST_ID}_c1` });
  const post = jsonCalls(fb).find((r) => r.method === 'POST');
  assert.ok(post);
  assert.deepEqual(bodyOf(post), {
    message: 'Tickets are live',
    attachment_url: 'https://example.com/poster.jpg',
  });
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0]?.outcome, 'applied');
  assert.deepEqual(journal.entries[0]?.metadata, {
    postId: POST_ID,
    messageChars: 16,
    withPhoto: true,
  });
});

test('a comment on a post whose answer was lost is attempted and points at the listing', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on((r) => r.method === 'GET' && r.path === `/${POST_ID}`, fbOk(postNode()));
  fb.on(
    (r) => r.method === 'POST' && r.path === `/${POST_ID}/comments`,
    fbErr(ambiguousWriteError()),
  );

  await assert.rejects(
    () =>
      applyViaPlan('facebook_comment_on_post', { post_id: POST_ID, message: 'Hi' }, ctx),
    (err: unknown) =>
      err instanceof GraphApiError && err.action?.category === 'ambiguous',
  );
  assert.equal(
    jsonCalls(fb).filter((r) => r.method === 'POST').length,
    1,
    'a lost answer is never retried',
  );
  assert.equal(journal.entries[0]?.outcome, 'attempted');
});

test('a comment acknowledged without an id is not applied and says to check the listing', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on((r) => r.method === 'GET' && r.path === `/${POST_ID}`, fbOk(postNode()));
  fb.on((r) => r.method === 'POST' && r.path === `/${POST_ID}/comments`, fbOk({}));

  const payload = body(
    await applyViaPlan(
      'facebook_comment_on_post',
      { post_id: POST_ID, message: 'Hi' },
      ctx,
    ),
  );

  assert.equal(payload.status, 'not_applied');
  assert.equal(payload.outcome, 'attempted');
  assert.ok(str(obj(payload.result).note).includes('facebook_list_comments'));
  assert.equal(journal.entries[0]?.outcome, 'attempted');
});

test('a comment with neither message nor photo is refused before any call', async () => {
  const { fb, ctx } = makeHarness();
  await assert.rejects(
    () => tool('facebook_comment_on_post').handler({ post_id: POST_ID }, ctx),
    (err: unknown) =>
      err instanceof GraphApiError && err.action?.category === 'validation',
  );
  assert.equal(fb.calls.length, 0);
});

test('a comment photo must be an https URL without credentials', () => {
  const schema = tool('facebook_comment_on_post').inputSchema;
  for (const bad of [
    'http://example.com/a.jpg',
    'file:///etc/passwd',
    'https://user:pw@example.com/a.jpg',
  ]) {
    assert.equal(
      schema.safeParse({ post_id: POST_ID, attachment_url: bad }).success,
      false,
      bad,
    );
  }
  assert.equal(
    schema.safeParse({ post_id: POST_ID, attachment_url: 'https://example.com/a.jpg' })
      .success,
    true,
  );
});

test('an edit preview quotes the current and the new text inside taint envelopes', async () => {
  const { fb, ctx, journal } = makeHarness({ writeMode: 'plan' });
  fb.on(isEditRead, fbOk(ownComment()));

  const result = await tool('facebook_edit_comment').handler(
    { comment_id: 'c1', message: 'Thanks for coming — doors open at 8pm' },
    ctx,
  );
  const payload = body(result);

  assert.equal(payload.status, 'preview');
  assert.equal(payload.tier, 'reversible');
  assert.ok(str(payload.summary).includes('Edit comment c1'));
  const warnings = arr(payload.warnings).map(str);
  const current = warnings.find((w) => w.startsWith('Current text:'));
  const next = warnings.find((w) => w.startsWith('New text:'));
  assert.ok(current?.includes('doors open at 7pm') && current.includes(TAINT_BEGIN));
  assert.ok(next?.includes('doors open at 8pm') && next.includes(TAINT_END));
  assert.equal(
    jsonCalls(fb).filter(isEditRead).length,
    1,
    'the pre-flight doubles as the plan snapshot',
  );
  assert.ok(!anyCall(fb, 'POST'), 'a dry run must not edit');
  assert.equal(journal.entries.length, 0);
});

test('an applied edit posts the new message and journals only fingerprints', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on(isEditRead, fbOk(ownComment()));
  fb.on((r) => r.method === 'POST' && r.path === '/c1', fbOk({ success: true }));

  const result = await applyViaPlan(
    'facebook_edit_comment',
    { comment_id: 'c1', message: 'doors open at 8pm' },
    ctx,
  );
  const payload = body(result);

  assert.equal(payload.status, 'applied');
  assert.deepEqual(payload.result, { id: 'c1', edited: true });
  const post = jsonCalls(fb).find((r) => r.method === 'POST');
  assert.ok(post);
  assert.deepEqual(bodyOf(post), { message: 'doors open at 8pm' });
  const metadata = obj(journal.entries[0]?.metadata);
  assert.equal(journal.entries[0]?.outcome, 'applied');
  assert.equal(metadata.commentId, 'c1');
  assert.equal(metadata.messageChars, 17);
  assert.match(str(metadata.previousFingerprint), /^[0-9a-f]{16}$/);
  assert.notEqual(metadata.previousFingerprint, metadata.messageFingerprint);
  assert.ok(!JSON.stringify(journal.entries[0]).includes('doors open'));
});

test('an edit of a comment the Page did not write is refused before any write', async () => {
  for (const node of [
    { id: 'c1', from: { id: 'u1' }, message: INJECTION },
    { id: 'c1', message: 'author hidden by permissions' },
  ]) {
    const { fb, ctx, journal } = makeHarness();
    fb.on(isEditRead, fbOk(node));
    await assert.rejects(
      () =>
        tool('facebook_edit_comment').handler({ comment_id: 'c1', message: 'x' }, ctx),
      (err: unknown) =>
        err instanceof GraphApiError &&
        err.action?.category === 'validation' &&
        err.message.includes("Only the Page's own comments") &&
        !err.message.includes('Ignore all previous'),
    );
    assert.ok(!anyCall(fb, 'POST'));
    assert.equal(journal.entries.length, 0);
  }
});

test('an edit of a comment changed after the preview diverges and writes nothing', async () => {
  const { fb, ctx } = makeHarness({ writeMode: 'plan' });
  fb.on(isEditRead, fbOk(ownComment('first text')), 1);
  fb.on(isEditRead, fbOk(ownComment('changed by a colleague')));
  fb.on((r) => r.method === 'POST', fbOk({ success: true }));
  const edit = tool('facebook_edit_comment');

  const preview = body(
    await edit.handler({ comment_id: 'c1', message: 'new text' }, ctx),
  );
  const result = await edit.handler(
    { comment_id: 'c1', message: 'new text', apply: true, plan_id: str(preview.planId) },
    ctx,
  );
  const payload = body(result);

  assert.equal(payload.status, 'diverged');
  assert.ok(!anyCall(fb, 'POST'));
  assert.ok(!text(result).includes('changed by a colleague'));
});

test('an edit Facebook answers with success:false is failed, not applied', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on(isEditRead, fbOk(ownComment()));
  fb.on((r) => r.method === 'POST', fbOk({ success: false }));

  const payload = body(
    await applyViaPlan('facebook_edit_comment', { comment_id: 'c1', message: 'x' }, ctx),
  );

  assert.notEqual(payload.status, 'applied');
  assert.equal(obj(payload.result).edited, false);
  assert.equal(journal.entries[0]?.outcome, 'failed');
});

test('an edit of a deleted comment surfaces the not-found error and writes nothing', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(isEditRead, fbErr(goneError()));
  await assert.rejects(
    () => tool('facebook_edit_comment').handler({ comment_id: 'c1', message: 'x' }, ctx),
    (err: unknown) => err instanceof GraphApiError && err.code === 100,
  );
  assert.ok(!anyCall(fb, 'POST'));
});
