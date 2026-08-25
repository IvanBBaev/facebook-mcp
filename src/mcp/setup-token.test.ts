// Tests for the guided `setup-token` onboarding subcommand (task R05):
// argument/env parsing (including the process-list advisory), token
// classification refusals, the two-tier scope check, the long-lived exchange,
// Page discovery + Page-token derivation, the atomic 0600 env-file write with
// its overwrite guard, and the text renderer.
//
// Every Graph call is served by `createFakeFbRequest` (a network fence throws on
// any real fetch), the env-file write is an injected seam except for one
// POSIX-only test that exercises the real `atomicWriteFile` in a temp dir, and
// all tokens are short placeholders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createFakeClock,
  createFakeFbRequest,
  createFakeRedactor,
  fbErr,
  fbOk,
  type FakeFbRequest,
} from '../core/fakes/index.js';
import type {
  AtomicWriteResult,
  FbRequest,
  JsonRequest,
  LogFields,
  Logger,
  Settings,
} from '../core/index.js';
import { withEnv } from '../testing/index.js';
import {
  parseSetupTokenArgs,
  renderSetupTokenReport,
  runSetupToken,
  SETUP_NEXT_COMMAND,
  SETUP_TOKEN_ENV_VAR,
  SYSTEM_USER_GUIDANCE,
  type SetupStepId,
  type SetupTokenDeps,
  type SetupTokenInput,
  type SetupTokenResult,
  type SetupTokenStep,
} from './setup-token.js';

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

/** Placeholder tokens — deliberately short and unrealistic (fixture lint). */
const PASTED = 'EAA-pasted';
const LONG_LIVED = 'EAA-long-lived';
const PAGE_TOKEN = 'EAA-page';
/**
 * The app secret is the OTHER credential this flow handles — it signs the
 * long-lived exchange. Distinct from the `FB_APP_SECRET` key name so a report
 * that merely NAMES the variable does not read as a leak of its value.
 */
const APP_SECRET = 'sekrit-appsecret-value';

const ENV_PATH = '/virtual/config/facebook-mcp/.env';

function makeLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

interface LogEntry {
  readonly msg: string;
  readonly fields?: LogFields;
}

/** A logger that keeps every record, so a test can prove what was NOT logged. */
function recordingLogger(entries: LogEntry[]): Logger {
  const record = (msg: string, fields?: LogFields): void => {
    entries.push({ msg, ...(fields !== undefined ? { fields } : {}) });
  };
  return { debug: record, info: record, warn: record, error: record };
}

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    appId: '1234567890',
    appSecret: APP_SECRET,
    profiles: {},
    apiVersion: 'v23.0',
    hosts: {
      graph: 'graph.facebook.com',
      graphVideo: 'graph-video.facebook.com',
      rupload: 'rupload.facebook.com',
    },
    requestTimeoutMs: 30_000,
    hostConcurrency: 4,
    writeMode: 'plan',
    maxResultChars: 25_000,
    transport: 'stdio',
    packagesDeny: [],
    packagesReadonly: [],
    journalPath: '/tmp/journal.ndjson',
    logLevel: 'info',
    ...overrides,
  };
}

function makeInput(overrides: Partial<SetupTokenInput> = {}): SetupTokenInput {
  return {
    token: PASTED,
    tokenSource: 'env',
    write: true,
    force: false,
    notes: [],
    ...overrides,
  };
}

interface Written {
  path: string;
  contents: string;
}

interface SetupParts {
  readonly fb: FakeFbRequest;
  readonly deps: SetupTokenDeps;
  /** Every env-file write the run performed (empty ⇒ nothing was written). */
  readonly writes: Written[];
}

function makeDeps(
  opts: {
    settings?: Settings;
    input?: Partial<SetupTokenInput>;
    nowMs?: number;
    fileExists?: boolean;
    writeError?: Error;
  } = {},
): SetupParts {
  const fb = createFakeFbRequest();
  const writes: Written[] = [];
  const deps: SetupTokenDeps = {
    fbRequest: fb.fn,
    settings: opts.settings ?? makeSettings(),
    clock: createFakeClock(opts.nowMs ?? 1_000_000),
    logger: makeLogger(),
    redactor: createFakeRedactor(),
    input: makeInput(opts.input),
    envFilePath: ENV_PATH,
    fileExists: () => Promise.resolve(opts.fileExists ?? false),
    writeEnvFile: (filePath, contents): Promise<AtomicWriteResult> => {
      if (opts.writeError) return Promise.reject(opts.writeError);
      writes.push({ path: filePath, contents });
      return Promise.resolve({ path: filePath, restricted: true, mode: 0o600 });
    },
  };
  return { fb, deps, writes };
}

/** Program `/debug_token` with a normalized payload. */
function withDebugToken(fb: FakeFbRequest, data: Record<string, unknown>): void {
  fb.on((req) => req.path === '/debug_token', fbOk({ data }));
}

/** Program the happy path: valid USER token, successful exchange, one Page. */
function withHappyPath(
  fb: FakeFbRequest,
  opts: { scopes?: readonly string[]; pages?: readonly Record<string, unknown>[] } = {},
): void {
  withDebugToken(fb, {
    type: 'USER',
    is_valid: true,
    app_id: '1234567890',
    scopes: opts.scopes ?? ['pages_show_list', 'pages_read_engagement'],
    expires_at: 1200,
    user_id: '42',
  });
  fb.on(
    (req) => req.path === '/oauth/access_token',
    fbOk({ access_token: LONG_LIVED, expires_in: 5_184_000 }),
  );
  fb.on(
    (req) => req.path === '/me/accounts',
    fbOk({
      data: opts.pages ?? [
        {
          id: '111',
          name: 'Acme Page',
          category: 'Software',
          tasks: ['MANAGE'],
          access_token: PAGE_TOKEN,
        },
      ],
    }),
  );
}

function isJson(req: FbRequest): req is JsonRequest {
  return req.protocol === 'json';
}

/** Query params of a captured JSON request (the union also holds multipart). */
function paramsOf(req: FbRequest): Readonly<Record<string, unknown>> {
  assert.ok(isJson(req), 'expected a JSON request');
  return req.params ?? {};
}

function step(result: SetupTokenResult, id: SetupStepId): SetupTokenStep {
  const found = result.steps.find((s) => s.id === id);
  assert.ok(found, `expected a ${id} step`);
  return found;
}

/** No token value may appear in the result or the rendered report. */
function assertNoSecrets(result: SetupTokenResult): void {
  const haystack = `${JSON.stringify(result)}\n${renderSetupTokenReport(result)}`;
  // The app secret belongs in this sweep too: `runSetupToken` signs the
  // long-lived exchange with it, so it is live in the same call frames as the
  // tokens — and a report that echoed a failing request URL would carry it.
  for (const secret of [PASTED, LONG_LIVED, PAGE_TOKEN, APP_SECRET]) {
    assert.equal(
      haystack.includes(secret),
      false,
      `token value ${secret} leaked into the result/report`,
    );
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

test('reads the token from the environment without a process-list warning', () => {
  const input = parseSetupTokenArgs([], { [SETUP_TOKEN_ENV_VAR]: `  ${PASTED} ` });

  assert.equal(input.token, PASTED);
  assert.equal(input.tokenSource, 'env');
  assert.equal(input.write, true);
  assert.equal(input.force, false);
  assert.deepEqual(input.notes, []);
});

test('a command-line token wins over the env var but is flagged as visible in `ps`', () => {
  const input = parseSetupTokenArgs([PASTED], { [SETUP_TOKEN_ENV_VAR]: 'EAA-other' });

  assert.equal(input.token, PASTED);
  assert.equal(input.tokenSource, 'argument');
  assert.ok(input.notes.some((n) => n.includes('process list')));
  assert.ok(input.notes.some((n) => n.includes(SETUP_TOKEN_ENV_VAR)));
});

test('parses --page, --env-file, --force and --no-write, noting unknown options', () => {
  const input = parseSetupTokenArgs(
    ['--page=111', '--env-file=/tmp/x.env', '--force', '--no-write', '--wat'],
    { [SETUP_TOKEN_ENV_VAR]: PASTED },
  );

  assert.equal(input.pageId, '111');
  assert.equal(input.envFilePath, '/tmp/x.env');
  assert.equal(input.force, true);
  assert.equal(input.write, false);
  assert.ok(input.notes.some((n) => n.includes('--wat')));
});

test('an unknown option is echoed by name only — never its value', () => {
  // `--token=…` is the flag an operator reaches for before finding the positional
  // form; it is not supported, so it lands on the unknown-option path. The note it
  // produces is rendered into the report, which must never carry a token value.
  const input = parseSetupTokenArgs(['--token=EAAsecretvalue', '--secret=hunter2'], {});

  assert.equal(input.tokenSource, 'none', 'an unknown option is not a token source');
  assert.deepEqual(
    input.notes.map((n) => n.slice(0, n.indexOf('. Supported'))),
    ['Ignored unknown option "--token"', 'Ignored unknown option "--secret"'],
  );
  for (const note of input.notes) {
    assert.doesNotMatch(note, /EAAsecretvalue|hunter2/);
  }
});

test('reports tokenSource "none" when nothing was supplied', () => {
  const input = parseSetupTokenArgs([], {});
  assert.equal(input.token, undefined);
  assert.equal(input.tokenSource, 'none');
});

test('--dry-run is an alias for --no-write', () => {
  assert.equal(parseSetupTokenArgs(['--dry-run'], {}).write, false);
});

test('treats blank values as absent: whitespace token, --page= and --env-file=', () => {
  const input = parseSetupTokenArgs(['   ', '--page=', '--env-file=   '], {
    [SETUP_TOKEN_ENV_VAR]: '  ',
  });

  assert.equal(input.token, undefined);
  assert.equal(input.tokenSource, 'none');
  assert.equal(input.pageId, undefined, 'an empty --page= must not pin Page ""');
  assert.equal(input.envFilePath, undefined, 'an empty --env-file= keeps the default');
  assert.deepEqual(
    input.notes,
    [],
    'a blank argument is not a token, so no `ps` advisory',
  );
});

// ---------------------------------------------------------------------------
// Input + classification refusals
// ---------------------------------------------------------------------------

test('refuses without a token and makes no Graph call at all', async () => {
  const { fb, deps } = makeDeps({ input: { token: undefined, tokenSource: 'none' } });

  const result = await runSetupToken(deps);

  assert.equal(result.ok, false);
  assert.equal(fb.calls.length, 0);
  assert.equal(step(result, 'input').status, 'failed');
  assert.match(step(result, 'input').detail ?? '', /Graph API Explorer/);
  assert.equal(result.write.status, 'skipped');
});

test('registers the pasted token with the redactor before any Graph call', async () => {
  const { fb, deps } = makeDeps();
  const redactor = createFakeRedactor();
  withHappyPath(fb);

  await runSetupToken({ ...deps, redactor });

  assert.ok(redactor.secrets.includes(PASTED), 'pasted token was not registered');
  assert.ok(redactor.secrets.includes(LONG_LIVED), 'long-lived token was not registered');
  assert.ok(redactor.secrets.includes(PAGE_TOKEN), 'Page token was not registered');
});

test('refuses a Page token with the direct FB_PAGE_TOKEN instruction', async () => {
  const { fb, deps } = makeDeps();
  withDebugToken(fb, { type: 'PAGE', is_valid: true, scopes: ['pages_show_list'] });

  const result = await runSetupToken(deps);

  assert.equal(result.ok, false);
  assert.equal(step(result, 'classify').status, 'failed');
  assert.match(step(result, 'classify').detail ?? '', /FB_PAGE_TOKEN/);
  assert.equal(fb.calls.length, 1, 'must stop before the exchange');
});

test('never hands a token value to the logger', async () => {
  const { fb, deps } = makeDeps();
  withHappyPath(fb, { pages: [{ id: '111', name: 'Acme Page' }] });
  fb.on((req) => req.path === '/111', fbOk({ access_token: PAGE_TOKEN }));
  const entries: LogEntry[] = [];

  await runSetupToken({ ...deps, logger: recordingLogger(entries) });

  assert.ok(entries.length > 0, 'the flow logs at least once');
  // Defence in depth: the redactor is the safety net, but setup-token itself
  // must never pass a token value to a log message or field in the first place.
  const logged = JSON.stringify(entries);
  for (const secret of [PASTED, LONG_LIVED, PAGE_TOKEN]) {
    assert.equal(logged.includes(secret), false, `token ${secret} reached the logger`);
  }
  assert.deepEqual(entries[0], {
    msg: 'setup-token: token received',
    fields: { source: 'env' },
  });
});

test('refuses an App token by name and stops before the exchange', async () => {
  const { deps, fb } = makeDeps();
  withDebugToken(fb, { type: 'APP', is_valid: true, scopes: [] });

  const result = await runSetupToken(deps);

  assert.equal(result.ok, false);
  assert.equal(step(result, 'classify').status, 'failed');
  assert.equal(step(result, 'classify').summary, 'unsupported token type APP');
  assert.match(
    step(result, 'classify').detail ?? '',
    /App token \(`\{app-id}\|\{app-secret}`\)/,
  );
  assert.equal(fb.calls.length, 1, 'must stop before the exchange');
  assert.equal(result.write.status, 'skipped');
});

test('refuses an expired/invalid token and explains the 1-2 hour Explorer lifetime', async () => {
  const { deps, fb } = makeDeps();
  withDebugToken(fb, { type: 'USER', is_valid: false, scopes: [] });

  const result = await runSetupToken(deps);

  assert.equal(result.ok, false);
  assert.equal(result.token.valid, false);
  assert.match(step(result, 'classify').detail ?? '', /1–2 hours/);
});

test('refuses a token missing pages_show_list, naming the scope', async () => {
  const { deps, fb } = makeDeps();
  withDebugToken(fb, {
    type: 'USER',
    is_valid: true,
    scopes: ['pages_read_engagement'],
  });

  const result = await runSetupToken(deps);

  assert.equal(result.ok, false);
  assert.deepEqual(result.missingRequiredScopes, ['pages_show_list']);
  assert.match(step(result, 'classify').summary, /pages_show_list/);
  assert.equal(result.write.status, 'skipped');
  assert.match(
    renderSetupTokenReport(result),
    /MISSING: pages_show_list \(setup-blocking\)/,
  );
});

test('an unknown FB_TOOL_PACKAGES entry falls back to the default profile', async () => {
  const { deps, fb } = makeDeps({
    settings: makeSettings({ toolPackages: ['core', 'not-a-package'] }),
  });
  withHappyPath(fb, { scopes: ['pages_show_list'] });

  const result = await runSetupToken(deps);

  // An invalid selection is the startup report's problem: setup still runs and
  // cross-references the DEFAULT profile rather than silently checking nothing.
  assert.equal(result.ok, true);
  const scopes = result.missingPackageScopes.map((m) => m.scope);
  assert.ok(scopes.includes('pages_manage_posts'), 'posts is in the default profile');
  assert.equal(scopes.includes('ads_read'), false, 'ads is NOT in the default profile');
  assert.deepEqual(
    result.missingPackageScopes.find((m) => m.scope === 'read_insights')?.packages,
    ['insights'],
  );
});

test('warns (but proceeds) for a package scope, naming scope and package', async () => {
  const { deps, fb } = makeDeps({
    settings: makeSettings({ toolPackages: ['core', 'posts'] }),
  });
  withHappyPath(fb, { scopes: ['pages_show_list', 'pages_read_engagement'] });

  const result = await runSetupToken(deps);

  assert.equal(result.ok, true);
  const missing = result.missingPackageScopes.find(
    (m) => m.scope === 'pages_manage_posts',
  );
  assert.ok(missing, 'expected pages_manage_posts to be reported as missing');
  assert.deepEqual(missing.packages, ['posts']);
  assert.ok(
    result.warnings.some((w) => w.includes('pages_manage_posts') && w.includes('posts')),
  );
});

test('reports a debug_token failure instead of throwing, with a redacted message', async () => {
  const { deps, fb } = makeDeps();
  fb.on((req) => req.path === '/debug_token', fbErr(new Error(`boom ${PASTED}`)));

  const result = await runSetupToken(deps);

  assert.equal(result.ok, false);
  assert.equal(step(result, 'classify').status, 'failed');
  assert.equal(result.token.error?.includes(PASTED), false);
  assert.match(result.token.error ?? '', /\[REDACTED]/);
});

// ---------------------------------------------------------------------------
// Exchange
// ---------------------------------------------------------------------------

test('exchanges the short-lived token and reports the ~60 day expiry honestly', async () => {
  const now = 1_000_000;
  const { deps, fb } = makeDeps({ nowMs: now });
  withHappyPath(fb);

  const result = await runSetupToken(deps);

  const exchangeCall = fb.calls.find((c) => c.path === '/oauth/access_token');
  assert.ok(exchangeCall);
  const params = paramsOf(exchangeCall);
  assert.equal(params['grant_type'], 'fb_exchange_token');
  assert.equal(params['client_id'], '1234567890');
  assert.equal(params['fb_exchange_token'], PASTED);

  assert.equal(result.exchange?.performed, true);
  assert.equal(result.exchange?.envKey, 'FB_ACCESS_TOKEN');
  assert.equal(result.exchange?.expiresAt, now + 5_184_000 * 1000);
  assert.equal(result.exchange?.expiresInDays, 60);
  assert.equal(result.exchange?.neverExpiring, false);
  assert.match(renderSetupTokenReport(result), /System-User token is the ONLY/);
});

test('refuses to write when the app secret is missing (a 1-hour token is useless)', async () => {
  const { deps, fb } = makeDeps({
    settings: makeSettings({ appSecret: undefined }),
  });
  withHappyPath(fb);

  const result = await runSetupToken(deps);

  assert.equal(result.ok, false);
  assert.equal(step(result, 'exchange').status, 'failed');
  assert.match(step(result, 'exchange').detail ?? '', /FB_APP_SECRET/);
  assert.equal(result.write.status, 'skipped');
  assert.equal(
    fb.calls.some((c) => c.path === '/oauth/access_token'),
    false,
  );
});

test('reports an exchange that returned no access_token and writes nothing', async () => {
  const { deps, fb, writes } = makeDeps();
  withDebugToken(fb, { type: 'USER', is_valid: true, scopes: ['pages_show_list'] });
  fb.on((req) => req.path === '/oauth/access_token', fbOk({ expires_in: 5_184_000 }));

  const result = await runSetupToken(deps);

  assert.equal(result.ok, false);
  assert.equal(step(result, 'exchange').status, 'failed');
  assert.equal(step(result, 'exchange').summary, 'Graph returned no long-lived token');
  assert.match(step(result, 'exchange').detail ?? '', /FB_APP_ID \/ FB_APP_SECRET/);
  assert.equal(result.write.status, 'skipped');
  assert.equal(writes.length, 0);
  assert.equal(
    fb.calls.some((c) => c.path === '/me/accounts'),
    false,
    'must not list Pages with a token it never received',
  );
});

test('warns when Graph reports no expiry for the exchanged token', async () => {
  const { deps, fb } = makeDeps();
  withDebugToken(fb, { type: 'USER', is_valid: true, scopes: ['pages_show_list'] });
  fb.on((req) => req.path === '/oauth/access_token', fbOk({ access_token: LONG_LIVED }));
  fb.on(
    (req) => req.path === '/me/accounts',
    fbOk({ data: [{ id: '111', name: 'Acme Page', access_token: PAGE_TOKEN }] }),
  );

  const result = await runSetupToken(deps);

  assert.equal(result.ok, true, 'an unreported expiry is a warning, never a refusal');
  assert.equal(result.exchange?.performed, true);
  assert.equal(result.exchange?.expiresAt, undefined);
  assert.equal(result.exchange?.expiresInDays, undefined);
  assert.equal(result.exchange?.neverExpiring, false, 'unknown is not "never expires"');
  assert.equal(
    step(result, 'exchange').summary,
    'long-lived token obtained (expiry not reported)',
  );
  assert.ok(result.warnings.some((w) => w.includes('~60 days')));
  assert.match(renderSetupTokenReport(result), /obtained, expiry not reported by Graph/);
  assertNoSecrets(result);
});

test('reports an exchange failure without throwing', async () => {
  const { deps, fb } = makeDeps();
  withDebugToken(fb, { type: 'USER', is_valid: true, scopes: ['pages_show_list'] });
  fb.on(
    (req) => req.path === '/oauth/access_token',
    fbErr(new Error('OAuthException: session expired')),
  );

  const result = await runSetupToken(deps);

  assert.equal(result.ok, false);
  assert.match(step(result, 'exchange').detail ?? '', /session expired/);
  assert.equal(result.write.status, 'skipped');
});

test('a System-User token skips the exchange and is written as FB_SYSTEM_TOKEN', async () => {
  const { deps, fb, writes } = makeDeps();
  withDebugToken(fb, {
    type: 'SYSTEM_USER',
    is_valid: true,
    scopes: ['pages_show_list', 'pages_read_engagement'],
    expires_at: 0,
  });
  fb.on(
    (req) => req.path === '/me/accounts',
    fbOk({ data: [{ id: '111', name: 'Acme Page', access_token: PAGE_TOKEN }] }),
  );

  const result = await runSetupToken(deps);

  assert.equal(result.ok, true);
  assert.equal(step(result, 'exchange').status, 'skipped');
  assert.equal(result.exchange?.neverExpiring, true);
  assert.ok(result.write.keys.includes('FB_SYSTEM_TOKEN'));
  assert.equal(
    fb.calls.some((c) => c.path === '/oauth/access_token'),
    false,
  );
  assert.match(writes[0]?.contents ?? '', /FB_SYSTEM_TOKEN="EAA-pasted"/);
});

test('renders a non-expiring System-User token without the rotation note', async () => {
  const { deps, fb } = makeDeps();
  withDebugToken(fb, {
    type: 'SYSTEM_USER',
    is_valid: true,
    scopes: ['pages_show_list'],
    expires_at: 0,
  });
  fb.on(
    (req) => req.path === '/me/accounts',
    fbOk({ data: [{ id: '111', name: 'Acme Page', access_token: PAGE_TOKEN }] }),
  );

  const text = renderSetupTokenReport(await runSetupToken(deps));

  assert.match(
    text,
    /long-lived token: non-expiring \(System-User token, used verbatim\)/,
  );
  assert.match(text, /written as: {7}FB_SYSTEM_TOKEN/);
  assert.equal(
    text.includes(SYSTEM_USER_GUIDANCE),
    false,
    'a token that never expires needs no "mint a System-User token" note',
  );
});

test('a System-User token with an expiry reports the days left, not "non-expiring"', async () => {
  const now = 1_700_000_000_000;
  const { deps, fb } = makeDeps({ nowMs: now });
  withDebugToken(fb, {
    type: 'SYSTEM_USER',
    is_valid: true,
    scopes: ['pages_show_list'],
    expires_at: now / 1000 + 10 * 86_400,
  });
  fb.on(
    (req) => req.path === '/me/accounts',
    fbOk({ data: [{ id: '111', name: 'Acme Page', access_token: PAGE_TOKEN }] }),
  );

  const result = await runSetupToken(deps);

  assert.equal(result.exchange?.performed, false);
  assert.equal(result.exchange?.neverExpiring, false);
  assert.equal(result.exchange?.expiresAt, now + 10 * 86_400 * 1000);
  assert.equal(result.exchange?.expiresInDays, 10);
  assert.equal(step(result, 'exchange').status, 'skipped');
  const text = renderSetupTokenReport(result);
  assert.match(text, /long-lived token: expires .+ \(~10 days\)/);
  assert.match(text, /System-User token is the ONLY/, 'an expiring token gets the note');
});

test('an already-expired System-User token reports 0 days, never a negative count', async () => {
  const now = 1_700_000_000_000;
  const { deps, fb } = makeDeps({ nowMs: now });
  withDebugToken(fb, {
    type: 'SYSTEM_USER',
    is_valid: true,
    scopes: ['pages_show_list'],
    expires_at: now / 1000 - 5 * 86_400,
  });
  fb.on(
    (req) => req.path === '/me/accounts',
    fbOk({ data: [{ id: '111', name: 'Acme Page', access_token: PAGE_TOKEN }] }),
  );

  const result = await runSetupToken(deps);

  assert.equal(result.exchange?.expiresInDays, 0);
  assert.equal(result.exchange?.neverExpiring, false);
  assert.match(renderSetupTokenReport(result), /\(~0 days\)/);
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

test('auto-selects the only Page and writes the full credential set', async () => {
  const { deps, fb, writes } = makeDeps();
  withHappyPath(fb);

  const result = await runSetupToken(deps);

  assert.equal(result.ok, true);
  assert.equal(result.selectedPageId, '111');
  assert.equal(result.pages[0]?.selected, true);
  assert.equal(result.pages[0]?.hasToken, true);
  assert.deepEqual(result.write.keys, [
    'FB_APP_ID',
    'FB_APP_SECRET',
    'FB_ACCESS_TOKEN',
    'FB_PAGE_ID',
    'FB_PAGE_TOKEN',
  ]);
  assert.equal(result.write.status, 'written');
  assert.equal(result.write.restricted, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.path, ENV_PATH);
  assert.match(writes[0]?.contents ?? '', /FB_PAGE_TOKEN="EAA-page"/);
  assertNoSecrets(result);
});

test('does not select a Page when several exist and none was requested', async () => {
  const { deps, fb } = makeDeps();
  withHappyPath(fb, {
    pages: [
      { id: '111', name: 'Acme Page' },
      { id: '222', name: 'Other Page' },
    ],
  });

  const result = await runSetupToken(deps);

  assert.equal(result.ok, true);
  assert.equal(result.selectedPageId, undefined);
  assert.equal(result.write.keys.includes('FB_PAGE_ID'), false);
  assert.ok(result.warnings.some((w) => w.includes('--page=<id>')));
});

test('--page= pins the requested Page and leaves the others unselected', async () => {
  const { deps, fb, writes } = makeDeps({ input: { pageId: '222' } });
  withHappyPath(fb, {
    pages: [
      { id: '111', name: 'Acme Page' },
      { id: '222', name: 'Other Page', access_token: PAGE_TOKEN },
    ],
  });

  const result = await runSetupToken(deps);

  assert.equal(result.ok, true);
  assert.equal(result.selectedPageId, '222');
  assert.deepEqual(
    result.pages.map((p) => p.selected),
    [false, true],
  );
  assert.equal(
    step(result, 'pages').summary,
    '2 Page(s) found; selected 222 (Page token derived)',
  );
  assert.match(writes[0]?.contents ?? '', /FB_PAGE_ID="222"/);
  assert.equal(
    fb.calls.some((c) => c.path === '/222'),
    false,
    'the listing already carried the Page token — no extra derivation call',
  );
  assertNoSecrets(result);
});

test('treats a /me/accounts payload without `data` as zero Pages and still writes', async () => {
  const { deps, fb, writes } = makeDeps();
  withDebugToken(fb, { type: 'USER', is_valid: true, scopes: ['pages_show_list'] });
  fb.on(
    (req) => req.path === '/oauth/access_token',
    fbOk({ access_token: LONG_LIVED, expires_in: 5_184_000 }),
  );
  fb.on((req) => req.path === '/me/accounts', fbOk({}));

  const result = await runSetupToken(deps);

  assert.equal(result.ok, true, 'no Page role is a warning, not a refusal');
  assert.deepEqual(result.pages, []);
  assert.equal(result.selectedPageId, undefined);
  assert.equal(step(result, 'pages').summary, '0 Page(s) found; none selected');
  assert.ok(result.warnings.some((w) => w.includes('No Pages were returned')));
  assert.deepEqual(result.write.keys, ['FB_APP_ID', 'FB_APP_SECRET', 'FB_ACCESS_TOKEN']);
  assert.equal(writes.length, 1, 'the runtime token is still worth writing');
  assert.match(renderSetupTokenReport(result), /\(none found\)/);
});

test('ignores account entries without an id and labels a nameless Page', async () => {
  const { deps, fb } = makeDeps();
  withHappyPath(fb, {
    pages: [
      { name: 'no id at all' },
      { id: '', name: 'blank id' },
      { id: '111', access_token: PAGE_TOKEN },
    ],
  });

  const result = await runSetupToken(deps);

  assert.equal(result.pages.length, 1, 'entries without a usable id are dropped');
  assert.equal(result.pages[0]?.id, '111');
  assert.equal(result.pages[0]?.name, '(unnamed Page)');
  assert.deepEqual(result.pages[0]?.tasks, []);
  assert.equal(result.selectedPageId, '111', 'the single usable Page auto-selects');
  assert.match(renderSetupTokenReport(result), /\(unnamed Page\)/);
});

test('warns when no Page token could be derived for the selected Page', async () => {
  const { deps, fb, writes } = makeDeps();
  withHappyPath(fb, { pages: [{ id: '111', name: 'Acme Page' }] });
  fb.on((req) => req.path === '/111', fbErr(new Error('(#200) requires Page role')));

  const result = await runSetupToken(deps);

  assert.equal(result.ok, true, 'a missing Page token is a warning, never a refusal');
  assert.equal(
    step(result, 'pages').summary,
    '1 Page(s) found; selected 111 (no Page token)',
  );
  assert.ok(result.warnings.some((w) => w.includes('No Page token could be derived')));
  assert.deepEqual(result.write.keys, [
    'FB_APP_ID',
    'FB_APP_SECRET',
    'FB_ACCESS_TOKEN',
    'FB_PAGE_ID',
  ]);
  assert.equal((writes[0]?.contents ?? '').includes('FB_PAGE_TOKEN'), false);
});

test('explains that the token sees no Pages at all when --page= matches nothing', async () => {
  const { deps, fb } = makeDeps({ input: { pageId: '999' } });
  withHappyPath(fb, { pages: [] });

  const result = await runSetupToken(deps);

  assert.equal(result.ok, false);
  assert.equal(step(result, 'pages').status, 'failed');
  assert.match(step(result, 'pages').detail ?? '', /sees no Pages at all/);
  assert.match(step(result, 'pages').detail ?? '', /pages_show_list/);
  assert.deepEqual(result.pages, []);
  assert.equal(result.write.status, 'skipped');
});

test('passes the caller AbortSignal to every Graph call it makes', async () => {
  const { deps, fb } = makeDeps();
  const controller = new AbortController();
  withHappyPath(fb, { pages: [{ id: '111', name: 'Acme Page' }] });
  fb.on((req) => req.path === '/111', fbOk({ access_token: PAGE_TOKEN }));

  await runSetupToken({ ...deps, signal: controller.signal });

  assert.deepEqual(
    fb.calls.map((c) => c.path),
    ['/debug_token', '/oauth/access_token', '/me/accounts', '/111'],
  );
  for (const call of fb.calls) {
    assert.equal(call.signal, controller.signal, `${call.path} lost the signal`);
  }
});

test('fails when the requested Page is not visible, listing the available IDs', async () => {
  const { deps, fb } = makeDeps({ input: { pageId: '999' } });
  withHappyPath(fb, {
    pages: [
      { id: '111', name: 'Acme Page' },
      { id: '222', name: 'Other Page' },
    ],
  });

  const result = await runSetupToken(deps);

  assert.equal(result.ok, false);
  assert.equal(step(result, 'pages').status, 'failed');
  assert.match(step(result, 'pages').detail ?? '', /111, 222/);
  assert.equal(result.write.status, 'skipped');
});

test('derives the Page token explicitly when /me/accounts omits it', async () => {
  const { deps, fb, writes } = makeDeps();
  withHappyPath(fb, { pages: [{ id: '111', name: 'Acme Page' }] });
  fb.on((req) => req.path === '/111', fbOk({ access_token: PAGE_TOKEN }));

  const result = await runSetupToken(deps);

  const derive = fb.calls.find((c) => c.path === '/111');
  assert.ok(derive, 'expected an explicit Page-token derivation call');
  assert.equal(paramsOf(derive)['fields'], 'access_token');
  assert.equal(derive.token, LONG_LIVED, 'derivation must use the long-lived token');
  assert.equal(result.pages[0]?.hasToken, false, 'listing carried no token');
  assert.ok(result.write.keys.includes('FB_PAGE_TOKEN'));
  assert.match(writes[0]?.contents ?? '', /FB_PAGE_TOKEN="EAA-page"/);
});

test('reports a /me/accounts failure instead of throwing', async () => {
  const { deps, fb } = makeDeps();
  withDebugToken(fb, { type: 'USER', is_valid: true, scopes: ['pages_show_list'] });
  fb.on(
    (req) => req.path === '/oauth/access_token',
    fbOk({ access_token: LONG_LIVED, expires_in: 5_184_000 }),
  );
  fb.on((req) => req.path === '/me/accounts', fbErr(new Error('permission denied')));

  const result = await runSetupToken(deps);

  assert.equal(result.ok, false);
  assert.match(step(result, 'pages').detail ?? '', /pages_show_list/);
  assert.equal(result.write.status, 'skipped');
});

// ---------------------------------------------------------------------------
// Env-file write
// ---------------------------------------------------------------------------

test('refuses to overwrite an existing env file without --force', async () => {
  const { deps, fb, writes } = makeDeps({ fileExists: true });
  withHappyPath(fb);

  const result = await runSetupToken(deps);

  assert.equal(result.ok, false);
  assert.equal(result.write.status, 'needs-force');
  assert.equal(writes.length, 0, 'nothing may be written without --force');
  assert.match(step(result, 'write').detail ?? '', /--force/);
  assert.ok(result.write.keys.length > 0, 'the keys are still reported');
});

test('overwrites an existing env file with --force', async () => {
  const { deps, fb, writes } = makeDeps({ fileExists: true, input: { force: true } });
  withHappyPath(fb);

  const result = await runSetupToken(deps);

  assert.equal(result.ok, true);
  assert.equal(result.write.status, 'written');
  assert.equal(writes.length, 1);
});

test('--no-write reports the keys it would write without touching the file', async () => {
  const { deps, fb, writes } = makeDeps({ input: { write: false } });
  withHappyPath(fb);

  const result = await runSetupToken(deps);

  assert.equal(result.ok, true);
  assert.equal(result.write.status, 'skipped');
  assert.ok(result.write.keys.includes('FB_PAGE_TOKEN'));
  assert.equal(writes.length, 0);
  assert.match(step(result, 'write').detail ?? '', /--no-write/);
});

test('reports a write failure with a redacted message', async () => {
  const { deps, fb } = makeDeps({ writeError: new Error(`EACCES ${PASTED}`) });
  withHappyPath(fb);

  const result = await runSetupToken(deps);

  assert.equal(result.ok, false);
  assert.equal(result.write.status, 'failed');
  assert.equal(result.write.error?.includes(PASTED), false);
  assertNoSecrets(result);
});

test('a non-Error rejection from the writer is still reported readably', async () => {
  const fb = createFakeFbRequest();
  withHappyPath(fb, {
    pages: [
      { id: '111', name: 'Acme Page' },
      { id: '222', name: 'Other Page' },
    ],
  });
  // Node rejects with a string here and there (and userland code with anything);
  // the report must stay readable instead of printing "[object Object]".
  const failure: unknown = 'EROFS: read-only file system';

  const result = await runSetupToken({
    fbRequest: fb.fn,
    settings: makeSettings(),
    clock: createFakeClock(1_000_000),
    logger: makeLogger(),
    redactor: createFakeRedactor(),
    input: makeInput(),
    envFilePath: ENV_PATH,
    fileExists: () => Promise.resolve(false),
    writeEnvFile: (): Promise<AtomicWriteResult> => {
      throw failure;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.write.status, 'failed');
  assert.equal(result.write.error, 'EROFS: read-only file system');
  assert.equal(result.selectedPageId, undefined, 'two Pages, none pinned');
  assert.equal(result.write.keys.includes('FB_PAGE_ID'), false);
  assert.match(step(result, 'write').detail ?? '', /EROFS/);
  assert.match(renderSetupTokenReport(result), /status: FAILED — EROFS/);
});

test('--dry-run with several Pages pins none, touches nothing, still lists the keys', async () => {
  const { deps, fb, writes } = makeDeps({ input: { write: false } });
  withHappyPath(fb, {
    pages: [
      { id: '111', name: 'Acme Page' },
      { id: '222', name: 'Other Page' },
    ],
  });

  const result = await runSetupToken(deps);
  const text = renderSetupTokenReport(result);

  assert.equal(result.ok, true);
  assert.equal(result.selectedPageId, undefined);
  assert.equal(result.write.status, 'skipped');
  assert.deepEqual(result.write.keys, ['FB_APP_ID', 'FB_APP_SECRET', 'FB_ACCESS_TOKEN']);
  assert.equal(writes.length, 0, 'a dry run must not touch the file');
  assert.match(step(result, 'write').detail ?? '', new RegExp(ENV_PATH));
  const pageLine = text.split('\n').find((l) => l.includes('Acme Page'));
  assert.ok(pageLine);
  assert.ok(pageLine.startsWith('    111'), 'an unselected Page carries no `*` marker');
  assert.equal(pageLine.includes('['), false, 'no category was returned');
  assert.equal(pageLine.includes('tasks:'), false, 'no tasks were returned');
});

test('renders the overwrite refusal with the --force instruction', async () => {
  const { deps, fb, writes } = makeDeps({ fileExists: true });
  withHappyPath(fb, {
    pages: [
      { id: '111', name: 'Acme Page' },
      { id: '222', name: 'Other Page' },
    ],
  });

  const result = await runSetupToken(deps);
  const text = renderSetupTokenReport(result);

  assert.equal(result.write.status, 'needs-force');
  assert.equal(result.selectedPageId, undefined);
  assert.equal(writes.length, 0);
  assert.match(text, /status: NOT written — the file exists; re-run with --force/);
  assert.match(
    text,
    /keys: {3}FB_APP_ID, FB_APP_SECRET, FB_ACCESS_TOKEN \(values are never printed\)/,
  );
  assert.match(text, /status: {7}INCOMPLETE/);
  assertNoSecrets(result);
});

test('writes to the platform config dir when no --env-file was given', async () => {
  const fb = createFakeFbRequest();
  withHappyPath(fb);
  const writes: Written[] = [];

  const result = await withEnv({ APPDATA: 'C:\\Users\\t\\AppData\\Roaming' }, () =>
    runSetupToken({
      fbRequest: fb.fn,
      settings: makeSettings(),
      clock: createFakeClock(1_000_000),
      logger: makeLogger(),
      redactor: createFakeRedactor(),
      input: makeInput(),
      platform: 'win32',
      fileExists: () => Promise.resolve(false),
      writeEnvFile: (filePath, contents): Promise<AtomicWriteResult> => {
        writes.push({ path: filePath, contents });
        return Promise.resolve({ path: filePath, restricted: false, mode: 0o600 });
      },
    }),
  );

  assert.equal(result.write.path, 'C:\\Users\\t\\AppData\\Roaming\\facebook-mcp\\.env');
  assert.equal(writes[0]?.path, result.write.path, 'the write went to that same path');
});

test(
  'the default env path follows XDG_CONFIG_HOME when nothing was injected',
  { skip: process.platform === 'win32' ? 'POSIX config dir' : false },
  async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-setup-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const fb = createFakeFbRequest();
    withHappyPath(fb);

    // No --env-file, no injected default, no injected platform: this is the path
    // a real POSIX install writes to. Kept a dry run so nothing touches disk.
    const result = await withEnv({ XDG_CONFIG_HOME: dir }, () =>
      runSetupToken({
        fbRequest: fb.fn,
        settings: makeSettings(),
        clock: createFakeClock(1_000_000),
        logger: makeLogger(),
        redactor: createFakeRedactor(),
        input: makeInput({ write: false }),
      }),
    );

    assert.equal(result.write.status, 'skipped');
    assert.equal(result.write.path, path.join(dir, 'facebook-mcp', '.env'));
    assert.equal(await stat(result.write.path).catch(() => undefined), undefined);
  },
);

test('reports honestly that Windows cannot enforce mode 0600', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-setup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, '.env');
  const fb = createFakeFbRequest();
  withHappyPath(fb);

  const result = await runSetupToken({
    fbRequest: fb.fn,
    settings: makeSettings(),
    clock: createFakeClock(1_000_000),
    logger: makeLogger(),
    redactor: createFakeRedactor(),
    input: makeInput({ envFilePath: target }),
    platform: 'win32',
  });

  assert.equal(result.write.status, 'written');
  assert.equal(result.write.restricted, false, 'POSIX 0600 is not enforced on Windows');
  assert.match(result.write.note ?? '', /not enforced on Windows/);
  assert.equal(step(result, 'write').detail, result.write.note, 'the note is surfaced');
  const text = renderSetupTokenReport(result);
  assert.match(text, /^ {2}status: written atomically$/m);
  assert.equal(
    text.includes('mode 0600, owner only'),
    false,
    'the report must not claim a permission it did not get',
  );
  assert.match(text, /^ {2}note: {3}POSIX mode 0600 is not enforced on Windows/m);
  assert.match(await readFile(target, 'utf8'), /^FB_ACCESS_TOKEN="EAA-long-lived"$/m);
});

test(
  'writes a real file with mode 0600 through the core atomic helper',
  {
    skip: process.platform === 'win32' ? 'POSIX modes only' : false,
  },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-setup-'));
    const target = path.join(dir, 'nested', '.env');
    const fb = createFakeFbRequest();
    withHappyPath(fb);

    const result = await runSetupToken({
      fbRequest: fb.fn,
      settings: makeSettings(),
      clock: createFakeClock(1_000_000),
      logger: makeLogger(),
      redactor: createFakeRedactor(),
      input: makeInput({ envFilePath: target }),
    });

    assert.equal(result.write.status, 'written');
    assert.equal(result.write.path, target);
    assert.equal(result.write.restricted, true);
    const stats = await stat(target);
    assert.equal(stats.mode & 0o777, 0o600);
    const contents = await readFile(target, 'utf8');
    assert.match(contents, /^FB_APP_ID="1234567890"$/m);
    assert.match(contents, /CONTAINS SECRETS/);
  },
);

test(
  'honours an existing real file without --force',
  {
    skip: process.platform === 'win32' ? 'POSIX modes only' : false,
  },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-setup-'));
    const target = path.join(dir, '.env');
    await writeFile(target, 'FB_APP_ID="keep-me"\n', { mode: 0o600 });
    const fb = createFakeFbRequest();
    withHappyPath(fb);

    const result = await runSetupToken({
      fbRequest: fb.fn,
      settings: makeSettings(),
      clock: createFakeClock(1_000_000),
      logger: makeLogger(),
      redactor: createFakeRedactor(),
      input: makeInput({ envFilePath: target }),
    });

    assert.equal(result.write.status, 'needs-force');
    assert.equal(await readFile(target, 'utf8'), 'FB_APP_ID="keep-me"\n');
  },
);

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

test('renders every section and ends with the concrete next command', async () => {
  const { deps, fb } = makeDeps();
  withHappyPath(fb);

  const text = renderSetupTokenReport(await runSetupToken(deps));
  const lines = text.split('\n');

  for (const section of ['Run', 'Steps', 'Token', 'Exchange', 'Pages', 'Env file']) {
    assert.ok(lines.includes(section), `missing section ${section}`);
  }
  assert.match(text, /Acme Page/);
  assert.match(text, /values are never printed/);
  assert.equal(lines.at(-1), `  ${SETUP_NEXT_COMMAND}`);
  assert.equal(lines.at(-2), 'Next step:');
});

test('renders the failure path with its actionable detail', async () => {
  const { deps } = makeDeps({ input: { token: undefined, tokenSource: 'none' } });

  const text = renderSetupTokenReport(await runSetupToken(deps));

  assert.match(text, /status:\s+INCOMPLETE/);
  assert.match(text, /\[FAIL] input/);
  assert.match(text, new RegExp(SETUP_TOKEN_ENV_VAR));
  assert.ok(text.trimEnd().endsWith(SETUP_NEXT_COMMAND));
});
