import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPagesRegistry } from './pages-registry.js';
import type { JsonRequest, LogFields, Logger, Settings } from './types.js';
import {
  createFakeFbRequest,
  createFakeClock,
  createFakeRedactor,
  fbOk,
  type FakeFbRequest,
} from './fakes/index.js';

// A fully-populated Settings whose page-topology fields the tests override. Only
// the fields this module reads matter; the rest carry inert placeholders.
function makeSettings(overrides: Partial<Settings>): Settings {
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

function deps(settings: Settings, fb: FakeFbRequest, extra?: { logger?: Logger }) {
  return {
    settings,
    fbRequest: fb.fn,
    clock: createFakeClock(),
    redactor: createFakeRedactor(),
    logger: extra?.logger,
  };
}

// ---------------------------------------------------------------------------
// Default Page + derivation (C14: explicit arg, no ALS)
// ---------------------------------------------------------------------------

test('resolvePage() derives the default Page token from the base user token', async () => {
  const fb = createFakeFbRequest();
  fb.on((r) => r.path === '/100', fbOk({ access_token: 'EAA-page-100', id: '100' }));
  const settings = makeSettings({ defaultPageId: '100', accessToken: 'EAA-user' });

  const registry = createPagesRegistry(deps(settings, fb));
  const page = await registry.resolvePage();

  assert.deepEqual(page, { pageId: '100', name: 'default', token: 'EAA-page-100' });
  const req = fb.lastRequest() as JsonRequest;
  assert.equal(req.token, 'EAA-user'); // derived with the base token
});

test('resolvePage resolves a profile by key and by raw Page ID', async () => {
  const fb = createFakeFbRequest();
  fb.on((r) => r.path === '/200', fbOk({ access_token: 'EAA-page-200', id: '200' }));
  const settings = makeSettings({
    defaultPageId: '100',
    accessToken: 'EAA-user',
    profiles: { 'brand-a': { pageId: '200' } },
  });

  const registry = createPagesRegistry(deps(settings, fb));

  const byKey = await registry.resolvePage('brand-a');
  assert.deepEqual(byKey, { pageId: '200', name: 'brand-a', token: 'EAA-page-200' });

  const byId = await registry.resolvePage('200');
  assert.deepEqual(byId, { pageId: '200', name: 'brand-a', token: 'EAA-page-200' });
});

test('a per-profile token override is returned verbatim, never derived', async () => {
  const fb = createFakeFbRequest(); // any Graph call would throw
  const settings = makeSettings({
    defaultPageId: '100',
    accessToken: 'EAA-user',
    profiles: { 'brand-a': { pageId: '200', tokenOverride: 'EAA-brand-a-token' } },
  });

  const registry = createPagesRegistry(deps(settings, fb));
  const page = await registry.resolvePage('brand-a');

  assert.equal(page.token, 'EAA-brand-a-token');
  assert.equal(fb.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Credential precedence (CC-AUTH-9) + Page-token fallback (C1)
// ---------------------------------------------------------------------------

test('system-user token wins over the user token when deriving (CC-AUTH-9)', async () => {
  const fb = createFakeFbRequest();
  fb.on((r) => r.path === '/100', fbOk({ access_token: 'EAA-page', id: '100' }));
  const settings = makeSettings({
    defaultPageId: '100',
    accessToken: 'EAA-user',
    systemToken: 'EAA-system',
  });

  const registry = createPagesRegistry(deps(settings, fb));
  await registry.resolvePage();

  const req = fb.lastRequest() as JsonRequest;
  assert.equal(req.token, 'EAA-system'); // system-user token wins
});

test('FB_PAGE_TOKEN is a first-class fallback for the default Page when no base token exists', async () => {
  const fb = createFakeFbRequest(); // no derivation allowed
  const settings = makeSettings({
    defaultPageId: '100',
    pageToken: 'EAA-long-lived-page',
  });

  const registry = createPagesRegistry(deps(settings, fb));
  const page = await registry.resolvePage();

  assert.equal(page.token, 'EAA-long-lived-page');
  assert.equal(fb.calls.length, 0); // used verbatim, not derived
});

test('a base token wins over FB_PAGE_TOKEN: the default Page is derived, not the page token (CC-AUTH-9)', async () => {
  const fb = createFakeFbRequest();
  fb.on((r) => r.path === '/100', fbOk({ access_token: 'EAA-derived', id: '100' }));
  const settings = makeSettings({
    defaultPageId: '100',
    systemToken: 'EAA-system',
    pageToken: 'EAA-long-lived-page',
  });

  const registry = createPagesRegistry(deps(settings, fb));
  const page = await registry.resolvePage();

  assert.equal(page.token, 'EAA-derived'); // derived, FB_PAGE_TOKEN not used
  assert.equal(fb.calls.length, 1);
});

// ---------------------------------------------------------------------------
// Ambiguity / unknown / missing default — refuse, never guess (CC-AUTH-6)
// ---------------------------------------------------------------------------

test('a raw Page ID mapping to conflicting profiles is refused as ambiguous (CC-AUTH-6)', async () => {
  const fb = createFakeFbRequest();
  const settings = makeSettings({
    profiles: {
      'brand-a': { pageId: '900', tokenOverride: 'EAA-a' },
      'brand-b': { pageId: '900', tokenOverride: 'EAA-b' },
    },
  });

  const registry = createPagesRegistry(deps(settings, fb));

  await assert.rejects(registry.resolvePage('900'), (e: unknown) => {
    assert.ok(e instanceof Error);
    assert.match(e.message, /Ambiguous Page reference "900"/);
    assert.match(e.message, /brand-a/);
    assert.match(e.message, /brand-b/);
    return true;
  });

  // Keyed by name, the same Page IDs are always unambiguous.
  assert.equal((await registry.resolvePage('brand-a')).token, 'EAA-a');
  assert.equal((await registry.resolvePage('brand-b')).token, 'EAA-b');
});

test('an exact profile-key match wins over a raw-ID collision (never a guess)', async () => {
  const fb = createFakeFbRequest();
  const settings = makeSettings({
    profiles: {
      // Key "999" collides with brand-x's pageId; the exact key must win.
      '999': { pageId: '111', tokenOverride: 'EAA-key-999' },
      'brand-x': { pageId: '999', tokenOverride: 'EAA-brand-x' },
    },
  });

  const registry = createPagesRegistry(deps(settings, fb));
  const page = await registry.resolvePage('999');

  assert.deepEqual(page, { pageId: '111', name: '999', token: 'EAA-key-999' });
});

test('an unknown Page reference is rejected with the known profiles listed', async () => {
  const fb = createFakeFbRequest();
  const settings = makeSettings({
    defaultPageId: '100',
    accessToken: 'EAA-user',
    profiles: { 'brand-a': { pageId: '200', tokenOverride: 'x' } },
  });

  const registry = createPagesRegistry(deps(settings, fb));
  await assert.rejects(registry.resolvePage('nope'), (e: unknown) => {
    assert.ok(e instanceof Error);
    assert.match(e.message, /Unknown Page reference "nope"/);
    assert.match(e.message, /default, brand-a/);
    return true;
  });
});

test('resolvePage() with no default configured fails with guidance', async () => {
  const fb = createFakeFbRequest();
  const settings = makeSettings({
    profiles: { 'brand-a': { pageId: '200', tokenOverride: 'x' } },
  });

  const registry = createPagesRegistry(deps(settings, fb));
  await assert.rejects(registry.resolvePage(), /No default Page configured/);
});

// ---------------------------------------------------------------------------
// invalidate is wired to the token cache (CC-AUTH-1/7)
// ---------------------------------------------------------------------------

test('invalidate() drops the cached token so the next resolvePage re-derives', async () => {
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ access_token: 'EAA-page-v1', id: '100' }));
  fb.enqueue(fbOk({ access_token: 'EAA-page-v2', id: '100' }));
  const settings = makeSettings({ defaultPageId: '100', accessToken: 'EAA-user' });

  const registry = createPagesRegistry(deps(settings, fb));

  assert.equal((await registry.resolvePage()).token, 'EAA-page-v1');
  assert.equal((await registry.resolvePage()).token, 'EAA-page-v1'); // cached
  registry.invalidate('100');
  assert.equal((await registry.resolvePage()).token, 'EAA-page-v2'); // re-derived
  assert.equal(fb.calls.length, 2);
});

// ---------------------------------------------------------------------------
// CC-AUTH-9 credential logging
// ---------------------------------------------------------------------------

test('the active credential is logged; system-user token wins when FB_PAGE_TOKEN is also set (CC-AUTH-9)', () => {
  const fb = createFakeFbRequest();
  const logged: { msg: string; fields?: LogFields }[] = [];
  const logger: Logger = {
    debug: (msg, fields) => logged.push({ msg, fields }),
    info: (msg, fields) => logged.push({ msg, fields }),
    warn: (msg, fields) => logged.push({ msg, fields }),
    error: (msg, fields) => logged.push({ msg, fields }),
  };
  const settings = makeSettings({
    defaultPageId: '100',
    systemToken: 'EAA-system',
    pageToken: 'EAA-page',
  });

  createPagesRegistry(deps(settings, fb, { logger }));

  const entry = logged.find((l) => l.msg.includes('active Facebook credential'));
  assert.ok(entry, 'expected a credential log line');
  assert.equal(entry.fields?.credential, 'system-user token (FB_SYSTEM_TOKEN)');
  assert.equal(entry.fields?.pageTokenAlsoSet, true);
});
