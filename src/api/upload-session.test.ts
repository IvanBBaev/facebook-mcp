// Tests for the shared chunked-upload state machine (task X06).
//
// The module is pure apart from two seams (the clock and the progress sink), so
// most tests drive the transitions directly. A small scripted driver at the end
// replays the transfer scenarios the media tests pin (stall exhaustion, rewinds,
// oscillation, overrun, server-named waits) under both stall policies, to show
// the extracted machine reproduces what `media-video.ts` and `media-reels.ts`
// do today. Nothing here touches the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeClock } from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import type { ErrorCategory, FbResponse } from '../core/index.js';

import {
  UPLOAD_MAX_SERVER_WAIT_MS,
  applyChunkAck,
  applyChunkFault,
  createTransferCursor,
  isAbortError,
  isChunkRefused,
  isResumableChunkFault,
  isTransferComplete,
  nextChunkWindow,
  notifyProgressSink,
  readChunkAck,
  readWireOffset,
  rebaseTransferCursor,
  resumeWaitMs,
  serverOffsetOf,
  serverWaitMsOf,
  waitBeforeResume,
} from './upload-session.js';
import type {
  ChunkAck,
  ChunkWindow,
  TransferCursor,
  TransferPolicy,
} from './upload-session.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function res(data: unknown, headers: Record<string, string> = {}): FbResponse<unknown> {
  return { data, headers, status: 200 };
}

function graphErr(
  category: ErrorCategory | undefined,
  httpStatus = 500,
  retryAfterMs?: number,
): GraphApiError {
  return new GraphApiError(`${String(category)} fault`, {
    code: 1,
    httpStatus,
    ...(category !== undefined
      ? {
          action: {
            category,
            retryable: category === 'transient',
            operatorText: 'test',
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          },
        }
      : {}),
  });
}

function abortErr(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

const transientOnly = (err: unknown): boolean =>
  err instanceof GraphApiError && err.action?.category === 'transient';

function videoPolicy(overrides: Partial<TransferPolicy> = {}): TransferPolicy {
  return {
    maxResumes: 4,
    backoffMs: 250,
    maxServerWaitMs: UPLOAD_MAX_SERVER_WAIT_MS,
    stallAccounting: 'resume-budget',
    isResumable: isResumableChunkFault,
    ...overrides,
  };
}

function reelsPolicy(overrides: Partial<TransferPolicy> = {}): TransferPolicy {
  return {
    maxResumes: 5,
    backoffMs: 250,
    maxServerWaitMs: UPLOAD_MAX_SERVER_WAIT_MS,
    stallAccounting: 'high-water',
    isResumable: transientOnly,
    ...overrides,
  };
}

function cursor(total = 12, chunkSize = 4, offset = 0): TransferCursor {
  return createTransferCursor({ total, chunkSize, offset });
}

const ack = (offset?: number, extra: Partial<ChunkAck> = {}): ChunkAck => ({
  ...(offset !== undefined ? { offset } : {}),
  refused: false,
  ...extra,
});

// ---------------------------------------------------------------------------
// Wire readers
// ---------------------------------------------------------------------------

test('readWireOffset accepts non-negative integers as numbers or numeric strings', () => {
  assert.equal(readWireOffset(0), 0);
  assert.equal(readWireOffset(4096), 4096);
  assert.equal(readWireOffset('8'), 8);
  assert.equal(readWireOffset(' 12 '), 12);
  for (const bad of [
    -1,
    1.5,
    Number.NaN,
    Infinity,
    '',
    '  ',
    '-4',
    'abc',
    '1.5',
    null,
    undefined,
    {},
    [],
  ]) {
    assert.equal(
      readWireOffset(bad),
      undefined,
      `rejects ${JSON.stringify(bad) ?? 'undefined'}`,
    );
  }
});

test('serverOffsetOf prefers headers, then the JSON body, and ignores non-records', () => {
  assert.equal(serverOffsetOf(res({ file_offset: 4 }, { file_offset: '8' })), 8);
  assert.equal(serverOffsetOf(res({ file_offset: 4 }, { 'upload-offset': '6' })), 6);
  assert.equal(serverOffsetOf(res({ file_offset: 4 })), 4);
  assert.equal(serverOffsetOf(res({ offset: '5' })), 5);
  assert.equal(serverOffsetOf(res({ start_offset: 7 })), 7);
  assert.equal(serverOffsetOf(res({ file_offset: '0x4' })), undefined);
  assert.equal(serverOffsetOf(res({ file_offset: -1 })), undefined);
  assert.equal(serverOffsetOf(res([{ file_offset: 4 }])), undefined);
  assert.equal(serverOffsetOf(res('file_offset=4')), undefined);
  assert.equal(serverOffsetOf(res(null)), undefined);
  assert.equal(serverOffsetOf(res(undefined)), undefined);
});

test('serverOffsetOf survives a body that cannot be serialized', () => {
  const cyclic: Record<string, unknown> = { file_offset: 4 };
  cyclic['self'] = cyclic;
  assert.equal(serverOffsetOf(res(cyclic)), undefined);
  assert.equal(serverOffsetOf(res({ n: 1n })), undefined);
  assert.equal(serverOffsetOf(res(cyclic, { file_offset: '4' })), 4);
});

test('isChunkRefused: only a present success flag that is not true refuses', () => {
  assert.equal(isChunkRefused(res({ success: true })), false);
  assert.equal(isChunkRefused(res({})), false);
  assert.equal(isChunkRefused(res(null)), false);
  assert.equal(isChunkRefused(res([false])), false);
  for (const flag of [false, 'false', 'true', 0, 1, null, undefined]) {
    assert.equal(isChunkRefused(res({ success: flag })), true, `refuses ${String(flag)}`);
  }
});

test('readChunkAck normalizes offset, declared end and refusal', () => {
  assert.deepEqual(
    readChunkAck(res({ file_offset: 4, end_offset: '8', success: true })),
    {
      offset: 4,
      declaredEnd: 8,
      refused: false,
    },
  );
  assert.deepEqual(readChunkAck(res({ success: false })), { refused: true });
  assert.deepEqual(readChunkAck(res({ end_offset: 'x' })), { refused: false });
  assert.deepEqual(readChunkAck(res('ok', { offset: '3' })), {
    offset: 3,
    refused: false,
  });
});

// ---------------------------------------------------------------------------
// Fault classification
// ---------------------------------------------------------------------------

test('isAbortError matches by name on Error instances only', () => {
  assert.equal(isAbortError(abortErr()), true);
  assert.equal(isAbortError(new Error('x')), false);
  assert.equal(isAbortError({ name: 'AbortError' }), false);
  assert.equal(isAbortError('AbortError'), false);
  const domAbort = new DOMException('aborted', 'AbortError');
  assert.equal(isAbortError(domAbort), domAbort instanceof Error);
});

test('serverWaitMsOf reads a positive finite retryAfterMs off a GraphApiError', () => {
  assert.equal(serverWaitMsOf(graphErr('transient', 503, 2000)), 2000);
  assert.equal(serverWaitMsOf(graphErr('transient', 503, 0)), undefined);
  assert.equal(serverWaitMsOf(graphErr('transient', 503, -5)), undefined);
  assert.equal(serverWaitMsOf(graphErr('transient', 503, Number.NaN)), undefined);
  assert.equal(serverWaitMsOf(graphErr('transient', 503, Infinity)), undefined);
  assert.equal(serverWaitMsOf(graphErr('transient', 503)), undefined);
  assert.equal(serverWaitMsOf(graphErr(undefined, 503)), undefined);
  assert.equal(serverWaitMsOf(new Error('x')), undefined);
});

test('isResumableChunkFault: transient and ambiguous resume, uncategorized falls back to 5xx', () => {
  assert.equal(isResumableChunkFault(graphErr('transient')), true);
  assert.equal(isResumableChunkFault(graphErr('ambiguous', 0)), true);
  for (const category of [
    'validation',
    'not_found',
    'rate_limit',
    'auth',
    'unknown',
  ] as const) {
    assert.equal(isResumableChunkFault(graphErr(category, 503)), false, category);
  }
  assert.equal(isResumableChunkFault(graphErr(undefined, 500)), true);
  assert.equal(isResumableChunkFault(graphErr(undefined, 503)), true);
  assert.equal(isResumableChunkFault(graphErr(undefined, 499)), false);
  assert.equal(isResumableChunkFault(new Error('socket hang up')), false);
  assert.equal(isResumableChunkFault(abortErr()), false);
});

// ---------------------------------------------------------------------------
// Waits and progress
// ---------------------------------------------------------------------------

test('resumeWaitMs is the linear backoff, raised to a longer server wait', () => {
  assert.equal(resumeWaitMs(250, 1), 250);
  assert.equal(resumeWaitMs(250, 3), 750);
  assert.equal(resumeWaitMs(250, 1, 2000), 2000);
  assert.equal(resumeWaitMs(250, 10, 2000), 2500);
  assert.equal(resumeWaitMs(0, 4), 0);
  assert.equal(resumeWaitMs(0, 4, 1500), 1500);
});

test('waitBeforeResume skips a zero wait without touching the clock', async () => {
  const clock = createFakeClock();
  await waitBeforeResume(clock, 0);
  await waitBeforeResume(clock, -1);
  await waitBeforeResume(clock, Number.NaN);
  assert.equal(clock.pendingSleeps(), 0);
});

test('waitBeforeResume sleeps on the injected clock until it is advanced', async () => {
  const clock = createFakeClock();
  let done = false;
  const p = waitBeforeResume(clock, 500).then(() => {
    done = true;
  });
  assert.equal(clock.pendingSleeps(), 1);
  clock.advance(499);
  await Promise.resolve();
  assert.equal(done, false);
  clock.advance(1);
  await p;
  assert.equal(done, true);
});

test('waitBeforeResume rejects with an AbortError when the signal fires', async () => {
  const clock = createFakeClock();
  const controller = new AbortController();
  const p = waitBeforeResume(clock, 500, controller.signal);
  controller.abort();
  await assert.rejects(p, (err: unknown) => isAbortError(err));

  const already = new AbortController();
  already.abort();
  await assert.rejects(waitBeforeResume(clock, 10, already.signal), (err: unknown) =>
    isAbortError(err),
  );
});

test('notifyProgressSink passes the arguments through and reports a clean run', () => {
  const seen: unknown[][] = [];
  const errors: unknown[] = [];
  const ok = notifyProgressSink(
    (done: number, total: number) => {
      seen.push([done, total]);
    },
    [4, 12] as const,
    (err) => errors.push(err),
  );
  assert.equal(ok, true);
  assert.deepEqual(seen, [[4, 12]]);
  assert.deepEqual(errors, []);
});

test('notifyProgressSink without a sink is a no-op', () => {
  let called = false;
  assert.equal(
    notifyProgressSink(undefined, [1] as const, () => {
      called = true;
    }),
    false,
  );
  assert.equal(called, false);
});

test('notifyProgressSink contains a throwing sink and a throwing error handler', () => {
  const boom = new Error('transport closed');
  const errors: unknown[] = [];
  assert.equal(
    notifyProgressSink(
      () => {
        throw boom;
      },
      [] as const,
      (err) => errors.push(err),
    ),
    false,
  );
  assert.deepEqual(errors, [boom]);

  assert.doesNotThrow(() =>
    notifyProgressSink(
      () => {
        throw boom;
      },
      [] as const,
      () => {
        throw new Error('logger broken');
      },
    ),
  );
});

// ---------------------------------------------------------------------------
// Cursor + windows
// ---------------------------------------------------------------------------

test('createTransferCursor seeds offsets and budgets', () => {
  assert.deepEqual(cursor(), {
    total: 12,
    chunkSize: 4,
    offset: 0,
    resumes: 0,
    highWater: 0,
    stalls: 0,
  });
  assert.deepEqual(
    createTransferCursor({
      total: 12,
      chunkSize: 4,
      offset: 8,
      declaredEnd: 10,
      resumes: 2,
    }),
    {
      total: 12,
      chunkSize: 4,
      offset: 8,
      declaredEnd: 10,
      resumes: 2,
      highWater: 8,
      stalls: 0,
    },
  );
});

test('createTransferCursor refuses invalid sizes and offsets', () => {
  const bad = [
    { total: 0, chunkSize: 4 },
    { total: -1, chunkSize: 4 },
    { total: 1.5, chunkSize: 4 },
    { total: Number.NaN, chunkSize: 4 },
    { total: 12, chunkSize: 0 },
    { total: 12, chunkSize: Infinity },
    { total: 12, chunkSize: 4, offset: -1 },
    { total: 12, chunkSize: 4, offset: 13 },
    { total: 12, chunkSize: 4, offset: 0.5 },
    { total: 12, chunkSize: 4, resumes: -1 },
  ];
  for (const init of bad) {
    assert.throws(() => createTransferCursor(init), RangeError, JSON.stringify(init));
  }
  assert.equal(isTransferComplete(cursor(12, 4, 12)), true);
});

test('nextChunkWindow steps by chunkSize and clamps to the file end', () => {
  assert.deepEqual(nextChunkWindow(cursor(10, 4, 0)), { start: 0, end: 4 });
  assert.deepEqual(nextChunkWindow(cursor(10, 4, 8)), { start: 8, end: 10 });
  assert.deepEqual(nextChunkWindow(cursor(10, 64, 0)), { start: 0, end: 10 });
  assert.deepEqual(nextChunkWindow(cursor(10, 4, 10)), { start: 10, end: 10 });
  assert.equal(isTransferComplete(cursor(10, 4, 8)), false);
});

test('nextChunkWindow honours a sane declared end and falls back otherwise', () => {
  const at = (declaredEnd: number): ChunkWindow =>
    nextChunkWindow(
      createTransferCursor({ total: 12, chunkSize: 4, offset: 2, declaredEnd }),
    );
  assert.deepEqual(at(3), { start: 2, end: 3 });
  assert.deepEqual(at(12), { start: 2, end: 12 });
  assert.deepEqual(at(2), { start: 2, end: 6 }, 'empty window falls back');
  assert.deepEqual(at(1), { start: 2, end: 6 }, 'backwards window falls back');
  assert.deepEqual(at(13), { start: 2, end: 6 }, 'past the end falls back');
  assert.deepEqual(at(5.5), { start: 2, end: 6 }, 'fractional end falls back');
});

test('rebaseTransferCursor adopts a sane probe, drops the declared window, keeps budgets', () => {
  const c: TransferCursor = {
    ...createTransferCursor({
      total: 12,
      chunkSize: 4,
      offset: 4,
      declaredEnd: 6,
      resumes: 2,
    }),
  };
  const moved = rebaseTransferCursor(c, 8);
  assert.equal(moved.offset, 8);
  assert.equal(moved.declaredEnd, undefined);
  assert.equal(moved.resumes, 2);
  assert.equal(rebaseTransferCursor(c, 0).offset, 0, 'a probe may rewind');
  assert.equal(rebaseTransferCursor(c, 12).offset, 12);
  for (const probe of [undefined, 13, -1, 2.5, Number.NaN]) {
    const kept = rebaseTransferCursor(c, probe);
    assert.equal(kept.offset, 4, `ignores ${String(probe)}`);
    assert.equal(kept.declaredEnd, undefined);
  }
});

// ---------------------------------------------------------------------------
// applyChunkAck — shared rules
// ---------------------------------------------------------------------------

for (const policy of [videoPolicy(), reelsPolicy()]) {
  const label = policy.stallAccounting;

  test(`[${label}] an ack the server names advances there and adopts its declared end`, () => {
    const out = applyChunkAck(cursor(), ack(4, { declaredEnd: 6 }), policy);
    assert.equal(out.kind, 'continue');
    assert.ok(out.kind === 'continue');
    assert.equal(out.movement, 'advanced');
    assert.equal(out.acked, 4);
    assert.equal(out.previous, 0);
    assert.equal(out.serverReported, true);
    assert.equal(out.waitMs, 0);
    assert.equal(out.cursor.offset, 4);
    assert.equal(out.cursor.highWater, 4);
    assert.deepEqual(nextChunkWindow(out.cursor), { start: 4, end: 6 });
  });

  test(`[${label}] a silent 2xx is taken as "the sent window landed"`, () => {
    const out = applyChunkAck(cursor(10, 4, 8), ack(), policy);
    assert.ok(out.kind === 'continue');
    assert.equal(out.acked, 10);
    assert.equal(out.serverReported, false);
    assert.equal(isTransferComplete(out.cursor), true);
  });

  test(`[${label}] a silent ack honours the declared window it was sent for`, () => {
    const c = createTransferCursor({
      total: 12,
      chunkSize: 4,
      offset: 0,
      declaredEnd: 3,
    });
    const out = applyChunkAck(c, ack(), policy);
    assert.ok(out.kind === 'continue');
    assert.equal(out.acked, 3);
  });

  test(`[${label}] a refusal with no offset stays at the window start`, () => {
    const out = applyChunkAck(
      cursor(12, 4, 4),
      ack(undefined, { refused: true }),
      policy,
    );
    assert.notEqual(out.kind, 'overrun');
    assert.ok(out.kind !== 'overrun');
    assert.equal(out.movement, 'stalled');
    assert.equal(out.acked, 4);
  });

  test(`[${label}] a server offset wins over a refusal`, () => {
    const out = applyChunkAck(cursor(), ack(8, { refused: true }), policy);
    assert.ok(out.kind === 'continue');
    assert.equal(out.movement, 'advanced');
    assert.equal(out.cursor.offset, 8);
  });

  test(`[${label}] an offset past the file end is an overrun, never "done"`, () => {
    const c = cursor();
    const out = applyChunkAck(c, ack(40), policy);
    assert.deepEqual(out, { kind: 'overrun', acked: 40, previous: 0, cursor: c });
  });

  test(`[${label}] an ack to exactly the file end completes without a wait`, () => {
    const out = applyChunkAck(cursor(12, 4, 8), ack(12), policy);
    assert.ok(out.kind === 'continue');
    assert.equal(out.waitMs, 0);
    assert.equal(isTransferComplete(out.cursor), true);
  });

  test(`[${label}] invalid policy knobs are refused so the loop always terminates`, () => {
    for (const bad of [
      { maxResumes: Number.NaN },
      { maxResumes: -1 },
      { maxResumes: 1.5 },
      { backoffMs: -1 },
      { backoffMs: Number.NaN },
      { maxServerWaitMs: Number.NaN },
      { maxServerWaitMs: -1 },
    ]) {
      const p = { ...policy, ...bad };
      assert.throws(
        () => applyChunkAck(cursor(), ack(4), p),
        RangeError,
        JSON.stringify(bad),
      );
      assert.throws(
        () => applyChunkFault(cursor(), graphErr('transient'), p),
        RangeError,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// applyChunkAck — resume-budget (legacy video edge)
// ---------------------------------------------------------------------------

test('[resume-budget] a stall spends one resume, waits the backoff, drops the declared window', () => {
  const c = createTransferCursor({ total: 12, chunkSize: 4, offset: 4, declaredEnd: 6 });
  const out = applyChunkAck(
    c,
    ack(4, { declaredEnd: 10 }),
    videoPolicy({ backoffMs: 100 }),
  );
  assert.ok(out.kind === 'continue');
  assert.equal(out.movement, 'stalled');
  assert.equal(out.cursor.offset, 4);
  assert.equal(out.cursor.resumes, 1);
  assert.equal(out.cursor.declaredEnd, undefined);
  assert.equal(out.waitMs, 100);
  const again = applyChunkAck(out.cursor, ack(4), videoPolicy({ backoffMs: 100 }));
  assert.ok(again.kind === 'continue');
  assert.equal(again.waitMs, 200, 'the backoff scales with the spent budget');
});

test('[resume-budget] a rewind spends one resume, moves back and re-sends at once', () => {
  const out = applyChunkAck(cursor(12, 4, 8), ack(4, { declaredEnd: 6 }), videoPolicy());
  assert.ok(out.kind === 'continue');
  assert.equal(out.movement, 'rewound');
  assert.equal(out.cursor.offset, 4);
  assert.equal(out.cursor.resumes, 1);
  assert.equal(out.waitMs, 0);
  assert.deepEqual(nextChunkWindow(out.cursor), { start: 4, end: 6 });
});

test('[resume-budget] an exhausted budget returns the pre-ack cursor', () => {
  const c = createTransferCursor({ total: 12, chunkSize: 4, offset: 8, resumes: 2 });
  const stalled = applyChunkAck(c, ack(8), videoPolicy({ maxResumes: 2 }));
  assert.equal(stalled.kind, 'exhausted');
  assert.ok(stalled.kind === 'exhausted');
  assert.equal(stalled.movement, 'stalled');
  assert.equal(stalled.cursor, c);
  const rewound = applyChunkAck(c, ack(0), videoPolicy({ maxResumes: 2 }));
  assert.ok(rewound.kind === 'exhausted');
  assert.equal(rewound.movement, 'rewound');
  assert.equal(rewound.cursor.offset, 8);
});

test('[resume-budget] faults and stalls share one budget that never resets on advance', () => {
  const policy = videoPolicy({ maxResumes: 2, backoffMs: 0 });
  const r1 = applyChunkFault(cursor(), graphErr('transient'), policy);
  assert.ok(r1.kind === 'resume');
  const a1 = applyChunkAck(r1.cursor, ack(4), policy);
  assert.ok(a1.kind === 'continue');
  assert.equal(a1.cursor.resumes, 1);
  const s1 = applyChunkAck(a1.cursor, ack(4), policy);
  assert.ok(s1.kind === 'continue');
  assert.equal(s1.cursor.resumes, 2);
  assert.equal(applyChunkAck(s1.cursor, ack(4), policy).kind, 'exhausted');
});

test('[resume-budget] maxResumes 0 fails the first stall', () => {
  assert.equal(
    applyChunkAck(cursor(), ack(0), videoPolicy({ maxResumes: 0 })).kind,
    'exhausted',
  );
});

// ---------------------------------------------------------------------------
// applyChunkAck — high-water (Reels)
// ---------------------------------------------------------------------------

test('[high-water] a stall follows the server, counts a stall and waits stall-scaled backoff', () => {
  const policy = reelsPolicy({ backoffMs: 100, maxResumes: 3 });
  const s1 = applyChunkAck(cursor(12, 4, 4), ack(4), policy);
  assert.ok(s1.kind === 'continue');
  assert.equal(s1.movement, 'stalled');
  assert.equal(s1.cursor.stalls, 1);
  assert.equal(s1.cursor.resumes, 0, 'stalls do not spend the fault budget');
  assert.equal(s1.waitMs, 100);
  const s2 = applyChunkAck(s1.cursor, ack(4), policy);
  assert.ok(s2.kind === 'continue');
  assert.equal(s2.waitMs, 200);
});

test('[high-water] a rewind moves back and waits, like a stall', () => {
  const policy = reelsPolicy({ backoffMs: 100 });
  const out = applyChunkAck(cursor(12, 4, 8), ack(4), policy);
  assert.ok(out.kind === 'continue');
  assert.equal(out.movement, 'rewound');
  assert.equal(out.cursor.offset, 4);
  assert.equal(out.cursor.highWater, 8);
  assert.equal(out.cursor.stalls, 1);
  assert.equal(out.waitMs, 100);
});

test('[high-water] climbing back below the high-water mark is still a stall', () => {
  const policy = reelsPolicy({ backoffMs: 0 });
  const rewound = applyChunkAck(cursor(12, 4, 8), ack(4), policy);
  assert.ok(rewound.kind === 'continue');
  const climbed = applyChunkAck(rewound.cursor, ack(8), policy);
  assert.ok(climbed.kind === 'continue');
  assert.equal(climbed.movement, 'advanced');
  assert.equal(climbed.cursor.stalls, 2);
  const passed = applyChunkAck(climbed.cursor, ack(12), policy);
  assert.ok(passed.kind === 'continue');
  assert.equal(passed.cursor.stalls, 0, 'passing the mark resets the guard');
  assert.equal(passed.cursor.highWater, 12);
});

test('[high-water] more than maxResumes non-advancing acks exhausts with the post-ack cursor', () => {
  const policy = reelsPolicy({ maxResumes: 2, backoffMs: 0 });
  let c = cursor(12, 4, 4);
  for (let i = 1; i <= 2; i += 1) {
    const out = applyChunkAck(c, ack(4), policy);
    assert.ok(out.kind === 'continue', `stall ${String(i)} tolerated`);
    c = out.cursor;
  }
  const out = applyChunkAck(c, ack(0), policy);
  assert.ok(out.kind === 'exhausted');
  assert.equal(out.movement, 'rewound');
  assert.equal(out.cursor.offset, 0);
  assert.equal(out.cursor.stalls, 3);
});

test('[high-water] a non-advancing ack at the file end does not wait', () => {
  const c: TransferCursor = { ...cursor(12, 4, 12), highWater: 12 };
  const out = applyChunkAck(c, ack(12), reelsPolicy());
  assert.ok(out.kind === 'continue');
  assert.equal(out.waitMs, 0);
});

// ---------------------------------------------------------------------------
// applyChunkFault
// ---------------------------------------------------------------------------

test('applyChunkFault: abort wins over everything, even an exhausted budget', () => {
  const c = createTransferCursor({ total: 12, chunkSize: 4, resumes: 9 });
  assert.deepEqual(
    applyChunkFault(c, abortErr(), videoPolicy({ isResumable: () => true })),
    {
      kind: 'abort',
    },
  );
});

test('applyChunkFault: a non-resumable fault is fatal under the injected predicate', () => {
  assert.deepEqual(
    applyChunkFault(cursor(), graphErr('validation', 400), videoPolicy()),
    {
      kind: 'fatal',
    },
  );
  assert.equal(applyChunkFault(cursor(), new Error('x'), videoPolicy()).kind, 'fatal');
  assert.equal(
    applyChunkFault(cursor(), graphErr('ambiguous', 0), videoPolicy()).kind,
    'resume',
  );
  assert.equal(
    applyChunkFault(cursor(), graphErr('ambiguous', 0), reelsPolicy()).kind,
    'fatal',
  );
});

test('applyChunkFault: a server wait over the cap is deferred without spending budget', () => {
  const c = createTransferCursor({ total: 12, chunkSize: 4, resumes: 4 });
  const err = graphErr('transient', 503, UPLOAD_MAX_SERVER_WAIT_MS + 1);
  assert.deepEqual(applyChunkFault(c, err, videoPolicy()), {
    kind: 'deferred',
    waitMs: UPLOAD_MAX_SERVER_WAIT_MS + 1,
  });
  const atCap = applyChunkFault(
    cursor(),
    graphErr('transient', 503, UPLOAD_MAX_SERVER_WAIT_MS),
    videoPolicy(),
  );
  assert.ok(atCap.kind === 'resume');
  assert.equal(atCap.waitMs, UPLOAD_MAX_SERVER_WAIT_MS);
});

test('applyChunkFault: an exhausted budget is reported with the spent count', () => {
  const c = createTransferCursor({ total: 12, chunkSize: 4, resumes: 4 });
  assert.deepEqual(applyChunkFault(c, graphErr('transient'), videoPolicy()), {
    kind: 'exhausted',
    resumes: 4,
  });
  assert.equal(
    applyChunkFault(cursor(), graphErr('transient'), videoPolicy({ maxResumes: 0 })).kind,
    'exhausted',
  );
});

test('applyChunkFault: a resume keeps the acknowledged offset, drops the window, waits', () => {
  const c = createTransferCursor({
    total: 12,
    chunkSize: 4,
    offset: 4,
    declaredEnd: 6,
    resumes: 1,
  });
  const out = applyChunkFault(c, graphErr('transient'), videoPolicy({ backoffMs: 100 }));
  assert.ok(out.kind === 'resume');
  assert.equal(out.attempt, 2);
  assert.equal(out.waitMs, 200);
  assert.equal(out.serverWaitMs, undefined);
  assert.equal(out.cursor.offset, 4);
  assert.equal(out.cursor.resumes, 2);
  assert.deepEqual(nextChunkWindow(out.cursor), { start: 4, end: 8 });

  const withWait = applyChunkFault(
    c,
    graphErr('transient', 503, 2000),
    videoPolicy({ backoffMs: 100 }),
  );
  assert.ok(withWait.kind === 'resume');
  assert.equal(withWait.serverWaitMs, 2000);
  assert.equal(withWait.waitMs, 2000);
});

test('applyChunkFault: a fault resume does not touch the high-water stall guard', () => {
  const c: TransferCursor = { ...cursor(12, 4, 4), highWater: 8, stalls: 2 };
  const out = applyChunkFault(c, graphErr('transient'), reelsPolicy());
  assert.ok(out.kind === 'resume');
  assert.equal(out.cursor.stalls, 2);
  assert.equal(out.cursor.highWater, 8);
});

// ---------------------------------------------------------------------------
// Scripted driver — replays the media transfer scenarios
// ---------------------------------------------------------------------------

type Step = FbResponse<unknown> | Error;

interface DriveResult {
  readonly outcome: string;
  readonly windows: readonly ChunkWindow[];
  readonly waits: readonly number[];
  readonly progress: readonly number[];
  readonly cursor: TransferCursor;
}

/**
 * A minimal transfer loop over the module, in the shape both media modules
 * share: send `nextChunkWindow`, then apply the ack or the fault. `probe` plays
 * the legacy edge's offset re-read before a fault re-drive; `reportEveryAck`
 * plays Reels' progress cadence (the video edge reports only on advance).
 */
async function drive(
  init: { total: number; chunkSize: number },
  policy: TransferPolicy,
  script: readonly Step[],
  opts: { probe?: () => number | undefined; reportEveryAck?: boolean } = {},
): Promise<DriveResult> {
  const windows: ChunkWindow[] = [];
  const waits: number[] = [];
  const progress: number[] = [];
  const clock = {
    sleep: (ms: number): Promise<void> => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
  let c = createTransferCursor(init);
  let i = 0;
  while (!isTransferComplete(c)) {
    const step = script[i];
    i += 1;
    if (step === undefined)
      return { outcome: 'script-ended', windows, waits, progress, cursor: c };
    windows.push(nextChunkWindow(c));
    if (step instanceof Error) {
      const fault = applyChunkFault(c, step, policy);
      if (fault.kind !== 'resume')
        return { outcome: fault.kind, windows, waits, progress, cursor: c };
      await waitBeforeResume(clock, fault.waitMs);
      c = opts.probe ? rebaseTransferCursor(fault.cursor, opts.probe()) : fault.cursor;
      continue;
    }
    const out = applyChunkAck(c, readChunkAck(step), policy);
    if (out.kind === 'overrun')
      return { outcome: 'overrun', windows, waits, progress, cursor: c };
    if (
      opts.reportEveryAck === true ||
      (out.kind === 'continue' && out.movement === 'advanced')
    ) {
      notifyProgressSink(
        (n: number) => progress.push(n),
        [out.acked] as const,
        () => undefined,
      );
    }
    if (out.kind === 'exhausted')
      return { outcome: 'exhausted', windows, waits, progress, cursor: out.cursor };
    await waitBeforeResume(clock, out.waitMs);
    c = out.cursor;
  }
  return { outcome: 'done', windows, waits, progress, cursor: c };
}

const at = (offset: number | string): FbResponse<unknown> => res({ file_offset: offset });
const starts = (r: DriveResult): number[] => r.windows.map((w) => w.start);

test('driver: a clean three-chunk transfer completes with no waits', async () => {
  for (const policy of [videoPolicy(), reelsPolicy()]) {
    const r = await drive({ total: 12, chunkSize: 4 }, policy, [at(4), at(8), at(12)]);
    assert.equal(r.outcome, 'done');
    assert.deepEqual(starts(r), [0, 4, 8]);
    assert.deepEqual(r.waits, []);
    assert.deepEqual(r.progress, [4, 8, 12]);
  }
});

test('driver (video): a server stuck at 0 of 12 exhausts after maxResumes + 1 sends', async () => {
  const r = await drive(
    { total: 12, chunkSize: 4 },
    videoPolicy({ maxResumes: 2, backoffMs: 100 }),
    Array.from({ length: 10 }, () => at(0)),
  );
  assert.equal(r.outcome, 'exhausted');
  assert.equal(r.windows.length, 3);
  assert.deepEqual(r.waits, [100, 200]);
  assert.equal(r.cursor.offset, 0);
  assert.deepEqual(r.progress, []);
});

test('driver (video): a rewind re-sends from the server offset, costing one resume', async () => {
  const r = await drive({ total: 12, chunkSize: 4 }, videoPolicy(), [
    at(4),
    at(8),
    at(4),
    at(8),
    at(12),
  ]);
  assert.equal(r.outcome, 'done');
  assert.deepEqual(starts(r), [0, 4, 8, 4, 8]);
  assert.equal(r.cursor.resumes, 1);
  assert.deepEqual(r.waits, [], 'a rewind re-sends at once');
});

test('driver (video): an offset past the end surfaces as an overrun', async () => {
  const r = await drive({ total: 12, chunkSize: 4 }, videoPolicy(), [at(40)]);
  assert.equal(r.outcome, 'overrun');
});

test('driver (video): a fault re-drive probes the server offset and honours Retry-After', async () => {
  const r = await drive(
    { total: 12, chunkSize: 4 },
    videoPolicy({ backoffMs: 100 }),
    [at(4), graphErr('transient', 503, 2000), at(12)],
    { probe: () => 8 },
  );
  assert.equal(r.outcome, 'done');
  assert.deepEqual(starts(r), [0, 4, 8]);
  assert.deepEqual(r.waits, [2000]);
});

test('driver (video): an over-cap Retry-After surfaces at once', async () => {
  const r = await drive({ total: 12, chunkSize: 4 }, videoPolicy(), [
    graphErr('transient', 503, 60_000),
  ]);
  assert.equal(r.outcome, 'deferred');
  assert.deepEqual(r.waits, []);
  assert.equal(r.cursor.resumes, 0);
});

test('driver (video): the declared end_offset shapes the next window', async () => {
  const r = await drive({ total: 12, chunkSize: 4 }, videoPolicy(), [
    res({ start_offset: '2', end_offset: '7' }),
    at(12),
  ]);
  assert.deepEqual(r.windows, [
    { start: 0, end: 4 },
    { start: 2, end: 7 },
  ]);
});

test('driver (reels): a stall at file_offset "0" with maxResumes 2 stops after 3 sends', async () => {
  const r = await drive(
    { total: 12, chunkSize: 4 },
    reelsPolicy({ maxResumes: 2, backoffMs: 100 }),
    Array.from({ length: 10 }, () => at('0')),
    { reportEveryAck: true },
  );
  assert.equal(r.outcome, 'exhausted');
  assert.equal(r.windows.length, 3);
  assert.deepEqual(r.waits, [100, 200]);
  assert.deepEqual(r.progress, [0, 0, 0], 'Reels reports every ack');
});

test('driver (reels): a server oscillating 0 <-> 4 terminates within the stall budget', async () => {
  const script = Array.from({ length: 50 }, (_, n) => at(n % 2 === 0 ? 4 : 0));
  const r = await drive(
    { total: 12, chunkSize: 4 },
    reelsPolicy({ maxResumes: 5, backoffMs: 0 }),
    script,
  );
  assert.equal(r.outcome, 'exhausted');
  assert.equal(
    r.windows.length,
    7,
    'one advance, then maxResumes + 1 non-advancing acks',
  );
});

test('driver (reels): a fault mid-stream resumes from the last acknowledged offset', async () => {
  const r = await drive({ total: 12, chunkSize: 4 }, reelsPolicy({ backoffMs: 100 }), [
    at(4),
    at(8),
    graphErr('transient', 503),
    at(12),
  ]);
  assert.equal(r.outcome, 'done');
  assert.deepEqual(starts(r), [0, 4, 8, 8]);
  assert.deepEqual(r.waits, [100]);
});

test('driver (reels): an ambiguous chunk fault is not resumed', async () => {
  const r = await drive({ total: 12, chunkSize: 4 }, reelsPolicy(), [
    at(4),
    graphErr('ambiguous', 0),
  ]);
  assert.equal(r.outcome, 'fatal');
  assert.equal(r.cursor.offset, 4);
});

test('driver: an abort mid-transfer stops without spending budget', async () => {
  for (const policy of [videoPolicy(), reelsPolicy()]) {
    const r = await drive({ total: 12, chunkSize: 4 }, policy, [at(4), abortErr()]);
    assert.equal(r.outcome, 'abort');
    assert.equal(r.cursor.offset, 4);
    assert.equal(r.cursor.resumes, 0);
  }
});

test('driver: every policy terminates against an endlessly faulting server', async () => {
  for (const policy of [videoPolicy({ backoffMs: 0 }), reelsPolicy({ backoffMs: 0 })]) {
    const r = await drive(
      { total: 12, chunkSize: 4 },
      policy,
      Array.from({ length: 100 }, () => graphErr('transient', 503)),
    );
    assert.equal(r.outcome, 'exhausted');
    assert.equal(r.windows.length, policy.maxResumes + 1);
  }
});
