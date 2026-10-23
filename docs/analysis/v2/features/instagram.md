# v2.0 feature specs — opt-in `instagram` package (Facebook Login variant)

Status: research / implementation-ready spec.
Date: 2026-10-24. Graph API: v26.0, host `graph.facebook.com` (+ `rupload.facebook.com` for IG video).
Decision gate: this package exists only if owner decision **D2 = A** (package here) or **C** (shared core).
D2 recommendation today is B (keep sibling `instagram-mcp`) — see `docs/analysis/v2/04-owner-decisions.md`.
Scope cap (from `docs/analysis/v2/03-v2-scope.md` §3.3): FB-Login variant only; no IG-Login
(`graph.instagram.com`), no hashtag search / Public Content Access, no HUMAN_AGENT tag.

All Meta facts below were re-checked against developers.facebook.com docs (IG Platform reference,
content-publishing guide, insights reference, Messenger Platform IG messaging, changelog) on 2026-10-24.
Items Meta documents ambiguously are flagged **LIVE PROBE**.

---

## 0. Cross-cutting design

### 0.1 Package registration (additive)

| File | Change |
|---|---|
| `src/core/types.ts` (`PACKAGE_NAMES`, ~l.639) | append `'instagram'` |
| `src/mcp/packages.ts` | NOT in `DEFAULT_PROFILE_PACKAGES` (opt-in like `ads`); `all` picks it up automatically; add profile alias `instagram: ['core','instagram']` (optional) |
| `src/mcp/packages.test.ts` (default-surface snapshot) | default snapshot unchanged (proves opt-in); new snapshot for `all` / `instagram` |
| `src/tools/index.ts` | export `createInstagramPackage` |
| `src/index.ts` | wire the factory into the package map |
| `src/mcp/doctor.ts` | `PACKAGE_PERMISSIONS.instagram`, `TOOL_PERMISSIONS` rows, IG checks (§1) |
| README / manifest generator | tool table regenerates from tool data (no hand edits beyond the package blurb) |

Breaking: **no**. Default surface, FB tool names, FB messaging pin (`PLATFORM_MESSENGER`) all unchanged.

### 0.2 New files (layering core ← api ← mcp ← tools)

```
src/api/ig-account.ts        + .test.ts   IG user id resolution, account read, cache
src/api/ig-publish.ts        + .test.ts   containers, status poll, media_publish, quota, rupload
src/api/ig-media-spec.ts     + .test.ts   pure caption/carousel/user-tag/spec validators (port)
src/api/ig-media.ts          + .test.ts   list/get media, stories, delete, comment_enabled
src/api/ig-comments.ts       + .test.ts   list/replies/reply/hide/delete
src/api/ig-insights.ts       + .test.ts   metric matrix, retired-metric table, normalization
src/api/ig-messaging.ts      + .test.ts   conversations/messages with platform=instagram pin
src/tools/instagram.ts       + .test.ts   createInstagramPackage (or split, see below)
src/testing/ig-fixtures.ts                fixture builders (IG user, media, container, comment, insights)
```

If `src/tools/instagram.ts` exceeds ~800 lines, split into `src/tools/instagram/{account,publish,media,
comments,insights,messages}.ts` + `src/tools/instagram/index.ts` exporting `createInstagramPackage`.
Tests are colocated (`*.test.ts`), using the existing `src/testing/with-fetch.ts` and the network fence.

### 0.3 IG user id resolution (shared by every tool)

- `resolveIgUser(fb, page)` → `GET /{page-id}?fields=instagram_business_account{id,username}` with the
  **Page token** from `resolvePage(profile)` / `src/core/auth.ts`.
- Cached per `pageId` in-process (Map, TTL = process lifetime; invalidated on Graph error 100/803 for
  the IG id). No new config key; optional override `ig_user_id` per page in `pages-registry` is
  **not** proposed for v2.0 (YAGNI).
- Error when `instagram_business_account` is absent: typed `IgNotLinkedError` → tool error
  "Page {name} has no linked Instagram professional account (Page settings → Linked accounts)".
- **LIVE PROBE P1:** Meta docs list a *Facebook User token* for the `instagram_business_account` field
  and IG User endpoints; community practice and the sibling's fb-login mode use the **Page token**.
  Probe: Page token from `resolvePage` → `GET /{page-id}?fields=instagram_business_account` and
  `GET /{ig-id}?fields=username`. If the Page token is rejected, auth needs a user-token path → effort L+.
- **LIVE PROBE P2:** System User token with `instagram_*` scopes (the repo's recommended long-lived setup).

### 0.4 HTTP / hosts

- All Graph calls through `fbRequest` / `fetchPage` (C3: never follow token-bearing `paging.next`).
- IG resumable video upload: `POST https://rupload.facebook.com/ig-api-upload/{ver}/{container-id}`.
  Same host as Reels (`settings.hosts.rupload`), different path prefix → add
  `IG_UPLOAD_PATH_PREFIX = 'ig-api-upload'` + `ruploadPathForIgContainer()` next to
  `ruploadPathForReel()` in `src/api/media-reels.ts` (or in `ig-publish.ts` reusing `containPathname`).
  **Host allowlist unchanged.** Header `Authorization: OAuth <token>` (rupload convention) — check
  whether the existing reels rupload helper already uses that header form and reuse it.
- 200-with-`error` envelope: already handled by core http (sibling's `graphBody()` not needed).
- IG-specific error subcodes to map in `ig-publish.ts`:
  `2207027` (media not ready → keep polling, never re-create), `2207026`/`2207052` (media fetch /
  unsupported format), `2207042` (quota reached), `2207020` (container expired), `9004` (URL unreachable).
  Codes are taken from the sibling + Meta error reference; treat unknown subcodes as plain `GraphApiError`.

### 0.5 Reuse vs sibling `instagram-mcp` (`instagram-mcp-ai@0.8.0`, v25.0, 29 tools)

General verdict: **port logic + constants, rewrite seams.** The sibling's `IgRequestFn`, `AuthProvider`,
http, host and refresh code do not match this repo's `FbRequestFn` / `resolvePage` / `executeWrite`
/ journal — rewrite. Pure modules (`media-spec.ts`, insights metric sets, `classifyScopes`) port almost
verbatim (license is the owner's own). Per-feature verdicts below.

### 0.6 Common error mapping (all tools)

| Condition | Mapping |
|---|---|
| 190 | existing auth path (re-derive Page token once) |
| 10 / 200 / 3 permission | error naming the missing IG permission from doctor's `TOOL_PERMISSIONS` row |
| 4/17/32/613, 80000–80099 | existing throttle classification (retry only for reads) |
| ambiguous write (timeout after send) | not retried (C2); journal `attempted` |
| `IgNotLinkedError` | tool error, no Graph write |

---

## 1. Account discovery + doctor checks

**User story:** As an operator I want to see which Instagram professional account is linked to my Page
and whether my token has every IG scope, so I know IG tools will work before I try to publish.

### Tool `instagram_get_account` (read)

```ts
inputSchema: z.object({ profile: profileArg.optional() })
```
Output:
```ts
{ page_id, ig_user_id, username, name, biography /*tainted*/, website, followers_count,
  follows_count, media_count, profile_picture_url, has_profile_pic, is_published,
  publishing_limit?: { quota_usage, quota_total, quota_duration } }   // best-effort, omitted on 10/200
```
Graph: `GET /{page-id}?fields=instagram_business_account` →
`GET /{ig-id}?fields=id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url,has_profile_pic,is_published`.
Permissions: `instagram_basic`, `pages_show_list`, `pages_read_engagement` (+ `ads_management` or
`ads_read` when the user's Page access comes via a Business Manager role — "ads_* quirk").
Tier: read (`readOnlyHint: true`, no `writeTier`). `biography`/`name` wrapped with `taint()`.
Errors: not linked; 10/200 missing `instagram_basic`; P1 token-type failure.

### Doctor additions (`src/mcp/doctor.ts`)

- `PACKAGE_PERMISSIONS.instagram = ['instagram_basic','instagram_content_publish','instagram_manage_comments','instagram_manage_insights','pages_show_list','pages_read_engagement']`.
  Optional (checked only if the tool is enabled): `instagram_manage_messages`, `pages_manage_metadata`
  (DMs), `instagram_manage_contents` (delete media).
- `TOOL_PERMISSIONS` row per tool (see each section).
- **ads_* quirk check:** if `/me/permissions` lacks both `ads_management` and `ads_read`, emit an
  INFO/WARN (not FAIL): "If your Page access is granted via Business Manager, Instagram endpoints also
  require ads_read or ads_management." Doctor cannot reliably detect BM-role access → warning only.
  Do NOT flag `ads_*` as over-scope when the `instagram` package is enabled (adjust over-scope logic).
- `business_management`: stays "not required" for the package; required only by the IG messaging
  permission set (§6) — doctor marks it required only when `instagram_send_message` is enabled.
- **Linked-account probe:** per configured Page, `GET /{page-id}?fields=instagram_business_account`;
  PASS with `@username`, WARN "no linked IG account" (package enabled but useless for that Page).
- **Quota probe:** `GET /{ig-id}/content_publishing_limit?fields=quota_usage,config` → report
  `quota_usage/quota_total` (PASS; WARN at ≥ 80 %).
- Messaging prerequisite (non-checkable via API): INFO line "Instagram app → Settings → Messages →
  Connected tools → Allow access to messages must be ON".

Files: `src/api/ig-account.ts`, `src/mcp/doctor.ts` (+ `doctor.test.ts` cases), `src/tools/instagram.ts`.
Tests: linked / not-linked / 10-permission fixtures; ads_* warning matrix (none / ads_read / ads_management);
over-scope not raised for ads_* with instagram enabled; cache hit avoids second Graph call.
Effort: **S** (tool) + **S** (doctor). Codeable now: yes (fixtures). Needs live probe: **P1, P2**.
Dependencies: none (foundation for all other features). Breaking: no (doctor output gains lines;
check doctor JSON snapshot tests — they will need an update, additive).
Reuse: port `classifyScopes()` idea from sibling `src/cli/scopes.ts` into doctor's existing matrix
(rewrite, ~30 lines); `getAccount` field list reused verbatim.

---

## 2. Publishing (image, carousel ≤ 20, Reels, Stories)

**User story:** As a social media manager I want to publish an image, a carousel, a Reel or a Story to
Instagram from a public URL (or a local video), with a preview first and a single confirmed apply.

### 2.1 Flow (shared `runIgPublish` in `src/api/ig-publish.ts`)

1. Validate inputs with `ig-media-spec.ts` (pure, before any Graph call).
2. `POST /{ig-id}/media` → container id (for carousel: N child containers with `is_carousel_item=true`,
   then parent `media_type=CAROUSEL&children=id1,id2,…`).
3. For video: either `video_url` (Meta fetches) or `upload_type=resumable` + rupload of a local file
   (bytes or `file_url` header).
4. Poll `GET /{container}?fields=status_code,status` until `FINISHED`; `ERROR`/`EXPIRED` → fail with
   `status` text; `IN_PROGRESS` → keep polling; unknown code → keep polling (never terminal).
   Poll interval 5 s for images, 15 s for video; budget `maxPollMs` default 300 000 (Meta: ≤ 5 min).
   Uses an injected clock (`Clock` interface already used for tests) so tests run instantly.
5. `POST /{ig-id}/media_publish?creation_id={container}` → `{id}` (IG media id). **Never retried.**
6. `GET /{media-id}?fields=permalink,shortcode` (best-effort) for the output.

Containers expire after 24 h; 400 containers / rolling 24 h per account. Publishing quota:
`content_publishing_limit` `config.quota_total` — Meta reference currently says **50** per 24 h, the
guide still says 100 → **read at runtime, never hard-code** (LIVE PROBE P3: confirm value for test acct).
Carousels count as one post.

### 2.2 Preview (apply=false)

Preview does **no container creation** (containers are side effects that count toward the 400 limit).
Preview performs: input validation, `resolveIgUser`, quota read, optional `HEAD` of each media URL is
**not** done (would leak a fetch to an arbitrary host from this process; Meta fetches it). Preview shows
caption char/hashtag/mention counts, children list, quota `usage/total`, warnings.

### 2.3 Tier and gating

- Tier **`reversible`** + per-call `requirePlanId: true` — verified identical to `facebook_create_post`
  / `create_photo_post` / `create_reel` (`src/tools/posts.ts`: `writeTier: 'reversible'`,
  `requirePlanId: publishesNow(...)`). IG has no scheduled/unpublished state via this API, so
  `requirePlanId` is always true; `FB_WRITE_MODE=apply` therefore never bypasses the plan.
- `classifyOutcome`: container created but publish failed → `not_applied` with `container_id` in
  metadata (re-publish later via `instagram_publish_container`); publish timed out → `attempted`
  (journal), output tells the user to check `instagram_list_media` before retrying.
- `readState` for divergence: quota usage at preview vs at apply → `stateWarnings` if quota dropped
  to 0 (not `diverged`; quota is not object state).

### 2.4 Tools

#### `instagram_create_post` (image or carousel)

```ts
const igMediaItem = z.discriminatedUnion('type', [
  z.object({ type: z.literal('image'), image_url: httpsUrlArg, alt_text: z.string().max(1000).optional(),
             user_tags: z.array(userTag).max(20).optional() }),
  z.object({ type: z.literal('video'), video_url: httpsUrlArg }),        // carousel child only
]);
inputSchema: z.object({
  ...writeArgs,                                   // profile, apply, plan_id
  items: z.array(igMediaItem).min(1).max(20),     // 1 image = single post; 2..20 = carousel
  caption: z.string().optional(),                 // validated: ≤2200 code points, ≤30 #, ≤20 @
  location_id: z.string().regex(/^\d+$/).optional(),
  collaborators: z.array(igUsername).max(3).optional(),
  is_ai_generated: z.boolean().optional(),        // carousel parent only (sent on parent, never children)
})
// userTag = { username: igUsername, x: z.number().min(0).max(1), y: z.number().min(0).max(1) }
// igUsername = z.string().regex(/^[A-Za-z0-9._]{1,30}$/)
```
Rules: single item must be `image` (single feed video = use `instagram_create_reel`; Meta removed
feed VIDEO media_type). `image_url` must be JPEG (Meta: JPEG only) → warning on non-.jpg/.jpeg
extension, hard error not possible without fetching. `alt_text` only on images. Caption only on parent.
`location_id` not on children.
Output: `{ ig_media_id, permalink?, shortcode?, container_id, children_container_ids?, quota: {usage,total} }`.
Graph: `POST /{ig-id}/media` (image_url | is_carousel_item | media_type=CAROUSEL&children&caption…),
`GET /{container}?fields=status_code,status`, `POST /{ig-id}/media_publish`.
Permissions: `instagram_basic`, `instagram_content_publish`, `pages_read_engagement` (+ ads_* quirk).
Errors: spec violations (zod/validator, pre-call), 9004/2207026 bad media URL, 2207042 quota,
poll timeout, `ERROR` status (surface `status` string), EXPIRED.
Effort: **M**. Codeable now: yes. Live probe: **P4** — does an `fbcdn.net` URL (e.g. a photo already
on the FB Page) work as `image_url`? (enables cross-post §7 without third-party hosting).

#### `instagram_create_reel`

```ts
inputSchema: z.object({
  ...writeArgs,
  video: z.union([ z.object({ url: httpsUrlArg }), z.object({ path: localPathArg }) ]),
  caption: z.string().optional(),
  share_to_feed: z.boolean().default(true),
  cover_url: httpsUrlArg.optional(), thumb_offset: z.number().int().min(0).optional(),
  audio_name: z.string().max(100).optional(),
  location_id, collaborators, user_tags: as above,
  trial: z.object({ graduation_strategy: z.enum(['MANUAL','SS_PERFORMANCE']) }).optional(),
})
```
`media_type=REELS`. Local path → `upload_type=resumable`, then rupload (`ig-api-upload` prefix) with
`offset: 0`, `file_size`; reuse `resolveLocalMediaPath`/`digestLocalMedia` from `src/api/media-photos.ts`
(local-path sandbox rules already exist). Spec warnings (not hard errors; Meta re-validates):
MOV/MP4, ≤ 300 MB (hard error — known before upload), 3 s–15 min, ≤ 1920 px wide, 23–60 fps.
Output: `{ ig_media_id, permalink?, container_id, upload: 'url'|'resumable' }`.
Effort: **M** (rupload variant is the new part). Codeable now: yes (rupload fixture via with-fetch).
Live probe: **P5** — rupload `ig-api-upload` accepts a Page token with `Authorization: OAuth`.

#### `instagram_create_story`

```ts
inputSchema: z.object({ ...writeArgs,
  media: z.union([ z.object({ image_url: httpsUrlArg }), z.object({ video_url: httpsUrlArg }),
                   z.object({ video_path: localPathArg }) ]),
  user_tags: z.array(userTag).max(20).optional() })
```
`media_type=STORIES`. No caption (Meta ignores it), no collaborators. Specs: image JPEG ≤ 8 MB; video
3–60 s, ≤ 100 MB. Story disappears after 24 h — summary says so. Same tier as posts.
Effort: **S** (reuses the flow). Codeable now: yes.

#### `instagram_get_container_status` (read)

`{ profile?, container_id: graphNodeIdArg }` → `{ container_id, status_code, status? }`.
Graph `GET /{container}?fields=status_code,status`. Effort **S**.

#### `instagram_publish_container` (recovery path)

`{ ...writeArgs, container_id }` → publishes a FINISHED container left over from a timed-out apply.
Same tier/plan rules as create. Preview reads status_code (refuse unless FINISHED). Effort **S**.

#### `instagram_get_publishing_limit` (read)

`{ profile? }` → `{ quota_usage, quota_total, quota_duration_s, remaining }`.
Graph `GET /{ig-id}/content_publishing_limit?fields=quota_usage,config` (`since` optional, ≤ 24 h old —
not exposed). Effort **S**.

Files: `src/api/ig-media-spec.ts`, `src/api/ig-publish.ts`, `src/api/media-reels.ts` (prefix helper,
additive), `src/tools/instagram.ts`.
Tests: per-validator unit tests (caption 2200 code points incl. emoji, 30/31 hashtags, 20/21 mentions,
carousel 1/2/20/21, alt_text on video rejected, is_ai_generated never sent to children); flow tests with
fake clock (FINISHED after N polls, ERROR, EXPIRED, unknown code, 2207027 on publish → keep polling,
timeout → `attempted`); media_publish never retried on 5xx (assert single call); preview performs zero
POSTs (network fence); quota read at runtime (fixture 50 and 100).
Fixtures: `ig-container-in-progress.json`, `ig-container-finished.json`, `ig-container-error.json`,
`ig-publish-ok.json`, `ig-publishing-limit.json`.
Dependencies: §1. Breaking: no.
Reuse: **port** `media-spec.ts` (bump `CAROUSEL_MAX` 10 → 20, allow video children), `runPublishFlow`
polling semantics (2207027 handling, unknown-code rule, never retry publish). **Rewrite** the tool
layer (sibling has separate low-level `create_media_container`/`publish_media` tools; here one
gated tool per media kind + recovery tool, because `executeWrite` previews must not create containers).

---

## 3. Media list / read

**User story:** As a manager I want to list my recent IG posts and Reels with engagement counts, and
fetch a single media item with its carousel children.

#### `instagram_list_media` (read)

```ts
inputSchema: z.object({ ...listArgs,                       // profile, limit 1..100, after
  since: isoDateArg.optional(), until: isoDateArg.optional() })
```
Graph `GET /{ig-id}/media?fields=id,caption,media_type,media_product_type,media_url,permalink,thumbnail_url,shortcode,timestamp,like_count,comments_count,is_comment_enabled,is_shared_to_feed&limit=&after=&since=&until=`
via `fetchPage`. Excludes stories (Meta). Max 10 000 most recent items reachable. `media_url` may be
absent (copyrighted audio, changelog 2026-07-30) → optional in the output type. `caption` tainted.
Output: `{ items: IgMediaNode[], next_cursor? }`. Permissions: `instagram_basic`, `pages_read_engagement`.

#### `instagram_get_media` (read)

`{ profile?, media_id: graphNodeIdArg, include_children?: boolean }` →
`GET /{media}?fields=…,alt_text,is_ai_generated,saved_count,shares_count,reposts_count,children{id,media_type,media_url,thumbnail_url}`.
Note: `saved_count`/`shares_count`/`reposts_count`/`total_*` fields are new (changelog 2026-04-22);
request them, and on error 100 "nonexisting field" retry once without them (field-fallback list, same
pattern as insights deprecation table). **LIVE PROBE P6:** availability of the new count fields on v26.0.

#### `instagram_list_stories` (read)

`{ ...listArgs }` → `GET /{ig-id}/stories?fields=id,media_type,media_url,permalink,timestamp`. Only
stories live in the last 24 h. Effort **S**.

#### `instagram_set_comments_enabled` (write)

`{ ...writeArgs, media_id, enabled: z.boolean() }` → `POST /{media}?comment_enabled=true|false` →
`{success:true}`. Tier `reversible`; `readState` = `is_comment_enabled` for divergence detection.
Permissions: `instagram_basic`, `instagram_manage_comments`. Belongs to the instagram package with
`writeModeDefault` like moderation (`apply`)? **No** — package-level default stays `plan`; only this
tool is moderation-like; keep consistent plan default for the whole IG package. Effort **S**.

#### `instagram_delete_media` (write)

`{ ...confirmableWriteArgs, media_id }` → `DELETE /{media}` (changelog 2025-12-03; FB-Login only).
Tier **irreversible** (plan_id + confirmer). Deletes posts, stories, reels and whole carousels; cannot
delete a single carousel child → validator: preview reads `GET /{media}?fields=media_type,media_product_type,permalink,timestamp`
and refuses if the id is a carousel child (child has no `permalink` / parent lookup returns 100).
Permission: **`instagram_manage_contents`** (new; must be requested in App Review).
Effort **S**. Live probe: **P7** — `instagram_manage_contents` grantable to the app in dev mode.

Files: `src/api/ig-media.ts`, `src/tools/instagram.ts`. Tests: paging via `fetchPage` (no `paging.next`
following), missing `media_url`, field fallback on error 100, delete preview/apply/confirm flow,
carousel-child refusal, comment toggle divergence. Fixtures: `ig-media-list.json`, `ig-media-carousel.json`.
Effort total: **M**. Codeable now: yes (P6/P7 affect only optional fields / one tool).
Dependencies: §1. Breaking: no.
Reuse: **port** field lists and `list_media/list_stories/get_media` normalization; **rewrite** paging
(sibling follows cursors itself) and add delete (sibling lacks it).

---

## 4. Comments moderation

**User story:** As a community manager I want to read comments on my IG media, reply, hide abusive
ones in bulk and delete spam, with the same safety model as Facebook moderation.

| Tool | Input (beyond `profile`) | Graph | Tier |
|---|---|---|---|
| `instagram_list_comments` | `media_id`, `...listArgs` | `GET /{media}/comments?fields=id,text,timestamp,username,from{id,username},hidden,like_count,parent_id` | read |
| `instagram_get_comment` | `comment_id`, `include_replies?` | `GET /{comment}?fields=…,replies{…}` | read |
| `instagram_list_replies` | `comment_id`, `...listArgs` | `GET /{comment}/replies?fields=…` | read |
| `instagram_reply_to_comment` | `...writeArgs`, `comment_id`, `message` (≤ 2200, ≤ 30 #) | `POST /{comment}/replies?message=` | reversible, `requirePlanId` (public speech, mirrors `facebook_reply_to_comment`) |
| `instagram_hide_comment` | `...writeArgs`, `comment_ids: graphNodeIdArg[] (1..50)`, `hide: boolean=true` | `POST /{comment}?hide=true|false` per id | reversible |
| `instagram_delete_comment` | `...confirmableWriteArgs`, `comment_id` | `DELETE /{comment}` | irreversible |

Permissions: `instagram_basic`, `instagram_manage_comments`, `pages_read_engagement` (+ ads_* quirk).
Notes from Meta: owner's own comments cannot be hidden (always shown) → API returns error; live-video
comments not supported for hide; replies only one level deep (reply to a reply → reply to its parent;
validator: preview reads `parent_id` and warns). `text`, `username` tainted.
Hide uses the existing bulk machinery: `readCommentStates` / `runBulk` / `tallyBulk` /
`moderateCommentStep` from `src/api/comments.ts` are FB-shaped (`is_hidden`), so generalize them with
a field adapter (`{ hiddenField: 'hidden', hideParam: 'hide' }`) rather than copy — small refactor of
`src/api/comments.ts`, behavior-preserving for FB (existing tests guard it).
Output for bulk hide: same envelope as `facebook_hide_comment` (`{ results: [{comment_id, outcome}], tally }`).
Divergence: preview records `hidden` per id + `messageFingerprint(text)`; apply re-reads and marks
`diverged` if text changed (same as FB).
Package write default: the FB moderation package uses `writeModeDefault: 'apply'`; IG comment tools
live in the `instagram` package whose default is `plan` → document that difference (or, if owner
prefers parity, per-tool default override — out of scope unless `defineTool` supports it; it doesn't today).
Errors: 100 comment gone (`isObjectGoneError` → outcome `gone`), owner-comment hide refusal, 10 missing
`instagram_manage_comments`.
Private replies (`recipient={comment_id}`, 7-day window): **deferred** — docs require
`instagram_manage_comments` + `pages_messaging` + Human Agent feature/Advanced Access; LIVE PROBE **P8**.
Files: `src/api/ig-comments.ts`, `src/api/comments.ts` (adapter refactor), `src/tools/instagram.ts`.
Tests: list/replies paging, hide bulk mixed outcomes (ok/gone/owner-refusal), unhide, divergence,
delete with confirm token, reply plan requirement. Fixtures: `ig-comments.json`, `ig-comment-replies.json`.
Effort: **M**. Codeable now: yes. Dependencies: §1, §3 (media ids). Breaking: no (refactor internal).
Reuse: **port** field lists and the hide/unhide pair as one array tool; **rewrite** around this repo's
bulk/divergence machinery. Sibling's `create_comment` (top-level comment on own media) — optional
add-on `instagram_create_comment` (S), `set_comments_enabled` already covered in §3.
`instagram_manage_engagement` (likes, changelog 2026-04-22) — out of scope.

---

## 5. Insights (account + media)

**User story:** As an analyst I want IG account reach/views/engagement over a date range and per-media
metrics, without hitting retired metric names.

#### `instagram_account_insights` (read)

```ts
inputSchema: z.object({ profile: profileArg.optional(),
  metrics: z.array(z.enum(IG_ACCOUNT_METRICS)).min(1).optional(),   // default: reach,views,accounts_engaged,total_interactions,follows_and_unfollows
  since: isoDateArg.optional(), until: isoDateArg.optional(),         // ≤ 30 days span, ≥ now-90d
  breakdown: z.enum(['media_product_type','follower_type','follow_type','contact_button_type']).optional(),
  time_series: z.boolean().default(false) })                          // only `reach` supports it
```
`IG_ACCOUNT_METRICS` = accounts_engaged, comments, follows_and_unfollows, likes, profile_links_taps,
reach, replies, reposts, saves, shares, total_interactions, views.
Graph: `GET /{ig-id}/insights?metric=…&period=day&metric_type=total_value|time_series&since&until&breakdown`.
Demographics as separate calls: `follower_demographics` / `engaged_audience_demographics`,
`period=lifetime`, `timeframe=this_week|this_month`, `breakdown=age|city|country|gender` — exposed as
`instagram_audience_demographics` (read, S) to keep schemas simple.
Rules: since/until default last 24 h (Meta); data retained 90 days; some metrics need ≥ 100 followers;
missing data = empty set, not 0 → output `value: null` + `note: 'no data'`.
Breakdown validity matrix (pure): `follow_type` only with follows_and_unfollows, `contact_button_type`
only with profile_links_taps, `media_product_type`/`follower_type` only with views/reach/… → zod
superRefine error before any call.

#### `instagram_media_insights` (read)

`{ profile?, media_id, metrics?: string[], breakdown?: 'action_type'|'story_navigation_action_type' }`.
Reads `media_product_type` first (`GET /{media}?fields=media_product_type,media_type`), then selects
the valid default set from the matrix:

| Product | Default metrics |
|---|---|
| FEED | views, reach, likes, comments, saved, shares, total_interactions, profile_visits, follows |
| REELS | views, reach, likes, comments, saved, shares, total_interactions, ig_reels_avg_watch_time, ig_reels_video_view_total_time, reels_skip_rate |
| STORY | views, reach, replies, shares, total_interactions, navigation, profile_visits, follows, link_clicks |

User-supplied metrics outside the product's set → dropped with a warning (not a Graph error).
Carousel children → refuse (no insights for album children). `breakdown=action_type` only with
`profile_activity`; `story_navigation_action_type` only with `navigation`.
Graph: `GET /{media}/insights?metric=…`.

#### Retired-metric table (reuse FB `deprecatedAbove` pattern from `src/api/insights.ts`)

`impressions`, `plays`, `clips_replays_count`, `ig_reels_aggregated_all_plays_count`,
`video_views` → replacement `views`; `profile_views` → retired (no replacement; suggest
`profile_visits` for media). Requested retired names are dropped before the call, replacement added,
warning returned. `impressions` also unavailable for media created after 2024-07-02.

Permissions: `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement` (+ ads_* quirk).
Output: `{ ig_user_id|media_id, metrics: [{ name, period, total_value?, values?: [{end_time,value}], breakdowns? }], warnings }`.
Files: `src/api/ig-insights.ts`, `src/tools/instagram.ts`. Tests: matrix per product type, retired
rename, breakdown validation, empty-data → null, time_series only for reach, 90-day bound.
Fixtures: `ig-account-insights.json`, `ig-media-insights-reel.json`, `ig-demographics.json`.
Effort: **M**. Codeable now: yes. Live probe: **P9** (low priority) — `crossposted_views`/`facebook_views`
present on v26.0 for FB-cross-posted reels. Dependencies: §1, §3. Breaking: no.
Reuse: **port** sibling `insights.ts` metric sets, product matrix, `findMissingMetrics`,
`TIME_SERIES_ACCOUNT_METRICS` (largest straight port in the package); **rewrite** request/normalize
glue to match `src/api/insights.ts` output shapes.

---

## 6. DMs (Instagram Messaging via the Page)

**User story:** As a support agent I want to read Instagram DM threads and reply within the 24-hour
window from the same server I use for Messenger.

| Tool | Input | Graph | Tier |
|---|---|---|---|
| `instagram_list_conversations` | `...listArgs` | `GET /{page-id}/conversations?platform=instagram&fields=id,updated_time,participants,message_count` | read |
| `instagram_get_conversation` | `conversation_id`, `...listArgs` | `GET /{conversation}?fields=messages{id,created_time,from,to,message,attachments}` (platform pinned in id lookup) | read |
| `instagram_send_message` | `...writeArgs`, `recipient_igsid: z.string().regex(/^\d+$/)`, one of `text` (≤ 1000 **bytes** UTF-8) / `image_url` / `media_share_id` (own post) / `like_heart: true` | `POST /{page-id}/messages` `recipient={"id":IGSID}`, `message={…}` | reversible + `requirePlanId: true` (verified same as `facebook_send_message`, `src/tools/messages.ts`) |

Pin: new `PLATFORM_INSTAGRAM = 'instagram'` in `src/api/ig-messaging.ts`; FB `PLATFORM_MESSENGER`
untouched (G-RUN-2 guard tests must still pass; add a mirror guard that IG tools never send
`platform=messenger`).
24-hour window: preview reads the thread's latest inbound message (`from.id === recipient`) and
computes `window_expires_at`; outside window → `warnings` + refuse in apply (no HUMAN_AGENT tag —
out of scope). Click-to-Direct ad threads have 7 days — not detectable reliably → documented, not coded.
Attachments: images png/jpeg ≤ 8 MB (URL only in v2.0; up to 10 per message is a later add-on);
audio/video/PDF and reactions (`sender_action react/unreact`) → out of v2.0.
Permissions: `instagram_basic`, `instagram_manage_messages`, `pages_manage_metadata`,
`pages_show_list`, `business_management`; the token user needs the MESSAGE task on the Page; the IG
"Allow access to messages" toggle must be ON; Standard Access → only app-role users reachable.
Errors: 10/200 permissions; 551/`2534022` outside window (map to "outside the 24-hour window");
threads in Requests folder inactive > 30 days not returned (documented); one-to-one only.
`message`, `from.username` tainted.
Files: `src/api/ig-messaging.ts`, `src/tools/instagram.ts`, doctor rows. Tests: platform pin on every
request (fence asserts query), byte-length validator (multi-byte), window computation, refusal outside
window, list paging. Fixtures: `ig-conversations.json`, `ig-conversation-messages.json`.
Effort: **M**. Codeable now: yes. Live probe: **P10** — exact permission set accepted with a Page token
(docs mix Messenger and IG lists; `business_management` requirement contradicts the repo's
"business_management not required" stance — doctor treats it as required only when this tool is on).
Dependencies: §1 (Page token; IG user id not needed for DMs). Breaking: no.
Reuse: **new** — the sibling has no DM tools. Reuse this repo's `src/api/messaging.ts` structure
(normalizers, window helpers) via a platform parameter where it is pure; keep the pinned constants separate.

---

## 7. Cross-posting FB + IG in one plan

**User story:** As a manager I want one preview and one confirmation to publish the same photo +
caption to my Facebook Page and its linked Instagram account.

Feasibility within `executeWrite`: **yes, as a single `WriteAction`** whose `perform` runs two
sequential publishes. `WriteAction` already carries `classifyOutcome` / `classifyResult` / `metadata`,
so partial success is expressible. No rollback (deleting the FB post after an IG failure is itself an
irreversible write the user did not approve).

#### `instagram_crosspost` (lives in the `instagram` package because it needs IG; `instagram_*` prefix rule)

```ts
inputSchema: z.object({ ...writeArgs,
  image_url: httpsUrlArg,                 // single image in v2.0; carousel/video later
  caption: z.string(),                    // validated against BOTH limits (IG 2200 / 30 # / 20 @)
  fb_message: z.string().optional(),      // override for FB text
  ig_alt_text: z.string().max(1000).optional(),
  order: z.enum(['ig_first','fb_first']).default('ig_first') })
```
Default order **ig_first**: IG has more failure modes (media fetch, quota, processing); if IG fails
nothing is published anywhere. Then FB `POST /{page-id}/photos` with `url=` (reuse
`resolveRemoteMediaUrl` from `src/api/media-photos.ts`).
Preview: validation for both, IG quota, FB page resolution; summary lists both targets.
Tier: `reversible` + `requirePlanId: true` (both legs are reversible live publishes).
Outcomes via `classifyResult`: both ok → `applied`; IG ok + FB failed → `partial` reported as
`applied` with `warnings` and `metadata.{ig_media_id, fb_error}` (if the envelope has no `partial`
state, add it — **check `write-mode.ts` envelope union; adding a state is a cross-cutting change → M**);
IG failed → `not_applied`; ambiguous at either step → `attempted` with both step states in journal.
Journal metadata: `{ ig_container_id, ig_media_id, fb_post_id }`.
Files: `src/tools/instagram.ts` (tool), `src/api/ig-publish.ts` (reuse), possibly `src/mcp/write-mode.ts`
(partial outcome) + `write-mode.test.ts`.
Tests: four outcome combos, ordering, no FB call when IG fails, journal contents, single plan_id
covers both.
Effort: **M** (L if a `partial` envelope state must be added). Codeable now: yes. Live probe: P4
(fbcdn URL as `image_url` enables a "re-share an existing FB photo to IG" variant).
Dependencies: §1, §2, FB photo post path. Breaking: no (envelope state addition is additive for
clients that switch on known states — verify the outcome enum isn't exhaustively matched by consumers).
Reuse: **new** (sibling is IG-only).

---

## 8. Summary table

| # | Feature | Tools | Effort | Codeable now | Live probes |
|---|---|---|---|---|---|
| 1 | Account + doctor | `instagram_get_account` + doctor checks | S+S | yes | P1 Page vs User token, P2 System User |
| 2 | Publishing | `instagram_create_post`, `_create_reel`, `_create_story`, `_get_container_status`, `_publish_container`, `_get_publishing_limit` | M | yes | P3 quota 50/100, P4 fbcdn URL, P5 rupload auth |
| 3 | Media | `instagram_list_media`, `_get_media`, `_list_stories`, `_set_comments_enabled`, `_delete_media` | M | yes | P6 new count fields, P7 manage_contents |
| 4 | Comments | `instagram_list_comments`, `_get_comment`, `_list_replies`, `_reply_to_comment`, `_hide_comment`, `_delete_comment` | M | yes | P8 private replies (deferred) |
| 5 | Insights | `instagram_account_insights`, `_media_insights`, `_audience_demographics` | M | yes | P9 (low) |
| 6 | DMs | `instagram_list_conversations`, `_get_conversation`, `_send_message` | M | yes | P10 permission set |
| 7 | Cross-post | `instagram_crosspost` | M/L | yes | P4 |

Totals: ~25 tools, package effort **L** overall (consistent with `03-v2-scope.md` §3.3). Everything is
fixture-testable today; **P1 is the blocking probe** — run it before writing any code, because a
User-token requirement changes the auth seam for the whole package.

Suggested build order: §1 → §3 (reads) → §5 → §2 → §4 → §6 → §7.

## 9. Live probe checklist

| ID | Probe | Blocks |
|---|---|---|
| P1 | Page token works for `instagram_business_account` and `GET /{ig-id}` | whole package |
| P2 | System User token with `instagram_*` scopes | recommended setup docs |
| P3 | `content_publishing_limit.config.quota_total` value | docs only (code reads at runtime) |
| P4 | `fbcdn.net` image URL accepted as `image_url` | crosspost variant |
| P5 | rupload `ig-api-upload` with Page token, `Authorization: OAuth` | local-file Reels/Stories |
| P6 | `saved_count`/`shares_count`/`reposts_count`/`total_*` on v26.0 | optional output fields |
| P7 | `instagram_manage_contents` grantable in dev mode | `instagram_delete_media` |
| P8 | IG private replies permission set | deferred tool |
| P9 | `facebook_views`/`crossposted_views` on cross-posted reels | optional metrics |
| P10 | IG messaging permission set with a Page token (`business_management`?) | DM tools, doctor |
