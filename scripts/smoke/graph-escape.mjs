// HARNESS-ONLY escape hatch: a raw Graph client for the test Page.
//
// Every other byte the smoke harness sends to Graph goes through the shipped
// server over MCP — that is the point of a smoke. This module is the single,
// deliberate exception, and it exists for exactly one smoke:
// `reels/lifecycle-probe` (smokes/reels-lifecycle.smoke.mjs), which answers
// G-TOOL-3 (doc 10): can `DELETE /{video-id}` remove a Reel, and does
// `facebook_delete_post` do it? Two things there cannot go through MCP:
//
//   1. the PRESENCE check that decides the verdict. `facebook_delete_post` can
//      report `alreadyAbsent: true` for an id its own pre-read could not load
//      (a Video node may reject the post-state field set), so "the tool said
//      applied" is not evidence the Reel is gone. Only an independent
//      `GET /{video-id}` is;
//   2. the CLEANUP. The server ships no Reel delete tool, and the probe's
//      `finally` must still work after the runner's timeout has closed the MCP
//      session — so the last-resort `DELETE /{video-id}` cannot depend on it.
//
// It is confined as tightly as a raw client can be:
//
//   * ONE Page. The only token it ever holds is the test Page's: the explicit
//     `FB_SMOKE_TEST_PAGE_TOKEN`, or one derived for exactly
//     `FB_SMOKE_TEST_PAGE_ID` from the base token (`GET /{test-page-id}?fields=
//     id,access_token`), and the derivation is refused unless Graph echoes that
//     same Page id back. `FB_PAGE_TOKEN` is never read — it covers `FB_PAGE_ID`,
//     which env.mjs already refuses to let equal the test Page.
//   * ONE object kind, and only this run's objects. It can GET and DELETE a bare
//     video id, nothing else, and only an id the smoke `track()`ed after creating
//     it in this run. A DELETE is additionally refused when Graph reports the
//     video's owner (`from.id`) as any Page other than the test Page.
//   * No secret in a URL or a log line. The token rides in the `Authorization`
//     header; `appsecret_proof` (an HMAC, not the token) is added when
//     `FB_APP_SECRET` is set, as the server itself does. Errors carry Graph's
//     code, subcode and message only — never a request URL or header.
//   * Its own timeout per request (`AbortSignal.timeout`), deliberately NOT the
//     smoke's `ctx.signal`: cleanup must still run after Ctrl-C or the run
//     timeout aborted that signal.
//
// Do not import this from any other smoke. If a second smoke ever needs raw
// Graph access, that is a missing MCP tool, not a reason to widen this module.

import { createHmac } from 'node:crypto';

import { SMOKE_ENV } from './env.mjs';

/** Graph's host, as `src/core/settings.ts` pins it for the `graph` host key. */
export const ESCAPE_GRAPH_ORIGIN = 'https://graph.facebook.com';

/** Mirrors `DEFAULT_API_VERSION` in src/core/settings.ts; `FB_API_VERSION` overrides. */
export const ESCAPE_DEFAULT_API_VERSION = 'v23.0';

/** Per-request timeout. Independent of the run timeout on purpose (see header). */
export const ESCAPE_REQUEST_TIMEOUT_MS = 30_000;

/** A bare Graph video id — the only object id this module will touch. */
const VIDEO_ID_SHAPE = /^\d+$/;

/** A Page id has the same shape. */
const PAGE_ID_SHAPE = /^\d+$/;

/** Graph's "object does not exist / cannot be loaded" family (cf. `isPostAbsentError`). */
const ABSENT_MESSAGE_RE =
  /does not exist|unsupported (get|delete) request|cannot be loaded/i;

/** The escape hatch refused to do something, or could not be set up. */
export class EscapeHatchError extends Error {
  name = 'EscapeHatchError';
}

function nonEmpty(env, name) {
  const value = env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Normalise a Graph response (or a transport failure) into
 * `{ ok, code, subcode, message }`. `code` is Graph's numeric code when there is
 * one, else `http<status>`, `timeout` or `network`. Pure.
 */
export function graphOutcome({ status, body, failure } = {}) {
  if (failure !== undefined) {
    const timedOut = failure?.name === 'TimeoutError' || failure?.name === 'AbortError';
    return {
      ok: false,
      code: timedOut ? 'timeout' : 'network',
      subcode: undefined,
      message: String(failure?.message ?? failure),
    };
  }
  const error = body !== null && typeof body === 'object' ? body.error : undefined;
  if (error !== undefined && error !== null && typeof error === 'object') {
    return {
      ok: false,
      code: typeof error.code === 'number' ? error.code : `http${String(status)}`,
      subcode: typeof error.error_subcode === 'number' ? error.error_subcode : undefined,
      message: typeof error.message === 'string' ? error.message : '',
    };
  }
  if (typeof status === 'number' && (status < 200 || status >= 300)) {
    return { ok: false, code: `http${status}`, subcode: undefined, message: '' };
  }
  return { ok: true, code: undefined, subcode: undefined, message: '' };
}

/** True when a failed outcome means "that object is not there". Pure. */
export function isAbsentOutcome(outcome) {
  if (outcome.ok) return false;
  if (outcome.code === 803) return true;
  if (outcome.code !== 100) return false;
  return outcome.subcode === 33 || ABSENT_MESSAGE_RE.test(outcome.message);
}

/**
 * Classify a `GET /{video-id}` into `present` | `absent` | `unknown`. `unknown`
 * carries the code: a permission error or a timeout proves nothing either way,
 * and must never be read as "deleted". Pure.
 */
export function classifyPresence(outcome) {
  if (outcome.ok) return { state: 'present' };
  if (isAbsentOutcome(outcome)) return { state: 'absent' };
  return { state: 'unknown', code: outcome.code };
}

/**
 * The verdict for one deletion attempt, judged by an INDEPENDENT re-read, never
 * by the delete call's own answer. Pure.
 *
 *   * absent afterwards              ⇒ `yes`
 *   * the call failed, still present ⇒ `error(<code>)`
 *   * the call "succeeded", present  ⇒ `no`
 *   * the re-read itself failed      ⇒ `unknown(<code>)`
 *   * never attempted                ⇒ `not-run`
 *
 * @param {{ attempted?: boolean, errorCode?: string|number, after?: {state: string, code?: unknown} }} input
 */
export function deleteVerdict({ attempted = true, errorCode, after } = {}) {
  if (!attempted) return 'not-run';
  if (after?.state === 'absent') return 'yes';
  if (errorCode !== undefined) return `error(${String(errorCode)})`;
  if (after?.state === 'present') return 'no';
  return `unknown(${String(after?.code ?? 'no-reread')})`;
}

/**
 * Where a Reel showed up: `scheduled_posts` | `video_reels` | `both` | `neither`,
 * or `unknown` when either listing could not be read. Pure.
 */
export function edgeVerdict(inScheduledPosts, inVideoReels) {
  if (typeof inScheduledPosts !== 'boolean' || typeof inVideoReels !== 'boolean') {
    return 'unknown';
  }
  if (inScheduledPosts && inVideoReels) return 'both';
  if (inScheduledPosts) return 'scheduled_posts';
  if (inVideoReels) return 'video_reels';
  return 'neither';
}

/** The machine-readable line the probe always prints. Pure. */
export function formatVerdict({
  deleteByVideoId = 'not-run',
  deletePostVideoId = 'not-run',
  deletePostComposite = 'not-run',
  scheduledReelIn = 'unknown',
  draftReelIn = 'unknown',
} = {}) {
  return (
    `G-TOOL-3 verdict: delete-by-video-id=${deleteByVideoId}; ` +
    `delete_post-video-id=${deletePostVideoId}; ` +
    `delete_post-composite=${deletePostComposite}; ` +
    `scheduled-reel-in=${scheduledReelIn}; ` +
    `draft-reel-in=${draftReelIn}`
  );
}

/**
 * Build the test-Page-only raw client.
 *
 * Nothing is sent until the first operation; the Page token is resolved lazily
 * and once. `fetchImpl` is injectable so tests never open a socket.
 *
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   testPageId: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 * }} options
 */
export function createTestPageGraph({
  env = process.env,
  testPageId,
  fetchImpl = globalThis.fetch,
  timeoutMs = ESCAPE_REQUEST_TIMEOUT_MS,
} = {}) {
  if (typeof testPageId !== 'string' || !PAGE_ID_SHAPE.test(testPageId)) {
    throw new EscapeHatchError(
      `the Graph escape hatch needs the numeric test Page id, got ${JSON.stringify(testPageId)}`,
    );
  }
  const version = nonEmpty(env, 'FB_API_VERSION') ?? ESCAPE_DEFAULT_API_VERSION;
  const appSecret = nonEmpty(env, 'FB_APP_SECRET');
  const explicitToken = nonEmpty(env, SMOKE_ENV.testPageToken);
  const baseToken = nonEmpty(env, 'FB_SYSTEM_TOKEN') ?? nonEmpty(env, 'FB_ACCESS_TOKEN');

  /** Ids this run created and may therefore read or delete. */
  const tracked = new Set();

  const send = async (method, path, params, token) => {
    const query = new URLSearchParams(params);
    if (appSecret !== undefined) {
      query.set(
        'appsecret_proof',
        createHmac('sha256', appSecret).update(token).digest('hex'),
      );
    }
    const qs = query.toString();
    const url = `${ESCAPE_GRAPH_ORIGIN}/${version}/${path}${qs === '' ? '' : `?${qs}`}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (failure) {
      return { outcome: graphOutcome({ failure }), body: undefined };
    }
    let body;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return { outcome: graphOutcome({ status: response.status, body }), body };
  };

  let tokenPromise;
  const pageToken = () => {
    tokenPromise ??= (async () => {
      if (explicitToken !== undefined) {
        return { token: explicitToken, source: SMOKE_ENV.testPageToken };
      }
      if (baseToken === undefined) {
        throw new EscapeHatchError(
          `no token for the test Page: set ${SMOKE_ENV.testPageToken}, or FB_SYSTEM_TOKEN / ` +
            'FB_ACCESS_TOKEN so one can be derived (FB_PAGE_TOKEN is never used here)',
        );
      }
      const { outcome, body } = await send(
        'GET',
        testPageId,
        { fields: 'id,access_token' },
        baseToken,
      );
      if (!outcome.ok) {
        throw new EscapeHatchError(
          `could not derive the test Page token [${String(outcome.code)}]: ${outcome.message}`,
        );
      }
      if (body?.id !== testPageId) {
        throw new EscapeHatchError(
          `token derivation answered for Page ${String(body?.id)}, not the test Page ` +
            `${testPageId} — refusing to hold that token`,
        );
      }
      if (typeof body.access_token !== 'string' || body.access_token === '') {
        throw new EscapeHatchError(
          `Graph returned no Page token for the test Page ${testPageId}`,
        );
      }
      return { token: body.access_token, source: 'derived from the base token' };
    })();
    // A failed derivation is not cached: the next call may try again.
    tokenPromise.catch(() => {
      tokenPromise = undefined;
    });
    return tokenPromise;
  };

  const requireTracked = (videoId, what) => {
    if (typeof videoId !== 'string' || !VIDEO_ID_SHAPE.test(videoId)) {
      throw new EscapeHatchError(
        `${what}: ${JSON.stringify(videoId)} is not a bare video id`,
      );
    }
    if (!tracked.has(videoId)) {
      throw new EscapeHatchError(
        `${what}: video ${videoId} was not created by this run — the escape hatch only ` +
          'touches ids the probe tracked',
      );
    }
  };

  /**
   * `GET /{video-id}?fields=id,from` → `{ state, code?, ownerId? }`.
   * Never throws for a Graph answer; throws only for a refusal of this module.
   */
  const presence = async (videoId) => {
    requireTracked(videoId, 'presence');
    const { token } = await pageToken();
    const { outcome, body } = await send('GET', videoId, { fields: 'id,from' }, token);
    const verdict = classifyPresence(outcome);
    const ownerId = typeof body?.from?.id === 'string' ? body.from.id : undefined;
    return { ...verdict, ...(ownerId !== undefined ? { ownerId } : {}) };
  };

  /**
   * `DELETE /{video-id}` → `{ ok, code?, subcode?, message, absent }`.
   * Refused unless the id is tracked and its owner, when Graph reports one, is
   * the test Page.
   */
  const deleteVideo = async (videoId) => {
    requireTracked(videoId, 'delete');
    const before = await presence(videoId);
    if (before.ownerId !== undefined && before.ownerId !== testPageId) {
      throw new EscapeHatchError(
        `delete: video ${videoId} belongs to ${before.ownerId}, not the test Page ` +
          `${testPageId} — refusing`,
      );
    }
    if (before.state === 'absent') {
      return { ok: true, absent: true, code: undefined, subcode: undefined, message: '' };
    }
    const { token } = await pageToken();
    const { outcome } = await send('DELETE', videoId, {}, token);
    return { ...outcome, absent: isAbsentOutcome(outcome) };
  };

  return {
    testPageId,
    apiVersion: version,
    /** Register an id this run created. Only tracked ids can be read or deleted. */
    track: (videoId) => {
      if (typeof videoId !== 'string' || !VIDEO_ID_SHAPE.test(videoId)) {
        throw new EscapeHatchError(
          `track: ${JSON.stringify(videoId)} is not a bare video id`,
        );
      }
      tracked.add(videoId);
    },
    tracked: () => [...tracked],
    /** Where the token came from — for the log, never the token itself. */
    tokenSource: async () => (await pageToken()).source,
    presence,
    deleteVideo,
  };
}
