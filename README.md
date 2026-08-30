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

> 🚧 **Status: pre-1.0, in active development.** Published on npm as
> [`@ivanbaev/facebook-mcp`](https://www.npmjs.com/package/@ivanbaev/facebook-mcp)
> — and the version number is the warning.
>
> All seven tool packages are implemented — see the [tool table](#tools) for the
> exact surface. **Nothing has been verified against the live Graph API yet.**
> Every test in this repository runs against fakes and recorded fixtures behind a
> network fence that throws on a real `fetch`, so "the tests pass" means "the code
> does what the fixtures say", not "Meta accepted it". A live smoke harness
> exists ([`scripts/smoke/`](scripts/smoke/README.md)) but has not been run
> against a real Page as part of any released state. Treat every capability below
> as **implemented but unproven**, expect breaking changes until 1.0, and read
> [Known limitations](#known-limitations) before you rely on anything.

**Contents:** [Features](#features) · [Requirements](#requirements) ·
[Setup](#setup) · [Client compatibility](#client-compatibility) ·
[Configure credentials](#configure-credentials) ·
[Permissions](#permissions-you-need-to-grant) · [Tools](#tools) ·
[How this compares](#how-this-compares) ·
[Known limitations](#known-limitations) · [Not in scope](#not-in-scope) ·
[Your responsibilities](#your-responsibilities-as-the-operator) ·
[Roadmap](#roadmap) · [Security notes](#security-notes) ·
[Documentation](#documentation) · [Support](#support) ·
[Trademark](#trademark) · [License](#license)

## Features

Implementation status only — see the status note above for what "implemented"
does and does not mean.

| Area                   | Capability                                                                      | Status                            |
| ---------------------- | ------------------------------------------------------------------------------- | --------------------------------- |
| **Core & diagnostics** | Identity, Page listing, rate-limit usage, `doctor` pre-flight check             | ✅ Implemented, not live-verified |
| **Reading**            | Page & post reads, Reels, reactions, cursor pagination                          | ✅ Implemented, not live-verified |
| **Publishing**         | Text / link / photo / video / Reels posts, scheduling, edit & delete            | ✅ Implemented, not live-verified |
| **Insights**           | Page & post insights, flat rows + per-metric summaries, deprecation-aware       | ✅ Implemented, not live-verified |
| **Moderation**         | Comment reads, replies, hide/delete, private reply, block/unblock               | ✅ Implemented, not live-verified |
| **Messaging**          | Conversation reads and replies within the 24-hour window                        | ✅ Implemented, not live-verified |
| **Ads**                | Campaign/adset/ad reads, insights, status & budget control — **off by default** | ✅ Implemented, not live-verified |
| **Live verification**  | Every tool exercised against a real Page and a real ad account                  | ❌ Not done — see the status note |
| **npm / MCPB release** | `npx @ivanbaev/facebook-mcp`, attested bundle, registry listing                 | ✅ Published — 0.7.0              |

The default profile exposes a deliberately small, curated tool surface — each
tool wraps one real capability rather than mirroring every Graph edge.

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

### (a) Via npx

Configure credentials first (see [below](#configure-credentials)), then run the
pre-flight check:

```bash
npx -y @ivanbaev/facebook-mcp doctor   # token, scopes, package matrix
```

Register it with your MCP client:

```json
{
  "mcpServers": {
    "facebook": {
      "command": "npx",
      "args": ["-y", "@ivanbaev/facebook-mcp"]
    }
  }
}
```

**Claude Code plugin** (installs the server wired up):

```bash
/plugin marketplace add IvanBBaev/facebook-mcp
/plugin install facebook-mcp
```

**Claude Desktop** takes the `.mcpb` bundle attached to the
[latest release](https://github.com/IvanBBaev/facebook-mcp/releases/latest). It
carries a build-provenance attestation, so you can prove it came out of this
repository's workflow before you install it:

```bash
gh attestation verify facebook-mcp-0.7.0.mcpb --repo IvanBBaev/facebook-mcp
```

### (b) From source

For development, or to run a commit that is not released yet:

```bash
git clone https://github.com/IvanBBaev/facebook-mcp.git
cd facebook-mcp
npm install
npm run build
node build/index.js doctor   # pre-flight: token, scopes, package matrix
node build/index.js          # or: ./bin/facebook-mcp.mjs
```

Point your MCP client at that command with an absolute path:

```json
{
  "mcpServers": {
    "facebook": {
      "command": "node",
      "args": ["/absolute/path/to/facebook-mcp/build/index.js"],
      "env": { "FB_SYSTEM_TOKEN": "…", "FB_PAGE_ID": "…" }
    }
  }
}
```

## Client compatibility

This is a standard stdio MCP server with no client-specific code, so it should
work anywhere the protocol does. **"Should" is the operative word:** the table
records the configuration each client needs and whether that path has actually
been exercised — not a promise.

| Client                             | How you register it                                              | Verified?                                      |
| ---------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| **Claude Desktop**                 | `claude_desktop_config.json` → `mcpServers`, or a `.mcpb` bundle | ❌ Not yet — bundle never installed end-to-end |
| **Claude Code**                    | `claude mcp add`, or the plugin marketplace in this repo         | ❌ Not yet                                     |
| **VS Code (Copilot Chat / agent)** | `.vscode/mcp.json` → `servers`                                   | ❌ Not yet                                     |
| **Cursor**                         | `~/.cursor/mcp.json` → `mcpServers`                              | ❌ Not yet                                     |
| **Windsurf, Zed, Cline, …**        | any client that speaks stdio JSON-RPC                            | ❌ Not yet                                     |
| **MCP Inspector**                  | point it at `node build/index.js`                                | ❌ Not yet                                     |

What **is** verified, by automated test:

- **stdio framing** — a test spawns the built server as a real subprocess, runs
  the full `initialize` → `tools/list` → `tools/call` handshake over pipes, and
  asserts that stdout carries protocol frames only (all logging goes to stderr).
- **Tool contracts** — every tool's input/output schema, annotations, write tier
  and error mapping are unit-tested against fakes and recorded fixtures.
- **The HTTP transport** — loopback binding, bearer-token rejection and session
  handling, again against a real local server.

None of that involves an MCP client or the Meta API. If you get it working with
a client, [say so in an issue](https://github.com/IvanBBaev/facebook-mcp/issues) —
that is how this table turns into ✅.

### Platform notes

CI runs the full check on Linux (Node 22/24/26) and Windows (Node 22). macOS is
the primary development platform but is not in CI. Paths for the env file, the
write journal and `FB_MEDIA_DIR` follow XDG on POSIX and `%APPDATA%` on Windows.

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
([full list below](#permissions-you-need-to-grant)), and set **`FB_APP_SECRET`**
so `appsecret_proof` is attached to every call — that makes a stolen bare token
unusable on its own. Settings are read from an env file at the XDG/`%APPDATA%`
config path, or from real environment variables (which take precedence).

If you would rather not assemble the env file by hand, run
`node build/index.js setup-token` — the guided flow exchanges and classifies a
token and writes the env file for you (`--page=<id>`, `--env-file=<path>`,
`--force` to overwrite, `--no-write`/`--dry-run` to rehearse; pass the token via
`FB_SETUP_TOKEN` rather than on the command line). See
[docs/runbooks/onboarding.md](docs/runbooks/onboarding.md) for the full walkthrough.

Then run `node build/index.js doctor` before anything else: it inspects the
token, reports type, expiry and granted scopes, and prints a per-package
usable / partial / blocked matrix so you find a missing permission before a tool
call does.

`node build/index.js --version` (or `-v`) prints the server, Node and MCP SDK
versions on one line and exits — it needs no credential, so it still answers on
an install that cannot start:

```text
facebook-mcp 0.7.0 (node v22.23.0, darwin arm64, sdk 1.30.0)
```

The bare server version is always the second field, so `--version | awk '{print
$2}'` keeps working. The same three versions plus the pinned Graph API version
are reported by `facebook_whoami` in its `server` object (`name`, `version`,
`apiVersion`, `sdkVersion`). `doctor`, `setup-token` and `--version` are the only
arguments that exit on their own; **anything else starts the stdio server** and
waits on JSON-RPC.

### Environment variables

Provide at least one token; everything else is optional tuning. Variables marked
**Secret** are never logged or returned by a tool.

<!-- BEGIN GENERATED: env -->

| Variable                    | Required |                 Default                  | Description                                                                                                              |
| --------------------------- | :------: | :--------------------------------------: | ------------------------------------------------------------------------------------------------------------------------ |
| `FB_SYSTEM_TOKEN`           | one of¹  |                    —                     | **Secret.** System User token (Business Manager). Recommended; wins over the other two.                                  |
| `FB_ACCESS_TOKEN`           | one of¹  |                    —                     | **Secret.** Meta user access token (a long-lived one preferred).                                                         |
| `FB_PAGE_TOKEN`             | one of¹  |                    —                     | **Secret.** Long-lived Page token — the no-Business-Manager fallback.                                                    |
| `FB_APP_ID`                 |    no    |                    —                     | Meta app ID. With `FB_APP_SECRET` it forms the app token used to inspect tokens.                                         |
| `FB_APP_SECRET`             |    no    |                    —                     | **Secret.** When set, `appsecret_proof` is attached so a stolen bare token is unusable.                                  |
| `FB_PAGE_ID`                |    no    |                    —                     | Default Page ID for Page-scoped tools when a call omits `profile`.                                                       |
| `FB_API_VERSION`            |    no    |                 `v23.0`                  | Graph API version to pin. Off-default values are accepted, but only the default is tested.                               |
| `FB_REQUEST_TIMEOUT_MS`     |    no    |                 `60000`                  | Per-request timeout in milliseconds (1–600000).                                                                          |
| `FB_HOST_CONCURRENCY`       |    no    |                   `4`                    | Max parallel requests per Graph host (1–64).                                                                             |
| `FB_MAX_RESULT_CHARS`       |    no    |                 `25000`                  | Character budget before a tool result is truncated (500–10000000).                                                       |
| `FB_WRITE_MODE`             |    no    |                  `plan`                  | `plan` (default) previews a write without mutating; `apply` executes. Never covers the irreversible/spend tiers.         |
| `FB_CONFIRM_TOKEN`          |    no    |                    —                     | **Secret.** Out-of-band confirmation token authorizing gated write / spend actions, for clients that cannot prompt.      |
| `FB_MEDIA_DIR`              |    no    |                    —                     | Directory permitted as a source for local media uploads. Unset ⇒ URL-only, local file access disabled.                   |
| `FB_JOURNAL_PATH`           |    no    |        XDG / %APPDATA% state path        | Path to the append-only, rotating write journal (0600).                                                                  |
| `FB_TOOL_PACKAGES`          |    no    | core profile (all packages except `ads`) | Comma-separated packages or profiles to enable. `core` is always forced on; `ads` is opt-in.                             |
| `FB_PACKAGES_DENY`          |    no    |                    —                     | Packages to exclude even if enabled by `FB_TOOL_PACKAGES`.                                                               |
| `FB_PACKAGES_READONLY`      |    no    |                    —                     | Packages whose write tools are not registered; their read tools stay.                                                    |
| `FB_TRANSPORT`              |    no    |                 `stdio`                  | `stdio` (default) or `http` (loopback-only Streamable HTTP for local agent clients).                                     |
| `FB_HTTP_TOKEN`             | if http  |                    —                     | **Secret.** Bearer token required by the `http` transport; it fails closed without it.                                   |
| `FB_HTTP_PORT`              |    no    |                  `3000`                  | TCP port for the `http` transport (the bind host is fixed to loopback `127.0.0.1`).                                      |
| `FB_AD_ACCOUNT_ID`          |    no    |                    —                     | Ad account ID for the opt-in `ads` package.                                                                              |
| `FB_ADS_BUDGET_CEILING`     |    no    |                    —                     | Hard budget ceiling for ads writes, in minor currency units (non-negative integer).                                      |
| `FB_LOG_LEVEL`              |    no    |                  `info`                  | Stderr log verbosity: `debug`, `info`, `warn`, `error`.                                                                  |
| `FB_SETUP_TOKEN`            |    no    |                    —                     | **Secret.** Short-lived user token consumed once by `setup-token`; the safe alternative to passing it as a CLI argument. |
| `FB_PROFILE_<NAME>_PAGE_ID` |    no    |                    —                     | Page ID for a named profile, e.g. FB_PROFILE_BRAND_A_PAGE_ID.                                                            |
| `FB_PROFILE_<NAME>_TOKEN`   |    no    |                    —                     | **Secret.** Optional per-profile token override for the matching FB_PROFILE_<NAME>_PAGE_ID.                              |

¹ Provide at least one of `FB_SYSTEM_TOKEN`, `FB_ACCESS_TOKEN` or `FB_PAGE_TOKEN`.
A full, commented template lives in [`.env.example`](.env.example).

<!-- END GENERATED -->

## Permissions you need to grant

<!-- BEGIN GENERATED: scopes -->

Grant only what the packages you actually enable require. The scopes below
are the ones this server asks for; `node build/index.js doctor` compares them
against what your token really has and prints a per-package usable / partial /
blocked matrix. `business_management` is deliberately **not** in this list — it
is a setup-only permission that should never ride on a runtime token.

| Package      | Required Graph permissions                             |
| ------------ | ------------------------------------------------------ |
| `core`       | `pages_show_list`<br>`pages_read_engagement`           |
| `reader`     | `pages_read_engagement`<br>`pages_read_user_content`   |
| `posts`      | `pages_manage_posts`<br>`pages_read_engagement`        |
| `insights`   | `read_insights`                                        |
| `moderation` | `pages_read_user_content`<br>`pages_manage_engagement` |
| `messages`   | `pages_messaging`<br>`pages_manage_metadata`           |
| `ads`        | `ads_read`<br>`ads_management`                         |

<details>
<summary>Per-tool scopes (a tool marked <em>inherited</em> has no finer mapping and falls back to its package set)</summary>

| Tool                            | Required Graph permissions                                         |
| ------------------------------- | ------------------------------------------------------------------ |
| `facebook_whoami`               | _(none — the token itself is enough)_                              |
| `facebook_list_pages`           | `pages_show_list`                                                  |
| `facebook_get_page`             | `pages_read_engagement`                                            |
| `facebook_usage`                | _(none — the token itself is enough)_                              |
| `facebook_list_posts`           | `pages_read_engagement`                                            |
| `facebook_get_post`             | `pages_read_engagement`                                            |
| `facebook_list_reels`           | `pages_read_engagement`                                            |
| `facebook_get_reactions`        | `pages_read_engagement`                                            |
| `facebook_create_post`          | `pages_manage_posts`                                               |
| `facebook_create_photo_post`    | `pages_manage_posts`                                               |
| `facebook_create_video_post`    | `pages_manage_posts`                                               |
| `facebook_create_reel`          | `pages_manage_posts`                                               |
| `facebook_update_post`          | `pages_manage_posts`                                               |
| `facebook_delete_post`          | `pages_manage_posts`                                               |
| `facebook_list_scheduled_posts` | `pages_read_engagement`                                            |
| `facebook_get_video_status`     | `pages_manage_posts`, `pages_read_engagement` _(inherited)_        |
| `facebook_page_insights`        | `read_insights`                                                    |
| `facebook_post_insights`        | `read_insights`                                                    |
| `facebook_reel_insights`        | `read_insights`                                                    |
| `facebook_list_comments`        | `pages_read_user_content`                                          |
| `facebook_get_comment`          | `pages_read_user_content`                                          |
| `facebook_reply_to_comment`     | `pages_manage_engagement`                                          |
| `facebook_hide_comment`         | `pages_manage_engagement`                                          |
| `facebook_delete_comment`       | `pages_manage_engagement`, `pages_read_user_content`               |
| `facebook_private_reply`        | `pages_messaging`, `pages_manage_engagement`                       |
| `facebook_block_user`           | `pages_read_user_content`, `pages_manage_engagement` _(inherited)_ |
| `facebook_unblock_user`         | `pages_read_user_content`, `pages_manage_engagement` _(inherited)_ |
| `facebook_list_conversations`   | `pages_messaging`, `pages_manage_metadata`                         |
| `facebook_get_conversation`     | `pages_messaging`, `pages_manage_metadata`                         |
| `facebook_send_message`         | `pages_messaging`                                                  |
| `facebook_list_campaigns`       | `ads_read`                                                         |
| `facebook_list_adsets`          | `ads_read`                                                         |
| `facebook_list_ads`             | `ads_read`                                                         |
| `facebook_get_ad_object`        | `ads_read`                                                         |
| `facebook_ads_insights`         | `ads_read`                                                         |
| `facebook_ads_report_status`    | `ads_read`                                                         |
| `facebook_update_ad_object`     | `ads_management`                                                   |

</details>

<!-- END GENERATED -->

## Tools

Packages are the unit of exposure: you enable and disable whole packages with
`FB_TOOL_PACKAGES`, and `FB_PACKAGES_READONLY` drops a package's write tools
while keeping its reads.

<!-- BEGIN GENERATED: packages -->

| Package      |  On by default  | Tools            | Default write mode | What it covers                                                                                                                                                                                          |
| ------------ | :-------------: | ---------------- | :----------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`       |       yes       | 4 read           |         —          | Always-on identity, Page discovery and rate-limit diagnostics (read-only).                                                                                                                              |
| `reader`     |       yes       | 4 read           |         —          | Read-only access to a Page's own content: posts (four edges), single posts, Reels and reaction totals.                                                                                                  |
| `posts`      |       yes       | 2 read + 6 write |       `plan`       | Publish, schedule, edit and delete Page posts, photos, videos and Reels (plan-first: every write previews before it applies).                                                                           |
| `insights`   |       yes       | 3 read           |         —          | Page, post and Reel insights: compact reshaped metric series, aggregate totals and post-2025 metric-rename guidance (read-only).                                                                        |
| `moderation` |       yes       | 2 read + 6 write |      `apply`       | Read and moderate comments on Page content (list, reply, hide, delete, private reply) and maintain the blocked-users list.                                                                              |
| `messages`   |       yes       | 2 read + 1 write |       `plan`       | Messenger conversations for a Page: poll the inbox, read a thread (untrusted content wrapped, attachments as placeholders) and send one private reply inside the 24-hour window. Plan-first by default. |
| `ads`        | **no** (opt-in) | 6 read + 1 write |       `plan`       | Marketing API access: campaign / ad-set / ad listings with delivery truth, single-object reads, insights with async report runs, and plan-gated status and budget control. Off by default.              |

<!-- END GENERATED -->

<!-- BEGIN GENERATED: tools -->

**37 tools in 7 packages.** 6 packages are on by default; the rest are opt-in via `FB_TOOL_PACKAGES`. Tier `read` never mutates. `reversible` writes are gated by `FB_WRITE_MODE`; `irreversible` and `spend` additionally require a per-call `apply` plus the `plan_id` of a preview you just ran, and are never unlocked by an environment variable alone.

| Package      | Tool                            |      Tier      | Purpose                                                                                                                                                                    |
| ------------ | ------------------------------- | :------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`       | `facebook_whoami`               |     `read`     | Report the identity behind the configured token (type, validity, granted permissions, expiry) plus the server, MCP SDK and pinned Graph API version.                       |
| `core`       | `facebook_list_pages`           |     `read`     | List the Facebook Pages the operator administers (via /me/accounts): id, name, category, the granted tasks, and whether a Page token is available.                         |
| `core`       | `facebook_get_page`             |     `read`     | Fetch metadata for one Page — name, category, follower/fan counts, publish state and new-Page-experience flag.                                                             |
| `core`       | `facebook_usage`                |     `read`     | Report the most recent Graph rate-limit signals (X-App-Usage, X-Business-Use-Case-Usage, x-fb-ads-insights-throttle) as usage percentages, so you can back off before…     |
| `reader`     | `facebook_list_posts`           |     `read`     | List a Page's posts, one cursor page at a time.                                                                                                                            |
| `reader`     | `facebook_get_post`             |     `read`     | Fetch ONE post by its composite id ("{page-id}_{post-id}" as returned by facebook_list_posts).                                                                             |
| `reader`     | `facebook_list_reels`           |     `read`     | List a Page's Reels via the /video_reels edge — the ONLY place Reels are readable.                                                                                         |
| `reader`     | `facebook_get_reactions`        |     `read`     | Read the reactions on one post: a `totals` map per reaction type (LIKE / LOVE / CARE / HAHA / WOW / SAD / ANGRY), the overall `total`, and the list of reacting users.     |
| `posts`      | `facebook_create_post`          |  `reversible`  | Create a Page post: plain text, a link, a multi-link card carousel, or a multi-photo carousel.                                                                             |
| `posts`      | `facebook_create_photo_post`    |  `reversible`  | Publish ONE photo to a Page, optionally with a caption, as a draft, or scheduled.                                                                                          |
| `posts`      | `facebook_create_video_post`    |  `reversible`  | Upload a video to a Page.                                                                                                                                                  |
| `posts`      | `facebook_create_reel`          |  `reversible`  | Publish a Facebook Reel through the three-phase upload (start → transfer → finish) with an explicit video_state: PUBLISHED, DRAFT or SCHEDULED.                            |
| `posts`      | `facebook_update_post`          |  `reversible`  | Edit a Page post the app itself created, or move it through the scheduled-post lifecycle.                                                                                  |
| `posts`      | `facebook_delete_post`          | `irreversible` | Permanently delete a Page post the app itself created — including a scheduled one, which is the only way to cancel it.                                                     |
| `posts`      | `facebook_list_scheduled_posts` |     `read`     | List the Page posts that are queued to publish later, each with its publish time echoed in UTC and in Page-local time.                                                     |
| `posts`      | `facebook_get_video_status`     |     `read`     | Poll where one video stands in Meta's pipeline: uploading, processing, ready or error.                                                                                     |
| `insights`   | `facebook_page_insights`        |     `read`     | Read Graph insights for one Page in a compact flat shape: one row per metric per data point ({metric, date, value}, plus `breakdown` for by-action-type metrics) and one…  |
| `insights`   | `facebook_post_insights`        |     `read`     | Read Graph insights for one published post (post_media_view, post_clicks, post_reactions_by_type_total, video metrics, ...) in the same compact flat shape as…             |
| `insights`   | `facebook_reel_insights`        |     `read`     | Read Graph insights for one Reel from /{video-id}/video_insights — the edge Reel metrics actually live on, which facebook_post_insights cannot reach.                      |
| `moderation` | `facebook_list_comments`        |     `read`     | List the comments on a post, photo, video or another comment, newest-first by default.                                                                                     |
| `moderation` | `facebook_get_comment`          |     `read`     | Read one comment by ID, optionally with its replies, and report whether a private reply is still possible (the 7-day window).                                              |
| `moderation` | `facebook_reply_to_comment`     |  `reversible`  | Post a PUBLIC reply under a comment — visible to everyone who can see the thread.                                                                                          |
| `moderation` | `facebook_hide_comment`         |  `reversible`  | Hide or unhide up to 50 comments in one call (`hidden:true` hides, `hidden:false` restores).                                                                               |
| `moderation` | `facebook_delete_comment`       | `irreversible` | PERMANENTLY delete up to 50 comments.                                                                                                                                      |
| `moderation` | `facebook_private_reply`        | `irreversible` | Send a private message to the author of a comment.                                                                                                                         |
| `moderation` | `facebook_block_user`           |  `reversible`  | Add up to 50 PSIDs to the Page's blocked list: they can no longer comment on the Page or message it.                                                                       |
| `moderation` | `facebook_unblock_user`         |  `reversible`  | Remove up to 50 PSIDs from the Page's blocked list, restoring their ability to comment and message.                                                                        |
| `messages`   | `facebook_list_conversations`   |     `read`     | List Messenger conversations for a Page (platform=messenger only — never Instagram threads): id, updated_time, unread_count, message_count and the latest-message snippet. |
| `messages`   | `facebook_get_conversation`     |     `read`     | Read one Messenger thread newest-message-first: sender, timestamp, direction and body, plus typed placeholders for images, stickers, files and shared links (attachments…  |
| `messages`   | `facebook_send_message`         |  `reversible`  | Send ONE plain-text PRIVATE Messenger message as the Page, as a reply inside the 24-hour standard messaging window (messaging_type=RESPONSE).                              |
| `ads`        | `facebook_list_campaigns`       |     `read`     | List campaigns under one ad account, a cursor page at a time.                                                                                                              |
| `ads`        | `facebook_list_adsets`          |     `read`     | List ad sets under one ad account, a cursor page at a time.                                                                                                                |
| `ads`        | `facebook_list_ads`             |     `read`     | List individual ads under one ad account, a cursor page at a time.                                                                                                         |
| `ads`        | `facebook_get_ad_object`        |     `read`     | Read one campaign, ad set or ad by id.                                                                                                                                     |
| `ads`        | `facebook_ads_insights`         |     `read`     | Read performance numbers (impressions, clicks, spend, reach, cpc, ctr) for an ad account, campaign, ad set or ad.                                                          |
| `ads`        | `facebook_ads_report_status`    |     `read`     | Probe one async insights report run and, with fetch_results:true, read its rows once it has completed.                                                                     |
| `ads`        | `facebook_update_ad_object`     | `irreversible` | Pause or resume an ads object, or change its budget.                                                                                                                       |

<!-- END GENERATED -->

## How this compares

Point-in-time survey (2026-07-21); the full write-up is in
[`docs/analysis/02-market-and-positioning.md`](docs/analysis/02-market-and-positioning.md).

| Project                            | Focus                 | Language   | License  | Distribution           | Notes                                                                        |
| ---------------------------------- | --------------------- | ---------- | -------- | ---------------------- | ---------------------------------------------------------------------------- |
| **facebook-mcp** (this)            | Pages / organic + ads | TypeScript | MIT      | npm + MCPB bundle      | Multi-Page, plan-and-apply writes, redaction, MCP annotations & outputSchema |
| **Meta's official hosted Ads MCP** | Ads only              | hosted     | Meta ToS | `mcp.facebook.com/ads` | Business OAuth, no developer app, ~29 tools. Free.                           |
| **pipeboard-co/meta-ads-mcp**      | Ads                   | Python     | BUSL-1.1 | hosted-remote          | Market leader (~1.1k ★), 42 tools. Not OSI open source.                      |
| **HagaiHen/facebook-mcp-server**   | Pages                 | Python     | MIT      | source only            | The only other notable Pages server: 27 tools, single Page, no tests.        |

**If you only need ads, use Meta's official server.** It is free, needs no
developer app of your own, is maintained by the vendor, and covers more ads
surface than this project ever will. The `ads` package here exists for one
reason: composing ads with Pages, moderation and messaging under a single token
and config, with the same spend gating. That is why it is **off by default** —
ads are not the reason to install this.

The reason to install this is the Pages side: multi-Page, video and Reels upload,
scheduled-post lifecycle, insights that tell you when a metric was renamed or
retired, and comment/message moderation — in a typed, tested, MIT-licensed
server that runs entirely on your machine.

## Known limitations

Current, factual, and deliberately unflattering:

- **No live Graph API verification.** Nothing here has been proven against Meta's
  servers. Fixtures encode what the API is documented to do; reality gets a vote.
- **Published, but brand new.** 0.7.0 is on npm with provenance, the `.mcpb`
  bundle is attached to the release and the MCP Registry listing is active — but
  no install path has been walked end-to-end by anyone except CI. See
  [Client compatibility](#client-compatibility) for what that means per client.
- **Clients that cannot prompt need an operator token.** `irreversible` and
  `spend` writes need a per-call `apply` plus a `plan_id` _and_ an out-of-band
  confirmation the model cannot supply itself. Where the client advertises the
  MCP `elicitation` capability, the server asks the human operator through it;
  where it does not, the caller must pass the `FB_CONFIRM_TOKEN` value as the
  tool's `confirm_token` argument. With neither route, those tools return
  `confirmation_denied`.
- **Upload progress depends on the client asking for it.** Chunked video and
  Reel uploads emit `notifications/progress` per chunk — but only when the caller
  supplies a `progressToken` on the request, as the MCP spec requires. A client
  that does not send one gets no frames, and a long upload just looks slow.
- **Insights metrics move under you.** Meta retired and renamed a large batch of
  Page/post metrics across three waves (2024-09, 2025-11 and 2026-06-15). The
  insights tools classify a requested metric and tell you when one is renamed or
  gone instead of silently returning nothing — but the underlying data loss is
  Meta's, and no wrapper can undo it.
- **Messaging is bound by Meta's 24-hour window.** A conversation that has gone
  quiet for more than 24 hours cannot be replied to without a message tag, and
  this server does not paper over that.
- **Single maintainer, pre-1.0.** Interfaces may change without a deprecation
  period until 1.0.

## Not in scope

Things people reasonably expect from a "Facebook MCP server" that this one does
**not** do. Listed so you can rule it out in thirty seconds instead of after an
install:

- **Personal profiles and Groups.** Publishing to a personal timeline has no
  API, and the Groups API was discontinued in April 2024. This server operates
  **Pages** — nothing else.
- **Instagram, Threads, WhatsApp.** Different products, different permission
  sets. Possible sibling servers one day; not this one.
- **Webhooks / real-time ingestion.** A local stdio server has no public URL to
  receive callbacks on. Reads are polled, by design.
- **Boosting an organic post** (`/{page-id}/promotions`). The organic→ads bridge
  is the most-requested crossover feature and is deliberately parked post-1.0 —
  it needs the ads package plus spend gating that has been thought through, not
  bolted on.
- **Page Stories.** The publishing endpoints exist but are unverified; Stories
  are not promised for 1.0 and stay out until a live run proves them.
- **Events, Live video, album/photo-library reads, Page profile editing,
  organic post targeting.** Real endpoints, outside the post / video / Reels /
  scheduling / moderation surface this server commits to.
- **Multi-tenant or hosted operation, serving other businesses' ad accounts.**
  The design targets one operator, Standard Access, own assets, own machine.
  Anything else needs App Review and Business Verification, which is a different
  product.

The full reasoning is in
[`docs/analysis/01-goals-and-scope.md`](docs/analysis/01-goals-and-scope.md).

## Your responsibilities as the operator

This server automates actions Meta attributes to **you**, under your app and
your token. Automating them does not exempt you from the rules that govern them:

- **Meta's [Platform Terms](https://developers.facebook.com/terms/) and
  [Developer Policies](https://developers.facebook.com/devpolicy/) still apply** —
  including the anti-spam and automated-behaviour rules. Bulk or repetitive
  posting, commenting, or messaging can get a Page restricted or an app disabled,
  and the fact that a model chose the timing is not a defence.
- **Messenger automation must be disclosed.** Meta expects users to know when
  they are talking to an automated system. If you wire the messaging tools to
  answer people, tell them.
- **Content and consent are yours.** The tools will publish whatever you point
  them at; deciding that you have the rights to it — and, for private replies
  and DMs, that the contact is expected — is not something a wrapper can do.
- **This is not legal advice.** It is the honest note that a capable automation
  tool comes with obligations, and this project would rather say so up front.

The security-side counterpart is in
[`SECURITY.md`](SECURITY.md#out-of-scope-for-the-threat-model).

## Roadmap

Work is tracked publicly on the
[**facebook-mcp roadmap** board](https://github.com/users/IvanBBaev/projects/3)
and grouped into release milestones:

| Milestone                                                                               | Scope                                                             |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [v0.1.0](https://github.com/IvanBBaev/facebook-mcp/milestone/1) — Core                  | Foundation + `core` tools, live smoke harness                     |
| [v0.2.0](https://github.com/IvanBBaev/facebook-mcp/milestone/2) — Reader & publishing   | Post/Reels reads, publishing, scheduling, photo/video/Reels media |
| [v0.3.0](https://github.com/IvanBBaev/facebook-mcp/milestone/3) — Insights & moderation | Page/post insights, comment moderation, blocking                  |
| [v0.4.0](https://github.com/IvanBBaev/facebook-mcp/milestone/4) — Messaging             | Conversations and message sending                                 |
| [v1.0.0](https://github.com/IvanBBaev/facebook-mcp/milestone/6) — Stable                | Live verification, metadata SSOT, release rail, npm publish       |
| [v1.1.0](https://github.com/IvanBBaev/facebook-mcp/milestone/5) — Ads                   | Ads read + control, opt-in and off by default                     |

**v1.0.0 ships without the ads package** — deliberately. The Pages surface is
the product; ads is opt-in, off by default, and lands in 1.1.0. The code for it
is already in the working tree, which is exactly why the milestone is about
_verification_, not implementation: milestones close when a surface has been
**verified live** against Meta's servers and released, not when the code lands.
The binding version map is
[`docs/analysis/10-v1-release-definition.md`](docs/analysis/10-v1-release-definition.md).

The design behind each item is written up in advance in
[`docs/analysis/`](docs/analysis/README.md) — the roadmap is a consequence of
that corpus, not a replacement for it.

## Security notes

- **Three-host fence.** Only `graph.facebook.com`, `graph-video.facebook.com`
  and `rupload.facebook.com` are ever contacted — the allowlist is fixed in code
  and not user-configurable, so a redirected or mistyped host cannot silently
  receive a token.
- **Plan-and-apply write gating.** Writes default to `plan` (a non-mutating
  preview); `apply` executes. The exception is `moderation`, which defaults to
  `apply` because hiding a comment is high-volume, reversible work — and
  `FB_WRITE_MODE` overrides any package default outright, in either direction, so
  the mode is an operator decision rather than a per-tool promise. What the mode
  cannot touch: irreversible and spend actions always require an out-of-band
  confirmation, and anything that reaches a live audience (publishing a post or a
  Reel, publishing a scheduled post early, sending a DM) additionally requires a
  `plan_id` bound to a preview of that exact call. No env flag bypasses either.
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
- **Runbooks** — operational procedures in [`docs/runbooks/`](docs/runbooks/).
- **Documentation site** — [ivanbbaev.github.io/facebook-mcp](https://ivanbbaev.github.io/facebook-mcp/).

The environment table, the package/tool tables and the permission tables above
are generated from the code by `npm run metadata`; CI fails if they drift.

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
- **[Donatree](https://donatr.ee/ivanbbaev/)** — every donation method on one
  page, including local payment options.

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?style=flat-square&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/IvanBBaev)
[![Support on Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?style=flat-square&logo=kofi&logoColor=white)](https://ko-fi.com/ivanbbaev)
[![Donate via Donatree](https://img.shields.io/badge/Donatree-Donate-34d399?style=flat-square&logo=liberapay&logoColor=white)](https://donatr.ee/ivanbbaev/)

Donating buys no priority support and no SLA — see [SUPPORT.md](SUPPORT.md). If
money is not an option, starring the repository or filing a good bug report
helps just as much.

## Trademark

This is an independent, community-built project and is not affiliated with,
endorsed by, or sponsored by Meta Platforms, Inc. Facebook, Meta and related
marks are trademarks of Meta Platforms, Inc., used here only nominatively to
indicate compatibility.

## License

[MIT](LICENSE) © 2026 Ivan Baev
