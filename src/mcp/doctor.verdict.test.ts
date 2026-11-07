// Tests for the doctor (`mcp/doctor.ts`): the overall verdict and the renderer's
// robustness.
//
// Split out of `doctor.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/doctor.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fbErr } from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import type { StartupProblem } from '../core/index.js';
import {
  PACKAGE_PERMISSIONS,
  doctorExitCode,
  renderDoctorReport,
  runDoctor,
  summarizeDoctor,
  type DoctorReport,
  type MetricProbe,
} from './doctor.js';
import {
  healthyReport,
  makeDeps,
  makeSettings,
  pkg,
  withDebugToken,
} from '../testing/harness/doctor.js';

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

test('a first run with no credential points at setup-token and reports one problem, not two', async () => {
  // The onboarding path is "run the doctor, fix what it says". With no token the
  // only fix is to mint one, so the FAIL must name the subcommand that does it,
  // and the metric probe must not add an UNKNOWN line that fails on the very
  // same missing token (or on the Page a fresh install has not pinned yet).
  let probeCalls = 0;
  const probe: MetricProbe = () => {
    probeCalls++;
    return Promise.reject(new Error('No default Page configured.'));
  };
  const { fb, deps } = makeDeps({ settings: makeSettings(), metricProbe: probe });

  const report = await runDoctor(deps);
  const fail = report.summary.findings.find(
    (f) => f.severity === 'fail' && f.area === 'token',
  );
  assert.ok(fail, 'expected the token FAIL');
  assert.match(fail.detail, /setup-token/);
  assert.match(fail.detail, /FB_SETUP_TOKEN/);
  assert.equal(probeCalls, 0, 'the metric probe must not run without a credential');
  assert.equal(report.metricProbe.failed, undefined);
  assert.match(report.metricProbe.summary, /skipped \(no token configured/);
  assert.equal(
    report.summary.findings.some((f) => f.area === 'metric probe'),
    false,
    'no second verdict line for the same missing token',
  );
  assert.equal(fb.calls.length, 0);
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
