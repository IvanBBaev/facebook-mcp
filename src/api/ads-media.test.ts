// Tests for ad image uploads (v2 ads §2): the adimages response parsing, the
// request shape, the format and size refusals, and the plan's content binding.
// Real files live in a temp FB_MEDIA_DIR; every Graph call is served by the
// fake, behind the network fence. Placeholder tokens only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeFbRequest, fbErr, fbOk } from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import type { MultipartRequest } from '../core/index.js';
import {
  AD_IMAGE_FILE_FIELD,
  MAX_AD_IMAGE_BYTES,
  assertAdImageExtension,
  parseAdImageResponse,
  uploadAdImage,
  uploadAdImageRequest,
} from './ads-media.js';
import { MediaSourceError, sha256Hex } from './media-photos.js';

const ACCOUNT_ID = 'act_1234567890';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function withMediaDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fbmcp-adimg-')));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const RESPONSE = {
  images: {
    'banner.png': {
      hash: '0a1b2c3d4e5f',
      url: 'https://scontent.example/banner.png',
      width: 1200,
      height: '628',
      name: 'banner.png',
    },
  },
};

test('parseAdImageResponse reads the first image and coerces its dimensions', () => {
  assert.deepEqual(parseAdImageResponse(RESPONSE), {
    hash: '0a1b2c3d4e5f',
    url: 'https://scontent.example/banner.png',
    width: 1200,
    height: 628,
    name: 'banner.png',
  });
  assert.equal(parseAdImageResponse({ images: {} }), undefined);
  assert.equal(parseAdImageResponse({ images: { a: { hash: '' } } }), undefined);
  assert.equal(parseAdImageResponse({ success: true }), undefined);
  assert.equal(parseAdImageResponse(null), undefined);
});

test('uploadAdImageRequest posts the bytes in the filename part to the marketing API', () => {
  const req = uploadAdImageRequest(
    ACCOUNT_ID,
    { data: PNG, filename: 'banner.png', contentType: 'image/png' },
    'Spring "hero"',
  );
  assert.equal(req.protocol, 'multipart');
  assert.equal(req.method, 'POST');
  assert.equal(req.api, 'marketing');
  assert.equal(req.path, `/${ACCOUNT_ID}/adimages`);
  assert.equal(req.files.length, 1);
  assert.equal(req.files[0]?.name, AD_IMAGE_FILE_FIELD);
  assert.equal(req.files[0]?.filename, 'Spring _hero_');
  assert.equal(req.files[0]?.contentType, 'image/png');
});

test('assertAdImageExtension refuses formats the library does not take', () => {
  for (const ok of [
    'a.jpg',
    'a.JPEG',
    'a.png',
    'a.gif',
    'a.bmp',
    'a.tif',
    'a.tiff',
    'a.webp',
  ]) {
    assert.doesNotThrow(() => assertAdImageExtension(ok, ok));
  }
  for (const bad of ['a.heic', 'a.mp4', 'a.svg', 'noext']) {
    assert.throws(
      () => assertAdImageExtension(bad, bad),
      (err: unknown) =>
        err instanceof MediaSourceError && err.reason === 'unsupported_format',
    );
  }
});

test('uploadAdImage uploads the bound file and returns its hash', async () => {
  await withMediaDir(async (dir) => {
    await writeFile(join(dir, 'banner.png'), PNG);
    const fb = createFakeFbRequest();
    fb.on((r) => r.method === 'POST', fbOk(RESPONSE));

    const outcome = await uploadAdImage(
      fb.fn,
      { mediaDir: dir },
      {
        accountId: ACCOUNT_ID,
        requested: 'banner.png',
        bound: { bytes: PNG.length, sha256: sha256Hex(PNG) },
      },
    );

    assert.equal(outcome.adAccountId, ACCOUNT_ID);
    assert.equal(outcome.image?.hash, '0a1b2c3d4e5f');
    const sent = fb.calls[0] as MultipartRequest;
    assert.deepEqual([...(sent.files[0]?.data ?? [])], [...PNG]);
  });
});

test('uploadAdImage refuses a changed file, a non-image and stays inside FB_MEDIA_DIR', async () => {
  await withMediaDir(async (dir) => {
    await writeFile(join(dir, 'banner.png'), PNG);
    await writeFile(join(dir, 'fake.png'), new Uint8Array([1, 2, 3, 4]));
    const fb = createFakeFbRequest();
    const reasonOf = async (requested: string, sha256: string, bytes: number) => {
      try {
        await uploadAdImage(
          fb.fn,
          { mediaDir: dir },
          { accountId: ACCOUNT_ID, requested, bound: { bytes, sha256 } },
        );
        return 'uploaded';
      } catch (err) {
        assert.ok(err instanceof MediaSourceError);
        return err.reason;
      }
    };

    assert.equal(
      await reasonOf('banner.png', '0'.repeat(64), PNG.length),
      'file_changed',
    );
    const fake = new Uint8Array([1, 2, 3, 4]);
    assert.equal(await reasonOf('fake.png', sha256Hex(fake), 4), 'unsupported_format');
    assert.equal(
      await reasonOf('../outside.png', sha256Hex(PNG), 12),
      'outside_media_dir',
    );
    assert.equal(fb.calls.length, 0, 'a local refusal sends nothing');
  });
});

test('uploadAdImage caps the file at 30 MB', async () => {
  await withMediaDir(async (dir) => {
    const big = new Uint8Array(MAX_AD_IMAGE_BYTES + 1);
    big.set(PNG);
    await writeFile(join(dir, 'big.png'), big);
    const fb = createFakeFbRequest();
    await assert.rejects(
      uploadAdImage(
        fb.fn,
        { mediaDir: dir },
        {
          accountId: ACCOUNT_ID,
          requested: 'big.png',
          bound: { bytes: big.length, sha256: sha256Hex(big) },
        },
      ),
      (err: unknown) =>
        err instanceof MediaSourceError && err.reason === 'file_too_large',
    );
    assert.equal(fb.calls.length, 0);
  });
});

test("a code-100 refusal carries Meta's user message", async () => {
  await withMediaDir(async (dir) => {
    await writeFile(join(dir, 'banner.png'), PNG);
    const fb = createFakeFbRequest();
    fb.on(
      (r) => r.method === 'POST',
      fbErr(
        new GraphApiError('(#100) Invalid image', {
          code: 100,
          httpStatus: 400,
          userMessage: 'The image is too small.',
        }),
      ),
    );
    await assert.rejects(
      uploadAdImage(
        fb.fn,
        { mediaDir: dir },
        {
          accountId: ACCOUNT_ID,
          requested: 'banner.png',
          bound: { bytes: PNG.length, sha256: sha256Hex(PNG) },
        },
      ),
      (err: unknown) =>
        err instanceof GraphApiError &&
        err.code === 100 &&
        /Meta refused the image: The image is too small\./.test(err.message),
    );
  });
});
