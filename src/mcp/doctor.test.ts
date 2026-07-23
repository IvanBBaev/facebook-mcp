// Tests for the `facebook doctor` diagnostic (task F16): token classification +
// never-expiring / expiring-soon detection, the permission x package matrix over
// INJECTED packages (usable / partial / blocked / unknown), over-scope
// detection, the optional metric-probe seam, and the text renderer. All Graph
// calls are served by `createFakeFbRequest`; placeholder tokens only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import {
  createFakeClock,
  createFakeFbRequest,
  createFakeRedactor,
  fbErr,
  fbOk,
  type FakeFbRequest,
} from '../core/fakes/index.js';
import type {
  Logger,
  PackageSpec,
  Settings,
  ToolAnnotations,
  ToolSpec,
} from '../core/index.js';
import { defineTool } from './define.js';
import {
  PACKAGE_PERMISSIONS,
  renderDoctorReport,
  runDoctor,
  type DoctorDeps,
  type MetricProbe,
  type PackageMatrixRow,
} from './doctor.js';

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

function makeLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function rtool(name: string): ToolSpec {
  return defineTool({
    name,
    description: 'diagnostic fixture tool',
    inputSchema: z.object({}),
    annotations: READ_ONLY,
    handler: () => Promise.resolve({ content: [{ type: 'text', text: 'ok' }] }),
  });
}

function pkg(name: string, toolNames: readonly string[]): PackageSpec {
  return { name, tools: toolNames.map(rtool), enabledByDefault: false };
}

/** The real core package's tool names, so the matrix mirrors production. */
const CORE_TOOLS = [
  'facebook_whoami',
  'facebook_list_pages',
  'facebook_get_page',
  'facebook_usage',
] as const;

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    profiles: {},
    apiVersion: 'v23.0',
    hosts: {
      graph: 'graph.facebook.com',
      graphVideo: 'graph-video.facebook.com',
      rupload: 'rupload.facebook.com',
    },
    requestTimeoutMs: 30_000,
    hostConcurrency: 4,
    writeMode: 'plan',
    maxResultChars: 25_000,
    transport: 'stdio',
    packagesDeny: [],
    packagesReadonly: [],
    journalPath: '/tmp/journal.ndjson',
    logLevel: 'info',
    ...overrides,
  };
}

interface DoctorParts {
  readonly fb: FakeFbRequest;
  readonly deps: DoctorDeps;
}

function makeDeps(
  opts: {
    settings?: Settings;
    packages?: readonly PackageSpec[];
    nowMs?: number;
    metricProbe?: MetricProbe;
  } = {},
): DoctorParts {
  const fb = createFakeFbRequest();
  const deps: DoctorDeps = {
    fbRequest: fb.fn,
    settings: opts.settings ?? makeSettings({ accessToken: 'EAA-runtime' }),
    clock: createFakeClock(opts.nowMs ?? 1000),
    logger: makeLogger(),
    redactor: createFakeRedactor(),
    packages: opts.packages ?? [pkg('core', CORE_TOOLS)],
    serverVersion: '9.9.9',
    ...(opts.metricProbe !== undefined ? { metricProbe: opts.metricProbe } : {}),
  };
  return { fb, deps };
}

/** Program `/debug_token` to return a given normalized payload. */
function withDebugToken(fb: FakeFbRequest, data: Record<string, unknown>): void {
  fb.on((req) => req.path === '/debug_token', fbOk({ data }));
}

function row(rows: readonly PackageMatrixRow[], name: string): PackageMatrixRow {
  const found = rows.find((r) => r.package === name);
  assert.ok(found, `expected a matrix row for ${name}`);
  return found;
}

// ---------------------------------------------------------------------------
// Token report
// ---------------------------------------------------------------------------

test('classifies a valid non-expiring system-user token (neverExpiring)', async () => {
  const { fb, deps } = makeDeps();
  withDebugToken(fb, {
    type: 'SYSTEM_USER',
    is_valid: true,
    app_id: '123',
    scopes: ['pages_show_list', 'pages_read_engagement'],
    expires_at: 0,
    user_id: '999',
  });

  const report = await runDoctor(deps);
  assert.equal(report.serverVersion, '9.9.9');
  assert.equal(report.apiVersion, 'v23.0');
  assert.equal(report.token.configured, true);
  assert.equal(report.token.type, 'SYSTEM_USER');
  assert.equal(report.token.valid, true);
  assert.equal(report.token.neverExpiring, true);
  assert.equal(report.token.expiringSoon, false);
  assert.equal(report.token.actingUserId, '999');
});

test('flags a token expiring within the warning window', async () => {
  const now = 10_000_000;
  const { fb, deps } = makeDeps({ nowMs: now });
  withDebugToken(fb, {
    type: 'USER',
    is_valid: true,
    scopes: ['pages_show_list'],
    expires_at: now / 1000 + 86_400, // +1 day, well inside the 7-day window
  });

  const report = await runDoctor(deps);
  assert.equal(report.token.neverExpiring, false);
  assert.equal(report.token.expiringSoon, true);
});

test('a valid token far from expiry is not flagged as expiring soon', async () => {
  const now = 10_000_000;
  const { fb, deps } = makeDeps({ nowMs: now });
  withDebugToken(fb, {
    type: 'USER',
    is_valid: true,
    scopes: [],
    expires_at: now / 1000 + 30 * 86_400, // +30 days
  });

  const report = await runDoctor(deps);
  assert.equal(report.token.expiringSoon, false);
});

test('reports "no token configured" without making a Graph call', async () => {
  const { fb, deps } = makeDeps({ settings: makeSettings() });

  const report = await runDoctor(deps);
  assert.equal(report.token.configured, false);
  assert.equal(report.token.valid, false);
  assert.match(String(report.token.error), /No access token configured/);
  assert.equal(fb.calls.length, 0);
  // With no scopes granted, only the scope-free tools (whoami, usage) stay
  // usable, so the mixed core package is `partial` and names its blocked tools.
  const core = row(report.matrix, 'core');
  assert.equal(core.status, 'partial');
  assert.deepEqual([...core.blockedTools], ['facebook_list_pages', 'facebook_get_page']);
});

test('runDoctor never throws on a debug_token failure; it redacts the error', async () => {
  const { fb, deps } = makeDeps();
  fb.on((req) => req.path === '/debug_token', fbErr(new Error('graph exploded')));

  const report = await runDoctor(deps);
  assert.equal(report.token.valid, false);
  assert.match(String(report.token.error), /graph exploded/);
});

// ---------------------------------------------------------------------------
// Permission x package matrix
// ---------------------------------------------------------------------------

test('a fully-scoped token makes the core package usable', async () => {
  const { fb, deps } = makeDeps();
  withDebugToken(fb, {
    type: 'SYSTEM_USER',
    is_valid: true,
    scopes: ['pages_show_list', 'pages_read_engagement'],
  });

  const core = row((await runDoctor(deps)).matrix, 'core');
  assert.equal(core.status, 'usable');
  assert.deepEqual([...core.missingPermissions], []);
  assert.deepEqual([...core.blockedTools], []);
});

test('a partial scope grant marks the package partial and names the blocked tools', async () => {
  const { fb, deps } = makeDeps();
  withDebugToken(fb, {
    type: 'USER',
    is_valid: true,
    scopes: ['pages_show_list'], // missing pages_read_engagement
  });

  const core = row((await runDoctor(deps)).matrix, 'core');
  assert.equal(core.status, 'partial');
  assert.deepEqual([...core.missingPermissions], ['pages_read_engagement']);
  // get_page needs pages_read_engagement; the other three do not.
  assert.deepEqual([...core.blockedTools], ['facebook_get_page']);
});

test('a package with no satisfied tool is fully blocked', async () => {
  const { fb, deps } = makeDeps({
    packages: [pkg('insights', ['facebook_page_insights', 'facebook_post_insights'])],
  });
  withDebugToken(fb, { type: 'USER', is_valid: true, scopes: ['pages_show_list'] });

  const insights = row((await runDoctor(deps)).matrix, 'insights');
  assert.equal(insights.status, 'blocked');
  assert.deepEqual([...insights.missingPermissions], ['read_insights']);
});

test('an unmapped package name renders as unknown (not blocked)', async () => {
  const { fb, deps } = makeDeps({ packages: [pkg('weird', ['facebook_mystery'])] });
  withDebugToken(fb, { type: 'USER', is_valid: true, scopes: ['pages_show_list'] });

  const weird = row((await runDoctor(deps)).matrix, 'weird');
  assert.equal(weird.status, 'unknown');
  assert.deepEqual([...weird.requiredPermissions], []);
});

test('the matrix expands over the INJECTED packages, not a hard-coded set', async () => {
  const { fb, deps } = makeDeps({
    packages: [pkg('core', CORE_TOOLS), pkg('ads', ['facebook_list_campaigns'])],
  });
  withDebugToken(fb, {
    type: 'SYSTEM_USER',
    is_valid: true,
    scopes: ['pages_show_list', 'pages_read_engagement', 'ads_read'],
  });

  const report = await runDoctor(deps);
  assert.deepEqual(
    report.matrix.map((r) => r.package),
    ['core', 'ads'],
  );
  assert.equal(row(report.matrix, 'ads').status, 'usable'); // ads_read covers the read tool
});

test('granted scopes no loaded package needs are flagged as over-scope', async () => {
  const { fb, deps } = makeDeps();
  withDebugToken(fb, {
    type: 'SYSTEM_USER',
    is_valid: true,
    // business_management is setup-only (doc 04) — never needed on a runtime token.
    scopes: ['pages_show_list', 'pages_read_engagement', 'business_management'],
  });

  const report = await runDoctor(deps);
  assert.deepEqual([...report.overScopePermissions], ['business_management']);
});

// ---------------------------------------------------------------------------
// Metric-probe seam
// ---------------------------------------------------------------------------

test('metric probe renders as unavailable when none is wired', async () => {
  const { fb, deps } = makeDeps();
  withDebugToken(fb, { type: 'USER', is_valid: true, scopes: [] });

  const report = await runDoctor(deps);
  assert.equal(report.metricProbe.available, false);
  assert.match(report.metricProbe.summary, /unavailable/);
});

test('an injected metric probe is folded into the report', async () => {
  const probe: MetricProbe = () =>
    Promise.resolve({
      available: true,
      summary: 'reach sampled ok',
      details: { sampled: 3 },
    });
  const { fb, deps } = makeDeps({ metricProbe: probe });
  withDebugToken(fb, { type: 'USER', is_valid: true, scopes: [] });

  const report = await runDoctor(deps);
  assert.equal(report.metricProbe.available, true);
  assert.equal(report.metricProbe.summary, 'reach sampled ok');
  assert.deepEqual(report.metricProbe.details, { sampled: 3 });
});

test('a throwing metric probe is caught and reported as failed', async () => {
  const probe: MetricProbe = () => Promise.reject(new Error('probe boom'));
  const { fb, deps } = makeDeps({ metricProbe: probe });
  withDebugToken(fb, { type: 'USER', is_valid: true, scopes: [] });

  const report = await runDoctor(deps);
  assert.equal(report.metricProbe.available, false);
  assert.match(report.metricProbe.summary, /failed/);
  assert.match(report.metricProbe.summary, /probe boom/);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('renderDoctorReport surfaces the token, matrix and over-scope sections', async () => {
  const { fb, deps } = makeDeps();
  withDebugToken(fb, {
    type: 'SYSTEM_USER',
    is_valid: true,
    app_id: '123',
    scopes: ['pages_show_list', 'business_management'], // partial + over-scope
    expires_at: 0,
  });

  const text = renderDoctorReport(await runDoctor(deps));
  assert.match(text, /facebook-mcp doctor/);
  assert.match(text, /version:\s+9\.9\.9/);
  assert.match(text, /type:\s+SYSTEM_USER/);
  assert.match(text, /never \(non-expiring token/);
  assert.match(text, /Permission x package matrix/);
  assert.match(text, /\[PARTIAL\] core/);
  assert.match(text, /over-scope .*business_management/);
  assert.match(text, /Metric probe/);
});

test('PACKAGE_PERMISSIONS covers every default-profile package', () => {
  for (const name of [
    'core',
    'reader',
    'posts',
    'insights',
    'moderation',
    'messages',
  ] as const) {
    assert.ok(PACKAGE_PERMISSIONS[name], `expected a permission mapping for ${name}`);
  }
});
