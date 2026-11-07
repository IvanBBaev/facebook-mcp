// Tests for the server bootstrap: the error hub — dead Page token eviction, usage
// buckets and bounded refusal text.
//
// Split out of `index.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/server.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  createFakeClock,
  createFakeFbRequest,
  createFakePageResolver,
  createFakeRedactor,
  createMemoryJournal,
  fbErr,
  fbOk,
} from './core/fakes/index.js';
import {
  GraphApiError,
  createFbRequest,
  createPagesRegistry,
  loadSettings,
  type PackageSpec,
  type Settings,
} from './core/index.js';
import { defineTool } from './mcp/index.js';
import { createCorePackage, META_ERROR_TEXT_MAX } from './tools/index.js';
import { withFetch, type FetchMock } from './testing/index.js';
import { createUsageTracker } from './tools/core.js';
import { createTransport, runCli, systemClock } from './index.js';
import {
  ACCESS_TOKEN,
  READ_ONLY_ANNOTATIONS,
  callProbeServer,
  connect,
  firstText,
  makeHarness,
  parseResult,
  probeSettings,
  silentLogger,
  textResult,
} from './testing/harness/server.js';

// ---------------------------------------------------------------------------
// Wave 16 (lane A): the error hub evicts a dead Page token, names the full
// usage bucket, and bounds Meta's own refusal text
// ---------------------------------------------------------------------------

/** The Page the dead-token tests resolve, and the base token that derives it. */
const HUB_PAGE_ID = '424242';

/** Settings with a default Page, so `resolvePage()` derives through the registry. */
function hubSettings(): Settings {
  const { settings } = loadSettings({
    env: {
      FB_ACCESS_TOKEN: ACCESS_TOKEN,
      FB_PAGE_ID: HUB_PAGE_ID,
      FB_TOOL_PACKAGES: 'ads',
    },
    loadEnvFile: false,
  });
  return settings;
}

/**
 * A package whose one tool reads the default Page's feed with the token the
 * registry resolves — the shape of every Page-scoped read in the real packages.
 */
function pageReadPackage(wrap?: (err: unknown) => unknown): PackageSpec {
  const read = defineTool({
    name: 'facebook_probe_page_read',
    description: 'Test-only: read the default Page feed with its resolved token.',
    inputSchema: z.object({}),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async (_input, ctx) => {
      const page = await ctx.pages.resolvePage(ctx.profile);
      try {
        const res = await ctx.fbRequest({
          protocol: 'json',
          host: 'graph',
          method: 'GET',
          path: `/${page.pageId}/feed`,
          token: page.token,
        });
        return textResult({ data: res.data });
      } catch (err) {
        throw wrap !== undefined ? wrap(err) : err;
      }
    },
  });
  return {
    name: 'ads',
    title: 'Probe',
    description: 'Test-only package injected through the packages seam.',
    tools: [read],
    enabledByDefault: false,
  };
}

/** Is `req` the registry's `/PAGE_ID?fields=access_token` derivation? */
function isDerivation(req: {
  readonly path: string;
  readonly params?: unknown;
}): boolean {
  const params = req.params as Record<string, unknown> | undefined;
  return req.path === `/${HUB_PAGE_ID}` && params?.['fields'] === 'access_token';
}

/**
 * Two calls of the page-read probe against a REAL pages registry whose feed read
 * fails with `feedError` every time. Returns how many times the registry derived
 * the Page token, and the second call's error record.
 */
async function twoPageReads(
  feedError: GraphApiError,
  wrap?: (err: unknown) => unknown,
): Promise<{ derivations: number; second: Record<string, unknown> }> {
  const settings = hubSettings();
  const clock = createFakeClock(1_000);
  const redactor = createFakeRedactor({ secrets: [ACCESS_TOKEN] });
  const fb = createFakeFbRequest();
  fb.on(isDerivation, fbOk({ access_token: 'derived-page-token-1', id: HUB_PAGE_ID }), 1);
  fb.on(isDerivation, fbOk({ access_token: 'derived-page-token-2', id: HUB_PAGE_ID }));
  fb.on((req) => req.path === `/${HUB_PAGE_ID}/feed`, fbErr(feedError));
  const pages = createPagesRegistry({ settings, fbRequest: fb.fn, clock, redactor });

  const { client, close } = await connect({
    settings,
    packages: [
      createCorePackage({ serverVersion: '1.2.3-test', sdkVersion: '1.29.0-test' }),
      pageReadPackage(wrap),
    ],
    serverVersion: '1.2.3-test',
    clock,
    logger: silentLogger,
    redactor,
    journal: createMemoryJournal(clock),
    fbRequest: fb.fn,
    pages,
  });
  try {
    const first = (await client.callTool({
      name: 'facebook_probe_page_read',
      arguments: {},
    })) as CallToolResult;
    assert.equal(first.isError, true);
    const second = (await client.callTool({
      name: 'facebook_probe_page_read',
      arguments: {},
    })) as CallToolResult;
    assert.equal(second.isError, true);
    return {
      derivations: fb.calls.filter(isDerivation).length,
      second: parseResult(second),
    };
  } finally {
    await close();
  }
}

test('a Page token Graph refuses with 190 is evicted, so the next call re-derives', async () => {
  const { derivations, second } = await twoPageReads(
    new GraphApiError('(#190) Error validating access token', {
      code: 190,
      subcode: 460,
      type: 'OAuthException',
      httpStatus: 400,
    }),
  );
  // Without the eviction the second call is served the SAME dead token from the
  // registry cache (15-minute TTL) and fails identically without asking Graph.
  assert.equal(derivations, 2, 'the second call must re-derive the Page token');
  assert.equal(second['code'], 190);
});

test('a Page token refused as an expired session (102) is evicted too', async () => {
  const { derivations } = await twoPageReads(
    new GraphApiError('(#102) Session has expired', {
      code: 102,
      type: 'OAuthException',
      httpStatus: 400,
    }),
  );
  assert.equal(derivations, 2, 'a 102 on the Page token must drop the cached token');
});

test('a stale Page object (100 / subcode 21) evicts the cached Page token too', async () => {
  const { derivations } = await twoPageReads(
    new GraphApiError('(#21) Page ID was migrated to page ID 999', {
      code: 100,
      subcode: 21,
      type: 'OAuthException',
      httpStatus: 400,
    }),
  );
  assert.equal(derivations, 2, 'a stale Page object must drop the cached derivation');
});

test('a tool that re-words a 190 keeping it as cause still evicts the Page token', async () => {
  // A tool layer that rebuilds a Graph refusal into its own error (a carousel or
  // multi-photo wrapper, a reclassified send) keeps the original as `cause`. The
  // hub must read the refusal down that chain, the way core/auth's
  // isPageTokenDead is applied everywhere else, or the dead token stays cached.
  const { derivations } = await twoPageReads(
    new GraphApiError('(#190) Error validating access token', {
      code: 190,
      subcode: 463,
      type: 'OAuthException',
      httpStatus: 400,
    }),
    (err) => new Error('the probe failed while reading the feed', { cause: err }),
  );
  assert.equal(derivations, 2, 'a 190 behind a wrapper must drop the cached token');
});

test('regression: an error that says nothing about the token keeps the cached Page token', async () => {
  const { derivations } = await twoPageReads(
    new GraphApiError('(#200) Permissions error', {
      code: 200,
      type: 'OAuthException',
      httpStatus: 403,
    }),
  );
  assert.equal(derivations, 1, 'a permission refusal must not cost a re-derivation');
});

test('regression: an ads-style 100/33 on a call that resolved no Page keeps the cached Page token', async () => {
  // The ads tools read and write ad objects with the user token and never
  // resolve a Page, yet a missing ad object answers with the same 100/33 shape
  // as a stale Page object. The hub evicts only Pages the failing call itself
  // resolved, so an ads miss must not cost the next Page read a re-derivation.
  const settings = hubSettings();
  const clock = createFakeClock(1_000);
  const redactor = createFakeRedactor({ secrets: [ACCESS_TOKEN] });
  const fb = createFakeFbRequest();
  fb.on(isDerivation, fbOk({ access_token: 'derived-page-token-1', id: HUB_PAGE_ID }), 1);
  fb.on(isDerivation, fbOk({ access_token: 'derived-page-token-2', id: HUB_PAGE_ID }));
  fb.on((req) => req.path === `/${HUB_PAGE_ID}/feed`, fbOk({ data: [] }));
  fb.on(
    (req) => req.path === '/120000000000001',
    fbErr(
      new GraphApiError('(#100) Object with ID does not exist', {
        code: 100,
        subcode: 33,
        type: 'GraphMethodException',
        httpStatus: 400,
      }),
    ),
  );
  const pages = createPagesRegistry({ settings, fbRequest: fb.fn, clock, redactor });
  const adRead = defineTool({
    name: 'facebook_probe_ad_read',
    description: 'Test-only: read an ad object with the user token, resolving no Page.',
    inputSchema: z.object({}),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async (_input, ctx) => {
      const res = await ctx.fbRequest({
        protocol: 'json',
        host: 'graph',
        method: 'GET',
        path: '/120000000000001',
      });
      return textResult({ data: res.data });
    },
  });
  const probe = pageReadPackage();
  const { client, close } = await connect({
    settings,
    packages: [
      createCorePackage({ serverVersion: '1.2.3-test', sdkVersion: '1.29.0-test' }),
      { ...probe, tools: [...probe.tools, adRead] },
    ],
    serverVersion: '1.2.3-test',
    clock,
    logger: silentLogger,
    redactor,
    journal: createMemoryJournal(clock),
    fbRequest: fb.fn,
    pages,
  });
  try {
    const first = (await client.callTool({
      name: 'facebook_probe_page_read',
      arguments: {},
    })) as CallToolResult;
    assert.notEqual(first.isError, true);
    const miss = (await client.callTool({
      name: 'facebook_probe_ad_read',
      arguments: {},
    })) as CallToolResult;
    assert.equal(miss.isError, true);
    assert.equal(parseResult(miss)['code'], 100);
    const second = (await client.callTool({
      name: 'facebook_probe_page_read',
      arguments: {},
    })) as CallToolResult;
    assert.notEqual(second.isError, true);
    assert.equal(
      fb.calls.filter(isDerivation).length,
      1,
      'an ads miss must not evict the Page token another call derived',
    );
  } finally {
    await close();
  }
});

test('a Graph refusal carrying usage headers names the full bucket in the error record', async () => {
  // Build the error the way production does: through the real HTTP client, on
  // a throttle response that carries Meta's usage headers.
  const settings = probeSettings();
  const refused = await withFetch(async (mock: FetchMock) => {
    mock.on(() => true, {
      status: 400,
      json: {
        error: {
          message: '(#4) Application request limit reached',
          type: 'OAuthException',
          code: 4,
        },
      },
      headers: {
        'x-app-usage': '{"call_count":100,"total_cputime":40,"total_time":35}',
        'x-business-use-case-usage':
          '{"1234":[{"type":"pages","call_count":12,"total_cputime":5,"total_time":5,"estimated_time_to_regain_access":0}]}',
        'x-fb-ads-insights-throttle': '{"app_id_util_pct":95,"acc_id_util_pct":10}',
      },
    });
    const fbRequest = createFbRequest({
      settings,
      clock: createFakeClock(1_000),
      redactor: createFakeRedactor(),
      logger: silentLogger,
      retry: { maxRetries: 0 },
    });
    return fbRequest({
      protocol: 'json',
      host: 'graph',
      method: 'GET',
      path: '/me',
    }).then(
      () => assert.fail('expected the throttle to reject'),
      (err: unknown) => err,
    );
  });
  assert.ok(refused instanceof GraphApiError);

  const thrower = defineTool({
    name: 'facebook_probe_throttled',
    description: 'Test-only: rethrow a real throttle refusal.',
    inputSchema: z.object({}),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: () => Promise.reject(refused),
  });
  const { deps } = makeHarness({
    settings,
    packages: [
      createCorePackage({ serverVersion: '1.2.3-test', sdkVersion: '1.29.0-test' }),
      {
        name: 'ads',
        title: 'Probe',
        description: 'Test-only package injected through the packages seam.',
        tools: [thrower],
        enabledByDefault: false,
      },
    ],
  });
  const { client, close } = await connect(deps);
  try {
    const record = parseResult(
      (await client.callTool({
        name: 'facebook_probe_throttled',
        arguments: {},
      })) as CallToolResult,
    );
    assert.equal(record['category'], 'rate_limit');
    assert.equal(record['nextTool'], 'facebook_usage');
    // facebook_usage probes `/me`, not the refused call, so only the refusing
    // response names the bucket that refused it.
    assert.deepEqual(record['usage'], {
      appUsagePct: 100,
      businessUseCasePct: 12,
      // The ads-insights bucket ships too: an Insights refusal is otherwise
      // indistinguishable from an app-level one.
      adsInsightsThrottlePct: 95,
    });
  } finally {
    await close();
  }
});

test('regression: a Graph error with no usage headers carries no usage field', async () => {
  const record = parseResult(
    await callProbeServer('facebook_probe_fail', { kind: 'graph-throttled' }),
  );
  assert.ok(!('usage' in record), 'usage must be absent, not invented');
});

test("Meta's own refusal text is length-bounded in the error record", async () => {
  const huge = 'x'.repeat(10_000);
  const thrower = defineTool({
    name: 'facebook_probe_verbose',
    description: 'Test-only: throw a Graph error with a pathological user message.',
    inputSchema: z.object({}),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: () =>
      Promise.reject(
        new GraphApiError('Graph API error (HTTP 400): Invalid parameter', {
          code: 100,
          httpStatus: 400,
          userTitle: huge,
          userMessage: huge,
          action: {
            category: 'validation',
            retryable: false,
            operatorText: 'Fix the request, then retry.',
          },
        }),
      ),
  });
  const { deps } = makeHarness({
    settings: probeSettings(),
    packages: [
      createCorePackage({ serverVersion: '1.2.3-test', sdkVersion: '1.29.0-test' }),
      {
        name: 'ads',
        title: 'Probe',
        description: 'Test-only package injected through the packages seam.',
        tools: [thrower],
        enabledByDefault: false,
      },
    ],
  });
  const { client, close } = await connect(deps);
  try {
    const record = parseResult(
      (await client.callTool({
        name: 'facebook_probe_verbose',
        arguments: {},
      })) as CallToolResult,
    );
    assert.ok(
      String(record['userMessage']).length <= META_ERROR_TEXT_MAX,
      `userMessage is ${String(String(record['userMessage']).length)} chars`,
    );
    assert.ok(String(record['userTitle']).length <= META_ERROR_TEXT_MAX);
    // The decision fields still ride along beside the bounded text.
    assert.equal(record['retryable'], false);
    assert.equal(record['category'], 'validation');
  } finally {
    await close();
  }
});

test('the production transport sends a multipart upload instead of refusing it', async () => {
  // main() builds its Graph client through createTransport. A local-file photo,
  // a video chunk and a reel all use a non-JSON protocol, so without the upload
  // handler wired in every one of them rejected before reaching the network.
  const res = await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ json: { id: 'photo_1' } });
    const fbRequest = createTransport({
      settings: probeSettings(),
      clock: createFakeClock(1_000),
      redactor: createFakeRedactor(),
      logger: silentLogger,
    });
    const out = await fbRequest<{ id: string }>({
      protocol: 'multipart',
      host: 'graph',
      method: 'POST',
      path: '/me/photos',
      fields: { published: 'false' },
      files: [
        {
          name: 'source',
          data: new Uint8Array([0xff, 0xd8, 0xff]),
          filename: 'pic.jpg',
          contentType: 'image/jpeg',
        },
      ],
    });
    assert.equal(mock.lastRequest()?.body.kind, 'formData');
    return out;
  });
  assert.deepEqual(res.data, { id: 'photo_1' });
});

test('the production transport feeds the usage tracker from JSON and upload responses', async () => {
  // main() hands usageTracker.record to createTransport. Without that wiring
  // facebook_usage only ever saw its own /me probe, which never carries the
  // Business-use-case bucket that Page calls and uploads report.
  const tracker = createUsageTracker();
  const buc =
    '{"1234":[{"type":"pages","call_count":40,"total_cputime":1,"total_time":1}]}';
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      json: { id: '1' },
      headers: { 'x-app-usage': '{"call_count":7,"total_cputime":1,"total_time":1}' },
    });
    mock.enqueue({
      json: { id: 'photo_1' },
      headers: { 'x-business-use-case-usage': buc },
    });
    const fbRequest = createTransport({
      settings: probeSettings(),
      clock: createFakeClock(1_000),
      redactor: createFakeRedactor(),
      logger: silentLogger,
      onUsage: tracker.record,
    });
    await fbRequest({ protocol: 'json', host: 'graph', method: 'GET', path: '/me' });
    await fbRequest({
      protocol: 'multipart',
      host: 'graph',
      method: 'POST',
      path: '/1/photos',
      fields: { published: 'false' },
      files: [{ name: 'source', data: new Uint8Array([0xff]), filename: 'p.jpg' }],
    });
  });
  const observed = tracker.observed();
  assert.equal(observed['x-app-usage']?.pct, 7);
  assert.equal(observed['x-business-use-case-usage']?.pct, 40);
});

test('runCli says "failed to start" only for a failure before the server started', async () => {
  // A transport that dies an hour into a session is not a startup failure, and
  // reporting it as one sends the operator to check the token and settings of
  // a server that started fine.
  const outcomes: { line: string; code?: number }[] = [];
  const io = {
    writeStderr: (line: string): void => {
      outcomes.push({ line });
    },
    exit: (code: number): void => {
      const last = outcomes.at(-1);
      if (last !== undefined) last.code = code;
    },
  };

  await runCli(() => Promise.reject(new Error('FB_ACCESS_TOKEN is not set')), io);
  await runCli(async (onStarted) => {
    onStarted();
    await Promise.resolve();
    throw new Error('stdin closed with a read error');
  }, io);
  // A clean shutdown after the start writes nothing and exits nothing.
  await runCli(async (onStarted) => {
    onStarted();
    await Promise.resolve();
  }, io);

  assert.deepEqual(outcomes, [
    { line: 'facebook-mcp failed to start: FB_ACCESS_TOKEN is not set\n', code: 1 },
    {
      line: 'facebook-mcp stopped unexpectedly: stdin closed with a read error\n',
      code: 1,
    },
  ]);
});

test('a tool that evicts a Page token reaches the real resolver through the bootstrap', async () => {
  // The bootstrap wraps the resolver to record which Pages a call resolved; the
  // wrapper must forward `invalidate`, or a tool's eviction is silently dropped
  // and the dead token keeps being served from the cache.
  const evict = defineTool({
    name: 'facebook_probe_evict',
    description: 'Test-only: evict a Page token through ctx.pages.',
    inputSchema: z.object({}),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: (_input, ctx) => {
      ctx.pages.invalidate('page-to-evict');
      return Promise.resolve(textResult({ ok: true }));
    },
  });
  const { deps } = makeHarness({
    settings: probeSettings(),
    packages: [
      createCorePackage({ serverVersion: '1.2.3-test', sdkVersion: '1.29.0-test' }),
      {
        name: 'ads',
        title: 'Probe',
        description: 'Test-only package injected through the packages seam.',
        tools: [evict],
        enabledByDefault: false,
      },
    ],
  });
  const pages = createFakePageResolver();
  const { client, close } = await connect({ ...deps, pages });
  try {
    const result = (await client.callTool({
      name: 'facebook_probe_evict',
      arguments: {},
    })) as CallToolResult;
    assert.notEqual(result.isError, true, firstText(result));
  } finally {
    await close();
  }
  assert.deepEqual([...pages.invalidated], ['page-to-evict']);
});

test('the system clock sleeps for real and detaches its abort listener afterwards', async () => {
  // Regression: every completed sleep used to leave its abort listener on the
  // caller's signal. Callers pass the per-request signal, so a long video or
  // reel status poll accumulated one listener per poll interval.
  const controller = new AbortController();
  const before = systemClock.now();
  for (let i = 0; i < 12; i += 1) {
    await systemClock.sleep(1, controller.signal);
  }
  assert.ok(systemClock.now() >= before);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  // A signal-less sleep resolves too.
  await systemClock.sleep(1);
});

test('the system clock rejects a sleep on an aborted signal, before or during it', async () => {
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(systemClock.sleep(10_000, aborted.signal), /aborted/);
  assert.equal(getEventListeners(aborted.signal, 'abort').length, 0);

  const live = new AbortController();
  const pending = systemClock.sleep(60_000, live.signal);
  live.abort();
  await assert.rejects(pending, /aborted/);
});
