// Tests for the Graph HTTP client (`core/http.ts`): usage headers, the concurrency
// semaphore, the protocol seam and the response envelope.
//
// Split out of `http.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/http.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFbRequest,
  parseUsageHeaders,
  extractResponseHeaders,
  createHostSemaphores,
  type HostSemaphores,
} from './http.js';
import { GraphApiError } from './index.js';
import type { FbRequest, FbResponse, GraphHost, UsageSnapshot } from './index.js';
import { createFakeClock } from './fakes/index.js';
import { withFetch, type FetchMock } from '../testing/index.js';
import {
  TOKEN,
  createRecordingClock,
  createTestLogger,
  makeDeps,
  settle,
  throttleBody,
} from '../testing/harness/http.js';

// ---------------------------------------------------------------------------
// Usage headers (CC-NET-2)
// ---------------------------------------------------------------------------

test('CC-NET-2: parseUsageHeaders parses valid usage headers and picks the max bucket', () => {
  const snapshot = parseUsageHeaders(
    {
      'x-app-usage': '{"call_count":10,"total_cputime":25,"total_time":12}',
      'x-business-use-case-usage':
        '{"1234":[{"type":"pages","call_count":5,"total_cputime":40,"total_time":8}]}',
      'x-fb-ads-insights-throttle': '{"app_id_util_pct":3,"acc_id_util_pct":7}',
    },
    111,
  );
  assert.equal(snapshot.appUsagePct, 25);
  assert.equal(snapshot.businessUseCasePct, 40);
  assert.equal(snapshot.adsInsightsThrottlePct, 7);
  assert.equal(snapshot.seenAt, 111);
  assert.equal(snapshot.raw['x-app-usage'] !== undefined, true);
});

test('CC-NET-2: malformed and absent usage headers degrade to undefined (no throw)', () => {
  const malformed = parseUsageHeaders({ 'x-app-usage': 'not json {{{' }, 5);
  assert.equal(malformed.appUsagePct, undefined);
  assert.equal(malformed.businessUseCasePct, undefined);

  const absent = parseUsageHeaders({}, 9);
  assert.equal(absent.appUsagePct, undefined);
  assert.deepEqual(absent.raw, {});
  assert.equal(absent.seenAt, 9);
});

test('the onUsage sink receives a snapshot on every response', async () => {
  await withFetch(async (mock: FetchMock) => {
    const snapshots: UsageSnapshot[] = [];
    mock.enqueue({
      json: { id: 'x' },
      headers: { 'x-app-usage': '{"call_count":80,"total_time":80,"total_cputime":80}' },
    });
    const clock = createFakeClock(42);
    const fbRequest = createFbRequest(
      makeDeps({ clock, onUsage: (s) => snapshots.push(s) }),
    );
    const res = await fbRequest({
      protocol: 'json',
      host: 'graph',
      method: 'GET',
      path: '/me',
    });
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.appUsagePct, 80);
    assert.equal(snapshots[0]?.seenAt, 42);
    // The raw usage headers are also on the response envelope.
    assert.ok(res.headers['x-app-usage']);
  });
});

test('CC-NET-2: a throwing onUsage sink cannot fail a request the server answered', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      json: { id: 'me' },
      headers: { 'x-app-usage': '{"call_count":80,"total_time":80,"total_cputime":80}' },
    });
    const logger = createTestLogger();
    const fbRequest = createFbRequest(
      makeDeps({
        logger,
        onUsage: () => {
          throw new Error('usage sink exploded');
        },
      }),
    );

    // The sink is ADVISORY — it exists so an integrator can back off proactively.
    // Usage headers are parsed defensively (CC-NET-2) and the observer fed from
    // them has to be just as defensive: otherwise a bad metrics handler fails
    // live traffic that Graph answered perfectly well.
    const res: FbResponse<{ id: string }> = await fbRequest({
      protocol: 'json',
      host: 'graph',
      method: 'GET',
      path: '/me',
    });

    assert.deepEqual(res.data, { id: 'me' });
    assert.equal(res.status, 200);
    // And it is not mistaken for a transport fault either: no retry.
    assert.equal(mock.requests.length, 1);
    const warned = logger.entries.find((e) => /usage sink threw/.test(e.msg));
    assert.ok(warned, 'a contained sink failure must still be visible in the log');
    assert.equal(warned.level, 'warn');
  });
});

test('extractResponseHeaders lowercases keys', () => {
  const response = new Response('{}', { headers: { 'X-App-Usage': '{}', ETag: 'abc' } });
  const bag = extractResponseHeaders(response);
  assert.equal(bag['x-app-usage'], '{}');
  assert.equal(bag['etag'], 'abc');
});

// ---------------------------------------------------------------------------
// Concurrency semaphore
// ---------------------------------------------------------------------------

test('createHostSemaphores limits concurrency and hands a permit to the next waiter', async () => {
  const sems = createHostSemaphores(1);
  const releaseA = await sems.acquire('graph');
  let bAcquired = false;
  const bPromise = sems.acquire('graph').then((release) => {
    bAcquired = true;
    return release;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bAcquired, false, 'second acquire must wait while the slot is taken');
  releaseA();
  const releaseB = await bPromise;
  assert.equal(bAcquired, true);
  releaseB();
  // A different host has an independent budget.
  const releaseC = await sems.acquire('rupload');
  releaseC();
});

/**
 * Wrap a real semaphore set so the test can see it being used. Counting alone is
 * what makes the injection observable: a client that quietly built its own set
 * would still serve six requests, so "six responses came back" proves nothing
 * about `deps.semaphores`.
 */
function spySemaphores(inner: HostSemaphores): HostSemaphores & {
  readonly acquired: GraphHost[];
  live: number;
  peak: number;
} {
  const spy = {
    acquired: [] as GraphHost[],
    live: 0,
    peak: 0,
    async acquire(host: GraphHost): Promise<() => void> {
      spy.acquired.push(host);
      const release = await inner.acquire(host);
      spy.live += 1;
      spy.peak = Math.max(spy.peak, spy.live);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        spy.live -= 1;
        release();
      };
    },
  };
  return spy;
}

test('every request takes a permit from the INJECTED set and always returns it', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.on(() => true, { status: 200, json: { ok: true } });
    const semaphores = spySemaphores(createHostSemaphores(2));
    const fbRequest = createFbRequest(makeDeps({ semaphores }));
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      ),
    );
    assert.equal(results.length, 6);
    assert.equal(mock.requests.length, 6);

    // The injected set is consulted per request, and under the host it is going
    // to dial — a per-host budget charged to the wrong host throttles nothing.
    assert.equal(semaphores.acquired.length, 6);
    assert.deepEqual([...new Set(semaphores.acquired)], ['graph']);

    // Permits are only a budget if the client waits for them: dropping the
    // `await` on acquire would let all six run at once and push the peak past
    // the limit. (How far past is timing-dependent, so the assertion is the
    // ceiling; that the ceiling BINDS at all is pinned by the unit test above.)
    assert.ok(
      semaphores.peak >= 1 && semaphores.peak <= 2,
      `peak was ${String(semaphores.peak)}`,
    );

    // A permit leaked on the success path deadlocks the next caller rather than
    // failing anything here, so the balance is checked where it is still cheap.
    assert.equal(semaphores.live, 0, 'every permit taken was handed back');
  });
});

test('a request that fails terminally still hands its permit back', async () => {
  await withFetch(async (mock: FetchMock) => {
    // 400 is terminal: no retry, straight to a throw. The release lives in a
    // `finally`, and this is the path that proves it — an early `return` style
    // release would strand the permit and wedge the host for the whole process.
    mock.on(() => true, { status: 400, json: { error: { message: 'bad', code: 100 } } });
    const semaphores = spySemaphores(createHostSemaphores(1));
    const fbRequest = createFbRequest(makeDeps({ semaphores }));

    await assert.rejects(
      fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      GraphApiError,
    );

    assert.equal(semaphores.acquired.length, 1);
    assert.equal(semaphores.live, 0);
    // The single permit is genuinely free again, not merely uncounted.
    (await semaphores.acquire('graph'))();
  });
});

// ---------------------------------------------------------------------------
// Protocol delegation seam (F08)
// ---------------------------------------------------------------------------

test('a non-JSON protocol is delegated to the uploadHandler when provided', async () => {
  const seen: FbRequest[] = [];
  const uploadHandler = <T = unknown>(req: FbRequest): Promise<FbResponse<T>> => {
    seen.push(req);
    return Promise.resolve({ data: { delegated: true } as T, headers: {}, status: 201 });
  };
  const semaphores = spySemaphores(createHostSemaphores(2));
  const fbRequest = createFbRequest(makeDeps({ uploadHandler, semaphores }));
  const request: FbRequest = {
    protocol: 'multipart',
    host: 'graph',
    method: 'POST',
    path: '/me/photos',
    files: [{ name: 'source', data: new Uint8Array([1, 2, 3]) }],
  };
  const res = await fbRequest(request);

  assert.deepEqual(res.data, { delegated: true });
  assert.equal(res.status, 201);
  // Counting the call leaves the seam's actual contract untested: the handler
  // owns the whole request, so it has to arrive intact — a path rewritten or a
  // file part dropped on the way through would still count as one call.
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], request);

  // This host's permits are NOT charged here: uploads run long and the upload
  // client acquires from the same shared set itself, so taking one here too
  // would double-charge — and, at a limit of one, deadlock against itself.
  assert.equal(semaphores.acquired.length, 0);
});

test('a non-JSON protocol without an uploadHandler rejects with a clear error', async () => {
  const fbRequest = createFbRequest(makeDeps());
  await assert.rejects(
    fbRequest({
      protocol: 'rupload',
      host: 'rupload',
      method: 'POST',
      path: '/x',
      fileOffset: 0,
      chunk: new Uint8Array([1]),
    }),
    /http-upload\.ts \(F08\)/,
  );
});

// ---------------------------------------------------------------------------
// Response envelope
// ---------------------------------------------------------------------------

test('a 2xx with an empty body yields data: undefined and the status/headers', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 204 });
    const fbRequest = createFbRequest(makeDeps());
    const res = await fbRequest({
      protocol: 'json',
      host: 'graph',
      method: 'DELETE',
      path: '/123',
    });
    assert.equal(res.data, undefined);
    assert.equal(res.status, 204);
  });
});

// An exhausted retry is the moment the wait the server asked for stops being a
// sleep and becomes the only thing the caller has left to act on.

test('an exhausted throttle surfaces the Retry-After the server sent, not a guess', async () => {
  await withFetch(async (mock: FetchMock) => {
    const clock = createFakeClock();
    mock.on(() => true, {
      status: 429,
      text: 'Too Many Requests',
      headers: { 'retry-after': '300' },
    });
    const fbRequest = createFbRequest(makeDeps({ clock, retry: { maxRetries: 0 } }));
    await assert.rejects(
      settle(
        clock,
        fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      ),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        assert.equal(err.action?.category, 'rate_limit');
        assert.equal(err.action?.retryAfterMs, 300_000);
        return true;
      },
    );
  });
});

test('an exhausted transient surfaces its Retry-After too', async () => {
  await withFetch(async (mock: FetchMock) => {
    const clock = createFakeClock();
    mock.on(() => true, {
      status: 503,
      text: 'Service Unavailable',
      headers: { 'retry-after': '30' },
    });
    const fbRequest = createFbRequest(makeDeps({ clock, retry: { maxRetries: 0 } }));
    await assert.rejects(
      settle(
        clock,
        fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      ),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        assert.equal(err.action?.category, 'transient');
        assert.equal(err.action?.retryAfterMs, 30_000);
        return true;
      },
    );
  });
});

test('a longer envelope ETA still wins over a shorter Retry-After when surfaced', async () => {
  await withFetch(async (mock: FetchMock) => {
    const clock = createFakeClock();
    mock.on(() => true, {
      status: 400,
      json: {
        error: {
          code: 4,
          message: 'Application request limit reached',
          error_data: { estimated_time_to_regain_access: 10 },
        },
      },
      headers: { 'retry-after': '60' },
    });
    const fbRequest = createFbRequest(makeDeps({ clock, retry: { maxRetries: 0 } }));
    await assert.rejects(
      settle(
        clock,
        fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      ),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        assert.equal(err.action?.category, 'rate_limit');
        assert.equal(err.action?.retryAfterMs, 600_000);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// A 2xx that carries a Graph `{error}` envelope is an error, not data
//
// Graph ships application errors inside an HTTP 200 on some paths, the same way
// it ships throttles as HTTP 400 (CC-NET-1): the status line is not the verdict,
// the body is. Returned as `data`, such a body reaches the api layer as a node
// with none of the fields it asked for and degrades into "unconfirmed" outcomes —
// on a write the caller then cannot tell "Graph refused it" from "the wire did
// not say". The envelope is read STRICTLY (a string `message` and a numeric
// `code` or a string `type`) so a legitimate node that merely has an `error`
// field is never misread.
// ---------------------------------------------------------------------------

test('a 2xx carrying a Graph error envelope rejects like the 400 case, not as data', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 200,
      json: {
        error: {
          message: `Unsupported get request. Object with ID '${TOKEN}' does not exist`,
          type: 'GraphMethodException',
          code: 100,
          fbtrace_id: 'Atwohundred',
        },
      },
    });
    const fbRequest = createFbRequest(makeDeps());
    await assert.rejects(
      fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      (err: unknown) => {
        assert.ok(
          err instanceof GraphApiError,
          'a 2xx envelope must reject as a GraphApiError',
        );
        assert.equal(err.code, 100);
        assert.equal(
          err.httpStatus,
          200,
          'the REAL status is surfaced, not a made-up 400',
        );
        assert.equal(err.type, 'GraphMethodException');
        assert.equal(err.fbtraceId, 'Atwohundred');
        // Prefixed with the status line and redacted (C3), exactly like a 400.
        assert.ok(
          err.message.startsWith('Graph API error (HTTP 200): Unsupported get request.'),
          `unexpected message: ${err.message}`,
        );
        assert.ok(!err.message.includes(TOKEN), 'token leaked into the surfaced message');
        assert.ok(err.message.includes('[REDACTED]'), 'the message was not redacted');
        // Classified by the matrix, so the operator gets the row's guidance.
        assert.equal(err.action?.category, 'validation');
        assert.equal(err.action?.retryable, false);
        return true;
      },
    );
    assert.equal(mock.requests.length, 1, 'a terminal envelope is not retried');
  });
});

test('a 2xx throttle envelope backs off and retries, then the second attempt succeeds', async () => {
  await withFetch(async (mock: FetchMock) => {
    const { clock, sleeps } = createRecordingClock();
    // Code 32 is a Page-level throttle; the ETA is 1 MINUTE (CC-NET-3).
    mock.enqueue({ status: 200, json: throttleBody(32, 1) });
    mock.enqueue({ status: 200, json: { id: 'p1' } });

    const fbRequest = createFbRequest(makeDeps({ clock, rng: () => 1 }));
    const res = await settle(
      clock,
      fbRequest<{ id: string }>({
        protocol: 'json',
        host: 'graph',
        method: 'POST',
        path: '/me/feed',
        body: { message: 'x' },
      }),
    );
    assert.deepEqual(res.data, { id: 'p1' });
    assert.equal(res.status, 200);
    assert.equal(mock.requests.length, 2, 'the throttle must be retried exactly once');
    // The wait Graph asked for is honored on a 2xx throttle exactly as on a 400.
    assert.deepEqual(sleeps, [60_000]);
  });
});

test('a 2xx throttle envelope with retries exhausted surfaces rate_limit, never data', async () => {
  await withFetch(async (mock: FetchMock) => {
    const clock = createFakeClock();
    // A 1-minute ETA sits at the 60s sleep cap, so it is retried; a longer one
    // would fail fast before any retry (CC-NET-3) and skip the exhaustion path.
    mock.on(() => true, { status: 200, json: throttleBody(613, 1) });
    const fbRequest = createFbRequest(makeDeps({ clock, retry: { maxRetries: 1 } }));
    await assert.rejects(
      settle(
        clock,
        fbRequest({
          protocol: 'json',
          host: 'graph',
          method: 'POST',
          path: '/me/feed',
          body: { message: 'x' },
        }),
      ),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        assert.equal(err.code, 613);
        assert.equal(err.httpStatus, 200);
        assert.equal(err.action?.category, 'rate_limit');
        assert.equal(err.action?.retryable, false, 'retries are spent');
        assert.equal(err.action?.retryAfterMs, 60_000);
        assert.equal(err.action?.nextTool, 'facebook_usage');
        return true;
      },
    );
    assert.equal(mock.requests.length, 2, 'initial + 1 retry (maxRetries=1)');
  });
});

test('a 2xx terminal envelope on a WRITE is terminal, not ambiguous', async () => {
  // Graph reported an application error, so the mutation was REFUSED: the
  // caller may fix the request and try again. Surfacing it as `ambiguous`
  // ("verify first, do NOT retry") would be the wrong instruction — that
  // verdict is reserved for a write whose outcome the wire genuinely did not
  // report (a 5xx or a lost response, C2).
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 200,
      json: {
        error: {
          message: '(#200) Requires pages_manage_posts permission',
          type: 'OAuthException',
          code: 200,
          fbtrace_id: 'Awrite',
        },
      },
    });
    mock.enqueue({
      status: 200,
      json: {
        error: { message: 'Invalid parameter', type: 'OAuthException', code: 100 },
      },
    });
    const fbRequest = createFbRequest(makeDeps());

    await assert.rejects(
      fbRequest({
        protocol: 'json',
        host: 'graph',
        method: 'POST',
        path: '/me/feed',
        body: { message: 'x' },
      }),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        assert.equal(err.code, 200);
        assert.equal(err.httpStatus, 200);
        assert.notEqual(err.action?.category, 'ambiguous');
        assert.equal(err.action?.category, 'permission');
        assert.equal(err.action?.retryable, false);
        assert.equal(err.action?.nextTool, 'facebook_whoami');
        return true;
      },
    );
    assert.equal(mock.requests.length, 1, 'the write must not be replayed');

    // DELETE is a write too.
    await assert.rejects(
      fbRequest({ protocol: 'json', host: 'graph', method: 'DELETE', path: '/123' }),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        assert.equal(err.code, 100);
        assert.equal(err.httpStatus, 200);
        assert.notEqual(err.action?.category, 'ambiguous');
        assert.equal(err.action?.category, 'validation');
        return true;
      },
    );
    assert.equal(mock.requests.length, 2);
  });
});

test('a 2xx whose body merely mentions an error still passes through as data', async () => {
  // The strict envelope test: anything looser than "a string message AND (a
  // numeric code OR a string type)" is a legitimate node, not a Graph error.
  const bodies: readonly unknown[] = [
    // `error` is a string, not a record.
    { error: 'x' },
    // an `error` record with no `message`.
    { error: { code: 100 } },
    // a `message` but neither an integer `code` nor a string `type`.
    { error: { message: 'x' } },
    { error: { message: 'x', code: 'E100' } },
    // the user-facing fields never make an envelope on their own.
    { error: { message: 'x', error_user_title: 't', error_user_msg: 'm' } },
    { error: { code: 100, error_user_msg: 'm' } },
    // a plain node.
    { id: '1', name: 'n' },
    // `/debug_token` reports an invalid token under `data.error` on a 200.
    { data: { is_valid: false, error: { message: 'Session expired', code: 190 } } },
    // a Graph batch answers with an ARRAY, each entry carrying its own body.
    [{ code: 400, body: '{"error":{"message":"x","type":"OAuthException","code":100}}' }],
  ];
  await withFetch(async (mock: FetchMock) => {
    const fbRequest = createFbRequest(makeDeps());
    for (const body of bodies) {
      mock.enqueue({ status: 200, json: body });
      const res = await fbRequest({
        protocol: 'json',
        host: 'graph',
        method: 'GET',
        path: '/x',
      });
      assert.deepEqual(
        res.data,
        body,
        `body was not passed through: ${JSON.stringify(body)}`,
      );
      assert.equal(res.status, 200);
    }
    assert.equal(mock.requests.length, bodies.length, 'none of these is retried');

    // An empty 2xx body still yields `undefined` data.
    mock.enqueue({ status: 200 });
    const empty = await fbRequest({
      protocol: 'json',
      host: 'graph',
      method: 'GET',
      path: '/x',
    });
    assert.equal(empty.data, undefined);
    assert.equal(empty.status, 200);
  });
});

test('a 2xx whose body is the JSON literal `null` yields data: null, not the string "null"', async () => {
  // `false`, `true` and `0` already pass through as their JSON values; `null`
  // is the one literal a `??` fallback replaces with the raw text.
  await withFetch(async (mock: FetchMock) => {
    const fbRequest = createFbRequest(makeDeps());
    const literals: readonly (readonly [string, unknown])[] = [
      ['null', null],
      ['false', false],
      ['true', true],
      ['0', 0],
    ];
    for (const [text, expected] of literals) {
      mock.enqueue({
        status: 200,
        text,
        headers: { 'content-type': 'application/json' },
      });
      const res = await fbRequest({
        protocol: 'json',
        host: 'graph',
        method: 'GET',
        path: '/x',
      });
      assert.equal(res.data, expected, `body ${text}`);
      assert.equal(res.status, 200);
    }
  });
});
