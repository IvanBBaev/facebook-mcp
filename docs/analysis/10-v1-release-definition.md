# 10 — v1.0 Release Definition & Gap Additions

Written 2026-07-22, after a full re-read of docs 01–09 and the review summary.
Purpose: (a) define what "version 1.0" actually is — the corpus never said;
(b) list the gaps that must be **added** to the plan for 1.0, none of which are
covered by the review action list A1–A16 or the corner-case catalog. Items that
extend an existing action are cross-referenced.

## 1. What is v1.0? (previously undefined)

The roadmap has Phases 0–5 but no version mapping. Binding definition:

| Milestone | npm version | dist-tag |
|---|---|---|
| Phase 0 exit (skeleton + core package) | `0.1.0` | none (no publish) |
| Phase 1–2 exit (reader + posts/media) | `0.2.0` | none (no publish) |
| Phase 1–3 exit (insights + moderation) | `0.3.0` | none (no publish) |
| Phase 3 exit (messages) | `0.4.0` | none (no publish) |
| **Phase 4 exit (distribution + dogfood + onboarding gate)** | **`1.0.0`** | `latest` |
| Phase 5 exit (ads read + control) | `1.1.0` | `latest` |

✎ The three pre-1.0 rows were re-cut when the GitHub milestones were created,
and this table now follows them. The original mapping was one phase per version
(`0.2.0` = reader + insights, `0.3.0` = posts + media, `0.4.0` = moderation +
messages); the milestones instead group by what a user can *do* with a release —
reading and publishing land together in `0.2.0`, then insights and moderation in
`0.3.0`. Phases are development gates and did not move; only their packaging into
versions did. Nothing before `1.0.0` is published, so no consumer was affected.

- Nothing is published to npm before `1.0.0` — pre-1.0 versions exist only as
  git tags. This avoids shipping a half-surface package under the reserved name
  (the name itself is reserved at Phase 0 exit with a placeholder publish only
  if npm policy requires it — decide with G2).
- **v1.0.0 therefore ships without the ads package.** That is deliberate: the
  Pages surface is the product (doc 02); ads lands in 1.1.0 already rescoped
  to read + status/budget control (A12).
- Pre-1.0 semver: breaking changes allowed at any 0.x bump. Post-1.0: the
  DevOps policy applies (manifest snapshot anchors breaking-change detection;
  default `FB_API_VERSION` bump = minor).

## 2. Tool-surface additions for 1.0

- **G-TOOL-1 `facebook_get_comment` (moderation package) — SHIPPED.** The
  catalog had `list_comments` but no single-comment read. Moderation previews
  already require re-fetching current comment text (CC-MOD-6); the model needed
  the same capability first-class — acting on a comment ID from a prior turn
  without re-listing the whole thread. Landed in the `moderation` package with an
  RO annotation, and it taints the comment body like every other UGC read.
  ✎ Unverified against real Graph, in common with the whole surface (§1).
- **G-TOOL-2 Reels insights path — SHIPPED.** Reels metrics live on
  `/{video-id}/video_insights`, not on the post-insights edge, so
  `facebook_post_insights` cannot reach them. Resolved as a **separate tool**,
  `facebook_reel_insights`, rather than ID-routing inside `post_insights`: the ID
  spaces are disjoint (bare video ID vs `{page-id}_{post-id}` composite), the metric
  vocabularies are disjoint, and a tool must not silently read a different edge than
  its name promises. Both existing insights descriptions now redirect to it, and an
  all-empty Reel result names the three real causes (wrong ID / not PUBLISHED / lag)
  instead of reading as "no engagement". ✎ The edge remains unverified against real
  Graph, in common with the whole surface (§1).
- **G-TOOL-3 Reels lifecycle verification.** Reels are invisible on post
  endpoints (verified) — but can `delete_post` delete a Reel by video ID, and
  where do **scheduled** Reels appear (`/scheduled_posts` or `/video_reels`)?
  ✎ Verify at Phase 2; `delete_post`/`list_scheduled_posts` descriptions must
  state the answer either way. Phase 2.
- **G-TOOL-4 `mark seen` on conversations — DECIDED: NOT SHIPPED.** Polling-based
  messaging leaves conversations unread forever, so `unread_count` — the
  designed polling diff signal (doc 03) — never resets, and the candidate fix was
  a `sender_action: mark_seen` call folded into `facebook_get_conversation` as an
  opt-in param. Rejected at Phase 3: it would make a tool annotated
  `readOnlyHint: true` mutate state a real person sees (a read receipt tells the
  human "someone read this"), and no opt-in param can be trusted to keep a read
  tool honest once a model is choosing the arguments. The operator cost is real
  and accepted — `unread_count` stays non-resetting. Recorded in the header of
  `src/tools/messages.ts` so the decision is visible where the tool lives; if it
  ever ships it must be a separate, write-tiered tool.
- **G-TOOL-5 Server version surfacing — SHIPPED.** `--version` CLI flag and a
  `version` field in `facebook_whoami` output (server version + pinned default
  `FB_API_VERSION` + SDK version), both fed from the metadata SSOT. `--version`
  answers before settings are loaded, so a bug reporter with a broken
  configuration can still report which build they are on.

## 3. Runtime additions for 1.0

- **G-RUN-1 Journal rotation — SHIPPED.** The write journal (05, Sec #7) grew
  without bound — CC-LIFE-1 covers write *failure* but nothing covered growth.
  Capped by size with single-generation rotation (`journal.ndjson` →
  `journal.1.ndjson`, ~5 MB) in `src/mcp/journal.ts`, mode 0600. The cap is
  checked before the next append rather than mid-write, so a file may slightly
  exceed it — hence "~5 MB", not a hard ceiling. No config knob, as decided.
- **G-RUN-2 Pin `platform=messenger` on conversation reads — SHIPPED.** The
  `/conversations` edge can return Instagram threads on linked accounts; IG is
  out of scope (doc 01) and accidental IG data would violate the declared scope.
  Pinned in `src/api/messaging.ts` on the request itself (not as a caller-supplied
  default), so no tool argument can widen it.

## 4. Documentation & repo-hygiene additions for 1.0 (Phase 4)

- **G-DOC-1 OSS hygiene set.** A 1.0 with hoped-for non-author adoption
  (PM #4 success metrics) needs: `CONTRIBUTING.md` (build, test, no-secrets
  rules, PR expectations), GitHub issue templates (bug report requires
  `--version` output + doctor summary — pairs with G-TOOL-5), PR template,
  a support statement (single maintainer, best-effort, minimum maintained
  core per PM #7), and an explicit **"no telemetry, no phone-home"**
  statement in README/SECURITY.md — it is true by design (3-host allowlist)
  and is a trust differentiator worth stating.
- **G-DOC-2 SECURITY.md disclosure section.** The planned SECURITY.md (PM #2)
  covers trust guarantees but not vulnerability reporting: add private
  disclosure channel (GitHub private vulnerability reporting), response
  expectation, supported-versions table (latest minor only).
- **G-DOC-3 Operator lifecycle runbooks** (`docs/runbooks/`, shipped in repo) —
  **DONE**; seven runbooks shipped, one per bullet below plus onboarding and the
  release cut:
  - *Token rotation / kill-switch* — expands Sec #6's mention into steps.
    → [`../runbooks/credential-rotation.md`](../runbooks/credential-rotation.md),
    [`../runbooks/kill-switch.md`](../runbooks/kill-switch.md)
  - *Uninstall / offboarding* — revoke token, delete system user, remove env
    file + journal + XDG state; currently no teardown story exists anywhere.
    → [`../runbooks/offboarding.md`](../runbooks/offboarding.md)
  - *Meta app upkeep* — **Data Use Checkup** (Meta requires periodic
    reconfirmation; missing it disables the app — a doctor can't detect this,
    only warn about it in docs) and the ~4-week changelog cadence (PM #7).
    → [`../runbooks/app-upkeep.md`](../runbooks/app-upkeep.md), which also covers
    the `FB_API_VERSION` deprecation clock and journal-rotation retention.
  - *Operator-window runbook* for live-unverifiable tools (QA) — referenced in
    Phase 3 gate but never given a home; this is its home.
    → [`../runbooks/operator-window.md`](../runbooks/operator-window.md)
- **G-DOC-4 Platform-policy compliance note** (in 04 + README). The server
  automates posting/messaging; the operator remains responsible under Meta
  Platform Terms (spam/automation policy, Messenger automation disclosure —
  extends the Meta reviewer's minor). One honest paragraph, not legal advice.
- **G-DOC-5 Client compatibility matrix** (README). Which MCP clients are
  tested (Claude Desktop, Claude Code) and how optional capabilities degrade:
  no `progressToken` → no upload progress; no elicitation → operator-token
  confirmation fallback (CC-MCP-6). Sets expectations for other clients
  (Cursor, VS Code) without claiming support.
- **G-DOC-6 Honest scope enumeration** (extends A13/PM #5). "Full Pages
  surface" must name what v1.0 does **not** cover: Stories (pending Phase 2
  verification), Events, Live video, albums/photo-library reads, Page profile
  management (about/cover/CTA buttons), organic post targeting
  (country/language gating), and **boosting a post** (the organic→ads bridge
  users will ask for first — parked for post-1.0, see §5). Goes into 01's
  out-of-scope list and the README.

## 5. Explicitly parked beyond 1.1 (recorded so "no" is a decision, not a gap)

- **Boost-post bridge** (`/{page-id}/promotions` or boosted-post creation) —
  the most likely first feature request after 1.0; needs ads package +
  careful spend gating; design after Phase 5 ships.
- Generated error-catalog README section (from the error→action matrix) —
  nice-to-have; the matrix itself ships in Phase 0.
- Doctor machine-readable output (`--json`, exit codes) for scripting.
- Everything already in the roadmap's Deferred list (Batch API, MCP Tasks,
  elicitation UI, custom audiences, HUMAN_AGENT, IG/Threads, webhook relay,
  OAuth flow, SDK v2).

## 6. Roadmap placement summary

| Item | Phase | Status |
|---|---|---|
| G-TOOL-5 version surfacing, G-RUN-1 journal rotation | 0 | shipped |
| G-TOOL-2 Reels insights | 2 | shipped, live-verify pending ✎ |
| G-TOOL-3 Reels lifecycle (delete-by-video-id, scheduled-Reel edge) | 2 | open ✎ — needs live Graph |
| G-TOOL-1 get_comment, G-RUN-2 platform pin | 3 | shipped |
| G-TOOL-4 mark_seen | 3 | decided: not shipped |
| G-DOC-1…6 (hygiene, disclosure, runbooks, policy, compat, scope) | 4 | G-DOC-3 done; rest open |
| §1 version map | governs all phases | binding |

These items are additive to the roadmap v2 gates. Every one of them is now
decided: the only code-level item still open is G-TOOL-3, and it is open because
it asks a question **only real Graph can answer** — no amount of implementation
closes it. What each shipped item lacks is live verification, which is the whole
point of the 1.0 milestone (§1) rather than a gap in this list. The G-DOC set
joins the Phase 4 exit gate (a 1.0 without them fails the "non-author
onboarding" spirit of PM #3).
