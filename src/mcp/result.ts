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
//
//   2. VALUE redaction (C3). The stripped clone is passed through the injected
//      {@link Redactor} — the single value-based choke-point that scrubs raw
//      secret VALUES (EAA tokens, app secret, appsecret_proof, FB_HTTP_TOKEN,
//      `{app-id}|{app-secret}`) wherever they survive. Defense in depth: the
//      shaper strips tokens structurally AND redacts values.
//
//   3. STRUCTURE-AWARE truncation (CC-MCP-4). If the compact JSON exceeds
//      `maxResultChars` the shaper trims arrays (largest first, via a prefix
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

/** Marker substituted for a stripped access token (distinct from the redactor's placeholder). */
const STRIPPED_TOKEN = '[STRIPPED_TOKEN]';

/** Marker substituted for a node that closes a reference cycle (keeps output JSON-safe). */
const CIRCULAR = '[CIRCULAR]';

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

/** Chars reserved so the appended truncation note still fits under `maxResultChars`. */
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
  const text = renderWithBudget(redacted, options.maxResultChars);
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
  return stripValue(value, new WeakSet<object>());
}

// ---------------------------------------------------------------------------
// Structural token/paging strip
// ---------------------------------------------------------------------------

function stripString(input: string): string {
  return input.replace(ACCESS_TOKEN_IN_STRING, `access_token=${STRIPPED_TOKEN}`);
}

function stripValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof value === 'string') return stripString(value);
  if (value === null || typeof value !== 'object') return value;

  // Leaf object types: kept by value, never structurally walked.
  if (value instanceof Date) return new Date(value.getTime());
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;

  // `ancestors` holds the nodes on the current walk, so a back-edge (true cycle)
  // is broken while a shared acyclic node is simply re-walked (safe: re-cloned).
  if (ancestors.has(value)) return CIRCULAR;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => stripValue(item, ancestors));
    }
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      if (key === PAGING_KEY) continue; // drop the paging object wholesale
      const raw = obj[key];
      if (TOKEN_KEYS.has(key) && typeof raw === 'string') {
        out[key] = STRIPPED_TOKEN; // token-bearing field
        continue;
      }
      out[key] = stripValue(raw, ancestors);
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
 * rendered output. `original` is the snapshot the prefix search restores from.
 */
interface ArraySite {
  readonly arr: unknown[];
  readonly original: readonly unknown[];
  readonly size: number;
}

/** A reducible large-string slot: its length plus a setter into its parent. */
interface StringSite {
  readonly len: number;
  readonly set: (v: unknown) => void;
}

interface Reduction {
  readonly root: unknown;
  readonly items: number;
  readonly fields: number;
  readonly hard: boolean;
}

function compact(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

function measure(value: unknown): number {
  return compact(value).length;
}

/**
 * Render `value` as compact JSON, structure-aware-truncating to `budget` chars
 * when needed (CC-MCP-4). Assumes `value` is already stripped + redacted (and
 * therefore JSON-safe, with cycles broken).
 */
function renderWithBudget(value: unknown, budget: number): string {
  const full = compact(value);
  if (full.length <= budget) return full;

  const effectiveBudget = Math.max(0, budget - NOTE_RESERVE);
  const { root, items, fields, hard } = reduceToBudget(value, effectiveBudget);
  const note = buildNote(budget, items, fields, hard);
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
    arrays.push({ arr, original: arr.slice(), size: measure(arr) });
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
  for (const key of Object.keys(obj)) {
    collectSites(
      obj[key],
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

  // Lever 1: trim arrays, biggest first, each to the largest prefix that fits.
  arrays.sort((a, b) => b.size - a.size);
  for (const site of arrays) {
    if (measure(root) <= budget) break;
    const { arr, original } = site;
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
      const before = measure(root);
      site.set(`[dropped ${site.len} chars]`);
      // Same honesty guard as above: a string that lived in a dropped array tail is
      // already gone from the output, so replacing it is a no-op worth no mention.
      if (measure(root) < before) fields += 1;
    }
  }

  // Final guard: pathological payload (no reducible arrays/strings). Replace the
  // body so the output can never exceed the budget as invalid-but-huge JSON.
  let hard = false;
  if (measure(root) > budget) {
    root = { dropped: 'payload exceeded FB_MAX_RESULT_CHARS after structural reduction' };
    hard = true;
  }

  return { root, items, fields, hard };
}

function buildNote(budget: number, items: number, fields: number, hard: boolean): string {
  const parts: string[] = [];
  if (items > 0) parts.push(`${items} list item(s)`);
  if (fields > 0) parts.push(`${fields} large field(s)`);
  const what = parts.length > 0 ? parts.join(' and ') : 'content';
  const tail = hard ? ' Result exceeded the budget even after reduction.' : '';
  return `Result truncated to fit FB_MAX_RESULT_CHARS=${budget}: dropped ${what}. Narrow the query or paginate to see the rest.${tail}`;
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
