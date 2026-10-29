# 08 — DevRel / OSS maintainer / technical writer review

- **Role:** Senior Developer Relations engineer, open-source maintainer and technical writer (adversarial, independent of the v3 plan authors).
- **Date:** 2026-10-29
- **Scope:** `main` at commit `2c8d8bd` (`feat(api): add the stable insights schema`), npm `@ivanbaev/facebook-mcp` 0.8.0, GitHub repo `IvanBBaev/facebook-mcp`, the GitHub Pages site under `docs/`, release `v0.8.0`, open/closed PRs and issues.
- **Method:**
  1. Walked the newcomer funnel cold: GitHub landing → README first screen → install for Claude Desktop, Claude Code, Cursor and VS Code → Meta app → token → `doctor` → first read → first safe write. Each step was timed as a reader, not executed against Meta.
  2. Ran a relative-link and anchor checker (a Node script kept in the session scratchpad, not committed). It covered 65 Markdown files and 303 relative links, excluding `node_modules`, `build`, `coverage`, `.git` and `docs/ai`.
  3. Cross-read README ↔ `docs/runbooks/onboarding.md` ↔ `.env.example` ↔ `src/core/settings.ts` ↔ the generated tables.
  4. Ran read-only `gh` queries: release body, PR #40/#41 timelines, Dependabot PRs, issues, labels, milestones, topics, community profile and traffic referrers.
  5. Mapped every finding to the v3 roadmap (`docs/analysis/v3/05-parallel-task-breakdown.md`).
- Claims marked **[UNVERIFIED]** depend on Meta's current UI or on third-party directories and were not checked live.

---

## 1. Verdict

**Workable-with-changes**, leaning toward *hostile-to-newcomers* on trust and on the final
two funnel steps.

1. **Engineering docs are excellent.** The env names are consistent everywhere, the generated tables are drift-proof, there are 0 broken relative links, and the troubleshooting runbook is a model of its kind.
2. **The public surfaces a newcomer actually sees are stale or contradictory.** The Pages site still says 0.7.0 / 37 tools. The README "Not in scope" list names tools that ship. The Roadmap says ads land in 1.1, which contradicts v3.
3. **The funnel stops before the "aha".** No Cursor or VS Code snippet. No example prompts. No guided first plan→apply write. No screenshot or GIF. A first-screen warning that nothing has been live-verified.
4. **Release and contribution communication is close to absent.** The v0.8.0 release body is 346 auto-generated characters. The 0.8.0 CHANGELOG section is ~3,050 lines. The one external feature PR waited 59 days with zero maintainer comments.
5. **Fixing this is roughly 4–6 docs-only tasks (S/M), with no code risk.** These tasks are the cheapest lever on the v3 adoption gate (V3-D1, SUPPORT.md checkpoint 2026-11-25).

**Counts:** 2 Blocker · 8 Major · 10 Minor · 4 Nit (24 findings).

---

## 2. Newcomer funnel

Times assume a competent Node developer who has never built a Meta app.

| # | Step | Time (est.) | Friction | Fix |
|---|---|---|---|---|
| 1 | GitHub landing | 0.5 min | No custom social preview, although `docs/assets/og-banner.png` exists. Topics lack `mcp-server`. The "status" badge links to `#` (`README.md:5`). | DX-17, DX-18, DX-22 |
| 2 | README first screen | 1–2 min | "Nothing has been verified against the live Graph API yet" dominates. There is no 3-line "what you can say to Claude" demo and no visual. A 76 KB README goes straight into a feature list. | DX-05, DX-06 |
| 3 | Pick a client and install | 2–10 min | Claude Code, Desktop JSON and `.mcpb` are covered. Cursor and VS Code get one table row each (`README.md:257-258`) and no JSON. VS Code uses `servers`, not `mcpServers`, which is the most common copy-paste failure. | DX-04 |
| 4 | Create the Meta app | 5–15 min | `onboarding.md:41` says "Pick the Business app type". Meta's current create flow is use-case first **[UNVERIFIED]**. No screenshots at the two steps that most often go wrong. | DX-14 |
| 5 | Get the token | 3–8 min | The scope table in `onboarding.md:62-75` is hand-written and has drifted from the generated table. Users under-scope and then hit a permission error later. | DX-07 |
| 6 | `setup-token` | 1–2 min | The runbook says arguments land in shell history (`onboarding.md:104-106`), then recommends an inline `FB_APP_SECRET='…' FB_SETUP_TOKEN='…'` prefix, which also lands in shell history (`onboarding.md:111-114`). | DX-08 |
| 7 | `doctor` | 0.5 min | Good. Clear output, and troubleshooting is mapped. | — |
| 8 | First read (`facebook_whoami`, list posts) | 1 min | Fine once connected, but the README offers no example prompt. | DX-05 |
| 9 | First safe write | 5+ min (self-discovered) | No walkthrough of plan → review → apply. `onboarding.md:281` claims "Writes stay in plan mode until you opt in", but `moderation` defaults to `apply` (`README.md:518`). | DX-03, DX-09 |
| **Σ** | | **≈20–45 min** | The README's "budget about 20 minutes" holds only for the happy path. No non-author has measured it (PM review 06, finding 4). | DX-10 |

---

## 3. Link and consistency audit

**Relative links:** 303 links / 65 files → **0 missing targets, 0 broken anchors.**
Keep this green by adding the checker to CI (DX-21).

**Env vars:** all `FB_*` names agree across `src/core/settings.ts`, the README generated env
table (`README.md:277-315`), `.env.example` and the runbooks. The only exceptions are
script-only `FB_SMOKE` and `FB_RECORD_FIXTURE`, which are correctly absent from user docs.
**Pass.** C04 (env renames) will break this unless it ships a docs follow-up (DX-12).

**Contradictions found:**

| Claim | Where | Contradicted by |
|---|---|---|
| "Page Stories … stay out" | `README.md:677-678` | `facebook_create_story` and `facebook_list_stories` ship (generated tools table) |
| "album/photo-library reads, Page profile editing" are out of scope | `README.md:679-681` | `facebook_list_albums`, `facebook_list_photos` and `facebook_update_page_profile` ship |
| "v1.0.0 ships without the ads package … lands in 1.1.0" | `README.md:725-729` | The v3 1.0 gate includes boost P1–P7 / L2.ads |
| "v1.1.0 — Ads" links to milestone/5 | `README.md:725` | milestone/5 is titled "v0.5.0 — Ads (opt-in)" |
| "Writes stay in `plan` mode until you opt in" | `docs/runbooks/onboarding.md:281` | `moderation` default `apply` (`README.md:518`) |
| `pages_manage_metadata` → messages only, and no `page_admin` row | `onboarding.md:70-71` | Generated scopes table (`README.md:319-415`) |
| "v0.7.0 on npm", "37 tools · 7 packages" | `docs/index.html:74,1359-1360,1422,1658,2463,2478,2488` | npm 0.8.0, 69 tools, 8 packages |
| "Questions → Discussions" | `SUPPORT.md:31`, `.github/ISSUE_TEMPLATE/config.yml` | Discussions are disabled (API 410). The issue chooser links to a 404. |
| Commit style `api: …` | `CONTRIBUTING.md:132` | History uses `feat(api): …` |
| Layout lists core/api/mcp/tools only | `CONTRIBUTING.md:24-36` | The six-layer map adds `src/cli` and `src/server` (`CONTRIBUTING.md:58`) |
| `package.json` `homepage` = GitHub readme | `package.json` | The Pages site is the declared docs home (`README.md:8`) |
| Sitemap `lastmod` 2026-08-09 | `docs/sitemap.xml` | Site edited 2026-10-22 |

---

## 4. Strengths to keep

- **Generated-docs discipline.** `npm run metadata` / `metadata:check` own the README env, scopes, packages and tools tables, `.env.example`, `manifest.json`, `server.json` and `docs/error-catalog.md`. CI enforces it. This is rare and is the right base for fixing the Pages site (DX-01).
- **Honesty.** The "not live-verified" banner, the dated comparison and SUPPORT.md's public adoption bar build trust. Keep the honesty, but reframe it (DX-06).
- **The onboarding runbook troubleshooting table** maps each error to its cause and fix. Keep its shape.
- **Security docs.** `SECURITY.md` offers private advisories with a fallback, and the issue templates warn to redact tokens. The `.mcpb` ships with `gh attestation verify` instructions.
- **The PR template checklist** matches the real gate and the layer rule.
- **Contributor credit was given correctly in substance.** The `c7ce5b8` message says "Builds on PR #41 by @lukaszliniewicz". The CHANGELOG thanks him (`CHANGELOG.md:48,712,720`). The release lists him under "New Contributors". Only the conversation was missing (DX-10).
- **Zero broken relative links** across 65 Markdown files.
- **Packaging breadth.** npx, the Claude Code plugin marketplace, a signed `.mcpb` and a `server.json` for the MCP registry are all present.

---

## 5. Findings (ordered by severity)

### DX-01 — The GitHub Pages site advertises 0.7.0, 37 tools and 7 packages — **Blocker**

- **Evidence:** `docs/index.html:74`: JSON-LD `softwareVersion: "0.7.0"`. `:1359-1360` and `:1658`: "37 tools · 7 packages". `:1360,1422,2463,2478`: "v0.7.0 on npm". `:2488`: `gh attestation verify facebook-mcp-0.7.0.mcpb`. The file was last touched in `bb36778` (2026-10-22). It is hand-written and outside the metadata generator.
- **Impact:** The site is the repo homepage and the README's "Documentation site" link (`README.md:8`). The first external surface undersells the product by half. The attestation command fails for anyone who downloads the 0.8.0 asset, which turns a trust feature into a trust failure. Search engines index the stale JSON-LD.
- **Recommendation:** Move the site's version, tool count, package count and `.mcpb` filename into generated markers, the same way the README tables work. Bump `sitemap.xml` `lastmod` in the same generator run. Make `metadata:check` fail on drift.
- **Placement:** 0.8.x · Wave A · **extend U-A2** (listings need a correct landing page), plus a generator change. Type I (integration), owner = integrator. Owns `scripts/metadata.config.mjs`, `docs/index.html` (marker blocks only) and `docs/sitemap.xml`.
- **Size:** M

### DX-02 — The README "Not in scope" list and Roadmap contradict shipped tools and the v3 plan — **Blocker**

- **Evidence:** `README.md:677-678` puts Page Stories out of scope. `README.md:679-681` puts album/photo reads and Page profile editing out of scope. All five of those tools are in the generated tools table. `README.md:725-729`: "v1.0.0 ships without the ads package … lands in 1.1.0". The "v1.1.0" link resolves to milestone/5, titled "v0.5.0 — Ads (opt-in)".
- **Impact:** A reviewer or directory curator reading the README concludes the docs are unmaintained. Agents that read the README (common for MCP users) will refuse to use tools that the README says do not exist. The roadmap promise conflicts with the 1.0 gate the owner has ratified.
- **Recommendation:** Rewrite "Not in scope" as "Shipped but unverified (beta)" vs. "Not planned". Replace the roadmap prose with a short table derived from `docs/analysis/v3/04-*.md` (0.8.x → 1.0 → 1.x). Rename or close milestones so the links are true (DX-16).
- **Placement:** 0.8.x · Wave A · **NEW D-01 "README prose truth pass"**. Type D (docs-only), owner = docs lane. Owns the non-generated README sections Status, Known limitations, Not in scope and Roadmap.
- **Size:** S

### DX-03 — No guided first safe write; the "plan by default" claim is false for moderation — **Major**

- **Evidence:** `docs/runbooks/onboarding.md:281` says "Writes stay in `plan` mode until you opt in". The generated packages table says `moderation` defaults to `apply` (`README.md:518`). The README Setup section ends at "run facebook_whoami". There is no plan → inspect → apply example with expected output.
- **Impact:** The product's differentiator (plan-and-apply tiers) is invisible during onboarding. Worse, a user who trusts the runbook can hide or delete comments on first use, believing the call is a dry run.
- **Recommendation:** Add "Step 9 — Your first safe write": create a post in plan mode, show the plan envelope, apply it, then delete it. Correct line 281 to name the `moderation` exception and the env var that changes it. Add a callout in the README Setup section.
- **Placement:** 0.8.x · Wave A · **NEW D-02 "Onboarding first-write + corrections"**. Type D, owner = docs lane. Owns `docs/runbooks/onboarding.md`.
- **Size:** S

### DX-04 — No Cursor or VS Code configuration snippets — **Major**

- **Evidence:** `README.md:246-262`: the client matrix has a single row each for VS Code (`.vscode/mcp.json → servers`) and Cursor (`~/.cursor/mcp.json`), and no JSON. Every client is marked "Not yet" verified. `onboarding.md` Step 7 defers to that matrix.
- **Impact:** Cursor and VS Code are two of the four target clients and a large part of the MCP audience. VS Code's `servers` key and its `inputs`-based secret prompt differ from Claude's `mcpServers`, so blind copy-paste fails silently.
- **Recommendation:** Add collapsible `<details>` blocks per client with exact JSON. For VS Code, show the `inputs` with `"password": true` pattern for the token. Add one-click install badges (the `vscode:mcp/install` and `cursor://` deeplinks) once verified. Generate the snippets from `server.json` so the package name and arguments never drift.
- **Placement:** 0.8.x · Wave A · **extend U-A2** (directory listings need the same snippets). The generator part is Type I and owns `scripts/metadata.config.mjs` plus a new `<!-- BEGIN GENERATED: clients -->` block.
- **Size:** M

### DX-05 — No example prompts, screenshots or demo GIF anywhere — **Major**

- **Evidence:** The README has no "Try asking" section and no images. The only image assets in the repo are `docs/assets/og-banner.{png,svg}`.
- **Impact:** An MCP server is used through natural language, so newcomers need to see the conversation, not the tool table. Directory listings (Smithery, PulseMCP, mcp.so, the Claude plugin directory) rank and convert on visuals **[UNVERIFIED for each directory's current rules]**.
- **Recommendation:** Add 6–8 example prompts grouped by package, each annotated with its tier, e.g. *"Draft a post for tomorrow 9:00 announcing X — plan only"*. Add one 20–30 s GIF of the plan → apply loop in Claude Desktop, recorded on a test Page and kept under 3 MB in `docs/assets/`.
- **Placement:** 0.8.x · Wave A · **extend U-A2**. Owner = U (only the owner has a live Page). Owns `README.md` (new non-generated section) and `docs/assets/demo.*`.
- **Size:** M

### DX-06 — The "not live-verified" warning dominates the first screen with no path forward — **Major**

- **Evidence:** The README status block (`README.md:15-21`) says "Nothing has been verified against the live Graph API yet", and every client row is "Not yet".
- **Impact:** Honest, but read as "do not use". There is no date, no link to the live-verification plan (A-tasks / smoke scripts) and no way for a user to contribute a verification.
- **Recommendation:** Shrink the warning to one line that links to a "Verification status" table showing per-package live status, date and who ran it. Invite users to report a successful run through a new "Verification report" issue template. This also produces the non-author issues the adoption bar needs.
- **Placement:** 0.8.x · Wave A · **NEW D-03 "Verification status page + template"**. Type D. Owns `docs/verification.md` and `.github/ISSUE_TEMPLATE/verification.yml`. README status lines go through D-01.
- **Size:** S

### DX-07 — The onboarding scope table has drifted from the generated scopes — **Major**

- **Evidence:** `onboarding.md:62-75` maps `pages_manage_metadata` to `messages` only (line 71) and `pages_messaging` to `messages` only (line 70). It has no `page_admin` row. The generated table (`README.md:319-415`) also requires `pages_manage_metadata` for `moderation` and `page_admin`, and `pages_messaging` for moderation's private reply. The runbook itself says to trust the generated table.
- **Impact:** Users under-scope the token in Step 3. They find out only at the first moderation private reply, after they have left the guided flow.
- **Recommendation:** Delete the hand-written table and link to the README anchor. Better, emit a second generated block into the runbook from `scripts/metadata.config.mjs`.
- **Placement:** 0.8.x · Wave A · Type I (generator). Owns `scripts/metadata.config.mjs` and the `docs/runbooks/onboarding.md` scope block. **NEW D-02** shares the file, so sequence them: D-02 first, then the generator block.
- **Size:** S

### DX-08 — Setup instructions put the App Secret and token into shell history — **Major**

- **Evidence:** `onboarding.md:104-106` warns that arguments land in shell history. `:111-114` and `:120-123` then recommend `FB_APP_ID='…' FB_APP_SECRET='…' FB_SETUP_TOKEN='…' npx …`, which zsh and bash also record. The README Setup section repeats the same pattern.
- **Impact:** The pattern contradicts the warning, and the copy-paste default leaks the long-lived secret. Security reviewers and DevRel readers will notice.
- **Recommendation:** Recommend `read -rs FB_SETUP_TOKEN && export FB_SETUP_TOKEN` (and the same for the secret), or a local untracked `.env` file plus `--env-file`. Note the `HISTCONTROL=ignorespace` / leading-space trick as a fallback. Cross-check with the security review (03) before choosing.
- **Placement:** 0.8.x · Wave A · **NEW D-02**. The README Setup text goes through D-01.
- **Size:** S

### DX-09 — The v0.8.0 GitHub release has no human release notes — **Major**

- **Evidence:** `gh release view v0.8.0`: the body is the 346-character auto-generated "What's Changed / New Contributors" text. It has no highlights, no BREAKING note (the insights shape changed), no upgrade or install steps and no checksum or attestation instructions.
- **Impact:** Releases are what watchers get notified about and what aggregators scrape. 0.8.0 doubled the tool count, and none of that reached anyone.
- **Recommendation:** Edit the v0.8.0 body: 5 highlights, BREAKING, install/upgrade, verify the `.mcpb`, and thanks. Add a `release-notes.md` template under `.github/` and make the release workflow use `--notes-file` from the CHANGELOG section summary.
- **Placement:** 0.8.x · Wave A · **extend U-A2** (the announcement rides on it). Owner = U for the edit, since editing a release is a repo-settings action that is out of this reviewer's remit. The template is Type D and owns `.github/release-notes.md`.
- **Size:** S

### DX-10 — External contributions were left unanswered; there is no response policy — **Major**

- **Evidence:** PR #41 (lukaszliniewicz), opened 2026-08-30: zero comments or reviews in 59 days, then "merged" 2026-10-28 via `626d70a` as superseded by `c7ce5b8` with no tree change. PR #40: closed by its author on 2026-10-24 after `d22b6f1` absorbed the fix, with no maintainer comment. `SUPPORT.md` states "no SLA". `CONTRIBUTING.md:132` bans co-author trailers, which removes the standard `Co-authored-by` credit path.
- **Impact:** The two first external contributors experienced silence. The adoption bar needs ≥3 non-author issues, and silence is the strongest deterrent. Credit was given correctly in the CHANGELOG and commit message, but invisibly to the contributor.
- **Recommendation:** Post a thank-you comment on #41 and #40 explaining what was absorbed and where it is credited. This is an owner action. Add a "Response expectations" paragraph to CONTRIBUTING: first response within 7 days, and the superseding policy. Change the trailer rule to "no AI co-author trailers; human co-authors are welcome".
- **Placement:** 0.8.x · Wave A · **NEW D-04 "Contributor policy pass"**. Type D. Owns `CONTRIBUTING.md` and `SUPPORT.md`. The comments are owner decision OD-3.
- **Size:** S

### DX-11 — The 0.8.0 CHANGELOG section is ~3,050 lines — **Minor**

- **Evidence:** `CHANGELOG.md:10-3060`. "Fixed" alone is lines 704-2839 (~2,135 lines). The whole file is 256 KB. 0.7.0 is ~140 lines.
- **Impact:** Nobody can find the BREAKING insights change. GitHub truncates rendering, and tools such as Dependabot and Renovate quote the top of the section.
- **Recommendation:** For 0.8.0, add a ≤40-line "Highlights / Breaking / Upgrade" summary at the top of the section and collapse the detail into `<details>`, or move it to `docs/changelog/0.8.0-detail.md`. For 1.0, enforce a per-fragment line budget in `changes/unreleased/`.
- **Placement:** 1.0 · Wave 6 · **extend I32** (the 1.0 CHANGELOG fold). The 0.8.x summary is NEW D-05 and owns `CHANGELOG.md` (0.8.0 header block only).
- **Size:** M

### DX-12 — Docs have no follow-up planned for the C04 env-var renames — **Minor**

- **Evidence:** `05-parallel-task-breakdown.md` C04 renames env vars. Generated tables will follow automatically, but prose does not: `onboarding.md`, `docs/runbooks/*`, `docs/index.html` and README Setup.
- **Impact:** This would break the one consistency property that currently passes (§3).
- **Recommendation:** Add a grep-based CI guard that fails when a non-generated doc names an unknown `FB_*` variable. Document old → new aliases in a short migration note.
- **Placement:** 1.0 · the wave of C04 · **extend C04's DoD**, plus NEW D-06 for the guard script (`scripts/check-doc-env.mjs`).
- **Size:** S

### DX-13 — CONTRIBUTING omits `metadata:check`, changelog fragments and the real layout — **Minor**

- **Evidence:** The gate table at `CONTRIBUTING.md:39-54` lists typecheck/lint/format/build/test only. CI also runs `metadata:check` and `guard:no-install-scripts` (`.github/workflows/ci.yml:44-46`). CONTRIBUTING does not mention `changes/unreleased/<id>.md`. The layout block (`:24-36`) omits `src/cli` and `src/server`. The commit example `api: …` (`:132`) does not match the history (`feat(api):`).
- **Impact:** A contributor who edits a tool description passes `npm run check` locally and then fails CI.
- **Recommendation:** Document the generator loop (`npm run metadata`), fragments, conventional commits and the six-layer layout.
- **Placement:** 0.8.x · Wave A · **NEW D-04**.
- **Size:** S

### DX-14 — The Meta app-creation steps lack screenshots and may lag Meta's UI — **Minor**

- **Evidence:** `onboarding.md:41` says "Pick the Business app type", and `:49` says "Add Facebook Login for Business". Meta now leads with a use-case picker **[UNVERIFIED]**.
- **Impact:** This is the single highest-abandonment step for non-Meta developers.
- **Recommendation:** The owner captures 4 annotated screenshots during the A-lane live run and dates them ("UI as of YYYY-MM-DD"). Add a "If you see X instead" note.
- **Placement:** 0.8.x · Wave A · **NEW D-02** (with owner-supplied images).
- **Size:** S

### DX-15 — Obsolete Dependabot PRs and stale issues make the repo look abandoned — **Minor**

- **Evidence:** Six Dependabot PRs are open (#1, #3, #4, #37, #38, #42). #1, #3 and #38 are already satisfied in `package.json`. Issue #15 "Release rail" is open although it has shipped. #11 and #19 are stale. All 30 issues are by the author, and there are 0 open `good first issue` issues even though the label exists.
- **Impact:** Visitors judge maintenance by the open-PR count and its age.
- **Recommendation:** Close the obsolete PRs and #15. Label 3–5 scoped docs tasks from this review as `good first issue` with acceptance criteria.
- **Placement:** 0.8.x · Wave A · owner hygiene (U). This is a repo action, not a file change.
- **Size:** S

### DX-16 — Milestones are all open, undated and misnamed against v3 — **Minor**

- **Evidence:** v0.1.0–v0.4.0 are open, some with 0 open issues. v0.5.0 "Ads (opt-in)" is linked as "v1.1.0" from `README.md:725`. None of the milestones has a due date.
- **Impact:** The README roadmap links land on contradictory pages.
- **Recommendation:** Close the completed milestones. Create `0.8.x`, `1.0` and `1.x` milestones matching v3, with due dates aligned to the 2026-11-25 checkpoint.
- **Placement:** 0.8.x · Wave A · owner (U). The `git-extra-info` skill covers it.
- **Size:** S

### DX-17 — Discoverability metadata is incomplete — **Minor**

- **Evidence:** There are 12 topics; `mcp-server`, `facebook-api`, `social-media` and `meta-graph-api` are missing. `usesCustomOpenGraphImage: false`, although `docs/assets/og-banner.png` exists. `package.json` `homepage` points to the GitHub readme instead of the Pages site. Referrers show 1 external source (aocr.org).
- **Impact:** GitHub topic pages and npm search are free distribution channels, and v3 names distribution as the bottleneck.
- **Recommendation:** Add the topics and upload the OG image (owner settings). Point `homepage` at the Pages site. Add npm `keywords` parity.
- **Placement:** 0.8.x · Wave A · **extend U-A2**. `package.json` belongs to the generator if keywords are generated; otherwise it is Type D.
- **Size:** S

### DX-18 — No CODE_OF_CONDUCT, and the community profile shows gaps — **Minor**

- **Evidence:** GitHub community profile health is 85%. `code_of_conduct` is missing. `issue_template` is reported false. The templates are legacy `.md` files; issue forms (`.yml`) are recognized.
- **Impact:** Some directories and corporate OSS policies check for a CoC.
- **Recommendation:** Add Contributor Covenant 2.1 with the SECURITY.md contact method. Convert the bug and feature templates to issue forms with required version and client fields.
- **Placement:** 0.8.x · Wave A · **NEW D-04** (adds `CODE_OF_CONDUCT.md` and `.github/ISSUE_TEMPLATE/*.yml`).
- **Size:** S

### DX-19 — "Questions → Discussions" is a dead end — **Minor**

- **Evidence:** `SUPPORT.md:31` and `.github/ISSUE_TEMPLATE/config.yml` (contact link) point to `/discussions`, but Discussions are disabled (the API returns 410). Blank issues are also disabled.
- **Impact:** A user with a question has no valid channel at all; the issue chooser sends them to a 404.
- **Recommendation:** Either enable Discussions with Q&A and Ideas categories (owner decision OD-2) or replace the link with a `question` issue form.
- **Placement:** 0.8.x · Wave A · NEW D-04 plus owner setting.
- **Size:** S

### DX-20 — The public analysis and review corpus overwhelms the docs IA — **Minor**

- **Evidence:** `README.md:763-778` (Documentation) links the analysis corpus next to the runbooks. `docs/` mixes user docs (runbooks, error catalog) with ~40 planning files (`docs/analysis/**`, `docs/reviews/**`).
- **Impact:** Newcomers cannot tell what is a user doc and what is internal deliberation. Agents fetching docs pull planning text as if it were product truth.
- **Recommendation:** Restructure per §6. Keep the corpus public (it is a transparency asset), but move it under `docs/internal/` with a banner, and drop it from the README Documentation list into a single "Design records" link.
- **Placement:** 1.0 · Wave 6 (after v3 docs stop churning) · **NEW D-07 "Docs IA restructure"**. Owns `docs/README.md` (new index) and the README Documentation section. The moves use `git mv` and the link checker runs in CI.
- **Size:** M

### DX-21 — The link checker is not in CI — **Nit**

- **Evidence:** There are 0 broken links today, but nothing prevents regressions. CI (`ci.yml`) has no docs-link job.
- **Recommendation:** Add `scripts/check-links.mjs` (relative links and anchors, offline) to `npm run check`.
- **Placement:** 0.8.x · Wave A · NEW D-06 (with the env-doc guard).
- **Size:** S

### DX-22 — The status badge links to `#` — **Nit**

- **Evidence:** `README.md:5`: `[![status](…pre--1.0-yellow…)](#)`.
- **Recommendation:** Link it to the Verification status page (DX-06).
- **Placement:** Through the `badges` skill / D-01.
- **Size:** S

### DX-23 — The "How this compares" survey is dated 2026-07-21 — **Nit**

- **Evidence:** `README.md:603-625`.
- **Recommendation:** Re-date it or add "as of" plus a re-survey cadence. PM review 06 finding 3 asked for this comparison, so keep it fresh.
- **Placement:** 0.8.x · Wave A · D-01.
- **Size:** S

### DX-24 — The README Support section lists three donation channels before any help channel — **Nit**

- **Evidence:** `README.md:779-` and `.github/FUNDING.yml` (GitHub Sponsors, Ko-fi, donatr.ee).
- **Impact:** Minor tone issue for a pre-1.0 project with no answered PRs.
- **Recommendation:** Lead with "Get help" (SUPPORT.md) and keep one sponsor line.
- **Placement:** D-01.
- **Size:** S

---

## 6. Proposed docs information architecture

```
README.md               <- 1-screen pitch, example prompts, GIF, per-client install
                           (generated snippets), "Next: onboarding"; generated tables
                           stay below the fold
docs/
  index.html            <- Pages site; version and tool counts via generated markers
  README.md             <- NEW docs index (tutorial / how-to / reference / explanation)
  tutorial/
    onboarding.md       <- moved from runbooks/; ends with the first safe write
  how-to/               <- runbooks/* (system user, token rotation, moderation, ads)
  reference/
    error-catalog.md    <- generated
    tools.md            <- NEW generated full tools reference (moves weight out of README)
    configuration.md    <- generated env + scopes
  verification.md       <- NEW live-verification status (DX-06)
  internal/             <- analysis/ + reviews/, with a "planning record" banner
CHANGELOG.md            <- summary first per release; detail collapsed
```

This shrinks README from 76 KB to a target below 25 KB without losing any generated
guarantee.

### Launch-readiness checklist (gate for the U-A2 announcement)

- [ ] Pages site shows 0.8.x, 69 tools and 8 packages, generated (DX-01)
- [ ] README "Not in scope" / Roadmap match shipped tools and v3 (DX-02)
- [ ] First safe write walkthrough plus moderation-default correction (DX-03)
- [ ] Cursor, VS Code, Claude Desktop and Claude Code snippets, each verified once (DX-04)
- [ ] ≥6 example prompts and one demo GIF (DX-05)
- [ ] Verification status page linked from the badge (DX-06, DX-22)
- [ ] v0.8.0 release body rewritten; template in place for the next release (DX-09)
- [ ] #40 and #41 acknowledged; response policy in CONTRIBUTING (DX-10)
- [ ] Obsolete Dependabot PRs and #15 closed; ≥3 `good first issue` open (DX-15)
- [ ] Topics, OG image and `homepage` fixed (DX-17)
- [ ] Questions channel works (DX-19)
- [ ] Time-to-first-call measured by one non-author at ≤20 min, with the result recorded in `docs/verification.md` (PM 06 finding 4)
- [ ] Listings submitted: MCP registry (`server.json`), Claude plugin directory, Smithery, PulseMCP, mcp.so, awesome-mcp-servers **[UNVERIFIED current submission rules]**

---

## 7. Roadmap placement summary

| Task | Release / wave | Type / owner | Owns | Findings |
|---|---|---|---|---|
| U-A2 (extend) | 0.8.x / A | U, owner | release body, topics, OG image, listings, GIF | DX-04, 05, 09, 17 |
| Generator (extend) | 0.8.x / A | I, integrator | `scripts/metadata.config.mjs`, site markers, sitemap, onboarding scope block, client snippets | DX-01, 04, 07 |
| NEW D-01 README prose truth pass | 0.8.x / A | D, docs | non-generated README sections | DX-02, 22, 23, 24 |
| NEW D-02 Onboarding fixes | 0.8.x / A | D, docs | `docs/runbooks/onboarding.md` | DX-03, 07, 08, 14 |
| NEW D-03 Verification page | 0.8.x / A | D, docs | `docs/verification.md`, issue form | DX-06 |
| NEW D-04 Contributor policy | 0.8.x / A | D, docs | `CONTRIBUTING.md`, `SUPPORT.md`, `CODE_OF_CONDUCT.md`, issue forms | DX-10, 13, 18, 19 |
| NEW D-05 0.8.0 CHANGELOG summary | 0.8.x / A | D, docs | `CHANGELOG.md` 0.8.0 header | DX-11 |
| NEW D-06 Doc guards | 0.8.x / A | D, docs | `scripts/check-links.mjs`, `scripts/check-doc-env.mjs` | DX-12, 21 |
| NEW D-07 Docs IA restructure | 1.0 / 6 | D, docs | `docs/README.md`, moves under `docs/` | DX-20 |
| I32 (extend) | 1.0 / 6 | I, integrator | CHANGELOG fold with line budget | DX-11 |
| C04 (extend DoD) | 1.0 / C04 wave | C | prose env references | DX-12 |
| Owner hygiene | 0.8.x / A | U | PRs, issues, milestones, settings | DX-15, 16 |

v3 has no docs-only lane today. **Recommend adding a "D" task type** to
`05-parallel-task-breakdown.md`: docs-only, parallel-safe, file ownership as listed above.

---

## 8. Owner decisions needed

- **OD-1 — Pages site source of truth.** Should `docs/index.html` move under the metadata generator (recommended), or be cut down to a redirect to the README?
- **OD-2 — Questions channel.** Enable GitHub Discussions (Q&A plus Ideas), or replace it with a `question` issue form? Either way the current dead link must go.
- **OD-3 — Contributor communication.** Comment on #41 and #40 now, and adopt a 7-day first-response target? Also: allow human `Co-authored-by` trailers while keeping the ban on AI attribution?
- **OD-4 — Analysis corpus visibility.** Keep it public under `docs/internal/` (recommended, as a transparency asset), or move it out of the published tree?
- **OD-5 — Honesty framing.** Replace the first-screen "nothing verified" banner with a dated per-package verification table, without overstating maturity?
- **OD-6 — CHANGELOG policy.** Summary-first with collapsed detail, and a per-fragment line budget for 1.0 (I32)?
- **OD-7 — Demo assets.** The owner must record the GIF and screenshots on a real Page. Do this before or after the A-lane live run? After is recommended, so the visuals show verified behavior.
- **OD-8 — Add a "D" (docs-only) task type to the v3 board**, or fold these tasks into U-A2 and I-lanes?
