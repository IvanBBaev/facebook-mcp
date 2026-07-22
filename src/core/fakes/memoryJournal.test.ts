import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryJournal } from './memoryJournal.js';
import { createFakeClock } from './fakeClock.js';
import type { JournalEntryInput } from '../types.js';

const ENTRY: JournalEntryInput = {
  tool: 'facebook_delete_post',
  tier: 'irreversible',
  pageId: '123',
  outcome: 'applied',
  summary: 'Deleted post 123_456',
};

test('append stores entries and stamps the timestamp from the injected clock', async () => {
  const clock = createFakeClock(5000);
  const journal = createMemoryJournal(clock);

  const status = await journal.append(ENTRY);
  assert.equal(status, 'ok');
  assert.equal(journal.entries.length, 1);
  assert.equal(journal.entries[0]?.timestamp, 5000);
  assert.equal(journal.entries[0]?.tool, 'facebook_delete_post');
});

test('failNext returns failed once and does not store (CC-LIFE-1)', async () => {
  const journal = createMemoryJournal(createFakeClock());
  journal.failNext();
  assert.equal(await journal.append(ENTRY), 'failed');
  assert.equal(journal.entries.length, 0);

  // The failure is one-shot: the next append succeeds.
  assert.equal(await journal.append(ENTRY), 'ok');
  assert.equal(journal.entries.length, 1);
});

test('clear empties the store', async () => {
  const journal = createMemoryJournal();
  await journal.append(ENTRY);
  assert.equal(journal.entries.length, 1);
  journal.clear();
  assert.equal(journal.entries.length, 0);
});
