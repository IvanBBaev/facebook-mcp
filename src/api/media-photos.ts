// Photo publishing flows for a Facebook Page (task V04, `api` layer).
//
// Two flows live here, both riding an INJECTED `FbRequestFn` (no ambient state,
// no module-level singletons, no AsyncLocalStorage — C14):
//
//   * SINGLE photo  — `uploadPhoto` POSTs one photo to `/{page-id}/photos` with a
//     caption and `published:true`, which creates the Page post in one call.
//   * MULTI photo   — `uploadUnpublishedPhotos` POSTs each photo to
//     `/{page-id}/photos` with `published:false`, collecting the unpublished
//     photo IDs. The caller (the `posts` tool package, V03) then references those
//     IDs as `attached_media` on a follow-up `/{page-id}/feed` call. The feed
//     call deliberately does NOT live here: this module owns media, not posts.
//
// Design decisions (justified against the corpus):
//
//   * ORPHAN DISCIPLINE (CC-MEDIA-5 / CC-MEDIA-10). Unpublished children created
//     before a mid-flight failure are invisible on the Page but still consume the
//     Page's photo library, so they are orphans. Three mitigations, in order:
//       1. every source is validated LOCALLY before the first byte is uploaded,
//          so a bad URL or an unreadable file can never orphan anything;
//       2. on a mid-flight failure the already-created children are deleted
//          best-effort (`DELETE /{photo-id}`);
//       3. whatever could not be deleted is ALWAYS reported by ID, on the thrown
//          {@link MultiPhotoUploadError}, so the operator can remove it by hand.
//     A cleanup failure never masks the original error: the original rides as
//     `cause` and its message leads the thrown message.
//   * CLEANUP IS NOT ABORTABLE BY THE CALLER'S SIGNAL. If the upload failed
//     *because* the call was cancelled, reusing that signal for the DELETEs would
//     turn every child into an orphan. Cleanup therefore runs without the
//     caller's signal, bounded instead by its own per-request timeout.
//   * LOCAL FILES ARE OFF BY DEFAULT (C11). A local path is readable only when
//     `mediaDir` (`FB_MEDIA_DIR`) is configured AND the file's REALPATH is
//     contained in the realpath of `mediaDir`, compared on a path-separator
//     boundary so a sibling directory (`/media-evil`) can never pass as inside
//     `/media`. Symlinks are resolved before the comparison, so a link inside the
//     allowlisted directory cannot escape it (CC-MEDIA-5).
//   * REMOTE SOURCES ARE HANDED TO META, NEVER FETCHED HERE. A `url` source is
//     passed through as the `url` param and Meta fetches it; this process makes
//     no request to it. `https:` is the only accepted scheme — `http:`, `file:`,
//     `data:` and everything else are refused, so no caller can steer this code
//     path into reading a local resource or proxying a request (SSRF hardening,
//     CC-MEDIA-4). The pass-through `extraParams` bag cannot reopen that hole:
//     the params this module owns — `url`/`source`, `published`, `access_token`,
//     `appsecret_proof`, `attached_media` — are refused there
//     ({@link RESERVED_PHOTO_PARAMS}), before any byte is uploaded.
//   * NO FORMAT VALIDATION (C10). Content type is a best-effort hint sniffed from
//     magic numbers (falling back to the extension, then to
//     `application/octet-stream`); Meta remains the source of truth on what it
//     accepts, and its error is surfaced with the filename attached.
//
// Layer rules: `api` may import only from `core`. No zod, no `defineTool`, no
// result shaping — those belong to the `tools` layer (V03), which consumes the
// signatures below.

import { access, open, realpath, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, extname, isAbsolute, resolve as resolvePath, sep } from 'node:path';

import { GraphApiError, ambiguousWriteAction } from '../core/index.js';
import type {
  FbRequestFn,
  JsonRequest,
  Logger,
  MultipartRequest,
  ParamValue,
} from '../core/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The Page edge that accepts a photo upload. */
export const PHOTOS_EDGE = 'photos';

/** The multipart field name Graph reads the raw photo bytes from. */
export const PHOTO_BYTES_FIELD = 'source';

/**
 * Local read ceiling, a MEMORY guard (the whole file is buffered for the
 * multipart body) — NOT a statement about Meta's limits, which are lower and
 * enforced by Meta (C10). Override per call via {@link LocalMediaOptions.maxBytes}.
 */
export const DEFAULT_MAX_LOCAL_BYTES = 25 * 1024 * 1024;

/**
 * Per-request timeout for a best-effort orphan DELETE. Bounded independently of
 * the upload so cleanup cannot hang a shutdown path.
 */
export const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;

/** The only accepted remote scheme; everything else is refused. */
export const ALLOWED_REMOTE_SCHEME = 'https:';

/** Content type used when neither magic numbers nor the extension identify the bytes. */
export const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

/**
 * Graph params a caller may NOT smuggle in through `extraParams` (compared
 * case-insensitively):
 *
 *   * `url` / `source` ARE the media. Accepting them would let a caller hand
 *     Meta a fetch target that never passed {@link resolveRemoteMediaUrl}, which
 *     is exactly the `http:`/`file:`/`data:` hole the scheme allowlist closes
 *     (CC-MEDIA-4). It matters most on the multipart path, where an unvalidated
 *     `url` field would ride alongside the file bytes.
 *   * `published` is owned by the flow — the multi-photo flow depends on its
 *     children staying unpublished.
 *   * `attached_media` belongs to the follow-up `/feed` call, not to `/photos`.
 *   * `access_token` / `appsecret_proof` are credentials owned by the HTTP
 *     client and the per-Page resolver (C1/C3); a caller-supplied one would act
 *     as somebody else.
 */
export const RESERVED_PHOTO_PARAMS: readonly string[] = [
  'url',
  'source',
  'published',
  'attached_media',
  'access_token',
  'appsecret_proof',
];

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * Where one photo's bytes come from.
 *
 * * `local` — a path interpreted against `mediaDir`; relative paths resolve
 *   inside it. Requires `mediaDir` to be configured (C11).
 * * `url` — a public `https:` URL. META fetches it; this process never does.
 */
export type PhotoSource =
  | { readonly kind: 'local'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string };

/** A local path that passed every containment and readability check. */
export interface ResolvedLocalMedia {
  /** The canonical realpath, proven to sit inside the realpath of `mediaDir`. */
  readonly path: string;
  /** Sanitized basename safe to use as a multipart filename. */
  readonly filename: string;
  /** File size in bytes at validation time (always > 0). */
  readonly bytes: number;
}

/** A local file plus its buffered bytes and best-effort content type. */
export interface LocalPhotoBytes extends ResolvedLocalMedia {
  readonly data: Uint8Array;
  readonly contentType: string;
}

/**
 * A source whose local validation already succeeded: the URL is scheme-checked
 * and normalized, or the path is resolved, contained and stat'ed. Producing this
 * performs NO network I/O and reads no file bytes, so it is safe to build in a
 * plan-mode (dry-run) preview.
 */
export type PreparedPhotoSource =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'local'; readonly file: ResolvedLocalMedia };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Why a source was refused before any network call happened. */
export type MediaSourceErrorReason =
  /** `FB_MEDIA_DIR` is unset ⇒ local file access is disabled (C11). */
  | 'local_media_disabled'
  /** `FB_MEDIA_DIR` itself cannot be resolved (missing / not readable). */
  | 'media_dir_unreadable'
  /** Traversal, absolute escape, or a symlink resolving outside `FB_MEDIA_DIR`. */
  | 'outside_media_dir'
  | 'file_not_found'
  | 'file_unreadable'
  /** Directory, FIFO, socket, device — anything that is not a regular file. */
  | 'not_a_regular_file'
  /** Zero-byte file: Meta would reject it, so it fails fast locally (CC-MEDIA-5). */
  | 'empty_file'
  | 'file_too_large'
  | 'malformed_url'
  /** Any scheme other than `https:` (`http:`, `file:`, `data:`, …). */
  | 'unsupported_url_scheme'
  /** `https://user:pass@host/…` — credentials must never be handed to Meta. */
  | 'url_has_credentials'
  /** `extraParams` tried to set a param this module owns (see {@link RESERVED_PHOTO_PARAMS}). */
  | 'reserved_param';

/**
 * A source rejected by LOCAL validation. Distinct from {@link GraphApiError}
 * because nothing was sent: no Graph code, no HTTP status, nothing to verify.
 * `reason` is the machine-readable discriminator the tool layer maps to guidance.
 */
export class MediaSourceError extends Error {
  override readonly name = 'MediaSourceError';
  readonly reason: MediaSourceErrorReason;
  /** The source as the caller supplied it (a path or a URL), for the message. */
  readonly source: string;

  constructor(reason: MediaSourceErrorReason, source: string, message: string) {
    super(message);
    this.reason = reason;
    this.source = source;
    Object.setPrototypeOf(this, MediaSourceError.prototype);
  }
}

/** One child photo that survived the best-effort cleanup and is still on the Page. */
export interface OrphanCleanupFailure {
  readonly id: string;
  /** Why the DELETE did not succeed (already redacted upstream by the client). */
  readonly message: string;
}

/**
 * Outcome of a best-effort orphan cleanup pass. `orphans` is the operator-facing
 * part of the contract: those IDs are still on the Page and must be deleted by
 * hand (CC-MEDIA-10).
 */
export interface OrphanCleanupReport {
  /** Child photo IDs confirmed deleted. */
  readonly deleted: readonly string[];
  /** Child photo IDs that could NOT be deleted — report these to the operator. */
  readonly orphans: readonly string[];
  /** One failure per entry in `orphans`, same order. */
  readonly failures: readonly OrphanCleanupFailure[];
}

/**
 * A report for "nothing to clean up". Deep-frozen because it is a shared
 * singleton returned to callers — a mutation would poison every later caller.
 */
export const EMPTY_ORPHAN_REPORT: OrphanCleanupReport = Object.freeze({
  deleted: Object.freeze<string[]>([]),
  orphans: Object.freeze<string[]>([]),
  failures: Object.freeze<OrphanCleanupFailure[]>([]),
});

/**
 * A multi-photo upload that failed partway. Carries the index that failed, the
 * cleanup outcome for the children created before it, and the ORIGINAL error as
 * `cause` — a cleanup failure must never mask why the upload failed
 * (CC-MEDIA-10). The message leads with the original failure and, when cleanup
 * left something behind, names the orphan IDs.
 */
export class MultiPhotoUploadError extends Error {
  override readonly name = 'MultiPhotoUploadError';
  /** Zero-based index (into the caller's `sources`) of the upload that failed. */
  readonly failedIndex: number;
  /** How many sources the caller submitted. */
  readonly total: number;
  readonly cleanup: OrphanCleanupReport;

  constructor(opts: {
    readonly failedIndex: number;
    readonly total: number;
    readonly cleanup: OrphanCleanupReport;
    readonly cause: unknown;
  }) {
    const original = errorMessage(opts.cause);
    const orphanNote = describeOrphans(opts.cleanup);
    super(
      `photo ${String(opts.failedIndex + 1)} of ${String(opts.total)} failed to upload: ` +
        `${original}${orphanNote !== undefined ? ` ${orphanNote}` : ''}`,
      { cause: opts.cause },
    );
    this.failedIndex = opts.failedIndex;
    this.total = opts.total;
    this.cleanup = opts.cleanup;
    Object.setPrototypeOf(this, MultiPhotoUploadError.prototype);
  }
}

/**
 * The operator-facing sentence for a cleanup report, or `undefined` when nothing
 * was left behind. Exported so the tool layer can add it verbatim to a result's
 * warnings without re-deriving the wording.
 */
export function describeOrphans(report: OrphanCleanupReport): string | undefined {
  if (report.orphans.length === 0) return undefined;
  return (
    `${String(report.orphans.length)} unpublished photo(s) could NOT be cleaned up and ` +
    `remain in the Page's photo library — delete them manually ` +
    `(DELETE /{photo-id}): ${report.orphans.join(', ')}.`
  );
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Local-file policy inputs, mirroring the `Settings` fields they come from. */
export interface LocalMediaOptions {
  /** `Settings.mediaDir` (`FB_MEDIA_DIR`). Undefined ⇒ local paths refused (C11). */
  readonly mediaDir?: string;
  /** Local read ceiling; defaults to {@link DEFAULT_MAX_LOCAL_BYTES}. */
  readonly maxBytes?: number;
}

/** Everything the photo flows need, passed explicitly (no module state). */
export interface MediaPhotoDeps extends LocalMediaOptions {
  readonly fbRequest: FbRequestFn;
  /** Optional; used only to record best-effort cleanup outcomes. */
  readonly logger?: Logger;
}

// ---------------------------------------------------------------------------
// Small internal helpers
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown error';
}

/** Read a Node `errno` code off an unknown thrown value. */
function errnoCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  const code: unknown = (err as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Containment test on a path-separator boundary: `/media/a.jpg` is inside
 * `/media`, but `/media-evil/a.jpg` is NOT. Both arguments must already be
 * realpaths. Comparison is exact-case, which fails CLOSED on a case-insensitive
 * filesystem (a case-mismatched path is refused rather than accepted).
 */
function isInsideDir(root: string, target: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(prefix);
}

/**
 * A filename safe to place in a `Content-Disposition` header. Control
 * characters, quotes, backslashes, separators and U+FFFD (what a non-UTF-8 name
 * decodes to — CC-MEDIA-5) become `_`. `FormData` escapes the header too; this is
 * defense in depth plus a readable name in Meta's error messages.
 *
 * Exported for its own sake: NTFS refuses to hold a name containing `"` or a
 * control character, so the on-disk end of this check cannot run on Windows and
 * the sanitizer would otherwise be untested there.
 */
export function multipartFilename(name: string): string {
  let out = '';
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    const unsafe =
      code < 0x20 ||
      code === 0x7f ||
      ch === '"' ||
      ch === '\\' ||
      ch === '/' ||
      ch === '�';
    out += unsafe ? '_' : ch;
  }
  const trimmed = out.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : 'photo';
}

/**
 * Refuse an `extraParams` bag that tries to set a param this module owns
 * ({@link RESERVED_PHOTO_PARAMS}). Called by both public flows BEFORE any source
 * is prepared, so a bad param can never leave an unpublished child behind.
 * Exported so the tools layer can run the same check while building a plan-mode
 * preview.
 *
 * @throws MediaSourceError (`reserved_param`) naming the offending key.
 */
export function assertNoReservedPhotoParams(
  extraParams?: Readonly<Record<string, ParamValue>>,
): void {
  if (extraParams === undefined) return;
  for (const key of Object.keys(extraParams)) {
    if (!RESERVED_PHOTO_PARAMS.includes(key.toLowerCase())) continue;
    throw new MediaSourceError(
      'reserved_param',
      key,
      `refusing the extra Graph param "${key}": this module owns it. The media source ` +
        '(url/source), the published flag and the request credentials are set from the ' +
        'validated request, never from caller-supplied extra params.',
    );
  }
}

// ---------------------------------------------------------------------------
// Content type — a best-effort HINT only (C10)
// ---------------------------------------------------------------------------

interface MagicRule {
  readonly offset: number;
  readonly bytes: readonly number[];
  readonly type: string;
  /** Optional second signature (WebP / HEIF carry a brand after the box header). */
  readonly then?: { readonly offset: number; readonly bytes: readonly number[] };
}

const ASCII_RIFF = [0x52, 0x49, 0x46, 0x46];
const ASCII_WEBP = [0x57, 0x45, 0x42, 0x50];
const ASCII_FTYP = [0x66, 0x74, 0x79, 0x70];

/** Signatures for the formats a Page photo upload plausibly carries. */
const MAGIC_RULES: readonly MagicRule[] = [
  { offset: 0, bytes: [0xff, 0xd8, 0xff], type: 'image/jpeg' },
  {
    offset: 0,
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    type: 'image/png',
  },
  { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38], type: 'image/gif' },
  {
    offset: 0,
    bytes: ASCII_RIFF,
    type: 'image/webp',
    then: { offset: 8, bytes: ASCII_WEBP },
  },
  { offset: 4, bytes: ASCII_FTYP, type: 'image/heic' },
  { offset: 0, bytes: [0x42, 0x4d], type: 'image/bmp' },
  { offset: 0, bytes: [0x49, 0x49, 0x2a, 0x00], type: 'image/tiff' },
  { offset: 0, bytes: [0x4d, 0x4d, 0x00, 0x2a], type: 'image/tiff' },
];

function matchesAt(data: Uint8Array, offset: number, bytes: readonly number[]): boolean {
  if (data.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (data[offset + i] !== bytes[i]) return false;
  }
  return true;
}

const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heic',
};

/**
 * Best-effort content type: magic numbers first (bytes cannot lie about
 * themselves), then the extension, then `application/octet-stream`. This is a
 * transport hint — it is NOT format validation, which stays with Meta (C10).
 */
export function detectPhotoContentType(data: Uint8Array, filename: string): string {
  for (const rule of MAGIC_RULES) {
    if (!matchesAt(data, rule.offset, rule.bytes)) continue;
    if (rule.then !== undefined && !matchesAt(data, rule.then.offset, rule.then.bytes)) {
      continue;
    }
    return rule.type;
  }
  return EXTENSION_TYPES[extname(filename).toLowerCase()] ?? FALLBACK_CONTENT_TYPE;
}

// ---------------------------------------------------------------------------
// Remote sources — scheme allowlist (SSRF hardening, CC-MEDIA-4)
// ---------------------------------------------------------------------------

/**
 * Validate and normalize a remote photo URL. Only `https:` is accepted: Meta,
 * not this process, performs the fetch, and the allowlist guarantees no caller
 * can steer a "remote" source into a local read (`file:`), an inline payload
 * (`data:`) or a cleartext fetch (`http:`). Embedded credentials are refused so
 * they cannot be handed to Meta or echoed into a log.
 *
 * @returns the normalized absolute URL to send as the `url` param.
 * @throws MediaSourceError (`malformed_url`, `unsupported_url_scheme`,
 *   `url_has_credentials`) — nothing is ever sent on the failure path.
 */
export function resolveRemoteMediaUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MediaSourceError(
      'malformed_url',
      raw,
      `not a valid absolute URL: "${raw}". Supply a complete public ${ALLOWED_REMOTE_SCHEME}// URL to the image.`,
    );
  }
  if (url.protocol !== ALLOWED_REMOTE_SCHEME) {
    throw new MediaSourceError(
      'unsupported_url_scheme',
      raw,
      `refusing the "${url.protocol}" URL "${raw}": only ${ALLOWED_REMOTE_SCHEME}// media URLs are accepted. ` +
        'Facebook fetches the URL itself, so it must be publicly reachable over HTTPS; ' +
        'to publish a local file, set FB_MEDIA_DIR and pass a path instead.',
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new MediaSourceError(
      'url_has_credentials',
      raw,
      'refusing a media URL that embeds credentials — Facebook fetches this URL, so the ' +
        'credentials would be disclosed. Supply a URL that needs no authentication.',
    );
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// Local sources — FB_MEDIA_DIR realpath containment (C11 / CC-MEDIA-5)
// ---------------------------------------------------------------------------

function disabledError(requested: string): MediaSourceError {
  return new MediaSourceError(
    'local_media_disabled',
    requested,
    'local file uploads are disabled: FB_MEDIA_DIR is not set. Either set FB_MEDIA_DIR to a ' +
      'directory holding the media you want to publish, or pass a public https:// URL instead.',
  );
}

function outsideError(
  requested: string,
  mediaDir: string,
  detail: string,
): MediaSourceError {
  return new MediaSourceError(
    'outside_media_dir',
    requested,
    `refusing "${requested}": ${detail}. Only files inside FB_MEDIA_DIR ("${mediaDir}") may be ` +
      'uploaded, and symlinks are resolved before that check, so a link pointing outside is ' +
      'refused too.',
  );
}

/**
 * Resolve a caller-supplied local path to a canonical, contained, readable
 * regular file. Performs NO network I/O and reads no file bytes, so the tool
 * layer can call it in plan mode to validate a write before it happens.
 *
 * Containment is decided on the REALPATH of both the file and `mediaDir`
 * (`fs.realpath`), compared on a separator boundary — so `..` traversal, an
 * absolute path elsewhere, and a symlink inside the directory that points out of
 * it are all refused. Relative paths resolve against `mediaDir`, never the
 * process cwd.
 *
 * @throws MediaSourceError for every rejection; the reason discriminates.
 */
export async function resolveLocalMediaPath(
  requested: string,
  opts: LocalMediaOptions,
): Promise<ResolvedLocalMedia> {
  const configured = opts.mediaDir?.trim();
  if (configured === undefined || configured.length === 0) {
    // C11: no filesystem access at all while local media is disabled.
    throw disabledError(requested);
  }
  if (requested.trim().length === 0) {
    throw new MediaSourceError('file_not_found', requested, 'the file path is empty.');
  }

  let root: string;
  try {
    root = await realpath(configured);
  } catch (err) {
    throw new MediaSourceError(
      'media_dir_unreadable',
      requested,
      `FB_MEDIA_DIR ("${configured}") cannot be resolved (${errnoCode(err) ?? errorMessage(err)}) — ` +
        'point it at an existing, readable directory.',
    );
  }

  // Relative paths belong to the allowlisted directory, not the process cwd.
  const candidate = isAbsolute(requested)
    ? resolvePath(requested)
    : resolvePath(root, requested);

  let real: string;
  try {
    real = await realpath(candidate);
  } catch (err) {
    // Never become an existence oracle for the filesystem outside the allowlist:
    // if the lexical candidate is already out of bounds, report the boundary
    // rather than whether the file happens to exist.
    if (!isInsideDir(root, candidate)) {
      throw outsideError(
        requested,
        root,
        'the path resolves outside the allowed media directory',
      );
    }
    const code = errnoCode(err);
    if (code === 'EACCES' || code === 'EPERM') {
      throw new MediaSourceError(
        'file_unreadable',
        requested,
        `"${requested}" cannot be read (${code}) — check the file's permissions.`,
      );
    }
    throw new MediaSourceError(
      'file_not_found',
      requested,
      `"${requested}" does not exist inside FB_MEDIA_DIR ("${root}").`,
    );
  }

  if (!isInsideDir(root, real)) {
    // Covers `..` traversal, an absolute path elsewhere, AND a symlink inside the
    // directory whose target sits outside it.
    throw outsideError(
      requested,
      root,
      'after resolving symlinks the file lies outside the allowed media directory',
    );
  }

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(real);
  } catch (err) {
    // The realpath resolved a moment ago, so this is a race (the file was
    // removed or its permissions changed). Report it as a source error rather
    // than letting a raw errno escape a validation function.
    throw new MediaSourceError(
      'file_not_found',
      requested,
      `"${requested}" disappeared while it was being validated (${errnoCode(err) ?? errorMessage(err)}).`,
    );
  }
  if (!info.isFile()) {
    throw new MediaSourceError(
      'not_a_regular_file',
      requested,
      `"${requested}" is not a regular file — pass a path to an image file.`,
    );
  }
  if (info.size === 0) {
    throw new MediaSourceError(
      'empty_file',
      requested,
      `"${requested}" is empty (0 bytes) — Facebook would reject it.`,
    );
  }
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_LOCAL_BYTES;
  if (info.size > maxBytes) {
    throw new MediaSourceError(
      'file_too_large',
      requested,
      `"${requested}" is ${String(info.size)} bytes, above this server's ${String(maxBytes)}-byte ` +
        'local upload ceiling. Resize the image or raise the ceiling.',
    );
  }
  try {
    await access(real, fsConstants.R_OK);
  } catch (err) {
    throw new MediaSourceError(
      'file_unreadable',
      requested,
      `"${requested}" is not readable (${errnoCode(err) ?? errorMessage(err)}) — check its permissions.`,
    );
  }

  return { path: real, filename: multipartFilename(basename(real)), bytes: info.size };
}

/**
 * `O_NOFOLLOW` where the platform has it (0 elsewhere, e.g. Windows). Applied to
 * the already-resolved realpath, whose final component is by definition not a
 * symlink: if it HAS become one between validation and read, the open fails
 * instead of following it. This narrows — it cannot fully close — the TOCTOU
 * window on a directory the operator has explicitly allowlisted.
 */
const OPEN_FLAGS: number = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

/** Buffer an already-validated local file, re-checking its size against the handle. */
async function readResolvedLocalPhoto(
  resolved: ResolvedLocalMedia,
  requested: string,
  opts: LocalMediaOptions,
): Promise<LocalPhotoBytes> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_LOCAL_BYTES;
  let handle;
  try {
    handle = await open(resolved.path, OPEN_FLAGS);
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ELOOP') {
      // Not `outsideError`: we do not know where the new link points, only that
      // it appeared after validation, so the message must not claim a directory.
      throw new MediaSourceError(
        'outside_media_dir',
        requested,
        `refusing "${requested}": it became a symlink after it was validated, so it was ` +
          'not followed. Only regular files inside FB_MEDIA_DIR may be uploaded.',
      );
    }
    throw new MediaSourceError(
      'file_unreadable',
      requested,
      `"${requested}" could not be opened (${code ?? errorMessage(err)}).`,
    );
  }
  try {
    // Re-stat through the open handle: the checks now describe the bytes we read.
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new MediaSourceError(
        'not_a_regular_file',
        requested,
        `"${requested}" is not a regular file — pass a path to an image file.`,
      );
    }
    if (info.size === 0) {
      throw new MediaSourceError(
        'empty_file',
        requested,
        `"${requested}" is empty (0 bytes) — Facebook would reject it.`,
      );
    }
    if (info.size > maxBytes) {
      throw new MediaSourceError(
        'file_too_large',
        requested,
        `"${requested}" is ${String(info.size)} bytes, above this server's ${String(maxBytes)}-byte ` +
          'local upload ceiling. Resize the image or raise the ceiling.',
      );
    }
    const data = await handle.readFile();
    return {
      path: resolved.path,
      filename: resolved.filename,
      bytes: data.byteLength,
      data,
      contentType: detectPhotoContentType(data, resolved.filename),
    };
  } finally {
    await handle.close();
  }
}

/**
 * Validate a local path and buffer its bytes. Convenience wrapper over
 * {@link resolveLocalMediaPath} for callers that want the file in one step.
 */
export async function readLocalPhoto(
  requested: string,
  opts: LocalMediaOptions,
): Promise<LocalPhotoBytes> {
  const resolved = await resolveLocalMediaPath(requested, opts);
  return readResolvedLocalPhoto(resolved, requested, opts);
}

// ---------------------------------------------------------------------------
// Source preparation — all local checks BEFORE any upload
// ---------------------------------------------------------------------------

/**
 * Run the local validation for one source: scheme-check a URL, or resolve and
 * stat a local path. No network I/O, no file bytes read.
 */
export async function preparePhotoSource(
  source: PhotoSource,
  opts: LocalMediaOptions,
): Promise<PreparedPhotoSource> {
  if (source.kind === 'url') {
    return { kind: 'url', url: resolveRemoteMediaUrl(source.url) };
  }
  return { kind: 'local', file: await resolveLocalMediaPath(source.path, opts) };
}

/**
 * Prepare every source, in order, failing on the FIRST invalid one. Called
 * before the first upload of a multi-photo post so a locally detectable mistake
 * (bad scheme, missing file, path escape) can never leave orphaned unpublished
 * children behind (CC-MEDIA-10).
 */
export async function preparePhotoSources(
  sources: readonly PhotoSource[],
  opts: LocalMediaOptions,
): Promise<PreparedPhotoSource[]> {
  const prepared: PreparedPhotoSource[] = [];
  for (const source of sources) {
    prepared.push(await preparePhotoSource(source, opts));
  }
  return prepared;
}

/** The path/URL a prepared source came from, for error messages. */
function describeSource(prepared: PreparedPhotoSource): string {
  return prepared.kind === 'url' ? prepared.url : prepared.file.path;
}

// ---------------------------------------------------------------------------
// Single photo upload
// ---------------------------------------------------------------------------

/** One `POST /{page-id}/photos` call. */
export interface PhotoUploadRequest {
  readonly pageId: string;
  readonly source: PhotoSource;
  /** Photo caption. For a multi-photo post the CAPTION belongs on the feed post. */
  readonly caption?: string;
  /**
   * `true` (default) publishes the photo as a Page post immediately. `false`
   * creates an unpublished child to reference from `attached_media` on a
   * subsequent `/{page-id}/feed` call.
   */
  readonly published?: boolean;
  /** The resolved Page token; always pass it explicitly (C1). */
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Extra Graph params passed through verbatim (e.g. `scheduled_publish_time`,
   * `place`, `no_story`, `targeting`). The CALLER owns their validation — this
   * module adds no policy of its own (C10).
   */
  readonly extraParams?: Readonly<Record<string, ParamValue>>;
}

/** What Graph returned for one uploaded photo. */
export interface UploadedPhoto {
  /** The photo (media) ID — the `media_fbid` for `attached_media`. */
  readonly id: string;
  /** The created Page post ID; present only when the photo was published. */
  readonly postId?: string;
}

interface RawPhotoResponse {
  readonly id?: unknown;
  readonly post_id?: unknown;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * A 2xx whose body carries no photo id: the upload may well have landed, but we
 * have no handle to it, so this is a C2 AMBIGUOUS write — never auto-retried,
 * verify first.
 */
function missingIdError(sourceLabel: string, status: number): GraphApiError {
  return new GraphApiError(
    `the photo upload for "${sourceLabel}" returned no photo id, so its outcome is unknown — ` +
      'do NOT retry blindly; check the Page for a stray photo first.',
    {
      code: 0,
      httpStatus: status,
      action: ambiguousWriteAction({ detail: 'photo upload response carried no id' }),
    },
  );
}

/** Merge the shared photo params; `undefined` values are dropped by the client. */
function photoParams(req: {
  readonly caption?: string;
  readonly published: boolean;
  readonly extraParams?: Readonly<Record<string, ParamValue>>;
}): Record<string, ParamValue> {
  return {
    ...(req.extraParams ?? {}),
    ...(req.caption !== undefined ? { caption: req.caption } : {}),
    published: req.published,
  };
}

/** Multipart form fields are strings; drop undefined, stringify the rest. */
function toFields(params: Readonly<Record<string, ParamValue>>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) fields[key] = String(value);
  }
  return fields;
}

/**
 * Everything one `/{page-id}/photos` call needs EXCEPT the source, which has
 * already been validated into a {@link PreparedPhotoSource}. Keeping `source`
 * out makes it impossible for the multi-photo flow to pass a placeholder just to
 * satisfy the type.
 */
type PreparedUploadOptions = Omit<PhotoUploadRequest, 'source'>;

/** Upload one prepared source; shared by the single- and multi-photo flows. */
async function uploadPreparedPhoto(
  deps: MediaPhotoDeps,
  prepared: PreparedPhotoSource,
  req: PreparedUploadOptions,
): Promise<UploadedPhoto> {
  const published = req.published ?? true;
  const params = photoParams({
    ...(req.caption !== undefined ? { caption: req.caption } : {}),
    published,
    ...(req.extraParams !== undefined ? { extraParams: req.extraParams } : {}),
  });
  const path = `/${req.pageId}/${PHOTOS_EDGE}`;

  let request: JsonRequest | MultipartRequest;
  if (prepared.kind === 'url') {
    // Meta fetches the URL; this process never does (CC-MEDIA-4). Params ride in
    // the form BODY, not the query string, so captions stay out of echoed URLs.
    request = {
      protocol: 'json',
      method: 'POST',
      host: 'graph',
      path,
      body: { ...params, url: prepared.url },
      ...(req.token !== undefined ? { token: req.token } : {}),
      ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
    };
  } else {
    const file = await readResolvedLocalPhoto(prepared.file, prepared.file.path, deps);
    request = {
      protocol: 'multipart',
      method: 'POST',
      host: 'graph',
      path,
      fields: toFields(params),
      files: [
        {
          name: PHOTO_BYTES_FIELD,
          data: file.data,
          filename: file.filename,
          contentType: file.contentType,
        },
      ],
      ...(req.token !== undefined ? { token: req.token } : {}),
      ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
    };
  }

  const res = await deps.fbRequest<RawPhotoResponse>(request);
  const id = asNonEmptyString(res.data?.id);
  if (id === undefined) {
    throw missingIdError(describeSource(prepared), res.status);
  }
  const postId = asNonEmptyString(res.data?.post_id);
  return { id, ...(postId !== undefined ? { postId } : {}) };
}

/**
 * Upload ONE photo to `/{page-id}/photos`. With the default `published:true`
 * this both creates the photo and publishes it as a Page post, so
 * `postId` comes back for the single-photo flow. Requires
 * `pages_manage_posts` on a Page token.
 *
 * @throws MediaSourceError when the source or an extra param fails local
 *   validation (nothing is sent on that path).
 * @throws GraphApiError propagated from the client, unchanged.
 */
export async function uploadPhoto(
  deps: MediaPhotoDeps,
  req: PhotoUploadRequest,
): Promise<UploadedPhoto> {
  assertNoReservedPhotoParams(req.extraParams);
  const prepared = await preparePhotoSource(req.source, deps);
  return uploadPreparedPhoto(deps, prepared, req);
}

// ---------------------------------------------------------------------------
// Orphan cleanup (CC-MEDIA-10)
// ---------------------------------------------------------------------------

/** Options for a best-effort cleanup pass. */
export interface CleanupOptions {
  readonly token?: string;
  /** Per-DELETE timeout; defaults to {@link DEFAULT_CLEANUP_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /**
   * Deliberately separate from the upload's signal: cleanup after a CANCELLED
   * upload must still run, so the caller opts in rather than inheriting an
   * already-aborted signal.
   */
  readonly signal?: AbortSignal;
}

interface RawDeleteResponse {
  readonly success?: unknown;
}

/**
 * Delete unpublished child photos, best effort and NEVER throwing. Every ID is
 * attempted (a failure does not stop the pass) and whatever survives is returned
 * in `orphans` so the caller can tell the operator exactly what to remove
 * (CC-MEDIA-10). Exported because the follow-up `/feed` call lives in the tools
 * layer: if THAT fails, its children are orphans too and this is how they are
 * cleaned up.
 */
export async function cleanupUnpublishedPhotos(
  deps: MediaPhotoDeps,
  ids: readonly string[],
  opts: CleanupOptions = {},
): Promise<OrphanCleanupReport> {
  if (ids.length === 0) return EMPTY_ORPHAN_REPORT;

  const deleted: string[] = [];
  const orphans: string[] = [];
  const failures: OrphanCleanupFailure[] = [];

  for (const id of ids) {
    try {
      const res = await deps.fbRequest<RawDeleteResponse>({
        protocol: 'json',
        method: 'DELETE',
        host: 'graph',
        path: `/${id}`,
        ...(opts.token !== undefined ? { token: opts.token } : {}),
        timeoutMs: opts.timeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
      // Graph answers `{success:true}`; an explicit `false` means it survived.
      if (res.data?.success === false) {
        orphans.push(id);
        failures.push({ id, message: 'Graph reported success:false for the delete' });
        continue;
      }
      deleted.push(id);
    } catch (err) {
      orphans.push(id);
      failures.push({ id, message: errorMessage(err) });
    }
  }

  const report: OrphanCleanupReport = { deleted, orphans, failures };
  if (orphans.length > 0) {
    deps.logger?.warn('media-photos.cleanup incomplete', {
      deleted: deleted.length,
      orphans,
    });
  } else {
    deps.logger?.debug('media-photos.cleanup complete', { deleted: deleted.length });
  }
  return report;
}

/**
 * {@link cleanupUnpublishedPhotos} that provably cannot throw. The pass already
 * swallows per-DELETE failures, but the surrounding bookkeeping (an injected
 * logger, a future addition) must never be able to replace the ORIGINAL upload
 * error with a cleanup error (CC-MEDIA-10). If the pass itself blows up we
 * degrade to "assume nothing was deleted", which over-reports rather than
 * under-reports: the operator is pointed at IDs that may already be gone,
 * instead of silently keeping real orphans.
 */
async function cleanupNeverThrows(
  deps: MediaPhotoDeps,
  ids: readonly string[],
  opts: CleanupOptions,
): Promise<OrphanCleanupReport> {
  try {
    return await cleanupUnpublishedPhotos(deps, ids, opts);
  } catch (err) {
    const message = `cleanup pass failed: ${errorMessage(err)}`;
    return {
      deleted: [],
      orphans: [...ids],
      failures: ids.map((id) => ({ id, message })),
    };
  }
}

// ---------------------------------------------------------------------------
// Multi-photo upload — unpublished children for /feed attached_media
// ---------------------------------------------------------------------------

/** One unpublished photo child, with its position in the caller's source list. */
export interface UnpublishedPhotoChild {
  /** The photo ID to use as `media_fbid`. */
  readonly id: string;
  /** Zero-based index of the source that produced it (ordering is preserved). */
  readonly index: number;
}

/** A multi-photo upload pass. */
export interface UnpublishedPhotosRequest {
  readonly pageId: string;
  /** At least one source; uploaded sequentially so ordering is deterministic. */
  readonly sources: readonly PhotoSource[];
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Per-DELETE timeout for the failure path; see {@link DEFAULT_CLEANUP_TIMEOUT_MS}. */
  readonly cleanupTimeoutMs?: number;
  /** Called after each successful child upload (progress reporting, CC-MCP-1). */
  readonly onProgress?: (done: number, total: number) => void;
  /** Extra Graph params applied to every child photo. */
  readonly extraParams?: Readonly<Record<string, ParamValue>>;
}

/** The child IDs plus the ready-made `attached_media` params for `/feed` (V03). */
export interface UnpublishedPhotosResult {
  /** Children in source order. */
  readonly children: readonly UnpublishedPhotoChild[];
  /** `attachedMediaParams(children)`, precomputed for convenience. */
  readonly attachedMedia: Readonly<Record<string, string>>;
}

/**
 * Flatten children into the `attached_media[i]={"media_fbid":"…"}` params a
 * `POST /{page-id}/feed` expects, in `children` order. Form-encoded indexed
 * params are used (rather than one JSON array) because that is the shape the
 * form/query protocol carries natively.
 */
export function attachedMediaParams(
  children: readonly UnpublishedPhotoChild[],
): Record<string, string> {
  const params: Record<string, string> = {};
  children.forEach((child, i) => {
    params[`attached_media[${String(i)}]`] = JSON.stringify({ media_fbid: child.id });
  });
  return params;
}

/**
 * Upload N photos as UNPUBLISHED children and hand back their IDs for a
 * follow-up `/{page-id}/feed` call with `attached_media` (the feed call belongs
 * to the tools layer, V03).
 *
 * Failure semantics (CC-MEDIA-10):
 *   * every source is validated locally FIRST, so a locally detectable mistake
 *     throws a {@link MediaSourceError} having created nothing;
 *   * if an upload fails after others succeeded, the successful children are
 *     deleted best-effort WITHOUT the caller's (possibly aborted) signal, and a
 *     {@link MultiPhotoUploadError} is thrown carrying the original error as
 *     `cause` plus the cleanup report — including any orphan IDs cleanup could
 *     not remove.
 *
 * The caller remains responsible for cleaning up on ITS own failure (a rejected
 * `/feed` call) via {@link cleanupUnpublishedPhotos}.
 */
export async function uploadUnpublishedPhotos(
  deps: MediaPhotoDeps,
  req: UnpublishedPhotosRequest,
): Promise<UnpublishedPhotosResult> {
  const total = req.sources.length;
  if (total === 0) {
    throw new Error('uploadUnpublishedPhotos: `sources` must contain at least one photo');
  }

  // Phase 1 — pure local validation. Nothing exists remotely yet, so a rejection
  // here cannot orphan anything.
  assertNoReservedPhotoParams(req.extraParams);
  const prepared = await preparePhotoSources(req.sources, deps);

  // Phase 2 — sequential uploads, tracking what must be cleaned up on failure.
  const children: UnpublishedPhotoChild[] = [];
  for (const [index, source] of prepared.entries()) {
    try {
      const uploaded = await uploadPreparedPhoto(deps, source, {
        pageId: req.pageId,
        published: false,
        ...(req.token !== undefined ? { token: req.token } : {}),
        ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
        ...(req.extraParams !== undefined ? { extraParams: req.extraParams } : {}),
      });
      children.push({ id: uploaded.id, index });
      req.onProgress?.(children.length, total);
    } catch (err) {
      // Best-effort cleanup WITHOUT req.signal: if the failure was a cancellation,
      // reusing that signal would abort every DELETE and orphan every child.
      const cleanup = await cleanupNeverThrows(
        deps,
        children.map((child) => child.id),
        {
          ...(req.token !== undefined ? { token: req.token } : {}),
          ...(req.cleanupTimeoutMs !== undefined
            ? { timeoutMs: req.cleanupTimeoutMs }
            : {}),
        },
      );
      throw new MultiPhotoUploadError({ failedIndex: index, total, cleanup, cause: err });
    }
  }

  return { children, attachedMedia: attachedMediaParams(children) };
}
