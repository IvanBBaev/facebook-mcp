# 04 — Roadmap and risks

Dates are targets, not promises. Each phase ends with a release gate, and the waves that do the
work are defined in [doc 05](05-parallel-task-breakdown.md).

## 1. Phases

| Phase | Release | Target | Waves | Exit gate |
|---|---|---|---|---|
| A | **0.8.0** | Nov 2026 | A | `npm run check` and `metadata:check` green; 42 commits pushed; PR #41 decided; listings submitted |
| B | **1.0.0** | Jan 2027 | 0, 1, 2, 3 | All 1.0 contract items from [02 §3](02-v3-scope.md) merged; live gate L1–L8 and boost P1–P7 run; 1.x deprecations documented |
| C | **2.0.0** | Mar–Apr 2027 (before 2027-04-30) | 4 | SDK v2 + zod 4; dual-era conformance; Node ≥ 24; 1.x deprecations removed |
| D | **2.x** | Apr 2027 – Q3 2027 | 5 | One minor per theme; ads pin bump ≈ 2027-06 |
| E | **3.0.0** | Q4 2027 – Q1 2028 (before 2028-04-30) | 6 | Modern-only; `FB_CONFIRM_TOKEN` gone; Node ≥ 26; conditional SDK v3 / result shape |

The adoption gate (V3-D1) is measured 30 days after phase A. It decides lean vs ambitious for
phases D–E only. Phases B and C are right under either outcome.

## 2. Watch list

| Signal | Check when | If it fires |
|---|---|---|
| A result-shape SEP or an HTTP-over-stdio SEP is accepted | each spec RC (≈ 2027-02, ≈ 2027-08) | Add a C-task and lane tasks to wave 6 |
| TS SDK v3 announced | monthly | Plan P-task "SDK v3 swap" for wave 6 |
| SDK 2.x minor changes the `outputSchema` wrapper or `legacyShim` defaults | every SDK bump (I-task) | Snapshot tests catch it; pin and record |
| Meta insights deprecation wave | Graph changelog, monthly | Insights lane: flip `status` to `removed` for the hit metrics; patch release |
| Marketing API sunset date for v26 announced | quarterly | Pin the bump date; ads lane task |
| Meta publishes a Pages or Business Messaging MCP | monthly | Re-run V3-D1 positioning; consider "personal tool" |
| Claude Code adds Tasks or Apps support | each release | Re-open V3-D6 4b / V3-D8 |
| Non-author issues or PRs arrive | weekly | Answer within a week; it is the gate metric |

## 3. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Parallel branches collide in shared files | high without rules | days of rebase | Doc 05: exclusive ownership, facades, fragments, integration-owned wiring |
| R2 | 1.0 slips because features keep landing on 0.x | high (it already happened) | 2.0 misses Node 22 EOL | Feature freeze from wave 0 to the 1.0 tag; features only as wave 5 A-tasks |
| R3 | The 2.0 platform swap (P01) breaks many files at once | medium | merge freeze | P01 runs alone, under a code freeze, after waves 0–3 have shrunk the files |
| R4 | Meta removes an insights metric across all versions | high in 2027 | broken reports | C05 stable schema in 1.0 |
| R5 | The SDK changes behaviour inside a minor | medium (2.4.0 did) | silent contract drift | Exact SDK pin in 2.0; snapshot tests of `tools/list` and results |
| R6 | Adoption stays flat | high | wasted effort on the ambitious variant | V3-D1 gate; lean scope is the default |
| R7 | Meta ships an official Pages MCP | medium-high | positioning loss | Differentiate on the write gate, boost composability and local-first; or consolidate |
| R8 | Spec removes something the server uses | low | forced change | Nothing used is on the 2026-07-28 deprecation list; verify logging in 2.x |
| R9 | Node 24 EOL passes without a 3.0 | low | unsupported runtime | 2028-04-30 is a hard deadline for wave 6 |
| R10 | A secret lands in a branch | low | credential leak | Staged-diff secret scan in every task's definition of done |
