// In-memory array-backed Journal fake (test-only).
//
// Stamps each entry's timestamp from an injected Clock (or Date.now when none is
// given) and stores it in an array tests can inspect. `append` never throws;
// `failNext` simulates the disk-full / permission case (CC-LIFE-1) by returning
// 'failed' without storing; `failHistory` makes the read-back report 'unreadable'.

import type {
  Clock,
  Journal,
  JournalEntry,
  JournalEntryInput,
  JournalStatus,
} from '../types.js';

/** A {@link Journal} exposing its stored entries and a failure toggle. */
export interface MemoryJournal extends Journal {
  /** All successfully appended entries, in order. */
  readonly entries: readonly JournalEntry[];
  /** Make the next `append` return `'failed'` without storing (CC-LIFE-1). */
  failNext(status?: JournalStatus): void;
  /** Make every later `history` read report `'unreadable'`. */
  failHistory(): void;
  /** Drop all stored entries. */
  clear(): void;
}

/** Create an array-backed journal; pass a `clock` for deterministic timestamps. */
export function createMemoryJournal(clock?: Clock): MemoryJournal {
  const entries: JournalEntry[] = [];
  let forcedNext: JournalStatus | undefined;
  let historyUnreadable = false;

  return {
    get entries() {
      return entries;
    },
    append: (entry: JournalEntryInput): Promise<JournalStatus> => {
      if (forcedNext !== undefined) {
        const status = forcedNext;
        forcedNext = undefined;
        return Promise.resolve(status);
      }
      const timestamp = clock ? clock.now() : Date.now();
      entries.push({ ...entry, timestamp });
      return Promise.resolve('ok');
    },
    history: (): Promise<readonly JournalEntry[] | 'unreadable'> =>
      Promise.resolve(historyUnreadable ? 'unreadable' : [...entries]),
    failHistory: (): void => {
      historyUnreadable = true;
    },
    failNext: (status: JournalStatus = 'failed'): void => {
      forcedNext = status;
    },
    clear: (): void => {
      entries.length = 0;
    },
  };
}
