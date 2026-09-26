// Tests for the Graph error -> action classifier (task F06).
//
// The centerpiece is a FROZEN SNAPSHOT of the whole matrix: every row is
// classified through `classifyGraphError` and compared, with a single
// `assert.deepStrictEqual`, against an inline golden object. Any change to a
// code, category, retry flag, next-tool, retry-after default, or operator text
// is a visible, reviewed diff — the matrix can never regress silently (C9).
// The remaining tests pin the behaviours that are not a straight table lookup:
// subcode specificity, ETA handling, the C2 ambiguous-write rule, network-fault
// classification (CC-NET), non-JSON bodies (CC-NET-4), and cursor expiry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphApiError, type ErrorAction } from './index.js';
import { DEFAULT_THROTTLE_RETRY_AFTER_MS, ERROR_MATRIX } from './error-matrix.js';
// Imported to ASSERT AGAINST, not to reuse: the transport reads the same
// response this module classifies, and the two readings must not disagree.
import { classifyHttpError } from './http.js';
import {
  ambiguousWriteAction,
  classifyGraphError,
  classifyNetworkError,
  cursorExpiredAction,
  DEFAULT_VERIFY_TOOL,
  errorMessageOf,
  isCursorRejection,
  matchErrorRow,
  NO_ERROR_MESSAGE,
  nonJsonBodyAction,
  PROXY_ENV_HINT,
  toGraphApiError,
  type GraphErrorEnvelope,
} from './errors.js';

// ---------------------------------------------------------------------------
// Whole-matrix snapshot (C9): classify a representative envelope for every row.
// ---------------------------------------------------------------------------

const MATRIX_SNAPSHOT: Record<string, ErrorAction> = {
  'auth-190-460': {
    category: 'auth',
    retryable: false,
    operatorText:
      'Access token is no longer valid — the password was changed or the session was invalidated (code 190/460). Re-authorize, update FB_ACCESS_TOKEN (or the Page token), then run facebook_whoami to confirm.',
    nextTool: 'facebook_whoami',
  },
  'auth-190-463': {
    category: 'auth',
    retryable: false,
    operatorText:
      'Access token has expired (code 190/463). Obtain a fresh long-lived token, update FB_ACCESS_TOKEN, then run facebook_whoami to confirm.',
    nextTool: 'facebook_whoami',
  },
  'auth-190-467': {
    category: 'auth',
    retryable: false,
    operatorText:
      'Access token is invalid — the user logged out or the token was revoked (code 190/467). Re-authorize and run facebook_whoami to confirm.',
    nextTool: 'facebook_whoami',
  },
  'permission-190-492': {
    category: 'permission',
    retryable: false,
    operatorText:
      'The token is valid but its user has no role on this Page (code 190/492). Refreshing the token will not help — the same user will be refused again. Grant that user a Page role (admin or the task the call needs) in Meta Business Suite, then mint a Page token for it. Run facebook_whoami to see which identity the current token belongs to and its Page tasks.',
    nextTool: 'facebook_whoami',
  },
  'auth-190-459': {
    category: 'auth',
    retryable: false,
    operatorText:
      'The account behind this token is checkpointed (code 190/459) — Meta is holding a security interstitial that only a person can clear. Do not mint a new token yet; it will be refused the same way. Log in to facebook.com as that user, complete the checkpoint, then re-authorize and run facebook_whoami to confirm the token is live.',
    nextTool: 'facebook_whoami',
  },
  'auth-190-464': {
    category: 'auth',
    retryable: false,
    operatorText:
      'The account behind this token is unconfirmed (code 190/464) — the user has not yet confirmed their Facebook account, and Meta refuses every token issued for it until they do. Do not mint a new token yet; it will be refused the same way. Log in to facebook.com as that user, complete the account confirmation, then re-authorize and run facebook_whoami to confirm the token is live.',
    nextTool: 'facebook_whoami',
  },
  'auth-190': {
    category: 'auth',
    retryable: false,
    operatorText:
      'Invalid or expired OAuth access token (code 190). Refresh the credential (FB_ACCESS_TOKEN / Page token) and run facebook_whoami to confirm which token is live.',
    nextTool: 'facebook_whoami',
  },
  'auth-102': {
    category: 'auth',
    retryable: false,
    operatorText:
      'Session/auth error (code 102) — the access token is missing or no longer valid. Refresh the credential and run facebook_whoami.',
    nextTool: 'facebook_whoami',
  },
  'auth-460': {
    category: 'auth',
    retryable: false,
    operatorText:
      'Access token is no longer valid (code 460, password changed / session invalidated). Re-authorize and run facebook_whoami.',
    nextTool: 'facebook_whoami',
  },
  'auth-463': {
    category: 'auth',
    retryable: false,
    operatorText:
      'Access token has expired (code 463). Obtain a fresh token and run facebook_whoami.',
    nextTool: 'facebook_whoami',
  },
  'auth-467': {
    category: 'auth',
    retryable: false,
    operatorText:
      'Access token is invalid (code 467). Re-authorize and run facebook_whoami.',
    nextTool: 'facebook_whoami',
  },
  'blocked-368': {
    category: 'permission',
    retryable: false,
    operatorText:
      'Action temporarily blocked for policy reasons (code 368). Do NOT auto-retry — reduce activity and wait for the block to clear; repeated attempts extend it.',
  },
  'permission-200': {
    category: 'permission',
    retryable: false,
    operatorText:
      'Permission denied (code 200) — the token lacks the required scope or Page role. Do not retry. Check your role on the Page and grant the exact permission named in the error message, then re-authorize. Run facebook_whoami to inspect granted scopes and Page tasks.',
    nextTool: 'facebook_whoami',
  },
  'permission-10': {
    category: 'permission',
    retryable: false,
    operatorText:
      'Permission denied (code 10) — this action is not permitted for the current token. Do not retry. Check your role on the Page and the missing permission named in the error message. Run facebook_whoami to check scopes and Page role.',
    nextTool: 'facebook_whoami',
  },
  'permission-2xx': {
    category: 'permission',
    retryable: false,
    operatorText:
      'Permission denied (code in the 200-299 family) — the token lacks a scope, a Page role or a Business asset assignment. Do not retry: the same call is refused identically until access changes. Grant the exact permission named in the error message and re-authorize. Run facebook_whoami to inspect granted scopes and Page tasks.',
    nextTool: 'facebook_whoami',
  },
  'rate-4': {
    category: 'rate_limit',
    retryable: true,
    operatorText:
      'Application-level rate limit reached (code 4). Slow down and retry idempotent reads after the cool-down; check facebook_usage for the current budget.',
    nextTool: 'facebook_usage',
    retryAfterMs: 60000,
  },
  'rate-17': {
    category: 'rate_limit',
    retryable: true,
    operatorText:
      'User-level rate limit reached (code 17). Slow down and retry after the cool-down; check facebook_usage.',
    nextTool: 'facebook_usage',
    retryAfterMs: 60000,
  },
  'rate-32': {
    category: 'rate_limit',
    retryable: true,
    operatorText:
      'Page-level rate limit reached (code 32). Slow down and retry after the cool-down; check facebook_usage.',
    nextTool: 'facebook_usage',
    retryAfterMs: 60000,
  },
  'rate-613': {
    category: 'rate_limit',
    retryable: true,
    operatorText:
      'Custom rate limit exceeded (code 613). Back off and retry after the cool-down; check facebook_usage.',
    nextTool: 'facebook_usage',
    retryAfterMs: 60000,
  },
  'rate-341': {
    category: 'rate_limit',
    retryable: true,
    operatorText:
      'Application limit reached (code 341) — a temporary, self-clearing cap on how much this app may do right now, not a permission problem. Back off and retry after the cool-down; check facebook_usage for the current budget.',
    nextTool: 'facebook_usage',
    retryAfterMs: 60000,
  },
  'rate-buc': {
    category: 'rate_limit',
    retryable: true,
    operatorText:
      'Business-use-case rate limit reached (codes 80000-80099). Retry after the estimated cool-down; check facebook_usage for the throttled bucket.',
    nextTool: 'facebook_usage',
    retryAfterMs: 60000,
  },
  'duplicate-506': {
    category: 'duplicate',
    retryable: false,
    operatorText:
      'Duplicate post rejected (code 506) — Facebook considers this identical to a recent post, so it was NOT published again and is NOT retried. The original is likely already live; verify with facebook_list_posts before changing the text and re-posting.',
    nextTool: 'facebook_list_posts',
  },
  'not-found-100-21': {
    category: 'not_found',
    retryable: false,
    operatorText:
      'The Page id has been migrated to a new id (code 100/21). Do not retry — this id will ' +
      'never resolve again; look up the current Page id and update FB_PAGE_ID (or the profile ' +
      'that supplies it).',
  },
  'not-found-21': {
    category: 'not_found',
    retryable: false,
    operatorText:
      'The Page id has been migrated to a new id (code 21). Do not retry — this id will never ' +
      'resolve again; the error message names the new id. Update FB_PAGE_ID (or the profile ' +
      'that supplies it) to the new id.',
  },
  'not-found-803': {
    category: 'not_found',
    retryable: false,
    operatorText:
      'The id or alias in the request does not resolve (code 803) — Graph found no object under that name, or refuses to look a user up by username. Do not retry: pass the numeric id (from the listing it came from), or treat the object as gone.',
  },
  'not-found-100-33': {
    category: 'not_found',
    retryable: false,
    operatorText:
      'Object does not exist, was deleted, or is not visible to this token (code 100/33). Do not retry — confirm the id and access, or treat it as already gone.',
  },
  'validation-100': {
    category: 'validation',
    retryable: false,
    operatorText:
      'Invalid parameter or unsupported request (code 100). This is a client-side error — fix the arguments; retrying unchanged will fail identically.',
  },
  'validation-324': {
    category: 'validation',
    retryable: false,
    operatorText:
      'Graph refused the media file this request carried as missing, unreadable or not a supported image (code 324); this call changed nothing. Do not retry unchanged: supply a valid image (for a URL, one that is publicly reachable and returns the image bytes).',
  },
  'transient-1': {
    category: 'transient',
    retryable: true,
    operatorText:
      'Temporary Graph error (code 1, "unknown/try again"). Safe to retry idempotent GETs after a short backoff; do NOT blindly retry a write — verify whether it landed first.',
  },
  'transient-2': {
    category: 'transient',
    retryable: true,
    operatorText:
      'Graph service temporarily unavailable (code 2). Safe to retry idempotent GETs after a short backoff; do NOT blindly retry a write — verify whether it landed first.',
  },
  'unsupported-12': {
    category: 'unsupported',
    retryable: false,
    operatorText:
      'Deprecated endpoint or parameter (code 12). This API surface is retired — upgrade the call; retrying will not help.',
  },
  'unsupported-2635': {
    category: 'unsupported',
    retryable: false,
    operatorText:
      'Deprecated Graph API version or edge (code 2635). Move to a supported version/edge; retrying will not help.',
  },
};

test('matrix snapshot: every row classifies to its frozen ErrorAction (C9)', () => {
  const actual: Record<string, ErrorAction> = {};
  for (const row of ERROR_MATRIX) {
    const env: GraphErrorEnvelope =
      row.subcode !== undefined
        ? { code: row.code, error_subcode: row.subcode }
        : { code: row.code };
    actual[row.id] = classifyGraphError(env);
  }
  assert.deepStrictEqual(actual, MATRIX_SNAPSHOT);
});

// ---------------------------------------------------------------------------
// Lookup specificity
// ---------------------------------------------------------------------------

test('matchErrorRow prefers an exact subcode over the code-only fallback', () => {
  assert.equal(matchErrorRow(190, 460)?.id, 'auth-190-460');
  assert.equal(matchErrorRow(190)?.id, 'auth-190');
  // An unknown subcode falls through to the code-only row, not to `unknown`.
  assert.equal(matchErrorRow(190, 99999)?.id, 'auth-190');
  // A code with no matching row at all returns undefined.
  assert.equal(matchErrorRow(424242), undefined);
});

// ---------------------------------------------------------------------------
// Auth / token death (C9, CC-AUTH-1)
// ---------------------------------------------------------------------------

test('CC-AUTH-1 / C9: 190 + subcodes 460/463/467 are non-retryable auth with re-auth guidance', () => {
  for (const subcode of [460, 463, 467]) {
    const a = classifyGraphError({ code: 190, error_subcode: subcode });
    assert.equal(a.category, 'auth');
    assert.equal(a.retryable, false);
    assert.equal(a.nextTool, 'facebook_whoami');
    assert.match(a.operatorText, /[Rr]e-authorize|FB_ACCESS_TOKEN/);
  }
  const bare = classifyGraphError({ code: 190 });
  assert.equal(bare.category, 'auth');
  assert.equal(bare.retryable, false);
  assert.match(bare.operatorText, /FB_ACCESS_TOKEN/);
});

test('regression: bare top-level codes 102/460/463/467 are the auth rows, not unknown, and the transport agrees', () => {
  // Graph sometimes ships the session codes at the TOP level instead of as a
  // 190 subcode. Each is a dead credential: non-retryable, pointing at
  // facebook_whoami, and terminal for the transport (never re-driven).
  for (const code of [102, 460, 463, 467]) {
    const a = classifyGraphError({ code });
    assert.equal(a.category, 'auth', `code ${code}`);
    assert.equal(a.retryable, false, `code ${code}`);
    assert.equal(a.nextTool, 'facebook_whoami', `code ${code}`);
    assert.match(a.operatorText, new RegExp(`code ${code}`));
    assert.match(a.operatorText, /[Rr]e-authorize|[Rr]efresh|fresh token/);
    assert.equal(a.retryAfterMs, undefined, `code ${code}`);
    assert.equal(classifyHttpError(400, code), 'terminal', `code ${code}`);
  }
});

// ---------------------------------------------------------------------------
// Permission / Page role (CC-AUTH-3, CC-AUTH-4)
// ---------------------------------------------------------------------------

test('CC-AUTH-3: 200/10 map to permission (check Page role) and are never retryable', () => {
  for (const code of [200, 10]) {
    const a = classifyGraphError({ code });
    assert.equal(a.category, 'permission');
    assert.equal(a.retryable, false);
    assert.match(a.operatorText, /role on the Page/);
  }
});

test('regression: 12/2635 are retired surfaces never worth a retry', () => {
  for (const code of [12, 2635]) {
    const a = classifyGraphError({ code });
    assert.equal(a.category, 'unsupported', `code ${code}`);
    assert.equal(a.retryable, false, `code ${code}`);
    assert.equal(a.nextTool, undefined, `code ${code}`);
    assert.match(a.operatorText, new RegExp(`code ${code}`));
    assert.match(a.operatorText, /retrying will not help/);
    assert.equal(classifyHttpError(400, code), 'terminal', `code ${code}`);
  }
});

// Graph's 803 is "(#803) Some of the aliases you requested do not exist: X" (or
// "(#803) Cannot query users by their username"): the id/alias in the path
// resolves to nothing. It is not a scope or Page-role refusal — that is what
// 100/33, 10 and 200-299 say — so a model told to check its Page role and run
// facebook_whoami chases a permission problem that does not exist.
test('803 is an unresolvable id/alias (not_found), never a Page-role problem', () => {
  const a = classifyGraphError({
    code: 803,
    message: '(#803) Some of the aliases you requested do not exist: acme-page',
    type: 'OAuthException',
  });
  assert.equal(a.category, 'not_found');
  assert.equal(a.retryable, false);
  assert.equal(a.nextTool, undefined);
  assert.match(a.operatorText, /code 803/);
  assert.match(a.operatorText, /numeric id/);
  assert.doesNotMatch(a.operatorText, /Page role|permission/i);
  assert.equal(classifyHttpError(400, 803), 'terminal');
});

// 324 is Graph's "Missing or invalid image file": the media the call carried
// (an upload, a thumbnail, a URL Meta fetched) is unusable. Unmatched it fell to
// the `unknown` row, which invites the caller to "decide whether the action is
// safe to repeat" — the same bytes fail the same way every time.
test('324 is an unusable media file (validation, not retryable), never "unclassified"', () => {
  const a = classifyGraphError({
    code: 324,
    message: '(#324) Missing or invalid image file',
    type: 'OAuthException',
  });
  assert.equal(a.category, 'validation');
  assert.equal(a.retryable, false);
  assert.match(a.operatorText, /code 324/);
  assert.match(a.operatorText, /this call changed nothing/);
  assert.doesNotMatch(a.operatorText, /Unclassified|safe to repeat/);
  assert.equal(classifyHttpError(400, 324), 'terminal');
});

// Graph rejects a bad or missing `appsecret_proof` as a plain code 100 — no
// subcode — which the matrix reads as "fix the arguments". The arguments are
// not what is wrong: the proof is computed from FB_APP_SECRET, so the operator
// has to fix the app secret (or the token's app), and every call fails the same
// way until they do.
test('a code-100 appsecret_proof rejection points at FB_APP_SECRET, not the tool arguments', () => {
  for (const message of [
    'Invalid appsecret_proof provided in the API argument',
    'API calls from the server require an appsecret_proof argument',
  ]) {
    const a = classifyGraphError({ code: 100, message, type: 'GraphMethodException' });
    assert.equal(a.category, 'auth', message);
    assert.equal(a.retryable, false, message);
    assert.match(a.operatorText, /FB_APP_SECRET/, message);
    assert.doesNotMatch(a.operatorText, /fix the arguments/, message);
  }
  // Scoped to code 100: the same words under a throttle keep the throttle row.
  assert.equal(
    classifyGraphError({ code: 4, message: 'appsecret_proof rate limited' }).category,
    'rate_limit',
  );
  // An ordinary code 100 is still a validation error.
  assert.equal(
    classifyGraphError({ code: 100, message: '(#100) Invalid parameter' }).category,
    'validation',
  );
});

test('CC-AUTH-4: permission mapping names the missing permission and points at facebook_whoami', () => {
  const a = classifyGraphError({ code: 200 });
  assert.match(a.operatorText, /permission named in the error message/);
  assert.equal(a.nextTool, 'facebook_whoami');
});

// Meta documents 200-299 as ONE family ("API Permission", the code varying with
// which permission is missing) and its own SDKs hardcode the range; the matrix
// knew only the exact codes 200/10 (and 803, since reclassified as not_found). Everything else in the family —
// (#294) ads_management, (#240) business_management, (#210) user not visible —
// fell through to `unknown`, whose closing advice is "decide whether the action
// is safe to repeat". Repeating is exactly what cannot work: a missing scope
// refuses the call identically forever, and no next tool was offered either.
test('CC-AUTH-3: the 201-299 permission family is permission, not an unclassified error', () => {
  for (const code of [201, 210, 240, 294, 299]) {
    const a = classifyGraphError({ code });
    assert.equal(a.category, 'permission', `code ${code}`);
    assert.equal(a.retryable, false, `code ${code}`);
    assert.equal(a.nextTool, 'facebook_whoami', `code ${code}`);
    assert.doesNotMatch(
      a.operatorText,
      /safe to repeat/,
      'a missing scope refuses the call identically forever',
    );
  }
  // The exact 200 row is more specific than the family and still wins.
  assert.equal(matchErrorRow(200)?.id, 'permission-200');
  assert.equal(matchErrorRow(294)?.id, 'permission-2xx');
  // The family does not leak past its documented bounds.
  assert.equal(classifyGraphError({ code: 300 }).category, 'unknown');
  assert.equal(classifyGraphError({ code: 199 }).category, 'unknown');
});

// ---------------------------------------------------------------------------
// Throttle families (CC-NET-1, CC-NET-3)
// ---------------------------------------------------------------------------

test('CC-NET-1: throttle families 4/17/32/613 classify as retryable rate_limit from a 400 body', () => {
  for (const code of [4, 17, 32, 613]) {
    const a = classifyGraphError({ code });
    assert.equal(a.category, 'rate_limit', `code ${code}`);
    assert.equal(a.retryable, true);
    assert.equal(a.nextTool, 'facebook_usage');
    assert.equal(a.retryAfterMs, 60_000);
  }
  // Classification is by BODY code, not the status line: a 400 still yields rate_limit.
  const err = toGraphApiError({ code: 4 }, 400);
  assert.equal(err.httpStatus, 400);
  assert.equal(err.action?.category, 'rate_limit');
});

test('CC-NET-1: the 80000-80099 business-use-case range matches by range, boundaries inclusive', () => {
  for (const code of [80000, 80001, 80050, 80099]) {
    assert.equal(classifyGraphError({ code }).category, 'rate_limit', `code ${code}`);
  }
  assert.equal(classifyGraphError({ code: 79999 }).category, 'unknown');
  assert.equal(classifyGraphError({ code: 80100 }).category, 'unknown');
});

test('CC-NET-3: throttles honor estimated_time_to_regain_access (minutes) as surfaced retryAfterMs', () => {
  assert.equal(
    classifyGraphError({ code: 4, estimated_time_to_regain_access: 5 }).retryAfterMs,
    5 * 60_000,
  );
  // Absent ETA => the row default.
  assert.equal(classifyGraphError({ code: 4 }).retryAfterMs, 60_000);
  // A huge ETA is surfaced verbatim — the 60s cap applies to the sleep, not the surface.
  assert.equal(
    classifyGraphError({ code: 17, estimated_time_to_regain_access: 120 }).retryAfterMs,
    120 * 60_000,
  );
  // A non-positive / non-finite ETA is ignored in favour of the default.
  assert.equal(
    classifyGraphError({ code: 32, estimated_time_to_regain_access: 0 }).retryAfterMs,
    60_000,
  );
});

// ---------------------------------------------------------------------------
// Duplicate / temporary block / not-found / validation / transient
// ---------------------------------------------------------------------------

test('C2: duplicate post (506) is surfaced, never retried, and points at a verify tool', () => {
  const a = classifyGraphError({ code: 506 });
  assert.equal(a.category, 'duplicate');
  assert.equal(a.retryable, false);
  assert.equal(a.nextTool, 'facebook_list_posts');
  assert.match(a.operatorText, /NOT retried/);
});

test('368 temporary policy block is non-retryable and surfaces only a cool-down Graph named', () => {
  const a = classifyGraphError({ code: 368 });
  assert.equal(a.category, 'permission');
  assert.equal(a.retryable, false);
  assert.match(a.operatorText, /temporarily blocked/);
  assert.equal(
    classifyGraphError({ code: 368, estimated_time_to_regain_access: 30 }).retryAfterMs,
    30 * 60_000,
  );
});

// A policy block lasts hours to days (the Reels daily cap arrives as 368 on a
// rolling 24 h window), and repeated attempts extend it. The generic 60 s
// throttle default is not Graph's estimate: stamping it onto an ETA-less 368
// told the model `retryAfterMs: 60000` right next to "Do NOT auto-retry", and a
// caller that honours the number comes back in a minute and lengthens the block.
test('368 without an ETA surfaces no invented 60 s cool-down', () => {
  const a = classifyGraphError({ code: 368 });
  assert.equal(
    a.retryAfterMs,
    undefined,
    'a policy block with no ETA on the wire must not claim a one-minute cool-down',
  );
  assert.equal(
    classifyGraphError({ code: 368, error_subcode: 1390008 }).retryAfterMs,
    undefined,
  );
});

test('code 100 splits: object-gone (100/33) is not_found, bare 100 is validation', () => {
  assert.equal(
    classifyGraphError({ code: 100, error_subcode: 33 }).category,
    'not_found',
  );
  assert.equal(classifyGraphError({ code: 100 }).category, 'validation');
});

// `src/core/auth.ts` declares BOTH 21 and 33 as `STALE_OBJECT_SUBCODES` — the
// CC-AUTH-7 rail treats each as "the object this Page id points at moved" and
// spends one re-derivation on it. The matrix knew only about 33, so once that
// retry was spent 100/21 was classified as a parameter mistake and the operator
// was told to fix their arguments. Nothing they can do to the arguments will
// help: Meta migrated the Page to a new id, and the old one is dead for good.
test('100/21 (migrated Page id) is not_found and names the id, not the arguments', () => {
  const action = classifyGraphError({ code: 100, error_subcode: 21 });
  assert.equal(action.category, 'not_found');
  assert.equal(action.retryable, false);
  assert.match(action.operatorText, /FB_PAGE_ID/);
  assert.doesNotMatch(
    action.operatorText,
    /fix the arguments/,
    'the arguments are not what is wrong, so advising a fix there sends the operator nowhere',
  );
});

// Graph prefixes every error message with its code — "(#21) Page ID X was
// migrated to page ID Y. Please update your API calls to the new ID" — and the
// migrated-Page refusal arrives under top-level code 21, not as a subcode of
// 100. With no row for it the operator got "Unclassified Graph error (code 21)
// ... decide whether the action is safe to repeat", for an id that will never
// resolve again.
test('top-level code 21 (migrated Page id) is not_found and names the fix, not unknown', () => {
  const action = classifyGraphError({
    code: 21,
    message:
      '(#21) Page ID 111 was migrated to page ID 222. Please update your API calls to the new ID',
  });
  assert.equal(action.category, 'not_found');
  assert.equal(action.retryable, false);
  assert.match(action.operatorText, /migrated/);
  assert.match(action.operatorText, /FB_PAGE_ID/);
  assert.equal(matchErrorRow(21, 987_654)?.id, 'not-found-21');
});

test('190/492 is a permission failure, not a dead credential', () => {
  const action = classifyGraphError({ code: 190, error_subcode: 492 });
  assert.equal(
    action.category,
    'permission',
    'the token is alive; what is missing is a Page role, and the category is what tools branch on',
  );
  assert.equal(action.retryable, false);
  assert.match(action.operatorText, /Page role/);
  assert.doesNotMatch(
    action.operatorText,
    /^Invalid or expired OAuth access token/,
    'falling through to the generic 190 row advises refreshing a credential that is not the problem',
  );
});

test('190/459 tells the operator to clear the checkpoint before re-issuing the token', () => {
  const action = classifyGraphError({ code: 190, error_subcode: 459 });
  assert.equal(action.category, 'auth');
  assert.equal(action.retryable, false);
  assert.match(action.operatorText, /checkpoint/i);
  // The ordering is the point: a new token minted before the checkpoint is cleared
  // is refused identically, so "refresh first" is a loop with no exit.
  assert.match(action.operatorText, /Do not mint a new token yet/);
});

test('190/464 tells the operator to confirm the account before re-issuing the token', () => {
  const action = classifyGraphError({ code: 190, error_subcode: 464 });
  assert.equal(action.category, 'auth');
  assert.equal(action.retryable, false);
  assert.equal(action.nextTool, 'facebook_whoami');
  assert.match(action.operatorText, /unconfirmed/i);
  // Same trap as the checkpoint: a token minted for an unconfirmed user is refused
  // identically, so the generic "refresh the credential" advice loops.
  assert.match(action.operatorText, /Do not mint a new token yet/);
});

test('generic transient codes 1/2 are retryable transient with a verify-before-write caveat', () => {
  for (const code of [1, 2]) {
    const a = classifyGraphError({ code });
    assert.equal(a.category, 'transient');
    assert.equal(a.retryable, true);
    assert.match(a.operatorText, /verify whether it landed|blindly retry a write/);
  }
});

test('an unrecognized code falls back to a non-retryable unknown action, embedding the code', () => {
  const a = classifyGraphError({ code: 999999 });
  assert.equal(a.category, 'unknown');
  assert.equal(a.retryable, false);
  assert.match(a.operatorText, /999999/);
  assert.equal(a.nextTool, undefined);
  assert.equal(a.retryAfterMs, undefined);
});

test('an unrecognized code Graph flags `is_transient: true` is a retryable transient, not unknown', () => {
  // Graph's own verdict on an error the matrix has no row for: the request may
  // be repeated. Dropped on the floor, the operator is told to inspect and
  // decide by hand what Graph already decided for them.
  const a = classifyGraphError({ code: 999999, is_transient: true });
  assert.equal(a.category, 'transient');
  assert.equal(a.retryable, true);
  assert.match(a.operatorText, /999999/);
  assert.match(a.operatorText, /transient/i);
  assert.equal(a.nextTool, undefined);
  assert.equal(a.retryAfterMs, undefined);
});

test('is_transient never overrides a matrix row, and a false or missing flag changes nothing', () => {
  // Regression coverage: a known row carries the specific remedy; Graph's
  // generic flag must not lift a revoked token or a validation refusal into a
  // retry. `false` on an unknown code is the plain unknown verdict.
  const auth = classifyGraphError({ code: 190, is_transient: true });
  assert.equal(auth.category, 'auth');
  assert.equal(auth.retryable, false);
  const validation = classifyGraphError({ code: 100, is_transient: true });
  assert.equal(validation.category, 'validation');
  assert.equal(validation.retryable, false);
  const flaggedFalse = classifyGraphError({ code: 999999, is_transient: false });
  assert.equal(flaggedFalse.category, 'unknown');
  assert.equal(flaggedFalse.retryable, false);
  // The known transient rows keep their own verdict whatever the flag says.
  const knownTransient = classifyGraphError({ code: 2, is_transient: false });
  assert.equal(knownTransient.category, 'transient');
  assert.equal(knownTransient.retryable, true);
});

// ---------------------------------------------------------------------------
// GraphApiError construction
// ---------------------------------------------------------------------------

test('toGraphApiError maps the envelope onto the frozen GraphApiError and attaches the action', () => {
  const err = toGraphApiError(
    {
      code: 190,
      error_subcode: 463,
      type: 'OAuthException',
      fbtrace_id: 'Axyz',
      message: 'Error validating access token: Session has expired.',
    },
    401,
  );
  assert.ok(err instanceof GraphApiError);
  assert.equal(err.code, 190);
  assert.equal(err.subcode, 463);
  assert.equal(err.type, 'OAuthException');
  assert.equal(err.fbtraceId, 'Axyz');
  assert.equal(err.httpStatus, 401);
  assert.equal(err.message, 'Error validating access token: Session has expired.');
  assert.equal(err.action?.category, 'auth');
  assert.equal(err.action?.retryable, false);
  assert.equal(err.action?.nextTool, 'facebook_whoami');
});

test('toGraphApiError synthesizes a message when the envelope omits one and carries a cause', () => {
  const cause = new Error('root');
  const err = toGraphApiError({ code: 4 }, 400, { cause });
  assert.match(err.message, /code 4/);
  assert.equal(err.cause, cause);
  assert.equal(err.subcode, undefined);
  assert.equal(err.action?.category, 'rate_limit');
});

test('toGraphApiError carries error_user_title / error_user_msg past a message override', () => {
  // The transport overrides `message` with its redacted, status-prefixed line;
  // the user-facing text must not be lost behind that override, nor folded into
  // it — it ships as its own two fields so `message` stays greppable.
  const envelope: GraphErrorEnvelope = {
    code: 100,
    error_subcode: 1_487_390,
    type: 'OAuthException',
    message: 'Invalid parameter',
    error_user_title: 'Budget Too Low',
    error_user_msg: 'The daily budget must be at least $1.00.',
  };
  const overridden = toGraphApiError(envelope, 400, {
    message: 'Graph API error (HTTP 400): Invalid parameter',
  });
  assert.equal(overridden.message, 'Graph API error (HTTP 400): Invalid parameter');
  assert.equal(overridden.userTitle, 'Budget Too Low');
  assert.equal(overridden.userMessage, 'The daily budget must be at least $1.00.');

  const plain = toGraphApiError(envelope, 400);
  assert.equal(plain.message, 'Invalid parameter');
  assert.equal(plain.userTitle, 'Budget Too Low');
  assert.equal(plain.userMessage, 'The daily budget must be at least $1.00.');

  // Absent on the envelope ⇒ absent on the error, never an empty string.
  const bare = toGraphApiError({ code: 100, message: 'Invalid parameter' }, 400);
  assert.equal(bare.userTitle, undefined);
  assert.equal(bare.userMessage, undefined);
});

// ---------------------------------------------------------------------------
// Non-JSON error bodies (CC-NET-4)
// ---------------------------------------------------------------------------

// The body snippet itself is bounded and redacted by the transport, so the
// end-to-end shape of a non-JSON error lives in `./http.test.ts`; what belongs
// here is the classification the transport asks this module for.

test('CC-NET-4: a body with no Graph envelope is transient on 5xx, unknown otherwise', () => {
  const server = nonJsonBodyAction(503);
  assert.equal(server.category, 'transient');
  assert.equal(server.retryable, true);
  assert.match(server.operatorText, /503/);

  // A 4xx we cannot parse gives no ground to call the request safe to repeat.
  const client = nonJsonBodyAction(418);
  assert.equal(client.category, 'unknown');
  assert.equal(client.retryable, false);
  assert.match(client.operatorText, /do not retry automatically/);
});

// A bare 429 has no Graph envelope BY DEFINITION: Graph ships its own throttles
// as HTTP 400 + a body code (CC-NET-1), so a 429 came from an edge, a CDN or a
// corporate proxy — and it arrives with that hop's HTML, which is the CC-NET-6
// interception signature. `classifyHttpError` already reads it as a throttle and
// backs off; this classifier folded it in with 418 and every other unparseable
// 4xx and called it `unknown`, so the two readings of the SAME response
// disagreed. Both ends of that disagreement were wrong, differently: an
// un-retried 429 surfaced to the model as a non-retryable `unknown`, and once
// retries WERE exhausted the transport passed `category: 'rate_limit'`
// explicitly, the categories no longer matched, and actionForResponse dropped
// this row's text for the six-word generic one — losing the proxy hint that is
// the whole reason this function carries it.
test('code 341 is the application limit it is, not an unclassified error', () => {
  // Meta ships 341 ("Application limit reached") in the same throttle family as
  // 4/17/32/613, but it had no row — so a real, temporary, self-clearing limit
  // reached the model through the unknown-error path, which offers no next tool
  // and closes by inviting a decision about whether the call is safe to repeat.
  const action = classifyGraphError({ code: 341 });
  assert.equal(action.category, 'rate_limit');
  assert.equal(action.retryable, true);
  assert.equal(action.nextTool, 'facebook_usage');
});

test('CC-NET-1/CC-NET-6: a bare 429 with no envelope is the rate limit the transport already sees', () => {
  assert.equal(
    classifyHttpError(429, undefined),
    'throttle',
    'the transport reads a bare 429 as a throttle — this classifier must not contradict it',
  );
  const a = nonJsonBodyAction(429);
  assert.equal(a.category, 'rate_limit');
  assert.equal(a.retryable, true);
  assert.equal(a.nextTool, 'facebook_usage');
  assert.equal(a.retryAfterMs, DEFAULT_THROTTLE_RETRY_AFTER_MS);
  assert.match(a.operatorText, /429/);
  // Agreeing on the category is what keeps this text — hint included — alive.
  assert.ok(a.operatorText.includes(PROXY_ENV_HINT));
});

// ---------------------------------------------------------------------------
// Network faults + ambiguous writes (CC-NET-5, C2)
// ---------------------------------------------------------------------------

test('CC-NET-5: DNS/connect faults are provably-not-sent -> retryable transient, even for writes', () => {
  for (const phase of ['dns', 'connect'] as const) {
    const a = classifyNetworkError({ phase, isWrite: true });
    assert.equal(a.category, 'transient');
    assert.equal(a.retryable, true);
    assert.match(a.operatorText, /never reached Facebook/);
  }
});

test('C2 / CC-NET-5: a later-phase fault on a WRITE is ambiguous and never retryable', () => {
  for (const phase of ['send', 'response', 'timeout', 'unknown'] as const) {
    const a = classifyNetworkError({ phase, isWrite: true });
    assert.equal(a.category, 'ambiguous', phase);
    assert.equal(a.retryable, false);
    assert.match(a.operatorText, /NOT retry blindly/);
    // A bare network fault does not know what was written, so it names no tool.
    assert.equal(a.nextTool, undefined, phase);
    assert.doesNotMatch(a.operatorText, /facebook_/);
  }
});

test('CC-NET-5: a later-phase fault on a READ is retryable transient', () => {
  const a = classifyNetworkError({ phase: 'timeout', isWrite: false });
  assert.equal(a.category, 'transient');
  assert.equal(a.retryable, true);
  assert.match(a.operatorText, /no Graph response was received/);
});

test('C2: ambiguousWriteAction carries the "verify, do not retry" contract with an overridable verify tool', () => {
  const a = ambiguousWriteAction();
  assert.equal(a.category, 'ambiguous');
  assert.equal(a.retryable, false);
  assert.match(a.operatorText, /NOT retry blindly/);

  const custom = ambiguousWriteAction({
    verifyTool: 'facebook_get_conversation',
    detail: 'send timed out',
  });
  assert.equal(custom.nextTool, 'facebook_get_conversation');
  assert.match(custom.operatorText, /send timed out/);
  assert.match(custom.operatorText, /verify via facebook_get_conversation first/);

  const feed = ambiguousWriteAction({ verifyTool: DEFAULT_VERIFY_TOOL });
  assert.equal(feed.nextTool, 'facebook_list_posts');
});

test('C2: ambiguousWriteAction without a verify tool names no tool at all', () => {
  // The action cannot know whether a comment, an ad, a message or a block was
  // written; any tool it names by default is wrong for most writes.
  const a = ambiguousWriteAction({ detail: 'HTTP 502 on DELETE' });
  assert.equal(a.nextTool, undefined);
  assert.doesNotMatch(a.operatorText, /facebook_list_posts/);
  assert.doesNotMatch(a.operatorText, /facebook_get_conversation/);
  assert.match(a.operatorText, /re-read the object/);
});

test('C2: ambiguousWriteAction with a verify tool names only that tool', () => {
  const a = ambiguousWriteAction({ verifyTool: 'facebook_get_comment' });
  assert.equal(a.nextTool, 'facebook_get_comment');
  assert.match(a.operatorText, /facebook_get_comment/);
  assert.doesNotMatch(a.operatorText, /facebook_get_conversation/);
});

// ---------------------------------------------------------------------------
// Cursor expiry (CC-PAGE-2)
// ---------------------------------------------------------------------------

test('cursor expiry maps to a non-retryable cursor_expired action that restarts the listing', () => {
  const a = cursorExpiredAction({ nextTool: 'facebook_list_posts' });
  assert.equal(a.category, 'cursor_expired');
  assert.equal(a.retryable, false);
  assert.equal(a.nextTool, 'facebook_list_posts');
  assert.match(a.operatorText, /restart the listing/);
  // nextTool is optional.
  assert.equal(cursorExpiredAction().nextTool, undefined);
});

// Graph publishes no code for a rejected cursor, so the classification is a
// scoped probe (codes 1/100 + Graph's raw prose) rather than a matrix row. These
// tests pin BOTH directions: the codes it must catch, and the far larger set of
// failures whose text mentions a cursor and must NOT be hijacked by it.

test('CC-PAGE-2: a cursor rejection is recognized under the codes Graph delivers it as', () => {
  for (const envelope of [
    { code: 100, message: 'The cursor you provided is not valid.' },
    { code: 100, error_subcode: 33, message: 'Invalid cursor: object no longer exists' },
    { code: 1, message: 'An unknown error occurred: the cursor has expired' },
    // Case must not matter — Graph's wording is not stable across edges.
    { code: 100, message: 'Please provide a valid CURSOR' },
  ] satisfies GraphErrorEnvelope[]) {
    assert.equal(isCursorRejection(envelope), true, JSON.stringify(envelope));
    const a = classifyGraphError(envelope);
    assert.equal(a.category, 'cursor_expired', JSON.stringify(envelope));
    assert.equal(a.retryable, false, 'the same dead cursor fails identically forever');
    assert.match(a.operatorText, /restart the listing/);
  }
});

test('CC-PAGE-2: cursor prose under any other code keeps the matrix classification', () => {
  // Every one of these mentions a cursor; none of them IS a cursor rejection.
  const cases: readonly (readonly [GraphErrorEnvelope, string])[] = [
    [{ code: 190, message: 'Session expired while fetching cursor' }, 'auth'],
    [
      { code: 32, message: 'Page-level throttle hit paging with cursor c1' },
      'rate_limit',
    ],
    [{ code: 200, message: 'Permissions error reading the cursor' }, 'permission'],
    [{ code: 506, message: 'Duplicate post; cursor is invalid' }, 'duplicate'],
  ];
  for (const [envelope, category] of cases) {
    assert.equal(isCursorRejection(envelope), false, JSON.stringify(envelope));
    assert.equal(classifyGraphError(envelope).category, category);
  }
});

test('CC-PAGE-2: codes 1 and 100 without cursor prose keep their matrix rows', () => {
  assert.equal(isCursorRejection({ code: 100, message: 'Invalid parameter' }), false);
  assert.equal(
    classifyGraphError({ code: 100, message: 'Invalid parameter' }).category,
    'validation',
  );
  assert.equal(
    isCursorRejection({ code: 1 }),
    false,
    'no message at all is not a cursor error',
  );
  assert.equal(classifyGraphError({ code: 1 }).category, 'transient');
  assert.equal(
    classifyGraphError({ code: 100, error_subcode: 33, message: 'Object does not exist' })
      .category,
    'not_found',
  );
});

// ---------------------------------------------------------------------------
// Corporate proxy / TLS interception (CC-NET-6)
// ---------------------------------------------------------------------------

test('CC-NET-6: connection-level faults name the proxy env vars an operator must check', () => {
  for (const phase of ['dns', 'connect', 'timeout', 'response', 'send'] as const) {
    const a = classifyNetworkError({ phase, isWrite: false });
    assert.match(a.operatorText, /HTTPS_PROXY/, phase);
    assert.match(a.operatorText, /HTTP_PROXY/, phase);
    assert.match(a.operatorText, /ALL_PROXY/, phase);
    assert.match(a.operatorText, /NO_PROXY/, phase);
    assert.ok(a.operatorText.includes(PROXY_ENV_HINT), phase);
  }
});

test('CC-NET-6: a body with no Graph envelope (the interception signature) carries the hint', () => {
  // Both branches, because an HTML interstitial is as likely to arrive with a
  // 4xx from the middlebox itself as with a 5xx from an edge.
  assert.ok(nonJsonBodyAction(403).operatorText.includes(PROXY_ENV_HINT));
  assert.ok(nonJsonBodyAction(502).operatorText.includes(PROXY_ENV_HINT));
});

test('CC-NET-6: the hint is honest that no custom CA is installed', () => {
  assert.match(PROXY_ENV_HINT, /no custom CA/);
});

// ---------------------------------------------------------------------------
// errorMessageOf — the one guarded "message of any throwable"
// ---------------------------------------------------------------------------

test('errorMessageOf: an Error yields its message', () => {
  assert.equal(errorMessageOf(new Error('boom')), 'boom');
  assert.equal(errorMessageOf(new TypeError('')), '');
});

test('errorMessageOf: a plain { message } object keeps its text, not "[object Object]"', () => {
  assert.equal(errorMessageOf({ message: 'library said no' }), 'library said no');
});

test('errorMessageOf: a non-string message is not a message; the value is stringified', () => {
  assert.equal(errorMessageOf({ message: 42 }), '[object Object]');
});

test('errorMessageOf: primitives stringify', () => {
  assert.equal(errorMessageOf('bare string'), 'bare string');
  assert.equal(errorMessageOf(42), '42');
  assert.equal(errorMessageOf(undefined), 'undefined');
  assert.equal(errorMessageOf(null), 'null');
});

test('errorMessageOf: a null-prototype object does not throw', () => {
  // `String(Object.create(null))` throws a TypeError (no toString / toPrimitive).
  assert.equal(errorMessageOf(Object.create(null)), NO_ERROR_MESSAGE);
});

test('errorMessageOf: an object whose toString throws does not throw', () => {
  const hostile = {
    toString(): string {
      throw new Error('toString exploded');
    },
  };
  assert.equal(errorMessageOf(hostile), NO_ERROR_MESSAGE);
});

test('errorMessageOf: an Error whose message getter throws yields the fallback, never a throw', () => {
  // Reading `.message` throws, and `Error.prototype.toString` reads it again, so
  // there is no text to recover: the documented fallback is returned.
  const err = new Error('unused');
  Object.defineProperty(err, 'message', {
    get(): string {
      throw new Error('getter exploded');
    },
  });
  assert.equal(errorMessageOf(err), NO_ERROR_MESSAGE);
});
