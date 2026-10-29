# Review v3 — Senior DevOps / Release Engineer

- **Role:** Senior DevOps / Release Engineer (independent, adversarial)
- **Date:** 2026-10-29
- **Scope:** `main` at commit `2c8d8bd` ("feat(api): add the stable insights schema (expand only)"),
  16 commits after the `v0.8.0` tag. Covers CI, CodeQL, Dependabot, the release pipeline, the
  release runbook, packaging (npm tarball, MCPB bundle, MCP registry `server.json`, Claude plugin
  and marketplace), repository settings on GitHub, and the v3 roadmap
  (`docs/analysis/v3/04-roadmap-and-risks.md`, `docs/analysis/v3/05-parallel-task-breakdown.md`).
- **Previous review:** `docs/reviews/05-devops-release-engineer.md` (2026-07, design-time).
- **Method:** read-only. Nothing was changed on GitHub or npm, and no package was installed.
  Commands run (all read-only):
  - `npm pack --dry-run --json` (file list, sizes, leak check).
  - `npm run pack:mcpb` twice on HEAD into the scratchpad; a rebuild of `v0.8.0` from
    `git archive` into the scratchpad, with a SHA-256 and `diff -rq` against the published asset.
  - `npm view @ivanbaev/facebook-mcp` (versions, dist-tags, maintainers, `_npmUser`, attestations).
  - `gh api repos/IvanBBaev/facebook-mcp` plus `/branches/main/protection`, `/rulesets`,
    `/tags/protection`, `/environments`, `/actions/permissions`,
    `/actions/permissions/workflow`, `/actions/secrets`, `/actions/variables`,
    `/dependabot/secrets`, `/vulnerability-alerts` and `security_and_analysis`.
  - `gh run list` / `gh run view --log` for `ci.yml` and `release.yml` (runs 40753409346 = v0.8.0
    release, 40939856241 = latest CI on `main`), `gh release view v0.8.0`, `gh pr list` (Dependabot).
  - Line-by-line reading of `.github/workflows/{ci,codeql,release}.yml`, `.github/dependabot.yml`,
    `docs/runbooks/release.md`, `package.json`, `bin/facebook-mcp.mjs`, `scripts/gen-metadata.mjs`,
    `scripts/metadata.config.mjs`, `scripts/pack-mcpb.mjs`, `scripts/fold-changes.mjs`,
    `server.json`, `manifest.json`, `.claude-plugin/{plugin,marketplace}.json`, `CHANGELOG.md`,
    `.npmrc`, `.nvmrc`, `.gitattributes`.
- Secrets are referenced by **name only**. No secret value was read or printed.

## 1. Verdict

**At-risk today, good-with-changes once OPS-01 and OPS-02 are closed.** The workflow code is
well above the norm for a single-maintainer OSS project. The repository settings and the
operating practice around that code do not deliver the guarantees the code and the runbook claim.

Summary:

1. `release.yml` is carefully engineered: SHA-pinned actions, per-job least privilege, a
   commit-equality assertion, an attested MCPB bundle, and a SHA-pinned `mcp-publisher` with OIDC.
2. **0.8.0 was published with the long-lived `NPM_TOKEN` bootstrap secret, not OIDC.** The secret
   is still in the repository about 64 days after it was created. The runbook says it lives 7 days.
3. **`main` has no branch protection, no ruleset and no tag protection.** Any push of a `v*.*.*`
   tag releases to npm, GitHub Releases and the MCP registry without "CI green on this SHA".
4. Distribution surfaces drift outside the release rail. The Claude plugin runs unpinned
   `npx -y`, the marketplace tracks `main`, there is no `exports` map, Dependabot has 6 stale PRs,
   and the rollback runbook covers npm only.
5. The roadmap has no release/supply-chain risk, no bus-factor item and no task that owns
   repository settings. Most fixes are S-size and fit into existing I-tasks (I32, P05, B04) or
   one new I-task in wave 1.

| Severity | Count |
|---|---|
| Blocker | 2 |
| Major | 6 |
| Minor | 10 |
| Nit | 4 |

## 2. Status of the 2026-07 findings

The 2026-07 review numbered its findings 1–15 without a prefix. They are listed here as `R1-NN`.

| ID | 2026-07 finding | Status 2026-10-29 | Evidence |
|---|---|---|---|
| R1-01 | npm name not reserved | **Resolved** | `@ivanbaev/facebook-mcp` published (0.7.0, 0.8.0) |
| R1-02 | Five metadata surfaces, no generation | **Resolved** | `scripts/gen-metadata.mjs` generates package.json fields, `server.json`, `manifest.json`, plugin, marketplace, `.env.example`, README blocks; `metadata:check` in CI (`ci.yml:35-46`) and gate (`release.yml:420-421`) |
| R1-03 | Node 20 EOL baseline | **Resolved** | `engines >=22`, `.nvmrc` 22, matrix 22/24/26 (`ci.yml:14-28`) |
| R1-04 | stdout purity / dotenv foot-gun | **Resolved (ops view)** | 3-OS `npx` cold-start gate (`ci.yml:118-133`); dotenv pinned `^18`; deeper check left to the QA review |
| R1-05 | No secret-free CI invariant | **Resolved for CI** | `ci.yml` uses no secrets; `permissions: contents: read` (`ci.yml:10-11`) |
| R1-06 | Prefer Trusted Publishing over `NPM_TOKEN` | **Regressed in practice** | Designed for OIDC (`release.yml:8-36`), but 0.8.0 shipped via `NPM_TOKEN` and the secret is still present (OPS-01) |
| R1-07 | `mcp-publisher` device flow, unpinned binary | **Resolved** | Pinned 1.8.1 plus in-repo SHA-256, `github-oidc` (`release.yml:806-833`) |
| R1-08 | MCPB outputs and gate unspecified | **Resolved** | `scripts/pack-mcpb.mjs`, CI `bundle` job (`ci.yml:145-155`), attestation (`release.yml:680-683`) |
| R1-09 | Windows `chmod 0600` no-op, XDG fallback | **Not re-verified** | `win32` handling exists in `src/core/settings.ts` and `src/core/config.ts`; out of OPS scope this round |
| R1-10 | No semver / deprecation policy | **Partial** | `docs/insights-schema.md` defines breaking for one schema; no package-wide policy, and no `exports` map (OPS-05) |
| R1-11 | CodeQL, Dependabot, pinning absent | **Resolved, with hygiene gaps** | `codeql.yml`, `dependabot.yml`, SHA pins everywhere; but security updates off, 6 stale PRs, SHA pinning not enforced (OPS-06, OPS-16) |
| R1-12 | "No install scripts" policy | **Resolved** | `guard:no-install-scripts` script; `--ignore-scripts` in privileged jobs (`release.yml:541`) |
| R1-13 | Node baseline in five places | **Regressed** | Now about 10 hand-maintained places (OPS-11) |
| R1-14 | Lockfile policy unstated | **Resolved** | `package-lock.json` committed, `npm ci` everywhere |
| R1-15 | `npx` staleness / latency | **Open** | Plugin runs unpinned `npx -y` (OPS-03) |

Score: 9 resolved, 1 partial, 1 open, 2 regressed, 1 not re-verified, 1 resolved for CI only.

## 3. Strengths to keep

- **SHA pinning everywhere.** checkout v7.0.1 `3d3c42e5…`, setup-node v7.0.0 `82076278…`,
  CodeQL v4.37.7 `ff2f1c62…`, attest-build-provenance v4.2.2 `4d101475…`, each with a version comment.
- **Per-job least privilege.** The workflow default is read. `id-token: write` exists only in
  `npm-publish`, `bundle` and `mcp-registry`; `contents: write` only in `github-release`.
- **Commit-equality assertion.** `npm-publish` re-checks that it builds the commit the gate
  resolved (`release.yml:498-509`). That closes the classic "tag moved during the run" race.
- **Dist-tag derivation** from the version, so a prerelease can never become `latest`
  (`release.yml:255-279`).
- **npm publish is ordered after the bundle** (`release.yml:472-476`). A broken MCPB no longer
  leaves an npm version without a bundle.
- **Attested bundle.** The bundle is verified (SHA-256 and `gh attestation verify`) before upload
  (`release.yml:712-731`).
- **Pinned `mcp-publisher`** with an in-repo digest, and a bounded wait for npm visibility before
  registry publish (`release.yml:852-878`).
- **Defensive npm scripts.** `prepublishOnly` refuses outside Actions unless
  `ALLOW_LOCAL_PUBLISH=1`; `preversion` refuses `npm version`.
- **Real-user CI gates.** A cold-start `npx` gate on three OSes, a bundle build gate in CI, and a
  metadata SSOT drift gate.
- **Clean npm tarball.** 272 files, 792,642 B packed, 2,706,751 B unpacked. No tests, fixtures,
  fakes or `.env` leak (`npm pack --dry-run`).
- **Reproducible bundle content.** The MCPB uses fixed 1980 timestamps, mode 0644 and sorted
  entries. The content is byte-identical across rebuilds (see OPS-10 for the compression caveat).
- **Changelog fragments** (`changes/unreleased/`, `scripts/fold-changes.mjs`) remove the
  `CHANGELOG.md` merge hotspot.
- **Runbook quality.** A thorough failure table, resume mode and a "safe to re-run" matrix
  (`docs/runbooks/release.md:456-494`).
- **Secret scanning and push protection** are enabled.

## 4. Findings

### OPS-01 — `NPM_TOKEN` is still present and 0.8.0 was published with it, not via OIDC

- **Severity:** Blocker
- **Evidence:** `gh api …/actions/secrets` lists `NPM_TOKEN` (created 2026-08-25, updated 2026-08-26). `release.yml:554-582` passes `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` whenever the secret exists. The run log of 40753409346 (v0.8.0) contains the job's own warning, "Publishing with the NPM_TOKEN bootstrap credential, not OIDC", followed by "npm identity for this token: ivanbaev". `npm view` shows `_npmUser` for 0.8.0 as the maintainer's personal account. The runbook says the token is a 7-day bootstrap to delete after the first release (`docs/runbooks/release.md:132-152`; `release.yml:14-23`, `549-553`).
- **Risk:** The headline supply-chain property, "no long-lived publish credential", is false. Anyone who can push a tag or edit `release.yml` (OPS-02) can exfiltrate a token that publishes as the owner's account. Provenance is signed, but the publish identity is a personal token, so the trust story in the README and runbook is inaccurate. Whether npm Trusted Publishing is configured at all is unverified. If it is not, deleting the secret will break the next release.
- **Recommendation:** On npmjs.com, confirm or configure the trusted publisher: repo `IvanBBaev/facebook-mcp`, workflow `release.yml`, and an environment if OPS-07 adds one. Revoke the token on npmjs.com, then delete the `NPM_TOKEN` repository secret. In `release.yml`, turn the warning into a hard failure unless an explicit `bootstrap` dispatch input is set. In the release verify step, assert that `_npmUser` is the GitHub Actions identity. Set npm package setting "require 2FA and disallow tokens" once OIDC is proven.
- **Roadmap:** before any further tag. Owner action (U) for the npm-side settings plus
  **NEW I-task "I1R — release rail hardening"** (wave 1, owns `.github/workflows/release.yml`,
  `docs/runbooks/release.md`) for the hard failure and the `_npmUser` assertion.
- **Size:** S

### OPS-02 — No branch protection, rulesets or tag protection; any tag push releases

- **Severity:** Blocker
- **Evidence:** `gh api …/branches/main/protection` returns 404, `…/rulesets` returns `[]`, and there is no tag protection. `release.yml:79-93` triggers on any `push` of `v*.*.*`. The gate (`release.yml:137-450`) does not check that the tagged commit is reachable from `main`, nor that `ci.yml` succeeded on that SHA. The runbook says so: per-release preconditions ask the human to check CI (`docs/runbooks/release.md:166-173`). In the v0.8.0 cut, the tag push (19:20:25) followed the CI completion on `main` (19:20:02) by 23 s, so correctness relied on human timing.
- **Risk:** A force-push to `main`, a tag on a feature branch, or a compromised PAT or session can release unreviewed code to three registries. `main` can be force-pushed, rewriting the history that provenance points at. The repository is public, and an external PR (#41) has already been merged.
- **Recommendation:** Add a ruleset on `main`: no force-push, no deletion, require PR, and require the `ci.yml` and `codeql.yml` checks. The owner bypass is acceptable for a solo maintainer. Add a tag ruleset on `v*`: only the owner may create tags, and no update or delete. In the gate, add `git merge-base --is-ancestor "$SHA" origin/main` and a `gh api …/commits/$SHA/check-runs` assertion that the `ci.yml` jobs concluded `success` (`actions: read` is enough).
- **Roadmap:** owner action (U, GitHub settings) now. Gate checks in **NEW I1R** (wave 1).
- **Size:** S

### OPS-03 — Claude plugin runs unpinned `npx -y`; marketplace tracks `main`

- **Severity:** Major
- **Evidence:** `.claude-plugin/plugin.json:16` runs `npx` with `-y @ivanbaev/facebook-mcp` and no version. `.claude-plugin/marketplace.json:14` has `"source": "./"`, so plugin metadata comes from the default branch, not from a release. HEAD is 16 commits past `v0.8.0` but still stamps `0.8.0` (OPS-20).
- **Risk:** Plugin users get whatever `latest` resolves to at spawn time, including a version deprecated after a rollback. The plugin manifest users install describes unreleased `main`, while the server it launches is the last npm release. These can disagree (tool list, env vars). A poisoned `latest` publish (OPS-01) would propagate instantly to every plugin user. This is the 2026-07 finding R1-15, still open.
- **Recommendation:** Generate `plugin.json` with `@ivanbaev/facebook-mcp@<version>` from the SSOT in `gen-metadata.mjs`. Point the marketplace at a release ref (a tag or a `release` branch), or document that `main` is always release-equal. Add the plugin to the rollback procedure (OPS-08).
- **Roadmap:** wave 3, extend **I32** (1.0.0 cut) or NEW I1R. `scripts/gen-metadata.mjs` and
  `scripts/metadata.config.mjs` are integration files.
- **Size:** S

### OPS-04 — The release gate re-runs less than CI; "CI green on this SHA" is not enforced

- **Severity:** Major
- **Evidence:** The gate runs `npm run check`, `metadata:check` and audit (`release.yml:411-450`) on Node 22 on Linux only. It does not run the cold-start matrix (`ci.yml:118-133`), Windows (`ci.yml:96-106`), Node 24/26 (`ci.yml:14-28`) or coverage (`ci.yml:83-93`). Nothing links the release run to a successful `ci.yml` run (see OPS-02).
- **Risk:** A tag on a commit whose Windows or `npx` cold-start leg is red still ships. These are exactly the regressions users of an `npx`-launched MCP server feel first.
- **Recommendation:** Convert `ci.yml` to also expose `on: workflow_call`, and call it from the gate (`uses: ./.github/workflows/ci.yml`). The release gate then equals CI by construction. Alternatively, keep the check-runs assertion from OPS-02. Keep the release-only checks (surfaces, CHANGELOG section, dist-tag) in the gate.
- **Roadmap:** NEW I1R (wave 1). Must land before the I32 1.0.0 tag.
- **Size:** M

### OPS-05 — No `exports` / `types` while `main` and 134 `.d.ts` files ship

- **Severity:** Major
- **Evidence:** `package.json` has `"main": "./build/index.js"`, no `exports` and no `types`. `npm pack --dry-run` ships 134 `.d.ts` files (581,570 B, 21% of the unpacked size). The v3 plan introduces the `exports` map only in **I31** (wave 3, task breakdown line 223), in the same wave as the 1.0.0 cut.
- **Risk:** Today every file under `build/` is importable public API. At 1.0.0, semver will freeze whatever is reachable. Adding `exports` later is itself a breaking change, so it must be in 1.0.0 or wait for 2.0.0. Shipping `.d.ts` without `types` suggests a library surface that is not intended.
- **Recommendation:** Owner decision (D-OPS-1): is this package a CLI/server only, or also a library? CLI/server only: ship `"exports": { "./package.json": "./package.json" }` (and the bin), and drop `declaration` from the build or exclude `*.d.ts` via `files`. Also a library: define a minimal `exports` plus `types`, and add an `attw` or `publint` check to CI. Either way, I31 must merge before I32 and must not be optional.
- **Roadmap:** wave 3, **I31** (pull its decision forward to U-tasks now).
- **Size:** S (CLI-only) / M (library)

### OPS-06 — Dependabot hygiene: 6 stale PRs, security updates disabled, no cooldown

- **Severity:** Major
- **Evidence:** Six open Dependabot PRs: #42 (actions minor/patch, green since 2026-10-14) and five red ones. #38 eslint and #1 `@eslint/js`: superseded by `eslint ^10.13`. #3 zod: superseded by `zod ^4.6`. #37 `@types/node` 22→26. #4 typescript 5.9→7.0. The oldest is from 2026-07-22. `security_and_analysis.dependabot_security_updates` is `disabled`. `.github/dependabot.yml` groups minor/patch (10-12) but has no `open-pull-requests-limit`, `ignore` rules, cooldown or labels. `@types/node` majors will keep proposing 26 while the floor is 22.
- **Risk:** The signal is drowned. A real security PR would sit beside five ignored red PRs. With security updates off, a high advisory in a runtime dependency is only noticed when `npm audit` fails a release gate (`release.yml:439-450`), that is, at the worst moment.
- **Recommendation:** Close the superseded PRs (#1, #3, #38) and merge #42. Enable Dependabot security updates and grouped security updates. Add an `ignore` rule for `@types/node` `version-update:semver-major`, removed by P05 and B04. Add a `typescript` major ignore until a planned I-task, and a cooldown of 3–7 days for non-security updates. Add a weekly triage line to the runbook.
- **Roadmap:** owner action (U) for PRs and settings; `dependabot.yml` changes in NEW I1R.
  Typescript 7 belongs to a NEW I-task in wave 4 next to P01.
- **Size:** S

### OPS-07 — No release environment, no required reviewer, single maintainer everywhere

- **Severity:** Major
- **Evidence:** `gh api …/environments` shows only `github-pages`. The privileged jobs (`npm-publish`, `bundle`, `github-release`, `mcp-registry`) run without an environment. npm `maintainers` is a single account. The GitHub repo, the MCP registry namespace `io.github.IvanBBaev` and the plugin all hang off the same identity. The 2FA mode on npm was not verifiable read-only. The runbook has no bus-factor or account-recovery section.
- **Risk:** No human checkpoint between "tag pushed" and "published to three registries". Loss of the one account (lockout, compromise, absence) freezes security fixes. There is no documented way to deprecate a bad version without that account.
- **Recommendation:** Create environment `release` with the owner as required reviewer and a tag-only deployment rule. Put `npm-publish`, `github-release` and `mcp-registry` in it, and bind the npm trusted publisher to it (OPS-01). Document a bus-factor plan: 2FA recovery codes stored offline, a named emergency deputy or an explicit "no deputy" decision, and a `SECURITY.md` contact path.
- **Roadmap:** owner decision D-OPS-2; workflow change in NEW I1R.
- **Size:** S

### OPS-08 — Release runbook drift and incomplete rollback

- **Severity:** Major
- **Evidence:** `docs/runbooks/release.md:362-363` says npm-publish and bundle run in parallel and a bundle failure does not un-publish npm. `release.yml:472-476` now makes `npm-publish` wait for `bundle`. The surfaces list at `release.md:174-177` omits `.claude-plugin/marketplace.json`, which the gate does assert. The rollback section (`release.md:422-452`) covers npm `deprecate` plus a dist-tag move only. There are no steps for: the GitHub Release (mark as pre-release or edit the notes); the MCPB asset that users may have installed; the MCP registry entry (`mcp-publisher` status/deprecate support in 1.8.1 must be checked); the unpinned plugin (OPS-03). The verify section claims anyone can reproduce the bundle (`release.md:415-418`). That holds only on the same Node/zlib (OPS-10).
- **Risk:** During an incident, an operator follows a runbook whose ordering model is wrong. Three of the five distribution channels have no documented rollback.
- **Recommendation:** Fix the parallel-to-sequential text. Make the surfaces list generated or cross-referenced from `gen-metadata.mjs`. Add a rollback matrix with one row per channel (npm, GitHub Release, MCPB, MCP registry, plugin/marketplace), and rehearse it once on a `-rc` version.
- **Roadmap:** NEW I1R. Wave 3, extend **I32** with "rollback rehearsal on `1.0.0-rc.1`".
- **Size:** M

### OPS-09 — GitHub Release notes are auto-generated, not taken from CHANGELOG

- **Severity:** Minor
- **Evidence:** `release.yml:749-753` uses `gh release create … --generate-notes`. The v0.8.0 release body is a "What's Changed" list of PRs (a single PR, #41). The BREAKING insights v2 change documented in `CHANGELOG.md` `## [0.8.0]` is not in the release notes.
- **Risk:** Users watching releases miss breaking-change notices, even though the curated text exists.
- **Recommendation:** Extract the `## [x.y.z]` section from `CHANGELOG.md` (the gate already asserts it exists) and pass it with `--notes-file`. Keep `--generate-notes` appended for contributor credit.
- **Roadmap:** NEW I1R.
- **Size:** S

### OPS-10 — MCPB "reproducibility" holds only on the same Node/zlib

- **Severity:** Minor
- **Evidence:** Packing HEAD twice locally gives identical hashes. Rebuilding `v0.8.0` locally on macOS with Node 26.12.1 gives `d58df8fe…`, 5,976,531 B. The published asset is `6474d7b4…`, 5,974,279 B. Both archives have the same 3,818 entries, and `diff -rq` of the extracted trees is clean. Only the deflate output differs (`scripts/pack-mcpb.mjs:139`, level 9 via Node's zlib). `release.md:415-418` does not state the Node version needed to reproduce the bundle.
- **Risk:** A third-party verifier gets a different hash and concludes tampering. The published hash will also change "for no reason" when the release `NODE_VERSION` moves to 24 (P05).
- **Recommendation:** Document "reproduce with Node 22.x on Linux". Better, also publish a content digest (a sorted manifest of entry SHA-256s) next to the archive hash and verify that in CI. Add a CI step that packs twice and compares, plus an extract-and-diff against the previous release asset.
- **Roadmap:** NEW I1R (docs, CI). The script change is in `scripts/`, owned by I-tasks.
- **Size:** S

### OPS-11 — The Node floor is hard-coded in about ten places outside the SSOT

- **Severity:** Minor
- **Evidence:** The SSOT `nodeEngine: '>=22'` (`scripts/metadata.config.mjs:73`) drives only `engines`, `server.json` and `manifest.json` (`gen-metadata.mjs:183`). It is hand-maintained in: `.nvmrc`; `bin/facebook-mcp.mjs:5-12` (`major < 22`); the `ci.yml` matrix and `node-version` lines; `release.yml` `NODE_VERSION`; `@types/node ^22`; `README.md:278`; `CONTRIBUTING.md:15-16,130`; `docs/runbooks/release.md:167,283`. This regresses R1-13, which counted five places.
- **Risk:** P05 (Node >=24, wave 4) and B04 (Node >=26, wave 6) will each miss one place. The launcher check is the dangerous one: a stale floor gives users a wrong error message.
- **Recommendation:** Generate the launcher floor and the `.nvmrc` from the SSOT. Add a `metadata.test.ts` guard that greps the other places for the floor. Write the bump as a checklist inside P05 and B04.
- **Roadmap:** extend **P05** (wave 4) with the generator and guard. B04 then becomes a one-line
  change.
- **Size:** S

### OPS-12 — No SBOM and no licence scan

- **Severity:** Minor
- **Evidence:** There is no `npm sbom`, `attest-sbom` or licence check in `release.yml` or `ci.yml`. The MCPB bundles the full production `node_modules` (3,818 entries), which is redistribution of third-party code.
- **Risk:** Enterprise adopters, a stated 1.0 audience, increasingly require an SBOM. A copyleft transitive dependency inside the MCPB would go unnoticed.
- **Recommendation:** In `bundle`, generate `npm sbom --sbom-format cyclonedx --omit dev`, attest it with `actions/attest-sbom` (SHA-pinned), and upload it as a release asset. Add a licence allowlist check (for example `license-checker-rseidelsohn --onlyAllow`, or a small script over `npm ls --json`) to CI.
- **Roadmap:** NEW I1R, or wave 3 extend **I32** if I1R is not opened.
- **Size:** S

### OPS-13 — `fold-changes --check` is not in CI; unfolded fragments are not blocked at release

- **Severity:** Minor
- **Evidence:** `scripts/fold-changes.mjs` supports `--check` (exit 2 on a malformed fragment) but neither workflow calls it. `changes/unreleased/c05.md` is pending. The task breakdown (line 377) lists the "optional release.yml guard against unfolded fragments" as deferred.
- **Risk:** A malformed fragment is found only by the release I-task. A release can ship with fragments that were never folded into its CHANGELOG section.
- **Recommendation:** Run `node scripts/fold-changes.mjs --check` in the CI `metadata` job. In the gate, fail if `changes/unreleased/*.md` (other than README) exist at the tagged commit.
- **Roadmap:** extend **I32** (or I1R, earlier).
- **Size:** S

### OPS-14 — CI shape is queue-bound; no concurrency, timeouts or Node 24/26 cold-start

- **Severity:** Minor
- **Evidence:** `ci.yml` fans out to 11 jobs, each repeating checkout, setup-node and `npm ci`. Run 40939856241: each job takes 20 s–1.5 min, but starts are staggered from 19:26 to 19:33; wall clock is about 10 min. There is no `concurrency` with `cancel-in-progress` and no `timeout-minutes`. Cold-start and bundle run on Node 22 only (`ci.yml:118-155`), and there is no macOS `check` leg.
- **Risk:** Slow feedback in a wave-based parallel plan with many PRs. A hung job burns the 6 h default. The P05 Node 24 switch will meet untested `npx` cold-start behaviour.
- **Recommendation:** Add `concurrency: ci-${{ github.ref }}` with `cancel-in-progress` for PRs, and `timeout-minutes: 15`. Fold `audit`, `metadata` and `coverage` into one Linux job. Add Node 24 to the cold-start matrix now and Node 26 before B04.
- **Roadmap:** NEW I1R (wave 1). The matrix additions are part of P05.
- **Size:** S

### OPS-15 — `cache: npm` inside privileged release jobs

- **Severity:** Minor
- **Evidence:** `release.yml:170` (gate), `515` (`npm-publish`, `id-token: write`) and `637` (`bundle`, attestations write) use `actions/setup-node` with `cache: npm`.
- **Risk:** The cache is shared with less-trusted workflows on the same repository. Cache poisoning is a known path into privileged jobs. `npm ci` integrity checks mitigate most of it, not all of it.
- **Recommendation:** Drop `cache: npm` from `npm-publish` and `bundle`. The release cadence makes the speed cost irrelevant.
- **Roadmap:** NEW I1R.
- **Size:** S

### OPS-16 — Repository Actions policy does not enforce what the workflows already do

- **Severity:** Minor
- **Evidence:** `gh api …/actions/permissions` returns `allowed_actions: all` and `sha_pinning_required: false`.
- **Risk:** A future workflow edit, by a contributor or an agent task, can introduce an unpinned or arbitrary action, and nothing stops it. Rule 9 of the task breakdown is policy, not enforcement.
- **Recommendation:** Enable "require actions to be pinned to a full-length commit SHA". Restrict to GitHub-owned and verified actions plus an explicit allowlist (`modelcontextprotocol` is not used as an action, so the list is short).
- **Roadmap:** owner action (U, settings).
- **Size:** S

### OPS-17 — Secret-scanning extras and branch hygiene settings are off

- **Severity:** Minor
- **Evidence:** `security_and_analysis`: `secret_scanning_non_provider_patterns` and `secret_scanning_validity_checks` are disabled. `delete_branch_on_merge` is `false`, and merge commit, squash and rebase are all allowed.
- **Risk:** Generic high-entropy secrets (Meta app secrets, page tokens are non-provider) are not flagged. These are exactly the secrets this project's users handle. The many `task/*` branches of the wave plan linger remotely.
- **Recommendation:** Enable non-provider patterns and validity checks. Set `delete_branch_on_merge: true`, and choose one merge method (squash or merge), matching the integrator protocol.
- **Roadmap:** owner action (U, settings).
- **Size:** S

### OPS-18 — Pinned tool versions have no upkeep mechanism

- **Severity:** Minor
- **Evidence:** `release.yml:111-130` pins `MCP_PUBLISHER_VERSION 1.8.1` plus SHA-256 and `NPM_VERSION 11.19.0`. `gen-metadata.mjs:236-237` hard-codes the `server.json` `$schema` date `2025-12-11`. Dependabot cannot see any of these.
- **Risk:** The registry schema moves (it is still a preview API), and the publish fails on release day, the worst moment to bump a binary and its digest.
- **Recommendation:** Add a weekly scheduled read-only job (or a `release:rehearsal` dispatch on a schedule) that validates `server.json` against the latest schema and reports newer `mcp-publisher` and npm versions as a workflow warning or issue. Add a "tool pins" line to the per-release preconditions.
- **Roadmap:** NEW I1R.
- **Size:** S

### OPS-19 — CHANGELOG date of 0.7.0 does not match the publish date

- **Severity:** Nit
- **Evidence:** `CHANGELOG.md:3061` reads `## [0.7.0] - 2026-08-25`. npm and the GitHub Release date it 2026-08-27, after two failed runs.
- **Recommendation:** Correct it to the publish date, and state the rule in the runbook (date = the day the tag is cut, or the day npm shows the version).
- **Roadmap:** I32. **Size:** S

### OPS-20 — HEAD keeps stamping the released version between releases

- **Severity:** Nit
- **Evidence:** HEAD is 16 commits after `v0.8.0`, and `metadata.config.mjs:71`, `server.json`, `manifest.json` and `--version` all say `0.8.0`.
- **Risk:** Bug reports from source checkouts, or from the `main`-tracking marketplace (OPS-03), are indistinguishable from the 0.8.0 release.
- **Recommendation:** Either accept and document it, or have `--version` append `+<git sha>` when not running from a packed tarball.
- **Roadmap:** I32 decision. **Size:** S

### OPS-21 — Bundle artifact retention of 7 days

- **Severity:** Nit
- **Evidence:** `release.yml:685-692` uploads with a retention of 7 days.
- **Risk:** Resume mode re-attaches the artifact. A failed `github-release` noticed after a week forces a full rebuild and a new attestation.
- **Recommendation:** Use 30 days, or document the 7-day resume window in the failure table.
- **Roadmap:** I1R. **Size:** S

### OPS-22 — Launcher floor check is hard-coded

- **Severity:** Nit
- **Evidence:** `bin/facebook-mcp.mjs:5-12` checks `major < 22` literally. The file also uses top-level `await` (line 31), so on a very old Node (<14.8) it fails with a syntax error before the friendly message prints.
- **Recommendation:** Generate the literal from the SSOT (OPS-11). Wrapping in an async IIFE costs nothing and keeps the message reachable on ancient runtimes.
- **Roadmap:** P05. **Size:** S

## 5. Release-rail checklist for 1.0.0

Ordered. Each item is a precondition for the next where it matters.

1. **Credentials.**
   - Confirm the npm trusted publisher (repo, `release.yml`, environment `release`).
   - Revoke the npm token, then delete the `NPM_TOKEN` secret (OPS-01).
   - Enable npm "require 2FA, disallow tokens".
2. **Repository settings.**
   - Ruleset on `main` (PR required; `ci.yml` and CodeQL required; no force-push or delete).
   - Tag ruleset on `v*`.
   - Environment `release` with a required reviewer.
   - SHA pinning required; Dependabot security updates on; non-provider secret patterns and
     validity checks on; delete branch on merge (OPS-02, 07, 16, 17).
3. **Dependabot backlog.** Close #1, #3, #38; merge #42; decide #4 and #37 by explicit `ignore`
   rules (OPS-06).
4. **I1R merged.** Release gate:
   - calls `ci.yml` via `workflow_call`, or asserts check runs;
   - verifies the commit is on `main`;
   - runs `fold-changes --check` and fails on unfolded fragments;
   - fails when `NPM_TOKEN` is present;
   - uses CHANGELOG-based notes;
   - adds SBOM and attestation;
   - no `cache: npm` in privileged jobs;
   - timeouts and concurrency;
   - fixed runbook (sequential order, full surfaces list, five-channel rollback matrix, Node
     version for MCPB reproduction).
5. **I31 merged.** `exports` decision implemented (D-OPS-1), with `publint`/`attw` (or a "no
   library" check) green in CI.
6. **Plugin pin.** `plugin.json` generated as `npx -y @ivanbaev/facebook-mcp@1.0.0`; marketplace
   source decision implemented (OPS-03).
7. **Fragments.** All `changes/unreleased/*.md` folded into `## [1.0.0] - <date>`; the BREAKING
   list is complete; migration notes from 0.8.x are linked.
8. **SSOT bump.** `scripts/metadata.config.mjs` version `1.0.0-rc.1`, `npm run metadata`,
   `metadata:check` green; CI green on that exact SHA on all legs.
9. **Rehearsal.** `workflow_dispatch` in rehearsal mode on the rc commit, then tag `v1.0.0-rc.1`.
   - Verify: dist-tag `next`; `_npmUser` is GitHub Actions (not the personal account);
     `npm audit signatures`; `gh attestation verify` on the MCPB; the registry entry is visible;
     the plugin installs the pinned rc.
10. **Rollback drill.** On the rc: `npm deprecate`, dist-tag move, GitHub Release edit and a
    registry status change, following the new matrix. Record the timings in the runbook.
11. **Live gate.** U30 live gate green against the rc (real Graph API, owner-run).
12. **Cut.** Version `1.0.0`, `npm run metadata`, CHANGELOG date set, CI green on the SHA, signed
    annotated tag `v1.0.0` from `main`. Approve the `release` environment.
13. **Post-release verify.**
    - `npm view @ivanbaev/facebook-mcp@1.0.0` (provenance, `_npmUser`), `latest` = 1.0.0.
    - Release notes contain the CHANGELOG section.
    - Install the MCPB and check the SHA-256 against the asset.
    - Registry search returns 1.0.0.
    - Run the `npx` cold-start on all three OSes from the registry.
14. **Post-release hygiene.**
    - Deprecate the 0.x line with a pointer to the migration guide (optional, owner choice).
    - Listings (U-A2 equivalent).
    - Open the next `[Unreleased]` section.

## 6. Roadmap critique and owner decisions

### Critique

- **The release rail has no owner task.** `.github/workflows/*` is integration-only
  (task breakdown line 38), and rule 9 reserves CI changes to I-tasks. But no I-task between
  wave 0 and I32 is scoped to CI or release hardening. Everything above would be squeezed into I32,
  the same task that cuts 1.0.0. That couples hardening with the cut, so a release-day failure
  blocks both. **Proposal:** open **I1R — release rail hardening** in wave 1 (size M). It owns:
  - `.github/workflows/{ci,release}.yml`;
  - `.github/dependabot.yml`;
  - `docs/runbooks/release.md`;
  - the `fold-changes` CI wiring.

  It runs parallel to the wave-1 C-tasks, since nothing else touches those files.
- **The risk register (doc 04, R1–R10) has no supply-chain, release or bus-factor risk.** Add:
  - **R11 — publish credential / repository-governance compromise.** Mitigations: OPS-01, 02, 07, 16.
  - **R12 — single-maintainer bus factor.** Mitigation: OPS-07.
- **I31 (`exports`) sits in the same wave as I32 (cut).** A late `exports` change is a 1.0
  semver decision. Decide D-OPS-1 now and land I31 early in wave 3, or move it to wave 2.
- **P05 (Node >=24) and the 2.0.0 date.** Node 22 reaches end-of-life on 2027-04-30, and P05 /
  2.0.0 are planned "before 2027-04-30". That leaves no buffer if 2.0 slips. The engines bump
  alone is a semver-major. Make Node 24 cold-start CI legs mandatory in 1.x (OPS-14), so the
  switch is mechanical when it comes.
- **The SDK v2 major (P01) and TypeScript 7 (#4)** are tool-chain shifts in the same wave 4. Keep
  them as separate I-tasks with separate release candidates.
- **Wave A is marked done, but U-A2 (listings, plugin submission) assumes a stable plugin rail.**
  Submitting the plugin with an unpinned `npx` (OPS-03) to a public marketplace bakes in the
  problem. Pin first.
- **The dispatch checklist** (task breakdown lines 345-354) does not check repository settings.
  Add "ruleset and environment present" to the integrator's pre-wave checklist, so the parallel
  agent tasks can never push straight to an unprotected `main`.

### Owner decisions needed

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| D-OPS-1 | Public surface for 1.0 | CLI/server only (no library `exports`, no `.d.ts`) vs supported library entry points | CLI/server only for 1.0; add a library later in a minor via new `exports` keys |
| D-OPS-2 | Human gate on publishing | Environment `release` with owner approval vs fully automatic on tag | Environment approval; the cost is one click per release |
| D-OPS-3 | Marketplace source | Track `main` (needs "main is always release-equal") vs a release tag/branch | Release ref; update it in the cut task |
| D-OPS-4 | Bus factor | Named emergency co-maintainer on npm/GitHub vs documented "solo, with recovery codes" | At least the documented solo plan and `SECURITY.md`; a co-maintainer for 1.0 if feasible |
| D-OPS-5 | Who owns the release rail | New I1R in wave 1 vs fold into I32 | New I1R; keep I32 a pure cut |
| D-OPS-6 | Merge method | Squash vs merge commit (rebase off) | Matches the integrator protocol; pick one and enforce it via the ruleset |
| D-OPS-7 | Release notes source | CHANGELOG section vs auto-generated | CHANGELOG section plus auto-generated contributor list |
