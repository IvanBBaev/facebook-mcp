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
import { ERROR_MATRIX } from './error-matrix.js';
import {
  ambiguousWriteAction,
  classifyGraphError,
  classifyNetworkError,
  cursorExpiredAction,
  DEFAULT_VERIFY_TOOL,
  graphErrorFromNonJson,
  matchErrorRow,
  NON_JSON_BODY_MAX,
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
    retryAfterMs: 60000,
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
  'permission-803': {
    category: 'permission',
    retryable: false,
    operatorText:
      'Object cannot be accessed with the current permissions (code 803) — it may be restricted or require a different Page role. Run facebook_whoami.',
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

test('CC-AUTH-4: permission mapping names the missing permission and points at facebook_whoami', () => {
  const a = classifyGraphError({ code: 200 });
  assert.match(a.operatorText, /permission named in the error message/);
  assert.equal(a.nextTool, 'facebook_whoami');
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

test('368 temporary policy block is non-retryable but surfaces a cool-down ETA', () => {
  const a = classifyGraphError({ code: 368 });
  assert.equal(a.category, 'permission');
  assert.equal(a.retryable, false);
  assert.equal(a.retryAfterMs, 60_000);
  assert.match(a.operatorText, /temporarily blocked/);
  assert.equal(
    classifyGraphError({ code: 368, estimated_time_to_regain_access: 30 }).retryAfterMs,
    30 * 60_000,
  );
});

test('code 100 splits: object-gone (100/33) is not_found, bare 100 is validation', () => {
  assert.equal(
    classifyGraphError({ code: 100, error_subcode: 33 }).category,
    'not_found',
  );
  assert.equal(classifyGraphError({ code: 100 }).category, 'validation');
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

// ---------------------------------------------------------------------------
// Non-JSON error bodies (CC-NET-4)
// ---------------------------------------------------------------------------

test('CC-NET-4: a non-JSON 5xx body yields a retryable transient error with a bounded snippet', () => {
  const body = `<html>${'x'.repeat(500)}</html>`;
  const err = graphErrorFromNonJson(503, body);
  assert.ok(err instanceof GraphApiError);
  assert.equal(err.httpStatus, 503);
  assert.equal(err.code, -1);
  assert.equal(err.action?.category, 'transient');
  assert.equal(err.action?.retryable, true);
  // The snippet is bounded to NON_JSON_BODY_MAX bytes (plus a short prefix).
  assert.ok(err.message.length <= NON_JSON_BODY_MAX + 40);
  assert.ok(err.message.includes('xxxxxxxxxx'));
});

test('CC-NET-4: a non-JSON 4xx body is non-retryable unknown; an empty body does not crash', () => {
  const err = graphErrorFromNonJson(418, undefined);
  assert.ok(err instanceof GraphApiError);
  assert.equal(err.action?.category, 'unknown');
  assert.equal(err.action?.retryable, false);
  assert.match(err.message, /HTTP 418/);
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
    assert.match(a.operatorText, /facebook_list_posts \/ facebook_get_conversation/);
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
  assert.equal(a.nextTool, DEFAULT_VERIFY_TOOL);
  assert.match(a.operatorText, /NOT retry blindly/);

  const custom = ambiguousWriteAction({
    verifyTool: 'facebook_get_conversation',
    detail: 'send timed out',
  });
  assert.equal(custom.nextTool, 'facebook_get_conversation');
  assert.match(custom.operatorText, /send timed out/);
  assert.match(
    custom.operatorText,
    /facebook_get_conversation \/ facebook_get_conversation/,
  );
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
