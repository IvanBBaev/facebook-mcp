// Tests for the Graph HTTP client (`core/http.ts`): throttle usage, Retry-After bounds,
// snippet redaction and ambiguous writes.
//
// Split out of `http.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/http.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFbRequest,
  computeAppSecretProof,
  graphErrorFromResponse,
  isProvablyNotSent,
  parseRetryAfterMs,
  usageOfGraphError,
} from './http.js';
import { NON_JSON_BODY_MAX } from './errors.js';
import { DEFAULT_THROTTLE_RETRY_AFTER_MS } from './error-matrix.js';
import { createRedactor } from './redact.js';
import { GraphApiError } from './index.js';
import type { FbRequest } from './index.js';
import { createFakeClock, createFakeRedactor } from './fakes/index.js';
import { withFetch, type FetchMock } from '../testing/index.js';
import {
  APP_SECRET,
  TOKEN,
  createRecordingClock,
  makeDeps,
  settle,
  throttleBody,
} from '../testing/harness/http.js';

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

test('CC-NET-3: an envelope ETA that overflows to Infinity ms is no wait at all', async () => {
  // `1e307` minutes is a finite number, so it survives the envelope parse, but
  // ×60_000 it is `Infinity`. That used to become the surfaced `retryAfterMs`
  // — which serialises to `null`, telling the caller nothing — and, as a wait
  // "beyond the cap", it also suppressed every retry. Like a `0` or a negative
  // ETA it is no instruction: the throttle keeps its ordinary retry schedule
  // and surfaces the matrix's finite default.
  const { clock, sleeps } = createRecordingClock();
  await withFetch(async (mock: FetchMock) => {
    mock.on(() => true, { status: 400, json: throttleBody(4, 1e307) });
    const fbRequest = createFbRequest(
      makeDeps({ clock, rng: () => 1, retry: { maxRetries: 1 } }),
    );
    await assert.rejects(
      settle(
        clock,
        fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      ),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        assert.equal(err.action?.category, 'rate_limit');
        assert.equal(err.action?.retryAfterMs, DEFAULT_THROTTLE_RETRY_AFTER_MS);
        return true;
      },
    );
    assert.equal(sleeps.length, 1, 'the ordinary backoff schedule still applies');
    assert.ok(Number.isFinite(sleeps[0]));
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
