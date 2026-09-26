// Cursor pagination helper for Graph API edges (task F10, `api` layer).
//
// Rides an injected `FbRequestFn` (no direct HTTP, no ambient context). Two
// entry points:
//   * `fetchPage` — read a SINGLE edge page (cursor in, cursor out). Default.
//   * `fetchAll`  — walk `paging.next` up to a hard page/item budget, returning
//                   the accumulated items with a `truncated` flag when a cap is
//                   hit or a cursor expires mid-walk.
//
// Design decisions (justified against the corpus):
//   * Cursors are OPAQUE forward cursors (Graph's `after`) and are NEVER
//     persisted (architecture §3). `fetchAll` re-issues the SAME logical request
//     with the extracted `after` cursor instead of following the raw
//     `paging.next` URL — that URL embeds the access token (C3 / CC-PAGE-4), so
//     the helper only ever lifts the opaque `after` query value out of it and
//     never surfaces the URL itself.
//   * `paging.next` absence = end of iteration (architecture §3).
//   * An empty `data` array that still carries `paging.next` CONTINUES; it is
//     never treated as end-of-data (CC-PAGE-1).
//   * A cursor-expiry `GraphApiError` mid-walk returns the items gathered so far
//     marked `truncated` with a restart note, never discarding them (CC-PAGE-2).
//   * No server-side dedup: items shifting between pages may appear twice or be
//     skipped; results carry Graph's item shape so a downstream keyed by `id`
//     can dedup (CC-PAGE-3, documented, not promised away).
//   * `fetchAll` ALWAYS terminates (CC-PAGE-5): the pages walked are bounded by a
//     finite effective cap (the caller's `maxPages`, else `DEFAULT_MAX_PAGES`),
//     and a seen-cursor guard stops non-advancing cursor loops even before that.

import { GraphApiError } from '../core/index.js';
import type {
  Cursor,
  FbRequestFn,
  FetchAllBudget,
  GraphHost,
  JsonRequest,
  Page,
  PageRequest,
  ParamValue,
} from '../core/index.js';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Small default page size so a bare listing never blows the result budget (CC-PAGE-5). */
export const DEFAULT_PAGE_LIMIT = 25;

/**
 * Hard safety cap on the number of pages `fetchAll` walks when the caller passes
 * no finite, positive `maxPages`. Guarantees termination even against an
 * adversarial empty-page-with-`next` stream that never ends (CC-PAGE-1/-5).
 */
export const DEFAULT_MAX_PAGES = 1000;

/** Model-facing note emitted when a cursor expires mid-walk (CC-PAGE-2, UX #7). */
export const CURSOR_EXPIRED_NOTE = 'cursor expired — restart listing';

/** Emitted when `paging.next` is present but no usable `after` cursor could be read. */
export const MISSING_CURSOR_NOTE = 'pagination cursor unavailable — restart listing';

/**
 * Emitted when Graph's `data` array carried entries that are not objects. Those
 * rows are dropped rather than handed on, so the count is the only way the
 * caller learns the listing is short: `data: []` with no note is a truthful
 * "there is nothing here", and five unusable rows is a different fact entirely.
 */
export function malformedRowsNote(count: number): string {
  return `${String(count)} rows were dropped: Graph returned entries this edge cannot read — the listing is incomplete`;
}

/**
 * Emitted when Graph answered an edge read without a `data` array at all (an
 * empty object, a bare `false`/`null`, a string). Graph reports an edge with no
 * rows as `data: []`; a body with no list in it is not that answer, so the page
 * is returned empty but marked `truncated`, never as a complete empty listing.
 */
export const NO_LIST_RETURNED_NOTE =
  'Graph answered without a list for this edge — nothing was read, so this is NOT an ' +
  'empty listing; retry the read before concluding there is nothing here';

/** Emitted when the cursor stops advancing (repeat), so the walk is stopped to avoid a loop. */
export const LOOP_GUARD_NOTE =
  'pagination stopped: the cursor did not advance (possible loop) — restart listing';

// ---------------------------------------------------------------------------
// Public input shape
// ---------------------------------------------------------------------------

/**
 * The Graph edge to page over. The helper OWNS the paging params (`limit` /
 * `after`) — the caller supplies everything else (host, path, base params,
 * page/token scoping, timeout, abort signal). Only GET reads are paginated.
 */
export interface EdgeRequest {
  readonly host: GraphHost;
  readonly path: string;
  /** Base query params merged under the helper-managed `limit`/`after`. */
  readonly params?: Readonly<Record<string, ParamValue>>;
  /** Page whose token the client should resolve (per-page token resolver — C1). */
  readonly pageId?: string;
  /** Explicit token override; otherwise resolved from `pageId` / settings. */
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Cursor-expiry classification
// ---------------------------------------------------------------------------

/**
 * True when a thrown error is a Graph cursor rejection (CC-PAGE-2) — the single
 * condition under which `fetchAll` swallows a failure and returns a truncated
 * page instead of propagating.
 *
 * It reads `ErrorAction.category` and nothing else. The classification is made
 * once, in core, against Graph's RAW envelope (`isCursorRejection` in
 * `core/errors.js`, applied by the live builder `graphErrorFromResponse`); this
 * layer only consumes the verdict.
 *
 * There used to be a second, independent message heuristic here as a "fallback",
 * and removing it is the point. It scanned the SURFACED message — redacted and
 * status-prefixed — for "cursor" plus one of three verbs, under any code, which
 * made it wrong in both directions: a permission or auth failure whose text
 * happened to mention an invalid cursor was silently downgraded to an empty page
 * (a listing that reports "0 results" for a credential problem is worse than one
 * that throws), while Graph's actual wording — "The cursor you provided is not
 * valid" — matched none of the three verbs. A duplicated classifier that
 * disagrees with the authoritative one is not a safety net.
 */
export function isCursorExpiryError(err: unknown): err is GraphApiError {
  return err instanceof GraphApiError && err.action?.category === 'cursor_expired';
}

// ---------------------------------------------------------------------------
// Internal: defensive Graph-page parsing
// ---------------------------------------------------------------------------

interface ParsedPage<T> {
  readonly items: readonly T[];
  /**
   * Whether the body carried a `data` array at all. `false` means Graph handed
   * back no list (see {@link NO_LIST_RETURNED_NOTE}) — not an empty one.
   */
  readonly listed: boolean;
  /** Entries under `data` that were not objects and could not be a `T`. */
  readonly dropped: number;
  /** Whether `paging.next` is present (there is a further page to walk). */
  readonly hasNext: boolean;
  /** The opaque forward cursor for the NEXT page, when extractable. */
  readonly after?: Cursor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * One row of a Graph list. Narrower than {@link isRecord} on purpose: an array
 * is an object, so `isRecord` would wave `[]` through as a row, and a shaper
 * would then read `.id` off it and get `undefined` rather than a dropped row.
 */
function isRow(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

/**
 * Extract only the opaque `after` query value from a `paging.next` URL. The URL
 * itself embeds the access token (C3) and is NEVER returned or logged — this
 * reads the single cursor param and drops everything else.
 */
function extractAfterParam(nextUrl: string): Cursor | undefined {
  try {
    const after = new URL(nextUrl).searchParams.get('after');
    return after !== null && after.length > 0 ? after : undefined;
  } catch {
    return undefined;
  }
}

/** Parse a raw Graph list body defensively — any field may be absent or malformed. */
function parsePage<T>(body: unknown): ParsedPage<T> {
  const rawData: unknown = isRecord(body) ? body.data : undefined;
  // The array-ness of `data` was already proven; its ELEMENTS were not, and
  // `as readonly T[]` asserts nothing about them. Every shaper downstream reads
  // fields off what it is handed, so a `null` row throws on `.id` and takes the
  // whole listing down, while a string row answers `.id` with `undefined` and
  // becomes a result with no identity. Graph list edges return objects; anything
  // else is dropped and COUNTED, because a silently shorter list is the one
  // failure the caller cannot detect.
  let items: readonly T[] = [];
  let dropped = 0;
  if (Array.isArray(rawData)) {
    const rows = rawData as readonly unknown[];
    const kept = rows.filter(isRow);
    dropped = rows.length - kept.length;
    items = kept as readonly T[];
  }

  let hasNext = false;
  let after: Cursor | undefined;

  const paging: unknown = isRecord(body) ? body.paging : undefined;
  if (isRecord(paging)) {
    const next: unknown = paging.next;
    hasNext = typeof next === 'string' && next.length > 0;

    const cursors: unknown = paging.cursors;
    const cursorAfter: unknown = isRecord(cursors) ? cursors.after : undefined;
    if (typeof cursorAfter === 'string' && cursorAfter.length > 0) {
      // Prefer the explicit opaque cursor over parsing the token-bearing URL.
      after = cursorAfter;
    } else if (typeof next === 'string') {
      after = extractAfterParam(next);
    }
  }

  return { items, listed: Array.isArray(rawData), dropped, hasNext, after };
}

/** Build and issue one GET page request, returning the parsed page. */
async function requestPage<T>(
  fbRequest: FbRequestFn,
  edge: EdgeRequest,
  limit: number | undefined,
  after: Cursor | undefined,
): Promise<ParsedPage<T>> {
  const params: Record<string, ParamValue> = { ...(edge.params ?? {}) };
  if (limit !== undefined) params.limit = limit;
  if (after !== undefined) params.after = after;

  const req: JsonRequest = {
    protocol: 'json',
    method: 'GET',
    host: edge.host,
    path: edge.path,
    params,
    pageId: edge.pageId,
    token: edge.token,
    timeoutMs: edge.timeoutMs,
    signal: edge.signal,
  };

  const res = await fbRequest<unknown>(req);
  return parsePage<T>(res.data);
}

// ---------------------------------------------------------------------------
// Internal: Page<T> construction
// ---------------------------------------------------------------------------

function makePage<T>(
  data: readonly T[],
  truncated: boolean,
  nextCursor: Cursor | undefined,
  note: string | undefined,
): Page<T> {
  const page: {
    data: readonly T[];
    truncated: boolean;
    nextCursor?: Cursor;
    note?: string;
  } = { data, truncated };
  if (nextCursor !== undefined) page.nextCursor = nextCursor;
  if (note !== undefined) page.note = note;
  return page;
}

/**
 * Join the notes a single result may owe the caller. A dropped-row count and a
 * budget note describe different things — how trustworthy the rows are, and
 * whether there are more of them — so one must never overwrite the other.
 */
function joinNotes(...notes: (string | undefined)[]): string | undefined {
  const present = notes.filter((n): n is string => n !== undefined && n.length > 0);
  return present.length > 0 ? present.join('; ') : undefined;
}

function itemBudgetNote(maxItems: number): string {
  return `result budget reached (kept the first ${String(maxItems)} items) — narrow the query or raise maxItems`;
}

function pageBudgetNote(maxPages: number): string {
  return `page budget reached (${String(maxPages)} pages) — narrow the query or resume from the returned cursor`;
}

/**
 * Finalize an accumulated walk. When `maxItems` sliced mid-page the page-level
 * cursor cannot resume without dropping the remainder of the current page, so we
 * drop the resume cursor and let the note tell the caller to raise `maxItems`.
 */
function finish<T>(
  items: readonly T[],
  maxItems: number | undefined,
  truncated: boolean,
  note: string | undefined,
  nextCursor: Cursor | undefined,
): Page<T> {
  let data = items;
  let cursor = nextCursor;
  let partial = truncated;
  let reason = note;
  if (maxItems !== undefined && data.length > maxItems) {
    // The slice is the only place that knows rows were discarded, so it also
    // owns saying so. Callers that stop because the edge ENDED arrive here with
    // `truncated: false` and no note; without this the result reads as a
    // complete listing that happens to be exactly `maxItems` long, and the
    // shortfall is the one thing a caller cannot detect from the page itself.
    data = data.slice(0, maxItems);
    cursor = undefined;
    partial = true;
    reason = joinNotes(reason, itemBudgetNote(maxItems));
  }
  return makePage(data, partial, cursor, reason);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read a SINGLE edge page. `page.after` resumes from a prior page's
 * `nextCursor`; the returned `nextCursor` (present only when `paging.next`
 * exists) resumes the next one. `truncated` is `false` for a normal page and
 * `true` when the walk cannot be continued although more rows exist — the cursor
 * expired (partial: empty data + restart note), Graph advertised a next page
 * without handing back an `after` to reach it (CC-PAGE-3), or the `after` it
 * handed back is the one this page was requested with (loop guard).
 */
export async function fetchPage<T>(
  fbRequest: FbRequestFn,
  edge: EdgeRequest,
  page: PageRequest = {},
): Promise<Page<T>> {
  const limit = page.limit ?? DEFAULT_PAGE_LIMIT;
  try {
    const parsed = await requestPage<T>(fbRequest, edge, limit, page.after);
    if (!parsed.listed) {
      // No `data` array is no answer about the rows, and `data: []` with
      // `truncated: false` is the one shape that means "there is nothing here".
      return makePage<T>([], true, undefined, NO_LIST_RETURNED_NOTE);
    }
    const dropNote = parsed.dropped > 0 ? malformedRowsNote(parsed.dropped) : undefined;
    if (parsed.hasNext && parsed.after === undefined) {
      // Graph promised a next page but gave no cursor to reach it. Reporting
      // `truncated: false` with no `nextCursor` here would be indistinguishable
      // from a terminal page, so the caller would stop and call the listing
      // complete while rows remain. `fetchAll` already treats this exact wire
      // shape as truncated (MISSING_CURSOR_NOTE); the two must not disagree
      // about the same response.
      return makePage(
        parsed.items,
        true,
        undefined,
        joinNotes(dropNote, MISSING_CURSOR_NOTE),
      );
    }
    if (parsed.hasNext && page.after !== undefined && parsed.after === page.after) {
      // Graph advertised a next page whose cursor is the one this request was
      // made with. Handing it back as `nextCursor` sends the caller round the
      // same page indefinitely; `fetchAll` stops on this exact response with
      // LOOP_GUARD_NOTE, and the single-page read must say the same thing.
      return makePage(
        parsed.items,
        true,
        undefined,
        joinNotes(dropNote, LOOP_GUARD_NOTE),
      );
    }
    const nextCursor = parsed.hasNext ? parsed.after : undefined;
    return makePage(parsed.items, false, nextCursor, dropNote);
  } catch (err) {
    if (isCursorExpiryError(err)) {
      return makePage<T>([], true, undefined, CURSOR_EXPIRED_NOTE);
    }
    throw err;
  }
}

/**
 * Walk `paging.next` accumulating whole pages until either budget cap is hit or
 * the edge ends (`paging.next` absent). Sets `truncated: true` when it stopped
 * early (budget or cursor expiry) and keeps the FIRST items. Only cursor-expiry
 * errors become partial results; every other error propagates (the retry/backoff
 * matrix lives inside `fbRequest`). Guaranteed to terminate (CC-PAGE-5).
 */
export async function fetchAll<T>(
  fbRequest: FbRequestFn,
  edge: EdgeRequest,
  budget: FetchAllBudget = {},
  page: PageRequest = {},
): Promise<Page<T>> {
  const limit = page.limit ?? DEFAULT_PAGE_LIMIT;
  const maxItems =
    budget.maxItems !== undefined &&
    Number.isFinite(budget.maxItems) &&
    budget.maxItems > 0
      ? Math.floor(budget.maxItems)
      : undefined;
  // Always a finite, positive cap → unconditional termination guarantee.
  const maxPages =
    budget.maxPages !== undefined &&
    Number.isFinite(budget.maxPages) &&
    budget.maxPages > 0
      ? Math.floor(budget.maxPages)
      : DEFAULT_MAX_PAGES;

  const items: T[] = [];
  // The seed cursor counts as already walked: a resumed walk whose first page
  // hands the same cursor straight back must stop on that first repeat, not
  // re-issue the identical request once more.
  const seen = new Set<Cursor>(page.after !== undefined ? [page.after] : []);
  let cursor: Cursor | undefined = page.after;
  let pagesWalked = 0;
  // Dropped rows accumulate across the WHOLE walk: one unusable row on page 3 of
  // a 10-page listing is just as invisible in the total as one on page 1, and a
  // count reset per page would report the last page's drops as the walk's.
  let droppedTotal = 0;

  /** Finish the walk, carrying the drop count alongside whatever stopped it. */
  const done = (
    truncated: boolean,
    note: string | undefined,
    nextCursor: Cursor | undefined,
  ): Page<T> =>
    finish<T>(
      items,
      maxItems,
      truncated,
      joinNotes(droppedTotal > 0 ? malformedRowsNote(droppedTotal) : undefined, note),
      nextCursor,
    );

  for (;;) {
    let parsed: ParsedPage<T>;
    try {
      parsed = await requestPage<T>(fbRequest, edge, limit, cursor);
    } catch (err) {
      if (isCursorExpiryError(err)) {
        return done(true, CURSOR_EXPIRED_NOTE, undefined);
      }
      throw err;
    }

    if (!parsed.listed) {
      // Ending here as a terminal page would hand back the rows so far as the
      // whole edge; the page that failed to list is exactly where it stopped.
      return done(true, NO_LIST_RETURNED_NOTE, undefined);
    }

    pagesWalked += 1;
    droppedTotal += parsed.dropped;
    for (const item of parsed.items) items.push(item);

    if (!parsed.hasNext) {
      // paging.next absent = end of iteration; a complete walk is not truncated.
      return done(false, undefined, undefined);
    }

    // A further page exists — decide whether to keep walking. The cursor's
    // sanity is settled first: a budget stop hands `parsed.after` back as the
    // resume point, and a cursor that is missing, or that did not advance, is
    // not one — resuming from it re-fetches this same page or nothing at all.
    // Reporting "resume from the returned cursor" on such a page would
    // contradict what `fetchPage` says about the identical response.
    if (parsed.after === undefined) {
      return done(true, MISSING_CURSOR_NOTE, undefined);
    }
    if (seen.has(parsed.after)) {
      return done(true, LOOP_GUARD_NOTE, undefined);
    }
    if (maxItems !== undefined && items.length >= maxItems) {
      // `finish` states the budget whenever it slices; on an exact boundary
      // there is nothing to slice, so the note has to be raised here instead.
      const willSlice = items.length > maxItems;
      return done(true, willSlice ? undefined : itemBudgetNote(maxItems), parsed.after);
    }
    if (pagesWalked >= maxPages) {
      return done(true, pageBudgetNote(maxPages), parsed.after);
    }
    seen.add(parsed.after);
    cursor = parsed.after;
  }
}
