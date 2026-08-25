// Smokes for the Reels surface, split across two roadmap phases because the
// surface itself is: `facebook_list_reels` is a `reader` tool and gates in
// phase 1, while `facebook_get_video_status` and the upload belong to `posts`
// and gate in phase 2 (doc 08 — CC-MEDIA-7 ships there). One file, two tags.
//
// Reels are the one vertical where the live harness cannot be symmetric, and the
// asymmetry is worth stating up front because it shaped every decision below.
//
//   * READING a Reel is free and safe, so it is covered unconditionally.
//   * CREATING one is not. It consumes one of the Page's 30 API Reels per rolling
//     24 h (hence `budget: 'reels'`, opt-in only), it needs a real video file the
//     repository cannot contain and cannot synthesize (hence
//     `requires: ['FB_SMOKE_REEL_PATH']`), and — this is the important part —
//     **there is no delete tool for it.** The server ships no
//     `facebook_delete_video`; `facebook_delete_post` takes a `{page-id}_{post-id}`
//     composite and a Reel is a VIDEO node. So a created Reel CANNOT be swept.
//     That is a leak by construction, not an oversight in the sweeper.
//
// The creating smoke therefore does three things no other smoke here does:
// publishes as `DRAFT` (a draft reaches no audience, so the blast radius of the
// leak is the test Page's draft area rather than its followers), refuses to run
// unless an operator explicitly opted in twice (`--include-budget` AND the env
// var), and ends by printing the video id with an instruction to delete it by
// hand. A run that creates a Reel is not "clean" afterwards and never claims to be.
//
// What is deliberately NOT covered:
//
//   * `video_state: 'PUBLISHED'` and `'SCHEDULED'` — both put a real Reel in front
//     of real followers, and neither can be taken down through this server. DRAFT
//     is the only state a self-cleaning-ish harness may use.
//   * the `{page-id}_{post-id}`-composite refusal on `facebook_reel_insights` —
//     already asserted by `insights/reel-guardrail`. `reels/status-guardrail`
//     below covers the OTHER tool that shares `videoIdArg`, which nothing else
//     touches.

import { registerSmoke } from '../registry.mjs';

/** A bare Graph VIDEO id: digits only (`videoIdArg` in src/tools/insights.ts). */
const VIDEO_ID_SHAPE = /^\d+$/;

/** The states `facebook_get_video_status` may report (`videoStatusOutputSchema`). */
const VIDEO_STATES = new Set(['uploading', 'processing', 'ready', 'error']);

/** Encoding takes minutes; a smoke may observe it, never wait it out. */
const STATUS_ATTEMPTS = 6;
const STATUS_DELAY_MS = 5000;

/** Pages of `facebook_list_posts` scanned when proving Reels are absent from it. */
const TIMELINE_MAX_PAGES = 4;
const TIMELINE_PAGE_SIZE = 25;

/** Abort-aware delay: Ctrl-C and the run timeout must not be swallowed by a wait. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The `{post-id}` half of a `{page-id}_{post-id}` composite, or the id itself. */
function postPart(id) {
  const cut = String(id).indexOf('_');
  return cut === -1 ? String(id) : String(id).slice(cut + 1);
}

// ---------------------------------------------------------------------------
// reels/listing — the reader-side contract, at zero Graph cost beyond GETs
// ---------------------------------------------------------------------------

registerSmoke({
  id: 'reels/listing',
  phase: 1,
  title: 'List Reels, page the cursor, and prove they are absent from the timeline',
  page: 'read',
  writes: false,
  packages: ['reader'],
  run: async (ctx) => {
    const first = await ctx.callTool('facebook_list_reels', {
      profile: ctx.profile,
      limit: 2,
    });

    ctx.assert(
      first.pageId === ctx.pages.readPageId,
      `listing resolved Page ${first.pageId}, expected ${ctx.pages.readPageId}`,
    );

    const reels = ctx.unwrap(first.reels);
    ctx.assert(Array.isArray(reels), `reels is not an array: ${typeof reels}`);
    ctx.assert(
      first.count === reels.length,
      `count ${first.count} disagrees with the array length ${reels.length}`,
    );
    ctx.log.step(`${reels.length} Reel(s) on the read Page`);

    if (reels.length === 0) {
      // Not a failure: most Pages have no Reels. Everything below needs at least
      // one, and inventing one is exactly what this smoke must not do.
      ctx.log.step(
        'read Page has no Reels — pagination and the absence check are skipped',
      );
      return;
    }

    // Every listed item must be addressable by the tools that consume a Reel id.
    // A composite here would mean the reader and the insights schema disagree
    // about the id space, which is the single most likely Reels regression.
    for (const [index, reel] of reels.entries()) {
      ctx.assert(
        typeof reel.id === 'string' && VIDEO_ID_SHAPE.test(reel.id),
        `reel ${index} has id ${String(reel.id)}, which facebook_reel_insights would refuse`,
      );
    }

    // Cursor round-trip: `nextCursor` must be accepted verbatim as `after`, and
    // the second page must not repeat the first. A cursor that silently restarts
    // the listing turns "page until empty" into an infinite loop for the model.
    if (typeof first.nextCursor === 'string' && first.nextCursor.length > 0) {
      const second = await ctx.callTool('facebook_list_reels', {
        profile: ctx.profile,
        limit: 2,
        after: first.nextCursor,
      });
      const more = ctx.unwrap(second.reels);
      ctx.assert(Array.isArray(more), `page 2 reels is not an array: ${typeof more}`);
      const seen = new Set(reels.map((reel) => reel.id));
      const repeated = more.filter((reel) => seen.has(reel.id));
      ctx.assert(
        repeated.length === 0,
        `the cursor replayed page 1: ${repeated.map((reel) => reel.id).join(', ')}`,
      );
      ctx.log.step(`cursor advanced to ${more.length} further Reel(s)`);
    } else {
      ctx.log.step('single page of Reels — the cursor round-trip is not exercised');
    }

    // The claim `facebook_list_reels`'s own description makes ("they never appear
    // in facebook_list_posts") is the reason the tool exists. It is asserted here
    // over a BOUNDED scan: a Page with thousands of posts must not turn a smoke
    // into a full timeline crawl, so the scan reports its own limit instead of
    // pretending to be exhaustive.
    const ids = new Set(reels.map((reel) => reel.id));
    let cursor;
    let scanned = 0;
    let pages = 0;
    for (; pages < TIMELINE_MAX_PAGES; pages += 1) {
      const page = await ctx.callTool('facebook_list_posts', {
        profile: ctx.profile,
        edge: 'published_posts',
        limit: TIMELINE_PAGE_SIZE,
        ...(cursor !== undefined ? { after: cursor } : {}),
      });
      const posts = ctx.unwrap(page.posts);
      if (!Array.isArray(posts) || posts.length === 0) break;
      scanned += posts.length;
      for (const post of posts) {
        ctx.assert(
          !ids.has(postPart(post.id)),
          `post ${post.id} on the timeline IS one of the listed Reels — the two edges ` +
            'overlap, so facebook_list_reels is no longer the only place Reels are readable',
        );
      }
      if (typeof page.nextCursor !== 'string' || page.nextCursor.length === 0) break;
      cursor = page.nextCursor;
    }
    ctx.log.step(
      `no Reel id appeared among the newest ${scanned} timeline post(s) ` +
        `(${pages} page(s); the scan is bounded, not exhaustive)`,
    );
  },
});

// ---------------------------------------------------------------------------
// reels/status-guardrail — the second consumer of the VIDEO id space
// ---------------------------------------------------------------------------

registerSmoke({
  id: 'reels/status-guardrail',
  phase: 2,
  title: 'facebook_get_video_status refuses a post composite before any Graph call',
  // `page: 'none'` is honest here: the composite is rejected by the input schema,
  // so no profile is ever resolved and no Page is touched. The value of running
  // it live is that it proves the guard survives into the SHIPPED, packaged
  // binary — the unit tests exercise the source, not `build/index.js` over stdio.
  page: 'none',
  writes: false,
  packages: ['posts'],
  run: async (ctx) => {
    const rejected = await ctx.callToolRaw('facebook_get_video_status', {
      video_id: '1234567890_9876543210',
    });

    ctx.assert(
      rejected.isError === true,
      'facebook_get_video_status accepted a {page-id}_{post-id} composite',
    );
    const message = String(rejected.payload?.error ?? '');
    ctx.assert(
      /VIDEO id/.test(message) && message.includes('digits only'),
      `the refusal does not describe the id shape it wants: ${message}`,
    );
    // A schema rejection carries `error` and nothing else. A `code` or an
    // `httpStatus` would mean the composite reached Graph.
    ctx.assert(
      rejected.payload?.code === undefined && rejected.payload?.httpStatus === undefined,
      `the composite reached Graph: ${JSON.stringify(rejected.payload)}`,
    );
    ctx.log.step('the video-id guard held inside the packaged server');
  },
});

// ---------------------------------------------------------------------------
// reels/create-and-status — BUDGETED, opt-in twice, and leaks by construction
// ---------------------------------------------------------------------------

registerSmoke({
  id: 'reels/create-and-status',
  phase: 2,
  title: 'Upload a DRAFT Reel and follow it to a terminal processing state',
  page: 'test',
  writes: true,
  // Two independent opt-ins. `budget` keeps it out of the default selection
  // (`--include-budget` or `--only` is needed); `requires` keeps it from running
  // even then unless the operator pointed at a real video file. Both are needed:
  // the quota is finite AND the artifact cannot be cleaned up afterwards.
  budget: 'reels',
  requires: ['FB_SMOKE_REEL_PATH'],
  packages: ['posts'],
  run: async (ctx) => {
    const video = process.env.FB_SMOKE_REEL_PATH;

    ctx.log.warn(
      "this smoke consumes one of the test Page's 30 API Reels per rolling 24 h, and " +
        'the server has no tool that can delete a Reel — the draft it creates must be ' +
        'removed by hand afterwards',
    );

    let created;
    try {
      ({ applied: created } = await ctx.applyWrite('facebook_create_reel', {
        video,
        description: ctx.mark('smoke: draft reel'),
        title: ctx.mark('smoke draft'),
        // DRAFT, never PUBLISHED: a published Reel reaches real followers and
        // cannot be taken down through this server. See the file header.
        video_state: 'DRAFT',
      }));
    } catch (err) {
      // The rolling-24h cap is a legitimate live outcome, not a bug. The server
      // reports it as `reel_quota` and deliberately marks it non-retryable, so
      // say what happened and let the run fail rather than sleeping for hours.
      if (err?.payload?.reason === 'reel_quota') {
        ctx.log.warn(
          `the test Page has exhausted its Reels quota: ${String(err.payload.operatorText ?? err.message)}`,
        );
      }
      throw err;
    }

    const result = created.result ?? {};
    ctx.assert(
      typeof result.videoId === 'string' && VIDEO_ID_SHAPE.test(result.videoId),
      `create_reel returned videoId ${String(result.videoId)}, expected a bare video id`,
    );
    ctx.assert(
      result.videoState === 'DRAFT',
      `asked for a DRAFT, the server reported ${String(result.videoState)}`,
    );
    // A draft has no post. A post id coming back here would mean the Reel went
    // live despite the requested state — a safety finding, not a shape nit.
    ctx.assert(
      result.postId === null,
      `a DRAFT Reel came back with post id ${String(result.postId)} — it may be live`,
    );
    ctx.assert(result.accepted === true, 'the finish phase did not report success');
    ctx.assert(
      result.isPublishedAndProcessed === false,
      'the server claimed the Reel is already processed; encoding is asynchronous and ' +
        'that flag must stay false at upload time',
    );
    ctx.assert(
      typeof result.bytesSent === 'number' && result.bytesSent > 0,
      `no bytes were transferred: ${String(result.bytesSent)}`,
    );
    ctx.log.step(
      `uploaded ${result.bytesSent} byte(s) in ${result.chunks} chunk(s), ` +
        `${result.resumes} resume(s), video ${result.videoId}`,
    );

    // The status edge. `facebook_get_video_status`'s own description says it is
    // UNVERIFIED whether a Reel id resolves there — resolving that question is
    // the whole reason this smoke is allowed to spend a quota slot, so a failure
    // here is a real finding and is reported as one rather than tolerated.
    let status;
    for (let attempt = 1; attempt <= STATUS_ATTEMPTS; attempt += 1) {
      status = await ctx.callTool('facebook_get_video_status', {
        profile: ctx.profile,
        video_id: result.videoId,
      });

      ctx.assert(
        status.videoId === result.videoId,
        `video id did not round-trip: sent ${result.videoId}, got back ${String(status.videoId)}`,
      );
      ctx.assert(
        status.pageId === ctx.pages.testPageId,
        `status resolved Page ${String(status.pageId)}, expected ${ctx.pages.testPageId}`,
      );
      ctx.assert(
        VIDEO_STATES.has(status.state),
        `unknown processing state ${String(status.state)}`,
      );
      ctx.assert(
        status.terminal === (status.state === 'ready' || status.state === 'error'),
        `terminal=${String(status.terminal)} disagrees with state ${String(status.state)}`,
      );

      ctx.log.step(
        `attempt ${attempt}: ${status.state} (terminal=${String(status.terminal)})`,
      );
      if (status.terminal === true) break;
      if (attempt < STATUS_ATTEMPTS) await sleep(STATUS_DELAY_MS, ctx.signal);
    }

    ctx.assert(
      status.state !== 'error',
      `the upload was accepted but encoding failed: ${JSON.stringify(status.error ?? status.note)}`,
    );
    if (status.terminal !== true) {
      // Not a failure: Meta-side encoding regularly outlives any sane smoke
      // budget. The contract under test (the id resolves, the shape holds) is
      // already proven by the assertions above.
      ctx.log.step(
        `still ${status.state} after ${STATUS_ATTEMPTS} attempt(s) — encoding outlived the smoke`,
      );
    }

    // The leak, stated loudly and last, so it is the thing left on screen.
    ctx.log.warn(
      `LEFT BEHIND: draft Reel ${result.videoId} on Page ${ctx.pages.testPageId}. ` +
        'No sweeper can remove it — the server ships no Reel delete tool. Delete it by ' +
        "hand from the Page's draft area.",
    );
  },
});
