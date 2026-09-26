# Runbook: write kill-switch

## When to use this

You need to **immediately stop the server from making any write** to the Graph API
— publishing, editing, deleting, comment moderation, messaging, or ads changes.
Reach for this when:

- You suspect the model has been **prompt-injected** by tainted Facebook content
  (a comment/DM instructing it to post, reply, delete, or spend).
- A token may be **compromised** (do this first, then
  [credential-rotation.md](credential-rotation.md)).
- Something is misbehaving and you want a hard stop while you investigate.

The options below are ordered from **strongest** (nothing can reach Graph at all)
to **operational** (the server stays up but cannot write). Use the strongest one
the situation warrants.

---

## Understand what does and does not stop writes

- **`FB_WRITE_MODE` is not a kill-switch.** Plan-and-apply is an _accident brake_,
  not a security control: in an autonomous loop the model itself supplies the
  apply signal. Setting write mode back to plan-only reduces _accidental_ writes
  but does **not** stop a hijacked model. Do not rely on it alone when you suspect
  injection or compromise.
- **The irreversible/spend tier already can't be env-bypassed.** Deletes and ads
  spend always require an out-of-band confirmation the model cannot supply itself;
  `FB_WRITE_MODE=apply` never covers them. That protects the worst actions by
  default, but the kill-switch below removes the _rest_ of the write surface too.

---

## Option 1 — Revoke the token (strongest; nothing reaches Graph)

Guarantees no write (or read) can hit the Graph API, because the credential is
dead. This is the only option that holds even if the process is compromised.

1. Revoke the runtime token per [credential-rotation.md](credential-rotation.md):
   - **System User (never-expiring):** delete the system user.
   - **System User (expiring):** regenerate/revoke the token.
   - **Page token:** trigger a security event (e.g. password change) to invalidate
     issued tokens.
2. Optionally stop the server process as well.

**Verify by:** a `debug_token` on the old value (doctor / `facebook_whoami`, or the
Graph API Explorer) reports it **invalid**; any tool call now fails with a `190`
(invalid/expired token). No further Graph calls are possible.

---

## Option 2 — Restrict to a read-only / plan-only profile (server stays up)

Keeps reads and diagnostics working while removing the ability to write. Use when
you still want insights/reads but no mutations.

1. Reconfigure the server to a **read-only package profile** so write packages
   (`posts`, `moderation`, `messages`, and `ads`) are not loaded — leaving only
   read surfaces (`core`, `reader`, `insights`). The corpus describes this as the
   recommended posture for unattended untrusted-content ingestion. Achieve it by
   either:
   - setting `FB_TOOL_PACKAGES` to a reader-only set (e.g. `core,reader,insights`),
     or
   - applying the read-only preset or the deny override. Both are read at
     startup, and they are **not** the same operation: `FB_PACKAGES_READONLY`
     keeps the named packages but drops every write-tier tool from them, while
     `FB_PACKAGES_DENY` removes the named packages entirely, their read tools
     included — denying `posts` also takes `facebook_list_scheduled_posts` and
     `facebook_get_video_status` with it.
2. **Restart** the server so it re-reads the package selection.

**Verify by:** the doctor / tools-manifest shows the write tools (`*_create_*`,
`*_delete_*`, `*_hide_*`, `send_message`, `private_reply`, `block_user`, all `ads`
writes) are **absent** from the surface. Attempting one returns "unknown tool",
not a queued write. The tool-surface is snapshot-tested, so the loaded set is
exactly the configured set.

---

## Option 3 — Deny write packages explicitly

If you want to keep a broad `FB_TOOL_PACKAGES` but subtract the dangerous parts,
use the deny override to remove specific write packages:

1. Set the deny override `FB_PACKAGES_DENY` to the write packages you want gone
   (e.g. `posts,moderation,messages,ads`). Denied packages are not loaded.
2. **Restart.**

**Verify by:** same as Option 2 — the denied write tools are absent from the
manifest.

### `FB_PACKAGES_DENY=all` — the fastest in-process stop

Under pressure, enumerating the write packages correctly is exactly the kind of
thing that goes wrong. `FB_PACKAGES_DENY=all` collapses the surface to the
always-on `core` package — four read-only identity and rate-limit tools — in one
token, and it does so **whatever `FB_TOOL_PACKAGES` says**, because deny is applied
after the selection. It leaves you enough server to run `facebook_whoami` and
`facebook_usage` while you investigate. This is the maximum stop that does not
touch the credential; it is still weaker than Option 1, which is the only option
that holds if the process itself is compromised.

> **Read this before typing a name into `FB_PACKAGES_DENY`.** All three package
> variables share one namespace of packages **and** profiles, and a profile name
> wins over a same-spelled package. `FB_PACKAGES_DENY=core` therefore does **not**
> remove the `core` package — it denies the whole six-package `core` profile, and
> the `core` package comes back anyway because it is always-on. That is **not**
> the same collapse as `all`: the `core` profile does not include `ads`, so on an
> install whose selection contains it (`FB_TOOL_PACKAGES=all`, or `ads` named
> explicitly) `FB_PACKAGES_DENY=core` leaves the entire `ads` package loaded —
> including `facebook_update_ad_object`, the only spend-tier tool in the server.
> Only `FB_PACKAGES_DENY=all` collapses the surface unconditionally: during an
> incident, type `all`. A name that matches neither a package nor a profile
> is a **startup error**, not a silently ignored token: if you typo the deny list
> during an incident the server refuses to start, which is the safe direction, but
> you will see a `PackageSelectionError` rather than a running read-only server.
> The error names the offending token, the variable it came from
> (`FB_PACKAGES_DENY` here, not the allow list), and the full set of valid names,
> so the fix is a one-line correction rather than a search.

---

## Recommended order in an incident

1. **Option 1 (revoke)** if compromise or active injection is suspected — it is
   the only guarantee.
2. Then **rotate** a fresh least-privilege credential per
   [credential-rotation.md](credential-rotation.md).
3. Bring the server back on a **read-only profile** (Option 2) while you review the
   **write journal** (structured metadata under the XDG state dir) to see exactly
   what was applied and when.
4. Re-enable write packages only once you have identified and closed the cause.

**Verify the all-clear by:** doctor reports a valid, least-privilege token; the
manifest shows only the tools you intend; the journal review is complete; and a
deliberate write in **plan mode** produces a preview with the explicit "was NOT
performed" line — confirming plan mode performs **zero** network mutations.
