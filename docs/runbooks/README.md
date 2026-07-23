# Operator runbooks

Short, procedural guides for operators running `facebook-mcp` against their own
Facebook Page. Each runbook opens with a **when to use this** section, then gives
numbered steps and **verify by…** checks. They are grounded in the design in
[`../analysis/04-auth-and-security.md`](../analysis/04-auth-and-security.md) and
[`../analysis/05-architecture.md`](../analysis/05-architecture.md).

> Note on identifiers. Exact environment-variable and tool names are pinned by
> the corpus where possible; a few (for example the read-only package preset) are
> designed but may be finalized at release. Where a name is not yet final, the
> runbook says so and describes the mechanism, so the procedure stays correct
> even if an identifier changes.

## Runbooks

| Runbook                                          | Use it when                                                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| [credential-rotation.md](credential-rotation.md) | A token is expiring, leaked, or you suspect compromise — rotate or revoke the System User token or Page token. |
| [kill-switch.md](kill-switch.md)                 | You need to immediately halt all write activity (posts, moderation, messaging, ads).                           |
| [offboarding.md](offboarding.md)                 | You are decommissioning the server — clean uninstall, token revocation, and local-state deletion.              |

## Related

- [SECURITY.md](../../SECURITY.md) — security posture and vulnerability reporting.
- [04-auth-and-security.md](../analysis/04-auth-and-security.md) — token strategy,
  redaction choke-point, threat model, and write-gating tiers.
