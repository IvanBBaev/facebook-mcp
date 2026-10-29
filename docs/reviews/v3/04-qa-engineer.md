# v3 review 04 — Senior QA / Test Engineer

- **Role:** Senior QA / Test Engineer. This is an independent, adversarial review of what the
  test suite proves, not of what the code intends.
- **Date:** 2026-10-29
- **Scope:** `@ivanbaev/facebook-mcp` 0.8.0 at commit `2c8d8bd` (main). Wave 0 is merged. C05 (the
  stable insights schema) has landed expand-only.
- **Method:**
  - I read the 2026-07 QA review (`docs/reviews/04-qa-engineer.md`), the v3 roadmap
    (`docs/analysis/v3/04-roadmap-and-risks.md`, `05-parallel-task-breakdown.md`),
    `package.json`, `.c8rc.json`, `.github/workflows/ci.yml`, `test/fixtures/*` and
    `scripts/smoke/*`. I also read the code and tests on the critical paths.
  - I built and ran the whole suite in an **isolated copy** (`git archive HEAD`) on Node 26.12.1:
    **3241 tests, 3241 pass, 0 fail**. The run took about 6.7 s, and build plus test took about 10.9 s.
  - I ran `npm run coverage` in the same copy: **Statements 99.38 / Branches 92.07 /
    Functions 99.41 / Lines 99.38**. The gate is 95/85/95/95.
  - I ran **18 hand-written mutation probes**. Each was applied to the isolated copy, the copy
    was rebuilt with `tsc`, the full suite was run with `--test-timeout=20000`, and the mutation
    was reverted. The results are in §5.
  - The smoke harness was **not** run against the live Graph API. Only its offline rehearsal
    runs, and that happens inside `npm test` (`src/smoke-rehearsal.test.ts`).
  - Nothing in the real working tree was modified except this file.

---

## 2. Verdict

**Ready-with-changes** for the next minor (0.9 / wave 1). **Not yet ready for 1.0.** The 1.0 gate
depends on three things that do not exist as committed artefacts today: a full `tools/list`
contract snapshot, recorded (not synthetic) fixtures for the ads/spend surface, and the U30 live
evidence.

1. The hermetic suite is unusually strong. Every mutation on the money, confirm, gate and
   redaction paths except one was killed, and assertions are behavioural, not coverage padding.
2. However, 9 of the 18 mutants were killed by exactly **one** test. During waves 1–2 (C01
   error envelope, the L2 lanes) a rewritten or deleted test silently removes the guard.
3. "Fake fidelity" is the weakest link. Of the 9 fixtures, 2 are labelled recorded but are
   synthetic and point at `v21.0`. There are no ads fixtures at all, and ads writes have zero live
   evidence.
4. Contract safety for P01 (the SDK v2 swap) and R5 rests on a snapshot test that does not exist.
   `annotations.test.ts` freezes names and hints, but not schemas, descriptions or results.
5. The runner is fragile in two ways. Tests execute out of a shared, in-place `build/`. There is no
   `--test-timeout`, so one class of regression shows up as a hang instead of a red test.

**Counts:** 0 Blocker · 7 Major · 6 Minor · 2 Nit (15 findings).

---

## 3. Status of the 2026-07 findings

| # | 2026-07 finding | Status at `2c8d8bd` | Evidence |
|---|---|---|---|
| 1 | Blocker — live smoke safety (test Page, markers, sweeper, ads) | **Closed** (offline). Live run not yet done. | `scripts/smoke/env.mjs:57-59` (gate is exactly `'1'`), `nonce.mjs:17` (`FBMCP-SMOKE`), `sweepers/*.sweep.mjs`, `graph-escape.mjs:20-35` (one Page, one object kind, owner check) |
| 2 | Major — upload flows versus the `withFetch` seam | **Mostly closed** | `src/core/http-upload.test.ts`, `src/api/media-video.test.ts`. But see QA-05: `upload-session.ts` is not adopted. |
| 3 | Major — fixture sourcing, sanitization and drift | **Tooling closed, data open** | `scripts/record-fixture.mjs`, fixture-lint, `fixture-shape-diff`. Fixtures themselves are synthetic or stale (QA-03), and there are no ads fixtures (QA-02). |
| 4 | Major — ambiguous-write retry | **Closed** | `src/core/http.ts:488-501`, `1452`, `1512`; probes M01–M04 killed |
| 5 | Major — token invalidation mid-session (190) | **Closed** | `src/core/http.test.ts:1259-1271` (190/463 matrix row), `src/core/error-matrix.test.ts` |
| 6 | Major — clock seam | **Closed in the core, leaking in places** | `src/core/fakes/fakeClock.ts`; real timers remain (QA-09), and the retry backoff is not fake-clocked on the write-ambiguous path (QA-04) |
| 7 | Major — redaction suite | **Closed** | `src/core/redact.test.ts` (547 lines); probe M13 killed |
| 8 | Major — client-side media validation | **Closed for photos and ads media** | `src/api/media-photos.ts`, `src/api/ads-media.ts` |
| 9 | Major — pagination edge semantics | **Mostly closed** | `src/api/shared.ts:184-221`. Probe M14 was killed only incidentally (QA-14). |
| 10 | Minor — CI/live network boundary | **Closed** | `src/testing/network-fence.ts`, loaded by `package.json:43` |
| 11 | Minor — coverage floors | **Closed, but not ratcheted** | `.c8rc.json` 95/85/95/95 against actual 99.4/92.1/99.4/99.4 (QA-08) |
| 12 | Minor — build-first freshness | **Open** | `package.json:43` `test` does not build. Only `check` (`:54`) does. See QA-04. |
| 13 | Minor — missing test categories | **Partially open** | No property-based or fuzz tests (no `fast-check` in `package.json`). Contract snapshot is missing (QA-01). Conformance is missing (QA-10). |
| 14 | Minor — plan/apply divergence | **Closed** | `src/mcp/write-mode.ts:961` (`computeDivergence`), `555-625` |
| 15 | Minor — live-unverifiable tools | **Closed as documentation** | `scripts/smoke/smokes/ads.smoke.mjs:795-815` (`ads/update-not-covered`); the same pattern is used in posts, messages and core |
| 16 | Nit — usage-header parsing | **Closed** | `src/core/http.test.ts`, `src/core/types.test.ts` |
| 17 | Nit — self-guarding ergonomics | **Closed** | network fence; smoke `plan`/`rehearse`; refusal exit 2 |

**Net:** 11 closed, 4 partially closed, 1 open (and one more, #6, leaking). None of the old
Blocker or Majors survives in its original form. What survives is a **data** problem (fixtures,
live evidence), not a test-design problem.

---

## 4. Strengths to keep

- **Behavioural, intention-named tests.** Test names state the invariant, for example
  `"authorize: irreversible/spend never honor the FB_WRITE_MODE=apply default (Security #3)"`
  and `"only an explicit boolean true from elicitation is an approval"`. When one fails it explains
  itself, and reviewers can map tests to risks.
- **Boundary tests on money exist and are exact.** `"CC-ADS-7: a budget exactly at the ceiling is
  allowed"` killed the `<=`→`<` mutant (M09). The spend-cap set/raise/lower matrix killed M10.
- **The allowlist posture is tested from the negative side.** `"a tier the gate does not recognise
  is gated like a high-consequence one"` is the test that matters most for an allowlist, and it exists.
- **The confirm seam is tested against hostile wire values.** Truthy non-booleans, `null` and `''`
  tokens are all covered (`src/mcp/confirm.ts:146-149`, `:185`).
- **Hermeticity is enforced, not assumed.** The network fence is preloaded for every test run
  (`package.json:43`), and CI holds no secrets.
- **A frozen annotation manifest.** `src/mcp/annotations.test.ts:1-33` freezes the full hint
  quadruple per tool in both directions (registry ⇄ table). Keep it, and extend it (QA-01).
- **Smoke harness design.** It has an offline `plan`, an offline `rehearse` against a loopback fake
  that fails on any unmodelled route, a gate that is exactly `FB_SMOKE=1`, nonce markers,
  sweepers, a "NOT EXERCISED" outcome distinct from PASS, and a raw-Graph escape hatch confined to
  one Page and one object kind (`scripts/smoke/graph-escape.mjs:20-35`). This is better than most
  commercial SDK harnesses.
- **Speed.** About 3.2k tests in about 7 s keeps the gate cheap enough that agents run it.

---

## 5. Test-strength probe results

Each mutant was applied to an isolated copy, compiled, run against the full suite with a 20 s
per-test timeout, and reverted. "Killing test(s)" names the assertions that failed.

| ID | Critical path | Mutation | Caught? | Killing test(s) (count) |
|---|---|---|---|---|
| M01 | Retry: 5xx on write | `retryVerdict` transient → `retry` for writes (`http.ts:488-501`) | **Yes, but only by timeout** | `"C2 / CC-NET-5: a 5xx on a write is ambiguous and never retried"` plus 4 others, all as **20 s timeouts**, not assertion failures. Without `--test-timeout` the first run hung for more than 5 min (QA-04). |
| M02 | Retry: not-sent proof | add `ECONNRESET` to `CONNECT_PHASE_CODES` (`http.ts:~503-508`) | Yes | `isProvablyNotSent…`, 2 multipart tests, the journaling test (4) |
| M03 | Retry: Graph code 1/2 on write | disable the transient-code → ambiguous conversion (`http.ts:1512`) | Yes | `"C2: a transient Graph code (1/2, or is_transient) on a write is ambiguous at any HTTP status"` (**1**) |
| M04 | 2xx error envelope | treat a 2xx envelope as data (`http.ts:1452`) | Yes | 4 envelope tests plus C2 (5) |
| M05 | Write gate: spend tier | `tierGated = tier === 'irreversible'` (`write-mode.ts:128`) | Yes | 7, including Security #3 |
| M06 | Plan binding: Page | skip the `plan.pageId` check (`write-mode.ts:593`) | Yes | `"an apply against a different Page than the plan is rejected as plan_mismatch"` (**1**) |
| M07 | Plan TTL boundary | `expiresAt <= now` → `<` (`write-mode.ts:572`) | Yes | `"regression: expiry is enforced on the apply itself…"` (**1**) |
| M08 | Env bypass allowlist | add `'spend'` to `ENV_BYPASSABLE_TIERS` (`write-mode.ts:69-72`) | Yes | 10 |
| M09 | Budget ceiling boundary | `requested <= ceiling` → `<` (`ads-money.ts:176`) | Yes | `"CC-ADS-7: a budget exactly at the ceiling is allowed"`, spend-cap max (2) |
| M10 | Lowering exemption | `requested < current` → `!==` (`ads-money.ts:177`) | Yes | 4 |
| M11 | Elicitation truthiness | `Boolean(outcome?.confirmed)` (`confirm.ts:185`) | Yes | `"only an explicit boolean true from elicitation is an approval"` (**1**) |
| M12 | Token fall-through | `perCallToken ?? resolver()` (`confirm.ts:146-147`) | Yes | `"a supplied-but-empty confirm_token is a refusal…"` (**1**) |
| M13 | Redaction `EAA` charset | drop `_-` from `/EAA[A-Za-z0-9_-]{20,}/` (`redact.ts:90`) | Yes | `"an allowlisted value is redacted before it reaches the log"` (**1**) |
| M14 | Pagination `hasNext` | also true when `cursors.after` is present (`shared.ts:209`) | Yes, **incidentally** | `"listAlbums reads /{page-id}/albums … maps the fixture"` (**1**, a fixture-mapping test, not a `parsePage` unit) |
| M15 | Upload overrun | `acked > total` → `acked > total + 1` (`media-video.ts:1224`) | **No — survived** | none (QA-05) |
| M16 | Refused chunk | treat a refused chunk as landed (`media-video.ts:1223`) | Yes | `"a chunk answered 2xx with success:false and no offset is not counted as landed"` (**1**) |
| M17 | Spend tier wiring | targeting `executeWrite` tier `spend` → `reversible` (`targeting.ts:219`) | Yes, **narrowly** | `"a targeting edit previews before → after as a spend write…"` (**1**, a label assertion; QA-07) |
| M18 | 429 handling | HTTP 429 → `transient` (`http.ts:470`) | Yes | 6 |

**Score:** 17 of 18 killed (94 %). **9 of the 17 kills rest on a single test** (M03, M06, M07, M11,
M12, M13, M14, M16, M17), and one (M01) is detected only as a timeout.

- The M16 run also showed three spawn-based tests with durations of about 1,012 s (`src/index.test.ts:2771`,
  `src/launcher.test.ts`, `src/fixture-shape-diff.test.ts`). These are not related to the mutant.
  The cause is either host suspension or load; I could not attribute it, but it reinforces QA-04.

---

## 6. Findings

### QA-01 — Major — No committed `tools/list` / result contract snapshot; P01 and R5 depend on one

- **Evidence:**
  - `src/mcp/annotations.test.ts:1-33` freezes only tool names and the four annotation booleans.
    It explicitly does not freeze `inputSchema`, `outputSchema`, `title` or `description`.
  - `src/index.test.ts:250-265` lists the tools but asserts only names, `readOnlyHint` and
    `inputSchema.type === 'object'`.
  - Doc 05 says wave 0 kept `tools/list` byte-identical: "Prove it with a before/after snapshot of
    `tools/list` in the PR description" (`docs/analysis/v3/05-parallel-task-breakdown.md:147-148`,
    `:377`).
  - P01 ships "`tools/list` snapshot" as part of the freeze task itself (`05…:235`).
  - R5 mitigation is "snapshot tests of `tools/list` and results" (`04-roadmap-and-risks.md:40`).
  - There is no golden file under `test/` and no snapshot test in `src/`.
- **Risk:**
  - The byte-identical claim for wave 0 is unverifiable after merge.
  - Waves 1–2 (C01 envelope, C02 list contract, C03 `outputSchema`, C06 aliases, all L2 lanes)
    intentionally change the surface. Without a golden they cannot be reviewed as a diff.
  - P01 would create the snapshot in the same PR that swaps the SDK and zod. A baseline taken
    after the swap proves nothing about the swap.
  - Schema drift caused by zod or SDK serialisation (key order, `additionalProperties`, `$schema`,
    defaults) is exactly what R5 describes, and it is invisible to every current test.
- **Recommendation:**
  - Add `src/contract/tools-list.contract.test.ts`. It should run the real registry with the `all`
    profile, normalise the result (sort keys, strip volatile fields), and compare it with
    `test/contract/tools-list.all.json` and `…default.json`.
  - Updates go through `UPDATE_CONTRACT=1 npm test`, so the diff is the review.
  - Add result goldens for about 12 representative tools: one read per package, one write preview,
    one ambiguous error, one refusal, one CSV export. Responses are canned through `fakeFbRequest`.
  - Record the 0.8.0 baseline **now**, from tag `v0.8.0`, so the wave-0 claim becomes checkable
    retroactively.
- **Roadmap:** NEW, wave 1, first task (before C01–C06). Contract type, owner C. Owns
  `src/contract/*`, `test/contract/*`. Every later C/L/P task then updates the golden in its own PR.
  P01's "`tools/list` snapshot" becomes "diff the existing golden".
- **Size:** M

### QA-02 — Major — Spend-tier writes have neither recorded fixtures nor live evidence; fake fidelity is unproven where money moves

- **Evidence:**
  - `test/fixtures/` holds 9 JSON files and no `ads/` directory. The README documents
    `test/fixtures/ads/<ads-version>/` (`test/fixtures/README.md:66`), and `--ads` recording exists
    (`src/record-fixture-ads.test.ts`), but nothing has been recorded.
  - The ads smoke states "Nothing in this file creates, changes or deletes remote state"
    (`scripts/smoke/smokes/ads.smoke.mjs:8`).
  - `ads/update-not-covered` defers the update to manual operator steps (`:795-815`).
  - Boost, campaign create, spend cap and targeting therefore exist only against hand-written
    fakes.
  - Coverage confirms the thinness: `src/tools/ads-create.ts` is at 65.6 % branches (uncovered 239–242),
    `src/tools/ads/copy.ts` at 60 %, and `src/api/ads-create.ts` at 83.5 % (uncovered 483–486,
    892–900).
- **Risk:**
  - The only proof that a refusal, preview or plan matches what Graph v26 actually returns for
    `act_*/campaigns`, `adsets`, `targeting` and `spend_cap` is the author's reading of the docs.
  - A field rename or error-code shape change breaks the money path silently, and
    `fixture-shape-diff` has nothing to diff.
- **Recommendation:**
  - Make recorded ads fixtures an explicit U30 output. Read edges and write *responses* (including
    `spend_cap` refusal envelopes) should be captured with `record-fixture.mjs --ads` on the
    disposable ad account.
  - Then convert `src/api/ads-*.test.ts` canned bodies to `loadFixture()` where a fixture exists.
  - Add a fixture-coverage check that every `writeTier: 'spend'` tool has at least one fixture-backed
    test.
  - Raise per-file branch floors for spend files (QA-08).
- **Roadmap:**
  - U30 (owner U) records the fixtures.
  - NEW `L2.ads-fixtures` (lane L, ads; owns `test/fixtures/ads/v26.0/*`, `src/api/ads-*.test.ts`)
    adopts them before I32.
  - A09 (the ads pin bump) then reuses `fixture-shape-diff --baseline ads/v26.0 --candidate ads/v27.0`.
- **Size:** M

### QA-03 — Major — Fixture provenance is false or absent; "recorded" fixtures are synthetic and on the wrong Graph version

- **Evidence:**
  - The README says `graph-me.json` and `graph-feed.json` are recorded (`test/fixtures/README.md:12-13`).
    Both are synthetic: `"name": "Example Test Page"` (`graph-me.json:3`, `graph-feed.json:10`),
    id `100000000000001`.
  - The `paging.next` URLs point at `v21.0` (`graph-feed.json:19`, `graph-stories.json:25`), while the pin is
    `v26.0` (`src/core/settings.ts:36`).
  - No fixture carries `recorded_at`, `graph_version` or `endpoint` metadata.
  - Only `src/api/{comments,albums,page-profile,stories}.test.ts` consume fixtures. Most API tests use
    inline literals.
- **Risk:**
  - Reviewers and agents trust the README and assume real-shape coverage that does not exist.
  - Stale version strings mask a class of bugs (version-sensitive URL rewriting, cursor parsing),
    because tests do not check them.
  - Drift tooling cannot detect drift in data that was never real.
- **Recommendation:**
  - Add a sidecar `<name>.meta.json` (or a `_meta` key stripped by `loadFixture`) with `source:
    recorded|synthetic`, `graph_version`, `endpoint`, `fields` and `recorded_at`.
  - Extend fixture-lint to fail when `source` is `recorded` without `recorded_at`, and to fail any
    `graph.facebook.com/vNN` URL that does not match `DEFAULT_API_VERSION`.
  - Correct the README now.
  - Re-record `me` and `feed` during U30.
- **Roadmap:**
  - NEW, wave 1, a test-infra task owned by I. It owns `scripts/record-fixture.mjs`, fixture-lint,
    `test/fixtures/README.md` and `test/fixtures/*.json`.
  - Re-recording happens in U30.
- **Size:** S

### QA-04 — Major — The runner is fragile: shared in-place `build/`, no freshness guard, no per-test timeout, and a retry regression shows up as a hang

- **Evidence:**
  - `package.json:37`: `build` begins with `rmSync('build')`.
  - `package.json:43`: `test` runs `build/**/*.test.js` without building and without `--test-timeout`.
  - `.github/workflows/ci.yml` sets no `timeout-minutes` on any job, so GitHub's default is 360 min.
  - Observed: my first in-repo `npm run build && npm test` failed 69 test files with
    `ERR_MODULE_NOT_FOUND`, because a concurrent build in the same checkout deleted `build/`
    mid-run.
  - Probe M01: the write-retry mutant made the retry loop sleep real backoff. The first full run
    produced no output for more than 5 min. With `--test-timeout=20000`, five tests failed only as
    timeouts, and one recorded a 963,462 ms duration.
  - `spawnSync` calls without a `timeout` option: `src/fixture-shape-diff.test.ts:240`, `:299`.
- **Risk:**
  - Waves 1–2 run parallel lanes and agents. Two agents in one checkout corrupt each other's run.
  - `npm test` after a source edit silently tests stale JS, so a green result can be false.
  - A retry or backoff regression stalls CI for hours instead of failing in seconds. The real
    backoff path on writes is not on the fake clock.
- **Recommendation:**
  1. Add `--test-timeout=30000` to `test` and `coverage`.
  2. Add `timeout-minutes: 15` to every CI job.
  3. Add a `pretest` freshness guard. It fails if any `src/**/*.ts` mtime is newer than
     `build/.tsbuildinfo`, or `test` runs `tsc -b` incrementally first.
  4. Allow `BUILD_DIR` / `outDir` per worktree, or build into `build-<pid>` for test runs, so
     parallel runs do not share a directory.
  5. Inject `fakeClock` into the write-retry tests in `src/core/http.test.ts` so a mis-retry fails
     on an attempt-count assertion, not on time.
  6. Add `timeout` to every `spawnSync`.
- **Roadmap:** NEW, wave 1, integration-files task, owner I. It owns `package.json` scripts,
  `.github/workflows/ci.yml` and `src/core/http.test.ts` (clock injection only).
- **Size:** S

### QA-05 — Major — Upload resume has a surviving boundary mutant, and the X06 session tests do not guard shipped upload paths

- **Evidence:**
  - Probe M15 (`acked > total` → `acked > total + 1`, `src/api/media-video.ts:1224`) **survived**.
    The only overrun test uses offset 40 against a 12-byte file (`src/api/media-video.test.ts:949-975`),
    so it is not a boundary test.
  - The refused-chunk branch (`:1223`) is killed by one test (M16).
  - `src/api/upload-session.ts` (X06) is not imported by any media file. The only reference is a
    comment at `src/api/media-video.ts:10`. Adoption is deferred to L2.posts (`05…:377`).
- **Risk:**
  - An off-by-one in the overrun guard lets a session with `total+1` bytes acked be treated as
    in-range. That is the "finish someone else's video" scenario CC-MEDIA-3 exists to prevent.
  - When L2.posts adopts `upload-session.ts`, the shipped paths swap to code whose tests were
    written against a different seam. Coverage stays high while the behaviour under test changes.
- **Recommendation:**
  - Add boundary tests at `acked === total` (completes) and `acked === total + 1` (desync).
    Mirror them in `media-reels.test.ts` (`:1117`).
  - Before L2.posts adopts X06, port the media-video resume matrix (stall, rewind, refused,
    overrun, `maxResumes` at `:1169`/`:1243`) into a shared table-driven suite. Run it against both
    the old and new implementation (expand → migrate → contract), and delete the old one only
    in the contract step.
- **Roadmap:**
  - Boundary tests: immediately, a test-only NEW task in the posts lane (owns `src/api/media-video.test.ts`
    and `media-reels.test.ts`, size S).
  - Shared resume suite: part of L2.posts.
- **Size:** S + M

### QA-06 — Major — Nine critical guards rest on a single test; waves 1–2 will rewrite many of them

- **Evidence:** In §5, M03, M06, M07, M11, M12, M13, M14, M16 and M17 are each killed by exactly one
  test. Those tests live in files that C01 (error envelope), C02 (list contract) and the L2 lanes
  own and will edit: `src/core/http.test.ts`, `src/mcp/write-mode.test.ts`, `src/mcp/confirm.test.ts`,
  `src/core/redact.test.ts`, `src/api/albums.test.ts`, `src/api/media-video.test.ts` and
  `src/tools/ads.test.ts`.
- **Risk:**
  - A lane rewriting a test to fit the new envelope can delete or weaken the only guard.
  - The coverage number does not move, because the line is still executed by other tests.
  - The doc 05 DoD has no check for "invariant tests preserved".
- **Recommendation:**
  - Add `src/guards.manifest.test.ts`. It lists the safety-invariant test names (the 18 here plus the
    Security #N set) and fails if any is missing from the test files. This is a static scan.
  - Add a second, independent test for each single-kill invariant, preferably at the tool layer
    through `executeWrite` or the MCP client, not only at the unit.
  - Run Stryker (or the probe script used for this review, see §7) monthly on `http.ts`,
    `write-mode.ts`, `confirm.ts`, `ads-money.ts`, `redact.ts`, `shared.ts` and `media-video.ts`.
    It is advisory and should not be on CI.
- **Roadmap:** NEW, wave 1, test-only task, owner C. It owns `src/guards.manifest.test.ts` and
  additions only in the listed test files. Add a DoD line: "guard manifest green, no guard removed".
- **Size:** M

### QA-07 — Major — The write tier is declared twice per tool with no cross-check

- **Evidence:**
  - `src/tools/ads/targeting.ts:164` sets `writeTier: 'spend'` on the spec, and `:219` passes
    `tier: 'spend'` separately to `executeWrite`. The same pattern is at `src/tools/ads/control.ts:326`.
  - Nothing in `src/mcp/write-mode.ts` reads `spec.writeTier` (a grep for `writeTier` finds no hits).
  - The registry uses `writeTier` only for read-only and package posture (`src/mcp/registry.ts:190-198`).
  - Probe M17 (handler tier `spend` → `reversible`) was killed only because one test asserts the
    preview **label**.
- **Risk:**
  - A copy-paste mis-tier on any of the other spend or irreversible tools makes the write
    env-bypassable under `FB_WRITE_MODE=apply`. `ENV_BYPASSABLE_TIERS` contains `reversible`
    (`write-mode.ts:69-72`).
  - The annotation manifest would still show the spec tier, so the advertised surface and the
    enforced gate disagree silently.
- **Recommendation:**
  - Option 1: `executeWrite` asserts `tier === ctx.spec.writeTier` and throws on mismatch.
  - Option 2 (better): derive the tier from the spec and remove the argument.
  - Add a registry-wide test: for every tool with a `writeTier`, invoke the handler with a recording
    gate and assert that the authorised tier equals the spec tier.
- **Roadmap:** C03 or C01 neighbourhood, wave 1. Contract type, owner C. Owns `src/mcp/write-mode.ts`
  and `src/mcp/define.ts`. Lanes drop the duplicated argument in L2 (contract step).
- **Size:** S

### QA-08 — Minor — The coverage gate has 4–7 points of slack, the DoD calls it advisory, and ads spend files are the weak spot

- **Evidence:**
  - `.c8rc.json` sets 95/85/95/95, against actual 99.38/92.07/99.41/99.38.
  - The DoD reads "Coverage is not lowered … (advisory, not gated)" (`05…:91-92`).
  - The lowest branch coverage is in `tools/ads-create.ts` 65.6 %, `tools/ads/copy.ts` 60 %,
    `api/ads-lifecycle.ts` 77.4 %, `api/ads-media.ts` 79 %, `api/ads-copy.ts` 79.9 %, `insights-export.ts`
    74 % and `tools/activity.ts` 75.8 %.
- **Risk:**
  - Six or seven points of global slack means a lane can drop a whole file's tests without the gate
    noticing.
  - The worst-covered code is exactly the spend surface.
- **Recommendation:**
  - Ratchet the global gate to 99/90/99/99.
  - Add per-file floors for `src/api/ads-*.ts` and `src/tools/ads*/**` (branches 85).
  - Make "no decrease" mechanical: CI compares `coverage-summary.json` against `main`.
- **Roadmap:** NEW, wave 1, integration-files task, owner I (`.c8rc.json`, `ci.yml`). The ads
  backfill goes into L2.ads.
- **Size:** S

### QA-09 — Minor — Wall-clock assertions and real timers in a few tests

- **Evidence:**
  - `src/smoke-harness.test.ts:684-693` asserts `Date.now() - started < 1000`.
  - `src/smoke-harness.test.ts:666` uses a real 20 ms `setTimeout`.
  - `src/smoke-rehearsal.test.ts:244-246` measures elapsed time (assertion is lenient).
  - `src/api/insights-batch.test.ts:287` uses a real 5 ms timer inside a concurrency-peak test.
  - `src/mcp/transport.test.ts:1859` has a 5 s stall timer.
  - Under load I observed spawn tests taking more than 1000 s (§5).
- **Risk:** Flakes on loaded Windows runners and in parallel agent sessions. Today the flake
  budget is zero, which is good, but these are the likely first offenders.
- **Recommendation:**
  - Move timer-based tests to `fakeClock`.
  - For the concurrency test, use a manual deferred-release queue instead of `setTimeout(5)`.
  - Widen any remaining wall bound to at least 5× the expected time, with a comment.
- **Roadmap:** NEW, test-only, owner C or the owning lane. Size S.

### QA-10 — Minor — No MCP spec-era conformance tests until wave 4

- **Evidence:**
  - `src/mcp/transport.test.ts:202` negotiates only `LATEST_PROTOCOL_VERSION`.
  - `src/cold-start.test.ts:336` hard-codes `'2025-06-18'`.
  - There is no `src/conformance/`.
  - P04 introduces conformance tests together with the dual-era change (`05…:238`).
- **Risk:**
  - P01 changes the SDK and the negotiated version at the same time. With no pre-swap
    conformance baseline, a regression in an older era (for example a client pinned to 2025-06-18)
    is indistinguishable from an intended change.
- **Recommendation:**
  - Add a minimal era matrix **before** P01. Cover `initialize` → `tools/list` → `tools/call`
    (read, write preview, refusal) and elicitation present or absent, for each protocol version
    the 1.x SDK accepts.
  - Snapshot the frames (this pairs with QA-01).
  - P04 then extends the matrix instead of creating it.
- **Roadmap:** NEW, wave 3 (after I31, before I32), test-only, owner C. It owns `src/conformance/*`,
  which P04 later inherits.
- **Size:** M

### QA-11 — Minor — Windows coverage of the journal and config is skipped, and Windows runs only Node 22

- **Evidence:**
  - `src/mcp/journal.test.ts:38`, `:473`, `:515` (POSIX modes, FIFOs) and `src/core/config.test.ts:548`
    (mkfifo) are skipped on win32.
  - `src/index.test.ts:3557` is also skipped.
  - The `windows` CI job runs only Node 22 (`ci.yml:~100-106`).
- **Risk:** Journal file permissions on Windows (ACLs) are not asserted at all. The journal may hold
  plan summaries, so this is a privacy-relevant file.
- **Recommendation:**
  - Add a Windows-specific assertion. For example, the journal is created under the user profile
    and not world-readable, checked via `icacls` in a guarded test, or explicitly documented as
    not enforced.
  - Add Node 24 to the Windows job when P05 moves the floor.
- **Roadmap:** P05 (CI matrix) plus a NEW test-only task owned by the journal owner. Size S.

### QA-12 — Minor — Very large test files will collide across parallel lanes

- **Evidence:** Seven test files are over 2,500 lines:
  - `src/tools/posts.test.ts` 4622
  - `src/index.test.ts` 3619
  - `src/core/http.test.ts` 3417
  - `src/tools/moderation.test.ts` 3373
  - `src/mcp/doctor.test.ts` 3274
  - `src/tools/ads.test.ts` 2942
  - `src/tools/messages.test.ts` 2587

  In total there are 81.5k test lines over 93 files, against 59k source lines. "Split the large test
  files" was deferred out of wave 0 (`05…:377`).
- **Risk:**
  - In wave 2, C01b and every L2 lane touch `index.test.ts` and `http.test.ts` for envelope changes,
    which means merge conflicts and accidental test deletion during conflict resolution (see QA-06).
- **Recommendation:**
  - Split by behaviour before wave 2: `http.retry.test.ts`, `http.envelope.test.ts`,
    `http.upload.test.ts`, `index.cli.test.ts`, `index.mcp.test.ts`, and so on.
  - Do it as pure moves, with the test count asserted equal before and after.
- **Roadmap:** NEW, wave 1 tail, test-only, owner I. Size M.

### QA-13 — Minor — `parsePage` cursor semantics are pinned only incidentally

- **Evidence:**
  - M14 (`hasNext` true when only `cursors.after` exists, `src/api/shared.ts:209`) was killed only by
    a fixture-mapping test for albums.
  - `src/api/shared.test.ts` (`:668` onwards) covers element shape, not the `next`-absent-but-cursor-present
    case.
- **Risk:** C02 (list contract: "omit `nextCursor` when done") rewrites exactly this logic.
- **Recommendation:** Add explicit `parsePage` cases:
  - no `paging`;
  - `next` present with no cursors;
  - cursors present with no `next` (this one must give `hasNext: false`);
  - an empty `next`;
  - a token-bearing `next` that is never returned.
- **Roadmap:** C02 (owner C), as its first commit. Size S.

### QA-14 — Nit — Redaction and fixture-lint disagree on the `EAA` token length

- **Evidence:** `src/core/redact.ts:90` uses `/EAA[A-Za-z0-9_-]{20,}/g`, while
  `scripts/record-fixture.mjs:323` uses `/EAA[A-Za-z0-9_-]{16,}/g`.
- **Risk:** A 16–19-character tail is caught when recording but not by the runtime redactor. That is
  harmless today, but these two lists will diverge further.
- **Recommendation:** Export a single pattern from `src/core/redact.ts` and import it into the lint
  from `build/`, or add a test asserting the two are equal.
- **Roadmap:** Any wave, owner C. Size S.

### QA-15 — Nit — Wave-0 "byte-identical" evidence lives in PR descriptions

- **Evidence:** `05…:147-148`, `:377`.
- **Risk:** The proof is not reproducible from the repo.
- **Recommendation:** Once QA-01 lands, rewrite the doc 05 §11 status to cite the golden commit.
- **Roadmap:** I (docs). Size S.

---

## 7. Test strategy for waves 1–6

**Principle:** every contract change is *expand → migrate → contract*. The test suite must prove
each step separately.

| Step | What the tests must prove | Mechanism |
|---|---|---|
| Expand | Old behaviour is unchanged; the new shape is additionally available | `tools/list` golden diff shows **additions only**; result goldens for old calls are unchanged |
| Migrate | Each lane moves its tools; the old path still answers | Per-lane golden updates; alias/deprecation tests (C06) assert the old name routes to the same handler and carries the deprecation text |
| Contract | The old path is gone, nothing else changed | Golden diff shows **removals only**; guard manifest still green |

**Per wave:**

- **Wave 1 (C01–C06 + new test infra).** Land QA-01, QA-04, QA-06 and QA-08 first, as one
  "test-infra" mini-wave, before C01. Each C task attaches its golden diff. C01 needs a table-driven
  envelope test over the full `src/core/error-matrix.test.ts` matrix, asserting the new `code` for
  every row. C02 starts with QA-13. C06 needs a test that every alias appears in `tools/list` with
  `deprecated` text and identical `inputSchema`.
- **Wave 2 (L2.\* + C01b).** One lane per PR. Each PR must not delete any guard-manifest test, must
  keep the golden diff limited to its own tools, and must leave per-file coverage at or above `main`.
  L2.posts adopts `upload-session.ts` behind the shared resume suite (QA-05). L2.ads adopts the
  ads fixtures (QA-02).
- **Wave 3 (I30, I31, U30, I32 → 1.0).** QA-10's conformance baseline lands here. U30 produces
  recorded fixtures plus a smoke transcript (redacted) committed under `docs/evidence/1.0/`.
  The 1.0 golden is tagged.
- **Wave 4 (P01–P05 → 2.0).** P01's PR must show a golden diff limited to the documented
  SDK-v2 differences. Every other byte must be identical, and conformance must be green for
  each supported era. P03 (MRTR confirm) re-runs the confirm probes (M11, M12) and adds
  MRTR equivalents. P04 extends `src/conformance/*`.
- **Wave 5 (A01–A10).** A02's schema budget is computed from the same golden. A04/A05 port tests
  are run against both the in-memory and file adapters (a shared suite). A09 uses
  `fixture-shape-diff` across ads versions.
- **Wave 6 (B/C60).** Same rules as P01 for B03. C60 starts with a result-golden rewrite as its
  "expand" commit.

**Mutation probing:** keep the 18-row table in §5 as a living artefact (for example
`scripts/qa/mutations.tsv` plus a runner). Run it at each wave exit. The exit criterion is **no
survivors**, and the timeout-kills (M01) should be converted into assertion kills.

### 1.0 release-gate checklist

- [ ] `npm run check` green on Node 22/24/26, and on Windows (Node 22 at minimum).
- [ ] `npm test` and `npm run coverage` run with `--test-timeout`. Every CI job has `timeout-minutes`.
- [ ] Coverage is at least 99/90/99/99 globally and at least 85 % branches per ads file. No decrease
      against the 0.9 baseline.
- [ ] The `tools/list` golden (`all` and `default` profiles) is committed, and the 1.0 diff against
      0.8.0 was reviewed and listed in CHANGELOG.
- [ ] Result goldens exist for the representative tool set.
- [ ] The guard manifest is green, and each listed invariant has at least 2 killing tests.
- [ ] The mutation table has no survivors (M15 fixed) and no timeout-only kills (M01 fixed).
- [ ] Every fixture carries provenance metadata. There are no `vNN` URL mismatches. `graph-me`
      and `graph-feed` are re-recorded.
- [ ] Recorded `test/fixtures/ads/v26.0/` exists and is consumed by ads tests.
- [ ] Single-tier source of truth (QA-07), with a registry-wide tier test.
- [ ] Conformance baseline for every supported protocol version.
- [ ] U30 is complete: L1–L8 and P1–P7 PASS, with no "NOT EXERCISED" on spend smokes. Leftovers
      match the plan. The redacted transcript is archived.
- [ ] `smoke:plan` and `smoke:rehearse` are green on the release commit.
- [ ] Packed tarball cold-start is green on ubuntu, macos and windows (existing CI job).

---

## 8. Roadmap critique and owner decisions

**Critique:**

1. **Test infrastructure is not a task in the roadmap.** Waves 1–2 are the riskiest churn, yet the
   roadmap gives them no contract snapshot, no guard preservation and no gated coverage. The DoD
   (`05…:91-92`) explicitly makes coverage advisory. I recommend a "wave 1a" of four small tasks
   (QA-01, QA-04, QA-06, QA-08) before C01.
2. **P01 builds its own safety net.** "`tools/list` snapshot" is listed inside P01 (`05…:235`). A
   baseline captured in the PR that changes the SDK cannot detect what that PR changes. Move the
   snapshot to wave 1 (QA-01).
3. **Conformance arrives with the change it should guard** (P04 together with the dual-era change).
   Baseline it in wave 3 (QA-10).
4. **U30 is overloaded.** It is the only source of live evidence, and per QA-02 and QA-03 it should
   also be the fixture-recording session. Make that explicit in its row, or split it into U30a (live
   gate) and U30b (fixture capture, ads included).
5. **Deferring "split the large test files" is a wave-2 hazard** (QA-12). It should come before the
   lanes fan out, not after.
6. **R5's mitigation is described as if it exists.** Update `04-roadmap-and-risks.md:40` to
   reference the QA-01 task ID once it is created.

**Owner decisions needed:**

- **D-QA-1:** Accept a wave-1a test-infra mini-wave (QA-01, QA-04, QA-06, QA-08) gating C01, or fold
  each item into the first C task that needs it.
- **D-QA-2:** Gate coverage per PR (ratchet against `main`) instead of "advisory".
- **D-QA-3:** Should recorded ads write-response fixtures be captured on the disposable ad account
  during U30? This means real but PAUSED, zero-delivery objects. If not, accept that spend-tier
  fidelity ships at 1.0 as "documented, not verified".
- **D-QA-4:** Tier source of truth. Should `executeWrite` derive the tier from the spec (a breaking
  internal API change, done in the C step), or assert equality (expand only)?
- **D-QA-5:** Should the mutation-probe runner be committed as a monthly advisory job, or kept as a
  per-wave manual QA step?
