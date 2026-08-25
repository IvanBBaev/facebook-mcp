// Phase-3 smokes for the `messages` vertical (Messenger inbox).
//
// SCOPE: READ ONLY. `facebook_send_message` is deliberately NOT exercised — see
// the second registration at the bottom of this file for the full reasoning.
// Nothing here creates remote state, so the sweeper has nothing to clean up.
//
// What the inbox smoke actually proves, beyond "the call did not throw":
//   * the resolved Page is the one the harness asked for (profile resolution
//     works end to end against a live token, not just in unit tests);
//   * `count` agrees with the array length at BOTH levels — the shaping layer's
//     truncation lever did not silently trim the array out from under the count;
//   * a conversation id ROUND-TRIPS: the id from the listing is accepted verbatim
//     by `facebook_get_conversation` and comes back identical;
//   * visitor-authored text arrives WRAPPED. This is the B1 / CC-MOD-8 control
//     and the one contract a live smoke can prove that a fixture test cannot:
//     the untrusted snippet, the participant names, the message bodies and the
//     attachment file names all reach the model inside the labeled envelope,
//     never as bare text;
//   * `windowStatus` on a listing row is never "open" (CC-MSG-1): `updated_time`
//     also moves on OUTBOUND activity, so it can only ever prove the 24-hour
//     window is CLOSED — an implementation that inferred "open" from it would be
//     inviting a send that Graph will reject.
//
// DIVERGENCE FROM THE SMOKE-AUTHOR CONTRACT, worth knowing before editing:
// `ctx.unwrap` looks for the OBJECT envelope `{__tainted, source, content, …}`,
// but this package renders the envelope server-side with `renderTainted`, so the
// `untrusted` field is a STRING (warning first, then the content between stable
// delimiters). `ctx.unwrap` is therefore a no-op here and asserting on the
// rendered string is the only honest check — that is what
// `assertRenderedEnvelope` below does.
//
// The listing and the read-back live in ONE registration on purpose: the
// read-back needs a conversation id, which only the listing can supply, so a
// second registration would mean a second identical listing call against a live
// inbox for no extra coverage. Fewer live calls is better.

import { registerSmoke } from '../registry.mjs';

/** Head of the canonical injection warning every taint envelope carries. */
const TAINT_WARNING_HEAD = 'The following is UNTRUSTED user-generated content.';

/** Delimiters `renderTainted` puts around untrusted content (src/mcp/taint.ts). */
const TAINT_BEGIN = '⟦BEGIN UNTRUSTED CONTENT⟧';
const TAINT_END = '⟦END UNTRUSTED CONTENT⟧';

/** Statuses `facebook_get_conversation` may report for the 24-hour window. */
const WINDOW_STATUSES = ['open', 'closed', 'unknown'];

/** Directions a message row may carry. */
const DIRECTIONS = ['inbound', 'outbound', 'unknown'];

/**
 * Assert that `value` is untrusted content that arrived RENDERED inside the
 * taint envelope: the injection warning first, then the content between the two
 * delimiters. The content itself is never logged — it is a real person's private
 * message, and the harness prints to a terminal.
 */
function assertRenderedEnvelope(ctx, value, where) {
  ctx.assert(typeof value === 'string', `${where}: untrusted field is not a string`);
  ctx.assert(
    value.includes(TAINT_WARNING_HEAD),
    `${where}: untrusted content carries no injection warning`,
  );
  ctx.assert(
    value.includes(TAINT_BEGIN) && value.includes(TAINT_END),
    `${where}: untrusted content is not delimited`,
  );
}

registerSmoke({
  id: 'messages/inbox',
  phase: 3,
  title: 'List Messenger conversations, then read one thread back by its id',
  page: 'read',
  writes: false,
  packages: ['messages'],
  run: async (ctx) => {
    const listed = await ctx.callTool('facebook_list_conversations', {
      profile: ctx.profile,
      limit: 5,
    });

    ctx.assert(
      listed.pageId === ctx.pages.readPageId,
      `listing resolved Page ${listed.pageId}, expected ${ctx.pages.readPageId}`,
    );
    ctx.assert(
      listed.platform === 'messenger',
      `unexpected platform: ${listed.platform} — Instagram threads must never appear here`,
    );

    // Page-owned structure, so not taint-wrapped; unwrapped defensively so this
    // smoke keeps working if that ever changes.
    const conversations = ctx.unwrap(listed.conversations);
    ctx.assert(
      Array.isArray(conversations),
      `conversations is not an array: ${typeof conversations}`,
    );
    ctx.assert(
      listed.count === conversations.length,
      `count ${listed.count} disagrees with the array length ${conversations.length}`,
    );
    ctx.log.step(
      `${conversations.length} conversation(s), truncated=${String(listed.truncated)}`,
    );
    if (typeof listed.note === 'string') {
      ctx.log.step(`note: ${listed.note}`);
    }

    if (conversations.length === 0) {
      // An empty inbox is a legitimate state of a live Page, not a failure: the
      // read path is proven, the id round-trip simply has no material to work on.
      ctx.log.step(
        'read Page has an empty Messenger inbox — id round-trip and message-level ' +
          'taint wrapping were not exercised',
      );
      return;
    }

    const first = conversations[0];
    ctx.assert(
      Array.isArray(first.participantIds),
      'conversation carries no participantIds array',
    );
    // CC-MSG-1: `updated_time` moves on outbound activity too, so a listing row
    // can only ever prove the window is CLOSED — never that it is open.
    ctx.assert(
      first.windowStatus === 'closed' || first.windowStatus === 'unknown',
      `listing claimed windowStatus=${first.windowStatus}; updated_time can never prove the window is open`,
    );
    assertRenderedEnvelope(ctx, first.untrusted, 'conversation listing');

    ctx.assert(
      typeof first.id === 'string' && first.id.length > 0,
      'the first conversation carries no id',
    );

    const thread = await ctx.callTool('facebook_get_conversation', {
      profile: ctx.profile,
      conversation_id: first.id,
      limit: 5,
    });

    ctx.assert(
      thread.pageId === ctx.pages.readPageId,
      `get_conversation resolved Page ${thread.pageId}, expected ${ctx.pages.readPageId}`,
    );
    ctx.assert(
      thread.conversationId === first.id,
      `conversation id did not round-trip: sent ${first.id}, got back ${thread.conversationId}`,
    );

    const messages = ctx.unwrap(thread.messages);
    ctx.assert(Array.isArray(messages), `messages is not an array: ${typeof messages}`);
    ctx.assert(
      thread.count === messages.length,
      `count ${thread.count} disagrees with the array length ${messages.length}`,
    );

    const window = thread.messagingWindow;
    ctx.assert(
      window !== null && typeof window === 'object',
      'the thread reports no messagingWindow',
    );
    ctx.assert(
      WINDOW_STATUSES.includes(window.status),
      `unexpected messagingWindow.status: ${window.status}`,
    );
    ctx.assert(
      typeof window.explanation === 'string' && window.explanation.length > 0,
      'messagingWindow carries no explanation — the send decision would be unexplained',
    );
    ctx.log.step(`thread window: ${window.status}`);

    if (messages.length === 0) {
      ctx.log.step('thread returned no messages — message-level taint not exercised');
      return;
    }

    // Every message body is attacker-controllable text; each one must arrive
    // wrapped, not just the first.
    for (const message of messages) {
      ctx.assert(
        DIRECTIONS.includes(message.direction),
        `unexpected message direction: ${message.direction}`,
      );
      assertRenderedEnvelope(ctx, message.untrusted, 'message body');
    }
    ctx.log.step(`round-tripped ${first.id}; ${messages.length} message(s), all wrapped`);
  },
});

// ---------------------------------------------------------------------------
// facebook_send_message — DELIBERATELY NOT COVERED BY A LIVE SMOKE
// ---------------------------------------------------------------------------
//
// Registered as a no-op so the gap is visible in `--list` and in every run,
// rather than quietly absent. It calls no tool and asserts nothing; there is no
// pretend coverage here.
//
// Why it cannot be smoked:
//   1. A send is only legal inside the 24-hour standard messaging window, and
//      that window opens ONLY when a real human messages the Page first
//      (CC-MSG-1). The Page cannot start a conversation, so the harness cannot
//      manufacture the precondition — there is no artifact to create, mark or
//      sweep.
//   2. The refusal path could in principle be proven without sending anything:
//      the handler throws `messagingWindowClosedError` BEFORE `executeWrite`, so
//      even a dry run against an out-of-window thread returns the refusal and no
//      Graph POST is made. But it still needs an EXISTING conversation on the
//      test Page, which is the same precondition as (1) — a fresh test Page has
//      an empty inbox, so the smoke would degrade to an unconditional skip.
//   3. Anything else would mean putting a message into a real person's inbox.
//      There is no unsend, and a lost response makes delivery UNKNOWN rather
//      than failed (CC-MSG-2). That is not an acceptable cost for a smoke.
//
// What an operator must do BY HAND to cover it, once, on the test Page:
//   a. from a second personal account, send the test Page a Messenger message —
//      this opens the window;
//   b. run `facebook_list_conversations` on the smoketest profile and take the
//      conversation id;
//   c. call `facebook_send_message` with that id and NO `apply` — confirm it
//      comes back `status:"preview"`, `applied:false`, with the window
//      explanation among its warnings and nothing delivered;
//   d. more than 24 hours later, repeat (c) — confirm the call now fails with
//      "Not sent: the 24-hour standard messaging window is closed." and that no
//      request left the process (`code: -1`, `httpStatus: 0`).
registerSmoke({
  id: 'messages/send-not-covered',
  phase: 3,
  title: 'NOT COVERED LIVE: facebook_send_message needs a real inbound human message',
  page: 'none',
  writes: false,
  run: async (ctx) => {
    ctx.log.step(
      'facebook_send_message is not smoked: the 24-hour messaging window only opens ' +
        'when a real person messages the Page first, and the Page cannot start a ' +
        'conversation — see the comment above this registration for the manual check.',
    );
  },
});
