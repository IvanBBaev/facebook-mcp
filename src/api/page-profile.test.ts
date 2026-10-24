// Tests for the Page profile helpers (organic F9, `api` layer).
//
// Covered: Graph's flat `hours` dict reshaped into ordered ranges (half ranges
// and foreign keys dropped), the profile field list with and without `emails`,
// and the Page node rewrite that leaves every other field untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadFixture } from '../testing/fixtures.js';

import {
  PROFILE_EMAILS_FIELD,
  PROFILE_READ_FIELDS,
  fromGraphHours,
  profileFields,
  withReadableHours,
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
