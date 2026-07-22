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
| [03-meta-api-landscape.md](03-meta-api-landscape.md) | Graph API v25.0 facts the design depends on |
| [04-auth-and-security.md](04-auth-and-security.md) | Token strategy, permissions, security model |
| [05-architecture.md](05-architecture.md) | Stack, layering, patterns, key design decisions |
| [06-tool-catalog.md](06-tool-catalog.md) | Proposed tool surface: packages, tools, annotations |
| [07-risks-and-open-questions.md](07-risks-and-open-questions.md) | Risks, uncertainties, runtime-verification list |
| [08-roadmap.md](08-roadmap.md) | Phased implementation plan (v2, post-review) |
| [09-corner-cases.md](09-corner-cases.md) | Corner-case catalog with binding handling decisions |
| [10-v1-release-definition.md](10-v1-release-definition.md) | v1.0 definition, version map, gap additions (G-items) |
| [11-parallel-task-breakdown.md](11-parallel-task-breakdown.md) | Multi-agent work plan: waves, task IDs, file ownership, dependency DAG |

## Status

- **Phase:** pre-code. No `src/` exists yet; this corpus precedes implementation by design.
- **Reviews:** seven role-based senior reviews completed 2026-07-21/22 (see
  `docs/reviews/`), consolidated in
  [../reviews/SUMMARY.md](../reviews/SUMMARY.md) — 2 Blockers, all verdicts
  go-with-changes.
- **Working mode:** development is dispatched as parallel tasks per
  [11-parallel-task-breakdown.md](11-parallel-task-breakdown.md) (waves +
  exclusive file ownership); [08-roadmap.md](08-roadmap.md) keeps governing
  verification/release gates.
- **Next step:** run Wave 0 (D01–D07 corpus corrections, parallel), clear the
  user gates U1–U4, then dispatch Wave 1 per doc 11.
