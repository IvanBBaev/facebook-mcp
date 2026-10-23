# 04 — Owner decisions

Each decision lists options and a recommendation. Nothing in v2 is implemented before D1 and
D4 are taken; D5 and D6 must be taken before the 1.0 tag.

## D1. What happens at the 2026-11-25 adoption checkpoint?

Bar (`SUPPORT.md`): ≥100 weekly downloads, ≥25 stars, ≥3 non-author issues. Now: 80 (best
week since launch; typical 40–60), 2, 0. Forecast: missed on all three; stars and issues by a
wide margin. A release plus announcement can spike one week over 100 (launch week: 191), but
that is not sustained use.

| Option | Meaning for v2 |
|---|---|
| **A. Personal tool** | Downgrade per `SUPPORT.md` (minimum maintained core: core, reader, posts, insights). v2 = lean (platform + removals + insights contract). No create-chain, no Instagram here. |
| **B. Last adoption push** | Ship 0.8/1.0 now, PulseMCP submission, launch post (per the `launch-marketing` skill), then a v2 with one headline feature (report tool or boost-post). Re-check 30 days later. |
| C. Move the checkpoint | Shift it to after 1.0 ships, on the grounds that 0.7.0 never had a live-verified release to promote. |

**Recommendation: C, then A or B.** The bar was set for a verified product; the project has not
shipped one yet. Move the checkpoint to 30 days after 1.0, do the cheap actions now (release,
PulseMCP, answer PR #41), and plan v2 lean so it is right under either outcome.

## D2. Instagram: in this server, in the sibling, or a shared core?

Evidence: IG is the strongest demand signal (nearly every new "Meta social" server bundles it);
the sibling `IvanBBaev/instagram-mcp` exists (public, 28 tools, 5 stars, not on npm as
`@ivanbaev/instagram-mcp`). The Facebook-Login IG variant uses the same host, token and
allowlist as this server.

| Option | Pros | Cons |
|---|---|---|
| A. `instagram` package here | One token, one install, cross-posting FB+IG in one plan | Breaks the Pages-only scope in [doc 01](../01-goals-and-scope.md); duplicates the sibling; doubles the Graph-churn treadmill here |
| **B. Keep the sibling; cross-promote** | No duplication; each server stays small | Users who want both run two servers and two configs |
| C. Extract a shared core (`core`/`api` layers) used by both | One HTTP/auth/gate implementation | A library API is a new contract (contradicts F12) and a monorepo cost |

**Recommendation: B for 2.0**, with a README section and a combined MCPB/config example. Revisit
C only if both servers gain real users.

## D3. Reverse A12 for a narrow boost-post create-chain?

A12 deferred all object creation. The research supports a narrow exception: Meta's official Ads
MCP cannot boost a Facebook Page post and has no media upload, and "boost the post I just
published" is the composability story no ads-only server has.

| Option | Meaning |
|---|---|
| A. Keep A12 | Ads stay read + status/budget; signpost Meta's Ads MCP for creation |
| **B. Narrow chain in 2.0** | [03 §3.2](03-v2-scope.md): paused-only, one plan, rollback, `NONE` category only, mandatory campaign `spend_cap` |
| C. Broad create surface | Objectives × placements × creatives — commodity, high cost |

**Recommendation: B, only if D1 is not "personal tool".** For personal use, A is enough. The
smoke test needs a real ad account with a spending limit set (doc 08 protocol).

## D4. Insights window convention (before the 1.0 freeze)

Today `days` is inclusive (`src/api/insights.ts:924`, `+1`). PR #41 moves to `[since, until)`
with Pacific-time boundaries (`META_INSIGHTS_TIMEZONE = 'America/Los_Angeles'`). The choice
changes the 90-day ceiling arithmetic and the echoed `days`.

**Recommendation: `[since, until)`**, as in PR #41 — it matches Graph's own semantics and fixes
the off-by-one. Confirm the boundary behaviour (CC-INS-5) in the live gate before tagging 1.0.

## D5. Tool renames before 1.0, or recorded exceptions?

See F6 in [01-fix-before-1.0.md](01-fix-before-1.0.md). Renaming after 1.0 means alias tools for
a whole major.

**Recommendation: rename the seven before 1.0** (`get_*_insights`, `get_ads_report_status`,
`send_private_reply`, `set_comment_visibility`); keep `whoami` / `usage` as recorded exceptions.
Keep the array-taking singular names (`hide_comment`, `block_user`) and document them — renaming
those buys little.

## D6. `outputSchema` on write previews in 1.0?

Write previews/applies are the most structured server-owned payload (`status`, `planId`, `tier`,
`expiresAt`, `nextStep`). Adding an `outputSchema` later is additive; removing one is breaking.

**Recommendation: yes, in 1.0** — but only for the envelope fields, not the per-tool `result`
(typed `unknown`), so Graph shape changes never break it.

## D7. PR #41 landing path

| Option | Meaning |
|---|---|
| **A. Merge the additive half now** | Rebase on `51a98ba`; add `kind`/`aggregation`/`value`; keep `total` deprecated; credit Lukasz |
| B. Merge as-is (breaking) | Fine pre-1.0, but `total` changing meaning silently is worse than adding new fields |
| C. Adopt into 2.0 later | Keeps the only external contributor waiting another quarter |

**Recommendation: A**, this week. Ask Lukasz what the curated report tool should contain.
