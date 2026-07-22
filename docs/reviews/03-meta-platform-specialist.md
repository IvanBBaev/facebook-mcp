# Review — Senior Meta Platform Specialist

Reviewed 2026-07-21 against Graph API v25.0. Scope: `docs/analysis/` (focus 03, 04,
06, 07) with `docs/ai/research/` as evidence base. Load-bearing claims were
spot-verified against live developers.facebook.com pages where I doubted them;
each finding notes what was verified live vs. what remains unverifiable (several
Meta docs/Help Center pages render via JS and resist programmatic fetching).

## Verdict

This is one of the most factually accurate pre-code Meta API analyses I have
reviewed: of the several dozen platform claims I checked live, nearly all held —
including the subtle ones (photos `caption` vs deprecated `message`; the real
30-vs-75-day scheduling contradiction between the Pages guide and the `/feed`
reference; the PagePost "Only select developers" DELETE note; edit-only-own-app;
Reels 3-phase flow with `PUBLISHED|SCHEDULED|DRAFT`, 10-min–29-day window and the
30-posts/24h moving cap; Pages BUC `4800 × engaged users`; the message-tag hard
fail dates of 2026-01-12/2026-04-27; private-reply one-shot/7-day; ODAX-only
objectives; Standard-Access-no-review for app-role users). The design decisions
built on top (pass-through metrics, expect-DELETE-to-fail, conservative windows,
header-driven backoff) are the right platform-native instincts. Two things keep
this from a clean go: (1) the primary credential path — the never-expiring System
User token — rests on a Business-Manager prerequisite (system-user creation
without Business Verification) that neither the corpus nor I could verify from
Meta's docs, and the corpus states "no Business Verification" categorically; and
(2) the insights "safe metric set" in 03 is internally unreconciled with the
corpus's own v25-changelog research and is partially stale now that the
2026-06-15 wave has landed. Both are cheaply de-risked before/at Phase 0–1.
**Go with changes** — no finding invalidates the architecture; the Majors are
un-derisked assumptions, not wrong facts baked into the design.

## Strengths worth keeping

- **Pass-through-not-whitelist for insights metrics** (03 §Insights, 06
  `facebook_page_insights`). Given three deprecation waves in 26 months and
  internally inconsistent Meta docs (confirmed: the live Page Insights reference
  still lists `page_impressions` variants as "deprecated above v25" while vendor
  trackers treat them as dead), refusing to hardcode a strict whitelist is the
  single most important insights decision, and it is correct.
- **Photos param fact is right where most wrappers get it wrong**: verified live —
  `caption` is the text param, `message` is explicitly "Deprecated. Please use
  the caption param instead" (https://developers.facebook.com/docs/graph-api/reference/page/photos/).
  `unpublished_content_type` (SCHEDULED) and `published`/`temporary` all confirmed.
- **The scheduling-window discrepancy is real and correctly flagged** (03, 07):
  verified `/feed` reference says 10 min–**75 days**
  (https://developers.facebook.com/docs/graph-api/reference/page/feed/) while the
  Pages posts guide says 10 min–**30 days**
  (https://developers.facebook.com/docs/pages-api/posts/). Most corpora would
  have silently picked one.
- **Reels facts fully verified** (https://developers.facebook.com/docs/video-api/guides/reels-publishing):
  3-phase start/rupload/finish, `video_state` PUBLISHED|SCHEDULED|DRAFT,
  scheduling ">10 minutes and within 29 days", **"30 API-published posts within a
  24-hour moving period"**, 9:16 / min 540×960 / 3–90 s. Client-side budget
  enforcement of the 30/24h cap is the right call.
- **Edit/delete asymmetry handled honestly**: verified "An app can only update a
  Page post if the post was made using that app" (Pages posts guide) and the
  PagePost DELETE note **"Only select developers can perform this operation using
  the API"** (https://developers.facebook.com/docs/graph-api/reference/pagepost/).
  06's `facebook_delete_post` caveat is exactly right. Also verified there:
  "This endpoint does not return Reels" → `/video_reels`, matching 03.
- **Reading facts verified**: `/feed` reference confirms "approximately 600
  ranked, published posts per year" and `limit` max 100; `scheduled_posts` edge
  exists on the Page node; `has_transitioned_to_new_page_experience` is a real
  Page field. Never-persist-cursors matches Meta's own guidance.
- **Permission dependency chains match the live permissions reference**
  (https://developers.facebook.com/docs/permissions/): `pages_manage_posts` →
  `pages_read_engagement` + `pages_show_list`; `pages_manage_engagement` →
  `pages_read_user_content`; `pages_messaging` → `pages_manage_metadata`;
  `read_insights` → `pages_read_engagement`. The CREATE_CONTENT task requirement
  for publishing is confirmed in the Pages posts guide. The doctor-validates-
  matrix-against-`granular_scopes`+Page-`tasks` design (04) is the best
  operator UX I've seen proposed for this.
- **"No App Review at Standard Access for app-role users" is correct**: verified
  the access-levels doc — "Permissions with Standard Access can only be
  requested from app users who have a role on the requesting app" and all
  Business apps are "automatically approved for Standard Access for all
  permissions and features"
  (https://developers.facebook.com/docs/graph-api/overview/access-levels/).
- **Messaging policy facts are current**: message tags ACCOUNT_UPDATE /
  POST_PURCHASE_UPDATE / CONFIRMED_EVENT_UPDATE deprecated 2026-01-12 and
  **hard-fail with error 100 since 2026-04-27** — corroborated by multiple
  vendors and live breakage reports (e.g.
  https://github.com/chatwoot/chatwoot/issues/14674). Limiting v1 to
  RESPONSE-type sends inside the 24h window, with HUMAN_AGENT explicitly out of
  scope (App Review), is the only policy-safe design today. Private replies
  verified: one per comment, within 7 days of creation, `recipient={comment_id}`,
  MESSAGING task + `pages_messaging`, cannot target another Page
  (https://developers.facebook.com/docs/messenger-platform/discovery/private-replies/).
- **Rate-limit model verified** (https://developers.facebook.com/docs/graph-api/overview/rate-limiting/):
  Pages BUC "Calls within 24 hours = 4800 × Number of Engaged Users" with
  Page/System tokens (Platform limits with app/user tokens); ads formulas
  `300 + 40×active_ads` (dev tier) and `600 + 400×active_ads − 0.001×user_errors`
  (insights); headers and `estimated_time_to_regain_access` as described.
  Parsing both headers plus `x-fb-ads-insights-throttle` and soft-backoff at 90%
  is exactly what Meta's own guidance implies and almost nobody implements.
- **ODAX-only objectives verified** via the v21.0 changelog: "Beginning with
  v21.0, you will no longer be able to create new ad sets or ads with
  non-Outcome-Driven Ad Experience (ODAX) objectives"
  (https://developers.facebook.com/docs/marketing-api/marketing-api-changelog/version21.0/).
  `special_ad_categories` required, DSA payor/beneficiary for EU, minor-unit
  budgets, `effective_status`-not-`status` — all consistent with current docs.
- **The official Meta Ads MCP claim holds** (launched ~2026-04-29, 29 tools,
  `mcp.facebook.com/ads`, Business OAuth — multiple independent third-party
  confirmations, e.g. https://ppc.land/meta-opens-ads-mcp-to-any-app-cutting-integration-code-to-zero/),
  which validates 02's decision to ship ads as an off-by-default package. Notably,
  coverage also reports Meta restricting accounts that used unregistered
  token-paste tooling against the Marketing API — using the operator's own
  registered app, as designed, is exactly the mitigation.
- **Honest uncertainty tracking**: the research files' [UNCERTAIN]/[FLAG] markers
  and 07's "re-verify at build time" list are the right way to handle a platform
  whose docs contradict themselves. Several items I checked (e.g. NPE
  `private_reply_conversation` null) are correctly pre-flagged rather than
  asserted.

## Findings

1. **Major — The primary token path rests on an unverified Business Manager
   prerequisite (system-user creation vs. Business Verification).**
   04 asserts "**No App Review, no Business Verification**" while making the
   never-expiring System User token the *primary* credential — which requires
   creating a system user in a Business portfolio and claiming the app into it.
   The no-App-Review half is verified (see Strengths). The no-Business-
   Verification half I could **not** verify for the system-user step: the
   system-users doc (https://developers.facebook.com/docs/business-management-apis/system-users/)
   and the Business Help Center article on system users resisted programmatic
   fetching, and there are recurring community reports (2023–2025) of the
   "Add system user" flow being gated behind Business Verification for some
   (especially new/low-history) portfolios. An older Marketing API SMB page also
   states "Only apps with Ads Management API standard access and above can be
   installed" for system users — almost certainly stale, but unrefuted.
   *Recommendation:* (a) soften 04's categorical claim to "no App Review;
   Business Verification is not expected for this path but must be confirmed for
   the operator's portfolio"; (b) add a **day-0 manual gate before Phase 0**:
   actually mint the never-expiring system-user token with the full scope list in
   the real portfolio, and only then treat it as the primary path; (c) keep the
   long-lived Page token fallback documented as first-class (it needs no
   Business Manager at all), which the corpus already does well.

2. **Major — The insights "safe metric set" (03) is unreconciled with the
   corpus's own research and partially stale post-2026-06-15.**
   Three problems: (a) 03's list includes the video-views family
   (`page_video_views*`, `post_video_views`, `post_video_avg_time_watched`)
   without noting the 2026-06-15 wave hit video metrics too — vendor deprecation
   trackers (e.g. https://docs.emplifi.io/platform/latest/home/facebook-metric-deprecation-june-2026)
   confirm unique/3-second video-view metrics were removed in June 2026 with
   media-view/media-viewer replacements and *no replacement* for some; whether the
   non-unique `page_video_views` totals survived is exactly the kind of thing the
   corpus should not assert without a live probe. (b)
   `docs/ai/research/meta-auth-permissions.md` §7 says the v25.0 changelog names
   `page_total_media_view_unique` / `post_total_media_view_unique` as the
   replacement "viewer" metrics — these names appear nowhere in 03's safe set;
   the two research files were never reconciled. (c) The research claim that the
   2025-11-15 wave made old names invalid "on all versions" is overstated: the
   live Page Insights reference still documents `page_impressions_unique` etc. as
   "Deprecated above Graph API v25" (i.e., version-dependent), while
   `page_media_view`, `post_media_view`, `page_follows`, `page_daily_follows`,
   `page_post_engagements`, `page_views_total` are confirmed present
   (https://developers.facebook.com/docs/graph-api/reference/page/insights/).
   The Nov-2025 replacement story itself (impressions→media_view, fans→follows)
   is well corroborated. The pass-through design decision absorbs most of this —
   but 03 presents the list as "build only on the current set", and 06/08 bake
   specific names into tool descriptions and the Phase 1 gate.
   *Recommendation:* demote the 03 list to "candidate examples, live-verified at
   Phase 1"; add a doctor/Phase-1 step that probes each documented example metric
   against the real Page and generates the README metric table from the probe;
   reconcile the two research files (or record the contradiction explicitly in
   07's re-verify list, which currently omits the metric-name question entirely).

3. **Minor — The ≥100-likes floor can fail the Phase 1 gate and confuse the
   doctor on small Pages.**
   Verified: "Page Insights data is only available on Pages with 100 or more
   likes" (Page Insights reference). 03 records the constraint, but nothing
   connects it to 08's Phase 1 gate ("pull `page_media_view` + `page_follows`
   without errors") or to 06's insights tools — on a Page under 100 likes the
   gate fails with correct code, and the secondary audience (other Page admins)
   will hit this in the wild. *Recommendation:* have `facebook_whoami`/doctor and
   the insights tools' error mapping detect the small-Page case (fan/follower
   count) and say so explicitly; annotate the Phase 1 gate with this precondition.

4. **Minor — Hard-enforcing the ~30-day scheduling bound client-side blocks
   schedules the API accepts.**
   Verified: the `/feed` reference currently states 10 minutes–**75 days**; only
   the Pages guide says 30. 03 says "enforce the conservative bound", which
   contradicts the corpus's own pass-through philosophy and would reject valid
   31–75-day schedules. *Recommendation:* hard-validate only the 10-minute lower
   bound and the Reels 29-day cap (both verified); for feed/photos, warn above
   30 days and let the API arbitrate, surfacing its error readably. Update 03/06
   wording accordingly.

5. **Minor — The throttle retry matrix enumerates only three of the 80xxx BUC
   codes.**
   05's retry matrix lists 4, 17, 32, 613, 80001, 80004, 80000. The rate-limiting
   doc defines additional BUC error codes for other use cases (custom audiences,
   leadgen, messaging/Instagram families — 80002, 80003, 80005, 80006, …), and
   this server's own scope will plausibly hit at least the custom-audience code
   (deferred phase) and possibly a messaging-family code under conversation
   polling. *Recommendation:* treat `code === 4 || 17 || 32 || 613 || (80000 ≤
   code < 80100)` as the throttle family instead of enumerating; keep the
   specific trio in docs as the expected common cases. Verify the exact 80xxx
   table during Phase 0 (the doc page renders fully in a browser).

6. **Minor — Comment-deletion permission mapping in 04 is imprecise.**
   The live permissions reference puts "Delete comments posted by users on your
   Page" under **`pages_read_user_content`**, while `pages_manage_engagement`
   covers creating/updating/deleting the *Page's own* comments and likes. 04's
   matrix maps reply/hide/delete uniformly to `pages_manage_engagement` +
   MODERATE. No functional gap (both scopes are requested), but the doctor's
   "exactly which tools will and won't work" promise and the error-hint mapping
   would misdiagnose a missing-`pages_read_user_content` case.
   *Recommendation:* split the moderation row in 04's matrix: delete-user-comment
   → `pages_read_user_content` (+ MODERATE task); Page-own-comment ops →
   `pages_manage_engagement`.

7. **Minor — `video_upload_limits` could not be confirmed as a Page node field.**
   03/06 plan `GET /{page-id}?fields=video_upload_limits` at runtime. My check of
   the Page node reference's field list did not find it (it may exist only in the
   Video API publishing guide, be recently renamed, or the page rendered
   incompletely — the research file itself marks video limits [UNCERTAIN]).
   *Recommendation:* keep the runtime-query design (it is right in spirit), but
   code it to degrade gracefully if the field errors, falling back to documented
   conservative defaults; add the field's existence to 07's re-verify list
   explicitly (currently only "actual values for the target Page" is listed,
   which presumes the field exists).

8. **Minor — "Require App Secret" breaks Graph API Explorer calls used by the
   fallback token path.**
   04 (correctly) recommends enabling App Settings → Advanced → "Require App
   Secret". Side effect not noted anywhere: once enabled, calls without
   `appsecret_proof` are rejected — including requests made from the Graph API
   Explorer, which is the documented fallback acquisition/debug path (04 §Token
   strategy, meta-auth-permissions.md §5). Token *generation* in the Explorer
   still works; test *calls* from it will fail. *Recommendation:* document the
   trade-off in 04 and in the eventual setup guide ("enable after you have your
   token working, or temporarily toggle for Explorer debugging").

9. **Minor — Messenger automation-disclosure policy is unaddressed.**
   Meta's Messenger Platform policies require that people know when they are
   interacting with automation. An MCP tool that lets an AI agent answer Page
   messages is an automated experience from the end-user's perspective, even if a
   human operator triggers it. Enforcement risk at single-operator scale is low,
   but this is the one place the tool catalog touches real policy exposure beyond
   rate limits. *Recommendation:* add a short policy note to the `messages`
   package docs (and 07's platform-risk table) recommending the operator disclose
   automation in conversations where replies are agent-generated; no code change
   needed.

10. **Minor — Polling cadence guidance should be explicitly quota-aware, not a
    fixed interval.**
    Pages BUC scales with *engaged users* (verified formula). A quiet Page with
    ~1 engaged user gets ~4,800 calls/24h; 30-second conversation polling alone
    is 2,880 calls/day — more than half the quota before any other tool runs.
    The corpus's header-driven backoff (05) already mitigates, but 07/R3's
    "documented polling intervals (≥30–60 s)" reads as a static default.
    *Recommendation:* make the documented default 60–120 s and state that the
    effective interval adapts to `X-Business-Use-Case-Usage` percentages; this
    also directly serves success criterion 4 ("must not get the user's app
    restricted").

11. **Nit — ODAX phrasing: "since v21.0" is about ad sets/ads.**
    The v21.0 changelog wording (verified) blocks creating new *ad sets or ads*
    with non-ODAX objectives; campaign-level legacy creation was constrained
    earlier in the ODAX migration. Irrelevant at pinned v25 (ODAX-only either
    way), but `marketing-api-messenger.md` A2's "ODAX only since v21.0 for new
    campaigns" is loose. *Recommendation:* reword to "ODAX-only at v25 (legacy
    objectives unusable for new objects since v21 at the latest)".

12. **Nit — Ads access-tier naming drift.**
    The live rate-limiting page now brands the lower/upper ads tiers with
    Standard/Advanced-style labels for the same formulas the corpus calls
    "development/standard tier" (the research file already notes "naming in
    flux"; the header value is `ads_api_access_tier: development_access |
    standard_access`). Behavior is unchanged and the corpus's formulas are
    verified correct. *Recommendation:* in docs and the `facebook_usage` tool,
    report the raw `ads_api_access_tier` header value rather than a
    corpus-invented tier name.

13. **Nit — The Messenger Platform changelog is reachable again.**
    Both research files note the official changelog 500'd during research and
    lean on vendor corroboration (which I independently confirmed). The page
    (https://developers.facebook.com/docs/messenger-platform/changelog/) resolves
    now. *Recommendation:* re-pull it once in a browser before Phase 3 to close
    the `CUSTOMER_FEEDBACK` tag question on primary evidence — it is already on
    07's re-verify list.

**Explicitly not findings (verified correct, recording for the consolidation):**
photos ≤10 MB/format list; multi-photo unpublished+`attached_media` flow with
`unpublished_content_type=SCHEDULED`; `child_attachments` 2–5; 90-day insights
window and 2-year retention; CARE-folds-into-LIKE; hide-not-delete default;
Page-token-required-for-comments (consistent with documented behavior, not
independently re-verified); `/blocked` PSID support (research-flagged, not
independently verified — fine as flagged); ASC/AAC merge deferral (07/R5 handles
it correctly — the planned `facebook_create_campaign` creates standard ODAX
campaigns, which is the shape that *survives* the merge).

## Open questions for the author

1. Have you actually created the system user and minted the never-expiring token
   in your real Business portfolio yet? If not, do it before Phase 0 (Finding 1)
   — it is a 15-minute check that de-risks the entire auth design, and it will
   also answer whether your portfolio hits a verification gate.
2. Which Business portfolio will own the app, and is the app already claimed
   into it? (The claim/install prerequisite is a one-way door worth doing early.)
3. Does your target Page have ≥100 likes today? If not, the Phase 1 insights
   gate needs a different Page or a rewritten gate (Finding 3).
4. For the scheduling window: do you accept warn-and-pass-through above 30 days
   (Finding 4), or do you have a product reason to hard-cap?
5. Will the README/tool-description metric examples be generated from a live
   probe of the operator's Page (Finding 2), or hand-maintained? The manifest
   snapshot test could cover the probe output cheaply.
6. Is there any intent to pursue HUMAN_AGENT via App Review later? If yes, the
   Business Verification question in Finding 1 becomes worth answering
   thoroughly now rather than twice.
7. The corpus pins v25.0 (dies ~2028). Who owns the "changelog check ritual each
   version bump" (07/R1) operationally — a release-checklist item, a CI reminder,
   or the worklog? It is currently stated but unassigned.
