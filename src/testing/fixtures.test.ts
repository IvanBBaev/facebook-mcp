import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadFixture,
  lintFixtureDir,
  assertFixturesClean,
  findSecrets,
  assertNoSecrets,
  FixtureSecretError,
  FIXTURES_DIR,
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

  // An empty result is only worth something if there was something to scan. A
  // default directory pointed at the wrong place, or a walk that skipped every
  // entry, produces this exact same `[]` — so pin that the fixtures are there.
  const names = (await readdir(FIXTURES_DIR)).filter((n) => n.endsWith('.json'));
  assert.ok(names.includes('graph-me.json'), `fixtures present: ${names.join(', ')}`);
  assert.ok(
    names.length >= 2,
    `expected several committed fixtures, saw ${String(names.length)}`,
  );
});

test('lintFixtureDir reads file CONTENT and reports which file leaked', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-fixture-lint-'));
  try {
    // The clean-fixtures test above cannot distinguish "scanned and clean" from
    // "never opened a file". Point the same walk at a directory that IS dirty:
    // only a lint that opens and parses each file can produce these findings.
    await writeFile(
      path.join(dir, 'dirty.json'),
      JSON.stringify({ page: { access_token: 'EAABwzLixnjYBO1234567890abcdef' } }),
    );
    await writeFile(path.join(dir, 'clean.json'), JSON.stringify({ id: '123' }));
    // Not JSON: skipped by extension, so a secret here is NOT a finding. Pinning
    // that keeps the extension filter honest about what it does and does not cover.
    await writeFile(path.join(dir, 'notes.txt'), 'access_token=EAABwzLixnjYBO1234');

    const url = pathToFileURL(`${dir}${path.sep}`);
    const findings = await lintFixtureDir(url);

    assert.deepEqual(
      [...new Set(findings.map((f) => f.file))],
      ['dirty.json'],
      'the finding names the offending file, and the clean one stays silent',
    );
    assert.ok(findings.some((f) => f.path === '$.page.access_token'));
    assert.ok(!findings.some((f) => f.sample.includes('1234567890abcdef')));

    await assert.rejects(assertFixturesClean(url), (err: unknown) => {
      assert.ok(err instanceof FixtureSecretError);
      assert.equal(err.findings.length, findings.length);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
