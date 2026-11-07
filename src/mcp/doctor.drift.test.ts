// Tests for the doctor (`mcp/doctor.ts`): metric omissions (wave 21) and API-version
// drift.
//
// Split out of `doctor.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/doctor.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeRedactor, fbErr, fbOk } from '../core/fakes/index.js';
import { GraphApiError, createVersionDriftMonitor } from '../core/index.js';
import {
  doctorExitCode,
  renderDoctorReport,
  runDoctor,
  summarizeDoctor,
  type AdAccountProbe,
} from './doctor.js';
import {
  CORE_TOOLS,
  derivedPageToken,
  healthyReport,
  insightRow,
  insightsCalls,
  makeDeps,
  makeLogger,
  makeMetricSetDeps,
  makeSettings,
  metricRejection,
  onBatch,
  onSingle,
  pkg,
  withDebugToken,
} from '../testing/harness/doctor.js';

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

// ---------------------------------------------------------------------------
// API-version drift (doc 12 H1, runbook app-upkeep §2)
// ---------------------------------------------------------------------------

const AUTO_UPGRADE =
  'The call has been auto-upgraded to v26.0 as v25.0 has been deprecated';

const HEALTHY_DEBUG_TOKEN = {
  type: 'SYSTEM_USER',
  is_valid: true,
  scopes: ['pages_show_list', 'pages_read_engagement'],
  expires_at: 0,
};

test('a version header seen by the ad-account probe is a warn finding and a Server line', async () => {
  const versionDrift = createVersionDriftMonitor({
    logger: makeLogger(),
    redactor: createFakeRedactor(),
  });
  // Stands in for the transport: the real probe's Graph call is what observes.
  const probe: AdAccountProbe = () => {
    versionDrift.observe(
      { 'x-ad-api-version-warning': AUTO_UPGRADE },
      'v25.0',
      'marketing',
    );
    return Promise.resolve({ available: true, summary: 'ad account act_1: ACTIVE' });
  };
  const { fb, deps } = makeDeps({ adAccountProbe: probe });
  withDebugToken(fb, HEALTHY_DEBUG_TOKEN);

  const report = await runDoctor({ ...deps, versionDrift });
  assert.equal(report.versionDrift?.length, 1, 'read AFTER the probes ran');
  assert.equal(report.summary.verdict, 'warn');
  const finding = report.summary.findings.find((f) => f.area === 'api version');
  assert.ok(finding, 'expected an api version finding');
  assert.equal(finding.severity, 'warn');
  assert.match(finding.detail, /x-ad-api-version-warning/);
  assert.match(finding.detail, /FB_ADS_API_VERSION/);
  assert.equal(doctorExitCode(report.summary.verdict, true), 1);

  const text = renderDoctorReport(report);
  const server = text.slice(0, text.indexOf('\nToken\n'));
  assert.match(
    server,
    / {2}VERSION DRIFT: x-ad-api-version-warning: "The call has been auto-upgraded/,
  );
});

test('a wired monitor that saw nothing adds no finding and no Server line', async () => {
  const { fb, deps } = makeDeps();
  withDebugToken(fb, HEALTHY_DEBUG_TOKEN);
  const wired = await runDoctor({ ...deps, versionDrift: { signals: () => [] } });
  assert.deepEqual(wired.versionDrift, []);
  assert.equal(wired.summary.verdict, 'ok');
  assert.ok(!renderDoctorReport(wired).includes('VERSION DRIFT'));
  // Unwired: the field is absent and the verdict unchanged.
  const unwired = await healthyReport();
  assert.equal(unwired.versionDrift, undefined);
  assert.equal(unwired.summary.verdict, 'ok');
});

test('a served-version mismatch names the Graph knob in the finding', async () => {
  const base = await healthyReport();
  const summary = summarizeDoctor({
    ...base,
    versionDrift: [
      {
        kind: 'served-version-mismatch',
        header: 'facebook-api-version',
        value: 'v24.0',
        requestedVersion: 'v23.0',
        api: 'graph',
      },
    ],
  });
  assert.equal(summary.verdict, 'warn');
  const finding = summary.findings.find((f) => f.area === 'api version');
  assert.match(finding?.detail ?? '', /FB_API_VERSION/);
  assert.match(finding?.detail ?? '', /requested v23\.0, Graph API/);
});
