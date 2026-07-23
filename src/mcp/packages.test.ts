// Tests for the PACKAGES manifest + selection expansion (task F11, C5, CC-CFG-3).
//
// The default-profile expansion is a frozen inline snapshot: the out-of-box tool
// surface must never drift without this literal changing in review.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PROFILE,
  DEFAULT_PROFILE_PACKAGES,
  PROFILES,
  PackageSelectionError,
  expandSelection,
  knownSelectionNames,
  sortByCanonical,
} from './packages.js';

// ---------------------------------------------------------------------------
// Default profile — frozen snapshot (C5: core+posts+reader+insights+moderation+
// messages; `ads` excluded)
// ---------------------------------------------------------------------------

test('DEFAULT_PROFILE_PACKAGES is the frozen default surface (ads excluded)', () => {
  assert.deepEqual(
    [...DEFAULT_PROFILE_PACKAGES],
    ['core', 'posts', 'reader', 'insights', 'moderation', 'messages'],
  );
  assert.equal(DEFAULT_PROFILE_PACKAGES.includes('ads' as never), false);
});

test('DEFAULT_PROFILE set mirrors the ordered constant', () => {
  assert.equal(DEFAULT_PROFILE.has('core'), true);
  assert.equal(DEFAULT_PROFILE.has('ads'), false);
  assert.equal(DEFAULT_PROFILE.size, DEFAULT_PROFILE_PACKAGES.length);
});

test('the `core` profile expands to exactly the default surface', () => {
  assert.deepEqual(sortByCanonical(expandSelection(['core'])), [
    'core',
    'reader',
    'posts',
    'insights',
    'moderation',
    'messages',
  ]);
});

test('the `all` profile adds ads on top of the default surface', () => {
  assert.deepEqual(sortByCanonical(expandSelection(['all'])), [
    'core',
    'reader',
    'posts',
    'insights',
    'moderation',
    'messages',
    'ads',
  ]);
});

// ---------------------------------------------------------------------------
// Namespace collision (CC-CFG-3): a reserved profile name wins over the
// same-spelled package
// ---------------------------------------------------------------------------

test('profiles resolve before packages so `core` is the profile, not the lone package', () => {
  // If the single `core` package won, this would be just ['core'].
  assert.equal(expandSelection(['core']).length, DEFAULT_PROFILE_PACKAGES.length);
});

test('single-package persona profiles map to themselves', () => {
  assert.deepEqual(expandSelection(['reader']), ['reader']);
  assert.deepEqual(expandSelection(['publisher']), ['posts']);
  assert.deepEqual(expandSelection(['moderator']), ['moderation']);
  assert.deepEqual(expandSelection(['ads']), ['ads']);
});

// ---------------------------------------------------------------------------
// expandSelection mechanics: case-insensitive, blank-skipping, de-duplicating
// ---------------------------------------------------------------------------

test('expandSelection is case-insensitive, trims, and skips blanks', () => {
  assert.deepEqual(expandSelection([' Reader ', '', '  ', 'ADS']), ['reader', 'ads']);
});

test('expandSelection de-duplicates overlapping tokens', () => {
  // `core` profile already includes `reader`; adding `reader` explicitly is a no-op.
  assert.deepEqual(
    sortByCanonical(expandSelection(['core', 'reader'])),
    sortByCanonical(expandSelection(['core'])),
  );
});

test('expandSelection of an empty list yields an empty list', () => {
  assert.deepEqual(expandSelection([]), []);
});

// ---------------------------------------------------------------------------
// Unknown-name error (CC-CFG-3: startup error lists the valid names)
// ---------------------------------------------------------------------------

test('expandSelection throws PackageSelectionError listing every valid name', () => {
  assert.throws(
    () => expandSelection(['reader', 'notaprofile', 'alsobad']),
    (err: unknown) => {
      assert.ok(err instanceof PackageSelectionError);
      // Both unknowns reported at once, verbatim.
      assert.deepEqual(err.unknownNames, ['notaprofile', 'alsobad']);
      // The valid set is surfaced for the operator.
      assert.deepEqual(err.validNames, knownSelectionNames());
      for (const valid of ['core', 'all', 'reader', 'ads', 'posts', 'messages']) {
        assert.ok(err.validNames.includes(valid), `expected ${valid} in validNames`);
      }
      // And the message names both the offenders and the valid set.
      assert.match(err.message, /notaprofile/);
      assert.match(err.message, /Valid names:/);
      return true;
    },
  );
});

test('knownSelectionNames is the sorted union of profiles and packages', () => {
  const names = knownSelectionNames();
  // sorted
  assert.deepEqual([...names], [...names].sort());
  // union members present
  for (const key of Object.keys(PROFILES)) {
    assert.ok(names.includes(key), `profile ${key} missing`);
  }
  for (const pkg of [
    'core',
    'reader',
    'posts',
    'insights',
    'moderation',
    'messages',
    'ads',
  ]) {
    assert.ok(names.includes(pkg), `package ${pkg} missing`);
  }
  // de-duplicated (reader/ads/core appear once despite being both profile & package)
  assert.equal(new Set(names).size, names.length);
});

// ---------------------------------------------------------------------------
// sortByCanonical
// ---------------------------------------------------------------------------

test('sortByCanonical orders by PACKAGE_NAMES position regardless of input order', () => {
  assert.deepEqual(sortByCanonical(['ads', 'core', 'insights', 'reader']), [
    'core',
    'reader',
    'insights',
    'ads',
  ]);
});
