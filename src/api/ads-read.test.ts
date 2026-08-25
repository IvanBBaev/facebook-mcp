// Tests for the ads READ api module (task V09). Corner cases are named after
// the case they pin: CC-ADS-1 (dev-tier rate limits), CC-ADS-2 (`effective_status`
// truth), CC-ADS-3 (minor-unit budgets), CC-ADS-5 (async report runs) and
// CC-ADS-6 (ad account disabled). Every Graph call goes through the injected
// fake — no network, ever.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeFbRequest, fbOk, fbErr } from '../core/fakes/index.js';
import { GraphApiError, classifyGraphError } from '../core/index.js';
import type { FbRequest, ParamValue } from '../core/index.js';

import {
  ADS_INSIGHTS_MAX_ROWS,
  AD_LEVEL_LIST_FIELDS,
  EFFECTIVE_STATUS_NOTE,
  OVERSIZED_SYNC_SUBCODE,
  REPORT_STALL_MS,
  adAccountBlockedError,
  assertAdAccountUsable,
  classifyAsyncStatus,
  describeAdAccount,
  describeEffectiveStatus,
  fetchAdsInsights,
  fetchReportResults,
  getAdObject,
  getReportRunStatus,
  isAdLevel,
  isDelivering,
  isOversizedSyncError,
  isTerminalPhase,
  listAdObjects,
  normalizeAdAccountId,
  normalizeAdNode,
  normalizeInsightsRow,
  parseMinorUnits,
  resolveAdAccountId,
  startAdsReport,
  withPinnedAdFields,
  type AdAccountInfo,
} from './ads-read.js';

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-07-20T12:00:00Z');
const ACCOUNT = 'act_1234567890';
const RUN_ID = '9988776655';

function paramsOf(call: FbRequest | undefined): Record<string, ParamValue> {
  assert.ok(call, 'expected a captured request');
  assert.equal(call.protocol, 'json');
  return { ...(call.protocol === 'json' ? (call.params ?? {}) : {}) };
}

function bodyOf(call: FbRequest | undefined): Record<string, unknown> {
  assert.ok(call, 'expected a captured request');
  assert.equal(call.protocol, 'json');
  return { ...(call.protocol === 'json' ? (call.body ?? {}) : {}) };
}

/** A Graph campaign node, budgets in the string form Graph really sends. */
function campaign(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '23851234567890123',
    name: 'Summer sale',
    status: 'ACTIVE',
    effective_status: 'ACTIVE',
    objective: 'OUTCOME_TRAFFIC',
    daily_budget: '1000',
    updated_time: '2026-07-19T10:00:00+0000',
    ...overrides,
  };
}

function listBody(...nodes: unknown[]): unknown {
  return {
    data: nodes,
    paging: { cursors: { after: 'CURSOR_2' }, next: 'https://graph/next?after=CURSOR_2' },
  };
}

function graphError(
  code: number,
  message: string,
  subcode?: number,
  httpStatus = 400,
): GraphApiError {
  return new GraphApiError(message, {
    code,
    ...(subcode !== undefined ? { subcode } : {}),
    httpStatus,
    action: classifyGraphError({
      code,
      message,
      ...(subcode !== undefined ? { error_subcode: subcode } : {}),
    }),
  });
}

async function rejectsGraph(promise: Promise<unknown>): Promise<GraphApiError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof GraphApiError, `expected GraphApiError, got ${String(err)}`);
    return err;
  }
  throw new Error('expected the promise to reject');
}

function throwsGraph(fn: () => unknown): GraphApiError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof GraphApiError, `expected GraphApiError, got ${String(err)}`);
    return err;
  }
  throw new Error('expected the call to throw');
}

// ---------------------------------------------------------------------------
// Account id normalisation
// ---------------------------------------------------------------------------

test('normalizeAdAccountId accepts both the bare digits and the act_ form', () => {
  assert.equal(normalizeAdAccountId('1234567890'), ACCOUNT);
  assert.equal(normalizeAdAccountId(' act_1234567890 '), ACCOUNT);
});

test('normalizeAdAccountId refuses anything that is not an ad account id', () => {
  for (const bad of [
    '',
    'act_',
    'page_123',
    'https://business.facebook.com/act_1',
    'act_12a',
  ]) {
    const err = throwsGraph(() => normalizeAdAccountId(bad));
    assert.equal(err.code, 100);
    assert.match(err.message, /act_/);
  }
});

test('resolveAdAccountId falls back to the configured default and names the env var', () => {
  assert.equal(resolveAdAccountId(undefined, '1234567890'), ACCOUNT);
  assert.equal(resolveAdAccountId('999', 'act_111'), 'act_999');
  const err = throwsGraph(() => resolveAdAccountId(undefined, undefined));
  assert.match(err.message, /FB_AD_ACCOUNT_ID/);
});

test('isAdLevel only accepts the three supported levels', () => {
  assert.equal(isAdLevel('adset'), true);
  assert.equal(isAdLevel('creative'), false);
});

// ---------------------------------------------------------------------------
// CC-ADS-2 — effective_status is the truth, status is a setting
// ---------------------------------------------------------------------------

test('CC-ADS-2: a configured-ACTIVE object whose parent is paused is NOT delivering', () => {
  const record = normalizeAdNode(
    campaign({ status: 'ACTIVE', effective_status: 'CAMPAIGN_PAUSED' }),
  );
  assert.equal(record.status, 'ACTIVE');
  assert.equal(record.delivering, false);
  assert.match(record.status_explanation, /parent CAMPAIGN is paused/);
  assert.match(record.status_explanation, /NOT delivering/);
});

test('CC-ADS-2: DISAPPROVED and PENDING_REVIEW are reported as not delivering', () => {
  for (const status of ['DISAPPROVED', 'PENDING_REVIEW', 'WITH_ISSUES', 'IN_PROCESS']) {
    assert.equal(isDelivering(status), false, `${status} must not count as delivering`);
  }
  assert.equal(isDelivering('ACTIVE'), true);
});

test('CC-ADS-2: an unrecognised effective_status is reported as unknown, not as fine', () => {
  const text = describeEffectiveStatus('SOMETHING_NEW', 'ACTIVE');
  assert.match(text, /Unrecognised effective status/);
  assert.equal(isDelivering('SOMETHING_NEW'), false);
});

test('CC-ADS-2: a missing effective_status is stated as unknown rather than assumed', () => {
  const record = normalizeAdNode({ id: '1', status: 'ACTIVE' });
  assert.equal(record.delivering, false);
  assert.match(record.status_explanation, /unknown/i);
});

// ---------------------------------------------------------------------------
// CC-ADS-3 — budgets are integer minor units
// ---------------------------------------------------------------------------

test('CC-ADS-3: minor-unit budget strings become integers under a _minor key', () => {
  const record = normalizeAdNode(
    campaign({
      daily_budget: '1000',
      lifetime_budget: '250000',
      budget_remaining: '750',
    }),
  );
  assert.equal(record.daily_budget_minor, 1000);
  assert.equal(record.lifetime_budget_minor, 250_000);
  assert.equal(record.budget_remaining_minor, 750);
  // The raw string form is gone, so nothing downstream can do string math on it.
  assert.equal(record.daily_budget, undefined);
});

test('CC-ADS-3: parseMinorUnits refuses decimals so a major-unit value never sneaks in', () => {
  assert.equal(parseMinorUnits('1000'), 1000);
  assert.equal(parseMinorUnits(1000), 1000);
  assert.equal(parseMinorUnits('10.00'), undefined);
  assert.equal(parseMinorUnits(10.5), undefined);
  assert.equal(parseMinorUnits('abc'), undefined);
  assert.equal(parseMinorUnits(undefined), undefined);
});

test('CC-ADS-3: an unparseable budget is passed through verbatim, never rounded', () => {
  const record = normalizeAdNode(campaign({ daily_budget: '10.00' }));
  assert.equal(record.daily_budget, '10.00');
  assert.equal(record.daily_budget_minor, undefined);
});

test('normalizeAdNode drops nested paging (the token-bearing next URL never travels)', () => {
  const record = normalizeAdNode({
    id: '1',
    paging: { next: 'https://x?access_token=SECRET' },
  });
  assert.equal(record.paging, undefined);
  assert.equal(JSON.stringify(record).includes('SECRET'), false);
});

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

test('listAdObjects hits the level edge with the level field set and returns the cursor', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk(listBody(campaign())));

  const result = await listAdObjects(fake.fn, {
    accountId: ACCOUNT,
    level: 'campaign',
    limit: 5,
  });

  const call = fake.lastRequest();
  assert.equal(call?.path, `/${ACCOUNT}/campaigns`);
  assert.equal(call?.method, 'GET');
  const params = paramsOf(call);
  assert.equal(params.fields, AD_LEVEL_LIST_FIELDS.campaign);
  assert.equal(params.limit, 5);
  assert.equal(result.count, 1);
  assert.equal(result.nextCursor, 'CURSOR_2');
  assert.equal(result.truncated, false);
  assert.equal(result.hasBudgets, true);
  assert.ok(result.notes.includes(EFFECTIVE_STATUS_NOTE));
});

test('listAdObjects sends an effective_status filter as a JSON array', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk({ data: [] }));

  await listAdObjects(fake.fn, {
    accountId: ACCOUNT,
    level: 'adset',
    effectiveStatus: ['ACTIVE', 'PAUSED'],
  });

  assert.equal(paramsOf(fake.lastRequest()).effective_status, '["ACTIVE","PAUSED"]');
});

test('CC-ADS-2: a fields override cannot drop the delivery fields off a listing', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk({ data: [] }));

  await listAdObjects(fake.fn, {
    accountId: ACCOUNT,
    level: 'campaign',
    fields: 'id,name,daily_budget',
  });

  // Without `effective_status` on the wire, every row normalises to
  // `delivering: false` — the listing would report the configured status as the
  // delivery truth, which is the exact confusion EFFECTIVE_STATUS_NOTE exists
  // to prevent.
  assert.equal(
    paramsOf(fake.lastRequest()).fields,
    'id,name,daily_budget,status,effective_status',
  );
});

test('withPinnedAdFields appends only what is missing and ignores nested selections', () => {
  assert.equal(withPinnedAdFields(''), 'id,status,effective_status');
  assert.equal(
    withPinnedAdFields('id,status,effective_status,name'),
    'id,status,effective_status,name',
    'nothing is appended when the caller already asked for all three',
  );
  // `creative{id,name}` carries an inner `id` that is not the top-level one; the
  // nested block is stripped before the membership test so it cannot mask it.
  assert.equal(
    withPinnedAdFields('name,creative{id,name,status}'),
    'name,creative{id,name,status},id,status,effective_status',
  );
});

test('CC-ADS-2: a fields override cannot drop the delivery fields off a detail read', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk({ id: '1' }));

  await getAdObject(fake.fn, { objectId: '1', level: 'ad', fields: 'id,name' });

  assert.equal(paramsOf(fake.lastRequest()).fields, 'id,name,status,effective_status');
});

test('an empty listing explains that Graph hides ARCHIVED/DELETED by default', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk({ data: [] }));

  const result = await listAdObjects(fake.fn, { accountId: ACCOUNT, level: 'ad' });

  assert.equal(result.count, 0);
  assert.ok(result.notes.some((note) => /ARCHIVED and DELETED/.test(note)));
});

test('listAdObjects returns a partial page with a restart note when the cursor expired', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbErr(graphError(1, 'The cursor you provided is no longer valid')));

  const result = await listAdObjects(fake.fn, {
    accountId: ACCOUNT,
    level: 'campaign',
    after: 'STALE',
  });

  assert.equal(result.truncated, true);
  assert.equal(result.count, 0);
  assert.match(result.note ?? '', /cursor expired/);
});

test('CC-ADS-1: a dev-tier rate-limit error propagates with the wait time attached', async () => {
  const fake = createFakeFbRequest();
  const envelope = {
    code: 80004,
    message: 'Too many calls to this ad-account',
    estimated_time_to_regain_access: 7,
  };
  fake.on(
    () => true,
    fbErr(
      new GraphApiError(envelope.message, {
        code: 80004,
        httpStatus: 400,
        action: classifyGraphError(envelope),
      }),
    ),
  );

  const err = await rejectsGraph(
    listAdObjects(fake.fn, { accountId: ACCOUNT, level: 'campaign' }),
  );
  assert.equal(err.action?.category, 'rate_limit');
  assert.equal(err.action?.retryable, true);
  assert.equal(err.action?.retryAfterMs, 7 * 60_000);
});

// ---------------------------------------------------------------------------
// Single-object read
// ---------------------------------------------------------------------------

test('getAdObject uses the per-level detail fields when the level is known', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk(campaign()));

  const result = await getAdObject(fake.fn, {
    objectId: '23851234567890123',
    level: 'campaign',
  });

  assert.equal(fake.lastRequest()?.path, '/23851234567890123');
  assert.match(String(paramsOf(fake.lastRequest()).fields), /budget_remaining/);
  assert.equal(result.object.delivering, true);
  assert.equal(result.level, 'campaign');
});

test('getAdObject without a level reads only the common fields and says so', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk({ id: '1', status: 'PAUSED', effective_status: 'PAUSED' }));

  const result = await getAdObject(fake.fn, { objectId: '1' });

  assert.equal(
    paramsOf(fake.lastRequest()).fields,
    'id,name,status,effective_status,created_time,updated_time',
  );
  assert.ok(result.notes.some((note) => /level=campaign\|adset\|ad/.test(note)));
});

// ---------------------------------------------------------------------------
// CC-ADS-6 — ad account disabled / payment failure
// ---------------------------------------------------------------------------

test('CC-ADS-6: an ACTIVE account is reported as serving with its currency', () => {
  const info = describeAdAccount(ACCOUNT, {
    account_status: 1,
    currency: 'EUR',
    name: 'Main account',
    timezone_name: 'Europe/Sofia',
  });
  assert.equal(info.serving, true);
  assert.equal(info.statusLabel, 'ACTIVE');
  assert.equal(info.currency, 'EUR');
});

test('CC-ADS-6: a DISABLED account decodes its disable reason and refuses writes', () => {
  const info = describeAdAccount(ACCOUNT, { account_status: 2, disable_reason: 3 });
  assert.equal(info.serving, false);
  assert.equal(info.statusLabel, 'DISABLED');
  assert.equal(info.disableReasonLabel, 'RISK_PAYMENT');

  const err = throwsGraph(() => {
    assertAdAccountUsable(info);
  });
  assert.equal(err.action?.category, 'account');
  assert.equal(err.action?.retryable, false);
  assert.match(err.message, /NOT attempted/);
  assert.match(err.action?.operatorText ?? '', /Ads Manager/);
});

test('CC-ADS-6: an unsettled account is called out as a payment problem, not a permission one', () => {
  const info = describeAdAccount(ACCOUNT, { account_status: 3 });
  assert.equal(info.serving, false);
  assert.equal(info.atRisk, true);
  assert.match(info.summary, /billing is unsettled/);
  const err = adAccountBlockedError(info);
  assert.equal(err.action?.category, 'account');
  // It is delivering as this error is raised, so the headline must not claim the
  // opposite of the summary appended one sentence later.
  assert.doesNotMatch(err.message, /cannot serve ads/);
  assert.match(err.message, /only delivery-stopping changes are accepted/);
});

test('CC-ADS-6: an at-risk account may still be paused, but never resumed or re-budgeted', () => {
  for (const status of [3, 8, 9]) {
    const info = describeAdAccount(ACCOUNT, { account_status: status });
    assert.equal(info.atRisk, true, `status ${String(status)} is a payment problem`);

    // A guardrail against overspending that forbids stopping the spend is worse
    // than no guardrail: pausing is the one action that reduces the damage.
    assert.doesNotThrow(() => {
      assertAdAccountUsable(info, { stopsDelivery: true });
    });
    // The hole is exactly that wide — nothing that keeps or raises spend passes.
    throwsGraph(() => {
      assertAdAccountUsable(info, { stopsDelivery: false });
    });
    throwsGraph(() => {
      assertAdAccountUsable(info);
    });
  }
});

test('CC-ADS-6: a DISABLED account cannot be written to even to stop delivery', () => {
  // Nothing is being spent, so there is no damage to reduce — and the state can
  // only be cleared in Ads Manager.
  const info = describeAdAccount(ACCOUNT, { account_status: 2, disable_reason: 3 });
  assert.equal(info.atRisk, false);
  const err = throwsGraph(() => {
    assertAdAccountUsable(info, { stopsDelivery: true });
  });
  assert.match(err.message, /cannot serve ads/);
});

test('CC-ADS-6: a serving account is not at risk and takes every write', () => {
  const info = describeAdAccount(ACCOUNT, { account_status: 1 });
  assert.equal(info.serving, true);
  assert.equal(info.atRisk, false);
  assert.doesNotThrow(() => {
    assertAdAccountUsable(info, { stopsDelivery: false });
  });
});

test('CC-ADS-6: an unknown account_status never blocks a write on its own', () => {
  const info: AdAccountInfo = describeAdAccount(ACCOUNT, {});
  assert.equal(info.statusLabel, 'UNKNOWN');
  assert.equal(info.serving, false);
  // No status field ⇒ no evidence of a problem ⇒ the write proceeds and Graph decides.
  assert.doesNotThrow(() => {
    assertAdAccountUsable(info);
  });
});

test('CC-ADS-6: an undocumented status code is reported verbatim instead of guessed', () => {
  const info = describeAdAccount(ACCOUNT, { account_status: 42 });
  assert.equal(info.statusLabel, 'UNKNOWN(42)');
  assert.equal(info.serving, false);
});

// ---------------------------------------------------------------------------
// Insights — sync path
// ---------------------------------------------------------------------------

test('fetchAdsInsights reads synchronously and sends the window as a JSON time_range', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk({ data: [{ impressions: '10', spend: '1.50' }] }));

  const result = await fetchAdsInsights(fake.fn, {
    objectId: ACCOUNT,
    level: 'campaign',
    since: '2026-07-01',
    until: '2026-07-07',
    breakdowns: ['age', 'gender'],
  });

  const params = paramsOf(fake.lastRequest());
  assert.equal(params.time_range, '{"since":"2026-07-01","until":"2026-07-07"}');
  assert.equal(params.breakdowns, 'age,gender');
  assert.equal(params.level, 'campaign');
  assert.equal(result.mode, 'sync');
  assert.equal(result.rowCount, 1);
  assert.equal(result.reportRunId, undefined);
});

test('an insights row is never dressed up as an ads object', async () => {
  const fake = createFakeFbRequest();
  fake.on(
    () => true,
    fbOk({
      data: [
        { impressions: '12000', spend: '48.10', paging: { cursors: { after: 'X' } } },
      ],
    }),
  );

  const result = await fetchAdsInsights(fake.fn, {
    objectId: ACCOUNT,
    level: 'campaign',
  });

  const row = result.rows?.[0] as Record<string, unknown> | undefined;
  assert.ok(row, 'the sync path returns the row inline');
  // A metric bag has no id and no effective_status, so the ads-object normaliser
  // would stamp it `id: ''` and `delivering: false` — labelling a row that is
  // itself proof of delivery as not delivering.
  assert.deepEqual(row, { impressions: '12000', spend: '48.10' });
  assert.equal('id' in row, false);
  assert.equal('delivering' in row, false);
  assert.equal('paging' in row, false, 'nested paging carries the access token (C3)');
});

test('normalizeInsightsRow passes metrics through and drops only nested paging', () => {
  assert.deepEqual(normalizeInsightsRow({ reach: 5, paging: { next: 'https://x' } }), {
    reach: 5,
  });
  assert.deepEqual(normalizeInsightsRow(null), {});
});

test('fetchAdsInsights refuses a half-open window instead of silently dropping it', async () => {
  const fake = createFakeFbRequest();
  const err = await rejectsGraph(
    fetchAdsInsights(fake.fn, { objectId: ACCOUNT, since: '2026-07-01' }),
  );
  assert.match(err.message, /BOTH `since` and `until`/);
  assert.equal(
    fake.calls.length,
    0,
    'nothing may reach the wire on a validation failure',
  );
});

test('fetchAdsInsights caps rows and says how many were dropped', async () => {
  const fake = createFakeFbRequest();
  const rows = Array.from({ length: ADS_INSIGHTS_MAX_ROWS + 5 }, (_unused, index) => ({
    id: String(index),
    impressions: String(index),
  }));
  fake.on(
    () => true,
    fbOk({ data: rows, paging: { cursors: { after: 'C' }, next: 'https://x' } }),
  );

  const result = await fetchAdsInsights(fake.fn, {
    objectId: ACCOUNT,
    datePreset: 'last_7d',
  });

  assert.equal(result.rowCount, ADS_INSIGHTS_MAX_ROWS);
  assert.equal(result.truncated, true);
  assert.ok(
    result.notes.some((note) => note.includes(String(ADS_INSIGHTS_MAX_ROWS + 5))),
  );
  // A cursor would resume mid-cap and skip the dropped rows, so it is withheld.
  assert.equal(result.nextCursor, undefined);
});

test('an empty sync result is explained as "no delivery", not as an error', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk({ data: [] }));

  const result = await fetchAdsInsights(fake.fn, { objectId: ACCOUNT });

  assert.equal(result.rowCount, 0);
  assert.ok(result.notes.some((note) => /not an error/.test(note)));
});

// ---------------------------------------------------------------------------
// CC-ADS-5 — async report runs
// ---------------------------------------------------------------------------

test('CC-ADS-5: an oversized sync query falls back to an async run and returns the id', async () => {
  const fake = createFakeFbRequest();
  fake.on(
    (req) => req.method === 'GET',
    fbErr(graphError(100, 'Please reduce the amount of data', OVERSIZED_SYNC_SUBCODE)),
  );
  fake.on((req) => req.method === 'POST', fbOk({ report_run_id: 9988776655 }));

  const result = await fetchAdsInsights(fake.fn, {
    objectId: ACCOUNT,
    since: '2025-01-01',
    until: '2026-01-01',
  });

  assert.equal(result.mode, 'async');
  assert.equal(result.reportRunId, RUN_ID);
  assert.equal(result.rows, undefined);
  assert.ok(result.notes.some((note) => /NO rows were read yet/.test(note)));
  assert.ok(result.notes.some((note) => /facebook_ads_report_status/.test(note)));
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[1]?.method, 'POST');
});

test('CC-ADS-5: a sync failure that is NOT the size limit propagates unchanged', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbErr(graphError(190, 'Invalid OAuth access token')));

  const err = await rejectsGraph(fetchAdsInsights(fake.fn, { objectId: ACCOUNT }));

  assert.equal(err.code, 190);
  assert.equal(fake.calls.length, 1, 'a failed sync read must not start an async run');
});

test('isOversizedSyncError only matches code 100 with the documented subcode', () => {
  assert.equal(
    isOversizedSyncError(graphError(100, 'too big', OVERSIZED_SYNC_SUBCODE)),
    true,
  );
  assert.equal(isOversizedSyncError(graphError(100, 'bad param')), false);
  assert.equal(
    isOversizedSyncError(graphError(1, 'unknown', OVERSIZED_SYNC_SUBCODE)),
    false,
  );
  assert.equal(isOversizedSyncError(new Error('nope')), false);
});

test('CC-ADS-5: forceAsync skips the sync attempt entirely', async () => {
  const fake = createFakeFbRequest();
  fake.on((req) => req.method === 'POST', fbOk({ report_run_id: '42' }));

  const result = await fetchAdsInsights(fake.fn, { objectId: ACCOUNT, forceAsync: true });

  assert.equal(result.mode, 'async');
  assert.equal(result.reportRunId, '42');
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.method, 'POST');
});

test('CC-ADS-5: an accepted run with no report_run_id is an error, not a silent success', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk({ ok: true }));

  const err = await rejectsGraph(startAdsReport(fake.fn, { objectId: ACCOUNT }));
  assert.match(err.message, /no `report_run_id`/);
});

test('startAdsReport POSTs the same query the sync path would have sent', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk({ report_run_id: 7 }));

  await startAdsReport(fake.fn, {
    objectId: ACCOUNT,
    level: 'ad',
    breakdowns: ['country'],
    timeIncrement: '1',
  });

  const call = fake.lastRequest();
  assert.equal(call?.method, 'POST');
  assert.equal(call?.path, `/${ACCOUNT}/insights`);
  const body = bodyOf(call);
  assert.equal(body.level, 'ad');
  assert.equal(body.breakdowns, 'country');
  assert.equal(body.time_increment, '1');
});

// ---------------------------------------------------------------------------
// CC-ADS-5 — the terminal-state machine
// ---------------------------------------------------------------------------

test('CC-ADS-5: every documented async_status maps onto a phase', () => {
  assert.equal(classifyAsyncStatus('Job Not Started'), 'pending');
  assert.equal(classifyAsyncStatus('Job Started'), 'running');
  assert.equal(classifyAsyncStatus('Job Running'), 'running');
  assert.equal(classifyAsyncStatus('Job Completed'), 'complete');
  assert.equal(classifyAsyncStatus('Job Failed'), 'failed');
  assert.equal(classifyAsyncStatus('Job Skipped'), 'skipped');
  assert.equal(classifyAsyncStatus('job completed'), 'complete');
  assert.equal(classifyAsyncStatus('Something Else'), 'unknown');
  assert.equal(classifyAsyncStatus(undefined), 'unknown');
});

test('CC-ADS-5: complete, failed and skipped are terminal; the rest are not', () => {
  assert.equal(isTerminalPhase('complete'), true);
  assert.equal(isTerminalPhase('failed'), true);
  assert.equal(isTerminalPhase('skipped'), true);
  assert.equal(isTerminalPhase('running'), false);
  assert.equal(isTerminalPhase('pending'), false);
  assert.equal(isTerminalPhase('unknown'), false);
});

test('CC-ADS-5: a completed run reports results as ready', async () => {
  const fake = createFakeFbRequest();
  fake.on(
    () => true,
    fbOk({
      async_status: 'Job Completed',
      async_percent_completion: 100,
      time_ref: (NOW - 60_000) / 1000,
    }),
  );

  const status = await getReportRunStatus(fake.fn, { reportRunId: RUN_ID, nowMs: NOW });

  assert.equal(status.phase, 'complete');
  assert.equal(status.terminal, true);
  assert.equal(status.resultsReady, true);
  assert.equal(status.stalled, false);
  assert.equal(status.ageMs, 60_000);
});

test('CC-ADS-5: a FAILED run says it produced nothing and tells the caller to stop polling', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk({ async_status: 'Job Failed', async_percent_completion: 40 }));

  const status = await getReportRunStatus(fake.fn, { reportRunId: RUN_ID, nowMs: NOW });

  assert.equal(status.phase, 'failed');
  assert.equal(status.terminal, true);
  assert.equal(status.resultsReady, false);
  assert.match(status.advice, /FAILED/);
  assert.match(status.advice, /Do not keep polling/);
});

test('CC-ADS-5: a SKIPPED run is reported as terminal with nothing produced', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk({ async_status: 'Job Skipped' }));

  const status = await getReportRunStatus(fake.fn, { reportRunId: RUN_ID, nowMs: NOW });

  assert.equal(status.phase, 'skipped');
  assert.equal(status.terminal, true);
  assert.match(status.advice, /SKIPPED/);
});

test('CC-ADS-5: a run stuck past the stall window gets "give up", not "keep waiting"', async () => {
  const fake = createFakeFbRequest();
  fake.on(
    () => true,
    fbOk({
      async_status: 'Job Running',
      async_percent_completion: 3,
      time_ref: (NOW - REPORT_STALL_MS - 60_000) / 1000,
    }),
  );

  const status = await getReportRunStatus(fake.fn, { reportRunId: RUN_ID, nowMs: NOW });

  assert.equal(status.phase, 'running');
  assert.equal(status.terminal, false);
  assert.equal(status.stalled, true);
  assert.match(status.advice, /Stop polling/);
  assert.match(status.advice, /no cancel API/);
});

test('CC-ADS-5: a young running job gets a poll interval instead of a stall warning', async () => {
  const fake = createFakeFbRequest();
  fake.on(
    () => true,
    fbOk({
      async_status: 'Job Running',
      async_percent_completion: 30,
      time_ref: (NOW - 30_000) / 1000,
    }),
  );

  const status = await getReportRunStatus(fake.fn, { reportRunId: RUN_ID, nowMs: NOW });

  assert.equal(status.stalled, false);
  assert.match(status.advice, /Wait about/);
  assert.match(status.advice, /30% complete/);
});

test('CC-ADS-5: an unrecognised async_status is surfaced verbatim and treated as unknown', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk({ async_status: 'Job Teleported' }));

  const status = await getReportRunStatus(fake.fn, { reportRunId: RUN_ID, nowMs: NOW });

  assert.equal(status.phase, 'unknown');
  assert.equal(status.terminal, false);
  assert.equal(status.resultsReady, false);
  assert.equal(status.rawStatus, 'Job Teleported');
  assert.match(status.advice, /Job Teleported/);
  assert.match(status.advice, /do not assume it is still running/i);
});

test('CC-ADS-5: a run with no time_ref reports no age and is never called stalled', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk({ async_status: 'Job Not Started' }));

  const status = await getReportRunStatus(fake.fn, { reportRunId: RUN_ID, nowMs: NOW });

  assert.equal(status.phase, 'pending');
  assert.equal(status.ageMs, undefined);
  assert.equal(status.stalled, false);
});

test('fetchReportResults reads the finished run and caps its rows', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk({ data: [{ impressions: '5' }, { impressions: '6' }] }));

  const results = await fetchReportResults(fake.fn, { reportRunId: RUN_ID, limit: 50 });

  assert.equal(fake.lastRequest()?.path, `/${RUN_ID}/insights`);
  assert.equal(paramsOf(fake.lastRequest()).limit, 50);
  assert.equal(results.rowCount, 2);
  assert.equal(results.truncated, false);
});

test('fetchReportResults really enforces the cap and then withholds the cursor', async () => {
  const fake = createFakeFbRequest();
  // Two rows never reach the cap, so the test above proves only that the happy
  // path returns everything. The async-report edge is exactly where a run is
  // large enough to hit it, so drive the cap for real here.
  const rows = Array.from({ length: ADS_INSIGHTS_MAX_ROWS + 3 }, (_unused, index) => ({
    impressions: String(index),
  }));
  fake.on(
    () => true,
    fbOk({ data: rows, paging: { cursors: { after: 'NEXT' }, next: 'https://x' } }),
  );

  const results = await fetchReportResults(fake.fn, { reportRunId: RUN_ID });

  assert.equal(results.rowCount, ADS_INSIGHTS_MAX_ROWS);
  assert.equal(results.truncated, true);
  assert.ok(
    results.notes.some((note) => note.includes(String(ADS_INSIGHTS_MAX_ROWS + 3))),
    'the note names how many rows the run actually had',
  );
  // Graph handed back a cursor, but it resumes AFTER the whole page — following it
  // would jump over the rows the cap just dropped and present the gap as complete.
  assert.equal(results.nextCursor, undefined);
});

test('fetchReportResults honours a caller-supplied maxRows below the default', async () => {
  const fake = createFakeFbRequest();
  const rows = Array.from({ length: 5 }, (_unused, index) => ({
    impressions: String(index),
  }));
  fake.on(() => true, fbOk({ data: rows }));

  const results = await fetchReportResults(fake.fn, {
    reportRunId: RUN_ID,
    maxRows: 2,
  });

  // `opts.maxRows ?? ADS_INSIGHTS_MAX_ROWS` is a fallback, not a floor: a caller
  // reading into a tight result budget has to be able to ask for less.
  assert.equal(results.rowCount, 2);
  assert.deepEqual(
    results.rows.map((row) => row.impressions),
    ['0', '1'],
    'the kept rows are the FIRST two, not an arbitrary slice',
  );
  assert.equal(results.truncated, true);
});
