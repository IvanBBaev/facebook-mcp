// Tests for the doctor (`mcp/doctor.ts`): the insights metric-set probe.
//
// Split out of `doctor.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/doctor.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeRedactor, fbErr, fbOk } from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
// Test-only reach into layer 1: the doctor may not import the api layer, so the
// rename table it ships is a hand-kept mirror of the api deprecation table. The
// drift guard at the bottom of this file is what keeps the two honest.

import {
  INSIGHTS_MAX_WINDOW_DAYS,
  PAGE_INSIGHTS_LIKES_FLOOR,
  classifyMetric,
} from '../api/insights.js';
import {
  METRIC_PROBE_LIKES_FLOOR,
  METRIC_PROBE_MAX_WINDOW_DAYS,
  METRIC_PROBE_PERIOD,
  METRIC_PROBE_WINDOW_DAYS,
  PROBED_PAGE_METRICS,
  renderDoctorReport,
  runDoctor,
} from './doctor.js';
import {
  ALL_METRICS,
  derivedPageToken,
  insightRow,
  insightsCalls,
  makeDeps,
  makeMetricSetDeps,
  makeSettings,
  metricRejection,
  onBatch,
  onPageTokenDerivation,
  onSingle,
} from '../testing/harness/doctor.js';

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
      'page_total_media_view_unique',
      'page_video_views',
    ],
  );
  // Meta's current reference lists only the unique unfollows metric; the probe
  // entry has to carry that caveat until a live pass settles it.
  const unfollows = PROBED_PAGE_METRICS.find((e) => e.metric === 'page_daily_unfollows');
  assert.match(unfollows?.note ?? '', /page_daily_unfollows_unique/);

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
    'page_impressions_unique',
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
