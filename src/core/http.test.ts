import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  createFbRequest,
  computeAppSecretProof,
  resolveHostBase,
  parseUsageHeaders,
  extractResponseHeaders,
  createHostSemaphores,
  classifyHttpError,
  isThrottleCode,
  retryVerdict,
  bestEffortCategory,
  graphErrorFromResponse,
  isProvablyNotSent,
  parseRetryAfterMs,
  usageOfGraphError,
  type FbRequestDeps,
  type HostSemaphores,
} from './http.js';
import { NON_JSON_BODY_MAX, PROXY_ENV_HINT } from './errors.js';
import { createRedactor } from './redact.js';
import { GraphApiError } from './index.js';
import type {
  FbRequest,
  FbResponse,
  GraphHost,
  HostAllowlist,
  Logger,
  LogFields,
  Settings,
  UsageSnapshot,
} from './index.js';
import { createFakeClock, createFakeRedactor, type FakeClock } from './fakes/index.js';
import { withFetch, type FetchMock } from '../testing/index.js';

// ---------------------------------------------------------------------------
// Test helpers
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
 * Make the NEXT response's body reject when read, the way a stream truncated by
 * a mid-flight reset does. Same wrapping discipline as {@link captureResponses}.
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

/**
 * Make the NEXT request reject with `message`, the way a connection cut between
 * the request and the response head does. Same wrapping discipline as
 * {@link captureResponses}.
 */
function failNextFetch(message: string): void {
  const inner = globalThis.fetch;
  let pending = true;
  globalThis.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    if (pending) {
      pending = false;
      throw new Error(message);
    }
    return inner(...args);
  };
}

/** A {@link FakeClock} that also records every duration the client asked to sleep. */
function createRecordingClock(startMs = 0): {
  readonly clock: FakeClock;
  readonly sleeps: readonly number[];
} {
  const base = createFakeClock(startMs);
  const sleeps: number[] = [];
  const clock: FakeClock = {
    now: () => base.now(),
    sleep: (ms, signal) => {
      sleeps.push(ms);
      return base.sleep(ms, signal);
    },
    advance: (ms) => base.advance(ms),
    set: (ms) => base.set(ms),
    pendingSleeps: () => base.pendingSleeps(),
  };
  return { clock, sleeps };
}

function makeDeps(overrides: Partial<FbRequestDeps> = {}): FbRequestDeps {
  return {
    settings: makeSettings(),
    clock: createFakeClock(),
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
async function settle<T>(clock: FakeClock, promise: Promise<T>): Promise<T> {
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
function throttleBody(code: number, etaMinutes?: number): unknown {
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

// ---------------------------------------------------------------------------
// Auth: Bearer header, no token in query, appsecret_proof (C3, CC-AUTH-8/10)
// ---------------------------------------------------------------------------

test('GET sends Authorization: Bearer, never the token in the query, proof in query', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ json: { id: 'me' } });
    const fbRequest = createFbRequest(makeDeps());

    const res: FbResponse<{ id: string }> = await fbRequest({
      protocol: 'json',
      host: 'graph',
      method: 'GET',
      path: '/me',
      params: { fields: 'id,name' },
    });

    assert.deepEqual(res.data, { id: 'me' });
    assert.equal(res.status, 200);

    const req = mock.lastRequest();
    assert.ok(req);
    assert.equal(req.headers['authorization'], `Bearer ${TOKEN}`);
    // Token must NEVER appear in the URL (C3 — Graph echoes query into paging.next).
    assert.ok(!req.url.includes(TOKEN), 'token leaked into the URL');
    // Version prepended, edge path preserved.
    assert.ok(req.url.startsWith('https://graph.facebook.com/v21.0/me'));
    // appsecret_proof present as a query param and correctly computed.
    const url = new URL(req.url);
    const expectedProof = createHmac('sha256', APP_SECRET).update(TOKEN).digest('hex');
    assert.equal(url.searchParams.get('appsecret_proof'), expectedProof);
    assert.equal(url.searchParams.get('fields'), 'id,name');
  });
});

test('POST puts appsecret_proof in the body (out of any echoed URL), token only in header', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ json: { id: '123_456' } });
    const fbRequest = createFbRequest(makeDeps());

    await fbRequest({
      protocol: 'json',
      host: 'graph',
      method: 'POST',
      path: '/me/feed',
      body: { message: 'hello world', published: false },
    });

    const req = mock.lastRequest();
    assert.ok(req);
    assert.equal(req.headers['authorization'], `Bearer ${TOKEN}`);
    assert.ok(!req.url.includes(TOKEN));
    assert.ok(
      !req.url.includes('appsecret_proof'),
      'proof should be in the body for POST',
    );
    assert.equal(req.body.kind, 'urlencoded');
    if (req.body.kind === 'urlencoded') {
      assert.equal(req.body.params['message'], 'hello world');
      assert.equal(req.body.params['published'], 'false');
      const expectedProof = computeAppSecretProof(TOKEN, APP_SECRET);
      assert.equal(req.body.params['appsecret_proof'], expectedProof);
    }
  });
});

test('req.token overrides settings and no appsecret_proof is sent when appSecret is absent', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ json: {} });
    const deps = makeDeps({ settings: makeSettings({ appSecret: undefined }) });
    const fbRequest = createFbRequest(deps);

    await fbRequest({
      protocol: 'json',
      host: 'graph',
      method: 'GET',
      path: '/me',
      token: 'OVERRIDE_TOKEN_xyz',
    });

    const req = mock.lastRequest();
    assert.ok(req);
    assert.equal(req.headers['authorization'], 'Bearer OVERRIDE_TOKEN_xyz');
    assert.ok(!req.url.includes('appsecret_proof'));
  });
});

test('missing token fails fast before any request is sent', async () => {
  await withFetch(async (mock: FetchMock) => {
    const deps = makeDeps({
      settings: makeSettings({
        accessToken: undefined,
        systemToken: undefined,
        pageToken: undefined,
      }),
    });
    const fbRequest = createFbRequest(deps);
    await assert.rejects(
      fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      /no access token/,
    );
    assert.equal(mock.requests.length, 0);
  });
});

test('logs never contain the raw token (C3)', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ json: {} });
    const logger = createTestLogger();
    const fbRequest = createFbRequest(makeDeps({ logger }));
    await fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' });
    const serialized = JSON.stringify(logger.entries);
    assert.ok(!serialized.includes(TOKEN), 'token appeared in a log field');
  });
});

test('every credential the request derives is registered with the redactor (C3)', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ json: {} });
    // The clean run above proves nothing about the registration: `logger.entries`
    // is empty of the token whether or not `addSecret` was ever called. Assert on
    // the registered SET so removing any of the three calls fails here — the
    // registration is what protects the code paths this test does not exercise.
    const redactor = createFakeRedactor();
    const fbRequest = createFbRequest(makeDeps({ redactor }));
    await fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' });

    const proof = computeAppSecretProof(TOKEN, APP_SECRET);
    assert.deepEqual([...redactor.secrets].sort(), [TOKEN, proof, APP_SECRET].sort());
  });
});

test('with no app secret configured, only the token is registered (C3)', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ json: {} });
    // No secret ⇒ no proof to compute and nothing else to register. Pinning the
    // exact set keeps the two `appSecret` guards from being widened into an
    // unconditional `addSecret(settings.appSecret!)`.
    const redactor = createFakeRedactor();
    const fbRequest = createFbRequest(
      makeDeps({ redactor, settings: makeSettings({ appSecret: undefined }) }),
    );
    await fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' });

    assert.deepEqual(redactor.secrets, [TOKEN]);
  });
});

// ---------------------------------------------------------------------------
// Host allowlist / URL safety (CC-NET-7)
// ---------------------------------------------------------------------------

test('CC-NET-7: an off-allowlist host key is rejected before any fetch', async () => {
  await withFetch(async (mock: FetchMock) => {
    const fbRequest = createFbRequest(makeDeps());
    await assert.rejects(
      fbRequest({
        protocol: 'json',
        // deliberately bypass the type to simulate untrusted input
        host: 'evil' as 'graph',
        method: 'GET',
        path: '/me',
      }),
      /not on the allowlist/,
    );
    assert.equal(mock.requests.length, 0);
  });
});

test('CC-NET-7: an absolute-URL path cannot redirect the request off-host', async () => {
  await withFetch(async (mock: FetchMock) => {
    const fbRequest = createFbRequest(makeDeps());
    await assert.rejects(
      fbRequest({
        protocol: 'json',
        host: 'graph',
        method: 'GET',
        path: 'https://evil.example/steal',
      }),
      /relative edge path/,
    );
    assert.equal(mock.requests.length, 0);
  });
});

test('CC-NET-7: a traversal segment in an interpolated id cannot retarget the edge', async () => {
  await withFetch(async (mock: FetchMock) => {
    const fbRequest = createFbRequest(makeDeps());
    // Ids reach `path` by interpolation and routinely originate in untrusted
    // content. Assigning `url.pathname` resolves dot segments — including their
    // percent-encoded spelling — so without containment `DELETE /{post_id}`
    // silently becomes `DELETE /me/accounts` on the very same allowlisted host.
    for (const postId of ['../../me/accounts', '%2e%2e/%2E%2e/me/accounts']) {
      await assert.rejects(
        fbRequest({
          protocol: 'json',
          host: 'graph',
          method: 'DELETE',
          path: `/${postId}`,
        }),
        /would traverse outside its edge/,
        `id '${postId}' escaped its edge`,
      );
    }
    assert.equal(mock.requests.length, 0);
  });
});

test('CC-NET-7: real Graph id shapes survive containment unescaped', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.fallback({ json: { data: [] } });
    const fbRequest = createFbRequest(makeDeps());
    await fbRequest({
      protocol: 'json',
      host: 'graph',
      method: 'GET',
      path: '/act_123_456/insights',
    });
    const recorded = mock.lastRequest();
    assert.ok(recorded);
    // `-`, `_`, `.` and `~` are left alone by encodeURIComponent, which covers
    // every id shape Graph actually emits: `123_456`, `act_123`, `v21.0`.
    assert.equal(new URL(recorded.url).pathname, '/v21.0/act_123_456/insights');
  });
});

test('CC-NET-7: a redirect response is refused, never followed', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 302, headers: { location: 'https://evil.example/' } });
    const fbRequest = createFbRequest(makeDeps());
    await assert.rejects(
      fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      (err: unknown) =>
        err instanceof GraphApiError && /refusing redirect/.test(err.message),
    );
    // Exactly one attempt — the redirect is terminal, not retried.
    assert.equal(mock.requests.length, 1);
    // The refusal above is our own status check, which would pass just as well if
    // the client asked the platform to FOLLOW redirects — in that case a real
    // runtime would have chased the 302 to evil.example with the Authorization
    // header attached and never handed us the 3xx to refuse. `manual` is what
    // makes the check reachable, so it is asserted where the check is.
    assert.equal(mock.lastRequest()?.redirect, 'manual');
  });
});

test('CC-NET-7: a refused redirect consumes its body instead of pinning the socket', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 302,
      headers: { location: 'https://evil.example/' },
      text: '<html>moved along, nothing to see</html>',
    });
    const seen = captureResponses();
    const fbRequest = createFbRequest(makeDeps());

    await assert.rejects(
      fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      (err: unknown) =>
        err instanceof GraphApiError && /refusing redirect/.test(err.message),
    );
    // `redirect: 'manual'` does NOT hand back an empty opaque-redirect response
    // under Node/undici: the 3xx arrives with a real body, and a body left unread
    // keeps its socket out of the pool. Every other exit in the client reads the
    // body; the refusal is not allowed to be the one exception.
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.bodyUsed, true, 'the refused redirect body was left unread');
  });
});

test('CC-NET-7: a redirect body that fails to read still surfaces the refusal', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 302,
      headers: { location: 'https://evil.example/' },
      text: '<html>moved along, nothing to see</html>',
    });
    breakNextBodyRead('socket hang up mid-body');
    const fbRequest = createFbRequest(makeDeps());

    // Discarding the body is advisory housekeeping. The caller must see why the
    // request failed — the redirect off the allowlisted host — never the failure
    // of a read whose only purpose was to throw the bytes away.
    await assert.rejects(
      fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        assert.match(err.message, /refusing redirect/);
        assert.equal(err.httpStatus, 302);
        assert.equal(err.action?.retryable, false);
        return true;
      },
    );
    assert.equal(mock.requests.length, 1);
  });
});

test('resolveHostBase maps the three symbolic hosts and rejects others', () => {
  assert.equal(resolveHostBase(HOSTS, 'graph'), 'graph.facebook.com');
  assert.equal(resolveHostBase(HOSTS, 'graph-video'), 'graph-video.facebook.com');
  assert.equal(resolveHostBase(HOSTS, 'rupload'), 'rupload.facebook.com');
  assert.throws(() => resolveHostBase(HOSTS, 'nope' as 'graph'), /allowlist/);
});

test('a path that already carries a version segment is not double-versioned', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ json: {} });
    const fbRequest = createFbRequest(makeDeps());
    await fbRequest({
      protocol: 'json',
      host: 'graph',
      method: 'GET',
      path: '/v19.0/act_1/campaigns',
    });
    const req = mock.lastRequest();
    assert.ok(req);
    assert.ok(req.url.startsWith('https://graph.facebook.com/v19.0/act_1/campaigns'));
    assert.ok(!req.url.includes('/v21.0/'));
  });
});

// ---------------------------------------------------------------------------
// Retry classification — pure table tests (CC-NET-1, CC-NET-5)
// ---------------------------------------------------------------------------

test('isThrottleCode covers families 4/17/32/613 and the 80000-80099 range', () => {
  for (const code of [4, 17, 32, 613, 80000, 80050, 80099]) {
    assert.equal(isThrottleCode(code), true, `expected ${code} to be throttle`);
  }
  for (const code of [1, 100, 190, 200, 506, 79999, 80100, undefined]) {
    assert.equal(
      isThrottleCode(code),
      false,
      `expected ${String(code)} to NOT be throttle`,
    );
  }
});

test('classifyHttpError keys throttle on the body code even at HTTP 400', () => {
  assert.equal(classifyHttpError(400, 4), 'throttle');
  assert.equal(classifyHttpError(400, 80004), 'throttle');
  assert.equal(classifyHttpError(400, 100), 'terminal'); // validation, not throttle
  assert.equal(classifyHttpError(500, undefined), 'transient');
  assert.equal(classifyHttpError(503, undefined), 'transient');
  assert.equal(classifyHttpError(404, 803), 'terminal');
  // A bare 429 from a hop in front of Graph has no body code to key on, but the
  // status alone already says "rejected, come back later" — provably not
  // processed, so it takes the throttle path for reads and writes alike.
  assert.equal(classifyHttpError(429, undefined), 'throttle');
});

test('retryVerdict encodes the GET-vs-write matrix (C2 / CC-NET-5)', () => {
  // Throttle: provably not processed ⇒ always retry, reads and writes alike.
  assert.equal(retryVerdict('throttle', false), 'retry');
  assert.equal(retryVerdict('throttle', true), 'retry');
  // 5xx: retry a read, ambiguous on a write.
  assert.equal(retryVerdict('transient', false), 'retry');
  assert.equal(retryVerdict('transient', true), 'ambiguous');
  // Network fault: reads retry; writes only if provably-not-sent, else ambiguous.
  assert.equal(retryVerdict('network', false), 'retry');
  assert.equal(retryVerdict('network', true, false), 'ambiguous');
  assert.equal(retryVerdict('network', true, true), 'retry');
  // Terminal application error: never retried.
  assert.equal(retryVerdict('terminal', false), 'terminal');
  assert.equal(retryVerdict('terminal', true), 'terminal');
});

test('bestEffortCategory assigns coarse categories', () => {
  assert.equal(bestEffortCategory(400, 4), 'rate_limit');
  assert.equal(bestEffortCategory(400, 190), 'auth');
  assert.equal(bestEffortCategory(403, 200), 'permission');
  assert.equal(bestEffortCategory(400, 506), 'duplicate');
  assert.equal(bestEffortCategory(404, 100), 'not_found');
  // 803 is an unresolvable id/alias, the same as the matrix's not-found-803 row.
  assert.equal(bestEffortCategory(400, 803), 'not_found');
  assert.equal(bestEffortCategory(500, undefined), 'transient');
  assert.equal(bestEffortCategory(400, 2635), 'validation');
  assert.equal(bestEffortCategory(429, undefined), 'rate_limit');
  assert.equal(bestEffortCategory(418, undefined), 'unknown');
});

// ---------------------------------------------------------------------------
// Retry behavior end-to-end (CC-NET-1, CC-NET-3, CC-NET-5)
// ---------------------------------------------------------------------------

test('CC-NET-1: HTTP 400 throttle (code 4) backs off then succeeds on GET', async () => {
  await withFetch(async (mock: FetchMock) => {
    const clock = createFakeClock();
    mock.enqueue({ status: 400, json: throttleBody(4, 1) });
    mock.enqueue({ status: 200, json: { ok: true } });

    const fbRequest = createFbRequest(makeDeps({ clock }));
    const res = await settle(
      clock,
      fbRequest<{ ok: boolean }>({
        protocol: 'json',
        host: 'graph',
        method: 'GET',
        path: '/me',
      }),
    );
    assert.deepEqual(res.data, { ok: true });
    assert.equal(mock.requests.length, 2, 'should have retried exactly once');
  });
});

test('CC-NET-1: throttle is retried even for writes (provably not processed)', async () => {
  await withFetch(async (mock: FetchMock) => {
    const clock = createFakeClock();
    mock.enqueue({ status: 400, json: throttleBody(17) });
    mock.enqueue({ status: 200, json: { id: 'p1' } });

    const fbRequest = createFbRequest(makeDeps({ clock }));
    const res = await settle(
      clock,
      fbRequest({
        protocol: 'json',
        host: 'graph',
        method: 'POST',
        path: '/me/feed',
        body: { message: 'x' },
      }),
    );
    assert.deepEqual(res.data, { id: 'p1' });
    assert.equal(mock.requests.length, 2);
  });
});

test('CC-NET-3: an ETA beyond the 60s cap is not slept — it fails fast with the real wait', async () => {
  // Formerly asserted a clamped 60s sleep: that re-hit an endpoint which had
  // just said it was blocked for an hour, and reported the hour only after
  // every retry was spent.
  const { clock, sleeps } = createRecordingClock();
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 400, json: throttleBody(4, 60) });
    mock.enqueue({ status: 200, json: {} });

    const fbRequest = createFbRequest(makeDeps({ clock, rng: () => 1 }));
    await assert.rejects(
      settle(
        clock,
        fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      ),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        assert.equal(err.action?.category, 'rate_limit');
        assert.equal(err.action?.retryAfterMs, 3_600_000);
        return true;
      },
    );
    assert.deepEqual(sleeps, []);
    assert.equal(mock.requests.length, 1);
  });
});

test('CC-NET-3: the surfaced retry-after reads the ETA as minutes, not seconds', async () => {
  await withFetch(async (mock: FetchMock) => {
    const clock = createFakeClock();
    // Graph documents `estimated_time_to_regain_access` in MINUTES, and the
    // matrix converts it with ETA_MINUTES_TO_MS. Reading it as seconds here
    // would tell the operator "retry in 30s" for a half-hour block.
    mock.on(() => true, { status: 400, json: throttleBody(4, 30) });
    const fbRequest = createFbRequest(makeDeps({ clock, retry: { maxRetries: 0 } }));
    await assert.rejects(
      settle(
        clock,
        fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      ),
      (err: unknown) =>
        err instanceof GraphApiError &&
        err.action?.category === 'rate_limit' &&
        err.action.retryAfterMs === 30 * 60_000,
    );
  });
});

test('CC-NET-3: a zero regain-access ETA backs off on the schedule, not instantly', async () => {
  const sleeps: number[] = [];
  const base = createFakeClock();
  const clock: FakeClock = {
    now: () => base.now(),
    sleep: (ms, signal) => {
      sleeps.push(ms);
      return base.sleep(ms, signal);
    },
    advance: (ms) => base.advance(ms),
    set: (ms) => base.set(ms),
    pendingSleeps: () => base.pendingSleeps(),
  };
  await withFetch(async (mock: FetchMock) => {
    // Graph emits `estimated_time_to_regain_access: 0` on real throttle
    // envelopes — F06 guards `eta > 0` before it will surface one, and
    // errors.test.ts pins the shape. Honored here as a wait, a 0 makes the
    // backoff base 0, so the equal-jitter delay is 0 and the whole retry budget
    // fires back to back into an endpoint that has just said "you are blocked":
    // the exact behavior that turns a soft throttle into a hard block. A 0 is
    // not a wait, so it is not an ETA — the exponential schedule stands.
    mock.enqueue({ status: 400, json: throttleBody(4, 0) });
    mock.enqueue({ status: 200, json: {} });

    const fbRequest = createFbRequest(makeDeps({ clock, rng: () => 1 }));
    await settle(
      clock,
      fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
    );
    assert.equal(sleeps.length, 1);
    // rng()=1 ⇒ equal jitter yields the full base: the first exponential step.
    assert.equal(sleeps[0], 500);
  });
});

test('CC-NET-3: a non-positive ETA never becomes the surfaced retry-after', async () => {
  for (const etaMinutes of [0, -5]) {
    await withFetch(async (mock: FetchMock) => {
      const clock = createFakeClock();
      mock.on(() => true, { status: 400, json: throttleBody(4, etaMinutes) });
      const fbRequest = createFbRequest(makeDeps({ clock, retry: { maxRetries: 0 } }));
      await assert.rejects(
        settle(
          clock,
          fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
        ),
        (err: unknown) => {
          assert.ok(err instanceof GraphApiError);
          assert.equal(err.action?.category, 'rate_limit');
          // `retryAfterMs: 0` reads as "retry immediately" and a negative one is
          // not a duration at all. Neither is an instruction from the server, so
          // the matrix's own throttle default is what the operator must see.
          assert.equal(err.action.retryAfterMs, 60_000);
          return true;
        },
      );
    });
  }
});

test('Retry-After (delay-seconds) governs the backoff instead of the local schedule', async () => {
  // The header is the server telling us when to come back. Ignoring it means the
  // exponential schedule — 500ms on the first retry — decides instead, so we
  // return well inside the window the endpoint just asked us to sit out, which
  // is how a soft throttle is escalated into a hard block. RFC 9110 §10.2.3
  // reads the value as a MINIMUM wait; one beyond the 60s cap fails fast
  // instead (see the CC-NET-3 fail-fast test).
  for (const [header, expected] of [['5', 5_000]] as const) {
    const { clock, sleeps } = createRecordingClock();
    await withFetch(async (mock: FetchMock) => {
      mock.enqueue({
        status: 400,
        json: throttleBody(4),
        headers: { 'retry-after': header },
      });
      mock.enqueue({ status: 200, json: {} });

      const fbRequest = createFbRequest(makeDeps({ clock, rng: () => 1 }));
      await settle(
        clock,
        fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      );
      // rng()=1 ⇒ equal jitter yields the full base.
      assert.deepEqual(sleeps, [expected], `Retry-After: ${header}`);
    });
  }
});

test('a server-named wait (Retry-After or ETA) is slept in full — jitter never shortens it', async () => {
  // RFC 9110 reads Retry-After as a MINIMUM; the ETA is the server saying when
  // access returns. Equal jitter on these would retry inside the window the
  // server just asked us to sit out (rng()=0 ⇒ half the wait).
  for (const [label, response, expected] of [
    [
      'Retry-After: 5',
      { status: 400, json: throttleBody(4), headers: { 'retry-after': '5' } },
      5_000,
    ],
    ['ETA 1 minute', { status: 400, json: throttleBody(4, 1) }, 60_000],
  ] as const) {
    const { clock, sleeps } = createRecordingClock();
    await withFetch(async (mock: FetchMock) => {
      mock.enqueue(response);
      mock.enqueue({ status: 200, json: {} });
      const fbRequest = createFbRequest(makeDeps({ clock, rng: () => 0 }));
      await settle(
        clock,
        fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      );
      assert.deepEqual(sleeps, [expected], label);
    });
  }
  // The local exponential schedule keeps its jitter (rng()=0 ⇒ half of 500ms).
  const { clock, sleeps } = createRecordingClock();
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 503, text: 'unavailable' });
    mock.enqueue({ status: 200, json: {} });
    const fbRequest = createFbRequest(makeDeps({ clock, rng: () => 0 }));
    await settle(
      clock,
      fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
    );
    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0]! < 500, `exponential backoff stays jittered, got ${sleeps[0]}`);
  });
});

test('Retry-After in HTTP-date form is honored as the wait that remains of it', async () => {
  // The other legal spelling of the same header (RFC 9110 §10.2.3). It is an
  // absolute instant, so the wait is `date - now` read off the injected clock —
  // never the raw value, and never a parse that silently yields NaN.
  const startMs = Date.parse('2026-01-01T00:00:00.000Z');
  const { clock, sleeps } = createRecordingClock(startMs);
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 503,
      text: 'Service Unavailable',
      headers: { 'retry-after': new Date(startMs + 7_000).toUTCString() },
    });
    mock.enqueue({ status: 200, json: {} });

    const fbRequest = createFbRequest(makeDeps({ clock, rng: () => 1 }));
    await settle(
      clock,
      fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me/posts' }),
    );
    assert.deepEqual(sleeps, [7_000]);
  });
});

test('a Retry-After that is not a future wait leaves the exponential schedule standing', async () => {
  // `0`, an unparseable value and a date already in the past are not waits the
  // server asked for. Honored as a base they make the backoff 0 and fire the
  // whole retry budget back to back — the same failure mode a zero ETA has
  // (CC-NET-3) — so each one falls through to the exponential step.
  const startMs = Date.parse('2026-01-01T00:00:00.000Z');
  for (const header of ['0', 'soon', '', new Date(startMs - 60_000).toUTCString()]) {
    const { clock, sleeps } = createRecordingClock(startMs);
    await withFetch(async (mock: FetchMock) => {
      mock.enqueue({
        status: 400,
        json: throttleBody(4),
        headers: { 'retry-after': header },
      });
      mock.enqueue({ status: 200, json: {} });

      const fbRequest = createFbRequest(makeDeps({ clock, rng: () => 1 }));
      await settle(
        clock,
        fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      );
      assert.deepEqual(sleeps, [500], `Retry-After: '${header}'`);
    });
  }
});

test('when both a Retry-After and a regain-access ETA arrive, the longer wait wins', async () => {
  // They are two statements of the same thing and neither is authoritative over
  // the other, so the safe reading is the one that satisfies both: come back no
  // earlier than either asked. Under-waiting on a block is the expensive
  // mistake; the 60s cap already bounds the other direction.
  const { clock, sleeps } = createRecordingClock();
  await withFetch(async (mock: FetchMock) => {
    // ETA 0.5 minutes = 30s, against a Retry-After of 5s.
    mock.enqueue({
      status: 400,
      json: throttleBody(4, 0.5),
      headers: { 'retry-after': '5' },
    });
    mock.enqueue({ status: 200, json: {} });

    const fbRequest = createFbRequest(makeDeps({ clock, rng: () => 1 }));
    await settle(
      clock,
      fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
    );
    assert.deepEqual(sleeps, [30_000]);
  });
});

test('CC-NET-1: a bare HTTP 429 is a rate limit that backs off, not a terminal error', async () => {
  // Graph itself ships throttles as HTTP 400 + a body code, which is why the
  // matrix keys on the body — but that is a statement about Graph, not about
  // every hop in front of it. An edge, a CDN or a corporate proxy answers with a
  // bare 429 and a Retry-After, and with no body code to key on that lands in
  // `terminal`: surfaced as a non-retryable `unknown`, never retried, with the
  // one status HTTP defines as "come back later" thrown away.
  const { clock, sleeps } = createRecordingClock();
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 429,
      text: 'Too Many Requests',
      headers: { 'retry-after': '3' },
    });
    mock.enqueue({ status: 200, json: { ok: true } });

    const fbRequest = createFbRequest(makeDeps({ clock, rng: () => 1 }));
    const res = await settle(
      clock,
      fbRequest<{ ok: boolean }>({
        protocol: 'json',
        host: 'graph',
        method: 'GET',
        path: '/me',
      }),
    );
    assert.deepEqual(res.data, { ok: true });
    assert.equal(mock.requests.length, 2, 'the 429 must be retried');
    assert.deepEqual(sleeps, [3_000]);
  });
});

test('CC-NET-1: an exhausted HTTP 429 surfaces as rate_limit, not unknown', async () => {
  await withFetch(async (mock: FetchMock) => {
    const clock = createFakeClock();
    mock.on(() => true, { status: 429, text: 'Too Many Requests' });
    const fbRequest = createFbRequest(makeDeps({ clock, retry: { maxRetries: 0 } }));
    await assert.rejects(
      settle(
        clock,
        fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      ),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        assert.equal(err.httpStatus, 429);
        assert.equal(err.action?.category, 'rate_limit');
        assert.equal(err.action?.retryable, false);
        return true;
      },
    );
    assert.equal(mock.requests.length, 1);
  });
});

test('CC-NET-5: a response body lost after a 200 is a transient fault on a read', async () => {
  await withFetch(async (mock: FetchMock) => {
    const clock = createFakeClock();
    mock.enqueue({ status: 200, json: { ok: 1 } });
    mock.enqueue({ status: 200, json: { ok: 2 } });
    // `fetch` settles on the response HEAD; the body is still arriving over the
    // same connection. A cut between the head and the last byte therefore
    // rejects at `response.text()`, not at `fetch` — undici spells it
    // `TypeError: terminated`. Read outside the fault classification, that
    // rejection escapes the client raw: no category, no operator text, and no
    // retry, though a truncated stream is the textbook transient and re-reading
    // a GET is free.
    breakNextBodyRead('terminated');
    const fbRequest = createFbRequest(makeDeps({ clock }));

    const res = await settle(
      clock,
      fbRequest<{ ok: number }>({
        protocol: 'json',
        host: 'graph',
        method: 'GET',
        path: '/me',
      }),
    );
    assert.deepEqual(res.data, { ok: 2 });
    assert.equal(mock.requests.length, 2, 'the truncated read should have retried once');
  });
});

test('C2: a response body lost after a 200 on a write is ambiguous, never retried', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.on(() => true, { status: 200, json: { id: 'p1' } });
    breakNextBodyRead('terminated');
    const fbRequest = createFbRequest(makeDeps());

    // This is the worst outcome the transport can produce: the post EXISTS —
    // Graph answered 200 — and only the id was lost on the way back. Surfaced
    // raw, it reaches the tool layer as an unclassified failure, which reads as
    // "it did not happen" and invites a retry that publishes the post twice. It
    // is the same lost-response fault as a mid-flight reset on a write, and it
    // takes the same verdict: ambiguous, verify first, never auto-retried.
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
        assert.equal(err.action?.category, 'ambiguous');
        assert.equal(err.action.retryable, false);
        assert.match(err.message, /ambiguous write outcome/);
        assert.equal(err.httpStatus, 200);
        return true;
      },
    );
    assert.equal(
      mock.requests.length,
      1,
      'a write Graph already accepted must not re-send',
    );
  });
});

test('CC-NET-5: 5xx retries on GET (read) then succeeds', async () => {
  await withFetch(async (mock: FetchMock) => {
    const clock = createFakeClock();
    mock.enqueue({ status: 503, text: 'Service Unavailable' });
    mock.enqueue({ status: 200, json: { data: [] } });

    const fbRequest = createFbRequest(makeDeps({ clock }));
    const res = await settle(
      clock,
      fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me/posts' }),
    );
    assert.deepEqual(res.data, { data: [] });
    assert.equal(mock.requests.length, 2);
  });
});

test('CC-NET-5: a network fault on a GET is retried then succeeds', async () => {
  await withFetch(async (mock: FetchMock) => {
    const clock = createFakeClock();
    // The first call matches no rule (⇒ the mock throws, standing in for a
    // mid-flight network fault); the second call matches and succeeds.
    let n = 0;
    mock.on(
      () => {
        n += 1;
        return n >= 2;
      },
      { status: 200, json: { ok: 1 } },
    );
    const fbRequest = createFbRequest(makeDeps({ clock }));
    const res = await settle(
      clock,
      fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
    );
    assert.equal(res.status, 200);
    assert.equal(mock.requests.length, 2);
  });
});

test('C2 / CC-NET-5: a 5xx on a write is ambiguous and never retried', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 502, text: 'Bad Gateway' });

    const fbRequest = createFbRequest(makeDeps());
    await assert.rejects(
      fbRequest({
        protocol: 'json',
        host: 'graph',
        method: 'POST',
        path: '/me/feed',
        body: { message: 'x' },
      }),
      (err: unknown) =>
        err instanceof GraphApiError &&
        err.action !== undefined &&
        err.action.category === 'ambiguous' &&
        err.action.retryable === false &&
        /[Dd]o NOT retry/.test(err.action.operatorText) &&
        // The guidance comes from F06, so it names the tool to verify with
        // instead of only telling the model to verify somehow.
        err.action.nextTool === 'facebook_list_posts',
    );
    assert.equal(mock.requests.length, 1, 'the write must not be replayed');
  });
});

test('C2: a lost response on a write (network fault) is ambiguous, not retried', async () => {
  await withFetch(async (mock: FetchMock) => {
    // No programmed response ⇒ the mock rejects, standing in for a mid-flight fault.
    const fbRequest = createFbRequest(makeDeps());
    await assert.rejects(
      fbRequest({
        protocol: 'json',
        host: 'graph',
        method: 'POST',
        path: '/me/feed',
        body: { message: 'x' },
      }),
      (err: unknown) =>
        err instanceof GraphApiError && err.action?.category === 'ambiguous',
    );
    assert.equal(mock.requests.length, 1);
  });
});

test('C3: an ambiguous write error redacts the credential its detail carries', async () => {
  // Both ambiguous call sites interpolate a wire error message verbatim, and a
  // transport fault routinely quotes the URL it failed on. That URL is not
  // credential-free: `appsecret_proof` rides in the query on DELETE, and any
  // middlebox or upstream helper can echo a token back in its own message. An
  // unredacted detail lands in TWO places at once — the surfaced message and the
  // operator guidance F06 builds from it — and both are logged and handed to the
  // model. `networkError`, the next function in the file, has always redacted;
  // the ambiguous path is the one that carries the write, so it needs it more.
  const leaky = `connect ECONNRESET https://graph.facebook.com/v21.0/me/feed?access_token=${TOKEN}`;

  const assertScrubbed = (err: unknown): true => {
    assert.ok(err instanceof GraphApiError);
    assert.equal(err.action?.category, 'ambiguous');
    assert.ok(!err.message.includes(TOKEN), 'token leaked into the ambiguous message');
    assert.ok(err.action !== undefined);
    assert.ok(
      !err.action.operatorText.includes(TOKEN),
      'token leaked into the operator guidance',
    );
    assert.ok(err.message.includes('[REDACTED]'), 'the detail was not redacted at all');
    return true;
  };

  // (a) the request is lost mid-flight — `ambiguousError(0, 'network fault: ...')`
  await withFetch(async () => {
    failNextFetch(leaky);
    const fbRequest = createFbRequest(makeDeps());
    await assert.rejects(
      fbRequest({
        protocol: 'json',
        host: 'graph',
        method: 'POST',
        path: '/me/feed',
        body: { message: 'x' },
      }),
      assertScrubbed,
    );
  });

  // (b) the body is lost after the head — `ambiguousError(status, 'response body lost ...')`
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 200, json: { id: 'p1' } });
    breakNextBodyRead(leaky);
    const fbRequest = createFbRequest(makeDeps());
    await assert.rejects(
      fbRequest({
        protocol: 'json',
        host: 'graph',
        method: 'POST',
        path: '/me/feed',
        body: { message: 'x' },
      }),
      assertScrubbed,
    );
  });
});

test('non-throttle 4xx (validation) is terminal — surfaced, not retried', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 400,
      json: {
        error: { message: 'Invalid parameter', type: 'OAuthException', code: 2500 },
      },
    });
    const fbRequest = createFbRequest(makeDeps());
    await assert.rejects(
      fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      (err: unknown) =>
        err instanceof GraphApiError &&
        err.code === 2500 &&
        err.httpStatus === 400 &&
        err.action?.category === 'validation',
    );
    assert.equal(mock.requests.length, 1);
  });
});

test('506 duplicate is surfaced and never retried', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 400,
      json: { error: { message: 'Duplicate status message', code: 506 } },
    });
    const fbRequest = createFbRequest(makeDeps());
    await assert.rejects(
      fbRequest({
        protocol: 'json',
        host: 'graph',
        method: 'POST',
        path: '/me/feed',
        body: { message: 'dup' },
      }),
      (err: unknown) =>
        err instanceof GraphApiError &&
        err.code === 506 &&
        err.action?.category === 'duplicate',
    );
    assert.equal(mock.requests.length, 1);
  });
});

// ---------------------------------------------------------------------------
// F06 delegation — live Graph errors carry the matrix classification
// ---------------------------------------------------------------------------

test('F06: a live Graph error is classified by the matrix, next tool included', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 400,
      json: {
        error: { message: 'Session expired', code: 190, error_subcode: 463 },
      },
    });
    const fbRequest = createFbRequest(makeDeps());
    await assert.rejects(
      fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      (err: unknown) =>
        err instanceof GraphApiError &&
        err.action?.category === 'auth' &&
        err.action.retryable === false &&
        // The matrix row for 190/463, not a category-level platitude.
        err.action.nextTool === 'facebook_whoami' &&
        /code 190\/463/.test(err.action.operatorText),
    );
  });
});

test('F06: the subcode picks the more specific row (100/33 is not_found, 100 is validation)', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 400,
      json: { error: { message: 'gone', code: 100, error_subcode: 33 } },
    });
    mock.enqueue({ status: 400, json: { error: { message: 'bad arg', code: 100 } } });
    const fbRequest = createFbRequest(makeDeps());
    const categoryOf = async (): Promise<string | undefined> => {
      try {
        await fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/x' });
        return undefined;
      } catch (err) {
        return err instanceof GraphApiError ? err.action?.category : undefined;
      }
    };
    assert.equal(await categoryOf(), 'not_found');
    assert.equal(await categoryOf(), 'validation');
  });
});

test('F06: a throttle surfaced after retries keeps the row guidance but not its retryability', async () => {
  await withFetch(async (mock: FetchMock) => {
    const clock = createFakeClock();
    mock.on(() => true, { status: 400, json: throttleBody(4, 30) });
    const fbRequest = createFbRequest(makeDeps({ clock, retry: { maxRetries: 0 } }));
    await assert.rejects(
      settle(
        clock,
        fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      ),
      (err: unknown) =>
        err instanceof GraphApiError &&
        err.action?.category === 'rate_limit' &&
        // Retries are spent, so the transport overrides the row's `retryable`...
        err.action.retryable === false &&
        // ...while the row still supplies the guidance and the ETA.
        err.action.nextTool === 'facebook_usage' &&
        err.action.retryAfterMs === 30 * 60_000 &&
        /facebook_usage/.test(err.action.operatorText),
    );
  });
});

test('F06: a code the matrix does not know still reads the HTTP status', async () => {
  await withFetch(async (mock: FetchMock) => {
    const clock = createFakeClock();
    // `classifyGraphError` is total and would call code 99999 `unknown`; the
    // status says 5xx, which is the more useful classification for a GET.
    mock.on(() => true, { status: 503, json: { error: { message: 'x', code: 99999 } } });
    const fbRequest = createFbRequest(makeDeps({ clock, retry: { maxRetries: 0 } }));
    await assert.rejects(
      settle(
        clock,
        fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      ),
      (err: unknown) =>
        err instanceof GraphApiError &&
        err.action?.category === 'transient' &&
        err.action.retryable === true,
    );
  });
});

test('CC-NET-6: a network fault surfaces the proxy self-diagnosis', async () => {
  await withFetch(async (mock: FetchMock) => {
    // No programmed response ⇒ the mock rejects. A GET, so it is transient
    // rather than the C2 ambiguous path a write would take.
    const fbRequest = createFbRequest(makeDeps({ retry: { maxRetries: 0 } }));
    await assert.rejects(
      fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      (err: unknown) =>
        err instanceof GraphApiError &&
        err.action?.category === 'transient' &&
        err.action.retryable === true &&
        /HTTPS_PROXY/.test(err.action.operatorText) &&
        /installs no custom CA/.test(err.action.operatorText),
    );
    assert.equal(mock.requests.length, 1);
  });
});

/**
 * Reject the NEXT `fetch` call with `value` (any shape, not only an `Error`),
 * then hand control back to the `withFetch` fake. `withFetch` restores the
 * previous global on exit, wrapper included.
 */
function rejectNextFetchWith(value: unknown): void {
  const inner = globalThis.fetch;
  let pending = true;
  globalThis.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    if (pending) {
      pending = false;
      throw value;
    }
    return inner(...args);
  };
}

test('a network fault names the underlying cause, not only undici\'s generic "fetch failed"', async () => {
  // undici rejects every transport fault as `TypeError: fetch failed` and puts
  // the real reason on `cause`. Reporting only the outer message tells the
  // operator nothing they can act on (DNS? refused? TLS?).
  await withFetch(async () => {
    rejectNextFetchWith(
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND graph.facebook.com'), {
          code: 'ENOTFOUND',
        }),
      }),
    );
    const fbRequest = createFbRequest(makeDeps({ retry: { maxRetries: 0 } }));
    await assert.rejects(
      fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        assert.match(err.message, /getaddrinfo ENOTFOUND graph\.facebook\.com/);
        assert.match(err.action?.operatorText ?? '', /ENOTFOUND graph\.facebook\.com/);
        return true;
      },
    );
  });
});

test('a network fault raised as a non-Error object keeps its message', async () => {
  // A proxied or polyfilled fetch may reject with a plain `{ message }` object.
  await withFetch(async () => {
    rejectNextFetchWith({ message: 'socket hang up' });
    const fbRequest = createFbRequest(makeDeps({ retry: { maxRetries: 0 } }));
    await assert.rejects(
      fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        assert.match(err.message, /socket hang up/);
        assert.match(err.action?.operatorText ?? '', /socket hang up/);
        return true;
      },
    );
  });
});

test('CC-NET-4: a non-JSON error body does not crash and yields a GraphApiError', async () => {
  await withFetch(async (mock: FetchMock) => {
    const clock = createFakeClock();
    // 500 with an HTML body, on a GET; retried once then surfaced as transient.
    mock.on(() => true, { status: 500, text: '<html>Internal Server Error</html>' });
    const fbRequest = createFbRequest(makeDeps({ clock, retry: { maxRetries: 1 } }));
    await assert.rejects(
      settle(
        clock,
        fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      ),
      (err: unknown) =>
        err instanceof GraphApiError &&
        err.httpStatus === 500 &&
        err.action?.category === 'transient',
    );
    assert.equal(mock.requests.length, 2, 'one initial + one retry (maxRetries=1)');
  });
});

// ---------------------------------------------------------------------------
// Live error classification (CC-PAGE-2 / CC-NET-4 / CC-NET-6)
//
// `graphErrorFromResponse` is the ONLY builder of Graph errors in production, so
// a classification that is not reachable from here does not exist. These tests
// exercise it directly rather than through a hand-stamped `action`, which is the
// mistake that let the cursor-expiry category sit dead behind a heuristic.
// ---------------------------------------------------------------------------

function cursorBody(message: string, code: number, subcode?: number): string {
  return JSON.stringify({
    error: {
      message,
      type: 'OAuthException',
      code,
      ...(subcode !== undefined ? { error_subcode: subcode } : {}),
      fbtrace_id: 'Acursor1',
    },
  });
}

test('CC-PAGE-2: a live Graph cursor rejection classifies as cursor_expired', () => {
  const redactor = createFakeRedactor();
  // Graph's actual wording. Note it says "not valid", not "invalid" and not
  // "expired" — prose-matching in the api layer missed exactly this.
  const err = graphErrorFromResponse(
    400,
    cursorBody(
      'The cursor you provided is not valid. Please use the cursor returned by the API.',
      100,
    ),
    redactor,
  );
  assert.equal(err.action?.category, 'cursor_expired');
  assert.equal(err.action?.retryable, false);
  assert.match(err.action?.operatorText ?? '', /restart the listing/);
  // The wire fields still survive the reclassification.
  assert.equal(err.code, 100);
  assert.equal(err.httpStatus, 400);
  assert.equal(err.fbtraceId, 'Acursor1');
  assert.equal(err.type, 'OAuthException');
});

test('CC-PAGE-2: the cursor classification wins over the not_found and transient rows', () => {
  const redactor = createFakeRedactor();
  const gone = graphErrorFromResponse(
    400,
    cursorBody('Invalid cursor: the referenced object is unavailable', 100, 33),
    redactor,
  );
  assert.equal(
    gone.action?.category,
    'cursor_expired',
    '100/33 would otherwise be not_found',
  );

  const unknown = graphErrorFromResponse(
    400,
    cursorBody('An unknown error occurred while decoding the cursor', 1),
    redactor,
  );
  assert.equal(
    unknown.action?.category,
    'cursor_expired',
    'code 1 would otherwise be transient',
  );
  assert.equal(
    unknown.action?.retryable,
    false,
    'a dead cursor never becomes valid again',
  );
});

test('CC-PAGE-2: cursor prose under another code does not hijack the live classification', () => {
  const redactor = createFakeRedactor();
  const auth = graphErrorFromResponse(
    401,
    cursorBody('Session has expired while walking the cursor', 190),
    redactor,
  );
  assert.equal(auth.action?.category, 'auth');

  const throttled = graphErrorFromResponse(
    400,
    cursorBody('Application request limit reached paging with an invalid cursor', 4),
    redactor,
  );
  assert.equal(throttled.action?.category, 'rate_limit');
});

test('a Graph `is_transient: true` on an unclassified code reaches the classifier off the wire', () => {
  // `errors.ts` honours the flag, but only if the transport hands it over: a
  // parser that drops it turns "Graph says retry" back into a non-retryable
  // `unknown` with the inspect-then-decide text.
  const redactor = createFakeRedactor();
  const flagged = graphErrorFromResponse(
    400,
    JSON.stringify({
      error: { message: 'Temporary failure', code: 999999, is_transient: true },
    }),
    redactor,
  );
  assert.equal(flagged.action?.category, 'transient');
  assert.equal(flagged.action?.retryable, true);

  // Anything that is not the boolean `true` is not a verdict: a string
  // `"true"`, a `1`, or a `false` all leave the unclassified code where the
  // status-only fallback puts it (a 400 with a body code reads as validation).
  for (const notAFlag of ['true', 1, false]) {
    const err = graphErrorFromResponse(
      400,
      JSON.stringify({ error: { message: 'x', code: 999999, is_transient: notAFlag } }),
      redactor,
    );
    assert.equal(
      err.action?.category,
      'validation',
      `is_transient: ${JSON.stringify(notAFlag)}`,
    );
    assert.equal(err.action?.retryable, false);
  }
});

test('Graph `error_user_title` / `error_user_msg` reach the GraphApiError off the wire', () => {
  // On an ads or publishing refusal `message` is the generic "Invalid parameter";
  // the two user fields are the only human-readable reason Graph gives. They
  // ride as their own fields: `message` stays the status-prefixed Graph message
  // operators grep for, and the user text is visible without a second lookup.
  const redactor = createFakeRedactor();
  const both = graphErrorFromResponse(
    400,
    JSON.stringify({
      error: {
        message: 'Invalid parameter',
        type: 'OAuthException',
        code: 100,
        error_subcode: 1_487_390,
        error_user_title: 'Budget Too Low',
        error_user_msg: 'The daily budget must be at least $1.00.',
        fbtrace_id: 'Abudget',
      },
    }),
    redactor,
  );
  assert.equal(both.message, 'Graph API error (HTTP 400): Invalid parameter');
  assert.equal(both.userTitle, 'Budget Too Low');
  assert.equal(both.userMessage, 'The daily budget must be at least $1.00.');
  assert.equal(both.code, 100);
  assert.equal(both.subcode, 1_487_390);
  assert.equal(both.action?.category, 'validation');

  // Only the message, no title: the one present field is surfaced, the other
  // is absent rather than invented.
  const msgOnly = graphErrorFromResponse(
    400,
    JSON.stringify({
      error: {
        message: 'Invalid parameter',
        code: 100,
        error_user_msg: 'Scheduled posts must be at least 10 minutes in the future.',
      },
    }),
    redactor,
  );
  assert.equal(msgOnly.userTitle, undefined);
  assert.equal(
    msgOnly.userMessage,
    'Scheduled posts must be at least 10 minutes in the future.',
  );

  // Anything that is not a string is not user text.
  const notStrings = graphErrorFromResponse(
    400,
    JSON.stringify({
      error: { message: 'x', code: 100, error_user_title: 42, error_user_msg: { a: 1 } },
    }),
    redactor,
  );
  assert.equal(notStrings.userTitle, undefined);
  assert.equal(notStrings.userMessage, undefined);
  assert.equal(notStrings.message, 'Graph API error (HTTP 400): x');
});

test('C3: user-facing Graph error text is redacted like the message before it is surfaced', () => {
  // `error_user_msg` echoes request parameters just as `message` can; both go
  // through the same redaction choke-point so a token in either never reaches
  // the GraphApiError (and from there a journal line or a tool result).
  const token = 'EAABsecretTOKENvalue';
  const redactor = createFakeRedactor({ secrets: [token] });
  const err = graphErrorFromResponse(
    400,
    JSON.stringify({
      error: {
        message: `Invalid parameter ${token}`,
        code: 100,
        error_user_title: `Bad token ${token}`,
        error_user_msg: `The token ${token} is not valid.`,
      },
    }),
    redactor,
  );
  assert.ok(!err.message.includes(token));
  assert.equal(err.userTitle, 'Bad token [REDACTED]');
  assert.equal(err.userMessage, 'The token [REDACTED] is not valid.');
});

test('a numeric-string `code` / `error_subcode` on an error response still reaches the matrix', () => {
  // Graph sends numbers, but a hop that re-serialises the body can turn `190`
  // into `"190"`. Dropping the string leaves an expired token classified as
  // `unknown` with `code: 0` while the body plainly says otherwise. Only an
  // integer string counts, and only for the two code fields — the ETA keeps
  // its strict number type (its unit is fragile enough already).
  const redactor = createFakeRedactor();
  const expired = graphErrorFromResponse(
    400,
    JSON.stringify({
      error: {
        message: 'Error validating access token: Session has expired.',
        type: 'OAuthException',
        code: '190',
        error_subcode: '463',
      },
    }),
    redactor,
  );
  assert.equal(expired.code, 190);
  assert.equal(expired.subcode, 463);
  assert.equal(expired.action?.category, 'auth');
  assert.equal(expired.action?.retryable, false);
  assert.equal(expired.action?.nextTool, 'facebook_whoami');

  // A throttle with a string code and a string ETA: the code is honoured, the
  // ETA is not (no row-level ETA ⇒ the row's default cool-down).
  const throttled = graphErrorFromResponse(
    400,
    JSON.stringify({
      error: {
        message: 'rate limited',
        code: '4',
        estimated_time_to_regain_access: '30',
      },
    }),
    redactor,
  );
  assert.equal(throttled.code, 4);
  assert.equal(throttled.action?.category, 'rate_limit');
  assert.equal(throttled.action?.retryAfterMs, 60_000);

  // Not integers: no code, so the status-only fallback applies as before.
  for (const notACode of ['abc', '1e3', '12.5', ' 12', '', '0x10']) {
    const err = graphErrorFromResponse(
      400,
      JSON.stringify({ error: { message: 'x', type: 'OAuthException', code: notACode } }),
      redactor,
    );
    assert.equal(err.code, 0, `code: ${JSON.stringify(notACode)}`);
    assert.equal(err.action?.category, 'unknown', `code: ${JSON.stringify(notACode)}`);
  }
});

test('a 400 whose envelope carries only a string code is an error, not data', async () => {
  // Without `type` the string code is the only thing that marks the body as an
  // envelope; read as "no code" it makes a 400 surface as `unknown` instead of
  // the auth refusal it is.
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 400,
      json: { error: { message: 'Invalid OAuth access token.', code: '190' } },
    });
    const fbRequest = createFbRequest(makeDeps());
    await assert.rejects(
      fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      (err: unknown) =>
        err instanceof GraphApiError &&
        err.code === 190 &&
        err.httpStatus === 400 &&
        err.action?.category === 'auth',
    );
    assert.equal(mock.requests.length, 1, 'an auth refusal is never retried');
  });
});

test('CC-NET-6: a non-JSON error body surfaces the proxy self-diagnosis', () => {
  const redactor = createFakeRedactor();
  const err = graphErrorFromResponse(
    403,
    '<html><body>Blocked by corporate proxy</body></html>',
    redactor,
  );
  assert.equal(err.action?.category, 'unknown');
  assert.equal(err.action?.retryable, false);
  assert.ok(
    err.action?.operatorText.includes(PROXY_ENV_HINT),
    'an HTML body where a Graph envelope belongs is the interception signature',
  );
});

test('CC-NET-4: a non-JSON body is surfaced as a bounded snippet and stays classified', () => {
  const redactor = createFakeRedactor();
  const long = graphErrorFromResponse(503, `<html>${'x'.repeat(500)}</html>`, redactor);
  assert.equal(long.httpStatus, 503);
  assert.equal(long.code, 0, 'no envelope ⇒ no Graph code');
  assert.equal(long.action?.category, 'transient');
  assert.equal(long.action?.retryable, true);
  assert.ok(long.message.includes('xxxxxxxxxx'));
  assert.ok(
    long.message.length <= NON_JSON_BODY_MAX + 40,
    'the snippet is bounded (plus the short status prefix)',
  );
  assert.ok(long.action?.operatorText.includes(PROXY_ENV_HINT));

  // An empty 5xx body: still no envelope, still classified, still hinted.
  const empty = graphErrorFromResponse(500, '', redactor);
  assert.match(empty.message, /HTTP 500/);
  assert.equal(empty.action?.category, 'transient');
  assert.ok(empty.action?.operatorText.includes(PROXY_ENV_HINT));
});

test('CC-PAGE-2: a cursor rejection reaches the caller through the live client', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.on(() => true, {
      status: 400,
      text: cursorBody('Invalid cursor: this cursor has expired', 1),
    });
    const fbRequest = createFbRequest(makeDeps({ retry: { maxRetries: 2 } }));
    await assert.rejects(
      fbRequest({
        protocol: 'json',
        host: 'graph',
        method: 'GET',
        path: '/123/feed',
        params: { after: 'QVFIUmJjcnNvcg' },
      }),
      (err: unknown) =>
        err instanceof GraphApiError &&
        err.action?.category === 'cursor_expired' &&
        err.action.retryable === false,
    );
    assert.equal(mock.requests.length, 1, 'a dead cursor is never retried');
  });
});

test('throttle exhaustion surfaces a rate_limit error and stops retrying', async () => {
  await withFetch(async (mock: FetchMock) => {
    const clock = createFakeClock();
    mock.on(() => true, { status: 400, json: throttleBody(32) });
    const fbRequest = createFbRequest(makeDeps({ clock, retry: { maxRetries: 2 } }));
    await assert.rejects(
      settle(
        clock,
        fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      ),
      (err: unknown) =>
        err instanceof GraphApiError && err.action?.category === 'rate_limit',
    );
    assert.equal(mock.requests.length, 3, 'initial + 2 retries');
  });
});

test('an aborted signal during backoff stops the retry loop (no replay)', async () => {
  await withFetch(async (mock: FetchMock) => {
    const clock = createFakeClock();
    const controller = new AbortController();
    mock.on(() => true, { status: 400, json: throttleBody(4) });
    const fbRequest = createFbRequest(makeDeps({ clock }));
    const promise = fbRequest({
      protocol: 'json',
      host: 'graph',
      method: 'GET',
      path: '/me',
      signal: controller.signal,
    });
    const rejected = assert.rejects(promise, /abort/i);
    // Let the first attempt run and park in backoff, then abort.
    for (let i = 0; i < 50 && clock.pendingSleeps() === 0; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    controller.abort();
    await rejected;
    assert.equal(mock.requests.length, 1, 'aborted before any retry');
  });
});

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

// ---------------------------------------------------------------------------
// Wave 15 (lane A): throttle usage, Retry-After bounds, snippet redaction,
// the exported connect-phase predicate
// ---------------------------------------------------------------------------

test('an exhausted throttle keeps the usage headers of the response that refused it', async () => {
  // Graph names the full bucket ON the throttle response itself. Every throttle
  // row sends the caller to facebook_usage, whose own probe is refused by the
  // same throttle, so this response is the only place the figures exist.
  await withFetch(async (mock: FetchMock) => {
    const clock = createFakeClock();
    mock.on(() => true, {
      status: 400,
      json: throttleBody(4),
      headers: {
        'x-app-usage': '{"call_count":100,"total_cputime":40,"total_time":35}',
        'x-business-use-case-usage':
          '{"1234":[{"type":"pages","call_count":12,"total_cputime":5,"total_time":5,"estimated_time_to_regain_access":0}]}',
      },
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
        const usage = usageOfGraphError(err);
        assert.ok(
          usage,
          'the usage snapshot of the throttle response must survive on the error',
        );
        assert.equal(usage.appUsagePct, 100);
        assert.equal(usage.businessUseCasePct, 12);
        assert.ok(usage.raw['x-app-usage'] !== undefined);
        return true;
      },
    );
  });
});

test('a terminal Graph error keeps its usage headers too, and none is invented when absent', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 400,
      json: {
        error: { message: 'Invalid parameter', type: 'OAuthException', code: 100 },
      },
      headers: { 'x-app-usage': '{"call_count":71,"total_cputime":3,"total_time":3}' },
    });
    mock.enqueue({
      status: 400,
      json: {
        error: { message: 'Invalid parameter', type: 'OAuthException', code: 100 },
      },
    });
    const fbRequest = createFbRequest(makeDeps());
    const req: FbRequest = {
      protocol: 'json',
      host: 'graph',
      method: 'GET',
      path: '/me',
    };
    const first = await fbRequest(req).then(
      () => assert.fail('expected a rejection'),
      (e: unknown) => e,
    );
    assert.equal(usageOfGraphError(first)?.appUsagePct, 71);
    const second = await fbRequest(req).then(
      () => assert.fail('expected a rejection'),
      (e: unknown) => e,
    );
    assert.ok(second instanceof GraphApiError);
    assert.equal(usageOfGraphError(second), undefined);
    assert.equal(usageOfGraphError(new Error('not a graph error')), undefined);
  });
});

test('an ambiguous 5xx on a write keeps the usage headers of its response', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 500,
      json: { error: { message: 'An unknown error occurred', code: 1 } },
      headers: { 'x-app-usage': '{"call_count":88,"total_cputime":4,"total_time":4}' },
    });
    const fbRequest = createFbRequest(makeDeps());
    const err = await fbRequest({
      protocol: 'json',
      host: 'graph',
      method: 'POST',
      path: '/123/feed',
      body: { message: 'hi' },
    }).then(
      () => assert.fail('expected a rejection'),
      (e: unknown) => e,
    );
    assert.ok(err instanceof GraphApiError);
    assert.equal(usageOfGraphError(err)?.appUsagePct, 88);
  });
});

test('a Retry-After too large to be a number is not surfaced as an infinite wait', async () => {
  const huge = '9'.repeat(400); // Number(huge) === Infinity
  assert.equal(parseRetryAfterMs(huge, 0), undefined);
  await withFetch(async (mock: FetchMock) => {
    const clock = createFakeClock();
    mock.on(() => true, {
      status: 429,
      text: 'Too Many Requests',
      headers: { 'retry-after': huge },
    });
    const fbRequest = createFbRequest(makeDeps({ clock, retry: { maxRetries: 0 } }));
    await assert.rejects(
      settle(
        clock,
        fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      ),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        const wait = err.action?.retryAfterMs;
        // JSON.stringify(Infinity) is `null`: the caller would be told nothing.
        assert.ok(
          wait === undefined || Number.isFinite(wait),
          `retryAfterMs=${String(wait)}`,
        );
        return true;
      },
    );
  });
});

test('a secret straddling the non-JSON snippet cut is redacted before the cut, not after', () => {
  // A proxy error page that echoes the request URL (appsecret_proof rides in a
  // GET query) — cut at NON_JSON_BODY_MAX mid-proof, a partial value matches
  // neither the exact-value scan nor the 64-hex pattern.
  const proof = computeAppSecretProof(TOKEN, APP_SECRET);
  const url = 'https://graph.facebook.com/v21.0/me?appsecret_proof=';
  const prefix = '<html><body>The requested URL could not be retrieved: ';
  // The proof starts 20 characters before the cut.
  const filler = 'x'.repeat(NON_JSON_BODY_MAX - 20 - prefix.length - url.length);
  const body = `${prefix}${filler}${url}${proof}</body></html>`;
  const at = body.indexOf(proof);
  assert.ok(at < NON_JSON_BODY_MAX && at + proof.length > NON_JSON_BODY_MAX, 'straddles');
  for (const redactor of [createRedactor({ secrets: [proof] }), createFakeRedactor()]) {
    redactor.addSecret(proof);
    const err = graphErrorFromResponse(502, body, redactor);
    const leaked = proof.slice(0, NON_JSON_BODY_MAX - at);
    assert.ok(leaked.length >= 8);
    assert.ok(!err.message.includes(leaked), `proof prefix leaked: ${err.message}`);
    assert.ok(err.message.length <= NON_JSON_BODY_MAX + 40, 'the snippet stays bounded');
  }
});

test('isProvablyNotSent: only a connect-phase code (direct or on the cause) proves not-sent', () => {
  // Regression coverage for the newly exported predicate (no behaviour change).
  for (const code of [
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
  ]) {
    assert.equal(isProvablyNotSent(Object.assign(new Error('x'), { code })), true, code);
    assert.equal(
      isProvablyNotSent(new TypeError('fetch failed', { cause: { code } })),
      true,
      `cause ${code}`,
    );
  }
  for (const err of [
    Object.assign(new Error('x'), { code: 'ECONNRESET' }),
    new TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } }),
    new DOMException('timed out', 'TimeoutError'),
    new Error('terminated'),
    'ECONNREFUSED',
    undefined,
    null,
  ]) {
    assert.equal(isProvablyNotSent(err), false, String(err));
  }
});

// ---------------------------------------------------------------------------
// C2: the ambiguous-write verify tool must match what was written
// ---------------------------------------------------------------------------

/** Assert an ambiguous write error names no posts-listing verify tool. */
function assertNoPostsVerifyTool(err: unknown): true {
  assert.ok(err instanceof GraphApiError);
  assert.equal(err.action?.category, 'ambiguous');
  assert.equal(err.action?.retryable, false);
  assert.equal(
    err.action?.nextTool,
    undefined,
    'a write that is not a feed post must not name a verify tool it cannot be verified with',
  );
  assert.doesNotMatch(String(err.action?.operatorText), /facebook_list_posts/);
  assert.doesNotMatch(String(err.action?.operatorText), /facebook_get_conversation/);
  assert.match(String(err.action?.operatorText), /re-read the object/);
  return true;
}

test('C2: an ambiguous DELETE on a comment does not point the caller at facebook_list_posts', async () => {
  // A comment delete whose response is a 502: the comment may be gone. A posts
  // listing does not carry comments, so naming it sends the model to a read
  // that cannot answer "did the delete land".
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 502, text: 'Bad Gateway' });
    const fbRequest = createFbRequest(makeDeps());
    await assert.rejects(
      fbRequest({ protocol: 'json', host: 'graph', method: 'DELETE', path: '/111_222' }),
      assertNoPostsVerifyTool,
    );
    assert.equal(mock.requests.length, 1, 'the delete must not be replayed');
  });
});

test('C2: an ambiguous POST on an ad object does not point the caller at facebook_list_posts', async () => {
  // An ad budget/status change lost mid-flight: the ad object has to be re-read,
  // the Page's posts say nothing about it.
  await withFetch(async (mock: FetchMock) => {
    const fbRequest = createFbRequest(makeDeps());
    await assert.rejects(
      fbRequest({
        protocol: 'json',
        host: 'graph',
        method: 'POST',
        path: '/120000000000001',
        body: { daily_budget: 5000 },
      }),
      assertNoPostsVerifyTool,
    );
    assert.equal(mock.requests.length, 1);
  });
});

test('C2: an ambiguous scheduled feed post points at facebook_list_scheduled_posts, a draft at no tool', async () => {
  // A scheduled post never appears on the published listing until it goes
  // live, so "verify on facebook_list_posts" would read as "it did not land".
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 503, text: 'Service Unavailable' });
    const fbRequest = createFbRequest(makeDeps());
    await assert.rejects(
      fbRequest({
        protocol: 'json',
        host: 'graph',
        method: 'POST',
        path: '/123/feed',
        body: { message: 'x', published: false, scheduled_publish_time: 1_900_000_000 },
      }),
      (err: unknown) =>
        err instanceof GraphApiError &&
        err.action?.category === 'ambiguous' &&
        err.action.nextTool === 'facebook_list_scheduled_posts' &&
        !/facebook_list_posts/.test(err.action.operatorText),
    );
  });
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 503, text: 'Service Unavailable' });
    const fbRequest = createFbRequest(makeDeps());
    await assert.rejects(
      fbRequest({
        protocol: 'json',
        host: 'graph',
        method: 'POST',
        path: '/123/feed',
        body: { message: 'x', published: false },
      }),
      assertNoPostsVerifyTool,
    );
  });
});

test('an ambiguous graphErrorFromResponse names no post-listing verify tool', () => {
  const err = graphErrorFromResponse(502, '', createFakeRedactor(), {
    category: 'ambiguous',
  });
  assert.equal(err.action?.category, 'ambiguous');
  assert.equal(err.action?.nextTool, undefined);
  assert.doesNotMatch(err.action?.operatorText ?? '', /facebook_/);
});

test('a write the api layer names a verify tool for carries it on the ambiguous guidance', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 502, text: 'Bad Gateway' });
    const fbRequest = createFbRequest(makeDeps());
    await assert.rejects(
      fbRequest({
        protocol: 'json',
        host: 'graph',
        method: 'DELETE',
        path: '/111_222',
        verifyTool: 'facebook_get_comment',
      }),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        assert.equal(err.action?.category, 'ambiguous');
        assert.equal(err.action?.nextTool, 'facebook_get_comment');
        assert.match(
          err.action?.operatorText ?? '',
          /verify via facebook_get_comment first/,
        );
        return true;
      },
    );
    assert.equal(mock.requests.length, 1);
    assert.equal(
      mock.requests[0]?.url.includes('verifyTool'),
      false,
      'the hint never reaches Graph',
    );
  });
});

test('usageOfGraphError finds the snapshot on a re-worded error through its cause', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 400,
      json: {
        error: { message: 'Invalid parameter', type: 'OAuthException', code: 100 },
      },
      headers: { 'x-app-usage': '{"call_count":64,"total_cputime":3,"total_time":3}' },
    });
    const fbRequest = createFbRequest(makeDeps());
    const original = await fbRequest({
      protocol: 'json',
      host: 'graph',
      method: 'GET',
      path: '/me',
    }).then(
      () => assert.fail('expected a rejection'),
      (e: unknown) => e,
    );
    assert.ok(original instanceof GraphApiError);
    const reworded = new GraphApiError('a clearer message', {
      code: 100,
      httpStatus: 400,
      cause: original,
    });
    assert.equal(usageOfGraphError(reworded)?.appUsagePct, 64);
    assert.equal(
      usageOfGraphError(new GraphApiError('bare', { code: 1, httpStatus: 400 })),
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// Wave 23 — a transient Graph code on a write is ambiguous at any status, and a
// server-named wait the transport will not sleep through fails fast.
// ---------------------------------------------------------------------------

test('C2: a transient Graph code (1/2, or is_transient) on a write is ambiguous at any HTTP status', async () => {
  // Graph's code 1 ("unknown error") and code 2 ("service unavailable") are its
  // own 5xx-class faults, but they arrive as HTTP 400 (and sometimes inside a
  // 200). Keyed on the status alone, a write that met one was surfaced with the
  // matrix's `retryable: true` — an invitation to repeat a publish that may
  // already be live.
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
          assert.ok(err instanceof GraphApiError, label);
          assert.equal(err.action?.category, 'ambiguous', label);
          assert.equal(err.action?.retryable, false, label);
          assert.equal(err.action?.nextTool, 'facebook_list_posts', label);
          assert.equal(err.httpStatus, status, label);
          return true;
        },
      );
      assert.equal(mock.requests.length, 1, `${label}: the write must not be replayed`);
    });
  }
});

test('regression: a transient Graph code on a GET stays a retryable transient', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 400,
      json: {
        error: { code: 1, message: 'An unknown error occurred', type: 'OAuthException' },
      },
    });
    const fbRequest = createFbRequest(makeDeps());
    await assert.rejects(
      fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        assert.equal(err.action?.category, 'transient');
        assert.equal(err.action?.retryable, true);
        return true;
      },
    );
  });
});

test('CC-NET-3: a server-named wait beyond the sleep cap fails fast with the real wait', async () => {
  // Sleeping the capped 60s and retrying lands every attempt inside a window
  // the server said is still closed — hammering a blocked endpoint for minutes
  // while holding a host permit — and the caller hears the real wait only after
  // all of that, if its own timeout has not fired first.
  for (const [label, response, expectedMs, category] of [
    [
      'ETA 60 minutes',
      { status: 400, json: throttleBody(4, 60) },
      3_600_000,
      'rate_limit',
    ],
    [
      'Retry-After 3600 on a 429',
      { status: 429, text: 'Too Many Requests', headers: { 'retry-after': '3600' } },
      3_600_000,
      'rate_limit',
    ],
    [
      'Retry-After 120 on a 503',
      { status: 503, text: 'Service Unavailable', headers: { 'retry-after': '120' } },
      120_000,
      'transient',
    ],
  ] as const) {
    const { clock, sleeps } = createRecordingClock();
    await withFetch(async (mock: FetchMock) => {
      mock.on(() => true, response);
      const fbRequest = createFbRequest(makeDeps({ clock, rng: () => 1 }));
      await assert.rejects(
        settle(
          clock,
          fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
        ),
        (err: unknown) => {
          assert.ok(err instanceof GraphApiError, label);
          assert.equal(err.action?.category, category, label);
          assert.equal(err.action?.retryAfterMs, expectedMs, label);
          return true;
        },
      );
      assert.deepEqual(sleeps, [], `${label}: nothing is slept`);
      assert.equal(mock.requests.length, 1, `${label}: no retry inside the window`);
    });
  }
});

test('regression CC-NET-3: a server-named wait exactly at the cap is still slept, then retried', async () => {
  const { clock, sleeps } = createRecordingClock();
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 400, json: throttleBody(4, 1) });
    mock.enqueue({ status: 200, json: {} });
    const fbRequest = createFbRequest(makeDeps({ clock, rng: () => 1 }));
    await settle(
      clock,
      fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
    );
    assert.deepEqual(sleeps, [60_000]);
    assert.equal(mock.requests.length, 2);
  });
});

/**
 * An `X-Business-Use-Case-Usage` header in Meta's documented shape: one bucket
 * per business object, each naming its own `estimated_time_to_regain_access`
 * (MINUTES — the same unit as the envelope field).
 */
function bucUsageHeader(etaByObject: Readonly<Record<string, number>>): string {
  const rec: Record<string, unknown> = {};
  for (const [id, eta] of Object.entries(etaByObject)) {
    rec[id] = [
      {
        type: 'pages',
        call_count: 100,
        total_cputime: 30,
        total_time: 40,
        estimated_time_to_regain_access: eta,
      },
    ];
  }
  return JSON.stringify(rec);
}

test('CC-NET-3: a business-use-case throttle honors the regain-access ETA its usage header names', async () => {
  // Graph's 80000-80099 envelope carries no ETA of its own: the wait lives in
  // the X-Business-Use-Case-Usage header of the refusing response. Ignored, the
  // client re-hit a bucket blocked for 25 minutes four more times inside ~8s,
  // then told the caller to come back in the matrix's default 60s.
  const { clock, sleeps } = createRecordingClock();
  await withFetch(async (mock: FetchMock) => {
    mock.on(() => true, {
      status: 400,
      json: throttleBody(80001),
      headers: { 'x-business-use-case-usage': bucUsageHeader({ '111': 25, '222': 0 }) },
    });
    const fbRequest = createFbRequest(makeDeps({ clock, rng: () => 1 }));
    await assert.rejects(
      settle(
        clock,
        fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      ),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        assert.equal(err.action?.category, 'rate_limit');
        assert.equal(err.action?.retryAfterMs, 25 * 60_000);
        return true;
      },
    );
    assert.deepEqual(sleeps, [], 'a 25-minute block is not slept through');
    assert.equal(mock.requests.length, 1, 'no retry inside the blocked window');
  });
});

test('CC-NET-3: a business-use-case ETA within the cap is slept in full before the retry', async () => {
  const { clock, sleeps } = createRecordingClock();
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 400,
      json: throttleBody(80001),
      headers: { 'x-business-use-case-usage': bucUsageHeader({ '111': 1 }) },
    });
    mock.enqueue({ status: 200, json: {} });
    const fbRequest = createFbRequest(makeDeps({ clock, rng: () => 0 }));
    await settle(
      clock,
      fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
    );
    assert.deepEqual(sleeps, [60_000]);
    assert.equal(mock.requests.length, 2);
  });
});

test('regression CC-NET-3: a zero business-use-case ETA leaves the exponential schedule standing', async () => {
  const { clock, sleeps } = createRecordingClock();
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 400,
      json: throttleBody(80001),
      headers: { 'x-business-use-case-usage': bucUsageHeader({ '111': 0 }) },
    });
    mock.enqueue({ status: 200, json: {} });
    const fbRequest = createFbRequest(makeDeps({ clock, rng: () => 1 }));
    await settle(
      clock,
      fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
    );
    assert.deepEqual(sleeps, [500]);
    assert.equal(mock.requests.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Wave 27 (lane A): a 2xx whose body is not JSON is not data
// ---------------------------------------------------------------------------

const PROXY_PAGE = '<html><body>Access to this site is blocked by policy</body></html>';

test('a 2xx GET whose body is not JSON is a classified error, never data an api read reads as empty', async () => {
  // A proxy / captive-portal page answered 200 in Graph's place, or a JSON body
  // arrived cut short. Handed back as a string `data`, every list edge parses
  // it as a page with no rows (`facebook_list_posts` reports "no posts") and a
  // node read calls the object not found — both false.
  const bodies = [PROXY_PAGE, '{"data":[{"id":"1_2","message":"hi"},{"id":"1_'];
  await withFetch(async (mock: FetchMock) => {
    const fbRequest = createFbRequest(makeDeps());
    for (const text of bodies) {
      mock.enqueue({ status: 200, text, headers: { 'content-type': 'text/html' } });
      await assert.rejects(
        fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/1/feed' }),
        (err: unknown) => {
          assert.ok(err instanceof GraphApiError, `body ${text}`);
          assert.equal(err.httpStatus, 200);
          assert.notEqual(err.action?.category, 'not_found');
          assert.match(err.action?.operatorText ?? '', /non-JSON body/);
          assert.ok(err.action?.operatorText.includes(PROXY_ENV_HINT));
          return true;
        },
      );
    }
    assert.equal(mock.requests.length, bodies.length, 'not retried automatically');
  });
});

test('C2: a 2xx write whose body is not JSON is ambiguous, never a refusal or a confirmation', async () => {
  // A DELETE on a comment answered 200 with a proxy page: the comment API reads
  // an unparsed string as "Facebook did not say yes" and reports the delete as
  // not applied — for a delete that may have landed.
  await withFetch(async (mock: FetchMock) => {
    mock.on(() => true, { status: 200, text: PROXY_PAGE });
    const fbRequest = createFbRequest(makeDeps());
    await assert.rejects(
      fbRequest({
        protocol: 'json',
        host: 'graph',
        method: 'DELETE',
        path: '/123_456',
        verifyTool: 'facebook_get_comment',
      }),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        assert.equal(err.action?.category, 'ambiguous');
        assert.equal(err.action.retryable, false);
        assert.equal(err.action.nextTool, 'facebook_get_comment');
        assert.equal(err.httpStatus, 200);
        assert.match(err.message, /ambiguous write outcome/);
        assert.match(err.message, /not JSON/);
        return true;
      },
    );
    assert.equal(mock.requests.length, 1, 'a write is never re-sent');
  });
});

test('regression: a 2xx JSON string, array or empty body still passes through as data', async () => {
  await withFetch(async (mock: FetchMock) => {
    const fbRequest = createFbRequest(makeDeps());
    for (const [text, expected] of [
      ['"ok"', 'ok'],
      ['[1,2]', [1, 2]],
      ['  {"id":"1"}\n', { id: '1' }],
      ['', undefined],
    ] as const) {
      mock.enqueue({ status: 200, text });
      const res = await fbRequest({
        protocol: 'json',
        host: 'graph',
        method: 'POST',
        path: '/1/comments',
        body: { message: 'x' },
      });
      assert.deepEqual(res.data, expected, `body ${JSON.stringify(text)}`);
    }
  });
});
