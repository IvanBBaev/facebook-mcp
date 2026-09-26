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
import {
  createFakeClock,
  createFakeRedactor,
  type FakeClock,
  type FakeRedactor,
} from './fakes/index.js';
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

/**
 * A fake clock whose `sleep` advances virtual time by itself and records every
 * wait, so a test that is not ABOUT pacing still runs to completion while the
 * waits it incurred stay assertable (`sleeps`). A test that is about pacing uses
 * a plain `createFakeClock()` and ticks it by hand.
 */
interface AutoClock extends FakeClock {
  readonly sleeps: readonly number[];
}

function createAutoClock(startMs = 0): AutoClock {
  const inner = createFakeClock(startMs);
  const sleeps: number[] = [];
  return {
    ...inner,
    sleeps,
    sleep: async (ms: number, signal?: AbortSignal): Promise<void> => {
      sleeps.push(ms);
      const done = inner.sleep(ms, signal);
      inner.advance(ms);
      await done;
    },
  };
}

function makeDeps(overrides: Partial<UploadHandlerDeps> = {}): UploadHandlerDeps {
  return {
    settings: makeSettings(),
    clock: createAutoClock(),
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

/**
 * Capture every `Response` the `withFetch` fake hands back, so a test can assert
 * what the client did with the body (`bodyUsed`). Call this INSIDE a `withFetch`
 * callback: the fake is the `fetch` being wrapped, and `withFetch` restores the
 * previous global on exit, wrapper included.
 */
function captureResponses(): readonly Response[] {
  const inner = globalThis.fetch;
  const seen: Response[] = [];
  globalThis.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const response = await inner(...args);
    seen.push(response);
    return response;
  };
  return seen;
}

/**
 * Break the NEXT response's body read, leaving the response head intact.
 * `fetch` settles on the HEAD; the body is still arriving over the same
 * connection, so a cut between the two rejects at `response.text()` rather than
 * at `fetch` (undici spells it `TypeError: terminated`). `withFetch` restores
 * the previous global on exit, wrapper included.
 */
function breakNextBodyRead(message: string): void {
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

test('multipart: a 2xx carrying a Graph error envelope is the error, never data', async () => {
  await withFetch(async (mock: FetchMock) => {
    // Graph is known to ship `{error}` inside an HTTP 200 on some paths; the
    // status line is not the verdict (the CC-NET-1 precedent in http.ts).
    mock.enqueue({
      status: 200,
      json: {
        error: { code: 100, type: 'OAuthException', message: 'Invalid parameter' },
      },
    });
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
        assert.equal(err.httpStatus, 200);
        // Graph refused the write — a terminal application error, not ambiguous.
        assert.notEqual(err.action?.category, 'ambiguous');
        return true;
      },
    );
    assert.equal(mock.requests.length, 1);
  });
});

test('multipart: a 2xx whose `error` is not a Graph envelope still passes through as data', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 200, json: { id: '1', error: 'not an envelope' } });
    const handler = createUploadHandler(makeDeps());

    const res = await handler<{ id: string; error: string }>({
      protocol: 'multipart',
      host: 'graph',
      method: 'POST',
      path: '/me/photos',
      files: [{ name: 'source', data: PHOTO_BYTES }],
    });
    assert.deepEqual(res.data, { id: '1', error: 'not an envelope' });
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

test('CC-NET-7: a refused multipart redirect consumes its body, pinning no socket', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 302,
      headers: { location: 'https://evil.example/steal' },
      text: '<html>moved along, nothing to see</html>',
    });
    const seen = captureResponses();
    const handler = createUploadHandler(makeDeps());

    await assert.rejects(handler(multipartTo('/me/photos')), (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.match(err.message, /refusing redirect/);
      return true;
    });
    // `redirect: 'manual'` does NOT hand back an empty opaque-redirect response
    // under Node/undici: the 3xx arrives with a real body, and a body left unread
    // keeps its socket out of the pool. Every other exit here reads the body.
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.bodyUsed, true, 'the refused redirect body was left unread');
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

test('CC-MEDIA-2: a probe Graph REFUSES is surfaced as the refusal, not as a transient resume', async () => {
  await withFetch(async (mock: FetchMock) => {
    const logger = createTestLogger();
    const redactor: FakeRedactor = createFakeRedactor();
    // The chunk POST 5xxs without an offset, so the handler probes — and the
    // probe answers, with a refusal: the token expired or was revoked mid-upload.
    // Graph quotes the credential back in its own message (C3).
    mock.enqueue({ status: 500, text: 'no offset here' });
    mock.enqueue({
      status: 401,
      json: {
        error: {
          code: 190,
          type: 'OAuthException',
          message: `Error validating access token: the session for ${TOKEN} was invalidated`,
        },
      },
    });
    const handler = createUploadHandler(makeDeps({ logger, redactor }));

    await assert.rejects(handler(ruploadTo('/video-id')), (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      // A revoked credential is PERMANENT. Parsed without looking at the status,
      // the 401 body simply yields no offset, and the caller is handed the
      // retryable `server offset unavailable to resume` instead: a resume that
      // can never succeed, driven again and again, with the operator told the
      // server lost its place rather than that their token is gone.
      assert.doesNotMatch(err.message, /server offset unavailable/);
      assert.equal(err.code, 190);
      assert.equal(err.httpStatus, 401);
      assert.equal(err.action?.category, 'auth');
      assert.equal(err.action?.retryable, false);
      assert.match(err.message, /Error validating access token/);
      // Graph quoted the token back; the surfaced error must not (C3).
      assert.ok(!err.message.includes(TOKEN));
      assert.match(err.message, /\[REDACTED\]/);
      return true;
    });
    assert.equal(mock.requests.length, 2, 'the chunk POST plus the refused probe');
    // The Graph error names the cause but not where it came from, so the probe
    // logs the status it refused on.
    const probeLog = logger.entries.find((e) => e.msg === 'fbRequest.rupload.probe');
    assert.ok(probeLog);
    assert.equal(probeLog.level, 'warn');
    assert.equal(probeLog.fields?.['status'], 401);
  });
});

test('CC-MEDIA-2: a probe answering 5xx stays a retryable transient fault', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 500, text: 'no offset here' }); // chunk POST fails
    mock.enqueue({ status: 503, text: 'upstream unavailable' }); // the probe is down too
    const handler = createUploadHandler(makeDeps());

    await assert.rejects(handler(ruploadTo('/video-id')), (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      // Reading the status must not promote a genuinely transient probe to a
      // permanent failure: the verdict is the one it always was, now carrying
      // the status that produced it instead of a bare 0.
      assert.equal(err.action?.category, 'transient');
      assert.equal(err.action?.retryable, true);
      assert.equal(err.httpStatus, 503);
      return true;
    });
    assert.equal(mock.requests.length, 2, 'the chunk POST plus the failed probe');
  });
});

test('CC-MEDIA-2: a probe refused with a Retry-After surfaces that wait', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 500, text: 'no offset here' }); // chunk POST fails
    mock.enqueue({ status: 503, headers: { 'retry-after': '120' }, text: 'maintenance' });
    const handler = createUploadHandler(makeDeps());

    await assert.rejects(handler(ruploadTo('/video-id')), (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.equal(err.action?.category, 'transient');
      assert.equal(err.action?.retryAfterMs, 120_000);
      return true;
    });
    assert.equal(mock.requests.length, 2, 'the chunk POST plus the refused probe');
  });
});

test('CC-MEDIA-2: a 2xx probe still resumes, reading its offset from the body', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 500, text: 'no offset here' }); // chunk POST fails, no offset
    mock.enqueue({ status: 200, json: { file_offset: 4 } }); // probe answers in the BODY
    mock.enqueue({ json: { h: 'done' } }); // resumed tail succeeds
    const handler = createUploadHandler(makeDeps());

    const res: FbResponse<{ h: string }> = await handler(ruploadTo('/video-id'));

    assert.deepEqual(res.data, { h: 'done' });
    assert.equal(mock.requests.length, 3);
    const [, probe, resend] = mock.requests;
    assert.ok(probe && resend);
    assert.equal(probe.method, 'GET');
    // A status check must not cost the body parse: bytes [4..10) are resent.
    assert.equal(resend.headers['file_offset'], '4');
    assert.equal(resend.body.kind, 'binary');
    if (resend.body.kind === 'binary') {
      assert.deepEqual(resend.body.bytes, new Uint8Array([14, 15, 16, 17, 18, 19]));
    }
  });
});

test('CC-NET-1: a 2xx probe whose body is a Graph error envelope is the refusal, never a missing offset', async () => {
  await withFetch(async (mock: FetchMock) => {
    const logger = createTestLogger();
    const redactor: FakeRedactor = createFakeRedactor();
    // The chunk POST 5xxs without an offset, so the handler probes. rupload
    // answers the probe with HTTP 200 whose body is a strict Graph error
    // envelope — the same 2xx-with-envelope shape the chunk POST already
    // treats as a refusal (wave 7). The token is gone; the status lies.
    mock.enqueue({ status: 500, text: 'no offset here' });
    mock.enqueue({
      status: 200,
      json: {
        error: {
          code: 190,
          type: 'OAuthException',
          message: `Error validating access token: the session for ${TOKEN} was invalidated`,
        },
      },
    });
    const handler = createUploadHandler(makeDeps({ logger, redactor }));

    await assert.rejects(handler(ruploadTo('/video-id')), (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      // Read only for an offset, the envelope yields none and the caller is
      // handed the retryable `server offset unavailable to resume`: a permanent
      // refusal laundered into a resume that can never succeed.
      assert.doesNotMatch(err.message, /server offset unavailable/);
      assert.equal(err.code, 190);
      assert.equal(err.httpStatus, 200);
      assert.equal(err.action?.category, 'auth');
      assert.equal(err.action?.retryable, false);
      assert.match(err.message, /Error validating access token/);
      assert.ok(!err.message.includes(TOKEN));
      assert.match(err.message, /\[REDACTED\]/);
      return true;
    });
    assert.equal(mock.requests.length, 2, 'the chunk POST plus the refused probe');
    const probeLog = logger.entries.find((e) => e.msg === 'fbRequest.rupload.probe');
    assert.ok(probeLog, 'the refusing probe is logged with the status that produced it');
    assert.equal(probeLog.level, 'warn');
    assert.equal(probeLog.fields?.['status'], 200);
  });
});

test('CC-NET-7: a redirect answering the offset probe is refused, never read as an offset', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 500, text: 'no offset here' }); // chunk POST fails, no offset
    mock.enqueue({
      status: 302,
      headers: { location: 'https://evil.example/offset' },
      text: '<html>moved along, nothing to see</html>',
    });
    const seen = captureResponses();
    const handler = createUploadHandler(makeDeps());

    await assert.rejects(handler(ruploadTo('/video-id')), (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.match(err.message, /refusing redirect/);
      assert.equal(err.httpStatus, 302);
      assert.equal(err.action?.retryable, false);
      return true;
    });
    assert.equal(mock.requests.length, 2);
    // The refused redirect body is consumed here as it is on the chunk POST, so
    // the socket returns to the pool instead of being pinned.
    assert.equal(
      seen.at(-1)?.bodyUsed,
      true,
      'the refused redirect body was left unread',
    );
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

test('rupload: a 2xx carrying a Graph error envelope is the error, never a landed chunk', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 200,
      json: {
        error: {
          code: 190,
          type: 'OAuthException',
          message: 'Invalid OAuth access token',
        },
      },
    });
    const handler = createUploadHandler(makeDeps());

    await assert.rejects(
      handler({
        protocol: 'rupload',
        host: 'rupload',
        method: 'POST',
        path: RUPLOAD_PATH,
        fileOffset: 0,
        chunk: CHUNK,
      }),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        assert.equal(err.code, 190);
        assert.equal(err.httpStatus, 200);
        return true;
      },
    );
    // Refused, not faulted: no offset probe, no resume.
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

test('C2: a multipart response body lost after a 200 is ambiguous, never surfaced raw', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.on(() => true, { status: 200, json: { id: 'photo-1' } });
    breakNextBodyRead('terminated');
    const handler = createUploadHandler(makeDeps());

    // The worst outcome this module can produce: the photo IS on the Page —
    // Graph answered 200 — and only its id was lost on the way back. Read
    // outside the fault classification above, that rejection escapes as a bare
    // `TypeError`, which every layer above reads as "the upload failed" and
    // which invites a retry that posts the photo twice. It is the same
    // lost-response fault as a mid-flight reset on a multipart write, and it
    // takes the same C2 verdict.
    await assert.rejects(handler(multipartTo('/me/photos')), (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.equal(err.action?.category, 'ambiguous');
      assert.equal(err.action.retryable, false);
      assert.match(err.message, /ambiguous upload outcome/);
      assert.equal(err.httpStatus, 200);
      return true;
    });
    assert.equal(
      mock.requests.length,
      1,
      'an upload Graph already accepted must not re-send',
    );
  });
});

test('CC-MEDIA-2: a chunk response body lost after a 200 resumes from the server offset', async () => {
  await withFetch(async (mock: FetchMock) => {
    // The chunk POST answers 200, then its body dies mid-read. A chunk is
    // offset-idempotent, so this is the same resumable transport fault as a
    // mid-flight reset — not an unclassified crash. The probe settles what
    // actually landed: here the server holds the whole 10-byte chunk, so there
    // is no tail to resend and the caller is told, in a classified error, to
    // move to the next window.
    mock.on((r) => r.method === 'GET', { headers: { file_offset: '10' } });
    mock.on((r) => r.method === 'POST', { status: 200, json: { h: 'done' } });
    breakNextBodyRead('terminated');
    const handler = createUploadHandler(makeDeps());

    await assert.rejects(handler(ruploadTo('/video-id')), (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.equal(err.action?.category, 'transient');
      assert.equal(err.action.retryable, true);
      assert.match(err.message, /acknowledged the whole chunk/);
      return true;
    });
    // The chunk POST, then the offset probe — never a blind replay of the chunk.
    assert.equal(mock.requests.length, 2);
    assert.equal(mock.requests[1]?.method, 'GET');
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

test('CC-NET-7: a refused rupload redirect consumes its body, pinning no socket', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 307,
      headers: { location: 'https://evil.example/chunk' },
      text: '<html>moved along, nothing to see</html>',
    });
    const seen = captureResponses();
    const handler = createUploadHandler(makeDeps());

    await assert.rejects(handler(ruploadTo('/video-id')), (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.match(err.message, /refusing redirect/);
      return true;
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.bodyUsed, true, 'the refused redirect body was left unread');
  });
});

test('regression CC-NET-7/C3: a redirect back onto the allowlisted host is refused too, and the OAuth header travels nowhere', async () => {
  await withFetch(async (mock: FetchMock) => {
    const redactor: FakeRedactor = createFakeRedactor();
    // The Location is on rupload itself — a "safe" looking hop. It is still
    // never followed: the credential rides in `Authorization: OAuth`, and
    // an automatic re-send is exactly what `redirect: 'manual'` forbids.
    mock.enqueue({
      status: 308,
      headers: { location: `https://${HOSTS.rupload}/elsewhere/${TOKEN}` },
      text: '<html>permanent redirect</html>',
    });
    mock.fallback({ json: { h: 'never reached' } });
    const handler = createUploadHandler(makeDeps({ redactor }));

    await assert.rejects(handler(ruploadTo('/video-id')), (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.match(err.message, /refusing redirect/);
      assert.equal(err.httpStatus, 308);
      assert.equal(err.action?.retryable, false);
      // The surfaced text names the host symbolically; neither the Location
      // nor the credential appears in it.
      assert.ok(!err.message.includes(TOKEN));
      assert.ok(!err.message.includes('/elsewhere/'));
      return true;
    });
    // One request only: the original chunk POST, never the redirected one.
    assert.equal(mock.requests.length, 1);
    const only = mock.lastRequest();
    assert.ok(only);
    assert.equal(only.redirect, 'manual');
    assert.ok(only.url.startsWith(`https://${HOSTS.rupload}/`));
    assert.ok(!only.url.includes('/elsewhere/'));
    assert.equal(only.headers['authorization'], `OAuth ${TOKEN}`);
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

test('CC-NET-2: a throwing onUsage sink cannot fail an upload whose bytes landed', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      json: { id: 'photo_1' },
      headers: { 'x-app-usage': '{"call_count":5,"total_time":5,"total_cputime":5}' },
    });
    const logger = createTestLogger();
    const handler = createUploadHandler(
      makeDeps({
        logger,
        onUsage: () => {
          throw new Error('usage sink exploded');
        },
      }),
    );

    // The sink is ADVISORY. The photo is already on Meta's side by the time the
    // headers are parsed; a metrics handler that throws must not turn a landed
    // write into a caller-visible failure it would then have to verify.
    const res: FbResponse<{ id: string }> = await handler({
      protocol: 'multipart',
      host: 'graph',
      method: 'POST',
      path: '/me/photos',
      files: [{ name: 'source', data: PHOTO_BYTES }],
    });

    assert.deepEqual(res.data, { id: 'photo_1' });
    const warned = logger.entries.find((e) => /usage sink threw/.test(e.msg));
    assert.ok(warned, 'a contained sink failure must still be visible in the log');
    assert.equal(warned.level, 'warn');
  });
});

test('CC-NET-2: a throwing onUsage sink is never reported as a failed offset probe', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 500, text: 'transient' }); // chunk POST fails, no offset
    mock.enqueue({ headers: { file_offset: '6' } }); // the probe answers
    mock.enqueue({ json: { h: 'done' } }); // the resent tail succeeds
    const logger = createTestLogger();
    let sinkCalls = 0;
    const handler = createUploadHandler(
      makeDeps({
        logger,
        onUsage: () => {
          sinkCalls += 1;
          // Throw on the OFFSET PROBE's response only. That `feedUsage` call sits
          // inside the try that classifies probe failures as transport faults, so
          // an unguarded sink turns into a transient `offset probe failed` — an
          // error naming a cause that never happened, for a probe that answered.
          if (sinkCalls === 2) throw new Error('usage sink exploded');
        },
      }),
    );

    const res: FbResponse<{ h: string }> = await handler(ruploadTo('/video-id'));

    assert.deepEqual(res.data, { h: 'done' });
    // The probe answered and the resume ran on its offset: three calls, not two.
    assert.equal(mock.requests.length, 3);
    assert.equal(sinkCalls, 3);
    const warned = logger.entries.find((e) => /usage sink threw/.test(e.msg));
    assert.ok(warned);
    assert.equal(warned.level, 'warn');
  });
});

test('the onUsage sink is fed by every upload response, the offset probe included', async () => {
  await withFetch(async (mock: FetchMock) => {
    const snapshots: UsageSnapshot[] = [];
    const clock = createAutoClock(1_700);
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
      // The probe and the resend follow the paced 500 ms resend backoff.
      [1_700, 2_200, 2_200],
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

// ---------------------------------------------------------------------------
// Connect-phase faults, strict offset parsing, and the server-requested wait
// ---------------------------------------------------------------------------

test('multipart: a connect-phase fault (upload provably never sent) is a retryable transient, not an ambiguous write', async () => {
  for (const code of [
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
  ]) {
    await withFetch(async () => {
      // undici's shape: a `TypeError: fetch failed` whose `cause` carries the code.
      const thrown = new TypeError('fetch failed', {
        cause: Object.assign(new Error(`connect ${code} graph.facebook.com`), { code }),
      });
      rejectNextFetchWith(thrown);
      const handler = createUploadHandler(makeDeps());

      await assert.rejects(handler(multipartTo('/me/photos')), (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        // No byte left the machine: telling the operator the photo "may have
        // landed — verify first" is false, and makes the api layer report an
        // orphan that cannot exist.
        assert.notEqual(err.action?.category, 'ambiguous', code);
        assert.equal(err.action?.category, 'transient', code);
        assert.equal(err.action?.retryable, true, code);
        assert.equal(err.httpStatus, 0);
        assert.equal(err.cause, thrown);
        return true;
      });
    });
  }

  // A fault after the connection was up (a reset) is still ambiguous (C2).
  await withFetch(async () => {
    rejectNextFetchWith(
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      }),
    );
    const handler = createUploadHandler(makeDeps());
    await assert.rejects(handler(multipartTo('/me/photos')), (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.equal(err.action?.category, 'ambiguous');
      return true;
    });
  });
});

test('upload network faults name the underlying cause, not only undici\'s generic "fetch failed"', async () => {
  // undici rejects every transport fault as `TypeError: fetch failed` and puts
  // the real reason on `cause`; a plain `{ message }` rejection must keep its text.
  for (const [label, thrown, expected] of [
    [
      'undici cause',
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      }),
      /read ECONNRESET/,
    ],
    ['plain object', { message: 'socket hang up' }, /socket hang up/],
  ] as const) {
    for (const req of [multipartTo('/me/photos'), ruploadTo(RUPLOAD_PATH)]) {
      await withFetch(async () => {
        // rupload follows a network fault with an offset probe; fault that
        // too, so the probe's own failure text is what is asserted.
        if (req.protocol === 'rupload') rejectNextFetchWith(thrown);
        rejectNextFetchWith(thrown);
        const handler = createUploadHandler(makeDeps());
        await assert.rejects(handler(req), (err: unknown) => {
          assert.ok(err instanceof GraphApiError, `${label} ${req.protocol}`);
          assert.match(err.message, expected, `${label} ${req.protocol}`);
          return true;
        });
      });
    }
  }
});

test('parseFileOffset: only a plain decimal offset is accepted — hex, exponent, signed or unsafe values never become a resume point', () => {
  // `Number()` reads all of these as integers; none is an offset a server sent.
  for (const raw of ['0x4', '1e1', '+4', '4.0', '0b100', '9007199254740993']) {
    assert.equal(parseFileOffset({ file_offset: raw }), undefined, `header '${raw}'`);
  }
  // A malformed header still falls through to a valid body offset.
  assert.equal(parseFileOffset({ file_offset: '0x4' }, JSON.stringify({ offset: 6 })), 6);
  // A JSON number beyond 2^53 is not an exact byte position.
  assert.equal(parseFileOffset({}, '{"file_offset": 1e300}'), undefined);
  // Plain decimals keep working.
  assert.equal(parseFileOffset({ file_offset: '0' }), 0);
  assert.equal(parseFileOffset({ file_offset: '1048576' }), 1_048_576);
});

test('uploads surface the Retry-After wait the server asked for as retryAfterMs', async () => {
  // rupload throttle (Graph code 4) with an hour-long Retry-After: the matrix
  // default is 60s, and the caller must not be told to come back in a minute.
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 429,
      headers: { 'retry-after': '3600' },
      json: { error: { code: 4, message: 'Application request limit reached' } },
    });
    const handler = createUploadHandler(makeDeps());
    await assert.rejects(handler(ruploadTo(RUPLOAD_PATH)), (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.equal(err.action?.category, 'rate_limit');
      assert.equal(err.action?.retryAfterMs, 3_600_000);
      return true;
    });
    assert.equal(mock.requests.length, 1);
  });

  // rupload 503 past the resume bound: a maintenance window with a named wait.
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 503, headers: { 'retry-after': '90' }, text: 'maintenance' });
    const handler = createUploadHandler(makeDeps({ maxResumeAttempts: 0 }));
    await assert.rejects(handler(ruploadTo(RUPLOAD_PATH)), (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.equal(err.action?.category, 'transient');
      assert.equal(err.action?.retryAfterMs, 90_000);
      return true;
    });
  });

  // multipart throttle: never retried here, so the header is the caller's only clue.
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 429,
      headers: { 'retry-after': '600' },
      json: { error: { code: 4, message: 'Application request limit reached' } },
    });
    const handler = createUploadHandler(makeDeps());
    await assert.rejects(handler(multipartTo('/me/photos')), (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.equal(err.action?.retryAfterMs, 600_000);
      return true;
    });
  });

  // A Retry-After on a non-retryable refusal is not attached to it.
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 400,
      headers: { 'retry-after': '600' },
      json: { error: { code: 100, message: 'bad param' } },
    });
    const handler = createUploadHandler(makeDeps());
    await assert.rejects(handler(multipartTo('/me/photos')), (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.equal(err.action?.retryAfterMs, undefined);
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// Wave 16 — connect-phase precedence and paced rupload 5xx resends
// ---------------------------------------------------------------------------

test('multipart: an error whose OWN code is a mid-flight reset stays ambiguous even when its cause names a connect-phase code', async () => {
  await withFetch(async () => {
    // The rejection the caller saw is a reset on an established connection; the
    // connect-phase code sits only on a stale `cause` (e.g. an earlier dial on a
    // pooled socket). The error's own code describes this failure, exactly as
    // `isProvablyNotSent` in http.ts reads it for a JSON write.
    const thrown = Object.assign(
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED',
        }),
      }),
      { code: 'ECONNRESET' },
    );
    rejectNextFetchWith(thrown);
    const handler = createUploadHandler(makeDeps());

    await assert.rejects(handler(multipartTo('/me/photos')), (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      // The photo may have landed: "never sent, safe to retry" invites a duplicate.
      assert.equal(err.action?.category, 'ambiguous');
      assert.equal(err.action?.retryable, false);
      assert.doesNotMatch(err.message, /never sent/);
      return true;
    });
  });
});

/** Let the handler run until it parks on a sleep or settles (bounded). */
async function settleOrPark(clock: FakeClock, settled: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !settled() && clock.pendingSleeps() === 0; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test('rupload: a 5xx resend waits a backoff first instead of hammering the server', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 503, headers: { file_offset: '3' } });
    mock.enqueue({ json: { h: 'done' } });
    const clock = createFakeClock();
    const handler = createUploadHandler(makeDeps({ clock }));

    let done = false;
    const pending = handler<{ h: string }>(ruploadTo(RUPLOAD_PATH)).finally(() => {
      done = true;
    });
    await settleOrPark(clock, () => done);

    // The resend has NOT gone out yet: the handler is waiting.
    assert.equal(mock.requests.length, 1, 'resend fired with zero delay');
    assert.equal(clock.pendingSleeps(), 1);

    clock.advance(10_000);
    const res = await pending;
    assert.deepEqual(res.data, { h: 'done' });
    assert.equal(mock.requests.length, 2);
    assert.equal(mock.requests[1]?.headers['file_offset'], '3');
  });
});

test('rupload: a 5xx resend honors the Retry-After the server named', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 503, headers: { file_offset: '3', 'retry-after': '3' } });
    mock.enqueue({ json: { h: 'done' } });
    const clock = createAutoClock();
    const handler = createUploadHandler(makeDeps({ clock }));

    const res: FbResponse<{ h: string }> = await handler(ruploadTo(RUPLOAD_PATH));

    assert.deepEqual(res.data, { h: 'done' });
    assert.deepEqual(clock.sleeps, [3_000]);
  });
});

test('rupload: the resume budget is not burned in milliseconds — successive 5xx resends back off and grow', async () => {
  await withFetch(async (mock: FetchMock) => {
    for (let i = 0; i < 3; i += 1) {
      mock.enqueue({ status: 503, headers: { file_offset: '0' } });
    }
    mock.enqueue({ json: { h: 'done' } });
    const clock = createAutoClock();
    const handler = createUploadHandler(makeDeps({ clock }));

    await handler(ruploadTo(RUPLOAD_PATH));

    assert.equal(clock.sleeps.length, 3);
    for (let i = 1; i < clock.sleeps.length; i += 1) {
      assert.ok(
        (clock.sleeps[i] ?? 0) > (clock.sleeps[i - 1] ?? 0),
        `sleeps not growing: ${clock.sleeps.join(',')}`,
      );
    }
  });
});

test('rupload: a Retry-After longer than the in-call backoff cap surfaces at once with that wait', async () => {
  await withFetch(async (mock: FetchMock) => {
    // An hour-long maintenance window: sleeping through it inside one chunk POST
    // (holding a host slot) is wrong, and resending into it is pointless.
    mock.enqueue({ status: 503, headers: { file_offset: '3', 'retry-after': '3600' } });
    const clock = createAutoClock();
    const handler = createUploadHandler(makeDeps({ clock }));

    await assert.rejects(handler(ruploadTo(RUPLOAD_PATH)), (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.equal(err.action?.retryable, true);
      assert.equal(err.action?.retryAfterMs, 3_600_000);
      return true;
    });
    assert.equal(mock.requests.length, 1, 'no resend into a named hour-long wait');
    assert.deepEqual(clock.sleeps, []);
  });
});

test('rupload: a resend after a network fault waits a backoff first instead of resending at once', async () => {
  await withFetch(async (mock: FetchMock) => {
    let posts = 0;
    // The FIRST chunk POST matches no rule (the fake rejects: a mid-flight
    // fault); the probe answers offset 6; the resend succeeds.
    mock.on((r) => r.method === 'GET', { headers: { file_offset: '6' } });
    mock.on(
      (r) => {
        if (r.method !== 'POST') return false;
        posts += 1;
        return posts >= 2;
      },
      { json: { h: 'done' } },
    );
    const clock = createFakeClock();
    const handler = createUploadHandler(makeDeps({ clock }));

    let done = false;
    const pending = handler<{ h: string }>(ruploadTo(RUPLOAD_PATH)).finally(() => {
      done = true;
    });
    await settleOrPark(clock, () => done);

    // Neither the probe nor the resend has gone out: the handler is waiting.
    assert.equal(mock.requests.length, 1, 'resend fired with zero delay');
    assert.equal(clock.pendingSleeps(), 1);

    clock.advance(10_000);
    const res = await pending;
    assert.deepEqual(res.data, { h: 'done' });
    assert.equal(mock.requests.length, 3);
    assert.equal(mock.requests[1]?.method, 'GET');
    assert.equal(mock.requests[2]?.headers['file_offset'], '6');
  });
});

test('rupload: a resend after a lost response body waits a backoff first', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 200, json: { h: 'lost' } }); // body read breaks
    mock.enqueue({ headers: { file_offset: '3' } }); // probe
    mock.enqueue({ json: { h: 'done' } }); // resend
    breakNextBodyRead('terminated');
    const clock = createFakeClock();
    const handler = createUploadHandler(makeDeps({ clock }));

    let done = false;
    const pending = handler<{ h: string }>(ruploadTo(RUPLOAD_PATH)).finally(() => {
      done = true;
    });
    await settleOrPark(clock, () => done);

    assert.equal(mock.requests.length, 1, 'probe/resend fired with zero delay');
    assert.equal(clock.pendingSleeps(), 1);

    clock.advance(10_000);
    const res = await pending;
    assert.deepEqual(res.data, { h: 'done' });
    assert.equal(mock.requests.length, 3);
    assert.equal(mock.requests[2]?.headers['file_offset'], '3');
  });
});

test('rupload: a flapping link does not burn the resume budget in milliseconds — network-fault resends back off and grow', async () => {
  await withFetch(async (mock: FetchMock) => {
    let posts = 0;
    mock.on((r) => r.method === 'GET', { headers: { file_offset: '0' } });
    mock.on(
      (r) => {
        if (r.method !== 'POST') return false;
        posts += 1;
        return posts >= 4;
      },
      { json: { h: 'done' } },
    );
    const clock = createAutoClock();
    const handler = createUploadHandler(makeDeps({ clock }));

    const res: FbResponse<{ h: string }> = await handler(ruploadTo(RUPLOAD_PATH));

    assert.deepEqual(res.data, { h: 'done' });
    assert.equal(clock.sleeps.length, 3);
    for (let i = 1; i < clock.sleeps.length; i += 1) {
      assert.ok(
        (clock.sleeps[i] ?? 0) > (clock.sleeps[i - 1] ?? 0),
        `sleeps not growing: ${clock.sleeps.join(',')}`,
      );
    }
  });
});

test('rupload: an abort during the network-fault resend wait rejects with AbortError and sends nothing more', async () => {
  await withFetch(async (mock: FetchMock) => {
    // Nothing programmed: every request rejects as a network fault.
    const clock = createFakeClock();
    const controller = new AbortController();
    const handler = createUploadHandler(makeDeps({ clock }));

    let done = false;
    const pending = handler({
      ...ruploadTo(RUPLOAD_PATH),
      signal: controller.signal,
    }).finally(() => {
      done = true;
    });
    await settleOrPark(clock, () => done);
    assert.equal(clock.pendingSleeps(), 1, 'no resend wait to abort');

    controller.abort();
    await assert.rejects(pending, (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!(err instanceof GraphApiError));
      assert.equal(err.name, 'AbortError');
      return true;
    });
    assert.equal(mock.requests.length, 1, 'no probe or resend after the abort');
  });
});

test('regression: a multipart write never waits and never resends — not on a connect-phase fault, not on a 5xx naming a Retry-After', async () => {
  await withFetch(async (mock: FetchMock) => {
    rejectNextFetchWith(
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      }),
    );
    // The rejection above bypasses the fake's request log, so count attempts here.
    let attempts = 0;
    const inner = globalThis.fetch;
    globalThis.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
      attempts += 1;
      return await inner(...args);
    };
    const clock = createAutoClock();
    const handler = createUploadHandler(makeDeps({ clock }));
    await assert.rejects(handler(multipartTo('/me/photos')), (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.equal(err.action?.retryable, true);
      return true;
    });
    assert.deepEqual(clock.sleeps, []);
    assert.equal(attempts, 1);
    assert.equal(mock.requests.length, 0);
  });
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 503, text: 'busy', headers: { 'retry-after': '2' } });
    const clock = createAutoClock();
    const handler = createUploadHandler(makeDeps({ clock }));
    await assert.rejects(handler(multipartTo('/me/photos')), (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.equal(err.action?.category, 'ambiguous');
      return true;
    });
    assert.deepEqual(clock.sleeps, []);
    assert.equal(mock.requests.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Wave 17 — an ambiguous upload names no post-listing verify tool
// ---------------------------------------------------------------------------

test('an ambiguous upload does not point a reel or video caller at facebook_list_posts', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 502, text: 'upstream boom' });
    const handler = createUploadHandler(makeDeps());
    await assert.rejects(handler(multipartTo('/p1/videos')), (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.equal(err.action?.category, 'ambiguous');
      assert.equal(err.action?.nextTool, undefined);
      assert.doesNotMatch(
        err.action?.operatorText ?? '',
        /facebook_list_posts/,
        'a video or reel never shows on the posts listing',
      );
      return true;
    });
  });
});

test('an ambiguous upload names the verify tool the api layer passed', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 502, text: 'upstream boom' });
    const handler = createUploadHandler(makeDeps());
    await assert.rejects(
      handler({ ...multipartTo('/p1/videos'), verifyTool: 'facebook_get_video_status' }),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        assert.equal(err.action?.nextTool, 'facebook_get_video_status');
        assert.match(
          err.action?.operatorText ?? '',
          /verify via facebook_get_video_status first/,
        );
        return true;
      },
    );
  });
});

test('C2: a transient Graph code on a multipart write is ambiguous at any HTTP status, never retryable', async () => {
  // Code 1 / code 2 (and a code Graph flags `is_transient`) are Graph's own
  // 5xx-class faults shipped as HTTP 400 or inside a 200. Surfaced with the
  // matrix's `retryable: true`, a photo that may already be on the Page is an
  // invitation to upload it twice.
  const cases = [
    {
      label: 'code 1 at 400',
      status: 400,
      error: { code: 1, message: 'An unknown error occurred', type: 'OAuthException' },
    },
    {
      label: 'code 2 at 200',
      status: 200,
      error: {
        code: 2,
        message: 'Service temporarily unavailable',
        type: 'OAuthException',
      },
    },
    {
      label: 'is_transient at 400',
      status: 400,
      error: {
        code: 999999,
        message: 'Temporary failure',
        type: 'OAuthException',
        is_transient: true,
      },
    },
  ] as const;
  for (const { label, status, error } of cases) {
    await withFetch(async (mock: FetchMock) => {
      mock.enqueue({ status, json: { error } });
      const handler = createUploadHandler(makeDeps());
      await assert.rejects(
        handler({ ...multipartTo('/p1/photos'), verifyTool: 'facebook_list_photos' }),
        (err: unknown) => {
          assert.ok(err instanceof GraphApiError, label);
          assert.equal(err.action?.category, 'ambiguous', label);
          assert.equal(err.action?.retryable, false, label);
          assert.equal(err.action?.nextTool, 'facebook_list_photos', label);
          assert.equal(err.httpStatus, status, label);
          return true;
        },
      );
      assert.equal(mock.requests.length, 1, label);
    });
  }
});

test('uploads surface the regain-access ETA a business-use-case throttle names in its usage header', async () => {
  // The 80000-80099 envelope carries no ETA; the X-Business-Use-Case-Usage
  // header (MINUTES) is the only statement of the wait. Dropped, the caller of
  // a photo upload blocked for 25 minutes was told to come back in 60s.
  const header = JSON.stringify({
    '111': [
      {
        type: 'pages',
        call_count: 100,
        total_cputime: 30,
        total_time: 40,
        estimated_time_to_regain_access: 25,
      },
    ],
  });
  for (const [label, req] of [
    ['multipart', multipartTo('/me/photos')],
    ['rupload', ruploadTo(RUPLOAD_PATH)],
  ] as const) {
    await withFetch(async (mock: FetchMock) => {
      mock.enqueue({
        status: 400,
        headers: { 'x-business-use-case-usage': header },
        json: {
          error: { code: 80001, type: 'OAuthException', message: 'too many calls' },
        },
      });
      const handler = createUploadHandler(makeDeps());
      await assert.rejects(handler(req), (err: unknown) => {
        assert.ok(err instanceof GraphApiError, label);
        assert.equal(err.action?.category, 'rate_limit', label);
        assert.equal(err.action?.retryAfterMs, 25 * 60_000, label);
        return true;
      });
      assert.equal(mock.requests.length, 1, label);
    });
  }
});
