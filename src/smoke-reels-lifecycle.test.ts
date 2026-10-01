// The G-TOOL-3 Reels lifecycle probe (`scripts/smoke/smokes/reels-lifecycle.smoke.mjs`)
// and the harness-only raw Graph escape hatch it uses (`scripts/smoke/graph-escape.mjs`).
//
// The probe itself needs a live Page and spends Reels quota, so it is never run
// here. What IS pinned: the verdict vocabulary the probe prints (a doc-10 update
// will be written from that line, so its shape is a contract), the presence
// classification that decides "deleted" versus "still there", and — the part
// with a blast radius — the escape hatch's confinement to the test Page's token
// and to the ids the run itself created. Every Graph call goes to an injected
// fake `fetch`; nothing here opens a socket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This file compiles to `build/smoke-reels-lifecycle.test.js`, so the root is one level up. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const smokeFile = (name: string): string =>
  pathToFileURL(join(REPO_ROOT, 'scripts', 'smoke', name)).href;

type SmokeEnv = Record<string, string | undefined>;

interface Outcome {
  readonly ok: boolean;
  readonly code: number | string | undefined;
  readonly subcode: number | undefined;
  readonly message: string;
}

interface Presence {
  readonly state: 'present' | 'absent' | 'unknown';
  readonly code?: unknown;
  readonly ownerId?: string;
}

interface FakeCall {
  readonly url: URL;
  readonly method: string;
  readonly authorization: string | undefined;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface TestPageGraph {
  readonly testPageId: string;
  readonly apiVersion: string;
  track(videoId: string): void;
  tracked(): string[];
  tokenSource(): Promise<string>;
  presence(videoId: string): Promise<Presence>;
  deleteVideo(videoId: string): Promise<Outcome & { absent: boolean }>;
}

interface EscapeModule {
  readonly EscapeHatchError: new (message: string) => Error;
  graphOutcome(input: { status?: number; body?: unknown; failure?: unknown }): Outcome;
  classifyPresence(outcome: Outcome): Presence;
  deleteVerdict(input: {
    attempted?: boolean;
    errorCode?: string | number;
    after?: Presence;
  }): string;
  edgeVerdict(inScheduledPosts: unknown, inVideoReels: unknown): string;
  formatVerdict(input: Record<string, string>): string;
  createTestPageGraph(options: {
    env?: SmokeEnv;
    testPageId: unknown;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  }): TestPageGraph;
}

interface RegisteredSmoke {
  readonly id: string;
  readonly phase: number;
  readonly page: string;
  readonly writes: boolean;
  readonly budget: string | null;
  readonly packages: readonly string[];
  readonly requires: readonly string[];
}

interface RegistryModule {
  resetRegistry(): void;
  listSmokes(): readonly RegisteredSmoke[];
  selectSmokes(options?: { only?: readonly string[]; includeBudget?: boolean }): {
    selected: readonly RegisteredSmoke[];
  };
}

const escape = (await import(smokeFile('graph-escape.mjs'))) as EscapeModule;

const TEST_PAGE = '111111';
const OTHER_PAGE = '999999';
const VIDEO = '424242';

/**
 * A fake `fetch` that answers from a queue of `[status, body]` and records every
 * call. An unexpected extra call fails loudly instead of hanging.
 */
function fakeFetch(responses: readonly (readonly [number, unknown])[]): {
  fetchImpl: FetchLike;
  calls: FakeCall[];
} {
  const queue = [...responses];
  const calls: FakeCall[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    const headers = new Headers(init.headers);
    calls.push({
      url: new URL(url),
      method: init.method ?? 'GET',
      authorization: headers.get('authorization') ?? undefined,
    });
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(
        new Error(`unexpected Graph call: ${init.method ?? 'GET'} ${url}`),
      );
    }
    const [status, body] = next;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetchImpl, calls };
}

const graphError = (code: number, subcode?: number, message = 'x'): unknown => ({
  error: { code, ...(subcode !== undefined ? { error_subcode: subcode } : {}), message },
});

// ---------------------------------------------------------------------------
// Presence classification: what counts as "the Reel is gone"
// ---------------------------------------------------------------------------

test('presence: only an explicit "does not exist" answer reads as absent', () => {
  const classify = (status: number, body: unknown): Presence =>
    escape.classifyPresence(escape.graphOutcome({ status, body }));

  assert.deepEqual(classify(200, { id: VIDEO }), { state: 'present' });
  assert.deepEqual(classify(404, graphError(803)), { state: 'absent' });
  assert.deepEqual(classify(400, graphError(100, 33)), { state: 'absent' });
  assert.deepEqual(
    classify(400, graphError(100, undefined, 'Object with ID 1 does not exist')),
    { state: 'absent' },
  );
  // A permission or token failure proves nothing about the Reel — calling it
  // "deleted" would turn a broken probe into a false `yes`.
  assert.deepEqual(classify(400, graphError(190)), { state: 'unknown', code: 190 });
  assert.deepEqual(classify(400, graphError(100, undefined, 'Invalid parameter')), {
    state: 'unknown',
    code: 100,
  });
  assert.deepEqual(classify(500, 'not json'), { state: 'unknown', code: 'http500' });

  const timedOut = Object.assign(new Error('The operation timed out'), {
    name: 'TimeoutError',
  });
  assert.deepEqual(escape.classifyPresence(escape.graphOutcome({ failure: timedOut })), {
    state: 'unknown',
    code: 'timeout',
  });
});

// ---------------------------------------------------------------------------
// The verdict vocabulary
// ---------------------------------------------------------------------------

test('deleteVerdict is judged by the re-read, never by the call alone', () => {
  assert.equal(escape.deleteVerdict({ after: { state: 'absent' } }), 'yes');
  // The call failed but the Reel is gone anyway (e.g. an absent-error on retry).
  assert.equal(
    escape.deleteVerdict({ errorCode: 100, after: { state: 'absent' } }),
    'yes',
  );
  assert.equal(escape.deleteVerdict({ after: { state: 'present' } }), 'no');
  assert.equal(
    escape.deleteVerdict({ errorCode: '100/33', after: { state: 'present' } }),
    'error(100/33)',
  );
  assert.equal(
    escape.deleteVerdict({ after: { state: 'unknown', code: 'timeout' } }),
    'unknown(timeout)',
  );
  assert.equal(escape.deleteVerdict({ attempted: false }), 'not-run');
});

test('edgeVerdict names the edge, and refuses to guess from a failed read', () => {
  assert.equal(escape.edgeVerdict(true, true), 'both');
  assert.equal(escape.edgeVerdict(true, false), 'scheduled_posts');
  assert.equal(escape.edgeVerdict(false, true), 'video_reels');
  assert.equal(escape.edgeVerdict(false, false), 'neither');
  assert.equal(escape.edgeVerdict(undefined, true), 'unknown');
});

test('the verdict line keeps its machine-readable shape', () => {
  const line = escape.formatVerdict({
    deleteByVideoId: 'yes',
    deletePostVideoId: 'error(100)',
    deletePostComposite: 'no',
    scheduledReelIn: 'video_reels',
    draftReelIn: 'neither',
  });
  assert.equal(
    line,
    'G-TOOL-3 verdict: delete-by-video-id=yes; delete_post-video-id=error(100); ' +
      'delete_post-composite=no; scheduled-reel-in=video_reels; draft-reel-in=neither',
  );
  // Defaults: a probe that died early still prints a parseable line.
  assert.match(
    escape.formatVerdict({}),
    /^G-TOOL-3 verdict: delete-by-video-id=not-run; delete_post-video-id=not-run; delete_post-composite=not-run; scheduled-reel-in=unknown; draft-reel-in=unknown$/,
  );
});

// ---------------------------------------------------------------------------
// The escape hatch: confined to the test Page token and this run's ids
// ---------------------------------------------------------------------------

test('escape hatch: refuses a non-numeric test Page id before anything else', () => {
  assert.throws(
    () =>
      escape.createTestPageGraph({
        testPageId: undefined,
        fetchImpl: fakeFetch([]).fetchImpl,
      }),
    escape.EscapeHatchError,
  );
  assert.throws(
    () =>
      escape.createTestPageGraph({
        testPageId: 'me',
        fetchImpl: fakeFetch([]).fetchImpl,
      }),
    escape.EscapeHatchError,
  );
});

test('escape hatch: touches only ids this run tracked, and only bare video ids', async () => {
  const { fetchImpl, calls } = fakeFetch([]);
  const graph = escape.createTestPageGraph({
    env: { FB_SMOKE_TEST_PAGE_TOKEN: 'EAAtestpagetoken' },
    testPageId: TEST_PAGE,
    fetchImpl,
  });
  await assert.rejects(graph.presence(VIDEO), escape.EscapeHatchError);
  await assert.rejects(graph.deleteVideo(VIDEO), escape.EscapeHatchError);
  assert.throws(() => graph.track(`${TEST_PAGE}_${VIDEO}`), escape.EscapeHatchError);
  assert.throws(() => graph.track('me'), escape.EscapeHatchError);
  assert.equal(calls.length, 0, 'a refused id must never reach Graph');
});

test('escape hatch: the explicit test Page token rides in the header, never the URL', async () => {
  const { fetchImpl, calls } = fakeFetch([[200, { id: VIDEO, from: { id: TEST_PAGE } }]]);
  const graph = escape.createTestPageGraph({
    env: {
      FB_SMOKE_TEST_PAGE_TOKEN: 'EAAtestpagetoken',
      FB_PAGE_TOKEN: 'EAAdefaultpagetoken',
      FB_API_VERSION: 'v99.0',
    },
    testPageId: TEST_PAGE,
    fetchImpl,
  });
  graph.track(VIDEO);
  assert.deepEqual(await graph.presence(VIDEO), { state: 'present', ownerId: TEST_PAGE });

  const [call] = calls;
  assert.ok(call !== undefined);
  assert.equal(call.method, 'GET');
  assert.equal(call.url.origin, 'https://graph.facebook.com');
  assert.equal(call.url.pathname, `/v99.0/${VIDEO}`);
  assert.equal(call.authorization, 'Bearer EAAtestpagetoken');
  assert.ok(!call.url.href.includes('EAA'), 'no token in the URL');
  assert.equal(call.url.searchParams.get('appsecret_proof'), null);
});

test('escape hatch: a derived token must be for exactly the test Page', async () => {
  // Graph answers the derivation for a different Page: refuse, and hold nothing.
  const wrong = fakeFetch([[200, { id: OTHER_PAGE, access_token: 'EAAotherpage' }]]);
  const refused = escape.createTestPageGraph({
    env: { FB_SYSTEM_TOKEN: 'EAAsystemtoken' },
    testPageId: TEST_PAGE,
    fetchImpl: wrong.fetchImpl,
  });
  refused.track(VIDEO);
  await assert.rejects(refused.presence(VIDEO), /not the test Page/);
  assert.equal(wrong.calls.length, 1, 'nothing may be sent with a mismatched token');

  // The right Page: the derived token (not the base token) is what reads the video.
  const right = fakeFetch([
    [200, { id: TEST_PAGE, access_token: 'EAAderivedtestpage' }],
    [200, { id: VIDEO }],
  ]);
  const graph = escape.createTestPageGraph({
    env: { FB_SYSTEM_TOKEN: 'EAAsystemtoken', FB_APP_SECRET: 'shh' },
    testPageId: TEST_PAGE,
    fetchImpl: right.fetchImpl,
  });
  graph.track(VIDEO);
  assert.equal((await graph.presence(VIDEO)).state, 'present');
  const [derive, read] = right.calls;
  assert.equal(derive?.url.pathname, `/v23.0/${TEST_PAGE}`);
  assert.equal(derive?.url.searchParams.get('fields'), 'id,access_token');
  assert.equal(derive?.authorization, 'Bearer EAAsystemtoken');
  assert.equal(read?.authorization, 'Bearer EAAderivedtestpage');
  assert.equal(
    read?.url.searchParams.get('appsecret_proof'),
    createHmac('sha256', 'shh').update('EAAderivedtestpage').digest('hex'),
    'appsecret_proof is the HMAC of the token actually sent',
  );
});

test('escape hatch: FB_PAGE_TOKEN alone is never used for the test Page', async () => {
  const { fetchImpl, calls } = fakeFetch([]);
  const graph = escape.createTestPageGraph({
    env: { FB_PAGE_TOKEN: 'EAAdefaultpagetoken', FB_PAGE_ID: OTHER_PAGE },
    testPageId: TEST_PAGE,
    fetchImpl,
  });
  graph.track(VIDEO);
  await assert.rejects(graph.presence(VIDEO), /FB_PAGE_TOKEN is never used/);
  assert.equal(calls.length, 0);
});

test('escape hatch: DELETE is refused for a video another Page owns', async () => {
  const { fetchImpl, calls } = fakeFetch([
    [200, { id: VIDEO, from: { id: OTHER_PAGE } }],
  ]);
  const graph = escape.createTestPageGraph({
    env: { FB_SMOKE_TEST_PAGE_TOKEN: 'EAAtestpagetoken' },
    testPageId: TEST_PAGE,
    fetchImpl,
  });
  graph.track(VIDEO);
  await assert.rejects(graph.deleteVideo(VIDEO), /belongs to 999999/);
  assert.deepEqual(
    calls.map((call) => call.method),
    ['GET'],
    'the ownership read happened and no DELETE followed',
  );
});

test('escape hatch: DELETE of an owned video, and of one already gone', async () => {
  const owned = fakeFetch([
    [200, { id: VIDEO, from: { id: TEST_PAGE } }],
    [200, { success: true }],
  ]);
  const graph = escape.createTestPageGraph({
    env: { FB_SMOKE_TEST_PAGE_TOKEN: 'EAAtestpagetoken' },
    testPageId: TEST_PAGE,
    fetchImpl: owned.fetchImpl,
  });
  graph.track(VIDEO);
  const deleted = await graph.deleteVideo(VIDEO);
  assert.equal(deleted.ok, true);
  assert.equal(deleted.absent, false);
  assert.deepEqual(
    owned.calls.map((call) => `${call.method} ${call.url.pathname}`),
    [`GET /v23.0/${VIDEO}`, `DELETE /v23.0/${VIDEO}`],
  );

  const gone = fakeFetch([[400, graphError(100, 33)]]);
  const again = escape.createTestPageGraph({
    env: { FB_SMOKE_TEST_PAGE_TOKEN: 'EAAtestpagetoken' },
    testPageId: TEST_PAGE,
    fetchImpl: gone.fetchImpl,
  });
  again.track(VIDEO);
  assert.equal((await again.deleteVideo(VIDEO)).absent, true);
  assert.equal(gone.calls.length, 1, 'no DELETE for a video that already reads absent');
});

// ---------------------------------------------------------------------------
// Registration: budget-gated, test Page only, refuses without its inputs
// ---------------------------------------------------------------------------

test('reels/lifecycle-probe is registered as a budget smoke on the test Page', async () => {
  const registry = (await import(smokeFile('registry.mjs'))) as RegistryModule;
  registry.resetRegistry();
  await import(smokeFile('smokes/reels-lifecycle.smoke.mjs'));

  const probe = registry
    .listSmokes()
    .find((smoke) => smoke.id === 'reels/lifecycle-probe');
  assert.ok(probe !== undefined, 'the probe registered itself');
  assert.equal(probe.budget, 'reels');
  assert.equal(probe.page, 'test');
  assert.equal(probe.writes, true);
  assert.equal(probe.phase, 2);
  assert.deepEqual([...probe.packages].sort(), ['posts', 'reader']);
  assert.deepEqual([...probe.requires].sort(), [
    'FB_CONFIRM_TOKEN',
    'FB_MEDIA_DIR',
    'FB_SMOKE_REEL_PATH',
  ]);

  // Never in the default selection; naming it is the opt-in.
  assert.equal(
    registry.selectSmokes().selected.some((smoke) => smoke.id === probe.id),
    false,
  );
  assert.deepEqual(
    registry.selectSmokes({ only: [probe.id] }).selected.map((smoke) => smoke.id),
    [probe.id],
  );
});
