// The Graph error -> action MATRIX (task F06, data half).
//
// This file is intentionally a DATA table: a single ordered array of rows that a
// human can scan top-to-bottom to see "which Graph error code maps to which
// action". The behaviour (lookup, retry-after computation, GraphApiError
// construction) lives next door in `./errors.js`; this module holds no logic
// beyond the shape and the frozen rows.
//
// Envelope shape mapped FROM (architecture doc §2):
//   { error: { message, type, code, error_subcode, fbtrace_id } }
// A row matches by exact `code` (optionally narrowed by `subcode`), or by an
// inclusive `[code, codeMax]` RANGE (the 80000-80099 business-use-case family).
// The `./errors.js` lookup prefers the most specific match:
//   (code + subcode) > (code, any subcode) > (range).
//
// Retry policy note (C9 / CC-NET-3): `retryable` here describes whether the
// error CLASS is retryable at all. The api-layer retry engine (F07/F08) is the
// authority on WHEN and applies the "GET/idempotent only" rule and the 60s
// internal sleep cap; `retryAfterMs` is only ever a SURFACED estimate, never a
// sleep instruction (see ErrorAction docs in types.ts).

import type { ErrorCategory } from './index.js';

/**
 * One row of the error -> action matrix. Kept declarative so the whole table can
 * be frozen by a snapshot test and read as data. `code`/`codeMax`/`subcode`
 * describe the match; the remaining fields are the classification the row emits.
 */
export interface ErrorMatrixRow {
  /** Stable id used by the frozen snapshot and for debugging (never user-facing). */
  readonly id: string;
  /** Exact Graph `code` this row matches (the LOW bound when `codeMax` is set). */
  readonly code: number;
  /** Inclusive upper bound for a code RANGE match; omit for an exact-code row. */
  readonly codeMax?: number;
  /** When set, the row matches only this `error_subcode` (most specific match). */
  readonly subcode?: number;
  readonly category: ErrorCategory;
  /** Whether this error CLASS is retryable at all (F07/F08 decide when). */
  readonly retryable: boolean;
  /** Suggested next tool for the model (e.g. `facebook_whoami`). */
  readonly nextTool?: string;
  /** Human-actionable operator guidance surfaced on the ErrorAction. */
  readonly operatorText: string;
  /**
   * Default SURFACED retry-after in ms when the envelope carries no ETA. Present
   * only on throttle/block rows; never a sleep instruction.
   */
  readonly retryAfterMs?: number;
  /**
   * When true, `estimated_time_to_regain_access` (MINUTES, Graph's documented
   * unit) in the envelope overrides `retryAfterMs` as the surfaced ETA.
   */
  readonly honorEta?: boolean;
}

/** Minutes -> ms factor for `estimated_time_to_regain_access` (Graph's unit is minutes). */
export const ETA_MINUTES_TO_MS = 60_000;

/**
 * Default surfaced cool-down (ms) for a throttle with no ETA in the envelope.
 * Matches the api-layer's 60s internal sleep cap (CC-NET-3) as a sensible hint;
 * the surfaced value may still exceed this when a real ETA is present.
 */
export const DEFAULT_THROTTLE_RETRY_AFTER_MS = 60_000;

/**
 * The frozen error -> action matrix. Order is documentation only — `./errors.js`
 * resolves the most specific match regardless of position — but rows are grouped
 * by family for readability. Every row here is covered by the matrix snapshot
 * test, so any edit is a visible, reviewed diff.
 */
export const ERROR_MATRIX: readonly ErrorMatrixRow[] = [
  // --- Auth: token dead / invalid / expired (code 190 + subcodes) ---------
  {
    id: 'auth-190-460',
    code: 190,
    subcode: 460,
    category: 'auth',
    retryable: false,
    nextTool: 'facebook_whoami',
    operatorText:
      'Access token is no longer valid — the password was changed or the session was ' +
      'invalidated (code 190/460). Re-authorize, update FB_ACCESS_TOKEN (or the Page ' +
      'token), then run facebook_whoami to confirm.',
  },
  {
    id: 'auth-190-463',
    code: 190,
    subcode: 463,
    category: 'auth',
    retryable: false,
    nextTool: 'facebook_whoami',
    operatorText:
      'Access token has expired (code 190/463). Obtain a fresh long-lived token, update ' +
      'FB_ACCESS_TOKEN, then run facebook_whoami to confirm.',
  },
  {
    id: 'auth-190-467',
    code: 190,
    subcode: 467,
    category: 'auth',
    retryable: false,
    nextTool: 'facebook_whoami',
    operatorText:
      'Access token is invalid — the user logged out or the token was revoked (code ' +
      '190/467). Re-authorize and run facebook_whoami to confirm.',
  },
  {
    // Facebook returns this when the *user* behind the token has no role on the
    // Page it is trying to act as ("must be an administrator of the page in order
    // to impersonate it"). The 190 family otherwise means "the credential is dead",
    // so without this row the operator was told to refresh the token — and a fresh
    // token minted by the same user reproduces the error exactly, because the
    // credential was never the problem. This is a `permission` failure that happens
    // to arrive under an auth code, and only a human granting the Page role fixes it.
    id: 'permission-190-492',
    code: 190,
    subcode: 492,
    category: 'permission',
    retryable: false,
    nextTool: 'facebook_whoami',
    operatorText:
      'The token is valid but its user has no role on this Page (code 190/492). Refreshing the ' +
      'token will not help — the same user will be refused again. Grant that user a Page role ' +
      '(admin or the task the call needs) in Meta Business Suite, then mint a Page token for it. ' +
      'Run facebook_whoami to see which identity the current token belongs to and its Page tasks.',
  },
  {
    // A checkpoint is a lock on the *account*, not on the token: Meta is holding a
    // security interstitial that a human has to clear at facebook.com. Re-issuing a
    // token first fails identically, so the generic 190 advice ("refresh the
    // credential") sends the operator round a loop that cannot terminate. Ordering
    // the two steps is the whole value of this row.
    id: 'auth-190-459',
    code: 190,
    subcode: 459,
    category: 'auth',
    retryable: false,
    nextTool: 'facebook_whoami',
    operatorText:
      'The account behind this token is checkpointed (code 190/459) — Meta is holding a security ' +
      'interstitial that only a person can clear. Do not mint a new token yet; it will be refused ' +
      'the same way. Log in to facebook.com as that user, complete the checkpoint, then re-authorize ' +
      'and run facebook_whoami to confirm the token is live.',
  },
  {
    // The same trap as the checkpoint, for a different reason: an account whose
    // owner never confirmed it is refused whatever token is minted for it, so the
    // generic 190 advice loops. The account has to be confirmed first.
    id: 'auth-190-464',
    code: 190,
    subcode: 464,
    category: 'auth',
    retryable: false,
    nextTool: 'facebook_whoami',
    operatorText:
      'The account behind this token is unconfirmed (code 190/464) — the user has not yet ' +
      'confirmed their Facebook account, and Meta refuses every token issued for it until they do. ' +
      'Do not mint a new token yet; it will be refused the same way. Log in to facebook.com as that ' +
      'user, complete the account confirmation, then re-authorize and run facebook_whoami to confirm ' +
      'the token is live.',
  },
  {
    id: 'auth-190',
    code: 190,
    category: 'auth',
    retryable: false,
    nextTool: 'facebook_whoami',
    operatorText:
      'Invalid or expired OAuth access token (code 190). Refresh the credential ' +
      '(FB_ACCESS_TOKEN / Page token) and run facebook_whoami to confirm which token is live.',
  },
  {
    id: 'auth-102',
    code: 102,
    category: 'auth',
    retryable: false,
    nextTool: 'facebook_whoami',
    operatorText:
      'Session/auth error (code 102) — the access token is missing or no longer valid. ' +
      'Refresh the credential and run facebook_whoami.',
  },
  {
    id: 'auth-460',
    code: 460,
    category: 'auth',
    retryable: false,
    nextTool: 'facebook_whoami',
    operatorText:
      'Access token is no longer valid (code 460, password changed / session invalidated). ' +
      'Re-authorize and run facebook_whoami.',
  },
  {
    id: 'auth-463',
    code: 463,
    category: 'auth',
    retryable: false,
    nextTool: 'facebook_whoami',
    operatorText:
      'Access token has expired (code 463). Obtain a fresh token and run facebook_whoami.',
  },
  {
    id: 'auth-467',
    code: 467,
    category: 'auth',
    retryable: false,
    nextTool: 'facebook_whoami',
    operatorText:
      'Access token is invalid (code 467). Re-authorize and run facebook_whoami.',
  },

  // --- Temporary policy block ----------------------------------------------
  {
    id: 'blocked-368',
    code: 368,
    category: 'permission',
    retryable: false,
    operatorText:
      'Action temporarily blocked for policy reasons (code 368). Do NOT auto-retry — ' +
      'reduce activity and wait for the block to clear; repeated attempts extend it.',
    // No default `retryAfterMs`: a policy block lasts hours to days (the Reels
    // daily cap arrives as 368 on a rolling 24 h window), so the 60 s throttle
    // default would be a false cool-down next to "Do NOT auto-retry". Only an
    // ETA Graph actually names is surfaced.
    honorEta: true,
  },

  // --- Permission / missing scope or Page role -----------------------------
  {
    id: 'permission-200',
    code: 200,
    category: 'permission',
    retryable: false,
    nextTool: 'facebook_whoami',
    operatorText:
      'Permission denied (code 200) — the token lacks the required scope or Page role. Do not ' +
      'retry. Check your role on the Page and grant the exact permission named in the error ' +
      'message, then re-authorize. Run facebook_whoami to inspect granted scopes and Page tasks.',
  },
  {
    id: 'permission-10',
    code: 10,
    category: 'permission',
    retryable: false,
    nextTool: 'facebook_whoami',
    operatorText:
      'Permission denied (code 10) — this action is not permitted for the current token. Do not ' +
      'retry. Check your role on the Page and the missing permission named in the error message. ' +
      'Run facebook_whoami to check scopes and Page role.',
  },
  // Meta documents 200-299 as ONE family ("API Permission"), the code varying
  // with WHICH permission is missing: (#294) ads_management, (#240)
  // business_management, (#210) user not visible, and more. Listed last in this
  // section so the exact rows above keep winning; the range starts at 201 so it
  // cannot shadow permission-200. Every member is a missing scope or Page role,
  // which refuses the call identically forever — never retryable.
  {
    id: 'permission-2xx',
    code: 201,
    codeMax: 299,
    category: 'permission',
    retryable: false,
    nextTool: 'facebook_whoami',
    operatorText:
      'Permission denied (code in the 200-299 family) — the token lacks a scope, a Page role ' +
      'or a Business asset assignment. Do not retry: the same call is refused identically ' +
      'until access changes. Grant the exact permission named in the error message and ' +
      're-authorize. Run facebook_whoami to inspect granted scopes and Page tasks.',
  },

  // --- Throttle families (rate limit) --------------------------------------
  {
    id: 'rate-4',
    code: 4,
    category: 'rate_limit',
    retryable: true,
    nextTool: 'facebook_usage',
    operatorText:
      'Application-level rate limit reached (code 4). Slow down and retry idempotent reads ' +
      'after the cool-down; check facebook_usage for the current budget.',
    retryAfterMs: DEFAULT_THROTTLE_RETRY_AFTER_MS,
    honorEta: true,
  },
  {
    id: 'rate-17',
    code: 17,
    category: 'rate_limit',
    retryable: true,
    nextTool: 'facebook_usage',
    operatorText:
      'User-level rate limit reached (code 17). Slow down and retry after the cool-down; ' +
      'check facebook_usage.',
    retryAfterMs: DEFAULT_THROTTLE_RETRY_AFTER_MS,
    honorEta: true,
  },
  {
    id: 'rate-32',
    code: 32,
    category: 'rate_limit',
    retryable: true,
    nextTool: 'facebook_usage',
    operatorText:
      'Page-level rate limit reached (code 32). Slow down and retry after the cool-down; ' +
      'check facebook_usage.',
    retryAfterMs: DEFAULT_THROTTLE_RETRY_AFTER_MS,
    honorEta: true,
  },
  {
    id: 'rate-613',
    code: 613,
    category: 'rate_limit',
    retryable: true,
    nextTool: 'facebook_usage',
    operatorText:
      'Custom rate limit exceeded (code 613). Back off and retry after the cool-down; check ' +
      'facebook_usage.',
    retryAfterMs: DEFAULT_THROTTLE_RETRY_AFTER_MS,
    honorEta: true,
  },
  {
    id: 'rate-341',
    code: 341,
    category: 'rate_limit',
    retryable: true,
    nextTool: 'facebook_usage',
    operatorText:
      'Application limit reached (code 341) — a temporary, self-clearing cap on how much this ' +
      'app may do right now, not a permission problem. Back off and retry after the cool-down; ' +
      'check facebook_usage for the current budget.',
    retryAfterMs: DEFAULT_THROTTLE_RETRY_AFTER_MS,
    honorEta: true,
  },
  {
    id: 'rate-buc',
    code: 80000,
    codeMax: 80099,
    category: 'rate_limit',
    retryable: true,
    nextTool: 'facebook_usage',
    operatorText:
      'Business-use-case rate limit reached (codes 80000-80099). Retry after the estimated ' +
      'cool-down; check facebook_usage for the throttled bucket.',
    retryAfterMs: DEFAULT_THROTTLE_RETRY_AFTER_MS,
    honorEta: true,
  },

  // --- Duplicate post: surfaced, NEVER retried -----------------------------
  {
    id: 'duplicate-506',
    code: 506,
    category: 'duplicate',
    retryable: false,
    nextTool: 'facebook_list_posts',
    operatorText:
      'Duplicate post rejected (code 506) — Facebook considers this identical to a recent ' +
      'post, so it was NOT published again and is NOT retried. The original is likely already ' +
      'live; verify with facebook_list_posts before changing the text and re-posting.',
  },

  // --- Not found / already gone --------------------------------------------
  {
    // The other half of `STALE_OBJECT_SUBCODES` (src/core/auth.ts). The CC-AUTH-7
    // rail already treats 100/21 as "the object this id points at moved" and
    // re-derives the Page token once; this row is what the operator is told when
    // that retry has been spent and the error surfaces anyway. Without it 100/21
    // fell through to `validation-100`, which says to fix the arguments — advice
    // that can never work, because the arguments are not what is wrong.
    id: 'not-found-100-21',
    code: 100,
    subcode: 21,
    category: 'not_found',
    retryable: false,
    operatorText:
      'The Page id has been migrated to a new id (code 100/21). Do not retry — this id will ' +
      'never resolve again; look up the current Page id and update FB_PAGE_ID (or the profile ' +
      'that supplies it).',
  },
  {
    // The same migration also arrives as top-level code 21 — "(#21) Page ID X
    // was migrated to page ID Y. Please update your API calls to the new ID".
    // Without this row it classified as `unknown` ("decide whether the action is
    // safe to repeat") for an id that will never resolve again.
    id: 'not-found-21',
    code: 21,
    category: 'not_found',
    retryable: false,
    operatorText:
      'The Page id has been migrated to a new id (code 21). Do not retry — this id will never ' +
      'resolve again; the error message names the new id. Update FB_PAGE_ID (or the profile ' +
      'that supplies it) to the new id.',
  },
  {
    // Graph's 803 is "(#803) Some of the aliases you requested do not exist: X"
    // or "(#803) Cannot query users by their username": the id or vanity name in
    // the path resolves to nothing Graph will look up. It was filed under
    // permissions ("may require a different Page role, run facebook_whoami"),
    // which sent the caller after a scope or role that was never missing — a
    // hidden or unreadable object arrives as 100/33, 10 or 200-299 instead.
    // `api/posts-write` already reads 803 as "the object is not there".
    id: 'not-found-803',
    code: 803,
    category: 'not_found',
    retryable: false,
    operatorText:
      'The id or alias in the request does not resolve (code 803) — Graph found no object ' +
      'under that name, or refuses to look a user up by username. Do not retry: pass the ' +
      'numeric id (from the listing it came from), or treat the object as gone.',
  },
  {
    id: 'not-found-100-33',
    code: 100,
    subcode: 33,
    category: 'not_found',
    retryable: false,
    operatorText:
      'Object does not exist, was deleted, or is not visible to this token (code 100/33). ' +
      'Do not retry — confirm the id and access, or treat it as already gone.',
  },

  // --- Validation / client parameter error ---------------------------------
  {
    id: 'validation-100',
    code: 100,
    category: 'validation',
    retryable: false,
    operatorText:
      'Invalid parameter or unsupported request (code 100). This is a client-side error — ' +
      'fix the arguments; retrying unchanged will fail identically.',
  },

  // 324 "Missing or invalid image file": the media the call carried (an upload,
  // a thumbnail, a URL Meta fetched) is unusable. Unmatched it fell to `unknown`
  // ("decide whether the action is safe to repeat"), yet the same bytes fail the
  // same way on every attempt. A 4xx refusal, so the call itself created nothing.
  {
    id: 'validation-324',
    code: 324,
    category: 'validation',
    retryable: false,
    operatorText:
      'Graph refused the media file this request carried as missing, unreadable or not a ' +
      'supported image (code 324); this call changed nothing. Do not retry unchanged: supply ' +
      'a valid image (for a URL, one that is publicly reachable and returns the image bytes).',
  },

  // --- Transient service faults (5xx-class Graph errors) --------------------
  {
    id: 'transient-1',
    code: 1,
    category: 'transient',
    retryable: true,
    operatorText:
      'Temporary Graph error (code 1, "unknown/try again"). Safe to retry idempotent GETs ' +
      'after a short backoff; do NOT blindly retry a write — verify whether it landed first.',
  },
  {
    id: 'transient-2',
    code: 2,
    category: 'transient',
    retryable: true,
    operatorText:
      'Graph service temporarily unavailable (code 2). Safe to retry idempotent GETs after a ' +
      'short backoff; do NOT blindly retry a write — verify whether it landed first.',
  },

  // --- Unsupported / retired API version or edge ---------------------------
  {
    id: 'unsupported-12',
    code: 12,
    category: 'unsupported',
    retryable: false,
    operatorText:
      'Deprecated endpoint or parameter (code 12). This API surface is retired — upgrade the ' +
      'call; retrying will not help.',
  },
  {
    id: 'unsupported-2635',
    code: 2635,
    category: 'unsupported',
    retryable: false,
    operatorText:
      'Deprecated Graph API version or edge (code 2635). Move to a supported version/edge; ' +
      'retrying will not help.',
  },
];
