// Tests for the `core` tool package (task F16): the four read-only tools
// (facebook_whoami / facebook_list_pages / facebook_get_page / facebook_usage)
// and the package-level invariants (always-on, read-only, server + SDK version
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
import { createFbRequest, GraphApiError } from '../core/index.js';
import type {
  JsonRequest,
  Logger,
  Settings,
  ToolContext,
  ToolResult,
  ToolSpec,
} from '../core/index.js';
import { withFetch, type FetchMock } from '../testing/index.js';
import { createCorePackage } from './core.js';

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const SERVER_VERSION = '9.9.9';
const SDK_VERSION = '8.8.8';

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
  const spec = createCorePackage({
    serverVersion: SERVER_VERSION,
    sdkVersion: SDK_VERSION,
  }).tools.find((t) => t.name === name);
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
  const pkg = createCorePackage({
    serverVersion: SERVER_VERSION,
    sdkVersion: SDK_VERSION,
  });
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
    createCorePackage({
      serverVersion: SERVER_VERSION,
      sdkVersion: SDK_VERSION,
    }).tools.map((t) => [t.name, t]),
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
    sdkVersion: SDK_VERSION, // injected, not resolved from node_modules
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

test('whoami does not claim "never expires" when Graph never said when (wave 9)', async () => {
  const { fb, ctx } = makeCtx({
    settings: makeSettings({ accessToken: 'EAA-runtime' }),
  });
  // A valid token whose `debug_token` answer carries NO `expires_at` at all.
  // Nothing on the wire says this credential is non-expiring; the only true
  // statement is that its expiry is unknown, and that must be visible to the
  // caller rather than dropped.
  fb.on(
    (req) => req.path === '/debug_token',
    fbOk({
      data: {
        type: 'SYSTEM_USER',
        is_valid: true,
        scopes: ['pages_show_list'],
        user_id: '999',
      },
    }),
  );

  const result = await tool('facebook_whoami').handler({}, ctx);
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent?.token, {
    type: 'SYSTEM_USER',
    valid: true,
    scopes: ['pages_show_list'],
    neverExpiring: false,
    expiryUnknown: true,
    actingUserId: '999',
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
    sdkVersion: SDK_VERSION,
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

test('whoami reports WHY Graph rejected the token, not merely that it did', async () => {
  const { fb, ctx } = makeCtx({
    settings: makeSettings({ accessToken: 'EAA-runtime' }),
  });
  // Graph rejects a token INSIDE a 200: `is_valid:false` with the cause in
  // `data.error`. That — not a thrown HTTP error — is how an expired, a revoked
  // and a wrong-app token all actually arrive, so this branch, not the catch, is
  // where most rejections land.
  fb.on(
    (req) => req.path === '/debug_token',
    fbOk({
      data: {
        type: 'USER',
        is_valid: false,
        scopes: [],
        error: { message: 'Session has expired', code: 190, subcode: 463 },
      },
    }),
  );

  const result = await tool('facebook_whoami').handler({}, ctx);
  const sc = result.structuredContent;
  assert.equal((sc?.token as { valid: boolean }).valid, false);
  // Without the cause the three failures read identically, and the operator
  // cannot tell whether to re-issue, re-grant, or re-check which app they
  // configured — from the tool whose description says to run it FIRST.
  assert.match(String(sc?.error), /Session has expired/);
  assert.match(String(sc?.error), /code 190/);
  assert.match(String(sc?.error), /subcode 463/);
});

test('whoami leaves `error` off a valid token even if Graph left a stale one in the body', async () => {
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
        error: { message: 'ignore me', code: 1 },
      },
    }),
  );

  const result = await tool('facebook_whoami').handler({}, ctx);
  assert.equal(result.structuredContent?.error, undefined);
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

test('list_pages survives a 2xx body Graph did not shape as an account list', async () => {
  // `fbRequest<T>` CASTS the parsed body to `T` (`data as T`, src/core/http.ts):
  // the declared `{ data?: RawPageAccount[] }` is a hope, not a guarantee. A 2xx
  // can arrive with no body at all (parsed as `undefined`), as a raw string, or
  // with a `data` member that is not an array — and every one of those used to
  // reach `res.data.data` or `.map` and throw a TypeError on a response the
  // transport had already accepted. The operator is then told the Page listing
  // failed, which is a different and much more alarming statement than "Graph
  // answered in a shape this tool does not recognise".
  const bodies: readonly unknown[] = [
    undefined,
    'OK',
    { data: 'not-an-array' },
    { data: null },
  ];
  for (const shaped of bodies) {
    const { fb, ctx } = makeCtx();
    fb.on((req) => req.path === '/me/accounts', fbOk(shaped));
    const parsed = body(await tool('facebook_list_pages').handler({}, ctx));
    assert.equal(parsed.count, 0, `count for ${JSON.stringify(shaped) ?? 'undefined'}`);
    assert.deepEqual(
      parsed.pages,
      [],
      `pages for ${JSON.stringify(shaped) ?? 'undefined'}`,
    );
  }
});

test('list_pages drops an account entry it cannot read instead of throwing on it', async () => {
  // The entries of a well-formed `data` array are cast too. A `null` entry makes
  // the token-presence probe throw, and a numeric `id` would be handed on to a
  // model that will spend it as a Page id on the next call. Neither is worth
  // failing the whole listing over, and neither is worth passing on: the entries
  // that ARE readable are the answer, and a page with no usable id is not one.
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.path === '/me/accounts',
    fbOk({
      data: [
        null,
        7,
        { id: 12345, name: 'Numeric Id' },
        { id: 'p9', name: 'Readable', tasks: ['MANAGE', 3] },
      ],
    }),
  );

  const parsed = body(await tool('facebook_list_pages').handler({}, ctx));
  assert.deepEqual(
    parsed.pages,
    [{ id: 'p9', name: 'Readable', tasks: ['MANAGE'], hasToken: false }],
    'only the readable entry survives, and its task list keeps only real task names',
  );
  assert.equal(parsed.count, 1, 'count reports what was returned, not what arrived');
});

test('list_pages says the listing was CUT instead of passing one window off as the whole set', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.path === '/me/accounts',
    fbOk({
      data: [{ id: 'p1', name: 'Page One', tasks: ['MANAGE'] }],
      // Graph's own evidence that this is one window of a longer edge. The
      // shaper deletes every `paging` object structurally (C3 / CC-PAGE-4), so
      // this has to be read off the raw body or it is gone before anyone looks.
      paging: {
        cursors: { after: 'CUR' },
        next: 'https://graph.facebook.com/v23.0/me/accounts?after=CUR',
      },
    }),
  );

  const parsed = body(await tool('facebook_list_pages').handler({}, ctx));

  // An operator whose Page sits outside the window must read "the listing was
  // cut", never "your Page does not exist".
  assert.equal(parsed.hasMore, true);
  assert.match(String(parsed.note), /MORE Pages/);
  assert.match(String(parsed.note), /raw Page ID/);
  assert.equal(parsed.count, 1, 'count is the size of this window, not of the set');
  // And the window is asked for explicitly — Graph's own default edge page is 25.
  assert.equal(lastJson(fb).params?.limit, 100);
  assert.equal(
    lastJson(fb).params?.fields,
    'id,name,category,tasks,access_token',
    'the field set is unchanged by the paging fix',
  );
});

test('list_pages reports a complete listing as complete', async () => {
  const { fb, ctx } = makeCtx();
  // No `next` cursor ⇒ Graph has nothing more to give, and a note here would be
  // a warning about a problem that does not exist.
  fb.on(
    (req) => req.path === '/me/accounts',
    fbOk({ data: [{ id: 'p1', tasks: [] }], paging: { cursors: { after: 'CUR' } } }),
  );

  const parsed = body(await tool('facebook_list_pages').handler({}, ctx));
  assert.equal(parsed.hasMore, false);
  assert.equal(parsed.note, undefined);
});

test('list_pages treats an unreadable `paging` as no evidence of more, not as a throw', async () => {
  // `paging` is cast off the wire like everything else (CC-NET-2): a non-record
  // `paging`, or a `next` that is not a string, must not fail a listing that is
  // otherwise perfectly readable.
  for (const paging of [null, 'nope', 42, [], { next: 7 }, { next: '' }]) {
    const { fb, ctx } = makeCtx();
    fb.on((req) => req.path === '/me/accounts', fbOk({ data: [{ id: 'p1' }], paging }));
    const parsed = body(await tool('facebook_list_pages').handler({}, ctx));
    assert.equal(
      parsed.hasMore,
      false,
      `paging ${JSON.stringify(paging) ?? 'undefined'}`,
    );
    assert.equal(parsed.count, 1);
  }
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
  // The probe SUCCEEDED here, so "idle" is an honest reading — and the note must
  // not blame a probe that did not fail.
  assert.doesNotMatch(String(sc?.note), /probe FAILED/);
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

test('usage reports a FAILED probe as unknown usage, never as an idle app', async () => {
  const { fb, ctx } = makeCtx({ nowMs: 3000 });
  fb.on((req) => req.path === '/me', fbErr(new Error('network down')));

  const note = String(
    (await tool('facebook_usage').handler({}, ctx)).structuredContent?.note,
  );

  // An expired token and an idle app produce the SAME empty header map, so the
  // note is the only thing that tells them apart. Saying "idle" here sends the
  // operator hunting a quota problem instead of the auth/network fault.
  assert.match(note, /The rate-limit probe FAILED/);
  assert.match(note, /usage figures are unknown/);
  assert.match(note, /not evidence that the app is idle/);
  assert.match(note, /facebook_whoami/, 'the note points at the tool that diagnoses it');
  assert.match(note, /Probe error: network down/);
  assert.doesNotMatch(note, /may be idle or Graph omitted them/);
});

test('usage redacts a secret carried by the probe error before echoing it', async () => {
  const TOKEN = 'EAA-probe-secret-999';
  const { fb, ctx } = makeCtx({ nowMs: 3000, secrets: [TOKEN] });
  fb.on(
    (req) => req.path === '/me',
    // Deliberately NOT an `access_token=…` occurrence: that shape is neutralized
    // structurally by the shaper, which would mask a missing redaction here.
    fbErr(new Error(`Invalid OAuth token ${TOKEN} for this app`)),
  );

  const note = String(
    (await tool('facebook_usage').handler({}, ctx)).structuredContent?.note,
  );

  assert.doesNotMatch(note, /EAA-probe-secret-999/, 'no raw credential in the note');
  assert.match(note, /Invalid OAuth token \[REDACTED\] for this app/);
});

test('usage caps the echoed probe error so the un-truncated envelope stays small', async () => {
  const { fb, ctx } = makeCtx({ nowMs: 3000 });
  fb.on((req) => req.path === '/me', fbErr(new Error('x'.repeat(5000))));

  const result = await tool('facebook_usage').handler({}, ctx);
  const note = String(result.structuredContent?.note);

  // shapeEnvelope deliberately does NOT truncate a server-owned envelope, so the
  // cap has to live here or a 5 KB Graph error becomes the whole result.
  assert.ok(note.length < 500, `the note grew unbounded: ${String(note.length)} chars`);
  assert.match(note, /…$/, 'a trimmed reason says so rather than ending mid-text');
  assert.equal(result.isError, undefined, 'still not a tool error');
});

// ---------------------------------------------------------------------------
// Non-Error rejections (a library that rejects with a plain object)
// ---------------------------------------------------------------------------

/** A rejection value that is not an `Error` — the fake's type says Error, the wire does not. */
function notAnError(value: object): Error {
  return value as Error;
}

test('whoami keeps the text of a non-Error { message } rejection and survives a null-prototype one', async () => {
  const plain = makeCtx({ settings: makeSettings({ accessToken: 'EAA-runtime' }) });
  plain.fb.on(
    (req) => req.path === '/debug_token',
    fbErr(notAnError({ message: 'library said no' })),
  );
  const result = await tool('facebook_whoami').handler({}, plain.ctx);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error, 'library said no');

  const bare = makeCtx({ settings: makeSettings({ accessToken: 'EAA-runtime' }) });
  bare.fb.on(
    (req) => req.path === '/debug_token',
    fbErr(notAnError(Object.create(null) as object)),
  );
  const bareResult = await tool('facebook_whoami').handler({}, bare.ctx);
  assert.equal(bareResult.isError, true);
  assert.equal(bareResult.structuredContent?.error, 'unknown error (no message)');
});

test('usage keeps the text of a non-Error { message } probe rejection and survives a null-prototype one', async () => {
  const plain = makeCtx({ nowMs: 3000 });
  plain.fb.on(
    (req) => req.path === '/me',
    fbErr(notAnError({ message: 'socket reset' })),
  );
  const note = String(
    (await tool('facebook_usage').handler({}, plain.ctx)).structuredContent?.note,
  );
  assert.match(note, /Probe error: socket reset$/);

  const bare = makeCtx({ nowMs: 3000 });
  bare.fb.on(
    (req) => req.path === '/me',
    fbErr(notAnError(Object.create(null) as object)),
  );
  const bareNote = String(
    (await tool('facebook_usage').handler({}, bare.ctx)).structuredContent?.note,
  );
  assert.match(bareNote, /Probe error: unknown error \(no message\)$/);
});

// ---------------------------------------------------------------------------
// facebook_usage — wave 14
// ---------------------------------------------------------------------------

test('usage names a THROTTLED probe as a rate limit, not as a token/connectivity fault', async () => {
  const { fb, ctx } = makeCtx({ nowMs: 3000 });
  fb.on(
    (req) => req.path === '/me',
    fbErr(
      new GraphApiError('(#4) Application request limit reached', {
        code: 4,
        httpStatus: 400,
        action: {
          category: 'rate_limit',
          retryable: true,
          nextTool: 'facebook_usage',
          operatorText: 'Application-level rate limit reached (code 4).',
          retryAfterMs: 300_000,
        },
      }),
    ),
  );

  const result = await tool('facebook_usage').handler({}, ctx);
  const sc = result.structuredContent;
  const note = String(sc?.note);

  // Every rate-limit error in the matrix names facebook_usage as the next tool,
  // and an app-level throttle refuses the /me probe too. Telling the caller to
  // "check the token and connectivity" here sends it to facebook_whoami for an
  // auth fault that does not exist while the real answer — throttled — is lost.
  assert.equal(result.isError, undefined, 'still a diagnostic, not a tool error');
  assert.equal(sc?.hasData, false);
  assert.doesNotMatch(note, /Check the token and connectivity/);
  assert.match(note, /rate limit/i);
  assert.equal(sc?.throttled, true, 'the envelope says the app is throttled');
  assert.equal(sc?.retryAfterMs, 300_000, 'the surfaced cool-down reaches the caller');
  assert.match(note, /Probe error: \(#4\) Application request limit reached/);
});

test('usage keeps the token/connectivity note for a probe that failed for another reason', async () => {
  const { fb, ctx } = makeCtx({ nowMs: 3000 });
  fb.on(
    (req) => req.path === '/me',
    fbErr(
      new GraphApiError('Error validating access token', {
        code: 190,
        httpStatus: 400,
        action: { category: 'auth', retryable: false, operatorText: 'token dead' },
      }),
    ),
  );

  const sc = (await tool('facebook_usage').handler({}, ctx)).structuredContent;
  assert.equal(sc?.throttled, undefined);
  assert.equal(sc?.retryAfterMs, undefined);
  assert.match(String(sc?.note), /Check the token and connectivity/);
});

test('usage says a present-but-unreadable usage header is UNKNOWN, not silently absent', async () => {
  const { fb, ctx } = makeCtx({ nowMs: 4000 });
  fb.on((req) => req.path === '/me', fbOk({ id: '123' }, { 'x-app-usage': 'not-json{' }));

  const sc = (await tool('facebook_usage').handler({}, ctx)).structuredContent;
  // `hasData:true` with no percentage and no note reads as "headers seen, all
  // quiet" — the caller must be told the figure could not be read.
  assert.equal(sc?.hasData, true);
  assert.deepEqual(sc?.usage, { seenAt: 4000, raw: { 'x-app-usage': 'not-json{' } });
  assert.match(String(sc?.note), /x-app-usage/);
  assert.match(String(sc?.note), /unknown/i);
});

test('usage names only the unreadable header when another one parsed', async () => {
  const { fb, ctx } = makeCtx({ nowMs: 4000 });
  fb.on(
    (req) => req.path === '/me',
    fbOk(
      { id: '123' },
      {
        'x-app-usage': '{"call_count":40}',
        'x-business-use-case-usage': '"garbage"',
      },
    ),
  );

  const sc = (await tool('facebook_usage').handler({}, ctx)).structuredContent;
  const usage = sc?.usage as Record<string, unknown>;
  assert.equal(usage.appUsagePct, 40);
  const note = String(sc?.note);
  assert.match(note, /x-business-use-case-usage/);
  assert.doesNotMatch(note, /x-app-usage/);
});

// ---------------------------------------------------------------------------
// Wave 16 (lane B): figures carried by a refused probe, Graph identity on whoami
// ---------------------------------------------------------------------------

/**
 * A REAL `GraphApiError` produced by the real client for one Graph error
 * response (no retries), so the usage side table `usageOfGraphError` reads is
 * populated exactly as it is in production. The fake `fbErr` cannot express
 * that: the snapshot lives in a WeakMap private to `src/core/http.ts`.
 */
async function graphErrorFromWire(
  status: number,
  error: Record<string, unknown>,
  headers: Record<string, string>,
  nowMs: number,
): Promise<GraphApiError> {
  return withFetch(async (mock: FetchMock) => {
    mock.enqueue({ status, json: { error }, headers });
    const fbRequest = createFbRequest({
      settings: makeSettings({ accessToken: 'EAA-runtime' }),
      clock: createFakeClock(nowMs),
      redactor: createFakeRedactor(),
      logger: makeLogger(),
      retry: { maxRetries: 0 },
    });
    const err = await fbRequest({
      protocol: 'json',
      host: 'graph',
      method: 'GET',
      path: '/me',
    }).then(
      () => assert.fail('expected a rejection'),
      (e: unknown) => e,
    );
    assert.ok(err instanceof GraphApiError);
    return err;
  });
}

const THROTTLE_APP_USAGE = '{"call_count":100,"total_cputime":40,"total_time":35}';

test('usage reports the figures a THROTTLED probe\u2019s refusal carried, not "unavailable"', async () => {
  const refusal = await graphErrorFromWire(
    400,
    { message: 'Application request limit reached', type: 'OAuthException', code: 4 },
    { 'x-app-usage': THROTTLE_APP_USAGE },
    2500,
  );
  const { fb, ctx } = makeCtx({ nowMs: 3000 });
  fb.on((req) => req.path === '/me', fbErr(refusal));

  const result = await tool('facebook_usage').handler({}, ctx);
  const sc = result.structuredContent;
  const note = String(sc?.note);

  // Graph names the full bucket ON the refusing response; that response is the
  // only place the figures exist while the app is throttled.
  assert.equal(result.isError, undefined, 'still a diagnostic, not a tool error');
  assert.equal(sc?.throttled, true);
  assert.equal(sc?.hasData, true, 'the refusal carried usage headers');
  assert.deepEqual(sc?.usage, {
    appUsagePct: 100,
    seenAt: 2500,
    raw: { 'x-app-usage': THROTTLE_APP_USAGE },
  });
  assert.match(note, /rate limit/i);
  assert.doesNotMatch(note, /unavailable/, 'the figures are known; do not say otherwise');
  assert.match(note, /refus/i);
});

test('usage keeps the figures an otherwise-failed probe\u2019s error response carried', async () => {
  const refusal = await graphErrorFromWire(
    400,
    { message: 'Error validating access token', type: 'OAuthException', code: 190 },
    { 'x-app-usage': '{"call_count":71,"total_cputime":3,"total_time":3}' },
    2600,
  );
  const { fb, ctx } = makeCtx({ nowMs: 3000 });
  fb.on((req) => req.path === '/me', fbErr(refusal));

  const sc = (await tool('facebook_usage').handler({}, ctx)).structuredContent;
  const note = String(sc?.note);

  assert.equal(sc?.hasData, true);
  assert.equal((sc?.usage as Record<string, unknown>).appUsagePct, 71);
  assert.equal(sc?.throttled, undefined);
  // The probe still failed and the token is still the thing to fix...
  assert.match(note, /probe FAILED/);
  assert.match(note, /facebook_whoami/);
  // ...but the figures are not "unknown": Graph sent them on the error.
  assert.doesNotMatch(note, /usage figures are unknown/);
});

test('usage still says the figures are unavailable when a throttled refusal carried no header', async () => {
  const refusal = await graphErrorFromWire(
    400,
    { message: 'Application request limit reached', type: 'OAuthException', code: 4 },
    {},
    2500,
  );
  const { fb, ctx } = makeCtx({ nowMs: 3000 });
  fb.on((req) => req.path === '/me', fbErr(refusal));

  const sc = (await tool('facebook_usage').handler({}, ctx)).structuredContent;
  assert.equal(sc?.throttled, true);
  assert.equal(sc?.hasData, false);
  assert.deepEqual(sc?.usage, { seenAt: 3000, raw: {} });
  assert.match(String(sc?.note), /figures are unavailable/);
});

test('whoami keeps the Graph identity of a debug_token failure (code, subcode, Meta\u2019s text)', async () => {
  const { fb, ctx } = makeCtx({
    settings: makeSettings({ accessToken: 'EAA-runtime' }),
  });
  fb.on(
    (req) => req.path === '/debug_token',
    fbErr(
      new GraphApiError('Error validating access token: Session has expired', {
        code: 190,
        subcode: 463,
        type: 'OAuthException',
        httpStatus: 400,
        fbtraceId: 'AtraceWhoami',
        userTitle: 'Session expired',
        userMessage: 'Your session has expired. Please log in again.',
      }),
    ),
  );

  const result = await tool('facebook_whoami').handler({}, ctx);
  const sc = result.structuredContent;
  assert.equal(result.isError, true);
  // 190/463 (expired) and 190/460 (password changed) need different fixes; the
  // subcode and Meta's own sentence are the only things that tell them apart.
  assert.deepEqual(sc?.graphError, {
    code: 190,
    subcode: 463,
    type: 'OAuthException',
    httpStatus: 400,
    fbtraceId: 'AtraceWhoami',
    userTitle: 'Session expired',
    userMessage: 'Your session has expired. Please log in again.',
  });
});

test('whoami adds no graphError for a non-Graph debug_token failure', async () => {
  const { fb, ctx } = makeCtx({
    settings: makeSettings({ accessToken: 'EAA-runtime' }),
  });
  fb.on((req) => req.path === '/debug_token', fbErr(new Error('socket hang up')));

  const sc = (await tool('facebook_whoami').handler({}, ctx)).structuredContent;
  assert.equal(sc?.graphError, undefined);
  assert.equal(sc?.error, 'socket hang up');
});

test('whoami marks validity and scopes as never observed when debug_token did not answer (wave 24)', async () => {
  // A network fault reaches the catch path, whose placeholder reads
  // `valid:false, scopes:[]` — word for word the answer for a token Graph ruled
  // dead with nothing granted. A model reading it tells the operator to re-issue
  // a healthy token. The payload must say those two fields were never checked.
  const { fb, ctx } = makeCtx({
    settings: makeSettings({ accessToken: 'EAA-runtime' }),
  });
  fb.on(
    (req) => req.path === '/debug_token',
    fbErr(
      new GraphApiError(
        'network request failed: getaddrinfo ENOTFOUND graph.facebook.com',
        {
          code: 0,
          httpStatus: 0,
        },
      ),
    ),
  );

  const result = await tool('facebook_whoami').handler({}, ctx);
  assert.equal(result.isError, true);
  const token = result.structuredContent?.token as Record<string, unknown>;
  assert.equal(token.unverified, true, 'the placeholder must be labelled as one');
});

test('whoami does not mark a token Graph actually ruled on as unverified (wave 24)', async () => {
  const { fb, ctx } = makeCtx({
    settings: makeSettings({ accessToken: 'EAA-runtime' }),
  });
  fb.on(
    (req) => req.path === '/debug_token',
    fbOk({ data: { is_valid: false, error: { code: 190, message: 'expired' } } }),
  );
  const token = (await tool('facebook_whoami').handler({}, ctx)).structuredContent
    ?.token as Record<string, unknown>;
  assert.equal(token.valid, false);
  assert.equal(token.unverified, undefined);
});

test('list_pages does not pass an unreadable /me/accounts answer off as "no Pages"', async () => {
  // A 2xx whose body carries no account list is survived (see above), but the
  // payload used to be `{ pages: [], count: 0, hasMore: false }` and nothing
  // else — word for word the answer for an operator who administers no Pages at
  // all. The model then reports "you have no Pages" (or "the token cannot see
  // your Page") off a response nobody could read.
  const bodies: readonly unknown[] = [undefined, 'OK', { data: 'not-an-array' }, {}];
  for (const shaped of bodies) {
    const { fb, ctx } = makeCtx();
    fb.on((req) => req.path === '/me/accounts', fbOk(shaped));
    const parsed = body(await tool('facebook_list_pages').handler({}, ctx));
    const label = JSON.stringify(shaped) ?? 'undefined';
    assert.equal(parsed.count, 0, `count for ${label}`);
    assert.match(String(parsed.note), /not a readable account list/, `note for ${label}`);
    assert.match(String(parsed.note), /not evidence/, `note for ${label}`);
  }

  // A genuinely empty edge is an honest "none" and carries no such warning.
  const { fb, ctx } = makeCtx();
  fb.on((req) => req.path === '/me/accounts', fbOk({ data: [] }));
  const empty = body(await tool('facebook_list_pages').handler({}, ctx));
  assert.equal(empty.count, 0);
  assert.equal(empty.note, undefined);
});

test('list_pages says how many account entries it dropped as unreadable', async () => {
  // `{ id: 12345 }` is a real Page Graph returned with a numeric id; dropping it
  // is right (the model cannot spend it), but dropping it SILENTLY leaves a
  // listing that reads as complete while one of the operator's Pages is missing.
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.path === '/me/accounts',
    fbOk({
      data: [null, { id: 12345, name: 'Numeric Id' }, { id: 'p9', name: 'Readable' }],
    }),
  );
  const parsed = body(await tool('facebook_list_pages').handler({}, ctx));
  assert.equal(parsed.count, 1);
  assert.equal(parsed.hasMore, false);
  assert.match(String(parsed.note), /2 account entries/);
  assert.match(String(parsed.note), /could not be read/);
});
