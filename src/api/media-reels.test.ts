// Tests for the Reels three-phase publish flow (task V06).
//
// Every Graph call goes through the injected `FbRequestFn` fake — nothing here
// touches the network, and the network fence in `src/testing` would fail the run
// if it did. The fake clock makes the scheduling-window assertions exact instead
// of wall-clock-dependent.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFakeClock,
  createFakeFbRequest,
  fbErr,
  fbOk,
} from '../core/fakes/index.js';
import type { FakeClock, FakeFbRequest } from '../core/fakes/index.js';
import {
  DEFAULT_THROTTLE_RETRY_AFTER_MS,
  GraphApiError,
  toGraphApiError,
} from '../core/index.js';
import type {
  ErrorAction,
  FbRequest,
  FbRequestFn,
  FbResponse,
  JsonRequest,
  LogFields,
  Logger,
  ParamValue,
  ProgressUpdate,
  RuploadRequest,
  Settings,
} from '../core/index.js';

import {
  REEL_CHUNK_BYTES,
  REEL_QUOTA_DEFAULT_RESET_MS,
  REEL_QUOTA_PER_24H,
  REEL_SCHEDULE_MAX_LEAD_MS,
  REEL_SCHEDULE_MIN_LEAD_MS,
  REEL_VIDEO_STATES,
  classifyReelFailure,
  finishReelUpload,
  isReelPublishError,
  isReelQuotaError,
  planReelPublish,
  publishReel,
  reelLifecycleNotes,
  ruploadPathForReel,
  startReelUpload,
  uploadReelBinary,
  validateReelSchedule,
  wrapReelError,
  ReelPublishError,
  type ReelsDeps,
  type ReelUploadSession,
} from './media-reels.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PAGE_ID = 'P1';
const VIDEO_ID = 'v-1';
const TOKEN = 'page-token';
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const WIRE: Pick<Settings, 'apiVersion' | 'hosts'> = {
  apiVersion: 'v25.0',
  hosts: {
    graph: 'graph.facebook.com',
    graphVideo: 'graph-video.facebook.com',
    rupload: 'rupload.facebook.com',
  },
};

const UPLOAD_PATH = `/video-upload/${WIRE.apiVersion}/${VIDEO_ID}`;
const UPLOAD_URL = `https://${WIRE.hosts.rupload}${UPLOAD_PATH}`;

/**
 * A Graph id as it reaches this module when the wire sent a JSON NUMBER.
 * `JSON.parse` has already rounded it to the nearest double, so the low digits
 * are gone before any code here gets a look at it. Written through `Number(...)`
 * rather than as a literal so the rounding is the test's subject rather than a
 * lint error about a lossy literal.
 */
const ROUNDED_WIRE_ID = Number('12345678901234567890');

interface RecordedLog {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly msg: string;
  readonly fields?: LogFields;
}

interface TestLogger extends Logger {
  readonly entries: readonly RecordedLog[];
}

function createTestLogger(): TestLogger {
  const entries: RecordedLog[] = [];
  const record =
    (level: RecordedLog['level']) =>
    (msg: string, fields?: LogFields): void => {
      entries.push({ level, msg, ...(fields !== undefined ? { fields } : {}) });
    };
  return {
    entries,
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
}

interface Harness {
  readonly fb: FakeFbRequest;
  readonly logger: TestLogger;
  readonly clock: FakeClock;
  readonly progress: ProgressUpdate[];
  readonly deps: ReelsDeps;
}

function harness(opts?: {
  readonly nowMs?: number;
  readonly chunkBytes?: number;
  readonly maxResumeAttempts?: number;
  readonly resumeBackoffMs?: number;
}): Harness {
  const fb = createFakeFbRequest();
  const logger = createTestLogger();
  const clock = createFakeClock(opts?.nowMs ?? NOW);
  const progress: ProgressUpdate[] = [];
  const deps: ReelsDeps = {
    fbRequest: fb.fn,
    logger,
    clock,
    settings: WIRE,
    onProgress: (update) => progress.push(update),
    ...(opts?.chunkBytes !== undefined ? { chunkBytes: opts.chunkBytes } : {}),
    ...(opts?.maxResumeAttempts !== undefined
      ? { maxResumeAttempts: opts.maxResumeAttempts }
      : {}),
    // The fake clock resolves a sleep only when a test ticks it, so resume tests
    // run with the local backoff off; pacing gets its own dedicated tests.
    resumeBackoffMs: opts?.resumeBackoffMs ?? 0,
  };
  return { fb, logger, clock, progress, deps };
}

const SESSION: ReelUploadSession = {
  videoId: VIDEO_ID,
  uploadPath: UPLOAD_PATH,
  uploadHost: WIRE.hosts.rupload,
  startedAtMs: NOW,
};

function bytes(n: number): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => i % 251);
}

function jsonOf(req: FbRequest | undefined): JsonRequest {
  if (req === undefined) assert.fail('expected a request, got none');
  if (req.protocol !== 'json')
    assert.fail(`expected a json request, got ${req.protocol}`);
  return req;
}

function ruploadOf(req: FbRequest | undefined): RuploadRequest {
  if (req === undefined) assert.fail('expected a request, got none');
  if (req.protocol !== 'rupload') {
    assert.fail(`expected a rupload request, got ${req.protocol}`);
  }
  return req;
}

function paramOf(req: FbRequest, key: string): ParamValue {
  return req.protocol === 'json' ? req.params?.[key] : undefined;
}

function isStartCall(req: FbRequest): boolean {
  return req.protocol === 'json' && paramOf(req, 'upload_phase') === 'start';
}

function isFinishCall(req: FbRequest): boolean {
  return req.protocol === 'json' && paramOf(req, 'upload_phase') === 'finish';
}

function isTransferCall(req: FbRequest): boolean {
  return req.protocol === 'rupload';
}

function graphError(
  message: string,
  init: Partial<ErrorAction> & { code?: number } = {},
) {
  const { code = 1, ...actionInit } = init;
  const action: ErrorAction = {
    category: actionInit.category ?? 'unknown',
    retryable: actionInit.retryable ?? false,
    operatorText: actionInit.operatorText ?? message,
    ...(actionInit.nextTool !== undefined ? { nextTool: actionInit.nextTool } : {}),
    ...(actionInit.retryAfterMs !== undefined
      ? { retryAfterMs: actionInit.retryAfterMs }
      : {}),
  };
  return new GraphApiError(message, { code, httpStatus: 400, action });
}

function transientError(message = 'HTTP 503 on rupload chunk POST'): GraphApiError {
  return graphError(message, { code: 0, category: 'transient', retryable: true });
}

/** The rolling-cap error shape: a BUC throttle whose message names the Reels cap. */
function quotaError(): GraphApiError {
  return graphError(
    '(#80004) Application request limit reached: you have reached the maximum number of Reels you can publish in 24 hours',
    {
      code: 80004,
      category: 'rate_limit',
      retryable: true,
      retryAfterMs: 15 * MINUTE,
      nextTool: 'facebook_usage',
    },
  );
}

async function expectReelError(fn: () => Promise<unknown>): Promise<ReelPublishError> {
  try {
    await fn();
  } catch (err) {
    if (!isReelPublishError(err)) {
      assert.fail(`expected a ReelPublishError, got ${String(err)}`);
    }
    return err;
  }
  assert.fail('expected the call to reject, but it resolved');
}

function expectReelErrorSync(fn: () => unknown): ReelPublishError {
  try {
    fn();
  } catch (err) {
    if (!isReelPublishError(err)) {
      assert.fail(`expected a ReelPublishError, got ${String(err)}`);
    }
    return err;
  }
  assert.fail('expected the call to throw, but it returned');
}

function programHappyPath(
  fb: FakeFbRequest,
  transferHeaders?: Record<string, string>,
): void {
  fb.on(isStartCall, fbOk({ video_id: VIDEO_ID, upload_url: UPLOAD_URL }));
  fb.on(isTransferCall, fbOk({ success: true }, transferHeaders));
  fb.on(isFinishCall, fbOk({ success: true, post_id: '111_222' }));
}

// ---------------------------------------------------------------------------
// Phase 1 — start
// ---------------------------------------------------------------------------

test('startReelUpload reserves a video id and derives the rupload path from upload_url', async () => {
  const { fb, deps } = harness();
  fb.on(isStartCall, fbOk({ video_id: VIDEO_ID, upload_url: UPLOAD_URL }));

  const session = await startReelUpload(deps, { pageId: PAGE_ID, token: TOKEN });

  assert.equal(session.videoId, VIDEO_ID);
  assert.equal(session.uploadPath, UPLOAD_PATH);
  assert.equal(session.uploadHost, WIRE.hosts.rupload);
  assert.equal(session.startedAtMs, NOW);

  const req = jsonOf(fb.lastRequest());
  assert.equal(req.method, 'POST');
  assert.equal(req.host, 'graph');
  assert.equal(req.path, `/${PAGE_ID}/video_reels`);
  assert.equal(paramOf(req, 'upload_phase'), 'start');
  assert.equal(req.token, TOKEN);
  assert.equal(req.pageId, PAGE_ID);
});

test('startReelUpload keeps the documented rupload layout when upload_url is absent', async () => {
  const { fb, deps } = harness();
  fb.on(isStartCall, fbOk({ video_id: VIDEO_ID }));

  const session = await startReelUpload(deps, { pageId: PAGE_ID });

  assert.equal(session.uploadPath, UPLOAD_PATH);
});

test('startReelUpload refuses a numeric video_id instead of reserving a rounded one', async () => {
  const { fb, deps } = harness();
  // `fbRequest` CASTS the body (CC-NET-2), so a numeric id is a fact about the
  // wire. Rounding it into a string would name a video that is not ours: the
  // whole file would be uploaded, and the finish phase would then commit against
  // somebody else's node. Failing the start phase costs nothing but this call.
  fb.on(isStartCall, fbOk({ video_id: ROUNDED_WIRE_ID, upload_url: UPLOAD_URL }));

  const err = await expectReelError(() => startReelUpload(deps, { pageId: PAGE_ID }));

  assert.equal(err.reel.phase, 'start');
  assert.match(err.message, /no video_id/);
});

test('ruploadPathForReel refuses an upload target off the allowlisted rupload host', () => {
  const err = expectReelErrorSync(() =>
    ruploadPathForReel(
      'https://evil.example.com/video-upload/v25.0/v-1',
      VIDEO_ID,
      WIRE.apiVersion,
      WIRE.hosts.rupload,
    ),
  );

  assert.equal(err.reel.kind, 'constraint');
  assert.equal(err.reel.phase, 'start');
  assert.match(err.message, /evil\.example\.com/);
  assert.match(err.message, /not the allowlisted rupload host/);
});

test('ruploadPathForReel falls back when upload_url is unparseable or path-less', () => {
  assert.equal(
    ruploadPathForReel('not a url', VIDEO_ID, WIRE.apiVersion, WIRE.hosts.rupload),
    UPLOAD_PATH,
  );
  assert.equal(
    ruploadPathForReel(
      `https://${WIRE.hosts.rupload}/`,
      VIDEO_ID,
      WIRE.apiVersion,
      WIRE.hosts.rupload,
    ),
    UPLOAD_PATH,
  );
});

test('startReelUpload fails loudly when the start response carries no video_id', async () => {
  const { fb, deps } = harness();
  fb.on(isStartCall, fbOk({ unexpected: true }));

  const err = await expectReelError(() => startReelUpload(deps, { pageId: PAGE_ID }));

  assert.equal(err.reel.phase, 'start');
  assert.match(err.message, /no video_id/);
});

test('startReelUpload names the start phase when Graph rejects the request', async () => {
  const { fb, deps } = harness();
  fb.on(
    isStartCall,
    fbErr(
      graphError('(#200) Permissions error', {
        code: 200,
        category: 'permission',
        retryable: false,
      }),
    ),
  );

  const err = await expectReelError(() => startReelUpload(deps, { pageId: PAGE_ID }));

  assert.equal(err.reel.phase, 'start');
  assert.equal(err.code, 200);
  assert.match(err.message, /Reels start phase failed/);
});

// ---------------------------------------------------------------------------
// The full three-phase flow
// ---------------------------------------------------------------------------

test('publishReel drives start, transfer and finish in order', async () => {
  const { fb, deps } = harness();
  programHappyPath(fb, { file_offset: '10' });

  const result = await publishReel(deps, {
    pageId: PAGE_ID,
    data: bytes(10),
    videoState: 'PUBLISHED',
    description: 'a reel',
    token: TOKEN,
  });

  assert.equal(fb.calls.length, 3, 'exactly one call per phase');

  const start = jsonOf(fb.calls[0]);
  assert.equal(paramOf(start, 'upload_phase'), 'start');

  const transfer = ruploadOf(fb.calls[1]);
  assert.equal(transfer.host, 'rupload');
  assert.equal(transfer.method, 'POST');
  assert.equal(transfer.path, UPLOAD_PATH);
  assert.equal(transfer.fileOffset, 0);
  assert.equal(transfer.chunk.byteLength, 10);
  assert.equal(transfer.headers?.['file_size'], '10');
  assert.equal(transfer.token, TOKEN);

  const finish = jsonOf(fb.calls[2]);
  assert.equal(paramOf(finish, 'upload_phase'), 'finish');
  assert.equal(paramOf(finish, 'video_id'), VIDEO_ID);
  assert.equal(paramOf(finish, 'video_state'), 'PUBLISHED');
  assert.equal(paramOf(finish, 'description'), 'a reel');
  assert.equal(paramOf(finish, 'scheduled_publish_time'), undefined);

  assert.equal(result.session.videoId, VIDEO_ID);
  assert.equal(result.transfer.byteLength, 10);
  assert.equal(result.transfer.chunks, 1);
  assert.equal(result.transfer.resumes, 0);
  assert.equal(result.transfer.finalOffset, 10);
  assert.equal(result.transfer.serverReportedOffset, true);
  assert.equal(result.finish.success, true);
  assert.equal(result.finish.postId, '111_222');
  assert.equal(result.finish.readEdge, `/${PAGE_ID}/video_reels`);
  assert.equal(result.elapsedMs, 0);
});

test('publishReel sends a single chunk for a payload below the default chunk size', async () => {
  const { fb, deps } = harness();
  programHappyPath(fb);
  assert.ok(
    REEL_CHUNK_BYTES > 1024,
    'default chunk size must exceed the fixture payload',
  );

  const result = await publishReel(deps, {
    pageId: PAGE_ID,
    data: bytes(1024),
    videoState: 'DRAFT',
  });

  assert.equal(result.transfer.chunks, 1);
  assert.equal(result.transfer.serverReportedOffset, false);
});

// ---------------------------------------------------------------------------
// video_state handling
// ---------------------------------------------------------------------------

test('REEL_VIDEO_STATES is exactly the three finish states', () => {
  assert.deepEqual([...REEL_VIDEO_STATES], ['PUBLISHED', 'DRAFT', 'SCHEDULED']);
});

test('finishReelUpload publishes immediately for video_state PUBLISHED', async () => {
  const { fb, deps } = harness();
  fb.on(isFinishCall, fbOk({ success: true, post_id: '111_222' }));

  const result = await finishReelUpload(deps, {
    pageId: PAGE_ID,
    videoId: VIDEO_ID,
    videoState: 'PUBLISHED',
    description: 'live now',
  });

  assert.equal(paramOf(jsonOf(fb.lastRequest()), 'video_state'), 'PUBLISHED');
  assert.equal(result.videoState, 'PUBLISHED');
  assert.equal(result.schedule, undefined);
  assert.equal(result.success, true);
  assert.match(result.processingNote, /acceptance, not visibility/);
  assert.ok(result.quotaNote.includes(String(REEL_QUOTA_PER_24H)));
  assert.ok(result.lifecycle.some((note) => note.id === 'reel-published'));
});

test('finishReelUpload acknowledges the publish without handing back a rounded post_id', async () => {
  const { fb, deps } = harness();
  // Graph answered with an id, so the publish was ACCEPTED — but the digits did
  // not survive the wire, so there is no handle to offer. The two facts are
  // separate: reporting `ambiguous` here would send the operator to verify a
  // Reel Graph has already confirmed, over an optional field they do not need
  // (a Reel is addressed by its video id).
  fb.on(isFinishCall, fbOk({ post_id: ROUNDED_WIRE_ID }));

  const result = await finishReelUpload(deps, {
    pageId: PAGE_ID,
    videoId: VIDEO_ID,
    videoState: 'PUBLISHED',
  });

  assert.equal(result.success, true, 'an id in the answer is acceptance');
  assert.equal(result.postId, undefined, 'a rounded id is never offered as a handle');
  assert.equal(result.videoId, VIDEO_ID);
});

test('finishReelUpload saves a draft for video_state DRAFT', async () => {
  const { fb, deps } = harness();
  fb.on(isFinishCall, fbOk({ success: true }));

  const result = await finishReelUpload(deps, {
    pageId: PAGE_ID,
    videoId: VIDEO_ID,
    videoState: 'DRAFT',
  });

  const req = jsonOf(fb.lastRequest());
  assert.equal(paramOf(req, 'video_state'), 'DRAFT');
  assert.equal(paramOf(req, 'description'), undefined);
  assert.equal(result.videoState, 'DRAFT');
  assert.equal(result.postId, undefined);
  assert.equal(result.schedule, undefined);

  const draftReadback = result.lifecycle.find(
    (note) => note.id === 'reel-draft-readback',
  );
  assert.ok(draftReadback, 'the DRAFT read-back question must be surfaced');
  assert.equal(draftReadback.verification, 'assumed');
});

test('finishReelUpload schedules and echoes the UTC instant plus the Page-timezone caveat', async () => {
  const { fb, deps } = harness();
  fb.on(isFinishCall, fbOk({ success: true }));
  const when = Math.floor((NOW + 2 * DAY) / 1000);

  const result = await finishReelUpload(deps, {
    pageId: PAGE_ID,
    videoId: VIDEO_ID,
    videoState: 'SCHEDULED',
    scheduledPublishTime: when,
    pageTimezone: 'Europe/Sofia',
  });

  const req = jsonOf(fb.lastRequest());
  assert.equal(paramOf(req, 'video_state'), 'SCHEDULED');
  assert.equal(paramOf(req, 'scheduled_publish_time'), when);

  const schedule = result.schedule;
  assert.ok(schedule, 'a SCHEDULED result must echo the schedule');
  assert.equal(schedule.epochSeconds, when);
  assert.equal(schedule.utc, new Date(when * 1000).toISOString());
  assert.equal(schedule.leadMs, 2 * DAY);
  assert.equal(schedule.pageTimezone, 'Europe/Sofia');
  assert.match(schedule.timezoneCaveat, /UTC Unix timestamp/);
  assert.match(schedule.timezoneCaveat, /Europe\/Sofia/);
  assert.match(schedule.windowNote, /10 minutes/);
  assert.match(schedule.windowNote, /29 days/);
});

test('a SCHEDULED echo without a Page timezone says so instead of inventing one', () => {
  const echo = validateReelSchedule('SCHEDULED', Math.floor((NOW + DAY) / 1000), NOW);
  assert.ok(echo);
  assert.equal(echo.pageTimezone, undefined);
  assert.match(echo.timezoneCaveat, /timezone was not supplied/);
});

// ---------------------------------------------------------------------------
// Scheduling validation
// ---------------------------------------------------------------------------

test('finishReelUpload rejects a SCHEDULED time in the past without calling Graph', async () => {
  const { fb, deps } = harness();

  const err = await expectReelError(() =>
    finishReelUpload(deps, {
      pageId: PAGE_ID,
      videoId: VIDEO_ID,
      videoState: 'SCHEDULED',
      scheduledPublishTime: Math.floor((NOW - DAY) / 1000),
    }),
  );

  assert.equal(fb.calls.length, 0, 'nothing may reach Graph once validation fails');
  assert.equal(err.reel.kind, 'schedule');
  assert.equal(err.reel.category, 'validation');
  assert.equal(err.reel.retryable, false);
  assert.match(err.message, /is in the past/);
  assert.match(err.message, /29 days/);
});

test('validateReelSchedule rejects a time inside the 10-minute minimum lead', () => {
  const err = expectReelErrorSync(() =>
    validateReelSchedule(
      'SCHEDULED',
      Math.floor((NOW + REEL_SCHEDULE_MIN_LEAD_MS - MINUTE) / 1000),
      NOW,
    ),
  );

  assert.equal(err.reel.kind, 'schedule');
  assert.match(err.message, /minutes ahead/);
});

test('validateReelSchedule accepts a time just outside the minimum lead', () => {
  const echo = validateReelSchedule(
    'SCHEDULED',
    Math.floor((NOW + REEL_SCHEDULE_MIN_LEAD_MS + MINUTE) / 1000),
    NOW,
  );
  assert.ok(echo);
  assert.equal(echo.leadMs, REEL_SCHEDULE_MIN_LEAD_MS + MINUTE);
});

test('validateReelSchedule rejects a time beyond the 29-day window', () => {
  const err = expectReelErrorSync(() =>
    validateReelSchedule(
      'SCHEDULED',
      Math.floor((NOW + REEL_SCHEDULE_MAX_LEAD_MS + DAY) / 1000),
      NOW,
    ),
  );

  assert.equal(err.reel.kind, 'schedule');
  assert.match(err.message, /days ahead/);
  assert.match(err.message, /beyond the Reels window/);
});

test('validateReelSchedule requires a time for video_state SCHEDULED', () => {
  const err = expectReelErrorSync(() =>
    validateReelSchedule('SCHEDULED', undefined, NOW),
  );
  assert.equal(err.reel.kind, 'schedule');
  assert.match(err.message, /requires scheduled_publish_time/);
});

test('validateReelSchedule refuses a scheduled time on a non-SCHEDULED state', () => {
  for (const state of ['PUBLISHED', 'DRAFT'] as const) {
    const err = expectReelErrorSync(() =>
      validateReelSchedule(state, Math.floor((NOW + DAY) / 1000), NOW),
    );
    assert.equal(err.reel.kind, 'schedule');
    assert.match(err.message, /only meaningful with video_state=SCHEDULED/);
  }
});

test('validateReelSchedule rejects a millisecond timestamp instead of guessing seconds', () => {
  const err = expectReelErrorSync(() =>
    validateReelSchedule('SCHEDULED', NOW + DAY, NOW),
  );
  assert.equal(err.reel.kind, 'schedule');
  assert.match(err.message, /Unix SECONDS/);
});

test('validateReelSchedule returns undefined for the unscheduled states', () => {
  assert.equal(validateReelSchedule('PUBLISHED', undefined, NOW), undefined);
  assert.equal(validateReelSchedule('DRAFT', undefined, NOW), undefined);
});

test('publishReel validates the schedule before any Graph call', async () => {
  const { fb, deps } = harness();
  programHappyPath(fb);

  const err = await expectReelError(() =>
    publishReel(deps, {
      pageId: PAGE_ID,
      data: bytes(10),
      videoState: 'SCHEDULED',
      scheduledPublishTime: Math.floor((NOW - MINUTE) / 1000),
    }),
  );

  assert.equal(err.reel.kind, 'schedule');
  assert.equal(fb.calls.length, 0, 'no video id reserved and no bytes uploaded');
});

test('publishReel refuses an empty payload before reserving a video id', async () => {
  const { fb, deps } = harness();
  programHappyPath(fb);

  const err = await expectReelError(() =>
    publishReel(deps, {
      pageId: PAGE_ID,
      data: new Uint8Array(0),
      videoState: 'PUBLISHED',
    }),
  );

  assert.equal(err.reel.kind, 'constraint');
  assert.equal(
    fb.calls.length,
    0,
    'the start phase must not run for an unusable payload',
  );
});

// ---------------------------------------------------------------------------
// Phase 2 — transfer, offsets and resume
// ---------------------------------------------------------------------------

test('uploadReelBinary chunks the payload and stamps every chunk with its offset', async () => {
  const { fb, deps } = harness({ chunkBytes: 4 });
  fb.on(isTransferCall, fbOk({ success: true }));

  const result = await uploadReelBinary(deps, { session: SESSION, data: bytes(10) });

  assert.equal(result.chunks, 3);
  assert.equal(result.resumes, 0);
  assert.equal(result.finalOffset, 10);
  assert.equal(result.serverReportedOffset, false);

  const offsets = fb.calls.map((call) => ruploadOf(call).fileOffset);
  assert.deepEqual(offsets, [0, 4, 8]);

  const lengths = fb.calls.map((call) => ruploadOf(call).chunk.byteLength);
  assert.deepEqual(lengths, [4, 4, 2]);

  // Lengths and offsets alone do not say the right BYTES went out: a slice taken
  // from the wrong end would keep both. Reassemble what the wire actually carried
  // and require it to equal the source, byte for byte.
  const source = bytes(10);
  const sent = Uint8Array.from(
    fb.calls.flatMap((call) => Array.from(ruploadOf(call).chunk)),
  );
  assert.deepEqual(sent, source, 'the concatenated chunks must reproduce the payload');

  for (const call of fb.calls) {
    assert.equal(ruploadOf(call).headers?.['file_size'], '10');
  }
});

test('uploadReelBinary forwards an explicit chunk content type', async () => {
  const { fb, deps } = harness();
  fb.on(isTransferCall, fbOk({ success: true }));

  await uploadReelBinary(deps, {
    session: SESSION,
    data: bytes(8),
    contentType: 'video/mp4',
  });

  assert.equal(ruploadOf(fb.lastRequest()).headers?.['content-type'], 'video/mp4');
});

test('uploadReelBinary follows the server-reported offset instead of its own arithmetic', async () => {
  const { fb, deps } = harness({ chunkBytes: 4 });
  // The server durably took only 3 of the first 4 bytes.
  fb.enqueue(fbOk({}, { file_offset: '3' }));
  fb.enqueue(fbOk({}, { file_offset: '7' }));
  fb.enqueue(fbOk({}, { file_offset: '10' }));

  const result = await uploadReelBinary(deps, { session: SESSION, data: bytes(10) });

  const offsets = fb.calls.map((call) => ruploadOf(call).fileOffset);
  assert.deepEqual(offsets, [0, 3, 7], 'the second chunk resumes at the server offset');
  assert.deepEqual(
    fb.calls.map((call) => ruploadOf(call).chunk.byteLength),
    [4, 4, 3],
  );
  assert.equal(result.serverReportedOffset, true);
  assert.equal(result.finalOffset, 10);
  assert.equal(result.resumes, 0, 'following an offset is not a resume');
});

test('uploadReelBinary reads the offset from the response body when no header carries it', async () => {
  const { fb, deps } = harness({ chunkBytes: 6 });
  fb.enqueue(fbOk({ file_offset: 6 }));
  fb.enqueue(fbOk({ start_offset: 10 }));

  const result = await uploadReelBinary(deps, { session: SESSION, data: bytes(10) });

  assert.deepEqual(
    fb.calls.map((call) => ruploadOf(call).fileOffset),
    [0, 6],
  );
  assert.equal(result.serverReportedOffset, true);
});

test('uploadReelBinary resumes from the last server-reported offset after a transient failure', async () => {
  const { fb, logger, deps } = harness({ chunkBytes: 4 });
  fb.enqueue(fbOk({}, { file_offset: '4' }));
  fb.enqueue(fbErr(transientError()));
  fb.enqueue(fbOk({}, { file_offset: '8' }));
  fb.enqueue(fbOk({}, { file_offset: '10' }));

  const result = await uploadReelBinary(deps, { session: SESSION, data: bytes(10) });

  const offsets = fb.calls.map((call) => ruploadOf(call).fileOffset);
  assert.deepEqual(offsets, [0, 4, 4, 8], 'the retry re-sends from offset 4, not from 0');
  assert.equal(result.resumes, 1);
  assert.equal(result.chunks, 3, 'the failed POST is not counted as a delivered chunk');
  assert.equal(result.finalOffset, 10);

  const resumeLog = logger.entries.find((entry) => entry.msg === 'reels.transfer.resume');
  assert.ok(resumeLog, 'a resume must be logged, not hidden');
  assert.equal(resumeLog.level, 'warn');
  assert.equal(resumeLog.fields?.['resumeFrom'], 4);
});

test('uploadReelBinary re-sends the same chunk when the server has reported no offset yet', async () => {
  const { fb, deps } = harness({ chunkBytes: 4 });
  fb.enqueue(fbErr(transientError()));
  fb.enqueue(fbOk({}));
  fb.enqueue(fbOk({}));
  fb.enqueue(fbOk({}));

  const result = await uploadReelBinary(deps, { session: SESSION, data: bytes(10) });

  assert.deepEqual(
    fb.calls.map((call) => ruploadOf(call).fileOffset),
    [0, 0, 4, 8],
  );
  assert.equal(result.resumes, 1);
  assert.equal(result.serverReportedOffset, false);
});

test('uploadReelBinary honours a server offset that rewinds, and logs it', async () => {
  const { fb, logger, deps } = harness({ chunkBytes: 4 });
  fb.enqueue(fbOk({}, { file_offset: '4' }));
  fb.enqueue(fbOk({}, { file_offset: '2' }));
  fb.enqueue(fbOk({}, { file_offset: '10' }));

  const result = await uploadReelBinary(deps, { session: SESSION, data: bytes(10) });

  assert.deepEqual(
    fb.calls.map((call) => ruploadOf(call).fileOffset),
    [0, 4, 2],
  );
  assert.equal(result.finalOffset, 10);
  const rewind = logger.entries.find((entry) => entry.msg === 'reels.transfer.rewind');
  assert.ok(rewind, 'a server rewind must be visible in the log');
  assert.equal(rewind.fields?.['to'], 2);
});

test('uploadReelBinary stops resuming once the resume budget is spent', async () => {
  const { fb, deps } = harness({ chunkBytes: 4, maxResumeAttempts: 1 });
  fb.enqueue(fbErr(transientError()));
  fb.enqueue(fbErr(transientError('HTTP 503 again')));

  const err = await expectReelError(() =>
    uploadReelBinary(deps, { session: SESSION, data: bytes(10) }),
  );

  assert.equal(fb.calls.length, 2);
  assert.equal(err.reel.kind, 'transient');
  assert.equal(err.reel.phase, 'transfer');
  assert.equal(err.reel.retryable, true);
  assert.match(err.message, /Reels transfer phase failed/);
});

test('uploadReelBinary refuses an empty payload before touching the wire', async () => {
  const { fb, deps } = harness();

  const err = await expectReelError(() =>
    uploadReelBinary(deps, { session: SESSION, data: new Uint8Array(0) }),
  );

  assert.equal(fb.calls.length, 0);
  assert.equal(err.reel.kind, 'constraint');
  assert.match(err.message, /empty \(0 bytes\)/);
});

test('uploadReelBinary terminates when the server offset oscillates instead of advancing', async () => {
  const { deps } = harness({ chunkBytes: 4, maxResumeAttempts: 2 });
  // Every chunk "succeeds", but the server alternates between acknowledging
  // chunk 1 and rewinding to 0: the offset advances on every other POST, so a
  // guard that resets on any advance never trips. The recorded fake answers
  // per-request, which the canned fake cannot express; it is capped so a
  // regression fails the test instead of hanging the suite.
  const offsets: number[] = [];
  const fbRequest = ((req: FbRequest) => {
    const rupload = ruploadOf(req);
    offsets.push(rupload.fileOffset);
    if (offsets.length > 50) return Promise.reject(new Error('runaway transfer loop'));
    const res: FbResponse<unknown> = {
      data: {},
      headers: { file_offset: rupload.fileOffset === 0 ? '4' : '0' },
      status: 200,
    };
    return Promise.resolve(res);
  }) as FbRequestFn;

  const err = await expectReelError(() =>
    uploadReelBinary({ ...deps, fbRequest }, { session: SESSION, data: bytes(10) }),
  );

  assert.equal(err.reel.kind, 'session', `got: ${err.message}`);
  assert.match(err.message, /stopped advancing/);
  assert.ok(
    offsets.length <= 10,
    `the loop must stop within the stall budget; made ${String(offsets.length)} calls`,
  );
});

test('uploadReelBinary fails loudly when the server offset stops advancing', async () => {
  const { fb, deps } = harness({ chunkBytes: 4, maxResumeAttempts: 2 });
  fb.on(isTransferCall, fbOk({}, { file_offset: '0' }));

  const err = await expectReelError(() =>
    uploadReelBinary(deps, { session: SESSION, data: bytes(10) }),
  );

  assert.equal(fb.calls.length, 3, 'the loop terminates instead of hammering the edge');
  assert.equal(err.reel.kind, 'session');
  assert.match(err.message, /stopped advancing/);
  assert.match(err.message, /restart from the start phase/);
});

test('uploadReelBinary never counts a chunk answered with success:false as uploaded', async () => {
  // A 2xx whose body refuses the chunk is not an acknowledgement. Advancing by
  // our own arithmetic would return finalOffset === byteLength and let
  // publishReel go on to finish a Reel whose bytes the host declined.
  const { fb, deps } = harness({ chunkBytes: 4, maxResumeAttempts: 2 });
  fb.on(isTransferCall, fbOk({ success: false }));

  const err = await expectReelError(() =>
    uploadReelBinary(deps, { session: SESSION, data: bytes(10) }),
  );

  assert.equal(err.reel.kind, 'session');
  assert.deepEqual(
    fb.calls.map((call) => ruploadOf(call).fileOffset),
    [0, 0, 0],
    'the refused chunk is re-sent from its own start, never skipped',
  );
});

test('publishReel does not finish a Reel whose chunks were refused with success:false', async () => {
  const { fb, deps } = harness({ chunkBytes: 4, maxResumeAttempts: 1 });
  fb.on(isStartCall, fbOk({ video_id: VIDEO_ID, upload_url: UPLOAD_URL }));
  fb.on(isTransferCall, fbOk({ success: false }));
  fb.on(isFinishCall, fbOk({ success: true }));

  await expectReelError(() =>
    publishReel(deps, { pageId: PAGE_ID, data: bytes(10), videoState: 'PUBLISHED' }),
  );

  assert.equal(
    fb.calls.filter(isFinishCall).length,
    0,
    'the finish (publish) call must never run after a refused transfer',
  );
});

test('uploadReelBinary treats a desynced session as terminal, not as a resume', async () => {
  const { fb, deps } = harness({ chunkBytes: 4 });
  fb.enqueue(
    fbErr(
      graphError(
        'upload session desynced — restart the upload (do not re-create silently): server offset 99 outside chunk window [0, 4)',
        { code: 0, category: 'validation', retryable: false },
      ),
    ),
  );

  const err = await expectReelError(() =>
    uploadReelBinary(deps, { session: SESSION, data: bytes(10) }),
  );

  assert.equal(fb.calls.length, 1, 'a desync is never retried');
  assert.equal(err.reel.kind, 'session');
  assert.equal(err.reel.phase, 'transfer');
  assert.match(err.reel.operatorText, /one server lifetime/);
});

test('uploadReelBinary reports byte progress against the total', async () => {
  const { fb, progress, deps } = harness({ chunkBytes: 4 });
  fb.on(isTransferCall, fbOk({}));

  await uploadReelBinary(deps, { session: SESSION, data: bytes(10) });

  assert.deepEqual(
    progress.map((update) => update.progress),
    [4, 8, 10],
  );
  for (const update of progress) {
    assert.equal(update.total, 10);
  }
});

test('a throwing progress sink never abandons a Reel whose bytes already landed', async () => {
  // The tools layer bridges onProgress onto an MCP progress notification, and that
  // notification can fail on a closing transport (CC-MCP-1). Reporting is ADVISORY:
  // a failed notification must not strand a reserved video_id with every byte
  // uploaded and no finish call. `media-video.ts` states exactly this contract for
  // the legacy resumable edge; the Reels edge owes the operator the same.
  const { fb, logger, clock } = harness();
  programHappyPath(fb);
  let sinkCalls = 0;
  const deps: ReelsDeps = {
    fbRequest: fb.fn,
    logger,
    clock,
    settings: WIRE,
    chunkBytes: 4,
    onProgress: () => {
      sinkCalls += 1;
      throw new Error('progress notification failed');
    },
  };

  const result = await publishReel(deps, {
    pageId: PAGE_ID,
    data: bytes(10),
    videoState: 'PUBLISHED',
  });

  // start, three chunks, finish — the sink is offered every one of them.
  assert.equal(sinkCalls, 5);
  assert.equal(result.finish.success, true);
  assert.equal(result.finish.postId, '111_222');
  assert.equal(result.transfer.finalOffset, 10);
  assert.equal(fb.calls.filter(isFinishCall).length, 1, 'the finish POST still ran');
  assert.equal(
    logger.entries.filter((e) => e.msg === 'reels.progress.failed').length,
    5,
    'every contained throw is logged, never silently dropped',
  );
});

test('a sink that throws on the finish update never leaves an uploaded Reel uncommitted', async () => {
  // The worst shape of the same fault. By the finish phase every byte is on
  // Meta's side and the reserved video_id is waiting for its commit; the finish
  // POST is the only call that names that session, so a throw in front of it
  // strands the upload with no way for the operator to find or complete it.
  const { fb, logger, clock } = harness();
  fb.on(isFinishCall, fbOk({ success: true, post_id: '111_222' }));
  const deps: ReelsDeps = {
    fbRequest: fb.fn,
    logger,
    clock,
    settings: WIRE,
    onProgress: () => {
      throw new Error('progress notification failed');
    },
  };

  const result = await finishReelUpload(deps, {
    pageId: PAGE_ID,
    videoId: VIDEO_ID,
    videoState: 'PUBLISHED',
  });

  assert.equal(result.success, true);
  assert.equal(fb.calls.filter(isFinishCall).length, 1, 'the commit still reached Graph');
});

test('publishReel names the stranded session when the upload outruns the schedule lead', async () => {
  // publishReel promises the schedule "costs no Graph write and no uploaded
  // bytes", and validates it against the clock at the START call. finishReelUpload
  // re-validates against a FRESH clock. A schedule that was legal when the operator
  // submitted it can therefore fail after a video_id is reserved and every byte is
  // on Meta's side — a local rejection raised past the point where it was free. The
  // throw itself is right (Graph would reject the short lead too), but the operator
  // must be told what actually happened and what is left behind.
  const { fb, logger, clock } = harness();
  programHappyPath(fb);
  const slowUpload: FbRequestFn = async <T = unknown>(
    req: FbRequest,
  ): Promise<FbResponse<T>> => {
    const res = await fb.fn<T>(req);
    if (req.protocol === 'rupload') clock.advance(5 * MINUTE);
    return res;
  };
  const deps: ReelsDeps = { fbRequest: slowUpload, logger, clock, settings: WIRE };
  // 12 minutes ahead at the start call: comfortably inside the 10-minute window
  // publishReel checks. Five minutes of upload later it no longer is.
  const scheduledPublishTime = Math.floor((NOW + 12 * MINUTE) / 1000);

  const err = await expectReelError(() =>
    publishReel(deps, {
      pageId: PAGE_ID,
      data: bytes(10),
      videoState: 'SCHEDULED',
      scheduledPublishTime,
    }),
  );

  assert.equal(err.reel.kind, 'schedule');
  assert.equal(err.reel.phase, 'finish');
  assert.equal(fb.calls.filter(isFinishCall).length, 0, 'no bad schedule reached Graph');
  assert.match(
    err.reel.operatorText,
    new RegExp(VIDEO_ID),
    'the reserved video id the operator now owns must be named',
  );
  assert.match(
    err.reel.operatorText,
    /upload/i,
    'the cause is the upload outrunning the lead, not a bad submission',
  );
});

test('uploadReelBinary rewinds only to the last ACKNOWLEDGED offset, not to a stale server one', async () => {
  const { fb, logger, deps } = harness({ chunkBytes: 4 });
  // Mixed stream: the server reports an offset for chunk 1 and then goes silent.
  fb.enqueue(fbOk({}, { file_offset: '4' }));
  fb.enqueue(fbOk({}));
  fb.enqueue(fbErr(transientError()));
  fb.enqueue(fbOk({}));

  const result = await uploadReelBinary(deps, { session: SESSION, data: bytes(12) });

  assert.deepEqual(
    fb.calls.map((call) => ruploadOf(call).fileOffset),
    [0, 4, 8, 8],
    'the retry resumes at 8 — rewinding to the stale server offset 4 would re-send a delivered chunk',
  );
  assert.equal(result.resumes, 1);
  assert.equal(result.finalOffset, 12);

  const resumeLog = logger.entries.find((entry) => entry.msg === 'reels.transfer.resume');
  assert.equal(resumeLog?.fields?.['resumeFrom'], 8);
});

test('uploadReelBinary refuses a server offset past the end of the file', async () => {
  const { fb, deps } = harness({ chunkBytes: 4 });
  fb.on(isTransferCall, fbOk({}, { file_offset: '99' }));

  const err = await expectReelError(() =>
    uploadReelBinary(deps, { session: SESSION, data: bytes(10) }),
  );

  assert.equal(fb.calls.length, 1, 'the loop stops at the impossible offset');
  assert.equal(err.reel.kind, 'session');
  assert.equal(err.reel.phase, 'transfer');
  assert.match(err.message, /past the end of the file/);
  assert.match(err.message, /restart from the start phase/);
});

test('uploadReelBinary rejects a non-integer chunk size instead of reporting an empty upload as done', async () => {
  const { fb, deps } = harness({ chunkBytes: Number.NaN });

  const err = await expectReelError(() =>
    uploadReelBinary(deps, { session: SESSION, data: bytes(10) }),
  );

  assert.equal(fb.calls.length, 0, 'nothing may reach the wire');
  assert.equal(err.reel.kind, 'constraint');
  assert.match(err.message, /chunkBytes/);
});

test('uploadReelBinary rejects a non-integer resume budget rather than resuming forever', async () => {
  const { fb, deps } = harness({ maxResumeAttempts: Number.NaN });

  const err = await expectReelError(() =>
    uploadReelBinary(deps, { session: SESSION, data: bytes(10) }),
  );

  assert.equal(fb.calls.length, 0);
  assert.equal(err.reel.kind, 'constraint');
  assert.match(err.message, /maxResumeAttempts/);
});

test('uploadReelBinary accepts a zero resume budget as "never resume"', async () => {
  const { fb, deps } = harness({ chunkBytes: 4, maxResumeAttempts: 0 });
  fb.enqueue(fbErr(transientError()));

  const err = await expectReelError(() =>
    uploadReelBinary(deps, { session: SESSION, data: bytes(10) }),
  );

  assert.equal(fb.calls.length, 1);
  assert.equal(err.reel.kind, 'transient');
});

/** Let queued promise continuations run until the loop parks on the clock (or ends). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** A transient chunk fault whose transport attached a server-named wait (`Retry-After`). */
function waitError(retryAfterMs: number): GraphApiError {
  return graphError('HTTP 503 on rupload chunk POST', {
    code: 0,
    category: 'transient',
    retryable: true,
    retryAfterMs,
  });
}

test('uploadReelBinary waits out a server-named Retry-After before re-driving a chunk', async () => {
  const { fb, clock, deps } = harness({ chunkBytes: 4 });
  fb.enqueue(fbErr(waitError(5_000)));
  fb.on(isTransferCall, fbOk({}));

  let done = false;
  const run = uploadReelBinary(deps, { session: SESSION, data: bytes(4) }).finally(() => {
    done = true;
  });
  await settle();
  assert.equal(fb.calls.length, 1, 'no re-drive before the server-named wait elapses');
  assert.equal(done, false);
  clock.advance(4_999);
  await settle();
  assert.equal(fb.calls.length, 1, 'still inside the Retry-After window');
  clock.advance(1);
  const result = await run;
  assert.equal(fb.calls.length, 2);
  assert.equal(result.resumes, 1);
});

test('uploadReelBinary backs off between re-drives when the server names no wait', async () => {
  const { fb, clock, deps } = harness({ chunkBytes: 4, resumeBackoffMs: 100 });
  fb.enqueue(fbErr(transientError()));
  fb.enqueue(fbErr(transientError('HTTP 503 again')));
  fb.on(isTransferCall, fbOk({}));

  const run = uploadReelBinary(deps, { session: SESSION, data: bytes(4) });
  await settle();
  assert.equal(fb.calls.length, 1, 'the first re-drive waits the base backoff');
  clock.advance(100);
  await settle();
  assert.equal(fb.calls.length, 2);
  clock.advance(199);
  await settle();
  assert.equal(fb.calls.length, 2, 'the second re-drive waits twice as long');
  clock.advance(1);
  const result = await run;
  assert.equal(fb.calls.length, 3);
  assert.equal(result.resumes, 2);
});

test('uploadReelBinary backs off before re-sending after a POST that did not advance the offset', async () => {
  const { fb, clock, deps } = harness({ chunkBytes: 4, resumeBackoffMs: 100 });
  fb.enqueue(fbOk({}, { file_offset: '0' }));
  fb.on(isTransferCall, fbOk({}, { file_offset: '4' }));

  const run = uploadReelBinary(deps, { session: SESSION, data: bytes(4) });
  await settle();
  assert.equal(fb.calls.length, 1, 'a stalled offset is not re-sent back-to-back');
  clock.advance(100);
  const result = await run;
  assert.equal(fb.calls.length, 2);
  assert.equal(result.finalOffset, 4);
});

test('uploadReelBinary surfaces a server-named wait beyond the in-call cap at once, with the wait', async () => {
  const { fb, clock, deps } = harness({ chunkBytes: 4, resumeBackoffMs: 100 });
  fb.enqueue(fbErr(waitError(120_000)));
  fb.on(isTransferCall, fbOk({}));

  const run = expectReelError(() =>
    uploadReelBinary(deps, { session: SESSION, data: bytes(4) }),
  );
  await settle();
  // Tick past every local backoff so an unguarded re-drive would show up.
  clock.advance(1_000);
  const err = await run;

  assert.equal(fb.calls.length, 1, 'no re-drive into the announced maintenance window');
  assert.equal(
    clock.pendingSleeps(),
    0,
    'a two-minute wait is not slept through in-call',
  );
  assert.equal(err.reel.kind, 'transient');
  assert.equal(err.reel.phase, 'transfer');
  assert.equal(err.reel.retryable, true);
  assert.equal(err.reel.retryAfterMs, 120_000, 'the caller is told how long to wait');
  assert.equal(err.action?.retryAfterMs, 120_000);
});

// ---------------------------------------------------------------------------
// Phase 3 — finish errors
// ---------------------------------------------------------------------------

test('a finish-phase rejection is mapped to a constraint verdict that names the phase', async () => {
  const { fb, deps } = harness();
  fb.on(
    isFinishCall,
    fbErr(
      graphError('(#100) The video duration is not supported for reels', {
        code: 100,
        category: 'validation',
        retryable: false,
      }),
    ),
  );

  const err = await expectReelError(() =>
    finishReelUpload(deps, {
      pageId: PAGE_ID,
      videoId: VIDEO_ID,
      videoState: 'PUBLISHED',
    }),
  );

  assert.equal(err.reel.kind, 'constraint');
  assert.equal(err.reel.phase, 'finish');
  assert.equal(err.reel.category, 'validation');
  assert.equal(err.reel.retryable, false);
  assert.equal(err.code, 100);
  assert.match(err.message, /Reels finish phase failed/);
  assert.match(err.reel.operatorText, /9:16/);
  assert.match(err.reel.operatorText, /bytes transferred but the finish phase rejected/);
  assert.match(err.reel.operatorText, /does not decode the file locally/);
});

test('a start-phase constraint text points at permissions rather than the media spec', () => {
  const failure = classifyReelFailure(
    graphError('(#100) Invalid parameter', { code: 100, category: 'validation' }),
    'start',
  );

  assert.equal(failure.kind, 'constraint');
  assert.match(failure.operatorText, /before any bytes moved/);
});

test('an ambiguous finish is never retried and points at the Reels read edge', async () => {
  const { fb, deps } = harness();
  fb.on(
    isFinishCall,
    fbErr(
      graphError('network fault: socket hang up', {
        code: 0,
        category: 'ambiguous',
        retryable: false,
      }),
    ),
  );

  const err = await expectReelError(() =>
    finishReelUpload(deps, {
      pageId: PAGE_ID,
      videoId: VIDEO_ID,
      videoState: 'PUBLISHED',
    }),
  );

  assert.equal(err.reel.kind, 'ambiguous');
  assert.equal(err.reel.retryable, false);
  assert.match(err.reel.operatorText, /video_reels/);
  assert.match(err.reel.operatorText, /NEVER retried/);
  assert.match(err.reel.operatorText, /published_posts/);
});

test('a finish response reporting success:false is raised, never returned as a result', async () => {
  const { fb, deps } = harness();
  fb.on(isFinishCall, fbOk({ success: false }));

  const err = await expectReelError(() =>
    finishReelUpload(deps, {
      pageId: PAGE_ID,
      videoId: VIDEO_ID,
      videoState: 'PUBLISHED',
    }),
  );

  assert.equal(err.reel.kind, 'ambiguous');
  assert.equal(err.reel.category, 'ambiguous');
  assert.equal(err.reel.retryable, false);
  assert.match(err.reel.operatorText, /video_reels/);
});

test('a finish response whose payload confirms nothing is ambiguous, not a silent success', async () => {
  const { fb, deps } = harness();
  fb.on(isFinishCall, fbOk({ unexpected: 'shape' }));

  const err = await expectReelError(() =>
    finishReelUpload(deps, {
      pageId: PAGE_ID,
      videoId: VIDEO_ID,
      videoState: 'DRAFT',
    }),
  );

  assert.equal(err.reel.kind, 'ambiguous');
  assert.equal(err.reel.phase, 'finish');
  assert.match(err.reel.operatorText, /NEVER retried/);
});

test('an explicit success:false is not upgraded to acceptance by a sibling post_id', async () => {
  const { fb, deps } = harness();
  // Graph said "no" in so many words; an id next to it is a reference, not a
  // contradiction of the verdict. Only an explicit `true`, or an id with NO
  // success field at all, may confirm the publish.
  fb.on(isFinishCall, fbOk({ success: false, post_id: '111_222' }));

  const err = await expectReelError(() =>
    finishReelUpload(deps, {
      pageId: PAGE_ID,
      videoId: VIDEO_ID,
      videoState: 'PUBLISHED',
    }),
  );

  assert.equal(err.reel.kind, 'ambiguous');
  assert.equal(err.reel.phase, 'finish');
  assert.equal(err.reel.retryable, false);
  assert.match(err.reel.operatorText, /video_reels/);
});

test('a caller abort during the finish POST is ambiguous, never a clean failure', async () => {
  const { fb, deps } = harness();
  // The transport rethrows the caller's own AbortError untouched, so it reaches
  // the api layer as a plain non-Graph throw. The finish POST is the write that
  // publishes: once it is on the wire, an abort means "response lost", which
  // is the C2 ambiguous verdict — the same verdict a 5xx or a timeout on this
  // POST already gets — not "nothing landed, re-run freely".
  const abort = new Error('This operation was aborted');
  abort.name = 'AbortError';
  fb.on(isFinishCall, fbErr(abort));

  const err = await expectReelError(() =>
    finishReelUpload(deps, {
      pageId: PAGE_ID,
      videoId: VIDEO_ID,
      videoState: 'PUBLISHED',
    }),
  );

  assert.equal(err.reel.kind, 'ambiguous');
  assert.equal(err.reel.phase, 'finish');
  assert.equal(err.reel.category, 'ambiguous');
  assert.equal(err.reel.retryable, false);
  assert.match(err.reel.operatorText, /NEVER retried/);
  assert.match(err.reel.operatorText, /video_reels/);
  assert.match(err.reel.operatorText, /aborted/i);
  assert.equal(err.cause, abort);
});

test('an ambiguous finish names the video_id the operator must verify', async () => {
  const { fb, deps } = harness();
  fb.on(
    isFinishCall,
    fbErr(
      graphError('network fault: socket hang up', {
        code: 0,
        category: 'ambiguous',
        retryable: false,
      }),
    ),
  );

  const err = await expectReelError(() =>
    finishReelUpload(deps, {
      pageId: PAGE_ID,
      videoId: VIDEO_ID,
      videoState: 'PUBLISHED',
    }),
  );

  assert.equal(err.reel.kind, 'ambiguous');
  assert.ok(
    err.reel.operatorText.includes(`GET /${VIDEO_ID}?fields=status`),
    `the operator must be told which Reel to check; got: ${err.reel.operatorText}`,
  );
  assert.equal(err.reel.videoId, VIDEO_ID);
  assert.ok(err.message.includes(VIDEO_ID));
  assert.equal(err.action?.operatorText, err.reel.operatorText);
});

test('a finish that confirms nothing names the video_id, and so does a finish rejection', async () => {
  const unconfirmed = harness();
  unconfirmed.fb.on(isFinishCall, fbOk({ success: false }));
  const err = await expectReelError(() =>
    finishReelUpload(unconfirmed.deps, {
      pageId: PAGE_ID,
      videoId: VIDEO_ID,
      videoState: 'PUBLISHED',
    }),
  );
  assert.equal(err.reel.kind, 'ambiguous');
  assert.ok(err.reel.operatorText.includes(`GET /${VIDEO_ID}?fields=status`));
  assert.equal(err.reel.videoId, VIDEO_ID);

  const rejected = harness();
  const cause = graphError('(#100) Video too short', {
    code: 100,
    category: 'validation',
  });
  rejected.fb.on(isFinishCall, fbErr(cause));
  const rejection = await expectReelError(() =>
    finishReelUpload(rejected.deps, {
      pageId: PAGE_ID,
      videoId: VIDEO_ID,
      videoState: 'PUBLISHED',
    }),
  );
  assert.equal(rejection.reel.kind, 'constraint');
  assert.equal(rejection.reel.videoId, VIDEO_ID);
  assert.ok(rejection.reel.operatorText.includes(VIDEO_ID));
  // Mapped, not swallowed: the Graph envelope survives the re-wrap.
  assert.equal(rejection.code, 100);
  assert.equal(rejection.cause, cause);
});

test('a caller abort during start or transfer stays a passthrough: nothing was published', async () => {
  const abort = new Error('This operation was aborted');
  abort.name = 'AbortError';

  const start = harness();
  start.fb.on(isStartCall, fbErr(abort));
  const startErr = await expectReelError(() =>
    startReelUpload(start.deps, { pageId: PAGE_ID, token: TOKEN }),
  );
  assert.equal(startErr.reel.kind, 'passthrough');
  assert.equal(startErr.reel.phase, 'start');

  const transfer = harness();
  transfer.fb.on(isTransferCall, fbErr(abort));
  const transferErr = await expectReelError(() =>
    uploadReelBinary(transfer.deps, { session: SESSION, data: bytes(10) }),
  );
  assert.equal(transferErr.reel.kind, 'passthrough');
  assert.equal(transferErr.reel.phase, 'transfer');
  assert.equal(transfer.fb.calls.length, 1, 'an abort is not a transient to resume from');
});

test('an ambiguous start never claims a Reel may have landed: only finish publishes', async () => {
  const { fb, deps } = harness();
  // Core stamps `ambiguous` on any POST whose response was lost (a 5xx, a
  // mid-flight reset). On the start POST that write only reserves an upload
  // session; no Reel can be live, and no listing shows a reserved id.
  fb.on(
    isStartCall,
    fbErr(
      graphError(
        'ambiguous write outcome (HTTP 502 on POST) — do NOT retry; verify first',
        {
          code: 0,
          category: 'ambiguous',
          retryable: false,
        },
      ),
    ),
  );

  const err = await expectReelError(() => startReelUpload(deps, { pageId: PAGE_ID }));

  assert.equal(err.reel.phase, 'start');
  assert.doesNotMatch(err.reel.operatorText, /may or may not have landed/);
  assert.doesNotMatch(err.reel.operatorText, /NEVER retried/);
  assert.doesNotMatch(err.reel.operatorText, /video_reels instead/);
  assert.match(err.reel.operatorText, /Nothing was published/);
  assert.equal(err.reel.nextTool, undefined, 'no read can show a reserved-only session');
  assert.equal(err.reel.retryable, true, 're-running the publish cannot publish twice');
  assert.equal(err.action?.retryable, true);

  // The transfer phase shares the rule: a chunk POST publishes nothing either.
  const transfer = classifyReelFailure(
    graphError('ambiguous upload outcome (network fault)', {
      code: 0,
      category: 'ambiguous',
    }),
    'transfer',
  );
  assert.doesNotMatch(transfer.operatorText, /may or may not have landed/);
  assert.match(transfer.operatorText, /Nothing was published/);
  assert.equal(transfer.retryable, true);
});

// ---------------------------------------------------------------------------
// Quota mapping (CC-MEDIA-8)
// ---------------------------------------------------------------------------

test('the rolling Reels cap maps to the distinct quota kind with a retry-after estimate', async () => {
  const { fb, deps } = harness();
  const cause = quotaError();
  fb.on(isFinishCall, fbErr(cause));

  const err = await expectReelError(() =>
    finishReelUpload(deps, {
      pageId: PAGE_ID,
      videoId: VIDEO_ID,
      videoState: 'PUBLISHED',
    }),
  );

  assert.equal(
    err.reel.kind,
    'quota',
    'a quota failure must not look like a generic one',
  );
  assert.equal(err.reel.phase, 'finish');
  assert.equal(err.reel.signatureId, 'quota-buc-family');
  assert.equal(err.reel.verified, true);
  // `ErrorCategory` is frozen and has no `quota` member, so the nearest legal
  // value rides in `category` while `kind` carries the precise verdict.
  assert.equal(err.reel.category, 'rate_limit');
  assert.equal(err.reel.retryable, false, 'a 24h wait must never become a retry loop');
  assert.equal(err.reel.retryAfterMs, 15 * MINUTE);
  assert.equal(err.reel.nextTool, 'facebook_usage');
  assert.match(err.reel.operatorText, /quota exhausted/);
  assert.ok(err.reel.operatorText.includes(String(REEL_QUOTA_PER_24H)));
  assert.match(err.reel.operatorText, /about 15 minutes/);
  assert.match(err.reel.operatorText, /Nothing was published by this call/);

  // Mapped, not swallowed: the original Graph answer is still reachable.
  assert.equal(err.code, 80004);
  assert.equal(err.cause, cause);
  assert.equal(err.action?.category, 'rate_limit');
  assert.equal(err.action?.retryAfterMs, 15 * MINUTE);
  assert.equal(err.action?.nextTool, 'facebook_usage');
});

test('a quota error without a Graph ETA falls back to the rolling 24h reset hint', () => {
  const failure = classifyReelFailure(
    graphError(
      '(#368) You have reached the daily limit of Reels you can publish from the API',
      { code: 368, category: 'permission', retryable: false },
    ),
    'finish',
  );

  assert.equal(failure.kind, 'quota');
  assert.equal(failure.signatureId, 'quota-policy-block');
  assert.equal(failure.verified, false, 'the 368 shape is inferred, not documented');
  assert.equal(failure.retryAfterMs, REEL_QUOTA_DEFAULT_RESET_MS);
  assert.match(failure.operatorText, /Graph did not supply an ETA/);
  assert.match(failure.operatorText, /1440 minutes/);
});

test('a Reels-cap message on an unlisted code still maps to quota, flagged unverified', () => {
  const failure = classifyReelFailure(
    graphError('(#1363030) Reels limit reached for this Page', {
      code: 1363030,
      category: 'unknown',
    }),
    'finish',
  );

  assert.equal(failure.kind, 'quota');
  assert.equal(failure.signatureId, 'quota-message-only');
  assert.equal(failure.verified, false);
});

test('a media rejection worded like the cap is a constraint, not a quota', () => {
  // Meta rejects an over-long Reel with the cap's own vocabulary - "Reels",
  // "limit", "reached" - on a plain validation code. Trusting the wording here
  // would answer a file that is a few seconds too long with "wait 24 h".
  const err = graphError(
    '(#100) Your video does not meet the Reels requirements: the duration limit is 90 seconds and this file reached 214 s',
    { code: 100, category: 'validation' },
  );

  assert.equal(isReelQuotaError(err), false);
  const failure = classifyReelFailure(err, 'finish');
  assert.equal(failure.kind, 'constraint');
  assert.equal(failure.category, 'validation');
  assert.equal(failure.retryable, false);
  assert.equal(failure.retryAfterMs, undefined, 'never advertise a cap reset');
  assert.match(failure.operatorText, /90 s duration/);
});

test('a bare throttle that does not name Reels is NOT reported as a Reels quota', () => {
  const err = graphError('(#4) Application request limit reached', {
    code: 4,
    category: 'rate_limit',
    retryable: true,
    retryAfterMs: 60_000,
  });

  assert.equal(isReelQuotaError(err), false);
  const failure = classifyReelFailure(err, 'finish');
  assert.equal(failure.kind, 'passthrough');
  assert.equal(failure.category, 'rate_limit');
  assert.equal(failure.retryable, true);
  assert.equal(failure.retryAfterMs, 60_000);
});

test("core's generic throttle default is not reported as Graph's reset estimate for the Reels cap", () => {
  // Built through core's own classifier, exactly as the transport builds it.
  // The BUC row stamps its generic 60 s throttle default into `retryAfterMs`
  // when the envelope carries no ETA, so a Reels cap with no ETA reaches this
  // module holding a number Graph never sent.
  const cause = toGraphApiError(
    {
      message: 'You have reached the maximum number of Reels you can publish in 24 hours',
      code: 80004,
    },
    400,
  );
  assert.equal(cause.action?.retryAfterMs, DEFAULT_THROTTLE_RETRY_AFTER_MS);

  const failure = classifyReelFailure(cause, 'finish');

  assert.equal(failure.kind, 'quota');
  assert.doesNotMatch(
    failure.operatorText,
    /Graph estimates access returns in about 1 minutes/,
    'a 24 h rolling cap must not be advertised as clearing in a minute Graph never quoted',
  );
  assert.match(failure.operatorText, /Graph did not supply an ETA/);
  assert.equal(failure.retryAfterMs, REEL_QUOTA_DEFAULT_RESET_MS);
});

test('a Reels cap with a real Graph ETA still surfaces that ETA', () => {
  const cause = toGraphApiError(
    {
      message: 'You have reached the maximum number of Reels you can publish in 24 hours',
      code: 80004,
      estimated_time_to_regain_access: 42,
    },
    400,
  );

  const failure = classifyReelFailure(cause, 'finish');

  assert.equal(failure.kind, 'quota');
  assert.equal(failure.retryAfterMs, 42 * MINUTE);
  assert.match(
    failure.operatorText,
    /Graph estimates access returns in about 42 minutes/,
  );
});

test('isReelQuotaError recognises an already-wrapped quota failure', () => {
  const wrapped = wrapReelError(quotaError(), 'finish');

  assert.equal(isReelQuotaError(wrapped), true);
  assert.equal(isReelQuotaError(new Error('not a graph error')), false);

  // Re-classifying is idempotent and keeps the original phase.
  const again = classifyReelFailure(wrapped, 'start');
  assert.equal(again.phase, 'finish');
  assert.equal(again.kind, 'quota');
});

// ---------------------------------------------------------------------------
// Error wrapping
// ---------------------------------------------------------------------------

test('wrapReelError preserves the Graph envelope and keeps the original as cause', () => {
  const cause = new GraphApiError('(#190) Error validating access token', {
    code: 190,
    subcode: 463,
    type: 'OAuthException',
    fbtraceId: 'trace-123',
    httpStatus: 401,
    action: {
      category: 'auth',
      retryable: false,
      operatorText: 'token expired',
      nextTool: 'facebook_whoami',
    },
  });

  const wrapped = wrapReelError(cause, 'start');

  assert.equal(wrapped.code, 190);
  assert.equal(wrapped.subcode, 463);
  assert.equal(wrapped.type, 'OAuthException');
  assert.equal(wrapped.fbtraceId, 'trace-123');
  assert.equal(wrapped.httpStatus, 401);
  assert.equal(wrapped.cause, cause);
  assert.equal(wrapped.reel.kind, 'passthrough');
  assert.equal(wrapped.reel.category, 'auth');
  assert.equal(wrapped.action?.nextTool, 'facebook_whoami');
  assert.equal(wrapReelError(wrapped, 'finish'), wrapped, 'wrapping is idempotent');
});

test("wrapReelError keeps Meta's user-facing title and message", () => {
  const cause = new GraphApiError('(#100) Invalid parameter', {
    code: 100,
    httpStatus: 400,
    userTitle: 'Video Too Long',
    userMessage: 'Reels must be 90 seconds or shorter.',
  });

  const wrapped = wrapReelError(cause, 'finish');

  assert.equal(wrapped.userTitle, 'Video Too Long');
  assert.equal(wrapped.userMessage, 'Reels must be 90 seconds or shorter.');
});

test('wrapReelError copes with a non-Graph throw', () => {
  const wrapped = wrapReelError(new TypeError('boom'), 'transfer');

  assert.equal(wrapped.reel.kind, 'passthrough');
  assert.equal(wrapped.reel.category, 'unknown');
  assert.equal(wrapped.reel.phase, 'transfer');
  assert.equal(wrapped.code, 0);
  assert.equal(wrapped.httpStatus, 0);
  assert.match(wrapped.reel.operatorText, /non-Graph error: boom/);
});

test('ReelPublishError satisfies both instanceof checks and names itself', () => {
  const err = wrapReelError(quotaError(), 'finish');

  assert.ok(err instanceof ReelPublishError, 'the subclass prototype must be pinned');
  assert.ok(
    err instanceof GraphApiError,
    'existing GraphApiError handling must still work',
  );
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'ReelPublishError');
  assert.equal(isReelPublishError(err), true);
  assert.equal(
    isReelPublishError(new GraphApiError('x', { code: 1, httpStatus: 400 })),
    false,
  );
});

// ---------------------------------------------------------------------------
// Lifecycle notes — the verified/assumed boundary (G-TOOL-3)
// ---------------------------------------------------------------------------

test('lifecycle notes state the Reels read edge as verified', () => {
  const notes = reelLifecycleNotes('PUBLISHED');
  const readEdge = notes.find((note) => note.id === 'reel-read-edge');

  assert.ok(readEdge);
  assert.equal(readEdge.verification, 'verified');
  assert.match(readEdge.text, /video_reels/);
  assert.match(readEdge.text, /does not appear on \/feed/);
});

test('lifecycle notes flag the Reel delete path as unverified rather than guessing', () => {
  const notes = reelLifecycleNotes('DRAFT');
  const del = notes.find((note) => note.id === 'reel-delete-path');

  assert.ok(del);
  assert.equal(del.verification, 'assumed');
  assert.match(del.text, /UNVERIFIED/);
  assert.match(del.text, /G-TOOL-3/);
});

test('lifecycle notes flag scheduled-Reel visibility as unverified', () => {
  const notes = reelLifecycleNotes('SCHEDULED');
  const visibility = notes.find((note) => note.id === 'reel-scheduled-visibility');

  assert.ok(visibility);
  assert.equal(visibility.verification, 'assumed');
  assert.match(visibility.text, /scheduled_posts/);

  const window = notes.find((note) => note.id === 'reel-scheduled-window');
  assert.ok(window);
  assert.equal(window.verification, 'verified');
  assert.match(window.text, /75 days/, 'the feed window is contrasted, not reused');
});

test('every state gets the general notes plus only its own state notes', () => {
  const published = reelLifecycleNotes('PUBLISHED').map((note) => note.id);
  const draft = reelLifecycleNotes('DRAFT').map((note) => note.id);

  assert.ok(published.includes('reel-is-a-video-object'));
  assert.ok(draft.includes('reel-is-a-video-object'));
  assert.ok(published.includes('reel-published'));
  assert.equal(published.includes('reel-draft'), false);
  assert.equal(draft.includes('reel-published'), false);
});

// ---------------------------------------------------------------------------
// Dry-run plan
// ---------------------------------------------------------------------------

test('planReelPublish previews the write without touching the wire', () => {
  const plan = planReelPublish(
    {
      pageId: PAGE_ID,
      byteLength: 2048,
      videoState: 'SCHEDULED',
      description: 'a reel',
      scheduledPublishTime: Math.floor((NOW + DAY) / 1000),
      pageTimezone: 'Europe/Sofia',
    },
    NOW,
  );

  assert.match(plan.summary, /2048-byte Reel/);
  assert.match(plan.summary, /video_state=SCHEDULED/);
  assert.equal(plan.readEdge, `/${PAGE_ID}/video_reels`);
  assert.ok(plan.schedule);
  assert.equal(plan.schedule.epochSeconds, Math.floor((NOW + DAY) / 1000));
  assert.ok(
    plan.warnings.some((warning) => warning.includes('not decoded locally')),
    'the dry run must admit there is no local media probe',
  );
  assert.ok(plan.warnings.some((warning) => warning.includes('rolling 24 h')));
  assert.ok(plan.lifecycle.some((note) => note.id === 'reel-scheduled-visibility'));
});

test('planReelPublish warns about an immediate publish and a missing caption', () => {
  const plan = planReelPublish(
    { pageId: PAGE_ID, byteLength: 10, videoState: 'PUBLISHED' },
    NOW,
  );

  assert.equal(plan.schedule, undefined);
  assert.ok(plan.warnings.some((warning) => warning.includes('no unpublish step')));
  assert.ok(plan.warnings.some((warning) => warning.includes('without a caption')));
});

test('planReelPublish rejects a past schedule in the dry run too', () => {
  const err = expectReelErrorSync(() =>
    planReelPublish(
      {
        pageId: PAGE_ID,
        byteLength: 10,
        videoState: 'SCHEDULED',
        scheduledPublishTime: Math.floor((NOW - DAY) / 1000),
      },
      NOW,
    ),
  );

  assert.equal(err.reel.kind, 'schedule');
  assert.match(err.message, /is in the past/);
});

test('planReelPublish refuses to preview a payload the apply step would reject', () => {
  const err = expectReelErrorSync(() =>
    planReelPublish({ pageId: PAGE_ID, byteLength: 0, videoState: 'PUBLISHED' }, NOW),
  );

  assert.equal(err.reel.kind, 'constraint');
  assert.match(err.message, /empty \(0 bytes\)/);
});

// ---------------------------------------------------------------------------
// No module-level state
// ---------------------------------------------------------------------------

test('two concurrent publishes share no module state', async () => {
  const a = harness({ chunkBytes: 4 });
  const b = harness({ chunkBytes: 4, nowMs: NOW + DAY });
  a.fb.on(isStartCall, fbOk({ video_id: 'reel-a', upload_url: UPLOAD_URL }));
  a.fb.on(isTransferCall, fbOk({}));
  a.fb.on(isFinishCall, fbOk({ success: true, post_id: 'a_1' }));
  b.fb.on(isStartCall, fbOk({ video_id: 'reel-b' }));
  b.fb.on(isTransferCall, fbOk({}));
  b.fb.on(isFinishCall, fbOk({ success: true, post_id: 'b_1' }));

  const [first, second] = await Promise.all([
    publishReel(a.deps, { pageId: 'PA', data: bytes(6), videoState: 'PUBLISHED' }),
    publishReel(b.deps, { pageId: 'PB', data: bytes(10), videoState: 'DRAFT' }),
  ]);

  assert.equal(first.session.videoId, 'reel-a');
  assert.equal(second.session.videoId, 'reel-b');
  assert.equal(first.transfer.chunks, 2);
  assert.equal(second.transfer.chunks, 3);
  assert.equal(first.finish.postId, 'a_1');
  assert.equal(second.finish.postId, 'b_1');
  assert.equal(second.session.uploadPath, '/video-upload/v25.0/reel-b');
  assert.equal(a.fb.calls.length, 4);
  assert.equal(b.fb.calls.length, 5);
});

/** Types a deliberately non-Error throwable so it can be thrown or rejected. */
function notAnError(value: object): Error {
  return value as Error;
}

test('a sink that throws a non-Error still never fails the commit, and the log keeps its text', async () => {
  for (const [thrown, expected] of [
    [{ message: 'transport closing' }, 'transport closing'],
    [Object.create(null) as object, 'unknown error (no message)'],
  ] as const) {
    const { fb, logger, clock } = harness();
    fb.on(isFinishCall, fbOk({ success: true, post_id: '111_222' }));
    const deps: ReelsDeps = {
      fbRequest: fb.fn,
      logger,
      clock,
      settings: WIRE,
      onProgress: () => {
        throw notAnError(thrown);
      },
    };

    const result = await finishReelUpload(deps, {
      pageId: PAGE_ID,
      videoId: VIDEO_ID,
      videoState: 'PUBLISHED',
    });

    assert.equal(result.success, true);
    assert.equal(
      fb.calls.filter(isFinishCall).length,
      1,
      'the commit still reached Graph',
    );
    const logged = logger.entries.filter((e) => e.msg === 'reels.progress.failed');
    assert.ok(logged.length > 0);
    for (const entry of logged) assert.equal(entry.fields?.error, expected);
  }
});

// ---------------------------------------------------------------------------
// Verify tools (wave 19): which read can show a Reel write that may have landed
// ---------------------------------------------------------------------------

function ambiguousFinishError(): GraphApiError {
  return graphError('network fault: socket hang up', {
    code: 0,
    category: 'ambiguous',
    retryable: false,
  });
}

function finishInputFor(state: 'PUBLISHED' | 'DRAFT' | 'SCHEDULED') {
  return {
    pageId: PAGE_ID,
    videoId: VIDEO_ID,
    videoState: state,
    ...(state === 'SCHEDULED'
      ? { scheduledPublishTime: Math.floor((NOW + DAY) / 1000) }
      : {}),
  } as const;
}

test('a PUBLISHED finish stamps facebook_list_reels as its verify tool, and an ambiguous outcome names it', async () => {
  const { fb, deps } = harness();
  fb.on(isFinishCall, fbErr(ambiguousFinishError()));

  const err = await expectReelError(() =>
    finishReelUpload(deps, finishInputFor('PUBLISHED')),
  );

  // The request the api layer sent carries the verify tool core names on an
  // ambiguous fault (timeout, network fault, 5xx on this non-idempotent POST).
  assert.equal(jsonOf(fb.lastRequest()).verifyTool, 'facebook_list_reels');
  assert.equal(err.reel.kind, 'ambiguous');
  assert.equal(err.reel.nextTool, 'facebook_list_reels');
  assert.equal(err.action?.nextTool, 'facebook_list_reels');
  assert.match(err.reel.operatorText, /verify via facebook_list_reels/);
  assert.ok(err.reel.operatorText.includes(VIDEO_ID));
});

test('a DRAFT or SCHEDULED finish verifies by video_id via facebook_get_video_status, not the Reels listing', async () => {
  for (const state of ['DRAFT', 'SCHEDULED'] as const) {
    const { fb, deps } = harness();
    fb.on(isFinishCall, fbErr(ambiguousFinishError()));

    const err = await expectReelError(() =>
      finishReelUpload(deps, finishInputFor(state)),
    );

    assert.equal(jsonOf(fb.lastRequest()).verifyTool, 'facebook_get_video_status', state);
    assert.equal(err.reel.kind, 'ambiguous', state);
    assert.equal(err.reel.nextTool, 'facebook_get_video_status', state);
    assert.equal(err.action?.nextTool, 'facebook_get_video_status', state);
    assert.match(err.reel.operatorText, /verify via facebook_get_video_status/, state);
    // The generic ambiguous text must not send a draft/scheduled Reel to an edge
    // it is not known to appear on, as a second, conflicting instruction.
    assert.doesNotMatch(
      err.reel.operatorText,
      /read GET \/\{page-id\}\/video_reels instead/,
      state,
    );
  }
});

test('a locally raised ambiguous finish (success:false, caller abort) names the same verify tool', async () => {
  const unconfirmed = harness();
  unconfirmed.fb.on(isFinishCall, fbOk({ success: false }));
  const err = await expectReelError(() =>
    finishReelUpload(unconfirmed.deps, finishInputFor('PUBLISHED')),
  );
  assert.equal(err.reel.kind, 'ambiguous');
  assert.equal(err.reel.nextTool, 'facebook_list_reels');
  assert.equal(err.action?.nextTool, 'facebook_list_reels');

  const aborted = harness();
  const abort = new Error('This operation was aborted');
  abort.name = 'AbortError';
  aborted.fb.on(isFinishCall, fbErr(abort));
  const abortErr = await expectReelError(() =>
    finishReelUpload(aborted.deps, finishInputFor('DRAFT')),
  );
  assert.equal(abortErr.reel.kind, 'ambiguous');
  assert.equal(abortErr.reel.nextTool, 'facebook_get_video_status');
  assert.equal(abortErr.action?.nextTool, 'facebook_get_video_status');
});

test('the start and transfer requests name no verify tool', async () => {
  const { fb, deps } = harness();
  programHappyPath(fb);

  await publishReel(deps, {
    pageId: PAGE_ID,
    data: new Uint8Array([1, 2, 3, 4]),
    videoState: 'PUBLISHED',
  });

  const start = fb.calls.find(isStartCall);
  const transfer = fb.calls.find(isTransferCall);
  assert.ok(start !== undefined && transfer !== undefined);
  // Start reserves an id nothing lists; transfer is offset-idempotent and never
  // ambiguous. Neither may point the caller at a listing.
  assert.equal(start.verifyTool, undefined);
  assert.equal(transfer.verifyTool, undefined);
});
