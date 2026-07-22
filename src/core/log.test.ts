import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from './log.js';
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
