// Insights file exports (v2 insights F5) — the insights-specific half of the
// `output` argument. `../mcp/export-file.js` owns the argument schema, CSV
// encoding and the atomic no-overwrite write; this module decides what goes in
// the file for each tool:
//
//   * single-object tools (page / post / Reel): one CSV line per data point —
//     `metric,date,end_time,breakdown,value` — or, as JSON, the result's
//     summaries next to every uncapped row;
//   * facebook_get_posts_insights: a long table — one line per post × metric
//     (× breakdown key) — `post_id,created_time,metric,breakdown,value,error`,
//     with a post Graph refused written as one line carrying its `error`.

import { defaultExportDir } from '../core/index.js';
import type { ToolContext } from '../core/index.js';
import type { InsightExportRow, InsightsResult, InsightsScope } from '../api/insights.js';
import type { PostsInsightsTable } from '../api/insights-batch.js';
import {
  encodeCsv,
  exportFileName,
  writeExportFile,
  type CsvCell,
  type ExportOutput,
  type ExportReceipt,
} from '../mcp/index.js';

/** Header of a single-object CSV export. */
export const INSIGHTS_CSV_HEADER = ['metric', 'date', 'end_time', 'breakdown', 'value'];

/** Header of a posts-table CSV export. */
export const POSTS_CSV_HEADER = [
  'post_id',
  'created_time',
  'metric',
  'breakdown',
  'value',
  'error',
];

/** Placeholder name part for a window boundary Graph defaulted. */
const OPEN_BOUNDARY = 'default';

function exportDirOf(ctx: ToolContext): string {
  return ctx.settings.exportDir ?? defaultExportDir();
}

async function write(
  ctx: ToolContext,
  output: ExportOutput,
  nameParts: readonly string[],
  rows: number,
  data: string,
): Promise<ExportReceipt> {
  return writeExportFile({
    dir: exportDirOf(ctx),
    fileName: exportFileName(output, nameParts, ctx.clock.now()),
    data,
    rows,
    format: output.format,
  });
}

/** The identity block a JSON export opens with. */
export interface InsightsExportHeader {
  readonly contractVersion: number;
  readonly scope: InsightsScope;
  readonly pageId: string;
  /** `postId` / `videoId` for a post or Reel. */
  readonly object?: Readonly<Record<string, string>>;
}

/**
 * Write a single-object result's full series and return the receipt. `result`
 * must have been fetched with `exportRows: true`.
 */
export async function exportInsights(
  ctx: ToolContext,
  output: ExportOutput,
  header: InsightsExportHeader,
  result: InsightsResult,
): Promise<ExportReceipt> {
  const rows: readonly InsightExportRow[] = result.exportRows ?? [];
  const objectId = Object.values(header.object ?? {})[0] ?? header.pageId;
  const data =
    output.format === 'csv'
      ? encodeCsv(
          INSIGHTS_CSV_HEADER,
          rows.map((row) => [
            row.metric,
            row.date,
            row.endTime,
            row.breakdown,
            row.value,
          ]),
        )
      : `${JSON.stringify(
          {
            contractVersion: header.contractVersion,
            scope: header.scope,
            pageId: header.pageId,
            ...header.object,
            period: result.period,
            ...(result.window !== undefined ? { window: result.window } : {}),
            metrics: result.metrics,
            rows,
          },
          null,
          2,
        )}\n`;
  return write(
    ctx,
    output,
    [
      header.scope,
      objectId,
      result.window?.since ?? OPEN_BOUNDARY,
      result.window?.until ?? OPEN_BOUNDARY,
    ],
    rows.length,
    data,
  );
}

/**
 * `result` without its per-point rows — the inline answer of an exporting
 * call, whose rows went to the file.
 */
export function withoutRows(
  result: InsightsResult,
): Omit<InsightsResult, 'rows' | 'exportRows'> {
  return Object.fromEntries(
    Object.entries(result).filter(([key]) => key !== 'rows' && key !== 'exportRows'),
  ) as Omit<InsightsResult, 'rows' | 'exportRows'>;
}

/** The long-format lines of a posts table, one per post × metric (× key). */
export function postsCsvRows(table: PostsInsightsTable): CsvCell[][] {
  const lines: CsvCell[][] = [];
  for (const post of table.posts) {
    if (post.error !== undefined) {
      lines.push([
        post.postId,
        post.createdTime,
        undefined,
        undefined,
        undefined,
        post.error.message,
      ]);
      continue;
    }
    for (const [metric, value] of Object.entries(post.values ?? {})) {
      lines.push([post.postId, post.createdTime, metric, undefined, value, undefined]);
    }
    for (const [metric, keys] of Object.entries(post.breakdowns ?? {})) {
      for (const [key, value] of Object.entries(keys)) {
        lines.push([post.postId, post.createdTime, metric, key, value, undefined]);
      }
    }
  }
  return lines;
}

/** Write a posts table and return the receipt. */
export async function exportPostsInsights(
  ctx: ToolContext,
  output: ExportOutput,
  header: { readonly contractVersion: number; readonly pageId: string },
  table: PostsInsightsTable,
): Promise<ExportReceipt> {
  const lines = postsCsvRows(table);
  const data =
    output.format === 'csv'
      ? encodeCsv(POSTS_CSV_HEADER, lines)
      : `${JSON.stringify({ ...header, scope: 'posts', ...table }, null, 2)}\n`;
  return write(
    ctx,
    output,
    ['posts', header.pageId],
    output.format === 'csv' ? lines.length : table.posts.length,
    data,
  );
}
