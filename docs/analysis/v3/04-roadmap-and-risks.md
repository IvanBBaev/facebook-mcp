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

## 4. Response to an official Meta MCP (U-A5)

Pre-written response for risk R7, decided as V3-D16 B (2026-10-30). It is written now so that the
project does not decide under pressure when the announcement lands.

### 4.1 What survives an official Pages MCP

Each item is something a hosted, first-party server is unlikely to offer. Positioning leads with
this list today, not after an announcement.

| # | Survivor | Where it lives today |
|---|---|---|
| S1 | Plan/apply write gate: every write previews first; free-text and spend writes apply only with the `plan_id` that binds the previewed parameters | `src/mcp/write-mode.ts`, `executeWrite` (R02 made reply, comment and edit plan-first) |
| S2 | Local write journal: an audit trail of every attempted, applied and failed write on the operator's machine | `src/mcp/journal.ts` |
| S3 | Local-first: the Page token stays on the operator's machine; no hosted party sees tokens, content or insights | `PRIVACY.md` |
| S4 | Boost composability: post → boost → targeting edit → copy in one conversation, with explicit Advantage+ and creative-enhancement settings | `src/api/ads-*.ts` (R01) |
| S5 | Local media: photos, videos and reels from disk, with resumable upload sessions | `src/api/media-*.ts`, `src/api/upload-session.ts` |
| S6 | Multi-Page profiles under one configuration | `FB_PROFILE_<NAME>_*` settings |
| S7 | A stable insights schema that survives Meta's metric deprecations | `src/api/insights-schema.ts` (C05) |
| S8 | An error matrix that tells the operator the next step, not only the Graph error code | `src/core/` error mapping |
| S9 | Scriptability: stdio server plus CLI; no browser OAuth flow | `src/cli/` |

### 4.2 Trigger

Any one of these starts the response:
- Meta announces an official MCP server that covers Facebook Pages, or Business Messaging for Pages,
  in beta or GA;
- an official Meta MCP that already exists adds Page posts, comments or insights tools.

The monthly watch-list check (§2) looks for both.

### 4.3 Pre-committed actions

| Step | When | Action |
|---|---|---|
| A1 | within 1 week | Map the official tool list against ours. For each of our tools, mark it as strictly worse, equal or better. Record the result in a new `docs/analysis/` note. |
| A2 | within 2 weeks | Add a README section "Use Meta's server when … / use this one when …", built from §4.1 and the A1 map. |
| A3 | within 2 weeks | Deprecate every tool that A1 marks strictly worse, following the deprecation policy (removal only in a major release). |
| A4 | within 4 weeks | Re-run V3-D1 (lean or ambitious scope) with the A1 map as input. The default is to re-scope as the developer-operator safety layer: S1–S3 in front of any Graph write. |
| A5 | at the V3-D1 re-run | If the adoption gate (PM-04) has failed, switch to personal-tool mode: keep the repo public and maintained for the owner's own Page, and stop listings and announcements. |

### 4.4 What we do not do

- We do not race the official server on tool count.
- We do not wrap or proxy Meta's MCP before A1 shows it is worth doing.
- We do not drop a survivor in §4.1 to simplify the code base.
