// Graph error -> action classification (task F06, behaviour half).
//
// This module turns a parsed Graph error envelope
//   { error: { message, type, code, error_subcode, fbtrace_id } }
// into the frozen ErrorAction (category + retryable + next-tool + operator text)
// and constructs the frozen GraphApiError carrying it. The lookup DATA lives in
// `./error-matrix.js`; this file is the logic that reads that table plus the few
// classifications that are NOT keyed by a Graph code (network faults, ambiguous
// writes, cursor expiry, non-JSON bodies).
//
// Layer: `core` (layer 0) — imports only sibling core modules and the frozen
// contracts from the core barrel. No api/mcp/tools imports; no I/O; pure.
//
// Retry authority (C9 / CC-NET-3/5): the ErrorAction here says WHETHER an error
// class is retryable and surfaces an ETA; the api-layer retry engine (F07/F08)
// owns WHEN — the GET/idempotent-only rule and the 60s internal sleep cap. The
// `retryAfterMs` this module emits is always a SURFACED estimate, never a sleep
// instruction (see ErrorAction docs in types.ts).

// Imported from `./types.js` rather than the `./index.js` barrel on purpose: the
// HTTP client (`./http.js`) classifies real Graph responses through this module,
// and the barrel re-exports http.js — going through it would make the two files
// mutually dependent at module-evaluation time.
import { GraphApiError, type ErrorAction } from './types.js';
import {
  DEFAULT_THROTTLE_RETRY_AFTER_MS,
  ERROR_MATRIX,
  ETA_MINUTES_TO_MS,
  type ErrorMatrixRow,
} from './error-matrix.js';

/**
 * A parsed Graph error envelope — the wire shape (snake_case) the HTTP client
 * (F07) hands to the matrix. `estimated_time_to_regain_access` is Graph's own
 * field, expressed in MINUTES; it is surfaced (never slept on) as `retryAfterMs`.
 */
export interface GraphErrorEnvelope {
  readonly code: number;
  readonly error_subcode?: number;
  readonly message?: string;
  readonly type?: string;
  readonly fbtrace_id?: string;
  /** Graph's throttle ETA, in MINUTES. Surfaced as `retryAfterMs`, not slept on. */
  readonly estimated_time_to_regain_access?: number;
  /**
   * Graph's own verdict that the failure is momentary and the request may be
   * repeated. Consulted ONLY for a code the matrix has no row for: a known row
   * carries the specific remedy and is never overridden by the generic flag.
   */
  readonly is_transient?: boolean;
  /**
   * Graph's human-readable headline / reason for a refusal (ads budget and
   * targeting rejections, policy blocks, scheduling-window violations). Often
   * the only concrete reason on the wire — `message` is then the generic
   * "Invalid parameter". Carried onto the error as `userTitle` / `userMessage`.
   */
  readonly error_user_title?: string;
  readonly error_user_msg?: string;
}

/**
 * Longest raw-body snippet embedded in a surfaced `GraphApiError` message. Used
 * for the bodies that carry no Graph envelope at all — HTML from an edge or a
 * proxy, an empty 5xx (CC-NET-4) — where the snippet is the only evidence the
 * operator gets. The HTTP client (`./http.js`) bounds its own snippets by this
 * same constant so there is one answer to "how much body is surfaced".
 */
export const NON_JSON_BODY_MAX = 200;

/**
 * Verify-tool for an ambiguous PUBLISHED feed post (C2). Not a default for every
 * write: a comment, an ad, a message or a block never shows up on a posts
 * listing, so {@link ambiguousWriteAction} names no tool unless told which.
 */
export const DEFAULT_VERIFY_TOOL = 'facebook_list_posts';

// ---------------------------------------------------------------------------
// Matrix lookup
// ---------------------------------------------------------------------------

/**
 * Find the most specific matrix row for a `{code, subcode}` pair, preferring:
 *   1. exact code + exact subcode,
 *   2. exact code with no subcode constraint,
 *   3. an inclusive code RANGE (e.g. 80000-80099).
 * Returns `undefined` when nothing matches (caller falls back to `unknown`).
 */
export function matchErrorRow(
  code: number,
  subcode?: number,
): ErrorMatrixRow | undefined {
  if (subcode !== undefined) {
    const exact = ERROR_MATRIX.find(
      (r) => r.codeMax === undefined && r.code === code && r.subcode === subcode,
    );
    if (exact) return exact;
  }
  const codeOnly = ERROR_MATRIX.find(
    (r) => r.codeMax === undefined && r.code === code && r.subcode === undefined,
  );
  if (codeOnly) return codeOnly;
  return ERROR_MATRIX.find(
    (r) => r.codeMax !== undefined && code >= r.code && code <= r.codeMax,
  );
}

/** Build an ErrorAction, omitting optional keys that are absent (clean snapshots). */
function makeAction(fields: {
  readonly category: ErrorAction['category'];
  readonly retryable: boolean;
  readonly operatorText: string;
  readonly nextTool?: string;
  readonly retryAfterMs?: number;
}): ErrorAction {
  return {
    category: fields.category,
    retryable: fields.retryable,
    operatorText: fields.operatorText,
    ...(fields.nextTool !== undefined ? { nextTool: fields.nextTool } : {}),
    ...(fields.retryAfterMs !== undefined ? { retryAfterMs: fields.retryAfterMs } : {}),
  };
}

/** Surfaced retry-after: the envelope ETA (minutes->ms) when honored, else the row default. */
function computeRetryAfterMs(
  row: ErrorMatrixRow,
  envelope: GraphErrorEnvelope,
): number | undefined {
  const eta = envelope.estimated_time_to_regain_access;
  if (row.honorEta && typeof eta === 'number' && Number.isFinite(eta) && eta > 0) {
    return Math.round(eta * ETA_MINUTES_TO_MS);
  }
  return row.retryAfterMs;
}

/** The fallback action for a Graph code the matrix does not recognize. */
function unknownAction(code: number): ErrorAction {
  return makeAction({
    category: 'unknown',
    retryable: false,
    operatorText:
      `Unclassified Graph error (code ${code}). Not retried automatically — inspect the ` +
      'message and fbtrace_id, then decide whether the action is safe to repeat.',
  });
}

/**
 * The verdict for a code outside the matrix that Graph itself flags
 * `is_transient: true`. Graph has already said the request may be repeated;
 * refusing that on the grounds that the code is unfamiliar would tell the
 * operator to inspect and decide by hand what the envelope already decided.
 * Writes still carry the C2 caveat: "may be repeated" is Graph's word, and a
 * transient fault on a write can still have landed.
 */
function flaggedTransientAction(code: number): ErrorAction {
  return makeAction({
    category: 'transient',
    retryable: true,
    operatorText:
      `Graph error (code ${code}) is unclassified but flagged transient by Graph. ` +
      'Retry with backoff; for a write, verify whether it landed before repeating it.',
  });
}

// ---------------------------------------------------------------------------
// Cursor rejection (CC-PAGE-2) — classified AHEAD of the matrix
// ---------------------------------------------------------------------------

/**
 * The Graph codes a rejected pagination cursor arrives under.
 *
 * Graph publishes no dedicated code or subcode for cursor expiry, and the design
 * corpus never pinned one — CC-PAGE-2 specifies the HANDLING (partial results +
 * a restart note), not the wire shape — so `./error-matrix.js` has no row to key
 * on. What Graph does is reject the stale `after` as a bad PARAMETER:
 *   * 100 — "invalid parameter", the code the opaque cursor shares with every
 *     other rejected argument; a cursor that still decodes to an object Graph
 *     can no longer resolve arrives as 100/33 instead.
 *   * 1 — the "unknown error / try again" bucket a malformed cursor falls into.
 * All three of those already have rows (`validation-100`, `not-found-100-33`,
 * `transient-1`) and all three send the caller somewhere useless: "fix the
 * arguments" is unactionable when the argument is an opaque cursor, "the object
 * is gone" blames the wrong thing, and "safe to retry" is actively wrong — the
 * same dead cursor fails identically forever. Hence the pre-matrix override.
 */
const CURSOR_REJECTION_CODES: ReadonlySet<number> = new Set([1, 100]);

/**
 * True when a Graph error envelope is refusing the pagination cursor itself
 * (CC-PAGE-2), rather than the object or the credential behind it.
 *
 * The message probe is a deliberate, documented FALLBACK — there is no
 * code/subcode to test — but it is scoped in a way an unconditional message scan
 * is not. It runs ONLY under the two codes above and ONLY against Graph's own
 * RAW `message`, before the redactor and before the transport prefixes it with a
 * status line. That scoping is what makes the prose safe: it can no longer
 * hijack an auth (190), throttle (4/17/32/613), permission (200/10) or
 * duplicate (506) failure merely because the word "cursor" turns up somewhere in
 * the surfaced text, and under codes 1/100 Graph has no reason to name a cursor
 * unless the cursor is what it refused.
 *
 * Known limit, accepted: Graph replies in English unless a `locale` is passed and
 * this server never passes one, so a localized deployment degrades to the matrix
 * classification (validation / not_found / transient) instead of a wrong one.
 * Losing the restart hint is a degradation; swallowing a token failure as an
 * empty page would be a bug.
 */
export function isCursorRejection(envelope: GraphErrorEnvelope): boolean {
  if (!CURSOR_REJECTION_CODES.has(envelope.code)) return false;
  return (envelope.message ?? '').toLowerCase().includes('cursor');
}

// ---------------------------------------------------------------------------
// appsecret_proof rejection — classified AHEAD of the matrix
// ---------------------------------------------------------------------------

/**
 * True when Graph is refusing the `appsecret_proof` this server attached (or
 * demanding one it did not): "Invalid appsecret_proof provided in the API
 * argument" / "API calls from the server require an appsecret_proof argument".
 *
 * Graph sends both as a bare code 100 with no subcode, so `validation-100`
 * claimed them and told the caller to "fix the arguments" — but the proof is an
 * HMAC of the token under FB_APP_SECRET, no tool argument feeds it, and every
 * call fails identically until the operator fixes the configuration. Like
 * {@link isCursorRejection}, the message probe is scoped to code 100 and to
 * Graph's RAW message, and the literal parameter name is the signal: Graph has
 * no reason to name `appsecret_proof` in a code-100 refusal about anything else.
 */
function isAppSecretProofRejection(envelope: GraphErrorEnvelope): boolean {
  if (envelope.code !== 100) return false;
  return (envelope.message ?? '').toLowerCase().includes('appsecret_proof');
}

/** The action for {@link isAppSecretProofRejection}: a credential-configuration fault. */
function appSecretProofAction(): ErrorAction {
  return makeAction({
    category: 'auth',
    retryable: false,
    operatorText:
      'Graph rejected the appsecret_proof (code 100) — a server credential problem, not a ' +
      'tool-argument error, so changing the arguments or retrying will fail identically. ' +
      'The proof is derived from FB_APP_SECRET: check that FB_APP_SECRET is set and is the ' +
      'secret of the SAME Meta app that issued the access token (a token minted in another ' +
      'app, e.g. Graph API Explorer, or a rotated app secret both cause this), then restart ' +
      'and run `facebook-mcp doctor`.',
  });
}

/**
 * Classify a parsed Graph error envelope into an {@link ErrorAction}. Pure and
 * total: an unrecognized code yields the `unknown` action rather than throwing
 * — or the retryable `transient` one when Graph itself flags the envelope
 * `is_transient: true`.
 */
export function classifyGraphError(envelope: GraphErrorEnvelope): ErrorAction {
  // Probed BEFORE the table: a cursor rejection arrives under codes the matrix
  // already claims, so a lookup-first order would never reach it.
  if (isCursorRejection(envelope)) return cursorExpiredAction();
  // Same reason: an appsecret_proof rejection is a plain code 100.
  if (isAppSecretProofRejection(envelope)) return appSecretProofAction();
  const row = matchErrorRow(envelope.code, envelope.error_subcode);
  if (!row) {
    return envelope.is_transient === true
      ? flaggedTransientAction(envelope.code)
      : unknownAction(envelope.code);
  }
  return makeAction({
    category: row.category,
    retryable: row.retryable,
    operatorText: row.operatorText,
    nextTool: row.nextTool,
    retryAfterMs: computeRetryAfterMs(row, envelope),
  });
}

// ---------------------------------------------------------------------------
// GraphApiError construction
// ---------------------------------------------------------------------------

/**
 * Construct the frozen {@link GraphApiError} for a parsed Graph error envelope,
 * classifying it through the matrix and attaching the resulting action. The
 * caller supplies the real HTTP status (throttles arrive as 400 body codes, so
 * status is NOT derivable from the classification — CC-NET-1).
 *
 * This is the single place the envelope's wire fields are mapped onto the frozen
 * error shape; the HTTP client's `graphErrorFromResponse` builds every live
 * Graph error through it. That client owns two things this module cannot know,
 * so both are overrides rather than a second copy of the mapping:
 *   * `message` — the surfaced text is redacted (C3) and status-prefixed;
 *   * `action` — once the retry loop has exhausted its attempts, a throttle is
 *     no longer retryable no matter what the matrix row says.
 */
export function toGraphApiError(
  envelope: GraphErrorEnvelope,
  httpStatus: number,
  opts: {
    readonly cause?: unknown;
    readonly message?: string;
    readonly action?: ErrorAction;
  } = {},
): GraphApiError {
  const action = opts.action ?? classifyGraphError(envelope);
  const message =
    opts.message ?? envelope.message ?? `Graph API error (code ${envelope.code}).`;
  return new GraphApiError(message, {
    code: envelope.code,
    ...(envelope.error_subcode !== undefined ? { subcode: envelope.error_subcode } : {}),
    ...(envelope.type !== undefined ? { type: envelope.type } : {}),
    ...(envelope.fbtrace_id !== undefined ? { fbtraceId: envelope.fbtrace_id } : {}),
    httpStatus,
    action,
    // Independent of the `message` override above: the transport replaces the
    // message with its redacted, status-prefixed line, and the user-facing text
    // must survive that rather than be folded into (or lost behind) it.
    ...(envelope.error_user_title !== undefined
      ? { userTitle: envelope.error_user_title }
      : {}),
    ...(envelope.error_user_msg !== undefined
      ? { userMessage: envelope.error_user_msg }
      : {}),
    ...(opts.cause !== undefined ? { cause: opts.cause } : {}),
  });
}

// ---------------------------------------------------------------------------
// Classifications NOT keyed by a Graph code
// ---------------------------------------------------------------------------

/** Phase a network fault occurred in; drives the GET/write retry split (CC-NET-5). */
export type NetworkPhase =
  'dns' | 'connect' | 'send' | 'response' | 'timeout' | 'unknown';

const NETWORK_PHASE_REASON: Readonly<Record<NetworkPhase, string>> = {
  dns: 'DNS lookup failed',
  connect: 'connection failed',
  send: 'connection dropped while sending',
  response: 'connection reset before a response',
  timeout: 'request timed out',
  unknown: 'network fault',
};

/**
 * The CC-NET-6 self-diagnosis line. A corporate proxy or TLS-interception
 * middlebox produces exactly the symptoms above — connect failures, resets, and
 * HTML bodies where a Graph envelope belongs — and this server adds no custom CA
 * handling, so the operator has to look at their proxy environment themselves.
 * Named env vars, because "check your proxy" is not actionable on its own.
 */
export const PROXY_ENV_HINT =
  'If you are behind a corporate proxy or TLS interception, check HTTPS_PROXY, ' +
  'HTTP_PROXY, ALL_PROXY and NO_PROXY (and their lowercase forms): facebook-mcp ' +
  'installs no custom CA and honors only the standard Node/undici proxy defaults.';

/**
 * The action for an error response that carries NO Graph `{error:{...}}`
 * envelope: HTML from an edge or a corporate proxy, a JSON body that is not an
 * error envelope, or an empty body on a 5xx (CC-NET-4).
 *
 * It always carries {@link PROXY_ENV_HINT}, and that is the whole point of the
 * function. An HTML interstitial where a Graph envelope belongs is the
 * TLS-interception signature CC-NET-6 was written for, and the absence of an
 * envelope is the only evidence available that the answer came from a middlebox
 * rather than from Facebook — without the hint the operator is left with a
 * truncated snippet of somebody else's error page and no way to name the cause.
 *
 * 5xx keeps the retryable `transient` classification the status earns; anything
 * else is non-retryable `unknown`, because a body we cannot parse gives no
 * ground to decide the request is safe to repeat.
 */
export function nonJsonBodyAction(httpStatus: number): ErrorAction {
  if (httpStatus >= 500 && httpStatus <= 599) {
    return makeAction({
      category: 'transient',
      retryable: true,
      operatorText:
        `HTTP ${httpStatus} with no Graph error envelope (non-JSON body). Safe to retry ` +
        'idempotent reads after a short backoff; the api layer caps any internal wait at ' +
        '60s and applies jitter. ' +
        PROXY_ENV_HINT,
    });
  }
  // A bare 429 is not an unparseable mystery: Graph ships its OWN throttles as
  // HTTP 400 plus a body code (CC-NET-1), so a 429 with no envelope came from an
  // edge, a CDN or an intercepting proxy that answered before Facebook did. The
  // transport already reads it that way (`classifyHttpError`), and folding it in
  // with every other unparseable 4xx made the two disagree — which cost this
  // action its text, its proxy hint and its next step (see actionForResponse).
  if (httpStatus === 429) {
    return makeAction({
      category: 'rate_limit',
      retryable: true,
      nextTool: 'facebook_usage',
      retryAfterMs: DEFAULT_THROTTLE_RETRY_AFTER_MS,
      operatorText:
        'HTTP 429 with no Graph error envelope (non-JSON body). Facebook sends its own ' +
        'throttles as HTTP 400 with a body code, so this one came from an edge, a CDN or ' +
        'an intercepting proxy: back off and retry idempotent reads, and run facebook_usage ' +
        'to check whether Graph itself is throttling you as well. ' +
        PROXY_ENV_HINT,
    });
  }
  return makeAction({
    category: 'unknown',
    retryable: false,
    operatorText:
      `HTTP ${httpStatus} returned no Graph error envelope (non-JSON body). Inspect the ` +
      'status and the surfaced body snippet; do not retry automatically. ' +
      PROXY_ENV_HINT,
  });
}

function networkTransientAction(reason: string, provablyNotSent: boolean): ErrorAction {
  const context = provablyNotSent
    ? 'the request provably never reached Facebook'
    : 'no Graph response was received';
  return makeAction({
    category: 'transient',
    retryable: true,
    operatorText:
      `Network fault (${reason}) — ${context}. Safe to retry idempotent reads after a short ` +
      'backoff; the api layer caps any internal wait at 60s and applies jitter. ' +
      PROXY_ENV_HINT,
  });
}

/**
 * The C2 ambiguous-write action: a publish/send/delete whose request reached the
 * wire but whose response was lost. NEVER retryable — the write may already have
 * landed, so the model must verify first.
 *
 * `verifyTool` is named only when the caller knows which read can show the
 * outcome. Without it the action names NO tool: a guessed default sends the
 * model to a read that cannot see a comment, an ad or a message, and an absent
 * row there reads as "it did not land" — the one conclusion that leads to a
 * duplicate write.
 */
export function ambiguousWriteAction(
  opts: { readonly verifyTool?: string; readonly detail?: string } = {},
): ErrorAction {
  const verify = opts.verifyTool;
  return makeAction({
    category: 'ambiguous',
    retryable: false,
    nextTool: verify,
    operatorText:
      `Write outcome unknown${opts.detail ? ` (${opts.detail})` : ''} — the request reached ` +
      'Facebook but the response was lost, so it may already have succeeded. Do NOT retry ' +
      (verify !== undefined
        ? `blindly; verify via ${verify} first, then decide.`
        : 'blindly; re-read the object you wrote (or the listing it belongs to) first, then decide.'),
  });
}

/**
 * Classify a network-level fault (no Graph envelope) into an {@link ErrorAction},
 * applying the GET-vs-write discipline (CC-NET-1/4/5, C2):
 *   - DNS/connect-phase faults are provably-not-sent ⇒ retryable `transient`
 *     even for writes;
 *   - any later-phase fault on a WRITE is C2 ambiguous ⇒ NOT retryable;
 *   - a later-phase fault on a read is retryable `transient`.
 */
export function classifyNetworkError(input: {
  readonly phase: NetworkPhase;
  readonly isWrite: boolean;
  readonly reason?: string;
}): ErrorAction {
  const reason = input.reason ?? NETWORK_PHASE_REASON[input.phase];
  const provablyNotSent = input.phase === 'dns' || input.phase === 'connect';
  if (provablyNotSent) {
    return networkTransientAction(reason, true);
  }
  if (input.isWrite) {
    return ambiguousWriteAction({ detail: reason });
  }
  return networkTransientAction(reason, false);
}

/**
 * The pagination cursor-expiry action (CC-PAGE-2): the saved `after` cursor is no
 * longer valid. Not retryable with the same cursor — the listing must restart.
 */
export function cursorExpiredAction(
  opts: { readonly nextTool?: string } = {},
): ErrorAction {
  return makeAction({
    category: 'cursor_expired',
    retryable: false,
    nextTool: opts.nextTool,
    operatorText:
      'Pagination cursor expired — the saved cursor is no longer valid. Do not reuse it; ' +
      'restart the listing from the beginning.',
  });
}

/**
 * The text an operator sees when a throwable has no usable message at all.
 * Exported so callers and tests can recognise the fallback rather than
 * re-spelling it.
 */
export const NO_ERROR_MESSAGE = 'unknown error (no message)';

/**
 * The message of any throwable. An `Error` has one; a library that rejects with
 * a plain `{ message }` object still names its reason and must not degrade to
 * `"[object Object]"`; and a value with no usable string form (a null-prototype
 * object makes `String()` throw) must never turn the error path itself into a
 * second failure.
 *
 * Never throws. Reading `.message` is itself guarded: an `Error` (or a proxy)
 * whose `message` getter throws falls through to `String(err)`, and if that
 * throws too the result is {@link NO_ERROR_MESSAGE}. A non-string `message`
 * (`{ message: 42 }`) is not a message; the value is stringified instead.
 */
export function errorMessageOf(err: unknown): string {
  try {
    if (typeof err === 'object' && err !== null) {
      const message: unknown = (err as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
  } catch {
    // A throwing `message` getter: fall through to the string form.
  }
  try {
    return String(err);
  } catch {
    return NO_ERROR_MESSAGE;
  }
}
