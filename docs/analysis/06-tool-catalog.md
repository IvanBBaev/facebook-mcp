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
> of 37 rows, so any hint or write-tier change fails until the row is edited
> deliberately. The same file asserts that the table and the registry list exactly
> the same tools in both directions, that no tool leaves a hint `undefined` (a
> partial object is worse than none, per the defaults above), that `openWorldHint`
> is `true` throughout, and that `readOnlyHint: true` and a write tier are mutually
> exclusive — checked against the real read-only posture, which must retain exactly
> the 23 read tools. The published counts (37 tools / 7 packages, 30 in the default
> profile, 23 read / 14 write) are asserted there too. `src/metadata.test.ts`
> remains the gate on tool _names_ agreeing across the registry, the README table
> and `manifest.json`.

## Default surface (`core` profile)

The default `FB_TOOL_PACKAGES` profile `core` expands to **core + posts + reader
+ insights + moderation + messages** (30 tools as shipped) — the `ads` package is
**excluded by default** and must be enabled explicitly (A7 / C5). The out-of-box surface
therefore includes publishing, so a fresh install can post on day one; ads
(spend) stays opt-in. The expansion is snapshot-tested (05 §6).

## Package `core` (always on)

| Tool | RO | D | I | OW | Notes |
|---|---|---|---|---|---|
| `facebook_whoami` | true | false | true | true | `debug_token` + `/me` + permission/task matrix check (doctor). Output includes a `version` field — server version + pinned default `FB_API_VERSION` + SDK version (G-TOOL-5) — needed for usable bug reports once non-author users exist |
| `facebook_list_pages` | true | false | true | true | `/me/accounts` — pages, tasks, token presence |
| `facebook_get_page` | true | false | true | true | Page metadata incl. `has_transitioned_to_new_page_experience`, `video_upload_limits`, follower count |
| `facebook_usage` | true | false | true | true | Last-seen rate-limit headers per host/business |

## Package `posts` (publishing; profile `publisher`)

Write-mode default: **plan-first** — publishing is the most consequential action
the server performs; the irreversible/spend tiers are never bypassed by
`FB_WRITE_MODE=apply`. The highest-consequence writes (`facebook_create_post` with
`published:true`, `facebook_create_reel` with `PUBLISHED`, `facebook_update_post`
with `action:"publish_now"`, `facebook_delete_post`) bind `apply:true` to a
short-lived `plan_id` returned by their validating-dry-run preview, so an eager
model cannot self-approve (A6). The rule is "reaches a live audience", not "is a
create": publishing a scheduled post early collects impressions that deleting it
afterwards cannot recall, while an edit or a reschedule reaches nobody new and
stays ungated.

| Tool | RO | D | I | OW | Notes |
|---|---|---|---|---|---|
| `facebook_create_post` | false | false | false | true | Text/link post; `scheduled_publish_time`, `published:false` drafts; carousel via `child_attachments`. Additive → `destructiveHint:false` (avoids over-triggering client confirms on top of plan-and-apply) |
| `facebook_create_photo_post` | false | false | false | true | 1–N photos (`caption`; multi-photo via unpublished photos + `attached_media`) |
| `facebook_create_video_post` | false | false | false | true | Resumable upload; `file_url` or local path; progress reporting |
| `facebook_create_reel` | false | false | false | true | 3-phase flow; PUBLISHED/SCHEDULED/DRAFT; validates 3–90 s / 9:16 / 30-per-24h budget |
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

## Package `insights`

| Tool | RO | D | I | OW | Notes |
|---|---|---|---|---|---|
| `facebook_page_insights` | true | false | true | true | Post-2025 metric names; semantics-aware summaries (flows vs gauges vs overlapping windows); follower stock/flow reconciliation; `[since, until)` window semantics with Pacific boundaries for Page daily Insights; API errors surfaced readably; 90-day window enforced |
| `facebook_post_insights` | true | false | true | true | `post_media_view`, `post_clicks`, reactions totals, video metrics. **Reels metrics are NOT reachable here** — they live on `/{video-id}/video_insights`, off the post-insights edge (G-TOOL-2); the description redirects to `facebook_reel_insights` |
| `facebook_reel_insights` | true | false | true | true | `/{video-id}/video_insights` — the Reel edge (G-TOOL-2). Takes the **video ID** (digits only), not a `{page-id}_{post-id}` composite, which the schema rejects before any Graph call. Default period `lifetime`; same reshape/cap/aggregate contract as the other two. Metric vocabulary is its own — unknown names are reported, never silently dropped | |

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
| `facebook_reply_to_comment` | false | false | false | true | `POST /{comment-id}/comments` — public reply visible to everyone; for a private DM to the commenter use `facebook_private_reply`. Additive |
| `facebook_hide_comment` | false | false | true | true | `is_hidden` true/false — reversible by design → `destructiveHint:false`, `idempotentHint:true` (hide-or-unhide) |
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

## Package `ads` (off by default; ships in 1.1 — profile `ads`)

**Rescoped for 1.1 to read + status/budget control only** (A12). The ad
create-chain (`create_campaign` / `create_adset` / `create_ad_creative` /
`create_ad`), `delete_ad_object`, and `upload_ad_image` are **deferred beyond
1.1** — create is a multi-object chain with spend/DSA gating that needs its own
design pass (see 08). Not part of the default `core` profile. Write-mode default:
**plan-first**; budget/status changes sit in the irreversible/spend tier (never
env-bypassed) and are gated by `FB_ADS_BUDGET_CEILING`.

| Tool | RO | D | I | OW | Notes |
|---|---|---|---|---|---|
| `facebook_list_campaigns` | true | false | true | true | `effective_status` surfaced prominently (ACTIVE ≠ delivering) |
| `facebook_list_adsets` | true | false | true | true | `effective_status` surfaced prominently |
| `facebook_list_ads` | true | false | true | true | `effective_status` surfaced prominently |
| `facebook_get_ad_object` | true | false | true | true | Any level by ID with field selection |
| `facebook_update_ad_object` | false | true | true | true | Status pause/resume + budget changes (minor units). Budget overwrites lose the prior value → `destructiveHint:true`; setting to a fixed value repeats to the same state → `idempotentHint:true` |
| `facebook_ads_insights` | true | false | true | true | Tried **synchronously first**; when Graph refuses the query for being too large, an async report run is started automatically and the result comes back with `mode:"async"`, a `reportRunId` and **no rows** — the caller polls `facebook_ads_report_status` instead of retrying this tool (CC-ADS-5). Window is either a `date_preset` or a since/until pair (both or neither); breakdowns with row caps + `truncated` |
| `facebook_ads_report_status` | true | false | true | true | Probes one async report run and, with `fetch_results:true`, reads its rows once complete. **One call, one answer** — it never sleeps and never loops; the phase (pending / running / complete / failed / skipped) and a stop-polling hint come back to the model, which owns the wait. A FAILED or SKIPPED run produced nothing and must be replaced by a narrower run, not re-probed (there is no cancel API) |

Deferred beyond 1.1: custom audiences (TOS gate + hashing pipeline), the ad
create-chain, `upload_ad_image`, and `delete_ad_object` — see 08.

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

**Total as shipped: 30 model-facing tools in the default `core` profile** (core 4
+ posts 8 + reader 4 + insights 3 + moderation 8 + messages 3), with the opt-in
`ads` package adding 7 more in 1.1 — **37 across all 7 packages**, split 23 read
/ 14 write (10 reversible, 4 irreversible, 0 spend). Deliberately smaller than the 100+
tool ads servers; each tool wraps a real, verified capability rather than
mirroring every Graph edge. This is **not** the full Pages surface: Stories
(pending Phase 2 verification), Events, Live video, albums / photo-library reads,
Page profile management, organic post targeting, and post boosting are out of
scope for 1.0 (see 01's out-of-scope list and the README scope enumeration).
