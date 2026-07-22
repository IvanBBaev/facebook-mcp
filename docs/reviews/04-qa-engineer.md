# Review — Senior QA Engineer

Reviewed: `docs/analysis/` (README, 01–08), `docs/ai/research/` (all five files), and the
reference test suite at `servicenow-mcp/test/` (helpers.js, http-retry, attachment,
write-mode, mcp-smoke, all-tools-smoke, manifest-snapshot, readme-sync, env-docs-sync,
redact, property tests). Review date: 2026-07-21.

## Verdict

**Go with changes.** For a pre-code corpus this is unusually testable: the seams are
named (a single `fbRequest` entry, `withEnv`/`withFetch` at the `globalThis.fetch`
level, tools-as-data feeding a manifest snapshot), the reference suite being ported is
real and proven in-house rather than aspirational, and the phase ordering sensibly puts
read-only surface before writes. However, the corpus is **not implementable as written
from a QA standpoint** in one area and underspecified in several others. The live smoke
gates in 08-roadmap can publish to a real audience and create real ad objects with no
cleanup contract, no dedicated test target, and no spend belt-and-braces — that is a
Blocker as designed, and it is cheap to fix now. Beyond that, the upload flows
(multipart, `rupload` binary, resumable chunking) exceed what the ported `withFetch`
seam has ever been shown to cover; the fixture strategy is a single sentence for an API
the corpus itself admits is inconsistently documented; and the retry matrix is silent on
exactly the case that matters most for this server — an ambiguous-outcome network error
on a non-idempotent publish. All of these are specification gaps, not architecture
flaws; none require redesign.

## Strengths worth keeping

- **The ported test strategy is real, not aspirational.** Every named pattern
  (`withEnv`/`withFetch`/`jsonResponse`, manifest snapshot, readme/env-docs sync,
  plan-mode "must not POST" tests, POST-vs-GET retry discipline) exists as working code
  in `servicenow-mcp/test/` and adapts directly. This dramatically de-risks Phase 0.
- **Plan-and-apply as the default write mode** (05-architecture §7) is the single most
  valuable QA safety property for a server whose worst failure is publishing to a real
  audience. The reference `write-mode.test.js` pattern ("throw if any mutating verb is
  seen in plan mode") ports cleanly.
- **Manifest snapshot as source of truth** (06-tool-catalog: "Counts are targets, not
  contracts — the manifest snapshot test becomes the source of truth") — the whole
  ~35-tool surface becomes diff-reviewed on every change.
- **Only 3 runtime deps and one HTTP entry point** — the entire external world is
  reachable through `fetch`, which is why a fetch-level mock is even plausible as the
  sole seam. The fixed three-host allowlist is simpler to test than servicenow's
  configurable host policy.
- **Phase 1 gate is read-only live smoke** — the riskiest integration (auth) is
  verified against the real API before any write path exists.
- **Honesty about doc ambiguity** — 03's "do not hardcode a strict metric whitelist;
  pass metrics through and surface API errors" and 07's "re-verify at build time" list
  are exactly the right instinct: they shrink the brittle test surface and feed a
  contract-test plan.
- **`node:test` + `c8`, no test-runner dependency** — matches the minimal-deps stance
  and the reference suite; `fast-check` already budgeted for property tests.

## Findings

### 1. **Blocker** — Live smoke gates can reach a real audience and lack any cleanup contract

**Problem** (08-roadmap Phases 2, 3, 5; 07 P3): The Phase 2 gate reads "publish a draft
(`published:false`), a scheduled post, a photo post; verify Reels flow with a test
clip; edit + delete **the drafts**." As written: (a) the photo post carries no
`published:false` qualifier — it goes to the real audience; (b) the scheduled post's
failure mode is *delayed* real publication: if cleanup fails or is forgotten, the post
publishes to the live Page minutes-to-days later; (c) only "the drafts" are deleted —
the scheduled post and photo post have no stated cleanup. Phase 3's "live smoke on a
test post's comments" implies a visible post on the production Page. Phase 5 creates a
real (PAUSED) ad chain: even paused ads enter Meta's ad review, so a sloppy test
creative accrues real account-quality risk; a bug that sends `status: ACTIVE` (or a
misread of `effective_status`) spends real money; there is no `spend_cap`, no
account-level spending-limit precondition, and no failure-path deletion guarantee.
Repeat runs with identical draft text can also trip Graph error 506 (duplicate status).
No marker/naming convention, no try/finally contract, no orphan sweeper, no dedicated
test Page anywhere in the corpus.

**Recommendation**: Make the smoke protocol a checked-in deliverable (scripts +
runbook, see finding 10), with these rules baked in:

- **Dedicated test Page** for all write smoke: a second Page under the same Business
  portfolio, assigned to the same system user — zero audience, same token, near-zero
  cost. The production Page is used for *read-only* smoke exclusively. Exception:
  insights smoke stays on the production Page (a fresh test Page cannot meet the
  ≥100-likes insights threshold, per 03) — which is fine, insights are reads.
- **Unpublished/DRAFT-only writes by default**: `published:false` posts, Reels
  `video_state: DRAFT`. The scheduled-post test uses a far-future time (e.g. 28 days,
  inside the conservative window) so a failed cleanup leaves a wide deletion window,
  and the same run verifies the deletion took effect via `/scheduled_posts`.
- **Marker + nonce**: every smoke object carries `[FBMCP-SMOKE <timestamp-nonce>]` in
  its message/name (also defeats error 506). A sweeper scans `/scheduled_posts`,
  `/feed?is_published=false`, `/video_reels` drafts, and the ad account by name prefix
  and deletes leftovers at the *start and end* of every run.
- **Ads belt-and-braces**: precondition documented — account spending limit set in
  Business Manager; the script asserts `status=PAUSED` **and** re-reads
  `effective_status` after each create; sets a minimal campaign `spend_cap`; reuses one
  innocuous evergreen creative (link to own domain); deletes the chain in a `finally`
  block; the sweeper covers the crash case.
- **Quota awareness**: a Reels smoke run consumes the shared 30-per-24h budget — the
  runbook must say so.

### 2. **Major** — Upload flows exceed what the `withFetch` seam has been shown to cover

**Problem** (05-architecture §9, §11; research servicenow-mcp-architecture §4;
`test/helpers.js`): The reference mock records `{url, init}` and was only ever
exercised with JSON and small `Buffer` bodies (`attachment.test.js`). facebook-mcp adds
three body shapes the seam has never handled: multipart `FormData` (photo `source` —
asserting the actual bytes/params requires boundary parsing), raw binary posts to
`rupload.facebook.com` with `file_offset`-style headers, and the resumable-upload
state machine (start → N chunk posts → finish) which is a scripted multi-request
sequence with resume-after-interruption semantics. If the implementation streams file
bodies (`fs.createReadStream`), Node fetch requires `duplex: "half"` and the recorded
`init.body` is a consumed-once stream — the recording mock keeps a dead reference and
can assert nothing. It is also unspecified whether graph-video/rupload calls route
through `fbRequest`, whose retry matrix ("5xx retried on GET only") must **not**
blind-retry a chunk POST — resumption via offset query is the retry mechanism there.

**Recommendation**: (a) Specify **buffered chunking** — read each chunk into memory
with a bounded chunk size — which is byte-for-byte assertable exactly like the
reference attachment tests; avoid stream bodies in v1. (b) Extend `helpers.js` with a
body-capture helper that normalizes `FormData`/`Buffer` bodies into assertable form.
(c) Enumerate mandatory fault-injection tests in 05 §11: transport error at chunk N →
offset query → resume from N (not from 0, not duplicating N); failure in the `finish`
phase; throttle in the `start` phase; and an explicit assertion that the generic retry
layer is bypassed for chunk POSTs.

### 3. **Major** — Fixture sourcing, sanitization, and drift detection are unspecified

**Problem** (05 §11 "fixtures with real Graph API response shapes"; 07 P3 "recording
fetch mocks from real traffic"; 03 admits Meta's docs are internally inconsistent):
"Real shapes" from *where*? Hand-transcribing from docs reproduces the docs' own
inconsistencies (the corpus documents three insights deprecation waves and NPE fields
that return null against documentation — R6). "Recording from real traffic" is named
but has no mechanism: no capture script, no sanitization step, no storage convention,
no way to detect when Meta drifts a shape under a pinned version (out-of-cycle changes
apply to all versions immediately, per the marketing research A1).

**Recommendation**: (a) A `scripts/record-fixture.mjs` that replays a named request
against the live API with the operator token and writes a sanitized fixture (IDs,
names, PSIDs, tokens, `fbtrace_id` normalized) with a metadata header `{endpoint,
api_version, recorded_at}`. (b) A shape-level diff mode (keys + types, not values)
re-run as part of the R1 "changelog check ritual" at every `FB_API_VERSION` bump —
this is the contract test the corpus needs, and it costs one script. (c) A
**fixture-lint test** in the suite: no `EAA`-shaped strings, no real-looking tokens,
anywhere under `test/fixtures/`.

### 4. **Major** — Retry matrix is silent on ambiguous-outcome writes (the double-publish case)

**Problem** (05 §2; 03 rate limits): The stated matrix — "429/throttle codes retried
with backoff; 5xx retried on GET only" — has two gaps. First, Graph throttle errors
(4, 17, 32, 613, 80001…) typically arrive as **HTTP 400 with the code in the body**,
not HTTP 429 — the retry decision must be body-envelope-driven, which the corpus
implies but never states. Second, and critical: nothing addresses a **transport
error/timeout on a POST publish**. Graph has no idempotency keys on `/feed`; a retried
timed-out publish can post twice to a real audience. A body-coded throttle on POST is
safe to retry (the API provably rejected pre-processing — same reasoning as the
reference suite's 429 handling), but an ambiguous outcome is not. The reference
`http-retry.test.js` pins exactly this ("a POST transport error is NOT retried —
outcome unknown"); the corpus doesn't carry the rule over.

**Recommendation**: State the policy in 05 §2: *ambiguous outcome ⇒ never retry a
write ⇒ the error instructs the user to check the Page/scheduled queue before
retrying*. Require a table-driven retry-decision test over (method × outcome class:
transport error / HTTP status / body code / subcode), porting the reference suite's
POST-vs-GET discipline. Add error 506 (duplicate status) to the error mapping while
at it — it is the symptom users will see when a double-submit does happen.

### 5. **Major** — Token invalidation mid-session is missing from the error mapping and test plan

**Problem** (04 token strategy; 07 R4): R4 covers `debug_token` **at startup** and
doctor diagnostics. Nothing specifies behavior when the token dies mid-session: Graph
error 190 with subcodes 460 (password changed — the documented death mode of the
long-lived Page-token fallback), 463 (expired), 467 (invalidated). These must be
non-retryable and mapped to an actionable message ("token invalidated — re-issue via
Business Manager / run doctor"), and the failure must not poison in-flight parallel
requests in confusing ways.

**Recommendation**: Add 190 + subcodes to the `GraphApiError` mapping table in 05 §2
as non-retryable, with per-subcode table-driven tests; add a test for `debug_token`
unreachable/failing at startup (server should start degraded with a clear doctor
message, not crash-loop — whichever is chosen, pin it in a test).

### 6. **Major** — No time/clock seam, yet the design is full of time-dependent logic

**Problem** (05 §2 backoff with 60 s cap and `estimated_time_to_regain_access`; 06
Reels 30-per-24h rolling budget, private-reply 7-day window, messaging 24h window; 03
scheduling window 10 min–29/30 days): none of this is testable without clock
injection — real sleeps make the suite slow and flaky, and rolling-window logic cannot
be exercised at all. The reference suite dodges this with "Retry-After date in the
past ⇒ zero wait" tricks, which do not scale to a 24-hour rolling counter.

**Recommendation**: Specify an injectable `now()`/`sleep()` (in `core/settings.ts`
style) or standardize on `node:test` mock timers, in 05 §11 — decided before Phase 0,
because `fbRequest`'s backoff is a Phase 0 deliverable. Add a rule: unit tests never
wall-clock-sleep beyond milliseconds.

### 7. **Major** — Redaction is differentiator #1 but gets a one-line test plan

**Problem** (01 success criterion 3 "tokens never leak: not in logs, not in error
messages, not in tool output"; 02 positioning; 04 redaction row): This is a headline
claim, and the market research shows token leakage is the #1 complaint cluster in
competing servers. The test strategy (05 §11) does not mention redaction at all. The
reference `redact.test.js` covers field/PII masking but not token-shaped-string
survival across every output channel.

**Recommendation**: Specify an adversarial redaction suite as a Phase 0 deliverable:
token embedded in a URL query string inside an error message; token echoed back inside
a Graph error body; token nested in `structuredContent`; `appsecret_proof` and
`FB_HTTP_TOKEN` masking; write-journal contents. Add a **spawn-level stdout-purity
test** (start `build/index.js` over stdio, assert stdout carries only JSON-RPC frames
— guards the stderr-only-logging invariant end to end) and a manifest-driven
`logFields` audit (no tool's `logFields` may emit a token-bearing argument). The
fixture-lint from finding 3 completes the set.

### 8. **Major** — The catalog promises client-side media validation the stack cannot deliver

**Problem** (06 `facebook_create_reel`: "validates 3–90 s / 9:16 / 30-per-24h
budget"; 05 stack: exactly 3 runtime deps, none of which can probe video duration or
aspect ratio): duration/aspect validation requires parsing container metadata —
unimplementable without a new dependency, hence untestable as specified, hence a tool
description that will lie to the model. The 30-per-24h budget *is* implementable (a
counter) but its state location is unspecified (see open question 5).

**Recommendation**: Decide now: drop client-side duration/aspect validation and
instead surface Meta's own validation error, mapped readably (recommended — consistent
with the corpus's "pass through and surface API errors" philosophy for metrics), or
explicitly add a probe dependency. Update the catalog line either way.

### 9. **Major** — Pagination edge-case semantics are unspecified

**Problem** (05 §3; 03 reading): The design states the happy path (cursor-based,
absence of `paging.next` = end, `fetchAll` cap + `truncated`). Unstated: an empty
`data` page **with** `paging.next` present (Graph does this — terminating on empty
data is a real-world bug class); a missing `paging` object entirely; **cursor expiry
mid-`fetchAll`** ("can quickly become invalid" per the research) — is partial data
returned with `truncated: true` and a warning, or is the whole call failed and the
pages already fetched discarded?; `limit > 100` handling.

**Recommendation**: Define the partial-result policy (recommend: return partial data +
`truncated: true` + an error note — never silently drop, never present partial as
complete, consistent with the corpus's own `truncated`-flag philosophy). Enumerate the
above cases as required tests in 05 §11, and add a `fast-check` property: for
arbitrary paging graphs, `fetchAll` terminates and never exceeds the cap.

### 10. **Minor** — The CI/live boundary is an assumption, not an enforced invariant

**Problem** (07 P3 says the smoke script is "run manually against the live Page"; 08
Phase 0 defines the CI workflow): nowhere does the corpus state the invariant "CI never
performs network I/O", and nothing enforces it — one carelessly written test hits the
real Graph API from CI with real credentials absent (fails flaky) or present (worse).
The smoke protocol also is not named as a checked-in artifact, making the gates
unrepeatable folklore.

**Recommendation**: (a) The test helpers install a **default network fence**: any
`fetch` not going through `withFetch` fails the test. (b) Smoke scripts live in the
repo (`scripts/smoke/*.mjs`), refuse to run without `FB_SMOKE=1` + explicit page/act
IDs, and are excluded from `npm test`. (c) The runbook (finding 1) is a Phase 2
deliverable. (d) Port the reference CI OS spread (ubuntu + macOS + **Windows** + the
ancient-Node launcher probe) — Windows matters specifically because `FB_MEDIA_DIR`
path-containment logic is exactly the kind of code that passes on POSIX and breaks (or
worse, escapes) on Windows paths.

### 11. **Minor** — Phase 0 coverage floors are unspecified; 94/82/97 is not a day-one number

**Problem** (05 §11, 01 success criterion 5, research §4): 94/82/97 is a *ratchet set
just below the actuals of a mature ~55-file suite*. The corpus correctly says "ratchet
set just below actuals once the suite exists", but Phase 0's gate ("coverage ratchet")
names no starting numbers — inviting either a blocked gate or threshold gaming while
the suite is small.

**Recommendation**: Set explicit Phase 0 floors (suggest 70 lines / 60 branches / 75
functions — honest for a skeleton with an HTTP client and registry), then ratchet to
just-below-actuals at every phase gate, recording each move. Never ratchet down without
a written reason. Port the `coverage-guard.mjs` Node ≥25 workaround note.

### 12. **Minor** — Keep test-against-`build/`, but mitigate its failure modes

**Problem** (05 stack; research §4 caution "consider testing source directly"): the
challenge is warranted but the answer is to keep build-first. It tests the artifact
that actually ships (Node16 ESM resolution, `.js` extension imports, the publish
allowlist) — for an npm-distributed server that is the right risk to burn down, and it
keeps zero test-time transpile deps. The real costs are (a) **stale-build false
greens** locally (edit src, forget to build, tests pass against old code) and (b)
coverage attribution to compiled JS.

**Recommendation**: Keep build-first. Add a pretest freshness guard (fail if any
`src/**` mtime is newer than `build/**`), keep `sourceMap: true` so c8 attributes to
`src/`, and document the watch loop (`tsc --watch` + `node --test --watch`) for
iteration.

### 13. **Minor** — 05 §11 names 4 test categories; the reference suite's highest-value ones are missing

**Problem**: The strategy lists `withEnv`/`withFetch`, fixtures, manifest snapshot,
readme/env-docs sync. Missing from the spec but present and high-value in the
reference suite: the **InMemoryTransport protocol smoke** (`mcp-smoke.test.js` —
exercises real zod `.strict()` rejection, package-profile contracts, and the ok/fail
envelope at the MCP layer, none of which unit tests touch), the **all-tools
synthesized-args smoke** (`all-tools-smoke.test.js` — every handler runs to a
well-formed ToolResult; the cheapest coverage-per-line in the suite), the **generic
write-mode sweep** (manifest-driven: for every tool without `readOnlyHint`, plan mode
must emit no mutating verb — stronger than per-tool tests), and named property-test
targets.

**Recommendation**: Add all four to 05 §11 explicitly. Property targets worth the
dependency: result-truncation halving loop (output never exceeds the char budget and
remains valid JSON), chunk partition (concatenated chunks byte-equal the source file),
redaction survival (no token-shaped substring survives arbitrary embedding), `fetchAll`
termination (finding 9), scheduling-window boundary validation.

### 14. **Minor** — Plan-and-apply divergence semantics are unspecified

**Problem** (05 §7): A preview cannot catch server-side validation (invalid metric,
scheduling bounds, ad policy) — plan says "will do X", apply fails; and for
update/delete, the before-state fetched at plan time can change before apply (the
comment gets deleted, the post gets edited). Neither the acceptable divergence nor the
user-facing expectation is stated, so it cannot be tested.

**Recommendation**: State it: previews are best-effort and say so in their output;
apply re-fetches before-state for destructive ops (or documents staleness). Pin with
the generic sweep (finding 13) plus one explicit preview-then-apply divergence
scenario test.

### 15. **Minor** — Some tools will ship with no live verification path; the corpus should say so

**Problem** (06 `messages`/`moderation`; 08 Phase 3 gate covers "conversation list +
read" only): `facebook_send_message` needs an open 24-hour window from a real user;
`facebook_private_reply` consumes its single shot on a real user's comment;
`facebook_block_user` needs a victim PSID. None of these can be live-smoked on demand
without a second identity, and the roadmap gates silently skip them — meaning they
ship verified only against fixtures, which contradicts success criterion 1 ("every
advertised tool works against a real Page").

**Recommendation**: Mark live-unverifiable tools explicitly in the catalog; compensate
with recorded-fixture contract tests (finding 3); script the operator-initiated-window
procedure in the runbook (operator messages own Page from their personal account to
open a 24h window, comments on a test-Page post for private-reply/moderation smoke) so
the manual step is repeatable rather than improvised.

### 16. **Nit** — Usage-header parsing robustness

`X-App-Usage`/`X-Business-Use-Case-Usage` are JSON-in-header values keyed by
business ID (05 §2). Add tests for absent, malformed, and partially populated headers,
and for `facebook_usage` before any traffic has been seen.

### 17. **Nit** — Port the reference suite's self-guarding ergonomics

Actionable assertion messages ("run `npm run gen:manifest` and commit the diff"), the
package.json description counts-sync test, and — most importantly — the
inventory-sanity floor from `env-docs-sync.test.js` (the source scan asserts a minimum
count + sentinels so a refactor cannot silently pass an empty inventory). These small
habits are what keep meta-tests honest; name them so they survive the port.

## Open questions for the author

1. Will a **dedicated test Page** be created under the Business portfolio for write
   smoke (accepting that insights smoke stays on the production Page because of the
   ≥100-likes threshold)? If not, what is the substitute safety story for Phase 2/3?
2. Are chunked uploads **buffered or streamed** in v1? If streamed, how does the
   recording fetch mock capture and assert bodies (consumed-once streams, `duplex`)?
3. Is any **second identity** available (household member, app-role tester) for
   comment/private-reply/messaging live verification, or do we accept those tools
   shipping live-unverified with fixture-only coverage (finding 15)?
4. Clock seam decision: injected `now()`/`sleep()` in `core/settings.ts` vs
   `node:test` mock timers — which, and decided before Phase 0?
5. Where does the **Reels 30-per-24h counter** persist (in-memory vs the write
   journal)? In-memory resets on every restart and cannot enforce the quota across
   sessions — which also determines how it is tested.
6. Phase 0 coverage floors — is 70/60/75 with a per-phase-gate ratchet acceptable as
   the written policy?
7. Fixture drift: is the shape-diff re-record run only at `FB_API_VERSION` bumps (the
   R1 ritual), or also on a periodic manual cadence given Meta's out-of-cycle changes?
8. Are the smoke scripts + runbook **checked-in phase deliverables** (with an
   `FB_SMOKE=1` guard), i.e., part of each gate's definition of done, rather than
   ad-hoc commands?
