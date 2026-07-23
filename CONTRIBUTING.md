# Contributing to facebook-mcp

Thanks for your interest. This is a single-maintainer, documentation-first
project; contributions are welcome as long as they respect the design principles
in the [README](README.md) and the pre-implementation corpus in
[`docs/analysis/`](docs/analysis/README.md). Read those first — most "why is it
built this way?" questions are answered there.

Please keep changes small, focused, and green against the single check gate
described below.

## Prerequisites

- **Node.js ≥ 22.** The floor is enforced by `engines` in `package.json` and
  pinned in `.nvmrc` (`22`). CI runs on Node 22, 24, and 26, plus a Windows leg
  on Node 22.
- **npm** (the repository ships a committed `package-lock.json`; use `npm ci` for
  reproducible installs).
- No global tooling is required — TypeScript, ESLint, Prettier, and the test
  runner are all dev dependencies.

## Repository layout

```
bin/        CommonJS/ESM launcher with a Node-version guard
src/
  core/     L0 — config, settings, auth + per-page token resolver, HTTP client,
            host allowlist, errors, logging, the value-based redaction choke-point
  api/      L1 — Graph API domain functions (pages, posts, media, comments, …)
  mcp/      L2 — define/registry/packages, result shaper, write-mode + journal,
            transport, taint/confirm seams
  tools/    L3 — ToolSpec[] per package (data, not code)
  testing/  test harness (network fence, withEnv/withFetch helpers)
scripts/    maintenance/record scripts (fixture recording, smokes)
docs/       analysis corpus, reviews, and operator runbooks
test/       shared fixtures
```

## The check gate

`npm run check` is the **single** gate. Run it before you push; CI runs the same
command on every push and pull request. It executes, in order:

| Step           | Command                | What it enforces                                    |
| -------------- | ---------------------- | --------------------------------------------------- |
| `typecheck`    | `tsc --noEmit`         | Strict TypeScript, no type errors                   |
| `lint`         | `eslint .`             | Lint rules, including the layering rule below       |
| `format:check` | `prettier --check .`   | Prettier-enforced formatting                        |
| `build`        | `tsc`                  | Emits `build/` (tests run against the built output) |
| `test`         | `node --test` (fenced) | All `*.test.ts` pass, with the network fence active |

If any step fails, the gate fails. Fix the cause rather than skipping the step.

To auto-fix formatting: `npm run format`.

## Architecture rule: layers point leftward only

The codebase is a lint-enforced four-layer stack:

```
core ← api ← mcp ← tools
```

Imports may only point **leftward** — `tools` may import from `mcp`, `api`, and
`core`; `mcp` may import from `api` and `core`; `api` may import from `core`;
`core` imports from nothing above it. This is enforced by ESLint
`no-restricted-imports`, so a wrong-direction import fails `npm run check`, not
just review. In particular, `tools` must **never** import `core/http` directly —
all Graph traffic goes through the `api` layer.

Keep the layers' responsibilities intact: domain HTTP logic lives in `api`,
MCP-facing plumbing (result shaping, write-mode gating, the journal) lives in
`mcp`, and tool definitions in `tools` are declarative `ToolSpec` data.

## Coding conventions

- **ESM / NodeNext.** Relative imports carry explicit `.js` extensions (e.g.
  `import { redact } from './redact.js'`), because the build emits ESM and Node
  resolves the emitted `.js`, not the `.ts` source.
- **Strict TypeScript,** including `noUncheckedIndexedAccess`. Prefer narrow
  types and exhaustive handling over `any` and non-null assertions.
- **Prettier owns formatting** (`singleQuote: true`, `printWidth: 90`). Do not
  hand-format; run `npm run format`.
- **No new runtime dependencies** without discussion — the runtime dependency
  budget is deliberately tiny (`@modelcontextprotocol/sdk`, `zod`, `dotenv`).
- **Secrets never touch code, logs, or fixtures.** Every log line, error, and
  tool result passes through the value-based redaction choke-point; never add a
  path that bypasses it, and never commit a real token (see the network fence
  below).

## Tests

- Tests are **colocated** next to the code they cover as `*.test.ts` and use
  `node:test` + `node:assert/strict`.
- The suite runs against the **built output** (`build/**/*.test.js`), so build
  before testing.
- **Network fence.** Tests run under `--import ./build/testing/network-fence.js`,
  which throws on any real network call. Tests must never hit the network; use
  the `withFetch` recording mock and the synthetic/sanitized fixtures under
  `test/fixtures/`. Live-only checks belong in `scripts/smoke/` (gated behind an
  explicit smoke flag), outside the test glob — never in the unit suite.

### Running a single test file

Build first, then point the runner at the compiled test:

```bash
npm run build
node --import ./build/testing/network-fence.js --test build/core/redact.test.js
```

(Use the `build/…/*.test.js` path — not the `src/…/*.test.ts` source — because
tests execute against the emitted output.)

## Commits and pull requests

- Keep PRs **small and focused** — one concern per PR is far easier to review.
- Run `npm run check` locally and make sure it is **green** before opening the
  PR; CI will run it again on Node 22/24/26 and Windows.
- Write clear, imperative commit messages with a short area prefix (e.g.
  `api: strip nested paging tokens from the result shaper`). Do not add co-author
  or tooling-attribution trailers.
- Respect the layer rule and update docs when you change behavior (see the PR
  template's docs-updated checkbox).
- If you find a **security** issue, do **not** open a public issue or PR — follow
  [SECURITY.md](SECURITY.md) instead.

## Getting help

See [SUPPORT.md](SUPPORT.md) for where to ask questions and file bug reports and
feature requests.
