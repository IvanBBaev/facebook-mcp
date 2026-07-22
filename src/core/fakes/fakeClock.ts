// In-memory controllable Clock fake (test-only).
//
// Time never advances on its own — `now()` returns the current virtual time and
// `sleep()` resolves only when a test ticks the clock past the sleep's due time.
// No real timers are used, so tests are deterministic and instant.

import type { Clock } from '../types.js';

/** A {@link Clock} whose time is driven manually by the test. */
export interface FakeClock extends Clock {
  /** Advance virtual time by `ms`, resolving every sleep whose due time is reached. */
  advance(ms: number): void;
  /** Set virtual time absolutely (epoch ms), resolving any now-due sleeps. */
  set(ms: number): void;
  /** Number of sleeps still waiting. */
  pendingSleeps(): number;
}

interface PendingSleep {
  due: number;
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Create a controllable clock starting at `startMs` (default 0).
 *
 * NOTE: even a `sleep(0)` resolves only on the next `advance`/`set` tick — this
 * is deliberate so a test that forgets to tick surfaces as a hang, not a race.
 */
export function createFakeClock(startMs = 0): FakeClock {
  let current = startMs;
  let pending: PendingSleep[] = [];

  const detach = (p: PendingSleep): void => {
    if (p.signal && p.onAbort) {
      p.signal.removeEventListener('abort', p.onAbort);
    }
  };

  const flush = (): void => {
    const due = pending.filter((p) => p.due <= current);
    if (due.length === 0) return;
    pending = pending.filter((p) => p.due > current);
    for (const p of due) {
      detach(p);
      p.resolve();
    }
  };

  return {
    now: () => current,

    sleep: (ms: number, signal?: AbortSignal): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        const entry: PendingSleep = { due: current + ms, resolve, reject };
        if (signal) {
          const onAbort = (): void => {
            pending = pending.filter((p) => p !== entry);
            detach(entry);
            reject(abortError());
          };
          entry.signal = signal;
          entry.onAbort = onAbort;
          signal.addEventListener('abort', onAbort, { once: true });
        }
        pending.push(entry);
      }),

    advance: (ms: number): void => {
      current += ms;
      flush();
    },

    set: (ms: number): void => {
      current = ms;
      flush();
    },

    pendingSleeps: () => pending.length,
  };
}
