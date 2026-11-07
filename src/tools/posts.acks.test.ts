// Tests for the `posts` tool package: Graph acknowledgements — read, never assumed.
//
// Split out of `posts.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/posts.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fbErr, fbOk } from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import { PLAN_IN_PROGRESS_MESSAGE, WriteGateError } from '../mcp/index.js';
import { type WriteToolContext } from './shared.js';
import {
  PAGE_ID,
  POST_ID,
  body,
  makeCtx,
  makeSettings,
  mediaFixture,
  record,
  stubPostGoneAfterDelete,
  stubPostState,
  stubVideoUploadPhases,
  tool,
} from '../testing/harness/posts.js';

// ---------------------------------------------------------------------------
// Graph acknowledgements — read, never assumed
// ---------------------------------------------------------------------------
//
// `fbRequest<T>` CASTS the parsed body to `T` without validating it
// (`data as T`, src/core/http.ts), so every one of these edges can hand the
// handler a body its declared type says is impossible. Two distinct ways to get
// a write wrong follow from that, and both are worse than an error: a bodiless
// 2xx used to throw a TypeError on the SUCCESS path, reporting a completed
// publish or delete as failed and inviting a retry that duplicates a post or
// hunts for one already gone; and `?? true` only rejects null/undefined, so a
// `success` Facebook sent as "false" or 0 was recorded as a completed write.
//
// A create's ack is its id. A 2xx that names no post is the same epistemic
// state the http layer files as C2-ambiguous when the body is lost after the
// status line: something may exist, and this call cannot vouch for it. So the
// envelope says `not_applied` + `attempted` (verify first), never `applied`
// beside `postId:null` — an "applied" with no handle reads as "published" and
// invites the blind retry that duplicates it.

test('create_post reports a 2xx that names no post as attempted, not as applied', async () => {
  // `{ success: true }` is the update ack, not the create ack: it confirms that
  // Graph answered, not that a post exists, and it carries nothing to verify by.
  const { fb, ctx, journal } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
    fbOk({ success: true }),
  );

  await tool('facebook_create_post').handler({ message: 'Ack without a post' }, ctx);
  const applied = body(
    await tool('facebook_create_post').handler(
      { message: 'Ack without a post', apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );

  assert.equal(applied['status'], 'not_applied');
  assert.equal(applied['applied'], false);
  assert.equal(applied['outcome'], 'attempted');
  assert.match(String(applied['notPerformedNotice']), /unconfirmed/);
  assert.equal(record(applied['result'])['postId'], null);
  const entry = journal.entries[0];
  assert.ok(entry);
  assert.equal(entry.outcome, 'attempted');
});

test('create_post reports a bodiless 2xx as attempted with no id, not as a crash', async () => {
  // Graph acknowledged the feed write with an empty body. A post MAY exist; the
  // handle for it never arrived, so the result must say exactly that.
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
    fbOk(undefined),
  );

  await tool('facebook_create_post').handler(
    { message: 'Acknowledged, unnamed', published: true },
    ctx,
  );
  const applied = body(
    await tool('facebook_create_post').handler(
      {
        message: 'Acknowledged, unnamed',
        published: true,
        apply: true,
        plan_id: 'plan-1',
      },
      ctx,
    ),
  );

  assert.equal(applied['status'], 'not_applied');
  assert.equal(applied['outcome'], 'attempted');
  assert.equal(record(applied['result'])['postId'], null);
});

test('create_post ignores a post_id that is not a usable string', async () => {
  // An id of the wrong type is not a handle: passing 12345 or "" to a follow-up
  // call is worse than admitting the id never arrived — and without a handle
  // the write is unconfirmed, not applied.
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
    fbOk({ post_id: '', id: 12345 }),
  );

  await tool('facebook_create_post').handler({ message: 'Odd ack' }, ctx);
  const applied = body(
    await tool('facebook_create_post').handler(
      { message: 'Odd ack', apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );

  assert.equal(applied['status'], 'not_applied');
  assert.equal(applied['outcome'], 'attempted');
  assert.equal(record(applied['result'])['postId'], null);
});

test('create_video_post reports a bodiless 2xx from the file_url edge as attempted', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) =>
      req.protocol === 'json' &&
      req.host === 'graph-video' &&
      req.path === `/${PAGE_ID}/videos`,
    fbOk(undefined),
  );

  await tool('facebook_create_video_post').handler(
    { video: 'https://cdn.example/clip.mp4' },
    ctx,
  );
  const applied = body(
    await tool('facebook_create_video_post').handler(
      { video: 'https://cdn.example/clip.mp4', apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );

  assert.equal(applied['status'], 'not_applied');
  assert.equal(applied['outcome'], 'attempted');
  const result = record(applied['result']);
  assert.equal(result['videoId'], null);
  assert.equal(result['delivery'], 'file-url');
});

test('update_post treats a bodiless 2xx as done and a non-true success as refused', async () => {
  // Absence confirms: the transport already turned an error payload into a
  // throw, so an empty 2xx here is Facebook saying "done". A `success` that is
  // PRESENT and not `true` is the opposite, whatever its JSON type.
  const cases: readonly [unknown, boolean][] = [
    [undefined, true],
    [true, true],
    [false, false],
    [null, false],
    ['', false],
    [{}, true],
    [{ success: true }, true],
    [{ success: false }, false],
    [{ success: 'false' }, false],
    [{ success: 0 }, false],
  ];

  for (const [ack, expected] of cases) {
    const { fb, ctx } = makeCtx();
    stubPostState(fb, { id: POST_ID, message: 'before' });
    fb.on((req) => req.method === 'POST' && req.path === `/${POST_ID}`, fbOk(ack));

    await tool('facebook_update_post').handler(
      { post_id: POST_ID, action: 'edit', message: 'after' },
      ctx,
    );
    const applied = body(
      await tool('facebook_update_post').handler(
        {
          post_id: POST_ID,
          action: 'edit',
          message: 'after',
          apply: true,
          plan_id: 'plan-1',
        },
        ctx,
      ),
    );

    // The envelope follows the acknowledgement: a refused edit is `not_applied`.
    assert.equal(applied['status'], expected ? 'applied' : 'not_applied');
    assert.equal(applied['applied'], expected);
    assert.equal(
      record(applied['result'])['success'],
      expected,
      `acknowledgement ${JSON.stringify(ack)} must read as ${String(expected)}`,
    );
  }
});

test('delete_post never claims a post is gone on an acknowledgement that refused', async () => {
  // The most consequential of the four: `deleted: true` tells the model to stop
  // looking. A `success` of "false" or 0 is Facebook declining the delete, and
  // `?? true` used to record both as a completed removal.
  const cases: readonly [unknown, boolean][] = [
    [undefined, true],
    [true, true],
    [false, false],
    [null, false],
    ['ok', false],
    [{ success: true }, true],
    [{ success: false }, false],
    [{ success: 'false' }, false],
    [{ success: 0 }, false],
  ];

  for (const [ack, expected] of cases) {
    const { fb, ctx } = makeCtx();
    stubPostState(fb, { id: POST_ID, message: 'still here' });
    fb.on((req) => req.method === 'DELETE' && req.path === `/${POST_ID}`, fbOk(ack));

    await tool('facebook_delete_post').handler({ post_id: POST_ID }, ctx);
    const applied = body(
      await tool('facebook_delete_post').handler(
        { post_id: POST_ID, apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    );

    // The envelope follows the acknowledgement: a refused delete is `not_applied`.
    assert.equal(applied['status'], expected ? 'applied' : 'not_applied');
    assert.equal(applied['applied'], expected);
    const result = record(applied['result']);
    assert.equal(
      result['deleted'],
      expected,
      `acknowledgement ${JSON.stringify(ack)} must read as ${String(expected)}`,
    );
    // A refused delete is still not the "already gone" end state — that one is
    // reached through the absent-object error path, never through a body.
    assert.equal(result['alreadyAbsent'], false);
  }
});

test('a plan another call is still applying is answered "wait", not "re-plan"', async () => {
  // The gate refuses a racing apply with plan_not_found and says the plan is in
  // progress. The generic recovery hint ("run WITHOUT apply, then apply the new
  // plan") is exactly the second write racing the first that the gate refused.
  const { fb, ctx } = makeCtx();
  stubPostState(fb, { id: POST_ID, message: 'still here' });
  const writeCtx = ctx as WriteToolContext;
  const racing: WriteToolContext = {
    ...writeCtx,
    writeGate: {
      execute: (action) =>
        action.apply === true
          ? Promise.reject(
              new WriteGateError('plan_not_found', PLAN_IN_PROGRESS_MESSAGE, action),
            )
          : writeCtx.writeGate.execute(action),
    },
  };

  const refused = body(
    await tool('facebook_delete_post').handler(
      { post_id: POST_ID, apply: true, plan_id: 'plan-1' },
      racing,
    ),
  );
  assert.equal(refused['reason'], 'plan_not_found');
  const hint = String(refused['hint']);
  assert.match(hint, /[Ww]ait for its result/);
  assert.doesNotMatch(hint, /WITHOUT apply|fresh preview/);
});

// A refused acknowledgement is a write that did not land. The result already
// says so (`success:false` / `deleted:false`); the envelope and the journal must
// agree with it instead of stamping the same call `applied` (CC-MOD-5 rule for a
// resolved-but-unapplied write; the gate reads it from `classifyResult`).
test('update_post envelopes and journals a refused acknowledgement as not applied', async () => {
  const refusals: readonly unknown[] = [
    { success: false },
    { success: 'false' },
    { success: 0 },
  ];

  for (const ack of refusals) {
    const { fb, ctx, journal } = makeCtx();
    stubPostState(fb, { id: POST_ID, message: 'before' });
    fb.on((req) => req.method === 'POST' && req.path === `/${POST_ID}`, fbOk(ack));

    await tool('facebook_update_post').handler(
      { post_id: POST_ID, action: 'edit', message: 'after' },
      ctx,
    );
    const applied = body(
      await tool('facebook_update_post').handler(
        {
          post_id: POST_ID,
          action: 'edit',
          message: 'after',
          apply: true,
          plan_id: 'plan-1',
        },
        ctx,
      ),
    );

    const label = JSON.stringify(ack);
    assert.equal(applied['status'], 'not_applied', `${label}: envelope status`);
    assert.equal(applied['applied'], false, `${label}: envelope applied flag`);
    assert.equal(record(applied['result'])['success'], false, `${label}: result success`);
    assert.equal(journal.entries.length, 1, `${label}: exactly one journal entry`);
    assert.equal(journal.entries[0]?.outcome, 'failed', `${label}: journal outcome`);
  }

  // Positive control: a confirming acknowledgement still lands as applied.
  const { fb, ctx, journal } = makeCtx();
  stubPostState(fb, { id: POST_ID, message: 'before' });
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
    fbOk({ success: true }),
  );
  await tool('facebook_update_post').handler(
    { post_id: POST_ID, action: 'edit', message: 'after' },
    ctx,
  );
  const applied = body(
    await tool('facebook_update_post').handler(
      {
        post_id: POST_ID,
        action: 'edit',
        message: 'after',
        apply: true,
        plan_id: 'plan-1',
      },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'applied');
  assert.equal(applied['applied'], true);
  assert.equal(journal.entries[0]?.outcome, 'applied');
});

test('delete_post envelopes and journals a refused acknowledgement as not applied', async () => {
  const refusals: readonly unknown[] = [
    { success: false },
    { success: 'false' },
    { success: 0 },
  ];

  for (const ack of refusals) {
    const { fb, ctx, journal } = makeCtx();
    stubPostState(fb, { id: POST_ID, message: 'still here' });
    fb.on((req) => req.method === 'DELETE' && req.path === `/${POST_ID}`, fbOk(ack));

    await tool('facebook_delete_post').handler({ post_id: POST_ID }, ctx);
    const applied = body(
      await tool('facebook_delete_post').handler(
        { post_id: POST_ID, apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    );

    const label = JSON.stringify(ack);
    assert.equal(applied['status'], 'not_applied', `${label}: envelope status`);
    assert.equal(applied['applied'], false, `${label}: envelope applied flag`);
    const result = record(applied['result']);
    assert.equal(result['deleted'], false, `${label}: result deleted`);
    assert.equal(result['alreadyAbsent'], false, `${label}: result alreadyAbsent`);
    assert.equal(journal.entries.length, 1, `${label}: exactly one journal entry`);
    assert.equal(journal.entries[0]?.outcome, 'failed', `${label}: journal outcome`);
  }
});

test('delete_post keeps the already-absent end state as applied in the envelope and journal', async () => {
  // The post is gone, which is the state the operator asked for: nothing to
  // reconcile, so this is not a failure. `deleted:false` + `alreadyAbsent:true`
  // already says the tool did not do the removing.
  const { fb, ctx, journal } = makeCtx();
  stubPostGoneAfterDelete(fb);
  stubPostState(fb, { id: POST_ID, message: 'here for now' }, 1);
  stubPostState(fb, { id: POST_ID, message: 'here for now' });
  fb.on(
    (req) => req.method === 'DELETE' && req.path === `/${POST_ID}`,
    fbErr(
      new GraphApiError('Unsupported delete request. Object does not exist', {
        code: 100,
        subcode: 33,
        httpStatus: 400,
      }),
    ),
  );

  await tool('facebook_delete_post').handler({ post_id: POST_ID }, ctx);
  const applied = body(
    await tool('facebook_delete_post').handler(
      { post_id: POST_ID, apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );

  assert.equal(applied['status'], 'applied');
  assert.equal(applied['applied'], true);
  assert.equal(record(applied['result'])['alreadyAbsent'], true);
  assert.equal(journal.entries[0]?.outcome, 'applied');
});

test('delete_post does not call a post it just read "already absent" when the re-read still finds it', async () => {
  // 100/33 on a DELETE means "does not exist, cannot be loaded due to missing
  // permissions, or does not support this operation" — the answer Graph gives
  // for a post another app created. The post was readable a moment ago; a
  // blind `alreadyAbsent:true` + `applied` tells the operator a still-live
  // post is gone.
  const { fb, ctx, journal } = makeCtx();
  stubPostState(fb, { id: POST_ID, message: 'still here' });
  fb.on(
    (req) => req.method === 'DELETE' && req.path === `/${POST_ID}`,
    fbErr(
      new GraphApiError(
        'Unsupported delete request. Object with ID does not exist, cannot be loaded due to missing permissions, or does not support this operation',
        { code: 100, subcode: 33, httpStatus: 400 },
      ),
    ),
  );

  await tool('facebook_delete_post').handler({ post_id: POST_ID }, ctx);
  const applied = body(
    await tool('facebook_delete_post').handler(
      { post_id: POST_ID, apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );

  const result = record(applied['result']);
  assert.equal(result['alreadyAbsent'], false, 'the post is still readable');
  assert.equal(result['deleted'], false);
  assert.equal(applied['status'], 'not_applied');
  assert.match(String(result['note']), /still/i);
  assert.equal(journal.entries[0]?.outcome, 'failed');
});

test('update_post does not let a 100/33 refusal of a post it just read pass as "the post is gone"', async () => {
  // 100/33 on `POST /{post-id}` is Graph's "does not exist, cannot be loaded due
  // to missing permissions, or does not support this operation" — the answer
  // for an edit of a post another app (or a human in the Page UI) created.
  // Propagated raw it is mapped `not_found` ("treat it as already gone"), yet
  // this very call just read the post. A re-read that still finds it proves the
  // post exists and was NOT changed.
  for (const [action, extra] of [
    ['edit', { message: 'after' }],
    ['publish_now', {}],
  ] as const) {
    const { fb, ctx, journal } = makeCtx();
    stubPostState(fb, { id: POST_ID, message: 'before', is_published: false });
    fb.on(
      (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
      fbErr(
        new GraphApiError(
          'Unsupported post request. Object with ID does not exist, cannot be loaded due to missing permissions, or does not support this operation',
          { code: 100, subcode: 33, httpStatus: 400 },
        ),
      ),
    );

    await tool('facebook_update_post').handler(
      { post_id: POST_ID, action, ...extra },
      ctx,
    );
    const applied = body(
      await tool('facebook_update_post').handler(
        { post_id: POST_ID, action, ...extra, apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    );

    const result = record(applied['result']);
    assert.equal(applied['status'], 'not_applied', `${action}: envelope status`);
    assert.equal(result['success'], false, `${action}: result success`);
    assert.match(String(result['note']), /still readable/, `${action}: note`);
    assert.match(String(result['note']), /NOT changed/, `${action}: note`);
    assert.match(
      String(result['note']),
      /SAME app/,
      `${action}: names the same-app rule`,
    );
    assert.equal(journal.entries[0]?.outcome, 'failed', `${action}: journal outcome`);
  }
});

test('update_post keeps the 100/33 refusal when the re-read confirms the post is gone', async () => {
  const { fb, ctx } = makeCtx();
  const absent = new GraphApiError(
    'Unsupported post request. Object with ID does not exist, cannot be loaded due to missing permissions, or does not support this operation',
    { code: 100, subcode: 33, httpStatus: 400 },
  );
  // Present for the preview and the apply pre-read, gone for the re-read.
  stubPostState(fb, { id: POST_ID, message: 'before' }, 2);
  fb.on((req) => req.method === 'GET' && req.path === `/${POST_ID}`, fbErr(absent));
  fb.on((req) => req.method === 'POST' && req.path === `/${POST_ID}`, fbErr(absent));

  await tool('facebook_update_post').handler(
    { post_id: POST_ID, action: 'edit', message: 'after' },
    ctx,
  );
  await assert.rejects(
    tool('facebook_update_post').handler(
      {
        post_id: POST_ID,
        action: 'edit',
        message: 'after',
        apply: true,
        plan_id: 'plan-1',
      },
      ctx,
    ),
    (err: unknown) => err === absent,
  );
});

test('create_video_post envelopes and journals a declined finish as attempted, not applied', async (t) => {
  // The video object exists from the `start` phase on, so a `finish` Graph
  // declines is not "nothing landed": the operator has an object to reconcile
  // (verify, then publish or delete). That is what `attempted` is defined for —
  // a plain `failed` would invite the retry that creates a duplicate
  // (CC-PUB-1), and `applied` beside `accepted:false` is two answers to one
  // question.
  const refusals: readonly unknown[] = [
    { video_id: 'vid-1', success: false },
    { video_id: 'vid-1', success: 'false' },
    { video_id: 'vid-1', success: 0 },
  ];

  for (const ack of refusals) {
    const media = await mediaFixture(t, 'clip.mp4', 64);
    const { fb, ctx, journal } = makeCtx({
      settings: makeSettings({ mediaDir: media.dir }),
    });
    stubVideoUploadPhases(fb, ack);

    await tool('facebook_create_video_post').handler({ video: media.name }, ctx);
    const applied = body(
      await tool('facebook_create_video_post').handler(
        { video: media.name, apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    );

    const label = JSON.stringify(ack);
    assert.equal(applied['status'], 'not_applied', `${label}: envelope status`);
    assert.equal(applied['applied'], false, `${label}: envelope applied flag`);
    assert.equal(applied['outcome'], 'attempted', `${label}: envelope outcome`);
    const result = record(applied['result']);
    assert.equal(result['accepted'], false, `${label}: result accepted`);
    assert.equal(result['videoId'], 'vid-1', `${label}: the id to reconcile survives`);
    assert.equal(journal.entries.length, 1, `${label}: exactly one journal entry`);
    assert.equal(journal.entries[0]?.outcome, 'attempted', `${label}: journal outcome`);
    const notice = String(applied['notPerformedNotice']);
    assert.match(notice, /ATTEMPTED/, `${label}: ${notice}`);
    assert.match(notice, /[Vv]erify/, `${label}: ${notice}`);
    assert.match(notice, /duplicate/, `${label}: ${notice}`);
    assert.doesNotMatch(notice, /nothing landed/, `${label}: ${notice}`);
  }

  // Positive control: a confirming (or bodiless) finish still lands as applied.
  for (const ack of [{ video_id: 'vid-1', success: true }, { video_id: 'vid-1' }]) {
    const media = await mediaFixture(t, 'clip.mp4', 64);
    const { fb, ctx, journal } = makeCtx({
      settings: makeSettings({ mediaDir: media.dir }),
    });
    stubVideoUploadPhases(fb, ack);

    await tool('facebook_create_video_post').handler({ video: media.name }, ctx);
    const applied = body(
      await tool('facebook_create_video_post').handler(
        { video: media.name, apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    );

    const label = JSON.stringify(ack);
    assert.equal(applied['status'], 'applied', `${label}: envelope status`);
    assert.equal(applied['applied'], true, `${label}: envelope applied flag`);
    assert.equal(applied['outcome'], 'applied', `${label}: envelope outcome`);
    assert.equal(
      record(applied['result'])['accepted'],
      true,
      `${label}: result accepted`,
    );
    assert.equal(journal.entries[0]?.outcome, 'applied', `${label}: journal outcome`);
  }
});

test('create_video_post does not tell the caller a declined finish is a finished upload being transcoded', async (t) => {
  // `processingNote` is what the model reads to decide what to say next. On a
  // finish Graph declined, "a finished upload ... Meta still has to transcode
  // it ... the video id comes back immediately" is false: the upload was NOT
  // committed and nothing is being prepared for publishing. The note must say
  // it was declined and name the id to reconcile.
  const media = await mediaFixture(t, 'clip.mp4', 64);
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  stubVideoUploadPhases(fb, { video_id: 'vid-1', success: false });

  await tool('facebook_create_video_post').handler({ video: media.name }, ctx);
  const applied = body(
    await tool('facebook_create_video_post').handler(
      { video: media.name, apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );

  const result = record(applied['result']);
  assert.equal(result['accepted'], false);
  const note = String(result['processingNote']);
  assert.doesNotMatch(note, /finished upload/, note);
  assert.doesNotMatch(note, /transcode/, note);
  assert.match(note, /DECLINED/, note);
  assert.match(note, /vid-1/, note);
  assert.match(note, /facebook_get_video_status/, note);
});

test('create_video_post does not promise a video id when the file_url edge named none', async () => {
  // A 2xx from the file_url edge that names no id is the unconfirmed state
  // (`attempted`, `videoId:null`). "The video id comes back immediately" beside
  // `videoId:null` tells the model an id exists that it was never given.
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) =>
      req.protocol === 'json' &&
      req.host === 'graph-video' &&
      req.path === `/${PAGE_ID}/videos`,
    fbOk({}),
  );

  await tool('facebook_create_video_post').handler(
    { video: 'https://cdn.example/clip.mp4' },
    ctx,
  );
  const applied = body(
    await tool('facebook_create_video_post').handler(
      { video: 'https://cdn.example/clip.mp4', apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );

  const result = record(applied['result']);
  assert.equal(result['videoId'], null);
  const note = String(result['processingNote']);
  assert.doesNotMatch(note, /video id comes back/, note);
  assert.match(note, /no video id/i, note);
  assert.match(note, /[Vv]erify/, note);
});
