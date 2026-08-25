# Live smoke harness

These are **not tests.** `npm test` runs hermetic unit tests over `build/**/*.test.js`
with no network and no credentials. This directory contains the opposite: a small
runner that drives the **shipped** server against the **real** Graph API with **real**
credentials, and creates real artifacts on a real Page.

It therefore lives outside everything automatic:

- plain `.mjs`, outside `tsconfig`'s `rootDir` — never compiled into `build/`;
- outside the test glob — `npm test` cannot pick it up;
- refuses to run unless `FB_SMOKE=1` — CI never runs it and never holds a token (C13).

## Prerequisites

```sh
npm run build            # the harness drives build/index.js, not src/
```

## Running

```sh
FB_SMOKE=1 npm run smoke                      # every non-budget smoke
FB_SMOKE=1 npm run smoke -- --list            # what exists (no gate needed)
FB_SMOKE=1 npm run smoke -- --phase 1         # one roadmap phase
FB_SMOKE=1 npm run smoke -- --only reader/timeline
FB_SMOKE=1 npm run smoke -- --sweep-only      # just clean the test Page
FB_SMOKE=1 npm run smoke -- --include-budget  # also run quota-consuming smokes
```

`--help` lists every flag. `--list` and `--help` work without the gate because they
make no network call and spawn nothing.

### Exit status

| Code | Meaning                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| `0`  | every selected smoke passed and the test Page was left clean                                                                 |
| `1`  | a smoke failed, **or** the sweep could not delete a marked artifact                                                          |
| `2`  | refused to run: gate off, incomplete/unsafe environment, unknown smoke id, or the server is not built. Nothing was executed. |

A refusal is deliberately non-zero: a misconfigured job must never report a green run
for a gate that never opened.

## Environment

| Variable                   | Required                     | What it does                                                          |
| -------------------------- | ---------------------------- | --------------------------------------------------------------------- |
| `FB_SMOKE`                 | always                       | Must be exactly `1`. Anything else ⇒ refuse, exit 2, no network call. |
| `FB_SYSTEM_TOKEN`          | preferred credential         | System-user token; the server derives Page tokens from it.            |
| `FB_ACCESS_TOKEN`          | alternative                  | User token. Used when no system token is set.                         |
| `FB_SMOKE_PAGE_ID`         | for read smokes              | The Page read-only smokes read. Falls back to `FB_PAGE_ID`.           |
| `FB_SMOKE_TEST_PAGE_ID`    | for write smokes + the sweep | The dedicated **test** Page. **No fallback** — unset ⇒ writes refuse. |
| `FB_SMOKE_PAGE_TOKEN`      | optional                     | Explicit Page token for the read Page (skips derivation).             |
| `FB_SMOKE_TEST_PAGE_TOKEN` | optional                     | Explicit Page token for the test Page (skips derivation).             |

Everything else in your environment (API version, HTTP tuning, app id/secret) is
inherited by the spawned server unchanged. The runner forces only:

- `FB_TRANSPORT=stdio`,
- `FB_WRITE_MODE=plan` — so nothing can mutate except through a preview the harness
  itself inspected,
- `FB_TOOL_PACKAGES` — only the packages the selected smokes declared,
- `FB_PROFILE_SMOKETEST_PAGE_ID` / `FB_PROFILE_SMOKEREAD_PAGE_ID` (+ `_TOKEN` when
  given) — the two Pages, as named profiles `smoketest` and `smokeread`. A raw Page
  ID only resolves when it is already configured, and a named key is the only
  unambiguous way to address a Page.

Note that `FB_PAGE_TOKEN` covers **only** the default Page (`FB_PAGE_ID`). If that is
your only credential, set `FB_SMOKE_TEST_PAGE_TOKEN` / `FB_SMOKE_PAGE_TOKEN`
explicitly — the harness refuses up front rather than failing mid-run.

## What it creates, and what it deletes

Every artifact a smoke creates carries a visible run marker:

```text
[FBMCP-SMOKE 20260802t2215z-a1b2c3]
```

The sweep runs **twice** per run and deletes every marked artifact it can find on the
test Page — including markers from _other_ runs, which is how a crashed run gets
cleaned up:

- **start sweep**, before the first smoke — clears leftovers from an earlier run that
  crashed, was killed, or lost its network;
- **end sweep**, in a `finally` — after success, after a thrown smoke, after a
  timeout, and after Ctrl-C.

Anything the sweep could **not** delete is reported line by line with its id and the
reason, and the run exits `1`. It is never swallowed and never reported as clean.

`--keep` skips the end sweep for debugging; the next run's start sweep collects the
leftovers.

## Safety rules the runner enforces for you

1. **Writes only ever reach the test Page.** `ctx.applyWrite` forces the `smoketest`
   profile, runs a dry run first, and refuses to apply unless the preview reports
   `pageId === FB_SMOKE_TEST_PAGE_ID`. There is no fallback to a default Page.
2. **The test Page and the read Page must differ.** Same id ⇒ refuse to start.
3. **Nothing unmarked gets created.** `applyWrite` rejects a creating call whose
   arguments do not contain this run's marker (pass `{ marker: 'none' }` only when the
   call merely references an existing object, e.g. a delete).
4. **Budget-consuming smokes are opt-in.** A smoke that declares `budget: 'reels'` or
   `budget: 'ads'` consumes a finite live quota (the 30-Reels/24 h cap, real ad spend).
   It never runs in the default selection, is labelled `BUDGET:` in `--list`, and runs
   only under `--include-budget` or when named explicitly with `--only`.
5. **No secrets in output.** Everything printed goes through a scrubber that removes
   the literal values of token-bearing environment variables plus `access_token=`
   query parameters and bearer strings. The server's stderr is captured, not streamed,
   and printed (scrubbed, tail only) only when something fails — or continuously under
   `--verbose`.

## Adding a smoke (for a vertical owner)

Drop one file into `scripts/smoke/smokes/`, named `<vertical>.smoke.mjs`. It is
discovered automatically — **the runner never needs to be edited.**

```js
import { registerSmoke } from '../registry.mjs';

registerSmoke({
  id: 'posts/publish-and-delete', // required, unique, "<vertical>/<name>", lowercase
  phase: 2, // required, 0–5 — the roadmap phase gate
  title: 'Publish a marked post, read it back, delete it', // required, one line
  page: 'test', // 'none' | 'read' | 'test'  (default: writes ? 'test' : 'read')
  writes: true, // creates or changes remote state? (default false)
  budget: null, // null | 'reels' | 'ads' — non-null ⇒ opt-in only
  packages: ['posts', 'reader'], // FB_TOOL_PACKAGES the server must load
  requires: [], // extra env var names that must be set
  run: async (ctx) => {
    const { applied } = await ctx.applyWrite('facebook_create_post', {
      message: ctx.mark('smoke: hello'),
    });
    ctx.assert(applied.result?.postId !== undefined, 'no post id came back');
  },
});
```

`writes: true` with any `page` other than `'test'` is a hard registration error.

### The `ctx` a smoke receives

| Field                              | What it is                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `ctx.nonce` / `ctx.marker`         | this run's nonce and the full `[FBMCP-SMOKE …]` string                                        |
| `ctx.mark(text)`                   | `text` with the marker appended — put it in every human-visible field                         |
| `ctx.profile`                      | the profile key this smoke should address (`smoketest` / `smokeread` / `undefined`)           |
| `ctx.pages`                        | `{ testProfile, testPageId, readProfile, readPageId }`                                        |
| `ctx.callTool(name, args)`         | call a tool, get the parsed JSON payload; a tool error throws `SmokeToolError` (with `.code`) |
| `ctx.callToolRaw(name, args)`      | `{ result, payload, isError }` — for asserting on an expected failure                         |
| `ctx.applyWrite(name, args, opts)` | the guarded dry-run → verify → apply handshake (see below)                                    |
| `ctx.listTools()`                  | raw `tools/list`                                                                              |
| `ctx.unwrap(value)`                | unwrap the taint envelope (`{__tainted, source, content, warning}`)                           |
| `ctx.assert(condition, message)`   | fail the smoke with a readable message                                                        |
| `ctx.log`                          | `step` / `info` / `warn` — scrubbed terminal output                                           |
| `ctx.signal`                       | aborted on timeout or Ctrl-C                                                                  |

`ctx.applyWrite(tool, args)` returns `{ preview, applied }`. Do **not** pass `apply` or
`plan_id` yourself — it owns that handshake, because the verification between the two
calls is the safety property.

## Adding a sweeper

If your vertical can leave anything behind, add `scripts/smoke/sweepers/<vertical>.sweep.mjs`:

```js
import { registerSweeper } from '../registry.mjs';

registerSweeper({
  id: 'ads',
  title: 'Marked paused campaigns on the test ad account',
  packages: ['ads'],
  sweep: async (ctx) => [
    { kind: 'campaign', id: '123', nonce: '…', deleted: true },
    {
      kind: 'campaign',
      id: '456',
      nonce: '…',
      deleted: false,
      reason: 'delete returned 400',
    },
  ],
});
```

Rules for a sweeper:

- find artifacts by **marker**, never by a list the smoke kept in memory;
- delete leftovers from **any** run, not just the current nonce;
- **never throw** for an artifact you could not delete — return it with
  `deleted: false` and a `reason`, so the run can report the leak precisely;
- respect `ctx.deleteCap`.

See `sweepers/posts.sweep.mjs` for the reference implementation.

## Confirmation

Deleting a post or a comment is an `irreversible`-tier write, so the write gate asks
the server's `Confirmer` for out-of-band confirmation before applying. The server
offers two routes: an MCP elicitation prompt, or the `FB_CONFIRM_TOKEN` operator token
passed as the tool's `confirm_token` argument. The smoke client does not advertise the
`elicitation` capability — a headless harness has no human to prompt — so it takes the
token route:

```bash
FB_SMOKE=1 FB_CONFIRM_TOKEN=<the value the server is configured with> npm run smoke
```

`applyWrite` reads that value out of the child environment and attaches it as
`confirm_token`, but **only** when the preview reports `tier: "irreversible"`. The
harness never mints a token of its own — it forwards one a human deliberately set, so
the gate keeps its human-in-the-loop property.

`spend` tier is deliberately excluded from that branch. No amount of harness
configuration may auto-approve a write that moves money; that is also why the ads
smokes are read-only.

**Without the token** the run is still useful — every reversible write is exercised
end to end — but nothing it creates can be deleted through the MCP path. The preflight
warns about this up front, each irreversible apply comes back as
`code: "confirmation_denied"`, the sweepers report those artifacts as leaks (with that
code and an instruction to delete them by hand), and the run exits `1`.
