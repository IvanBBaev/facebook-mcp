# Role review round 3 — implemented code at 0.8.0 (2026-10-29)

The first review round (`docs/reviews/`, 2026-07-21/22) reviewed the **pre-code
design corpus**. This round reviews the **implemented code**:

- version 0.8.0, plus wave 0 and C05 (commit `2c8d8bd`);
- the **v3 roadmap** in `docs/analysis/v3/`.

Each senior role reviewed the code independently. Each role checked what became of
its 2026-07 findings and placed every new finding in the v3 dispatch model
(release → wave → task / lane).

## Documents

| # | Document | Content |
|---|---|---|
| 00 | [Current-state baseline](00-current-state-baseline.md) | Measured facts shared by all roles: size, gate, coverage, delivery state, adoption |
| 01 | [Software Architect](01-software-architect.md) | Layering, module size, duplication, type and HTTP design, SDK v2 readiness |
| 02 | [Security Engineer](02-security-engineer.md) | Threat model, tokens, SSRF, transport, prompt injection, write-gate bypasses, supply chain |
| 03 | [Meta Platform Specialist](03-meta-platform-specialist.md) | Graph / Messenger / Ads correctness, permissions, Meta calendar, live verification plan |
| 04 | [QA / Test Engineer](04-qa-engineer.md) | What the tests prove, mutation probes, fake fidelity, smoke readiness, 1.0 test gate |
| 05 | [DevOps / Release Engineer](05-devops-release-engineer.md) | CI, provenance, packaging, release rail, Dependabot, Node transitions |
| 06 | [MCP / Agent-UX Engineer](06-mcp-agent-ux-engineer.md) | Measured `tools/list` size, schemas, annotations, agent task walkthroughs |
| 07 | [Product Manager](07-product-manager.md) | Users, JTBD, competition, 1.0 definition, adoption gate |
| 08 | [DevRel / OSS Maintainer & Docs](08-devrel-oss-docs.md) | Newcomer funnel, links, docs IA, contributor experience, launch readiness |
| 09 | [Legal / Privacy / Platform Compliance](09-legal-privacy-compliance.md) | Meta terms, GDPR roles, data inventory, notices, trademark, licences |
| — | [SUMMARY](SUMMARY.md) | Consolidated verdicts, cross-role themes, the roadmap delta |

## Role selection

The roles were chosen from what the baseline shows the project needs now, not from
a fixed list.

| Role | Kept / new | Why it is needed now |
|---|---|---|
| Software Architect | Kept | About 59k LOC in six layers; 17 files over 950 lines; duplicated upload paths; the wave 4 SDK v2 migration needs an architecture that can absorb it. |
| Security Engineer | Kept | The confused-deputy Blocker (B1) from 2026-07 is now code (taint, confirm, write mode) and must be tested as code. The HTTP transport, the setup-token CLI and ads spend are new attack surface. |
| Meta Platform Specialist | Kept | The server has **never touched the live Graph API**. Meta's 2026-11 → 2027 calendar forces changes. Permission matrices and error mapping are assumptions until checked. |
| QA / Test Engineer | Kept | 99.7 % coverage hides how strong the assertions are and how faithful the fakes are. The live smoke gate (B2 in 2026-07) is still unrun. |
| DevOps / Release Engineer | Kept | Five distribution channels (npm, `.mcpb`, MCP registry, plugin, Pages). Single maintainer. Node 22 EOL. Stale Dependabot PRs. |
| MCP / Agent-UX Engineer | Kept | 69 tools is a large context budget. Waves 1, 2 and 5 are mostly agent-UX work, and their priorities need an outside check. |
| Product Manager | Kept | The roadmap is engineering-led (contract → platform → removals) while adoption is 2 stars. The V3-D1 adoption gate is open. |
| DevRel / OSS Maintainer & Docs | **New** | Adoption is the bottleneck: a 76 KB README, a 256 KB CHANGELOG, a hard Meta-app onboarding, and the launch (U-A2) is still pending. No 2026-07 role owned the newcomer funnel. |
| Legal / Privacy / Platform Compliance | **New** (excluded in 2026-07) | Code now ships that moves private Messenger messages and visitor UGC to third-party LLM providers and stores them on local disk. It also automates ad spend under Meta terms that change on 2026-11-20, and it uses Meta's trademark in the product name. The 2026-07 exclusion rested on "no code yet". That no longer holds. |

### Excluded roles

| Role | Why it is excluded |
|---|---|
| SRE / Operations | There is no hosted service, SLO or on-call. Local operational concerns (kill switch, rotation, rate limits) are covered by the Security, Meta and DevOps reviews. Revisit if V3-D4 (remote mode) is decided "yes". |
| Data engineer | Insights exports are small and operator-local. The stable insights schema (C05) is reviewed by the Architect and Agent-UX roles. |
| UX / visual designer | The product has no UI. The only visual surface is the GitHub Pages site, and DevRel covers it. |
| Performance engineer | The workload is single-operator and Graph-bound. Rate limiting and backoff fall under the Meta and Architect reviews. |

## Method

1. Build the shared baseline (doc 00) from measurements: the gate, coverage, audit,
   `npm outdated`, LOC, git and GitHub state.
2. Run nine independent senior reviews in parallel. Each reviewer gets the baseline,
   the roadmap, its 2026-07 predecessor review (where one exists), and the
   instruction to be adversarial and cite `path:line` evidence.
3. Rate every finding **Blocker / Major / Minor / Nit**, the same scale as 2026-07.
4. Give every finding a **roadmap placement**: release, wave, and an existing task
   ID to extend or a NEW task with the files it owns, following the exclusive-ownership
   rules in `docs/analysis/v3/05-parallel-task-breakdown.md`.
5. Consolidate everything in [SUMMARY](SUMMARY.md). Fold the accepted findings into:
   - `docs/analysis/v3/03-owner-decisions.md` (new decisions);
   - `04-roadmap-and-risks.md` (risks and watch list);
   - `05-parallel-task-breakdown.md` (new R-tasks per wave).
