// Unit tests for the shared ads MONEY helpers: the campaign spend cap guards and
// the worst-case spend envelope. Pure functions — no transport involved.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GraphApiError } from '../core/index.js';
import {
  SPEND_CAP_REMOVAL_SENTINEL,
  assertSpendCapMaxReachable,
  describeEnvelope,
  enforceCeiling,
  enforceSpendCapMax,
  validateSpendCapMinor,
  worstCaseEnvelope,
} from './ads-money.js';

function throwsGraph(fn: () => unknown): GraphApiError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof GraphApiError, 'expected a GraphApiError');
    return err;
  }
  assert.fail('expected a throw');
}

const START = '2026-11-01T00:00:00Z';

test('validateSpendCapMinor refuses the removal sentinel and anything beyond it as a removal', () => {
  for (const value of [
    SPEND_CAP_REMOVAL_SENTINEL,
    SPEND_CAP_REMOVAL_SENTINEL + 1,
    2 ** 60,
  ]) {
    const err = throwsGraph(() => validateSpendCapMinor('spend_cap_minor', value));
    assert.match(err.message, /removing a campaign spend cap is out of scope/);
    assert.equal(err.action?.category, 'validation');
  }
});

test('validateSpendCapMinor accepts an ordinary cap and still rejects non-integers', () => {
  assert.equal(validateSpendCapMinor('spend_cap_minor', 500_000), 500_000);
  const err = throwsGraph(() => validateSpendCapMinor('spend_cap_minor', 10.5));
  assert.doesNotMatch(err.message, /out of scope/);
});

test('enforceSpendCapMax refuses every cap while FB_ADS_CAMPAIGN_SPEND_CAP_MAX is unset', () => {
  const err = throwsGraph(() =>
    enforceSpendCapMax({
      field: 'spend_cap_minor',
      requested: 1_000,
      current: undefined,
      max: undefined,
      currency: 'EUR',
      objectId: 'c1',
    }),
  );
  assert.match(err.message, /set FB_ADS_CAMPAIGN_SPEND_CAP_MAX/i);
  assert.match(err.message, /NOTHING was changed on c1/);
});

test('enforceSpendCapMax names its own setting when the cap exceeds the max', () => {
  const err = throwsGraph(() =>
    enforceSpendCapMax({
      field: 'spend_cap_minor',
      requested: 600_000,
      current: undefined,
      max: 500_000,
      currency: 'EUR',
      objectId: 'c1',
    }),
  );
  assert.match(err.message, /FB_ADS_CAMPAIGN_SPEND_CAP_MAX/);
  assert.doesNotMatch(err.message, /FB_ADS_BUDGET_CEILING/);
  assert.doesNotThrow(() =>
    enforceSpendCapMax({
      field: 'spend_cap_minor',
      requested: 500_000,
      current: undefined,
      max: 500_000,
      currency: 'EUR',
      objectId: 'c1',
    }),
  );
});

test('enforceCeiling still names FB_ADS_BUDGET_CEILING by default', () => {
  const err = throwsGraph(() =>
    enforceCeiling({
      field: 'daily_budget_minor',
      requested: 2_000,
      current: undefined,
      ceiling: 1_000,
      currency: 'EUR',
      objectId: 'a1',
    }),
  );
  assert.match(err.message, /FB_ADS_BUDGET_CEILING/);
});

test('assertSpendCapMaxReachable refuses a max below Meta’s minimum campaign spend cap', () => {
  const err = throwsGraph(() => assertSpendCapMaxReachable(5_000, 10_000, 'USD'));
  assert.match(err.message, /below Meta's minimum campaign spend cap/);
  assert.doesNotThrow(() => assertSpendCapMaxReachable(10_000, 10_000, 'USD'));
  assert.doesNotThrow(() => assertSpendCapMaxReachable(1, undefined, 'USD'));
});

test('worstCaseEnvelope: the envelope table', () => {
  const rows: readonly {
    readonly name: string;
    readonly input: Parameters<typeof worstCaseEnvelope>[0];
    readonly expected: ReturnType<typeof worstCaseEnvelope>;
  }[] = [
    {
      name: 'daily, no end: the cap bounds the total',
      input: { dailyBudgetMinor: 1_000, startTime: START, spendCapMinor: 50_000 },
      expected: {
        perDayMaxMinor: 1_750,
        perWeekMaxMinor: 7_000,
        totalMaxMinor: 50_000,
        boundBy: 'spend_cap',
        spendCapMinor: 50_000,
      },
    },
    {
      name: 'daily, 10 days: two weeks of budget under a large cap',
      input: {
        dailyBudgetMinor: 1_000,
        startTime: START,
        endTime: '2026-11-11T00:00:00Z',
        spendCapMinor: 50_000,
      },
      expected: {
        perDayMaxMinor: 1_750,
        perWeekMaxMinor: 7_000,
        totalMaxMinor: 14_000,
        boundBy: 'daily_flex',
        spendCapMinor: 50_000,
      },
    },
    {
      name: 'daily, 10 days: a small cap wins',
      input: {
        dailyBudgetMinor: 1_000,
        startTime: START,
        endTime: '2026-11-11T00:00:00Z',
        spendCapMinor: 9_000,
      },
      expected: {
        perDayMaxMinor: 1_750,
        perWeekMaxMinor: 7_000,
        totalMaxMinor: 9_000,
        boundBy: 'spend_cap',
        spendCapMinor: 9_000,
      },
    },
    {
      name: 'daily 175% rounds up in integer math',
      input: { dailyBudgetMinor: 3, startTime: START, spendCapMinor: 100 },
      expected: {
        perDayMaxMinor: 6,
        perWeekMaxMinor: 21,
        totalMaxMinor: 100,
        boundBy: 'spend_cap',
        spendCapMinor: 100,
      },
    },
    {
      name: 'lifetime below the cap: the lifetime budget bounds it',
      input: { lifetimeBudgetMinor: 20_000, startTime: START, spendCapMinor: 50_000 },
      expected: {
        totalMaxMinor: 20_000,
        boundBy: 'lifetime_budget',
        spendCapMinor: 50_000,
      },
    },
    {
      name: 'lifetime above the cap: the cap bounds it',
      input: { lifetimeBudgetMinor: 80_000, startTime: START, spendCapMinor: 50_000 },
      expected: { totalMaxMinor: 50_000, boundBy: 'spend_cap', spendCapMinor: 50_000 },
    },
  ];
  for (const row of rows) {
    assert.deepStrictEqual(worstCaseEnvelope(row.input), row.expected, row.name);
  }
});

test('worstCaseEnvelope refuses both budget kinds, a bad time and an end before the start', () => {
  throwsGraph(() =>
    worstCaseEnvelope({
      dailyBudgetMinor: 1,
      lifetimeBudgetMinor: 1,
      startTime: START,
      spendCapMinor: 10,
    }),
  );
  throwsGraph(() =>
    worstCaseEnvelope({ dailyBudgetMinor: 1, startTime: 'soon', spendCapMinor: 10 }),
  );
  throwsGraph(() =>
    worstCaseEnvelope({
      dailyBudgetMinor: 1,
      startTime: START,
      endTime: START,
      spendCapMinor: 10,
    }),
  );
  const err = throwsGraph(() =>
    worstCaseEnvelope({
      dailyBudgetMinor: 1,
      startTime: START,
      spendCapMinor: SPEND_CAP_REMOVAL_SENTINEL,
    }),
  );
  assert.match(err.message, /out of scope/);
});

test('describeEnvelope always names the spend cap as the absolute ceiling, in currency wording', () => {
  const jpy = describeEnvelope(
    worstCaseEnvelope({
      dailyBudgetMinor: 1_000,
      startTime: START,
      spendCapMinor: 50_000,
    }),
    'JPY',
  );
  assert.match(jpy.join('\n'), /1750 JPY \(whole units\)/);
  assert.match(jpy.at(-1) ?? '', /Absolute ceiling: the campaign spend cap of 50000 JPY/);

  const bhd = describeEnvelope(
    worstCaseEnvelope({
      lifetimeBudgetMinor: 2_050,
      startTime: START,
      spendCapMinor: 5_000,
    }),
    'BHD',
  );
  assert.match(bhd.join('\n'), /no per-day bound/);
  assert.match(
    bhd.join('\n'),
    /2050 hundredths of BHD \(20\.50 BHD\), bounded by the lifetime budget/,
  );
  assert.match(bhd.at(-1) ?? '', /50\.00 BHD/);
});
