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
// no false negatives.
//
// BACKUP strategy — pattern scan (defense-in-depth ONLY, for secrets we do not
// hold, e.g. a token a user pastes into a tool argument): mask `EAA…` tokens,
// the 32-hex app secret, the 64-hex `appsecret_proof`, and the
// `{app-id}|{app-secret}` app-access-token pipe form. The app secret is 32-hex
// and the proof is 64-hex — neither is `EAA`-shaped, which is why prefix
// matching alone is insufficient.
//
// Inputs are never mutated: `redact` returns a scrubbed structural clone and a
// reference cycle is broken with a sentinel so the clone stays JSON-safe.

import type { Redactor, RedactorConfig } from './types.js';

const DEFAULT_PLACEHOLDER = '[REDACTED]';

/** Marker substituted for a node that closes a reference cycle (keeps output JSON-safe). */
const CIRCULAR = '[CIRCULAR]';

/**
 * Defense-in-depth patterns, applied in this order so composite forms collapse
 * to a single placeholder before their sub-parts could match:
 *  1. app-access-token pipe form `{app-id}|{app-secret}` (numeric id + 32-hex),
 *  2. `EAA…` access tokens (base64url tail; `-`/`_` allowed so an embedded
 *     separator never leaves a live tail unmasked),
 *  3. 64-hex `appsecret_proof`,
 *  4. 32-hex app secret.
 * The `\b` anchors on the hex forms keep the 32- and 64-hex patterns mutually
 * exclusive (no `\b` sits inside a longer hex run).
 */
const PATTERNS: readonly RegExp[] = [
  /\b\d{6,}\|[A-Fa-f0-9]{32}\b/g,
  /EAA[A-Za-z0-9_-]{20,}/g,
  /\b[A-Fa-f0-9]{64}\b/g,
  /\b[A-Fa-f0-9]{32}\b/g,
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    if (registered.includes(value)) return;
    registered.push(value);
    rebuild();
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
  const redactValue = (value: unknown, path: WeakSet<object>): unknown => {
    if (typeof value === 'string') return scrubString(value);
    if (value === null || typeof value !== 'object') return value;

    // Leaf object types: cloned/kept by value, never structurally walked.
    if (value instanceof Date) return new Date(value.getTime());
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;

    if (path.has(value)) return CIRCULAR;
    path.add(value);
    try {
      if (value instanceof Error) {
        const errCopy: Record<string, unknown> = {
          name: scrubString(value.name),
          message: scrubString(value.message),
        };
        // message/stack are typically non-enumerable, so copy them explicitly.
        if (typeof value.stack === 'string') errCopy.stack = scrubString(value.stack);
        if ('cause' in value) errCopy.cause = redactValue(value.cause, path);
        for (const [key, val] of Object.entries(value)) {
          errCopy[scrubString(key)] = redactValue(val, path);
        }
        return errCopy;
      }

      if (Array.isArray(value)) {
        return value.map((item) => redactValue(item, path));
      }

      // Plain or generic object: scrub keys AND values into a fresh plain
      // object. Non-plain instances (Map/Set/class instances) degrade to their
      // own enumerable entries — lossy but safe (data dropped, never leaked).
      const objCopy: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        objCopy[scrubString(key)] = redactValue(val, path);
      }
      return objCopy;
    } finally {
      path.delete(value);
    }
  };

  return {
    redact: (value: unknown): unknown => redactValue(value, new WeakSet<object>()),
    redactString: (s: string): string => scrubString(s),
    addSecret,
  };
}
