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
import {
  lstat,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
import { loadEnvFile } from '../core/index.js';
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
  renderEnvFile,
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

test('--page <id> and --env-file <path> take their value from the next argument', () => {
  // The space-separated form is what most CLIs accept. Read as an unknown
  // `--page` plus a positional, the Page ID became the TOKEN: FB_SETUP_TOKEN was
  // silently ignored, the ID was sent to Graph as a credential, and the operator
  // was told their token sat in the process list.
  const input = parseSetupTokenArgs(['--page', '111', '--env-file', '/tmp/x.env'], {
    [SETUP_TOKEN_ENV_VAR]: PASTED,
  });

  assert.equal(input.pageId, '111');
  assert.equal(input.envFilePath, '/tmp/x.env');
  assert.equal(input.token, PASTED);
  assert.equal(input.tokenSource, 'env');
  assert.deepEqual(input.notes, []);
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

test('the no-token instruction names the blocking scope, not an unshipped docs path', async () => {
  // `docs/` is not in package.json's `files`, so an operator who reached this
  // message through `npx @ivanbaev/facebook-mcp setup-token` has no runbook to
  // open — and this is the first thing the flow ever prints.
  const { deps } = makeDeps({ input: { token: undefined, tokenSource: 'none' } });

  const detail = step(await runSetupToken(deps), 'input').detail ?? '';

  assert.match(detail, /pages_show_list/, 'the blocking scope must be named inline');
  assert.doesNotMatch(detail, /docs\//, 'points at a path the npm package omits');
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

test('registers every Page token the listing carried, not only the selected one', async () => {
  // The unselected Pages' tokens are live credentials sitting in the parsed
  // payload for the rest of the run. Value-based redaction is the primary
  // strategy (the `EAA…` pattern scan is only a backup), so each one has to be
  // registered — the header promises it for "every derived Page token".
  const otherPageToken = 'EAA-unselected-page';
  const { deps, fb } = makeDeps({ input: { pageId: '222' } });
  const redactor = createFakeRedactor();
  withHappyPath(fb, {
    pages: [
      { id: '111', name: 'Acme Page', access_token: otherPageToken },
      { id: '222', name: 'Other Page', access_token: PAGE_TOKEN },
    ],
  });

  const result = await runSetupToken({ ...deps, redactor });

  assert.equal(result.selectedPageId, '222');
  assert.ok(redactor.secrets.includes(PAGE_TOKEN), 'selected Page token');
  assert.ok(
    redactor.secrets.includes(otherPageToken),
    'the unselected Page token was never registered with the redactor',
  );
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

test('an exchange whose token dies within the day is flagged, not called long-lived', async () => {
  const now = 1_700_000_000_000;
  const { deps, fb, writes } = makeDeps({ nowMs: now });
  withDebugToken(fb, { type: 'USER', is_valid: true, scopes: ['pages_show_list'] });
  // Graph answered the exchange with a token that lives 90 minutes — the
  // lifetime of the Explorer token that went in, not the ~60 days that make a
  // token long-lived. The step used to call it "long-lived token obtained
  // (~0 days)" with nothing else said, and the file was written as usual.
  fb.on(
    (req) => req.path === '/oauth/access_token',
    fbOk({ access_token: LONG_LIVED, expires_in: 5_400 }),
  );
  fb.on(
    (req) => req.path === '/me/accounts',
    fbOk({ data: [{ id: '111', name: 'Acme Page', access_token: PAGE_TOKEN }] }),
  );

  const result = await runSetupToken(deps);

  assert.equal(result.ok, true, 'a short lifetime is a warning, never a refusal');
  assert.equal(result.exchange?.expiresAt, now + 5_400 * 1000);
  assert.equal(result.exchange?.expiresInDays, 0);
  assert.equal(
    writes.length,
    1,
    'the token still works until it expires, so it is written',
  );
  const summary = step(result, 'exchange').summary;
  assert.doesNotMatch(summary, /long-lived/, 'a 90-minute token is not long-lived');
  assert.match(summary, /expires in ~1 hour/);
  const warning = result.warnings.find((w) => w.includes('not a long-lived token')) ?? '';
  assert.match(warning, /~1 hour/);
  assert.match(warning, /re-run/);
  const text = renderSetupTokenReport(result);
  assert.match(text, /token: {12}expires .+ \(under a day — NOT long-lived\)/);
  assert.doesNotMatch(text, /long-lived token: expires/);
  assertNoSecrets(result);
});

test('an exchange whose token dies within the hour states the minutes left', async () => {
  const now = 1_700_000_000_000;
  const { deps, fb } = makeDeps({ nowMs: now });
  withDebugToken(fb, { type: 'USER', is_valid: true, scopes: ['pages_show_list'] });
  fb.on(
    (req) => req.path === '/oauth/access_token',
    fbOk({ access_token: LONG_LIVED, expires_in: 20 }),
  );
  fb.on(
    (req) => req.path === '/me/accounts',
    fbOk({ data: [{ id: '111', name: 'Acme Page', access_token: PAGE_TOKEN }] }),
  );

  const result = await runSetupToken(deps);

  assert.match(step(result, 'exchange').summary, /expires in ~1 minute/);
  assert.ok(result.warnings.some((w) => w.includes('not a long-lived token')));
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

test('a System-User token whose expiry Graph never stated is not written as non-expiring', async () => {
  // `debug_token` answers `expires_at: 0` for a token that never expires; an
  // answer with no usable `expires_at` at all says nothing. The two used to
  // collapse into the same "non-expiring (System-User token, used verbatim)"
  // line, so a credential the operator must rotate was filed as one they never
  // need to touch.
  const { deps, fb, writes } = makeDeps();
  withDebugToken(fb, {
    type: 'SYSTEM_USER',
    is_valid: true,
    scopes: ['pages_show_list'],
  });
  fb.on(
    (req) => req.path === '/me/accounts',
    fbOk({ data: [{ id: '111', name: 'Acme Page', access_token: PAGE_TOKEN }] }),
  );

  const result = await runSetupToken(deps);

  assert.equal(result.ok, true, 'an unknown expiry is a warning, not a failure');
  assert.equal(result.token.expiry, 'unknown');
  assert.equal(result.exchange?.performed, false);
  assert.equal(result.exchange?.neverExpiring, false, 'unknown is not "never expires"');
  assert.equal(result.exchange?.expiresAt, undefined);
  assert.ok(
    result.warnings.some((w) =>
      /did not report an expiry for this System-User token/.test(w),
    ),
    `expected an unknown-expiry warning, got ${JSON.stringify(result.warnings)}`,
  );
  const text = renderSetupTokenReport(result);
  assert.doesNotMatch(text, /non-expiring \(System-User token/);
  assert.match(text, /System-User token: used verbatim, expiry not reported by Graph/);
  assert.match(
    writes[0]?.contents ?? '',
    /FB_SYSTEM_TOKEN="EAA-pasted"/,
    'still written',
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

test('the "pin a Page" advice admits the re-run needs --force', async () => {
  const { deps, fb } = makeDeps();
  withHappyPath(fb, {
    pages: [
      { id: '111', name: 'Acme Page' },
      { id: '222', name: 'Other Page' },
    ],
  });

  const result = await runSetupToken(deps);
  const warning = result.warnings.find((w) => w.includes('--page=<id>')) ?? '';

  assert.equal(result.write.status, 'written', 'this run leaves an env file behind');
  assert.match(warning, /--force/, 'the suggested re-run is refused without it');

  // The trap the warning has to describe: the exact command it suggests, run
  // against the file this run just wrote, does not complete.
  const second = makeDeps({ input: { pageId: '222' }, fileExists: true });
  withHappyPath(second.fb, {
    pages: [
      { id: '111', name: 'Acme Page' },
      { id: '222', name: 'Other Page', access_token: PAGE_TOKEN },
    ],
  });
  assert.equal((await runSetupToken(second.deps)).write.status, 'needs-force');
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

test('an account entry with unexpected field types cannot crash the renderer', async () => {
  // `/me/accounts` is untrusted JSON, not a validated shape. `tasks` is joined
  // by the renderer, so a non-array arriving there threw AFTER the credentials
  // had already been written to disk — the operator lost the report of a run
  // that had in fact succeeded.
  const { deps, fb, writes } = makeDeps();
  withHappyPath(fb, {
    pages: [
      { id: '111', name: 42, category: null, tasks: 'MANAGE', access_token: PAGE_TOKEN },
    ],
  });

  const result = await runSetupToken(deps);

  assert.equal(writes.length, 1, 'the write happens before the render');
  assert.doesNotThrow(() => renderSetupTokenReport(result));
  assert.deepEqual(result.pages[0]?.tasks, []);
  assert.equal(result.pages[0]?.name, '(unnamed Page)');
  assert.equal(result.pages[0]?.category, undefined, 'a null category is not "[null]"');
  assert.equal(result.pages[0]?.hasToken, true);
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

test('a failed Page-token derivation names the reason, redacted, not only a role hint', async () => {
  // Every failure used to collapse into "confirm your role on the Page" — also a
  // network timeout or a dead token, where checking the role fixes nothing and
  // the one fact that would (Graph's own message) had been thrown away.
  const { deps, fb } = makeDeps();
  withHappyPath(fb, { pages: [{ id: '111', name: 'Acme Page' }] });
  fb.on(
    (req) => req.path === '/111',
    fbErr(new Error(`connect ETIMEDOUT graph.facebook.com token=${LONG_LIVED}`)),
  );

  const result = await runSetupToken(deps);

  assert.equal(result.ok, true, 'still a warning, never a refusal');
  const warning = result.warnings.find((w) =>
    w.includes('No Page token could be derived'),
  );
  assert.ok(warning, 'expected the derivation warning');
  assert.match(warning, /ETIMEDOUT/, 'the reason for the failed derivation was dropped');
  assertNoSecrets(result);
});

test('a failed Page-token derivation never claims a write the write step did not make', async () => {
  // The derivation warning is composed during the pages step, before the write
  // step has run. It used to say "only the runtime token was written" even when
  // that step then refused (an existing file without --force), failed, or was a
  // dry run — so the operator was told a credential had landed on disk when
  // nothing had.
  const cases: readonly {
    readonly label: string;
    readonly opts: Parameters<typeof makeDeps>[0];
    readonly expected: RegExp;
  }[] = [
    {
      label: 'existing file, no --force',
      opts: { fileExists: true },
      expected: /nothing was written/,
    },
    {
      label: 'write error',
      opts: { writeError: new Error('EACCES: permission denied') },
      expected: /nothing was written/,
    },
    {
      label: 'dry run',
      opts: { input: { write: false } },
      expected: /dry run wrote nothing/,
    },
  ];
  for (const { label, opts, expected } of cases) {
    const { deps, fb, writes } = makeDeps(opts);
    withHappyPath(fb, { pages: [{ id: '111', name: 'Acme Page' }] });
    fb.on((req) => req.path === '/111', fbErr(new Error('(#200) requires Page role')));

    const result = await runSetupToken(deps);

    assert.equal(writes.length, 0, `${label}: nothing may be written`);
    const warning =
      result.warnings.find((w) => w.includes('No Page token could be derived')) ?? '';
    assert.doesNotMatch(
      warning,
      /only the runtime token was written/,
      `${label}: the warning claims a write that never happened: ${warning}`,
    );
    assert.match(warning, expected, `${label}: ${warning}`);
  }

  // The write that does happen is still described as such.
  const { deps, fb } = makeDeps();
  withHappyPath(fb, { pages: [{ id: '111', name: 'Acme Page' }] });
  fb.on((req) => req.path === '/111', fbErr(new Error('(#200) requires Page role')));
  const written = await runSetupToken(deps);
  assert.match(
    written.warnings.find((w) => w.includes('No Page token could be derived')) ?? '',
    /only the runtime token was written/,
  );
});

test('a token that sees no Pages never claims its runtime token was written when it was not', async () => {
  const { deps, fb, writes } = makeDeps({ fileExists: true });
  withHappyPath(fb, { pages: [] });

  const result = await runSetupToken(deps);

  assert.equal(result.write.status, 'needs-force');
  assert.equal(writes.length, 0);
  const warning = result.warnings.find((w) => w.includes('No Pages were returned')) ?? '';
  assert.doesNotMatch(
    warning,
    /runtime token is still written/,
    `the warning claims a write that never happened: ${warning}`,
  );
  assert.match(warning, /nothing was written/i);
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

test('an unreadable FB_TOOL_PACKAGES is reported, not silently defaulted', async () => {
  // The scope cross-reference is computed against "the packages this install will
  // run". With an invalid FB_TOOL_PACKAGES the install runs NOTHING — the server
  // refuses to start on it. Falling back to the default profile in silence let the
  // operator finish onboarding with a green report describing a configuration that
  // cannot boot, and nothing in the output pointed at the variable to fix.
  const { deps, fb } = makeDeps({
    settings: makeSettings({ toolPackages: ['reader', 'notaprofile'] }),
  });
  withHappyPath(fb);

  const result = await runSetupToken(deps);

  const warning = result.warnings.find((w) => w.includes('FB_TOOL_PACKAGES')) ?? '';
  assert.match(warning, /could not be read/);
  // The offending token, so the fix does not need a second run to locate.
  assert.match(warning, /notaprofile/);
  // And the consequence, which is what makes it worth interrupting a green run.
  assert.match(warning, /refuse to start/);
});

test('a valid FB_TOOL_PACKAGES adds no such warning', async () => {
  const { deps, fb } = makeDeps({
    settings: makeSettings({ toolPackages: ['reader'] }),
  });
  withHappyPath(fb);

  const result = await runSetupToken(deps);

  assert.equal(
    result.warnings.some((w) => w.includes('FB_TOOL_PACKAGES')),
    false,
  );
});

test('never blames pages_show_list after classify verified it was granted', async () => {
  // classify refuses any token missing pages_show_list, so by the time the
  // pages step speaks, "the scope was not granted" is a cause the flow itself
  // has already ruled out — and it sends the operator back to the Explorer to
  // re-tick a box that is already ticked.
  const { deps, fb } = makeDeps();
  withHappyPath(fb, { pages: [] });

  const empty = await runSetupToken(deps);
  const warning = empty.warnings.find((w) => w.includes('No Pages were returned')) ?? '';

  assert.doesNotMatch(warning, /pages_show_list was not granted/);
  assert.match(warning, /pages_show_list IS granted/);

  const pinned = makeDeps({ input: { pageId: '999' } });
  withHappyPath(pinned.fb, { pages: [] });
  const detail = step(await runSetupToken(pinned.deps), 'pages').detail ?? '';

  assert.doesNotMatch(detail, /pages_show_list was granted/);
  assert.match(detail, /pages_show_list IS granted/);
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

test('admits the Page listing was truncated instead of denying the Page exists', async () => {
  // The flow reads ONE page of /me/accounts (limit 100) and never follows
  // `paging.next`. With more Pages than that, "not among the Pages this token
  // can see" is false — the Page is simply outside the window this run read.
  const truncated = {
    data: [{ id: '111', name: 'Acme Page', access_token: PAGE_TOKEN }],
    paging: { next: 'https://graph.facebook.com/v23.0/me/accounts?after=cursor' },
  };
  const pinned = makeDeps({ input: { pageId: '999' } });
  withDebugToken(pinned.fb, {
    type: 'USER',
    is_valid: true,
    scopes: ['pages_show_list'],
  });
  pinned.fb.on(
    (req) => req.path === '/oauth/access_token',
    fbOk({ access_token: LONG_LIVED, expires_in: 5_184_000 }),
  );
  pinned.fb.on((req) => req.path === '/me/accounts', fbOk(truncated));

  const missed = await runSetupToken(pinned.deps);

  assert.equal(step(missed, 'pages').status, 'failed');
  assert.match(step(missed, 'pages').summary, /first 100 Pages/);
  assert.match(step(missed, 'pages').summary, /Graph reported more/);
});

test('a truncated listing never auto-selects its only visible Page', async () => {
  // Auto-selection rests on uniqueness: ONE Page, so it must be the one. When
  // Graph's own `paging.next` says more exist, the entry this run happened to
  // see is not unique — pinning it wrote FB_PAGE_ID for a Page the operator
  // never chose, reported as "1 Page(s) found; selected 111", and every later
  // write went to it.
  const { deps, fb, writes } = makeDeps();
  withDebugToken(fb, { type: 'USER', is_valid: true, scopes: ['pages_show_list'] });
  fb.on(
    (req) => req.path === '/oauth/access_token',
    fbOk({ access_token: LONG_LIVED, expires_in: 5_184_000 }),
  );
  fb.on(
    (req) => req.path === '/me/accounts',
    fbOk({
      data: [{ id: '111', name: 'Acme Page', access_token: PAGE_TOKEN }],
      paging: { next: 'https://graph.facebook.com/v23.0/me/accounts?after=cursor' },
    }),
  );

  const result = await runSetupToken(deps);

  assert.equal(result.selectedPageId, undefined, 'a non-unique Page was pinned');
  assert.equal(result.write.keys.includes('FB_PAGE_ID'), false);
  assert.equal((writes[0]?.contents ?? '').includes('FB_PAGE_ID'), false);
  assert.ok(
    result.warnings.some((w) => w.includes('Graph reported more Pages')),
    'a truncated listing was never disclosed',
  );
  assert.ok(
    result.warnings.some((w) => w.includes('--page=<id>')),
    'the operator is not told how to pin the Page',
  );
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

test('--no-write over an existing env file says the real run needs --force', async () => {
  // The dry run exists to answer "what will the real run do?". Promising
  // "re-run without --no-write to write …" while that exact re-run is refused
  // (the file exists, no --force) sends the operator into a failing command.
  const { deps, fb, writes } = makeDeps({ fileExists: true, input: { write: false } });
  withHappyPath(fb);

  const result = await runSetupToken(deps);

  assert.equal(result.write.status, 'skipped');
  assert.equal(writes.length, 0);
  const detail = step(result, 'write').detail ?? '';
  assert.match(detail, /already exists/);
  assert.match(detail, /--force/);
});

test(
  '--no-write over a symlinked env file reports the refusal the real run would hit',
  { skip: process.platform === 'win32' ? 'POSIX symlinks only' : false },
  async (t) => {
    // A symbolic link at the env path is refused even with --force, so no
    // re-run of this command can ever write there. A dry run that reports
    // success and promises the write is telling the operator something false.
    const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-setup-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const real = path.join(dir, 'managed.env');
    await writeFile(real, 'FB_ACCESS_TOKEN="EAA-old"\n', { mode: 0o600 });
    const target = path.join(dir, '.env');
    await symlink(real, target);
    const fb = createFakeFbRequest();
    withHappyPath(fb);

    const result = await runSetupToken({
      fbRequest: fb.fn,
      settings: makeSettings(),
      clock: createFakeClock(1_000_000),
      logger: makeLogger(),
      redactor: createFakeRedactor(),
      input: makeInput({ envFilePath: target, write: false }),
    });

    assert.equal(result.ok, false, 'a write no re-run can perform is not a success');
    assert.equal(result.write.status, 'failed');
    assert.match(result.write.error ?? '', /symbolic link/);
    assert.match(step(result, 'write').detail ?? '', /--env-file=/);
    assert.equal((await lstat(target)).isSymbolicLink(), true, 'the link survives');
    assert.equal(await readFile(real, 'utf8'), 'FB_ACCESS_TOKEN="EAA-old"\n');
  },
);

/**
 * An existing env file holding keys this command never writes. The values are
 * distinctive so a report that echoed one would be caught.
 */
const OLD_ENV_FILE =
  'FB_APP_ID="1234567890"\n' +
  'FB_ACCESS_TOKEN="EAA-old"\n' +
  'FB_CONFIRM_TOKEN="old-confirm-value"\n' +
  'FB_WRITE_MODE=live\n' +
  'FB_TOOL_PACKAGES="core,posts"\n';

async function runOverExistingFile(
  t: { after: (fn: () => Promise<void>) => void },
  input: Partial<SetupTokenInput>,
): Promise<{ result: SetupTokenResult; writes: Written[] }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-setup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envPath = path.join(dir, '.env');
  await writeFile(envPath, OLD_ENV_FILE, { mode: 0o600 });
  const fb = createFakeFbRequest();
  withHappyPath(fb);
  const writes: Written[] = [];
  const result = await runSetupToken({
    fbRequest: fb.fn,
    settings: makeSettings(),
    clock: createFakeClock(1_000_000),
    logger: makeLogger(),
    redactor: createFakeRedactor(),
    input: makeInput({ envFilePath: envPath, ...input }),
    writeEnvFile: (filePath, contents): Promise<AtomicWriteResult> => {
      writes.push({ path: filePath, contents });
      return Promise.resolve({ path: filePath, restricted: true, mode: 0o600 });
    },
  });
  return { result, writes };
}

function assertNamesDroppedKeys(result: SetupTokenResult): void {
  const detail = step(result, 'write').detail ?? '';
  const text = renderSetupTokenReport(result);
  for (const haystack of [detail, text]) {
    assert.match(haystack, /FB_CONFIRM_TOKEN, FB_WRITE_MODE, FB_TOOL_PACKAGES/);
  }
  // Keys this run re-writes are not "dropped".
  assert.equal(/dropped[^\n]*FB_ACCESS_TOKEN/i.test(text), false);
  // Names only — never a value from the old file.
  for (const value of ['EAA-old', 'old-confirm-value', 'core,posts']) {
    assert.equal(text.includes(value), false, `old value ${value} leaked`);
    assert.equal(
      JSON.stringify(result).includes(value),
      false,
      `old value ${value} leaked`,
    );
  }
}

test('--force over an existing env file names the keys the replacement drops', async (t) => {
  // The file is replaced wholesale: a confirm token, a write mode or a package
  // selection the operator set by hand silently vanished, and the next server
  // start ran in a different mode with no hint why.
  const { result, writes } = await runOverExistingFile(t, { force: true });

  assert.equal(result.write.status, 'written');
  assert.equal(writes.length, 1);
  assertNamesDroppedKeys(result);
});

test('a --force dry run over an existing env file names the keys it would drop', async (t) => {
  const { result, writes } = await runOverExistingFile(t, { force: true, write: false });

  assert.equal(result.write.status, 'skipped');
  assert.equal(writes.length, 0);
  assertNamesDroppedKeys(result);
});

test('the overwrite refusal names the keys --force would drop', async (t) => {
  const { result, writes } = await runOverExistingFile(t, {});

  assert.equal(result.write.status, 'needs-force');
  assert.equal(writes.length, 0);
  assertNamesDroppedKeys(result);
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

test(
  'a dangling symlink at the env path is an existing entry, not a free slot',
  { skip: process.platform === 'win32' ? 'POSIX symlinks only' : false },
  async (t) => {
    // `.env -> <a file on a volume that is not mounted yet>`: `stat` follows the
    // link, answers ENOENT, and the overwrite guard waved the write through
    // without --force — then `rename` replaced the operator's link with a
    // regular file. The guard exists precisely so nothing at the path is
    // replaced unasked.
    const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-setup-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const target = path.join(dir, '.env');
    const linkTarget = path.join(dir, 'unmounted', 'fb.env');
    await symlink(linkTarget, target);
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

    assert.notEqual(result.write.status, 'written', 'nothing may be written unasked');
    assert.equal(result.ok, false);
    assert.equal((await lstat(target)).isSymbolicLink(), true, 'the link survives');
    assert.equal(await readlink(target), linkTarget);
  },
);

test(
  'refuses to replace a symlinked env file even with --force, and says why',
  { skip: process.platform === 'win32' ? 'POSIX symlinks only' : false },
  async (t) => {
    // With --force the atomic `rename` replaces the LINK, not the file it points
    // to: the operator's managed file keeps the stale credential, the link they
    // set up is gone, and the report claims the keys were written "to" a path
    // that no longer means what they configured.
    const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-setup-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const real = path.join(dir, 'managed.env');
    await writeFile(real, 'FB_ACCESS_TOKEN="EAA-old"\n', { mode: 0o600 });
    const target = path.join(dir, '.env');
    await symlink(real, target);
    const fb = createFakeFbRequest();
    withHappyPath(fb);

    const result = await runSetupToken({
      fbRequest: fb.fn,
      settings: makeSettings(),
      clock: createFakeClock(1_000_000),
      logger: makeLogger(),
      redactor: createFakeRedactor(),
      input: makeInput({ envFilePath: target, force: true }),
    });

    assert.equal(result.write.status, 'failed');
    assert.equal(result.ok, false);
    assert.match(result.write.error ?? '', /symbolic link/);
    assert.match(step(result, 'write').detail ?? '', /--env-file=/);
    assert.match(renderSetupTokenReport(result), /symbolic link/);
    assert.equal((await lstat(target)).isSymbolicLink(), true, 'the link survives');
    assert.equal(await readFile(real, 'utf8'), 'FB_ACCESS_TOKEN="EAA-old"\n');
  },
);

// ---------------------------------------------------------------------------
// The env file has to read back as the value that was written
// ---------------------------------------------------------------------------

/** Every key this flow can write — scoped away so a load cannot leak into the run. */
const ENV_KEYS_UNDER_TEST = [
  'FB_APP_ID',
  'FB_APP_SECRET',
  'FB_ACCESS_TOKEN',
  'FB_SYSTEM_TOKEN',
  'FB_PAGE_ID',
  'FB_PAGE_TOKEN',
] as const;

/**
 * Render `entries` with {@link renderEnvFile}, write them to a real file and
 * load it back through `core`'s `loadEnvFile` — the exact path the server takes
 * on the next start. What comes out of `process.env` is what the server will
 * actually authenticate with.
 */
async function roundTripEnvFile(
  entries: readonly (readonly [string, string])[],
): Promise<{
  readonly seen: Readonly<Record<string, string | undefined>>;
  readonly parsedKeys: readonly string[];
}> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-envfile-'));
  const target = path.join(dir, '.env');
  await writeFile(target, renderEnvFile(entries, 1_000_000), { mode: 0o600 });
  const seen: Record<string, string | undefined> = {};
  let parsedKeys: readonly string[] = [];
  try {
    await withEnv(
      Object.fromEntries(ENV_KEYS_UNDER_TEST.map((key) => [key, undefined])),
      () => {
        parsedKeys = loadEnvFile({ path: target, override: true }).parsedKeys;
        for (const key of ENV_KEYS_UNDER_TEST) seen[key] = process.env[key];
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { seen, parsedKeys };
}

test('a written value containing a backslash or a quote reads back unchanged', async () => {
  // dotenv — the parser `loadEnvFile` hands the file to — strips ONE layer of
  // quotes and expands only \n and \r inside double quotes. It never unescapes
  // \\ or \", so a defensively escaped value loads with the escapes still in it
  // and the server authenticates with a credential Graph never issued.
  const { seen } = await roundTripEnvFile([
    ['FB_PAGE_TOKEN', 'EAA-back\\slash'],
    ['FB_APP_SECRET', 'quote"inside'],
  ]);

  assert.equal(seen.FB_PAGE_TOKEN, 'EAA-back\\slash');
  assert.equal(seen.FB_APP_SECRET, 'quote"inside');
});

test('a value with #, $ or trailing spaces survives and injects no second key', async () => {
  const { seen, parsedKeys } = await roundTripEnvFile([
    ['FB_ACCESS_TOKEN', 'EAA #not-a-comment $HOME  '],
    ['FB_PAGE_ID', 'x\nFB_APP_SECRET=injected'],
  ]);

  assert.equal(seen.FB_ACCESS_TOKEN, 'EAA #not-a-comment $HOME  ');
  assert.equal(seen.FB_PAGE_ID, 'x\nFB_APP_SECRET=injected');
  // A crafted value must never become a second variable in the file it lands in.
  assert.deepEqual([...parsedKeys].sort(), ['FB_ACCESS_TOKEN', 'FB_PAGE_ID']);
  assert.equal(seen.FB_APP_SECRET, undefined);
});

test('a value no env file can represent is refused instead of silently mangled', () => {
  // Both quote styles in one value: a double-quoted line cannot carry the `"`,
  // a single-quoted one cannot carry the `'`, and dotenv unescapes neither. No
  // encoding is left, and writing a file that loads as a DIFFERENT credential is
  // not an acceptable substitute for saying so.
  assert.throws(
    () => renderEnvFile([['FB_APP_SECRET', `mixed'and"quotes`]], 1_000_000),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /FB_APP_SECRET/);
      assert.doesNotMatch(err.message, /mixed/, 'the value must never be printed');
      return true;
    },
  );
});

test('a value ending in a backslash neither swallows the next line nor lets it inject a key', async () => {
  // dotenv matches a single-quoted value with `'(?:\\'|[^'])*'`: a trailing
  // backslash turns the closing quote into an "escaped" one, so the match runs
  // on to the next single quote that ends a line — here the one opening the
  // Page token. Everything in between, following keys included, becomes this
  // value, and the Page token's own lines are then parsed as fresh keys.
  const entries = [
    ['FB_APP_SECRET', 'ends-with\\'],
    ['FB_PAGE_ID', '111'],
    ['FB_PAGE_TOKEN', '\nFB_ACCESS_TOKEN=injected\n"x'],
  ] as const;
  const { seen, parsedKeys } = await roundTripEnvFile(entries);

  assert.equal(seen.FB_APP_SECRET, 'ends-with\\');
  assert.equal(seen.FB_PAGE_ID, '111');
  assert.equal(seen.FB_PAGE_TOKEN, '\nFB_ACCESS_TOKEN=injected\n"x');
  assert.equal(seen.FB_ACCESS_TOKEN, undefined, 'no key may be injected');
  assert.deepEqual([...parsedKeys].sort(), [
    'FB_APP_SECRET',
    'FB_PAGE_ID',
    'FB_PAGE_TOKEN',
  ]);
});

test('a trailing-backslash value that cannot be written bare is refused, not mangled', () => {
  // Every quote style mis-reads a trailing backslash, and a bare value loses its
  // leading/trailing whitespace, `#…` tail and line breaks. No encoding is left.
  for (const value of [' lead-space\\', 'has #hash\\', 'line\nbreak\\']) {
    assert.throws(
      () => renderEnvFile([['FB_PAGE_TOKEN', value]], 1_000_000),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /FB_PAGE_TOKEN/);
        assert.doesNotMatch(err.message, /lead-space|hash|break/);
        return true;
      },
      `expected ${JSON.stringify(value)} to be refused`,
    );
  }
});

test('a carriage return in a value reads back as a carriage return', async () => {
  // dotenv folds every CR / CRLF in the file to LF before parsing, so a raw CR
  // written inside quotes loads back as a line feed — a different credential.
  const { seen } = await roundTripEnvFile([
    ['FB_PAGE_TOKEN', 'EAA\rtail'],
    ['FB_APP_SECRET', 'crlf\r\nend'],
  ]);

  assert.equal(seen.FB_PAGE_TOKEN, 'EAA\rtail');
  assert.equal(seen.FB_APP_SECRET, 'crlf\r\nend');
});

test('a carriage return next to a backslash or a double quote is refused', () => {
  // Single quotes are the only carrier for `\` / `"`, and they cannot carry a CR.
  assert.throws(
    () => renderEnvFile([['FB_APP_SECRET', 'back\\slash\rcr']], 1_000_000),
    /FB_APP_SECRET/,
  );
});

test('--no-write refuses a value no env file can hold instead of promising the write', async () => {
  // A dry run exists to say what the real run will do. The real run refuses
  // this secret; the dry run must not report success and "re-run to write it".
  const { deps, fb, writes } = makeDeps({
    settings: makeSettings({ appSecret: `mixed'and"quotes` }),
    input: { write: false },
  });
  withHappyPath(fb);

  const result = await runSetupToken(deps);

  assert.equal(result.ok, false);
  assert.equal(step(result, 'write').status, 'failed');
  assert.match(step(result, 'write').detail ?? '', /FB_APP_SECRET/);
  assert.doesNotMatch(renderSetupTokenReport(result), /mixed'and/);
  assert.equal(writes.length, 0);
});

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

test('an expires_in that cannot be turned into a date is dropped, not carried', async () => {
  const { fb, deps } = makeDeps();
  withDebugToken(fb, {
    type: 'USER',
    is_valid: true,
    app_id: '1234567890',
    scopes: ['pages_show_list', 'pages_read_engagement'],
    expires_at: 1200,
    user_id: '42',
  });
  // Graph does not have to be malicious for this to arrive, only wrong:
  // `JSON.parse('{"expires_in":1e400}')` yields `Infinity`. `now + Infinity` is
  // `Infinity`, `new Date(Infinity)` is an Invalid Date, and `toISOString()` on
  // one throws `RangeError: Invalid time value` — from inside the report
  // renderer, so the whole setup report is lost over a single bad number.
  fb.on(
    (req) => req.path === '/oauth/access_token',
    fbOk({ access_token: LONG_LIVED, expires_in: Number.POSITIVE_INFINITY }),
  );
  fb.on((req) => req.path === '/me/accounts', fbOk({ data: [] }));

  const result = await runSetupToken(deps);
  // An expiry we cannot express is an expiry we did not get. Saying so is
  // honest and already has wording; inventing one is not.
  assert.equal(result.exchange?.expiresAt, undefined);
  assert.match(renderSetupTokenReport(result), /expiry not reported by Graph/);
});

/** Types a deliberately non-Error throwable so it can be thrown or rejected. */
function notAnError(value: object): Error {
  return value as Error;
}

test('a non-Error { message } or null-prototype rejection from the writer is reported, not thrown', async () => {
  const run = (failure: object): Promise<SetupTokenResult> => {
    const fb = createFakeFbRequest();
    withHappyPath(fb, { pages: [{ id: '111', name: 'Acme Page' }] });
    return runSetupToken({
      fbRequest: fb.fn,
      settings: makeSettings(),
      clock: createFakeClock(1_000_000),
      logger: makeLogger(),
      redactor: createFakeRedactor(),
      input: makeInput(),
      envFilePath: ENV_PATH,
      fileExists: () => Promise.resolve(false),
      writeEnvFile: (): Promise<AtomicWriteResult> => Promise.reject(notAnError(failure)),
    });
  };

  const plain = await run({ message: 'EROFS: read-only file system' });
  assert.equal(plain.write.status, 'failed');
  assert.equal(plain.write.error, 'EROFS: read-only file system');

  const bare = await run(Object.create(null) as object);
  assert.equal(bare.write.status, 'failed');
  assert.equal(bare.write.error, 'unknown error (no message)');
});
