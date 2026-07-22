# Review — Senior Software Architect

Reviewed: `docs/analysis/README.md` + 01–08, against `docs/ai/research/*` and the
real source of the reference implementation at `~/Development/servicenow-mcp`
(`src/core/http.ts`, `src/core/request-context.ts`, `src/mcp/registry.ts`,
`src/mcp/write-mode.ts`, `src/mcp/define.ts` inspected directly). Review date
2026-07-21, pre-code.

## Verdict

This is an unusually disciplined pre-code corpus: the market analysis is honest
(ads = commodity, Pages = the product), the reference architecture is real and
verified in production, and the explicit "what we do NOT port" section shows the
author is porting a shape, not cargo-culting a codebase. **Go with changes.**
The 4-layer port, tools-as-data registry, and plan-and-apply gating all fit the
Graph API domain. The problems cluster exactly where Graph API diverges from
ServiceNow's request model and the corpus glosses the divergence: (1) token
topology — the corpus contradicts itself on whether a System User token can
drive Page endpoints directly, and no page-token resolution flow is designed;
(2) the multi-instance→multi-page mapping ports a connection-profile idiom
(AsyncLocalStorage ambient context) for what in Graph is a plain path parameter;
(3) the single `fbRequest` entry does not cover the three distinct wire
protocols the media plan requires; (4) long-running uploads have no answer to
MCP tool-call timeouts; (5) Graph responses embed the access token in
`paging.next` URLs — a leak vector the security section doesn't name. None of
these force a redesign of the layering; all of them are cheap to fix on paper
now and expensive to discover in Phase 2. Fold the Major findings into 04/05/06
before Phase 0 and this plan is implementable as written.

## Strengths worth keeping

- **Tools-as-data + PACKAGES manifest + snapshot test** (05 §5–6). Verified in
  the reference (`src/mcp/registry.ts`): one manifest feeds registration,
  gating, README generation, and the snapshot test. At 7 packages / ~35 tools
  this is comfortably inside the envelope the pattern already handles (18/67).
- **Correct de-porting decisions** (05 §"What we do NOT port"): dropping the
  auth-provider matrix (`basic|oauth|apikey|token` + grant types), dropping
  user-configurable hosts, dropping the `{result}` envelope unwrap, and not
  carrying the dark Jira scaffold. Each is the right call for a one-vendor API.
- **Plan-and-apply as the default for public publishing** (05 §7, 06). Publishing
  to a live audience is the highest-consequence action here; safe-by-default
  plus `destructiveHint` annotations is exactly the right posture, and the
  reference's `shouldApply`/`planPreview` mechanism is small (54 LOC) and proven.
- **Fixed three-host SSRF allowlist + no local URL fetching** (04): media-by-URL
  is fetched by Meta, not the server; local files constrained to `FB_MEDIA_DIR`.
  This eliminates the SSRF class that bit pipeboard (GHSA-45gf-fjxp-cjpq).
- **Insights pass-through stance** (03 §Insights, 06): after three metric
  deprecation waves, refusing to hardcode a metric whitelist and surfacing
  Meta's own "invalid metric" errors is the correct durability posture.
- **Package boundaries align with Meta's permission model**: `posts` ↔
  CREATE_CONTENT, `moderation` ↔ MODERATE, `insights` ↔ ANALYZE, `messages` ↔
  MESSAGING. The doctor/`facebook_whoami` matrix (04) turns that alignment into
  operability — "this tool won't work because scope X / task Y is missing" is a
  differentiator no competitor has.
- **Phasing by risk** (08): auth + publishing first, commodity ads last, custom
  audiences deferred behind the TOS gate. The `oliverames` 200-tool cautionary
  tale is correctly internalized as a ~35-tool cap.
- **Spec-transition awareness** (02, 07 P2): no Roots/Sampling/Logging
  dependencies, v1 SDK + codemod path, stateless-friendly intent. Right side of
  the 2026-07-28 line (with one ported-default exception — see finding 14).
- **`FB_` prefix uniformly from day one**, fixing the reference's acknowledged
  `SN_` historical inconsistency, and stderr-only JSON logging.
- **An honest risk register** (07) with a concrete "re-verify at build time"
  list — rare and valuable.

## Findings

### 1. **Major** — Page-token topology is unresolved; 03 and 04 contradict each other

03 states (backed by `pages-api.md`): "Page posts require a **Page token**
(user must hold the CREATE_CONTENT Page task)". 04 designs the primary
credential as a **System User token** treated as "an opaque `FB_ACCESS_TOKEN`"
with "no pluggable provider matrix needed (one auth mode)" (05 §2). These
cannot both be true as written: if Page endpoints (`/feed`, `/comments`,
`/messages`, `/video_reels`) genuinely require a Page-scoped token, then the
opaque-token design fails success criterion #1 ("every advertised tool works
with a System User token") the first time Phase 2 runs, and a token-derivation
flow must be retrofitted into `core/`. The corpus never specifies the
well-known resolution: derive a Page token from the system-user/user token
(`GET /{page-id}?fields=access_token` or `/me/accounts`), cache it per page,
invalidate on OAuth error 190, retry once. That is a real piece of `core/auth`
architecture — the Graph-API analog of the reference's OAuth token cache with
single forced re-auth on 401 (`src/core/http.ts` lines 178–188) — and it is
absent from 04/05.

**Recommendation:** Add a "token resolution" subsection to 04: (a) Phase 0
doctor empirically verifies whether the operator's system-user token works
directly against a Page write endpoint; (b) regardless of the answer, design a
per-page token resolver in `core/auth` (derive → cache → invalidate-on-190 →
re-derive once), because it also makes the multi-page story and the long-lived
Page-token fallback uniform. Without it, "one auth mode" is an assumption, not
a design.

### 2. **Major** — The multi-instance → multi-page port uses the wrong idiom: a Page is a path parameter, not a connection profile

05 §4 ports the reference's MI-3 machinery (`FB_PROFILE_<NAME>_PAGE_ID`,
auto-injected `page` argument, `AsyncLocalStorage` context) as the "analog of
servicenow-mcp multi-instance profiles". The analogy is false. In ServiceNow,
the instance determines *host + credentials + auth mode* — ambient state that
would otherwise thread through every `config → auth → http → policy` signature,
which is why ALS exists (`src/core/request-context.ts` documents exactly this
rationale). In Graph API, the page ID is a **first-class URL path parameter**
(`/{page-id}/feed`, `/{page-id}/conversations`): every `api/` function must
take it explicitly anyway. There is no invisible layer that needs ambient
context — except per-page tokens, which finding 1's resolver handles keyed by
page ID inside `core/auth`. Porting ALS here buys nothing and costs hidden
coupling, an env-var naming matrix, and per-request context plumbing in a
single-operator server whose primary user has one Page.

**Recommendation:** Keep the optional `page` tool argument (good,
forward-compatible surface), but back it with a trivial registry:
`resolvePage(name?) → { pageId, tokenOverride? }` from `FB_PAGE_ID` +
`FB_PAGES` (or the profile env scheme, if kept purely as naming). Pass
`pageId` explicitly down the `api/` signatures; delete `AsyncLocalStorage`
from the port list. Same external behavior, materially simpler core.

### 3. **Major** — Graph responses embed the access token in URLs (`paging.next`, nested field-expansion paging); the security model doesn't name this leak vector

The corpus's #1 stated differentiator is "token security done right" (02), and
04 designs stderr-only logging, query-string stripping in errors, and a
defensive `EAA…` redaction pass. But it never names the most Graph-specific
leak: **`paging.next`/`paging.previous` URLs returned by Meta contain
`access_token=...` verbatim**, and they appear not only on list endpoints
(internalized by the pagination helper, 05 §3) but *nested inside single-object
reads* via field expansion (e.g. `comments.summary(true)`, `reactions.…` on
`facebook_get_post`). A tool that passes a Graph node through result shaping
un-scrubbed hands the live credential to the model context and to the MCP
client's logs. The generic `EAA…` regex is a net, not a policy — and 04 itself
calls it "defensive", i.e. not the primary control.

**Recommendation:** Promote to an explicit invariant in 04 + 05 §8: *no
`paging` object (top-level or nested) and no Meta-returned URL containing
`access_token` ever appears in tool output*; the result shaper deletes/rewrites
`paging` keys recursively; a test asserts a fixture with nested paging comes
out clean. Additionally, send the token via the `Authorization: Bearer` header
instead of a query parameter for graph.facebook.com calls (Graph supports it;
rupload requires header auth anyway) — this keeps tokens out of request URLs,
error strings, and any intermediary logging entirely, and simplifies the
`safeUrl` discipline the reference needed.

### 4. **Major** — One `fbRequest<T>()` entry cannot cover the three wire protocols the media plan requires; "one auth mode" breaks across the three hosts

05 §2 designs a single `fbRequest` ("append `access_token` +
`appsecret_proof`"), and 05 §9 puts the video/Reels state machine in
`api/media.ts`. But the corpus's own research (`pages-api.md` §2) shows three
distinct protocols: (a) JSON/query-param requests on `graph.facebook.com`;
(b) **multipart/form-data** uploads (photo `source`, video
`fbuploader_video_file_chunk` on `graph-video`); (c) **raw binary with
header-based auth** (`Authorization: OAuth <token>`, `offset`/`file_size`
headers) on `rupload.facebook.com` — where `appsecret_proof` as a query param
does not apply. The reference client supports `rawBody`+`contentType` but not
multipart streams, and its auth is header-injection per attempt. If `fbRequest`
isn't specified to handle all three, `api/media.ts` will inevitably bypass
`core/http` — silently losing the SSRF allowlist, retry matrix, usage-header
tracking, telemetry, and the layer rule "tools never import core/http" becomes
"media quietly reimplements core/http".

**Recommendation:** Specify in 05 §2 that `core/http` exposes the single
low-level transport for *all three hosts*: JSON mode, multipart/FormData mode
(Node 20 fetch supports FormData + streams), and raw-binary mode with
per-request header auth and a per-request timeout override (a 512 MB chunk
cannot share the default JSON timeout). All modes share host allowlist,
retry/backoff, usage parsing, and telemetry. `api/media.ts` owns only the
*state machine*, never the wire.

### 5. **Major** — Long-running uploads vs MCP tool-call timeouts: "progress in tool output" is not a keep-alive, and resumable-session state has no home

05 §9 says "resumable-session handling and progress in tool output". Output
arrives only when the handler returns — it does nothing for a client whose
tool-call timeout fires at 60–600 s while a multi-GB video crawls up a
residential uplink. The corpus neither adopts the MCP mechanism that exists for
exactly this (**progress notifications** via the client's `progressToken`,
supported in SDK v1, which many clients use to extend timeouts) nor defines
what "resumable" means across calls: if the upload dies mid-session, is the
session ID persisted so a second tool call resumes, or is it in-memory and
lost? In-memory session state also quietly contradicts the "stateless-friendly"
commitment (07 P2) for the HTTP transport mode.

**Recommendation:** In 05 §9 specify: (a) chunk loops emit MCP progress
notifications when the client supplies a progress token; (b) define the
no-token fallback (conservative chunk sizing so individual calls stay short, or
document the client-timeout requirement); (c) decide where resumable session
state lives (in-memory per process for v1 is acceptable — but then say
"resume within one server lifetime" honestly); (d) note MCP Tasks (2026-07-28
extensions, SEP-1686) as the designed future path for `facebook_create_video_post`
/ `facebook_create_reel`, so the tool contract (accept → poll) doesn't need
inventing twice.

### 6. **Major** — Retry matrix: double-post risk on publishing writes, and `estimated_time_to_regain_access` conflicts with the tool-call latency budget

Two holes in 05 §2's retry design as applied to publishing. First, Graph
publishing has **no idempotency keys**: a `POST /{page-id}/feed` that dies on a
transport error or 5xx *after the request was sent* has an unknown outcome, and
any retry can double-post to a live audience — the single most embarrassing
failure this server can produce. The reference handles this class correctly
("non-idempotent methods are retried only on connection errors, never on a
received response" — and even connection-error replay is a judgment call), but
the corpus only says "5xx retried on GET only", leaving throttle-code retries
(4/17/32/613/80001…) implicitly method-agnostic and saying nothing about
ambiguous outcomes. Second, "backoff honoring `estimated_time_to_regain_access`"
collides with reality: ETRA is reported in **minutes** (can be 30–60+); a
synchronous MCP tool call cannot sit in a backoff loop that long, and the 60 s
cap makes "honoring" it a misnomer.

**Recommendation:** Specify in 05 §2: (a) publishing POSTs are *never*
retried after the request has been written to the socket; on ambiguous outcome
the error message instructs verification via `facebook_list_posts`/
`/published_posts` (throttle-rejected requests, which Meta rejects before
processing, may be retried once within budget); (b) if ETRA (or computed
backoff) exceeds a small per-call budget (e.g. 30–60 s total), fail fast with
the retry-after surfaced in the error text — the *model* is the retry loop at
that timescale, not the HTTP client.

### 7. **Minor** — Plan-mode semantics are undefined for multi-step media flows

Plan-and-apply is specified per write tool (05 §7), but the flagship flows are
multi-step with intermediate *writes*: multi-photo = upload N photos
`published=false` + `/feed` attach; Reels = start/upload/finish. Does
`facebook_create_photo_post` without `apply:true` upload the unpublished photos
(a real mutation with server-side residue) and only skip the final attach, or
mutate nothing? The reference's `planPreview` never had this problem — table
writes are single calls.

**Recommendation:** One sentence in 05 §7: *plan mode performs zero network
mutations*; previews are computed from arguments plus local validation only
(file existence, size vs `video_upload_limits`, aspect ratio where cheaply
determinable); all uploads happen under `apply:true`.

### 8. **Minor** — Profile→package expansion is unspecified, and profile names shadow package names

06 defines packages `core, posts, reader, insights, moderation, messages, ads`
and 05 §6 profiles `core, all, reader, publisher, moderator, ads`. Three names
(`core`, `reader`, `ads`) are both a package and a profile, and in the
reference resolver profiles win (`resolveEnabledPackages` checks `PROFILES`
first) — so `FB_TOOL_PACKAGES=reader` means the *profile*, and enabling just
the `reader` package alone becomes inexpressible if the profile expands wider.
Nowhere does the corpus define the expansions: does `publisher` include
`reader` + `insights`? Does the default `core` profile expose *only*
whoami/list_pages/get_page/usage — a first-run surface that can neither read
nor post (the reference's default `core` is a genuinely useful read surface)?

**Recommendation:** Add the profile→package expansion table to 06 (or 05 §6),
rename colliding profiles or packages (e.g. profiles `publisher`, `moderator`
already avoid it — do the same for the other three), and decide the default
profile's UX deliberately (suggest default = `core` + `reader` + `insights`:
useful and read-only).

### 9. **Minor** — Client-side quota/window enforcement needs durable state and contradicts the corpus's own pass-through philosophy

06 promises client-side enforcement of: Reels 30-per-rolling-24 h, private
replies "one per comment, 7-day window", and the 24-hour messaging window. All
three require durable state (a rolling send ledger; per-comment reply history;
per-conversation last-user-message timestamps) whose storage is never
specified — while the write journal's format is itself an open question (07
Q5). Meanwhile 03 argues (for insights metrics) *against* client-side
replication of server-enforced rules: "do not hardcode … surface the API's
errors readably". Both stances are defensible; holding each on a different
tool is not.

**Recommendation:** Pick one policy: either (a) drop client-side enforcement
and invest in first-class *error mapping* (the API rejects these anyway —
translate error 613/subcodes into "Reels 24 h budget exhausted" text), which
is stateless and consistent with the insights stance; or (b) if pre-flight
checks are kept, name the write journal as the backing store and specify its
retention. (a) is recommended for v1.

### 10. **Minor** — No video/Reel processing-status tool; `facebook_create_reel` completion semantics undefined

Upload finishing is not publishing: after `upload_phase: finish` (and after
video POSTs), Meta processes asynchronously and can fail minutes later (codec,
aspect-ratio, duration rejections). The catalog (06) has no
`facebook_get_video_status` (`GET /{video-id}?fields=status` — documented in
`pages-api.md` §Reels), and it is unspecified whether `facebook_create_reel`
returns at *finish-accepted* or polls until *ready/published*. Blocking until
ready re-imports finding 5's timeout problem; returning early without a status
tool strands the model.

**Recommendation:** Add `facebook_get_video_status` (RO) to the `posts` or
`reader` package; specify create tools return immediately after the publish
call with `video_id` + "processing" and point at the status tool.

### 11. **Minor** — The Graph Batch API is absent even as a consideration

Rate limits are a stated top-5 differentiator and R3 is High-impact, yet the
canonical Graph mitigation — `?batch=[…]` (up to 50 sub-requests per call,
one BUC charge profile) — appears nowhere. Two designed flows would use it
immediately: multi-photo posts (N unpublished uploads) and per-post insights
across a post list.

**Recommendation:** No v1 build needed; add a paragraph to 05 §2 reserving the
design space (batch as an `api/shared.ts` capability of `fbRequest`, not a
tool) so the HTTP client's request shape (per-request → array-of-requests)
isn't designed into a corner. Note the interaction with `appsecret_proof` and
per-sub-request errors.

### 12. **Minor** — Strict `outputSchema` on Graph shapes will be brittle under Meta's field churn

02/05 make `outputSchema`/`structuredContent` a differentiator, and the SDK
*validates* `structuredContent` against `outputSchema` at runtime. But R1
documents Meta's habit of removing/renaming fields out-of-cycle, and tools
accept a caller-controlled `fields` selection — the honest output shape is
dynamic. A strict output schema turns Meta shape drift into hard tool failures.

**Recommendation:** Scope strict output schemas to server-owned envelopes
(`facebook_usage`, doctor/whoami, plan previews, pagination wrappers
`{items, truncated}`) and keep Graph-node payloads permissive
(`z.record`/passthrough or schema-less). State this in 05 §8 so it's a policy,
not 35 ad-hoc decisions.

### 13. **Minor** — Messaging polling state ownership is undefined

03 and 01 designate polling (`diff updated_time/unread_count`) as the
ingestion path, which implies remembered last-seen state; 07 Q3 debates tool
vs resource but not *who owns the cursor*. A stateless v1 answer exists — the
tool returns current conversations with `updated_time`/`unread_count` and the
*model* diffs against its context — and matches the stateless-friendly
commitment; server-side watermarks would need a state file and re-raise the
"where does durable state live" question (finding 9).

**Recommendation:** State explicitly in 05/06 that v1 messaging tools are
stateless snapshots (optionally accepting a `since` argument the *caller*
supplies) and that no poll cursor is persisted server-side.

### 14. **Minor** — The ported bootstrap defaults contradict the spec-transition decisions

02/07 correctly rule out building on Logging (deprecated in 2026-07-28) and
promise stateless-friendliness. But 05 ports the reference bootstrap and
transport "as in servicenow-mcp", and the reference (a) declares
`capabilities: { logging: {} }` and mirrors logs to the client via
`setServer()`, and (b) runs Streamable HTTP with a `randomUUID`
**session-ID** generator — the exact `Mcp-Session-Id` mechanism SEP-2575
removes. Ported verbatim, the codebase starts life on both deprecated paths.

**Recommendation:** Add both deltas to 05's "What we do NOT port": no logging
capability / no client log mirroring (stderr only, as 04 already says), and
HTTP transport kept minimal and sessionless (or explicitly deferred past v1 —
its v1 value for a single-operator stdio server is marginal anyway).

### 15. **Nit** — Testing against `build/` is inherited without a decision

05 §Stack ports "tests … against built output". The reference's own research
note flags this as a caution ("consider testing source directly if
preferred"): it costs a build step per test cycle and prevents importing
un-exported internals. Fine to keep — the reference proves it works — but it
should be a decision, not an inheritance; record the rationale (tests exercise
the exact shipped artifact) in 05.

### 16. **Nit** — Quarantine zod-v3-specific idioms for the v2/Standard-Schema migration

The reference registry uses `z.object({...}).strict() as unknown as typeof
spec.input` — a v3-specific type cast at the registration boundary. SDK v2
moves to Standard Schema (zod v4), and the codemod will not rescue casts like
that. The corpus already centralizes registration (good); make it explicit in
05 §5 that *all* zod-API-specific constructs (`.strict()`, raw-shape typing,
`applyInput`) live only in `mcp/define.ts` + `mcp/registry.ts`, never in
`tools/` or `api/`, so the v2 migration touches two files.

## Open questions for the author

1. Has direct System-User-token publishing to a Page (`POST /{page-id}/feed`)
   been verified against the real target Page, or is success criterion #1
   currently resting on an untested assumption? (Finding 1 — this should be a
   Phase 0 doctor check either way.)
2. What exactly does each `FB_TOOL_PACKAGES` profile expand to, and what is
   the intended *default* first-run surface — is a default that can neither
   read nor post acceptable UX? (Finding 8.)
3. Where does durable server-side state live, as a single answer — write
   journal entries, Reels-budget ledger, private-reply history, messaging poll
   watermarks, resumable upload sessions? One store, several, or "none in v1"?
   (Findings 5, 9, 13.)
4. Is the Streamable HTTP transport actually needed in v1, given the primary
   user runs stdio and the 2026-07-28 spec rewrites the HTTP session model
   under it? (Finding 14.)
5. Is the plan-mode contract "zero network mutations, local validation only"
   — including for multi-photo and Reels flows? (Finding 7.)
6. Do `facebook_create_video_post` / `facebook_create_reel` block until Meta's
   async processing completes, or return `video_id` immediately for status
   polling? (Findings 5, 10.)
7. Is multi-ad-account support intended (05 §4 shows a single
   `FB_AD_ACCOUNT_ID` while Pages get a full profile scheme), or is
   single-account by design? Worth one sentence in 05 either way.
