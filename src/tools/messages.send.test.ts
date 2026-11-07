// Tests for facebook_send_message: plan/apply, the 24-hour window, journal
// outcomes of ambiguous and refused sends, recipient binding and cancellation.
//
// Shared fixtures, fakes and helpers live in `src/testing/harness/messages.ts`;
// the suite-level notes (load-bearing behaviours) are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fbErr, fbOk } from '../core/fakes/index.js';
import { GraphApiError, ambiguousWriteAction } from '../core/index.js';
import type { ToolResult } from '../core/index.js';
import { MESSAGE_TAG_GUIDANCE, STANDARD_MESSAGING_WINDOW_MS } from '../api/messaging.js';
import type { WriteToolContext } from './shared.js';
import {
  CONVERSATION_ID,
  HOUR_MS,
  NOW,
  PAGE_ID,
  PAGE_NAME,
  PAGE_TOKEN,
  PSID,
  TOOL_GET,
  TOOL_SEND,
  body,
  graphError,
  graphTime,
  inboundNode,
  jsonCalls,
  jsonOf,
  list,
  makeCtx,
  outboundNode,
  posts,
  record,
  sendApplied,
  stubSend,
  stubThread,
  tool,
} from '../testing/harness/messages.js';

/**
 * The apply half of {@link sendApplied} for a send expected to REJECT: the
 * preview is taken first (it makes no request), then the bound apply is handed
 * to `assert.rejects` as the promise under test.
 */
async function sendApply(
  args: Record<string, unknown>,
  ctx: WriteToolContext,
): Promise<ToolResult> {
  const preview = body(await tool(TOOL_SEND).handler(args, ctx));
  return tool(TOOL_SEND).handler({ ...args, apply: true, plan_id: preview.planId }, ctx);
}

// ---------------------------------------------------------------------------
// facebook_send_message — gating
// ---------------------------------------------------------------------------

test('facebook_send_message previews by default and sends nothing', async () => {
  const { fb, journal, ctx } = makeCtx();
  stubThread(fb, [inboundNode({ agoMs: 2 * HOUR_MS, message: 'Is this in stock?' })]);
  stubSend(fb, fbOk({ message_id: 'mid.1', recipient_id: PSID }));

  const payload = body(
    await tool(TOOL_SEND).handler(
      { conversation_id: CONVERSATION_ID, message: 'Yes, it is.' },
      ctx,
    ),
  );

  assert.equal(payload.status, 'preview');
  assert.equal(payload.applied, false);
  assert.equal(payload.tier, 'reversible');
  assert.equal(payload.tool, TOOL_SEND);
  assert.equal(payload.pageId, PAGE_ID);
  assert.equal(typeof payload.planId, 'string');
  assert.equal(posts(fb).length, 0, 'a dry run must not POST');
  assert.equal(journal.entries.length, 0, 'a dry run writes no journal entry');

  // The window probe is a Page-scoped read like any other and must carry the
  // Page token rather than falling back to the transport's default identity.
  const probe = jsonOf(jsonCalls(fb)[0]);
  assert.equal(probe.method, 'GET');
  assert.equal(probe.path, `/${CONVERSATION_ID}/messages`);
  assert.equal(probe.token, PAGE_TOKEN);

  const warnings = list(payload.warnings, 'warnings').map(String);
  assert.ok(
    warnings.some((w) => w.includes('PRIVATE Messenger message')),
    'the private-surface warning must be shown (CC-MSG-4)',
  );
  assert.ok(
    warnings.some((w) => w.includes('attempted')),
    'the unknown-outcome warning must be shown up front (CC-MSG-2)',
  );
  assert.ok(
    String(payload.notPerformedNotice).includes('NO message was sent'),
    'the preview must state plainly that nothing was sent',
  );
});

test('the plan-time unknown-outcome warning does not promise a journal entry', async () => {
  // The warning is shown BEFORE the send, when nobody knows whether the journal
  // append will succeed: it is best-effort and answers `'failed'` on a full disk
  // or an unwritable path (CC-LIFE-1). "The journal records attempted" is then a
  // promise about a record that may not exist; the classification is the fact.
  const { fb, ctx } = makeCtx();
  stubThread(fb, [inboundNode({ agoMs: 2 * HOUR_MS, message: 'Is this in stock?' })]);

  const payload = body(
    await tool(TOOL_SEND).handler(
      { conversation_id: CONVERSATION_ID, message: 'Yes, it is.' },
      ctx,
    ),
  );

  const warning = list(payload.warnings, 'warnings')
    .map(String)
    .find((w) => w.includes('idempotency key'));
  assert.ok(warning !== undefined, 'the unknown-outcome warning must be shown');
  assert.ok(
    warning.includes('"attempted"'),
    'the ambiguous send is classified attempted',
  );
  assert.doesNotMatch(
    warning,
    /journal records/,
    'a journal append can fail, so the warning must not promise the entry',
  );
  assert.match(warning, /append can itself fail/, 'the qualification is stated');
});

test('no write mode can send a bare apply:true — the send is plan-bound', async () => {
  // The package declares writeModeDefault:'plan', but an operator who typed
  // FB_WRITE_MODE=apply overrides a package default outright, so the default is
  // NOT what keeps an unattended DM off the wire — `requirePlanId` is.
  const { fb, journal, ctx } = makeCtx({ writeMode: 'apply' });
  stubSend(fb, fbOk({ message_id: 'mid.never' }));

  const payload = body(
    await tool(TOOL_SEND).handler(
      { recipient_id: PSID, message: 'Unattended.', apply: true },
      ctx,
    ),
  );

  assert.equal(payload.status, 'preview');
  // The downgrade reason rides along, so the model learns what it still owes
  // rather than re-sending the same bare apply.
  const warnings = payload.warnings as readonly string[];
  assert.ok(
    warnings.some((w) => w.includes('plan_id')),
    `expected a plan_id warning, got ${JSON.stringify(warnings)}`,
  );
  assert.equal(posts(fb).length, 0, 'nothing may reach the recipient');
  assert.equal(journal.entries.length, 0);
});

test('facebook_send_message applies against the plan it previewed', async () => {
  const { fb, journal, ctx } = makeCtx();
  stubThread(fb, [inboundNode({ agoMs: 2 * HOUR_MS, message: 'Is this in stock?' })]);
  stubSend(fb, fbOk({ message_id: 'mid.1', recipient_id: PSID }));
  const args = { conversation_id: CONVERSATION_ID, message: 'Yes, it is.' };

  const preview = body(await tool(TOOL_SEND).handler(args, ctx));
  const planId = preview.planId;
  assert.equal(typeof planId, 'string');

  const applied = body(
    await tool(TOOL_SEND).handler({ ...args, apply: true, plan_id: planId }, ctx),
  );

  assert.equal(applied.status, 'applied');
  assert.equal(applied.applied, true);
  const result = record(applied.result, 'result');
  assert.equal(result.delivery, 'sent');
  assert.equal(result.messageId, 'mid.1');
  assert.equal(result.recipientId, PSID);

  const sent = posts(fb);
  assert.equal(sent.length, 1, 'exactly one message may leave the process');
  const sendReq = jsonOf(sent[0]);
  assert.equal(sendReq.path, `/${PAGE_ID}/messages`);
  assert.deepEqual(sendReq.body, {
    recipient: { id: PSID },
    message: { text: 'Yes, it is.' },
    messaging_type: 'RESPONSE',
  });

  assert.equal(journal.entries.length, 1);
  const entry = journal.entries[0];
  assert.ok(entry);
  assert.equal(entry.outcome, 'applied');
  assert.equal(entry.tool, TOOL_SEND);
  assert.equal(entry.tier, 'reversible');
  assert.equal(entry.planId, planId);
  assert.equal(entry.timestamp, NOW);
  // Journal metadata is ids and sizes only — never the body or a person's name.
  assert.deepEqual(entry.metadata, {
    recipientId: PSID,
    conversationId: CONVERSATION_ID,
    chars: 'Yes, it is.'.length,
    windowStatus: 'open',
    replyTo: false,
  });
  assert.ok(!JSON.stringify(entry.metadata).includes('Yes, it is.'));
});

test('a send acknowledged without a message id is unconfirmed, not applied, and journalled attempted', async () => {
  const { fb, journal, ctx } = makeCtx();
  stubThread(fb, [inboundNode({ agoMs: 2 * HOUR_MS, message: 'Is this in stock?' })]);
  // Graph answered 200 but omitted `message_id`. `sendMessage` returns `{}`
  // here, so there is no acknowledgement to point at and delivery is UNKNOWN —
  // the mirror image of the case commitment 2 guards: it must not be reported
  // as "not sent", and it must not be overclaimed as confirmed either.
  stubSend(fb, fbOk({}));

  const applied = await sendApplied(
    { conversation_id: CONVERSATION_ID, message: 'Yes, it is.' },
    ctx,
  );

  // The envelope must agree with the result it carries: `status:"applied"`
  // beside `delivery:"unconfirmed"` hands the model two answers to the one
  // question the envelope exists to answer, and the wrong one reads first.
  assert.equal(applied.status, 'not_applied');
  assert.equal(applied.applied, false);
  assert.equal(applied.outcome, 'attempted');
  assert.match(String(applied.notPerformedNotice), /ATTEMPTED/);
  const result = record(applied.result, 'result');
  assert.equal(result.messageId, undefined, 'Graph returned no message id');
  assert.equal(result.delivery, 'unconfirmed');

  const note = String(result.note);
  assert.ok(
    !note.includes('delivery is confirmed'),
    `an unacknowledged send must not claim confirmed delivery; got: ${note}`,
  );
  assert.ok(
    !note.includes('message id'),
    `the note must not cite a message id that was never returned; got: ${note}`,
  );
  // The resend hazard is unchanged: the message may well have landed.
  assert.match(note, /do not send it again/i);
  assert.match(note, /facebook_get_conversation/);

  // The request reached the wire and nothing vouches for what it did, so the
  // journal holds an ATTEMPT for an operator to reconcile (C2 / CC-LIFE-2) —
  // not a change that was never confirmed.
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0]?.outcome, 'attempted');
});

test('a 200 whose body is a Graph error envelope is never reported as sent', async () => {
  // Regression coverage (CC-NET-2 / CC-MSG-2): the transport only rejects on a
  // non-2xx status, so a 200 carrying `{ error: {...} }` reaches the tool as
  // "data". There is no message id in it, and the tool must fall on the
  // unconfirmed side — a model told "sent" here would stop checking the inbox
  // for a message that may never have existed.
  const { fb, journal, ctx } = makeCtx();
  stubThread(fb, [inboundNode({ agoMs: 2 * HOUR_MS, message: 'Still open?' })]);
  stubSend(
    fb,
    fbOk({
      error: { message: 'Temporarily unable to send', code: 1, type: 'OAuthException' },
    }),
  );

  const applied = await sendApplied(
    { conversation_id: CONVERSATION_ID, message: 'Yes, until 18:00.' },
    ctx,
  );

  const result = record(applied.result, 'result');
  assert.equal(result.delivery, 'unconfirmed');
  assert.equal(result.messageId, undefined);
  assert.doesNotMatch(String(result.note), /delivery is confirmed/);
  // Same verdict as any other id-less acknowledgement: unconfirmed is not applied.
  assert.equal(applied.status, 'not_applied');
  assert.equal(applied.outcome, 'attempted');
  assert.equal(journal.entries[0]?.outcome, 'attempted');
});

test('facebook_send_message refuses locally when the 24-hour window has closed', async () => {
  const { fb, journal, ctx } = makeCtx();
  stubThread(fb, [
    inboundNode({
      agoMs: STANDARD_MESSAGING_WINDOW_MS + HOUR_MS,
      message: 'Old question',
    }),
  ]);
  stubSend(fb, fbOk({ message_id: 'mid.never' }));

  await assert.rejects(
    tool(TOOL_SEND).handler(
      {
        conversation_id: CONVERSATION_ID,
        message: 'Too late.',
        apply: true,
      },
      ctx,
    ),
    (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      // A locally generated refusal: no request ever left the process.
      assert.equal(err.code, -1);
      assert.equal(err.httpStatus, 0);
      assert.match(err.message, /Not sent/);
      assert.equal(err.action?.category, 'unsupported');
      assert.equal(err.action?.retryable, false);
      assert.ok(String(err.action?.operatorText).includes(MESSAGE_TAG_GUIDANCE));
      return true;
    },
  );

  assert.equal(posts(fb).length, 0, 'nothing may be sent outside the window');
  assert.equal(journal.entries.length, 0, 'no write was attempted, so nothing is logged');
});

test('the window is re-checked at apply time, not trusted from the preview', async () => {
  const { fb, clock, ctx } = makeCtx();
  stubThread(fb, [inboundNode({ agoMs: 23 * HOUR_MS, message: 'Nearly stale' })]);
  stubSend(fb, fbOk({ message_id: 'mid.late' }));
  const args = { conversation_id: CONVERSATION_ID, message: 'Here you go.' };

  const preview = body(await tool(TOOL_SEND).handler(args, ctx));
  assert.equal(preview.status, 'preview');

  // The window closes between the preview and the apply (CC-MSG-1 race).
  clock.advance(2 * HOUR_MS);

  await assert.rejects(
    tool(TOOL_SEND).handler({ ...args, apply: true, plan_id: preview.planId }, ctx),
    /24-hour standard messaging window is closed/,
  );
  assert.equal(posts(fb).length, 0);
});

test('facebook_send_message needs a target and never guesses one', async () => {
  const { fb, ctx } = makeCtx();

  await assert.rejects(
    tool(TOOL_SEND).handler({ message: 'Hello?' }, ctx),
    /conversation_id .*or .*recipient_id/s,
  );
  assert.equal(fb.calls.length, 0, 'no request may be made without a target');

  // An empty (or wholly unattributed) thread identifies nobody, so the send is
  // refused rather than aimed at a guess.
  const orphan = makeCtx();
  stubThread(orphan.fb, []);
  await assert.rejects(
    tool(TOOL_SEND).handler(
      { conversation_id: CONVERSATION_ID, message: 'Hello?', apply: true },
      orphan.ctx,
    ),
    // Only the newest messages are probed, so the refusal must not claim
    // the whole thread was searched.
    /no recipient could be identified from the newest 10 messages/,
  );
  assert.equal(posts(orphan.fb).length, 0);
});

test('a thread with only outbound messages still resolves the recipient from `to`', async () => {
  const { fb, journal, ctx } = makeCtx();
  // The Page messaged first and got no reply: nobody is inferable from `from`,
  // but the addressee is. The window stays `unknown` — an outbound-only thread
  // proves nothing about the 24-hour clock — so the send is allowed to proceed
  // and Graph remains the authority (CC-MSG-1).
  stubThread(fb, [outboundNode({ agoMs: HOUR_MS, message: 'Anyone there?' })]);
  stubSend(fb, fbOk({ message_id: 'mid.4', recipient_id: PSID }));

  const payload = await sendApplied(
    { conversation_id: CONVERSATION_ID, message: 'Following up.' },
    ctx,
  );

  assert.equal(payload.status, 'applied');
  assert.deepEqual(jsonOf(posts(fb)[0]).body, {
    recipient: { id: PSID },
    message: { text: 'Following up.' },
    messaging_type: 'RESPONSE',
  });
  const entry = journal.entries[0];
  assert.ok(entry);
  assert.equal(record(entry.metadata, 'metadata').windowStatus, 'unknown');
});

test('a bare recipient_id sends with the window honestly reported as unknown', async () => {
  const { fb, journal, ctx } = makeCtx();
  stubSend(fb, fbOk({ message_id: 'mid.2', recipient_id: PSID }));

  const payload = await sendApplied(
    { recipient_id: PSID, message: 'Following up.' },
    ctx,
  );

  assert.equal(payload.status, 'applied');
  // No conversation was read, so no thread GET was issued — only the send. The
  // preview leg makes no request at all, which is why one POST is still the whole
  // conversation on the wire.
  assert.deepEqual(
    jsonCalls(fb).map((r) => r.method),
    ['POST'],
  );
  const entry = journal.entries[0];
  assert.ok(entry);
  assert.equal(record(entry.metadata, 'metadata').windowStatus, 'unknown');
  assert.equal(record(entry.metadata, 'metadata').conversationId, undefined);
});

// ---------------------------------------------------------------------------
// facebook_send_message — failure classification (CC-MSG-2 / CC-MSG-3)
// ---------------------------------------------------------------------------

test('an ambiguous send is journalled attempted, never failed', async () => {
  const { fb, journal, ctx } = makeCtx();
  const ambiguous = graphError('connection reset before the response arrived', {
    category: 'ambiguous',
  });
  stubSend(fb, fbErr(ambiguous));

  await assert.rejects(
    sendApply({ recipient_id: PSID, message: 'Are you still there?' }, ctx),
    (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      // Passed through untouched: the transport already classified it as
      // "may have landed — verify first".
      assert.equal(err.action?.category, 'ambiguous');
      return true;
    },
  );

  assert.equal(journal.entries.length, 1);
  const entry = journal.entries[0];
  assert.ok(entry);
  // The message may already be in the recipient's inbox — claiming `failed`
  // would invite a duplicate resend (C2 / CC-MSG-2).
  assert.equal(entry.outcome, 'attempted');
  assert.match(String(entry.error), /connection reset/);
});

test('a transport fault with no Graph envelope is also attempted, not failed', async () => {
  const { fb, journal, ctx } = makeCtx();
  stubSend(fb, fbErr(new Error('socket hang up')));

  await assert.rejects(
    sendApply({ recipient_id: PSID, message: 'Hello again.' }, ctx),
    /socket hang up/,
  );

  const entry = journal.entries[0];
  assert.ok(entry);
  assert.equal(entry.outcome, 'attempted');
});

test('a Graph rejection envelope proves the send did not happen, so it is failed', async () => {
  const { fb, journal, ctx } = makeCtx();
  stubSend(
    fb,
    fbErr(
      graphError('This message is sent outside of allowed window.', {
        code: 10,
        subcode: 2018278,
      }),
    ),
  );

  await assert.rejects(
    sendApply({ recipient_id: PSID, message: 'Too late.' }, ctx),
    (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.match(err.message, /Message NOT sent/);
      assert.equal(err.action?.category, 'unsupported');
      assert.ok(String(err.action?.operatorText).includes(MESSAGE_TAG_GUIDANCE));
      return true;
    },
  );

  const entry = journal.entries[0];
  assert.ok(entry);
  assert.equal(entry.outcome, 'failed');
});

test('a blocked or deleted recipient is a terminal, non-retryable failure', async () => {
  const { fb, ctx } = makeCtx();
  stubSend(
    fb,
    fbErr(
      graphError('This person is not available right now.', {
        code: 551,
        subcode: 1545041,
      }),
    ),
  );

  await assert.rejects(
    sendApply({ recipient_id: PSID, message: 'Hello?' }, ctx),
    (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.match(err.message, /recipient is unavailable/);
      assert.equal(err.action?.category, 'not_found');
      assert.equal(err.action?.retryable, false);
      assert.match(String(err.action?.operatorText), /do not retry/);
      return true;
    },
  );
});

test('an ambiguous send points the caller at facebook_get_conversation, not a posts listing', async () => {
  const { fb, journal, ctx } = makeCtx();
  // Built exactly the way the transport builds it (`ambiguousError` in
  // core/http.ts): the default verify tool is the posts listing, where a DM
  // can never appear.
  stubSend(
    fb,
    fbErr(
      new GraphApiError('ambiguous write outcome (HTTP 502 on POST) — do NOT retry', {
        code: 0,
        httpStatus: 502,
        action: ambiguousWriteAction({ detail: 'HTTP 502 on POST' }),
      }),
    ),
  );

  await assert.rejects(
    sendApply({ recipient_id: PSID, message: 'Did this arrive?' }, ctx),
    (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.equal(err.action?.category, 'ambiguous');
      assert.equal(err.action?.retryable, false);
      assert.equal(err.action?.nextTool, TOOL_GET);
      assert.doesNotMatch(String(err.action?.operatorText), /facebook_list_posts/);
      assert.match(String(err.action?.operatorText), /do not send it again/i);
      assert.match(err.message, /HTTP 502 on POST/);
      return true;
    },
  );
  assert.equal(journal.entries[0]?.outcome, 'attempted');
});

test('an ambiguous send carries exactly one verify instruction, naming the conversation', async () => {
  const { fb, ctx } = makeCtx();
  stubThread(fb, [inboundNode({ agoMs: 2 * HOUR_MS, message: 'Is this in stock?' })]);
  // What the transport raises on a lost send response; the api layer repoints
  // it at the conversation before the tool layer sees it.
  stubSend(
    fb,
    fbErr(
      new GraphApiError('ambiguous write outcome (HTTP 502 on POST) — do NOT retry', {
        code: 0,
        httpStatus: 502,
        action: ambiguousWriteAction({ detail: 'HTTP 502 on POST' }),
      }),
    ),
  );

  await assert.rejects(
    sendApply({ conversation_id: CONVERSATION_ID, message: 'Yes, it is.' }, ctx),
    (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      const text = String(err.action?.operatorText);
      assert.equal(err.action?.nextTool, TOOL_GET);
      // One instruction, not a generic "verify via" followed by a second,
      // conversation-specific one saying the same thing.
      assert.equal(
        text.split(TOOL_GET).length - 1,
        1,
        `expected ${TOOL_GET} named once, got: ${text}`,
      );
      assert.ok(text.includes(`conversation ${CONVERSATION_ID}`), text);
      assert.match(text, /HTTP 502 on POST/);
      assert.match(text, /Do NOT retry/);
      assert.match(text, /do not send it again/i);
      return true;
    },
  );
});

test('re-aiming an ambiguous send keeps every diagnostic field of the original error', async () => {
  // The rebuilt error must not shed what support needs to trace the failure
  // (subcode, type, fbtrace id), nor the chain back to the wrapped Graph error.
  const { fb, ctx } = makeCtx();
  const inner = new GraphApiError('(#2) Service temporarily unavailable', {
    code: 2,
    httpStatus: 503,
  });
  stubSend(
    fb,
    fbErr(
      new GraphApiError('ambiguous write outcome (HTTP 503 on POST) — do NOT retry', {
        code: 2,
        subcode: 1234,
        type: 'OAuthException',
        fbtraceId: 'trace-amb',
        httpStatus: 503,
        action: ambiguousWriteAction({ detail: 'HTTP 503 on POST' }),
        cause: inner,
      }),
    ),
  );

  await assert.rejects(
    sendApply({ recipient_id: PSID, message: 'Did this arrive?' }, ctx),
    (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.equal(err.action?.nextTool, TOOL_GET);
      assert.equal(err.subcode, 1234);
      assert.equal(err.type, 'OAuthException');
      assert.equal(err.fbtraceId, 'trace-amb');
      let link: unknown = err.cause;
      while (link instanceof Error && link !== inner) link = link.cause;
      assert.equal(link, inner);
      return true;
    },
  );
});

test("a window refusal keeps Meta's userTitle / userMessage for the caller", async () => {
  const { fb, ctx } = makeCtx();
  stubSend(
    fb,
    fbErr(
      new GraphApiError('(#10) This message is sent outside of allowed window.', {
        code: 10,
        subcode: 2018278,
        httpStatus: 400,
        fbtraceId: 'trace-1',
        userTitle: 'Message not sent',
        userMessage: 'This person has not messaged your Page in the last 24 hours.',
      }),
    ),
  );

  await assert.rejects(
    sendApply({ recipient_id: PSID, message: 'Too late.' }, ctx),
    (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.match(err.message, /Message NOT sent/);
      assert.equal(err.subcode, 2018278);
      assert.equal(err.fbtraceId, 'trace-1');
      assert.equal(err.userTitle, 'Message not sent');
      assert.equal(
        err.userMessage,
        'This person has not messaged your Page in the last 24 hours.',
      );
      return true;
    },
  );
});

test("a recipient-unavailable refusal keeps Meta's userMessage for the caller", async () => {
  const { fb, ctx } = makeCtx();
  stubSend(
    fb,
    fbErr(
      new GraphApiError("(#551) This person isn't available right now.", {
        code: 551,
        subcode: 1545041,
        httpStatus: 400,
        userMessage: 'The person blocked messages from this Page.',
      }),
    ),
  );

  await assert.rejects(
    sendApply({ recipient_id: PSID, message: 'Hello?' }, ctx),
    (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.match(err.message, /recipient is unavailable/);
      assert.equal(err.action?.category, 'not_found');
      assert.equal(err.userMessage, 'The person blocked messages from this Page.');
      return true;
    },
  );
});

test('an apply whose arguments drifted from the plan is refused, not sent', async () => {
  const { fb, journal, ctx } = makeCtx();
  stubThread(fb, [inboundNode({ agoMs: HOUR_MS, message: 'Question?' })]);
  stubSend(fb, fbOk({ message_id: 'mid.3' }));

  const preview = body(
    await tool(TOOL_SEND).handler(
      { conversation_id: CONVERSATION_ID, message: 'Original answer.' },
      ctx,
    ),
  );

  await assert.rejects(
    tool(TOOL_SEND).handler(
      {
        conversation_id: CONVERSATION_ID,
        message: 'Swapped answer.',
        apply: true,
        plan_id: preview.planId,
      },
      ctx,
    ),
    /apply params differ from the planned params/,
  );
  assert.equal(posts(fb).length, 0, 'the swapped text must never be sent');
  assert.equal(journal.entries.length, 0);
});

// ---------------------------------------------------------------------------
// Path containment — a thread id must never address another Graph node
// ---------------------------------------------------------------------------

test('conversation_id refuses a value that would address another Graph node or edge', async () => {
  // `/{conversation_id}/messages` is built by interpolation and
  // `containPathname` sees only the joined path, so a `/` inside the id is a new
  // segment: a thread read becomes a read of whatever node the caller named,
  // under the same Page token. The fake answers ANY path, so an escape that got
  // through would be recorded as a call.
  for (const name of [TOOL_GET, TOOL_SEND]) {
    const { fb, ctx } = makeCtx();
    fb.on(() => true, fbOk({ id: CONVERSATION_ID, data: [] }));

    for (const escaped of [
      `${PAGE_ID}/accounts`,
      'me/accounts',
      `${CONVERSATION_ID}/messages?fields=from`,
      '..',
      '.',
    ]) {
      const args =
        name === TOOL_SEND
          ? { conversation_id: escaped, message: 'Hello.' }
          : { conversation_id: escaped };
      await assert.rejects(
        () => tool(name).handler(args, ctx),
        /bare Graph ID/,
        `${name} must refuse conversation_id ${JSON.stringify(escaped)}`,
      );
    }
    assert.equal(
      fb.calls.length,
      0,
      `${name} let an escaped conversation id reach Graph`,
    );
  }
});

test('conversation_id still accepts the thread ids Graph actually mints', () => {
  // Regression coverage: containment must not narrow Graph's ID space.
  for (const id of [CONVERSATION_ID, 't_1234567890', '1234567890', 'act_123']) {
    assert.equal(
      tool(TOOL_GET).inputSchema.safeParse({ conversation_id: id }).success,
      true,
      `${TOOL_GET} must accept conversation_id ${JSON.stringify(id)}`,
    );
    assert.equal(
      tool(TOOL_SEND).inputSchema.safeParse({ conversation_id: id, message: 'Hello.' })
        .success,
      true,
      `${TOOL_SEND} must accept conversation_id ${JSON.stringify(id)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Recipient binding and blank text (wave 11)
// ---------------------------------------------------------------------------

test('a recipient_id that is not in the named conversation is refused, not sent', async () => {
  // conversation_id is what the window verdict and the preview's "in
  // conversation ..." are drawn from, while recipient_id is who the POST goes
  // to. When they disagree the preview vouches for one person's 24-hour window
  // and a thread the message will never appear in, and the apply sends to
  // somebody else entirely (CC-MSG-1 / recipient selection).
  const { fb, journal, ctx } = makeCtx();
  stubThread(fb, [inboundNode({ agoMs: 2 * HOUR_MS, message: 'Is this in stock?' })]);
  stubSend(fb, fbOk({ message_id: 'mid.wrong', recipient_id: '9999' }));

  await assert.rejects(
    tool(TOOL_SEND).handler(
      { conversation_id: CONVERSATION_ID, recipient_id: '9999', message: 'Yes, it is.' },
      ctx,
    ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Nothing was sent/);
      assert.match(err.message, /not a participant/);
      return true;
    },
  );
  assert.equal(posts(fb).length, 0, 'the mismatched recipient must never be messaged');
  assert.equal(journal.entries.length, 0);
});

test('a recipient_id that matches the conversation participant is still accepted', async () => {
  // Regression coverage for the binding above: an explicit PSID that IS the
  // person in the thread keeps working, window verdict included.
  const { fb, journal, ctx } = makeCtx();
  stubThread(fb, [inboundNode({ agoMs: 2 * HOUR_MS, message: 'Is this in stock?' })]);
  stubSend(fb, fbOk({ message_id: 'mid.ok', recipient_id: PSID }));

  const payload = await sendApplied(
    { conversation_id: CONVERSATION_ID, recipient_id: PSID, message: 'Yes, it is.' },
    ctx,
  );
  assert.equal(payload.status, 'applied');
  assert.equal(record(journal.entries[0]?.metadata, 'metadata').windowStatus, 'open');
});

test('an outbound-only thread still binds recipient_id to its `to` participant', async () => {
  // The only non-Page id in an outbound-only thread is the addressee, so a
  // recipient_id naming somebody else is refused just like with an inbound
  // sender, while the addressee itself is accepted.
  const refused = makeCtx();
  stubThread(refused.fb, [outboundNode({ agoMs: HOUR_MS, message: 'Anyone there?' })]);
  stubSend(refused.fb, fbOk({ message_id: 'mid.wrong', recipient_id: '9999' }));
  await assert.rejects(
    tool(TOOL_SEND).handler(
      { conversation_id: CONVERSATION_ID, recipient_id: '9999', message: 'Hello?' },
      refused.ctx,
    ),
    /not a participant/,
  );
  assert.equal(posts(refused.fb).length, 0);

  const accepted = makeCtx();
  stubThread(accepted.fb, [outboundNode({ agoMs: HOUR_MS, message: 'Anyone there?' })]);
  stubSend(accepted.fb, fbOk({ message_id: 'mid.ok', recipient_id: PSID }));
  const payload = await sendApplied(
    { conversation_id: CONVERSATION_ID, recipient_id: PSID, message: 'Hello?' },
    accepted.ctx,
  );
  assert.equal(payload.status, 'applied');
});

test('a thread naming only the Page, or addressees without ids, identifies no recipient', async () => {
  // Rows exist, but every `from` and `to` is the Page itself or carries no id:
  // there is still nobody to send to, so the send is refused, not guessed.
  const { fb, ctx } = makeCtx();
  stubThread(fb, [
    {
      id: 'm_self',
      created_time: graphTime(NOW - HOUR_MS),
      from: { id: PAGE_ID, name: PAGE_NAME },
      to: { data: [{ id: PAGE_ID, name: PAGE_NAME }, { name: 'Nameless' }] },
      message: 'Note to self.',
    },
  ]);
  await assert.rejects(
    tool(TOOL_SEND).handler(
      { conversation_id: CONVERSATION_ID, message: 'Hello?', apply: true },
      ctx,
    ),
    /no recipient could be identified/,
  );
  assert.equal(posts(fb).length, 0);
});

test('a whitespace-only message is refused before any request', async () => {
  // `min(1)` counts characters, so "   " passed the schema and was previewed as
  // a sendable 3-character private message to a real person.
  for (const blank of ['   ', '\n\t ', ' 　']) {
    const { fb, journal, ctx } = makeCtx();
    stubSend(fb, fbOk({ message_id: 'mid.blank' }));
    await assert.rejects(
      tool(TOOL_SEND).handler({ recipient_id: PSID, message: blank }, ctx),
      /Nothing was sent: the message is blank/,
      `a message of ${JSON.stringify(blank)} must be refused`,
    );
    assert.equal(fb.calls.length, 0);
    assert.equal(journal.entries.length, 0);
  }
});

// ---------------------------------------------------------------------------
// The window verdict must not rest on a message it could not read
// ---------------------------------------------------------------------------

/**
 * The newest message is from the visitor but its `created_time` is unusable
 * (here: zone-less, which `parseGraphTime` refuses by design), and behind it
 * sits an older, well-dated inbound message 30h old. The dated one is only a
 * LOWER bound on how recently the person wrote: the undated one may be minutes
 * old, so "closed" is a claim this thread cannot support.
 */
function threadWithUndatedNewestInbound(): unknown[] {
  return [
    {
      id: 'm_undated',
      created_time: '2026-07-28T11:00:00',
      from: { id: PSID, name: 'Visitor' },
      to: { data: [{ id: PAGE_ID, name: PAGE_NAME }] },
      message: 'Are you still there?',
    },
    inboundNode({ agoMs: STANDARD_MESSAGING_WINDOW_MS + 6 * HOUR_MS, message: 'Old' }),
  ];
}

test('facebook_get_conversation does not declare the window closed past an undated inbound message', async () => {
  const { fb, ctx } = makeCtx();
  stubThread(fb, threadWithUndatedNewestInbound());

  const window = record(
    body(await tool(TOOL_GET).handler({ conversation_id: CONVERSATION_ID }, ctx))
      .messagingWindow,
    'messagingWindow',
  );
  assert.equal(
    window.status,
    'unknown',
    'an inbound message with no usable timestamp may be the one that keeps the window open',
  );
  assert.equal(
    window.closesAt,
    undefined,
    'no closing time is minted from a lower bound',
  );
});

test('facebook_send_message does not refuse locally past an undated inbound message', async () => {
  const { fb, journal, ctx } = makeCtx();
  stubThread(fb, threadWithUndatedNewestInbound());
  stubSend(fb, fbOk({ message_id: 'mid.undated', recipient_id: PSID }));

  const payload = await sendApplied(
    { conversation_id: CONVERSATION_ID, message: 'Yes, here to help.' },
    ctx,
  );

  assert.equal(payload.status, 'applied', 'Facebook, not a guess, decides this send');
  assert.equal(posts(fb).length, 1);
  assert.equal(record(journal.entries[0]?.metadata, 'metadata').windowStatus, 'unknown');
});

/**
 * Graph put an entry the edge cannot read (here `null`) at the head of the
 * thread; `fetchPage` drops it and says so in the page note. The dropped entry
 * may be the visitor's reply from a minute ago, so the 30h-old inbound message
 * behind it is only a lower bound — "closed" is not proven.
 */
function threadWithDroppedNewestRow(): unknown[] {
  return [
    null,
    inboundNode({ agoMs: STANDARD_MESSAGING_WINDOW_MS + 6 * HOUR_MS, message: 'Old' }),
  ];
}

test('facebook_get_conversation does not declare the window closed past a dropped unreadable row', async () => {
  const { fb, ctx } = makeCtx();
  stubThread(fb, threadWithDroppedNewestRow());

  const window = record(
    body(await tool(TOOL_GET).handler({ conversation_id: CONVERSATION_ID }, ctx))
      .messagingWindow,
    'messagingWindow',
  );
  assert.equal(
    window.status,
    'unknown',
    'a row Graph sent but the edge could not read may be the message that keeps the window open',
  );
  assert.equal(
    window.closesAt,
    undefined,
    'no closing time is minted from a lower bound',
  );
});

test('facebook_get_conversation returns the page note as notes[] and the deprecated note', async () => {
  const { fb, ctx } = makeCtx();
  stubThread(fb, threadWithDroppedNewestRow());

  const payload = body(
    await tool(TOOL_GET).handler({ conversation_id: CONVERSATION_ID }, ctx),
  );
  assert.ok(Array.isArray(payload.notes), 'notes is an array');
  const notes = payload.notes as readonly string[];
  assert.equal(notes.length, 1);
  assert.equal(payload.note, notes[0]);
});

test('facebook_send_message does not refuse locally past a dropped unreadable row', async () => {
  const { fb, journal, ctx } = makeCtx();
  stubThread(fb, threadWithDroppedNewestRow());
  stubSend(fb, fbOk({ message_id: 'mid.dropped', recipient_id: PSID }));

  const payload = await sendApplied(
    { conversation_id: CONVERSATION_ID, message: 'Yes, here to help.' },
    ctx,
  );

  assert.equal(
    payload.status,
    'applied',
    'Facebook, not an incomplete read, decides this send',
  );
  assert.equal(posts(fb).length, 1);
  assert.equal(record(journal.entries[0]?.metadata, 'metadata').windowStatus, 'unknown');
});

test('an unattributed message dated inside 24h keeps a closed verdict unproven', async () => {
  // `from` is missing on the newest message, so it may be the visitor's; it is
  // 1h old. The only attributed inbound message is 30h old.
  const { fb, ctx } = makeCtx();
  stubThread(fb, [
    {
      id: 'm_anon',
      created_time: graphTime(NOW - HOUR_MS),
      message: 'Hello?',
    },
    inboundNode({ agoMs: STANDARD_MESSAGING_WINDOW_MS + 6 * HOUR_MS, message: 'Old' }),
  ]);

  const window = record(
    body(await tool(TOOL_GET).handler({ conversation_id: CONVERSATION_ID }, ctx))
      .messagingWindow,
    'messagingWindow',
  );
  assert.equal(window.status, 'unknown');
});

test('a closed verdict still stands when every possibly-inbound message is dated and old', async () => {
  // Regression coverage: the Page's own undated message and an unattributed
  // message older than 24h cannot reopen anything, so "closed" is still proven.
  const { fb, ctx } = makeCtx();
  stubThread(fb, [
    {
      id: 'm_out_undated',
      from: { id: PAGE_ID, name: PAGE_NAME },
      to: { data: [{ id: PSID, name: 'Visitor' }] },
      message: 'Ping',
    },
    { id: 'm_anon_old', created_time: graphTime(NOW - 40 * HOUR_MS), message: 'x' },
    inboundNode({ agoMs: STANDARD_MESSAGING_WINDOW_MS + 6 * HOUR_MS, message: 'Old' }),
  ]);

  const window = record(
    body(await tool(TOOL_GET).handler({ conversation_id: CONVERSATION_ID }, ctx))
      .messagingWindow,
    'messagingWindow',
  );
  assert.equal(window.status, 'closed');
});

test('a send cancelled before the POST was issued is journalled failed, not attempted', async () => {
  // The caller cancels after the apply's window probe and before `perform`
  // issues the POST. `fetch` refuses an already-aborted signal before a byte
  // leaves the machine, and the transport rethrows that AbortError raw — so a
  // classifier that reads only the error cannot tell it from a mid-flight abort
  // and journals "may already be in the inbox" about a message nobody received.
  const { fb, journal, ctx } = makeCtx();
  stubThread(fb, [inboundNode({ agoMs: HOUR_MS, message: 'Hi' })]);
  stubSend(fb, fbOk({ message_id: 'mid.1', recipient_id: PSID }));
  const args = { conversation_id: CONVERSATION_ID, message: 'On our way.' };
  const preview = body(await tool(TOOL_SEND).handler(args, ctx));

  const controller = new AbortController();
  let postsSent = 0;
  const cancellingCtx: WriteToolContext = {
    ...ctx,
    signal: controller.signal,
    fbRequest: async <T>(req: Parameters<WriteToolContext['fbRequest']>[0]) => {
      // Mirror fetch: an already-aborted signal rejects before anything is sent.
      if (req.method !== 'GET' && req.signal?.aborted === true) {
        throw Object.assign(new Error('This operation was aborted'), {
          name: 'AbortError',
        });
      }
      if (req.method !== 'GET') postsSent += 1;
      const res = await fb.fn<T>(req);
      // Cancel right after the apply's window probe, i.e. before the POST.
      if (req.method === 'GET') controller.abort();
      return res;
    },
  };

  await assert.rejects(
    tool(TOOL_SEND).handler(
      { ...args, apply: true, plan_id: preview.planId },
      cancellingCtx,
    ),
    /aborted/,
  );

  assert.equal(postsSent, 0, 'the POST never left the machine');
  assert.equal(journal.entries.length, 1, 'exactly one journal entry');
  assert.equal(
    journal.entries.at(-1)?.outcome,
    'failed',
    'a send cancelled before it was issued cannot have been delivered',
  );
});

test('a send cancelled while the POST was in flight stays attempted', async () => {
  // The other half of the rule: once the POST is on the wire, an abort leaves
  // delivery unknown, so the journal must still say "attempted".
  const { journal, ctx } = makeCtx();
  const controller = new AbortController();
  const cancellingCtx: WriteToolContext = {
    ...ctx,
    signal: controller.signal,
    fbRequest: (req: Parameters<WriteToolContext['fbRequest']>[0]) => {
      if (req.method === 'GET') return ctx.fbRequest(req);
      controller.abort();
      return Promise.reject(
        Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }),
      );
    },
  };
  const args = { recipient_id: PSID, message: 'Checking in.' };
  const preview = body(await tool(TOOL_SEND).handler(args, cancellingCtx));

  await assert.rejects(
    tool(TOOL_SEND).handler(
      { ...args, apply: true, plan_id: preview.planId },
      cancellingCtx,
    ),
    /aborted/,
  );

  assert.equal(journal.entries.at(-1)?.outcome, 'attempted');
});
