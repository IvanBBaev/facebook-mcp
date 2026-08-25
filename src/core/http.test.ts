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
  type FbRequestDeps,
  type HostSemaphores,
} from './http.js';
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
  assert.equal(bestEffortCategory(500, undefined), 'transient');
  assert.equal(bestEffortCategory(400, 2635), 'validation');
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

test('CC-NET-3: backoff honors estimated_time_to_regain_access but caps at 60s', async () => {
  const sleeps: number[] = [];
  const base = createFakeClock();
  // Wrap the clock to record the requested sleep durations.
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
    // An ETA of 60 MINUTES (3_600_000 ms) must be clamped to the 60s cap.
    mock.enqueue({ status: 400, json: throttleBody(4, 60) });
    mock.enqueue({ status: 200, json: {} });

    const fbRequest = createFbRequest(makeDeps({ clock, rng: () => 1 }));
    await settle(
      clock,
      fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
    );
    assert.equal(sleeps.length, 1);
    // rng()=1 ⇒ equal jitter yields the full base; base clamped to the 60s cap.
    assert.equal(sleeps[0], 60_000);
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
