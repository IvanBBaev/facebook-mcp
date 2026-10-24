// Graph-shaped helpers for the Page profile fields (organic F9, `api` layer):
// the public business fields a Page shows (about, website, phone, hours, …)
// and the pure conversion of Graph's flat `hours` dict into ranges. Shared with
// the planned profile update (organic F8). No zod, no `defineTool` — the tool
// wiring lives in `src/tools/core.ts`.
//
// Design decisions:
//   * `hours` is RESHAPED into `[{day, open, close}]`: Graph's
//     `{mon_1_open, mon_1_close, …}` dict is unordered and easy to misread, and
//     the update side (F8) takes the same range list as input.
//   * `emails` is the one field the docs do not clear for a plain Page read.
//     It is listed separately so a read that Graph refuses can be retried
//     without it instead of failing the whole profile.

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
