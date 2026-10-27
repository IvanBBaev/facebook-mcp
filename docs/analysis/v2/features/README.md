# v2.0 feature specs — index and build order

Status: implementation-ready research, 2026-10-24, Graph API v26.0 (Marketing API pin v26.0).
This directory covers only features that can be coded. It leaves out adoption, marketing and
process. The scope and decisions it builds on are in [../03-v2-scope.md](../03-v2-scope.md) and
[../04-owner-decisions.md](../04-owner-decisions.md).

Each spec gives the following for every feature:
- user story and tool name;
- zod input sketch and output shape;
- Graph calls with permissions;
- write tier and plan preview;
- error mapping;
- files per layer (core ← api ← mcp ← tools);
- tests and fixtures;
- effort;
- whether it is codeable now or which live probe it needs;
- dependencies;
- whether the change is breaking.

## Specs

| Spec | Features | New tools | Effort | Breaking |
|---|---|---|---|---|
| [insights-reporting.md](insights-reporting.md) | Insights contract v2, page report, activity digest, multi-post insights, file export | 3 | 4×M + 1×S | Contract v2 only |
| [organic-publishing.md](organic-publishing.md) | Stories, albums/photos, album publish, post targeting, top-level Page comment, pin refinement, Page profile update, profile read, photo alt text | 6 | 3×M + 7×S | None |
| [messaging-moderation.md](messaging-moderation.md) | `reply_to`, reactions, Messenger attachments, private-reply improvements, `notes[]`, comment triage, reply-and-hide, edit/like comments, local saved replies, labels, moderation settings, find by PSID | 13 | 5×M + 8×S | `note` removal only |
| [ads.md](ads.md) | Subcode table, spend-cap env, account headroom, preview, campaign `spend_cap`, archive/delete, image upload, targeting read/edit, duplicate, boost-post chain | ≈9 | 1×L + 4×M + 6×S | None |
| [instagram.md](instagram.md) | Opt-in `instagram` package (Facebook Login variant): account, publishing, media, comments, insights, DMs, FB+IG cross-post | ≈25 | L overall | None (new package) |

Without Instagram, the catalog grows from 37 tools to about 68. Every new tool updates the
default-profile snapshot in `src/mcp/packages.test.ts` (opt-in packages excepted) and
[../../06-tool-catalog.md](../../06-tool-catalog.md).

## Build order

The waves are ordered by readiness first and value second. Every wave-1 and wave-2 item can be
built and fully tested against fixtures and fakes today. Wave-3 items can be coded now, but
each has a live probe that must pass before it is enabled by default.

### Wave 1 — small, no live access needed

| Item | Spec | Effort |
|---|---|---|
| Ads subcode table (11 mutation/rate subcodes + 2 DSA), ARCHIVED next-step text | ads §0.4, §5.3–5.4 | S |
| `FB_ADS_CAMPAIGN_SPEND_CAP_MAX` + money helpers (shared by every ads write below) | ads §0.2–0.3 | S |
| Account money headroom, Advantage+ state (read-only), verify v25 report error fields | ads §5.1, §5.2, §5.5 | S each |
| `notes[]` alongside `note` (removal in 2.0) | messaging F5 | S |
| `facebook_list_stories`, `facebook_list_albums`, `facebook_list_photos` | organic F2, F3 | S |
| `facebook_get_page` `field_set: 'profile'` | organic F9 | S |
| `facebook_comment_on_post` (top-level comment as the Page) | organic F6 | S |
| `reply_to_message_id` on send; find conversation by PSID | messaging F1 (send half), F13 | S |
| `facebook_edit_comment`, comment-reply attachments, bulk `facebook_like_comment` | messaging F8, F9 | S |
| `facebook_get_ad_preview` | ads §6 | S |

### Wave 2 — the headline features, codeable now

| Item | Spec | Effort | Depends on |
|---|---|---|---|
| **Insights contract v2** (PR #41 semantics, `kind: 'unique'`, `[since, until)`, `contractVersion: 2`) | insights F1 | M | — (breaking; part of 2.0.0) |
| **`facebook_get_page_report`** | insights F2 | M | insights F1 |
| **`facebook_get_activity_since`** (local high-water mark) | insights F3 | M | shares triage logic with messaging F6 |
| `facebook_get_posts_insights` (≤25 posts) | insights F4 | S | insights F1 |
| `facebook_triage_comments`, `facebook_reply_and_hide_comment` | messaging F6, F7 | M, S–M | — |
| Local saved replies | messaging F10 | M | — |
| `facebook_create_story` (photo/video) | organic F1 | M | Reels upload path |
| Organic post `targeting` (geo + `age_min`) | organic F5 | S | — |
| Campaign `spend_cap` on `facebook_update_ad_object` | ads §4 | S/M | money helpers |
| `facebook_archive_ad_object` / `facebook_delete_ad_object` | ads §3 | M | subcode table |
| `facebook_upload_ad_image` | ads §2 | S/M | — |
| Insights file export (`output: {format: csv\|json}`) | insights F5 | S–M | insights F1 |

### Wave 3 — code now, enable after the probe

| Item | Spec | Effort | Gating probe |
|---|---|---|---|
| `facebook_update_page_profile` (new opt-in `page_admin` package) | organic F8 | M | Permission (`pages_manage_metadata`?) |
| `album_id` on photo posts; pin refinement; photo `alt_text` | organic F4, F7, F10 | S each | Album write permission; pin on non-app posts; `alt_text_custom` on children |
| Message reactions; Messenger attachments; private reply to `post_id` + attachment | messaging F2, F3, F4 | S, M, S–M | P-2 window, P-3 multipart, P-4 |
| Conversation labels; moderation settings (blocked words, profanity) | messaging F11, F12 | M each | P-6 scope/terms, P-7 New Page Experience write |
| Ad-set targeting read/edit (countries + age only) | ads §8 | S + M | `advantage_audience` default |
| `facebook_duplicate_ad_object` (forced PAUSED) | ads §7 | M | `status_option` on ad sets/ads |
| **`facebook_boost_post`** paused create-chain with rollback | ads §1 | L | ads P1–P7; decision D3 |

### Instagram package — gated by D2

**D2 was decided B (2026-10-27): the package is not built here.** The README points to the
sibling server instead. The rest of this section is kept for a later revisit.

[instagram.md](instagram.md) applies only if decision D2 is A (package here) or C (shared core).
Probe P1 blocks the whole package: whether a Page token, rather than a User token, is enough
for `instagram_business_account` and `GET /{ig-id}`. Run that probe before writing any code.
After P1 the package can be built against fixtures in this order: account → media → insights →
publishing → comments → DMs → cross-post.

## Breaking changes in this feature set

Only two items break the contract, and both belong in 2.0.0:
- **Insights contract v2:** removes `total` and `totalIsLatest`, and `until` becomes exclusive.
- **`note` removal:** moderation and messaging reads keep only `notes[]`.

Everything else is additive. It can ship in 1.x minors before 2.0 or in 2.x minors after it, as
[../05-roadmap-and-risks.md](../05-roadmap-and-risks.md) prefers. The forced SDK v2 migration
must not wait on any of it.

## Considered and dropped

Each spec lists what it dropped and why. In summary:
- **Insights:** demographic reports (the metrics are gone) and scheduled digests (outside a
  stdio server).
- **Organic:** link-preview override, `feed_targeting`, album creation (the edge is not
  writable), story scheduling, Events, and the profile fields deprecated in v26.0.
- **Messaging:** `HUMAN_AGENT` and all message tags. The utility tags
  `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE` and `POST_PURCHASE_UPDATE` have returned error
  100 since 2026-04-27. Also dropped: Moderate Conversations (Instagram-only), `mark_seen`,
  typing indicators, Meta's Saved Replies API, and regex filters (ReDoS).
- **Ads:** custom audiences, special-category and political ads, account spend-limit reset or
  delete, bulk delete, and activation inside a create call.
