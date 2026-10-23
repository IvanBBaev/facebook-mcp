# 03 — v2.0.0 scope

Three groups: (1) the platform migration that forces the major, (2) removals of what 1.x
deprecated, (3) optional feature headlines. Groups 1 and 2 are the **lean v2**. Group 3 depends
on decisions D1–D3 in [04-owner-decisions.md](04-owner-decisions.md).

## 1. Platform migration (the forcing function)

### 1.1 Facts (verified 2026-10-24)

- `@modelcontextprotocol/sdk` (v1) is at 1.32.2 and speaks at most 2025-11-25. Fixes continue
  for **at least six months after v2 GA (2026-07-27)**, so until about late January 2027 at the
  earliest. No exact end date is published.
- `@modelcontextprotocol/server` 2.4.0 (+ `core`, `node` 2.1.2, `codemod`) implements spec
  **2026-07-28**. It requires **zod ≥ 4.2** (4.0–4.1 silently drop `.describe()`), Node ≥ 20.
- Claude Code: local stdio negotiates 2026-07-28 by default since 2.1.292 (2026-10-06); all
  connectors since 2.1.299 (2026-10-14). It still falls back to `initialize` for 2025-era
  servers. Other clients (Cursor, VS Code, ChatGPT) have no confirmed 2026-07-28 support, so
  the legacy protocol stays supported throughout 2.x.

### 1.2 What changes in this codebase

| Area | Change | Effort |
|---|---|---|
| `package.json` | `@modelcontextprotocol/sdk` → `@modelcontextprotocol/server` (+ `@modelcontextprotocol/node` for HTTP); `zod ^4.2` | S |
| `src/index.ts` | `setRequestHandler('tools/list' \| 'tools/call', …)` with method strings (v1 request schemas throw at registration); delete `toJsonSchemaCompat` and the `zod/v4` `TolerantCallToolRequestSchema`; `extra.*` → `ctx.mcpReq.*`; `McpError` → `ProtocolError`; opt into 2026-07-28 via `serveStdio` | M–L |
| `elicitVia` (confirm seam) | On 2026 requests return `inputRequired({ inputRequests, requestState })` and finish on the re-call; on 2025 clients use the legacy shim. `FB_CONFIRM_TOKEN` fallback stays. The server-minted `plan_id` already fits stateless re-calls; carry it in `requestState`, which is **signed, not encrypted** — no tokens in it | M |
| `src/mcp/transport.ts` | stdio via `serveStdio`; HTTP via `createMcpHandler` + `toNodeHandler`, stateless; drop `sessionIdGenerator` and the DELETE re-arm. Keep the `FB_HTTP_TOKEN` bearer, Host/Origin guards and body cap. Non-JSON → 415 | M |
| `src/mcp/define.ts`, `registry.ts`, `packages.ts`, `src/core/types.ts` | zod 4 types (`z.ZodObject`, `z.ZodType`) | S |
| `src/tools/*.ts` (8 files) | two-argument `z.record`, `message` → `error` options, review the one `.default()` (`posts.ts:1485`) and one `.refine()` (`insights.ts:124`) | M |
| Tests | regenerate `tools/list` snapshots; stateless HTTP tests; interop tests for 2026-07-28 **and** the legacy handshake | M–L |
| `server.json`, `manifest.json` | version bump; check for a newer `server.schema.json` date before release | S |

Overall effort **L** (≈1–2 focused weeks, estimate). Run `@modelcontextprotocol/codemod` first;
it does not rewrite `toJsonSchemaCompat`.

### 1.3 User-visible breaks

1. **Published tool schemas change.** Measured with zod 4.6.7: dialect draft-07 → 2020-12,
   `z.record` gains `propertyNames`, key order differs; `.strict()`, optional/required, min/max,
   enum and regex render the same. What the SDK adds on top was not measured — the snapshot
   diff will show it and goes into the CHANGELOG.
2. **HTTP becomes stateless.** No `Mcp-Session-Id`, no DELETE.
3. **Confirmation flow on 2026 clients** becomes a multi-round-trip result instead of a push.
4. **Protocol error codes** may renumber (SDK uses -32020..-32022) — verify on our paths.

Unchanged: stdio configs, env variables (except the 1.x deprecations), tool names and
arguments, MCPB install.

### 1.4 Out of scope for 2.0

- **MCP Tasks** (now an extension): no mainstream client support found, no server helper in the
  TS SDK. Re-evaluate for durable video uploads after 2.0.
- **OAuth / CIMD / remote multi-tenant hosting:** the product stays local-first with a bearer
  token on loopback HTTP.
- **Skills over MCP** (SEP-2640, SDK 2.4.0): evaluate after 2.0.
- Roots, Sampling, Logging (deprecated by SEP-2577) — never used, nothing to do.

### 1.5 Dependency majors that ride along

| Dependency | Now | 2.0 | Note |
|---|---|---|---|
| zod | ^3.25.76 | ^4.2 (4.6.7) | Runtime quarantined to `src/mcp/define.ts` |
| Node floor | `>=22` | `>=24` | Node 22 EOL 2027-04-30; raising the floor is breaking |
| @types/node | ^22 | ^24 (or 26 if the floor allows) | Must match the floor |
| TypeScript | ^5.9.3 | 7 when typescript-eslint supports it | Build-only, not a semver event; may land in any minor |

## 2. Removals (deprecated in 1.x, removed in 2.0)

Each removal needs a 1.x deprecation first (warning in `doctor`, note in the tool description).

| Removal | Deprecated by |
|---|---|
| `summary.total` / `totalIsLatest` | F3 (PR #41 fields) |
| Numeric top-level error `code` | F2 (`graph.code`) |
| String form of `fields` | F7 |
| Old tool names (if renamed via aliases after 1.0 instead of before) | F6 |
| `FB_PACKAGES_DENY` / `FB_PACKAGES_READONLY` / `FB_HTTP_TOKEN` | F11 |
| Three token variables → `FB_ACCESS_TOKEN` + per-profile tokens | CC-AUTH-9 |
| `FB_API_VERSION=v23.0` override (or earlier, on Meta's 2027-10-08 retirement) | — |
| Moderation `note` (joined string) → `notes[]` | — |

## 3. Feature candidates

Implementation-ready specs for these and further codeable features are in
[features/](features/README.md).

### 3.1 Insights contract and reporting — **recommended**

- PR #41 semantics become the only contract: `kind` (flow/gauge/unknown), `aggregation`
  (sum/latest/latest_window/single/none), `value`, `firstValue`/`lastValue`/`change`,
  `aggregationNote`, Pacific-time boundaries, the window convention chosen in D4.
- Optional **`facebook_get_page_report`**: a curated summary (followers net change reconciled
  against follows − unfollows, reach, engagement, top posts) built on that contract. This is
  the "higher-level reporting tool" PR #41 deliberately left out — ask Lukasz what it should
  contain.
- Effort M. This is the differentiator the market data supports.

### 3.2 Boost-post create-chain (ads) — **conditional on D3**

This reverses A12 (create-chain deferred) for a narrow slice.

- `facebook_boost_post`: one plan, four steps — campaign (`OUTCOME_ENGAGEMENT` / `TRAFFIC` /
  `AWARENESS`) → ad set (geo + age targeting only) → creative (`object_story_id =
  {page_id}_{post_id}`, idempotent) → ad. **Everything `PAUSED`; the schema does not accept
  `ACTIVE`.** Activation stays the existing spend-tier `facebook_update_ad_object`, so there is
  still exactly one path that starts spend.
- On a failed step, delete the objects already created (they are paused and never delivered)
  and report `applied` / `rolledBack` / `orphaned` honestly.
- Plan preview: worst-case money envelope (1.75× daily per day, 7× daily per week, or the
  lifetime amount), `/generatepreviews` iframe (24 h).
- Mandatory explicit fields: `bid_strategy` (omitting it defaults to a bid-cap strategy that
  needs `bid_amount`), `special_ad_categories` = `NONE` only, `is_adset_budget_sharing_enabled`
  when ad-set budgets are used, DSA payor/beneficiary for EU targeting (from account defaults,
  refused when missing), every creative enhancement sent as `OPT_OUT`.
- New optional env `FB_ADS_CAMPAIGN_SPEND_CAP_MAX` (minor units): makes a campaign `spend_cap`
  mandatory on every created campaign. `FB_ADS_BUDGET_CEILING` keeps refusing, never clamping.
- Companions: `facebook_upload_ad_image` (Meta's MCP has no upload), single-object
  `archive_ad_object` / `delete_ad_object` (irreversible tier; warn when the object delivered in
  the last 28 days), campaign `spend_cap` on `update_ad_object` (raise = spend tier, lower =
  irreversible; the removal sentinel is refused).
- Effort L. Unverified until the live smoke: minimum permission / Page task for
  `object_story_id` creatives (`pages_manage_ads`?), v26 enhancement defaults.

### 3.3 Instagram — **conditional on D2**

If built in this server: an opt-in `instagram` package on the **Facebook Login** variant (same
host `graph.facebook.com`, same Page token, same allowlist).

- Publishing: container → poll `status_code` → `media_publish`; image, carousel (≤20), Reels,
  Stories. **Images must be at a public URL** (no binary image upload) and there is no
  server-side scheduling — both must be stated in the tool descriptions. Read the quota from
  `content_publishing_limit` (docs say 100 and 50 in different places).
- Comments moderation (maps 1:1 onto the moderation tool shapes), insights (same rename-table +
  doctor-probe pattern; `views` replaces the retired metrics), DMs through
  `/conversations?platform=instagram`.
- Scope quirk: IG publishing/comments/insights docs also list `ads_management` + `ads_read` when
  the user has a Business Manager role on the Page — the doctor must check it.
- Effort L. Additive.

### 3.4 Page profile management — optional

Narrow `facebook_update_page_profile`: `about`, `description`, `hours`, `temporary_status`,
`website`, `phone`. High blast radius on Page identity → plan-and-apply, `before` snapshot in
the journal. Permission (`pages_manage_metadata`?) needs a live probe. Effort M.

## 4. Ranked table

| Rank | Candidate | Group | Value | Effort | Breaking | Recommendation |
|---|---|---|---|---|---|---|
| 1 | SDK v2 + zod 4 + spec 2026-07-28 with legacy fallback | Platform | Forced | L | Yes | **2.0 — required** |
| 2 | Removal of 1.x deprecations | Removals | High (clean contract) | S–M | Yes | **2.0 — required** |
| 3 | Insights contract (PR #41) as the only contract | Feature | High (differentiator) | M | Yes | **2.0** |
| 4 | Node floor 24, @types/node | Platform | Medium | S | Yes | **2.0** |
| 5 | `get_page_report` curated tool | Feature | Medium–High | M | No | **2.0**, if D1 = push |
| 6 | Boost-post create-chain + upload image + archive/delete + campaign `spend_cap` | Feature | High (Meta can't boost Page posts) | L | No | **2.0**, if D3 = yes |
| 7 | Instagram package (FB Login variant) | Feature | Highest demand | L | No | **D2** |
| 8 | Page profile management | Feature | Medium | M | No | 2.0 or 2.x |
| 9 | Module splits (`doctor`, `tools/posts`, `media-*`, `index`) | Internal | Medium | L | No | Before 2.0 feature work |
| 10 | Threads | Feature | Medium | M–L | No | **Later**, as a sibling server |
| 11 | Live video, Batch API (internal reads), webhook via operator tunnel, Utility Templates, video ad creatives | Feature | Low–Medium | M each | No | **Later** |
| 12 | MCP Tasks, OAuth/remote, Skills over MCP | Platform | Low today | L | — | **Later** |

## 5. Never

- Touching the **account** spending limit upward (`spend_cap_action=delete|reset`, raising
  the account `spend_cap`): it removes Meta's own hard stop.
- Bulk delete (`DELETE /act_{id}/campaigns` with `delete_strategy`).
- Special-category or political ads (Meta stopped EU political ads on 2025-10-06), legacy
  objectives, legacy ASC/AAC creation, activation inside a create call.
- Custom audiences (PII + terms liability; Meta's MCP hashes server-side) — likely never.
- `HUMAN_AGENT` tag (App Review + Business Verification), IG hashtag search / Public Content
  Access, the Instagram-Login variant on `graph.instagram.com`, a hosted webhook relay, Page
  Events (current reference returns 404; re-check yearly).
- Chasing ads breadth (catalogs, datasets, lift tests) or app/webhook management — Meta's Ads
  MCP (91 tools per a third-party count) and Social Technologies MCP cover them.
