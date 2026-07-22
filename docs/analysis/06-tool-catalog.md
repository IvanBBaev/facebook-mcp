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

The manifest snapshot test freezes the quadruple so it can never regress silently.
Every write tool participates in plan-and-apply gating (`apply` parameter), with
per-package write-mode defaults stated in each section below. Counts are targets,
not contracts — the manifest snapshot test becomes the source of truth once code
exists.

## Default surface (`core` profile)

The default `FB_TOOL_PACKAGES` profile `core` expands to **core + posts + reader
+ insights + moderation + messages** (~28 tools) — the `ads` package is **excluded
by default** and must be enabled explicitly (A7 / C5). The out-of-box surface
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
`published:true`, `facebook_create_reel` with `PUBLISHED`, `facebook_delete_post`)
bind `apply:true` to a short-lived `plan_id` returned by their validating-dry-run
preview, so an eager model cannot self-approve (A6).

| Tool | RO | D | I | OW | Notes |
|---|---|---|---|---|---|
| `facebook_create_post` | false | false | false | true | Text/link post; `scheduled_publish_time`, `published:false` drafts; carousel via `child_attachments`. Additive → `destructiveHint:false` (avoids over-triggering client confirms on top of plan-and-apply) |
| `facebook_create_photo_post` | false | false | false | true | 1–N photos (`caption`; multi-photo via unpublished photos + `attached_media`) |
| `facebook_create_video_post` | false | false | false | true | Resumable upload; `file_url` or local path; progress reporting |
| `facebook_create_reel` | false | false | false | true | 3-phase flow; PUBLISHED/SCHEDULED/DRAFT; validates 3–90 s / 9:16 / 30-per-24h budget |
| `facebook_update_post` | false | true | true | true | Own-app posts only; message, `is_hidden`, `is_pinned`; also the **scheduled-post lifecycle** verb — publish-now / reschedule / cancel (A13). Overwrites prior content → `destructiveHint:true`; setting a field to a fixed value repeats to the same state → `idempotentHint:true` |
| `facebook_delete_post` | false | true | true | true | Permanent; may fail for posts not created by this app (documented caveat). Repeat delete has no further effect → `idempotentHint:true` |
| `facebook_list_scheduled_posts` | true | false | true | true | `/scheduled_posts`; a read-only tool living inside the write-gated `posts` package (a `reader`-profile install does not see the scheduled queue) |

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
| `facebook_page_insights` | true | false | true | true | Post-2025 metric names; metric list passed through; API errors surfaced readably; 90-day window enforced |
| `facebook_post_insights` | true | false | true | true | `post_media_view`, `post_clicks`, reactions totals, video metrics. **Reels metrics are NOT reachable here** — they live on `/{video-id}/video_insights`, off the post-insights edge (G-TOOL-2). ✎ Verify the edge at Phase 2, then either add a separate `facebook_reel_insights` or route by ID type inside this tool — routing decision deferred to that verification |

## Package `moderation` (profile `moderator`)

Write-mode default: **apply-by-default** for the reversible ops — moderation is
high-volume, and stacking a plan-preview and a client confirm on a 20-comment
sweep is dozens of prompts (A6 / UX #6); `destructiveHint` is kept `false` on those
reversible verbs so client prompting stays proportionate. The irreversible
`facebook_delete_comment` and the externally-visible `facebook_private_reply` are
**never** apply-by-default.

| Tool | RO | D | I | OW | Notes |
|---|---|---|---|---|---|
| `facebook_list_comments` | true | false | true | true | `toplevel`/`stream` filter, ordering, `summary=true`; Page-token requirement documented (a user-token call is refused with an actionable error, not the API's silent empty) |
| `facebook_get_comment` | true | false | true | true | Single-comment read by ID (G-TOOL-1). Lets the model act on a comment ID from a prior turn without re-listing the whole thread; also backs moderation previews that must re-fetch current comment text (CC-MOD-6) |
| `facebook_reply_to_comment` | false | false | false | true | `POST /{comment-id}/comments` — public reply visible to everyone; for a private DM to the commenter use `facebook_private_reply`. Additive |
| `facebook_hide_comment` | false | false | true | true | `is_hidden` true/false — reversible by design → `destructiveHint:false`, `idempotentHint:true` (hide-or-unhide) |
| `facebook_delete_comment` | false | true | true | true | Permanent → `destructiveHint:true`; repeat delete has no further effect → `idempotentHint:true` |
| `facebook_private_reply` | false | true | false | true | One private reply per comment, 7-day window (both enforced client-side with clear errors). Externally visible with no unsend → `destructiveHint:true`; a lost-response retry can double-send → `idempotentHint:false` (unknown-outcome errors instruct "do NOT retry — verify first"; see the error→action matrix in 05) |
| `facebook_block_user` | false | false | true | true | `/blocked`, accepts PSIDs; reversible via `facebook_unblock_user`, and blocking an already-blocked user is a no-op → `idempotentHint:true` |
| `facebook_unblock_user` | false | false | true | true | Inverse of `facebook_block_user`; idempotent |

## Package `messages`

Write-mode default: **plan-first** — a send is instantly visible to a third-party
human and has no unsend.

| Tool | RO | D | I | OW | Notes |
|---|---|---|---|---|---|
| `facebook_list_conversations` | true | false | true | true | Polling-friendly: `updated_time`, `unread_count`, `snippet` |
| `facebook_get_conversation` | true | false | true | true | Messages with `from`, `created_time`, attachments. **Candidate** opt-in `mark_seen` parameter — sends a `sender_action: mark_seen` so `unread_count` resets for the polling diff signal; folded into this tool rather than a separate tool, decision at Phase 3 entry, not committed (G-TOOL-4) |
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
| `facebook_ads_insights` | true | false | true | true | Sync + auto-fallback to async report runs (returns a `report_run_id` to poll; terminal states surfaced); breakdowns with row caps + `truncated` |

Deferred beyond 1.1: custom audiences (TOS gate + hashing pipeline), the ad
create-chain, `upload_ad_image`, and `delete_ad_object` — see 08.

## Resources & prompts (secondary)

- Resource: `facebook://usage` (rate-limit state), `facebook://pages` (configured
  profiles). Prompts: none in v1 (spec deprecation risk is low for prompts, but
  they add little here).

## Cross-cutting behaviors baked into every spec

- `.strict()` input schemas; `.describe()` on every field.
- Auto-injected optional `profile` argument (selects which configured Page /
  credential the call targets) except where a tool is page-independent.
- Compact JSON output + character budget + `structuredContent` where an output
  schema exists.
- Errors: mapped `GraphApiError` with actionable text ("permission X missing —
  run facebook_whoami", "rate limited — retry after N min").

**Total: ~28 model-facing tools in the default `core` profile** (core + posts +
reader + insights + moderation + messages), with the opt-in `ads` package adding
~6 more in 1.1 (~34 across all 7 packages) — deliberately smaller than the 100+
tool ads servers; each tool wraps a real, verified capability rather than
mirroring every Graph edge. This is **not** the full Pages surface: Stories
(pending Phase 2 verification), Events, Live video, albums / photo-library reads,
Page profile management, organic post targeting, and post boosting are out of
scope for 1.0 (see 01's out-of-scope list and the README scope enumeration).
