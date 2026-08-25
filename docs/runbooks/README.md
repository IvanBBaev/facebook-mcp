# Operator runbooks

Short, procedural guides for operators running `facebook-mcp` against their own
Facebook Page. Each runbook opens with a **when to use this** section, then gives
numbered steps and **verify by…** checks. They are grounded in the design in
[`../analysis/04-auth-and-security.md`](../analysis/04-auth-and-security.md) and
[`../analysis/05-architecture.md`](../analysis/05-architecture.md).

> Note on identifiers. Environment-variable and tool names are final and match
> the shipped code — including the package overrides `FB_PACKAGES_READONLY` and
> `FB_PACKAGES_DENY`. Each runbook still describes the mechanism alongside the
> name, so the procedure reads correctly on its own.

## Runbooks

| Runbook                                          | Use it when                                                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| [onboarding.md](onboarding.md)                   | You are setting the server up for the first time — Meta app, scopes, `setup-token`, `doctor`.                  |
| [credential-rotation.md](credential-rotation.md) | A token is expiring, leaked, or you suspect compromise — rotate or revoke the System User token or Page token. |
| [kill-switch.md](kill-switch.md)                 | You need to immediately halt all write activity (posts, moderation, messaging, ads).                           |
| [app-upkeep.md](app-upkeep.md)                   | The ~4-week maintenance pass — Meta changelog, API-version deprecation, Data Use Checkup, token expiry.        |
| [offboarding.md](offboarding.md)                 | You are decommissioning the server — clean uninstall, token revocation, and local-state deletion.              |
| [operator-window.md](operator-window.md)         | You need live QA for the three tools no smoke test can cover — send message, private reply, block user.        |
| [release.md](release.md)                         | You are cutting a release — tag, CI-only publish, provenance, MCPB bundle, registry listing.                   |

## Related

- [SECURITY.md](../../SECURITY.md) — security posture and vulnerability reporting.
- [04-auth-and-security.md](../analysis/04-auth-and-security.md) — token strategy,
  redaction choke-point, threat model, and write-gating tiers.
