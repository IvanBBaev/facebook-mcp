# Runbook: credential rotation & compromise response

## When to use this

- A token is **expiring** (a 60-day System User token on its rotation schedule, or
  a Page token near a security-event-driven invalidation) and you want to rotate
  ahead of an outage.
- A token has **leaked** or you **suspect compromise** (it appeared somewhere it
  should not, a machine was lost, or the doctor reports unexpected scopes).
- You need to **revoke** access entirely — see also
  [kill-switch.md](kill-switch.md) to stop writes _first_, then rotate here.

Two credential routes exist and rotate differently. Identify yours with the
doctor / `facebook_whoami` flow, which calls `debug_token` and reports the token
**type**, validity, scopes, and expiry.

- **Route A — System User token** (Business portfolio).
- **Route B — long-lived Page token** (no Business Manager).

---

## Why the blast radius is limited

Before rotating, understand what a leaked token can and cannot do — it changes how
urgently you must act:

- **The runtime token is least-privilege.** It is scoped to the enabled packages,
  not everything. Setup-only scopes such as `business_management` are **not**
  carried on it, so a leaked runtime token cannot manage business assets or create
  system users.
- **A bare token may be useless.** If **"Require App Secret"** is enabled on the
  app, calls require a valid `appsecret_proof`; a stolen token without the app
  secret is rejected.
- **Secrets do not leak through the server's own outputs.** Value-based redaction
  at a single choke-point strips the exact secret values from every log, error,
  tool result, and the write journal, and the result shaper strips token-bearing
  `paging` URLs. So the leak source is almost always the environment/host, not the
  server output — which tells you where to look.

Rotating the token is still the correct response to any suspected leak; the above
limits the damage in the meantime.

---

## Route A — rotate a System User token

1. **Stop writes first** if compromise is suspected — follow
   [kill-switch.md](kill-switch.md).
2. In **Business settings → Users → System users**, select the system user and
   **generate a new token**, scoped to the enabled packages only (do **not**
   re-add `business_management` to the runtime token). Prefer the **60-day
   expiring** variant and rotate on schedule; treat never-expiring as an explicit
   opt-in only.
3. **Revoke the old token.** For a compromised token you must invalidate the old
   value, not merely stop using it. A never-expiring System User token's only
   revocation is **deleting the system user** (then recreating it and reassigning
   Page + ad-account assets); an expiring token can be left to lapse only if
   compromise is _not_ suspected.
4. Update the secret in the server's configuration (the `FB_ACCESS_TOKEN`
   environment value / XDG env file). The env file is written atomically with
   `0600`; keep it that way.
5. **Restart** the server so it re-reads config and re-validates on startup.

**Verify by:** running the doctor / `facebook_whoami` — confirm the new token's
`valid`, expected `scopes`, and `expiresAt` (or `neverExpiring: true` for a
System User token), and that there is **no over-scope warning**. Then confirm the
old token is dead: a `debug_token` on the old value should report it invalid.

---

## Route B — rotate a long-lived Page token

1. **Stop writes first** if compromise is suspected — see
   [kill-switch.md](kill-switch.md).
2. Re-run the documented acquisition path: Graph API Explorer **user token** →
   server-side `fb_exchange_token` exchange → `GET /me/accounts` → the **Page
   token** with no expiration date.
3. To force old Page tokens to die on suspected compromise, trigger a
   **security event** on the underlying account (e.g. a **password change**),
   which invalidates issued tokens; then re-derive per step 2.
4. Update `FB_ACCESS_TOKEN` in the config / XDG env file (`0600`) and **restart**.

**Verify by:** doctor / `facebook_whoami` shows a valid Page token with the
expected scopes; a write in **plan mode** resolves the Page and passes the
permission check without a `190` (invalid/expired token) error.

> Note: for a Pages-only install, Route B is a complete path. If the **ads**
> package is enabled, ads calls ride the 60-day user token, so an ads-enabled
> install needs re-auth roughly every 60 days regardless.

---

## Rotating the app secret

If the **app secret** itself may have leaked (not just a token):

1. Rotate `FB_APP_SECRET` in **App settings → Basic** on the developer app, then
   update the `FB_APP_SECRET` config value and restart.
2. Because `appsecret_proof = HMAC-SHA256(token, app_secret)`, rotating the secret
   invalidates every previously-derived proof — existing tokens must be used with
   the new proof, which the server recomputes automatically once the new secret is
   configured.

**Verify by:** doctor / `facebook_whoami` succeeds (the server can sign calls with
the new secret) and calls are accepted with **"Require App Secret"** on.

---

## Suspected-compromise checklist

Do these in order:

1. **Halt writes** — [kill-switch.md](kill-switch.md) (revoke/deny writes before
   anything else).
2. **Revoke** the leaked credential per the matching route above (delete the
   system user for a never-expiring Route-A token; trigger a security event for a
   Route-B Page token).
3. **Rotate the app secret** if it may also be exposed.
4. **Review the write journal** (structured metadata under the XDG state dir — no
   tokens/PII in it) to see what writes were applied and when, so you can assess
   and reverse unwanted actions on the Page.
5. **Check scopes** with the doctor; if the leaked token had more scope than the
   enabled packages, re-issue with least privilege and confirm the over-scope
   warning is gone.
6. **Find the leak source** — since the server redacts its own outputs, look at
   the host: environment dumps, shell history, backups of the env file, CI logs,
   or a client that logged the token. Remediate there.

**Verify by:** the old credential is invalid (`debug_token`), the new one is valid
and least-privilege, no writes can occur until you intentionally re-enable them,
and the journal review is complete.
