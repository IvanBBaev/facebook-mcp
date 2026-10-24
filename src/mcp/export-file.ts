// Local file exports for insights results (v2 insights F5).
//
// An insights tool called with `output` writes its full, uncapped series to one
// file under `FB_EXPORT_DIR` and returns only the path and a summary, so a
// 90-day × 12-metric daily series no longer has to fit the row cap or the
// result budget. This module owns the parts that are not about insights:
//
//   * THE ARGUMENT. `output: {format, file_name?}`; `file_name` is a bare name
//     (no separators, no leading dot), so it cannot leave the export dir.
//   * CSV. RFC 4180 quoting with CRLF line ends, plus a formula-injection guard:
//     a TEXT cell starting with `=`, `+`, `-` or `@` is prefixed with `'`, so a
//     spreadsheet never evaluates a breakdown key or an error message. Numbers
//     are written as numbers — a negative value is data, not a formula.
//   * ATOMIC, NO OVERWRITE. The bytes go to a 0600 temp file in the export dir
//     (created 0700), are fsynced, and are then hard-linked to the final name.
//     `link` refuses an existing target, so a collision moves to `name-1.ext`,
//     `name-2.ext`, … and a reader never sees a partial file.
//   * ONE ERROR. Any filesystem failure is an `ExportFileError` naming
//     `FB_EXPORT_DIR`; the temp file is always removed.

import { createHash, randomBytes } from 'node:crypto';
import { chmod, link, mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { errorMessageOf } from '../core/index.js';

// ---------------------------------------------------------------------------
// 1. The argument
// ---------------------------------------------------------------------------

export type ExportFormat = 'csv' | 'json';

/** A bare file name: no separators, no leading dot (so never `.` or `..`). */
const EXPORT_FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}$/;

/** The optional `output` argument the insights tools share. */
export const exportOutputArg = z
  .object({
    format: z
      .enum(['csv', 'json'])
      .describe(
        'File format: "csv" (one row per data point, spreadsheet-ready) or "json" (the summaries plus every row).',
      ),
    file_name: z
      .string()
      .regex(
        EXPORT_FILE_NAME,
        'file_name must be a bare name of 1-80 letters, digits, ".", "_" or "-", not starting with "."; it cannot contain a path.',
      )
      .optional()
      .describe(
        'Optional bare file name (1-80 of A-Z a-z 0-9 . _ -, no path, no leading dot). The extension is added when missing. Omitted ⇒ <scope>-<objectId>-<since>-<until>-<timestamp>. An existing file is never overwritten; a numeric suffix is added instead.',
      ),
  })
  .strict()
  .optional()
  .describe(
    'Write the FULL series to a local file in FB_EXPORT_DIR instead of returning rows. The row cap does not apply to the file; the inline result is the aggregate-mode summary (no rows, max_rows and aggregate are ignored) plus `export: {path, format, rows, bytes, sha256}`. Use it for long daily series that would otherwise be truncated.',
  );

/** The parsed `output` argument. */
export interface ExportOutput {
  readonly format: ExportFormat;
  readonly file_name?: string | undefined;
}

/** What the tool reports about a written export. */
export interface ExportReceipt {
  readonly path: string;
  readonly format: ExportFormat;
  /** Data rows in the file (CSV: excluding the header). */
  readonly rows: number;
  readonly bytes: number;
  readonly sha256: string;
}

// ---------------------------------------------------------------------------
// 2. CSV
// ---------------------------------------------------------------------------

export type CsvCell = string | number | undefined;

/** Leading characters a spreadsheet reads as the start of a formula. */
const FORMULA_START = /^[=+\-@]/;

/** One CSV field: guarded, then quoted when it holds a delimiter or a quote. */
export function csvField(cell: CsvCell): string {
  if (cell === undefined) return '';
  if (typeof cell === 'number') return Number.isFinite(cell) ? String(cell) : '';
  const guarded = FORMULA_START.test(cell) ? `'${cell}` : cell;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/** An RFC 4180 document: header line, then one line per row, CRLF-terminated. */
export function encodeCsv(
  header: readonly string[],
  rows: readonly (readonly CsvCell[])[],
): string {
  const lines = [header, ...rows].map((cells) => cells.map(csvField).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// 3. Names
// ---------------------------------------------------------------------------

/** Characters outside the bare-name alphabet become `_`. */
function namePart(part: string): string {
  return part.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** `20261024T101500Z` — sortable, and free of `:` (not allowed on Windows). */
function compactTimestamp(nowMs: number): string {
  return new Date(nowMs)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/**
 * The file name to write: the caller's `file_name` (extension added when
 * missing), or `<parts…>-<timestamp>.<ext>`.
 */
export function exportFileName(
  output: ExportOutput,
  parts: readonly string[],
  nowMs: number,
): string {
  const ext = `.${output.format}`;
  if (output.file_name !== undefined) {
    return output.file_name.toLowerCase().endsWith(ext)
      ? output.file_name
      : `${output.file_name}${ext}`;
  }
  const stem = [...parts, compactTimestamp(nowMs)].map(namePart).join('-');
  return `${stem.replace(/^\.+/, '_').slice(0, 120)}${ext}`;
}

/** `name.ext` → `name-N.ext` for the N-th collision. */
function suffixed(fileName: string, n: number): string {
  const ext = path.extname(fileName);
  return `${fileName.slice(0, fileName.length - ext.length)}-${String(n)}${ext}`;
}

// ---------------------------------------------------------------------------
// 4. The write
// ---------------------------------------------------------------------------

/** Collisions tried before giving up on a name. */
const MAX_NAME_ATTEMPTS = 100;

/** An export that could not be written; nothing was left behind. */
export class ExportFileError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'ExportFileError';
  }
}

function errnoCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

export interface WriteExportOptions {
  /** Absolute export directory (`Settings.exportDir`). */
  readonly dir: string;
  readonly fileName: string;
  readonly data: string;
  /** Data rows, echoed in the receipt. */
  readonly rows: number;
  readonly format: ExportFormat;
  /** Defaults to `process.platform`; POSIX modes are skipped on Windows. */
  readonly platform?: NodeJS.Platform;
}

/**
 * Write one export atomically under `dir` without overwriting anything, and
 * return its receipt. Throws {@link ExportFileError} on any filesystem failure.
 */
export async function writeExportFile(opts: WriteExportOptions): Promise<ExportReceipt> {
  const posix = (opts.platform ?? process.platform) !== 'win32';
  const bytes = Buffer.from(opts.data, 'utf8');
  const tmp = path.join(opts.dir, `.export-${randomBytes(8).toString('hex')}.tmp`);
  try {
    await mkdir(opts.dir, { recursive: true, ...(posix ? { mode: 0o700 } : {}) });
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (posix) await chmod(tmp, 0o600);
    const finalPath = await linkUnique(tmp, opts.dir, opts.fileName);
    return {
      path: finalPath,
      format: opts.format,
      rows: opts.rows,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch (err) {
    if (err instanceof ExportFileError) throw err;
    throw new ExportFileError(
      `Could not write the export to ${opts.dir}: ${errorMessageOf(err)}. Set FB_EXPORT_DIR to an absolute directory this server can write to, or call the tool without \`output\` to get the result inline.`,
      { cause: err },
    );
  } finally {
    // Best effort: when the dir itself is unusable there is no temp file to
    // remove, and a cleanup error must not replace the actionable one.
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** Hard-link `tmp` to the first free `fileName`, `fileName-1`, … under `dir`. */
async function linkUnique(tmp: string, dir: string, fileName: string): Promise<string> {
  for (let n = 0; n < MAX_NAME_ATTEMPTS; n += 1) {
    const candidate = path.join(dir, n === 0 ? fileName : suffixed(fileName, n));
    try {
      await link(tmp, candidate);
      return candidate;
    } catch (err) {
      if (errnoCode(err) !== 'EEXIST') throw err;
    }
  }
  throw new ExportFileError(
    `Could not write the export: "${fileName}" and its first ${String(MAX_NAME_ATTEMPTS - 1)} numbered variants already exist in ${dir}. Pass a different file_name, or clean up FB_EXPORT_DIR.`,
  );
}
