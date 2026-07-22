import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withEnv } from '../testing/index.js';
import {
  assertStartupOk,
  DEFAULT_API_VERSION,
  DEFAULT_HOST_CONCURRENCY,
  DEFAULT_MAX_RESULT_CHARS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  formatStartupReport,
  GRAPH_HOSTS,
  HTTP_LOOPBACK_HOST,
  loadSettings,
  StartupConfigError,
  type StartupProblem,
} from './settings.js';

const POSIX = {
  platform: 'linux' as const,
  homeDir: '/home/t',
  loadEnvFile: false as const,
};

function codes(problems: readonly StartupProblem[]): string[] {
  return problems.map((p) => p.code);
}

// --- Happy path & defaults ---

test('minimal valid config resolves with sane defaults and no errors', () => {
  const { settings, report } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake-access-token',
      FB_PAGE_ID: '123',
      FB_APP_SECRET: 'fake-secret',
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.errors.length, 0);
  assert.equal(settings.accessToken, 'fake-access-token');
  assert.equal(settings.defaultPageId, '123');
  assert.equal(settings.apiVersion, DEFAULT_API_VERSION);
  assert.equal(settings.transport, 'stdio');
  assert.equal(settings.writeMode, 'plan');
  assert.equal(settings.logLevel, 'info');
  assert.equal(settings.maxResultChars, DEFAULT_MAX_RESULT_CHARS);
  assert.equal(settings.hostConcurrency, DEFAULT_HOST_CONCURRENCY);
  assert.equal(settings.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  assert.deepEqual(settings.hosts, GRAPH_HOSTS);
  assert.deepEqual(settings.profiles, {});
  assert.deepEqual(settings.packagesDeny, []);
  assert.equal(settings.toolPackages, undefined);
  assert.equal(settings.mediaDir, undefined);
  assert.equal(settings.httpToken, undefined);
  assert.ok(settings.journalPath.endsWith('/facebook-mcp/journal.ndjson'));
});

test('system-user token alone (no FB_ACCESS_TOKEN) satisfies the credential check', () => {
  const { report } = loadSettings({
    ...POSIX,
    env: { FB_SYSTEM_TOKEN: 'fake-sys', FB_PAGE_ID: '1' },
  });
  assert.equal(report.ok, true);
});

// --- CC-CFG-2: aggregated startup report (never fail-fast) ---

test('CC-CFG-2: all config problems are aggregated, not reported one at a time', () => {
  const { settings, report } = loadSettings({
    ...POSIX,
    env: {
      // no token at all
      FB_TRANSPORT: 'carrier-pigeon',
      FB_WRITE_MODE: 'yolo',
      FB_MAX_RESULT_CHARS: 'not-a-number',
      FB_LOG_LEVEL: 'chatty',
      FB_APP_SECRET: 'fake-secret',
      FB_PAGE_ID: '1',
    },
  });

  assert.equal(report.ok, false);
  const errorCodes = codes(report.errors);
  assert.ok(errorCodes.includes('no-access-token'), 'missing token reported');
  // Two bad enums + one bad number all surface together.
  assert.ok(errorCodes.filter((c) => c === 'invalid-enum').length >= 2);
  assert.ok(errorCodes.includes('invalid-number'));
  assert.ok(report.errors.length >= 4, 'aggregated, not fail-fast on the first');

  // Best-effort settings still returned with defaults substituted.
  assert.equal(settings.transport, 'stdio');
  assert.equal(settings.writeMode, 'plan');
  assert.equal(settings.logLevel, 'info');
  assert.equal(settings.maxResultChars, DEFAULT_MAX_RESULT_CHARS);
});

test('CC-CFG-2: loadSettings never throws; assertStartupOk does; formatter lists everything', () => {
  const { report } = loadSettings({ ...POSIX, env: {} });
  assert.equal(report.ok, false);

  assert.throws(
    () => {
      assertStartupOk(report);
    },
    (e: unknown) => e instanceof StartupConfigError && e.report === report,
  );

  const text = formatStartupReport(report);
  assert.match(text, /Configuration errors/);
  assert.match(text, /no-access-token/);
});

test('assertStartupOk is a no-op when the report is clean', () => {
  const { report } = loadSettings({
    ...POSIX,
    env: { FB_ACCESS_TOKEN: 'fake', FB_PAGE_ID: '1', FB_APP_SECRET: 's' },
  });
  assert.doesNotThrow(() => {
    assertStartupOk(report);
  });
});

// --- CC-CFG-5: FB_API_VERSION future/retired accepted verbatim, warns ---

test('CC-CFG-5: a non-default API version is accepted verbatim with a warning (not an error)', () => {
  const { settings, report } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_API_VERSION: 'v99.0',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
    },
  });
  assert.equal(settings.apiVersion, 'v99.0');
  assert.equal(report.ok, true, 'escape hatch: not an error');
  assert.ok(codes(report.warnings).includes('api-version-nondefault'));
});

test('CC-CFG-5: a malformed API version is still accepted verbatim, with a format warning', () => {
  const { settings, report } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_API_VERSION: 'banana',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
    },
  });
  assert.equal(settings.apiVersion, 'banana');
  assert.equal(report.ok, true);
  assert.ok(codes(report.warnings).includes('api-version-format'));
});

test('CC-CFG-5: the default API version produces no version warning', () => {
  const { report } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_API_VERSION: DEFAULT_API_VERSION,
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
    },
  });
  assert.ok(!codes(report.warnings).some((c) => c.startsWith('api-version')));
});

// --- CC-CFG-6: HTTP transport fails closed without a token ---

test('CC-CFG-6: FB_TRANSPORT=http without FB_HTTP_TOKEN is an aggregated error', () => {
  const { settings, report } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_TRANSPORT: 'http',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
    },
  });
  assert.equal(report.ok, false);
  assert.ok(codes(report.errors).includes('http-no-token'));
  assert.equal(settings.transport, 'http');
});

test('CC-CFG-6: FB_TRANSPORT=http with a token binds loopback and the default port', () => {
  const { settings, report } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_TRANSPORT: 'http',
      FB_HTTP_TOKEN: 'fake-http-token',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
    },
  });
  assert.equal(report.ok, true);
  assert.equal(settings.transport, 'http');
  assert.equal(settings.httpHost, HTTP_LOOPBACK_HOST);
  assert.equal(settings.httpPort, 3000);
  assert.equal(settings.httpToken, 'fake-http-token');
});

// --- CC-CFG-4: Windows journal path via %LOCALAPPDATA% ---

test('CC-CFG-4: settings resolves a Windows journal path under %LOCALAPPDATA%', () => {
  const { settings } = loadSettings({
    platform: 'win32',
    homeDir: 'C:\\Users\\Test',
    loadEnvFile: false,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
      LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
    },
  });
  assert.equal(
    settings.journalPath,
    'C:\\Users\\Test\\AppData\\Local\\facebook-mcp\\journal.ndjson',
  );
});

// --- Profiles ---

test('named profiles parse page id + optional token, keyed lowercase', () => {
  const { settings, report } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_APP_SECRET: 's',
      FB_PROFILE_BRANDA_PAGE_ID: '111',
      FB_PROFILE_BRANDA_TOKEN: 'fake-branda-token',
      FB_PROFILE_BRANDB_PAGE_ID: '222',
    },
  });
  assert.equal(report.ok, true);
  assert.deepEqual(settings.profiles, {
    branda: { pageId: '111', tokenOverride: 'fake-branda-token' },
    brandb: { pageId: '222' },
  });
  // FB_PAGE_ID unset but profiles exist ⇒ no 'no-page' warning.
  assert.ok(!codes(report.warnings).includes('no-page'));
});

test('an empty profile page id is an aggregated error', () => {
  const { report } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
      FB_PROFILE_EMPTY_PAGE_ID: '   ',
    },
  });
  assert.equal(report.ok, false);
  assert.ok(codes(report.errors).includes('empty-profile-page-id'));
});

test('missing default Page and no profiles warns (page-scoped tools need a profile)', () => {
  const { report } = loadSettings({
    ...POSIX,
    env: { FB_ACCESS_TOKEN: 'fake', FB_APP_SECRET: 's' },
  });
  assert.equal(report.ok, true);
  assert.ok(codes(report.warnings).includes('no-page'));
});

// --- Lists, numbers, ads ---

test('list-valued vars are split, trimmed and lowercased', () => {
  const { settings } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
      FB_TOOL_PACKAGES: 'core, posts ,READER',
      FB_PACKAGES_DENY: 'ads',
      FB_PACKAGES_READONLY: 'reader,insights',
    },
  });
  assert.deepEqual(settings.toolPackages, ['core', 'posts', 'reader']);
  assert.deepEqual(settings.packagesDeny, ['ads']);
  assert.deepEqual(settings.packagesReadonly, ['reader', 'insights']);
});

test('FB_TOOL_PACKAGES present but empty warns and falls back to the default expansion', () => {
  const { settings, report } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
      FB_TOOL_PACKAGES: ' , , ',
    },
  });
  assert.equal(settings.toolPackages, undefined);
  assert.ok(codes(report.warnings).includes('empty-tool-packages'));
});

test('numeric overrides parse; out-of-range/non-integer values error and fall back', () => {
  const ok = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
      FB_MAX_RESULT_CHARS: '5000',
      FB_HOST_CONCURRENCY: '8',
      FB_REQUEST_TIMEOUT_MS: '15000',
      FB_ADS_BUDGET_CEILING: '250000',
    },
  });
  assert.equal(ok.settings.maxResultChars, 5000);
  assert.equal(ok.settings.hostConcurrency, 8);
  assert.equal(ok.settings.requestTimeoutMs, 15000);
  assert.equal(ok.settings.adsBudgetCeiling, 250000);
  assert.equal(ok.report.ok, true);

  const bad = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
      FB_HOST_CONCURRENCY: '0',
      FB_ADS_BUDGET_CEILING: '-5',
    },
  });
  assert.equal(bad.report.ok, false);
  assert.equal(bad.settings.hostConcurrency, DEFAULT_HOST_CONCURRENCY);
  assert.equal(bad.settings.adsBudgetCeiling, undefined);
  assert.ok(codes(bad.report.errors).filter((c) => c === 'invalid-number').length >= 2);
});

test('missing FB_APP_SECRET warns (appsecret_proof unavailable) but is not an error', () => {
  const { report } = loadSettings({
    ...POSIX,
    env: { FB_ACCESS_TOKEN: 'fake', FB_PAGE_ID: '1' },
  });
  assert.equal(report.ok, true);
  assert.ok(codes(report.warnings).includes('no-app-secret'));
});

// --- Env-first at the settings layer, reading a real env file via process.env ---

test('env-first: a client-passed env value beats the env file at the settings layer', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-set-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.env');
  await writeFile(
    file,
    'FB_ACCESS_TOKEN=from-file\nFB_PAGE_ID=999\nFB_APP_SECRET=file-secret\n',
  );

  await withEnv(
    { FB_ACCESS_TOKEN: 'from-client', FB_PAGE_ID: undefined, FB_APP_SECRET: undefined },
    () => {
      const { settings, report } = loadSettings({ envFilePath: file, loadEnvFile: true });
      assert.equal(report.ok, true);
      assert.equal(settings.accessToken, 'from-client', 'client env wins over the file');
      assert.equal(
        settings.defaultPageId,
        '999',
        'file fills in what the client did not set',
      );
    },
  );
});
