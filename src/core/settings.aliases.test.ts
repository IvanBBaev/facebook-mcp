// Settings collapse (C04): renamed variables read through deprecated aliases,
// the multiple-token warning (CC-AUTH-9) and the SEC-04 spend-ceiling contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adsSpendCeilingProblem,
  loadSettings,
  SETTING_ALIASES,
  type StartupProblem,
} from './settings.js';

const BASE_ENV = { FB_ACCESS_TOKEN: 'fake', FB_APP_SECRET: 's', FB_PAGE_ID: '1' };
const HTTP_BEARER = 'http-bearer-0123456789abcdef';

function load(env: Record<string, string>) {
  return loadSettings({
    platform: 'linux',
    homeDir: '/home/t',
    loadEnvFile: false,
    env: { ...BASE_ENV, ...env },
  });
}

function byCode(problems: readonly StartupProblem[], code: string): StartupProblem[] {
  return problems.filter((p) => p.code === code);
}

test('C04: every alias maps a distinct old name to a distinct new FB_* name', () => {
  const names = SETTING_ALIASES.flatMap((a) => [a.name, a.deprecated]);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.match(name, /^FB_[A-Z_]+$/);
});

test('C04: the new names are read without any warning', () => {
  const { settings, report } = load({
    FB_TOOL_PACKAGES_DENY: 'Messages, ads',
    FB_TOOL_PACKAGES_READONLY: 'posts',
    FB_HTTP_BEARER: HTTP_BEARER,
  });
  assert.deepEqual(settings.packagesDeny, ['messages', 'ads']);
  assert.deepEqual(settings.packagesReadonly, ['posts']);
  assert.equal(settings.httpToken, HTTP_BEARER);
  assert.deepEqual(byCode(report.problems, 'deprecated-setting'), []);
  assert.equal(report.ok, true);
});

for (const { name, deprecated } of SETTING_ALIASES) {
  const value = deprecated === 'FB_HTTP_TOKEN' ? HTTP_BEARER : 'messages';

  test(`C04: ${deprecated} alone still works and is reported as deprecated`, () => {
    const { report } = load({ [deprecated]: value });
    assert.equal(report.ok, true);
    const [warning, ...rest] = byCode(report.warnings, 'deprecated-setting');
    assert.deepEqual(rest, []);
    assert.ok(warning);
    assert.equal(warning.field, deprecated);
    assert.match(
      warning.message,
      new RegExp(`${deprecated} is deprecated; rename it to ${name}`),
    );
    assert.match(warning.message, /2\.0/);
  });

  test(`C04: ${name} and ${deprecated} set alike warns; set differently is an error`, () => {
    const same = load({ [name]: value, [deprecated]: value });
    assert.equal(same.report.ok, true);
    const [warning] = byCode(same.report.warnings, 'deprecated-setting');
    assert.ok(warning);
    assert.match(warning.message, /ignored because/);

    const other = deprecated === 'FB_HTTP_TOKEN' ? `${HTTP_BEARER}-other` : 'reader';
    const conflict = load({ [name]: value, [deprecated]: other });
    assert.equal(conflict.report.ok, false);
    const [error] = byCode(conflict.report.errors, 'setting-alias-conflict');
    assert.ok(error);
    assert.equal(error.field, deprecated);
    assert.ok(
      !error.message.includes(value),
      'the conflict message never echoes a value',
    );
  });
}

test('C04: the old values reach the same settings the new names do', () => {
  const { settings } = load({
    FB_PACKAGES_DENY: 'ads',
    FB_PACKAGES_READONLY: 'reader,insights',
    FB_HTTP_TOKEN: HTTP_BEARER,
  });
  assert.deepEqual(settings.packagesDeny, ['ads']);
  assert.deepEqual(settings.packagesReadonly, ['reader', 'insights']);
  assert.equal(settings.httpToken, HTTP_BEARER);
});

test('C04: a short bearer is refused under the name the operator actually set', () => {
  const viaOld = load({ FB_TRANSPORT: 'http', FB_HTTP_TOKEN: 'short' });
  const [oldError] = byCode(viaOld.report.errors, 'weak-http-token');
  assert.ok(oldError);
  assert.equal(oldError.field, 'FB_HTTP_TOKEN');
  assert.match(oldError.message, /^FB_HTTP_TOKEN must be/);

  const viaNew = load({ FB_TRANSPORT: 'http', FB_HTTP_BEARER: 'short' });
  const [newError] = byCode(viaNew.report.errors, 'weak-http-token');
  assert.ok(newError);
  assert.equal(newError.field, 'FB_HTTP_BEARER');
});

test('C04: http without a bearer names the new variable and its former name', () => {
  const { report } = load({ FB_TRANSPORT: 'http' });
  const [error] = byCode(report.errors, 'http-no-token');
  assert.ok(error);
  assert.equal(error.field, 'FB_HTTP_BEARER');
  assert.match(error.message, /FB_HTTP_BEARER \(formerly FB_HTTP_TOKEN\)/);
});

test('CC-AUTH-9: more than one base token warns, naming the winner and never a value', () => {
  const { report } = load({
    FB_SYSTEM_TOKEN: 'sys-secret-value',
    FB_PAGE_TOKEN: 'page-secret-value',
  });
  assert.equal(report.ok, true);
  const [warning, ...rest] = byCode(report.warnings, 'multiple-tokens');
  assert.deepEqual(rest, []);
  assert.ok(warning);
  assert.equal(warning.field, 'FB_ACCESS_TOKEN');
  assert.match(warning.message, /only FB_SYSTEM_TOKEN is used/);
  assert.match(warning.message, /FB_ACCESS_TOKEN, FB_PAGE_TOKEN are ignored/);
  assert.doesNotMatch(warning.message, /secret-value|fake/);
});

test('CC-AUTH-9: a single base token says nothing', () => {
  const { report } = load({});
  assert.deepEqual(byCode(report.problems, 'multiple-tokens'), []);
});

test('SEC-04: spend-tier ads writes need FB_ADS_BUDGET_CEILING', () => {
  const problem = adsSpendCeilingProblem({ adsBudgetCeiling: undefined });
  assert.ok(problem);
  assert.equal(problem.severity, 'error');
  assert.equal(problem.code, 'ads-no-budget-ceiling');
  assert.equal(problem.field, 'FB_ADS_BUDGET_CEILING');

  assert.equal(adsSpendCeilingProblem({ adsBudgetCeiling: 0 }), undefined);
  const { settings } = load({ FB_ADS_BUDGET_CEILING: '5000' });
  assert.equal(adsSpendCeilingProblem(settings), undefined);
});
