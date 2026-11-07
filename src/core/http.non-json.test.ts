// Tests for the Graph HTTP client (`core/http.ts`): a 2xx whose body is not JSON, and the
// API-version drift headers.
//
// Split out of `http.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/http.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFbRequest,
  computeAppSecretProof,
  resolveHostBase,
  usageOfGraphError,
} from './http.js';
import { PROXY_ENV_HINT } from './errors.js';
import { createVersionDriftMonitor, VERSION_DRIFT_LOG_MSG } from './version-drift.js';
import { GraphApiError } from './index.js';
import { createFakeRedactor } from './fakes/index.js';
import { withFetch, type FetchMock } from '../testing/index.js';
import {
  APP_SECRET,
  HOSTS,
  type RecordedLog,
  TOKEN,
  type TestLogger,
  breakNextBodyRead,
  createTestLogger,
  makeDeps,
  makeSettings,
} from '../testing/harness/http.js';

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

test('a DELETE with a body sends it form-encoded and keeps the proof in the query', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ json: { success: true } });
    const fbRequest = createFbRequest(makeDeps());

    await fbRequest({
      protocol: 'json',
      host: 'graph',
      method: 'DELETE',
      path: '/123_456',
      body: {
        reason: 'spam',
        count: 3,
        notify: false,
        meta: { a: 1 },
        skipped: undefined,
      },
    });

    const req = mock.lastRequest();
    assert.ok(req);
    assert.equal(req.method, 'DELETE');
    assert.equal(
      new URL(req.url).searchParams.get('appsecret_proof'),
      computeAppSecretProof(TOKEN, APP_SECRET),
    );
    assert.equal(req.body.kind, 'urlencoded');
    if (req.body.kind === 'urlencoded') {
      assert.equal(req.body.params['reason'], 'spam');
      assert.equal(req.body.params['count'], '3');
      assert.equal(req.body.params['notify'], 'false');
      // Objects travel as JSON strings, the way Graph reads structured params.
      assert.equal(req.body.params['meta'], '{"a":1}');
      assert.equal('skipped' in req.body.params, false);
      assert.equal('appsecret_proof' in req.body.params, false);
    }
  });
});

test('resolveHostBase refuses a host whose hostname is not configured', () => {
  assert.throws(
    () => resolveHostBase({ ...HOSTS, rupload: '' }, 'rupload'),
    /no hostname configured for host 'rupload'/,
  );
});

test('a response body lost on every attempt of a read ends as a network error', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status: 200, json: { ok: 1 } });
    breakNextBodyRead('terminated');
    const fbRequest = createFbRequest(makeDeps({ retry: { maxRetries: 0 } }));

    await assert.rejects(
      fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        assert.match(err.message, /terminated/);
        assert.equal(err.action?.category, 'transient');
        return true;
      },
    );
    assert.equal(mock.requests.length, 1);
  });
});

test('an unrecognized code on a 429 or a 5xx still gets operator text for its category', async () => {
  // Codes the error matrix has no row for fall back to a status-derived
  // category, and that category's generic guidance must still reach the operator.
  for (const [status, category] of [
    [429, 'rate_limit'],
    [503, 'transient'],
  ] as const) {
    await withFetch(async (mock: FetchMock) => {
      mock.enqueue({
        status,
        json: {
          error: { message: 'Something new', type: 'OAuthException', code: 987_654 },
        },
      });
      const fbRequest = createFbRequest(makeDeps({ retry: { maxRetries: 0 } }));
      await assert.rejects(
        fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' }),
        (err: unknown) => {
          assert.ok(err instanceof GraphApiError);
          assert.equal(err.action?.category, category, `HTTP ${status}`);
          assert.ok((err.action?.operatorText.length ?? 0) > 0, `HTTP ${status}`);
          assert.notEqual(err.action?.operatorText, 'request failed', `HTTP ${status}`);
          return true;
        },
      );
    });
  }
});

test('usageOfGraphError stops following re-wrapped errors after a bounded depth', () => {
  let err = new GraphApiError('innermost', { code: 1, httpStatus: 400 });
  for (let i = 0; i < 6; i += 1) {
    err = new GraphApiError(`wrap ${String(i)}`, {
      code: 1,
      httpStatus: 400,
      cause: err,
    });
  }
  assert.equal(usageOfGraphError(err), undefined);
});

// ---------------------------------------------------------------------------
// API-version drift headers (doc 12 H1, runbook app-upkeep §2)
// ---------------------------------------------------------------------------

const AUTO_UPGRADE_NOTICE =
  'The call has been auto-upgraded to v26.0 as v25.0 has been deprecated';

function driftEntries(logger: TestLogger): readonly RecordedLog[] {
  return logger.entries.filter((entry) => entry.msg === VERSION_DRIFT_LOG_MSG);
}

test('X-Ad-Api-Version-Warning is logged once as a warn and never fails the call', async () => {
  await withFetch(async (mock: FetchMock) => {
    for (let i = 0; i < 3; i += 1) {
      mock.enqueue({
        json: { id: 'act_1' },
        headers: { 'X-Ad-Api-Version-Warning': AUTO_UPGRADE_NOTICE },
      });
    }
    const logger = createTestLogger();
    const fbRequest = createFbRequest(
      makeDeps({ logger, settings: makeSettings({ adsApiVersion: 'v25.0' }) }),
    );
    for (let i = 0; i < 3; i += 1) {
      const res = await fbRequest<{ id: string }>({
        protocol: 'json',
        host: 'graph',
        method: 'GET',
        path: '/act_1',
        api: 'marketing',
      });
      assert.deepEqual(res.data, { id: 'act_1' });
      // The raw header still rides the envelope.
      assert.equal(res.headers['x-ad-api-version-warning'], AUTO_UPGRADE_NOTICE);
    }
    const entries = driftEntries(logger);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.level, 'warn');
    assert.equal(entries[0]?.fields?.['kind'], 'ad-api-version-warning');
    assert.equal(entries[0]?.fields?.['requestedVersion'], 'v25.0');
    assert.equal(entries[0]?.fields?.['api'], 'marketing');
  });
});

test('a served facebook-api-version that differs from the pin is logged as a mismatch', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ json: {}, headers: { 'facebook-api-version': 'v21.0' } });
    mock.enqueue({ json: {}, headers: { 'facebook-api-version': 'v22.0' } });
    const logger = createTestLogger();
    const fbRequest = createFbRequest(makeDeps({ logger }));
    // Served == requested (Graph pin v21.0): no signal.
    await fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' });
    assert.equal(driftEntries(logger).length, 0);
    // Graph substituted another version: one signal, call still answered.
    const res = await fbRequest({
      protocol: 'json',
      host: 'graph',
      method: 'GET',
      path: '/me',
    });
    assert.equal(res.status, 200);
    const entries = driftEntries(logger);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.fields?.['kind'], 'served-version-mismatch');
    assert.equal(entries[0]?.fields?.['value'], 'v22.0');
    assert.equal(entries[0]?.fields?.['requestedVersion'], 'v21.0');
  });
});

test('a path-forced version is what the served version is compared against', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ json: {}, headers: { 'facebook-api-version': 'v19.0' } });
    const logger = createTestLogger();
    const fbRequest = createFbRequest(makeDeps({ logger }));
    await fbRequest({
      protocol: 'json',
      host: 'graph',
      method: 'GET',
      path: '/v19.0/act_1/campaigns',
    });
    assert.equal(driftEntries(logger).length, 0);
  });
});

test('a drift header on an error response is still observed, and the error is the Graph one', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 400,
      headers: { 'x-ad-api-version-warning': AUTO_UPGRADE_NOTICE },
      json: {
        error: { message: 'Invalid parameter', type: 'OAuthException', code: 100 },
      },
    });
    const logger = createTestLogger();
    const versionDrift = createVersionDriftMonitor({
      logger,
      redactor: createFakeRedactor(),
    });
    const fbRequest = createFbRequest(
      makeDeps({ logger, versionDrift, retry: { maxRetries: 0 } }),
    );
    await assert.rejects(
      fbRequest({
        protocol: 'json',
        host: 'graph',
        method: 'GET',
        path: '/act_1',
        api: 'marketing',
      }),
      (err: unknown) => err instanceof GraphApiError && err.code === 100,
    );
    assert.equal(versionDrift.signals().length, 1);
    assert.equal(driftEntries(logger).length, 1);
  });
});

test('the drift warn is redacted: a credential echoed in the header never reaches the log (C3)', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      json: {},
      headers: { 'x-ad-api-version-warning': `auto-upgraded (token ${TOKEN})` },
    });
    const logger = createTestLogger();
    const fbRequest = createFbRequest(makeDeps({ logger }));
    await fbRequest({
      protocol: 'json',
      host: 'graph',
      method: 'GET',
      path: '/act_1',
      api: 'marketing',
    });
    const entries = driftEntries(logger);
    assert.equal(entries.length, 1);
    assert.ok(!JSON.stringify(entries).includes(TOKEN));
  });
});

test('one injected monitor dedupes across two clients (the shared per-process instance)', async () => {
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      json: {},
      headers: { 'x-ad-api-version-warning': AUTO_UPGRADE_NOTICE },
    });
    mock.enqueue({
      json: {},
      headers: { 'x-ad-api-version-warning': AUTO_UPGRADE_NOTICE },
    });
    const logger = createTestLogger();
    const versionDrift = createVersionDriftMonitor({
      logger,
      redactor: createFakeRedactor(),
    });
    const a = createFbRequest(makeDeps({ logger, versionDrift }));
    const b = createFbRequest(makeDeps({ logger, versionDrift }));
    await a({
      protocol: 'json',
      host: 'graph',
      method: 'GET',
      path: '/act_1',
      api: 'marketing',
    });
    await b({
      protocol: 'json',
      host: 'graph',
      method: 'GET',
      path: '/act_2',
      api: 'marketing',
    });
    assert.equal(driftEntries(logger).length, 1);
  });
});
