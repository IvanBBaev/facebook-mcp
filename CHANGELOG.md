# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).
Planned work is tracked on the [roadmap board](https://github.com/users/IvanBBaev/projects/3)
and its [milestones](https://github.com/IvanBBaev/facebook-mcp/milestones); the git history is
largely one commit per task, apart from the squashed `0.7.0` release commit.

## [Unreleased]

### Added

- **A green smoke run said how many scenarios passed, never which tools were
  touched.** The summary counted smokes, so `8 passed` read as a verified
  surface — but a smoke is a scenario, not a tool, and nothing in the run knew
  or said that a tool the server advertised to that very session was never
  called once. A `--phase 2` run could go green having exercised half the tools
  that phase ships, and the gap was invisible by construction. The runner now
  reports coverage from two facts it already has: what the session advertised
  through `listTools`, and what it actually got an answer for, recorded at the
  single `callToolRaw` chokepoint. The bar is deliberately "the server replied",
  not "we tried" — an `isError` result still counts, because a tool that ran and
  refused is exactly what a guardrail smoke asserts. Sweeper calls are excluded
  so the destructive half of the surface is never reported as verified by a run
  that only tidied up, a tool called but never advertised is surfaced as a
  failure rather than absorbed as an ordinary tool error (it means the smoke is
  calling something this package selection does not load, so the scenario it
  claims to cover never ran), and the caveat is appended to the result line only
  on a full run — a `--only` or `--phase` run legitimately leaves most of its
  narrowed surface untouched, and warning there would train the reader to ignore
  the warning that matters.

- **`doctor` now ends with a verdict, and `--strict` turns it into an exit
  code.** The report already contained every fact needed to judge an install, but
  reading it was the operator's job, and the command exited 0 no matter what it
  found — so nothing could gate on it. Each section now contributes findings
  (`warn` / `unknown` / `fail`), the worst one becomes the report's verdict, and
  `doctor --strict` exits 2 for a configuration that cannot serve requests, 1 for
  one that is degraded or unverified, 0 otherwise.

  The default stays exit 0 whatever the verdict: the doctor is what a wrapper
  runs for its text, and making it fail by default would break those callers to
  no benefit. `unknown` outranks `warn` so that an unreachable `debug_token`
  cannot pass for a merely degraded setup, and the credential-file rule stays
  silent on platforms without POSIX permission bits — a finding no `chmod` can
  clear would make `--strict` permanently red on Windows.

- **The live smoke harness can now say "this proved nothing" without lying in
  either direction.** Seven scenarios legitimately depend on material a test Page
  may not have — a published post, a Reel, a conversation, a stranger's comment —
  and each of them used to log a line and return, which the runner counted as a
  pass. A run against an idle Page therefore reported all-green while the taint
  contract on visitor-authored text, the only place it is checked at all, had
  never executed. `ctx.notExercised(reason)` records that a part of a contract
  could not run: it does not throw, so a smoke that verified five of six
  behaviours keeps the five; the smoke is counted separately from `passed`; and
  every reason is echoed live and listed again in the summary, whose result line
  reads `PASS — N smoke(s) NOT EXERCISED (this run is not evidence for what they
cover)`. The exit code stays 0 on purpose — an idle Page is a property of the
  environment, not a defect, and a gate that goes red for a reason no code change
  can clear is a gate people learn to ignore.

- **Live coverage for the last three uncovered read tools.**
  `facebook_list_pages`, `facebook_get_page` and `facebook_usage` had no live
  coverage at all, and `facebook_get_reactions` none either. They are free
  read-only GETs, so they were closed with real coverage rather than labelled
  accepted gaps — that label belongs to contracts that _cannot_ be exercised, and
  using it here would have called an oversight a decision. The Page-surface smoke
  proves against a real Graph response that `facebook_list_pages` fetches a Page
  access token and drops it before the payload; a fixture test can only prove the
  fixture was stripped. The reactions smoke pins the counting trap `userCount` is
  the length of the _disclosed_ reactor list, never the reaction count, and
  asserts the taint envelope before unwrapping and regardless of length, so the
  shape cannot come to depend on what Graph felt like disclosing.
  `facebook_create_video_post` stays uncovered but is now registered as a visible
  no-op scenario with the manual check written out, so the gap appears in
  `--list` and in every run instead of being an absence nobody can see.

- **The ads parent chain is now walked on live data, not assumed.**
  `facebook_list_adsets` and `facebook_list_ads` had no live coverage: the
  campaign smoke proved the shared envelope, but everything the _level_ decides —
  which fields each level asks Graph for, and the parent ids that exist only below
  the campaign — went unchecked. An ads id is opaque digits that encode neither
  the level nor the owning account, so a listing answered for the wrong account,
  or a level wired to another level's field set, hands back parent ids that are
  perfectly well-formed and point at somebody else's objects. The new
  `ads/hierarchy` smoke resolves each parent id back through
  `facebook_get_ad_object` and compares the `account_id` it returns with the
  account that was listed — the only check that can tell those two apart from
  outside the server — then asserts that an ad and its own ad set agree about
  which campaign they belong to, which is a disagreement neither id shows alone.
  It also pins the two unbounded blobs out of the listings (`targeting`,
  `creative`), each of which can outweigh the whole result budget, and that an ad
  reports no budget of its own. Where a real account cannot supply the material —
  no ad sets, no ads under review, budgets sitting on the campaign under budget
  optimisation — the smoke reports `notExercised` rather than passing silently.

- **The log allowlist now names something on 20 tools instead of one.**
  Enforcing `ToolSpec.logFields` (above) made the field load-bearing, and at that
  moment exactly one tool in the server declared an allowlist — so the enforced
  mechanism logged the ads update's arguments and, for every other call, a bare
  tool name. Twenty of the thirty-seven tools now declare one, chosen per tool
  rather than by rule: the object a call acted on (`post_id`, `comment_id`,
  `object_id`, `conversation_id`), the shape of a read that can hit a rate-limit
  wall (`level`, `date_preset`, `since`/`until`), and on every write the two
  fields that say whether it was a preview or the real thing (`apply`,
  `plan_id`). Seventeen tools stay silent deliberately — a plain listing whose only
  arguments are the configured account plus paging can report nothing an operator
  did not already know, and a padded allowlist is worse than none because it
  makes review look done. No `message`, `caption`, `fields`, `psid` or token-like
  argument appears anywhere in the set.

- **A registry-wide audit of what may be logged, over the assembled surface.**
  Each package already pinned its own allowlists in its own test, which is
  exactly the check that cannot see the thing worth seeing: a new package, or a
  key nobody thought about, is invisible to every table but the one it was added
  to. `annotations.test.ts` now expands the whole surface through the real
  registry and holds the union of every declared key against a frozen vocabulary
  of twenty-five names, checks that each logged key is a real argument of the
  tool that logs it (read off the zod schema, so a renamed argument leaves a dead
  entry behind and is caught), and runs the vocabulary past an independent set of
  never-loggable patterns — content, identity, secrets, money. Adding a
  twenty-sixth name is now a review event rather than a diff nobody reads.

### Fixed

- **A bulk hide or delete whose ids all came back UNPROVEN was reported, and journaled, as a batch in which nothing happened.** `core/http.ts` marks a write whose request reached Facebook but whose answer was lost as `ambiguous` — it may already have landed — yet `runBulk` flattened that into a plain per-id `error`, indistinguishable from `(#200) Permissions error`. Downstream, `failed === total` then licensed the `failed` verdict, whose own docstring calls "the world is untouched" the more dangerous of the two possible lies: the tool printed _"All N id(s) failed — nothing was applied ... every id is still to do once the cause is fixed"_, the journal recorded `outcome: failed, applied: false`, and the obvious next move was a blind retry — permanent, for `facebook_delete_comment`. An unproven outcome now carries `ambiguous: true` and a verify-first note per id, `tallyBulk` counts them apart from provable failures (`failed` keeps its old meaning), and a batch holding one takes the ATTEMPTED verdict this package already gives every other unconfirmed write: `not_applied` with the notice that says verify before retrying, never `failed`.
- **An unusable answer from a result classifier crashed the write gate AFTER the mutation had landed, and lost the journal entry with it.** `runApply` read `.outcome` off whatever `classifyResult` returned, below the line whose own comment reads _"`perform` RESOLVED: the mutation is at Graph. Nothing below may throw."_ A hook that fell off the end — or any JS caller of the barrel-exported `createWriteGate` — made that read throw a `TypeError`, so the caller was told the write had failed, no journal entry was written for a write that did land, and the spent plan invited a re-plan and a second mutation on one authorization. A malformed verdict could also put a non-boolean straight onto the frozen `applied` envelope field. The hook's answer is now validated and an unusable one keeps the applied verdict with a recorded classification error — the same fail-safe the gate already applied to a classifier that threw.
- **A `perform` that REJECTED could be journaled as `applied`.** `classifyOutcome` is typed to exclude `applied` precisely because the gate is about to re-throw the Graph error, but the hook is an injected seam on an exported factory, so the type was documentation rather than a control: its answer went into the audit record unchecked. The journal could therefore assert a change that the very same call reported as a failure — and an `undefined` produced a record with no `outcome` field at all. `applied` and anything unrecognised now collapse to `attempted`, the same "we do not know" already recorded for a classifier that threw.
- **`listComments` blamed the token for an empty first page that itself handed back a forward cursor.** Graph pages a filtered comments edge by scanning a fixed row window, so an empty `data` beside a `paging.next` means "keep walking" (CC-PAGE-1) — while a token that cannot see the edge is answered with an empty list and no paging at all. A minted cursor therefore disproves the USER-token diagnosis, but the note fired anyway and sent the operator off to re-mint a credential when the next page was one call away. An empty first page carrying a cursor now says so, the same way a page reached _by_ a cursor already did.
- **The 24-hour messaging window was computed from a last-inbound timestamp in the future, reporting `open` with a negative age and a deadline later than the real one.** A `created_time` ahead of this server's clock — skew between Meta and the host, or a garbled value `Date.parse` happens to accept — cannot be true, so nothing derived from it is an age; `open` is the dangerous direction, because the caller sends untagged on the strength of the fabricated `closesAtMs`. `evaluateMessagingWindow` now answers `unknown` with no deadline and names the clock disagreement, matching the stance its sibling `windowStatusFromLastActivity` already took and the module's own rule that an unverifiable window is Facebook's to enforce.
- **A budget on a zero-decimal ad-account currency was stated at one hundredth of its real size, in the one line an operator approves.** `formatMinor` labelled every amount "N minor units of <CUR>", and the `daily_budget_minor` / `lifetime_budget_minor` descriptions told the model that 1000 always means 10.00 — but sixteen of the currencies an ad account can be denominated in (JPY, KRW, CLP, VND, ISK and eleven more) have no sub-unit at all, so `daily_budget_minor: 2500` on a JPY account is 2500 yen, not 25.00. Both the plan preview and the `FB_ADS_BUDGET_CEILING` refusal therefore understated the amount being approved by a factor of a hundred, in the text whose entire job is consent before a spend-tier write (CC-ADS-3, CC-ADS-7). `formatMinor` now names the currency's real granularity ("2500 JPY (whole units)"), a zero-decimal plan carries an explicit warning beside the overwrite note, and the fractional-amount refusal and the four model-facing budget texts state both cases instead of only the two-decimal one. No number on the wire changed.
- **A token or secret containing a backslash or a double quote was written into `.env` in an escaping the loader never undoes.** `renderEnvFile` doubled every `\` and escaped every `"` inside a double-quoted value, but the reader — dotenv, through `loadEnvFile` — strips one layer of quotes and expands only `\n` and `\r`; it never unescapes `\\` or `\"`. The defensive escaping was therefore destructive: `setup-token` reported `[OK] write`, and the server then failed with a Graph auth error that pointed at nothing. Values are now written in a quoting dotenv actually reverses, and the rare value no env file can represent at all (a single quote mixed with a double quote or a backslash) is refused as a failed write step that names the key and never prints the value, instead of being mangled in silence.
- **Graph's own user-facing error text was parsed off the wire and then thrown away.** An error envelope carries `error_user_title` / `error_user_msg` — the sentence Meta wrote for a human, and often the only place a refusal explains itself ("Your account is restricted", "This post is no longer available"). The transport dropped both, so the caller got the developer `message` alone. They now ride `GraphErrorEnvelope`, `GraphApiError` and the tool error record, and — because they are Meta-authored text that can quote back whatever the request contained — they are redacted exactly like the message before they are surfaced.
- **A Graph error whose `code` arrived as a string missed the error matrix entirely.** Graph is not consistent about the type of `code` / `error_subcode`: the same edge answers `190` and `"190"`. The parser accepted only a number, so a string code left `code` undefined, the matrix had nothing to match, and a perfectly well-known refusal (an expired token, a rate limit) came back as an unclassified error with generic "inspect then decide" guidance. Numeric strings are now read as the integers they are, so the classification is the same whichever form Graph sends. One consequence is a correctness fix in its own right: a 400 whose envelope carried only a string `code` was not recognized as an envelope at all and was handed back as DATA.
- **A 2xx whose body was the JSON literal `null` was handed back as the string `"null"`.** The transport parsed the body and fell back to the raw text whenever the parse produced a falsy value, so `null` — a legitimate and meaningful Graph answer — lost its type on the way to the caller. The fallback now distinguishes "the body did not parse" from "the body parsed to null", and `false`, `0` and `""` take the same corrected path.
- **A rejection that was not an `Error` was reported as `[object Object]`.** The top-level error record stringified anything non-`Error`, so a plain object thrown or rejected with — the shape a Graph-derived failure takes when it crosses a library boundary — lost its `message` to `String()`. The record now reads a string `message` off any object before falling back, and the fallback itself can no longer throw.
- **A resumable video upload took the server's REWOUND offset for a stall and re-sent the wrong window.** When Graph answers a chunk with an offset EARLIER than the local one, it is telling the client what it actually holds (CC-MEDIA-2) — but the loop treated any non-advancing offset as a stall: it backed off, cleared the window and re-sent from the local offset Graph had just contradicted, burning resume attempts until the budget ran out. A rewind now moves the local start back to the server's offset, recomputes the window, records `server offset rewound from X to Y`, logs it, and re-sends immediately without a backoff; a true stall (the same offset again) keeps the old behaviour verbatim.
- **A server offset PAST the end of the file was clamped to "transfer complete".** `Math.min(acked, total)` turned an impossible offset — the server describing some other file, or some other session — into a finished transfer, which would then finish and possibly PUBLISH a video that is not the caller's (CC-MEDIA-2). That answer is now a desync: the session is marked `failed` with `server offset N is past the M-byte file end` and the call throws instead of proceeding.
- **A finished upload session could be finished a second time, or re-opened by another transfer.** Neither `finishVideoUpload` nor `transferVideoUpload` looked at the session phase, so a retry after a successful finish sent a second `upload_phase=finish` for a video that already exists — the duplicate-publishing case the write gate exists to prevent. Both now refuse a session in phase `finished` locally, without a wire call, naming the video id and pointing at the status poll.
- **An EXPIRED video was reported as still in progress.** `mapVideoStatus` mapped Graph's `expired` status to the "keep polling" branch, so a video Meta had discarded before it was finished looked like one that just needed more time — a poll loop that can only ever time out. `expired` is now terminal: it reports as an error with `video expired — Meta discarded it before it was finished; upload it again`.
- **`facebook_ads_insights` sent a reversed or malformed date window straight to Graph.** `since` and `until` were pasted into `time_range` after a shape check no stronger than "non-empty string", so `since: "2026-03-01", until: "2026-01-01"` became a Graph round-trip that could only fail, and `01/02/2026` was sent as-is. Both ends are now parsed as real calendar dates and the order is checked locally, before any request, with a message that names which end is wrong.
- **`facebook_post_insights` spent a Graph call on a post ID that cannot resolve.** A bare number is a video or photo ID — or the post half of the composite without its Page prefix — and never resolves on `/insights`, but the argument accepted any non-empty string. It is now refused locally with a message that names the mistake, says where the right ID comes from, and points Reels and videos at `facebook_reel_insights`.
- **An impossible calendar date was silently rolled over into a real one.** `2026-02-30` parses in JavaScript as the 2nd of March, so an insights window built from a typo asked Graph about days the caller never named — and the answer looked perfectly valid. Dates are now round-tripped through their own formatting, and one that does not come back unchanged is refused as not a real date.
- **An ad-account status code this server does not know was treated as "dead".** The status map covers the documented codes; anything else fell through to the disabled branch, so an account Meta had put in a state added after this map was written was declared unable to serve ads — and, worse, `assertAdAccountUsable` used that to BLOCK a pause, which is exactly the write an operator reaches for when an account is in trouble. An undocumented code now says so plainly ("not one this server knows … check the account in Ads Manager. Writes are attempted and Graph decides") and no longer blocks the write; the structured `statusLabel`, `serving` and `atRisk` fields are unchanged.
- **A post whose outcome was AMBIGUOUS was journaled as a clean failure.** The publish classifier judged a `GraphApiError` by its HTTP status alone, so the two places that raise an ambiguous error with a 2xx status — a response body lost after HTTP 200, and a `/photos` call answered 200 with no photo id — were recorded as `failed`. That is the record that invites the blind retry, and a duplicate post. An error the transport already classified `ambiguous` is now journaled as `attempted` whatever its status, for all four create paths (CC-PUB-1).
- **A post created without a usable ID was reported as published.** `facebook_create_post` had no result classifier, so a 2xx whose body was `{}`, empty, or carried an ID of the wrong type came back `status: "applied"` beside `postId: null` — a clean "published" with no handle to verify by, from exactly the state the transport itself files as ambiguous. Such a create is now `status: "not_applied"` with `outcome: "attempted"` and the verify-before-retry notice; `facebook_create_video_post` does the same when the `file_url` delivery names no video (CC-PUB-1).
- **The Page-post character limit was enforced in UTF-16 units.** The schema promises "up to 63206 characters" and that "Unicode and emoji pass through byte-for-byte", but the local pre-check compared `message.length`, which counts an emoji twice — so a 32 000-emoji message was refused locally as `64000 characters`, a number the caller cannot reconcile with the text it sent. The check now counts code points, as documented; Meta's own count remains the truth on the wire (CC-PUB-7).
- **Ten more model-supplied IDs could address a Graph node other than the one named.** The same escape the reader tools had — a `/` in an interpolated ID opens a new path segment, because `containPathname` receives the path already joined and cannot tell a structural segment from an ID — reached `facebook_update_post` / `facebook_delete_post` (`post_id`), `facebook_list_comments` (`object_id`), `facebook_get_comment`, `facebook_reply_to_comment`, `facebook_private_reply`, `facebook_hide_comment` and `facebook_delete_comment` (`comment_id` / `comment_ids[]`), and `facebook_get_conversation` and `facebook_send_message` (`conversation_id`). `900/conversations` passed as a comment ID reached the inbox under the same Page token and the same HTTP method. All ten now require a bare Graph ID shape (`graphNodeIdArg`, shared with the reader tools), checked before any request leaves; the arguments that only ever ride the query string or the body — `psid`, `recipient_id`, the private reply's own `comment_id` on the send — are unchanged, as is `profile`, which resolves through the Pages registry rather than being interpolated.
- **A `post_id` containing a slash addressed a different Graph node.** `facebook_get_post` and `facebook_get_reactions` accepted any non-empty string and interpolated it into the edge path, where a `/` creates a new path segment: `100200300/conversations` reached the inbox — normally behind the `messages` package — and `me/accounts` reached the Page listing, under the same token and the same method. (`..` was already refused and `?`/`%` already contained; `/` was the one character that escaped.) Both arguments now require a Graph ID shape, checked before any request leaves.
- **A SCHEDULED multi-photo post was silently created as a draft.** A `/feed` post that carries `attached_media` needs `unpublished_content_type=SCHEDULED` alongside `published:false` and `scheduled_publish_time`; without it Graph accepts the call, reports the post as created, and never honours the scheduled instant — so the post simply never goes live, with nothing in the answer saying so. The flag is now sent for exactly that combination: a scheduled text or link post is unaffected, and an unscheduled photo post is not labelled as scheduled content.

- **A token expiry Graph never stated was reported as "never expires" — by `facebook_whoami`, by the doctor, and by `setup-token`.** `debug_token` answers `expires_at: 0` for a non-expiring token; an answer with no `expires_at`, or one that is not a number, says nothing. Both were normalized to the same absent value, and every consumer read "absent" as "never": `whoami` claimed `neverExpiring: true`, the doctor printed `token expiry: never` with no finding, and `setup-token` filed a System-User token of unknown lifetime as one the operator never needs to rotate. `DebugTokenInfo` now carries `expiry: "known" | "never" | "unknown"`; `whoami` reports `neverExpiring: false` plus `expiryUnknown: true`, the doctor renders `unknown — Graph's debug_token answer carried no usable expires_at` and raises a `warn` (so `--strict` exits 1), and `setup-token` still writes the token but warns that its expiry is unknown instead of labelling it non-expiring.
- **The doctor's probes could not tell "configured but unhealthy" from "not configured".** The ad-account probe exists to catch a DISABLED or UNSETTLED account, and the metric probe to catch a Page whose insights do not answer as pinned — but both came back as a plain `available: false`, printed above `OK — nothing needs attention` and invisible to `--strict`. Probes now mark such answers `degraded`, which the doctor raises as a `warn` (a probe that threw stays `unknown`; a probe with nothing configured stays silent).
- **`doctor` printed a green report for a configuration the server refuses to start on.** Startup validation runs after the doctor, so a `FB_TRANSPORT=http` with no `FB_HTTP_TOKEN`, an invalid enum or number, a duplicate profile, or a weak confirm token never reached the verdict, and `doctor --strict` exited 0. Startup errors now appear under `Configuration` as `<field>: WILL NOT START — …` and fail the verdict (exit 2 under `--strict`); startup warnings (`no-app-secret`, the API-version notes, an unreadable env file) are `warn`. Problems the doctor already judges in its own words (no token, no Page, a Page token not bound to `FB_PAGE_ID`) are not repeated.
- **`facebook_ads_insights` explained an empty page reached with a cursor as "the object never delivered in the window".** The empty-page note was pushed for every empty result, including the last page of a walk the caller resumed with `after` — contradicting the rows already in hand. A continuation page that comes back empty now says the read has run past the last row and makes no claim about delivery; the first page keeps the original explanation.
- **`facebook_update_ad_object` warned that a campaign "has no end time" while reading the wrong key, and asserted the same about a field it never read.** The lifetime-budget preview checked `end_time` only — an ad-set field; a campaign's end is `stop_time`, so a campaign with a perfectly good `stop_time` was told Graph would reject the write. With no `level` the object is read with the common field set, which carries neither key, and the preview still declared the end time absent. The check now reads the key each level actually carries, the missing-end note names both keys, and a plan made without a `level` carries a separate note saying the end time could not be verified and how to have it checked.
- **`facebook_send_message` reported `applied` for a send Graph never confirmed.** A 200 with no `message_id` is not a delivery: the message may or may not have left, and the API layer already said so (`delivery: "unconfirmed"`). The tool still let the write gate's default verdict stand, so the envelope said `applied` and the journal recorded a change. An unconfirmed send now comes back as `status: "not_applied"` with `outcome: "attempted"` and is journaled as attempted; a 200 whose body is a Graph error envelope is never reported as sent (CC-NET-2, CC-MSG-2).
- **`facebook_reply_to_comment` and `facebook_private_reply` reported `applied` when Graph returned no id.** A reply acknowledged without a comment id, or a private reply acknowledged without a message id, may already be public — or may have spent the one private reply the thread allows — yet both surfaced as clean `applied` writes; the comment reply also invented an `id: ""`. Both now come back `status: "not_applied"` with `outcome: "attempted"`, are journaled as attempted, and carry a note that says which listing tool to check before doing anything else. `replyToComment` returns no `id` rather than an empty one, and a 2xx with no body, a non-object body, or an unusable id all take the same unconfirmed path instead of throwing (CC-NET-2, CC-PUB-1, CC-MSG-2).
- **A comment Graph sent without a `message` was rendered as empty text.** `normalizeComment` filled a missing `message` with `""`, so a comment whose text the token is not allowed to read (or that Graph simply omitted) was indistinguishable from an empty comment. The field is now absent when Graph did not send it and `facebook_list_comments` renders it as `null`; a node with no fields at all still normalizes.
- **The resumable-upload offset probe took a 2xx Graph error envelope for a successful probe.** `probeServerOffset` checked only the HTTP status, so a 200 whose body was `{"error": {...}}` was parsed for an offset, found none, and the upload was reported as having no server offset — hiding the actual refusal. A 2xx whose body is a Graph error envelope is now surfaced as that refusal, never as a missing offset (CC-NET-1).
- **An unrecognized Graph error code the API itself flagged `is_transient: true` was classified `unknown` and non-retryable.** Graph attaches `is_transient` to errors it expects to clear on their own; the classifier never read the flag, and the transport never handed it over, so an unclassified transient fault came back with "inspect then decide" text instead of "retry with backoff". `GraphErrorEnvelope` now carries `is_transient`, the transport parses it off the wire (the boolean `true` only — a `"true"` or a `1` is not a verdict), and `classifyGraphError` turns a flagged code with no matrix row into a retryable `transient`. The flag never overrides a matrix row, and a false or missing flag changes nothing.
- **The doctor knew which Page an `FB_PAGE_TOKEN` belongs to and never said so — nor noticed an `FB_PAGE_ID` naming a different Page.** `debug_token` attributes a Page token to its Page (`profile_id`), and the doctor printed that id as `acting as:` and stopped. With `FB_PAGE_ID` unset the verdict was `ok` with no hint which id to set; with `FB_PAGE_ID` naming another Page the verdict was still `ok`, while every Page-scoped tool would have called that Page with a token issued for a different one. The report now carries a `page binding:` line under `acting as:` and a `warn` finding: `this Page token belongs to Page 4040; set FB_PAGE_ID=4040 …` when unbound, and `… but FB_PAGE_ID names 5050 — Page-scoped tools will call Page 5050 with a token for Page 4040 …` on a mismatch. A token bound to its own `FB_PAGE_ID` adds nothing, and the binding is judged only for the credential that actually acts (a shadowed Page token is not judged). `DoctorTokenReport.pageBinding` exposes the same verdict structurally.
- **A Page token was reported as `acting as: user N`.** `debug_token` returns both `profile_id` (the Page the token acts as) and `user_id` (the user it was issued through), and the renderer preferred the user — false on the wire, where every call is made as the Page. A Page token now reads `acting as: page 4040 (issued to user 999)`; `user N` is printed only when Graph named no Page.
- **`TOKEN NOT CHECKED` sent the operator to "the error line above and the proxy hint" — the error line is rendered below, and the proxy hint was never rendered.** The HTTPS_PROXY / NO_PROXY guidance (CC-NET-6) lives in the failure's `operatorText`, and the doctor stored only the bare message, so a DNS failure read `network request failed: getaddrinfo ENOTFOUND graph.facebook.com` with no hint anywhere on the page. The structured `token.error` and the rendered `error:` line now carry the operator text (`<message> — <hint>`), and the diagnosis points at the line below.
- **When `debug_token` was unreachable, the package matrix declared permissions MISSING that were never observed.** A network fault left the scope set at its empty default, and the matrix was built from it: `[PARTIAL] core missing: pages_show_list, …`, `[BLOCKED] reader missing: …`, one warning per package — verdicts inferred from the absence of an answer, pointing the operator at Business settings for grants the token most likely has. Packages now render `NOT CHECKED — required: … — not checked (the token's scopes were never learned; see Token above)` with `status: "unverified"` and no per-package finding; the token's own `unknown` finding already says why. A malformed or missing token still reports the matrix as before (CC-NET-6).
- **`facebook_create_video_post` reported `applied` for an upload Graph had declined to finish.** For a local file the tool uploads in phases and closes with a `finish` call; when Graph answers that call with `{"success": false}` the video may or may not exist, yet the write gate's default verdict said `applied` and the audit journal recorded a change. The tool now classifies its own result: a declined finish comes back as `status: "not_applied"` with `outcome: "attempted"`, is journaled as `attempted` — not as a change, not as a failure — and carries a notice that a blind retry can create a duplicate. Every write envelope now also echoes the journaled `outcome` alongside `applied`, so a caller can tell an attempted write from a refused one without reading the journal (CC-PUB-1).
- **`facebook_update_ad_object` reported `applied` for an update the Marketing API had refused.** The edge answers a refusal as an HTTP 200 with `{"success": false}`; the tool now classifies that as `status: "not_applied"` with `applied: false` and journals it as a failure, while a confirmed update stays `applied`.
- **A Reel `finish` request the caller aborted was reported as a clean failure.** An `AbortError` raised while the finish POST was in flight was passed through as a plain failure, so the caller was told nothing had been published — when the request may already have reached Graph and published the Reel. That case is now classified `ambiguous`, journaled as `attempted`, and carries the same verify-before-retry guidance as a timed-out finish. An abort during `start` or `transfer` stays a passthrough: nothing was published (CC-MCP-2, CC-PUB-1).
- **A Reel `finish` answered `{"success": false}` was upgraded to a success by a sibling id.** Acceptance was `success === true || namesAnId(rec)`, so a body that both refused the publish and echoed the `post_id` was treated as accepted. An explicit `success: false` now wins; an id only stands in for a missing `success` field.
- **`fetchAll` re-issued the seed request once and could offer a dead cursor as a resume point.** Two contract defects in the exhaustive walker: (1) the seen-cursor set was not seeded with the caller's `after` cursor, so a resumed walk whose first page handed the seed cursor straight back fetched the identical page a second time and duplicated its rows before the loop guard fired; (2) the page/item budget was checked before the cursor sanity checks, so a budget stop could report "resume from the returned cursor" with no cursor at all, or with a cursor the walk itself had just refused to follow — contradicting what `fetchPage` says about the identical response. The seed cursor now counts as walked, and a missing or repeated cursor is reported as such ahead of any budget note. No tool calls `fetchAll` today (every listing uses `fetchPage`), so this is a contract fix (CC-PAGE-5).
- **`setup-token` called a token that dies within hours "long-lived" and wrote it in silence.** The exchange step trusted the endpoint rather than the wire: an `expires_in` of 90 minutes produced `long-lived token obtained (~0 days)`, no warning, and a written `.env`. The step now says `token obtained, but it expires in ~1 hour` (or `~N minutes`), raises a warning that this is not a long-lived token and to re-run with a fresh Explorer token, and the report labels it `under a day — NOT long-lived`. The file is still written — the token works until then — and a System-User token's non-expiring path is unchanged.
- **`facebook_update_post` and `facebook_delete_post` reported `applied` for a write Graph had refused.** Both edges answer a refusal as an HTTP 200 with `{"success": false}` rather than an error, and the write gate's default verdict is "resolved, therefore applied" — so the envelope said `status: "applied"`, the audit journal recorded a change, and only the nested `success: false` told the truth. Each tool now classifies its own result: a refused edit or delete comes back as `status: "not_applied"` with `applied: false` and is journaled as a failure. A delete whose post was already gone stays `applied` — the end state the caller asked for is the end state (CC-PUB-5).
- **A Graph error envelope delivered inside an HTTP 2xx was returned to the
  caller as data.** Graph is known to ship `{error: {code, type, message}}`
  under a 200 on some paths, and the transport trusted the status line: the
  success branch parsed the body and handed it back, so a refused write came
  out looking like an applied one, a throttle went un-retried, and no error
  classification ran at all. The JSON transport now recognises a strict Graph
  envelope — a string `message` plus a numeric `code` or a string `type` — on
  any status and takes the ordinary error path with the real status, so a
  throttle envelope still backs off and retries and a terminal one is
  classified as terminal (a 2xx is never ambiguous). Both upload handlers
  (multipart and resumable chunk POSTs) apply the same rule, so a refused chunk
  can no longer count as a landed one. A 2xx whose body merely contains an
  `error` field that is not an envelope — a per-recipient blocked-map entry, a
  video phase status — still passes through as data.

- **`FB_PAGE_TOKEN` without `FB_PAGE_ID` was accepted in silence, and the error
  it eventually produced told the operator to set the token they had already
  set.** A Page token belongs to exactly one Page and `FB_PAGE_ID` is the only
  setting that names it; with the token alone, startup said nothing beyond the
  generic `no-page` warning (nothing at all next to a profile), and the first
  Page-scoped call failed with "provide a long-lived Page token". Startup now
  emits a `page-token-unbound` warning naming `FB_PAGE_ID` and both ways out
  (bind the token, or use a base token and let the server derive Page tokens);
  it stays a warning because credential-level calls such as `facebook_whoami`
  still work on the bare token, and it does not fire when a base token is also
  set, since that token wins outright and the Page token is reported as shadowed
  instead. The resolver's no-base-token error now says to _bind_ the token
  (`FB_PAGE_TOKEN` with `FB_PAGE_ID=<id>`, or the `FB_PROFILE_<NAME>_*` pair).
  The env reference and `.env.example` say the same.

- **Startup configuration warnings were never shown on a start that succeeded.**
  `assertStartupOk` rendered them only inside the error it threw, so an operator
  whose configuration was merely warned about — an unbound Page token, a missing
  app secret — saw nothing. The bootstrap now logs each warning as one
  `startup config warning` line on stderr (with its stable `code`, `field` and
  message) right after the fail-closed assertion lets the start through.

- **A closed stderr crashed the server with an uncaught `write EPIPE`.** The
  default log sink wrote to `process.stderr` with no `'error'` listener, so the
  first log line after a supervisor or `| head` closed the pipe became an
  unhandled `'error'` event and exit code 1 — the server died because a
  diagnostics line could not be delivered. The sink now attaches one `'error'`
  listener per stream (idempotent across loggers), goes silent after the first
  failure instead of re-raising on every later line (Node's bootstrap stderr
  un-destroys itself after an error, so a listener alone would not stop the
  storm), refuses to write to a destroyed or ended stream, and never throws
  even when a file-backed stderr fails synchronously. This is the stderr
  counterpart of the stdout fix below.

- **A call that named no profile could run under a profile's token.** Per-profile
  token overrides were also loaded into the shared token resolver keyed by Page
  ID, but a profile is always handed its own override before the resolver is
  consulted — so the only entry that map could ever serve was a _different_ one
  on the same Page ID, in practice the default Page. An operator who pointed a
  profile at the default's Page with its own token (a rotation in flight, a
  narrowly-scoped token for one workflow) had every unqualified call act under
  that profile's token instead of the base credential — while the startup line
  still named the base credential as active, and the same Page by raw ID was
  refused as ambiguous one door over (CC-AUTH-6). With no base token the same
  entry also kept `FB_PAGE_TOKEN` from ever being installed. Overrides now stay
  with the profile that declared them, the default Page derives from the base
  credential or uses `FB_PAGE_TOKEN` as documented, and the overrides are still
  registered with the redactor at startup (CC-AUTH-9).

- **A Page token bound to no Page was announced as the active credential.**
  Settings accept `FB_PAGE_TOKEN` as the only credential as long as _some_ Page
  is configured, but a long-lived Page token belongs to exactly one Page and
  `FB_PAGE_ID` is the only setting that names which — a profile Page takes
  `FB_PROFILE_<NAME>_TOKEN`. So `FB_PAGE_TOKEN` plus a profile and no
  `FB_PAGE_ID` passed startup, was logged as the active credential, and then
  every Page-scoped call failed asking the operator to "provide
  `FB_PAGE_TOKEN`", which they already had. Startup now warns once that the
  token is bound to no Page and names the three ways out: set `FB_PAGE_ID`, give
  each profile its own token, or configure a base token (CC-AUTH-9).

- **A single-photo upload whose response named a post but no photo id now tells
  the operator which post to inspect.** When Graph answered a `/{page-id}/photos`
  POST with a 2xx that carried `post_id` but no `id`, the upload was correctly
  reported as an ambiguous write, but the message only said to "check the Page
  for a stray photo" — the post id Graph had just returned was read after the
  throw and discarded, so the operator had to search the whole Page for a post
  whose handle the server already held. The ambiguous error now names that post
  id in both its message and its structured action detail (only when it is a
  real string; a numeric id is never stringified, since it may already have lost
  digits in JSON parsing). The outcome is still classified ambiguous and is still
  never retried automatically — verification becomes a direct lookup instead of
  a hunt.

- **A client that stopped reading the server's stdout crashed the stdio server
  with an uncaught `write EPIPE` and exit code 1.** The SDK's stdio transport
  writes to `process.stdout` without an `'error'` listener, so the first
  response after the peer closed its read end became an unhandled `'error'`
  event instead of the clean shutdown that stdin EOF already triggers.
  `startStdio` now listens for stdout `'error'`, logs the first failure once,
  and routes it through the same memoized close path (abort signal, transport
  close, `closed` promise) as stdin EOF (CC-MCP-5). The listener is never
  removed, because an in-flight response can fail after close and would
  otherwise turn a clean exit into a crash. Covered by a spawned-process test
  that destroys the reader's end of stdout and asserts exit code 0 with no
  `Unhandled 'error' event` on stderr.

- **A frame the server could not parse — or a response it could not send — left
  no trace anywhere: the client hung and stderr said only "connected".** The SDK
  reports such failures through `transport.onerror`, and nothing in the server
  ever set that hook, on either transport. Both `startStdio` and `startHttp` now
  install a logger-backed `onerror` before `connect`, so every malformed stdin
  line, non-JSON HTTP body, or failed send lands on stderr as
  `<kind> transport error` with the SDK's own reason. Behaviour on the wire is
  unchanged: the SDK still drops the frame or answers 400 as before.

- **A journal record written after a crash mid-write was glued onto the torn
  last line, so both the torn record and the good one behind it became
  unparseable.** The journal is append-only and trusted `appendFile` to leave
  the file ending in a newline; a process killed (or an `ENOSPC`) in the middle
  of a write leaves it without one. `writeLine` now inspects the last byte of
  the live file before appending and prefixes a newline when the previous record
  was not terminated, so a crash costs exactly one bad line and never the record
  that follows it (CC-LIFE-2). The torn line itself is never rewritten. Readers
  should skip a line that does not parse rather than stop at it; the module
  header now says so.

- **Insights `total` for `week`, `days_28` and `lifetime` metrics was a sum of
  overlapping windows — up to 28 times the real figure.** Graph answers these
  periods with one point per day, each already covering the trailing 7 / 28
  days (or, for lifetime, the cumulative count), and the per-metric summary
  added every point together: a Page with a steady 100 views per 28 days
  reported `total: 3000`, and that sum is the headline of aggregate mode
  (CC-INS-4). For an overlapping period with points on more than one date the
  total is now the newest date's value (across breakdown keys), chosen by date
  value rather than array position, flagged `totalIsLatest: true`, and the
  notes say why; `day`, `month` and `total_over_range` totals are still sums.
  The `aggregate` argument's description states the rule.

- **`facebook_get_conversation` could declare the 24-hour messaging window
  closed while it was open.** The verdict was computed from whichever page was
  read, but a continuation page (`after`) is older than the first page by
  construction, so its newest inbound message is only a lower bound on how
  recently the person wrote — it can prove the window open, never closed.
  Reading page 2 of a thread whose fresh reply sits on page 1 reported
  "CLOSED, last message 30h ago" with a closing time, and a model reading that
  stops replying to a person it was entitled to answer (CC-MSG-1). A `closed`
  verdict on a continuation page is now downgraded to `unknown`, with no
  `closesAt`, and the explanation points at the first page or at
  `facebook_send_message`, which probes the newest messages itself. `open` on
  any page is unchanged.

- **A Messenger thread whose one message carried a `null` sticker, attachment
  name or share link could not be read at all — and could not be replied to.**
  `sticker`, `attachments[].name` and `shares[].link`/`name` are declared
  strings and were measured with `.length`; a `null` on the wire threw a
  `TypeError` inside the page-shaping pass, which cost `facebook_get_conversation`
  the whole page and made `facebook_send_message` fail before planning, since
  its window probe reads the same page (CC-NET-2). The four reads now go
  through one non-empty-string helper: a malformed field costs only itself, the
  rest of the message and the page survive, and a non-string sticker is no
  sticker.

- **`facebook_block_user` / `facebook_unblock_user` spoke a `/blocked` dialect
  Graph does not have — an unblock that landed was reported as "nothing was
  applied".** Both tools sent a `psids` parameter; the documented name is
  `psid`, on POST and DELETE alike. Worse, the unblock path issued ONE DELETE
  carrying a JSON-encoded list and then read the answer as a per-PSID map —
  but Graph answers a DELETE with a `{success}` struct, so every PSID came back
  "Facebook returned no result", the batch was recorded as failed, and the
  operator was told the unblock had not happened after it had. The block call
  now posts the `psid` list and reads the documented per-id map (looked up with
  `Object.hasOwn`, so `constructor` or `__proto__` as an id can no longer read a
  result off the prototype chain); the unblock call issues one DELETE per PSID,
  reads the `{success}` struct, isolates a per-PSID failure so the remaining
  DELETEs still run, and normalizes "not blocked" to success-with-note like the
  other idempotent writes. The shape follows the official Page `/blocked`
  reference; it has NOT been exercised against the live API — the smoke suite
  excludes block/unblock by design, and the existing unit tests had asserted the
  wrong wire shape and were corrected.

- **`facebook_whoami` said a token was invalid without ever saying why.** Graph
  rejects a token INSIDE a 200 — `is_valid:false` with the cause in
  `data.error` — so an expired, a revoked and a wrong-app token never reach the
  error path at all; they arrive as perfectly successful calls. The API layer
  already normalized that cause into `invalidReason`, but the tool that tells the
  operator to "run this first to diagnose auth problems" dropped it, and all
  three failures read identically: `valid:false`, no subject, no reason. The
  reason is now surfaced as `error`, the same field the doctor uses for the same
  purpose. An explicit error still wins: on the throw path the thrown message is
  what actually happened.

- **`facebook_list_pages` passed one window of Pages off as the complete set.**
  The tool reads a single page of `/me/accounts` and follows no cursor, and it
  asked for no page size — so Graph applied its own edge default of 25, which
  cuts an ordinary agency account without anyone having requested a limit. The
  payload then reported `count`, which reads as "this is how many Pages you
  have", and the evidence to the contrary was gone by construction: the shaper
  strips every `paging` object before the result exists. The call now asks for
  100 and decides `hasMore` on the RAW body before shaping, and a cut listing
  carries a note saying so — because an operator whose Page is outside the window
  must read "the listing was cut", never "your Page does not exist", which sends
  them to re-check roles and asset assignments for a Page the token can see
  perfectly well. An unreadable `paging` counts as no evidence of more, never as
  a throw.

- **A type-filtered `facebook_get_reactions` read emitted the ALL-TYPES figure
  under the name `total`.** The API layer asks Graph for the all-types summary on
  every reactions read, filter or no filter, so a filtered read came back with a
  one-key `totals` and a number spanning every reaction type. Emitted as `total`
  beside `type:"ANGRY"` and `totals:{ANGRY:3}`, the larger number reads as the
  answer to "how many angry reactions" — and the tool's own description tells the
  model to report `total` rather than count the reactor list, so the misreading
  was the one it had been instructed to make. Under a filter the figure is now
  named `allTypesTotal`, which cannot be mistaken for the filtered count;
  unfiltered, `total` is exactly what it says and keeps its name.

- **A `null` write gate crashed as a `TypeError` instead of naming the wiring
  bug.** `writeGateOf` is a runtime check precisely because `ToolContext` does not
  declare `writeGate` — whatever the bootstrap attached is unverified at that
  seam — but it tested only for `undefined` before reaching for `.execute`. Any
  mis-wiring that writes an absence down as a value (`lookup() ?? null`, a
  context rebuilt from JSON, a JS consumer of the package barrel who meets no
  type checker at all) therefore produced `Cannot read properties of null`, which
  names no tool, names no cause, and reads like a crash in the write path rather
  than a server that was never wired — the exact confusion the dedicated error
  exists to prevent.

- **The "application limit reached" throttle (code 341) was reported as an
  unclassified error and never backed off.** Meta ships 341 in the same
  temporary, self-clearing family as codes 4, 17, 32 and 613, but it appeared in
  neither the error matrix nor the transport's throttle set — so it reached the
  model through the unknown-error path, with no next tool and no cool-down, and
  the retry loop treated it as a terminal failure. It is now classified as the
  rate limit it is, carries the 60s cool-down estimate, honours a Graph-supplied
  ETA and points at `facebook_usage`. The two tables are edited in different
  files, so a new test asserts the invariant directly: every rate-limit row that
  promises a retry must be a code the transport actually throttles.
- **A rate limit arriving as a bare HTTP 429 was reported as an unclassified
  error, and the diagnosis for it was thrown away.** Facebook sends its own
  throttles as HTTP 400 with a body code, so a 429 carrying no Graph envelope
  came from an edge, a CDN or an intercepting corporate proxy — and the transport
  already read it that way and backed off. The classifier did not: it filed 429
  with every other unparseable 4xx as `unknown` and not retryable. An un-retried
  429 therefore reached the model as a mystery failure it was told not to repeat,
  and once retries were exhausted the two disagreeing readings cancelled each
  other out, replacing the whole explanation with the six words "rate limited —
  back off and retry later" and dropping the proxy and TLS-interception hint in
  the exact situation that produces it. A bare 429 is now classified as the rate
  limit it is, keeps that hint, surfaces a 60s cool-down estimate, and points at
  `facebook_usage` to check whether Graph is throttling you as well.
- **A missing permission usually arrived as an unclassified error, with advice to
  consider trying again.** Meta documents 200-299 as a single "API Permission"
  family whose code varies with _which_ permission is missing, but the matrix knew
  only 200, 10 and 803. Everything else — `(#294)` for `ads_management`, `(#240)`
  for `business_management`, `(#210)` for a user not visible — fell through to the
  unknown-error path, which closes by inviting you to decide whether the action is
  safe to repeat. It never is: a missing scope or Business asset assignment
  refuses the identical call forever until a person grants access, so the guidance
  pointed at the one route that cannot succeed and offered no next tool. The whole
  family is now classified as a permission failure, states that retrying changes
  nothing, and points at `facebook_whoami` to see which scopes and Page tasks the
  current token actually has. The exact 200, 10 and 803 rows keep their more
  specific wording.
- **A log field named `__proto__` never reached the line.** `LogFields` is an
  open record, so a caller spreading a parsed Graph object into it can carry the
  key as an own property; the record builder assigned it plainly and the
  inherited setter swallowed the value. The field is now defined, so what the
  caller logged is what an operator reads.
- **A profile name with an underscore was refused, though the README documents
  one.** `FB_PROFILE_<name>_PAGE_ID` accepted only letters, digits and hyphens in
  the name, so `FB_PROFILE_acme_uk_PAGE_ID` was parsed as a profile the loader
  then rejected — the operator's config was correct and the server said it was
  not. Underscores are now accepted.
- **A profile key had to be typed back in the exact case the loader stored it
  in.** Settings lowercase every profile name, so an operator who wrote
  `FB_PROFILE_Acme_PAGE_ID` reads `Acme` out of their own env and gets "Unknown
  Page reference" for it — a message that sends them to fix a config that was
  never wrong. A profile key now matches case-insensitively and ignores
  surrounding whitespace. Two configured keys that differ only in case are
  refused as ambiguous rather than folded onto whichever came first: injected
  settings can carry both, and folding them would land a write on the wrong Page
  with nothing saying the reference was ambiguous (CC-AUTH-6).
- **An env file that could not be read was swallowed.** The file was loaded
  before the problem reporters existed, so a permissions error or a malformed
  line was dropped on the floor and the operator saw only the downstream symptom
  — "no access token configured" — for a file that was right there and unreadable.
  The load now happens after the reporters and its failure is reported as a
  config warning naming the path.
- **A listing that ended early could read as a complete page.** `finish` sliced
  the rows down to `maxItems` but kept the caller's `truncated` flag and note, so
  a walk that stopped because the edge ENDED came back marked complete while rows
  had in fact been dropped — the one shortfall a caller cannot detect from the
  page itself, since the page is exactly `maxItems` long. The slice now owns
  saying it sliced (CC-PAGE-5).
- **A `fields` override that asked for comment or reaction ROWS got a count
  instead.** Normalisation flattened `shares`, `comments` and `reactions` into
  scalars and dropped the nested object unconditionally, which is right for the
  default field sets — they ask for `.limit(0).summary(total_count)`, so the
  summary is the whole payload. An override like `comments{message,from}` asks
  for the rows themselves, and those were discarded: a post was reported as
  having no comments moments after Graph handed them over. The three keys are now
  dropped only when they carried nothing but the count.
- **A node id Graph sent as a number was erased instead of read.** Graph encodes
  the same id field as a JSON string on one build and a bare number on another —
  the reason `readReportRunId` exists in the same module. `normalizeAdNode`
  accepted only a string, so a numeric id became `''`, and because a blank string
  still satisfies the declared `id: string` the record looked well-formed while
  its identity was gone. A number that is exactly representable is now coerced;
  one that `JSON.parse` has already rounded is still refused rather than minted
  into a plausible id for an object that does not exist (CC-NET-2).

- **A journaled write could be lost to its own metadata.** The audit journal is
  the only durable record that an irreversible write happened, and `append` built
  its line by handing the whole entry to `JSON.stringify` — which throws on a
  cycle and on a `bigint`, both of which reach it through metadata copied off an
  unvalidated Graph response. The throw was caught and reported as a failed
  append, so the write went out and nothing on disk said so. The entry now goes
  through the same structural clone the result path uses before it is serialized,
  which is where a `bigint` becomes its digits and a back-edge becomes
  `[CIRCULAR]` — the record survives in the shape that made it awkward.
- **`ok` from the journal did not mean a readable record was on disk.** If
  redaction returned something `JSON.stringify` drops — `undefined`, a function,
  a symbol — the template that built the line interpolated the four letters
  `undefined` into the file and the append reported success. A corrupt line is
  worse than a missing one: it survives review, and it breaks the parse of
  everything that reads the journal back. Serialization now refuses a non-string
  rather than writing one, and the refusal is reported as the failure it is. No
  fallback line is built from the raw entry on purpose — redaction is the C3
  chokepoint, and an unscrubbed record must not reach disk.
- **The result shaper could be walked off its own guarantee.** `shapeResult`
  promises to hand back something `JSON.stringify` will accept, and two inputs
  broke that promise: nesting deeper than the engine's own recursion limit
  (`JSON.parse` accepts more nesting than a naive walk survives, so a reply the
  HTTP layer had already parsed could take the shaper down), and an own
  `__proto__` key, which plain assignment does not store — it re-parents the
  clone and silently drops the key. The walk now cuts at the same `MAX_DEPTH` the
  redactor uses, checked after the leaves rather than before, so the cut costs a
  subtree and never a stripped token; and own keys are written with
  `Object.defineProperty`, so a `__proto__` arriving from Graph is carried as
  data instead of changing the object carrying it.
- **Rendering tainted content could throw instead of quarantining it.**
  `renderTainted` wraps every piece of visitor-authored text the server hands
  back, and it serialized non-string content with a bare `JSON.stringify`. The
  one function that exists to make hostile input safe was itself reachable by
  hostile input. It is total now: content that cannot be serialized renders as a
  sentinel inside the envelope, which is what the envelope is for.
- **A budget change Facebook refused was reported with the full list of changes
  it "applied".** `applyAdObjectUpdate` read Graph's `success` flag correctly but
  still handed back `plan.changes` — the changes that were _asked for_ —
  whatever the answer was. That outcome is what the write gate journals and shows
  the model, so a refused edit arrived as `success: false` sitting beside a
  confident account of what changed on an account that changed nothing. On a
  refusal the confirmed set is now empty; what was attempted is still recorded,
  in the gate's `changedFields` metadata and the echoed params.
- **The archived/deleted refusal (CC-ADS-4) trusted Graph to shout.** `status`
  and `effective_status` arrive as an unvalidated cast off the response body, and
  the guard that stops an archived object from being resumed compared them
  against an exact-case set. One `archived` from a future API version or a
  partner proxy and the refusal did not fire: the plan was built and the spend
  gate armed for a write Graph refuses anyway. Both fields are now folded before
  every comparison — as the operator's own `status` input already was — which
  also restores the "status is already PAUSED" notice telling a confirmer the
  write would change nothing.
- **`end_time: null` was read as "this ad set has an end date".** Graph answers a
  field it was asked for and that is unset with `null`, not by omitting it, and
  the lifetime-budget warning was gated on `undefined`. The one notice explaining
  why the lifetime budget about to be sent will bounce was dropped in exactly the
  case it was written for.
- **An insights metric could be returned with its own rows and a note saying its
  name is invalid.** Requested metric names are folded to Graph's canonical
  spelling so request and reply speak one vocabulary — but only the request half
  was folded. The reply's `name` is a declared string nothing had checked, so an
  entry echoed in another casing missed the match and landed in
  `unavailableMetrics` while its data sat in the same payload. The reply is not
  more trustworthy than the request; both are folded now.
- **A reschedule could silently skip the 29-day creation window.** The CC-SCHED-1
  bound on how far a scheduled post may be moved past its own creation is applied
  only when Graph reported a usable `created_time`; when it did not, the check
  was skipped and nothing said so. A preview that omits a check reads exactly
  like a preview that passed one, so the operator confirmed a move Facebook then
  refused on apply. The plan now names the check that did not run.
- **A video or Reel upload could spend the whole file against a node that does
  not exist.** Graph node ids run past the safe-integer range, so an
  `upload_session_id`, `video_id` or `post_id` that arrives as a JSON number has
  already lost its low digits by the time `JSON.parse` hands it over — and both
  media modules coerced it with `String(n)`, minting a plausible-looking id for
  nothing. On the start path that id became the target every chunk was POSTed
  into; on the finish path it was handed back as the video the caller then
  polled and published, while the video they actually uploaded went unwatched.
  Both edges now report no id, which is the branch their callers already fail
  closed on: `start` refuses before a byte moves, and `finish` keeps the id the
  start phase assigned.
- **A Reels publish that Graph had confirmed could be reported as
  `ambiguous`.** Refusing a rounded numeric `post_id` must not be re-read as
  "Graph confirmed nothing": naming an id is acceptance, and whether the digits
  survived the wire is a separate question. The two are now asked separately, so
  the operator is no longer sent to verify a live Reel over an optional field —
  a Reel is addressed by its `video_id`, which the module has held since the
  start phase.
- **The redactor's one promise — "no false negatives" — held only for the exact
  spelling it was handed.** Value-based redaction matches the configured secret
  as a literal string, but `FB_HTTP_TOKEN` and `FB_CONFIRM_TOKEN` are chosen by
  the operator, and a randomly generated bearer token is naturally base64: `+`,
  `/`, `=`. The moment such a token travelled through a URL or into an NDJSON
  journal record it no longer matched itself, and the primary strategy — the one
  the pattern scan exists only to back up — silently stopped seeing it. A secret
  is now registered together with every wire form it can take: percent-encoded,
  form-encoded (which spells a space `+`, not `%20`), and JSON-escaped.
- **Three ways to make the scrubber throw, on the one code path that runs while
  something has already gone wrong.** `redact` promises a JSON-safe clone and the
  logger and the write journal take that at their word. A `bigint` leaf was
  handed straight back, and `JSON.stringify` refuses one outright — so the record
  was not degraded, it was destroyed. A payload nested deeper than the walk could
  recurse threw a `RangeError`, and `JSON.parse` accepts nesting thousands of
  levels deep, which made the parser the _more_ permissive of the two: a body the
  server had already accepted could take down the line that was meant to report
  it. And one property whose accessor threw aborted the whole walk. A bigint is
  now emitted as its decimal string, descent past a depth bound is cut with a
  marker, and a broken accessor costs its own key and nothing else.
- **A page on a rebound DNS name could reach the HTTP transport without ever
  presenting an `Origin` for the rebinding check to reject.** The check is sound
  as far as it goes, but a page served from a name that re-resolves to 127.0.0.1
  is same-origin with the server it is attacking, and a same-origin `GET` — the
  Streamable-HTTP event stream is one — carries no `Origin` header at all. The
  bearer token is still the credential that stops the attack, and it held; the
  `Host` header, which names where the browser believes it is going and is the
  one header the attack cannot spell as loopback, is now validated the same way
  `Origin` is. Hostname only: a port-forward in front of the server is a setup,
  not an attack.
- **The HTTP transport answered `401` to clients holding the correct token.**
  RFC 7235 §2.1 makes the `auth-scheme` name case-insensitive and allows more
  than one space before the credential; the check matched the literal prefix
  `Bearer `. A client spelling it `bearer` was refused with the same status as a
  client presenting a wrong secret — the one failure an operator has no way to
  tell apart from a real one. The scheme is now matched per the RFC; the
  credential itself stays exact and is still compared in constant time.
- **One malformed row on the wire could destroy a whole page of messages or
  comments the caller had already paid for.** `fbRequest<T>` casts the parsed
  body (`data as T`), so a field declared `string` is a hope about Graph rather
  than a fact about it — and the per-row shapers spent those fields immediately.
  A `created_time` that arrived as a bare epoch reached `String.prototype.replace`
  inside `parseGraphTime`, a numeric `mime_type` reached `.toLowerCase()`, an
  edge whose `data` was not an array of objects reached `.map` and then its
  shaper, and `getComment` dereferenced `.comments` on a body that a bodiless 2xx
  had already parsed to `undefined`. Each is a `TypeError` thrown from the middle
  of a page walk, so it cost the caller every sound row alongside the bad one.

  Every shaper is now total: an unusable field is dropped and the rest of the row
  still shapes, junk rows inside a nested edge are filtered before they reach a
  shaper — the rule `parsePage` already applied to top-level rows — and
  `attachmentNames` stays index-bound to the placeholders it annotates. Graph
  node ids get the treatment `graphId` established for the token-debug identity:
  strings only, never coerced. A numeric id has already lost digits by the time
  `JSON.parse` is done with it, so `String(n)` would mint a plausible-looking id
  that addresses nothing — and for a Messenger sender id that id becomes the
  `recipient` of a reply, which is a message delivered to the wrong person rather
  than a cosmetic error. The one place the coercion was written out in full,
  `report_run_id`, now accepts only a number that is exactly representable;
  anything rounded is refused into the existing "nothing to poll" error instead
  of handing back a run id that would poll forever while the run that really
  started is orphaned.

- **An exhausted retry threw away the one number the caller could still act
  on.** Honouring `Retry-After` while retrying is only half of it: once the
  budget is spent the wait the server named stops being something this process
  sleeps on and becomes the only concrete figure the caller has. It was dropped —
  a bare `HTTP 429` with `Retry-After: 300` carries no Graph envelope, so the
  exhausted error surfaced whatever generic estimate the F06 row happened to
  hold, and an exhausted 503 with a maintenance window surfaced nothing at all.
  Both now surface the server's own wait as `retryAfterMs`, uncapped: the 60s
  `maxDelayMs` bounds how long this process will block (CC-NET-3), but it says
  nothing about when the endpoint will answer, and clamping the surfaced figure
  would tell a caller holding a five-minute block to come back in one — which is
  how a client that was told better escalates a soft throttle into a hard one.

- **The one error a lost write produces was the one error that did not scrub
  its credentials.** `ambiguousError` built both the surfaced message and the F06
  operator guidance by interpolating an error message read straight off the wire,
  with no `redactor.redactString` anywhere on the path — while `networkError`, the
  next function in the same file, had always redacted both. A transport fault
  quotes the URL it failed on, and on a `DELETE` that URL carries
  `appsecret_proof` in the query string (only a POST moves it into the body), so a
  network fault during a delete could put a live credential into a string that is
  logged, journalled and returned to the model. That path is also the one an
  operator reads most closely, because it is the one that says a write may already
  have landed. The detail is now redacted into the action's text and the whole
  message redacted over the top, exactly as the network-fault path does it, so the
  three call sites can quote the wire without also quoting the credential.

- **The server told us when to come back and the client threw the note away.**
  `Retry-After` appeared nowhere in the transport: the retry loop slept on its own
  exponential schedule and on `estimated_time_to_regain_access`, so an endpoint
  that answered "come back in five seconds" got the next attempt roughly half a
  second later. Worse, the one status HTTP reserves for exactly this — a bare
  `HTTP 429` from an edge, a CDN or a corporate proxy in front of Graph, carrying
  a `Retry-After` and no Graph body code to key on — was classified `terminal`:
  never retried at all, and surfaced to the operator as a non-retryable `unknown`
  rather than as a rate limit. The module's rule that a Graph throttle arrives as
  HTTP 400 with a body code (CC-NET-1) is a true statement about Graph, not about
  the hops in front of it.

  Both spellings of `Retry-After` are now honoured as the backoff base —
  delay-seconds and HTTP-date, the latter measured against the injected clock so
  it is the wait that _remains_ — with a zero, an unparseable value or a date
  already past falling back to the exponential schedule the same way a zero
  regain-access ETA does (CC-NET-3), and the 60s cap still bounding the other
  direction. Where a response carries both a header and an ETA the longer of the
  two governs, since under-waiting on a block is how a soft throttle becomes a
  hard one. A bare 429 now takes the throttle path for reads and writes alike,
  which is safe under C2 because a 429 is a rejection rather than a processed
  request, and an exhausted one reaches the operator as `rate_limit`.

- **A resumable upload asked the server where to resume and never looked at
  whether the server had answered.** The `rupload` offset probe parsed
  `file_offset` out of the response without reading its HTTP status first — and a
  401, a 403 or a 400 carries no offset for exactly the same trivial reason an
  empty 200 carries none. So a token that expired or was revoked mid-upload
  collapsed onto `undefined`, which the resume path reports as the retryable
  `server offset unavailable to resume`: the client kept re-probing an endpoint
  that had already told it, in the clearest terms HTTP has, that it would never
  answer again. The probe now classifies its own response through
  `graphErrorFromResponse` before parsing, so an auth failure surfaces as the
  permanent error it is while a 503 stays transient and retryable with its status
  intact, a redirect is refused rather than followed off the allowlist, and the
  error text goes through the redactor like every other surfaced body.

- **Both report renderers could be destroyed by a single number they were asked
  to print.** `facebook_doctor` and `setup-token` rendered every timestamp with
  `new Date(ms).toISOString()`, which is not a formatting call that can go wrong
  quietly: for a `NaN` or out-of-range epoch `new Date(ms)` is an Invalid Date
  and `toISOString()` throws `RangeError: Invalid time value`. The throw happened
  _inside_ the renderer, so an unreadable expiry did not cost the operator the
  expiry line — it cost them the diagnosis, the credential, the permissions and
  every other line, at the exact moment they ran the command to find out what had
  broken. Reaching it took no malice from Graph, only wrongness:
  `JSON.parse('{"expires_in":1e400}')` yields `Infinity`, and `now + Infinity`
  rode straight into the renderer. Both `iso()` helpers are now total — an
  unreadable epoch prints as `(unreadable timestamp)` and the rest of the report
  survives — and the `expires_in` exchange rejects a non-finite value, and one
  landing past the widest epoch a `Date` can hold, before it is stored: an expiry
  that cannot be expressed as a date is an expiry we did not get, which the
  existing "expiry not reported by Graph" wording already says honestly.

- **`debug_token` trusted the rest of Graph's body the same way it trusted the
  token type: not at all, but silently.** The `/debug_token` payload reaches the
  parser through a cast, so every field declared `string` or `number` was a hope
  about the wire rather than a fact about the value. Three of them were then used
  as if the hope had been checked. A non-string `type` hit
  `(raw ?? '').toUpperCase()` and threw a `TypeError` out of `debugToken` — which
  took down `facebook_doctor`, the one command an operator runs _precisely_ when
  their token has stopped working, so the crash landed exactly where the
  diagnosis was needed. A non-numeric `expires_at` multiplied out to `NaN` and
  rode all the way to the report's `new Date(ms).toISOString()`, which throws
  `RangeError: Invalid time value` — the same lost report, one step further
  along. And a non-string `app_id`, `profile_id`, or `user_id` was handed on
  typed as a string, which matters most for `profile_id`: it becomes the report's
  `actingPageId`, an id an operator may go on to address a Page with. The payload
  interface is now `unknown` field by field, so the compiler forces each one
  through a guard: an unreadable type lands on `UNKNOWN` (what that fallback is
  for), a junk timestamp is dropped rather than coerced — reported as
  never-expiring, which is wrong but _warned about_, where the `RangeError` cost
  the whole report — and a non-string id is dropped rather than stringified,
  because Graph ids run past the safe-integer range and `String(n)` on one that
  has already lost digits to `JSON.parse` would mint a plausible id pointing at
  nothing.

- **Every paginated listing cast Graph's rows to the shape it wanted them to
  have.** `parsePage` checked that `data` was an array and then wrote
  `rawData as readonly T[]` — which proves the edge is a list and proves nothing
  about what is in it. Every shaper downstream reads fields off what it is
  handed, so a `null` row threw on `.id` and took an entire listing down, while a
  string or number row answered `.id` with `undefined` and became a result with
  no identity — a participant, comment, post, or ad row that looks real and
  cannot be acted on. This is one helper, so it was every listing edge in the
  server at once. Rows that are not objects (arrays included — an array is an
  object, and a shaper would read `.id` off it just as happily) are now dropped
  and **counted**, and the count reaches the caller as a note, because a silently
  shorter list is the one failure a caller cannot detect: `data: []` with no note
  is a truthful "there is nothing here", and five unusable rows is a different
  fact. The count accumulates across a whole `fetchAll` walk and is joined with —
  never replaced by — a budget, cursor-expiry, or loop-guard note, since how
  trustworthy the rows are and whether there are more of them are two different
  questions.

- **`debug_token` reporting a token invalid produced a verdict with no cause.**
  Graph does not answer an invalid `input_token` with an HTTP error — it accepts
  the call and rejects the subject, returning 200 with `is_valid: false` and the
  reason in `data.error`. Nothing read that field, so the common path to
  `token_malformed` reached the doctor as a bare boolean: the report printed
  `TOKEN MALFORMED OR INVALID — re-issue it` above an empty `error:` line, and an
  expired token, a revoked one, and one issued by a different app were
  indistinguishable — on the one command an operator runs precisely because they
  do not yet know what is wrong. `DebugTokenInfo` now carries an `invalidReason`
  parsed defensively from that in-band error (a non-string `message` or a
  non-numeric `code` is dropped rather than printed as `[object Object]` or
  `NaN`, and a valid token never reports one), and the doctor renders it through
  the redactor, since Graph's message can quote the credential back.

- **A write gate built without a confirmer performed `irreversible` and `spend`
  writes with no confirmation at all.** The out-of-band seam is the one control
  those tiers have that `FB_WRITE_MODE` cannot bypass, but the gate consulted it
  only `if (deps.confirmer)` — so a gate constructed without one did not fall
  back to refusing, it fell through to performing. The dependency was optional in
  `WriteGateDeps`, and `createWriteGate` is exported from the package barrel,
  where a JS caller meets no type checker and a TS caller can spread the field in
  from a partial. The seam is now **required**, and re-checked at runtime: a
  high-consequence apply that reaches the gate with nowhere to ask is refused
  with a new `confirmation_unavailable` code rather than performed. It is
  deliberately not `confirmation_denied` — a denial is an answer the operator
  gave, this is a broken install, and conflating them would tell an operator
  someone declined a write nobody was ever asked about. The shipped server is
  unaffected: it has always defaulted to a real confirmer.

- **The doctor printed `ACTION:` and `OK — nothing needs attention` in the same
  report.** Three separate paths reached the verdict without contributing to it,
  and each one made `doctor --strict` exit 0 on an install that had not checked
  out. A metric name Graph answers 200 to and simply never mentions — the silent
  drift the check exists to catch — produced no finding at all, though the notes
  above already counted it. A metric-set probe whose call died before ruling on a
  single name was `warn`, i.e. "degraded", when the report's own note says it
  "says nothing about whether they are still valid": that is "nothing was
  established" wearing the wrong label, exactly what the `unknown > warn` ladder
  is written to prevent. And a probe that threw returned the same
  `available: false` as a probe that was never wired up, while `summarizeDoctor`
  never looked at the probe reports at all — so `ad account: failed (connect
ETIMEDOUT act_1)` could sit directly above `OK`. The unknown verdict now
  reaches the summary, a failed probe is distinguished from an absent one by a new
  optional `failed` flag on `MetricProbeReport`, and both hold the verdict at
  `unknown`.

- **Graph declining to answer was recorded as a verdict on the token.** The
  token inspection treated any `GraphApiError` with a status at or above 400 as
  "Facebook has ruled", so a Meta outage (5xx) and a throttle — which arrives as
  HTTP **400** with a body code, CC-NET-1 — both became `token_malformed`, and the
  report told the operator `TOKEN MALFORMED OR INVALID` and to re-issue it. They
  rotate a live credential while the real fault is somewhere else, and the whole
  point of the separate `token_check_failed` diagnosis is to keep those apart. A
  ruling now requires a 4xx whose category is neither `transient` nor
  `rate_limit`; a real 401 or code 190 still condemns the token.

- **A journal write that failed after a successful delete was raised as if the
  delete had failed.** `runApply` wrapped `perform`, `classifyResult` and
  `journal.append` in one `try`. When only the last of those broke — a full disk,
  a read-only state dir — the post was already gone from Graph and the sole
  casualty was the local record, yet the promise rejected, the `catch` attempted a
  second `append` that failed the same way, and the journal's error was what
  reached the model. It reads that as "delete failed", the obvious next move is a
  retry, the plan is spent, so it re-plans and applies again: one authorization,
  two mutations. `ApplyResult.journalStatus` exists precisely to carry this as a
  fact about the RECORD rather than about the write. Only `perform` stays inside
  the failure-classifying `try`; everything after it goes through a
  `journalQuietly` that returns `'failed'` instead of rejecting.

- **A broken journal replaced the real Graph error with its own.** On the failure
  path the same `catch` awaited `journal.append` before re-throwing, so a write
  that failed with `(#200) insufficient permission` while the disk was full
  surfaced as `ENOSPC`. The Graph error is the only one that says whether the
  write reached its target. The record is still attempted; the cause that
  propagates is the one from Graph.

- **A `classifyResult` hook that threw un-said a mutation that had already
  landed.** The hook reads a response shape it did not build, so a Graph payload
  shaped differently today makes it throw — which is a bug in the verdict, not
  evidence that the mutation did not happen. It was journalled as `failed` and
  raised, feeding the same duplicate-write retry. It now runs in its own `try`:
  a throw keeps the documented `APPLIED_VERDICT` default and the journal entry
  admits the verdict was never computed. Symmetrically, a `classifyOutcome` that
  throws yields `'attempted'`, never `'failed'` — a classifier that blew up has
  not told us the write did NOT land.

- **An unrecognised write tier failed OPEN through `FB_WRITE_MODE=apply`.** The
  gate keyed on a denylist of high-consequence tiers, so any tier outside the
  `WriteTier` union — reachable from a JS consumer of the published `authorize` /
  `createWriteGate`, or a handler compiled against a newer union — read as "not
  high-consequence" and executed immediately under `apply`: no `plan_id`, no
  confirmer, unknown blast radius. It is now an allowlist of the two tiers an env
  var may bypass (`safe`, `reversible`); everything unknown lands on the guarded
  side. Behaviour for the four known tiers is unchanged.

- **A stored plan held its `params` by reference instead of by snapshot.** The
  plan's fingerprint mutated along with the caller's own object, so the
  `deepEqual(plan.params, action.params)` binding at apply time compared an object
  with itself, matched unconditionally, and executed a write nobody had reviewed —
  under the summary that WAS reviewed, with a `plan_id` asserting the two agreed.
  The preview says "Delete post 123" and the apply deletes `999`. `storePlan` now
  pins a copy of exactly the backbone `deepEqual` walks. No handler in the repo
  mutates `params` between the two `tools/call`s today, so this was latent — but
  the control depended on the caller's discipline rather than on itself.

- **`FB_PACKAGES_READONLY` failed open on a tool with a missing `writeTier`.**
  `defineTool` cross-checks the two independent read-only signals, but
  `createRegistry` does not consume `defineTool` — it consumes an injected
  `PackageSpec[]` that is never re-validated. A write tool that lost its
  `writeTier` (added later, copy-pasted from a read tool) still advertised
  `readOnlyHint: false` to the client and still mutated, while the operator had
  asked for a deployment that cannot write. The drop is now on the union of both
  signals: a missing field may cost a tool, never the guarantee.

- **The rotated journal generation inherited whatever permissions it was
  carrying.** The live file heals itself with `chmod 0600` after every append;
  rotation is the one place the module creates a SECOND file, and `rename` carries
  the mode across, after which nothing ever looks at `journal.1.ndjson` again. A
  journal restored from a backup, copied in by an operator, left by an older
  build, or one whose single `chmod` had failed stayed group/world-readable for
  the rest of the deployment's life while holding exactly the entries the module's
  0600 promise covers. The retained generation is now chmod-ed on POSIX after the
  rename.

- **A 200 whose body was lost mid-flight surfaced as a bare `TypeError`, and on
  a write that invited a duplicate publish.** `fetch` resolves on the response
  HEAD; the body is still travelling on the same connection, so a connection cut
  between the head and the last byte rejects at `response.text()`, not inside
  the request. All three transports — JSON, multipart upload, rupload chunk —
  read the body OUTSIDE their own error classification, so that fault escaped
  uncategorised: no category, no operator text, no `nextTool`. On a `POST
/me/feed` that means the post exists and only its `id` went missing, and every
  layer above reads an uncategorised throw as "it did not happen" and retries,
  publishing it twice. The body read now sits inside the classification and
  takes the same verdict as a lost response: a read retries within its budget
  and then surfaces as a network error; a write is AMBIGUOUS and is never
  retried (C2); a multipart upload is always ambiguous; and a chunk, being
  offset-idempotent, resumes through the existing probe-and-resend path with
  `reason: 'body'` in the log. The redirect refusal (CC-NET-7) still runs first,
  so `discardBody`'s advisory read stays swallowed.

- **A throttle ETA of zero fired the entire retry budget at an endpoint that had
  just said "you are blocked".** `estimated_time_to_regain_access` was honoured
  on a bare `!== undefined`, so a `0` — or a negative — became the backoff base;
  equal jitter of zero is zero, and all five attempts went out back to back,
  which is precisely how a soft throttle escalates into a hard one. On an
  exhausted budget the operator was then told `retryAfterMs: 0`, i.e. "try again
  now". `src/core/errors.ts` already guarded the same field with `Number.isFinite
&& > 0`; the two readings of one wire value now agree, and a non-positive ETA
  is treated as no instruction at all, leaving the exponential schedule and the
  matrix default in place.

- **Deriving a Page token dereferenced a body nothing had checked.** The
  resolver read `res.data.access_token` straight off a cast. A bodiless 2xx —
  which Graph returns routinely for `GET /{page-id}?fields=access_token` when the
  token has no role on that Page — made that a `TypeError`, replacing the
  actionable "the base token may lack a role on this Page" text with an
  uncategorised crash, and bypassing the code-190 path the invalidate-and-
  re-derive logic depends on. The quieter half: a non-string `access_token` has
  no `.length`, so the emptiness check waved it through to be registered with the
  redactor and pasted into an `Authorization: Bearer` header. Only a non-empty
  string after `trim()` is now a token; everything else is "no token", which the
  caller already knows how to explain.

- **A photo Facebook refused to delete was reported as deleted.** The orphan
  cleanup treated only the exact boolean `false` as a decline, so `{"success":
"false"}`, `{"success": 0}` and `{"success": null}` — all of them Graph saying
  the photo survived — fell through to the `deleted` list. After a failed
  multi-photo `/feed` call the operator is then told the Page was cleaned up
  while unpublished media is still sitting on it, which is the exact outcome
  CC-MEDIA-10 exists to prevent, and `describeOrphans()` stays silent so nothing
  ever points at it. The check now follows the settled idiom — a bodiless 2xx
  confirms, because the transport has already turned an error payload into a
  throw, and a present `success` confirms only when it is exactly `true` — and
  the failure line reports what actually arrived rather than asserting
  `success: false`.

- **A declined video finish was handed to the model as `accepted: true`.** The
  finish phase documented its contract as "the edge's own `success` flag when it
  sent one, else `true`", but implemented it as `typeof raw === 'boolean' ? raw :
true`. A `"false"`, a `0` or a `null` **is** the edge sending one, and sending
  a refusal; every one of them was coerced to `true` and surfaced verbatim as the
  `accepted` field of `facebook_create_video_post`. Absence still confirms; a
  present flag now confirms only when it is exactly `true`.

- **Token-bearing `paging.next` survived below the top level in ads results.**
  Both ads normalizers documented "`paging` is dropped — nested edge paging
  carries the access token and must never travel further (C3)" while skipping the
  key at the top level only. `fields` on the ads listing tools is a free-form
  model-supplied Graph field list, and `withPinnedAdFields` strips `{…}`
  expansion groups — proving nested expansions are supported input — so a
  `fields: 'id,name,ads{id,name}'` returns a `paging.next` one level down that
  travelled into the tool result intact. The central redactor masks `EAA…`-shaped
  values in results, so in practice this was a C3 contract violation and a
  broken, misleading URL handed to the model rather than a raw credential leak.
  The sibling `posts-read.ts` already had the correct recursive form; ads-read had
  drifted from it and now strips `paging` at every depth, rebuilding rather than
  mutating.

- **The only tool in the server that can spend money published itself as merely
  irreversible.** `facebook_update_ad_object` declared `writeTier:
'irreversible'`, while its own planner classifies a resume or a budget raise as
  `spend` and hands the gate that tier per call. Nothing behaved wrongly —
  `HIGH_CONSEQUENCE_TIERS` holds both, so either value demands a plan id and an
  out-of-band confirmation — but the declared value is not inert: `gen-metadata`
  renders it as the write-tier column of the README tool table, so the one place
  an operator can read what the server can do to their money said `irreversible`
  next to the tool that starts delivery. The declaration is a claim about the
  worst tier any call can reach, and it now is one. That contract was undocumented
  and is now written on the field itself in `ToolSpec` and `ToolDefinition`, and a
  test drives the real planner down both branches so the claim is falsifiable
  rather than a comment.

- **The write that can start spending logged a line that could not tell a preview
  from a spend.** `facebook_update_ad_object` allowlisted `object_id`, `level` and
  `status` — identical text whether the model previewed a resume or actually
  resumed delivery. The write journal records what was applied, but the log line
  is emitted before the handler and therefore survives the crash, hang or kill the
  journal never gets to record, which is precisely the run someone reads the log
  for. `apply` and `plan_id` are now on the allowlist. `confirm_token` stays off
  it: it is the operator's out-of-band secret, and it is the one field whose
  presence in a log would undo the gate.

- **A write acknowledgement that said no was recorded as a success.** Comment
  hide/unhide, comment delete and the ad status/budget write all tested the
  acknowledgement with `success !== false`, which is only correct if the field is
  the boolean Graph documents. `"false"`, `0` and `null` are Facebook declining
  the write, and every one of them passed that test — the moderation summary
  reported a hidden comment that is still visible, and the ad update handed back
  an `applied` change list the ad account never took. A present `success` now
  confirms only when it is `true`; absence still confirms, because the transport
  has already turned an error payload into a throw.

- **An untrusted response body could crash a completed write or corrupt a
  destructive gate's before-state.** The Graph client casts a parsed body to the
  declared type without validating it, so `res.data` can legally be `undefined`
  (an empty 200), a raw string, or a record whose fields have the wrong types —
  and six call sites reached into it as if the declared type were a guarantee.
  The private reply, of which a comment gets exactly one, would throw a
  `TypeError` on the success path and report a delivered message as failed,
  inviting a retry that can never succeed (CC-MOD-2); the comment-state snapshot
  would store the string `"false"` as `hidden` (truthy, so the divergence check
  would sign off on a hide that changed nothing) or throw inside the fingerprint
  hash on a numeric `message` and abort the whole snapshot; the opt-in comment
  summary would throw away the page of comments the caller already had in hand.
  All six now read field by field and drop what is mistyped.

- **The same unvalidated body read, four more times, one layer up.** The post
  tools reached into `res.data` the same way: `create_post` for the id it hands
  back, the video poll for `id`, and post update and delete for `success`. A
  bodiless 2xx — which is what several of these edges legitimately return —
  therefore threw a `TypeError` after the post had already been published or
  deleted, reporting a completed write as failed and inviting a retry that
  duplicates a post or hunts for one that is already gone; a `success` of `"false"`
  or `0` was reported as a success outright. All four now go through shared
  readers that treat the body as `unknown`: an id counts only as a non-empty
  string, and a present `success` confirms only when it is exactly `true`.

- **`facebook_list_pages` advertised defensive parsing it did not perform.** The
  section comment above the shapes read "parsed defensively — CC-NET-2", while the
  code declared `fbRequest<{ data?: readonly RawPageAccount[] }>` and mapped
  straight over the edge — a cast, not a check. A 2xx whose body is absent or is
  not an object therefore threw a `TypeError` inside the one tool a client calls
  first to discover which Pages it may act on, so the failure lands before any
  Page id exists and nothing downstream can route around it; a single unreadable
  entry took the whole list with it; and an account with no usable `id` was
  handed on as an answer, moving the failure to the next call where it is harder
  to read. The reader now starts from `unknown`: a non-array edge yields an empty
  list, an entry that is not a record or carries no non-empty string `id` is
  dropped rather than thrown on, `tasks` keeps only its string members, and
  `hasToken` still derives presence from `access_token` without the value ever
  entering the payload.

- **`moderateCommentStep` selected the permanent delete by the ABSENCE of a
  field.** Its input took an optional `hidden` flag, and `hidden === undefined`
  meant delete — so "I forgot to pass a property" and "destroy this comment
  forever" were the same call, and the compiler could not tell them apart. The
  verb is now an explicit `op: 'hide' | 'delete'` discriminant, both branches are
  matched positively, and anything else throws: input that lost its verb on the
  way in costs a rejected call rather than a comment nobody can get back.

- **An empty page of comments blamed the token even when the cursor disproved
  it.** Every empty comments page carried the user-token hint (CC-AUTH-2), which
  is right for a first page and provably wrong for a continuation: a forward
  cursor was minted by a successful read of that same edge with that same token,
  so the only thing an empty page proves is that the walk ran past the last
  comment. Continuations now say that instead.

- **A genuine ad parameter fault was re-diagnosed as a deleted object.** The
  gone-or-archived remapping (CC-ADS-4) keyed only on a bare code 100 with no
  subcode, but Graph spends that same code on real parameter faults ("Param
  daily_budget must be a positive integer"). The remapping asserted a cause
  nothing had established and sent the model to re-read a live object instead of
  fixing its request; it now also requires the message to read like Graph's
  nonexistent-object answer, and any other 100 keeps its own words.

- **`doctor` gave a healthy report for a configuration that cannot start.** When
  the package selection does not resolve, the doctor's package narrowing falls
  back to the full package array so that a report still prints — which is right,
  and on its own was also a lie: the operator got a permission matrix over all
  seven packages for an install that loads none of them, and the worst verdict a
  broken `FB_PACKAGES_DENY` could produce was `warn`. `doctor` now asks
  separately why the selection failed, prints `Configuration / packages: WILL NOT
START` above the token block, and raises a `fail` finding naming the variable —
  so `doctor --strict` exits 2 for a server that will refuse to boot, instead of
  1 for one it mistook for merely degraded.

- **`setup-token` reported on a package set the install would never load.** The
  scope cross-reference is computed against "the packages this install will run".
  When `FB_TOOL_PACKAGES` failed to parse the command swallowed the error and
  quietly substituted the default profile — so onboarding ended green, describing
  a configuration that cannot boot, with nothing in the output naming the variable
  at fault. The fallback is still right (a scope report beats an aborted setup);
  the silence was not. It now emits a warning naming the offending token and
  saying the server will refuse to start until it is fixed.

- **A typo in any of the three package variables produced an error that would not
  say which variable.** `FB_TOOL_PACKAGES`, `FB_PACKAGES_DENY` and
  `FB_PACKAGES_READONLY` all expand through the same function and all fail the
  server closed, and the message named the bad token and the full valid set but
  never the setting it came from. That is tolerable at leisure and expensive
  during an incident, which is exactly when the kill-switch runbook tells an
  operator to type a package name into `FB_PACKAGES_DENY` under pressure: the
  server would refuse to start and the text gave them no reason to suspect the
  deny list rather than a perfectly correct allow list. `PackageSelectionError`
  now carries the source variable and folds it into the message.

- **Two Graph errors sent the operator to fix the one thing that was not
  broken.** Codes `190/492` and `190/459` had no matrix row of their own, so both
  fell through to the generic `190` advice — refresh the credential. Neither is a
  credential problem. `190/492` means the token is alive but its user holds no
  role on the Page; minting a fresh token for the same user reproduces the error
  exactly. `190/459` means the account is sitting behind a security checkpoint
  that only a person can clear at facebook.com; a token issued before that is
  refused identically. Both now have rows: `190/492` classifies as `permission`
  rather than `auth` — the category tools branch on — and names the Page role to
  grant, and `190/459` names the checkpoint and says, in order, clear it first and
  re-authorize second. The advice they replaced was not merely unhelpful; it was a
  loop with no exit.

- **`FB_PACKAGES_DENY=core` did the opposite of what the documentation implied.**
  All three package variables read one namespace of packages _and_ profiles, and a
  profile name beats a same-spelled package — so denying `core` denied the whole
  six-package `core` profile, then handed the `core` package back because it is
  always-on. The reference table said only "packages to exclude", which predicts
  precisely the inverse. The behaviour is correct and is now pinned by a test;
  what changed is that the README, the generated env reference, the docs site and
  the kill-switch runbook all say it. The runbook additionally documents
  `FB_PACKAGES_DENY=all` as the fastest in-process stop — one token, collapses the
  surface to core's four read-only tools whatever `FB_TOOL_PACKAGES` says, and
  leaves `facebook_whoami` and `facebook_usage` alive to investigate with.

- **The `mcp` barrel withheld the type an action needs to tell the truth about
  its own result.** `WriteResultVerdict` and `APPLIED_VERDICT` were exported from
  `mcp/write-mode.ts` but never re-exported from `mcp/index.js`, which is the only
  door the `tools` layer is allowed through. A missing barrel line does not fail
  loudly — it quietly forces the next author to write around it, and `bulkVerdict`
  in `tools/moderation.ts` is the evidence, returning an inline structural type
  because the real one had no name on that side of the wall. Both are exported
  now, guarded by a test that does not compile if either goes missing again.

- **A bulk write that changed nothing was journaled, and reported, as applied.**
  A bulk verb runs its ids one at a time and catches each failure so a single bad
  id cannot kill the batch (CC-MOD-5) — which means it returns its per-id outcome
  array _normally_ even when every id failed. The write gate cannot see inside an
  opaque result, so it took the resolved promise as proof and wrote `applied` to
  the audit journal, the one record an operator reconciles a mutation against
  (CC-LIFE-2). The envelope agreed with it: `status` was hardcoded to `"applied"`
  while the `applied` boolean beside it said `false`, so the model was handed two
  contradictory answers to the one question the envelope exists to answer.
  Actions can now classify their own result (`WriteAction.classifyResult`); a
  batch where every id failed journals `failed`, reports `applied: false`, and
  carries `status: "not_applied"` with a notice saying so. A _partial_ failure
  stays applied on purpose — some ids really did land, and for a delete those
  comments are gone for good, so claiming the world is untouched would be the
  more dangerous of the two lies.

- **An absent optional boolean selected the irreversible verb.** Internally,
  `moderateCommentStep` took `hidden?: boolean` and treated a missing field as
  "delete this comment permanently": forgetting a property and asking for
  destruction were the same call, and the compiler could not tell them apart. Not
  reachable through the shipped tool, but reachable by any other caller — a JSON
  boundary, a hand-built object, a future third verb. The verb is now an explicit
  `op` discriminant, both cases are matched positively, and anything else is
  refused instead of falling through to the delete.

- **A send could be reported as confirmed when Facebook never acknowledged it.**
  The transport casts a parsed body to the declared type without validating it,
  so `message_id` was a claim rather than a fact, and `sendMessage` accepted it
  on a bare `!== undefined` test. A `{"message_id": null}` body therefore passed —
  and `facebook_send_message` reported `delivery: "sent"` with _"Facebook
  acknowledged the send with a message id, so delivery is confirmed. Do not send
  it again."_ The same gap failed the other way too: an HTTP 200 with an empty
  body threw a raw `TypeError` out of the success path, so a send that did go out
  surfaced as an unclassified crash. An id now counts only when it is a non-empty
  string, matching what `sendPrivateReply` already did on the same endpoint.

- **A documented log-hygiene control logged nothing at all.** `ToolSpec.logFields`
  — the per-tool allowlist of arguments that may be written to the log — was
  carried faithfully from `defineTool` into the spec and then read by nobody: not
  the registry, not the dispatcher, not anything. Two documents describe it as
  enforced. It is now enforced: a call logs one `info` line, on stderr, carrying
  only the allowlisted keys, each redacted at the dispatch site as well as by the
  logger, with non-scalar values reduced to a type tag (`[object]`, `[array]`)
  because the author reviewed a key, not the arbitrary tree a client can hang
  under it. The line is emitted _before_ the handler, so a call that throws or
  hangs still leaves a record. No allowlist still means no logging — an allowlist
  nobody wrote is not permission to log everything — and `defineTool` now refuses
  an empty one, which read as if hygiene had been considered while behaving
  exactly like an absent field.

- **`FB_PACKAGES_READONLY` could hide a duplicate tool name.** Two packages
  claiming the same tool name is a packaging fault that refuses startup — but the
  check ran over the survivors, so naming the package that owns the write-tier
  twin in `FB_PACKAGES_READONLY` dropped that twin first, the collision vanished,
  and the other package silently inherited the name. The same two packages either
  refused to start or shadowed each other depending on an environment variable,
  and nobody was told the surface was ambiguous. Names are now claimed before the
  read-only filter runs, so the integrity check is blind to configuration.

- **Error 100/21 told the operator to fix arguments that were not wrong.**
  `src/core/auth.ts` treats subcodes 21 and 33 alike — both mean "the object this
  Page id points at moved" (CC-AUTH-7) — and spends a token re-derivation on
  each. The error matrix knew only about 33, so once that retry was spent, 100/21
  fell through to the generic `validation-100` row: _"fix the arguments; retrying
  unchanged will fail identically."_ Nothing done to the arguments can help — Meta
  migrated the Page to a new id and the old one is dead for good. The matrix now
  carries a 100/21 row that says exactly that and names `FB_PAGE_ID`.

- **Importing the smoke runner ran the smoke runner.** `parseCliArgs` is exported
  with the comment "so it can be exercised in isolation", and that was not
  achievable: `main()` was called at module scope, so importing the module
  started a run — the gate refusal and a non-zero `process.exitCode` at best, a
  spawned server and live smokes in an environment configured for them. It is now
  guarded on being the entry point, which is what `npm run smoke` invokes it as.

- **Two empty CLI selectors resolved to the opposite of what they asked for.**
  `--phase ""` became phase 0, because `Number('')` is 0 and 0 is an integer;
  `--only ""` became the full default run, because an empty selection means "no
  narrowing". Both are what `--phase "$P"` / `--only "$IDS"` do when the variable
  is unset, so both turned a typo into a silently different run against a live
  Page. An empty selector is now refused.

- **`setup-token` handed out live Page tokens it never registered as secrets.**
  The module header promises redaction covers "the long-lived token and every
  derived Page token", but `redactor.addSecret` ran only for the Page the
  operator selected — while `/me/accounts` returns a live `access_token` for
  _every_ Page the token can see, and that whole payload stays in frame for the
  rest of the run. Value-based redaction is this server's primary strategy (the
  `EAA…` pattern scan is only the backup), so any later step that failed with the
  listing in its message could surface the unselected Pages' tokens verbatim.
  Every token in the listing is now registered the moment the listing is
  filtered, before any step that could throw.

- **A wrong parameter on an ads write was answered with "go re-read the
  object".** `mapUpdateError` rewrote every bare code 100 into the "object may be
  DELETED or ARCHIVED, or your token may lack permission on it" diagnosis, but
  Graph also answers genuine parameter faults with a bare 100
  (`(#100) Param daily_budget must be a positive integer`). The function's own
  docstring says it maps the case "whose stock text ('Unsupported post
  request')" identifies — and the code never looked at the text. It does now:
  errors whose message does not match that stock wording propagate untouched
  with their own diagnosis, so a fixable request stops being reported as a
  vanished object.

- **A Page whose timezone the runtime supports was reported as unrecognised, and
  the write refused.** `resolvePageTimezone` required a `/` in the zone name, so
  `UTC`, `GMT`, `Japan` and `Singapore` were dropped — the schedule preview then
  called the Page timezone unknown, and on the operator-supplied path the write
  was refused outright with `page_timezone "UTC" is not a timezone this runtime
recognises`, a message asserting something false. The slash test is replaced by
  an explicit numeric-offset rejection, which keeps the original intent (Meta's
  legacy Page `timezone` can be `-8` or `+08:00`) and is required to be explicit
  because Node's `Intl` accepts `+08:00` and `+0800` as time zones — the
  supported-zone check alone would let them through.

- **Nested edge `paging` travelled on through the api layer.** `FLATTENED_KEYS`
  promises that "nested edge paging carries the access token; dropping it here
  means it never travels through the api layer at all (C3)", but the key loop
  skipped `paging` only on the node itself, and a `fields` expansion
  (`attachments{...}`, `likes{...}`) returns the edge as `{ data, paging }` — one
  level down, copied through by reference. `normalizeNode` now strips `paging` at
  every depth, rebuilding rather than mutating. This was never a live token leak:
  the MCP result shaper strips `paging` recursively, so the model never saw one.
  It restores the defence in depth C3 describes.

- **`setup-token`'s first instruction pointed at a file the npm package does not
  ship.** With no token configured, the flow told the operator to tick the scopes
  listed in `docs/runbooks/onboarding.md` — but `docs/` is not in `package.json`'s
  `files`, so someone following the runbook's own `npx @ivanbaev/facebook-mcp
setup-token` has nothing to open. The required scopes are named inline now,
  with the README table (which npm always ships) as the reference.

- **Three `setup-token` messages blamed a permission the flow had already
  verified.** `classify` refuses any token without `pages_show_list`, yet the
  steps after it still advised "or pages_show_list was not granted" — so the
  report printed `scopes: pages_show_list` and sent the operator back to the
  Graph Explorer to tick a box that was already ticked. All three now state that
  the scope _is_ granted and name the causes that remain: no Page role, a
  System-User token whose Page is not assigned as an asset, or a token issued by
  a different app.

- **"Re-run with `--page=<id>`" named a command that fails.** After writing an
  env file for a token with several Pages, the flow advised pinning one — but
  that re-run replaces an existing file rather than merging, so it exits
  `needs-force`. The advice now includes `--force` and says why.

- **An unexpected `/me/accounts` shape crashed the report after the credentials
  were already on disk.** `RawPageAccount` declared `tasks?: readonly string[]`
  over unvalidated Graph JSON, and `renderPage` calls `page.tasks.join(',')`, so
  a non-array threw a `TypeError` inside `renderSetupTokenReport` — a run that
  succeeded, wrote the file, and then died before telling the operator anything.
  The fields are `unknown` now and parsed defensively (CC-NET-2, the treatment
  `core/auth.ts` already applies), and a null `category` no longer renders as
  `[null]`.

- **"Page X is not among the Pages this token can see" was false past 100
  Pages.** The flow reads one page of `/me/accounts` and does not follow
  `paging.next`, so the denial was really about the first 100 entries. It now
  reads `paging.next` and says so — "not among the first 100 Pages … (Graph
  reported more)" — and a successful auto-select warns that it chose within that
  window. Following the cursor would be a feature, not a fix; this stops the
  server stating as fact something it did not check.

- **A failed credential write left a half-written 0600 file behind, one per
  failure, forever.** `atomicWriteFile` promises a reader "never sees a partial
  or world-readable file", and it guarded the chmod/rename step with a
  `rm(tmp, {force:true})` — but the temp file is created by the `open(tmp,'wx')`
  before that guard, so a failure in the write, the fsync or the close escaped
  with no cleanup, orphaning a `<target>.<pid>.<uuid>.tmp` sibling in the config
  or state directory. The whole temp-file lifecycle is now inside one try, and
  the docstring states the cleanup guarantee rather than implying it.

- **The doctor could report every required permission missing on a token that
  had them all.** `debugToken` took Graph's `scopes` field at its word
  (`data.scopes ?? []`) while declaring it `readonly string[]`. A bare string on
  the wire flows straight through that contract: `.length` answers a character
  count, setup-token's summary throws on `.join()`, and the doctor's
  `new Set(token.scopes)` expands it into single characters, so every permission
  check misses. `normalizeScopes` (CC-NET-2) now drops anything that is not an
  array of strings rather than coercing it — the same defensive treatment
  `granular_scopes` already had.

- **A Page whose id collided with an `Object.prototype` member skipped token
  derivation.** The override lookup was a bare `overrides[pageId] !== undefined`
  on a plain object, so a Page id of `toString`, `constructor` or `valueOf` read
  back an inherited function, which the guard accepted as a configured token:
  `resolve` then returned a non-string from a `Promise<string>` and never
  derived. Both call sites now go through an `Object.hasOwn` lookup.

- **`FB_TOOL_PACKAGES=` was ignored, and the operator got the full tool surface
  they had just tried to switch off.** `resolveToolPackages` documents that "a
  present-but-empty value warns and falls back", but the call site read it
  through `str()`, which folds an empty or whitespace value to `undefined` — the
  "not configured" answer — so the empty setting expanded to the default package
  list with nothing said in the startup report. The raw value is passed now. The
  existing test covered `' , , '`, which is non-empty after trim, so the truly
  empty case had never run.

- **A profile could silently act with the credential it was configured not to
  use.** Profile names are case-insensitive everywhere else in the module — the
  page-id var is lowercased into the key, and two spellings of one name are
  refused — but the token was read at the page-id var's exact spelling. So
  `FB_PROFILE_Acme_PAGE_ID` beside `FB_PROFILE_ACME_TOKEN` yielded a profile with
  no token override, no error and no warning, and the profile fell back to
  deriving a Page token from the base credential. Token vars are now matched
  case-insensitively like the name, and two spellings of one token var are
  refused as `duplicate-profile-token` rather than ranked — mirroring
  `duplicate-profile-name`, on the same reasoning that acting with an arbitrarily
  chosen credential is worse than acting with none.

- **A Reel Meta rejected as out-of-spec could be reported as an exhausted
  publishing quota.** The rolling Reels cap has no documented
  `{code, subcode}` of its own, so classification falls back to Meta's wording —
  deliberately, and labelled `quota-message-only` / `verified: false` when it
  does, because a genuine cap arriving on an undocumented code is the expected
  case and misreading it as a generic failure invites exactly the retry loop the
  module exists to prevent. The fallback was ungated, though, and Meta rejects an
  over-long or wrong-shaped Reel in the cap's own vocabulary: "the Reels duration
  limit is 90 seconds and this file reached 214 s" matches the cap patterns on
  every word. Quota is tested before the constraint branch, so that rejection was
  answered with "Reels publishing quota exhausted — wait ~24 h" — a day's wait
  prescribed for a file the operator could re-encode in a minute, and precisely
  the mis-advice the per-signature message gate was written to avoid.

  The message-only path now yields to an error core already classified as
  `validation` or `not_found`. That verdict is the one piece of evidence that
  outranks the wording: Meta reports the cap as a throttle, a policy block or an
  undocumented code, never as a parameter validation failure, so under those two
  categories the file is out of spec whatever the text says. Errors on a matched
  signature row are untouched, and so is the message-only path everywhere else —
  narrowing it to require a code match would have been the larger change and the
  wrong one, since no code family is documented as cap-exclusive today.

- **A failed bundle could still lose a race to an irreversible `npm publish`.**
  In the release rail `npm-publish` and `bundle` both hung off `gate` alone, so
  they ran concurrently: a bundle that failed to pack, attest or verify could not
  stop a publish that had already succeeded, leaving the version spent on npm
  with no GitHub Release to go with it. An npm version, once taken, is never
  reusable, so that outcome costs a version number and a hand-written recovery.
  `npm-publish` now runs after `bundle` — of the two artifacts this rail ships,
  only npm cannot be taken back, so it goes last and a bundle failure costs a
  re-run instead.

  It tests `bundle`'s result explicitly rather than declaring a bare
  `needs: [gate, bundle]` dependency, because the resume mode skips `bundle` on
  purpose and a skipped dependency skips its dependants — which would disable the
  one mode whose whole purpose is to finish an interrupted publish. So it
  publishes when the bundle succeeded or was deliberately skipped, never when it
  failed, and the guard is `!cancelled()` rather than `always()` so a cancelled
  run does not publish anyway.

- **Cursor-expiry handling was written, tested, and never reached by a live
  error.** `fetchAll` swallows exactly one failure — a rejected pagination cursor
  — and returns the rows it already has plus a restart note, rather than losing a
  long listing to a stale `after`. But nothing in the live path ever produced the
  `cursor_expired` classification that behaviour keys on: Graph publishes no
  dedicated code for it, so a rejected cursor arrived as code 100 or 1 and the
  error matrix answered "fix the arguments" (unactionable when the argument is an
  opaque cursor) or "safe to retry" (actively wrong — the same dead cursor fails
  identically forever). The envelope is now probed for a cursor rejection ahead
  of the table, since the codes it arrives under are ones the table already
  claims, and the transport passes Graph's raw `message` through so there is
  something to probe. The probe is a documented fallback, not a guess dressed up
  as a lookup: it runs only under those two codes and only against Graph's own
  wording, and a localized deployment degrades to the matrix classification
  rather than to a wrong one.

  The duplicate heuristic in the api layer is gone. It scanned the _surfaced_
  message — redacted and status-prefixed — under any code for "cursor" plus one
  of three verbs, which made it wrong in both directions: an auth or permission
  failure whose text happened to mention a cursor was downgraded to an empty
  page, and a listing that reports zero results for a credential problem is worse
  than one that throws, while Graph's actual wording matched none of the three
  verbs. That helper now reads the classification and nothing else.

- **The TLS-interception hint could not reach the case it was written for.** An
  HTML error page where a Graph envelope belongs is the corporate-proxy
  signature, and the absence of an envelope is the only evidence available that
  the answer came from a middlebox rather than from Facebook. The builder that
  attached the proxy-environment hint to those bodies had no production callers
  at all — the live path routed a non-JSON body to a status-derived category
  instead — so operators got a truncated snippet of somebody else's error page
  and no way to name the cause. Non-JSON bodies now classify through one function
  that always carries the hint: 5xx stays retryable, anything else is
  non-retryable, since a body that cannot be parsed gives no ground to call the
  request safe to repeat.

- **`facebook_get_video_status` accepted a post ID it could never resolve.**
  `video_id` was declared twice and the two declarations had drifted apart: the
  insights copy checked the shape and rejected a `{page-id}_{post-id}` composite
  with a precise message, while the posts copy checked only that the string was
  non-empty. So the composite — the one mistake every video edge invites —
  passed validation and spent a live Graph call to fail. Both tools now build
  the argument from one shared definition in the tools layer, so the two cannot
  disagree again; the tool-specific prose stays per-tool, the shape and the
  rejection message do not.

- **`facebook_usage` reported a failed probe as an idle app.** The rate-limit
  probe was wrapped in a bare `catch` that produced the same empty snapshot as a
  successful probe against a quiet app, and the note then told the model the app
  "may be idle". An expired token or a dropped connection was therefore
  diagnosed as low traffic, which sends the operator looking for a quota problem
  that does not exist. The two cases are now distinct: a probe that threw says
  the figures are unknown and names the probe as the thing to fix. The tool
  still does not throw — a diagnostic that fails loudly on a broken token is one
  more error stacked on the one being diagnosed — and the echoed reason goes
  through the redactor before it is trimmed, so trimming cannot slice a secret
  and leave the surviving prefix unmatched.

- **A smoke server that died during start-up took its own explanation with it.**
  The stderr listener was attached after the MCP handshake, so a child that
  failed to boot — bad configuration, an unreadable build — wrote its only
  diagnostic into a stream nobody was reading yet, and the operator got a bare
  connect error. It is attached before `connect` now (the transport hands out its
  stderr stream before the child is even spawned, precisely for this), and the
  failure carries the child's stderr with it. The same path also skipped the
  start-of-run sweep, so leftovers from a previous run stayed on the Page while
  nothing said so; the runner now names that consequence and prints the
  `--sweep-only` command that clears it.

- **Two ways a token could reach a smoke log unredacted.** The stderr tail was
  truncated before it was scrubbed, and slicing first can cut a token in half —
  half a token matches neither its literal value nor the structural pattern, so
  the surviving fragment would have been printed verbatim into output an operator
  might paste into an issue. Scrubbing now runs first, on assembled lines rather
  than raw chunks (so a secret straddling a pipe-chunk boundary is still matched)
  and truncation follows on line boundaries. Separately, the CLI parse failure and
  the top-level rejection handler — which prints a stack — wrote straight to
  `process.stderr`, bypassing the scrubber every other line in the harness goes
  through.

- **A smoke that declared no packages got the six-package default.** The fallback
  set `FB_TOOL_PACKAGES=core`, but `core` is a _profile_ name that wins over the
  same-spelled package and expands to six packages, so a scenario asking for the
  narrowest possible surface was handed nearly all of it. The fallback now pairs
  it with `FB_PACKAGES_DENY=all`, which the registry filters before forcing the
  always-on `core` package back on, leaving exactly that one package. The child
  environment also forces `FB_PACKAGES_READONLY` empty, so an operator's ambient
  configuration cannot remove a tool the selected smoke declared it needs.

- **Two harness refusals that did not say what to do about them.** A write smoke
  without `FB_CONFIRM_TOKEN` was refused without explaining that the alternative
  is to narrow the selection, and `--list` did not show the requirement at all.
  `reels/create-and-status` declared only `FB_SMOKE_REEL_PATH`, but the Reels
  upload protocol has no fetch-this-URL mode and local file access is off by
  default, so a perfectly valid path was refused at the media layer — after two
  opt-ins and a spent quota slot. It now declares `FB_MEDIA_DIR` too, turning that
  into an up-front refusal that names the variable.

- **The 90-day support checkpoint had no date, so nobody could hold the project
  to it.** `SUPPORT.md` promised a measurement "at 90 days after launch" against
  a named adoption bar, and then went on to declare the consequence of missing
  it — but "launch" is defined nowhere, and a pre-committed outcome with an
  unfixable start date is not a commitment. The anchor is the first public
  release, `0.7.0` on npm 2026-08-27, so the checkpoint is 2026-11-25 and
  `SUPPORT.md` now says so outright. The roadmap keeps its relative wording with
  an annotation recording the anchoring, per the corpus convention that dated
  analysis is amended rather than rewritten.

- **The doctor judged packages the server never loads, and `--strict` inherited
  the verdict.** `main` hands the doctor everything the bootstrap can _build_ —
  `ads` included — but selection happens later, inside the registry, and `ads` is
  not in the default `core` profile. A correctly provisioned out-of-box install
  therefore reported `ads: BLOCKED - missing ads_read, ads_management` and, once
  `--strict` existed, exited non-zero over a package nobody had enabled: a gate
  no default install could pass is a gate that gets deleted from the pipeline.
  The same array is what the over-scope check subtracts from, so the error ran
  the other way too — an `ads_management` scope riding on a runtime token that
  cannot use it counted as "needed" and was never flagged. The doctor is now
  given the packages the registry actually loads. An unknown `FB_TOOL_PACKAGES`
  name still yields the full array rather than an exception, because a broken
  config is the case the doctor most needs to survive; the startup path is where
  that error is reported.

  The subcommand moved into `runDoctorCommand` to make the narrowing testable at
  the place it happens. A test that calls the helper itself proves only that the
  helper works — delete the call from the command and every such test still
  passes — so the seam had to sit where the report is produced.

- **A Graph body with no entries at all was reported as invalid metric names.**
  "Silent empty data" — a Page below the eligibility floor, or a read made with a
  user token instead of a Page token — has two possible wire shapes, and the
  corpus pins neither: entries whose `values` array is empty, or a body carrying
  no entries whatsoever. Only the first was explained. The second met a guard
  that required at least one entry before the explanation could be assembled, so
  it skipped both the scope note and the user-token hint and left exactly one
  note behind: that the requested metric names are unavailable. That is the one
  reading almost certainly wrong, since Graph rejects an unknown metric name
  outright rather than answering with silence — and it sends the operator to
  rename metrics that were never the problem. The guard is gone; a request that
  asked for nothing still cannot reach this code, because a fully deprecated
  metric list returns before the notes are built.

- **A tag that moved mid-run could publish code no gate had seen.** Every job in
  the release rail checks out the tag by NAME and resolves it independently, so a
  force-move between the gate finishing and the publish starting produced a run
  whose checks were applied to one commit and whose tarball came from another —
  and on npm that is unrecoverable, because the version can never be re-cut. The
  gate now records the commit it actually validated, and every job that performs
  a checkout refuses to continue unless its own `HEAD` matches. It changes
  nothing about what is checked out; it only declines to build on a ref that
  moved. `github-release` needs no such check — it performs no checkout and
  works from the attested artifact.

- **A `bin` entry pointing at a file that does not exist published clean.** The
  gate already refused a `bin` target written as `./path`, because npm strips
  that at publish time and ships a package with no executable. The same outcome
  arrives the other way and was not caught: npm does not verify that a `bin`
  target exists, and `npm pack` on a package whose launcher was renamed or
  excluded exits 0 with no warning at all. The result is a version that installs
  successfully and fails on every `npx`, on a version number that can never be
  republished. The gate now checks the target is present in the checkout.

- **The bundle packer's first run of a release was also its only test.**
  `scripts/pack-mcpb.mjs` has no unit tests and no CI caller: it executes exactly
  once in the life of a release, in the `bundle` job on a `v*.*.*` tag, and that
  job runs in parallel with the irreversible npm publish. A break in the packer,
  in the manifest's `server.entry_point`, or in `package.json#files` — which
  decides whether the entry point is inside the publish surface at all —
  therefore surfaced first on a tag, after npm had taken a version that can never
  be republished. CI now packs the bundle on every push and pull request, which
  moves that failure onto the branch where it is still free. The job builds a
  bundle in the runner workspace and nothing more: it uploads nothing, attests
  nothing and publishes nothing.

- **Release rail: a recovery path for a registry listing that a re-run cannot
  fix.** `npm publish` is one-shot, so once it succeeds the release cannot be
  re-cut: a re-tag dies on the npm step before it reaches anything else.
  Re-running the failed jobs from the Actions UI is the normal recovery and it
  usually works, but it replays the workflow file _as it was_, so it cannot pick
  up a fix for whatever failed. `workflow_dispatch` now takes `mode: resume` plus
  a `tag` input: dispatched from the default branch it runs today's rail, checks
  out the release tag, leaves npm alone, and re-runs `mcp-registry` against the
  tarball that is already public. The default stays `rehearsal`, which publishes
  nothing.

  Resume deliberately stops at the registry rather than covering the whole
  release. `attest-build-provenance` derives its statement from the run's own
  context and has no ref override, so a bundle rebuilt during a resume — which is
  dispatched from a branch — would be attested as coming from `refs/heads/main`
  while its bytes came from the tag's checkout: a signed, publicly verifiable
  claim that is false. `bundle` and `github-release` are therefore skipped on a
  resume, and a failed Release is recovered by re-running that job, which replays
  the original context and keeps the attestation truthful. What a re-run cannot
  do is pick up a workflow fix — which is exactly the registry's failure mode,
  and why the registry is the job that needs a dispatch-based recovery.

- **Release rail: a duplicate MCP Registry listing is no longer a silent
  ambiguity.** The registry is append-only — a version may be listed once, and a
  second publish is rejected with `cannot publish duplicate version` — so the
  publish step now reads that response instead of failing on it blindly: during a
  resume it is success, because the listing the run was sent to create exists,
  and on a tag push it is a hard error naming the real problem, because it means
  the version was listed before this tag ran.
- **Release rail: the wait for npm CDN propagation was too short.** A scope's
  first package is far slower to appear than a new version of an existing one —
  0.7.0 took 5m17s against a 200-second window — so `mcp-registry` failed on a
  release that had otherwise succeeded, and only went through on a re-run once
  the tarball had propagated. The window is now 10 minutes; erring long costs
  runner minutes, erring short costs a manual recovery run.

- **A log field with a throwing getter no longer takes down the caller.**
  `log.ts` states that a logger must never throw, and it wrapped serialization in
  a guard to keep that promise — but redaction ran one step _outside_ that guard.
  Redaction walks the record's own enumerable properties, which invokes property
  accessors, so a field whose getter throws threw from the logger itself and the
  exception surfaced in whatever code had merely tried to log something. The
  redaction call now sits inside the guard with the serialization it feeds, so
  that field lands in the same fallback record as a value that defeats
  `JSON.stringify`: the message re-redacted, the caller's fields dropped, and a
  `logError` marker in place of a silent hole in the log.

- **The last page of a listing no longer reads as a broken token or an empty
  account.** Two edges stamped their "this is empty, and here is the likely
  reason" note on _any_ empty page, including one fetched with a forward cursor —
  which is simply how a walk ends. A comments walk finished by telling the model
  the call "was most likely made with a USER token" and to re-run
  `facebook_list_pages`, a diagnosis the cursor itself disproves: that cursor was
  minted by a successful read of the same edge with the same token. An ads walk
  finished by advising a re-list with `effective_status` to reveal hidden
  objects, which means paying the metered ads edge again — documented at roughly
  300 + 40 x active ads per hour — to rediscover objects the caller had already
  been handed. Both notes are now gated on the absence of a cursor, and an empty
  continuation says what it actually knows: the listing ran past its last item,
  and that is all.

- **An ads listing no longer blames a filter it never sent.** `effective_status:
[]` skipped the wire parameter (an empty filter is no filter) but still
  explained an empty page as "No objects matched the requested effective_status
  filter" — sending the operator to adjust a filter Graph had never received. One
  local now decides both the parameter and the note, so the two cannot drift
  apart again.

- **A failed progress notification no longer destroys an upload that had
  succeeded.** The progress sink is advisory — the tools layer bridges it onto an
  MCP `progressToken` notification, which fails on a closing transport — and
  `media-video.ts` says so explicitly: "A throwing sink must never fail an upload
  whose bytes are already on Meta's side." The photo and Reels paths did not keep
  that contract. In multi-photo upload the sink call sat inside the upload `try`,
  so a failed notification was caught as an upload failure: every
  already-accepted child was deleted, and the error named a photo that had
  uploaded perfectly. On Reels it was worse — the sink call before the finish POST
  was unguarded, so a failed notification escaped raw and left a reserved
  `video_id` with every byte uploaded and no commit, and since `finishReelUpload`
  is the only call that names that session and Reels sessions live one server
  lifetime, nothing could ever find it again. All four call sites now contain the
  throw and log it.

- **A Reel whose upload outran its own schedule now says so, instead of blaming
  the operator's publish time.** `finishReelUpload` re-validates
  `scheduled_publish_time` against a fresh clock, which is correct — Graph
  measures the lead at the commit. But the minimum lead is 10 minutes, so a Reel
  scheduled 12 minutes out whose upload takes 5 fails a purely local check after
  a `video_id` is reserved and every byte is uploaded. The message read as if a
  bad time had been submitted, when a good one had been, and said nothing about
  the session left behind. That rejection is now re-raised naming the real cause
  — the upload took longer than the lead allowed — along with the elapsed time,
  the reserved `video_id`, and the fact that re-running reserves a new one.

- **A hostname that merely starts with `127.` is no longer accepted as a loopback
  bind address.** The HTTP transport's bind guard was a string test —
  `host.startsWith('127.')` — so `127.0.0.1.example.com` passed it. That is a
  perfectly registrable DNS name, and `listen()` hands a non-literal host to the
  resolver, which is free to answer with a public address. The server that was
  meant to be reachable only from this machine would then be bound to a routable
  interface, with the bearer-token check as the only thing left between the
  internet and the operator's Page tokens (Security #4). The guard now asks
  `node:net`'s `isIP` and accepts only a literal IPv4 loopback or a literal `::1`
  — which also, deliberately, drops the bracketed `[::1]` URL spelling the old
  test allowed, because `listen()` treats brackets as part of a name and never
  resolves them.

- **The stdio console guard now covers every `console` method that writes to
  stdout.** Only `log`, `info` and `debug` were redirected to stderr, but Node
  routes `dir`, `dirxml`, `table`, `group`, `count`, `clear` and the `time*`
  family to stdout without passing them through `console.log`. A single
  `console.dir` from a chatty dependency was enough to interleave a formatted
  object with the JSON-RPC frames and break the client's parse — the exact
  corruption the guard exists to prevent (CC-CFG-1 / C12). All fifteen are now
  redirected, and they are redirected to a real `Console` whose stdout is
  `process.stderr`, so `table`'s formatting, `group`'s indentation and `time`'s
  and `count`'s label state survive the move instead of collapsing into
  `console.error(...args)`.

- **The write journal's error path can no longer throw the error it was reporting
  on.** `append` swallows every write failure and returns `'failed'` so a journal
  outage can never fail a Graph write that already happened (CC-LIFE-1) — but the
  reporting leg inside that `catch` called two injected seams unguarded, the
  host's `onError` sink and the redactor. A logger writing to an already-closed
  stream throws, and that throw escaped `append` and rejected it, turning a
  successful Graph write into a reported failure. The whole leg is now contained.
  Nothing falls back to reporting unredacted: the redactor is the C3 choke-point,
  and a message that could not pass through it must not escape at all.

- **A refused redirect no longer pins its connection.** Both the JSON transport
  and the upload handler refuse a 3xx off the host allowlist by throwing, and
  neither read the body first. Under Node's undici, `redirect: 'manual'` does not
  hand back an empty opaque-redirect response — it hands back a normal response
  carrying the origin's 3xx body, and an unread body keeps its socket out of the
  pool. Measured on Node 22, five refused redirects in a row opened five sockets
  and released none, against one reused socket when the body is read. Every other
  exit in both modules already consumed its body; these three now do too. The read
  is advisory and its own failure is swallowed, so a body that breaks mid-read
  cannot replace the refusal the caller has to see.

- **A throwing usage sink can no longer fail a request the server already
  answered.** `onUsage` is advisory — it exists so a caller can back off before
  Graph throttles it — and the headers feeding it are parsed defensively
  (CC-NET-2), but the call itself was unguarded on both the JSON and the upload
  path. A sink that throws destroyed a completed request, and inside
  `probeServerOffset` it was worse: the call sits within the `try` that classifies
  network faults, so the sink's own error surfaced as a transient
  "rupload transient fault (offset probe failed: ...)" for a probe that had in
  fact answered with a valid offset — sending the caller to retry a network that
  was never at fault. The sink's throw is now caught and logged as a warning on
  both paths.

- **A finished video upload no longer loses the video id when its session record
  expires mid-call.** `finishVideoUpload` checked the session on entry, then
  required the bookkeeping update to find that same record after the commit had
  succeeded. Session TTL is measured from `updatedAt` and `finish` does not touch
  the record before the wire call, so a `finish` issued near the end of an idle
  window can straddle the eviction boundary — and the caller was then handed
  `not_found` with "upload session lost — restart the upload" for a video Meta had
  already created. Restarting produces the duplicate video CC-MEDIA-3 exists to
  prevent, and the `videoId` was the only handle to the one that existed. The
  bookkeeping update is now optional and falls back to the snapshot taken on
  entry; the entry check for a genuinely unknown session is unchanged.

- **A revoked Page token no longer survives until the server is restarted.** The
  per-Page token cache is documented as holding a derived token "until it is
  explicitly invalidated (error 190)", which is the right contract for a caller
  that drives the full C1 rail — derive, run, invalidate and re-derive once on a
  dead token. Nothing drives it. `runWithPageToken` is implemented and tested but
  has no production caller and is not surfaced through the Pages registry at all,
  and `invalidate` is called by nothing outside the registry itself. With no TTL
  injected at the wiring site either, the cache had no eviction path whatsoever:
  a token Meta revokes — a password change, a role removed, a permission pulled
  in app review — stayed cached for the entire process lifetime, every call on
  that Page kept failing with the same dead credential, and restarting the server
  was the only cure. The registry now defaults to a fifteen-minute window, so the
  outage is bounded and self-healing at a cost of one derivation per Page per
  window. Reaching the C1 rail from the tools layer remains open; this bounds the
  damage rather than closing it.

- **A bulk moderation batch where every id failed no longer claims the rest were
  applied.** `bulkSummary` attached a fixed note — "N of M ids failed; the rest
  were applied" — whenever anything failed, including when nothing succeeded, in
  which case there is no rest. That note was the batch's only chance to say so:
  the write gate marks any `perform` that returns without throwing as `applied`,
  so the envelope around it reports success no matter what the tally says. An
  operator reading the result of a wholly failed hide or delete was told the
  opposite of what happened. All-failed now reads "All M id(s) failed — nothing
  was applied.", across hide, delete and both blocked-user variants. The envelope
  and the journal still say `applied`; that lives in the write gate and is not
  closed here.

- **A message send Facebook did not confirm is no longer reported as confirmed.**
  Graph can acknowledge a send without returning a `message_id`, and the API layer
  models that faithfully by returning no id. The tool did not: it emitted one
  static note asserting that Facebook "acknowledged the send with a message id, so
  delivery is confirmed" and carried no field distinguishing the two cases, so a
  caller had no way to tell an unconfirmed send from a confirmed one. The outcome
  now carries `delivery: 'sent' | 'unconfirmed'`, and the unconfirmed note says
  what it actually knows — the message may well have landed, check the
  conversation before assuming otherwise, and do not blind-resend.

- **Forged envelope delimiters in visitor content are neutralized instead of
  passed through verbatim.** The reader package surfaces untrusted content in the
  taint envelope's structured form, which doc 04 control #1 sanctions — but the
  delimiter neutralization lived inside `renderTainted`, the text-form renderer
  the package never calls. The delimiters are a documented, stable contract, so an
  attacker knows them too: a visitor post or a display name containing a literal
  `⟦END UNTRUSTED CONTENT⟧` emitted that marker into the session, closing the
  envelope early and passing everything after it off as trusted text. This was the
  largest attacker-authorable surface in the server, and the only tools file with
  the gap — moderation and messages both neutralize. All three taint sites in the
  reader now run a deep pass over the Graph value first. The substitution itself
  is the renderer's own `neutralizeDelimiters`, now exported rather than copied,
  so the two spellings of a neutralized marker cannot drift apart.

- **A reply to a thread could quietly go to someone outside it.** A send given
  both `conversation_id` and `recipient_id` trusted the pair: a recipient who was
  not a participant of that thread got the message anyway, while the caller
  believed it had answered the conversation it named. The send now reads the
  thread's participants and refuses a recipient who is not one of them (when the
  participant list is known). A message that is only whitespace is refused
  before any Graph call instead of being sent as a blank message.

- **A blank value in the client environment no longer hides the `.env` file.**
  The file loader kept any key already present in `process.env`, so a client
  config template that passed `FB_ACCESS_TOKEN=""` shadowed the real token in the
  file and the server started as if unconfigured. A present-but-blank value now
  counts as unset for the file's purposes; a non-blank client value still wins.
  The credential-file protection check also refuses anything that is not a
  regular file (a directory, a FIFO) instead of reporting on it as if it were.

- **Ads field selection and paging respect nested fields and the row cap.** The
  top-level field names of a `fields` string were found with a regex that could
  not see past one level of braces, so `insights{actions{value}}` produced a
  bogus name and a wrong allow-list decision; the split is now depth-aware. The
  insights and async-report readers also asked Graph for a full page even when
  the caller's row cap was smaller, fetching rows that were then thrown away; the
  page size is now capped by the rows still wanted.

- **Result truncation drops one oversized string before it empties a list.**
  Budget reduction trimmed arrays first, so one huge text field could cost a
  result every list item while the field itself survived. Any single string leaf
  larger than the whole budget is now dropped first. The `_truncation` note also
  stopped promising that dropped items are on the next page — they are not; it
  now says to re-request with a smaller limit or narrow the query.

- **A multi-photo upload no longer claims "nothing was left behind" when it
  cannot know that.** When a child photo's upload ended with an unknown outcome
  (a 5xx, a lost body, a 2xx without an id, or a cancellation mid-request), the
  cleanup report listed no orphans, and the operator was told every unpublished
  photo had been cleaned up — while that photo may exist with an id nobody
  received. The report now carries `unconfirmedUploads`, and the notice names the
  photo and asks the operator to check the Page's photo library.

- **A local photo is read with a hard ceiling, and only real HEIF is labelled
  HEIC.** The byte ceiling was checked against the size from `stat`, then the
  whole file was buffered, so a file that grew in between was read past the
  ceiling; the read now stops at the ceiling plus one byte and refuses the file.
  Content sniffing labelled every ISO-BMFF file `image/heic` — MP4 and MOV
  included — because it matched `ftyp` without looking at the brand; it now
  requires a HEIF brand, and anything else falls back to the extension.

- **Error code 190/464 gets its own advice.** An unconfirmed Facebook account
  is refused whatever token is minted for it, so the generic 190 advice
  ("re-authorize") looped. The error matrix now has an `auth-190-464` row telling
  the operator to confirm the account first, then re-authorize.

- **An error with no usable message is described the same way everywhere.** The
  sixteen sites that turned a caught value into text each had their own
  `instanceof Error ? … : String(…)`, and some of them threw on a hostile value (a
  getter that throws, a `toString` that does). They now share `errorMessageOf`
  in `core/errors`, which never throws and falls back to "unknown error (no
  message)". The comment and messaging rewraps also keep the original error as
  `cause`.

- **The logger and redactor survive hostile values.** A field whose getter
  throws is logged as `[UNREADABLE]` instead of taking the whole log line down,
  an `Error` whose `name`/`message`/`stack`/`cause` getters throw is still
  described, and an `AggregateError`'s inner errors are now carried (and
  redacted) instead of dropped.

- **A duplicate tool name across packages depended on which packages were
  selected.** The registry now claims every tool name across all injected
  packages before selection, deny or read-only filtering, and the error names
  both packages.

- **Insights errors and truncation notes lost detail.** A failed metric now keeps
  Graph's user-facing title and message, a row cap names the series it cut, and
  the summary picks the first and last period by time rather than by row order.

- **Insights tools accepted input that bypassed their own checks.** A
  comma-packed metric entry (`"page_impressions,page_follows"`) skipped the
  renamed-metric check and the 20-name cap, and is now refused.
  `facebook_post_insights` refuses a post whose Page prefix is not the resolved
  Page, instead of sending it with the wrong Page's token. `facebook_reel_insights`
  now points to `facebook_list_reels` as the source of an existing Reel's id.

- **`resolvePage()` with no default Page now lists the configured profiles** the
  caller can pass.

- **Moderation writes whose answer was lost were journaled as failed.** A reply,
  private reply or block that ends in a network fault, a 5xx or an ambiguous
  error is now journaled `attempted` (it may have landed); a Graph refusal stays
  `failed`. A private reply to the Page's own comment is refused before the gate,
  since it can never succeed and burns the one-shot.

- **An empty comment page that carried a forward cursor was called the end of
  the listing.** The returned-cursor check now runs first, so a filtered walk is
  not stopped while rows remain.

- **Repeated ids in a bulk moderation call were acted on and counted twice.** The
  second delete of the same comment was reported as "already gone", and the tally
  counted three outcomes for two comments. `comment_ids` and `psids` are now
  de-duplicated in order, and the preview counts distinct ids.

- **A 200 with no object was reported as a successful post or reaction read.** A
  bare `false`, `null`, string or array body from `getPost` or the reaction
  totals now raises a `not_found` error. Reaction totals Graph did not report are
  named as unknown in the note instead of reading as zero.

- **`create_post` names child uploads of unknown outcome as a structured
  `unconfirmedUploads` field** (1-based `photo` plus the error) in its cleanup
  payload, not only in prose.

- **The HTTP server refused every client after one ended its session.** The SDK
  closes the whole transport on `DELETE /mcp`, which then answered every new
  `initialize` with "Server already initialized" while the listener stayed up.
  The server now re-arms with a fresh transport; a real shutdown still closes it.

- **Schedule messages name spans a person can read.** A too-soon, too-far or
  reschedule-window refusal now says "2 days 3 hours" (the two largest units)
  instead of a raw figure, and a time already past says "is X in the past".

- **Reel uploads name the video Meta already holds when the finish phase fails.**
  The error message, `operatorText` and the tool envelope carry the `video_id`,
  so the operator can inspect or delete it. A throttle with no Graph retry hint
  no longer claims the wait came from Graph, and a stalled upload offset is
  refused instead of looping.

- **Message timestamps without an explicit offset are refused** instead of being
  read in the host time zone.

- **Budgets use the unit Meta counts, not the ISO subunit.** COP, CRC, HUF, IDR
  and TWD are zero-decimal in Meta's currency-offset table, and BHD and JOD count
  hundredths; previews and refusals now render them that way, and the tool
  descriptions and the fractional-budget refusal define the minor unit as the
  currency offset. An ad-object update error keeps Meta's `userTitle` and
  `userMessage`.

- **An ad-object update checks that the object belongs to the configured ad
  account**, including an update that names no level (the common read fields now
  include `account_id`), and a failed update is classified like the other writes.

- **`setup-token` writes values with trailing backslashes or carriage returns
  safely**, accepts `--page <id>` and `--env-file <path>` in the space form, and
  `--no-write` renders the file before it reports that the write step was skipped.

- **Journal rotation failure no longer drops the entry.** A failed rotate writes a
  redacted note to stderr and the entry is still appended.

- **Feed schedule descriptions say "at least 10 minutes"**, matching the validator.

- **A resumable video upload that runs out of retries names its `video_id`**, and a
  finish call whose answer was lost (ambiguous, 5xx or network) points to
  `facebook_get_video_status` for that id instead of inviting a re-upload.
- **An unrecognized video status is reported as unknown**, not as "still processing".
- **A reel failure keeps Meta's `userTitle` / `userMessage`.**
- **Multipart uploads treat a connect-phase fault as a retryable transient**, since
  the bytes provably never left; upload errors (including the offset probe) honor
  the server's `Retry-After`; `file_offset` accepts only a plain decimal.
- **A granular grant with no `target_ids` means "all assets"**: auth records
  `appliesToAllTargets`, and the doctor reports it as `ok` / `(all assets)` rather
  than as revoked access.
- **A base token refused for an account block (190/459 checkpointed, 190/464
  unconfirmed)** says to clear the block on facebook.com, not to mint a new token.
- **The doctor maps `facebook_get_video_status`, `facebook_block_user` and
  `facebook_unblock_user` to their permissions**, and warns when data access expires soon.
- **`facebook_get_usage` reports a throttled probe** (`throttled`, `retryAfterMs`)
  and explains unreadable usage headers.
- **A UTF-16 `.env` (Windows PowerShell 5.1 `>` / `Out-File`) is read correctly.**
- **An `FB_PROFILE_<NAME>_TOKEN` with no matching `_PAGE_ID` is reported** instead of
  being silently ignored.
- **A write whose transport outcome is ambiguous is journaled `attempted`**, not
  `failed`, so the audit trail never claims a possibly-landed write did not happen.
- **Package error records carry Meta's own explanation**: `code`, `subcode`, `type`,
  `httpStatus`, `fbtraceId`, `userTitle` and `userMessage` (length-bounded), including
  on a Reel phase failure; a locally raised Reel refusal invents no Graph code.
- **A carousel post whose feed call may have landed no longer deletes its child
  photos**: it reports `carousel_post_unconfirmed` with the `photoIds` and says to
  verify before cleaning up by hand. A clean rejection still cleans up as before.
- **`facebook_create_video_post` no longer calls a declined finish, or a 2xx with no
  video id, "a finished upload being transcoded"**; each case gets a note that says
  what actually happened.
- **The doctor lists the real permissions**: `facebook_list_comments` needs
  `pages_read_engagement` too, the `moderation` package is the union of its tools'
  permissions (adds `pages_read_engagement` and `pages_messaging`), and a token that
  could not be checked prints `unknown (not checked)` instead of "invalid, no scopes".
- **`doctor` names an argument it ignored** (option names only, never a value), so a
  mistyped `--strict` is visible; **`--help` / `-h` prints usage and exits 0** instead
  of starting the server or failing on missing configuration.
- **A listing page that hands back the cursor it was resumed with is not
  resumable**: `fetchPage` marks it truncated with the loop-guard note, matching
  `fetchAll`, instead of offering an endless resume loop.
- **Graph errors keep the usage headers of the response that refused them**
  (`usageOfGraphError`), and a `Retry-After` too large to be a number is no longer
  surfaced as an infinite wait.
- **The Page token resolver** evicts a token still dead after its one re-derivation,
  treats code 102 (session expired) like 190, and shares one derivation between
  concurrent resolves for the same Page, never caching a rejected one or one
  invalidated mid-flight.
- **Local-file uploads work in the shipped server**: `main()` never wired the
  multipart / resumable upload handler, so every local photo, video chunk and Reel
  upload was refused before it was sent. The server now builds its Graph client with
  the upload handler and one shared per-host concurrency budget (`createTransport`).
- **A derived Page token Graph refuses (190, 102, or 100 with subcode 21/33) is
  evicted by the server**, so the next call re-derives instead of reusing the dead
  token for the rest of its cache lifetime.
- **Server error records carry the usage figures of the response that refused the
  call** (`usage`: `appUsagePct`, `businessUseCasePct`, `adsInsightsThrottlePct`),
  and Meta's `userTitle` / `userMessage` there are length-bounded.
- **`facebook_usage` reports the figures a refused probe carried** instead of calling
  them unavailable, and **`facebook_whoami` returns the Graph identity of a failed
  `debug_token` call** (`graphError`: code, subcode, trace id, Meta's text).
- **`update_post` and `delete_post` journal a write cut off in flight as
  `attempted`**, not `failed`; `facebook_get_video_status` names the `videoId` field
  `facebook_create_video_post` actually returns.
- **A bulk hide / delete / unblock cancelled while a request is on the wire** marks
  that id ambiguous and journals the sweep `attempted`, instead of reporting "nothing
  was applied".
- **`facebook_private_reply` and `facebook_get_comment` name the permissions they
  actually need** (the pre-flight comment read needs `pages_read_engagement`).
- **An ambiguous message send points at `facebook_get_conversation`**, not a posts
  listing, and says not to resend if the text is there; a messaging-window or
  recipient-unavailable refusal keeps Meta's own explanation.
- **`facebook_update_ad_object` without a configured ad account** takes the currency
  and the health check from the account the object belongs to, so a zero-decimal
  budget is shown in whole units and a disabled account is refused; an update that
  provably never left the machine is journaled `failed`, not `attempted`.
- **Multipart uploads use the transport's own "provably not sent" rule**, so an error
  whose own code is a mid-flight reset stays ambiguous (not retried) even when its
  cause names a connect-phase code.
- **A resumable-upload 5xx is resent after a growing backoff** that honors
  `Retry-After`; a `Retry-After` beyond 30 s surfaces at once with that wait instead
  of burning the resume budget in milliseconds.
- **An append-only or foreign-owned journal no longer reports every append as
  failed** when `chmod` is refused after the record was written; a loose mode that
  cannot be fixed is reported on stderr.
- **An ambiguous write names the tool that can actually show it.** The outcome-unknown
  guidance used to send every write to `facebook_list_posts`, a listing that can
  never show a comment, an ad edit, a scheduled post or a Reel. Each write now names
  its own read: comment reply → `facebook_list_comments`, hide / delete →
  `facebook_get_comment`, private reply → `facebook_list_conversations`, ad update →
  `facebook_get_ad_object`, post update / delete → `facebook_get_post`, scheduled
  photo → `facebook_list_scheduled_posts`, video transfer / finish →
  `facebook_get_video_status`, a published Reel → `facebook_list_reels` (a draft or
  scheduled Reel → `facebook_get_video_status`). A write whose only id was in the
  lost response (block / unblock, video-by-URL create, upload start) names none.
- **Scheduled and draft posts are no longer told to verify on the published
  listing**: the create / photo / video / carousel verify notes and the id-less
  video note follow the publish state, and `facebook_update_post` gives an edit or a
  reschedule its own note instead of the publish one.
- **A resumable video upload that runs out of retries names
  `facebook_get_video_status` as the next tool**, and one without a video id points
  at the Page's video library instead of a status check it cannot run.
- **Deleted or archived ad objects** surface as `not_found` with a re-read of the
  object, not as an argument error.
- **A bulk moderation sweep stops at the first dead Page token**: the token is
  evicted once and the remaining ids are reported "not attempted" instead of each
  failing on the same token. The server and `facebook_create_post` recognise a dead
  token behind a wrapped error too.
- **An ambiguous Reel upload start is journaled `failed`**, not `attempted`: only the
  finish phase can publish a Reel.
- Insights: a Graph `metric[N]` rejection now names the metric at N in the list actually sent (deprecated names dropped, case folded, duplicates merged), not in the caller's list.
- Insights: a metric Graph omits or returns empty is no longer blamed on its name alone — the notes say an unsupported metric/period pair looks the same.
- Insights: a rolling or lifetime total whose newest point is an empty breakdown map (`{}`) is now 0, instead of reporting an older window as the latest.
- Ads: `WITH_ISSUES` now says the object may still be delivering and spending in part, and a paused parent together with a paused child says to resume both.
- `facebook_list_posts` / `facebook_list_reels`: the listing note and descriptions now say scheduled posts and drafts are not on any post edge, so a missing post is not taken as proof it was never created.
- `facebook_get_post`: the default `comment_count` is now flagged as counting top-level comments only (replies excluded).
- Write gate: a high-consequence apply now re-reads the state after the out-of-band confirmation and refuses with `diverged` if the world changed while the prompt was open.
- Result shaping: a string list no longer empties around an entry that was already dropped as too large for the budget.
- Settings: a leading `~` in `FB_JOURNAL_PATH` / `FB_MEDIA_DIR` is expanded to the home directory; a relative `FB_JOURNAL_PATH` warns and falls back to the default path.
- Publish verify notes no longer tell the model to filter `facebook_list_posts` "to the last few minutes" — the tool has no time filter; they now say to match `created_time` and message text.
- Moderation: a `100/33` answer to an unblock of a never-blocked PSID no longer evicts the Page token or stops the sweep — only a GET on the Page itself proves the token dead.
- `facebook_list_comments`: when only the total-count summary call fails, the comments are still returned with a note (a dead token still fails loudly).
- Messaging: the 24-hour window is no longer declared closed past a message the server could not date or attribute; the verdict is `unknown`, and `facebook_send_message` no longer refuses locally a send Facebook would accept.
- Messaging: the no-recipient refusal says only the newest 10 messages were read, instead of claiming the whole thread names nobody.
- Photos: a DELETE answered with a bare `false`, `"false"` or `null` is no longer counted as a confirmed cleanup.
- Photos: with a symlinked `FB_MEDIA_DIR`, a missing file under it is reported `file_not_found`, not as a path outside the directory.
- `facebook_update_ad_object`: an update cancelled before its POST was sent is journaled `failed`, not `attempted` ("may be live").
- `facebook_list_pages`: an unreadable account list, or entries dropped as malformed, now carry a note instead of passing as a complete, empty-or-short list.
- Doctor: a metric Graph leaves out of the probe is no longer declared an invalid name — Graph omits a metric that does not serve `period=day` the same way.
- Doctor: an isolation pass that stopped on a rate limit or fault no longer counts the metrics it never asked about as broken names.
- Doctor: a `debug_token` call rejected while signed with `FB_APP_ID|FB_APP_SECRET` now names the app credential as a suspect, and the package matrix reads `unverified` rather than inventing missing permissions.
- Transport: a server-named wait (`Retry-After`, or the throttle ETA) is now slept in full; jitter only applies to the local exponential backoff, so retries no longer land inside the throttle window.
- Transport: network faults now name the underlying cause (`getaddrinfo ENOTFOUND`, `ECONNRESET`, TLS) instead of undici's bare "fetch failed", and a non-Error rejection keeps its message.
- Video uploads refuse a resume offset past the file's end instead of resending from a desynced position; a status-0 finish that provably never left the host is no longer reported as "may have landed".
- An ambiguous Reel start or upload no longer claims the Reel may have been published: only the finish phase publishes, so re-running is reported as safe.
- `facebook_delete_post` no longer reports a post as "already absent" (and the delete as applied) when Graph refuses the delete but the post is still readable.
- `facebook_update_post action:"publish_now"` points at a check the caller can run (`facebook_get_post`, `is_published`) and refuses a post that is already live instead of claiming it published it.
- A 190/492 during Page-token derivation now says the token's user has no role on the Page, not that the base token expired; stale-Page guidance names the real `FB_PROFILE_<NAME>_PAGE_ID` variable.
- Startup warns when a profile key equals another profile's raw Page ID, since the key would shadow that ID.
- A profile named `__proto__` is refused at startup instead of silently disappearing.
- Code 368 policy blocks no longer surface an invented 60-second cool-down; top-level code 21 (migrated Page ID) is classified as not-found with the fix named.
- `setup-token --no-write` reports the refusal (symbolic link) or `--force` requirement the real run would hit; a truncated Page listing never auto-selects its only visible Page; a failed Page-token derivation names the redacted reason.
- The "server started" log line lists only the packages actually loaded; the insights doctor probe no longer calls metrics Graph never returned "accepted"; `facebook_page_insights` refuses a window starting after tomorrow.
- The insights window messages no longer claim Graph serves at most 90 days (Graph allows 93; 90 is this server's cap) and no longer name an `until` the caller never passed.
- **A write that Graph refused with a transient code (1/2, or `is_transient`) at a 4xx status was reported as a clean failure.** A transient refusal on a write can follow a mutation that already landed; `core/http.ts` and `core/http-upload.ts` now report it as ambiguous (may have landed; verify before retrying) at any HTTP status, never as retryable.
- **A server-named wait longer than the sleep cap was cut short and retried early.** When `Retry-After` or a throttle ETA exceeds the retry cap, the transport now fails fast and reports the real wait instead of sleeping the capped delay and hitting the same limit again.
- **A Page-token derivation answered 2xx without an `access_token` was reported as Graph error 190 with HTTP 403.** Graph sent neither; the error now carries code 0, the status Graph actually sent, and a `permission` action pointing at `facebook_whoami`, and it no longer makes eviction hooks treat a missing Page role as a dead token.
- **The ads-object refusal in its real wire shape (100 with subcode 33) kept the generic "treat it as already gone" diagnosis.** It is now re-mapped like the bare 100, and the diagnosis names a missing `ads_management` edit permission as a cause. A DELETED object is no longer told to be restored in Ads Manager — deletion is final.
- **A bare `false`, `null` or text body was read as a confirmed write.** Comment delete/hide, unblock, `facebook_update_post` and `facebook_delete_post` now confirm only on a bodiless 2xx, a bare `true`, or a record whose `success` is absent or `true`.
- **`facebook_get_post`, `facebook_list_posts` and `facebook_list_reels` stripped the paging of a nested expansion without saying more existed.** The node now carries `has_more: true` and the note says the expansion is partial. Metadata text bounding no longer leaves a lone high surrogate at the cut.
- **An apply racing an in-flight apply of the same plan was told the plan was "expired, already applied, or never created".** It is now told the plan is in progress, and the post tools hint to wait for that result instead of re-planning — which would perform the write twice.
- **A failed `chmod` of the retained journal generation was reported as a failed rotation past the size cap.** The rotation did happen; the note now names the retained file that could not be restricted to 0600.
- **Shortening an untrusted-content warning to fit `FB_MAX_RESULT_CHARS` was reported as dropped data.** The truncation note now says the warnings were shortened and no data was dropped, instead of telling the model to narrow the query.
- **Closing stdin while a tool call was running aborted the call and dropped its response.** The stdio transport now waits for in-flight requests (bounded by `STDIO_EOF_DRAIN_MS`, 120 s) before shutting down.
- **`setup-token --force` replaced the env file without saying which keys it dropped.** The dry run, the overwrite refusal and the written report now name the keys (never their values) that the new file will not carry, and the report gains an optional `droppedKeys` field.
- **A tool removed by package configuration was answered with "unknown tool".** The error now says the tool is disabled and names the package and the setting (`FB_TOOL_PACKAGES` / `FB_PACKAGES_DENY`, or `FB_PACKAGES_READONLY`) that removed it.
- A video or Reel upload chunk answered 2xx with `success:false` and no offset is no longer counted as landed; it stalls at the refused offset and fails through the resume budget instead of finishing (and publishing) an incomplete upload.
- Graph code 803 (an id or alias that does not resolve) is classified as `not_found`, not as a Page-role permission problem, in both the error matrix and the unrecognized-code fallback.
- A code-100 `appsecret_proof` rejection now points at `FB_APP_SECRET` (category `auth`) instead of telling the caller to fix the tool arguments.
- `facebook_get_comment` says when Graph cut the reply expansion short (`repliesHasMore` plus a note naming `facebook_list_comments`), instead of presenting the first replies as the whole thread.
- Bulk moderation no longer claims a comment was deleted when Graph's 100/33 may equally mean the comment belongs to another Page; the note says what the evidence shows.
- A message send cancelled before its POST was issued is journalled `failed`, not `attempted`.
- `facebook_update_post` with `action:"reschedule"` refuses a post that is already live instead of previewing and applying a move.
- `facebook_create_post` refuses a `link` or card `link`/`picture` that is a local path or a non-http(s) URL before any write.
- The doctor leaves the package matrix unverified when `debug_token` answers 200 with an invalid token, instead of reporting permissions as missing.
- `facebook_whoami` marks `token.unverified` when `debug_token` gave no answer, so its placeholder `valid:false` / empty scopes are not read as Graph's verdict.
- The `FB_ADS_BUDGET_CEILING` documentation states the ceiling is in minor units of the ad account's own currency, with no conversion.
- A Business-Use-Case throttle (codes 80000-80099) now honors the regain-access
  wait named in the `X-Business-Use-Case-Usage` header, in both the JSON client
  and the upload client, instead of retrying into the blocked bucket and
  surfacing the 60 s default.
- An ambiguous 5xx on a write now keeps the usage snapshot of its response, like
  every other terminal error.
- A `/debug_token` 2xx without a boolean `is_valid` is reported as an unanswered
  check (`token_check_failed`, `unverified`), no longer as an invalid token the
  operator is told to re-issue.
- One refused read no longer fails a whole bulk hide/delete preview: the id is
  marked unreadable, named in a preview warning, and never acted on at apply; a
  change in readability between preview and apply diverges.
- `facebook_get_post` refuses the Page itself (its id or `me`) as a post id, so a
  `fields` override cannot read Page edges a denied package guards.
- `getPost` marks a default-set comment or reaction count Graph did not report as
  unknown rather than omitting it silently; `listPosts` says an empty page with a
  forward cursor is not the end of the posts.
- `setup-token` warnings composed before the write step no longer claim the env
  file was written when the write was refused, failed, or was a dry run.
- A published `no_story` photo whose upload answer was lost no longer points at
  `facebook_list_posts`, where it can never appear.
- A budget write of the kind an ad object does not use warns that the object
  spends against the other budget kind and that Graph is expected to refuse the
  switch.
- Two servers sharing one journal no longer rotate away each other's records: a
  pid-stamped cross-process lock guards rotation, and an append that loses its
  live file to another server's rotation still records the entry.
- A result cut down by the final size guard keeps its top-level scalar fields
  (error category, retryable, next tool) that fit the budget instead of dropping
  them all.
- A truncated error result is no longer told to narrow the query or fetch the
  next page; it says to act on the fields kept, or raise FB_MAX_RESULT_CHARS.
- An empty ads listing or ads insights page that still carries a forward cursor
  is no longer reported as "no objects" or "did not deliver": a note says more
  pages follow. The facebook_ads_insights description now says the same.
- Bulk comment moderation reads a repeated comment id once instead of spending a
  second call that could overwrite the state it already observed.
- A conversation page that dropped unreadable rows no longer yields a "closed"
  messaging window, nor a local refusal to send: the verdict becomes unknown.
- A photo upload by URL that Meta could not fetch (code 324, or 100 "could not
  fetch") names the URL as the problem instead of "unclassified" or "fix the
  arguments"; code 324 elsewhere is a non-retryable validation error.
- facebook_get_post, facebook_get_reactions and facebook_post_insights refuse a
  Page username as a post id, so the read cannot land on the Page node.
- A 100/33 refusal to edit a post the tool has just read no longer claims the
  post is gone; a re-read confirms it is still there and unchanged.
- facebook_doctor no longer reports missing scopes when no token is configured,
  and its metric-set probe reads Page insights with the Page token.
- A metric list with one entry Graph rejects by position still answers the rest,
  reporting the rejected name in `rejectedMetrics`; a Page metric on a post (or a
  post metric on the Page) is named as a scope mismatch, not a typo.
- A 2xx answer whose body is not JSON (a proxy or captive-portal page, a truncated body) is no longer handed to the api layer as data: a read fails with the classified no-envelope error, and a write is reported ambiguous (C2) and never re-sent. Before, a list read it as an empty listing and a delete as "Facebook did not confirm".
- On stdio, stdin EOF now waits for every in-flight request that shares one JSON-RPC id, not just the first one answered, so a second call with a reused id is no longer aborted with its outcome lost.
- A misspelt or unknown `FB_*` environment variable (for example `FB_ADS_BUDGET_CEILNG`, or `FB_PROFILE_ACME_PAGEID`) now raises an `unknown-setting` startup warning naming the closest real setting, instead of being silently ignored. Only the name is reported, never the value.
- A journal path that names a directory is refused before anything touches it; the server previously chmod-ed that directory to 0600.
- A 200 answer with no `data` array is no longer reported as a complete, empty listing ("no comments", "no posts"): the page is marked truncated with a note, and a multi-page walk keeps the rows read so far.
- `facebook_list_reels` now notes that more pages follow when an empty page still carries a forward cursor.
- A bulk hide/delete comment sweep stops sending writes after Facebook reports a rate limit; the remaining ids are reported as not attempted, with the wait. The plan-time comment snapshot likewise stops reading and marks the rest unreadable.
- `facebook_list_comments` keeps the comments it read when the summary call answers 100/33 for the object, instead of failing and evicting a live Page token.
- An ad update answered with a bare `false`, `null` or `0` 2xx body is no longer journalled as an applied budget or status change.
- Ads insights now always read `account_currency` alongside money metrics (default fields and caller-chosen fields, sync and async), and the `facebook_ads_insights` description states that spend/cpc are decimal amounts in that currency, not minor units.

### Security

- **The credential file and the write journal could be created outside the
  per-user config directory.** The XDG and `%APPDATA%` base directories were read
  with `??`, which only guards `undefined` — an EMPTY value is a real thing when
  a launcher, a systemd unit or a `sudo` scrubbed the variable, and joining `""`
  with the app name yields the RELATIVE path `facebook-mcp`. The env file holding
  the access token, and the journal recording every write, were then created
  under whatever directory the MCP client happened to spawn the server in,
  outside the `0700`/`0600` that protects them. Empty and non-absolute values are
  now treated as unset, which is what the XDG spec says they mean.
- **`FB_CONFIRM_TOKEN` was accepted at any length, including one character.** The
  token is the out-of-band answer that authorises an irreversible write, the
  comparison is constant-time but nothing rate-limits it, and the party retrying
  it is the model the gate exists to restrain — at one character the first guess
  wins. A confirm token shorter than 16 characters is now a startup error naming
  `openssl rand -hex 32`, rather than a gate armed with a secret that is not one.
- **An own `__proto__` key on a Graph node replaced the record's prototype
  instead of becoming a field.** `JSON.parse` creates `__proto__` as an own
  property, so the shaper's key loop hands it to a plain assignment, which runs
  the inherited setter: the key vanished from the output and every value on the
  injected object began answering property reads — a fabricated
  `daily_budget_minor`, say — on a record the shaper never validated. Ads nodes,
  insights rows and post nodes are now assigned the same way shaped results
  already were, at every depth.
- **The write gate could apply a write whose parameters differed from the one it
  previewed.** A plan pins a deep copy of its `params` so the apply-time
  comparison has a stable fingerprint, but the copy was built with a plain
  assignment. An own `__proto__` key — what `JSON.parse` produces, and what any
  caller forwarding a raw payload or a Graph node carries — was therefore never
  stored: a string value was swallowed by the inherited setter, so the pinned
  fingerprint was missing a parameter the operator had approved, and an apply
  that omitted it compared equal and went through. An object value re-parented
  the copy instead, which made the plan unappliable against the very parameters
  it was minted from. The pinned `beforeState` had the same hole, so an untouched
  Page could report a phantom divergence and block a legitimate apply. Both
  snapshots now define their keys.
- **A field named `__proto__` was dropped from every redacted record.** Redaction
  is the single choke-point all output passes through — log lines, tool results,
  error payloads — and it rebuilds each object into a fresh copy with a plain
  assignment. A `__proto__` key off the wire was consequently scrubbed and then
  discarded rather than written, or, when its value was an object, re-parented
  the copy so the whole subtree disappeared from anything that serialised it.
  Nothing leaked — the value was lost, not exposed — but the record an operator
  reads after an incident was not the record the server handled.

- **Control characters could rewrite the frame the operator reads visitor text
  in.** Every piece of third-party text — a comment, a message, a page name — is
  wrapped in a delimiter envelope whose two markers are neutralized if the
  content forges them. The markers were the only thing checked, and Unicode
  offers several ways to attack the frame without touching them: an unterminated
  `RIGHT-TO-LEFT OVERRIDE` reorders the closing delimiter into the middle of the
  quoted body, isolates open a scope that outlives the envelope, zero-width
  characters hide a directive from the human reviewing the transcript, ANSI
  escapes rewrite the terminal that transcript is read in, and Unicode tag
  characters are invisible by definition. Every C0/C1 control, the bidi
  formatting range, the zero-width set and the tag block are now escaped to their
  `U+XXXX` spelling at the single chokepoint that already neutralizes the
  delimiters. TAB, LF, emoji joiners and the marks that shape non-Latin scripts
  are deliberately spared — a neutralizer that damages legitimate text is one
  operators learn to route around.
- **A token carried in a URL survived the journal's value redaction.** Journal
  entries were redacted by value and written; the structural strip that drops
  Graph paging objects and neutralizes token-bearing URLs ran on tool results but
  not on the audit record. An `access_token` sitting in a `next`/`previous` query
  string is not a bare secret the value scan recognizes — it is a URL — so it
  reached a file that is `0600` for a reason and that both tooling and people
  read back. The journal now runs the same structural strip as the result path,
  ahead of redaction.
- **A previewed ad-account write could be applied against a different ad
  account.** `facebook_update_ad_object` is the server's only `spend`-tier tool,
  and the write gate pins the arguments a plan was previewed with so that an
  apply which changes them is rejected — but `ad_account_id` was not among the
  pinned params. The account decides which object the budget is read against and
  which currency the confirmed sentence is denominated in, so a plan confirmed as
  a daily budget on one account could be applied against another under the same
  `plan_id`. What is pinned is the _resolved_ account rather than the raw
  argument: it is optional and falls back to `FB_AD_ACCOUNT_ID`, so pinning what
  the caller typed would let a preview that took the default be applied against
  an account named explicitly. Naming the same account the preview resolved to is
  still accepted.

- **The live smoke harness could be pointed at the operator's own Page, and
  would then sweep it.** `FB_SMOKE_TEST_PAGE_ID` is the Page write smokes create
  artifacts on and the sweeper deletes every marked artifact from, so the
  resolver refuses to start when it equals the read Page. But the read Page is
  `FB_SMOKE_PAGE_ID ?? FB_PAGE_ID`, which means the server's own default Page was
  only covered by accident: set `FB_SMOKE_PAGE_ID` to a third Page — exactly what
  an operator does when they want to read a Page that has real content — and a
  test Page typo'd to `FB_PAGE_ID` passed the guard whose own message says the
  test Page "must never be a Page you care about". The check now compares the
  test Page against both, and names which collision it found.

  This is also the first automated coverage the harness has had. It sits outside
  `rootDir` and outside the test glob so it never ships, which left its refusals
  — the gate being `=== '1'` rather than truthy, the deliberate absence of a
  fallback to `FB_PAGE_ID`, reporting every problem at once instead of one per
  run, forcing the child server to `plan`/`stdio` over whatever the operator's
  shell said, and the registry's `writes ⇒ page:'test'` invariant — resting on
  review alone. `src/smoke-harness.test.ts` imports the pure decision functions
  the way `src/record-fixture.test.ts` imports the recorder and pins them; it
  opens no socket and spawns no server.

- **The two most privileged jobs in the release rail no longer run dependency
  install scripts.** `npm-publish` holds `id-token: write` and, until trusted
  publishing is configured, the npm token; `bundle` holds `attestations: write`
  and produces the bytes the workflow then signs a provenance statement over. A
  `postinstall` from anywhere in the dev tree executed inside both, and the tree
  contains one today by way of ESLint's import resolver. Neither job needs it —
  the build is `tsc` — so both switched to `npm ci --ignore-scripts`. The `gate`
  job keeps a plain `npm ci` deliberately, because it is where ESLint runs and it
  holds nothing worth stealing.

- **A URL-encoded app access token is no longer printed in the clear.** The
  defensive pattern scan matched the composite `{app-id}|{app-secret}` form only
  with a literal pipe, so the same token that had been through a URL — arriving
  as `{app-id}%7C{app-secret}`, which is how it looks in a query string, and
  therefore in an error message quoting one — went through unmasked. The 32-hex
  rule that exists to catch a bare app secret could not rescue it either: `%7C`
  ends in `C`, a word character, so the rule's leading `\b` never matched at the
  secret's first digit. The composite pattern now accepts the percent-encoded
  separator in either case. This is defense-in-depth only — a token the server
  holds is redacted by value and was never affected — and it is the path that
  matters for a secret the server does not hold, such as one a user pastes into a
  tool argument.

- **An object's `toJSON` could put an unredacted secret in the output.** The
  redactor walked an object's own fields, but the serializer later called its
  `toJSON` and printed whatever that returned, unredacted. The redactor now calls
  `toJSON` itself (own or inherited) and redacts the result; a `toJSON` that
  throws becomes `[UNREADABLE]`.

- **Look-alike brackets no longer fake the taint envelope.** Delimiter
  neutralization caught the envelope markers only in their exact spelling, so a
  visitor could close the envelope early with the same words in `〚 〛` or other
  bracket look-alikes. Those are now folded to the canonical form before
  matching, a disguised marker is neutralized and flagged as forged, and the
  forgery notice says so.

- **Third-party fields on trusted posts are tainted.** A `fields` override on
  `facebook_list_posts`, `facebook_get_post` or `facebook_list_reels` could pull
  comments, reactions, shares or attachments into a Page-authored row, and they
  were returned as trusted content. Those fields are now wrapped in the taint
  envelope with their own source kind.

- **A path swapped for a FIFO no longer hangs a photo upload.** A local file that
  passed validation and was then replaced by a FIFO blocked the upload forever at
  `open`, before the handle check that refuses non-regular files could run. The
  open is now non-blocking, which changes nothing for a regular file, so the FIFO
  is refused and the photos already uploaded are cleaned up.

- **`FB_HTTP_TOKEN` must be at least 16 characters.** It is the only credential
  in front of the HTTP transport, nothing rate-limits it, and any local process
  can retry it; a short value is also registered as a redaction secret, so a
  common string like `test` was rewritten to `[REDACTED]` across logs, results
  and the journal. Under `FB_TRANSPORT=http` a shorter token now fails startup
  (`weak-http-token`); under stdio it is dropped with a warning. This is the same
  floor `FB_CONFIRM_TOKEN` already had, and both are now documented.

- **A hide or delete the token was not allowed to make was reported as done.**
  Graph answers both a deleted comment and one the token cannot moderate with the
  same 100/33 "does not exist, cannot be loaded due to missing permissions" text,
  so an abusive comment could stay public while the operator was told it was
  gone. A gone-looking write error is now confirmed with a `GET`: only a comment
  that is also gone to the read is "already gone"; otherwise the write fails.

- **The HTTP transport caps request bodies at 4 MiB.** The SDK buffers a whole
  POST body with no limit of its own, so an authenticated client could exhaust
  memory. An oversized body (declared or chunked) is refused with HTTP 413 after
  the Host, Origin and bearer checks, and the server stays up.

- **Message attachment metadata is validated before it reaches the model.** MIME
  type, counts and URLs outside the untrusted-content envelope must match a strict
  shape, so a crafted attachment cannot inject text through them.

- **`setup-token` refuses an env value it cannot write unambiguously**, so a
  token or page id cannot smuggle an extra variable into the env file.

- **Result truncation never strips the injection warning off an untrusted
  envelope**; it shortens it instead, so third-party content is never delivered
  without its warning.
- **Runs of Unicode variation selectors in third-party text are made visible**,
  closing a hidden-payload channel alongside the tag characters.
- **The redactor catches hex secrets that follow an escape sequence and redacts
  array elements individually**, closing two leak paths.
- **A non-JSON error body is redacted before it is cut to its snippet length**, so a
  secret straddling the cut (e.g. an `appsecret_proof` echoed by a proxy error page)
  can no longer leak its prefix.
- **Tag, recipient and place names (`message_tags`, `story_tags`, `with_tags`, `to`,
  `place`) and any aliased edge expansion with rows** are returned as untrusted-content
  envelopes even on a Page-authored post.
- **`setup-token` refuses to replace a symlinked env file**, even with `--force`, and
  treats a dangling symlink as an existing entry; the atomic write would otherwise
  replace the link, leaving the real file with the old token.
- UGC neutralizer: deprecated format controls (U+206A–206F) and interlinear annotation marks (U+FFF9–FFFB) are now escaped instead of passing through invisibly.
- Settings: a relative `FB_MEDIA_DIR` is now a startup error instead of allowlisting a directory resolved against the client's working directory.
- **A photo upload could read bytes from outside `FB_MEDIA_DIR`.** `O_NOFOLLOW`
  guards only the last path component, so a directory on the validated path
  swapped for a symlink between validation and the read was followed. The opened
  handle is now re-checked against the validated path (realpath and `dev`/`ino`)
  before any byte is read, and the upload is refused otherwise.

## [0.7.0] - 2026-08-25

First public release. **Pre-1.0 on purpose, and the version number is the
warning:** the design corpus is complete and all seven tool packages are
implemented, registered and unit-tested against recorded responses, but what is
still outstanding for 1.0 is verification, not implementation. The live
exit-gate smoke runs against a real test Page have not been executed, so no tool
in this release has been confirmed against the real Graph API. Treat every
capability below as "implemented and tested in isolation", not as "proven in
production" — and expect the 1.0 line to be the one that carries live
verification, not new surface area.

### Added

- **Layered architecture.** A lint-enforced four-layer boundary
  `core → api → mcp → tools`: `core` (config/settings, auth and `/debug_token`
  classification, the Graph HTTP client with the retry/error matrix, the
  per-host semaphore, value-based secret redaction and the append-only write
  journal), `api` (shared cursor pagination), `mcp` (tool authoring and the
  server wiring), and `tools` (the tool packages themselves).
- **`core` tool package (always on, read-only).** Four tools:
  `facebook_whoami` (classify the configured token — type, validity, granted
  permissions, expiry — plus server and pinned Graph API version),
  `facebook_list_pages` (the Pages the operator administers via `/me/accounts`,
  with Page-token presence but never the token value), `facebook_get_page`
  (metadata for one resolved Page) and `facebook_usage` (the most recent Graph
  rate-limit headers as usage percentages).
- **`reader` tool package (read-only).** Four tools: `facebook_list_posts`,
  `facebook_get_post`, `facebook_list_reels` and `facebook_get_reactions` — Page
  feed and Reels listing with cursor pagination, and reaction breakdowns.
- **`posts` tool package (writes).** Eight tools: text, photo, video and Reel
  publishing (`facebook_create_post`, `facebook_create_photo_post`,
  `facebook_create_video_post`, `facebook_create_reel`), scheduling and the
  scheduled-post list (`facebook_list_scheduled_posts`), edit and delete
  (`facebook_update_post`, `facebook_delete_post`), and upload-state polling for
  large media (`facebook_get_video_status`). Video and Reel uploads are
  resumable and report progress to clients that request it.
- **`insights` tool package (read-only).** `facebook_page_insights` and
  `facebook_post_insights`, with metric names validated before the call so an
  unknown metric fails locally instead of returning a silently empty series.
- **`moderation` tool package (writes).** Eight tools: comment listing and
  reading, reply, hide, delete, the one-shot `facebook_private_reply` (7-day
  window and single-attempt rule checked client-side before anything is sent),
  and the reversible `facebook_block_user` / `facebook_unblock_user` pair.
- **`messages` tool package (writes).** `facebook_list_conversations`,
  `facebook_get_conversation` and `facebook_send_message`, with the 24-hour
  standard messaging window evaluated on every call — including on an `apply`
  that follows a stale preview — and an ambiguous send recorded as `attempted`
  rather than `failed`, so a lost response never invites a double-send.
- **`ads` tool package (opt-in, not part of 1.0).** Campaign / ad-set / ad
  listing and reading, guarded status and budget updates, and asynchronous
  insight reports (`facebook_ads_insights`, `facebook_ads_report_status`). Off
  unless explicitly enabled; it ships as a supported capability in 1.1.0.
- **Tools-as-data authoring.** `defineTool` (schema-validated, annotation-typed
  tool specs) and a central package registry that expands the default profile,
  forces `core` on and applies the deny / read-only package policy.
- **Structure-aware result shaper.** A single result/envelope shaper enforces the
  `FB_MAX_RESULT_CHARS` truncation budget, strips paging cursors and tokens, and
  runs every payload through the redactor before it leaves the process.
- **Tiered plan-and-apply write gating + journal.** A `plan | apply` write mode
  with per-tool blast-radius tiers (`safe` / `reversible` / `irreversible` /
  `spend`); `irreversible` and `spend` are never bypassed by the env flag. Each
  applied mutation is recorded in a redaction-aware, rotation-aware,
  owner-only (0600) append-only journal.
- **Tainted-UGC confirmation.** User-generated content (comments, messages,
  visitor posts) is wrapped in a delimited, injection-warned taint envelope
  before it reaches the model, and an out-of-band confirmation seam
  (MCP elicitation, with an operator-token fallback via `FB_CONFIRM_TOKEN`)
  gates destructive and spend actions.
- **Transports.** stdio (default) and a loopback-only Streamable HTTP transport
  that fails closed without `FB_HTTP_TOKEN` and validates the request `Origin`.
- **`doctor` diagnostic.** A startup self-check that aggregates every `FB_*`
  configuration problem into one report and probes whether the configured token
  actually works, so misconfiguration surfaces in one pass.
- **`setup-token` subcommand.** An interactive first-run helper that exchanges a
  short-lived user token for a long-lived Page token and writes it to the env
  file with owner-only permissions. It never prints, logs or echoes a token
  value, and it warns when a token is passed on the command line, where `ps` and
  the shell history can see it.
- **Progress notifications.** Long uploads emit MCP `notifications/progress`
  frames when — and only when — the client supplied a progress token. Delivery is
  best-effort and detached, so a closed stream can never fail an upload that
  otherwise succeeded.
- **Distribution manifests.** An MCP Registry `server.json`, a Claude Code plugin
  bundle (`.claude-plugin/`), an MCPB desktop bundle built by
  `scripts/pack-mcpb.mjs`, a `FUNDING.yml` sponsor button and this changelog. All
  of them, plus the README env table and `.env.example`, are generated from a
  single metadata source (`scripts/metadata.config.mjs`) and checked for drift in
  CI, so the shipped manifests cannot disagree with the code.
- **CI-only publishing.** A tag-triggered release workflow publishes to npm with
  provenance from GitHub Actions; the package declares no install lifecycle
  scripts, and a guard fails the build if one is ever added. Local publishing and
  `npm version` are both refused by design — see
  [`docs/runbooks/release.md`](docs/runbooks/release.md).
- **Operator runbooks.** Seven procedural guides under `docs/runbooks/` —
  onboarding, credential rotation, kill switch, the ~4-week Meta app upkeep pass,
  offboarding, the release cut, and the operator window for the three tools no
  automated test can cover.
- **Documentation site.** A zero-build GitHub Pages site at
  [ivanbbaev.github.io/facebook-mcp](https://ivanbbaev.github.io/facebook-mcp/),
  including funding links and a per-package shipping status so the public page
  never claims a capability that is not implemented yet.

### Changed

- **Honest capability reporting.** The README, the Pages site and the FAQ
  distinguish what is implemented from what is designed and scheduled, with every
  planned area linked to its release milestone, and they now state plainly that
  nothing has been verified against the real Graph API yet. A README `Roadmap`
  section points at the public roadmap board.

### Fixed

- **Windows CI line endings.** A `.gitattributes` now normalises the tree to LF,
  so a Windows checkout no longer rewrites every file to CRLF and fails
  `prettier --check` on the Windows CI leg while Linux and macOS pass.

### Security

- **Fixed Graph-API host allowlist.** Only `graph.facebook.com`,
  `graph-video.facebook.com` and `rupload.facebook.com` are ever contacted; there
  are no user-configurable hosts and no telemetry.
- **Secret hygiene.** Tokens and the app secret are redacted at a single
  choke-point across logs, errors, tool results and the journal; the
  `appsecret_proof` signature (when `FB_APP_SECRET` is set) makes a stolen bare
  token unusable.
- **Release-toolchain integrity.** The `mcp-publisher` binary used to list the
  server on the MCP Registry is verified against a SHA-256 committed to this
  repository rather than against a checksum file fetched from the same place as
  the binary; the upstream checksums file is kept only as a warning-level
  cross-check. A mismatch fails the release.
- **Attested desktop bundle.** The `.mcpb` bundle now carries a GitHub
  build-provenance attestation, re-verified with `gh attestation verify` before
  the asset is attached to the Release — so the file on the Release page can be
  proven to have come out of this repository's workflow, which a checksum
  published beside it cannot do.

[Unreleased]: https://github.com/IvanBBaev/facebook-mcp/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/IvanBBaev/facebook-mcp/releases/tag/v0.7.0
