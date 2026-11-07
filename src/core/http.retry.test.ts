// Tests for the Graph HTTP client (`core/http.ts`): retry behaviour end to end.
//
// Split out of `http.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/http.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFbRequest } from './http.js';
import { GraphApiError } from './index.js';
import { createFakeClock } from './fakes/index.js';
import { withFetch, type FetchMock } from '../testing/index.js';
import {
  TOKEN,
  breakNextBodyRead,
  createRecordingClock,
  makeDeps,
  settle,
  throttleBody,
} from '../testing/harness/http.js';

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
  const { clock, sleeps } = createRecordingClock();
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
