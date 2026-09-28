# 03 — Meta API Landscape (the facts the design depends on)

Synthesized from official Meta docs research, 2026-07-21 (revised 2026-07-22 after
the role reviews). Items the docs leave ambiguous are tracked in
[07-risks-and-open-questions.md](07-risks-and-open-questions.md); facts that can
only be confirmed against a live Page/portfolio are marked ✎ with their phase.

## Versioning

- **Pin Graph API v23.0** as a config constant (`FB_API_VERSION`, default
  `v23.0` — the shipped value in `src/core/settings.ts`). Versions live ~2 years;
  releases every 3–5 months. Marketing API shares the same version track and
  URLs.
- Base hosts: `graph.facebook.com` (everything), `graph-video.facebook.com`
  (video file upload), `rupload.facebook.com` (Reels binary upload). These three
  hosts define the SSRF allowlist.

## Tokens (which credential the endpoints accept)

- Every Page endpoint below — publish, read, moderate, message, insights —
  authenticates with a **Page access token**; that is the credential the Graph
  API actually checks. The design treats two acquisition paths as **first-class**
  (neither is a footnote):
  - **Long-lived Page token** exchanged from a user token (~60-day lifetime,
    re-derivable, needs no Business Manager or portfolio setup). This is the
    documented first-class fallback.
  - Page token **derived from a never-expiring System User token**
    (`GET /{page-id}?fields=access_token` on the system user). Lower-maintenance,
    but it assumes a system user can be created **without Business Verification** —
    Meta's docs do not state this unambiguously and it varies by portfolio.
    ✎ Confirm against the operator's own portfolio at build time (day-0 gate)
    before treating it as primary; do **not** assert "no Business Verification"
    categorically.
- The per-page resolver (derive → cache → invalidate-on-190 → re-derive once,
  verified by the doctor) is an architecture concern — see
  [04-auth-and-security.md](04-auth-and-security.md) and
  [05-architecture.md](05-architecture.md). The only API-level fact here is that
  the token is Page-scoped and identical across the read, write, and insights
  edges.

## Publishing (Pages only)

- No personal-profile publishing; no Groups. Page posts require a **Page token**
  (user must hold the `CREATE_CONTENT` Page task) + `pages_manage_posts`.
- **Feed:** `POST /{page-id}/feed` — `message` or `link`; `child_attachments`
  (2–5) for carousels; `attached_media` for multi-photo; link-preview overrides
  only honored for verified domains (treat as best-effort).
- **Photos:** `POST /{page-id}/photos` — text param is **`caption`** (`message`
  is deprecated); `url` or multipart `source`; ≤10 MB. Multi-photo = upload each
  `published=false`, then `/feed` with `attached_media`; scheduled multi-photo
  additionally needs `unpublished_content_type=SCHEDULED`.
- **Video:** `POST /{page-id}/videos` on graph-video; modern path is the
  Resumable Upload API (`/{app-id}/uploads` session → chunked upload →
  `fbuploader_video_file_chunk`). Graph v25 rejects `video_upload_limits` on the
  Page node, so do not request it as metadata; keep local validation conservative
  and surface Meta's upload validation errors readably. Request `publish_video`
  permission defensively.
- **Reels:** 3-phase `/{page-id}/video_reels` flow (start → rupload binary →
  finish with `video_state PUBLISHED|SCHEDULED|DRAFT`). Specs: 9:16, min 540×960,
  3–90 s; scheduling window is **>10 min and within 29 days** (its own cap,
  tighter than feed — verified). **Hard limit: 30 API-published Reels per rolling
  24 h.** Reels do not appear on post read endpoints — read via `/video_reels`.
- **Scheduling:** `published=false` + `scheduled_publish_time`. The `/feed`
  reference documents a **10 min–75 day** window; the Pages posts guide says
  10 min–30 days (docs conflict — both verified live). Hard-validate only the
  **10-minute lower bound**; above 30 days, *warn* and let the API arbitrate
  (surface its error readably) rather than hard-capping — a client cap would
  reject the 31–75-day schedules the API actually accepts, contradicting the
  pass-through philosophy. Reels carry their own tighter **29-day** cap (see
  Reels). Queue readable via `GET /{page-id}/scheduled_posts`.
- **Edit/delete:** `POST /{page-post-id}` works only on posts created by the same
  app (also `is_hidden`, `is_pinned`). DELETE is documented inconsistently —
  expect it to work for app-created posts, surface failures cleanly otherwise.
- **No idempotency keys — write outcomes can be ambiguous.** Graph has no
  idempotency key on any publishing or messaging POST (`/feed`, `/photos`,
  `/videos`, `/video_reels`, and `/messages` under Messenger). A POST whose body
  reached the socket but whose response was lost (transport error / timeout /
  5xx) has an **unknown outcome** — it may have succeeded — so such writes are
  **never** auto-retried: the tool returns "unknown outcome — do not retry
  blindly; verify via the relevant read edge (`/published_posts`,
  `/scheduled_posts`, or `/conversations`)." A blind re-publish surfaces as
  **error 506 (duplicate status)**. Only requests Meta rejects *before*
  processing — body-coded throttles (see Rate limits) — are safe to retry. The
  concrete retry matrix lives in [05-architecture.md](05-architecture.md).

## Reading

- **`GET /{page-id}/published_posts`** is the canonical "list my posts" edge
  (supports `summary=total_count`); `/feed` includes visitor/tagged content;
  `/posts` is own-posts. Caps: `limit ≤ 100`, ~600 ranked posts/year.
- Single post: `GET /{page-id}_{post-id}?fields=...` — useful fields:
  `permalink_url, is_published, status_type, shares, attachments, full_picture,
  scheduled_publish_time, is_hidden`.
- **Pagination is cursor-based** (`paging.cursors.before/after`). Never persist
  cursors; absence of `paging.next` is the only end-of-data signal.
- Reading Pages you don't manage requires Page Public Content Access (App
  Review) — out of scope.

## Insights (heavily changed 2024–2026)

- `GET /{page-id|post-id}/insights?metric=...` — `metric` is mandatory (error
  3001). Needs `ANALYZE` Page task + `read_insights`. Page needs ≥100 likes;
  90-day max query window; 2-year retention.
- Three deprecation waves (2024-03, 2024-09, 2025-11) removed the impressions and
  fans families (impressions → media-view, fans → follows); **2026-06-15** removed
  remaining unique variants and **hit the video-views family too** (unique /
  3-second video-view metrics went away, some with no replacement). Metric names
  are also **version-dependent**: the live Page Insights reference still documents
  e.g. `page_impressions_unique` as "deprecated above v25", so validity turns on
  the pinned `FB_API_VERSION`, not just the calendar.
- Treat the following as **candidate examples, live-verified at Phase 1** (✎) —
  **not** a hardcoded "safe set": `page_media_view`, `post_media_view`,
  `page_follows`, `page_daily_follows`, `page_post_engagements`,
  `page_views_total`, `post_clicks`, `post_reactions_*_total`,
  `post_activity_by_action_type`, `content_monetization_earnings`, and the
  **video-views names** (`page_video_views*`, `post_video_views`,
  `post_video_avg_time_watched`) — the video group is exactly what the June-2026
  wave disrupted and **must** be probed live before use. The doctor probes each
  candidate against the real Page and generates the metric table; tool
  descriptions carry only the probed-valid set (see
  [06-tool-catalog.md](06-tool-catalog.md)).
- Meta's docs remain internally inconsistent → do **not** hardcode a strict
  metric whitelist; pass user-requested metrics through and surface the API's
  "invalid metric" errors readably, backed by a static rename-suggestion table in
  the tool layer.

## Comments, reactions, moderation

- Comments on Page content require a **Page token** (user token silently returns
  empty). Read: `filter=toplevel|stream`, `summary=true`. Write needs the
  `MODERATE` task, but the **permission splits by target**: reply / hide / edit
  and deleting the **Page's own** comments → `pages_manage_engagement`; deleting a
  comment **left by a user** on the Page → `pages_read_user_content`. The doctor
  permission matrix must model this split, or a missing `pages_read_user_content`
  gets misdiagnosed as a working delete.
- Hide (`POST /{comment-id}` `is_hidden=true`) is the reversible moderation
  default (author + friends still see it); delete is permanent.
- **Private replies:** `POST /{page-id}/messages` with
  `recipient={"comment_id"}` — exactly one per comment, within 7 days.
- Reactions: totals per type via field expansion
  (`reactions.type(LOVE).limit(0).summary(total_count)`); CARE folds into LIKE;
  identities unavailable.
- Block users: `GET|POST|DELETE /{page-id}/blocked` (accepts PSIDs).

## Messenger

- Send: `POST /{page-id}/messages`, `pages_messaging` + `MESSAGING` task.
  **24-hour window**; message tags are effectively dead (hard-fail since
  2026-04-27) except **HUMAN_AGENT** (7-day window) which needs App Review —
  out of scope initially. Send is a non-idempotent write with no idempotency key:
  a lost response means **unknown delivery**, so never blind-retry — apply the
  ambiguous-outcome rule under Publishing and verify via `/conversations`.
- **A local server cannot receive webhooks → polling** `GET
  /{page-id}/conversations` (diff `updated_time`/`unread_count`) is the designed
  ingestion path; then `GET /{conversation-id}/messages`.

## Marketing API

- Hierarchy: `act_{id}` → Campaign → Ad Set → Ad → Creative (creatives
  immutable). Objectives are **ODAX only** (`OUTCOME_TRAFFIC`, etc.);
  `special_ad_categories` is required on campaign create; EU targeting requires
  `dsa_payor`/`dsa_beneficiary`; budgets in minor units (cents); read
  `effective_status`, not `status`, for truth.
- Insights: `GET /{object}/insights` with `level`, `breakdowns`, `time_range`;
  oversized queries → async report runs (`POST /insights` → poll → fetch).
  Separate throttle header `x-fb-ads-insights-throttle`.
- Custom audiences: TOS acceptance gate (error 200/subcode 1870090), SHA-256
  normalized uploads, ≤10k rows/call.
- **Own ad account works on the default development tier without review** —
  BUC limit `300 + 40×active_ads` calls/h (ads_management), fine for one account.

## Rate limits (cross-cutting)

- Pages with Page/System token: BUC `4800 × engaged_users`/24 h (error 80001).
- **Throttle errors arrive as HTTP 400 with the code in the response body — not
  HTTP 429/5xx** — so retry/backoff decisions must be *body-envelope-driven*, not
  HTTP-status-driven. Detect the throttle **family by membership, not
  enumeration**: platform codes `4 / 17 / 32 / 613`, plus the BUC range
  `80000 ≤ code < 80100` (common members: `80001` pages, `80004`/`80000` ads;
  other 80xxx codes exist for custom-audience, leadgen and messaging families).
  ✎ Verify the exact 80xxx table at Phase 0.
- Parse **both** `X-App-Usage` and `X-Business-Use-Case-Usage` on every
  response; honor `estimated_time_to_regain_access`; back off before 100%.
- Content quotas: 30 Reels/24 h; `limit ≤ 100` on reads.
