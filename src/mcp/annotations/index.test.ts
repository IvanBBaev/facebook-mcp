// destructiveHint derivation (AUX-04): every manifest row must follow
// `deriveDestructiveHint`, carry a recorded override, or be a pending lane fix.
//
// `../annotations.test.ts` already proves the manifest equals the live
// registry, so asserting the rows here asserts what `tools/list` publishes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ANNOTATION_MANIFEST,
  DESTRUCTIVE_OVERRIDES,
  OVERWRITES_EXISTING_STATE,
  PENDING_DESTRUCTIVE_FIXES,
  deriveDestructiveHint,
} from './index.js';

const ROWS = new Map(ANNOTATION_MANIFEST.map((row) => [row[0], row] as const));

function derivedFor(name: string): boolean {
  const row = ROWS.get(name);
  assert.ok(row, `${name} is not in the annotation manifest`);
  return deriveDestructiveHint(row[5], OVERWRITES_EXISTING_STATE.has(name));
}

test('deriveDestructiveHint: tier and overwrite rule', () => {
  assert.equal(deriveDestructiveHint(undefined, false), false);
  assert.equal(deriveDestructiveHint(undefined, true), false);
  assert.equal(deriveDestructiveHint('safe', false), false);
  assert.equal(deriveDestructiveHint('reversible', false), false);
  assert.equal(deriveDestructiveHint('safe', true), true);
  assert.equal(deriveDestructiveHint('reversible', true), true);
  assert.equal(deriveDestructiveHint('irreversible', false), true);
  assert.equal(deriveDestructiveHint('spend', false), true);
});

test('every row follows the derivation, a recorded override, or a pending fix', () => {
  const violations: string[] = [];
  for (const [name, , destructive] of ANNOTATION_MANIFEST) {
    const derived = derivedFor(name);
    const override = DESTRUCTIVE_OVERRIDES[name];
    const pending = PENDING_DESTRUCTIVE_FIXES[name];
    if (override) {
      if (destructive !== override.destructiveHint) {
        violations.push(`${name}: hint ${destructive} disagrees with its override`);
      }
    } else if (pending) {
      if (destructive === derived) {
        violations.push(
          `${name}: fixed (destructiveHint ${destructive}); remove it from PENDING_DESTRUCTIVE_FIXES`,
        );
      }
    } else if (destructive !== derived) {
      violations.push(
        `${name}: destructiveHint ${destructive}, derived ${derived} — fix the fragment row ` +
          'or record an override with a reason',
      );
    }
  }
  assert.deepEqual(violations, []);
});

test('overrides are needed, reasoned and name real tools', () => {
  for (const [name, override] of Object.entries(DESTRUCTIVE_OVERRIDES)) {
    assert.notEqual(
      override.destructiveHint,
      derivedFor(name),
      `${name}: override is redundant`,
    );
    assert.ok(
      override.reason.trim().length >= 20,
      `${name}: override needs a recorded reason`,
    );
    assert.equal(
      PENDING_DESTRUCTIVE_FIXES[name],
      undefined,
      `${name}: both override and pending`,
    );
  }
});

test('pending fixes name real tools and an owner; the list never grows', () => {
  for (const [name, pending] of Object.entries(PENDING_DESTRUCTIVE_FIXES)) {
    assert.ok(ROWS.has(name), `${name} is not in the annotation manifest`);
    assert.match(pending.owner, /^L2\.[a-z-]+$/, `${name}: owner must be a wave 2 lane`);
    assert.ok(pending.finding.length > 0, `${name}: finding is required`);
  }
  // Ratchet: lanes remove entries as they fix rows; nobody adds one.
  assert.ok(Object.keys(PENDING_DESTRUCTIVE_FIXES).length <= 8);
});

test('OVERWRITES_EXISTING_STATE names write tools only', () => {
  for (const name of OVERWRITES_EXISTING_STATE) {
    const row = ROWS.get(name);
    assert.ok(row, `${name} is not in the annotation manifest`);
    assert.notEqual(row[5], undefined, `${name} is read-only; it cannot overwrite state`);
  }
});
