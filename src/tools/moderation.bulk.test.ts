// Tests for the `moderation` tool package: bulk semantics, likes and
// facebook_delete_comment.
//
// Split out of `moderation.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/moderation.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fbErr, fbOk } from '../core/fakes/index.js';
import type { FbRequest } from '../core/index.js';
import {
  ALREADY_GONE_NOTE,
  ALREADY_IN_LIKE_STATE_NOTE,
  LIKE_TARGET_GONE_ERROR,
  MAX_BULK_IDS,
} from '../api/comments.js';
import {
  INJECTION,
  POST_ID,
  ambiguousWriteError,
  anyCall,
  arr,
  body,
  bodyOf,
  callAt,
  firstCall,
  goneError,
  isEditRead,
  isJson,
  isStateRead,
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
// 5. Bulk semantics (CC-MOD-5, CC-MOD-1)
// ---------------------------------------------------------------------------

test('facebook_hide_comment gives every id its own outcome and never fails the batch', async () => {
  const { fb, ctx } = makeHarness();
  fb.on((r) => r.method === 'POST' && r.path === '/c1', fbOk({ success: true }));
  fb.on((r) => r.method === 'POST' && r.path === '/c2', fbErr(permissionError()));
  fb.on((r) => r.method === 'POST' && r.path === '/c3', fbErr(goneError()));
  // The confirming read: c3 is gone to a GET as well, so the hide is a no-op.
  fb.on((r) => r.method === 'GET' && r.path === '/c3', fbErr(goneError()));

  const payload = body(
    await tool('facebook_hide_comment').handler(
      { comment_ids: ['c1', 'c2', 'c3'], hidden: true },
      ctx,
    ),
  );

  assert.equal(payload.status, 'applied');
  const result = obj(payload.result);
  assert.equal(result.total, 3);
  assert.equal(result.ok, 2);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.outcomes, [
    { id: 'c1', ok: true },
    { id: 'c2', ok: false, error: '(#200) Permissions error' },
    // CC-MOD-1: a comment deleted a second ago is a success-with-note.
    { id: 'c3', ok: true, note: ALREADY_GONE_NOTE },
  ]);
  assert.ok(str(result.note).includes('only retry the failures'));

  const calls = jsonCalls(fb);
  assert.deepEqual(
    calls.map((r) => `${r.method} ${r.path}`),
    ['POST /c1', 'POST /c2', 'POST /c3', 'GET /c3'],
    'one write per id, sequentially, plus the read that confirms the gone one',
  );
  assert.deepEqual(bodyOf(callAt(fb, 0)), { is_hidden: true });
});

test('a bulk hide where every id fails does not claim the rest were applied', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on((r) => r.method === 'POST', fbErr(permissionError()));

  const payload = body(
    await tool('facebook_hide_comment').handler(
      { comment_ids: ['c1', 'c2'], hidden: true },
      ctx,
    ),
  );

  const result = obj(payload.result);
  assert.equal(result.total, 2);
  assert.equal(result.ok, 0);
  assert.equal(result.failed, 2);

  // A bulk verb returns its per-id outcomes rather than throwing (CC-MOD-5), so
  // nothing about the call itself tells the gate that not one id moved — the
  // action has to say so. All three places a reader could look must agree:
  assert.equal(payload.applied, false, 'the envelope may not claim a write landed');
  // `status` is the first thing a model reads, and it used to be hardcoded to
  // 'applied' regardless — so the same envelope answered the same question two
  // opposite ways, loudest lie first.
  assert.equal(
    payload.status,
    'not_applied',
    'the status line must agree with the applied flag beside it',
  );
  assert.equal(
    journal.entries[0]?.outcome,
    'failed',
    'the journal is the audit trail an operator reconciles against (CC-LIFE-2)',
  );
  // ...and the note carries the same statement in prose, with what to do next.
  // Telling the model "the rest were applied" when there is no rest reports a
  // change that never happened.
  const note = str(result.note);
  assert.ok(
    !note.includes('the rest were'),
    `an all-failed batch must not promise a remainder was applied; got: ${note}`,
  );
  assert.ok(note.includes('nothing was applied'), note);
});

test('a partially failed bulk hide stays applied — some ids really did land', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on((r) => r.method === 'POST' && r.path === '/c1', fbOk({ success: true }));
  fb.on((r) => r.method === 'POST' && r.path === '/c2', fbErr(permissionError()));

  const payload = body(
    await tool('facebook_hide_comment').handler(
      { comment_ids: ['c1', 'c2'], hidden: true },
      ctx,
    ),
  );

  const result = obj(payload.result);
  assert.equal(result.ok, 1);
  assert.equal(result.failed, 1);
  // Deliberately NOT downgraded to failed. c1 is hidden, and for the delete verb
  // the equivalent id would be gone for good; recording the batch as a failure
  // would tell an operator reconciling the journal that the world is untouched,
  // which is the more dangerous of the two possible lies. `outcomes` says which.
  assert.equal(payload.applied, true);
  assert.equal(journal.entries[0]?.outcome, 'applied');
  assert.equal(arr(result.outcomes).length, 2);
});

test('a bulk hide whose ids all came back ambiguous is not journaled as a failure', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on((r) => r.method === 'POST', fbErr(ambiguousWriteError()));

  const payload = body(
    await tool('facebook_hide_comment').handler(
      { comment_ids: ['c1', 'c2'], hidden: true },
      ctx,
    ),
  );

  const result = obj(payload.result);
  assert.equal(result.failed, 2);
  assert.equal(result.ambiguous, 2, 'the api layer flags an outcome it could not prove');

  // `failed === total` holds, but the condition that licenses the `failed`
  // verdict — provably nothing to reconcile — does not: every request reached
  // Facebook and only the answer was lost, so each hide may have landed. The
  // journal is what an operator reconciles a mutation against (CC-LIFE-2), and
  // `failed` there means "the world is untouched", the dangerous direction.
  assert.equal(
    journal.entries[0]?.outcome,
    'attempted',
    'an unproven outcome is neither a change nor a failure',
  );
  assert.equal(payload.status, 'not_applied');
  assert.match(
    str(payload.notPerformedNotice),
    /unconfirmed/i,
    'the envelope must carry the ATTEMPTED notice, not the refusal one',
  );
});

test('a bulk note never calls an unproven id "still to do"', async () => {
  const { fb, ctx } = makeHarness();
  fb.on((r) => r.method === 'POST' && r.path === '/c1', fbErr(permissionError()));
  fb.on((r) => r.method === 'POST' && r.path === '/c2', fbErr(ambiguousWriteError()));

  const payload = body(
    await tool('facebook_hide_comment').handler(
      { comment_ids: ['c1', 'c2'], hidden: true },
      ctx,
    ),
  );

  // c1 is safe to redo; c2 may already be hidden. One sentence covering both
  // sends the model to repeat a write it cannot see the outcome of — and the
  // identical sentence fronts `facebook_delete_comment`, where that repeat is
  // permanent.
  const note = str(obj(payload.result).note);
  assert.ok(
    !note.includes('every id is still to do'),
    `an unproven id may not be described as untouched work; got: ${note}`,
  );
  assert.match(note, /unproven|ambiguous/i, note);
});

test('facebook_hide_comment refuses an absent or undefined `hidden` before any request', async () => {
  const { fb, ctx } = makeHarness();
  fb.on((r) => r.method === 'POST', fbOk({ success: true }));

  // `hidden` carries the hide/unhide direction, so an absent one has no sane
  // default to fall back to. The schema makes it required and `defineTool`
  // strict-parses before the handler runs, so neither an omitted key nor an
  // explicit `undefined` can reach the api layer. (The api layer no longer
  // treats a missing field as "delete" either — the verb is named there now —
  // but this tool must still refuse the call rather than guess a direction.)
  await assert.rejects(
    () => tool('facebook_hide_comment').handler({ comment_ids: ['c1'] }, ctx),
    /hidden/i,
  );
  await assert.rejects(
    () =>
      tool('facebook_hide_comment').handler(
        { comment_ids: ['c1'], hidden: undefined },
        ctx,
      ),
    /hidden/i,
  );

  assert.equal(fb.calls.length, 0, 'no request escaped — least of all a DELETE');
});

test('facebook_hide_comment unhides through the same tool with hidden:false', async () => {
  const { fb, ctx } = makeHarness();
  fb.on((r) => r.method === 'POST', fbOk({ success: true }));

  const payload = body(
    await tool('facebook_hide_comment').handler(
      { comment_ids: ['c1'], hidden: false },
      ctx,
    ),
  );

  assert.equal(payload.applied, true);
  assert.deepEqual(bodyOf(firstCall(fb)), { is_hidden: false });
});

test('a bulk call above the 50-id cap is rejected before any request is made', async () => {
  const { fb, ctx } = makeHarness();
  const tooMany = Array.from({ length: MAX_BULK_IDS + 1 }, (_, i) => `c${String(i)}`);

  await assert.rejects(
    () =>
      tool('facebook_hide_comment').handler({ comment_ids: tooMany, hidden: true }, ctx),
    /<=50 items/,
  );
  await assert.rejects(
    () => tool('facebook_delete_comment').handler({ comment_ids: tooMany }, ctx),
    /<=50 items/,
  );
  await assert.rejects(
    () => tool('facebook_block_user').handler({ psids: tooMany }, ctx),
    /<=50 items/,
  );
  await assert.rejects(
    () => tool('facebook_hide_comment').handler({ comment_ids: [], hidden: true }, ctx),
    />=1 items/,
  );

  assert.equal(fb.calls.length, 0, 'schema rejection happens before the network');
});

test('exactly 50 ids are accepted — the cap is inclusive', async () => {
  const { fb, ctx } = makeHarness();
  fb.on((r) => r.method === 'POST', fbOk({ success: true }));
  const ids = Array.from({ length: MAX_BULK_IDS }, (_, i) => `c${String(i)}`);

  const payload = body(
    await tool('facebook_hide_comment').handler({ comment_ids: ids, hidden: true }, ctx),
  );

  assert.equal(obj(payload.result).total, MAX_BULK_IDS);
  assert.equal(jsonCalls(fb).length, MAX_BULK_IDS);
});

// ---------------------------------------------------------------------------
// 5b. facebook_like_comment — like / unlike as the Page (messaging F9)
// ---------------------------------------------------------------------------

/** The like verb's snapshot: the state read plus `user_likes`. */
function isLikeStateRead(req: FbRequest): boolean {
  return (
    isJson(req) &&
    req.method === 'GET' &&
    paramsOf(req).fields === 'id,message,is_hidden,user_likes'
  );
}

test('facebook_like_comment likes each id once and skips one already liked', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on(
    (r) => isLikeStateRead(r) && r.path === '/c1',
    fbOk({ id: 'c1', message: INJECTION, is_hidden: false, user_likes: false }),
  );
  fb.on(
    (r) => isLikeStateRead(r) && r.path === '/c2',
    fbOk({ id: 'c2', message: 'hi', is_hidden: false, user_likes: true }),
  );
  fb.on((r) => r.method === 'POST' && r.path === '/c1/likes', fbOk({ success: true }));

  const result = await tool('facebook_like_comment').handler(
    { comment_ids: ['c1', 'c2'] },
    ctx,
  );
  const payload = body(result);

  assert.equal(payload.status, 'applied');
  assert.deepEqual(obj(payload.result).outcomes, [
    { id: 'c1', ok: true },
    { id: 'c2', ok: true, note: ALREADY_IN_LIKE_STATE_NOTE },
  ]);
  assert.deepEqual(
    jsonCalls(fb).map((r) => `${r.method} ${r.path}`),
    ['GET /c1', 'GET /c2', 'POST /c1/likes'],
    'the already-liked comment gets no write',
  );
  assert.ok(!text(result).includes(INJECTION), 'no comment text in the result');
  const entry = journal.entries.find((e) => e.tool === 'facebook_like_comment');
  assert.ok(entry);
  assert.ok(!JSON.stringify(entry).includes(INJECTION), 'no comment text in the journal');
});

test('facebook_like_comment with unlike:true sends DELETE and treats a gone comment as done', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(
    (r) => isLikeStateRead(r) && r.path === '/c1',
    fbOk({ id: 'c1', message: 'hi', is_hidden: false, user_likes: true }),
  );
  fb.on((r) => isLikeStateRead(r) && r.path === '/c2', fbErr(goneError()));
  fb.on((r) => r.method === 'DELETE' && r.path === '/c1/likes', fbOk({ success: true }));

  const payload = body(
    await tool('facebook_like_comment').handler(
      { comment_ids: ['c1', 'c2'], unlike: true },
      ctx,
    ),
  );

  assert.deepEqual(obj(payload.result).outcomes, [
    { id: 'c1', ok: true },
    { id: 'c2', ok: true, note: ALREADY_GONE_NOTE },
  ]);
  assert.ok(!anyCall(fb, 'POST'), 'an unlike never POSTs');
});

test('facebook_like_comment fails a like on a gone comment and an unconfirmed write', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on((r) => isLikeStateRead(r) && r.path === '/c1', fbErr(goneError()));
  fb.on(
    (r) => isLikeStateRead(r) && r.path === '/c2',
    fbOk({ id: 'c2', message: 'hi', is_hidden: false, user_likes: false }),
  );
  fb.on((r) => r.method === 'POST' && r.path === '/c2/likes', fbOk({ success: false }));

  const payload = body(
    await tool('facebook_like_comment').handler({ comment_ids: ['c1', 'c2'] }, ctx),
  );

  assert.equal(payload.applied, false);
  assert.deepEqual(obj(payload.result).outcomes, [
    { id: 'c1', ok: false, error: LIKE_TARGET_GONE_ERROR },
    { id: 'c2', ok: false, error: 'Facebook reported success:false' },
  ]);
  assert.equal(journal.entries.at(-1)?.outcome, 'failed');
});

test('a facebook_like_comment plan diverges when the like state changed before apply', async () => {
  const { fb, ctx } = makeHarness({ writeMode: 'plan' });
  fb.on(
    isLikeStateRead,
    fbOk({ id: 'c1', message: 'hi', is_hidden: false, user_likes: false }),
    1,
  );
  fb.on(
    isLikeStateRead,
    fbOk({ id: 'c1', message: 'hi', is_hidden: false, user_likes: true }),
  );
  const like = tool('facebook_like_comment');

  const preview = body(await like.handler({ comment_ids: ['c1'] }, ctx));
  assert.equal(preview.status, 'preview');
  const applied = body(
    await like.handler(
      { comment_ids: ['c1'], apply: true, plan_id: str(preview.planId) },
      ctx,
    ),
  );

  assert.equal(applied.status, 'diverged');
  assert.ok(!anyCall(fb, 'POST'), 'a diverged plan sends no like');
});

test('the package apply default previews a comment on a post or an edit, never posts it', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on((r) => r.method === 'GET' && r.path === `/${POST_ID}`, fbOk(postNode()));
  fb.on(isEditRead, fbOk(ownComment()));
  fb.on((r) => r.method === 'POST', fbOk({ success: true, id: 'x' }));

  for (const [name, args] of [
    ['facebook_comment_on_post', { post_id: POST_ID, message: 'Hi' }],
    [
      'facebook_comment_on_post',
      { post_id: POST_ID, attachment_url: 'https://attacker.example/?d=leak' },
    ],
    ['facebook_edit_comment', { comment_id: 'c1', message: 'new text' }],
  ] as const) {
    for (const extra of [{}, { apply: true }]) {
      const payload = body(await tool(name).handler({ ...args, ...extra }, ctx));
      assert.equal(payload.status, 'preview', `${name} ${JSON.stringify(extra)}`);
    }
  }
  assert.ok(!anyCall(fb, 'POST'), 'no free text reaches the Page without a bound plan');
  assert.equal(journal.entries.length, 0);
});

test('the package apply default still hides, unhides and likes in one call', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(isStateRead, fbOk({ id: 'c1', message: 'hi', is_hidden: false }));
  fb.on(
    isLikeStateRead,
    fbOk({ id: 'c1', message: 'hi', is_hidden: false, user_likes: false }),
  );
  fb.on((r) => r.method === 'POST', fbOk({ success: true }));

  for (const [name, args] of [
    ['facebook_hide_comment', { comment_ids: ['c1'], hidden: true }],
    ['facebook_hide_comment', { comment_ids: ['c1'], hidden: false }],
    ['facebook_like_comment', { comment_ids: ['c1'] }],
  ] as const) {
    const payload = body(await tool(name).handler(args, ctx));
    assert.equal(payload.status, 'applied', `${name} ${JSON.stringify(args)}`);
  }
});

test('the apply default never deletes: irreversible needs apply:true AND a plan_id', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on(isStateRead, fbOk({ id: 'c1', message: 'nice post', is_hidden: false }));
  fb.on((r) => r.method === 'DELETE' && r.path === '/c1', fbOk({ success: true }));
  const del = tool('facebook_delete_comment');

  // 1. No apply at all, under writeModeDefault:'apply' — still only a preview.
  const bare = body(await del.handler({ comment_ids: ['c1'] }, ctx));
  assert.equal(bare.status, 'preview');
  assert.equal(bare.tier, 'irreversible');
  assert.ok(arr(bare.warnings).some((w) => str(w).includes('PERMANENT')));

  // 2. apply:true but no plan_id — still a preview, and it says what is missing.
  const unbound = body(await del.handler({ comment_ids: ['c1'], apply: true }, ctx));
  assert.equal(unbound.status, 'preview');
  assert.equal(unbound.applied, false);
  assert.ok(
    arr(unbound.warnings).some((w) => str(w).includes('plan_id')),
    'the preview must tell the agent what it still owes',
  );
  assert.ok(!anyCall(fb, 'DELETE'), 'nothing may be deleted without a bound plan');
  assert.equal(journal.entries.length, 0);

  // 3. apply:true bound to the plan_id from step 2 — now it performs.
  const applied = body(
    await del.handler(
      { comment_ids: ['c1'], apply: true, plan_id: str(unbound.planId) },
      ctx,
    ),
  );
  assert.equal(applied.status, 'applied');
  assert.equal(applied.applied, true);
  assert.deepEqual(obj(applied.result).outcomes, [{ id: 'c1', ok: true }]);
  assert.ok(anyCall(fb, 'DELETE', '/c1'));
  assert.equal(journal.entries[0]?.outcome, 'applied');
});

test('a preview counts each distinct comment once, as the apply acts on it once', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(isStateRead, fbOk({ id: 'c1', message: 'nice post', is_hidden: false }));

  const preview = await tool('facebook_delete_comment').handler(
    { comment_ids: ['c1', 'c2', 'c1'] },
    ctx,
  );

  assert.match(text(preview), /PERMANENTLY delete 2 comment\(s\)/);
  assert.ok(!anyCall(fb, 'DELETE'));
});

test('a plan_id cannot be replayed against a different set of comment ids', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(isStateRead, fbOk({ id: 'c1', message: 'nice post', is_hidden: false }));
  fb.on((r) => r.method === 'DELETE', fbOk({ success: true }));
  const del = tool('facebook_delete_comment');

  const preview = body(await del.handler({ comment_ids: ['c1'] }, ctx));

  await assert.rejects(
    () =>
      del.handler(
        { comment_ids: ['c1', 'c2'], apply: true, plan_id: str(preview.planId) },
        ctx,
      ),
    /differ from the planned params/,
  );
  assert.ok(!anyCall(fb, 'DELETE'));
});

test('a comment edited between preview and apply diverges without leaking its text', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(
    isStateRead,
    fbOk({ id: 'c1', message: 'the original body', is_hidden: false }),
    1,
  );
  fb.on(
    isStateRead,
    fbOk({ id: 'c1', message: 'edited after the preview', is_hidden: false }),
  );
  fb.on((r) => r.method === 'DELETE', fbOk({ success: true }));
  const del = tool('facebook_delete_comment');

  const preview = body(await del.handler({ comment_ids: ['c1'] }, ctx));
  const result = await del.handler(
    { comment_ids: ['c1'], apply: true, plan_id: str(preview.planId) },
    ctx,
  );
  const payload = body(result);

  // CC-MOD-6: the world moved, so nothing is written and the agent must re-plan.
  assert.equal(payload.status, 'diverged');
  assert.equal(payload.applied, false);
  assert.ok(str(payload.notPerformedNotice).includes('nothing was written'));
  assert.ok(!anyCall(fb, 'DELETE'));

  const diff = obj(arr(payload.diverged)[0]);
  assert.equal(diff.field, 'c1');
  // CC-MOD-8: a divergence diff is shown to the model, so it carries a
  // fingerprint of the body — never the untainted body itself.
  assert.ok(text(result).includes('fingerprint'));
  assert.ok(!text(result).includes('the original body'));
  assert.ok(!text(result).includes('edited after the preview'));
});

test('one unreadable comment does not fail a bulk preview, and apply never acts on it', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on(
    (r) => isStateRead(r) && r.path === '/c1',
    fbOk({ id: 'c1', message: 'nice post', is_hidden: false }),
  );
  fb.on((r) => isStateRead(r) && r.path === '/c2', fbErr(permissionError()));
  fb.on((r) => r.method === 'DELETE', fbOk({ success: true }));
  const del = tool('facebook_delete_comment');

  const preview = body(await del.handler({ comment_ids: ['c1', 'c2'] }, ctx));
  assert.equal(preview.status, 'preview');
  // The preview names the id it could not read and says it will not be touched.
  const unread = arr(preview.warnings)
    .map(str)
    .filter((w) => w.includes('could not be read'));
  assert.equal(unread.length, 1);
  assert.match(unread[0] ?? '', /\bc2 \(\(#200\) Permissions error\)/);
  assert.ok(!(unread[0] ?? '').includes('c1'));

  const applied = body(
    await del.handler(
      { comment_ids: ['c1', 'c2'], apply: true, plan_id: str(preview.planId) },
      ctx,
    ),
  );
  assert.equal(applied.status, 'applied');
  assert.ok(anyCall(fb, 'DELETE', '/c1'));
  assert.ok(!anyCall(fb, 'DELETE', '/c2'), 'an id never read must never be deleted');
  const outcomes = arr(obj(applied.result).outcomes).map(obj);
  assert.deepEqual(outcomes[0], { id: 'c1', ok: true });
  assert.equal(outcomes[1]?.id, 'c2');
  assert.equal(outcomes[1]?.ok, false);
  assert.match(str(outcomes[1]?.error), /not acted on/i);
  assert.equal(obj(applied.result).failed, 1);
  assert.equal(journal.entries[0]?.outcome, 'applied');
});

test('an id unreadable at preview but readable at apply diverges instead of being acted on', async () => {
  const { fb, ctx } = makeHarness({ writeMode: 'plan' });
  fb.on(
    (r) => isStateRead(r) && r.path === '/c1',
    fbOk({ id: 'c1', message: 'nice post', is_hidden: false }),
  );
  fb.on((r) => isStateRead(r) && r.path === '/c2', fbErr(permissionError()), 1);
  fb.on(
    (r) => isStateRead(r) && r.path === '/c2',
    fbOk({ id: 'c2', message: 'never previewed', is_hidden: false }),
  );
  fb.on((r) => r.method === 'POST', fbOk({ success: true }));
  const hide = tool('facebook_hide_comment');

  const preview = body(
    await hide.handler({ comment_ids: ['c1', 'c2'], hidden: true }, ctx),
  );
  assert.equal(preview.status, 'preview');

  const applied = body(
    await hide.handler(
      {
        comment_ids: ['c1', 'c2'],
        hidden: true,
        apply: true,
        plan_id: str(preview.planId),
      },
      ctx,
    ),
  );
  // The previewed state of c2 was never seen, so the plan did not approve it.
  assert.equal(applied.status, 'diverged');
  assert.equal(obj(arr(applied.diverged)[0]).field, 'c2');
  assert.ok(!anyCall(fb, 'POST'));
});
