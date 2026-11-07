// Tests for the `moderation` tool package: facebook_private_reply and blocked users.
//
// Split out of `moderation.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/moderation.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fbErr, fbOk } from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import { NOT_BLOCKED_NOTE, PRIVATE_REPLY_WINDOW_MS } from '../api/comments.js';
import {
  CREATED,
  CREATED_MS,
  DAY_MS,
  type Harness,
  NOW_MS,
  PAGE,
  PRIVATE_REPLY_ARGS,
  SECOND_PAGE,
  ambiguousWriteError,
  anyCall,
  arr,
  body,
  bodyOf,
  callAt,
  firstCall,
  jsonCalls,
  makeHarness,
  obj,
  paramsOf,
  rawComment,
  str,
  tool,
} from '../testing/harness/moderation.js';

test('a private reply outside the 7-day window is refused before the attempt is spent', async () => {
  const { fb, ctx, journal } = makeHarness({
    nowMs: CREATED_MS + PRIVATE_REPLY_WINDOW_MS + 1,
  });
  fb.on((r) => r.method === 'GET' && r.path === '/c1', fbOk(rawComment()));

  await assert.rejects(
    () =>
      tool('facebook_private_reply').handler(
        { ...PRIVATE_REPLY_ARGS, apply: true, plan_id: 'plan-forged' },
        ctx,
      ),
    (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.ok(err.message.includes('7-day private-reply window'));
      assert.ok(err.message.includes('do NOT retry'));
      assert.equal(err.action?.retryable, false);
      assert.equal(err.action?.category, 'validation');
      assert.equal(err.action?.nextTool, 'facebook_reply_to_comment');
      return true;
    },
  );

  assert.ok(!anyCall(fb, 'POST'), 'the single attempt must not be spent');
  assert.equal(journal.entries.length, 0, 'the refusal never reached the gate');
});

test('an unreadable created_time fails closed rather than gambling the one attempt', async () => {
  const { fb, ctx } = makeHarness();
  fb.on((r) => r.method === 'GET', fbOk(rawComment({ created_time: 'not-a-date' })));

  await assert.rejects(
    () =>
      tool('facebook_private_reply').handler(
        { ...PRIVATE_REPLY_ARGS, apply: true, plan_id: 'plan-forged' },
        ctx,
      ),
    /creation time could not be read/,
  );
  assert.ok(!anyCall(fb, 'POST'));
});

test('a private reply previews the window and the one-shot cost before applying', async () => {
  const { fb, ctx } = makeHarness();
  fb.on((r) => r.method === 'GET', fbOk(rawComment({ can_reply_privately: false })));

  const payload = body(
    await tool('facebook_private_reply').handler(PRIVATE_REPLY_ARGS, ctx),
  );

  assert.equal(payload.status, 'preview');
  assert.equal(payload.tier, 'irreversible');
  const warnings = arr(payload.warnings).map(str);
  assert.ok(warnings.some((w) => w.includes('no second attempt')));
  assert.ok(
    warnings.some((w) =>
      w.includes(new Date(CREATED_MS + PRIVATE_REPLY_WINDOW_MS).toISOString()),
    ),
  );
  // Facebook's own eligibility flag is advisory: it warns, it does not refuse.
  assert.ok(warnings.some((w) => w.includes('can_reply_privately=false')));
  assert.ok(!anyCall(fb, 'POST'));
});

test('an applied private reply posts to the Page messages edge and journals the send', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on((r) => r.method === 'GET', fbOk(rawComment()));
  fb.on(
    (r) => r.method === 'POST' && r.path === `/${PAGE.pageId}/messages`,
    fbOk({ message_id: 'm_1', recipient_id: 'psid_1' }),
  );
  const pr = tool('facebook_private_reply');

  const preview = body(await pr.handler(PRIVATE_REPLY_ARGS, ctx));
  const payload = body(
    await pr.handler(
      { ...PRIVATE_REPLY_ARGS, apply: true, plan_id: str(preview.planId) },
      ctx,
    ),
  );

  assert.equal(payload.status, 'applied');
  assert.deepEqual(payload.result, { messageId: 'm_1', recipientId: 'psid_1' });

  const post = jsonCalls(fb).find((r) => r.method === 'POST');
  assert.ok(post);
  assert.deepEqual(bodyOf(post), {
    recipient: { comment_id: 'c1' },
    message: { text: PRIVATE_REPLY_ARGS.message },
  });

  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0]?.outcome, 'applied');
  assert.equal(obj(journal.entries[0]?.metadata).commentAgeMs, 2 * DAY_MS);
});

test('a private reply acknowledged without a message id is not applied and journalled attempted', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on((r) => r.method === 'GET', fbOk(rawComment()));
  // A 200 with no `message_id`: the one-shot may already be spent and the
  // message may already be in the inbox, or neither. Stamping `applied` here
  // tells the model the send is done; stamping `failed` invites a retry. The
  // honest verdict is ATTEMPTED — verify in the inbox before anything else.
  fb.on((r) => r.method === 'POST' && r.path === `/${PAGE.pageId}/messages`, fbOk({}));
  const pr = tool('facebook_private_reply');

  const preview = body(await pr.handler(PRIVATE_REPLY_ARGS, ctx));
  const payload = body(
    await pr.handler(
      { ...PRIVATE_REPLY_ARGS, apply: true, plan_id: str(preview.planId) },
      ctx,
    ),
  );

  assert.equal(payload.status, 'not_applied');
  assert.equal(payload.applied, false);
  assert.equal(payload.outcome, 'attempted');
  assert.ok(str(payload.notPerformedNotice).includes('ATTEMPTED'));
  const result = obj(payload.result);
  assert.equal(result.messageId, undefined);
  assert.ok(str(result.note).includes('facebook_list_conversations'));
  assert.ok(anyCall(fb, 'POST', `/${PAGE.pageId}/messages`), 'the send really went out');

  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0]?.outcome, 'attempted');
});

test('an exhausted one-shot maps to a terminal do-not-retry refusal journaled as failed', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on((r) => r.method === 'GET', fbOk(rawComment()));
  fb.on(
    (r) => r.method === 'POST',
    fbErr(
      new GraphApiError(
        '(#10) This comment has already been replied to privately; only one private reply is allowed.',
        { code: 10, httpStatus: 400 },
      ),
    ),
  );
  const pr = tool('facebook_private_reply');

  const preview = body(await pr.handler(PRIVATE_REPLY_ARGS, ctx));

  await assert.rejects(
    () =>
      pr.handler(
        { ...PRIVATE_REPLY_ARGS, apply: true, plan_id: str(preview.planId) },
        ctx,
      ),
    (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.ok(err.message.includes('has already been used'));
      assert.ok(err.message.includes('do NOT retry'));
      assert.equal(err.action?.retryable, false);
      assert.equal(err.action?.nextTool, 'facebook_reply_to_comment');
      assert.equal(err.code, 10, 'the originating Graph code is preserved');
      return true;
    },
  );

  // Facebook ANSWERED, and the answer is a refusal: nothing was delivered by
  // this call, so the journal records a failure. `attempted` would send an
  // operator hunting the inbox for a message that provably never went out.
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0]?.outcome, 'failed');
});

test('a private reply whose answer was lost is journaled attempted', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on((r) => r.method === 'GET', fbOk(rawComment()));
  fb.on((r) => r.method === 'POST', fbErr(ambiguousWriteError()));
  const pr = tool('facebook_private_reply');

  const preview = body(await pr.handler(PRIVATE_REPLY_ARGS, ctx));
  await assert.rejects(() =>
    pr.handler({ ...PRIVATE_REPLY_ARGS, apply: true, plan_id: str(preview.planId) }, ctx),
  );

  // C2: the send reached Facebook and the answer was lost — it may be delivered.
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0]?.outcome, 'attempted');
});

test("a private reply to the Page's own comment is refused before anything is sent", async () => {
  const { fb, ctx, journal } = makeHarness();
  // The Page wrote this comment itself: there is no other person to message,
  // so the one-shot send can never succeed and a preview promising it is false.
  fb.on(
    (r) => r.method === 'GET',
    fbOk(rawComment({ from: { id: PAGE.pageId, name: PAGE.name } })),
  );

  await assert.rejects(
    () => tool('facebook_private_reply').handler(PRIVATE_REPLY_ARGS, ctx),
    (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.ok(err.message.includes('written by the Page itself'), err.message);
      assert.equal(err.action?.retryable, false);
      assert.equal(err.action?.category, 'validation');
      return true;
    },
  );
  assert.ok(!anyCall(fb, 'POST'), 'nothing may be sent');
  assert.equal(journal.entries.length, 0);
});

// --- Private reply to a visitor post, attachments, one-shot journal (F4) ---

const POST_REPLY_ARGS = { post_id: '123_456', message: 'Thanks for the post — DM us.' };

/** The fields a private-reply pre-flight reads from a visitor post. */
function rawVisitorPost(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: '123_456',
    created_time: CREATED,
    from: { id: 'u1' },
    can_reply_privately: true,
    ...overrides,
  };
}

test('a private reply to a visitor post sends recipient.post_id and journals the post', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on((r) => r.method === 'GET' && r.path === '/123_456', fbOk(rawVisitorPost()));
  fb.on(
    (r) => r.method === 'POST' && r.path === `/${PAGE.pageId}/messages`,
    fbOk({ message_id: 'm_2', recipient_id: 'psid_2' }),
  );
  const pr = tool('facebook_private_reply');

  const preview = body(await pr.handler(POST_REPLY_ARGS, ctx));
  assert.equal(preview.status, 'preview');
  assert.ok(str(preview.summary).includes('visitor post 123_456'), str(preview.summary));
  const payload = body(
    await pr.handler(
      { ...POST_REPLY_ARGS, apply: true, plan_id: str(preview.planId) },
      ctx,
    ),
  );

  assert.equal(payload.status, 'applied');
  const post = jsonCalls(fb).find((r) => r.method === 'POST');
  assert.ok(post);
  assert.deepEqual(bodyOf(post), {
    recipient: { post_id: '123_456' },
    message: { text: POST_REPLY_ARGS.message },
  });
  const metadata = obj(journal.entries[0]?.metadata);
  assert.equal(metadata.postId, '123_456');
  assert.equal(metadata.postAgeMs, 2 * DAY_MS);
  assert.equal(metadata.commentId, undefined);
});

test('a private reply needs exactly one of comment_id or post_id', async () => {
  const { fb, ctx } = makeHarness();
  const pr = tool('facebook_private_reply');

  await assert.rejects(
    () => pr.handler({ ...PRIVATE_REPLY_ARGS, post_id: '123_456' }, ctx),
    /exactly one of `comment_id` or `post_id`/,
  );
  await assert.rejects(
    () => pr.handler({ message: 'hi' }, ctx),
    /exactly one of `comment_id` or `post_id`/,
  );
  assert.equal(fb.calls.length, 0, 'refused before any Graph call');
});

test("a private reply to the Page's own post is refused before anything is sent", async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on((r) => r.method === 'GET', fbOk(rawVisitorPost({ from: { id: PAGE.pageId } })));

  await assert.rejects(
    () => tool('facebook_private_reply').handler(POST_REPLY_ARGS, ctx),
    (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.ok(err.message.includes('post 123_456'), err.message);
      assert.equal(err.action?.retryable, false);
      return true;
    },
  );
  assert.ok(!anyCall(fb, 'POST'));
  assert.equal(journal.entries.length, 0);
});

test('a visitor post outside the 7-day window is refused with a post-specific message', async () => {
  const { fb, ctx } = makeHarness({ nowMs: CREATED_MS + PRIVATE_REPLY_WINDOW_MS + 1 });
  fb.on((r) => r.method === 'GET', fbOk(rawVisitorPost()));

  await assert.rejects(
    () => tool('facebook_private_reply').handler(POST_REPLY_ARGS, ctx),
    (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.ok(err.message.includes('7-day private-reply window'), err.message);
      assert.ok(err.message.includes('post'), err.message);
      return true;
    },
  );
  assert.ok(!anyCall(fb, 'POST'));
});

/** Record an earlier private reply in the journal, as a real send would. */
async function seedPriorPrivateReply(
  h: Harness,
  outcome: 'applied' | 'attempted' | 'failed',
  metadata: Record<string, unknown> = { commentId: 'c1' },
): Promise<void> {
  await h.journal.append({
    tool: 'facebook_private_reply',
    tier: 'irreversible',
    pageId: PAGE.pageId,
    outcome,
    summary: 'earlier private reply',
    metadata,
  });
}

test('a private reply the journal records as delivered is refused, even with allow_repeat', async () => {
  const h = makeHarness();
  h.fb.on((r) => r.method === 'GET', fbOk(rawComment()));
  await seedPriorPrivateReply(h, 'applied');

  for (const args of [
    PRIVATE_REPLY_ARGS,
    { ...PRIVATE_REPLY_ARGS, allow_repeat: true },
  ]) {
    await assert.rejects(
      () => tool('facebook_private_reply').handler(args, h.ctx),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        assert.ok(err.message.includes('already sent (or attempted)'), err.message);
        assert.ok(err.message.includes('do NOT retry'), err.message);
        assert.ok(err.message.includes(new Date(NOW_MS).toISOString()), err.message);
        assert.equal(err.action?.nextTool, 'facebook_list_conversations');
        return true;
      },
    );
  }
  assert.ok(!anyCall(h.fb, 'POST'));
});

test('an attempted private reply in the journal needs allow_repeat to try again', async () => {
  const h = makeHarness();
  h.fb.on((r) => r.method === 'GET', fbOk(rawComment()));
  await seedPriorPrivateReply(h, 'attempted');
  const pr = tool('facebook_private_reply');

  await assert.rejects(() => pr.handler(PRIVATE_REPLY_ARGS, h.ctx), /allow_repeat:true/);

  const preview = body(
    await pr.handler({ ...PRIVATE_REPLY_ARGS, allow_repeat: true }, h.ctx),
  );
  assert.equal(preview.status, 'preview');
  assert.ok(
    arr(preview.warnings)
      .map(str)
      .some((w) => w.includes('allow_repeat')),
  );
});

test('journal entries for other targets, other Pages or failed sends do not block', async () => {
  const h = makeHarness();
  h.fb.on((r) => r.method === 'GET', fbOk(rawComment()));
  await seedPriorPrivateReply(h, 'applied', { commentId: 'c2' });
  await seedPriorPrivateReply(h, 'applied', { postId: 'c1' });
  await seedPriorPrivateReply(h, 'failed');
  await h.journal.append({
    tool: 'facebook_private_reply',
    tier: 'irreversible',
    pageId: SECOND_PAGE.pageId,
    outcome: 'applied',
    summary: 'other Page',
    metadata: { commentId: 'c1' },
  });

  const preview = body(
    await tool('facebook_private_reply').handler(PRIVATE_REPLY_ARGS, h.ctx),
  );
  assert.equal(preview.status, 'preview');
});

test('an unreadable journal warns instead of refusing', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on((r) => r.method === 'GET', fbOk(rawComment()));
  journal.failHistory();

  const preview = body(
    await tool('facebook_private_reply').handler(PRIVATE_REPLY_ARGS, ctx),
  );
  assert.equal(preview.status, 'preview');
  assert.ok(
    arr(preview.warnings)
      .map(str)
      .some((w) => w.includes('local journal could not be read')),
  );
});

test('a private reply can carry one attachment instead of text', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on((r) => r.method === 'GET', fbOk(rawComment()));
  fb.on(
    (r) => r.method === 'POST' && r.path === `/${PAGE.pageId}/messages`,
    fbOk({ message_id: 'm_3', recipient_id: 'psid_1' }),
  );
  const pr = tool('facebook_private_reply');
  const args = {
    comment_id: 'c1',
    attachment: { type: 'image', attachment_id: '1857777774821032' },
  };

  const preview = body(await pr.handler(args, ctx));
  assert.ok(str(preview.summary).includes('a image attachment (by attachment id)'));
  await pr.handler({ ...args, apply: true, plan_id: str(preview.planId) }, ctx);

  const post = jsonCalls(fb).find((r) => r.method === 'POST');
  assert.ok(post);
  assert.deepEqual(bodyOf(post), {
    recipient: { comment_id: 'c1' },
    message: {
      attachment: { type: 'image', payload: { attachment_id: '1857777774821032' } },
    },
  });
  const metadata = obj(journal.entries[0]?.metadata);
  assert.equal(metadata.attachmentType, 'image');
  assert.equal(metadata.attachmentSource, 'id');
  assert.equal(metadata.messageChars, undefined);
});

test('a private reply refuses an attachment combined with a message', async () => {
  const { fb, ctx } = makeHarness();
  await assert.rejects(
    () =>
      tool('facebook_private_reply').handler(
        { ...PRIVATE_REPLY_ARGS, attachment: { type: 'image', attachment_id: '1' } },
        ctx,
      ),
    /exactly one of/,
  );
  assert.equal(fb.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 8. Blocked users (CC-MOD-7)
// ---------------------------------------------------------------------------

test('facebook_block_user posts the PSIDs and reports one outcome per PSID', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(
    (r) => r.method === 'POST' && r.path === `/${PAGE.pageId}/blocked`,
    fbOk({
      'psid-1': true,
      'psid-2': { success: false, error: { message: 'Invalid user id' } },
    }),
  );

  const payload = body(
    await tool('facebook_block_user').handler({ psids: ['psid-1', 'psid-2'] }, ctx),
  );

  assert.equal(payload.status, 'applied');
  const result = obj(payload.result);
  assert.equal(result.total, 2);
  assert.equal(result.ok, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.outcomes, [
    { id: 'psid-1', ok: true },
    { id: 'psid-2', ok: false, error: 'Invalid user id' },
  ]);
  assert.deepEqual(bodyOf(firstCall(fb)), { psid: ['psid-1', 'psid-2'] });
});

test('facebook_unblock_user issues one DELETE per PSID and forgives a never-blocked id', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(
    (r) =>
      r.method === 'DELETE' &&
      r.path === `/${PAGE.pageId}/blocked` &&
      paramsOf(r).psid === 'psid-9',
    fbErr(
      new GraphApiError('(#100) The user is not blocked', { code: 100, httpStatus: 400 }),
    ),
  );
  fb.on(
    (r) => r.method === 'DELETE' && r.path === `/${PAGE.pageId}/blocked`,
    fbOk({ success: true }),
  );

  const payload = body(
    await tool('facebook_unblock_user').handler({ psids: ['psid-8', 'psid-9'] }, ctx),
  );

  assert.equal(payload.status, 'applied');
  const result = obj(payload.result);
  assert.equal(result.total, 2);
  assert.equal(result.ok, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.outcomes, [
    { id: 'psid-8', ok: true },
    { id: 'psid-9', ok: true, note: NOT_BLOCKED_NOTE },
  ]);
  // The DELETE form of the edge takes ONE `psid` and answers `{success}`, so the
  // batch is one call per PSID on the documented singular parameter.
  assert.equal(fb.calls.length, 2, 'one DELETE per PSID');
  assert.deepEqual(
    [0, 1].map((i) => [callAt(fb, i).method, paramsOf(callAt(fb, i)).psid]),
    [
      ['DELETE', 'psid-8'],
      ['DELETE', 'psid-9'],
    ],
  );
});

test('a block whose answer was lost is journaled attempted, not failed', async () => {
  const { fb, ctx, journal } = makeHarness();
  // Blocking is ONE POST for the whole list, so a lost answer is not caught per
  // id by the bulk runner: it rejects the call. Every PSID may now be blocked.
  fb.on(
    (r) => r.method === 'POST' && r.path === `/${PAGE.pageId}/blocked`,
    fbErr(ambiguousWriteError()),
  );

  await assert.rejects(() =>
    tool('facebook_block_user').handler({ psids: ['psid-1', 'psid-2'] }, ctx),
  );

  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0]?.outcome, 'attempted');
});

test('blocking previews under plan mode and names the inverse verb', async () => {
  const { fb, ctx } = makeHarness({ writeMode: 'plan' });

  const payload = body(
    await tool('facebook_block_user').handler({ psids: ['psid-1'] }, ctx),
  );

  assert.equal(payload.status, 'preview');
  assert.ok(str(payload.summary).includes('facebook_unblock_user'));
  assert.equal(fb.calls.length, 0);
});
