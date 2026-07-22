import { test } from 'node:test';
import assert from 'node:assert/strict';
// Importing the fence installs a throwing global `fetch` as a side effect. Each
// node:test file runs in its own child process, so this side effect is contained
// to this file.
import { installNetworkFence, NetworkFenceError, fenceFetch } from './network-fence.js';
import { withFetch } from './with-fetch.js';

test('the fence is installed on import and fetch throws NetworkFenceError', () => {
  assert.equal(globalThis.fetch, fenceFetch);
  assert.throws(() => {
    void fetch('https://graph.facebook.com/me');
  }, NetworkFenceError);
});

test('the fence throws synchronously (not a rejected promise)', () => {
  assert.throws(() => {
    // If it returned a rejected promise instead, this call itself would not throw.
    void fetch('https://graph.facebook.com/me');
  }, /network access is disabled in tests/);
});

test('installNetworkFence is idempotent', () => {
  installNetworkFence();
  installNetworkFence();
  assert.equal(globalThis.fetch, fenceFetch);
});

test('withFetch swaps the mock in for its scope and restores the fence after', async () => {
  assert.equal(globalThis.fetch, fenceFetch);

  await withFetch(async (mock) => {
    mock.enqueue({ json: { ok: true } });
    // Inside the scope the fence is replaced by the recording mock.
    assert.notEqual(globalThis.fetch, fenceFetch);
    const res = await fetch('https://graph.facebook.com/me');
    assert.deepEqual(await res.json(), { ok: true });
  });

  // After the scope the previous global (the fence) is restored.
  assert.equal(globalThis.fetch, fenceFetch);
  assert.throws(() => {
    void fetch('https://graph.facebook.com/me');
  }, NetworkFenceError);
});

test('the fence is restored even when the withFetch callback throws', async () => {
  await assert.rejects(
    withFetch(async () => {
      await Promise.resolve();
      throw new Error('inside');
    }),
    /inside/,
  );
  assert.equal(globalThis.fetch, fenceFetch);
});
