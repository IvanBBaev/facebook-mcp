// Tests for the rotation-aware, redaction-aware write journal (task F13).
//
// Properties under test:
//   * append stamps `timestamp` from the injected Clock and writes one JSON line;
//   * the whole entry passes through the redactor so no secret VALUE reaches disk,
//     and the file is 0600 on POSIX (Security #7 / C3);
//   * appends accumulate (append-only, newline-delimited);
//   * the file rotates at the size threshold, keeping a single generation (G-RUN-1);
//   * a write failure returns `'failed'` and NEVER throws, routing the note through
//     the redactor (CC-LIFE-1).
//
// The network fence blocks `fetch` only, so real filesystem I/O under a temp dir
// is fine here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createFakeClock } from '../core/fakes/fakeClock.js';
import { createFakeRedactor } from '../core/fakes/fakeRedactor.js';
import type { JournalEntryInput } from '../core/index.js';
import { createJournal, JOURNAL_MAX_BYTES, rotatedJournalPath } from './journal.js';

const isPosix = process.platform !== 'win32';

function tmpJournalDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'fbmcp-journal-'));
}

function entry(over: Partial<JournalEntryInput> = {}): JournalEntryInput {
  return {
    tool: 'facebook_delete_post',
    tier: 'irreversible',
    outcome: 'applied',
    summary: 'Delete post 123',
    ...over,
  };
}

function parseLine(line: string | undefined): Record<string, unknown> {
  assert.ok(line, 'expected a non-empty journal line');
  return JSON.parse(line) as Record<string, unknown>;
}

function nonEmptyLines(raw: string): string[] {
  return raw.split('\n').filter((l) => l.length > 0);
}

test('append writes one redacted JSON line, stamped from the clock, at 0600', async () => {
  const dir = await tmpJournalDir();
  try {
    const journalPath = path.join(dir, 'journal.ndjson');
    const clock = createFakeClock(1234);
    const redactor = createFakeRedactor({ secrets: ['SUPER_SECRET_TOKEN'] });
    const journal = createJournal({ clock, redactor, journalPath });

    const status = await journal.append(
      entry({ metadata: { token: 'SUPER_SECRET_TOKEN', postId: '123' } }),
    );
    assert.equal(status, 'ok');

    const raw = await readFile(journalPath, 'utf8');
    // No secret VALUE survives anywhere in the serialized file (Security #7 / C3).
    assert.ok(!raw.includes('SUPER_SECRET_TOKEN'));

    const lines = nonEmptyLines(raw);
    assert.equal(lines.length, 1);
    const parsed = parseLine(lines[0]);
    assert.equal(parsed.timestamp, 1234); // stamped from the injected clock
    assert.equal(parsed.tool, 'facebook_delete_post');
    assert.equal(parsed.outcome, 'applied');

    const meta = parsed.metadata as Record<string, unknown>;
    assert.equal(meta.token, '[REDACTED]'); // secret scrubbed
    assert.equal(meta.postId, '123'); // non-secret preserved

    // The whole entry went through the redactor choke-point.
    assert.equal(redactor.calls.length, 1);

    if (isPosix) {
      const mode = (await stat(journalPath)).mode & 0o777;
      assert.equal(mode, 0o600);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('appends accumulate as newline-delimited entries in order', async () => {
  const dir = await tmpJournalDir();
  try {
    const journalPath = path.join(dir, 'journal.ndjson');
    const clock = createFakeClock(1);
    const journal = createJournal({ clock, redactor: createFakeRedactor(), journalPath });

    assert.equal(await journal.append(entry({ outcome: 'applied' })), 'ok');
    clock.advance(5);
    assert.equal(
      await journal.append(entry({ outcome: 'attempted', error: 'ambiguous' })),
      'ok',
    );

    const lines = nonEmptyLines(await readFile(journalPath, 'utf8'));
    assert.equal(lines.length, 2);
    assert.equal(parseLine(lines[0]).timestamp, 1);
    assert.equal(parseLine(lines[1]).timestamp, 6);
    assert.equal(parseLine(lines[1]).outcome, 'attempted');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rotates the live file at the size threshold, keeping a single generation (G-RUN-1)', async () => {
  const dir = await tmpJournalDir();
  try {
    const journalPath = path.join(dir, 'journal.ndjson');
    const clock = createFakeClock(0);
    // Tiny threshold so a handful of entries crosses it.
    const journal = createJournal({
      clock,
      redactor: createFakeRedactor(),
      journalPath,
      maxBytes: 200,
    });

    const total = 6;
    for (let i = 0; i < total; i += 1) {
      clock.advance(1);
      const status = await journal.append(
        entry({
          summary: `entry ${i} padded out so each serialized line comfortably exceeds one hundred bytes`,
        }),
      );
      assert.equal(status, 'ok');
    }

    // Rotation happened: the .1 generation exists and is non-empty.
    const rotated = rotatedJournalPath(journalPath);
    const rotatedStat = await stat(rotated);
    assert.ok(rotatedStat.size > 0);

    // The live file was reset by rotation, so it holds fewer than all entries.
    const liveLines = nonEmptyLines(await readFile(journalPath, 'utf8'));
    assert.ok(liveLines.length >= 1);
    assert.ok(liveLines.length < total, 'live file should have been reset by rotation');

    // Only ONE generation is retained — no journal.2.ndjson.
    await assert.rejects(stat(path.join(dir, 'journal.2.ndjson')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('repeated rotations stay at one generation and keep the NEWEST one (G-RUN-1)', async () => {
  const dir = await tmpJournalDir();
  try {
    const journalPath = path.join(dir, 'journal.ndjson');
    const maxBytes = 512;
    const journal = createJournal({
      clock: createFakeClock(0),
      redactor: createFakeRedactor(),
      journalPath,
      maxBytes,
    });

    // Two rotations, each with a distinguishable live file planted beforehand.
    // A single rotation only proves `.2` is never created on the first pass; the
    // bound is about what happens on the SECOND, where the retained generation
    // has to be dropped rather than shifted down to `.2`.
    await writeFile(journalPath, `${'A'.repeat(maxBytes)}\n`);
    assert.equal(await journal.append(entry({ summary: 'after first rotation' })), 'ok');
    const rotated = rotatedJournalPath(journalPath);
    assert.match(await readFile(rotated, 'utf8'), /^A+$/m);

    await writeFile(journalPath, `${'B'.repeat(maxBytes)}\n`);
    assert.equal(await journal.append(entry({ summary: 'after second rotation' })), 'ok');

    const kept = await readFile(rotated, 'utf8');
    assert.match(kept, /^B+$/m, 'the retained generation is the most recent one');
    assert.ok(
      !kept.includes('AAAA'),
      'the older generation was dropped, not appended to',
    );
    await assert.rejects(
      stat(path.join(dir, 'journal.2.ndjson')),
      'generations must not accumulate on disk',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the journal directory it creates is 0700 on POSIX (Security #7)', async () => {
  const dir = await tmpJournalDir();
  try {
    // `mkdtemp` already makes ITS directory 0700, so point at a nested path the
    // journal has to create itself — that is the one whose mode is under test.
    const journalDir = path.join(dir, 'nested', 'state');
    const journal = createJournal({
      clock: createFakeClock(0),
      redactor: createFakeRedactor(),
      journalPath: path.join(journalDir, 'journal.ndjson'),
    });

    assert.equal(await journal.append(entry()), 'ok');

    if (isPosix) {
      // The file is 0600, but a group- or world-readable PARENT still exposes the
      // entry names and sizes, and a writable one lets anyone swap the file out.
      assert.equal((await stat(journalDir)).mode & 0o777, 0o700);
      assert.equal((await stat(path.join(dir, 'nested'))).mode & 0o777, 0o700);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent appends that race a rotation all reach disk, in submission order', async () => {
  const dir = await tmpJournalDir();
  try {
    const journalPath = path.join(dir, 'journal.ndjson');
    // Big enough that the eight entries below (~112 bytes each) never cross it on
    // their own, so the ONLY rotation in this test is the one the burst races.
    const maxBytes = 2048;
    // Plant an already-over-size live file, so the burst below starts on the exact
    // edge where rotation happens: every caller stats the same over-size file at
    // once. Unserialized, they all decide to rotate — one `rename` wins and the
    // rest fail with ENOENT, silently dropping their entries (CC-LIFE-2).
    await writeFile(journalPath, `${'x'.repeat(maxBytes)}\n`);

    const journal = createJournal({
      clock: createFakeClock(0),
      redactor: createFakeRedactor(),
      journalPath,
      maxBytes,
    });

    const total = 8;
    const statuses = await Promise.all(
      Array.from({ length: total }, (_, i) =>
        journal.append(entry({ summary: `concurrent ${i}` })),
      ),
    );
    assert.deepEqual(
      statuses,
      Array.from({ length: total }, () => 'ok'),
    );

    // Exactly one rotation: the planted content is the retained generation, and
    // every one of the eight entries is in the live file.
    assert.match(await readFile(rotatedJournalPath(journalPath), 'utf8'), /^x+$/m);
    const lines = nonEmptyLines(await readFile(journalPath, 'utf8'));
    assert.equal(lines.length, total, 'no entry may be lost to the rotation race');
    assert.deepEqual(
      lines.map((l) => parseLine(l).summary),
      Array.from({ length: total }, (_, i) => `concurrent ${i}`),
      'the queue is FIFO, so entries land in the order they were submitted',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('one failed append does not poison the writes queued behind it', async () => {
  const dir = await tmpJournalDir();
  try {
    const journalPath = path.join(dir, 'journal.ndjson');
    const journal = createJournal({
      clock: createFakeClock(0),
      redactor: createFakeRedactor(),
      journalPath,
      onError: () => undefined,
    });

    // A value `JSON.stringify` refuses: the entry fails before it ever reaches the
    // queue, but a shared promise chain is exactly the kind of thing a rejection
    // can wedge, so the next caller has to still get through.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const bad = await journal.append(entry({ metadata: circular }));
    assert.equal(bad, 'failed');

    assert.equal(await journal.append(entry({ summary: 'after the failure' })), 'ok');
    const lines = nonEmptyLines(await readFile(journalPath, 'utf8'));
    assert.equal(lines.length, 1);
    assert.equal(parseLine(lines[0]).summary, 'after the failure');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a write failure returns "failed" without throwing and redacts the note (CC-LIFE-1)', async () => {
  const dir = await tmpJournalDir();
  try {
    // Plant a regular FILE where the journal wants a directory: mkdir → ENOTDIR.
    const blocker = path.join(dir, 'blocker');
    await writeFile(blocker, 'x');
    // The failing path SEGMENT is the registered secret, so the OS error message
    // quotes it back — which is how a filesystem error becomes a leak channel and
    // why the note is worth asserting on, not just counting.
    const journalPath = path.join(blocker, 'SECRET', 'journal.ndjson');

    const redactor = createFakeRedactor({ secrets: ['SECRET'] });
    const errors: string[] = [];
    const journal = createJournal({
      clock: createFakeClock(0),
      redactor,
      journalPath,
      onError: (m) => errors.push(m),
    });

    // Must resolve (never reject) with 'failed' — a journal miss cannot block the write.
    const status = await journal.append(entry());
    assert.equal(status, 'failed');
    assert.equal(errors.length, 1);
    // The failure note was routed through the redactor choke-point.
    assert.equal(redactor.stringCalls.length, 1);
    const note = errors[0] ?? '';
    assert.match(note, /ENOTDIR|not a directory/, 'the note still says what went wrong');
    assert.ok(!note.includes('SECRET'), 'the raw secret must not survive in the note');
    assert.ok(note.includes('[REDACTED]'), 'it was replaced, not merely dropped');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rotatedJournalPath inserts a .1 generation before the extension', () => {
  assert.equal(
    rotatedJournalPath(path.join('/var', 'data', 'journal.ndjson')),
    path.join('/var', 'data', 'journal.1.ndjson'),
  );
  assert.equal(JOURNAL_MAX_BYTES, 5 * 1024 * 1024);
});
