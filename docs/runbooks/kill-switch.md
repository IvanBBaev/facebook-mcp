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
   - applying the read-only preset / deny override
     (`FB_PACKAGES_READONLY` / `FB_PACKAGES_DENY`).
   > TBD: confirm the exact preset variable name at release — the corpus references
   > both a `readonly` preset and `FB_PACKAGES_READONLY`/`FB_PACKAGES_DENY`. The
   > mechanism (drop the write packages) is stable regardless of the final name.
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

1. Set the deny override (`FB_PACKAGES_DENY`) to the write packages you want gone
   (e.g. `posts,moderation,messages,ads`).
   > TBD: confirm the exact deny variable name at release (`FB_PACKAGES_DENY` per
   > the architecture doc). Mechanism is stable: denied packages are not loaded.
2. **Restart.**

**Verify by:** same as Option 2 — the denied write tools are absent from the
manifest.

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
