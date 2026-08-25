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
import { GraphApiError } from '../core/index.js';
import type {
  JsonRequest,
  Logger,
  PackageSpec,
  Settings,
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
  activeCredential,
  classifyAssetAccess,
  renderDoctorReport,
  runDoctor,
  type AdAccountProbe,
  type DoctorDeps,
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

test('an unreadable credential path is reported instead of crashing the doctor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'facebook-mcp-doctor-enotdir-'));
  const notADir = join(dir, 'env');
  await writeFile(notADir, 'FB_ACCESS_TOKEN=USER-TOKEN-PLACEHOLDER\n');

  // Statting THROUGH a regular file yields ENOTDIR, not ENOENT.
  const { fb, deps } = makeDeps({ credentialFilePath: join(notADir, 'nested') });
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
  return parts;
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
    undefined,
    'the client resolves the credential — the doctor never handles the secret',
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
