// Tests for the ad-preview read (v2 ads §6): the request each source kind
// builds, and the iframe extraction that is the only thing handed on.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeFbRequest, fbOk } from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';

import {
  PREVIEW_TTL_MS,
  generateAdPreview,
  normalizeObjectStoryId,
  parsePreview,
  previewRequest,
} from './ads-preview.js';

const IFRAME_SRC =
  'https://www.facebook.com/ads/api/preview_iframe.php?d=AQPLACEHOLDER&t=AQPLACEHOLDERTOKEN';

function previewBody(src = IFRAME_SRC.replace(/&/g, '&amp;')): Record<string, unknown> {
  return {
    data: [
      {
        body: `<iframe src="${src}" width="335" height="450" scrolling="yes" style="border: none;"></iframe>`,
      },
    ],
  };
}

test('ad and creative previews read /{id}/previews with the placement', () => {
  const ad = previewRequest({ kind: 'ad', adId: '111' }, 'INSTAGRAM_STORY');
  assert.equal(ad.method, 'GET');
  assert.equal(ad.api, 'marketing');
  assert.equal(ad.path, '/111/previews');
  assert.deepEqual(ad.params, { ad_format: 'INSTAGRAM_STORY' });

  const creative = previewRequest(
    { kind: 'creative', creativeId: '222' },
    'MOBILE_FEED_STANDARD',
  );
  assert.equal(creative.path, '/222/previews');
});

test('a post preview goes through generatepreviews with an object_story_id creative', () => {
  const req = previewRequest(
    { kind: 'post', accountId: 'act_42', objectStoryId: '900_555' },
    'DESKTOP_FEED_STANDARD',
  );
  assert.equal(req.path, '/act_42/generatepreviews');
  assert.deepEqual(req.params, {
    ad_format: 'DESKTOP_FEED_STANDARD',
    creative: '{"object_story_id":"900_555"}',
  });
});

test('parsePreview returns only the unescaped iframe src', () => {
  assert.equal(parsePreview(previewBody()), IFRAME_SRC);
  assert.equal(
    parsePreview({ data: [{ body: `<iframe width='1' src='${IFRAME_SRC}'></iframe>` }] }),
    IFRAME_SRC,
  );
});

test('parsePreview refuses an answer without a usable facebook.com iframe', () => {
  const refused: unknown[] = [
    {},
    { data: [] },
    { data: [{ body: 42 }] },
    { data: [{ body: '<div>no iframe</div>' }] },
    previewBody('http://www.facebook.com/ads/api/preview_iframe.php?d=x'),
    previewBody('https://evil.example.com/preview'),
    previewBody('https://facebook.com.evil.example/preview'),
    previewBody('javascript:alert(1)'),
  ];
  for (const raw of refused) {
    assert.throws(() => parsePreview(raw), GraphApiError, JSON.stringify(raw));
  }
});

test('normalizeObjectStoryId accepts only <page-id>_<post-id>', () => {
  assert.equal(normalizeObjectStoryId(' 900_555 '), '900_555');
  for (const bad of ['555', '900_', 'act_900', '900_555_1', '../x']) {
    assert.throws(() => normalizeObjectStoryId(bad), GraphApiError, bad);
  }
});

test('generateAdPreview stamps a ~24h validity from the injected clock', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk(previewBody()));
  const nowMs = Date.parse('2026-10-24T10:00:00Z');

  const preview = await generateAdPreview(fb.fn, {
    source: { kind: 'ad', adId: '111' },
    adFormat: 'MOBILE_FEED_STANDARD',
    nowMs,
  });

  assert.equal(preview.iframeSrc, IFRAME_SRC);
  assert.equal(preview.adFormat, 'MOBILE_FEED_STANDARD');
  assert.equal(preview.validUntil, new Date(nowMs + PREVIEW_TTL_MS).toISOString());
  assert.ok(preview.note.includes('24 hours'));
});
