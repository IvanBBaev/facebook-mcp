// In-memory ActivityCursorStore fake (test-only).
//
// Keeps per-Page marks in a Map tests can inspect. `failNextGet` / `failNextSet`
// simulate the unreadable-file and disk-full cases; neither method ever throws.

import type { ActivityCursorStore, ActivityMarks } from '../types.js';

/** An {@link ActivityCursorStore} exposing its marks and failure toggles. */
export interface MemoryActivityState extends ActivityCursorStore {
  /** Stored marks by Page id. */
  readonly marks: ReadonlyMap<string, ActivityMarks>;
  /** Every `set` call, in order (including failed ones). */
  readonly sets: readonly { pageId: string; marks: ActivityMarks }[];
  /** Make the next `get` answer `'unreadable'`. */
  failNextGet(): void;
  /** Make the next `set` answer `'failed'` without storing. */
  failNextSet(): void;
}

/** Create an in-memory store, optionally seeded with marks. */
export function createMemoryActivityState(
  seed: Readonly<Record<string, ActivityMarks>> = {},
): MemoryActivityState {
  const marks = new Map<string, ActivityMarks>(Object.entries(seed));
  const sets: { pageId: string; marks: ActivityMarks }[] = [];
  let getFails = false;
  let setFails = false;
  return {
    marks,
    sets,
    get: (pageId) => {
      if (getFails) {
        getFails = false;
        return Promise.resolve('unreadable');
      }
      return Promise.resolve(marks.get(pageId));
    },
    set: (pageId, next) => {
      sets.push({ pageId, marks: next });
      if (setFails) {
        setFails = false;
        return Promise.resolve('failed');
      }
      marks.set(pageId, { ...marks.get(pageId), ...next });
      return Promise.resolve('ok');
    },
    failNextGet: () => {
      getFails = true;
    },
    failNextSet: () => {
      setFails = true;
    },
  };
}
