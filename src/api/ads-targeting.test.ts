// Tests for the narrow ad-set targeting module (v2 ads §8): the plain-terms
// summary, the "too complex to edit" refusal matrix, that every key the edit does
// not own survives byte-identical, the key-order-insensitive fingerprint, EU
// detection, the DSA probe and the error mapping. Every Graph call goes through
// the injected fake — no network, ever.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeFbRequest, fbErr, fbOk } from '../core/fakes/index.js';
import { GraphApiError, classifyGraphError, type JsonRequest } from '../core/index.js';

import {
  TOO_COMPLEX_MESSAGE,
  applyTargetingEdit,
  complexityReasons,
  dsaRefusal,
  hasDsaInfo,
  mapTargetingError,
  normalizeCountries,
  planTargetingEdit,
  readAdSetTargeting,
  summarizeTargeting,
  targetingBytes,
  targetingEditSummary,
  targetingFingerprint,
  type Targeting,
} from './ads-targeting.js';

const ADSET_ID = '23859876543210987';
const ACCOUNT_ID = 'act_1234567890';

/** A simple audience the narrow edit may touch, with keys it must not touch. */
function simple(overrides: Record<string, unknown> = {}): Targeting {
  return {
    age_min: 25,
    age_max: 54,
    genders: [1],
    geo_locations: { countries: ['US', 'CA'], location_types: ['home', 'recent'] },
    publisher_platforms: ['facebook', 'instagram'],
    facebook_positions: ['feed', 'story'],
    device_platforms: ['mobile'],
    targeting_automation: { advantage_audience: 0 },
    ...overrides,
  };
}

function graphError(code: number, message: string, subcode?: number): GraphApiError {
  return new GraphApiError(message, {
    code,
    ...(subcode !== undefined ? { subcode } : {}),
    httpStatus: 400,
    action: classifyGraphError({
      code,
      message,
      ...(subcode !== undefined ? { error_subcode: subcode } : {}),
    }),
  });
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

test('summary states the audience in plain terms', () => {
  const summary = summarizeTargeting(
    simple({
      locales: [6, 24],
      geo_locations: { countries: ['us'], regions: [{ key: '1' }] },
    }),
  );
  assert.deepEqual(summary.countries, ['US']);
  assert.equal(summary.regions_count, 1);
  assert.equal(summary.cities_count, 0);
  assert.equal(summary.age_min, 25);
  assert.equal(summary.age_max, 54);
  assert.deepEqual(summary.genders, [1]);
  assert.equal(summary.locales_count, 2);
  assert.equal(summary.advantage_audience, false);
  assert.deepEqual(summary.publisher_platforms, ['facebook', 'instagram']);
  assert.equal(summary.editable_by_this_server, false);
  assert.match(
    summary.not_editable_because.join(),
    /locations other than whole countries/,
  );
});

test('a simple audience is editable and says so', () => {
  const summary = summarizeTargeting(simple());
  assert.equal(summary.editable_by_this_server, true);
  assert.deepEqual(summary.not_editable_because, []);
  assert.equal(summary.has_custom_audiences, false);
  assert.equal(summary.has_detailed_targeting, false);
  assert.equal(summary.has_exclusions, false);
});

test('an empty blob summarises without throwing', () => {
  const summary = summarizeTargeting({});
  assert.deepEqual(summary.countries, []);
  assert.equal(summary.age_min, null);
  assert.equal(summary.advantage_audience, null);
  assert.equal(summary.advantage_audience_state, 'unset');
});

test('Advantage+ audience reads as on, off or unset', () => {
  const state = (automation: unknown) =>
    summarizeTargeting(simple({ targeting_automation: automation }))
      .advantage_audience_state;
  assert.equal(state({ advantage_audience: 1 }), 'on');
  assert.equal(state({ advantage_audience: '0' }), 'off');
  assert.equal(state({ individual_setting: { age: 1 } }), 'unset');
  assert.equal(state(undefined), 'unset');
  const unset = summarizeTargeting(simple({ targeting_automation: undefined }));
  assert.equal(unset.advantage_audience, null, 'the boolean field is unchanged');
  assert.equal(unset.editable_by_this_server, true);
});

// ---------------------------------------------------------------------------
// Refusal matrix
// ---------------------------------------------------------------------------

const COMPLEX: readonly [string, Record<string, unknown>, RegExp][] = [
  ['custom audiences', { custom_audiences: [{ id: '1' }] }, /custom audiences/],
  ['interests', { interests: [{ id: '6003' }] }, /detailed targeting/],
  [
    'flexible_spec',
    { flexible_spec: [{ behaviors: [{ id: '1' }] }] },
    /detailed targeting/,
  ],
  [
    'cities',
    { geo_locations: { countries: ['US'], cities: [{ key: '2420379' }] } },
    /cities/,
  ],
  ['zips', { geo_locations: { zips: [{ key: 'US:94304' }] } }, /zips/],
  ['exclusions', { exclusions: { interests: [{ id: '1' }] } }, /exclusions/],
  ['excluded audiences', { excluded_custom_audiences: [{ id: '9' }] }, /exclusions/],
  [
    'Advantage+ audience',
    { targeting_automation: { advantage_audience: 1 } },
    /Advantage\+ audience on/,
  ],
];

for (const [label, overrides, reason] of COMPLEX) {
  test(`an audience with ${label} is refused before any plan is built`, () => {
    const targeting = simple(overrides);
    assert.match(complexityReasons(targeting).join(', '), reason);
    assert.throws(
      () => planTargetingEdit(targeting, { ageMin: 30 }),
      (err: unknown) =>
        err instanceof GraphApiError &&
        err.message.includes(TOO_COMPLEX_MESSAGE) &&
        reason.test(err.message),
    );
  });
}

test('empty complex keys do not count as complex', () => {
  const targeting = simple({ custom_audiences: [], interests: [], exclusions: {} });
  assert.deepEqual(complexityReasons(targeting), []);
});

test('a no-op, an inverted range and an empty country list are refused', () => {
  assert.throws(
    () => planTargetingEdit(simple(), { countries: ['ca', 'US'], ageMin: 25 }),
    /Nothing to change/,
  );
  assert.throws(() => planTargetingEdit(simple(), { ageMin: 60 }), /above age_max/);
  assert.throws(() => planTargetingEdit({ age_min: 18 }, { ageMin: 21 }), /no country/);
});

// ---------------------------------------------------------------------------
// The planner keeps everything it does not own
// ---------------------------------------------------------------------------

test('the edit replaces only countries and ages; every other key is byte-identical', () => {
  const current = simple();
  const plan = planTargetingEdit(current, { countries: ['gb', 'GB', 'IE'], ageMax: 65 });
  assert.deepEqual(plan.changedFields, ['countries', 'age_max']);
  const next = plan.next as Record<string, unknown>;
  assert.deepEqual(next.geo_locations, {
    countries: ['GB', 'IE'],
    location_types: ['home', 'recent'],
  });
  assert.equal(next.age_max, 65);
  for (const key of Object.keys(current)) {
    if (key === 'geo_locations' || key === 'age_max') continue;
    assert.equal(JSON.stringify(next[key]), JSON.stringify(current[key]), key);
  }
  assert.deepEqual(Object.keys(next), Object.keys(current), 'key order is kept');
  assert.deepEqual(plan.before, { countries: ['US', 'CA'], ageMin: 25, ageMax: 54 });
  assert.deepEqual(plan.after, { countries: ['GB', 'IE'], ageMin: 25, ageMax: 65 });
});

test('the summary names before and after', () => {
  const plan = planTargetingEdit(simple(), { countries: ['MX'], ageMin: 30 });
  const text = targetingEditSummary(ADSET_ID, plan);
  assert.match(text, /countries US, CA → MX/);
  assert.match(text, /ages 25–54 → 30–54/);
  assert.match(text, /Everything else in its targeting is kept/);
});

test('an unset Advantage+ audience is written explicitly as 0 and said so', () => {
  const current = simple({ targeting_automation: { individual_setting: { age: 1 } } });
  const plan = planTargetingEdit(current, { ageMin: 30 });
  assert.equal(plan.advantageAudienceSetOff, true);
  assert.deepEqual((plan.next as Record<string, unknown>).targeting_automation, {
    individual_setting: { age: 1 },
    advantage_audience: 0,
  });
  assert.match(
    targetingEditSummary(ADSET_ID, plan),
    /Advantage\+ audience: set explicitly OFF \(was unset\)\./,
  );

  const fromBare = planTargetingEdit(simple({ targeting_automation: undefined }), {
    countries: ['MX'],
  });
  assert.deepEqual((fromBare.next as Record<string, unknown>).targeting_automation, {
    advantage_audience: 0,
  });
});

test('an Advantage+ audience already off stays 0 and the summary is silent', () => {
  const plan = planTargetingEdit(simple(), { ageMin: 30 });
  assert.equal(plan.advantageAudienceSetOff, false);
  assert.deepEqual((plan.next as Record<string, unknown>).targeting_automation, {
    advantage_audience: 0,
  });
  assert.doesNotMatch(targetingEditSummary(ADSET_ID, plan), /Advantage/);
});

test('countries are upper-cased and de-duplicated in caller order', () => {
  assert.deepEqual(normalizeCountries(['de', ' FR', 'DE']), ['DE', 'FR']);
});

// ---------------------------------------------------------------------------
// Fingerprint and size
// ---------------------------------------------------------------------------

test('the fingerprint ignores key order but not values', () => {
  const a = targetingFingerprint({ age_min: 18, geo_locations: { countries: ['US'] } });
  const b = targetingFingerprint({ geo_locations: { countries: ['US'] }, age_min: 18 });
  const c = targetingFingerprint({ geo_locations: { countries: ['US'] }, age_min: 19 });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('the byte size counts UTF-8', () => {
  assert.equal(targetingBytes({ a: 'é' }), Buffer.byteLength('{"a":"é"}'));
});

// ---------------------------------------------------------------------------
// EU and DSA
// ---------------------------------------------------------------------------

test('EU countries are flagged only when the audience had none', () => {
  const fromNone = planTargetingEdit(simple(), { countries: ['US', 'DE', 'FR'] });
  assert.deepEqual(fromNone.euAdded, ['DE', 'FR']);
  const fromEu = planTargetingEdit(simple({ geo_locations: { countries: ['IT'] } }), {
    countries: ['IT', 'DE'],
  });
  assert.deepEqual(fromEu.euAdded, []);
});

test('DSA info on the ad set is enough; the account is not read', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk({ dsa_payor: 'Acme', dsa_beneficiary: 'Acme' }));
  assert.equal(await hasDsaInfo(fb.fn, ADSET_ID, ACCOUNT_ID), true);
  assert.equal(fb.calls.length, 1);
});

test('DSA info falls back to the account defaults', async () => {
  const fb = createFakeFbRequest();
  fb.on((r) => r.path === `/${ADSET_ID}`, fbOk({}));
  fb.on(
    (r) => r.path === `/${ACCOUNT_ID}`,
    fbOk({ default_dsa_payor: 'Acme', default_dsa_beneficiary: 'Acme Ltd' }),
  );
  assert.equal(await hasDsaInfo(fb.fn, ADSET_ID, ACCOUNT_ID), true);
});

test('a failed DSA read counts as not set', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    () => true,
    fbErr(graphError(100, 'Tried accessing nonexisting field (dsa_payor)')),
  );
  assert.equal(await hasDsaInfo(fb.fn, ADSET_ID, ACCOUNT_ID), false);
  assert.equal(await hasDsaInfo(fb.fn, ADSET_ID, undefined), false);
});

test('the DSA refusal names the EU countries and changes nothing', () => {
  const err = dsaRefusal(ADSET_ID, ['DE']);
  assert.match(err.message, /EU targeting \(DE\)/);
  assert.match(err.message, /Nothing was changed/);
  assert.equal(err.action?.category, 'validation');
});

// ---------------------------------------------------------------------------
// Read and write
// ---------------------------------------------------------------------------

test('the read asks for the targeting fields and tolerates a missing blob', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk({ id: ADSET_ID, account_id: '1234567890' }));
  const read = await readAdSetTargeting(fb.fn, ADSET_ID);
  assert.deepEqual(read, { id: ADSET_ID, accountId: '1234567890', targeting: {} });
  const call = fb.calls[0] as JsonRequest;
  assert.equal(call.params?.fields, 'id,name,account_id,targeting');
});

test('apply posts the whole new blob and reports after only on success', async () => {
  const plan = planTargetingEdit(simple(), { ageMin: 30 });
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk({ success: true }));
  const out = await applyTargetingEdit(fb.fn, ADSET_ID, plan);
  assert.equal(out.success, true);
  assert.deepEqual(out.after, plan.after);
  const call = fb.calls[0] as JsonRequest;
  assert.equal(call.method, 'POST');
  assert.equal(call.path, `/${ADSET_ID}`);
  assert.deepEqual(call.body, { targeting: plan.next });

  const declined = createFakeFbRequest();
  declined.on(() => true, fbOk({ success: false }));
  const refused = await applyTargetingEdit(declined.fn, ADSET_ID, plan);
  assert.equal(refused.success, false);
  assert.equal(refused.after, undefined);
});

test('known targeting refusals gain guidance; others keep their words', () => {
  const dsa = mapTargetingError(
    graphError(100, 'The DSA beneficiary is required for ads in the EU.', 3858504),
    ADSET_ID,
  ) as GraphApiError;
  assert.match(dsa.message, /DSA payor \/ beneficiary info/);
  assert.match(dsa.message, /Nothing was changed/);
  assert.equal(dsa.subcode, 3858504);

  const asc = mapTargetingError(
    graphError(100, 'Targeting cannot be edited on Advantage+ shopping campaigns.'),
    ADSET_ID,
  ) as GraphApiError;
  assert.match(asc.message, /Advantage\+ campaign/);

  const throttled = mapTargetingError(
    graphError(613, 'Calls to this api have exceeded the rate limit.'),
    ADSET_ID,
  ) as GraphApiError;
  assert.match(throttled.message, /do not retry in a loop/);

  const plain = new Error('socket hang up');
  assert.equal(mapTargetingError(plain, ADSET_ID), plain);
});
