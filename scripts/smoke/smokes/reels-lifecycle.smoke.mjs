// reels/lifecycle-probe — the one deliberate live run that closes G-TOOL-3.
//
// G-TOOL-3 (docs/analysis/10-v1-release-definition.md) asks two questions the
// hermetic tests cannot answer, and the tool descriptions currently mark both
// UNVERIFIED:
//
//   Q1. Can `DELETE /{video-id}` delete a Reel — and does `facebook_delete_post`
//       do it, given a bare video id, or given a `{page-id}_{post-id}` composite?
//   Q2. Where does a SCHEDULED Reel appear: `/scheduled_posts`
//       (`facebook_list_scheduled_posts`), `/video_reels` (`facebook_list_reels`),
//       both, or neither? (The DRAFT Reel's whereabouts are reported too.)
//
// The probe creates two Reels on the TEST Page through the MCP path — a DRAFT,
// and a SCHEDULED one ~28 days out, both carrying the run marker — reads the two
// listings through MCP, tries `facebook_delete_post` on each, and judges every
// deletion by an INDEPENDENT re-read. It ends with one machine-readable line:
//
//   G-TOOL-3 verdict: delete-by-video-id=yes; delete_post-video-id=…;
//     delete_post-composite=…; scheduled-reel-in=…; draft-reel-in=…
//
// Values: `yes` | `no` | `error(<code>[/<subcode>])` | `unknown(<code>)` |
// `not-run` for the deletions; `scheduled_posts` | `video_reels` | `both` |
// `neither` | `unknown` | `error(<code>)` for the listings.
//
// The re-read and the cleanup use the HARNESS-ONLY raw Graph escape hatch
// (`../graph-escape.mjs`): confined to the test Page token and to the video ids
// this run created. Why they cannot go through MCP is explained there. Cleanup is
// attempted in `finally` for every Reel the probe created, whatever happened
// before, and does not depend on the MCP session or `ctx.signal` still being
// alive. A Reel that survives it is printed as a leak with its video id and a
// manual-delete instruction, and the smoke fails.
//
// Cost: TWO of the test Page's 30 API Reels per rolling 24 h. Hence
// `budget: 'reels'` (never in the default selection) and `requires`, which also
// demands FB_CONFIRM_TOKEN — `facebook_delete_post` is irreversible-tier, and
// without the token Q1 could not be asked at all.
//
// Why a SCHEDULED Reel is acceptable here when `reels/create-and-status` refuses
// one: this probe deletes what it creates (a scheduled Reel ~28 days out has
// weeks of margin before it would reach anyone), and if deletion fails the leak
// line says exactly when it would publish.

import { SmokeSafetyError } from '../client.mjs';
import {
  createTestPageGraph,
  deleteVerdict,
  edgeVerdict,
  formatVerdict,
} from '../graph-escape.mjs';
import { findMarkerNonce } from '../nonce.mjs';
import { paced } from '../pace.mjs';
import { registerSmoke } from '../registry.mjs';

const VIDEO_ID_SHAPE = /^\d+$/;

/** ~28 days: inside the Reels window (> 10 min, <= 29 days), as far out as it allows. */
const SCHEDULE_LEAD_MS = 28 * 24 * 60 * 60 * 1000;

/** Processing is observed briefly, never waited out (cf. reels/create-and-status). */
const STATUS_ATTEMPTS = 6;
const STATUS_DELAY_MS = paced(5000);

/** Listings are eventually consistent: probe a few times before saying "neither". */
const EDGE_ATTEMPTS = 4;
const EDGE_DELAY_MS = paced(10_000);
const EDGE_MAX_PAGES = 4;
const EDGE_PAGE_SIZE = 25;

/** A delete may take a moment to become visible to a read. */
const SETTLE_ATTEMPTS = 3;
const SETTLE_DELAY_MS = paced(3000);

/** Labels that tell the two Reels apart inside one run's marker. */
const LABEL = Object.freeze({
  DRAFT: 'G-TOOL-3 probe DRAFT reel',
  SCHEDULED: 'G-TOOL-3 probe SCHEDULED reel',
});

/** Abort-aware delay for the probing phase: Ctrl-C must not be swallowed. */
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

/** Plain delay for cleanup, which must run even after the signal aborted. */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The `{post-id}` half of a `{page-id}_{post-id}` composite, or the id itself. */
function postPart(id) {
  const cut = String(id).indexOf('_');
  return cut === -1 ? String(id) : String(id).slice(cut + 1);
}

/** `<code>` or `<code>/<subcode>` from a tool error, for the verdict line. */
function errorCodeOf(err) {
  const payload = err?.payload;
  const code = payload?.code ?? err?.code ?? err?.name ?? 'unknown';
  const subcode = payload?.subcode;
  return subcode === undefined ? String(code) : `${String(code)}/${String(subcode)}`;
}

/** Is this item one of this run's Reels, by id or by marker + label? */
function matchesReel(item, reel, nonce, unwrap) {
  const plain = unwrap(item);
  const id = typeof plain?.id === 'string' ? plain.id : undefined;
  if (id !== undefined) {
    if (id === reel.videoId || postPart(id) === reel.videoId) return true;
    if (reel.postId !== null && postPart(id) === postPart(reel.postId)) return true;
  }
  return findMarkerNonce(plain) === nonce && JSON.stringify(plain).includes(reel.label);
}

/**
 * Scan one listing tool (bounded) for each Reel. Returns
 * `{ found: Map<videoId, boolean>, error?: string }`.
 */
async function scanEdge(ctx, tool, itemsKey, reels) {
  const found = new Map(reels.map((reel) => [reel.videoId, false]));
  let cursor;
  try {
    for (let page = 0; page < EDGE_MAX_PAGES; page += 1) {
      const res = await ctx.callTool(tool, {
        profile: ctx.profile,
        limit: EDGE_PAGE_SIZE,
        ...(cursor !== undefined ? { after: cursor } : {}),
      });
      const items = ctx.unwrap(res[itemsKey]);
      if (!Array.isArray(items) || items.length === 0) break;
      for (const item of items) {
        for (const reel of reels) {
          if (matchesReel(item, reel, ctx.nonce, ctx.unwrap))
            found.set(reel.videoId, true);
        }
      }
      if ([...found.values()].every(Boolean)) break;
      if (typeof res.nextCursor !== 'string' || res.nextCursor === '') break;
      cursor = res.nextCursor;
    }
    return { found };
  } catch (err) {
    if (err?.name !== 'SmokeToolError') throw err;
    return { found, error: errorCodeOf(err) };
  }
}

/** Re-read a video until it reads absent, or the attempts run out. */
async function settlePresence(graph, videoId) {
  let last;
  for (let attempt = 1; attempt <= SETTLE_ATTEMPTS; attempt += 1) {
    last = await graph.presence(videoId);
    if (last.state === 'absent') return last;
    if (attempt < SETTLE_ATTEMPTS) await pause(SETTLE_DELAY_MS);
  }
  return last;
}

/**
 * `facebook_delete_post` through the normal plan → apply path. Never throws for
 * a tool-level refusal — that refusal IS the finding — but a harness safety
 * violation (a preview aimed at another Page) is re-thrown.
 */
async function tryDeletePost(ctx, postId) {
  try {
    const { applied } = await ctx.applyWrite(
      'facebook_delete_post',
      { post_id: postId },
      { marker: 'none' },
    );
    return { summary: JSON.stringify(applied.result ?? {}) };
  } catch (err) {
    if (
      err instanceof SmokeSafetyError &&
      !/apply did not report success|diverged/.test(err.message)
    ) {
      throw err;
    }
    const code =
      err instanceof SmokeSafetyError
        ? /diverged/.test(err.message)
          ? 'diverged'
          : 'not-applied'
        : errorCodeOf(err);
    return { errorCode: code, summary: String(err?.message ?? err) };
  }
}

registerSmoke({
  id: 'reels/lifecycle-probe',
  phase: 2,
  title:
    'G-TOOL-3: create a DRAFT + a SCHEDULED Reel, probe delete-by-video-id and the scheduled-Reel edge, delete both',
  page: 'test',
  writes: true,
  budget: 'reels',
  requires: ['FB_SMOKE_REEL_PATH', 'FB_MEDIA_DIR', 'FB_CONFIRM_TOKEN'],
  packages: ['posts', 'reader'],
  run: async (ctx) => {
    const video = process.env.FB_SMOKE_REEL_PATH;
    const testPageId = ctx.pages.testPageId;
    const graph = createTestPageGraph({ testPageId });

    /** Every Reel this run created (or reserved), in creation order. */
    const created = [];
    const verdict = {
      deleteByVideoId: 'not-run',
      deletePostVideoId: 'not-run',
      deletePostComposite: 'not-run',
      scheduledReelIn: 'unknown',
      draftReelIn: 'unknown',
    };
    /** Findings that make the run fail, without aborting the rest of the probe. */
    const problems = [];
    let failure;
    let leaks = [];

    const createReel = async (state, extra = {}) => {
      const label = LABEL[state];
      try {
        const { applied } = await ctx.applyWrite('facebook_create_reel', {
          video,
          description: ctx.mark(`smoke: ${label}`),
          title: ctx.mark(`smoke ${state.toLowerCase()} probe`),
          video_state: state,
          ...extra,
        });
        const result = applied.result ?? {};
        ctx.assert(
          typeof result.videoId === 'string' && VIDEO_ID_SHAPE.test(result.videoId),
          `create_reel (${state}) returned videoId ${String(result.videoId)}`,
        );
        const reel = {
          state,
          label,
          videoId: result.videoId,
          postId: typeof result.postId === 'string' ? result.postId : null,
          publishAt: extra.scheduled_publish_time,
          gone: false,
        };
        graph.track(reel.videoId);
        created.push(reel);
        ctx.log.step(
          `created ${state} Reel video ${reel.videoId} (post id ${String(reel.postId)}, ` +
            `reported state ${String(result.videoState)})`,
        );
        return reel;
      } catch (err) {
        // A failure after the upload reserved an id still leaves a video behind:
        // the server reports that id on the error so it can be cleaned up.
        const reserved = err?.payload?.videoId;
        if (typeof reserved === 'string' && VIDEO_ID_SHAPE.test(reserved)) {
          graph.track(reserved);
          created.push({
            state,
            label,
            videoId: reserved,
            postId: null,
            publishAt: extra.scheduled_publish_time,
            gone: false,
          });
        }
        if (err?.payload?.reason === 'reel_quota') {
          ctx.log.warn(
            `the test Page has exhausted its Reels quota: ${String(err.payload.operatorText ?? err.message)}`,
          );
        }
        throw err;
      }
    };

    try {
      // Resolve the escape hatch FIRST: if the cleanup path cannot work, refuse
      // before a single quota slot is spent.
      ctx.log.step(
        `escape hatch: test Page token ${await graph.tokenSource()}, Graph ${graph.apiVersion}`,
      );
      ctx.log.warn(
        "this probe consumes TWO of the test Page's 30 API Reels per rolling 24 h and " +
          'deletes both Reels it creates at the end',
      );

      const draft = await createReel('DRAFT');
      ctx.assert(
        draft.postId === null,
        `a DRAFT Reel came back with post id ${String(draft.postId)} — it may be live`,
      );

      let scheduled;
      try {
        scheduled = await createReel('SCHEDULED', {
          scheduled_publish_time: new Date(Date.now() + SCHEDULE_LEAD_MS).toISOString(),
        });
      } catch (err) {
        // Q1 can still be asked of the draft; Q2 cannot be asked at all.
        verdict.scheduledReelIn = `error(${errorCodeOf(err)})`;
        problems.push(
          `creating the SCHEDULED Reel failed: ${String(err?.message ?? err)}`,
        );
        ctx.log.fail(problems.at(-1));
      }

      const live = [draft, ...(scheduled !== undefined ? [scheduled] : [])];

      // Processing state: observed, not awaited to the end. It is logged because
      // "not listed yet" and "still processing" look identical from a listing.
      for (const reel of live) {
        for (let attempt = 1; attempt <= STATUS_ATTEMPTS; attempt += 1) {
          let status;
          try {
            status = await ctx.callTool('facebook_get_video_status', {
              profile: ctx.profile,
              video_id: reel.videoId,
            });
          } catch (err) {
            if (err?.name !== 'SmokeToolError') throw err;
            ctx.log.step(`${reel.state} status unreadable: ${errorCodeOf(err)}`);
            break;
          }
          ctx.log.step(
            `${reel.state} status attempt ${attempt}: ${String(status.state)}`,
          );
          if (status.terminal === true) break;
          if (attempt < STATUS_ATTEMPTS) await sleep(STATUS_DELAY_MS, ctx.signal);
        }
      }

      // Q2 — where do the Reels appear? Through MCP only.
      const seen = {
        scheduled_posts: new Map(live.map((reel) => [reel.videoId, false])),
        video_reels: new Map(live.map((reel) => [reel.videoId, false])),
      };
      const edgeErrors = {};
      for (let attempt = 1; attempt <= EDGE_ATTEMPTS; attempt += 1) {
        const scans = {
          scheduled_posts: await scanEdge(
            ctx,
            'facebook_list_scheduled_posts',
            'posts',
            live,
          ),
          video_reels: await scanEdge(ctx, 'facebook_list_reels', 'reels', live),
        };
        for (const [edge, scan] of Object.entries(scans)) {
          if (scan.error !== undefined) edgeErrors[edge] = scan.error;
          else delete edgeErrors[edge];
          for (const [id, hit] of scan.found) if (hit) seen[edge].set(id, true);
        }
        ctx.log.step(
          `edge scan ${attempt}: ` +
            live
              .map(
                (reel) =>
                  `${reel.state} scheduled_posts=${String(seen.scheduled_posts.get(reel.videoId))} ` +
                  `video_reels=${String(seen.video_reels.get(reel.videoId))}`,
              )
              .join('; ') +
            (Object.keys(edgeErrors).length > 0
              ? ` (errors: ${JSON.stringify(edgeErrors)})`
              : ''),
        );
        const allEverywhere = live.every(
          (reel) =>
            seen.scheduled_posts.get(reel.videoId) === true &&
            seen.video_reels.get(reel.videoId) === true,
        );
        if (allEverywhere) break;
        if (attempt < EDGE_ATTEMPTS) await sleep(EDGE_DELAY_MS, ctx.signal);
      }
      const edgeFor = (reel) => {
        const errors = Object.entries(edgeErrors);
        if (errors.length > 0) {
          return `error(${errors.map(([edge, code]) => `${edge}:${code}`).join(',')})`;
        }
        return edgeVerdict(
          seen.scheduled_posts.get(reel.videoId),
          seen.video_reels.get(reel.videoId),
        );
      };
      verdict.draftReelIn = edgeFor(draft);
      if (scheduled !== undefined) verdict.scheduledReelIn = edgeFor(scheduled);

      // Q1a — facebook_delete_post with the DRAFT's bare video id.
      const byVideoId = await tryDeletePost(ctx, draft.videoId);
      ctx.log.step(`delete_post(${draft.videoId}): ${byVideoId.summary}`);
      const afterTool = await settlePresence(graph, draft.videoId);
      verdict.deletePostVideoId = deleteVerdict({
        errorCode: byVideoId.errorCode,
        after: afterTool,
      });
      if (afterTool.state === 'absent') {
        // delete_post sends exactly `DELETE /{post_id}`, so this also answers
        // the raw Graph question.
        draft.gone = true;
        verdict.deleteByVideoId = 'yes';
      } else {
        // Q1b — the raw Graph capability, independent of the tool's pre-read.
        const raw = await graph.deleteVideo(draft.videoId);
        const afterRaw = await settlePresence(graph, draft.videoId);
        draft.gone = afterRaw.state === 'absent';
        verdict.deleteByVideoId = deleteVerdict({
          errorCode:
            raw.ok || raw.absent
              ? undefined
              : raw.subcode === undefined
                ? raw.code
                : `${String(raw.code)}/${String(raw.subcode)}`,
          after: afterRaw,
        });
        ctx.log.step(
          `raw DELETE /${draft.videoId}: ${raw.ok ? 'ok' : `[${String(raw.code)}] ${raw.message}`}`,
        );
      }

      // Q1c — facebook_delete_post with a post composite, on the SCHEDULED Reel.
      if (scheduled !== undefined) {
        const composite =
          scheduled.postId !== null && scheduled.postId.includes('_')
            ? scheduled.postId
            : `${testPageId}_${scheduled.postId ?? scheduled.videoId}`;
        const byComposite = await tryDeletePost(ctx, composite);
        ctx.log.step(`delete_post(${composite}): ${byComposite.summary}`);
        const afterComposite = await settlePresence(graph, scheduled.videoId);
        scheduled.gone = afterComposite.state === 'absent';
        verdict.deletePostComposite = deleteVerdict({
          errorCode: byComposite.errorCode,
          after: afterComposite,
        });
      }
    } catch (err) {
      failure = err;
    } finally {
      // Cleanup: every Reel not already confirmed gone, through the escape hatch
      // only — the MCP session may already be closed by a run timeout.
      leaks = [];
      for (const reel of created) {
        if (reel.gone) continue;
        try {
          const raw = await graph.deleteVideo(reel.videoId);
          const after = await settlePresence(graph, reel.videoId);
          if (after.state === 'absent') {
            reel.gone = true;
            ctx.log.step(`cleanup: ${reel.state} Reel ${reel.videoId} deleted`);
          } else {
            leaks.push({
              reel,
              reason: raw.ok
                ? `the DELETE was accepted but the video still reads ${after.state}`
                : `[${String(raw.code)}] ${raw.message}`,
            });
          }
        } catch (err) {
          leaks.push({ reel, reason: String(err?.message ?? err) });
        }
      }
      for (const { reel, reason } of leaks) {
        ctx.log.fail(
          `COULD NOT DELETE ${reel.state} reel ${reel.videoId} (${ctx.nonce}) on test Page ` +
            `${testPageId}: ${reason}. Delete it by hand — Meta Business Suite → the test ` +
            `Page → Content (Reels / Drafts / Scheduled), or DELETE /${graph.apiVersion}/` +
            `${reel.videoId} with the test Page token.` +
            (reel.publishAt !== undefined
              ? ` It is SCHEDULED and will publish to the Page's audience at ${reel.publishAt} unless removed.`
              : ''),
        );
      }
      // The verdict line is printed whatever happened, so a partial run still
      // leaves its evidence on screen.
      ctx.log.line(formatVerdict(verdict));
    }

    if (leaks.length > 0) {
      throw new Error(
        `${leaks.length} Reel(s) could not be deleted — see the COULD NOT DELETE line(s)` +
          (failure !== undefined
            ? `; the probe had already failed: ${String(failure?.message ?? failure)}`
            : ''),
      );
    }
    if (failure !== undefined) throw failure;
    if (problems.length > 0) throw new Error(problems.join('; '));
  },
});
