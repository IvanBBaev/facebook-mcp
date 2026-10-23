# v2.0 feature specs: insights and reporting

Status: research draft (2026-10-24). Graph API v26.0. Scope is code only, with no
marketing or process work.

Sources: `src/api/insights.ts` and `src/tools/insights.ts` (main at 5724988), the PR #41 diff,
`docs/analysis/v2/03-v2-scope.md` §3.1, `docs/analysis/v2/02-v1x-backlog.md` O2,
the local research note `codebase-contract-audit` (P3/F3, P6, F20), and the live Meta docs listed
in §0.

---

## 0. Verified facts (Meta docs, fetched 2026-10-24)

| Fact | Status | Consequence |
|---|---|---|
| `/{page}/insights` needs `read_insights` + `pages_read_engagement` and a Page token from a person who can do the **ANALYZE** task | documented | Same permission surface as today; no new scope |
| `page_follows` (day) | documented | Gauge (stock) |
| `page_daily_follows` (day), `page_daily_follows_unique` (day/week/days_28) | documented | Flows |
| `page_daily_unfollows_unique` (day/week/days_28) | documented | Flow |
| `page_daily_unfollows` (non-unique) | **NOT listed** in the reference. PR #41 used it live on v25 | **Live probe P-1.** Fall back to `_unique` |
| `page_media_view`, `page_total_media_view_unique`, `page_post_engagements`, `page_views_total` (day/week/days_28) | documented | `page_total_media_view_unique` is a *unique* count: daily values are **not additive** |
| `post_media_view`, `post_total_media_view_unique`, `post_reactions_by_type_total`, `post_clicks` (lifetime) | documented | Post metrics are lifetime-only in the reference |
| 2026-06-15 deprecation wave applies to all versions; deprecated metrics return an "invalid metric" error | documented | Already handled by the `DEPRECATIONS` table and the positional-drop logic |
| `/{object}/comments`: `filter=stream` (all levels, chronological), `summary=true` gives `total_count`, and reading comment ids on a Page post needs the **MODERATE** task | documented | Activity digest permission |
| `/{object}/comments` with `order=reverse_chronological` as a request param | used widely, but the param table lists only `summary` and `filter` | **Live probe P-4** |
| `/{object}/comments` `since` time filter | not documented | Use a client-side cutoff on `created_time` (no probe needed); `since` is an optional optimisation |
| Root `GET /?ids=` removed (2026-10-27, all versions) | from earlier research | Multi-object reads go through sequential calls or the Batch API only |

Existing building blocks (verified in the code):

- `stateDir()` lives in `src/core/config.ts:100`. On POSIX it is `$XDG_STATE_HOME/facebook-mcp`, falling back to `~/.local/state/facebook-mcp`. On Windows it is `%LOCALAPPDATA%` (or `%APPDATA%`) `\facebook-mcp`. `defaultJournalPath()` (`config.ts:122`) joins `stateDir()` with the journal file name. The `FB_JOURNAL_PATH` override is resolved through `resolveOperatorPath` (`src/core/settings.ts:409`, helper at `:713`). The `Journal` port is in `src/core/types.ts:764`, the implementation in `src/mcp/journal.ts`, and it is wired in the composition root `src/index.ts` (`deps.journal`, lines 157/214/283). New local state follows exactly this pattern.
- `listComments(fbRequest, {objectId, filter, order, token, signal}, page)` (`src/api/comments.ts:333`) and `COMMENT_FIELDS` (`:52`).
- `listConversations(fbRequest, {pageId, token, signal, page})` (`src/api/messaging.ts:846`). `CONVERSATION_FIELDS` already includes `updated_time,unread_count,message_count`, and `platform=messenger` is pinned.
- `listPosts(fbRequest, {pageId, edge, fields, ...})` (`src/api/posts-read.ts:696`). `POST_DETAIL_FIELDS` already uses `comments.limit(0).summary(total_count),reactions.limit(0).summary(total_count),shares`.
- `fetchPage` / `fetchAll` (`src/api/shared.ts:334/391`, `DEFAULT_MAX_PAGES = 1000`). `fetchAll` always takes an explicit small `maxPages` here.
- The taint envelope (`src/mcp/taint.ts`, `taint('message', …)`, `renderTainted`) is mandatory for comment text, commenter names and DM snippets (B1 / CC-MOD-8).
- `defineTool` enforces "`writeTier` absent ⇔ `readOnlyHint:true`" (`src/mcp/define.ts:92`).
- Fixtures: only `test/fixtures/graph-feed.json` and `graph-me.json` exist (F20). Loading uses `loadFixture(name)` (`src/testing/fixtures.ts:30`), and every fixture must pass `assertFixturesClean`. `scripts/record-fixture.mjs` writes `test/fixtures/<version>/`.

Live probes referenced below (all need a Page with ≥100 followers, a Page token with
`read_insights` + ANALYZE, MODERATE for comments, and `pages_messaging` for conversations):

| Id | Probe |
|---|---|
| **P-1** | v26.0: does `metric=page_daily_unfollows` (non-unique) still resolve, or does it give "invalid metric"? Compare it with `page_daily_unfollows_unique` over the same 14-day window |
| **P-2** | v26.0 window semantics (CC-INS-5): Page `period=day` with `since=D1&until=D2` should return exactly D2−D1 points with `end_time` = D1+1 … D2 at 07:00/08:00 UTC (PT midnight). PR #41 confirmed this live on v25. Re-run it on v26 and record a fixture |
| **P-3** | Page `period=week` / `days_28` with `until=D`: is the last point's `end_time` = D (PT), so that the latest window covers [D−7, D) or [D−28, D)? |
| **P-4** | `/{post}/comments?filter=stream&order=reverse_chronological`: is newest-first honoured together with `filter=stream`? |
| **P-5** | `/{page}/published_posts?since=<unix>&until=<unix>`: is the time filter honoured (time-based paging) or ignored? |
| **P-6** | Does a post's `updated_time` advance on a new comment? This would allow skipping posts with no new activity |

---

## F1. Insights contract v2 (breaking)

**User story.** As an agent summarising Page performance, I get one scalar per metric that I can
quote without doing arithmetic. It tells me how it was derived, and it never double-counts a stock
or a rolling window. The window boundaries are stated unambiguously.

**Tool names.** `facebook_page_insights`, `facebook_post_insights` and `facebook_reel_insights`.
If the P6 rename lands in 2.0, they become `facebook_get_page_insights`,
`facebook_get_post_insights` and `facebook_get_reel_insights`. The rename is orthogonal to this
contract: do it in the same release, but as a separate commit.

**Write tier.** Read. Annotations stay `{readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:true}`.

### Input schema (changes only)

```ts
const insightsWindowArgs = {
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe('Inclusive start boundary (YYYY-MM-DD). Range is [since, until). Page period=day uses Pacific Time.'),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe('EXCLUSIVE end boundary (YYYY-MM-DD). until=2026-08-30 includes the 2026-08-29 PT day.'),
};
// metrics: keep the 1..20 array, trim + lowercase. zod 4: replace the `.refine()` at
// tools/insights.ts:124 (comma check) with `.check()` / `z.string().regex(/^[^,]+$/)`
// per element. A per-element regex is simpler and keeps the JSON schema expressive.
// period / aggregate / max_rows: unchanged.
```

There are no new input args. The contract change is entirely in the output and in the meaning of
`until`. PR #41 already moved to `[since, until)` with `days` = boundary span.

### Output shape (v2)

```json
{
  "profile": "main",
  "pageId": "1234567890",
  "contractVersion": 2,
  "mode": "aggregate",
  "period": "day",
  "window": {
    "since": "2026-09-01",
    "until": "2026-10-01",
    "days": 30,
    "boundary": "[since, until)",
    "timezone": "America/Los_Angeles"
  },
  "queriedMetrics": ["page_follows", "page_daily_follows", "page_daily_unfollows_unique", "page_total_media_view_unique"],
  "metrics": [
    {
      "metric": "page_follows", "period": "day", "points": 30,
      "kind": "gauge", "aggregation": "latest",
      "value": 882, "firstValue": 860, "lastValue": 882, "change": 22,
      "firstEnd": "2026-09-02T07:00:00+0000", "lastEnd": "2026-10-01T07:00:00+0000",
      "aggregationNote": "Gauge/snapshot metric: value is the latest observation; summing observations would double-count the stock."
    },
    {
      "metric": "page_daily_follows", "period": "day", "points": 30,
      "kind": "flow", "aggregation": "sum", "value": 31, "firstValue": 0, "lastValue": 2,
      "firstEnd": "2026-09-02T07:00:00+0000", "lastEnd": "2026-10-01T07:00:00+0000"
    },
    {
      "metric": "page_daily_unfollows_unique", "period": "day", "points": 30,
      "kind": "flow", "aggregation": "sum", "value": 9
    },
    {
      "metric": "page_total_media_view_unique", "period": "day", "points": 30,
      "kind": "unique", "aggregation": "none", "firstValue": 210, "lastValue": 190,
      "aggregationNote": "Unique-audience metric: daily uniques overlap and are not additive. Use period=week or days_28 for a window reach."
    }
  ],
  "derived": {
    "followers": {
      "start": 860, "end": 882, "stockChange": 22,
      "follows": 31, "unfollows": 9, "unfollowsMetric": "page_daily_unfollows_unique",
      "netFlow": 22, "discrepancy": 0, "consistent": true,
      "note": "Follower stock change reconciles exactly with daily follows minus daily unfollows for the returned buckets."
    }
  },
  "rowsAvailable": 120,
  "truncated": false,
  "deprecatedMetrics": [],
  "unavailableMetrics": [],
  "emptyMetrics": [],
  "notes": ["…"]
}
```

Contract rules. These are normative and become the tool-description text and the tests.

1. `value` is the **only** recommended scalar. It is present iff `aggregation ∈ {sum, latest, latest_window, single}`.
2. `total` and `totalIsLatest` are **removed** (F3/P3). `value` + `aggregation:"sum"` replaces `total`. `aggregation:"latest"` replaces `totalIsLatest:true`.
3. `kind ∈ {flow, gauge, unique, unknown}`. **New vs PR #41:** `unique` covers every `*_unique` metric and `page_total_media_view_unique` / `post_total_media_view_unique`. Multi-point `period=day|month` unique series get `aggregation:"none"`. Multi-point `week|days_28` unique series get `latest_window`. Today these fall into `unknown`, which gives the same `none` result but a vaguer note. The explicit kind lets F2 pick the right reach strategy.
   - Correction to PR #41: `page_daily_follows_unique` and `page_daily_unfollows_unique` are in PR #41's `FLOW_METRICS` and are summed. A unique flow (a person who follows, unfollows and follows again counts once per day) *is* additive across non-overlapping days at day granularity, because each day's uniques are a per-day count. That makes the sum "follower-days", which equals net follows when nobody churns twice in one day. **Keep them as `flow`**, but give `derived.followers` an `unfollowsMetric` field so the reader knows which variant reconciled.
4. `firstValue`/`lastValue` are always present when there is ≥1 numeric scalar point. `change` is present for gauges only.
5. `window.boundary` is the literal `"[since, until)"`. `window.timezone` is `"America/Los_Angeles"` for `scope=page` and `"UTC"` for post/reel. Window-less calls on post or reel omit `window` entirely.
6. `days` is the boundary span (`until − since`). With `until` omitted, the implicit boundary is today's date in PT for a page and in UTC otherwise.
7. `derived.followers` is emitted only for page scope, and only when at least one of `page_follows` / `page_daily_follows` / `page_daily_unfollows[_unique]` was queried. The reconciliation prefers `page_daily_unfollows`. If it is absent or unavailable (P-1), it uses `page_daily_unfollows_unique` and sets `unfollowsMetric` accordingly.
8. `contractVersion: 2` is a top-level literal so clients can feature-detect.
9. Rows (series mode) are unchanged: `{metric, date, breakdown?, value}`. `date` = the calendar date of `end_time`, which is the exclusive end boundary.

### Graph calls

Unchanged: `GET /{page-id}/insights`, `GET /{post-id}/insights` and `GET /{video-id}/video_insights`
with `metric`, `period`, `since`, `until`. Permissions: `read_insights`, `pages_read_engagement`,
ANALYZE.

### Error cases and mapping

| Case | Mapping |
|---|---|
| Malformed date, or `since ≥ until` | `classifyGraphError({code:100})` → validation error before any request (`checkWindow`). **Change:** `since == until` is now a zero-bucket window under `[since,until)` and is refused ("empty window: until is exclusive") |
| Span > 90 days | Validation error (existing message, updated to say "boundary span") |
| `since` later than tomorrow (`assertWindowHasPast`) | Unchanged |
| Graph code 100 "invalid metric" | Existing positional-drop logic → `rejectedMetrics[]`, max 5 drops |
| Code 10 / 200 permission | Existing error matrix, plus the `INSIGHTS_TOKEN_EMPTY_HINT` note on empty results |
| All empty on a Page | `PAGE_ELIGIBILITY_NOTE` (the <100 followers floor) |

### Migration from today's code

`src/api/insights.ts`:

1. Port PR #41 as-is: `META_INSIGHTS_TIMEZONE`, `insightsDate()`, `PAGE_TIMEZONE_NOTE`, `FLOW_METRICS`/`GAUGE_METRICS`, `safeRollup`, the new `MetricSummary` fields, `checkWindow` exclusive `days`, the scope-aware `needsFreshnessNote`, `deriveFollowerReconciliation`, and `InsightsResult.derived`.
2. Delete `OVERLAPPING_PERIODS`, `STOCK_METRICS`, `OVERLAPPING_TOTAL_NOTE` and the `total`/`totalIsLatest` code paths. `safeRollup` now owns that logic.
3. Remove `total` from `MetricSummary` and `SafeRollup`.
4. Add `kind:'unique'` using `UNIQUE_METRICS = /_unique$|_total_media_view_unique$/`. The check runs before `FLOW_METRICS` in `metricKind`, with the exception of the two follow/unfollow unique flows (rule 3).
5. `deriveFollowerReconciliation`: fall back to `page_daily_unfollows_unique`, and add `unfollowsMetric`.
6. `InsightsWindow` gains `boundary` and `timezone`. Pass `scope` into `checkWindow`.
7. Refuse `since == until`.
8. Export `insightsDate` (F2 needs it) and the new `previousWindow(window)` helper (F2).

`src/tools/insights.ts`: PR #41's describe texts, plus "`total` removed; read `value` and `aggregation`" in all three tool descriptions. Add `contractVersion: 2` in `readInsights`. Do the zod 4 refine replacement.

`docs/analysis/06-tool-catalog.md` and `CHANGELOG.md`: add a breaking-change entry with the old → new field map.

### Tests

- `src/api/insights.test.ts`: take PR #41's tests as-is, plus the following.
  - (a) The `kind:'unique'` day series gives `aggregation:'none'`. The `days_28` series gives `latest_window`.
  - (b) Reconciliation falls back to `_unique`, and `unfollowsMetric` is set.
  - (c) `since==until` is refused.
  - (d) `window.timezone` is per scope.
  - (e) The serialised `MetricSummary` never contains a `total` / `totalIsLatest` key (a structural `Object.hasOwn` assert over every test result).
  - (f) A DST-crossing window (2026-11-01) gives `days` 30 and is not off by one. The PT end boundaries 07:00 → 08:00 UTC are both recognised.
- `src/tools/insights.test.ts`: update the PR #41 expectations, assert `contractVersion`, and run a zod 4 schema test for the comma rejection.
- Fixtures (new, recorded via P-2 then scrubbed):
  - `test/fixtures/v26.0/page-insights-follows-day.json` (page_follows + page_daily_follows + page_daily_unfollows_unique, 14 days)
  - `page-insights-reach-days28.json`
  - `post-insights-lifetime.json`
  - `reel-video-insights-lifetime.json`

  Until these are recorded, use hand-built bodies in the existing test style. The contract does not depend on live data.

**Effort:** M. Most of it is porting PR #41 and re-baselining the tests.
**Codeable now:** yes, fully, from PR #41 plus hand-built fixtures. P-1 and P-2 only confirm the fallback and the boundary note. They do not change the code shape.
**Dependencies:** none. It is a prerequisite for F2, F4 and F5.
**Breaking:** yes. `total` and `totalIsLatest` are removed, `until` becomes exclusive (behaviour change), and `since==until` is refused.

---

## F2. `facebook_get_page_report` (additive)

**User story.** "How did my Page do over the last 28 days compared with the 28 before?" One call
returns followers (stock and net flow, reconciled), reach, views, engagement and the top posts.
Each number states its derivation, and each has a period-over-period delta.

**Tool name.** `facebook_get_page_report`. **Package:** `insights`. **Tier:** read
(`readOnlyHint:true, idempotentHint:true, openWorldHint:true`). It has no `logFields` (consistent
with the insights package).

### Input schema

```ts
z.object({
  profile: profileArg,
  window: z.enum(['last_7_days', 'last_28_days', 'last_90_days', 'custom']).default('last_28_days')
    .describe('Preset windows end at today 00:00 Pacific (exclusive), so the partial current day is excluded.'),
  since: z.string().regex(DATE_RE).optional().describe('Required iff window=custom. Inclusive.'),
  until: z.string().regex(DATE_RE).optional().describe('Required iff window=custom. Exclusive.'),
  compare: z.boolean().default(true).describe('Also read the immediately preceding window of equal length.'),
  top_posts: z.number().int().min(0).max(10).default(5),
  top_by: z.enum(['engagement', 'reactions', 'comments', 'shares']).default('engagement'),
}).strict()
// cross-field: custom ⇒ since+until present, and span ≤ 90; preset ⇒ since/until absent.
// zod 4: use .superRefine or a z.discriminatedUnion on `window`. Prefer the
// discriminatedUnion: the JSON schema stays honest for MCP clients.
```

### Output shape

```json
{
  "profile": "main",
  "pageId": "1234567890",
  "contractVersion": 2,
  "window": { "since": "2026-09-26", "until": "2026-10-24", "days": 28, "boundary": "[since, until)", "timezone": "America/Los_Angeles" },
  "previousWindow": { "since": "2026-08-29", "until": "2026-09-26", "days": 28 },
  "followers": {
    "start": 860, "end": 882, "stockChange": 22,
    "follows": 31, "unfollows": 9, "netFlow": 22,
    "discrepancy": 0, "consistent": true, "unfollowsMetric": "page_daily_unfollows_unique",
    "previous": { "stockChange": 14, "netFlow": 14 },
    "delta": { "abs": 8, "pct": 57.1 }
  },
  "reach": {
    "value": 5120, "method": "rolling_window", "metric": "page_total_media_view_unique", "period": "days_28",
    "previous": 4410, "delta": { "abs": 710, "pct": 16.1 }
  },
  "views": { "value": 9840, "method": "sum", "metric": "page_media_view", "previous": 8800, "delta": { "abs": 1040, "pct": 11.8 } },
  "engagement": { "value": 612, "method": "sum", "metric": "page_post_engagements", "previous": 700, "delta": { "abs": -88, "pct": -12.6 } },
  "pageViews": { "value": 140, "method": "sum", "metric": "page_views_total", "previous": 120, "delta": { "abs": 20, "pct": 16.7 } },
  "topPosts": {
    "rankedBy": "engagement",
    "scanned": 23,
    "scanTruncated": false,
    "items": [
      {
        "postId": "1234567890_111", "createdTime": "2026-10-02T09:12:00+0000",
        "permalinkUrl": "https://www.facebook.com/…", "excerpt": "First 120 chars of the Page's own text…",
        "reactions": 140, "comments": 22, "shares": 9, "engagement": 171,
        "insights": { "post_media_view": 3100, "post_total_media_view_unique": 2400, "post_clicks": 85 }
      }
    ]
  },
  "eligible": true,
  "notes": [
    "Top posts are posts PUBLISHED in the window, ranked by lifetime counts as of now — not engagement that happened inside the window.",
    "Reach is a unique-audience count from Meta's rolling days_28 window ending at `until`; daily uniques are never summed."
  ]
}
```

Semantics:

- **Preset window:** `until = insightsDate(now)` (today PT, exclusive) and `since = until − N days`. **Previous:** `[since − N, since)`. `custom` follows the same rule with N = span. Both windows must satisfy ≤90 days and the 2-year retention, so `custom` + `compare` with a span of 90 reaches back 180 days. That is fine.
- **Followers:** `derived.followers` from F1 over `period=day`. `delta` compares `netFlow`, or `stockChange` when the flows are missing.
- **Reach:** for `last_7_days` / `last_28_days` (or a custom span of exactly 7 or 28), request `page_total_media_view_unique` with `period=week|days_28` and `since=until−1` / `until=until` → `latest_window` value (P-3), `method:"rolling_window"`. For any other span, return `{method:"unavailable", note:"…no exact reach for a N-day window; Meta exposes unique reach only as 1/7/28-day windows"}` with no value. **Never a summed or averaged daily unique.**
- **views / engagement / pageViews:** day-period flow sums (F1 `aggregation:"sum"`). `delta.pct` is `null` when `previous == 0`. All of them are omitted (with a note) when the metric is in `unavailableMetrics`/`rejectedMetrics`.
- **Top posts:** `GET /{page}/published_posts` with `fields=id,created_time,message,permalink_url,shares,comments.limit(0).summary(total_count),reactions.limit(0).summary(total_count)`, `limit=50`. A `fetchAll` with `maxPages:4` (≤200 posts) stops once `created_time < since`, because the edge is newest-first. Filter to `[since, until)` client-side. `engagement = reactions + comments + shares`. The top K then get one `GET /{post}/insights?metric=post_media_view,post_total_media_view_unique,post_clicks&period=lifetime` each, with concurrency 3 (reusing `fetchInsights`).
  - `message` is Page-authored on `published_posts`, so it is not tainted (same reasoning as `reader.ts` Reels). It is truncated to a 120-char `excerpt`.
  - If P-5 confirms that `since/until` work on `published_posts`, pass them and drop the client-side stop condition.
- **`eligible:false`** is set when every insights metric came back empty (the <100 followers floor). The top-post section still renders, because it is not insights-gated.

### Graph calls (per invocation, compare=true, top_posts=5)

| # | Method + path | Params | Permission |
|---|---|---|---|
| 1 | `GET /{page}/insights` | `metric=page_follows,page_daily_follows,page_daily_unfollows,page_daily_unfollows_unique,page_media_view,page_post_engagements,page_views_total&period=day&since&until` (current) | read_insights, pages_read_engagement, ANALYZE |
| 2 | same | previous window | same |
| 3–4 | `GET /{page}/insights` | `metric=page_total_media_view_unique&period=days_28` (or `week`), current and previous | same |
| 5..8 | `GET /{page}/published_posts` | fields above, limit 50, ≤4 pages | pages_read_engagement |
| +K | `GET /{post}/insights` | lifetime post metrics | read_insights |

Worst case is 4 + 4 + 10 = 18 GETs. All calls are sequential except the K post-insights calls.
Optional optimisation: send calls 1–4 as a single `POST /` Batch with ≤4 ops. This is rate-limit
neutral, because each op counts. Defer it until a shared `api/batch.ts` exists (see F4).

### Error cases

| Case | Mapping |
|---|---|
| Invalid window args | Validation (`code:100`) before any call |
| Insights call 1 fails (permission 10/200, token) | Whole tool fails through the error matrix. Without the current window there is no report |
| Previous-window call fails | Report returned, `previous`/`delta` omitted, note `"comparison unavailable: <code>"` |
| Reach call fails or is empty | `reach.method:"unavailable"` + note |
| `page_daily_unfollows` rejected (P-1) | Positional drop → reconciliation uses `_unique` (handled by F1) |
| `published_posts` fails | `topPosts: {error:{code,message}}`, rest of report intact |
| A single post-insights call fails | That item gets `insightsError:{code}`, no `insights` |
| AbortSignal | Propagates (`ctx.signal`) |

### Files

- `src/api/page-report.ts` (new): `buildPageReport(fbRequest, {pageId, token, window, compare, topPosts, topBy, nowMs, signal})`, with pure helpers `resolveReportWindow`, `previousWindow`, `deltaOf`, `rankPosts` and `reachPeriodFor(span)`. Its only imports come from `./insights.js`, `./posts-read.js` and `./shared.js`.
- `src/api/page-report.test.ts` (new).
- `src/api/insights.ts`: export `insightsDate` and `previousWindow` (F1).
- `src/tools/insights.ts`: add the `facebook_get_page_report` definition to `createInsightsPackage()`. Alternatively, create `src/tools/report.ts` and add it to the package's `tools` array. A new file is preferred because `insights.ts` is already 456 lines.
- `src/tools/report.test.ts` (new).
- `docs/analysis/06-tool-catalog.md` and the `CHANGELOG.md` entry.

### Tests

- Pure tests:
  - Window resolution with a fixed clock, including a PT date boundary: 2026-10-24T05:00Z is still 2026-10-23 PT.
  - Previous-window arithmetic.
  - `deltaOf` with zero/negative values and `pct:null`.
  - `reachPeriodFor` (7 → week, 28 → days_28, 30 → unavailable).
  - `rankPosts` tie-break on `createdTime` desc, then `postId`.
- Tool tests with `withFetch` routing by path and params:
  - The happy path asserts the call count (≤18) and that the reach is never summed.
  - Previous-window failure degrades the report.
  - `published_posts` failure isolates the top-posts section.
  - A post-insights error appears per item.
  - All-empty gives `eligible:false`.
  - The `published_posts` walk stops at `since`, and the walk is not truncated by `maxPages` before that.
  - The serialised result contains no paging or token data.
- Fixtures: reuse the F1 page fixtures, plus a new `test/fixtures/v26.0/published-posts-with-counts.json`. Hand-built is acceptable until it is recorded.

**Effort:** M.
**Codeable now:** yes. Live probes P-3 (rolling-window `end_time` alignment) and P-5 (`published_posts` time filter) only tune the reach-window params and remove the client-side stop. Both have safe defaults.
**Dependencies:** F1 (`kind`, `value`, `derived.followers`, `insightsDate`).
**Breaking:** no, it is additive.

---

## F3. `facebook_get_activity_since` (additive)

**User story.** "What happened on my Page since I last looked?" The tool returns new comments
across recent posts and conversations with unread or new messages. It remembers where I stopped,
so the next call returns only what is new.

**Tool name.** `facebook_get_activity_since`. **Package:** `messages`. It spans comments and
conversations, and that package is already the inbox surface. If the comments reads live in
`moderation`, register the tool there and document the cross-package read. **Tier:** read with
respect to Facebook. Annotations are `{readOnlyHint:true, destructiveHint:false,
idempotentHint:false, openWorldHint:true}`. `idempotentHint:false` is set because advancing the
local high-water mark changes what the next call returns. The local cursor file is not a Graph
write, so the tool gets no plan-and-apply. `defineTool` accepts it (no `writeTier` ⇔ read-only).

### Input schema

```ts
z.object({
  profile: profileArg,
  since: z.string().datetime({ offset: true }).optional()
    .describe('ISO-8601 instant. Omitted ⇒ the stored high-water mark for this Page; none stored ⇒ now − 24h.'),
  posts: z.number().int().min(1).max(25).default(10)
    .describe('How many most-recent published posts to scan for new comments.'),
  max_comments: z.number().int().min(1).max(100).default(50),
  include_comments: z.boolean().default(true),
  include_conversations: z.boolean().default(true),
  mark_seen: z.boolean().default(true)
    .describe('Advance the local high-water mark to this read\'s horizon. false ⇒ peek without moving it.'),
}).strict()
```

### Output shape

```json
{
  "profile": "main",
  "pageId": "1234567890",
  "since": "2026-10-23T08:00:00.000Z",
  "sinceSource": "stored",
  "horizon": "2026-10-24T09:30:00.000Z",
  "markSeen": "advanced",
  "comments": {
    "count": 3,
    "postsScanned": 10,
    "truncated": false,
    "items": [
      {
        "commentId": "111_222", "postId": "1234567890_111",
        "createdTime": "2026-10-24T07:10:00+0000", "isReply": false, "parentId": null,
        "likeCount": 0, "commentCount": 0, "isHidden": false, "canReplyPrivately": true,
        "permalinkUrl": "https://www.facebook.com/…",
        "untrusted": "⟦BEGIN UNTRUSTED CONTENT⟧ …from.name + message… ⟦END UNTRUSTED CONTENT⟧"
      }
    ]
  },
  "conversations": {
    "count": 2,
    "unreadTotal": 3,
    "truncated": false,
    "items": [
      { "conversationId": "t_123", "updatedTime": "2026-10-24T06:00:00+0000", "unreadCount": 2, "messageCount": 14, "canReply": true,
        "untrusted": "⟦BEGIN UNTRUSTED CONTENT⟧ …participants + snippet… ⟦END UNTRUSTED CONTENT⟧" }
    ]
  },
  "notes": ["Comments are scanned on the 10 most recent published posts only; older posts with new comments are not covered."]
}
```

Fields:

- `sinceSource ∈ {argument, stored, default_24h}`.
- `markSeen ∈ {advanced, skipped, not_requested, failed}`.
- A section that was excluded is omitted. A section that failed is replaced by `{error:{code, message, hint}}`.

### Semantics

- `horizon` = `ctx.clock.now()` captured **before** the first request. Items are kept iff `since < created_time ≤ horizon` (or `updated_time` for conversations). The next call's stored `since` is `horizon`, so nothing that arrives during the scan is skipped. Duplicate exclusion relies on the strict `>`.
- If a section was truncated (budget hit), the mark for that section is **not** advanced past the oldest item that was not covered. The store keeps per-section marks for exactly this reason: `{commentsSeenAt, conversationsSeenAt}`. When a section is truncated, its mark is set to the `created_time` of the newest item *not* returned, minus 1 ms. Simpler rule: on truncation, do not advance that section and add a note saying so.
- **Comments:**
  - The scan reads `listPosts` (`published_posts`, `fields=id,created_time,updated_time,permalink_url`, `limit=posts`).
  - For each post, `listComments({filter:'stream', order:'reverse_chronological'})` runs page by page with `limit=25` and stops at the first `created_time ≤ since` (P-4). If P-4 shows that the order is not honoured, the code reads chronologically and keeps a bounded tail of ≤3 pages per post, flagging `truncated`.
  - Concurrency is 3 posts. The global budget is `max_comments` and a 30-call hard cap.
  - If P-6 holds, posts with `updated_time ≤ since` are skipped without a comments call.
- **Conversations:** `listConversations` returns pages newest-updated first. The walk stops at the first `updated_time ≤ since`. An item is included when `updated_time > since` **or** `unread_count > 0`. Unread conversations older than `since` are therefore still surfaced, at most `max_comments` of them. The walk is capped at 3 pages.
- **Taint:** each comment's `from.name` + `message`, and each conversation's `participants` + `snippet`, are wrapped in one envelope per item (`taint('comment'|'message', …)` → `renderTainted`). This is the same pattern as `src/tools/messages.ts:205-212`. Ids, timestamps and counts stay outside the envelope.

### Local state (high-water mark)

- Path: the new setting `FB_ACTIVITY_STATE_PATH`, resolved with `resolveOperatorPath` exactly like `FB_JOURNAL_PATH` (`settings.ts:409`). The default is `join(stateDir(), 'activity-state.json')`, using a new `defaultActivityStatePath()` in `src/core/config.ts` next to `defaultJournalPath()`.
- Format:

  ```json
  { "version": 1, "pages": { "<pageId>": { "commentsSeenAt": "<ISO>", "conversationsSeenAt": "<ISO>", "updatedAt": "<ISO>" } } }
  ```

  The file holds no tokens and no UGC. Page ids only.
- Write: mode `0600`. The file is written to a temp file in the same directory and then renamed (atomic). The directory is created with mode `0700` if missing, which matches what the journal does. Reuse `describeFileProtection` (`config.ts:328`) for the Windows caveat.
- Port: `ActivityCursorStore { get(pageId): Promise<ActivityMarks|undefined>; set(pageId, marks): Promise<'ok'|'failed'> }`, defined in `src/core/types.ts` next to `Journal`. It **never throws**, because a state failure must not fail a read. The implementation is `src/mcp/activity-state.ts`. It is injected as `ToolContext.activityState` (a new optional field) in `src/index.ts`, next to `deps.journal`, and `ctx` exposes it to tools without breaking the layering (tools → mcp is allowed; core only defines the port).
- A corrupt or unreadable file is treated as "no stored mark" (`sinceSource:"default_24h"`) with a note. Writes then overwrite it with a valid file.
- `facebook_doctor` (`src/mcp/doctor.ts`) should list the path and its protection, as it does for the journal.

### Graph calls

| Method + path | Params | Permission |
|---|---|---|
| `GET /{page}/published_posts` | `fields=id,created_time,updated_time,permalink_url&limit=N` | pages_read_engagement |
| `GET /{post}/comments` | `filter=stream&order=reverse_chronological&fields=COMMENT_FIELDS&limit=25` | pages_read_engagement, pages_read_user_content, **MODERATE** task |
| `GET /{page}/conversations` | `platform=messenger&fields=CONVERSATION_FIELDS` | pages_messaging, MODERATE task |

### Error cases

| Case | Mapping |
|---|---|
| `since` in the future, or more than 90 days back | Validation `code:100`. The 90-day guard keeps scans bounded |
| Permission error on conversations (no `pages_messaging`) | `conversations:{error}` with the error-matrix hint. The comments section is still returned and the comments mark still advances |
| Permission error on comments for one post | Counted in `comments.postErrors`. If every post errors, the result is `comments:{error}` |
| `published_posts` fails | `comments:{error}` |
| Both sections fail | The tool throws the first `GraphApiError` (matrix-mapped), and nothing is advanced |
| State read failure | Note, `default_24h` |
| State write failure | `markSeen:"failed"` + note. The result is still returned |
| Abort | Propagates. Marks are not advanced |

### Files

- `src/api/activity.ts` (new): `collectActivity(fbRequest, {pageId, token, since, horizon, posts, maxComments, include*, signal})` returns the raw normalised sections and a per-section `complete` flag. The cutoff and budget logic is pure.
- `src/api/activity.test.ts` (new).
- `src/core/types.ts`: the `ActivityMarks` and `ActivityCursorStore` port, and `ToolContext.activityState?`.
- `src/core/config.ts`: `defaultActivityStatePath()`. `src/core/settings.ts`: the `FB_ACTIVITY_STATE_PATH` key (allow-list at `:154-162` + resolution).
- `src/mcp/activity-state.ts` (new) and `src/mcp/activity-state.test.ts` (new): covers atomic write, 0600 mode, corrupt-file recovery and never-throw behaviour.
- `src/index.ts`: construct and inject the store.
- `src/mcp/doctor.ts`: report the path.
- `src/tools/messages.ts`: the `facebook_get_activity_since` definition, with taint rendering. Alternatively, create `src/tools/activity.ts` and add it to `createMessagesPackage().tools`. `src/tools/activity.test.ts` (new).
- `src/core/fakes/`: an in-memory `ActivityCursorStore` fake for the tool tests.
- `README.md` env table, `CHANGELOG.md` and `docs/analysis/06-tool-catalog.md`.

### Tests

- Cutoff:
  - The strict `>` on `since` and `≤ horizon`.
  - An item that arrives mid-scan (`created_time > horizon`) is excluded and caught by the next call.
- Section behaviour:
  - Comments stop at the first older item (proved by asserting that no second page is requested).
  - A conversation with unread messages that is older than `since` is still included.
  - Each section's budget, the truncated flag, and the rule that a truncated section does not advance its mark.
- Marks:
  - `mark_seen:false` leaves the store untouched.
  - A per-section error advances only the healthy section's mark.
- Store:
  - Corrupt-file recovery.
  - Mode 0600 on POSIX.
  - The Windows path comes from `PathOptions` (mirror the existing `config.test.ts` cases).
- Every comment message and name is inside the taint delimiters. Also run a negative test with UGC that contains the delimiter text.
- A fake clock is used everywhere. `Date.now()` is never consulted.
- Fixtures:
  - New `test/fixtures/v26.0/post-comments-stream-desc.json` and `page-conversations.json`. Both contain UGC, so they need scrubbing and `assertNoSecrets`. Hand-built fixtures are acceptable first.
  - `graph-feed.json` can seed the posts list.

**Effort:** M. The API and tool are S–M. The state store, setting and wiring add the rest.
**Codeable now:** yes. **Live probes:** P-4 (`order=reverse_chronological` with `filter=stream`) and P-6 (`updated_time` bump). Both have coded fallbacks: a bounded chronological tail, and no skip optimisation.
**Dependencies:** none hard. It reuses the existing comments, messaging and posts-read APIs. If the messaging spec changes `listConversations`, this tool follows.
**Breaking:** no. It adds a new tool, a new optional env var and a new optional ctx field.

---

## F4. `facebook_get_posts_insights`: batch post-level insights (additive)

**User story.** "Compare views, reach, clicks and reactions for my last 10 posts." Today this takes
10 `facebook_post_insights` calls, each with a full envelope. Ten envelopes burn the result budget
and the model's turn count.

**Tool name.** `facebook_get_posts_insights`. **Package:** `insights`. **Tier:** read (`idempotentHint:true`).

### Input schema

```ts
z.object({
  profile: profileArg,
  post_ids: z.array(z.string().regex(/^\d+_\d+$/)).min(1).max(25).optional(),
  latest: z.number().int().min(1).max(25).optional()
    .describe('Instead of post_ids: the N most recent published posts.'),
  metrics: z.array(metricName).min(1).max(10)
    .default(['post_media_view', 'post_total_media_view_unique', 'post_clicks', 'post_reactions_by_type_total']),
}).strict()   // exactly one of post_ids | latest (discriminated union in zod 4)
```

### Output shape (a compact table, one row per post)

```json
{
  "profile": "main", "pageId": "1234567890", "contractVersion": 2, "period": "lifetime",
  "columns": ["post_media_view", "post_total_media_view_unique", "post_clicks", "post_reactions_by_type_total"],
  "posts": [
    { "postId": "1234567890_111", "createdTime": "2026-10-02T09:12:00+0000",
      "values": { "post_media_view": 3100, "post_total_media_view_unique": 2400, "post_clicks": 85 },
      "breakdowns": { "post_reactions_by_type_total": { "like": 120, "love": 15, "wow": 5 } } },
    { "postId": "1234567890_112", "error": { "code": 100, "message": "Unsupported get request", "hint": "…" } }
  ],
  "deprecatedMetrics": [], "rejectedMetrics": [], "emptyMetrics": [],
  "notes": ["Post metrics are lifetime and lag minutes to hours after publishing."]
}
```

- `values[metric]` = F1's `value` (`aggregation` is `single` or `latest`).
- Breakdown metrics go under `breakdowns`, unaggregated (F1 rule).
- Metric vetting (deprecations, positional drops) runs **once**, on the first post. The vetted list is reused for the rest, so a bad metric costs 1 call and not N.

### Graph calls

`GET /{post}/insights?metric=…&period=lifetime` per post, with concurrency 3 (read_insights +
ANALYZE). With `latest`, add one `GET /{page}/published_posts?fields=id,created_time&limit=N`. Each
`post_id` is checked to belong to the resolved Page (reuse `assertPostOnResolvedPage` from
`tools/insights.ts`).

The Batch API alternative is `POST /` with `batch=[{method:GET, relative_url:"{post}/insights?metric=…"}]`
for ≤25 ops, which is one HTTP round trip. Rate-limit cost is the same, because each op counts. It
needs a new `src/api/batch.ts` (it parses per-op `{code, body}`, and each op body goes through the
same GraphApiError classification). Recommendation: **ship with sequential calls at concurrency 3
first.** Add `batch.ts` later as a transport swap behind the same function, so the output stays
unchanged. The "Codeable now" line covers this.

### Error cases

| Case | Mapping |
|---|---|
| Neither or both of `post_ids`/`latest` given | Validation |
| Post not on the resolved Page | That row gets `error` (validation code). This differs from `post_insights`, which throws, because one bad id should not sink 24 good ones |
| Per-post Graph error | Row `error` via `classifyGraphError` + matrix hint |
| Every row errors | Throw the first error |
| Metric rejected on the first post | `rejectedMetrics`, and it is removed for the rest |

### Files

- `src/api/insights.ts`: export a small `fetchInsightsMany(fbRequest, {objectIds, metrics, scope:'post', token, nowMs, signal, concurrency})` that wraps `fetchInsights` and implements vet-once. Alternatively, create `src/api/insights-batch.ts` (new) to keep `insights.ts` from growing past 1500 lines. The new file is preferred.
- `src/api/insights-batch.test.ts` (new).
- `src/tools/insights.ts`: the tool definition, or put it in `src/tools/report.ts` next to F2. `src/tools/insights.test.ts` gains the matching tests.
- Optional later: `src/api/batch.ts` + `batch.test.ts`.

### Tests

- Vet-once: the second and later requests carry the reduced metric list.
- A per-row error is isolated.
- A foreign-Page id becomes a row error.
- `latest` resolves through `published_posts`.
- Concurrency is bounded (the fake fetch counts in-flight requests).
- Lifetime `value` comes out as `single`.
- Fixtures: `post-insights-lifetime.json` from F1, plus a hand-built error body.

**Effort:** S (sequential). With `batch.ts` it is M.
**Codeable now:** yes. **Live probe:** only for the optional Batch transport (per-op error body shape on v26.0, and whether `relative_url` accepts `/insights` with a Page token in the top-level `access_token`).
**Dependencies:** F1. F2 can reuse `fetchInsightsMany` for its top-K step.
**Breaking:** no, it is additive.

---

## F5. File export for insights results (additive, lower priority)

**User story.** "Give me 90 days × 12 metrics daily as a CSV." That is about 1,080 rows, well past
`INSIGHTS_MAX_ROWS=250` and `FB_MAX_RESULT_CHARS≈25k`, so today the series is truncated. Writing the
full series to a local file and returning only the path and a summary removes that ceiling without
growing the model context.

**Tool surface.** There is no new tool. Add an optional `output` arg to `facebook_page_insights`,
`facebook_post_insights`, `facebook_reel_insights` and `facebook_get_posts_insights`:

```ts
output: z.object({
  format: z.enum(['csv', 'json']),
  file_name: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/).optional(),
}).strict().optional()
```

When `output` is given, the row cap does not apply to the file. The inline result is the normal
`aggregate`-mode summary plus `export: {path, format, rows, bytes, sha256}`. CSV columns are
`metric,date,end_time,breakdown,value`, with RFC 4180 quoting. Formula-injection guard: prefix
`'` to any cell starting with `= + - @`. Insights values are numbers and metric names, but
breakdown keys can be arbitrary.

**Tier.** It writes a local file, not Graph. The tools stay `readOnlyHint:true`, which matches the
"environment = Facebook" reading the codebase already uses for the journal. The file goes only
into `FB_EXPORT_DIR` (new, resolved via `resolveOperatorPath`, default `join(stateDir(), 'exports')`,
mode 0700 dir / 0600 file). `file_name` cannot contain path separators. The default name is
`<scope>-<objectId>-<since>-<until>-<timestamp>.<ext>`. No overwrite: on a name collision, a
suffix is appended.

**Graph calls.** These are the same calls as today. A 90-day window per request means that a full
export of a wider span is the caller's job (slices).

**Errors.** If the export dir is unwritable, the tool throws a validation-class error with a hint
naming `FB_EXPORT_DIR`. Nothing is written partially, because the file is written atomically.

**Files.**
- `src/core/config.ts`: `defaultExportDir()`. `src/core/settings.ts`: `FB_EXPORT_DIR`.
- `src/mcp/export-file.ts` (new): an atomic writer, a CSV encoder and the injection guard. Tools may import mcp.
- `src/mcp/export-file.test.ts` (new).
- `src/tools/insights.ts`: the arg and its wiring. `src/tools/insights.test.ts`: export tests through a temp dir (`withEnv`).

**Tests.**
- The CSV escaping and formula guard.
- Atomic write, 0600 mode, and no overwrite.
- The cap is bypassed for the file only.
- The inline result stays in aggregate mode and has no rows.
- Path traversal in `file_name` is rejected by the schema.

**Effort:** S–M. **Codeable now:** yes, there is no Graph dependency. **Dependencies:** F1, for the
row and summary shape. **Breaking:** no.

Justification for its lower priority: it is the only way to get a full-resolution 90-day series
through the 25k budget. It overlaps, though, with a client that can call the tool in slices, and
it adds a second local write path. Ship it after F1–F4.

---

## Considered and rejected

- **Demographic and "fans by city/country" reports.** These metrics were removed in the 2024–2026 waves. Nothing is left to build on.
- **A Reels report.** `video_insights` metrics (`blue_reels_play_count`, `post_video_avg_time_watched`, …) are lifetime per Reel. `facebook_get_posts_insights` with a `scope:'reel'` variant (video ids, `/video_insights`) covers it. It is a candidate for a v2.1 option on F4, not a separate tool.
- **Server-side scheduled digests.** These need a long-running process and a delivery channel, which is outside an MCP stdio server.

## Summary table

| Id | Tool | Effort | Codeable now | Live probes | Depends on | Breaking |
|---|---|---|---|---|---|---|
| F1 | Insights contract v2 (3 existing tools) | M | Yes | P-1, P-2 (confirmatory) | none | **Yes** |
| F2 | `facebook_get_page_report` | M | Yes | P-3, P-5 (tuning) | F1 | No |
| F3 | `facebook_get_activity_since` | M | Yes | P-4, P-6 (fallbacks coded) | none | No |
| F4 | `facebook_get_posts_insights` | S (M with Batch) | Yes (sequential) | Batch per-op shape (optional) | F1 | No |
| F5 | `output:{format}` file export | S–M | Yes | none | F1 | No |
