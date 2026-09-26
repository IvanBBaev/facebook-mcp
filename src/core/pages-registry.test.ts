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

function deps(
  settings: Settings,
  fb: FakeFbRequest,
  extra?: { logger?: Logger; redactor?: ReturnType<typeof createFakeRedactor> },
) {
  return {
    settings,
    fbRequest: fb.fn,
    clock: createFakeClock(),
    redactor: extra?.redactor ?? createFakeRedactor(),
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

  const redactor = createFakeRedactor();
  const registry = createPagesRegistry(deps(settings, fb, { redactor }));
  const page = await registry.resolvePage('brand-a');

  assert.equal(page.token, 'EAA-brand-a-token');
  assert.equal(fb.calls.length, 0);
  // The override bypasses the resolver, so it also bypasses the resolver's own
  // `addSecret`. Nothing else on this path would ever register it, and the value
  // is returned to a caller that will put it on the wire — so the registration
  // has to happen here, and has to be asserted here.
  assert.deepEqual(redactor.secrets, ['EAA-brand-a-token']);
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

test('the default Page never borrows a profile token override that shares its Page ID (CC-AUTH-6/9)', async () => {
  const fb = createFakeFbRequest();
  fb.on((r) => r.path === '/100', fbOk({ access_token: 'EAA-derived', id: '100' }));
  // A profile pointed at the SAME Page as the default, with its own token — the
  // shape a rotation or a narrowly-scoped token takes while the old credential
  // is still live. The override belongs to `legacy`; a call that names no
  // profile is a call on the default Page under the base token, and the header
  // precedence says so. Same Page ID by raw reference is REFUSED as ambiguous
  // below, so it cannot be silently resolved here to the profile's token.
  const settings = makeSettings({
    defaultPageId: '100',
    accessToken: 'EAA-user',
    profiles: { legacy: { pageId: '100', tokenOverride: 'EAA-legacy' } },
  });

  const registry = createPagesRegistry(deps(settings, fb));

  const byDefault = await registry.resolvePage();
  assert.equal(byDefault.token, 'EAA-derived'); // derived, not the profile's override
  assert.equal(fb.calls.length, 1);
  assert.equal((fb.lastRequest() as JsonRequest).token, 'EAA-user');

  const byDefaultKey = await registry.resolvePage('default');
  assert.equal(byDefaultKey.token, 'EAA-derived');

  // The profile itself still gets its override, verbatim.
  assert.equal((await registry.resolvePage('legacy')).token, 'EAA-legacy');
  assert.equal(fb.calls.length, 1); // cached derivation; no call for the override

  // And the raw ID stays ambiguous — two entries, two different tokens.
  await assert.rejects(registry.resolvePage('100'), /Ambiguous Page reference "100"/);
});

test('FB_PAGE_TOKEN still backs the default Page when a profile shares its Page ID with an override (CC-AUTH-9)', async () => {
  const fb = createFakeFbRequest(); // no base token, so nothing may derive
  const settings = makeSettings({
    defaultPageId: '100',
    pageToken: 'EAA-long-lived-page',
    profiles: { legacy: { pageId: '100', tokenOverride: 'EAA-legacy' } },
  });

  const registry = createPagesRegistry(deps(settings, fb));

  // The operator's explicit FB_PAGE_TOKEN is the default Page's credential; a
  // profile override is only ever that profile's.
  assert.equal((await registry.resolvePage()).token, 'EAA-long-lived-page');
  assert.equal((await registry.resolvePage('legacy')).token, 'EAA-legacy');
  assert.equal(fb.calls.length, 0);
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

test('a profile key matches case-insensitively and ignores surrounding whitespace', async () => {
  const fb = createFakeFbRequest();
  // The default Page has no override, so reaching it costs one derivation; the
  // three profile spellings must cost none.
  fb.on((r) => r.path === '/100', fbOk({ access_token: 'EAA-derived', id: '100' }));
  const settings = makeSettings({
    defaultPageId: '100',
    accessToken: 'EAA-user',
    // Exactly what F04 stores for FB_PROFILE_Acme_PAGE_ID: the key is lowercased
    // there, and two spellings of one name are refused as ONE profile. So the
    // configured spelling is the mixed-case one the operator wrote and reads
    // back in their own config — and that spelling missed here, turning every
    // page-scoped call for that Page into "Unknown Page reference".
    profiles: { acme: { pageId: '200', tokenOverride: 'EAA-acme' } },
  });

  const registry = createPagesRegistry(deps(settings, fb));

  assert.equal((await registry.resolvePage('Acme')).pageId, '200');
  assert.equal((await registry.resolvePage(' acme ')).pageId, '200');
  assert.equal((await registry.resolvePage(' 200 ')).pageId, '200');
  assert.equal((await registry.resolvePage('DEFAULT')).pageId, '100');
  assert.equal(fb.calls.length, 1, 'only the default Page needed a derivation');
});

test('profile keys differing only in case are refused, never folded onto one', async () => {
  const fb = createFakeFbRequest();
  // Not reachable through F04 (it refuses the duplicate at load time), but this
  // registry takes any injected Settings, and case-insensitive matching must not
  // turn two Pages into a coin flip.
  const settings = makeSettings({
    profiles: {
      acme: { pageId: '200', tokenOverride: 'EAA-lower' },
      Acme: { pageId: '300', tokenOverride: 'EAA-upper' },
    },
  });

  const registry = createPagesRegistry(deps(settings, fb));

  await assert.rejects(registry.resolvePage('ACME'), (e: unknown) => {
    assert.ok(e instanceof Error);
    assert.match(e.message, /Ambiguous profile key "ACME"/);
    return true;
  });
  // An exactly-spelled key is still unambiguous and wins.
  assert.equal((await registry.resolvePage('Acme')).pageId, '300');
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

test('resolvePage() with no default names the configured profiles the caller can pass instead', async () => {
  const fb = createFakeFbRequest();
  // With no FB_PAGE_ID, every Page-scoped call that omits `profile` lands here,
  // and the only way forward is to pass a profile — whose keys the caller (the
  // model) has no other in-band way to learn. The "unknown reference" refusal
  // one door over lists them; this one must too, or the next call is a guess.
  const settings = makeSettings({
    accessToken: 'EAA-user',
    profiles: {
      'brand-a': { pageId: '200', tokenOverride: 'x' },
      'brand-b': { pageId: '300' },
    },
  });

  const registry = createPagesRegistry(deps(settings, fb));
  await assert.rejects(registry.resolvePage(), (e: unknown) => {
    assert.ok(e instanceof Error);
    assert.match(e.message, /No default Page configured/);
    assert.match(e.message, /Known profiles: brand-a, brand-b/);
    return true;
  });
  assert.equal(fb.calls.length, 0);
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

/** A logger that records the level with each line, for tests that assert on it. */
function levelledLogger(): {
  logger: Logger;
  lines: {
    level: 'debug' | 'info' | 'warn' | 'error';
    msg: string;
    fields?: LogFields;
  }[];
} {
  const lines: {
    level: 'debug' | 'info' | 'warn' | 'error';
    msg: string;
    fields?: LogFields;
  }[] = [];
  const logger: Logger = {
    debug: (msg, fields) => lines.push({ level: 'debug', msg, fields }),
    info: (msg, fields) => lines.push({ level: 'info', msg, fields }),
    warn: (msg, fields) => lines.push({ level: 'warn', msg, fields }),
    error: (msg, fields) => lines.push({ level: 'error', msg, fields }),
  };
  return { logger, lines };
}

test('FB_PAGE_TOKEN with no FB_PAGE_ID is warned about at startup as bound to no Page', async () => {
  const fb = createFakeFbRequest();
  const { logger, lines } = levelledLogger();
  // F04 accepts this: a token exists, and a profile Page exists. But a long-lived
  // Page token is the credential of exactly one Page, and FB_PAGE_ID is the only
  // way to say which — a profile Page takes FB_PROFILE_<NAME>_TOKEN, never
  // FB_PAGE_TOKEN. So this token is bound to nothing and no Page-scoped call can
  // ever resolve, while the startup line reports it as the active credential and
  // the per-call error tells the operator to "provide FB_PAGE_TOKEN".
  const settings = makeSettings({
    pageToken: 'EAA-long-lived-page',
    profiles: { 'brand-a': { pageId: '200' } },
  });

  const registry = createPagesRegistry(deps(settings, fb, { logger }));

  const warned = lines.find((l) => l.level === 'warn' && /FB_PAGE_TOKEN/.test(l.msg));
  assert.ok(warned, 'expected a startup warning about the unbound FB_PAGE_TOKEN');
  assert.match(warned.msg, /FB_PAGE_ID/); // names the setting that binds it
  assert.match(warned.msg, /FB_PROFILE_<NAME>_TOKEN/); // and the per-profile alternative
  assert.ok(!/EAA-long-lived-page/.test(warned.msg)); // the token itself never hits stderr

  // The failure it warns about is real: the profile cannot resolve.
  await assert.rejects(registry.resolvePage('brand-a'), /No base token available/);
  assert.equal(fb.calls.length, 0);
});

test('FB_PAGE_TOKEN bound to FB_PAGE_ID draws no startup warning (regression coverage)', () => {
  const fb = createFakeFbRequest();
  const { logger, lines } = levelledLogger();
  const settings = makeSettings({
    defaultPageId: '100',
    pageToken: 'EAA-long-lived-page',
    profiles: { 'brand-a': { pageId: '200', tokenOverride: 'EAA-brand-a' } },
  });

  createPagesRegistry(deps(settings, fb, { logger }));

  assert.equal(
    lines.filter((l) => l.level === 'warn').length,
    0,
    'a correctly bound Page token is not a misconfiguration',
  );
});

// ---------------------------------------------------------------------------
// Derived-token cache lifetime
// ---------------------------------------------------------------------------

test('a derived Page token is re-derived after the default cache TTL, not kept for the process lifetime', async () => {
  // The resolver caches "until explicitly invalidated" when no TTL is given —
  // but nothing in production ever invalidates: `runWithPageToken` is not
  // reachable through this registry and `invalidate` has no caller outside it.
  // Without a default TTL the cache therefore has no eviction path at all, and a
  // Page token Meta revokes stays cached until the server is restarted.
  const fb = createFakeFbRequest();
  fb.on((r) => r.path === '/100', fbOk({ access_token: 'EAA-page-100', id: '100' }));
  const settings = makeSettings({ defaultPageId: '100', accessToken: 'EAA-user' });
  const clock = createFakeClock();

  const registry = createPagesRegistry({
    settings,
    fbRequest: fb.fn,
    clock,
    redactor: createFakeRedactor(),
  });

  await registry.resolvePage();
  assert.equal(fb.calls.length, 1, 'the first resolve derives');

  // Well inside any sane window: still served from cache, no extra Graph call.
  clock.advance(60_000);
  await registry.resolvePage();
  assert.equal(fb.calls.length, 1, 'a fresh entry is not re-derived');

  // A day later the entry must be gone. The exact window is an implementation
  // detail; that the cache empties at all is the contract this asserts.
  clock.advance(24 * 60 * 60_000);
  await registry.resolvePage();
  assert.equal(fb.calls.length, 2, 'a stale entry is re-derived');
});

// ---------------------------------------------------------------------------
// Wave 22 — a profile key that shadows another Page's raw ID
// ---------------------------------------------------------------------------

test('a profile key equal to the raw ID of another Page is warned about at startup (wave 22)', () => {
  // The exact key wins over a raw-ID match (pinned above), so with this config
  // `profile: "999"` can never reach brand-x's Page 999: it silently resolves
  // to Page 111. A caller who passes the raw ID it read back from
  // facebook_list_pages acts on the wrong Page and nothing says so. The
  // precedence is kept; the operator is told once, at startup, which raw ID is
  // shadowed and by which profile.
  const fb = createFakeFbRequest();
  const { logger, lines } = levelledLogger();
  const settings = makeSettings({
    profiles: {
      '999': { pageId: '111', tokenOverride: 'EAA-key-999' },
      'brand-x': { pageId: '999', tokenOverride: 'EAA-brand-x' },
    },
  });

  createPagesRegistry(deps(settings, fb, { logger }));

  const warned = lines.find((l) => l.level === 'warn' && /shadow/i.test(l.msg));
  assert.ok(warned, 'expected a startup warning about the shadowed raw Page ID');
  assert.match(warned.msg, /"999"/);
  assert.match(warned.msg, /brand-x/);
  assert.match(warned.msg, /111/);
  assert.ok(!/EAA-/.test(warned.msg)); // no token value on stderr
});

test('a profile key that names its OWN Page ID draws no shadow warning (regression coverage)', () => {
  const fb = createFakeFbRequest();
  const { logger, lines } = levelledLogger();
  const settings = makeSettings({
    defaultPageId: '100',
    accessToken: 'EAA-user',
    profiles: { '200': { pageId: '200' } },
  });

  createPagesRegistry(deps(settings, fb, { logger }));

  assert.equal(lines.filter((l) => l.level === 'warn').length, 0);
});
