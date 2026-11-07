// Runtime seams of the core contract (X08 split of `core/types.ts`): the
// injectable clock, the redaction choke-point and the stderr logger.
// Shapes only; `core` is layer 0 and this file imports nothing.

// ---------------------------------------------------------------------------
// 1. Clock (injectable time seam — QA #6 / G3)
// ---------------------------------------------------------------------------

/**
 * Injectable time seam. Every retry/backoff/expiry decision reads time through
 * this interface so tests can drive time deterministically (see `fakeClock`).
 * `sleep` honors an `AbortSignal` so in-flight waits abort on shutdown /
 * cancellation (CC-MCP-5).
 */
export interface Clock {
  /** Current wall-clock time in epoch milliseconds. */
  now(): number;
  /** Resolve after `ms` milliseconds, or reject with an AbortError if `signal` aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

// ---------------------------------------------------------------------------
// 5. Redactor — value-based secret scrubbing choke-point (C3, F05 implements)
// ---------------------------------------------------------------------------

/** Construction config for a {@link Redactor}. */
export interface RedactorConfig {
  /** Known secret VALUES registered at construction (tokens, app secret, proof, http token). */
  readonly secrets?: readonly string[];
  /** Replacement placeholder (default implementation uses `[REDACTED]`). */
  readonly placeholder?: string;
}

/**
 * Value-based redaction choke-point. Primary strategy scrubs registered secret
 * VALUES wherever they appear (logs, errors, results, journal); the real F05
 * implementation adds a defensive pattern scan (EAA tokens, 32-hex app secret,
 * `{app-id}|{app-secret}`) as backup only.
 */
export interface Redactor {
  /** Deep-redact any value, returning a scrubbed clone (strings, arrays, objects). */
  redact(value: unknown): unknown;
  /** Redact a single string. */
  redactString(s: string): string;
  /**
   * Register a secret value discovered at runtime — e.g. a per-Page token derived
   * after startup (C1) must be scrubbable the moment it exists.
   */
  addSecret(value: string): void;
}

// ---------------------------------------------------------------------------
// 11. Logger — stderr JSON logger (F05 implements)
// ---------------------------------------------------------------------------

export type LogFields = Readonly<Record<string, unknown>>;

/**
 * Structured stderr logger. stdout is the stdio JSON-RPC channel, so all log
 * output goes to stderr as JSON. `fields` are redacted at the choke-point before
 * emission (C3).
 */
export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}
