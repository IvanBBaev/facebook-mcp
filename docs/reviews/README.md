# Role-Based Reviews of the Analysis Corpus

Before implementation, the pre-code analysis corpus (`docs/analysis/`) is
reviewed by senior-level reviewers, one per role. Each review is an independent,
critical pass over the full corpus with the raw research (`docs/ai/research/`)
available as backing evidence. Reviews were performed 2026-07-21.

## Why these roles

The corpus makes claims in six distinct risk domains; each domain has a
professional role whose core competency is catching exactly that class of error.
A seventh cross-cutting role covers what generic software roles miss about
MCP/LLM-facing design specifically.

| # | Role | What only this role reliably catches | Review file |
|---|---|---|---|
| 1 | **Senior Software Architect** | Layering flaws, wrong abstractions, pattern-porting mistakes (ServiceNow idioms that don't fit Graph API), scalability of the tool registry, SDK v1→v2 transition traps | [01-software-architect.md](01-software-architect.md) |
| 2 | **Senior Security Engineer** | Token-handling gaps, redaction blind spots, SSRF/media-path risks, appsecret_proof pitfalls, plan-and-apply bypass scenarios, HTTP-mode exposure | [02-security-engineer.md](02-security-engineer.md) |
| 3 | **Senior Meta Platform Specialist** | Wrong API facts: permissions/tasks matrix errors, deprecated params, metric-name drift, rate-limit misunderstandings, policy violations that get apps restricted | [03-meta-platform-specialist.md](03-meta-platform-specialist.md) |
| 4 | **Senior QA Engineer** | Untestable designs, missing failure-mode coverage, live-smoke-test risk (posting to a real audience!), fixture strategy gaps, coverage-gate realism | [04-qa-engineer.md](04-qa-engineer.md) |
| 5 | **Senior DevOps / Release Engineer** | CI matrix gaps, packaging/distribution traps (npm scoping, MCPB, registry), version pinning strategy, supply-chain hygiene, release automation | [05-devops-release-engineer.md](05-devops-release-engineer.md) |
| 6 | **Senior Product Manager (Developer Tools)** | Scope/positioning errors, roadmap sequencing risk, differentiation claims that won't hold, adoption friction for the secondary audience | [06-product-manager.md](06-product-manager.md) |
| 7 | **Senior MCP / Agent-UX Engineer** | LLM-facing tool ergonomics: tool granularity, description quality, token-budget behavior, annotation correctness, error messages a model can act on | [07-mcp-agent-ux-engineer.md](07-mcp-agent-ux-engineer.md) |

Roles considered and not included: **Legal/compliance** (no third-party data
processing, single-operator own-assets scope — Meta Platform Specialist covers
platform-policy risk); **SRE** (no hosted service); **Data engineer** (no
persistent data pipeline).

## Review protocol

Each reviewer was instructed to:
1. Read all of `docs/analysis/` and consult `docs/ai/research/` for evidence.
2. Review strictly from their role's perspective, at senior level, assuming the
   corpus will be implemented as written unless they object.
3. Document: overall verdict; strengths worth keeping; findings with severity
   (**Blocker / Major / Minor / Nit**), each with a concrete recommendation;
   open questions for the author.
4. Be adversarial where warranted — the goal is to find problems before code
   exists, when they are cheapest to fix.

Consolidated findings and the resulting action list: [SUMMARY.md](SUMMARY.md).
