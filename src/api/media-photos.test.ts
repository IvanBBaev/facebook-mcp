// Tests for the photo publishing flows (task V04, `api` layer).
//
// Every Graph call is served by `createFakeFbRequest`; the network fence
// guarantees no real fetch escapes, and the fake REJECTS an unstubbed request,
// so the "nothing reached the wire" assertions are backed by two independent
// mechanisms.
//
// The filesystem, by contrast, is REAL: the `FB_MEDIA_DIR` containment rules
// (C11 / CC-MEDIA-5) are only meaningful against real inodes, so each local test
// builds a temp tree — including a genuine symlink pointing out of the
// allowlisted directory — and removes it afterwards.

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, constants as fsConstants } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createFakeFbRequest,
  fbErr,
  fbOk,
  type FakeFbRequest,
} from '../core/fakes/index.js';
import { GraphApiError, ambiguousWriteAction, toGraphApiError } from '../core/index.js';
import type {
  FbRequest,
  FbRequestFn,
  FbResponse,
  JsonRequest,
  LogFields,
  Logger,
  MultipartRequest,
} from '../core/index.js';

import {
  ALLOWED_REMOTE_SCHEME,
  DEFAULT_CLEANUP_TIMEOUT_MS,
  EMPTY_ORPHAN_REPORT,
  FALLBACK_CONTENT_TYPE,
  MediaSourceError,
  MultiPhotoUploadError,
  PHOTO_BYTES_FIELD,
  assertNoReservedPhotoParams,
  attachedMediaParams,
  cleanupUnpublishedPhotos,
  describeOrphans,
  detectPhotoContentType,
  multipartFilename,
  preparePhotoSources,
  readLocalPhoto,
  resolveLocalMediaPath,
  resolveRemoteMediaUrl,
  uploadPhoto,
  uploadUnpublishedPhotos,
  type MediaPhotoDeps,
  type MediaSourceErrorReason,
  type PhotoSource,
} from './media-photos.js';

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const PAGE_ID = '777';
const PAGE_TOKEN = 'EAA-PAGE-PLACEHOLDER';
const REMOTE = 'https://cdn.example.com/a.jpg';

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

/** A minimal byte blob that sniffs as `image/png`. */
function pngBytes(tail = 'payload'): Uint8Array {
  return Uint8Array.from([...PNG_HEADER, ...Buffer.from(tail, 'utf8')]);
}

function url(target: string): PhotoSource {
  return { kind: 'url', url: target };
}

function local(path: string): PhotoSource {
  return { kind: 'local', path };
}

function makeDeps(
  fb: FakeFbRequest,
  opts: { mediaDir?: string; maxBytes?: number; logger?: Logger } = {},
): MediaPhotoDeps {
  return {
    fbRequest: fb.fn,
    ...(opts.mediaDir !== undefined ? { mediaDir: opts.mediaDir } : {}),
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  };
}

interface LogEntry {
  readonly level: string;
  readonly msg: string;
  readonly fields?: LogFields;
}

interface RecordingLogger extends Logger {
  readonly entries: readonly LogEntry[];
}

function makeLogger(): RecordingLogger {
  const entries: LogEntry[] = [];
  const at =
    (level: string) =>
    (msg: string, fields?: LogFields): void => {
      entries.push({ level, msg, fields });
    };
  return {
    entries,
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  };
}

/** A logger whose sink is broken — every call throws (a full disk, say). */
function makeBrokenLogger(): Logger {
  const boom = (): never => {
    throw new Error('logger sink is broken');
  };
  return { debug: boom, info: boom, warn: boom, error: boom };
}

// --- request narrowing ------------------------------------------------------

function jsonAt(fb: FakeFbRequest, index: number): JsonRequest {
  const call = fb.calls[index];
  assert.ok(call, `expected a request at index ${String(index)}`);
  if (call.protocol !== 'json') {
    throw new Error(`expected a json request at ${String(index)}, got ${call.protocol}`);
  }
  return call;
}

function multipartAt(fb: FakeFbRequest, index: number): MultipartRequest {
  const call = fb.calls[index];
  assert.ok(call, `expected a request at index ${String(index)}`);
  if (call.protocol !== 'multipart') {
    throw new Error(
      `expected a multipart request at ${String(index)}, got ${call.protocol}`,
    );
  }
  return call;
}

// --- rejection helpers ------------------------------------------------------

async function rejectsMediaSourceError(
  promise: Promise<unknown>,
  reason: MediaSourceErrorReason,
): Promise<MediaSourceError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(
      err instanceof MediaSourceError,
      `expected MediaSourceError, got ${String(err)}`,
    );
    assert.equal(err.reason, reason, `wrong reason (message: ${err.message})`);
    return err;
  }
  return assert.fail(`expected a MediaSourceError with reason "${reason}"`);
}

function throwsMediaSourceError(
  fn: () => unknown,
  reason: MediaSourceErrorReason,
): MediaSourceError {
  try {
    fn();
  } catch (err) {
    assert.ok(
      err instanceof MediaSourceError,
      `expected MediaSourceError, got ${String(err)}`,
    );
    assert.equal(err.reason, reason, `wrong reason (message: ${err.message})`);
    return err;
  }
  return assert.fail(`expected a MediaSourceError with reason "${reason}"`);
}

async function rejectsMultiPhotoError(
  promise: Promise<unknown>,
): Promise<MultiPhotoUploadError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(
      err instanceof MultiPhotoUploadError,
      `expected MultiPhotoUploadError, got ${String(err)}`,
    );
    return err;
  }
  return assert.fail('expected a MultiPhotoUploadError');
}

// --- temp media tree --------------------------------------------------------

interface MediaFixture {
  /** Realpath of the temp root; `mediaDir` and `outside` are siblings under it. */
  readonly root: string;
  /** The allowlisted directory (`FB_MEDIA_DIR`). */
  readonly mediaDir: string;
  /** A sibling directory that is deliberately NOT allowlisted. */
  readonly outside: string;
}

/**
 * Build `<tmp>/{media,outside}` and register its removal on the test context.
 * The root is realpath'ed up front because macOS hands out `/var/...` temp paths
 * that are themselves symlinks into `/private/var` — comparing against the
 * unresolved path would make every containment assertion vacuous.
 */
async function mediaFixture(t: TestContext): Promise<MediaFixture> {
  const raw = await mkdtemp(join(tmpdir(), 'fbmcp-media-'));
  t.after(() => rm(raw, { recursive: true, force: true }));
  const root = await realpath(raw);
  const mediaDir = join(root, 'media');
  const outside = join(root, 'outside');
  await mkdir(mediaDir);
  await mkdir(outside);
  return { root, mediaDir, outside };
}

// ---------------------------------------------------------------------------
// detectPhotoContentType — a transport HINT, never format validation (C10)
// ---------------------------------------------------------------------------

test('detectPhotoContentType: magic numbers outrank a lying extension', () => {
  assert.equal(detectPhotoContentType(pngBytes(), 'actually-a.jpg'), 'image/png');
  assert.equal(
    detectPhotoContentType(bytes(0xff, 0xd8, 0xff, 0xe0), 'x.png'),
    'image/jpeg',
  );
  assert.equal(
    detectPhotoContentType(bytes(0x47, 0x49, 0x46, 0x38), 'x.png'),
    'image/gif',
  );
  assert.equal(detectPhotoContentType(bytes(0x42, 0x4d, 0x01), 'x.png'), 'image/bmp');
  assert.equal(
    detectPhotoContentType(bytes(0x49, 0x49, 0x2a, 0x00), 'x.png'),
    'image/tiff',
  );
  assert.equal(
    detectPhotoContentType(bytes(0x4d, 0x4d, 0x00, 0x2a), 'x.png'),
    'image/tiff',
  );
  assert.equal(
    // ISO-BMFF `ftyp` plus a HEIF major brand (`heic`) — `ftyp` alone is also MP4.
    detectPhotoContentType(
      bytes(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63),
      'x.png',
    ),
    'image/heic',
  );
});

test('detectPhotoContentType: RIFF alone is not WebP — the brand at offset 8 decides', () => {
  const riff = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0];
  const webp = bytes(...riff, 0x57, 0x45, 0x42, 0x50);
  const avi = bytes(...riff, 0x41, 0x56, 0x49, 0x20);
  assert.equal(detectPhotoContentType(webp, 'x.bin'), 'image/webp');
  // The second signature did not match, so the extension decides instead.
  assert.equal(detectPhotoContentType(avi, 'x.bin'), FALLBACK_CONTENT_TYPE);
  assert.equal(detectPhotoContentType(avi, 'x.jpeg'), 'image/jpeg');
});

test('detectPhotoContentType: falls back to the extension, then to octet-stream', () => {
  assert.equal(detectPhotoContentType(bytes(1, 2, 3), 'photo.HEIF'), 'image/heic');
  assert.equal(
    detectPhotoContentType(bytes(1, 2, 3), 'photo.unknown'),
    FALLBACK_CONTENT_TYPE,
  );
  assert.equal(detectPhotoContentType(bytes(), 'noext'), FALLBACK_CONTENT_TYPE);
  // Shorter than the signature it would otherwise match: the length guard holds.
  assert.equal(detectPhotoContentType(bytes(0xff), 'tiny.png'), 'image/png');
});

// ---------------------------------------------------------------------------
// Remote sources — https-only allowlist (CC-MEDIA-4)
// ---------------------------------------------------------------------------

test('resolveRemoteMediaUrl: accepts and normalizes an https URL', () => {
  assert.equal(ALLOWED_REMOTE_SCHEME, 'https:');
  assert.equal(resolveRemoteMediaUrl(REMOTE), REMOTE);
  assert.equal(
    resolveRemoteMediaUrl('https://cdn.example.com:443/a b.jpg?v=1'),
    'https://cdn.example.com/a%20b.jpg?v=1',
  );
});

// Regression coverage (anti-over-refusal): the CC-MEDIA-4 allowlist is a SCHEME
// check and nothing more. Uppercase scheme spelling, an explicit non-default
// port, a query string, an IP-literal host and a fragment are all legitimate
// ways to address a public image and must never be swept up by the refusal.
test('resolveRemoteMediaUrl: unusual but legitimate https URLs are accepted, not over-refused', () => {
  assert.equal(
    resolveRemoteMediaUrl('HTTPS://CDN.Example.com/Photo.JPG'),
    'https://cdn.example.com/Photo.JPG',
    'the scheme and host are case-normalized; the path is left alone',
  );
  assert.equal(
    resolveRemoteMediaUrl('https://cdn.example.com:8443/a.jpg?sig=abc&exp=1'),
    'https://cdn.example.com:8443/a.jpg?sig=abc&exp=1',
    'a non-default port and a signed-URL query string survive intact',
  );
  assert.equal(
    resolveRemoteMediaUrl('https://203.0.113.7/a.jpg'),
    'https://203.0.113.7/a.jpg',
    "an IP-literal host is Meta's problem to reach, not ours to police",
  );
  assert.equal(
    resolveRemoteMediaUrl('https://[2001:db8::1]/a.jpg'),
    'https://[2001:db8::1]/a.jpg',
    'an IPv6 literal is not mistaken for embedded credentials',
  );
});

test('CC-MEDIA-4: every non-https scheme is refused — no SSRF proxy, no local reads', () => {
  const refused = [
    'http://cdn.example.com/a.jpg',
    'file:///etc/passwd',
    'data:image/png;base64,iVBORw0KGgo=',
    'ftp://cdn.example.com/a.jpg',
    'javascript:alert(1)',
    'blob:https://cdn.example.com/1234',
    'HTTP://cdn.example.com/a.jpg',
  ];
  for (const candidate of refused) {
    const err = throwsMediaSourceError(
      () => resolveRemoteMediaUrl(candidate),
      'unsupported_url_scheme',
    );
    assert.match(
      err.message,
      /https:\/\//,
      `${candidate}: the message names the allowed scheme`,
    );
    assert.equal(err.source, candidate);
  }
});

test('CC-MEDIA-4: a URL embedding credentials is refused (Meta would receive them)', () => {
  const err = throwsMediaSourceError(
    () => resolveRemoteMediaUrl('https://user:hunter2@cdn.example.com/a.jpg'),
    'url_has_credentials',
  );
  // The refusal must not echo the secret back into the message (C3).
  assert.doesNotMatch(err.message, /hunter2/);
  throwsMediaSourceError(
    () => resolveRemoteMediaUrl('https://user@cdn.example.com/a.jpg'),
    'url_has_credentials',
  );
});

test('resolveRemoteMediaUrl: a relative or garbage string is a malformed_url', () => {
  throwsMediaSourceError(() => resolveRemoteMediaUrl('/local/a.jpg'), 'malformed_url');
  throwsMediaSourceError(
    () => resolveRemoteMediaUrl('cdn.example.com/a.jpg'),
    'malformed_url',
  );
  throwsMediaSourceError(() => resolveRemoteMediaUrl(''), 'malformed_url');
});

// ---------------------------------------------------------------------------
// Local sources — FB_MEDIA_DIR gating (C11) and containment (CC-MEDIA-5)
// ---------------------------------------------------------------------------

test('C11: with FB_MEDIA_DIR unset every local path is refused', async () => {
  const fb = createFakeFbRequest();
  const err = await rejectsMediaSourceError(
    resolveLocalMediaPath('/etc/passwd', {}),
    'local_media_disabled',
  );
  assert.match(err.message, /FB_MEDIA_DIR/);
  // A blank / whitespace-only setting counts as unset, never as "the cwd".
  await rejectsMediaSourceError(
    resolveLocalMediaPath('a.png', { mediaDir: '' }),
    'local_media_disabled',
  );
  await rejectsMediaSourceError(
    resolveLocalMediaPath('a.png', { mediaDir: '   ' }),
    'local_media_disabled',
  );
  // And the disabled path never reaches the wire.
  await rejectsMediaSourceError(
    uploadPhoto(makeDeps(fb), { pageId: PAGE_ID, source: local('a.png') }),
    'local_media_disabled',
  );
  assert.equal(fb.calls.length, 0);
});

test('C11: FB_MEDIA_DIR pointing at a missing directory is media_dir_unreadable', async (t) => {
  const fx = await mediaFixture(t);
  await rejectsMediaSourceError(
    resolveLocalMediaPath('a.png', { mediaDir: join(fx.root, 'nope') }),
    'media_dir_unreadable',
  );
});

test('C11: a relative path resolves inside FB_MEDIA_DIR, never the process cwd', async (t) => {
  const fx = await mediaFixture(t);
  await mkdir(join(fx.mediaDir, 'nested'));
  await writeFile(join(fx.mediaDir, 'nested', 'pic.png'), pngBytes());

  const resolved = await resolveLocalMediaPath('nested/pic.png', {
    mediaDir: fx.mediaDir,
  });
  assert.equal(resolved.path, join(fx.mediaDir, 'nested', 'pic.png'));
  assert.equal(resolved.filename, 'pic.png');
  assert.equal(resolved.bytes, pngBytes().byteLength);

  // `package.json` exists in the repo cwd but not in FB_MEDIA_DIR: were the cwd
  // consulted, this would resolve instead of failing.
  await rejectsMediaSourceError(
    resolveLocalMediaPath('package.json', { mediaDir: fx.mediaDir }),
    'file_not_found',
  );
});

test('CC-MEDIA-5: `..` traversal out of FB_MEDIA_DIR is refused', async (t) => {
  const fx = await mediaFixture(t);
  await writeFile(join(fx.outside, 'secret.png'), pngBytes());

  const err = await rejectsMediaSourceError(
    resolveLocalMediaPath('../outside/secret.png', { mediaDir: fx.mediaDir }),
    'outside_media_dir',
  );
  assert.match(err.message, /FB_MEDIA_DIR/);
  await rejectsMediaSourceError(
    resolveLocalMediaPath(join(fx.outside, 'secret.png'), { mediaDir: fx.mediaDir }),
    'outside_media_dir',
  );
});

test('CC-MEDIA-5: a sibling directory sharing the name prefix is NOT inside it', async (t) => {
  // The separator-boundary case: "<root>/media-evil" starts with "<root>/media"
  // as a plain string, so a naive prefix test would let it through.
  const fx = await mediaFixture(t);
  const evil = `${fx.mediaDir}-evil`;
  await mkdir(evil);
  await writeFile(join(evil, 'pic.png'), pngBytes());

  await rejectsMediaSourceError(
    resolveLocalMediaPath(join(evil, 'pic.png'), { mediaDir: fx.mediaDir }),
    'outside_media_dir',
  );
  await rejectsMediaSourceError(
    resolveLocalMediaPath('../media-evil/pic.png', { mediaDir: fx.mediaDir }),
    'outside_media_dir',
  );
});

test('CC-MEDIA-5: a real symlink escaping FB_MEDIA_DIR is refused; one staying inside is not', async (t) => {
  const fx = await mediaFixture(t);
  await writeFile(join(fx.outside, 'secret.png'), pngBytes('secret'));
  await writeFile(join(fx.mediaDir, 'real.png'), pngBytes('real'));
  // A genuine symlink inside the allowlisted directory, pointing out of it...
  await symlink(join(fx.outside, 'secret.png'), join(fx.mediaDir, 'escape.png'));
  // ...and a control symlink whose target stays inside it.
  await symlink(join(fx.mediaDir, 'real.png'), join(fx.mediaDir, 'inside.png'));

  const err = await rejectsMediaSourceError(
    resolveLocalMediaPath('escape.png', { mediaDir: fx.mediaDir }),
    'outside_media_dir',
  );
  assert.match(err.message, /symlink/);

  // The control proves the rejection is about CONTAINMENT, not about symlinks:
  // a link resolving inside the directory is accepted, under its real name.
  const ok = await resolveLocalMediaPath('inside.png', { mediaDir: fx.mediaDir });
  assert.equal(ok.path, join(fx.mediaDir, 'real.png'));
  assert.equal(
    ok.filename,
    'real.png',
    'the realpath basename is used, not the link name',
  );
});

test('CC-MEDIA-5: a symlinked DIRECTORY cannot be used to escape either', async (t) => {
  const fx = await mediaFixture(t);
  await writeFile(join(fx.outside, 'secret.png'), pngBytes());
  await symlink(fx.outside, join(fx.mediaDir, 'link-dir'));

  await rejectsMediaSourceError(
    resolveLocalMediaPath('link-dir/secret.png', { mediaDir: fx.mediaDir }),
    'outside_media_dir',
  );
});

test('CC-MEDIA-5: a missing path OUTSIDE the directory reports the boundary, not existence', async (t) => {
  const fx = await mediaFixture(t);
  // Nothing here exists — the answer must still be "out of bounds", so the tool
  // never becomes an existence oracle for the rest of the filesystem.
  await rejectsMediaSourceError(
    resolveLocalMediaPath('../outside/nope.png', { mediaDir: fx.mediaDir }),
    'outside_media_dir',
  );
  // Inside the directory, a missing file is honestly reported as missing.
  await rejectsMediaSourceError(
    resolveLocalMediaPath('nope.png', { mediaDir: fx.mediaDir }),
    'file_not_found',
  );
});

test('CC-MEDIA-5: zero-byte, non-regular and oversized files fail fast locally', async (t) => {
  const fx = await mediaFixture(t);
  await writeFile(join(fx.mediaDir, 'empty.png'), new Uint8Array(0));
  await mkdir(join(fx.mediaDir, 'a-directory'));
  await writeFile(join(fx.mediaDir, 'big.png'), pngBytes('0123456789'));

  await rejectsMediaSourceError(
    resolveLocalMediaPath('empty.png', { mediaDir: fx.mediaDir }),
    'empty_file',
  );
  await rejectsMediaSourceError(
    resolveLocalMediaPath('a-directory', { mediaDir: fx.mediaDir }),
    'not_a_regular_file',
  );
  // FB_MEDIA_DIR itself is inside FB_MEDIA_DIR, but it is not a file.
  await rejectsMediaSourceError(
    resolveLocalMediaPath('.', { mediaDir: fx.mediaDir }),
    'not_a_regular_file',
  );
  const err = await rejectsMediaSourceError(
    resolveLocalMediaPath('big.png', { mediaDir: fx.mediaDir, maxBytes: 8 }),
    'file_too_large',
  );
  assert.match(err.message, /8-byte/);
});

test('CC-MEDIA-5: an unreadable file is refused', async (t) => {
  if (process.platform === 'win32') {
    t.skip('chmod 0o000 does not restrict reads on win32 — protection is the NTFS ACL');
    return;
  }
  if (process.getuid?.() === 0) {
    t.skip('running as root — permission bits do not restrict reads');
    return;
  }
  const fx = await mediaFixture(t);
  const target = join(fx.mediaDir, 'locked.png');
  await writeFile(target, pngBytes());
  // Left unreadable on purpose: the fixture's `rm` unlinks it from a writable
  // parent regardless of the file's own mode, so no chmod-back hook is needed.
  await chmod(target, 0o000);

  await rejectsMediaSourceError(
    resolveLocalMediaPath('locked.png', { mediaDir: fx.mediaDir }),
    'file_unreadable',
  );
});

// A quote (Content-Disposition injection), a control character, and U+FFFD --
// what a non-UTF-8 filename decodes to. Each must collapse to a single `_`.
// Built from code points so this source file stays plain ASCII.
const BEL = String.fromCharCode(0x07);
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);
const HOSTILE_FILENAME = `we"ird${BEL}na${REPLACEMENT_CHAR}me.png`;

/** Every character the multipart name must never carry. */
function assertSanitized(filename: string): void {
  assert.equal(filename, 'we_ird_na_me.png');
  for (const unsafe of ['"', '\\', BEL, REPLACEMENT_CHAR]) {
    assert.equal(filename.includes(unsafe), false, `"${unsafe}" survived sanitization`);
  }
}

test('CC-MEDIA-5: the multipart name sanitizer collapses every unsafe code point', () => {
  assertSanitized(multipartFilename(HOSTILE_FILENAME));
});

test('CC-MEDIA-5: a hostile filename is sanitized before it becomes a multipart name', async (t) => {
  if (process.platform === 'win32') {
    // NTFS refuses `"` and control characters outright, so the hostile name cannot
    // exist on disk here. The sanitizer itself is covered by the unit test above.
    t.skip('win32 cannot create a file with this name');
    return;
  }
  const fx = await mediaFixture(t);
  await writeFile(join(fx.mediaDir, HOSTILE_FILENAME), pngBytes());

  const resolved = await resolveLocalMediaPath(HOSTILE_FILENAME, {
    mediaDir: fx.mediaDir,
  });
  assertSanitized(resolved.filename);
});

test('readLocalPhoto: buffers the bytes and sniffs the content type', async (t) => {
  const fx = await mediaFixture(t);
  await writeFile(join(fx.mediaDir, 'shot.png'), pngBytes());

  const file = await readLocalPhoto('shot.png', { mediaDir: fx.mediaDir });
  assert.deepEqual([...file.data], [...pngBytes()]);
  assert.equal(file.contentType, 'image/png');
  assert.equal(file.bytes, pngBytes().byteLength);
  assert.equal(file.filename, 'shot.png');
  assert.equal(file.path, join(fx.mediaDir, 'shot.png'));
});

test('preparePhotoSources: validates every source in order, touching no network', async (t) => {
  const fx = await mediaFixture(t);
  await writeFile(join(fx.mediaDir, 'a.png'), pngBytes());

  const prepared = await preparePhotoSources([url(REMOTE), local('a.png')], {
    mediaDir: fx.mediaDir,
  });
  assert.equal(prepared.length, 2);
  assert.deepEqual(prepared[0], { kind: 'url', url: REMOTE });
  const second = prepared[1];
  assert.ok(second !== undefined && second.kind === 'local');
  assert.equal(second.file.filename, 'a.png');

  // The FIRST invalid source stops the pass.
  await rejectsMediaSourceError(
    preparePhotoSources([url(REMOTE), url('http://nope/a.jpg'), local('a.png')], {
      mediaDir: fx.mediaDir,
    }),
    'unsupported_url_scheme',
  );
});

// ---------------------------------------------------------------------------
// Single photo post
// ---------------------------------------------------------------------------

test('single photo: POSTs caption + published:true to /{page-id}/photos and returns both ids', async () => {
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ id: 'photo-1', post_id: '777_888' }));

  const uploaded = await uploadPhoto(makeDeps(fb), {
    pageId: PAGE_ID,
    source: url(REMOTE),
    caption: 'hello world',
    token: PAGE_TOKEN,
    timeoutMs: 4321,
  });

  assert.deepEqual(uploaded, { id: 'photo-1', postId: '777_888' });
  const req = jsonAt(fb, 0);
  assert.equal(req.method, 'POST');
  assert.equal(req.host, 'graph');
  assert.equal(req.path, '/777/photos');
  assert.equal(req.token, PAGE_TOKEN);
  assert.equal(req.timeoutMs, 4321);
  assert.deepEqual(req.body, { caption: 'hello world', published: true, url: REMOTE });
  assert.equal(
    req.params,
    undefined,
    'params ride in the body, not an echoable query string',
  );
  assert.equal(fb.calls.length, 1);
});

test('single photo: published:false yields a child id and no post id', async () => {
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ id: 'photo-1' }));

  const uploaded = await uploadPhoto(makeDeps(fb), {
    pageId: PAGE_ID,
    source: url(REMOTE),
    published: false,
  });

  assert.deepEqual(uploaded, { id: 'photo-1' });
  assert.equal(jsonAt(fb, 0).body?.published, false);
});

test('single photo: an empty-string post_id is dropped, not reported as a post', async () => {
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ id: 'photo-1', post_id: '' }));

  const uploaded = await uploadPhoto(makeDeps(fb), {
    pageId: PAGE_ID,
    source: url(REMOTE),
  });
  assert.deepEqual(uploaded, { id: 'photo-1' });
});

test('single photo (local): uploads via the multipart protocol with a sniffed content type', async (t) => {
  const fx = await mediaFixture(t);
  await writeFile(join(fx.mediaDir, 'shot.png'), pngBytes());
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ id: 'photo-1', post_id: '777_888' }));

  const uploaded = await uploadPhoto(makeDeps(fb, { mediaDir: fx.mediaDir }), {
    pageId: PAGE_ID,
    source: local('shot.png'),
    caption: 'from disk',
    token: PAGE_TOKEN,
  });

  assert.deepEqual(uploaded, { id: 'photo-1', postId: '777_888' });
  const req = multipartAt(fb, 0);
  assert.equal(req.method, 'POST');
  assert.equal(req.host, 'graph');
  assert.equal(req.path, '/777/photos');
  assert.equal(req.token, PAGE_TOKEN);
  assert.deepEqual(req.fields, { caption: 'from disk', published: 'true' });
  assert.equal(req.files.length, 1);
  const part = req.files[0];
  assert.ok(part);
  assert.equal(part.name, PHOTO_BYTES_FIELD);
  assert.equal(part.filename, 'shot.png');
  assert.equal(part.contentType, 'image/png');
  assert.deepEqual([...part.data], [...pngBytes()]);
});

test('single photo: an http:/file:/data: source never reaches the wire (CC-MEDIA-4)', async () => {
  const fb = createFakeFbRequest();
  for (const bad of [
    'http://cdn.example.com/a.jpg',
    'file:///etc/passwd',
    'data:image/png;base64,AAA=',
  ]) {
    await rejectsMediaSourceError(
      uploadPhoto(makeDeps(fb), { pageId: PAGE_ID, source: url(bad) }),
      'unsupported_url_scheme',
    );
  }
  assert.equal(fb.calls.length, 0);
});

test('single photo: a 2xx carrying no id is an AMBIGUOUS write, not a silent success (C2)', async () => {
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ post_id: '777_888' }, {}, 201));

  await assert.rejects(
    uploadPhoto(makeDeps(fb), { pageId: PAGE_ID, source: url(REMOTE) }),
    (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.equal(err.httpStatus, 201);
      assert.equal(err.action?.category, 'ambiguous');
      assert.equal(err.action?.retryable, false);
      assert.match(err.message, /do NOT retry blindly/);
      assert.match(err.message, /cdn\.example\.com/, 'the failing source is named');
      return true;
    },
  );
});

test('single photo: an id-less 2xx that still names a post_id hands that id to the operator (C2)', async () => {
  // Graph answered without the photo id but WITH a post id: the write clearly
  // landed as a post. Swallowing the one handle we were given would send the
  // operator hunting the whole Page for "a stray photo" they could have looked
  // up directly. The id must be surfaced, and only when it is a real string —
  // never minted from a number that has already lost digits in JSON.parse.
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ post_id: '777_888' }, {}, 201));

  await assert.rejects(
    uploadPhoto(makeDeps(fb), { pageId: PAGE_ID, source: url(REMOTE) }),
    (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.equal(err.action?.category, 'ambiguous', 'still ambiguous — no photo id');
      assert.equal(err.action?.retryable, false);
      assert.match(
        err.message,
        /post id 777_888/,
        'the post id Graph DID report is named, so the operator can go straight to it',
      );
      assert.match(
        err.action?.operatorText ?? '',
        /777_888/,
        'the structured action detail carries the same handle',
      );
      return true;
    },
  );
});

// Regression coverage (CC-NET-2, mirrored from the video/reels lanes): a NUMERIC
// id off the wire is never minted into a string. Graph ids run past the
// safe-integer range, so `String(12345)` could be a plausible handle that has
// already lost digits in JSON.parse — the honest answer is "no id".
test('single photo: a numeric id or post_id is never minted into a string handle (CC-NET-2)', async () => {
  const fb = createFakeFbRequest();

  fb.enqueue(fbOk({ id: 12345 }));
  await assert.rejects(
    uploadPhoto(makeDeps(fb), { pageId: PAGE_ID, source: url(REMOTE) }),
    (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.equal(err.action?.category, 'ambiguous');
      assert.doesNotMatch(
        err.message,
        /12345/,
        'the number is not echoed as if it were a handle',
      );
      return true;
    },
  );

  // A numeric post_id next to a good photo id: the photo is a success and the
  // post id is dropped, not stringified.
  fb.enqueue(fbOk({ id: 'photo-1', post_id: 777888 }));
  const uploaded = await uploadPhoto(makeDeps(fb), {
    pageId: PAGE_ID,
    source: url(REMOTE),
  });
  assert.deepEqual(uploaded, { id: 'photo-1' });

  // Both numeric: there is nothing honest to name, so the generic hint stands.
  fb.enqueue(fbOk({ id: 12345, post_id: 777888 }));
  await assert.rejects(
    uploadPhoto(makeDeps(fb), { pageId: PAGE_ID, source: url(REMOTE) }),
    (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.doesNotMatch(err.message, /777888|12345/);
      assert.match(err.message, /check the Page for a stray photo first/);
      return true;
    },
  );
});

// Regression coverage (CC-NET-2): `fbRequest` CASTS a 2xx body to the declared
// type — a bodiless 2xx arrives as `undefined`, a JSON literal as itself and a
// non-JSON body as its raw string. None of these carries a photo id, so every
// one must be the C2 ambiguous error, never a TypeError from `.id` on a
// non-object and never a silent success.
test('single photo: a 2xx whose body is not an object is ambiguous, not a crash (CC-NET-2)', async () => {
  const fb = createFakeFbRequest();
  const bodies: unknown[] = [
    undefined,
    null,
    false,
    0,
    '',
    'null',
    '<html>maintenance</html>',
    [],
  ];
  for (const body of bodies) {
    fb.enqueue(fbOk(body, {}, 200));
    await assert.rejects(
      uploadPhoto(makeDeps(fb), { pageId: PAGE_ID, source: url(REMOTE) }),
      (err: unknown) => {
        assert.ok(
          err instanceof GraphApiError,
          `body ${JSON.stringify(body)} must be a GraphApiError`,
        );
        assert.equal(err.action?.category, 'ambiguous');
        assert.equal(err.httpStatus, 200);
        return true;
      },
    );
  }
  assert.equal(
    fb.calls.length,
    bodies.length,
    'each body cost exactly one call — no retry',
  );
});

// Regression coverage (C10, anti-over-refusal): a caption is content, not a
// format this module validates. Newlines, emoji, hashtags, `&`/`=` and quotes
// all ride through the JSON body verbatim — there is no encoding step here for
// them to be mangled by, and no length or character policy to trip over.
test('single photo: a caption with newlines, emoji and form-hostile characters is passed verbatim (C10)', async () => {
  const caption = 'Line one\nLine two — “quotes” & a=b?c #hashtag 🎉';
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ id: 'photo-1', post_id: '777_888' }));

  await uploadPhoto(makeDeps(fb), { pageId: PAGE_ID, source: url(REMOTE), caption });
  assert.equal(jsonAt(fb, 0).body?.caption, caption);
});

test('single photo: a Graph error propagates unchanged (mapping stays in the client)', async () => {
  const fb = createFakeFbRequest();
  const boom = new GraphApiError('(#200) Permissions error', {
    code: 200,
    httpStatus: 403,
  });
  fb.enqueue(fbErr(boom));

  await assert.rejects(
    uploadPhoto(makeDeps(fb), { pageId: PAGE_ID, source: url(REMOTE) }),
    (err: unknown) => {
      assert.equal(err, boom, 'the same instance, not a re-wrap');
      return true;
    },
  );
});

test('url photo: Graph code 324 (image could not be fetched/read) names the URL as the problem, not "unclassified"', async () => {
  const fb = createFakeFbRequest();
  const original = toGraphApiError(
    {
      code: 324,
      message: '(#324) Missing or invalid image file',
      type: 'OAuthException',
      fbtrace_id: 'TRACE324',
    },
    400,
  );
  fb.enqueue(fbErr(original));

  const err = await uploadPhoto(makeDeps(fb), {
    pageId: PAGE_ID,
    source: url(REMOTE),
  }).catch((e: unknown) => e);

  assert.ok(err instanceof GraphApiError, 'still a GraphApiError');
  assert.equal(err.code, 324, 'the Graph code is preserved');
  assert.equal(err.fbtraceId, 'TRACE324', 'the trace id is preserved');
  assert.equal(err.httpStatus, 400);
  assert.equal(err.message, original.message, 'the Graph line is not re-worded');
  assert.equal(err.cause, original, 'the original rides as cause');
  assert.equal(
    err.action?.category,
    'validation',
    `a URL Facebook could not turn into an image is a source problem, got ${String(err.action?.category)}`,
  );
  assert.equal(err.action?.retryable, false);
  assert.ok(
    err.action?.operatorText.includes(REMOTE),
    `the guidance names the URL: ${String(err.action?.operatorText)}`,
  );
  assert.match(err.action?.operatorText ?? '', /publicly reachable/);
  assert.doesNotMatch(err.action?.operatorText ?? '', /unclassified/i);
  assert.equal(fb.calls.length, 1, 'never re-sent');
});

test('url photo: a code-100 "could not fetch" refusal names the URL, not a generic bad argument', async () => {
  const fb = createFakeFbRequest();
  const original = toGraphApiError(
    { code: 100, message: '(#100) Could not fetch the image from the given url' },
    400,
  );
  fb.enqueue(fbErr(original));

  const err = await uploadUnpublishedPhotos(makeDeps(fb), {
    pageId: PAGE_ID,
    sources: [url(REMOTE)],
  }).catch((e: unknown) => e);

  assert.ok(err instanceof MultiPhotoUploadError);
  const cause = err.cause;
  assert.ok(cause instanceof GraphApiError);
  assert.equal(cause.code, 100);
  assert.equal(cause.action?.category, 'validation');
  assert.ok(
    cause.action?.operatorText.includes(REMOTE),
    `the guidance names the URL: ${String(cause.action?.operatorText)}`,
  );
  assert.equal(
    err.cleanup.unconfirmedUploads,
    undefined,
    'a clean fetch refusal created nothing, so no possible orphan is reported',
  );
});

test('url photo: an unrelated code-100 refusal and a local-file 324 keep the transport verdict', async (t) => {
  const fb = createFakeFbRequest();
  const unrelated = toGraphApiError(
    { code: 100, message: '(#100) Invalid parameter: targeting' },
    400,
  );
  fb.enqueue(fbErr(unrelated));
  const first = await uploadPhoto(makeDeps(fb), {
    pageId: PAGE_ID,
    source: url(REMOTE),
  }).catch((e: unknown) => e);
  assert.equal(first, unrelated, 'a refusal about another argument is not re-worded');

  const fx = await mediaFixture(t);
  await writeFile(join(fx.mediaDir, 'a.png'), pngBytes());
  const local = toGraphApiError(
    { code: 324, message: '(#324) Missing or invalid image file' },
    400,
  );
  fb.enqueue(fbErr(local));
  const second = await uploadPhoto(makeDeps(fb, { mediaDir: fx.mediaDir }), {
    pageId: PAGE_ID,
    source: { kind: 'local', path: 'a.png' },
  }).catch((e: unknown) => e);
  assert.equal(second, local, 'there is no URL to blame on the multipart path');
});

// ---------------------------------------------------------------------------
// extraParams — the pass-through bag cannot reopen a closed hole
// ---------------------------------------------------------------------------

test('CC-MEDIA-4: extraParams cannot smuggle a url/source past the scheme allowlist', async (t) => {
  const fx = await mediaFixture(t);
  await writeFile(join(fx.mediaDir, 'a.png'), pngBytes());
  const fb = createFakeFbRequest();
  const deps = makeDeps(fb, { mediaDir: fx.mediaDir });

  // The multipart path is where an unchecked `url` field would be most dangerous:
  // it would ride alongside the file bytes with no scheme validation at all.
  const err = await rejectsMediaSourceError(
    uploadPhoto(deps, {
      pageId: PAGE_ID,
      source: local('a.png'),
      extraParams: { url: 'http://169.254.169.254/latest/meta-data/' },
    }),
    'reserved_param',
  );
  assert.equal(err.source, 'url');

  await rejectsMediaSourceError(
    uploadPhoto(deps, {
      pageId: PAGE_ID,
      source: url(REMOTE),
      extraParams: { source: '/etc/passwd' },
    }),
    'reserved_param',
  );
  // ...and the multi-photo flow refuses it before the first upload, too.
  await rejectsMediaSourceError(
    uploadUnpublishedPhotos(deps, {
      pageId: PAGE_ID,
      sources: [url(REMOTE), local('a.png')],
      extraParams: { URL: 'http://evil.example' },
    }),
    'reserved_param',
  );
  assert.equal(fb.calls.length, 0, 'nothing reached the wire on any refusal');
});

test('extraParams cannot override the credentials or the published flag', async () => {
  const fb = createFakeFbRequest();
  for (const key of ['access_token', 'appsecret_proof', 'published', 'attached_media']) {
    await rejectsMediaSourceError(
      uploadPhoto(makeDeps(fb), {
        pageId: PAGE_ID,
        source: url(REMOTE),
        extraParams: { [key]: 'x' },
      }),
      'reserved_param',
    );
  }
  // Case-insensitive: Graph would accept the mixed-case spelling just the same.
  throwsMediaSourceError(() => {
    assertNoReservedPhotoParams({ Access_Token: 'x' });
  }, 'reserved_param');
  assertNoReservedPhotoParams(undefined);
  assertNoReservedPhotoParams({ scheduled_publish_time: 1 });
  assert.equal(fb.calls.length, 0);
});

test('extraParams: legitimate Graph params ride along on both protocols', async (t) => {
  const fx = await mediaFixture(t);
  await writeFile(join(fx.mediaDir, 'a.png'), pngBytes());
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ id: 'p1' })).enqueue(fbOk({ id: 'p2' }));
  const deps = makeDeps(fb, { mediaDir: fx.mediaDir });

  await uploadPhoto(deps, {
    pageId: PAGE_ID,
    source: url(REMOTE),
    extraParams: { scheduled_publish_time: 1893456000, no_story: true },
  });
  assert.deepEqual(jsonAt(fb, 0).body, {
    scheduled_publish_time: 1893456000,
    no_story: true,
    published: true,
    url: REMOTE,
  });

  await uploadPhoto(deps, {
    pageId: PAGE_ID,
    source: local('a.png'),
    extraParams: { scheduled_publish_time: 1893456000, no_story: false },
  });
  assert.deepEqual(multipartAt(fb, 1).fields, {
    scheduled_publish_time: '1893456000',
    no_story: 'false',
    published: 'true',
  });
});

// ---------------------------------------------------------------------------
// Multi-photo post — unpublished children for /feed attached_media
// ---------------------------------------------------------------------------

test('multi photo: each child is uploaded unpublished and returned in source order', async (t) => {
  const fx = await mediaFixture(t);
  await writeFile(join(fx.mediaDir, 'b.png'), pngBytes());
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ id: 'ph1' }))
    .enqueue(fbOk({ id: 'ph2' }))
    .enqueue(fbOk({ id: 'ph3' }));
  const progress: [number, number][] = [];

  const result = await uploadUnpublishedPhotos(makeDeps(fb, { mediaDir: fx.mediaDir }), {
    pageId: PAGE_ID,
    sources: [url(REMOTE), local('b.png'), url('https://cdn.example.com/c.jpg')],
    token: PAGE_TOKEN,
    onProgress: (done, total) => progress.push([done, total]),
  });

  assert.deepEqual(
    [...result.children],
    [
      { id: 'ph1', index: 0 },
      { id: 'ph2', index: 1 },
      { id: 'ph3', index: 2 },
    ],
  );
  // The ready-made /feed params — the feed call itself belongs to the tools layer.
  assert.deepEqual(result.attachedMedia, {
    'attached_media[0]': '{"media_fbid":"ph1"}',
    'attached_media[1]': '{"media_fbid":"ph2"}',
    'attached_media[2]': '{"media_fbid":"ph3"}',
  });
  assert.deepEqual(progress, [
    [1, 3],
    [2, 3],
    [3, 3],
  ]);

  assert.equal(fb.calls.length, 3, 'no /feed call is made here');
  assert.equal(jsonAt(fb, 0).body?.published, false);
  assert.equal(multipartAt(fb, 1).fields?.published, 'false');
  assert.equal(jsonAt(fb, 2).body?.published, false);
  // A caption belongs on the feed post, not on the children.
  assert.equal(jsonAt(fb, 0).body?.caption, undefined);
  assert.equal(multipartAt(fb, 1).fields?.caption, undefined);
  for (const call of fb.calls) {
    assert.equal(call.token, PAGE_TOKEN);
    assert.equal(call.path, '/777/photos');
  }
});

// ---------------------------------------------------------------------------
// Verify tools — which read can show an ambiguous photo write (wave 18)
// ---------------------------------------------------------------------------

test('verify tool: a published photo upload names facebook_list_posts on both protocols', async (t) => {
  // A lost response on a published photo leaves a Page post that only the
  // published listing can show; without `verifyTool` the transport's guidance
  // names no read at all, so the model cannot check before deciding to retry.
  const fx = await mediaFixture(t);
  await writeFile(join(fx.mediaDir, 'shot.png'), pngBytes());
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ id: 'photo-1', post_id: '777_1' })).enqueue(
    fbOk({ id: 'photo-2', post_id: '777_2' }),
  );
  const deps = makeDeps(fb, { mediaDir: fx.mediaDir });

  await uploadPhoto(deps, { pageId: PAGE_ID, source: url(REMOTE) });
  await uploadPhoto(deps, { pageId: PAGE_ID, source: local('shot.png') });

  assert.equal(jsonAt(fb, 0).verifyTool, 'facebook_list_posts');
  assert.equal(multipartAt(fb, 1).verifyTool, 'facebook_list_posts');
});

test('verify tool: a scheduled photo names facebook_list_scheduled_posts', async () => {
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ id: 'photo-1' }));

  await uploadPhoto(makeDeps(fb), {
    pageId: PAGE_ID,
    source: url(REMOTE),
    published: false,
    extraParams: { scheduled_publish_time: 1_900_000_000 },
  });

  assert.equal(jsonAt(fb, 0).verifyTool, 'facebook_list_scheduled_posts');
});

test('verify tool: a published no_story photo names no listing', async () => {
  // `no_story` publishes the photo WITHOUT a feed story, so facebook_list_posts
  // can never show it. Naming that listing tells the model to look where the
  // write cannot appear, read "absent", and retry into a duplicate photo.
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ id: 'photo-1' }))
    .enqueue(fbOk({ id: 'photo-2' }))
    .enqueue(fbOk({ id: 'photo-3' }));

  await uploadPhoto(makeDeps(fb), {
    pageId: PAGE_ID,
    source: url(REMOTE),
    extraParams: { no_story: true },
  });
  await uploadPhoto(makeDeps(fb), {
    pageId: PAGE_ID,
    source: url(REMOTE),
    extraParams: { no_story: 'true' },
  });
  // An explicit `no_story: false` still produces a story on the published listing.
  await uploadPhoto(makeDeps(fb), {
    pageId: PAGE_ID,
    source: url(REMOTE),
    extraParams: { no_story: false },
  });

  assert.equal(jsonAt(fb, 0).verifyTool, undefined);
  assert.equal(jsonAt(fb, 1).verifyTool, undefined);
  assert.equal(jsonAt(fb, 2).verifyTool, 'facebook_list_posts');
});

test('verify tool: a draft photo and an unpublished carousel child name no listing', async () => {
  // Regression coverage: no listing tool can show an unpublished photo, so the
  // guidance must stay neutral rather than name a read that can never show it.
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ id: 'photo-1' }))
    .enqueue(fbOk({ id: 'ph1' }))
    .enqueue(fbOk({ id: 'ph2' }));

  await uploadPhoto(makeDeps(fb), {
    pageId: PAGE_ID,
    source: url(REMOTE),
    published: false,
  });
  await uploadUnpublishedPhotos(makeDeps(fb), {
    pageId: PAGE_ID,
    sources: [url(REMOTE), url('https://cdn.example.com/c.jpg')],
  });

  assert.equal(fb.calls.length, 3);
  for (const call of fb.calls) assert.equal(call.verifyTool, undefined);
});

test('verify tool: an id-less 2xx on a published photo points at facebook_list_posts', async () => {
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({}, {}, 200));

  await assert.rejects(
    uploadPhoto(makeDeps(fb), { pageId: PAGE_ID, source: url(REMOTE) }),
    (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.equal(err.action?.category, 'ambiguous');
      assert.equal(err.action?.nextTool, 'facebook_list_posts');
      assert.match(err.action?.operatorText ?? '', /verify via facebook_list_posts/);
      return true;
    },
  );
});

test('verify tool: an id-less 2xx on a scheduled photo points at facebook_list_scheduled_posts', async () => {
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({}, {}, 200));

  await assert.rejects(
    uploadPhoto(makeDeps(fb), {
      pageId: PAGE_ID,
      source: url(REMOTE),
      published: false,
      extraParams: { scheduled_publish_time: 1_900_000_000 },
    }),
    (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.equal(err.action?.nextTool, 'facebook_list_scheduled_posts');
      return true;
    },
  );
});

test('verify tool: an id-less 2xx on an unpublished child names no listing', async () => {
  // Regression coverage: an unpublished child is on no listing.
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({}, {}, 200));

  await assert.rejects(
    uploadPhoto(makeDeps(fb), { pageId: PAGE_ID, source: url(REMOTE), published: false }),
    (err: unknown) => {
      assert.ok(err instanceof GraphApiError);
      assert.equal(err.action?.category, 'ambiguous');
      assert.equal(err.action?.nextTool, undefined);
      return true;
    },
  );
});

test('multi photo: a throwing progress sink never destroys children that already uploaded', async () => {
  // The tools layer bridges onProgress onto an MCP progress notification, which
  // can throw on a closing transport (CC-MCP-1). Reporting is advisory: a failed
  // notification must not delete children Graph has already accepted, and must
  // not blame a child that uploaded cleanly.
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ id: 'ph1' })).enqueue(fbOk({ id: 'ph2' }));
  const logger = makeLogger();
  let sinkCalls = 0;

  const result = await uploadUnpublishedPhotos(makeDeps(fb, { logger }), {
    pageId: PAGE_ID,
    sources: [url(REMOTE), url(REMOTE)],
    token: PAGE_TOKEN,
    onProgress: () => {
      sinkCalls += 1;
      throw new Error('progress notification failed');
    },
  });

  assert.equal(sinkCalls, 2, 'the sink is still offered every accepted child');
  assert.deepEqual(
    [...result.children],
    [
      { id: 'ph1', index: 0 },
      { id: 'ph2', index: 1 },
    ],
  );
  assert.equal(fb.calls.length, 2, 'no DELETE was issued against a successful child');
  assert.ok(
    logger.entries.some((e) => e.level === 'warn' && /progress sink/.test(e.msg)),
    'the contained throw is logged, never silently dropped',
  );
});

test('multi photo: a broken logger cannot turn a contained sink throw into a failure', async () => {
  // Containing the sink throw is pointless if the log call that records it can
  // fail the same upload — the rule `cleanupNeverThrows` already applies to the
  // cleanup pass (CC-MEDIA-10) holds for progress bookkeeping too.
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ id: 'ph1' })).enqueue(fbOk({ id: 'ph2' }));

  const result = await uploadUnpublishedPhotos(
    makeDeps(fb, { logger: makeBrokenLogger() }),
    {
      pageId: PAGE_ID,
      sources: [url(REMOTE), url(REMOTE)],
      onProgress: () => {
        throw new Error('progress notification failed');
      },
    },
  );

  assert.deepEqual([...result.children.map((child) => child.id)], ['ph1', 'ph2']);
  assert.equal(fb.calls.length, 2, 'no DELETE was issued against a successful child');
});

test('attachedMediaParams: indexed /feed params in child order; empty for no children', () => {
  assert.deepEqual(attachedMediaParams([]), {});
  assert.deepEqual(
    attachedMediaParams([
      { id: 'z', index: 5 },
      { id: 'a', index: 0 },
    ]),
    {
      'attached_media[0]': '{"media_fbid":"z"}',
      'attached_media[1]': '{"media_fbid":"a"}',
    },
  );
});

test('multi photo: an empty source list is refused before any call', async () => {
  const fb = createFakeFbRequest();
  await assert.rejects(
    uploadUnpublishedPhotos(makeDeps(fb), { pageId: PAGE_ID, sources: [] }),
    /at least one photo/,
  );
  assert.equal(fb.calls.length, 0);
});

test('CC-MEDIA-10: a locally invalid source aborts BEFORE the first upload — nothing to orphan', async (t) => {
  const fx = await mediaFixture(t);
  await writeFile(join(fx.mediaDir, 'a.png'), pngBytes());
  const fb = createFakeFbRequest();

  // The bad source is LAST: validating lazily would have uploaded two children
  // first and then had to clean them up.
  await rejectsMediaSourceError(
    uploadUnpublishedPhotos(makeDeps(fb, { mediaDir: fx.mediaDir }), {
      pageId: PAGE_ID,
      sources: [url(REMOTE), local('a.png'), local('../outside/nope.png')],
    }),
    'outside_media_dir',
  );
  assert.equal(fb.calls.length, 0, 'no child was created, so there is nothing to orphan');
});

test('CC-MEDIA-5/10: a source that vanishes between validation and upload is cleaned up', async (t) => {
  const fx = await mediaFixture(t);
  await writeFile(join(fx.mediaDir, 'a.png'), pngBytes());
  await writeFile(join(fx.mediaDir, 'b.png'), pngBytes());
  const fb = createFakeFbRequest();
  fb.on((req) => req.protocol === 'multipart', fbOk({ id: 'ph1' }), 1).on(
    (req) => req.method === 'DELETE',
    fbOk({ success: true }),
  );

  // Delete the second file while the first upload is in flight — i.e. after
  // phase-1 validation accepted it. The read at upload time must catch it.
  const fbRequest: FbRequestFn = async <T = unknown>(
    req: FbRequest,
  ): Promise<FbResponse<T>> => {
    const res = await fb.fn<T>(req);
    await rm(join(fx.mediaDir, 'b.png'), { force: true });
    return res;
  };
  const deps: MediaPhotoDeps = { fbRequest, mediaDir: fx.mediaDir };

  const err = await rejectsMultiPhotoError(
    uploadUnpublishedPhotos(deps, {
      pageId: PAGE_ID,
      sources: [local('a.png'), local('b.png')],
    }),
  );
  assert.equal(err.failedIndex, 1);
  const cause: unknown = err.cause;
  assert.ok(cause instanceof MediaSourceError);
  assert.deepEqual([...err.cleanup.deleted], ['ph1'], 'the first child was cleaned up');
  assert.deepEqual([...err.cleanup.orphans], []);
});

test('CC-MEDIA-10: a mid-flight failure deletes the children already uploaded', async () => {
  const fb = createFakeFbRequest();
  const boom = new GraphApiError('(#4) Application request limit reached', {
    code: 4,
    httpStatus: 400,
  });
  fb.enqueue(fbOk({ id: 'ph1' }))
    .enqueue(fbOk({ id: 'ph2' }))
    .enqueue(fbErr(boom))
    .enqueue(fbOk({ success: true }))
    .enqueue(fbOk({ success: true }));
  const logger = makeLogger();

  const err = await rejectsMultiPhotoError(
    uploadUnpublishedPhotos(makeDeps(fb, { logger }), {
      pageId: PAGE_ID,
      sources: [url(REMOTE), url(REMOTE), url(REMOTE), url(REMOTE)],
      token: PAGE_TOKEN,
    }),
  );

  assert.equal(err.failedIndex, 2, 'zero-based index of the source that failed');
  assert.equal(err.total, 4);
  assert.equal(err.cause, boom, 'the ORIGINAL error is preserved as the cause');
  assert.match(err.message, /photo 3 of 4 failed to upload/);
  assert.match(err.message, /Application request limit reached/);
  assert.doesNotMatch(err.message, /could NOT be cleaned up/, 'nothing was left behind');

  assert.deepEqual([...err.cleanup.deleted], ['ph1', 'ph2']);
  assert.deepEqual([...err.cleanup.orphans], []);
  assert.deepEqual([...err.cleanup.failures], []);
  assert.equal(describeOrphans(err.cleanup), undefined);

  // One DELETE per child, on the graph host, with the Page token and the
  // independent cleanup timeout.
  assert.equal(fb.calls.length, 5);
  for (const [i, id] of ['ph1', 'ph2'].entries()) {
    const del = jsonAt(fb, 3 + i);
    assert.equal(del.method, 'DELETE');
    assert.equal(del.host, 'graph');
    assert.equal(del.path, `/${id}`);
    assert.equal(del.token, PAGE_TOKEN);
    assert.equal(del.timeoutMs, DEFAULT_CLEANUP_TIMEOUT_MS);
  }
  assert.equal(
    logger.entries.some((e) => e.level === 'warn'),
    false,
    'a complete cleanup is not a warning',
  );
});

test('CC-MEDIA-10: a cleanup failure reports the orphan IDs and never masks the original error', async () => {
  const fb = createFakeFbRequest();
  const boom = new GraphApiError('(#100) Invalid photo', { code: 100, httpStatus: 400 });
  const deleteFailed = new Error('DELETE ph1 exploded');
  fb.enqueue(fbOk({ id: 'ph1' }))
    .enqueue(fbOk({ id: 'ph2' }))
    .enqueue(fbErr(boom)) // the third upload fails...
    .enqueue(fbErr(deleteFailed)) // ...cleaning up ph1 fails...
    .enqueue(fbOk({ success: false })); // ...and Graph refuses to delete ph2.
  const logger = makeLogger();

  const err = await rejectsMultiPhotoError(
    uploadUnpublishedPhotos(makeDeps(fb, { logger }), {
      pageId: PAGE_ID,
      sources: [url(REMOTE), url(REMOTE), url(REMOTE)],
      cleanupTimeoutMs: 2500,
    }),
  );

  // The original error is the cause, and its text LEADS the message.
  assert.equal(err.cause, boom);
  assert.match(err.message, /Invalid photo/);
  assert.ok(
    err.message.indexOf('Invalid photo') < err.message.indexOf('ph1'),
    'the original failure leads; the orphan note follows',
  );
  assert.doesNotMatch(err.message, /exploded/, 'the cleanup error does not take over');

  // Every ID that survived is reported, in order, with a per-ID reason.
  assert.deepEqual([...err.cleanup.deleted], []);
  assert.deepEqual([...err.cleanup.orphans], ['ph1', 'ph2']);
  assert.deepEqual(
    [...err.cleanup.failures],
    [
      { id: 'ph1', message: 'DELETE ph1 exploded' },
      { id: 'ph2', message: 'Graph did not confirm the delete (success: false)' },
    ],
  );
  assert.match(err.message, /ph1, ph2/);
  assert.match(describeOrphans(err.cleanup) ?? '', /delete them manually/);

  // The failing DELETE did not stop the pass — ph2 was still attempted.
  assert.equal(fb.calls.length, 5);
  assert.equal(jsonAt(fb, 4).path, '/ph2');
  assert.equal(jsonAt(fb, 3).timeoutMs, 2500, 'the caller cleanup timeout is honored');
  const warned = logger.entries.find((e) => e.level === 'warn');
  assert.ok(warned, 'an incomplete cleanup is logged as a warning');
  assert.deepEqual(warned.fields?.orphans, ['ph1', 'ph2']);
});

test('CC-MEDIA-10: cleanup runs with its own signal, so a cancelled upload still cleans up', async () => {
  const fb = createFakeFbRequest();
  const controller = new AbortController();
  fb.enqueue(fbOk({ id: 'ph1' }))
    .enqueue(fbErr(new Error('This operation was aborted')))
    .enqueue(fbOk({ success: true }));
  controller.abort();

  const err = await rejectsMultiPhotoError(
    uploadUnpublishedPhotos(makeDeps(fb), {
      pageId: PAGE_ID,
      sources: [url(REMOTE), url(REMOTE)],
      signal: controller.signal,
    }),
  );

  // The uploads carried the caller's signal...
  assert.equal(jsonAt(fb, 0).signal, controller.signal);
  assert.equal(jsonAt(fb, 1).signal, controller.signal);
  // ...but the DELETE must NOT, or an aborted upload would orphan every child.
  const del = jsonAt(fb, 2);
  assert.equal(del.method, 'DELETE');
  assert.equal(del.signal, undefined);
  assert.deepEqual([...err.cleanup.deleted], ['ph1']);
  assert.deepEqual([...err.cleanup.orphans], []);
});

test('CC-MEDIA-10: a cleanup pass that itself throws still surfaces the original error', async () => {
  const fb = createFakeFbRequest();
  const boom = new GraphApiError('(#506) Duplicate post', { code: 506, httpStatus: 400 });
  fb.enqueue(fbOk({ id: 'ph1' }))
    .enqueue(fbErr(boom))
    .enqueue(fbOk({ success: true }));

  // A broken log sink makes the cleanup pass itself throw, after the DELETE.
  const err = await rejectsMultiPhotoError(
    uploadUnpublishedPhotos(makeDeps(fb, { logger: makeBrokenLogger() }), {
      pageId: PAGE_ID,
      sources: [url(REMOTE), url(REMOTE)],
    }),
  );

  assert.equal(err.cause, boom, 'the cleanup crash did not become the reported error');
  assert.match(err.message, /Duplicate post/);
  // We cannot know what survived, so we over-report rather than under-report.
  assert.deepEqual([...err.cleanup.orphans], ['ph1']);
  assert.deepEqual([...err.cleanup.deleted], []);
  assert.match(err.cleanup.failures[0]?.message ?? '', /cleanup pass failed/);
  assert.equal(fb.calls.length, 3, 'the DELETE was still attempted');
});

test('CC-MEDIA-10: a first-photo failure has nothing to clean up', async () => {
  const fb = createFakeFbRequest();
  const boom = new GraphApiError('(#200) Permissions error', {
    code: 200,
    httpStatus: 403,
  });
  fb.enqueue(fbErr(boom));

  const err = await rejectsMultiPhotoError(
    uploadUnpublishedPhotos(makeDeps(fb), {
      pageId: PAGE_ID,
      sources: [url(REMOTE), url(REMOTE)],
    }),
  );
  assert.equal(err.failedIndex, 0);
  assert.equal(err.cause, boom);
  assert.equal(err.cleanup, EMPTY_ORPHAN_REPORT);
  assert.equal(fb.calls.length, 1, 'no DELETE is issued when no child exists');
});

test('multi photo: a child response without an id is ambiguous and triggers cleanup', async () => {
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ id: 'ph1' }))
    .enqueue(fbOk({ post_id: 'nope' })) // 2xx, but no photo id
    .enqueue(fbOk({ success: true }));

  const err = await rejectsMultiPhotoError(
    uploadUnpublishedPhotos(makeDeps(fb), {
      pageId: PAGE_ID,
      sources: [url(REMOTE), url(REMOTE)],
    }),
  );
  const cause: unknown = err.cause;
  assert.ok(cause instanceof GraphApiError);
  assert.equal(cause.action?.category, 'ambiguous');
  assert.deepEqual([...err.cleanup.deleted], ['ph1']);
});

// ---------------------------------------------------------------------------
// cleanupUnpublishedPhotos / describeOrphans — the operator-facing contract
// ---------------------------------------------------------------------------

test('cleanupUnpublishedPhotos: an empty id list makes no call and returns the empty report', async () => {
  const fb = createFakeFbRequest();
  const report = await cleanupUnpublishedPhotos(makeDeps(fb), []);
  assert.equal(report, EMPTY_ORPHAN_REPORT);
  assert.equal(fb.calls.length, 0);
  assert.ok(
    Object.isFrozen(EMPTY_ORPHAN_REPORT),
    'the shared singleton cannot be mutated',
  );
  assert.ok(Object.isFrozen(EMPTY_ORPHAN_REPORT.orphans));
});

test('cleanupUnpublishedPhotos: never throws and attempts every id, even after a failure', async () => {
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ success: true }))
    .enqueue(fbErr(new Error('boom')))
    .enqueue(fbOk({ success: false }))
    .enqueue(fbOk({}));
  const logger = makeLogger();

  const report = await cleanupUnpublishedPhotos(makeDeps(fb, { logger }), [
    'a',
    'b',
    'c',
    'd',
  ]);

  assert.deepEqual([...report.deleted], ['a', 'd'], 'a bodyless 2xx counts as deleted');
  assert.deepEqual([...report.orphans], ['b', 'c']);
  assert.deepEqual(
    report.failures.map((f) => f.id),
    ['b', 'c'],
    'failures line up with orphans, in the same order',
  );
  assert.equal(report.failures[0]?.message, 'boom');
  assert.equal(fb.calls.length, 4, 'a failure does not stop the pass');
  assert.equal(logger.entries.filter((e) => e.level === 'warn').length, 1);
});

test('cleanupUnpublishedPhotos: a fully successful pass logs at debug, not warn', async () => {
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ success: true }));
  const logger = makeLogger();

  const report = await cleanupUnpublishedPhotos(makeDeps(fb, { logger }), ['a'], {
    token: PAGE_TOKEN,
    timeoutMs: 1234,
  });

  assert.deepEqual([...report.orphans], []);
  assert.equal(logger.entries.length, 1);
  assert.equal(logger.entries[0]?.level, 'debug');
  const del = jsonAt(fb, 0);
  assert.equal(del.token, PAGE_TOKEN);
  assert.equal(del.timeoutMs, 1234);
});

test('cleanupUnpublishedPhotos: an explicitly passed signal is used for the DELETEs', async () => {
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ success: true }));
  const controller = new AbortController();

  await cleanupUnpublishedPhotos(makeDeps(fb), ['a'], { signal: controller.signal });
  assert.equal(jsonAt(fb, 0).signal, controller.signal, 'the caller opts in explicitly');
});

test('cleanupUnpublishedPhotos: a non-boolean success flag is a decline, not a delete', async () => {
  const fb = createFakeFbRequest();
  // Graph is not disciplined about JSON types on this edge: a REFUSED delete can
  // arrive as the string "false", as `0`, or as `null`. Every one of those is
  // Facebook saying the photo is still there, so every one of them belongs in
  // `orphans` — telling the operator the Page was cleaned up while unpublished
  // media survives is exactly the failure CC-MEDIA-10 exists to prevent.
  fb.enqueue(fbOk({ success: 'false' }))
    .enqueue(fbOk({ success: 0 }))
    .enqueue(fbOk({ success: null }))
    .enqueue(fbOk({ success: true }));

  const report = await cleanupUnpublishedPhotos(makeDeps(fb), ['a', 'b', 'c', 'd']);

  assert.deepEqual([...report.deleted], ['d'], 'only an explicit true confirms');
  assert.deepEqual([...report.orphans], ['a', 'b', 'c']);
  assert.deepEqual(
    report.failures.map((f) => f.id),
    ['a', 'b', 'c'],
    'failures line up with orphans',
  );
  assert.match(describeOrphans(report) ?? '', /3 unpublished photo\(s\)/);
});

test('describeOrphans: silent on a clean report, actionable when something survived', () => {
  assert.equal(describeOrphans({ deleted: ['a'], orphans: [], failures: [] }), undefined);
  const note = describeOrphans({
    deleted: [],
    orphans: ['x', 'y'],
    failures: [
      { id: 'x', message: 'nope' },
      { id: 'y', message: 'nope' },
    ],
  });
  assert.match(note ?? '', /2 unpublished photo\(s\)/);
  assert.match(note ?? '', /DELETE \/\{photo-id\}/);
  assert.match(note ?? '', /x, y/);
});

// ---------------------------------------------------------------------------
// Wave 11 — ambiguous child uploads, read-time races, ISO-BMFF brands
// ---------------------------------------------------------------------------

/** A C2-ambiguous upload failure, shaped exactly as the http client throws it. */
function ambiguousUploadFailure(detail: string): GraphApiError {
  return new GraphApiError(
    `ambiguous write outcome (${detail}) — do NOT retry; verify first`,
    { code: 0, httpStatus: 502, action: ambiguousWriteAction({ detail }) },
  );
}

test('CC-MEDIA-10: an AMBIGUOUS child upload is reported as a possible orphan, not as "nothing left behind"', async () => {
  const fb = createFakeFbRequest();
  const boom = ambiguousUploadFailure('HTTP 502 on POST');
  fb.enqueue(fbOk({ id: 'ph1' }))
    .enqueue(fbOk({ id: 'ph2' }))
    .enqueue(fbErr(boom)) // photo 3 of 5: may have landed, id never returned
    .enqueue(fbOk({ success: true }))
    .enqueue(fbOk({ success: true }));

  const err = await rejectsMultiPhotoError(
    uploadUnpublishedPhotos(makeDeps(fb), {
      pageId: PAGE_ID,
      sources: [url(REMOTE), url(REMOTE), url(REMOTE), url(REMOTE), url(REMOTE)],
    }),
  );

  // Exactly children 1-2 are deleted; photos 4-5 were never attempted.
  assert.deepEqual([...err.cleanup.deleted], ['ph1', 'ph2']);
  assert.deepEqual([...err.cleanup.orphans], []);
  assert.equal(fb.calls.length, 5);
  // ...but photo 3 itself may exist, and the operator must be told so.
  assert.deepEqual(
    (err.cleanup.unconfirmedUploads ?? []).map((u) => u.index),
    [2],
    'the ambiguous upload is carried on the report',
  );
  const note = describeOrphans(err.cleanup);
  assert.ok(note !== undefined, 'a possible orphan is not "nothing was left behind"');
  assert.match(note, /photo 3/);
  assert.match(note, /photo library/);
  assert.match(err.message, /photo 3 of 5 failed to upload/);
  assert.match(err.message, /may exist/);
});

test('CC-MEDIA-10: an id-less 2xx on the FIRST child is still a possible orphan (no DELETE possible)', async () => {
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({})); // 2xx, no photo id: ambiguous

  const err = await rejectsMultiPhotoError(
    uploadUnpublishedPhotos(makeDeps(fb), {
      pageId: PAGE_ID,
      sources: [url(REMOTE), url(REMOTE)],
    }),
  );
  assert.equal(err.failedIndex, 0);
  assert.equal(fb.calls.length, 1, 'nothing to DELETE by id');
  assert.deepEqual(
    (err.cleanup.unconfirmedUploads ?? []).map((u) => u.index),
    [0],
  );
  assert.match(describeOrphans(err.cleanup) ?? '', /photo 1/);
});

test('CC-MEDIA-10: a non-Graph fault mid-upload (cancellation) is a possible orphan too', async () => {
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ id: 'ph1' }))
    .enqueue(fbErr(new Error('This operation was aborted')))
    .enqueue(fbOk({ success: true }));

  const err = await rejectsMultiPhotoError(
    uploadUnpublishedPhotos(makeDeps(fb), {
      pageId: PAGE_ID,
      sources: [url(REMOTE), url(REMOTE)],
    }),
  );
  assert.deepEqual([...err.cleanup.deleted], ['ph1']);
  assert.deepEqual(
    (err.cleanup.unconfirmedUploads ?? []).map((u) => u.index),
    [1],
  );
  assert.match(describeOrphans(err.cleanup) ?? '', /photo 2/);
});

test('CC-MEDIA-10: a clean Graph refusal or a local read failure adds no possible-orphan note', async (t) => {
  const fb = createFakeFbRequest();
  fb.enqueue(fbOk({ id: 'ph1' }))
    .enqueue(
      fbErr(new GraphApiError('(#100) Invalid photo', { code: 100, httpStatus: 400 })),
    )
    .enqueue(fbOk({ success: true }));
  const refused = await rejectsMultiPhotoError(
    uploadUnpublishedPhotos(makeDeps(fb), {
      pageId: PAGE_ID,
      sources: [url(REMOTE), url(REMOTE)],
    }),
  );
  assert.equal(refused.cleanup.unconfirmedUploads, undefined);
  assert.equal(describeOrphans(refused.cleanup), undefined);

  // A file that vanished before its upload never reached the wire.
  const fx = await mediaFixture(t);
  await writeFile(join(fx.mediaDir, 'a.png'), pngBytes());
  const fb2 = createFakeFbRequest();
  const fbRequest: FbRequestFn = async <T = unknown>(
    req: FbRequest,
  ): Promise<FbResponse<T>> => {
    const res = await fb2.fn<T>(req);
    await rm(join(fx.mediaDir, 'a.png'), { force: true });
    return res;
  };
  fb2.enqueue(fbOk({ id: 'ph1' })).enqueue(fbOk({ success: true }));
  const vanished = await rejectsMultiPhotoError(
    uploadUnpublishedPhotos(
      { fbRequest, mediaDir: fx.mediaDir },
      { pageId: PAGE_ID, sources: [url(REMOTE), local('a.png')] },
    ),
  );
  assert.ok(vanished.cause instanceof MediaSourceError);
  assert.equal(vanished.cleanup.unconfirmedUploads, undefined);
  assert.equal(describeOrphans(vanished.cleanup), undefined);
});

test('describeOrphans: names both the orphan ids and the unconfirmed uploads', () => {
  const note = describeOrphans({
    deleted: [],
    orphans: ['x'],
    failures: [{ id: 'x', message: 'nope' }],
    unconfirmedUploads: [{ index: 3, message: 'HTTP 503' }],
  });
  assert.match(note ?? '', /x\./);
  assert.match(note ?? '', /photo 4/);
});

test('CC-MEDIA-5: a file swapped for a FIFO after validation is refused, not read forever', async (t) => {
  if (process.platform === 'win32') {
    t.skip('no FIFOs on win32');
    return;
  }
  const fx = await mediaFixture(t);
  const a = join(fx.mediaDir, 'a.png');
  const b = join(fx.mediaDir, 'b.png');
  await writeFile(a, pngBytes());
  await writeFile(b, pngBytes());
  // If the read blocked on the FIFO, give it a writer so the process can exit.
  t.after(async () => {
    try {
      const w = await open(b, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
      await w.close();
    } catch {
      // No blocked reader (ENXIO) — nothing to unblock.
    }
  });
  const fb = createFakeFbRequest();
  fb.on((req) => req.protocol === 'multipart', fbOk({ id: 'ph1' }), 1).on(
    (req) => req.method === 'DELETE',
    fbOk({ success: true }),
  );
  const fbRequest: FbRequestFn = async <T = unknown>(
    req: FbRequest,
  ): Promise<FbResponse<T>> => {
    const res = await fb.fn<T>(req);
    if (req.method === 'POST') {
      await rm(b, { force: true });
      execFileSync('mkfifo', [b]);
    }
    return res;
  };

  let timer: NodeJS.Timeout | undefined;
  const hung = new Promise<'hung'>((resolve) => {
    timer = setTimeout(() => {
      resolve('hung');
    }, 2000);
  });
  const outcome = await Promise.race([
    uploadUnpublishedPhotos(
      { fbRequest, mediaDir: fx.mediaDir },
      { pageId: PAGE_ID, sources: [local('a.png'), local('b.png')] },
    ).then(
      () => 'resolved' as const,
      (err: unknown) => err,
    ),
    hung,
  ]);
  clearTimeout(timer);
  assert.notEqual(outcome, 'hung', 'the upload blocked forever opening a FIFO');
  assert.ok(outcome instanceof MultiPhotoUploadError, `got ${String(outcome)}`);
  const cause: unknown = outcome.cause;
  assert.ok(cause instanceof MediaSourceError);
  assert.equal(cause.reason, 'not_a_regular_file');
  assert.deepEqual([...outcome.cleanup.deleted], ['ph1']);
});

test('readLocalPhoto: a file that grows after the size check never buffers past the ceiling', async (t) => {
  const fx = await mediaFixture(t);
  const target = join(fx.mediaDir, 'grow.png');
  await writeFile(target, pngBytes('ab')); // 10 bytes, under the 16-byte ceiling

  // Grow the file right after the handle's own size check, i.e. in the window
  // between that check and the read.
  const probe = await open(target, 'r');
  const proto = Object.getPrototypeOf(probe) as {
    stat: (...a: unknown[]) => Promise<unknown>;
  };
  await probe.close();
  const original = proto.stat;
  proto.stat = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    const info = await original.apply(this, args);
    appendFileSync(target, new Uint8Array(100));
    return info;
  };
  try {
    await rejectsMediaSourceError(
      readLocalPhoto('grow.png', { mediaDir: fx.mediaDir, maxBytes: 16 }),
      'file_too_large',
    );
  } finally {
    proto.stat = original;
  }
});

test('readLocalPhoto: a file of exactly the ceiling is accepted, one byte more is not', async (t) => {
  const fx = await mediaFixture(t);
  await writeFile(join(fx.mediaDir, 'exact.png'), pngBytes('12345678')); // 16 bytes
  const file = await readLocalPhoto('exact.png', { mediaDir: fx.mediaDir, maxBytes: 16 });
  assert.equal(file.bytes, 16);
  assert.equal(file.data.byteLength, 16);
  await rejectsMediaSourceError(
    readLocalPhoto('exact.png', { mediaDir: fx.mediaDir, maxBytes: 15 }),
    'file_too_large',
  );
});

test('detectPhotoContentType: an ISO-BMFF VIDEO is not labelled image/heic — the ftyp brand decides', () => {
  const box = (brand: string): Uint8Array =>
    Uint8Array.from([
      0,
      0,
      0,
      0x18,
      ...Buffer.from(`ftyp${brand}`, 'latin1'),
      0,
      0,
      0,
      0,
    ]);
  // An MP4 / QuickTime file renamed to .jpg must not travel as a HEIC image.
  assert.equal(detectPhotoContentType(box('isom'), 'clip.jpg'), 'image/jpeg');
  assert.equal(detectPhotoContentType(box('mp42'), 'clip.bin'), FALLBACK_CONTENT_TYPE);
  assert.equal(detectPhotoContentType(box('qt  '), 'clip.bin'), FALLBACK_CONTENT_TYPE);
  // Real HEIF brands still sniff as HEIC whatever the extension says.
  for (const brand of ['heic', 'heix', 'hevc', 'mif1', 'msf1']) {
    assert.equal(detectPhotoContentType(box(brand), 'x.jpg'), 'image/heic', brand);
  }
});

// ---------------------------------------------------------------------------
// Wave 21 — containment and cleanup truthfulness
// ---------------------------------------------------------------------------

test('CC-MEDIA-5: with a symlinked FB_MEDIA_DIR, a missing file under it is file_not_found, not outside', async (t) => {
  const fx = await mediaFixture(t);
  // FB_MEDIA_DIR configured through a symlink (macOS `/tmp`, `/var` and many
  // home-directory layouts are exactly this). An absolute path spelled under the
  // configured directory IS inside the allowlist — a missing file there must be
  // reported as missing, not as a path that escapes the directory.
  const linked = join(fx.root, 'media-link');
  await symlink(fx.mediaDir, linked, 'junction');
  await writeFile(join(fx.mediaDir, 'real.png'), pngBytes());

  // Control: an existing file spelled through the link resolves fine.
  const ok = await resolveLocalMediaPath(join(linked, 'real.png'), { mediaDir: linked });
  assert.equal(ok.path, join(fx.mediaDir, 'real.png'));

  const err = await rejectsMediaSourceError(
    resolveLocalMediaPath(join(linked, 'nope.png'), { mediaDir: linked }),
    'file_not_found',
  );
  assert.doesNotMatch(err.message, /outside/);
  // A missing path genuinely outside is still reported as the boundary.
  await rejectsMediaSourceError(
    resolveLocalMediaPath(join(fx.outside, 'nope.png'), { mediaDir: linked }),
    'outside_media_dir',
  );
});

test('cleanupUnpublishedPhotos: a bare false / "false" / null body is a decline, not a delete', async () => {
  const fb = createFakeFbRequest();
  // Graph answers some DELETEs with a bare JSON boolean instead of
  // `{success:…}`. A bare `false` is Facebook refusing the delete; counting it
  // as confirmed tells the operator an orphan is gone while it survives.
  fb.enqueue(fbOk(false))
    .enqueue(fbOk('false'))
    .enqueue(fbOk(null))
    .enqueue(fbOk(true))
    .enqueue(fbOk(undefined));

  const report = await cleanupUnpublishedPhotos(makeDeps(fb), ['a', 'b', 'c', 'd', 'e']);

  assert.deepEqual(
    [...report.deleted],
    ['d', 'e'],
    'bare true and a bodiless 2xx confirm',
  );
  assert.deepEqual([...report.orphans], ['a', 'b', 'c']);
  assert.match(report.failures[0]?.message ?? '', /false/);
});

test('CC-MEDIA-5: a directory swapped for an outbound symlink after validation is never uploaded from', async (t) => {
  const fx = await mediaFixture(t);
  await writeFile(join(fx.mediaDir, 'a.png'), pngBytes('first'));
  await mkdir(join(fx.mediaDir, 'sub'));
  await writeFile(join(fx.mediaDir, 'sub', 'b.png'), pngBytes('allowed'));
  await writeFile(join(fx.outside, 'b.png'), pngBytes('SECRET-OUTSIDE'));
  const fb = createFakeFbRequest();
  fb.on((req) => req.protocol === 'multipart', fbOk({ id: 'ph1' })).on(
    (req) => req.method === 'DELETE',
    fbOk({ success: true }),
  );

  // While the first upload is in flight (after phase-1 validation accepted
  // `sub/b.png`), the INTERMEDIATE directory is swapped for a symlink pointing
  // outside FB_MEDIA_DIR. O_NOFOLLOW guards only the final path component, so
  // the read must re-prove containment itself.
  let swapped = false;
  const fbRequest: FbRequestFn = async <T = unknown>(
    req: FbRequest,
  ): Promise<FbResponse<T>> => {
    const res = await fb.fn<T>(req);
    if (!swapped) {
      swapped = true;
      await rm(join(fx.mediaDir, 'sub'), { recursive: true, force: true });
      await symlink(fx.outside, join(fx.mediaDir, 'sub'), 'junction');
    }
    return res;
  };
  const deps: MediaPhotoDeps = { fbRequest, mediaDir: fx.mediaDir };

  let outcome: unknown;
  try {
    await uploadUnpublishedPhotos(deps, {
      pageId: PAGE_ID,
      sources: [local('a.png'), local('sub/b.png')],
    });
    outcome = 'resolved';
  } catch (err) {
    outcome = err;
  }
  const secret = Buffer.from('SECRET-OUTSIDE', 'utf8');
  const leaked = fb.calls.some(
    (call) =>
      call.protocol === 'multipart' &&
      call.files.some((f) => Buffer.from(f.data).includes(secret)),
  );
  assert.equal(leaked, false, 'bytes from outside FB_MEDIA_DIR reached the wire');
  assert.ok(
    outcome instanceof MultiPhotoUploadError,
    `expected MultiPhotoUploadError, got ${String(outcome)}`,
  );
  const cause: unknown = outcome.cause;
  assert.ok(cause instanceof MediaSourceError);
  assert.equal(cause.reason, 'outside_media_dir');
  assert.deepEqual([...outcome.cleanup.deleted], ['ph1']);
});
