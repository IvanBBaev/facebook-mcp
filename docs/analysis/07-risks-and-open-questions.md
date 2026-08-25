# 07 — Risks and Open Questions

## Platform risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **Metric/endpoint deprecation churn** — Meta removed 100+ insights metrics in 3 waves; more will follow (June-2026 wave just landed) | High | Medium | Pass metrics through instead of whitelisting; surface API errors; version pinned but configurable; changelog check ritual each version bump |
| R2 | **API version expiry** (~2-year lifetime; the pinned v23.0 ages out first) | Certain | Low | `FB_API_VERSION` config; CI job hitting the changelog is overkill — a README upgrade note suffices |
| R3 | **Rate limiting / app restriction** — aggressive polling or bulk ops could throttle (80001) or flag the app | Medium | High | Proactive header parsing + backoff at 90%; documented polling intervals (≥30–60 s); Reels 30/24h budget enforced client-side |
| R4 | **Token invalidation** — "never-expiring" tokens die on system-user deletion, app disowning, scope revocation, security events | Low | Medium | `debug_token` at startup + clear doctor diagnostics; documented re-issue procedure |
| R5 | **Policy drift** (messaging tags hard-fail 2026-04; ASC/AAC merge Sept 2026) | High (ads), Medium (rest) | Medium | Ads package isolated; messaging limited to RESPONSE-type sends; re-verify list below |
| R6 | **NPE field quirks** — New Pages Experience returns null/exceptions on some documented fields; the official differences doc is gone | Medium | Low–Medium | Verify per-field during integration testing on the real Page; tolerate nulls in schemas |
| R7 | **Meta ships an official hosted MCP for the Pages surface** — Meta already operates an official hosted MCP for ads; extending it to Pages would erode this project's core value proposition (competitive / platform-strategy risk) | Medium | High | Survival story: self-hosted token ownership (nothing leaves the operator beyond Graph calls), local-media upload, tiered plan-and-apply + tainted-content isolation, multi-page `profile` support, composable tool packages, honest signposting to Meta's ads MCP — position as complementary, not competitive (differentiator reorder + success metrics land in [02-market-and-positioning.md](02-market-and-positioning.md) per A14) |

## Project risks

| # | Risk | Mitigation |
|---|---|---|
| P1 | **Scope creep → abandonment** (the 200-tool precedent that archived in a month) | Phased roadmap; ~35 tools; ads package optional; Instagram/Threads explicitly out |
| P2 | **SDK v2 / spec 2026-07-28 transition** — v1 will eventually be legacy | v1 + codemod path; no Roots/Sampling/Logging dependencies; stateless-friendly design |
| P3 | **Single real-world test target** — one Page, one ad account | Recording fetch mocks from real traffic; fixtures from documented shapes; integration smoke script run manually against the live Page |
| P4 | **npm name squatting** | Name reserved at **Phase 0 exit** (C8 / A16, user gate U2), not deferred to packaging; `mcpName` registry identity independent of the npm name |

## Open questions (status after the review round)

The review round (see [../reviews/SUMMARY.md](../reviews/SUMMARY.md)) closed all
six. Each is marked **Resolved** with the decision and the deciding
cluster/document; the one residual choice (the concrete package name) is a named
user gate.

1. **Package/npm name** — scoped `@ivanbbaev/facebook-mcp`? unscoped distinct
   name? **Resolved (procedure); concrete name = user gate U2.** Naming is now a
   **Phase 0-exit** decision, not Phase 4 (C8 / A16): candidates are unscoped
   `facebook-mcp-ai` or `@ivanbbaev/facebook-mcp` (fallback), with a
   "pages"-bearing name plus a Meta brand-term check also on the table (PM);
   verify npm availability, add a trademark disclaimer, and ship
   `mcpName: io.github.IvanBBaev/...` in the **first** publish. The concrete name
   is settled at user gate **U2** (Phase 0 exit).
2. **Local media handling** — is `FB_MEDIA_DIR` allowlisting enough, or should
   local file upload be off by default (URL-only)? **Resolved (C11 / A10):**
   off by default — `FB_MEDIA_DIR` unset ⇒ local file access disabled (URL-only);
   when set, realpath containment (symlink-safe) + no cross-host redirects on
   remote fetches, and MCPB marks it sensitive (see also CC-MEDIA-4/5).
3. **Messenger polling tool vs. resource** — expose "check new messages" as a
   tool the model calls, or maintain a subscription-like resource?
   **Resolved (Arch minor / CC-MSG-5):** the v1 assumption stands — a plain
   stateless tool (caller supplies `since`, poll-based, ordering best-effort);
   the package is framed as "comment-driven private replies + within-window
   responses (polled)" (PM), `platform=messenger` is pinned (G-RUN-2), and an
   opt-in `mark_seen` is a Phase 3 decision (G-TOOL-4).
4. **Ads insights async threshold** — auto-fallback heuristics vs. explicit
   `async` parameter. **Resolved (CC-ADS-5 / A12):** not the auto-fallback
   heuristic — an explicit async **job-status tool** with terminal-state mapping
   and polling guidance, alongside the sync path (doc 11 V09). Ads is out of
   v1.0, so this lands in **1.1.0 (Phase 5)** with the rescoped read +
   status/budget-control ads package.
5. **Write journal format** — port servicenow-mcp's journal as-is or simplify?
   **Resolved (Sec #7 / C4 / G-RUN-1 / CC-LIFE-1):** simplify — structured
   metadata only, routed through the value-based redactor, `0600` under the XDG
   state dir, non-blocking (a journal failure never blocks the write), with
   ~5 MB size-based rotation (`journal.ndjson` → `journal.1.ndjson`, one
   generation). No tokens or PII.
6. **Reels/video from URL vs local file priority** — both designed; which ships
   in Phase 2 vs 3 may shift after integration testing.
   **Resolved (doc 10 §1 / doc 11 Wave 4):** all media — photos, video, Reels —
   ships in **Phase 2** (V04–V06, Phase 2 smoke gate), not split across
   Phase 2/3; URL is the default source and local files are gated behind
   `FB_MEDIA_DIR` (C11), so URL-first is the effective priority.

## Re-verify at build time — consolidated runtime-verification inventory

This is the **single complete inventory** of items that must be verified live
(not from docs). It folds in every ✎-marked corner case from
[09-corner-cases.md](09-corner-cases.md) and the ✎ tool-surface gaps from
[10-v1-release-definition.md](10-v1-release-definition.md) §2, each carrying its
phase tag. A phase gate is not passable while one of its items is unverified.

**Ambiguous / third-party items (original list):**

- **[Phase 2] Scheduled-post window** — policy decided (10 min–75 d; warn, don't
  block, above 30 d; Reels 29 d — A15 / CC-SCHED-1); confirm the live upper bound
  and any per-surface differences on the test Page.
- **[Verified] DELETE post "select developers" flag** — confirmed correct by the
  Meta specialist at v25.0 (SUMMARY verified-correct list); retained for
  traceability, no longer open.
- **[Phase 3] `CUSTOMER_FEEDBACK` tag status + Messenger changelog** — re-pull
  the messaging changelog before Phase 3 (Meta minor / CC-LIFE-5); the reference
  page 500'd during research.
- **[Phase 5 / v1.1] ASC/AAC campaign merge shape** (`smart_promotion_type`) —
  verify before building campaign-type logic; ads ships in 1.1 (doc 10 §1), so
  this lands with the ads package.
- **[Phase 2] `video_upload_limits` values** — field unconfirmed (C10); read for
  the target Page and degrade gracefully if absent.
- **[Phase 3] NPE per-field behavior** (`private_reply_conversation`,
  `visitor_posts`) — verify per-field on the real Page (R6); tolerate nulls.
- **[Phase 0] SDK v1 (1.29) spec coverage** — confirm the SDK version implements
  the 2025-11-25 features used (annotations, `structuredContent`); proven in
  servicenow-mcp, confirm the versions match.

**✎ corner cases folded in from [09-corner-cases.md](09-corner-cases.md):**

- **[Phase 2] Draft publish-state transition matrix** (CC-PUB-9) — which
  `published:false → true` (and reverse) transitions the API allows per post
  type; preview shows the current state before transition.
- **[Phase 2] Resumable upload session TTL** (CC-MEDIA-3) — measure idle-session
  expiry empirically; expiry maps to "restart the upload."
- **[Phase 1] Insights `period`/`date_preset` boundary semantics** (CC-INS-5) —
  probe partial-current-day and Page-timezone day boundaries with the doctor;
  document observed behavior rather than assuming.
- **[Phase 3] Nested comment reply depth** (CC-MOD-4) — verify reply-to-reply
  depth/flattening behavior; `list_comments` documents what the API actually
  returns.

**✎ tool-surface gaps folded in from [10-v1-release-definition.md](10-v1-release-definition.md) §2:**

- **[SHIPPED] Reels insights edge** (G-TOOL-2) — resolved as a **separate tool**:
  `facebook_reel_insights` reads `/{video-id}/video_insights`. ID-sniffing inside
  `facebook_post_insights` was rejected — the ID spaces are disjoint (bare video ID
  vs `{page-id}_{post-id}` composite), so is the metric vocabulary, and a tool that
  silently reads a different edge than its name promises is the failure mode this
  server avoids everywhere else. The edge itself is still **unverified against real
  Graph** (like every other tool — see U1/U4); fixtures only.
- **[Phase 2] Reels lifecycle** (G-TOOL-3) — confirm whether `delete_post` can
  delete a Reel by video ID and where **scheduled** Reels appear
  (`/scheduled_posts` vs `/video_reels`); `delete_post` / `list_scheduled_posts`
  descriptions must state the answer either way.
