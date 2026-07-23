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

test('a write failure returns "failed" without throwing and redacts the note (CC-LIFE-1)', async () => {
  const dir = await tmpJournalDir();
  try {
    // Plant a regular FILE where the journal wants a directory: mkdir → ENOTDIR.
    const blocker = path.join(dir, 'blocker');
    await writeFile(blocker, 'x');
    const journalPath = path.join(blocker, 'nested', 'journal.ndjson');

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
