# Review — Senior DevOps / Release Engineer

Reviewed: `docs/analysis/` (all nine files, focus on 02, 05, 07, 08), raw research
(`docs/ai/research/servicenow-mcp-architecture.md` §1/§6,
`docs/ai/research/mcp-prior-art-ecosystem.md` §B.3/§B.4), and the actual reference
implementation at `/Users/ivanbaev/Development/servicenow-mcp` (`package.json`,
`bin/servicenow-mcp-ai.cjs`, `server.json`, `.claude-plugin/`, `scripts/gen-manifest.mjs`,
`.github/workflows/{ci,codeql,publish,publish-mcp}.yml`, `.github/dependabot.yml`).
Review date: 2026-07-21.

## Verdict

**Go with changes.** The distribution plan stands on a genuinely proven base: the
servicenow-mcp packaging pattern (ESM + `.cjs` launcher, `files` allowlist, 3 runtime
deps, tag-driven CI-only publishing with a `prepublishOnly` backstop, OIDC registry
publish) is real, running, and correct in its essentials, and porting it is the right
call. But the corpus treats distribution as a solved problem it can defer to Phase 4,
and that is where the risk hides: the npm name — the one asset that is first-come-
first-served in a niche with demonstrated squatting — is left undecided until the last
phase; the metadata surface has grown to five files that must agree (package.json,
server.json, MCPB manifest.json, `.claude-plugin/*`, README/.env.example) with no
generation strategy, and the reference repo has *already drifted* on exactly this
point; the Node 20 baseline was EOL three months before this corpus was written; and
nothing states the two invariants a credibility-critical "security-first" project must
be able to prove: CI never holds a Meta secret, and stdout never carries a byte that
is not protocol. All of this is cheap to fix now and expensive to fix after the first
`npm publish`. No finding blocks the design itself.

## Strengths worth keeping

- **The `.cjs` launcher pattern** (`bin/*.cjs` guard, ancient-Node parseable, then
  `import("../build/index.js")`) plus the CI probe that asserts a human-readable
  failure under Node 12 — this is the correct fix for the "ESM entry can't even be
  parsed by old Node" trap, and 05 ports it explicitly.
- **Tag-driven, CI-only publishing with a double gate**: `publish.yml` runs
  `npm run check`, asserts tag == `package.json` version, and `prepublishOnly` re-runs
  the gate as a backstop; `release:dry` exists. A red build cannot reach the registry.
  Port this verbatim (modulo Finding 6).
- **3 runtime deps, zero native modules.** Beyond audit-surface benefits, this is what
  makes a *single cross-platform MCPB bundle* possible (no per-OS builds) — worth
  stating as a deliberate packaging property, not just a hygiene stat.
- **`files` allowlist** (`build`, `!build/**/*.map`, `bin`) — publish surface is
  explicit, docs/tests/research never leak into the tarball.
- **Clean `FB_` prefix from day one** (05 §1) — avoids the `SN_` legacy problem and,
  release-engineering-wise, means no env-var deprecation debt at v1.
- **Manifest snapshot test as the tool-surface contract** — this is the natural
  anchor for a semver policy (Finding 10) and for generated docs; keeping it is right.
- **mcpName fixed early and decoupled from the npm name** (07 Q1: registry identity
  `io.github.IvanBBaev/...` independent of npm) — correct reading of how the registry
  verifies ownership, and it de-risks the naming decision.
- **Stateless-friendly, no Roots/Sampling/Logging dependency** (02, P2) — the right
  posture ahead of the 2026-07-28 spec; nothing in the release story depends on
  deprecated capabilities.

## Findings

### 1. **Major — npm name left to Phase 4 is a squatting/timing risk; decide and reserve it now**

07 Q1 and 02 defer the scoped-vs-unscoped decision to "packaging time" (Phase 4 —
after roughly four phases of work). This is the only project asset that is
first-come-first-served, in a niche where `facebook-mcp-server` is *already* squatted
(mcp-prior-art-ecosystem.md §A.1 npm namespace note) and where visible activity (a
public repo, review docs, registry chatter) can trigger copycat registration. The
corpus never even verifies which candidate names are currently free.

**Forced recommendation: unscoped `facebook-mcp-ai`**, with
`mcpName: "io.github.IvanBBaev/facebook-mcp-ai"` and bin `facebook-mcp-ai`.
Trade-offs considered:

- *Discoverability*: npm search ranks unscoped exact-ish matches well; scoped
  `@ivanbbaev/facebook-mcp` reads as a personal fork and ranks worse. (In 2026 the
  MCP registry + directories matter more than npm search, but npm search is not
  nothing.) The `-ai` suffix matches the author's existing `servicenow-mcp-ai` brand,
  so the two packages corroborate each other's provenance.
- *npx ergonomics*: `npx -y facebook-mcp-ai` is shorter and less error-prone than the
  scoped form in every README, MCPB manifest, and `.claude-plugin` snippet.
- *Provenance*: npm provenance/attestations work identically for scoped and unscoped
  names; scope buys nothing here.
- *Trademark*: both options contain the "Facebook" mark; scope does not immunize.
  Mitigate the same way servicenow-mcp-ai does — port the `trademark` nominative-use
  disclaimer field in package.json and "unofficial/community" wording in the README.
- *Fallback*: if `facebook-mcp-ai` turns out taken, use `@ivanbbaev/facebook-mcp`
  (guaranteed available) rather than inventing a third unscoped name.

**Action**: verify availability today; publish the first working 0.x as soon as the
Phase 0 gate passes (a functional skeleton is a legitimate reservation; an empty spam
placeholder is not) instead of waiting for Phase 4. Update 07 Q1 from "open" to
"decided, reservation scheduled at Phase 0 exit".

### 2. **Major — Five metadata surfaces, no sync/generation strategy; the reference repo has already drifted**

05 §12 and 08 Phase 4 list README tables, `server.json`, `.claude-plugin/` manifests,
and the MCPB bundle as deliverables, but propose no mechanism keeping them coherent.
The implicit assumption ("servicenow-mcp has `gen:manifest`") does not hold:

- `scripts/gen-manifest.mjs` in servicenow-mcp writes **only**
  `test/fixtures/tools-manifest.json` (the snapshot fixture). The research doc's claim
  that `server.json` is "generated/kept in sync via `npm run gen:manifest`"
  (servicenow-mcp-architecture.md §6) is **false** — `server.json` is hand-maintained.
- The drift is not hypothetical: in the reference repo,
  `.claude-plugin/plugin.json` says `"version": "2.0.0"` while `package.json` and
  `server.json` say `2.0.1` — a stale version shipped in a distribution manifest,
  exactly the failure mode facebook-mcp will multiply by adding an MCPB
  `manifest.json` (fifth surface, carrying its own name/version/description and the
  full `user_config` env-var enumeration).

**Recommendation** (answering "is gen:manifest enough?" — no):

1. Make `src/core/settings.ts` (or a sibling metadata module) the single source of
   truth for env vars: name, description, required, secret, default. Generate from it:
   the `server.json` `environmentVariables` block, the MCPB `manifest.json`
   `user_config` section, the README env table, and `.env.example`.
2. One `scripts/gen-metadata.mjs` that stamps name/version/description from
   `package.json` into `server.json`, MCPB `manifest.json`, and
   `.claude-plugin/plugin.json`, wired into the npm `version` lifecycle hook so a
   version bump can never miss a file.
3. A CI drift test (same family as the readme-sync/env-docs-sync tests in 05 §11)
   asserting all generated files match a fresh generation.
4. A version-consistency assertion in the publish workflows: `publish.yml` already
   checks tag == package.json; add `server.json`/`manifest.json` == package.json.
   Today `publish-mcp.yml` publishes whatever `server.json` is checked in, with no
   check at all — the plugin.json precedent shows this will eventually register a
   stale version.

### 3. **Major — Node 20 baseline is EOL at design time**

05 Stack: "Node ≥ 20 (`.nvmrc` 22)"; 08 Phase 0: "CI workflow (Node 20/22/24
matrix)". Node 20 reached end-of-life 2026-04-30 — almost three months **before**
this corpus was written. A brand-new project should not promise support for a dead
runtime on day one: it drags the test matrix backwards, blocks dependency floors, and
signals the opposite of the project's security positioning. Additionally,
`scripts/coverage-guard.mjs` in the reference exists to *skip* coverage on Node ≥ 25
(c8/yargs breakage) — porting a workaround that erodes the coverage gate on current
Node is the wrong default for a fresh repo.

**Recommendation**: `engines: ">=22"`, launcher guard message updated to match, CI
matrix **22 / 24 / 26** (26 has been current since April 2026), `.nvmrc` 22 or 24.
Keep the ancient-Node launcher probe (its point is parse-era Node; 12 is fine).
Resolve the c8-on-new-Node issue properly (newer c8, or move coverage to the
node:test built-in reporter) instead of porting coverage-guard. SDK v2 requires Node
20+, so a 22 floor also keeps the future migration unconstrained.

### 4. **Major — stdout purity is asserted but not guarded; `dotenv` is an unversioned foot-gun**

04 correctly states "stderr only — stdout is the stdio protocol channel", but nothing
in the corpus *enforces* it, and 05 lists `dotenv` with no version constraint.
dotenv v17 (mid-2025) started printing runtime tips via `console.log` **to stdout by
default** (`[dotenv@17.x] injecting env ...`). A fresh `npm install dotenv` in 2026
gets v17; the very first byte the server emits would then be non-protocol garbage on
the JSON-RPC channel. This is the kind of bug that ships silently because local
inspector testing may tolerate it while stricter clients do not.

**Recommendation**: (a) pin/configure dotenv explicitly (`quiet: true` at the call
site, or stay on ^16 like the reference); (b) add a **stdout-purity test** to the
suite: spawn the built server, drive one `initialize` over stdio, and assert that
every stdout byte parses as a JSON-RPC frame — zero tolerance for stray output. This
also permanently protects against any future dependency acquiring a banner habit.
State it as a Phase 0 gate criterion in 08 (today the gate is "server starts over
stdio", which a polluted stdout can still pass with a lenient client).

### 5. **Major — No stated "secret-free CI" invariant, and no guard that tests cannot reach the real Graph API**

For a project whose #1 differentiator is token security (02), the corpus never states
the two obvious release-engineering consequences: (a) GitHub Actions must hold **no
Meta credentials, ever** (the only CI secrets should be CODECOV_TOKEN and — see
Finding 6 — ideally not even NPM_TOKEN); (b) the test suite must be structurally
unable to hit `graph.facebook.com`. P3 says the live smoke script is "run manually",
but that is a habit, not an invariant — one refactor that auto-discovers
`test/*.test.js` or one fixture recorded from real traffic with a live token pastes a
credential into the repo or CI logs.

**Recommendation**:
- Test bootstrap replaces `globalThis.fetch` with a thrower by default; `withFetch`
  is the only opt-in. Any un-mocked network call fails the suite loudly.
- Live smoke scripts live outside the test glob (e.g. `scripts/smoke/`), require an
  explicit `FB_SMOKE=1` plus env credentials, and are documented as never-CI.
- Fixtures use synthetic `EAA...`-shaped tokens only (this doubles as redaction test
  input); the recording mock strips `access_token`/`appsecret_proof` at record time.
- Enable GitHub secret scanning + push protection on the repo from day 0 (free for
  public repos) — this is the backstop for the recorded-fixture risk.
- Write the invariant into 05 §11 and the Phase 0 gate.

### 6. **Major — Release workflow under-specified in the roadmap; prefer npm Trusted Publishing over a long-lived NPM_TOKEN**

08 Phase 4 says "npm publish (scoped name decision), server.json + mcp-publisher
registry listing, MCPB bundle" — but never commits to the tag-driven, CI-only flow
that makes the reference repo trustworthy, and the reference's `publish.yml` still
uses a long-lived `NPM_TOKEN` repo secret. Since the 2025 npm supply-chain incidents,
npm has been aggressively tightening token policy (classic tokens deprecated,
granular tokens short-lived); a static publish token in repo secrets is both an
operational rot risk (publish fails when it silently expires) and the single juiciest
exfiltration target in the repo.

**Recommendation**: specify in 08 Phase 4 (and implement in Phase 0, since the
workflow files are scaffolding): tag push `v*` → `npm run check` → tag==version
assertion → publish via **npm Trusted Publishing (GitHub Actions OIDC)** — no
NPM_TOKEN secret at all, provenance/attestations generated automatically → then the
`workflow_run`-triggered registry publish (as in `publish-mcp.yml`) → build the
`.mcpb` in the same release pipeline and attach it (plus SHA-256 checksums) to the
GitHub Release. Note: provenance requires the repo to be public at first publish —
sequence the repo-visibility flip before the first tag.

### 7. **Minor — mcp-publisher pitfalls: device flow is the wrong auth for CI, the binary is unpinned, and the registry is still "preview"**

02 says "`mcp-publisher`, GitHub device-flow auth". Device flow is the *interactive*
path; in CI the correct login is `mcp-publisher login github-oidc` (which the
reference `publish-mcp.yml` already uses — the corpus text should match). Other
pitfalls to design for:

- `publish-mcp.yml` downloads the mcp-publisher binary from the **latest** GitHub
  release, unpinned and unverified — a supply-chain and breakage vector in the one
  workflow holding an OIDC identity. Pin the version and verify a checksum.
- The registry is still officially "preview" (mcp-prior-art-ecosystem.md §B.3) and
  the `server.json` schema is date-pinned (`2025-12-11`); expect schema churn and
  treat `mcp-publisher init`-time schema as re-verifiable at Phase 4, not settled.
- Ordering constraint: the registry verifies ownership against the **published npm
  tarball's** `mcpName` field — so `mcpName` must be in package.json from the very
  first npm publish (a 0.x reservation publish without it would require another
  release before the registry listing works).
- There is a propagation race between `npm publish` and registry validation of the
  new version; the `workflow_run` delay usually absorbs it, but keep
  `workflow_dispatch` re-run (as the reference does) as the documented recovery path.

### 8. **Minor — MCPB build outputs and gate are unspecified**

The corpus mentions the MCPB bundle four times (02, 05 §12, 08 Phase 4) but never
what it implies for the build: a `.mcpb` is a zip of the server **plus production
`node_modules`** plus `manifest.json`. Concretely missing:

- A `pack:mcpb` pipeline: stage `build/` + `npm ci --omit=dev` into a clean dir, then
  `npx @anthropic-ai/mcpb pack`. Note the bundle carries the SDK's full transitive
  tree (express and friends, unused in stdio mode) — measure the size once and record
  it; the SDK v2 split will shrink it later.
- `manifest.json` needs a `compatibility.runtimes.node` constraint matching `engines`
  (Claude Desktop supplies its own Node — the `.cjs` launcher guard never runs in
  this path, so the manifest constraint is the only guard).
- `user_config` entries with `sensitive: true` (FB_ACCESS_TOKEN, FB_APP_SECRET →
  OS keychain) mapped into env via `mcp_config` — consistent with the env-first
  design in 05 §1; the doctor should detect a Desktop/keychain install and *not*
  offer to write the XDG env file in that mode.
- The Phase 4 gate (08) only tests `npx -y <pkg>` cold start. Add: "`.mcpb`
  double-click install in Claude Desktop, secrets entered into keychain-backed
  user_config, doctor passes" — MCPB targets exactly the non-technical Page admin
  who will never debug a broken bundle.

### 9. **Minor — Windows honesty: `chmod 0600` is a no-op and XDG needs a fallback**

02 and 04 sell "0600 env files" as a differentiator and 05 §1 specifies "XDG config
path; atomic 0600 writes". On Windows, `fs.chmod` cannot express owner-only
permissions (it only toggles read-only) and `$XDG_CONFIG_HOME` does not exist. The
reference repo sidesteps this culturally (dev on macOS) but facebook-mcp's CI design
includes a Windows leg and the MCPB audience includes Windows Desktop users.

**Recommendation**: resolve the config dir as XDG → `~/.config/<name>` → `%APPDATA%`
on win32; attempt chmod but have the doctor report the *actual* protection state per
platform instead of implying 0600 everywhere; keep SECURITY.md wording accurate
("owner-only permissions on POSIX"). Exercise `FB_MEDIA_DIR` path normalization
(drive letters, backslashes) in the Windows CI leg — it is both a correctness and an
allowlist-bypass surface.

### 10. **Minor — No semver / deprecation policy; define what "breaking" means for a tool server**

The corpus specifies versioning inputs (FB_API_VERSION pinning in R2, SDK v1→v2 in
P2, CHANGELOG.md in Phase 4) but no output policy. For an MCP server the public
contract is the **tool surface + env contract**, and the manifest snapshot test
already computes its diff — anchor the policy there:

- Major: tool removed/renamed, input field removed or semantics changed, env var
  renamed/removed, `FB_TOOL_PACKAGES` profile semantics changed, SDK v2 migration,
  Node baseline raise.
- Minor: new tool/package, new optional input, **FB_API_VERSION default bump**
  (behavior change, always a dedicated changelog entry with the Graph changelog
  link — this is the "changelog check ritual" of R1 made enforceable).
- Env-var deprecations: since `FB_` is clean from day one there is no initial debt;
  commit to a policy anyway (old name honored with a stderr warning for ≥1 minor
  before removal) so the first rename doesn't invent policy ad hoc.
- Keep-a-changelog format from the first tag, not from Phase 4 — retrofitting a
  changelog over Phases 0–3 history is busywork; writing it as you go is free.

### 11. **Minor — CodeQL, dependabot, and action pinning are absent from the corpus**

The reference repo has `codeql.yml` (push/PR + weekly cron), `dependabot.yml` (npm +
github-actions ecosystems, grouped minor/patch), and `npm audit --omit=dev
--audit-level=high` both in `check` and as a CI step. The corpus mentions only "CI
workflow (Node matrix), coverage ratchet" (08 Phase 0) — the rest is presumably
implied by "port the blueprint", but for a security-positioned project the
supply-chain rails should be named deliverables, not implications. Also improve on
the reference: its workflows pin actions by tag (`@v4`, `@v5`); pin by commit SHA at
least in the credentialed workflows (`publish*.yml`, anything with `id-token:
write`), and let the dependabot github-actions ecosystem bump the SHAs. Commit
`package-lock.json` and use `npm ci` everywhere (see also Finding 13). Note that
`npm audit --omit=dev` over 3 direct deps will almost never fire — CodeQL + dependabot
+ lockfile review are the real controls; keep the audit gate anyway as a cheap
tripwire.

### 12. **Minor — State a "no install scripts" policy; doctor is the post-install check, never `postinstall`**

The corpus designs a doctor subcommand (04, 08 Phase 0 gate) but never says how it
relates to installation. Make it explicit policy: the published package ships **zero
npm lifecycle scripts** (`postinstall` etc.) — install-time script execution is the
top supply-chain red flag and gets packages quarantined by scanners and blocked by
`ignore-scripts` environments. The documented flow is manual:
`npx -y facebook-mcp-ai doctor` as step 2 of every install path (README quickstart,
MCPB troubleshooting, registry description). `prepublishOnly` is fine (runs on the
maintainer's side only).

### 13. **Nit — The Node baseline is encoded in five places; add a bump checklist or drift test**

`engines`, `.nvmrc`, the launcher guard string, the CI matrix, and the MCPB
`compatibility.runtimes.node` all encode the floor. The reference's launcher probe
even greps for the literal message text ("requires Node.js >= 20") — which will also
silently pass/fail oddly if the package name in the message changes. Either a tiny
test that derives the launcher's guard number from `package.json#engines`, or a
RELEASING.md checklist item. Related: `engine-strict=true` in `.npmrc` binds only
contributors installing in-repo — consumers get an EBADENGINE *warning* at most, so
the launcher guard is the only consumer-facing enforcement; the corpus is right to
port it, just don't describe engine-strict as user protection.

### 14. **Nit — Lockfile policy unstated**

08 Phase 0 lists `.npmrc` and `.nvmrc` but not `package-lock.json`. It is obviously
implied by `npm ci` in the ported workflows — state it (committed lockfile,
`npm ci` in CI and release, lockfile changes reviewed like code). One line in 05.

### 15. **Nit — Document the `npx` staleness/latency trade-off**

`npx -y <pkg>` cold start downloads the tarball (slow first launch under Desktop's
spawn timeout) and thereafter may serve a cached older version depending on the
user's npm cache behavior. Add one README note: MCPB is the recommended path for
non-technical users; `npx -y facebook-mcp-ai@latest` for always-current; pinned
`@x.y.z` for reproducible setups. Zero code cost, saves recurring support issues
(the Phase 4 gate's "cold-start works" should measure this once).

## Open questions for the author

1. Has anyone actually checked, today, whether `facebook-mcp-ai` (and fallback
   `@ivanbbaev/facebook-mcp`) are free on npm? The corpus verified the squat of
   `facebook-mcp-server` but never the candidates. (Finding 1.)
2. Will the GitHub repo stay `facebook-mcp` while the npm package and `mcpName` use a
   different string? Auto-indexing directories key off the GitHub repo + README
   `mcp-name:` line — is the intentional mismatch acceptable, or will the repo be
   renamed to match at publish time?
3. When does the repo go public? npm provenance and free secret-scanning/push-
   protection both assume a public repo; the sequencing (public before first tag)
   should be a Phase 4 — ideally Phase 0 — decision, not an accident.
4. Is the rest of the servicenow-mcp distribution estate (GitHub Pages docs site,
   VS Code extension, `publish-vscode.yml`) in or out of the "port the blueprint"
   claim? The corpus is silent; each is a real maintenance commitment.
5. Do you intend to sign the `.mcpb` (mcpb tooling supports signing), and is the
   distribution channel GitHub Releases only, or also a Claude Desktop directory
   submission? This affects whether the release workflow needs signing keys.
6. What is the intended cadence for bumping the `FB_API_VERSION` default relative to
   Graph API releases (every release ~3–5 months, or every other)? This determines
   how often the R1 "changelog check ritual" actually runs and should be written into
   RELEASING.md.
7. Where does the plan-and-apply write journal (05 §7, 07 Q5) live on disk — XDG data
   dir? — and does it rotate? It affects packaging docs, the doctor's disk-state
   report, and what an uninstall leaves behind.
