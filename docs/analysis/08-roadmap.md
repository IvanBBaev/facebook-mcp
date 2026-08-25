# 08 — Implementation Roadmap (v2)

Revised 2026-07-22 after the seven role reviews. v1 phases survive, but every
phase now carries: entry conditions, deliverables, corner cases it must cover
(from [09-corner-cases.md](09-corner-cases.md)), and an exit gate. Phases are
gates, not sprints: each ends with `npm run check` green and — where applicable
— a live smoke against the **test Page** (never the production Page for writes;
see Smoke Safety Protocol below). Findings referenced as B/C/A numbers come
from [../reviews/SUMMARY.md](../reviews/SUMMARY.md). Version mapping (which
phase exit becomes npm `1.0.0`) and the additive G-items per phase are defined
in [10-v1-release-definition.md](10-v1-release-definition.md) — its §6 table is
part of each phase's scope.

**Execution model:** this roadmap governs *verification and release* order
(gates, live smokes). *Development* order is governed by
[11-parallel-task-breakdown.md](11-parallel-task-breakdown.md), which
decomposes every phase into small tasks with exclusive file ownership so
multiple agents can work in parallel; phase scopes below map to its waves
(Phase 0 = Waves 1–3, Phases 1–3 = Wave 4 verticals, Phase 4 = Wave 5,
Phase 5 = Wave 6).

## Smoke Safety Protocol (binding for all phases — B2)

1. All write smokes run against a **dedicated test Page** in the same Business
   portfolio. The production Page is read-only smoke territory; insights smoke
   stays on production (≥100-likes floor).
2. Writes are unpublished/DRAFT-only, or far-future scheduled + verified
   deletion.
3. Every smoke artifact carries `[FBMCP-SMOKE <nonce>]`; a sweeper deletes
   marked artifacts at the start **and** end of every smoke run (CC-LIFE-3).
4. Ads smoke: precondition on account spending limit, force `PAUSED`, re-read
   `effective_status`, set `spend_cap`, delete in `finally`.
5. Reels smoke consumes the 30/24h budget — run deliberately, not in loops.
6. Smokes live in `scripts/smoke/` behind `FB_SMOKE=1`, outside the test glob;
   CI never runs them and never holds a token (C13).

## Phase −1 — Day-0 gates (no code until all four are green)

| Gate | Action | Source |
|---|---|---|
| G1 | Mint the real system-user token, or confirm the Page-token fallback path empirically | C1 |
| G2 | Verify npm name availability (`facebook-mcp-ai`; fallback `@ivanbbaev/facebook-mcp`); check Meta brand terms; decision recorded in 02 | C8 |
| G3 | Decide the clock seam: injectable `now()`/`sleep()` through `core` | QA #6 |
| G4 | Repo visibility decision (npm provenance requires public before first tag); license = MIT, LICENSE file at repo root | DevOps, PM |

Also before code: apply the corpus updates A1–A16 from SUMMARY.md so the
implementation starts from a corrected corpus (dispatched as parallel tasks
D01–D07 in doc 11's Wave 0).

## Phase 0 — Skeleton & quality rails

**Entry:** Phase −1 gates green; corpus updated.

- Repo scaffolding: package.json (ESM, 3 runtime deps, `engines >=22`),
  tsconfig, ESLint flat config with layer-boundary rules, prettier, `.nvmrc`,
  `.npmrc`, bin launcher. No install scripts, ever (DevOps).
- `core/`: settings (the metadata SSOT feeding all five surfaces via
  `gen-metadata.mjs` + drift test), config (env-first, XDG + `%APPDATA%`
  fallback, atomic 0600 with Windows honesty — CC-CFG-4), logging (stderr
  JSON), errors (`GraphApiError`, error→action matrix table, snapshot-tested —
  C9), host allowlist (CC-NET-7), **value-based redaction choke-point** (C3),
  `fbRequest` covering all three wire protocols (JSON/query, multipart,
  raw-binary rupload — C7) with `appsecret_proof`, Bearer auth, table-driven
  retry matrix (C2, CC-NET-1/5), usage-header parsing (CC-NET-2), clock seam
  (G3).
- `core/auth`: per-page token resolver (derive → cache → invalidate-on-190 →
  re-derive once — C1, CC-AUTH-1/6/7); `debug_token` type detection
  (CC-AUTH-2); no AsyncLocalStorage (C14).
- `mcp/`: define/registry/result-shaper (paging-strip invariant — CC-PAGE-4)/
  redact/transport; PACKAGES manifest with the **default profile expansion**
  `core+posts+reader+insights+moderation+messages` (C5, CC-CFG-3); tiered
  write-mode gate (irreversible/spend never env-bypassed — C4); tainted-content
  envelope + OOB confirmation seam (B1, CC-MCP-6); write journal through the
  redactor, 0600, never blocking (CC-LIFE-1).
- Test harness: `withEnv`, `withFetch` + body-capture helper, fetch-thrower CI
  network fence (C13), manifest snapshot test, adversarial redaction suite,
  **spawn-level stdout-purity test** (C12, CC-CFG-1), retry-decision table
  test, error-matrix snapshot, coverage floors + ratchet (proposed 70/60/75;
  **shipped at 95 lines / 85 branches / 95 functions / 95 statements** in
  `.c8rc.json` after the ratchet), CI matrix
  Node 22/24/26 + Windows leg, secret scanning + push protection, CodeQL,
  dependabot, SHA-pinned actions.
- Doctor v1: token debug, permission×package matrix (CC-AUTH-4), active
  credential + expiry report (CC-AUTH-9, CC-LIFE-4), aggregated env report
  (CC-CFG-2).

**Corner cases in scope:** all AUTH, CFG, NET; CC-PAGE-4; CC-LIFE-1/2.

**Exit gate:** server starts over stdio (stdout pure), registers `core`
package (`facebook_whoami`, `facebook_list_pages`, `facebook_get_page`,
`facebook_usage` — whoami/usage carry `outputSchema`), doctor validates the
real token end-to-end. npm name reserved (C8).

## Phase 1 — Reading & insights

**Entry:** Phase 0 gate green.

- `api/pages.ts`, `api/posts-read.ts`, `api/insights.ts`; cursor pagination
  helper with `fetchAll` + `truncated` (CC-PAGE-1/2/3/5, fast-check
  termination property).
- Tools: `reader` + `insights` packages. Insights: doctor metric probe →
  generated README metric table; description carries current metric set +
  rename-suggestion table (C6, CC-INS-1); reshape contract with `aggregate`
  and row caps (CC-INS-4); ≥100-likes and freshness notes (CC-INS-2/6).
- Media/Reels **spike** (PM minor): one manual resumable upload + one Reel
  against the test Page to de-risk Phase 2's hardest flow early.

**Corner cases in scope:** all INS, all PAGE.

**Exit gate:** live smoke — list real posts (production, read-only), read one,
pull two live-verified metrics without errors; metric table generated;
period-boundary behavior recorded (CC-INS-5 ✎).

## Phase 2 — Publishing (the flagship)

**Entry:** Phase 1 gate green; test Page exists and sweeper works.

- `api/posts-write.ts`, `api/media.ts` (photo, multi-photo with child cleanup
  — CC-MEDIA-10, resumable video with in-memory session state — CC-MEDIA-1/2/3,
  Reels state machine — CC-MEDIA-8/9), `facebook_get_video_status`
  (CC-MEDIA-7 — **shipped**: API function and tool both landed, in the
  write-gated `posts` package), scheduling with ISO-8601-offset-only input
  (CC-SCHED-1/2/3).
- Tools: `posts` package with validating-dry-run previews (C4), plan_id
  binding on delete, scheduled lifecycle (publish-now/reschedule/cancel via
  `update_post` — CC-SCHED-5), annotation quadruples explicit (A11).
- `FB_MEDIA_DIR` disabled-by-default + realpath containment (C11, CC-MEDIA-5);
  remote fetch hardening (CC-MEDIA-4).
- Progress notifications via `progressToken` (CC-MCP-1); cancellation =
  ambiguous outcome (CC-MCP-2).
- Stories: verify feasibility now or declare out-of-scope and soften the
  "full surface" claim (A13, PM #5 ✎).

**Corner cases in scope:** all PUB, MEDIA, SCHED; CC-MCP-1/2.

**Exit gate:** live smoke on the **test Page** — draft, scheduled (far-future,
then rescheduled, then published-now, then deleted — the full CC-SCHED-5
round-trip), photo post, one Reel; edit + delete; publish-state matrix
recorded (CC-PUB-9 ✎); sweeper leaves the Page empty.

## Phase 3 — Moderation & messaging

**Entry:** Phase 2 gate green; Messenger changelog re-pulled (CC-LIFE-5).

- `api/comments.ts`, `api/messaging.ts`; private-reply one-shot/7-day and
  24h-window semantics (CC-MOD-2, CC-MSG-1); tag sends never silently
  substituted. **Shipped stricter than proposed:** the plan said "error mapping
  only — no client-side windows", but both windows are now checked client-side
  *before* anything leaves the process — a >7-day comment is refused as
  `window_closed` and a closed messaging window is refused on every call,
  including an `apply` that follows a still-valid preview. Spending the single
  private reply, or messaging a person outside the window, is not worth a round
  trip to find out.
- Tools: `moderation` (bulk `ids ≤50` with per-ID outcomes — CC-MOD-5,
  hide/unhide + block/unblock symmetry — CC-MOD-7, apply-by-default per-package
  write mode — C4) + `messages` (trio negative-space descriptions — CC-MSG-4,
  {destructive, non-idempotent} annotations + unknown-outcome error text —
  CC-MSG-2, stateless `since` snapshots — CC-MSG-5, attachment placeholders —
  CC-MSG-6).
- Tainted-content envelope live on all UGC-returning tools (B1, CC-MOD-8);
  read-only-profile guidance in README.

**Corner cases in scope:** all MOD, MSG.

**Exit gate:** live smoke on a test-Page post's comments (reply, hide,
unhide, delete); conversation list + read; reply-depth behavior recorded
(CC-MOD-4 ✎). `send_message`/`private_reply`/`block_user` are marked
live-unverifiable — operator-window runbook executed once manually (QA); the
runbook lives at [`../runbooks/operator-window.md`](../runbooks/operator-window.md).

## Phase 4 — Distribution

**Entry:** Phase 3 gate green; **dogfood period done** — 2–4 weeks of the
author using Phases 1–3 weekly on the real Page (PM minor).

- README (generated tool tables + metric table), `.env.example` + env-docs
  sync test, SECURITY.md (trust guarantees — PM #2), CHANGELOG.md, comparison
  table + honest signposting to Meta's ads MCP.
- `setup-token` helper subcommand (Explorer→exchange→Page-token quickstart —
  PM #3).
- Release rail: tag-driven CI-only publish, npm Trusted Publishing OIDC,
  provenance (repo public first), `.mcpb` + SHA-256 checksums, `mcpName` in
  the first publish, `server.json` + `mcp-publisher` (github-oidc, pinned
  binary), `.claude-plugin/` manifests — all from the metadata SSOT.
  **Shipped stricter than proposed:** the pinned `mcp-publisher` is verified
  against a SHA-256 committed to *this* repo rather than against the checksum
  file published beside the binary (a checksum fetched over the channel it
  polices proves nothing), and the `.mcpb` bundle carries a build-provenance
  attestation that is re-verified with `gh attestation verify` before the asset
  is attached to the Release — so both shipped artifacts, not just the npm
  tarball, are traceable to this repository's workflow.

**Exit gate:** `npx -y <pkg>` cold-start works in Claude Desktop/Code on
macOS + Windows; a non-author completes onboarding in ≤20 min (PM #3).

## Phase 5 — Ads (rescoped: read + status/budget control — A12)

**Entry:** Phase 4 shipped; spending limit set on the ad account.

- `api/ads.ts`: campaign/adset/ad **read** + insights (sync with async
  fallback — CC-ADS-5) + status changes + budget changes (minor units —
  CC-ADS-3; irreversible-tier gating + `FB_ADS_BUDGET_CEILING` — CC-ADS-7).
  Create-chain, creative upload, custom audiences all deferred.
- Tools: `ads` package, off by default (C5); `effective_status` truth
  (CC-ADS-2); account-status doctor check (CC-ADS-6).

**Corner cases in scope:** all ADS.

**Exit gate:** live smoke — read the real account's campaign tree + insights;
pause/unpause one **already-paused test campaign**; budget change refused
above ceiling; belt-and-braces protocol observed.

## Post-launch checkpoints

- **+4 weeks cadence:** Meta changelog check (CC-LIFE-5); fixture shape-diff
  on any `FB_API_VERSION` bump.
- **+90 days:** adoption checkpoint (≥100 weekly downloads / ≥25 stars / ≥3
  non-author issues) — else pre-committed downgrade to personal tool, minimum
  maintained core = `core+reader+posts+insights` (PM #4/#7).

## Deferred / future (unchanged decisions recorded in SUMMARY §D)

Batch API; MCP Tasks (durable upload state); elicitation as confirm channel
(seam ships in Phase 0, feature later); custom audiences; HUMAN_AGENT;
IG/Threads; webhook relay; OAuth/URL-elicitation flow; SDK v2 migration;
ads create-chain + image upload; client-side Reels A/V validation (dropped);
client-side quota enforcement (dropped).
