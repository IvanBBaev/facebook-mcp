# facebook-mcp v2.0.0 — Analysis Corpus

Analysis performed **2026-10-24** against `main` @ `2d8f468` (package 0.7.0). Version line:
0.7.0 (published) → **1.0** (live-verification gate) → **1.1** (ads on by default for the
`ads` profile) → **2.0** (this corpus). Raw research inputs (local-only) live in
`docs/ai/research/v2/`; this directory is the synthesized, reviewable output. It extends the
pre-implementation corpus in [`../`](../README.md) and does not replace it.

## Executive summary

v2.0.0 is the next **major** and therefore the release that takes every breaking change the
1.x line cannot. The research yields five findings:

1. **The most valuable v2 work happens before 1.0.** Under the semver policy
   ([doc 10 §1](../10-v1-release-definition.md)) breaking changes are free until 1.0 ships.
   The contract audit found twelve contract warts (profile/package name collision, two error
   envelopes, overloaded insights `total`, `nextCursor: null` vs omitted, verb-less tool names,
   no `exports` map, …). Each costs one CHANGELOG line now and a major version later.
   Fixing them first turns 2.0 into a *removal* release instead of a redesign →
   [01-fix-before-1.0.md](01-fix-before-1.0.md).
2. **The platform forces a major by about late January 2027.** MCP TypeScript SDK v2 went GA
   on 2026-07-27. It drops zod 3, removes `toJsonSchemaCompat`, and is the only line that
   speaks spec 2026-07-28 (stateless, no `initialize`, elicitation as a return value). The v1
   SDK gets fixes for at least six months after v2 GA. Claude Code negotiates 2026-07-28 by
   default on every connection type since 2026-10-14, so a v1-SDK server lives on the
   fallback path. Published tool schemas and the HTTP transport change → user-visible break.
3. **Adoption is below every checkpoint bar.** 80 npm downloads/week (best week since
   launch), 2 stars, 0 non-author issues against the 2026-11-25 bar of ≥100 / ≥25 / ≥3. The
   only external user (Lukasz Liniewicz, PRs #40 and #41) has waited weeks for a review.
   The v2 scope must be sized *after* the checkpoint decision, not before.
4. **The defensible position is "insights you can trust" plus spend-safe ads.** No competitor
   documents flow vs gauge metric semantics (a competitor ships retired metrics; ours summed a
   follower stock into 6166 instead of 882 until `51a98ba`). Meta's official Ads MCP cannot
   boost a Facebook Page post and has no media upload, which leaves a narrow but real ads
   differentiator: a paused-only, plan-gated boost of the post this server just published.
5. **Instagram is the strongest demand signal, and also an owner decision.** Almost every new
   "Meta social" server bundles Pages and Instagram. The sibling repo `IvanBBaev/instagram-mcp`
   already exists (public, 28 tools, 5 stars). In-server package vs sibling vs shared core is
   decision D2 in [04-owner-decisions.md](04-owner-decisions.md).

Recommended shape: **lean v2** = SDK v2 + zod 4 + spec 2026-07-28 (with a legacy fallback),
the PR #41 insights contract, and the removal of everything deprecated in 1.x. Feature
headlines (boost-post create-chain, Instagram) stay optional and depend on D1/D2.

## Document map

| Doc | Contents |
|---|---|
| [01-fix-before-1.0.md](01-fix-before-1.0.md) | Contract fixes that must land before 1.0, in priority order |
| [02-v1x-backlog.md](02-v1x-backlog.md) | Additive work that fits 1.x minors (organic, ads, hygiene) |
| [03-v2-scope.md](03-v2-scope.md) | v2.0.0 candidates: platform migration, removals, features; ranked table; never-list |
| [04-owner-decisions.md](04-owner-decisions.md) | Decisions the owner must take, each with options and a recommendation |
| [05-roadmap-and-risks.md](05-roadmap-and-risks.md) | Phasing and dates from now to 2.0.0; risks; open live probes |

## Urgent dates

| Date | What | Action |
|---|---|---|
| 2026-10-27 | Marketing API v26 rules apply to all versions (HEF `advantage_audience`, poll ads, placements removed); Graph root `GET /?ids=` removed | None: `src/` does not use `?ids=` (checked 2026-10-24); no ads code change expected |
| 2026-11-10 | Marketing API v24 sunset (doc 12 says 2026-10-06 — wrong) | Correct doc 12 |
| 2026-11-25 | Adoption checkpoint (`SUPPORT.md`) | Decision D1 |
| ~2027-01-27 | Earliest end of SDK v1 bug/security fixes | 2.0.0 on SDK v2 should ship before it |
| 2027-04-30 | Node 22 end of life | Node floor raise in 2.0 |

## Status

- **Phase:** research synthesized; nothing implemented. No GitHub issues filed yet.
- **Next step:** owner decisions D1–D7, then the fix-before-1.0 items enter the current
  [roadmap](../08-roadmap.md) ahead of the 1.0 live gate.
