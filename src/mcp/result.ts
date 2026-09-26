// MCP result shaper (task F12, clusters C3 / CC-PAGE-4 / CC-MCP-4 / CC-MCP-7).
//
// Turns a raw typed payload (the parsed Graph `data`, or a server-owned
// envelope) into an MCP {@link ToolResult}. Four responsibilities, applied in a
// fixed order so security always precedes size management:
//
//   1. STRUCTURAL token/paging strip (C3 / CC-PAGE-4). Graph embeds the live
//      `access_token` in `paging.next` / `paging.previous` / `paging.cursors`
//      URLs — including nested field-expansion paging — so the shaper walks the
//      payload and (a) drops every `paging` object recursively and (b) neutralizes
//      any `access_token=…` occurrence inside any remaining string, plus any
//      token-bearing field. Cursors surface only as opaque `after` values (owned
//      by the pagination helper), never as token-bearing URLs. Depth/cycle-safe.
//      The same walk is also where the payload becomes JSON-SAFE: `http.ts`
//      returns `data as T` — a cast, never a validation — so every step after
//      this one would otherwise be trusting a shape nobody checked. A shaper
//      that throws converts a successful Graph call into a crash, which costs
//      the operator both the answer and the reason.
//
//   2. VALUE redaction (C3). The stripped clone is passed through the injected
//      {@link Redactor} — the single value-based choke-point that scrubs raw
//      secret VALUES (EAA tokens, app secret, appsecret_proof, FB_HTTP_TOKEN,
//      `{app-id}|{app-secret}`) wherever they survive. Defense in depth: the
//      shaper strips tokens structurally AND redacts values.
//
//   3. STRUCTURE-AWARE truncation (CC-MCP-4). If the compact JSON exceeds
//      `maxResultChars` the shaper first drops any string leaf longer than the
//      whole budget (it could never be shown), then trims arrays (largest first, via a prefix
//      binary search) and drops oversized string leaves — never a mid-string or
//      mid-structure cut — and appends an honest truncation note. The output is
//      always valid JSON.
//
//   4. RENDER. Ordinary tool results are text-only (CC-MCP-7): a single compact
//      JSON {@link ToolTextContent}. `structuredContent` is emitted ONLY for
//      server-owned envelopes (whoami / usage) via {@link shapeEnvelope}, whose
//      structured field is left un-truncated so it stays valid against the
//      tool's `outputSchema`.

import type { Redactor, ToolResult, ToolTextContent } from '../core/index.js';
import { isTainted, TAINT_WARNING_SHORT } from './taint.js';

/** Marker substituted for a stripped access token (distinct from the redactor's placeholder). */
const STRIPPED_TOKEN = '[STRIPPED_TOKEN]';

/** Marker substituted for a node that closes a reference cycle (keeps output JSON-safe). */
const CIRCULAR = '[CIRCULAR]';

/** Marker substituted for a subtree deeper than {@link MAX_DEPTH}. */
const TRUNCATED = '[TRUNCATED]';

/** Marker substituted for a property whose accessor threw while being read. */
const UNREADABLE = '[UNREADABLE]';

/**
 * How far the strip will descend before cutting the subtree off.
 *
 * `JSON.parse` accepts nesting thousands of levels deep, so the body arriving
 * from Graph has ALREADY been accepted by the parser: a plain recursive walk
 * blows the stack somewhere past ~4 000 levels and turns a successful call into
 * a `RangeError` the tool cannot recover from. Nesting depth is not ours to
 * choose — it is a field of an attacker-influenced response — so the walk has
 * to be the robust half of the pair. Two hundred is far past anything Graph
 * returns and far short of the recursion limit; it matches the same cap in
 * `core/redact.ts`, which runs immediately after this on the same clone.
 */
const MAX_DEPTH = 200;

/** Graph's pagination metadata key — dropped wholesale (C3 / CC-PAGE-4). */
const PAGING_KEY = 'paging';

/** Field names whose string value is a raw credential and is neutralized structurally. */
const TOKEN_KEYS: ReadonlySet<string> = new Set([
  'access_token',
  'client_secret',
  'appsecret_proof',
  'client_token',
]);

/** Neutralizes an `access_token=<value>` occurrence inside any string (URL query, etc.). */
const ACCESS_TOKEN_IN_STRING = /access_token=[^&#\s"']*/gi;

/**
 * Chars held back from the budget so the truncation note appended afterwards
 * still fits under `maxResultChars`. It has to cover the longest note the
 * builder can emit plus the JSON that carries it; a test pins that against the
 * smallest `FB_MAX_RESULT_CHARS` the settings loader accepts.
 */
const NOTE_RESERVE = 256;

/** String leaves longer than this are candidates for dropping during truncation. */
const BIG_STRING_THRESHOLD = 128;

/** Reserved key that carries the truncation note inside the (still-valid) JSON. */
const TRUNCATION_KEY = '_truncation';

/** Inputs the shaper needs from the tool context. */
export interface ShapeOptions {
  /** Structure-aware truncation budget in characters (`Settings.maxResultChars`). */
  readonly maxResultChars: number;
  /** Value-based redaction choke-point, applied as the final security pass (C3). */
  readonly redactor: Redactor;
  /** Marks the produced result as an error result (`ToolResult.isError`). */
  readonly isError?: boolean;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Shape an ordinary typed payload into a TEXT-ONLY {@link ToolResult}: strip
 * paging/token URLs (C3 / CC-PAGE-4) → redact values (C3) → structure-aware
 * truncate to `maxResultChars` (CC-MCP-4) → compact JSON. Never emits
 * `structuredContent` (CC-MCP-7). The input is never mutated.
 */
export function shapeResult(payload: unknown, options: ShapeOptions): ToolResult {
  const stripped = stripPagingAndTokens(payload);
  const redacted = options.redactor.redact(stripped);
  const text = renderWithBudget(
    redacted,
    options.maxResultChars,
    options.isError === true,
  );
  return buildResult(text, options.isError);
}

/**
 * Shape a SERVER-OWNED envelope (whoami / usage) into a {@link ToolResult} that
 * carries both the compact JSON text and a `structuredContent` field (CC-MCP-7).
 * The same structural strip + value redaction run (defense in depth), but the
 * envelope is deliberately NOT truncated: it is small and server-authored, and
 * trimming it would break validation against the tool's `outputSchema`.
 */
export function shapeEnvelope(
  payload: Readonly<Record<string, unknown>>,
  options: ShapeOptions,
): ToolResult {
  const stripped = stripPagingAndTokens(payload);
  const structured = asRecord(options.redactor.redact(stripped));
  const content: ToolTextContent[] = [{ type: 'text', text: compact(structured) }];
  return options.isError === undefined
    ? { content, structuredContent: structured }
    : { content, structuredContent: structured, isError: options.isError };
}

/**
 * Recursively remove Graph `paging` objects and neutralize every token-bearing
 * URL/field (C3 / CC-PAGE-4). Returns a fresh structural clone — the input is
 * never mutated — and is cycle-safe (a back-edge collapses to `[CIRCULAR]`).
 * Exported so other `mcp` code and tests can reuse the strip in isolation.
 */
export function stripPagingAndTokens(value: unknown): unknown {
  return stripValue(value, new WeakSet<object>(), 0);
}

// ---------------------------------------------------------------------------
// Structural token/paging strip
// ---------------------------------------------------------------------------

function stripString(input: string): string {
  return input.replace(ACCESS_TOKEN_IN_STRING, `access_token=${STRIPPED_TOKEN}`);
}

/**
 * Write one own property onto the clone.
 *
 * `out[key] = v` is wrong for exactly one key: `__proto__` is an accessor on
 * `Object.prototype`, so a plain assignment re-parents the clone instead of
 * storing the field. `JSON.parse` produces `__proto__` as an ordinary own data
 * property, which means Graph — or anything upstream of it — can hand the
 * shaper a record whose `__proto__` value is a normal object. The clone would
 * then silently lose a key the operator was told they were reading, and every
 * later `in` test on that clone would start consulting a prototype chosen by
 * the payload. Defining the property keeps it a plain field on a plain object.
 */
function setOwn(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(out, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return;
  }
  out[key] = value;
}

/**
 * Read one property without letting a hostile or merely broken accessor take
 * the whole response down. The key survives with a marker for its value, so the
 * shape of what Graph returned is still legible.
 */
function readOwn(obj: Record<string, unknown>, key: string): unknown {
  try {
    return obj[key];
  } catch {
    return UNREADABLE;
  }
}

/**
 * Clone `value`, stripping paging and tokens — and, just as importantly,
 * returning something `JSON.stringify` will accept. `src/core/http.ts` hands
 * back `data as T`, a cast and never a validation, so this walk is where the
 * payload stops being a hope and starts being a known-serializable structure:
 * a `bigint` becomes its digits rather than a thrown `TypeError`, functions and
 * symbols are dropped the way `JSON.stringify` would drop them (which also
 * disposes of a `toJSON` that throws), and an accessor that throws costs its
 * own key instead of the whole result.
 */
function stripValue(value: unknown, ancestors: WeakSet<object>, depth: number): unknown {
  if (typeof value === 'string') return stripString(value);
  // `JSON.stringify` throws on a bigint rather than skipping it; its digits are
  // the only lossless rendering that survives a JSON round-trip.
  if (typeof value === 'bigint') return `${value}`;
  // Dropped rather than kept: `JSON.stringify` omits both, and carrying a
  // function through the clone is what lets a throwing `toJSON` reach the
  // serializer and take the response with it.
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value === null || typeof value !== 'object') return value;

  // Leaf object types: kept by value, never structurally walked.
  if (value instanceof Date) return new Date(value.getTime());
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;

  // Leaves above are kept at any depth; only further DESCENT stops here, so the
  // cut costs a subtree and never a stripped token.
  if (depth >= MAX_DEPTH) return TRUNCATED;

  // `ancestors` holds the nodes on the current walk, so a back-edge (true cycle)
  // is broken while a shared acyclic node is simply re-walked (safe: re-cloned).
  if (ancestors.has(value)) return CIRCULAR;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => stripValue(item, ancestors, depth + 1));
    }
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    let keys: string[];
    try {
      keys = Object.keys(obj);
    } catch {
      // A Proxy may refuse even to enumerate. Dropping the contents is lossy;
      // throwing here would cost the operator the whole call.
      keys = [];
    }
    for (const key of keys) {
      if (key === PAGING_KEY) continue; // drop the paging object wholesale
      const raw = readOwn(obj, key);
      if (TOKEN_KEYS.has(key) && typeof raw === 'string') {
        setOwn(out, key, STRIPPED_TOKEN); // token-bearing field
        continue;
      }
      setOwn(out, key, stripValue(raw, ancestors, depth + 1));
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

// ---------------------------------------------------------------------------
// Structure-aware truncation
// ---------------------------------------------------------------------------

/**
 * A reducible array slot. Trimming happens IN PLACE (the array object keeps its
 * identity) rather than by writing a fresh `slice` into the parent, because the
 * child sites collected from inside it hold setters that close over this exact
 * object: replacing it would detach every one of them, so a later string drop
 * inside a RETAINED element would write into an orphan and change nothing in the
 * rendered output. The snapshot the prefix search restores from is taken when
 * the array's turn comes, not here — see {@link reduceToBudget}.
 */
interface ArraySite {
  readonly arr: unknown[];
  readonly size: number;
}

/**
 * A reducible large-string slot: its length plus a setter into its parent.
 * `replacement`, when present, is written instead of the `[dropped N chars]`
 * marker — see {@link collectSites} for the one slot that carries it.
 */
interface StringSite {
  readonly len: number;
  readonly set: (v: unknown) => void;
  readonly replacement?: string;
}

function droppedMarker(site: StringSite): string {
  return site.replacement ?? `[dropped ${site.len} chars]`;
}

interface Reduction {
  readonly root: unknown;
  readonly items: number;
  readonly fields: number;
  /** Taint warnings swapped for their short form — no data lost. */
  readonly shortened: number;
  readonly hard: boolean;
}

/**
 * Compact JSON that cannot throw. {@link stripValue} has already made the clone
 * serializable, so the fallback should be unreachable — but it runs on the last
 * line before the result leaves the process, and a shaper that throws here
 * hands the operator a crash in place of the answer they asked for. A sentinel
 * that says which call produced nothing is strictly more useful than a stack.
 */
function compact(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '{"_unserializable":"the result could not be rendered as JSON"}';
  }
}

function measure(value: unknown): number {
  return compact(value).length;
}

/**
 * Render `value` as compact JSON, structure-aware-truncating to `budget` chars
 * when needed (CC-MCP-4). Assumes `value` is already stripped + redacted (and
 * therefore JSON-safe, with cycles broken).
 */
function renderWithBudget(value: unknown, budget: number, isError: boolean): string {
  const full = compact(value);
  if (full.length <= budget) return full;

  const effectiveBudget = Math.max(0, budget - NOTE_RESERVE);
  const { root, items, fields, shortened, hard } = reduceToBudget(value, effectiveBudget);
  const note = buildNote(budget, { items, fields, shortened, hard }, isError);
  return compact(withNote(root, note));
}

function collectSites(
  value: unknown,
  set: (v: unknown) => void,
  seen: WeakSet<object>,
  arrays: ArraySite[],
  strings: StringSite[],
): void {
  if (typeof value === 'string') {
    if (value.length > BIG_STRING_THRESHOLD) strings.push({ len: value.length, set });
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    const arr = value as unknown[];
    arrays.push({ arr, size: measure(arr) });
    arr.forEach((item, index) => {
      collectSites(
        item,
        (nv) => {
          // The prefix search shortens this array in place, so an index past the
          // retained prefix no longer exists. Writing to it would re-grow the array
          // with a hole — `null` in the rendered JSON, and a longer result than the
          // budget the drop was meant to buy.
          if (index < arr.length) arr[index] = nv;
        },
        seen,
        arrays,
        strings,
      );
    });
    return;
  }

  const obj = value as Record<string, unknown>;
  const envelope = isTainted(value);
  for (const key of Object.keys(obj)) {
    const item = obj[key];
    // A taint envelope's warning is the longest string in most small results,
    // so it was the first thing the large-field lever dropped — delivering the
    // untrusted content it guards with nothing left saying it is untrusted.
    // Shrinking a result must not cost its security label: the warning is
    // shortened to a fixed form, never dropped.
    if (envelope && key === 'warning' && typeof item === 'string') {
      if (item.length > TAINT_WARNING_SHORT.length) {
        strings.push({
          len: item.length,
          set: (nv) => {
            obj[key] = nv;
          },
          replacement: TAINT_WARNING_SHORT,
        });
      }
      continue;
    }
    collectSites(
      item,
      (nv) => {
        obj[key] = nv;
      },
      seen,
      arrays,
      strings,
    );
  }
}

/**
 * Reset `arr` in place to the first `n` elements of its snapshot. In place, not a
 * fresh array, so the setters that child sites closed over keep pointing at the
 * live node (see {@link ArraySite}); restoring from `original` is what lets the
 * prefix search walk back up after overshooting.
 */
function setPrefix(arr: unknown[], original: readonly unknown[], n: number): void {
  arr.length = 0;
  for (let i = 0; i < n; i += 1) arr.push(original[i]);
}

function reduceToBudget(value: unknown, budget: number): Reduction {
  let root = value;
  const arrays: ArraySite[] = [];
  const strings: StringSite[] = [];
  collectSites(
    root,
    (nv) => {
      root = nv;
    },
    new WeakSet<object>(),
    arrays,
    strings,
  );

  let items = 0;
  let fields = 0;
  let shortened = 0;
  // A site with a `replacement` is a taint warning being shortened, not data
  // being dropped: counting it as a "large field" told the model content was
  // missing and sent it to re-query for what it already had.
  const count = (site: StringSite): void => {
    if (site.replacement !== undefined) shortened += 1;
    else fields += 1;
  };

  // Lever 0: a string leaf longer than the whole budget can never be rendered,
  // whatever else is cut, so dropping it first costs nothing that could have
  // survived. Leaving it to lever 2 lets lever 1 empty every array it shares the
  // result with first: one post longer than the budget wiped its whole page (and
  // `nextCursor` then resumed past all of it), and one long preview summary cost
  // the warnings the model must read before applying.
  const dropped = new Set<StringSite>();
  for (const site of strings) {
    if (site.len <= budget) continue;
    if (measure(root) <= budget) break;
    const before = measure(root);
    site.set(droppedMarker(site));
    dropped.add(site);
    if (measure(root) < before) count(site);
  }

  // Lever 1: trim arrays, biggest first, each to the largest prefix that fits.
  arrays.sort((a, b) => b.size - a.size);
  for (const site of arrays) {
    if (measure(root) <= budget) break;
    const { arr } = site;
    // Snapshot NOW, not at collection time: lever 0 writes its marker straight
    // into the array slot when the oversized string is a direct element, and a
    // snapshot taken before that restores the full string on the first probe —
    // no prefix containing it fits, so the whole list was emptied around a
    // string that had already been dropped.
    const original = arr.slice();
    const before = measure(root);
    let lo = 0;
    let hi = original.length;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      setPrefix(arr, original, mid);
      if (measure(root) <= budget) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    setPrefix(arr, original, best);
    // Sorting biggest-first means an outer array is trimmed before the arrays
    // nested in its tail, and those are no longer part of `root` at all. Trimming
    // one is harmless but counting it would inflate the note with items the caller
    // never lost here — so only a reduction the rendered root actually felt counts.
    if (original.length > best && measure(root) < before) items += original.length - best;
  }

  // Lever 2: drop oversized string leaves (never a mid-string cut).
  if (measure(root) > budget) {
    strings.sort((a, b) => b.len - a.len);
    for (const site of strings) {
      if (measure(root) <= budget) break;
      if (dropped.has(site)) continue;
      const before = measure(root);
      site.set(droppedMarker(site));
      // Same honesty guard as above: a string that lived in a dropped array tail is
      // already gone from the output, so replacing it is a no-op worth no mention.
      if (measure(root) < before) count(site);
    }
  }

  // Final guard: pathological payload (no reducible arrays/strings). Replace the
  // body with a short sentinel so the rendered size stops tracking the input's:
  // what survives is the sentinel plus the note, which `NOTE_RESERVE` covers for
  // every budget `FB_MAX_RESULT_CHARS` can hold.
  let hard = false;
  if (measure(root) > budget) {
    root = salvageScalars(
      root,
      {
        dropped: 'payload exceeded FB_MAX_RESULT_CHARS after structural reduction',
      },
      budget,
    );
    hard = true;
  }

  return { root, items, fields, shortened, hard };
}

/**
 * Build the final-guard body: the sentinel, plus as many of the reduced root's
 * top-level scalar fields as still fit, smallest first.
 *
 * Every thrown error reaches the model through this shaper, and its record is
 * exactly the shape the other levers cannot touch — a dozen short scalars, no
 * array, no string past {@link BIG_STRING_THRESHOLD}. Replacing the whole record
 * with a sentinel handed the model an error with no `category`, `retryable` or
 * `nextTool`: nothing to decide a retry on. Those are the smallest fields in the
 * record, so smallest-first keeps them. A taint envelope is never salvaged
 * piecemeal: its `content` must not outlive its `warning`.
 */
function salvageScalars(
  reduced: unknown,
  sentinel: Record<string, unknown>,
  budget: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...sentinel };
  if (reduced === null || typeof reduced !== 'object' || Array.isArray(reduced))
    return out;
  if (isTainted(reduced)) return out;
  const obj = reduced as Record<string, unknown>;
  const candidates = Object.keys(obj)
    .filter((key) => !(key in out))
    .map((key) => ({ key, value: obj[key] }))
    .filter(
      ({ value }) =>
        value === null ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        typeof value === 'string',
    )
    .map((c) => ({ ...c, size: measure({ [c.key]: c.value }) }))
    .sort((a, b) => a.size - b.size);
  for (const { key, value } of candidates) {
    setOwn(out, key, value);
    if (measure(out) > budget) {
      delete out[key];
      break; // sorted smallest-first: nothing after this fits either
    }
  }
  return out;
}

function buildNote(
  budget: number,
  { items, fields, shortened, hard }: Omit<Reduction, 'root'>,
  isError: boolean,
): string {
  const head = `Result truncated to fit FB_MAX_RESULT_CHARS=${budget}:`;
  if (items === 0 && fields === 0 && !hard && shortened > 0) {
    return `${head} shortened ${shortened} untrusted-content warning(s); no data was dropped.`;
  }
  const parts: string[] = [];
  if (items > 0) parts.push(`${items} list item(s)`);
  if (fields > 0) parts.push(`${fields} large field(s)`);
  const what = parts.length > 0 ? parts.join(' and ') : 'content';
  // Kept short: every word here comes out of NOTE_RESERVE, and a hard cut has
  // replaced the body the warnings sat in anyway.
  const tail = hard
    ? ' Result exceeded the budget even after reduction.'
    : shortened > 0
      ? ` Warnings shortened: ${shortened}.`
      : '';
  // Never "paginate to see the rest": a `nextCursor` resumes after the page Graph
  // returned, not after the prefix kept here, so what was dropped is not on the
  // next page — the advice would send the model past it believing it had seen it.
  // An error result is not a listing: there is no query to narrow and no page
  // to re-request — re-running the call narrower returns the same refusal, not
  // the text cut here. What is true is that the fields kept still decide the
  // next step, and only a larger budget shows the rest.
  const advice = isError
    ? ' Error result: act on the fields kept here; a larger FB_MAX_RESULT_CHARS shows the rest.'
    : items > 0
      ? ' Dropped list items are not on the next page: re-request with a smaller limit to see them.'
      : ' Narrow the query to see the rest; the next page does not repeat what was dropped.';
  return `${head} dropped ${what}.${advice}${tail}`;
}

/** Attach the truncation note without invalidating the JSON (append a field / wrap). */
function withNote(value: unknown, note: string): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    let key = TRUNCATION_KEY;
    while (key in obj) key = `${key}_`;
    return { ...obj, [key]: note };
  }
  return { data: value, [TRUNCATION_KEY]: note };
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function buildResult(text: string, isError?: boolean): ToolResult {
  const content: ToolTextContent[] = [{ type: 'text', text }];
  return isError === undefined ? { content } : { content, isError };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  // The envelope input is constrained to a record; this guards the redactor's
  // `unknown` return type without silently dropping a non-record value.
  return { value };
}
