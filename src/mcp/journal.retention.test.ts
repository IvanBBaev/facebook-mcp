// Tests for the write journal's age-based retention (C14, LEG-02 parts 2–3).
//
// Properties under test:
//   * entries older than `retentionDays` are dropped at the first append, once a
//     day after that, and after a size rotation;
//   * a live file whose oldest entry expired is rotated, never rewritten in place,
//     and only the retained generation's expired head is cut off (0600 kept);
//   * an undatable line is dropped only when an expired entry follows it;
//   * `0` disables retention; a held lock or a failed pass never costs the entry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createFakeClock } from '../core/fakes/fakeClock.js';
import { createFakeRedactor } from '../core/fakes/fakeRedactor.js';
import { DEFAULT_JOURNAL_RETENTION_DAYS } from '../core/index.js';
import type { JournalEntryInput } from '../core/index.js';
import { createJournal, retainedJournalText, rotatedJournalPath } from './journal.js';

const isPosix = process.platform !== 'win32';
const DAY = 24 * 60 * 60 * 1000;

function entry(over: Partial<JournalEntryInput> = {}): JournalEntryInput {
  return {
    tool: 'facebook_send_message',
    tier: 'reversible',
    outcome: 'applied',
    summary: 'Send message',
    ...over,
  };
}

/** One NDJSON line as the journal writes it, stamped at `timestamp`. */
function line(summary: string, timestamp: number): string {
  return `${JSON.stringify({ ...entry({ summary }), timestamp })}\n`;
}

function summaries(raw: string): string[] {
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => {
      try {
        return String((JSON.parse(l) as { summary?: unknown }).summary);
      } catch {
        return `<raw:${l}>`;
      }
    });
}

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-journal-retention-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the default retention is 90 days', () => {
  assert.equal(DEFAULT_JOURNAL_RETENTION_DAYS, 90);
});

test('retainedJournalText cuts the head through the last expired entry', () => {
  const text = `${line('old', 1)}not json\n${line('older-by-stamp', 2)}${line('new', 10)}tail\n`;
  const out = retainedJournalText(text, 5);
  assert.equal(out.dropped, true);
  assert.deepEqual(summaries(out.kept), ['new', '<raw:tail>']);
});

test('retainedJournalText keeps the text untouched when nothing expired', () => {
  const text = `torn{\n${line('a', 10)}${line('b', 11)}`;
  const out = retainedJournalText(text, 5);
  assert.equal(out.dropped, false);
  assert.equal(out.kept, text);
});

test('at the first append, an expired live head is rotated and trimmed off', async () => {
  await withDir(async (dir) => {
    const journalPath = path.join(dir, 'journal.ndjson');
    const rotated = rotatedJournalPath(journalPath);
    await writeFile(rotated, line('ancient', 0), { mode: 0o644 });
    await writeFile(journalPath, line('expired', 5 * DAY) + line('recent', 50 * DAY));
    const journal = createJournal({
      clock: createFakeClock(100 * DAY),
      redactor: createFakeRedactor(),
      journalPath,
      retentionDays: 90,
    });

    assert.equal(await journal.append(entry({ summary: 'fresh' })), 'ok');

    assert.deepEqual(summaries(await readFile(rotated, 'utf8')), ['recent']);
    assert.deepEqual(summaries(await readFile(journalPath, 'utf8')), ['fresh']);
    if (isPosix) assert.equal((await stat(rotated)).mode & 0o777, 0o600);
    const history = await journal.history?.();
    assert.ok(history !== undefined && history !== 'unreadable');
    assert.deepEqual(
      history.map((e) => e.summary),
      ['recent', 'fresh'],
    );
  });
});

test('a fully expired retained generation is removed; a current live file stays', async () => {
  await withDir(async (dir) => {
    const journalPath = path.join(dir, 'journal.ndjson');
    const rotated = rotatedJournalPath(journalPath);
    await writeFile(rotated, line('old-1', 1 * DAY) + line('old-2', 2 * DAY));
    await writeFile(journalPath, line('recent', 95 * DAY));
    const journal = createJournal({
      clock: createFakeClock(100 * DAY),
      redactor: createFakeRedactor(),
      journalPath,
    });

    assert.equal(await journal.append(entry({ summary: 'fresh' })), 'ok');

    await assert.rejects(stat(rotated));
    assert.deepEqual(summaries(await readFile(journalPath, 'utf8')), ['recent', 'fresh']);
  });
});

test('after the first pass, retention runs again only once a day has passed', async () => {
  await withDir(async (dir) => {
    const journalPath = path.join(dir, 'journal.ndjson');
    const clock = createFakeClock(10 * DAY);
    const journal = createJournal({
      clock,
      redactor: createFakeRedactor(),
      journalPath,
      retentionDays: 1,
    });
    assert.equal(await journal.append(entry({ summary: 'first' })), 'ok');

    // An expired record appears behind the server's back (another process, a restore).
    const firstLine = await readFile(journalPath, 'utf8');
    await writeFile(journalPath, line('stale', 0) + firstLine);

    clock.advance(60 * 60 * 1000);
    assert.equal(await journal.append(entry({ summary: 'second' })), 'ok');
    assert.deepEqual(summaries(await readFile(journalPath, 'utf8')), [
      'stale',
      'first',
      'second',
    ]);

    clock.advance(DAY);
    assert.equal(await journal.append(entry({ summary: 'third' })), 'ok');
    assert.deepEqual(summaries(await readFile(journalPath, 'utf8')), ['third']);
    // `first` is now a day old; `second` sits exactly on the cutoff and stays.
    assert.deepEqual(summaries(await readFile(rotatedJournalPath(journalPath), 'utf8')), [
      'second',
    ]);
  });
});

test('a size rotation triggers a retention pass on the generation it retains', async () => {
  await withDir(async (dir) => {
    const journalPath = path.join(dir, 'journal.ndjson');
    const clock = createFakeClock(10 * DAY);
    const journal = createJournal({
      clock,
      redactor: createFakeRedactor(),
      journalPath,
      retentionDays: 1,
      maxBytes: 200,
    });
    assert.equal(await journal.append(entry({ summary: 'first' })), 'ok');
    const firstLine = await readFile(journalPath, 'utf8');
    await writeFile(journalPath, line('stale '.repeat(30), 0) + firstLine);

    clock.advance(60 * 60 * 1000);
    assert.equal(await journal.append(entry({ summary: 'second' })), 'ok');

    assert.deepEqual(summaries(await readFile(rotatedJournalPath(journalPath), 'utf8')), [
      'first',
    ]);
    assert.deepEqual(summaries(await readFile(journalPath, 'utf8')), ['second']);
  });
});

test('retentionDays 0 keeps every entry', async () => {
  await withDir(async (dir) => {
    const journalPath = path.join(dir, 'journal.ndjson');
    await writeFile(journalPath, line('ancient', 0));
    const journal = createJournal({
      clock: createFakeClock(10_000 * DAY),
      redactor: createFakeRedactor(),
      journalPath,
      retentionDays: 0,
    });

    assert.equal(await journal.append(entry({ summary: 'fresh' })), 'ok');

    assert.deepEqual(summaries(await readFile(journalPath, 'utf8')), [
      'ancient',
      'fresh',
    ]);
    await assert.rejects(stat(rotatedJournalPath(journalPath)));
  });
});

test('a held rotation lock skips the pass, and the next append retries it', async () => {
  await withDir(async (dir) => {
    const journalPath = path.join(dir, 'journal.ndjson');
    const lockPath = `${journalPath}.rotating`;
    await writeFile(journalPath, line('expired', 0));
    // Held by a live process (this one), so it is not stale.
    await writeFile(lockPath, `${String(process.pid)}\n`);
    const journal = createJournal({
      clock: createFakeClock(100 * DAY),
      redactor: createFakeRedactor(),
      journalPath,
    });

    assert.equal(await journal.append(entry({ summary: 'first' })), 'ok');
    assert.deepEqual(summaries(await readFile(journalPath, 'utf8')), [
      'expired',
      'first',
    ]);

    await rm(lockPath);
    assert.equal(await journal.append(entry({ summary: 'second' })), 'ok');
    assert.deepEqual(summaries(await readFile(journalPath, 'utf8')), ['second']);
    assert.deepEqual(summaries(await readFile(rotatedJournalPath(journalPath), 'utf8')), [
      'first',
    ]);
    await assert.rejects(stat(lockPath));
  });
});

test(
  'a failed retention pass is a note and never costs the entry',
  {
    skip:
      !isPosix || process.getuid?.() === 0
        ? 'needs POSIX modes and a non-root user'
        : false,
  },
  async () => {
    await withDir(async (dir) => {
      const journalPath = path.join(dir, 'journal.ndjson');
      const rotated = rotatedJournalPath(journalPath);
      // A retained generation the server may not read: the pass cannot check it.
      await writeFile(rotated, line('expired', 0), { mode: 0o000 });
      await writeFile(journalPath, line('recent', 99 * DAY));
      const notes: string[] = [];
      const journal = createJournal({
        clock: createFakeClock(100 * DAY),
        redactor: createFakeRedactor(),
        journalPath,
        onError: (message) => notes.push(message),
      });

      assert.equal(await journal.append(entry({ summary: 'fresh' })), 'ok');

      assert.ok(
        notes.some((n) => n.includes('journal retention pass failed')),
        `expected a retention note, got ${JSON.stringify(notes)}`,
      );
      assert.deepEqual(summaries(await readFile(journalPath, 'utf8')), [
        'recent',
        'fresh',
      ]);
      await assert.rejects(stat(`${journalPath}.rotating`));
    });
  },
);

test('a retained generation that is not a regular file is left to rotation, silently', async () => {
  await withDir(async (dir) => {
    const journalPath = path.join(dir, 'journal.ndjson');
    await mkdir(rotatedJournalPath(journalPath));
    await writeFile(journalPath, line('recent', 99 * DAY));
    const notes: string[] = [];
    const journal = createJournal({
      clock: createFakeClock(100 * DAY),
      redactor: createFakeRedactor(),
      journalPath,
      onError: (message) => notes.push(message),
    });

    assert.equal(await journal.append(entry({ summary: 'fresh' })), 'ok');

    assert.deepEqual(notes, []);
    assert.deepEqual(summaries(await readFile(journalPath, 'utf8')), ['recent', 'fresh']);
  });
});

test(
  'a retained generation that cannot even be stat-ed is a note, and the entry lands',
  { skip: !isPosix ? 'needs POSIX symlinks' : false },
  async () => {
    await withDir(async (dir) => {
      const journalPath = path.join(dir, 'journal.ndjson');
      const rotated = rotatedJournalPath(journalPath);
      // A symlink to itself: stat fails with ELOOP, not ENOENT.
      await symlink(path.basename(rotated), rotated);
      await writeFile(journalPath, line('recent', 99 * DAY));
      const notes: string[] = [];
      const journal = createJournal({
        clock: createFakeClock(100 * DAY),
        redactor: createFakeRedactor(),
        journalPath,
        onError: (message) => notes.push(message),
      });

      assert.equal(await journal.append(entry({ summary: 'fresh' })), 'ok');

      assert.ok(
        notes.some((n) => n.includes('journal retention pass failed')),
        `expected a retention note, got ${JSON.stringify(notes)}`,
      );
      assert.deepEqual(summaries(await readFile(journalPath, 'utf8')), [
        'recent',
        'fresh',
      ]);
    });
  },
);
