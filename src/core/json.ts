// Shared JSON-narrowing helpers (task C13, Architect review ARC-08).
//
// Graph responses, upload-session state and usage headers arrive as untrusted
// JSON. Before this module, `asRecord` existed in seven copies (and `isRecord`
// in many more) with subtle differences — readonly vs mutable results, array
// handling, a variant that never returns `undefined` — so the same payload
// could be read differently per module. These helpers are the single
// definition of how untrusted JSON is narrowed.
//
// Expand only: nothing imports this module yet. Each lane replaces its local
// copy in its own L2.* task (doc 05 §1 rule 5); a later task removes the copies.
//
// Rules every helper follows:
//   - pure and total: never throws, whatever the input;
//   - a value of the wrong shape becomes `undefined`, never a coerced value
//     (no `Number("12")`, no `String(12)`);
//   - arrays are never records, and `null` is never a record.
//
// Layering: core layer, no imports.

/** A JSON object as read from untrusted input. */
export type JsonRecord = Record<string, unknown>;

/** True for a plain object value: not `null`, not an array, not a primitive. */
export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value as a record, or `undefined` when it is not one (see {@link isRecord}). */
export function asRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

/** The value as an array, or `undefined` when it is not one. Elements stay `unknown`. */
export function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? (value as readonly unknown[]) : undefined;
}

/** A finite number, or `undefined`. `NaN`, `±Infinity` and numeric strings are rejected. */
export function numOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * A safe integer, or a string that is exactly one (`"190"`, `"-1"`), else
 * `undefined`. Graph sends error `code` / `error_subcode` as numbers, but a hop
 * that re-serialises the body can hand them back quoted. A padded, fractional
 * or exponent form (`" 190"`, `"1.5"`, `"1e3"`) is not an integer here.
 */
export function intOr(value: unknown): number | undefined {
  if (typeof value === 'string') {
    if (!/^-?\d+$/.test(value)) return undefined;
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

/** A string (the empty string included), or `undefined`. Other types are not stringified. */
export function strOr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * `JSON.parse` that never throws: the parsed value, or `undefined` when the
 * text is not valid JSON. A valid `null` body parses to `null`, so callers can
 * tell "no JSON" from "JSON null".
 */
export function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
