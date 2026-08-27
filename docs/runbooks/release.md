# Runbook: cutting a release

## When to use this

You are shipping a version of `facebook-mcp` — to npm, to the GitHub Releases
page as a `.mcpb` bundle, and to the MCP Registry. Reach for this when:

- You are cutting **1.0.0** (the first publish — read the
  [one-time setup](#one-time-setup-do-this-once-before-the-first-tag) section in
  full; several of its steps can only be done in the right order).
- You are cutting any later release.
- A release failed part-way through and you need to know what is safe to re-run.
- You need to **undo** a release (see [rollback](#rollback-deprecate-never-unpublish)).

**The rule this runbook exists to protect: nothing is ever published from a
laptop.** The only thing an operator does is push a tag. Everything else happens
in [`.github/workflows/release.yml`](../../.github/workflows/release.yml), which
holds no long-lived publish credential — npm and the MCP Registry both
authenticate the workflow itself through GitHub OIDC. `prepublishOnly` in
`package.json` enforces this from the other side: `npm publish` refuses to run
outside GitHub Actions.

> **The one exception, stated up front.** npm binds a trusted publisher to an
> **existing** package page, so a name that has never been published has nothing
> to bind to. Reserving it costs exactly one manual publish from a laptop with a
> short-lived token — [step 4 below](#one-time-setup-do-this-once-before-the-first-tag)
> is the only place in this project where that is allowed, it happens once in the
> package's life, and the token is revoked in the same sitting. Every release
> after it runs on the rail. If you find yourself reaching for a token for any
> other reason, the answer is no.

---

## One-time setup (do this once, before the first tag)

1. **The repository must be public.** npm provenance/attestations are only
   generated for public repositories, and free secret scanning + push protection
   assume one too. Flip visibility **before** the first tag, not after.

2. **`package.json` must be publishable.** During pre-1.0 development the package
   carries `"private": true`; npm refuses to publish while it is set. The release
   gate fails loudly on this, so you cannot forget it — but fix it in a normal PR,
   not in a panic on top of a tag.

3. **`mcpName` must already be in `package.json`.** The MCP Registry verifies
   ownership by reading `mcpName` out of the *published npm tarball*. It cannot be
   added to a version that is already on npm, so a first publish without it costs
   you an extra release before the registry listing can work. The gate asserts it.

4. **Configure npm Trusted Publishing for the package** on npmjs.com →
   *Package settings* → *Publishing access* → *Trusted publisher* → *GitHub
   Actions*, with **exactly** these values:

   | Field                | Value            |
   | -------------------- | ---------------- |
   | Organization or user | `IvanBBaev`      |
   | Repository           | `facebook-mcp`   |
   | Workflow filename    | `release.yml`    |
   | Environment          | _(leave empty)_  |

   The binding is exact-match: renaming the workflow file, moving the repo, or
   adding a job `environment:` all break publishing until the trusted publisher
   is updated to match.

   > **First-publish ordering caveat — the bootstrap exception.** npm's
   > trusted-publisher settings live on a package page, so for a name that has
   > never been published there is nothing to configure yet. **Check the settings
   > page first**: if npm lets you pre-register the trusted publisher for an
   > unpublished name, do that and skip the rest of this box — the rail then does
   > the first publish too, and no token is ever created.
   >
   > If it does not, the name has to be reserved with a **single token-authed
   > publish**. Prefer doing it **on the rail** — an `NPM_TOKEN` repository
   > secret, which the `npm-publish` job reads as an explicit fallback — over
   > publishing from a laptop: CI publishes the exact tagged commit after the
   > full gate, and the credential never touches your shell history or `~/.npmrc`.
   > Either way it is bounded by the steps below. Do them in one sitting, start
   > to finish:
   >
   > 1. **Mint the narrowest possible token.** npmjs.com → *Access Tokens* →
   >    *Generate New Token* → **Granular Access Token** with:
   >
   >    | Setting              | Value                                                     |
   >    | -------------------- | --------------------------------------------------------- |
   >    | Expiration           | **7 days** (the shortest npm offers; you need minutes)     |
   >    | Packages and scopes  | **Only select packages** → `@ivanbaev/facebook-mcp`. A name that has never been published cannot be selected — it does not exist yet — so for the bootstrap publish only, scope the token to `@ivanbaev/*` (still narrower than "all packages"), then replace or delete it once the package page exists. |
   >    | Permissions          | **Read and write** (publish needs write; nothing else does) |
   >    | Organizations        | **No access**                                              |
   >    | IP allow-list        | your current address, if you can be bothered — cheap and it costs nothing to be wrong |
   >
   >    Do **not** create a Classic/automation token: those are account-wide.
   >
   >    The scope in the package name is the **npm account** `ivanbaev` — one `b`,
   >    unlike the GitHub user `IvanBBaev`. A token belonging to an account that
   >    does not own the scope fails with a 404, not a 403, and re-minting it with
   >    wider permissions changes nothing. `npm whoami` under the token settles it
   >    in one line; the publish step prints it.
   >
   > 2. **Publish once.** On the rail (preferred): add the token as
   >    `Settings → Secrets and variables → Actions → NPM_TOKEN`, then push the
   >    release tag as usual. The `npm-publish` job picks the secret up, logs a
   >    warning saying it did, and publishes the gated commit. Provenance still
   >    works — `id-token: write` is granted and `--provenance` stays on, so even
   >    the bootstrap tarball is attested.
   >
   >    From a laptop (only if CI is unavailable), from a clean checkout of the
   >    exact tagged commit:
   >
   >    ```bash
   >    npm whoami                       # confirm you are the right account
   >    ALLOW_LOCAL_PUBLISH=1 npm publish --access public --tag latest --dry-run
   >    ALLOW_LOCAL_PUBLISH=1 npm publish --access public --tag latest
   >    ```
   >
   >    `ALLOW_LOCAL_PUBLISH=1` is the deliberate override of the
   >    `prepublishOnly` guard; it exists so that this one publish is a conscious
   >    act and every other laptop publish is an error message. A laptop tarball
   >    carries **no provenance** — provenance requires OIDC — which is the second
   >    reason to prefer the rail.
   >
   > 3. **Configure the trusted publisher immediately** (the table above), now
   >    that the package page exists.
   >
   > 4. **Revoke the token — mandatory, same sitting.** Delete the `NPM_TOKEN`
   >    repository secret, delete the token itself at npmjs.com → *Access
   >    Tokens*, and (if you published locally) `npm logout` on the machine you
   >    used. Then confirm nothing is left behind:
   >
   >    ```bash
   >    gh api repos/IvanBBaev/facebook-mcp/actions/secrets   # -> total_count 0
   >    npm whoami                                            # -> ENEEDAUTH
   >    grep -r "_authToken" ~/.npmrc                         # -> no match
   >    ```
   >
   >    The invariant in `release.yml`'s header ("no publish credential in steady
   >    state") is only true once this step is done, and the next release will
   >    keep using the secret in preference to OIDC for as long as it exists.
   >    Leaving the token alive "in case the release fails" is exactly the failure
   >    mode the rail was built to remove.

5. **Confirm no publish secret survived the bootstrap.**
   `Settings → Secrets and variables → Actions` should contain no `NPM_TOKEN`
   (outside the single bootstrap sitting above) and no Meta credential of any
   kind. In steady state the release rail needs neither.

6. **GitHub Release assets need no setup** — the `github-release` job uses the
   built-in `GITHUB_TOKEN`, which is the only job in the workflow granted
   `contents: write`.

---

## Per-release preconditions

Work through these on `main` **before** you tag. The gate re-checks every one of
them, but finding a problem here costs a commit; finding it after tagging costs a
tag deletion.

1. **CI is green on the commit you intend to tag.** `npm run check` (no install
   scripts, typecheck, lint, format, build, test) passes on the Node 22/24/26
   matrix and the Windows leg, `coverage` and `audit` are green, and CodeQL is
   clean. This matters more than it looks: **a tag push does not run `ci.yml`**
   (it triggers on `push: main` and `pull_request` only). The release gate
   re-runs `check`, `metadata:check` and the production `npm audit`, but the
   coverage and Windows legs exist only in the CI run on the commit — so tag a
   commit whose CI you have actually seen go green.
2. **The metadata surfaces agree.** `package.json`, `server.json`, the MCPB
   `manifest.json` and `.claude-plugin/plugin.json` must all carry the same
   version, `server.json.name` must equal `package.json.mcpName`, and the npm
   package entry in `server.json` must name the same npm package. All of them are
   generated from `scripts/metadata.config.mjs` — regenerate with
   `npm run metadata` and never hand-edit an artifact. `npm run metadata:check`
   is the day-to-day guard (it runs both in CI and in the release gate).
3. **`CHANGELOG.md` has a `## [<version>]` section** for this release, written in
   Keep-a-Changelog style. The gate looks for the literal `## [<version>]` string
   and fails without it — release notes are written before the tag, never after.
   See [step 2 of the cut](#step-2--write-the-changelog-entry) for the exact
   heading format.
4. **The bundle packs locally.**
   ```bash
   npm run build
   node scripts/pack-mcpb.mjs
   ```
   prints the bundle path and its SHA-256. This is optional (CI does it too) but
   it is the fastest way to catch a broken `manifest.json`.
5. **Rehearse the whole rail.** Actions → *Release* → *Run workflow* on `main`.
   This runs the real gate, a real `npm publish --dry-run` (Trusted Publishing
   included) and a real bundle build; it publishes nothing and skips the GitHub
   Release and MCP Registry jobs. Do this at least once before the first tag.

---

## Cutting the release

### Step 1 — bump the version in the SSOT, not in `package.json`

**`package.json` does not own the version.** It is a generated surface, like
`server.json` and `manifest.json`. The single source of truth is
`identity.version` in
[`scripts/metadata.config.mjs`](../../scripts/metadata.config.mjs); the generator
stamps it into every surface.

This is why `npm version 1.0.0 --no-git-tag-version` is **wrong**: it edits
`package.json`, and the very next `npm run metadata` overwrites the field from the
still-unbumped SSOT — reverting the bump with no error and no diff to notice. A
`preversion` script now refuses `npm version` outright so the mistake cannot be
made silently.

Edit the SSOT, then regenerate:

```bash
# scripts/metadata.config.mjs
#   -  version: '0.9.9',
#   +  version: '1.0.0',
npm run metadata          # builds, then rewrites package.json, server.json,
                          # manifest.json, .claude-plugin/*, .env.example, README
npm run metadata:check    # must print no drift
node -p "require('./package.json').version"   # -> 1.0.0, and it stays 1.0.0
```

### Step 2 — write the CHANGELOG entry

**The gate hard-fails without it.** `release.yml` greps `CHANGELOG.md` for the
literal string `## [<version>]`, so the heading must be exactly that — a Keep-a-
Changelog release heading, not `## Unreleased`, not `## v1.0.0`, not `## 1.0.0`:

```markdown
## [1.0.0] - 2026-08-12

### Added
...
```

Rename the existing `## [Unreleased]` section (or add a new section below it) and
keep the `Added` / `Changed` / `Fixed` / `Removed` subheadings. Release notes are
written before the tag, never after — this is the last moment where writing them
is cheap.

### Step 3 — merge, then tag

```bash
# Commit steps 1-2 and merge to main as a normal PR. Then, from an up-to-date
# main, at the exact commit CI went green on:
git switch main && git pull --ff-only
git tag -a v1.0.0 -m "v1.0.0"
git push origin v1.0.0
```

The tag must be `v<version>` — the workflow triggers on `v*.*.*` and asserts
`tag == package.json.version`. Nothing else starts a release.

**Prereleases publish to a prerelease dist-tag, automatically.** `v*.*.*` also
matches `v1.0.0-rc.1`, so the gate derives the npm dist-tag from the version
rather than letting `npm publish` default to `latest`: `1.0.0` → `latest`,
`1.0.0-rc.1` → `rc`, `1.0.0-beta.2` → `beta`, a numeric-only prerelease → `next`.
The gate logs the tag it chose; check that line if a release candidate ever needs
to be promoted (`npm dist-tag add <pkg>@<version> latest`). The same verdict marks
the GitHub Release: anything with a prerelease suffix is created with
`--prerelease`, so it never displaces the last stable release at the top of the
releases page (promote with `gh release edit v<version> --prerelease=false`).

**Verify by:** the *Release* workflow appears in the Actions tab within seconds of
the push, and its `gate` job logs `Tag v1.0.0 matches package.json 1.0.0`.

---

## What CI does, step by step

| Job              | Token it holds                | What it does                                                                                                                                                                          |
| ---------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gate`           | `contents: read`              | Asserts the trigger is a tag push, `tag == package.json` version, the package is publishable (`private` unset, `mcpName` present), every metadata surface agrees, the CHANGELOG has the section; derives the npm dist-tag from the version — then runs the full `npm run check`, `npm run metadata:check` and `npm audit --omit=dev --audit-level=high`. |
| `npm-publish`    | `+ id-token: write`           | Installs the pinned `NPM_VERSION` (and asserts ≥ 11.5.1, since Node 22 ships npm 10), `npm ci`, `npm run build`, then `npm publish --provenance --access public --tag <derived>`. Authenticates over OIDC unless an `NPM_TOKEN` secret exists, which is the bootstrap fallback only and is warned about in the log.     |
| `bundle`         | `+ id-token: write`, `attestations: write` | Builds, runs `scripts/pack-mcpb.mjs`, independently re-verifies the emitted SHA-256 with `sha256sum -c`, **attests the bundle's build provenance** (`actions/attest-build-provenance`), and uploads the bundle + checksum as a workflow artifact. |
| `github-release` | `contents: write`, `attestations: read` | Downloads the artifact, re-verifies the checksum a second time, **re-verifies the provenance attestation with `gh attestation verify` before the asset can become public**, then creates (or updates) the Release for the tag and attaches `*.mcpb` and `*.mcpb.sha256`. |
| `mcp-registry`   | `+ id-token: write`           | Downloads a **version-pinned** `mcp-publisher` and verifies it against a SHA-256 committed to *this* repo, waits until the new npm version is actually visible on the registry CDN, then `mcp-publisher login github-oidc && mcp-publisher publish`. |

Design notes worth knowing when you read a failed run:

- `github-release` and `mcp-registry` are the only jobs that can change anything
  outside npm, and both are gated on `needs.gate.outputs.finalize == 'true'` — a
  `workflow_dispatch` rehearsal can never reach them.
- **Resuming a partly-failed release.** `npm publish` is the one step that cannot
  be repeated: a version exists on npm exactly once, so after it succeeds neither
  a re-run nor a re-tag can get the rest of the rail to run — the re-tag dies on
  the npm step before it reaches anything else. For that case only, dispatch the
  workflow **on the tag** with `mode: resume`. It leaves npm alone (the publish
  step degrades to `--dry-run`) and runs `github-release` and `mcp-registry` for
  real. Both are idempotent — `gh release upload --clobber`, and the registry
  accepts a re-publish of the same version — so resuming is safe even when only
  one of them actually failed. `mode: resume` refuses to run off a tag, because
  the registry publishes the `server.json` from the checkout and the version it
  names has to be the one already on npm.
  One consequence to know before you dispatch it: resuming rebuilds the `.mcpb`,
  so an asset that was already attached is replaced by freshly built, freshly
  attested bytes. Its `.sha256` is replaced in the same upload, so the published
  pair stays consistent and verifiable — but a checksum somebody recorded from
  the earlier upload will no longer match.
- No step is `continue-on-error`. A failure anywhere stops the rail; nothing is
  "published anyway".
- Every third-party action is pinned to a commit SHA with a `# vX.Y.Z` comment,
  and the npm upgrade inside the `id-token: write` job is pinned to an exact
  `NPM_VERSION` rather than `@latest`. Dependabot maintains the action SHAs;
  `NPM_VERSION`, `MCP_PUBLISHER_VERSION` and `MCP_PUBLISHER_SHA256` are bumped by
  hand, in a PR.
- **`mcp-publisher` is verified against a checksum that lives in this repo**, not
  against one fetched from the place the binary came from. `MCP_PUBLISHER_SHA256`
  in `release.yml` is the gate and a mismatch is a hard failure; the upstream
  `registry_<version>_checksums.txt` is still fetched, but only as a best-effort
  secondary cross-check that emits `::warning::` if it disagrees or cannot be
  reached. When you bump `MCP_PUBLISHER_VERSION`, re-pin the digest by hand —
  download the asset, hash it yourself, and put the result in the PR description
  so the review has something to check against.
- **Both shipped artifacts carry verifiable provenance.** The npm tarball gets it
  from `npm publish --provenance`; the `.mcpb` bundle gets a build-provenance
  attestation in `bundle`, which `github-release` re-verifies with
  `gh attestation verify` before attaching the asset. An unattestable bundle
  fails the release rather than shipping unsigned.
- The jobs are independent runners, so `npm-publish` and `bundle` run in
  parallel; a bundle failure does not un-publish npm (see rollback).

---

## Verify the release afterwards

Run these once the workflow is green.

```bash
# 1. The version is live and carries provenance attestations.
npm view @ivanbaev/facebook-mcp --json dist.attestations
#    -> an object with a "provenance" entry; `null`/absent means the tarball was
#       published without provenance and must be re-released.

# 2. Signatures and attestations validate end to end.
npm audit signatures

# 3. Cold start from the registry, exactly as a new user gets it.
#    `--version` and `doctor` both exit on their own; any OTHER argument starts
#    the stdio server, which would hang this check.
npx -y @ivanbaev/facebook-mcp@1.0.0 --version
#    -> `facebook-mcp 1.0.0 (node v22…, …)`. Cross-check against the registry:
npm view @ivanbaev/facebook-mcp version
npx -y @ivanbaev/facebook-mcp@1.0.0 doctor

# 4. The bundle on the Release page matches the checksum next to it.
curl -fLO https://github.com/IvanBBaev/facebook-mcp/releases/download/v1.0.0/facebook-mcp-1.0.0.mcpb
curl -fLO https://github.com/IvanBBaev/facebook-mcp/releases/download/v1.0.0/facebook-mcp-1.0.0.mcpb.sha256
sha256sum -c facebook-mcp-1.0.0.mcpb.sha256

# 5. The bundle's provenance verifies against this repository. This is the check
#    a downstream user should run too — it proves the file came out of this
#    workflow, which a checksum published beside the file cannot.
gh attestation verify facebook-mcp-1.0.0.mcpb --repo IvanBBaev/facebook-mcp
#    -> "Loaded ... attestation" then a green verification summary naming the
#       release workflow. A failure here means the asset was not built by the
#       rail; do not distribute it and do not "fix" it by re-uploading.

# 6. The registry listing points at the new version.
curl -fsS "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.IvanBBaev/facebook-mcp"
```

**Verify by:** the npm page shows the green *Provenance* badge linking back to
this repository and the exact workflow run; `sha256sum -c` prints `OK`;
`gh attestation verify` passes against `IvanBBaev/facebook-mcp`; the MCPB bundle
installs in Claude Desktop and its doctor passes.

The bundle is deterministic — the same commit, the same lockfile and the same
Node/zlib produce byte-identical output — so anyone can re-run
`node scripts/pack-mcpb.mjs` at the tag and compare their SHA-256 to the
published one.

---

## Rollback: deprecate, never unpublish

**Never run `npm unpublish`.** It is only allowed within 72 hours, it breaks every
consumer and lockfile that already resolved the version, and npm permanently
burns the `name@version` pair so you cannot re-publish a fixed build under it.

To withdraw a bad release:

1. **Deprecate it** with a message that says what to do instead:
   ```bash
   npm deprecate "@ivanbaev/facebook-mcp@1.0.0" \
     "Broken release - upgrade to 1.0.1. See https://github.com/IvanBBaev/facebook-mcp/releases/tag/v1.0.1"
   ```
   Installs still work but print the warning; `npm view` shows it as deprecated.
2. **Move `latest` off it** if a good version already exists:
   ```bash
   npm dist-tag add "@ivanbaev/facebook-mcp@0.9.9" latest
   ```
3. **Ship the fix as a new version** (`1.0.1`) through this same rail. Do not try
   to re-tag or force-push `v1.0.0`; the tag is the audit record of what was
   published, and npm will reject a re-publish of the same version anyway.
4. **Mark the GitHub Release** as a pre-release (or delete its assets) so the
   `.mcpb` is not the first thing a new user downloads:
   ```bash
   gh release edit v1.0.0 --prerelease --notes "Withdrawn - use v1.0.1."
   ```
5. **The MCP Registry** has no "unpublish" either: publish the corrected version
   so the listing moves forward. If the bad version is actively harmful, contact
   the registry maintainers.
6. If the reason for the rollback was a **leaked credential**, this runbook is not
   enough — go to [credential-rotation.md](credential-rotation.md) first.

---

## Failure modes and fixes

| Symptom                                                                             | Cause                                                                                   | Fix                                                                                                                                                       |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gate`: _Tag vX.Y.Z declares version … but package.json says …_                     | Tagged the wrong commit, or forgot the version bump.                                     | `git push --delete origin vX.Y.Z && git tag -d vX.Y.Z`, fix the version on `main`, re-tag. Nothing was published — the gate runs before every publish step. |
| `gate`: _package.json still has `"private": true`_                                  | Pre-1.0 guard never removed.                                                             | Remove the field in a PR, then re-tag.                                                                                                                     |
| `gate`: _package.json has no `mcpName`_                                             | Registry identity missing.                                                               | Add it **before** the first publish; it cannot be retrofitted onto a published version.                                                                    |
| `gate`: _server.json / manifest.json / plugin.json version != …_                    | Metadata drift — the classic five-surface failure.                                        | `npm run metadata`, commit, re-tag.                                                                                                                    |
| `gate`: _CHANGELOG.md has no `## [X.Y.Z]` section_                                  | Release notes not written, or the heading is `## Unreleased` / `## v1.0.0` instead of the literal `## [1.0.0]`. | Write/rename the section exactly as `## [X.Y.Z]`, commit, re-tag.                                                                       |
| `gate`: `metadata:check` reports drift                                              | A generated artifact was hand-edited, or the version was bumped in `package.json` instead of `scripts/metadata.config.mjs`. | Bump `identity.version` in the SSOT, `npm run metadata`, commit, re-tag. Never patch the artifact.                    |
| `gate`: `npm audit` exits non-zero                                                  | A high/critical advisory in the **production** tree.                                      | Fix it — bump the dependency, or drop it. This gate is not waived for a release; a release is the worst time to ship a known-vulnerable tree.               |
| `npm run check`: _Policy violation: package.json declares install lifecycle script(s)_ | Someone added `preinstall`/`install`/`postinstall`/`prepare`.                          | Remove it. This package runs no code at install time; the post-install check is the user-run `doctor` subcommand.                                            |
| `npm version` refuses with _do not bump the version with npm version_               | Working as designed — `package.json#version` is generated.                                | Edit `identity.version` in `scripts/metadata.config.mjs`, then `npm run metadata`.                                                                          |
| Local `npm publish` refuses with _publishing happens in release.yml_                | `prepublishOnly` backstop. Working as designed.                                           | Push a tag instead. The only sanctioned override is the first-ever name-reserving publish (`ALLOW_LOCAL_PUBLISH=1`, one-time setup step 4).                 |
| `npm-publish`: `ENEEDAUTH` / _Unable to authenticate_                               | Trusted publisher not configured, or its binding does not match this workflow.            | Re-check org, repo, workflow filename `release.yml` and the empty environment field on npmjs.com. Re-run the job; nothing else has published yet.           |
| `npm-publish`: `E404` / _Not found — PUT https://registry.npmjs.org/@scope%2fname_ | The credential cannot create this package. npm answers 404 rather than 403 so it does not leak which scopes exist, which makes "token too narrow" and "token belongs to an account that does not own the scope" look identical. | Read the `npm identity for this token:` line the publish step prints. If the username does not own the scope, no token will ever work — fix the scope in `identity.packageName` or create the org. Only if the account is right is re-scoping the token the fix. |
| `npm-publish`: _provenance requires `id-token: write`_ or _repository is private_   | Permissions changed, or the repo is not public.                                           | Restore `id-token: write` on the job / make the repo public. Provenance cannot be added later — re-release as a new patch version.                          |
| `npm-publish`: _You cannot publish over the previously published versions_          | The version already exists on npm (usually a partially-failed earlier run).                | The npm half already succeeded. Do **not** bump blindly — verify with `npm view <pkg>@<version>`, then run only the remaining jobs: `workflow_dispatch` on the tag with `mode: resume`. |
| `bundle`: _no MCPB manifest found_                                                  | `manifest.json` is missing or not generated.                                              | `npm run metadata`, commit, re-tag.                                                                                                                    |
| `bundle`: _manifest declares server.entry_point "…" but that file is not in the bundle_ | The manifest points at a path `package.json#files` does not publish.                  | Fix the entry point or the `files` allowlist; a bundle without its entry point cannot start.                                                                |
| `bundle`: _build/index.js is missing_                                               | Packer ran without a build.                                                               | `npm run build` first (CI already does; locally it is on you).                                                                                             |
| `bundle`: attestation step fails with _missing id-token / attestations permission_  | The job's `permissions:` block was trimmed.                                                | Restore `id-token: write` **and** `attestations: write` on `bundle`. Do not remove the attestation step to get a green run — an unattested bundle is the thing this gate exists to stop. |
| `github-release`: `gh attestation verify` fails                                     | The asset does not match any attestation for this repo — a stale artifact, or a bundle that did not come out of this run. | Stop. Do not upload it. Re-run the workflow from `bundle` so the artifact and its attestation are produced together, and treat an unexplained failure as a supply-chain incident, not a flake. |
| `mcp-registry`: _mcp-publisher checksum mismatch_                                   | The downloaded binary does not match the `MCP_PUBLISHER_SHA256` pinned in `release.yml` — usually a `MCP_PUBLISHER_VERSION` bump without a digest re-pin. | Verify the asset by hand (download, `sha256sum`) and re-pin the digest in a reviewed commit. Never relax the check to unblock a release.                    |
| `mcp-registry`: `::warning::` about the upstream checksums file                     | Upstream `registry_<version>_checksums.txt` disagreed or could not be fetched. The in-repo digest still passed, so the job continued. | Not a failure, but not noise either: confirm the pinned digest is still the right one for that version before the next release.                             |
| `mcp-registry`: _… never became visible on npm_                                     | CDN propagation took longer than the 30 × 20 s (10 min) wait. A scope's **first** package is the slow case — 0.7.0 took 5m17s where a new version of an existing package is visible in seconds. | Wait until `npm view <pkg>@<version>` resolves, then `workflow_dispatch` on the tag with `mode: resume`. npm is unaffected.                                   |
| `mcp-registry`: _authentication failed_ / ownership not verified                    | `mcpName` missing from the published tarball, or `server.json.name` does not match it.     | Both must be right in the tarball itself — fix and release a new version.                                                                                  |
| `github-release`: _release not found_ / tag mismatch                                | Tag was deleted or re-pointed while the run was in flight.                                | Restore the tag, then `workflow_dispatch` on it with `mode: resume`. The job is idempotent: it uploads with `--clobber` when the Release already exists.     |

**Safe to re-run:** the whole workflow is idempotent except `npm publish`, which
fails on an already-published version. Re-running after a partial failure is the
normal recovery path, not a last resort — and once npm has succeeded, the way to
re-run is `workflow_dispatch` on the tag with `mode: resume`, which is exactly
the "everything except npm" run that a plain re-run cannot express.

---

## Related

- [`.github/workflows/release.yml`](../../.github/workflows/release.yml) — the rail itself.
- [`scripts/pack-mcpb.mjs`](../../scripts/pack-mcpb.mjs) — the deterministic bundler (`--help` for options).
- [CHANGELOG.md](../../CHANGELOG.md) — Keep-a-Changelog history; the gate reads it.
- [SECURITY.md](../../SECURITY.md) — why no Meta credential ever reaches CI.
- [credential-rotation.md](credential-rotation.md) — when a release is rolled back because something leaked.
- [`../analysis/10-v1-release-definition.md`](../analysis/10-v1-release-definition.md) — what each version number means.
