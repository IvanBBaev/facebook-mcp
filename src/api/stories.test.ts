// Tests for the Page Stories READ helpers (organic F2, `api` layer).
//
// Covered: the edge path and since/until hand-off, row mapping (epoch → ISO,
// case normalisation, rows without a post_id dropped), the client-side status
// filter with its `filteredOut` count and note, and the empty-listing archive
// hint. Placeholder tokens only — never a real secret in a fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFakeClock,
  createFakeFbRequest,
  fbErr,
  fbOk,
} from '../core/fakes/index.js';
import type { FakeFbRequest } from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import type { FbRequest, JsonRequest, Logger } from '../core/index.js';
import { loadFixture } from '../testing/fixtures.js';

import { DEFAULT_PAGE_LIMIT } from './shared.js';
import type { ReelsDeps } from './media-reels.js';
import {
  EMPTY_STORIES_NOTE,
  STORY_MEDIA_REUSE_WARNING,
  STORY_REMOTE_PHOTO_WARNING,
  STORY_VERIFY_TOOL,
  STORY_VIDEO_SPEC_WARNING,
  STORY_VISIBILITY_WARNING,
  StoryPublishError,
  listStories,
  mapStory,
  publishPhotoStory,
  publishVideoStory,
  storiesFilteredNote,
  storyPlanWarnings,
  storyTimeToIso,
  validateStoryMedia,
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

// ---------------------------------------------------------------------------
// Publishing (organic F1)
// ---------------------------------------------------------------------------

const PHOTO_URL = 'https://cdn.example.invalid/story.jpg';
const PHOTO_ID = '555';

const SILENT: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function isJsonPost(req: FbRequest, path: string): boolean {
  return req.protocol === 'json' && req.method === 'POST' && req.path === path;
}

function graphRefusal(httpStatus: number): GraphApiError {
  return new GraphApiError('Invalid parameter', { code: 100, httpStatus });
}

test('validateStoryMedia refuses what Meta documents as unsupported', () => {
  const local = (path: string) => ({ kind: 'local' as const, path });
  const url = (u: string) => ({ kind: 'url' as const, url: u });
  assert.equal(
    validateStoryMedia({ mediaType: 'photo', source: local('/m/a.PNG') }),
    undefined,
  );
  assert.equal(
    validateStoryMedia({ mediaType: 'photo', source: url('https://x.invalid/img') }),
    undefined,
    'a CDN URL without an extension passes',
  );
  assert.equal(
    validateStoryMedia({
      mediaType: 'video',
      source: local('/m/v.mp4'),
      isAiGenerated: true,
    }),
    undefined,
  );
  assert.equal(
    validateStoryMedia({
      mediaType: 'photo',
      source: local('/m/a.jpg'),
      isAiGenerated: false,
    })?.field,
    'is_ai_generated',
  );
  assert.match(
    validateStoryMedia({ mediaType: 'video', source: url('https://x.invalid/v.mp4') })
      ?.message ?? '',
    /local \.mp4/,
  );
  assert.match(
    validateStoryMedia({ mediaType: 'video', source: local('/m/v.mov') })?.message ?? '',
    /\.mov/,
  );
  assert.match(
    validateStoryMedia({ mediaType: 'photo', source: local('/m/a.webp') })?.message ?? '',
    /\.webp/,
  );
  assert.equal(
    validateStoryMedia({ mediaType: 'photo', source: local('/m/noext') })?.field,
    'media',
  );
});

test('storyPlanWarnings states visibility, reuse, and the per-media caveats', () => {
  assert.deepEqual(storyPlanWarnings('photo', 'local'), [
    STORY_VISIBILITY_WARNING,
    STORY_MEDIA_REUSE_WARNING,
  ]);
  assert.deepEqual(storyPlanWarnings('photo', 'url'), [
    STORY_VISIBILITY_WARNING,
    STORY_REMOTE_PHOTO_WARNING,
    STORY_MEDIA_REUSE_WARNING,
  ]);
  assert.deepEqual(storyPlanWarnings('video', 'local'), [
    STORY_VISIBILITY_WARNING,
    STORY_VIDEO_SPEC_WARNING,
    STORY_MEDIA_REUSE_WARNING,
  ]);
});

test('publishPhotoStory uploads unpublished, then posts photo_stories with the photo id', async () => {
  const fb = createFakeFbRequest();
  const story = await loadFixture<Record<string, unknown>>('graph-photo-stories.json');
  fb.on((req) => isJsonPost(req, `/${PAGE_ID}/photos`), fbOk({ id: PHOTO_ID }));
  fb.on((req) => isJsonPost(req, `/${PAGE_ID}/photo_stories`), fbOk(story));

  const result = await publishPhotoStory(
    { fbRequest: fb.fn },
    { pageId: PAGE_ID, source: { kind: 'url', url: PHOTO_URL }, token: PAGE_TOKEN },
  );

  assert.deepEqual(result, {
    storyPostId: story['post_id'],
    mediaId: PHOTO_ID,
    mediaType: 'photo',
  });
  assert.equal(fb.calls.length, 2);
  const upload = jsonAt(fb, 0);
  const uploadBody = upload.body as Record<string, unknown>;
  assert.equal(uploadBody['published'], false);
  assert.equal(uploadBody['url'], PHOTO_URL);
  const post = jsonAt(fb, 1);
  assert.deepEqual(post.params, { photo_id: PHOTO_ID });
  assert.equal(post.token, PAGE_TOKEN);
  assert.equal(post.verifyTool, STORY_VERIFY_TOOL);
});

test('a clean photo_stories refusal deletes the unpublished photo and reports failed', async () => {
  const fb = createFakeFbRequest();
  fb.on((req) => isJsonPost(req, `/${PAGE_ID}/photos`), fbOk({ id: PHOTO_ID }));
  fb.on((req) => isJsonPost(req, `/${PAGE_ID}/photo_stories`), fbErr(graphRefusal(400)));
  fb.on(
    (req) => req.protocol === 'json' && req.method === 'DELETE',
    fbOk({ success: true }),
  );

  await assert.rejects(
    publishPhotoStory(
      { fbRequest: fb.fn, logger: SILENT },
      { pageId: PAGE_ID, source: { kind: 'url', url: PHOTO_URL } },
    ),
    (err: unknown) => {
      assert.ok(err instanceof StoryPublishError);
      assert.equal(err.outcome, 'failed');
      assert.equal(err.mediaId, PHOTO_ID);
      assert.deepEqual(err.cleanup?.deleted, [PHOTO_ID]);
      assert.ok(err.cause instanceof GraphApiError);
      return true;
    },
  );
  assert.equal(jsonAt(fb, 2).path, `/${PHOTO_ID}`);
});

test('a 5xx or unconfirmed story step is attempted: no cleanup, no retry', async () => {
  for (const outcome of [fbErr(graphRefusal(503)), fbOk({ success: false })]) {
    const fb = createFakeFbRequest();
    fb.on((req) => isJsonPost(req, `/${PAGE_ID}/photos`), fbOk({ id: PHOTO_ID }));
    fb.on((req) => isJsonPost(req, `/${PAGE_ID}/photo_stories`), outcome);

    await assert.rejects(
      publishPhotoStory(
        { fbRequest: fb.fn },
        { pageId: PAGE_ID, source: { kind: 'url', url: PHOTO_URL } },
      ),
      (err: unknown) =>
        err instanceof StoryPublishError &&
        err.outcome === 'attempted' &&
        err.cleanup === undefined,
    );
    assert.equal(
      fb.calls.length,
      2,
      'the story POST is sent once and nothing is deleted',
    );
  }
});

test('publishVideoStory starts on video_stories, transfers, then finishes', async () => {
  const fb = createFakeFbRequest();
  const start = await loadFixture<Record<string, unknown>>(
    'graph-video-stories-start.json',
  );
  const isPhase = (req: FbRequest, phase: string) =>
    isJsonPost(req, `/${PAGE_ID}/video_stories`) &&
    req.protocol === 'json' &&
    req.params?.['upload_phase'] === phase;
  fb.on((req) => isPhase(req, 'start'), fbOk(start));
  fb.on((req) => req.protocol === 'rupload', fbOk({ success: true }));
  fb.on(
    (req) => isPhase(req, 'finish'),
    fbOk({ success: true, post_id: `${PAGE_ID}_9` }),
  );

  const deps: ReelsDeps = {
    fbRequest: fb.fn,
    logger: SILENT,
    clock: createFakeClock(Date.UTC(2026, 9, 24)),
    settings: {
      apiVersion: 'v25.0',
      hosts: {
        graph: 'graph.facebook.com',
        graphVideo: 'graph-video.facebook.com',
        rupload: 'rupload.facebook.com',
      },
    },
    resumeBackoffMs: 0,
  };
  const result = await publishVideoStory(deps, {
    pageId: PAGE_ID,
    data: new Uint8Array(64),
    contentType: 'video/mp4',
    isAiGenerated: true,
    token: PAGE_TOKEN,
  });

  assert.deepEqual(result, {
    storyPostId: `${PAGE_ID}_9`,
    mediaId: start['video_id'],
    mediaType: 'video',
  });
  assert.deepEqual(
    fb.calls.map((c) => c.protocol),
    ['json', 'rupload', 'json'],
  );
  const finish = jsonAt(fb, 2);
  assert.deepEqual(finish.params, {
    upload_phase: 'finish',
    video_id: start['video_id'],
    is_ai_generated: true,
  });
  assert.equal(finish.verifyTool, STORY_VERIFY_TOOL);
});
