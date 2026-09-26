import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFakeClock,
  createFakeFbRequest,
  fbErr,
  fbOk,
} from '../core/fakes/index.js';
import { classifyNetworkError, GraphApiError } from '../core/index.js';
import type {
  Clock,
  ErrorCategory,
  FbRequest,
  FbResponse,
  JsonRequest,
  RuploadRequest,
} from '../core/index.js';
import type { FakeFbRequest } from '../core/fakes/index.js';

import {
  createUploadSessionRegistry,
  finishVideoUpload,
  getVideoStatus,
  isResumableUploadError,
  mapVideoStatus,
  readUploadOffset,
  ruploadPathForSession,
  startVideoUpload,
  transferVideoUpload,
  uploadVideo,
  CREATED_NOT_READY_NOTE,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_SESSION_TTL_MS,
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  SESSION_DESYNC_NOTE,
  SESSION_LOST_NOTE,
  STATUS_NOTES,
  VIDEO_STATUS_FIELDS,
  type UploadSessionRegistry,
  type VideoUploadDeps,
} from './media-video.js';

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const PAGE_ID = 'p1';
const SESSION_ID = 'us1';
const VIDEO_ID = 'v1';
const TOTAL = 12;
const API_VERSION = 'v25.0';
/** The rupload layout: api-name, then version, then id — version is SECOND. */
const UPLOAD_PATH = `/video-upload/${API_VERSION}/${SESSION_ID}`;

/**
 * A Graph id as it reaches this module when the wire sent a JSON NUMBER.
 * `JSON.parse` has already rounded it to the nearest double, so the low digits
 * are gone before any code here gets a look at it. Written through `Number(...)`
 * rather than as a literal so the rounding is the test's subject rather than a
 * lint error about a lossy literal.
 */
const ROUNDED_WIRE_ID = Number('12345678901234567890');

/** Deterministic file bytes; the pattern makes a mis-sliced chunk obvious. */
function bytes(n: number): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => (i * 7) % 251);
}

/**
 * A clock whose sleeps resolve immediately while recording their delays, so a
 * backoff can be asserted without a test hanging on a tick it forgot to drive.
 */
interface TestClock extends Clock {
  advance(ms: number): void;
  readonly sleeps: readonly number[];
}

function makeClock(startMs = 1_000): TestClock {
  let current = startMs;
  const sleeps: number[] = [];
  return {
    now: () => current,
    sleep: (ms: number): Promise<void> => {
      sleeps.push(ms);
      current += ms;
      return Promise.resolve();
    },
    advance: (ms: number): void => {
      current += ms;
    },
    get sleeps(): readonly number[] {
      return sleeps;
    },
  };
}

interface HarnessOptions {
  readonly maxResumeAttempts?: number;
  readonly resumeBackoffMs?: number;
  readonly ttlMs?: number;
}

interface Harness {
  readonly fb: FakeFbRequest;
  readonly clock: TestClock;
  readonly sessions: UploadSessionRegistry;
  readonly deps: VideoUploadDeps;
}

function harness(options: HarnessOptions = {}): Harness {
  const fb = createFakeFbRequest();
  const clock = makeClock();
  const sessions = createUploadSessionRegistry({
    clock,
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
  });
  const deps: VideoUploadDeps = {
    fbRequest: fb.fn,
    clock,
    sessions,
    settings: { apiVersion: API_VERSION },
    ...(options.maxResumeAttempts !== undefined
      ? { maxResumeAttempts: options.maxResumeAttempts }
      : {}),
    // Tests never wait: backoff scaling gets its own dedicated test.
    resumeBackoffMs: options.resumeBackoffMs ?? 0,
  };
  return { fb, clock, sessions, deps };
}

function jsonOf(req: FbRequest | undefined): JsonRequest {
  if (req === undefined || req.protocol !== 'json') {
    throw new Error(`expected a json request, got ${String(req?.protocol)}`);
  }
  return req;
}

function bodyOf(req: FbRequest | undefined): Readonly<Record<string, unknown>> {
  return jsonOf(req).body ?? {};
}

function chunksOf(fb: FakeFbRequest): RuploadRequest[] {
  return fb.calls.filter((r): r is RuploadRequest => r.protocol === 'rupload');
}

const isStart = (r: FbRequest): boolean =>
  r.protocol === 'json' && r.method === 'POST' && r.body?.['upload_phase'] === 'start';
const isFinish = (r: FbRequest): boolean =>
  r.protocol === 'json' && r.method === 'POST' && r.body?.['upload_phase'] === 'finish';
const isChunk = (r: FbRequest): boolean => r.protocol === 'rupload';
const isProbe = (r: FbRequest): boolean => r.protocol === 'json' && r.method === 'GET';

/** A `start` response: the session id, the assigned video id and the first window. */
function startBody(endOffset: number, overrides: Record<string, unknown> = {}): unknown {
  return {
    upload_session_id: SESSION_ID,
    video_id: VIDEO_ID,
    start_offset: '0',
    end_offset: String(endOffset),
    ...overrides,
  };
}

/** A chunk-accepted response: the NEXT window the server wants. */
function chunkBody(startOffset: number, endOffset = startOffset): unknown {
  return { start_offset: String(startOffset), end_offset: String(endOffset) };
}

function statusUploading(bytesTransferred: number): unknown {
  return {
    id: VIDEO_ID,
    status: {
      video_status: 'processing',
      uploading_phase: { status: 'in_progress', bytes_transferred: bytesTransferred },
    },
  };
}

function graphErr(category: ErrorCategory, httpStatus = 500): GraphApiError {
  return new GraphApiError(`${category} fault`, {
    code: 1,
    httpStatus,
    action: { category, retryable: category === 'transient', operatorText: 'test' },
  });
}

function abortErr(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

function asGraphError(err: unknown): GraphApiError {
  assert.ok(err instanceof GraphApiError, `expected a GraphApiError, got ${String(err)}`);
  return err;
}

/** Register a completed session directly, so `finish` tests need no transfer. */
function seedCompleted(sessions: UploadSessionRegistry): void {
  sessions.create({
    uploadSessionId: SESSION_ID,
    pageId: PAGE_ID,
    totalBytes: TOTAL,
    chunkSize: DEFAULT_CHUNK_SIZE,
    startOffset: TOTAL,
    endOffset: TOTAL,
    videoId: VIDEO_ID,
  });
}

// ---------------------------------------------------------------------------
// Session registry (CC-MEDIA-1) — in-memory only, clock-driven TTL
// ---------------------------------------------------------------------------

test('registry stamps createdAt/updatedAt from the injected clock', () => {
  const clock = createFakeClock(5_000);
  const sessions = createUploadSessionRegistry({ clock });

  const session = sessions.create({
    uploadSessionId: SESSION_ID,
    pageId: PAGE_ID,
    totalBytes: TOTAL,
    chunkSize: MIN_CHUNK_SIZE,
  });

  assert.equal(session.createdAt, 5_000);
  assert.equal(session.updatedAt, 5_000);
  assert.equal(session.phase, 'started');
  assert.equal(session.startOffset, 0);
  assert.equal(session.endOffset, TOTAL, 'the first window cannot exceed the file');
  assert.equal(session.resumes, 0);
  assert.equal(session.videoId, undefined);
  assert.equal(sessions.ttlMs, DEFAULT_SESSION_TTL_MS);
});

test('registry lookup reports progress for a live session and misses an unknown id', () => {
  const clock = createFakeClock();
  const sessions = createUploadSessionRegistry({ clock });
  sessions.create({
    uploadSessionId: SESSION_ID,
    pageId: PAGE_ID,
    totalBytes: TOTAL,
    chunkSize: MIN_CHUNK_SIZE,
  });

  clock.advance(10);
  const updated = sessions.update(SESSION_ID, { startOffset: 4, phase: 'transferring' });
  assert.equal(updated?.startOffset, 4);
  assert.equal(updated?.updatedAt, 10);
  assert.equal(sessions.get(SESSION_ID)?.startOffset, 4);
  assert.equal(sessions.get('nope'), undefined);
  assert.equal(sessions.update('nope', { startOffset: 1 }), undefined);
  assert.equal(sessions.size(), 1);
  assert.equal(sessions.list().length, 1);
  assert.equal(sessions.remove(SESSION_ID), true);
  assert.equal(sessions.remove(SESSION_ID), false);
  assert.equal(sessions.size(), 0);
});

test('registry evicts sessions idle longer than the TTL, driven by a fake clock', () => {
  const clock = createFakeClock();
  const sessions = createUploadSessionRegistry({ clock, ttlMs: 1_000 });
  sessions.create({
    uploadSessionId: SESSION_ID,
    pageId: PAGE_ID,
    totalBytes: TOTAL,
    chunkSize: MIN_CHUNK_SIZE,
  });

  clock.advance(1_000);
  assert.equal(sessions.evictExpired().length, 0, 'exactly at the TTL is still live');
  assert.equal(sessions.get(SESSION_ID)?.uploadSessionId, SESSION_ID);

  clock.advance(1);
  assert.deepEqual(sessions.evictExpired(), [SESSION_ID]);
  assert.equal(sessions.get(SESSION_ID), undefined, 'expired reads exactly like unknown');
  assert.equal(sessions.size(), 0);
});

test('registry lookup evicts lazily, so an expired session is never returned', () => {
  const clock = createFakeClock();
  const sessions = createUploadSessionRegistry({ clock, ttlMs: 100 });
  sessions.create({
    uploadSessionId: SESSION_ID,
    pageId: PAGE_ID,
    totalBytes: TOTAL,
    chunkSize: MIN_CHUNK_SIZE,
  });

  clock.advance(500);
  assert.equal(sessions.get(SESSION_ID), undefined);
  assert.equal(sessions.list().length, 0);
});

test('registry activity refreshes the TTL so a long upload is not evicted mid-flight', () => {
  const clock = createFakeClock();
  const sessions = createUploadSessionRegistry({ clock, ttlMs: 1_000 });
  sessions.create({
    uploadSessionId: SESSION_ID,
    pageId: PAGE_ID,
    totalBytes: TOTAL,
    chunkSize: MIN_CHUNK_SIZE,
  });

  for (let i = 0; i < 5; i += 1) {
    clock.advance(900);
    assert.notEqual(sessions.update(SESSION_ID, { startOffset: i }), undefined);
  }

  assert.equal(
    sessions.size(),
    1,
    'total age is 4500ms but it was never idle for 1000ms',
  );
  assert.equal(sessions.get(SESSION_ID)?.createdAt, 0, 'createdAt is still reported');
});

test('registry falls back to the default TTL for a non-positive override', () => {
  const clock = createFakeClock();
  assert.equal(
    createUploadSessionRegistry({ clock, ttlMs: 0 }).ttlMs,
    DEFAULT_SESSION_TTL_MS,
  );
  assert.equal(
    createUploadSessionRegistry({ clock, ttlMs: Number.NaN }).ttlMs,
    DEFAULT_SESSION_TTL_MS,
  );
});

test('two registries never share sessions (no module-level state)', () => {
  const clock = createFakeClock();
  const a = createUploadSessionRegistry({ clock });
  const b = createUploadSessionRegistry({ clock });
  a.create({
    uploadSessionId: SESSION_ID,
    pageId: PAGE_ID,
    totalBytes: TOTAL,
    chunkSize: MIN_CHUNK_SIZE,
  });

  assert.equal(a.size(), 1);
  assert.equal(b.size(), 0);
  assert.equal(b.get(SESSION_ID), undefined);
});

// ---------------------------------------------------------------------------
// Phase 1 — start
// ---------------------------------------------------------------------------

test('startVideoUpload opens the session on the video edge and registers it', async () => {
  const { fb, deps, sessions } = harness();
  fb.on(isStart, fbOk(startBody(4)));

  const session = await startVideoUpload(deps, {
    pageId: PAGE_ID,
    totalBytes: TOTAL,
    fileName: 'clip.mp4',
  });

  const req = jsonOf(fb.lastRequest());
  assert.equal(req.host, 'graph-video');
  assert.equal(req.path, `/${PAGE_ID}/videos`);
  assert.equal(req.method, 'POST');
  assert.equal(req.pageId, PAGE_ID);
  assert.deepEqual(req.body, {
    upload_phase: 'start',
    file_size: TOTAL,
    file_name: 'clip.mp4',
  });

  assert.equal(session.uploadSessionId, SESSION_ID);
  assert.equal(session.videoId, VIDEO_ID);
  assert.equal(session.totalBytes, TOTAL);
  assert.equal(session.startOffset, 0);
  assert.equal(session.endOffset, 4, 'the server-declared first window is honoured');
  assert.equal(sessions.get(SESSION_ID)?.uploadSessionId, SESSION_ID);
});

test('startVideoUpload clamps the chunk size into the supported range', async () => {
  const { fb, deps } = harness();
  fb.on(isStart, fbOk(startBody(4)));

  const tiny = await startVideoUpload(deps, {
    pageId: PAGE_ID,
    totalBytes: TOTAL,
    chunkSize: 3,
  });
  assert.equal(tiny.chunkSize, MIN_CHUNK_SIZE);

  const huge = await startVideoUpload(deps, {
    pageId: PAGE_ID,
    totalBytes: TOTAL,
    chunkSize: MAX_CHUNK_SIZE * 4,
  });
  assert.equal(huge.chunkSize, MAX_CHUNK_SIZE);

  const missing = await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  assert.equal(missing.chunkSize, DEFAULT_CHUNK_SIZE);
});

test('startVideoUpload rejects bad input before touching the wire', async () => {
  const { fb, deps } = harness();

  for (const totalBytes of [0, -1, 1.5, Number.NaN]) {
    const err = asGraphError(
      await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes }).catch(
        (e: unknown) => e,
      ),
    );
    assert.equal(err.action?.category, 'validation');
  }
  const noPage = asGraphError(
    await startVideoUpload(deps, { pageId: '  ', totalBytes: TOTAL }).catch(
      (e: unknown) => e,
    ),
  );
  assert.match(noPage.message, /pageId is required/);
  assert.equal(fb.calls.length, 0);
});

test('startVideoUpload reports a restart when the edge returns no session id', async () => {
  const { fb, deps, sessions } = harness();
  fb.on(isStart, fbOk({ video_id: VIDEO_ID }));

  const err = asGraphError(
    await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL }).catch(
      (e: unknown) => e,
    ),
  );
  assert.equal(err.action?.category, 'validation');
  assert.equal(err.action?.operatorText, SESSION_DESYNC_NOTE);
  assert.equal(
    sessions.size(),
    0,
    'nothing is registered for a session that never opened',
  );
});

test('startVideoUpload refuses a numeric upload_session_id rather than rounding one', async () => {
  const { fb, deps, sessions } = harness();
  // `fbRequest` CASTS the body, so an id arriving as a number is a fact about
  // the wire, not an impossibility (CC-NET-2). `String(n)` would mint a
  // plausible-looking session id that every chunk POST then uploads into, and
  // the whole file would be spent against a session Meta never opened. Refusing
  // here costs one round trip; discovering it after the transfer costs the file.
  fb.on(isStart, fbOk({ upload_session_id: ROUNDED_WIRE_ID, video_id: VIDEO_ID }));

  const err = asGraphError(
    await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL }).catch(
      (e: unknown) => e,
    ),
  );
  assert.equal(err.action?.operatorText, SESSION_DESYNC_NOTE);
  assert.equal(sessions.size(), 0, 'no session is opened around an id we cannot trust');
});

test('startVideoUpload falls back to one chunk step when end_offset is nonsense', async () => {
  const { fb, deps } = harness();
  fb.on(isStart, fbOk(startBody(0, { end_offset: 'not-a-number' })));

  const session = await startVideoUpload(deps, {
    pageId: PAGE_ID,
    totalBytes: TOTAL,
    chunkSize: MIN_CHUNK_SIZE,
  });
  assert.equal(session.endOffset, TOTAL, 'min(start + chunkSize, total)');
});

test('startVideoUpload refuses a first window that starts past the file end (CC-MEDIA-3)', async () => {
  // The chunk loop already refuses an acknowledged offset past the file end,
  // because a session that declared `total` bytes cannot hold more. The FIRST
  // window deserves the same check: accepted as-is, it registers a session that
  // is "already transferred", so transfer sends nothing and finish closes a
  // video with none of the caller's bytes while reporting them as sent.
  const { fb, deps, sessions } = harness();
  fb.on(isStart, fbOk(startBody(TOTAL, { start_offset: String(TOTAL * 10) })));

  const err = asGraphError(
    await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL }).catch(
      (e: unknown) => e,
    ),
  );
  assert.equal(err.action?.operatorText, SESSION_DESYNC_NOTE);
  assert.match(err.message, /past the 12-byte file end/);
  assert.equal(
    sessions.size(),
    0,
    'no session is registered around a window we cannot trust',
  );
});

test('uploadVideo never finishes a video whose start window lies past the file end', async () => {
  const { fb, deps } = harness();
  fb.on(isStart, fbOk(startBody(TOTAL, { start_offset: String(TOTAL + 1) })));
  fb.on(isFinish, fbOk({ id: VIDEO_ID, success: true }));

  const err = await uploadVideo(deps, { pageId: PAGE_ID, data: bytes(TOTAL) }).catch(
    (e: unknown) => e,
  );

  assert.ok(err instanceof GraphApiError, 'the upload must fail, not report success');
  assert.equal(fb.calls.filter(isFinish).length, 0, 'finish is never sent');
});

// ---------------------------------------------------------------------------
// Phase 2 — transfer
// ---------------------------------------------------------------------------

test('transferVideoUpload walks the server-declared windows to completion', async () => {
  const { fb, deps, sessions } = harness();
  fb.on(isStart, fbOk(startBody(5)));
  fb.on(isChunk, fbOk(chunkBody(5, 9)), 1);
  fb.on(isChunk, fbOk(chunkBody(9, 12)), 1);
  fb.on(isChunk, fbOk(chunkBody(12, 12)), 1);
  const data = bytes(TOTAL);

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const session = await transferVideoUpload(deps, {
    uploadSessionId: SESSION_ID,
    data,
  });

  const chunks = chunksOf(fb);
  assert.equal(chunks.length, 3);
  assert.deepEqual(
    chunks.map((c) => c.fileOffset),
    [0, 5, 9],
    'each chunk carries its own absolute file_offset',
  );
  assert.deepEqual(
    chunks.map((c) => c.chunk.byteLength),
    [5, 4, 3],
    'the server-declared end_offset sizes every chunk',
  );
  assert.deepEqual([...(chunks[1]?.chunk ?? [])], [...data.subarray(5, 9)]);
  assert.equal(chunks[0]?.host, 'rupload');
  assert.equal(chunks[0]?.path, UPLOAD_PATH);
  assert.equal(chunks[0]?.headers?.['file_size'], String(TOTAL));
  assert.equal(chunks[0]?.pageId, PAGE_ID);

  assert.equal(session.startOffset, TOTAL);
  assert.equal(session.phase, 'transferred');
  assert.equal(session.resumes, 0);
  assert.equal(sessions.get(SESSION_ID)?.phase, 'transferred');
});

test('every transfer chunk targets /video-upload/{version}/{session-id}', async () => {
  // The rupload host puts the API version SECOND, after the api-name — unlike a
  // Graph edge path, where it leads. Core validates a rupload path but deliberately
  // never injects a version into one, so this module composes the whole thing. A
  // wrong layout is invisible against a fake and only surfaces as a 404 on the real
  // wire, which is why every chunk's full path is pinned rather than just a suffix.
  const { fb, deps } = harness();
  fb.on(isStart, fbOk(startBody(4)));
  fb.on(isChunk, fbOk(chunkBody(4, 8)), 1);
  fb.on(isChunk, fbOk(chunkBody(TOTAL)));

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  await transferVideoUpload(deps, { uploadSessionId: SESSION_ID, data: bytes(TOTAL) });

  const chunks = chunksOf(fb);
  assert.ok(chunks.length > 1, 'the transfer must have sent more than one chunk');
  assert.deepEqual(
    [...new Set(chunks.map((c) => c.path))],
    [UPLOAD_PATH],
    'a resumed chunk targets the same versioned rupload path as the first',
  );
});

test('ruploadPathForSession puts the version second, after the api name', () => {
  assert.equal(
    ruploadPathForSession(SESSION_ID, API_VERSION),
    `/video-upload/${API_VERSION}/${SESSION_ID}`,
  );
});

test('transferVideoUpload reports progress once per accepted chunk', async () => {
  const { fb, deps } = harness();
  fb.on(isStart, fbOk(startBody(4)));
  fb.on(isChunk, fbOk(chunkBody(4, 8)), 1);
  fb.on(isChunk, fbOk(chunkBody(8, 12)), 1);
  fb.on(isChunk, fbOk(chunkBody(12)), 1);
  const seen: Array<[number, number]> = [];

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  await transferVideoUpload(deps, {
    uploadSessionId: SESSION_ID,
    data: bytes(TOTAL),
    onProgress: (sent, total) => seen.push([sent, total]),
  });

  assert.deepEqual(seen, [
    [4, TOTAL],
    [8, TOTAL],
    [12, TOTAL],
  ]);
});

test('a throwing progress sink never fails an upload whose bytes already landed', async () => {
  // The tools layer bridges onProgress onto an MCP progress notification, which
  // can throw on a closing transport (CC-MCP-1). Reporting is advisory: it must
  // not destroy an upload that the server has already accepted.
  const { fb, deps, sessions } = harness();
  fb.on(isStart, fbOk(startBody(4)));
  fb.on(isChunk, fbOk(chunkBody(4, 8)), 1);
  fb.on(isChunk, fbOk(chunkBody(8, 12)), 1);
  fb.on(isChunk, fbOk(chunkBody(12)), 1);
  let sinkCalls = 0;

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const session = await transferVideoUpload(deps, {
    uploadSessionId: SESSION_ID,
    data: bytes(TOTAL),
    onProgress: () => {
      sinkCalls += 1;
      throw new Error('progress notification failed');
    },
  });

  assert.equal(sinkCalls, 3, 'the sink is still offered every accepted chunk');
  assert.equal(session.startOffset, TOTAL);
  assert.equal(session.phase, 'transferred');
  assert.equal(sessions.get(SESSION_ID)?.phase, 'transferred');
});

test('a transient chunk failure resumes from the server offset instead of restarting', async () => {
  const { fb, deps, sessions } = harness();
  // A scripted exchange: start -> chunk fails -> offset probe -> chunk resumes.
  fb.enqueue(fbOk(startBody(4)));
  fb.enqueue(fbErr(graphErr('transient', 503)));
  fb.enqueue(fbOk(statusUploading(4)));
  fb.enqueue(fbOk(chunkBody(12)));
  const seen: Array<[number, number]> = [];

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const session = await transferVideoUpload(deps, {
    uploadSessionId: SESSION_ID,
    data: bytes(TOTAL),
    onProgress: (sent, total) => seen.push([sent, total]),
  });

  const chunks = chunksOf(fb);
  assert.equal(chunks.length, 2, 'the upload resumed — it did not restart');
  assert.deepEqual(
    chunks.map((c) => c.fileOffset),
    [0, 4],
    'the retry starts at the offset the SERVER reported, not at zero',
  );
  assert.equal(chunks[1]?.chunk.byteLength, 8, 'the tail after the confirmed offset');

  const probe = jsonOf(fb.calls.find(isProbe));
  assert.equal(probe.method, 'GET');
  assert.equal(probe.path, `/${VIDEO_ID}`);
  assert.deepEqual(probe.params, { fields: VIDEO_STATUS_FIELDS });

  assert.equal(session.startOffset, TOTAL);
  assert.equal(session.phase, 'transferred');
  assert.equal(session.resumes, 1);
  assert.deepEqual(seen, [[12, TOTAL]], 'the failed chunk reported no progress');
  assert.equal(sessions.get(SESSION_ID)?.lastError, 'transient fault');
});

test('a resume records the probed offset so a later call continues from it', async () => {
  // The server may have swallowed more bytes than the client saw acknowledged.
  // That probed offset is authoritative and must reach the registry immediately —
  // otherwise a follow-up transfer re-sends bytes Meta already holds.
  const { fb, deps, sessions } = harness();
  fb.enqueue(fbOk(startBody(4)));
  fb.enqueue(fbErr(graphErr('transient', 503)));
  fb.enqueue(fbOk(statusUploading(8)));
  fb.enqueue(fbErr(graphErr('validation', 400))); // terminal: freeze the state here

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  await assert.rejects(
    transferVideoUpload(deps, { uploadSessionId: SESSION_ID, data: bytes(TOTAL) }),
  );

  assert.deepEqual(
    chunksOf(fb).map((c) => c.fileOffset),
    [0, 8],
    'the resumed chunk starts where the server says it is',
  );
  assert.equal(
    sessions.get(SESSION_ID)?.startOffset,
    8,
    'the probed offset was persisted, not just used in the loop',
  );
});

test('an ambiguous chunk failure is resumable because chunks are offset-idempotent', async () => {
  const { fb, deps } = harness();
  fb.enqueue(fbOk(startBody(TOTAL)));
  fb.enqueue(fbErr(graphErr('ambiguous', 500)));
  fb.enqueue(fbOk(statusUploading(0)));
  fb.enqueue(fbOk(chunkBody(TOTAL)));

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const session = await transferVideoUpload(deps, {
    uploadSessionId: SESSION_ID,
    data: bytes(TOTAL),
  });

  assert.equal(session.startOffset, TOTAL);
  assert.equal(session.resumes, 1);
  assert.deepEqual(
    chunksOf(fb).map((c) => c.fileOffset),
    [0, 0],
    'the same window is re-sent when the server offset has not moved',
  );
});

test('retry exhaustion fails with a bounded resume error and marks the session failed', async () => {
  const { fb, deps, sessions } = harness({ maxResumeAttempts: 2 });
  fb.on(isStart, fbOk(startBody(TOTAL)));
  fb.on(isProbe, fbOk(statusUploading(0)));
  fb.on(isChunk, fbErr(graphErr('transient', 500)));

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const err = asGraphError(
    await transferVideoUpload(deps, {
      uploadSessionId: SESSION_ID,
      data: bytes(TOTAL),
    }).catch((e: unknown) => e),
  );

  assert.equal(chunksOf(fb).length, 3, 'the initial attempt plus exactly 2 resumes');
  assert.equal(err.action?.category, 'transient');
  assert.equal(
    err.action?.retryable,
    false,
    'the caller must check status, not hammer on',
  );
  assert.match(err.message, /could not be resumed after 2 attempt\(s\)/);
  assert.ok(
    err.cause instanceof GraphApiError,
    'the last wire fault is kept as the cause',
  );

  const session = sessions.get(SESSION_ID);
  assert.equal(session?.phase, 'failed');
  assert.equal(session?.startOffset, 0, 'no bytes were ever confirmed');
});

test('retry exhaustion names the video id the caller is told to check the status of', async () => {
  // The operator text says "check the video status before re-uploading". The
  // tools layer builds a fresh session registry per call, so once this error
  // leaves the api layer the id `start` assigned is gone unless it rides on the
  // error itself — and without it there is nothing to poll.
  const { fb, deps } = harness({ maxResumeAttempts: 1 });
  fb.on(isStart, fbOk(startBody(TOTAL)));
  fb.on(isProbe, fbOk(statusUploading(0)));
  fb.on(isChunk, fbErr(graphErr('transient', 500)));

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const err = asGraphError(
    await transferVideoUpload(deps, {
      uploadSessionId: SESSION_ID,
      data: bytes(TOTAL),
    }).catch((e: unknown) => e),
  );

  assert.match(err.message, /could not be resumed/);
  assert.match(
    err.message,
    new RegExp(`video '${VIDEO_ID}'`),
    'the id is in the message',
  );
  assert.match(
    err.action?.operatorText ?? '',
    new RegExp(`video '${VIDEO_ID}'`),
    'the status-check guidance names the video to check',
  );
});

test('a stalled offset that exhausts the budget also names the video id', async () => {
  const { fb, deps } = harness({ maxResumeAttempts: 0 });
  fb.on(isStart, fbOk(startBody(TOTAL)));
  fb.on(isChunk, fbOk(chunkBody(0, 0)));

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const err = asGraphError(
    await transferVideoUpload(deps, {
      uploadSessionId: SESSION_ID,
      data: bytes(TOTAL),
    }).catch((e: unknown) => e),
  );

  assert.match(err.message, /stuck at 0 of 12/);
  assert.match(err.message, new RegExp(`video '${VIDEO_ID}'`));
});

test('a non-resumable chunk failure propagates untouched and is never retried', async () => {
  const { fb, deps, sessions } = harness();
  fb.on(isStart, fbOk(startBody(TOTAL)));
  const fault = graphErr('permission', 403);
  fb.on(isChunk, fbErr(fault));

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const err = await transferVideoUpload(deps, {
    uploadSessionId: SESSION_ID,
    data: bytes(TOTAL),
  }).catch((e: unknown) => e);

  assert.equal(err, fault, 'the original error reaches the caller unwrapped');
  assert.equal(chunksOf(fb).length, 1);
  assert.equal(
    fb.calls.filter(isProbe).length,
    0,
    'no offset probe for a permanent fault',
  );
  assert.equal(sessions.get(SESSION_ID)?.phase, 'failed');
});

test('a failure rejected as a plain { message } object keeps its reason on the session', async () => {
  const { fb, deps, sessions } = harness();
  fb.on(isStart, fbOk(startBody(TOTAL)));
  fb.on(isChunk, fbErr({ message: 'socket hang up' } as unknown as Error));

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  await transferVideoUpload(deps, {
    uploadSessionId: SESSION_ID,
    data: bytes(TOTAL),
  }).catch(() => undefined);

  const session = sessions.get(SESSION_ID);
  assert.equal(session?.phase, 'failed');
  assert.equal(session?.lastError, 'socket hang up');
});

test('an abort propagates immediately and leaves the session resumable (CC-MCP-2)', async () => {
  const { fb, deps, sessions } = harness();
  fb.on(isStart, fbOk(startBody(4)));
  fb.on(isChunk, fbOk(chunkBody(4, 8)), 1);
  fb.on(isChunk, fbErr(abortErr()));

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const err = await transferVideoUpload(deps, {
    uploadSessionId: SESSION_ID,
    data: bytes(TOTAL),
  }).catch((e: unknown) => e);

  assert.ok(err instanceof Error);
  assert.equal(err.name, 'AbortError');
  assert.equal(
    chunksOf(fb).length,
    2,
    'cancellation is not a fault — nothing is retried',
  );
  const session = sessions.get(SESSION_ID);
  assert.equal(session?.phase, 'transferring', 'still resumable, not failed');
  assert.equal(session?.startOffset, 4, 'the confirmed offset survives the cancellation');
});

test('an abort during the resume backoff cancels the transfer (CC-MCP-2)', async () => {
  // A real backoff parks on the injected clock; the caller's signal must reach it,
  // otherwise a cancelled upload keeps sleeping and then sends another chunk.
  const fb = createFakeFbRequest();
  const clock = createFakeClock();
  const sessions = createUploadSessionRegistry({ clock });
  const deps: VideoUploadDeps = {
    fbRequest: fb.fn,
    clock,
    sessions,
    settings: { apiVersion: API_VERSION },
    resumeBackoffMs: 100,
  };
  const controller = new AbortController();
  fb.on(isStart, fbOk(startBody(TOTAL)));
  fb.on(isChunk, fbErr(graphErr('transient', 503)));

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const pending = transferVideoUpload(deps, {
    uploadSessionId: SESSION_ID,
    data: bytes(TOTAL),
    signal: controller.signal,
  });

  // Let the first chunk fail and the backoff park itself on the clock.
  for (let i = 0; i < 20 && clock.pendingSleeps() === 0; i += 1) {
    await Promise.resolve();
  }
  assert.equal(clock.pendingSleeps(), 1, 'the backoff is waiting on the injected clock');
  controller.abort();

  const err = await pending.catch((e: unknown) => e);
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'AbortError');
  assert.equal(clock.pendingSleeps(), 0, 'the sleep was detached, not leaked');
  assert.equal(chunksOf(fb).length, 1, 'no chunk is sent after the cancellation');
  assert.equal(
    fb.calls.filter(isProbe).length,
    0,
    'the offset probe never runs after an aborted backoff',
  );
});

test('a server offset that never advances exhausts the budget instead of looping', async () => {
  const { fb, deps, sessions } = harness({ maxResumeAttempts: 1 });
  fb.on(isStart, fbOk(startBody(TOTAL)));
  fb.on(isChunk, fbOk(chunkBody(0, 0)));

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const err = asGraphError(
    await transferVideoUpload(deps, {
      uploadSessionId: SESSION_ID,
      data: bytes(TOTAL),
    }).catch((e: unknown) => e),
  );

  assert.match(err.message, /stuck at 0 of 12/);
  assert.equal(chunksOf(fb).length, 2, 'bounded by the resume budget');
  assert.equal(sessions.get(SESSION_ID)?.phase, 'failed');
});

test('a server offset behind the local one is a rewind: the next chunk starts where Graph says (CC-MEDIA-2)', async () => {
  const { fb, deps } = harness();
  fb.on(isStart, fbOk(startBody(4)));
  fb.on(isChunk, fbOk(chunkBody(4, 8)), 1);
  fb.on(isChunk, fbOk(chunkBody(8, 12)), 1);
  // Graph did not keep [8, 12) and asks for [4, 8) again: its offset is the
  // authoritative one, so the next chunk must start at 4, not at the local 8.
  fb.on(isChunk, fbOk(chunkBody(4, 8)), 1);
  fb.on(isChunk, fbOk(chunkBody(8, 12)), 1);
  fb.on(isChunk, fbOk(chunkBody(12, 12)), 1);
  const data = bytes(TOTAL);

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const session = await transferVideoUpload(deps, { uploadSessionId: SESSION_ID, data });

  const chunks = chunksOf(fb);
  assert.deepEqual(
    chunks.map((c) => c.fileOffset),
    [0, 4, 8, 4, 8],
    'the chunk after the rewind starts at the server offset, not the local one',
  );
  assert.deepEqual([...(chunks[3]?.chunk ?? [])], [...data.subarray(4, 8)]);
  assert.equal(session.startOffset, TOTAL);
  assert.equal(session.phase, 'transferred');
  assert.equal(
    session.resumes,
    1,
    'a rewind consumes one resume attempt, so the loop stays bounded',
  );
});

test('a server offset past the file end is a desync, not a completed transfer (CC-MEDIA-3)', async () => {
  const { fb, deps, sessions } = harness();
  fb.on(isStart, fbOk(startBody(4)));
  fb.on(isChunk, fbOk(chunkBody(4, 8)), 1);
  // A session that declared 12 bytes cannot have received 40: the server is
  // describing some other file (or some other session). Calling that "done"
  // would finish — and possibly publish — a video that is not this one.
  fb.on(isChunk, fbOk(chunkBody(40, 40)), 1);

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const err = asGraphError(
    await transferVideoUpload(deps, {
      uploadSessionId: SESSION_ID,
      data: bytes(TOTAL),
    }).catch((e: unknown) => e),
  );

  assert.equal(err.action?.operatorText, SESSION_DESYNC_NOTE);
  assert.match(err.message, /40/);
  assert.equal(
    chunksOf(fb).length,
    2,
    'nothing more is sent on a session that no longer describes this file',
  );
  const session = sessions.get(SESSION_ID);
  assert.equal(session?.phase, 'failed');
  assert.equal(
    session?.startOffset,
    4,
    'the last confirmed offset is kept, not the impossible one',
  );
});

test('a missing offset in the accept response assumes the sent window landed', async () => {
  const { fb, deps } = harness();
  fb.on(isStart, fbOk(startBody(4)));
  fb.on(isChunk, fbOk({ success: true }));

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const session = await transferVideoUpload(deps, {
    uploadSessionId: SESSION_ID,
    data: bytes(TOTAL),
  });

  assert.equal(session.startOffset, TOTAL);
  assert.deepEqual(
    chunksOf(fb).map((c) => c.fileOffset),
    [0, 4],
    'without a declared window it falls back to the client chunk step, capped at the file end',
  );
});

test('a chunk answered 2xx with success:false and no offset is not counted as landed', async () => {
  // The body explicitly refuses the chunk. Falling back to "the sent window
  // landed" would advance past bytes the server declined and report the whole
  // file transferred, inviting a finish on a video Graph never received.
  const { fb, deps, sessions } = harness({ maxResumeAttempts: 1 });
  fb.on(isStart, fbOk(startBody(4)));
  fb.on(isChunk, fbOk({ success: false }));

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const err = await transferVideoUpload(deps, {
    uploadSessionId: SESSION_ID,
    data: bytes(TOTAL),
  }).catch((e: unknown) => e);

  assert.ok(
    err instanceof GraphApiError,
    'a refused chunk must not end in a clean transfer',
  );
  assert.deepEqual(
    chunksOf(fb).map((c) => c.fileOffset),
    [0, 0],
    'the refused window is re-sent, never skipped',
  );
  assert.equal(sessions.get(SESSION_ID)?.startOffset, 0);
  assert.equal(sessions.get(SESSION_ID)?.phase, 'failed');
});

test('a resume offset is also read from the file_offset response header', async () => {
  const { fb, deps } = harness();
  fb.on(isStart, fbOk(startBody(4)));
  fb.on(isChunk, fbOk({}, { file_offset: String(TOTAL) }), 1);

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const session = await transferVideoUpload(deps, {
    uploadSessionId: SESSION_ID,
    data: bytes(TOTAL),
  });

  assert.equal(session.startOffset, TOTAL);
  assert.equal(chunksOf(fb).length, 1);
});

test('a resume waits on the injected clock with a scaled backoff', async () => {
  const { fb, deps, clock } = harness({ maxResumeAttempts: 3, resumeBackoffMs: 100 });
  fb.on(isStart, fbOk(startBody(TOTAL)));
  fb.on(isProbe, fbOk(statusUploading(0)));
  fb.on(isChunk, fbErr(graphErr('transient', 500)), 2);
  fb.on(isChunk, fbOk(chunkBody(TOTAL)));

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const session = await transferVideoUpload(deps, {
    uploadSessionId: SESSION_ID,
    data: bytes(TOTAL),
  });

  assert.deepEqual(clock.sleeps, [100, 200], 'linear scaling, no real timers');
  assert.equal(session.resumes, 2);
});

/** A retryable chunk fault whose transport attached a server-named wait (`Retry-After`). */
function waitErr(retryAfterMs: number): GraphApiError {
  return new GraphApiError('Service Unavailable', {
    code: 2,
    httpStatus: 503,
    action: {
      category: 'transient',
      retryable: true,
      operatorText: 'test',
      retryAfterMs,
    },
  });
}

test('a chunk re-drive waits out the server-named Retry-After, not just the local backoff', async () => {
  const { fb, deps, clock } = harness({ maxResumeAttempts: 3, resumeBackoffMs: 100 });
  fb.on(isStart, fbOk(startBody(TOTAL)));
  fb.on(isProbe, fbOk(statusUploading(0)));
  fb.on(isChunk, fbErr(waitErr(5_000)), 1);
  fb.on(isChunk, fbOk(chunkBody(TOTAL)));

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const session = await transferVideoUpload(deps, {
    uploadSessionId: SESSION_ID,
    data: bytes(TOTAL),
  });

  assert.deepEqual(
    clock.sleeps,
    [5_000],
    'the server said when to come back; re-driving after 100 ms hammers the same outage',
  );
  assert.equal(session.resumes, 1);
});

test('a server-named wait beyond the in-call cap surfaces at once with the wait attached', async () => {
  const { fb, deps, clock, sessions } = harness({
    maxResumeAttempts: 3,
    resumeBackoffMs: 100,
  });
  fb.on(isStart, fbOk(startBody(TOTAL)));
  fb.on(isProbe, fbOk(statusUploading(0)));
  fb.on(isChunk, fbErr(waitErr(120_000)), 1);
  fb.on(isChunk, fbOk(chunkBody(TOTAL)));

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const err = asGraphError(
    await transferVideoUpload(deps, {
      uploadSessionId: SESSION_ID,
      data: bytes(TOTAL),
    }).then(
      () => undefined,
      (e: unknown) => e,
    ),
  );

  assert.equal(
    chunksOf(fb).length,
    1,
    'no re-drive into the announced maintenance window',
  );
  assert.equal(fb.calls.filter(isProbe).length, 0, 'no offset probe either');
  assert.deepEqual(clock.sleeps, [], 'a two-minute wait is not slept through in-call');
  assert.equal(err.action?.retryAfterMs, 120_000, 'the caller is told how long to wait');
  assert.equal(err.action?.category, 'transient');
  assert.equal(err.action?.retryable, true);
  assert.match(err.action?.operatorText ?? '', /v1/, 'names the video to check');
  assert.equal(err.httpStatus, 503, 'Graph identity is kept');
  const left = sessions.get(SESSION_ID);
  assert.equal(left?.resumes, 0, 'no resume attempt was spent');
  assert.equal(left?.phase, 'transferring', 'the session stays resumable');
});

test('a failing offset probe does not mask the upload fault', async () => {
  const { fb, deps } = harness({ maxResumeAttempts: 1 });
  fb.on(isStart, fbOk(startBody(TOTAL)));
  fb.on(isProbe, fbErr(graphErr('not_found', 404)));
  fb.on(isChunk, fbErr(graphErr('transient', 500)), 1);
  fb.on(isChunk, fbOk(chunkBody(TOTAL)));

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const session = await transferVideoUpload(deps, {
    uploadSessionId: SESSION_ID,
    data: bytes(TOTAL),
  });

  assert.equal(session.startOffset, TOTAL, 'the window is simply re-sent');
  assert.equal(session.resumes, 1);
});

test('transferVideoUpload refuses data whose size disagrees with the session', async () => {
  const { fb, deps } = harness();
  fb.on(isStart, fbOk(startBody(4)));

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const err = asGraphError(
    await transferVideoUpload(deps, {
      uploadSessionId: SESSION_ID,
      data: bytes(8),
    }).catch((e: unknown) => e),
  );

  assert.equal(err.action?.category, 'validation');
  assert.equal(err.action?.operatorText, SESSION_DESYNC_NOTE);
  assert.match(err.message, /8 byte\(s\) but the session declared 12/);
  assert.equal(chunksOf(fb).length, 0);
});

test('transferVideoUpload on an unknown session says restart the upload (CC-MEDIA-1)', async () => {
  const { fb, deps } = harness();

  const err = asGraphError(
    await transferVideoUpload(deps, {
      uploadSessionId: 'gone',
      data: bytes(TOTAL),
    }).catch((e: unknown) => e),
  );

  assert.equal(err.action?.category, 'not_found');
  assert.equal(err.action?.operatorText, SESSION_LOST_NOTE);
  assert.equal(err.action?.retryable, false);
  assert.equal(fb.calls.length, 0, 'a lost session is never silently re-created');
});

test('a second transfer call continues from the confirmed offset', async () => {
  const { fb, deps } = harness();
  fb.on(isStart, fbOk(startBody(4)));
  fb.on(isChunk, fbOk(chunkBody(4, 8)), 1);
  fb.on(isChunk, fbErr(graphErr('validation', 400)), 1);

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const data = bytes(TOTAL);
  await assert.rejects(transferVideoUpload(deps, { uploadSessionId: SESSION_ID, data }));

  fb.on(isChunk, fbOk(chunkBody(TOTAL)));
  const session = await transferVideoUpload(deps, { uploadSessionId: SESSION_ID, data });

  assert.equal(session.startOffset, TOTAL);
  assert.deepEqual(
    chunksOf(fb).map((c) => c.fileOffset),
    [0, 4, 4],
    'the resumed call re-sends only the unconfirmed tail',
  );
});

test('transferVideoUpload on an already complete session re-sends nothing', async () => {
  const { fb, deps, sessions } = harness();
  seedCompleted(sessions);
  const seen: number[] = [];

  const session = await transferVideoUpload(deps, {
    uploadSessionId: SESSION_ID,
    data: bytes(TOTAL),
    onProgress: (sent) => seen.push(sent),
  });

  assert.equal(session.phase, 'transferred');
  assert.equal(session.startOffset, TOTAL);
  assert.equal(fb.calls.length, 0, 'confirmed bytes are never uploaded twice');
  assert.deepEqual(seen, [], 'no progress is invented for bytes already confirmed');
});

test('a server-side session expiry is reported, never silently re-created (CC-MEDIA-3)', async () => {
  const { fb, deps, sessions } = harness();
  fb.on(isStart, fbOk(startBody(4)));
  fb.on(isChunk, fbOk(chunkBody(4, 8)), 1);
  // The shape core/http-upload.ts raises when the server refuses to resume.
  const expired = new GraphApiError('upload session expired', {
    code: 0,
    httpStatus: 0,
    action: {
      category: 'validation',
      retryable: false,
      operatorText: SESSION_DESYNC_NOTE,
    },
  });
  fb.on(isChunk, fbErr(expired));

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const err = await transferVideoUpload(deps, {
    uploadSessionId: SESSION_ID,
    data: bytes(TOTAL),
  }).catch((e: unknown) => e);

  assert.equal(err, expired, 'the restart guidance reaches the caller untouched');
  assert.equal(chunksOf(fb).length, 2, 'an expired session is not retried');
  assert.equal(
    fb.calls.filter(isStart).length,
    1,
    'no replacement session is opened behind the caller',
  );
  const session = sessions.get(SESSION_ID);
  assert.equal(session?.phase, 'failed');
  assert.equal(
    session?.startOffset,
    4,
    'the confirmed prefix is preserved for the report',
  );
  assert.equal(sessions.size(), 1, 'the failed session is kept, not swapped out');
});

// ---------------------------------------------------------------------------
// Phase 3 — finish
// ---------------------------------------------------------------------------

test('finishVideoUpload closes the session and returns the video id', async () => {
  const { fb, deps, sessions } = harness();
  seedCompleted(sessions);
  fb.on(isFinish, fbOk({ success: true, video_id: 'v9' }));

  const result = await finishVideoUpload(deps, {
    uploadSessionId: SESSION_ID,
    title: 'Launch',
    description: 'ship it',
    published: false,
    scheduledPublishTime: 1_700_000_000,
  });

  const req = jsonOf(fb.lastRequest());
  assert.equal(req.host, 'graph-video');
  assert.equal(req.path, `/${PAGE_ID}/videos`);
  assert.deepEqual(req.body, {
    upload_phase: 'finish',
    upload_session_id: SESSION_ID,
    title: 'Launch',
    description: 'ship it',
    published: false,
    scheduled_publish_time: 1_700_000_000,
  });

  assert.equal(result.videoId, 'v9');
  assert.equal(result.success, true);
  assert.equal(result.totalBytes, TOTAL);
  assert.equal(result.resumes, 0);
  assert.equal(result.note, CREATED_NOT_READY_NOTE, 'created is not ready (CC-MEDIA-7)');
  const session = sessions.get(SESSION_ID);
  assert.equal(session?.phase, 'finished');
  assert.equal(session?.videoId, 'v9');
});

test('a second finish on an already finished session is refused without a wire call (CC-MEDIA-3)', async () => {
  const { fb, deps, sessions } = harness();
  seedCompleted(sessions);
  fb.on(isFinish, fbOk({ success: true, video_id: 'v9' }));

  await finishVideoUpload(deps, { uploadSessionId: SESSION_ID, title: 'Launch' });
  const err = asGraphError(
    await finishVideoUpload(deps, { uploadSessionId: SESSION_ID, title: 'Launch' }).catch(
      (e: unknown) => e,
    ),
  );

  // `finish` is NOT idempotent: Graph can mint a second post for the same bytes.
  assert.equal(
    fb.calls.filter(isFinish).length,
    1,
    'upload_phase=finish went out exactly once',
  );
  assert.equal(err.action?.category, 'validation');
  assert.match(err.message, /already finished/);
  assert.match(err.message, /v9/, 'the refusal names the video the caller already has');
  assert.equal(sessions.get(SESSION_ID)?.phase, 'finished');
});

test('a transfer on a finished session is refused and does not reopen it for a second finish', async () => {
  const { fb, deps, sessions } = harness();
  seedCompleted(sessions);
  fb.on(isFinish, fbOk({ success: true }));
  await finishVideoUpload(deps, { uploadSessionId: SESSION_ID });

  const err = asGraphError(
    await transferVideoUpload(deps, {
      uploadSessionId: SESSION_ID,
      data: bytes(TOTAL),
    }).catch((e: unknown) => e),
  );

  assert.match(err.message, /already finished/);
  assert.equal(
    sessions.get(SESSION_ID)?.phase,
    'finished',
    'the phase is not rewound to transferred, which would let a second finish through',
  );
  assert.equal(fb.calls.length, 1, 'only the one finish ever reached the wire');
});

test('finishVideoUpload omits every field the caller did not set', async () => {
  const { fb, deps, sessions } = harness();
  seedCompleted(sessions);
  fb.on(isFinish, fbOk({ success: true }));

  const result = await finishVideoUpload(deps, { uploadSessionId: SESSION_ID });

  assert.deepEqual(bodyOf(fb.lastRequest()), {
    upload_phase: 'finish',
    upload_session_id: SESSION_ID,
  });
  assert.equal(result.videoId, VIDEO_ID, 'falls back to the id start already assigned');
});

test('finishVideoUpload ignores a numeric video_id and keeps the id start assigned', async () => {
  const { fb, deps, sessions } = harness();
  seedCompleted(sessions);
  // The rounded id names a video that is not this one. Handing it back would
  // send the caller to poll — and eventually publish — somebody else's node,
  // while the video they actually uploaded goes unwatched.
  fb.on(isFinish, fbOk({ success: true, video_id: ROUNDED_WIRE_ID }));

  const result = await finishVideoUpload(deps, { uploadSessionId: SESSION_ID });

  assert.equal(
    result.videoId,
    VIDEO_ID,
    'the string id from start outranks a rounded one',
  );
  assert.equal(sessions.get(SESSION_ID)?.videoId, VIDEO_ID);
});

test('finishVideoUpload surfaces a false success flag instead of assuming success', async () => {
  const { fb, deps } = harness();
  seedCompleted(deps.sessions);
  fb.on(isFinish, fbOk({ success: false, video_id: VIDEO_ID }));

  const result = await finishVideoUpload(deps, { uploadSessionId: SESSION_ID });

  assert.equal(result.success, false, 'the wire verdict is reported, not overwritten');
  assert.equal(result.videoId, VIDEO_ID);
  assert.equal(result.note, CREATED_NOT_READY_NOTE);
});

test('finishVideoUpload treats a non-boolean success flag as a decline, not a confirmation', async () => {
  // `success` is documented as "the edge's own flag when it sent one". A string
  // "false", a `0` or a `null` IS the edge sending one — and sending a refusal.
  // Coercing those to `true` reports `accepted: true` for a video Graph declined.
  for (const flag of ['false', 0, null] as const) {
    const { fb, deps } = harness();
    seedCompleted(deps.sessions);
    fb.on(isFinish, fbOk({ success: flag, video_id: VIDEO_ID }));

    const result = await finishVideoUpload(deps, { uploadSessionId: SESSION_ID });

    assert.equal(
      result.success,
      false,
      `a present success of ${JSON.stringify(flag)} is a refusal, not a confirmation`,
    );
    assert.equal(
      result.videoId,
      VIDEO_ID,
      'the id still comes back, so nothing is re-uploaded',
    );
  }
});

test('an error during finish marks the session failed and rethrows', async () => {
  const { fb, deps, sessions } = harness();
  seedCompleted(sessions);
  const fault = graphErr('rate_limit', 400);
  fb.on(isFinish, fbErr(fault));

  const err = await finishVideoUpload(deps, { uploadSessionId: SESSION_ID }).catch(
    (e: unknown) => e,
  );

  assert.equal(err, fault);
  const session = sessions.get(SESSION_ID);
  assert.equal(session?.phase, 'failed');
  assert.equal(session?.lastError, 'rate_limit fault');
  assert.equal(
    session?.startOffset,
    TOTAL,
    'the session is kept so finish can be re-issued without re-uploading',
  );
});

test('a finish whose answer was lost names the video id so the caller can poll instead of re-uploading', async () => {
  // A lost finish answer may have created (and published) the video. The
  // transport's ambiguous action points at the feed, which does not answer
  // "did THIS video get finished" — the video status does, and only the id
  // `start` assigned can ask it. The tools layer's registry dies with the call.
  const { fb, deps, sessions } = harness();
  seedCompleted(sessions);
  const lost = new GraphApiError(
    'ambiguous write outcome (network fault) — verify first',
    {
      code: 0,
      httpStatus: 0,
      action: {
        category: 'ambiguous',
        retryable: false,
        nextTool: 'facebook_list_posts',
        operatorText: 'Write outcome unknown — verify first.',
      },
    },
  );
  fb.on(isFinish, fbErr(lost));

  const err = asGraphError(
    await finishVideoUpload(deps, { uploadSessionId: SESSION_ID }).catch(
      (e: unknown) => e,
    ),
  );

  assert.equal(err.message, lost.message, 'the transport line stays greppable');
  assert.equal(err.httpStatus, 0);
  assert.equal(err.code, 0);
  assert.equal(err.action?.category, 'ambiguous', 'still a may-have-landed outcome');
  assert.equal(err.action?.retryable, false);
  assert.match(
    err.action?.operatorText ?? '',
    new RegExp(`video '${VIDEO_ID}'`),
    'the guidance names the video that may now exist',
  );
  assert.equal(err.action?.nextTool, 'facebook_get_video_status');
  assert.equal(err.cause, lost, 'the transport fault is kept as the cause');
  assert.equal(sessions.get(SESSION_ID)?.phase, 'failed');
});

test('a finish that failed after reaching the edge (5xx) also names the video id', async () => {
  const { fb, deps, sessions } = harness();
  seedCompleted(sessions);
  fb.on(isFinish, fbErr(graphErr('transient', 503)));

  const err = asGraphError(
    await finishVideoUpload(deps, { uploadSessionId: SESSION_ID }).catch(
      (e: unknown) => e,
    ),
  );

  assert.equal(err.httpStatus, 503);
  assert.match(err.action?.operatorText ?? '', new RegExp(`video '${VIDEO_ID}'`));
});

test('a finish that provably never left the host is not reported as maybe-landed', async () => {
  // A connect-phase fault is classified by core as "the request provably never
  // reached Facebook" (transient, retryable). Appending "the finish may have
  // gone through" to that contradicts the transport and tells the caller a
  // video may exist when none can.
  const { fb, deps, sessions } = harness();
  seedCompleted(sessions);
  const notSent = new GraphApiError('network request failed: connect ECONNREFUSED', {
    code: 0,
    httpStatus: 0,
    action: classifyNetworkError({
      phase: 'connect',
      isWrite: true,
      reason: 'connect ECONNREFUSED',
    }),
  });
  fb.on(isFinish, fbErr(notSent));

  const err = await finishVideoUpload(deps, { uploadSessionId: SESSION_ID }).catch(
    (e: unknown) => e,
  );

  assert.equal(err, notSent, 'a provably-unsent fault propagates untouched');
  assert.doesNotMatch(
    asGraphError(err).action?.operatorText ?? '',
    /may have gone through/,
  );
});

test('a finish refused before the wire (auth, no HTTP status) is not reported as maybe-landed', async () => {
  const { fb, deps, sessions } = harness();
  seedCompleted(sessions);
  const refused = graphErr('auth', 0);
  fb.on(isFinish, fbErr(refused));

  const err = await finishVideoUpload(deps, { uploadSessionId: SESSION_ID }).catch(
    (e: unknown) => e,
  );

  assert.equal(err, refused);
});

test('an unclassified finish fault with no HTTP status still names the video id', async () => {
  // Regression guard for the narrowed rule: no action at all means nothing is
  // known about whether it was sent, so the video id guidance stays.
  const { fb, deps, sessions } = harness();
  seedCompleted(sessions);
  fb.on(isFinish, fbErr(new GraphApiError('socket closed', { code: 0, httpStatus: 0 })));

  const err = asGraphError(
    await finishVideoUpload(deps, { uploadSessionId: SESSION_ID }).catch(
      (e: unknown) => e,
    ),
  );
  assert.match(err.action?.operatorText ?? '', new RegExp(`video '${VIDEO_ID}'`));
  assert.equal(err.action?.nextTool, 'facebook_get_video_status');
});

test('finishVideoUpload refuses an incomplete transfer without a wire call', async () => {
  const { fb, deps, sessions } = harness();
  sessions.create({
    uploadSessionId: SESSION_ID,
    pageId: PAGE_ID,
    totalBytes: TOTAL,
    chunkSize: MIN_CHUNK_SIZE,
    startOffset: 4,
  });

  const err = asGraphError(
    await finishVideoUpload(deps, { uploadSessionId: SESSION_ID }).catch(
      (e: unknown) => e,
    ),
  );

  assert.equal(err.action?.category, 'validation');
  assert.match(err.message, /only 4 of 12 byte\(s\) transferred/);
  assert.equal(fb.calls.length, 0);
});

test('finishVideoUpload on an unknown session says restart the upload', async () => {
  const { fb, deps } = harness();

  const err = asGraphError(
    await finishVideoUpload(deps, { uploadSessionId: 'gone' }).catch((e: unknown) => e),
  );

  assert.equal(err.action?.operatorText, SESSION_LOST_NOTE);
  assert.equal(fb.calls.length, 0);
});

test('finish hands back the video id even if the session expires mid-call (CC-MEDIA-3)', async () => {
  const h = harness({ ttlMs: 1_000 });
  seedCompleted(h.sessions);
  h.fb.on(isFinish, fbOk({ video_id: VIDEO_ID, success: true }));

  // The session is live when `finish` starts and evicted by the time the edge
  // answers: the call itself straddles the TTL boundary. The video is created,
  // so telling the caller to restart the upload would duplicate it.
  const deps: VideoUploadDeps = {
    ...h.deps,
    fbRequest: <T = unknown>(req: FbRequest): Promise<FbResponse<T>> => {
      h.clock.advance(2_000);
      return h.deps.fbRequest<T>(req);
    },
  };

  const res = await finishVideoUpload(deps, { uploadSessionId: SESSION_ID });

  assert.equal(res.videoId, VIDEO_ID);
  assert.equal(res.uploadSessionId, SESSION_ID);
  assert.equal(res.totalBytes, TOTAL);
  assert.equal(res.success, true);
  assert.equal(res.note, CREATED_NOT_READY_NOTE);
  assert.equal(h.sessions.get(SESSION_ID), undefined, 'the record really was evicted');
});

test('finishVideoUpload reports a desync when no video id can be determined', async () => {
  const { fb, deps, sessions } = harness();
  sessions.create({
    uploadSessionId: SESSION_ID,
    pageId: PAGE_ID,
    totalBytes: TOTAL,
    chunkSize: MIN_CHUNK_SIZE,
    startOffset: TOTAL,
  });
  fb.on(isFinish, fbOk({ success: true }));

  const err = asGraphError(
    await finishVideoUpload(deps, { uploadSessionId: SESSION_ID }).catch(
      (e: unknown) => e,
    ),
  );

  assert.match(err.message, /finish returned no video id/);
  assert.equal(sessions.get(SESSION_ID)?.phase, 'failed');
});

// ---------------------------------------------------------------------------
// One-call orchestration
// ---------------------------------------------------------------------------

test('uploadVideo runs start, transfer and finish and reports the bytes sent', async () => {
  const { fb, deps } = harness();
  fb.on(isStart, fbOk(startBody(4)));
  fb.on(isChunk, fbOk(chunkBody(4, 8)), 1);
  fb.on(isChunk, fbOk(chunkBody(8, 12)), 1);
  fb.on(isChunk, fbOk(chunkBody(12)), 1);
  fb.on(isFinish, fbOk({ success: true, video_id: VIDEO_ID }));
  const seen: number[] = [];

  const result = await uploadVideo(deps, {
    pageId: PAGE_ID,
    data: bytes(TOTAL),
    description: 'hello',
    onProgress: (sent) => seen.push(sent),
  });

  assert.equal(result.videoId, VIDEO_ID);
  assert.equal(result.bytesSent, TOTAL);
  assert.equal(result.totalBytes, TOTAL);
  assert.equal(result.note, CREATED_NOT_READY_NOTE);
  assert.deepEqual(seen, [4, 8, 12]);
  assert.deepEqual(
    fb.calls.map((c) => c.protocol),
    ['json', 'rupload', 'rupload', 'rupload', 'json'],
  );
  assert.equal(bodyOf(fb.lastRequest())['description'], 'hello');
});

test('uploadVideo derives the file size from the buffer and stops at the first failure', async () => {
  const { fb, deps } = harness();
  fb.on(isStart, fbOk(startBody(TOTAL)));
  fb.on(isChunk, fbErr(graphErr('permission', 403)));

  await assert.rejects(uploadVideo(deps, { pageId: PAGE_ID, data: bytes(TOTAL) }));

  assert.equal(bodyOf(fb.calls[0])['file_size'], TOTAL);
  assert.equal(
    fb.calls.filter(isFinish).length,
    0,
    'finish never runs after a failed transfer',
  );
});

test('uploadVideo refuses an empty buffer before opening a session', async () => {
  const { fb, deps, sessions } = harness();

  const err = asGraphError(
    await uploadVideo(deps, { pageId: PAGE_ID, data: bytes(0) }).catch((e: unknown) => e),
  );

  assert.equal(err.action?.category, 'validation');
  assert.equal(err.action?.retryable, false);
  assert.match(err.message, /totalBytes must be a positive integer \(got 0\)/);
  assert.equal(fb.calls.length, 0, 'nothing reaches the wire');
  assert.equal(sessions.size(), 0, 'no session is leaked into the registry');
});

test('every phase and the resume probe carry the caller token, timeout and signal', async () => {
  // The api layer resolves nothing itself: whatever scope the tools layer passes
  // must ride on all four request kinds, or a page-scoped upload silently uses
  // the wrong token halfway through.
  const { fb, deps } = harness();
  const signal = new AbortController().signal;
  fb.enqueue(fbOk(startBody(4)));
  fb.enqueue(fbErr(graphErr('transient', 503)));
  fb.enqueue(fbOk(statusUploading(4)));
  fb.enqueue(fbOk(chunkBody(TOTAL)));
  fb.enqueue(fbOk({ success: true, video_id: VIDEO_ID }));

  await uploadVideo(deps, {
    pageId: PAGE_ID,
    data: bytes(TOTAL),
    token: 'page-token',
    timeoutMs: 1_234,
    signal,
  });

  assert.deepEqual(
    fb.calls.map((c) => c.protocol),
    ['json', 'rupload', 'json', 'rupload', 'json'],
    'start, failed chunk, offset probe, resumed chunk, finish',
  );
  for (const call of fb.calls) {
    assert.equal(
      call.token,
      'page-token',
      `${call.method} ${call.path} carries the token`,
    );
    assert.equal(call.timeoutMs, 1_234);
    assert.equal(call.signal, signal);
    assert.equal(call.pageId, PAGE_ID, 'every call stays attributed to the page');
  }
});

// ---------------------------------------------------------------------------
// Status probe (CC-MEDIA-7) — finished is not published
// ---------------------------------------------------------------------------

test('mapVideoStatus maps an in-flight upload to `uploading`', () => {
  const status = mapVideoStatus(VIDEO_ID, statusUploading(42));

  assert.equal(status.kind, 'uploading');
  assert.equal(status.videoId, VIDEO_ID);
  assert.equal(status.kind === 'uploading' ? status.bytesTransferred : undefined, 42);
  assert.equal(status.note, STATUS_NOTES.uploading);
});

test('mapVideoStatus maps a not-yet-started upload to `uploading`', () => {
  const status = mapVideoStatus(VIDEO_ID, {
    status: { uploading_phase: { status: 'not_started' } },
  });

  assert.equal(status.kind, 'uploading');
  assert.equal(status.kind === 'uploading' ? status.bytesTransferred : 0, undefined);
});

test('mapVideoStatus maps transcoding to `processing`', () => {
  const status = mapVideoStatus(VIDEO_ID, {
    status: {
      video_status: 'processing',
      uploading_phase: { status: 'complete' },
      processing_phase: { status: 'in_progress' },
    },
  });

  assert.equal(status.kind, 'processing');
  assert.equal(status.note, STATUS_NOTES.processing);
});

test('mapVideoStatus maps a finished transcode to `ready` with the publishing status', () => {
  const status = mapVideoStatus(VIDEO_ID, {
    status: {
      video_status: 'ready',
      uploading_phase: { status: 'complete' },
      processing_phase: { status: 'complete' },
      publishing_phase: { status: 'complete', publish_status: 'published' },
    },
  });

  assert.equal(status.kind, 'ready');
  assert.equal(status.kind === 'ready' ? status.publishStatus : undefined, 'published');
  assert.equal(status.note, STATUS_NOTES.ready);
});

test('mapVideoStatus treats a complete processing phase alone as `ready`', () => {
  const status = mapVideoStatus(VIDEO_ID, {
    status: { processing_phase: { status: 'complete' } },
  });

  assert.equal(status.kind, 'ready');
  assert.equal(status.kind === 'ready' ? status.publishStatus : 'x', undefined);
});

test('mapVideoStatus maps a failed phase to `error` with its message', () => {
  const status = mapVideoStatus(VIDEO_ID, {
    status: {
      video_status: 'error',
      processing_phase: { status: 'error', errors: [{ message: 'unsupported codec' }] },
    },
  });

  assert.equal(status.kind, 'error');
  assert.equal(status.kind === 'error' ? status.message : '', 'unsupported codec');
  assert.equal(status.note, STATUS_NOTES.error);
});

test('mapVideoStatus lets an error in any phase win over a ready video_status', () => {
  const status = mapVideoStatus(VIDEO_ID, {
    status: {
      video_status: 'ready',
      processing_phase: { status: 'error', error: { message: 'transcode failed' } },
    },
  });

  assert.equal(status.kind, 'error');
  assert.equal(status.kind === 'error' ? status.message : '', 'transcode failed');
});

test('mapVideoStatus falls back to a generic message for an error with no detail', () => {
  const status = mapVideoStatus(VIDEO_ID, { status: { video_status: 'upload_failed' } });

  assert.equal(status.kind, 'error');
  assert.match(status.kind === 'error' ? status.message : '', /failed/);
});

test('mapVideoStatus maps an expired video to a terminal error, never to "poll again"', () => {
  // `expired` is a dead end: Meta discarded the video. Reporting it as
  // `processing` tells the caller to poll a node that will never become ready.
  const status = mapVideoStatus(VIDEO_ID, {
    id: VIDEO_ID,
    status: { video_status: 'expired' },
  });

  assert.equal(status.kind, 'error');
  assert.match(status.kind === 'error' ? status.message : '', /expired/);
  assert.equal(status.note, STATUS_NOTES.error);
});

test('mapVideoStatus defaults an absent or unusable status to `processing`, never ready', () => {
  for (const raw of [{ id: VIDEO_ID }, {}, null, undefined, 'ready', 42, []]) {
    const status = mapVideoStatus(VIDEO_ID, raw);
    assert.equal(status.kind, 'processing', `raw=${JSON.stringify(raw)}`);
    assert.equal(status.note, STATUS_NOTES.unknown);
  }
});

test('mapVideoStatus never claims "still processing" for a status it does not recognize', () => {
  // `STATUS_NOTES.unknown` exists for exactly this case. A status object that
  // carries nothing this module understands — an empty one, or a video_status
  // Meta added later — is not evidence of transcoding, so the note must not
  // assert it.
  for (const raw of [
    { status: {} },
    { status: { video_status: 'quarantined' } },
    { status: { video_status: 'quarantined', uploading_phase: {} } },
  ]) {
    const status = mapVideoStatus(VIDEO_ID, raw);
    assert.equal(status.kind, 'processing', `raw=${JSON.stringify(raw)}: poll again`);
    assert.equal(status.note, STATUS_NOTES.unknown, `raw=${JSON.stringify(raw)}`);
  }
});

test('mapVideoStatus keeps the processing note when the payload says it is processing', () => {
  for (const raw of [
    { status: { video_status: 'processing' } },
    { status: { processing_phase: { status: 'in_progress' } } },
    { status: { processing_phase: { status: 'not_started' } } },
    { status: { uploading_phase: { status: 'complete' } } },
  ]) {
    const status = mapVideoStatus(VIDEO_ID, raw);
    assert.equal(status.kind, 'processing', `raw=${JSON.stringify(raw)}`);
    assert.equal(status.note, STATUS_NOTES.processing, `raw=${JSON.stringify(raw)}`);
  }
});

test('mapVideoStatus reads the legacy `{ status: "ready" }` string shape as unknown, never ready (CC-NET-2)', () => {
  // The old node shape carried `status` as a bare string. It is not the
  // `{ video_status }` object the poller trusts, so it must not mint `ready`.
  const status = mapVideoStatus(VIDEO_ID, { id: VIDEO_ID, status: 'ready' });

  assert.equal(status.kind, 'processing');
  assert.equal(status.note, STATUS_NOTES.unknown);
});

test('mapVideoStatus accepts a bare status object as well as a full node body', () => {
  assert.equal(mapVideoStatus(VIDEO_ID, { video_status: 'ready' }).kind, 'ready');
  assert.equal(
    mapVideoStatus(VIDEO_ID, { uploading_phase: { status: 'in_progress' } }).kind,
    'uploading',
  );
});

test('getVideoStatus reads /{video-id}?fields=status on the graph host', async () => {
  const { fb, deps } = harness();
  fb.on(isProbe, fbOk(statusUploading(7)));

  const status = await getVideoStatus(deps, { videoId: VIDEO_ID, pageId: PAGE_ID });

  const req = jsonOf(fb.lastRequest());
  assert.equal(req.method, 'GET');
  assert.equal(req.host, 'graph');
  assert.equal(req.path, `/${VIDEO_ID}`);
  assert.deepEqual(req.params, { fields: VIDEO_STATUS_FIELDS });
  assert.equal(req.pageId, PAGE_ID);
  assert.equal(status.kind, 'uploading');
});

test('getVideoStatus rejects an empty video id without a wire call', async () => {
  const { fb, deps } = harness();

  const err = asGraphError(
    await getVideoStatus(deps, { videoId: ' ' }).catch((e: unknown) => e),
  );
  assert.match(err.message, /videoId is required/);
  assert.equal(fb.calls.length, 0);
});

test('getVideoStatus lets a wire error propagate', async () => {
  const { fb, deps } = harness();
  const fault = graphErr('auth', 401);
  fb.on(isProbe, fbErr(fault));

  assert.equal(
    await getVideoStatus(deps, { videoId: VIDEO_ID }).catch((e: unknown) => e),
    fault,
  );
});

test('readUploadOffset returns the server byte count and swallows probe failures', async () => {
  const { fb, deps } = harness();
  fb.on(isProbe, fbOk(statusUploading(9)), 1);
  assert.equal(await readUploadOffset(deps, { videoId: VIDEO_ID }), 9);

  fb.on(isProbe, fbErr(graphErr('transient', 500)), 1);
  assert.equal(await readUploadOffset(deps, { videoId: VIDEO_ID }), undefined);

  fb.on(isProbe, fbOk({ status: { video_status: 'ready' } }), 1);
  assert.equal(await readUploadOffset(deps, { videoId: VIDEO_ID }), undefined);
});

// ---------------------------------------------------------------------------
// Resumability classification
// ---------------------------------------------------------------------------

test('isResumableUploadError only accepts transient and ambiguous faults', () => {
  assert.equal(isResumableUploadError(graphErr('transient', 500)), true);
  assert.equal(isResumableUploadError(graphErr('ambiguous', 500)), true);
  for (const category of ['auth', 'permission', 'validation', 'not_found'] as const) {
    assert.equal(isResumableUploadError(graphErr(category, 400)), false, category);
  }
});

test('isResumableUploadError falls back to the HTTP status when no action was attached', () => {
  const noAction = (httpStatus: number): GraphApiError =>
    new GraphApiError('raw', { code: 0, httpStatus });

  assert.equal(isResumableUploadError(noAction(503)), true);
  assert.equal(isResumableUploadError(noAction(500)), true);
  assert.equal(isResumableUploadError(noAction(400)), false);
  assert.equal(isResumableUploadError(new Error('boom')), false);
  assert.equal(isResumableUploadError('boom'), false);
  assert.equal(isResumableUploadError(undefined), false);
});

// ---------------------------------------------------------------------------
// Verify tools (C2): name a read only when the caller holds the id it needs
// ---------------------------------------------------------------------------

test('start names no verify tool: a lost start answer leaves the caller no id to verify with', async () => {
  // Regression: `start` creates no post and hands back the only ids there are.
  // A lost answer leaves nothing the caller can poll, and no listing shows an
  // empty upload session, so the transport's guidance must stay neutral.
  const { fb, deps } = harness();
  fb.on(isStart, fbOk(startBody(TOTAL)));

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });

  const start = fb.calls.find(isStart);
  assert.ok(start !== undefined);
  assert.equal(start.verifyTool, undefined);
});

test('transfer chunks name facebook_get_video_status as the verify tool once start assigned a video id', async () => {
  const { fb, deps } = harness();
  fb.on(isStart, fbOk(startBody(4)));
  fb.on(isChunk, fbOk(chunkBody(4, 8)), 1);
  fb.on(isChunk, fbOk(chunkBody(8, 12)), 1);
  fb.on(isChunk, fbOk(chunkBody(12)), 1);

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  await transferVideoUpload(deps, { uploadSessionId: SESSION_ID, data: bytes(TOTAL) });

  const chunks = chunksOf(fb);
  assert.equal(chunks.length, 3);
  for (const chunk of chunks) {
    assert.equal(
      chunk.verifyTool,
      'facebook_get_video_status',
      `chunk at ${String(chunk.fileOffset)} names the status read`,
    );
  }
});

test('finish names facebook_get_video_status as the verify tool when start assigned a video id', async () => {
  const { fb, deps, sessions } = harness();
  seedCompleted(sessions);
  fb.on(isFinish, fbOk({ success: true, video_id: VIDEO_ID }));

  await finishVideoUpload(deps, { uploadSessionId: SESSION_ID });

  assert.equal(jsonOf(fb.lastRequest()).verifyTool, 'facebook_get_video_status');
});

test('transfer and finish stay neutral when start assigned no video id', async () => {
  // Regression: facebook_get_video_status needs the id; without one it is not a
  // tool the caller can call, so no verify tool is named.
  const { fb, deps } = harness();
  fb.on(isStart, fbOk(startBody(TOTAL, { video_id: undefined })));
  fb.on(isChunk, fbOk(chunkBody(TOTAL)));
  fb.on(isFinish, fbOk({ success: true, id: VIDEO_ID }));

  await uploadVideo(deps, { pageId: PAGE_ID, data: bytes(TOTAL) });

  for (const call of fb.calls) {
    assert.equal(call.verifyTool, undefined, `${call.method} ${call.path}`);
  }
});

test('retry exhaustion hands the caller facebook_get_video_status as the structured next tool', async () => {
  // The operator text sends the caller to the video status; the structured
  // `nextTool` is what the error record surfaces for the model to act on.
  const { fb, deps } = harness({ maxResumeAttempts: 1 });
  fb.on(isStart, fbOk(startBody(TOTAL)));
  fb.on(isProbe, fbOk(statusUploading(0)));
  fb.on(isChunk, fbErr(graphErr('transient', 500)));

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const err = asGraphError(
    await transferVideoUpload(deps, {
      uploadSessionId: SESSION_ID,
      data: bytes(TOTAL),
    }).catch((e: unknown) => e),
  );

  assert.equal(err.action?.nextTool, 'facebook_get_video_status');
  assert.match(err.action?.operatorText ?? '', /facebook_get_video_status/);
  assert.match(err.action?.operatorText ?? '', new RegExp(`video '${VIDEO_ID}'`));
});

test('a stalled offset that exhausts the budget also names facebook_get_video_status as the next tool', async () => {
  const { fb, deps } = harness({ maxResumeAttempts: 0 });
  fb.on(isStart, fbOk(startBody(TOTAL)));
  fb.on(isChunk, fbOk(chunkBody(0, 0)));

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const err = asGraphError(
    await transferVideoUpload(deps, {
      uploadSessionId: SESSION_ID,
      data: bytes(TOTAL),
    }).catch((e: unknown) => e),
  );

  assert.equal(err.action?.nextTool, 'facebook_get_video_status');
});

test('retry exhaustion without a video id does not send the caller to a status check it cannot run', async () => {
  const { fb, deps } = harness({ maxResumeAttempts: 0 });
  fb.on(isStart, fbOk(startBody(TOTAL, { video_id: undefined })));
  fb.on(isChunk, fbErr(graphErr('transient', 500)));

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const err = asGraphError(
    await transferVideoUpload(deps, {
      uploadSessionId: SESSION_ID,
      data: bytes(TOTAL),
    }).catch((e: unknown) => e),
  );

  assert.equal(err.action?.nextTool, undefined);
  assert.doesNotMatch(
    err.action?.operatorText ?? '',
    /video status/,
    'there is no video id to poll the status of',
  );
  assert.match(err.action?.operatorText ?? '', /no video id/);
});

test('a deferred resume without a video id does not send the caller to a status check it cannot run', async () => {
  const { fb, deps } = harness({ maxResumeAttempts: 3 });
  fb.on(isStart, fbOk(startBody(TOTAL, { video_id: undefined })));
  fb.on(isChunk, fbErr(waitErr(120_000)));

  await startVideoUpload(deps, { pageId: PAGE_ID, totalBytes: TOTAL });
  const err = asGraphError(
    await transferVideoUpload(deps, {
      uploadSessionId: SESSION_ID,
      data: bytes(TOTAL),
    }).catch((e: unknown) => e),
  );

  assert.equal(err.action?.retryAfterMs, 120_000);
  assert.equal(err.action?.nextTool, undefined);
  assert.doesNotMatch(
    err.action?.operatorText ?? '',
    /video status/,
    'there is no video id to poll the status of',
  );
  assert.match(err.action?.operatorText ?? '', /no video id/);
});
