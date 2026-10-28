# 05 — Parallel task breakdown (v3 dispatch board)

Written 2026-10-28. This splits the road from 0.8 to 3.0 ([doc 04](04-roadmap-and-risks.md))
into tasks that run **in separate branches at the same time without touching the same files**.
Each task has:

- a stable ID;
- an exclusive file set;
- explicit dependencies;
- a definition of done.

It follows the format of the v1 board ([../11-parallel-task-breakdown.md](../11-parallel-task-breakdown.md)).
Waves order *development*. Phase gates in doc 04 order *releases*.

## 1. Coordination rules (binding for every task)

1. **One task = one branch = one worktree.**
   - Branch: `task/<id>-<slug>`, e.g. `task/c01-error-envelope`.
   - Worktree: `git worktree add ~/Development/_branches/facebook-mcp-<id> -b task/<id>-<slug>`.
   - Never inside `~/Development` directly, never `../`.
   - When merged: `git worktree remove` it and `git branch -d` the branch in the same session.
   - A branch lives for at most one wave.
2. **Exclusive file ownership.** A task edits only the files in its *Owns* column (including
   their colocated `*.test.ts`). It may create new files only under the paths it owns. It
   reads anything.
   - Needs a change in a file it does not own → stop and file a request with the owner (§6).
     Never edit the file "just a little".
3. **Integration-only files.** These files belong only to I-tasks:

   | File | Why it is shared |
   |---|---|
   | `package.json`, `package-lock.json` | dependencies, scripts, engines, `exports` |
   | `src/index.ts` → after I01: `src/server/*` | bootstrap, wiring |
   | `src/tools/index.ts` | package barrel (one `export` line per package) |
   | `src/mcp/packages.ts` | profiles |
   | `src/core/types.ts` (`PACKAGE_NAMES`, `PackageSpec`) | package contract |
   | `eslint.config.js`, `tsconfig*.json`, `.prettierrc*` | gate config |
   | `.github/workflows/*`, `.nvmrc` | CI, runtime |
   | `scripts/metadata.config.mjs`, `src/metadata.test.ts` | version and metadata source of truth |
   | `CHANGELOG.md` | folded from fragments at release time |

   Before a release, the I-task that cuts it changes only the version in `scripts/metadata.config.mjs`.
4. **Generated files are never hand-merged.** These files are regenerated, not merged:
   - the README tool tables;
   - `manifest.json`, `server.json`, `.env.example`;
   - [../06-tool-catalog.md](../06-tool-catalog.md) where it is generated.

   On a conflict, take either side, run `npm run metadata`, and commit the regenerated output.
5. **Expand → migrate → contract.** A cross-cutting change never edits every caller in one branch.
   1. **Expand.** A C-task (contract) adds the new helper, type or schema in files it owns, with
      tests. It does not migrate callers. After merge, its exported API is **frozen** for the wave.
   2. **Migrate.** One L-task per lane adopts the contract in that lane's own files. The lanes
      run in parallel.
   3. **Contract.** A later task removes the old helper, once the lanes have merged and nothing
      uses it any more.
6. **Facade rule for splits.** A file split into a directory keeps its old path as a thin
   re-export facade. For example, `src/tools/posts.ts` becomes
   `export * from './posts/index.js'`. Then `src/tools/index.ts` and every importer stay
   unchanged, and splits never conflict with the wiring.
7. **Cross-lane imports are read-only.** Some lanes import from others:
   - `messages` imports `activity` and `labels`;
   - `saved-replies` is imported by `messages` and `moderation`;
   - `report` imports `insights`;
   - `ads-create` and `ads-shared` import `ads`.

   An exported symbol used by another lane is frozen during the wave. If it must change, add a
   new export and leave the old one; the owning lane's next task removes it.
8. **Fragments instead of shared lists** (introduced by I00):
   - **CHANGELOG:** each task writes `changes/unreleased/<task-id>.md`. The release I-task folds
     them into `CHANGELOG.md` and deletes them.
   - **Annotations:** the frozen `ANNOTATION_MANIFEST` in `src/mcp/annotations.test.ts` becomes
     one fragment per package, `src/mcp/annotations/<pkg>.ts`, owned by that package's lane.
     The test only concatenates them.
9. **Only I-tasks change dependencies, the Node version or the CI.** A task that needs a new
   dependency asks for it (§6). No task adds a dependency inside its own branch.
10. **Feature freeze from wave 0 to the 1.0 tag.** New tools wait for wave 5 (A-tasks).
    Bug fixes are allowed in the lane that owns the file.
11. **Commit and push.** Commit on the task branch when the definition of done is green. Merge
    into `main` happens through the integrator (§5). Nothing is pushed unless the owner asks.

## 2. Definition of done (every task)

- [ ] `npm run check` green in the task worktree:
  - guard
  - typecheck
  - lint (layers `core ← api ← mcp ← tools`)
  - format
  - build
  - tests
- [ ] `npm run metadata:check` green (if it fails only on generated files, run `npm run metadata`).
- [ ] Colocated tests for every new or changed behaviour. Coverage is not lowered: compare
  `npm run coverage` before and after (advisory, not gated).
- [ ] Only files from the *Owns* column are changed: `git diff --name-only main...` ⊆ the
  ownership set plus the task's CHANGELOG fragment.
- [ ] Facade paths unchanged; no import path of another lane broken.
- [ ] `changes/unreleased/<task-id>.md` present (from wave 1 on), plus the annotation fragment
  if a tool's annotations changed.
- [ ] Staged diff checked for secrets (tokens, app secrets, `.env*`). If one is found, stop and
  report; never commit it.
- [ ] No harness files (`CLAUDE.md`, `WORKLOG.md`, `.claude/`, `docs/ai/`) in the diff.
- [ ] Rebased on the current `main` just before merge; the gate is green again after the rebase.

## 3. Lanes (file ownership by package)

A **lane** is the set of files of one tool package plus its API module(s). The L-tasks of a wave
are one per lane, and they never overlap.

| Lane | Tool files (`src/tools/`) | API files (`src/api/`) | Other owned files |
|---|---|---|---|
| `core` | `core.ts` | — | `src/mcp/annotations/core.ts` |
| `reader` | `reader.ts`, `activity.ts` | `posts-read.ts`, `activity.ts` | `src/mcp/annotations/reader.ts` |
| `posts` | `posts.ts` (facade), `posts/*` | `posts-write.ts`, `media-photos.ts`, `media-video.ts`, `media-reels.ts`, `albums.ts`, `stories.ts` | `src/mcp/annotations/posts.ts` |
| `insights` | `insights.ts`, `report.ts`, `insights-export.ts` | `insights.ts`, `insights-batch.ts`, `page-report.ts` | `src/mcp/annotations/insights.ts` |
| `moderation` | `moderation.ts` (facade), `moderation/*`, `moderation-settings.ts`, `saved-replies.ts` | `comments.ts`, `comment-triage.ts`, `page-settings.ts` | `src/core/saved-replies.ts`, `src/mcp/annotations/moderation.ts` |
| `messages` | `messages.ts`, `labels.ts`, `message-attachment.ts` | `messaging.ts`, `labels.ts` | `src/mcp/annotations/messages.ts` |
| `ads` | `ads.ts` (facade), `ads/*`, `ads-create.ts`, `ads-shared.ts` | `ads-*.ts` (all ten) | `src/mcp/annotations/ads.ts` |
| `page-admin` | `page-admin.ts` | `page-profile.ts` | `src/mcp/annotations/page-admin.ts` |

Lanes do **not** own these. Only C, P, X or I tasks change them, each named in its row:

- `src/tools/shared.ts`, `src/api/shared.ts`;
- every other file in `src/core/` and `src/mcp/`;
- `src/testing/`, `src/core/fakes/`;
- the root `*.test.ts` harnesses.

After X03 splits the doctor, each `src/mcp/doctor/<lane>.ts` probe file belongs to its lane.

Lanes `core` and `page-admin` are small, so one session may take both in the same wave. They
stay separate branches.

## 4. Waves

Sizes: **S** = a focused session, **M** = a full session, **L** = a large session (split on the fly).
*Depends* lists task IDs that must be merged into `main` first.

### Wave A — ship 0.8.0 (now)

| ID | Task | Owns | Depends | Size |
|---|---|---|---|---|
| U-A1 | Owner: approve push of the 42 commits and the 0.8.0 release; decide V3-D1 and V3-D11 | — | — | S |
| I-A1 | Land PR #41 per v2 D7 (additive half; credit the author) | the PR's files, rebased | U-A1 | S |
| I-A2 | Release 0.8.0: version in `scripts/metadata.config.mjs`, `npm run metadata`, CHANGELOG section, tag | integration files | I-A1 | S |
| U-A2 | Owner: listings (PulseMCP, Smithery, mcp.so, GitHub MCP registry), Claude plugin submission, announcement per `launch-marketing` | — | I-A2 | S |

### Wave 0 — enablers (no behaviour change; all parallel)

None of these changes behaviour. Each keeps `tools/list` byte-identical. Prove it with a
before/after snapshot of `tools/list` in the PR description.

| ID | Task | Owns | Depends | Size |
|---|---|---|---|---|
| I00 | Fragments: create `changes/unreleased/` with a README; split `ANNOTATION_MANIFEST` into `src/mcp/annotations/<pkg>.ts` fragments plus a loader; release-script step that folds fragments | `src/mcp/annotations.test.ts`, `src/mcp/annotations/*`, `changes/`, `scripts/` (new fold script only) | I-A2 | M |
| I01 | Split `src/index.ts` into `src/server/{bootstrap,errors,schema,elicitation,handlers}.ts`; `src/index.ts` becomes the entry facade; add the `server` zone to the ESLint layer map | `src/index.ts`, `src/index.test.ts`, `src/server/*`, `eslint.config.js` | I-A2 | L |
| X01 | Split `src/tools/posts.ts` (2,640 lines) into `src/tools/posts/{publish,lifecycle,media,queue,index}.ts` behind a facade | `src/tools/posts.ts`, `posts.test.ts`, `src/tools/posts/*` | I-A2 | M |
| X02 | Split `src/tools/moderation.ts` (2,447) into `src/tools/moderation/{comments,visibility,replies,blocking,index}.ts` behind a facade | `src/tools/moderation.ts`, `moderation.test.ts`, `src/tools/moderation/*` | I-A2 | M |
| X03 | Split `src/mcp/doctor.ts` (2,424) into `src/mcp/doctor/{index,runner,<lane>}.ts`, one probe file per lane | `src/mcp/doctor.ts`, `doctor.test.ts`, `src/mcp/doctor/*` | I-A2 | M |
| X04 | Split `src/tools/ads.ts` (1,709) into `src/tools/ads/{read,insights,control,index}.ts` behind a facade | `src/tools/ads.ts`, `ads.test.ts`, `src/tools/ads/*` | I-A2 | M |
| X05 | Move `src/mcp/setup-token.ts` (CLI) to `src/cli/setup-token/*`; keep a facade in `src/mcp/` | `src/mcp/setup-token.ts`, its test, `src/cli/*` | I-A2 | M |
| X06 | Extract the shared upload state machine from `media-{photos,video,reels}.ts` into a new `src/api/upload-session.ts`. **Expand only**: the media files stay as they are | `src/api/upload-session.ts` (+ test) | I-A2 | M |
| X07 | Narrow the `src/core/index.ts` barrel: add explicit named exports; mark the wildcard ones deprecated. No importer edits | `src/core/index.ts` | I-A2 | S |

Merge order inside the wave does not matter, except: I01 last, because it touches
`eslint.config.js`. If a new `src/cli` or `src/server` zone needs an ESLint entry, I01 adds both.

### Wave 1 — contracts (expand only; all parallel)

Each C-task adds a contract with tests and migrates **no** lane file. The doc it writes is the
lanes' spec.

| ID | Task | Owns | Depends | Size |
|---|---|---|---|---|
| C01 | **Unified error envelope.** One `ErrorResult` shape with a typed `code`; `graphErrorFields` keeps its signature but returns the new shape; catalogue in `docs/error-catalog.md` | `src/mcp/result.ts`, `src/server/errors.ts`, `src/tools/shared.ts` (error helpers only), `docs/error-catalog.md` | I01 | M |
| C02 | **List contract.** Helpers for pagination (omit `nextCursor` when done), `fields` as `string[]` (CSV accepted and flagged deprecated), `notes[]` builder | `src/tools/shared.ts` (list helpers section), `src/api/shared.ts` | I-A2 | M |
| C03 | **`outputSchema` builder.** Write-preview envelope schema (v2 D6) plus a helper for read tools to declare one | `src/mcp/define.ts`, `src/mcp/result.ts` (schema exports only) | C01 | M |
| C04 | **Settings collapse.** New env and token names with old names as aliases plus a deprecation note in `doctor` | `src/core/settings.ts`, `src/core/config.ts`, `src/mcp/doctor/runner.ts` | X03 | M |
| C05 | **Stable insights schema.** Server-owned metric map (`views`, `viewers`, `engagements`, `follows`, …) with `source_metric` and `status` | new `src/api/insights-schema.ts` (+ test), `docs/insights-schema.md` | I-A2 | M |
| C06 | **Tool aliases.** A tool definition may declare `aliases: string[]`; the registry lists each alias with a deprecated description and routes it to the same handler | `src/mcp/registry.ts`, `src/mcp/define.ts` (alias field only) | C03 | S |

`src/tools/shared.ts` is split between C01 and C02 by section. To avoid a conflict, C02 puts its
helpers in a new `src/tools/shared/list.ts` and re-exports it from `shared.ts` with one line.
C02 merges after C01.

`src/mcp/define.ts` is shared by C03 and C06, so C06 depends on C03.

### Wave 2 — lane adoption (one L-task per lane; all lanes parallel)

Every lane task does the same checklist, only in its own files:

1. Adopt C01: return the unified error envelope.
2. Adopt C02:
   - `fields` arrays;
   - pagination;
   - `notes[]` (keep `note` emitted and deprecated);
   - typed results for Meta-side refusals that hit this lane.
3. Adopt C03: `outputSchema` on every read tool of the lane, and the envelope schema on writes.
4. Renames per V3-D5 via C06 aliases, with the annotation fragment updated.
5. Lane-specific items in the table below.

| ID | Lane | Lane-specific items | Depends | Size |
|---|---|---|---|---|
| L2.core | core | `whoami` / `usage` recorded exceptions | C01–C04, C06 | S |
| L2.reader | reader | `get_activity_since` `idempotentHint: true` | C01–C03, C06 | M |
| L2.posts | posts | `create_story` tier → reversible (if V3-D5 confirms); adopt X06 `upload-session.ts` in the media files | C01–C03, C06, X01, X06 | L |
| L2.insights | insights | Adopt C05 in every insights tool and the report; insights renames | C01–C03, C05, C06 | L |
| L2.moderation | moderation | `send_private_reply` / `set_comment_visibility` renames | C01–C03, C06, X02 | M |
| L2.messages | messages | `send_message` `destructiveHint` fix; thread-ownership refusal typed (Conversation Routing / Meta Business Agent) | C01–C03, C06 | M |
| L2.ads | ads | Explicit `advantage_audience` on duplicate and targeting edit (**due 2027-02-23**); `ad_set` spelling; `boost_post` arg; typed refusals (breakdown enablement, ASC/AAC writes) | C01–C03, C06, X04 | L |
| L2.page-admin | page-admin | — | C01–C03, C06 | S |

Merge order: any order. Each lane rebases on `main` before merge.

Wave 2 also has a *contract* step, done by the integrator after all lanes have merged:

| ID | Task | Owns | Depends | Size |
|---|---|---|---|---|
| C01b | Remove the old error helpers and branches that the lanes no longer use | `src/tools/shared.ts`, `src/server/errors.ts` | all L2.* | S |

### Wave 3 — release 1.0.0 (integration only)

| ID | Task | Owns | Depends | Size |
|---|---|---|---|---|
| I30 | Profiles: `core` → `default` (old name accepted as alias); re-home odd read tools | `src/mcp/packages.ts`, `src/core/types.ts` | all L2.* | S |
| I31 | `exports` map in `package.json`; `npm run metadata` | `package.json` | I30 | S |
| U30 | Owner: live gate L1–L8 and boost P1–P7 on the test Page and ad account | — | I31 | M |
| I32 | Fold fragments into `CHANGELOG.md` (1.0 section with a deprecations table); version 1.0.0; tag | integration files | U30 | S |

### Wave 4 — 2.0 platform (spring 2027)

P01 runs **alone, under a code freeze**: no other branch is open. It swaps the SDK and zod, so
it touches many files mechanically. After it merges, P02–P05 and the lane removals run in
parallel again.

| ID | Task | Owns | Depends | Size |
|---|---|---|---|---|
| P01 | SDK v2 + zod 4: dependency swap; drop `toJsonSchemaCompat`, the `zod/v4` bridge and `TolerantCallToolRequestSchema`; exact SDK pin; `tools/list` snapshot | **everything** (freeze) | I32 | L |
| P02 | Stateless Streamable HTTP; remove `sessionIdGenerator` | `src/mcp/transport.ts` (+ test) | P01 | M |
| P03 | MRTR / `inputRequired` confirm; `FB_CONFIRM_TOKEN` kept as fallback | `src/mcp/confirm.ts`, `src/mcp/write-mode.ts` | P01 | M |
| P04 | Dual-era config (`legacy: 'stateless'`), conformance tests for 2025-11-25 and 2026-07-28 sessions | `src/server/*`, new `src/conformance/*` | P01 | M |
| P05 | Node ≥ 24: `engines`, `.nvmrc`, CI matrix | integration files | P01 | S |
| L4.<lane> | Remove the lane's 1.x deprecations: aliases, `note`, CSV `fields`, old arg names | the lane's files | P01 | S each |
| C04b | Remove the old env names | `src/core/settings.ts`, `src/core/config.ts` | P01 | S |
| I40 | Release 2.0.0 (before 2027-04-30) | integration files | P02–P05, all L4.*, C04b | S |

### Wave 5 — 2.x additive (parallel themes; one minor per theme)

| ID | Task | Owns | Depends | Size |
|---|---|---|---|---|
| A01 | Server `instructions` | `src/server/instructions.ts` | I40 | S |
| A02 | Schema-size budget test (`all` < 110 KB) | new `src/schema-budget.test.ts` | I40 | S |
| L5.<lane> | Description and schema diet to meet A02 | the lane's files | A02 | S each |
| A03 | `facebook://reference/*` resources and 2–3 prompts (V3-D8) | new `src/mcp/resources/*`, `src/mcp/prompts/*` | I40 | M |
| A04 | Ports: `PlanStore`, `JournalSink`, `UploadSessionStore`, `TokenStore` with in-memory adapters | new `src/core/ports/*`; `src/mcp/write-mode.ts`, `src/mcp/journal.ts` | I40 | M |
| A05 | Durable uploads (V3-D6 4a): file adapter for `UploadSessionStore` | new `src/core/adapters/*`; `src/api/upload-session.ts` | A04 | M |
| A06 | Page Integrity read tool | new `src/tools/page-integrity.ts`, `src/api/page-integrity.ts` (new package; wiring by I) | I40 | M |
| A07 | Messenger reactions and `reply_to` | messages lane | I40 | M |
| A08 | Boost objective `PROFILE_AND_PAGE_ENGAGEMENT`; creative-feature opt-outs | ads lane | I40 | M |
| A09 | Ads pin bump (≈ 2027-06) | `src/api/ads-*.ts` constants and ads fixtures | I40 | M |
| A10 | Verify MCP `logging/message` vs stderr against the deprecation | `src/core/log.ts` | I40 | S |
| I5x | Wire new packages (A06), release each minor | integration files | per theme | S |

A07 and A08 occupy their lanes. No other task in the same lane runs in parallel with them.

### Wave 6 — 3.0.0 (Q4 2027 – Q1 2028; before 2028-04-30)

| ID | Task | Owns | Depends | Size |
|---|---|---|---|---|
| U60 | Owner: confirm V3-D9 and the conditional items (SDK v3, result shape, HTTP-over-stdio) | — | ~2027-09-28 spec | S |
| B01 | Modern-only: `legacy: 'reject'`, `legacyShim: false`; remove the dual-era branches | `src/server/*`, `src/conformance/*` | U60 | M |
| B02 | Drop `FB_CONFIRM_TOKEN`: elicitation / MRTR or deny | `src/mcp/confirm.ts`, `src/mcp/write-mode.ts`, `src/core/settings.ts` | U60 | S |
| L6.<lane> | Remove the lane's 2.x deprecations | the lane's files | U60 | S each |
| B03 | SDK v3 swap, if released (same freeze rule as P01) | everything (freeze) | B01 | L |
| C60 + L6r.<lane> | Result-shape redesign, if the spec ships it: contract first, then lanes | as in waves 1–2 | B03 | L |
| B04 | Node ≥ 26: `engines`, `.nvmrc`, CI | integration files | U60 | S |
| I60 | Release 3.0.0 with the migration guide | integration files, `docs/migration-3.md` | all of wave 6 | S |

## 5. Merge protocol (integrator)

1. Merge only tasks whose *Depends* are already in `main`.
2. Order inside a wave:
   1. C/X/P tasks;
   2. lane tasks (any order);
   3. contract-step tasks (C01b, C04b);
   4. I-tasks.
3. Before each merge:
   - the branch is rebased on `main`;
   - `npm run check` and `metadata:check` are green on the rebased branch;
   - `git diff --name-only main...` is within the ownership set.
4. Generated-file conflict → `npm run metadata`, commit, continue (rule 4).
5. After the merge: remove the worktree, delete the branch, tick the task in §8.
6. A wave closes when all its tasks are merged. The next wave's branches are created from
   that `main`.

## 6. Change requests across ownership

If a task needs a change in a file it does not own:

1. Stop that part of the work. Write the request in `changes/requests/<from-id>-to-<owner-id>.md`
   (file, change, reason). Commit it on the task branch.
2. The owner task (or the integrator, for integration files) makes the change in its own
   branch. If the owner task is already merged, a new S-task is opened in the same wave.
3. The requesting task continues against the new `main` after a rebase.

Typical requests:

| Need | Owner |
|---|---|
| New dependency | I-task |
| New field in `PackageSpec` | I-task (`src/core/types.ts`) |
| Change in `tools/shared.ts` | C01 / C02 |
| New fake in `src/core/fakes/` | the C-task of the wave, or an I-task |
| A symbol from another lane | the owning lane (add a new export; never edit the old one) |

## 7. Conflict hotspots

| File | Owner | How others get a change in |
|---|---|---|
| `src/index.ts` / `src/server/*` | I01, then C01 (`errors.ts`), P04, B01 | request (§6) |
| `src/tools/index.ts` | I | request; a new package gets one line |
| `src/mcp/annotations.test.ts` | I00, then fragments by lane | edit your own fragment |
| `CHANGELOG.md` | release I-tasks | write `changes/unreleased/<id>.md` |
| `src/tools/shared.ts` | C01, C02 (split into `shared/list.ts`) | request |
| `src/mcp/define.ts` | C03 → C06 | request |
| `src/mcp/doctor.ts` | X03, then per-lane probe files | edit your lane's probe file |
| `src/core/settings.ts` | C04, C04b, B02 | request |
| README tool tables, `manifest.json`, `server.json`, `.env.example` | generated | `npm run metadata` |

## 8. Dependency graph

```text
Wave A   U-A1 → I-A1 → I-A2 → U-A2
                         │
Wave 0   I00  I01  X01  X02  X03  X04  X05  X06  X07     (parallel)
                │              │
Wave 1   C02  C05   C01(I01) → C03 → C06   C04(X03)       (parallel)
                │
Wave 2   L2.core  L2.reader  L2.posts  L2.insights  L2.moderation  L2.messages  L2.ads  L2.page-admin
                                                   └──────────── all ────────────┘
                                                                  → C01b
Wave 3   I30 → I31 → U30 → I32 (1.0.0)
Wave 4   P01 (freeze) → { P02  P03  P04  P05  L4.*  C04b } → I40 (2.0.0)
Wave 5   A01  A02 → L5.*  A03  A04 → A05  A06  A07  A08  A09  A10  → I5x (2.x)
Wave 6   U60 → { B01 → B03 → C60 → L6r.*,  B02,  B04,  L6.* } → I60 (3.0.0)
```

## 9. Dispatch checklist (per wave)

- [ ] The owner decisions that block this wave are recorded in [doc 03](03-owner-decisions.md).
- [ ] The previous wave is fully merged, and `main` is green.
- [ ] Number of parallel tasks ≤ the V3-D11 limit.
- [ ] Each task has a worktree under `~/Development/_branches/facebook-mcp-<id>` and a branch
  `task/<id>-<slug>`.
- [ ] Each agent got the briefing (§10).
- [ ] No two open tasks share a file in *Owns* (check the tables in §3–§4).
- [ ] After the wave: every worktree removed, every task branch deleted.

## 10. Agent briefing template

Each agent (or session) gets exactly this, and nothing else is in scope:

```text
Task: <ID> — <title>                      Wave: <n>
Branch: task/<id>-<slug>
Worktree: ~/Development/_branches/facebook-mcp-<id>
Owns (only these files, plus their colocated tests): <list>
Depends (already in main): <IDs>
Contract to follow: <doc or C-task output, e.g. docs/error-catalog.md>
Lane checklist: <the wave-2/4/6 checklist items for this lane>
Out of scope: every other file. For a change elsewhere, write changes/requests/<id>-to-<owner>.md and stop that part.
Done when: §2 definition of done is green. Commit on the branch; do not merge, do not push.
```

## 11. Task status

| Wave | Tasks | Merged |
|---|---|---|
| A | U-A1, I-A1, I-A2, U-A2 | U-A1, I-A1, I-A2 (2026-10-28: PR #41 recorded as merged, superseded by `c7ce5b8`; zod ^4.6.7 for GHSA-mrhx-c7xc-m3w5; 0.8.0 on npm). U-A2 open |
| 0 | I00, I01, X01–X07 | — |
| 1 | C01–C06 | — |
| 2 | L2.* (8), C01b | — |
| 3 | I30–I32, U30 | — |
| 4 | P01–P05, L4.*, C04b, I40 | — |
| 5 | A01–A10, L5.*, I5x | — |
| 6 | U60, B01–B04, C60, L6.*, I60 | — |
