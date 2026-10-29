# 06 — MCP / Agent-UX Engineer review (v3)

| | |
|---|---|
| Role | Senior MCP / Agent-UX Engineer (independent, adversarial) |
| Date | 2026-10-29 |
| Scope | `@ivanbaev/facebook-mcp` 0.8.0 at commit `2c8d8bd` — 69 tools, MCP SDK 1.32.1, zod 4 |
| Inputs | `src/**`, `build/**`, `docs/analysis/v3/{02,03,05}`, the 2026-07 review `docs/reviews/07-mcp-agent-ux-engineer.md` |

**Method.**
1. `npm run build`, then a stdio client dumped `initialize`, `tools/list`, `prompts/list` and `resources/list` for each profile. The env was fake (`FB_ACCESS_TOKEN=EAAfake`), and `tools/list` makes no network calls.
2. Size is the byte length of compact `JSON.stringify(tools)`. Tokens are estimated as chars / 4 (Claude tokenizer ±15%). Descriptions, input schemas and every property were walked to count undescribed properties, enums, regexes, `$schema` copies and repeated boilerplate.
3. An in-process harness drove 15 real `tools/call`s with no network. It used `buildServer`, all 8 package factories, `build/core/fakes` (fake `fbRequest`, page resolver, clock, redactor, journal) and `InMemoryTransport` + `Client`. The calls captured real validation errors, Graph-error results, write previews, list envelopes and the taint envelope on 100 comments. Every number marked *measured* comes from these runs.
4. The 22 findings of 2026-07 were each re-checked against the source.

No live Graph call was made, and no file outside this one was changed.

## 1. Verdict

**Good-with-changes.**
1. The write-safety UX is the best I have reviewed in a community MCP server: plan → apply with `plan_id`, tiered gates, elicitation with an operator-token fallback, and honest ATTEMPTED/REFUSED notices. Graph errors carry `action`, `category`, `retryable` and `nextTool`.
2. The tool surface is too expensive. The **default** profile is 126.6 KB (~31.6k tokens); that already breaks A02's target for `all` (< 110 KB). `all` is 171.6 KB (~42.9k tokens). The roadmap puts the fix in 2.x, after two majors have shipped.
3. Validation errors, the error class an agent hits most often while learning a surface, are raw zod JSON inside a string: no `code`, no hint, no "did you mean". C01 must cover them explicitly.
4. The per-item taint envelope on comments costs ~340 chars per comment. *Measured:* at the default budget, `list_comments limit:100` returns only 50 items, and the 50 dropped are not on the next page.
5. Annotation hints contradict the tiers: `boost_post` (spends money) and `create_story` (irreversible tier) are `destructiveHint:false`. The 1.0 fix list (L2.*) does not cover either.

**Counts:** Blocker 0 · Major 7 · Minor 7 · Nit 3 (17 findings).

## 2. Measurements

### 2.1 Per-profile surface (`tools/list`)

| Profile | Tools | Bytes (compact JSON) | ~Tokens | Description chars | inputSchema chars |
|---|---:|---:|---:|---:|---:|
| default (`core`) | 53 | **126,595** | ~31.6k | 27,889 | 85,634 |
| `all` | 69 | **171,609** | ~42.9k | 38,216 | 117,141 |
| `reader` | 11 | 19,815 | ~5.0k | — | — |
| `publisher` | 13 | 32,679 | ~8.2k | — | — |
| `moderator` | 19 | 37,279 | ~9.3k | — | — |
| `ads` | 19 | 46,755 | ~11.7k | — | — |

- Input schemas are **68%** of the bytes and descriptions are 22%. The diet is a schema problem first and a prose problem second.
- To reach A02's target, `all` must lose 61.6 KB (−36%) and the default must lose 16.6 KB.
- `initialize` advertises only `capabilities:{tools:{}}`, with no `instructions` (`src/server/handlers.ts:99`). `prompts/list` and `resources/list` → `-32601 Method not found`.
- Only **3/69** tools declare an `outputSchema`: `whoami`, `usage`, `get_video_status`.

### 2.2 Top 15 heaviest tools (`all`)

| # | Tool | Total B | Description B | Schema B | Props |
|---:|---|---:|---:|---:|---:|
| 1 | `facebook_reel_insights` | 6,286 | 1,170 | 4,920 | 9 |
| 2 | `facebook_page_insights` | 6,004 | 1,333 | 4,479 | 8 |
| 3 | `facebook_post_insights` | 5,935 | 819 | 4,922 | 9 |
| 4 | `facebook_boost_post` | 5,404 | 903 | 4,308 | 19 |
| 5 | `facebook_create_post` | 5,327 | 264 | 4,873 | 11 |
| 6 | `facebook_update_ad_object` | 5,169 | 1,156 | 3,813 | 10 |
| 7 | `facebook_ads_insights` | 4,587 | 914 | 3,479 | 13 |
| 8 | `facebook_create_photo_post` | 4,361 | 249 | 3,910 | 11 |
| 9 | `facebook_send_message` | 4,349 | 1,245 | 2,913 | 9 |
| 10 | `facebook_private_reply` | 4,095 | 832 | 3,059 | 10 |
| 11 | `facebook_create_video_post` | 4,029 | 278 | 3,549 | 10 |
| 12 | `facebook_update_post` | 3,369 | 531 | 2,642 | 10 |
| 13 | `facebook_update_page_profile` | 3,171 | 495 | 2,471 | 10 |
| 14 | `facebook_duplicate_ad_object` | 2,998 | 741 | 2,051 | 8 |
| 15 | `facebook_reply_to_comment` | 2,992 | 495 | 2,297 | 7 |

- The three insights tools alone weigh 18.2 KB, more than the whole `reader` profile.
- The smallest tools are `get_moderation_settings` (698 B), `list_pages` (724 B) and `delete_saved_reply` (737 B).
- Description length: median 490, mean 554, min 145, max 1,333 (`page_insights`).

### 2.3 Schema hygiene (`all`)

| Metric | Value | Note |
|---|---:|---|
| Properties (all depths) | 457 | |
| Properties without `description` | **15** | see AUX-10 |
| Enums / defaults / `anyOf` | 39 / 22 / 6 | |
| Strict (`additionalProperties:false`) | 69/69 | good: unknown keys are rejected, not ignored |
| `title` present | 69/69 | |
| Draft-07 `$schema` copies | 72 | 3,744 B of pure waste |
| `pattern` regexes | 77 (2,844 B) | two 317-char leap-year ISO regexes (`triage_comments`, `get_activity_since`) |
| `apply` arg | 32 copies | 12,800 B |
| `plan_id` arg | 32 copies | 7,008 B |
| `confirm_token` arg | 12 copies | 3,636 B |
| `profile` arg | 51 copies | 7,242 B |
| `limit` + `after` | 16 + 16 copies | 6,304 B |
| **Gate + profile + paging boilerplate** | | **≈ 36.9 KB ≈ 21% of `all`** |

### 2.4 Runtime outputs (*measured*, in-process)

| Call | Result chars | Note |
|---|---:|---|
| `list_posts {limit:2}` | 641 | 381 chars are a static `note` repeated on every call |
| `list_comments {limit:2}` | 1,345 | ~340-char taint preamble per comment + 330-char `guidance` |
| `list_comments {limit:100}` (100 short comments, 14.7 KB raw) | 24,515 | **50 items dropped** by `FB_MAX_RESULT_CHARS=25000` |
| `create_post` preview | 1,276 | 4 static warnings ≈ 870 chars |
| `delete_post` preview | 1,029 | |
| zod error (`hide_comment {comment_id}`) | 576 | raw issue JSON in a string |
| Graph error code 10 | 439 | `action`, `category`, `retryable`, `nextTool` — good |

## 3. Status of the 2026-07 findings (`docs/reviews/07-mcp-agent-ux-engineer.md`)

| # | 2026-07 finding (sev.) | Status | Evidence / where it continues |
|---:|---|---|---|
| 1 | Write annotations underspecified (Major) | **Resolved (spec)**; correctness gap open | All 69 tools carry 4 hints (`src/mcp/annotations/*.ts`); wrong values → AUX-04 |
| 2 | `send_message` / `private_reply` irreversibility, double-send (Major) | **Resolved** | irreversible tier + `confirm_token`, journal check, `allow_repeat`, ATTEMPTED notice |
| 3 | Messaging trio confusability (Major) | **Partial** | Good cross-referencing descriptions; the `send_private_reply` rename is V3-D5 → AUX-07 |
| 4 | Reels / ~600 cap on wrong tools (Major) | **Resolved** | `list_posts` note, `create_post` warning CC-PUB-3 |
| 5 | Insights metric names vs training data (Major) | **Resolved** (at a size cost) | Metric lists in descriptions; C05 stable schema in 1.0 |
| 6 | No preview→apply binding (Major) | **Resolved** | single-use `plan_id`, `PLAN_TTL_MS` 5 min (`src/mcp/write-mode.ts:54`), `expiresAt` |
| 7 | No pagination contract (Major) | **Partial** | `after`/`nextCursor` everywhere; truncation contract leaks → AUX-02; C02 pending |
| 8 | Injected `page` arg collides with pagination (Major) | **Resolved** | renamed `profile`; one exception: `boost_post.page_id` → AUX-16 |
| 9 | Comments silently empty on user token (Major) | **Resolved** | reported as a note (`src/tools/moderation/comments.ts:101`) |
| 10 | Default profile unspecified (Major) | **Resolved**; naming open | `DEFAULT_PROFILE_PACKAGES` (`src/mcp/packages.ts`); `core` collision → I30 / AUX-17 |
| 11 | Insights shaping contract (Major) | **Partial** | compact rows + summaries; stable schema is C05 |
| 12 | `create_post` vs photo/video boundary (Minor) | **Resolved** | descriptions route; still 5 creation tools → AUX-07 |
| 13 | `hide_comment` folds unhide (Minor) | **Open** | `hide_comment {comment_ids, hidden}`; V3-D5 `set_comment_visibility` |
| 14 | `list_campaigns/adsets/ads` (Minor) | **Resolved** | three tools |
| 15 | Verbless names (Minor) | **Open** | `page_insights`, `post_insights`, `reel_insights`, `ads_insights`, `ads_report_status`, `usage`, `whoami` |
| 16 | Error → action matrix gaps (Minor) | **Partial** | Graph errors excellent; validation/unknown-tool errors have no action → AUX-03 |
| 17 | Upload progress (Minor) | **Resolved** | `progressReporterFor` (`src/server/handlers.ts`), `get_video_status` |
| 18 | `outputSchema` scope (Minor) | **Open** | 3/69 tools → AUX-08 (C03) |
| 19 | ID round-tripping (Minor) | **Partial** | `object_id` / `post_id` / `posts` / `comment_ids` drift → AUX-07 |
| 20 | Truth-in-description (Nit) | **Resolved** | lag, eligibility and edge semantics stated honestly |
| 21 | `list_scheduled_posts` in the `posts` package (Nit) | **Open (accepted)** | `src/mcp/annotations/posts.ts:17`; I30 re-homes |
| 22 | Elicitation (Nit) | **Resolved, beyond ask** | `src/server/elicitation.ts` with fail-closed operator-token fallback |

**Tally:** 12 resolved, 6 partial, 4 open, 0 regressed. One related new defect is not a regression of a 2026-07 finding: AUX-04's `boost_post` hint contradicts its own tier.

## 4. Strengths to keep

1. **Plan → apply is discoverable from the result alone.** Each preview carries a full `nextStep` sentence with the exact `plan_id`, an ISO `expiresAt` and a `notPerformedNotice` (`previewPayload` in `src/tools/shared.ts`). An agent with no system prompt completes a write on its first try.
2. **Graph errors are agent-grade.** *Measured*, code 10 → `{category:"permission", retryable:false, action:"…Do not retry…Run facebook_whoami…", nextTool:"facebook_whoami"}`. Keep this shape as the template for C01.
3. **The unadvertised-tool message** in `src/server/handlers.ts` names the package and the env var and says "Retrying will not help". Agents stop looping.
4. **The ambiguity notices are honest.** ATTEMPTED vs REFUSED, "a lost response may already have delivered the message" (`private_reply`), and verification recipes inside warnings (CC-PUB-1).
5. **Strict input schemas everywhere** (69/69). A misspelled key is a visible error, never a silently ignored argument.
6. **Negative-space descriptions.** `post_insights` says "Reel metrics are NOT reachable through this tool"; `get_posts_insights` says "For one post with full summaries use facebook_post_insights". This is the right pattern; it is just expensive (AUX-01).
7. **Layered taint defence.** Delimiters are neutralized inside UGC (`neutralizeUgc`, `src/tools/reader.ts:290`). The short warning is substituted on truncation, never dropped (`TAINT_WARNING_SHORT`, `src/mcp/taint.ts:29`). Page-authored edges are deliberately not tainted (`src/tools/reader.ts:473`).
8. **Persona profiles** (`reader` 5.0k, `publisher` 8.2k, `moderator` 9.3k tokens) are already the right answer for budget-sensitive hosts. They need to be advertised (AUX-05).

## 5. Agent task walkthroughs

The fixed cost is the `tools/list` payload, paid on every turn unless the client caches the prompt. Per-call result sizes are *measured* where the harness could produce them, and estimated from source otherwise (marked ≈).

### 5.1 Weekly performance report (profile: default, 31.6k tokens fixed)

| Step | Call | Result |
|---|---|---|
| 1 | `facebook_get_page_report {}` | ≈ 3–6 KB (window, deltas, top posts) |
| 2 (optional) | `facebook_get_posts_insights {latest:10}` | ≈ 2–4 KB |

- **Calls:** 1–2. **Tokens:** ~32k fixed + ~2k results.
- **Friction:**
  - The agent sees four insights entry points: `get_page_report`, `page_insights`, `post_insights` and `get_posts_insights`. Only description cross-links steer it to the report.
  - `get_page_report` uses `[since, until)` in Pacific Time. `ads_insights` uses an inclusive `until` in the ad-account timezone (AUX-06). "Last week" spend vs reach will be off by a day.
  - The best case is excellent: one call.

### 5.2 Comment triage (profile: `moderator` or default)

| Step | Call | Result |
|---|---|---|
| 1 | `facebook_triage_comments {posts:[…], since}` | ≈ 4–15 KB |
| 2 | `facebook_list_comments {object_id, limit:100}` | **24.5 KB, 50/100 items** (measured) |
| 3 | `facebook_hide_comment {comment_ids:[…], hidden:true}` (preview) | ≈ 1 KB |
| 4 | the same + `apply:true, plan_id` | ≈ 0.5 KB |
| 5–6 | `facebook_reply_to_comment` preview + apply per reply | ≈ 1 KB each |

- **Calls:** 4 + 2 × replies. **Tokens:** ~9–32k fixed + ~8k per 100 comments.
- **Friction (measured):**
  - The obvious `hide_comment {comment_id}` fails with a 576-char zod dump listing three issues: `comment_ids` missing, `hidden` missing, `comment_id` unknown.
  - `triage_comments` rejects `object_id`, the key `list_comments` *requires*. One concept has three arg names: `object_id`, `posts`, `post_id` (AUX-07).
  - Asking for 100 comments returns 50 plus a "re-request with a smaller limit" note. `nextCursor` still points past the dropped items (AUX-02).

### 5.3 Publish and boost (profile: `all`, 42.9k tokens fixed)

| Step | Call | Result |
|---|---|---|
| 1 | `facebook_create_post {message}` preview | 1,276 chars (measured) |
| 2 | the same + `apply:true, plan_id` | ≈ 0.4 KB |
| 3 | `facebook_boost_post {page_id, post_id, spend_cap_minor, countries, …}` preview | ≈ 1.5 KB |
| 4 | the same + `apply, plan_id, confirm_token` (or elicitation) | ≈ 0.5 KB |

- **Calls:** 4. **Tokens:** ~43k fixed + ~4k results + the full argument set re-sent twice.
- **Friction:**
  - `boost_post` is the only tool that takes `page_id` instead of `profile`.
  - It has 19 properties with `*_minor` money units.
  - It is hinted `destructiveHint:false` (AUX-04), so a hint-driven client may auto-approve the spend call. Only the server-side confirm gate stands in the way.
  - No prompt exists for this flow (AUX-05), although V3-D8 names it.

### 5.4 DM backlog (profile: default)

| Step | Call | Result |
|---|---|---|
| 1 | `facebook_get_activity_since {since, include_conversations:true}` | ≈ 3–10 KB |
| 2 | `facebook_get_conversation` × N | ≈ 1–3 KB each |
| 3 | `facebook_send_message` preview + apply (+ `confirm_token`) | ≈ 1.5 KB per reply |

- **Calls:** 1 + N + 2 × replies. **Tokens:** ~32k fixed + ~2 KB per thread.
- **Friction:**
  - `get_activity_since` is `readOnly:true, idempotent:false` with `mark_seen`. A reviewing agent that re-runs it to "double check" may advance the high-water mark and lose items. Doc 05 plans to flip it to `idempotentHint:true` (L2.reader), which is wrong while `mark_seen` defaults on (AUX-13).
  - `include_comments` and `include_conversations` have no descriptions (AUX-10).
  - The recipient key differs across tools: `psid` / `psids` / `recipient_id` / `user_id`.

### 5.5 Recovery from a wrong guess (any profile)

| Attempt | Result (measured) |
|---|---|
| `facebook_get_insights {}` | `{"error":"unknown tool: facebook_get_insights"}` — no candidates |
| `facebook_list_posts {fields:["id","message"]}` | 202-char zod JSON: "expected string, received array" |
| `facebook_list_posts {page:"brand-a"}` | "Unrecognized key: \"page\"" — no hint that it is `profile` |
| `facebook_delete_post {post_id, apply:true}` (no `plan_id`) | **a fresh preview, `isError:false`**, the gate reason buried as the 5th warning |

- **Cost:** 1–3 wasted round-trips per mistake.
- With C01 + C06 a nearest-name suggestion would make each of these recoverable in one hop (AUX-03, AUX-09).

## 6. Findings (by severity)

### AUX-01 — Major — The schema budget breaks in the default profile, and the fix is scheduled after two majors
- **Evidence:**
  - Default 126,595 B (~31.6k tokens); `all` 171,609 B (~42.9k).
  - A02 (doc 05, wave 5) targets `all` < 110 KB in **2.x**, after I40 (2.0).
  - The default is already 15% over the `all` target.
  - Input schemas are 68% of the bytes (§2.1).
  - The insights trio alone is 18.2 KB (`facebook_reel_insights`, `facebook_page_insights`, `facebook_post_insights`).
- **Impact:**
  - About 30–43k tokens are spent before the first user word, on every uncached turn.
  - Hosts that load many servers (Claude Code with 5+ MCPs) start deferring or dropping tools.
  - The model sees 53–69 near-neighbour tools and its selection accuracy drops.
- **Recommendation:**
  - Land a measurement-only budget test in **1.0**. It records current sizes with a ratcheting ceiling (no growth), per profile.
  - Ship the diet as 1.x minors: dedupe boilerplate per AUX-05, strip `$schema`/regexes per AUX-11, and move metric catalogues into `facebook://reference/insights-metrics`.
  - Targets: default ≤ 90 KB, `all` ≤ 110 KB.
  - Nothing in the diet is breaking, so there is no reason to wait for 2.0.
- **Roadmap:** 1.0 (budget ratchet), wave 1 → **NEW C07**. It owns `src/schema-budget.test.ts` and `scripts/measure-schema.mjs`; size S. Then 1.x for the diet (L5.<lane> pulled forward into 1.x minors, S each); A02 shrinks to "tighten the ceiling".

### AUX-02 — Major — Per-item taint preamble halves list capacity and breaks the paging contract
- **Evidence:**
  - *Measured* `list_comments {limit:100}` on 100 short comments: raw Graph 14.7 KB → result 24.5 KB with **50 items dropped**.
  - Note: "Dropped list items are not on the next page: re-request with a smaller limit" (`src/mcp/result.ts`).
  - Each comment's `content` repeats the 230-char `TAINT_WARNING` (`src/mcp/taint.ts:18`) plus the delimiters and the source tag, ≈ 340 chars per item.
  - The reader package wraps the *array once* (`taint('visitor_post', …)`, `src/tools/reader.ts:477`), while moderation renders per item (`renderTainted`, `src/tools/moderation/comments.ts`). That is two different taint shapes in one server.
- **Impact:**
  - Advertised `limit` max 100 is effectively ~50.
  - The agent must notice `_truncation` and re-page by hand. Many will not; they report "50 comments" as the total.
  - The two shapes mean code or prompts written against one edge break on the other.
- **Recommendation:**
  - Adopt one list-level envelope: `{"__tainted":true,"warning":…,"source":"comment","items":[…]}` with a single warning, and keep per-field delimiters only in write-preview excerpts.
  - Make truncation drop items *from the end* and set `nextCursor` to the last kept item (a Graph `after` cursor per item is available in `paging.cursors`), so nothing is lost across pages.
  - Specify both in the C02 list contract.
- **Roadmap:** 1.0, wave 1 **C02** (contract + helper) → wave 2 **L2.moderation**, L2.messages and L2.reader adopt it; size M (C02 grows from M to M+). Security co-review is needed because it changes how the warning sits next to the content.

### AUX-03 — Major — Validation and unknown-tool errors are not agent-actionable, and `code` has three types
- **Evidence:**
  - *Measured*:
    - `{"error":"[\n  {\n    \"expected\": \"array\", … \"path\": [\"comment_ids\"] …"}` for `hide_comment {comment_id}`;
    - `{"error":"unknown tool: facebook_get_insights"}` (`src/server/handlers.ts:135`);
    - `reply_to_comment {comment_id}` → `{"code":0,"httpStatus":400,…}`.
  - So `code` is a number (Graph), a string (`plan_not_found`, `WriteGateError`) or 0, and is absent on zod errors.
  - `buildErrorRecord` (`src/server/errors.ts:96`) falls through to `{error: message}` for the strict parse at `src/mcp/define.ts:127`.
- **Impact:**
  - Argument-shape mistakes are the commonest agent error in §5.
  - The agent must parse JSON inside a JSON string, gets no `action`, and gets no "did you mean `object_id`".
  - An unknown tool gives no candidates, so the agent re-reads 30k tokens of tool list or guesses again.
- **Recommendation:** C01 must define, and test, these codes:
  - `invalid_arguments` with structured `issues:[{path, problem, expected, hint}]`;
  - `unknown_argument` with `did_you_mean`, computed by edit distance against the tool's own keys plus a known-synonym table (`page`→`profile`, `comment_id`→`comment_ids`, `post_id`→`object_id`);
  - `unknown_tool` with `did_you_mean` over registered names plus C06 aliases.
  - Make Graph's numeric code `graph_code`, so `code` is always a string.
- **Roadmap:** 1.0, wave 1 **C01** (scope addition, M → L) plus a small `src/mcp/define.ts` hook for issue formatting (C01 already owns `src/server/errors.ts`). Follow-up C01b unchanged.

### AUX-04 — Major — Annotation hints contradict the write tiers (money-spending tool is "non-destructive")
- **Evidence** (`[name, readOnly, destructive, idempotent, openWorld, tier]`):
  - `facebook_boost_post` `false,false,false,true,'irreversible'` (`src/mcp/annotations/ads.ts:24`);
  - `facebook_create_story` `false,false,false,true,'irreversible'` (`posts.ts:14`);
  - `facebook_delete_saved_reply` `destructive:false` (`messages.ts:19`), although it deletes local data;
  - `facebook_update_page_profile` (`page-admin.ts:10`) and `facebook_set_moderation_settings` (`moderation.ts:24`) are `destructive:false`, while `update_post` / `update_ad_object` / `update_ad_set_targeting` are `true`;
  - `facebook_usage` is `openWorld:true`, although it reads cached headers.
- **Impact:**
  - Clients gate confirmation prompts on `destructiveHint`. The one tool that spends money is advertised as safe to auto-approve.
  - The server-side gate still holds (tier + `confirm_token`), so this is not a Blocker. But it is the defence-in-depth layer the 2026-07 finding #1 asked for.
  - Doc 05 L2.ads does not list it, and L2.messages fixes only `send_message`.
- **Recommendation:**
  - Derive the hint, with a unit test in `src/mcp/annotations/index.ts`: `destructiveHint = tier ∈ {irreversible, spend} || overwrites-existing-state`. Overrides are allowed only with a recorded reason.
  - Fix the six rows above.
  - Settle `create_story` in V3-D5 (doc 05 L2.posts tentatively makes it reversible; Stories cannot be edited, so keep it irreversible and set destructive true).
- **Roadmap:** 1.0, wave 2: L2.ads (`boost_post`), L2.posts (`create_story`), L2.messages (`delete_saved_reply`), L2.page-admin, L2.moderation and L2.core (`usage`). The derivation test goes to **I00**'s annotation loader owner → NEW **C08** (owns `src/mcp/annotations/index.ts` + test); size S.

### AUX-05 — Major — No server `instructions`, prompts or resources; the contract is repeated in 32–51 places instead
- **Evidence:**
  - `src/server/handlers.ts:99` advertises `{tools:{}}` only.
  - `apply` / `plan_id` / `confirm_token` / `profile` / `limit` / `after` descriptions are repeated 159 times ≈ 36.9 KB (§2.3).
  - The taint guidance repeats per result (`guidance` field, 330 chars).
  - A01/A03 are placed in 2.x (wave 5) and are additive.
- **Impact:**
  - The cross-cutting rules agents need *before* the first call (plan→apply, profiles, taint, `*_minor` money units, time windows) are learned by reading 30 copies.
  - Flows V3-D8 already names (weekly report, triage, publish-and-boost) have no entry point.
- **Recommendation:**
  - **1.0:** ship `instructions` (≤ 1.5 KB) covering plan→apply, `profile`, taint, pagination and money units. Then cut the per-arg descriptions of `apply` / `plan_id` / `confirm_token` / `profile` to ≤ 60 chars each (−25 KB on `all`).
  - Clients that ignore `instructions` still get `nextStep` in every preview, so nothing is lost.
  - **1.x:** the three V3-D8 prompts plus `facebook://reference/{insights-metrics,errors,time-windows}`.
  - Everything is additive, and none of it depends on SDK v2.
- **Roadmap:** A01 → **1.0** (wave 2 side task; owns `src/server/instructions.ts`, touches `src/server/handlers.ts:99`; size S). A03 → **1.x** (wave 3+, M). Needs owner decision OD-2.

### AUX-06 — Major — `since`/`until` mean six different things across tools
- **Evidence:**
  - `list_stories`: Unix-or-ISO `anyOf`.
  - `page_insights` / `post_insights` / `reel_insights`: `YYYY-MM-DD`, inclusive start, **exclusive** end, Pacific boundaries, 90-day span.
  - `get_page_report`: `window:"custom"` + `[since, until)` Pacific.
  - `triage_comments` / `get_activity_since`: ISO date-time, exclusive high-water mark.
  - `ads_insights`: `YYYY-MM-DD`, **inclusive** `until`, ad-account timezone.
- **Impact:**
  - "Last 7 days" passed identically to `page_insights` and `ads_insights` covers different days.
  - Comparisons of spend vs reach in a weekly report are silently misaligned by one day and by a timezone. The model cannot infer this from argument names.
- **Recommendation:**
  - Define one time-window contract in C02: `since` inclusive, `until` exclusive, ISO date-or-date-time. Each tool echoes the resolved window back as `window:{since, until, timezone, until_inclusive:false}`.
  - `ads_insights` translates internally.
  - Accept the old forms in 1.x with a `notes[]` deprecation.
  - Document the contract in `facebook://reference/time-windows`.
- **Roadmap:** 1.0, wave 1 **C02** (contract) + **C05** (insights echo) → wave 2 L2.insights, L2.ads, L2.reader; size M overall. Needs owner decision OD-3.

### AUX-07 — Major — Confusable families and argument drift remain beyond V3-D5 3b
- **Evidence:**
  - Pairs: `post_insights` vs `get_posts_insights`; `get_page_report` vs `page_insights`; four comment-writing tools (`reply_to_comment`, `comment_on_post`, `private_reply`, `reply_and_hide_comment`); three readers of the same comments (`list_comments`, `triage_comments`, `get_activity_since`); five creation tools (`create_post`, `_photo_`, `_video_`, `create_reel`, `create_story`).
  - Arg drift, *measured*:
    - `list_comments.object_id` (required) vs `triage_comments.posts` (rejects `object_id`) vs `private_reply.post_id`;
    - `hide_comment.comment_ids` (array) vs `reply_to_comment.comment_id`;
    - recipient `psid` / `psids` / `recipient_id` / `user_id`;
    - ads `object_id` / `adset_id` / `id`.
  - V3-D5 3b renames tool names but no argument names.
- **Impact:**
  - Most agent mis-calls in §5 are argument-name guesses that are right in a neighbouring tool.
  - Renaming tools without harmonizing args leaves the expensive half of the confusion.
- **Recommendation:**
  - Extend 3b with an **argument lexicon** (doc 05 appendix):
    - `post_id` for one post, `post_ids` for many;
    - `comment_id`, or `comment_ids` for bulk;
    - `recipient_id`.
  - Old arg names stay accepted as aliases in 1.x, through the C06 mechanism extended to args, and are removed in 2.0.
  - Fold `post_insights` into `get_posts_insights` (`post_ids:[one]` + `summaries:true`) under the insights-family rename.
  - Add a one-line "Not this tool if…" to each family member.
- **Roadmap:** 1.0, wave 1 **C06** (arg aliases, M → L), wave 2 all L2.<lane> renames. Needs owner decision OD-1 (V3-D5 scope → "3b+args").

### AUX-08 — Minor — `outputSchema` on 3/69 tools; previews and lists are untyped
- **Evidence:** only `whoami`, `usage` and `get_video_status` declare one (`src/mcp/define.ts` comment: "server-owned envelopes"). The preview envelope (§2.4) and the list envelope are stable in practice but undeclared.
- **Impact:** clients and agent frameworks cannot validate or compactly render results. Structured clients fall back to text.
- **Recommendation:**
  - C03 as planned (envelope only, v2 D6).
  - In 1.0, declare the *list envelope* and the *error envelope* generically, not only the write preview.
  - Per-tool item schemas follow in 1.x.
  - Measure the added `tools/list` bytes against the C07 ratchet. `outputSchema` counts toward the budget, so share the definitions via `$defs`.
- **Roadmap:** 1.0, wave 1 **C03**; size M (unchanged).

### AUX-09 — Minor — Apply re-sends every argument, and a missing `plan_id` yields a silent fresh preview
- **Evidence:**
  - `nextStep` says "call … again with the same arguments plus apply:true and plan_id" (`src/tools/shared.ts`, `previewPayload`).
  - *Measured* `delete_post {post_id, apply:true}` → `status:"preview", isError:false`, a *new* `planId`. The reason ("irreversible writes must bind apply:true to a plan_id") is the 5th warning.
- **Impact:**
  - For `boost_post` / `create_post` the full argument set (up to 19 properties, long messages) crosses the wire twice.
  - An agent that misses the buried reason loops preview→preview and burns a plan each time.
- **Recommendation:**
  - In 1.x, accept `{plan_id, apply:true}` alone and replay the stored arguments. The plan store already holds them for the binding check.
  - On a missing `plan_id`, put `code:"plan_required"` at the top of the preview, next to `status`.
  - Keep "same arguments" accepted for compatibility.
- **Roadmap:** 1.x (additive), wave 3+ → NEW **C09**, owning `src/mcp/write-mode.ts` and the preview helpers in `src/tools/shared.ts`; size M. Security co-review is needed: the plan must remain bound to the profile and tool.

### AUX-10 — Minor — 15 input properties have no description
- **Evidence:**
  - `create_post` / `create_photo_post` / `create_video_post`: `targeting.geo_locations`, `regions[].key`, `cities[].key` (9 properties).
  - `get_activity_since`: `include_comments`, `include_conversations`.
  - `save_reply`: `title`, `tags`.
  - `boost_post`: `dsa.payor`, `dsa.beneficiary` (EU DSA legal names — the agent will guess).
- **Impact:** guessing on targeting keys and the DSA fields leads to Meta rejections (the DSA fields) or wrong audiences.
- **Recommendation:** add ≤ 80-char descriptions, and a lint test that fails on any undescribed property in `tools/list`. It fits in the C07 test file.
- **Roadmap:** 1.0, wave 2 L2.posts, L2.messages, L2.ads; test in **C07**; size S.

### AUX-11 — Minor — Schema emission waste: `$schema` × 72 and 317-char regexes
- **Evidence:** 72 draft-07 `$schema` keys (3,744 B); two leap-year ISO regexes of 317 chars in `triage_comments.since` and `get_activity_since.since`; 77 patterns totalling 2,844 B.
- **Impact:** ~7 KB of tokens that carry no meaning for the model. Long regexes are also unreadable to it; a plain "ISO 8601 date-time" is clearer.
- **Recommendation:** strip `$schema` in the registry's schema emitter, and emit `format:"date-time"` in place of regexes (validation stays in zod server-side).
- **Roadmap:** 1.0 or 1.x, wave 1 **C03** (it owns the schema emission in `src/mcp/define.ts`); size S.

### AUX-12 — Minor — Advisory fields are inconsistent: `note`, `guidance`, `warnings`, `profile:null`
- **Evidence:**
  - *Measured* `list_posts` returns `note` (381 chars, static, on every call) and `profile:null`.
  - `list_comments` returns `guidance` (330 chars, static).
  - Previews use `warnings[]`.
- **Impact:** agents must learn three advisory channels. Static text repeated per result costs ~100 tokens per call and trains the model to skip it.
- **Recommendation:**
  - C02 `notes[]` should absorb `note` and `guidance`.
  - Static notes go to the description or a resource and are emitted only when relevant (e.g. the Reels note when the result is empty or `edge` is `published_posts`).
  - Omit `profile` when it is null.
- **Roadmap:** 1.0, wave 1 **C02** → L2.reader, L2.moderation; size S.

### AUX-13 — Minor — `get_activity_since` idempotency: the planned fix is wrong while `mark_seen` advances state
- **Evidence:** the annotation row `true,false,false,true` (`src/mcp/annotations/messages.ts:15`) plus the `mark_seen` arg. Doc 05 L2.reader plans `idempotentHint:true`.
- **Impact:**
  - A read-only, idempotent hint invites clients and agents to retry or parallelize freely.
  - With `mark_seen` on, a retry consumes the high-water mark and loses items.
- **Recommendation:**
  - Default `mark_seen:false` and make advancing explicit. Only then set `idempotentHint:true`.
  - Alternatively, keep `false` and record it as an exception.
  - Mention the cursor in `instructions`.
- **Roadmap:** 1.0, wave 2 **L2.reader** (scope change); size S.

### AUX-14 — Minor — Schema does not express "one of" requirements
- **Evidence:**
  - `facebook_private_reply` has **zero** required properties (`comment_id` XOR `post_id` is enforced only at runtime).
  - `reply_to_comment` requires only `comment_id` (message XOR attachment is runtime: *measured* `code:0` error).
  - `hide_comment` folds unhide via `hidden` (2026-07 #13, still open).
- **Impact:** the model learns the rule from a failed call. Each costs one round-trip.
- **Recommendation:** state the constraint in the property descriptions ("exactly one of `comment_id`, `post_id`"). Avoid `oneOf` (poor client support). `set_comment_visibility` per V3-D5.
- **Roadmap:** 1.0, wave 2 **L2.moderation**; size S.

### AUX-15 — Nit — Static warnings dominate write previews
- **Evidence:** in the `create_post` preview, 4 static warnings ≈ 870 of 1,276 chars (CC-PUB-1/2/3/8). The same text appears in every preview and is partly duplicated in descriptions.
- **Recommendation:** emit only the warnings that apply to the call. For example, CC-PUB-8 only when the message contains `@`. Move the rest to `facebook://reference/publishing`.
- **Roadmap:** 1.x, L5.posts (pulled forward per AUX-01); size S.

### AUX-16 — Nit — `boost_post` is the only tool addressed by `page_id`
- **Evidence:** `boost_post` requires `page_id`, has no `profile`, and 51 other tools take `profile`.
- **Recommendation:** already in V3-D5 3b ("`boost_post` arg"). Confirm that the target is `profile`, with `page_id` as a 1.x alias.
- **Roadmap:** 1.0, wave 2 **L2.ads**; size S.

### AUX-17 — Nit — The `core` profile shadows the `core` package
- **Evidence:** `src/mcp/packages.ts`: `FB_TOOL_PACKAGES=core` resolves to the default profile (6 packages), not the `core` package (2 tools).
- **Recommendation:** as planned in I30 (`default`, old name accepted). Also add a one-line `doctor` hint when `core` is used.
- **Roadmap:** 1.0, wave 3 **I30**; size S.

## 7. Roadmap critique and owner decisions

### 7.1 V3-D5 rename scope

- 3b fixes tool names, but agents fail more often on **argument names**. *Measured* examples: `object_id` vs `posts`, `comment_id` vs `comment_ids`, `page` vs `profile`.
- Renaming tools while leaving args drifting spends the one breaking window (1.0 → 2.0) on the cheaper half of the problem.
- Recommend **"3b + args"**: the 3b tool set plus the argument lexicon in AUX-07, both through C06 aliases.
- Also fold `post_insights` into the `get_*_insights` family rather than leaving a singular and a plural tool side by side.
- 3c (full grammar) remains overkill.

### 7.2 A02 budget placement

- A02 in 2.x (wave 5) measures the wrong profile (`all`) at the wrong time.
- The default profile is the out-of-box experience and is already over the `all` target.
- Every 1.x minor can add bytes unchecked until then.
- Recommend:
  - a ratchet test in wave 1 (NEW C07, S);
  - per-profile ceilings: default ≤ 90 KB, `all` ≤ 110 KB, persona ≤ 40 KB;
  - the L5.<lane> diet as 1.x minors.
- The diet is purely additive or descriptive, so semver allows it in 1.x.

### 7.3 Prompts, resources, `instructions`

- These are additive and do not depend on SDK v2 or the 2026-07-28 spec era.
- Placing A01/A03 after I40 delays the largest token saving (−25 KB of boilerplate) and the V3-D8 flows by a full major.
- Recommend:
  - A01 in 1.0;
  - A03 in the first 1.x minor;
  - the Claude plugin skills generated from the same prompt text, so the two never drift.
- Keep the resources small; each is fetched on demand, so it costs nothing in `tools/list`.

### 7.4 Other roadmap notes

- **C01** must name validation, unknown-argument and unknown-tool codes explicitly (AUX-03). Otherwise the most frequent error class stays raw zod.
- **C02** should own the list-level taint envelope and truncation-safe paging (AUX-02), plus the time-window contract (AUX-06). Security reviews the envelope change.
- **L2.<lane> annotation fixes** must include `boost_post`, `create_story`, `delete_saved_reply`, `update_page_profile`, `set_moderation_settings` and `usage` (AUX-04), not just `send_message`. Add a derivation test.
- **L2.reader**'s `idempotentHint:true` for `get_activity_since` is unsafe as written (AUX-13).
- **V3-D6 Tasks** later: agree. Progress notifications plus `get_video_status` already cover agent UX for uploads.

### 7.5 Owner decisions needed

| ID | Question | Recommendation | Blocks |
|---|---|---|---|
| OD-1 | Extend V3-D5 to argument names ("3b + args")? | Yes; aliases through C06 | C06 scope, wave 2 renames |
| OD-2 | Move A01 (`instructions`) to 1.0 and A03 (prompts/resources) to 1.x? | Yes | AUX-05; diet savings |
| OD-3 | Adopt one time-window contract (`until` exclusive, echoed window) in 1.0? | Yes | C02/C05, L2.insights, L2.ads |
| OD-4 | Add a schema-budget ratchet in wave 1 (NEW C07) and pull L5 into 1.x? | Yes; default ≤ 90 KB, `all` ≤ 110 KB | AUX-01, AUX-10 |
| OD-5 | Single list-level taint envelope (security co-sign)? | Yes | AUX-02, C02 |
| OD-6 | Allow apply by `plan_id` alone (NEW C09, 1.x)? | Yes, with profile + tool binding | AUX-09 |
| OD-7 | `create_story` tier: keep irreversible + `destructiveHint:true`? | Keep irreversible | AUX-04, L2.posts |

### 7.6 New tasks proposed for doc 05

| ID | Wave | Release | Owns | Size |
|---|---|---|---|---|
| C07 | 1 | 1.0 | `src/schema-budget.test.ts`, `scripts/measure-schema.mjs` | S |
| C08 | 1 | 1.0 | `src/mcp/annotations/index.ts` derivation + test | S |
| C09 | 3+ | 1.x | `src/mcp/write-mode.ts`, preview helpers in `src/tools/shared.ts` | M |
| A01 (moved) | 2 | 1.0 | `src/server/instructions.ts` | S |
| A03 (moved) | 3+ | 1.x | `src/mcp/resources/*`, `src/mcp/prompts/*` | M |

