// `posts` package — per-call context helpers (Page resolution, request scope,
// local media binding, progress) and the dual UTC + Page-local schedule echo.

import type { ResolvedPage, ToolContext } from '../../core/index.js';
import {
  MediaSourceError,
  digestLocalMedia,
  readLocalPhoto,
  type LocalMediaOptions,
  type MediaPhotoDeps,
  type PhotoSource,
  type PreparedPhotoSource,
} from '../../api/media-photos.js';
import { type ReelScheduleEcho } from '../../api/media-reels.js';
import {
  formatInTimeZone,
  readPageTimezone,
  resolvePageTimezone,
  type OrganicTargeting,
  type PostPlan,
  type RequestScope,
  type ScheduleEcho,
} from '../../api/posts-write.js';
import { ToolInputError, resolvedPagesOf } from './errors.js';

// ---------------------------------------------------------------------------
// 4. Context helpers
// ---------------------------------------------------------------------------

/** The Page, the clock reading and the (optional) timezone one call works with. */
interface PostsBase {
  readonly page: ResolvedPage;
  readonly nowMs: number;
  readonly pageTimezone?: string;
}

/** Token + abort seams for every Graph call this package makes (C1 / CC-MCP-2). */
export function requestScope(ctx: ToolContext, page: ResolvedPage): RequestScope {
  return {
    token: page.token,
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  };
}

/** `FB_MEDIA_DIR` policy, straight from settings (C11). */
export function localMediaOptions(ctx: ToolContext): LocalMediaOptions {
  return ctx.settings.mediaDir !== undefined ? { mediaDir: ctx.settings.mediaDir } : {};
}

export function mediaDeps(ctx: ToolContext): MediaPhotoDeps {
  return { fbRequest: ctx.fbRequest, logger: ctx.logger, ...localMediaOptions(ctx) };
}

/**
 * Resolve the Page and, when a schedule is involved, its timezone.
 *
 * The timezone is display-only: an explicit `page_timezone` is validated (a
 * typo must not silently degrade to a UTC-only echo), while the Graph read
 * behind it never throws, so an unreadable Page timezone downgrades the echo
 * instead of blocking the write (CC-SCHED-2).
 */
export async function prepareBase(
  ctx: ToolContext,
  input: { readonly profile?: string; readonly page_timezone?: string },
  opts: { readonly needTimezone: boolean },
): Promise<PostsBase> {
  const page = await ctx.pages.resolvePage(input.profile);
  resolvedPagesOf.get(ctx)?.add(page.pageId);
  const nowMs = ctx.clock.now();

  let pageTimezone: string | undefined;
  if (input.page_timezone !== undefined) {
    pageTimezone = resolvePageTimezone(input.page_timezone);
    if (pageTimezone === undefined) {
      throw new ToolInputError(
        'page_timezone',
        `page_timezone "${input.page_timezone}" is not a timezone this runtime recognises.`,
        'Pass an IANA name such as "Europe/Sofia" or "America/New_York", or omit the argument and let the server read the Page timezone.',
      );
    }
  } else if (opts.needTimezone) {
    pageTimezone = await readPageTimezone(
      ctx.fbRequest,
      page.pageId,
      requestScope(ctx, page),
    );
  }

  return {
    page,
    nowMs,
    ...(pageTimezone !== undefined ? { pageTimezone } : {}),
  };
}

/**
 * Read a local video for upload, refusing bytes the plan did not describe.
 *
 * The handler resolves the file and binds its size AND content hash into the
 * plan params, but `perform()` reads the file again. A file rewritten in
 * between — even to the same size — would otherwise be uploaded under a plan
 * that showed a different file. The hash is checked on the very buffer that
 * is uploaded, so the check cannot be raced by a later rewrite.
 */
export async function readBoundLocalMedia(
  requested: string,
  opts: LocalMediaOptions,
  bound: { readonly bytes: number; readonly sha256: string },
): Promise<Awaited<ReturnType<typeof readLocalPhoto>>> {
  const file = await readLocalPhoto(requested, opts, bound.sha256);
  const boundBytes = bound.bytes;
  if (file.bytes !== boundBytes) {
    throw new MediaSourceError(
      'file_changed',
      requested,
      `"${requested}" is now ${String(file.bytes)} bytes, but the plan was built for ${String(boundBytes)} bytes — the file changed after it was validated, so it was not uploaded. Preview the call again to bind the current file.`,
    );
  }
  return file;
}

/**
 * Attach the content hash of every local photo to its source, so the plan can
 * bind it and the upload can refuse bytes that no longer hash the same. URL
 * sources pass through: Meta fetches those, this process never sees the bytes.
 */
export async function bindLocalPhotoContent(
  sources: readonly PhotoSource[],
  prepared: readonly PreparedPhotoSource[],
  opts: LocalMediaOptions,
): Promise<PhotoSource[]> {
  const bound: PhotoSource[] = [];
  for (const [index, source] of sources.entries()) {
    const ready = prepared[index];
    if (source.kind === 'local' && ready?.kind === 'local') {
      const digest = await digestLocalMedia(ready.file, source.path, opts);
      bound.push({ ...source, sha256: digest.sha256 });
    } else {
      bound.push(source);
    }
  }
  return bound;
}

/** Forward a byte/child counter to the MCP client when it asked for progress. */
export function report(
  ctx: ToolContext,
  progress: number,
  total: number,
  message: string,
): void {
  ctx.reportProgress?.({ progress, total, message });
}

// ---------------------------------------------------------------------------
// 5. The dual UTC + Page-local schedule echo
// ---------------------------------------------------------------------------

/**
 * One normalized publish-time echo. Both echo producers in the `api` layer
 * (`ScheduleEcho` for feed posts, `ReelScheduleEcho` for Reels) collapse into
 * this, so a preview and its result state the instant identically and an
 * operator comparing two tools never sees two wordings for one fact.
 */
interface TimeEcho {
  readonly utc: string;
  readonly epochSeconds: number;
  readonly leadMs: number;
  readonly pageTimezone: string | null;
  readonly pageLocal: string | null;
  readonly windowNote: string;
  readonly timezoneCaveat: string;
}

export function toTimeEcho(echo: ScheduleEcho): TimeEcho {
  return {
    utc: echo.utc,
    epochSeconds: echo.epochSeconds,
    leadMs: echo.leadMs,
    pageTimezone: echo.pageTimezone ?? null,
    pageLocal: echo.pageLocal ?? null,
    windowNote: echo.windowNote,
    timezoneCaveat: echo.timezoneCaveat,
  };
}

export function toReelTimeEcho(echo: ReelScheduleEcho, pageTimezone?: string): TimeEcho {
  const zone = pageTimezone ?? echo.pageTimezone;
  const local =
    zone !== undefined ? formatInTimeZone(echo.epochSeconds * 1000, zone) : undefined;
  return {
    utc: echo.utc,
    epochSeconds: echo.epochSeconds,
    leadMs: echo.leadMs,
    pageTimezone: zone ?? null,
    pageLocal: local ?? null,
    windowNote: echo.windowNote,
    timezoneCaveat: echo.timezoneCaveat,
  };
}

/**
 * The one-line rendering of an echo, added to a preview's warnings. A preview is
 * text an operator approves, so the instant must be legible there and not only
 * in the applied result.
 */
export function echoLine(echo: TimeEcho): string {
  const local =
    echo.pageLocal !== null && echo.pageTimezone !== null
      ? `${echo.pageLocal} (${echo.pageTimezone})`
      : 'not available — the Page timezone is unknown';
  return `Publish time: ${echo.utc} (UTC, epoch seconds ${String(echo.epochSeconds)}); in Page-local time: ${local}.`;
}

/** Preview warnings for a create-style plan, with the echo line appended. */
/** The bound audience, echoed in the preview metadata and the result. */
export function targetingMeta(plan: PostPlan): { targetingEcho?: OrganicTargeting } {
  return plan.targetingEcho !== undefined ? { targetingEcho: plan.targetingEcho } : {};
}

export function planWarnings(
  plan: { readonly warnings: readonly string[] },
  echo?: TimeEcho,
) {
  return echo === undefined ? plan.warnings : [...plan.warnings, echoLine(echo)];
}
