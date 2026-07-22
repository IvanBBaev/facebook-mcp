# facebook-mcp

A TypeScript [Model Context Protocol](https://modelcontextprotocol.io) (MCP)
server for the **Meta Graph API**, focused on **Facebook Pages**: publishing,
reading & insights, and comment/message moderation — operated locally by a Page
admin using their own Meta developer app.

> 🚧 **Status: pre-1.0, in active development.** Not yet published to npm. The
> design is complete and documented; implementation is in progress. Interfaces
> and scope may change until the first tagged release.

## What it will do

| Area                   | Capability                                                                |
| ---------------------- | ------------------------------------------------------------------------- |
| **Publishing**         | Text / link / photo / video / Reels posts, scheduling, edit & delete      |
| **Reading & insights** | Page & post reads, cursor pagination, live-verified insight metrics       |
| **Moderation**         | Comment hide/unhide/delete, message reads & replies                       |
| **Ads (1.1)**          | Campaign/adset/ad read + status & budget control (opt-in, off by default) |

The default profile exposes a deliberately small, curated tool surface — each
tool wraps a real, verified capability rather than mirroring every Graph edge.

## Design principles

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

- Node.js **≥ 22**
- A Meta (Facebook) developer app and a Page/ad-account you administer

## Documentation

The full pre-implementation design corpus lives in
[`docs/analysis/`](docs/analysis/README.md): goals & scope, market positioning,
Graph API landscape, auth & security model, architecture, tool catalog, risks,
roadmap, corner cases, the v1.0 release definition, and the parallel
task-breakdown that drives development.

## License

[MIT](LICENSE) © 2026 Ivan Baev
