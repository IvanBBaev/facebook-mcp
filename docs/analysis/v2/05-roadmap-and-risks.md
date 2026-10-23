# 05 — Roadmap and risks

Dates are targets, not commitments. Each phase ends with the full gate (`npm run check`,
`metadata:check`, `smoke:rehearse`, cold-start) and a tag via the
[release runbook](../../runbooks/release.md).

## 1. Phases

| Phase | Window | Content | Exit |
|---|---|---|---|
| **P0 — Now** | 2026-10-24 → 10-31 | Answer PR #41 (D7 option A), close PR #40; check that nothing uses the removed Graph root `GET /?ids=`; correct doc 12 (v24 sunset 2026-11-10, tier renames); cut a 0.8.0 release; submit to PulseMCP | Release on npm + registry |
| **P1 — Contract freeze prep** | 2026-11 | [01-fix-before-1.0.md](01-fix-before-1.0.md) F1–F12 and decisions D4–D6. Pre-1.0, so breaking changes are allowed and each gets a CHANGELOG line | Manifest snapshot reflects the frozen contract |
| **P2 — 1.0 live gate** | 2026-11 → 12 | Existing [roadmap](../08-roadmap.md) live verification, plus: CC-INS-5 boundary probe, G-TOOL-3, Graph fixture recording, the open probes in §3 that 1.x/2.0 depend on | **1.0.0** |
| **P3 — 1.1 ads on** | 2026-12 | F14 (ads multi-account model), [02 §2](02-v1x-backlog.md) A1–A6 | **1.1.0** |
| **P4 — 1.x minors** | 2026-12 → 2027-01 | Organic backlog O1–O6 as demand shows; deprecation warnings for every §2 removal in [03](03-v2-scope.md) | 1.2+ |
| **P5 — 2.0 platform** | 2027-01 | SDK v2 + zod 4 + spec 2026-07-28 with legacy fallback; stateless HTTP; MRTR confirm seam; Node 24 floor; removals; insights contract as the only contract | **2.0.0** before SDK v1 fixes end (≈ late January 2027 at the earliest) |
| P6 — 2.x features | 2027-02 → | Report tool, boost-post chain (D3), profile management — each as a minor on top of 2.0 | 2.1+ |

Feature headlines are deliberately placed **after** 2.0.0: they are additive, and coupling them
to the forced platform migration would put the SDK deadline at risk. The only exception is the
insights contract, whose removal half is breaking.

If D1 ends in "personal tool", P4 and P6 shrink to bug fixes and Graph upkeep; P5 still happens,
because the SDK deadline applies regardless.

## 2. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| SDK v1 fixes end before 2.0 ships | Medium | High (unpatched protocol layer) | P5 starts in January at the latest; codemod first; stateless HTTP tests written before the switch |
| zod 4 / SDK v2 schema diff larger than measured | Medium | Medium | `tools/list` snapshot diff reviewed and documented in the CHANGELOG; no behaviour change because `parseAsync` still runs |
| Non-Anthropic clients lag on 2026-07-28 | High | Medium | Keep the legacy handshake and push-elicitation shim through 2.x; keep `FB_CONFIRM_TOKEN` |
| Meta ships an official Pages MCP | Medium | High | Lean v2; lead with insights correctness and the local plan/apply gate, which a hosted server does not offer |
| oliverames/meta-mcp-server keeps outgrowing us (≈140 vs ≈54 npm/week) | High | Medium | Compete on correctness and safety, not tool count |
| Only external contributor leaves | Medium | High (only real user signal) | D7 this week |
| Graph churn (retired metrics, v25 field removals) | High | Medium | Rename table + doctor probes; recorded fixtures per Graph version; changelog check every Meta release |
| Create-chain money risk (if D3 = B) | Low | High | Paused by construction; one spend path; mandatory campaign `spend_cap`; worst-case envelope in the plan; live smoke on an account with a spending limit |
| Feature-gate ambiguity at Standard Access (Live, Human Agent, webhooks for non-role users) | — | Medium | Nothing in 2.0 depends on them; probe before any later investment |

## 3. Open live probes

| # | Question | Needed for |
|---|---|---|
| L1 | Insights boundary semantics (CC-INS-5) on a real Page | D4, 1.0 |
| L2 | Minimum permission / Page task for `object_story_id` creatives | D3 |
| L3 | v26 creative-enhancement defaults and exact `creative_features_spec` JSON | D3 |
| L4 | Status/budget write on a legacy ASC/AAC campaign — rejected, with which subcode | A5 |
| L5 | Whether Ads Manager can unarchive | A4 wording |
| L6 | Page Stories maximum length (60 s vs 90 s) | O1 |
| L7 | Permission for `POST /{page-id}` profile updates | §3.4 profile management |
| L8 | Standard-Access `pages_messaging` to non-role customers | Shipped Messenger tools (1.0 live pass) |
| L9 | IG: System User token with `instagram_*` scopes; whether `image_url` accepts a Page photo's fbcdn URL; quota 100 vs 50 | D2 option A only |
