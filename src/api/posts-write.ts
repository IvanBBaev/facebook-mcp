// Planning and validation for the `posts` write surface (task V03).
//
// This is layer-1 `api` code: it may reach into `core` and its sibling `api`
// modules and nothing above, so there is no zod here, no result shaping and no
// knowledge of the write gate — the tool layer owns those. What lives here is
// everything that must be IDENTICAL in a dry run and in the apply that follows
// it, because a preview an operator approved must never be rejected locally one
// step later:
//
//   * the scheduling contract (CC-SCHED-1/2/3) — an ISO-8601 instant carrying an
//     explicit UTC offset, bounded windows, and the dual UTC + Page-timezone
//     echo;
//   * the field-combination rules for `/{page-id}/feed`, `/{post-id}` and the
//     scheduled-post lifecycle (CC-PUB-6/7/9/10, CC-SCHED-5);
//   * the request builders, so preview and apply cannot drift apart;
//   * the post-state reader that backs divergence detection (CC-SCHED-4).
//
// Nothing in this module retries, and nothing invents a Graph behaviour: local
// validation covers what is cheap and certain, Meta stays the source of truth
// for the rest (C10).

import {
  GraphApiError,
  type FbRequestFn,
  type JsonRequest,
  type ParamValue,
} from '../core/index.js';
import type { EdgeRequest } from './shared.js';
import {
  describeOrphans,
  type OrphanCleanupReport,
  type PhotoSource,
} from './media-photos.js';

// ---------------------------------------------------------------------------
// 1. Edges, fields and the operator-facing notes
// ---------------------------------------------------------------------------

/** The Page feed edge every text/link/carousel post is created on. */
export const FEED_EDGE = 'feed';

/** The edge that lists posts waiting for their `scheduled_publish_time`. */
export const SCHEDULED_POSTS_EDGE = 'scheduled_posts';

/** The Page video edge (used for the remote-`file_url` create path). */
export const VIDEOS_EDGE = 'videos';

/** Fields read back for each entry of the scheduled queue. */
export const SCHEDULED_POST_FIELDS =
  'id,message,story,created_time,scheduled_publish_time,is_published,permalink_url';

/** Fields captured for divergence detection on update/delete (C4). */
export const POST_STATE_FIELDS =
  'id,message,is_published,is_hidden,scheduled_publish_time,created_time';

/** CC-PUB-7: the documented Page-post text ceiling. */
export const POST_MESSAGE_MAX_CHARS = 63_206;

/** CC-PUB-10: a multi-link carousel needs between two and five children. */
export const CHILD_ATTACHMENTS_MIN = 2;
/** CC-PUB-10 upper bound. */
export const CHILD_ATTACHMENTS_MAX = 5;

/**
 * Ceiling for a local video file. The resumable uploader takes the whole file as
 * a `Uint8Array`, so the file is buffered in memory — this bound exists to keep
 * a mistyped path from exhausting the process rather than to mirror any Meta
 * limit.
 */
export const MAX_LOCAL_VIDEO_BYTES = 256 * 1024 * 1024;

export const PUBLISH_VERIFY_NOTE =
  'A publish that times out may still have landed. Never re-send it blindly — verify with facebook_list_posts filtered to the last few minutes, matching the exact message text in this plan (CC-PUB-1).';

export const DUPLICATE_CONTENT_NOTE =
  'Posting identical text twice in quick succession is refused by Meta as duplicate content (error 506). The server never retries a publish on its own (CC-PUB-2).';

export const POST_YEAR_CAP_NOTE =
  'A Page can publish roughly 600 posts per year through the API. The server does not count them locally, so the cap surfaces as a Meta error rather than a local refusal (CC-PUB-3).';

export const LINK_PREVIEW_NOTE =
  'The link preview is scraped by Facebook and is best-effort: it can be slow, partial or absent, and the server does not control it (CC-PUB-6).';

export const DRAFT_TRANSITION_NOTE =
  'An unpublished draft can be published later with facebook_update_post (action "publish_now"). The reverse transition — published back to unpublished — is not available for every post type (CC-PUB-9).';

export const EDIT_OWN_APP_NOTE =
  'Facebook only lets an app edit posts that the SAME app created. Editing a post published by another app, or by a human in the Page UI, fails no matter what permissions the token carries (CC-PUB-4).';

export const DELETE_PERMANENT_NOTE =
  'Deleting a Page post is permanent: there is no undo and no trash to restore it from.';

export const DELETE_ALREADY_ABSENT_NOTE =
  'If the post is already gone, the delete reports success-with-note instead of an error — absence is the intended end state (CC-PUB-5).';

export const SCHEDULE_RACE_NOTE =
  'A scheduled post can publish itself while this plan is open. The apply step re-reads the post first and refuses with a diff if its state moved (CC-SCHED-4).';

export const VIDEO_CREATED_NOT_READY_NOTE =
  'A finished upload is NOT a published, processed video: Meta still has to transcode it. The video id comes back immediately, but the post may 404 or render empty for a while — poll the video status before telling anyone it is live (CC-MEDIA-7).';

export const UNICODE_PASSTHROUGH_NOTE =
  'Message text is sent verbatim as UTF-8. Hashtags are plain text and @-mentions of other Pages are not supported for third-party apps (CC-PUB-8).';

// ---------------------------------------------------------------------------
// 2. Local validation failures
// ---------------------------------------------------------------------------

/** Why a post was refused before any request was built. */
export type PostValidationReason =
  | 'schedule_format'
  | 'schedule_too_soon'
  | 'schedule_too_far'
  | 'schedule_reschedule_window'
  | 'schedule_missing'
  | 'schedule_not_allowed'
  | 'message_too_long'
  | 'empty_post'
  | 'child_attachments_range'
  | 'conflicting_params'
  | 'no_update_fields'
  | 'unsupported_transition'
  | 'unsupported_media_source';

/**
 * A refusal raised locally, before anything was sent. `reason` is the machine
 * handle; the message always states what to send instead, because the caller is
 * usually a model that has to fix the arguments without a second round trip.
 */
export class PostValidationError extends Error {
  override readonly name = 'PostValidationError';
  readonly reason: PostValidationReason;
  /** The offending argument, when exactly one can be named. */
  readonly field?: string | undefined;

  constructor(reason: PostValidationReason, message: string, field?: string) {
    super(message);
    this.reason = reason;
    this.field = field;
    Object.setPrototypeOf(this, PostValidationError.prototype);
  }
}

/**
 * The photos of a carousel uploaded, but creating the feed post that references
 * them failed — so the children are unpublished media sitting on the Page.
 * Carries the best-effort cleanup report so the operator learns exactly which
 * ids (if any) survived and must be removed by hand (CC-MEDIA-10).
 */
export class CarouselPostError extends Error {
  override readonly name = 'CarouselPostError';
  readonly cleanup: OrphanCleanupReport;

  constructor(opts: { readonly cause: unknown; readonly cleanup: OrphanCleanupReport }) {
    const original =
      opts.cause instanceof Error ? opts.cause.message : String(opts.cause);
    const orphanNote = describeOrphans(opts.cleanup);
    super(
      `the photos uploaded but the carousel post could not be created: ${original}` +
        (orphanNote !== undefined ? ` ${orphanNote}` : ''),
      { cause: opts.cause },
    );
    this.cleanup = opts.cleanup;
    Object.setPrototypeOf(this, CarouselPostError.prototype);
  }
}

// ---------------------------------------------------------------------------
// 2b. Media references
// ---------------------------------------------------------------------------

/**
 * Anything shaped like `scheme://…`. Deliberately broader than `https:` so a
 * `http://` or `ftp://` reference is classified as a URL and refused by the
 * scheme check in `media-photos`, instead of being treated as a relative path
 * and producing a confusing "file not found".
 */
const URL_LIKE_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Classify one operator-supplied media reference. Pure string work: no
 * filesystem access and no network, so it is safe in a dry run. The allowlist
 * checks (https-only for URLs, `FB_MEDIA_DIR` containment for paths) belong to
 * `media-photos` and run on the value this returns.
 */
export function toMediaSource(raw: string): PhotoSource {
  const value = raw.trim();
  return URL_LIKE_RE.test(value)
    ? { kind: 'url', url: value }
    : { kind: 'local', path: value };
}

/**
 * Narrow a media reference to a local path, for the flows that must read the
 * bytes themselves (the Reels rupload protocol has no "fetch this URL for me"
 * mode). Refusing here — with the reason spelled out — beats letting a URL fall
 * through to a path resolver that would report it as a missing file.
 *
 * @throws PostValidationError
 */
export function assertLocalMediaSource(raw: string, field: string, why: string): string {
  const source = toMediaSource(raw);
  if (source.kind === 'url') {
    throw new PostValidationError('unsupported_media_source', why, field);
  }
  return source.path;
}

// ---------------------------------------------------------------------------
// 3. Scheduling (CC-SCHED-1/2/3)
// ---------------------------------------------------------------------------

/** CC-SCHED-1 lower bound: Meta refuses anything closer than ten minutes. */
export const SCHEDULE_MIN_LEAD_MS = 10 * 60 * 1000;
/** CC-SCHED-1 upper bound for a fresh scheduled post. */
export const SCHEDULE_MAX_LEAD_MS = 75 * 24 * 60 * 60 * 1000;
/** Above this the request is still sent, but the plan says the surface may cap it. */
export const SCHEDULE_WARN_LEAD_MS = 30 * 24 * 60 * 60 * 1000;
/** Rescheduling an existing post is bounded relative to that post's creation. */
export const RESCHEDULE_MAX_FROM_CREATION_MS = 29 * 24 * 60 * 60 * 1000;

export const SCHEDULE_FORMAT_HELP =
  'Pass scheduled_publish_time as an ISO-8601 instant WITH an explicit UTC offset — for example "2026-08-01T09:30:00+03:00" or "2026-08-01T06:30:00Z". A bare local time ("2026-08-01T09:30:00") and a bare epoch-seconds value are both refused, because the instant they mean would be a guess (CC-SCHED-2/3).';

export const SCHEDULE_TIMEZONE_CAVEAT =
  "Facebook renders scheduled times in the Page's own timezone. The wire value is the UTC instant below (Unix seconds); the Page-local rendering is display-only.";

/**
 * ISO-8601 date-time that ends in `Z` or an explicit numeric offset. Captured
 * piecewise so the components can be range-checked without relying on
 * `Date.parse`, whose out-of-range behaviour (silent rollover vs `NaN`) is
 * engine-defined.
 */
const ISO_WITH_OFFSET_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:[Zz]|([+-])(\d{2}):?(\d{2}))$/;
/** The same shape WITHOUT an offset — recognised only so the error can say why. */
const NAIVE_ISO_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/;
const ALL_DIGITS_RE = /^\d+$/;
const COMPACT_OFFSET_RE = /([+-])(\d{2})(\d{2})$/;

/** The resolved schedule, echoed in the preview AND in the applied result. */
export interface ScheduleEcho {
  /** Exactly what the caller supplied, after trimming. */
  readonly input: string;
  /** What goes on the wire as `scheduled_publish_time` (Unix SECONDS). */
  readonly epochSeconds: number;
  /** The same instant in epoch milliseconds. */
  readonly epochMs: number;
  /** The same instant as UTC ISO-8601. */
  readonly utc: string;
  /** Milliseconds between "now" and the requested instant. */
  readonly leadMs: number;
  /** The Page's IANA timezone, when it is known. */
  readonly pageTimezone?: string;
  /** The same instant rendered in {@link ScheduleEcho.pageTimezone}. */
  readonly pageLocal?: string;
  readonly windowNote: string;
  readonly timezoneCaveat: string;
}

/** Bounds a particular surface enforces; every field has a documented default. */
export interface ScheduleWindow {
  readonly minLeadMs?: number;
  readonly maxLeadMs?: number;
  /** Creation time of the post being rescheduled, epoch ms (CC-SCHED-1). */
  readonly createdAtMs?: number;
  readonly maxFromCreationMs?: number;
}

/** Everything {@link resolveSchedule} needs besides the raw value. */
export interface ScheduleContext {
  readonly nowMs: number;
  readonly pageTimezone?: string;
  readonly window?: ScheduleWindow;
}

function days(ms: number): string {
  return String(Math.round(ms / (24 * 60 * 60 * 1000)));
}

function minutes(ms: number): string {
  return String(Math.round(ms / 60_000));
}

/** `+0300` is not in the ES date-time grammar; `+03:00` is. */
function normalizeOffset(raw: string): string {
  return raw.replace(COMPACT_OFFSET_RE, '$1$2:$3');
}

/** Last day of a 1-based month, leap years included. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Range-check the captured components. `Date.parse('2026-02-31T…')` rolls the
 * date forward on V8 instead of failing, which would silently publish on the
 * wrong day — so the calendar is validated here rather than delegated.
 */
function assertCalendarComponents(raw: string, m: RegExpExecArray, field: string): void {
  const [, y = '', mo = '', d = '', h = '', mi = '', s = '0', , oh = '0', om = '0'] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const valid =
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    Number(h) <= 23 &&
    Number(mi) <= 59 &&
    Number(s) <= 59 &&
    Number(oh) <= 23 &&
    Number(om) <= 59;
  if (!valid) {
    throw new PostValidationError(
      'schedule_format',
      `${field} "${raw}" is not a real calendar instant. ${SCHEDULE_FORMAT_HELP}`,
      field,
    );
  }
}

/**
 * Turn the caller's `scheduled_publish_time` into epoch milliseconds.
 *
 * The only accepted form is an ISO-8601 instant with an explicit offset. A
 * naive local time is ambiguous across DST (CC-SCHED-3) and a bare number hides
 * a seconds/milliseconds unit bug, so both are refused rather than guessed.
 *
 * @throws PostValidationError (`schedule_format`)
 */
export function parseScheduledPublishTime(
  value: unknown,
  field = 'scheduled_publish_time',
): number {
  if (typeof value === 'number') {
    throw new PostValidationError(
      'schedule_format',
      `${field} was given as the number ${String(value)}. Bare epoch values are not accepted. ${SCHEDULE_FORMAT_HELP}`,
      field,
    );
  }
  if (typeof value !== 'string') {
    throw new PostValidationError(
      'schedule_format',
      `${field} must be a string. ${SCHEDULE_FORMAT_HELP}`,
      field,
    );
  }
  const raw = value.trim();
  if (raw === '') {
    throw new PostValidationError(
      'schedule_format',
      `${field} is empty. ${SCHEDULE_FORMAT_HELP}`,
      field,
    );
  }
  if (ALL_DIGITS_RE.test(raw)) {
    throw new PostValidationError(
      'schedule_format',
      `${field} "${raw}" looks like a raw epoch timestamp. Epoch values are not accepted because the seconds/milliseconds unit cannot be told apart safely. ${SCHEDULE_FORMAT_HELP}`,
      field,
    );
  }
  if (NAIVE_ISO_RE.test(raw)) {
    throw new PostValidationError(
      'schedule_format',
      `${field} "${raw}" carries no UTC offset, so the instant it means depends on a timezone this server refuses to guess. ${SCHEDULE_FORMAT_HELP}`,
      field,
    );
  }
  const match = ISO_WITH_OFFSET_RE.exec(raw);
  if (match === null) {
    throw new PostValidationError(
      'schedule_format',
      `${field} "${raw}" is not an ISO-8601 instant with an explicit UTC offset. ${SCHEDULE_FORMAT_HELP}`,
      field,
    );
  }
  assertCalendarComponents(raw, match, field);
  const epochMs = Date.parse(normalizeOffset(raw));
  if (Number.isNaN(epochMs)) {
    throw new PostValidationError(
      'schedule_format',
      `${field} "${raw}" is not a real calendar instant. ${SCHEDULE_FORMAT_HELP}`,
      field,
    );
  }
  return epochMs;
}

/** Whether the runtime's ICU data knows this IANA zone. */
export function isSupportedTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Render an instant in an IANA zone, or `undefined` when the zone is unusable.
 * Display only — the wire value is always the UTC instant.
 */
export function formatInTimeZone(epochMs: number, timeZone: string): string | undefined {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'shortOffset',
    }).format(new Date(epochMs));
  } catch {
    return undefined;
  }
}

/**
 * Accept a Page timezone only when it is a usable IANA name. Meta's legacy Page
 * `timezone` field can also be a numeric UTC offset; a number is display-hostile
 * and cannot drive `Intl`, so it is dropped rather than reinterpreted.
 */
export function resolvePageTimezone(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const tz = raw.trim();
  if (tz === '' || !tz.includes('/') || !isSupportedTimeZone(tz)) return undefined;
  return tz;
}

/**
 * Parse, bound-check and echo a requested publish time.
 *
 * @throws PostValidationError — `schedule_format`, `schedule_too_soon`,
 *   `schedule_too_far` or `schedule_reschedule_window`.
 */
export function resolveSchedule(value: unknown, ctx: ScheduleContext): ScheduleEcho {
  const epochMs = parseScheduledPublishTime(value);
  const minLeadMs = ctx.window?.minLeadMs ?? SCHEDULE_MIN_LEAD_MS;
  const maxLeadMs = ctx.window?.maxLeadMs ?? SCHEDULE_MAX_LEAD_MS;
  const leadMs = epochMs - ctx.nowMs;
  const utc = new Date(epochMs).toISOString();

  if (leadMs < minLeadMs) {
    throw new PostValidationError(
      'schedule_too_soon',
      `scheduled_publish_time ${utc} is only ${minutes(leadMs)} minute(s) away; Facebook requires at least ${minutes(minLeadMs)} minutes of lead time. Pick a later instant or publish immediately by omitting scheduled_publish_time (CC-SCHED-1).`,
      'scheduled_publish_time',
    );
  }
  if (leadMs > maxLeadMs) {
    throw new PostValidationError(
      'schedule_too_far',
      `scheduled_publish_time ${utc} is ${days(leadMs)} days away; the accepted window ends ${days(maxLeadMs)} days from now (CC-SCHED-1).`,
      'scheduled_publish_time',
    );
  }

  const createdAtMs = ctx.window?.createdAtMs;
  const maxFromCreationMs =
    ctx.window?.maxFromCreationMs ?? RESCHEDULE_MAX_FROM_CREATION_MS;
  if (createdAtMs !== undefined && epochMs - createdAtMs > maxFromCreationMs) {
    throw new PostValidationError(
      'schedule_reschedule_window',
      `scheduled_publish_time ${utc} is ${days(epochMs - createdAtMs)} days after the post was created (${new Date(createdAtMs).toISOString()}); a scheduled post can only be moved up to ${days(maxFromCreationMs)} days past its creation. Delete it and create a new post for a later date (CC-SCHED-1).`,
      'scheduled_publish_time',
    );
  }

  const pageTimezone = ctx.pageTimezone;
  const pageLocal =
    pageTimezone !== undefined ? formatInTimeZone(epochMs, pageTimezone) : undefined;

  return {
    input: typeof value === 'string' ? value.trim() : String(value),
    epochSeconds: Math.floor(epochMs / 1000),
    epochMs,
    utc,
    leadMs,
    ...(pageTimezone !== undefined ? { pageTimezone } : {}),
    ...(pageLocal !== undefined ? { pageLocal } : {}),
    windowNote: `Accepted scheduling window: at least ${minutes(minLeadMs)} minutes and at most ${days(maxLeadMs)} days from now.`,
    timezoneCaveat: SCHEDULE_TIMEZONE_CAVEAT,
  };
}

/** The advisory lines a resolved schedule adds to a preview (never blocking). */
export function scheduleWarnings(echo: ScheduleEcho): string[] {
  const warnings: string[] = [];
  if (echo.leadMs > SCHEDULE_WARN_LEAD_MS) {
    warnings.push(
      `This post is scheduled ${days(echo.leadMs)} days out. Some publishing surfaces cap scheduling at ${days(SCHEDULE_WARN_LEAD_MS)} days, so Meta may still refuse it (CC-SCHED-1).`,
    );
  }
  if (echo.pageTimezone === undefined) {
    warnings.push(
      'The Page timezone is unknown, so the schedule is echoed in UTC only. Pass page_timezone (an IANA name such as "Europe/Sofia") to also see the Page-local rendering (CC-SCHED-2).',
    );
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// 4. Creating a feed post
// ---------------------------------------------------------------------------

/** One card of a multi-link carousel (CC-PUB-10). */
export interface ChildAttachment {
  readonly link: string;
  readonly name?: string;
  readonly description?: string;
  readonly picture?: string;
}

/** What the operator asked `facebook_create_post` to publish. */
export interface CreatePostInput {
  readonly pageId: string;
  readonly message?: string;
  readonly link?: string;
  readonly published?: boolean;
  /** Raw, unvalidated — {@link resolveSchedule} owns the parsing. */
  readonly scheduledPublishTime?: unknown;
  readonly childAttachments?: readonly ChildAttachment[];
  /** How many photo sources become carousel children (0 ⇒ a text/link post). */
  readonly photoCount?: number;
}

/** Whether the post goes live now, waits as a draft, or waits for a clock. */
export type PublishState = 'published' | 'draft' | 'scheduled';

/** The fully validated shape of one write, shared by preview and apply. */
export interface PostPlan {
  /** The Graph body, minus any `attached_media` the tool layer adds later. */
  readonly params: Readonly<Record<string, ParamValue>>;
  readonly summary: string;
  readonly warnings: readonly string[];
  readonly schedule?: ScheduleEcho;
  readonly publishState: PublishState;
}

function assertMessageLength(message: string | undefined): void {
  if (message === undefined) return;
  if (message.length > POST_MESSAGE_MAX_CHARS) {
    throw new PostValidationError(
      'message_too_long',
      `message is ${String(message.length)} characters; the Page-post limit is ${String(POST_MESSAGE_MAX_CHARS)} (CC-PUB-7).`,
      'message',
    );
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length > 0 ? value : undefined;
}

/**
 * The "when" half of a create summary. Shared by every create planner so a text
 * post, a photo post and a video post describe the same schedule identically —
 * the operator compares previews across tools, and a wording difference would
 * read as a behaviour difference.
 */
function describeWhen(
  publishState: PublishState,
  schedule: ScheduleEcho | undefined,
): string {
  if (schedule === undefined) {
    return publishState === 'draft' ? 'as an unpublished draft' : 'immediately';
  }
  const local =
    schedule.pageLocal !== undefined
      ? ` = ${schedule.pageLocal} (${schedule.pageTimezone ?? 'Page time'})`
      : '';
  return `scheduled for ${schedule.utc} (UTC)${local}`;
}

/**
 * Validate one `facebook_create_post` call and build its `/feed` body.
 *
 * Everything checkable without the network is checked HERE, so the dry run an
 * operator approves is the same decision the apply re-makes: field
 * combinations, the carousel bounds, the text ceiling and the schedule window.
 *
 * @throws PostValidationError
 */
export function planCreatePost(
  input: CreatePostInput,
  ctx: { readonly nowMs: number; readonly pageTimezone?: string },
): PostPlan {
  const message = nonEmpty(input.message?.trim() === '' ? undefined : input.message);
  const link = nonEmpty(input.link?.trim());
  const children = input.childAttachments;
  const photoCount = input.photoCount ?? 0;

  if (message === undefined && link === undefined && photoCount === 0) {
    throw new PostValidationError(
      'empty_post',
      'nothing to post: supply at least one of message, link or photos.',
    );
  }
  assertMessageLength(message);

  if (children !== undefined) {
    if (
      children.length < CHILD_ATTACHMENTS_MIN ||
      children.length > CHILD_ATTACHMENTS_MAX
    ) {
      throw new PostValidationError(
        'child_attachments_range',
        `child_attachments has ${String(children.length)} entries; a multi-link carousel needs between ${String(CHILD_ATTACHMENTS_MIN)} and ${String(CHILD_ATTACHMENTS_MAX)} (CC-PUB-10).`,
        'child_attachments',
      );
    }
    if (link === undefined) {
      throw new PostValidationError(
        'conflicting_params',
        'child_attachments describes the cards of a multi-link carousel and requires the parent `link` to be set as well.',
        'child_attachments',
      );
    }
    if (photoCount > 0) {
      throw new PostValidationError(
        'conflicting_params',
        'child_attachments (a multi-link carousel) and photos (a photo carousel) are two different post types — send one or the other, not both.',
        'child_attachments',
      );
    }
  }

  if (photoCount > 0 && link !== undefined) {
    throw new PostValidationError(
      'conflicting_params',
      'a photo post cannot also carry a `link`: Facebook renders either the photos or the link preview, never both. Drop one of them.',
      'link',
    );
  }

  let schedule: ScheduleEcho | undefined;
  let publishState: PublishState;
  if (input.scheduledPublishTime !== undefined) {
    if (input.published === true) {
      throw new PostValidationError(
        'conflicting_params',
        'a scheduled post is created unpublished and goes live on its own — published:true and scheduled_publish_time contradict each other. Drop published:true (CC-SCHED-5).',
        'published',
      );
    }
    schedule = resolveSchedule(input.scheduledPublishTime, {
      nowMs: ctx.nowMs,
      ...(ctx.pageTimezone !== undefined ? { pageTimezone: ctx.pageTimezone } : {}),
    });
    publishState = 'scheduled';
  } else {
    publishState = input.published === false ? 'draft' : 'published';
  }

  const params: Record<string, ParamValue> = {
    ...(message !== undefined ? { message } : {}),
    ...(link !== undefined ? { link } : {}),
    ...(children !== undefined ? { child_attachments: JSON.stringify(children) } : {}),
    ...(publishState === 'published' ? {} : { published: false }),
    ...(schedule !== undefined ? { scheduled_publish_time: schedule.epochSeconds } : {}),
  };

  const warnings: string[] = [PUBLISH_VERIFY_NOTE, POST_YEAR_CAP_NOTE];
  if (message !== undefined)
    warnings.push(DUPLICATE_CONTENT_NOTE, UNICODE_PASSTHROUGH_NOTE);
  if (link !== undefined) warnings.push(LINK_PREVIEW_NOTE);
  if (publishState === 'draft') warnings.push(DRAFT_TRANSITION_NOTE);
  if (schedule !== undefined) warnings.push(...scheduleWarnings(schedule));

  const what =
    photoCount > 0
      ? `a ${String(photoCount)}-photo post`
      : children !== undefined
        ? `a ${String(children.length)}-card link carousel`
        : link !== undefined
          ? 'a link post'
          : 'a text post';
  return {
    params,
    summary: `Create ${what} on Page ${input.pageId} ${describeWhen(publishState, schedule)}.`,
    warnings,
    ...(schedule !== undefined ? { schedule } : {}),
    publishState,
  };
}

// ---------------------------------------------------------------------------
// 4b. Creating a video post (CC-MEDIA-6/7)
// ---------------------------------------------------------------------------

/**
 * How the bytes reach Meta. `resumable-upload` streams a local file through the
 * chunked `/videos` session; `file-url` hands Meta a public URL and Meta does
 * the fetching — the two have different failure modes, so the plan names which
 * one an operator is approving.
 */
export type VideoDelivery = 'resumable-upload' | 'file-url';

export interface VideoPostInput {
  readonly pageId: string;
  readonly delivery: VideoDelivery;
  /** The path or URL exactly as the operator supplied it, for the summary. */
  readonly sourceLabel: string;
  readonly description?: string;
  readonly title?: string;
  readonly published?: boolean;
  readonly scheduledPublishTime?: unknown;
  /** Known for a local file (already stat'ed); absent for a `file_url`. */
  readonly byteLength?: number;
}

/**
 * Validate one `facebook_create_video_post` call and build the params the
 * finish phase (or the `file_url` body) carries.
 *
 * The same publish/schedule contract as a text post applies — a video is still
 * a Page post — but the honesty notes differ: a completed upload is a CREATED
 * video, not a published, encoded one (CC-MEDIA-7), and nothing about the file
 * itself (codec, duration, aspect) is inspected locally (C10).
 *
 * @throws PostValidationError
 */
export function planVideoPost(
  input: VideoPostInput,
  ctx: { readonly nowMs: number; readonly pageTimezone?: string },
): PostPlan {
  const description = nonEmpty(
    input.description?.trim() === '' ? undefined : input.description,
  );
  const title = nonEmpty(input.title?.trim());
  assertMessageLength(description);

  let schedule: ScheduleEcho | undefined;
  let publishState: PublishState;
  if (input.scheduledPublishTime !== undefined) {
    if (input.published === true) {
      throw new PostValidationError(
        'conflicting_params',
        'a scheduled video is created unpublished and goes live on its own — published:true and scheduled_publish_time contradict each other. Drop published:true (CC-SCHED-5).',
        'published',
      );
    }
    schedule = resolveSchedule(input.scheduledPublishTime, {
      nowMs: ctx.nowMs,
      ...(ctx.pageTimezone !== undefined ? { pageTimezone: ctx.pageTimezone } : {}),
    });
    publishState = 'scheduled';
  } else {
    publishState = input.published === false ? 'draft' : 'published';
  }

  const params: Record<string, ParamValue> = {
    ...(description !== undefined ? { description } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(publishState === 'published' ? {} : { published: false }),
    ...(schedule !== undefined ? { scheduled_publish_time: schedule.epochSeconds } : {}),
    ...(input.delivery === 'file-url' ? { file_url: input.sourceLabel } : {}),
  };

  const warnings: string[] = [
    PUBLISH_VERIFY_NOTE,
    VIDEO_CREATED_NOT_READY_NOTE,
    POST_YEAR_CAP_NOTE,
    // C10: no local decode happens, so say so instead of implying a pre-flight check.
    'The file is not decoded locally, so container, codec, duration and resolution are validated only by Meta — a violation surfaces during encoding, after the bytes have already been transferred.',
  ];
  if (description !== undefined) warnings.push(UNICODE_PASSTHROUGH_NOTE);
  if (publishState === 'draft') warnings.push(DRAFT_TRANSITION_NOTE);
  if (input.delivery === 'file-url') {
    warnings.push(
      'Meta fetches file_url from its own network, so the URL must be publicly reachable without credentials; a fetch failure surfaces asynchronously on the video object, not in this call.',
    );
  }
  if (schedule !== undefined) warnings.push(...scheduleWarnings(schedule));

  const from =
    input.delivery === 'file-url'
      ? `from URL ${input.sourceLabel}`
      : `from local file ${input.sourceLabel}${input.byteLength !== undefined ? ` (${String(input.byteLength)} bytes)` : ''}`;

  return {
    params,
    summary: `Create a video post on Page ${input.pageId} ${from} ${describeWhen(publishState, schedule)}.`,
    warnings,
    ...(schedule !== undefined ? { schedule } : {}),
    publishState,
  };
}

// ---------------------------------------------------------------------------
// 5. Updating a post — edits plus the scheduled-post lifecycle (CC-SCHED-5)
// ---------------------------------------------------------------------------

/** The lifecycle verbs `facebook_update_post` covers (A13 / CC-SCHED-5). */
export const UPDATE_POST_ACTIONS = [
  'edit',
  'publish_now',
  'reschedule',
  'cancel_schedule',
] as const;

export type UpdatePostAction = (typeof UPDATE_POST_ACTIONS)[number];

export interface UpdatePostInput {
  readonly postId: string;
  readonly action: UpdatePostAction;
  readonly message?: string;
  readonly isHidden?: boolean;
  readonly isPinned?: boolean;
  readonly scheduledPublishTime?: unknown;
}

export interface UpdatePostPlan {
  readonly params: Readonly<Record<string, ParamValue>>;
  readonly summary: string;
  readonly warnings: readonly string[];
  readonly schedule?: ScheduleEcho;
  readonly action: UpdatePostAction;
}

function assertNoContentFields(input: UpdatePostInput, verb: string): void {
  const supplied = [
    input.message !== undefined ? 'message' : undefined,
    input.isHidden !== undefined ? 'is_hidden' : undefined,
    input.isPinned !== undefined ? 'is_pinned' : undefined,
  ].filter((f): f is string => f !== undefined);
  if (supplied.length > 0) {
    throw new PostValidationError(
      'conflicting_params',
      `action "${verb}" is a lifecycle transition and takes no content fields, but ${supplied.join(', ')} was supplied. Run the content edit as a separate action:"edit" call.`,
      supplied[0],
    );
  }
}

/**
 * Validate one `facebook_update_post` call and build its `POST /{post-id}` body.
 *
 * `cancel_schedule` is deliberately refused rather than emulated: Graph has no
 * un-schedule transition, and the only way to stop a scheduled post is to delete
 * it — an irreversible act that must go through the irreversible gate rather
 * than ride inside a reversible edit.
 *
 * @throws PostValidationError
 */
export function planUpdatePost(
  input: UpdatePostInput,
  ctx: {
    readonly nowMs: number;
    readonly pageTimezone?: string;
    readonly createdAtMs?: number;
  },
): UpdatePostPlan {
  const warnings: string[] = [EDIT_OWN_APP_NOTE];

  if (input.action === 'cancel_schedule') {
    throw new PostValidationError(
      'unsupported_transition',
      `Facebook has no un-schedule transition: cancelling a scheduled post removes it. Call facebook_delete_post with post_id "${input.postId}" instead — it is an irreversible-tier tool, so it needs its own dry run and the plan_id that dry run returns (CC-SCHED-5).`,
      'action',
    );
  }

  if (input.action === 'edit') {
    if (input.scheduledPublishTime !== undefined) {
      throw new PostValidationError(
        'conflicting_params',
        'action "edit" does not move a publish time. Use action:"reschedule" with scheduled_publish_time (CC-SCHED-5).',
        'scheduled_publish_time',
      );
    }
    assertMessageLength(input.message);
    if (
      input.message === undefined &&
      input.isHidden === undefined &&
      input.isPinned === undefined
    ) {
      throw new PostValidationError(
        'no_update_fields',
        'action "edit" needs at least one of message, is_hidden or is_pinned.',
      );
    }
    const params: Record<string, ParamValue> = {
      ...(input.message !== undefined ? { message: input.message } : {}),
      ...(input.isHidden !== undefined ? { is_hidden: input.isHidden } : {}),
      ...(input.isPinned !== undefined ? { is_pinned: input.isPinned } : {}),
    };
    if (input.message !== undefined) warnings.push(UNICODE_PASSTHROUGH_NOTE);
    return {
      params,
      summary: `Edit post ${input.postId} (${Object.keys(params).join(', ')}).`,
      warnings,
      action: input.action,
    };
  }

  if (input.action === 'publish_now') {
    assertNoContentFields(input, 'publish_now');
    if (input.scheduledPublishTime !== undefined) {
      throw new PostValidationError(
        'conflicting_params',
        'action "publish_now" publishes immediately and therefore takes no scheduled_publish_time. Use action:"reschedule" to move the time instead (CC-SCHED-5).',
        'scheduled_publish_time',
      );
    }
    warnings.push(SCHEDULE_RACE_NOTE, PUBLISH_VERIFY_NOTE);
    return {
      params: { is_published: true },
      summary: `Publish scheduled/draft post ${input.postId} right now.`,
      warnings,
      action: input.action,
    };
  }

  // action === 'reschedule'
  assertNoContentFields(input, 'reschedule');
  if (input.scheduledPublishTime === undefined) {
    throw new PostValidationError(
      'schedule_missing',
      `action "reschedule" needs scheduled_publish_time. ${SCHEDULE_FORMAT_HELP}`,
      'scheduled_publish_time',
    );
  }
  const schedule = resolveSchedule(input.scheduledPublishTime, {
    nowMs: ctx.nowMs,
    ...(ctx.pageTimezone !== undefined ? { pageTimezone: ctx.pageTimezone } : {}),
    ...(ctx.createdAtMs !== undefined
      ? { window: { createdAtMs: ctx.createdAtMs } }
      : {}),
  });
  warnings.push(SCHEDULE_RACE_NOTE, ...scheduleWarnings(schedule));
  return {
    params: { scheduled_publish_time: schedule.epochSeconds },
    summary: `Move post ${input.postId} to ${schedule.utc} (UTC)${schedule.pageLocal !== undefined ? ` = ${schedule.pageLocal} (${schedule.pageTimezone ?? 'Page time'})` : ''}.`,
    warnings,
    schedule,
    action: input.action,
  };
}

// ---------------------------------------------------------------------------
// 6. Deleting a post
// ---------------------------------------------------------------------------

export interface DeletePostPlan {
  readonly params: Readonly<Record<string, ParamValue>>;
  readonly summary: string;
  readonly warnings: readonly string[];
}

/** The (parameterless) delete plan plus the notices its preview must carry. */
export function planDeletePost(input: { readonly postId: string }): DeletePostPlan {
  return {
    params: { post_id: input.postId },
    summary: `Permanently delete post ${input.postId}.`,
    warnings: [DELETE_PERMANENT_NOTE, EDIT_OWN_APP_NOTE, DELETE_ALREADY_ABSENT_NOTE],
  };
}

// ---------------------------------------------------------------------------
// 7. Request builders — one definition each, used by preview and apply alike
// ---------------------------------------------------------------------------

/** Token / timeout / abort seams every builder forwards unchanged. */
export interface RequestScope {
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

function scopeOf(scope: RequestScope) {
  return {
    ...(scope.token !== undefined ? { token: scope.token } : {}),
    ...(scope.timeoutMs !== undefined ? { timeoutMs: scope.timeoutMs } : {}),
    ...(scope.signal !== undefined ? { signal: scope.signal } : {}),
  };
}

/** `POST /{page-id}/feed`. Params ride in the BODY so text stays out of URLs. */
export function feedPostRequest(
  pageId: string,
  body: Readonly<Record<string, ParamValue>>,
  scope: RequestScope = {},
): JsonRequest {
  return {
    protocol: 'json',
    method: 'POST',
    host: 'graph',
    path: `/${pageId}/${FEED_EDGE}`,
    body,
    ...scopeOf(scope),
  };
}

/** `POST /{page-id}/videos` with a remote `file_url` (Meta does the fetching). */
export function videoByUrlRequest(
  pageId: string,
  body: Readonly<Record<string, ParamValue>>,
  scope: RequestScope = {},
): JsonRequest {
  return {
    protocol: 'json',
    method: 'POST',
    host: 'graph-video',
    path: `/${pageId}/${VIDEOS_EDGE}`,
    body,
    ...scopeOf(scope),
  };
}

/** `POST /{post-id}` — the edit and lifecycle transitions. */
export function updatePostRequest(
  postId: string,
  body: Readonly<Record<string, ParamValue>>,
  scope: RequestScope = {},
): JsonRequest {
  return {
    protocol: 'json',
    method: 'POST',
    host: 'graph',
    path: `/${postId}`,
    body,
    ...scopeOf(scope),
  };
}

/** `DELETE /{post-id}`. */
export function deletePostRequest(postId: string, scope: RequestScope = {}): JsonRequest {
  return {
    protocol: 'json',
    method: 'DELETE',
    host: 'graph',
    path: `/${postId}`,
    ...scopeOf(scope),
  };
}

/** `GET /{post-id}?fields=…` — the before/after read behind divergence checks. */
export function postStateRequest(postId: string, scope: RequestScope = {}): JsonRequest {
  return {
    protocol: 'json',
    method: 'GET',
    host: 'graph',
    path: `/${postId}`,
    params: { fields: POST_STATE_FIELDS },
    ...scopeOf(scope),
  };
}

/** `GET /{page-id}?fields=timezone` — display-only Page metadata (CC-SCHED-2). */
export function pageTimezoneRequest(
  pageId: string,
  scope: RequestScope = {},
): JsonRequest {
  return {
    protocol: 'json',
    method: 'GET',
    host: 'graph',
    path: `/${pageId}`,
    params: { fields: 'id,timezone' },
    ...scopeOf(scope),
  };
}

/** The cursor-paginated scheduled queue, ready for `fetchPage`/`fetchAll`. */
export function scheduledPostsEdge(
  pageId: string,
  scope: RequestScope = {},
): EdgeRequest {
  return {
    host: 'graph',
    path: `/${pageId}/${SCHEDULED_POSTS_EDGE}`,
    params: { fields: SCHEDULED_POST_FIELDS },
    ...scopeOf(scope),
  };
}

// ---------------------------------------------------------------------------
// 8. Reading a post's state (divergence detection + already-absent semantics)
// ---------------------------------------------------------------------------

/**
 * Graph codes that mean "this object is not there" rather than "your request was
 * wrong": 100/33 is the documented nonexistent-node answer and 803 is the older
 * alias. Anything else propagates untouched.
 */
const ABSENT_SUBCODE = 33;
const ABSENT_CODES = new Set([100, 803]);
const ABSENT_MESSAGE_RE =
  /does not exist|cannot be loaded|unsupported get request|missing permissions/i;

/** Whether an error means the post is already gone (CC-PUB-5). */
export function isPostAbsentError(err: unknown): boolean {
  if (!(err instanceof GraphApiError)) return false;
  if (err.code === 803) return true;
  if (!ABSENT_CODES.has(err.code)) return false;
  return err.subcode === ABSENT_SUBCODE || ABSENT_MESSAGE_RE.test(err.message);
}

/** The stable projection of a post that plan and apply compare (C4). */
export interface PostState {
  /** `false` ⇒ the post is not there (deleted, never existed, or invisible). */
  readonly present: boolean;
  readonly id?: string;
  readonly message?: string;
  readonly isPublished?: boolean;
  readonly isHidden?: boolean;
  /** Unix SECONDS, as Graph reports it. */
  readonly scheduledPublishTime?: number;
  readonly createdTime?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/**
 * Project a raw post node onto {@link PostState}. Deliberately narrow: fields
 * that move on their own (comment counts, `updated_time`) would make every apply
 * look diverged, so only operator-controlled state is compared (CC-NET-2 style
 * defensive parsing throughout — every field may be missing or mistyped).
 */
export function normalizePostState(raw: unknown): PostState {
  if (typeof raw !== 'object' || raw === null) return { present: false };
  const node = raw as Record<string, unknown>;
  const id = str(node['id']);
  if (id === undefined) return { present: false };
  return {
    present: true,
    id,
    ...(str(node['message']) !== undefined ? { message: str(node['message']) } : {}),
    ...(bool(node['is_published']) !== undefined
      ? { isPublished: bool(node['is_published']) }
      : {}),
    ...(bool(node['is_hidden']) !== undefined
      ? { isHidden: bool(node['is_hidden']) }
      : {}),
    ...(num(node['scheduled_publish_time']) !== undefined
      ? { scheduledPublishTime: num(node['scheduled_publish_time']) }
      : {}),
    ...(str(node['created_time']) !== undefined
      ? { createdTime: str(node['created_time']) }
      : {}),
  };
}

/**
 * Read a post's comparable state. A genuinely absent post is data (`present:
 * false`), not a failure — delete needs to treat it as the intended end state
 * (CC-PUB-5) and update needs it to fail with a diff rather than a stack trace.
 * Every other Graph error propagates unchanged.
 */
export async function readPostState(
  fbRequest: FbRequestFn,
  postId: string,
  scope: RequestScope = {},
): Promise<PostState> {
  try {
    const res = await fbRequest<unknown>(postStateRequest(postId, scope));
    return normalizePostState(res.data);
  } catch (err) {
    if (isPostAbsentError(err)) return { present: false };
    throw err;
  }
}

/** The post's creation instant in epoch ms, when Graph reported a usable one. */
export function createdAtMsOf(state: PostState): number | undefined {
  if (state.createdTime === undefined) return undefined;
  const ms = Date.parse(state.createdTime);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Best-effort Page timezone for the schedule echo. Display-only, so an
 * unreadable or non-IANA value degrades to `undefined` (the plan then says the
 * timezone is unknown) instead of blocking a write on cosmetics.
 */
export async function readPageTimezone(
  fbRequest: FbRequestFn,
  pageId: string,
  scope: RequestScope = {},
): Promise<string | undefined> {
  try {
    const res = await fbRequest<unknown>(pageTimezoneRequest(pageId, scope));
    const node = res.data;
    if (typeof node !== 'object' || node === null) return undefined;
    return resolvePageTimezone((node as Record<string, unknown>)['timezone']);
  } catch {
    return undefined;
  }
}
