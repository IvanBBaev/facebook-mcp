// Tests for the posts planning/validation layer.
//
// These cover the decisions a preview must make BEFORE it is shown to an
// operator: the scheduling contract (CC-SCHED-1/2/3), the field-combination
// rules (CC-PUB-6/7/9/10), the request builders and the post-state projection
// that backs divergence detection. No test touches the network — the only Graph
// calls here go through the injected fake.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GraphApiError } from '../core/index.js';
import {
  createFakeClock,
  createFakeFbRequest,
  fbErr,
  fbOk,
} from '../core/fakes/index.js';
import type { JsonRequest } from '../core/index.js';
import {
  CHILD_ATTACHMENTS_MAX,
  CHILD_ATTACHMENTS_MIN,
  CarouselPostError,
  DRAFT_TRANSITION_NOTE,
  POST_MESSAGE_MAX_CHARS,
  POST_STATE_FIELDS,
  PostValidationError,
  RESCHEDULE_MAX_FROM_CREATION_MS,
  SCHEDULED_POST_FIELDS,
  SCHEDULE_MAX_LEAD_MS,
  SCHEDULE_MIN_LEAD_MS,
  SCHEDULE_WARN_LEAD_MS,
  VIDEO_CREATED_NOT_READY_NOTE,
  assertLocalMediaSource,
  createdAtMsOf,
  deletePostRequest,
  feedPostRequest,
  formatInTimeZone,
  isPostAbsentError,
  isSupportedTimeZone,
  normalizePostState,
  pageTimezoneRequest,
  parseScheduledPublishTime,
  planCreatePost,
  planDeletePost,
  planUpdatePost,
  planVideoPost,
  postStateRequest,
  readPageTimezone,
  readPostState,
  resolvePageTimezone,
  resolveSchedule,
  scheduleWarnings,
  scheduledPostsEdge,
  toMediaSource,
  updatePostRequest,
  videoByUrlRequest,
} from './posts-write.js';

// Every schedule test measures against a FAKE clock, never the wall clock: the
// window bounds are time-relative, so a real `Date.now()` here would make these
// assertions drift with the calendar.
const clock = createFakeClock(Date.parse('2026-07-15T00:00:00.000Z'));
const NOW_MS = clock.now();
const CREATED_TIME = '2026-07-15T00:00:00+0000';
const PAGE_ID = '111';
const POST_ID = '111_222';

function hours(n: number): number {
  return n * 60 * 60 * 1000;
}

function isoAt(offsetMs: number): string {
  return new Date(NOW_MS + offsetMs).toISOString();
}

function expectValidationError(fn: () => unknown, reason: string): PostValidationError {
  try {
    fn();
  } catch (err) {
    assert.ok(
      err instanceof PostValidationError,
      `expected PostValidationError, got ${String(err)}`,
    );
    assert.equal(err.reason, reason);
    return err;
  }
  throw new Error(
    `expected a PostValidationError with reason "${reason}", but nothing was thrown`,
  );
}

// ---------------------------------------------------------------------------
// parseScheduledPublishTime — CC-SCHED-2/3
// ---------------------------------------------------------------------------

test('parseScheduledPublishTime accepts an ISO instant with a numeric offset', () => {
  assert.equal(
    parseScheduledPublishTime('2026-08-01T09:30:00+03:00'),
    Date.parse('2026-08-01T06:30:00Z'),
  );
});

test('parseScheduledPublishTime accepts a Z-suffixed instant', () => {
  assert.equal(
    parseScheduledPublishTime('2026-08-01T06:30:00Z'),
    Date.parse('2026-08-01T06:30:00Z'),
  );
});

test('parseScheduledPublishTime accepts a compact +HHMM offset', () => {
  assert.equal(
    parseScheduledPublishTime('2026-08-01T09:30:00+0300'),
    Date.parse('2026-08-01T06:30:00Z'),
  );
});

test('parseScheduledPublishTime rejects a bare local time and says what to send', () => {
  const err = expectValidationError(
    () => parseScheduledPublishTime('2026-08-01T09:30:00'),
    'schedule_format',
  );
  assert.match(err.message, /no UTC offset/);
  assert.match(err.message, /2026-08-01T09:30:00\+03:00/);
  assert.equal(err.field, 'scheduled_publish_time');
});

test('parseScheduledPublishTime rejects a bare epoch-seconds number', () => {
  const err = expectValidationError(
    () => parseScheduledPublishTime(1_785_000_000),
    'schedule_format',
  );
  assert.match(err.message, /1785000000/);
  assert.match(err.message, /Bare epoch values are not accepted/);
  assert.match(err.message, /ISO-8601/);
});

test('parseScheduledPublishTime rejects an epoch value passed as a digit string', () => {
  const err = expectValidationError(
    () => parseScheduledPublishTime('1785000000'),
    'schedule_format',
  );
  assert.match(err.message, /seconds\/milliseconds unit/);
});

test('parseScheduledPublishTime rejects a date-only value', () => {
  expectValidationError(() => parseScheduledPublishTime('2026-08-01'), 'schedule_format');
});

test('parseScheduledPublishTime rejects an empty string and a non-string', () => {
  expectValidationError(() => parseScheduledPublishTime('   '), 'schedule_format');
  expectValidationError(() => parseScheduledPublishTime(null), 'schedule_format');
});

test('parseScheduledPublishTime rejects an impossible calendar instant', () => {
  const err = expectValidationError(
    () => parseScheduledPublishTime('2026-02-31T09:30:00+03:00'),
    'schedule_format',
  );
  assert.match(err.message, /not a real calendar instant/);
});

// ---------------------------------------------------------------------------
// resolveSchedule — the window (CC-SCHED-1) and the dual echo (CC-SCHED-2)
// ---------------------------------------------------------------------------

test('resolveSchedule rejects a time inside the minimum lead window', () => {
  const err = expectValidationError(
    () => resolveSchedule(isoAt(SCHEDULE_MIN_LEAD_MS - 60_000), { nowMs: NOW_MS }),
    'schedule_too_soon',
  );
  assert.match(err.message, /at least 10 minutes/);
});

test('resolveSchedule accepts a time exactly at the minimum lead', () => {
  const echo = resolveSchedule(isoAt(SCHEDULE_MIN_LEAD_MS), { nowMs: NOW_MS });
  assert.equal(echo.leadMs, SCHEDULE_MIN_LEAD_MS);
});

test('resolveSchedule rejects a time past the maximum lead window', () => {
  const err = expectValidationError(
    () => resolveSchedule(isoAt(SCHEDULE_MAX_LEAD_MS + hours(24)), { nowMs: NOW_MS }),
    'schedule_too_far',
  );
  assert.match(err.message, /window ends 75 days from now/);
});

test('resolveSchedule accepts a time exactly at the maximum lead', () => {
  const echo = resolveSchedule(isoAt(SCHEDULE_MAX_LEAD_MS), { nowMs: NOW_MS });
  assert.equal(echo.leadMs, SCHEDULE_MAX_LEAD_MS);
});

test('resolveSchedule bounds a reschedule relative to the post creation time', () => {
  const createdAtMs = NOW_MS - hours(24 * 5);
  const err = expectValidationError(
    () =>
      resolveSchedule(isoAt(hours(24 * 25)), {
        nowMs: NOW_MS,
        window: { createdAtMs },
      }),
    'schedule_reschedule_window',
  );
  assert.match(err.message, /30 days after the post was created/);
  assert.match(err.message, /up to 29 days past its creation/);
});

test('resolveSchedule allows a reschedule inside the creation-relative bound', () => {
  const createdAtMs = NOW_MS - hours(24 * 5);
  const echo = resolveSchedule(isoAt(hours(24 * 20)), {
    nowMs: NOW_MS,
    window: { createdAtMs },
  });
  assert.ok(echo.epochMs - createdAtMs <= RESCHEDULE_MAX_FROM_CREATION_MS);
});

test('resolveSchedule echoes the instant in UTC and in the Page timezone', () => {
  const echo = resolveSchedule('2026-08-01T09:30:00+03:00', {
    nowMs: NOW_MS,
    pageTimezone: 'Europe/Sofia',
  });
  assert.equal(echo.utc, '2026-08-01T06:30:00.000Z');
  assert.equal(echo.epochSeconds, Math.floor(Date.parse('2026-08-01T06:30:00Z') / 1000));
  assert.equal(echo.pageTimezone, 'Europe/Sofia');
  assert.ok(echo.pageLocal !== undefined);
  // Europe/Sofia is UTC+3 in August, so the Page sees the wall time it asked for.
  assert.match(echo.pageLocal, /2026-08-01/);
  assert.match(echo.pageLocal, /09:30/);
  assert.match(echo.timezoneCaveat, /Page's own timezone/);
});

test('resolveSchedule keeps the wire value in seconds, not milliseconds', () => {
  const echo = resolveSchedule('2026-08-01T06:30:45.500Z', { nowMs: NOW_MS });
  assert.equal(echo.epochSeconds, Math.floor(echo.epochMs / 1000));
  assert.ok(echo.epochSeconds < 10_000_000_000);
});

test('resolveSchedule omits the Page-local echo when no timezone is known', () => {
  const echo = resolveSchedule(isoAt(hours(48)), { nowMs: NOW_MS });
  assert.equal(echo.pageTimezone, undefined);
  assert.equal(echo.pageLocal, undefined);
});

test('resolveSchedule drops an unusable Page timezone instead of throwing', () => {
  const echo = resolveSchedule(isoAt(hours(48)), {
    nowMs: NOW_MS,
    pageTimezone: 'Mars/Olympus_Mons',
  });
  assert.equal(echo.pageLocal, undefined);
});

test('scheduleWarnings flags a far-out schedule without blocking it', () => {
  const echo = resolveSchedule(isoAt(SCHEDULE_WARN_LEAD_MS + hours(48)), {
    nowMs: NOW_MS,
    pageTimezone: 'Europe/Sofia',
  });
  const warnings = scheduleWarnings(echo);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /cap scheduling at 30 days/);
});

test('scheduleWarnings asks for page_timezone when the zone is unknown', () => {
  const echo = resolveSchedule(isoAt(hours(48)), { nowMs: NOW_MS });
  const warnings = scheduleWarnings(echo);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /page_timezone/);
});

test('scheduleWarnings stays silent for a nearby schedule with a known zone', () => {
  const echo = resolveSchedule(isoAt(hours(48)), {
    nowMs: NOW_MS,
    pageTimezone: 'Europe/Sofia',
  });
  assert.deepEqual(scheduleWarnings(echo), []);
});

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

test('isSupportedTimeZone separates real IANA zones from nonsense', () => {
  assert.equal(isSupportedTimeZone('America/New_York'), true);
  assert.equal(isSupportedTimeZone('Nowhere/Nothing'), false);
});

test('resolvePageTimezone accepts an IANA name and rejects a numeric offset', () => {
  assert.equal(resolvePageTimezone('Europe/Sofia'), 'Europe/Sofia');
  assert.equal(resolvePageTimezone(' Europe/Sofia '), 'Europe/Sofia');
  // Meta's legacy Page `timezone` field can be a numeric UTC offset — unusable.
  assert.equal(resolvePageTimezone(3), undefined);
  assert.equal(resolvePageTimezone('UTC'), undefined);
  assert.equal(resolvePageTimezone(''), undefined);
  assert.equal(resolvePageTimezone(undefined), undefined);
});

test('formatInTimeZone returns undefined for an unusable zone', () => {
  assert.equal(formatInTimeZone(NOW_MS, 'Nowhere/Nothing'), undefined);
  assert.ok((formatInTimeZone(NOW_MS, 'UTC') ?? '').includes('2026-07-15'));
});

// ---------------------------------------------------------------------------
// Media references — the source allowlist front door (CC-MEDIA-4/5)
// ---------------------------------------------------------------------------

test('toMediaSource classifies any scheme:// reference as a URL, not a path', () => {
  assert.deepEqual(toMediaSource('https://cdn.example/a.jpg'), {
    kind: 'url',
    url: 'https://cdn.example/a.jpg',
  });
  // http:// must NOT fall through to the path resolver, or the operator would
  // get a bogus "file not found" instead of the real scheme refusal.
  assert.deepEqual(toMediaSource('http://cdn.example/a.jpg'), {
    kind: 'url',
    url: 'http://cdn.example/a.jpg',
  });
  assert.deepEqual(toMediaSource('  photos/a.jpg  '), {
    kind: 'local',
    path: 'photos/a.jpg',
  });
});

test('assertLocalMediaSource refuses a URL for a bytes-only flow and names the field', () => {
  assert.equal(
    assertLocalMediaSource('clips/reel.mp4', 'video', 'why'),
    'clips/reel.mp4',
  );
  const err = expectValidationError(
    () =>
      assertLocalMediaSource(
        'https://cdn.example/reel.mp4',
        'video',
        'Reels are uploaded from local bytes only.',
      ),
    'unsupported_media_source',
  );
  assert.equal(err.field, 'video');
  assert.match(err.message, /local bytes only/);
});

// ---------------------------------------------------------------------------
// planCreatePost — CC-PUB-6/7/9/10
// ---------------------------------------------------------------------------

test('planCreatePost builds an immediate text post', () => {
  const plan = planCreatePost({ pageId: PAGE_ID, message: 'hello' }, { nowMs: NOW_MS });
  assert.deepEqual(plan.params, { message: 'hello' });
  assert.equal(plan.publishState, 'published');
  assert.match(plan.summary, /Create a text post on Page 111 immediately/);
  assert.ok(plan.warnings.some((w) => /Never re-send it blindly/.test(w)));
  assert.ok(plan.warnings.some((w) => /duplicate content/.test(w)));
});

test('planCreatePost accepts a link-only post and notes the scrape caveat', () => {
  const plan = planCreatePost(
    { pageId: PAGE_ID, link: 'https://e.example' },
    { nowMs: NOW_MS },
  );
  assert.deepEqual(plan.params, { link: 'https://e.example' });
  assert.ok(plan.warnings.some((w) => /scraped by Facebook/.test(w)));
});

test('planCreatePost refuses a post with no message, link or photos', () => {
  const err = expectValidationError(
    () => planCreatePost({ pageId: PAGE_ID }, { nowMs: NOW_MS }),
    'empty_post',
  );
  assert.match(err.message, /at least one of message, link or photos/);
});

test('planCreatePost treats a whitespace-only message as no message', () => {
  expectValidationError(
    () => planCreatePost({ pageId: PAGE_ID, message: '   ' }, { nowMs: NOW_MS }),
    'empty_post',
  );
});

test('planCreatePost refuses a message over the documented character ceiling', () => {
  const err = expectValidationError(
    () =>
      planCreatePost(
        { pageId: PAGE_ID, message: 'x'.repeat(POST_MESSAGE_MAX_CHARS + 1) },
        { nowMs: NOW_MS },
      ),
    'message_too_long',
  );
  assert.match(err.message, /63206/);
});

test('planCreatePost accepts a message exactly at the ceiling', () => {
  const plan = planCreatePost(
    { pageId: PAGE_ID, message: 'x'.repeat(POST_MESSAGE_MAX_CHARS) },
    { nowMs: NOW_MS },
  );
  assert.equal(plan.publishState, 'published');
});

test('planCreatePost enforces the 2-5 child_attachments bounds', () => {
  const card = { link: 'https://e.example/1' };
  for (const count of [CHILD_ATTACHMENTS_MIN - 1, CHILD_ATTACHMENTS_MAX + 1]) {
    const err = expectValidationError(
      () =>
        planCreatePost(
          {
            pageId: PAGE_ID,
            link: 'https://e.example',
            childAttachments: Array.from({ length: count }, () => card),
          },
          { nowMs: NOW_MS },
        ),
      'child_attachments_range',
    );
    assert.match(err.message, /between 2 and 5/);
  }
});

test('planCreatePost serialises child_attachments as JSON and requires a parent link', () => {
  const cards = [{ link: 'https://e.example/1' }, { link: 'https://e.example/2' }];
  const plan = planCreatePost(
    { pageId: PAGE_ID, link: 'https://e.example', childAttachments: cards },
    { nowMs: NOW_MS },
  );
  assert.equal(plan.params['child_attachments'], JSON.stringify(cards));
  assert.match(plan.summary, /2-card link carousel/);

  const err = expectValidationError(
    () =>
      planCreatePost(
        { pageId: PAGE_ID, message: 'hi', childAttachments: cards },
        { nowMs: NOW_MS },
      ),
    'conflicting_params',
  );
  assert.match(err.message, /requires the parent `link`/);
});

test('planCreatePost refuses mixing a photo carousel with a link carousel', () => {
  expectValidationError(
    () =>
      planCreatePost(
        {
          pageId: PAGE_ID,
          link: 'https://e.example',
          childAttachments: [
            { link: 'https://e.example/1' },
            { link: 'https://e.example/2' },
          ],
          photoCount: 2,
        },
        { nowMs: NOW_MS },
      ),
    'conflicting_params',
  );
});

test('planCreatePost refuses a photo post that also carries a link', () => {
  const err = expectValidationError(
    () =>
      planCreatePost(
        { pageId: PAGE_ID, photoCount: 2, link: 'https://e.example' },
        { nowMs: NOW_MS },
      ),
    'conflicting_params',
  );
  assert.equal(err.field, 'link');
});

test('planCreatePost marks an unpublished draft and explains the transition', () => {
  const plan = planCreatePost(
    { pageId: PAGE_ID, message: 'later', published: false },
    { nowMs: NOW_MS },
  );
  assert.equal(plan.publishState, 'draft');
  assert.equal(plan.params['published'], false);
  assert.ok(plan.warnings.some((w) => /publish_now/.test(w)));
});

test('planCreatePost builds a scheduled post with the seconds wire value', () => {
  const plan = planCreatePost(
    {
      pageId: PAGE_ID,
      message: 'soon',
      scheduledPublishTime: '2026-08-01T09:30:00+03:00',
    },
    { nowMs: NOW_MS, pageTimezone: 'Europe/Sofia' },
  );
  assert.equal(plan.publishState, 'scheduled');
  assert.equal(plan.params['published'], false);
  assert.equal(
    plan.params['scheduled_publish_time'],
    Math.floor(Date.parse('2026-08-01T06:30:00Z') / 1000),
  );
  assert.equal(plan.schedule?.utc, '2026-08-01T06:30:00.000Z');
  assert.match(plan.summary, /2026-08-01T06:30:00.000Z \(UTC\)/);
  assert.match(plan.summary, /Europe\/Sofia/);
});

test('planCreatePost refuses published:true together with a schedule', () => {
  const err = expectValidationError(
    () =>
      planCreatePost(
        {
          pageId: PAGE_ID,
          message: 'x',
          published: true,
          scheduledPublishTime: isoAt(hours(48)),
        },
        { nowMs: NOW_MS },
      ),
    'conflicting_params',
  );
  assert.equal(err.field, 'published');
});

test('planCreatePost propagates the schedule window refusal', () => {
  expectValidationError(
    () =>
      planCreatePost(
        { pageId: PAGE_ID, message: 'x', scheduledPublishTime: isoAt(60_000) },
        { nowMs: NOW_MS },
      ),
    'schedule_too_soon',
  );
});

// ---------------------------------------------------------------------------
// planUpdatePost — CC-PUB-4 and the lifecycle verbs (CC-SCHED-5)
// ---------------------------------------------------------------------------

test('planUpdatePost builds an edit body and always names the own-app rule', () => {
  const plan = planUpdatePost(
    { postId: POST_ID, action: 'edit', message: 'fixed' },
    { nowMs: NOW_MS },
  );
  assert.deepEqual(plan.params, { message: 'fixed' });
  assert.ok(plan.warnings.some((w) => /SAME app/.test(w)));
});

test('planUpdatePost edits is_hidden and is_pinned without a message', () => {
  const plan = planUpdatePost(
    { postId: POST_ID, action: 'edit', isHidden: true, isPinned: false },
    { nowMs: NOW_MS },
  );
  assert.deepEqual(plan.params, { is_hidden: true, is_pinned: false });
});

test('planUpdatePost refuses an edit with no fields to change', () => {
  expectValidationError(
    () => planUpdatePost({ postId: POST_ID, action: 'edit' }, { nowMs: NOW_MS }),
    'no_update_fields',
  );
});

test('planUpdatePost refuses an over-long edited message', () => {
  expectValidationError(
    () =>
      planUpdatePost(
        {
          postId: POST_ID,
          action: 'edit',
          message: 'x'.repeat(POST_MESSAGE_MAX_CHARS + 1),
        },
        { nowMs: NOW_MS },
      ),
    'message_too_long',
  );
});

test('planUpdatePost points an edit carrying a schedule at the reschedule action', () => {
  const err = expectValidationError(
    () =>
      planUpdatePost(
        { postId: POST_ID, action: 'edit', scheduledPublishTime: isoAt(hours(48)) },
        { nowMs: NOW_MS },
      ),
    'conflicting_params',
  );
  assert.match(err.message, /action:"reschedule"/);
});

test('planUpdatePost builds the publish-now transition', () => {
  const plan = planUpdatePost(
    { postId: POST_ID, action: 'publish_now' },
    { nowMs: NOW_MS },
  );
  assert.deepEqual(plan.params, { is_published: true });
  assert.ok(plan.warnings.some((w) => /publish itself while this plan is open/.test(w)));
});

test('planUpdatePost refuses content fields on a lifecycle transition', () => {
  const err = expectValidationError(
    () =>
      planUpdatePost(
        { postId: POST_ID, action: 'publish_now', message: 'also edit me' },
        { nowMs: NOW_MS },
      ),
    'conflicting_params',
  );
  assert.equal(err.field, 'message');
});

test('planUpdatePost refuses publish_now that also carries a schedule', () => {
  expectValidationError(
    () =>
      planUpdatePost(
        {
          postId: POST_ID,
          action: 'publish_now',
          scheduledPublishTime: isoAt(hours(48)),
        },
        { nowMs: NOW_MS },
      ),
    'conflicting_params',
  );
});

test('planUpdatePost builds a reschedule and echoes both renderings', () => {
  const plan = planUpdatePost(
    {
      postId: POST_ID,
      action: 'reschedule',
      scheduledPublishTime: '2026-07-20T12:00:00+03:00',
    },
    { nowMs: NOW_MS, pageTimezone: 'Europe/Sofia' },
  );
  assert.equal(
    plan.params['scheduled_publish_time'],
    Math.floor(Date.parse('2026-07-20T09:00:00Z') / 1000),
  );
  assert.equal(plan.schedule?.utc, '2026-07-20T09:00:00.000Z');
  // "both renderings" is the claim, so the second one has to say something the
  // first does not. `!== undefined` passes for a `pageLocal` that is simply the
  // UTC instant relabelled — which is the whole failure this echo exists to
  // prevent, since the operator reads it as the Page's wall clock.
  const local = plan.schedule?.pageLocal ?? '';
  assert.match(local, /2026-07-20/);
  assert.match(local, /12:00/, 'Sofia is UTC+3 in July, so 09:00Z is noon locally');
  assert.match(local, /GMT\+3/, 'and the offset says which clock that is');
  assert.match(plan.summary, /Europe\/Sofia/);
});

test('planUpdatePost requires a time for a reschedule', () => {
  const err = expectValidationError(
    () => planUpdatePost({ postId: POST_ID, action: 'reschedule' }, { nowMs: NOW_MS }),
    'schedule_missing',
  );
  assert.match(err.message, /ISO-8601/);
});

test('planUpdatePost applies the creation-relative bound to a reschedule', () => {
  expectValidationError(
    () =>
      planUpdatePost(
        {
          postId: POST_ID,
          action: 'reschedule',
          scheduledPublishTime: isoAt(hours(24 * 25)),
        },
        { nowMs: NOW_MS, createdAtMs: NOW_MS - hours(24 * 6) },
      ),
    'schedule_reschedule_window',
  );
});

test('planUpdatePost refuses cancel_schedule and names the irreversible tool', () => {
  const err = expectValidationError(
    () =>
      planUpdatePost({ postId: POST_ID, action: 'cancel_schedule' }, { nowMs: NOW_MS }),
    'unsupported_transition',
  );
  assert.match(err.message, /facebook_delete_post/);
  assert.match(err.message, /plan_id/);
  assert.match(err.message, new RegExp(POST_ID));
});

// ---------------------------------------------------------------------------
// planDeletePost
// ---------------------------------------------------------------------------

test('planDeletePost states permanence and the already-absent semantics', () => {
  const plan = planDeletePost({ postId: POST_ID });
  assert.deepEqual(plan.params, { post_id: POST_ID });
  assert.match(plan.summary, /Permanently delete post 111_222/);
  assert.ok(plan.warnings.some((w) => /no undo/.test(w)));
  assert.ok(plan.warnings.some((w) => /success-with-note/.test(w)));
});

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

test('feedPostRequest posts to the feed edge with the params in the body', () => {
  const req = feedPostRequest(PAGE_ID, { message: 'hi' }, { token: 't', timeoutMs: 5 });
  assert.equal(req.protocol, 'json');
  assert.equal(req.method, 'POST');
  assert.equal(req.host, 'graph');
  assert.equal(req.path, '/111/feed');
  assert.deepEqual(req.body, { message: 'hi' });
  assert.equal(req.params, undefined);
  assert.equal(req.token, 't');
  assert.equal(req.timeoutMs, 5);
});

test('feedPostRequest omits scope keys that were not supplied', () => {
  const req = feedPostRequest(PAGE_ID, { message: 'hi' });
  assert.equal('token' in req, false);
  assert.equal('timeoutMs' in req, false);
  assert.equal('signal' in req, false);
});

test('videoByUrlRequest targets the video host', () => {
  const req = videoByUrlRequest(PAGE_ID, { file_url: 'https://e.example/v.mp4' });
  assert.equal(req.host, 'graph-video');
  assert.equal(req.path, '/111/videos');
  assert.deepEqual(req.body, { file_url: 'https://e.example/v.mp4' });
});

test('updatePostRequest and deletePostRequest address the node directly', () => {
  const update = updatePostRequest(POST_ID, { is_published: true });
  assert.equal(update.method, 'POST');
  assert.equal(update.path, '/111_222');
  const del = deletePostRequest(POST_ID);
  assert.equal(del.method, 'DELETE');
  assert.equal(del.path, '/111_222');
  assert.equal(del.body, undefined);
});

test('postStateRequest asks only for the fields divergence compares', () => {
  const req = postStateRequest(POST_ID);
  assert.equal(req.method, 'GET');
  assert.deepEqual(req.params, { fields: POST_STATE_FIELDS });
  assert.equal(POST_STATE_FIELDS.includes('updated_time'), false);
});

test('pageTimezoneRequest reads only the display metadata it needs', () => {
  const req = pageTimezoneRequest(PAGE_ID);
  assert.equal(req.path, '/111');
  assert.deepEqual(req.params, { fields: 'id,timezone' });
});

test('scheduledPostsEdge points at the scheduled queue with its fields', () => {
  const edge = scheduledPostsEdge(PAGE_ID, { token: 'tok' });
  assert.equal(edge.host, 'graph');
  assert.equal(edge.path, '/111/scheduled_posts');
  assert.deepEqual(edge.params, { fields: SCHEDULED_POST_FIELDS });
  assert.equal(edge.token, 'tok');
});

// ---------------------------------------------------------------------------
// Post state, absence and divergence input
// ---------------------------------------------------------------------------

test('normalizePostState projects the operator-controlled fields only', () => {
  const state = normalizePostState({
    id: POST_ID,
    message: 'hi',
    is_published: false,
    is_hidden: false,
    scheduled_publish_time: '1785000000',
    created_time: CREATED_TIME,
    comments: { data: [] },
    updated_time: '2026-07-16T00:00:00+0000',
  });
  assert.deepEqual(state, {
    present: true,
    id: POST_ID,
    message: 'hi',
    isPublished: false,
    isHidden: false,
    scheduledPublishTime: 1_785_000_000,
    createdTime: CREATED_TIME,
  });
});

test('normalizePostState reports absence for junk or an id-less node', () => {
  assert.deepEqual(normalizePostState(null), { present: false });
  assert.deepEqual(normalizePostState('nope'), { present: false });
  assert.deepEqual(normalizePostState({ message: 'orphan' }), { present: false });
});

test('isPostAbsentError recognises the nonexistent-node answers only', () => {
  assert.equal(
    isPostAbsentError(
      new GraphApiError('Unsupported get request.', {
        code: 100,
        subcode: 33,
        httpStatus: 400,
      }),
    ),
    true,
  );
  assert.equal(
    isPostAbsentError(
      new GraphApiError('Object with ID does not exist', { code: 100, httpStatus: 400 }),
    ),
    true,
  );
  assert.equal(
    isPostAbsentError(
      new GraphApiError('Some alias error', { code: 803, httpStatus: 400 }),
    ),
    true,
  );
  assert.equal(
    isPostAbsentError(
      new GraphApiError('Invalid parameter', { code: 100, subcode: 1, httpStatus: 400 }),
    ),
    false,
  );
  assert.equal(
    isPostAbsentError(new GraphApiError('rate limited', { code: 4, httpStatus: 400 })),
    false,
  );
  assert.equal(isPostAbsentError(new Error('boom')), false);
});

test('readPostState returns the projection for a live post', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    (req) => req.method === 'GET',
    fbOk({ id: POST_ID, message: 'hi', is_published: true }),
  );
  const state = await readPostState(fb.fn, POST_ID, { token: 'tok' });
  assert.equal(state.present, true);
  assert.equal(state.isPublished, true);
  const req = fb.lastRequest() as JsonRequest;
  assert.equal(req.token, 'tok');
});

test('readPostState turns an absent post into data, not a failure', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    () => true,
    fbErr(
      new GraphApiError('does not exist', { code: 100, subcode: 33, httpStatus: 400 }),
    ),
  );
  assert.deepEqual(await readPostState(fb.fn, POST_ID), { present: false });
});

test('readPostState rethrows an error that is not an absence', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    () => true,
    fbErr(new GraphApiError('rate limited', { code: 4, httpStatus: 400 })),
  );
  await assert.rejects(() => readPostState(fb.fn, POST_ID), /rate limited/);
});

test('createdAtMsOf parses a Graph created_time and tolerates junk', () => {
  assert.equal(createdAtMsOf({ present: true, createdTime: CREATED_TIME }), NOW_MS);
  assert.equal(createdAtMsOf({ present: true, createdTime: 'not-a-time' }), undefined);
  assert.equal(createdAtMsOf({ present: false }), undefined);
});

test('readPageTimezone returns a usable IANA zone', async () => {
  const fb = createFakeFbRequest();
  fb.on(() => true, fbOk({ id: PAGE_ID, timezone: 'Europe/Sofia' }));
  assert.equal(await readPageTimezone(fb.fn, PAGE_ID), 'Europe/Sofia');
});

test('readPageTimezone degrades to undefined rather than failing a write', async () => {
  const denied = createFakeFbRequest();
  denied.on(
    () => true,
    fbErr(new GraphApiError('no permission', { code: 200, httpStatus: 403 })),
  );
  assert.equal(await readPageTimezone(denied.fn, PAGE_ID), undefined);

  const numeric = createFakeFbRequest();
  numeric.on(() => true, fbOk({ id: PAGE_ID, timezone: 3 }));
  assert.equal(await readPageTimezone(numeric.fn, PAGE_ID), undefined);

  const junk = createFakeFbRequest();
  junk.on(() => true, fbOk('nope'));
  assert.equal(await readPageTimezone(junk.fn, PAGE_ID), undefined);
});

// ---------------------------------------------------------------------------
// CarouselPostError — CC-MEDIA-10
// ---------------------------------------------------------------------------

test('CarouselPostError embeds the orphan ids left behind', () => {
  const err = new CarouselPostError({
    cause: new GraphApiError('feed refused', { code: 100, httpStatus: 400 }),
    cleanup: { deleted: ['1'], orphans: ['2', '3'], failures: [] },
  });
  assert.match(err.message, /feed refused/);
  assert.match(err.message, /2/);
  assert.match(err.message, /3/);
  assert.deepEqual(err.cleanup.orphans, ['2', '3']);
  assert.ok(err instanceof CarouselPostError);
});

test('CarouselPostError stays readable when cleanup removed everything', () => {
  const err = new CarouselPostError({
    cause: new Error('feed refused'),
    cleanup: { deleted: ['1', '2'], orphans: [], failures: [] },
  });
  assert.match(
    err.message,
    /the photos uploaded but the carousel post could not be created/,
  );
  assert.deepEqual(err.cleanup.orphans, []);
});

// ---------------------------------------------------------------------------
// planVideoPost — CC-MEDIA-6/7 plus the shared publish/schedule contract
// ---------------------------------------------------------------------------

test('planVideoPost names the local file and always warns that created is not ready', () => {
  const plan = planVideoPost(
    {
      pageId: PAGE_ID,
      delivery: 'resumable-upload',
      sourceLabel: 'clip.mp4',
      description: 'launch teaser',
      title: 'Teaser',
      byteLength: 12_345,
    },
    { nowMs: NOW_MS },
  );
  assert.deepEqual(plan.params, { description: 'launch teaser', title: 'Teaser' });
  assert.equal(plan.publishState, 'published');
  assert.match(plan.summary, /local file clip\.mp4 \(12345 bytes\)/);
  assert.match(plan.summary, /immediately/);
  assert.ok(plan.warnings.includes(VIDEO_CREATED_NOT_READY_NOTE));
  assert.ok(plan.warnings.some((w) => /not decoded locally/.test(w)));
});

test('planVideoPost puts a remote source in file_url and warns Meta does the fetching', () => {
  const plan = planVideoPost(
    {
      pageId: PAGE_ID,
      delivery: 'file-url',
      sourceLabel: 'https://cdn.example.com/clip.mp4',
    },
    { nowMs: NOW_MS },
  );
  assert.equal(plan.params['file_url'], 'https://cdn.example.com/clip.mp4');
  assert.match(plan.summary, /from URL https:\/\/cdn\.example\.com\/clip\.mp4/);
  assert.ok(plan.warnings.some((w) => /publicly reachable without credentials/.test(w)));
});

test('planVideoPost marks an unpublished video as a draft and says how to publish it', () => {
  const plan = planVideoPost(
    {
      pageId: PAGE_ID,
      delivery: 'resumable-upload',
      sourceLabel: 'clip.mp4',
      published: false,
    },
    { nowMs: NOW_MS },
  );
  assert.equal(plan.params['published'], false);
  assert.equal(plan.publishState, 'draft');
  assert.ok(plan.warnings.includes(DRAFT_TRANSITION_NOTE));
});

test('planVideoPost echoes a scheduled video in UTC and in the Page timezone', () => {
  const plan = planVideoPost(
    {
      pageId: PAGE_ID,
      delivery: 'resumable-upload',
      sourceLabel: 'clip.mp4',
      scheduledPublishTime: isoAt(hours(3)),
    },
    { nowMs: NOW_MS, pageTimezone: 'Europe/Sofia' },
  );
  assert.equal(plan.publishState, 'scheduled');
  assert.equal(plan.params['published'], false);
  assert.equal(plan.params['scheduled_publish_time'], plan.schedule?.epochSeconds);
  assert.equal(plan.schedule?.utc, new Date(NOW_MS + hours(3)).toISOString());
  assert.equal(plan.schedule?.pageTimezone, 'Europe/Sofia');
  // NOW_MS is 2026-07-15T00:00:00Z, so three hours out is 03:00Z — 06:00 on the
  // Sofia clock. Pinning the shifted hour is what separates a real conversion
  // from a `pageTimezone` that is merely carried alongside an untouched UTC string.
  const local = plan.schedule?.pageLocal ?? '';
  assert.match(local, /2026-07-15/);
  assert.match(local, /06:00/);
  assert.match(local, /GMT\+3/);
  assert.match(plan.summary, /Europe\/Sofia/);
});

test('planVideoPost refuses published:true together with a schedule', () => {
  expectValidationError(
    () =>
      planVideoPost(
        {
          pageId: PAGE_ID,
          delivery: 'resumable-upload',
          sourceLabel: 'clip.mp4',
          published: true,
          scheduledPublishTime: isoAt(hours(3)),
        },
        { nowMs: NOW_MS },
      ),
    'conflicting_params',
  );
});

test('planVideoPost rejects a bare local time for the video schedule too', () => {
  const err = expectValidationError(
    () =>
      planVideoPost(
        {
          pageId: PAGE_ID,
          delivery: 'resumable-upload',
          sourceLabel: 'clip.mp4',
          scheduledPublishTime: '2026-08-01T09:30:00',
        },
        { nowMs: NOW_MS },
      ),
    'schedule_format',
  );
  assert.match(err.message, /explicit UTC offset/);
});

test('planVideoPost applies the post text ceiling to the description', () => {
  expectValidationError(
    () =>
      planVideoPost(
        {
          pageId: PAGE_ID,
          delivery: 'resumable-upload',
          sourceLabel: 'clip.mp4',
          description: 'x'.repeat(POST_MESSAGE_MAX_CHARS + 1),
        },
        { nowMs: NOW_MS },
      ),
    'message_too_long',
  );
});
