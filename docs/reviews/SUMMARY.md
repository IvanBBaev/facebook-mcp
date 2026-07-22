# Review Consolidation — SUMMARY

Consolidated 2026-07-22 from the seven senior role reviews of the analysis corpus
(`docs/analysis/01–08`). Reviews were run in parallel by independent agents; this
document deduplicates their findings, ranks them, and turns them into a
prioritized action list. Individual reviews remain the authoritative record of
each role's full reasoning.

## Verdicts

| # | Role | File | Verdict |
|---|---|---|---|
| 1 | Software Architect | [01-software-architect.md](01-software-architect.md) | go-with-changes |
| 2 | Security Engineer | [02-security-engineer.md](02-security-engineer.md) | **conditional go** (1 Blocker) |
| 3 | Meta Platform Specialist | [03-meta-platform-specialist.md](03-meta-platform-specialist.md) | go-with-changes |
| 4 | QA Engineer | [04-qa-engineer.md](04-qa-engineer.md) | go-with-changes (1 Blocker) |
| 5 | DevOps / Release Engineer | [05-devops-release-engineer.md](05-devops-release-engineer.md) | go-with-changes |
| 6 | Product Manager | [06-product-manager.md](06-product-manager.md) | go-with-changes |
| 7 | MCP Agent-UX Engineer | [07-mcp-agent-ux-engineer.md](07-mcp-agent-ux-engineer.md) | go-with-changes |

No review recommended stopping the project. All verdicts converge on: the corpus
is sound, the architecture port is right, but **specific decisions must land
before Phase 0** and several corpus claims need correction. Exactly **two
findings are Blockers**; everything else is Major or below.

---

## Blockers (must be resolved in the corpus before any code)

### B1 — Prompt injection / confused deputy (Security #1)

Attacker-controlled Facebook content (comments, DMs, visitor posts) flows into
the same model session that holds delete/publish/send/ads-spend tools.
Plan-and-apply is an *accident* control operated by the same model that read the
tainted content — it is not a *security* control.

**Required corpus changes (04-auth-and-security.md):**
- Add a threat-model section naming the confused-deputy scenario explicitly.
- Tainted-content isolation envelope: UGC-returning tools wrap user text in a
  clearly delimited data envelope with an injection warning.
- Out-of-band confirmation gate for destructive/spend tools (MCP elicitation
  where supported; operator-token fallback), not bypassable by `FB_WRITE_MODE`.
- Package-separation guidance: document `FB_PACKAGES` read-only profile as the
  recommended configuration for unattended UGC ingestion sessions.

### B2 — Live smoke gates reach real audience / real money (QA #1)

The roadmap's live smoke tests as written would publish to the production Page
and create real ad objects with no cleanup contract.

**Required corpus changes (08-roadmap.md — applied in v2):**
- Dedicated **test Page** under the same Business portfolio for all write
  smokes; the production Page is read-only smoke territory (insights stays on
  production because of the ≥100-likes floor).
- Writes are unpublished/DRAFT-only; scheduled-post smoke uses a far-future time
  and verifies deletion.
- `[FBMCP-SMOKE <nonce>]` marker in all smoke content + a start/end sweeper
  that deletes anything carrying the marker.
- Ads smoke belt-and-braces: precondition on an account spending limit, force
  `PAUSED`, re-read `effective_status`, set `spend_cap`, `finally`-delete.
- Reels smoke consumes the 30/24h budget — run it deliberately and rarely.

---

## Converged Majors (found independently by ≥2 reviews)

### C1 — Day-0 gate: mint the real system-user token (Arch #1, Meta #1)
The recommended credential path rests on an **unverified** Business Verification
prerequisite, and the Page-token topology is contradictory between docs 03 and
04. Before Phase 0: actually mint the system-user token; keep the long-lived
Page token as a first-class fallback, not a footnote. Architecture: per-page
token resolver in `core/auth` (derive → cache → invalidate on error 190 →
re-derive once), verified empirically by the doctor.

### C2 — Ambiguous-outcome writes must never be retried (Arch #6, QA #4, UX #2)
Graph API has **no idempotency keys**. A publish/send whose socket was written
but whose response was lost may have succeeded. Rules: publishing/messaging
POSTs are never auto-retried after the request body is on the wire; the error
result says "unknown outcome — do NOT retry blindly; verify via
`facebook_list_posts` / `facebook_get_conversation`". Throttle codes arrive as
HTTP 400 body codes, so the retry matrix must be table-driven and tested
(include error 506 duplicate-post). Optional in-process dedupe for messaging.

### C3 — Token leakage via `paging.next` + query-string auth (Arch #3, Sec #2/#8)
Graph responses embed `access_token` in paging URLs (including nested paging).
Invariants: send auth via `Authorization: Bearer` (never query string, except
where the API forces otherwise); the result shaper strips **all** `paging`
objects and token-bearing URLs recursively; redaction is **value-based** at a
single choke-point (raw secret values: EAA tokens, 32-hex app secret,
`appsecret_proof`, `FB_HTTP_TOKEN`, `{app-id}|{app-secret}`) across logs,
errors, results, and the journal; pattern-scan is defense-in-depth only.

### C4 — Plan-and-apply hardening (Sec #3, Arch minor, QA #14, UX #6)
- Tier write gating by blast radius: irreversible (delete) and spend (ads)
  tiers are **never** covered by the `FB_WRITE_MODE=apply` env bypass.
- Plan mode = **zero network mutations**, enforced by a generic all-tools test
  sweep (QA) — but preview is a *validating dry-run*: resolves Page name/ID,
  publish state, permission-matrix check, local constraint checks, warnings,
  before-state for update/delete, and an explicit "The post was NOT published"
  anti-hallucination line (UX).
- Highest-consequence tools bind apply to a short-lived `plan_id` from the
  preview step.
- Per-package write-mode defaults to avoid confirmation stacking (moderation
  may default to apply; publishing/ads never).
- Define plan/apply divergence semantics: apply re-validates; if state changed
  since preview, fail with a diff rather than proceeding.

### C5 — Default profile expansion is THE missing line (Arch minor, UX #10)
`FB_TOOL_PACKAGES` default `core` expansion was never defined. Decision:
default profile = `core + posts + reader + insights + moderation + messages`
(≈27 tools), **ads excluded by default**. Document the expansion table in 05
and 06 and snapshot-test it.

### C6 — Insights metrics are training-data poison (Meta #2, UX #5)
The post-Nov-2025 metric reset (`page_impressions` → `page_media_view` etc.)
plus the June-2026 video wave means both the corpus's "safe set" and the
model's training data are stale. Demote corpus metric lists to "candidate
examples, live-verified at Phase 1"; the doctor probes valid metrics and
generates a README metric table; insights tool descriptions carry the current
metric set; invalid-metric errors return a static rename-suggestion table.
Wire the ≥100-likes floor into the doctor and tool descriptions.

### C7 — Uploads exceed both the HTTP seam and the test seam (Arch #4, QA #2)
`fbRequest` must cover three wire protocols: JSON/query-string, multipart
`FormData`, and raw-binary rupload with header auth + per-request timeout —
otherwise media code bypasses `core/http`. Testing: buffered chunking in v1, a
body-capture helper for `withFetch`, enumerated fault-injection tests; chunk
POSTs bypass the generic retry matrix (resume via offset query instead).
Long uploads: progress notifications via `progressToken`; resumable-session
state is in-memory v1 ("resume within one server lifetime") — the single
durable-state answer (Arch #5, QA Q5). MCP Tasks noted as future work.

### C8 — Name the package now, not at Phase 4 (DevOps #1, PM minor)
npm/repo naming is a Phase 0-exit decision: verify availability, reserve the
name, add a trademark disclaimer. DevOps recommends unscoped `facebook-mcp-ai`
(fallback `@ivanbbaev/facebook-mcp`); PM prefers a "pages"-bearing name and
checking Meta brand terms. **Decision to make at Phase 0 exit** with both
constraints on the table; `mcpName` must ship in the *first* npm publish.

### C9 — Mid-session token death (QA #5, UX error matrix)
Errors 190 + subcodes 460/463/467 are non-retryable and must map to actionable
guidance (which env var to refresh, which doctor command to run). Covered by
the table-driven error→action matrix (`{code, subcode}` → text + next tool),
snapshot-tested; includes 190, 506, 368, edit-not-own-app, async-report flow,
cursor expiry.

### C10 — Reels client-side A/V validation is infeasible (QA #8, UX #6)
With a 3-dependency budget there is no ffprobe: drop client-side
duration/aspect validation; surface Meta's own validation errors well instead;
preview warns based on file size/extension only. `video_upload_limits` field is
unconfirmed — degrade gracefully if absent.

### C11 — Local media is an exfiltration channel (Sec #5, DevOps minor, QA #10)
`FB_MEDIA_DIR` unset ⇒ local file access **disabled** (URL-only default). When
set: realpath containment (symlink-safe), no cross-host redirects on remote
fetches, reword the "no local SSRF" claim in 04. MCPB `user_config` marks it
sensitive.

### C12 — stdout purity is a Phase 0 gate (DevOps #4, QA #7)
dotenv v17 prints a banner to stdout, corrupting stdio JSON-RPC. Pin/quiet it;
add a spawn-level stdout-purity test (server boots, stdout contains only
JSON-RPC) as a Phase 0 gate; adversarial redaction suite + `logFields` audit
ride the same rail.

### C13 — Secret-free CI with a network fence (DevOps #5, QA minor)
CI never sees a real token: fetch-thrower bootstrap in unit tests, smoke
scripts live outside the test glob (`scripts/smoke/`, `FB_SMOKE=1`), synthetic
fixtures only, record-time token stripping (`scripts/record-fixture.mjs` +
fixture-lint that greps for `EAA`), GitHub secret scanning + push protection
from day 0.

### C14 — No AsyncLocalStorage; explicit page plumbing (Arch #2, UX #8)
Multi-page context via ALS is the wrong idiom for a request-scoped MCP server.
Keep an optional tool arg backed by a trivial `resolvePage(name?)` registry;
`api/` signatures take explicit `pageId`. UX: rename the auto-injected arg to
`profile`, accept a profile key or raw Page ID, omit-by-default guidance in
descriptions.

---

## Single-review Majors (still required, no convergence needed)

**Security:** (Sec #4) HTTP transport fails closed without `FB_HTTP_TOKEN`,
validates `Origin` (DNS rebinding), binds 127.0.0.1 only. (Sec #6) Minimal
token scope: drop `business_management` from runtime, scope token to enabled
packages, 60-day default lifetime option, kill-switch runbook, doctor warns on
over-scope. (Sec #7) Write journal: structured metadata only, through the
redactor, 0600 under XDG state dir, no tokens/PII.

**Meta platform:** scheduling upper bound is 75 days per API (don't hard-cap at
30; validate the 10-minute lower bound + Reels 29d; warn above 30). Throttle
detection = code families 4/17/32/613 + range 80000–80099, not enumeration.
Delete-user-comment needs `pages_read_user_content` (split doctor matrix).
"Require App Secret" breaks Graph Explorer test calls — document the toggle
trade-off. Messenger automation-disclosure policy note. Polling default
60–120s, adaptive to BUC usage %.

**QA:** injectable clock seam (`now()`/`sleep()`) decided before Phase 0;
fixture strategy with sanitized recordings + shape-diff at `FB_API_VERSION`
bumps; pagination edge cases (empty `data` with `paging.next`; cursor expiry
mid-`fetchAll` → partial + `truncated` + note; fast-check termination
property); coverage floors 70/60/75 + ratchet ritual; mark live-unverifiable
tools (`send_message`, `private_reply`, `block_user`) + operator-window
runbook; Windows CI leg.

**DevOps:** metadata SSOT — settings module + `gen-metadata.mjs` feeding all
five surfaces (package.json, server.json, MCPB manifest, `.claude-plugin/`,
README/.env.example) + CI drift test + publish version assertions. Node
`engines >=22` (20 is EOL), CI matrix 22/24/26. Release = tag-driven CI-only +
npm Trusted Publishing OIDC (no `NPM_TOKEN`); provenance requires the repo
public before the first tag; attach `.mcpb` + SHA-256 checksums. No install
scripts ever (doctor via `npx`, never postinstall). Semver policy: default
`FB_API_VERSION` bump = minor + changelog link, anchored to the manifest
snapshot.

**Product:** add the "Meta ships an official Pages MCP" risk (Medium/High) with
the survival story (local media, plan-and-apply, multi-page, token ownership,
packages, composability). Reorder differentiators into "why install" vs "why
stay/trust" + trust artifacts (SECURITY.md guarantees, comparison table, honest
signposting to Meta's ads MCP). Onboarding: Explorer→exchange→Page-token as the
default quickstart + `setup-token` helper subcommand; Phase 4 gate: non-author
onboarding ≤20 min. Success criteria: author weekly use ≥4 weeks; TTFC ≤20
min; +90-day checkpoint (≥100 weekly downloads / ≥25 stars / ≥3 non-author
issues) else pre-committed downgrade to personal tool. Scope truth: Stories
absent (verify at Phase 2 or declare out-of-scope), draft/scheduled lifecycle
needs publish-now/reschedule/cancel. Ads v1 = read + status/budget control only
(defer create-chain + image upload). Maintenance: minimum maintained core,
changelog-check cadence ~4 weeks, IG/Threads scope statement, pre-written
sunset story. License: MIT, decided now.

**Agent UX:** full annotation quadruple explicit per tool (spec defaults
`destructiveHint: true` when annotations are present — "—" rows are a contract
gap); quadruple snapshot-tested. Messaging trio (`reply_to_comment` vs
`private_reply` vs `send_message`) gets description contracts with negative
space + decision rules. Reels invisibility + ~600/yr `published_posts` cap
disclosed on `list_posts`/`get_post` + in-band pagination notes. Model-facing
pagination contract (cursor naming, expiry error "restart listing",
truncation-keeps-first + order param). Comments-with-user-token silent-empty →
active runtime guard from `debug_token` type. Insights reshape contract (strip
boilerplate, collapse series, `aggregate` param, breakdown row caps,
`FB_MAX_RESULT_CHARS` ≈25k). `outputSchema` only for server-owned envelopes
(whoami, usage). ID round-tripping/chaining rules in descriptions.

---

## Minors & Nits (condensed; full text in the individual reviews)

- Drop client-side quota enforcement; map Meta's errors well instead (Arch).
- Add `facebook_get_video_status`; video creates return `video_id` +
  `processing` state (Arch).
- Reserve Batch API design space; do not build it in v1 (Arch).
- Messaging tools are stateless snapshots (caller-supplied `since`) (Arch).
- Do not port ServiceNow logging capability or sessionful HTTP (Arch).
- Quarantine zod-v3 idioms in `mcp/define.ts` + `registry.ts` (Arch).
- Ads creates force `PAUSED` + budget ceiling env (Sec).
- Report raw `ads_api_access_tier`; re-pull Messenger changelog before Phase 3
  (Meta).
- `InMemoryTransport` smoke, all-tools smoke, property-test targets (QA).
- Keep build-first testing + freshness guard + sourcemaps (QA).
- Usage-header parsing robustness (absent/malformed headers) (QA).
- CodeQL, dependabot, SHA-pinned actions, lockfile policy; Node-floor
  five-places drift test; Windows chmod honesty in doctor (DevOps).
- MCPB pack pipeline + `compatibility.runtimes.node`; `mcp-publisher`
  github-oidc with pinned binary (DevOps).
- Bulk moderation takes `ids: string[]` ≤50; reframe messages package as
  "comment-driven private replies + within-window responses (polled)";
  `get_reactions` is marginal; document best-time-to-post infeasibility;
  qualify "no maintained TS Pages server" (PM).
- Verb symmetry hide/unhide, block/unblock; media-family negative-space
  cross-references; naming-convention exceptions codified + lint-enforced;
  truth-in-description pins (CARE→LIKE, link preview best-effort, scheduling
  window, ACTIVE≠delivering); `list_scheduled_posts` read-only inside a
  write-gated package; elicitation recorded as deferred confirm channel with a
  seam (UX).

## Verified-correct list (Meta specialist, live at v25.0)

Photos `caption`; multi-photo unpublished+`attached_media`; `child_attachments`
2–5; CARE→LIKE mapping; Messenger tag hard-fail dates; private-reply
one-shot/7-day; BUC 4800×engaged_users; ~600 posts/yr cap; edit-own-app-only;
DELETE select-developers note. These corpus claims need **no** change.

---

## Prioritized action list

### A. Corpus updates (before any code)

| # | Action | Corpus file | Source |
|---|---|---|---|
| A1 | Threat model + tainted-content envelope + OOB confirmation + package-separation guidance | 04 | B1 |
| A2 | Rewrite live-smoke protocol (test Page, markers, sweeper, ads belt-and-braces) | 08 (v2) | B2 |
| A3 | Soften system-user claim; Page-token fallback first-class; per-page resolver design | 03, 04, 05 | C1 |
| A4 | Retry matrix: never retry ambiguous writes; 400-body throttle codes; error 506 | 03, 05 | C2 |
| A5 | Bearer auth + paging-strip invariant + value-based redaction spec | 04, 05 | C3 |
| A6 | Write-gating tiers, plan_id binding, per-package defaults, divergence semantics | 05, 06 | C4 |
| A7 | Define default profile expansion (core+posts+reader+insights+moderation+messages) | 05, 06 | C5 |
| A8 | Demote insights metric lists to candidates; doctor probe + description contract | 03, 06 | C6 |
| A9 | fbRequest 3 wire protocols; in-memory resumable state; progressToken | 05 | C7 |
| A10 | FB_MEDIA_DIR disabled-by-default + realpath; reword SSRF claim | 04, 05 | C11 |
| A11 | Annotation quadruples explicit for all ~35 tools | 06 | UX #1 |
| A12 | Ads package rescoped: read + status/budget control in v1 | 01, 06, 08 | PM #6 |
| A13 | Stories decision + scheduled-post lifecycle tools; soften "full surface" claim | 01, 06 | PM #5 |
| A14 | Meta-official-MCP risk entry + differentiator reorder + success metrics | 02, 07 | PM #1/2/4 |
| A15 | Scheduling window 10min–75d (warn >30d); throttle code families; permission split | 03 | Meta minors |
| A16 | License = MIT; naming decision procedure at Phase 0 exit | 01, 02 | C8, PM |

### B. Day-0 gates (before Phase 0 code)

1. **Mint the real system-user token** (or confirm Page-token fallback) — C1.
2. **Verify npm name availability** for the two candidates — C8.
3. **Decide clock seam** (`now()`/`sleep()` injectable) — QA #6.
4. Repo public/private decision (provenance needs public before first tag).

### C. Phase 0 rails (build into the skeleton, not retrofitted)

Value-based redaction choke-point; stdout-purity spawn test; CI network fence;
secret scanning + push protection; Node engines ≥22 (CI 22/24/26); no-ALS page
registry; Bearer + paging-strip in `fbRequest`/shaper from the first line;
metadata SSOT + gen script; error→action matrix table (snapshot-tested);
coverage floors 70/60/75; write journal through redactor.

### D. Deferred by decision

Batch API (design space reserved); MCP Tasks; elicitation as confirm channel
(seam only); custom audiences; HUMAN_AGENT; IG/Threads; SDK v2 migration;
client-side Reels A/V validation (dropped, C10); client-side quota enforcement
(dropped); ads create-chain + image upload (deferred from v1, A12).

The implementation roadmap incorporating all of the above is
[08-roadmap.md](../analysis/08-roadmap.md) (v2); the corner-case catalog that
feeds the test plan is
[09-corner-cases.md](../analysis/09-corner-cases.md).
