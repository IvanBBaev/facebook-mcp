// Structured stderr JSON logger (task F05, cluster C3 / CC-CFG-1).
//
// stdout is reserved for the stdio JSON-RPC transport, so EVERY log line goes
// to stderr — never stdout — as one JSON object per line (a spawn-level
// stdout-purity test elsewhere guards this invariant; do not break it).
//
// The whole record (message, field keys, field values) passes through the
// injected Redactor before serialization, so the logger is a value-based
// redaction consumer of the C3 choke-point, never a bypass of it. Timestamps
// come from an injected Clock so tests are deterministic.

import type { Clock, LogFields, LogLevel, Logger, Redactor } from './types.js';

/** Numeric severity so a threshold comparison is a single `>=`. */
const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Reserved record keys that a caller's `fields` may never shadow. */
const RESERVED = new Set(['time', 'level', 'msg']);

/** Construction seams for {@link createLogger}. */
export interface LoggerConfig {
  /** Time source for the `time` field (epoch ms). */
  readonly clock: Clock;
  /** Redaction choke-point every record is passed through before emission (C3). */
  readonly redactor: Redactor;
  /** Minimum level emitted; quieter levels are dropped. Default `info`. */
  readonly level?: LogLevel;
  /**
   * Sink for a finished line (already newline-terminated). Defaults to
   * `process.stderr` — NEVER stdout. Injectable for tests only.
   */
  readonly write?: (line: string) => void;
}

const writeStderr = (line: string): void => {
  process.stderr.write(line);
};

/**
 * Create a stderr-only JSON {@link Logger}. Records are shaped
 * `{ time, level, msg, ...fields }`, redacted as a whole, then written as one
 * newline-terminated JSON line. A caller field named `time`/`level`/`msg` can
 * never displace the reserved key of the same name.
 */
export function createLogger(config: LoggerConfig): Logger {
  const { clock, redactor } = config;
  const threshold = LEVEL_ORDER[config.level ?? 'info'];
  const write = config.write ?? writeStderr;

  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[level] < threshold) return;

    // Reserved keys win: spread caller fields first, then stamp the reserved
    // ones so a field called `msg`/`time`/`level` cannot shadow them.
    const record: Record<string, unknown> = {};
    if (fields) {
      for (const [key, val] of Object.entries(fields)) {
        if (!RESERVED.has(key)) record[key] = val;
      }
    }
    record.time = clock.now();
    record.level = level;
    record.msg = msg;

    // Single redaction choke-point: the ENTIRE record (msg + field keys/values)
    // is scrubbed before it can be serialized.
    const safe = redactor.redact(record);

    let line: string;
    try {
      line = JSON.stringify(safe, bigintReplacer);
    } catch {
      // A logger must never throw. Fall back to a minimal, always-serializable
      // record so an unserializable field cannot silence the log entirely.
      //
      // The message is re-redacted rather than taken raw from `msg`. An
      // unserializable *field* (a cycle, a throwing `toJSON`) survives redaction
      // untouched and only fails here, so emitting the original `msg` would route
      // a message around the choke-point above — the one bypass in the whole
      // logger. Caller fields are dropped wholesale: the value that cannot be
      // re-serialized is exactly the one that broke the first attempt.
      line = JSON.stringify({
        time: clock.now(),
        level,
        msg: redactor.redactString(msg),
        logError: 'record serialization failed',
      });
    }
    write(`${line}\n`);
  };

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}

/** Render bigint as a string so a stray bigint field never throws JSON.stringify. */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
