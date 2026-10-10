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

## First live run

Three steps, in this order. The first two touch nothing real; only the third does.

```sh
npm run build                         # the harness drives build/index.js
npm run smoke:plan                    # 1. offline: validate the env, see what the run will do
npm run smoke:rehearse                # 2. offline: the real run.mjs against a fake Graph
FB_SMOKE=1 npm run smoke              # 3. live: the real Graph API, the real test Page
```

1. **`smoke:plan`** checks your environment and prints the run before it happens —
   see [Planning a run](#planning-a-run-offline). Fix every problem it lists; it exits
   `0` only when the live run would start. Pass the same selection flags you intend
   to use live (`npm run smoke:plan -- --include-budget`), since what is required
   depends on what is selected.
2. **`smoke:rehearse`** proves the harness plumbing end to end against a loopback
   fake — see [Offline rehearsal](#offline-rehearsal).
3. **The live run.** Read the plan's "Left on the real Page" section first: anything
   listed there is still on the test Page when the run ends.

## Running

```sh
FB_SMOKE=1 npm run smoke                      # every non-budget smoke
FB_SMOKE=1 npm run smoke -- --list            # what exists (no gate needed)
npm run smoke:plan                            # validate + describe the run (no gate needed)
FB_SMOKE=1 npm run smoke -- --phase 1         # one roadmap phase
FB_SMOKE=1 npm run smoke -- --only reader/timeline
FB_SMOKE=1 npm run smoke -- --sweep-only      # just clean the test Page
FB_SMOKE=1 npm run smoke -- --include-budget  # also run quota-consuming smokes
```

`--help` lists every flag. `--list`, `--plan` and `--help` work without the gate
because they make no network call and spawn nothing.

### Planning a run (offline)

```sh
npm run smoke:plan                                    # the default selection
npm run smoke:plan -- --include-budget                # with the quota-consuming smokes
npm run smoke:plan -- --only reels/create-and-status  # exactly one smoke
```

`smoke:plan` is `run.mjs --plan` (`plan.mjs`). It loads the registry, then — with no
network call and no server — prints:

- **Configuration**: which credential, read Page and test Page the run would use.
  Tokens are only ever shown as `set (hidden)`.
- **Every smoke**, as `RUN`, `SKIP` (not named by `--only`, phase not selected, budget
  opt-in not given, `--sweep-only`) or `BLOCKED` (selected, but a variable in its
  `requires` is missing), and for every writing smoke what it **creates** on the real
  test Page, how it **cleans up**, and what it deliberately **leaves** behind. These
  lines come from the `effects` each smoke declares at registration, not from a
  separate table.
- **Sweep**: whether the start and end sweeps run (`--keep`, `--sweep-only`), and the
  registered sweepers.
- **Left on the real Page after this run**: the sum of every selected smoke's `leaves`
  (plus everything it creates, under `--keep`). For example `reels/create-and-status`
  leaves its DRAFT Reel: there is no Reel delete tool and no sweeper collects Reels.
- **Problems**: every reason the live run would refuse, all at once. Besides what the
  run itself checks (credential, test/read Page, token paths, `requires`), the plan
  also checks shapes the run would only discover later:
  - numeric `FB_SMOKE_PAGE_ID` / `FB_SMOKE_TEST_PAGE_ID` / `FB_PAGE_ID`;
  - tokens without a `Bearer ` prefix, quotes, whitespace or a `<placeholder>`, and no
    token reused across the test Page and another Page;
  - `FB_CONFIRM_TOKEN` of at least 16 characters (the server ignores a shorter one, so
    every cleanup delete would be denied);
  - `FB_AD_ACCOUNT_ID` as `act_<digits>` or bare digits;
  - `FB_SMOKE_PHOTO_URL` as an `https://` URL;
  - `FB_MEDIA_DIR` as an existing directory, and `FB_SMOKE_REEL_PATH` as a non-empty
    `.mp4`/`.mov` that resolves inside it;
  - any `FB_SMOKE*` name the harness does not read, with the closest one it does
    (`FB_SMOKE_TEST_PAGEID` → `FB_SMOKE_TEST_PAGE_ID`);
  - the rehearsal switches (`FB_SMOKE_REHEARSAL_*`) left set in a live shell, a gate
    set to anything but `1`, and operator-set `FB_PROFILE_SMOKETEST_*` /
    `FB_PROFILE_SMOKEREAD_*` (the harness owns those profiles);
  - a missing `build/index.js`.

  A malformed value that only an unselected smoke reads is a warning, not a problem.

Exit status: `0` when the plan is runnable, `2` (the refusal status) when it is not.

### Exit status

| Code | Meaning                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| `0`  | every selected smoke passed and the test Page was left clean                                                                 |
| `1`  | a smoke failed, **or** the sweep could not delete a marked artifact                                                          |
| `2`  | refused to run: gate off, incomplete/unsafe environment, unknown smoke id, or the server is not built. Nothing was executed. |

Under `--plan` the same codes mean: `0` the plan is runnable, `2` it is not.

A refusal is deliberately non-zero: a misconfigured job must never report a green run
for a gate that never opened.

A fourth outcome sits inside exit `0`: **not exercised**. A smoke that finds no data
of the shape it needs — an empty inbox, a Page with no published post, a metric with
too few data points to trip the row cap — calls `ctx.notExercised(reason)` instead of
returning quietly. It still exits `0`, because an idle Page is a fact about the Page
and not a defect in the server, but the reason is printed as it happens, listed again
in the summary, counted next to `passed`, and the final line reads
`result PASS — N smoke(s) NOT EXERCISED` rather than a bare `PASS`. Treat that as
"this run is not evidence for what those smokes cover", and give the test Page the
material they need before believing them.

### Offline rehearsal

```sh
npm run build && npm run smoke:rehearse       # no credentials, no network
npm run smoke:rehearse -- --only reels/lifecycle-probe
```

`rehearse.mjs` runs the real `run.mjs` — every smoke, budget ones and the lifecycle
probe included, plus both sweeps — against a loopback fake Graph
(`rehearsal/fake-graph.mjs`, fixture-shaped answers, every request recorded) with
fake `FB_SMOKE_*` values and throwaway config/state directories. The seam is a
preload (`rehearsal/fetch-redirect.mjs`, loaded via `NODE_OPTIONS` into the harness
and the server child) that rewrites `graph`, `graph-video` and `rupload.facebook.com`
onto the fake and refuses every other destination. It is active only when
`FB_SMOKE_REHEARSAL_PRELOAD=1` and `FB_SMOKE_REHEARSAL_GRAPH` is a loopback origin;
inside that same gate the smokes' eventual-consistency waits collapse to zero
(`pace.mjs`). A route the fake does not model fails the rehearsal even when
`run.mjs` exits `0`. `src/smoke-rehearsal.test.ts` runs it in `npm test`.

A green rehearsal proves the harness's plumbing, not anything about the real Graph.

## Environment

| Variable                   | Required                                                  | What it does                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FB_SMOKE`                 | always                                                    | Must be exactly `1`. Anything else ⇒ refuse, exit 2, no network call.                                                                                                                                                                                                                                                                                |
| `FB_SYSTEM_TOKEN`          | preferred credential                                      | System-user token; the server derives Page tokens from it.                                                                                                                                                                                                                                                                                           |
| `FB_ACCESS_TOKEN`          | alternative                                               | User token. Used when no system token is set.                                                                                                                                                                                                                                                                                                        |
| `FB_SMOKE_PAGE_ID`         | for read smokes                                           | The Page read-only smokes read. Falls back to `FB_PAGE_ID`.                                                                                                                                                                                                                                                                                          |
| `FB_SMOKE_TEST_PAGE_ID`    | for write smokes + the sweep                              | The dedicated **test** Page. **No fallback** — unset ⇒ writes refuse.                                                                                                                                                                                                                                                                                |
| `FB_SMOKE_PAGE_TOKEN`      | optional                                                  | Explicit Page token for the read Page (skips derivation).                                                                                                                                                                                                                                                                                            |
| `FB_SMOKE_TEST_PAGE_TOKEN` | optional                                                  | Explicit Page token for the test Page (skips derivation).                                                                                                                                                                                                                                                                                            |
| `FB_CONFIRM_TOKEN`         | for every write smoke                                     | The operator approval an `irreversible` apply demands. Every write smoke declares it — the three `posts/*` ones, `moderation/reply-and-delete` and `reels/lifecycle-probe` — because each deletes what it created. Unset ⇒ those smokes **refuse** (exit 2) rather than create artifacts they could never remove. See [Confirmation](#confirmation). |
| `FB_SMOKE_PHOTO_URL`       | for `posts/photo`                                         | A public `https://` image URL Meta fetches itself — the repo ships none, and baking in someone else's CDN link would make the smoke fail for reasons unrelated to this server. `posts/photo` is in the DEFAULT selection, so **an unset value refuses the plain `npm run smoke`** (exit 2, nothing executed).                                        |
| `FB_SMOKE_REEL_PATH`       | for `reels/create-and-status` and `reels/lifecycle-probe` | Path to a real MP4/MOV the Reels upload streams. Budget-gated, so it only bites under `--include-budget` / `--only`. Must resolve **inside** `FB_MEDIA_DIR`.                                                                                                                                                                                         |
| `FB_MEDIA_DIR`             | for `reels/create-and-status` and `reels/lifecycle-probe` | The server's local-media root. Local file access is **off by default** (C11): unset ⇒ the server is URL-only, and the Reels protocol has no "fetch this URL" mode, so `FB_SMOKE_REEL_PATH` alone is not enough. Inherited by the child verbatim; paths are confined by realpath containment.                                                         |
| `FB_AD_ACCOUNT_ID`         | for the `ads/*` live smokes                               | The ad account `ads/read-surface` and `ads/hierarchy` read, and the default for any tool call that omits `ad_account_id`. Written as `act_<digits>` or as the bare digits — the tools normalise it and echo back the `act_` form. Budget-gated, so it only bites under `--include-budget` / `--only`.                                                |

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

## The G-TOOL-3 Reels lifecycle probe (`reels/lifecycle-probe`)

A budget-gated, run-it-once smoke that answers the two live questions G-TOOL-3 (doc 10)
leaves open:

1. Can `DELETE /{video-id}` delete a Reel, and does `facebook_delete_post` do it — given
   a bare video id, and given a `{page-id}_{post-id}` composite?
2. Where does a **SCHEDULED** Reel appear: `/scheduled_posts`
   (`facebook_list_scheduled_posts`), `/video_reels` (`facebook_list_reels`), both, or
   neither? (Where the DRAFT Reel appears is reported too.)

Through the MCP path it creates, on the **test Page** only and marked with the run
marker, one `DRAFT` Reel and one `SCHEDULED` Reel ~28 days out; observes their processing
state; scans both listings through MCP (a few bounded retries, since listings lag); runs
`facebook_delete_post` with the draft's bare video id and with the scheduled Reel's post
composite; and judges every deletion by an independent re-read of the video.

It costs **two** of the test Page's 30 API Reels per rolling 24 h, so it only runs when
named:

```sh
npm run build
# FB_SYSTEM_TOKEN may be replaced by FB_SMOKE_TEST_PAGE_TOKEN or FB_ACCESS_TOKEN
FB_SMOKE=1 \
FB_SMOKE_TEST_PAGE_ID=<test page id> \
FB_SYSTEM_TOKEN=<system token> \
FB_MEDIA_DIR=/path/to/media \
FB_SMOKE_REEL_PATH=/path/to/media/probe.mp4 \
FB_CONFIRM_TOKEN=<the value the server is configured with> \
npm run smoke -- --only reels/lifecycle-probe --timeout 900000
```

`--timeout 900000` (15 min) is recommended: two uploads, a processing wait, the listing
retries and the delete re-reads do not fit the 180 s default reliably. `FB_CONFIRM_TOKEN`
is **required** (unset ⇒ refused up front): `facebook_delete_post` is irreversible-tier,
and without it the deletion question cannot be asked.

It always prints one machine-readable line, even after a failure:

```text
G-TOOL-3 verdict: delete-by-video-id=yes; delete_post-video-id=error(100); delete_post-composite=no; scheduled-reel-in=video_reels; draft-reel-in=neither
```

| Field                   | Meaning                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `delete-by-video-id`    | Graph capability: did `DELETE /{video-id}` remove the draft (via the tool, else raw)?                        |
| `delete_post-video-id`  | Did `facebook_delete_post` with the bare video id remove the draft?                                          |
| `delete_post-composite` | Did `facebook_delete_post` with `{page-id}_{post-id}` (or `{page-id}_{video-id}`) remove the scheduled Reel? |
| `scheduled-reel-in`     | `scheduled_posts` \| `video_reels` \| `both` \| `neither` for the SCHEDULED Reel                             |
| `draft-reel-in`         | The same for the DRAFT Reel                                                                                  |

Deletion values are `yes` \| `no` (the call claimed success, the video is still there) \|
`error(<code>[/<subcode>])` (the call failed and the video is still there) \|
`unknown(<code>)` (the re-read itself failed) \| `not-run`. A listing that errored reads
`error(<edge>:<code>)`. `neither` is the result of a bounded scan (4 pages × 25 items, 4
attempts), not an exhaustive one.

### The harness-only Graph escape hatch

The re-read and the cleanup do **not** go through MCP; they use `graph-escape.mjs`, the
only raw Graph client in the harness. Two reasons: `facebook_delete_post` may answer
`alreadyAbsent` for an id its own pre-read could not load, so only an independent
`GET /{video-id}` can say a Reel is gone; and the server ships no Reel delete tool, while
cleanup must still work after a run timeout has closed the MCP session. It is confined:

- it only ever holds the **test Page's** token — `FB_SMOKE_TEST_PAGE_TOKEN`, or one derived
  for exactly `FB_SMOKE_TEST_PAGE_ID` from `FB_SYSTEM_TOKEN` / `FB_ACCESS_TOKEN` (refused
  unless Graph echoes the same Page id back). `FB_PAGE_TOKEN` is never read;
- it can `GET` and `DELETE` bare video ids **this run created** and nothing else, and it
  refuses a `DELETE` when Graph reports the video's owner as another Page;
- the token travels in the `Authorization` header, never in a URL or a log line
  (`appsecret_proof` is added when `FB_APP_SECRET` is set); `FB_API_VERSION` is honoured.

No other smoke may import it.

### Cleanup and leaks

Cleanup runs in `finally` for every Reel the probe created (including an id a failed
upload reserved), after success, a thrown step, Ctrl-C or the run timeout, and does not
depend on the MCP session. A Reel that survives is printed as

```text
COULD NOT DELETE SCHEDULED reel <video-id> (<nonce>) on test Page <id>: <reason>. Delete it by hand — …
```

with the time a scheduled one would publish, and the smoke fails (exit `1`). Delete it
from Meta Business Suite (test Page → Content → Reels / Drafts / Scheduled), or with
`DELETE /{video-id}` and the test Page token. The regular sweep does **not** collect Reels.

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
  effects: {
    // required — 'none' for a smoke that creates nothing; printed by --plan
    creates: ['1 published text post carrying the run marker'],
    cleansUp: ['deletes the post with facebook_delete_post'],
    leaves: [], // what the operator must remove by hand
  },
  run: async (ctx) => {
    const { applied } = await ctx.applyWrite('facebook_create_post', {
      message: ctx.mark('smoke: hello'),
    });
    ctx.assert(applied.result?.postId !== undefined, 'no post id came back');
  },
});
```

`writes: true` with any `page` other than `'test'` is a hard registration error.

`effects` is required and must agree with `writes`: `'none'` exactly when
`writes: false`; otherwise all three arrays, a non-empty `creates`, and at least one
entry in `cleansUp` or `leaves`. One line per entry, phrased for the operator reading
`npm run smoke:plan` — it is the only place the plan learns what your smoke does to the
real Page.

Never early-return on missing material. If the live Page holds nothing to assert
against, say so with `ctx.notExercised('<the contract that did not run>')` first —
name the behaviour that went unverified, not merely the data that was absent. It does
not throw, so a smoke that proved five of its six behaviours records only the sixth
and keeps the five.

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
| `ctx.notExercised(reason)`         | record that a part of this smoke's contract could not run against this Page — does not throw  |
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
