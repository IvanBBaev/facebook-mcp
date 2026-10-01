// Offline rehearsal of the live smoke harness (`scripts/smoke/rehearse.mjs`).
//
// The harness exists to talk to the real Graph API, so until now nothing ran it
// end to end outside a live Page: its plumbing — spawn, plan/apply, markers,
// sweeps, escape hatch, cleanup, verdicts, exit codes — was first exercised by
// an operator with real credentials. This file runs the REAL `run.mjs`, every
// smoke including the budget ones and the G-TOOL-3 lifecycle probe, against the
// loopback fake Graph, and pins the seam that makes that safe: the redirect
// preload refuses every destination except the fake, and the delay pacing only
// collapses inside that same gate.
//
// Network: the rehearsal's own process opens a loopback listener and uses no
// `fetch`, so the test fence stays intact here; the harness and server children
// get a fresh environment (no fence, no caller credentials) whose only reachable
// origin is that listener.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This file compiles to `build/smoke-rehearsal.test.js`, so the root is one level up. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const smokeFile = (name: string): string =>
  pathToFileURL(join(REPO_ROOT, 'scripts', 'smoke', name)).href;

type SmokeEnv = Record<string, string | undefined>;

interface RedirectModule {
  readonly REHEARSAL_GRAPH_VAR: string;
  readonly REDIRECT_REFUSAL: string;
  parseRehearsalOrigin(raw: unknown): string;
  redirectUrl(target: string, origin: string): string;
  createRedirectingFetch(
    origin: string,
    realFetch: (input: unknown, init?: unknown) => Promise<unknown>,
  ): (input: unknown, init?: unknown) => Promise<unknown>;
}

interface PaceModule {
  delayScale(env?: SmokeEnv): 0 | 1;
  paced(ms: number, env?: SmokeEnv): number;
}

interface RecordedRequest {
  readonly method: string;
  readonly host: string;
  readonly path: string;
}

interface RehearsalResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly requests: readonly RecordedRequest[];
  readonly unhandled: readonly RecordedRequest[];
}

interface RehearseModule {
  rehearse(opts?: {
    args?: readonly string[];
    timeoutMs?: number;
    echo?: boolean;
  }): Promise<RehearsalResult>;
  rehearsalEnv(input: {
    origin: string;
    fake: {
      ids: Record<string, string>;
      tokens: Record<string, string>;
    };
    dirs: Record<string, string>;
  }): SmokeEnv;
  summarizeRequests(requests: readonly RecordedRequest[]): readonly string[];
}

interface InsightsSmokeModule {
  readonly PERMALINK_REFUSAL_FRAGMENT: string;
}

// The preload switch is unset in this process, so importing the redirect keeps
// it inert: only its pure helpers are exercised.
const redirect = (await import(
  smokeFile('rehearsal/fetch-redirect.mjs')
)) as RedirectModule;
const pace = (await import(smokeFile('pace.mjs'))) as PaceModule;
const rehearsal = (await import(smokeFile('rehearse.mjs'))) as RehearseModule;

const ORIGIN = 'http://127.0.0.1:43210';

// ---------------------------------------------------------------------------
// The seam: where a rehearsal may send traffic
// ---------------------------------------------------------------------------

test('the rehearsal origin must be a loopback http origin with a port', () => {
  assert.equal(redirect.parseRehearsalOrigin(`${ORIGIN}/`), ORIGIN);
  for (const bad of [
    undefined,
    '',
    'not a url',
    'https://127.0.0.1:43210',
    'http://127.0.0.1',
    'http://graph.facebook.com:80',
    'http://10.0.0.5:43210',
  ]) {
    assert.throws(
      () => redirect.parseRehearsalOrigin(bad),
      (err: unknown) =>
        err instanceof Error && err.message.includes(redirect.REDIRECT_REFUSAL),
      `expected a refusal for ${String(bad)}`,
    );
  }
});

test('Graph, graph-video and rupload hosts are rewritten onto the fake, keeping path and query', () => {
  assert.equal(
    redirect.redirectUrl('https://graph.facebook.com/v23.0/me?fields=id', ORIGIN),
    `${ORIGIN}/__host/graph.facebook.com/v23.0/me?fields=id`,
  );
  assert.equal(
    redirect.redirectUrl('https://graph-video.facebook.com/v23.0/123/videos', ORIGIN),
    `${ORIGIN}/__host/graph-video.facebook.com/v23.0/123/videos`,
  );
  assert.equal(
    redirect.redirectUrl('https://rupload.facebook.com/video-upload/v23.0/9', ORIGIN),
    `${ORIGIN}/__host/rupload.facebook.com/video-upload/v23.0/9`,
  );
  assert.equal(redirect.redirectUrl(`${ORIGIN}/x`, ORIGIN), `${ORIGIN}/x`);
});

test('every other destination is refused, including look-alike Graph URLs', () => {
  for (const target of [
    'https://example.com/photo.jpg',
    'http://graph.facebook.com/v23.0/me',
    'https://graph.facebook.com:8443/v23.0/me',
    'https://graph.facebook.com.evil.test/v23.0/me',
    'https://www.facebook.com/',
    'http://127.0.0.1:1/',
    '/relative/path',
  ]) {
    assert.throws(
      () => redirect.redirectUrl(target, ORIGIN),
      (err: unknown) =>
        err instanceof Error && err.message.includes(redirect.REDIRECT_REFUSAL),
      `expected ${target} to be refused`,
    );
  }
});

test('the redirecting fetch rewrites before calling through and rejects the rest', async () => {
  const seen: unknown[] = [];
  const wrapped = redirect.createRedirectingFetch(ORIGIN, (input) => {
    seen.push(input);
    return Promise.resolve('answered');
  });
  assert.equal(await wrapped(new URL('https://graph.facebook.com/v23.0/me')), 'answered');
  assert.deepEqual(seen, [`${ORIGIN}/__host/graph.facebook.com/v23.0/me`]);
  await assert.rejects(wrapped('https://example.com/'), /smoke rehearsal fence/);
  assert.equal(seen.length, 1, 'a refused call never reaches the real fetch');
});

test('smoke waits collapse to zero only inside the gated rehearsal', () => {
  const gated = {
    FB_SMOKE_REHEARSAL_PRELOAD: '1',
    [redirect.REHEARSAL_GRAPH_VAR]: ORIGIN,
  };
  assert.equal(pace.delayScale(gated), 0);
  assert.equal(pace.paced(5000, gated), 0);
  // A live run — or a half-configured one — keeps every wait.
  for (const env of [
    {},
    { FB_SMOKE_REHEARSAL_PRELOAD: '1' },
    { [redirect.REHEARSAL_GRAPH_VAR]: ORIGIN },
    { FB_SMOKE_REHEARSAL_PRELOAD: 'true', [redirect.REHEARSAL_GRAPH_VAR]: ORIGIN },
    {
      FB_SMOKE_REHEARSAL_PRELOAD: '1',
      [redirect.REHEARSAL_GRAPH_VAR]: 'https://graph.facebook.com',
    },
  ] as SmokeEnv[]) {
    assert.equal(pace.delayScale(env), 1, JSON.stringify(env));
    assert.equal(pace.paced(5000, env), 5000);
  }
});

test('the rehearsal environment is built from scratch, never from the caller', () => {
  const env = rehearsal.rehearsalEnv({
    origin: ORIGIN,
    fake: {
      ids: { testPageId: '1', readPageId: '2', adAccountId: 'act_3' },
      tokens: { system: 'fake-system', testPage: 'fake-test', readPage: 'fake-read' },
    },
    dirs: {
      home: '/h',
      config: '/c',
      state: '/s',
      media: '/m',
      tmp: '/t',
      reel: '/m/r.mp4',
    },
  });
  assert.equal(env.FB_SYSTEM_TOKEN, 'fake-system');
  assert.equal(env.FB_SMOKE_REHEARSAL_PRELOAD, '1');
  assert.equal(env[redirect.REHEARSAL_GRAPH_VAR], ORIGIN);
  assert.match(env.NODE_OPTIONS ?? '', /--import file:.*fetch-redirect\.mjs$/);
  assert.equal(env.HOME, '/h', 'the server never reads the operator .env or journal');
  for (const name of ['FB_PAGE_TOKEN', 'FB_PAGE_ID', 'FB_APP_SECRET', 'FB_USER_TOKEN']) {
    assert.equal(env[name], undefined, `${name} must not leak into a rehearsal`);
  }
});

// ---------------------------------------------------------------------------
// Harness assertions pinned against the server they assert on
// ---------------------------------------------------------------------------

test('the insights permalink refusal fragment is still in the server message', async () => {
  // Regression: insights/reel-guardrail asserted the exact text "not a URL, a
  // permalink or a query string", which the server stopped emitting when it
  // added "a Page username" to that list — so the smoke failed against a server
  // that behaves correctly. It now asserts a fragment, pinned here to the source.
  const smoke = (await import(
    smokeFile('smokes/insights.smoke.mjs')
  )) as InsightsSmokeModule;
  const source = readFileSync(join(REPO_ROOT, 'src', 'tools', 'insights.ts'), 'utf8');
  assert.ok(
    source.includes(smoke.PERMALINK_REFUSAL_FRAGMENT),
    `src/tools/insights.ts no longer contains "${smoke.PERMALINK_REFUSAL_FRAGMENT}"`,
  );
});

// ---------------------------------------------------------------------------
// The whole harness, end to end
// ---------------------------------------------------------------------------

test(
  'the full harness passes against the fake Graph with no unmodelled request',
  { timeout: 120_000 },
  async () => {
    const started = Date.now();
    const result = await rehearsal.rehearse({ timeoutMs: 110_000 });
    const elapsed = Date.now() - started;
    const context = `\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;

    assert.deepEqual(
      rehearsal.summarizeRequests(result.unhandled),
      [],
      `the fake was asked for routes it does not model${context}`,
    );
    assert.equal(result.code, 0, `run.mjs exited ${String(result.code)}${context}`);
    assert.match(result.stdout, /0 failed, 0 not exercised/, context);
    assert.match(result.stdout, /✔ start sweep/);
    assert.match(result.stdout, /✔ end sweep: nothing marked on the test Page/);
    // The G-TOOL-3 probe ran to its verdict, inside its own section, not after it.
    const probe = result.stdout.indexOf('reels/lifecycle-probe');
    const verdict = result.stdout.indexOf('G-TOOL-3 verdict:');
    assert.ok(probe !== -1 && verdict > probe, `no lifecycle verdict${context}`);
    assert.doesNotMatch(result.stdout, /G-TOOL-3 verdict:.*=not-run/);
    // Tools both the sweeper and the smokes call are counted as called.
    const neverCalled = /never called: ([^\n]*)/.exec(result.stdout)?.[1] ?? '';
    for (const tool of [
      'facebook_list_posts',
      'facebook_list_scheduled_posts',
      'facebook_list_comments',
    ]) {
      assert.ok(!neverCalled.includes(tool), `${tool} reported never called`);
    }
    assert.ok(result.requests.length > 50, 'the smokes really went through the fake');
    assert.ok(
      result.requests.some((request) => request.host === 'rupload.facebook.com'),
      'the Reel upload leg reached the fake rupload host',
    );
    // Budget for `npm test`: generous for a slow CI leg, but a regression that
    // brings a live-sized wait back (tens of seconds) trips it.
    assert.ok(elapsed < 60_000, `the rehearsal took ${String(elapsed)} ms`);
  },
);
