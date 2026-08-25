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
import type {
  FbResponse,
  HostAllowlist,
  Logger,
  LogFields,
  MultipartRequest,
  RuploadRequest,
  Settings,
  UsageSnapshot,
} from './index.js';
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

/**
 * Reject the NEXT `fetch` call with `value`, then hand control back to the
 * `withFetch` fake. The fake stands in for a network fault by throwing an
 * `Error` (an unprogrammed request), so a NON-`Error` rejection — what a proxied
 * or polyfilled fetch may raise — has to be programmed by wrapping it.
 * `withFetch` restores the previous global on exit, wrapper included.
 */
function rejectNextFetchWith(value: unknown): void {
  const inner = globalThis.fetch;
  let pending = true;
  globalThis.fetch = async (input, init) => {
    if (pending) {
      pending = false;
      throw value;
    }
    return await inner(input, init);
  };
}

const PHOTO_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const CHUNK = new Uint8Array([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

/**
 * A real rupload path: `/{api-name}/{version}/{id}`, so the version is the SECOND
 * segment — not the first, as it is on a Graph edge path. The `api` layer composes
 * this (or copies it from Meta's `upload_url`); core only validates it.
 */
const RUPLOAD_PATH = '/video-upload/v21.0/video-id';

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

test('CC-NET-7: a multipart redirect is refused, never followed off the host', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 302, headers: { location: 'https://evil.example/steal' } });
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
        assert.match(err.message, /refusing redirect/);
        assert.equal(err.httpStatus, 302);
        assert.equal(err.action?.retryable, false);
        return true;
      },
    );
    // The redirect target is never dialled — and it stays undialled only because
    // the client asked for `manual`: with the default `follow`, the platform would
    // have replayed the multipart body to evil.example before this code ever saw
    // a status to refuse.
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.lastRequest()?.redirect, 'manual');
  });
});

test('C2: a lost multipart response (network fault) is ambiguous, never retried', async () => {
  await withFetch(async (mock: FetchMock) => {
    // No programmed response ⇒ the fake rejects, standing in for a mid-flight fault.
    const handler = createUploadHandler(makeDeps());

    await assert.rejects(handler(multipartTo('/me/photos')), (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.equal(err.action?.category, 'ambiguous');
      assert.equal(err.action?.retryable, false);
      assert.equal(err.httpStatus, 0);
      assert.match(err.message, /network fault/);
      return true;
    });
    assert.equal(mock.requests.length, 1);
  });
});

test('multipart: a non-Error network rejection still yields a usable ambiguous error', async () => {
  const faults: readonly { readonly thrown: unknown; readonly detail: RegExp }[] = [
    { thrown: 'socket hang up', detail: /socket hang up/ },
    { thrown: { errno: -54 }, detail: /unknown error/ },
  ];

  for (const fault of faults) {
    await withFetch(async (mock: FetchMock) => {
      rejectNextFetchWith(fault.thrown);
      const handler = createUploadHandler(makeDeps());

      await assert.rejects(handler(multipartTo('/me/photos')), (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        assert.equal(err.action?.category, 'ambiguous');
        // A fault that is not an Error still reads as text, never `[object Object]`.
        assert.match(err.message, fault.detail);
        // The original value rides as the cause for diagnostics.
        assert.equal(err.cause, fault.thrown);
        return true;
      });
      assert.equal(mock.requests.length, 0, 'the wrapper replaced the fetch entirely');
    });
  }
});

test('multipart: an aborted request surfaces the abort, not an ambiguous write', async () => {
  await withFetch(async (mock: FetchMock) => {
    const controller = new AbortController();
    controller.abort();
    // Nothing programmed ⇒ the fake rejects, as a real fetch does once the
    // caller's signal fires.
    const handler = createUploadHandler(makeDeps());

    await assert.rejects(
      handler({ ...multipartTo('/me/photos'), signal: controller.signal }),
      (err: unknown) => {
        // Cancellation is not a lost write: it must not be remapped to `ambiguous`,
        // which would tell the operator to go verify a write that never happened.
        assert.ok(err instanceof Error);
        assert.ok(!(err instanceof GraphApiError));
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
      path: RUPLOAD_PATH,
      fileOffset: 0,
      chunk: CHUNK,
      headers: { file_size: '10' },
    });

    assert.deepEqual(res.data, { h: 'upload_handle_abc' });
    assert.equal(res.status, 200);

    const req = mock.lastRequest();
    assert.ok(req);
    assert.equal(req.method, 'POST');
    assert.equal(req.url, `https://rupload.facebook.com${RUPLOAD_PATH}`);
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
// URL building — the two hosts use two different layouts (CC-NET-7)
// ---------------------------------------------------------------------------

/** POST one chunk/photo and return the URL the handler actually fetched. */
async function urlFor(req: MultipartRequest | RuploadRequest): Promise<string> {
  let url = '';
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ json: {} });
    await createUploadHandler(makeDeps())(req);
    url = mock.lastRequest()?.url ?? '';
  });
  return url;
}

function ruploadTo(path: string): RuploadRequest {
  return {
    protocol: 'rupload',
    host: 'rupload',
    method: 'POST',
    path,
    fileOffset: 0,
    chunk: CHUNK,
  };
}

function multipartTo(path: string): MultipartRequest {
  return { protocol: 'multipart', host: 'graph', method: 'POST', path, files: [] };
}

test('rupload paths pass through verbatim — core never injects an API version', async () => {
  // Prepending the version, as the Graph builder does, would emit
  // `/v21.0/video-upload/v21.0/video-id` — a URL Meta never documented. The api
  // layer owns this layout end to end, either verbatim from Meta's `upload_url`
  // (Reels) or composed from the api-name plus the configured version (video).
  assert.equal(
    await urlFor(ruploadTo(RUPLOAD_PATH)),
    `https://rupload.facebook.com${RUPLOAD_PATH}`,
  );
  assert.equal(
    await urlFor(ruploadTo('video-upload/v21.0/video-id')),
    `https://rupload.facebook.com${RUPLOAD_PATH}`,
    'a missing leading slash is normalised, nothing else',
  );
  assert.equal(
    await urlFor(ruploadTo('/no-version-here')),
    'https://rupload.facebook.com/no-version-here',
    'core does not second-guess the api layer by adding a version',
  );
});

test('multipart paths take the API version as their FIRST segment, added once', async () => {
  assert.equal(
    await urlFor(multipartTo('/page-id/photos')),
    'https://graph.facebook.com/v21.0/page-id/photos',
  );
  assert.equal(
    await urlFor(multipartTo('/v20.0/page-id/photos')),
    'https://graph.facebook.com/v20.0/page-id/photos',
    'a caller-supplied version wins and is never doubled',
  );
});

test('CC-NET-7: an absolute or protocol-relative path cannot redirect off the allowlist', async () => {
  for (const path of ['https://evil.test/x', '//evil.test/x', 'http://evil.test/x']) {
    await assert.rejects(
      () => urlFor(ruploadTo(path)),
      /must be a relative edge path/,
      `rupload accepted '${path}'`,
    );
    await assert.rejects(
      () => urlFor(multipartTo(path)),
      /must be a relative edge path/,
      `multipart accepted '${path}'`,
    );
  }
});

test('CC-NET-7: a traversal segment cannot retarget an upload at another edge', async () => {
  // Upload paths interpolate model-supplied ids (`/{video-id}`,
  // `/{page-id}/photos`) exactly like Graph edges do, and `url.pathname`
  // resolves `..` and `%2e%2e` alike — so containment belongs here too, not only
  // in the JSON builder.
  for (const id of ['../../me/accounts', '%2e%2e/%2E%2e/me/accounts']) {
    await assert.rejects(
      () => urlFor(ruploadTo(`/video-upload/v21.0/${id}`)),
      /would traverse outside its edge/,
      `rupload accepted '${id}'`,
    );
    await assert.rejects(
      () => urlFor(multipartTo(`/${id}/photos`)),
      /would traverse outside its edge/,
      `multipart accepted '${id}'`,
    );
  }
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

test('CC-MEDIA-2: an offset at the chunk end is a transient fault, never a restart', async () => {
  await withFetch(async (mock: FetchMock) => {
    // The server took all 10 bytes and the fault hit on the way back. Nothing is
    // left to resend, but nothing is desynced either: restarting here would
    // discard a chunk the server already holds.
    mock.enqueue({ status: 503, headers: { file_offset: '10' } });
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
        assert.equal(err.action?.category, 'transient');
        assert.equal(err.action?.retryable, true);
        assert.match(err.message, /acknowledged the whole chunk/);
        return true;
      },
    );
    // Nothing is resent — the tail is empty by definition.
    assert.equal(mock.requests.length, 1);
  });
});

test('CC-MEDIA-2: a failing offset probe is classified, not surfaced raw', async () => {
  await withFetch(async (mock: FetchMock) => {
    // The chunk POST 5xxs without an offset, so the handler probes — and the
    // probe hits the same broken transport (no rule matches ⇒ the mock throws).
    mock.enqueue({ status: 503, text: 'boom' });
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
        // Unclassified, this would escape as a bare TypeError: no category, no
        // retry verdict, no operator text for the layers above.
        assert.ok(err instanceof GraphApiError);
        assert.equal(err.action?.category, 'transient');
        assert.match(err.message, /offset probe failed/);
        return true;
      },
    );
    assert.equal(mock.requests.length, 2, 'the chunk POST plus the failed probe');
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

test('CC-MEDIA-2: a network fault probes the server offset and resends only the tail', async () => {
  await withFetch(async (mock: FetchMock) => {
    const logger = createTestLogger();
    let posts = 0;
    // The probe GET answers offset 6. The FIRST chunk POST matches no rule (⇒ the
    // fake rejects, standing in for a mid-flight fault); the resend then succeeds.
    mock.on((r) => r.method === 'GET', { headers: { file_offset: '6' } });
    mock.on(
      (r) => {
        if (r.method !== 'POST') return false;
        posts += 1;
        return posts >= 2;
      },
      { json: { h: 'done' } },
    );
    const handler = createUploadHandler(makeDeps({ logger }));

    const res: FbResponse<{ h: string }> = await handler(ruploadTo('/video-id'));

    assert.deepEqual(res.data, { h: 'done' });
    assert.equal(mock.requests.length, 3);

    const [, probe, resend] = mock.requests;
    assert.ok(probe && resend);
    assert.equal(probe.method, 'GET');
    // Only bytes [6..10) are resent — a chunk is offset-idempotent, never replayed whole.
    assert.equal(resend.headers['file_offset'], '6');
    assert.equal(resend.body.kind, 'binary');
    if (resend.body.kind === 'binary') {
      assert.deepEqual(resend.body.bytes, new Uint8Array([16, 17, 18, 19]));
    }

    const resume = logger.entries.find((e) => e.msg === 'fbRequest.rupload.resume');
    assert.ok(resume);
    assert.equal(resume.level, 'warn');
    assert.equal(resume.fields?.['reason'], 'network');
    assert.equal(resume.fields?.['offset'], 6);
    assert.equal(resume.fields?.['resumes'], 1);
  });
});

test('rupload: past the resume bound a network fault surfaces as a transient fault', async () => {
  await withFetch(async (mock: FetchMock) => {
    // Nothing programmed ⇒ the POST rejects; the bound is 0, so the fault
    // surfaces at once instead of being resumed in-call.
    const handler = createUploadHandler(makeDeps({ maxResumeAttempts: 0 }));

    await assert.rejects(handler(ruploadTo('/video-id')), (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      // Unlike multipart, a chunk is offset-idempotent: re-driving it is SAFE,
      // so the fault is transient/retryable rather than ambiguous.
      assert.equal(err.action?.category, 'transient');
      assert.equal(err.action?.retryable, true);
      assert.match(err.message, /rupload transient fault/);
      return true;
    });
    // No offset probe once the bound is spent — the caller re-drives it.
    assert.equal(mock.requests.length, 1);
  });
});

test('CC-MEDIA-2: no offset in the response nor the probe is a transient fault', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 500, text: 'no offset here' }); // chunk POST fails
    mock.enqueue({ text: 'still no offset' }); // probe GET reports nothing usable
    const handler = createUploadHandler(makeDeps());

    await assert.rejects(handler(ruploadTo('/video-id')), (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.equal(err.action?.category, 'transient');
      assert.equal(err.action?.retryable, true);
      assert.match(err.message, /server offset unavailable/);
      return true;
    });
    // Probed once, then gave up — never a blind resend from the chunk start.
    assert.equal(mock.requests.length, 2);
  });
});

test('CC-NET-7: a rupload redirect is refused, never followed and never resumed', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 307, headers: { location: 'https://evil.example/chunk' } });
    const handler = createUploadHandler(makeDeps());

    await assert.rejects(handler(ruploadTo('/video-id')), (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.match(err.message, /refusing redirect/);
      assert.equal(err.httpStatus, 307);
      assert.equal(err.action?.retryable, false);
      return true;
    });
    // A 3xx is terminal here: no offset probe, no tail resend.
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.lastRequest()?.redirect, 'manual');
  });
});

test('rupload: an aborted request surfaces the abort and never probes for an offset', async () => {
  await withFetch(async (mock: FetchMock) => {
    const controller = new AbortController();
    controller.abort();
    const handler = createUploadHandler(makeDeps());

    await assert.rejects(
      handler({ ...ruploadTo('/video-id'), signal: controller.signal }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(!(err instanceof GraphApiError));
        return true;
      },
    );
    // An aborted upload does not turn into a resume loop.
    assert.equal(mock.requests.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Token resolution + host hardening (C3 / CC-NET-7)
// ---------------------------------------------------------------------------

interface TokenCase {
  readonly label: string;
  readonly settings: Partial<Settings>;
  readonly token?: string;
  readonly expected: string;
}

test('upload token precedence: req.token, then systemToken, accessToken, pageToken', async () => {
  const cases: readonly TokenCase[] = [
    {
      label: 'an explicit req.token wins over every configured token',
      settings: { systemToken: 'system-token-value' },
      token: 'request-token-value',
      expected: 'request-token-value',
    },
    {
      label: 'a system-user token beats the user access token',
      settings: { systemToken: 'system-token-value' },
      expected: 'system-token-value',
    },
    {
      label: 'the Page token is the last resort (C1)',
      settings: { accessToken: undefined, pageToken: 'page-token-value' },
      expected: 'page-token-value',
    },
  ];

  for (const c of cases) {
    await withFetch(async (mock: FetchMock) => {
      mock.enqueue({ json: {} });
      const redactor: FakeRedactor = createFakeRedactor();
      const handler = createUploadHandler(
        makeDeps({ settings: makeSettings(c.settings), redactor }),
      );

      await handler({
        ...multipartTo('/me/photos'),
        ...(c.token !== undefined ? { token: c.token } : {}),
      });

      assert.equal(
        mock.lastRequest()?.headers['authorization'],
        `Bearer ${c.expected}`,
        c.label,
      );
      // Whichever token wins is registered before anything can log it (C3).
      assert.ok(redactor.secrets.includes(c.expected), c.label);
    });
  }
});

test('upload: a missing or empty token fails fast, before any request goes out', async () => {
  await withFetch(async (mock: FetchMock) => {
    const handler = createUploadHandler(
      makeDeps({ settings: makeSettings({ accessToken: undefined }) }),
    );

    await assert.rejects(handler(multipartTo('/me/photos')), /no access token available/);
    await assert.rejects(handler(ruploadTo('/video-id')), /no access token available/);
    // An empty override counts as absent — never sent as a bare `Bearer `.
    await assert.rejects(
      handler({ ...multipartTo('/me/photos'), token: '' }),
      /no access token available/,
    );
    assert.equal(mock.requests.length, 0);
  });
});

test('CC-NET-7: an allowlist hostname carrying a port or a path is refused', async () => {
  await withFetch(async (mock: FetchMock) => {
    // A misconfigured `hosts` entry must not become the URL the client dials:
    // the parsed hostname has to match the configured one exactly.
    const ported = createUploadHandler(
      makeDeps({
        settings: makeSettings({ hosts: { ...HOSTS, graph: 'graph.facebook.com:8443' } }),
      }),
    );
    await assert.rejects(ported(multipartTo('/me/photos')), /refusing off-allowlist URL/);

    const pathed = createUploadHandler(
      makeDeps({
        settings: makeSettings({
          hosts: { ...HOSTS, rupload: 'rupload.facebook.com/evil.example' },
        }),
      }),
    );
    await assert.rejects(pathed(ruploadTo('/video-id')), /refusing off-allowlist URL/);
    assert.equal(mock.requests.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Response decoding + usage accounting (CC-NET-2)
// ---------------------------------------------------------------------------

test('uploads decode an empty body as undefined and a non-JSON body verbatim', async () => {
  await withFetch(async (mock: FetchMock) => {
    const handler = createUploadHandler(makeDeps());

    // A rupload chunk ack is frequently a bodyless 200.
    mock.enqueue({ status: 200 });
    const ack: FbResponse<unknown> = await handler(ruploadTo('/video-id'));
    assert.equal(ack.data, undefined);
    assert.equal(ack.status, 200);

    // A non-JSON body is surfaced as its text, not swallowed.
    mock.enqueue({ status: 201, text: 'plain text ack' });
    const text: FbResponse<unknown> = await handler(multipartTo('/me/photos'));
    assert.equal(text.data, 'plain text ack');
    assert.equal(text.status, 201);
  });
});

test('the onUsage sink is fed by every upload response, the offset probe included', async () => {
  await withFetch(async (mock: FetchMock) => {
    const snapshots: UsageSnapshot[] = [];
    const clock = createFakeClock(1_700);
    mock.enqueue({
      status: 500,
      text: 'transient',
      headers: { 'x-app-usage': '{"call_count":10,"total_time":10,"total_cputime":10}' },
    });
    mock.enqueue({
      headers: {
        file_offset: '5',
        'x-app-usage': '{"call_count":55,"total_time":20,"total_cputime":20}',
      },
    });
    mock.enqueue({
      json: { h: 'done' },
      headers: { 'x-app-usage': '{"call_count":90,"total_time":30,"total_cputime":30}' },
    });
    const handler = createUploadHandler(
      makeDeps({ clock, onUsage: (s) => snapshots.push(s) }),
    );

    const res: FbResponse<{ h: string }> = await handler(ruploadTo('/video-id'));

    assert.deepEqual(res.data, { h: 'done' });
    // The failed chunk POST, the offset probe and the resend all report usage —
    // proactive backoff must not lose the readings taken mid-resume.
    assert.deepEqual(
      snapshots.map((s) => s.appUsagePct),
      [10, 55, 90],
    );
    assert.deepEqual(
      snapshots.map((s) => s.seenAt),
      [1_700, 1_700, 1_700],
    );
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

test('parseFileOffset: a malformed body offset never yields a bogus resume point', () => {
  // Body offsets arrive as JSON numbers, so the numeric guard carries the weight:
  // resuming from a negative or fractional offset would corrupt the upload.
  assert.equal(parseFileOffset({}, JSON.stringify({ file_offset: -1 })), undefined);
  assert.equal(parseFileOffset({}, JSON.stringify({ offset: 3.5 })), undefined);
  assert.equal(parseFileOffset({}, JSON.stringify({ file_offset: null })), undefined);
  // JSON that is not an object carries no offset either.
  assert.equal(parseFileOffset({}, '[0, 1]'), undefined);
  assert.equal(parseFileOffset({}, '7'), undefined);
  // A blank header falls through to the body instead of parsing as 0
  // (`Number(' ') === 0`, which would rewind the upload to the start).
  assert.equal(parseFileOffset({ file_offset: '  ' }, JSON.stringify({ offset: 8 })), 8);
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
