// facebook_get_page_report (v2 insights F2) — the one-call Page report in the
// `insights` package. The api module (`../api/page-report.js`) owns every read,
// the derivations and the failure isolation; this module owns the schema, the
// model-facing prose and the result shaping.
//
// The cross-field window rules (custom ⇒ since + until; preset ⇒ neither) are
// checked by `resolveReportWindow`, not by a zod refine: the input stays a plain
// object schema, and the error text is the api module's single actionable one.

import { z } from 'zod';

import type { ToolAnnotations, ToolSpec } from '../core/index.js';
import { INSIGHTS_CONTRACT_VERSION } from '../api/insights.js';
import {
  DEFAULT_REPORT_WINDOW,
  DEFAULT_TOP_POSTS,
  MAX_TOP_POSTS,
  REPORT_WINDOWS,
  TOP_POST_RANKINGS,
  buildPageReport,
  resolveReportWindow,
} from '../api/page-report.js';
import { defineTool } from '../mcp/index.js';
import { profileArg, shapeFor } from './shared.js';

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const pageReportArgs = {
  profile: profileArg,
  window: z
    .enum(REPORT_WINDOWS)
    .default(DEFAULT_REPORT_WINDOW)
    .describe(
      'Preset windows end at today 00:00 Pacific (exclusive), so the partial current day is excluded. "custom" needs since + until.',
    ),
  since: z
    .string()
    .regex(DATE_RE, 'Use YYYY-MM-DD.')
    .optional()
    .describe('Only with window "custom" (required there). Inclusive, YYYY-MM-DD.'),
  until: z
    .string()
    .regex(DATE_RE, 'Use YYYY-MM-DD.')
    .optional()
    .describe(
      'Only with window "custom" (required there). Exclusive, YYYY-MM-DD; span ≤ 90 days.',
    ),
  compare: z
    .boolean()
    .default(true)
    .describe('Also read the immediately preceding window of equal length.'),
  top_posts: z
    .number()
    .int()
    .min(0)
    .max(MAX_TOP_POSTS)
    .default(DEFAULT_TOP_POSTS)
    .describe('How many top posts to list (0 skips the post scan).'),
  top_by: z
    .enum(TOP_POST_RANKINGS)
    .default('engagement')
    .describe('engagement = reactions + comments + shares.'),
};

/** Build the facebook_get_page_report tool (added to the `insights` package). */
export function createPageReportTool(): ToolSpec {
  return defineTool({
    name: 'facebook_get_page_report',
    title: 'Page Report',
    description:
      'One-call Page performance report over a window (default last 28 days, ' +
      '[since, until) in Pacific Time) compared with the preceding window of ' +
      'equal length: followers (stock change reconciled with daily follows − ' +
      'unfollows), reach, views, engagement and Page views, each with its ' +
      'derivation (`method`) and a period-over-period `delta` ({abs, pct}; pct ' +
      'null when the previous value is 0), plus the top posts published in the ' +
      'window with lifetime post insights. Reach is a unique audience read from ' +
      "Meta's rolling 7- or 28-day window — other spans report reach as " +
      'unavailable instead of summing daily uniques. `eligible:false` means ' +
      'every insights metric came back empty (usually a Page under 100 ' +
      'followers or a token without read_insights), not zero activity. For raw ' +
      'series use facebook_page_insights.',
    inputSchema: z.object(pageReportArgs),
    annotations: READ_ONLY,
    handler: async (input, ctx) => {
      // Before the Page is resolved: a bad window needs no token.
      const nowMs = ctx.clock.now();
      const window = resolveReportWindow({
        window: input.window,
        ...(input.since !== undefined ? { since: input.since } : {}),
        ...(input.until !== undefined ? { until: input.until } : {}),
        nowMs,
      });
      const resolved = await ctx.pages.resolvePage(input.profile);
      const report = await buildPageReport(ctx.fbRequest, {
        pageId: resolved.pageId,
        token: resolved.token,
        window,
        compare: input.compare,
        topPosts: input.top_posts,
        topBy: input.top_by,
        nowMs,
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      });
      return shapeFor(ctx, {
        profile: input.profile ?? null,
        pageId: resolved.pageId,
        contractVersion: INSIGHTS_CONTRACT_VERSION,
        ...report,
      });
    },
  });
}
