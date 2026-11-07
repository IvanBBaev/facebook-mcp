// Tests for the `moderation` tool package: facebook_triage_comments and
// facebook_reply_and_hide_comment.
//
// Split out of `moderation.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/moderation.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fbErr, fbOk, type FakeFbRequest } from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import type { FbRequest, JsonRequest } from '../core/index.js';
import { EMPTY_PAGE_TOKEN_HINT } from '../api/comments.js';
import { TAINT_BEGIN, TAINT_END, TAINT_WARNING } from '../mcp/index.js';
import type { WriteToolContext } from './shared.js';
import {
  CREATED,
  INJECTION,
  PAGE,
  anyCall,
  arr,
  body,
  bodyOf,
  goneError,
  isStateRead,
  jsonCalls,
  makeHarness,
  obj,
  permissionError,
  rawComment,
  str,
  text,
  tool,
} from '../testing/harness/moderation.js';

// ---------------------------------------------------------------------------
// facebook_triage_comments
// ---------------------------------------------------------------------------

const TRIAGE_POST = '900_1';
const TRIAGE_POST_2 = '900_2';

/** Serve `published_posts`; the per-post comment reads are stubbed per test. */
function serveTriagePosts(fb: FakeFbRequest, ids: readonly string[]): void {
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${PAGE.pageId}/published_posts`,
    fbOk({ data: ids.map((id) => ({ id, created_time: CREATED })) }),
  );
}

/** The thread read the unanswered check makes (`fields=from{id}`). */
function isReplyRead(r: FbRequest, commentId: string): boolean {
  return (
    r.method === 'GET' &&
    r.path === `/${commentId}/comments` &&
    r.protocol === 'json' &&
    r.params?.fields === 'from{id}'
  );
}

test('facebook_triage_comments lists only threads the Page has not answered', async () => {
  const { fb, ctx } = makeHarness();
  serveTriagePosts(fb, [TRIAGE_POST]);
  fb.on(
    (r) => isReplyRead(r, 'c1'),
    fbOk({ data: [{ id: 'c1_r1', from: { id: PAGE.pageId } }] }),
  );
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${TRIAGE_POST}/comments`,
    fbOk({
      data: [
        rawComment({ id: 'c1', comment_count: 1 }),
        rawComment({ id: 'c2', comment_count: 0, message: INJECTION }),
        rawComment({ id: 'c3', from: { id: PAGE.pageId, name: 'Test Page' } }),
      ],
    }),
  );

  const result = await tool('facebook_triage_comments').handler({}, ctx);
  const payload = body(result);

  assert.equal(payload.pageId, PAGE.pageId);
  assert.equal(payload.scannedPosts, 1);
  assert.equal(payload.truncated, false);
  const items = arr(payload.items).map(obj);
  assert.deepEqual(
    items.map((i) => i.commentId),
    ['c2'],
    'c1 has a Page reply and c3 is the Page itself',
  );
  assert.equal(items[0]?.pageReplied, false);
  assert.equal(items[0]?.postId, TRIAGE_POST);
  assert.equal(items[0]?.authorId, 'u1');

  // The comment text exists only inside the taint envelope.
  const content = str(items[0]?.content);
  assert.ok(content.startsWith(TAINT_WARNING));
  assert.ok(content.indexOf(TAINT_BEGIN) < content.indexOf(INJECTION));
  assert.ok(content.indexOf(INJECTION) < content.indexOf(TAINT_END));
  assert.equal(text(result).split(INJECTION).length - 1, 1);
  assert.ok(!text(result).includes(PAGE.token));

  for (const call of fb.calls) assert.equal(call.token, PAGE.token);
});

test('facebook_triage_comments matches keywords case- and width-insensitively', async () => {
  const { fb, ctx } = makeHarness();
  serveTriagePosts(fb, [TRIAGE_POST]);
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${TRIAGE_POST}/comments`,
    fbOk({
      data: [
        rawComment({ id: 'c1', message: 'What is the ＰＲＩＣＥ?' }),
        rawComment({ id: 'c2', message: 'lovely' }),
      ],
    }),
  );

  const payload = body(
    await tool('facebook_triage_comments').handler(
      { status: 'all', keywords: ['price', 'refund'] },
      ctx,
    ),
  );

  const items = arr(payload.items).map(obj);
  assert.deepEqual(
    items.map((i) => i.commentId),
    ['c1'],
  );
  assert.deepEqual(items[0]?.matchedKeywords, ['price']);
});

test('facebook_triage_comments turns one unreadable post into a note, not a failure', async () => {
  const { fb, ctx } = makeHarness();
  serveTriagePosts(fb, [TRIAGE_POST, TRIAGE_POST_2]);
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${TRIAGE_POST}/comments`,
    fbErr(goneError()),
  );
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${TRIAGE_POST_2}/comments`,
    fbOk({ data: [rawComment({ id: 'c9' })] }),
  );

  const payload = body(await tool('facebook_triage_comments').handler({}, ctx));

  assert.equal(payload.truncated, true);
  assert.deepEqual(
    arr(payload.items).map((i) => obj(i).commentId),
    ['c9'],
  );
  assert.ok(
    arr(payload.notes).some((n) => str(n).includes(`post ${TRIAGE_POST}`)),
    'the failed post is named in a note',
  );
});

test('facebook_triage_comments explains a Page with no published posts', async () => {
  const { fb, ctx } = makeHarness();
  serveTriagePosts(fb, []);

  const payload = body(await tool('facebook_triage_comments').handler({}, ctx));

  assert.equal(payload.count, 0);
  assert.ok(arr(payload.notes).some((n) => str(n).includes(EMPTY_PAGE_TOKEN_HINT)));
});

test('facebook_triage_comments rejects a since without a timezone offset', () => {
  const schema = tool('facebook_triage_comments').inputSchema;
  assert.equal(schema.safeParse({ since: '2026-07-01T10:00:00' }).success, false);
  assert.equal(schema.safeParse({ since: '2026-07-01T10:00:00+03:00' }).success, true);
  assert.equal(schema.safeParse({ keywords: [''] }).success, false);
});

// ---------------------------------------------------------------------------
// facebook_reply_and_hide_comment (v2 F7)
// ---------------------------------------------------------------------------

const REPLY_AND_HIDE = 'facebook_reply_and_hide_comment';
const REPLY_AND_HIDE_ARGS = { comment_id: 'c1', message: 'We have sent you a DM.' };

function isReplyPost(r: FbRequest): boolean {
  return r.method === 'POST' && r.path === '/c1/comments';
}

function isHidePost(r: FbRequest): boolean {
  return r.method === 'POST' && r.path === '/c1';
}

/** Preview, then apply the plan the preview handed back. */
async function replyAndHide(
  ctx: WriteToolContext,
  args: Record<string, unknown> = REPLY_AND_HIDE_ARGS,
): Promise<{ preview: Record<string, unknown>; applied: Record<string, unknown> }> {
  const preview = body(await tool(REPLY_AND_HIDE).handler(args, ctx));
  const applied = body(
    await tool(REPLY_AND_HIDE).handler(
      { ...args, apply: true, plan_id: preview.planId },
      ctx,
    ),
  );
  return { preview, applied };
}

test('reply_and_hide previews first and posts the reply before the hide', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on(isStateRead, fbOk({ id: 'c1', message: 'spam', is_hidden: false }));
  fb.on(isReplyPost, fbOk({ id: 'c1_r1' }));
  fb.on(isHidePost, fbOk({ success: true }));

  // The package default is apply, but this verb is plan-bound: apply:true alone
  // is still a preview.
  const unbound = body(
    await tool(REPLY_AND_HIDE).handler({ ...REPLY_AND_HIDE_ARGS, apply: true }, ctx),
  );
  assert.equal(unbound.status, 'preview');
  assert.ok(!anyCall(fb, 'POST'));

  const { preview, applied } = await replyAndHide(ctx);
  assert.equal(preview.status, 'preview');
  assert.ok(
    str(preview.summary).startsWith(
      'Reply publicly to comment c1 (22 chars), then hide comment c1',
    ),
    str(preview.summary),
  );
  assert.equal(applied.status, 'applied');
  assert.equal(applied.applied, true);
  assert.deepEqual(applied.result, {
    commentId: 'c1',
    outcome: 'applied',
    reply: { outcome: 'applied', replyId: 'c1_r1' },
    hide: { outcome: 'applied' },
  });

  const writes = jsonCalls(fb).filter((r) => r.method === 'POST');
  assert.deepEqual(
    writes.map((r) => r.path),
    ['/c1/comments', '/c1'],
    'the reply goes first, the hide second',
  );
  assert.deepEqual(bodyOf(writes[1] as JsonRequest), { is_hidden: true });
  assert.equal(journal.entries.at(-1)?.outcome, 'applied');
});

test('reply_and_hide on an already-hidden comment warns and only replies', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(isStateRead, fbOk({ id: 'c1', message: 'spam', is_hidden: true }));
  fb.on(isReplyPost, fbOk({ id: 'c1_r1' }));
  fb.on(isHidePost, fbOk({ success: true }));

  const { preview, applied } = await replyAndHide(ctx);
  assert.ok(arr(preview.warnings).some((w) => str(w).includes('already hidden')));
  assert.equal(applied.status, 'applied');
  const result = obj(applied.result);
  assert.equal(obj(result.hide).outcome, 'skipped');
  assert.equal(result.nextStep, undefined);
  assert.ok(!anyCall(fb, 'POST', '/c1'), 'no hide is sent for a hidden comment');
});

test('reply_and_hide reports a failed hide as attempted with the follow-up call', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on(isStateRead, fbOk({ id: 'c1', message: 'spam', is_hidden: false }));
  fb.on(isReplyPost, fbOk({ id: 'c1_r1' }));
  fb.on(isHidePost, fbErr(permissionError()));

  const { applied } = await replyAndHide(ctx);
  assert.equal(applied.applied, false);
  const result = obj(applied.result);
  assert.equal(result.outcome, 'attempted');
  assert.deepEqual(result.reply, { outcome: 'applied', replyId: 'c1_r1' });
  assert.equal(obj(result.hide).outcome, 'failed');
  assert.equal(
    result.nextStep,
    'facebook_hide_comment {"comment_ids":["c1"],"hidden":true}',
  );
  assert.equal(journal.entries.at(-1)?.outcome, 'attempted');
});

test('reply_and_hide hides nothing when the reply fails', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on(isStateRead, fbOk({ id: 'c1', message: 'spam', is_hidden: false }));
  fb.on(isReplyPost, fbErr(permissionError()));
  fb.on(isHidePost, fbOk({ success: true }));

  const preview = body(await tool(REPLY_AND_HIDE).handler(REPLY_AND_HIDE_ARGS, ctx));
  await assert.rejects(
    () =>
      tool(REPLY_AND_HIDE).handler(
        { ...REPLY_AND_HIDE_ARGS, apply: true, plan_id: preview.planId },
        ctx,
      ),
    (err: unknown) => err instanceof GraphApiError && err.code === 200,
  );
  assert.ok(!anyCall(fb, 'POST', '/c1'), 'step 2 is never attempted');
  assert.equal(journal.entries.at(-1)?.outcome, 'failed');
});

test('reply_and_hide diverges when the comment changed after the preview', async () => {
  const { fb, ctx } = makeHarness();
  // The preview reads the original; every later read sees the edit.
  fb.on(isStateRead, fbOk({ id: 'c1', message: 'spam', is_hidden: false }), 1);
  fb.on(isStateRead, fbOk({ id: 'c1', message: 'edited', is_hidden: false }));
  fb.on(isReplyPost, fbOk({ id: 'c1_r1' }));

  const preview = body(await tool(REPLY_AND_HIDE).handler(REPLY_AND_HIDE_ARGS, ctx));
  const applied = body(
    await tool(REPLY_AND_HIDE).handler(
      { ...REPLY_AND_HIDE_ARGS, apply: true, plan_id: preview.planId },
      ctx,
    ),
  );
  assert.equal(applied.status, 'diverged');
  assert.ok(!anyCall(fb, 'POST'));
});
