# Stable insights schema

Meta renames and removes insights metric names on every Graph version at once,
without a version bump. There were three waves: 2024-09, 2025-11-15 and
2026-06-15 (see [analysis/03-meta-api-landscape.md](analysis/03-meta-api-landscape.md)
and [analysis/12-graph-changelog-check-2026-10.md](analysis/12-graph-changelog-check-2026-10.md)).
A caller that keys on a Graph name such as `page_impressions` breaks when Meta drops it.

The stable insights schema is the server's answer (owner decision V3-D10: it ships
in 1.0). The server owns a small map of **stable keys** (`views`, `viewers`,
`engagements`, `follows`, ...). Each key is read from one Graph metric, its
`source_metric`. Every insights result can carry a stable view next to the raw
metrics. In that view each key has a `status` of `ok`, `empty` or `removed`.

- When Meta **renames** a metric, the server changes the key's source. Callers
  see the same key.
- When Meta **removes** a metric, the key's status becomes `removed`. That is a
  status change, not a breaking change.

The code lives in [`src/api/insights-schema.ts`](../src/api/insights-schema.ts)
(task C05). It is expand-only: no tool emits the view yet. Lane L2.insights
adopts it in wave 2, as described [below](#adoption-by-l2insights).

## Stable keys (schema version 1, Graph v26.0)

Source names are the names the code reads today:

- `REPORT_DAY_METRICS`, `REACH_METRIC` and `TOP_POST_METRICS` in `src/api/page-report.ts`;
- `DEFAULT_POSTS_INSIGHTS_METRICS` in `src/api/insights-batch.ts`;
- the doctor's probe set in `src/mcp/doctor/insights.ts`;
- the reshape semantics table in `src/api/insights.ts`;
- the metric names in the `facebook_reel_insights` description.

Legacy names come from the deprecation table in `src/api/insights.ts`.

**Kind** says how the points of a key combine over a window:

- **flow**: disjoint counts, summed;
- **gauge**: a level, the latest point is the value;
- **unique**: overlapping audiences, never summed over days;
- **breakdown**: a map per point, no scalar.

### Page (`/{page-id}/insights`)

| Key | `source_metric` | Periods | Kind | Legacy names (answered as `removed`) |
|---|---|---|---|---|
| `views` | `page_media_view` | day, week, days_28 | flow | `page_impressions`, `page_impressions_organic`, `page_impressions_paid`, `page_impressions_viral`, `page_impressions_nonviral`, `page_posts_impressions` |
| `viewers` | `page_total_media_view_unique` | day, week, days_28 | unique | `page_impressions_unique`, `page_impressions_paid_unique`, `page_impressions_viral_unique`, `page_impressions_nonviral_unique`, `page_posts_impressions_unique` |
| `engagements` | `page_post_engagements` | day, week, days_28 | flow | `page_engaged_users` |
| `followers` | `page_follows` | day | gauge | `page_fans` |
| `follows` | `page_daily_follows` | day | flow | `page_fan_adds` |
| `follows_unique` | `page_daily_follows_unique` | day | flow | `page_fan_adds_unique` |
| `unfollows` | `page_daily_unfollows` ⚠ | day | flow | `page_fan_removes` |
| `unfollows_unique` | `page_daily_unfollows_unique` | day | flow | `page_fan_removes_unique` |
| `page_views` | `page_views_total` | day, week, days_28 | flow | — |
| `video_views` | `page_video_views` | day, week, days_28 | flow | `page_video_views_unique` |
| `video_view_time` | `page_video_view_time` ⚠ | day | flow | — |

### Post (`/{post-id}/insights`)

| Key | `source_metric` | Periods | Kind | Legacy names (answered as `removed`) |
|---|---|---|---|---|
| `views` | `post_media_view` | lifetime | flow | `post_impressions`, `post_impressions_organic`, `post_impressions_paid`, `post_impressions_viral`, `post_impressions_nonviral`, `post_impressions_fan` |
| `viewers` | `post_total_media_view_unique` | lifetime | unique | `post_impressions_unique`, `post_impressions_paid_unique`, `post_impressions_fan_unique`, `post_impressions_organic_unique`, `post_impressions_viral_unique`, `post_impressions_nonviral_unique` |
| `clicks` | `post_clicks` | lifetime | flow | — |
| `reactions` | `post_reactions_by_type_total` | lifetime | breakdown | — |
| `video_views` | `post_video_views` | lifetime | flow | `post_video_views_unique`, `post_video_views_organic_unique`, `post_video_views_paid_unique` |
| `video_view_time` | `post_video_view_time` | lifetime | flow | — |

### Reel (`/{video-id}/video_insights`)

| Key | `source_metric` | Periods | Kind | Legacy names |
|---|---|---|---|---|
| `plays` | `blue_reels_play_count` | lifetime | flow | — |
| `video_view_time` | `post_video_view_time` ⚠ | lifetime | flow | — |
| `avg_watch_time` | `post_video_avg_time_watched` ⚠ | lifetime | gauge | — |
| `reactions` | `post_video_likes_by_reaction_type` ⚠ | lifetime | breakdown | — |
| `social_actions` | `post_video_social_actions` ⚠ | lifetime | breakdown | — |

A Reel has `plays`, not `video_views`. `blue_reels_play_count` counts play starts,
which is a different quantity from the post edge's `post_video_views`.

### Names not confirmed live (⚠)

These rows carry `unverified: true` in the table. The projection treats them like
any other key. If Meta does not serve one of them, its status is `removed`
(reason `unavailable` or `rejected`) and nothing breaks. Confirm them in the 1.0
live pass:

- `page_daily_unfollows`: not in Meta's current Page reference; only the
  `_unique` variant is listed (doc 12, M1). The `unfollows_unique` key reads the
  listed name.
- `page_video_view_time`: in the reshape semantics table (a flow), but no default
  list reads it and the doctor does not probe it.
- The four Reel names other than `blue_reels_play_count` come from the
  `facebook_reel_insights` description, which cites Meta's reference. No
  default list or probe reads them.
- `avg_watch_time` is kind `gauge` by meaning: an average, never summed. The
  reshape table does not list it, so today its summary has a roll-up only when
  Graph returns a single lifetime point. That is the usual case on `/video_insights`.

## Entry shape and status semantics

`toStableInsights(level, read)` returns:

```ts
{
  schema_version: 1,
  level: 'page' | 'post' | 'reel',
  entries: Array<{
    key: StableMetricKey;
    value: number | null;
    source_metric: string;
    status: 'ok' | 'removed' | 'empty';
    period?: string;                                    // Graph's echoed period
    reason?: 'deprecated' | 'rejected' | 'unavailable'; // only with 'removed'
  }>,
  unmapped: string[],
}
```

The `read` argument takes `fetchInsights`' `InsightsResult` as is. The function
uses only `queriedMetrics`, `metrics`, `deprecatedMetrics`, `emptyMetrics` and
`rejectedMetrics`.

| Status | When | `value` | `source_metric` |
|---|---|---|---|
| `ok` | Graph returned the source metric with ≥ 1 data point | the summary's safe scalar (`MetricSummary.value`), or `null` when the reshape refused a roll-up (breakdown map, daily uniques over several days, non-numeric points) | the current source |
| `empty` | Graph accepted the source metric and returned no points | `null` | the current source |
| `removed`, reason `deprecated` | the caller asked for a legacy name of the key; the deprecation table dropped it before the request | `null` | the legacy name as requested (canonical form) |
| `removed`, reason `rejected` | Graph rejected the source metric by position (`metric[N]`) and the read went on without it | `null` | the current source |
| `removed`, reason `unavailable` | Graph answered the call but returned no entry for the source metric | `null` | the current source |

Rules:

- **One entry per key the request touched**, in table order, not request order.
  A key the request did not touch has no entry.
- **If both are requested, the current source wins over a legacy name.** A request
  with `page_follows` and `page_fans` gives one `followers` entry, `ok`.
- **`empty` is not `removed`.** An empty series means a valid name with no data:
  - the eligibility floor (a Page under 100 followers);
  - insights lag on a fresh post;
  - a quiet window;
  - a period the metric answers with no points.

  The raw notes explain which.
- **`unavailable` can also be a period mismatch.** Graph omits a metric/period
  pair it does not serve instead of failing the call. Each key's period list
  shows the periods the server reads it with. A caller that picks another
  period can get `removed` / `unavailable` for a metric that is still live.
- **Passthrough of unknown names.** The schema is not a whitelist. A requested
  name that feeds no key at this level stays in the raw `metrics` / `rows`
  exactly as before, and is listed in `unmapped`. This covers an unknown or new
  Meta metric, a metric of another level, and a dead name with no stable key
  (e.g. `page_fans_city`). It is never dropped and never an error.
- **Additive.** The function is pure and does not mutate its input. The raw
  `metrics`, `rows`, `deprecatedMetrics`, `unavailableMetrics`, `emptyMetrics`
  and notes stay exactly as they are today.
- **Case-insensitive.** Names are matched in Graph's canonical form (trimmed,
  lower case), the same rule as `canonicalMetricName`.

## Exported API

From `src/api/insights-schema.ts`. Frozen for wave 2 (rule 5 of the dispatch board).

| Export | Kind | Purpose |
|---|---|---|
| `INSIGHTS_SCHEMA_VERSION` | const `1` | bumped only when a key is removed or changes meaning |
| `STABLE_INSIGHTS_SCHEMA` | `readonly StableMetricDefinition[]` | the table above |
| `stableMetricsFor(level)` | function | the definitions of one level, in table order |
| `stableMetric(level, key)` | function | one definition, or `undefined` |
| `stableKeyFor(level, metric)` | function | the key a source or legacy name feeds, or `undefined` |
| `toStableInsights(level, read)` | function | the projection described above |
| `StableMetricKey`, `StableMetricLevel`, `StableMetricKind`, `StableMetricDefinition` | types | the table |
| `StableInsightStatus`, `StableRemovedReason`, `StableInsightEntry`, `StableInsightsInput`, `StableInsights` | types | the projection |

## Evolution rules

| Meta does | The server changes | Callers see |
|---|---|---|
| renames a source metric | `sourceMetric` → the new name; the old name moves to `legacyMetrics` and into the deprecation table in `insights.ts` | the same key, `ok` |
| removes a source metric with no replacement | the deprecation table first. The key stays, so requests for it show `removed` | the same key, `removed` |
| adds a new quantity worth a key | a new row (additive; no version bump) | a new key |

A key is never renamed or reused for another quantity. Doing that, or deleting a
key, bumps `INSIGHTS_SCHEMA_VERSION` and is a breaking change.

Drift guards in `src/api/insights-schema.test.ts`:

- no source metric is in the deprecation table;
- every legacy name is in the table;
- a renamed legacy name points at its key's current source;
- every metric the Page report and the posts table read has a key.

## Adoption by L2.insights

Wave 2 lane L2.insights owns `src/tools/insights.ts`, `report.ts`,
`insights-export.ts`, `src/api/insights*.ts` and `page-report.ts`. It adopts the
schema as follows. This module does not do any of it.

1. **Per-object tools** (`facebook_page_insights`, `facebook_post_insights`,
   `facebook_reel_insights`): call `toStableInsights(scope, result)` on the
   `fetchInsights` result. Emit the result as a new top-level `stable` field next
   to the existing `metrics`. Leave every existing field unchanged. Do this in
   both `series` and `aggregate` mode.
2. **`outputSchema`** (with C03): declare `stable` as optional, with the entry
   shape above. `status` is an enum of exactly `ok | removed | empty`. `reason`
   is an optional enum.
3. **Posts table** (`insights-batch.ts` / its tool): add `stable` per post row
   with level `post`. A failed row keeps its error and has no `stable`.
4. **Page report** (`page-report.ts`, `report.ts`): today the report names its
   figures with `views`, `engagement` and `pageViews`. Add the stable view for
   the current-window read under `stable` and keep the old fields. A rename of
   the old fields is a later contract step, not part of the adoption.
5. **File export** (`insights-export.ts`): unchanged. The export carries raw rows.
   The stable view rides in the inline result only.
6. **Descriptions**: state that `stable` keys are server-owned and do not change
   when Meta renames a metric. Recommend `stable` to models that compare reads
   over time. Keep `tools/list` changes inside the lane's metadata regeneration.
7. **Do not** add a request-side alias such as `metrics: ["views"]` in wave 2.
   Stable keys are output-only in schema version 1. A request-side mapping
   would be a new feature (rule 10, feature freeze).
