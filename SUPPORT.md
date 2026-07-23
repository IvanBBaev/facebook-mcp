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

## Privacy: nothing phones home

This is worth restating because it shapes what "support" can even see. The
project is **local-first with no telemetry**: it collects nothing, sends nothing
to the maintainer, and reaches only three Meta hosts (`graph.facebook.com`,
`graph-video.facebook.com`, `rupload.facebook.com`) — never any endpoint owned by
this project. There is no usage data, no crash reporting, and no phone-home of
any kind. When you file an issue, **you** choose exactly what to share, and you
must redact tokens and secrets before sharing anything.
