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

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

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

test('the generation rotation retains is 0600 too, not whatever it inherited', async () => {
  const dir = await tmpJournalDir();
  try {
    const journalPath = path.join(dir, 'journal.ndjson');
    // A journal file the server did not create with its own `appendFile` mode:
    // restored from a backup, copied in by an operator, left behind by an older
    // build, or a file whose one `chmod` happened to fail. The live file heals
    // itself on the next append — but rotation is the one place the module
    // creates a SECOND file, by `rename`, which carries the mode across, and
    // nothing ever revisits the retained generation. Its content is the same
    // set of entries (tool names, Page ids, summaries) the 0600 promise in this
    // module's header covers, so it cannot be left group/world readable for the
    // rest of the deployment's life.
    await writeFile(journalPath, `${'x'.repeat(400)}\n`);
    await chmod(journalPath, 0o644);

    const journal = createJournal({
      clock: createFakeClock(0),
      redactor: createFakeRedactor(),
      journalPath,
      maxBytes: 200,
    });
    assert.equal(await journal.append(entry()), 'ok');

    const rotated = rotatedJournalPath(journalPath);
    assert.ok((await stat(rotated)).size > 0, 'the old content was retained');
    if (isPosix) {
      assert.equal((await stat(journalPath)).mode & 0o777, 0o600, 'live file');
      assert.equal((await stat(rotated)).mode & 0o777, 0o600, 'retained generation');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** `chflags` (BSD/macOS) — sets or clears the user append-only flag. */
const chflags = (flag: 'uappnd' | 'nouappnd', file: string): Promise<unknown> =>
  promisify(execFile)('chflags', [flag, file]);

test(
  'an append-only journal records the entry and answers ok, not failed',
  {
    skip:
      process.platform !== 'darwin' ? 'needs BSD chflags (user append-only flag)' : false,
  },
  async () => {
    // Append-only is the textbook hardening for an audit log (tamper evidence):
    // the kernel still accepts O_APPEND writes but refuses chmod with EPERM.
    // The journal chmod-ed unconditionally AFTER the bytes were on disk, so every
    // append threw past a successful write and answered `'failed'` — the caller
    // (and `ApplyResult.journalStatus`) told the record is missing while it is
    // sitting in the file, for every write of the deployment.
    const dir = await tmpJournalDir();
    const journalPath = path.join(dir, 'journal.ndjson');
    try {
      await writeFile(journalPath, '', { mode: 0o600 });
      await chmod(journalPath, 0o600);
      await chflags('uappnd', journalPath);
      const notes: string[] = [];
      const journal = createJournal({
        clock: createFakeClock(0),
        redactor: createFakeRedactor(),
        journalPath,
        onError: (message) => notes.push(message),
      });

      assert.equal(await journal.append(entry({ summary: 'first' })), 'ok');
      assert.equal(await journal.append(entry({ summary: 'second' })), 'ok');
      const lines = nonEmptyLines(await readFile(journalPath, 'utf8'));
      assert.deepEqual(
        lines.map((l) => parseLine(l).summary),
        ['first', 'second'],
      );
      assert.deepEqual(notes, [], 'the file is already 0600: nothing to report');
    } finally {
      await chflags('nouappnd', journalPath).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'a loose-mode journal that cannot be chmod-ed still records, and says the mode is wrong',
  {
    skip:
      process.platform !== 'darwin' ? 'needs BSD chflags (user append-only flag)' : false,
  },
  async () => {
    const dir = await tmpJournalDir();
    const journalPath = path.join(dir, 'journal.ndjson');
    try {
      await writeFile(journalPath, '');
      await chmod(journalPath, 0o644);
      await chflags('uappnd', journalPath);
      const notes: string[] = [];
      const journal = createJournal({
        clock: createFakeClock(0),
        redactor: createFakeRedactor(),
        journalPath,
        onError: (message) => notes.push(message),
      });

      assert.equal(await journal.append(entry()), 'ok', 'the record is on disk');
      assert.equal(nonEmptyLines(await readFile(journalPath, 'utf8')).length, 1);
      assert.equal(notes.length, 1, 'one note for the unenforceable mode');
      assert.match(notes[0] ?? '', /0600/);
      assert.match(notes[0] ?? '', /0644/);
    } finally {
      await chflags('nouappnd', journalPath).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  },
);

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
    // The failure has to be INJECTED now. This test used to reach for a
    // reference cycle, on the theory that a value `JSON.stringify` refuses is
    // the natural way one append fails while the journal stays usable — but
    // that stopped being true when the structural strip started absorbing every
    // hostile shape the data can take (see 'an entry survives metadata that
    // JSON.stringify refuses'). What is left that can still fail one call is a
    // collaborator seam, and the redactor is the one that runs per entry.
    const base = createFakeRedactor();
    const journal = createJournal({
      clock: createFakeClock(0),
      redactor: {
        ...base,
        redact: (value: unknown): unknown => {
          if ((value as { summary?: unknown }).summary === 'the redactor throws') {
            throw new Error('redactor boom');
          }
          return base.redact(value);
        },
      },
      journalPath,
      onError: () => undefined,
    });

    // The entry fails before it ever reaches the queue, but a shared promise
    // chain is exactly the kind of thing a rejection can wedge, so the next
    // caller has to still get through.
    const bad = await journal.append(entry({ summary: 'the redactor throws' }));
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
    // The blocker ITSELF carries the registered secret, so the OS error message
    // quotes it back whichever component that platform names — POSIX reports the
    // deepest path it tried, win32 stops at the blocker. That quoting is how a
    // filesystem error becomes a leak channel, and why the note is worth
    // asserting on rather than just counting.
    const blocker = path.join(dir, 'SECRET');
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
    const note = errors[0] ?? '';
    assert.match(note, /ENOTDIR|not a directory/, 'the note still says what went wrong');
    assert.ok(!note.includes('SECRET'), 'the raw secret must not survive in the note');
    assert.ok(note.includes('[REDACTED]'), 'it was replaced, not merely dropped');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  'a journal path that names a directory is refused without chmod-ing that directory',
  { skip: !isPosix && 'POSIX modes do not apply on win32' },
  async () => {
    const dir = await tmpJournalDir();
    try {
      // FB_JOURNAL_PATH=~/fb-journal/ — an operator naming the folder rather than
      // the file. The journal must not tighten that folder to 0600: with its
      // execute bit gone nothing inside it can be reached, owner included.
      const target = path.join(dir, 'operator-folder');
      await mkdir(target);
      await chmod(target, 0o755);
      await writeFile(path.join(target, 'keep.txt'), 'operator data');
      const errors: string[] = [];
      const journal = createJournal({
        clock: createFakeClock(0),
        redactor: createFakeRedactor(),
        journalPath: target,
        onError: (m) => errors.push(m),
      });

      const status = await journal.append(entry());

      assert.equal(status, 'failed', 'nothing was recorded, so it must not say ok');
      assert.equal(
        (await stat(target)).mode & 0o777,
        0o755,
        'the directory keeps the mode the operator gave it',
      );
      assert.equal(
        await readFile(path.join(target, 'keep.txt'), 'utf8'),
        'operator data',
      );
      assert.equal(errors.length, 1);
      assert.match(errors[0] ?? '', /is a directory/, 'the note says why');
    } finally {
      await chmod(path.join(dir, 'operator-folder'), 0o755).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test('append never throws even when the failure-reporting path itself throws (CC-LIFE-1)', async () => {
  const dir = await tmpJournalDir();
  try {
    // Same ENOTDIR blocker as above, so the write leg genuinely fails and the
    // catch block runs. What differs is that the two collaborators the catch
    // block calls -- the injected `onError` sink and the redactor -- are the ones
    // that blow up. Both are public seams (`JournalDeps.onError`, `Redactor`), so
    // a host can wire a logger that throws on a closed stream, or a redactor that
    // chokes on a pathological message. The `Journal` contract is absolute -- it
    // "is non-blocking and NEVER throws" -- because `append` sits on the hot path
    // after a REAL Graph write has already happened: a rejection here turns a
    // succeeded, irreversible write into a reported failure (CC-LIFE-1).
    const blocker = path.join(dir, 'blocker');
    await writeFile(blocker, 'x');
    const journalPath = path.join(blocker, 'nested', 'journal.ndjson');

    // 1. A sink that throws (e.g. a logger writing to an already-closed stream).
    const throwingSink = createJournal({
      clock: createFakeClock(0),
      redactor: createFakeRedactor(),
      journalPath,
      onError: () => {
        throw new Error('sink is closed');
      },
    });
    assert.equal(await throwingSink.append(entry()), 'failed');

    // 2. A redactor whose string pass throws before the sink is ever reached.
    const base = createFakeRedactor();
    const throwingRedactor = {
      ...base,
      redactString: (): string => {
        throw new Error('redactor exploded');
      },
    };
    const notes: string[] = [];
    const throwingRedact = createJournal({
      clock: createFakeClock(0),
      redactor: throwingRedactor,
      journalPath,
      onError: (m) => notes.push(m),
    });
    assert.equal(await throwingRedact.append(entry()), 'failed');
    // Nothing could be reported -- but the return value still carried the miss,
    // and crucially an UNREDACTED note was not emitted as a fallback (C3).
    assert.deepEqual(notes, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a record appended behind a torn last line lands on a line of its own', async () => {
  const dir = await tmpJournalDir();
  try {
    const journalPath = path.join(dir, 'journal.ndjson');
    // What a crash mid-write leaves behind: one whole record, then one cut off
    // before its newline (SIGKILL, power loss, ENOSPC part-way through a line).
    const whole = JSON.stringify({
      tool: 'facebook_delete_post',
      outcome: 'applied',
      timestamp: 1,
    });
    const torn = '{"tool":"facebook_delete_post","tier":"irreversible","outcome":"att';
    await writeFile(journalPath, `${whole}\n${torn}`, { mode: 0o600 });

    const journal = createJournal({
      clock: createFakeClock(2),
      redactor: createFakeRedactor(),
      journalPath,
    });
    assert.equal(
      await journal.append(entry({ summary: 'first write after the crash' })),
      'ok',
    );

    let lines = nonEmptyLines(await readFile(journalPath, 'utf8'));
    // The tear itself stays: the file is append-only and nothing rewrites
    // history. But the record written AFTER it must be a line of its own that
    // parses — not glued onto the tear, where a one-JSON.parse-per-line reader
    // loses it along with the fragment.
    assert.equal(
      lines.length,
      3,
      `expected whole + torn + new, got:\n${lines.join('\n')}`,
    );
    assert.equal(lines[1], torn);
    const healed = parseLine(lines[2]);
    assert.equal(healed.summary, 'first write after the crash');
    assert.equal(healed.timestamp, 2);

    // A whole last line is left alone: no blank line is ever inserted between
    // two intact records.
    assert.equal(await journal.append(entry({ summary: 'second write' })), 'ok');
    const raw = await readFile(journalPath, 'utf8');
    lines = nonEmptyLines(raw);
    assert.equal(lines.length, 4);
    assert.ok(!raw.includes('\n\n'), 'a blank line was inserted between intact records');
    assert.equal(parseLine(lines[3]).summary, 'second write');
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

// ---------------------------------------------------------------------------
// The journal is the only record that a destructive write happened. Two
// properties it has to hold whatever it is handed: the line lands (an entry is
// never lost because a field was awkward), and the line parses (a reader
// tailing the file with `JSON.parse` per line never hits a wall).
// ---------------------------------------------------------------------------

test('an entry survives metadata that JSON.stringify refuses', async () => {
  const dir = await tmpJournalDir();
  try {
    const journalPath = path.join(dir, 'journal.ndjson');
    const journal = createJournal({
      clock: createFakeClock(7),
      redactor: createFakeRedactor(),
      journalPath,
    });

    // Every one of these is a value `JSON.stringify` throws on rather than
    // skips. The metadata is the least important field in the record; losing
    // the fact that an irreversible write was applied because of it is the
    // worst trade the journal could make.
    const cyclic: Record<string, unknown> = { postId: '123' };
    cyclic.self = cyclic;
    const deep: unknown = JSON.parse(`${'['.repeat(5_000)}1${']'.repeat(5_000)}`);

    const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['a reference cycle', cyclic],
      ['a bigint', { reach: 10n }],
      ['nesting past the recursion limit', { tree: deep }],
      [
        'an accessor that throws',
        {
          get postId(): string {
            throw new Error('accessor boom');
          },
        },
      ],
    ];

    for (const [label, metadata] of cases) {
      const status = await journal.append(entry({ metadata, summary: label }));
      assert.equal(status, 'ok', `${label}: the write was still recorded`);
    }

    const lines = nonEmptyLines(await readFile(journalPath, 'utf8'));
    assert.equal(lines.length, cases.length, 'one line per attempted append');
    for (const [i, line] of lines.entries()) {
      const parsed = parseLine(line);
      assert.equal(parsed.tool, 'facebook_delete_post');
      assert.equal(parsed.outcome, 'applied');
      assert.equal(parsed.summary, cases[i]?.[0]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a line that would not parse is never written, and never reported as ok', async () => {
  const dir = await tmpJournalDir();
  try {
    const journalPath = path.join(dir, 'journal.ndjson');
    const notes: string[] = [];
    // A redactor that hands back `undefined` — `JSON.stringify(undefined)` is
    // itself `undefined`, and template-interpolating that writes the four
    // letters "undefined" as if they were a record.
    const journal = createJournal({
      clock: createFakeClock(7),
      redactor: { ...createFakeRedactor(), redact: () => undefined },
      journalPath,
      onError: (m) => notes.push(m),
    });

    const status = await journal.append(entry());
    let raw = '';
    try {
      raw = await readFile(journalPath, 'utf8');
    } catch {
      raw = '';
    }
    for (const line of nonEmptyLines(raw)) {
      assert.doesNotThrow(() => JSON.parse(line), `unparseable journal line: ${line}`);
    }
    if (status === 'ok') {
      assert.equal(nonEmptyLines(raw).length, 1, "'ok' must mean a record is on disk");
    } else {
      assert.ok(notes.length > 0, 'a failure the operator can see');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an access_token query value is stripped structurally, not only by value', async () => {
  const dir = await tmpJournalDir();
  try {
    const journalPath = path.join(dir, 'journal.ndjson');
    // Deliberately a secret the redactor was NEVER told about and that matches
    // none of its defensive patterns: not `EAA`-shaped, not 32- or 64-hex. The
    // journal's own header promises no secret reaches disk, and today that
    // promise is held entirely by four other files remembering to register
    // every value. `result.ts` does not take that bet for the model-facing
    // channel; the on-disk channel should not either.
    const unregistered = 'zzz-not-an-eaa-token-9182';
    const journal = createJournal({
      clock: createFakeClock(7),
      redactor: createFakeRedactor(),
      journalPath,
    });

    await journal.append(
      entry({
        error: `Graph returned HTML for GET /me/feed?access_token=${unregistered}&fields=id`,
        metadata: { access_token: unregistered },
      }),
    );

    const raw = await readFile(journalPath, 'utf8');
    assert.ok(!raw.includes(unregistered), 'the token value never reaches the file');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Types a deliberately non-Error throwable so it can be thrown or rejected. */
function notAnError(value: object): Error {
  return value as Error;
}

test('a non-Error thrown on the write path is still reported with its text', async () => {
  const dir = await tmpJournalDir();
  try {
    const journalPath = path.join(dir, 'journal.ndjson');
    // The redactor is an injected seam: a host implementation that throws a plain
    // `{ message }` object (or a value with no string form at all) must still
    // produce a readable note, not "[object Object]" or no note whatsoever.
    for (const [thrown, expected] of [
      [{ message: 'redactor choked' }, 'redactor choked'],
      [Object.create(null) as object, 'unknown error (no message)'],
    ] as const) {
      const base = createFakeRedactor();
      const notes: string[] = [];
      const journal = createJournal({
        clock: createFakeClock(0),
        redactor: {
          ...base,
          redact: (): never => {
            throw notAnError(thrown);
          },
        },
        journalPath,
        onError: (m) => notes.push(m),
      });
      assert.equal(await journal.append(entry()), 'failed');
      assert.deepEqual(notes, [expected]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a rotation that fails still records the entry, and does not wedge the journal', async () => {
  const dir = await tmpJournalDir();
  try {
    const journalPath = path.join(dir, 'journal.ndjson');
    const maxBytes = 200;
    // An over-cap live file, and something rotation cannot clear where the
    // retained generation goes: a non-empty DIRECTORY (an operator's backup
    // folder, a restore gone wrong). `rm` without `recursive` refuses it, so
    // every rotation attempt fails -- on this append and on every one after it,
    // because the live file stays over the cap. Rotation is housekeeping; the
    // entry is the payload. Losing the record of a write that really happened
    // because the PREVIOUS generation could not be deleted is the wrong trade,
    // and losing every record after it is the journal silently switching off.
    await writeFile(journalPath, `${'A'.repeat(maxBytes)}\n`);
    const rotated = rotatedJournalPath(journalPath);
    await mkdir(rotated);
    await writeFile(path.join(rotated, 'keep'), 'x');

    const notes: string[] = [];
    const journal = createJournal({
      clock: createFakeClock(0),
      redactor: createFakeRedactor(),
      journalPath,
      maxBytes,
      onError: (m) => notes.push(m),
    });

    assert.equal(
      await journal.append(entry({ summary: 'first after failed rotation' })),
      'ok',
    );
    assert.equal(
      await journal.append(entry({ summary: 'second after failed rotation' })),
      'ok',
    );

    const lines = nonEmptyLines(await readFile(journalPath, 'utf8'));
    assert.deepEqual(
      lines.slice(1).map((l) => parseLine(l).summary),
      ['first after failed rotation', 'second after failed rotation'],
      'both entries are on disk, in order, each on its own parseable line',
    );
    assert.equal(notes.length, 2, 'each failed rotation is still reported');
    assert.match(
      notes[0] ?? '',
      /rotat/i,
      'the note says it was the rotation that failed',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a retained generation whose chmod fails is reported as that, not as a failed rotation', async (t) => {
  if (!isPosix) {
    t.skip('POSIX permission bits only');
    return;
  }
  const dir = await tmpJournalDir();
  const rotated = rotatedJournalPath(path.join(dir, 'journal.ndjson'));
  // The rename has already happened when the chmod of the retained generation
  // runs, so the rotation DID take place: the live file moved and this record
  // starts a fresh one. The note used to say "rotation failed, appending past
  // the size cap" — false on both counts — and never said the one thing that
  // was true: the retained generation kept its loose bits.
  const realChmod = fsPromises.chmod;
  const chmodMock = mock.method(
    fsPromises,
    'chmod',
    (target: Parameters<typeof realChmod>[0], mode: Parameters<typeof realChmod>[1]) =>
      String(target) === rotated
        ? Promise.reject(
            Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }),
          )
        : realChmod(target, mode),
  );
  syncBuiltinESMExports();
  try {
    const journalPath = path.join(dir, 'journal.ndjson');
    await writeFile(journalPath, `${'x'.repeat(400)}\n`);
    await realChmod(journalPath, 0o644);
    const notes: string[] = [];
    const journal = createJournal({
      clock: createFakeClock(0),
      redactor: createFakeRedactor(),
      journalPath,
      maxBytes: 200,
      onError: (m) => notes.push(m),
    });
    assert.equal(await journal.append(entry({ summary: 'after rotation' })), 'ok');

    // The rotation really happened.
    assert.match(await readFile(rotated, 'utf8'), /^x+$/m);
    const live = nonEmptyLines(await readFile(journalPath, 'utf8'));
    assert.deepEqual(
      live.map((l) => parseLine(l).summary),
      ['after rotation'],
    );
    assert.equal(notes.length, 1, 'exactly one note');
    assert.doesNotMatch(notes[0] ?? '', /rotation failed|past the size cap/);
    assert.match(notes[0] ?? '', /0600/);
    assert.match(notes[0] ?? '', /EPERM/);
  } finally {
    chmodMock.mock.restore();
    syncBuiltinESMExports();
    await rm(dir, { recursive: true, force: true });
  }
});

test('two servers sharing one journal never rotate away the other server records', async () => {
  // Every MCP client spawns its own server, and every server defaults to the
  // same per-user journal path — so two processes rotating one file is the
  // ordinary deployment, not a corner. The in-process FIFO serializes only its
  // own instance. A server that measured the file over the cap and then lost
  // the race to another server's rotation went on to rotate AGAIN, on a stale
  // measurement: it renamed the other server's fresh live file over the
  // retained generation, deleting every record rotation had just preserved.
  // Two instances on one path stand in for the two processes.
  const dir = await tmpJournalDir();
  const journalPath = path.join(dir, 'journal.ndjson');
  const maxBytes = 200;
  const realRename = fsPromises.rename;
  let pausedOnce = false;
  let arrived!: () => void;
  const atRename = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Hold the FIRST rename (server A's rotation) until server B has finished a
  // whole append — the interleaving two processes get from the scheduler.
  const renameMock = mock.method(
    fsPromises,
    'rename',
    async (
      from: Parameters<typeof realRename>[0],
      to: Parameters<typeof realRename>[1],
    ) => {
      if (!pausedOnce) {
        pausedOnce = true;
        arrived();
        await released;
      }
      return realRename(from, to);
    },
  );
  syncBuiltinESMExports();
  try {
    await writeFile(journalPath, `${'A'.repeat(maxBytes)}\n`, { mode: 0o600 });
    const make = (): ReturnType<typeof createJournal> =>
      createJournal({
        clock: createFakeClock(0),
        redactor: createFakeRedactor(),
        journalPath,
        maxBytes,
        onError: () => undefined,
      });
    const serverA = make();
    const serverB = make();

    const appendA = serverA.append(entry({ summary: 'from server A' }));
    await atRename;
    assert.equal(await serverB.append(entry({ summary: 'from server B' })), 'ok');
    release();
    assert.equal(await appendA, 'ok');

    const readOrEmpty = (file: string): Promise<string> =>
      readFile(file, 'utf8').catch(() => '');
    const everything =
      (await readOrEmpty(rotatedJournalPath(journalPath))) +
      (await readOrEmpty(journalPath));
    assert.ok(
      everything.includes('A'.repeat(maxBytes)),
      'the records that were over the cap survive the second server rotation',
    );
    assert.ok(everything.includes('from server A'), 'server A record is on disk');
    assert.ok(everything.includes('from server B'), 'server B record is on disk');
  } finally {
    renameMock.mock.restore();
    syncBuiltinESMExports();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an append that loses its live file to another server rotation still records the entry', async () => {
  // Between measuring the live file and reading its last byte (the torn-line
  // check), another server sharing the journal may rotate it away. The file is
  // not gone — it is the retained generation now — and the right answer is a
  // fresh live file holding this record. Instead the `open` hit ENOENT, the
  // whole append answered 'failed', and the record of a write that really
  // happened was never written.
  const dir = await tmpJournalDir();
  const journalPath = path.join(dir, 'journal.ndjson');
  const rotated = rotatedJournalPath(journalPath);
  const realOpen = fsPromises.open;
  const realRename = fsPromises.rename;
  let rotatedAway = false;
  const openMock = mock.method(
    fsPromises,
    'open',
    async (...args: Parameters<typeof realOpen>) => {
      if (!rotatedAway && String(args[0]) === journalPath) {
        rotatedAway = true;
        await realRename(journalPath, rotated); // the other server's rotation
      }
      return realOpen(...args);
    },
  );
  syncBuiltinESMExports();
  try {
    await writeFile(journalPath, '{"earlier":true}\n', { mode: 0o600 });
    const notes: string[] = [];
    const journal = createJournal({
      clock: createFakeClock(0),
      redactor: createFakeRedactor(),
      journalPath,
      onError: (m) => notes.push(m),
    });
    assert.equal(await journal.append(entry({ summary: 'raced' })), 'ok');
    assert.ok(rotatedAway, 'the race was staged');
    assert.deepEqual(
      nonEmptyLines(await readFile(journalPath, 'utf8')).map((l) => parseLine(l).summary),
      ['raced'],
    );
    assert.match(await readFile(rotated, 'utf8'), /"earlier":true/);
    assert.deepEqual(notes, []);
  } finally {
    openMock.mock.restore();
    syncBuiltinESMExports();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a rotation lock left by a server that no longer exists does not stop rotation', async () => {
  // The cross-process rotation lock carries its holder's pid. A server killed
  // mid-rotation leaves the file behind; if that alone blocked rotation, the
  // journal would grow without bound for the rest of the deployment.
  const dir = await tmpJournalDir();
  try {
    const journalPath = path.join(dir, 'journal.ndjson');
    const maxBytes = 200;
    const child = await promisify(execFile)(process.execPath, [
      '-e',
      'process.stdout.write(String(process.pid))',
    ]);
    const deadPid = Number(child.stdout);
    assert.ok(Number.isSafeInteger(deadPid) && deadPid > 0);
    await writeFile(`${journalPath}.rotating`, `${deadPid}\n`);
    await writeFile(journalPath, `${'A'.repeat(maxBytes)}\n`, { mode: 0o600 });
    const notes: string[] = [];
    const journal = createJournal({
      clock: createFakeClock(0),
      redactor: createFakeRedactor(),
      journalPath,
      maxBytes,
      onError: (m) => notes.push(m),
    });
    assert.equal(await journal.append(entry({ summary: 'after stale lock' })), 'ok');
    assert.match(await readFile(rotatedJournalPath(journalPath), 'utf8'), /^A+$/m);
    assert.deepEqual(
      nonEmptyLines(await readFile(journalPath, 'utf8')).map((l) => parseLine(l).summary),
      ['after stale lock'],
    );
    await assert.rejects(stat(`${journalPath}.rotating`), 'the lock is released');
    assert.deepEqual(notes, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a rotation lock that stays held is reported once, and records still land', async () => {
  const dir = await tmpJournalDir();
  try {
    const journalPath = path.join(dir, 'journal.ndjson');
    const maxBytes = 200;
    // Held by a live process (this one, standing in for another server).
    await writeFile(`${journalPath}.rotating`, `${process.pid}\n`);
    await writeFile(journalPath, `${'A'.repeat(maxBytes)}\n`, { mode: 0o600 });
    const notes: string[] = [];
    const journal = createJournal({
      clock: createFakeClock(0),
      redactor: createFakeRedactor(),
      journalPath,
      maxBytes,
      onError: (m) => notes.push(m),
    });
    for (let i = 0; i < 5; i += 1) {
      assert.equal(await journal.append(entry({ summary: `held ${i}` })), 'ok');
    }
    assert.equal(nonEmptyLines(await readFile(journalPath, 'utf8')).length, 6);
    assert.equal(notes.length, 1, 'said once, not on every append');
    assert.match(notes[0] ?? '', /journal\.ndjson\.rotating/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
