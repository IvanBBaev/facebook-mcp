import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
      FB_HTTP_TOKEN: 'fake-http-token-0123',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
    },
  });
  assert.equal(report.ok, true);
  assert.equal(settings.transport, 'http');
  assert.equal(settings.httpHost, HTTP_LOOPBACK_HOST);
  assert.equal(settings.httpPort, 3000);
  assert.equal(settings.httpToken, 'fake-http-token-0123');
});

test('a too-short FB_HTTP_TOKEN is refused instead of guarding the HTTP transport with it', () => {
  const { settings, report } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_TRANSPORT: 'http',
      FB_HTTP_TOKEN: 'test',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
    },
  });
  // The bearer token is the only credential on the HTTP transport, and any local
  // process can retry it: a four-character value is guessed, not presented. It is
  // also registered as a redaction secret, so every "test" in a log line, a result
  // or the journal would be rewritten to [REDACTED].
  assert.equal(report.ok, false);
  assert.ok(codes(report.errors).includes('weak-http-token'));
  assert.ok(
    !codes(report.errors).includes('http-no-token'),
    'one problem, one report: the weak token is not also called missing',
  );
  assert.equal(settings.httpToken, undefined);
  assert.match(formatStartupReport(report), /FB_HTTP_TOKEN/);
});

test('a too-short FB_HTTP_TOKEN under stdio is dropped with a warning, not a startup failure', () => {
  const { settings, report } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_HTTP_TOKEN: 'test',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
    },
  });
  // stdio never reads the token, so refusing to start would punish a leftover
  // value; dropping it keeps it out of the redactor's secret list all the same.
  assert.equal(report.ok, true);
  assert.ok(codes(report.warnings).includes('weak-http-token'));
  assert.equal(settings.httpToken, undefined);
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

// --- Operator-supplied filesystem paths (FB_JOURNAL_PATH, FB_MEDIA_DIR) ---

test('a leading ~ in FB_JOURNAL_PATH / FB_MEDIA_DIR names the home directory, not a literal "~" dir', () => {
  // No shell ever sees these values: an MCP client's JSON `env` block and the
  // env file both hand "~/…" over verbatim. Kept literal, it named a directory
  // called "~" under whatever cwd the client spawned the server in.
  const { settings, report } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
      FB_JOURNAL_PATH: '~/fb/journal.ndjson',
      FB_MEDIA_DIR: '~',
    },
  });
  assert.deepEqual(report.problems, []);
  assert.equal(settings.journalPath, '/home/t/fb/journal.ndjson');
  assert.equal(settings.mediaDir, '/home/t');
});

test('a leading ~\\ on Windows names the home directory too', () => {
  const { settings, report } = loadSettings({
    platform: 'win32',
    homeDir: 'C:\\Users\\Test',
    loadEnvFile: false,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
      FB_JOURNAL_PATH: '~\\fb\\journal.ndjson',
      FB_MEDIA_DIR: '~/Pictures',
    },
  });
  assert.deepEqual(report.problems, []);
  assert.equal(settings.journalPath, 'C:\\Users\\Test\\fb\\journal.ndjson');
  assert.equal(settings.mediaDir, 'C:\\Users\\Test\\Pictures');
});

test('a relative FB_JOURNAL_PATH is warned about and replaced by the default journal path', () => {
  const { settings, report } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
      FB_JOURNAL_PATH: 'logs/journal.ndjson',
    },
  });
  assert.equal(report.ok, true);
  assert.deepEqual(codes(report.warnings), ['relative-journal-path']);
  assert.equal(report.warnings[0]?.field, 'FB_JOURNAL_PATH');
  assert.equal(settings.journalPath, '/home/t/.local/state/facebook-mcp/journal.ndjson');
});

test('a relative FB_MEDIA_DIR is refused, never allowlisted against the cwd', () => {
  // "." under a client that spawns the server with cwd "/" would allowlist the
  // whole filesystem for uploads.
  for (const value of ['.', 'media', 'C:media']) {
    const { settings, report } = loadSettings({
      ...POSIX,
      ...(value.startsWith('C:')
        ? { platform: 'win32' as const, homeDir: 'C:\\Users\\Test' }
        : {}),
      env: {
        FB_ACCESS_TOKEN: 'fake',
        FB_APP_SECRET: 's',
        FB_PAGE_ID: '1',
        FB_MEDIA_DIR: value,
      },
    });
    assert.equal(report.ok, false, value);
    assert.deepEqual(codes(report.errors), ['relative-media-dir'], value);
    assert.equal(settings.mediaDir, undefined, value);
  }
});

test('absolute FB_JOURNAL_PATH / FB_MEDIA_DIR pass through verbatim (regression coverage)', () => {
  const { settings, report } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
      FB_JOURNAL_PATH: '/var/lib/fb/journal.ndjson',
      FB_MEDIA_DIR: '/srv/media/~x',
    },
  });
  assert.deepEqual(report.problems, []);
  assert.equal(settings.journalPath, '/var/lib/fb/journal.ndjson');
  assert.equal(settings.mediaDir, '/srv/media/~x');
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

test('the reserved "default" profile name is refused, not silently shadowed', () => {
  const { settings, report } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
      FB_PROFILE_DEFAULT_PAGE_ID: '999',
    },
  });
  // The registry mints key "default" for FB_PAGE_ID and an exact key match wins,
  // so this profile could never be selected — writes meant for 999 would go to 1.
  assert.equal(report.ok, false);
  assert.ok(codes(report.errors).includes('reserved-profile-name'));
  assert.deepEqual(settings.profiles, {});
});

test('a profile named __proto__ is refused, not silently swallowed as a prototype', () => {
  const { settings, report } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
      FB_PROFILE___proto___PAGE_ID: '555',
    },
  });
  // Assigning out['__proto__'] replaces the object's prototype instead of adding
  // a key: the profile vanished with no startup problem reported.
  assert.equal(report.ok, false);
  assert.ok(codes(report.errors).includes('reserved-profile-name'));
  assert.equal(Object.getPrototypeOf(settings.profiles), Object.prototype);
});

test('two spellings of one profile name are refused, and neither survives', () => {
  const { settings, report } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
      FB_PROFILE_Acme_PAGE_ID: '111',
      FB_PROFILE_ACME_PAGE_ID: '222',
      FB_PROFILE_OTHER_PAGE_ID: '333',
    },
  });
  // Keys are case-insensitive: keeping either one would point `profile: "acme"`
  // at a Page chosen by env enumeration order.
  assert.equal(report.ok, false);
  assert.ok(codes(report.errors).includes('duplicate-profile-name'));
  assert.deepEqual(settings.profiles, { other: { pageId: '333' } });
});

test('a profile token var is matched case-insensitively, like the profile name', () => {
  const { settings, report } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
      FB_PROFILE_Acme_PAGE_ID: '111',
      FB_PROFILE_ACME_TOKEN: 'fake-acme-token',
    },
  });
  // The two vars differ only in case, and profile names are case-insensitive
  // everywhere else here, so this is one profile with one configured token.
  // Matching the page-id var's exact spelling dropped it without a word and left
  // the profile deriving a Page token from the base credential instead.
  assert.equal(report.ok, true);
  assert.deepEqual(settings.profiles, {
    acme: { pageId: '111', tokenOverride: 'fake-acme-token' },
  });
});

test('two spellings of one profile token var are refused, and neither is used', () => {
  const { settings, report } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
      FB_PROFILE_ACME_PAGE_ID: '111',
      FB_PROFILE_ACME_TOKEN: 'fake-token-a',
      FB_PROFILE_Acme_TOKEN: 'fake-token-b',
    },
  });
  // Picking one would make the profile act with a credential chosen by env
  // enumeration order — the same reasoning as duplicate-profile-name.
  assert.equal(report.ok, false);
  assert.ok(codes(report.errors).includes('duplicate-profile-token'));
  assert.deepEqual(settings.profiles, { acme: { pageId: '111' } });
});

test('a profile token var with no matching profile page id is reported, not silently dropped', () => {
  const { settings, report } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
      FB_PROFILE_ACME_PAGE_ID: '111',
      // The natural misspelling of FB_PROFILE_ACME_TOKEN: it parses as the token
      // of a profile named "acme_page", which has no page id.
      FB_PROFILE_ACME_PAGE_TOKEN: 'fake-acme-token',
    },
  });
  // Without a word, "acme" runs with no token override and derives a Page token
  // from the base credential — the one the operator configured it not to use.
  assert.deepEqual(settings.profiles, { acme: { pageId: '111' } });
  const orphan = report.warnings.find((p) => p.code === 'orphan-profile-token');
  assert.ok(
    orphan,
    `expected orphan-profile-token, got: ${codes(report.problems).join(', ')}`,
  );
  assert.equal(orphan.field, 'FB_PROFILE_ACME_PAGE_TOKEN');
  assert.ok(orphan.message.includes('FB_PROFILE_ACME_PAGE_PAGE_ID'), orphan.message);
  assert.ok(!orphan.message.includes('fake-acme-token'), 'the secret is never echoed');
});

test('regression: a profile token next to its page id (any case) is not an orphan', () => {
  const { report } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
      FB_PROFILE_Acme_PAGE_ID: '111',
      FB_PROFILE_ACME_TOKEN: 'fake-acme-token',
    },
  });
  assert.ok(!codes(report.problems).includes('orphan-profile-token'));
});

test('a profile name with an underscore is accepted, like the README documents', () => {
  const { settings, report } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
      FB_PROFILE_BRAND_A_PAGE_ID: '111',
      FB_PROFILE_BRAND_A_TOKEN: 'fake-brand-a-token',
    },
  });
  // `FB_PROFILE_BRAND_A_PAGE_ID` is the README's own example, and the underscore
  // is how anyone spells a two-word Page name in an env var. Refusing it made the
  // documented config an error-severity problem, and startup is fail-closed
  // (index calls assertStartupOk) — the server would not boot on its own README.
  assert.equal(report.ok, true, formatStartupReport(report));
  assert.deepEqual(settings.profiles, {
    brand_a: { pageId: '111', tokenOverride: 'fake-brand-a-token' },
  });
});

test('missing default Page and no profiles warns (page-scoped tools need a profile)', () => {
  const { report } = loadSettings({
    ...POSIX,
    env: { FB_ACCESS_TOKEN: 'fake', FB_APP_SECRET: 's' },
  });
  assert.equal(report.ok, true);
  assert.ok(codes(report.warnings).includes('no-page'));
});

// --- FB_PAGE_TOKEN binding: a Page token is the credential of exactly one Page ---

test('FB_PAGE_TOKEN alone with no FB_PAGE_ID warns that the Page token is bound to no Page', () => {
  const { report } = loadSettings({
    ...POSIX,
    env: { FB_PAGE_TOKEN: 'fake-page-token', FB_APP_SECRET: 's' },
  });
  // The credential check is satisfied by FB_PAGE_TOKEN, but FB_PAGE_ID is the
  // only setting that names the Page it belongs to (the registry installs the
  // override under FB_PAGE_ID and nowhere else). Without it the token is bound
  // to nothing: no Page-scoped call can resolve, and the per-call error then
  // tells the operator to "provide" the very token they set. A warning, not an
  // error — the token still serves credential-level calls (/me, the doctor).
  assert.equal(report.ok, true, formatStartupReport(report));
  const unbound = report.warnings.find((p) => p.code === 'page-token-unbound');
  assert.ok(
    unbound,
    `expected page-token-unbound, got: ${codes(report.problems).join(', ')}`,
  );
  assert.equal(unbound.field, 'FB_PAGE_ID');
  // Both ways out are named: bind the token, or let a base token derive one.
  assert.match(unbound.message, /FB_PAGE_ID/);
  assert.match(unbound.message, /facebook_whoami/);
  assert.match(unbound.message, /FB_SYSTEM_TOKEN/);
  assert.match(unbound.message, /FB_ACCESS_TOKEN/);
  assert.ok(!unbound.message.includes('fake-page-token'), 'the token never appears');
  assert.match(formatStartupReport(report), /\[page-token-unbound\]/);
});

test('FB_PAGE_TOKEN with a profile but no FB_PAGE_ID still warns unbound (no-page is silent)', () => {
  const { report } = loadSettings({
    ...POSIX,
    env: {
      FB_PAGE_TOKEN: 'fake-page-token',
      FB_APP_SECRET: 's',
      FB_PROFILE_BRANDA_PAGE_ID: '111',
    },
  });
  // A profile Page takes FB_PROFILE_<NAME>_TOKEN, never FB_PAGE_TOKEN, so the
  // profile satisfies `no-page` without giving this token a Page. This is the
  // configuration where nothing at all used to fire at the settings level.
  assert.equal(report.ok, true, formatStartupReport(report));
  assert.ok(!codes(report.warnings).includes('no-page'));
  assert.ok(codes(report.warnings).includes('page-token-unbound'));
});

test('regression: FB_PAGE_TOKEN bound to FB_PAGE_ID draws no page-token-unbound warning', () => {
  const { report } = loadSettings({
    ...POSIX,
    env: { FB_PAGE_TOKEN: 'fake-page-token', FB_PAGE_ID: '100', FB_APP_SECRET: 's' },
  });
  assert.equal(report.ok, true, formatStartupReport(report));
  assert.ok(!codes(report.warnings).includes('page-token-unbound'));
});

test('regression: FB_PAGE_TOKEN next to a base token is shadowed, not unbound — no page-token-unbound', () => {
  const { report } = loadSettings({
    ...POSIX,
    env: {
      FB_SYSTEM_TOKEN: 'fake-sys',
      FB_PAGE_TOKEN: 'fake-page-token',
      FB_APP_SECRET: 's',
    },
  });
  // With a base token the resolver never installs FB_PAGE_TOKEN, FB_PAGE_ID or
  // not (CC-AUTH-9) — so "set FB_PAGE_ID" would be false advice here. That
  // token is *shadowed*, which the doctor already reports on its own line.
  assert.equal(report.ok, true, formatStartupReport(report));
  assert.ok(!codes(report.warnings).includes('page-token-unbound'));
  assert.ok(
    codes(report.warnings).includes('no-page'),
    'the generic no-page warning still applies',
  );
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

test('FB_TOOL_PACKAGES set to the empty string warns instead of silently defaulting', () => {
  const { settings, report } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
      FB_TOOL_PACKAGES: '',
    },
  });
  // `FB_TOOL_PACKAGES=` is a configured value, not an absent one: the operator
  // meant to restrict the surface and got the full default expansion instead,
  // with nothing in the startup report to say so.
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

// --- Out-of-band confirmation token (B1 / CC-MCP-6) ---

test('a too-short FB_CONFIRM_TOKEN is refused instead of arming the gate with it', () => {
  const { settings, report } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
      FB_CONFIRM_TOKEN: '1',
    },
  });
  // Nothing rate-limits `confirm_token`, and the party retrying it is the model
  // the gate exists to restrain: a one-character secret is guessed on the first
  // call, so the gate reported itself armed while authorizing every irreversible
  // apply. Refused loudly, and the value dropped so the gate denies meanwhile.
  assert.equal(report.ok, false);
  assert.ok(codes(report.errors).includes('weak-confirm-token'));
  assert.equal(settings.confirmToken, undefined);
  assert.match(formatStartupReport(report), /FB_CONFIRM_TOKEN/);
});

test('regression: a long-enough FB_CONFIRM_TOKEN is kept verbatim', () => {
  const { settings, report } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
      FB_CONFIRM_TOKEN: 'operator-confirm-token-4d3c2b1a',
    },
  });
  assert.equal(report.ok, true);
  assert.equal(settings.confirmToken, 'operator-confirm-token-4d3c2b1a');
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

test('an unreadable env file is reported, not swallowed behind "no access token"', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-set-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // A directory where the env file should be makes dotenv's read fail with
  // EISDIR — a portable stand-in for the real cases (an EACCES `.env` left
  // root-owned by a `sudo` run, a broken mount under the config dir).
  const file = path.join(dir, '.env');
  await mkdir(file);

  await withEnv(
    {
      FB_ACCESS_TOKEN: undefined,
      FB_SYSTEM_TOKEN: undefined,
      FB_PAGE_TOKEN: undefined,
    },
    () => {
      const { report } = loadSettings({ envFilePath: file, loadEnvFile: true });
      // Without this the operator is told to set FB_ACCESS_TOKEN — which they
      // did, in the file the server could not read and never mentioned.
      assert.ok(
        codes(report.warnings).includes('env-file-unreadable'),
        `expected an env-file problem, got: ${codes(report.problems).join(', ')}`,
      );
      assert.ok(formatStartupReport(report).includes(file), 'the path is named');
    },
  );
});

// --- Unknown FB_* variables (a misspelt setting is silently ignored) ---

test('a misspelt FB_* setting is reported by name, with the setting it resembles', () => {
  const { settings, report } = loadSettings({
    ...POSIX,
    env: {
      FB_SYSTEM_TOKEN: 'fake-system-token',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
      // Each of these is read by nothing: without a word, the ads tools run
      // with no budget ceiling and the operator believes one is enforced.
      FB_ACESS_TOKEN: 'fake-typo-token-value',
      FB_ADS_BUDGET_CEILNG: '5000',
    },
  });
  assert.equal(settings.adsBudgetCeiling, undefined);
  const unknown = report.warnings.filter((p) => p.code === 'unknown-setting');
  assert.deepEqual(
    unknown.map((p) => p.field).sort(),
    ['FB_ACESS_TOKEN', 'FB_ADS_BUDGET_CEILNG'],
    `expected unknown-setting warnings, got: ${codes(report.problems).join(', ')}`,
  );
  const typo = unknown.find((p) => p.field === 'FB_ACESS_TOKEN');
  assert.ok(typo?.message.includes('FB_ACCESS_TOKEN'), typo?.message);
  const ceiling = unknown.find((p) => p.field === 'FB_ADS_BUDGET_CEILNG');
  assert.ok(ceiling?.message.includes('FB_ADS_BUDGET_CEILING'), ceiling?.message);
  assert.ok(
    !formatStartupReport(report).includes('fake-typo-token-value'),
    'the value of an unknown variable is never echoed',
  );
});

test('a misspelt profile variable is reported rather than silently dropped', () => {
  const { settings, report } = loadSettings({
    ...POSIX,
    env: {
      FB_ACCESS_TOKEN: 'fake',
      FB_APP_SECRET: 's',
      FB_PAGE_ID: '1',
      FB_PROFILE_ACME_PAGEID: '111',
    },
  });
  assert.deepEqual(settings.profiles, {});
  const unknown = report.warnings.find((p) => p.code === 'unknown-setting');
  assert.equal(unknown?.field, 'FB_PROFILE_ACME_PAGEID');
  assert.match(unknown.message, /FB_PROFILE_<NAME>_PAGE_ID/);
});

test('regression: every documented FB_* variable, profile vars, tooling vars and blank unknowns raise no unknown-setting warning', () => {
  const { report } = loadSettings({
    ...POSIX,
    env: {
      FB_APP_ID: '1',
      FB_APP_SECRET: 's',
      FB_ACCESS_TOKEN: 'fake',
      FB_SYSTEM_TOKEN: 'fake2',
      FB_PAGE_TOKEN: 'fake3',
      FB_PAGE_ID: '1',
      FB_PROFILE_ACME_PAGE_ID: '2',
      FB_PROFILE_ACME_TOKEN: 'fake4',
      FB_API_VERSION: 'v23.0',
      FB_REQUEST_TIMEOUT_MS: '1000',
      FB_HOST_CONCURRENCY: '2',
      FB_WRITE_MODE: 'plan',
      FB_MEDIA_DIR: '/srv/media',
      FB_MAX_RESULT_CHARS: '5000',
      FB_TRANSPORT: 'stdio',
      FB_HTTP_TOKEN: 'http-token-0123456789abcdef',
      FB_HTTP_PORT: '3000',
      FB_TOOL_PACKAGES: 'core',
      FB_PACKAGES_DENY: 'ads',
      FB_PACKAGES_READONLY: 'posts',
      FB_JOURNAL_PATH: '/var/lib/fb/journal.ndjson',
      FB_LOG_LEVEL: 'info',
      FB_AD_ACCOUNT_ID: 'act_1',
      FB_ADS_BUDGET_CEILING: '100',
      FB_CONFIRM_TOKEN: 'operator-confirm-token-4d3c2b1a',
      FB_SETUP_TOKEN: 'fake5',
      FB_SMOKE: '1',
      FB_SMOKE_PAGE_ID: '3',
      FB_RECORD_FIXTURE: '1',
      FB_SOMETHING_BLANK: '  ',
      NOT_FB_VAR: 'x',
    },
  });
  assert.ok(
    !codes(report.problems).includes('unknown-setting'),
    report.problems
      .filter((p) => p.code === 'unknown-setting')
      .map((p) => p.message)
      .join('\n'),
  );
});
