# SUMMARY — Role review round 3 (0.8.0, 2026-10-29)

Nine senior roles reviewed the implemented code at `2c8d8bd` (0.8.0 + wave 0 + C05) and the v3
roadmap in [`docs/analysis/v3/`](../../analysis/v3/README.md). This document consolidates their
verdicts, groups the findings into cross-role themes, and maps every accepted finding to a task
in the v3 dispatch board. The task IDs below are the **canonical** ones. Where a review proposed a
colliding ID (several reviewers proposed `C07`–`C09` or `D-01`), this summary renumbered it, and
the role documents should be read through the mapping in §5.

The roadmap documents now carry these results:

- [03 — owner decisions](../../analysis/v3/03-owner-decisions.md): V3-D12…D17, amendments, and the
  review-round decision table;
- [04 — roadmap and risks](../../analysis/v3/04-roadmap-and-risks.md): R11–R17, the amended phase B
  gate and the watch list;
- [05 — parallel task breakdown](../../analysis/v3/05-parallel-task-breakdown.md): §12, the
  review-round tasks.

The review itself changed no code. On 2026-10-30 the owner delegated every open decision; they
were taken as recommended (§6), and the first fixes landed the same day (§7).

## 1. Verdicts

| # | Role | Verdict | Blocker | Major | Minor | Nit |
|---|---|---|---:|---:|---:|---:|
| 01 | [Software Architect](01-software-architect.md) | Sound with changes | 0 | 6 | 9 | 3 |
| 02 | [Security Engineer](02-security-engineer.md) | **Not ready for 1.0** | 1 | 3 | 5 | 3 |
| 03 | [Meta Platform Specialist](03-meta-platform-specialist.md) | Correct with changes | 0 | 5 | 8 | 4 |
| 04 | [QA / Test Engineer](04-qa-engineer.md) | Ready with changes for 0.9, not for 1.0 | 0 | 7 | 6 | 2 |
| 05 | [DevOps / Release Engineer](05-devops-release-engineer.md) | **At risk** until OPS-01/02 are fixed | 2 | 6 | 10 | 4 |
| 06 | [MCP / Agent-UX Engineer](06-mcp-agent-ux-engineer.md) | Good with changes | 0 | 7 | 7 | 3 |
| 07 | [Product Manager](07-product-manager.md) | **Off track**, cheaply recoverable | 2 | 9 | 5 | 2 |
| 08 | [DevRel / OSS & Docs](08-devrel-oss-docs.md) | Workable with changes | 2 | 8 | 10 | 4 |
| 09 | [Legal / Privacy / Compliance](09-legal-privacy-compliance.md) | Manageable with changes | 0 | 5 | 7 | 4 |
| | **Total (159)** | | **7** | **56** | **67** | **29** |

Compared with 2026-07 (2 Blockers, all on the design): the engineering is far stronger than the
corpus promised. The 2026-07 B1 (confused deputy) is now code and largely holds. B2 (live smoke)
is still not run. The new Blockers are about **release governance, live evidence and adoption**,
not about the architecture.

## 2. Blockers

| ID | Role | Blocker | Fix | Placement |
|---|---|---|---|---|
| SEC-01 | Security | Free-text moderation replies and outbound messages run with no plan step in the default mode. A tainted comment can steer the agent to post text on the Page (`src/tools/moderation/index.ts:113`). | Moderation free-text verbs are plan-first now (R02); outbound taint latch (C08) in 1.0 | 0.8.1 R02; wave 1 C08 |
| OPS-01 | DevOps | The long-lived `NPM_TOKEN` secret is still present next to the OIDC trusted publisher, and `release.yml` falls back to it. | Verify the trusted publisher, delete the secret, remove the fallback | U-A7 (owner); R15 |
| OPS-02 | DevOps | No ruleset on `main` or `v*` tags and no `release` environment. Any push of a tag publishes to npm without approval. | Rulesets, a `release` environment with a required reviewer, recovery plan | U-A7 (owner); R15 |
| PM-01 | Product | The server has never been used for a real job on a real Page. The roadmap stacks 1.0 contract work on unverified behaviour. | A thin live pass on 0.8.0 plus a two-week dogfood log before wave 2 | U-A3, U-A4 |
| PM-02 | Product | 1.0 has no user-outcome gate. Nobody but the author has ever completed onboarding. | Two onboarding trials on other people's machines are part of the 1.0 gate | U31; phase B gate |
| DX-01 | DevRel | The GitHub Pages site is hand-written and contradicts the README (tool count, install command, status). | Put the site under the metadata generator | I-A4 |
| DX-02 | DevRel | The README states things that are false today (live-verified, plugin-installable, "stable"). | README truth pass | D01 |

Three of the seven Blockers (OPS-01, OPS-02, SEC-01) are cheap and should land before anything
else. They need an owner yes, not engineering time.

## 3. Cross-role themes

| # | Theme | Roles | What they agree on |
|---|---|---|---|
| T1 | **No live verification** | META, QA, PM, SEC, DX | Every fixture encodes an unchecked assumption. Run a thin live pass on 0.8.0 now (U-A3), and the full 1.0 subset in wave 3 (U30a). Stop calling the server "verified" anywhere. |
| T2 | **Write-gate weaknesses** | SEC, AUX, QA, ARC | The gate is well built, but: free-text writes skip the plan (SEC-01); the confirm token is one static env value (SEC-02); elicitation shows no evidence (SEC-03); tiers are declared twice (QA-07); `destructiveHint` does not follow the tier (AUX-04). |
| T3 | **The ads money path** | META, SEC, QA, LEG | `advantage_audience` must be explicit **now** on v26, not in 2027 (META-01). Spend writes need a mandatory budget ceiling (SEC-04). Ads fixtures are synthetic (QA-02). Special ad categories need an attestation (LEG-04). The 2026-11-20 ad terms are unread (LEG-11). |
| T4 | **Release governance** | OPS, SEC, DX | One maintainer, a live npm token, no rulesets, no approval step, stale Dependabot PRs, unpinned `npx` and marketplace refs. |
| T5 | **Test infrastructure first** | QA, ARC, AUX | Wave 1 changes contracts that nothing snapshots. Golden `tools/list` and result snapshots, an exact SDK pin, a coverage ratchet and a guard manifest must land **before** C01 (wave 1a). |
| T6 | **Schema budget** | AUX, ARC | Measured: default profile 126,595 B, `all` 171,609 B. The A02 target (`all` < 110 KB) is in wave 5, too late; a ratchet must start in wave 1a. |
| T7 | **Stale public surfaces** | DX, PM, OPS | Pages site, README status lines, 0.8.0 release notes, milestones, Discussions and the 256 KB CHANGELOG all disagree with each other. |
| T8 | **Privacy disclosure** | LEG, SEC | Messenger content and visitor UGC go to the operator's LLM provider and to local disk (journal, exports). No `PRIVACY.md`, no retention, no registry `privacy_policies`. Must be fixed before the launch (U-A2). |
| T9 | **1.0 vs 2.0 sequencing** | PM, ARC, OPS | Two breaking releases three months apart is costly for a 2-star project. Either make 0.9 the contract release and 1.0 the platform release, or keep 1.0/2.0 but say why. "Phases B and C are right under either outcome" (doc 04) does not hold. |
| T10 | **Lane-model accuracy** | ARC, QA | Rule 7 lists 4 cross-lane edges; the import graph has about 16. Media upload is a shared module that no lane owns (C07). P01 "freeze everything" is unnecessary after the wave 0 splits. |

## 4. Recommended reshape of the roadmap

1. **0.8.1 hotfix release now** (I-A3): R01 explicit `advantage_audience` (META-01) and R02
   plan-first moderation free text (SEC-01). Both are lane-local bug fixes, allowed by rule 10.
2. **Owner actions before more engineering** (wave A additions): U-A7 release credential and
   governance, U-A3 thin live pass, U-A8 repo hygiene, U-A9 ad terms review, D08 privacy notice,
   then the launch U-A2a–d.
3. **Wave 2 waits for U-A2 and U-A3** (V3-D15, recommended B). Wave 1 contract work can run in
   parallel with the launch, because it is internal.
4. **Wave 1a before C01**: snapshots (R10), SDK pin + runner hardening + coverage ratchet (R11),
   guard manifest (R12), schema-budget ratchet (R13), fitness functions (R14), release-rail
   hardening (R15), fixture tooling (R16), test splits (R17), upload boundary tests (R18).
5. **Wave 1 grows the write-gate fixes**: C08 outbound taint latch, C09 per-plan confirmation
   code, C11 single tier declaration, C12 annotation derivation, plus C07 shared media source.
6. **Wave 3 splits the live gate** into U30a (live behaviour, 1.0 subset) and U30b (fixture
   capture, ads included), and adds U31 onboarding trials.
7. **One breaking line** (V3-D13, recommended B): 0.9 = contracts; 1.0 = platform + contracts,
   before 2027-04-30. If the owner keeps the current 1.0/2.0 split, everything above still holds;
   only the version labels change.

## 5. Finding → task map

Type **D** (docs task) is new in this round; see doc 05 §12. "Ext." means the finding extends an
existing task in doc 05.

### Wave A / 0.8.x

| Task | Type | Findings | Owns | Size |
|---|---|---|---|---|
| U-A2a | U | PM-05 | — (4 directory submissions) | S |
| U-A2b | U | PM-05, DX-05 | — (plugin install walk-through, flip the compatibility row, submit) | S |
| U-A2c | U | PM-05, PM-09 | — (one announcement for developer-operators via `launch-marketing`) | S |
| U-A2d | U | DX-04, DX-05, DX-09, DX-17 | `docs/assets/demo.*` | S |
| U-A3 | U | PM-01, META-05, D-META-4 | — (live pass on 0.8.0: META §7 A1, A3, C4, D3; spend cap ≤ 1 currency unit) | M |
| U-A4 | U | PM-01 | `docs/ai/dogfood-log.md` (local) | M |
| U-A5 | U | PM-08 | — (pre-written response to an official Meta MCP; V3-D16) | S |
| U-A6 | U | PM-10 | — (maintenance budget and sunset clause in the README; owner text) | S |
| U-A7 | U | OPS-01, OPS-02, SEC-08 (settings), D-OPS-2/4/6 | GitHub settings, npm settings | S |
| U-A8 | U | OPS-06, DX-09, DX-10, DX-15, DX-16, DX-19 | GitHub settings (Dependabot PRs #42/#38/#37, milestones, Discussions, 0.8.0 release notes, #40/#41 answers) | S |
| U-A9 | U | LEG-11 | — (review the 2026-11-20 ad terms; ads liability notice text) | S |
| R01 | L | META-01, D-META-1 | `src/api/ads-*.ts`, `src/tools/ads*` (targeting edit, duplicate) | S |
| R02 | L | SEC-01, DX-03 | `src/tools/moderation/*` | S |
| I-A3 | I | — | release 0.8.1 | S |
| I-A4 | I | DX-01, DX-04, DX-07, DX-17, LEG-05 | `scripts/metadata.config.mjs`, marker blocks of `docs/index.html`, manifest `privacy_policies` | M |
| D01 | D | DX-02, DX-06, DX-22, DX-23, DX-24, PM-06, PM-09, LEG-04, LEG-11, LEG-12, LEG-14 | non-generated README sections | M |
| D02 | D | DX-03, DX-07, DX-08, DX-14, D-META-5 | `docs/runbooks/onboarding.md` | S |
| D03 | D | DX-06 | `docs/verification.md`, `.github/ISSUE_TEMPLATE/verification.yml` | S |
| D04 | D | DX-10, DX-13, DX-18, DX-19, PM-14 | `CONTRIBUTING.md`, `SUPPORT.md`, `CODE_OF_CONDUCT.md`, other `.github/ISSUE_TEMPLATE/*` | S |
| D05 | D | DX-11 | 0.8.0 header block of `CHANGELOG.md` | S |
| D06 | D | DX-12, DX-21 | `scripts/check-doc-env.mjs` (link checker wired by an I-task) | S |
| D08 | D | LEG-01, LEG-05, LEG-06, LEG-08, LEG-09, LEG-10 | `PRIVACY.md`, `SECURITY.md` cross-link — **before U-A2** | S |
| D09 | D | LEG-03 | `docs/assets/og-banner.*`, mark lines of `docs/index.html` — after I-A4, owner design choice | S |

### Wave 1a (before C01)

| Task | Type | Findings | Owns | Size |
|---|---|---|---|---|
| R10 | C | QA-01, ARC-06 | `src/contract/*`, `test/contract/*` (golden `tools/list` and result snapshots) | M |
| R11 | I | ARC-06, D-ARC-3, QA-04, QA-08, ARC-12, D-QA-2 | `package.json`, `package-lock.json`, `.c8rc.json` (`all: true`), `ci.yml`, clock injection in `src/core/http.test.ts` | M |
| R12 | C | QA-06 | `src/guards.manifest.test.ts` | M |
| R13 | C | AUX-01, OD-4 | `src/schema-budget.test.ts`, `scripts/measure-schema.mjs` (default ≤ 90 KB, `all` ≤ 110 KB, persona ≤ 40 KB) | S |
| R14 | I | ARC I02 parts, D-ARC-7 | `lane-graph.json` gate, orphan modules, file-size soft gate (≤ 1200 production / ≤ 2500 test, shrinking allowlist), tool-name literal ratchet | S |
| R15 | I | OPS-03, OPS-04, OPS-06, OPS-07, SEC-08 (workflow), D-OPS-3 | `.github/workflows/release.yml`, `.github/dependabot.yml`, `docs/runbooks/release.md` | M |
| R16 | C | QA-03 | `scripts/record-fixture.mjs`, fixture lint, `test/fixtures/README.md` | S |
| R17 | X | QA-12, ARC-09 | the 7 test files over 2,500 lines | M |
| R18 | L | QA-05 (mutant M15) | `media-video.test.ts`, `media-reels.test.ts` | S |

### Wave 1

| Task | Type | Findings | Owns / change | Size |
|---|---|---|---|---|
| C01 ext. | C | AUX-03, META error items | validation / unknown-argument / unknown-tool codes | M → L |
| C02 ext. | C | AUX-02, AUX-06, QA-13 | list-level taint warning, truncation-safe paging, `until` exclusive, `parsePage` first | — |
| C03 ext. | C | SEC-03, ARC-14, AUX-08 | evidence block in elicitation | — |
| C04 ext. | C | SEC-04, SEC-05, DX-12 | mandatory `FB_ADS_BUDGET_CEILING` for spend writes; `appsecret_proof` required unless `FB_ALLOW_NO_APPSECRET` | — |
| C06 ext. | C | ARC-10, ARC-13, AUX-07 | logFields check; argument aliases | S → M |
| C07 | C | ARC-01, D-ARC-1 | `src/api/media-source.ts`; `media-photos.ts` section becomes a facade | M |
| C08 | C | SEC-01, SEC-06 | `write-mode.ts`, `taint.ts`, `confirm.ts`, `executeWrite` in `tools/shared.ts`, `core/redact.ts` predicate | M |
| C09 | C | SEC-02 | `confirm.ts`, `settings.ts` (mode flag), `src/cli/confirm/*` | M |
| C10 | C | ARC-04 | `src/core/tool-names.ts` | S |
| C11 | C | QA-07, D-QA-4 | `write-mode.ts` tier section, `define.ts` tier field | S |
| C12 | C | AUX-04 | `src/mcp/annotations/index.ts` | S |
| C13 | C | ARC-08 | `src/core/json.ts` | S |
| C14 | C | LEG-02 (parts 2–3) | `src/mcp/journal.ts`, `config.ts` (`FB_JOURNAL_RETENTION_DAYS`) | S |
| X08 | X | ARC-07 | `src/core/types/*` | S |
| X09–X11 | X | ARC-09 | `insights.ts`; `media-video.ts` / `media-reels.ts`; `ads-read.ts` | M each |

### Wave 2

| Task | Change | Findings |
|---|---|---|
| L2.core | `usage` hint; doctor permissions column | META |
| L2.reader | **Reverse** `get_activity_since` `idempotentHint: true`; adopt list taint | AUX-13, AUX-02 |
| L2.posts | `create_story` **stays irreversible** with `destructiveHint`; the upload part moves out | SEC-01, OD-7 |
| L2.posts-upload | **New.** Adopt `upload-session.ts` in the media paths, else revert X06; resume test suite | ARC-02, META-02, D-META-2, QA-05 |
| L2.moderation | Stop storing reply text in the journal; list taint | LEG-02 (part 1), AUX-02 |
| L2.messages | `delete_saved_reply` hint; messaging-window item | AUX, META |
| L2.ads | `bid_strategy` on the ad set; bid wording; ceiling enforcement; special-ad attestation; fixture backfill; `boost_post` hint | META-03, META-04, SEC-04, LEG-04, QA-02, QA-08 |
| L2.page-admin | `update_page_profile` hint | AUX |
| every lane | owns its `src/mcp/doctor/<lane>.ts` probe | ARC |
| A01 | `instructions` pulled into 1.0 as a wave-2 side task | AUX-05, OD-2 |

### Waves 3 and 4

| Task | Change | Findings |
|---|---|---|
| I30 ext. | Add a `WriteGatePort` on `ToolContext` | ARC-03, D-ARC-6 |
| I31 ext. | Package exports = CLI and server only; decide now | OPS-05, D-OPS-1 |
| I33 | `src/write-safety.test.ts` sweep | ARC-03 |
| I34 | SDK import restriction; remove the setup-token facade | ARC-11 |
| I35 | `boost.smoke.mjs`, sweepers, live-gate table (`scripts/smoke/*`) | META-05 |
| C30 | Conformance baseline (`src/conformance/*`) | QA-10 |
| U30a | Live gate per META §7; 1.0 subset A1, A3, B1, C1, C3, C4, D2, D3, D8, E1, E2 | META-05, PM-01 |
| U30b | Fixture capture incl. ads (PAUSED, zero delivery) → L3.ads-fixtures | QA-02, QA-03, D-QA-3 |
| U31 | Onboarding trials on 2 clients | PM-02 |
| I32 ext. | Rollback rehearsal on `1.0.0-rc.1`; CHANGELOG policy; QA §7 release checklist | OPS, QA |
| D07 | Docs IA restructure (`docs/README.md`) | DX-20 |
| P01 re-scope | No code freeze; size M | D-ARC-4 |
| P02 | Hard dependency on P03 | ARC-05 |
| P06 | `PlanStore` port (`src/core/ports/plan-store.ts`) | ARC, D-ARC-5 |
| I-task | TypeScript 7 evaluation | ARC |

### 1.x follow-ups (wave 3x)

| Task | Change | Findings |
|---|---|---|
| M01 | Apply by `plan_id` alone | AUX-09, OD-6 |
| M02 | Taint page-authored text | SEC-07 |
| M03 | Kill switch without a restart | SEC-09 |
| M04 | Graph usage view (`http.ts`, `tools/core.ts`) | META |
| M05 | L5 schema diet pulled into 1.x | AUX |
| M06 | Remove the `http.ts` `verifyTool` inference | ARC-15 |
| M07 | A03 prompts/resources in 1.x (subject to OD-2) | AUX |

Minor and Nit findings not listed above stay in the role documents. Each role document names the
lane that should pick them up when it next touches the file.

## 6. Owner decisions raised

All were **decided on 2026-10-30 by owner delegation**, as recommended, and are recorded in
[doc 03](../../analysis/v3/03-owner-decisions.md) (V3-D12…D17, the amendments, and the
"Review-round decisions" table). The owner can reopen any of them there.

| Area | Decisions (recommendation) |
|---|---|
| Product | V3-D12 1.0 meaning (C, "verified Pages core"); V3-D13 one breaking line (B); V3-D14 experimental tier (B); V3-D15 wave 2 waits for U-A2/U-A3 (B); V3-D16 Meta MCP response (B); V3-D17 segment = developer-operators (B); V3-D1 amend (B, per server, clock from listings); V3-D9 / U60 amend (B, trigger-based removal) |
| Security | SD-1b outbound confirmation; SD-2b moderation plan-first; SD-3b per-plan confirm code; SD-4b mandatory ads ceiling; SD-5b app secret required; SD-6b release approval |
| Release | D-OPS-1 exports; D-OPS-2 approval; D-OPS-3 marketplace ref; D-OPS-4 bus factor; D-OPS-6 merge method; D-OPS-7 release notes |
| Meta | D-META-1 hotfix now; D-META-2 upload session; D-META-3 special-ad attestation; D-META-4 early live pass; D-META-5 Standard Access text |
| QA | D-QA-1 wave 1a; D-QA-2 coverage gate in `check`; D-QA-3 ads fixture capture; D-QA-4 single tier; D-QA-5 mutation runner |
| Architecture | D-ARC-1…7 |
| Agent UX | OD-1 V3-D5 "3b + args"; OD-2 A01 into 1.0; OD-3 time window; OD-4 budget ratchet; OD-5 list taint; OD-6 apply by id; OD-7 `create_story` tier |
| Legal / docs | Journal retention (90 days default); logo and display name (LEG-03/12); privacy policy hosting (LEG-05); docs task type D; Pages source (DX OD-1); analysis corpus visibility (DX OD-4) |

The Legal review (§8) also lists seven questions for a lawyer. Delegation cannot answer them.
None of them blocks 0.8.x or 0.9; they must be answered before the stable 1.0 (V3-D13) or any
remote mode.

## 7. What to do this week

State on 2026-10-30, after the delegated decisions.

| # | Action | Who | State |
|---|---|---|---|
| 1 | Rulesets on `main` and `v*` tags; `release` environment with the owner as required reviewer; `npm-publish` runs in that environment (OPS-02, SD-6) | Done | **Done 2026-10-30** |
| 2 | Delete the `NPM_TOKEN` secret, revoke the token on npmjs.com, verify the trusted publisher (OPS-01) | Owner | Open — secret-store writes are owner-only |
| 3 | R01 explicit `advantage_audience`, R02 plan-first moderation free text | Lanes | Done 2026-10-30 (`99ae652`, `ee54de1`) |
| 4 | Release 0.8.1 (I-A3) | Owner (tag push, then approve the deployment) | R01/R02 are on `main`; waits for the owner's tag push and approval |
| 5 | `PRIVACY.md` (D08) | Docs | Done 2026-10-30 (`1df6e1f`) |
| 6 | 2026-11-20 ad terms (U-A9) | Analysis | [10-ad-terms-2026-11-20](10-ad-terms-2026-11-20.md); the liability text goes into D01 |
| 7 | Thin live pass (U-A3) | Owner | Open — needs a real Page and the test ad account |
| 8 | Launch U-A2a–d | Owner | Open — after D08 and U-A3; the announcement needs the owner's yes |
