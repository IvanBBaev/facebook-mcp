---
name: Bug report
about: Report something that behaves incorrectly
title: '[bug] '
labels: bug
---

<!--
Before filing:
- Search existing issues to avoid duplicates.
- Do NOT report security vulnerabilities here — see SECURITY.md for private reporting.
- REDACT all tokens and secrets from anything you paste (logs, config, URLs).
-->

## What happened

A clear, concise description of the actual behavior.

## What you expected

What you expected to happen instead.

## Steps to reproduce

1.
2.
3.

Which tool(s) were involved (e.g. `facebook_create_post`, `facebook_list_posts`)
and whether the call was in plan (dry-run) or apply mode.

## Environment

- **Server version:** <!-- `facebook_whoami` version field or `--version` -->
- **Node version:** <!-- `node --version` -->
- **OS:** <!-- e.g. macOS 15, Ubuntu 24.04, Windows 11 -->
- **Transport:** <!-- stdio (default) or http -->
- **MCP client:** <!-- e.g. Claude Desktop, Claude Code, other -->
- **Enabled packages:** <!-- FB_TOOL_PACKAGES value, or "default" -->

## Doctor / whoami summary

<!-- Paste the redacted output of the doctor / facebook_whoami flow. It reports
token type, validity, scopes, and expiry, and is the single most useful thing for
triage. -->

## Relevant logs

<!-- Paste relevant server logs (stderr). Server output is redacted at a
value-based choke-point, but DOUBLE-CHECK there are no tokens, app secrets,
appsecret_proof values, or token-bearing URLs before pasting. -->

```
paste redacted logs here
```

## Checklist

- [ ] I searched existing issues and this is not a duplicate.
- [ ] This is **not** a security vulnerability (those go through SECURITY.md).
- [ ] I have **removed all tokens and secrets** from logs, config, and URLs above.
