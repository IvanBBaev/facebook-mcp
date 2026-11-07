// Tests for the doctor (`mcp/doctor.ts`): the Page token binding, wire truth and non-
// Error rejections.
//
// Split out of `doctor.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/doctor.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fbErr } from '../core/fakes/index.js';
import { GraphApiError, PROXY_ENV_HINT, classifyNetworkError } from '../core/index.js';
import {
  doctorExitCode,
  renderDoctorReport,
  runDoctor,
  type DoctorReport,
} from './doctor.js';
import {
  CORE_TOOLS,
  makeDeps,
  makeMetricSetDeps,
  makeSettings,
  onBatch,
  pkg,
  row,
  withDebugToken,
} from '../testing/harness/doctor.js';

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
    /\[NOT CHECKED\] reader\s+required: pages_read_engagement, pages_read_user_content, pages_show_list — not checked \(the token's scopes were never learned; see Token above\)/,
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
