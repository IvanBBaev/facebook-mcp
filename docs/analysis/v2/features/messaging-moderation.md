# v2.0 feature specs: Messenger and comment moderation

Status: research draft (2026-10-24). Graph API v26.0 pin (`DEFAULT_API_VERSION`). Scope is
code only, with no marketing, adoption or process work.


Sources: `src/api/messaging.ts`, `src/tools/messages.ts`, `src/api/comments.ts`,
`src/tools/moderation.ts`, `src/tools/shared.ts`, `src/api/media-photos.ts`,
`src/core/http-upload.ts`, `src/core/config.ts` (main at 5724988),
`docs/analysis/05-architecture.md`, `docs/analysis/06-tool-catalog.md`,
`docs/analysis/v2/02-v1x-backlog.md` (O2, O5, O6),
the local research note `codebase-contract-audit` (P6, P7, F16),
the local research note `meta-organic-surface` §7. Meta docs were fetched 2026-10-24 under
`developers.facebook.com/documentation/business-messaging/messenger-platform/...`. The legacy
`/docs/messenger-platform/...` URLs now render empty.

Hard constraints, applied to every feature below:

- No `HUMAN_AGENT` tag and no message tag of any kind. `messaging_type` stays `RESPONSE`, so
  every Messenger send stays inside the standard 24-hour window.
- The four lint-enforced layers stay `core ← api ← mcp ← tools`. The api layer only shapes
  data; taint wrapping happens in tools via `taint()` / `renderTainted`. Filesystem access
  lives in core.
- Tools are data: `defineTool` with zod `.strict()` inputs, every field `.describe()`d,
  `logFields` excluding message text and PSIDs, and a `writeTier`. Every write goes through
  `executeWrite` (plan and apply).
- Ambiguous writes are never auto-retried (C2). A 2xx without the expected id or ack counts
  as `attempted`.

---

## 0. Verified facts (Meta docs, 2026-10)

| # | Fact | Status | Consequence |
|---|---|---|---|
| V1 | Send API reply threading: a top-level `"reply_to": {"mid": "<message id>"}` next to `recipient`, `messaging_type` and `message` | documented (changelog 2025-07-15) | F1 is additive |
| V2 | Conversations API message field `reply_to{mid,is_self_reply}` | changelog 2025-10-06. **Not listed** on the Message node reference page | Probe P-1 before adding it to `MESSAGE_FIELDS` |
| V3 | Message node fields include `reactions{reaction,users{id,username}}`, `tags`, `is_unsupported`, `story`, `shares` | documented | F1 read side can add `reactions` |
| V4 | Sender action `react`: POST `/{page}/messages` with `{recipient:{id}, sender_action:"react", payload:{message_id, reaction:"<emoji>"}}`. `unreact` takes `payload:{message_id}` only. It cannot be combined with `message`. The response is `{recipient_id}` only | documented | F2. The outcome is ack-based, with no message id |
| V5 | Reaction window and `messaging_type` rules for `react` are not documented | undocumented | Probe P-2 |
| V6 | Outbound attachment: `message.attachment{type: image\|audio\|video\|file, payload:{url, is_reusable?} \| {attachment_id}}`. Multi-image `message.attachments[]` takes images only, up to 30 | documented | F3 |
| V7 | `text` and `attachment` are mutually exclusive in one `message` object | documented | F3 uses XOR per call |
| V8 | Reusable upload: POST `/{page}/message_attachments`, either JSON `{message:{attachment:{type,payload:{url,is_reusable:true}}}}` or multipart `filedata` plus a `message` JSON part, returns `{attachment_id}` | documented | F3b. The multipart form is probe P-3 |
| V9 | Limits: 25 MB per file; images fetched by URL 8 MB; URL fetch timeout 75 s for video, 10 s otherwise. Attachment ids expire after 90 days, are owned by the Page, and error `100/2018074` means an invalid or foreign id | documented | F3 validation and error mapping |
| V10 | Private replies: `recipient` can be `{comment_id}` **or `{post_id}`** (visitor posts). One message per commenter within 7 days. Every Send API message type is allowed. Needs `pages_messaging` and the MESSAGING task | documented | F4 |
| V11 | Conversations: detail only for the 20 most recent messages. `user_id=<PSID>` finds the thread with that person | documented | F13 |
| V12 | Custom Labels: POST `/{page}/custom_labels` with `page_label_name`; POST/DELETE `/{label}/label` with `user=<PSID>`; GET `/{psid}/custom_labels`; GET `/{page}/custom_labels`; DELETE `/{label}`. No deprecation notice | documented | F11. The listed permissions include a suspicious `pages_me`, so this is probe P-6 |
| V13 | Like as the Page: POST `/{object}/likes` returns `{success:true}` and needs `pages_manage_engagement` plus the CREATE_CONTENT task. DELETE `/{object}/likes` needs the MODERATE task and removes only the Page's own like. The comment field `user_likes` reports the viewer's like | documented | F9 |
| V14 | Comment create (POST `/{object}/comments`) takes `message`, `attachment_id` (unpublished photo), `attachment_url` (image URL), `attachment_share_url` (GIF) and `source` (multipart); at least one is required. Comment update (POST `/{comment}`) takes `message`, `is_hidden`, `attachment_id`, `attachment_url` and `attachment_share_url` | documented | F8 |
| V15 | Comment read params: `filter` (`toplevel`/`stream`) and `summary` are documented. `order` appears only as a response field and `since` is undocumented | documented | F6 filters timestamps locally and does not rely on `since` |
| V16 | Page settings: GET/POST `/{page}/settings` with `option` objects; `PAGE_MODERATION_BLACKLIST` (comma-separated words), `PROFANITY_FILTER` (`OFF`/`MEDIUM`/`STRONG`), `USERS_CAN_MESSAGE`. One option per POST. `WALL_COMBINED_POSTS` is deprecated. New Page Experience support is confirmed for reads only | documented (reads) | F12. Writes on NPE Pages and the required scope are probe P-7 |
| V17 | Message tags `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE` and `POST_PURCHASE_UPDATE` return error 100 since 2026-04-27 | documented | Dropped (§D) |
| V18 | The Moderate Conversations API is documented for Instagram only | changelog; the Messenger page 404s | Dropped for Messenger (§D) |

### Live probes referenced below

| Probe | Question | Blocks |
|---|---|---|
| P-1 | Does `GET /{message}?fields=reply_to{mid,is_self_reply}` work on v26 for a Messenger thread? Does it return nothing, or error 100, for a message that is not a reply? | F1 read side |
| P-2 | Does `sender_action:react` outside the 24h window return 10/2018278? Can the Page react to its own outbound message? Does it need `messaging_type`? What is the error for an emoji outside the allowed set? | F2 gating |
| P-3 | Does multipart `filedata` on `/{page}/message_attachments` work through `core/http-upload.ts` unchanged (field name, part order, `message` part as a JSON string)? | F3b local upload |
| P-4 | Does a private reply carrying an attachment work on v26 for `comment_id` and for `post_id`? | F4 attachment |
| P-5 | What does `POST /{comment}/likes` return when the Page has already liked the comment (error code)? | F9 idempotency mapping |
| P-6 | What exact scope does Custom Labels need (`pages_messaging` vs `pages_manage_metadata`), and what is the error when Page Contact Terms are not accepted? | F11 |
| P-7 | Does `POST /{page}/settings` with `PAGE_MODERATION_BLACKLIST` work on a New Page Experience Page, and with which scope (`pages_manage_metadata`?) | F12 write |

---

## Summary table

| ID | Feature | Tool(s) | Tier | Effort | Codeable now? | Breaking? |
|---|---|---|---|---|---|---|
| F1 | Messenger reply threading (send plus read) | `facebook_send_message` (+`reply_to_message_id`), `facebook_get_conversation` fields | reversible (unchanged) | S | Send: yes. Read: needs P-1 | additive |
| F2 | Message reactions | `facebook_react_to_message` (new) | reversible | S | yes with fakes. Gating needs P-2 | additive |
| F3 | Attachments in Messenger replies | `facebook_send_message` (+`attachment`), `facebook_upload_message_attachment` (new, optional) | reversible / reversible | M | URL and id: yes. Local file: needs P-3 | additive |
| F4 | Private reply improvements | `facebook_private_reply` (+`post_id`, +`attachment`) | irreversible (unchanged) | S–M | `post_id`: yes. Attachment: needs P-4 | additive |
| F5 | `notes[]` instead of the joined `note` | every paged read in moderation and messages | — | S | yes | additive in v1.x, `note` removed in 2.0 (breaking) |
| F6 | Bulk comment triage | `facebook_triage_comments` (new, read) | read | M | yes | additive |
| F7 | Reply and hide in one call | `facebook_reply_and_hide_comment` (new) | reversible | S–M | yes | additive |
| F8 | Comment reply with attachment; edit own comment | `facebook_reply_to_comment` (+`attachment`), `facebook_edit_comment` (new) | reversible | S | yes (`source` multipart reuses the photo path) | additive |
| F9 | Like or unlike comments as the Page | `facebook_like_comment` (new, bulk) | reversible | S | yes. Duplicate-like code needs P-5 | additive |
| F10 | Local saved replies | `facebook_list_saved_replies`, `facebook_save_reply`, `facebook_delete_saved_reply` (new) + `saved_reply_id` on send/reply | local (no Graph) | M | yes | additive |
| F11 | Custom labels on conversations | `facebook_list_labels`, `facebook_manage_label` (new) | reversible | M | yes with fakes. Scope needs P-6 | additive |
| F12 | Page moderation settings (blocked words, profanity filter) | `facebook_get_moderation_settings`, `facebook_set_moderation_settings` (new) | reversible | M | read: yes. Write needs P-7 | additive |
| F13 | Find a conversation by PSID | `facebook_list_conversations` (+`user_id`) | read | S | yes | additive |

New tools: 13 if all ship (F2, F3b, F6, F7, F8b, F9, F10 x3, F11 x2, F12 x2), taking the catalog from 37 to 50. Each
new tool changes the default-profile snapshot in `src/mcp/packages.test.ts` and the catalog in
`docs/analysis/06-tool-catalog.md` (counts, annotation table). Package placement is stated per
feature. The `messages` package keeps `writeModeDefault:'plan'` and `moderation` keeps
`'apply'`.

Recommended ship order: F5 → F1 → F9 → F8 → F7 → F13 → F2 → F3 → F4 → F6 → F10 → F12 → F11.

---

## F1. Messenger reply threading (`reply_to`)

**User story.** As a Page operator, I want the agent's reply to quote the specific customer
message it answers, so a thread with several open questions stays readable. I also want
`get_conversation` to show which message each message replies to.

**Tool.** `facebook_send_message` (extended) and `facebook_get_conversation` (read fields).

**Input sketch (additive field on the existing schema).**

```ts
reply_to_message_id: z.string().regex(MESSAGE_ID_SHAPE).max(200).optional()
  .describe('Message id (mid, from facebook_get_conversation) this reply quotes. ' +
    'Must belong to the same conversation. Optional.'),
```

`MESSAGE_ID_SHAPE = /^[\w.:\-+=\/]+$/`. Messenger mids look like `m_...` and can contain
`-` and `_`, but they never go into a URL path here. They travel only in the JSON body, so
`graphNodeIdArg` is not required. Cap the length and reject whitespace and control chars.

**Output.** Unchanged envelope. The applied payload adds `replyToMessageId` (echoed) to
`result`. Journal metadata adds `replyTo: true|false`. The mid itself is not logged, since
it identifies a private message.

**Read side.** Add `reactions{reaction,users{id}}` (V3) to `MESSAGE_FIELDS` now. Add
`reply_to{mid,is_self_reply}` only after P-1 passes. `MessageRecord` gains:

```ts
replyToMessageId?: string;   // reply_to.mid
isSelfReply?: boolean;       // reply_to.is_self_reply
reactions?: { reaction: string; count: number; byPage: boolean }[];  // users folded to count
```

The emoji itself is user content, so tools render it through `taint()`. PSIDs of reactors are
not echoed, only `count` and `byPage` (users[].id === pageId).

**Graph calls.**

| Call | Body/params | Permission |
|---|---|---|
| POST `/{page}/messages` | `{recipient:{id}, messaging_type:'RESPONSE', reply_to:{mid}, message:{text}}` | `pages_messaging` |
| GET `/{conversation}/messages?fields=MESSAGE_FIELDS` | adds `reactions{...}`, then `reply_to{mid,is_self_reply}` | `pages_messaging`, `pages_manage_metadata` |

**Write tier and preview.** Tier reversible, plan-bound (`requirePlanId:true`), as today.
`reply_to_message_id` becomes part of the plan identity (`params`), so a changed target
invalidates the plan. The preview summary adds "as a reply to message <first 8 chars>…".

**Pre-flight (local, no extra call).** If the window probe already fetched the last
`WINDOW_PROBE_LIMIT` messages (it does when `conversation_id` is given), check that the mid
appears among them. If it does not, add the warning "reply target is not among the last 10
messages; Meta may reject it or send it unthreaded". Do not refuse, since older mids are
valid.

**Errors.**
- Invalid or foreign mid: Graph 100 (subcode unknown). Map it through `explainSendFailure`
  with the hint "reply_to mid not found in this conversation". The outcome is `failed`. There
  is no retry.
- Window closed: unchanged (`messagingWindowClosedError`).

**Files.**
- api: `src/api/messaging.ts`. `sendMessage` options gain `replyToMessageId?`, and the body
  builder adds `reply_to`. `MESSAGE_FIELDS` and the `MessageRecord` shaping change (reply_to
  gated behind a constant `READ_REPLY_TO = false` until P-1).
- tools: `src/tools/messages.ts`. Arg, params, summary, journal metadata, preview warning,
  and rendering of `replyToMessageId` and `reactions` in `get_conversation`.
- tests: `src/api/messaging.test.ts` (body shape includes `reply_to` only when set; reactions
  folding), `src/tools/messages.test.ts` (plan identity changes with the mid; the warning
  appears when the mid is not in the probe window; the mid is absent from journal metadata).
- fixtures: inline `fakeFbRequest` responses. Optionally add `test/fixtures/graph-conversation-messages.json`
  (synthetic ids only; fixture-lint applies).

**Effort.** S. **Codeable now:** send side and `reactions` read, yes. `reply_to` read needs
P-1. **Dependencies:** none. **Breaking:** no.

---

## F2. Message reactions (`facebook_react_to_message`)

**User story.** As a Page operator, I want to acknowledge a customer message with a reaction
(for example ❤️ or 👍) without sending a text reply, and to remove that reaction.

**Tool.** `facebook_react_to_message` in the `messages` package.

**Input sketch.**

```ts
z.object({
  ...writeArgs,                         // profile, page, apply, plan_id
  conversation_id: graphNodeIdArg.optional().describe('Conversation (t_...) to resolve the recipient and check the window.'),
  recipient_id: psidArg.optional().describe('PSID of the person. One of conversation_id or recipient_id is required.'),
  message_id: z.string().regex(MESSAGE_ID_SHAPE).max(200).describe('Message id (mid) to react to.'),
  reaction: z.string().min(1).max(16).optional()
    .describe('A single emoji, for example "❤️". Omit together with remove:true to remove the reaction.'),
  remove: z.boolean().default(false).describe('true removes the Page\'s reaction (unreact).'),
}).strict()
  .refine(a => a.remove !== (a.reaction !== undefined), 'Pass exactly one of reaction or remove:true')
  .refine(a => a.conversation_id || a.recipient_id, 'conversation_id or recipient_id is required')
```

Emoji validation is local: a single grapheme cluster (`Intl.Segmenter`, granularity
`grapheme`, exactly one segment), and the code point must be in the Extended_Pictographic
class (`/\p{Extended_Pictographic}/u`). No allowlist until P-2 shows whether Meta restricts
the set.

`logFields`: `['conversation_id', 'remove']`. Never `recipient_id`, `message_id` or the
emoji.

**Output.**
- Preview: standard `executeWrite` preview. The summary is "React ❤️ to message m_ab12… in
  conversation t_…" or "Remove the Page's reaction from …".
- Applied: `{status:'applied', outcome, journalStatus, result:{recipientId, action:'react'|'unreact', reaction?}}`.

**Graph calls.**

| Call | Body | Permission |
|---|---|---|
| POST `/{page}/messages` | `{recipient:{id}, sender_action:'react', payload:{message_id, reaction}}` | `pages_messaging` |
| POST `/{page}/messages` | `{recipient:{id}, sender_action:'unreact', payload:{message_id}}` | `pages_messaging` |
| (pre-flight, when `conversation_id` is given) GET `/{conversation}/messages?limit=10` | reuses `getConversationMessages` | as F1 |

No `messaging_type` is sent unless P-2 shows it is required. In that case use `RESPONSE`.

**Write tier and preview.** Tier `reversible`: the reaction is visible, but a later
`remove:true` undoes it. Plan-bound like send (`requirePlanId:true`), because it is
customer-visible. Plan identity params: `{recipientId, messageId, action, reaction}`.

**Outcome classification.** `classifyOutcome`: a 2xx with `recipient_id` equal to the
requested PSID is `applied`. A 2xx without `recipient_id` is `attempted` (C2, no retry). Any
error is `failed`.

**Window gating.** Until P-2, run the same `evaluateMessagingWindow` pre-flight as send.
Closed window: refuse with `messagingWindowClosedError`. Unknown window state: warn. After
P-2, relax this if Meta allows reactions outside the window. Either way, never use a tag.

**Errors.**
- Window closed (10/2018278): mapped by `isMessagingWindowError`.
- Recipient unavailable (551 / 1545041): `isRecipientUnavailableError`.
- Invalid mid: Graph 100. Hint: "message id not found for this recipient".
- Invalid emoji: Graph 100 (subcode from P-2). Hint: "Meta rejected this reaction emoji".
- Local refine failures are `invalid_arguments` before any call.

**Files.**
- api: `src/api/messaging.ts`, new `sendReaction(fbRequest, {pageId, recipientId, messageId, reaction?|remove, token?, signal?})`
  returning `{recipientId?}`, plus `classifyReactionOutcome`. Reuse `explainSendFailure`.
- tools: `src/tools/messages.ts`, new `defineTool`. Reuse `resolveSendTarget`, `windowInput`
  and `finalizeSendError`. Add `MESSAGE_ID_SHAPE` and an `emojiArg` local to the file (not
  `shared.ts`, which is a cross-package contract).
- mcp: no change. Annotations: `destructiveHint:false`, `idempotentHint:true` (re-reacting
  with the same emoji is a no-op), `openWorldHint:true`.
- tests: `src/api/messaging.test.ts` (react and unreact body shapes; ack classification),
  `src/tools/messages.test.ts` (refine XOR; grapheme validation rejects "ab" and "👍👍";
  plan-bound apply; closed window refuses; no PSID in log fields),
  `src/mcp/packages.test.ts` (snapshot), `docs/analysis/06-tool-catalog.md`.

**Effort.** S. **Codeable now:** yes, with fakes. Window gating policy is probe P-2.
**Dependencies:** shares `MESSAGE_ID_SHAPE` with F1. **Breaking:** no.

---

## F3. Attachments in Messenger replies

Checked first: outbound attachments do **not** exist today. `sendMessage` builds
`message:{text}` only. `ATTACHMENT_URL_NOTE` covers inbound attachment URLs on reads only.

**User story.** As a Page operator, I want to send a price list PDF, a product photo or a
short video in reply to a customer, from a public https URL, from a file under
`FB_MEDIA_DIR`, or from an attachment id uploaded earlier.

### F3a. `attachment` on `facebook_send_message`

**Input sketch (additive).**

```ts
attachment: z.object({
  type: z.enum(['image', 'audio', 'video', 'file']).describe('Attachment kind as Messenger renders it.'),
  url: z.string().url().max(2048).optional().describe('Public https URL Meta fetches (no credentials). Images ≤ 8 MB.'),
  path: z.string().max(1024).optional().describe('File under FB_MEDIA_DIR, uploaded as multipart. ≤ 25 MB.'),
  attachment_id: z.string().regex(/^\d{1,32}$/).optional().describe('Reusable id from facebook_upload_message_attachment (expires after 90 days).'),
}).strict()
  .refine(a => [a.url, a.path, a.attachment_id].filter(Boolean).length === 1, 'Pass exactly one of url, path or attachment_id')
  .optional()
  .describe('One attachment. Cannot be combined with message text in the same call (Meta rule).'),
```

`message` becomes optional, and the top-level refine requires exactly one of `message` or
`attachment` (**XOR per call**, V7). Rationale: sending text and a file as two Graph calls
creates a partial outcome (text sent, file failed) that plan and apply cannot retry safely
(C2). The agent makes two calls, each with its own plan, if it wants both.

Multi-image (`attachments[]`, up to 30 images, V6) is **not** proposed for 2.0. It is a
later additive extension (`attachments: z.array(...).max(30)` restricted to `type:'image'`).

**Source resolution (tools → api).**
- `url`: `resolveRemoteMediaUrl` (https only, no userinfo, no private hosts as today).
  Sends `payload:{url, is_reusable:false}`.
- `path`: `resolveLocalMediaPath` (realpath containment in `FB_MEDIA_DIR`), then the size
  check (≤ 25 MB = `DEFAULT_MAX_LOCAL_BYTES`), then a multipart POST to `/{page}/messages`
  with parts `recipient` (JSON), `messaging_type`, `message` (JSON
  `{attachment:{type,payload:{is_reusable:false}}}`) and `filedata` (file, filename via
  `multipartFilename`). Content-type is detected by `detectPhotoContentType` for images and by
  extension otherwise.
- `attachment_id`: `payload:{attachment_id}`.

**Output.** Applied `result: {messageId?, recipientId?, attachmentType}`. Journal metadata
adds `{attachmentType, attachmentSource:'url'|'path'|'id', bytes?}`, never the URL, path or
id.

**Graph calls.**

| Call | Body | Permission |
|---|---|---|
| POST `/{page}/messages` (JSON) | `{recipient, messaging_type:'RESPONSE', message:{attachment:{type,payload:{url}\|{attachment_id}}}}` | `pages_messaging` |
| POST `/{page}/messages` (multipart, `protocol:'multipart'`) | `recipient`, `messaging_type`, `message`, `filedata` | `pages_messaging` |

**Write tier and preview.** Reversible, plan-bound (unchanged). Plan identity params add
`attachment: {type, source, url?, pathDigest?, attachmentId?}`. For `path`, the plan binds a
SHA-256 of the file contents, computed in core by a new helper. At apply time a changed file
gives `diverged` (readState/stateWarnings), so the preview the human approved is the file
that gets sent. Preview content: "Send a <type> attachment (<source>, <size> MB, <filename
for path>) to …". Warnings: "URL fetch timeout is 10 s (75 s for video); slow hosts fail".

**Errors.**
- `MediaSourceError` (outside `FB_MEDIA_DIR`, symlink escape, not https, too large):
  `invalid_arguments` before any call.
- 100/2018074 (invalid or foreign attachment id): "attachment id is invalid, expired (90
  days) or belongs to another Page".
- URL fetch failure (Graph 100, subcode 2018047 or similar, to be confirmed): "Meta could not
  fetch the URL".
- Window or recipient errors: unchanged.
- Multipart timeout after the upload completed: `attempted` (C2).

### F3b. `facebook_upload_message_attachment` (optional, in `messages`)

**User story.** Upload a brochure once, then send it to many customers by id without
re-uploading.

**Input.** `{...writeArgs, type, url? | path?}` (same XOR refine as above, minus
`attachment_id`).

**Graph call.** POST `/{page}/message_attachments`, either JSON
`{message:{attachment:{type,payload:{url,is_reusable:true}}}}` or multipart `message` plus
`filedata`. Returns `{attachment_id}`. Permission `pages_messaging`.

**Tier.** `reversible`. Nothing is customer-visible and the id expires by itself. Not
plan-bound. The package default `plan` still yields a preview first.

**Output.** `{attachmentId, type, expiresAt}`, where `expiresAt` is upload time plus 90 days
(computed with the injected clock and labelled as an estimate). No local cache in 2.0. The id
appears in the tool result and the journal. A local registry can be added later on top of
F10's store module if needed.

**Files (F3a and F3b).**
- api: `src/api/messaging.ts`. `sendMessage` takes `content: {text} | {attachment: OutboundAttachment}`
  (a discriminated union, with the internal signature change confined to the api layer). New
  `uploadMessageAttachment`. Reuse `src/api/media-photos.ts` helpers. If a generic
  `detectMediaContentType` is needed, add it to `media-photos.ts` (or rename it to
  `media-source.ts` in a separate refactor commit).
- core: `src/core/http-upload.ts` should need no change if P-3 confirms the part layout. A new
  `sha256File(path)` helper goes to core (next to `http-upload.ts`, or in a new
  `src/core/file-digest.ts`).
- tools: `src/tools/messages.ts`. New args, XOR refine, source resolution, preview text, new
  tool for F3b.
- tests: `src/api/messaging.test.ts` (JSON vs multipart body; `is_reusable` flag; 2018074
  mapping), `src/tools/messages.test.ts` (XOR; containment refusals; digest divergence between
  plan and apply; no URL or path in journal), `src/core/http-upload.test.ts` (if the part
  layout changes), snapshot plus doc 06.

**Effort.** M. **Codeable now:** URL and `attachment_id` sources, yes. The local `path`
upload needs P-3. **Dependencies:** none (F4 and F8 reuse the attachment arg).
**Breaking:** no. `message` becomes optional but stays accepted.

---

## F4. Private reply improvements

**User story.** As a Page operator, I want to privately answer a visitor who posted *on* my
Page (a visitor post, not a comment), and to include a file, such as a menu PDF, in the
private reply.

**Tool.** `facebook_private_reply` (extended). The P6 rename to `facebook_send_private_reply`
is tracked separately in the contract audit and is orthogonal.

**Input sketch (additive).**

```ts
comment_id: commentIdArg.optional(),          // today: required
post_id: graphNodeIdArg.optional().describe('Visitor post id (pageid_postid) to answer privately. Use instead of comment_id.'),
attachment: outboundAttachmentArg.optional(), // shared with F3; url | attachment_id only (no path in 2.0)
// refine: exactly one of comment_id/post_id; exactly one of message/attachment
```

**Graph calls.**

| Call | Body | Permission |
|---|---|---|
| GET `/{post}?fields=id,created_time,from{id},can_reply_privately` (pre-flight) | — | `pages_read_engagement` |
| POST `/{page}/messages` | `{recipient:{post_id}, message:{text}\|{attachment}}` | `pages_messaging` + MESSAGING task |

**Pre-flight (mirrors the existing comment path).** `privateReplyWindow` generalised to
`created_time` of the post. Refuse if the post is older than 7 days, if `from.id === pageId`
(the Page's own post), or if `can_reply_privately === false`. Unknown values give a warning
only.

**One-shot rule (V10).** Meta allows one private reply per comment or post. A local
pre-flight reads the journal (`memoryJournal` in tests, NDJSON at runtime) for an earlier
`applied` or `attempted` private reply to the same `comment_id`/`post_id`. If one is found,
refuse with "a private reply was already sent (or attempted) on <date>; Meta allows one". An
override flag `allow_repeat: true` lets the call proceed if the earlier entry was only
`attempted`. Journal access goes through the existing `readState` hook, not a new import
path.

**Tier.** Stays `irreversible` (apply plus `plan_id`). The preview adds the target kind
(comment or visitor post) and the attachment description.

**Errors.**
- 10/2018108 (or the existing mapped code), "already replied": the existing
  `classifyPrivateReplyFailure` gains this case.
- Post window expired: local refusal.
- 100/2018074 for the attachment id (as in F3).

**Files.**
- api: `src/api/comments.ts`. `sendPrivateReply` recipient becomes `{commentId}|{postId}` and
  content becomes `{text}|{attachment}`. `privateReplyWindow` takes `createdTime`.
- tools: `src/tools/moderation.ts`. Args, refine, post pre-flight, journal one-shot check.
- tests: `src/api/comments.test.ts`, `src/tools/moderation.test.ts` (post_id path; own-post
  refusal; repeat refusal from the journal; `allow_repeat` only after `attempted`).

**Effort.** S–M. **Codeable now:** `post_id` and the one-shot rule, yes. The attachment in a
private reply needs P-4. **Dependencies:** F3 (attachment arg type). **Breaking:** no.
`comment_id` becomes optional, but every v1.x call stays valid.

---

## F5. `notes[]` instead of the joined `note` (audit F16)

**User story.** As an agent, I want each advisory note as its own array element, so I can
branch on a specific note without splitting prose.

**Change.** Every read that builds `notes: string[]` and then `.join(' ')`s it into `note`
(`facebook_list_comments` around lines 818–836 of `src/tools/moderation.ts`; check
`list_conversations` and `get_conversation` for `POLLING_NOTE` and `ATTACHMENT_URL_NOTE`)
returns `notes: string[]`.

Optionally each note gets a stable code: `notes: {code: string, text: string}[]`, with codes
such as `empty_page_token`, `polling`, `attachment_urls_expire` and `truncated`. Recommended:
plain `string[]` in v1.x. Decide on codes only if the P7 array work in the contract audit
wants them across all packages.

**Migration.**
- v1.x (additive): emit both `notes` and `note` (joined), and mark `note` deprecated in the
  catalog.
- 2.0 (breaking): drop `note`. Record it in the changelog and the 2.0 migration notes.

**Files.** `src/tools/moderation.ts`, `src/tools/messages.ts`, any shared shaping helper (if
one is added, it goes to `src/tools/shared.ts` and counts as a cross-package contract change),
the matching tests, and doc 06.

**Effort.** S. **Codeable now:** yes. **Dependencies:** none. **Breaking:** yes in 2.0
(removal of `note`), additive before that.

---

## F6. Bulk comment triage (`facebook_triage_comments`)

**User story.** As a Page operator, I want one call that lists comments on my recent posts
that the Page has not answered yet, optionally filtered by keyword, so the agent can work
through a moderation queue instead of opening each post.

**Overlap.** Backlog O2 (`facebook_get_activity_since`) proposes a cross-object activity
digest. F6 is the moderation-specific queue with filters. Recommendation: F6 owns comment
scanning in `src/api/comments.ts` (`scanRecentComments`), and O2 calls into it, so the scan
logic exists once.

**Tool.** `facebook_triage_comments` in the `moderation` package (read).

**Input sketch.**

```ts
z.object({
  ...profileArg, page: pageArg,
  posts: z.number().int().min(1).max(25).default(10).describe('How many most recent Page posts to scan.'),
  since: z.string().datetime().optional().describe('Only comments created at or after this ISO time (filtered locally).'),
  status: z.enum(['unanswered', 'all', 'hidden']).default('unanswered')
    .describe('unanswered: no reply from the Page in the thread. hidden: is_hidden=true.'),
  keywords: z.array(z.string().min(1).max(64)).max(20).optional()
    .describe('Case-insensitive substring match on the comment text (local; any keyword matches).'),
  include_replies: z.boolean().default(false).describe('Also consider reply-level comments (filter=stream).'),
  max_comments: z.number().int().min(1).max(200).default(100).describe('Stop after this many matches.'),
}).strict()
```

No regex input, to avoid ReDoS on untrusted text. Keywords are matched with
`toLocaleLowerCase` and `includes` after NFKC normalisation.

**Output.**

```ts
{
  pageId, scannedPosts: number, scannedComments: number, truncated: boolean,
  items: Array<{
    commentId, postId, createdTime, isHidden, likeCount, commentCount,
    from: tainted({id, name}), text: tainted(snippet≤280), matchedKeywords: string[],
    pageReplied: boolean, canReplyPrivately: boolean | null,
  }>,
  notes: string[],   // F5 shape; e.g. "scan capped at 25 posts", "reply scan skipped for N threads"
}
```

`matchedKeywords` echoes the operator's keywords, not user text, so it is not tainted.

**Graph calls (all GET, Page token, `pages_read_engagement` + MODERATE task).**
1. `/{page}/published_posts?fields=id,created_time&limit={posts}`.
2. For each post: `/{post}/comments?filter={toplevel|stream}&fields=COMMENT_FIELDS&limit=100`,
   following `paging.next` until `since` is passed or the cap is hit.
3. For `status:'unanswered'`: for each top-level comment with `comment_count > 0`,
   `/{comment}/comments?fields=from{id}&limit=25` and check `from.id === pageId`. A comment
   with `comment_count === 0` is unanswered without a call. Reply scans are bounded by a
   budget (`MAX_REPLY_SCANS = 100`). Over budget, `pageReplied` is `null` with a note.

Calls run through `sweepFbRequest` with concurrency 4, and the `pageTokenFence` is reused.
An empty-token result gives `EMPTY_PAGE_TOKEN_HINT` as a note.

**Tier.** Read. No `executeWrite`.

**Errors.**
- A per-post failure does not fail the call. It goes into
  `notes: ["post <id>: <graph error summary>"]` and `truncated: true`.
- Permission (10 or 200): the whole call fails with the existing permission hint.
- Rate limit (4/17/32/613): stop the scan, return partial results with `truncated:true` and
  the note "rate limited; partial results".

**Files.**
- api: `src/api/comments.ts`. New `scanRecentComments(fbRequest, opts)` returning shaped,
  untainted records plus scan stats. Keyword matching lives in tools (it is policy, not
  shaping), or api exposes a pure `matchKeywords` helper. Recommended: tools.
- tools: `src/tools/moderation.ts`. New `defineTool`, taint wrapping, keyword filter, output.
- tests: `src/api/comments.test.ts` (paging stops at `since`; reply-scan budget; zero-reply
  shortcut), `src/tools/moderation.test.ts` (unanswered detection with a Page reply present;
  keyword NFKC case-folding; text tainted; partial failure becomes a note), fixture
  `test/fixtures/graph-post-comments.json` (synthetic), snapshot plus doc 06.

**Effort.** M. **Codeable now:** yes. **Dependencies:** F5 (notes shape). O2 should consume
it. **Breaking:** no.

---

## F7. Reply and hide in one call (`facebook_reply_and_hide_comment`)

**User story.** As a Page operator dealing with spam or abuse, I want to post a short public
reply (for example "We've sent you a DM") and hide the original comment in one approved
step.

**Order.** Reply first, then hide the **parent** comment. Replying to a hidden comment works,
but a reply posted after the hide may be less visible. Doing the reply first also means that
if the reply fails, nothing is hidden.

**Input sketch.**

```ts
z.object({
  ...writeArgs,
  comment_id: commentIdArg,
  message: messageArg,                 // ≤ 8000
  attachment: commentAttachmentArg.optional(),  // from F8
}).strict()
```

**Graph calls.**

| Step | Call | Permission |
|---|---|---|
| read state | `readCommentStates([comment_id])` (fingerprint: is_hidden, message hash) | `pages_read_engagement` |
| 1 | POST `/{comment}/comments` `{message}` → `{id}` | `pages_manage_engagement` / MODERATE |
| 2 | POST `/{comment}` `{is_hidden:true}` → `{success}` | `pages_manage_engagement` / MODERATE |

**Tier and preview.** `reversible`. Both steps can be undone: delete the reply, unhide the
comment. The `moderation` package default is `apply`, but because the reply is a public write
the tool sets `requirePlanId:true`, matching `send_message`. Preview: "Reply publicly to
comment <id> (N chars), then hide comment <id>". The state fingerprint goes into the plan, so
an edited or already-hidden comment at apply time gives `diverged`. If the comment is already
hidden, the preview warns "already hidden; only the reply will be posted" and step 2 is
skipped.

**Outcome.** Per-step outcomes, as in the bulk verbs (CC-MOD-5):
`result: {reply:{outcome, replyId?}, hide:{outcome}}`.
- Top-level `outcome`: `applied` if both steps are applied, `failed` if step 1 failed (step 2
  is not attempted), `attempted` otherwise.
- If step 2 fails after step 1 is applied, the result names the follow-up:
  `nextStep: "facebook_hide_comment {comment_id}"`.
- There is no automatic retry of either step (C2).

**Errors.** Comment gone (100/33): `failed` at step 1. Permission errors: existing mapping.

**Files.**
- api: `src/api/comments.ts`. No new Graph function; this composes `replyToComment` and
  `setCommentHidden`. Optionally add `replyAndHide` to keep the ordering logic out of tools.
  Recommended: api, since it is call sequencing rather than policy.
- tools: `src/tools/moderation.ts`. New tool and a `TIERS` entry.
- tests: both test files (order; skip hide when already hidden; step-2 failure gives
  `attempted` plus `nextStep`; divergence), snapshot plus doc 06.

**Effort.** S–M. **Codeable now:** yes. **Dependencies:** F8 if the attachment is included.
**Breaking:** no.

---

## F8. Comment replies with attachments, and editing the Page's own comment

### F8a. `attachment` on `facebook_reply_to_comment`

**Input sketch (additive).**

```ts
attachment: z.object({
  kind: z.enum(['image_url', 'gif_url', 'photo_path']).describe('image_url → attachment_url, gif_url → attachment_share_url, photo_path → multipart source under FB_MEDIA_DIR.'),
  url: z.string().url().max(2048).optional(),
  path: z.string().max(1024).optional(),
}).strict().refine(...exactly one of url/path matching kind...).optional()
// message becomes optional; refine: at least one of message/attachment (V14)
```

Unlike Messenger, a comment can carry text **and** an attachment together.

**Graph call.** POST `/{object}/comments` with `message?` plus `attachment_url` |
`attachment_share_url` | multipart `source`. Returns `{id}`. Needs `pages_manage_engagement`.

**Files.** `src/api/comments.ts` (`replyToComment` content union; the multipart path reuses
`readLocalPhoto` and `http-upload`), `src/tools/moderation.ts`, plus tests.

### F8b. `facebook_edit_comment` (new, `moderation`)

**User story.** Fix a typo in a reply the Page already posted.

**Input.** `{...writeArgs, comment_id, message}`.

**Graph calls.**
1. Pre-flight GET `/{comment}?fields=from{id},message`. Refuse if `from.id !== pageId`
   ("only the Page's own comments can be edited").
2. POST `/{comment}` `{message}` → `{success:true}`.

**Tier.** `reversible`: the old text is kept in the plan or journal, so it can be restored.
Store a hash in metadata, plus the old text in the preview only. Preview: a before and after
diff (both tainted, truncated to 500 chars). The fingerprint (message hash) binds the plan,
so a concurrent edit gives `diverged`.

**Errors.** Not own comment: local refusal. Graph 100/33: comment gone.

**Effort.** S for both. **Codeable now:** yes. **Dependencies:** none. **Breaking:** no.
`message` on `reply_to_comment` becomes optional, but text-only calls are unchanged.

---

## F9. Like or unlike comments as the Page (`facebook_like_comment`)

**User story.** As a Page operator, I want to like positive comments as the Page, in bulk,
as a lightweight acknowledgement.

**Tool.** `facebook_like_comment` in `moderation`. It is a bulk verb, consistent with
hide/delete.

**Input sketch.**

```ts
z.object({
  ...writeArgs,
  comment_ids: commentIdsArg,    // 1–50 (MAX_BULK_IDS)
  unlike: z.boolean().default(false).describe('true removes the Page\'s like.'),
}).strict()
```

**Graph calls.**

| Call | Permission |
|---|---|
| read state: `readCommentStates` extended with `user_likes` | `pages_read_engagement` |
| POST `/{comment}/likes` → `{success:true}` | `pages_manage_engagement` + CREATE_CONTENT task |
| DELETE `/{comment}/likes` → `{success:true}` | MODERATE task |

**Tier and preview.** `reversible`, not plan-bound (package default `apply`, the same
handling as hide). Preview: "Like N comments as the Page (M already liked, skipped)".
Comments with `user_likes === true` (for like) or `false` (for unlike) are reported as
`skipped: already_in_state` and not called, so the call is idempotent by design.

**Outcome.** `runBulk` / `tallyBulk` per-id outcomes. `{success:true}` is `applied`. A 2xx
without `success` is `attempted`.

**Errors.**
- Duplicate like (error code from P-5): mapped to `applied` with a note, never `failed`.
- Object cannot be liked (100): `failed` per id.
- Permission: whole-call failure via the existing mapping.

**Files.** `src/api/comments.ts` (`setCommentLiked`; `COMMENT_FIELDS` or the state fields add
`user_likes`), `src/tools/moderation.ts` (tool and `TIERS`), both test files, snapshot plus
doc 06. Optionally surface `pageLiked` (`user_likes`) in `list_comments` and `get_comment`
too.

**Effort.** S. **Codeable now:** yes, except for the duplicate-like code (P-5).
**Dependencies:** none. **Breaking:** no.

---

## F10. Local saved replies (no Graph calls)

**Is it useful?** Yes, but narrowly. Agents tend to re-generate the same policy answers
("shipping takes 3–5 days", "please DM us your order number") slightly differently each time.
A local, operator-curated set gives consistent wording and lets the human pre-approve text.
Meta's own Saved Replies API (`/{page}/saved_message_responses`) is not used: it is
undocumented for v26 and Business Suite-only. Purely local storage needs no permission.

**Tools (package `messages`, since it is shared by moderation; or a tiny new package
`replies` that is on by default; recommended: `messages`).**
- `facebook_list_saved_replies {profile?, tag?}` returns `{items:[{id, title, text, tags, updatedAt}]}`.
  The text is operator-authored, so it is **not** tainted. It is still shown in a fenced block.
- `facebook_save_reply {id?, title, text, tags?}` upserts. `id` is a slug
  `^[a-z0-9][a-z0-9-]{0,47}$` and is generated from the title if omitted.
- `facebook_delete_saved_reply {id}`.
- On `facebook_send_message`, `facebook_reply_to_comment` and `facebook_private_reply`: an
  optional `saved_reply_id` (XOR with `message`). The resolved text goes into the plan's
  `params`, so editing the template after the preview gives `diverged`.

**Placeholders.** Support only `{{page_name}}`, filled from the resolved Page, which is
trusted. **No** auto-fill from user data (commenter name and so on). The agent writes those
itself, so tainted data never flows silently into an outbound message. An unknown
`{{...}}` placeholder is an error at save time.

**Storage (core).**
- New `src/core/saved-replies.ts`: `loadSavedReplies(path)` and `writeSavedReplies(path, data)`,
  with atomic temp file plus rename, mode 0600, and a schema version field `{version:1, profiles:{[profile]: Reply[]}}`.
- Path: `savedRepliesPath()` in `src/core/config.ts` gives `configDir()/saved-replies.json`.
  It sits in config, not state, because it is operator-curated.
- Limits: 200 replies per profile, text ≤ 2000 chars (the Messenger cap).

**Tier.** These are local writes. `save` and `delete` use a new `writeTier: 'local'` if the
registry supports it. If not, the tools are marked `reversible` and bypass `executeWrite` with
`readOnlyHint:false` and `destructiveHint:false`. This is a decision for the registry owner:
adding a tier touches `src/mcp/define.ts` and the write-mode logic. **Recommended:** no new
tier. Save and delete apply directly (local, user-owned data). `delete` returns the deleted
record so it can be re-saved.

**Errors.** Corrupt JSON gives a `config_error` naming the file, and the file is never
overwritten silently. Duplicate `id` on create without `overwrite:true` is a conflict error.

**Files.**
- core: `src/core/saved-replies.ts` plus a test, `src/core/config.ts` (path) plus
  `config.test.ts`.
- api: none.
- mcp: possibly `define.ts` if a `local` tier is chosen.
- tools: `src/tools/messages.ts` (3 tools; `saved_reply_id` on send),
  `src/tools/moderation.ts` (`saved_reply_id` on reply and private reply).
- tests: tool tests with a temp XDG dir (`PathOptions` injection), snapshot plus doc 06.

**Effort.** M. **Codeable now:** yes. **Dependencies:** none. **Breaking:** no.

---

## F11. Custom labels on conversations

**User story.** As a Page operator, I want the agent to tag a customer's thread ("vip",
"refund-pending") so it shows up in the Page inbox label view and can be listed later.

**Tools (package `messages`).**
- `facebook_list_labels {profile?, page?, psid?}` (read). Without `psid`, it lists the Page's
  labels via GET `/{page}/custom_labels?fields=id,page_label_name`. With `psid`, it lists the
  labels on that person via GET `/{psid}/custom_labels?fields=id,page_label_name`.
- `facebook_manage_label` (write), with a discriminated union:

```ts
z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), name: z.string().min(1).max(64) }),
  z.object({ action: z.literal('assign'), label_id: graphNodeIdArg, psid: psidArg }),
  z.object({ action: z.literal('unassign'), label_id: graphNodeIdArg, psid: psidArg }),
  z.object({ action: z.literal('delete'), label_id: graphNodeIdArg }),
]).and(z.object({ ...writeArgs }).strict())
```

(If the registry cannot express a union input in its JSON Schema export, split into
`facebook_create_label`, `facebook_assign_label` and `facebook_delete_label` instead.)

**Graph calls.**

| Action | Call | Returns |
|---|---|---|
| create | POST `/{page}/custom_labels` `page_label_name` | `{id}` |
| assign | POST `/{label}/label` `user=<psid>` | `{success}` |
| unassign | DELETE `/{label}/label` `user=<psid>` | `{success}` |
| delete | DELETE `/{label}` | `{success}` |

Permissions per doc: `pages_manage_metadata`, `pages_show_list` (plus the questionable
`pages_me`) and the MESSAGING task. **P-6** confirms this. Page Contact Terms must be accepted.

**Tier.** create, assign and unassign are `reversible`. delete is `irreversible`
(`confirmableWriteArgs`: apply plus `plan_id` plus `confirm_token`), because it removes the
label from every person it was assigned to. Preview content names the label (the name is
operator content and is fetched for assign and unassign so the preview shows it) and a
recipient count for delete, when cheaply available.

**Privacy.** PSIDs never appear in `logFields`. The journal stores `{action, labelId}` only.

**Errors.** Contact Terms not accepted (code from P-6): "accept Page Contact Terms in Meta
Business Suite". Phone-number accounts: the read returns an error, and it is mapped to a note.

**Files.** New `src/api/labels.ts` plus a test. `src/tools/messages.ts` (or a new
`src/tools/labels.ts` registered in `src/tools/index.ts`, if `messages.ts` gets too large; it
is at 867 lines already, so a separate file is recommended, still in the `messages` package).
Snapshot plus doc 06.

**Effort.** M. **Codeable now:** yes with fakes. The scope and error codes need P-6.
**Dependencies:** none. **Breaking:** no.

---

## F12. Page moderation settings (blocked words, profanity filter)

**User story.** As a Page operator, I want the agent to read and update the Page's blocked
keyword list and profanity filter, so recurring spam terms are auto-hidden by Meta instead of
handled comment by comment.

**Tools (package `moderation`).**
- `facebook_get_moderation_settings {profile?, page?}` (read) returns
  `{blockedWords: string[], profanityFilter: 'OFF'|'MEDIUM'|'STRONG'|null, usersCanMessage: boolean|null}`.
- `facebook_set_moderation_settings`:

```ts
z.object({
  ...writeArgs,
  blocked_words: z.object({
    add: z.array(z.string().min(1).max(80)).max(100).optional(),
    remove: z.array(z.string().min(1).max(80)).max(100).optional(),
  }).strict().optional().describe('Delta against the current list; the tool computes and writes the full list.'),
  profanity_filter: z.enum(['OFF', 'MEDIUM', 'STRONG']).optional(),
}).strict().refine(a => a.blocked_words || a.profanity_filter, 'Nothing to change')
```

Delta input, not full replacement, so a model cannot wipe the list by accident. Words cannot
contain commas, since Meta's format is comma-separated. Words are trimmed and deduplicated
case-insensitively.

**Graph calls.**

| Call | Body | Permission |
|---|---|---|
| GET `/{page}/settings` | — | Page token (`pages_manage_metadata`?, **P-7**) |
| POST `/{page}/settings` | `option={"PAGE_MODERATION_BLACKLIST":"w1,w2,..."}` | same |
| POST `/{page}/settings` | `option={"PROFANITY_FILTER":"STRONG"}` | same |

One option per POST (V16). Changing both settings means two POSTs, with per-step outcomes as
in F7.

**Tier and preview.** `reversible`. The before state is in the preview and the journal, so
restore is possible. `readState` fingerprints the current list (hash of the sorted words) and
filter value. A change between plan and apply gives `diverged` and no write, because a
full-list write would otherwise clobber a human's concurrent edit. Preview: "Blocked words:
+3 (…), −1 (…), resulting list 42 words. Profanity filter MEDIUM → STRONG". The preview also
warns that blocked words hide matching comments automatically and that this applies Page-wide.

**Errors.** NPE write unsupported (P-7, likely Graph 100 or 200): "this Page type does not
allow changing this setting via the API; use Meta Business Suite". The step outcome is
`failed`, and for a multi-step change the earlier step is reported as applied.

**Files.** New `src/api/page-settings.ts` plus a test (parse `data[].{setting,value}` into the
typed shape; build the option bodies). `src/tools/moderation.ts` (2 tools plus `TIERS`).
Snapshot plus doc 06.

**Effort.** M. **Codeable now:** read and the full write path with fakes, yes. Shipping the
write needs P-7. **Dependencies:** none. **Breaking:** no.

---

## F13. Find a conversation by PSID

**User story.** As an agent handed a PSID (from a comment's `from.id` after a private reply,
or from a label listing), I want the conversation id without paging the whole inbox.

**Change.** `facebook_list_conversations` gains
`user_id: psidArg.optional().describe('Return only the conversation with this person.')`.
That becomes GET `/{page}/conversations?platform=messenger&user_id=<psid>&fields=CONVERSATION_FIELDS`
(V11). `user_id` is excluded from `logFields`.

**Files.** `src/api/messaging.ts` (`listConversations` option), `src/tools/messages.ts`, both
tests.

**Effort.** S. **Codeable now:** yes. **Dependencies:** none. **Breaking:** no.

---

## D. Dropped or not proposed

| Item | Reason |
|---|---|
| `HUMAN_AGENT` tag, any `MESSAGE_TAG` send, `UPDATE` messaging type | Owner constraint: no messaging outside the 24h window. `messaging_type` stays `RESPONSE` |
| `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE`, `POST_PURCHASE_UPDATE` | Removed: error 100 since 2026-04-27 (V17) |
| Moderate Conversations API (block/spam/move threads) for Messenger | Documented for Instagram only. The Messenger reference 404s (V18). Revisit in the Instagram package spec |
| `mark_seen` sender action | Rejected on purpose in v1 (G-TOOL-4): a read tool must not change the customer's view |
| `typing_on` / `typing_off` | Possible, but no value for a non-realtime agent. A typing indicator followed by a plan approval delay is misleading |
| Utility / marketing message templates, recurring notifications | Need template approval and eligibility, and cover out-of-window use cases the owner excluded |
| Meta-hosted saved replies (`saved_message_responses`) | Not documented for v26 Graph. F10 is local instead |
| `WALL_COMBINED_POSTS` setting | Deprecated (V16) |
| Comment `order`/`since` server params in F6 | `order` is not a documented request param and `since` is undocumented (V15). F6 filters locally |
| Regex keyword filter in F6 | ReDoS risk on untrusted text. Substring keywords only |
