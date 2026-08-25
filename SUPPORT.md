# Support

`facebook-mcp` is a single-maintainer, best-effort open-source project. Support
is provided through GitHub on a time-available basis — there is no SLA. Please
use the right channel below so issues stay searchable and triage stays sane.

## Before you ask

- **Design & rationale** — read the [README](README.md) and the
  pre-implementation corpus in
  [`docs/analysis/`](docs/analysis/README.md). Most "why does it work this way?"
  questions (auth/token strategy, architecture, tool catalog, corner cases, the
  v1.0 definition) are answered there.
- **Operator procedures** — the runbooks in
  [`docs/runbooks/`](docs/runbooks/README.md) cover credential rotation, halting
  writes, and clean uninstall.
- **Diagnostics** — run the doctor / `facebook_whoami` flow first; it reports
  token type, validity, scopes, expiry, and which tools will and won't work. Its
  output (with secrets redacted) is exactly what a good bug report needs.

## Where to get help

- **Bugs** → open a [bug report](https://github.com/IvanBBaev/facebook-mcp/issues/new/choose)
  using the issue template. Include the server version, Node version, OS,
  transport, and relevant **redacted** logs.
- **Feature requests** → open a
  [feature request](https://github.com/IvanBBaev/facebook-mcp/issues/new/choose)
  using the template; describe the problem and which tool area it touches.
- **Questions / ideas / show-and-tell** → use
  [GitHub Discussions](https://github.com/IvanBBaev/facebook-mcp/discussions) if
  enabled on the repository; otherwise a lightly-scoped issue is fine.
- **Security vulnerabilities** → do **not** file a public issue. Follow
  [SECURITY.md](SECURITY.md) (private GitHub Security Advisory or maintainer
  email).

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the dev
workflow and the single check gate.

## What is committed to stay maintained

A single maintainer cannot promise the whole surface forever, so the scope of
that promise was fixed **before** launch rather than after enthusiasm ran out
(see the post-launch checkpoints in
[`docs/analysis/08-roadmap.md`](docs/analysis/08-roadmap.md)):

- The **minimum maintained core** is `core` + `reader` + `posts` + `insights`.
  These packages get bug fixes and Meta-changelog upkeep for as long as the
  project is published at all.
- `moderation`, `messages` and `ads` ship on the same terms as everything else
  today, but they are the packages a scope reduction would touch first.
- At **90 days after launch** the project is measured against a pre-committed
  adoption bar (≥100 weekly downloads / ≥25 stars / ≥3 non-author issues). If it
  is not met, the declared outcome is a **downgrade to a personal tool**: the
  minimum core keeps being maintained, the rest becomes as-is. That is a
  reduction in support, not a deletion — nothing is unpublished and the MIT
  licence keeps every fork viable.

This is written down so you can plan around it. If a package outside the minimum
core is load-bearing for you, say so in an issue — usage that is visible is
usage that counts at the checkpoint.

## Funding the maintenance

The project is MIT-licensed and free, with no paid tier and no commercial
support offering. Maintenance happens in the maintainer's own time, so tips are
welcome:

- **[GitHub Sponsors](https://github.com/sponsors/IvanBBaev)** — one-off or
  recurring, no platform fee.
- **[Ko-fi](https://ko-fi.com/ivanbbaev)** — quick one-off support, no account
  needed.
- **[Donatree](https://donatr.ee/ivanbbaev/)** — every donation method on one
  page, including local payment options.

To be explicit: **donating buys no priority and no SLA.** Sponsored and
unsponsored issues are triaged the same way. Starring the repository, writing a
reproducible bug report, or telling another Page admin about the project helps
just as much as money.

## Privacy: nothing phones home

This is worth restating because it shapes what "support" can even see. The
project is **local-first with no telemetry**: it collects nothing, sends nothing
to the maintainer, and reaches only three Meta hosts (`graph.facebook.com`,
`graph-video.facebook.com`, `rupload.facebook.com`) — never any endpoint owned by
this project. There is no usage data, no crash reporting, and no phone-home of
any kind. When you file an issue, **you** choose exactly what to share, and you
must redact tokens and secrets before sharing anything.
