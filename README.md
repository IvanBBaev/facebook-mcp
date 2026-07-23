# facebook-mcp — Facebook Pages MCP Server

| [![CI](https://img.shields.io/github/actions/workflow/status/IvanBBaev/facebook-mcp/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/IvanBBaev/facebook-mcp/actions/workflows/ci.yml) | [![CodeQL](https://img.shields.io/github/actions/workflow/status/IvanBBaev/facebook-mcp/codeql.yml?branch=main&style=flat-square&logo=github&label=CodeQL)](https://github.com/IvanBBaev/facebook-mcp/actions/workflows/codeql.yml) |             [![License: MIT](https://img.shields.io/github/license/IvanBBaev/facebook-mcp?style=flat-square&color=blue&label=license)](LICENSE)             |              [![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)              | [![MCP](https://img.shields.io/badge/MCP-server-orange?style=flat-square)](https://modelcontextprotocol.io) |
| :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :---------------------------------------------------------------------------------------------------------------------------------------------------------: | :-----------------------------------------------------------------------------------------------------------------------------------------------------------: | :---------------------------------------------------------------------------------------------------------: |
|                                                                           [![status](https://img.shields.io/badge/status-pre--1.0-yellow?style=flat-square)](#)                                                                            |              [![last commit](https://img.shields.io/github/last-commit/IvanBBaev/facebook-mcp?style=flat-square&logo=git&logoColor=white&label=last%20commit)](https://github.com/IvanBBaev/facebook-mcp/commits/main)              | [![docs](https://img.shields.io/badge/docs-github.io-1877F2?style=flat-square&logo=readthedocs&logoColor=white)](https://ivanbbaev.github.io/facebook-mcp/) | [![Sponsor](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?style=flat-square&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/IvanBBaev) |                                                                                                             |

📖 **[Documentation site →](https://ivanbbaev.github.io/facebook-mcp/)**

A local-first TypeScript [Model Context Protocol](https://modelcontextprotocol.io)
(MCP) server for the **Meta Graph API**, focused on **Facebook Pages** —
publishing, reading & insights, and comment/message moderation — driven from an
MCP client (Claude, VS Code, the Inspector…) and operated locally by a Page admin
using their own Meta developer app. Least-privilege tokens, plan-and-apply write
safety, and no telemetry.

> 🚧 **Status: pre-1.0, in active development.** Not yet published to npm. The
> design is complete and documented; implementation is in progress. Interfaces
> and scope may change until the first tagged release.

**Contents:** [Features](#features) · [Requirements](#requirements) ·
[Setup](#setup) · [Configure credentials](#configure-credentials) ·
[Tools](#tools) · [Security notes](#security-notes) ·
[Documentation](#documentation) · [Support](#support) ·
[Trademark](#trademark) · [License](#license)

## Features

| Area                   | Capability                                                                |
| ---------------------- | ------------------------------------------------------------------------- |
| **Publishing**         | Text / link / photo / video / Reels posts, scheduling, edit & delete      |
| **Reading & insights** | Page & post reads, cursor pagination, live-verified insight metrics       |
| **Moderation**         | Comment hide/unhide/delete, message reads & replies                       |
| **Ads (1.1)**          | Campaign/adset/ad read + status & budget control (opt-in, off by default) |

The default profile exposes a deliberately small, curated tool surface — each
tool wraps a real, verified capability rather than mirroring every Graph edge.

- **Local-first, no telemetry.** Only three Meta hosts are ever reached
  (`graph`, `graph-video`, `rupload`); nothing phones home.
- **Least-privilege credentials.** Works with a never-expiring System User token
  (Business Manager) or a long-lived Page token — no App Review required for an
  admin operating their own assets.
- **Safe writes.** Tiered plan-and-apply gating; irreversible and spend actions
  require out-of-band confirmation and are never bypassed by an env flag.
- **Secret hygiene.** Value-based redaction at a single choke-point across logs,
  errors, tool results, and the write journal.
- **Layered architecture.** Lint-enforced `core ← api ← mcp ← tools` layering,
  tools-as-data with a central package registry.

## Requirements

- Node.js **≥ 22** (enforced by `engines` and a runtime guard in the launcher;
  the project targets the version in `.nvmrc`).
- A Meta (Facebook) developer app — a **Business**-type app at Standard Access is
  enough; no App Review is needed to operate your own assets.
- A Facebook **Page** (and, for the opt-in `ads` package, an **ad account**) you
  administer.

## Setup

### (a) From source (current)

The package is not on npm yet, so build from a clone:

```bash
git clone https://github.com/IvanBBaev/facebook-mcp.git
cd facebook-mcp
npm install
npm run build
node build/index.js   # or: ./bin/facebook-mcp.mjs
```

Configure credentials (see [below](#configure-credentials)), then point your MCP
client at that command.

### (b) Via npx (after the first release)

> Both snippets below become available **after the first published release** —
> the package is currently unpublished.

Register the server with an MCP client (Claude Desktop, VS Code Chat, the
Inspector…) by pointing its command at `npx`:

```json
{
  "mcpServers": {
    "facebook": {
      "command": "npx",
      "args": ["-y", "@ivanbbaev/facebook-mcp"]
    }
  }
}
```

**Claude Code plugin** (installs the server wired up):

```bash
/plugin marketplace add IvanBBaev/facebook-mcp
/plugin install facebook-mcp
```

## Configure credentials

facebook-mcp authenticates with a token **you already control** — there is no
App Review, no OAuth callback server, and no hosted component. Provide **at least
one** of the token variables below; the most specific wins (`FB_SYSTEM_TOKEN` →
`FB_ACCESS_TOKEN` → `FB_PAGE_TOKEN`):

- **`FB_SYSTEM_TOKEN`** — a never-expiring **System User token** (Business
  Manager). Recommended: it does not expire and is scoped to the assets you
  assign it.
- **`FB_ACCESS_TOKEN`** — a Meta user access token (a long-lived one preferred).
- **`FB_PAGE_TOKEN`** — a long-lived **Page token**, the no-Business-Manager
  fallback.

Grant only the permissions the packages you enable actually need
(least-privilege), and set **`FB_APP_SECRET`** so `appsecret_proof` is attached
to every call — that makes a stolen bare token unusable on its own. Settings are
read from an env file at the XDG/`%APPDATA%` config path, or from real
environment variables (which take precedence).

### Environment variables

Provide at least one token; everything else is optional tuning. Variables marked
**Secret** are never logged or returned by a tool.

| Variable                    | Required | Default  | Description                                                                                              |
| --------------------------- | :------: | :------: | -------------------------------------------------------------------------------------------------------- |
| `FB_SYSTEM_TOKEN`           | one of¹  |    —     | **Secret.** Never-expiring System User token (Business Manager). Recommended.                            |
| `FB_ACCESS_TOKEN`           | one of¹  |    —     | **Secret.** Meta user access token (long-lived preferred).                                               |
| `FB_PAGE_TOKEN`             | one of¹  |    —     | **Secret.** Long-lived Page token — the no-Business-Manager fallback.                                    |
| `FB_APP_ID`                 |    no    |    —     | Meta app ID. With `FB_APP_SECRET` it forms the app access token used to inspect tokens.                  |
| `FB_APP_SECRET`             |    no    |    —     | **Secret.** Meta app secret. When set, `appsecret_proof` is attached so a stolen bare token is unusable. |
| `FB_PAGE_ID`                |    no    |    —     | Default Page ID for Page-scoped tools when no profile is given.                                          |
| `FB_PROFILE_<NAME>_PAGE_ID` |    no    |    —     | Page ID for a named profile (e.g. `FB_PROFILE_BRAND_A_PAGE_ID`).                                         |
| `FB_PROFILE_<NAME>_TOKEN`   |    no    |    —     | **Secret.** Optional per-profile token override.                                                         |
| `FB_API_VERSION`            |    no    | `v23.0`  | Graph API version to pin. Off-default values are accepted, but only the default is tested.               |
| `FB_WRITE_MODE`             |    no    |  `plan`  | `plan` (default) previews a write without mutating; `apply` executes.                                    |
| `FB_MEDIA_DIR`              |    no    |    —     | Directory permitted as a source for local media uploads.                                                 |
| `FB_MAX_RESULT_CHARS`       |    no    | `25000`  | Character budget before a tool result is truncated (500–10000000).                                       |
| `FB_REQUEST_TIMEOUT_MS`     |    no    | `60000`  | Per-request timeout in milliseconds (1–600000).                                                          |
| `FB_HOST_CONCURRENCY`       |    no    |   `4`    | Max parallel requests per Graph host (1–64).                                                             |
| `FB_TRANSPORT`              |    no    | `stdio`  | `stdio` (default) or `http` (loopback-only Streamable HTTP for local agent clients).                     |
| `FB_HTTP_TOKEN`             | if http  |    —     | **Secret.** Bearer token required by the `http` transport; it fails closed without it.                   |
| `FB_HTTP_PORT`              |    no    |  `3000`  | TCP port for the `http` transport (bind host is fixed to loopback `127.0.0.1`).                          |
| `FB_TOOL_PACKAGES`          |    no    |  `core`  | Comma/space-separated tool packages to enable. `core` is always on.                                      |
| `FB_PACKAGES_DENY`          |    no    |    —     | Packages to exclude even if enabled by `FB_TOOL_PACKAGES`.                                               |
| `FB_PACKAGES_READONLY`      |    no    |    —     | Packages whose write tools are not registered; their read tools stay.                                    |
| `FB_JOURNAL_PATH`           |    no    | XDG path | Path to the append-only write journal.                                                                   |
| `FB_LOG_LEVEL`              |    no    |  `info`  | Stderr log verbosity: `debug`, `info`, `warn`, `error`.                                                  |
| `FB_AD_ACCOUNT_ID`          |    no    |    —     | Ad account ID for the opt-in `ads` package (1.1).                                                        |
| `FB_ADS_BUDGET_CEILING`     |    no    |    —     | Hard budget ceiling for ads writes, in minor currency units (non-negative integer).                      |
| `FB_CONFIRM_TOKEN`          |    no    |    —     | **Secret.** Out-of-band confirmation token authorizing gated write / spend actions.                      |

¹ Provide at least one of `FB_SYSTEM_TOKEN`, `FB_ACCESS_TOKEN` or `FB_PAGE_TOKEN`.

## Tools

<!-- GENERATED:TOOLS:BEGIN (regenerate after Wave 4) -->

The always-on `core` package ships four **read-only** tools today. The
`reader`, `posts`, `insights`, `moderation`, `messages` and `ads` packages are
on the roadmap, and this table will grow as they land.

| Package | Tool                  | Read-only | Description                                                                                                                                              |
| ------- | --------------------- | :-------: | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`  | `facebook_whoami`     |    yes    | Report the identity behind the configured token (type, validity, granted permissions, expiry) plus the server and pinned Graph API version.              |
| `core`  | `facebook_list_pages` |    yes    | List the Pages the operator administers (via `/me/accounts`): id, name, category, tasks and token presence. Page tokens are never returned.              |
| `core`  | `facebook_get_page`   |    yes    | Fetch metadata for one Page — name, category, follower/fan counts, publish state and video upload limits.                                                |
| `core`  | `facebook_usage`      |    yes    | Report the most recent Graph rate-limit signals (`X-App-Usage`, `X-Business-Use-Case-Usage`) as usage percentages so you can back off before a throttle. |

<!-- GENERATED:TOOLS:END -->

## Security notes

- **Three-host fence.** Only `graph.facebook.com`, `graph-video.facebook.com`
  and `rupload.facebook.com` are ever contacted — the allowlist is fixed in code
  and not user-configurable, so a redirected or mistyped host cannot silently
  receive a token.
- **Plan-and-apply write gating.** Writes default to `plan` (a non-mutating
  preview); `apply` executes. Irreversible and spend actions additionally require
  an out-of-band confirmation and are never bypassed by an env flag.
- **Single-choke-point redaction.** Secret values are stripped at one place
  before anything reaches logs, errors, tool results or the write journal; Page
  access tokens are derived to a boolean and their values never enter a payload.
- **No telemetry, local-first.** The server logs only to `stderr`, collects
  nothing, and phones home nowhere. The `http` transport binds loopback
  (`127.0.0.1`) only and fails closed without `FB_HTTP_TOKEN`.

See [SECURITY.md](SECURITY.md) for the full model and vulnerability reporting.

## Documentation

- **Design corpus** — the full pre-implementation analysis lives in
  [`docs/analysis/`](docs/analysis/README.md): goals & scope, market positioning,
  Graph API landscape, auth & security model, architecture, tool catalog, risks,
  roadmap, corner cases, the v1.0 release definition, and the parallel
  task-breakdown that drives development.
- **Documentation site** — [ivanbbaev.github.io/facebook-mcp](https://ivanbbaev.github.io/facebook-mcp/).

## Support

Best-effort, single-maintainer support runs through GitHub — see
[SUPPORT.md](SUPPORT.md) for how to file bugs, feature requests and security
reports.

This project is built and maintained in my own time. If it helps, a tip keeps it
going:

- **[GitHub Sponsors](https://github.com/sponsors/IvanBBaev)** — one-off or
  recurring, no platform fee.
- **[Ko-fi](https://ko-fi.com/ivanbbaev)** — quick one-off support (also accepts
  PayPal), the fallback for anyone without a GitHub account.

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?style=flat-square&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/IvanBBaev)
[![Support on Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?style=flat-square&logo=kofi&logoColor=white)](https://ko-fi.com/ivanbbaev)

## Trademark

This is an independent, community-built project and is not affiliated with,
endorsed by, or sponsored by Meta Platforms, Inc. Facebook, Meta and related
marks are trademarks of Meta Platforms, Inc., used here only nominatively to
indicate compatibility.

## License

[MIT](LICENSE) © 2026 Ivan Baev
