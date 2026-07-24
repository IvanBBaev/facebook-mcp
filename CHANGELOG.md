# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).
Planned work is tracked on the [roadmap board](https://github.com/users/IvanBBaev/projects/3)
and its [milestones](https://github.com/IvanBBaev/facebook-mcp/milestones); the git history is one commit per task.

## [Unreleased]

Pre-1.0 work in progress — **not yet released to npm.** The design corpus is
complete and the foundation is implemented and tested; the tool surface is still
being filled out package by package.

### Added

- **Layered architecture.** A lint-enforced four-layer boundary
  `core → api → mcp → tools`: `core` (config/settings, auth and `/debug_token`
  classification, the Graph HTTP client with the retry/error matrix, the
  per-host semaphore, value-based secret redaction and the append-only write
  journal), `api` (shared cursor pagination), `mcp` (tool authoring and the
  server wiring), and `tools` (the tool packages themselves).
- **`core` tool package (always on, read-only).** Four tools:
  `facebook_whoami` (classify the configured token — type, validity, granted
  permissions, expiry — plus server and pinned Graph API version),
  `facebook_list_pages` (the Pages the operator administers via `/me/accounts`,
  with Page-token presence but never the token value), `facebook_get_page`
  (metadata for one resolved Page) and `facebook_usage` (the most recent Graph
  rate-limit headers as usage percentages).
- **Tools-as-data authoring.** `defineTool` (schema-validated, annotation-typed
  tool specs) and a central package registry that expands the default profile,
  forces `core` on and applies the deny / read-only package policy.
- **Structure-aware result shaper.** A single result/envelope shaper enforces the
  `FB_MAX_RESULT_CHARS` truncation budget, strips paging cursors and tokens, and
  runs every payload through the redactor before it leaves the process.
- **Tiered plan-and-apply write gating + journal.** A `plan | apply` write mode
  with per-tool blast-radius tiers (`safe` / `reversible` / `irreversible` /
  `spend`); `irreversible` and `spend` are never bypassed by the env flag. Each
  applied mutation is recorded in a redaction-aware, rotation-aware,
  owner-only (0600) append-only journal.
- **Tainted-UGC confirmation.** User-generated content (comments, messages,
  visitor posts) is wrapped in a delimited, injection-warned taint envelope
  before it reaches the model, and an out-of-band confirmation seam
  (MCP elicitation, with an operator-token fallback via `FB_CONFIRM_TOKEN`)
  gates destructive and spend actions.
- **Transports.** stdio (default) and a loopback-only Streamable HTTP transport
  that fails closed without `FB_HTTP_TOKEN` and validates the request `Origin`.
- **`doctor` diagnostic.** A startup self-check that aggregates every `FB_*`
  configuration problem into one report and probes whether the configured token
  actually works, so misconfiguration surfaces in one pass.
- **Distribution manifests.** An MCP Registry `server.json`, a Claude Code plugin
  bundle (`.claude-plugin/`), a `FUNDING.yml` sponsor button and this changelog.
- **Documentation site.** A zero-build GitHub Pages site at
  [ivanbbaev.github.io/facebook-mcp](https://ivanbbaev.github.io/facebook-mcp/),
  including funding links and a per-package shipping status so the public page
  never claims a capability that is not implemented yet.

### Changed

- **Honest capability reporting.** The README, the Pages site and the FAQ now
  distinguish what ships today (the read-only `core` package, four tools) from
  what is designed and scheduled, with every planned area linked to its release
  milestone. A new README `Roadmap` section points at the public roadmap board.

### Fixed

- **Windows CI line endings.** A `.gitattributes` now normalises the tree to LF,
  so a Windows checkout no longer rewrites every file to CRLF and fails
  `prettier --check` on the Windows CI leg while Linux and macOS pass.

### Security

- **Fixed Graph-API host allowlist.** Only `graph.facebook.com`,
  `graph-video.facebook.com` and `rupload.facebook.com` are ever contacted; there
  are no user-configurable hosts and no telemetry.
- **Secret hygiene.** Tokens and the app secret are redacted at a single
  choke-point across logs, errors, tool results and the journal; the
  `appsecret_proof` signature (when `FB_APP_SECRET` is set) makes a stolen bare
  token unusable.

[Unreleased]: https://github.com/IvanBBaev/facebook-mcp/commits/main
