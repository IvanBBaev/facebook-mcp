# 02 — Market and Positioning

Based on a live survey of GitHub/npm and the MCP ecosystem (2026-07-21); details in
the research corpus. Star counts and activity are point-in-time.

## Landscape

Two clusters exist:

**Ads/Marketing servers (crowded):**
- `pipeboard-co/meta-ads-mcp` — market leader (~1.1k stars), Python, hosted-remote
  model, BUSL-1.1 (not OSI open source). 42 tools, ads-centric.
- **Meta's official hosted Ads MCP** at `mcp.facebook.com/ads` (open beta since
  ~2026-04): ~29 tools, Meta Business OAuth, no developer app needed. Ads only.
- Several MIT TypeScript ads servers (`mikusnuz` 135 tools, `byadsco` 97 tools with
  real rate-limit compliance and encrypted tokens, `hashcott` 54 tools).

**Pages/organic servers (sparse):**
- `HagaiHen/facebook-mcp-server` — the only notable one: Python, 27 tools, MIT.
  Plain env-var token, single page, no tests, no package distribution, semi-idle.
- npm name `facebook-mcp-server` is squatted (v1.6.6, no public repo).
- `oliverames/meta-mcp-server` attempted everything (200+ tools) and was archived
  within a month — a cautionary tale about mega-scope under a single maintainer.

## Gaps no existing project fills

1. **Security** — the #1 complaint cluster: token leaks in logs/errors/OAuth
   callbacks, SSRF via media-fetch tools, no encrypted storage, no redaction.
2. **No maintained TypeScript Pages server** — none with npm distribution,
   multi-page support, video/Reels upload, or scheduled-post management.
3. **Modern MCP features unused** — no `readOnlyHint`/`destructiveHint`
   annotations, no `outputSchema`/`structuredContent`, no response-size management.
4. **Rate-limit compliance is rare** (only byadsco parses
   `X-Business-Use-Case-Usage`).
5. **API-truth problems** — thin wrappers that hide Graph API semantics
   (`status` vs `effective_status`, silent metric deprecations) frustrate users.

## Positioning

**The defensible niche is a well-engineered TypeScript Pages/organic server.**
The ads side is commodity: Meta's own official hosted Ads MCP
(`mcp.facebook.com/ads`) covers it for free behind a Business OAuth click, no
developer app required. This project therefore does **not** try to out-compete
Meta on ads. The user wants full scope, so ads ship as a clearly separated,
optional tool package that is **off by default** and can be ignored in favor of
Meta's official server; the Pages/organic packages are the flagship and the whole
reason to install. The only durable ads advantage here is composability (ads +
Pages + moderation under one token and config, with plan-and-apply spend gating),
not surface breadth — so for ads-first or ads-heavy workflows the honest move is
to **signpost users to Meta's official Ads MCP**. Honest signposting is a trust
property, not a concession (the README carries an explicit "when to use Meta's
official ads MCP instead" note — see 06 and R02).

Differentiators, split by the job they do — they are **not** equally visible at
install time, so ranking them by engineering merit would misjudge what actually
drives adoption:

**Why you install** (acquisition — legible in a directory/README; the things the
only Pages competitor demonstrably lacks):

1. Full Pages surface: multi-photo, video (resumable), Reels, scheduling, drafts,
   scheduled-post lifecycle.
2. Frictionless distribution: one-line `npx` / MCPB install + official-registry
   listing.
3. Multi-page support: several Pages under one config, selected per call.

**Why you stay / trust** (retention — invisible at install time; converted to
adoption only by making them legible via trust artifacts: SECURITY.md guarantees,
a README comparison table vs HagaiHen / pipeboard / official-Meta, honest ads
signposting):

4. Token security done right (value-based redaction, `appsecret_proof`, 0600 env
   files on POSIX, debug validation at startup) — the market's #1 documented
   complaint cluster (token leaks), so it matters, but only once made legible.
5. API truth: surfaces Graph semantics thin wrappers hide (`effective_status`,
   silent metric deprecations) instead of papering over them.
6. Insights that work in 2026 (post-deprecation metric names, graceful errors).
7. MCP-native quality: annotations, structured output, `.strict()` schemas,
   token-budget-aware responses.
8. Proactive rate-limit handling (both usage headers, backoff, clear errors) —
   mostly relevant to the ads tier; solo Page admins rarely hit the BUC ceiling.

## Ecosystem/timing decisions

- **MCP SDK:** start on **v1 stable (`@modelcontextprotocol/sdk` ^1.29)** with
  `registerTool` + zod v3 — the exact stack servicenow-mcp runs. SDK v2 is in beta
  (2.0.0-beta.5) with API churn; migrate later via the official codemod once v2 GA
  stabilizes. Design forward-compatibly: **do not build on Roots, Sampling, or
  Logging capabilities** — the 2026-07-28 spec (finalizing in days) deprecates
  them — and keep the server stateless-friendly.
- **Spec target:** 2025-11-25 features that matter: tool annotations,
  outputSchema/structuredContent. Aggressive annotation is a stated differentiator.
- **Naming (decision recorded here — day-0 gate U2 / roadmap G2):** npm
  `facebook-mcp-server` is squatted, so a new name is needed. This is the one
  first-come-first-served asset in a niche with demonstrated squatting, so the
  decision is made at **Phase 0 exit**, not deferred to packaging time. Procedure:
  1. **Candidate npm name:** unscoped `facebook-mcp-ai` — matches the author's
     existing `servicenow-mcp-ai` brand (mutual provenance) and gives a short
     `npx -y facebook-mcp-ai` form. A "pages"-bearing alternative (e.g.
     `facebook-pages-mcp`) is also on the table: it signals the niche and further
     separates from the squatter. Both constraints stay live until the checks
     below resolve them.
  2. **Fallback (guaranteed available):** scoped `@ivanbbaev/facebook-mcp`, used
     only if the chosen unscoped name is taken — do not invent a third unscoped
     name.
  3. **Day-0 availability check:** verify both candidates are actually free on npm
     **today** (the corpus has only verified the `facebook-mcp-server` squat, not
     the candidates), and reserve the GitHub repo + registry identity to match.
  4. **Meta brand-terms check:** a short review of Meta's current brand /
     platform-terms language before committing — historically "Facebook" as the
     *leading* element of a third-party name is disallowed ("… for Facebook" is
     the tolerated pattern), and this project's distribution depends on public
     directories and the official registry, exactly where a trademark sweep would
     look. Carry a nominative-use `trademark` disclaimer in package.json and
     "unofficial / community" wording in the README. Flag, not legal advice.
  - **Outcome (2026-08-27, at the 0.7.0 publish):** the fallback was taken, with
    one correction — the scope is `@ivanbaev`, the npm account, which has ONE `b`
    unlike the GitHub user `IvanBBaev`. The shipped name is
    **`@ivanbaev/facebook-mcp`**; the `@ivanbbaev/…` spelling above is the
    original proposal, kept as written. Publishing under an unowned scope returns
    a 404 on PUT that looks exactly like a permissions failure, which cost a
    release cycle to diagnose — see docs/runbooks/release.md.
  - Registry identity is decoupled from the npm name:
    `mcpName: "io.github.IvanBBaev/<name>"` for the official registry via
    `mcp-publisher`. The registry verifies ownership against the published
    tarball's `mcpName`, so it must ship in the **first** npm publish.
  - **No npm publish before `1.0.0`** (doc 10 §1): pre-1.0 milestones exist only
    as git tags. The name is *reserved* at Phase 0 exit; a placeholder publish is
    made **only if npm policy requires one to hold the name** (decided under G2) —
    never a half-surface release under the flagship name.
- **Distribution:** npm (`npx -y` pattern) + `.mcpb` bundle for Claude Desktop
  (manifest `user_config` stores secrets in the OS keychain) + registry listing +
  README metadata for auto-indexing directories.
