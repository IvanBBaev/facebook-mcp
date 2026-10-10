# Runbook: Meta app upkeep

A Facebook app is not a set-and-forget dependency. Meta retires Graph API
versions on a schedule, renames and removes insights metrics without warning,
and periodically requires the app owner to reconfirm how the app uses data — and
missing that last one **disables the app**. None of these are things the server
can detect for you: from inside the process they all look like "the API started
returning errors", or worse, like "the API started returning nothing".

This runbook is the periodic maintenance pass that catches them early.

## When to use this

- **On a ~4-week cadence.** This is the changelog check the corpus commits to
  (CC-LIFE-5) and the one recurring obligation of running this server.
- Meta emailed you about **Data Use Checkup**, an **API version deprecation**, or
  a **permission change**.
- Every tool suddenly fails with permission errors and nothing about your setup
  changed — jump straight to [§3](#3-data-use-checkup).
- Insights calls started returning empty series for metrics that used to work —
  jump to [§1](#1-the-4-week-changelog-check).
- Before cutting a release — see [release.md](release.md), which assumes this
  pass is current.

---

## 1. The ~4-week changelog check

Meta publishes breaking and behavioural changes in changelogs, not in the API
responses. Read them; nothing else will tell you.

1. Read the **Graph API changelog** for every version released since your last
   pass, and the **Messenger Platform** and **Marketing API** changelogs if the
   `messages` or `ads` packages are enabled.
2. Look specifically for the four things that break this server silently:
   - **Insights metric renames or retirements.** The failure mode is an empty
     series, not an error — a user sees "no data" and blames their Page.
   - **Edge removals or field-permission changes** on the edges in
     `src/api/` — feed, published posts, video reels, comments, conversations,
     insights, ads.
   - **Window-rule changes** — the 24-hour standard messaging window and the
     7-day / one-shot private-reply rule are both enforced client-side, so a
     rule change makes the server refuse work the API would now allow.
   - **Permission renames**, which invalidate the doctor's permission × package
     matrix.
3. For anything you find, the fix belongs in the source, not in a note: a
   changed rule means a changed guard and a changed tool description. The
   description is what the model reads; a stale one is a live defect.

**Verify by:** you can name the newest Graph API version Meta has published and
say whether anything in it affects this server.

---

## 2. Graph and Marketing API version deprecation

The server pins **two** tested versions in
[`../../src/core/settings.ts`](../../src/core/settings.ts), because the two APIs
retire versions on different clocks:

| Pin | Override | Currently | Used by |
|---|---|---|---|
| `DEFAULT_API_VERSION` | `FB_API_VERSION` | `v23.0` | every Graph call (Pages, posts, comments, Reels, insights, messages, token checks) |
| `DEFAULT_ADS_API_VERSION` | `FB_ADS_API_VERSION` | `v26.0` | every Marketing API call of the `ads` package (ad accounts, campaigns, ad sets, ads, ads insights, async report runs, status/budget writes) |

Meta ships a new version roughly quarterly and supports each **Graph** API
version for about two years, so the Graph pin ages out on a predictable, slow
clock (Graph v23.0 runs until 2027-10-08).

The **Marketing** API runs on a much shorter clock: a Marketing API version is
typically retired a few months after the version two releases newer ships
(Marketing v23.0 ended 2026-06-09, v24.0 on 2026-10-06). Once it is retired,
Meta auto-upgrades calls to the next available version only for endpoints that
did not change, marks them with an `X-Ad-Api-Version-Warning` header, and
rejects the rest with error `#2635`. So check the **Marketing API versions
table** on every §1 pass, not just the Graph one — the ads pin needs a bump
long before the Graph pin does. See
[`../analysis/12-graph-changelog-check-2026-10.md`](../analysis/12-graph-changelog-check-2026-10.md)
(finding H1 is why the pins were split).

The two pins move **independently**: bumping one never requires bumping the
other, and each bump is its own change. Both overrides accept any `vNN.N` value
with a warning when it is off the tested default — behaviour is only verified
against the defaults. Use an override to *test* a bump, never to *ship* one.
`doctor` and `facebook_whoami` report both versions.

To move a pin (`<VAR>` is `FB_API_VERSION` for Graph, `FB_ADS_API_VERSION` for
the ads pin; `<PIN>` is the matching constant):

1. Set `<VAR>=<new>` in a scratch env and run `doctor`. For the ads pin, first
   confirm `<new>` is listed in the Marketing API versions table with no sunset
   date in sight.
2. Run the live smoke suite against the **test** Page — see
   [`../../scripts/smoke/README.md`](../../scripts/smoke/README.md). Read-only
   smokes first; write smokes only once those are clean. For the ads pin, set
   `FB_AD_ACCOUNT_ID` so the ads smokes run, and check that no response
   carries `X-Ad-Api-Version-Warning`.
3. Shape-diff the recorded fixtures under `test/fixtures/` against the new
   version's responses. A field that changed type or disappeared is the whole
   point of this step. Snapshot the current set (`cp -R test/fixtures
   "${TMPDIR:-/tmp}/fixtures-baseline"`), re-record each fixture with
   `FB_RECORD_FIXTURE=1 FB_API_VERSION=<new> node scripts/record-fixture.mjs
   --endpoint <edge> --out <name>.json --force`, then run
   `npm run fixtures:shape-diff -- --baseline "${TMPDIR:-/tmp}/fixtures-baseline"
   --candidate test/fixtures`. Exit `0` means no breaking difference; exit `1`
   lists every `removed`, `type-changed` and `array-element-changed` path (added
   fields and nullability changes are reported but do not fail). The comparison
   is shapes only and never prints a fixture value. Restore or prune the
   re-recorded files before committing — see
   [`../../test/fixtures/README.md`](../../test/fixtures/README.md#when-the-api-version-moves).
   For an **ads** bump the fixtures are versioned by the ads pin under
   `test/fixtures/ads/<ads-version>/`, so no snapshot is needed: record the new
   version next to the old one with `FB_RECORD_FIXTURE=1
   FB_AD_ACCOUNT_ID=act_<id> FB_ADS_API_VERSION=<new> node
   scripts/record-fixture.mjs --ads` (read-only: the account, the campaign /
   ad set / ad listings, one object read per level and sync insights — never
   the async report POST), then run `npm run fixtures:shape-diff -- --baseline
   test/fixtures/ads/<old> --candidate test/fixtures/ads/<new>`. If there is no
   baseline directory for the current pin yet, record it first with the same
   command minus `FB_ADS_API_VERSION`. Without `FB_AD_ACCOUNT_ID` the recorder
   skips the ads set (exit `0`) and records nothing. Read the anonymised files
   before committing the new directory, and remove the old one once the bump
   ships.
4. Only then change `<PIN>` in `src/core/settings.ts` (and its default in
   `scripts/metadata.config.mjs`), regenerate the metadata surfaces
   (`npm run metadata`), run `npm run check`, and record the bump in
   `CHANGELOG.md`.

**Verify by:** `facebook_whoami` reports the new version on the pin you moved
(`apiVersion` or `adsApiVersion`), the smoke suite is green against it, and
every line `npm run fixtures:shape-diff` reports as breaking is explained.

> Do not bump a pin and release in the same change. A version bump is its own
> release, so that a regression has exactly one suspect.

---

## 3. Data Use Checkup

Meta periodically requires the app owner to reconfirm what the app does with the
data each permission grants. It is announced by email and in the app dashboard,
with a deadline. **Miss the deadline and Meta removes the app's permissions** —
which, from this server's side, looks like every tool failing at once with
permission errors, on a token that `debug_token` still reports as valid.

The server cannot detect this state. There is no API for it; it is a manual
console step.

1. Open the developer app dashboard and check for a Data Use Checkup prompt.
2. Complete it for every permission the app holds — the runtime scopes plus any
   setup-only scope such as `business_management`.
3. If the app has permissions it no longer needs, drop them here rather than
   reconfirming them. A smaller grant is a smaller blast radius.

**Verify by:** the dashboard shows no outstanding checkup, and `doctor` reports
the permission × package matrix as satisfied for every enabled package.

---

## 4. Token expiry watch

Tokens expire on their own schedule, independently of everything above.

1. Run `doctor` (or `facebook_whoami`) and read the reported token **type**,
   validity and **expiry**.
2. A System User token on a 60-day rotation, or a Page token approaching a
   security-event-driven invalidation, is rotated ahead of the outage — the
   procedure is [credential-rotation.md](credential-rotation.md), not this
   runbook.

**Verify by:** you know the expiry date of the credential currently in use, and
it is further away than your next upkeep pass.

---

## 5. Journal growth

The write journal is capped, but only just: it rotates at about 5 MB,
`journal.ndjson` → `journal.1.ndjson`, and **one generation is retained** — the
next rotation overwrites the previous `.1` file.

That is deliberate (unbounded local growth is the bigger risk), but it means the
journal is not an archive. If you need write history beyond the last two
generations — for an audit, or because you are about to run a high-volume
moderation sweep — copy the files somewhere durable first:

```sh
ls -l "$(dirname "${FB_JOURNAL_PATH:-$HOME/.local/state/facebook-mcp/journal.ndjson}")"
```

On Windows the default location is `%LOCALAPPDATA%\facebook-mcp\`.

**Verify by:** the journal directory holds at most the current generation and one
rotated file, and anything you needed to keep has been copied out.

---

## 6. Dependencies and the Node floor

1. Review open Dependabot pull requests. Majors that break the pinned MCP SDK
   are closed with a reason, not merged and reverted later.
2. Run `npm audit` and triage anything reachable at runtime — the package ships
   a deliberately small runtime dependency set, so a real finding is rare and
   worth acting on immediately.
3. Check whether the supported Node floor still matches reality: the floor is
   declared once in `scripts/metadata.config.mjs`, and `npm run metadata`
   propagates it to `package.json`, `server.json`, `manifest.json`, the plugin
   manifests, `.env.example` and the generated README blocks. `.nvmrc`, the
   `bin/` launcher guard and the CI/release workflows are **hand-written** — the
   drift tests in `src/metadata.test.ts` only assert they agree, they do not
   update them. So raising the floor is: edit the config, run `npm run
   metadata`, then edit those four by hand, and only then do the tests go green.

**Verify by:** `npm run check` and `npm run metadata:check` are both green.

---

## Recording the result

Keep the pass cheap to repeat by leaving a trail: one line per pass with the
date, the newest Graph API version seen, whether Data Use Checkup was
outstanding, the credential expiry, and anything you changed as a result. A pass
that found nothing is still worth recording — it is the evidence that the gap
since the last check is small.

### Check log

Newest first. Link a dated analysis doc when the pass produced findings.

| Date | Newest Graph / Marketing API | Data Use Checkup | Credential expiry | Outcome |
| ---- | ---------------------------- | ---------------- | ----------------- | ------- |
| 2026-10-02 | v26.0 / v25.0 (v26.0 announced, not yet in the Marketing table) | not checked (console step, desk check only) | not checked | Pin `v23.0`: Graph fine to 2027-10-08, but Marketing API v23.0 retired 2026-06-09 (HIGH). Recommend bumping to v26.0 as its own release before the 1.0 live pass. Insights rename-table gaps (MEDIUM). No source changed. See [`12-graph-changelog-check-2026-10.md`](../analysis/12-graph-changelog-check-2026-10.md). |

## Related

- [credential-rotation.md](credential-rotation.md) — when the expiry check in §4
  says it is time.
- [offboarding.md](offboarding.md) — if the answer to "should we keep this app?"
  is no.
- [release.md](release.md) — the release cut, which assumes this pass is current.
- [`../analysis/09-corner-cases.md`](../analysis/09-corner-cases.md) — CC-LIFE-5
  and the insights corner cases this pass is designed to catch.
- [`../analysis/12-graph-changelog-check-2026-10.md`](../analysis/12-graph-changelog-check-2026-10.md)
  — the first post-launch pass (2026-10-02): versions, impact matrix, bump
  recommendation.
