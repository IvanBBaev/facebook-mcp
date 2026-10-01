# Onboarding trial — does a stranger reach a tool call in 20 minutes?

**When to use this.** Before a release that touches the README, `setup-token`,
`doctor` or the client configuration, and at least once before 1.0. The author
cannot test onboarding: they already know every step the docs leave out. This
protocol has **someone who has never used `facebook-mcp`** follow the public
docs while an observer times them and says nothing.

**Pass criterion:** the tester reaches the **first successful tool call** —
`facebook_whoami` returning `valid: true` inside their MCP client — within
**20 minutes** of opening the README, with **no help** from the observer.

---

## Roles

- **Tester** — a developer comfortable with a terminal and Node, who has
  **never** installed or read the code of this server. Someone who has seen a
  previous trial is not a new tester.
- **Observer** — runs the clock, takes notes, and stays silent. May be the
  author, but only if they can keep quiet; a second person is better.

Run one trial per client you want to claim: Claude Code and Claude Desktop are
separate trials with separate clocks.

---

## What the tester gets

1. A machine with Node.js ≥ 22, a terminal, and the MCP client under test
   installed and signed in (Claude Code, or Claude Desktop). Installing the
   client is not part of the trial.
2. A Facebook account that is an **admin of a test Page** (create a throwaway
   Page beforehand — never a production Page).
3. That account's access to <https://developers.facebook.com>, already
   registered as a Meta developer (the one-time developer registration and phone
   verification are Meta's, not ours, and can take longer than the whole budget).
4. One link: the repository README
   (<https://github.com/IvanBBaev/facebook-mcp#readme>).
5. One sentence of task: _"Using only the public documentation, get this
   Facebook MCP server working in `<client>` against your test Page, until the
   client shows the result of `facebook_whoami`. Think aloud."_

## What the tester must NOT be told

- Anything about the order of steps, which commands to run, or where the env
  file lives.
- That `setup-token` needs `FB_APP_ID` / `FB_APP_SECRET`.
- The `npx` package name, the `claude mcp add` syntax, or the Claude Desktop
  config path.
- Which tool to call first, or which scopes to tick.
- Any workaround when they get stuck. If they ask, the observer says _"do what
  you would do if I weren't here"_. If they would open an issue, they note the
  question and the clock keeps running.

The observer **may** intervene only to prevent harm: a real token about to be
pasted into a chat, an issue, a screen share that is recorded, or a production
Page. Record every intervention; an intervention for any other reason fails the
trial.

---

## Timing sheet

Start the clock when the tester opens the README. Record the wall-clock time at
the end of each step (the moment the tester moves on), not what the tester
estimates. "Target" is what a first-timer should need if the docs are right.

| #   | Step                                              | Ends when                                                         | Target | Start | End | Minutes | Stuck points (quote the tester) |
| --- | ------------------------------------------------- | ----------------------------------------------------------------- | -----: | ----- | --- | ------: | ------------------------------- |
| 0   | Read README to the Setup section                  | Tester starts acting on a step                                    |      2 |       |     |         |                                 |
| 1   | Create the Business app, find App ID + App Secret | Both values copied                                                |      5 |       |     |         |                                 |
| 2   | Short-lived User token in Graph API Explorer      | Token copied, with the chosen scopes ticked                       |      3 |       |     |         |                                 |
| 3   | `setup-token`                                     | Report shows `status: completed` and `Env file … status: written` |      3 |       |     |         |                                 |
| 4   | `doctor`                                          | Tester has read the verdict and the package matrix                |      2 |       |     |         |                                 |
| 5   | Register the server with the client (+ restart)   | Client lists the `facebook_*` tools / `/mcp` shows it connected   |      3 |       |     |         |                                 |
| 6   | First tool call: `facebook_whoami`                | Result with `valid: true` is on screen                            |      2 |       |     |         |                                 |
|     | **Total**                                         |                                                                   | **20** |       |     |         |                                 |

Also record, per step:

- **Reruns** — how many times a command was run again, and why (the exact error
  line the tester reacted to).
- **Doc jumps** — every time the tester left the README (runbook, `--help`,
  web search, Meta docs). A web search for something about this server is a
  doc bug even if it succeeded.
- **Wrong turns** — anything done and later undone (wrong app type, Page token
  instead of User token, an `env` block pasted with placeholder values).

Stop the clock at the first successful `facebook_whoami`. If the tester gives
up, or 40 minutes pass, stop and record the step and the last error seen.

---

## Pass / fail

| Result                                                                 | Verdict                                     |
| ---------------------------------------------------------------------- | ------------------------------------------- |
| First successful tool call in **≤ 20 min**, no non-safety intervention | **PASS**                                    |
| 20–40 min, no non-safety intervention                                  | **FAIL (slow)** — fix the slowest step      |
| Gave up, > 40 min, or needed a hint                                    | **FAIL (blocked)** — fix before the release |

Meta-side delays outside our docs (developer registration, a security checkpoint
on the Facebook account, a Meta outage) are recorded with their minutes and
**subtracted** from the total, with a note. Anything the README or a runbook
could have prevented is never subtracted.

---

## What to record afterwards

Right after the trial, while the tester still remembers, capture:

1. The filled timing sheet, the client, its version, the OS, and the Node
   version (`node -v`) and server version (`npx -y @ivanbaev/facebook-mcp
--version`).
2. The verdict from the table above.
3. For each stuck point: the doc section the tester was reading, what they
   expected, what actually happened, and the exact error or report line. Never
   copy a token, app secret or env-file contents into the notes — redact to
   `<token>`.
4. The tester's answers to three questions:
   - _"Where did you first feel unsure what to do next?"_
   - _"Which message from the tool helped most, and which misled you?"_
   - _"What would you have searched for?"_
5. A proposed fix per stuck point, tagged `README`, `runbook`, `CLI output` or
   `code`.

File the result as a GitHub issue titled `Onboarding trial <date> — <client> —
PASS|FAIL`, one issue per trial. On a PASS for a client, the author may flip that
client's row in the README's **Client compatibility** table to verified, citing
the issue.

Afterwards, have the tester revoke the token (Meta Business Settings, or remove
the app) and delete the env file — see [offboarding.md](offboarding.md).

## Related

- [onboarding.md](onboarding.md) — the procedure under test.
- [README → Setup](../../README.md#setup) — where the tester starts.
