# 06 — Proposed Tool Catalog

Naming: `facebook_<verb>_<noun>`. Every tool carries the **full MCP annotation
quadruple, explicitly** — no tool is left implicit. This matters because when an
`annotations` object is present the spec defaults `destructiveHint` to `true` and
`idempotentHint` to `false`, so a partial object silently misreports intent (a
"—" shorthand row is a contract gap). The four columns in every package table are
the literal booleans registered in the spec:

- **RO** = `readOnlyHint`
- **D** = `destructiveHint`
- **I** = `idempotentHint`
- **OW** = `openWorldHint` — `true` for every tool (all touch a live external system)

Every write tool participates in plan-and-apply gating (`apply` parameter), with
per-package write-mode defaults stated in each section below.

> **As implemented.** This document was written as a proposal and is kept in sync
> with the code, but the code is the contract. The quadruple is asserted per
> package in `src/tools/*.test.ts`, and **`src/mcp/annotations.test.ts` freezes all
> four booleans for all seven packages in one place** — it expands the full surface
> through the real registry (`all` profile) and holds it against an in-file table
> of 40 rows, so any hint or write-tier change fails until the row is edited
> deliberately. The same file asserts that the table and the registry list exactly
> the same tools in both directions, that no tool leaves a hint `undefined` (a
> partial object is worse than none, per the defaults above), that `openWorldHint`
> is `true` for every tool except the three local saved-reply tools, and that `readOnlyHint: true` and a write tier are mutually
> exclusive — checked against the real read-only posture, which must retain exactly
> the 32 read tools. The published counts (56 tools / 7 packages, 45 in the default
> profile, 32 read / 24 write) are asserted there too. `src/metadata.test.ts`
> remains the gate on tool _names_ agreeing across the registry, the README table
> and `manifest.json`.

## Default surface (`core` profile)

The default `FB_TOOL_PACKAGES` profile `core` expands to **core + posts + reader
+ insights + moderation + messages** (45 tools as shipped) — the `ads` package is
**excluded by default** and must be enabled explicitly (A7 / C5). The out-of-box surface
therefore includes publishing, so a fresh install can post on day one; ads
(spend) stays opt-in. The expansion is snapshot-tested (05 §6).

## Package `core` (always on)

| Tool | RO | D | I | OW | Notes |
|---|---|---|---|---|---|
| `facebook_whoami` | true | false | true | true | `debug_token` + `/me` + permission/task matrix check (doctor). Output includes a `version` field — server version + pinned default `FB_API_VERSION` + SDK version (G-TOOL-5) — needed for usable bug reports once non-author users exist |
| `facebook_list_pages` | true | false | true | true | `/me/accounts` — pages, tasks, token presence |
| `facebook_get_page` | true | false | true | true | Page metadata incl. `has_transitioned_to_new_page_experience` and follower count; Graph v25 rejects the legacy `video_upload_limits` Page field; `field_set:"profile"` adds the public business fields (hours as `[{day, open, close}]`), retried without `emails` if Graph refuses it |
| `facebook_usage` | true | false | true | true | Last-seen rate-limit headers per host/business |

## Package `posts` (publishing; profile `publisher`)

Write-mode default: **plan-first** — publishing is the most consequential action
the server performs; the irreversible/spend tiers are never bypassed by
`FB_WRITE_MODE=apply`. The highest-consequence writes (`facebook_create_post` with
`published:true`, `facebook_create_reel` with `PUBLISHED`, `facebook_update_post`
with `action:"publish_now"`, `facebook_create_story`, `facebook_delete_post`) bind `apply:true` to a
short-lived `plan_id` returned by their validating-dry-run preview, so an eager
model cannot self-approve (A6). The rule is "reaches a live audience", not "is a
create": publishing a scheduled post early collects impressions that deleting it
afterwards cannot recall, while an edit or a reschedule reaches nobody new and
stays ungated.

| Tool | RO | D | I | OW | Notes |
|---|---|---|---|---|---|
| `facebook_create_post` | false | false | false | true | Text/link post; `scheduled_publish_time`, `published:false` drafts; carousel via `child_attachments`; optional organic `targeting` (`geo_locations` + `age_min`, Feed distribution only). Additive → `destructiveHint:false` (avoids over-triggering client confirms on top of plan-and-apply) |
| `facebook_create_photo_post` | false | false | false | true | 1–N photos (`caption`; multi-photo via unpublished photos + `attached_media`); optional organic `targeting` |
| `facebook_create_video_post` | false | false | false | true | Resumable upload; `file_url` or local path; progress reporting; optional organic `targeting` (sent on `finish`) |
| `facebook_create_reel` | false | false | false | true | 3-phase flow; PUBLISHED/SCHEDULED/DRAFT; validates 3–90 s / 9:16 / 30-per-24h budget |
| `facebook_create_story` | false | false | false | true | v2 F1, tier **irreversible** (a story is public at once and no tool deletes it). `media_type` `photo` (local or URL, jpeg/bmp/png/gif/tiff, at most 10 MB: unpublished `/photos` upload, then `/photo_stories`; a clean refusal deletes the photo) or `video` (local `.mp4` only: `video_stories` start → rupload → finish, optional `is_ai_generated`). A local file is bound to the plan by its SHA-256. A 5xx or unconfirmed story step is `attempted`, never retried; verify with `facebook_list_stories` |
| `facebook_update_post` | false | true | true | true | Own-app posts only; message, `is_hidden`, `is_pinned`; also the **scheduled-post lifecycle** verb — publish-now / reschedule / cancel (A13). Overwrites prior content → `destructiveHint:true`; setting a field to a fixed value repeats to the same state → `idempotentHint:true` |
| `facebook_delete_post` | false | true | true | true | Permanent; may fail for posts not created by this app (documented caveat). Repeat delete has no further effect → `idempotentHint:true` |
| `facebook_list_scheduled_posts` | true | false | true | true | `/scheduled_posts`; a read-only tool living inside the write-gated `posts` package (a `reader`-profile install does not see the scheduled queue) |
| `facebook_get_video_status` | true | false | true | true | `/{video-id}?fields=status` — where a large video or Reel stands in Meta's pipeline (uploading / processing / ready / error). A read tool in the write-gated package, for the same reason as `facebook_list_scheduled_posts`: it answers a question only a publisher asks (CC-MEDIA-7) |

## Package `reader` (reading; profile `reader`)

| Tool | RO | D | I | OW | Notes |
|---|---|---|---|---|---|
| `facebook_list_posts` | true | false | true | true | `/published_posts` default; `feed`/`posts`/`tagged` via param; cursor pagination, `truncated` flag |
| `facebook_get_post` | true | false | true | true | Full field set incl. `permalink_url`, `attachments`, `shares`, reactions summary |
| `facebook_list_reels` | true | false | true | true | `/video_reels` (Reels invisible on post endpoints) |
| `facebook_get_reactions` | true | false | true | true | Per-type totals via field expansion |
| `facebook_list_stories` | true | false | true | true | `/stories`; `since`/`until` (Unix seconds or ISO 8601); `status` filtered client-side with `filteredOut`; empty-listing archive hint in `notes` |
| `facebook_list_albums` | true | false | true | true | `/albums`; the album `id` feeds `facebook_list_photos` |
| `facebook_list_photos` | true | false | true | true | `/{album-id}/photos`, or `/{page-id}/photos` with `type` defaulted to `uploaded` (Graph's default is `profile`); `album_id` and `type` mutually exclusive; `tagged` photos come back tainted |

## Package `insights`

| Tool | RO | D | I | OW | Notes |
|---|---|---|---|---|---|
| `facebook_page_insights` | true | false | true | true | Post-2025 metric names; metric list passed through; API errors surfaced readably; 90-day window enforced. Contract v2 (`contractVersion: 2`): each summary has `kind` + `aggregation` and a `value` only when that roll-up is safe (no `total`); window `[since, until)` in Pacific Time with `boundary`/`timezone`; `derived.followers` reconciles `page_follows` with daily follows − unfollows |
| `facebook_post_insights` | true | false | true | true | `post_media_view`, `post_clicks`, reactions totals, video metrics. **Reels metrics are NOT reachable here** — they live on `/{video-id}/video_insights`, off the post-insights edge (G-TOOL-2); the description redirects to `facebook_reel_insights` |
| `facebook_reel_insights` | true | false | true | true | `/{video-id}/video_insights` — the Reel edge (G-TOOL-2). Takes the **video ID** (digits only), not a `{page-id}_{post-id}` composite, which the schema rejects before any Graph call. Default period `lifetime`; same reshape/cap/aggregate contract (v2 `kind`/`aggregation`/`value`, `[since, until)` in UTC) as the other two. Metric vocabulary is its own — unknown names are reported, never silently dropped | |
| `facebook_get_page_report` | true | false | true | true | v2 F2. One-call Page report: a preset (`last_7/28/90_days`, ending today 00:00 PT, exclusive) or `custom` window vs the preceding equal window — followers (reconciled), reach, views, engagement, Page views with `method` + `delta {abs, pct}`, plus top posts published in the window with lifetime insights. Reach only from the rolling `week`/`days_28` window, never summed; other spans report it unavailable. ≤18 Graph calls; only the current-window read is load-bearing, every other section degrades to a note/error |
| `facebook_get_posts_insights` | true | false | true | true | v2 F4. Lifetime insights for up to 25 posts in one table: `post_ids` (composite `{page}_{post}`, own Page only) or `latest` N published posts, ≤10 `metrics` (default views, unique viewers, clicks, reactions by type). The metric list is vetted once on the first post that answers (renamed/rejected names dropped for the rest); 3 reads in flight; a failing post is a row `error`, only all rows failing throws. Breakdown maps stay unaggregated |

**File export (v2 F5).** `facebook_page_insights`, `facebook_post_insights`,
`facebook_reel_insights` and `facebook_get_posts_insights` take an optional
`output: {format: "csv" | "json", file_name?}`. The full series goes to one file
under `FB_EXPORT_DIR` (default: the XDG / `%APPDATA%` state dir + `exports/`;
dir 0700, file 0600), written atomically and never overwriting (a taken name
gets `-1`, `-2`, …). The row cap and `max_rows` do not apply to the file; the
inline answer is the aggregate-mode summary plus `export: {path, format, rows,
bytes, sha256}` (the posts tool returns `postCount` / `postErrors` instead of
`posts`). `file_name` is a bare name (no path, no leading dot). CSV is RFC 4180
with CRLF; a text cell starting with `= + - @` is prefixed with `'`. The
annotations are unchanged: the tools write nothing to Meta, and the local file is
a new one per call.

## Package `moderation` (profile `moderator`)

Write-mode default: **apply-by-default** for the reversible ops — moderation is
high-volume, and stacking a plan-preview and a client confirm on a 20-comment
sweep is dozens of prompts (A6 / UX #6); `destructiveHint` is kept `false` on those
reversible verbs so client prompting stays proportionate. The irreversible
`facebook_delete_comment` and the externally-visible `facebook_private_reply` are
**never** apply-by-default.

| Tool | RO | D | I | OW | Notes |
|---|---|---|---|---|---|
| `facebook_list_comments` | true | false | true | true | `toplevel`/`stream` filter, ordering, `summary=true`; Page-token requirement documented. **Shipped behaviour differs from this proposal:** an up-front refusal on token type was rejected (CC-AUTH-2) — with the per-Page resolver, a configured USER token is the normal setup and the token on the wire is a derived Page token, so a refusal would reject the working configuration. Instead an empty result carries a note naming the Page-token requirement, attached in `src/api/comments.ts` so every caller of the edge gets it |
| `facebook_get_comment` | true | false | true | true | Single-comment read by ID (G-TOOL-1). Lets the model act on a comment ID from a prior turn without re-listing the whole thread; also backs moderation previews that must re-fetch current comment text (CC-MOD-6) |
| `facebook_triage_comments` | true | false | true | true | Moderation queue in one call (v2 F6): comments on the N most recent published posts, newest first, filtered by `status` (`unanswered` default — no Page reply in the thread; `hidden`; `all`), `since` and NFKC case-insensitive `keywords`. The Page's own comments are skipped; `pageReplied: null` when the reply check was over budget or incomplete; a failed post becomes a note and sets `truncated`. Comment text and author names are tainted |
| `facebook_reply_to_comment` | false | false | false | true | `POST /{comment-id}/comments` — public reply visible to everyone; for a private DM to the commenter use `facebook_private_reply`. Additive |
| `facebook_comment_on_post` | false | false | false | true | `POST /{post-id}/comments` with `message` and/or an https `attachment_url` — a top-level public comment as the Page (organic F6). The plan-mode preview reads the post (`id,message,from,created_time`), quotes it, and warns when the Page did not write it; a foreign post's text is quoted only inside a taint envelope. Reversible via `facebook_delete_comment`; not idempotent, so a lost answer is `attempted` |
| `facebook_edit_comment` | false | false | true | true | `POST /{comment-id}` with `message` — rewrite a comment the Page itself wrote (messaging F8b). A pre-flight `GET /{comment-id}?fields=id,from{id},message` runs on every call and refuses locally when `from.id` is not the Page (or is unreadable). The plan-mode preview quotes the current and the new text inside taint envelopes, and the plan binds to the comment's fingerprint, so an edit by someone else in between diverges. Reversible by a second edit back; the journal keeps only fingerprints. Same text twice lands on the same state → `idempotentHint:true` |
| `facebook_hide_comment` | false | false | true | true | `is_hidden` true/false — reversible by design → `destructiveHint:false`, `idempotentHint:true` (hide-or-unhide) |
| `facebook_reply_and_hide_comment` | false | false | false | true | Public reply, then hide the parent, in one approved step (v2 F7). Plan-bound (`requirePlanId`), so `apply:true` alone is always a preview; the comment's fingerprint and hidden flag bind the plan, so an edit or hide in between diverges. A failed reply hides nothing; an already-hidden comment only gets the reply. Per-step outcomes (`reply`, `hide`) — `applied` only when both landed, otherwise `attempted`, with `nextStep` naming the `facebook_hide_comment` call when the hide did not land. No retries; reply not idempotent → `idempotentHint:false` |
| `facebook_like_comment` | false | false | true | true | `POST` / `DELETE /{comment-id}/likes` — like or unlike up to 50 comments as the Page (messaging F9; `unlike` defaults to false). Bulk with per-id outcomes like `facebook_hide_comment`; the snapshot adds `user_likes`, so an id already in the target state is skipped without a write and a changed like state diverges a plan. Reversible with the opposite flag → `destructiveHint:false`, `idempotentHint:true` |
| `facebook_delete_comment` | false | true | true | true | Permanent → `destructiveHint:true`; repeat delete has no further effect → `idempotentHint:true` |
| `facebook_private_reply` | false | true | false | true | One private reply per comment, 7-day window (both enforced client-side with clear errors). Externally visible with no unsend → `destructiveHint:true`; a lost-response retry can double-send → `idempotentHint:false` (unknown-outcome errors instruct "do NOT retry — verify first"; see the error→action matrix in 05) |
| `facebook_block_user` | false | false | true | true | `/blocked`, accepts PSIDs; reversible via `facebook_unblock_user`, and blocking an already-blocked user is a no-op → `idempotentHint:true` |
| `facebook_unblock_user` | false | false | true | true | Inverse of `facebook_block_user`; idempotent |

## Package `messages`

Write-mode default: **plan-first** — a send is instantly visible to a third-party
human and has no unsend. The default alone does not carry that guarantee (an
operator who typed `FB_WRITE_MODE=apply` overrides a package default outright), so
`facebook_send_message` is additionally **plan-bound**: `apply:true` must be
bound to a `plan_id` from a preview of that exact text. Its tier stays
`reversible` — a DM can be followed up — but no write mode can send from a bare
call, which is what stops it being the soft route to what `facebook_private_reply`
gates as `irreversible`.

| Tool | RO | D | I | OW | Notes |
|---|---|---|---|---|---|
| `facebook_list_conversations` | true | false | true | true | Polling-friendly: `updated_time`, `unread_count`, `snippet` |
| `facebook_get_conversation` | true | false | true | true | Messages with `from`, `created_time`, attachments. The candidate opt-in `mark_seen` parameter (G-TOOL-4) was **decided against and does not ship**: a read tool must not mutate read receipts on a real person's conversation as a side effect of the model looking at it. A test pins the rejection |
| `facebook_send_message` | false | true | false | true | RESPONSE type; 24-hour-window errors explained in the error mapping. Externally visible with no unsend → `destructiveHint:true`; a lost-response retry can double-message a real customer → `idempotentHint:false` |
| `facebook_get_activity_since` | true | false | false | true | v2 F3. New comments on the recent published posts (`posts` 1–25) plus conversations updated since `since` or still unread, in one call. `since` omitted ⇒ the local per-Page, per-section high-water mark (`FB_ACTIVITY_STATE_PATH`, 0600), first call ⇒ now − 24h, at most 90 days back. `mark_seen` (default true) advances the mark to the read's horizon only for a complete section; a truncated or failed section keeps its mark. Not idempotent because of that local mark; no Graph write. Comment and message text inside the taint envelope |
| `facebook_list_saved_replies` | true | false | true | false | v2 F10. The Page's local saved replies (`saved-replies.json` in the config dir, 0600, keyed by Page id), optional `tag` filter. No Graph call, so the only closed-world tools. Templates are operator-authored text and are not taint-wrapped |
| `facebook_save_reply` | false | false | true | false | v2 F10. Create or update a template (`id` slug derived from the title when omitted; an existing id needs `overwrite:true` and returns the replaced record). The only placeholder is `{{page_name}}`, filled from the resolved Page; unknown placeholders are refused at save time. Local write, tier `reversible`, applied directly without the plan gate; a corrupt file is a `config_error` and is never overwritten |
| `facebook_delete_saved_reply` | false | false | true | false | v2 F10. Delete one template and return it, so it can be re-saved. Local write, tier `reversible` |

`saved_reply_id` is accepted by `facebook_send_message`, `facebook_reply_to_comment`
and `facebook_private_reply` in place of `message` (exactly one of the two). The
template is resolved to its filled text at preview time and the TEXT is bound to
the plan, so editing the template between preview and apply is a `plan_mismatch`.

## Package `ads` (off by default; ships in 1.1 — profile `ads`)

**Rescoped for 1.1 to read + status/budget control only** (A12). The ad
create-chain (`create_campaign` / `create_adset` / `create_ad_creative` /
`create_ad`) is **deferred beyond
1.1**; single-object archive/delete (v2 ads §3) and ad image uploads (v2 ads §2)
landed in 2.0 — create is a multi-object chain with spend/DSA gating that needs its own
design pass (see 08). Not part of the default `core` profile. Write-mode default:
**plan-first**; budget/status changes sit in the irreversible/spend tier (never
env-bypassed) and are gated by `FB_ADS_BUDGET_CEILING`.

| Tool | RO | D | I | OW | Notes |
|---|---|---|---|---|---|
| `facebook_list_campaigns` | true | false | true | true | `effective_status` surfaced prominently (ACTIVE ≠ delivering) |
| `facebook_list_adsets` | true | false | true | true | `effective_status` surfaced prominently |
| `facebook_list_ads` | true | false | true | true | `effective_status` surfaced prominently |
| `facebook_get_ad_object` | true | false | true | true | Any level by ID with field selection |
| `facebook_get_ad_preview` | true | false | true | true | Placement preview of an ad, a creative or a Page post as an ad; returns the iframe URL only |
| `facebook_update_ad_object` | false | true | true | true | Status pause/resume + budget changes (minor units) + campaign `spend_cap_minor` (raise = spend, set/lower = irreversible, bounded by `FB_ADS_CAMPAIGN_SPEND_CAP_MAX`). Budget overwrites lose the prior value → `destructiveHint:true`; setting to a fixed value repeats to the same state → `idempotentHint:true` |
| `facebook_archive_ad_object` | false | true | true | true | v2 ads §3, tier **irreversible**. `POST /{id}` `status=ARCHIVED`; children inherit (preview counts them with `level`). Archived objects can only be renamed or deleted. Already archived/deleted is refused locally. At-risk accounts allowed (stops delivery) |
| `facebook_delete_ad_object` | false | true | true | true | v2 ads §3, tier **irreversible**. Campaign: `DELETE /{id}`; ad set / ad / unknown level: `POST /{id}` `status=DELETED`. Never the account bulk DELETE. Deleting an archived object is allowed. 28-day delivery warning (insights `last_28d` spend or `effective_status` ACTIVE); ambiguous answer is `attempted`, never retried |
| `facebook_upload_ad_image` | false | false | true | true | v2 ads §2, tier **reversible**. Multipart `POST /act_{id}/adimages` of one local file under `FB_MEDIA_DIR` (same containment/symlink checks as Page photos), JPEG/PNG/GIF/BMP/TIFF/WEBP by extension and magic bytes, at most 30 MB. The plan binds size + sha256, so a file changed after preview is refused. Returns the image `hash` (journaled); no hash in the answer is `attempted`. Creates no ad; Meta deduplicates by hash → `idempotentHint:true`. Needs `ads_management` |
| `facebook_ads_insights` | true | false | true | true | Tried **synchronously first**; when Graph refuses the query for being too large, an async report run is started automatically and the result comes back with `mode:"async"`, a `reportRunId` and **no rows** — the caller polls `facebook_ads_report_status` instead of retrying this tool (CC-ADS-5). Window is either a `date_preset` or a since/until pair (both or neither); breakdowns with row caps + `truncated` |
| `facebook_ads_report_status` | true | false | true | true | Probes one async report run and, with `fetch_results:true`, reads its rows once complete. **One call, one answer** — it never sleeps and never loops; the phase (pending / running / complete / failed / skipped) and a stop-polling hint come back to the model, which owns the wait. A FAILED or SKIPPED run produced nothing and must be replaced by a narrower run, not re-probed (there is no cancel API) |

Deferred beyond 1.1: custom audiences (TOS gate + hashing pipeline), the ad
create-chain and `delete_ad_image` — see 08.

## Resources & prompts (secondary)

- **Not implemented.** The proposed resources `facebook://usage` (rate-limit
  state) and `facebook://pages` (configured profiles) do **not** ship — there is
  no resource registration anywhere in `src/`. Both are reachable as tools
  instead (`facebook_usage`, `facebook_list_pages`), which is why neither was
  built: a resource would have duplicated a tool for no added capability.
  Prompts: none in v1 (spec deprecation risk is low for prompts, but they add
  little here).

## Cross-cutting behaviors baked into every spec

- `.strict()` input schemas; `.describe()` on every field.
- Auto-injected optional `profile` argument (selects which configured Page /
  credential the call targets) except where a tool is page-independent.
- Compact JSON output + character budget + `structuredContent` where an output
  schema exists.
- Errors: mapped `GraphApiError` with actionable text ("permission X missing —
  run facebook_whoami", "rate limited — retry after N min").
- Advisory notes on a read come as `notes: string[]`, one advisory per element
  (`facebook_list_comments`, `facebook_list_conversations`,
  `facebook_get_conversation`). The joined `note` string is still emitted next
  to it but is **deprecated** and removed in 2.0.

**Total as shipped: 45 model-facing tools in the default `core` profile** (core 4
+ posts 9 + reader 7 + insights 5 + moderation 13 + messages 7), with the opt-in
`ads` package adding 11 more — **56 across all 7 packages**, split 32 read
/ 24 write (17 reversible, 6 irreversible, 1 spend — the single `spend` tool is
`facebook_update_ad_object`). Deliberately smaller than the 100+
tool ads servers; each tool wraps a real, verified capability rather than
mirroring every Graph edge. This is **not** the full Pages surface: Story
publishing, Events, Live video, album / photo uploads, Page profile updates (reads ship via `facebook_get_page`), organic post targeting, and post boosting are out of
scope for 1.0 (see 01's out-of-scope list and the README scope enumeration).
