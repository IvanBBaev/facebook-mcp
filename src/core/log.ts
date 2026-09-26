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
//
// The default sink survives a stderr whose reader has gone away. A supervisor
// that closed the pipe, a `| head` that exited, a crashed wrapper: the next
// write raises EPIPE, which Node delivers as an `'error'` event on the stream,
// and an `'error'` nobody listens for is an uncaught exception — the whole
// server dead with exit code 1 because a LOG line could not be delivered. The
// stdout precedent in `src/mcp/transport.ts` turns the same failure on the
// protocol channel into a clean shutdown; stderr is diagnostics only, so here
// the sink falls silent instead (see `stderrSink`).

import type { Writable } from 'node:stream';

import type { Clock, LogFields, LogLevel, Logger, Redactor } from './types.js';

/** Numeric severity so a threshold comparison is a single `>=`. */
const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Marker logged in place of a caller field whose accessor threw (matches the redactor's). */
const UNREADABLE = '[UNREADABLE]';

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
   * {@link stderrSink} over `process.stderr` — NEVER stdout. Injectable for
   * tests only.
   */
  readonly write?: (line: string) => void;
}

/**
 * Per-stream sink state, shared by every sink built over the same stream: one
 * pipe carries every logger's lines, so when it dies, it dies for all of them.
 */
interface SinkStreamState {
  dead: boolean;
}

/**
 * Streams already guarded, so the `'error'` listener is attached once per
 * stream however many times `createLogger` runs — once in production, many
 * times in a test process — and never piles up past the default ceiling of ten
 * into a MaxListenersExceededWarning. Weak, so a test's stream can be collected.
 */
const GUARDED_STREAMS = new WeakMap<Writable, SinkStreamState>();

/**
 * Own the stream's `'error'` path. The listener does one thing — flip the flag —
 * so nothing attached here can itself throw.
 *
 * `on`, not `once`, and never removed: after the first failure the sink is dead
 * and writes nothing, so no second error can come from us — but the stream is
 * `process.stderr`, shared with the console guard and the doctor report, and a
 * listener that stepped down after one error would leave THEIR next line to
 * crash a process whose logger had already gone quiet.
 */
function guardStream(stream: Writable): SinkStreamState {
  const known = GUARDED_STREAMS.get(stream);
  if (known !== undefined) return known;
  const state: SinkStreamState = { dead: false };
  GUARDED_STREAMS.set(stream, state);
  stream.on('error', () => {
    state.dead = true;
  });
  return state;
}

/**
 * Build the default line sink over a stderr-like stream — `process.stderr`
 * when nothing is injected. Fire-and-forget, as before; what it adds is that a
 * stderr nobody reads any more silences the logger instead of killing the
 * server (the stdout precedent in `src/mcp/transport.ts` shuts down on the
 * same failure, because stdout IS the protocol; stderr is only diagnostics).
 *
 * The decision is carried by the per-stream `dead` flag, not by the stream's
 * own state. Node's bootstrap gives the stdio streams a `_destroy` that hands
 * the error on and then un-destroys the stream, so `process.stderr` never
 * reports `destroyed` after an EPIPE — and every further write fails, and
 * errors, all over again: one `'error'` event per log line for the life of the
 * process. Stopping at the first is what keeps that from being a storm. The
 * `destroyed` / `writableEnded` checks cover a stream that was closed under
 * us without erroring, where a write would raise ERR_STREAM_WRITE_AFTER_END or
 * ERR_STREAM_DESTROYED of its own.
 *
 * A stderr redirected to a FILE is a SyncWriteStream, whose failed `writeSync`
 * (EBADF, EIO, ENOSPC) throws out of `write()` itself instead of arriving as an
 * event. A logger must never throw, so that is absorbed the same way: the sink
 * goes dead. Silence is the contract either way — there is nowhere else to
 * report a stderr that cannot be written to, and stdout is never an option.
 */
export function stderrSink(stream: Writable = process.stderr): (line: string) => void {
  const state = guardStream(stream);
  return (line: string): void => {
    if (state.dead || stream.destroyed || stream.writableEnded) return;
    try {
      stream.write(line);
    } catch {
      state.dead = true;
    }
  };
}

/**
 * Set a caller field on the record. `JSON.parse` creates `__proto__` as an OWN
 * property, so a caller that spreads a parsed object into `LogFields` can carry
 * one — and a plain `record[key] = val` runs the inherited setter, dropping the
 * field from the line an operator has to read. Mirrors `setOwn` in
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
 * Create a stderr-only JSON {@link Logger}. A record carries the caller's fields
 * plus the reserved `time`/`level`/`msg`, is redacted as a whole, then written
 * as one newline-terminated JSON line — the reserved keys are stamped last, so
 * they are the trailing keys of the emitted object, not the leading ones. A
 * caller field named `time`/`level`/`msg` can never displace the reserved key of
 * the same name.
 */
export function createLogger(config: LoggerConfig): Logger {
  const { clock, redactor } = config;
  const threshold = LEVEL_ORDER[config.level ?? 'info'];
  const write = config.write ?? stderrSink();

  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[level] < threshold) return;

    let line: string;
    try {
      // Reserved keys win: a caller field named `msg`/`time`/`level` is dropped
      // by the filter below, so the later stamp cannot be shadowed whatever the
      // order. The caller's own `fields` are read INSIDE the guard and one key at
      // a time: reading a value invokes its accessor, and a getter that throws
      // must cost that one field — never the line, and never the caller.
      const record: Record<string, unknown> = {};
      if (fields) {
        for (const key of Object.keys(fields)) {
          if (RESERVED.has(key)) continue;
          let val: unknown;
          try {
            val = fields[key];
          } catch {
            val = UNREADABLE;
          }
          setOwn(record, key, val);
        }
      }
      record.time = clock.now();
      record.level = level;
      record.msg = msg;

      // Single redaction choke-point: the ENTIRE record (msg + field keys/values)
      // is scrubbed before it can be serialized. Redaction is INSIDE the guard,
      // not before it: the walk reads own enumerable properties, so a field whose
      // accessor throws fails here rather than at serialization, and a `redact`
      // left outside would hand that throw straight to the caller.
      line = JSON.stringify(redactor.redact(record), bigintReplacer);
    } catch {
      // A logger must never throw. Fall back to a minimal, always-serializable
      // record so one hostile field cannot silence the log entirely.
      //
      // The message is re-redacted rather than taken raw from `msg`. A field that
      // defeats rendering (a throwing accessor, a throwing `toJSON`) leaves `msg`
      // untouched, so emitting the original would route a message around the
      // choke-point above — the one bypass in the whole logger. `redactString`
      // takes a plain string and cannot fail the same way. Caller fields are
      // dropped wholesale: the value that broke the attempt is among them.
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
