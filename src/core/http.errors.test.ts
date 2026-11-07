// Tests for the Graph HTTP client (`core/http.ts`): live Graph error classification and
// the error-matrix delegation.
//
// Split out of `http.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/http.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFbRequest, graphErrorFromResponse } from './http.js';
import { NON_JSON_BODY_MAX, PROXY_ENV_HINT } from './errors.js';
import { GraphApiError } from './index.js';
import { createFakeClock, createFakeRedactor } from './fakes/index.js';
import { withFetch, type FetchMock } from '../testing/index.js';
import { makeDeps, settle, throttleBody } from '../testing/harness/http.js';

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
