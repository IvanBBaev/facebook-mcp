# Review v3 — Senior Product Manager (Developer Tools / AI-Agent Integrations)

| Field | Value |
|---|---|
| Role | Senior Product Manager, developer tools and AI-agent integrations. This is an independent, adversarial review. |
| Date | 2026-10-29 |
| Scope | Product position of `@ivanbaev/facebook-mcp` 0.8.0 and the v3 roadmap (`docs/analysis/v3/`), checked against what has shipped and against the market |
| Baseline | `main` @ `2c8d8bd` (wave 0 merged; C05 stable insights schema merged as expand-only) |
| Method | Read the strategy corpus, the README and the dispatch board. Re-checked every 2026-07 PM finding against the code and README. Used live, read-only npm, GitHub and web queries. Did not run the server against Meta. |

**Sources (all checked 2026-10-29 unless noted)**

- Corpus:
  - `docs/analysis/01-goals-and-scope.md` and `02-market-and-positioning.md`
  - `docs/analysis/10-v1-release-definition.md` (2026-07-22, amended 2026-08-25)
  - `docs/analysis/v3/README.md` and `01`–`05` (2026-10-28)
  - `docs/reviews/06-product-manager.md` (2026-07-21)
  - `README.md` (76,766 B), `SUPPORT.md`, `.github/FUNDING.yml`, `docs/runbooks/onboarding-trial.md`
  - `WORKLOG.md` (entries up to 2026-10-29)
- npm API, `point/last-week` and `range/last-month`:
  - `@ivanbaev/facebook-mcp`: 270 a week, 440 a month. Daily values 10-22…10-28: 14, 6, 6, 7, 5, 18, **214**.
  - `instagram-mcp-ai`: 115/wk
  - `facebook-pages-mcp`: 73/wk
  - `@luminarylane/facebook-mcp-server`: 118/wk
  - `facebook-mcp-server`: 8/wk
  - `meta-ads-mcp`: 839/wk
- GitHub (`gh`):
  - this repo: 2★, 2 forks, 49 views from 35 unique visitors in 14 days; the only referrer is `aocr.org` (1)
  - `HagaiHen/facebook-mcp-server`: 232★, last push 2026-04-23
  - `pipeboard-co/meta-ads-mcp`: 1,341★, last push 2026-10-20; license `NOASSERTION`, previously BUSL-1.1
- Meta:
  - `developers.facebook.com/documentation/mcp` and its `llms.txt`
  - the 2026-06-30 Developer Tools / Social Technologies MCP blog post
  - the 2026-09-15 WhatsApp Business Tools MCP announcement and press coverage
- Hosted connectors, from vendor pages found by web search. Their feature claims are **[UNVERIFIED 2026-10-29]**.

---

## 1. Verdict

**Off-track. It can be put back on track with changes that cost little engineering time.**

1. The product has **never touched its real environment**. That means 69 tools, 3,147 tests and a public npm release with zero live Graph calls. The primary user (the owner) has no `FB_*` config on this machine (WORKLOG 2026-10). The v3 plan schedules the first live contact (U30) **last**, after three waves of refactors.
2. v3 has **quietly redefined 1.0**. Before, 1.0 meant "live-verified + dogfood + onboarding" (doc 10, still binding and still in the README). Now it means "contract fixes". Users read "1.0" as "it works", not as "the error envelope is unified".
3. The roadmap ships **two majors in about 10 weeks**: 1.0 in Jan 2027, then 2.0 in Mar–Apr 2027. Deprecations added in 1.0 are removed in 2.0. The sequence follows the SDK and Node calendars, not user need. Collapse it into one breaking release.
4. Distribution (U-A2) is the stated bottleneck, yet it is the only wave-A task still open. Meanwhile wave 0 and C05 merged within a day. The V3-D1 gate counts npm downloads that are mostly not humans.
5. The competition is moving faster than the plan assumes:
   - Meta has shipped **three** official MCPs in five months: Ads (04-29), Social Technologies (06-30) and WhatsApp Business Tools (09-15).
   - Hosted connectors already serve the non-developer Page admin.

   The product therefore needs a sharp **developer-operator** position and a pre-written plan for when Meta ships an official Pages MCP.

**Counts:** Blocker 2 · Major 9 · Minor 5 · Nit 2.

---

## 2. Status of the 2026-07 findings

| # (06-PM) | Finding | Status 2026-10-29 | Evidence |
|---|---|---|---|
| 1 | No risk entry for an official Meta Pages MCP | **Held, partly addressed.** R7 exists (v3/04, medium-high). There is still no written survival list and no kill/consolidate trigger. | v3/04 R7 and watch list ("consider personal tool") |
| 2 | Differentiators ordered by engineering merit | **Partly addressed.** The README says "the reason to install this is the Pages side" and SECURITY.md exists. The first screen still leads with badges and a disclaimer, not with a job. | README:1–40, 603–625 |
| 3 | Onboarding not viable | **Built, not proven.** `setup-token` shipped (R05), and the Explorer path is the default quickstart. The trial protocol exists, but **no trial has ever run**. "Budget about 20 minutes" is an untested claim. | README:82–126; `onboarding-trial.md`; WORKLOG "non-author onboarding" open |
| 4 | No adoption or retention criteria | **Added, then missed, then deferred.** The D1 bar (2026-11-25) will miss on every metric, and V3-D1 moves the gate. Two gates in a row without a decision is a pattern (PM-04). | v3/01 §6, v3/03 V3-D1 |
| 5 | Stories absent; draft lifecycle incomplete | **Done in code, wrong in docs.** `create_story`, `list_stories` and the scheduled-post lifecycle shipped, but README "Not in scope" still says Stories are out. | README:546 vs README "Not in scope" |
| 6 | Ads: ship read + control, defer the create chain | **Regressed.** Ads now has 15 tools, including `boost_post` (a create chain), `duplicate_ad_object`, `upload_ad_image` and targeting edit. Doc 01 still says the create chain and image upload are "deferred beyond v1 (A12)". | README:520; doc 01 §Use cases 4 |
| 7 | Maintenance treadmill | **Partly addressed.** SUPPORT.md names the minimum maintained core (`core` + `reader` + `posts` + `insights`), and doc 12 has a changelog ritual. There is no budget in hours and no sunset story. The plan now adds two more majors and a sibling server. | SUPPORT.md:47; v3/04 |
| 8 | Media spike early | **Not done.** No live upload of any kind has ever run. | WORKLOG |
| 9 | Dogfood gate before distribution | **Not done.** The server was distributed (0.7, 0.8) without dogfood. | WORKLOG "dogfood" open |
| 10 | Naming / trademark | **Decided.** The name stays `@ivanbaev/facebook-mcp`, with a nominative-use Trademark section. Accepted. | README:803 |
| 11 | License unstated | **Closed.** MIT. | LICENSE |
| 12 | Messenger expectations | **Partly addressed.** The 24-hour window is documented. The package has since grown to 13 tools (labels, saved replies, attachments, reactions) on a polling-only model. | README:519 |
| 13 | Bulk moderation | **Closed.** Hide and delete accept up to 50 ids, and `triage_comments` and `reply_and_hide_comment` were added. | README:558–565 |
| 14 | Squatted-name disambiguation | **Partly addressed.** There is a general "not affiliated with Meta" line, but nothing names `facebook-mcp-server` or `facebook-pages-mcp`. | README:805 |
| 15 | `get_reactions` marginal | **Not adopted.** The tool still exists. | README tool table |
| 16 | "Best time to post" FAQ | **Not done.** | grep: no hit |

**Net:** 3 closed, 7 partly addressed, 1 decided, 4 open or not adopted, 1 regressed. The findings that were *engineering* got done (setup-token, bulk moderation, Stories). The findings that needed the *owner's time in the real world* did not: live run, dogfood, onboarding trial, listings. That asymmetry is the main subject of this review.

---

## 3. Users, JTBD and positioning

**Who the user is today (evidence-based, not aspirational)**

| Segment | Exists? | Fit |
|---|---|---|
| **The owner** (primary in doc 01) | Yes, but not using it. No live config on the dev machine and no dogfood. | Unproven |
| **Developer-operator.** A developer or technical marketer who runs 1–N Pages, already lives in Claude Code, Cursor or VS Code, can create a Meta Business app, and will not hand a Page token to a SaaS. | Plausible. The 115/wk sibling and 73–118/wk Pages servers suggest a small but real pool. | **Best fit.** Every differentiator (local, plan/apply, MIT, own token) matters to this person. |
| "Self-serve Page admin" (secondary in doc 01) | Exists, and is served better by hosted connectors: OAuth click, multi-network, no developer app. | **Poor fit.** Meta-app onboarding is a hard wall for non-developers. |
| Agencies with many client Pages | Exists | Out of scope by design: App Review, tenancy. Correct. |

**JTBD (one sentence):** *"When I manage my own Facebook Page(s) from my coding agent, I want to publish, moderate and report safely and repeatably, on my machine and under my own token, so that I never have to open Business Suite for routine work and never trust a third party with my Page."*

**Positioning statement (proposed):** *The local, MIT-licensed Facebook Pages MCP for developers. Your agent previews every post before it goes live, your token never leaves your machine, and your reports survive Meta's metric churn.*

Three claims a user can check; nothing about layers, redaction or annotations above the fold.

---

## 4. Competitive landscape 2026-10

| Player | Type | Surface | Auth / setup | Signal (2026-10-29) | Threat to us |
|---|---|---|---|---|---|
| **Meta Ads MCP** | Official, hosted, beta (launched 2026-04-29) | Ads: analysis, create/edit ads, campaigns, catalogs | OAuth, Read/Manage scopes | Vendor-maintained; free | Ads package: **high**. The README already says "use Meta's". Correct. |
| **Meta Social Technologies MCP** (formerly Developer Tools MCP) | Official, hosted (2026-06-30) | App status, webhooks, docs, API troubleshooting | OAuth with app credentials | — | Low directly. It **does** solve "why does my Graph call fail", which competes with `doctor`. |
| **WhatsApp Business Tools MCP** | Official, hosted (2026-09-15, gradual rollout) | WABA setup, templates, webhooks, **sending messages** | OAuth | Wide press coverage | Indirect. It proves Meta will ship messaging-capable MCPs. The overview says the servers cover "Facebook, Instagram, WhatsApp and Ads". |
| **Official Pages / Business Messaging MCP** | Not listed yet | — | — | Cadence of ~1 server every 2–2.5 months **[PROJECTED]** | **High** for the "secondary" segment; medium for developer-operators |
| `pipeboard-co/meta-ads-mcp` | OSS, hosted option | Ads | Hosted OAuth | 1,341★, active; `meta-ads-mcp` npm 839/wk | Ads only |
| `HagaiHen/facebook-mcp-server` | OSS, Python | Pages, single Page | Paste a token | 232★, **idle since 2026-04-23** | Low. The star gap (232 vs 2) is a distribution gap, not a product gap. |
| `facebook-pages-mcp` (npm) | OSS | Pages: organic analytics, posts, insights, Graph v25 **[UNVERIFIED]** | — | 73/wk | Direct; similar downloads |
| `@luminarylane/facebook-mcp-server` | OSS | Facebook **[UNVERIFIED]** | — | 118/wk | Direct |
| Blotato, PostPlanify, Poster.ly, upload-post, Flozic | Hosted SaaS connectors | Multi-network publish, schedule, comment replies **[UNVERIFIED]** | OAuth click, paid tiers | Marketing-heavy, Claude custom connectors | **High** for non-developers; low for developer-operators |
| Composio (Facebook toolkit) | Hosted aggregator | Generic Facebook actions | OAuth via Composio | One `claude mcp add` line | Medium: wins on "one command" |
| **This project** | OSS, local, TS | 69 tools, Pages + ads + messaging | Meta app + `setup-token` | 270/wk in release week (≈ 45 floor); 35 unique repo visitors in 14 days | — |

**Reading:** the "no maintained TS Pages server" claim (02, README "How this compares", dated 2026-07-21) is **stale**. There are at least two more npm Pages servers with similar downloads, and a hosted segment the table does not mention. Our real moat is narrower and different: **local media from disk**, **deterministic plan/apply previews with a `plan_id`**, **an operator-owned token**, **a stable insights schema (C05)**, **MIT**. Nothing in the moat is "69 tools".

---

## 5. Findings

### PM-01 — Blocker — Zero live verification and zero dogfood, and the plan runs the first live contact last

- **Evidence:**
  - README:20–29: "Nothing has been verified against the live Graph API yet". Every client in the compatibility table is "❌ Not yet".
  - WORKLOG (2026-10): "No `FB_*` env or local config on this machine, so no live smoke possible"; "dogfood, non-author onboarding" are open.
  - v3/05 wave 3: U30 (live gate L1–L8, boost P1–P7) depends on I31, which is after waves 0–2.
  - C05 (stable insights schema) was designed and merged from fixtures alone.
- **Impact:**
  - The whole 1.0 contract (envelope, renames, insights schema) is designed against fixtures. If the live run shows, for example, that Reels upload or insights behave differently, contract work gets redone after the renames have shipped.
  - Every public install today is a beta test run by strangers who will not report back (0 non-author issues).
  - The primary user has not adopted the product. That is the strongest negative product signal available, and it costs nothing to fix.
- **Recommendation:**
  1. Run a **live smoke of the 0.8.0 default profile now**, limited to `core`, `reader`, `posts` (text, photo, scheduled, delete) and `insights`. The smoke harness already exists, so this is a half-day for the owner.
  2. Then **dogfood for 2 weeks**: run the owner's real Page weekly through Claude Code.
  3. File every surprise as an issue. They are also the first public issues.
  4. Gate the dispatch of wave 2 on this run.
- **Roadmap placement:** release 0.8.x · wave A (insert before wave 2) · owner task **NEW U-A3** "live smoke on 0.8.0, default profile" (splits off from U30, which stays as the full L1–L8 run at 1.0) plus **NEW U-A4** "2-week dogfood log" · size **M**.

### PM-02 — Blocker — 1.0 was redefined without a decision record, and the public README still promises the old 1.0

- **Evidence:**
  - Doc 10 §1 (binding, amended 2026-08-25): "`1.0.0` is the live-verification gate, `1.1.0` turns the ads package on". Phase 4 exit = "distribution + dogfood + onboarding gate".
  - README Roadmap: "v1.0.0 ships without the ads package … milestones close when a surface has been verified live".
  - v3/04 phase B: 1.0 = "All 1.0 contract items merged", with the live gate as one line. Dogfood, onboarding and listings are absent.
  - No V3-D decision records the change.
- **Impact:**
  - For users, "1.0" is a trust signal ("it works with my Page"). For the v3 plan it is an API-stability signal. Shipping a 1.0 that is contract-clean but walked by no stranger on any client spends the one trust event the project gets.
  - It also creates a public contradiction: README vs v3 vs doc 10.
- **Recommendation:** define 1.0 as **"Verified Pages core"**:
  1. The default profile (minus experimental tools, see PM-07) is live-verified (U30).
  2. Two non-author onboarding trials pass in ≤ 20 min (Claude Code and Claude Desktop).
  3. The server is listed in ≥ 4 directories and the Claude plugin is installable.
  4. The breaking contract fixes are in.

  Record this as a new owner decision. Update the README Roadmap and doc 10 in the same commit.
- **Roadmap placement:** release 1.0 · wave 3 · owner decision **NEW V3-D12** · extends **U30**, plus **NEW U31** "onboarding trial ×2 clients" before I32 · size **S** (decision and docs) + **M** (trials).

### PM-03 — Major — Two majors in about 10 weeks (1.0 Jan → 2.0 Mar–Apr) is engineering-driven and hostile to users

- **Evidence:**
  - v3/04: 1.0 lands in Jan 2027 and 2.0 in Mar–Apr 2027.
  - v3/02 §3: renames, `note`, CSV `fields` and env names are deprecated in 1.0 and removed in 2.0.
  - The driver is the SDK v1 fix window (~2027-01) and Node 22 EOL (2027-04-30), not user value.
- **Impact:**
  - Any 1.0 adopter migrates twice in one quarter.
  - Alias machinery (C06) is built only to live for about 10 weeks.
  - Lane work is done twice: deprecate in L2, then remove in L4.
  - For a project whose gate metric is "non-author users", making early adopters migrate twice is a hit to the one thing you are trying to grow.
- **Recommendation:** make **one breaking line**. 0.9 (Dec–Jan) carries the contract fixes. It is pre-1.0, so breaking is free and aliases are optional for one minor. **1.0 (Mar–Apr 2027, before 2027-04-30)** = 0.9 contracts + P01–P05 platform (SDK v2, zod 4, Node ≥ 24, dual-era) + the PM-02 gates. 2.x is additive, and the removal release becomes trigger-based (PM-11).
- **Trade-off:** 0.9 runs on the SDK v1 line for about 8 weeks past its fix window. That is acceptable for a pre-1.0, local-only server; an SDK security advisory pulls P01 forward.
- **Roadmap placement:** releases 0.9 / 1.0 · waves 1–4 re-cut (waves 1–2 → 0.9; waves 3 and 4 merge into the 1.0 gate) · owner decision **NEW V3-D13** · size **S** (plan). Net engineering effort goes *down*: the L4 lane removals and most of C06 disappear.

### PM-04 — Major — The V3-D1 adoption gate measures the wrong things, on the wrong clock, and its "right under both outcomes" claim is false

- **Evidence:**
  - npm daily values 10-22…10-28 were 14, 6, 6, 7, 5, 18, **214**. The release-day spike, and the 26/44 burst on 10-17/18, are consistent with mirrors, scanners and our own CI or cold-start checks.
  - The repo had 35 unique visitors in the same window, so at most a fraction of 270 downloads are people. The real floor is ≈ 5–15/day.
  - The gate is "measured across facebook-mcp and instagram-mcp". That combines two products, and the sibling is not even under `@ivanbaev` (`instagram-mcp-ai`).
  - The clock starts "30 days after 0.8", but U-A2 (listings, plugin, announcement) has not happened. That is the same flaw that sank D1.
  - V3-D1 says "Waves 0–3 are right under both outcomes". Under option A (personal tool: consolidate to 4 packages), the alias, deprecation and outputSchema work across 8 lanes and 69 tools is pure overhead. A personal tool needs no public contract.
- **Impact:**
  - npm volume will "pass" or "fail" on noise.
  - The gate will be re-deferred a third time.
  - The ambitious variant stays permanently "pending".
- **Recommendation:** make the new gate:
  1. **Clock** = 30 days from the day the last of the 4 listings and the plugin submission go live (U-A2 done), not from the release.
  2. **Metrics per server, not combined:**
     - ≥ 3 non-author issues, PRs or discussions;
     - ≥ 2 independent "works with client X" confirmations;
     - ≥ 150 unique repo visitors per 14 days, with ≥ 3 non-GitHub referrers;
     - median npm downloads on **non-release** days ≥ 15/day (informative);
     - stars informative only.
  3. **Pre-commit the fail action now:** freeze ads and messages as experimental (PM-07), keep only the minimum maintained core in the 1.0 contract, and cancel the ambitious 3.0.
  4. Do not dispatch L2.ads or L2.messages before the gate reads out.
- **Roadmap placement:** release 0.8.x → 0.9 · wave between 1 and 2 · amends **V3-D1** · owner · size **S**.

### PM-05 — Major — Distribution is "the bottleneck", but it is the only task that never gets done

- **Evidence:**
  - v3 README point 4: "distribution is the bottleneck".
  - v3/05 §11: U-A1, I-A1 and I-A2 merged on 10-28, wave 0 merged on 10-29, and C05 merged. **U-A2 is open.**
  - Missing listings: PulseMCP, Smithery, mcp.so and the GitHub MCP registry.
  - The repo has its own plugin marketplace (`.claude-plugin/`), but the README marks Claude Code as "❌ Not yet" verified.
  - The only referrer in 14 days is 1 visit from `aocr.org`.
- **Impact:** every week of engineering without U-A2 is effort the gate cannot see. The 214-download release spike decays to the floor within a week, unseen.
- **Recommendation:**
  - Make U-A2 a **hard dependency** of wave 2 (dispatch checklist v3/05 §9). Treat it as 4 small tasks with a date each:
    1. 4 directory submissions (1 hour);
    2. walk the plugin install end-to-end in Claude Code, flip the compatibility row, then submit;
    3. one announcement per `launch-marketing`, aimed at the developer-operator segment (r/ClaudeAI, the MCP Discord, dev.to);
    4. a short demo GIF of plan → apply of a scheduled post.
  - Put the GIF in the README hero.
- **Roadmap placement:** release 0.8.x · wave A · extends **U-A2** (split it into U-A2a…d) · owner · size **S** each.

### PM-06 — Major — The README fails the 60-second test and contradicts the shipped product

- **Evidence:**
  - The first screen (README:1–30) is a 5×2 badge table, a doc-site link, a two-sentence abstract and a 12-line warning. There are no example prompts, no "what you can say to your agent" section, and no demo.
  - The Features table omits Stories, albums and photos, boost, duplicate, Page profile, labels, saved replies and triage.
  - "Not in scope" says "**Page Stories** … stay out" and lists "album/photo-library reads, Page profile editing" as out of scope. Yet `facebook_create_story`, `facebook_list_stories`, `facebook_list_albums`, `facebook_list_photos` and `facebook_update_page_profile` all ship (README:539–599).
  - The Roadmap section lists the doc-10 milestones (PM-02).
  - "How this compares" is dated 2026-07-21 and omits the newer official MCPs and the hosted competitors (§4).
  - The README is 76 KB.
- **Impact:**
  - A visitor cannot answer "what does this do for me" in 60 seconds.
  - A careful reader finds the README contradicting itself and stops trusting the rest. Trust is the entire differentiator.
  - Agents that read the README (via the plugin, or Context7-style indexing) will tell users that Stories are unsupported.
- **Recommendation:**
  1. Rewrite the top 40 lines: the positioning sentence from §3; 3 example conversations ("schedule this photo for Friday 9:00 — show me the preview first", "triage unanswered comments on last week's posts", "weekly report"); a 3-command quickstart; a "verified / unverified" status line.
  2. Fix "Not in scope", Features and Roadmap against the generated tool table, and add a metadata check that fails when a shipped tool name appears in "Not in scope".
  3. Re-date and extend "How this compares".
  4. Move permissions, env and package-namespace detail to the docs site. Target ≤ 25 KB.
- **Roadmap placement:** release 0.8.x (docs-only patch) · wave A · **NEW I-A3** "README rewrite + scope-drift check". The README is integration-owned because it contains generated tables · size **M**.

### PM-07 — Major — 69 tools is scope creep, it costs the agent ~126 KB per session, and the plan only diets in 2.x

- **Evidence:**
  - Doc 01 lists the requested scope as "absolutely everything".
  - Ads grew to 15 tools (8 read, 7 write). That includes `upload_ad_image` and the boost create chain, which doc 01 still lists as deferred beyond v1 (A12). The 2026-07 review recommended read + control only (§2 #6).
  - v3/02 §5 then redrew the never-list around what had already shipped ("beyond boost, duplicate and narrow edits").
  - Messages is 13 tools on a polling-only, 24-hour-window model.
  - v3/01 §3: the default profile is 53 tools at **126,006 B** of `tools/list`; `all` is 171 KB; each insights tool is ~6 KB.
  - The schema diet (A02 and L5) is wave 5, i.e. 2.x.
- **Impact:**
  - Every L2 lane task (two of them L-size: ads and posts) puts the 1.0 contract machinery on surface that has no demonstrated user.
  - Clients without tool search pay roughly 30k+ tokens before the first user message, which hurts tool selection quality — the very "MCP-native quality" claim.
  - Each new tool raises the maintenance treadmill (Graph pin bumps, Marketing sunsets).
- **Recommendation:**
  1. **Feature freeze stays.** Also add a "no new tool without a non-author request" rule through 1.0.
  2. Introduce an **experimental tier**: ads write tools beyond status/budget, `boost_post`, `duplicate_ad_object`, the `update_ad_set_targeting` and `upload_ad_image` write paths, labels, `react_to_message`, `upload_message_attachment` and `update_page_profile`. They ship, but they sit **outside the 1.0 semver contract**, so their L2 adoption can wait.
  3. Pull **A02** (schema-size budget test) and the default-profile part of **L5** into 0.9, with a target of default `tools/list` ≤ 70 KB.
  4. Consider folding `page_insights`, `post_insights`, `reel_insights` and `get_posts_insights` behind the C05 schema into fewer tools. That also removes rename churn (V3-D5).
- **Roadmap placement:**
  - releases 0.9 (A02 and the diet) and 1.0 (tier definition);
  - waves 1–2;
  - **NEW V3-D14** (experimental tier) as an owner decision;
  - A02 moved from wave 5 to wave 1, and L5.* for the default lanes merged into the L2.* checklists.
  - Size **M** in total, but it **saves** the L2.ads (L) and L2.messages (M) contract work.

### PM-08 — Major — The plan for an official Meta Pages MCP is a monthly check with no pre-written response

- **Evidence:**
  - v3/04 watch list: when Meta ships, "Re-run V3-D1 positioning; consider personal tool".
  - Meta's cadence: Ads (2026-04-29), Social Technologies (2026-06-30), WhatsApp Business Tools (2026-09-15). Meta's MCP overview says its servers cover "Facebook, Instagram, WhatsApp and Ads".
  - WhatsApp Tools already *sends messages*, the pattern a "Business Messaging" or Pages MCP would follow.
- **Impact:**
  - When it lands, hosted OAuth with zero setup takes the self-serve admin overnight.
  - Without a written response, the project will react on the fly and probably keep investing in the overlapping surface.
- **Recommendation:** write the response now, half a page, in v3/04:
  - **(a) What survives:**
    - local media from disk and resumable uploads;
    - `plan_id`-bound previews and a local write journal (audit);
    - the token never leaves the machine (no hosted party);
    - multi-Page under one config;
    - the stable insights schema;
    - scriptability (stdio/CLI);
    - works where Meta's gradual rollout has not reached.
  - **(b) Trigger and action:** official Pages MCP GA →
    1. within 2 weeks, publish a "use Meta's when… / use this when…" README section;
    2. drop any tool that is strictly worse than the official one;
    3. re-scope to the developer-operator "safety layer";
    4. if the gate (PM-04) has failed, switch to personal-tool mode.
  - **(c)** Lead positioning with the surviving list today, not after.
- **Roadmap placement:** release 0.8.x (docs) · wave A · extends the **R7** watch-list item · **NEW U-A5** (owner writes the response) · size **S**.

### PM-09 — Major — The "secondary user" is the wrong segment; the product should say "for developers"

- **Evidence:**
  - Doc 01 secondary user: "other Page admins with the same self-serve setup".
  - Onboarding needs a Meta developer registration, a Business-type app, Graph Explorer, and an App ID and secret on the command line (README:82–126).
  - Hosted connectors serve Page admins with one OAuth click (§4).
  - Our only adjacent signal, `instagram-mcp-ai` at 115/wk, is also developer-installed.
- **Impact:** marketing to "Page admins" pits the project against SaaS on their home turf (zero-setup, multi-network) and loses. The developer-operator segment, where local-first and plan/apply win, gets no targeted message.
- **Recommendation:**
  - Re-word doc 01, the README hero, the `package.json` description and the directory listings around the **developer-operator** JTBD (§3). Channel choice follows: Claude Code plugin, MCP directories, dev.to and r/ClaudeAI; not Facebook-marketer groups.
  - Keep the "Not for you if…" block, and point non-developers to hosted options honestly.
- **Roadmap placement:** release 0.8.x · wave A · goes with **I-A3** and **U-A2c** · size **S**.

### PM-10 — Major — There is no maintenance budget for three majors, a sibling server and the Meta treadmill, and FUNDING is not a plan

- **Evidence:**
  - v3/04 plans 1.0 (Jan), 2.0 (Apr), 2.x minors including an ads pin bump around 2027-06, and 3.0 (Q4 2027 – Q1 2028).
  - The sibling `instagram-mcp-ai` is at 0.8.0 on the same cadence.
  - WORKLOG records 247 Opus-hours to reach 1.0 (doc 08).
  - FUNDING.yml lists GitHub Sponsors, Ko-fi and Donatree, and a Sponsor badge sits in the README hero. At 2★ and ~0 users, expected revenue is ≈ 0.
  - SUPPORT.md names a minimum core, but there is no hours-per-month budget and no sunset or archive story (06-PM #7d).
- **Impact:**
  - The binding constraint is owner hours, especially *owner-only* hours: live runs, Meta UI, App Review, listings. The plan consumes them on majors that users did not ask for.
  - A donation-first hero on an unverified tool reads as premature.
- **Recommendation:**
  - State a budget, e.g. "≤ 8 owner hours/month for both servers". Rank the roadmap by owner-hour cost.
  - Write the sunset clause in SUPPORT.md.
  - Move the Sponsor badge out of the hero, keeping the Support section.
  - Treat sustainability honestly: this is a portfolio and personal-leverage project, and the success metric is "the owner uses it weekly and ≥ N developers do", not revenue. Do not add paid tiers or a hosted service (consistent with the never-list).
- **Roadmap placement:** release 0.8.x (docs) · wave A · **NEW U-A6** "maintenance budget + sunset clause" · size **S**.

### PM-11 — Major — Phase exit gates are all engineering; no phase has a user outcome

- **Evidence:**
  - v3/04 §1 exit gates are `npm run check`, metadata, contract items merged, SDK v2, Node floor and modern-only.
  - The only adoption measure (V3-D1) decides lean vs ambitious for phases D–E only.
- **Impact:** the roadmap can be "on track" while nobody uses the product. That is exactly what happened from 0.7 to 0.8.
- **Recommendation:** add one user-outcome exit metric per phase (see §6). Make wave 6 trigger-based: plan 3.0 only when a forcing event fires (SDK v3, a result-shape SEP, or Node 24 EOL approaching), not on a calendar.
- **Roadmap placement:** all releases · v3/04 §1 · amends **V3-D1** and **U60** · owner · size **S**.

### PM-12 — Minor — The best differentiator (stable insights schema) is invisible, and workflows trail tools

- **Evidence:**
  - C05 merged as expand-only (`docs/insights-schema.md`). The README sells "insights that tell you when a metric was renamed", not "reports that do not break".
  - Prompts and skills (weekly report, comment triage, publish-and-boost) are placed in 2.x (V3-D8, A03).
- **Impact:** users buy outcomes ("my weekly report keeps working after Meta's next metric wave"), not schemas. Hosted competitors sell workflows.
- **Recommendation:**
  - Pull the **weekly-report** and **comment-triage** prompts and plugin skills to 0.9 or 1.0. They are additive, need no SDK v2, and they are the demo.
  - Make "reports that survive Meta's metric changes" a headline claim once C05 is adopted by L2.insights.
- **Roadmap placement:** release 1.0 · wave 2 · **A03** split, with A03a (2 prompts + skills) moved to wave 2 · size **S**.

### PM-13 — Minor — The Claude plugin is the highest-leverage channel, but it is unverified

- **Evidence:**
  - `.claude-plugin/plugin.json` and `marketplace.json` exist, and the README instructs `/plugin marketplace add IvanBBaev/facebook-mcp`.
  - The compatibility table says Claude Code "❌ Not yet".
  - v3/02 item 18 calls the plugin "the only Anthropic directory path for a local server".
- **Impact:** the plugin is the channel most likely to reach developer-operators. A submission that fails on first install burns the channel.
- **Recommendation:** walk the plugin install end-to-end on a clean profile before submission, then flip the row.
- **Roadmap placement:** 0.8.x · wave A · **U-A2b** · size **S**.

### PM-14 — Minor — There is no contributor funnel

- **Evidence:** 0 non-author issues. PR #41 (the only external contributor) waited unreviewed until it was superseded. There are no "good first issue" labels, no Discussions and no issue template for "works with my client".
- **Impact:** the gate's main metric (non-author issues and PRs) has no on-ramp.
- **Recommendation:**
  - Add an issue template "Client report: works / doesn't work with X".
  - Label 3–5 good first issues (for example the PM-06 drift check, the "best time to post" FAQ, client confirmations).
  - Commit to a 7-day response SLA, as the watch list already implies.
- **Roadmap placement:** 0.8.x · wave A · **NEW I-A4** (`.github/` is integration-owned) · size **S**.

### PM-15 — Minor — Process overhead is out of proportion to a solo, pre-user product

- **Evidence:**
  - Three analysis corpora (v1, v2, v3) plus two review rounds.
  - A dispatch board with exclusive-ownership rules, fragments, change-request files and 8 lanes for ≤ 4 parallel sessions.
  - The README is 76 KB, and the CHANGELOG `[Unreleased]` section spanned ~3,000 lines before folding.
- **Impact:** planning and process artefacts make engineering feel like progress. Owner-only tasks (PM-01, 05) do not fit the board's machinery, so they starve.
- **Recommendation:**
  - Add an "owner lane" to the dispatch board with dated U-tasks, and require one U-task to close per wave before the next wave opens.
  - Freeze new analysis corpora until 1.0. This review should be the last one before 1.0.
- **Roadmap placement:** all · v3/05 §9 checklist · owner · size **S**.

### PM-16 — Minor — Disambiguation from look-alike packages is missing

- **Evidence:** npm already has `facebook-pages-mcp` (73/wk), `@luminarylane/facebook-mcp-server` (118/wk) and `facebook-mcp-server` (8/wk). The README names only HagaiHen.
- **Impact:** confused installs, and lost credit for our own downloads.
- **Recommendation:** add a one-line "not affiliated with …" note in "How this compares" and in the directory listings.
- **Roadmap placement:** 0.8.x · **I-A3** · size **S**.

### PM-17 — Nit — `facebook_get_reactions` is still a separate tool (carried over from 06-PM #15)

Fold it into `get_post` fields during the schema diet (PM-07), or record it as a deliberate exception. Placement: 0.9 · L2.reader · **S**.

### PM-18 — Nit — There is still no "best time to post" FAQ (carried over from 06-PM #16)

`page_fans_online` is gone, and users and agents will ask. Add two lines to Known limitations. Placement: 0.8.x · **I-A3** · **S**.

---

## 6. Recommended roadmap reshape

Principle: **verify → distribute → stabilise once → extend on evidence.** There is one breaking line before Node 22 EOL, and the removal major happens only when a trigger fires.

| Phase | Release | Target | Content | Exit metrics (product **and** engineering) |
|---|---|---|---|---|
| A′ | **0.8.x** | Nov 2026 | U-A3 live smoke (default profile); U-A4 2-week dogfood; U-A2a–d listings, plugin and announcement; I-A3 README rewrite; I-A4 contributor funnel; U-A5 Meta-response doc; U-A6 budget | Live smoke green on core/reader/posts/insights; owner used the server ≥ 2 weeks on the real Page; 4 listings live + plugin submitted; README hero has example conversations and no scope contradictions; 1 stranger onboarding trial run (pass or fail recorded) |
| Gate | — | 30 days after listings (~end Dec 2026) | V3-D1 re-measured per PM-04 | Pass → full 1.0 scope. Fail → experimental tier frozen; 1.0 contract = minimum maintained core |
| B′ | **0.9.0** | Dec 2026 – Jan 2027 | Waves 1–2 (C01–C06, L2.*) for **non-experimental** tools; A02 schema budget + default-profile diet; A03a prompts/skills; C05 adopted | Default `tools/list` ≤ 70 KB; one error envelope; ≥ 1 non-author issue answered within 7 days |
| C′ | **1.0.0** "Verified Pages core" | Mar – Apr 2027 (**before 2027-04-30**) | P01–P05 platform (SDK v2, zod 4, Node ≥ 24, dual-era), I30–I31, U30 full live gate, U31 onboarding ×2 clients, deprecations from 0.9 removed | L1–L8 live green; 2/2 onboarding trials ≤ 20 min; Claude Code + Desktop rows ✅; gate metrics trending (≥ 3 non-author issues/PRs cumulative) |
| D′ | **1.x** | Apr – Q4 2027 | Additive: durable uploads, ads pin bump (~2027-06), `advantage_audience` (**due 2027-02-23**: pull into 0.9 L2.ads or a 0.8.x patch), Page Integrity, experimental tools promoted only on user request | Each minor justified by an issue or the forcing calendar; owner hours within budget |
| E′ | **2.0.0** (formerly "3.0") | Trigger-based; no later than Q1 2028 (Node 24 EOL 2028-04-30) | Modern-only, drop `FB_CONFIRM_TOKEN`, Node ≥ 26, conditional SDK v3 | Planned only when a trigger fires; legacy-client share near zero, or the deadline is ≤ 6 months away |

Note on `advantage_audience` (2027-02-23): under the current plan it rides on L2.ads in wave 2, which PM-04 gates. It is a **date-forced bug fix**, so ship it as a 0.8.x or 0.9 patch regardless of the gate.

---

## 7. Owner decisions needed

| ID | Question | Options | Recommendation |
|---|---|---|---|
| **V3-D12 (new)** | What does 1.0 mean? | A. Contract fixes (current v3). B. Doc-10 meaning: live + dogfood + onboarding. **C. "Verified Pages core" = B + breaking contracts + listings** | **C.** Record it, and update README Roadmap and doc 10 in the same commit (PM-02). |
| **V3-D13 (new)** | One breaking line or two majors in ~10 weeks? | A. Keep 1.0 Jan + 2.0 Apr. **B. 0.9 contracts → 1.0 platform + contracts (Apr 2027)**. C. 1.0 Jan, and 2.0 keeps all aliases (Node/SDK only) | **B.** C is the fallback if an SDK v1 security fix forces an early 1.0 (PM-03). |
| **V3-D1 (amend)** | Gate metrics and clock | A. As written (combined servers, npm-weighted, release clock). **B. Per-server, issue/referrer/client-confirmation-weighted, clock from listings, fail action pre-committed** | **B** (PM-04). |
| **V3-D14 (new)** | Experimental tier outside the 1.0 contract | A. All 69 tools are 1.0 contract. **B. Ads writes beyond status/budget, boost, duplicate, targeting edit, image upload, labels, message reactions/attachments and Page profile are experimental**. C. Remove them | **B.** C only if the gate fails *and* a tool has zero use in the dogfood log (PM-07). |
| **V3-D15 (new)** | Order of work: owner tasks vs engineering waves | A. Engineering waves continue; U-tasks whenever. **B. Wave 2 is not dispatched until U-A2 and U-A3 are done** | **B** (PM-01, PM-05, PM-15). |
| **V3-D16 (new)** | Response to an official Meta Pages MCP | A. React when it happens. **B. Pre-written survival list, trigger and actions (PM-08)** | **B.** Write it in 0.8.x. |
| **V3-D17 (new)** | Target segment | A. "Page admins" (doc 01). **B. Developer-operators; non-developers pointed to hosted options** | **B** (PM-09). |
| **V3-D9 / U60 (amend)** | The removal major | A. Calendar 3.0 Q4 2027. **B. Trigger-based removal major (renumbered 2.0 under V3-D13 B)** | **B** (PM-11). |

**The adversarial bottom line for the owner:** the codebase is better engineered than almost anything in this market. The risk is not quality. It is that 69 well-tested tools reach 1.0, and then a Meta-hosted Pages MCP arrives, without one stranger, or the owner, having used them on a real Page. The cheapest, highest-value work left is about two days of owner time (live smoke, dogfood start, listings, plugin walk, README hero). Do it before another engineering wave is dispatched.
