// In-memory value-based Redactor fake (test-only).
//
// Implements the real-ish value-based strategy (not identity): every registered
// secret VALUE is replaced with the placeholder wherever it appears in strings,
// object values, object keys, and array elements. This lets tests assert that
// secrets never survive a redaction pass. The real F05 redactor adds a
// defensive pattern scan on top; the fake omits that (value-based is what tests
// exercise) and records its calls for assertions.

import type { Redactor, RedactorConfig } from '../types.js';

/** A {@link Redactor} with recorded inputs and the current secret set exposed. */
export interface FakeRedactor extends Redactor {
  /** Inputs passed to `redact()`, in order. */
  readonly calls: readonly unknown[];
  /** Inputs passed to `redactString()`, in order. */
  readonly stringCalls: readonly string[];
  /** The registered secret values currently being scrubbed. */
  readonly secrets: readonly string[];
}

const DEFAULT_PLACEHOLDER = '[REDACTED]';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Create a value-based redactor seeded with `config.secrets`. */
export function createFakeRedactor(config: RedactorConfig = {}): FakeRedactor {
  const placeholder = config.placeholder ?? DEFAULT_PLACEHOLDER;
  const secrets: string[] = [];
  const calls: unknown[] = [];
  const stringCalls: string[] = [];

  const addSecret = (value: string): void => {
    // Ignore empty/whitespace so we never blank-replace every character.
    if (value.length > 0 && !secrets.includes(value)) {
      secrets.push(value);
    }
  };

  for (const s of config.secrets ?? []) {
    addSecret(s);
  }

  const redactString = (s: string): string => {
    stringCalls.push(s);
    let out = s;
    for (const secret of secrets) {
      out = out.replace(new RegExp(escapeRegExp(secret), 'g'), placeholder);
    }
    return out;
  };

  const redactDeep = (value: unknown, seen: WeakSet<object>): unknown => {
    if (typeof value === 'string') {
      // Reuse the same substitution but without re-recording as a string call.
      let out = value;
      for (const secret of secrets) {
        out = out.replace(new RegExp(escapeRegExp(secret), 'g'), placeholder);
      }
      return out;
    }
    if (value === null || typeof value !== 'object') {
      return value;
    }
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item) => redactDeep(item, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const safeKey = redactDeep(key, seen) as string;
      out[safeKey] = redactDeep(val, seen);
    }
    return out;
  };

  return {
    get calls() {
      return calls;
    },
    get stringCalls() {
      return stringCalls;
    },
    get secrets() {
      return secrets;
    },
    redact: (value: unknown): unknown => {
      calls.push(value);
      return redactDeep(value, new WeakSet<object>());
    },
    redactString,
    addSecret,
  };
}
