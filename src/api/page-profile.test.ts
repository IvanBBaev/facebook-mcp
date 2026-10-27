// Tests for the Page profile helpers (organic F9 read, F8 update; `api` layer).
//
// Covered: Graph's flat `hours` dict reshaped into ordered ranges (half ranges
// and foreign keys dropped), the profile field list with and without `emails`,
// the Page node rewrite that leaves every other field untouched, and the update
// side: the hours round-trip, the hours rules, the before/after diff with no-op
// fields dropped, the POST body, the permission re-map and the verify step.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadFixture } from '../testing/fixtures.js';

import { GraphApiError } from '../core/index.js';

import {
  PROFILE_EMAILS_FIELD,
  PROFILE_READ_FIELDS,
  diffProfile,
  fromGraphHours,
  mapProfileError,
  profileFields,
  profileMismatches,
  profileUpdateBody,
  renderHours,
  toGraphHours,
  toProfileSnapshot,
  validateHours,
  withReadableHours,
  type HoursRange,
} from './page-profile.js';

test('fromGraphHours orders ranges by day, then by range number', async () => {
  const page = await loadFixture<{ hours: unknown }>('graph-page-profile.json');
  assert.deepEqual(fromGraphHours(page.hours), [
    { day: 'mon', open: '09:00', close: '12:00' },
    { day: 'mon', open: '14:00', close: '18:00' },
    { day: 'tue', open: '09:00', close: '18:00' },
  ]);
});

test('fromGraphHours drops half ranges and keys it does not recognise', () => {
  assert.deepEqual(
    fromGraphHours({
      wed_1_open: '08:00',
      thu_1_open: '10:00',
      thu_1_close: '02:00',
      holiday: 'closed',
      fri_1_close: 18,
    }),
    [{ day: 'thu', open: '10:00', close: '02:00' }],
  );
  assert.equal(fromGraphHours('mon 9-5'), undefined);
  assert.equal(fromGraphHours(null), undefined);
  assert.deepEqual(fromGraphHours({}), []);
});

test('profileFields adds emails only when asked', () => {
  assert.equal(profileFields(false), PROFILE_READ_FIELDS.join(','));
  assert.equal(
    profileFields(true),
    `${PROFILE_READ_FIELDS.join(',')},${PROFILE_EMAILS_FIELD}`,
  );
  assert.equal(profileFields(false).includes('emails'), false);
});

test('withReadableHours rewrites hours and leaves the rest of the node alone', async () => {
  const page = await loadFixture<Record<string, unknown>>('graph-page-profile.json');
  const out = withReadableHours(page);
  assert.equal(out.website, 'https://example.com');
  assert.deepEqual(out.location, page.location);
  assert.ok(Array.isArray(out.hours));
  assert.deepEqual(withReadableHours({ id: '1' }), { id: '1' });
  assert.deepEqual(withReadableHours({ id: '1', hours: 'unreadable' }), { id: '1' });
});

// ---------------------------------------------------------------------------
// Profile update (organic F8)
// ---------------------------------------------------------------------------

async function fixtureSnapshot() {
  return toProfileSnapshot(
    await loadFixture<Record<string, unknown>>('graph-page-profile.json'),
  );
}

function isValidation(err: unknown): boolean {
  return err instanceof GraphApiError && err.code === 100 && err.httpStatus === 400;
}

test('toGraphHours numbers each day in input order and round-trips through fromGraphHours', () => {
  const ranges: HoursRange[] = [
    { day: 'tue', open: '09:00', close: '18:00' },
    { day: 'mon', open: '09:00', close: '12:00' },
    { day: 'mon', open: '14:00', close: '18:00' },
  ];
  const graph = toGraphHours(ranges);
  assert.deepEqual(graph, {
    mon_1_open: '09:00',
    mon_1_close: '12:00',
    mon_2_open: '14:00',
    mon_2_close: '18:00',
    tue_1_open: '09:00',
    tue_1_close: '18:00',
  });
  assert.deepEqual(fromGraphHours(graph), [ranges[1], ranges[2], ranges[0]]);
});

test('validateHours enforces HH:MM, two ranges per day and the overnight rule', () => {
  validateHours([{ day: 'fri', open: '18:00', close: '02:00' }]);
  validateHours([{ day: 'fri', open: '18:00', close: '06:00' }]);
  for (const bad of [
    [{ day: 'mon', open: '9:00', close: '18:00' }],
    [{ day: 'mon', open: '09:00', close: '24:00' }],
    [{ day: 'mon', open: '09:00', close: '09:00' }],
    [{ day: 'sat', open: '18:00', close: '07:00' }],
    [
      { day: 'mon', open: '08:00', close: '10:00' },
      { day: 'mon', open: '11:00', close: '13:00' },
      { day: 'mon', open: '14:00', close: '18:00' },
    ],
  ] as HoursRange[][]) {
    assert.throws(() => validateHours(bad), isValidation, JSON.stringify(bad));
  }
});

test('renderHours reads like a timetable', () => {
  assert.equal(renderHours([]), '(none)');
  assert.equal(
    renderHours([
      { day: 'tue', open: '09:00', close: '18:00' },
      { day: 'mon', open: '09:00', close: '12:00' },
    ]),
    'Mon 09:00–12:00, Tue 09:00–18:00',
  );
});

test('diffProfile keeps the changing fields and drops the no-ops', async () => {
  const before = await fixtureSnapshot();
  const diff = diffProfile(before, {
    about: 'Synthetic Page for the unit suite.',
    phone: '+1 555 0199',
    hours: [
      { day: 'mon', open: '09:00', close: '12:00' },
      { day: 'tue', open: '09:00', close: '18:00' },
      { day: 'mon', open: '14:00', close: '18:00' },
    ],
    temporary_status: 'TEMPORARILY_CLOSED',
  });
  assert.deepEqual(diff.unchanged, ['about', 'hours']);
  assert.deepEqual(diff.changes, [
    { field: 'phone', before: '+1 555 0100', after: '+1 555 0199' },
    {
      field: 'temporary_status',
      before: 'OPERATING_AS_USUAL',
      after: 'TEMPORARILY_CLOSED',
    },
  ]);
});

test('diffProfile reports an absent before-value as null', () => {
  const diff = diffProfile(toProfileSnapshot({}), {
    website: 'https://example.org',
    is_always_open: true,
  });
  assert.deepEqual(diff.changes, [
    { field: 'website', before: null, after: 'https://example.org' },
    { field: 'is_always_open', before: null, after: true },
  ]);
});

test('profileUpdateBody sends only the named fields, hours as a JSON string', () => {
  const update = {
    about: 'a',
    phone: '+1 555 0199',
    hours: [{ day: 'wed' as const, open: '10:00', close: '16:00' }],
  };
  assert.deepEqual(profileUpdateBody(update, ['phone', 'hours']), {
    phone: '+1 555 0199',
    hours: JSON.stringify({ wed_1_open: '10:00', wed_1_close: '16:00' }),
  });
});

test('mapProfileError names pages_manage_metadata and EDIT_PROFILE for permission codes', () => {
  for (const code of [10, 200, 283]) {
    const mapped = mapProfileError(
      new GraphApiError('(#200) Permissions error', { code, httpStatus: 403 }),
    );
    assert.ok(mapped instanceof GraphApiError);
    assert.equal(mapped.code, code);
    assert.equal(mapped.action?.category, 'permission');
    assert.equal(mapped.action?.retryable, false);
    assert.match(mapped.message, /pages_manage_metadata/);
    assert.match(mapped.message, /EDIT_PROFILE/);
  }
  const param = new GraphApiError('Invalid parameter', { code: 100, httpStatus: 400 });
  assert.equal(mapProfileError(param), param);
});

test('profileMismatches lists the fields the re-read does not confirm', async () => {
  const before = await fixtureSnapshot();
  const { changes } = diffProfile(before, {
    phone: '+1 555 0199',
    website: 'https://example.org',
  });
  const after = toProfileSnapshot({
    phone: '+15550199',
    website: 'https://example.org',
  });
  assert.deepEqual(profileMismatches(after, changes), ['phone']);
});
