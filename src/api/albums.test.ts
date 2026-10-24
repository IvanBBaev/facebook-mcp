// Tests for the Page album / photo READ helpers (organic F3, `api` layer).
//
// Covered: the album and photo field sets, row mapping (reference objects
// flattened to ids, numeric strings read as numbers), the Page photo path
// defaulting to `type=uploaded` (Graph's own default is `profile`), the album
// path, the album_id / type exclusivity, and the not-found re-throw that points
// at facebook_list_albums. Placeholder tokens only.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeFbRequest, fbErr, fbOk } from '../core/fakes/index.js';
import type { FakeFbRequest } from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import type { JsonRequest } from '../core/index.js';
import { loadFixture } from '../testing/fixtures.js';

import { DEFAULT_PAGE_LIMIT } from './shared.js';
import {
  ALBUM_FIELDS,
  DEFAULT_PHOTO_LIST_TYPE,
  PHOTO_LIST_FIELDS,
  UNKNOWN_ALBUM_TEXT,
  listAlbums,
  listPhotos,
  mapAlbum,
  mapPhoto,
} from './albums.js';

const PAGE_ID = '100000000000001';
const ALBUM_ID = '400000000000001';
const PAGE_TOKEN = 'EAA-PAGE-PLACEHOLDER';

function jsonAt(fb: FakeFbRequest, index: number): JsonRequest {
  const call = fb.calls[index];
  if (call === undefined || call.protocol !== 'json')
    throw new Error('expected a json request');
  return call;
}

test('the album and photo field sets match the spec', () => {
  assert.equal(
    ALBUM_FIELDS,
    'id,name,description,type,count,can_upload,cover_photo,link,created_time,updated_time',
  );
  assert.equal(PHOTO_LIST_FIELDS, 'id,created_time,name,link,width,height,album');
  assert.equal(DEFAULT_PHOTO_LIST_TYPE, 'uploaded');
});

test('mapAlbum flattens cover_photo and drops absent fields', () => {
  assert.deepEqual(
    mapAlbum({
      id: ALBUM_ID,
      name: 'A',
      type: 'normal',
      count: '7',
      can_upload: true,
      cover_photo: { id: '9' },
      created_time: 't0',
    }),
    {
      id: ALBUM_ID,
      name: 'A',
      type: 'normal',
      count: 7,
      canUpload: true,
      coverPhotoId: '9',
      createdTime: 't0',
    },
  );
  assert.equal(mapAlbum({ name: 'no id' }), undefined);
});

test('mapPhoto flattens album to albumId', () => {
  assert.deepEqual(
    mapPhoto({ id: '5', width: 10, height: '20', album: { id: ALBUM_ID } }),
    {
      id: '5',
      width: 10,
      height: 20,
      albumId: ALBUM_ID,
    },
  );
  assert.equal(mapPhoto(null), undefined);
});

test('listAlbums reads /{page-id}/albums with the field set and maps the fixture', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk(await loadFixture('graph-albums.json')));

  const res = await listAlbums(fb.fn, { pageId: PAGE_ID, token: PAGE_TOKEN, limit: 10 });

  const req = jsonAt(fb, 0);
  assert.equal(req.path, `/${PAGE_ID}/albums`);
  assert.equal(req.token, PAGE_TOKEN);
  assert.deepEqual({ ...req.params }, { fields: ALBUM_FIELDS, limit: 10 });
  assert.equal(res.count, 2);
  assert.deepEqual(res.albums[0], {
    id: ALBUM_ID,
    name: 'Example album',
    description: 'Synthetic album for the unit suite.',
    type: 'normal',
    count: 12,
    canUpload: false,
    coverPhotoId: '500000000000001',
    link: 'https://www.facebook.com/album.php?fbid=400000000000001',
    createdTime: '2026-01-10T08:00:00+0000',
    updatedTime: '2026-01-15T10:00:00+0000',
  });
  assert.equal(res.nextCursor, undefined);
  assert.deepEqual(res.notes, []);
});

test('listPhotos on the Page path defaults to type=uploaded', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk({ data: [] }));

  const res = await listPhotos(fb.fn, { pageId: PAGE_ID });

  const req = jsonAt(fb, 0);
  assert.equal(req.path, `/${PAGE_ID}/photos`);
  assert.deepEqual(
    { ...req.params },
    { type: 'uploaded', fields: PHOTO_LIST_FIELDS, limit: DEFAULT_PAGE_LIMIT },
  );
  assert.equal(res.type, 'uploaded');
  assert.equal('albumId' in res, false);
});

test('listPhotos forwards an explicit type', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk({ data: [] }));

  const res = await listPhotos(fb.fn, { pageId: PAGE_ID, type: 'tagged' });

  assert.equal(jsonAt(fb, 0).params?.type, 'tagged');
  assert.equal(res.type, 'tagged');
});

test('listPhotos on the album path reads /{album-id}/photos and maps the fixture', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk(await loadFixture('graph-photos.json')));

  const res = await listPhotos(fb.fn, { pageId: PAGE_ID, albumId: ALBUM_ID });

  const req = jsonAt(fb, 0);
  assert.equal(req.path, `/${ALBUM_ID}/photos`);
  assert.equal(req.params?.type, undefined);
  assert.equal(res.albumId, ALBUM_ID);
  assert.equal('type' in res, false);
  assert.equal(res.count, 2);
  assert.deepEqual(res.photos[1], {
    id: '500000000000002',
    createdTime: '2026-01-11T09:00:00+0000',
    link: 'https://www.facebook.com/photo.php?fbid=500000000000002',
    width: 1080,
    height: 1080,
    albumId: ALBUM_ID,
  });
});

test('listPhotos refuses album_id together with type before any request', async () => {
  const fb = createFakeFbRequest();

  await assert.rejects(
    listPhotos(fb.fn, { pageId: PAGE_ID, albumId: ALBUM_ID, type: 'uploaded' }),
    /mutually exclusive/,
  );
  assert.equal(fb.calls.length, 0);
});

test('an unknown album id is re-thrown pointing at facebook_list_albums', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    () => true,
    fbErr(
      new GraphApiError('Unsupported get request', {
        code: 100,
        subcode: 33,
        httpStatus: 400,
        action: { category: 'not_found', retryable: false, operatorText: 'gone' },
      }),
    ),
  );

  await assert.rejects(listPhotos(fb.fn, { pageId: PAGE_ID, albumId: '999' }), (err) => {
    assert.ok(err instanceof GraphApiError);
    assert.equal(err.code, 100);
    assert.equal(err.subcode, 33);
    assert.equal(err.action?.category, 'not_found');
    assert.equal(err.action?.nextTool, 'facebook_list_albums');
    assert.equal(err.action?.operatorText, UNKNOWN_ALBUM_TEXT);
    return true;
  });
});

test('a non-not-found album error propagates unchanged', async () => {
  const original = new GraphApiError('perm', {
    code: 10,
    httpStatus: 403,
    action: { category: 'permission', retryable: false, operatorText: 'perm' },
  });
  const fb = createFakeFbRequest();
  fb.on(() => true, fbErr(original));

  await assert.rejects(
    listPhotos(fb.fn, { pageId: PAGE_ID, albumId: ALBUM_ID }),
    (err) => {
      assert.equal(err, original);
      return true;
    },
  );
});
