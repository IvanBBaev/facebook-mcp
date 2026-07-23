// Tests for the `core` tool package (task F16): the four read-only tools
// (facebook_whoami / facebook_list_pages / facebook_get_page / facebook_usage)
// and the package-level invariants (always-on, read-only, server-version
// injection). Every Graph call is served by `createFakeFbRequest` — the network
// fence guarantees no real fetch escapes. Placeholder tokens only; never a real
// secret in a fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFakeClock,
  createFakeFbRequest,
  createFakePageResolver,
  createFakeRedactor,
  createMemoryJournal,
  fbErr,
  fbOk,
  type FakeFbRequest,
  type FakePageResolver,
} from '../core/fakes/index.js';
import type {
  JsonRequest,
  Logger,
  Settings,
  ToolContext,
  ToolResult,
  ToolSpec,
} from '../core/index.js';
import { createCorePackage } from './core.js';

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const SERVER_VERSION = '9.9.9';

/** A recording no-op logger (satisfies the contract without side effects). */
function makeLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
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

interface CtxParts {
  readonly fb: FakeFbRequest;
  readonly pages: FakePageResolver;
  readonly ctx: ToolContext;
}

function makeCtx(
  opts: {
    settings?: Settings;
    pages?: FakePageResolver;
    nowMs?: number;
    secrets?: readonly string[];
  } = {},
): CtxParts {
  const fb = createFakeFbRequest();
  const pages = opts.pages ?? createFakePageResolver();
  const clock = createFakeClock(opts.nowMs ?? 1000);
  const settings = opts.settings ?? makeSettings();
  const ctx: ToolContext = {
    settings,
    fbRequest: fb.fn,
    pages,
    logger: makeLogger(),
    redactor: createFakeRedactor({ secrets: opts.secrets }),
    clock,
    journal: createMemoryJournal(clock),
  };
  return { fb, pages, ctx };
}

/** Look a tool up in the built package by name (fails loudly if renamed). */
function tool(name: string): ToolSpec {
  const spec = createCorePackage({ serverVersion: SERVER_VERSION }).tools.find(
    (t) => t.name === name,
  );
  assert.ok(spec, `expected a tool named ${name}`);
  return spec;
}

/** Parse a text-only ToolResult body as an object. */
function body(result: ToolResult): Record<string, unknown> {
  const text = result.content[0]?.text ?? '';
  return JSON.parse(text) as Record<string, unknown>;
}

function lastJson(fb: FakeFbRequest): JsonRequest {
  const req = fb.lastRequest();
  if (req === undefined || req.protocol !== 'json') {
    throw new Error(`expected a json request, got ${req?.protocol ?? 'none'}`);
  }
  return req;
}

// ---------------------------------------------------------------------------
// Package invariants
// ---------------------------------------------------------------------------

test('createCorePackage builds the always-on read-only package with four tools', () => {
  const pkg = createCorePackage({ serverVersion: SERVER_VERSION });
  assert.equal(pkg.name, 'core');
  assert.equal(pkg.enabledByDefault, true);
  assert.deepEqual(
    pkg.tools.map((t) => t.name),
    ['facebook_whoami', 'facebook_list_pages', 'facebook_get_page', 'facebook_usage'],
  );
  for (const t of pkg.tools) {
    assert.equal(t.annotations.readOnlyHint, true, `${t.name} must be read-only`);
    assert.equal(t.writeTier, undefined, `${t.name} must carry no write tier`);
    assert.equal(t.annotations.destructiveHint, false);
    assert.equal(t.annotations.idempotentHint, true);
    assert.equal(t.annotations.openWorldHint, true);
  }
});

test('only the server-owned envelopes (whoami, usage) declare an outputSchema', () => {
  const byName = new Map(
    createCorePackage({ serverVersion: SERVER_VERSION }).tools.map((t) => [t.name, t]),
  );
  assert.ok(byName.get('facebook_whoami')?.outputSchema, 'whoami has outputSchema');
  assert.ok(byName.get('facebook_usage')?.outputSchema, 'usage has outputSchema');
  assert.equal(byName.get('facebook_list_pages')?.outputSchema, undefined);
  assert.equal(byName.get('facebook_get_page')?.outputSchema, undefined);
});

// ---------------------------------------------------------------------------
// facebook_whoami
// ---------------------------------------------------------------------------

test('whoami classifies a valid non-expiring system-user token (neverExpiring)', async () => {
  const { fb, ctx } = makeCtx({
    settings: makeSettings({ accessToken: 'EAA-runtime' }),
  });
  fb.on(
    (req) => req.path === '/debug_token',
    fbOk({
      data: {
        type: 'SYSTEM_USER',
        is_valid: true,
        app_id: '123',
        scopes: ['pages_show_list', 'pages_read_engagement'],
        expires_at: 0, // 0 ⇒ never-expiring
        user_id: '999',
      },
    }),
  );

  const result = await tool('facebook_whoami').handler({}, ctx);
  const sc = result.structuredContent;
  assert.ok(sc, 'whoami emits structuredContent (server-owned envelope)');
  assert.equal(result.isError, undefined);
  assert.deepEqual(sc.server, {
    name: 'facebook-mcp',
    version: SERVER_VERSION, // injected, not read from package.json
    apiVersion: 'v23.0',
  });
  assert.deepEqual(sc.token, {
    type: 'SYSTEM_USER',
    valid: true,
    appId: '123',
    scopes: ['pages_show_list', 'pages_read_engagement'],
    neverExpiring: true,
    actingUserId: '999',
  });
  // The token under inspection was passed as `input_token`.
  assert.equal(lastJson(fb).params?.input_token, 'EAA-runtime');
});

test('whoami uses the app access token ({app-id}|{app-secret}) as the debug credential', async () => {
  const { fb, ctx } = makeCtx({
    settings: makeSettings({
      accessToken: 'EAA-runtime',
      appId: '111',
      appSecret: 'sekret',
    }),
  });
  fb.on(
    (req) => req.path === '/debug_token',
    fbOk({ data: { type: 'USER', is_valid: true, scopes: [] } }),
  );

  await tool('facebook_whoami').handler({}, ctx);
  assert.equal(lastJson(fb).token, '111|sekret');
});

test('whoami reports a valid USER token with an expiry (not never-expiring)', async () => {
  const { fb, ctx } = makeCtx({
    settings: makeSettings({ accessToken: 'EAA-runtime' }),
  });
  fb.on(
    (req) => req.path === '/debug_token',
    fbOk({
      data: {
        type: 'USER',
        is_valid: true,
        scopes: ['pages_show_list'],
        expires_at: 4_000, // seconds -> 4_000_000 ms
        data_access_expires_at: 5_000,
        user_id: 'u1',
      },
    }),
  );

  const sc = (await tool('facebook_whoami').handler({}, ctx)).structuredContent;
  assert.deepEqual(sc?.token, {
    type: 'USER',
    valid: true,
    scopes: ['pages_show_list'],
    neverExpiring: false,
    expiresAt: 4_000_000,
    dataAccessExpiresAt: 5_000_000,
    actingUserId: 'u1',
  });
});

test('whoami returns a schema-valid error envelope when no token is configured', async () => {
  const { fb, ctx } = makeCtx({ settings: makeSettings() });

  const result = await tool('facebook_whoami').handler({}, ctx);
  assert.equal(result.isError, true);
  const sc = result.structuredContent;
  assert.deepEqual(sc?.server, {
    name: 'facebook-mcp',
    version: SERVER_VERSION,
    apiVersion: 'v23.0',
  });
  assert.deepEqual(sc?.token, {
    type: 'UNKNOWN',
    valid: false,
    scopes: [],
    neverExpiring: false,
  });
  assert.match(String(sc?.error), /No access token configured/);
  // No Graph call is made on the token-less path.
  assert.equal(fb.calls.length, 0);
});

test('whoami surfaces a debug_token failure as a redacted error envelope', async () => {
  const { fb, ctx } = makeCtx({
    settings: makeSettings({ accessToken: 'EAA-runtime' }),
  });
  fb.on((req) => req.path === '/debug_token', fbErr(new Error('graph exploded')));

  const result = await tool('facebook_whoami').handler({}, ctx);
  assert.equal(result.isError, true);
  const sc = result.structuredContent;
  assert.equal((sc?.token as { valid: boolean }).valid, false);
  assert.match(String(sc?.error), /graph exploded/);
});

// ---------------------------------------------------------------------------
// facebook_list_pages
// ---------------------------------------------------------------------------

test('list_pages surfaces token PRESENCE as a boolean and never leaks the token value', async () => {
  const PAGE_TOKEN = 'EAA-PAGE-SECRET-0123456789';
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.path === '/me/accounts',
    fbOk({
      data: [
        {
          id: 'p1',
          name: 'Page One',
          category: 'Brand',
          tasks: ['MANAGE', 'CREATE_CONTENT'],
          access_token: PAGE_TOKEN,
        },
        { id: 'p2', name: 'Page Two' },
      ],
    }),
  );

  const result = await tool('facebook_list_pages').handler({}, ctx);
  assert.equal(result.structuredContent, undefined, 'ordinary tool is text-only');
  const parsed = body(result);
  assert.equal(parsed.count, 2);
  assert.deepEqual(parsed.pages, [
    {
      id: 'p1',
      name: 'Page One',
      category: 'Brand',
      tasks: ['MANAGE', 'CREATE_CONTENT'],
      hasToken: true,
    },
    { id: 'p2', name: 'Page Two', tasks: [], hasToken: false },
  ]);
  // The raw Page token must never appear anywhere in the rendered result.
  assert.equal(result.content[0]?.text.includes(PAGE_TOKEN), false);
  // The request asks /me/accounts on the graph host.
  const req = lastJson(fb);
  assert.equal(req.path, '/me/accounts');
  assert.equal(req.host, 'graph');
});

test('list_pages tolerates an empty/absent edge (count 0)', async () => {
  const { fb, ctx } = makeCtx();
  fb.on((req) => req.path === '/me/accounts', fbOk({}));

  const parsed = body(await tool('facebook_list_pages').handler({}, ctx));
  assert.equal(parsed.count, 0);
  assert.deepEqual(parsed.pages, []);
});

// ---------------------------------------------------------------------------
// facebook_get_page
// ---------------------------------------------------------------------------

test('get_page resolves a named profile and fetches that Page node with its token', async () => {
  const pages = createFakePageResolver({
    default: { pageId: '100', name: 'Default', token: 'EAA-DEF' },
    pages: { 'brand-a': { pageId: '200', name: 'Brand A', token: 'EAA-BRAND' } },
  });
  const { fb, ctx } = makeCtx({ pages });
  fb.on(
    (req) => req.path === '/200',
    fbOk({ id: '200', name: 'Brand A Page', fan_count: 10, is_published: true }),
  );

  const parsed = body(
    await tool('facebook_get_page').handler({ profile: 'brand-a' }, ctx),
  );
  assert.deepEqual(pages.resolveCalls, ['brand-a']);
  assert.equal(parsed.profile, 'brand-a');
  assert.equal(parsed.pageId, '200');
  assert.equal(parsed.name, 'Brand A'); // resolver display name
  assert.deepEqual(parsed.page, {
    id: '200',
    name: 'Brand A Page',
    fan_count: 10,
    is_published: true,
  });
  const req = lastJson(fb);
  assert.equal(req.path, '/200');
  assert.equal(req.token, 'EAA-BRAND'); // per-page token (C1)
  assert.ok(String(req.params?.fields).includes('followers_count'));
});

test('get_page with no profile resolves the default Page and echoes profile null', async () => {
  const pages = createFakePageResolver({
    default: { pageId: '100', name: 'Default', token: 'EAA-DEF' },
  });
  const { fb, ctx } = makeCtx({ pages });
  fb.on((req) => req.path === '/100', fbOk({ id: '100', name: 'Default Page' }));

  const parsed = body(await tool('facebook_get_page').handler({}, ctx));
  assert.deepEqual(pages.resolveCalls, [undefined]);
  assert.equal(parsed.profile, null);
  assert.equal(parsed.pageId, '100');
  assert.equal(lastJson(fb).token, 'EAA-DEF');
});

// ---------------------------------------------------------------------------
// facebook_usage
// ---------------------------------------------------------------------------

test('usage parses the rate-limit headers from a probe and marks hasData', async () => {
  const { fb, ctx } = makeCtx({ nowMs: 1000 });
  fb.on(
    (req) => req.path === '/me',
    fbOk(
      { id: '123' },
      { 'x-app-usage': '{"call_count":25,"total_cputime":3,"total_time":8}' },
    ),
  );

  const result = await tool('facebook_usage').handler({}, ctx);
  const sc = result.structuredContent;
  assert.ok(sc, 'usage emits structuredContent (server-owned envelope)');
  assert.equal(sc.hasData, true);
  assert.deepEqual(sc.usage, {
    appUsagePct: 25,
    seenAt: 1000,
    raw: { 'x-app-usage': '{"call_count":25,"total_cputime":3,"total_time":8}' },
  });
  // Probe is a cheap /me?fields=id call.
  const req = lastJson(fb);
  assert.equal(req.path, '/me');
  assert.equal(req.params?.fields, 'id');
});

test('usage returns an honest no-data envelope (with a note) when no headers are present', async () => {
  const { fb, ctx } = makeCtx({ nowMs: 2000 });
  fb.on((req) => req.path === '/me', fbOk({ id: '123' }));

  const sc = (await tool('facebook_usage').handler({}, ctx)).structuredContent;
  assert.equal(sc?.hasData, false);
  assert.match(String(sc?.note), /No usage headers observed/);
  assert.deepEqual(sc?.usage, { seenAt: 2000, raw: {} });
});

test('usage does not throw when the probe request fails; it reports no data', async () => {
  const { fb, ctx } = makeCtx({ nowMs: 3000 });
  fb.on((req) => req.path === '/me', fbErr(new Error('network down')));

  const result = await tool('facebook_usage').handler({}, ctx);
  assert.equal(result.isError, undefined, 'a failed probe is not a tool error');
  const sc = result.structuredContent;
  assert.equal(sc?.hasData, false);
  assert.deepEqual(sc?.usage, { seenAt: 3000, raw: {} });
});
