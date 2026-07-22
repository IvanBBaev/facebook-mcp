# Review — Senior MCP / Agent-UX Engineer

Reviewed: `docs/analysis/` 01–08 + README, `docs/ai/research/mcp-prior-art-ecosystem.md`,
`docs/ai/research/servicenow-mcp-architecture.md`, `pages-api.md`,
`marketing-api-messenger.md`, and the reference implementation at
`servicenow-mcp/src/mcp/` + `src/tools/` (define.ts, registry.ts, result.ts,
write-mode.ts, resources.ts, table.ts). Perspective: the LLM agent is the primary
user; every judgment below is about how a model will select, call, chain, and
recover from these tools mid-conversation.

## Verdict

**Go with changes.** The foundation is genuinely strong — the ported ToolSpec
pattern is one of the better model-facing designs in the ecosystem (`.describe()`
on every field, `.strict()` schemas, in-band `note` guidance, `truncated` flags,
structured errors), the ~35-tool count with package gating is squarely inside the
range where frontier models select tools reliably, and the corpus is unusually
honest about Graph API semantics. But the catalog as drafted stops one level
short of where the model-facing contract actually lives: write-tool annotations
are underspecified relative to MCP spec defaults, the plan-and-apply gate has no
binding between preview and apply (so an eager model self-approves), the
model-facing pagination contract does not exist yet, several caveats that the
corpus itself documents (Reels invisible in `list_posts`, comments silently empty
on user tokens, deprecated metric names the model will produce from its training
data) are parked in the wrong place — a Notes column or a different tool's row —
instead of being specified as description/guard contracts, and the auto-injected
`page` argument collides head-on with pagination vocabulary. None of this
requires rearchitecting; all of it must be decided before Phase 1–2 writes the
first ToolSpec, because these are exactly the contracts the manifest snapshot
test will freeze.

## Strengths worth keeping

- **Tool count and granularity are right.** ~35–40 tools across 7 packages, with
  package profiles shrinking the live surface further, is comfortably within the
  range where models select accurately (degradation is an issue at 60–100+, or
  with near-duplicate names — neither applies here). The media-type split
  (`create_post` / `create_photo_post` / `create_video_post` / `create_reel`)
  mirrors genuinely different API flows, parameter shapes, and constraint sets;
  a single `create_post` with a media union would produce a worse schema (deeply
  conditional, harder for the model to fill correctly) and worse previews. Keep
  the split; fix the boundary descriptions (Finding 11).
- **Tools-as-data + manifest snapshot test** (05 §5–6, servicenow `define.ts`/
  `registry.ts`): the tool surface is diff-reviewed on every change — this is the
  single best defense against description drift, the #1 documented ecosystem
  complaint (prior-art §A.2.4).
- **`.strict()` input schemas** — typos become visible validation errors instead
  of silently dropped args. Rare in the ecosystem, high value for agents.
- **In-band model guidance via `note` fields** (servicenow `planPreview` "No
  change was made… re-run with apply:true"; `okQueryResult` truncation notes that
  tell the model *what to do next*: "Narrow the query, select fewer fields").
  This is model-actionable output done right — port it verbatim as a house style.
- **`truncated` flag discipline** — a capped read is never presented as complete
  (ARCH-3 in the reference). Directly answers prior-art complaint #5
  (response-size pain, pipeboard #96).
- **`openWorldHint: true` across the board** is semantically correct: every tool
  touches an open world of external entities (a live audience, arbitrary
  commenters, real Messenger users).
- **API-truth orientation**: `effective_status` surfaced prominently on ads list
  tools, metric passthrough instead of a stale whitelist, `caption`-not-`message`
  on photos, delete-may-fail caveat on `delete_post` — the corpus internalized
  the "thin wrappers that lie" complaint (02 §Gaps.5) and designs against it.
- **Resources correctly demoted to secondary** (06 §Resources): the key state a
  model needs mid-conversation (`whoami`, `usage`, `list_pages`) is already
  exposed as tools. Client support for autonomous resource reads is patchy;
  tools-first is the right call. No prompts in v1 is also right.
- **Error objects that keep structure** (`GraphApiError` with `code`,
  `error_subcode`, `fbtrace_id`; 04 §Error hygiene) so the model can branch on
  401 vs 429 vs TOS-gate instead of parsing prose.
- **Doctor/`facebook_whoami` as the designated recovery target** — "permission X
  missing — run facebook_whoami" gives every permission error a canonical next
  action. This is the correct shape for model-actionable errors.

## Findings

### 1. **Major** — Write-tool annotations are underspecified; "—" rows are a contract gap

06 marks only RO/D/I and leaves every create/send tool as "—". Per the MCP spec,
when `annotations` are registered, **`destructiveHint` defaults to `true`** and
`idempotentHint` to `false`; an empty or partial annotation object therefore
means different things to different clients, and the corpus cannot claim
"aggressive annotation is a differentiator" (02 §Positioning.4) while leaving the
majority of write tools implicit. Worse, the reference being ported has at least
one spec-incorrect precedent: `servicenow_update_record` declares
`destructiveHint: false`, but the spec defines destructive as "may perform
destructive updates" vs "only additive" — an update that **overwrites** a post's
`message` destroys the prior text and is destructive in spec terms.
**Recommendation:** 06 must specify the full quadruple
(`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`) for every
tool, explicitly. Concretely: `facebook_update_post` →
`{RO:false, D:true, I:true}` (overwrites content); `facebook_update_ad_object` →
`{RO:false, D:true, I:true}` (budget overwrites lose the prior value; status
pause/resume alone would be D:false, but the tool bundles both);
`facebook_delete_post`/`delete_comment`/`delete_ad_object` →
`{D:true, I:true}` (repeat delete has no further effect — mirror
`servicenow_delete_record`); all `create_*` → `{D:false, I:false}` explicitly
(additive, so the spec default of D:true would over-trigger client confirm
dialogs on top of plan-and-apply — see Finding 6); `facebook_hide_comment` →
`{D:false, I:true}` explicitly (reversible by design — the corpus's own
moderation default rationale, 03 §Comments). Encode the quadruple in the
manifest snapshot test so it can never regress silently.

### 2. **Major** — `send_message` / `private_reply` irreversibility and the retry double-send hazard

These are the only tools in the catalog whose effect is instantly visible to a
third-party human and has **no compensating API call** (no unsend). 06 gives
them "—". Two distinct problems: (a) annotation — MCP has no "irreversible"
hint, so the practical choice is `destructiveHint: true` as the conservative
confirm-dialog trigger (defensible: an un-undoable externally visible action) or
an explicit `false` with documented rationale; the corpus must decide, not
default. I recommend `{D:true, I:false, openWorld:true}` for both. (b) The
bigger agent hazard is **non-idempotent send + model retry behavior**: when a
send times out or errors ambiguously, models retry — and double-message a real
customer. The Graph Send API has no idempotency key. **Recommendation:** specify
now that the error mapping for sends distinguishes "definitively not sent"
(4xx before dispatch) from "unknown outcome" (timeout/5xx), and that the
unknown-outcome error text explicitly instructs: "Do NOT retry blindly — check
facebook_get_conversation for whether the message was delivered." Consider a
short-lived in-process dedupe (same recipient + same text within N seconds →
refuse without `apply:true` again).

### 3. **Major** — The messaging trio is the highest-confusability cluster and its descriptions are unspecified

`facebook_reply_to_comment` (public, on the comment thread),
`facebook_private_reply` (DM, `recipient={comment_id}`, one-shot, 7-day), and
`facebook_send_message` (DM, existing conversation, 24-hour window) partially
overlap in intent-space ("respond to this person"), and two of them hit the
*same endpoint* (`POST /{page-id}/messages`). A model choosing
`reply_to_comment` when the user meant a private reply is a **privacy incident**
(publishing what was meant to be a DM); choosing `send_message` with a PSID when
`private_reply` was the only legal channel wastes the one-shot window.
**Recommendation:** 06 must specify the description contract for all three,
including negative space: each description names the other two and states the
decision rule ("Public comment reply visible to everyone — for a private DM to
the commenter use facebook_private_reply"; "First private contact triggered by
a comment: exactly ONE per comment, within 7 days of the comment — for an
ongoing conversation use facebook_send_message"; "Reply in an existing Messenger
conversation within 24h of the user's last message — cannot initiate contact;
to privately answer a comment use facebook_private_reply"). This is the concrete
antidote to the ecosystem's "misleading tool descriptions" complaint.

### 4. **Major** — Reels invisibility and the ~600-post/year cap are disclosed on the wrong tools

03 documents both facts precisely; 06 attaches "Reels invisible on post
endpoints" only to the `facebook_list_reels` row. But the model that needs the
warning is the one calling **`facebook_list_posts`** ("list everything we posted
this week") — it will return a confidently incomplete answer, which is exactly
the misleading-completeness failure the corpus criticizes in prior art. Same for
the ~600 ranked posts/year listing cap (03 §Reading) — absent from the
`list_posts` row entirely. **Recommendation:** specify that `list_posts` and
`get_post` descriptions carry "Reels are NOT returned by this tool — use
facebook_list_reels" and that `list_posts` responses (or at minimum its
description) disclose the ~600/year ranking cap; when deep pagination stops,
the in-band `note` should say the cap may be the reason, not "end of data".

### 5. **Major** — Insights tools will collide with the model's training data; the metric list must live in the description

Every frontier model's training data is saturated with `page_impressions`,
`page_fans`, `post_impressions_unique` — all invalid since the 2024–2026
deprecation waves (03 §Insights). "Pass metrics through and surface API errors
readably" (R1 mitigation) is correct as a *mechanism* but insufficient as *UX*:
the most predictable first call is a deprecated metric name, a burned API call,
and an error. **Recommendation:** (a) put the current safe metric set verbatim
into `facebook_page_insights`/`facebook_post_insights` descriptions, with an
explicit "metric names from before 2025-11 (`page_impressions*`, `page_fans*`,
`*_unique`) are invalid"; (b) map the invalid-metric error (code 100/3001) to a
suggestion: "`page_impressions` was removed 2025-11 — nearest current metric:
`page_media_view`". A small static rename table for the famous ones costs
nothing and converts a dead-end error into a one-step recovery. This is the
cheapest high-impact model-UX win in the whole catalog.

### 6. **Major** — Plan-and-apply: no preview→apply binding, undefined interaction with client confirmations, unspecified preview payloads

Three sub-issues with the `apply?: boolean` gate (05 §7, servicenow
`write-mode.ts`):

- **Self-approval.** Nothing binds the apply call to a prior preview. Models
  learn the pattern from the `applyInput` description itself ("set true to
  apply") and start passing `apply:true` on the *first* call — at which point
  the gate protects nothing. For most tools that is acceptable (the flag is at
  least a deliberate act, and client confirms still fire), but 05 itself calls
  publishing "the most consequential action this server performs" and declares
  safe-by-default non-negotiable. **Recommendation:** for the
  highest-consequence tools only (`create_post` with `published:true`,
  `create_reel` with `PUBLISHED`, `send_message`, `private_reply`,
  `delete_post`), have the preview return a short-lived `plan_id` and require it
  alongside `apply:true`. In-process state is fine for a stdio session. Document
  the deliberate exception: `FB_WRITE_MODE=apply` bypasses it for automation.
- **Confirmation stacking.** Claude Code/Desktop already prompt on
  non-read-only tools. With plan-and-apply the user confirms the tool call, gets
  back… a preview; then confirms again for the apply call. Two-to-three prompts
  per post drives users to `FB_WRITE_MODE=apply`, destroying the safety story.
  06's blanket "every write tool participates" makes this worst for high-volume,
  low-consequence moderation (`hide_comment` across 20 comments = 40 prompts).
  **Recommendation:** specify a per-package (or per-tool) default write mode:
  publishing/messaging plan-first; moderation apply-by-default with
  `destructiveHint` correctly false on reversible ops (Finding 1) so client
  prompting stays proportionate. Acknowledge the stacking explicitly in 05.
- **Preview content.** servicenow's `planPreview` echoes `before`/`after` —
  meaningful for record updates, nearly worthless for creates ("here is your
  own input back"). A preview is useful to a model when it contains what the
  model *cannot know*: the resolved target (Page name + ID from the `page`
  profile — the #1 wrong-target guard), the resolved publish state
  (now/scheduled-at-ISO/draft), validation results against the permission
  matrix (whoami data: "this token lacks pages_manage_posts — apply will
  fail"), local constraint checks (Reels 3–90 s, 30/24h budget remaining,
  scheduling window), and best-effort warnings (link preview override only for
  verified domains). For `update_post`/`delete_post`, fetch and show `before`
  as servicenow does. **Recommendation:** 06 should specify the preview
  contract per write family; a validating dry-run preview is the feature, an
  echo is not. Also keep and strengthen the anti-hallucination note: previews
  must state `posted: false` / "The post was NOT published" so the model cannot
  report success after a plan-mode call.

### 7. **Major** — The model-facing pagination contract does not exist

05 §3 specifies the internal helper (single page, `fetchAll` cap, `truncated`)
but 06 never says how pagination is *exposed to the model*: is there an `after`
cursor input on `list_posts`/`list_comments`/`list_conversations`? Does the
response carry `next_cursor`? Without it the model literally cannot fetch page
2; with it, three things need specifying now: (a) the cursor round-trip params
and response field names (one convention across all list tools); (b) the
cursor-expiry error mapping — Graph cursors "can quickly become invalid" (03),
so error 100-on-cursor must map to "cursor expired — restart the listing from
the beginning", not a generic failure; (c) truncation semantics — when the
character budget halves a comment thread, which end survives? Specify
"truncation keeps the first records; ordering is controlled by the `order`
param", so a model that needs newest-first can get it deterministically.
**Recommendation:** add a "list-tool contract" subsection to 06 covering
cursor-in/cursor-out naming, expiry error text, and truncation ordering.

### 8. **Major** — The auto-injected `page` argument collides with pagination vocabulary; single-page default deserves special-casing

`page` is the single most overloaded word in a list-tool context. A user asks
for "page 2 of the posts" and the model has an optional `page` string parameter
staring at it on `facebook_list_posts` — the misfire writes itself
(`page: "2"` → "Unknown profile" error at best, silent weirdness at worst).
servicenow's `instance` had no such collision. Additionally, for the
overwhelming default (exactly one configured Page), the parameter is pure noise
on all ~35 tools and invites hallucinated values (the Page's display name, its
numeric ID). **Recommendation:** rename to `profile` (or `page_profile`);
describe it as "Only needed when multiple Page profiles are configured — omit
otherwise"; on mismatch return the servicenow-style recovery error listing
available profiles ("see facebook_list_pages"); accept either the profile key
or the exact Page ID (models will pass IDs they just read from `list_pages` —
meet them there). Consider suppressing injection entirely when one profile is
configured — if the manifest snapshot must stay config-independent, keep the
param but make the describe() text carry the omit-by-default guidance.

### 9. **Major** — Comments-on-user-token returns silently empty; a description cannot fix a silent failure

03 documents it: "user token silently returns empty" on `/comments`. 06's
mitigation is "Page-token requirement documented" — but this failure produces
**no error to map**: the model sees `[]`, reports "no comments", and is wrong
with full confidence. Documentation in a description does not reliably override
an empty-but-well-formed result. **Recommendation:** an active runtime guard:
the server knows the token type from startup `debug_token` (04); when
`facebook_list_comments` (or any moderation read) runs with a user token,
return an explicit error — "Comments require a Page access token; this server
is configured with a user token — run facebook_whoami" — instead of the API's
silent empty. This turns the nastiest trap in the Pages API into a one-step
recovery. Same class of issue: `page_insights` on a <100-like Page returns
empty — the response should carry a `note` explaining why, not bare `[]`.

### 10. **Major** — The default (`core`) profile's package expansion is unspecified — the out-of-box tool surface is undefined

05 §6 lists profiles (`core` default, `all`, `reader`, `publisher`,
`moderator`, `ads`) and 06 says ads is "off by default in the `core` profile",
implying `core` includes everything else — but nowhere is the expansion written
down. In servicenow, `CORE_PROFILE` is an explicit four-package list; if the
port mirrors that shape and `core` = just the `core` package, the default
install is 4 read-only tools and **cannot post** — a fatal first-run experience
for a server whose flagship is publishing. **Recommendation:** specify the
expansion in 06/05 now, e.g. `core` = core + posts + reader + insights +
moderation + messages (≈27 tools, ads excluded). This is the most important
single line missing from the corpus: the OOTB surface *is* the product.

### 11. **Major** — Insights response shaping is a designed contract, not a passthrough — specify it now

Raw Graph insights are arrays of
`{name, period, values:[{value, end_time}…], title, description, id}` — a
90-day daily window × 5 metrics ≈ 450 value objects with ISO timestamps plus
per-metric `title`/`description` boilerplate: easily 10–30k characters that the
halving-loop would then truncate *mid-series*, which is worse than reshaping.
Same for `facebook_ads_insights` with breakdowns (cartesian row explosion).
**Recommendation:** 06 should commit to a compact reshape: strip
`title`/`description`/`id`, collapse series to
`{metric: {period, values: [["2026-07-01", 123], …]}}` (or offer
`aggregate: "sum"|"series"` defaulting to totals for periods), cap breakdown
rows with the `truncated` flag + a "narrow with time_range/breakdowns" note.
Also state the character-budget default (`FB_MAX_RESULT_CHARS` value) in 05 —
"character budget" without a number is not reviewable; ~25k chars (≈6k tokens)
is a sane stdio default.

### 12. **Minor** — `create_post` vs `create_photo_post` boundary and video-vs-reel routing need negative-space descriptions

Two boundary ambiguities inside the (correctly) split media family:
(a) `create_post` mentions "carousel via `child_attachments`" (a *link*
carousel) while multi-*photo* posts belong to `create_photo_post` — a model
holding three photos and the word "carousel" has a coin-flip. Each description
must state its media scope negatively: "no photo/video uploads — use
facebook_create_photo_post / _video_post". (b) A 30-second 9:16 clip is valid
for both `create_video_post` and `create_reel`; descriptions must carry the
decision rule (Reel = short vertical 3–90 s, lands in the Reels tab, invisible
to `list_posts`; video post = regular feed video) and `create_video_post`
could helpfully note "if you want a Reel, use facebook_create_reel" when specs
match. Specify these cross-references in 06 so they survive into the specs.

### 13. **Minor** — `hide_comment` folds unhide while block/unblock are split — verb asymmetry

06 gives `facebook_block_user` / `facebook_unblock_user` separate tools but
folds unhide into `facebook_hide_comment` (`is_hidden` true/false). A model
scanning tool names for "unhide" finds nothing and must infer from a
parameter. Either split `facebook_unhide_comment` (consistent with
block/unblock, costs one tool) or keep the fold but title/describe it as
"Hide or unhide…". Pick one symmetry policy and apply it everywhere.

### 14. **Minor** — `facebook_list_campaigns / adsets / ads` — one tool or three? The row is ambiguous

06 line 69 puts three names in one row. If it is three tools, the count and
manifest are fine; if it is one tool with a `level` param, it contradicts the
one-verb-one-noun convention. Ads already has generic-object read/update/delete
(`get_ad_object`, `update_ad_object`, `delete_ad_object`) next to typed
creates — a reasonable asymmetry (creates differ structurally; updates are
mostly status/budget/name), but the list-row ambiguity should be resolved
explicitly in the catalog since it moves the total by two.

### 15. **Minor** — Naming convention breaks: verbless tools; codify the exceptions

Convention is `facebook_<verb>_<noun>`, but `facebook_page_insights`,
`facebook_post_insights`, `facebook_ads_insights`, `facebook_usage`, and
`facebook_whoami` have no verb. `whoami`/`usage` are idiomatic enough to keep
as named exceptions; the insights trio should either become
`facebook_get_page_insights` etc. or the convention text in 06 should list the
exceptions explicitly — and the manifest snapshot test should enforce the
convention with that exception list, so drift is caught mechanically.

### 16. **Minor** — Error → model-action matrix has gaps beyond the two headline mappings

06 §Cross-cutting names permission-missing and rate-limit mappings; 03/04 cover
24-hour window, 7-day private reply, and TOS-gate 1870090. Still missing from
any doc: (a) **error 190** (token expired/invalidated mid-session) → "token
invalid — re-issue per README, then facebook_whoami"; (b) **error 506**
(duplicate post) — highly likely under agent retries → "identical post already
published — change the content or confirm the earlier post"; (c) **error 368**
(temporary policy block) → "do not retry; wait and review content"; (d)
edit/update on a post not created by this app → the same actionable text as
the delete caveat ("only app-created posts are editable via API"); (e) async
ads report flow — what the model sees while a report run polls (does the tool
block, or return a `report_run_id` to poll via a follow-up call? specify); (f)
cursor expiry (Finding 7). Add a single error-mapping table to 06 or 05 —
`{code, subcode} → model-facing text + recommended next tool` — and
snapshot-test it. The mapping is a first-class model API, not an internal
detail.

### 17. **Minor** — Long-running uploads: name the MCP progress mechanism and the resume contract for the model

06 says `create_video_post` has "progress reporting" and 05 says "progress in
tool output" — but a resumable 1 GB upload inside one tool call can run for
minutes, and several MCP clients time tool calls out. Specify: (a) MCP progress
notifications (`notifications/progress` via the request's `progressToken`) as
the mechanism, with graceful no-op when the client did not request it; (b) the
interrupted-upload contract the *model* experiences — on failure, does the
error say "re-run the same call with the same file to resume session X" (server
persists session state), or must the model do anything differently? A model
cannot babysit a state machine unless the error text tells it the one action
to take.

### 18. **Minor** — outputSchema/structuredContent scope is circular — name the tools, use token cost as the criterion

06 says "structuredContent where an output schema exists" — which is the
definition, not a decision. The SDK sends text content *and*
`structuredContent`, and clients commonly serialize both into model context:
double tokens on the fattest payloads if list tools get schemas. servicenow's
`okStructured` is correctly opt-in with a comment saying exactly this.
**Recommendation:** commit in 06 to the v1 output-schema list:
`facebook_whoami` (the doctor matrix is the one payload downstream tooling will
parse), `facebook_usage`, and possibly a compact insights summary — and
explicitly *not* the list tools. One sentence, prevents both over- and
under-adoption during implementation.

### 19. **Minor** — ID round-tripping between tools is unspecified — the chaining contract is the agent UX

Graph has at least four ID shapes in play: `{page-id}_{post-id}` composite post
IDs, bare photo `id` vs `post_id` in photo-create responses, comment IDs,
conversation `t_…` IDs, and PSIDs. A model chains tools by pasting an ID from
one output into the next input; every mismatch is a wasted call plus a
confused recovery. **Recommendation:** add one cross-cutting rule to 06: every
tool returns IDs in the canonical form its sibling tools accept
(`create_photo_post` returns the *post* ID prominently, `get_conversation`
surfaces participant PSIDs explicitly because `send_message` needs one,
`list_posts` returns composite post IDs that `get_post`/`update_post`/
`delete_post` accept verbatim), and input `.describe()` texts name which tool's
output the ID comes from ("post ID as returned by facebook_list_posts").

### 20. **Nit** — Truth-in-description details worth pinning now

Three facts from 03 that must survive into descriptions/outputs or the tools
will quietly mislead: (a) `get_reactions` — CARE is folded into LIKE counts;
(b) `create_post` link-preview overrides are best-effort (verified domains
only) — the preview payload should warn (covered in Finding 6) and the
description should not promise customization; (c) scheduling window 10 min–29
days stated in `create_post`/`create_reel` descriptions so the model does not
burn a call discovering it; (d) `update_ad_object` — setting `status: ACTIVE`
does not mean delivering; point at `effective_status`.

### 21. **Nit** — `facebook_list_scheduled_posts` (RO) lives in the write-gated `posts` package

A `reader`-profile install cannot see the scheduled queue. Defensible (the
queue only exists if someone publishes), but note it — or move it to `reader`
— so the profile matrix in 05 §6 is deliberate rather than accidental.

### 22. **Nit** — Elicitation deserves one sentence as a considered-and-deferred alternative

The 2025-11-25 spec's elicitation could eventually replace the double-confirm
stacking in Finding 6 for clients that support it (server asks the *user* to
confirm an apply, out-of-band from the model). Client support is too patchy to
build on now — the corpus's transport-agnostic plan-and-apply is the right v1
choice — but 06/05 should record elicitation as the known future confirm
channel so the write-gate module keeps a seam for it.

## Open questions for the author

1. What exactly does the default `core` profile expand to, package by package?
   (Finding 10 — this defines the out-of-box product.)
2. `facebook_list_campaigns / adsets / ads`: one tool with `level`, or three
   tools? (Finding 14.)
3. Will the auto-injected profile argument accept the profile key only, or also
   the raw Page ID a model just read from `facebook_list_pages`? And are you
   willing to rename it away from `page`? (Finding 8.)
4. Are you willing to hold in-process preview state (a `plan_id`) for the
   highest-consequence writes, or is stateless plan-and-apply a hard
   requirement? (Finding 6.)
5. Which tools get `outputSchema` in v1? (Finding 18 — needs a named list, not
   a criterion.)
6. Is plan-and-apply really blanket-on for high-volume moderation
   (`hide_comment`, `reply_to_comment`), or per-package defaults? What does a
   20-comment moderation session feel like in Claude Code with client confirms
   stacked on plan mode? (Finding 6b.)
7. What is the model-facing pagination surface — cursor param names, response
   cursor field, and the cursor-expiry error text? (Finding 7.)
8. For ambiguous-outcome `send_message` failures (timeout after dispatch), what
   is the specified model guidance — and is the in-process double-send guard
   in scope for v1? (Finding 2.)
9. `FB_MAX_RESULT_CHARS` default value — what number, and is the
   truncation-keeps-first-records rule acceptable for reverse-chronological
   comment threads? (Findings 7c, 11.)
