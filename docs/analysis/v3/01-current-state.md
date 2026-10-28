# 01 — Current state: the v2 plan vs reality

Baseline: `main` @ `d294b9e`, 2026-10-28. Source: `docs/ai/research/v3/codebase-state-audit.md`.

## 1. The roadmap inverted

The v2 corpus ([v2/05](../v2/05-roadmap-and-risks.md)) set this order:

1. contract fixes before 1.0 ([v2/01](../v2/01-fix-before-1.0.md));
2. 1.0 live-verification gate;
3. 2.0 platform migration (SDK v2, zod 4, spec 2026-07-28, Node 24);
4. features ([v2/features](../v2/features/README.md)).

What actually happened in the four days since: features first, on 0.x.

| v2 plan item | State at `d294b9e` |
|---|---|
| Feature specs F1–F14 | F3 done, F8 partial; F1, F2, F4, F6, F7, F9, F10, F11, F12 not started |
| Off-plan features | Shipped: boost-post create-chain, ad-object duplicate, ad-set targeting read/edit, moderation settings |
| 12 contract fixes before 1.0 | **None started** |
| 2.0 platform migration | **Not started.** `toJsonSchemaCompat` (`src/index.ts:33`), `zod/v4` bridge import (`:46`), `TolerantCallToolRequestSchema` (`:254`), push `elicitInput` (`:451-490`), schema converter (`:495-516`), stateful `sessionIdGenerator` (`src/mcp/transport.ts:320-322`) |
| 1.x deprecation removals | None executed. The deprecated `note` is still emitted (`moderation.ts:1291-1293`, `messages.ts:349-350`) |
| Release | 0.7.0 is the only published version (2026-08-27). 42 commits are local only |

Consequence: every item the v2 corpus placed in 1.0 or 2.0 is still open. A v3 plan that skips
them would stack a third major on two unfinished ones. The scope doc
([02](02-v3-scope.md)) therefore places each candidate in its *earliest correct* release,
not in 3.0 by default.

## 2. Contract warts still open (ranked)

The ranking runs from highest user-visible cost to lowest. Every item is cheap before 1.0 and
costs a major after it.

| # | Wart | Evidence |
|---|---|---|
| 1 | Four error-envelope shapes | `src/index.ts:612-650`; `graphErrorFields` at `src/tools/shared.ts:573`, also `posts.ts:434,454`, `core.ts:693` |
| 2 | 2.x compatibility shims (legacy SDK paths) | see §1 platform row |
| 3 | `FB_CONFIRM_TOKEN` confirm fallback | confirm seam: form elicitation → token → deny |
| 4 | Tool names without a consistent verb/noun scheme | `page/post/reel/ads insights`, `ads_report_status`, `private_reply`; `adsets` vs `ad_set`; `boost_post` takes `page_id` (`ads-create.ts:137-141`) |
| 5 | Env and token variables sprawl | `settings.ts:145-175`, `264-318` |
| 6 | Singular `note` next to `notes[]` | §1 |
| 7 | `fields` as a CSV string | `reader.ts:84-90`, `ads.ts:273-280` |
| 8 | `nextCursor: null` vs omitted | `posts.ts:2491` |
| 9 | Profile `core` collides with package `core`; read tools sit in odd packages | `packages.ts:49-56` |
| 10 | `outputSchema` on only 3 of 69 tools | `core.ts:661`, `core.ts:846`, `posts.ts:2573` |
| 11 | Annotation / tier oddities | `create_story` irreversible; `send_message` `destructiveHint`; `get_activity_since` `idempotentHint: false` |
| 12 | No `exports` map; Node floor `>=22` | `package.json` |

## 3. Measured surface

| Measure | Value |
|---|---|
| Tools | 69 (35 read / 34 write: 23 reversible, 9 irreversible, 2 spend) |
| Default profile | 53 tools, `tools/list` = 126,006 B |
| `all` profile | 69 tools, `tools/list` = 171,030 B; inputSchema is 68 % of the bytes; each insights tool ~6 KB |
| Server instructions / prompts / resources | none (`src/index.ts:203-206`) |
| In-memory state | plan store, TTL 5 min (`write-mode.ts:54,436`); upload sessions (`media-video.ts:39,843`); transport guards (`transport.ts:23-45`) |
| On-disk state | journal (0600 file, `journal.ts`) |

## 4. Files that block parallel work

Most new work touches the same handful of files today:

| File | Lines | Why it collides |
|---|---|---|
| `src/tools/posts.ts` | 2,640 | every publishing, lifecycle and queue tool |
| `src/tools/moderation.ts` | 2,447 | comments, hide/delete, private replies, blocking |
| `src/mcp/doctor.ts` | 2,424 | every package adds probes |
| `src/tools/ads.ts` | 1,709 | reads, insights, control |
| `src/mcp/setup-token.ts` | 1,651 | CLI living in the MCP layer |
| `src/index.ts` | 1,632 | bootstrap, error envelope, schema conversion, elicitation |
| `src/api/media-{photos,video,reels}.ts` | ~1.7k each | three copies of one upload state machine |
| `src/mcp/annotations.test.ts` | — | one frozen manifest row per tool: every tool change edits it |
| `CHANGELOG.md` | `[Unreleased]` spans lines 8–3048 | every task appends to the same section |

Splitting these behind facades is wave 0 of [doc 05](05-parallel-task-breakdown.md).

## 5. Gate and quality

- `npm run check`: exit 0 in 76 s, 3,147 / 3,147 tests.
- Coverage is **not** in the gate. The last lcov is from 2026-10-01 (stale).
- Open live probes: L1–L8 ([doc 12](../12-graph-changelog-check-2026-10.md)), boost P1–P7, and
  unchecked WORKLOG items.

## 6. Adoption (2026-10-28)

| Metric | Value | D1 bar (2026-11-25) |
|---|---|---|
| npm last week | 38 (floor ~45 since 09-03) | ≥ 100 |
| npm total since launch | 560 | — |
| Stars | 2 | ≥ 25 |
| Non-author issues | 0 | ≥ 3 |
| Referrers, 14 days | none | — |
| Listings | official registry (0.7.0), Glama; **missing** PulseMCP, Smithery, mcp.so, GitHub MCP registry | — |
| External PRs | #41 open: +120/−14, mergeable, unreviewed | — |

The checkpoint will be missed on every bar. V3-D1 in
[03-owner-decisions.md](03-owner-decisions.md) replaces it with a fairer gate: 30 days after
a real release plus listings.
