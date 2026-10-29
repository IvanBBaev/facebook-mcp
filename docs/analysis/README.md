# facebook-mcp — Pre-Implementation Analysis Corpus

Analysis performed **2026-07-21**, before any code was written. This corpus is the
single source of truth for what the project is, why, and how it will be built.
Raw research inputs (local-only) live in `docs/ai/research/`; this directory is the
synthesized, reviewable output.

## Executive summary

**facebook-mcp** will be a TypeScript MCP (Model Context Protocol) server for the
Meta Graph API, operated locally by a Page/ad-account admin with their own Meta
developer app. Full requested scope: Page post publishing (text, links, photos,
video, Reels, scheduled posts), reading & insights, comment and message moderation,
and the Marketing/Ads API.

Three findings shape the design:

1. **The market gap is Pages/organic, not ads.** The ads MCP niche is saturated —
   including Meta's own official hosted server at `mcp.facebook.com/ads` — while no
   maintained TypeScript Pages server exists. The Pages side is the product; the ads
   package is a secondary, optional package (still built, since the user wants full
   scope, but not the differentiator).
2. **No App Review is needed.** A Business-type Meta app at Standard Access covers
   everything for users with an app role operating their own assets. The recommended
   credential is a **never-expiring System User token** (Business Manager), with a
   long-lived Page token as the no-Business-Manager fallback.
3. **A proven architecture already exists in-house.** `servicenow-mcp` (same author)
   provides a production-grade blueprint: 4-layer lint-enforced architecture
   (`core ← api ← mcp ← tools`), tools-as-data with a central package registry,
   plan-and-apply write gating, SSRF-guarded HTTP client, stderr-only logging,
   `node:test` + c8. This project ports that shape with Graph-API-specific internals.

## Document map

| Doc | Contents |
|---|---|
| [01-goals-and-scope.md](01-goals-and-scope.md) | Goals, target user, use cases, in/out of scope |
| [02-market-and-positioning.md](02-market-and-positioning.md) | Prior art, gaps, competitive positioning, naming/distribution |
| [03-meta-api-landscape.md](03-meta-api-landscape.md) | Graph API v23.0 facts the design depends on |
| [04-auth-and-security.md](04-auth-and-security.md) | Token strategy, permissions, security model |
| [05-architecture.md](05-architecture.md) | Stack, layering, patterns, key design decisions |
| [06-tool-catalog.md](06-tool-catalog.md) | Proposed tool surface: packages, tools, annotations |
| [07-risks-and-open-questions.md](07-risks-and-open-questions.md) | Risks, uncertainties, runtime-verification list |
| [08-roadmap.md](08-roadmap.md) | Phased implementation plan (v2, post-review) |
| [09-corner-cases.md](09-corner-cases.md) | Corner-case catalog with binding handling decisions |
| [10-v1-release-definition.md](10-v1-release-definition.md) | v1.0 definition, version map, gap additions (G-items) |
| [11-parallel-task-breakdown.md](11-parallel-task-breakdown.md) | Multi-agent work plan: waves, task IDs, file ownership, dependency DAG |
| [12-graph-changelog-check-2026-10.md](12-graph-changelog-check-2026-10.md) | Post-launch Meta changelog check (2026-10-02): versions, v23.0 sunset, impact matrix, bump recommendation |
| [v2/](v2/README.md) | v2.0.0 analysis (2026-10-24): fix-before-1.0 list, v1.x backlog, v2 scope, owner decisions, roadmap and risks |
| [v3/](v3/README.md) | v3.0.0 analysis (2026-10-28): current state vs the v2 plan, v3 scope, owner decisions V3-D1–D17, roadmap, parallel-branch task breakdown; review round of 0.8.0 in [`../reviews/v3/`](../reviews/v3/README.md) |

## Status

- **Phase:** implemented and published, not yet live-verified. This corpus
  preceded implementation by design; `src/` now holds the full server, shipped as
  `@ivanbaev/facebook-mcp` 0.8.0 on npm (the scope has one `b`, unlike the GitHub
  user `IvanBBaev`), with the registry listing `io.github.IvanBBaev/facebook-mcp`
  active. Nothing has been verified against the live Graph API yet.
- **Reviews:** seven role-based senior reviews completed 2026-07-21/22 (see
  `docs/reviews/`), consolidated in
  [../reviews/SUMMARY.md](../reviews/SUMMARY.md) — 2 Blockers, all verdicts
  go-with-changes.
- **Working mode:** development is dispatched as parallel tasks per
  [11-parallel-task-breakdown.md](11-parallel-task-breakdown.md) (waves +
  exclusive file ownership); [08-roadmap.md](08-roadmap.md) keeps governing
  verification/release gates.
- **Upkeep:** the first post-launch changelog check
  ([12-graph-changelog-check-2026-10.md](12-graph-changelog-check-2026-10.md))
  found the Marketing API side of the `v23.0` pin already retired. ✎ 2026-10-11:
  the `ads` package now has its own pin (`FB_ADS_API_VERSION`, default v26.0)
  with version-drift detection, and the insights table fixes landed. ✎
  2026-10-22: the Graph pin moved to `v26.0` too (owner decision, option C), so
  the live verification runs on the version that ships.
- **v2.0.0 analysis:** ✎ 2026-10-24: [v2/](v2/README.md) adds a fix-before-1.0
  list (F1–F14) for the contract freeze, plus the 2.0 scope (forced by the MCP SDK
  v2 migration) and owner decisions D1–D7.
- **v3.0.0 analysis:** ✎ 2026-10-28: [v3/](v3/README.md) places every v3 candidate
  in its earliest correct release (lean 3.0 = removals, Q4 2027 – Q1 2028) and splits
  the work from 0.8 to 3.0 into waves of tasks with exclusive file ownership, so they
  can run in separate branches without conflicts.
- **v3 role review round:** ✎ 2026-10-30: nine senior roles reviewed 0.8.0
  ([`../reviews/v3/`](../reviews/v3/README.md)); the delegated decisions moved the release
  labels down one major (0.9 = contracts, 1.0 = platform) and added the wave 1a and §12 tasks.
- **Next step:** verification against a live Page / ad account (the ✎-marked
  runtime items in [07-risks-and-open-questions.md](07-risks-and-open-questions.md));
  the release rail in [../runbooks/release.md](../runbooks/release.md) has already
  cut 0.7.0 and stays the path for every later tag.
