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
import { ERROR_MATRIX, ETA_MINUTES_TO_MS, type ErrorMatrixRow } from './error-matrix.js';

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
}

/** Longest error-body snippet embedded in a non-JSON `GraphApiError` message (CC-NET-4). */
export const NON_JSON_BODY_MAX = 200;

/** Verify-tool the ambiguous-write guidance points at by default (C2). */
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
 * Classify a parsed Graph error envelope into an {@link ErrorAction}. Pure and
 * total: an unrecognized code yields the `unknown` action rather than throwing.
 */
export function classifyGraphError(envelope: GraphErrorEnvelope): ErrorAction {
  const row = matchErrorRow(envelope.code, envelope.error_subcode);
  if (!row) return unknownAction(envelope.code);
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
 */
export function toGraphApiError(
  envelope: GraphErrorEnvelope,
  httpStatus: number,
  opts: { readonly cause?: unknown } = {},
): GraphApiError {
  const action = classifyGraphError(envelope);
  const message = envelope.message ?? `Graph API error (code ${envelope.code}).`;
  return new GraphApiError(message, {
    code: envelope.code,
    ...(envelope.error_subcode !== undefined ? { subcode: envelope.error_subcode } : {}),
    ...(envelope.type !== undefined ? { type: envelope.type } : {}),
    ...(envelope.fbtrace_id !== undefined ? { fbtraceId: envelope.fbtrace_id } : {}),
    httpStatus,
    action,
    ...(opts.cause !== undefined ? { cause: opts.cause } : {}),
  });
}

/**
 * Build a {@link GraphApiError} for a NON-JSON error body — HTML from an edge or
 * proxy, or an empty body on a 5xx (CC-NET-4). Never crashes on a parse failure;
 * embeds up to {@link NON_JSON_BODY_MAX} bytes of the body. NOTE: `body` must
 * already be redacted by the caller (the F05 choke-point) — `core` holds no
 * redactor. 5xx bodies classify as retryable `transient`; other statuses as
 * non-retryable `unknown`.
 */
export function graphErrorFromNonJson(
  httpStatus: number,
  body?: string,
  opts: { readonly cause?: unknown } = {},
): GraphApiError {
  const snippet = body ? body.slice(0, NON_JSON_BODY_MAX) : '';
  const action =
    httpStatus >= 500
      ? networkTransientAction(`HTTP ${httpStatus} with a non-JSON body`, false)
      : makeAction({
          category: 'unknown',
          retryable: false,
          operatorText:
            `HTTP ${httpStatus} returned a non-JSON error body (not a Graph envelope). ` +
            'Inspect the status and the surfaced body snippet; do not retry automatically. ' +
            // An HTML body where a Graph envelope belongs is the classic
            // interception signature (CC-NET-6).
            PROXY_ENV_HINT,
        });
  const message = snippet
    ? `Non-JSON error body (HTTP ${httpStatus}): ${snippet}`
    : `Non-JSON error body (HTTP ${httpStatus}).`;
  return new GraphApiError(message, {
    code: -1,
    httpStatus,
    action,
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
 */
export function ambiguousWriteAction(
  opts: { readonly verifyTool?: string; readonly detail?: string } = {},
): ErrorAction {
  const verify = opts.verifyTool ?? DEFAULT_VERIFY_TOOL;
  return makeAction({
    category: 'ambiguous',
    retryable: false,
    nextTool: verify,
    operatorText:
      `Write outcome unknown${opts.detail ? ` (${opts.detail})` : ''} — the request reached ` +
      'Facebook but the response was lost, so it may already have succeeded. Do NOT retry ' +
      `blindly; verify via ${verify} / facebook_get_conversation first, then decide.`,
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
