// Tests for the file-backed activity state store (v2 insights F3): the
// round-trip, the per-Page merge, the 0600 / 0700 modes, corrupt-file recovery,
// serialized writes and the never-throw contract. Every test works in its own
// temp directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ACTIVITY_STATE_VERSION, createActivityStateStore } from './activity-state.js';

const isPosix = process.platform !== 'win32';
const A = '2026-10-24T12:00:00.000Z';
const B = '2026-10-24T13:00:00.000Z';

function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'fbmcp-activity-'));
}

function quietStore(statePath: string): {
  store: ReturnType<typeof createActivityStateStore>;
  errors: string[];
} {
  const errors: string[] = [];
  return {
    store: createActivityStateStore({ statePath, onError: (m) => errors.push(m) }),
    errors,
  };
}

test('activity state: a missing file reads as no marks', async () => {
  const dir = await tempDir();
  const { store, errors } = quietStore(path.join(dir, 'activity-state.json'));
  assert.equal(await store.get('111'), undefined);
  assert.deepEqual(errors, []);
});

test('activity state: set then get round-trips and merges per Page', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'activity-state.json');
  const { store } = quietStore(file);
  assert.equal(await store.set('111', { commentsSeenAt: A, updatedAt: A }), 'ok');
  assert.equal(await store.set('111', { conversationsSeenAt: B, updatedAt: B }), 'ok');
  assert.equal(await store.set('222', { commentsSeenAt: B }), 'ok');
  assert.deepEqual(await store.get('111'), {
    commentsSeenAt: A,
    conversationsSeenAt: B,
    updatedAt: B,
  });
  assert.deepEqual(await store.get('222'), { commentsSeenAt: B });

  const onDisk = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  assert.equal(onDisk.version, ACTIVITY_STATE_VERSION);
  assert.deepEqual(Object.keys(onDisk.pages as object).sort(), ['111', '222']);
  // No temp file is left behind.
  assert.deepEqual(await readdir(dir), ['activity-state.json']);
});

test(
  'activity state: the file is 0600 and a created directory 0700',
  { skip: !isPosix },
  async () => {
    const dir = await tempDir();
    const nested = path.join(dir, 'state', 'nested');
    const file = path.join(nested, 'activity-state.json');
    const { store } = quietStore(file);
    assert.equal(await store.set('111', { commentsSeenAt: A }), 'ok');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(nested)).mode & 0o777, 0o700);
  },
);

test('activity state: a corrupt file reads unreadable and the next set replaces it', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'activity-state.json');
  await writeFile(file, '{not json');
  const { store, errors } = quietStore(file);
  assert.equal(await store.get('111'), 'unreadable');
  assert.equal(errors.length, 1);
  assert.equal(await store.set('111', { commentsSeenAt: A }), 'ok');
  assert.deepEqual(await store.get('111'), { commentsSeenAt: A });
});

test('activity state: a foreign shape and junk marks are not trusted', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'activity-state.json');
  await writeFile(file, JSON.stringify({ version: 2, pages: {} }));
  const { store } = quietStore(file);
  assert.equal(await store.get('111'), 'unreadable');

  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      pages: {
        '111': { commentsSeenAt: 'yesterday', conversationsSeenAt: A, extra: 'x' },
        '../evil': { commentsSeenAt: A },
      },
    }),
  );
  assert.deepEqual(await store.get('111'), { conversationsSeenAt: A });
  assert.equal(await store.get('../evil'), undefined);
});

test('activity state: concurrent sets for different Pages are all kept', async () => {
  const dir = await tempDir();
  const { store } = quietStore(path.join(dir, 'activity-state.json'));
  const ids = ['1', '2', '3', '4', '5', '6'];
  const results = await Promise.all(
    ids.map((id) => store.set(id, { commentsSeenAt: A })),
  );
  assert.deepEqual(
    results,
    ids.map(() => 'ok'),
  );
  for (const id of ids) assert.deepEqual(await store.get(id), { commentsSeenAt: A });
});

test('activity state: failures answer failed / unreadable instead of throwing', async () => {
  const dir = await tempDir();
  // The state path is a directory: reading and renaming over it both fail.
  const file = path.join(dir, 'activity-state.json');
  await mkdir(file);
  const { store, errors } = quietStore(file);
  assert.equal(await store.get('111'), 'unreadable');
  assert.equal(await store.set('111', { commentsSeenAt: A }), 'failed');
  assert.equal(await store.set('not-a-page', { commentsSeenAt: A }), 'failed');
  assert.ok(errors.length >= 2);
  // Only the directory itself remains: the temp file was cleaned up.
  assert.deepEqual(await readdir(dir), ['activity-state.json']);
});

test('activity state: a throwing onError sink does not escape', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'activity-state.json');
  await writeFile(file, 'garbage');
  const store = createActivityStateStore({
    statePath: file,
    onError: () => {
      throw new Error('sink down');
    },
  });
  assert.equal(await store.get('111'), 'unreadable');
});
