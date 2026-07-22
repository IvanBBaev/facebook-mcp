import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeFbRequest, fbOk, fbErr } from './fakeFbRequest.js';
import { GraphApiError } from '../types.js';
import type { JsonRequest } from '../types.js';

function getReq(path: string): JsonRequest {
  return { protocol: 'json', method: 'GET', host: 'graph', path };
}

test('matcher rules return canned responses and capture requests', async () => {
  const fake = createFakeFbRequest();
  fake.on(
    (r) => r.path === '/me',
    fbOk({ id: '1', name: 'Me' }, { 'X-App-Usage': '{"call_count":10}' }),
  );

  const res = await fake.fn<{ id: string; name: string }>(getReq('/me'));
  assert.equal(res.data.id, '1');
  assert.equal(res.status, 200);
  // Header keys are lowercased.
  assert.equal(res.headers['x-app-usage'], '{"call_count":10}');

  assert.equal(fake.calls.length, 1);
  assert.equal(fake.lastRequest()?.path, '/me');
});

test('enqueue drives a FIFO sequence consumed before rules', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk({ from: 'rule' }));
  fake.enqueue(fbOk({ step: 1 })).enqueue(fbErr(new Error('transient')));

  const first = await fake.fn<{ step: number }>(getReq('/a'));
  assert.equal(first.data.step, 1);

  await assert.rejects(fake.fn(getReq('/b')), /transient/);

  // Queue drained → falls through to the matcher rule.
  const third = await fake.fn<{ from: string }>(getReq('/c'));
  assert.equal(third.data.from, 'rule');
});

test('error stubs reject with the given error (incl. GraphApiError)', async () => {
  const fake = createFakeFbRequest();
  const gErr = new GraphApiError('Duplicate post', { code: 506, httpStatus: 400 });
  fake.on((r) => r.method === 'POST', fbErr(gErr));

  await assert.rejects(
    fake.fn({ protocol: 'json', method: 'POST', host: 'graph', path: '/feed' }),
    (e: unknown) => e instanceof GraphApiError && e.code === 506,
  );
});

test('the times limit retires a rule after N uses', async () => {
  const fake = createFakeFbRequest();
  fake.on((r) => r.path === '/once', fbOk({ ok: true }), 1);
  await fake.fn(getReq('/once'));
  await assert.rejects(fake.fn(getReq('/once')), /unexpected request/);
});

test('an unmatched request rejects loudly', async () => {
  const fake = createFakeFbRequest();
  await assert.rejects(
    fake.fn(getReq('/unknown')),
    /unexpected request GET json graph\/unknown/,
  );
});

test('reset clears calls, queue, and rules', async () => {
  const fake = createFakeFbRequest();
  fake.on(() => true, fbOk({ ok: true }));
  await fake.fn(getReq('/x'));
  assert.equal(fake.calls.length, 1);
  fake.reset();
  assert.equal(fake.calls.length, 0);
  await assert.rejects(fake.fn(getReq('/x')), /unexpected request/);
});
