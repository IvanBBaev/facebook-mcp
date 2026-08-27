# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).
Planned work is tracked on the [roadmap board](https://github.com/users/IvanBBaev/projects/3)
and its [milestones](https://github.com/IvanBBaev/facebook-mcp/milestones); the git history is one commit per task.

## [Unreleased]

### Fixed

- **Release rail: a recovery path for a release whose npm half already
  succeeded.** `npm publish` is one-shot, so when a later job failed there was no
  way to finish the release: a plain re-run of the failed jobs is refused by
  GitHub once the run is that old, and re-tagging dies on the npm step before it
  reaches anything else. `workflow_dispatch` now takes a `mode` input — `resume`
  runs `github-release` and `mcp-registry` for real against the tarball that is
  already public, and leaves npm alone. The default stays `rehearsal`, which
  publishes nothing.
- **Release rail: the wait for npm CDN propagation was too short.** A scope's
  first package is far slower to appear than a new version of an existing one —
  0.7.0 took 5m17s against a 200-second window — so `mcp-registry` failed on a
  release that had otherwise succeeded. The window is now 10 minutes; erring long
  costs runner minutes, erring short costs a manual recovery run.

## [0.7.0] - 2026-08-25

First public release. **Pre-1.0 on purpose, and the version number is the
warning:** the design corpus is complete and all seven tool packages are
implemented, registered and unit-tested against recorded responses, but what is
still outstanding for 1.0 is verification, not implementation. The live
exit-gate smoke runs against a real test Page have not been executed, so no tool
in this release has been confirmed against the real Graph API. Treat every
capability below as "implemented and tested in isolation", not as "proven in
production" — and expect the 1.0 line to be the one that carries live
verification, not new surface area.

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
- **`reader` tool package (read-only).** Four tools: `facebook_list_posts`,
  `facebook_get_post`, `facebook_list_reels` and `facebook_get_reactions` — Page
  feed and Reels listing with cursor pagination, and reaction breakdowns.
- **`posts` tool package (writes).** Eight tools: text, photo, video and Reel
  publishing (`facebook_create_post`, `facebook_create_photo_post`,
  `facebook_create_video_post`, `facebook_create_reel`), scheduling and the
  scheduled-post list (`facebook_list_scheduled_posts`), edit and delete
  (`facebook_update_post`, `facebook_delete_post`), and upload-state polling for
  large media (`facebook_get_video_status`). Video and Reel uploads are
  resumable and report progress to clients that request it.
- **`insights` tool package (read-only).** `facebook_page_insights` and
  `facebook_post_insights`, with metric names validated before the call so an
  unknown metric fails locally instead of returning a silently empty series.
- **`moderation` tool package (writes).** Eight tools: comment listing and
  reading, reply, hide, delete, the one-shot `facebook_private_reply` (7-day
  window and single-attempt rule checked client-side before anything is sent),
  and the reversible `facebook_block_user` / `facebook_unblock_user` pair.
- **`messages` tool package (writes).** `facebook_list_conversations`,
  `facebook_get_conversation` and `facebook_send_message`, with the 24-hour
  standard messaging window evaluated on every call — including on an `apply`
  that follows a stale preview — and an ambiguous send recorded as `attempted`
  rather than `failed`, so a lost response never invites a double-send.
- **`ads` tool package (opt-in, not part of 1.0).** Campaign / ad-set / ad
  listing and reading, guarded status and budget updates, and asynchronous
  insight reports (`facebook_ads_insights`, `facebook_ads_report_status`). Off
  unless explicitly enabled; it ships as a supported capability in 1.1.0.
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
- **`setup-token` subcommand.** An interactive first-run helper that exchanges a
  short-lived user token for a long-lived Page token and writes it to the env
  file with owner-only permissions. It never prints, logs or echoes a token
  value, and it warns when a token is passed on the command line, where `ps` and
  the shell history can see it.
- **Progress notifications.** Long uploads emit MCP `notifications/progress`
  frames when — and only when — the client supplied a progress token. Delivery is
  best-effort and detached, so a closed stream can never fail an upload that
  otherwise succeeded.
- **Distribution manifests.** An MCP Registry `server.json`, a Claude Code plugin
  bundle (`.claude-plugin/`), an MCPB desktop bundle built by
  `scripts/pack-mcpb.mjs`, a `FUNDING.yml` sponsor button and this changelog. All
  of them, plus the README env table and `.env.example`, are generated from a
  single metadata source (`scripts/metadata.config.mjs`) and checked for drift in
  CI, so the shipped manifests cannot disagree with the code.
- **CI-only publishing.** A tag-triggered release workflow publishes to npm with
  provenance from GitHub Actions; the package declares no install lifecycle
  scripts, and a guard fails the build if one is ever added. Local publishing and
  `npm version` are both refused by design — see
  [`docs/runbooks/release.md`](docs/runbooks/release.md).
- **Operator runbooks.** Seven procedural guides under `docs/runbooks/` —
  onboarding, credential rotation, kill switch, the ~4-week Meta app upkeep pass,
  offboarding, the release cut, and the operator window for the three tools no
  automated test can cover.
- **Documentation site.** A zero-build GitHub Pages site at
  [ivanbbaev.github.io/facebook-mcp](https://ivanbbaev.github.io/facebook-mcp/),
  including funding links and a per-package shipping status so the public page
  never claims a capability that is not implemented yet.

### Changed

- **Honest capability reporting.** The README, the Pages site and the FAQ
  distinguish what is implemented from what is designed and scheduled, with every
  planned area linked to its release milestone, and they now state plainly that
  nothing has been verified against the real Graph API yet. A README `Roadmap`
  section points at the public roadmap board.

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
- **Release-toolchain integrity.** The `mcp-publisher` binary used to list the
  server on the MCP Registry is verified against a SHA-256 committed to this
  repository rather than against a checksum file fetched from the same place as
  the binary; the upstream checksums file is kept only as a warning-level
  cross-check. A mismatch fails the release.
- **Attested desktop bundle.** The `.mcpb` bundle now carries a GitHub
  build-provenance attestation, re-verified with `gh attestation verify` before
  the asset is attached to the Release — so the file on the Release page can be
  proven to have come out of this repository's workflow, which a checksum
  published beside it cannot do.

[Unreleased]: https://github.com/IvanBBaev/facebook-mcp/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/IvanBBaev/facebook-mcp/releases/tag/v0.7.0
