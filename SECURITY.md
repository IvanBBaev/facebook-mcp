# Security Policy

`facebook-mcp` is a local-first MCP server that operates a Facebook Page on
behalf of the operator who runs it. Security is a first-class design concern, not
an afterthought — the model is documented in
[`docs/analysis/04-auth-and-security.md`](docs/analysis/04-auth-and-security.md).
This file covers supported versions, how to report a vulnerability, the posture
you can rely on, and what is explicitly outside the threat model.

## Supported versions

The project is **pre-1.0 and in active development**; nothing is published to npm
before `1.0.0` and interfaces may change until the first tagged release.

| Version                | Supported                       |
| ---------------------- | ------------------------------- |
| Latest tagged release  | ✅ Security fixes land here     |
| Any older tag / commit | ❌ Please upgrade to the latest |

Security fixes target the **latest release only**. After 1.0, this becomes "the
latest minor release"; there is no back-porting to older minors.

## Reporting a vulnerability

**Please report privately — do not open a public issue, discussion, or pull
request for a suspected vulnerability.**

1. Preferred: open a private report via GitHub Security Advisories:
   <https://github.com/IvanBBaev/facebook-mcp/security/advisories/new>.
2. Fallback: email the maintainer at **ivanbbaev@gmail.com** with `facebook-mcp
security` in the subject.

Please include enough detail to reproduce: affected version/commit, transport
(`stdio` or `http`), configuration relevant to the issue, and a minimal
proof-of-concept. **Redact any real tokens or secrets** from anything you send —
see the redaction note below.

**What to expect.** This is a single-maintainer, best-effort project. You should
get an acknowledgement within a few business days. I ask for **coordinated
disclosure**: please give a reasonable window to release a fix before any public
write-up, and I will keep you updated on progress and credit you (if you want)
when the fix ships.

## Security posture

These are properties the design commits to; grounded in the corpus:

- **Local-first, no telemetry.** The server phones home to nobody. The only hosts
  it will ever reach are three Meta endpoints — `graph.facebook.com`,
  `graph-video.facebook.com`, and `rupload.facebook.com` — enforced by a fixed
  host allowlist with no user-configurable hosts, and cross-host redirects are
  not auto-followed.
- **Least-privilege credentials.** The runtime token is scoped to the enabled
  tool packages, not the union of every permission. Setup-only scopes (such as
  `business_management`) are never carried on the running token, and the doctor
  warns on over-scope and on never-expiring tokens.
- **Value-based secret redaction at one choke-point.** The exact configured
  secret _values_ (the access token(s), app secret, the HTTP-mode token, the
  derived `appsecret_proof`, and any app-access token) are stripped wherever they
  appear — across logs, errors, tool results, **and** the write journal. Known-
  value redaction has no false negatives; a prefix/pattern scan is defense-in-
  depth only. The result shaper additionally strips every `paging` object and
  token-bearing URL recursively, because Graph embeds `access_token` in
  `paging.next`.
- **Credentials off the query string.** Tokens are sent as an `Authorization`
  header, never in the URL. When the app secret is configured, `appsecret_proof`
  is attached to every call so a bare stolen token is useless.
- **Tiered plan-and-apply write gating with an out-of-band confirmation gate.**
  Write tools default to a validating dry-run preview that performs zero network
  mutations. Reversible writes may be applied via an explicit signal; but
  **irreversible (delete) and spend (ads) actions require an out-of-band
  confirmation the model cannot supply itself** (MCP elicitation where supported,
  an operator-set per-action token as fallback), and this tier is **never**
  bypassed by the `FB_WRITE_MODE` environment flag. Plan-and-apply is an accident
  brake; the confirmation gate is the security control.
- **Tainted-content isolation.** Attacker-controlled Facebook content (comments,
  DMs, visitor posts, author names, captions) is wrapped in a clearly delimited,
  labeled data envelope stating it is data, never instructions — to blunt prompt
  injection / confused-deputy attacks. For unattended ingestion of untrusted
  content, a **read-only package profile is the recommended configuration** so
  that reading untrusted content and taking destructive/spend actions are never
  enabled in the same session.
- **Append-only write journal.** Applied writes are recorded as structured
  metadata (no tokens, no PII — it passes through the same redactor), written
  `0600` under the XDG state directory, non-blocking, and size-rotated.
- **HTTP transport fails closed.** `FB_TRANSPORT=http` refuses to start without
  `FB_HTTP_TOKEN`, binds `127.0.0.1` only, validates the `Origin` header
  (DNS-rebinding guard), and does a constant-time bearer check on every request.
- **Local file upload is off by default.** Local media access is disabled unless
  a media directory is explicitly configured; when set, resolved paths are
  `realpath`-canonicalized and asserted contained within it (symlink-safe), with
  an extension/MIME allowlist.

Operators who handle a suspected credential compromise, need to halt writes
immediately, or are decommissioning an install should follow the operator
runbooks:

- [Credential rotation & compromise response](docs/runbooks/credential-rotation.md)
- [Write kill-switch](docs/runbooks/kill-switch.md)
- [Offboarding / clean uninstall](docs/runbooks/offboarding.md)

## Out of scope for the threat model

Stated soberly, so expectations are honest:

- **A compromised host.** If the machine running the server is compromised, the
  attacker already has the operator's environment, config, and credentials; no
  in-process control can defend against that. Protect the host.
- **A malicious or coerced operator.** The operator is the trusted principal —
  the _only_ trusted instruction channel is operator → model. A determined
  operator can enable every package in a single session; the controls above make
  the **default** safe and the dangerous path an explicit, out-of-band choice,
  not an implicit consequence of reading a comment. They do not police the
  operator's own intent.
- **Platform-policy compliance.** Automating posting, commenting, and messaging
  does not exempt the operator from Meta's Platform Terms and Developer Policies
  (anti-spam/automation rules, Messenger automation-disclosure expectations). See
  the compliance note in the auth-and-security doc. This is not legal advice.
- **Multi-user / hosted deployment.** The project targets a single operator
  running their own assets locally. There are no multi-user token vaults or
  encrypted-DB storage; running it as a shared hosted service is not a supported
  or reviewed configuration.
