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
 * True when a thrown error is a Graph cursor-expiry (CC-PAGE-2). Prefers the
 * authoritative `ErrorAction.category` set by F06's error matrix; falls back to a
 * message heuristic so the helper still recognizes expiry before the matrix runs.
 */
export function isCursorExpiryError(err: unknown): err is GraphApiError {
  if (!(err instanceof GraphApiError)) return false;
  if (err.action?.category === 'cursor_expired') return true;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('cursor') &&
    (msg.includes('expire') || msg.includes('invalid') || msg.includes('no longer valid'))
  );
}

// ---------------------------------------------------------------------------
// Internal: defensive Graph-page parsing
// ---------------------------------------------------------------------------

interface ParsedPage<T> {
  readonly items: readonly T[];
  /** Whether `paging.next` is present (there is a further page to walk). */
  readonly hasNext: boolean;
  /** The opaque forward cursor for the NEXT page, when extractable. */
  readonly after?: Cursor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
  const items: readonly T[] = Array.isArray(rawData) ? (rawData as readonly T[]) : [];

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

  return { items, hasNext, after };
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
  if (maxItems !== undefined && data.length > maxItems) {
    data = data.slice(0, maxItems);
    cursor = undefined;
  }
  return makePage(data, truncated, cursor, note);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read a SINGLE edge page. `page.after` resumes from a prior page's
 * `nextCursor`; the returned `nextCursor` (present only when `paging.next`
 * exists) resumes the next one. `truncated` is `false` for a normal page and
 * `true` only when the cursor expired (partial: empty data + restart note).
 */
export async function fetchPage<T>(
  fbRequest: FbRequestFn,
  edge: EdgeRequest,
  page: PageRequest = {},
): Promise<Page<T>> {
  const limit = page.limit ?? DEFAULT_PAGE_LIMIT;
  try {
    const parsed = await requestPage<T>(fbRequest, edge, limit, page.after);
    const nextCursor = parsed.hasNext ? parsed.after : undefined;
    return makePage(parsed.items, false, nextCursor, undefined);
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
  const seen = new Set<Cursor>();
  let cursor: Cursor | undefined = page.after;
  let pagesWalked = 0;

  for (;;) {
    let parsed: ParsedPage<T>;
    try {
      parsed = await requestPage<T>(fbRequest, edge, limit, cursor);
    } catch (err) {
      if (isCursorExpiryError(err)) {
        return finish<T>(items, maxItems, true, CURSOR_EXPIRED_NOTE, undefined);
      }
      throw err;
    }

    pagesWalked += 1;
    for (const item of parsed.items) items.push(item);

    if (!parsed.hasNext) {
      // paging.next absent = end of iteration; a complete walk is not truncated.
      return finish<T>(items, maxItems, false, undefined, undefined);
    }

    // A further page exists — decide whether to keep walking.
    if (maxItems !== undefined && items.length >= maxItems) {
      return finish<T>(items, maxItems, true, itemBudgetNote(maxItems), parsed.after);
    }
    if (pagesWalked >= maxPages) {
      return finish<T>(items, maxItems, true, pageBudgetNote(maxPages), parsed.after);
    }
    if (parsed.after === undefined) {
      return finish<T>(items, maxItems, true, MISSING_CURSOR_NOTE, undefined);
    }
    if (seen.has(parsed.after)) {
      return finish<T>(items, maxItems, true, LOOP_GUARD_NOTE, undefined);
    }
    seen.add(parsed.after);
    cursor = parsed.after;
  }
}
