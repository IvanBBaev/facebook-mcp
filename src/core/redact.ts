// Value-based secret-redaction choke-point (task F05, cluster C3).
//
// A single Redactor scrubs secrets out of everything that could leave the
// process — log lines, error strings, tool results, and the write journal —
// so there is one choke-point rather than two strategies with a seam between
// them (auth-and-security §"Redaction").
//
// PRIMARY strategy — value-based: the exact configured secret VALUES
// (`FB_ACCESS_TOKEN` and every derived per-Page token, `FB_APP_SECRET`, the
// derived `appsecret_proof`, `FB_HTTP_TOKEN`, any app-access-token) are
// registered — at construction via `RedactorConfig.secrets` or at runtime via
// `addSecret` — and replaced wherever they appear. Known-value redaction has
// no false negatives, but only for the spelling it was given: a secret is
// therefore registered together with every WIRE FORM it can take on its way out
// (percent-encoded, form-encoded, JSON-escaped). An operator-chosen
// `FB_HTTP_TOKEN` or `FB_CONFIRM_TOKEN` is naturally base64 — `+`, `/`, `=` —
// and travels through URLs and NDJSON to reach the places a human reads, where
// an exact-string match would no longer recognise it.
//
// BACKUP strategy — pattern scan (defense-in-depth ONLY, for secrets we do not
// hold, e.g. a token a user pastes into a tool argument): mask `EAA…` tokens,
// the 32-hex app secret, the 64-hex `appsecret_proof`, and the
// `{app-id}|{app-secret}` app-access-token pipe form. The app secret is 32-hex
// and the proof is 64-hex — neither is `EAA`-shaped, which is why prefix
// matching alone is insufficient.
//
// Inputs are never mutated: `redact` returns a scrubbed structural clone that
// is always JSON-safe, because the caller downstream (a log line, an NDJSON
// journal record) has no way to recover if it is not: a reference cycle is
// broken with a sentinel, a `bigint` — which `JSON.stringify` refuses outright
// — is handed back as its decimal string, nesting past `MAX_DEPTH` is cut with
// a marker rather than overflowing the stack, and an accessor that throws costs
// its own key instead of the whole record. Redaction runs ON the error path, so
// anything it throws replaces the failure the operator needed to read. One
// documented exception: binary leaves (`ArrayBuffer` and its views) are handed
// back by reference, neither copied nor scanned, because a byte-level mask is a
// different strategy from the string scan. Never route a value that may carry a
// secret through a Buffer and expect this to catch it.

import type { Redactor, RedactorConfig } from './types.js';

const DEFAULT_PLACEHOLDER = '[REDACTED]';

/** Marker substituted for a node that closes a reference cycle (keeps output JSON-safe). */
const CIRCULAR = '[CIRCULAR]';

/** Marker substituted for a subtree deeper than {@link MAX_DEPTH}. */
const TRUNCATED = '[TRUNCATED]';

/** Marker substituted for a property whose accessor threw while being read. */
const UNREADABLE = '[UNREADABLE]';

/**
 * How far the walk will descend before cutting the subtree off.
 *
 * The number matters because the scrubber must never be the more brittle half
 * of the pair: `JSON.parse` accepts nesting thousands of levels deep, so a body
 * the server has ALREADY accepted must not be the thing that kills the log line
 * with a `RangeError`. Two hundred is far past anything Graph returns or a tool
 * argument carries, and far short of the recursion limit.
 */
const MAX_DEPTH = 200;

/**
 * Defense-in-depth patterns, applied in this order so composite forms collapse
 * to a single placeholder before their sub-parts could match:
 *  1. app-access-token pipe form `{app-id}|{app-secret}` (numeric id + 32-hex),
 *     accepting the percent-encoded separator too: a composite token that has
 *     been through a URL arrives as `{app-id}%7C{app-secret}`, and `%7C` ends in
 *     a word character, so rule 4's leading `\b` cannot rescue the secret half,
 *  2. `EAA…` access tokens (base64url tail; `-`/`_` allowed so an embedded
 *     separator never leaves a live tail unmasked),
 *  3. 64-hex `appsecret_proof`,
 *  4. 32-hex app secret.
 * The `\b` anchors on the hex forms keep the 32- and 64-hex patterns mutually
 * exclusive (no `\b` sits inside a longer hex run).
 *
 * The LEADING anchor also accepts the end of an escape sequence
 * ({@link AFTER_ESCAPE}). A percent-escape (`%3D`, `%7C`, `%20`) and a JSON
 * escape (`\n`, `\u0009`) both end in a word character — for `%3D` even a hex
 * digit — so a secret that follows one does not start at a word boundary: the
 * query of a URL carried inside another URL or a form-encoded Graph batch body
 * (`appsecret_proof%3D{64-hex}`) turns the proof into a 66-hex run that neither
 * hex pattern could see, and the whole value leaked.
 */
const AFTER_ESCAPE = String.raw`(?<=%[0-9A-Fa-f]{2}|\\[bfnrt]|\\u[0-9A-Fa-f]{4})`;
const LEAD = String.raw`(?:\b|${AFTER_ESCAPE})`;
const PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`${LEAD}\d{6,}(?:\||%7[Cc])[A-Fa-f0-9]{32}\b`, 'g'),
  /EAA[A-Za-z0-9_-]{20,}/g,
  new RegExp(String.raw`${LEAD}[A-Fa-f0-9]{64}\b`, 'g'),
  new RegExp(String.raw`${LEAD}[A-Fa-f0-9]{32}\b`, 'g'),
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every spelling of the same secret that could reach a log line: the raw value,
 * its percent-encoded form (a URL or query value), its form-encoded form
 * (`application/x-www-form-urlencoded`, which spells a space `+` rather than
 * `%20`), and its JSON-escaped form (the journal is NDJSON — a secret holding a
 * quote, a backslash or a newline arrives escaped and no longer matches
 * itself). Registering all of them is what keeps "no false negatives" true for
 * a value that is not URL-safe to begin with.
 */
function wireForms(value: string): string[] {
  const forms = new Set<string>([value]);
  try {
    forms.add(encodeURIComponent(value));
  } catch {
    // A lone surrogate makes `encodeURIComponent` throw. The raw form is still
    // registered, and a half-formed pair could not have survived a URL anyway.
  }
  forms.add(new URLSearchParams([['v', value]]).toString().slice('v='.length));
  // `JSON.stringify` wraps the value in quotes; the body between them is what
  // actually appears inside a serialised record.
  forms.add(JSON.stringify(value).slice(1, -1));
  return [...forms];
}

/**
 * Define a scrubbed key on the copy. `JSON.parse` creates `__proto__` as an OWN
 * enumerable property, so a Graph node carrying one reaches {@link safeEntries}
 * and a plain `copy[key] = value` runs the inherited setter instead of storing
 * the field: a string value is swallowed and an object value re-parents the copy,
 * dropping the subtree from anything that serialises it. Redaction is the C3
 * choke-point every record passes through, so a field lost here is lost from the
 * log line, the tool result and the error payload alike. Mirrors `setOwn` in
 * `src/mcp/result.ts`.
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
 * Read a value's own enumerable entries without letting one hostile or merely
 * broken accessor take the whole record down. A key that throws is kept, with
 * a marker in place of its value, so the shape of what was logged survives.
 */
function safeEntries(value: object): Array<[string, unknown]> {
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    // A Proxy may refuse even to enumerate. Dropping the contents is lossy;
    // throwing here would be worse.
    return [];
  }
  const entries: Array<[string, unknown]> = [];
  for (const key of keys) {
    try {
      entries.push([key, (value as Record<string, unknown>)[key]]);
    } catch {
      entries.push([key, UNREADABLE]);
    }
  }
  return entries;
}

/** Read one property, turning a throwing accessor into {@link UNREADABLE}. */
function readField(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return UNREADABLE;
  }
}

/** `key in value`, false when a hostile Proxy trap throws instead of answering. */
function hasField(value: object, key: string): boolean {
  try {
    return key in value;
  } catch {
    return false;
  }
}

/**
 * Create a {@link Redactor}. Registered secret values are scrubbed first
 * (longest-first, so a composite secret is replaced before any fragment of it
 * could survive), then the defensive pattern scan runs as backup.
 */
export function createRedactor(config: RedactorConfig = {}): Redactor {
  const placeholder = config.placeholder ?? DEFAULT_PLACEHOLDER;

  // Compiled global regexes for each registered secret, kept sorted so the
  // longest secret is substituted first.
  let secretPatterns: RegExp[] = [];
  const registered: string[] = [];

  const rebuild = (): void => {
    secretPatterns = [...registered]
      .sort((a, b) => b.length - a.length)
      .map((value) => new RegExp(escapeRegExp(value), 'g'));
  };

  const addSecret = (value: string): void => {
    // Ignore empty/whitespace-only values — replacing "" would blank the whole
    // string and a whitespace secret would scrub every space.
    if (value.trim().length === 0) return;
    let added = false;
    for (const form of wireForms(value)) {
      if (form.trim().length === 0) continue;
      if (registered.includes(form)) continue;
      registered.push(form);
      added = true;
    }
    if (added) rebuild();
  };

  for (const s of config.secrets ?? []) addSecret(s);

  const scrubString = (input: string): string => {
    let out = input;
    // 1. Value-based (primary): exact registered secret values.
    for (const re of secretPatterns) out = out.replace(re, placeholder);
    // 2. Pattern scan (defense-in-depth backup only).
    for (const re of PATTERNS) out = out.replace(re, placeholder);
    return out;
  };

  // `path` holds the ancestors on the current walk so a back-edge (true cycle)
  // is broken with a marker, while a shared non-cyclic node is simply
  // re-walked (safe: data is scrubbed again, never leaked).
  const redactValue = (value: unknown, path: WeakSet<object>, depth: number): unknown => {
    if (typeof value === 'string') return scrubString(value);
    // A bigint carries no registered secret and its digits are not worth
    // running the hex backup over — masking a 32-digit id would be a pure loss
    // — but it cannot be handed on as-is either, because `JSON.stringify`
    // throws on one rather than skipping it.
    if (typeof value === 'bigint') return `${value}`;
    if (value === null || typeof value !== 'object') return value;

    // Leaf object types, never structurally walked. A Date is copied; binary is
    // returned as-is — by reference, and unscanned (see the header note).
    if (value instanceof Date) return new Date(value.getTime());
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;

    // Leaves above are kept whatever their depth; only further DESCENT stops,
    // so the cut costs a subtree and never a scrubbed value.
    if (depth >= MAX_DEPTH) return TRUNCATED;
    if (path.has(value)) return CIRCULAR;
    path.add(value);
    try {
      if (value instanceof Error) {
        // Every read goes through `readField`: `name`/`message`/`stack` are
        // ordinary properties a caller can overwrite with a non-string or an
        // accessor that throws, and a bare `scrubString(value.name)` turned
        // either into a throw out of `redact` — on the error path, where it
        // replaces the failure being reported.
        const errCopy: Record<string, unknown> = {
          name: redactValue(readField(value, 'name'), path, depth + 1),
          message: redactValue(readField(value, 'message'), path, depth + 1),
        };
        // message/stack are typically non-enumerable, so copy them explicitly.
        const stack = readField(value, 'stack');
        if (typeof stack === 'string') errCopy.stack = scrubString(stack);
        if (hasField(value, 'cause')) {
          errCopy.cause = redactValue(readField(value, 'cause'), path, depth + 1);
        }
        // `AggregateError.errors` is an own NON-enumerable property, so the
        // entries walk below never sees it — and it is where Node puts the
        // per-address connect failures behind a bare `fetch failed`.
        if (value instanceof AggregateError) {
          errCopy.errors = redactValue(readField(value, 'errors'), path, depth + 1);
        }
        for (const [key, val] of safeEntries(value)) {
          setOwn(errCopy, scrubString(key), redactValue(val, path, depth + 1));
        }
        return errCopy;
      }

      // A value that serializes itself is redacted as what it SERIALIZES TO.
      // Copying a function-valued `toJSON` onto the clone let `JSON.stringify`
      // call it downstream and emit its return value unscrubbed; walking own
      // entries instead lost a class instance entirely (a `URL` came out `{}`).
      const toJSON = readField(value, 'toJSON');
      if (typeof toJSON === 'function') {
        let serialized: unknown;
        try {
          serialized = (toJSON as (key: string) => unknown).call(value, '');
        } catch {
          return UNREADABLE;
        }
        return redactValue(serialized, path, depth + 1);
      }

      if (Array.isArray(value)) {
        // Element by element through `readField`, like every other read in the
        // walk: `map` invoked an index accessor directly, so one throwing getter
        // threw out of `redact` and cost the whole record. Holes stay holes.
        const length = readField(value, 'length');
        const arrCopy: unknown[] = [];
        arrCopy.length = typeof length === 'number' ? length : 0;
        for (let i = 0; i < arrCopy.length; i += 1) {
          if (!hasField(value, String(i))) continue;
          arrCopy[i] = redactValue(readField(value, String(i)), path, depth + 1);
        }
        return arrCopy;
      }

      // Plain or generic object: scrub keys AND values into a fresh plain
      // object. Non-plain instances without a `toJSON` (Map/Set/most class
      // instances) degrade to their own enumerable entries — lossy but safe (data dropped, never leaked).
      const objCopy: Record<string, unknown> = {};
      for (const [key, val] of safeEntries(value)) {
        setOwn(objCopy, scrubString(key), redactValue(val, path, depth + 1));
      }
      return objCopy;
    } finally {
      path.delete(value);
    }
  };

  return {
    redact: (value: unknown): unknown => redactValue(value, new WeakSet<object>(), 0),
    redactString: (s: string): string => scrubString(s),
    addSecret,
  };
}
