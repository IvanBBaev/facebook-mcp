# 01 — Goals and Scope

## Goal

Build an MCP server that lets an AI agent (Claude Code, Claude Desktop, any MCP
client) operate a Facebook Page through the Meta Graph API: publish content, read
and analyze performance, and moderate comments and messages. The Page/organic
surface is the product and ships as **v1.0.0**. Ad-account control is a later,
optional package: ads lands in **1.1.0**, off by default and rescoped to read +
status/budget control (see the version map in
[10-v1-release-definition.md](10-v1-release-definition.md) §1). "Operate a Page"
here means the full post/video/Reels/scheduling/moderation surface, not literally
every Pages endpoint — the out-of-scope list below is deliberately explicit about
the gaps.

## Target user

- **Primary:** the project owner — admin of a Meta developer app, a Facebook Page,
  and an ad account, running the server locally over stdio. Single-operator,
  own-assets model; no third-party users, no hosted multi-tenant service.
- **Secondary (distribution goal):** other Page admins with the same self-serve
  setup, installing via `npx` (npm) or one-click `.mcpb` (Claude Desktop). The
  server must therefore be configurable and documented beyond one person's setup,
  but multi-tenancy is explicitly out of scope.

## Use cases (requested scope: "absolutely everything")

1. **Publishing** — text/link posts, single and multi-photo posts, video upload,
   Reels, scheduled posts, draft (unpublished) posts; edit and delete own posts.
2. **Reading & insights** — list the Page's posts, read a single post with
   engagement fields, Page-level and post-level insights with the post-2025 metric
   set, follower growth, video metrics.
3. **Moderation** — read comments (incl. filtering), reply, hide/unhide, delete,
   private replies to comments, block/unblock users; read Messenger conversations
   and reply within policy windows (polling-based ingestion).
4. **Marketing/Ads (1.1.0 package, off by default — not in v1.0)** — read
   campaign/ad set/ad objects, `effective_status`, and ads insights (sync +
   async); status (pause/resume) and budget control. The create-chain
   (campaign/ad-set/ad/creative creation), ad-image/creative upload, and
   custom-audience operations are **deferred beyond v1** (A12); for ads-first
   workflows the README signposts Meta's official ads MCP.

## In scope

- Facebook **Pages** (New Pages Experience) via Graph API v23.0.
- **Marketing API** for the operator's own ad account (development-tier limits) —
  **not in v1.0**; ships in the optional `ads` package at 1.1.0, off by default,
  rescoped to read + status/budget control (A12).
- **Messenger** Page conversations via polling + Send API (24h window rules).
- stdio transport (primary); Streamable HTTP (loopback, token-guarded) as a
  secondary mode, following the servicenow-mcp transport pattern.
- npm + MCPB packaging; official MCP registry listing. Distributed under the
  **MIT license** (matching servicenow-mcp) — open source, unlike the BUSL-licensed
  market leader.

## Out of scope (explicit)

- **Personal profile publishing** — impossible via the API (`publish_actions`
  removed 2018).
- **Groups** — Groups API discontinued April 2024.
- **Instagram / Threads / WhatsApp** — different products and permission sets;
  possible future packages, not part of this analysis.
- **Webhooks-based real-time ingestion** — a local stdio server cannot receive
  webhooks; polling is the designed default. A tunnel/relay may be a future option.
- **Multi-tenant / hosted operation, App Review, Business Verification** — the
  design targets Standard Access with app-role users only.
- **Serving other businesses' ad accounts** — would require Marketing API standard
  access + review.
- **Page Stories** — the photo/video Stories publishing endpoints are **pending
  live verification at Phase 2** (A13); Stories support is **not promised** in v1.0
  and stays listed here until verified. If Phase 2 confirms the endpoints, 1–2 tools
  may be added; otherwise Stories remain out of scope.
- **Events, Live video, albums/photo-library reads** — real Pages endpoints, but
  outside the v1.0 post/video/Reels/scheduling/moderation surface.
- **Page profile management** — editing the Page's about/description, cover/profile
  imagery, and CTA buttons.
- **Organic post targeting** — country/language gating (audience restriction) on
  organic posts.
- **Boosting a post** (`/{page-id}/promotions`) — the organic→ads bridge users ask
  for first; it needs the ads package + careful spend gating and is **parked for
  post-1.0** (doc 10 §5).

## Success criteria

1. Every advertised tool works against a real Page with a System User token at
   Standard Access, with no App Review — and, once the `ads` package ships in
   1.1.0, against a real ad account on the same token.
2. Write operations are safe by default (plan-and-apply preview gating, correct
   MCP `destructiveHint`/`readOnlyHint` annotations).
3. Tokens never leak: not in logs, not in error messages, not in tool output.
4. Rate limits are respected proactively (usage headers parsed, backoff before
   throttling) — the server must not get the user's app restricted.
5. Quality gate parity with servicenow-mcp: typecheck, lint, format, tests with
   coverage thresholds, CI matrix, `npm run check` green before any release.
