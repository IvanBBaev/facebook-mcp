import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createUploadHandler,
  planRuploadChunks,
  parseFileOffset,
  type UploadHandlerDeps,
} from './http-upload.js';
import { createFbRequest, computeAppSecretProof, createHostSemaphores } from './http.js';
import { GraphApiError } from './index.js';
import type { FbResponse, HostAllowlist, Logger, LogFields, Settings } from './index.js';
import { createFakeClock, createFakeRedactor, type FakeRedactor } from './fakes/index.js';
import { withFetch, type FetchMock } from '../testing/index.js';

// ---------------------------------------------------------------------------
// Test helpers (mirrors src/core/http.test.ts)
// ---------------------------------------------------------------------------

const TOKEN = 'EAAtestTOKENvalue1234567890abcdef';
const APP_SECRET = 'appsecret000102030405060708090a0b';
const HOSTS: HostAllowlist = {
  graph: 'graph.facebook.com',
  graphVideo: 'graph-video.facebook.com',
  rupload: 'rupload.facebook.com',
};

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    appId: '1234567890',
    appSecret: APP_SECRET,
    accessToken: TOKEN,
    profiles: {},
    apiVersion: 'v21.0',
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

function makeDeps(overrides: Partial<UploadHandlerDeps> = {}): UploadHandlerDeps {
  return {
    settings: makeSettings(),
    clock: createFakeClock(),
    redactor: createFakeRedactor(),
    logger: createTestLogger(),
    ...overrides,
  };
}

const PHOTO_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const CHUNK = new Uint8Array([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

// ---------------------------------------------------------------------------
// multipart — FormData, Bearer + appsecret_proof form field, no token in URL
// ---------------------------------------------------------------------------

test('multipart: Bearer auth, appsecret_proof as a form field, files, no token in URL', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      json: { id: 'photo_1' },
      headers: { 'x-app-usage': '{"call_count":1}' },
    });
    const handler = createUploadHandler(makeDeps());

    const res: FbResponse<{ id: string }> = await handler({
      protocol: 'multipart',
      host: 'graph',
      method: 'POST',
      path: '/me/photos',
      fields: { caption: 'hello', published: 'false' },
      files: [
        {
          name: 'source',
          data: PHOTO_BYTES,
          filename: 'pic.jpg',
          contentType: 'image/jpeg',
        },
      ],
    });

    assert.deepEqual(res.data, { id: 'photo_1' });
    assert.equal(res.status, 200);

    const req = mock.lastRequest();
    assert.ok(req);
    assert.equal(req.method, 'POST');
    assert.ok(req.url.startsWith('https://graph.facebook.com/v21.0/me/photos'));
    assert.equal(req.headers['authorization'], `Bearer ${TOKEN}`);
    // Token NEVER in the URL (C3).
    assert.ok(!req.url.includes(TOKEN));
    assert.ok(!req.url.includes('access_token'));

    assert.equal(req.body.kind, 'formData');
    if (req.body.kind === 'formData') {
      assert.equal(req.body.fields['caption'], 'hello');
      assert.equal(req.body.fields['published'], 'false');
      // appsecret_proof rides as a form field, computed as the HMAC (not the token).
      assert.equal(
        req.body.fields['appsecret_proof'],
        computeAppSecretProof(TOKEN, APP_SECRET),
      );
      assert.equal(req.body.files.length, 1);
      const [file] = req.body.files;
      assert.ok(file);
      assert.equal(file.field, 'source');
      assert.equal(file.filename, 'pic.jpg');
      assert.equal(file.contentType, 'image/jpeg');
      assert.deepEqual(file.bytes, PHOTO_BYTES);
    }
  });
});

test('multipart: no appsecret_proof field when appSecret is absent', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ json: { id: 'photo_2' } });
    const handler = createUploadHandler(
      makeDeps({ settings: makeSettings({ appSecret: undefined }) }),
    );

    await handler({
      protocol: 'multipart',
      host: 'graph',
      method: 'POST',
      path: '/me/photos',
      files: [{ name: 'source', data: PHOTO_BYTES }],
    });

    const req = mock.lastRequest();
    assert.ok(req);
    assert.equal(req.body.kind, 'formData');
    if (req.body.kind === 'formData') {
      assert.ok(!('appsecret_proof' in req.body.fields));
    }
  });
});

test('multipart: registers the token with the redactor (C3)', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ json: { id: 'photo_3' } });
    const redactor: FakeRedactor = createFakeRedactor();
    const handler = createUploadHandler(makeDeps({ redactor }));

    await handler({
      protocol: 'multipart',
      host: 'graph',
      method: 'POST',
      path: '/me/photos',
      files: [{ name: 'source', data: PHOTO_BYTES }],
    });

    assert.ok(redactor.secrets.includes(TOKEN));
    assert.ok(redactor.secrets.includes(computeAppSecretProof(TOKEN, APP_SECRET)));
  });
});

test('multipart: terminal 4xx maps to GraphApiError and is NOT retried', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 400, json: { error: { code: 100, message: 'bad param' } } });
    const handler = createUploadHandler(makeDeps());

    await assert.rejects(
      handler({
        protocol: 'multipart',
        host: 'graph',
        method: 'POST',
        path: '/me/photos',
        files: [{ name: 'source', data: PHOTO_BYTES }],
      }),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        assert.equal(err.code, 100);
        return true;
      },
    );
    // One attempt only — a write is never auto-retried.
    assert.equal(mock.requests.length, 1);
  });
});

test('multipart: 5xx is an ambiguous write — NOT retried, verify first (C2)', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 500, text: 'upstream boom' });
    const handler = createUploadHandler(makeDeps());

    await assert.rejects(
      handler({
        protocol: 'multipart',
        host: 'graph',
        method: 'POST',
        path: '/me/photos',
        files: [{ name: 'source', data: PHOTO_BYTES }],
      }),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        assert.equal(err.action?.category, 'ambiguous');
        assert.equal(err.action?.retryable, false);
        return true;
      },
    );
    assert.equal(mock.requests.length, 1);
  });
});

// ---------------------------------------------------------------------------
// rupload — OAuth header auth, file_offset, raw binary body, header passthrough
// ---------------------------------------------------------------------------

test('rupload: Authorization OAuth (not Bearer), file_offset, raw body, header passthrough', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ json: { h: 'upload_handle_abc' } });
    const handler = createUploadHandler(makeDeps());

    const res: FbResponse<{ h: string }> = await handler({
      protocol: 'rupload',
      host: 'rupload',
      method: 'POST',
      path: '/video-id',
      fileOffset: 0,
      chunk: CHUNK,
      headers: { file_size: '10' },
    });

    assert.deepEqual(res.data, { h: 'upload_handle_abc' });
    assert.equal(res.status, 200);

    const req = mock.lastRequest();
    assert.ok(req);
    assert.equal(req.method, 'POST');
    assert.ok(req.url.startsWith('https://rupload.facebook.com/v21.0/video-id'));
    assert.equal(req.headers['authorization'], `OAuth ${TOKEN}`);
    assert.equal(req.headers['file_offset'], '0');
    assert.equal(req.headers['file_size'], '10');
    assert.equal(req.headers['content-type'], 'application/octet-stream');
    assert.ok(!req.url.includes(TOKEN));

    assert.equal(req.body.kind, 'binary');
    if (req.body.kind === 'binary') {
      assert.equal(req.body.byteLength, 10);
      assert.deepEqual(req.body.bytes, CHUNK);
    }
  });
});

// ---------------------------------------------------------------------------
// CC-MEDIA-2 — offset resume (re-read server offset, resend only the tail)
// ---------------------------------------------------------------------------

test('CC-MEDIA-2: 5xx carrying a server file_offset resumes by resending only the tail', async () => {
  await withFetch(async (mock: FetchMock) => {
    // First chunk POST fails 5xx but reports the server got 3 bytes.
    mock.enqueue({ status: 503, headers: { file_offset: '3' } });
    // Resend of the tail succeeds.
    mock.enqueue({ json: { h: 'done' } });
    const handler = createUploadHandler(makeDeps());

    const res: FbResponse<{ h: string }> = await handler({
      protocol: 'rupload',
      host: 'rupload',
      method: 'POST',
      path: '/video-id',
      fileOffset: 0,
      chunk: CHUNK,
    });

    assert.deepEqual(res.data, { h: 'done' });
    assert.equal(mock.requests.length, 2);

    const [, resend] = mock.requests;
    assert.ok(resend);
    assert.equal(resend.headers['file_offset'], '3');
    assert.equal(resend.body.kind, 'binary');
    if (resend.body.kind === 'binary') {
      // Only bytes [3..10) are resent — offset arithmetic is exact.
      assert.equal(resend.body.byteLength, 7);
      assert.deepEqual(resend.body.bytes, new Uint8Array([13, 14, 15, 16, 17, 18, 19]));
    }
  });
});

test('CC-MEDIA-2: 5xx without an offset probes the server (GET OAuth) then resumes', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 500, text: 'transient' }); // chunk POST fails, no offset
    mock.enqueue({ headers: { file_offset: '4' } }); // probe GET reports offset 4
    mock.enqueue({ json: { h: 'done' } }); // resumed tail succeeds
    const handler = createUploadHandler(makeDeps());

    const res: FbResponse<{ h: string }> = await handler({
      protocol: 'rupload',
      host: 'rupload',
      method: 'POST',
      path: '/video-id',
      fileOffset: 0,
      chunk: CHUNK,
    });

    assert.deepEqual(res.data, { h: 'done' });
    assert.equal(mock.requests.length, 3);

    const [, probe, resend] = mock.requests;
    assert.ok(probe && resend);
    // The offset probe is a GET carrying OAuth auth, no body.
    assert.equal(probe.method, 'GET');
    assert.equal(probe.headers['authorization'], `OAuth ${TOKEN}`);
    assert.equal(probe.body.kind, 'none');
    // Resume resends bytes [4..10).
    assert.equal(resend.headers['file_offset'], '4');
    assert.equal(resend.body.kind, 'binary');
    if (resend.body.kind === 'binary') {
      assert.equal(resend.body.byteLength, 6);
      assert.deepEqual(resend.body.bytes, new Uint8Array([14, 15, 16, 17, 18, 19]));
    }
  });
});

test('CC-MEDIA-2: a server offset outside the chunk window refuses to resume (restart)', async () => {
  await withFetch(async (mock: FetchMock) => {
    // Server reports offset 20, but this 10-byte chunk covers [0, 10).
    mock.enqueue({ status: 503, headers: { file_offset: '20' } });
    const handler = createUploadHandler(makeDeps());

    await assert.rejects(
      handler({
        protocol: 'rupload',
        host: 'rupload',
        method: 'POST',
        path: '/video-id',
        fileOffset: 0,
        chunk: CHUNK,
      }),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        assert.match(err.message, /restart|cannot resume/i);
        return true;
      },
    );
    // No blind resend of a chunk we cannot align.
    assert.equal(mock.requests.length, 1);
  });
});

test('rupload: 4xx terminal error is mapped and NOT resumed', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 400, json: { error: { code: 190, message: 'bad token' } } });
    const handler = createUploadHandler(makeDeps());

    await assert.rejects(
      handler({
        protocol: 'rupload',
        host: 'rupload',
        method: 'POST',
        path: '/video-id',
        fileOffset: 0,
        chunk: CHUNK,
      }),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        assert.equal(err.code, 190);
        return true;
      },
    );
    assert.equal(mock.requests.length, 1);
  });
});

test('rupload: chunk POSTs bypass the generic retry matrix (maxResumeAttempts 0 ⇒ no resume)', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 503, headers: { file_offset: '3' } });
    const handler = createUploadHandler(makeDeps({ maxResumeAttempts: 0 }));

    await assert.rejects(
      handler({
        protocol: 'rupload',
        host: 'rupload',
        method: 'POST',
        path: '/video-id',
        fileOffset: 0,
        chunk: CHUNK,
      }),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        return true;
      },
    );
    // Bound is 0 ⇒ a single attempt, never a generic-matrix retry loop.
    assert.equal(mock.requests.length, 1);
  });
});

// ---------------------------------------------------------------------------
// CC-MEDIA-3 — buffered chunking (planRuploadChunks) offset arithmetic
// ---------------------------------------------------------------------------

test('CC-MEDIA-3: planRuploadChunks splits with exact offsets and reassembles', () => {
  const data = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const plans = planRuploadChunks(data, 4);

  assert.equal(plans.length, 3);
  assert.deepEqual(
    plans.map((p) => p.fileOffset),
    [0, 4, 8],
  );
  assert.deepEqual(
    plans.map((p) => p.chunk.byteLength),
    [4, 4, 2],
  );
  assert.deepEqual(
    plans.map((p) => p.isLast),
    [false, false, true],
  );

  // Reassembly reconstructs the original buffer exactly.
  const reassembled = new Uint8Array(data.byteLength);
  for (const p of plans) {
    reassembled.set(p.chunk, p.fileOffset);
  }
  assert.deepEqual(reassembled, data);
});

test('CC-MEDIA-3: a chunkSize ≥ length yields one chunk; an empty buffer yields none', () => {
  const data = new Uint8Array([1, 2, 3]);
  const single = planRuploadChunks(data, 8);
  assert.equal(single.length, 1);
  assert.ok(single[0]);
  assert.equal(single[0].fileOffset, 0);
  assert.equal(single[0].isLast, true);
  assert.deepEqual(single[0].chunk, data);

  assert.deepEqual(planRuploadChunks(new Uint8Array(0), 4), []);
});

test('CC-MEDIA-3: a non-positive chunkSize is rejected', () => {
  assert.throws(() => planRuploadChunks(new Uint8Array([1]), 0), /positive integer/);
  assert.throws(() => planRuploadChunks(new Uint8Array([1]), -3), /positive integer/);
});

// ---------------------------------------------------------------------------
// parseFileOffset — defensive offset reader (header + body)
// ---------------------------------------------------------------------------

test('parseFileOffset: reads header, then body, and rejects malformed values', () => {
  assert.equal(parseFileOffset({ file_offset: '42' }), 42);
  assert.equal(parseFileOffset({ 'upload-offset': '7' }), 7);
  assert.equal(parseFileOffset({}, JSON.stringify({ start_offset: 5 })), 5);
  assert.equal(parseFileOffset({}, JSON.stringify({ file_offset: 9 })), 9);
  assert.equal(parseFileOffset({ file_offset: 'nope' }), undefined);
  assert.equal(parseFileOffset({ file_offset: '-1' }), undefined);
  assert.equal(parseFileOffset({}), undefined);
  assert.equal(parseFileOffset({}, 'not json'), undefined);
});

// ---------------------------------------------------------------------------
// Protocol routing + F07 ↔ F08 wiring (shared semaphore handoff)
// ---------------------------------------------------------------------------

test("upload handler rejects protocol 'json' (that is F07's)", async () => {
  const handler = createUploadHandler(makeDeps());
  await assert.rejects(
    handler({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
    /handled by core\/http\.ts \(F07\)/,
  );
});

test('F07 createFbRequest delegates multipart to the F08 uploadHandler over a shared semaphore', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ json: { id: 'photo_wired' } });

    const settings = makeSettings();
    const clock = createFakeClock();
    const redactor = createFakeRedactor();
    const logger = createTestLogger();
    // One per-host budget shared by both clients.
    const semaphores = createHostSemaphores(settings.hostConcurrency);
    const uploadHandler = createUploadHandler({
      settings,
      clock,
      redactor,
      logger,
      semaphores,
    });
    const fbRequest = createFbRequest({
      settings,
      clock,
      redactor,
      logger,
      semaphores,
      uploadHandler,
    });

    const res: FbResponse<{ id: string }> = await fbRequest({
      protocol: 'multipart',
      host: 'graph',
      method: 'POST',
      path: '/me/photos',
      files: [
        {
          name: 'source',
          data: PHOTO_BYTES,
          filename: 'p.jpg',
          contentType: 'image/jpeg',
        },
      ],
    });

    assert.deepEqual(res.data, { id: 'photo_wired' });
    assert.equal(mock.requests.length, 1);
    const req = mock.lastRequest();
    assert.ok(req);
    assert.equal(req.headers['authorization'], `Bearer ${TOKEN}`);
    assert.equal(req.body.kind, 'formData');
  });
});
