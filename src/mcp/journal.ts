// Redaction-aware, rotation-aware append-only write journal (task F13, `mcp`).
//
// The journal records every gated write (plan/apply outcome) as one JSON line so
// an operator can reconcile what the server did — especially the *ambiguous*
// writes whose wire outcome is unknown (CC-LIFE-2 / C2). It is deliberately the
// weakest link in the write path by design:
//
//   * NON-BLOCKING & NEVER THROWS. A journal failure (disk full, permission,
//     serialization) must never block or fail the real Graph write — `append`
//     swallows every error and returns `'failed'` so the caller records the miss
//     and proceeds (CC-LIFE-1). The only signal is the return value + a stderr note,
//     and the note is best-effort: a throwing `onError` sink or redactor is
//     swallowed too, since by then the Graph write has already happened.
//   * REDACTED. The whole entry runs through the structural token strip and then
//     the value-based redactor before it is serialized, so no token/secret/PII
//     value can ever reach disk (C3 / Sec #7). Metadata is structured-only by
//     contract. The structural pass is not redundant with the redactor: the
//     redactor only recognises the values it was TOLD about (plus a defensive
//     `EAA…`/hex scan), so a credential nobody registered — a token echoed back
//     inside a proxy's HTML error page, which `core/errors.ts` embeds verbatim
//     into the `GraphApiError` message this file journals as `error` — is
//     invisible to it. `access_token=…` in a string is recognisable by SHAPE,
//     and shape is what survives an upstream that forgot to register a value.
//   * PARSEABLE. Every line written is valid JSON, and a line that is not is not
//     written at all. An operator tails this file with one `JSON.parse` per line;
//     a single malformed record is a wall, not a gap. That makes serialization a
//     precondition of `'ok'` rather than an afterthought — `'ok'` means the bytes
//     are on disk and readable, never merely that nothing threw. The one line
//     this module cannot vouch for is a record TORN by a crash mid-write; it
//     is never rewritten (append-only), but the next append terminates it so
//     the tear stays one bad line instead of swallowing the good record behind
//     it. Readers should skip a line that does not parse, not stop at it.
//   * 0600. The file is written owner-read/write only on POSIX (an existing file
//     with looser bits is chmod-ed before the append, a new one right after it,
//     so the exact bits hold regardless of umask). A chmod the kernel refuses —
//     an append-only journal, a foreign-owned file — is a stderr note, not a
//     `'failed'`: the record is on disk either way. So is the
//     generation rotation retains, which `rename` would otherwise leave with
//     whatever mode it inherited; on Windows POSIX modes do not apply and the
//     parent-directory ACL governs (see F04's honesty note). The state dir is
//     created 0700.
//   * ROTATED. The file is capped by size with a single retained generation
//     (`journal.ndjson` → `journal.1.ndjson`, ~5 MB default) so it cannot grow
//     without bound (G-RUN-1). Rotation is check-before-append, so the live file
//     may slightly exceed the cap before the next append rotates it — "~5 MB".
//     A rotation that FAILS never costs the entry: it is reported on stderr and
//     the line is appended past the cap, since the record outranks the bound.
//   * SERIALIZED. Concurrent tool calls append concurrently, and rotation is a
//     read-modify-write across three syscalls; the writes therefore run one at a
//     time on an internal FIFO queue. Without it two callers racing a rotation
//     lose an entry outright (the second `rename` hits ENOENT), which defeats the
//     whole point of the file. Separate server PROCESSES share the default
//     journal path too (one per MCP client), so rotation itself also runs under
//     a pid-stamped `<journal>.rotating` lock file and re-measures the live file
//     once it holds it; an append that finds the file rotated away underneath
//     it starts the fresh one instead of failing.
//
// All time is read through the injected `Clock` (no `Date.now()`), so the stamped
// `timestamp` is deterministic under test.

import {
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { errorMessageOf } from '../core/index.js';
import type {
  Clock,
  Journal,
  JournalEntry,
  JournalEntryInput,
  JournalStatus,
  Redactor,
} from '../core/index.js';
import { stripPagingAndTokens } from './result.js';

/** Default rotation threshold in bytes (~5 MB — G-RUN-1). */
export const JOURNAL_MAX_BYTES = 5 * 1024 * 1024;

/** Construction dependencies for {@link createJournal}. */
export interface JournalDeps {
  /** Time seam used to stamp each entry's `timestamp` (no `Date.now()`). */
  readonly clock: Clock;
  /** Value-based redaction choke-point; the whole entry passes through it (C3). */
  readonly redactor: Redactor;
  /** Absolute path of the journal file (`Settings.journalPath`). */
  readonly journalPath: string;
  /** Rotate once the live file reaches this many bytes; default {@link JOURNAL_MAX_BYTES}. */
  readonly maxBytes?: number;
  /**
   * Sink for the (redacted) failure note. Defaults to a `console.error` line on
   * stderr — never stdout, which is the stdio JSON-RPC channel (CC-CFG-1).
   */
  readonly onError?: (message: string) => void;
}

/**
 * The path the current generation rotates to. One generation is retained, so a
 * new rotation overwrites the previous `.1` file. `journal.ndjson` →
 * `journal.1.ndjson`.
 */
export function rotatedJournalPath(journalPath: string): string {
  const parsed = path.parse(journalPath);
  return path.join(parsed.dir, `${parsed.name}.1${parsed.ext}`);
}

/**
 * Serialize one already-redacted record into a single NDJSON line, or refuse.
 *
 * `JSON.stringify` answers `undefined` — not a string — for `undefined`, a
 * function and a symbol, and `${undefined}` is the four letters "undefined".
 * Interpolating the result therefore appends a line no reader can parse while
 * every signal the caller has says the write was recorded: the journal would be
 * claiming, in writing, that it holds a record it does not hold, and the next
 * operator to reconcile an ambiguous write hits a `SyntaxError` instead of the
 * entry they came for.
 *
 * Throwing here routes into `append`'s existing never-throws handler, so the
 * caller gets `'failed'` plus a stderr note — the honest answer. There is
 * deliberately no fallback line built from the raw entry: `redact` is the C3
 * choke-point, and a record that did not come out of it has not been scrubbed,
 * so writing a degraded version of it would trade a visible failure for a
 * possible secret on disk. The structural strip above has already absorbed
 * every failure the DATA can cause; what is left is a broken redactor seam,
 * which is a defect to surface rather than to paper over.
 */
function serializeLine(record: unknown): string {
  const json = JSON.stringify(record);
  if (typeof json !== 'string') {
    throw new TypeError(
      'journal record did not serialize to JSON — the redactor returned a value ' +
        'JSON.stringify drops (undefined, a function, or a symbol)',
    );
  }
  return `${json}\n`;
}

/**
 * Consecutive appends that must find the cross-process rotation lock held
 * before the journal says it looks abandoned (see `acquireRotationLock`).
 */
const ROTATION_LOCK_WEDGED_AFTER = 3;

/** The `code` of a Node system error (`'EEXIST'`, `'ESRCH'`, …), if it carries one. */
function errnoOf(err: unknown): unknown {
  return typeof err === 'object' && err !== null
    ? (err as { code?: unknown }).code
    : undefined;
}

/**
 * Create an append-only {@link Journal} backed by a rotating 0600 file.
 *
 * The returned `append` is safe to call on the hot write path: it awaits the
 * on-disk write (so an "attempted" entry is flushed before the caller re-throws —
 * CC-LIFE-2) yet can never throw or reject; any failure is reported as `'failed'`.
 */
export function createJournal(deps: JournalDeps): Journal {
  const maxBytes = deps.maxBytes ?? JOURNAL_MAX_BYTES;
  const isPosix = process.platform !== 'win32';
  const filePath = deps.journalPath;
  const dir = path.dirname(filePath);
  const lockPath = `${filePath}.rotating`;
  const reportError =
    deps.onError ??
    ((message: string): void => {
      console.error(`[facebook-mcp] journal append failed: ${message}`);
    });

  /**
   * Best-effort, redacted stderr note. Never throws: both collaborators are
   * injected seams, and nothing is reported unredacted as a fallback (C3).
   */
  function reportNote(message: string): void {
    try {
      reportError(deps.redactor.redactString(message));
    } catch {
      // Deliberately empty: there is no sink left to report through.
    }
  }

  /**
   * Size and permission bits of the live file, or `undefined` when there is
   * none yet (ENOENT).
   */
  async function liveStat(): Promise<{ size: number; mode: number } | undefined> {
    let stats;
    try {
      stats = await stat(filePath);
    } catch {
      // No file yet (ENOENT) — nothing to rotate, nothing to terminate.
      return undefined;
    }
    // A journal path that names a DIRECTORY (an operator pointing
    // FB_JOURNAL_PATH at a folder) can never hold a record, and everything
    // after this call would harm it before failing: `enforceMode` chmods it to
    // 0600, stripping the execute bit so nothing inside stays reachable, and
    // rotation would rename the whole folder. Refuse here, before any of that.
    if (stats.isDirectory()) {
      throw new Error(`journal path ${filePath} is a directory, not a file`);
    }
    return { size: stats.size, mode: stats.mode & 0o777 };
  }

  /**
   * Bring the live file to 0600, reporting — never throwing — when it cannot be.
   *
   * By the time this runs after an append the record IS on disk, and `'ok'`
   * means exactly that. An unconditional `chmod` that throws there turned a
   * recorded write into `'failed'`: an append-only (`chflags uappnd` /
   * `chattr +a`) journal — the standard tamper-evidence hardening for an audit
   * log — refuses `chmod` with EPERM, so every write of the deployment was
   * reported unrecorded while sitting in the file. The mode problem is real and
   * is said on stderr; it is not the same fact as a lost record. `chmod` is
   * skipped when the bits are already right, so a correctly-provisioned
   * append-only journal is silent.
   */
  async function enforceMode(currentMode: number | undefined): Promise<void> {
    if (!isPosix || currentMode === 0o600) return;
    try {
      await chmod(filePath, 0o600);
    } catch (err) {
      const shown = currentMode === undefined ? 'unknown' : `0${currentMode.toString(8)}`;
      reportNote(
        `journal file mode is ${shown}, not 0600, and could not be restricted: ` +
          errorMessageOf(err),
      );
    }
  }

  /**
   * True when the live file's last byte is a newline — i.e. its last record was
   * written whole. `size` is the file's size as just observed (> 0).
   *
   * The journal exists for the moment the process died mid-write — and a
   * process that dies mid-write leaves the line it was writing cut off with no
   * newline (SIGKILL, power loss; within one process, ENOSPC part-way through a
   * line does the same and `append` answers `'failed'`). That record is lost
   * either way. But the NEXT append lands right behind the fragment, on the
   * same line, and a reader doing one `JSON.parse` per line loses that record
   * too: a write that really happened, after the crash, while the operator was
   * reconciling, gone into the same wall as the fragment. Checking the last
   * byte before every append — one `open`/`read`/`close` against a budget that
   * already spends mkdir, stat, open/write/close and chmod — keeps the damage
   * to the one line the crash actually tore. Checked per append rather than
   * once per journal instance because the ENOSPC case tears a line in THIS
   * process, after the instance was created.
   */
  async function lastRecordTerminated(size: number): Promise<boolean> {
    let handle;
    try {
      handle = await open(filePath, 'r');
    } catch (err) {
      // Another server sharing this journal rotated the file away since the
      // stat. It is the retained generation now, not lost; this record starts
      // the fresh live file, so there is nothing to terminate. Failing here cost
      // the record of a write that really happened.
      if (errnoOf(err) === 'ENOENT') return true;
      throw err;
    }
    try {
      const { bytesRead, buffer } = await handle.read(Buffer.alloc(1), 0, 1, size - 1);
      // Zero bytes means the file shrank under us since the stat (an operator
      // truncated it); there is nothing to terminate, and a spurious newline
      // would be a blank line no reader wants.
      return bytesRead === 0 || buffer[0] === 0x0a;
    } finally {
      await handle.close();
    }
  }

  /**
   * Take the cross-process rotation lock, or answer `false` when another live
   * server holds it.
   *
   * The FIFO below serializes THIS instance only. Every MCP client spawns its
   * own server and every server defaults to the same per-user journal, so two
   * processes rotating one file is the ordinary deployment. Without a lock, a
   * server that measured the file over the cap and then lost the race to the
   * other server's rotation rotated again on its stale measurement: it renamed
   * the other server's fresh live file over the retained generation, deleting
   * every record the first rotation had just preserved. `wx` makes creation the
   * atomic test-and-set; the file carries the holder's pid so a lock left by a
   * crashed server is recognised (the holder no longer exists) and cleared once.
   */
  async function acquireRotationLock(): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await writeFile(lockPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
        return true;
      } catch (err) {
        if (errnoOf(err) !== 'EEXIST') throw err;
        if (attempt > 0 || !(await rotationLockIsStale())) return false;
        await rm(lockPath, { force: true });
      }
    }
    return false;
  }

  /**
   * A lock is stale only when its holder is provably gone. Unreadable or not yet
   * written (the holder is between `open` and `write`) counts as HELD: skipping
   * one rotation costs a few bytes over the cap, while stealing a live lock
   * reopens exactly the race it exists to close.
   */
  async function rotationLockIsStale(): Promise<boolean> {
    let raw: string;
    try {
      raw = await readFile(lockPath, 'utf8');
    } catch (err) {
      // Released between our `wx` and this read: the retry can take it.
      return errnoOf(err) === 'ENOENT';
    }
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (err) {
      return errnoOf(err) === 'ESRCH';
    }
  }

  /**
   * Rotate under the cross-process lock. Answers `'held'` when another server
   * is rotating right now: this record is appended to whichever file is live —
   * the one being moved or its fresh successor — and is kept either way.
   */
  async function rotate(): Promise<'rotated' | 'skipped' | 'held'> {
    if (!(await acquireRotationLock())) return 'held';
    const rotated = rotatedJournalPath(filePath);
    try {
      // Re-measured UNDER the lock: the size that sent us here may predate
      // another server's rotation, and rotating on it would move that server's
      // fresh file over the generation it just retained.
      const fresh = await liveStat();
      if (fresh === undefined || fresh.size < maxBytes) return 'skipped';
      // Keep exactly one generation: drop the previous rotated file first.
      await rm(rotated, { force: true });
      await rename(filePath, rotated);
    } finally {
      try {
        await rm(lockPath, { force: true });
      } catch (err) {
        reportNote(
          `journal rotation lock ${lockPath} could not be removed; rotation will be ` +
            `skipped until it is deleted: ${errorMessageOf(err)}`,
        );
      }
    }
    if (isPosix) {
      // `rename` carries the live file's mode across, and nothing ever revisits
      // the retained generation afterwards. The live file heals itself on the
      // very next append; this one would keep whatever bits it inherited — from
      // a journal restored out of a backup, copied in by an operator, left by an
      // older build, or one whose single `chmod` failed — for the rest of the
      // deployment's life, while holding exactly the entries the 0600 promise
      // in this module's header covers.
      //
      // A refusal here is NOT a failed rotation: the rename already happened,
      // the live file moved and the next record starts a fresh one. Reported
      // through the rotation-failure path it read "appending past the size cap"
      // — false on both counts — and hid the one true fact, the retained
      // generation's loose bits.
      try {
        await chmod(rotated, 0o600);
      } catch (err) {
        reportNote(
          `retained journal generation ${rotated} could not be restricted to 0600: ` +
            errorMessageOf(err),
        );
      }
    }
    return 'rotated';
  }

  // Writes are serialized on one promise chain. Concurrent tool calls each end in
  // an `append`, and check-then-rotate-then-write is not atomic: two callers can
  // both stat an over-size file, both `rm` the retained generation and both try to
  // `rename` it — the loser fails with ENOENT and DROPS ITS ENTRY, which is the one
  // thing the journal exists to prevent (CC-LIFE-2). Interleaved rotations can also
  // discard the retained generation that G-RUN-1 promises to keep. Ordering is
  // FIFO, so entries land in the order they were submitted.
  //
  // The chain never rejects: each link swallows the outcome so one failed write
  // cannot poison the writes queued behind it.
  let queue: Promise<unknown> = Promise.resolve();
  /** Consecutive appends that found the rotation lock held by someone else. */
  let heldInARow = 0;
  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = queue.then(job, job);
    queue = run.catch(() => undefined);
    return run;
  }

  async function writeLine(line: string): Promise<void> {
    await mkdir(dir, { recursive: true, ...(isPosix ? { mode: 0o700 } : {}) });
    let live = await liveStat();
    if (live !== undefined && live.size >= maxBytes) {
      try {
        const rotation = await rotate();
        heldInARow = rotation === 'held' ? heldInARow + 1 : 0;
        if (heldInARow === ROTATION_LOCK_WEDGED_AFTER) {
          // Contention clears within milliseconds; the lock still held on this
          // many consecutive appends means nobody is releasing it. Said once per
          // episode, with the file to delete.
          reportNote(
            `journal rotation skipped: ${lockPath} is held by another process; ` +
              'delete it if no other facebook-mcp server is running',
          );
        }
      } catch (err) {
        // Rotation is housekeeping; the entry is the payload. A retained
        // generation that cannot be cleared (a directory or a foreign-owned file
        // where `journal.1.ndjson` goes) would otherwise cost THIS record, and —
        // because the live file stays over the cap — every record after it: the
        // journal silently switching off. Exceed the cap instead, say so, and
        // re-read the size: the live file may have changed under us.
        reportNote(
          `journal rotation failed, appending past the size cap: ${errorMessageOf(err)}`,
        );
      }
      // Re-read either way: after our rotation the live file starts over, and
      // another server may already have started (or rotated) it.
      live = await liveStat();
    }
    // An existing file with looser bits is tightened BEFORE the new record lands
    // in it, not after — the record is exactly what the 0600 promise covers.
    if (live !== undefined) await enforceMode(live.mode);
    const size = live?.size;
    const terminator =
      size !== undefined && size > 0 && !(await lastRecordTerminated(size)) ? '\n' : '';
    await appendFile(filePath, `${terminator}${line}`, { mode: 0o600 });
    // A file this append created has umask-reduced bits: guarantee the exact
    // 0600 (a pre-existing one was handled above).
    if (live === undefined) await enforceMode(undefined);
  }

  async function append(entry: JournalEntryInput): Promise<JournalStatus> {
    try {
      const full: JournalEntry = { ...entry, timestamp: deps.clock.now() };
      // Strip structurally FIRST, then redact by value: defense in depth, and in
      // this order because the structural walk is also what makes the record
      // JSON-safe. An entry is assembled from `error` strings and `metadata`
      // objects that came off the wire through `http.ts`'s `data as T` — a cast,
      // never a validation — so a `bigint`, a reference cycle, a five-thousand-
      // level tree or a getter that throws can all reach this line, and every
      // one of them makes `JSON.stringify` throw rather than skip. Before this
      // walk existed, each of them cost the whole record: an irreversible write
      // that really happened went unlogged because the least important field on
      // it was awkward. Now the awkward field degrades to a marker and the fact
      // of the write survives, which is the only trade the journal should ever
      // make.
      const safe = stripPagingAndTokens(full);
      // Redact the ENTIRE entry (not just metadata): defense in depth so a secret
      // that slips into any field is scrubbed before it reaches disk (C3).
      const redacted = deps.redactor.redact(safe);
      const line = serializeLine(redacted);

      await enqueue(() => writeLine(line));
      return 'ok';
    } catch (err) {
      // The REPORTING leg must be as unfailable as the write leg. Both of the
      // collaborators it calls are injected seams: a host-supplied `onError` sink
      // (a logger over an already-closed stream) or a `Redactor` can themselves
      // throw, and an escaping error here would reject `append` -- turning a Graph
      // write that ALREADY SUCCEEDED into a reported failure. The return value is
      // the contractual signal (CC-LIFE-1); the note is best-effort. Nothing is
      // reported unredacted as a fallback, because the redactor is the C3
      // choke-point and a message that could not pass through it must not escape.
      reportNote(errorMessageOf(err));
      return 'failed';
    }
  }

  return { append };
}
