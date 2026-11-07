// Tests for the doctor (`mcp/doctor.ts`): the token report, permission matrix, probe
// seams, scopes, credential file and rendering.
//
// Split out of `doctor.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/doctor.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fbErr, fbOk } from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import {
  activeCredential,
  classifyAssetAccess,
  renderDoctorReport,
  runDoctor,
  type AdAccountProbe,
  type MetricProbe,
} from './doctor.js';
import {
  CORE_TOOLS,
  NO_CREDENTIAL_FILE,
  makeDeps,
  makeSettings,
  pkg,
  row,
  withDebugToken,
} from '../testing/harness/doctor.js';

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
  assert.equal(report.adsApiVersion, 'v26.0');
  const text = renderDoctorReport(report);
  assert.match(text, /API version:\s+v23\.0/);
  assert.match(text, /Ads API:\s+v26\.0 \(Marketing API, ads package\)/);
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
  assert.deepEqual(
    [...insights.missingPermissions],
    ['read_insights', 'pages_read_engagement'],
  );
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

test('a token check that never answered skips the dependent Graph probes', async () => {
  // Offline with a token: every probe after debug_token goes over the same dead
  // connection, and their retries added ~9 s of silence before the report.
  let metricCalls = 0;
  let adCalls = 0;
  const metric: MetricProbe = () => {
    metricCalls++;
    return Promise.reject(new Error('network request failed'));
  };
  const ad: AdAccountProbe = () => {
    adCalls++;
    return Promise.reject(new Error('network request failed'));
  };
  const { fb, deps } = makeDeps({
    settings: makeSettings({ accessToken: 'EAA-runtime', adAccountId: 'act_1' }),
    metricProbe: metric,
    adAccountProbe: ad,
  });
  fb.on(
    (req) => req.path === '/debug_token',
    fbErr(
      new GraphApiError('network request failed: ECONNREFUSED', {
        code: 0,
        httpStatus: 0,
        action: {
          category: 'transient',
          retryable: true,
          operatorText: 'Network fault.',
        },
      }),
    ),
  );

  const report = await runDoctor(deps);
  assert.equal(report.token.diagnosis, 'token_check_failed');
  assert.equal(metricCalls, 0, 'the metric probe must not run after token_check_failed');
  assert.equal(adCalls, 0, 'the ad-account probe must not run after token_check_failed');
  assert.match(
    report.metricProbe.summary,
    /^metric probe: skipped \(the token could not be checked/,
  );
  assert.match(
    report.adAccount.summary,
    /^ad account: skipped \(the token could not be checked/,
  );
  assert.equal(report.metricProbe.failed, undefined);
  assert.equal(
    report.summary.findings.some(
      (f) => f.area === 'metric probe' || f.area === 'ad account',
    ),
    false,
    'a skipped probe adds no second verdict line for the same connection fault',
  );
  const text = renderDoctorReport(report);
  assert.match(text, /metric probe: skipped/);
  assert.match(text, /ad account: skipped/);
});

test('a token check that failed still reports an unconfigured ad account (no Graph call)', async () => {
  const ad: AdAccountProbe = () =>
    Promise.resolve({
      available: false,
      summary: 'ad account: not configured (set FB_AD_ACCOUNT_ID).',
    });
  const { fb, deps } = makeDeps({ adAccountProbe: ad });
  fb.on(
    (req) => req.path === '/debug_token',
    fbErr(
      new GraphApiError('Service unavailable', {
        code: 2,
        httpStatus: 503,
        action: {
          category: 'transient',
          retryable: true,
          operatorText: 'Network fault.',
        },
      }),
    ),
  );
  const report = await runDoctor(deps);
  assert.equal(report.token.diagnosis, 'token_check_failed');
  assert.match(report.adAccount.summary, /not configured/);
});

test('a token Graph rejected (not a transport fault) still runs the metric probe', async () => {
  let metricCalls = 0;
  const metric: MetricProbe = () => {
    metricCalls++;
    return Promise.resolve({ available: true, summary: 'metric probe: ok' });
  };
  const { fb, deps } = makeDeps({ metricProbe: metric });
  fb.on(
    (req) => req.path === '/debug_token',
    fbErr(
      new GraphApiError('Invalid OAuth access token.', { code: 190, httpStatus: 400 }),
    ),
  );
  const report = await runDoctor(deps);
  assert.equal(report.token.diagnosis, 'token_malformed');
  assert.equal(metricCalls, 1);
});

test('the no-token FAIL names setup-token under the launch form the operator used', async () => {
  const { deps } = makeDeps({ settings: makeSettings() });
  const report = await runDoctor({
    ...deps,
    launchCommand: 'npx -y @ivanbaev/facebook-mcp',
  });
  const fail = report.summary.findings.find((f) => f.area === 'token');
  assert.ok(fail);
  assert.match(
    fail.detail,
    /`FB_SETUP_TOKEN=<token> npx -y @ivanbaev\/facebook-mcp setup-token`/,
  );
  // Unknown launch form: the binary name, as before.
  const fallback = await runDoctor(deps);
  const plain = fallback.summary.findings.find((f) => f.area === 'token');
  assert.match(plain?.detail ?? '', /`FB_SETUP_TOKEN=<token> facebook-mcp setup-token`/);
});

test('token messages list the credentials in precedence order (system > user > page)', async () => {
  const { deps } = makeDeps({ settings: makeSettings() });
  const report = await runDoctor(deps);
  const order = /FB_SYSTEM_TOKEN[^]*FB_ACCESS_TOKEN[^]*FB_PAGE_TOKEN/;
  assert.match(report.token.error ?? '', order);
  assert.match(report.metricSet.summary, order);
  const fail = report.summary.findings.find((f) => f.area === 'token');
  assert.match(fail?.detail ?? '', order);
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

test('the doctor reports the activity state file next to the credential file', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX permission bits are not enforced on win32');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'facebook-mcp-doctor-state-'));
  const statePath = join(dir, 'activity-state.json');
  const { fb, deps } = makeDeps({
    settings: makeSettings({ accessToken: 'EAA-runtime', activityStatePath: statePath }),
  });
  withDebugToken(fb, { type: 'USER', is_valid: true, scopes: [], expires_at: 0 });

  // Absent is the normal state before the first call — reported, not a finding.
  const absent = await runDoctor(deps);
  assert.equal(absent.activityStateFile?.exists, false);
  assert.equal(absent.activityStateFile?.unreadable, undefined);
  assert.match(renderDoctorReport(absent), /state file:\s+.*activity-state\.json/);
  assert.ok(!absent.summary.findings.some((f) => f.area === 'activity state file'));

  await writeFile(statePath, '{"version":1,"pages":{}}\n', { mode: 0o644 });
  await chmod(statePath, 0o644);
  const loose = await runDoctor(deps);
  assert.equal(loose.activityStateFile?.ownerOnly, false);
  const finding = loose.summary.findings.find((f) => f.area === 'activity state file');
  assert.match(String(finding?.detail), /chmod 600/);

  // No path in the settings ⇒ no row at all.
  const { fb: fb2, deps: bare } = makeDeps();
  withDebugToken(fb2, { type: 'USER', is_valid: true, scopes: [], expires_at: 0 });
  const none = await runDoctor(bare);
  assert.equal(none.activityStateFile, undefined);
  assert.doesNotMatch(renderDoctorReport(none), /state file:/);
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
