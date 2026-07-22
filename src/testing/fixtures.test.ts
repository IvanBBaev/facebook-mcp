import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadFixture,
  lintFixtureDir,
  assertFixturesClean,
  findSecrets,
  assertNoSecrets,
  FixtureSecretError,
  type SecretRule,
} from './fixtures.js';

test('loadFixture reads and parses a committed fixture', async () => {
  const me = await loadFixture<{ id: string; name: string }>('graph-me.json');
  assert.equal(me.id, '100000000000001');
  assert.equal(me.name, 'Example Test Page');
});

test('lintFixtureDir finds no secrets in the committed fixtures', async () => {
  const findings = await lintFixtureDir();
  assert.deepEqual(findings, []);
});

test('assertFixturesClean resolves for the committed fixtures', async () => {
  await assertFixturesClean();
});

test('findSecrets flags an EAA-prefixed access token', () => {
  const dirty = { token: 'EAABwzLixnjYBO1234567890abcdef' };
  const findings = findSecrets(dirty);
  const rules = findings.map((f) => f.rule);
  assert.ok(rules.includes('eaa-access-token'));
  // The sample must never leak the raw value.
  assert.ok(!findings.some((f) => f.sample.includes('1234567890abcdef')));
});

test('findSecrets flags a 64-hex appsecret_proof-shaped value (not also 32-hex)', () => {
  const proof = 'a'.repeat(64);
  const findings = findSecrets({ appsecret_proof: proof });
  const rules = findings.map((f) => f.rule);
  assert.ok(rules.includes('appsecret-proof-64hex'));
  assert.ok(!rules.includes('app-secret-32hex'));
});

test('findSecrets flags a 32-hex app-secret-shaped value', () => {
  const findings = findSecrets({ secret: 'b'.repeat(32) });
  assert.ok(findings.map((f) => f.rule).includes('app-secret-32hex'));
});

test('findSecrets flags any non-empty access_token field regardless of value shape', () => {
  const findings = findSecrets({ access_token: 'plain-not-token-shaped' });
  const match = findings.find((f) => f.rule === 'access-token-field');
  assert.ok(match);
  assert.equal(match.path, '$.access_token');
});

test('findSecrets ignores an empty access_token field', () => {
  const findings = findSecrets({ access_token: '' });
  assert.equal(findings.length, 0);
});

test('findSecrets flags the {app-id}|{app-secret} app-access-token form', () => {
  const findings = findSecrets({ token: '1234567890|abcdefghijklmnop' });
  assert.ok(findings.map((f) => f.rule).includes('app-access-token-pipe'));
});

test('findSecrets records JSON paths, including nested and array positions', () => {
  const findings = findSecrets({
    data: [{ page: { access_token: 'EAABwzLixnjYBO1234567890abcdef' } }],
  });
  const paths = findings.map((f) => f.path);
  assert.ok(paths.includes('$.data[0].page.access_token'));
});

test('assertNoSecrets throws FixtureSecretError with findings on dirty data', () => {
  try {
    assertNoSecrets({ access_token: 'EAABwzLixnjYBO1234567890abcdef' }, 'dirty.json');
    assert.fail('expected assertNoSecrets to throw');
  } catch (err) {
    assert.ok(err instanceof FixtureSecretError);
    assert.ok(err.findings.length > 0);
    const rules: SecretRule[] = err.findings.map((f) => f.rule);
    assert.ok(rules.includes('eaa-access-token'));
    assert.ok(rules.includes('access-token-field'));
  }
});

test('assertNoSecrets does not throw on clean data', () => {
  assert.doesNotThrow(() => {
    assertNoSecrets({ id: '123', name: 'clean' });
  });
});
