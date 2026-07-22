import { test } from 'node:test';
import assert from 'node:assert/strict';

import { debugToken, createPageTokenResolver, ERROR_CODE_TOKEN_INVALID } from './auth.js';
import { GraphApiError } from './types.js';
import type { JsonRequest } from './types.js';
import {
  createFakeFbRequest,
  createFakeClock,
  createFakeRedactor,
  fbOk,
  fbErr,
} from './fakes/index.js';

function tokenDead(subcode?: number): GraphApiError {
  return new GraphApiError('Error validating access token', {
    code: ERROR_CODE_TOKEN_INVALID,
    subcode,
    httpStatus: 401,
  });
}

// ---------------------------------------------------------------------------
// debug_token — token type detection (CC-AUTH-2, CC-AUTH-5, CC-AUTH-9/10 seam)
// ---------------------------------------------------------------------------

test('debugToken classifies a USER token and queries /debug_token correctly', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    (r) => r.path === '/debug_token',
    fbOk({
      data: {
        type: 'USER',
        is_valid: true,
        app_id: 'app-1',
        scopes: ['pages_show_list', 'pages_manage_posts'],
        expires_at: 2_000,
        user_id: 'user-9',
      },
    }),
  );

  const info = await debugToken('EAA-user-token', {
    fbRequest: fb.fn,
    accessToken: 'app-1|app-secret',
  });

  assert.equal(info.type, 'USER');
  assert.equal(info.valid, true);
  assert.equal(info.appId, 'app-1');
  assert.deepEqual([...info.scopes], ['pages_show_list', 'pages_manage_posts']);
  assert.equal(info.expiresAt, 2_000_000); // seconds → ms
  assert.equal(info.userId, 'user-9');

  const req = fb.lastRequest() as JsonRequest;
  assert.equal(req.path, '/debug_token');
  assert.equal(req.params?.input_token, 'EAA-user-token');
  assert.equal(req.token, 'app-1|app-secret'); // authorized by the app/base token
});

test('debugToken classifies a PAGE token (profile_id present)', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    (r) => r.path === '/debug_token',
    fbOk({ data: { type: 'PAGE', is_valid: true, profile_id: '100' } }),
  );

  const info = await debugToken('EAA-page-token', {
    fbRequest: fb.fn,
    accessToken: 'base',
  });

  assert.equal(info.type, 'PAGE');
  assert.equal(info.profileId, '100');
});

test('debugToken classifies a SYSTEM_USER token', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    (r) => r.path === '/debug_token',
    fbOk({ data: { type: 'SYSTEM_USER', is_valid: true } }),
  );

  const info = await debugToken('EAA-sys', { fbRequest: fb.fn, accessToken: 'base' });
  assert.equal(info.type, 'SYSTEM_USER');
});

test('debugToken: never-expiring, invalid, unknown-type and empty bodies parse defensively', async () => {
  const fb = createFakeFbRequest();
  // expires_at 0 ⇒ never-expiring; is_valid false ⇒ invalid (CC-AUTH-5).
  fb.enqueue(fbOk({ data: { type: 'user', is_valid: false, expires_at: 0 } }));
  fb.enqueue(fbOk({ data: { type: 'weird-new-type' } }));
  fb.enqueue(fbOk({})); // no `data` at all

  const a = await debugToken('t1', { fbRequest: fb.fn, accessToken: 'base' });
  assert.equal(a.type, 'USER'); // case-insensitive
  assert.equal(a.valid, false);
  assert.equal(a.expiresAt, undefined); // 0 ⇒ never-expiring
  assert.deepEqual([...a.scopes], []);

  const b = await debugToken('t2', { fbRequest: fb.fn, accessToken: 'base' });
  assert.equal(b.type, 'UNKNOWN');

  const c = await debugToken('t3', { fbRequest: fb.fn, accessToken: 'base' });
  assert.equal(c.type, 'UNKNOWN');
  assert.equal(c.valid, false);
});

// ---------------------------------------------------------------------------
// Per-page token resolver — derive + cache (C1)
// ---------------------------------------------------------------------------

test('resolve derives a Page token from the base token, caches it, and registers it as a secret', async () => {
  const fb = createFakeFbRequest();
  const clock = createFakeClock();
  const redactor = createFakeRedactor();
  fb.on((r) => r.path === '/100', fbOk({ access_token: 'EAA-page-100', id: '100' }));

  const resolver = createPageTokenResolver({
    fbRequest: fb.fn,
    baseToken: 'EAA-base',
    clock,
    redactor,
  });

  const t1 = await resolver.resolve('100');
  const t2 = await resolver.resolve('100');

  assert.equal(t1, 'EAA-page-100');
  assert.equal(t2, 'EAA-page-100');
  assert.equal(fb.calls.length, 1); // second resolve is a cache hit
  assert.equal(redactor.secrets.includes('EAA-page-100'), true); // scrubbable at once

  const req = fb.lastRequest() as JsonRequest;
  assert.equal(req.path, '/100');
  assert.equal(req.params?.fields, 'access_token');
  assert.equal(req.token, 'EAA-base'); // derived with the base token
});

test('an override token is used verbatim (Page-token fallback), never derived', async () => {
  const fb = createFakeFbRequest(); // no rules ⇒ any Graph call would throw
  const clock = createFakeClock();
  const redactor = createFakeRedactor();

  const resolver = createPageTokenResolver({
    fbRequest: fb.fn,
    baseToken: 'EAA-base',
    clock,
    redactor,
    overrides: { '200': 'EAA-page-override' },
  });

  const t = await resolver.resolve('200');
  assert.equal(t, 'EAA-page-override');
  assert.equal(fb.calls.length, 0); // no derivation
  assert.equal(redactor.secrets.includes('EAA-page-override'), true);
});

test('invalidate drops the cache so the next resolve re-derives (CC-AUTH-1/7)', async () => {
  const fb = createFakeFbRequest();
  const clock = createFakeClock();
  const redactor = createFakeRedactor();
  fb.enqueue(fbOk({ access_token: 'EAA-page-v1', id: '100' }));
  fb.enqueue(fbOk({ access_token: 'EAA-page-v2', id: '100' }));

  const resolver = createPageTokenResolver({
    fbRequest: fb.fn,
    baseToken: 'EAA-base',
    clock,
    redactor,
  });

  assert.equal(await resolver.resolve('100'), 'EAA-page-v1');
  resolver.invalidate('100');
  assert.equal(await resolver.resolve('100'), 'EAA-page-v2');
  assert.equal(fb.calls.length, 2);
});

test('cacheTtlMs expires a derived token, forcing re-derivation', async () => {
  const fb = createFakeFbRequest();
  const clock = createFakeClock(1_000);
  const redactor = createFakeRedactor();
  fb.enqueue(fbOk({ access_token: 'EAA-page-v1', id: '100' }));
  fb.enqueue(fbOk({ access_token: 'EAA-page-v2', id: '100' }));

  const resolver = createPageTokenResolver({
    fbRequest: fb.fn,
    baseToken: 'EAA-base',
    clock,
    redactor,
    cacheTtlMs: 60_000,
  });

  assert.equal(await resolver.resolve('100'), 'EAA-page-v1');
  clock.advance(30_000);
  assert.equal(await resolver.resolve('100'), 'EAA-page-v1'); // still fresh
  clock.advance(30_001);
  assert.equal(await resolver.resolve('100'), 'EAA-page-v2'); // expired ⇒ re-derived
  assert.equal(fb.calls.length, 2);
});

test('a dead base token fails derivation with actionable guidance (CC-AUTH-1)', async () => {
  const fb = createFakeFbRequest();
  const clock = createFakeClock();
  const redactor = createFakeRedactor();
  fb.on((r) => r.path === '/100', fbErr(tokenDead(463)));

  const resolver = createPageTokenResolver({
    fbRequest: fb.fn,
    baseToken: 'EAA-base',
    clock,
    redactor,
  });

  await assert.rejects(resolver.resolve('100'), (e: unknown) => {
    assert.ok(e instanceof GraphApiError);
    assert.equal(e.code, 190);
    assert.match(e.message, /Base access token is invalid or expired/);
    assert.match(e.message, /FB_SYSTEM_TOKEN \/ FB_ACCESS_TOKEN/);
    return true;
  });
});

test('resolve with no base token and no override fails with guidance', async () => {
  const fb = createFakeFbRequest();
  const clock = createFakeClock();
  const redactor = createFakeRedactor();

  const resolver = createPageTokenResolver({ fbRequest: fb.fn, clock, redactor });

  await assert.rejects(resolver.resolve('100'), /No base token available/);
  assert.equal(fb.calls.length, 0);
});

test('derivation that returns no access_token surfaces a permission error (CC-AUTH-4)', async () => {
  const fb = createFakeFbRequest();
  const clock = createFakeClock();
  const redactor = createFakeRedactor();
  fb.on((r) => r.path === '/100', fbOk({ id: '100' })); // no access_token field

  const resolver = createPageTokenResolver({
    fbRequest: fb.fn,
    baseToken: 'EAA-base',
    clock,
    redactor,
  });

  await assert.rejects(resolver.resolve('100'), /no Page access token/);
});

// ---------------------------------------------------------------------------
// runWithPageToken — 190 → invalidate → re-derive once → then fail (C1)
// ---------------------------------------------------------------------------

test('runWithPageToken runs the op with the resolved token (happy path)', async () => {
  const fb = createFakeFbRequest();
  const clock = createFakeClock();
  const redactor = createFakeRedactor();
  fb.on((r) => r.path === '/100', fbOk({ access_token: 'EAA-page', id: '100' }));

  const resolver = createPageTokenResolver({
    fbRequest: fb.fn,
    baseToken: 'EAA-base',
    clock,
    redactor,
  });

  const seen: string[] = [];
  const out = await resolver.runWithPageToken('100', (token) => {
    seen.push(token);
    return Promise.resolve('ok');
  });

  assert.equal(out, 'ok');
  assert.deepEqual(seen, ['EAA-page']);
});

test('runWithPageToken: op 190 → invalidate → re-derive once → op succeeds', async () => {
  const fb = createFakeFbRequest();
  const clock = createFakeClock();
  const redactor = createFakeRedactor();
  fb.enqueue(fbOk({ access_token: 'EAA-page-v1', id: '100' }));
  fb.enqueue(fbOk({ access_token: 'EAA-page-v2', id: '100' }));

  const resolver = createPageTokenResolver({
    fbRequest: fb.fn,
    baseToken: 'EAA-base',
    clock,
    redactor,
  });

  const seen: string[] = [];
  let opCalls = 0;
  const out = await resolver.runWithPageToken('100', (token) => {
    opCalls += 1;
    seen.push(token);
    if (opCalls === 1) return Promise.reject(tokenDead(460)); // stale derived token
    return Promise.resolve('recovered');
  });

  assert.equal(out, 'recovered');
  assert.equal(opCalls, 2);
  assert.deepEqual(seen, ['EAA-page-v1', 'EAA-page-v2']); // re-derived once
  assert.equal(fb.calls.length, 2);
});

test('runWithPageToken: a second 190 after re-derivation fails with actionable guidance', async () => {
  const fb = createFakeFbRequest();
  const clock = createFakeClock();
  const redactor = createFakeRedactor();
  fb.enqueue(fbOk({ access_token: 'EAA-page-v1', id: '100' }));
  fb.enqueue(fbOk({ access_token: 'EAA-page-v2', id: '100' }));

  const resolver = createPageTokenResolver({
    fbRequest: fb.fn,
    baseToken: 'EAA-base',
    clock,
    redactor,
  });

  let opCalls = 0;
  await assert.rejects(
    resolver.runWithPageToken('100', () => {
      opCalls += 1;
      return Promise.reject(tokenDead(467));
    }),
    (e: unknown) => {
      assert.ok(e instanceof GraphApiError);
      assert.equal(e.code, 190);
      assert.match(e.message, /still invalid after one re-derivation/);
      return true;
    },
  );

  assert.equal(opCalls, 2); // exactly one re-derive + retry, then fail
  assert.equal(fb.calls.length, 2);
});

test('runWithPageToken: an override token 190 fails immediately (cannot re-derive)', async () => {
  const fb = createFakeFbRequest();
  const clock = createFakeClock();
  const redactor = createFakeRedactor();

  const resolver = createPageTokenResolver({
    fbRequest: fb.fn,
    baseToken: 'EAA-base',
    clock,
    redactor,
    overrides: { '200': 'EAA-override' },
  });

  let opCalls = 0;
  await assert.rejects(
    resolver.runWithPageToken('200', () => {
      opCalls += 1;
      return Promise.reject(tokenDead());
    }),
    /Configured Page token for Page 200 is invalid/,
  );

  assert.equal(opCalls, 1); // no re-derivation attempt
  assert.equal(fb.calls.length, 0);
});

test('runWithPageToken: a non-190 error is rethrown as-is, never retried (CC-AUTH-3)', async () => {
  const fb = createFakeFbRequest();
  const clock = createFakeClock();
  const redactor = createFakeRedactor();
  fb.on((r) => r.path === '/100', fbOk({ access_token: 'EAA-page', id: '100' }));

  const resolver = createPageTokenResolver({
    fbRequest: fb.fn,
    baseToken: 'EAA-base',
    clock,
    redactor,
  });

  const permission = new GraphApiError('Missing Page role', {
    code: 200,
    httpStatus: 403,
  });
  let opCalls = 0;
  await assert.rejects(
    resolver.runWithPageToken('100', () => {
      opCalls += 1;
      return Promise.reject(permission);
    }),
    (e: unknown) => e === permission, // same instance, unwrapped
  );

  assert.equal(opCalls, 1); // permission errors are never retried
});
