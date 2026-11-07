// Tests for the Graph HTTP client (`core/http.ts`): auth, the host allowlist and the pure
// retry classification.
//
// Split out of `http.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/http.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  apiVersionFor,
  createFbRequest,
  computeAppSecretProof,
  resolveHostBase,
  classifyHttpError,
  isThrottleCode,
  retryVerdict,
  bestEffortCategory,
} from './http.js';
import { GraphApiError } from './index.js';
import type { FbResponse } from './index.js';
import { createFakeRedactor } from './fakes/index.js';
import { withFetch, type FetchMock } from '../testing/index.js';
import {
  APP_SECRET,
  HOSTS,
  TOKEN,
  breakNextBodyRead,
  createTestLogger,
  makeDeps,
  makeSettings,
} from '../testing/harness/http.js';

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

test('doc 12 H1: a marketing request uses the ads pin, a graph request keeps the Graph pin', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ json: {} });
    mock.enqueue({ json: {} });
    mock.enqueue({ json: {} });
    const fbRequest = createFbRequest(makeDeps());
    await fbRequest({
      protocol: 'json',
      host: 'graph',
      method: 'GET',
      path: '/act_1/campaigns',
      api: 'marketing',
    });
    assert.equal(
      new URL(mock.lastRequest()?.url ?? '').pathname,
      '/v26.0/act_1/campaigns',
    );
    await fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' });
    assert.equal(new URL(mock.lastRequest()?.url ?? '').pathname, '/v21.0/me');
    await fbRequest({
      protocol: 'json',
      host: 'graph',
      method: 'GET',
      path: '/123/insights',
      api: 'graph',
    });
    assert.equal(new URL(mock.lastRequest()?.url ?? '').pathname, '/v21.0/123/insights');
  });
});

test('apiVersionFor picks the ads pin only for the marketing family', () => {
  const settings = { apiVersion: 'v23.0', adsApiVersion: 'v26.0' };
  assert.equal(apiVersionFor(settings, 'marketing'), 'v26.0');
  assert.equal(apiVersionFor(settings, 'graph'), 'v23.0');
  assert.equal(apiVersionFor(settings, undefined), 'v23.0');
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
