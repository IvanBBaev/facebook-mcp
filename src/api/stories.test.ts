// Tests for the Page Stories READ helpers (organic F2, `api` layer).
//
// Covered: the edge path and since/until hand-off, row mapping (epoch → ISO,
// case normalisation, rows without a post_id dropped), the client-side status
// filter with its `filteredOut` count and note, and the empty-listing archive
// hint. Placeholder tokens only — never a real secret in a fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeFbRequest, fbOk } from '../core/fakes/index.js';
import type { FakeFbRequest } from '../core/fakes/index.js';
import type { JsonRequest } from '../core/index.js';
import { loadFixture } from '../testing/fixtures.js';

import { DEFAULT_PAGE_LIMIT } from './shared.js';
import {
  EMPTY_STORIES_NOTE,
  listStories,
  mapStory,
  storiesFilteredNote,
  storyTimeToIso,
} from './stories.js';

const PAGE_ID = '100000000000001';
const PAGE_TOKEN = 'EAA-PAGE-PLACEHOLDER';

function jsonAt(fb: FakeFbRequest, index: number): JsonRequest {
  const call = fb.calls[index];
  if (call === undefined || call.protocol !== 'json')
    throw new Error('expected a json request');
  return call;
}

test('storyTimeToIso converts epoch seconds and passes ISO through', () => {
  assert.equal(storyTimeToIso(1768471200), '2026-01-15T10:00:00.000Z');
  assert.equal(storyTimeToIso('1768471200'), '2026-01-15T10:00:00.000Z');
  assert.equal(storyTimeToIso('2026-01-15T10:00:00+0000'), '2026-01-15T10:00:00.000Z');
  assert.equal(storyTimeToIso('not a time'), undefined);
  assert.equal(storyTimeToIso(undefined), undefined);
});

test('mapStory maps the six documented fields and drops a row without post_id', () => {
  assert.deepEqual(
    mapStory({
      post_id: `${PAGE_ID}_1`,
      status: 'published',
      creation_time: 1768471200,
      media_type: 'PHOTO',
      media_id: 11,
      url: 'https://example.invalid/s/1',
    }),
    {
      postId: `${PAGE_ID}_1`,
      status: 'PUBLISHED',
      createdTime: '2026-01-15T10:00:00.000Z',
      mediaType: 'photo',
      mediaId: '11',
      url: 'https://example.invalid/s/1',
    },
  );
  assert.deepEqual(mapStory({ post_id: `${PAGE_ID}_2` }), { postId: `${PAGE_ID}_2` });
  assert.equal(mapStory({ status: 'PUBLISHED' }), undefined);
  assert.equal(mapStory('x'), undefined);
});

test('listStories reads /{page-id}/stories with since/until and maps the fixture', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk(await loadFixture('graph-stories.json')));

  const res = await listStories(fb.fn, {
    pageId: PAGE_ID,
    token: PAGE_TOKEN,
    since: 1768000000,
    until: 1769000000,
  });

  const req = jsonAt(fb, 0);
  assert.equal(req.method, 'GET');
  assert.equal(req.path, `/${PAGE_ID}/stories`);
  assert.equal(req.token, PAGE_TOKEN);
  assert.deepEqual(
    { ...req.params },
    { since: 1768000000, until: 1769000000, limit: DEFAULT_PAGE_LIMIT },
  );
  assert.equal(res.count, 2);
  assert.equal(res.stories[0]?.createdTime, '2026-01-15T10:00:00.000Z');
  assert.equal(res.stories[1]?.status, 'ARCHIVED');
  assert.equal(res.nextCursor, 'U1RPUllfYWZ0ZXI');
  assert.equal(res.truncated, false);
  assert.equal('filteredOut' in res, false);
  assert.deepEqual(res.notes, []);
});

test('listStories filters by status client-side and reports what it dropped', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk(await loadFixture('graph-stories.json')));

  const res = await listStories(fb.fn, { pageId: PAGE_ID, status: 'ARCHIVED' });

  assert.equal(jsonAt(fb, 0).params?.status, undefined);
  assert.equal(res.count, 1);
  assert.equal(res.stories[0]?.status, 'ARCHIVED');
  assert.equal(res.filteredOut, 1);
  assert.deepEqual(res.notes, [storiesFilteredNote(1, 'ARCHIVED')]);
});

test('listStories with a filter that drops nothing reports filteredOut 0 and no note', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk({ data: [{ post_id: `${PAGE_ID}_1`, status: 'PUBLISHED' }] }));

  const res = await listStories(fb.fn, { pageId: PAGE_ID, status: 'PUBLISHED' });

  assert.equal(res.filteredOut, 0);
  assert.deepEqual(res.notes, []);
});

test('an empty stories listing carries the archive hint', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk({ data: [] }));

  const res = await listStories(fb.fn, { pageId: PAGE_ID });

  assert.equal(res.count, 0);
  assert.deepEqual(res.notes, [EMPTY_STORIES_NOTE]);
  assert.match(EMPTY_STORIES_NOTE, /story archive is enabled/);
});
