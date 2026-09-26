import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { createLogger, stderrSink } from './log.js';
import { createFakeClock } from './fakes/fakeClock.js';
import { createFakeRedactor } from './fakes/fakeRedactor.js';
import { createRedactor } from './redact.js';

/** A logger writing into an array sink, with a fake clock and passthrough redactor. */
function harness(level?: 'debug' | 'info' | 'warn' | 'error') {
  const lines: string[] = [];
  const clock = createFakeClock(1_700_000_000_000);
  const redactor = createFakeRedactor();
  const logger = createLogger({
    clock,
    redactor,
    level,
    write: (line) => lines.push(line),
  });
  return { lines, clock, redactor, logger };
}

test('emits one newline-terminated JSON object per call', () => {
  const { lines, logger } = harness();
  logger.info('hello', { a: 1 });
  assert.equal(lines.length, 1);
  const line = lines[0]!;
  assert.ok(line.endsWith('\n'));
  assert.equal(line.split('\n').filter(Boolean).length, 1);
  const rec = JSON.parse(line) as Record<string, unknown>;
  assert.equal(rec.msg, 'hello');
  assert.equal(rec.level, 'info');
  assert.equal(rec.a, 1);
});

test('a field named `__proto__` is logged as a field, not swallowed by the prototype', () => {
  // `LogFields` is `Record<string, unknown>`, so any caller that spreads a parsed
  // Graph object into log fields can carry an OWN `__proto__` key — `JSON.parse`
  // is what makes it own. A plain `record[key] = val` then runs the inherited
  // setter: the value never lands, and the field an operator needs to read the
  // incident silently disappears from the line.
  const { lines, logger } = harness();
  logger.info(
    'm',
    JSON.parse('{"__proto__":"tenant-a","other":1}') as Record<string, unknown>,
  );
  const rec = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(rec.other, 1);
  assert.equal(rec['__proto__'], 'tenant-a', 'the field must reach the line');
});

test('timestamp comes from the injected Clock (deterministic)', () => {
  const { lines, logger, clock } = harness();
  logger.warn('tick');
  const rec = JSON.parse(lines[0]!) as { time: number };
  assert.equal(rec.time, clock.now());
  assert.equal(rec.time, 1_700_000_000_000);
});

test('level threshold drops quieter records', () => {
  const { lines, logger } = harness('warn');
  logger.debug('d');
  logger.info('i');
  logger.warn('w');
  logger.error('e');
  const levels = lines.map((l) => (JSON.parse(l) as { level: string }).level);
  assert.deepEqual(levels, ['warn', 'error']);
});

test('every record passes through the injected Redactor before serialization (C3)', () => {
  const { lines, logger, redactor } = harness();
  logger.info('m', { k: 'v' });
  // The fake records each redact() input: the whole record went through it.
  assert.equal(redactor.calls.length, 1);
  const passed = redactor.calls[0] as Record<string, unknown>;
  assert.equal(passed.msg, 'm');
  assert.equal(passed.k, 'v');
  assert.equal(lines.length, 1);
});

test('C3: a registered secret in a log field is scrubbed in the output line', () => {
  const lines: string[] = [];
  const clock = createFakeClock(1);
  const secret = 'live-token-must-not-leak-value';
  const redactor = createRedactor({ secrets: [secret] });
  const logger = createLogger({ clock, redactor, write: (l) => lines.push(l) });

  logger.error('request failed', { url: `https://x/?access_token=${secret}` });
  const line = lines[0]!;
  assert.ok(!line.includes(secret));
  assert.ok(line.includes('[REDACTED]'));
});

test('reserved keys (time/level/msg) cannot be shadowed by caller fields', () => {
  const { lines, logger, clock } = harness();
  logger.info('real-message', { msg: 'FAKE', time: 0, level: 'debug', keep: 'yes' });
  const rec = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(rec.msg, 'real-message');
  assert.equal(rec.level, 'info');
  assert.equal(rec.time, clock.now());
  assert.equal(rec.keep, 'yes');
});

test('a bigint field is serialized (never throws)', () => {
  const { lines, logger } = harness();
  assert.doesNotThrow(() => logger.info('big', { n: 10n }));
  const rec = JSON.parse(lines[0]!) as { n: string };
  assert.equal(rec.n, '10');
});

test('an unserializable record falls back to a minimal line instead of throwing', () => {
  const { lines, logger, clock } = harness();
  // A node pointing back at its parent is what real payloads look like; the
  // redactor passes the cycle through, so JSON.stringify throws on it.
  const node: Record<string, unknown> = { name: 'response' };
  node.self = node;

  assert.doesNotThrow(() => logger.error('upload failed', { node }));

  assert.equal(lines.length, 1, 'the log line must not be lost');
  const line = lines[0]!;
  assert.ok(line.endsWith('\n'));
  const rec = JSON.parse(line) as Record<string, unknown>;
  assert.equal(rec.msg, 'upload failed');
  assert.equal(rec.level, 'error');
  assert.equal(rec.time, clock.now());
  assert.equal(rec.logError, 'record serialization failed');
  // The offending field is dropped whole, so nothing of it can be partially
  // serialized into the fallback line.
  assert.equal('node' in rec, false);
});

test('the serialization fallback is not a redaction bypass (C3)', () => {
  // The fallback used to re-emit the raw `msg` argument instead of a redacted
  // one, which made it the single path in the logger that skipped the C3
  // choke-point. It takes two independent things to trigger — an unserializable
  // field AND a secret in the message — so nothing in the codebase exercises it
  // today; that is precisely why it needs a test rather than a code reading.
  //
  // The fallback is reached by a `redact` that fails. The real redactor used to
  // get there on its own — it copied an own `toJSON` by reference, so a throwing
  // serializer surfaced at `JSON.stringify` — but it now calls `toJSON` itself
  // and contains the throw per key, so the failure is injected here instead.
  // `redactString` stays the REAL one: it is what the fallback relies on.
  const lines: string[] = [];
  const secret = 'EAAsecret-token-value-000000';
  const clock = createFakeClock(1_700_000_000_000);
  const real = createRedactor({ secrets: [secret] });
  const redactor = {
    ...real,
    redact: (): never => {
      throw new Error('redaction failed');
    },
  };
  const logger = createLogger({ clock, redactor, write: (l) => lines.push(l) });

  const payload = { id: 'response' };
  logger.error(`token exchange failed for ${secret}`, { payload });

  const line = lines[0]!;
  const rec = JSON.parse(line) as Record<string, unknown>;
  assert.equal(rec.logError, 'record serialization failed', 'the fallback ran');
  assert.ok(!line.includes(secret), 'the secret must not reach the sink');
  assert.equal(rec.msg, 'token exchange failed for [REDACTED]');
});

test('a field whose accessor throws cannot make the logger throw', () => {
  const lines: string[] = [];
  const secret = 'EAAfakeLOGvalue0123456789abcdef';
  const clock = createFakeClock(1_700_000_000_000);
  const redactor = createRedactor({ secrets: [secret] });
  const logger = createLogger({ clock, redactor, write: (l) => lines.push(l) });

  // Redaction walks own enumerable properties, which INVOKES accessors. A field
  // whose getter throws therefore fails inside `redact`, before serialization is
  // ever reached — so the JSON.stringify guard alone does not contain it.
  // `redact` now absorbs the throw per-key, which is why the whole-record
  // fallback below is NOT expected to run: one broken field costs its own value
  // and the rest of the record still reaches the operator. The fallback keeps
  // its own coverage in the `toJSON` test above, where the throw happens at
  // serialization time and no per-key containment is possible.
  const hostile = {
    ok: 'this field is readable',
    get detail(): string {
      throw new TypeError('lazily computed field blew up');
    },
  };

  assert.doesNotThrow(() => {
    logger.error(`token exchange failed for ${secret}`, { hostile });
  });

  assert.equal(lines.length, 1, 'a line is still emitted');
  const line = lines[0]!;
  const rec = JSON.parse(line) as Record<string, unknown>;
  assert.equal(rec.logError, undefined, 'the record survived, so no fallback was needed');
  assert.equal(rec.level, 'error');
  assert.equal(rec.msg, 'token exchange failed for [REDACTED]');
  assert.ok(!line.includes(secret), 'the secret must not reach the sink');
  const kept = rec.hostile as Record<string, unknown>;
  assert.equal(
    kept.ok,
    'this field is readable',
    'the readable sibling is not collateral',
  );
  assert.equal(
    typeof kept.detail,
    'string',
    'the unreadable field is marked, not dropped',
  );
});

test('stderr-only: default logger writes to stderr and NEVER stdout (CC-CFG-1)', () => {
  const clock = createFakeClock(42);
  const redactor = createFakeRedactor();
  const logger = createLogger({ clock, redactor }); // default sink = process.stderr

  const errChunks: string[] = [];
  const outChunks: string[] = [];
  const origErr = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    errChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  };
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    outChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  };

  try {
    logger.info('to-stderr', { a: 1 });
    logger.error('also-stderr');
  } finally {
    process.stderr.write = origErr;
    process.stdout.write = origOut;
  }

  assert.equal(outChunks.length, 0, 'nothing may be written to stdout');
  assert.equal(errChunks.length, 2);
  const rec = JSON.parse(errChunks[0]!) as { msg: string; time: number };
  assert.equal(rec.msg, 'to-stderr');
  assert.equal(rec.time, 42);
});

// ---------------------------------------------------------------------------
// Default sink over a stderr that has gone away (the stdout precedent in
// `src/mcp/transport.ts` handles the same failure for the protocol channel).
// ---------------------------------------------------------------------------

/** An EPIPE exactly as libuv reports it once the reader of a pipe is gone. */
function epipe(): NodeJS.ErrnoException {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write' });
}

/** Let the stream's nextTick-scheduled `'error'` / callback bookkeeping run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A `Writable` that records every chunk reaching `_write` and then reports
 * `outcome` for it (`undefined` = success). Delivery attempts are what a test
 * counts: a dead sink must stop producing them.
 */
function recordingStream(
  outcome?: () => Error,
  options: { autoDestroy?: boolean; stderrLike?: boolean } = {},
): { stream: Writable; attempts: string[] } {
  const attempts: string[] = [];
  const stream = new Writable({
    autoDestroy: options.autoDestroy ?? true,
    write(chunk: Buffer | string, _encoding, callback) {
      attempts.push(String(chunk));
      callback(outcome?.());
    },
    ...(options.stderrLike
      ? {
          destroy(
            this: Writable,
            error: Error | null,
            callback: (e?: Error | null) => void,
          ) {
            // What Node's bootstrap installs on `process.stderr` (`dummyDestroy`
            // in `lib/internal/bootstrap/switches/is_main_thread.js`): pass the
            // error on, then un-destroy, so the stdio stream never reports
            // `destroyed` and the NEXT write fails — and errors — all over
            // again. `_undestroy` is not in the public typings.
            callback(error);
            (this as unknown as { _undestroy(): void })._undestroy();
          },
        }
      : {}),
  });
  return { stream, attempts };
}

/** A stream whose reader is gone, behaving as the real `process.stderr` does. */
function deadStderr(): { stream: Writable; attempts: string[] } {
  return recordingStream(epipe, { stderrLike: true });
}

test('stderrSink owns the stream error path: one listener, attached once per stream', () => {
  const { stream } = deadStderr();
  assert.equal(stream.listenerCount('error'), 0);

  stderrSink(stream);
  assert.equal(
    stream.listenerCount('error'),
    1,
    'an error nobody listens for is an uncaught exception — the sink must listen',
  );

  // `createLogger` runs once per process in production but many times in a
  // test process; a listener per call would pile up past the default max of
  // ten and raise MaxListenersExceededWarning.
  for (let i = 0; i < 20; i += 1) stderrSink(stream);
  assert.equal(stream.listenerCount('error'), 1, 'the listener must not accumulate');
});

test('a dead stderr (EPIPE) silences the logger once instead of killing the process', async () => {
  const { stream, attempts } = deadStderr();
  const errors: unknown[] = [];
  const write = stderrSink(stream);
  // The test's own observer. Attached AFTER the sink so it never stands in for
  // the listener the sink is required to own; kept on so a sink that does not
  // listen fails an assertion below instead of taking the runner down.
  stream.on('error', (err) => errors.push(err));
  const logger = createLogger({
    clock: createFakeClock(1),
    redactor: createFakeRedactor(),
    write,
  });

  logger.info('first');
  await settle();
  assert.equal(attempts.length, 1, 'the first line is attempted');
  assert.equal(errors.length, 1, 'and is what surfaces the EPIPE');
  assert.equal(
    stream.destroyed,
    false,
    'process.stderr never reports destroyed after an error, so that flag cannot carry the decision',
  );

  logger.info('second');
  logger.error('third');
  await settle();
  assert.equal(
    attempts.length,
    1,
    'after the first failure the sink is dead: no further line reaches the stream',
  );
  assert.equal(
    errors.length,
    1,
    'and the stream does not error again for every line logged',
  );
});

test('every sink over the same stream goes silent together', async () => {
  // Two loggers over one process.stderr share one pipe; when it dies, it dies for both.
  const { stream, attempts } = deadStderr();
  const errors: unknown[] = [];
  const first = stderrSink(stream);
  const second = stderrSink(stream);
  stream.on('error', (err) => errors.push(err));

  first('{"n":1}\n');
  await settle();
  second('{"n":2}\n');
  first('{"n":3}\n');
  await settle();

  assert.equal(attempts.length, 1);
  assert.equal(errors.length, 1);
});

test('a stream that has already ended receives no write (no write-after-end error)', async () => {
  // `autoDestroy: false` so the stream is ended but NOT destroyed — the case
  // only the `writableEnded` check can catch. A write after `end()` is not a
  // silent drop: Node raises ERR_STREAM_WRITE_AFTER_END as an `'error'` event.
  const { stream, attempts } = recordingStream(undefined, { autoDestroy: false });
  stream.end();
  await settle();
  assert.equal(stream.writableEnded, true);
  assert.equal(stream.destroyed, false);

  const errors: unknown[] = [];
  const write = stderrSink(stream);
  stream.on('error', (err) => errors.push(err));
  write('{"msg":"late"}\n');
  await settle();

  assert.equal(attempts.length, 0);
  assert.equal(errors.length, 0, 'the sink must not provoke a write-after-end error');
});

test('a stream that is already destroyed receives no write', async () => {
  const { stream, attempts } = recordingStream();
  stream.destroy();
  await settle();
  assert.equal(stream.destroyed, true);

  const errors: unknown[] = [];
  const write = stderrSink(stream);
  stream.on('error', (err) => errors.push(err));
  assert.doesNotThrow(() => write('{"msg":"late"}\n'));
  await settle();

  assert.equal(attempts.length, 0);
  assert.equal(errors.length, 0);
});

test('a stream whose write throws synchronously cannot make the logger throw', () => {
  // `process.stderr` redirected to a FILE is a SyncWriteStream: a failed
  // writeSync (EBADF, EIO, ENOSPC) throws out of `write()` itself instead of
  // arriving as an `'error'` event.
  const attempts: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string) {
      attempts.push(String(chunk));
      throw Object.assign(new Error('EBADF: bad file descriptor, write'), {
        code: 'EBADF',
        syscall: 'write',
      });
    },
  });
  const logger = createLogger({
    clock: createFakeClock(1),
    redactor: createFakeRedactor(),
    write: stderrSink(stream),
  });

  assert.doesNotThrow(() => logger.warn('first'));
  assert.doesNotThrow(() => logger.warn('second'));
  assert.equal(attempts.length, 1, 'one failed attempt, then the sink is dead');
});

test('stderrSink writes every line to the stream, newline-terminated (regression)', async () => {
  const stream = new PassThrough();
  const logger = createLogger({
    clock: createFakeClock(7),
    redactor: createFakeRedactor(),
    write: stderrSink(stream),
  });

  logger.info('hello', { a: 1 });
  logger.warn('again');
  stream.end();

  let text = '';
  for await (const chunk of stream) text += String(chunk);
  assert.ok(text.endsWith('\n'));
  const records = text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { msg: string; time: number; a?: number });
  assert.deepEqual(
    records.map((r) => r.msg),
    ['hello', 'again'],
  );
  assert.equal(records[0]?.a, 1);
  assert.equal(records[0]?.time, 7);
});

test('the default sink guards process.stderr itself (production path)', () => {
  const clock = createFakeClock(1);
  const redactor = createFakeRedactor();
  const before = process.stderr.listenerCount('error');

  createLogger({ clock, redactor }); // default sink = stderrSink(process.stderr)
  const after = process.stderr.listenerCount('error');
  assert.ok(
    after >= 1,
    'a default logger must leave process.stderr with an error listener',
  );
  assert.ok(after - before <= 1, 'and adds at most one');

  createLogger({ clock, redactor });
  createLogger({ clock, redactor });
  assert.equal(
    process.stderr.listenerCount('error'),
    after,
    'one listener, however many loggers',
  );
});

test('a TOP-LEVEL field whose accessor throws cannot make the logger throw', () => {
  // The per-key containment in `redact` covers nested accessors, but the
  // caller's own `fields` object used to be read with `Object.entries` before
  // the guard, so its getter threw straight out of `logger.warn`.
  const lines: string[] = [];
  const secret = 'EAAfakeTOPLEVELvalue0123456789ab';
  const clock = createFakeClock(1_700_000_000_000);
  const redactor = createRedactor({ secrets: [secret] });
  const logger = createLogger({ clock, redactor, write: (l) => lines.push(l) });

  const fields = {
    ok: 'kept',
    get boom(): string {
      throw new Error('getter exploded');
    },
  };
  assert.doesNotThrow(() => logger.warn(`retry for ${secret}`, fields));
  assert.equal(lines.length, 1, 'a line is still emitted');
  const rec = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(rec.msg, 'retry for [REDACTED]');
  assert.equal(rec.ok, 'kept', 'the readable sibling survives');
  assert.equal(rec.boom, '[UNREADABLE]');
});
