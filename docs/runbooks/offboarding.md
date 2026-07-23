# Runbook: offboarding / clean uninstall

## When to use this

You are **decommissioning** an install of `facebook-mcp` — retiring the machine,
handing it off, or simply removing the server. This procedure removes the server
from your MCP client, revokes credentials so they can no longer act on your Page,
deletes all local state, and points you at the Meta-side cleanup.

Do the steps **in order**: revoke access before deleting local files, so a
lingering credential is never left valid with no operator watching it.

---

## 1. Halt writes and disconnect the client

1. If anything might still be running, halt writes first —
   [kill-switch.md](kill-switch.md).
2. Remove the `facebook-mcp` entry from your **MCP client configuration**:
   - **Claude Desktop / Claude Code:** delete the server's entry from the client's
     MCP server config and restart the client.
   - **Other clients:** remove the equivalent server definition.
3. If you installed a **desktop bundle (MCPB)**, uninstall it through the client so
   its keychain-stored `user_config` values (including any token) are removed.

**Verify by:** the client no longer lists `facebook-mcp` and none of its tools are
available.

---

## 2. Revoke credentials

Revoke so the token cannot act even if a copy survives somewhere. Match your route
(see [credential-rotation.md](credential-rotation.md) for detail):

- **Route A — System User token:** delete the **system user** in Business settings
  (this is the only revocation for a never-expiring token) or revoke the token;
  un-assign the Page and ad-account assets if the system user is being retired.
- **Route B — long-lived Page token:** trigger a **security event** (e.g. a
  password change) to invalidate issued tokens, or remove the app's access to the
  Page.

**Verify by:** a `debug_token` on the old token value reports it **invalid**.

---

## 3. Delete local state

Remove everything the server wrote to disk. There is no hosted state and no
telemetry — teardown is entirely local:

1. **Env / config file** — the XDG config env file holding `FB_ACCESS_TOKEN`,
   `FB_APP_SECRET`, and related values (written `0600`). Delete it. Also clear
   these from any shell profile, `.env`, or client config where you set them.
2. **Write journal** — `journal.jsonl` (and any rotated `journal.1.jsonl`) under
   the XDG **state** directory. It holds redacted structured metadata only, but
   delete it as part of a clean teardown.
3. **Any other XDG state** the server created under its state/cache directories.
4. **Media directory** — if you had set a media directory for local uploads, that
   directory belongs to you; the server created nothing there, but confirm no
   copies of media you no longer want remain.

> The exact XDG paths follow the platform's `XDG_CONFIG_HOME` / `XDG_STATE_HOME`
> conventions (with the OS defaults when unset). If unsure, locate them from the
> doctor output or by searching your config/state directories for the app's
> folder before deleting.

**Verify by:** the env file, journal(s), and state directory are gone; a search of
your config/state locations for the app's folder returns nothing.

---

## 4. Meta-side cleanup

The credential is revoked and local state is gone; finish on Meta's side:

1. **Remove app access to the Page / ad account.** In Business settings (Route A)
   or the Page's linked-apps view (Route B), remove the developer app's access so
   it no longer holds any standing permission on your assets.
2. **Data Use Checkup.** Meta periodically requires reconfirming an app's data use;
   if you are retiring the developer app entirely, you can let it lapse or delete
   the app. (The server cannot detect Data Use Checkup state — this is a manual
   Meta-console step.)
3. **Delete or disable the developer app** if it existed only for this server.

**Verify by:** the app no longer appears among the apps with access to your Page /
ad account in the Meta console, and (if deleted) the developer app is gone.

---

## Uninstall the package

Finally, remove the software itself:

- If installed globally or run via a package manager, uninstall it there.
- If run via `npx`, there is nothing persistent to remove beyond the npm cache.
- Remove any launcher scripts or shell aliases you added.

**Verify by:** the binary/command is no longer resolvable and nothing re-spawns
the server.
