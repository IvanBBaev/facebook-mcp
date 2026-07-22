# 09 — Corner-Case Catalog

Compiled 2026-07-22, after the seven role reviews (`docs/reviews/`). Each entry
states the corner case and the **decided handling** — these decisions are binding
on the implementation and feed the test plan directly. Format: `CC-<domain>-<n>`.
Cases marked ⚠ are known to have bitten other Facebook integrations in the wild;
cases marked ✎ need live verification (they carry a phase tag).

Domains: AUTH, PUB, MEDIA, SCHED, INS, MOD, MSG, ADS, NET, PAGE (pagination),
MCP (protocol), CFG (config), LIFE (process lifecycle).

---

## AUTH — tokens & permissions

- **CC-AUTH-1 ⚠ Token dies mid-session** (expired, revoked, password change).
  Error 190 + subcodes 460/463/467. Handling: non-retryable; error→action matrix
  returns which env var to refresh and the doctor command; per-page token cache
  is invalidated and re-derived **once** before surfacing the error.
- **CC-AUTH-2 ⚠ User token where Page token is required.** Comment/insight reads
  with a user token return **silent empty data**, not an error. Handling: the
  server knows the token type from `debug_token` at startup; affected tools
  return an explicit error instead of empty results (UX #9).
- **CC-AUTH-3 Page role removed while token still valid.** Token debugs fine but
  Page operations fail with permission errors. Handling: map error 200/10 family
  to "check your role on the Page", never retry.
- **CC-AUTH-4 Granular permission missing** (e.g. `pages_read_user_content`
  absent but `pages_manage_engagement` present — delete-user-comment fails).
  Handling: doctor prints a permission×package matrix; tool descriptions name
  their exact permission; error mapping names the missing permission.
- **CC-AUTH-5 System user deleted / app removed from Business.** Token invalid
  with a distinct subcode. Handling: same 190 rail; doctor distinguishes "token
  malformed" from "asset access revoked" via `debug_token` `granular_scopes`.
- **CC-AUTH-6 Two pages with the same display name** in `/me/accounts`.
  Handling: `resolvePage` refuses ambiguous names with a list of ID candidates;
  profiles keyed by ID are always unambiguous.
- **CC-AUTH-7 Page merged, renamed, or unpublished by Meta.** Cached
  name→ID mapping goes stale. Handling: resolver cache invalidates on 190/100
  and re-derives; `facebook_list_pages` is always live, never cached.
- **CC-AUTH-8 Clock skew breaks `appsecret_proof`.** Proof is HMAC over the
  token (no timestamp in the base variant) — but if the timestamped variant is
  ever used, skew >5 min fails. Handling: use the untimestamped variant only.
- **CC-AUTH-9 Both `FB_PAGE_TOKEN` and `FB_SYSTEM_TOKEN` set.** Handling:
  explicit precedence (system token wins), logged at startup, doctor states
  which credential is active.
- **CC-AUTH-10 "Require App Secret" toggle on** in the app while a tool call
  omits proof — or off while Explorer testing expects it. Handling: always send
  `appsecret_proof` when `FB_APP_SECRET` is set; document the Explorer trade-off
  (Meta minor).

## PUB — publishing & post lifecycle

- **CC-PUB-1 ⚠ Double post on ambiguous outcome.** Timeout/reset after the
  request body is on the wire. Handling: publishing POSTs are never auto-retried
  post-write; error text instructs verification via `facebook_list_posts`
  filtered to the last few minutes (C2). Preview includes the exact message so
  the operator can search for it.
- **CC-PUB-2 Duplicate-content rejection** (error 506) when the same text is
  posted twice quickly. Handling: mapped to "identical post already exists —
  did a previous attempt succeed?"; never retried.
- **CC-PUB-3 ~600 published posts/year cap** on `/published_posts` reads and
  feed writes. Handling: disclosed in `list_posts`/`get_post` descriptions;
  error mapping explains the cap; no client-side counting.
- **CC-PUB-4 Editing a post created by another app** fails (edit-own-app-only,
  verified). Handling: error→action matrix names the cause; `update_post`
  description carries the constraint.
- **CC-PUB-5 Deleting an already-deleted post.** Graph returns error 100.
  Handling: idempotent-delete semantics surfaced as success-with-note ("already
  absent") — safe because delete is the intended end state; noted in preview.
- **CC-PUB-6 Link-only post with empty message.** Allowed by API; link preview
  scrape may fail or be slow. Handling: accept; description pins "link preview
  is best-effort, controlled by Facebook's scraper" (UX nit).
- **CC-PUB-7 Post text at/over the length limit** (~63,206 chars). Handling:
  local pre-validation with the exact limit in the preview warning; server
  still relies on Meta's error as truth.
- **CC-PUB-8 Unicode/emoji/RTL text and `#`/`@` sequences.** Hashtags are
  plain text; @-mentions of Pages require `@[page-id]` syntax that mostly no
  longer resolves for third-party apps. Handling: pass text through verbatim
  (UTF-8), document that mentions are not supported; never mangle encoding.
- **CC-PUB-9 Publishing a draft (`published:false`) then publishing it again.**
  Transition rules are asymmetric (unpublished→published OK once; published→
  unpublished not allowed for some types). ✎ Verify exact matrix in Phase 2;
  preview shows current publish state before transition.
- **CC-PUB-10 `child_attachments` count out of range** (multi-link carousel
  needs 2–5, verified). Handling: local validation, exact bounds in error.

## MEDIA — photos, video, Reels

- **CC-MEDIA-1 ⚠ Server restart mid-resumable-upload.** v1 state is in-memory
  (C7): resume works within one server lifetime only. Handling: error after
  restart says "upload session lost — restart the upload"; roadmap notes MCP
  Tasks / durable state as future work.
- **CC-MEDIA-2 Chunk upload fails mid-sequence.** rupload protocol resumes via
  offset query, not by replaying chunks. Handling: chunk POSTs bypass the
  generic retry matrix; resume logic asks the API for the current offset and
  continues; enumerated fault-injection tests (QA #2).
- **CC-MEDIA-3 Upload session expiry** (Meta expires idle sessions). ✎ Verify
  TTL empirically in Phase 2. Handling: expiry error mapped to "restart the
  upload"; no silent re-create.
- **CC-MEDIA-4 Remote media URL misbehaves**: 404, redirect to another host,
  content-type lies, unbounded body. Handling: no cross-host redirects (Sec);
  size ceiling enforced while streaming to buffer; content-type taken from
  bytes (magic numbers) not headers where it matters; clear error naming the
  URL failure mode.
- **CC-MEDIA-5 Local file edge cases**: path traversal, symlink escaping
  `FB_MEDIA_DIR`, zero-byte file, unreadable permissions, non-UTF-8 filename.
  Handling: `FB_MEDIA_DIR` unset ⇒ local files disabled; realpath containment
  check after resolving symlinks; zero-byte and unreadable fail fast locally.
- **CC-MEDIA-6 Unsupported/edge formats**: HEIC, animated GIF (becomes video?),
  CMYK JPEG, >8K images. Handling: no client-side format validation beyond
  extension warnings (C10); Meta's error is the source of truth, mapped
  verbatim with the filename attached.
- **CC-MEDIA-7 ⚠ Video "created" ≠ video "ready".** Processing is async; the
  post may 404 or render empty briefly. Handling: video creates return
  `video_id` + `processing` state; `facebook_get_video_status` polls;
  descriptions warn that immediate `get_post` may not reflect the video.
- **CC-MEDIA-8 Reels daily cap (30/24h) exhausted.** Handling: mapped error
  explains the cap and when it resets (from `estimated_time_to_regain_access`
  if present); smoke tests budget Reels deliberately (B2).
- **CC-MEDIA-9 Reels constraint violations** (duration, aspect, codec).
  Handling: no local probe (C10); Meta's per-phase errors surfaced with the
  upload phase named (start/transfer/finish).
- **CC-MEDIA-10 Multi-photo where one child upload fails.** Unpublished photo
  children uploaded first; one fails → orphaned unpublished photos. Handling:
  best-effort cleanup of already-uploaded children on failure; if cleanup
  fails, result lists orphan IDs so the operator can delete them.

## SCHED — scheduling

- **CC-SCHED-1 Scheduled time out of window.** Lower bound 10 min, upper 75
  days (30 for some surfaces, 29d for Reels). Handling: validate lower bound +
  Reels bound locally; warn (not block) above 30 days; pass through otherwise
  (Meta minor).
- **CC-SCHED-2 Timezone ambiguity.** `scheduled_publish_time` is a Unix
  timestamp; the operator thinks in Page-local time. Handling: tools accept
  ISO-8601 with explicit offset **required** (reject naive datetimes); preview
  echoes the time in UTC *and* the Page's timezone (from Page metadata).
- **CC-SCHED-3 DST transition makes a local time nonexistent/ambiguous.**
  Handling: solved by CC-SCHED-2 (explicit offset only — no local-time math in
  the server).
- **CC-SCHED-4 Scheduled post's time passes while it's being edited/canceled.**
  Race: post may publish mid-operation. Handling: apply-time re-validation
  (C4 divergence semantics) detects the state change and fails with the diff.
- **CC-SCHED-5 Draft/scheduled lifecycle transitions** (publish-now,
  reschedule, cancel). Gaps found by PM #5. Handling: `update_post` extended to
  cover transitions; round-trip (schedule→reschedule→publish-now→delete) is a
  Phase 2 gate item on the test Page.

## INS — insights

- **CC-INS-1 ⚠ Metric invalid after platform migration.** Post-Nov-2025 reset +
  June-2026 video wave; training data suggests dead metrics. Handling: doctor
  probes and generates the valid-metric table; static rename suggestions in the
  invalid-metric error (C6).
- **CC-INS-2 Page under ~100 likes returns empty insights.** Not an error — an
  eligibility floor. Handling: runtime note in the result when series come back
  empty and the Page is small; doctor states eligibility.
- **CC-INS-3 Empty series vs zero values vs missing days.** Graph omits days
  with no data for some metrics. Handling: reshape contract (UX #11) preserves
  explicit dates; no gap-filling invention — absent days reported as absent.
- **CC-INS-4 Huge breakdown responses.** Handling: row caps per breakdown +
  `FB_MAX_RESULT_CHARS` (~25k) truncation that keeps the first rows and says
  what was dropped; `aggregate` param for series collapse.
- **CC-INS-5 `period`/`date_preset` boundary semantics** (partial current day,
  Page-timezone day boundaries). ✎ Verify at Phase 1 with the doctor probe;
  document observed behavior rather than assuming.
- **CC-INS-6 Insights on a just-published post.** Metrics lag minutes-to-hours.
  Handling: description notes the lag; empty result on a fresh post is normal,
  stated in the result note.

## MOD — comments & moderation

- **CC-MOD-1 Comment deleted (by author) before the moderation action lands.**
  Error 100. Handling: hide/delete treat gone-already as success-with-note;
  reply treats it as a hard error (nothing to reply to).
- **CC-MOD-2 Private reply already consumed or >7 days old.** One-shot/7-day
  (verified). Handling: distinct error mapping for both exhaustion and expiry;
  `private_reply` description carries both constraints (UX #3).
- **CC-MOD-3 Acting on the Page's own comment** (hide/delete own content has
  different permission semantics). Handling: preview shows comment author; the
  user-content permission split (CC-AUTH-4) covers the delete path.
- **CC-MOD-4 Deeply nested reply threads.** Replies-to-replies have limited
  API support. ✎ Verify depth behavior in Phase 3; `list_comments` documents
  observed flattening; no recursion beyond what the API returns.
- **CC-MOD-5 Bulk moderation partial failure.** `ids: string[]` ≤50 (PM
  minor): result reports per-ID outcome {ok, already-gone, failed+reason};
  never all-or-nothing.
- **CC-MOD-6 Comment edited after being read.** Moderation decision may be
  based on stale text. Handling: preview re-fetches and shows current text
  (before-state, C4); apply-time divergence check.
- **CC-MOD-7 Blocking a user who is already blocked / unblocking a never-
  blocked user.** Handling: idempotent success-with-note; verb symmetry
  hide/unhide + block/unblock (UX minor).
- **CC-MOD-8 ⚠ Injected instructions inside comment text.** The B1 scenario.
  Handling: tainted-content envelope wraps all UGC; moderation tools carry the
  read-only-profile guidance for unattended runs.

## MSG — messaging

- **CC-MSG-1 ⚠ 24-hour window expires between read and send.** Race: window
  open at preview, closed at apply. Handling: tag-less send failure (error
  10/551 family) mapped to "window closed — private reply or wait for user
  message"; never silently retried with a tag (tags hard-fail since
  2026-04-27, verified).
- **CC-MSG-2 Ambiguous send outcome.** Same class as CC-PUB-1 but worse (a
  human receives it). Handling: `send_message`/`private_reply` annotated
  {destructive: true, idempotent: false}; error distinguishes "definitively
  not sent" vs "unknown — check `facebook_get_conversation`, do NOT resend
  blindly" (UX #2); optional in-process dedupe by (recipient, text-hash).
- **CC-MSG-3 User blocked or deleted the conversation.** Sends fail with a
  distinct subcode. Handling: mapped to a terminal "recipient unavailable";
  non-retryable.
- **CC-MSG-4 Wrong tool for the surface** (public reply where private was
  intended = privacy incident). Handling: description negative-space contracts
  on the trio (UX #3); preview names the visibility ("PUBLIC comment reply" vs
  "PRIVATE message").
- **CC-MSG-5 Polling misses messages between polls.** Stateless snapshot
  design (Arch minor): caller supplies `since`; descriptions say ordering is
  best-effort and delivery is poll-based, not real-time.
- **CC-MSG-6 Attachments in inbound messages** (stickers, images, shares).
  Handling: v1 renders as typed placeholders (`[image] <url>`) through the
  shaper; URLs are CDN-tokenized and expire — noted in the result.

## ADS — Marketing API (rescoped v1: read + status/budget control)

- **CC-ADS-1 Dev-tier rate limits** (300 + 40n calls). Handling: BUC header
  monitoring; polling backs off; error 17/32 mapped with `estimated_time_to_
  regain_access` in minutes.
- **CC-ADS-2 `ACTIVE` ≠ delivering.** `effective_status` vs `status` vs review
  pipeline. Handling: status tools always return `effective_status` with the
  configured/effective distinction explained in the description pin (UX nit).
- **CC-ADS-3 Budget in minor currency units** (cents) with per-currency rules.
  Handling: tools accept minor units only, named `budget_minor`; result echoes
  the currency from the ad account; no float math.
- **CC-ADS-4 Status/budget change on a deleted/archived object.** Handling:
  error 100 mapped to "object gone/archived"; archived objects are read-only —
  stated in preview.
- **CC-ADS-5 Async insights job never completes or fails.** Handling: job
  status tool with terminal-state mapping; polling guidance in description;
  timeout advice rather than infinite waiting.
- **CC-ADS-6 Ad account disabled / payment failure mid-session.** Handling:
  distinct error family mapped to account-level action text; doctor reports
  `account_status` on startup.
- **CC-ADS-7 Spend-limit safety.** Even in read+control scope, budget raises
  are spend-affecting. Handling: budget changes are irreversible-tier (C4) —
  never env-bypassed; optional `FB_ADS_BUDGET_CEILING` refuses raises above a
  configured cap (Sec minor).

## NET — transport, retries, rate limits

- **CC-NET-1 ⚠ Throttle arrives as HTTP 400 with a body code** (4/17/32/613,
  80000–80099), not HTTP 429. Handling: retry matrix keys on body codes;
  family/range matching, not enumeration (Meta minor); table-driven test.
- **CC-NET-2 `X-App-Usage`/`X-Business-Use-Case-Usage` absent or malformed.**
  Handling: usage parsing is defensive (absent ⇒ unknown, never crash);
  `facebook_usage` reports "no data" honestly (QA nit).
- **CC-NET-3 `estimated_time_to_regain_access` is minutes and can be huge.**
  Handling: never sleep on it (60s cap on any internal wait — the model is the
  retry loop, Arch #6); surfaced in the error text as a human-readable ETA.
- **CC-NET-4 Non-JSON error bodies** (HTML from an edge/proxy, empty body on
  5xx). Handling: JSON parse failure produces a `GraphApiError` with status +
  first N bytes of body (through the redactor), never a crash.
- **CC-NET-5 GET vs POST retry discipline.** Safe reads retry on 5xx/network;
  writes follow C2 (retry only if provably not sent — DNS/connect-phase
  failures). Handling: retry decision is a pure function with a table test.
- **CC-NET-6 Corporate proxy / TLS interception mangles requests.** Handling:
  no custom CA handling in v1; error text suggests checking proxy env; honor
  standard `HTTPS_PROXY` via undici defaults only if free; otherwise document.
- **CC-NET-7 Host allowlist bypass attempts** (redirect to attacker host,
  `graph.facebook.com.evil.com`). Handling: strict hostname allowlist
  (`graph.facebook.com`, `graph-video.facebook.com`, `rupload.facebook.com`);
  no cross-host redirect following (C11).

## PAGE — pagination

- **CC-PAGE-1 Empty `data` with a `paging.next` present.** Real Graph
  behavior on filtered feeds. Handling: `fetchAll` continues past empty pages
  up to the page budget; never treats empty-page as end-of-data when `next`
  exists (QA #9).
- **CC-PAGE-2 Cursor expiry mid-`fetchAll`.** Handling: return partial
  results + `truncated: true` + note "cursor expired — restart listing"
  (UX #7); never throw away already-fetched items.
- **CC-PAGE-3 Items shifting between pages** (new post published mid-listing).
  Duplicates/skips possible. Handling: documented as inherent; results are
  keyed by ID so downstream dedup is possible; no server-side dedup promise.
- **CC-PAGE-4 `paging.next` URL embeds the access token.** Handling: shaper
  strips all paging objects recursively (C3); cursors surface as opaque
  `after` values only.
- **CC-PAGE-5 Unbounded listings blowing the result budget.** Handling:
  `limit` defaults small; `fetchAll` capped by page budget; truncation keeps
  the first items + states the drop (UX #7, QA property test for termination).

## MCP — protocol & client interplay

- **CC-MCP-1 Client timeout during long upload.** Handling: progress
  notifications via `progressToken` when the client provides one; without one,
  descriptions warn about duration; chunked design keeps each request short
  (C7).
- **CC-MCP-2 Cancellation mid-write.** MCP cancellation can arrive after the
  Graph POST is on the wire. Handling: treat as CC-PUB-1 ambiguous outcome —
  the cancellation response says the write may have landed and how to verify.
- **CC-MCP-3 Concurrent tool calls on one server instance.** Two applies
  racing on the same object. Handling: no global mutable state besides caches
  (no ALS, C14); per-page token cache is concurrency-safe; plan_id binding
  (C4) prevents cross-talk on high-consequence applies.
- **CC-MCP-4 Result exceeds client/context budget.** Handling:
  `FB_MAX_RESULT_CHARS` (~25k) with structure-aware truncation (UX #11);
  never mid-JSON cuts.
- **CC-MCP-5 stdio EOF / client vanishes mid-request.** Handling: server
  exits cleanly on transport close; in-flight Graph requests aborted via
  AbortSignal; no orphan retries after shutdown.
- **CC-MCP-6 Client without elicitation support** hits the OOB confirmation
  gate (B1). Handling: elicitation is a seam with a fallback — operator
  confirmation token via env/config; the gate never silently downgrades to
  "just allow".
- **CC-MCP-7 `structuredContent`/`outputSchema` mismatch after API drift.**
  Handling: outputSchema only on server-owned envelopes (whoami, usage), never
  on Graph-shaped passthrough (Arch minor, UX minor).

## CFG — configuration & environment

- **CC-CFG-1 dotenv v17 banner on stdout.** Corrupts JSON-RPC. Handling:
  pinned/quieted + spawn-level stdout-purity test as a Phase 0 gate (C12).
- **CC-CFG-2 Missing/partial env at startup.** Handling: fail fast with a
  single aggregated report of everything missing (not one-error-at-a-time);
  doctor replicates the check.
- **CC-CFG-3 `FB_TOOL_PACKAGES` contains unknown/misspelled package or a
  profile-package name collision.** Handling: startup error lists valid names;
  profiles and packages live in one namespace with reserved profile names
  (Arch minor).
- **CC-CFG-4 Windows paths & permissions.** chmod 0600 is a no-op; XDG vars
  absent. Handling: `%APPDATA%` fallback; doctor reports actual (not claimed)
  file protection; Windows CI leg (DevOps minor, QA minor).
- **CC-CFG-5 `FB_API_VERSION` set to a future/retired version.** Handling:
  accepted verbatim (escape hatch by design) but doctor warns when it differs
  from the tested default; manifest snapshot pins the default.
- **CC-CFG-6 HTTP transport enabled without auth.** Handling: fails closed —
  no `FB_HTTP_TOKEN`, no server; Origin validated; 127.0.0.1 bind only
  (Sec #4).

## LIFE — process lifecycle & operational

- **CC-LIFE-1 Journal write fails** (disk full, permission). Handling: journal
  failure never blocks the actual write operation; logged to stderr; result
  carries a `journal: failed` note.
- **CC-LIFE-2 SIGINT/SIGTERM during apply.** Handling: in-flight request
  finishes or aborts per CC-MCP-5; journal entry for "attempted" writes is
  flushed before exit where possible; ambiguous outcome documented in the
  journal entry itself.
- **CC-LIFE-3 Orphaned smoke artifacts** (test posts, PAUSED campaigns left
  behind after a crashed smoke run). Handling: `[FBMCP-SMOKE nonce]` marker +
  sweeper at start AND end of every smoke run (B2); ads smoke deletes in
  `finally`.
- **CC-LIFE-4 Long-running session crosses a token expiry boundary**
  (60-day Page token). Handling: CC-AUTH-1 rail; doctor prints expiry date at
  startup and warns under 7 days.
- **CC-LIFE-5 Meta changelog lands mid-development** (version deprecation,
  metric wave). Handling: PM #7 cadence — changelog check every ~4 weeks;
  fixture shape-diff on `FB_API_VERSION` bump (QA #3); re-pull Messenger
  changelog before Phase 3 (Meta nit).

---

## Coverage note

Every ⚠ case maps to at least one table-driven or fault-injection test in the
QA plan; every ✎ case appears in the live-verification list of
[07-risks-and-open-questions.md](07-risks-and-open-questions.md) with a phase
tag. The roadmap ([08-roadmap.md](08-roadmap.md)) references this catalog per
phase — a phase gate is not passable while one of its ⚠ cases lacks a test.
