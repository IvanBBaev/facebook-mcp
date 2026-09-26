// Tests for the `facebook doctor` diagnostic (task F16): token classification +
// never-expiring / expiring-soon detection, the permission x package matrix over
// INJECTED packages (usable / partial / blocked / unknown), over-scope
// detection, the optional metric-probe seam, and the text renderer. All Graph
// calls are served by `createFakeFbRequest`; placeholder tokens only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import {
  createFakeClock,
  createFakeFbRequest,
  createFakeRedactor,
  fbErr,
  fbOk,
  type FakeFbRequest,
} from '../core/fakes/index.js';
import { GraphApiError, PROXY_ENV_HINT, classifyNetworkError } from '../core/index.js';
import type {
  JsonRequest,
  Logger,
  PackageSpec,
  Settings,
  StartupProblem,
  ToolAnnotations,
  ToolSpec,
} from '../core/index.js';
// Test-only reach into layer 1: the doctor may not import the api layer, so the
// rename table it ships is a hand-kept mirror of the api deprecation table. The
// drift guard at the bottom of this file is what keeps the two honest.
import {
  INSIGHTS_MAX_WINDOW_DAYS,
  PAGE_INSIGHTS_LIKES_FLOOR,
  classifyMetric,
} from '../api/insights.js';
import { defineTool } from './define.js';
import {
  METRIC_PROBE_LIKES_FLOOR,
  METRIC_PROBE_MAX_WINDOW_DAYS,
  METRIC_PROBE_PERIOD,
  METRIC_PROBE_WINDOW_DAYS,
  PACKAGE_PERMISSIONS,
  PROBED_PAGE_METRICS,
  TOOL_PERMISSIONS,
  activeCredential,
  classifyAssetAccess,
  doctorExitCode,
  renderDoctorReport,
  runDoctor,
  summarizeDoctor,
  type AdAccountProbe,
  type DoctorDeps,
  type DoctorReport,
  type MetricProbe,
  type PackageMatrixRow,
  type ProbedMetric,
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

/**
 * A path that cannot exist, so the credential-file check (CC-CFG-4) never stats
 * the operator's real config during a test run.
 */
const NO_CREDENTIAL_FILE = join(tmpdir(), 'facebook-mcp-doctor-absent', 'env');

function makeDeps(
  opts: {
    settings?: Settings;
    packages?: readonly PackageSpec[];
    nowMs?: number;
    metricProbe?: MetricProbe;
    adAccountProbe?: AdAccountProbe;
    credentialFilePath?: string;
    platform?: NodeJS.Platform;
    metricSet?: readonly ProbedMetric[];
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
    credentialFilePath: opts.credentialFilePath ?? NO_CREDENTIAL_FILE,
    ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
    ...(opts.metricProbe !== undefined ? { metricProbe: opts.metricProbe } : {}),
    ...(opts.adAccountProbe !== undefined ? { adAccountProbe: opts.adAccountProbe } : {}),
    ...(opts.metricSet !== undefined ? { metricSet: opts.metricSet } : {}),
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

test('an expiry Graph never stated is reported as unknown, never as "never" (wave 9)', async () => {
  // Two answers that say NOTHING about when the token stops working: no
  // `expires_at` at all, and one that is not a number. Both used to normalize
  // to the same `expiresAt: undefined` that a literal `expires_at: 0` does, so
  // the report printed the never-expiring line — a confident statement Graph
  // never made — and the verdict had nothing to say.
  for (const wire of [{}, { expires_at: 'soon' }]) {
    const { fb, deps } = makeDeps();
    withDebugToken(fb, {
      type: 'SYSTEM_USER',
      is_valid: true,
      scopes: ['pages_show_list', 'pages_read_engagement'],
      ...wire,
    });

    const report = await runDoctor(deps);
    const label = JSON.stringify(wire);
    assert.equal(report.token.valid, true);
    assert.equal(
      report.token.neverExpiring,
      false,
      `${label} must not read as never-expiring`,
    );
    assert.equal(report.token.expiryUnknown, true, `${label} must read as unknown`);

    const text = renderDoctorReport(report);
    assert.match(
      text,
      /token expiry: unknown — Graph's debug_token answer carried no usable expires_at/,
    );
    assert.doesNotMatch(text, /non-expiring token/);

    // The doctor cannot tell the operator when this credential stops working,
    // and that is something an operator needs to know about.
    const finding = report.summary.findings.find((f) => f.area === 'token');
    assert.ok(finding, `${label}: expected a token finding for the unknown expiry`);
    assert.equal(finding.severity, 'warn');
    assert.match(finding.detail, /expiry/);
    assert.equal(report.summary.verdict, 'warn');
  }

  // Control: the literal `expires_at: 0` is the one wire fact that means
  // "never", and it still reads that way — this is not a blanket demotion.
  const control = makeDeps();
  withDebugToken(control.fb, {
    type: 'SYSTEM_USER',
    is_valid: true,
    scopes: ['pages_show_list', 'pages_read_engagement'],
    expires_at: 0,
  });
  const stated = await runDoctor(control.deps);
  assert.equal(stated.token.neverExpiring, true);
  assert.equal(stated.token.expiryUnknown, false);
  assert.match(renderDoctorReport(stated), /non-expiring token/);
  assert.equal(stated.summary.verdict, 'ok');
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
  // No token means no scope was ever observed — not "no scope granted": the
  // row is unverified and names nothing as blocked (whoami and usage do not
  // work without a token either, so `partial` claimed a usability nobody had).
  const core = row(report.matrix, 'core');
  assert.equal(core.status, 'unverified');
  assert.deepEqual([...core.blockedTools], []);
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
// Ad-account seam (CC-ADS-6)
// ---------------------------------------------------------------------------

test('the ad account reads as "not checked" when no probe is wired', async () => {
  const { fb, deps } = makeDeps();
  withDebugToken(fb, { type: 'USER', is_valid: true, scopes: [] });

  const report = await runDoctor(deps);
  assert.equal(report.adAccount.available, false);
  assert.match(report.adAccount.summary, /not checked/);
  assert.match(report.adAccount.summary, /FB_AD_ACCOUNT_ID/);
});

test('a blocked ad account is reported, not raised', async () => {
  const probe: AdAccountProbe = () =>
    Promise.resolve({
      available: false,
      summary: 'ad account act_1: Ad account is DISABLED: it cannot serve ads',
      details: { statusLabel: 'DISABLED' },
    });
  const { fb, deps } = makeDeps({ adAccountProbe: probe });
  withDebugToken(fb, { type: 'USER', is_valid: true, scopes: ['ads_management'] });

  const report = await runDoctor(deps);
  assert.equal(report.adAccount.available, false);
  assert.match(report.adAccount.summary, /DISABLED/);
  assert.deepEqual(report.adAccount.details, { statusLabel: 'DISABLED' });
});

test('a throwing ad-account probe still yields a report', async () => {
  const probe: AdAccountProbe = () => Promise.reject(new Error('account boom'));
  const { fb, deps } = makeDeps({ adAccountProbe: probe });
  withDebugToken(fb, { type: 'USER', is_valid: true, scopes: [] });

  const report = await runDoctor(deps);
  assert.equal(report.adAccount.available, false);
  assert.match(report.adAccount.summary, /ad account: failed/);
  assert.match(report.adAccount.summary, /account boom/);
});

// ---------------------------------------------------------------------------
// Active credential (CC-AUTH-9)
// ---------------------------------------------------------------------------

test('activeCredential names the winner and every shadowed credential', () => {
  assert.deepEqual(
    activeCredential(
      makeSettings({
        systemToken: 'SYSTEM-TOKEN-PLACEHOLDER',
        accessToken: 'USER-TOKEN-PLACEHOLDER',
        pageToken: 'PAGE-TOKEN-PLACEHOLDER',
      }),
    ),
    { source: 'FB_SYSTEM_TOKEN', shadowed: ['FB_ACCESS_TOKEN', 'FB_PAGE_TOKEN'] },
  );

  assert.deepEqual(
    activeCredential(
      makeSettings({
        accessToken: 'USER-TOKEN-PLACEHOLDER',
        pageToken: 'PAGE-TOKEN-PLACEHOLDER',
      }),
    ),
    { source: 'FB_ACCESS_TOKEN', shadowed: ['FB_PAGE_TOKEN'] },
  );

  assert.deepEqual(activeCredential(makeSettings()), { source: 'none', shadowed: [] });
});

test('the report names which credential the rest of it is about', async () => {
  const { fb, deps } = makeDeps({
    settings: makeSettings({
      systemToken: 'SYSTEM-TOKEN-PLACEHOLDER',
      pageToken: 'PAGE-TOKEN-PLACEHOLDER',
    }),
  });
  withDebugToken(fb, { type: 'SYSTEM_USER', is_valid: true, scopes: [], expires_at: 0 });

  const report = await runDoctor(deps);
  assert.equal(report.token.credentialSource, 'FB_SYSTEM_TOKEN');
  assert.deepEqual(report.token.shadowedCredentials, ['FB_PAGE_TOKEN']);

  const text = renderDoctorReport(report);
  assert.match(text, /credential:\s+FB_SYSTEM_TOKEN \(system-user token\)/);
  assert.match(text, /shadowed:\s+FB_PAGE_TOKEN \(also set, NOT used\)/);
});

test('an unconfigured doctor run reports the credential source as none', async () => {
  const { deps } = makeDeps({ settings: makeSettings() });

  const report = await runDoctor(deps);
  assert.equal(report.token.credentialSource, 'none');
  assert.deepEqual(report.token.shadowedCredentials, []);
  assert.equal(report.token.diagnosis, 'no_token');
  assert.match(renderDoctorReport(report), /diagnosis:\s+no token configured/);
});

// ---------------------------------------------------------------------------
// Granular scopes & diagnosis (CC-AUTH-5)
// ---------------------------------------------------------------------------

test('classifyAssetAccess judges only asset-scoped permissions', () => {
  assert.equal(classifyAssetAccess([]), 'not_reported');
  assert.equal(
    classifyAssetAccess([{ scope: 'public_profile', targetIds: [] }]),
    'not_reported',
    'a user-level permission legitimately has no targets',
  );
  assert.equal(
    classifyAssetAccess([
      { scope: 'pages_show_list', targetIds: [] },
      { scope: 'pages_read_engagement', targetIds: ['111'] },
    ]),
    'ok',
  );
  assert.equal(
    classifyAssetAccess([
      { scope: 'pages_show_list', targetIds: [] },
      { scope: 'business_management', targetIds: [] },
    ]),
    'revoked',
  );
});

test('a healthy token surfaces its granular grants and diagnoses ok', async () => {
  const { fb, deps } = makeDeps();
  withDebugToken(fb, {
    type: 'SYSTEM_USER',
    is_valid: true,
    scopes: ['pages_show_list', 'pages_read_engagement'],
    expires_at: 0,
    granular_scopes: [{ scope: 'pages_show_list', target_ids: ['111', '222'] }],
  });

  const report = await runDoctor(deps);
  assert.deepEqual(report.token.granularScopes, [
    { scope: 'pages_show_list', targetIds: ['111', '222'] },
  ]);
  assert.equal(report.token.assetAccess, 'ok');
  assert.equal(report.token.diagnosis, 'ok');

  const text = renderDoctorReport(report);
  assert.match(text, /granular:\s+pages_show_list -> 111,222/);
  assert.match(text, /asset access:\s+ok \(at least one asset still granted\)/);
  assert.match(text, /diagnosis:\s+ok/);
});

test('a valid token whose assets are gone diagnoses revoked, not malformed', async () => {
  const { fb, deps } = makeDeps();
  withDebugToken(fb, {
    type: 'SYSTEM_USER',
    is_valid: true,
    scopes: ['pages_show_list', 'pages_read_engagement'],
    expires_at: 0,
    granular_scopes: [
      { scope: 'pages_show_list', target_ids: [] },
      { scope: 'pages_read_engagement', target_ids: [] },
    ],
  });

  const report = await runDoctor(deps);
  assert.equal(report.token.valid, true, 'the token itself still parses');
  assert.equal(report.token.assetAccess, 'revoked');
  assert.equal(report.token.diagnosis, 'asset_access_revoked');

  const text = renderDoctorReport(report);
  assert.match(text, /granular:\s+pages_show_list -> \(no assets\)/);
  assert.match(text, /ASSET ACCESS REVOKED/);
  assert.match(text, /Business settings/, 'the fix is re-granting, not re-issuing');
});

test('a grant Meta reports with no target_ids covers all assets, not none', async () => {
  const { fb, deps } = makeDeps();
  withDebugToken(fb, {
    type: 'SYSTEM_USER',
    is_valid: true,
    scopes: ['pages_show_list', 'pages_read_engagement'],
    expires_at: 0,
    // No target_ids key at all: Meta's shape for "granted over every asset".
    granular_scopes: [{ scope: 'pages_show_list' }, { scope: 'pages_read_engagement' }],
  });

  const report = await runDoctor(deps);
  assert.equal(report.token.assetAccess, 'ok');
  assert.notEqual(report.token.diagnosis, 'asset_access_revoked');

  const text = renderDoctorReport(report);
  assert.match(text, /granular:\s+pages_show_list -> \(all assets\)/);
  assert.doesNotMatch(text, /ASSET ACCESS REVOKED/);
});

test('a token debug_token rejects diagnoses as malformed, not as revoked', async () => {
  const { fb, deps } = makeDeps();
  // Graph ANSWERED and refused the credential — the 400 is what makes "malformed"
  // an honest verdict rather than a guess.
  fb.on(
    (req) => req.path === '/debug_token',
    fbErr(
      new GraphApiError('Error validating access token: malformed access token', {
        code: 190,
        httpStatus: 400,
        type: 'OAuthException',
      }),
    ),
  );

  const report = await runDoctor(deps);
  assert.equal(report.token.diagnosis, 'token_malformed');
  assert.equal(report.token.assetAccess, 'not_reported');
  assert.deepEqual(report.token.granularScopes, []);
  assert.match(renderDoctorReport(report), /TOKEN MALFORMED OR INVALID/);
});

test("a 200 that reports the token invalid carries Graph's reason into the report", async () => {
  const { fb, deps } = makeDeps();
  // The far more common shape than the 400 above: Graph accepts the CALL and
  // rejects the SUBJECT, so `debug_token` answers 200 with `is_valid: false` and
  // the cause in the body. The doctor used to print `TOKEN MALFORMED OR INVALID`
  // with an empty `error:` line — a verdict with no evidence, on the one command
  // an operator runs precisely because they do not know what is wrong.
  fb.on(
    (req) => req.path === '/debug_token',
    fbOk({
      data: {
        is_valid: false,
        error: {
          code: 190,
          subcode: 463,
          message: 'Error validating access token: Session has expired.',
        },
      },
    }),
  );

  const report = await runDoctor(deps);
  assert.equal(report.token.diagnosis, 'token_malformed');
  assert.equal(
    report.token.error,
    'Error validating access token: Session has expired. (code 190, subcode 463)',
  );
  const text = renderDoctorReport(report);
  assert.match(text, /TOKEN MALFORMED OR INVALID/);
  assert.match(text, /Session has expired\. \(code 190, subcode 463\)/);
});

test('a network failure does not convict the token — CC-NET-6, not a bad credential', async () => {
  const { fb, deps } = makeDeps();
  // The shape `core/http` throws when no response ever arrived: httpStatus 0.
  fb.on(
    (req) => req.path === '/debug_token',
    fbErr(
      new GraphApiError(
        'network request failed: getaddrinfo ENOTFOUND graph.facebook.com',
        {
          code: 0,
          httpStatus: 0,
          action: {
            category: 'transient',
            retryable: true,
            operatorText: 'Network fault (DNS lookup failed).',
          },
        },
      ),
    ),
  );

  const report = await runDoctor(deps);
  assert.equal(report.token.diagnosis, 'token_check_failed');
  assert.equal(report.token.configured, true, 'a token IS set — it just was not checked');

  const text = renderDoctorReport(report);
  assert.match(text, /TOKEN NOT CHECKED/);
  assert.doesNotMatch(
    text,
    /TOKEN MALFORMED/,
    'sending the operator to re-issue a healthy token hides the real fault',
  );
  // The metric probe skips for the connection, not because the token is "dead".
  assert.match(report.metricSet.summary, /could not be checked/);
});

test('a token Graph reports without granular_scopes stays "not reported"', async () => {
  const { fb, deps } = makeDeps();
  withDebugToken(fb, {
    type: 'USER',
    is_valid: true,
    scopes: ['pages_show_list'],
    expires_at: 0,
  });

  const report = await runDoctor(deps);
  assert.equal(report.token.assetAccess, 'not_reported');
  assert.equal(report.token.diagnosis, 'ok', 'silence is not evidence of revocation');
  assert.match(renderDoctorReport(report), /granular:\s+\(not reported\)/);
});

// ---------------------------------------------------------------------------
// Credential file protection (CC-CFG-4)
// ---------------------------------------------------------------------------

test('a missing credential file is reported as env-only, not as a failure', async () => {
  const { fb, deps } = makeDeps();
  withDebugToken(fb, { type: 'USER', is_valid: true, scopes: [], expires_at: 0 });

  const report = await runDoctor(deps);
  assert.equal(report.credentialFile.exists, false);
  assert.equal(report.credentialFile.path, NO_CREDENTIAL_FILE);
  assert.match(report.credentialFile.note, /credentials come from the environment only/);
  assert.match(renderDoctorReport(report), /protection:\s+No credential file/);
});

test('the doctor reports the OBSERVED mode of a credential file', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX permission bits are not enforced on win32');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'facebook-mcp-doctor-'));
  const filePath = join(dir, 'env');
  await writeFile(filePath, 'FB_ACCESS_TOKEN=USER-TOKEN-PLACEHOLDER\n', { mode: 0o600 });

  const { fb, deps } = makeDeps({ credentialFilePath: filePath });
  withDebugToken(fb, { type: 'USER', is_valid: true, scopes: [], expires_at: 0 });

  const tight = await runDoctor(deps);
  assert.equal(tight.credentialFile.exists, true);
  assert.equal(tight.credentialFile.ownerOnly, true);
  assert.equal(tight.credentialFile.mode, 0o600);
  assert.match(renderDoctorReport(tight), /protection:\s+0600 — owner-only, as intended/);

  await chmod(filePath, 0o644);
  const loose = await runDoctor(deps);
  assert.equal(loose.credentialFile.ownerOnly, false);
  assert.equal(loose.credentialFile.mode, 0o644);
  assert.match(renderDoctorReport(loose), /0644 — WARNING: group\/other can read/);

  // The doctor report is the artifact operators paste into issues, and this probe
  // is the one that touches a file full of credentials. Naming the PATH is the
  // whole point; echoing what is INSIDE it — or the token already in settings —
  // would turn the diagnostic into the leak it is meant to warn about.
  const haystack = `${JSON.stringify(loose)}\n${renderDoctorReport(loose)}`;
  assert.ok(
    !haystack.includes('USER-TOKEN-PLACEHOLDER'),
    'the credential file is stat-ed, never read into the report',
  );
  assert.ok(!haystack.includes('EAA-runtime'), 'the configured token stays out too');
});

test('a credential file on win32 is reported as unenforceable, not as safe', async (t) => {
  if (process.platform === 'win32') {
    t.skip('this asserts the win32 branch as observed from a POSIX host');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'facebook-mcp-doctor-win32-'));
  const filePath = join(dir, 'env');
  await writeFile(filePath, 'FB_ACCESS_TOKEN=USER-TOKEN-PLACEHOLDER\n', { mode: 0o600 });

  const { fb, deps } = makeDeps({ credentialFilePath: filePath, platform: 'win32' });
  withDebugToken(fb, { type: 'USER', is_valid: true, scopes: [], expires_at: 0 });

  const report = await runDoctor(deps);
  assert.equal(report.credentialFile.posixPermissions, false);
  assert.equal(report.credentialFile.ownerOnly, false);
  assert.match(renderDoctorReport(report), /protection:\s+WARNING:/);
});

test('an unreadable credential path is reported instead of crashing the doctor', async (t) => {
  if (process.platform === 'win32') {
    // Statting THROUGH a regular file is ENOTDIR on POSIX but collapses to plain
    // ENOENT on win32, which is the "no credential file" branch, not this one.
    // The platform-independent shape below covers the same branch there.
    t.skip('win32 reports ENOENT for this path shape');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'facebook-mcp-doctor-enotdir-'));
  const notADir = join(dir, 'env');
  await writeFile(notADir, 'FB_ACCESS_TOKEN=USER-TOKEN-PLACEHOLDER\n');

  const { fb, deps } = makeDeps({ credentialFilePath: join(notADir, 'nested') });
  withDebugToken(fb, { type: 'USER', is_valid: true, scopes: [], expires_at: 0 });

  const report = await runDoctor(deps);
  assert.equal(report.credentialFile.exists, false);
  assert.match(report.credentialFile.note, /Could not read file protection/);
});

test('a credential path Node refuses outright is reported, not thrown', async () => {
  // A NUL byte makes `stat` fail before any syscall, on every platform, with a
  // code that is not ENOENT — the same branch as ENOTDIR, reachable everywhere.
  // Built from a code point so this source file stays plain ASCII.
  const nul = String.fromCharCode(0);
  const { fb, deps } = makeDeps({ credentialFilePath: `${tmpdir()}${nul}env` });
  withDebugToken(fb, { type: 'USER', is_valid: true, scopes: [], expires_at: 0 });

  const report = await runDoctor(deps);
  assert.equal(report.credentialFile.exists, false);
  assert.match(report.credentialFile.note, /Could not read file protection/);
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
  assert.match(text, /Ad account/);
});

// ---------------------------------------------------------------------------
// Insights metric-set probe (C6 / CC-INS-1)
// ---------------------------------------------------------------------------

/** A three-name stand-in for the shipped set: two renamed lineages + one plain. */
const PROBE_SET: readonly ProbedMetric[] = [
  { metric: 'page_media_view', replaces: ['page_impressions'] },
  { metric: 'page_follows', replaces: ['page_fans'] },
  { metric: 'page_video_views' },
];

const ALL_METRICS = 'page_media_view,page_follows,page_video_views';

/** Noon UTC, so the day boundaries in the assertions are unambiguous. */
const PROBE_NOW = Date.UTC(2026, 2, 15, 12, 0, 0);

/** A Graph insights row with `points` daily values. */
function insightRow(name: string, values: readonly (number | null)[]): unknown {
  return {
    name,
    period: 'day',
    values: values.map((value, index) => ({
      value,
      end_time: `2026-03-1${String(3 + index)}`,
    })),
  };
}

/** The shape Graph uses to refuse a metric NAME (as opposed to the call). */
function metricRejection(metric: string): GraphApiError {
  return new GraphApiError(
    `(#100) Requires metric to be one of the following values: ..., ${metric} is not valid`,
    {
      code: 100,
      httpStatus: 400,
      type: 'OAuthException',
      action: {
        category: 'validation',
        retryable: false,
        operatorText: 'Check the metric name against the Graph API changelog.',
      },
    },
  );
}

function makeMetricSetDeps(
  opts: {
    settings?: Settings;
    metricSet?: readonly ProbedMetric[];
    tokenValid?: boolean;
  } = {},
): DoctorParts {
  const parts = makeDeps({
    settings:
      opts.settings ??
      makeSettings({ accessToken: 'ACCESS-TOKEN-PLACEHOLDER', defaultPageId: '1010' }),
    nowMs: PROBE_NOW,
    metricSet: opts.metricSet ?? PROBE_SET,
  });
  withDebugToken(parts.fb, {
    type: 'SYSTEM_USER',
    is_valid: opts.tokenValid ?? true,
    scopes: ['read_insights', 'pages_read_engagement'],
    expires_at: 0,
  });
  // A user / system-user credential is not what Graph wants on a Page insights
  // edge: the probe derives the Page token the tools would use, like they do.
  onPageTokenDerivation(parts.fb, '1010');
  return parts;
}

/** The Page token the fake hands out for `pageId` on a derivation call. */
function derivedPageToken(pageId: string): string {
  return `PAGE-${pageId}-TOKEN-PLACEHOLDER`;
}

/** Program the `/{page}?fields=access_token` derivation for one Page. */
function onPageTokenDerivation(fb: FakeFbRequest, pageId: string): void {
  fb.on(
    (req) =>
      req.protocol === 'json' &&
      req.path === `/${pageId}` &&
      req.params?.fields === 'access_token',
    fbOk({ access_token: derivedPageToken(pageId), id: pageId }),
  );
}

/** Every insights call the probe made, in order. */
function insightsCalls(fb: FakeFbRequest): readonly JsonRequest[] {
  return fb.calls.filter(
    (call): call is JsonRequest =>
      call.protocol === 'json' && call.path.endsWith('/insights'),
  );
}

/** Program the batched attempt (all names at once). */
function onBatch(fb: FakeFbRequest, result: Parameters<FakeFbRequest['on']>[1]): void {
  fb.on((req) => req.protocol === 'json' && req.params?.metric === ALL_METRICS, result);
}

/** Program the isolated attempt for a single name. */
function onSingle(
  fb: FakeFbRequest,
  metric: string,
  result: Parameters<FakeFbRequest['on']>[1],
): void {
  fb.on((req) => req.protocol === 'json' && req.params?.metric === metric, result);
}

test('metric-set probe: one batched call verifies the whole shipped set', async () => {
  const { fb, deps } = makeMetricSetDeps();
  onBatch(
    fb,
    fbOk({
      data: [
        insightRow('page_media_view', [11, 12]),
        insightRow('page_follows', [3]),
        insightRow('page_video_views', [0, 4]),
      ],
    }),
  );

  const report = await runDoctor(deps);
  const set = report.metricSet;

  assert.equal(set.outcome, 'probed');
  assert.equal(set.requests, 1, 'the happy path costs exactly one Graph call');
  assert.deepEqual(
    set.verdicts.map((v) => v.status),
    ['accepted', 'accepted', 'accepted'],
  );
  assert.deepEqual(
    set.verdicts.map((v) => v.points),
    [2, 1, 2],
  );

  const [call] = insightsCalls(fb);
  assert.ok(call);
  assert.equal(call.path, '/1010/insights');
  assert.equal(call.method, 'GET');
  assert.equal(call.params?.metric, ALL_METRICS);
  assert.equal(call.params?.period, METRIC_PROBE_PERIOD);
  assert.equal(call.params?.since, '2026-03-13', 'a cheap 3-day window, not a data pull');
  assert.equal(call.params?.until, '2026-03-15');
  assert.equal(
    call.token,
    derivedPageToken('1010'),
    'a Page insights edge is read with the Page token, the same credential the insights tools use',
  );

  assert.match(
    set.summary,
    /3 accepted, 0 empty, 0 rejected, 0 unknown of 3 on Page 1010/,
  );
  assert.match(set.summary, /\(FB_PAGE_ID\)/);
  assert.ok(
    set.notes.some((note) => /documented metric set is current/.test(note)),
    'a clean run says so instead of staying silent',
  );
});

test('metric-set probe: an empty series is reported as data, never as a failure', async () => {
  const { fb, deps } = makeMetricSetDeps();
  onBatch(
    fb,
    fbOk({
      data: [
        insightRow('page_media_view', []),
        insightRow('page_follows', [null, null]),
        insightRow('page_video_views', [7]),
      ],
    }),
  );

  const set = (await runDoctor(deps)).metricSet;
  assert.equal(set.outcome, 'probed');
  assert.deepEqual(
    set.verdicts.map((v) => v.status),
    ['empty', 'empty', 'accepted'],
    'no values at all and only null values both mean "accepted, no data"',
  );
  assert.deepEqual(
    set.verdicts.map((v) => v.points),
    [0, 0, 1],
  );
  assert.equal(
    set.verdicts.filter((v) => v.status === 'empty').every((v) => v.error === undefined),
    true,
    'an empty series carries no error text',
  );
  const floorNote = set.notes.find((note) => /empty series is DATA/.test(note));
  assert.ok(floorNote, 'the report must say plainly that empty is not a defect');
  assert.match(floorNote, new RegExp(String(METRIC_PROBE_LIKES_FLOOR)));
  assert.ok(
    set.notes.some((note) => /does not support daily buckets/.test(note)),
    'period=day is the only period asked for, and that has to be stated',
  );
  assert.ok(!set.notes.some((note) => /^ACTION/.test(note)));
});

test('metric-set probe: a rejected name is isolated and its neighbours still report', async () => {
  const { fb, deps } = makeMetricSetDeps();
  onBatch(fb, fbErr(metricRejection('page_follows')));
  onSingle(fb, 'page_media_view', fbOk({ data: [insightRow('page_media_view', [5])] }));
  onSingle(fb, 'page_follows', fbErr(metricRejection('page_follows')));
  onSingle(fb, 'page_video_views', fbOk({ data: [insightRow('page_video_views', [])] }));

  const report = await runDoctor(deps);
  const set = report.metricSet;

  assert.equal(set.outcome, 'probed');
  assert.equal(set.requests, 4, 'one batched attempt + exactly one call per metric');
  assert.equal(insightsCalls(fb).length, 4, 'no metric is ever asked twice');
  assert.deepEqual(
    set.verdicts.map((v) => v.status),
    ['accepted', 'rejected', 'empty'],
  );

  const rejected = set.verdicts[1];
  assert.ok(rejected);
  assert.match(String(rejected.error), /#100/, "Graph's own words survive");
  assert.match(String(rejected.error), /is not valid/);
  assert.doesNotMatch(
    String(rejected.error),
    /\(#100\) \(#100\)/,
    'Meta already labels its own message with the code',
  );
  assert.match(
    String(rejected.error),
    /Graph API changelog/,
    'plus the taxonomy guidance',
  );
  assert.match(String(rejected.suggestion), /page_fans/, 'names the dead predecessor');
  assert.deepEqual(rejected.replaces, ['page_fans']);

  assert.ok(set.notes.some((note) => /ACTION: 1 of 3/.test(note)));
  assert.ok(set.notes.some((note) => /re-asked on its own/.test(note)));

  const text = renderDoctorReport(report);
  assert.match(text, /Insights metric set/);
  assert.match(text, /\[OK {6}\] page_media_view {14}1 data point/);
  assert.match(text, /\[REJECTED\] page_follows/);
  assert.match(text, /-> Meta no longer accepts "page_follows"/);
  assert.match(text, /\[EMPTY {3}\] page_video_views {13}accepted by Graph, no data/);
});

test('metric-set probe: every name rejected still costs one call per metric', async () => {
  const { fb, deps } = makeMetricSetDeps();
  onBatch(fb, fbErr(metricRejection('page_media_view')));
  for (const metric of ['page_media_view', 'page_follows', 'page_video_views']) {
    onSingle(fb, metric, fbErr(metricRejection(metric)));
  }

  const set = (await runDoctor(deps)).metricSet;
  assert.equal(set.outcome, 'probed', 'a fully drifted set is a finding, not a crash');
  assert.equal(set.requests, 4);
  assert.deepEqual(
    set.verdicts.map((v) => v.status),
    ['rejected', 'rejected', 'rejected'],
  );
  assert.ok(set.notes.some((note) => /ACTION: 3 of 3/.test(note)));
  assert.ok(
    set.verdicts.every((v) => v.suggestion !== undefined),
    'each dead name carries its own fix',
  );
  assert.match(
    String(set.verdicts[2]?.suggestion),
    /Graph API changelog/,
    'a metric with no recorded lineage still gets actionable advice',
  );
});

test('metric-set probe: a metric Graph never mentions is unknown, not empty', async () => {
  const { fb, deps } = makeMetricSetDeps();
  onBatch(
    fb,
    fbOk({
      data: [insightRow('page_media_view', [1]), insightRow('page_follows', [2])],
    }),
  );

  const set = (await runDoctor(deps)).metricSet;
  assert.deepEqual(
    set.verdicts.map((v) => v.status),
    ['accepted', 'accepted', 'unknown'],
  );
  assert.match(
    String(set.verdicts[2]?.suggestion),
    /not valid for this Page or for v23\.0/,
  );
  assert.ok(set.notes.some((note) => /ACTION: 1 of 3/.test(note)));
});

test('metric-set probe: a whole-API failure is reported, and stops after one call', async () => {
  const { fb, deps } = makeMetricSetDeps();
  onBatch(
    fb,
    fbErr(
      new GraphApiError('Error validating access token: session has expired', {
        code: 190,
        subcode: 463,
        httpStatus: 401,
        type: 'OAuthException',
        action: {
          category: 'auth',
          retryable: false,
          operatorText: 'Re-issue the credential and restart the server.',
        },
      }),
    ),
  );

  const report = await runDoctor(deps);
  const set = report.metricSet;

  assert.equal(set.outcome, 'failed');
  assert.equal(set.requests, 1, 'a dead edge is not hammered once per metric');
  assert.deepEqual(set.verdicts, []);
  assert.match(set.summary, /probe failed/);
  assert.match(set.summary, /#190\/463/, 'the subcode is what tells 190s apart');
  assert.match(set.summary, /session has expired/);
  assert.match(set.summary, /Re-issue the credential/);
  assert.ok(
    set.notes.some((note) =>
      /says nothing about whether they are still valid/.test(note),
    ),
    'a failed probe must not read as "the metric names are fine"',
  );
  assert.match(
    renderDoctorReport(report),
    /Insights metric set\n {2}metric set: probe failed/,
  );
});

test('metric-set probe: a non-Graph failure is reported without a code prefix', async () => {
  const { fb, deps } = makeMetricSetDeps();
  onBatch(fb, fbErr(new Error('socket hang up')));

  const set = (await runDoctor(deps)).metricSet;
  assert.equal(set.outcome, 'failed');
  assert.match(set.summary, /socket hang up/);
  assert.doesNotMatch(set.summary, /#/);
});

test('metric-set probe: the failure text goes through the redactor', async () => {
  const parts = makeMetricSetDeps();
  const redactor = createFakeRedactor({ secrets: ['ACCESS-TOKEN-PLACEHOLDER'] });
  onBatch(
    parts.fb,
    fbErr(new Error('Invalid OAuth access token ACCESS-TOKEN-PLACEHOLDER for this Page')),
  );

  const set = (await runDoctor({ ...parts.deps, redactor })).metricSet;
  assert.doesNotMatch(set.summary, /ACCESS-TOKEN-PLACEHOLDER/);
  assert.match(set.summary, /\[REDACTED\]/);
});

test('metric-set probe: a mid-isolation outage halts the pass instead of retrying', async () => {
  const { fb, deps } = makeMetricSetDeps();
  onBatch(fb, fbErr(metricRejection('page_media_view')));
  onSingle(fb, 'page_media_view', fbErr(metricRejection('page_media_view')));
  onSingle(
    fb,
    'page_follows',
    fbErr(
      new GraphApiError('User request limit reached', {
        code: 17,
        httpStatus: 429,
        action: {
          category: 'rate_limit',
          retryable: true,
          operatorText: 'Back off and re-run the doctor later.',
        },
      }),
    ),
  );
  onSingle(fb, 'page_video_views', fbOk({ data: [insightRow('page_video_views', [1])] }));

  const set = (await runDoctor(deps)).metricSet;
  assert.deepEqual(
    set.verdicts.map((v) => v.status),
    ['rejected', 'unknown', 'unknown'],
  );
  assert.equal(
    set.requests,
    3,
    'the third metric is never asked — the edge already said no',
  );
  assert.equal(insightsCalls(fb).length, 3);
  assert.match(String(set.verdicts[1]?.suggestion), /User request limit reached/);
  assert.match(String(set.verdicts[2]?.suggestion), /stopped earlier/);
  assert.match(String(set.verdicts[2]?.suggestion), /User request limit reached/);
});

test('metric-set probe: skipped without a token, and it costs no Graph call', async () => {
  const { fb, deps } = makeDeps({ settings: makeSettings({ defaultPageId: '1010' }) });

  const report = await runDoctor(deps);
  assert.equal(report.metricSet.outcome, 'skipped');
  assert.match(report.metricSet.summary, /no token configured/);
  assert.match(report.metricSet.summary, /FB_ACCESS_TOKEN/);
  assert.equal(report.metricSet.requests, 0);
  assert.deepEqual(report.metricSet.verdicts, []);
  assert.equal(fb.calls.length, 0, 'the doctor never probes without a credential');
  assert.match(renderDoctorReport(report), /metric set: skipped \(no token configured/);
});

test('metric-set probe: skipped when the token itself did not check out', async () => {
  const { fb, deps } = makeMetricSetDeps({ tokenValid: false });

  const set = (await runDoctor(deps)).metricSet;
  assert.equal(set.outcome, 'skipped');
  assert.match(set.summary, /did not check out/);
  assert.equal(insightsCalls(fb).length, 0);
});

test('metric-set probe: skipped when no Page is configured', async () => {
  const { fb, deps } = makeMetricSetDeps({
    settings: makeSettings({ accessToken: 'ACCESS-TOKEN-PLACEHOLDER' }),
  });

  const set = (await runDoctor(deps)).metricSet;
  assert.equal(set.outcome, 'skipped');
  assert.match(set.summary, /no Page configured/);
  assert.match(set.summary, /FB_PAGE_ID/);
  assert.equal(insightsCalls(fb).length, 0, 'the doctor does not go shopping for a Page');
});

test('metric-set probe: skipped when the metric set is empty', async () => {
  const { fb, deps } = makeMetricSetDeps({ metricSet: [] });

  const set = (await runDoctor(deps)).metricSet;
  assert.equal(set.outcome, 'skipped');
  assert.match(set.summary, /metric set is empty/);
  assert.equal(insightsCalls(fb).length, 0);
});

test('metric-set probe: falls back to a profile Page, deterministically', async () => {
  const { fb, deps } = makeMetricSetDeps({
    settings: makeSettings({
      accessToken: 'ACCESS-TOKEN-PLACEHOLDER',
      profiles: {
        brand: { pageId: '2020' },
        agency: { pageId: '3030' },
      },
    }),
  });
  onPageTokenDerivation(fb, '3030');
  fb.on((req) => req.path === '/3030/insights', fbOk({ data: [] }));

  const set = (await runDoctor(deps)).metricSet;
  assert.equal(
    set.pageId,
    '3030',
    'alphabetically first profile, so runs are repeatable',
  );
  assert.match(set.summary, /profile "agency"/);
  assert.deepEqual(
    set.verdicts.map((v) => v.status),
    ['unknown', 'unknown', 'unknown'],
    'an answer that mentions no metric at all establishes nothing',
  );
});

test('metric-set probe: a blank profile Page is not a Page', async () => {
  const { deps } = makeMetricSetDeps({
    settings: makeSettings({
      accessToken: 'ACCESS-TOKEN-PLACEHOLDER',
      defaultPageId: '   ',
      profiles: { brand: { pageId: '  ' } },
    }),
  });

  const set = (await runDoctor(deps)).metricSet;
  assert.equal(set.outcome, 'skipped');
  assert.match(set.summary, /no Page configured/);
});

test('PROBED_PAGE_METRICS agrees with the api layer it may not import', () => {
  // `length > 0` survives a list gutted down to a single entry, and the probe
  // would then hand back a clean bill of health for a metric set the README
  // still advertises. The shipped set IS the contract, so pin it by name.
  assert.deepEqual(
    PROBED_PAGE_METRICS.map((entry) => entry.metric),
    [
      'page_media_view',
      'page_post_engagements',
      'page_follows',
      'page_daily_follows',
      'page_daily_follows_unique',
      'page_daily_unfollows',
      'page_daily_unfollows_unique',
      'page_video_views',
    ],
  );

  // The loop below walks list → api. This walks api → list: every Page-scope name
  // the api layer silently RENAMES a caller into has to be a name the doctor
  // actually probes, otherwise the tools redirect callers onto metrics whose
  // liveness nothing verifies.
  const probedRenames = new Set(
    PROBED_PAGE_METRICS.flatMap((e) => [...(e.replaces ?? [])]),
  );
  for (const dead of [
    'page_fans',
    'page_fan_adds',
    'page_fan_adds_unique',
    'page_fan_removes',
    'page_fan_removes_unique',
    'page_engaged_users',
    'page_impressions',
  ]) {
    const verdict = classifyMetric(dead);
    assert.equal(verdict.status, 'renamed', `${dead} should still be a known rename`);
    assert.ok(
      probedRenames.has(dead),
      `${dead} is renamed by the api layer but unprobed`,
    );
  }

  for (const entry of PROBED_PAGE_METRICS) {
    assert.equal(
      classifyMetric(entry.metric).status,
      'ok',
      `${entry.metric} is shipped as live but the api layer treats it as deprecated`,
    );
    for (const dead of entry.replaces ?? []) {
      const verdict = classifyMetric(dead);
      assert.equal(verdict.status, 'renamed', `${dead} should be a known rename`);
      assert.equal(
        verdict.replacement,
        entry.metric,
        `the api layer maps ${dead} somewhere else than ${entry.metric}`,
      );
    }
  }
  assert.equal(METRIC_PROBE_LIKES_FLOOR, PAGE_INSIGHTS_LIKES_FLOOR);
  assert.equal(METRIC_PROBE_MAX_WINDOW_DAYS, INSIGHTS_MAX_WINDOW_DAYS);
  assert.ok(
    METRIC_PROBE_WINDOW_DAYS < METRIC_PROBE_MAX_WINDOW_DAYS,
    'the probe must stay well inside the window Graph allows',
  );
});

// ---------------------------------------------------------------------------
// Overall verdict (`doctor --strict`)
// ---------------------------------------------------------------------------

/**
 * A healthy report, used as the base every rule test mutates. Returning the
 * whole report (summary included) is deliberate: `summarizeDoctor` takes the
 * report minus its own summary, and a `DoctorReport` satisfies that, so each
 * test can override one slice and re-derive the verdict from the same input the
 * real run would have produced.
 */
async function healthyReport(): Promise<DoctorReport> {
  const { fb, deps } = makeDeps();
  withDebugToken(fb, {
    type: 'SYSTEM_USER',
    is_valid: true,
    scopes: ['pages_show_list', 'pages_read_engagement'],
    // What Graph really says for a System-User token. A fixture that leaves
    // the expiry unstated is not "healthy": the doctor cannot tell when that
    // credential stops working, and says so.
    expires_at: 0,
  });
  return runDoctor(deps);
}

test('a healthy configuration verdicts ok, and --strict keeps it green', async () => {
  const report = await healthyReport();
  assert.equal(report.summary.verdict, 'ok');
  assert.deepEqual([...report.summary.findings], []);
  assert.equal(doctorExitCode(report.summary.verdict, true), 0);
  assert.match(renderDoctorReport(report), /Verdict\n {2}OK — nothing needs attention/);
});

test('a missing credential verdicts fail; only --strict turns that into an exit code', async () => {
  const { deps } = makeDeps({ settings: makeSettings() });

  const report = await runDoctor(deps);
  assert.equal(report.summary.verdict, 'fail');
  assert.ok(
    report.summary.findings.some(
      (f) => f.severity === 'fail' && /No credential is configured/.test(f.detail),
    ),
  );
  assert.equal(doctorExitCode(report.summary.verdict, true), 2);
  // The default is a REPORT: a wrapper that runs the doctor for its text must
  // not start failing because the doctor found what it was asked to look for.
  assert.equal(doctorExitCode(report.summary.verdict, false), 0);
  assert.match(renderDoctorReport(report), /Verdict\n {2}FAIL —/);
});

test('an unresolvable package selection fails the verdict and says so first', async () => {
  // The doctor is what an operator runs when something is wrong, and a selection
  // that does not expand is a server that never starts. Judging a healthy token
  // and a full package matrix in that state is a green report on an install that
  // cannot answer a single request.
  const base = await healthyReport();
  const summary = summarizeDoctor({
    ...base,
    packageSelectionError:
      'Unknown tool package/profile name(s) in FB_PACKAGES_DENY: "reeder". Valid names: ads, all, core.',
  });

  assert.equal(summary.verdict, 'fail');
  assert.equal(doctorExitCode(summary.verdict, true), 2);
  const finding = summary.findings.find((f) => f.area === 'configuration');
  assert.ok(finding, 'expected a configuration finding');
  assert.equal(finding.severity, 'fail');
  // The variable to fix, carried through from the selection error.
  assert.match(finding.detail, /FB_PACKAGES_DENY/);
  // And the caveat that makes the rest of the report readable rather than wrong.
  assert.match(finding.detail, /built over every package/);
});

test('the render names the startup blocker above the token block', async () => {
  const base = await healthyReport();
  const report = {
    ...base,
    packageSelectionError:
      'Unknown tool package/profile name(s) in FB_TOOL_PACKAGES: "nope".',
  };
  const text = renderDoctorReport({ ...report, summary: summarizeDoctor(report) });

  assert.match(text, /Configuration\n {2}packages: {5}WILL NOT START/);
  // Order matters: everything under Token is contingent on the server starting.
  assert.ok(
    text.indexOf('WILL NOT START') < text.indexOf('\nToken\n'),
    'the startup blocker must precede the token block',
  );
});

test('a resolvable selection adds no configuration finding and no Configuration block', async () => {
  const report = await healthyReport();
  assert.equal(
    report.summary.findings.some((f) => f.area === 'configuration'),
    false,
  );
  assert.doesNotMatch(renderDoctorReport(report), /WILL NOT START/);
});

test('a startup error reaches the verdict as a failure, a startup warning as a warning (wave 9)', async () => {
  // `loadSettings()` already judges the environment the doctor runs in: an
  // error there is a server `assertStartupOk` refuses to start, a warning is
  // what the real start logs first. The doctor was handed neither, so
  // `doctor --strict` exited 0 on an install that will never answer a request.
  const base = await healthyReport();
  const blocker: StartupProblem = {
    severity: 'error',
    code: 'http-no-token',
    field: 'FB_HTTP_TOKEN',
    message: 'FB_TRANSPORT=http requires FB_HTTP_TOKEN to be set.',
  };
  const failed = summarizeDoctor({ ...base, startupProblems: [blocker] });
  const failFinding = failed.findings.find((f) => f.area === 'configuration');
  assert.ok(failFinding, 'expected a configuration finding for the startup error');
  assert.equal(failFinding.severity, 'fail');
  assert.match(failFinding.detail, /FB_HTTP_TOKEN/);
  assert.equal(failed.verdict, 'fail');
  assert.equal(doctorExitCode(failed.verdict, true), 2);

  const soft: StartupProblem = {
    severity: 'warning',
    code: 'no-app-secret',
    field: 'FB_APP_SECRET',
    message: 'FB_APP_SECRET is not set; requests will not carry appsecret_proof.',
  };
  const warned = summarizeDoctor({ ...base, startupProblems: [soft] });
  const warnFinding = warned.findings.find((f) => f.area === 'configuration');
  assert.ok(warnFinding, 'expected a configuration finding for the startup warning');
  assert.equal(warnFinding.severity, 'warn');
  assert.match(warnFinding.detail, /FB_APP_SECRET/);
  assert.equal(warned.verdict, 'warn');
  assert.equal(doctorExitCode(warned.verdict, true), 1);

  // Problems the doctor already judges in its own words stay single-voiced:
  // no credential is the token block's failure, a page token bound to no page
  // is the binding check, and no page at all is why the metric probe is quiet.
  const alreadyJudged: StartupProblem[] = [
    {
      severity: 'error',
      code: 'no-access-token',
      message: 'No access token configured.',
    },
    {
      severity: 'warning',
      code: 'page-token-unbound',
      message: 'FB_PAGE_TOKEN without FB_PAGE_ID.',
    },
    { severity: 'warning', code: 'no-page', message: 'No FB_PAGE_ID configured.' },
  ];
  const quiet = summarizeDoctor({ ...base, startupProblems: alreadyJudged });
  assert.equal(
    quiet.findings.some((f) => f.area === 'configuration'),
    false,
    'problems the doctor already reports elsewhere must not be echoed as configuration findings',
  );

  // `runDoctor` carries the problems into the report, so a real run renders
  // the blocker the way the package blocker renders: before the token block.
  const { fb, deps } = makeDeps();
  withDebugToken(fb, {
    type: 'SYSTEM_USER',
    is_valid: true,
    scopes: ['pages_show_list', 'pages_read_engagement'],
    expires_at: 0,
  });
  const report = await runDoctor({ ...deps, startupProblems: [blocker] });
  assert.equal(report.summary.verdict, 'fail');
  const text = renderDoctorReport(report);
  assert.match(
    text,
    /Configuration\n {2}FB_HTTP_TOKEN: WILL NOT START — .*FB_HTTP_TOKEN/,
  );
  assert.ok(
    text.indexOf('WILL NOT START') < text.indexOf('\nToken\n'),
    'the startup blocker must precede the token block',
  );
});

test('an unreachable debug_token verdicts unknown, never fail (CC-NET-6)', async () => {
  const { fb, deps } = makeDeps();
  fb.on(
    (req) => req.path === '/debug_token',
    fbErr(
      new GraphApiError('network request failed: getaddrinfo ENOTFOUND', {
        code: 0,
        httpStatus: 0,
        action: {
          category: 'transient',
          retryable: true,
          operatorText: 'Network fault (DNS lookup failed).',
        },
      }),
    ),
  );

  const report = await runDoctor(deps);
  assert.equal(report.summary.verdict, 'unknown');
  assert.equal(doctorExitCode(report.summary.verdict, true), 1);
  // No scopes were learned, so the matrix is NOT degraded — it is unverified,
  // and it adds no warning of its own (that would be a permission verdict
  // inferred from silence). Add a real warning from elsewhere to prove that
  // `unknown` outranks it: "nothing was established" must not hide behind
  // "degraded".
  const withWarning = summarizeDoctor({
    ...report,
    credentialFile: {
      ...report.credentialFile,
      unreadable: true,
      note: 'Could not read file protection: x',
    },
  });
  assert.ok(withWarning.findings.some((f) => f.severity === 'warn'));
  assert.equal(withWarning.verdict, 'unknown');
  assert.equal(withWarning.findings[0]?.severity, 'unknown', 'worst finding sorts first');
});

test('Graph declining to answer is never a verdict on the token', async () => {
  // An HTTP status on a `debug_token` failure was read as Facebook having ruled
  // on the credential, but only a 4xx rejection is a ruling. A 5xx is Meta's own
  // outage (or a proxy's 502), and a throttle is Graph refusing to look at all —
  // in both cases nothing was learned, and "TOKEN MALFORMED" sends the operator
  // off to rotate a healthy credential while the real fault sits elsewhere.
  async function diagnose(err: GraphApiError): Promise<DoctorReport> {
    const { fb, deps } = makeDeps();
    fb.on((req) => req.path === '/debug_token', fbErr(err));
    return runDoctor(deps);
  }

  const outage = await diagnose(
    new GraphApiError('An unexpected error has occurred. Please retry your request.', {
      code: 2,
      httpStatus: 500,
      type: 'OAuthException',
      action: {
        category: 'transient',
        retryable: true,
        operatorText: 'Safe to retry idempotent reads after a short backoff.',
      },
    }),
  );
  assert.equal(outage.token.diagnosis, 'token_check_failed');
  assert.equal(outage.summary.verdict, 'unknown');
  assert.doesNotMatch(
    renderDoctorReport(outage),
    /TOKEN MALFORMED/,
    'a Meta outage reported as a dead credential costs an operator a rotation',
  );

  // Meta's throttles arrive as HTTP 400 with a body code (CC-NET-1), so status
  // alone cannot tell "Graph judged this token" from "Graph would not look".
  const throttled = await diagnose(
    new GraphApiError('(#4) Application request limit reached', {
      code: 4,
      httpStatus: 400,
      type: 'OAuthException',
      action: {
        category: 'rate_limit',
        retryable: true,
        operatorText: 'Back off and re-run the doctor later.',
      },
    }),
  );
  assert.equal(throttled.token.diagnosis, 'token_check_failed');
  assert.equal(throttled.summary.verdict, 'unknown');

  // The control: a real OAuth rejection must still convict, or the check is
  // worthless in the other direction.
  const rejected = await diagnose(
    new GraphApiError('Error validating access token: session has expired', {
      code: 190,
      subcode: 463,
      httpStatus: 401,
      type: 'OAuthException',
      action: {
        category: 'auth',
        retryable: false,
        operatorText: 'Re-issue the credential and restart the server.',
      },
    }),
  );
  assert.equal(rejected.token.diagnosis, 'token_malformed');
  assert.equal(rejected.summary.verdict, 'fail');
});

test('a partially-scoped package is a warning, not a failure', async () => {
  const { fb, deps } = makeDeps();
  withDebugToken(fb, { type: 'USER', is_valid: true, scopes: ['pages_show_list'] });

  const report = await runDoctor(deps);
  assert.equal(report.summary.verdict, 'warn');
  assert.equal(doctorExitCode(report.summary.verdict, true), 1);
  assert.match(renderDoctorReport(report), /\[WARN {3}\] packages: core: PARTIAL/);
});

test('every package blocked is one failure, not a pile of warnings', async () => {
  const { fb, deps } = makeDeps({
    packages: [pkg('insights', ['facebook_page_insights'])],
  });
  // A stated, far-off expiry: this test counts findings by area, and a token
  // whose expiry Graph never stated is a (correct) second finding.
  withDebugToken(fb, {
    type: 'USER',
    is_valid: true,
    scopes: ['pages_show_list'],
    expires_at: 4_000_000_000,
  });

  const report = await runDoctor(deps);
  assert.equal(report.summary.verdict, 'fail');
  assert.deepEqual(
    report.summary.findings.map((f) => f.area),
    ['packages'],
  );
  assert.match(String(report.summary.findings[0]?.detail), /read_insights/);
});

test('an expiring token warns even when everything else is healthy', async () => {
  const { fb, deps } = makeDeps({ nowMs: 1_000_000 });
  withDebugToken(fb, {
    type: 'USER',
    is_valid: true,
    scopes: ['pages_show_list', 'pages_read_engagement'],
    expires_at: Math.floor((1_000_000 + 60_000) / 1000),
  });

  const report = await runDoctor(deps);
  assert.equal(report.summary.verdict, 'warn');
  assert.ok(report.summary.findings.some((f) => /expires within 7 days/.test(f.detail)));
});

test('the credential-file rules warn only where an operator can act', async () => {
  const base = await healthyReport();
  const file = base.credentialFile;

  const loose = summarizeDoctor({
    ...base,
    credentialFile: {
      ...file,
      exists: true,
      posixPermissions: true,
      ownerOnly: false,
      mode: 0o644,
      note: 'Mode 0644 grants group/other access.',
    },
  });
  assert.equal(loose.verdict, 'warn');
  assert.match(String(loose.findings[0]?.detail), /chmod 600/);

  // Windows carries no POSIX bits, so there is no chmod to recommend. A finding
  // nothing can clear would make --strict permanently red on that platform.
  const win32 = summarizeDoctor({
    ...base,
    credentialFile: {
      ...file,
      exists: true,
      posixPermissions: false,
      ownerOnly: false,
      mode: 0o666,
      note: 'Windows ACLs are not checked.',
    },
  });
  assert.equal(win32.verdict, 'ok');

  // An absent file is the normal env-only setup; a file that could not be READ
  // is a question left unanswered, and only that one is a finding.
  assert.equal(summarizeDoctor({ ...base, credentialFile: file }).verdict, 'ok');
  const unreadable = summarizeDoctor({
    ...base,
    credentialFile: {
      ...file,
      unreadable: true,
      note: 'Could not read file protection: x',
    },
  });
  assert.equal(unreadable.verdict, 'warn');
});

test('a metric name Graph refuses warns; a skipped or empty probe does not', async () => {
  const base = await healthyReport();

  const drifted = summarizeDoctor({
    ...base,
    metricSet: {
      outcome: 'probed',
      summary: 'probed 2 metric(s)',
      requests: 3,
      notes: [],
      verdicts: [
        { metric: 'page_impressions_unique', status: 'accepted', points: 7 },
        { metric: 'page_posts_impressions', status: 'rejected', error: 'unsupported' },
      ],
    },
  });
  assert.equal(drifted.verdict, 'warn');
  assert.match(String(drifted.findings[0]?.detail), /page_posts_impressions/);

  // Running without a Page is a configuration, not a defect; an EMPTY window is
  // data, not drift. Neither may hold back a --strict gate.
  const quiet = summarizeDoctor({
    ...base,
    metricSet: {
      outcome: 'probed',
      summary: 'probed 1 metric(s)',
      requests: 2,
      notes: ['The Page had no activity in this window.'],
      verdicts: [{ metric: 'page_impressions_unique', status: 'empty', points: 0 }],
    },
  });
  assert.equal(quiet.verdict, 'ok');
  assert.equal(base.metricSet.outcome, 'skipped');
  assert.equal(base.summary.verdict, 'ok');
});

test('a metric name Graph never mentions holds the verdict back, as the notes say', async () => {
  const base = await healthyReport();

  // The SILENT drift case, which is the one this probe exists for: Graph answers
  // 200 and simply omits the name. `metricSetNotes` already counts it under
  // "ACTION: n of m ... did not check out", so a verdict derived from `rejected`
  // alone contradicted the notes printed directly above it — and `--strict`
  // waved a metric set that no longer matches the live API straight through.
  const silent = summarizeDoctor({
    ...base,
    metricSet: {
      outcome: 'probed',
      summary: 'probed 2 metric(s)',
      requests: 1,
      notes: [
        'ACTION: 1 of 2 shipped metric name(s) did not check out against the live API.',
      ],
      verdicts: [
        { metric: 'page_media_view', status: 'accepted', points: 4 },
        {
          metric: 'page_follows',
          status: 'unknown',
          suggestion: 'Graph answered without a "page_follows" entry.',
        },
      ],
    },
  });

  assert.equal(silent.verdict, 'unknown');
  assert.equal(doctorExitCode(silent.verdict, true), 1);
  const finding = silent.findings.find((f) => f.area === 'insights');
  assert.ok(finding, 'expected an insights finding for the unverified name');
  assert.equal(finding.severity, 'unknown');
  assert.match(finding.detail, /page_follows/);
});

test('a metric-set probe that never reached the names is unverified, not degraded', async () => {
  const base = await healthyReport();

  // `outcome: 'failed'` means the call died before a single name was judged, and
  // the report's own note says it "says nothing about whether they are still
  // valid". Filing that under `warn` is exactly the "nothing was established
  // hides behind degraded" case the severity ladder was written to prevent.
  const failed = summarizeDoctor({
    ...base,
    metricSet: {
      outcome: 'failed',
      summary: 'metric set: probe failed ((#190/463) session has expired)',
      requests: 1,
      verdicts: [],
      notes: ['The call never reached the metric names.'],
    },
  });

  assert.equal(failed.verdict, 'unknown');
  const finding = failed.findings.find((f) => f.area === 'insights');
  assert.ok(finding, 'expected an insights finding for the probe that died');
  assert.equal(finding.severity, 'unknown');
});

test('a probe that blew up is not "nothing needs attention"', async () => {
  const { fb, deps } = makeDeps({
    adAccountProbe: () => Promise.reject(new Error('connect ETIMEDOUT act_1')),
  });
  withDebugToken(fb, {
    type: 'SYSTEM_USER',
    is_valid: true,
    scopes: ['pages_show_list', 'pages_read_engagement'],
  });

  // `available: false` is also what an UNWIRED probe reports, so the verdict had
  // no way to tell "never checked" from "the check threw" and counted both as
  // healthy — printing "ad account: failed (...)" above "OK — nothing needs
  // attention" in the same report.
  const report = await runDoctor(deps);
  assert.match(report.adAccount.summary, /failed/);
  assert.equal(report.summary.verdict, 'unknown');
  const finding = report.summary.findings.find((f) => f.area === 'ad account');
  assert.ok(finding, 'expected a finding for the probe that threw');
  assert.equal(finding.severity, 'unknown');
  assert.match(finding.detail, /ETIMEDOUT/);

  // An absent probe stays green: not wiring one is a configuration, not a fault.
  assert.equal((await healthyReport()).summary.verdict, 'ok');
});

test('a probe that answered "configured but unhealthy" is a warning, not "nothing needs attention" (wave 9)', async () => {
  const base = await healthyReport();

  // The exact situation the ad-account probe exists to surface (CC-ADS-6):
  // FB_AD_ACCOUNT_ID is set, Graph answered, and the account cannot serve.
  // Until now that was the same `available: false` an UNCONFIGURED account
  // reports, so it printed above "OK — nothing needs attention" and --strict
  // could not see it.
  const degraded = summarizeDoctor({
    ...base,
    adAccount: {
      available: false,
      degraded: true,
      summary: 'ad account act_1: Ad account is DISABLED: it cannot serve ads',
      details: { statusLabel: 'DISABLED' },
    },
  });
  const finding = degraded.findings.find((f) => f.area === 'ad account');
  assert.ok(finding, 'expected a finding for the configured-but-unhealthy ad account');
  assert.equal(finding.severity, 'warn');
  assert.match(finding.detail, /DISABLED/);
  assert.equal(degraded.verdict, 'warn');
  assert.equal(doctorExitCode(degraded.verdict, true), 1);

  // The same carrier on the metric probe: a Page that accepted the metrics and
  // returned nothing is a Page the operator has to do something about.
  const noData = summarizeDoctor({
    ...base,
    metricProbe: {
      available: false,
      degraded: true,
      summary: 'metric probe: Page 1010 accepted the metrics and returned no data',
    },
  });
  assert.equal(noData.findings.find((f) => f.area === 'metric probe')?.severity, 'warn');
  assert.equal(noData.verdict, 'warn');

  // A plain `available: false` — unconfigured, or no probe wired — stays
  // silent: an unconfigured ad account on a non-ads install must not redden
  // --strict.
  const unconfigured = summarizeDoctor({
    ...base,
    adAccount: {
      available: false,
      summary: 'ad account: not configured (set FB_AD_ACCOUNT_ID to check it)',
    },
  });
  assert.equal(
    unconfigured.findings.some((f) => f.area === 'ad account'),
    false,
  );
  assert.equal(unconfigured.verdict, 'ok');
  assert.equal(doctorExitCode(unconfigured.verdict, true), 0);

  // And `runDoctor` carries the flag from the probe's answer into the report,
  // so the rule above sees it on a real run and the finding renders.
  const { fb, deps } = makeDeps({
    adAccountProbe: () =>
      Promise.resolve({
        available: false,
        degraded: true,
        summary: 'ad account act_1: Ad account is UNSETTLED: it cannot serve ads',
      }),
  });
  withDebugToken(fb, {
    type: 'SYSTEM_USER',
    is_valid: true,
    scopes: ['pages_show_list', 'pages_read_engagement'],
    expires_at: 0,
  });
  const report = await runDoctor(deps);
  assert.equal(report.adAccount.degraded, true);
  assert.equal(report.summary.verdict, 'warn');
  assert.match(renderDoctorReport(report), /\[WARN {3}\] ad account: .*UNSETTLED/);
});

test('doctorExitCode maps every verdict, and 0 without --strict', () => {
  for (const verdict of ['ok', 'warn', 'unknown', 'fail'] as const) {
    assert.equal(
      doctorExitCode(verdict, false),
      0,
      `${verdict} must not gate by default`,
    );
  }
  assert.equal(doctorExitCode('ok', true), 0);
  assert.equal(doctorExitCode('warn', true), 1);
  assert.equal(doctorExitCode('unknown', true), 1);
  assert.equal(doctorExitCode('fail', true), 2);
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

// ---------------------------------------------------------------------------
// The renderer must not be able to lose the report over one number
// ---------------------------------------------------------------------------

test('an unrenderable expiry costs one line of the report, not the whole report', async () => {
  const { fb, deps } = makeDeps();
  withDebugToken(fb, { type: 'USER', is_valid: true, scopes: [], expires_at: 1200 });
  const report = await runDoctor(deps);

  // `new Date(ms)` is an Invalid Date for a NaN or out-of-range epoch, and
  // `toISOString()` on one throws `RangeError: Invalid time value`. That throw
  // happens INSIDE the renderer, so an unreadable number does not cost the
  // operator the expiry line — it costs them every other line as well, at the
  // exact moment they ran the doctor to find out what was wrong.
  for (const expiresAt of [Number.NaN, 1e300, Number.POSITIVE_INFINITY]) {
    const broken: DoctorReport = {
      ...report,
      token: { ...report.token, neverExpiring: false, expiresAt },
    };
    const text = renderDoctorReport(broken);
    // Everything the operator actually came for is still there.
    assert.match(text, /diagnosis:/);
    assert.match(text, /credential:/);
  }
});

// ---------------------------------------------------------------------------
// Page token <-> FB_PAGE_ID binding
// ---------------------------------------------------------------------------

/** A run where FB_PAGE_TOKEN is the only credential and Graph says it is Page 4040's. */
async function pageTokenReport(defaultPageId?: string): Promise<DoctorReport> {
  const { fb, deps } = makeDeps({
    settings: makeSettings({
      pageToken: 'PAGE-TOKEN-PLACEHOLDER',
      ...(defaultPageId !== undefined ? { defaultPageId } : {}),
    }),
    // A configured Page would send the metric-set probe to Graph; it is not
    // what these tests judge, and an empty set skips it without a finding.
    metricSet: [],
  });
  withDebugToken(fb, {
    type: 'PAGE',
    is_valid: true,
    scopes: ['pages_show_list', 'pages_read_engagement'],
    profile_id: '4040',
    // Stated on the wire, as a Page token issued through a System User is.
    expires_at: 0,
  });
  return runDoctor(deps);
}

test('a Page token without FB_PAGE_ID names the Page to bind it to', async () => {
  const report = await pageTokenReport();
  assert.equal(report.token.credentialSource, 'FB_PAGE_TOKEN');
  assert.equal(report.token.actingPageId, '4040');

  const text = renderDoctorReport(report);
  assert.match(
    text,
    /acting as:\s+page 4040\n\s+page binding:\s+this Page token belongs to Page 4040; set FB_PAGE_ID=4040 so Page-scoped tools can use it/,
  );
  // The structured answer: the token's Page, and no configured Page to hold it.
  assert.deepEqual(report.token.pageBinding, { status: 'unbound', tokenPageId: '4040' });
  // The settings layer warns about this at startup; the doctor's verdict agrees.
  assert.equal(report.summary.verdict, 'warn');
  assert.ok(
    report.summary.findings.some(
      (f) =>
        f.severity === 'warn' && f.area === 'token' && /FB_PAGE_ID=4040/.test(f.detail),
    ),
    `expected a warn finding naming FB_PAGE_ID=4040, got ${JSON.stringify(report.summary.findings)}`,
  );
});

test('a Page token whose FB_PAGE_ID names another Page is a warning, not a match', async () => {
  const report = await pageTokenReport('5050');
  const text = renderDoctorReport(report);
  assert.match(
    text,
    /page binding:\s+this Page token belongs to Page 4040, but FB_PAGE_ID names 5050 — Page-scoped tools will call Page 5050 with a token for Page 4040; set FB_PAGE_ID=4040/,
  );
  assert.deepEqual(report.token.pageBinding, {
    status: 'mismatch',
    tokenPageId: '4040',
    configuredPageId: '5050',
  });
  assert.equal(report.summary.verdict, 'warn');
  const finding = report.summary.findings.find(
    (f) =>
      f.severity === 'warn' &&
      f.area === 'token' &&
      /belongs to Page 4040/.test(f.detail),
  );
  assert.ok(
    finding,
    `expected a mismatch warning, got ${JSON.stringify(report.summary.findings)}`,
  );
  assert.match(finding.detail, /FB_PAGE_ID names 5050/);
  assert.match(finding.detail, /call Page 5050 with a token for Page 4040/);
  assert.match(finding.detail, /FB_PAGE_ID=4040/);
  assert.equal(doctorExitCode(report.summary.verdict, true), 1);
});

test('a Page token bound to its own FB_PAGE_ID adds nothing', async () => {
  const report = await pageTokenReport('4040');
  assert.deepEqual(report.token.pageBinding, { status: 'bound', tokenPageId: '4040' });
  assert.equal(report.summary.verdict, 'ok');
  assert.deepEqual([...report.summary.findings], []);
  const text = renderDoctorReport(report);
  assert.doesNotMatch(text, /page binding:/);
  assert.doesNotMatch(text, /FB_PAGE_ID=/);
});

test('the binding is only judged for the credential that IS a Page token', async () => {
  // A system token also carries FB_PAGE_TOKEN in the environment, but the
  // shadowed credential is not the one acting — its Page is nobody's business.
  const { fb, deps } = makeDeps({
    settings: makeSettings({
      systemToken: 'SYSTEM-TOKEN-PLACEHOLDER',
      pageToken: 'PAGE-TOKEN-PLACEHOLDER',
    }),
  });
  withDebugToken(fb, { type: 'SYSTEM_USER', is_valid: true, scopes: [], user_id: '999' });
  const report = await runDoctor(deps);
  assert.equal(report.token.pageBinding, undefined);
  assert.doesNotMatch(renderDoctorReport(report), /page binding:/);
});

test('a Page token Graph did not attribute to a Page has no binding to judge', async () => {
  // No `profile_id` on the wire: the doctor must not claim a Page it never saw.
  const { fb, deps } = makeDeps({
    settings: makeSettings({ pageToken: 'PAGE-TOKEN-PLACEHOLDER' }),
  });
  withDebugToken(fb, { type: 'PAGE', is_valid: true, scopes: [] });
  const report = await runDoctor(deps);
  assert.equal(report.token.pageBinding, undefined);
  const text = renderDoctorReport(report);
  assert.doesNotMatch(text, /page binding:/);
  assert.doesNotMatch(text, /FB_PAGE_ID=/);
});

// ---------------------------------------------------------------------------
// Wire-truth hunt: what the report says must be what the wire said
// ---------------------------------------------------------------------------

test('a Page token acts as the Page Graph attributed it to, not as its issuing user', async () => {
  const { fb, deps } = makeDeps({
    settings: makeSettings({
      pageToken: 'PAGE-TOKEN-PLACEHOLDER',
      defaultPageId: '4040',
    }),
    metricSet: [],
  });
  // The real wire shape for a Page token: `debug_token` names BOTH the Page the
  // token acts as (`profile_id`) and the user it was issued through (`user_id`).
  withDebugToken(fb, {
    type: 'PAGE',
    is_valid: true,
    scopes: ['pages_show_list', 'pages_read_engagement'],
    profile_id: '4040',
    user_id: '999',
  });

  const report = await runDoctor(deps);
  assert.equal(report.token.actingPageId, '4040');
  assert.equal(report.token.actingUserId, '999');
  const text = renderDoctorReport(report);
  assert.match(
    text,
    /acting as:\s+page 4040 \(issued to user 999\)/,
    'a Page token that calls Graph as the Page must not be reported as acting as a user',
  );

  // Control: a user-shaped token still reports the user, so the fix is not a
  // blanket preference for Pages.
  const control = makeDeps();
  withDebugToken(control.fb, {
    type: 'SYSTEM_USER',
    is_valid: true,
    scopes: [],
    user_id: '999',
  });
  assert.match(
    renderDoctorReport(await runDoctor(control.deps)),
    /acting as:\s+user 999\n/,
  );
});

test('TOKEN NOT CHECKED shows the proxy hint it sends the operator to, where it says it is', async () => {
  const { fb, deps } = makeDeps();
  // The shape `core/http` really throws when the connection never opened: the
  // CC-NET-6 proxy self-diagnosis rides in `action.operatorText`, not in the
  // message — a doctor that keeps only the message loses the one line the
  // diagnosis explicitly tells the operator to read.
  fb.on(
    (req) => req.path === '/debug_token',
    fbErr(
      new GraphApiError(
        'network request failed: getaddrinfo ENOTFOUND graph.facebook.com',
        {
          code: 0,
          httpStatus: 0,
          action: classifyNetworkError({
            phase: 'connect',
            isWrite: false,
            reason: 'getaddrinfo ENOTFOUND graph.facebook.com',
          }),
        },
      ),
    ),
  );

  const report = await runDoctor(deps);
  assert.equal(report.token.diagnosis, 'token_check_failed');
  assert.match(
    String(report.token.error),
    /HTTPS_PROXY/,
    'the proxy hint has to survive into the structured error, not only the message',
  );

  const text = renderDoctorReport(report);
  assert.match(text, /TOKEN NOT CHECKED/);
  assert.ok(
    text.includes(PROXY_ENV_HINT),
    'the diagnosis promises a proxy hint; it must be on the page',
  );
  // The diagnosis points at the error line: it has to point where the line is.
  const lines = text.split('\n');
  const diagnosisAt = lines.findIndex((l) => l.includes('diagnosis:'));
  const errorAt = lines.findIndex((l) => l.includes('  error:'));
  assert.ok(diagnosisAt >= 0 && errorAt >= 0);
  assert.ok(errorAt > diagnosisAt, 'the error line is rendered after the diagnosis');
  assert.match(String(lines[diagnosisAt]), /error line below/);
  assert.doesNotMatch(String(lines[diagnosisAt]), /error line above/);
});

test('an unreachable debug_token leaves the package matrix unverified, not blocked', async () => {
  const { fb, deps } = makeDeps({
    packages: [
      pkg('core', CORE_TOOLS),
      pkg('reader', ['facebook_list_posts', 'facebook_get_post']),
    ],
  });
  fb.on(
    (req) => req.path === '/debug_token',
    fbErr(
      new GraphApiError(
        'network request failed: getaddrinfo ENOTFOUND graph.facebook.com',
        {
          code: 0,
          httpStatus: 0,
          action: classifyNetworkError({ phase: 'connect', isWrite: false }),
        },
      ),
    ),
  );

  const report = await runDoctor(deps);
  assert.equal(report.token.diagnosis, 'token_check_failed');
  // No scope was ever observed, so no row may say one is missing: "BLOCKED —
  // missing: pages_read_engagement" under a DNS fault sends the operator to
  // Business settings to grant a permission the token most likely has.
  for (const matrixRow of report.matrix) {
    assert.equal(
      matrixRow.status,
      'unverified',
      `${matrixRow.package} was judged from an empty default, not from the wire`,
    );
    assert.deepEqual(matrixRow.missingPermissions, []);
    assert.deepEqual(matrixRow.blockedTools, []);
  }
  const text = renderDoctorReport(report);
  assert.doesNotMatch(text, /missing: /);
  assert.doesNotMatch(text, /\[BLOCKED\]|\[PARTIAL\]/);
  assert.match(
    text,
    /\[NOT CHECKED\] reader\s+required: pages_read_engagement, pages_read_user_content — not checked \(the token's scopes were never learned; see Token above\)/,
  );
  // The token finding already says nothing was established; the packages must
  // not add a second, invented layer of "missing" warnings under it.
  assert.equal(
    report.summary.findings.some((finding) => finding.area === 'packages'),
    false,
  );
  assert.equal(report.summary.verdict, 'unknown');

  // Control: with an answer on the wire the matrix is still judged for real.
  const answered = makeDeps({ packages: [pkg('reader', ['facebook_list_posts'])] });
  withDebugToken(answered.fb, {
    type: 'USER',
    is_valid: true,
    scopes: ['pages_show_list'],
  });
  const judged = await runDoctor(answered.deps);
  assert.equal(row(judged.matrix, 'reader').status, 'blocked');
});

// ---------------------------------------------------------------------------
// Non-Error rejections (a library that rejects with a plain object)
// ---------------------------------------------------------------------------

/** Types a deliberately non-Error throwable so it can be thrown or rejected. */
function notAnError(value: object): Error {
  return value as Error;
}

test('a non-Error debug_token rejection keeps its text; a null-prototype one is still a report', async () => {
  const plain = makeDeps();
  plain.fb.on(
    (req) => req.path === '/debug_token',
    fbErr(notAnError({ message: 'library said no' })),
  );
  const report = await runDoctor(plain.deps);
  assert.equal(report.token.valid, false);
  assert.equal(report.token.error, 'library said no');

  const bare = makeDeps();
  bare.fb.on(
    (req) => req.path === '/debug_token',
    fbErr(notAnError(Object.create(null) as object)),
  );
  const bareReport = await runDoctor(bare.deps);
  assert.equal(bareReport.token.valid, false);
  assert.equal(bareReport.token.error, 'unknown error (no message)');
});

test('a non-Error rejection from a metric or ad-account probe keeps its text', async () => {
  const { fb, deps } = makeDeps({
    metricProbe: () => Promise.reject(notAnError({ message: 'probe said no' })),
    adAccountProbe: () => Promise.reject(notAnError(Object.create(null) as object)),
  });
  withDebugToken(fb, { type: 'USER', is_valid: true, scopes: [] });

  const report = await runDoctor(deps);
  assert.equal(report.metricProbe.available, false);
  assert.match(report.metricProbe.summary, /failed \(probe said no\)$/);
  assert.equal(report.adAccount.available, false);
  assert.match(
    report.adAccount.summary,
    /ad account: failed \(unknown error \(no message\)\)$/,
  );
});

test('metric-set probe: a non-Error { message } failure keeps its text, a null-prototype one is reported', async () => {
  const plain = makeMetricSetDeps();
  onBatch(plain.fb, fbErr(notAnError({ message: 'socket reset' })));
  const set = (await runDoctor(plain.deps)).metricSet;
  assert.equal(set.outcome, 'failed');
  assert.match(set.summary, /socket reset/);
  assert.doesNotMatch(set.summary, /object Object/);

  const bare = makeMetricSetDeps();
  onBatch(bare.fb, fbErr(notAnError(Object.create(null) as object)));
  const bareSet = (await runDoctor(bare.deps)).metricSet;
  assert.equal(bareSet.outcome, 'failed');
  assert.match(bareSet.summary, /unknown error \(no message\)/);
});

// ---------------------------------------------------------------------------
// Wave 14: every shipped tool is mapped, and data-access expiry is judged
// ---------------------------------------------------------------------------

/**
 * The concrete tool surface, loaded through a computed specifier for the same
 * reason `annotations.test.ts` does: `src/mcp` may not statically import the
 * tools layer, but this guard needs the real tool names.
 */
const TOOLS_BARREL = new URL('../tools/index.js', import.meta.url).href;

async function loadShippedPackages(): Promise<readonly PackageSpec[]> {
  const barrel = (await import(TOOLS_BARREL)) as Record<string, unknown>;
  const specs: PackageSpec[] = [];
  for (const [name, value] of Object.entries(barrel)) {
    if (!/^create[A-Za-z0-9]*Package$/.test(name) || typeof value !== 'function')
      continue;
    const factory = value as (opts: {
      serverVersion: string;
      sdkVersion?: string;
    }) => PackageSpec;
    specs.push(factory({ serverVersion: '0.0.0-test', sdkVersion: '0.0.0-test' }));
  }
  assert.ok(specs.length > 0, 'no package factories found in src/tools/index.ts');
  return specs;
}

test('TOOL_PERMISSIONS maps every shipped tool, so none inherits its whole package set (wave 14)', async () => {
  const unmapped = (await loadShippedPackages())
    .flatMap((spec) => spec.tools.map((tool) => tool.name))
    .filter((name) => !Object.hasOwn(TOOL_PERMISSIONS, name))
    .sort();
  assert.deepEqual(unmapped, []);
});

test('block/unblock need only pages_manage_engagement and are not reported blocked without pages_read_user_content (wave 14)', async () => {
  const { fb, deps } = makeDeps({
    packages: [
      pkg('moderation', [
        'facebook_hide_comment',
        'facebook_block_user',
        'facebook_unblock_user',
        'facebook_list_comments',
      ]),
    ],
  });
  withDebugToken(fb, {
    type: 'PAGE',
    is_valid: true,
    scopes: ['pages_manage_engagement'],
  });

  const moderation = row((await runDoctor(deps)).matrix, 'moderation');
  assert.equal(moderation.status, 'partial');
  // Only the read that genuinely needs pages_read_user_content is blocked.
  assert.deepEqual([...moderation.blockedTools], ['facebook_list_comments']);
});

test('facebook_get_video_status is a read and is not blocked by a missing pages_manage_posts (wave 14)', async () => {
  const { fb, deps } = makeDeps({
    packages: [
      pkg('posts', [
        'facebook_create_post',
        'facebook_list_scheduled_posts',
        'facebook_get_video_status',
      ]),
    ],
  });
  withDebugToken(fb, {
    type: 'PAGE',
    is_valid: true,
    scopes: ['pages_read_engagement'],
  });

  const posts = row((await runDoctor(deps)).matrix, 'posts');
  assert.equal(posts.status, 'partial');
  assert.deepEqual([...posts.blockedTools], ['facebook_create_post']);
});

test('a never-expiring token whose DATA ACCESS lapses within the window warns (wave 14)', async () => {
  const now = 1_000_000_000_000;
  const { fb, deps } = makeDeps({ nowMs: now });
  withDebugToken(fb, {
    type: 'PAGE',
    is_valid: true,
    scopes: ['pages_show_list', 'pages_read_engagement'],
    expires_at: 0, // the token itself never expires...
    data_access_expires_at: now / 1000 + 2 * 86_400, // ...but data access ends in 2 days
  });

  const report = await runDoctor(deps);
  assert.equal(report.token.neverExpiring, true);
  assert.equal(report.summary.verdict, 'warn');
  assert.equal(report.token.dataAccessExpiringSoon, true);
  assert.ok(
    report.summary.findings.some(
      (f) => f.severity === 'warn' && /data access/i.test(f.detail),
    ),
    'expected a data-access expiry finding',
  );
  assert.match(renderDoctorReport(report), /data access: {2}\S+ \(EXPIRING SOON/);
});

test('a data access that has already lapsed warns; one far away does not (wave 14)', async () => {
  const now = 1_000_000_000_000;
  const lapsed = makeDeps({ nowMs: now });
  withDebugToken(lapsed.fb, {
    type: 'USER',
    is_valid: true,
    scopes: ['pages_show_list', 'pages_read_engagement'],
    expires_at: now / 1000 + 50 * 86_400,
    data_access_expires_at: now / 1000 - 86_400,
  });
  const lapsedReport = await runDoctor(lapsed.deps);
  assert.equal(lapsedReport.summary.verdict, 'warn');
  assert.equal(lapsedReport.token.dataAccessExpiringSoon, true);

  const far = makeDeps({ nowMs: now });
  withDebugToken(far.fb, {
    type: 'USER',
    is_valid: true,
    scopes: ['pages_show_list', 'pages_read_engagement'],
    expires_at: now / 1000 + 50 * 86_400,
    data_access_expires_at: now / 1000 + 60 * 86_400,
  });
  const farReport = await runDoctor(far.deps);
  assert.equal(farReport.token.dataAccessExpiringSoon, false);
  assert.equal(farReport.summary.verdict, 'ok');
});

// ---------------------------------------------------------------------------
// Wave 15: permission tables agree with the tools, and an unchecked token is
// not rendered as a checked one
// ---------------------------------------------------------------------------

test('facebook_list_comments is blocked without pages_read_engagement, as its description says (wave 15)', async () => {
  const { fb, deps } = makeDeps({
    packages: [pkg('moderation', ['facebook_list_comments', 'facebook_hide_comment'])],
  });
  withDebugToken(fb, {
    type: 'PAGE',
    is_valid: true,
    scopes: ['pages_read_user_content', 'pages_manage_engagement'],
  });

  const moderation = row((await runDoctor(deps)).matrix, 'moderation');
  assert.equal(moderation.status, 'partial');
  assert.deepEqual([...moderation.blockedTools], ['facebook_list_comments']);
  assert.ok(moderation.missingPermissions.includes('pages_read_engagement'));
});

test('a moderation row blocked only by pages_messaging names that permission as missing (wave 15)', async () => {
  const { fb, deps } = makeDeps({
    packages: [
      pkg('moderation', [
        'facebook_list_comments',
        'facebook_hide_comment',
        'facebook_private_reply',
      ]),
    ],
  });
  withDebugToken(fb, {
    type: 'PAGE',
    is_valid: true,
    scopes: [
      'pages_read_engagement',
      'pages_read_user_content',
      'pages_manage_engagement',
    ],
  });

  const report = await runDoctor(deps);
  const moderation = row(report.matrix, 'moderation');
  assert.equal(moderation.status, 'partial');
  assert.deepEqual([...moderation.blockedTools], ['facebook_private_reply']);
  // The row used to read "missing: (none); blocked tools: facebook_private_reply",
  // leaving the operator no permission to go and grant.
  assert.deepEqual([...moderation.missingPermissions], ['pages_messaging']);
  assert.match(
    renderDoctorReport(report),
    /\[PARTIAL\] moderation\s+missing: pages_messaging; blocked tools: facebook_private_reply/,
  );
});

test("PACKAGE_PERMISSIONS is the union of its shipped tools' TOOL_PERMISSIONS (wave 15)", async () => {
  const gaps: string[] = [];
  for (const spec of await loadShippedPackages()) {
    const required = new Set(
      PACKAGE_PERMISSIONS[spec.name as keyof typeof PACKAGE_PERMISSIONS] ?? [],
    );
    for (const tool of spec.tools) {
      for (const perm of TOOL_PERMISSIONS[tool.name] ?? []) {
        if (!required.has(perm)) gaps.push(`${spec.name}: ${tool.name} needs ${perm}`);
      }
    }
  }
  assert.deepEqual(gaps.sort(), []);
});

test('TOOL_PERMISSIONS carries no stale entry for a tool that is not shipped (wave 15)', async () => {
  const shipped = new Set(
    (await loadShippedPackages()).flatMap((spec) => spec.tools.map((tool) => tool.name)),
  );
  const stale = Object.keys(TOOL_PERMISSIONS)
    .filter((name) => !shipped.has(name))
    .sort();
  assert.deepEqual(stale, []);
});

test('an expiring token that is also missing a permission reports both findings (wave 15)', async () => {
  const now = 1_000_000_000_000;
  const { fb, deps } = makeDeps({
    nowMs: now,
    packages: [pkg('core', CORE_TOOLS), pkg('posts', ['facebook_create_post'])],
  });
  withDebugToken(fb, {
    type: 'USER',
    is_valid: true,
    scopes: ['pages_show_list', 'pages_read_engagement'],
    expires_at: now / 1000 + 86_400,
  });

  const report = await runDoctor(deps);
  assert.equal(report.summary.verdict, 'warn');
  const details = report.summary.findings.map((f) => `${f.area}: ${f.detail}`);
  assert.ok(details.some((d) => /^token: The token expires within 7 days/.test(d)));
  assert.ok(details.some((d) => /^packages: posts: .*pages_manage_posts/.test(d)));
});

test('an unchecked token is rendered as unknown, not as invalid with no scopes (wave 15)', async () => {
  const { fb, deps } = makeDeps();
  fb.on(
    (req) => req.path === '/debug_token',
    fbErr(
      new GraphApiError(
        'network request failed: getaddrinfo ENOTFOUND graph.facebook.com',
        {
          code: 0,
          httpStatus: 0,
          action: classifyNetworkError({ phase: 'connect', isWrite: false }),
        },
      ),
    ),
  );

  const report = await runDoctor(deps);
  assert.equal(report.token.diagnosis, 'token_check_failed');
  const text = renderDoctorReport(report);
  // debug_token never answered: "valid: no" / "scopes: (none)" / "not reported
  // by Graph" each state something Graph was never asked.
  assert.doesNotMatch(text, /^ {2}valid: +no$/m);
  assert.doesNotMatch(text, /^ {2}scopes: +\(none\)$/m);
  assert.doesNotMatch(text, /asset access: +not reported by Graph/);
  assert.match(text, /^ {2}valid: +unknown \(not checked\)$/m);
  assert.match(text, /^ {2}scopes: +unknown \(not checked\)$/m);
  assert.match(text, /^ {2}granular: +unknown \(not checked\)$/m);
  assert.match(text, /^ {2}asset access: +unknown \(not checked\)$/m);
});

// ---------------------------------------------------------------------------
// Wave 17: the moderation rows match the tools' own stated requirements
// ---------------------------------------------------------------------------

test('facebook_private_reply is usable with the documented set and no pages_manage_engagement (wave 17)', async () => {
  const { fb, deps } = makeDeps({
    packages: [pkg('moderation', ['facebook_get_comment', 'facebook_private_reply'])],
  });
  // Exactly what the tool description names: pages_messaging to send, and
  // pages_read_engagement + pages_read_user_content for the pre-flight read.
  withDebugToken(fb, {
    type: 'PAGE',
    is_valid: true,
    scopes: ['pages_messaging', 'pages_read_engagement', 'pages_read_user_content'],
  });

  const moderation = row((await runDoctor(deps)).matrix, 'moderation');
  assert.deepEqual([...moderation.blockedTools], []);
  assert.equal(moderation.status, 'usable');
});

test('facebook_private_reply is blocked without pages_read_engagement for its pre-flight comment read (wave 17)', async () => {
  const { fb, deps } = makeDeps({
    packages: [pkg('moderation', ['facebook_hide_comment', 'facebook_private_reply'])],
  });
  withDebugToken(fb, {
    type: 'PAGE',
    is_valid: true,
    scopes: ['pages_messaging', 'pages_manage_engagement', 'pages_read_user_content'],
  });

  const moderation = row((await runDoctor(deps)).matrix, 'moderation');
  assert.equal(moderation.status, 'partial');
  assert.deepEqual([...moderation.blockedTools], ['facebook_private_reply']);
});

test('facebook_get_comment is blocked without pages_read_engagement, as its description says (wave 17)', async () => {
  const { fb, deps } = makeDeps({
    packages: [pkg('moderation', ['facebook_get_comment', 'facebook_hide_comment'])],
  });
  withDebugToken(fb, {
    type: 'PAGE',
    is_valid: true,
    scopes: ['pages_read_user_content', 'pages_manage_engagement'],
  });

  const moderation = row((await runDoctor(deps)).matrix, 'moderation');
  assert.equal(moderation.status, 'partial');
  assert.deepEqual([...moderation.blockedTools], ['facebook_get_comment']);
  assert.ok(moderation.missingPermissions.includes('pages_read_engagement'));
});

// ---------------------------------------------------------------------------
// Wave 21 (lane E)
// ---------------------------------------------------------------------------

test('a metric Graph leaves out is not declared a dead name — Graph also omits a metric/period pair it does not serve (wave 21)', async () => {
  const { fb, deps } = makeMetricSetDeps();
  onBatch(
    fb,
    fbOk({
      data: [insightRow('page_media_view', [1]), insightRow('page_follows', [])],
    }),
  );

  const set = (await runDoctor(deps)).metricSet;
  assert.deepEqual(
    set.verdicts.map((v) => v.status),
    ['accepted', 'empty', 'unknown'],
  );
  const silent = String(set.verdicts[2]?.suggestion);
  // The api layer documents that Graph drops an unsupported metric/period pair
  // from the answer instead of failing the call; the probe asks period=day only,
  // so an absent entry does not prove the NAME is dead.
  assert.match(silent, /period="day"/, 'the period the probe asked for is named');
  assert.doesNotMatch(
    silent,
    /so the name is not valid/,
    'an absent entry is not proof the name is invalid',
  );
  assert.doesNotMatch(
    set.notes.join('\n'),
    /does not support daily buckets also answers empty/,
    'a metric without daily buckets is omitted (unknown), not answered empty',
  );
});

test('a halted isolation pass does not tell the operator to fix names it never asked about (wave 21)', async () => {
  const { fb, deps } = makeMetricSetDeps();
  onBatch(fb, fbErr(metricRejection('page_media_view')));
  onSingle(fb, 'page_media_view', fbErr(metricRejection('page_media_view')));
  onSingle(
    fb,
    'page_follows',
    fbErr(
      new GraphApiError('User request limit reached', {
        code: 17,
        httpStatus: 429,
        action: {
          category: 'rate_limit',
          retryable: true,
          operatorText: 'Back off and re-run the doctor later.',
        },
      }),
    ),
  );

  const set = (await runDoctor(deps)).metricSet;
  assert.deepEqual(
    set.verdicts.map((v) => v.status),
    ['rejected', 'unknown', 'unknown'],
  );
  const notes = set.notes.join('\n');
  assert.doesNotMatch(
    notes,
    /ACTION: 3 of 3/,
    'two names were never judged; counting them as drift sends the operator to edit a correct list',
  );
  assert.match(notes, /ACTION: 1 of 3/);
  assert.match(notes, /2 of 3 shipped metric name\(s\) were not probed/);
});

test('a debug_token call rejected under the app credential does not convict the token alone (wave 21)', async () => {
  const { fb, deps } = makeDeps({
    settings: makeSettings({
      accessToken: 'EAA-runtime',
      appId: '123',
      appSecret: 'APP-SECRET-PLACEHOLDER',
    }),
  });
  fb.on(
    (req) => req.path === '/debug_token',
    fbErr(
      new GraphApiError('Invalid OAuth access token signature.', {
        code: 190,
        httpStatus: 400,
        type: 'OAuthException',
      }),
    ),
  );

  const report = await runDoctor(deps);
  // The call was authenticated with FB_APP_ID|FB_APP_SECRET, not with the token
  // under test — Graph's refusal may be about either credential.
  assert.equal(fb.lastRequest()?.token, '123|APP-SECRET-PLACEHOLDER');
  assert.equal(report.token.diagnosis, 'token_malformed');
  assert.equal(report.summary.verdict, 'fail');
  const finding = report.summary.findings.find((f) => f.area === 'token');
  assert.ok(finding);
  assert.match(
    finding.detail,
    /FB_APP_SECRET/,
    'the app credential is named as a suspect',
  );
  assert.doesNotMatch(
    finding.detail,
    /did not accept this token — re-issue it/,
    'a wrong app secret must not send the operator off to rotate a healthy token',
  );
  assert.match(renderDoctorReport(report), /FB_APP_ID\|FB_APP_SECRET/);
});

test('a rejected debug_token call leaves the package matrix unverified, not blocked (wave 21)', async () => {
  const { fb, deps } = makeDeps({
    packages: [
      pkg('core', CORE_TOOLS),
      pkg('reader', ['facebook_list_posts', 'facebook_get_post']),
    ],
  });
  fb.on(
    (req) => req.path === '/debug_token',
    fbErr(
      new GraphApiError('Error validating access token: malformed access token', {
        code: 190,
        httpStatus: 400,
        type: 'OAuthException',
      }),
    ),
  );

  const report = await runDoctor(deps);
  assert.equal(report.token.diagnosis, 'token_malformed');
  // Graph refused the CALL, so no scope list ever came back: "missing:
  // pages_show_list" would be a permission verdict nobody observed.
  for (const matrixRow of report.matrix) {
    assert.equal(matrixRow.status, 'unverified', matrixRow.package);
    assert.deepEqual(matrixRow.missingPermissions, []);
  }
  assert.equal(
    report.summary.findings.some((f) => f.area === 'packages'),
    false,
    'the token finding carries the failure; no invented "missing" list under it',
  );
  assert.equal(report.summary.verdict, 'fail', 'still a failure — from the token');
  const text = renderDoctorReport(report);
  assert.doesNotMatch(text, /missing: /);
  assert.match(text, /scopes:\s+unknown \(not checked\)/);
});

test('a 200 that rules the token invalid leaves the package matrix unverified, not blocked (wave 24)', async () => {
  const { fb, deps } = makeDeps({
    packages: [
      pkg('core', CORE_TOOLS),
      pkg('reader', ['facebook_list_posts', 'facebook_get_post']),
    ],
  });
  // The common shape of a dead token: Graph answers the CALL with 200 and rules
  // on the SUBJECT inside it, with no scope list. The wave-21 fix covered only
  // the thrown 4xx, so this path still judged every package against the empty
  // default and printed "BLOCKED — missing: pages_show_list, ..." for grants
  // nobody observed; the operator went off to re-grant permissions when the one
  // thing wrong was the token.
  fb.on(
    (req) => req.path === '/debug_token',
    fbOk({
      data: {
        is_valid: false,
        error: {
          code: 190,
          subcode: 463,
          message: 'Error validating access token: Session has expired.',
        },
      },
    }),
  );

  const report = await runDoctor(deps);
  assert.equal(report.token.diagnosis, 'token_malformed');
  for (const matrixRow of report.matrix) {
    assert.equal(matrixRow.status, 'unverified', matrixRow.package);
    assert.deepEqual(matrixRow.missingPermissions, []);
    assert.deepEqual(matrixRow.blockedTools, []);
  }
  assert.equal(
    report.summary.findings.some((f) => f.area === 'packages'),
    false,
    'the token finding carries the failure; no invented "missing" list under it',
  );
  assert.equal(report.summary.verdict, 'fail', 'still a failure — from the token');
  assert.doesNotMatch(renderDoctorReport(report), /missing: /);
});

test('no configured token leaves the package matrix unverified, not blocked (wave 26)', async () => {
  const { deps } = makeDeps({
    settings: makeSettings(),
    packages: [
      pkg('core', CORE_TOOLS),
      pkg('reader', ['facebook_list_posts', 'facebook_get_post']),
    ],
  });
  // With no credential at all, debug_token is never asked, so no scope was
  // observed. Judging every package against the empty default printed
  // "No loaded package can run under the granted scopes (missing:
  // pages_show_list, ...)" — a permission verdict about a token that does not
  // exist, sending the operator to re-grant permissions instead of setting one.
  const report = await runDoctor(deps);
  assert.equal(report.token.diagnosis, 'no_token');
  for (const matrixRow of report.matrix) {
    assert.equal(matrixRow.status, 'unverified', matrixRow.package);
    assert.deepEqual(matrixRow.missingPermissions, []);
    assert.deepEqual(matrixRow.blockedTools, []);
  }
  assert.equal(
    report.summary.findings.some((f) => f.area === 'packages'),
    false,
    'the token finding carries the failure; no invented "missing" list under it',
  );
  assert.equal(report.summary.verdict, 'fail', 'still a failure — from the token');
  assert.doesNotMatch(renderDoctorReport(report), /missing: /);
});

test('metric-set probe reads the Page insights edge with the Page token, not the user credential (wave 26)', async () => {
  // Page insights want a Page access token. Sent bare, the request went out
  // under FB_SYSTEM_TOKEN / FB_ACCESS_TOKEN (the transport's fallback), so a
  // healthy install drew a refusal ("probe failed" -> an `unknown` finding) or
  // Graph's silent empty answer (CC-AUTH-2) -> every metric judged `unknown`
  // or `empty`, while the insights tools themselves derive and use the Page
  // token and work fine.
  const { fb, deps } = makeMetricSetDeps({
    settings: makeSettings({
      systemToken: 'SYSTEM-TOKEN-PLACEHOLDER',
      defaultPageId: '1010',
    }),
  });
  onBatch(fb, fbOk({ data: [insightRow('page_media_view', [1])] }));

  const set = (await runDoctor(deps)).metricSet;
  const [call] = insightsCalls(fb);
  assert.ok(call);
  assert.equal(call.token, derivedPageToken('1010'));
  assert.equal(set.outcome, 'probed');
  assert.equal(set.requests, 1, 'requests counts the insights calls');
});

test("metric-set probe uses a profile's own Page token and derives nothing for it (wave 26)", async () => {
  const { fb, deps } = makeMetricSetDeps({
    settings: makeSettings({
      accessToken: 'ACCESS-TOKEN-PLACEHOLDER',
      profiles: {
        agency: { pageId: '3030', tokenOverride: 'AGENCY-PAGE-TOKEN-PLACEHOLDER' },
      },
    }),
  });
  fb.on((req) => req.path === '/3030/insights', fbOk({ data: [] }));

  await runDoctor(deps);
  const [call] = insightsCalls(fb);
  assert.ok(call);
  assert.equal(call.token, 'AGENCY-PAGE-TOKEN-PLACEHOLDER');
  assert.equal(
    fb.calls.some((req) => req.protocol === 'json' && req.path === '/3030'),
    false,
    'an override is used verbatim, never derived',
  );
});

test('metric-set probe: a failed Page-token derivation is reported as such, and no insights call is made (wave 26)', async () => {
  const { fb, deps } = makeMetricSetDeps({
    settings: makeSettings({
      accessToken: 'ACCESS-TOKEN-PLACEHOLDER',
      defaultPageId: '4040',
    }),
  });
  fb.on(
    (req) => req.protocol === 'json' && req.path === '/4040',
    fbErr(new Error('socket hang up')),
  );

  const set = (await runDoctor(deps)).metricSet;
  assert.equal(set.outcome, 'failed');
  assert.match(set.summary, /Page token for Page 4040/);
  assert.match(set.summary, /socket hang up/);
  assert.equal(insightsCalls(fb).length, 0);
  assert.equal(set.requests, 0, 'no insights call was spent');
});

test('metric-set probe: an FB_PAGE_TOKEN install reads with that token and derives nothing (wave 26)', async () => {
  const { fb, deps } = makeMetricSetDeps({
    settings: makeSettings({
      pageToken: 'PAGE-TOKEN-PLACEHOLDER',
      defaultPageId: '1010',
    }),
  });
  onBatch(fb, fbOk({ data: [insightRow('page_media_view', [1])] }));

  await runDoctor(deps);
  const [call] = insightsCalls(fb);
  assert.ok(call);
  assert.equal(call.token, 'PAGE-TOKEN-PLACEHOLDER');
  assert.equal(
    fb.calls.some((req) => req.protocol === 'json' && req.path === '/1010'),
    false,
    'with no base token there is nothing to derive from',
  );
});
