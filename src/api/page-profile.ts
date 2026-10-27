// Graph-shaped helpers for the Page profile fields (organic F9 read, F8 update,
// `api` layer): the public business fields a Page shows (about, website, phone,
// hours, …), the conversion of Graph's flat `hours` dict to and from ranges,
// the before/after diff an update previews, and the update request itself. No
// zod, no `defineTool` — the read is wired in `src/tools/core.ts`, the update
// in `src/tools/page-admin.ts`.
//
// Design decisions:
//   * `hours` is RESHAPED into `[{day, open, close}]`: Graph's
//     `{mon_1_open, mon_1_close, …}` dict is unordered and easy to misread, and
//     the update side (F8) takes the same range list as input.
//   * An update POSTs ONLY the fields that differ from the snapshot, and the
//     tool re-reads them afterwards: Graph answers `{success:true}` even when it
//     normalized a value (a phone number's formatting, say), so the re-read is
//     the only evidence of what the Page now shows.
//   * `emails` is the one field the docs do not clear for a plain Page read.
//     It is listed separately so a read that Graph refuses can be retried
//     without it instead of failing the whole profile.

import { GraphApiError, classifyGraphError } from '../core/index.js';
import type { FbRequestFn } from '../core/index.js';

/** Days in Graph's `hours` key order (`mon_1_open`, …). */
export const PROFILE_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export type ProfileDay = (typeof PROFILE_DAYS)[number];

/** One opening range: `open`/`close` as Graph's `HH:MM` strings. */
export interface HoursRange {
  readonly day: ProfileDay;
  readonly open: string;
  readonly close: string;
}

/** The profile field Graph may refuse on a plain read (see the header). */
export const PROFILE_EMAILS_FIELD = 'emails';

/** The profile fields read without reservation. */
export const PROFILE_READ_FIELDS = [
  'about',
  'description',
  'website',
  'phone',
  'hours',
  'is_always_open',
  'temporary_status',
  'single_line_address',
  'location',
] as const;

/** Emitted when the profile was read again without `emails`. */
export const EMAILS_DROPPED_NOTE =
  'Graph refused the `emails` field for this token, so the profile was read without it. ' +
  'The other profile fields are complete; `emails` is absent, not empty.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const HOURS_KEY = /^(mon|tue|wed|thu|fri|sat|sun)_(\d+)_(open|close)$/;

/**
 * Graph's `hours` dict as ranges, ordered by day and then by range number.
 * A range missing its open or close half is dropped rather than guessed;
 * anything that is not a dict yields `undefined`.
 */
export function fromGraphHours(raw: unknown): HoursRange[] | undefined {
  if (!isRecord(raw)) return undefined;
  const halves = new Map<
    string,
    { day: ProfileDay; n: number; open?: string; close?: string }
  >();
  for (const [key, value] of Object.entries(raw)) {
    const m = HOURS_KEY.exec(key);
    if (m === null || typeof value !== 'string') continue;
    const day = m[1] as ProfileDay;
    const n = Number(m[2]);
    const id = `${day}_${String(n)}`;
    const entry = halves.get(id) ?? { day, n };
    if (m[3] === 'open') entry.open = value;
    else entry.close = value;
    halves.set(id, entry);
  }
  return [...halves.values()]
    .filter(
      (h): h is typeof h & { open: string; close: string } =>
        h.open !== undefined && h.close !== undefined,
    )
    .sort(
      (a, b) => PROFILE_DAYS.indexOf(a.day) - PROFILE_DAYS.indexOf(b.day) || a.n - b.n,
    )
    .map(({ day, open, close }) => ({ day, open, close }));
}

/** The `fields` list for a profile read, with or without `emails`. */
export function profileFields(withEmails: boolean): string {
  return [...PROFILE_READ_FIELDS, ...(withEmails ? [PROFILE_EMAILS_FIELD] : [])].join(
    ',',
  );
}

/** A Page node with `hours` replaced by its range list (other fields untouched). */
export function withReadableHours(
  page: Record<string, unknown>,
): Record<string, unknown> {
  if (!('hours' in page)) return page;
  const hours = fromGraphHours(page.hours);
  const rest = Object.fromEntries(
    Object.entries(page).filter(([key]) => key !== 'hours'),
  );
  return hours === undefined ? rest : { ...rest, hours };
}

// ---------------------------------------------------------------------------
// Profile update (organic F8)
// ---------------------------------------------------------------------------

/** The fields `facebook_update_page_profile` can change, in diff order. */
export const PROFILE_WRITE_FIELDS = [
  'about',
  'description',
  'website',
  'phone',
  'hours',
  'is_always_open',
  'temporary_status',
] as const;

export type ProfileWriteField = (typeof PROFILE_WRITE_FIELDS)[number];

/** Graph's `temporary_status` values. */
export const TEMPORARY_STATUSES = [
  'OPERATING_AS_USUAL',
  'TEMPORARILY_CLOSED',
  'DIFFERENTLY_OPEN',
  'NO_DATA',
] as const;

export type TemporaryStatus = (typeof TEMPORARY_STATUSES)[number];

/** Opening ranges allowed per day (Graph numbers them `_1_` and `_2_`). */
export const MAX_RANGES_PER_DAY = 2;

/** The latest close time an overnight range (close before open) may have. */
export const OVERNIGHT_CLOSE_LIMIT = '06:00';

/** The requested profile values; an absent field is left as it is. */
export interface ProfileUpdate {
  readonly about?: string | undefined;
  readonly description?: string | undefined;
  readonly website?: string | undefined;
  readonly phone?: string | undefined;
  readonly hours?: readonly HoursRange[] | undefined;
  readonly is_always_open?: boolean | undefined;
  readonly temporary_status?: TemporaryStatus | undefined;
}

/** The writable profile fields as Graph reports them, `hours` as ranges. */
export interface ProfileSnapshot {
  readonly about?: string;
  readonly description?: string;
  readonly website?: string;
  readonly phone?: string;
  readonly hours: readonly HoursRange[];
  readonly is_always_open?: boolean;
  readonly temporary_status?: string;
}

/** One field the update changes. `hours` values are rendered text. */
export interface ProfileChange {
  readonly field: ProfileWriteField;
  readonly before: string | boolean | null;
  readonly after: string | boolean;
}

/** The changing fields, plus the requested ones that already hold the value. */
export interface ProfileDiff {
  readonly changes: readonly ProfileChange[];
  readonly unchanged: readonly ProfileWriteField[];
}

/** The tool that shows the profile after a write. */
const VERIFY_PROFILE_TOOL = 'facebook_get_page';

function validationError(message: string): GraphApiError {
  return new GraphApiError(message, {
    code: 100,
    httpStatus: 400,
    action: classifyGraphError({ code: 100, message }),
  });
}

const HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/**
 * Check a range list against Graph's hours rules and throw a validation error
 * (nothing sent) on the first violation: `HH:MM` times, at most
 * {@link MAX_RANGES_PER_DAY} ranges per day, a range that ends where it starts
 * refused, and an overnight range (close before open) allowed only when it
 * closes by {@link OVERNIGHT_CLOSE_LIMIT}.
 */
export function validateHours(ranges: readonly HoursRange[]): void {
  const perDay = new Map<ProfileDay, number>();
  for (const { day, open, close } of ranges) {
    if (!HH_MM.test(open) || !HH_MM.test(close)) {
      throw validationError(
        `hours: ${day} ${open}–${close} is not valid — open and close must be 24-hour HH:MM times (e.g. "09:00", "18:30").`,
      );
    }
    if (open === close) {
      throw validationError(
        `hours: ${day} ${open}–${close} opens and closes at the same time. For a 24-hour business pass is_always_open:true instead of hours.`,
      );
    }
    if (close < open && close > OVERNIGHT_CLOSE_LIMIT) {
      throw validationError(
        `hours: ${day} ${open}–${close} closes before it opens. An overnight range is allowed only when it closes by ${OVERNIGHT_CLOSE_LIMIT} the next morning; otherwise split it across two days.`,
      );
    }
    const count = (perDay.get(day) ?? 0) + 1;
    if (count > MAX_RANGES_PER_DAY) {
      throw validationError(
        `hours: ${day} has more than ${String(MAX_RANGES_PER_DAY)} ranges. Graph stores at most ${String(MAX_RANGES_PER_DAY)} opening ranges per day.`,
      );
    }
    perDay.set(day, count);
  }
}

/** Ranges ordered by day, keeping the input order within a day (stable sort). */
function byDay(ranges: readonly HoursRange[]): HoursRange[] {
  return [...ranges].sort(
    (a, b) => PROFILE_DAYS.indexOf(a.day) - PROFILE_DAYS.indexOf(b.day),
  );
}

/**
 * Ranges as Graph's flat `hours` dict (`{mon_1_open, mon_1_close, …}`), each
 * day's ranges numbered in input order. Validates first (see {@link validateHours}).
 */
export function toGraphHours(ranges: readonly HoursRange[]): Record<string, string> {
  validateHours(ranges);
  const counters = new Map<ProfileDay, number>();
  const out: Record<string, string> = {};
  for (const { day, open, close } of byDay(ranges)) {
    const n = (counters.get(day) ?? 0) + 1;
    counters.set(day, n);
    out[`${day}_${String(n)}_open`] = open;
    out[`${day}_${String(n)}_close`] = close;
  }
  return out;
}

/** `Mon 09:00–18:00, Tue 09:00–18:00`, or `(none)` for an empty list. */
export function renderHours(ranges: readonly HoursRange[]): string {
  if (ranges.length === 0) return '(none)';
  return byDay(ranges)
    .map(
      ({ day, open, close }) =>
        `${day[0]?.toUpperCase() ?? ''}${day.slice(1)} ${open}–${close}`,
    )
    .join(', ');
}

/** True when a range list has an overnight range (close before open). */
export function hasOvernightRange(ranges: readonly HoursRange[]): boolean {
  return ranges.some(({ open, close }) => close < open);
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A Page node's writable profile fields as a {@link ProfileSnapshot}. */
export function toProfileSnapshot(node: Record<string, unknown>): ProfileSnapshot {
  const about = stringField(node.about);
  const description = stringField(node.description);
  const website = stringField(node.website);
  const phone = stringField(node.phone);
  const temporaryStatus = stringField(node.temporary_status);
  return {
    ...(about !== undefined ? { about } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(website !== undefined ? { website } : {}),
    ...(phone !== undefined ? { phone } : {}),
    hours: fromGraphHours(node.hours) ?? [],
    ...(typeof node.is_always_open === 'boolean'
      ? { is_always_open: node.is_always_open }
      : {}),
    ...(temporaryStatus !== undefined ? { temporary_status: temporaryStatus } : {}),
  };
}

interface ProfileScope {
  readonly pageId: string;
  readonly token: string;
  readonly signal?: AbortSignal;
}

/** Read the writable profile fields of a Page. */
export async function readProfileSnapshot(
  fbRequest: FbRequestFn,
  scope: ProfileScope,
): Promise<ProfileSnapshot> {
  const res = await fbRequest<unknown>({
    protocol: 'json',
    method: 'GET',
    host: 'graph',
    path: `/${scope.pageId}`,
    params: { fields: PROFILE_WRITE_FIELDS.join(',') },
    token: scope.token,
    ...(scope.signal !== undefined ? { signal: scope.signal } : {}),
  });
  const node = res.data;
  return toProfileSnapshot(
    typeof node === 'object' && node !== null ? (node as Record<string, unknown>) : {},
  );
}

/** The value of one field in the shape a {@link ProfileChange} carries. */
function snapshotValue(
  snapshot: ProfileSnapshot,
  field: ProfileWriteField,
): string | boolean | null {
  if (field === 'hours')
    return snapshot.hours.length > 0 ? renderHours(snapshot.hours) : null;
  return snapshot[field] ?? null;
}

function updateValue(
  update: ProfileUpdate,
  field: ProfileWriteField,
): string | boolean | undefined {
  if (field === 'hours')
    return update.hours === undefined ? undefined : renderHours(update.hours);
  return update[field];
}

/**
 * Compare the requested values with the snapshot. Hours compare as rendered
 * text, which orders them by day exactly as Graph's numbering does.
 */
export function diffProfile(before: ProfileSnapshot, update: ProfileUpdate): ProfileDiff {
  const changes: ProfileChange[] = [];
  const unchanged: ProfileWriteField[] = [];
  for (const field of PROFILE_WRITE_FIELDS) {
    const after = updateValue(update, field);
    if (after === undefined) continue;
    const current = snapshotValue(before, field);
    if (current === after) unchanged.push(field);
    else changes.push({ field, before: current, after });
  }
  return { changes, unchanged };
}

/** The POST body for the changing fields; `hours` travels as a JSON string. */
export function profileUpdateBody(
  update: ProfileUpdate,
  fields: readonly ProfileWriteField[],
): Record<string, string | boolean> {
  const body: Record<string, string | boolean> = {};
  for (const field of fields) {
    if (field === 'hours') {
      if (update.hours !== undefined)
        body.hours = JSON.stringify(toGraphHours(update.hours));
      continue;
    }
    const value = update[field];
    if (value !== undefined) body[field] = value;
  }
  return body;
}

/** Graph's permission codes for a profile write the token or role cannot make. */
const PROFILE_PERMISSION_CODES: ReadonlySet<number> = new Set([10, 200, 283]);

/**
 * A permission refusal restated with what a profile edit needs: the
 * `pages_manage_metadata` scope and the EDIT_PROFILE (or MANAGE) Page task.
 * Anything else passes through unchanged.
 */
export function mapProfileError(err: unknown): unknown {
  if (!(err instanceof GraphApiError) || !PROFILE_PERMISSION_CODES.has(err.code))
    return err;
  const operatorText =
    `Graph refused the profile edit (code ${String(err.code)}). Editing a Page profile needs a Page token with the pages_manage_metadata permission, issued by a person with the EDIT_PROFILE (or MANAGE) task on the Page. ` +
    'Run facebook_whoami to see the granted scopes; do not retry unchanged.';
  return new GraphApiError(`${err.message} ${operatorText}`, {
    code: err.code,
    ...(err.subcode !== undefined ? { subcode: err.subcode } : {}),
    ...(err.type !== undefined ? { type: err.type } : {}),
    ...(err.fbtraceId !== undefined ? { fbtraceId: err.fbtraceId } : {}),
    httpStatus: err.httpStatus,
    action: {
      category: 'permission',
      retryable: false,
      nextTool: 'facebook_whoami',
      operatorText,
    },
    ...(err.userTitle !== undefined ? { userTitle: err.userTitle } : {}),
    ...(err.userMessage !== undefined ? { userMessage: err.userMessage } : {}),
    cause: err,
  });
}

/**
 * POST the changing fields to the Page. Resolves `true` when Graph confirms
 * (`{success:true}` or an empty body), `false` on an explicit `success:false`.
 */
export async function updatePageProfile(
  fbRequest: FbRequestFn,
  scope: ProfileScope & {
    readonly update: ProfileUpdate;
    readonly fields: readonly ProfileWriteField[];
  },
): Promise<boolean> {
  try {
    const res = await fbRequest<unknown>({
      protocol: 'json',
      method: 'POST',
      host: 'graph',
      path: `/${scope.pageId}`,
      body: profileUpdateBody(scope.update, scope.fields),
      token: scope.token,
      verifyTool: VERIFY_PROFILE_TOOL,
      ...(scope.signal !== undefined ? { signal: scope.signal } : {}),
    });
    const body = res.data;
    if (body === undefined || body === true) return true;
    if (typeof body !== 'object' || body === null) return false;
    const flag = (body as { success?: unknown }).success;
    return flag === undefined || flag === true;
  } catch (err) {
    throw mapProfileError(err);
  }
}

/**
 * The fields whose re-read value differs from what was written: Graph
 * accepted the write but stores (or shows) something else.
 */
export function profileMismatches(
  after: ProfileSnapshot,
  changes: readonly ProfileChange[],
): ProfileWriteField[] {
  return changes
    .filter((change) => snapshotValue(after, change.field) !== change.after)
    .map((change) => change.field);
}
