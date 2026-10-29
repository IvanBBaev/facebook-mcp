# v3 review 03 — Meta platform specialist

| Field | Value |
|---|---|
| Role | Senior Meta Platform Specialist (Graph API, Pages, Messenger, Marketing API, App Review) |
| Date | 2026-10-29 |
| Scope | `main` at commit `2c8d8bd` — `@ivanbaev/facebook-mcp` 0.8.0, 69 tools, Graph pin `v26.0`, Ads pin `FB_ADS_API_VERSION` (default `v26.0`) |
| Method | Static read of `src/core`, `src/api`, `src/tools`, `src/mcp/doctor`, `scripts/smoke`, `docs/runbooks`, and the v3 analysis corpus. Claims about the code were checked against Meta's public documentation and changelogs found by web search. **No live Graph call was made.** Every claim that only a live call can settle is marked **[UNVERIFIED 2026-10-29]**. |
| Prior review | [`docs/reviews/03-meta-platform-specialist.md`](../03-meta-platform-specialist.md) (2026-07, pre-code, v25) |

## Sources (all checked 2026-10-29)

1. Graph API changelog and version table (v23–v26 sunset dates), as summarised and cross-checked in [`docs/analysis/12-graph-changelog-check-2026-10.md`](../../analysis/12-graph-changelog-check-2026-10.md).
2. Pages API, deprecated Page insights metrics: `developers.facebook.com/documentation/pages-api/platforminsights/page/deprecated-metrics`. This covers the 2025-11-15 wave (`page_impressions` becomes `page_media_view`, paid traffic moves to an `is_from_ads` breakdown, fans become follows) and the June 2026 wave (unique impressions become `page_total_media_view_unique` / `post_total_media_view_unique`).
3. Messenger Platform, message tags: `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE` and `POST_PURCHASE_UPDATE` return code 100 since 2026-04-27. `HUMAN_AGENT` (7 days, App Review, not at Standard Access) and `CUSTOMER_FEEDBACK` (template-only, 7 days) are still documented. Utility message templates are the documented replacement.
4. Marketing API, Advantage+ audience (`targeting_automation.advantage_audience`): from v23.0 the field "either defaults to 1 or must be explicitly set to 1 or 0".
5. Marketing API changelog v24–v26: `is_adset_budget_sharing_enabled` (v24); creation, duplication and updates of Advantage+ shopping/app campaigns prohibited from 2026-05-19; async report-run error fields (v25); ads-insights lookback limits since 2026-01-12.
6. Marketing API, bidding: bid strategy and `bid_amount` semantics, where the campaign-level `bid_strategy` applies with a campaign budget (CBO); ad set `bid_amount` is the bid or cost cap per optimisation event.
7. Reels publishing guide (`/{page-id}/video_reels`, rupload, 30 per 24 h, 10 min – 29 days scheduling) and the Video API publishing guide (Resumable Upload API `/{app-id}/uploads`; legacy chunked `upload_phase=start|transfer|finish` on `graph-video`).
8. Graph API rate limiting: `X-App-Usage`, `X-Business-Use-Case-Usage`, `X-Ad-Account-Usage`, `x-fb-ads-insights-throttle`, `estimated_time_to_regain_access`.
9. The v3 scope and roadmap: [`02-v3-scope.md`](../../analysis/v3/02-v3-scope.md) §2.2, [`04-roadmap-and-risks.md`](../../analysis/v3/04-roadmap-and-risks.md), [`05-parallel-task-breakdown.md`](../../analysis/v3/05-parallel-task-breakdown.md).

---

## 1. Verdict

**Correct-with-changes.** The organic surface (posts, Reels, Stories, comments, Messenger, insights, the error matrix and rate handling) is unusually well aligned with Meta's documented behaviour for an implementation never run against the live API. The ads write surface carries four money- or targeting-semantics defects that must be fixed before 1.0. The dominant risk is still that nothing has been verified live.

- The organic path is platform-correct on paper. The scheduling windows (10 min – 75 days for the feed, 29 days for Reels and reschedules), the Reels rupload protocol, the 24 h Messenger window, the 2025-11 and 2026-06 insights renames and the 80000–80099 BUC range all match the current docs.
- **Ads targeting edit and duplicate can silently switch Advantage+ audience ON (v23+ default).** This is already live on the v26 pin, not a 2027-02-23 problem (META-01).
- The boost chain is structurally right (PAUSED, spend cap, DSA, creative opt-outs). However, it puts `bid_strategy` on a non-CBO campaign and tells the model that bids are "per 1000 impressions", which is wrong (META-03, META-04).
- The Page video upload is a hybrid of two Meta protocols that Meta does not document together, and is likely to fail on the first live run (META-02).
- No smoke covers the boost path, and the live gate items "L1–L8" are not written down as runnable checks with pass criteria. 1.0 cannot honestly claim platform correctness until §7 below is executed (META-05).

**Counts:** Blocker 0 · Major 5 · Minor 8 · Nit 4 (17 findings).

---

## 2. Status of the 2026-07 findings

| # | 2026-07 finding (sev.) | Status at `2c8d8bd` | Evidence |
|---|---|---|---|
| 1 | System-user token / Business Verification path unverified (Major) | **Open — unverified** | The doctor treats `business_management` as asset-scoped and over-scope (`src/mcp/doctor/credentials.ts:67`, `src/mcp/doctor/permissions.ts:13-15`). No smoke exercises a system-user token. Carried as META-11 and §7 step 2. |
| 2 | Insights "safe set" stale (Major) | **Resolved (on paper)** | Rename/removal table drives the request (`src/api/insights.ts:277-292`, `src/api/insights-schema.ts`). The posts default set uses `post_total_media_view_unique` (`src/api/insights-batch.ts:39`). `post_impressions` is filtered out with a note (`src/api/insights-batch.test.ts:130-142`). Live confirmation is pending (META-12). |
| 3 | ≥100-likes floor for Page insights (Minor) | **Resolved** | `PAGE_ELIGIBILITY_NOTE` (`src/api/insights.ts:105`) explains the floor and points to `fan_count` / `followers_count` and the ANALYZE task. |
| 4 | 30-day scheduling cap vs `/feed` 75 days (Minor) | **Resolved** | `SCHEDULE_MIN_LEAD_MS` 10 min, `SCHEDULE_MAX_LEAD_MS` 75 days, `RESCHEDULE_MAX_FROM_CREATION_MS` 29 days (`src/api/posts-write.ts:272-278`). The Reels-specific 29-day window is at `src/api/media-reels.ts:120`. |
| 5 | Throttle "80xxx" vague (Minor) | **Resolved** | BUC range 80000–80099 (`src/core/error-matrix.ts:336-344`). |
| 6 | Comment delete permission (Minor) | **Resolved** | `facebook_delete_comment` maps to `pages_manage_engagement` + `pages_read_user_content` (`src/mcp/doctor/permissions.ts:107`). |
| 7 | `video_upload_limits` field unconfirmed (Minor) | **Resolved by removal** | No reference left in `src/`. A different video-protocol risk replaces it (META-02). |
| 8 | Require App Secret vs Graph Explorer tokens (Minor) | **Resolved** | `appsecret_proof` is handled in `src/core/http.ts` and `src/core/settings.ts`. |
| 9 | Messenger automation disclosure (Minor) | **Open** | No disclosure guidance in `src/api/messaging.ts` or the messaging tools. Carried as part of META-06. |
| 10 | Polling cadence quota-aware (Minor) | **Partially resolved** | Usage headers are parsed and surfaced (`src/core/http.ts:28-33`, `src/tools/core.ts:843-844`). `X-Ad-Account-Usage` is missing (META-07). |
| 11 | ODAX phrasing (Nit) | **Resolved** | Boost uses only `OUTCOME_*` objectives (`src/api/ads-create.ts:42-60`). |
| 12 | Report raw ads tier header (Nit) | **Open** | `ads_api_access_tier` is never parsed (META-07). |
| 13 | Messenger changelog re-pull (Nit) | **Resolved** | Re-pulled 2026-10 (doc 12, N2). The tag guidance is slightly over-stated (META-06). |

---

## 3. Strengths to keep

- **Error matrix depth.** `src/core/error-matrix.ts` covers:
  - the 190 subcodes 460/463/464/467/492/459 (l.76–165);
  - 368 with no retry (l.215);
  - the 200/10/2xx permission family (l.232–260);
  - 4/17/32/613/341 (l.275–323) and the 80000–80099 BUC range (l.336–344);
  - the ads subcodes for budget-change frequency, spend limit and ads BUC (l.356–430);
  - the DSA rows (l.443–462) and 2635 version drift.

  This is better than most production Graph clients.
- **Server-authoritative backoff.** `src/core/http.ts:28-33,464,584` honours both `Retry-After` spellings and `estimated_time_to_regain_access`, with the unit handled explicitly.
- **Messenger window discipline.**
  - Only `messaging_type=RESPONSE` is sent (`src/api/messaging.ts:62,1156`).
  - A client-side window pre-check (l.611–690) refuses with a local `code:-1` (l.910) instead of burning a Graph call.
  - Window-closed errors are detected by subcode set and text fallback (l.733–746).
- **Reels protocol** matches the current guide exactly: start → rupload → finish, the 30-per-24 h cap (`src/api/media-reels.ts:128`), the host allowlist for `upload_url`, and the 10 min – 29 day window.
- **Ads safety rails.**
  - Everything is created PAUSED.
  - Copies use `status_option:'PAUSED'` and are re-verified and re-paused (`src/api/ads-copy.ts:571-590,656-745`).
  - ASC/AAC objects are refused (`src/api/ads-copy.ts:258`, `src/api/ads-control.ts:289-290`).
  - A spend cap is required and cannot be removed (`src/api/ads-control.ts:607-670`).
  - Budgets use minor units everywhere, with a 175% daily over-delivery envelope (`src/api/ads-money.ts:299,369`).
  - DSA payor and beneficiary are set for EU/EEA (`src/api/ads-create.ts:63,312-316`).
  - Every creative feature is opted out (`src/api/ads-create.ts:611-623`).
- **Version drift handling.** The separate ads pin plus 2635 / `X-Ad-Api-Version-Warning` detection is the right design for a Marketing API that sunsets roughly twice as fast as Graph.
- **Narrow targeting edit.** The read-modify-write refuses blobs it does not model (custom audiences, detailed targeting, exclusions, non-country geo — `src/api/ads-targeting.ts:192-208`). Keep this; it only needs the Advantage+ gap closed.

---

## 4. Findings

Ordered by severity. Each placement uses the task IDs of [`05-parallel-task-breakdown.md`](../../analysis/v3/05-parallel-task-breakdown.md), or **NEW** with the files it owns.

### META-01 — Targeting edit and duplicate can silently turn Advantage+ audience ON
- **Severity:** Major. Upgrade to **Blocker** if §7 step A3 shows Graph defaulting to 1.
- **Evidence:**
  - The targeting write is a read-modify-write (`src/api/ads-targeting.ts:6-7,300-360`, written by `POST /{adset_id}` at l.484–488). It replaces only countries and ages.
  - `advantageAudience()` returns `null` when `targeting_automation.advantage_audience` is absent (`src/api/ads-targeting.ts:181-185`). `complexityReasons` refuses only `=== true` (l.206). So a blob without the field is written back without it.
  - `copyRequest` (`src/api/ads-copy.ts:571-590`) sends no `targeting_automation` either.
  - Meta (source 4): from v23.0 the field "either defaults to 1 or must be explicitly set to 1 or 0". The server pins v26.
- **Impact:** For an ad set whose stored targeting lacks the field (older ad sets, or ones created in Ads Manager with the toggle untouched), a "change countries to BG" edit can either fail with a code-100 validation error or, worse, **succeed with audience expansion ON**. Spend then goes outside the stated countries and ages, which contradicts the narrow-edit promise. The same applies to `/copies` when Graph re-validates the copied ad set under v26 rules.
- **Recommendation:**
  1. When the field is absent, add `targeting_automation: { advantage_audience: 0 }` to the written blob, and say so in the preview ("Advantage+ audience: set explicitly OFF").
  2. Treat `null` as a third state in `summarizeTargeting` (`src/api/ads-targeting.ts:227`) and surface it in `facebook_get_ad_set_targeting`.
  3. For `/copies`, read back each copied ad set's `targeting.targeting_automation`, and flag or refuse if it is 1 where the source was 0 or absent.
  4. Add unit tests for absent → 0.
- **Placement:** 1.0 · Wave 2 · **L2.ads** (already lists "Explicit advantage_audience on duplicate and targeting edit (due 2027-02-23)"). **Change the due date to "now"**: it applies on the current v26 pin. The 2027-02-23 all-versions date could not be confirmed **[UNVERIFIED 2026-10-29]**. Owned files: `src/api/ads-targeting.ts`, `src/api/ads-copy.ts`, tests. Size **S**.

### META-02 — Page video upload mixes two Meta protocols
- **Severity:** Major **[UNVERIFIED 2026-10-29]**.
- **Evidence:** `src/api/media-video.ts:8-22`:
  - `start` is the legacy chunked flow (`POST graph-video/{page-id}/videos`, `upload_phase=start`, `file_size`; l.967–976).
  - `transfer` sends raw bytes to the **rupload host** at `/video-upload/{version}/{upload_session_id}` with a `file_offset` header (l.10–12, 165–175, 1127–1131).
  - `finish` uses `upload_phase=finish` (l.1333–1336).

  Meta documents (a) the legacy flow, where `transfer` is `upload_phase=transfer` + `upload_session_id` + `start_offset` + a multipart `video_file_chunk` on the **same** `graph-video` edge; (b) the Resumable Upload API (`/{app-id}/uploads` → handle); and (c) the Reels/Stories rupload flow, keyed by **video id** from `/video_reels`. Rupload keyed by an `upload_session_id` from the legacy `start` is not documented anywhere I found. The in-code note "the two differ only in WHERE the session is created" (l.19–22) understates the difference.
- **Impact:** `facebook_create_video_post` (and anything built on `media-video.ts`) is likely to fail on its first live transfer, with a 4xx from rupload or a session the `finish` call does not recognise. Doc 12 L4 tracks only the `upload_phase` deprecation question, not this protocol mix.
- **Recommendation:**
  1. Probe first (§7 step C4).
  2. If the hybrid fails, choose one documented flow. Prefer the legacy `upload_phase=transfer` on `graph-video` for a minimal change, or move to the Resumable Upload API, which is the only one in the current guide. The latter also lets L2.posts adopt `src/api/upload-session.ts` as deferred in Wave 0.
  3. Keep the server-authoritative offset logic either way.
- **Placement:** 1.0 · Wave 2 · **L2.posts** (owns `src/api/media-video.ts`, `src/api/upload-session.ts`). Size **M** (S if the probe passes).

### META-03 — Boost: `bid_strategy` on a non-CBO campaign
- **Severity:** Major **[UNVERIFIED 2026-10-29]**.
- **Evidence:** `boostStepBody` puts `bid_strategy` on the campaign with `is_adset_budget_sharing_enabled:false` (`src/api/ads-create.ts:574-583`). It puts `daily_budget`/`lifetime_budget` and optionally `bid_amount` on the **ad set** (l.585–594), and sends no `bid_strategy` there. In Meta's bidding model the campaign-level `bid_strategy` belongs to campaign budget optimisation; without a campaign budget the strategy is set on the ad set.
- **Impact:** Graph may (a) reject the campaign or ad set (a code-100 subcode about `bid_strategy` with ABO), or (b) accept it and ignore the campaign field. In case (b), a `COST_CAP` request with `bid_amount` is interpreted by the ad set's default strategy (bid cap or lowest cost). The operator then gets a different bidding regime than the preview promised, which is a silent money-semantics drift.
- **Recommendation:** Move `bid_strategy` to the ad-set body. Keep it off the campaign, or send it on the campaign only if the boost switches to a campaign budget (it should not). Add a read-back of `adset.bid_strategy` after create, plus a test asserting the body shape.
- **Placement:** 1.0 · Wave 2 · **L2.ads** (`src/api/ads-create.ts`, `src/tools/ads-create.ts`). Size **S**. Confirm with boost probe P3/P4 (§7 step D3).

### META-04 — Wrong `bid_amount` semantics ("per 1000 impressions")
- **Severity:** Major.
- **Evidence:** The preview warning (`src/api/ads-create.ts:494`), the summary line (`src/api/ads-create.ts:504`) and the tool argument description (`src/tools/ads-create.ts:174`) all say the bid/cost cap is "per 1000 impressions". Meta's `bid_amount` is the cap **per optimisation result**: per post engagement for `POST_ENGAGEMENT`, per link click for `LINK_CLICKS`, and for `REACH` per 1,000 people reached. `billing_event:'IMPRESSIONS'` (l.594) sets how Meta charges, not what the bid is denominated in.
- **Impact:** An agent that turns "I'll pay at most €0.20 per engagement" into a CPM-scale value, or the reverse, misprices the bid by roughly 1000× in either direction. Too low means no delivery; too high means overspend up to the spend cap. The tool description is what the model reads, so the wrong text shapes its behaviour directly.
- **Recommendation:** Derive the denominator from `optimization_goal`: "per engagement", "per link click", or "per 1,000 people reached". Fix all three strings and the description, and add a snapshot test of the preview text per objective.
- **Placement:** 1.0 · Wave 2 · **L2.ads**. Size **S**. Description text also touches C03/C06 consumers; coordinate with the manifest snapshot.

### META-05 — The live gate is undefined and the boost path has no smoke
- **Severity:** Major (process, platform correctness).
- **Evidence:**
  - The 1.0 exit criterion is "live gate L1–L8 and boost P1–P7 run" (`docs/analysis/v3/04-roadmap-and-risks.md:11`; U30 at `docs/analysis/v3/05-parallel-task-breakdown.md:224`).
  - In doc 12, L1–L4 are *changelog findings*, two of them already fixed (`docs/analysis/12-graph-changelog-check-2026-10.md:119-122,150-153`). They are not probes with pass criteria, and L5–L8 are not defined there.
  - P1–P7 exist only as prose (`docs/analysis/v2/features/ads.md:386-389`).
  - `scripts/smoke/smokes/ads.smoke.mjs` has `ads/read-surface`, `ads/hierarchy`, `ads/guardrails` and `ads/update-not-covered`, but **no boost smoke**. `grep boost scripts/smoke docs/runbooks` returns nothing.
- **Impact:** U30 cannot be executed deterministically or audited afterwards. The highest-risk tool (`facebook_boost_post`, money) and META-01..04 would be "verified" by ad-hoc clicks.
- **Recommendation:** Adopt §7 below as the canonical live gate. Give each step an ID, a smoke id and a pass criterion. Add a `boost.smoke.mjs` that is **budget-gated** (behind `--include-budget`, like the Reels smoke). It creates the full PAUSED chain against a test ad account with a minimal spend cap, asserts the body shape by read-back (bid_strategy level, advantage_audience 0, DSA fields, creative opt-outs), checks P4 (whether PAUSED ads enter review), and archives everything through the sweeper.
- **Placement:** 1.0 · Wave 3 · **I31** (smoke harness) + **U30** (owner run). NEW sub-item **I31b — `scripts/smoke/smokes/boost.smoke.mjs`, `scripts/smoke/sweepers/*` (ads archive), `scripts/smoke/README.md` live-gate table**. Size **M**.

### META-06 — Messenger tag guidance over-states "every tag fails"; no automation disclosure
- **Severity:** Minor.
- **Evidence:** `MESSAGE_TAG_GUIDANCE` (`src/api/messaging.ts:88-94`) says "Every message tag now hard-fails except HUMAN_AGENT". Per source 3, `CUSTOMER_FEEDBACK` (template-only) is still documented, and utility message templates are the sanctioned way to reach a user outside 24 h. HUMAN_AGENT's limits (7 days, human-sent only, App Review) are not stated. The prior review's #9 (disclose that replies are automated or assisted) is unaddressed.
- **Impact:** This is mostly accurate for what this server *can* send. However, the text is fed to the model as fact and will age badly, and the model may tell operators no out-of-window path exists at all. The missing disclosure is a Messenger policy and App Review risk for operators running it unattended.
- **Recommendation:** Reword to: "This server sends only RESPONSE messages. Outside 24 h Meta allows HUMAN_AGENT (7 days, human-sent, App Review) and template-based messages, neither of which this server supports." Add one line to the messaging tool description and `docs/` recommending a human-review or disclosure policy when replies are AI-drafted.
- **Placement:** 1.0 · Wave 2 · **L2.messages** (`src/api/messaging.ts`, `src/tools/messages*.ts`). Size **S**.

### META-07 — `X-Ad-Account-Usage` and the ads access tier are not parsed
- **Severity:** Minor.
- **Evidence:** The rate parser covers `X-App-Usage`, `X-Business-Use-Case-Usage` and `x-fb-ads-insights-throttle` (`src/core/http.ts:28-29,355-356`). There is no handling of `X-Ad-Account-Usage` (`acc_id_util_pct`, `reset_time_duration`, `ads_api_access_tier`). `grep` over `src/` for `ad-account-usage` / `ads_api_access_tier` returns nothing outside tests.
- **Impact:** Ads management calls throttle per ad account. `reset_time_duration` is the documented wait, and the Development vs Standard access tier changes the budget by orders of magnitude. Without them, backoff for ads writes falls back to row defaults (`src/core/error-matrix.ts:356-430`), and the doctor cannot tell an operator they are on development-tier limits.
- **Recommendation:**
  - Parse the header into the usage snapshot.
  - Prefer `reset_time_duration` for the ads retry-after.
  - Surface the raw `ads_api_access_tier` string in `facebook_rate_status` and the doctor. Do not map it to friendly names (prior #12).
- **Placement:** 1.x (does not block 1.0) · **P-wave / C-task owning `src/core/http.ts`**. Per the lane rules, `src/core/*` belongs to C/P/X/I tasks only, so make it **NEW P06 — `src/core/http.ts`, `src/tools/core.ts` (usage view), tests**. Size **S**. An earlier slot is fine if L2.ads needs it.

### META-08 — The doctor checks scopes but not Page tasks or the ads asset path
- **Severity:** Minor **[UNVERIFIED 2026-10-29 for exact task requirements]**.
- **Evidence:** `TOOL_PERMISSIONS` (`src/mcp/doctor/permissions.ts:58-166`) is scope-only. Page tasks (CREATE_CONTENT, MODERATE, MESSAGING, ANALYZE, ADVERTISE, MANAGE) appear only in prose: the private-reply comment at l.108 and the insights note at `src/api/insights.ts:105`. `facebook_boost_post` maps to `ads_management` + `pages_read_engagement` (l.163), with no ADVERTISE task, no `pages_manage_ads`, and no check that the ad account is reachable by the token's user or system user. Boost probe P1 ("minimum Page permission/task for `object_story_id`") is still open.
- **Impact:** The doctor can report "usable" for packages that will fail with 200/10 at call time, because a Page task is missing or the token's user lacks the ADVERTISE task. Error rows exist for the failure, but the doctor's promise is to catch this earlier.
- **Recommendation:**
  - Read `GET /me/accounts?fields=id,tasks` (already available with `pages_show_list`) and add a `requiredTasks` column per tool family (see §5).
  - For ads, probe `GET /act_<id>?fields=account_status,user_tasks` (or `users_v2`) once.
  - Add `pages_manage_ads` to the boost row only after P1 confirms it.
- **Placement:** 1.0 · Wave 2. Each lane owns its `src/mcp/doctor/<lane>.ts` probe. The shared column in `src/mcp/doctor/permissions.ts` goes to **L2.core**. Size **M** in total.

### META-09 — Boost always declares `special_ad_categories: []`
- **Severity:** Minor (policy).
- **Evidence:** `src/api/ads-create.ts:578`; header comment l.4.
- **Impact:** Boosting a post about housing, employment, credit, financial products, or social issues, elections and politics without the right category violates Meta's advertising policies. Meta's review usually rejects such ads, but repeated violations can restrict the ad account. An agent-driven boost makes this more likely than in a human UI that asks the question.
- **Recommendation:**
  - Add a preview warning listing the categories and requiring the operator to confirm none apply.
  - Optionally accept `special_ad_categories` plus `special_ad_category_country`, but refuse political or social-issue ads outright, since they need an authorised advertiser and a disclaimer.
  - Document this in the boost tool description.
- **Placement:** 1.0 · Wave 2 · **L2.ads**. Size **S**.

### META-10 — `promoted_object: { page_id }` for every boost objective
- **Severity:** Minor **[UNVERIFIED 2026-10-29]**.
- **Evidence:** `src/api/ads-create.ts:597` sends `promoted_object.page_id` for `OUTCOME_ENGAGEMENT`, `OUTCOME_TRAFFIC` and `OUTCOME_AWARENESS`. `destination_type:'ON_POST'` is sent only for engagement (l.595–596).
- **Impact:** For `LINK_CLICKS` and `REACH`, a `promoted_object.page_id` is not required and is sometimes rejected under ODAX ("promoted_object not supported for this optimization goal"). For `OUTCOME_TRAFFIC`, a destination type (`WEBSITE`) may be required.
- **Recommendation:** Probe per objective (§7 step D3). Send `promoted_object` only where Meta requires it, and set `destination_type` explicitly for traffic.
- **Placement:** 1.0 · Wave 2 · **L2.ads**. Size **S**.

### META-11 — System-user / BM-owned ad account path unverified; `business_management` shown as over-scope
- **Severity:** Minor.
- **Evidence:** `business_management` is deliberately excluded from every package (`src/mcp/doctor/permissions.ts:13-15`) and therefore surfaces as over-scope (`src/mcp/doctor/types.ts:383`). `ASSET_SCOPED_EXACT` (`src/mcp/doctor/credentials.ts:67`) treats it as asset-scoped.
- **Impact:** The recommended production setup (a system-user token on a Business-Manager-owned Page and ad account) commonly carries `business_management`. Flagging it as over-scope nudges operators to remove it, and it is needed to manage system-user asset assignments. That is not needed at runtime, but neither is it a smell. Prior #1 remains unverified.
- **Recommendation:** Report it as "setup-only (fine for system users)" instead of over-scope. Add §7 step A2 (system-user token end-to-end).
- **Placement:** 1.0 · Wave 2 · **L2.core** (`src/mcp/doctor/permissions.ts`, `src/mcp/doctor/index.ts`). Size **S**.

### META-12 — Insights replacements for video unique metrics and `page_daily_unfollows` are unconfirmed
- **Severity:** Minor **[UNVERIFIED 2026-10-29]**.
- **Evidence:**
  - The schema maps `post_video_views_unique` to a replacement (`src/api/insights-schema.test.ts:169`).
  - Doc 12 M1 (`page_daily_unfollows` not in the reference) is still open.
  - The June 2026 wave documents `*_total_media_view_unique` for impressions, but I could not find an explicit replacement for the video-unique family.
- **Impact:** C05's stable schema (V3-D10) promises 1.0 stability for these mappings. A wrong mapping ships a permanently mislabelled metric.
- **Recommendation:**
  - Mark any mapping not confirmed by a live probe as `status: 'unverified'` in the schema output.
  - Run §7 step B2 against a Page above the 100-likes floor.
  - Add a calendar check for the next insights wave, plausibly 2027 (§6).
- **Placement:** 1.0 · Wave 2 · **L2.insights** (`src/api/insights*.ts`). Size **S**.

### META-13 — The DSA error top-level code is assumed to be 100
- **Severity:** Minor **[UNVERIFIED 2026-10-29]**.
- **Evidence:** The DSA rows key on `100/3858079` and `100/3858081` (`src/core/error-matrix.ts:443-462`). Boost probe P7 is still open.
- **Impact:** If Graph returns these subcodes under a different code, the DSA guidance never fires and the model sees a generic validation error.
- **Recommendation:** Key the rows on the subcode alone (subcodes are globally unique in practice) with the code as a hint, or confirm with §7 step D4.
- **Placement:** 1.0 · Wave 1 · **C01** (owns `src/core/error-matrix.ts` changes via the error envelope). Size **S**.

### META-14 — Status and budget writes on existing ASC/AAC campaigns
- **Severity:** Minor **[UNVERIFIED 2026-10-29]**.
- **Evidence:** `src/api/ads-control.ts:289-290,470` refuses updates on `ADVANTAGE_PLUS_SALES/APP` but allows pause. Doc 12 L3: it is unknown whether `POST /{campaign-id}` status writes are also prohibited since 2026-05-19.
- **Impact:** Allowing pause is the right default: a failure is harmless, and pausing is the safety action.
- **Recommendation:** Probe (§7 step D6). If pause is rejected, map the subcode to "pause in Ads Manager".
- **Placement:** 1.0 · Wave 3 · **U30**. Size **S**.

### META-15 — `facebook_block_user` / `unblock_user` permission row
- **Severity:** Nit **[UNVERIFIED 2026-10-29]**.
- **Evidence:** Mapped to `pages_manage_engagement` only. The `/{page-id}/blocked` edge works on PSIDs (`src/api/comments.ts:20-21,1356`). Some docs list `pages_manage_metadata` or the MODERATE task as well.
- **Recommendation:** Confirm in §7 step C6 and adjust the row.
- **Placement:** Wave 2 · **L2.moderation**. Size **S**.

### META-16 — 190 subcodes 452 and 458 fall through to the generic 190 row
- **Severity:** Nit.
- **Evidence:** Specific rows exist for 459/460/463/464/467/492 (`src/core/error-matrix.ts:76-165`). 458 ("app not installed", meaning the user removed the app) and 452 (session invalid) fall to `auth-190` (l.165).
- **Recommendation:** Add 458 with "the Page admin removed the app; re-run onboarding". It is the most common real-world cause after password change and expiry.
- **Placement:** Wave 1 · **C01**. Size **S**.

### META-17 — The ads-insights 13-month limit and `reach`
- **Severity:** Nit **[UNVERIFIED 2026-10-29]**.
- **Evidence:** Doc 12 L2, partly fixed. `reach` is a default field, and whether it counts as a unique field for the 13-month limit is unknown (`src/api/ads-read.ts:1002`, `src/tools/ads.ts:201`).
- **Recommendation:** §7 step D5. If confirmed, refuse `since` older than 13 months when `reach` is requested.
- **Placement:** Wave 2 · **L2.ads**. Size **S**.

---

## 5. Permission / Page-task matrix check

Scopes are as coded in `src/mcp/doctor/permissions.ts:18-166`. "Task" is the Page task Meta requires for the acting user, which the doctor does not check today (META-08).

| Family (tools) | Coded scopes | Expected scopes (Meta, 2026-10) | Page task | Verdict |
|---|---|---|---|---|
| core (`get_page`, `list_pages`, rate/doctor) | `pages_show_list`, `pages_read_engagement` | same | any | OK |
| reader (posts, comments read) | + `pages_read_user_content` | same | any (CREATE_CONTENT/MODERATE for unpublished) | OK |
| posts write (feed, photos, video, Reels, Stories, schedule, edit, delete) | `pages_manage_posts`, `pages_read_engagement` | same | CREATE_CONTENT | OK. Add a task check. |
| insights (page, post, batch, report) | `read_insights`, `pages_read_engagement` | same | ANALYZE | OK. `read_insights` is asset-scoped (`credentials.ts:67`). |
| comments write (reply, edit, hide, like) | `pages_manage_engagement` | `pages_manage_engagement` (+ `pages_read_user_content` to read targets) | MODERATE | OK |
| comment delete | `pages_manage_engagement`, `pages_read_user_content` (l.107) | same | MODERATE | OK (prior #6 resolved) |
| private reply | `pages_messaging`, `pages_read_engagement`, `pages_read_user_content` (l.108) | same | MESSAGING | OK |
| block/unblock | `pages_manage_engagement` | likely + `pages_manage_metadata` **[UNVERIFIED]** | MODERATE | Probe (META-15) |
| moderation settings | `pages_manage_metadata` | same | MANAGE | OK |
| conversations / send / react / upload | `pages_messaging` (+ `pages_manage_metadata` for reads) | same; HUMAN_AGENT needs a separate feature | MESSAGING | OK |
| labels | `pages_manage_metadata` | `pages_manage_metadata` (probe P-6) | MESSAGING | OK pending probe |
| activity feed | `pages_read_engagement`, `pages_read_user_content`, `pages_messaging` | same | MODERATE + MESSAGING | OK |
| ads read (list, get, preview, insights, report status, targeting read) | `ads_read` | `ads_read` (+ ad account role) | — | OK |
| ads write (update, archive, delete, image, targeting, duplicate) | `ads_management` | `ads_management` (+ ad account ADVERTISE/MANAGE role) | — | OK. Add an account-role probe. |
| boost | `ads_management`, `pages_read_engagement` | + ADVERTISE task on the Page; possibly `pages_manage_ads` **[UNVERIFIED, P1]** | ADVERTISE | **Gap** (META-08) |
| page_admin (profile update) | `pages_manage_metadata`, `pages_read_engagement` | same | MANAGE | OK |
| saved replies (local) | none | none | — | OK |

App Review / Advanced Access: every scope above other than `pages_show_list` needs **Advanced Access** for Pages the app's developers do not own. `pages_messaging` and `ads_management` are the hardest reviews, and both need a screencast. HUMAN_AGENT is a separate feature review. Business Verification is a prerequisite for Advanced Access on `ads_management` and `pages_messaging`. The onboarding runbook should state that a self-hosted, single-owner operator can stay on **Standard Access** if every Page and ad account is owned by an app role holder. This is the cheapest path and the one most users of this MCP will take.

---

## 6. Meta calendar 2026-11 → 2028

| Date | Event | Source / confidence | Action in this repo |
|---|---|---|---|
| ongoing | advantage_audience explicit on v23+ (already applies on the v26 pin) | Meta doc, confirmed | META-01 now |
| 2026-11 → 2027-01 | Changelog check every ~4 weeks (`docs/runbooks/app-upkeep.md` §1) | runbook | Owner |
| 2027-01 | Expected Graph/Marketing v27 release (cadence ~Jan/May/Sep) | pattern **[PROJECTED]** | Diff the changelog; do not bump |
| 2027-02-23 | advantage_audience required on all versions (as recorded in v3 scope) | **[UNVERIFIED 2026-10-29]** | Superseded by META-01 |
| 2027 (H1?) | Next Page insights deprecation wave | pattern (2024-09, 2025-11, 2026-06) **[PROJECTED]** | L2.insights watch; C05 schema `status` |
| ≈2027-06 | Ads pin bump v26 → v27/v28 (A09) | v3 scope §2.2 | Wave 5 A09 |
| ≈2027-08 → 09 | Marketing API v26 sunset | **[PROJECTED]** | A09 must land before |
| 2027-10-08 | Graph v23 sunset | changelog, confirmed | none (pin v26) |
| 2028-02-18 | Graph v24 sunset | changelog, confirmed | none |
| H1 2028 | Second ads bump | v3 scope | Wave 6 |
| 2028-07-29 | Graph v25 sunset; `FB_API_VERSION=v25.0` fallback dies | changelog, confirmed | Remove the fallback note by 2028-06 |
| ≥ 2028-12 | Graph v26 sunset (not announced) | **[PROJECTED]** | Graph bump in Wave 6 |
| 12–18 months | Official Meta Pages MCP (R7) | v3 scope, opinion | Product decision |

---

## 7. Live verification plan

Run against a dedicated **test Page** (≥100 followers, needed for insights), a **test Messenger user** (an app role holder, for the 24 h window), and a **test ad account** with a minimal spend cap. Use the app in Development mode first, then repeat A1–A3 with a system-user token. Each step names its smoke (under `scripts/smoke/smokes/`) and a pass criterion. Record results in `docs/runbooks/app-upkeep.md` "Check log" and in U30.

**A. Credentials and doctor** (`core.smoke.mjs`, `docs/runbooks/onboarding.md`)
1. **A1** — User-token doctor run. Pass: every package `usable`, `scopesObserved=true`, `appsecret_proof` accepted.
2. **A2** — System-user token on a BM-owned Page and ad account. Pass: the same matrix, and `business_management` reported as setup-only after META-11.
3. **A3** — `GET /<adset>?fields=targeting` on an ad set created in Ads Manager with default settings. Pass: record whether `targeting_automation.advantage_audience` is absent, 0 or 1. This decides the META-01 severity.

**B. Insights** (`insights.smoke.mjs`)
1. **B1** — Page insights with `page_media_view`, `page_follows`, `page_total_media_view_unique`, period `day`. Pass: non-empty values, no code 100.
2. **B2** — Each mapped replacement in `src/api/insights-schema.ts` (including the video-unique family and `page_daily_unfollows`). Pass: Graph accepts each metric name, and the schema status matches the result.
3. **B3** — A Page under 100 likes. Pass: an empty result plus `PAGE_ELIGIBILITY_NOTE`.

**C. Organic writes** (`posts.smoke.mjs`, `reels.smoke.mjs`, `reels-lifecycle.smoke.mjs`, `moderation.smoke.mjs`)
1. **C1** — Feed post scheduled at +11 min and +74 days; reject at +9 min and +76 days locally. Pass: Graph accepts both edges.
2. **C2** — Reschedule beyond 29 days from creation. Pass: the local refusal matches the Graph error if bypassed.
3. **C3** — Reel start → rupload → finish → `status`, scheduled at +1 day. Pass: `video_status=ready`, `publishing_phase` scheduled.
4. **C4** — `facebook_create_video_post` with a 30 MB file and two chunks. Pass: the video is published. **On failure, run META-02 immediately.**
5. **C5** — Photo story and video story. Pass: a story id is returned and visible.
6. **C6** — Comment reply, hide, unhide, delete, block, unblock with the minimal scopes. Pass: each succeeds with the mapped scope set, and the META-15 row is confirmed.

**D. Ads** (`ads.smoke.mjs` + new `boost.smoke.mjs`, `--include-budget`)
1. **D1** — Read surface, plus a sync and an async insights run with the `report_run_id` polled to completion. Pass: `async_status` reaches `Job Completed`, and the v25 error fields are parsed on a forced failure.
2. **D2** — Targeting edit on the A3 ad set. Pass: read-back shows `advantage_audience=0` and only countries and ages changed.
3. **D3** — Boost dry run, then create for each objective (engagement, traffic, awareness) with `COST_CAP`. Pass: all four objects are PAUSED; read-back shows `bid_strategy` on the ad set (META-03); `promoted_object` and `destination_type` are accepted (META-10); the creative opt-outs are accepted (P2); the preview text uses the correct bid unit (META-04).
4. **D4** — Boost targeting the EU without DSA defaults. Pass: the matrix maps the DSA error, and the observed top-level code is recorded (META-13).
5. **D5** — Ads insights with `reach` and `since` 14 months back. Pass: the behaviour is recorded (META-17).
6. **D6** — Pause an existing ASC campaign (if one is available). Pass: the behaviour is recorded (META-14).
7. **D7** — Duplicate an ad set (deep copy). Pass: the copies are PAUSED and `advantage_audience` matches the source.
8. **D8** — Sweep: archive or delete every created ads object. Pass: zero ACTIVE objects remain, and spend is 0.

**E. Messenger** (`messages.smoke.mjs`)
1. **E1** — Send inside 24 h. Pass: a `message_id` is returned.
2. **E2** — Send outside 24 h. Pass: local refusal with `code:-1`; when forced through Graph, the window subcode maps to `MESSAGE_TAG_GUIDANCE`.
3. **E3** — Private reply to a comment under 7 days old. Pass: success. Over 7 days: the mapped error.

**F. Rate limits** (all smokes)
1. **F1** — Check that `facebook_rate_status` shows app, BUC and ads-insights usage after the run, and ad-account usage after META-07.

Gate: A1, A3, B1, C1, C3, C4, D2, D3, D8, E1 and E2 must pass for 1.0. The rest must be recorded, with the finding updated or closed.

---

## 8. Roadmap critique and owner decisions

**Critique.**
1. **advantage_audience is mis-dated in the roadmap.** L2.ads carries it as "due 2027-02-23", but it already applies on the pinned version. It belongs at the head of L2.ads, before any other ads work merges (META-01).
2. **The live gate is a label, not a plan.** "L1–L8" refers to changelog rows of which half are already fixed, and "P1–P7" is prose in a v2 feature doc. U30 should point to §7 (or a copy of it in `scripts/smoke/README.md`). I31 must deliver the boost smoke, or the money tool ships unverified.
3. **The live gate comes too late.** Running it only in Wave 3 means META-02/03 failures are found after the C03 outputSchema and C05 stable schema freeze. Run a **thin live pass (A1, A3, C4, D3) at the start of Wave 2**. It costs about an hour of owner time and de-risks three lanes.
4. **Insights stability is promised (V3-D10) on unverified mappings.** Either run B2 before 1.0 or let the schema carry an `unverified` status, so 1.0 does not freeze a guess.
5. **Ads pin bump A09 (≈2027-06) is in Wave 5 (2.x).** That is fine, but add a calendar reminder to the app-upkeep runbook for 2027-04, so that Marketing v27's breaking items get two months of lead time.
6. **R7 (official Meta Pages MCP)** is rightly a product risk. The differentiators that survive it are the safety rails (PAUSED-only, spend-cap enforcement, window discipline, the error matrix). Keep investing there, not in surface breadth.

**Owner decisions needed.**
- **D-META-1:** Fix META-01 now (pre-L2 hotfix on `main`) or at the head of L2.ads? Recommendation: hotfix now. It is a small change with real spend risk.
- **D-META-2:** For the Page video upload, keep the legacy flow (fix the transfer step) or move to the Resumable Upload API? Recommendation: decide after C4; prefer the Resumable Upload API if C4 fails.
- **D-META-3:** Boost: accept `special_ad_categories` as input, or only warn and refuse political or social-issue content? Recommendation: warn plus refuse in 1.0, and accept the input in 2.x.
- **D-META-4:** Approve the thin early live pass (A1, A3, C4, D3) at the start of Wave 2, using the test ad account with a spend cap of at most 1 unit of the account currency.
- **D-META-5:** Document Standard Access (single owner) as the primary supported mode, with Advanced Access and App Review as an optional path. This affects onboarding docs and the doctor wording.
