# 11 — Parallel Task Breakdown (multi-agent work plan)

Written 2026-07-22. Decomposes the entire project into small tasks that can be
assigned to independent agents and developed **in parallel**. Every task has a
stable ID, an exclusive file-ownership set, explicit dependencies, and a
definition of done. This document is the dispatch board; the roadmap
([08-roadmap.md](08-roadmap.md)) still governs **verification and release**
order (live smoke gates), but development order is governed by the waves here.

**Key principle:** phases gate *verification*; waves gate *development*.
Wave-4 verticals (reader, posts, media, moderation, messages) are all
developed in parallel against contracts + fixtures; their live smokes still
run in phase order (1 → 2 → 3) on the test Page.

## Coordination rules (binding for every agent)

1. **Contract-first.** Wave 1 produces the shared TypeScript contracts and
   in-memory fakes. After Wave 1 merges, contracts are **frozen**: any change
   goes through the integration owner (I-tasks), never unilaterally.
2. **Exclusive file ownership.** Each task owns a disjoint file set (listed
   per task). An agent never edits files outside its set. Shared wiring files
   are owned **only** by integration tasks:
   `package.json`, `src/index.ts`, `src/tools/index.ts` (package wiring),
   CI workflow files (owned by F01, later R03).
3. **Registration convention.** Each tool package exports
   `export const PACKAGE: PackageSpec` from its own `src/tools/<pkg>.ts`.
   The integrator adds exactly one import line per package — no other file
   contention exists between verticals.
4. **Isolation.** Each agent works in its own git worktree/branch
   (`task/<id>-<slug>`). Merges happen per wave by the integration owner.
   Commits/pushes only when the user has asked (standing policy).
5. **Definition of done (common, every task):** `npm run check` green
   (typecheck + lint + format + tests) in the task's worktree; new code has
   colocated tests; coverage not lowered; no cross-layer imports (ESLint
   enforces `core ← api ← mcp ← tools`); every corner case listed in the
   task's Refs column has a test or an explicit deferral note in the PR
   description; no English-rule violations; no secrets in fixtures
   (fixture-lint).
6. **Fakes over mocks of neighbors.** A task depending on another task's
   contract uses the Wave-1 fakes (`fakeFbRequest`, `fakeRedactor`,
   `fakeClock`, `memoryJournal`), never a hand-rolled mock of a sibling's
   internals — this is what makes the merge cheap.
7. **Agent briefing template.** Each agent gets: (a) this file, (b) its task
   row + detail note, (c) the corpus sections in its Refs, (d) the
   corner-case IDs it must cover, (e) the file-ownership list. Nothing else
   is in scope for that agent.

## Task index

ID prefixes: **D** = docs (Wave 0), **U** = user-only gate, **F** =
foundation (Waves 1–3), **V** = vertical slice (Wave 4/6), **S** = smoke
harness, **R** = release (Wave 5), **I** = integration. Size: S ≈ small
focused session, M ≈ full session, L ≈ large session (consider splitting on
the fly).

## Wave 0 — corpus corrections (all parallel; one file per task)

Applies review actions A1–A16 (see [../reviews/SUMMARY.md](../reviews/SUMMARY.md))
and G-items (doc 10), grouped **by target file** so tasks never collide.

| ID | Task | Owns | Applies | Size |
|---|---|---|---|---|
| D01 | Update goals & scope | `docs/analysis/01-*.md` | A12 (scope note), A13, A16 (license), G-DOC-6 | S |
| D02 | Update market & positioning | `docs/analysis/02-*.md` | A14 (differentiators), A16 (naming procedure) | S |
| D03 | Update API landscape | `docs/analysis/03-*.md` | A3, A4, A8, A15 | M |
| D04 | Update auth & security | `docs/analysis/04-*.md` | A1 (threat model — largest), A3, A5, A10, G-DOC-4 | M |
| D05 | Update architecture | `docs/analysis/05-*.md` | A4–A7, A9, A10 (incl. no-ALS, 3 wire protocols, media file split) | M |
| D06 | Update tool catalog | `docs/analysis/06-*.md` | A6, A7, A11 (annotation quadruples — largest), A12, A13, G-TOOL-1/2/4/5 | M |
| D07 | Update risks & open questions | `docs/analysis/07-*.md` | A14 (Meta-MCP risk), close answered open questions (Q2 media, Q5 journal), fold ✎ items from docs 09/10 into the re-verify list | S |

D-tasks are documentation edits only; they follow English-only and keep each
doc's existing structure. A finding that spans files (e.g. A3) is applied by
each owning task **only within its own file**.

## User-only gates (not agent work; block later waves)

| ID | Gate | Blocks |
|---|---|---|
| U1 | Mint system-user token (or confirm Page-token fallback live) | F09 final verification, all smokes |
| U2 | npm name decision + availability check + Meta brand terms | R01, R03 |
| U3 | Repo visibility decision (+ MIT LICENSE confirmation) | R03 (provenance) |
| U4 | Create the dedicated **test Page** in the Business portfolio | S01, all write smokes |

## Wave 1 — scaffold & contracts (mostly sequential; the parallelism enabler)

| ID | Task | Owns | Depends | Refs | Size |
|---|---|---|---|---|---|
| F01 | Repo scaffold: package.json (ESM, engines ≥22), tsconfig, ESLint flat config with layer rules, prettier, `.nvmrc`, `.npmrc`, bin launcher, CI skeleton (22/24/26 + Windows leg, secret scanning, CodeQL, SHA-pinned actions), no install scripts | repo root configs, `.github/`, `bin/` | — | 05, DevOps §Majors | M |
| F02 | **Contracts + fakes**: public types for `Settings`, `FbRequestFn` (3 wire protocols incl. per-request timeout + AbortSignal), `GraphApiError`, `Redactor`, `Clock` (`now()`/`sleep()`), `PageResolver`, `ToolSpec`/`PackageSpec`, `Journal`, pagination types; in-memory fakes for each; the whole tree compiles with stub implementations | `src/core/types.ts`, `src/core/fakes/` (test-only), layer barrels | F01 | 05, C7, C14, G3 | M |
| F03 | Test harness: `withEnv`, `withFetch` + body-capture, fetch-thrower CI network fence, fixture-lint (no `EAA`), `scripts/record-fixture.mjs` skeleton, coverage config + floors 70/60/75 | `test/helpers/`, `scripts/record-fixture.mjs`, c8 config | F01 | QA §3/#7, C13 | M |

F02 is the single most leveraged task: everything after it builds against
these types. It must be reviewed against docs 05 + SUMMARY before the freeze.

## Wave 2 — core layer (parallel after Wave 1 merge)

| ID | Task | Owns | Depends | Refs | Size |
|---|---|---|---|---|---|
| F04 | Config/settings: env-first, XDG + `%APPDATA%`, atomic 0600 (Windows honesty), aggregated startup report, `FB_*` surface, settings = metadata SSOT shape | `src/core/config.ts`, `src/core/settings.ts` | F02 | CC-CFG-2/4/5, DevOps #2 | M |
| F05 | Logging (stderr JSON) + **value-based redaction choke-point** (token/secret/proof/pipe-token values; pattern scan as backup) | `src/core/log.ts`, `src/core/redact.ts` | F02 | C3, Sec #2, CC-CFG-1 refs | M |
| F06 | Errors: `GraphApiError`, **error→action matrix** (`{code, subcode}` → text + next tool; 190/460/463/467, 506, 368, throttle families 4/17/32/613 + 80000–80099, permission-missing, cursor-expiry), snapshot test | `src/core/errors.ts`, matrix table file | F02 | C2, C9, CC-NET-1/4, CC-AUTH-1/3/4 | M |
| F07 | `fbRequest` JSON protocol: Bearer auth, `appsecret_proof`, host allowlist, table-driven retry matrix (GET-vs-write discipline, never-retry-ambiguous), usage-header parsing (defensive), per-host semaphore | `src/core/http.ts` | F02 (fakes of F05/F06) | C2, C3, CC-NET-1..7 | L |
| F08 | `fbRequest` upload protocols: multipart FormData + raw-binary rupload (header auth, offset resume, chunk POSTs bypass generic retry), buffered chunking | `src/core/http-upload.ts` | F07 | C7, CC-MEDIA-2/3, QA #2 | M |
| F09 | Auth: `debug_token` type detection, per-page token resolver (derive → cache → invalidate-on-190 → re-derive once), `resolvePage(name?)` registry (no ALS), ambiguous-name refusal | `src/core/auth.ts`, `src/core/pages-registry.ts` | F02 | C1, C14, CC-AUTH-1..10 | M |
| F10 | Pagination helper: cursor in/out, `fetchAll` + page budget + `truncated`, empty-page-with-next handling, cursor-expiry partial results, fast-check termination property | `src/api/shared.ts` | F02 | CC-PAGE-1..5, UX #7 | M |

## Wave 3 — mcp layer (parallel after Wave 2 merge)

| ID | Task | Owns | Depends | Refs | Size |
|---|---|---|---|---|---|
| F11 | `defineTool`/registry + PACKAGES manifest + profile expansion (default = core+posts+reader+insights+moderation+messages; ads off), `FB_TOOL_PACKAGES`/`DENY`/`READONLY`, unknown-name errors, manifest snapshot test | `src/mcp/define.ts`, `src/mcp/registry.ts`, `src/mcp/packages.ts` | F02 | C5, CC-CFG-3, Arch nits (zod-v3 quarantine) | M |
| F12 | Result shaper: compact JSON, `FB_MAX_RESULT_CHARS` structure-aware truncation, **recursive paging/token-URL strip**, `structuredContent` for server-owned envelopes | `src/mcp/result.ts` | F05 | C3, CC-PAGE-4, CC-MCP-4, UX #11 | M |
| F13 | Write gating: tiered plan-and-apply (irreversible/spend never env-bypassed), `plan_id` binding, per-package defaults, apply-time re-validation (divergence diff), journal (structured, redacted, 0600, non-blocking, **rotation ~5 MB**) | `src/mcp/write-mode.ts`, `src/mcp/journal.ts` | F02, F05 | C4, Sec #3/#7, G-RUN-1, CC-LIFE-1/2 | L |
| F14 | Transports: stdio (stdout purity) + Streamable HTTP (fail-closed without `FB_HTTP_TOKEN`, Origin validation, 127.0.0.1), spawn-level stdout-purity test, clean shutdown + AbortSignal propagation | `src/mcp/transport.ts`, spawn test | F04 | C12, Sec #4, CC-CFG-1/6, CC-MCP-5 | M |
| F15 | Tainted-content envelope (UGC wrapper + injection warning) + out-of-band confirmation seam (elicitation-ready, operator-token fallback, never silently downgrades) | `src/mcp/taint.ts`, `src/mcp/confirm.ts` | F02 | B1, CC-MOD-8, CC-MCP-6 | M |
| F16 | Core package tools + doctor: `whoami` (incl. server version — G-TOOL-5), `list_pages`, `get_page`, `usage` (whoami/usage with `outputSchema`); doctor: token debug, permission×package matrix, credential + expiry report, metric-probe seam | `src/tools/core.ts`, `src/index.ts` doctor subcommand section | F06, F07, F09, F11 | 06 §core, CC-AUTH-4/9, CC-LIFE-4 | L |
| I1 | **Wave 1–3 integration**: merge order, contract-drift resolution, wire `src/index.ts` bootstrap, InMemoryTransport all-tools smoke, generic plan-mode no-write sweep | shared wiring files | all F-tasks | QA minors | M |

**Phase 0 exit gate** (roadmap) runs after I1: real-token doctor validation
(needs U1).

## Wave 4 — vertical slices (maximum parallelism: up to 9 agents)

Each vertical = `api/` module + `tools/` package + tests + fixtures + its own
smoke script under `scripts/smoke/`. File sets are disjoint by construction
(note: `api/media.ts` from doc 05 splits into three modules for ownership).

| ID | Task | Owns | Depends | Refs | Size |
|---|---|---|---|---|---|
| V01 | Reader: `list_posts` (edges param, ~600/yr + Reels-invisibility disclosure), `get_post`, `list_reels`, `get_reactions` | `src/api/posts-read.ts`, `src/tools/reader.ts`, fixtures | I1 | 06 §reader, CC-PUB-3, UX #4 | M |
| V02 | Insights: page/post insights, reshape contract (`aggregate`, row caps), doctor metric probe + generated metric table, rename-suggestion table, ≥100-likes + freshness notes; **Reels insights routing after G-TOOL-2 verification** | `src/api/insights.ts`, `src/tools/insights.ts`, fixtures | I1 | C6, CC-INS-1..6, G-TOOL-2 | L |
| V03 | Posts write: text/link/carousel create, scheduling (ISO-8601-offset-only, UTC+Page-TZ echo, 10min/75d/29d validation), `update_post` incl. lifecycle (publish-now/reschedule/cancel), `delete_post`, `list_scheduled_posts`, validating previews | `src/api/posts-write.ts`, `src/tools/posts.ts`, fixtures | I1 | CC-PUB-1..10, CC-SCHED-1..5, C4 | L |
| V04 | Media — photos: single + multi-photo (unpublished children + `attached_media`, orphan cleanup + orphan-ID reporting), `FB_MEDIA_DIR` realpath containment, remote-fetch hardening | `src/api/media-photos.ts`, fixtures | I1 | CC-MEDIA-4/5/10, C11 | M |
| V05 | Media — video: resumable upload state machine (in-memory sessions), `create_video_post`, `get_video_status`, progressToken wiring | `src/api/media-video.ts`, fixtures | I1, F08 | CC-MEDIA-1/2/3/7, CC-MCP-1/2 | L |
| V06 | Media — Reels: 3-phase flow, 30/24h budget error mapping, DRAFT/SCHEDULED states, lifecycle verification (delete path, scheduled visibility — G-TOOL-3) | `src/api/media-reels.ts`, fixtures | I1, F08 | CC-MEDIA-8/9, G-TOOL-3 | M |
| V07 | Moderation: `list_comments`, `get_comment` (G-TOOL-1), reply, hide/unhide, delete, `private_reply` (one-shot/7-day mapping), block/unblock, bulk `ids ≤50` per-ID outcomes, taint envelope on all UGC | `src/api/comments.ts`, `src/tools/moderation.ts`, fixtures | I1, F15 | CC-MOD-1..8, G-TOOL-1 | L |
| V08 | Messages: `list_conversations` (`platform=messenger` pinned — G-RUN-2), `get_conversation` (+`mark_seen` param if G-TOOL-4 approved), `send_message` (24h mapping, unknown-outcome error, optional dedupe), attachment placeholders, taint envelope | `src/api/messaging.ts`, `src/tools/messages.ts`, fixtures | I1, F15 | CC-MSG-1..6, G-RUN-2, G-TOOL-4 | L |
| S01 | Smoke harness: runner (`FB_SMOKE=1`, outside test glob), `[FBMCP-SMOKE nonce]` marker convention, start/end sweeper, per-vertical smoke registration API | `scripts/smoke/` harness files | I1, U4 | B2, CC-LIFE-3 | M |

The three media tasks (V04–V06) plus V03 converge in the **posts** tool
package; `src/tools/posts.ts` is owned by V03, which consumes the api modules
of V04–V06 through their Wave-1-shaped contracts (media api signatures are
added to F02's types during I1, before Wave 4 dispatch).

**Live smoke order stays phased:** V01+V02 smokes = Phase 1 gate; V03–V06 =
Phase 2 gate; V07+V08 = Phase 3 gate. Development of all nine can proceed
concurrently.

## Wave 5 — distribution & 1.0 (parallel after Wave 4 merge + dogfood)

| ID | Task | Owns | Depends | Refs | Size |
|---|---|---|---|---|---|
| R01 | Metadata SSOT: `gen-metadata.mjs` feeding package.json/server.json/MCPB manifest/`.claude-plugin/`/README+.env.example, CI drift test, version assertions | `scripts/gen-metadata.mjs`, generated targets | U2, I1 | DevOps #2 | M |
| R02 | Docs: generated README tool + metric tables, `.env.example` sync test, comparison table + Meta-ads-MCP signposting, client compat matrix (G-DOC-5), scope enumeration (G-DOC-6) | `README.md`, `.env.example`, gen script | R01 | PM #2, G-DOC-5/6 | M |
| R03 | Release rail: tag-driven CI-only publish, npm Trusted Publishing OIDC, provenance, `.mcpb` pack + SHA-256, `mcpName` in first publish, `mcp-publisher` (github-oidc, pinned) | `.github/workflows/release.yml`, MCPB config | U2, U3, R01 | DevOps #6, minors | L |
| R04 | Hygiene + runbooks: CONTRIBUTING, issue/PR templates (require `--version` + doctor output), support statement, no-telemetry statement, SECURITY.md (guarantees + disclosure + supported versions), `docs/runbooks/` (rotation/kill-switch, uninstall/offboarding, Data Use Checkup + changelog cadence, operator-window) | those files | — (docs-only; parallel with R01–R03) | G-DOC-1..4, PM #2/#7 | M |
| R05 | `setup-token` subcommand: Explorer→exchange→Page-token quickstart, 0600 env write; onboarding doc | `src/index.ts` subcommand section (coordinated with I2), setup docs | I1 | PM #3 | M |
| I2 | **1.0 integration**: final wiring, Phase 4 exit gate execution (`npx` cold start macOS+Windows, non-author onboarding ≤20 min), tag `1.0.0` (on user instruction) | shared wiring files | all R-tasks | 10 §1 | M |

## Wave 6 — ads (1.1; after 1.0 ships)

| ID | Task | Owns | Depends | Refs | Size |
|---|---|---|---|---|---|
| V09 | Ads read: campaign/adset/ad listings + `get_ad_object`, `effective_status` truth, insights (sync + async job tool, terminal states), account-status doctor check | `src/api/ads-read.ts`, `src/tools/ads.ts` (read half), fixtures | I2 | CC-ADS-1/2/5/6 | L |
| V10 | Ads control: status pause/resume + budget changes (minor units, irreversible-tier gating, `FB_ADS_BUDGET_CEILING`), ads smoke (belt-and-braces) | `src/api/ads-control.ts`, `src/tools/ads.ts` (control half — coordinate with V09 owner or same agent), fixtures | V09 | CC-ADS-3/4/7, A12 | M |

V09 and V10 share `src/tools/ads.ts` — assign to the same agent or run
sequentially; they are listed separately because read can ship without
control if 1.1 needs to split.

## Dependency graph (summary)

```
Wave 0: D01..D07  (all parallel; no code dependencies)
U1..U4  (user; U1 before Phase-0 gate, U4 before smokes, U2/U3 before Wave 5)

F01 ──► F02 ──► { F04 F05 F06 F07 F09 F10 }      (Wave 2, parallel)
   └──► F03          F07 ──► F08
{Wave 2} ──► { F11 F12 F13 F14 F15 } ──► F16 ──► I1   (Wave 3)
I1 ──► { V01 V02 V03 V04 V05 V06 V07 V08 S01 }        (Wave 4, parallel)
{Wave 4 + dogfood} ──► { R01 R02 R03 R04 R05 } ──► I2 = v1.0.0
I2 ──► V09 ──► V10 = v1.1.0
```

Critical path: F01 → F02 → F07 → F08 → I1 → V05 (video) → Phase 2 smoke.
Maximum concurrent agents: 7 (Wave 0), 6 (Wave 2), 5 (Wave 3), 9 (Wave 4),
5 (Wave 5).

## Dispatch checklist (per wave)

1. Confirm the wave's dependencies are merged and `npm run check` is green on
   the integration branch.
2. Spawn one agent per task with the briefing template (rule 7).
3. Agents work in isolated worktrees; no shared-file edits (rule 2).
4. Integration owner merges in dependency order, resolves contract drift,
   runs the wave's integration checks, then the roadmap gate if one applies.
5. Update WORKLOG per wave (not per task).
