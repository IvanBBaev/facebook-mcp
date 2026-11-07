// The list contract (task C02, wave 1 — expand only).
//
// Every listing tool answers the same questions the same way: is there more
// (`nextCursor`), is this all of it (`truncated`), what should the caller know
// (`notes[]`), which Graph fields were read (`fields`), which time range was
// read (`window`) and which parts are untrusted (one list-level taint envelope).
// This module is that contract; the wave 2 lane tasks adopt it in their own
// files. Nothing here migrates a caller.
//
// The rules, in the order a listing result is built:
//
//   1. Pagination. `nextCursor` is present only when a further page exists and
//      is omitted otherwise — never `null`, never `""` (V3 scope #4).
//      `truncated: true` means rows exist that this result does not carry.
//   2. Notes. Advice is a `notes: string[]`, in order, without duplicates. The
//      singular `note` is still emitted beside it, joined with `"; "`, and is
//      deprecated (removed in 2.0, V3 scope #5). Static text belongs in the tool
//      description, not in a note on every call (AUX-12).
//   3. Fields. `fields` is a `string[]` of Graph field names, nested expansion
//      included (`"comments{message,from}"`). A comma-separated string is still
//      accepted and adds {@link FIELDS_CSV_DEPRECATED_NOTE} to `notes`.
//   4. Time windows (OD-3). `since` is inclusive, `until` is exclusive; both
//      take an ISO 8601 date or a date-time with an offset. A tool echoes what it
//      resolved as `window: {since, until, timezone, until_inclusive: false}`.
//      A Graph edge that takes an inclusive end translates internally
//      ({@link inclusiveEndDate}); the caller never sees two meanings.
//   5. Untrusted rows (OD-5). A list of user-generated rows is wrapped ONCE, as
//      `{__tainted, source, warning, content: [...]}` ({@link taintedList}),
//      instead of one envelope per row. Per-field delimiters stay only in
//      write-preview excerpts. The Security co-sign that OD-5 asks for is
//      still open; lanes adopt this only after it is recorded.
//
// Truncation-safe paging (AUX-02) also needs the result shaper to withdraw
// `nextCursor` when it drops list items; that file is not C02's, so the change
// is requested in `changes/requests/c02-to-c01.md`.

import { z } from 'zod';

import type { Page, TaintedContent, TaintSource } from '../../core/index.js';
import { NOTE_SEPARATOR, pageNotes } from '../../api/shared.js';
import { neutralizeDelimiters, taint } from '../../mcp/index.js';

// ---------------------------------------------------------------------------
// 1. notes[]
// ---------------------------------------------------------------------------

/** Anything a note list can be collected from; absent and empty values are skipped. */
export type NoteSource = string | readonly string[] | undefined | null | false;

/**
 * Collect notes in order, skipping absent and empty ones and dropping exact
 * duplicates (the same advice twice reads as two problems).
 */
export function collectNotes(...sources: readonly NoteSource[]): string[] {
  const out: string[] = [];
  for (const source of sources) {
    if (source === undefined || source === null || source === false) continue;
    const list = typeof source === 'string' ? [source] : source;
    for (const note of list) {
      if (note.length > 0 && !out.includes(note)) out.push(note);
    }
  }
  return out;
}

/** The advisory fields of a result: `notes[]` plus the deprecated joined `note`. */
export interface NotesFields {
  readonly notes?: readonly string[];
  /** @deprecated Joined form of `notes`, kept for 1.x callers; removed in 2.0. */
  readonly note?: string;
}

/** Spreadable advisory fields; `{}` when there is nothing to say. */
export function notesFields(...sources: readonly NoteSource[]): NotesFields {
  const notes = collectNotes(...sources);
  return notes.length > 0 ? { notes, note: notes.join(NOTE_SEPARATOR) } : {};
}

// ---------------------------------------------------------------------------
// 2. Pagination
// ---------------------------------------------------------------------------

/** The paging fields every listing result carries. */
export interface ListPaging extends NotesFields {
  /** Present only when a further page exists. */
  readonly nextCursor?: string;
  readonly truncated: boolean;
}

/**
 * The paging fields of a page, ready to spread into a result:
 * `shapeFor(ctx, { posts, ...listPaging(page, extraNote) })`. Extra notes
 * (a deprecation, a tool-specific caveat) follow the page's own notes.
 */
export function listPaging(
  page: Page<unknown>,
  ...extraNotes: readonly NoteSource[]
): ListPaging {
  const cursor = page.nextCursor;
  return {
    ...(cursor !== undefined && cursor.length > 0 ? { nextCursor: cursor } : {}),
    truncated: page.truncated,
    ...notesFields(pageNotes(page), ...extraNotes),
  };
}

// ---------------------------------------------------------------------------
// 3. fields
// ---------------------------------------------------------------------------

/** Added to `notes` when `fields` arrives as a comma-separated string. */
export const FIELDS_CSV_DEPRECATED_NOTE =
  '`fields` as a comma-separated string is deprecated: pass an array such as ["id","message"]. ' +
  'The string form is accepted in 1.x and removed in 2.0.';

/** Upper bound on the number of field names one call may request. */
export const MAX_FIELDS = 100;

/**
 * Split a Graph field list on its top-level commas. Commas inside a nested
 * expansion (`comments{message,from}`) belong to that expansion and stay. Names
 * are trimmed; empty entries are dropped.
 */
export function splitFieldList(csv: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of csv) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map((name) => name.trim()).filter((name) => name.length > 0);
}

/**
 * The `fields` argument: an array of Graph field names, or (deprecated) one
 * comma-separated string. `description` is the tool's own prose: which default
 * set the list replaces, and what it can reach.
 */
export function fieldsArg(
  description: string,
): z.ZodOptional<z.ZodUnion<readonly [z.ZodArray<z.ZodString>, z.ZodString]>> {
  return z
    .union([
      z.array(z.string().trim().min(1)).min(1).max(MAX_FIELDS),
      z.string().trim().min(1),
    ])
    .optional()
    .describe(description);
}

/** A parsed `fields` argument. */
export interface ResolvedFields {
  /** The field names, de-duplicated in order; absent when `fields` was omitted. */
  readonly names?: readonly string[];
  /** The Graph `fields` query value (`names` joined with `,`). */
  readonly param?: string;
  /** {@link FIELDS_CSV_DEPRECATED_NOTE} when the string form was used. */
  readonly notes: readonly string[];
}

/**
 * Normalize a parsed `fields` argument. Array entries are split on top-level
 * commas as well, so `["id,message"]` means what the caller meant.
 */
export function resolveFields(
  value: readonly string[] | string | undefined,
): ResolvedFields {
  if (value === undefined) return { notes: [] };
  const csv = typeof value === 'string';
  const parts = csv ? splitFieldList(value) : value.flatMap(splitFieldList);
  const names = [...new Set(parts)];
  if (names.length === 0) return { notes: csv ? [FIELDS_CSV_DEPRECATED_NOTE] : [] };
  return {
    names,
    param: names.join(','),
    notes: csv ? [FIELDS_CSV_DEPRECATED_NOTE] : [],
  };
}

// ---------------------------------------------------------------------------
// 4. Time windows (OD-3)
// ---------------------------------------------------------------------------

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,9})?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function isCalendarDate(year: string, month: string, day: string): boolean {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  );
}

/** True for `YYYY-MM-DD` that names a real calendar day. */
export function isIsoDate(value: string): boolean {
  const m = DATE_ONLY.exec(value);
  return m !== null && isCalendarDate(m[1] ?? '', m[2] ?? '', m[3] ?? '');
}

/** True for an ISO 8601 date-time with an explicit offset (`Z` or `±HH:MM`). */
export function isIsoDateTime(value: string): boolean {
  const m = DATE_TIME.exec(value);
  return m !== null && isCalendarDate(m[1] ?? '', m[2] ?? '', m[3] ?? '');
}

/** The rejection message of a malformed window bound. */
export const WINDOW_BOUND_MESSAGE =
  'Expected an ISO 8601 date ("2026-01-31") or a date-time with an offset ("2026-01-31T09:00:00Z").';

/**
 * A `since` / `until` argument. The check runs in a refinement rather than a
 * schema `pattern`, so the advertised schema stays a plain string (AUX-11).
 */
export function windowBoundArg(description: string): z.ZodOptional<z.ZodString> {
  return z
    .string()
    .trim()
    .refine((v) => isIsoDate(v) || isIsoDateTime(v), WINDOW_BOUND_MESSAGE)
    .optional()
    .describe(description);
}

/** The window a tool echoes back: what it actually read. */
export interface TimeWindow {
  readonly since?: string;
  readonly until?: string;
  /** IANA name (or `UTC`) that date-only bounds were resolved in. */
  readonly timezone: string;
  readonly until_inclusive: false;
}

/** The echo object for a resolved window; absent bounds are omitted. */
export function timeWindow(bounds: {
  readonly since?: string;
  readonly until?: string;
  readonly timezone: string;
}): TimeWindow {
  return {
    ...(bounds.since !== undefined ? { since: bounds.since } : {}),
    ...(bounds.until !== undefined ? { until: bounds.until } : {}),
    timezone: bounds.timezone,
    until_inclusive: false,
  };
}

/**
 * Why `since`/`until` cannot form a window, or `undefined` when they can. Only
 * bounds of the same form are compared: a date is a day in the tool's timezone
 * and a date-time is an instant, so ordering one against the other needs the
 * timezone the tool resolves later.
 */
export function windowProblem(since?: string, until?: string): string | undefined {
  if (since === undefined || until === undefined) return undefined;
  const bothDates = isIsoDate(since) && isIsoDate(until);
  const bothTimes = isIsoDateTime(since) && isIsoDateTime(until);
  if (!bothDates && !bothTimes) return undefined;
  const from = bothDates ? since : Date.parse(since);
  const to = bothDates ? until : Date.parse(until);
  return from < to
    ? undefined
    : '`until` must be later than `since`: `since` is inclusive and `until` is exclusive, so equal bounds select nothing.';
}

function shiftDate(date: string, days: number): string {
  const m = DATE_ONLY.exec(date);
  if (m === null || !isCalendarDate(m[1] ?? '', m[2] ?? '', m[3] ?? '')) {
    throw new RangeError(`not an ISO date: ${date}`);
  }
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days);
  return new Date(t).toISOString().slice(0, 10);
}

/** The last day INSIDE a window whose exclusive end is `until` (for inclusive Graph edges). */
export function inclusiveEndDate(until: string): string {
  return shiftDate(until, -1);
}

/** The exclusive end of a window whose last included day is `lastDay`. */
export function exclusiveEndDate(lastDay: string): string {
  return shiftDate(lastDay, 1);
}

// ---------------------------------------------------------------------------
// 5. List-level taint envelope (OD-5)
// ---------------------------------------------------------------------------

function neutralizeValue(value: unknown): unknown {
  if (typeof value === 'string') return neutralizeDelimiters(value).text;
  if (Array.isArray(value)) return value.map(neutralizeValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        neutralizeDelimiters(key).text,
        neutralizeValue(item),
      ]),
    );
  }
  return value;
}

/**
 * Wrap a list of untrusted rows in ONE taint envelope: one warning for the
 * whole list instead of ~340 characters per row (AUX-02). Every string in the
 * rows, keys included, has its delimiters and invisible controls neutralized
 * first, because the structured form never passes through `renderTainted`.
 */
export function taintedList<T>(
  source: TaintSource,
  rows: readonly T[],
): TaintedContent<readonly T[]> {
  return taint(source, neutralizeValue(rows) as readonly T[]);
}
