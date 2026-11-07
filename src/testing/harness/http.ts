// Shared fixtures, fakes and helpers for the Graph HTTP client (`core/http.ts`) tests,
// split out of `http.test.ts` (R17). The test files import from here.
//

import assert from 'node:assert/strict';

import { type FbRequestDeps } from '../../core/http.js';
import type { HostAllowlist, Logger, LogFields, Settings } from '../../core/index.js';
import {
  createFakeClock,
  createFakeRedactor,
  type FakeClock,
} from '../../core/fakes/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export const TOKEN = 'EAAtestTOKENvalue1234567890abcdef';
export const APP_SECRET = 'appsecret000102030405060708090a0b';
export const HOSTS: HostAllowlist = {
  graph: 'graph.facebook.com',
  graphVideo: 'graph-video.facebook.com',
  rupload: 'rupload.facebook.com',
};

export function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    appId: '1234567890',
    appSecret: APP_SECRET,
    accessToken: TOKEN,
    profiles: {},
    apiVersion: 'v21.0',
    adsApiVersion: 'v26.0',
    hosts: HOSTS,
    requestTimeoutMs: 30_000,
    hostConcurrency: 4,
    writeMode: 'plan',
    maxResultChars: 25_000,
    transport: 'stdio',
    packagesDeny: [],
    packagesReadonly: [],
    journalPath: '/tmp/journal.log',
    logLevel: 'error',
    ...overrides,
  };
}

export interface RecordedLog {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly msg: string;
  readonly fields?: LogFields;
}

export interface TestLogger extends Logger {
  readonly entries: readonly RecordedLog[];
}

export function createTestLogger(): TestLogger {
  const entries: RecordedLog[] = [];
  const record =
    (level: RecordedLog['level']) =>
    (msg: string, fields?: LogFields): void => {
      entries.push({ level, msg, fields });
    };
  return {
    entries,
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
}

/**
 * Make the NEXT response's body reject when read, the way a stream truncated by
 * a mid-flight reset does. Same wrapping discipline as {@link captureResponses}.
 */
export function breakNextBodyRead(message: string): void {
  const inner = globalThis.fetch;
  let pending = true;
  globalThis.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const response = await inner(...args);
    if (pending) {
      pending = false;
      Object.defineProperty(response, 'text', {
        value: (): Promise<string> => Promise.reject(new Error(message)),
      });
    }
    return response;
  };
}

/** A {@link FakeClock} that also records every duration the client asked to sleep. */
export function createRecordingClock(startMs = 0): {
  readonly clock: FakeClock;
  readonly sleeps: readonly number[];
} {
  const base = createFakeClock(startMs);
  const sleeps: number[] = [];
  const sleep: FakeClock['sleep'] = (ms, signal) => {
    sleeps.push(ms);
    return base.sleep(ms, signal);
  };
  return { clock: { ...base, sleep }, sleeps };
}

/**
 * Default clock of {@link makeDeps}: `sleep` fails at once. Retry tests pass their
 * own clock and {@link settle} it; anywhere else a backoff (a mis-retried write,
 * QA-04 / mutation probe M01) is a bug that must fail here, not hang the runner.
 */
export function createNoBackoffClock(): FakeClock {
  const sleep = (ms: number): Promise<void> =>
    Promise.reject(new assert.AssertionError({ message: `unexpected ${ms} ms backoff` }));
  return { ...createFakeClock(), sleep };
}

export function makeDeps(overrides: Partial<FbRequestDeps> = {}): FbRequestDeps {
  return {
    settings: makeSettings(),
    clock: createNoBackoffClock(),
    redactor: createFakeRedactor(),
    logger: createTestLogger(),
    ...overrides,
  };
}

/**
 * Drive a fake-clock-backed request to completion: repeatedly flush the
 * microtask/immediate queue and, whenever the client is parked in `clock.sleep`,
 * advance the virtual clock past any backoff (60s ≥ the cap) so the retry
 * proceeds instantly. Bounded so a stuck request fails as a finite loop, not a
 * hang.
 */
export async function settle<T>(clock: FakeClock, promise: Promise<T>): Promise<T> {
  let done = false;
  const tracked = promise.then(
    (v) => {
      done = true;
      return v;
    },
    (e: unknown) => {
      done = true;
      throw e;
    },
  );
  // Keep the polling loop from tripping an unhandled-rejection warning.
  tracked.catch(() => undefined);
  for (let i = 0; i < 10_000 && !done; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (!done && clock.pendingSleeps() > 0) {
      clock.advance(60_000);
    }
  }
  return tracked;
}

/** `estimated_time_to_regain_access` is MINUTES — Graph's documented unit (CC-NET-3). */
export function throttleBody(code: number, etaMinutes?: number): unknown {
  return {
    error: {
      message: 'rate limited',
      type: 'OAuthException',
      code,
      ...(etaMinutes !== undefined
        ? { error_data: { estimated_time_to_regain_access: etaMinutes } }
        : {}),
    },
  };
}
