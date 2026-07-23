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
//     and proceeds (CC-LIFE-1). The only signal is the return value + a stderr note.
//   * REDACTED. The whole entry is passed through the value-based redactor before
//     it is serialized, so no token/secret/PII value can ever reach disk (C3 /
//     Sec #7). Metadata is structured-only by contract.
//   * 0600. The file is written owner-read/write only on POSIX (chmod after each
//     append guarantees the exact bits regardless of umask); on Windows POSIX
//     modes do not apply and the parent-directory ACL governs (see F04's honesty
//     note). The state dir is created 0700.
//   * ROTATED. The file is capped by size with a single retained generation
//     (`journal.ndjson` → `journal.1.ndjson`, ~5 MB default) so it cannot grow
//     without bound (G-RUN-1). Rotation is check-before-append, so the live file
//     may slightly exceed the cap before the next append rotates it — "~5 MB".
//
// All time is read through the injected `Clock` (no `Date.now()`), so the stamped
// `timestamp` is deterministic under test.

import { appendFile, chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  Clock,
  Journal,
  JournalEntry,
  JournalEntryInput,
  JournalStatus,
  Redactor,
} from '../core/index.js';

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
  const reportError =
    deps.onError ??
    ((message: string): void => {
      console.error(`[facebook-mcp] journal append failed: ${message}`);
    });

  async function maybeRotate(): Promise<void> {
    let size: number;
    try {
      size = (await stat(filePath)).size;
    } catch {
      // No file yet (ENOENT) — nothing to rotate.
      return;
    }
    if (size < maxBytes) return;
    const rotated = rotatedJournalPath(filePath);
    // Keep exactly one generation: drop the previous rotated file first.
    await rm(rotated, { force: true });
    await rename(filePath, rotated);
  }

  async function append(entry: JournalEntryInput): Promise<JournalStatus> {
    try {
      const full: JournalEntry = { ...entry, timestamp: deps.clock.now() };
      // Redact the ENTIRE entry (not just metadata): defense in depth so a secret
      // that slips into any field is scrubbed before it reaches disk (C3).
      const redacted = deps.redactor.redact(full);
      const line = `${JSON.stringify(redacted)}\n`;

      await mkdir(dir, { recursive: true, ...(isPosix ? { mode: 0o700 } : {}) });
      await maybeRotate();
      await appendFile(filePath, line, { mode: 0o600 });
      if (isPosix) {
        // Guarantee the exact 0600 bits regardless of umask / prior file mode.
        await chmod(filePath, 0o600);
      }
      return 'ok';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reportError(deps.redactor.redactString(message));
      return 'failed';
    }
  }

  return { append };
}
