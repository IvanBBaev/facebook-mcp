# facebook-mcp — an MCP server for Facebook Pages

| [![CI](https://img.shields.io/github/actions/workflow/status/IvanBBaev/facebook-mcp/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/IvanBBaev/facebook-mcp/actions/workflows/ci.yml) | [![CodeQL](https://img.shields.io/github/actions/workflow/status/IvanBBaev/facebook-mcp/codeql.yml?branch=main&style=flat-square&logo=github&label=CodeQL)](https://github.com/IvanBBaev/facebook-mcp/actions/workflows/codeql.yml) |             [![License: MIT](https://img.shields.io/github/license/IvanBBaev/facebook-mcp?style=flat-square&color=blue&label=license)](LICENSE)             |              [![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)              | [![MCP](https://img.shields.io/badge/MCP-server-orange?style=flat-square)](https://modelcontextprotocol.io) |
| :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :---------------------------------------------------------------------------------------------------------------------------------------------------------: | :-----------------------------------------------------------------------------------------------------------------------------------------------------------: | :---------------------------------------------------------------------------------------------------------: |
|                                                                        [![status](https://img.shields.io/badge/status-pre--1.0-yellow?style=flat-square)](#status)                                                                         |              [![last commit](https://img.shields.io/github/last-commit/IvanBBaev/facebook-mcp?style=flat-square&logo=git&logoColor=white&label=last%20commit)](https://github.com/IvanBBaev/facebook-mcp/commits/main)              | [![docs](https://img.shields.io/badge/docs-github.io-1877F2?style=flat-square&logo=readthedocs&logoColor=white)](https://ivanbbaev.github.io/facebook-mcp/) | [![Sponsor](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?style=flat-square&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/IvanBBaev) |                                                                                                             |

📖 **[Documentation site →](https://ivanbbaev.github.io/facebook-mcp/)**

A local-first, MIT-licensed TypeScript
[Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for
**developers who run their own Facebook Page(s)** from an MCP client such as
Claude Code, Claude Desktop, VS Code or Cursor. It talks to the **Meta Graph
API** through your own Meta developer app and your own token: publishing,
reading and insights, comment moderation and Messenger replies. Writes return a
preview first by default (plan-and-apply), and the server sends no telemetry.

Things you could ask your agent once it is set up (the tools exist; see
[Status](#status) for what has been verified):

- _"Draft a post with this photo and schedule it for Friday 9:00 — show me the
  preview first."_
- _"Triage the unanswered comments on last week's posts."_
- _"Give me this week's Page report."_

**Not for you if** you do not want to create a Meta developer app and handle an
App ID, an App Secret and a token yourself — hosted social-media connectors
with a one-click login are a better fit for that. It is also not for personal
profiles, Groups, Instagram (there is a [sibling server](#c-instagram-alongside-the-sibling-server))
or a hosted service for other people's Pages — see [Not in scope](#not-in-scope).

## Status

> 🚧 **Pre-1.0, and not yet verified against a live Page.** The latest release is
> [`@ivanbaev/facebook-mcp`](https://www.npmjs.com/package/@ivanbaev/facebook-mcp)
> 0.8.0 on npm. This README describes `main`, which can be ahead of that release;
> unreleased changes are listed in [`changes/unreleased/`](changes/unreleased/).

- **Implemented, not live-verified.** All 69 tools in the [tool table](#tools)
  are implemented. Every test in this repository runs against fakes and recorded
  fixtures behind a network fence that throws on a real `fetch`, so "the tests
  pass" means "the code does what the fixtures say", not "Meta accepted it". A
  live smoke harness exists ([`scripts/smoke/`](scripts/smoke/README.md)) but has
  not been run against a real Page for any release.
- **No client verified by hand.** CI starts the packed server with `npx` on
  Linux, macOS and Windows, but no person has walked an install end-to-end in
  any MCP client yet — see [Client compatibility](#client-compatibility).
- **Experimental tools.** Some tools are marked experimental (list under
  [Not in scope](#not-in-scope)): they may change in any minor release, even
  after 1.0.
- **Breaking changes are planned.** 0.9 changes tool contracts (see
  [Roadmap](#roadmap)). Read [Known limitations](#known-limitations) before you
  rely on anything.

**Contents:** [Status](#status) · [Features](#features) ·
[Requirements](#requirements) · [Setup](#setup) ·
[Client compatibility](#client-compatibility) ·
[Configure credentials](#configure-credentials) ·
[Permissions](#permissions-you-need-to-grant) · [Tools](#tools) ·
[How this compares](#how-this-compares) ·
[Known limitations](#known-limitations) · [Not in scope](#not-in-scope) ·
[Your responsibilities](#your-responsibilities-as-the-operator) ·
[Roadmap](#roadmap) · [Security notes](#security-notes) ·
[Documentation](#documentation) · [Support](#support) ·
[Trademark](#trademark) · [License](#license)

## Features

Implementation status only — see [Status](#status) for what "implemented" does
and does not mean. "Experimental" follows the
[experimental tier](#shipped-but-experimental).

| Area                      | Capability                                                                                                                                           | Status                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Core & diagnostics**    | Identity, Page listing, rate-limit usage, `doctor` pre-flight check, `setup-token`                                                                   | ✅ Implemented, not live-verified                     |
| **Reading**               | Page and post reads, Reels, reactions, Stories, albums and photos, cursor pagination                                                                 | ✅ Implemented, not live-verified                     |
| **Publishing**            | Text / link / photo / video / Reels posts, Stories, scheduling, edit and delete                                                                      | ✅ Implemented, not live-verified                     |
| **Insights**              | Page, post and Reel insights, a one-call Page report, a posts comparison table, metric-rename and retirement guidance                                | ✅ Implemented, not live-verified                     |
| **Moderation**            | Comment reads and triage, replies, comment edits, hide, like, delete, private reply, block/unblock, moderation settings                              | ✅ Implemented, not live-verified                     |
| **Messaging**             | Conversation reads, "what is new since", replies within the 24-hour window, saved replies; message reactions, attachments and labels                 | ✅ Implemented, not live-verified (some experimental) |
| **Ads** (opt-in)          | Campaign / ad-set / ad reads, previews, insights, status, budget and spend-cap control; archive/delete, image upload, targeting edits, copies, boost | ✅ Implemented, not live-verified (some experimental) |
| **Page profile** (opt-in) | Edit the Page's about, description, website, phone, hours, temporary status                                                                          | ✅ Implemented, not live-verified, experimental       |
| **Live verification**     | Every tool exercised against a real Page and a real ad account                                                                                       | ❌ Not done — see [Status](#status)                   |
| **npm / MCPB release**    | `npx @ivanbaev/facebook-mcp`, attested `.mcpb` bundle, MCP Registry listing                                                                          | ✅ Published — 0.8.0                                  |

Each tool wraps one capability rather than mirroring every Graph edge. Six
packages (53 tools) are on by default; `ads` and `page_admin` are opt-in.

- **Local-first, no telemetry.** Only three Meta hosts are ever reached
  (`graph`, `graph-video`, `rupload`); nothing phones home.
- **Least-privilege credentials.** Works with a never-expiring System User token
  (Business Manager) or a long-lived Page token — no App Review required for an
  admin operating their own assets.
- **Safe writes.** Tiered plan-and-apply gating; irreversible and spend actions
  require out-of-band confirmation and are never unlocked by an env flag alone.
- **Secret hygiene.** Value-based redaction of secrets at a single choke-point
  across logs, errors, tool results, and the write journal.
- **Layered architecture.** Lint-enforced `core ← api ← mcp ← tools ← cli ← server` layering,
  tools-as-data with a central package registry.

## Requirements

- Node.js **≥ 22** (enforced by `engines` and a runtime guard in the launcher;
  the project targets the version in `.nvmrc`).
- A Meta (Facebook) developer app — a **Business**-type app at Standard Access is
  enough; no App Review is needed to operate your own assets.
- A Facebook **Page** (and, for the opt-in `ads` package, an **ad account**) you
  administer.

## Setup

The first run is five steps, in this order. Most of the time goes into Meta's
app UI. [docs/runbooks/onboarding.md](docs/runbooks/onboarding.md) is
the long form with troubleshooting.

1. **Meta app** — create a **Business**-type app at
   <https://developers.facebook.com/apps> and note its **App ID** and **App
   Secret** (Settings → Basic). `setup-token` needs both.
2. **Short-lived token** — in the
   [Graph API Explorer](https://developers.facebook.com/tools/explorer/) pick
   your app, **User Token**, tick the [scopes](#permissions-you-need-to-grant)
   you need (at least `pages_show_list` and `pages_read_engagement`), and
   **Generate Access Token**. It lives 1–2 hours, so do step 3 right away.
3. **Exchange it and write the env file** — `setup-token` swaps it for a
   ~60-day token, resolves your Page and writes the env file:

   ```bash
   FB_APP_ID='<app id>' FB_APP_SECRET='<app secret>' \
   FB_SETUP_TOKEN='<explorer token>' \
     npx -y @ivanbaev/facebook-mcp setup-token
   ```

   Success is `status: completed` in the **Run** block and `status: written`
   in the **Env file** block. The file lands at
   `~/.config/facebook-mcp/.env` (`$XDG_CONFIG_HOME` if set) or
   `%APPDATA%\facebook-mcp\.env` on Windows, mode `0600`. The server reads it
   on every start, so the client config below needs **no** `env` block. More
   than one Page? Re-run with `--page=<id> --force`.

4. **Pre-flight** — every package you plan to use should be `usable`:

   ```bash
   npx -y @ivanbaev/facebook-mcp doctor
   ```

5. **Register the server with your client and make the first call** — see the
   next two subsections, then ask the client to _"run facebook_whoami"_. A
   reply naming your token type and Page is the first successful tool call.

The `doctor` and `setup-token` reports name commands in the form you launched
with (`npx -y @ivanbaev/facebook-mcp …`, `facebook-mcp …` after a global
install, or `node build/index.js …` from a source checkout). `--help` writes
`facebook-mcp …`; substitute your launch form. Every subcommand takes `--help`
without touching the network.

### (a) Via npx

**Claude Code** — one command, then check `/mcp` inside a session:

```bash
claude mcp add facebook -- npx -y @ivanbaev/facebook-mcp
```

It is registered for the current project directory by default; add
`--scope user` to have it everywhere. Or install it as a plugin, which wires up
the same command:

```bash
/plugin marketplace add IvanBBaev/facebook-mcp
/plugin install facebook-mcp
```

The plugin route has not been walked end-to-end yet. The marketplace reads the
plugin from this repository's `main` branch, and the plugin starts
`npx -y @ivanbaev/facebook-mcp` without a version pin, so it runs whatever
release is `latest` on npm.

**Claude Desktop** — Settings → Developer → **Edit Config** opens
`claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`). Add the
server, save, then **quit and restart** Claude Desktop:

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

Claude Desktop does not load your shell profile. If Node comes from a version
manager (nvm, fnm, asdf) and the server fails to start, put the absolute path of
`npx` (`which npx`) in `command`.

Any other stdio client takes the same `command` / `args` pair — see
[Client compatibility](#client-compatibility).

**Claude Desktop bundle (alternative)** — the `.mcpb` attached to the
[latest release](https://github.com/IvanBBaev/facebook-mcp/releases/latest)
installs by double-click. Its settings form lists every credential as optional:
leave them blank to use the env file from step 3 (a blank field never overrides
it). It carries a build-provenance attestation, so you can prove it came out of
this repository's workflow before you install it:

```bash
gh attestation verify facebook-mcp-0.8.0.mcpb --repo IvanBBaev/facebook-mcp
```

### (b) From source

For development, or to run a commit that is not released yet:

```bash
git clone https://github.com/IvanBBaev/facebook-mcp.git
cd facebook-mcp
npm install
npm run build
node build/index.js setup-token   # with the same FB_* variables as step 3
node build/index.js doctor        # pre-flight: token, scopes, package matrix
node build/index.js               # or: ./bin/facebook-mcp.mjs
```

Point your MCP client at that command with an absolute path. The `env` block is
optional — without it the server reads the env file, and a non-blank value here
overrides the file:

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

### (c) Instagram alongside: the sibling server

This server stays Pages-only. Instagram professional accounts are covered by the
separate [`instagram-mcp-ai`](https://github.com/IvanBBaev/instagram-mcp)
server (publishing, media, comments, insights, DMs). Run both side by side;
each keeps its own credentials and env file
(`~/.config/instagram-mcp-ai/.env` for Instagram, set up with
`npx instagram-mcp-ai login`), so neither config below needs an `env` block.

**Claude Code:**

```bash
claude mcp add facebook -- npx -y @ivanbaev/facebook-mcp
claude mcp add instagram -- npx -y instagram-mcp-ai
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "facebook": {
      "command": "npx",
      "args": ["-y", "@ivanbaev/facebook-mcp"]
    },
    "instagram": {
      "command": "npx",
      "args": ["-y", "instagram-mcp-ai"]
    }
  }
}
```

The two servers share nothing at runtime: a post to a Page and a post to
Instagram are two tool calls, each with its own preview. Tool names do not
collide (`facebook_*` here).

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
- **`npx` cold start** — CI packs each commit, starts it with `npx -y` from an
  empty directory on Linux, macOS and Windows, and requires `initialize` and a
  non-empty `tools/list`.

None of that involves an MCP client or the Meta API. If you get it working with
a client, [say so in an issue](https://github.com/IvanBBaev/facebook-mcp/issues) —
that is how this table turns into ✅.

### Platform notes

CI runs the full check on Linux (Node 22/24/26) and Windows (Node 22). macOS is
the primary development platform; in CI it runs only the `npx` cold-start job
(pack, start, `initialize` and `tools/list`), which also runs on Linux and
Windows. Paths for the env file, the
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
  fallback. It belongs to exactly one Page, so set `FB_PAGE_ID` to that Page
  alongside it (`doctor` / `facebook_whoami` reports it as the acting Page).

Grant only the permissions the packages you enable actually need
([full list below](#permissions-you-need-to-grant)), and set **`FB_APP_SECRET`**
so `appsecret_proof` is attached to every call — that makes a stolen bare token
unusable on its own. Settings are read from an env file at the XDG/`%APPDATA%`
config path, or from real environment variables (which take precedence).

If you would rather not assemble the env file by hand, run
`npx -y @ivanbaev/facebook-mcp setup-token` (`node build/index.js setup-token`
from source) — the guided flow exchanges and classifies a
token and writes the env file for you (`--page=<id>`, `--env-file=<path>`,
`--force` to overwrite, `--no-write`/`--dry-run` to rehearse; pass the token via
`FB_SETUP_TOKEN` rather than on the command line; the exchange also needs
`FB_APP_ID` and `FB_APP_SECRET`). See
[docs/runbooks/onboarding.md](docs/runbooks/onboarding.md) for the full walkthrough.

Then run `doctor` (`npx -y @ivanbaev/facebook-mcp doctor`) before anything else: it inspects the
token, reports type, expiry and granted scopes, and prints a per-package
usable / partial / blocked matrix so you find a missing permission before a tool
call does. It ends with a one-line verdict over everything it found.

The doctor is a report, so it exits 0 whatever it finds — a wrapper that runs it
for the text keeps working. Add `--strict` to make it a gate instead:

| Verdict   | With `--strict` | Means                                                                                                                                                       |
| --------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OK`      | exit 0          | Nothing needs attention.                                                                                                                                    |
| `WARN`    | exit 1          | The server will run, but something is degraded (partial scopes, a token about to expire, a world-readable env file, a metric name Graph no longer accepts). |
| `UNKNOWN` | exit 1          | A check could not be completed — typically `debug_token` was unreachable, so the credential is unverified rather than bad.                                  |
| `FAIL`    | exit 2          | This configuration cannot serve requests: no token, a token Graph rejects, revoked asset access, or no usable package.                                      |

`UNKNOWN` outranks `WARN` on purpose: "nothing was established" must not hide
behind "degraded". A platform without POSIX permission bits raises no finding for
the credential file — there is no `chmod` to recommend there, and a warning
nothing can clear would make `--strict` permanently red on Windows.

`node build/index.js --version` (or `-v`) prints the server, Node and MCP SDK
versions on one line and exits — it needs no credential, so it still answers on
an install that cannot start:

```text
facebook-mcp 0.8.0 (node v22.23.0, darwin arm64, sdk 1.32.1)
```

The bare server version is always the second field, so `--version | awk '{print
$2}'` keeps working. The same three versions plus the pinned Graph API version
are reported by `facebook_whoami` in its `server` object (`name`, `version`,
`apiVersion`, `sdkVersion`). `--help` (or `-h`) prints the command summary and
a first-run recipe to stdout and exits 0, again without reading any credential;
`setup-token --help` and `doctor --help` do the same instead of running. `doctor`, `setup-token`,
`--version` and `--help` are the only arguments that exit on their own; **anything
else starts the stdio server** and waits on JSON-RPC. An argument `doctor` does not
recognise (say `--stric`) never gates, but the report names it — option names
only, never a value — so a mistyped `--strict` in CI is visible.

### Environment variables

Provide at least one token; everything else is optional tuning. Variables marked
**Secret** are never logged or returned by a tool.

<!-- BEGIN GENERATED: env -->

| Variable                        | Required |                 Default                  | Description                                                                                                                                                                       |
| ------------------------------- | :------: | :--------------------------------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FB_SYSTEM_TOKEN`               | one of¹  |                    —                     | **Secret.** System User token (Business Manager). Recommended; wins over the other two.                                                                                           |
| `FB_ACCESS_TOKEN`               | one of¹  |                    —                     | **Secret.** Meta user access token (a long-lived one preferred).                                                                                                                  |
| `FB_PAGE_TOKEN`                 | one of¹  |                    —                     | **Secret.** Long-lived Page token — the no-Business-Manager fallback. Belongs to exactly one Page: set `FB_PAGE_ID` to that Page alongside it, or no Page-scoped tool can use it. |
| `FB_APP_ID`                     |    no    |                    —                     | Meta app ID. With `FB_APP_SECRET` it forms the app token used to inspect tokens.                                                                                                  |
| `FB_APP_SECRET`                 |    no    |                    —                     | **Secret.** When set, `appsecret_proof` is attached so a stolen bare token is unusable.                                                                                           |
| `FB_PAGE_ID`                    |    no    |                    —                     | Default Page ID for Page-scoped tools when a call omits `profile`. Required when `FB_PAGE_TOKEN` is the only credential (it names the Page the token belongs to).                 |
| `FB_API_VERSION`                |    no    |                 `v26.0`                  | Graph API version to pin. Off-default values are accepted, but only the default is tested.                                                                                        |
| `FB_ADS_API_VERSION`            |    no    |                 `v26.0`                  | Marketing API version for the ads tools (own lifecycle, separate from FB_API_VERSION). Off-default values are accepted, but only the default is tested.                           |
| `FB_REQUEST_TIMEOUT_MS`         |    no    |                 `60000`                  | Per-request timeout in milliseconds (1–600000).                                                                                                                                   |
| `FB_HOST_CONCURRENCY`           |    no    |                   `4`                    | Max parallel requests per Graph host (1–64).                                                                                                                                      |
| `FB_MAX_RESULT_CHARS`           |    no    |                 `25000`                  | Character budget before a tool result is truncated (500–10000000).                                                                                                                |
| `FB_WRITE_MODE`                 |    no    |                  `plan`                  | `plan` (default) previews a write without mutating; `apply` executes. Never covers the irreversible/spend tiers.                                                                  |
| `FB_CONFIRM_TOKEN`              |    no    |                    —                     | **Secret.** Out-of-band confirmation token authorizing gated write / spend actions, for clients that cannot prompt. At least 16 characters.                                       |
| `FB_MEDIA_DIR`                  |    no    |                    —                     | Directory permitted as a source for local media uploads. Unset ⇒ URL-only, local file access disabled.                                                                            |
| `FB_JOURNAL_PATH`               |    no    |        XDG / %APPDATA% state path        | Path to the append-only, rotating write journal (0600).                                                                                                                           |
| `FB_ACTIVITY_STATE_PATH`        |    no    |        XDG / %APPDATA% state path        | Path to the local high-water marks of facebook_get_activity_since (0600).                                                                                                         |
| `FB_EXPORT_DIR`                 |    no    |        XDG / %APPDATA% state path        | Directory for insights file exports (`output` argument; 0700 dir, 0600 files).                                                                                                    |
| `FB_TOOL_PACKAGES`              |    no    | core profile (all packages except `ads`) | Comma-separated packages or profiles to enable. `core` is always forced on; `ads` is opt-in.                                                                                      |
| `FB_PACKAGES_DENY`              |    no    |                    —                     | Packages or profiles to exclude even if `FB_TOOL_PACKAGES` enables them; the `core` package always survives.                                                                      |
| `FB_PACKAGES_READONLY`          |    no    |                    —                     | Packages or profiles whose write tools are not registered; their read tools stay.                                                                                                 |
| `FB_TRANSPORT`                  |    no    |                 `stdio`                  | `stdio` (default) or `http` (loopback-only Streamable HTTP for local agent clients).                                                                                              |
| `FB_HTTP_TOKEN`                 | if http  |                    —                     | **Secret.** Bearer token required by the `http` transport; it fails closed without it. At least 16 characters.                                                                    |
| `FB_HTTP_PORT`                  |    no    |                  `3000`                  | TCP port for the `http` transport (the bind host is fixed to loopback `127.0.0.1`).                                                                                               |
| `FB_AD_ACCOUNT_ID`              |    no    |                    —                     | Ad account ID for the opt-in `ads` package.                                                                                                                                       |
| `FB_ADS_BUDGET_CEILING`         |    no    |                    —                     | Hard budget ceiling for ads writes, in minor units of the ad account currency (non-negative integer, no currency conversion).                                                     |
| `FB_ADS_CAMPAIGN_SPEND_CAP_MAX` |    no    |                    —                     | Largest campaign spend cap an ads write may set, in minor units of the ad account currency (non-negative integer, no currency conversion).                                        |
| `FB_LOG_LEVEL`                  |    no    |                  `info`                  | Stderr log verbosity: `debug`, `info`, `warn`, `error`.                                                                                                                           |
| `FB_SETUP_TOKEN`                |    no    |                    —                     | **Secret.** Short-lived user token consumed once by `setup-token`; the safe alternative to passing it as a CLI argument.                                                          |
| `FB_PROFILE_<NAME>_PAGE_ID`     |    no    |                    —                     | Page ID for a named profile, e.g. FB_PROFILE_BRAND_A_PAGE_ID.                                                                                                                     |
| `FB_PROFILE_<NAME>_TOKEN`       |    no    |                    —                     | **Secret.** Optional per-profile token override for the matching FB_PROFILE_<NAME>_PAGE_ID.                                                                                       |

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

| Package      | Required Graph permissions                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `core`       | `pages_show_list`<br>`pages_read_engagement`                                                                                      |
| `reader`     | `pages_read_engagement`<br>`pages_read_user_content`<br>`pages_show_list`                                                         |
| `posts`      | `pages_manage_posts`<br>`pages_read_engagement`                                                                                   |
| `insights`   | `read_insights`<br>`pages_read_engagement`                                                                                        |
| `moderation` | `pages_read_engagement`<br>`pages_read_user_content`<br>`pages_manage_engagement`<br>`pages_messaging`<br>`pages_manage_metadata` |
| `messages`   | `pages_messaging`<br>`pages_manage_metadata`<br>`pages_read_engagement`<br>`pages_read_user_content`                              |
| `ads`        | `ads_read`<br>`ads_management`<br>`pages_read_engagement`                                                                         |
| `page_admin` | `pages_manage_metadata`<br>`pages_read_engagement`                                                                                |

<details>
<summary>Per-tool scopes (a tool marked <em>inherited</em> has no finer mapping and falls back to its package set)</summary>

| Tool                                 | Required Graph permissions                                            |
| ------------------------------------ | --------------------------------------------------------------------- |
| `facebook_whoami`                    | _(none — the token itself is enough)_                                 |
| `facebook_list_pages`                | `pages_show_list`                                                     |
| `facebook_get_page`                  | `pages_read_engagement`                                               |
| `facebook_usage`                     | _(none — the token itself is enough)_                                 |
| `facebook_list_posts`                | `pages_read_engagement`                                               |
| `facebook_get_post`                  | `pages_read_engagement`                                               |
| `facebook_list_reels`                | `pages_read_engagement`                                               |
| `facebook_get_reactions`             | `pages_read_engagement`                                               |
| `facebook_list_stories`              | `pages_read_engagement`, `pages_show_list`                            |
| `facebook_list_albums`               | `pages_read_engagement`                                               |
| `facebook_list_photos`               | `pages_read_engagement`, `pages_show_list`                            |
| `facebook_create_post`               | `pages_manage_posts`                                                  |
| `facebook_create_photo_post`         | `pages_manage_posts`                                                  |
| `facebook_create_video_post`         | `pages_manage_posts`                                                  |
| `facebook_create_reel`               | `pages_manage_posts`                                                  |
| `facebook_create_story`              | `pages_manage_posts`                                                  |
| `facebook_update_post`               | `pages_manage_posts`                                                  |
| `facebook_delete_post`               | `pages_manage_posts`                                                  |
| `facebook_list_scheduled_posts`      | `pages_read_engagement`                                               |
| `facebook_get_video_status`          | `pages_read_engagement`                                               |
| `facebook_page_insights`             | `read_insights`                                                       |
| `facebook_post_insights`             | `read_insights`                                                       |
| `facebook_reel_insights`             | `read_insights`                                                       |
| `facebook_get_page_report`           | `read_insights`, `pages_read_engagement`                              |
| `facebook_get_posts_insights`        | `read_insights`, `pages_read_engagement`                              |
| `facebook_list_comments`             | `pages_read_engagement`, `pages_read_user_content`                    |
| `facebook_get_comment`               | `pages_read_engagement`, `pages_read_user_content`                    |
| `facebook_triage_comments`           | `pages_read_engagement`, `pages_read_user_content`                    |
| `facebook_reply_to_comment`          | `pages_manage_engagement`                                             |
| `facebook_comment_on_post`           | `pages_manage_engagement`                                             |
| `facebook_edit_comment`              | `pages_manage_engagement`                                             |
| `facebook_hide_comment`              | `pages_manage_engagement`                                             |
| `facebook_reply_and_hide_comment`    | `pages_manage_engagement`, `pages_read_engagement`                    |
| `facebook_like_comment`              | `pages_manage_engagement`                                             |
| `facebook_delete_comment`            | `pages_manage_engagement`, `pages_read_user_content`                  |
| `facebook_private_reply`             | `pages_messaging`, `pages_read_engagement`, `pages_read_user_content` |
| `facebook_block_user`                | `pages_manage_engagement`                                             |
| `facebook_unblock_user`              | `pages_manage_engagement`                                             |
| `facebook_get_moderation_settings`   | `pages_manage_metadata`                                               |
| `facebook_set_moderation_settings`   | `pages_manage_metadata`                                               |
| `facebook_list_conversations`        | `pages_messaging`, `pages_manage_metadata`                            |
| `facebook_get_conversation`          | `pages_messaging`, `pages_manage_metadata`                            |
| `facebook_send_message`              | `pages_messaging`                                                     |
| `facebook_react_to_message`          | `pages_messaging`                                                     |
| `facebook_upload_message_attachment` | `pages_messaging`                                                     |
| `facebook_get_activity_since`        | `pages_read_engagement`, `pages_read_user_content`, `pages_messaging` |
| `facebook_list_saved_replies`        | _(none — the token itself is enough)_                                 |
| `facebook_save_reply`                | _(none — the token itself is enough)_                                 |
| `facebook_delete_saved_reply`        | _(none — the token itself is enough)_                                 |
| `facebook_list_labels`               | `pages_manage_metadata`                                               |
| `facebook_create_label`              | `pages_manage_metadata`                                               |
| `facebook_assign_label`              | `pages_manage_metadata`                                               |
| `facebook_delete_label`              | `pages_manage_metadata`                                               |
| `facebook_list_campaigns`            | `ads_read`                                                            |
| `facebook_list_adsets`               | `ads_read`                                                            |
| `facebook_list_ads`                  | `ads_read`                                                            |
| `facebook_get_ad_object`             | `ads_read`                                                            |
| `facebook_get_ad_preview`            | `ads_read`                                                            |
| `facebook_ads_insights`              | `ads_read`                                                            |
| `facebook_ads_report_status`         | `ads_read`                                                            |
| `facebook_update_ad_object`          | `ads_management`                                                      |
| `facebook_archive_ad_object`         | `ads_management`                                                      |
| `facebook_delete_ad_object`          | `ads_management`                                                      |
| `facebook_upload_ad_image`           | `ads_management`                                                      |
| `facebook_get_ad_set_targeting`      | `ads_read`                                                            |
| `facebook_update_ad_set_targeting`   | `ads_management`                                                      |
| `facebook_duplicate_ad_object`       | `ads_management`                                                      |
| `facebook_boost_post`                | `ads_management`, `pages_read_engagement`                             |
| `facebook_update_page_profile`       | `pages_manage_metadata`, `pages_read_engagement`                      |

</details>

<!-- END GENERATED -->

## Tools

Packages are the unit of exposure: you enable and disable whole packages with
`FB_TOOL_PACKAGES`, and `FB_PACKAGES_READONLY` drops a package's write tools
while keeping its reads.

All three package variables share one namespace of packages **and** profiles
(`core`, `all`, `reader`, `publisher`, `moderator`, `ads`), and a profile name
wins over a same-spelled package. That matters most in `FB_PACKAGES_DENY`:
`FB_PACKAGES_DENY=core` denies the six-package **core profile**, not the single
`core` package — and the `core` package is then forced back on anyway, since its
identity and rate-limit tools are how you diagnose the surface you just narrowed.
A name none of them recognize fails at startup rather than being ignored.

<!-- BEGIN GENERATED: packages -->

| Package      |  On by default  | Tools             | Default write mode | What it covers                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------ | :-------------: | ----------------- | :----------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`       |       yes       | 4 read            |         —          | Always-on identity, Page discovery and rate-limit diagnostics (read-only).                                                                                                                                                                                                                                                                                                                                             |
| `reader`     |       yes       | 7 read            |         —          | Read-only access to a Page's own content: posts (four edges), single posts, Reels, reaction totals, Stories, albums and photos.                                                                                                                                                                                                                                                                                        |
| `posts`      |       yes       | 2 read + 7 write  |       `plan`       | Publish, schedule, edit and delete Page posts, photos, videos, Reels and stories (plan-first: every write previews before it applies).                                                                                                                                                                                                                                                                                 |
| `insights`   |       yes       | 5 read            |         —          | Page, post and Reel insights: compact reshaped metric series, semantics-aware summaries, a one-call Page report, a posts comparison table and post-2025 metric-rename guidance (read-only).                                                                                                                                                                                                                            |
| `moderation` |       yes       | 4 read + 11 write |      `apply`       | Read and moderate comments on Page content (list, reply, comment on a post, edit the Page's own comments, hide, like, delete, private reply) and maintain the blocked-users list and the Page moderation settings (blocked words, profanity filter).                                                                                                                                                                   |
| `messages`   |       yes       | 5 read + 8 write  |       `plan`       | Messenger conversations for a Page: poll the inbox, read a thread (untrusted content wrapped, attachments as placeholders) and send one private reply inside the 24-hour window, or react to a message; or ask what is new since the last look; keep local saved replies to send verbatim; tag threads with custom labels. Plan-first by default.                                                                      |
| `ads`        | **no** (opt-in) | 8 read + 7 write  |       `plan`       | Marketing API access: campaign / ad-set / ad listings with delivery truth, single-object reads, placement previews, insights with async report runs, plan-gated status, budget and campaign spend-cap control, single-object archive/delete, ad image uploads, ad-set targeting reads with a narrow countries/ages edit, paused copies of campaigns, ad sets and ads, and paused boosts of Page posts. Off by default. |
| `page_admin` | **no** (opt-in) | 0 read + 1 write  |       `plan`       | Edit the Page itself: its public profile (about, description, website, phone, hours, temporary status). Opt-in; needs pages_manage_metadata.                                                                                                                                                                                                                                                                           |

<!-- END GENERATED -->

<!-- BEGIN GENERATED: tools -->

**69 tools in 8 packages.** 6 packages are on by default; the rest are opt-in via `FB_TOOL_PACKAGES`. Tier `read` never mutates. `reversible` writes are gated by `FB_WRITE_MODE`; `irreversible` and `spend` additionally require a per-call `apply` plus the `plan_id` of a preview you just ran, and are never unlocked by an environment variable alone.

| Package      | Tool                                 |      Tier      | Purpose                                                                                                                                                                    |
| ------------ | ------------------------------------ | :------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`       | `facebook_whoami`                    |     `read`     | Report the identity behind the configured token (type, validity, granted permissions, expiry) plus the server, MCP SDK and pinned Graph API version.                       |
| `core`       | `facebook_list_pages`                |     `read`     | List the Facebook Pages the operator administers (via /me/accounts): id, name, category, the granted tasks, and whether a Page token is available.                         |
| `core`       | `facebook_get_page`                  |     `read`     | Fetch metadata for one Page — name, category, follower/fan counts, publish state and new-Page-experience flag.                                                             |
| `core`       | `facebook_usage`                     |     `read`     | Report the most recent Graph rate-limit signals (X-App-Usage, X-Business-Use-Case-Usage, x-fb-ads-insights-throttle) as usage percentages, so you can back off before…     |
| `reader`     | `facebook_list_posts`                |     `read`     | List a Page's posts, one cursor page at a time.                                                                                                                            |
| `reader`     | `facebook_get_post`                  |     `read`     | Fetch ONE post by its composite id ("{page-id}_{post-id}" as returned by facebook_list_posts).                                                                             |
| `reader`     | `facebook_list_reels`                |     `read`     | List a Page's Reels via the /video_reels edge — the ONLY place Reels are readable.                                                                                         |
| `reader`     | `facebook_get_reactions`             |     `read`     | Read the reactions on one post: a `totals` map per reaction type (LIKE / LOVE / CARE / HAHA / WOW / SAD / ANGRY), the overall `total`, and the list of reacting users.     |
| `reader`     | `facebook_list_stories`              |     `read`     | List a Page's Stories via the /stories edge, one cursor page at a time: each item has `postId`, `status` (PUBLISHED / ARCHIVED), `createdTime` (ISO 8601), `mediaType`…    |
| `reader`     | `facebook_list_albums`               |     `read`     | List a Page's photo albums, one cursor page at a time: `id`, `name`, `description`, `type` (normal / profile / cover / …), photo `count`, `canUpload`, `coverPhotoId`…     |
| `reader`     | `facebook_list_photos`               |     `read`     | List photos, one cursor page at a time: an album's photos when `album_id` (from facebook_list_albums) is given, otherwise a Page photo listing chosen by `type`.           |
| `posts`      | `facebook_create_post`               |  `reversible`  | Create a Page post: plain text, a link, a multi-link card carousel, or a multi-photo carousel.                                                                             |
| `posts`      | `facebook_create_photo_post`         |  `reversible`  | Publish ONE photo to a Page, optionally with a caption, as a draft, or scheduled, and optionally into one of the Page albums (album_id).                                   |
| `posts`      | `facebook_create_video_post`         |  `reversible`  | Upload a video to a Page.                                                                                                                                                  |
| `posts`      | `facebook_create_reel`               |  `reversible`  | Publish a Facebook Reel through the three-phase upload (start → transfer → finish) with an explicit video_state: PUBLISHED, DRAFT or SCHEDULED.                            |
| `posts`      | `facebook_create_story`              | `irreversible` | Publish a photo or video story on the Page.                                                                                                                                |
| `posts`      | `facebook_update_post`               |  `reversible`  | Edit a Page post the app itself created, or move it through the scheduled-post lifecycle.                                                                                  |
| `posts`      | `facebook_delete_post`               | `irreversible` | Permanently delete a Page post the app itself created — including a scheduled one, which is the only way to cancel it.                                                     |
| `posts`      | `facebook_list_scheduled_posts`      |     `read`     | List the Page posts that are queued to publish later, each with its publish time echoed in UTC and in Page-local time.                                                     |
| `posts`      | `facebook_get_video_status`          |     `read`     | Poll where one video stands in Meta's pipeline: uploading, processing, ready or error.                                                                                     |
| `insights`   | `facebook_page_insights`             |     `read`     | Read Graph insights for one Page in a compact flat shape: one row per metric per data point ({metric, date, value}, plus `breakdown` for by-action-type metrics) and one…  |
| `insights`   | `facebook_post_insights`             |     `read`     | Read Graph insights for one published post (post_media_view, post_clicks, post_reactions_by_type_total, video metrics, ...) in the same compact flat shape as…             |
| `insights`   | `facebook_reel_insights`             |     `read`     | Read Graph insights for one Reel from /{video-id}/video_insights — the edge Reel metrics actually live on, which facebook_post_insights cannot reach.                      |
| `insights`   | `facebook_get_page_report`           |     `read`     | One-call Page performance report over a window (default last 28 days, [since, until) in Pacific Time) compared with the preceding window of equal length: followers…       |
| `insights`   | `facebook_get_posts_insights`        |     `read`     | Lifetime insights for several posts in one call, as a compact table: one row per post with `values` (one scalar per metric) and unaggregated `breakdowns` (e.g. reactions… |
| `moderation` | `facebook_list_comments`             |     `read`     | List the comments on a post, photo, video or another comment, newest-first by default.                                                                                     |
| `moderation` | `facebook_get_comment`               |     `read`     | Read one comment by ID, optionally with its replies, and report whether a private reply is still possible (the 7-day window).                                              |
| `moderation` | `facebook_triage_comments`           |     `read`     | A moderation queue in one call: the comments on the Page's most recent published posts, newest first, filtered by `status` (default "unanswered" — no Page reply in the…   |
| `moderation` | `facebook_reply_to_comment`          |  `reversible`  | Post a PUBLIC reply under a comment — visible to everyone who can see the thread.                                                                                          |
| `moderation` | `facebook_comment_on_post`           |  `reversible`  | Post a PUBLIC top-level comment as the Page on a post — e.g. a first comment with a link.                                                                                  |
| `moderation` | `facebook_edit_comment`              |  `reversible`  | Replace the text of a comment the Page itself wrote — e.g. fix a typo in a reply.                                                                                          |
| `moderation` | `facebook_hide_comment`              |  `reversible`  | Hide or unhide up to 50 comments in one call (`hidden:true` hides, `hidden:false` restores).                                                                               |
| `moderation` | `facebook_reply_and_hide_comment`    |  `reversible`  | Post a PUBLIC reply under a comment and then hide that comment, in one approved step — e.g. "We have sent you a DM" under spam or abuse.                                   |
| `moderation` | `facebook_like_comment`              |  `reversible`  | Like up to 50 comments as the Page, or unlike them with `unlike:true`.                                                                                                     |
| `moderation` | `facebook_delete_comment`            | `irreversible` | PERMANENTLY delete up to 50 comments.                                                                                                                                      |
| `moderation` | `facebook_private_reply`             | `irreversible` | Send a private message to the author of a comment, or of a visitor post on the Page (post_id).                                                                             |
| `moderation` | `facebook_block_user`                |  `reversible`  | Add up to 50 PSIDs to the Page's blocked list: they can no longer comment on the Page or message it.                                                                       |
| `moderation` | `facebook_unblock_user`              |  `reversible`  | Remove up to 50 PSIDs from the Page's blocked list, restoring their ability to comment and message.                                                                        |
| `moderation` | `facebook_get_moderation_settings`   |     `read`     | Read the Page's moderation settings: the blocked-word list (comments containing one are hidden automatically), the profanity filter level (OFF, MEDIUM, STRONG) and…       |
| `moderation` | `facebook_set_moderation_settings`   |  `reversible`  | Change the Page's blocked words and profanity filter.                                                                                                                      |
| `messages`   | `facebook_list_conversations`        |     `read`     | List Messenger conversations for a Page (platform=messenger only — never Instagram threads): id, updated_time, unread_count, message_count and the latest-message snippet. |
| `messages`   | `facebook_get_conversation`          |     `read`     | Read one Messenger thread newest-message-first: sender, timestamp, direction and body, plus typed placeholders for images, stickers, files and shared links (attachments…  |
| `messages`   | `facebook_send_message`              |  `reversible`  | Send ONE PRIVATE Messenger message as the Page — text, or one attachment (image / audio / video / file by public HTTPS URL or reusable attachment_id) — as a reply inside… |
| `messages`   | `facebook_react_to_message`          |  `reversible`  | React to ONE Messenger message as the Page with a single emoji (for example "❤️" or "👍"), or remove the Page’s reaction with remove:true — an acknowledgement without a…  |
| `messages`   | `facebook_upload_message_attachment` |  `reversible`  | Upload ONE file (image / audio / video / file) by public HTTPS URL to the Page’s Messenger attachment store and get a reusable attachment_id — valid for about 90 days…    |
| `messages`   | `facebook_get_activity_since`        |     `read`     | What is new on a Page since a point in time, in one call: new comments (and replies) on the most recent published posts, and Messenger conversations updated since then…   |
| `messages`   | `facebook_list_saved_replies`        |     `read`     | List the Page's local saved replies: operator-approved reply templates kept on this machine (no Facebook call).                                                            |
| `messages`   | `facebook_save_reply`                |  `reversible`  | Create or update a local saved reply (no Facebook call): a reply template the operator approves once and the agent then sends verbatim.                                    |
| `messages`   | `facebook_delete_saved_reply`        |  `reversible`  | Delete one local saved reply (no Facebook call).                                                                                                                           |
| `messages`   | `facebook_list_labels`               |     `read`     | List the Page’s custom Messenger labels (id and name), or — with psid — the labels on one person.                                                                          |
| `messages`   | `facebook_create_label`              |  `reversible`  | Create a custom Messenger label on the Page (for example "vip" or "refund-pending") and return its id, to put on people with facebook_assign_label.                        |
| `messages`   | `facebook_assign_label`              |  `reversible`  | Put a custom label on one person (their PSID from a conversation), so the thread shows in the Page inbox label view; remove:true takes it off.                             |
| `messages`   | `facebook_delete_label`              | `irreversible` | PERMANENTLY delete a custom label from the Page.                                                                                                                           |
| `ads`        | `facebook_list_campaigns`            |     `read`     | List campaigns under one ad account, a cursor page at a time.                                                                                                              |
| `ads`        | `facebook_list_adsets`               |     `read`     | List ad sets under one ad account, a cursor page at a time.                                                                                                                |
| `ads`        | `facebook_list_ads`                  |     `read`     | List individual ads under one ad account, a cursor page at a time.                                                                                                         |
| `ads`        | `facebook_get_ad_object`             |     `read`     | Read one campaign, ad set or ad by id.                                                                                                                                     |
| `ads`        | `facebook_get_ad_preview`            |     `read`     | Show how an existing ad, an existing ad creative, or a Page post used as an ad would render in one placement (`ad_format`, default MOBILE_FEED_STANDARD).                  |
| `ads`        | `facebook_ads_insights`              |     `read`     | Read performance numbers (impressions, clicks, spend, reach, cpc, ctr) for an ad account, campaign, ad set or ad.                                                          |
| `ads`        | `facebook_ads_report_status`         |     `read`     | Probe one async insights report run and, with fetch_results:true, read its rows once it has completed.                                                                     |
| `ads`        | `facebook_update_ad_object`          |    `spend`     | Pause or resume an ads object, change its budget, or set a campaign spend cap.                                                                                             |
| `ads`        | `facebook_archive_ad_object`         | `irreversible` | Archive one campaign, ad set or ad by id.                                                                                                                                  |
| `ads`        | `facebook_delete_ad_object`          | `irreversible` | Delete one campaign, ad set or ad by id — permanently.                                                                                                                     |
| `ads`        | `facebook_upload_ad_image`           |  `reversible`  | Upload one local image (JPEG, PNG, GIF, BMP, TIFF or WEBP, at most 30 MB, inside FB_MEDIA_DIR) to the ad account's image library and return its hash, which creatives…     |
| `ads`        | `facebook_get_ad_set_targeting`      |     `read`     | Read one ad set's audience and summarise it in plain terms: countries, counts of regions / cities / locales, age range, genders, placements, and flags for detailed…       |
| `ads`        | `facebook_update_ad_set_targeting`   |    `spend`     | Change only the countries and/or the age range of one ad set's audience; everything else in its targeting is kept exactly as it is, except that an unset Advantage+…       |
| `ads`        | `facebook_duplicate_ad_object`       | `irreversible` | Copy one campaign, ad set or ad into a new PAUSED copy (an ad set copy stays in its campaign, an ad copy in its ad set).                                                   |
| `ads`        | `facebook_boost_post`                | `irreversible` | Boost one existing Page post: create a campaign, ad set, ad creative and ad that promote it.                                                                               |
| `page_admin` | `facebook_update_page_profile`       |  `reversible`  | Change the Page's public business fields: about, description, website, phone, opening hours, is_always_open and temporary_status.                                          |

<!-- END GENERATED -->

## How this compares

Point-in-time survey as of **2026-10-29**; this market changes monthly, so check
the date. Sources and method are in
[`docs/reviews/v3/07-product-manager.md`](docs/reviews/v3/07-product-manager.md)
§4; the older long-form write-up (2026-07-21) is
[`docs/analysis/02-market-and-positioning.md`](docs/analysis/02-market-and-positioning.md).
Entries marked _unverified_ were not checked beyond their listing.

| Project                                                   | Focus                                                | Type                   | Notes                                                                                      |
| --------------------------------------------------------- | ---------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------ |
| **facebook-mcp** (this)                                   | Pages, messaging, moderation; ads opt-in             | OSS (MIT), local, TS   | Your own Meta app and token, plan-and-apply writes, local media upload. Not live-verified. |
| **Meta Ads MCP**                                          | Ads                                                  | Official, hosted, beta | Launched 2026-04-29. OAuth, no developer app of your own. Free.                            |
| **Meta Social Technologies MCP**                          | App status, webhooks, docs, API troubleshooting      | Official, hosted       | Launched 2026-06-30. Overlaps with `doctor` for diagnosing Graph errors.                   |
| **WhatsApp Business Tools MCP**                           | WhatsApp Business setup, templates, sending messages | Official, hosted       | Launched 2026-09-15 with a gradual rollout. Meta has no Pages MCP listed as of the survey. |
| `pipeboard-co/meta-ads-mcp`                               | Ads                                                  | OSS (BUSL-1.1), hosted | About 1.3k stars. BUSL-1.1 is not an OSI open-source licence.                              |
| `HagaiHen/facebook-mcp-server`                            | Pages, single Page                                   | OSS (MIT), Python      | About 230 stars; no commits since 2026-04-23.                                              |
| `facebook-pages-mcp`, `@luminarylane/facebook-mcp-server` | Pages / Facebook                                     | OSS on npm             | Similar weekly downloads to this project; scope _unverified_.                              |
| Hosted social-media connectors                            | Multi-network publishing and scheduling              | Hosted SaaS            | One-click OAuth, no developer app, often with paid tiers; feature claims _unverified_.     |

**If you only need ads, use Meta's official Ads MCP.** It is free, needs no
developer app of your own, is maintained by the vendor, and covers more ads
surface than this project ever will. The `ads` package here exists for one
reason: composing ads with Pages, moderation and messaging under a single token
and config, with the same spend gating. That is why it is **off by default** —
ads are not the reason to install this.

**If you do not write code, a hosted connector is likely the better fit.** The
setup here needs a Meta developer app and a token you manage yourself.

The reason to install this is the Pages side, run from your own machine: video
and Reels upload from local files, scheduled-post lifecycle, insights that tell
you when a metric was renamed or retired, comment and message moderation, and
writes you preview before they apply — in a typed, tested, MIT-licensed server
under a token you own.

## Known limitations

Current, factual, and deliberately unflattering:

- **No live Graph API verification.** Nothing here has been proven against Meta's
  servers. Fixtures encode what the API is documented to do; reality gets a vote.
- **Published, but brand new.** 0.8.0 is on npm with provenance, the `.mcpb`
  bundle is attached to the GitHub release and the MCP Registry lists 0.8.0 — but
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
  quiet for more than 24 hours cannot be replied to without a message tag. This
  server sends no message tags (the only working one, `HUMAN_AGENT`, needs its
  own App Review approval), so such a reply is refused with an explanation.
- **Single maintainer, pre-1.0.** Tool names, arguments and result shapes are
  planned to change in 0.9 (see [Roadmap](#roadmap)). Until 1.0 there is no
  guaranteed deprecation period.

## Not in scope

Two different things: tools that **ship but are experimental**, and things this
server does **not** do and does not plan to. Listed so you can rule it out in
thirty seconds instead of after an install.

### Shipped but experimental

These tools are in the [tool table](#tools) and work like the rest, but they
are outside the contract the roadmap stabilises: they may change or be removed
in any minor release, including after 1.0. Like every other tool, none has been
verified against a live Page or ad account.

- **Ads writes beyond status and budget** (`ads` package, opt-in):
  `facebook_boost_post`, `facebook_duplicate_ad_object`,
  `facebook_update_ad_set_targeting`, `facebook_upload_ad_image`,
  `facebook_archive_ad_object`, `facebook_delete_ad_object`.
- **Messenger labels, reactions and attachments** (`messages` package):
  `facebook_list_labels`, `facebook_create_label`, `facebook_assign_label`,
  `facebook_delete_label`, `facebook_react_to_message`,
  `facebook_upload_message_attachment`.
- **Page profile edits** (`page_admin` package, opt-in):
  `facebook_update_page_profile`.

The tool descriptions do not carry this marking yet.

### Not planned

- **Personal profiles and Groups.** Publishing to a personal timeline has no
  API, and the Groups API was discontinued in April 2024. This server operates
  **Pages** — nothing else.
- **Instagram, Threads, WhatsApp.** Different products, different permission
  sets. Instagram has its own sibling server — see
  [(c) Instagram alongside](#c-instagram-alongside-the-sibling-server).
- **Webhooks / real-time ingestion.** A local stdio server has no public URL to
  receive callbacks on. Reads are polled, by design.
- **A general ad-creation surface.** `facebook_boost_post` is the one create
  path: one existing Page post, everything PAUSED, a mandatory campaign spend
  cap, no special ad categories. Ads breadth beyond boosts, paused copies and
  narrow edits stays with Meta's own tools.
- **Events, Live video, organic post targeting, multi-network scheduling.**
  Real needs, outside the Pages publishing, insights, moderation and messaging
  surface this server is built around.
- **Multi-tenant or hosted operation, serving other businesses' Pages or ad
  accounts.** The design targets one operator, Standard Access, own assets, own
  machine. Anything else needs App Review and Business Verification, which is a
  different product.
- **Telemetry** of any kind.

The reasoning is in
[`docs/analysis/01-goals-and-scope.md`](docs/analysis/01-goals-and-scope.md) and,
for the current plan, [`docs/analysis/v3/02-v3-scope.md`](docs/analysis/v3/02-v3-scope.md)
(that document still uses the old release labels; see [Roadmap](#roadmap)).

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
- **Ads are your contract with Meta.** Every campaign, ad set or ad this server
  creates, copies or changes is in your ad account, under the Meta Self-Serve
  Ad Terms and Advertising Standards you accepted, and you pay for it. Boosts
  and copies start PAUSED. A boost needs a mandatory `spend_cap_minor` within
  `FB_ADS_CAMPAIGN_SPEND_CAP_MAX` (it is refused while that is unset), and a
  budget within `FB_ADS_BUDGET_CEILING` when you set one — but activating a
  campaign is your decision. `facebook_boost_post` always declares **no special
  ad category**: never use it for housing, employment, credit, or social issues,
  elections or politics. Those ads need a declared category (and, in the EU,
  are subject to the political-advertising rules) and must be created in Ads
  Manager. This software is provided under the MIT licence, without warranty;
  the author is not liable for ad spend or ad content.
- **You answer for this server and the model driving it.** From 20 November
  2026 Meta's Self-Serve Ad Terms make you solely responsible for the acts or
  omissions of any third-party software you use with the ads APIs — that
  includes this server and the AI model driving it. Review every plan before you
  apply it.
- **This is not legal advice.** It is the honest note that a capable automation
  tool comes with obligations, and this project would rather say so up front.

The security-side counterpart is in
[`SECURITY.md`](SECURITY.md#out-of-scope-for-the-threat-model).

What data the tools read, where it goes (including your AI provider) and what
stays on disk is described in the [privacy notice](PRIVACY.md).

## Roadmap

Work is tracked publicly on the
[**facebook-mcp roadmap** board](https://github.com/users/IvanBBaev/projects/3).
The plan below is a target, not a promise; the binding version is
[`docs/analysis/v3/04-roadmap-and-risks.md`](docs/analysis/v3/04-roadmap-and-risks.md).

| Release   | Target                           | What it carries                                                                                                                                                                                                                                              |
| --------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **0.8.x** | Nov 2026                         | 0.8.0 is released. 0.8.1 is planned to carry fixes already on `main` (free-text moderation verbs plan-first, Advantage+ audience pinned off on targeting edits). Documentation fixes and directory listings.                                                 |
| **0.9.0** | Jan 2027                         | The contract changes: a unified error shape, tool renames with deprecated aliases, pagination and argument clean-ups, a stable insights schema, security fixes. Gate: a live test subset passes and two people other than the owner complete the onboarding. |
| **1.0.0** | Mar–Apr 2027 (before 2027-04-30) | "Verified Pages core": the first release whose core behaviour has been seen working on a real Page, by the owner and at least two other people. Also MCP SDK v2, Node ≥ 24, and removal of the 0.9 deprecations.                                             |
| **1.x**   | Apr 2027 – Q3 2027               | Additive minors, one theme each.                                                                                                                                                                                                                             |
| **2.0.0** | Trigger-based, before 2028-04-30 | Removals: only current-era MCP clients, `FB_CONFIRM_TOKEN` gone, Node ≥ 26.                                                                                                                                                                                  |

The `ads` and `page_admin` packages ship in 0.8 already, **disabled by default**,
pre-1.0 and not live-verified; their write tools are mostly
[experimental](#shipped-but-experimental).

**Older labels.** The planning documents written before 2026-10-30 use other
numbers for the same releases: their "1.0" is **0.9**, their "2.0" is **1.0**,
and their "3.0" is **2.0**. The repository's GitHub milestones still carry the
older titles.

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
  `apply` for its text-free verbs because hiding a comment is high-volume,
  reversible work — and
  `FB_WRITE_MODE` overrides any package default outright, in either direction, so
  the mode is an operator decision rather than a per-tool promise. What the mode
  cannot touch: irreversible and spend actions always require an out-of-band
  confirmation, and anything that reaches a live audience (publishing a post or a
  Reel, publishing a scheduled post early, sending a DM, or a public comment,
  reply or comment edit as the Page) additionally requires a `plan_id` bound to a
  preview of that exact call. No env flag bypasses either. A session that reads
  comments or the inbox should run a read-only profile or a client with
  elicitation — see [SECURITY.md](SECURITY.md).
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
  roadmap, corner cases, the original v1.0 release definition, and the parallel
  task-breakdown. The current plan is in
  [`docs/analysis/v3/`](docs/analysis/v3/README.md), and the 2026-10 role
  reviews are in [`docs/reviews/v3/`](docs/reviews/v3/).
- **Runbooks** — operational procedures in [`docs/runbooks/`](docs/runbooks/).
- **Error catalog** — every Graph error the server classifies, whether it is
  retried, and what to do: [`docs/error-catalog.md`](docs/error-catalog.md).
- **Documentation site** — [ivanbbaev.github.io/facebook-mcp](https://ivanbbaev.github.io/facebook-mcp/).

The environment table, the package/tool tables and the permission tables above,
and the error catalog, are generated from the code by `npm run metadata`; CI
fails if they drift.

## Support

Best-effort, single-maintainer support runs through GitHub — see
[SUPPORT.md](SUPPORT.md) for how to ask a question, file a bug or a feature
request, and report a security issue privately. If you got the server working
with a client or a live Page, an issue saying so is useful too: it is how the
[Client compatibility](#client-compatibility) table turns into ✅.

If the project helps you, you can sponsor it through
[GitHub Sponsors](https://github.com/sponsors/IvanBBaev) (other channels are
listed in [`.github/FUNDING.yml`](.github/FUNDING.yml)). Sponsoring buys no
priority support and no SLA.

## Trademark

This is an independent, community-built project and is not affiliated with,
endorsed by, or sponsored by Meta Platforms, Inc. Facebook, Meta and related
marks are trademarks of Meta Platforms, Inc., used here only nominatively to
indicate compatibility.

## License

[MIT](LICENSE) © 2026 Ivan Baev
