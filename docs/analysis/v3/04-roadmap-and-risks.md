# 04 — Roadmap and risks

Dates are targets, not promises. Each phase ends with a release gate, and the waves that do the
work are defined in [doc 05](05-parallel-task-breakdown.md).

## 1. Phases

| Phase | Release | Target | Waves | Exit gate |
|---|---|---|---|---|
| A | **0.8.0** | Nov 2026 | A | `npm run check` and `metadata:check` green; 42 commits pushed; PR #41 decided; listings submitted |
| B | **0.9.0** (was 1.0.0) | Jan 2027 | 0, 1a, 1, 2, 3 | All contract items from [02 §3](02-v3-scope.md) merged; SEC-01…04 fixes (R02, C04 ext., C08, C09) merged; golden snapshots (R10) green; U30a live subset passed; U31 onboarding trials done by two people other than the owner; deprecations documented |
| C | **1.0.0** (was 2.0.0) | Mar–Apr 2027 (before 2027-04-30) | 4 | SDK v2 + zod 4; dual-era conformance; Node ≥ 24; 0.9 deprecations removed; the "verified Pages core" of V3-D12 |
| D | **1.x** (was 2.x) | Apr 2027 – Q3 2027 | 5 | One minor per theme; ads pin bump ≈ 2027-06 |
| E | **2.0.0** (was 3.0.0) | trigger-based, before 2028-04-30 | 6 | Modern-only; `FB_CONFIRM_TOKEN` gone; Node ≥ 26; conditional SDK v3 / result shape |

Phase A also covers the **0.8.1** hotfix (R01, R02) and the owner tasks U-A2…U-A9 added by the
review round of 2026-10-29.

**Release labels (V3-D13 B, decided 2026-10-30).** The phases and waves are unchanged; only the
version numbers moved. Older documents in this corpus use the old labels:

| Old label | New label | Content |
|---|---|---|
| 1.0.0 | **0.9.0** | Contracts |
| 2.0.0 | **1.0.0** | Platform, verified Pages core |
| 2.x | **1.x** | Additive themes |
| 3.0.0 | **2.0.0** | Removals, trigger-based (V3-D9) |

The adoption gate (V3-D1, amended) is measured per server, 30 days after the listings are
submitted. It decides lean vs ambitious for phases D–E. Phases B and C are **not** right under
either outcome without the user evidence of V3-D12: wave 2 waits for U-A2 and U-A3 (V3-D15), and
the phase B gate includes the onboarding trials (U31).

## 2. Watch list

| Signal | Check when | If it fires |
|---|---|---|
| A result-shape SEP or an HTTP-over-stdio SEP is accepted | each spec RC (≈ 2027-02, ≈ 2027-08) | Add a C-task and lane tasks to wave 6 |
| TS SDK v3 announced | monthly | Plan P-task "SDK v3 swap" for wave 6 |
| SDK 2.x minor changes the `outputSchema` wrapper or `legacyShim` defaults | every SDK bump (I-task) | Snapshot tests catch it; pin and record |
| Meta insights deprecation wave | Graph changelog, monthly | Insights lane: flip `status` to `removed` for the hit metrics; patch release |
| Marketing API sunset date for v26 announced (expected ≈ 2027-08/09) | quarterly | Pin the bump date; ads lane task |
| Marketing API v27 breaking changes | reminder 2027-04 | Two months of lead time before the A09 pin bump |
| Meta Self-Serve Ad Terms update | 2026-11-20 | U-A9; analysis in [`10-ad-terms-2026-11-20`](../../reviews/v3/10-ad-terms-2026-11-20.md) |
| Meta publishes a Pages or Business Messaging MCP | monthly | Apply the U-A5 response plan (V3-D16) |
| Claude Code adds Tasks or Apps support | each release | Re-open V3-D6 4b / V3-D8 |
| Non-author issues or PRs arrive | weekly | Answer within a week; it is the gate metric |

## 3. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Parallel branches collide in shared files | high without rules | days of rebase | Doc 05: exclusive ownership, facades, fragments, integration-owned wiring |
| R2 | 1.0 slips because features keep landing on 0.x | high (it already happened) | 2.0 misses Node 22 EOL | Feature freeze from wave 0 to the 1.0 tag; features only as wave 5 A-tasks |
| R3 | The 2.0 platform swap (P01) breaks many files at once | medium | merge freeze | P01 runs alone, under a code freeze, after waves 0–3 have shrunk the files |
| R4 | Meta removes an insights metric across all versions | high in 2027 | broken reports | C05 stable schema in 1.0 |
| R5 | The SDK changes behaviour inside a minor | medium (2.4.0 did) | silent contract drift | Exact SDK pin now (R11, D-ARC-3); golden snapshots of `tools/list` and results (R10) |
| R6 | Adoption stays flat | high | wasted effort on the ambitious variant | V3-D1 gate; lean scope is the default |
| R7 | Meta ships an official Pages MCP | **high** — Meta shipped official Ads (2026-04-29), Social Technologies (2026-06-30) and WhatsApp (2026-09-15) MCPs | positioning loss | U-A5 response plan (V3-D16); differentiate on the write gate, boost composability and local-first; or consolidate |
| R8 | Spec removes something the server uses | low | forced change | Nothing used is on the 2026-07-28 deprecation list; verify logging in 2.x |
| R9 | Node 24 EOL passes without a 3.0 | low | unsupported runtime | 2028-04-30 is a hard deadline for wave 6 |
| R10 | A secret lands in a branch | low | credential leak | Staged-diff secret scan in every task's definition of done |
| R11 | Publish credential or repository governance is compromised | medium | a malicious version on npm | Rulesets on `main` and `v*`, `release` environment with owner approval (done 2026-10-30); delete `NPM_TOKEN`, OIDC only (U-A7, R15) |
| R12 | Single-maintainer bus factor | medium | the project stalls; credentials unrecoverable | Documented solo plan with recovery codes (D-OPS-4) |
| R13 | Live behaviour differs from the fakes | high (never run) | a stable contract frozen on a guess | U-A3 thin live pass now; U30a before 0.9; U30b fixture capture |
| R14 | Confused deputy via visitor UGC | medium | the Page speaks for an attacker | R02 (0.8.1), C08 taint latch, C09 per-plan confirmation |
| R15 | Privacy disclosure gap | medium | operator GDPR exposure, listing rejection | D08 `PRIVACY.md` before U-A2; C14 journal retention |
| R16 | Ads money semantics wrong | medium | unintended spend | R01 explicit `advantage_audience` (0.8.1); mandatory budget ceiling (SD-4); ads fixtures from U30b |
| R17 | Supply-chain publish without approval | low after 2026-10-30 | as R11 | The `release` environment gates `npm-publish`; every later job depends on it |
