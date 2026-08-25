# Runbook: operator window — live QA for the unverifiable tools

Three write tools cannot be exercised by the automated smoke suite, because each
one needs a **second real human** on the other side and each one is visible to
that person the moment it succeeds:

| Tool                     | Why the smoke suite cannot cover it                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `facebook_send_message`  | Needs an open 24-hour standard messaging window, which only the other person can open by messaging the Page.   |
| `facebook_private_reply` | Needs a real comment from someone who is not the Page, and there is exactly **one** attempt per comment, ever. |
| `facebook_block_user`    | Needs a real PSID; the effect lands on a real account's ability to comment and message.                        |

An **operator window** is a short, scheduled, manually-driven session in which a
human operator and a consenting helper account exercise these three tools once,
on a dedicated test Page, and record the observed behaviour. It is the substitute
for automated coverage, not an addition to it — see the Phase 3 exit gate in
[`../analysis/08-roadmap.md`](../analysis/08-roadmap.md) and
[`../analysis/10-v1-release-definition.md`](../analysis/10-v1-release-definition.md).

## When to use this

- You are closing the Phase 3 exit gate before a release, and the three tools
  above are still marked live-unverifiable.
- You changed anything in `src/api/messaging.ts`, `src/tools/messages.ts`, the
  private-reply path in `src/tools/moderation.ts`, or the block/unblock path, and
  need to confirm the change against the real Graph API.
- Meta announced a change to the messaging windows, the private-reply rules, or
  the blocked-users endpoint, and you need to know whether the shipped guard
  rails still match reality.

Do **not** run an operator window on a Page with real followers, and do not run
it against a person who has not agreed in advance to be messaged and blocked.

---

## Prerequisites

1. **A dedicated test Page** — no real audience, and one you are willing to leave
   with visible artefacts (a comment thread, an inbox conversation). Same Page as
   the one used by `scripts/smoke/`.
2. **A helper account** — a second Facebook account, belonging to a person who has
   explicitly agreed to receive a private message from the Page and to be blocked
   and then unblocked. The helper must not be an admin of the test Page, because a
   Page role changes both the messaging behaviour and the blocked list.
3. **A Page token with the right scopes and tasks:**
   - `pages_messaging` + the `MESSAGING` task — `facebook_send_message`,
     `facebook_private_reply`.
   - `pages_manage_engagement` + the `MODERATE` task — `facebook_block_user`,
     `facebook_unblock_user`.
   - `pages_read_engagement` / `pages_read_user_content` for the reads used to
     verify each step.
4. **A clean journal position.** Note the current end of the journal so the
   window's entries are easy to isolate afterwards:

   ```sh
   wc -l "${FB_JOURNAL_PATH:-$HOME/.local/state/facebook-mcp/journal.ndjson}"
   ```

   On Windows the default is `%LOCALAPPDATA%\facebook-mcp\journal.ndjson`.
5. **Plan-first for the whole window.** Set the mode explicitly, in the client's
   env block for this session only:

   ```sh
   FB_WRITE_MODE=plan
   ```

   An explicit `FB_WRITE_MODE` wins outright over every package default, which
   matters here: the `moderation` package ships `writeModeDefault: apply`, so
   without this line `facebook_block_user` would fire on the first call. With it,
   every one of the three tools previews first and needs `apply: true` plus the
   `plan_id` from that preview.

**Verify by:** `facebook_whoami` reports the test Page, and its `writeMode` is
`plan`.

---

## Step 1 — Open the messaging window (helper acts)

The 24-hour standard messaging window can only be opened from the other side.

1. The helper opens the test Page in Messenger and sends it any message.
2. Note the wall-clock time. Everything in Step 2 must happen inside 24 hours of
   this message, and the window is measured from the **last inbound** message, not
   from the first.
3. Call `facebook_list_conversations` and find the thread. Record its
   `conversation_id`.
4. Call `facebook_get_conversation` on it and read the reported window verdict.

**Verify by:** `facebook_get_conversation` reports the window as open, with an
explanation naming the last inbound message's timestamp. If it reports `closed`,
the helper's message did not land on this Page — do not continue; nothing in
Step 2 can succeed.

---

## Step 2 — `facebook_send_message`

1. Call `facebook_send_message` with the `conversation_id` from Step 1 and a short
   message that identifies itself as a test. Do **not** pass `apply`.
2. Read the preview. It must contain: the recipient PSID, the character count, the
   private-message visibility warning, the lost-response warning, and the
   `notPerformedNotice` stating that nothing was sent.
3. Confirm with the helper that they received **nothing**.
4. Re-call with `apply: true` and the `plan_id` from the preview.
5. Ask the helper to confirm the message arrived, and read the thread back with
   `facebook_get_conversation`.

**Verify by:** the applied call returns `delivery: "sent"` with a message id, the
helper sees exactly one message, and the journal has exactly **one** entry for
`facebook_send_message` with `outcome: "applied"` — the dry run must not have
produced a journal entry with a delivery outcome.

> If the call fails ambiguously (timeout, socket reset, 5xx), the journal records
> `outcome: "attempted"`, not `failed`. That is correct and is the behaviour under
> test: **do not resend.** Verify with `facebook_get_conversation` first, and
> record which of the two states you observed.

---

## Step 3 — `facebook_private_reply`

This is the one step in the window that cannot be repeated on the same target.
Each comment allows exactly one private reply, forever.

1. The helper comments on any post on the test Page. Use a **fresh** comment — one
   whose single private reply has never been spent.
2. Call `facebook_list_comments` on that post and record the comment id.
3. Call `facebook_private_reply` with that comment id and a short message. Do
   **not** pass `apply`.
4. Read the preview. It must state that this consumes the single allowed reply,
   and it must name the ISO timestamp at which the 7-day window closes. If
   Facebook reports `can_reply_privately=false`, the preview carries that as an
   extra warning — the tool surfaces it but does not refuse on it, because the
   flag is advisory. If you see that warning, expect the apply to fail, and treat
   the failure as the expected outcome rather than a defect.
5. Apply with `apply: true` and the `plan_id`.
6. Ask the helper whether the private reply arrived in their Messenger inbox.

**Verify by:** the helper receives the private message, and the journal entry for
`facebook_private_reply` records `commentId`, `messageChars` and `commentAgeMs` —
and **not** the message text.

Also confirm the two client-side refusals, each on a comment you do not mind
burning nothing on (neither of these sends anything):

- A comment older than 7 days is refused **before** any send, with a
  `window_closed` refusal.
- A comment whose creation time cannot be read is refused as `unknown_age`.

---

## Step 4 — `facebook_block_user` and the way back

Block last, because a blocked helper can no longer comment or message, which
would invalidate Steps 1–3 if you needed to repeat them.

1. Take the helper's PSID from the conversation in Step 1. A PSID is
   Page-scoped — it is not the helper's Facebook user id, and it is only valid for
   this Page.
2. Call `facebook_block_user` with that single PSID and no `apply`. Read the
   preview: one outcome per PSID, and the statement that blocking is reversible
   with `facebook_unblock_user`.
3. Apply. Confirm with the helper that they can no longer comment on the Page or
   send it a message.
4. Call `facebook_block_user` again with the same PSID and `apply`. Blocking an
   already-blocked user is a no-op — this is the idempotence claim in the tool's
   description, and it is under test.
5. Call `facebook_unblock_user` with the same PSID and `apply`.
6. Call `facebook_unblock_user` a **second** time, on a PSID that was never
   blocked. This must be reported as done, not as an error.

**Verify by:** the helper can comment and message again after Step 4.5, and each
of the four calls produced its own journal entry with one outcome per PSID.

> **Leave nobody blocked.** The window is not finished until the helper is
> unblocked and has confirmed it. If you abandon the window part-way through,
> unblocking is the one step you must still perform.

---

## Step 5 — Record the result

The point of the window is the record; an unrecorded window has to be run again.

1. Extract the window's journal entries — everything appended after the line count
   you noted in the prerequisites.
2. Append to `docs/analysis/09-corner-cases.md` (or the QA log you keep alongside
   it) one line per tool: the date, the Graph API version from `facebook_whoami`,
   the observed behaviour, and any divergence from the tool description.
3. Divergences are the deliverable. In particular record: whether the 24-hour
   window behaved as measured from the last inbound message; whether
   `can_reply_privately` was present and whether it predicted the outcome; and
   whether a second block on the same PSID was silently accepted.
4. If any tool description is now wrong, fix the description in the source — the
   description is what the model reads, and a stale one is a live defect, not a
   documentation nit.

**Verify by:** a reader who was not in the room can tell, from the record alone,
which of the three tools were exercised, on which date, against which API version,
and what was observed.

---

## Cleanup

- Delete the helper's comment and the Page's reply, if you do not want them left
  on the test Page.
- Confirm once more that the helper is **not** blocked.
- Unset `FB_WRITE_MODE=plan` only if you had it set purely for the window — for
  day-to-day operation, see [kill-switch.md](kill-switch.md) for what the write
  mode does and, more importantly, what it does not do.
- The private replies you spent are gone. If you need to repeat Step 3, it needs a
  new comment.

## Related

- [onboarding.md](onboarding.md) — getting the Page token and tasks in place first.
- [kill-switch.md](kill-switch.md) — halting write activity if the window goes wrong.
- [`../analysis/08-roadmap.md`](../analysis/08-roadmap.md) — the Phase 3 exit gate
  this runbook closes.
