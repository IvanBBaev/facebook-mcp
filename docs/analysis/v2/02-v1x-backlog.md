# 02 — v1.x additive backlog

Everything here is additive (new tools, optional parameters, better errors) and can ship in a
1.x minor without a major version. It is listed so that v2.0 does not absorb work that has no
reason to wait. Order inside each section is by value × feasibility for a single Page operator
at Standard Access.

## 1. Organic surface

| # | Item | Graph surface | Effort | Notes |
|---|---|---|---|---|
| O1 | **Page Stories** (photo + video publish, list) — resolves A13 | `POST /{page-id}/video_stories` (3-phase, same shape as Reels), `photo_stories` with an unpublished `photo_id`, `GET /{page-id}/stories` | S | No new scope. Docs conflict on max length (60 s vs 90 s): validate ≤60 s or let the API decide. Media reused from an earlier post is rejected; fbcdn URLs are rejected. |
| O2 | **Activity digest** `facebook_get_activity_since` | `/conversations` (unread/new) + `/{post}/comments?filter=stream&since=` over recent posts | S–M | Polling with a local high-water mark in XDG state. Zero new attack surface; the honest local alternative to webhooks. |
| O3 | **Albums / photo library reads** (+ publish into an album) | `GET /{page-id}/albums`, `/{album-id}/photos`, `/{page-id}/photos?type=uploaded`, `POST /{album-id}/photos` | S | `pages_read_engagement`. Useful for "reuse an existing image". |
| O4 | **Organic post `targeting`** on `create_post` | `targeting` (`geo_locations`, `age_min` ∈ {13,15,18,21,25}) | S | Hard restriction can hide a post from most followers → loud preview warning. Skip interest-based `feed_targeting`. |
| O5 | **Messenger additions:** `reply_to` threading, reactions | Send API (`reply_to` 2025-10-06, reactions 2025-12-02) | S | Keeps the RESPONSE-only policy. |
| O6 | **Page-content gaps seen in competitor issues:** pin a post (`is_pinned`), top-level Page comments | `POST /{post-id}` `is_pinned`; `POST /{post-id}/comments` as the Page | S | Demand evidence: oliverames issues #2 and #6. |

## 2. Ads (package stays opt-in)

| # | Item | Effort | Notes |
|---|---|---|---|
| A1 | **Map ads mutation and rate-limit subcodes** | S | 613/1487632 (ad-set budget: 4 changes/hour), 17/1885172 (account spend limit: 10/day), 613/1487225, 613/4841018 (same object edited ≈1/30 s), 613/5044001 (mutation QPS), 17/2446079 + 613/1487742 (BUC), 200/1870090 + 200/1870050 (custom audiences). Non-retryable rate errors with `retryAfterMs`. None is mapped today; retrying a budget write is actively harmful. |
| A2 | **v25 async report error fields** in `ads_report_status` | S | `error_code`, `error_message`, `error_subcode`, `error_user_title`, `error_user_msg`. |
| A3 | **Account money headroom** read (`facebook_get_ad_account` or a doctor check) | S | `spend_cap`, `amount_spent`, `balance`, `min_daily_budget`, `account_status`, `disable_reason`, DSA defaults, `dsa_recommendations` (hint only). Precondition for the ads smoke test and for any create. |
| A4 | **Correct the ARCHIVED next-step text** | S | `src/api/ads-control.ts` (≈ line 543) says archived objects can be restored; the API documents no unarchive. New text: "Archived objects cannot be resumed through the API; if Ads Manager offers to restore it, do that there, otherwise duplicate it." |
| A5 | **Read `advantage_state_info`**; map the legacy ASC/AAC write rejection | S | Explains delivery/edit behaviour. Do not construct or migrate Advantage+. |
| A6 | **Docs accuracy** | S | Doc 12: v24 sunset is 2026-11-10, not 2026-10-06. Access tiers were renamed on 2026-05-04: Limited (was Standard), Full (was Advanced); Full needs 500 calls in 15 days at <15% errors, no screencast. Daily-budget flex is 75 % since v24 (1.75× per day, 7× per week) — any ceiling wording must say so. |

## 3. Hygiene and distribution

- Submit to **PulseMCP** (not listed; the only 14-day referrer was one Google visit). Keep the
  official registry entry and Glama current with every release.
- Enable GitHub Discussions or an "I use this" issue template, so existing users have a
  low-friction way to show up.
- Answer HagaiHen-style "dead project?" fears by keeping PR review latency visible (PR #41 is the
  test case).
- Warn (not fail) in 1.x when more than one of `FB_ACCESS_TOKEN` / `FB_SYSTEM_TOKEN` /
  `FB_PAGE_TOKEN` is set; the model collapses in 2.0 (CC-AUTH-9).
- Deterministic `tools/list` order: spec 2026-07-28 says SHOULD. Add a test that pins it.
