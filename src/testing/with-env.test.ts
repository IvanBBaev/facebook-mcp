import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withEnv } from './with-env.js';

test('withEnv applies overrides in scope and restores originals after', async () => {
  process.env.FB_TEST_EXISTING = 'original';
  delete process.env.FB_TEST_ABSENT;

  const result = await withEnv(
    { FB_TEST_EXISTING: 'override', FB_TEST_ABSENT: 'added' },
    () => {
      assert.equal(process.env.FB_TEST_EXISTING, 'override');
      assert.equal(process.env.FB_TEST_ABSENT, 'added');
      return 'ret';
    },
  );

  assert.equal(result, 'ret');
  assert.equal(process.env.FB_TEST_EXISTING, 'original');
  assert.equal(process.env.FB_TEST_ABSENT, undefined);
  delete process.env.FB_TEST_EXISTING;
});

test('withEnv deletes a key when the override is undefined, then restores it', async () => {
  process.env.FB_TEST_DELETE = 'present';

  await withEnv({ FB_TEST_DELETE: undefined }, () => {
    assert.ok(!('FB_TEST_DELETE' in process.env));
  });

  assert.equal(process.env.FB_TEST_DELETE, 'present');
  delete process.env.FB_TEST_DELETE;
});

test('withEnv restores env even when the callback throws', async () => {
  process.env.FB_TEST_THROW = 'keep';

  await assert.rejects(
    withEnv({ FB_TEST_THROW: 'temp', FB_TEST_NEW: 'x' }, () => {
      throw new Error('boom');
    }),
    /boom/,
  );

  assert.equal(process.env.FB_TEST_THROW, 'keep');
  assert.equal(process.env.FB_TEST_NEW, undefined);
  delete process.env.FB_TEST_THROW;
});

test('withEnv supports async callbacks and returns their resolved value', async () => {
  const value = await withEnv({ FB_TEST_ASYNC: 'v' }, async () => {
    await Promise.resolve();
    return process.env.FB_TEST_ASYNC;
  });

  assert.equal(value, 'v');
  assert.equal(process.env.FB_TEST_ASYNC, undefined);
});
