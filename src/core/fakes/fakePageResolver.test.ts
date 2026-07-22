import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePageResolver } from './fakePageResolver.js';
import type { ResolvedPage } from '../types.js';

const DEFAULT_PAGE: ResolvedPage = {
  pageId: '100',
  name: 'Main Page',
  token: 'tok-main',
};
const BRAND_A: ResolvedPage = { pageId: '200', name: 'Brand A', token: 'tok-a' };

test('resolves the default page when no profile is given', async () => {
  const r = createFakePageResolver({ default: DEFAULT_PAGE });
  const page = await r.resolvePage();
  assert.deepEqual(page, DEFAULT_PAGE);
  assert.deepEqual([...r.resolveCalls], [undefined]);
});

test('resolves by profile key and by raw Page ID', async () => {
  const r = createFakePageResolver({
    default: DEFAULT_PAGE,
    pages: { 'brand-a': BRAND_A },
  });
  assert.deepEqual(await r.resolvePage('brand-a'), BRAND_A);
  assert.deepEqual(await r.resolvePage('200'), BRAND_A);
  assert.deepEqual(await r.resolvePage('100'), DEFAULT_PAGE);
});

test('rejects an unknown profile', async () => {
  const r = createFakePageResolver({ default: DEFAULT_PAGE });
  await assert.rejects(r.resolvePage('nope'), /no page configured for profile "nope"/);
});

test('failWith makes resolve reject until cleared', async () => {
  const r = createFakePageResolver({ default: DEFAULT_PAGE });
  r.failWith(new Error('token dead'));
  await assert.rejects(r.resolvePage(), /token dead/);
  r.failWith(undefined);
  assert.deepEqual(await r.resolvePage(), DEFAULT_PAGE);
});

test('setPage adds/replaces pages and invalidate is recorded', async () => {
  const r = createFakePageResolver();
  r.setPage(undefined, DEFAULT_PAGE);
  r.setPage('brand-a', BRAND_A);
  assert.deepEqual(await r.resolvePage(), DEFAULT_PAGE);
  assert.deepEqual(await r.resolvePage('brand-a'), BRAND_A);

  r.invalidate('200');
  r.invalidate('100');
  assert.deepEqual([...r.invalidated], ['200', '100']);
});
