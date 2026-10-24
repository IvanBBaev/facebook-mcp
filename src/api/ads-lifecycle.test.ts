// Tests for the pure archive/delete planner and its request shapes (v2 ads §3).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GraphApiError } from '../core/index.js';
import {
  ARCHIVE_NOTE,
  DELETE_PERMANENT_NOTE,
  DELIVERED_28D_NOTE,
  DELIVERED_28D_UNKNOWN_NOTE,
  STOPS_DELIVERY_NOTE,
  archiveAdObjectRequest,
  deleteAdObjectRequest,
  planLifecycleChange,
} from './ads-lifecycle.js';
import type { LifecycleTarget } from './ads-lifecycle.js';
import { normalizeAdNode } from './ads-read.js';

const ID = '23851234567890123';

function plan(
  status: string,
  target: LifecycleTarget,
  extra: Partial<Parameters<typeof planLifecycleChange>[0]> = {},
) {
  return planLifecycleChange({
    objectId: ID,
    level: 'campaign',
    current: normalizeAdNode({ id: ID, status, effective_status: status }),
    target,
    children: { adsets: 1, ads: 4 },
    delivered28d: false,
    ...extra,
  });
}

test('the transitions table: what is refused and what is allowed', () => {
  const cases: readonly [string, LifecycleTarget, 'ok' | RegExp][] = [
    ['ACTIVE', 'ARCHIVED', 'ok'],
    ['PAUSED', 'ARCHIVED', 'ok'],
    ['ARCHIVED', 'ARCHIVED', /already archived.*facebook_delete_ad_object/],
    ['DELETED', 'ARCHIVED', /already deleted/],
    ['ACTIVE', 'DELETED', 'ok'],
    ['PAUSED', 'DELETED', 'ok'],
    ['ARCHIVED', 'DELETED', 'ok'],
    ['DELETED', 'DELETED', /already deleted/],
  ];
  for (const [from, to, want] of cases) {
    const label = `${from} -> ${to}`;
    if (want === 'ok') {
      const p = plan(from, to);
      assert.equal(p.fromStatus, from, label);
      assert.equal(p.toStatus, to, label);
      assert.match(p.summary, new RegExp(`${from} -> ${to}`), label);
    } else {
      assert.throws(
        () => plan(from, to),
        (err: unknown) => err instanceof GraphApiError && want.test(err.message),
        label,
      );
    }
  }
});

test('archive warns that archived objects cannot be resumed', () => {
  const p = plan('PAUSED', 'ARCHIVED');
  assert.ok(p.warnings.includes(ARCHIVE_NOTE));
  assert.ok(!p.warnings.includes(DELETE_PERMANENT_NOTE));
});

test('the 28-day warning follows spend, effective_status, or an unknown read', () => {
  assert.ok(!plan('PAUSED', 'DELETED').warnings.includes(DELIVERED_28D_NOTE));
  assert.ok(
    plan('PAUSED', 'DELETED', { delivered28d: true }).warnings.includes(
      DELIVERED_28D_NOTE,
    ),
  );
  const active = plan('ACTIVE', 'DELETED');
  assert.ok(active.warnings.includes(DELIVERED_28D_NOTE));
  assert.ok(active.warnings.includes(STOPS_DELIVERY_NOTE));
  const unknown = planLifecycleChange({
    objectId: ID,
    level: 'campaign',
    current: normalizeAdNode({ id: ID, status: 'PAUSED', effective_status: 'PAUSED' }),
    target: 'DELETED',
  });
  assert.ok(unknown.warnings.includes(DELIVERED_28D_UNKNOWN_NOTE));
  assert.ok(unknown.warnings.includes(DELETE_PERMANENT_NOTE));
});

test('the children text and count per level', () => {
  const campaign = plan('PAUSED', 'DELETED');
  assert.equal(campaign.childrenAffected, 5);
  assert.ok(
    campaign.warnings.includes('1 ad sets and 4 ads under it will also be deleted.'),
  );

  const partial = plan('PAUSED', 'ARCHIVED', { children: { adsets: 2 } });
  assert.equal(partial.childrenAffected, 'unknown');
  assert.ok(
    partial.warnings.includes(
      '2 ad sets and an unknown number of ads under it will also be archived.',
    ),
  );

  const adset = plan('PAUSED', 'ARCHIVED', { level: 'adset', children: { ads: 3 } });
  assert.equal(adset.childrenAffected, 3);
  assert.ok(adset.warnings.includes('3 ads under it will also be archived.'));

  const ad = plan('PAUSED', 'ARCHIVED', { level: 'ad', children: {} });
  assert.equal(ad.childrenAffected, 0);
  assert.ok(!ad.warnings.some((w) => w.includes('under it')));

  const noLevel = planLifecycleChange({
    objectId: ID,
    current: normalizeAdNode({ id: ID, status: 'PAUSED' }),
    target: 'ARCHIVED',
  });
  assert.equal(noLevel.childrenAffected, 'unknown');
  assert.ok(noLevel.warnings.some((w) => w.includes('pass level to count them')));
});

test('request shapes: archive POST, campaign DELETE, other levels POST status=DELETED', () => {
  const archive = archiveAdObjectRequest(ID);
  assert.equal(archive.method, 'POST');
  assert.deepEqual(archive.body, { status: 'ARCHIVED' });
  assert.equal(archive.verifyTool, 'facebook_get_ad_object');

  const campaign = deleteAdObjectRequest(ID, 'campaign');
  assert.equal(campaign.method, 'DELETE');
  assert.equal(campaign.path, `/${ID}`);
  assert.equal(campaign.body, undefined);

  for (const level of ['adset', 'ad', undefined] as const) {
    const req = deleteAdObjectRequest(ID, level);
    assert.equal(req.method, 'POST', String(level));
    assert.deepEqual(req.body, { status: 'DELETED' }, String(level));
  }
});
