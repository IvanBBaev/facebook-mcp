// Tests for message attachments: facebook_send_message with an attachment and
// facebook_upload_message_attachment.
//
// Shared fixtures, fakes and helpers live in `src/testing/harness/messages.ts`;
// the suite-level notes (load-bearing behaviours) are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fbOk } from '../core/fakes/index.js';
import {
  CONVERSATION_ID,
  HOUR_MS,
  NOW,
  PAGE_ID,
  PSID,
  TOOL_SEND,
  TOOL_UPLOAD,
  body,
  inboundNode,
  jsonOf,
  makeCtx,
  posts,
  record,
  sendApplied,
  stubSend,
  stubThread,
  tool,
} from '../testing/harness/messages.js';

// ---------------------------------------------------------------------------
// Outbound attachments (v2 F3)
// ---------------------------------------------------------------------------

const ATTACHMENT_URL = 'https://cdn.example.com/menu.pdf?sig=SIGNED-QUERY';

test('facebook_send_message sends one attachment by URL and journals no URL', async () => {
  const { fb, journal, ctx } = makeCtx();
  stubThread(fb, [inboundNode({ agoMs: HOUR_MS })]);
  stubSend(fb, fbOk({ message_id: 'mid.att', recipient_id: PSID }));
  const args = {
    conversation_id: CONVERSATION_ID,
    attachment: { type: 'file', url: ATTACHMENT_URL },
  };

  const preview = body(await tool(TOOL_SEND).handler(args, ctx));
  assert.equal(preview.status, 'preview');
  assert.match(
    String(preview.summary),
    /^Send a PRIVATE Messenger file attachment \(by URL\)/,
  );
  assert.doesNotMatch(String(preview.summary), /cdn\.example/);
  assert.ok(
    (preview.warnings as string[]).some((w) => /Meta fetches the attachment URL/.test(w)),
  );

  const applied = body(
    await tool(TOOL_SEND).handler({ ...args, apply: true, plan_id: preview.planId }, ctx),
  );
  assert.equal(applied.status, 'applied');
  assert.equal(record(applied.result, 'result').attachmentType, 'file');
  assert.deepEqual(jsonOf(posts(fb)[0]).body, {
    recipient: { id: PSID },
    message: {
      attachment: { type: 'file', payload: { url: ATTACHMENT_URL, is_reusable: false } },
    },
    messaging_type: 'RESPONSE',
  });
  const entry = journal.entries[0];
  assert.ok(entry);
  assert.deepEqual(entry.metadata, {
    recipientId: PSID,
    conversationId: CONVERSATION_ID,
    attachmentType: 'file',
    attachmentSource: 'url',
    windowStatus: 'open',
    replyTo: false,
  });
  assert.doesNotMatch(JSON.stringify(entry), /SIGNED-QUERY|cdn\.example/);
});

test('facebook_send_message sends a reusable attachment id', async () => {
  const { fb, ctx } = makeCtx();
  stubSend(fb, fbOk({ message_id: 'mid.id', recipient_id: PSID }));

  const applied = await sendApplied(
    {
      recipient_id: PSID,
      attachment: { type: 'image', attachment_id: '1857777774821032' },
    },
    ctx,
  );

  assert.equal(applied.status, 'applied');
  assert.deepEqual(jsonOf(posts(fb)[0]).body, {
    recipient: { id: PSID },
    message: {
      attachment: { type: 'image', payload: { attachment_id: '1857777774821032' } },
    },
    messaging_type: 'RESPONSE',
  });
});

test('a message carries text or one attachment, and the attachment one source', async () => {
  const { fb, ctx } = makeCtx();
  for (const args of [
    {
      recipient_id: PSID,
      message: 'Hi',
      attachment: { type: 'file', url: ATTACHMENT_URL },
    },
    { recipient_id: PSID, attachment: { type: 'file' } },
    {
      recipient_id: PSID,
      attachment: { type: 'file', url: ATTACHMENT_URL, attachment_id: '1' },
    },
  ]) {
    await assert.rejects(tool(TOOL_SEND).handler(args, ctx), /exactly one of/);
  }
  await assert.rejects(
    tool(TOOL_SEND).handler({ recipient_id: PSID }, ctx),
    /attachment/,
  );
  assert.equal(fb.calls.length, 0, 'refused before any request');
});

test('an attachment URL must be public HTTPS without credentials', async () => {
  const { fb, ctx } = makeCtx();
  for (const url of [
    'http://cdn.example.com/a.png',
    'https://user:pw@cdn.example.com/a.png',
  ]) {
    await assert.rejects(
      tool(TOOL_SEND).handler(
        { recipient_id: PSID, attachment: { type: 'image', url } },
        ctx,
      ),
      /Nothing was sent: the attachment URL must be a public https/,
    );
    await assert.rejects(
      tool(TOOL_UPLOAD).handler({ type: 'image', url }, ctx),
      /Nothing was uploaded/,
    );
  }
  assert.equal(fb.calls.length, 0);
});

test('a changed attachment after the preview does not match the plan', async () => {
  const { fb, ctx } = makeCtx();
  stubSend(fb, fbOk({ message_id: 'mid.x', recipient_id: PSID }));
  const args = {
    recipient_id: PSID,
    attachment: { type: 'image', attachment_id: '111' },
  };

  const preview = body(await tool(TOOL_SEND).handler(args, ctx));
  await assert.rejects(
    tool(TOOL_SEND).handler(
      {
        ...args,
        attachment: { type: 'image', attachment_id: '222' },
        apply: true,
        plan_id: preview.planId,
      },
      ctx,
    ),
    (err: unknown) => (err as { code?: unknown }).code === 'plan_mismatch',
  );
  assert.equal(posts(fb).length, 0);
});

test('facebook_upload_message_attachment previews, then uploads a reusable file', async () => {
  const { fb, journal, ctx } = makeCtx();
  fb.on(
    (req) => req.path === `/${PAGE_ID}/message_attachments` && req.method === 'POST',
    fbOk({ attachment_id: '1857777774821032' }),
  );
  const spec = tool(TOOL_UPLOAD);
  assert.equal(spec.writeTier, 'reversible');
  assert.deepEqual(spec.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  });
  const args = { type: 'file', url: ATTACHMENT_URL };

  const preview = body(await spec.handler(args, ctx));
  assert.equal(preview.status, 'preview');
  assert.equal(posts(fb).length, 0);
  assert.doesNotMatch(String(preview.summary), /cdn\.example/);

  const applied = body(
    await spec.handler({ ...args, apply: true, plan_id: preview.planId }, ctx),
  );
  assert.equal(applied.status, 'applied');
  const result = record(applied.result, 'result');
  assert.equal(result.attachmentId, '1857777774821032');
  assert.equal(result.expiresAtEstimate, new Date(NOW + 90 * 24 * HOUR_MS).toISOString());
  assert.deepEqual(jsonOf(posts(fb)[0]).body, {
    message: {
      attachment: { type: 'file', payload: { url: ATTACHMENT_URL, is_reusable: true } },
    },
  });
  const entry = journal.entries[0];
  assert.ok(entry);
  assert.equal(entry.outcome, 'applied');
  assert.deepEqual(entry.metadata, { type: 'file' });
  assert.doesNotMatch(JSON.stringify(entry), /SIGNED-QUERY/);
});

test('an upload acknowledged without an id is attempted, not applied', async () => {
  const { fb, journal, ctx } = makeCtx();
  fb.on((req) => req.method === 'POST', fbOk({}));
  const args = { type: 'image', url: 'https://cdn.example.com/a.png' };

  const preview = body(await tool(TOOL_UPLOAD).handler(args, ctx));
  const payload = body(
    await tool(TOOL_UPLOAD).handler(
      { ...args, apply: true, plan_id: preview.planId },
      ctx,
    ),
  );

  assert.notEqual(payload.status, 'applied');
  assert.equal(journal.entries[0]?.outcome, 'attempted');
});
