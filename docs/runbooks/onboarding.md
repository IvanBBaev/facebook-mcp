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

The file holds at most five keys — `FB_APP_ID`, `FB_APP_SECRET`,
`FB_ACCESS_TOKEN` (or `FB_SYSTEM_TOKEN`), `FB_PAGE_ID` and `FB_PAGE_TOKEN` — and
only the ones the run could actually resolve. The app secret and both tokens are
in it in clear text, so treat it as a secret; the parent directory is created
`0700` when it does not already exist.

Real environment variables always win over that file, so an MCP client that
injects `FB_*` in its own config overrides it.

---

## Step 1 — Create the Meta app (≈5 min)

1. Go to <https://developers.facebook.com/apps> → **Create app**.
2. Pick the **Business** app type. Consumer apps cannot hold the Page scopes.
3. From the app dashboard, note the **App ID** and **App Secret**
   (Settings → Basic). The running server treats both as optional, but Step 4
   does not: the long-lived exchange is a server-side call that needs the pair,
   and without it `setup-token` stops at `exchange` and writes nothing. Set them
   for the runtime benefit as well — with `FB_APP_ID` + `FB_APP_SECRET` every
   call carries `appsecret_proof`, so a stolen bare token cannot be replayed on
   its own.
4. Add the **Facebook Login for Business** product if the Graph API Explorer does
   not already offer your app in its dropdown.

**Verify by…** the app appears in the Graph API Explorer's *Meta App* dropdown.

---

## Step 2 — Choose your scopes

Grant only what the packages you actually enable need. `setup-token` refuses
only when a **setup-blocking** scope is missing; a missing package scope is a
warning naming the exact scope and the exact package, because the install still
works with a smaller tool surface.

| Scope                     | Required by package              | Blocking? |
| ------------------------- | -------------------------------- | --------- |
| `pages_show_list`         | `core` — Page discovery, token derivation | **yes** — without it `/me/accounts` returns nothing and no Page token can be derived |
| `pages_read_engagement`   | `core`, `reader`, `posts`        | no        |
| `pages_read_user_content` | `reader`, `moderation`           | no        |
| `pages_manage_posts`      | `posts`                          | no        |
| `pages_manage_engagement` | `moderation` (hide/delete/reply) | no        |
| `pages_messaging`         | `messages`                       | no        |
| `pages_manage_metadata`   | `messages` (conversation listing) | no       |
| `read_insights`           | `insights`                       | no        |
| `ads_read`                | `ads` reads                      | no        |
| `ads_management`          | `ads` writes                     | no        |

`business_management` is deliberately **not** on that list: no package asks for
it, so neither `setup-token` nor `doctor` will ever mention it. It is a
Business-Settings permission you exercise in Step 6 to assign assets to a system
user, and it has no business riding on the runtime token.

The warnings cross-reference the packages *this install will run* — whatever
`FB_TOOL_PACKAGES` names at the moment you run `setup-token`, or the default
profile (everything except `ads`) when it is unset. So tick `ads_read` /
`ads_management` now if you plan to enable `ads` later; nothing will warn you
about them while the package is unselected.

The README's generated **Permissions you need to grant** table is the
machine-checked version of this list — it is derived from the same source the
doctor uses, so trust it over any prose that has drifted.

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
FB_SETUP_TOKEN='<paste>' npx @ivanbaev/facebook-mcp setup-token
```

From a source checkout:

```sh
npm run build
FB_SETUP_TOKEN='<paste>' node build/index.js setup-token
```

What it does, in order — these are the five step ids the report prints:

1. **input** — takes the token from `FB_SETUP_TOKEN`, or from a positional
   argument if you insisted. No token at all fails here, before any Graph call.
2. **classify** — `/debug_token`: type, app id, granted scopes, expiry. Refuses
   early, with the exact missing scope named, if the token cannot do the job.
3. **exchange** — `grant_type=fb_exchange_token` for a long-lived token
   (**~60 days**, not forever — see Step 6). *Skipped*, not failed, when Graph
   classifies the token as `SYSTEM_USER`: it is already the long-lived
   credential and is written verbatim as `FB_SYSTEM_TOKEN`.
4. **pages** — `/me/accounts` lists the Pages you administer and resolves the
   Page token for the one you selected. It reads **one page of at most 100
   results** and never follows `paging.next`, so with more Pages than that only
   the first window is considered — and the report says so rather than claiming
   a Page outside it does not exist.
5. **write** — writes the env file atomically at `0600` and prints **which keys**
   it wrote. Token values are never printed, logged, or echoed.

Useful flags:

| Flag                | Effect                                                          |
| ------------------- | --------------------------------------------------------------- |
| `--page=<id>`       | Pick the Page explicitly. Omit it and a *unique* Page — unique within the window the `pages` step listed — is auto-selected. Several Pages and no flag pins **none**: the server refuses to guess which Page you meant, and warns instead of failing. An id it cannot see *is* a failure, and the report lists the ids it can. |
| `--no-write` / `--dry-run` | Run everything and report what *would* be written. Nothing touches disk. |
| `--force`           | Overwrite an existing env file. The file is **replaced, never merged** — anything you hand-added to it is lost. |
| `--env-file=<path>` | Write somewhere else (useful for a per-project file).            |

The `=` is not optional. Flags are matched whole, so `--page 111` is read as an
unknown option (ignored, with a warning naming the option) *plus* a positional
token — and the run then tries to classify `111` as your access token. Every
argument that does not start with `-` is taken as the token.

Exit codes: `0` when no step failed, `2` when one did — the report names the step
and what to do about it. `1` is reserved for a process that could not produce a
report at all. Warnings never change the exit code: several Pages and no
`--page` still exits `0`, with an env file that has no Page pinned.

**Verify by…** the report's **Run** block says `status: completed` (the failure
word is `INCOMPLETE`) and its **Env file** block says `status: written`. The
`Next step:` line at the bottom is printed on every run, successful or not, so it
is not on its own a sign that anything worked.

---

## Step 5 — Confirm with `doctor`

```sh
npx @ivanbaev/facebook-mcp doctor
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
   `FB_PAGE_TOKEN`. You can also feed it back through Step 4 —
   `setup-token` recognises a `SYSTEM_USER` token, skips the exchange, writes it
   under `FB_SYSTEM_TOKEN` and re-pins the Page. That run needs `--force`,
   because the env file from Step 4 is already there.

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
| `input` failed, "no short-lived token supplied"                | `FB_SETUP_TOKEN` was unset or blank and no token argument was given.      | Redo Step 3 and pass the token through the env var. Nothing was called and nothing was written. |
| `classify` failed, "token is not valid"                        | The Explorer token already expired (1–2 hours).                          | Generate a fresh one and rerun Step 4.                                       |
| `classify` failed, `pages_show_list` missing                   | The scope was not ticked in the Explorer.                                 | Re-tick it, regenerate, rerun. This one is genuinely blocking.               |
| `classify` failed, "this is already a Page token"              | You copied a Page token, not a User token.                                | Switch the Explorer dropdown to **User Token**. (A Page token needs no exchange at all — set `FB_PAGE_TOKEN` and `FB_PAGE_ID` by hand and run `doctor`.) |
| `exchange` failed, "cannot exchange without app credentials"   | `FB_APP_ID` / `FB_APP_SECRET` are not set.                                | Set both from Settings → Basic and rerun. Nothing was written — an unexchanged Explorer token would be dead within the hour. |
| `pages` OK, "0 Page(s) found; none selected"                   | The token holder has no role on any Page; or, for a System-User token, the Page is not assigned to it as an asset; or the token was generated for a different app than the one the Page runs through. `pages_show_list` is *not* the cause — `classify` already verified it. | Not a failure: the run exits `0` and the env file holds the runtime token, without `FB_PAGE_ID` / `FB_PAGE_TOKEN`. Fix the role or the asset assignment, then rerun with `--force`. |
| `pages` OK, "N Page(s) found; none selected"                   | More than one Page and no `--page=<id>`. The server refuses to guess which Page you meant. | Also not a failure: exit `0`, env file written with no Page pinned, and a warning saying so. Rerun with **both** `--page=<id>` and `--force` — the file this run just wrote is itself the "already exists" that would block the second run. |
| `pages` failed, "Page … is not among the Pages this token can see" | The `--page=<id>` you gave is not in the listing.                     | Use one of the ids the failure detail lists. If the summary instead says *first 100 Pages … Graph reported more*, your Page is outside the single window this flow reads: pin it by hand with `FB_PAGE_ID` / `FB_PAGE_TOKEN`. |
| `write` failed, "env file already exists"                      | An env file is already there and `--force` was not given.                 | Rerun with `--force` — but note it **replaces** the file, it does not merge. This is a failed step, so the run exits `2`. |
| Everything green, but the client shows no tools                | The client injects its own env, or is running a different binary.         | Run `doctor` through the *same* command the client uses.                     |
| Writes are refused at runtime                                  | `FB_WRITE_MODE` is `plan` (the default for `posts` / `messages` / `ads`). | That is intended. Preview first, then re-call with `apply` and the returned `plan_id`. |
| Ads tools missing entirely                                     | The `ads` package is off by default.                                      | Add `ads` to `FB_TOOL_PACKAGES` and set `FB_AD_ACCOUNT_ID`.                  |

## Related

- [credential-rotation.md](credential-rotation.md) — rotating or revoking a token.
- [kill-switch.md](kill-switch.md) — halting all write activity immediately.
- [offboarding.md](offboarding.md) — clean uninstall and local-state deletion.
- [../analysis/04-auth-and-security.md](../analysis/04-auth-and-security.md) —
  why the token strategy is what it is.
