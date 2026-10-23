# v2.0 feature specs — Organic publishing & Page management

Status: implementation-ready research. Graph API pin: **v26.0**.
Scope: organic Page publishing and Page management only. Every endpoint, field and permission
below was checked against the current Meta reference docs (2026-10-24). Anything the docs do not
state is marked **LIVE PROBE** with the exact probe to run.

Sources checked:
- Page Stories API — https://developers.facebook.com/docs/page-stories-api
- Page node (read + `POST /{page-id}`) — https://developers.facebook.com/docs/graph-api/reference/page/
- Page feed (publishing `targeting` / `feed_targeting`) — https://developers.facebook.com/docs/graph-api/reference/page/feed/
- Page photos — https://developers.facebook.com/docs/graph-api/reference/page/photos/
- Page albums edge — https://developers.facebook.com/docs/graph-api/reference/page/albums/
- Album node — https://developers.facebook.com/docs/graph-api/reference/album/
- Album photos edge — https://developers.facebook.com/docs/graph-api/reference/album/photos/
- Object comments edge — https://developers.facebook.com/docs/graph-api/reference/object/comments/
- Post node — https://developers.facebook.com/docs/graph-api/reference/post/

Conventions used below (all existing, from `src/mcp/define.ts`, `src/mcp/write-mode.ts`, `src/tools/shared.ts`):
- `writeArgs` = `profile`, `apply`, `plan_id`, `confirm_token`; paged reads also take `after`, `limit`.
- Every write goes through `executeWrite(ctx, WriteAction)`. Preview payload =
  `{status:'preview', applied:false, planId, tool, tier, summary, warnings, notPerformedNotice, pageId, expiresAt, nextStep}`.
- Ambiguous outcomes are never auto-retried (C2). `classifyOutcome` returns `'attempted'` after the
  request has left the process.
- Local media is allowed only under `FB_MEDIA_DIR`. Its sha256 is bound into the plan, and a
  changed file is refused at apply with `file_changed`. Remote media must be https.
- Layering stays core ← api ← mcp ← tools. New Graph logic goes in `src/api/*`, and tool wiring goes in `src/tools/*`.

---

## 0. Already shipped — do NOT re-implement

Audit of `src/tools/posts.ts` / `src/api/posts-write.ts` (v1.x):

| Capability | Where | Note |
|---|---|---|
| Multi-photo post (carousel of photos) | `facebook_create_post` `photos[]` → `uploadUnpublishedPhotos` + `attached_media`, orphan cleanup | done |
| Multi-link carousel | `facebook_create_post` `child_attachments` (2–5) | done |
| Drafts / scheduled posts | `published:false`, `scheduled_publish_time`, `page_timezone` echo | done |
| List scheduled posts | `facebook_list_scheduled_posts` | done |
| Publish now / reschedule | `facebook_update_post` action `publish_now` / `reschedule` | done |
| **Pin / unpin**, hide/unhide | `facebook_update_post` action `edit` with `is_pinned` / `is_hidden` | done; see F7 for the refinement |
| Reels (3-phase rupload) | `facebook_create_reel` | done |
| Video post + status | `facebook_create_video_post`, `facebook_get_video_status` | done |
| Reply to a comment as the Page | `facebook_reply_to_comment` (moderation) | done; a **top-level** comment on a post is missing (F6) |

Rejected / not offerable (documented so they are not re-proposed):
- **Link preview override** (title/image/description): Graph ignores these for Page link posts. LINK_PREVIEW_NOTE already says so.
- **`feed_targeting`** (age_max, genders, education, relationship, interests): legacy, and its targeting is over-broad for an MCP surface. The v1.x backlog O4 says to skip it. Only `targeting` (F5).
- **Album creation** (`POST /{page-id}/albums`): the Page albums reference says *"You can't perform this operation on this endpoint"* for both reading and creating. Reading albums works through the `albums` edge listed on the Page node (F3). There is no create.
- **Story scheduling**: no scheduling parameter is documented on `photo_stories` / `video_stories`.
- **Events** (deprecated for apps), **live video** (later, not v2.0).
- **Deprecated Page fields** on NPE Pages in v26.0 (`current_location`, `genre`, `network`, `parking`, `start_info`): excluded from F8.

---

## Feature index

| # | Feature | Tool(s) | Package | Tier | Effort | Codeable now? |
|---|---|---|---|---|---|---|
| F1 | Publish a Page Story (photo / video) | `facebook_create_story` | posts | irreversible (publishes now) | M | Yes. Probe: hosted `file_url` acceptance, 60 s cap |
| F2 | List Page Stories | `facebook_list_stories` | reader | read | S | Yes |
| F3 | Albums + photo library reads | `facebook_list_albums`, `facebook_list_photos` | reader | read | S | Yes |
| F4 | Publish a photo into an album | `album_id` on `facebook_create_photo_post` | posts | as today | S | Code yes. Probe: album write permission |
| F5 | Organic post `targeting` (geo + age_min) | `targeting` on `facebook_create_post` (+ photo/video) | posts | as today | S | Yes. Probe: geo key shape echo |
| F6 | Top-level comment as the Page | `facebook_comment_on_post` | moderation | reversible | S | Yes |
| F7 | Pin refinement (single-pin warning, own-app note) | `facebook_update_post` (existing) | posts | as today | S | Probe: pin on a non-app post |
| F8 | Page profile update with before-snapshot | `facebook_update_page_profile` | core (new `page_admin` opt-in? see F8) | reversible + `requirePlanId` | M | Code yes. Probe: permission (`pages_manage_metadata`) |
| F9 | Profile fields on `facebook_get_page` | `facebook_get_page` `field_set` | core | read | S | Yes |
| F10 | Photo alt text | `alt_text` on photo uploads | posts | as today | S | Probe: `alt_text_custom` on unpublished children |

Total: 3×M + 7×S. Everything is additive. There are no breaking changes, and new tool names only extend the manifest snapshot.

---

## F1 — Publish a Page Story (photo or video)

**User story.** As a Page operator, I ask the assistant to "post this image/video as a story" and get one plan to approve, then the story id.

**Tool.** `facebook_create_story` (posts package). It is one tool with a `media_type` discriminator, because both share the plan, gating and result shape. Two tools would double the manifest for no gain.

**Input schema (zod sketch).**
```ts
z.object({
  ...writeArgs,
  page_id: pageIdArg.optional(),           // same resolution as create_post
  media_type: z.enum(['photo', 'video']),
  media: z.string().min(1)
    .describe('https URL or a path under FB_MEDIA_DIR'),
  is_ai_generated: z.boolean().optional()  // video finish phase only (documented)
}).strict()
```
Validation (pure, in `src/api/stories.ts`):
- photo: extension or Content-Type ∈ jpeg/bmp/png/gif/tiff, size ≤ **10 MB** (local files are checked with stat; remote files with HEAD when available, else a warning).
- video: `.mp4`, size ≤ the existing video local cap. Duration is not probed locally (no ffprobe dependency). Instead, a plan warning states the documented limits: 9:16, 1080×1920 recommended (minimum 540×960), 24–60 fps, **≤60 s**. The docs say 3–90 s in the spec table but *"A video story can't exceed 60 seconds"*, so 60 s is the binding limit.
- `is_ai_generated` with `media_type:'photo'` raises `ToolInputError('is_ai_generated', 'only supported for video stories')`.

**Output.**
```ts
{ status:'applied', applied:true, outcome:'confirmed'|'attempted',
  result:{ storyPostId?: string, mediaId: string, mediaType:'photo'|'video',
           videoStatus?: 'ready'|'processing'|'error' }, journalStatus }
```

**Graph calls.**
- Photo:
  1. `POST /{page-id}/photos` with `url` or multipart `source` and `published=false` → `{id}`. Reuse `uploadPhoto(..., {published:false})`.
  2. `POST /{page-id}/photo_stories` with `photo_id` → `{success, post_id}`.
- Video (the Reels 3-phase flow with a different edge):
  1. `POST /{page-id}/video_stories` with `upload_phase=start` → `{video_id, upload_url}`.
  2. Upload to `upload_url` (rupload host):
     - local: headers `offset: 0`, `file_size`, binary body. Reuse `uploadReelBinary` with offset resume.
     - hosted: header `file_url: <https url>`. fbcdn URLs are rejected, and the host's robots.txt must allow `facebookexternalhit`. **New transfer mode**, since Reels has no `file_url` path today.
  3. Poll `GET /{video-id}?fields=status` until `uploading_phase` completes (reuse `getVideoStatus` / `mapVideoStatus`).
  4. `POST /{page-id}/video_stories` with `upload_phase=finish`, `video_id`, and optional `is_ai_generated` → `{success, post_id}`.
- Permissions: Page task **CREATE_CONTENT**, plus `pages_manage_posts`, `pages_read_engagement`, `pages_show_list` (and `business_management` for a system-user token). These match the existing posts package. No new scope.

**Write tier & preview.**
- Tier `irreversible` with `requirePlanId: true`. A story publishes immediately to the public, cannot be scheduled, and cannot be un-published through this server, which has no delete-story tool. This matches `publishesNow` for posts.
- Preview `summary`: `Publish a <photo|video> story on <Page name> (<pageId>) from <url | local file name, size, sha256 prefix>`.
- `warnings`:
  - Stories are visible for 24 h, then move to the archive only if the Page's story archive is on.
  - The video spec limits (above).
  - *"Media already used in a previous post is rejected"* (documented).
  - For a hosted video: the robots.txt/facebookexternalhit requirement.
- `metadata` (journal): mediaType, source kind (url|local), byte size, sha256, videoId and photoId once known. Never the URL query string (it is redacted by the existing shaper).

**Error cases.**

| Case | Handling |
|---|---|
| Local path outside FB_MEDIA_DIR / non-https URL | `ToolInputError` before any plan (existing resolvers) |
| Photo > 10 MB, unsupported type | `ToolInputError('media', …)` at plan time |
| Local file changed between plan and apply | `file_changed` refusal (existing sha256 binding) |
| Photo upload OK, `photo_stories` rejected cleanly (4xx with code) | Call `cleanupUnpublishedPhotos([photoId])` and report `failed` with the Graph message |
| `photo_stories` / `finish` times out or returns 5xx | `attempted`, **no retry** (C2). The notice says to check `facebook_list_stories` before retrying |
| Video `status.video_status = error` or `expired` before finish | `failed` with a phase-named error (generalize `ReelPublishError` to carry the edge) |
| Duplicate media (used before) | Pass the Graph message through and add a hint: use fresh media |
| Missing CREATE_CONTENT / scope (200/10/190) | The existing permission classifier gives an actionable hint |

**Files.**
- **NEW** `src/api/stories.ts`:
  - `PHOTO_STORIES_EDGE`, `VIDEO_STORIES_EDGE`, `STORIES_EDGE`
  - `publishPhotoStory(deps, input)`, `publishVideoStory(deps, input)`
  - `validateStoryMedia(...)` (pure), `storyVerdict`, `classifyStoryFailure`
- `src/api/media-reels.ts`: generalize the start/transfer/finish helpers to take `edge: 'video_reels' | 'video_stories'` (default `'video_reels'`, so no behaviour change). Add a `transfer: {kind:'binary'} | {kind:'file_url', url}` option to the transfer step. Keep the exported names stable.
- `src/tools/posts.ts`: `createStoryTool`, added to `createPostsPackage().tools`. Per the audit's module split, it may instead go in a **NEW** `src/tools/posts-stories.ts` imported by `posts.ts`.
- Regenerate the README tables and metadata with `scripts/gen-metadata.mjs`.

**Tests & fixtures.**
- **NEW** `src/api/stories.test.ts`:
  - photo: the two-call sequence, the params, the cleanup-on-reject path, and the timeout ⇒ attempted path with no cleanup and no retry
  - video: start → binary transfer → status poll → finish; the file_url header path; the error/expired status; `is_ai_generated` passthrough
- `src/api/media-reels.test.ts`: the existing tests stay green, plus one test with `edge:'video_stories'`.
- `src/tools/posts.test.ts`:
  - plan mode returns a preview with zero Graph mutations (the generic sweep covers it automatically)
  - apply without plan_id is refused (irreversible)
  - local path outside FB_MEDIA_DIR is refused
- Fixtures: **NEW** `test/fixtures/graph-photo-stories.json` (`{success:true, post_id}`) and `test/fixtures/graph-video-stories-start.json` (`{video_id, upload_url}`). Shapes come from the docs. Mark them `source: docs` in the fixture README until they are re-recorded live.
- The manifest snapshot (`src/mcp/packages.test.ts`, `src/metadata.test.ts`, `src/index.test.ts`) gets the new tool name. Check the annotations quadruple in `src/mcp/annotations.test.ts`: `readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:true`.

**Effort.** M (the edge generalization plus the new `file_url` transfer mode are the bulk).

**Codeable now?** Yes, fully from the docs. **LIVE PROBE** (non-blocking, in the smoke rehearsal):
- (a) a hosted `file_url` upload to `video_stories` from a non-fbcdn https host succeeds
- (b) a 61 s mp4 is rejected at finish, which confirms 60 s vs 90 s
- (c) whether `photo_stories` accepts a photo uploaded with `temporary=true`, which would avoid an orphan

**Deps.** None new. Reuses media-photos, media-reels and media-video.

**Breaking?** Additive.

---

## F2 — List Page Stories

**User story.** "What stories are live on my Page / what did we post as stories this week?"

**Tool.** `facebook_list_stories` (reader package; read-only).

**Input.**
```ts
z.object({
  profile, page_id: pageIdArg.optional(),
  since: isoOrUnix.optional(), until: isoOrUnix.optional(),
  status: z.enum(['PUBLISHED','ARCHIVED']).optional()   // client-side filter, see below
  , after: cursorArg.optional(), limit: z.number().int().min(1).max(100).optional()
}).strict()
```

**Output.**
`{ items: Array<{ postId, status:'PUBLISHED'|'ARCHIVED', createdTime (ISO), mediaType:'photo'|'video', mediaId, url }>, nextCursor? }`

**Graph.**
- `GET /{page-id}/stories` with `since`, `until`, `limit`, `after` → `data[]` of `{post_id, status, creation_time, media_type, media_id, url}`.
- No `status` query parameter is documented, so `status` is filtered after the fetch. When filtering drops items, the result carries `filteredOut: n` so a short page is not mistaken for the end.
- Permissions: same as F1 (documented on the Stories page). ARCHIVED stories appear only when the Page's story archive is enabled. The tool description says so.

**Tier.** Read; no preview.

**Errors.**
- `since > until` → `ToolInputError`.
- An empty list with archive off → a hint in `notes` (not an error).
- Permission errors → the existing classifier.

**Files.**
- `src/api/stories.ts` (from F1): add `listStoriesRequest(pageId, params)` and `mapStory(raw)`.
- `src/tools/reader.ts`: `listStoriesTool`, added to `createReaderPackage().tools`.

**Tests.**
- `src/api/stories.test.ts`: the mapping (epoch/ISO `creation_time` → ISO), the status filter, and `filteredOut`.
- `src/tools/reader.test.ts`: paging gives `nextCursor`, and the omitted cursor on the last page.
- Fixture: **NEW** `test/fixtures/graph-stories.json`.

**Effort.** S. **Codeable now:** yes. **Deps:** F1's api module (or standalone). **Breaking:** additive.

---

## F3 — Albums and photo library reads

**User story.**
- "List my Page's albums"
- "Show the photos in album X"
- "Show the photos the Page uploaded", e.g. to reuse a photo id or pick an album for F4.

**Tools** (reader package; read-only):
- `facebook_list_albums`
  ```ts
  z.object({ profile, page_id: pageIdArg.optional(), after, limit }).strict()
  ```
  → `{ items: Array<{ id, name, description?, type, count, canUpload, coverPhotoId?, link, createdTime, updatedTime }>, nextCursor? }`
- `facebook_list_photos`
  ```ts
  z.object({ profile, page_id: pageIdArg.optional(),
             album_id: graphIdArg.optional(),
             type: z.enum(['uploaded','profile','tagged']).optional(),   // Page-photos only
             after, limit }).strict()
  .refine(x => !(x.album_id && x.type), 'album_id and type are mutually exclusive')
  ```
  → `{ items: Array<{ id, createdTime, name?(caption), link, width?, height?, albumId? }>, nextCursor? }`

  The default for the Page path is `type:'uploaded'`. Graph's own default is `profile` (profile pictures), which is surprising, so the tool overrides it and says so in the description.

**Graph.**
- `GET /{page-id}/albums?fields=id,name,description,type,count,can_upload,cover_photo,link,created_time,updated_time`.
  The Page node lists `albums` as an edge. The `page/albums` reference page shows no read operation, but the Album node documents its fields and says a published Page's albums read with `pages_read_engagement`.
- `GET /{album-id}/photos?fields=id,created_time,name,link,width,height,album`. No parameters are documented. No specific permission is listed; error 200 is listed.
- `GET /{page-id}/photos?type=uploaded&fields=…`. Needs the **MODERATE** task + `pages_read_engagement` + `pages_show_list`.
- The `images` array (all renditions) is excluded from the default fields to stay inside the result budget. `fields` override follows the existing reader pattern.

**Tier.** Read.

**Errors.**
- `album_id` and `type` together → `ToolInputError`.
- An unknown album → Graph 100, passed through with the hint "use facebook_list_albums".
- MODERATE missing on `/photos` → the permission hint names the task.

**Files.**
- **NEW** `src/api/albums.ts`: `ALBUM_FIELDS`, `PHOTO_LIST_FIELDS`, `albumsEdge`, `albumPhotosEdge`, `pagePhotosEdge`, `mapAlbum`, `mapPhoto`.
- `src/tools/reader.ts`: two tools, added to the package.

**Tests.**
- **NEW** `src/api/albums.test.ts`: the field lists, the mapping, and `cover_photo` `{id}` → `coverPhotoId`.
- `src/tools/reader.test.ts`: the mutual-exclusion refusal, the default `type=uploaded` on the wire, and paging.
- Fixtures: **NEW** `test/fixtures/graph-albums.json` and `test/fixtures/graph-photos.json`.

**Effort.** S. **Codeable now:** yes. **LIVE PROBE** (optional): confirm `GET /{page-id}/albums` works with a Page token that has only `pages_read_engagement` (doc-implied, not stated on the edge page). **Breaking:** additive.

---

## F4 — Publish a photo into an album

**User story.** "Add this photo to the 'Menu' album" instead of the default Timeline Photos album.

**Tool.** Extend `facebook_create_photo_post` with `album_id: graphIdArg.optional()`. No new tool.
- With `album_id`: `POST /{album-id}/photos` with `url` or multipart `source`, `caption`, `published` and the same schedule params → `{id, post_id}`. This is **documented** on the Album photos edge.
- Do **not** use `aid` on `/{page-id}/photos`. The Page photos reference marks it DEPRECATED.

**Validation.**
- `album_id` is only valid on the single-photo tool. A multi-photo `create_post` with `photos[]` builds a feed post from unpublished children and cannot target an album.
- An optional pre-check `GET /{album-id}?fields=can_upload,name,type` at plan time:
  - `can_upload:false` → refusal.
  - The album name goes into the summary.
  - The album `type` (`profile`, `cover`, `wall`, …) is checked: system album types are refused unless `type==='normal'` or `'app'` (others are Meta-managed).

**Tier & preview.**
- The tier is unchanged (reversible/irreversible as today via `publishesNow`).
- Summary: `Publish a photo to album "<name>" (<albumId>) on <Page>`.
- `readState` is not needed.

**Errors.**
- `can_upload:false` → `ToolInputError('album_id','album does not accept uploads')`.
- Album not owned by the Page (the album's `from.id !== pageId`) → refusal.
- An album write permission error → the classifier hint.

**Files.**
- `src/api/media-photos.ts`: `uploadPhoto` takes an optional `targetEdge: {kind:'page'} | {kind:'album', albumId}` (default page). `RESERVED_PHOTO_PARAMS` is unchanged.
- `src/api/albums.ts` (F3): add `albumUploadCheckRequest`.
- `src/tools/posts.ts`: the schema field, the plan pre-check and the summary.

**Tests.**
- `src/api/media-photos.test.ts`: the album path posts to `/{album}/photos`, and the default path is unchanged.
- `src/tools/posts.test.ts`: `can_upload:false` refusal, the foreign-album refusal, and the summary text.

**Effort.** S. **Codeable now:** yes. **LIVE PROBE:** a POST to `/{album-id}/photos` with a Page token. The edge page lists no permission. Expect the `/photos` set (CREATE_CONTENT + `pages_manage_posts`), but it is unverified. Also probe whether `scheduled_publish_time` is honoured on the album edge. The docs list `published` but are silent on scheduling. Until then, the plan warns that scheduling into an album is unverified. **Breaking:** additive.

---

## F5 — Organic post `targeting` (geo + minimum age)

**User story.** "Post this only for people in Bulgaria and Romania, 18+" (alcohol, regional offers).

**Tool.** Add `targeting` to `facebook_create_post`, and to `facebook_create_photo_post` / `facebook_create_video_post` through `extraParams`. `media-photos.ts` already documents `targeting` as a passthrough the caller validates.

**Input (zod sketch).**
```ts
targeting: z.object({
  age_min: z.union([z.literal(13), z.literal(15), z.literal(18), z.literal(21), z.literal(25)]).optional(),
  geo_locations: z.object({
    countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(25).optional(),
    regions:   z.array(z.object({ key: z.string().regex(/^\d+$/) })).max(200).optional(),
    cities:    z.array(z.object({ key: z.string().regex(/^\d+$/) })).max(250).optional()
  }).strict().refine(g => g.countries || g.regions || g.cities, 'geo_locations needs at least one list').optional()
}).strict().refine(t => t.age_min !== undefined || t.geo_locations, 'targeting needs age_min or geo_locations').optional()
```
- Documented: the publishing `targeting` object takes **only** `age_min` (13, 15, 18, 21 or 25) and `geo_locations`. The `geo_locations` structure is deferred to the targeting guide, so `countries`/`regions`/`cities` with the ads-style `{key}` objects is the standard shape. That is why F5 has a live probe.
- The caps (25/200/250) are server-side guardrails, not Graph limits.

**Planner.** `planCreatePost` gets `targeting?: OrganicTargeting`, serialized as a JSON string param `targeting=...`.

**Preview.**
- The summary appends `Audience: countries BG, RO; regions 2 keys; age 18+`.
- `warnings` always includes:
  - *"Targeting narrows who sees the post in Feed; it is not a privacy control — the post stays publicly reachable by link and on the Page."*
  - *"Region/city keys are Meta location ids; look them up in Ads Manager targeting search — the server does not resolve names."*

**Output.** Unchanged. A `targetingEcho` (normalized object) is added to the plan and the result so the user sees what was bound.

**Errors.**
- An invalid `age_min` / lowercase country → a zod error with the field path.
- Graph 100 on an invalid location key → passthrough with the hint "check the key".
- `targeting` together with `child_attachments`: allowed (no doc conflict).
- `targeting` on an edit: **not** supported. `update_post` stays unchanged, because the post reference documents no update parameters.

**Files.**
- `src/api/posts-write.ts`: `OrganicTargeting` type, `normalizeTargeting` (pure: dedupe, uppercase check), wiring in `planCreatePost`, and `TARGETING_NOTE`.
- `src/tools/posts.ts`: the schema on the three create tools, the summary and the warnings.
- `README` regenerated.

**Tests.**
- `src/api/posts-write.test.ts`:
  - serialization (exact JSON string on the wire)
  - each allowed `age_min` and a rejected 16
  - empty geo refused
  - dedupe
- `src/tools/posts.test.ts`: the preview contains the audience line and both warnings, and the plan binding includes targeting (a changed targeting on apply ⇒ plan mismatch, the existing behaviour).
- Fixture: none new (response unchanged).

**Effort.** S. **Codeable now:** yes. **LIVE PROBE:** publish an unpublished (`published=false`) post with `targeting={"geo_locations":{"countries":["BG"]},"age_min":18}`, then read `GET /{post-id}?fields=targeting`. This confirms the geo key shape is accepted and echoed, without anything going live. **Deps:** none. **Breaking:** additive.

---

## F6 — Top-level comment as the Page on a post

**User story.** "Comment on our latest post as the Page: 'Tickets are live — link in bio'." For example, a first comment with a link.

**Tool.** `facebook_comment_on_post` (moderation package, next to `facebook_reply_to_comment`).

**Input.**
```ts
z.object({
  ...writeArgs, page_id: pageIdArg.optional(),
  post_id: postIdArg,                                   // {pageId}_{postId} or bare id
  message: z.string().min(1).max(8000).optional(),
  attachment_url: httpsUrl.optional(),                  // photo comment
}).strict().refine(x => x.message || x.attachment_url, 'message or attachment_url is required')
```
- Documented params: `message`, `attachment_id`, `attachment_share_url` (GIF), `attachment_url`, `source`. At least one is required.
- v2.0 exposes `message` + `attachment_url`. `source` (local multipart) and `attachment_share_url` are deferred.
- `@[page-id]` mentions are passed through verbatim. The docs say mentions are *"subject to review"*, so the description mentions it.

**Graph.**
- `POST /{post-id}/comments` with `message`, `attachment_url` → `{id}`.
- Permissions: a Page token from a person with the **MODERATE** task, or the app has `pages_manage_engagement`. Same as reply_to_comment, so no new scope.

**Tier & preview.**
- Tier `reversible` (a comment can be deleted with `facebook_delete_comment`). It joins the moderation `TIERS` map.
- Preview summary: `Comment as <Page> on post <postId>: "<first 80 chars>…"`, plus the post's first 80 chars of message, read at plan time via `GET /{post-id}?fields=id,message,from,created_time`. Do not request `can_comment`, which is documented on comment objects, not posts.
- If the post `from.id !== pageId` → warning: "commenting on another Page/user's post; requires the post to be visible to the Page".

**Output.** `{status:'applied', outcome, result:{ commentId?: string, postId }, journalStatus}`.
- A timeout → `attempted` with `REPLY_UNCONFIRMED_NOTE`-style text (do not resend; check `facebook_list_comments`).

**Errors.**
- The post is not found or not visible (100/803) → passthrough + hint.
- Comments disabled → Graph message passthrough.
- 368 (blocked for spam) → mapped, no retry.

**Files.**
- `src/api/comments.ts`: `commentOnObject(fbRequest, {objectId, message?, attachmentUrl?, ...scope})`. Refactor `replyToComment` to call it. Same edge; the behaviour stays identical.
- `src/tools/moderation.ts`: `commentOnPostTool`, `TIERS` entry, verdict = `replyVerdict` reuse.

**Tests.**
- `src/api/comments.test.ts`: the params on the wire, attachment-only, and the replyToComment regression.
- `src/tools/moderation.test.ts`: preview with the post excerpt, the foreign-post warning, timeout ⇒ attempted with no retry, and plan-mode zero mutation.
- Manifest snapshots updated.
- Fixture: **NEW** `test/fixtures/graph-comment-create.json` (`{id}`).

**Effort.** S. **Codeable now:** yes (all documented). **Breaking:** additive.

---

## F7 — Pin refinement (on the existing `facebook_update_post`)

Pin/unpin ships today (`action:'edit'`, `is_pinned`). Docs status:
- The Post reference no longer documents `POST /{post-id}` updates at all (*"You can't perform this operation on this endpoint"*), and does not list `is_pinned`.
- The v1 behaviour relies on the long-standing undocumented update.

**Refinements (code):**
1. **Single-pin warning.** At plan time, when `is_pinned:true`, read `GET /{page-id}/feed?fields=id,is_pinned&limit=25` (the existing `readPostState` pattern). If another post is pinned, warn: "Pinning replaces the currently pinned post <id>". `readState` captures the previous pinned id so the journal can show what to restore.
2. **Docs-drift note** in the tool description and `EDIT_OWN_APP_NOTE`: pinning is an undocumented Graph behaviour; if Graph rejects it, the error is passed through with that context.

**Files.** `src/tools/posts.ts` (update tool plan step), `src/api/posts-write.ts` (`pinnedPostProbeRequest`), tests in `src/tools/posts.test.ts` (pinned-elsewhere warning; no warning when none is pinned).

**Effort.** S. **LIVE PROBE (needed before claiming support in docs):**
- (a) `POST /{post-id}` with `is_pinned=true` on a post **created by this app** → success.
- (b) the same on a post created in Meta Business Suite → does the EDIT_OWN_APP restriction apply to pinning?
- (c) whether `is_pinned` is readable on the feed (needed for refinement 1). If not readable, drop refinement 1 and keep only the note.

**Breaking:** none.

---

## F8 — Page profile update with a before-snapshot

**User story.** "Set our hours to Mon–Fri 9–18, mark us temporarily closed for the holidays, update the website." The plan must show the current vs new value of every field and refuse to apply if someone changed the profile in between.

**Tool.** `facebook_update_page_profile`.
- Package: **core**, but only when the opt-in env `FB_ENABLE_PAGE_ADMIN` is set or an explicit package is enabled.
- Recommendation: a **new package `page_admin`** (`enabledByDefault:false`, `writeModeDefault:'plan'`) containing this tool. This keeps the core read-only and makes the extra permission an explicit opt-in.

**Input.**
```ts
const day = z.enum(['mon','tue','wed','thu','fri','sat','sun']);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
z.object({
  ...writeArgs, page_id: pageIdArg.optional(),
  about: z.string().max(100).optional(),               // UI "Description", 100 chars
  description: z.string().max(5000).optional(),        // UI "Additional information" (cap = server guardrail)
  website: httpsOrHttpUrl.optional(),
  phone: z.string().min(3).max(40).optional(),
  hours: z.array(z.object({ day, open: hhmm, close: hhmm })).max(14).optional(), // ≤2 ranges/day
  is_always_open: z.boolean().optional(),
  temporary_status: z.enum(['OPERATING_AS_USUAL','TEMPORARILY_CLOSED','DIFFERENTLY_OPEN','NO_DATA']).optional(),
}).strict()
 .refine(x => Object.keys(pick(x, PROFILE_KEYS)).length > 0, 'at least one profile field')
 .refine(x => !(x.hours && x.is_always_open), 'hours and is_always_open are mutually exclusive')
```
- `hours` is converted by the pure helper `toGraphHours()` into Graph's dict `{ "mon_1_open":"09:00", "mon_1_close":"18:00", "mon_2_open": … }`. Ranges are numbered per day in input order.
- Documented rule: a closing time cannot be later than 06:00 the next day. A range where `close < open` is allowed (overnight) only if `close ≤ 06:00`, else `ToolInputError`.
- At most 2 ranges per day is a server guardrail.
- `differently_open_offerings` (documented companion of DIFFERENTLY_OPEN) is deferred.
- Excluded (deprecated in v26.0 on NPE Pages, or out of scope): `current_location`, `genre`, `network`, `parking`, `start_info`, `emails`, cover/picture.

**Graph.**
- Before-snapshot: `GET /{page-id}?fields=about,description,website,phone,hours,is_always_open,temporary_status`. This field list is separate from `GET_PAGE_FIELDS`.
- Write: `POST /{page-id}` with only the changed fields (`hours` as a JSON string) → `{success:true}`. Read-after-write is supported, so it requests the same fields back to confirm.
- Permissions: **the docs name none** for these fields. Error 283 lists `pages_manage_metadata` among candidates; cover changes need EDIT_PROFILE + `business_management`. Expected: Page task **EDIT_PROFILE** (or MANAGE) + `pages_manage_metadata` (+ `pages_read_engagement`, `pages_show_list`). The `doctor` / `whoami` scope check gets this scope.

**Tier & preview.**
- Tier `reversible` (every field can be set back), with **`requirePlanId: true`** per call, because profile changes are public, business-facing and not journal-undoable automatically.
- `readState` = the before-snapshot.
- Plan payload `diff`: `Array<{field, before, after}>`, with only the changed fields. `hours` before/after are rendered as `Mon 09:00–18:00; …`.
- Fields where before === after are dropped with a warning ("no-op: website already set to …"). If everything is a no-op → a preview with `nothing to apply` and no plan id.
- `warnings`:
  - "temporary_status TEMPORARILY_CLOSED is shown prominently on the Page and in search".
  - The `hours` overnight rule.
- At apply, re-read the snapshot. `computeDivergence(before, now)` → `status:'diverged'` and no write if any target field changed since the plan.
- `metadata` (journal): field names + before/after values. These are business-public data, not secrets, so they are kept and serve as the manual undo record.

**Output.**
`{status:'applied'|'not_applied'|'diverged', outcome, result:{ changed: string[], after: Record<string, unknown> }, journalStatus}`
- After `{success:true}`, the server re-reads and verifies. A mismatch → outcome `attempted` with a "Graph accepted but value differs" warning (e.g. Meta normalizes phone formatting). It is **not** treated as a failure.

**Errors.**
- 283/200/10 (permission) → hint naming `pages_manage_metadata` + EDIT_PROFILE.
- 100 invalid param (e.g. a bad URL or hours) → passthrough with the field.
- 368 (policy block) → no retry.
- 374/375 → passthrough.
- Divergence → `diverged`.
- Timeout on POST → `attempted`; the notice says to run `facebook_get_page field_set:'profile'` (F9) to check.

**Files.**
- **NEW** `src/api/page-profile.ts`:
  - `PROFILE_FIELDS`, `PROFILE_KEYS`, `toGraphHours`, `fromGraphHours` (pure, both directions)
  - `profileSnapshotRequest`, `updateProfileRequest`, `diffProfile`, `profileVerdict`
- **NEW** `src/tools/page-admin.ts`: `createPageAdminPackage()` + `updatePageProfileTool`.
- `src/tools/index.ts`: register the package.
- `src/mcp/packages.ts`: package id `page_admin` in the known list / env parsing.
- `src/mcp/doctor.ts`: scope expectation for page_admin (`pages_manage_metadata`).
- The README package table is regenerated via `scripts/gen-metadata.mjs`.

**Tests.**
- **NEW** `src/api/page-profile.test.ts`:
  - hours round-trip (`toGraphHours`∘`fromGraphHours` = id)
  - the overnight ≤06:00 rule, 2-ranges/day, and the diff no-op dropping
- **NEW** `src/tools/page-admin.test.ts`:
  - the preview shows before/after
  - apply without plan_id is refused (requirePlanId)
  - divergence ⇒ `diverged` and zero POSTs
  - the verify mismatch ⇒ attempted + warning
  - plan mode makes zero mutations (the generic sweep picks it up)
- `src/mcp/packages.test.ts`: the new package is off by default.
- Manifest snapshots.
- Fixtures: **NEW** `test/fixtures/graph-page-profile.json` (snapshot shape incl. `hours` dict).

**Effort.** M. **Codeable now:** yes (the logic is fully specified). **LIVE PROBE (blocking for GA):**
1. With a Page token from a user with **only** `pages_manage_posts` + `pages_read_engagement`: `POST /{page-id}` with `website=…`. Expect 200/283 if `pages_manage_metadata` is required.
2. Repeat with `pages_manage_metadata` → success.
3. Read back `hours` to confirm the dict shape on an NPE Page.
4. Confirm `temporary_status` is writable on an NPE Page in v26.0.

**Deps.** F9 (shares `PROFILE_FIELDS`). **Breaking:** additive (new opt-in package).

---

## F9 — Profile fields on `facebook_get_page`

**User story.** "What hours / website / phone does the Page show right now?" This is also the read-back for F8.

**Change.** `facebook_get_page` gets `field_set: z.enum(['summary','profile']).default('summary')`.
- `summary` is today's `GET_PAGE_FIELDS`, unchanged.
- `profile` adds `about,description,website,phone,emails,hours,is_always_open,temporary_status,single_line_address,location`. `hours` is rendered through `fromGraphHours` into `[{day, open, close}]`.

**Graph.**
- `GET /{page-id}?fields=…`.
- Permissions: `pages_read_engagement` (public business fields). Probe whether `emails` needs more. If it does, drop it from the set rather than fail the read.

**Files.** `src/tools/core.ts`, `src/api/page-profile.ts` (shared constants), tests in `src/tools/core.test.ts`.

**Effort.** S. **Codeable now:** yes. **Breaking:** additive (default unchanged).

---

## F10 — Photo alt text

**User story.** "Publish this photo with alt text 'Plate of grilled sea bass with lemon'" (accessibility).

**Change.** Add `alt_text: z.string().max(1000).optional()` to `facebook_create_photo_post`, and to each item of `photos[]` on `facebook_create_post` (`photos: [{source, alt_text?}]`, while still accepting the plain string form).
- On the wire it is `alt_text_custom` on `POST /{page-id}/photos` (documented on Page photos publishing).

**Preview.** The summary marks `alt text: yes (n chars)`. A missing alt text gives no warning.

**Files.**
- `src/api/media-photos.ts`: `altText` on the upload input, mapped to `alt_text_custom`, and added to `RESERVED_PHOTO_PARAMS` so `extraParams` cannot also set it.
- `src/tools/posts.ts`: the schemas.
- Tests in `src/api/media-photos.test.ts` and `src/tools/posts.test.ts`: the string and object forms of `photos[]` are both accepted.

**Effort.** S. **Codeable now:** yes. **LIVE PROBE:** whether `alt_text_custom` set on an **unpublished child** (`published=false`) survives into the multi-photo feed post (`GET /{photo-id}?fields=alt_text_custom` after publish). If not, document the limitation as single-photo only. **Breaking:** additive (the `photos[]` union keeps the string form).

---

## Cross-cutting notes for the implementer

- **Probe bundle.** All LIVE PROBEs above can run in one smoke-rehearsal session against a test Page (`src/smoke-rehearsal.test.ts` pattern), using unpublished posts where possible:
  - F1 a/b/c
  - F3 albums read
  - F4 album write + schedule
  - F5 targeting echo
  - F7 a/b/c
  - F8 1–4
  - F9 emails
  - F10 alt on child

  Record the responses with the fixture recorder, which replaces the `source: docs` fixtures.
- **Manifest growth.** +6 tools (create_story, list_stories, list_albums, list_photos, comment_on_post, update_page_profile) and +1 package (`page_admin`). The rest are schema extensions.
- **Suggested order:**
  1. F6, F5, F3, F9, F10 (pure doc-backed S items)
  2. F1/F2 (shared module)
  3. F4
  4. F8 after its permission probe
  5. F7 after its probe
