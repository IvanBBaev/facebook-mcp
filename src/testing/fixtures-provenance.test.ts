// Provenance lint (R16, QA-03).
//
// Every committed fixture carries a `_meta` block saying whether it was
// recorded, hand-written (`synthetic`) or taken from Meta's docs, which API
// version and endpoint it stands for and, for recordings, when it was captured.
// These tests pin the lint rules and that the committed set obeys them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEFAULT_API_VERSION } from '../core/settings.js';
import {
  assertFixturesProvenance,
  expectedFixtureVersion,
  findProvenanceIssues,
  FixtureProvenanceError,
  FIXTURES_DIR,
  lintFixtureProvenance,
  loadFixture,
  loadFixtureMeta,
  splitFixture,
  type ProvenanceRule,
} from './fixtures.js';

const V = DEFAULT_API_VERSION;

function synthetic(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'synthetic',
    graph_version: V,
    endpoint: 'GET /{page-id}/feed',
    ...extra,
  };
}

function rulesOf(value: unknown, expectedVersion = V): ProvenanceRule[] {
  return findProvenanceIssues(value, { expectedVersion }).map((f) => f.rule);
}

test('every committed fixture has valid provenance on the pinned version', async () => {
  assert.deepEqual(await lintFixtureProvenance(), []);
  await assertFixturesProvenance();

  // An empty result only counts if something was scanned.
  const names = (await readdir(FIXTURES_DIR)).filter((n) => n.endsWith('.json'));
  assert.ok(names.length >= 2, `fixtures present: ${names.join(', ')}`);
});

test('loadFixture strips _meta; loadFixtureMeta returns it', async () => {
  const me = await loadFixture<Record<string, unknown>>('graph-me.json');
  assert.ok(!('_meta' in me), 'the provenance block leaked into the body');
  assert.equal(me['id'], '100000000000001');

  const meta = await loadFixtureMeta('graph-me.json');
  assert.equal(meta?.source, 'synthetic', 'graph-me.json is hand-written, not recorded');
  assert.equal(meta?.endpoint, 'GET /me');
});

test('splitFixture leaves a body without _meta (and non-objects) untouched', () => {
  assert.deepEqual(splitFixture({ id: '1' }), { body: { id: '1' }, meta: undefined });
  assert.deepEqual(splitFixture([1, 2]), { body: [1, 2], meta: undefined });
  assert.deepEqual(splitFixture({ _meta: { a: 1 }, id: '1' }), {
    body: { id: '1' },
    meta: { a: 1 },
  });
});

test('a clean synthetic fixture produces no finding', () => {
  assert.deepEqual(rulesOf({ _meta: synthetic(), data: [] }), []);
  assert.deepEqual(rulesOf({ _meta: synthetic({ fields: 'id,message' }), data: [] }), []);
});

test('a fixture without _meta is refused', () => {
  assert.deepEqual(rulesOf({ data: [] }), ['meta-missing']);
  assert.deepEqual(rulesOf({ _meta: 'synthetic', data: [] }), ['meta-missing']);
});

test('the source must be recorded, synthetic or docs', () => {
  assert.deepEqual(rulesOf({ _meta: synthetic({ source: 'docs' }) }), []);
  assert.deepEqual(rulesOf({ _meta: synthetic({ source: 'guessed' }) }), ['meta-source']);
  assert.deepEqual(rulesOf({ _meta: synthetic({ source: undefined }) }), ['meta-source']);
});

test('a recorded fixture needs recorded_at; any other source must not have one', () => {
  const recorded = synthetic({ source: 'recorded' });
  assert.deepEqual(rulesOf({ _meta: recorded }), ['meta-recorded-at']);
  assert.deepEqual(rulesOf({ _meta: { ...recorded, recorded_at: 'yesterday' } }), [
    'meta-recorded-at',
  ]);
  assert.deepEqual(
    rulesOf({ _meta: { ...recorded, recorded_at: '2026-10-31T09:15:00.000Z' } }),
    [],
  );
  assert.deepEqual(
    rulesOf({ _meta: synthetic({ recorded_at: '2026-10-31T09:15:00Z' }) }),
    ['meta-recorded-at'],
  );
});

test('graph_version must be a version tag equal to the expected version', () => {
  assert.deepEqual(rulesOf({ _meta: synthetic({ graph_version: '26' }) }), [
    'meta-graph-version',
  ]);
  assert.deepEqual(rulesOf({ _meta: synthetic({ graph_version: 'v21.0' }) }), [
    'meta-graph-version',
  ]);
  assert.deepEqual(
    rulesOf({ _meta: synthetic({ graph_version: 'v27.0' }) }, 'v27.0'),
    [],
  );
});

test('the endpoint is METHOD /path with ids as placeholders, never a real id', () => {
  for (const endpoint of [
    'GET /me',
    'POST /{post-id}/comments',
    'GET /act_{id}/campaigns',
  ]) {
    assert.deepEqual(rulesOf({ _meta: synthetic({ endpoint }) }), [], endpoint);
  }
  for (const endpoint of [
    '/me',
    'me',
    'GET me',
    'PATCH /me',
    'GET /100000000000001/feed',
  ]) {
    assert.deepEqual(
      rulesOf({ _meta: synthetic({ endpoint }) }),
      ['meta-endpoint'],
      endpoint,
    );
  }
});

test('fields, when present, is a non-empty string', () => {
  assert.deepEqual(rulesOf({ _meta: synthetic({ fields: '' }) }), ['meta-fields']);
  assert.deepEqual(rulesOf({ _meta: synthetic({ fields: ['id'] }) }), ['meta-fields']);
});

test('an unknown _meta key is refused, so the schema stays the documented one', () => {
  assert.deepEqual(rulesOf({ _meta: synthetic({ recorded: true }) }), [
    'meta-unknown-key',
  ]);
});

test('a Graph URL on another version than the fixture stands for is refused', () => {
  const stale = {
    _meta: synthetic(),
    paging: { next: 'https://graph.facebook.com/v21.0/1/feed?after=x' },
    upload_url: 'https://rupload.facebook.com/video-upload/v25.0/3',
    video: 'https://graph-video.facebook.com/v24.0/3/videos',
  };
  const findings = findProvenanceIssues(stale, { expectedVersion: V });
  assert.deepEqual(
    findings.map((f) => [f.rule, f.path]),
    [
      ['graph-version-url', '$.paging.next'],
      ['graph-version-url', '$.upload_url'],
      ['graph-version-url', '$.video'],
    ],
  );
  assert.match(findings[0]?.detail ?? '', /v21\.0/);

  const current = {
    _meta: synthetic(),
    paging: { next: `https://graph.facebook.com/${V}/1/feed?after=x` },
    upload_url: `https://rupload.facebook.com/video-upload/${V}/3`,
    link: 'https://www.facebook.com/photo.php?fbid=5',
  };
  assert.deepEqual(rulesOf(current), []);
});

test('fixtures under ads/<version>/ stand for their directory version', () => {
  assert.equal(expectedFixtureVersion('graph-me.json'), V);
  assert.equal(expectedFixtureVersion('ads/v27.0/ads-account.json'), 'v27.0');
  assert.equal(expectedFixtureVersion('ads/notes/x.json'), V);
});

test('lintFixtureProvenance walks subdirectories and names the file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-fixture-provenance-'));
  try {
    await mkdir(path.join(dir, 'ads', 'v27.0'), { recursive: true });
    const adsMeta = {
      source: 'recorded',
      graph_version: 'v27.0',
      endpoint: 'GET /act_{id}',
      recorded_at: '2026-10-31T09:15:00.000Z',
    };
    await writeFile(
      path.join(dir, 'ads', 'v27.0', 'ads-account.json'),
      JSON.stringify({ _meta: adsMeta, id: 'act_9000000001' }),
    );
    await writeFile(path.join(dir, 'bare.json'), JSON.stringify({ id: '1' }));

    const url = pathToFileURL(`${dir}${path.sep}`);
    const findings = await lintFixtureProvenance(url);
    assert.deepEqual(
      findings.map((f) => [f.file, f.rule]),
      [['bare.json', 'meta-missing']],
      'the ads fixture is held to v27.0, its directory, and passes',
    );

    await assert.rejects(assertFixturesProvenance(url), (err: unknown) => {
      assert.ok(err instanceof FixtureProvenanceError);
      assert.match(err.message, /bare\.json \$\._meta: meta-missing/);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
