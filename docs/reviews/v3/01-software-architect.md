# V3 review 01 — Software architecture

| | |
|---|---|
| Role | Senior software architect / principal TypeScript-Node engineer (independent, adversarial) |
| Date | 2026-10-29 |
| Scope | `@ivanbaev/facebook-mcp` 0.8.0, 69 tools, commit `2c8d8bd` on `main`; roadmap `docs/analysis/v3/` (README, 01, 04, 05) |
| Prior review | `docs/reviews/01-software-architect.md` (2026-07-21, pre-code, 16 findings) |
| Method | Read the layer boundaries (`eslint.config.js`), the contract files (`src/core/types.ts`, `src/mcp/define.ts`, `src/server/*`), the HTTP stack (`src/core/http.ts`, `src/core/http-upload.ts`), the write path (`src/mcp/write-mode.ts`, `src/tools/shared.ts`) and the media lane (`src/api/media-*.ts`, `src/api/upload-session.ts`). Scripted a cross-lane import graph over `src/{api,tools}` mapped onto the doc 05 lanes. Grepped tool-name literals, duplicated helpers and SDK coupling points. Checked every claim in doc 05 §1, §4–§7 and §11 against the code. I trust no roadmap statement that I could not reproduce. |

## 1. Verdict

**Sound-with-changes.**

1. **The runtime architecture is good.** It has six lint-enforced layers, one typed `FbRequest` union for three wire protocols, an injected `ToolContext`, and a plan/apply write gate with a journal. The SDK coupling is already confined to `src/server/`.
2. **The roadmap's parallel model (doc 05) is not yet safe.** Its cross-lane dependency list (§1 rule 7) names 4 edges; the code has about 16. Shared media-source security code lives inside the `posts` lane.
3. **Wave 0 left debt.** X06 shipped a 613-line `upload-session.ts` (plus a 975-line test) that nothing imports. The duplication it was meant to remove is now one copy larger. Its adoption is buried inside the already L-sized L2.posts.
4. **The write gate is outside the type contract.** `ToolContext` has no `writeGate`; tools fetch it through a runtime cast. The only generic plan-mode test runs zero write tools.
5. **Wave 4 is mis-scoped.** P01 freezes "everything" for a swap that touches about 4 files. Meanwhile P02 (stateless HTTP) is sequenced before P03 (MRTR confirm) and before A04 (ports), even though stateless transport breaks elicitation-based confirmation.

Counts: **0 Blocker, 6 Major, 9 Minor, 3 Nit** (18 findings).

## 2. Status of the 2026-07 review findings

| # | 2026-07 finding (sev) | Status | Evidence |
|---|---|---|---|
| 1 | Page-token resolver: derive, cache, invalidate on 190 (Major) | **Resolved** | `src/server/handlers.ts:218-220` invalidates every page resolved during the call; `PageResolver` port in `src/core/types.ts` |
| 2 | No ambient context (ALS); page as an explicit param (Major) | **Resolved** | `handlers.ts:182-197` builds the per-call ctx; `extractProfile` at `handlers.ts:298` |
| 3 | Token in `paging.next`; use Bearer (Major) | **Resolved** | Bearer per `src/core/http.ts:11-14`; `access_token` scrub in `src/mcp/result.ts:8-11,73,80,161` |
| 4 | Three wire protocols need one client (Major) | **Resolved** | `FbRequest` json/multipart/rupload union; `FbRequestDeps.uploadHandler` (`http.ts:96`) delegates to `http-upload.ts` |
| 5 | Progress notifications and resumable uploads (Major) | **Partial** | `progressReporterFor` (`handlers.ts:180`); upload sessions in memory only (`src/api/media-video.ts:109` TTL 1 h, `:253` registry). Durable uploads deferred to A05 (2.x) |
| 6 | Write retry and ETA cap (Major) | **Resolved** | `retryVerdict` ambiguous class (`http.ts:488`), cap 60 s (`http.ts:128-130`) |
| 7 | Plan mode = zero mutations (Minor) | **Open (test is vacuous)** | `src/index.test.ts:321-353` sweeps only the `core` package and asserts `writeTools.length === 0` (`:335`); no write tool is exercised in plan mode generically |
| 8 | Profile `core` vs package `core` name collision (Minor) | **Open** | Planned as I30 (doc 05 line 222) |
| 9 | Client-side quota enforcement (Minor) | **Partial** | Reels quota is a note constant (`src/api/media-reels.ts:129`), not enforced |
| 10 | Video status tool (Minor) | **Resolved** | `getVideoStatus` (`media-video.ts:1631`), `facebook_get_video_status` |
| 11 | Batch API (Minor) | **Partial** | Only insights uses it (`src/api/insights-batch.ts`) |
| 12 | Strict `outputSchema` (Minor) | **Open** | Declared on 3 tools; C03 expands it — see ARC-14 |
| 13 | Messaging poll state (Minor) | **Resolved differently** | Server-side cursor store `ActivityCursorStore` (`handlers.ts:61`) |
| 14 | Logging capability; sessionless HTTP (Minor) | **Open** | `capabilities: { tools: {} }` (`handlers.ts:99`); `sessionIdGenerator: () => randomUUID()` (`src/mcp/transport.ts:322`) |
| 15 | Tests run against the build (Nit) | **Open, accepted** | `package.json` `test` and `coverage` scripts run `build/**/*.test.js` |
| 16 | Zod quarantine (Nit) | **Regressed** | `src/mcp/define.ts:12` still claims "Zod-v3 RUNTIME usage is deliberately quarantined to this file", but zod runtime is imported in about 34 `src/tools` files, `src/server/schema.ts:12` and 2 `src/mcp` files |

Net: 7 resolved or resolved differently, 4 partial, 4 open, 1 regressed. Nothing that was resolved has slipped back except the zod quarantine claim.

## 3. Strengths to keep

- **Layer enforcement as code.** `eslint.config.js:12-52` uses `import-x/no-restricted-paths` zones with a string-glob twin. Wave 0 added the `server` zone, so the dependency direction is machine-checked, not reviewed.
- **SDK isolation.** Only `src/server/schema.ts:5-12` and `src/server/handlers.ts:5-6` import `@modelcontextprotocol/sdk` for the tool surface. `toMcpTool` / `toCallToolResult` (`schema.ts:57-92`) are the only projection points, so the SDK v2 swap has a natural seam.
- **One HTTP choke point.** `createFbRequest` (`http.ts:1208`) owns auth, `appsecret_proof`, host semaphores, retry verdicts, usage headers and version drift. The header invariants (`http.ts:1-39`) are written down and tested (`http.test.ts`, 3,417 lines).
- **Explicit error data.** `ERROR_MATRIX` has frozen membership, and `src/core/error-matrix.test.ts:193-210` cross-checks matrix rows against the transport's throttle set. This is the pattern to copy for the other cross-file invariants below.
- **Honest write envelopes.** `applyPayload` (`src/tools/shared.ts:472-520`) separates applied / not_applied / attempted / diverged, and the wording changes when the journal append fails.
- **Log hygiene by allowlist.** `allowlistedLogFields` (`handlers.ts:266-284`) logs only scalars and redacts even allowlisted values.
- **Expand-only discipline worked.** Wave 0 merged with `tools/list` byte-identical to 0.8.0 (doc 05 §11, line 377).

## 4. Findings (by severity)

### ARC-01 — Doc 05 lane graph is incomplete; shared media-source security lives in the `posts` lane — **Major**

- **Evidence.** Doc 05 §1 rule 7 (`docs/analysis/v3/05-parallel-task-breakdown.md:60-67`) lists 4 cross-lane imports. A scripted import scan of `src/api` and `src/tools`, mapped onto lanes, finds these undocumented edges:
  - ads → posts:
    - `src/api/ads-media.ts:25-26` → `media-photos.ts`;
    - `src/tools/ads/image.ts:20-21` → `media-photos.ts`.
  - messages → posts: `src/tools/message-attachment.ts:7` → `media-photos.ts`.
  - moderation → posts: `src/tools/moderation/replies.ts:16` → `media-photos.ts`.
  - moderation → messages:
    - `src/api/comments.ts`, `src/api/comment-triage.ts` and `src/tools/moderation/private-reply.ts` → `src/api/messaging.ts`;
    - `private-reply.ts` → `message-attachment.ts`.
  - reader → messages and moderation: `src/api/activity.ts` → `messaging.ts`, `comments.ts`.
  - reader → posts: `src/tools/reader.ts` → `albums.ts`, `stories.ts`.
  - insights → reader: `src/api/page-report.ts` → `posts-read.ts`.
  - core → page-admin: `src/tools/core.ts` → `src/api/page-profile.ts`.
  - The URL/path security functions (`resolveRemoteMediaUrl` `media-photos.ts:559`, `resolveLocalMediaPath` `:630`, `digestLocalMedia` `:1002`, `MediaSourceError`) are owned by `posts`. Four other lanes depend on them.
- **Why it matters.**
  - Rule 7 freezes only *listed* exports, so L2.posts can legally change `media-photos.ts` while L2.ads, L2.messages and L2.moderation run in parallel against it.
  - C01 changes error shapes that `MediaSourceError` consumers catch.
  - SSRF / path-traversal defence (security-critical) should not sit in a feature file of 1,678 lines.
- **Recommendation.**
  - Extract `src/api/media-source.ts` (expand), with media-photos re-exporting it. Mark it as a shared, non-lane module owned by C-tasks.
  - Rewrite rule 7 from the generated graph.
  - Add a fitness test that fails on any lane edge not in an allowlist (see §8).
- **Placement.** 1.0, wave 1. Owner: NEW **C07** (owns `src/api/media-source.ts` + test; the security section of `src/api/media-photos.ts` becomes a facade; doc 05 §1 rule 7). Size M. Must merge before any L2 task.

### ARC-02 — X06 shipped dead code; duplication grew; adoption is hidden inside L2.posts — **Major**

- **Evidence.**
  - `src/api/upload-session.ts` (613 lines) and `upload-session.test.ts` (975 lines) have **zero importers**. The only reference is a comment in `media-video.ts:10`.
  - Copies of the same helpers remain:
    - `media-video.ts`: `MAX_RESUME_WAIT_MS` `:98`, `asRecord` `:427`, `readOffset` `:453`, `offsetFromResponse` `:480`, `chunkRefused` `:493`, `isAbortError` `:726`;
    - `media-reels.ts`: `REEL_MAX_RESUME_WAIT_MS` `:116`, `asRecord` `:892`, `isAbortError` `:939`, `chunkRefused` `:1017`;
    - `upload-session.ts`: `UPLOAD_MAX_SERVER_WAIT_MS = 30_000`, `isAbortError`, `isChunkRefused`, `readWireOffset`.
  - L2.posts (doc 05 line 203) is already size **L** and bundles a tier change with this adoption.
- **Why it matters.**
  - There are now three implementations of the chunk-ack state machine, and only the unused one carries the newest tests.
  - A fix lands in one copy, and the copies drift (CC-MEDIA-* defects have hit exactly this code).
  - `.c8rc.json` sets `"all": false`, so coverage never reveals that a module is unused.
- **Recommendation.**
  - Split adoption out of L2.posts into its own task. It migrates `media-video.ts` and `media-reels.ts` (and the photos rupload path) onto `upload-session.ts`, deletes the local copies and must leave tests byte-identical.
  - Set a contract deadline: the expand-only module must have at least one importer by the end of wave 2, or be reverted.
  - Add an orphan-module fitness check (§8).
- **Placement.** 1.0, wave 2. Owner: NEW **L2.posts-upload** (owns the upload sections of `src/api/media-video.ts`, `src/api/media-reels.ts`, `src/api/media-photos.ts`, and `src/api/upload-session.ts`). Depends on X06 and C07. Size M. L2.posts shrinks to M.

### ARC-03 — The write gate is not part of the typed tool contract — **Major**

- **Evidence.**
  - `ToolContext` (`src/core/types.ts:554`) has no `writeGate` or `confirmer`.
  - `handlers.ts:83-86` declares a private `ToolCallContext` superset "because types.ts is frozen".
  - Tools obtain the gate with `writeGateOf` (`src/tools/shared.ts:344-350`), which reads `(ctx as Partial<WriteToolContext>).writeGate` and throws at runtime when it is missing.
  - `ToolSpec.writeTier` (`types.ts:615`) is declarative only. Nothing in `src/mcp/registry.ts` or `define.ts` checks that a tool with a `writeTier` actually routes through `executeWrite`.
  - The only generic plan-mode sweep (`src/index.test.ts:321-353`) loads `core`, asserts it has **no** write tools (`:335`), and calls each tool with `{}`.
- **Why it matters.**
  - The product's core safety promise ("plan mode performs zero mutations") is enforced by per-handler discipline across 18 tool files that call `executeWrite` / `writeGateOf`.
  - A new write handler that calls `ctx.fbRequest` directly passes typecheck, lint and the generic sweep.
  - The "freeze" that justified the cast was a wave-3 note from 0.x. It is now permanent.
- **Recommendation.**
  - Define a core-level `WriteGatePort` interface (types only, so layer 0 stays clean) and add `writeGate` and `confirmer` to `ToolContext`; then delete `writeGateOf`'s cast.
  - Add a registry-wide test. For every registered tool with `writeTier`, call it in plan mode with a minimal valid fixture, and assert that (a) the gate saw exactly one `execute`, and (b) the fake `fbRequest` saw zero non-GET requests.
- **Placement.** 1.0, wave 3. Owner: **I30** (already owns `src/core/types.ts`); extend its scope. The sweep test is NEW **I33** (owns a new `src/write-safety.test.ts` + fixtures per package). Size M.

### ARC-04 — Tool names are hard-coded in `core` and `api`, unowned and unchecked — **Major**

- **Evidence.**
  - 56 production literals `'facebook_…'` across 19 files in `src/core` and `src/api`, for example:
    - `src/core/error-matrix.ts` (23);
    - `src/api/messaging.ts` (6), `src/api/comments.ts` (4), `src/api/media-reels.ts` (3);
    - `src/core/http.ts:1051-1060` (`verifyToolFor` returns `'facebook_list_scheduled_posts'` / `DEFAULT_VERIFY_TOOL`).
  - Only the error-matrix names are verified against `manifest.json` (`src/core/error-matrix.test.ts:212-245`).
  - No check covers whether a named tool is *enabled* under the active packages or profile.
- **Why it matters.**
  - V3-D5 renames (L2.moderation, L2.insights, L2.ads) and C06 aliases change tool names in lane files, but the strings that point the model at those tools live in `core`/`api` files that no lane owns.
  - A rename silently turns "call facebook_X next" into advice the model cannot follow.
  - A layer-0 module also knows layer-3 vocabulary.
- **Recommendation.**
  - Add `src/core/tool-names.ts` with an `as const` map that every literal uses.
  - Add a test: every value in that map is in `manifest.json`, and no `'facebook_[a-z_]+'` literal appears in non-test `src/core`/`src/api` outside it.
  - When the result shaper runs, drop or rewrite a `nextTool` hint whose tool is not registered in this deployment.
- **Placement.** 1.0, wave 1 (before any rename lands). Owner: NEW **C08** (owns `src/core/tool-names.ts` + test). Literal migration is done by each L2 lane in its own files; `error-matrix.ts` and `http.ts` go to C08 itself. Size S (expand) + S per lane.

### ARC-05 — Wave 4 ordering breaks confirmation: P02 (stateless) lands before P03 (MRTR) and A04 (ports) — **Major**

- **Evidence.**
  - Confirmation uses server→client elicitation bound to one live session (`handlers.ts:102-108` → `elicitVia(server)`).
  - Plan state lives in a closure Map (`src/mcp/write-mode.ts:436`, TTL `:54` 5 min), one gate per mode (`handlers.ts:110-126`).
  - Upload sessions are in-process (`media-video.ts:253`).
  - Doc 05 lines 236-237 make P02 (stateless, `src/mcp/transport.ts` only) and P03 (MRTR confirm) parallel after P01.
  - A04 ports are in 2.x (line 252).
  - The transport re-arms one SDK transport per session (`transport.ts:318-340`).
- **Why it matters.**
  - In stateless Streamable HTTP there is no session to elicit on. If P02 merges first, every irreversible write in HTTP mode silently drops to the `FB_CONFIRM_TOKEN` fallback (or refuses).
  - The plan store is process-local. That is fine for one process, but 2.0 would be the first release that *invites* multi-request, multi-instance deployment, and it would advertise `plan_id` round-trips that cannot survive them.
  - P02's ownership (one file) understates the blast radius.
- **Recommendation.**
  - Make P03 a hard dependency of P02 (or merge them into one task owning `transport.ts`, `confirm.ts`, `write-mode.ts`, `server/elicitation.ts`).
  - Pull the `PlanStore` half of A04 into wave 4.
  - State in docs that 2.0 HTTP is single-process; multi-instance needs A04 + A05.
- **Placement.** 2.0, wave 4. Owner: P02 + P03 re-scoped; NEW **P06** "PlanStore port" (owns new `src/core/ports/plan-store.ts`; the plan-store section of `src/mcp/write-mode.ts`). Size M.

### ARC-06 — P01 "everything freeze" is over-scoped; the SDK pin risk is live now — **Major**

- **Evidence.**
  - Doc 05 line 229 says P01 runs alone under a code freeze, and line 235 has P01 owning "**everything**" and swapping "SDK v2 + zod 4".
  - zod 4 is already in (`package.json:61` `"zod": "^4.6.7"`; `src/server/schema.ts:12` imports `zod/v4`).
  - The SDK surface used is `toJsonSchemaCompat`, `CallToolRequestSchema`, `CallToolRequestParamsSchema` and types (`schema.ts:5-11`), plus `Server` and `ListToolsRequestSchema` (`handlers.ts:5-6`), plus `StreamableHTTPServerTransport` (`transport.ts:320`).
  - Meanwhile `@modelcontextprotocol/sdk` is pinned with a caret (`package.json:59` `^1.32.1`). Doc 04 R5 (`04-roadmap-and-risks.md:40`) records that the SDK already changed behaviour inside a minor, yet defers the exact pin to 2.0.
- **Why it matters.**
  - A freeze of every branch costs a full wave of parallelism to protect about 4 files that are already isolated.
  - The real, current risk — a `^1.x` minor changing `tools/list` or call validation under 1.0 users — is left open for six months.
- **Recommendation.**
  - Pin the SDK exactly now and add the `tools/list` snapshot test now (both are cheap).
  - Re-scope P01 to `src/server/*`, `src/mcp/transport.ts`, `src/mcp/define.ts`, `package.json`, with no freeze; lanes are only asked not to touch those files.
  - Do a throwaway SDK v2 spike in wave 3 to size it honestly.
- **Placement.** Exact pin + snapshot: 1.0, wave 1, NEW **I02** (integration files: `package.json`, `package-lock.json`, new `src/server/tools-list.snapshot.test.ts`), S. P01 re-scope: 2.0, wave 4, P01, size M (down from L).

### ARC-07 — `core/types.ts` is a 937-line god contract that holds MCP concepts in layer 0 — **Minor**

- **Evidence.** `src/core/types.ts` mixes:
  - Graph and errors: `GraphApiError` class `:215`;
  - Settings: `:63`;
  - MCP results: `ToolContent = ToolTextContent` `:527`, `ToolResult` `:530`;
  - the tool contract: `ToolContext` `:554`, `ToolSpec` `:588`, with `ZodTypeAny` input/output schemas, `PackageSpec`, `PACKAGE_NAMES`;
  - the write model: `WriteTier`, Plan, PlanPreview, ApplyResult, Journal, Confirmer `:902-925`;
  - stores: ActivityCursorStore, SavedReplyStore.
- **Why it matters.**
  - Every structured-content, image-content, outputSchema or SDK v2 change edits layer 0. That makes the integration-owned file a hotspot for C03, I30, P01, P03 and A04 alike.
  - Text-only `ToolContent` blocks image/resource results without a core change.
- **Recommendation.** Split into `src/core/types/{graph,settings,tool,write,stores}.ts` behind the existing `types.ts` facade (doc 05 rule 6). Move `ToolSpec`/`ToolResult` to the mcp layer at 2.0 if the SDK v2 types replace them.
- **Placement.** 1.0, wave 1. Owner: NEW **X08** (owns `src/core/types.ts` → `src/core/types/*`). Size S. Expand-only; no importer edits.

### ARC-08 — Seven copies of `asRecord` and parallel JSON-narrowing helpers — **Minor**

- **Evidence.** `asRecord` is defined at:
  - `src/api/ads-targeting.ts:142`;
  - `src/api/media-reels.ts:892`;
  - `src/api/media-video.ts:427`;
  - `src/api/upload-session.ts:58`;
  - `src/core/http-upload.ts:202`;
  - `src/core/http.ts:304`;
  - `src/mcp/result.ts:640` (different return type: never undefined).
  
  `http.ts` also keeps local `numOr`, `intOr`, `strOr` and `parseJson`.
- **Why it matters.** The narrowing helpers decide how untrusted Graph JSON is read. Subtle variants (readonly vs mutable, array handling, a non-undefined return) make behaviour differ per module.
- **Recommendation.** Add `src/core/json.ts` (`asRecord`, `asArray`, `numOr`, `strOr`, `parseJsonSafe`) with tests, and migrate each copy in its owner's lane task.
- **Placement.** 1.0, wave 1. Owner: NEW **C09** (owns `src/core/json.ts` + test). Lanes migrate in L2.*. Size S.

### ARC-09 — Very large modules outside the split plan — **Minor**

- **Evidence.** X01–X05 (doc 05 lines 154-158) split only tools/mcp files. Production files at or above 1,300 lines remain unscheduled:

  | File | Lines |
  |---|---|
  | `src/api/insights.ts` | 1,763 |
  | `src/api/media-reels.ts` | 1,732 |
  | `src/api/media-photos.ts` | 1,678 |
  | `src/api/ads-read.ts` | 1,667 |
  | `src/api/media-video.ts` | 1,657 |
  | `src/core/http.ts` | 1,623 |
  | `src/api/posts-write.ts` | 1,619 |
  | `src/api/comments.ts` | 1,525 |
  | `src/tools/messages.ts` | 1,352 |
  | `src/api/messaging.ts` | 1,351 |

  The test giants are `src/tools/posts.test.ts` (4,622), `src/index.test.ts` (3,619), `src/core/http.test.ts` (3,417) and `src/tools/moderation.test.ts` (3,373).
- **Why it matters.** L2.insights, L2.posts and L2.ads are all size L because the api files are monoliths. Large test files are the most frequent merge-conflict site in a parallel wave, and doc 05 has no owner for `src/index.test.ts` beyond I-tasks.
- **Recommendation.**
  - Add an api-layer split wave alongside wave 1 (insights, media-video and media-reels after C07 and L2.posts-upload, ads-read).
  - Set a 1,200-line budget in the gate (§8).
  - Assign `src/index.test.ts` sections to lanes, or split it per concern.
- **Placement.** 1.0, wave 1–2. Owner: NEW **X09–X11** (one per api file, facade rule). Size M each.

### ARC-10 — `logFields` are not validated against `inputSchema` — **Minor**

- **Evidence.** `defineTool` checks that `logFields` is non-empty (`src/mcp/define.ts`) but not that each key exists in the schema. `allowlistedLogFields` silently skips missing keys (`handlers.ts:275-277`).
- **Why it matters.** The L2 argument renames (V3-D5, `ad_set` spelling, `boost_post` argument) will turn allowlisted keys into dead names. The log line then loses its only diagnostic fields, and no test notices.
- **Recommendation.** In `defineTool`, assert that every `logFields` key is a top-level key of the object schema (throw at module load).
- **Placement.** 1.0, wave 1. Owner: **C06** (already owns `src/mcp/define.ts` for aliases); add the check. Size S.

### ARC-11 — Lint zones do not cover `src/testing`, the root `src/*.ts`, or the cli↔tools relation the docs describe — **Minor**

- **Evidence.**
  - `eslint.config.js:19-52` zones `core`, `api`, `mcp`, `tools` and `cli` only. `server` is the top layer.
  - Nothing forbids production code importing `src/testing/*` (the network fence, fakes).
  - `cli` is barred from `tools` (`:42-43`), so the documented chain `core ← api ← mcp ← tools ← cli ← server` is really `tools` and `cli` as siblings.
  - The `FACADE_ZONES` exception lets `src/mcp/setup-token.ts` import cli (`:48-52`) and is still alive (deferred in doc 05 §11).
- **Why it matters.** Test helpers leaking into the runtime bundle and silent new facades are the two easy ways the boundary erodes. The architecture doc mis-states the graph that agents and lanes rely on.
- **Recommendation.**
  - Add a zone that forbids every non-test file outside `src/testing` from importing `src/testing` and `src/core/fakes`.
  - Correct the layer diagram to show `tools` and `cli` as siblings.
  - Schedule removal of the setup-token facade.
- **Placement.** 1.0, wave 3. Owner: NEW **I34** (owns `eslint.config.js` and the architecture doc diagram). Facade removal is a contract task after X05. Size S.

### ARC-12 — Coverage is outside `npm run check`, and `"all": false` hides unloaded modules — **Minor**

- **Evidence.**
  - `package.json` `check` = guard + typecheck + lint + format:check + build + test.
  - Coverage runs only in CI (`.github/workflows/ci.yml:83-93`).
  - `.c8rc.json` has `"all": false`.
- **Why it matters.**
  - Local `check` (what agents and lanes run before merge) can be green while CI coverage is red.
  - A production module that no test loads contributes 0 lines to the denominator instead of failing.
- **Recommendation.** Add `npm run coverage` to `check` (or a `check:full`), and set `"all": true` with explicit excludes.
- **Placement.** 1.0, wave 1. Owner: NEW **I02** (same integration task as the SDK pin). Size S.

### ARC-13 — `server` handlers own policy that belongs to the registry — **Minor**

- **Evidence.**
  - `buildServer` decides the gate per write mode (`handlers.ts:114-126`).
  - It composes the "disabled tool" explanation by scanning packages (`:131-140`).
  - It performs page-token invalidation (`:218-220`).
  - The registry (`src/mcp/registry.ts`, 216 lines) only selects tools.
- **Why it matters.** C06 aliases, I30 profiles and P02/P04 dual-era configs all need the same lookups. With the logic in `server/`, every one of them edits the same 300-line file and the SDK-coupled module.
- **Recommendation.** Move `writeModeFor`-to-gate resolution and `unadvertisedToolMessage` into `src/mcp/registry.ts` (`registry.resolve(name) → {spec, gate, disabledReason}`). `server/` stays a thin SDK adapter.
- **Placement.** 1.0, wave 1. Owner: **C06** (owns `src/mcp/registry.ts`); handlers edit by I-task. Size S.

### ARC-14 — `outputSchema` expansion (C03) will collide with the text-only result contract — **Minor**

- **Evidence.**
  - `ToolContent = ToolTextContent` (`types.ts:527`).
  - `toCallToolResult` copies text and `structuredContent` (`schema.ts:84-92`).
  - The shaper truncates to `maxResultChars` (`shapeOptionsOf`, `src/tools/shared.ts:356`).
  - C03 owns `src/mcp/define.ts` and `src/mcp/result.ts` (doc 05 line 174).
- **Why it matters.** Under the spec, a tool with an `outputSchema` must return a `structuredContent` that validates. A truncated or redacted payload (budget overflow, `access_token` scrub) can violate the declared schema, which strict clients reject.
- **Recommendation.** C03 must define the overflow policy explicitly (structured payload never truncated, or a schema with a `truncated` union branch). Add a test that validates every shaped result against its declared schema under a tiny budget.
- **Placement.** 1.0, wave 1. Owner: **C03**; acceptance criteria added. Size unchanged (M).

### ARC-15 — `src/core/http.ts` has encoded publish-verification policy for one tool — **Minor**

- **Evidence.** `verifyToolFor` (`http.ts:1051-1060`) regex-matches feed POSTs and decides the verify tool name from the body (`published`, `scheduled_publish_time`). The `DEFAULT_VERIFY_TOOL` constant is also there.
- **Why it matters.** It is endpoint-specific knowledge in the transport. Every new ambiguous-write family (reels, stories, ads creates) either extends this regex in core or lacks a verify hint. It is also part of ARC-04.
- **Recommendation.** Require `JsonRequest.verifyTool` from the api caller (it already exists as an override) and delete the path inference in a contract step.
- **Placement.** 1.x. Owner: L2.posts sets `verifyTool`, then NEW **C08b** removes the inference (`src/core/http.ts` section). Size S.

### ARC-16 — Stale design claims in code and roadmap — **Nit**

- **Evidence.**
  - `src/mcp/define.ts:12` "Zod-v3 … quarantined to this file" (false; zod 4, used in 30+ files).
  - The `ToolContext` "FREEZE NOTE" (`types.ts:550`) and the `handlers.ts:76-82` comment promise that "Wave-4 write handlers consume them once ToolContext gains the additive fields", which refers to the 0.x wave numbering.
  - Doc 05 §11 shows wave 1 as "—" while `2c8d8bd` (C05) is merged.
  - Doc 05 line 235 still lists "zod 4" as a P01 deliverable.
- **Recommendation.** Fix these with ARC-03 (I30) and the next doc 05 status update.
- **Placement.** 1.0, wave 1, doc 05 owner (integration). Size S.

### ARC-17 — `src/core/index.ts` barrel is 289 lines of explicit exports — **Nit**

- **Evidence.** X07 replaced wildcards (`src/core/index.ts:7`), but every layer imports `../core/index.js` (for example `handlers.ts:8-24`).
- **Why it matters.** Any new core export conflicts in this one file across parallel C-tasks (C07, C08, C09, X08).
- **Recommendation.** Let lanes import `../core/<module>.js` directly (lint-allowed), and keep the barrel for the package's public API only.
- **Placement.** 1.0, wave 1. Owner: X07 follow-up (integration). Size S.

### ARC-18 — Reels quota is a constant without enforcement or a seam — **Nit**

- **Evidence.** `REEL_QUOTA_PER_24H = 30` (`src/api/media-reels.ts:129`) is used only in notes and error text (`media-reels.test.ts:485,1589`).
- **Recommendation.** Either delete the claim of a quota from the notes, or add a `QuotaStore` port in A04 and check it before the upload starts.
- **Placement.** 2.x, wave 5. Owner: A04. Size S.

## 5. Roadmap critique (docs 04 and 05)

**What is right.**

- Expand → migrate → contract, facades for splits, fragments for CHANGELOG and annotations, and "only I-tasks touch dependencies" are the correct mechanics for many agents on one repo.
- Wave 0 proved they work: `tools/list` stayed byte-identical.

**Where the plan does not survive contact with the code.**

1. **The dependency map is hand-written and wrong** (ARC-01). The whole lane model rests on §1 rule 7. Generate it from imports, store it as a fixture, and fail the gate on drift. Without that, "exclusive ownership" is an honour system.
2. **Expand-only has no contract deadline** (ARC-02). Doc 05 rule 5.3 says "a later task removes the old helper" but sets no date. X06 shows the failure: the expand step merged, and the migrate step became a footnote in an L task. Every expand task should name its migrate task ID and a wave deadline in §11.
3. **Unowned files.**
   - `src/core/error-matrix.ts`, `src/core/http.ts` and the tool-name literals in `src/api/*` are touched by renames but have no lane (ARC-04).
   - `src/index.test.ts` (3,619 lines) is "integration" by default and is the most likely conflict site in wave 2.
   - Doc 05 should add an explicit "shared, C-owned" list: `media-source`, `tool-names`, `json`, `upload-session`, `messaging` read helpers.
4. **Sizes are inflated where splits are missing** (ARC-09). L2.posts, L2.insights and L2.ads are L because their api files are monoliths. Splitting api files in wave 1 converts three L tasks into M tasks and reduces wave-2 risk more than any rule change.
5. **Wave 4 is ordered by dependency on P01 alone** (ARC-05, ARC-06). P01 is not a real bottleneck once re-scoped. The true constraint is the confirm/state coupling: P03 → P02, with PlanStore pulled forward.
6. **R5 is mitigated in the wrong release.** Doc 04 line 40 places the exact SDK pin in 2.0. The risk is present for every 1.x user; move it to 1.0.
7. **R3 mitigation creates its own risk.** A code freeze (doc 04 line 38) is cheap only if wave 4 is short. With MRTR, stateless HTTP and dual-era config, it is not. Re-scoped P01 removes the need.
8. **Missing fitness functions.** The roadmap names tests per task but no structural gates (file size, lane graph, orphan modules, literal tool names, write-gate sweep). §8 lists them; they belong in I02 so that waves 1–3 run under them.
9. **Status table drift.** §11 is the dispatch source of truth but lags a merged commit (C05). Make the status table a generated view, or update it in the same commit as each task merges.

## 6. Owner decisions needed

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D-ARC-1 | Where the media-source security code lives | (a) stays in `media-photos.ts` (posts lane); (b) new shared `src/api/media-source.ts`, C-owned; (c) move to `src/core/` | **(b)**. It is Graph-adjacent (api layer) but cross-lane; core would need fs/url policy it does not own today |
| D-ARC-2 | Fate of `upload-session.ts` | (a) adopt in a dedicated wave-2 task; (b) keep in L2.posts; (c) revert X06 | **(a)**, with revert as the fallback if not adopted by the wave-2 tag |
| D-ARC-3 | Exact SDK pin timing | (a) now (1.0); (b) 2.0 as planned | **(a)**. R5 already happened once |
| D-ARC-4 | P01 freeze | (a) full freeze, "everything"; (b) re-scoped file set, no freeze, after a wave-3 spike | **(b)** |
| D-ARC-5 | 2.0 HTTP deployment model | (a) single-process only, documented; (b) multi-instance in 2.0 (needs PlanStore + upload store in wave 4); (c) defer HTTP stateless to 2.x | **(a)** for 2.0 with PlanStore port in wave 4; multi-instance in 2.x with A05 |
| D-ARC-6 | Write-gate typing | (a) keep the runtime cast; (b) `WriteGatePort` in core + field on `ToolContext` at I30 | **(b)**. It is the safety contract and should be typed |
| D-ARC-7 | File-size budget | (a) none; (b) 1,200-line soft gate with an allowlist that only shrinks | **(b)** |

## 7. Metrics and fitness functions to add to the gate

All of these are plain Node scripts or `node:test` files with no new dependencies (doc 05 rule 9). They belong to NEW **I02** unless noted.

| Fitness function | Rule | Implementation |
|---|---|---|
| Lane graph | Every cross-lane import is in `docs/analysis/v3/lane-graph.json`; new edges fail | Script maps `src/{api,tools}` files to lanes via the doc 05 ownership table, walks imports with the TS compiler API (already a dev dependency) |
| Orphan modules | Every non-test production module under `src/` is reachable from `src/index.ts` or `src/cli` entry | Same import walk; allowlist with an expiry wave for expand-only modules |
| File-size budget | Production file ≤ 1,200 lines, test file ≤ 2,500; allowlist may only shrink | `wc`-style script; allowlist checked in |
| Tool-name literals | No `'facebook_[a-z_]+'` literal in non-test `src/core`/`src/api` outside `src/core/tool-names.ts`; every name there exists in `manifest.json` | Grep-based test (C08) |
| Write-safety sweep | Every registered tool with `writeTier`, all packages loaded, plan mode: exactly one gate `execute`, zero non-GET `fbRequest` calls | Registry-driven test with per-package minimal fixtures (I33) |
| logFields ⊆ schema keys | Each `logFields` entry is a top-level key of `inputSchema` | Check in `defineTool` (C06) |
| outputSchema conformance | Every shaped result validates against its declared `outputSchema` at a 500-char budget | Test in C03 |
| SDK surface | Only `src/server/*` and `src/mcp/transport.ts` import `@modelcontextprotocol/sdk` | `no-restricted-imports` pattern in `eslint.config.js` (I34) |
| Coverage in `check` | `npm run check` runs c8 with `"all": true` | `package.json`, `.c8rc.json` |
| `tools/list` snapshot | Byte-identical `tools/list` per profile unless the snapshot is updated in the same commit | Snapshot test (I02) |
| Helper duplication | `function asRecord` defined once in production code | Grep-based test (C09) |

Track three numbers per wave in doc 05 §11:
- the count of undocumented lane edges (target 0);
- the files over budget (target: non-increasing);
- the expand-only modules with zero importers (target 0 at each wave tag).
