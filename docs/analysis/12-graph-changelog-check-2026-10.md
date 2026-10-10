# 12 — Graph API changelog check, 2026-10

Check performed **2026-10-02** against commit `e15de55`, following
[`../runbooks/app-upkeep.md` §1](../runbooks/app-upkeep.md#1-the-4-week-changelog-check)
(CC-LIFE-5). The server pins `DEFAULT_API_VERSION = 'v23.0'`
([`src/core/settings.ts:34`](../../src/core/settings.ts)) and uses that one
version for **every** call — Pages, Messenger, video/rupload **and** the
Marketing API (ads) edges.

Every claim below cites an official Meta source. Anything that could not be
confirmed from an official page is marked **UNVERIFIED**. Nothing here has been
checked against the live API; this is a desk check of the published changelogs.

## Summary

- **Newest Graph API version: v26.0** (released 2026-07-29). The pinned **Graph**
  version v23.0 is supported until **2027-10-08**.
- **HIGH — the Marketing API v23.0 is already past its sunset (2026-06-09).** The
  `ads` package sends every call on v23.0, so today those calls are either
  auto-upgraded by Meta to the next available Marketing API version or rejected
  with error `#2635`. The next one up, Marketing API v24.0, itself sunsets on
  **2026-10-06** — four days after this check.
- No breaking change in v24.0 – v26.0 touches a Pages, video, Reels, comments or
  Messenger field this server reads or writes.
- Page insights: the June/July 2026 removal wave is already reflected in the
  server's rename table, but the table is incomplete, two hints are stale now
  that Meta shipped the "media viewers" metrics, and the doctor probes one metric
  (`page_daily_unfollows`) that the current reference no longer lists.
- **Recommendation:** bump `DEFAULT_API_VERSION` to **v26.0** as its own release
  **before** the 1.0 live verification, so the live pass verifies the version
  that ships (see [Recommendation](#recommendation)).

## Versions

### Graph API

| Version | Released   | Available until | Source |
| ------- | ---------- | --------------- | ------ |
| v26.0   | 2026-07-29 | TBD             | [1]    |
| v25.0   | 2026-02-18 | 2028-07-29      | [1]    |
| v24.0   | 2025-10-08 | 2028-02-18      | [1]    |
| v23.0   | 2025-05-29 | **2027-10-08**  | [1]    |

When a Graph version expires, "any calls made to it will be defaulted to the next
oldest, usable version" [2]. Older versions retiring in this window: v20.0 on
2026-09-24 and v21.0 on 2027-01-21 [4].

### Marketing API

The Marketing API has "its own versioning scheme" with different schedules [2],
and a much shorter one:

| Version | Released   | Available until | Source  |
| ------- | ---------- | --------------- | ------- |
| v26.0   | 2026-07-29 | not listed      | [4]     |
| v25.0   | 2026-02-18 | TBD             | [5]     |
| v24.0   | 2025-10-08 | **2026-10-06**  | [5]     |
| v23.0   | 2025-05-29 | **2026-06-09**  | [5]     |

Marketing API v26.0 was announced together with Graph v26.0 [4], but the
Marketing API versions table [5] and the versioning page ("The current version of
the Marketing API is v25.0") [6] had not listed it at the time of this check —
**UNVERIFIED** whether v26.0 is callable on the Marketing API edges.

Behaviour on an expired Marketing API version [6]: after the grace period "the
older version becomes non-functional"; since May 2024 an **auto-upgrade** to the
next available version applies to endpoints that did not change between the two
versions, but "auto-version upgrade is not applied to endpoints affected by next
available version". Auto-upgraded responses carry an `X-Ad-Api-Version-Warning`
header, and the upgrade can be switched off in the app's Marketing API settings.
Failing calls get `(#2635) You are calling a deprecated version of the Ads API`
[6].

## Inventory checked

The Graph surface the server touches at `e15de55`:

| Area | Edges / fields |
| ---- | -------------- |
| Auth | `GET /debug_token`; `GET /{page-id}?fields=access_token` ([`src/core/auth.ts`](../../src/core/auth.ts)) |
| Posts read | `/{page-id}/{published_posts,feed,posts,tagged}`, `/{page-id}/video_reels`, `/{post-id}`, `/{post-id}/reactions`; field sets `POST_LIST_FIELDS`, `POST_DETAIL_FIELDS`, `REEL_LIST_FIELDS` (`status{video_status}`) ([`src/api/posts-read.ts`](../../src/api/posts-read.ts)) |
| Posts write | `POST /{page-id}/feed`, `/{page-id}/videos` (`file_url`), `POST`/`DELETE /{post-id}`, `/{page-id}/scheduled_posts`, `GET /{page-id}?fields=id,timezone` ([`src/api/posts-write.ts`](../../src/api/posts-write.ts)) |
| Photos | `POST /{page-id}/photos` multipart ([`src/api/media-photos.ts`](../../src/api/media-photos.ts)) |
| Video | `POST /{page-id}/videos` `upload_phase=start/finish` on `graph-video`, bytes on `rupload` `/video-upload/{version}/{session}`, `GET /{video-id}?fields=status` ([`src/api/media-video.ts`](../../src/api/media-video.ts)) |
| Reels | `POST /{page-id}/video_reels` `upload_phase=start/finish`, rupload `/video-upload/{version}/{video-id}`, `video_state`, `scheduled_publish_time` (10 min – 29 days) ([`src/api/media-reels.ts`](../../src/api/media-reels.ts)) |
| Comments | `/{object-id}/comments`, `/{comment-id}` (`is_hidden`, delete), `COMMENT_FIELDS` incl. `can_reply_privately`; private reply `POST /{page-id}/messages` with `recipient={comment_id}` (7-day rule); `/{page-id}/blocked` ([`src/api/comments.ts`](../../src/api/comments.ts)) |
| Messenger | `/{page-id}/conversations?platform=messenger` (`CONVERSATION_FIELDS`), `/{conversation-id}/messages` (`MESSAGE_FIELDS`), `POST /{page-id}/messages` `messaging_type=RESPONSE` (24 h window) ([`src/api/messaging.ts`](../../src/api/messaging.ts)) |
| Page insights | `/{object-id}/insights`, caller-chosen metrics; rename table ([`src/api/insights.ts:275-372`](../../src/api/insights.ts)); doctor probe set ([`src/mcp/doctor.ts:190-201`](../../src/mcp/doctor.ts)); documented examples `page_media_view`, `page_follows`, `post_media_view`, `post_clicks`, `post_reactions_by_type_total` |
| Ads read | `/act_{id}/{campaigns,adsets,ads}`, `/{object-id}`, `/act_{id}` (`account_status`, `disable_reason`, `currency`, `timezone_name`), `/{object-id}/insights` (`impressions,clicks,spend,reach,cpc,ctr,account_currency`, `date_preset` / `time_range`, `breakdowns`), async `/{report-run-id}` (`async_status`, `async_percent_completion`) ([`src/api/ads-read.ts`](../../src/api/ads-read.ts)) |
| Ads control | `POST /{object-id}` with `status` and/or `daily_budget` / `lifetime_budget` ([`src/api/ads-control.ts:699`](../../src/api/ads-control.ts)) |
| Protocol | none of `pretty`, `debug`, `date_format`, root `GET /?ids=`, `If-None-Match`, `metadata=1` is sent (grep of `src/`, 2026-10-02) |

## Impact matrix

Severity: **HIGH** = a tool is broken or about to break on the pinned version
today; **MEDIUM** = wrong or misleading output / model-facing text; **LOW** =
cosmetic or edge case; **NONE** = checked, does not touch the inventory.

| # | Change (source) | Affected file / tool | Severity | Action |
| - | --------------- | -------------------- | -------- | ------ |
| H1 | Marketing API v23.0 sunset 2026-06-09; v24.0 sunsets 2026-10-06; expired calls auto-upgrade only where the endpoint is unchanged, otherwise `#2635` [5][6] | Every `ads` tool: [`src/core/settings.ts:34`](../../src/core/settings.ts) (single pin) → [`src/api/ads-read.ts`](../../src/api/ads-read.ts), [`src/api/ads-control.ts:699`](../../src/api/ads-control.ts) | **HIGH** | Bump the pin (see recommendation). Until then, live behaviour is **UNVERIFIED**: check whether ads calls return `X-Ad-Api-Version-Warning` or `#2635` ([`src/core/error-matrix.ts:478`](../../src/core/error-matrix.ts) already maps 2635). Consider a separate ads version pin long-term, since the Marketing API ages out roughly four times faster than Graph. |
| M1 | `page_daily_unfollows` (non-unique) is not listed in the current Page insights reference; only `page_daily_unfollows_unique` is [3] | Doctor probe [`src/mcp/doctor.ts:196`](../../src/mcp/doctor.ts); rename target for `page_fan_removes` [`src/api/insights.ts:286`](../../src/api/insights.ts) | MEDIUM | **UNVERIFIED** whether the name still answers. Confirm in the 1.0 live pass; if dead, drop it from the probe set and point `page_fan_removes` at `page_daily_unfollows_unique`. |
| M2 | v25.0 shipped deduplicated "media viewers" metrics: `page_total_media_view_unique`, `post_total_media_view_unique` as the alternatives to `page_impressions_unique` / `post_impressions_unique` [7][8] | Hints [`src/api/insights.ts:344`](../../src/api/insights.ts) and [`:350`](../../src/api/insights.ts) say "No deduplicated replacement shipped" | MEDIUM | Make `*_total_media_view_unique` the replacement (model-facing text is a live defect per the runbook). |
| M3 | Names removed on all versions on 2025-11-15 [9] and in the 2026 wave [7][3] that are **not** in the rename table: `page_fans_locale`, `page_fans_city`, `page_fans_country`, `page_impressions_viral`, `page_impressions_nonviral`, `post_impressions_fan`, `post_impressions_nonviral`, `page_impressions_paid_unique`, `page_impressions_viral_unique`, `page_impressions_nonviral_unique`, the `page_posts_impressions*` family (9 names), `post_impressions_paid_unique`, `post_impressions_fan_unique`, `post_impressions_organic_unique`, `post_impressions_viral_unique`, `post_impressions_nonviral_unique`, `total_video_impressions*` and `total_video_views_{organic,paid,}_unique` | [`src/api/insights.ts:275-372`](../../src/api/insights.ts) | MEDIUM | Not a break: unknown names pass through, Graph rejects them and the server drops the rejected name and re-reads when Graph names it. Extend the table so the model gets a replacement instead of an error round-trip. |
| L1 | The fans family (`page_fans`, `page_fan_adds*`, `page_fan_removes*`) was removed on **2025-11-15**, not in the 2024-09 wave [9] | `removedOn: '2024-09'` at [`src/api/insights.ts:277-292`](../../src/api/insights.ts) | LOW | Correct the wave label in the suggestion text. |
| L2 | Since 2026-01-12, unique-count fields and hourly breakdowns are limited to 13 months, frequency breakdowns to 6 months; only totals keep 37 months; `7d_view` / `28d_view` attribution windows are no longer returned [10] | `facebook_ads_insights` `since` description [`src/tools/ads.ts:201`](../../src/tools/ads.ts), [`src/api/ads-read.ts:1002`](../../src/api/ads-read.ts) ("reach back up to 37 months") | LOW | Qualify the 37-month claim. **UNVERIFIED** whether `reach` (a default field) counts as a unique-count field for the 13-month limit. The server sends no `action_attribution_windows`, so the window removal does not apply. |
| L3 | Advantage+ shopping/app campaigns: creation, duplication and updates prohibited on all versions since 2026-05-19; listed endpoints are `POST /{ad-account-id}/campaigns` and `POST /{campaign-id}/copies` [7] | [`src/api/ads-control.ts:699`](../../src/api/ads-control.ts) (`POST /{object-id}`) | LOW | **UNVERIFIED** whether a status/budget write on an existing ASC/AAC campaign is rejected; the listed endpoints are not the one the server uses. |
| L4 | The current video publishing guide documents only the Resumable Upload API (`/{app-id}/uploads`); no deprecation notice for `upload_phase` on `/{page-id}/videos` was found [11] | [`src/api/media-video.ts`](../../src/api/media-video.ts) | LOW | Pre-existing ✎ item (G-TOOL-3); **UNVERIFIED** either way. Exercise it in the live pass. |
| N1 | Reels publishing guide still documents `start` → rupload `/video-upload/{version}/{video-id}` → `finish`, `video_state`, a 10 min – 29 day scheduling window and `GET /{video-id}?fields=status` [12] | [`src/api/media-reels.ts`](../../src/api/media-reels.ts) | NONE | Matches the implementation. |
| N2 | Messenger: `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE`, `POST_PURCHASE_UPDATE` tags error with code 100 after 2026-04-27; `is_owner` and `reply_to` added to Conversations [13] | [`src/api/messaging.ts:79`](../../src/api/messaging.ts) | NONE | The server sends only `messaging_type=RESPONSE` and already tells the model that every tag except `HUMAN_AGENT` hard-fails. Additive fields need nothing. |
| N3 | v26.0 removes `pretty`, `debug`, `date_format`, root `GET /?ids=` and `If-None-Match`/ETag (v26.0+ on 2026-07-29, all versions on 2026-10-27) [4][14] | — | NONE | None of these is sent (grep of `src/`). |
| N4 | v26.0 blocks `current_location`, `genre`, `network`, `parking`, `start_info` on New Pages Experience Pages (all versions ~90 days later) [14] | — | NONE | The server reads only `id,timezone` and `access_token` on the Page node. |
| N5 | v25.0 deprecates `metadata=1` (all versions 2026-05-19) [7] | — | NONE | Not sent. |
| N6 | v24.0: `is_adset_budget_sharing_enabled` required on `POST /{ad-account-id}/campaigns` when budgets live at ad-set level [15] | — | NONE | The server never creates campaigns. |
| N7 | v25.0: async report runs return `error_code` (now `int`), `error_message`, `error_subcode`, `error_user_title`, `error_user_msg` [7] | [`src/api/ads-read.ts:1315`](../../src/api/ads-read.ts) | NONE | Additive; the report-run read requests its own field list. A follow-up could surface `error_message` on a failed run. |
| N8 | v26.0 Marketing API: Instagram Explore placement, Messenger Stories placement, poll ads, `web_only` app-link treatment, HEC-F `advantage_audience`, Delivery Estimate fields, Commerce Order Management, Rights Manager owner fields [14] | — | NONE | No tool creates ads, targets placements or uses these edges. |
| N9 | v24.0: Certificate Transparency endpoints, Live Video `overlay_url`, Messenger lead-ad creation [15]; webhook mTLS CA change 2026-03-31 [7] | — | NONE | Not used (the server consumes no webhooks). |

No change was found to the comments edges, `can_reply_privately`, the private
reply 7-day rule, the 24-hour standard messaging window, `/{page-id}/blocked`, or
the Page permission names in the checked changelogs [1][4][7][13][15]. The doctor's
permission × package matrix is unaffected.

## Recommendation

The 1.0 live verification has not happened yet, so the version it runs against is
the version that should ship. Verifying on v23.0 and bumping afterwards means
doing the expensive live pass twice.

| Option | Cost | Risk |
| ------ | ---- | ---- |
| **A. Keep v23.0** | None now. | The `ads` package already runs on an expired Marketing API version (H1) and depends on Meta's auto-upgrade, which skips changed endpoints and can be turned off per app. After 2026-10-06 the auto-upgrade target moves from v24.0 to v25.0. Graph side is fine until 2027-10-08, but the 1.0 live pass would verify ads behaviour the code does not control. |
| **B. Bump to v25.0** | One bump release: `doctor` + live smokes + fixture shape-diff per [runbook §2](../runbooks/app-upkeep.md#2-graph-and-marketing-api-version-deprecation). No source change expected from this check. | Graph runway to 2028-07-29. Marketing API v25.0 is "current" with sunset TBD [5][6], but on the observed cadence (v23 died ~4 months after v25 shipped, v24 ~2 months after v26) it is likely to expire within months of v27.0 — **UNVERIFIED** projection. |
| **C. Bump to v26.0** | Same as B. Also exercises the v26 protocol removals (N3), which the server does not use. | Longest runway on both APIs. Graph v26.0 sunset is TBD (expected ~2 years). Marketing API v26.0 was announced [4] but not yet listed on the Marketing API versions page [5][6] — **UNVERIFIED** until a live `doctor` / ads smoke on v26.0 succeeds. |

**Recommended: option C (v26.0), with option B (v25.0) as the fallback** if a live
ads read on v26.0 fails or returns `X-Ad-Api-Version-Warning`. Do it as its own
release before the 1.0 live verification, per the runbook rule that a version bump
is never released together with other changes. Fold M1–M3 and L1–L2 into the same
pre-1.0 window as separate changes; they are text and table fixes, not wire
changes.

Longer term, the Marketing API's shorter lifecycle means a single pin forces a
Graph bump every ~8 months just to keep ads alive. A separate ads version pin
(for example `FB_ADS_API_VERSION`) is worth evaluating; that is a design change,
not part of this check.

## Sources

1. Graph API changelog, versions table — <https://developers.facebook.com/docs/graph-api/changelog>
2. Graph API versioning guide — <https://developers.facebook.com/docs/graph-api/guides/versioning>
3. Page Insights reference (deprecation notice "By June 15, 2026 …", metric list) — <https://developers.facebook.com/docs/graph-api/reference/insights>
4. Introducing Graph API v26 and Marketing API v26 (2026-07-29) — <https://developers.facebook.com/blog/post/2026/07/29/introducing-graph-api-v26-and-marketing-api-v26/>
5. Marketing API changelog / versions — <https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog> and <https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog/versions>
6. Marketing API versioning (grace period, auto-upgrade, `#2635`) — <https://developers.facebook.com/documentation/ads-commerce/marketing-api/overview/versioning>
7. Graph API v25.0 changelog — <https://developers.facebook.com/docs/graph-api/changelog/version25.0>
8. Introducing Graph API v25 and Marketing API v25 (2026-02-18) — <https://developers.facebook.com/blog/post/2026/02/18/introducing-graph-api-v25-and-marketing-api-v25>
9. Pages API changelog (2025-11-15 insights deprecation) — <https://developers.facebook.com/documentation/pages-api/changelog>; announcement <https://developers.facebook.com/blog/post/2025/08/15/page-insights-api-updates/>
10. Ads Insights API metric availability updates (2026-01-12) — <https://developers.facebook.com/blog/post/2025/10/16/ads-insights-api-metric-availability-updates/>
11. Video API publishing guide — <https://developers.facebook.com/docs/video-api/guides/publishing>
12. Reels publishing guide — <https://developers.facebook.com/docs/video-api/guides/reels-publishing>
13. Messenger Platform changelog — <https://developers.facebook.com/docs/messenger-platform/changelog>
14. Graph API v26.0 changelog — <https://developers.facebook.com/docs/graph-api/changelog/version26.0>
15. Graph API v24.0 changelog — <https://developers.facebook.com/docs/graph-api/changelog/version24.0>

Also consulted: the 2025 non-versioned changes page
(<https://developers.facebook.com/docs/graph-api/changelog/non-versioned-changes/nvc-2025>,
oEmbed only — no impact). A 2026 non-versioned changes page was not found (the
`nvc-2026` URL returned 404).
