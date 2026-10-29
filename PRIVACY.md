# Privacy notice

This notice describes what `@ivanbaev/facebook-mcp` reads, where that data goes
and what it leaves on disk. It is written for the **operator**: the person who
installs the server and runs it with their own Meta app, their own token, on their
own Pages and ad accounts.

> **Not legal advice.** This is a factual description of how the software
> handles data, written to help you meet your own obligations. It is not legal
> advice and does not replace advice from a qualified lawyer in your jurisdiction.

## Summary

- The server runs **only on your machine**. There is no hosted component, no
  account with the project, no telemetry, no analytics and no update check.
- The maintainer of this project **receives and processes no data** — not yours,
  and not that of the people who interact with your Page.
- Everything the tools read from Meta is returned to **your MCP client**, and from
  there to **the AI model provider you chose**. That provider is a recipient of
  Meta Platform Data and of personal data of third parties.
- The server keeps a few **local files** (an audit journal, insights exports,
  saved replies, activity marks, the env file). None is deleted automatically by
  age; see [Local files and retention](#local-files-and-retention).

## Roles

| Party                                           | Role                                                                                                                                                                                                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **You, the operator** (Page / ad account admin) | Decide which tools run, what is read, what is sent and what is published. Under the GDPR you are, in general, the **controller** for this processing. For Page Insights, Meta and the Page admin are treated as joint controllers (CJEU C-210/16). |
| **Your AI model provider**                      | Receives every tool result your client forwards to it. Whether it acts as your processor depends on the plan and terms you use with it (see [Your obligations](#your-obligations-as-the-operator)).                                                |
| **Meta**                                        | Source and destination of the data, under the Meta Platform Terms and, for ads, the advertising terms you accepted.                                                                                                                                |
| **The maintainer** (project author)             | Ships software under the MIT licence. Operates no server, receives no data, and is neither controller nor processor of anything the server handles.                                                                                                |

## What the server reads

Only through the Meta Graph API, with the token you configure, and only for the
tool packages you enable (`FB_TOOL_PACKAGES`, `FB_PACKAGES_DENY`):

- **Page content** — your Page's posts, photos, videos, Reels, Stories, albums and
  reaction totals (`reader`, `posts`).
- **Comments and visitor posts** — including user-generated content written by
  other people: their text, display names and IDs (`moderation`).
- **Messenger conversations** — participants' names and Page-scoped IDs (PSIDs),
  message text, and attachment types (shown as placeholders) (`messages`). This
  package is **on by default**; it can contain anything a person chose to write to
  your Page, including sensitive information about them.
- **Custom labels** — labels you attach to people in Messenger (stored at Meta).
- **Insights** — Page, post and Reel metrics; aggregates, normally not personal
  data (`insights`).
- **Ads data** — ad accounts, campaigns, ad sets, ads, budgets, targeting
  (countries and ages), previews, ad insights, and DSA payor/beneficiary values
  (`ads`, **off by default**).
- **Local media files** — only files you point an upload tool at, inside
  `FB_MEDIA_DIR`, which are sent to Meta.

User-generated content is returned inside an "untrusted content" envelope. That
envelope protects the model against prompt injection; it is not a privacy control
and does not reduce what is shared.

## Where the data goes

1. **Meta** — the only network destinations are `graph.facebook.com`,
   `graph-video.facebook.com` and `rupload.facebook.com`. The allowlist is fixed in
   code and cannot be configured.
2. **Your MCP client, and through it your AI model provider** — every tool result
   (including message text, names and PSIDs) is returned to the client on stdio, or
   on a loopback-only HTTP transport (`127.0.0.1`, token required). What the
   provider stores, for how long, and whether it trains on it is governed by your
   agreement with that provider, not by this project.
3. **Local files** — listed below.

Nothing else. The server has no telemetry, analytics, crash reporting or
"phone home" of any kind, and its runtime dependencies are limited to the MCP SDK,
`dotenv` and `zod`.

## Local files and retention

Default locations (POSIX use `$XDG_STATE_HOME` / `$XDG_CONFIG_HOME` when set):

- **State dir:** `~/.local/state/facebook-mcp/` on POSIX;
  `%LOCALAPPDATA%\facebook-mcp\` on Windows.
- **Config dir:** `~/.config/facebook-mcp/` on POSIX; `%APPDATA%\facebook-mcp\`
  on Windows.

| File                                                    | Override env             | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                       | Retention today                                                                                                               |
| ------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `<state>/journal.ndjson` and `<state>/journal.1.ndjson` | `FB_JOURNAL_PATH`        | One JSON line per executed write: timestamp, tool, Page id, outcome, a summary and metadata. Secrets are redacted. Entries **do contain personal data**: recipient PSIDs and conversation ids for Messenger sends and reactions, and the Page name. Messenger message text is not stored (only its length), but summaries quote up to 300 characters of **private-reply text** and of public replies, and excerpts of the Page's own comments. | Size-based only: rotates at ~5 MB, one older generation kept. **No time limit** — on a quiet Page entries can stay for years. |
| `<state>/exports/`                                      | `FB_EXPORT_DIR`          | CSV/JSON insights exports, written only when you pass `output` to an insights tool. Aggregated metrics.                                                                                                                                                                                                                                                                                                                                        | **Never deleted** by the server.                                                                                              |
| `<state>/activity-state.json`                           | `FB_ACTIVITY_STATE_PATH` | Per-Page "last seen" timestamps for `facebook_get_activity_since`. Page ids and timestamps only.                                                                                                                                                                                                                                                                                                                                               | Overwritten in place; never deleted.                                                                                          |
| `<config>/saved-replies.json`                           | —                        | Reply templates you save through the messaging tools, keyed by Page id. Operator-written text.                                                                                                                                                                                                                                                                                                                                                 | Until you delete them (`facebook_delete_saved_reply`) or the file.                                                            |
| `<config>/.env`                                         | —                        | Your credentials (`FB_ACCESS_TOKEN`, `FB_APP_SECRET`, …), written by `setup-token` or by you.                                                                                                                                                                                                                                                                                                                                                  | Until you delete it.                                                                                                          |

Files are created `0600` and directories `0700` on POSIX. On Windows, POSIX modes
do not apply and the parent folder's ACL governs.

**Logs.** The server writes structured JSON logs to **stderr only**, at `info` by
default (`FB_LOG_LEVEL`). Secret values are redacted. Logs are not redacted for
personal data in general; each tool logs an allowlist of fields, which can include
Page, post, comment and conversation ids. Where stderr ends up — and how long it is
kept — is decided by your MCP client (for example, desktop clients often keep
per-server log files).

## Your obligations as the operator

This software cannot meet these for you. As a starting checklist:

- **Tell the people you interact with.** Your Page's own privacy notice should
  cover AI-assisted handling of comments and messages, the AI provider as a
  recipient, and your lawful basis.
- **Follow Meta's terms.** The [Meta Platform Terms](https://developers.facebook.com/terms/)
  and [Developer Policies](https://developers.facebook.com/devpolicy/) apply to all
  Platform Data you read, including the rules on sharing it with service providers
  and on deleting it when no longer needed or when a person asks. Advertising is
  also governed by the ad terms and advertising standards you accepted.
- **Choose an AI provider and plan with suitable terms** — a data processing
  agreement, no training on your inputs, and acceptable data location and
  retention. Commercial API or business plans usually offer this; consumer chat
  plans may not.
- **Minimise inbox reads.** Disable the `messages` package (`FB_PACKAGES_DENY=messages`)
  if you do not need it, and avoid reading whole inboxes into a session when one
  thread will do.
- **Do not record sensitive traits.** Never use labels or notes to record a
  person's health, religion, ethnicity, political opinion or sexuality.
- **Disclose automation where the law requires it.** Meta's Messenger policy and,
  in the EU, the AI Act transparency rules may require telling people that a reply
  was drafted with AI.
- **Answer access and deletion requests**, and **apply your own retention period**
  to the local files above, since the server applies none by age.

## Deleting local data

- **Everything:** stop the server, then delete the state dir and the config dir
  listed above (or the paths you set with `FB_JOURNAL_PATH`, `FB_EXPORT_DIR` and
  `FB_ACTIVITY_STATE_PATH`). Also remove credentials from any client config or
  shell profile, and clear your MCP client's logs and chat history if they hold
  tool results. See the [offboarding runbook](docs/runbooks/offboarding.md) for the
  full teardown, including revoking access on Meta's side.
- **One person's data (a deletion request):** find the person's PSID from the
  conversation; delete the journal lines that contain it from `journal.ndjson`
  and `journal.1.ndjson` (one JSON object per line, so a `grep -v <PSID>` into a
  new file works while the server is stopped); remove any labels you assigned to
  them; delete chat histories with your AI provider that contain their data. Data
  held by Meta (the conversation itself, comments) is managed in Meta's own tools.
- **Old journal entries:** stop the server and delete or trim `journal.1.ndjson`
  and `journal.ndjson`. The server starts a fresh file on the next write.

## Contact

Questions about this notice or the software's data handling: open an issue at
[github.com/IvanBBaev/facebook-mcp/issues](https://github.com/IvanBBaev/facebook-mcp/issues).
Security vulnerabilities go through the private channel in [SECURITY.md](SECURITY.md).
The maintainer holds no data about you or your Page visitors, so requests about
such data must go to the operator of the Page you interacted with.
