import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeClock } from './fakeClock.js';

test('now() starts at the seed and moves only when driven', () => {
  const clock = createFakeClock(1000);
  assert.equal(clock.now(), 1000);
  clock.advance(500);
  assert.equal(clock.now(), 1500);
  clock.set(42);
  assert.equal(clock.now(), 42);
});

test('sleep resolves only once time reaches its due point', async () => {
  const clock = createFakeClock(0);
  let resolved = false;
  const p = clock.sleep(100).then(() => {
    resolved = true;
  });

  assert.equal(clock.pendingSleeps(), 1);
  clock.advance(50);
  await Promise.resolve();
  assert.equal(resolved, false, 'not yet due at t=50');

  clock.advance(50);
  await p;
  assert.equal(resolved, true, 'due at t=100');
  assert.equal(clock.pendingSleeps(), 0);
});

test('an already-aborted signal rejects sleep immediately', async () => {
  const clock = createFakeClock(0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    clock.sleep(100, controller.signal),
    (e: Error) => e.name === 'AbortError',
  );
});

test('aborting mid-sleep rejects and drops the pending sleep', async () => {
  const clock = createFakeClock(0);
  const controller = new AbortController();
  const p = clock.sleep(1000, controller.signal);
  assert.equal(clock.pendingSleeps(), 1);
  controller.abort();
  await assert.rejects(p, (e: Error) => e.name === 'AbortError');
  assert.equal(clock.pendingSleeps(), 0);
});
