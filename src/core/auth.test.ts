import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  debugToken,
  createPageTokenResolver,
  ERROR_CODE_INVALID_PARAM,
  ERROR_CODE_TOKEN_INVALID,
  isPageTokenDead,
  STALE_OBJECT_SUBCODES,
} from './auth.js';
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

test('debugToken: never-expiring, invalid and unknown-type bodies parse defensively', async () => {
  const fb = createFakeFbRequest();
  // expires_at 0 ⇒ never-expiring; is_valid false ⇒ invalid (CC-AUTH-5).
  fb.enqueue(fbOk({ data: { type: 'user', is_valid: false, expires_at: 0 } }));
  fb.enqueue(fbOk({ data: { type: 'weird-new-type', is_valid: true } }));

  const a = await debugToken('t1', { fbRequest: fb.fn, accessToken: 'base' });
  assert.equal(a.type, 'USER'); // case-insensitive
  assert.equal(a.valid, false);
  assert.equal(a.expiresAt, undefined); // 0 ⇒ never-expiring
  assert.deepEqual([...a.scopes], []);

  const b = await debugToken('t2', { fbRequest: fb.fn, accessToken: 'base' });
  assert.equal(b.type, 'UNKNOWN');
  assert.equal(b.valid, true);
});

test('debugToken: a 2xx that carries no is_valid verdict is unanswered, not an invalid token (wave 25)', async () => {
  // Graph always states `is_valid` when it rules on a token. A 2xx without it —
  // a bodiless 200, a proxy's HTML page, `{}` with no `data`, a `data` that is
  // not an object, or one missing / mistyping `is_valid` — is no ruling at all.
  // Reporting it as `valid:false` sent the doctor to "token malformed, re-issue
  // it" and gave whoami an invalid token with no reason, for a credential that
  // was never assessed. It must surface as an unanswered call: a GraphApiError
  // with no Graph code and the 2xx status, which the doctor classifies as
  // `token_check_failed` and whoami labels `unverified`.
  const bodies: readonly unknown[] = [
    {},
    undefined,
    '<html>captive portal</html>',
    { data: 'nope' },
    { data: null },
    { data: { type: 'USER', scopes: ['pages_show_list'] } },
    { data: { type: 'USER', is_valid: 'false' } },
  ];
  for (const body of bodies) {
    const fb = createFakeFbRequest();
    fb.enqueue(fbOk(body, {}, 203));
    await assert.rejects(
      debugToken('t', { fbRequest: fb.fn, accessToken: 'base' }),
      (err: unknown) => {
        assert.ok(
          err instanceof GraphApiError,
          `expected GraphApiError for ${JSON.stringify(body)}`,
        );
        assert.equal(err.code, 0);
        assert.equal(err.httpStatus, 203);
        assert.match(err.message, /is_valid/);
        return true;
      },
      `a verdict-less body must not be read as a ruling: ${JSON.stringify(body)}`,
    );
  }
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

test('the no-base-token guidance tells an operator with an unbound FB_PAGE_TOKEN to bind it, not to provide one', async () => {
  const fb = createFakeFbRequest();
  const resolver = createPageTokenResolver({
    fbRequest: fb.fn,
    clock: createFakeClock(),
    redactor: createFakeRedactor(),
  });

  // This is the shape the resolver sees for two different operators: one with
  // no token at all, and one who set FB_PAGE_TOKEN without FB_PAGE_ID (the
  // registry then installs no override, so `overrides` is empty here too). For
  // the second, "provide a long-lived Page token" is the wrong instruction —
  // they did — and the real fix is to BIND it to this Page. The resolver cannot
  // tell the two apart, so one message must be true for both: name the base-
  // token route, and name the binding pairs with THIS Page's id filled in.
  await assert.rejects(resolver.resolve('100'), (e: unknown) => {
    assert.ok(e instanceof GraphApiError);
    assert.equal(e.code, ERROR_CODE_TOKEN_INVALID);
    assert.match(e.message, /No base token available/);
    assert.match(e.message, /FB_SYSTEM_TOKEN or FB_ACCESS_TOKEN/);
    assert.match(e.message, /FB_PAGE_TOKEN with FB_PAGE_ID=100\b/);
    assert.match(
      e.message,
      /FB_PROFILE_<NAME>_TOKEN with FB_PROFILE_<NAME>_PAGE_ID=100\b/,
    );
    assert.match(e.message, /bound to nothing/);
    assert.match(e.message, /facebook_whoami/);
    return true;
  });
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

test('CC-AUTH-4: a derive response whose body is not the declared shape stays actionable', async () => {
  // `FbResponse<T>.data` is a CAST, not a guarantee: core/http.ts parses the
  // body and hands the result back as `T` without checking it. Three shapes get
  // past that cast on a 2xx — `undefined` (a bodiless 200, which the client
  // decodes to `undefined` by design), the raw string of a non-JSON body, and
  // any JSON that simply is not the object this call declared. Reaching into
  // `res.data.access_token` as if the declared shape held turns the first two
  // into a bare `TypeError: Cannot read properties of undefined`: an
  // unclassified crash, with no Graph code and none of the "the base token may
  // lack a role on this Page" text the operator needs to act. The fourth shape
  // is worse for being quiet — a non-string `access_token` has no `.length`, so
  // the emptiness check waves it through and a number ends up registered as a
  // secret and pasted into an `Authorization: Bearer` header.
  const bodies: readonly unknown[] = [
    undefined, // bodiless 2xx
    'not json at all', // non-JSON body, handed back verbatim
    ['access_token'], // JSON, but not an object with the field
    null, // JSON `null`
    { access_token: 12345 }, // present, but not a string
    { access_token: '   ' }, // present, but not a usable token
  ];

  for (const body of bodies) {
    const fb = createFakeFbRequest();
    const clock = createFakeClock();
    const redactor = createFakeRedactor();
    fb.on((r) => r.path === '/100', fbOk(body));

    const resolver = createPageTokenResolver({
      fbRequest: fb.fn,
      baseToken: 'EAA-base',
      clock,
      redactor,
    });

    await assert.rejects(
      resolver.resolve('100'),
      (err: unknown) => {
        assert.ok(
          err instanceof GraphApiError,
          `body ${JSON.stringify(body)} produced ${String(err)}`,
        );
        assert.match(err.message, /no Page access token/);
        // Graph sent no error, so there is no Graph code to report (wave 23).
        assert.equal(err.code, 0);
        assert.equal(err.action?.category, 'permission');
        return true;
      },
      `body ${JSON.stringify(body)} must not crash the resolver`,
    );
    // Nothing unusable is ever registered as a secret: the fake redactor drops
    // empty strings, so a leaked `'   '` or `12345` would show up here.
    assert.deepEqual(redactor.secrets, []);
  }
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

// ---------------------------------------------------------------------------
// CC-AUTH-5 — granular_scopes surfaced by debug_token
// ---------------------------------------------------------------------------

test('debugToken surfaces granular_scopes with their target asset ids', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    (r) => r.path === '/debug_token',
    fbOk({
      data: {
        type: 'SYSTEM_USER',
        is_valid: true,
        scopes: ['pages_show_list', 'ads_read'],
        granular_scopes: [
          { scope: 'pages_show_list', target_ids: ['100', '200'] },
          { scope: 'ads_read', target_ids: ['act_1'] },
        ],
      },
    }),
  );

  const info = await debugToken('EAA-system-token', {
    fbRequest: fb.fn,
    accessToken: 'app-1|app-secret',
  });

  assert.deepEqual(
    (info.granularScopes ?? []).map((entry) => [entry.scope, [...entry.targetIds]]),
    [
      ['pages_show_list', ['100', '200']],
      ['ads_read', ['act_1']],
    ],
  );
});

test('debugToken reports a granular scope that lost every target asset (CC-AUTH-5)', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    (r) => r.path === '/debug_token',
    fbOk({
      data: {
        type: 'SYSTEM_USER',
        is_valid: true,
        scopes: ['pages_show_list'],
        granular_scopes: [{ scope: 'pages_show_list', target_ids: [] }],
      },
    }),
  );

  const info = await debugToken('EAA-system-token', {
    fbRequest: fb.fn,
    accessToken: 'app-1|app-secret',
  });

  // Valid token, permission still listed, but no asset behind it.
  assert.equal(info.valid, true);
  assert.deepEqual([...info.scopes], ['pages_show_list']);
  assert.deepEqual(info.granularScopes, [{ scope: 'pages_show_list', targetIds: [] }]);
});

test('debugToken parses malformed granular_scopes defensively (CC-NET-2)', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    (r) => r.path === '/debug_token',
    fbOk({
      data: {
        type: 'USER',
        is_valid: true,
        granular_scopes: [
          { target_ids: ['100'] }, // no scope name ⇒ dropped
          { scope: '', target_ids: ['100'] }, // empty scope name ⇒ dropped
          { scope: 'pages_show_list', target_ids: 'nope' }, // not an array ⇒ []
          { scope: 'ads_read', target_ids: ['act_1', 7] }, // non-string id dropped
          { scope: 'read_insights' }, // absent target_ids ⇒ granted over all assets
        ],
      },
    }),
  );

  const info = await debugToken('EAA-user-token', {
    fbRequest: fb.fn,
    accessToken: 'app-1|app-secret',
  });

  assert.deepEqual(info.granularScopes, [
    { scope: 'pages_show_list', targetIds: [] },
    { scope: 'ads_read', targetIds: ['act_1'] },
    { scope: 'read_insights', targetIds: [], appliesToAllTargets: true },
  ]);
});

test('debugToken reports no granular scopes when Graph omits the field', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    (r) => r.path === '/debug_token',
    fbOk({ data: { type: 'USER', is_valid: true, granular_scopes: 'not-an-array' } }),
  );

  const info = await debugToken('EAA-user-token', {
    fbRequest: fb.fn,
    accessToken: 'app-1|app-secret',
  });

  assert.deepEqual(info.granularScopes, []);
});

// ---------------------------------------------------------------------------
// CC-AUTH-7 — the cache also invalidates on error 100 (stale Page object)
// ---------------------------------------------------------------------------

function stalePage(subcode: number): GraphApiError {
  return new GraphApiError('Unsupported get request', {
    code: ERROR_CODE_INVALID_PARAM,
    subcode,
    httpStatus: 400,
  });
}

for (const subcode of STALE_OBJECT_SUBCODES) {
  test(`runWithPageToken: op 100/${String(subcode)} → invalidate → re-derive once → op succeeds`, async () => {
    const fb = createFakeFbRequest();
    fb.enqueue(fbOk({ access_token: 'EAA-page-v1', id: '100' }));
    fb.enqueue(fbOk({ access_token: 'EAA-page-v2', id: '100' }));

    const resolver = createPageTokenResolver({
      fbRequest: fb.fn,
      baseToken: 'EAA-base',
      clock: createFakeClock(),
      redactor: createFakeRedactor(),
    });

    const seen: string[] = [];
    let opCalls = 0;
    const out = await resolver.runWithPageToken('100', (token) => {
      opCalls += 1;
      seen.push(token);
      if (opCalls === 1) return Promise.reject(stalePage(subcode));
      return Promise.resolve('recovered');
    });

    assert.equal(out, 'recovered');
    assert.equal(opCalls, 2);
    assert.deepEqual(seen, ['EAA-page-v1', 'EAA-page-v2']); // re-derived once
  });
}

test('runWithPageToken: a bare error 100 does NOT invalidate the cache', async () => {
  const fb = createFakeFbRequest();
  fb.on((r) => r.path === '/100', fbOk({ access_token: 'EAA-page', id: '100' }));

  const resolver = createPageTokenResolver({
    fbRequest: fb.fn,
    baseToken: 'EAA-base',
    clock: createFakeClock(),
    redactor: createFakeRedactor(),
  });

  // Error 100 with no subcode is "you sent a bad parameter", not "the Page
  // moved" — dropping the token and replaying the op would be pure waste.
  const badParam = new GraphApiError('Invalid parameter', {
    code: ERROR_CODE_INVALID_PARAM,
    httpStatus: 400,
  });
  let opCalls = 0;
  await assert.rejects(
    resolver.runWithPageToken('100', () => {
      opCalls += 1;
      return Promise.reject(badParam);
    }),
    (e: unknown) => e === badParam, // same instance, unwrapped
  );

  assert.equal(opCalls, 1);
  assert.equal(fb.calls.length, 1); // one derivation, no re-derivation
});

test('runWithPageToken: a second 100/33 after re-derivation reports the moved Page', async () => {
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ access_token: 'EAA-page-v1', id: '100' }));
  fb.enqueue(fbOk({ access_token: 'EAA-page-v2', id: '100' }));

  const resolver = createPageTokenResolver({
    fbRequest: fb.fn,
    baseToken: 'EAA-base',
    clock: createFakeClock(),
    redactor: createFakeRedactor(),
  });

  let opCalls = 0;
  await assert.rejects(
    resolver.runWithPageToken('100', () => {
      opCalls += 1;
      return Promise.reject(stalePage(33));
    }),
    (e: unknown) => {
      assert.ok(e instanceof GraphApiError);
      assert.equal(e.code, ERROR_CODE_INVALID_PARAM);
      assert.equal(e.subcode, 33);
      assert.match(e.message, /still does not resolve after one re-derivation/);
      assert.match(e.message, /facebook_list_pages/);
      return true;
    },
  );

  assert.equal(opCalls, 2);
});

test('runWithPageToken: an override token on 100/21 reports the merged Page, no re-derive', async () => {
  const fb = createFakeFbRequest();

  const resolver = createPageTokenResolver({
    fbRequest: fb.fn,
    clock: createFakeClock(),
    redactor: createFakeRedactor(),
    overrides: { '100': 'EAA-configured-page-token' },
  });

  let opCalls = 0;
  await assert.rejects(
    resolver.runWithPageToken('100', () => {
      opCalls += 1;
      return Promise.reject(stalePage(21));
    }),
    (e: unknown) => {
      assert.ok(e instanceof GraphApiError);
      assert.equal(e.code, ERROR_CODE_INVALID_PARAM);
      assert.match(e.message, /merged, renamed or unpublished/);
      return true;
    },
  );

  assert.equal(opCalls, 1); // an override has no re-derivation source
  assert.equal(fb.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Defensive parsing of the wire shape (CC-NET-2) + own-property guards
// ---------------------------------------------------------------------------

test('debugToken keeps scopes an array when Graph sends a non-array (CC-NET-2)', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    (r) => r.path === '/debug_token',
    // A single permission sent as a bare string instead of a one-element array.
    // `DebugTokenInfo.scopes` is declared `readonly string[]`; leaking the string
    // through makes `scopes.length` a character count, `scopes.join()` throw, and
    // `new Set(scopes)` a set of single characters — which is how the doctor's
    // permission check would report every required scope as missing on a token
    // that actually holds this one.
    fbOk({ data: { type: 'USER', is_valid: true, scopes: 'pages_read_engagement' } }),
  );

  const info = await debugToken('EAA-user-token', {
    fbRequest: fb.fn,
    accessToken: 'app-1|app-secret',
  });

  assert.equal(Array.isArray(info.scopes), true);
  assert.deepEqual([...info.scopes], []);
  assert.doesNotThrow(() => info.scopes.join(', '));
});

test('debugToken drops non-string entries from the scopes array (CC-NET-2)', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    (r) => r.path === '/debug_token',
    fbOk({
      data: {
        type: 'USER',
        is_valid: true,
        scopes: ['pages_show_list', 42, null, 'pages_manage_posts'],
      },
    }),
  );

  const info = await debugToken('EAA-user-token', {
    fbRequest: fb.fn,
    accessToken: 'app-1|app-secret',
  });

  assert.deepEqual([...info.scopes], ['pages_show_list', 'pages_manage_posts']);
});

test('resolve does not mistake an inherited Object.prototype key for an override', async () => {
  const fb = createFakeFbRequest();
  const redactor = createFakeRedactor();
  fb.on((r) => r.path === '/toString', fbOk({ access_token: 'EAA-derived', id: 'x' }));

  const resolver = createPageTokenResolver({
    fbRequest: fb.fn,
    baseToken: 'EAA-base',
    clock: createFakeClock(),
    redactor,
    overrides: {}, // nothing configured — every Page must be derived
  });

  // `overrides['toString']` answers Object.prototype.toString, which a bare
  // `!== undefined` check accepts as a configured token: `resolve` would return a
  // function from a `Promise<string>` and skip derivation entirely.
  const token = await resolver.resolve('toString');

  assert.equal(typeof token, 'string');
  assert.equal(token, 'EAA-derived');
  assert.equal(fb.calls.length, 1);
});

// ---------------------------------------------------------------------------
// The in-band error Graph returns INSIDE a 200 /debug_token body
// ---------------------------------------------------------------------------

test('debugToken carries the reason Graph gave for rejecting the token', async () => {
  // Graph does not answer an invalid `input_token` with an HTTP error — it
  // answers 200, `is_valid: false`, and puts the reason in `data.error`. Reading
  // only `is_valid` turned that into a bare "not valid", so the doctor printed a
  // symptom with no cause and an operator could not tell an expired token from a
  // revoked one from a token issued by a different app.
  const fb = createFakeFbRequest();
  fb.on(
    (r) => r.path === '/debug_token',
    fbOk({
      data: {
        is_valid: false,
        error: {
          code: 190,
          subcode: 463,
          message: 'Error validating access token: Session has expired.',
        },
      },
    }),
  );

  const info = await debugToken('EAA-expired', { fbRequest: fb.fn, accessToken: 'base' });

  assert.equal(info.valid, false);
  assert.equal(
    info.invalidReason,
    'Error validating access token: Session has expired. (code 190, subcode 463)',
  );
});

test('debugToken parses the in-band error defensively and never invents a reason', async () => {
  const fb = createFakeFbRequest();

  // A valid token has nothing to explain.
  fb.on((r) => r.path === '/debug_token', fbOk({ data: { is_valid: true } }));
  assert.equal(
    (await debugToken('t-ok', { fbRequest: fb.fn, accessToken: 'base' })).invalidReason,
    undefined,
  );

  // Invalid with no `error` object at all — still no reason to report.
  fb.reset();
  fb.on((r) => r.path === '/debug_token', fbOk({ data: { is_valid: false } }));
  assert.equal(
    (await debugToken('t-bare', { fbRequest: fb.fn, accessToken: 'base' })).invalidReason,
    undefined,
  );

  // A message with no numbers stands on its own — no empty parenthetical.
  fb.reset();
  fb.on(
    (r) => r.path === '/debug_token',
    fbOk({
      data: { is_valid: false, error: { message: 'Invalid OAuth access token.' } },
    }),
  );
  assert.equal(
    (await debugToken('t-msg', { fbRequest: fb.fn, accessToken: 'base' })).invalidReason,
    'Invalid OAuth access token.',
  );

  // Numbers with no message still say more than silence does.
  fb.reset();
  fb.on(
    (r) => r.path === '/debug_token',
    fbOk({ data: { is_valid: false, error: { code: 190 } } }),
  );
  assert.equal(
    (await debugToken('t-code', { fbRequest: fb.fn, accessToken: 'base' })).invalidReason,
    'code 190',
  );

  // Wire junk is dropped, not coerced: a non-string message and a non-numeric
  // code must not reach the operator as "[object Object] (code NaN)".
  fb.reset();
  fb.on(
    (r) => r.path === '/debug_token',
    fbOk({
      data: {
        is_valid: false,
        error: { message: { nested: true }, code: 'oops', subcode: null },
      },
    }),
  );
  assert.equal(
    (await debugToken('t-junk', { fbRequest: fb.fn, accessToken: 'base' })).invalidReason,
    undefined,
  );

  // `error` itself not being an object must not throw the doctor over.
  fb.reset();
  fb.on(
    (r) => r.path === '/debug_token',
    fbOk({ data: { is_valid: false, error: 'nope' } }),
  );
  assert.equal(
    (await debugToken('t-str', { fbRequest: fb.fn, accessToken: 'base' })).invalidReason,
    undefined,
  );
});

// ---------------------------------------------------------------------------
// debug_token — the rest of the body is wire junk too (CC-NET-2)
// ---------------------------------------------------------------------------

test('debugToken survives a non-string token type instead of throwing (CC-NET-2)', async () => {
  const fb = createFakeFbRequest();
  // `DebugTokenData.type` is declared `string | undefined`, but the whole body
  // reaches the parser through a cast — the declaration is a hope, not a check.
  const junkTypes: readonly unknown[] = [{}, 42, ['USER'], null, true];
  for (const type of junkTypes) {
    fb.enqueue(fbOk({ data: { is_valid: true, type } }));
  }

  for (let i = 0; i < junkTypes.length; i += 1) {
    const info = await debugToken('t', { fbRequest: fb.fn, accessToken: 'base' });
    // `UNKNOWN` is exactly what that fallback exists for: we could not tell what
    // class of token this is. Throwing takes the whole doctor down instead.
    assert.equal(info.type, 'UNKNOWN');
    assert.equal(info.valid, true);
  }
});

test('debugToken drops a non-numeric expiry rather than emitting NaN (CC-NET-2)', async () => {
  const fb = createFakeFbRequest();
  const junkExpiries: readonly unknown[] = [
    'soon',
    {},
    null,
    [],
    true,
    Number.NaN,
    Infinity,
  ];
  for (const expires_at of junkExpiries) {
    fb.enqueue(fbOk({ data: { is_valid: true, type: 'USER', expires_at } }));
  }

  for (let i = 0; i < junkExpiries.length; i += 1) {
    const info = await debugToken('t', { fbRequest: fb.fn, accessToken: 'base' });
    // A NaN epoch is not a harmless wrong number: the doctor renders token
    // expiry with `new Date(ms).toISOString()`, which THROWS `RangeError:
    // Invalid time value` on NaN — so a junk `expires_at` would take down the
    // one command an operator runs to find out why their token is failing.
    assert.equal(info.expiresAt, undefined);
    assert.equal(info.dataAccessExpiresAt, undefined);
  }
});

test('debugToken keeps a real numeric expiry, in ms (CC-NET-2)', async () => {
  const fb = createFakeFbRequest();
  fb.enqueue(
    fbOk({
      data: {
        is_valid: true,
        type: 'USER',
        expires_at: 1_700_000_000,
        data_access_expires_at: 1_800_000_000,
      },
    }),
  );
  const info = await debugToken('t', { fbRequest: fb.fn, accessToken: 'base' });
  assert.equal(info.expiresAt, 1_700_000_000_000);
  assert.equal(info.dataAccessExpiresAt, 1_800_000_000_000);
});

test('debugToken tells "never expires" apart from "Graph did not say" (wave 9)', async () => {
  const fb = createFakeFbRequest();
  const deps = { fbRequest: fb.fn, accessToken: 'base' };
  // Five wire facts that used to collapse into the same `expiresAt: undefined`,
  // which whoami and the doctor then read as the confident "never expires".
  // Only Graph's literal `expires_at: 0` says that; an absent, malformed or
  // negative value says nothing, and the marker must say so.
  fb.enqueue(fbOk({ data: { is_valid: true, type: 'SYSTEM_USER' } }));
  const absent = await debugToken('t', deps);
  assert.equal(absent.expiry, 'unknown');
  assert.equal(absent.expiresAt, undefined);

  fb.enqueue(fbOk({ data: { is_valid: true, type: 'USER', expires_at: 'soon' } }));
  const malformed = await debugToken('t', deps);
  assert.equal(malformed.expiry, 'unknown');
  assert.equal(malformed.expiresAt, undefined);

  fb.enqueue(fbOk({ data: { is_valid: true, type: 'USER', expires_at: -1 } }));
  const negative = await debugToken('t', deps);
  assert.equal(negative.expiry, 'unknown');
  assert.equal(negative.expiresAt, undefined);

  fb.enqueue(fbOk({ data: { is_valid: true, type: 'SYSTEM_USER', expires_at: 0 } }));
  const never = await debugToken('t', deps);
  assert.equal(never.expiry, 'never');
  assert.equal(never.expiresAt, undefined);

  fb.enqueue(fbOk({ data: { is_valid: true, type: 'USER', expires_at: 1_893_456_000 } }));
  const known = await debugToken('t', deps);
  assert.equal(known.expiry, 'known');
  assert.equal(known.expiresAt, 1_893_456_000_000);
});

test('debugToken drops non-string identity fields rather than passing wire junk on (CC-NET-2)', async () => {
  const fb = createFakeFbRequest();
  fb.enqueue(
    fbOk({
      data: {
        is_valid: true,
        type: 'PAGE',
        app_id: { id: 1 },
        profile_id: 12345,
        user_id: ['u1'],
      },
    }),
  );

  const info = await debugToken('t', { fbRequest: fb.fn, accessToken: 'base' });
  // These are declared `string` and are consumed as such — `profileId` becomes
  // the doctor's `actingPageId`, an id an operator may go on to address a Page
  // with. Handing on a number typed as a string is worse than handing on
  // nothing: Graph node ids can exceed the safe-integer range, so a numeric
  // `profile_id` has ALREADY lost digits by the time JSON.parse is done with
  // it, and stringifying it would mint a plausible-looking id that is wrong.
  assert.equal(info.appId, undefined);
  assert.equal(info.profileId, undefined);
  assert.equal(info.userId, undefined);
});

// ---------------------------------------------------------------------------
// Regression coverage (green before and after this hardening wave) — pinned so
// a later "tidy-up" cannot quietly change these answers.
// ---------------------------------------------------------------------------

test('debugToken: a fractional or negative expiry stays a finite ms value, never NaN (CC-NET-2)', async () => {
  // Graph documents integer seconds, but a fractional `expires_at` is still a
  // moment and renders as a valid date, so it is kept as-is rather than rounded.
  // `data_access_expires_at` goes through `secondsToMs`, which accepts any
  // FINITE number: a negative epoch renders as 1969 — wrong, but wrong VISIBLY
  // in the doctor. Only NaN and the infinities are dropped there, because those
  // are what make `toISOString` throw. (A negative `expires_at` is classified
  // `unknown` instead, since wave 9 — see the "never expires" test above.)
  const fb = createFakeFbRequest();
  fb.enqueue(
    fbOk({
      data: {
        is_valid: true,
        type: 'USER',
        expires_at: 1_700_000_000.5,
        data_access_expires_at: -1,
      },
    }),
  );
  const info = await debugToken('t', { fbRequest: fb.fn, accessToken: 'base' });
  assert.equal(info.expiresAt, 1_700_000_000_500);
  assert.equal(info.dataAccessExpiresAt, -1_000);
  assert.ok(Number.isFinite(info.expiresAt));
  assert.ok(Number.isFinite(info.dataAccessExpiresAt));
  assert.doesNotThrow(() => new Date(info.expiresAt ?? 0).toISOString());
});

test('debugToken: a 2xx whose body is not the declared envelope is a classified unanswered error, never a TypeError (CC-NET-2)', async () => {
  // `FbResponse<T>.data` is a cast: a bodiless 200 arrives as `undefined`, a
  // non-JSON body as its raw string, a JSON literal as itself, and `data` may be
  // present but not an object. None of these is Graph ruling on the token, so
  // none may read as `valid:false` (the doctor would say "token malformed").
  // Each must reject with a classified GraphApiError — code 0, the real 2xx
  // status — which every caller already catches as "debug_token did not
  // answer"; an unclassified TypeError would take the doctor down instead.
  const fb = createFakeFbRequest();
  const bodies: readonly unknown[] = [
    undefined,
    'null',
    '<html>maintenance</html>',
    false,
    0,
    [],
    { data: null },
    { data: 'junk' },
    { data: 42 },
    { data: [] },
  ];
  for (const body of bodies) fb.enqueue(fbOk(body));

  for (const body of bodies) {
    const label = JSON.stringify(body) ?? 'undefined';
    await assert.rejects(
      debugToken('t', { fbRequest: fb.fn, accessToken: 'base' }),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError, `body ${label} must be a GraphApiError`);
        assert.equal(err.code, 0, `body ${label} must not claim a Graph code`);
        assert.equal(err.httpStatus, 200, `body ${label} keeps the real status`);
        return true;
      },
    );
  }
  assert.equal(fb.calls.length, bodies.length);
});

test('resolver errors name the Page, never a token value — base, override or derived (C3)', async () => {
  // Every failure path the resolver can throw on its own is exercised with
  // distinctive token values, and none of those values may appear anywhere in
  // the thrown error: the message reaches MCP clients, logs and journals, and
  // the redactor is a backstop for values it was TOLD about, not a licence to
  // put them in prose. A token in an error message is a leak the operator
  // cannot rotate away by fixing config alone.
  const TOKENS = ['EAA-BASE-SECRET', 'EAA-OVERRIDE-SECRET', 'EAA-PAGE-V1', 'EAA-PAGE-V2'];
  const leaks = (e: unknown): string[] => {
    const texts: string[] = [];
    if (e instanceof Error) {
      texts.push(e.message, JSON.stringify(e));
      if (e.cause instanceof Error) texts.push(e.cause.message);
    }
    return TOKENS.filter((token) => texts.some((text) => text.includes(token)));
  };

  // 1. Dead base token during derivation.
  {
    const fb = createFakeFbRequest();
    fb.on((r) => r.path === '/100', fbErr(tokenDead(463)));
    const resolver = createPageTokenResolver({
      fbRequest: fb.fn,
      baseToken: 'EAA-BASE-SECRET',
      clock: createFakeClock(),
      redactor: createFakeRedactor(),
    });
    await assert.rejects(resolver.resolve('100'), (e: unknown) => {
      assert.deepEqual(leaks(e), []);
      assert.match((e as Error).message, /Page 100/);
      return true;
    });
  }

  // 2. Derive body without an access_token.
  {
    const fb = createFakeFbRequest();
    fb.on((r) => r.path === '/100', fbOk({ id: '100' }));
    const resolver = createPageTokenResolver({
      fbRequest: fb.fn,
      baseToken: 'EAA-BASE-SECRET',
      clock: createFakeClock(),
      redactor: createFakeRedactor(),
    });
    await assert.rejects(resolver.resolve('100'), (e: unknown) => {
      assert.deepEqual(leaks(e), []);
      return true;
    });
  }

  // 3. Override token rejected with 190 (no re-derivation possible).
  {
    const fb = createFakeFbRequest();
    const resolver = createPageTokenResolver({
      fbRequest: fb.fn,
      baseToken: 'EAA-BASE-SECRET',
      clock: createFakeClock(),
      redactor: createFakeRedactor(),
      overrides: { '200': 'EAA-OVERRIDE-SECRET' },
    });
    await assert.rejects(
      resolver.runWithPageToken('200', () => Promise.reject(tokenDead())),
      (e: unknown) => {
        assert.deepEqual(leaks(e), []);
        assert.match((e as Error).message, /Page 200/);
        return true;
      },
    );
    assert.equal(fb.calls.length, 0);
  }

  // 4. Derived token still dead after the one permitted re-derivation.
  {
    const fb = createFakeFbRequest();
    fb.enqueue(fbOk({ access_token: 'EAA-PAGE-V1', id: '100' }));
    fb.enqueue(fbOk({ access_token: 'EAA-PAGE-V2', id: '100' }));
    const resolver = createPageTokenResolver({
      fbRequest: fb.fn,
      baseToken: 'EAA-BASE-SECRET',
      clock: createFakeClock(),
      redactor: createFakeRedactor(),
    });
    await assert.rejects(
      resolver.runWithPageToken('100', () => Promise.reject(tokenDead(467))),
      (e: unknown) => {
        assert.deepEqual(leaks(e), []);
        assert.match((e as Error).message, /Page 100/);
        return true;
      },
    );
  }

  // 5. No base token and no override.
  {
    const fb = createFakeFbRequest();
    const resolver = createPageTokenResolver({
      fbRequest: fb.fn,
      clock: createFakeClock(),
      redactor: createFakeRedactor(),
    });
    await assert.rejects(resolver.resolve('300'), (e: unknown) => {
      assert.deepEqual(leaks(e), []);
      assert.match((e as Error).message, /Page 300/);
      return true;
    });
  }
});

// ---------------------------------------------------------------------------
// Wave 14 — lane C
// ---------------------------------------------------------------------------

test('debugToken tells "granted over all assets" (no target_ids) apart from "granted over none" (wave 14)', async () => {
  // Meta's debug_token reference: "If permission applies to all, targets will
  // not be shown." An ABSENT `target_ids` is therefore the broadest grant there
  // is, while an EMPTY array is the CC-AUTH-5 "every asset was taken away"
  // signature. Collapsing both into `targetIds: []` had the doctor report a
  // business-wide System User grant as revoked.
  const fb = createFakeFbRequest();
  fb.enqueue(
    fbOk({
      data: {
        type: 'SYSTEM_USER',
        is_valid: true,
        scopes: ['pages_show_list', 'pages_manage_posts', 'ads_read', 'read_insights'],
        granular_scopes: [
          { scope: 'pages_show_list' }, // absent ⇒ all assets
          { scope: 'pages_manage_posts', target_ids: [] }, // empty ⇒ none
          { scope: 'ads_read', target_ids: ['act_1'] }, // listed
          { scope: 'read_insights', target_ids: 'nope' }, // malformed ⇒ no claim
        ],
      },
    }),
  );

  const info = await debugToken('EAA-system-token', {
    fbRequest: fb.fn,
    accessToken: 'app-1|app-secret',
  });

  assert.deepEqual(info.granularScopes, [
    { scope: 'pages_show_list', targetIds: [], appliesToAllTargets: true },
    { scope: 'pages_manage_posts', targetIds: [] },
    { scope: 'ads_read', targetIds: ['act_1'] },
    { scope: 'read_insights', targetIds: [] },
  ]);
});

for (const [subcode, cause] of [
  [459, /checkpoint/i],
  [464, /unconfirmed/i],
] as const) {
  test(`a base token refused for an account-level block (190/${String(subcode)}) does not advise minting a new token (wave 14)`, async () => {
    // The account behind the token is locked: Meta refuses EVERY token issued
    // for it until a person clears the block at facebook.com. "Refresh
    // FB_SYSTEM_TOKEN / FB_ACCESS_TOKEN" sends the operator round a loop that
    // cannot terminate — and contradicted the `action` riding on the same error,
    // which says "Do not mint a new token yet".
    const fb = createFakeFbRequest();
    fb.on((r) => r.path === '/100', fbErr(tokenDead(subcode)));
    const resolver = createPageTokenResolver({
      fbRequest: fb.fn,
      baseToken: 'EAA-base',
      clock: createFakeClock(),
      redactor: createFakeRedactor(),
    });

    await assert.rejects(resolver.resolve('100'), (e: unknown) => {
      assert.ok(e instanceof GraphApiError);
      assert.equal(e.code, 190);
      assert.equal(e.subcode, subcode);
      assert.match(e.message, /Page 100/);
      assert.match(e.message, new RegExp(`190/${String(subcode)}`));
      assert.match(e.message, cause);
      assert.match(e.message, /facebook\.com/);
      assert.doesNotMatch(e.message, /invalid or expired/);
      assert.doesNotMatch(e.message, /Refresh FB_SYSTEM_TOKEN/);
      return true;
    });
  });
}

// ---------------------------------------------------------------------------
// Wave 15 — lane F: page token resolver cache
// ---------------------------------------------------------------------------

test('runWithPageToken: a derived token still dead after re-derivation is not served again from the cache (wave 15)', async () => {
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ access_token: 'EAA-page-v1', id: '100' }));
  fb.enqueue(fbOk({ access_token: 'EAA-page-v2', id: '100' }));
  fb.enqueue(fbOk({ access_token: 'EAA-page-v3', id: '100' }));
  const resolver = createPageTokenResolver({
    fbRequest: fb.fn,
    baseToken: 'EAA-base',
    clock: createFakeClock(),
    redactor: createFakeRedactor(),
  });

  await assert.rejects(
    resolver.runWithPageToken('100', () => Promise.reject(tokenDead(463))),
    /still invalid after one re-derivation/,
  );

  // v2 was just proven dead by Graph; the next resolve must re-derive, not hand it out.
  assert.equal(await resolver.resolve('100'), 'EAA-page-v3');
  assert.equal(fb.calls.length, 3);
});

test('runWithPageToken: a session error (code 102) on a derived token invalidates and re-derives once (wave 15)', async () => {
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ access_token: 'EAA-page-v1', id: '100' }));
  fb.enqueue(fbOk({ access_token: 'EAA-page-v2', id: '100' }));
  const resolver = createPageTokenResolver({
    fbRequest: fb.fn,
    baseToken: 'EAA-base',
    clock: createFakeClock(),
    redactor: createFakeRedactor(),
  });

  const seen: string[] = [];
  const out = await resolver.runWithPageToken('100', (token) => {
    seen.push(token);
    if (seen.length === 1) {
      return Promise.reject(
        new GraphApiError('Session has expired', { code: 102, httpStatus: 401 }),
      );
    }
    return Promise.resolve('recovered');
  });

  assert.equal(out, 'recovered');
  assert.deepEqual(seen, ['EAA-page-v1', 'EAA-page-v2']);
  assert.equal(await resolver.resolve('100'), 'EAA-page-v2'); // the dead v1 is gone
  assert.equal(fb.calls.length, 2);
});

test('runWithPageToken: a second 102 after re-derivation fails with guidance naming code 102 and evicts the token (wave 15)', async () => {
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ access_token: 'EAA-page-v1', id: '100' }));
  fb.enqueue(fbOk({ access_token: 'EAA-page-v2', id: '100' }));
  fb.enqueue(fbOk({ access_token: 'EAA-page-v3', id: '100' }));
  const resolver = createPageTokenResolver({
    fbRequest: fb.fn,
    baseToken: 'EAA-base',
    clock: createFakeClock(),
    redactor: createFakeRedactor(),
  });

  await assert.rejects(
    resolver.runWithPageToken('100', () =>
      Promise.reject(
        new GraphApiError('Session has expired', { code: 102, httpStatus: 401 }),
      ),
    ),
    (e: unknown) => {
      assert.ok(e instanceof GraphApiError);
      assert.equal(e.code, 102);
      assert.match(
        e.message,
        /still invalid after one re-derivation \(Graph error 102\)/,
      );
      return true;
    },
  );
  assert.equal(await resolver.resolve('100'), 'EAA-page-v3');
});

test('resolve: concurrent resolves for one Page share a single derivation (wave 15)', async () => {
  const fb = createFakeFbRequest();
  fb.on((r) => r.path === '/100', fbOk({ access_token: 'EAA-page', id: '100' }));
  const resolver = createPageTokenResolver({
    fbRequest: fb.fn,
    baseToken: 'EAA-base',
    clock: createFakeClock(),
    redactor: createFakeRedactor(),
  });

  const tokens = await Promise.all([
    resolver.resolve('100'),
    resolver.resolve('100'),
    resolver.resolve('100'),
  ]);

  assert.deepEqual(tokens, ['EAA-page', 'EAA-page', 'EAA-page']);
  assert.equal(fb.calls.length, 1);
});

test('resolve: a rejected shared derivation is not cached — the next resolve derives again (wave 15)', async () => {
  const fb = createFakeFbRequest();
  fb.enqueue(
    fbErr(new GraphApiError('Service unavailable', { code: 2, httpStatus: 503 })),
  );
  fb.enqueue(fbOk({ access_token: 'EAA-page', id: '100' }));
  const resolver = createPageTokenResolver({
    fbRequest: fb.fn,
    baseToken: 'EAA-base',
    clock: createFakeClock(),
    redactor: createFakeRedactor(),
  });

  const settled = await Promise.allSettled([
    resolver.resolve('100'),
    resolver.resolve('100'),
  ]);
  assert.ok(settled.every((s) => s.status === 'rejected'));

  assert.equal(await resolver.resolve('100'), 'EAA-page');
  assert.equal(fb.calls.length, 2);
});

test('invalidate during an in-flight derivation: the next resolve does not join the pre-invalidation flight (wave 15)', async () => {
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ access_token: 'EAA-page-v1', id: '100' }));
  fb.enqueue(fbOk({ access_token: 'EAA-page-v2', id: '100' }));
  const resolver = createPageTokenResolver({
    fbRequest: fb.fn,
    baseToken: 'EAA-base',
    clock: createFakeClock(),
    redactor: createFakeRedactor(),
  });

  const first = resolver.resolve('100');
  resolver.invalidate('100');
  const second = resolver.resolve('100');
  assert.equal(await first, 'EAA-page-v1');
  assert.equal(await second, 'EAA-page-v2');
  // The flight that started before the invalidation must not overwrite the newer one.
  assert.equal(await resolver.resolve('100'), 'EAA-page-v2');
  assert.equal(fb.calls.length, 2);
});

test('isPageTokenDead: 190, 102 and 100 with a stale-object subcode evict; other refusals do not', () => {
  const graph = (code: number, subcode?: number): GraphApiError =>
    new GraphApiError('refused', {
      code,
      httpStatus: 400,
      ...(subcode !== undefined ? { subcode } : {}),
    });
  assert.equal(isPageTokenDead(graph(190)), true);
  assert.equal(isPageTokenDead(graph(102)), true);
  for (const subcode of STALE_OBJECT_SUBCODES) {
    assert.equal(isPageTokenDead(graph(100, subcode)), true, `100/${subcode}`);
  }
  assert.equal(isPageTokenDead(graph(100)), false);
  assert.equal(isPageTokenDead(graph(100, 1363040)), false);
  assert.equal(isPageTokenDead(graph(10)), false);
  assert.equal(isPageTokenDead(new Error('190')), false);
});

// ---------------------------------------------------------------------------
// Wave 22 — guidance that tells the operator the truth
// ---------------------------------------------------------------------------

test('a 190/492 on derivation says the base token lacks a Page role, not that it is expired (wave 22)', async () => {
  // 190/492 is "the user behind the token has no role on this Page": the token
  // itself is valid (the error matrix's `permission-190-492` row), and a fresh
  // token minted by the same user is refused identically. Wrapping it in the
  // generic "Base access token is invalid or expired ... Refresh FB_SYSTEM_TOKEN
  // / FB_ACCESS_TOKEN" sends the operator to rotate a working credential, while
  // the attached matrix action says refreshing will not help.
  const fb = createFakeFbRequest();
  fb.on((r) => r.path === '/100', fbErr(tokenDead(492)));
  const resolver = createPageTokenResolver({
    fbRequest: fb.fn,
    baseToken: 'EAA-base',
    clock: createFakeClock(),
    redactor: createFakeRedactor(),
  });

  await assert.rejects(resolver.resolve('100'), (e: unknown) => {
    assert.ok(e instanceof GraphApiError);
    assert.equal(e.code, ERROR_CODE_TOKEN_INVALID);
    assert.equal(e.subcode, 492);
    assert.doesNotMatch(e.message, /invalid or expired/);
    assert.doesNotMatch(e.message, /Refresh FB_SYSTEM_TOKEN/);
    assert.match(e.message, /no role on Page 100/);
    assert.match(e.message, /190\/492/);
    assert.match(e.message, /facebook_whoami/);
    return true;
  });
});

test('stale-Page guidance names the real profile env var, FB_PROFILE_<NAME>_PAGE_ID (wave 22)', async () => {
  // The settings loader reads a profile's Page from FB_PROFILE_<NAME>_PAGE_ID;
  // there is no FB_PROFILE_<NAME>_ID. Both stale-Page messages (override and
  // after one re-derivation) told the operator to update the variable that
  // does not exist, so the edit they make changes nothing.
  const overrideResolver = createPageTokenResolver({
    fbRequest: createFakeFbRequest().fn,
    clock: createFakeClock(),
    redactor: createFakeRedactor(),
    overrides: { '100': 'EAA-configured-page-token' },
  });
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ access_token: 'EAA-page-v1', id: '200' }));
  fb.enqueue(fbOk({ access_token: 'EAA-page-v2', id: '200' }));
  const derivedResolver = createPageTokenResolver({
    fbRequest: fb.fn,
    baseToken: 'EAA-base',
    clock: createFakeClock(),
    redactor: createFakeRedactor(),
  });
  const stale = (): Promise<never> =>
    Promise.reject(
      new GraphApiError('Page ID was migrated', {
        code: ERROR_CODE_INVALID_PARAM,
        subcode: 21,
        httpStatus: 400,
      }),
    );

  for (const [label, run] of [
    ['override', () => overrideResolver.runWithPageToken('100', stale)],
    ['re-derived', () => derivedResolver.runWithPageToken('200', stale)],
  ] as const) {
    await assert.rejects(run(), (e: unknown) => {
      assert.ok(e instanceof GraphApiError, label);
      assert.doesNotMatch(e.message, /FB_PROFILE_<NAME>_ID\b/, label);
      assert.match(e.message, /FB_PROFILE_<NAME>_PAGE_ID\b/, label);
      return true;
    });
  }
});

// ---------------------------------------------------------------------------
// Wave 23 — lane B: no invented Graph wire facts
// ---------------------------------------------------------------------------

test('a 2xx derivation with no access_token does not claim Graph error 190 or HTTP 403 (wave 23)', async () => {
  // Graph ANSWERED the derivation — 200, no error envelope — it simply left the
  // `access_token` field out (the base user has no role on the Page, or lacks
  // pages_show_list / pages_manage_metadata). The error used to report
  // `code: 190, httpStatus: 403`: two wire facts Graph never sent. The hub
  // copies both into the tool result, where 190 reads as "Invalid OAuth access
  // token" — the opposite of the message's own diagnosis — and, with no
  // `action`, the model got no `retryable` / `nextTool` to act on. 190 also
  // tripped `isPageTokenDead`, so every eviction hook treated a live base token's
  // missing Page role as a dead Page token.
  const fb = createFakeFbRequest();
  fb.on((r) => r.path === '/100', fbOk({ id: '100' }));
  const resolver = createPageTokenResolver({
    fbRequest: fb.fn,
    baseToken: 'EAA-base',
    clock: createFakeClock(),
    redactor: createFakeRedactor(),
  });

  await assert.rejects(resolver.resolve('100'), (e: unknown) => {
    assert.ok(e instanceof GraphApiError);
    assert.match(e.message, /no Page access token/);
    assert.notEqual(e.code, ERROR_CODE_TOKEN_INVALID, 'Graph sent no error code');
    assert.equal(e.httpStatus, 200, 'the status Graph actually answered with');
    assert.equal(isPageTokenDead(e), false);
    assert.equal(e.action?.category, 'permission');
    assert.equal(e.action?.retryable, false);
    assert.equal(e.action?.nextTool, 'facebook_whoami');
    return true;
  });
});
