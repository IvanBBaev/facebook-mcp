// Insights tools of the `ads` package: the sync-first insights read with its
// async fallback, and the one-shot probe of an async report run.

import { z } from 'zod';

import {
  ADS_INSIGHTS_MAX_ROWS,
  REPORT_RUN_TTL_DAYS,
  fetchAdsInsights,
  fetchReportResults,
  getReportRunStatus,
  resolveAdAccountId,
} from '../../api/ads-read.js';
import { defineTool } from '../../mcp/index.js';
import { afterArg, limitArg, shapeFor } from '../shared.js';
import { adAccountIdArg, signalOf } from '../ads-shared.js';
import { READ_ONLY, fieldsArg, objectIdArg } from './common.js';

// ---------------------------------------------------------------------------
// Input fields
// ---------------------------------------------------------------------------

const insightsLevelArg = z
  .enum(['account', 'campaign', 'adset', 'ad'])
  .optional()
  .describe(
    'Aggregation level Graph reports at — one row per object of that level under the requested id. Omitted ⇒ Graph aggregates at the level of the id itself.',
  );

const datePresetArg = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    'Graph date preset, e.g. "today", "yesterday", "last_7d", "last_30d", "this_month". Ignored when both `since` and `until` are given.',
  );

const sinceArg = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    'Window start as "YYYY-MM-DD" (inclusive, ad-account timezone). Must be paired with `until` and may not be after it — a lone end, a reversed window or a date in any other form is rejected before the request. No per-call span cap: totals reach back up to 37 months, but unique-count fields (possibly `reach`) and hourly breakdowns only 13 months and frequency breakdowns only 6.',
  );

const untilArg = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    'Window end as "YYYY-MM-DD" (inclusive). Must be paired with `since`. Attribution lags, so the last day or two of any window is still moving.',
  );

const breakdownsArg = z
  .array(z.string().trim().min(1))
  .min(1)
  .max(4)
  .optional()
  .describe(
    'Graph breakdown dimensions, e.g. ["age","gender"] or ["publisher_platform"]. Each breakdown MULTIPLIES the row count, which is the fastest way to hit the row cap or to push the query onto the async path — add them one at a time.',
  );

const timeIncrementArg = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    'Row granularity: "1" for a daily series, "all_days" for a single aggregate row, or a number of days. Use "all_days" when you only need totals — it is the cheapest way to stay inside the result budget.',
  );

const maxRowsArg = z
  .number()
  .int()
  .min(1)
  .max(ADS_INSIGHTS_MAX_ROWS)
  .optional()
  .describe(
    `Lower the row cap for this call (1-${String(ADS_INSIGHTS_MAX_ROWS)}; the default and the ceiling are both ${String(ADS_INSIGHTS_MAX_ROWS)} — this argument can only shrink it). Rows past the cap are dropped and the result says so.`,
  );

const forceAsyncArg = z
  .boolean()
  .optional()
  .describe(
    'True ⇒ skip the synchronous attempt and start an async report run immediately. Use it when a query already failed as too large. The call returns a report_run_id and NO rows — it never waits for the run.',
  );

const reportRunIdArg = z
  .string()
  .trim()
  .min(1)
  .regex(
    /^[0-9]+$/,
    'Expected the numeric `reportRunId` returned by facebook_ads_insights when it fell back to the async path.',
  )
  .describe(
    `The async run to probe, as returned by facebook_ads_insights (\`reportRunId\`). Ids resolve for about ${String(REPORT_RUN_TTL_DAYS)} days.`,
  );

const fetchResultsArg = z
  .boolean()
  .optional()
  .describe(
    'True ⇒ also read the rows when (and only when) the run has completed. On an unfinished run nothing is read and the phase is reported instead, because an unfinished run answers with an EMPTY page that is indistinguishable from "this query genuinely has no data".',
  );

/**
 * Build the two insights tools. Called once per `createAdsPackage()` so every
 * package instance gets its own tool objects, exactly as before the split.
 */
export function createInsightsTools() {
  const adsInsights = defineTool({
    name: 'facebook_ads_insights',
    title: 'Ads Insights',
    description:
      'Read performance numbers (impressions, clicks, spend, reach, cpc, ctr) for ' +
      'an ad account, campaign, ad set or ad. The call is tried SYNCHRONOUSLY ' +
      'first; when Graph refuses the query for being too large, an async report ' +
      'run is started automatically and the result comes back with mode:"async" ' +
      'and a `reportRunId` and NO rows — poll it with facebook_ads_report_status ' +
      'rather than retrying this tool. Windows are either a `date_preset` or a ' +
      'since/until pair (both or neither). Breakdowns multiply rows, so add them ' +
      'one at a time; use time_increment:"all_days" for totals. Empty rows with no ' +
      '`nextCursor` mean the object did not deliver in the window — that is data, ' +
      'not an error; an empty page that still has a `nextCursor` means more pages ' +
      'follow. Money metrics (spend, cpc, cpm, cost_per_*) are decimal amounts in ' +
      "the row's `account_currency`, not minor units. Attribution lags leave the " +
      'last day or two incomplete.',
    inputSchema: z.object({
      ad_account_id: adAccountIdArg,
      object_id: objectIdArg.optional(),
      level: insightsLevelArg,
      fields: fieldsArg,
      date_preset: datePresetArg,
      since: sinceArg,
      until: untilArg,
      breakdowns: breakdownsArg,
      time_increment: timeIncrementArg,
      limit: limitArg,
      after: afterArg,
      max_rows: maxRowsArg,
      force_async: forceAsyncArg,
    }),
    // READ_ONLY despite the async escape hatch issuing a POST. `readOnlyHint`
    // is about the caller's assets, and a report run changes none of them: it
    // creates a short-lived server-side result set that expires on its own
    // (REPORT_RUN_TTL_DAYS) and is the only way Graph will answer a query it
    // refuses synchronously. Giving this tool a write tier instead would gate
    // large insights queries behind FB_WRITE_MODE and make a read-only server
    // unable to read — the opposite of what the tier protects.
    annotations: READ_ONLY,
    // The one read in this package that earns a line on stderr. Insights is the
    // throttled edge (ADS_RATE_LIMIT_NOTE) and the only read that can leave
    // server-side state behind, since the async escape hatch POSTs a report run.
    // An operator looking at a rate-limit wall needs the SHAPE of the query that
    // built it: which object, at which level, over which window, and whether the
    // model forced the async path. `fields` is a caller-composed field list,
    // `breakdowns` an array the projection can only render as "[array]", and
    // `after` an opaque cursor — none of them is evidence.
    logFields: [
      'ad_account_id',
      'object_id',
      'level',
      'date_preset',
      'since',
      'until',
      'force_async',
    ],
    handler: async (input, ctx) => {
      // No object_id ⇒ account-level insights, which is the question most people
      // mean by "how are the ads doing".
      const objectId =
        input.object_id ??
        resolveAdAccountId(input.ad_account_id, ctx.settings.adAccountId);
      const result = await fetchAdsInsights(ctx.fbRequest, {
        objectId,
        ...(input.level !== undefined ? { level: input.level } : {}),
        ...(input.fields !== undefined ? { fields: input.fields } : {}),
        ...(input.date_preset !== undefined ? { datePreset: input.date_preset } : {}),
        ...(input.since !== undefined ? { since: input.since } : {}),
        ...(input.until !== undefined ? { until: input.until } : {}),
        ...(input.breakdowns !== undefined ? { breakdowns: input.breakdowns } : {}),
        ...(input.time_increment !== undefined
          ? { timeIncrement: input.time_increment }
          : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.after !== undefined ? { after: input.after } : {}),
        ...(input.max_rows !== undefined ? { maxRows: input.max_rows } : {}),
        ...(input.force_async !== undefined ? { forceAsync: input.force_async } : {}),
        ...signalOf(ctx),
      });
      return shapeFor(ctx, result);
    },
  });

  // No `logFields` on the poll below: the report run it polls was already
  // recorded by facebook_ads_insights when it started one, and a
  // `report_run_id` repeated every few seconds is volume, not evidence.
  const reportStatus = defineTool({
    name: 'facebook_ads_report_status',
    title: 'Ads Report Status',
    description:
      'Probe one async insights report run and, with fetch_results:true, read its ' +
      'rows once it has completed. One call, one answer: this tool NEVER sleeps ' +
      'and never loops — the result says which phase the run is in (pending, ' +
      'running, complete, failed, skipped), how far along it is, and when to stop ' +
      'polling. Wait about 10s between probes and give up after ~15 minutes ' +
      'without progress: very large runs can hang indefinitely and there is no ' +
      'cancel API, so the way out is a narrower run, not more polling. A FAILED ' +
      'or SKIPPED run produced nothing — start a new one instead of re-probing; ' +
      'when Meta stated why, `failure` carries its reason, code and subcode.',
    inputSchema: z.object({
      report_run_id: reportRunIdArg,
      fetch_results: fetchResultsArg,
      limit: limitArg,
      after: afterArg,
      max_rows: maxRowsArg,
    }),
    annotations: READ_ONLY,
    handler: async (input, ctx) => {
      const status = await getReportRunStatus(ctx.fbRequest, {
        reportRunId: input.report_run_id,
        // The injected clock, never Date.now(): the run's age and the stall
        // verdict both depend on "now" and must stay testable.
        nowMs: ctx.clock.now(),
        // Meta's failure reason is redacted BEFORE it is capped, so a secret the
        // cap would cut in half is still recognised and scrubbed whole.
        redactString: (s) => ctx.redactor.redactString(s),
        ...signalOf(ctx),
      });

      if (input.fetch_results !== true) return shapeFor(ctx, status);

      if (!status.resultsReady) {
        return shapeFor(ctx, {
          ...status,
          rowsRead: false,
          // Spelled out because an unfinished run answers with an empty page,
          // which a model otherwise reads as "the campaign got nothing".
          note: `fetch_results was requested but the run is ${status.phase}, so NO rows were read. An unfinished run returns an empty page that looks exactly like a query with no data — probe again once the phase is "complete".`,
        });
      }

      const results = await fetchReportResults(ctx.fbRequest, {
        reportRunId: input.report_run_id,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.after !== undefined ? { after: input.after } : {}),
        ...(input.max_rows !== undefined ? { maxRows: input.max_rows } : {}),
        ...signalOf(ctx),
      });
      return shapeFor(ctx, { ...status, rowsRead: true, ...results });
    },
  });

  return { adsInsights, reportStatus };
}
