# facebook-mcp v3.0.0 — Analysis Corpus

Analysis performed **2026-10-28** against `main` @ `d294b9e` (package 0.7.0 published,
42 local commits unreleased). It extends the [v2 corpus](../v2/README.md) and does not replace
it. Raw research inputs (local-only) live in `docs/ai/research/v3/`; this directory is the
synthesized, reviewable output.

## Executive summary

1. **3.0 can only be defined relative to a 2.0 that has not happened yet.** The v2 plan was
   *1.0 contract fixes → 2.0 platform migration → features*. The repo did the opposite.
   Features landed on 0.x: of the v2 feature specs F1–F14, only F3 is done and F8 is partial,
   but boost-post, ad duplication and moderation settings shipped outside the plan. None of the
   twelve contract fixes and none of the 2.0 platform migration has started. Most "v3
   candidates" are therefore **1.0 or 2.0 items that slipped**, not 3.0 items
   → [01-current-state.md](01-current-state.md).
2. **3.0 has a real window, and it is late.** MCP spec revisions now ship every six months
   (2027-03-30, ~2027-09-28, ~2028-03-28). The first revision that may remove the 2026-07-28
   deprecations is ~2027-09-28. No TS SDK v3 is announced. Node 24 (the 2.0 floor) reaches EOL
   on **2028-04-30**. Realistic 3.0: **Q4 2027 – Q1 2028**, at the latest before 2028-04-30.
   3.0 is a *removal* release: legacy-era clients, 2.x shims and `FB_CONFIRM_TOKEN` are dropped,
   and the Node floor moves to 26 → [02-v3-scope.md](02-v3-scope.md).
3. **Meta forces maintenance, not a major.** The Graph pin v26.0 has no forced bump before about
   Dec 2028. The Marketing pin needs about one bump per year (≈ Aug–Sep 2027, then H1 2028).
   The real Graph risk is **all-version insights waves**, which a pin does not stop. The answer
   is a server-owned, stable insights output schema. That is the one Meta-driven contract change,
   and it belongs in 1.0, not 3.0.
4. **Adoption is the gate, and distribution is the bottleneck.** The npm floor is ~45/week,
   with 2 stars, 0 non-author issues and zero referrers in 14 days. 0.7.0 has had no successor
   for two months. PR #41 (the only external contributor) is small, mergeable and unreviewed.
   v3 *engineering* investment is gated on evidence measured for 30 days **after** a real
   release plus directory listings → [03-owner-decisions.md](03-owner-decisions.md).
5. **The work is planned to run in parallel branches without collisions.** Every cross-cutting
   change is split into a *contract* task, which owns the shared files, and per-package *lane*
   tasks, which own disjoint file sets. The four oversized files (`posts.ts`,
   `moderation.ts`, `doctor.ts`, `src/index.ts`) are split first, behind facades that keep
   import paths stable. Shared wiring files belong only to integration tasks
   → [05-parallel-task-breakdown.md](05-parallel-task-breakdown.md).

Recommended shape: **ship 0.8 now → 1.0 = contract fixes → 2.0 = platform (spring 2027) →
2.x additive → lean 3.0 (Q4 2027 – Q1 2028)**. The ambitious variant (monorepo with the
Instagram sibling, opt-in remote mode, Tasks) is held behind the adoption gate.

## Document map

| Doc | Contents |
|---|---|
| [01-current-state.md](01-current-state.md) | v2 plan vs reality, roadmap inversion, measured surface, gate and adoption status |
| [02-v3-scope.md](02-v3-scope.md) | Forcing functions (MCP, Node, Meta), placement of every candidate (1.0 / 2.0 / 2.x / 3.0 / never), lean vs ambitious 3.0 |
| [03-owner-decisions.md](03-owner-decisions.md) | Decisions V3-D1…V3-D11 with options and recommendations; open v2 decisions carried over |
| [04-roadmap-and-risks.md](04-roadmap-and-risks.md) | Dated phases from now to 3.0, watch list, risks |
| [05-parallel-task-breakdown.md](05-parallel-task-breakdown.md) | Dispatch board: task IDs, exclusive file ownership, dependencies, waves, branch and merge rules, definition of done |

## Urgent dates

| Date | What | Action |
|---|---|---|
| now | 42 commits unpushed, 0.7.0 is the only release | Ship 0.8.0 (wave A in doc 05) |
| 2026-11-20 | Meta Commercial / Self-Serve Ad Terms update (moved from 10-30) **[UNVERIFIED]** | Docs only: the operator owns every write |
| 2026-11-25 | D1 adoption checkpoint (v2 doc 04) | Record the miss, then re-measure 30 days after the 0.8 release (V3-D1) |
| ~2027-01 | SDK v1 fix window closes (≥ 6 months after 2026-07-27) | 1.0 contract fixes done; 2.0 platform migration underway |
| 2027-02-23 | Marketing v25 sunset: explicit `advantage_audience` required on all versions | Audit `ads-copy.ts` / `ads-targeting.ts` keep the flag (lane L2.ads) |
| 2027-03-30 | MCP spec revision (SDK betas ~mid-Feb) | Re-check for a result-shape or transport SEP |
| 2027-04-30 | Node 22 EOL | 2.0 (Node ≥ 24) must be out |
| ≈ 2027-06 | Marketing v26 sunset projected Aug–Sep 2027 | Ads pin bump in a 2.x minor |
| ~2027-09-28 | First spec revision eligible to remove the 2026-07-28 deprecations | 3.0 planning trigger |
| 2028-04-30 | Node 24 EOL | 3.0 (Node ≥ 26) must be out |

## Status

Analysis only; no code changed. Research inputs: `codebase-state-audit.md`,
`architecture-options.md`, `mcp-platform-horizon.md`, `meta-platform-horizon.md` and
`market-adoption.md` in `docs/ai/research/v3/`. Facts carry their check date (2026-10-28).
Projections are marked **[PROJECTED]**, and unconfirmed claims are marked **[UNVERIFIED]**.
