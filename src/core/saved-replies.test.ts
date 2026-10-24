import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeClock } from './fakes/index.js';
import {
  MAX_SAVED_REPLIES,
  SavedRepliesError,
  createSavedReplyStore,
  fillSavedReply,
  loadSavedReplies,
  slugifyTitle,
  unknownPlaceholders,
} from './saved-replies.js';

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'fb-saved-replies-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const reply = (id: string) => ({
  id,
  title: `Title ${id}`,
  text: `Text ${id}`,
  tags: [],
});

test('an absent file is an empty set', async () => {
  await withDir(async (dir) => {
    const data = await loadSavedReplies(join(dir, 'saved-replies.json'));
    assert.deepEqual(data, { version: 1, profiles: {} });
  });
});

test('a corrupt file is a config_error and is never overwritten', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'saved-replies.json');
    for (const body of [
      '{not json',
      '[]',
      '{"version":2,"profiles":{}}',
      '{"version":1}',
    ]) {
      await writeFile(file, body);
      const store = createSavedReplyStore({
        filePath: file,
        clock: createFakeClock(NOW),
      });
      await assert.rejects(
        store.save('p1', reply('a'), { overwrite: false }),
        (err: unknown) => err instanceof SavedRepliesError && err.code === 'config_error',
      );
      assert.equal(await readFile(file, 'utf8'), body);
    }
  });
});

test('a reply with a bad field makes the whole file unusable', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'saved-replies.json');
    const bad = {
      id: 'Bad Id',
      title: 't',
      text: 'x',
      tags: [],
      updatedAt: new Date(NOW),
    };
    await writeFile(file, JSON.stringify({ version: 1, profiles: { p1: [bad] } }));
    await assert.rejects(loadSavedReplies(file), /invalid id/);
  });
});

test('concurrent saves are serialized and none is lost; the file is 0600', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'saved-replies.json');
    const store = createSavedReplyStore({ filePath: file, clock: createFakeClock(NOW) });
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    await Promise.all(ids.map((id) => store.save('p1', reply(id), { overwrite: false })));
    assert.deepEqual(
      (await store.list('p1')).map((r) => r.id),
      ids,
    );
    if (process.platform !== 'win32') {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
  });
});

test('records are kept per Page and the last delete drops the Page key', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'saved-replies.json');
    const store = createSavedReplyStore({ filePath: file, clock: createFakeClock(NOW) });
    await store.save('p1', reply('a'), { overwrite: false });
    await store.save('p2', reply('a'), { overwrite: false });
    const removed = await store.remove('p1', 'a');
    assert.equal(removed.id, 'a');
    assert.equal(removed.updatedAt, new Date(NOW).toISOString());
    const data = await loadSavedReplies(file);
    assert.deepEqual(Object.keys(data.profiles), ['p2']);
  });
});

test('a Page is capped at MAX_SAVED_REPLIES', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'saved-replies.json');
    const full = Array.from({ length: MAX_SAVED_REPLIES }, (_, i) => ({
      ...reply(`r${String(i)}`),
      updatedAt: new Date(NOW).toISOString(),
    }));
    await writeFile(file, JSON.stringify({ version: 1, profiles: { p1: full } }));
    const store = createSavedReplyStore({ filePath: file, clock: createFakeClock(NOW) });
    await assert.rejects(
      store.save('p1', reply('one-more'), { overwrite: false }),
      (err: unknown) => err instanceof SavedRepliesError && err.code === 'limit',
    );
    // An overwrite of an existing id is still allowed at the cap.
    const write = await store.save('p1', reply('r0'), { overwrite: true });
    assert.equal(write.created, false);
  });
});

test('placeholders: only {{page_name}} is filled, others are reported', () => {
  assert.deepEqual(
    unknownPlaceholders('Hi {{ name }} from {{page_name}} {{name}} {{x}}'),
    ['name', 'x'],
  );
  assert.equal(
    fillSavedReply('Thanks from {{page_name}}! {{ page_name }}', { pageName: 'Acme' }),
    'Thanks from Acme! Acme',
  );
  assert.equal(fillSavedReply('Keep {{other}}', { pageName: 'Acme' }), 'Keep {{other}}');
});

test('slugifyTitle makes a lowercase ASCII slug of at most 48 characters', () => {
  assert.equal(slugifyTitle('  Opening Hours & Prices! '), 'opening-hours-prices');
  assert.equal(slugifyTitle('Café déjà vu'), 'cafe-deja-vu');
  assert.equal(slugifyTitle('Здравей'), '');
  const long = slugifyTitle('word '.repeat(30));
  assert.ok(long.length <= 48 && !long.endsWith('-'));
});
