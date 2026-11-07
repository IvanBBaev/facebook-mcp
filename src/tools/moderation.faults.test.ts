// Tests for the `moderation` tool package: path containment, cancellation, connect-phase
// faults, token eviction and rate limits in sweeps.
//
// Split out of `moderation.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/moderation.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fbErr, fbOk, type FakeFbRequest } from '../core/fakes/index.js';
import { GraphApiError, classifyNetworkError, isProvablyNotSent } from '../core/index.js';
import type { FbRequest, JsonRequest } from '../core/index.js';
import { NOT_BLOCKED_NOTE } from '../api/comments.js';
import type { WriteToolContext } from './shared.js';
import {
  OBJECT_ID,
  PAGE,
  PRIVATE_REPLY_ARGS,
  applyViaPlan,
  arr,
  body,
  goneError,
  isJson,
  isStateRead,
  jsonCalls,
  makeHarness,
  obj,
  paramsOf,
  rawComment,
  str,
  tokenDeadError,
  tool,
} from '../testing/harness/moderation.js';

// ---------------------------------------------------------------------------
// Path containment — an id must never be able to address another Graph node
// ---------------------------------------------------------------------------

test('every moderation id that reaches a path refuses a value addressing another node', async () => {
  // Each of these ids is interpolated into a Graph edge (`/{comment_id}`,
  // `/{object_id}/comments`, …) and `containPathname` only ever sees the joined
  // path, so it cannot tell an id from a structural segment: a `/` inside the id
  // is a new segment and retargets the call under the same token and method.
  // The fake answers ANY path, so an escape that got through would be recorded.
  const cases: readonly (readonly [string, (id: string) => Record<string, unknown>])[] = [
    ['facebook_list_comments', (id) => ({ object_id: id })],
    ['facebook_get_comment', (id) => ({ comment_id: id })],
    ['facebook_reply_to_comment', (id) => ({ comment_id: id, message: 'thanks!' })],
    ['facebook_private_reply', (id) => ({ comment_id: id, message: 'thanks!' })],
    ['facebook_hide_comment', (id) => ({ comment_ids: [id], hidden: true })],
    ['facebook_delete_comment', (id) => ({ comment_ids: [id] })],
  ];

  for (const [name, args] of cases) {
    const { fb, ctx } = makeHarness();
    fb.on(() => true, fbOk({ id: 'c1', data: [], success: true }));

    for (const escaped of [
      `${PAGE.pageId}/conversations`,
      'me/accounts',
      'c1?fields=from',
      '..',
      '.',
    ]) {
      await assert.rejects(
        () => tool(name).handler(args(escaped), ctx),
        /bare Graph ID/,
        `${name} must refuse the id ${JSON.stringify(escaped)}`,
      );
    }
    assert.equal(fb.calls.length, 0, `${name} let an escaped id reach Graph`);
  }
});

test('the moderation id shapes still accept every id Graph actually mints', () => {
  // Regression coverage: containment must not narrow Graph's ID space.
  for (const id of [OBJECT_ID, 'c1', '123456_789012', '1234567890', 'act_123']) {
    for (const [name, args] of [
      ['facebook_list_comments', { object_id: id }],
      ['facebook_get_comment', { comment_id: id }],
      ['facebook_reply_to_comment', { comment_id: id, message: 'thanks!' }],
      ['facebook_private_reply', { comment_id: id, message: 'thanks!' }],
      ['facebook_hide_comment', { comment_ids: [id], hidden: true }],
      ['facebook_delete_comment', { comment_ids: [id] }],
    ] as readonly (readonly [string, Record<string, unknown>])[]) {
      assert.equal(
        tool(name).inputSchema.safeParse(args).success,
        true,
        `${name} must accept the id ${JSON.stringify(id)}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Wave 16 — cancellation mid-sweep, and the permissions the descriptions name
// ---------------------------------------------------------------------------

/**
 * Stand in for a caller cancelling a sweep while one write is on the wire.
 * `core/http.ts` rethrows a caller abort RAW (no GraphApiError, no category),
 * both for the request that was in flight and for every later one, which fetch
 * rejects at once because the signal is already aborted. `inFlight` picks the
 * write that was mid-flight when the cancel arrived: it may have landed.
 */
function cancelMidFlight(
  ctx: WriteToolContext,
  fb: FakeFbRequest,
  inFlight: (req: JsonRequest) => boolean,
): { readonly ctx: WriteToolContext; readonly sent: JsonRequest[] } {
  const controller = new AbortController();
  const sent: JsonRequest[] = [];
  const abortError = () => new DOMException('This operation was aborted', 'AbortError');
  const fbRequest = (async (req: FbRequest) => {
    if (isJson(req) && req.method !== 'GET') {
      if (controller.signal.aborted) throw abortError();
      if (inFlight(req)) {
        sent.push(req);
        controller.abort();
        throw abortError();
      }
    }
    return fb.fn(req);
  }) as WriteToolContext['fbRequest'];
  return { ctx: { ...ctx, fbRequest, signal: controller.signal }, sent };
}

test('a delete sweep cancelled while a DELETE is on the wire is journaled attempted, not failed', async () => {
  const harness = makeHarness();
  harness.fb.on(isStateRead, fbOk({ id: 'c1', message: 'nice post', is_hidden: false }));
  const del = tool('facebook_delete_comment');
  const preview = body(await del.handler({ comment_ids: ['c1', 'c2'] }, harness.ctx));

  const { ctx, sent } = cancelMidFlight(
    harness.ctx,
    harness.fb,
    (r) => r.method === 'DELETE' && r.path === '/c1',
  );
  const payload = body(
    await del.handler(
      { comment_ids: ['c1', 'c2'], apply: true, plan_id: str(preview.planId) },
      ctx,
    ),
  );

  assert.equal(sent.length, 1, 'the DELETE for c1 reached the wire');
  const result = obj(payload.result);
  const outcomes = arr(result.outcomes).map(obj);
  // c1 was sent and its answer was cut off: it may be gone for good.
  assert.equal(outcomes[0]?.ambiguous, true, 'the in-flight delete is unproven');
  // c2 was never sent — the signal was already aborted — so it stays provable.
  assert.equal(outcomes[1]?.ambiguous, undefined, 'a never-sent id is not unproven');
  assert.equal(
    harness.journal.entries.at(-1)?.outcome,
    'attempted',
    'a permanent delete that may have landed must not be journaled as failed',
  );
  assert.ok(
    !str(result.note).includes('nothing was applied'),
    `the note may not say nothing was applied; got: ${str(result.note)}`,
  );
});

test('an unblock sweep cancelled while a DELETE is on the wire is journaled attempted', async () => {
  const harness = makeHarness();
  harness.fb.on((r) => r.method === 'DELETE', fbOk({ success: true }));
  const { ctx, sent } = cancelMidFlight(
    harness.ctx,
    harness.fb,
    (r) => r.method === 'DELETE' && paramsOf(r).psid === 'psid-1',
  );

  const payload = body(
    await tool('facebook_unblock_user').handler({ psids: ['psid-1', 'psid-2'] }, ctx),
  );

  assert.equal(sent.length, 1);
  const outcomes = arr(obj(payload.result).outcomes).map(obj);
  assert.equal(outcomes[0]?.ambiguous, true);
  assert.equal(outcomes[1]?.ambiguous, undefined);
  assert.equal(harness.journal.entries[0]?.outcome, 'attempted');
});

test('facebook_private_reply names the read permission its pre-flight comment read needs', () => {
  // Meta: sending a private reply needs pages_messaging and the MESSAGING task.
  // The tool ALSO reads the comment first (the 7-day window and author check),
  // and that GET needs pages_read_engagement — without it the call fails before
  // any send, which the description must not leave the model to discover.
  const description = tool('facebook_private_reply').description;
  assert.match(description, /pages_messaging/);
  assert.match(description, /MESSAGING task/);
  assert.match(description, /pages_read_engagement/);
});

test('facebook_get_comment names the permissions it needs, as its siblings do', () => {
  const description = tool('facebook_get_comment').description;
  assert.match(description, /pages_read_engagement/);
  assert.match(description, /pages_read_user_content/);
});

// ---------------------------------------------------------------------------
// Wave 17 — a connect-phase fault provably never sent the write
// ---------------------------------------------------------------------------

/**
 * The exact error `core/http.ts` `networkError` throws once a write's
 * connect-phase retries are exhausted: status 0, a transient (not ambiguous)
 * action, and the raw fetch rejection as `cause`. `code` picks the undici/Node
 * error code on that cause: ECONNREFUSED proves no byte left the machine,
 * ECONNRESET (a mid-flight reset) proves nothing.
 */
function transportFaultError(code: string): GraphApiError {
  const cause = new TypeError('fetch failed', {
    cause: Object.assign(new Error(`connect ${code} 157.240.0.35:443`), { code }),
  });
  return new GraphApiError('network request failed: fetch failed', {
    code: 0,
    httpStatus: 0,
    action: classifyNetworkError({
      phase: isProvablyNotSent(cause) ? 'connect' : 'response',
      isWrite: true,
      reason: 'fetch failed',
    }),
    cause,
  });
}

test('a reply refused at connect time is journaled failed, not attempted', async () => {
  const { fb, ctx, journal } = makeHarness();
  // ECONNREFUSED: the POST never left the machine, so no reply can be public.
  // `attempted` would send an operator reconciling the journal hunting for a
  // reply that provably does not exist.
  fb.on(
    (r) => r.method === 'POST' && r.path === '/c1/comments',
    fbErr(transportFaultError('ECONNREFUSED')),
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

test('a private reply refused at connect time is journaled failed, not attempted', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on((r) => r.method === 'GET', fbOk(rawComment()));
  fb.on((r) => r.method === 'POST', fbErr(transportFaultError('ENOTFOUND')));
  const pr = tool('facebook_private_reply');

  const preview = body(await pr.handler(PRIVATE_REPLY_ARGS, ctx));
  await assert.rejects(() =>
    pr.handler({ ...PRIVATE_REPLY_ARGS, apply: true, plan_id: str(preview.planId) }, ctx),
  );

  // DNS failed: the one-shot send never reached Facebook and is not spent.
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0]?.outcome, 'failed');
});

test('a block refused at connect time is journaled failed, not attempted', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on(
    (r) => r.method === 'POST' && r.path === `/${PAGE.pageId}/blocked`,
    fbErr(transportFaultError('ECONNREFUSED')),
  );

  await assert.rejects(() =>
    tool('facebook_block_user').handler({ psids: ['psid-1', 'psid-2'] }, ctx),
  );

  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0]?.outcome, 'failed');
});

test('a private reply cut off by a mid-flight reset stays journaled attempted', async () => {
  // The other side of the connect-phase rule: a reset carries no proof the
  // send stayed local, so the one-shot may be spent and the entry must say so.
  const { fb, ctx, journal } = makeHarness();
  fb.on((r) => r.method === 'GET', fbOk(rawComment()));
  fb.on((r) => r.method === 'POST', fbErr(transportFaultError('ECONNRESET')));
  const pr = tool('facebook_private_reply');

  const preview = body(await pr.handler(PRIVATE_REPLY_ARGS, ctx));
  await assert.rejects(() =>
    pr.handler({ ...PRIVATE_REPLY_ARGS, apply: true, plan_id: str(preview.planId) }, ctx),
  );

  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0]?.outcome, 'attempted');
});

test('a hide sweep that hits a dead Page token evicts the cached token', async () => {
  const { fb, ctx, pages } = makeHarness();
  fb.on((r) => r.method === 'POST' && r.path === '/c1', fbOk({ success: true }));
  fb.on((r) => r.method === 'POST' && r.path === '/c2', fbErr(tokenDeadError()));
  fb.on((r) => r.method === 'POST' && r.path === '/c3', fbOk({ success: true }));

  await tool('facebook_hide_comment').handler(
    { comment_ids: ['c1', 'c2', 'c3'], hidden: true },
    ctx,
  );

  // A per-id failure is folded into an outcome row, so the server's
  // invalidate-on-190 hook never sees it; the sweep has to evict itself or every
  // later call keeps replaying the dead token until the cache TTL.
  assert.deepEqual(pages.invalidated, [PAGE.pageId]);
});

test('a hide sweep stops at a dead Page token and reports the rest as not attempted', async () => {
  const { fb, ctx, journal } = makeHarness();
  fb.on((r) => r.method === 'POST' && r.path === '/c1', fbOk({ success: true }));
  fb.on((r) => r.method === 'POST' && r.path === '/c2', fbErr(tokenDeadError()));
  fb.on((r) => r.method === 'POST' && r.path === '/c3', fbOk({ success: true }));

  const payload = body(
    await tool('facebook_hide_comment').handler(
      { comment_ids: ['c1', 'c2', 'c3'], hidden: true },
      ctx,
    ),
  );

  assert.deepEqual(
    jsonCalls(fb).map((r) => `${r.method} ${r.path}`),
    ['POST /c1', 'POST /c2'],
    'no further write may ride a token Graph just called dead',
  );
  const result = obj(payload.result);
  assert.equal(result.ok, 1);
  assert.equal(result.failed, 2);
  const outcomes = arr(result.outcomes).map(obj);
  const c3 = outcomes[2];
  assert.equal(c3?.id, 'c3');
  assert.equal(c3.ok, false);
  assert.equal(c3.ambiguous, undefined, 'a never-sent id is provable, not unproven');
  assert.match(str(c3.error), /not attempted/i);
  // c1 really was hidden, so the batch stays applied (partial success).
  assert.equal(journal.entries[0]?.outcome, 'applied');
});

test('an unblock sweep that hits a 102 session error evicts the cached token', async () => {
  const { fb, ctx, pages } = makeHarness();
  fb.on(
    (r) => r.method === 'DELETE' && r.path === `/${PAGE.pageId}/blocked`,
    fbErr(tokenDeadError(102)),
  );

  const payload = body(
    await tool('facebook_unblock_user').handler({ psids: ['psid-1', 'psid-2'] }, ctx),
  );

  assert.deepEqual(pages.invalidated, [PAGE.pageId]);
  assert.equal(fb.calls.length, 1, 'the second PSID is not sent on a dead token');
  assert.match(str(obj(arr(obj(payload.result).outcomes)[1]).error), /not attempted/i);
});

test('an unblock of a never-blocked PSID answered 100/33 neither evicts the token nor stops the sweep', async () => {
  const { fb, ctx, pages } = makeHarness();
  // Graph answers the DELETE for a PSID that is not on the list with its stock
  // 100/33 text. On the /{page}/blocked edge that subcode names the PSID, not
  // the Page: the confirming read of the blocked list proves the Page is fine.
  fb.on(
    (r) => r.method === 'DELETE' && isJson(r) && paramsOf(r).psid === 'psid-1',
    fbErr(
      new GraphApiError(
        "Unsupported delete request. Object with ID 'psid-1' does not exist, cannot be " +
          'loaded due to missing permissions, or does not support this operation.',
        { code: 100, subcode: 33, httpStatus: 400 },
      ),
    ),
  );
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${PAGE.pageId}/blocked`,
    fbOk({ data: [] }),
  );
  fb.on((r) => r.method === 'DELETE', fbOk({ success: true }));

  const payload = body(
    await tool('facebook_unblock_user').handler({ psids: ['psid-1', 'psid-2'] }, ctx),
  );

  assert.deepEqual(pages.invalidated, [], 'a live Page token must not be evicted');
  assert.deepEqual(arr(obj(payload.result).outcomes), [
    { id: 'psid-1', ok: true, note: NOT_BLOCKED_NOTE },
    { id: 'psid-2', ok: true },
  ]);
});

test('a delete sweep whose confirming read hits a dead token evicts it', async () => {
  const harness = makeHarness();
  harness.fb.on(isStateRead, fbOk({ id: 'c1', message: 'nice post', is_hidden: false }));
  const del = tool('facebook_delete_comment');
  const preview = body(await del.handler({ comment_ids: ['c1'] }, harness.ctx));
  // The DELETE answers "does not exist"; the read that must confirm it is where
  // Graph reveals the token is dead — and that answer is swallowed by the probe.
  harness.fb.on(
    (r) => r.method === 'DELETE' && r.path === '/c1',
    fbErr(goneError('Object with ID c1 does not exist')),
  );
  harness.fb.on(
    (r) => r.method === 'GET' && r.path === '/c1' && !isStateRead(r),
    fbErr(tokenDeadError()),
  );

  await del.handler(
    { comment_ids: ['c1'], apply: true, plan_id: str(preview.planId) },
    harness.ctx,
  );

  assert.deepEqual(harness.pages.invalidated, [PAGE.pageId]);
});

test('a comment that is merely gone does not evict the Page token', async () => {
  const { fb, ctx, pages } = makeHarness();
  // 100/33 on a COMMENT path is about the comment, not the Page, even though the
  // same subcode on the Page object marks the Page token stale.
  fb.on((r) => r.method === 'POST' && r.path === '/c1', fbErr(goneError()));
  fb.on((r) => r.method === 'GET' && r.path === '/c1', fbErr(goneError()));
  fb.on((r) => r.method === 'POST' && r.path === '/c2', fbOk({ success: true }));

  const payload = body(
    await tool('facebook_hide_comment').handler(
      { comment_ids: ['c1', 'c2'], hidden: true },
      ctx,
    ),
  );

  assert.deepEqual(pages.invalidated, []);
  assert.equal(obj(payload.result).ok, 2, 'the sweep carries on past a gone comment');
});

test('a block cut off mid-flight does not send the model to facebook_get_comment', async () => {
  const harness = makeHarness();
  harness.fb.on((r) => r.method === 'POST', fbOk({ 'psid-1': true }));
  const { ctx, sent } = cancelMidFlight(
    harness.ctx,
    harness.fb,
    (r) => r.method === 'POST' && r.path === `/${PAGE.pageId}/blocked`,
  );

  let thrown: unknown;
  await assert.rejects(async () => {
    try {
      await tool('facebook_block_user').handler({ psids: ['psid-1'] }, ctx);
    } catch (err) {
      thrown = err;
      throw err;
    }
  });

  assert.equal(sent.length, 1, 'the block POST reached the wire');
  assert.ok(thrown instanceof GraphApiError, 'an interrupted write is the C2 error');
  assert.equal(thrown.action?.category, 'ambiguous');
  // No comment read can show a PSID's blocked state, so naming one sends the
  // model to verify a block in a place that can never show it.
  assert.equal(thrown.action.nextTool, undefined);
  assert.ok(
    !thrown.action.operatorText.includes('facebook_get_comment'),
    thrown.action.operatorText,
  );
});

// ---------------------------------------------------------------------------
// Rate limit inside a bulk sweep, and the summary's non-Page 100/33
// ---------------------------------------------------------------------------

/** A throttle whose retries core/http.ts has already exhausted (code 32). */
function rateLimitError(): GraphApiError {
  return new GraphApiError('(#32) Page request limit reached', {
    code: 32,
    httpStatus: 400,
    action: {
      category: 'rate_limit',
      retryable: false,
      retryAfterMs: 300_000,
      operatorText: 'the Page is rate limited',
    },
  });
}

test('a hide sweep stops at a rate limit and reports the rest as not attempted', async () => {
  const { fb, ctx, pages, journal } = makeHarness();
  fb.on((r) => r.method === 'POST' && r.path === '/c1', fbOk({ success: true }));
  fb.on((r) => r.method === 'POST' && r.path === '/c2', fbErr(rateLimitError()));
  fb.on((r) => r.method === 'POST' && r.path === '/c3', fbOk({ success: true }));

  const payload = body(
    await tool('facebook_hide_comment').handler(
      { comment_ids: ['c1', 'c2', 'c3'], hidden: true },
      ctx,
    ),
  );

  // Every later write rides the same throttled bucket: sending it only spends
  // more of a budget Facebook already said is gone, each one after the http
  // layer's own retries and back-offs.
  assert.deepEqual(
    jsonCalls(fb).map((r) => `${r.method} ${r.path}`),
    ['POST /c1', 'POST /c2'],
    'no further write may be sent into a rate limit Facebook just reported',
  );
  const result = obj(payload.result);
  assert.equal(result.ok, 1);
  assert.equal(result.failed, 2);
  const c3 = arr(result.outcomes).map(obj)[2];
  assert.equal(c3?.id, 'c3');
  assert.equal(c3.ok, false);
  assert.equal(c3.ambiguous, undefined, 'a never-sent id is provable, not unproven');
  assert.match(str(c3.error), /not attempted/i);
  assert.match(str(c3.error), /rate limit/i);
  assert.deepEqual(pages.invalidated, [], 'a rate limit says nothing about the token');
  assert.equal(journal.entries[0]?.outcome, 'applied');
});

test('facebook_list_comments keeps the comments when the summary read answers 100/33 for the object', async () => {
  const { fb, ctx } = makeHarness();
  // 100/33 on a post's comments edge is about that object, not the Page token
  // (the same rule the bulk fence applies): the comments already read stay.
  fb.on(
    (r) => r.method === 'GET' && paramsOf(r).summary === 'true',
    fbErr(goneError('Unsupported get request. Object with ID 900_17841 does not exist')),
  );
  fb.on((r) => r.method === 'GET', fbOk({ data: [rawComment()] }));

  const payload = body(
    await tool('facebook_list_comments').handler(
      { object_id: OBJECT_ID, include_summary: true },
      ctx,
    ),
  );

  assert.equal(payload.count, 1, 'the comments already read are returned');
  assert.equal(payload.summary, undefined, 'no count is invented');
  assert.match(str(payload.note), /summary could not be read/);
});
