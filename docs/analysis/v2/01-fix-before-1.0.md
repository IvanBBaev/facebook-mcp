# 01 — Fix before 1.0

Once 1.0 ships, the manifest snapshot anchors breaking-change detection and every item below
becomes a 2.0 item. Before 1.0 each one costs a CHANGELOG line. The items are ordered by
priority. "Additive half" means the item can land as a non-breaking addition in 1.0 with the
removal scheduled for 2.0 (see [03-v2-scope.md](03-v2-scope.md) §2).

## 1. Items

| # | Item | Evidence | Effort | Fix |
|---|---|---|---|---|
| F1 | **Profile `core` shadows package `core`** in `FB_PACKAGES_DENY` / `FB_PACKAGES_READONLY` | `src/mcp/packages.ts` `PROFILES` + shared `expandSelection`; `src/mcp/registry.ts` re-adds core after deny | S | Rename the profile to `default`. `FB_PACKAGES_READONLY=core` today makes the whole default profile read-only; `FB_TOOL_PACKAGES=core,reader` yields the full default surface including writes. This is a correctness bug, not only a naming wart. |
| F2 | **Two error envelopes**; `code` is a number for Graph errors and a string for gate errors; Zod errors have no category | `src/index.ts:598-640` `buildErrorRecord`; `src/mcp/write-mode.ts:162-173`; local envelopes `src/tools/core.ts:648-669`, `src/tools/posts.ts:388,464` | M | Freeze one envelope: `{error, category, code: string, graph?: {code, subcode, type, fbtraceId, …}, retryable, nextTool?, retryAfterMs?}`. `category: 'validation'` for Zod and client-side checks. Move it to `src/mcp/errors.ts`. Additive half: add `category` and `graph.*` now, keep the numeric top-level `code` deprecated. |
| F3 | **Insights `total` is overloaded** (sum or latest, depending on `totalIsLatest`); window is inclusive with `+1` | `src/api/insights.ts:594-617`, `:924`; PR #41 | M | Land PR #41's additive fields (`kind`, `aggregation`, `value`, `aggregationNote`, timezone note) with credit. Deprecate `total`/`totalIsLatest` in 1.0. **Decide the window convention before the freeze** (decision D4). Probe CC-INS-5 boundary semantics in the live gate. |
| F4 | **Pagination:** `nextCursor: null` in one place, omitted elsewhere; three helpers | `src/tools/posts.ts:2072` vs `src/tools/reader.ts:179`, `src/tools/messages.ts:191`, `src/tools/moderation.ts:834` | S | "Omitted ⇒ last page" (already the rule in `src/tools/shared.ts:54`); one shared helper. |
| F5 | **Casing:** inputs snake_case, outputs camelCase; the write loop crosses it (`planId` out, `plan_id` in) | `src/tools/shared.ts` `executeWrite` | S | Keep camelCase outputs. Write the rule into [doc 05](../05-architecture.md) ("server-authored keys camelCase; inputs and Graph passthrough snake_case"); add a test over output keys. |
| F6 | **Tool names without a verb**, singular names that take arrays | `facebook_page_insights`, `post_insights`, `reel_insights`, `ads_insights`, `ads_report_status`, `private_reply`; `hide_comment` / `delete_comment` / `block_user` / `unblock_user` take arrays; `hide_comment` also unhides | M | Rename before 1.0: `get_page_insights`, `get_post_insights`, `get_reel_insights`, `get_ads_insights`, `get_ads_report_status`, `send_private_reply`, `set_comment_visibility`. Keep `whoami` / `usage` as recorded exceptions. If not renamed, record each name as a deliberate exception in doc 05 so 1.0 freezes a decision, not an accident. (Decision D5.) |
| F7 | **`fields` is a CSV string** while every other list argument is an array | `reader` `list_posts` / `get_post`, `ads` `list_*` | S | Accept `string \| string[]`; array is canonical. The string form is removed in 2.0. |
| F8 | **`FB_PROFILE_<NAME>_*` parsing traps** | `src/core/settings.ts:131-132` greedy `(.+)`; warning only at `:573-600` | S | Accept `_PAGE_TOKEN` as an alias of `_TOKEN` (the natural spelling now parses as profile `ACME_PAGE`); **reject** a profile named `DEFAULT`. |
| F9 | **Unknown CLI arguments start the server** | `src/index.ts:942-960` | S | Unknown subcommand → usage + exit 2. Move CLI dispatch into `src/cli.ts`. A typo such as `facebook-mcp docter` currently hangs a terminal on stdio. |
| F10 | **`outputSchema` policy drift** | `src/mcp/define.ts` comment and doc 05 decision 8 say whoami/usage only; `get_video_status` also has one (`src/tools/posts.ts:2087,2154`) | S | Fix the docs. Decide whether write previews/applies (the most structured server-owned payload) get an `outputSchema` in 1.0. Adding one later is additive; removing one is breaking. |
| F11 | **Env naming:** `FB_TOOL_PACKAGES` vs `FB_PACKAGES_DENY` / `FB_PACKAGES_READONLY`; `FB_HTTP_TOKEN` is a transport bearer, not a Facebook token | `src/core/settings.ts:143-166` | S | Add `FB_TOOL_PACKAGES_DENY` / `FB_TOOL_PACKAGES_READONLY` (and optionally `FB_HTTP_BEARER`) as aliases now; deprecate the old names in 1.x; remove in 2.0. Put token precedence (CC-AUTH-9) in one README table. |
| F12 | **No `exports` map** | `package.json` (`main` only) | S | Export only `.` and `./package.json`, so deep imports such as `build/api/insights.js` never become a de-facto contract. Adding it after 1.0 is itself breaking. |
| F13 | **G-TOOL-3 (Reels lifecycle) still open** | doc 10, probe ready | — | Whatever `create_reel` ships (`video_state` enum, polling via `get_video_status`) freezes. Resolve in the live gate. |
| F14 | **Ads multi-account model** before 1.1 turns ads on | `src/tools/ads.ts` (no `profile`, `ad_account_id` only) | M | Decide whether ads tools take `profile` (mapped to an ad account) or stay on `ad_account_id`. The ads contract freezes at 1.1, not 1.0. |

## 2. Not on this list on purpose

- `doctor --json` stays parked (doc 10). If added in 1.x, it carries `"schemaVersion": 1` so it
  never forces a major.
- Text-argument naming (`message` / `caption` / `description`) mirrors Graph. Document it; do
  not change it.
- Module splits (`src/doctor.ts` 2320 LOC, `src/tools/posts.ts` 2220, `src/api/media-*` ≈5k,
  `src/index.ts` 1597) are internal and can happen at any time. Two of them pair naturally with
  F2 (`src/mcp/errors.ts`) and F9 (`src/cli.ts`).

## 3. Also before 1.0, outside the contract

- **Record Graph fixtures during the live gate.** `scripts/record-fixture.mjs` writes
  `test/fixtures/<version>/`, and none exist yet. They are the evidence base for the manifest
  snapshot and every later Graph bump.
- **Answer the only external contributor.** Review PR #41 (rebase onto `51a98ba`, which shipped
  a narrower stock-metric fix). Close PR #40 with a note that its content landed as `d22b6f1`.
- **Ship a release.** Nothing has been published since 0.7.0 (2026-08-27); `main` carries the
  v25/v26 fixes, the stock-metric fix and the Windows fixes.
