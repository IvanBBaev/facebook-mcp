# Onboarding — zero to a working server

**When to use this.** You have never run `facebook-mcp` before and need a working
install against a Facebook Page you administer. Budget **20 minutes**; most of it
is Meta's app UI, not this server.

You do **not** need App Review. Standard Access on your own app is enough to
operate assets you already administer — App Review only matters when other
people's Pages are involved.

---

## What you will end up with

An env file at the platform config path, mode `0600`:

| Platform | Path                                                            |
| -------- | --------------------------------------------------------------- |
| macOS/Linux | `$XDG_CONFIG_HOME/facebook-mcp/.env` (default `~/.config/facebook-mcp/.env`) |
| Windows  | `%APPDATA%\facebook-mcp\.env`                                    |

> **Windows honesty note.** `0600` has no exact NTFS equivalent. The server
> reports what protection it actually achieved rather than claiming a POSIX mode
> it did not set. On a shared Windows machine, treat the file as readable by
> anything running as you.

Real environment variables always win over that file, so an MCP client that
injects `FB_*` in its own config overrides it.

---

## Step 1 — Create the Meta app (≈5 min)

1. Go to <https://developers.facebook.com/apps> → **Create app**.
2. Pick the **Business** app type. Consumer apps cannot hold the Page scopes.
3. From the app dashboard, note the **App ID** and **App Secret**
   (Settings → Basic). Both are optional for this server but strongly
   recommended: with `FB_APP_ID` + `FB_APP_SECRET` set, every call carries
   `appsecret_proof`, so a stolen bare token cannot be replayed on its own.
4. Add the **Facebook Login for Business** product if the Graph API Explorer does
   not already offer your app in its dropdown.

**Verify by…** the app appears in the Graph API Explorer's *Meta App* dropdown.

---

## Step 2 — Choose your scopes

Grant only what the packages you actually enable need. `setup-token` refuses
only when a **setup-blocking** scope is missing; a missing package scope is a
warning naming the exact scope and the exact package, because the install still
works with a smaller tool surface.

| Scope                     | Needed by                       | Blocking? |
| ------------------------- | ------------------------------- | --------- |
| `pages_show_list`         | Page discovery, token derivation | **yes** — without it `/me/accounts` returns nothing and no Page token can be derived |
| `pages_read_engagement`   | `reader`, `moderation`           | no        |
| `pages_manage_posts`      | `posts`                          | no        |
| `pages_manage_engagement` | `moderation` (hide/delete/reply) | no        |
| `pages_messaging`         | `messages`                       | no        |
| `read_insights`           | `insights`                       | no        |
| `ads_read`                | `ads` reads                      | no        |
| `ads_management`          | `ads` writes                     | no        |
| `business_management`     | System-User asset management     | no        |

The README's generated **Required scopes** table is the machine-checked version
of this list — it is derived from the same source the doctor uses, so trust it
over any prose that has drifted.

---

## Step 3 — Get a short-lived token from the Explorer (≈2 min)

1. Open the [Graph API Explorer](https://developers.facebook.com/tools/explorer/).
2. Select your app, then **User Token**, then tick the scopes from Step 2.
3. **Generate Access Token** and approve the dialog.
4. Copy the token. It expires in **1–2 hours** — that is fine, Step 4 exchanges it.

---

## Step 4 — Run `setup-token` (≈1 min)

Pass the token through the **environment**, not as an argument. A command-line
argument is visible to every process on the machine (`ps`) and lands in your
shell history; the tool warns when you do it anyway.

```sh
FB_SETUP_TOKEN='<paste>' npx @ivanbbaev/facebook-mcp setup-token
```

From a source checkout:

```sh
npm run build
FB_SETUP_TOKEN='<paste>' node build/index.js setup-token
```

What it does, in order:

1. **classify** — `/debug_token`: type, app id, granted scopes, expiry. Refuses
   early, with the exact missing scope named, if the token cannot do the job.
2. **exchange** — `grant_type=fb_exchange_token` for a long-lived token
   (**~60 days**, not forever — see Step 6).
3. **pages** — `/me/accounts` lists the Pages you administer and resolves the
   Page token for the one you selected.
4. **write** — writes the env file atomically at `0600` and prints **which keys**
   it wrote. Token values are never printed, logged, or echoed.

Useful flags:

| Flag                | Effect                                                          |
| ------------------- | --------------------------------------------------------------- |
| `--page=<id>`       | Pick the Page explicitly. Omit it and a *unique* Page is auto-selected; several Pages without this flag is an error, not a guess. |
| `--no-write` / `--dry-run` | Run everything and report what *would* be written. Nothing touches disk. |
| `--force`           | Overwrite an existing env file. The file is **replaced, never merged** — anything you hand-added to it is lost. |
| `--env-file=<path>` | Write somewhere else (useful for a per-project file).            |

Exit codes: `0` completed, `2` incomplete — the report says which step failed and
what to do about it.

**Verify by…** the report ends with `status: completed` and a `Next step:` line.

---

## Step 5 — Confirm with `doctor`

```sh
npx @ivanbbaev/facebook-mcp doctor
```

The doctor never throws for an auth or scope problem — it *reports*. Read the
permission × package matrix: every package you intend to use should be usable.
`ads` is **off by default**; enable it with `FB_TOOL_PACKAGES` and set
`FB_AD_ACCOUNT_ID` before the ad-account health line means anything.

**Verify by…** every package you plan to use shows as usable, and the token
expiry is the ~60-day one from Step 4 rather than the Explorer's 1–2 hours.

---

## Step 6 — Upgrade to a System-User token (recommended)

A long-lived user token still expires in ~60 days, and it dies when you change
your Facebook password. The **only** genuinely non-expiring credential is a
System-User token:

1. Claim the app into a **Business portfolio** (Business Settings → Apps → Add).
2. Create a **system user** with the *Admin* role.
3. Assign the **Page** — and the **ad account**, if you enable `ads` — as assets
   to that system user, with the tasks you need.
4. **Generate new token** for the system user, selecting the same scopes.
5. Put it in `FB_SYSTEM_TOKEN`; it takes precedence over `FB_ACCESS_TOKEN` and
   `FB_PAGE_TOKEN`.

Meta still recommends the 60-day variant plus scheduled rotation — see
[credential-rotation.md](credential-rotation.md).

---

## Step 7 — Point your MCP client at it

See the README's **client compatibility matrix** for the per-client config shape
and what has actually been verified. The server speaks stdio by default; stdout
is reserved for the protocol, so **all** diagnostics go to stderr.

---

## It didn't work

| Symptom                                                        | Cause                                                                    | Fix                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `classify` failed, "token is not valid"                        | The Explorer token already expired (1–2 hours).                          | Generate a fresh one and rerun Step 4.                                       |
| `classify` failed, `pages_show_list` missing                   | The scope was not ticked in the Explorer.                                 | Re-tick it, regenerate, rerun. This one is genuinely blocking.               |
| `classify` reports type `PAGE`                                 | You copied a Page token, not a User token.                                | Switch the Explorer dropdown to **User Token**.                              |
| `exchange` failed, "app secret required"                       | `FB_APP_ID` / `FB_APP_SECRET` are not set.                                | Set both from Settings → Basic and rerun.                                    |
| `pages` returned none                                          | The account administers no Page, or `pages_show_list` was granted for a different app. | Confirm in Business Settings that you are a Page admin, and that the Explorer app matches the app whose id `classify` printed. |
| `pages` failed with several ids listed                         | More than one Page and no `--page=<id>`.                                  | Rerun with `--page=<id>` — the server refuses to guess which Page you meant. |
| `write` skipped, "file exists"                                 | An env file is already there.                                             | Rerun with `--force` — but note it **replaces** the file, it does not merge. |
| Everything green, but the client shows no tools                | The client injects its own env, or is running a different binary.         | Run `doctor` through the *same* command the client uses.                     |
| Writes are refused at runtime                                  | `FB_WRITE_MODE` is `plan` (the default for `posts` / `messages` / `ads`). | That is intended. Preview first, then re-call with `apply` and the returned `plan_id`. |
| Ads tools missing entirely                                     | The `ads` package is off by default.                                      | Add `ads` to `FB_TOOL_PACKAGES` and set `FB_AD_ACCOUNT_ID`.                  |

## Related

- [credential-rotation.md](credential-rotation.md) — rotating or revoking a token.
- [kill-switch.md](kill-switch.md) — halting all write activity immediately.
- [offboarding.md](offboarding.md) — clean uninstall and local-state deletion.
- [../analysis/04-auth-and-security.md](../analysis/04-auth-and-security.md) —
  why the token strategy is what it is.
