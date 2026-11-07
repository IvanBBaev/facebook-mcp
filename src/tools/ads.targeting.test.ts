// Tests for the `ads` tool package: ad-set targeting read and the narrow targeting edit.
//
// Split out of `ads.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/ads.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fbOk, type FakeFbRequest } from '../core/fakes/index.js';
import type { FbRequest } from '../core/index.js';
import {
  ACCOUNT_ID,
  ADSET_ID,
  BARE_ACCOUNT_ID,
  OTHER_ACCOUNT_ID,
  arr,
  body,
  isJson,
  makeHarness,
  obj,
  str,
  tool,
  writes,
} from '../testing/harness/ads.js';

// ---------------------------------------------------------------------------
// Ad-set targeting read and narrow edit (v2 ads §8)
// ---------------------------------------------------------------------------

/** A simple audience the narrow edit may touch. */
function simpleTargeting(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    age_min: 25,
    age_max: 54,
    geo_locations: { countries: ['US'], location_types: ['home'] },
    publisher_platforms: ['facebook'],
    targeting_automation: { advantage_audience: 0 },
    ...overrides,
  };
}

function adsetTargetingNode(
  targeting: Record<string, unknown>,
  accountId = BARE_ACCOUNT_ID,
): Record<string, unknown> {
  return { id: ADSET_ID, name: 'Lookalikes', account_id: accountId, targeting };
}

/** Serve the account read and the ad-set targeting read(s), in order. */
function stubTargetingReads(
  fb: FakeFbRequest,
  ...targetings: readonly Record<string, unknown>[]
): void {
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${ACCOUNT_ID}`,
    fbOk({ id: ACCOUNT_ID, account_status: 1, currency: 'EUR', name: 'Test account' }),
  );
  const isTargetingRead = (r: FbRequest): boolean =>
    r.method === 'GET' &&
    r.path === `/${ADSET_ID}` &&
    isJson(r) &&
    r.params?.fields === 'id,name,account_id,targeting';
  targetings.slice(0, -1).forEach((t) => {
    fb.on(isTargetingRead, fbOk(adsetTargetingNode(t)), 1);
  });
  fb.on(isTargetingRead, fbOk(adsetTargetingNode(targetings.at(-1) ?? {})));
}

test('get targeting returns the summary, the raw blob only on request', async () => {
  const { fb, ctx } = makeHarness();
  stubTargetingReads(fb, simpleTargeting());
  const get = tool('facebook_get_ad_set_targeting');

  const plain = body(
    await get.handler(get.inputSchema.parse({ adset_id: ADSET_ID }), ctx),
  );
  assert.equal(plain.adsetId, ADSET_ID);
  assert.equal(obj(plain.summary).editable_by_this_server, true);
  assert.deepEqual(obj(plain.summary).countries, ['US']);
  assert.equal(plain.targeting, undefined);
  assert.equal(typeof plain.raw_bytes, 'number');

  const raw = body(
    await get.handler(
      get.inputSchema.parse({ adset_id: ADSET_ID, include_raw: true }),
      ctx,
    ),
  );
  assert.deepEqual(raw.targeting, simpleTargeting());
});

test('get targeting says when Advantage+ audience is unset', async () => {
  const { fb, ctx } = makeHarness();
  stubTargetingReads(fb, simpleTargeting({ targeting_automation: undefined }));
  const get = tool('facebook_get_ad_set_targeting');

  const summary = obj(
    body(await get.handler(get.inputSchema.parse({ adset_id: ADSET_ID }), ctx)).summary,
  );
  assert.equal(summary.advantage_audience_state, 'unset');
  assert.equal(summary.advantage_audience, null);
});

test('get targeting refuses an ad set from another explicitly named account', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(
    (r) => r.method === 'GET',
    fbOk(adsetTargetingNode(simpleTargeting(), '9876543210')),
  );
  const get = tool('facebook_get_ad_set_targeting');
  await assert.rejects(
    () =>
      get.handler(
        get.inputSchema.parse({ adset_id: ADSET_ID, ad_account_id: ACCOUNT_ID }),
        ctx,
      ),
    new RegExp(`belongs to ad account ${OTHER_ACCOUNT_ID}`),
  );
});

test('a targeting edit previews before → after as a spend write and changes nothing', async () => {
  const { fb, ctx, journal } = makeHarness();
  stubTargetingReads(fb, simpleTargeting());
  const update = tool('facebook_update_ad_set_targeting');

  const preview = body(
    await update.handler(
      update.inputSchema.parse({
        adset_id: ADSET_ID,
        countries: ['us', 'ca'],
        age_max: 65,
      }),
      ctx,
    ),
  );
  assert.equal(preview.status, 'preview');
  assert.equal(preview.tier, 'spend');
  assert.match(str(preview.summary), /countries US → US, CA/);
  assert.match(str(preview.summary), /ages 25–54 → 25–65/);
  assert.ok(arr(preview.warnings).some((w) => /learning phase/.test(str(w))));
  assert.equal(writes(fb).length, 0);
  assert.equal(journal.entries.length, 0);
});

test('applying a targeting edit posts the whole blob with only the owned keys changed', async () => {
  const { fb, ctx, journal } = makeHarness();
  const current = simpleTargeting({ device_platforms: ['mobile'] });
  stubTargetingReads(fb, current);
  fb.on((r) => r.method === 'POST', fbOk({ success: true }));
  const update = tool('facebook_update_ad_set_targeting');
  const args = { adset_id: ADSET_ID, age_min: 30 };

  const preview = body(await update.handler(update.inputSchema.parse(args), ctx));
  const applied = body(
    await update.handler(
      update.inputSchema.parse({ ...args, apply: true, plan_id: str(preview.planId) }),
      ctx,
    ),
  );

  assert.equal(applied.status, 'applied');
  const [post] = writes(fb);
  assert.ok(post && isJson(post));
  assert.equal(post.path, `/${ADSET_ID}`);
  assert.deepEqual(post.body, { targeting: { ...current, age_min: 30 } });
  assert.deepEqual(obj(applied.result).after, {
    countries: ['US'],
    ageMin: 30,
    ageMax: 54,
  });
  const entry = journal.entries.at(-1);
  assert.equal(entry?.outcome, 'applied');
  assert.deepEqual(obj(entry?.metadata).changedFields, ['age_min']);
});

test('a targeting edit diverges when any key changed after the preview', async () => {
  const { fb, ctx } = makeHarness();
  stubTargetingReads(
    fb,
    simpleTargeting(),
    simpleTargeting({ publisher_platforms: ['facebook', 'instagram'] }),
  );
  fb.on((r) => r.method === 'POST', fbOk({ success: true }));
  const update = tool('facebook_update_ad_set_targeting');
  const args = { adset_id: ADSET_ID, age_min: 30 };

  const preview = body(await update.handler(update.inputSchema.parse(args), ctx));
  const result = body(
    await update.handler(
      update.inputSchema.parse({ ...args, apply: true, plan_id: str(preview.planId) }),
      ctx,
    ),
  );
  assert.equal(result.status, 'diverged');
  assert.equal(writes(fb).length, 0);
});

test('a complex audience is refused before any preview', async () => {
  const { fb, ctx } = makeHarness();
  stubTargetingReads(fb, simpleTargeting({ custom_audiences: [{ id: '1' }] }));
  const update = tool('facebook_update_ad_set_targeting');
  await assert.rejects(
    () =>
      update.handler(update.inputSchema.parse({ adset_id: ADSET_ID, age_min: 30 }), ctx),
    /more complex than this tool edits.*custom audiences/,
  );
  assert.equal(writes(fb).length, 0);
});

test('adding EU countries without DSA info is refused; with account defaults it previews', async () => {
  const update = tool('facebook_update_ad_set_targeting');
  const args: unknown = update.inputSchema.parse({
    adset_id: ADSET_ID,
    countries: ['US', 'DE'],
  });
  const isDsaRead = (r: FbRequest): boolean =>
    isJson(r) && /dsa/.test(String(r.params?.fields ?? ''));

  const missing = makeHarness();
  missing.fb.on(isDsaRead, fbOk({}));
  stubTargetingReads(missing.fb, simpleTargeting());
  await assert.rejects(() => update.handler(args, missing.ctx), /EU targeting \(DE\)/);
  assert.equal(writes(missing.fb).length, 0);

  const known = makeHarness();
  known.fb.on(
    (r) => isDsaRead(r) && r.path === `/${ACCOUNT_ID}`,
    fbOk({ default_dsa_payor: 'Acme', default_dsa_beneficiary: 'Acme' }),
  );
  known.fb.on(isDsaRead, fbOk({}));
  stubTargetingReads(known.fb, simpleTargeting());
  const preview = body(await update.handler(args, known.ctx));
  assert.equal(preview.status, 'preview');
});

test('a targeting edit with nothing to change is refused', async () => {
  const { fb, ctx } = makeHarness();
  stubTargetingReads(fb, simpleTargeting());
  const update = tool('facebook_update_ad_set_targeting');
  await assert.rejects(
    () => update.handler(update.inputSchema.parse({ adset_id: ADSET_ID }), ctx),
    /Nothing to change/,
  );
  await assert.rejects(
    () =>
      update.handler(update.inputSchema.parse({ adset_id: ADSET_ID, age_min: 25 }), ctx),
    /Nothing to change/,
  );
  assert.throws(() =>
    update.inputSchema.parse({ adset_id: ADSET_ID, countries: ['USA'] }),
  );
  assert.throws(() => update.inputSchema.parse({ adset_id: 'act_1', age_min: 30 }));
});
