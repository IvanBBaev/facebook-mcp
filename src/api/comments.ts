// Comment reading and moderation plumbing for the Graph API (task V07, `api`
// layer — layer 1 of core ← api ← mcp ← tools).
//
// This module owns the HTTP shape of every comment/moderation edge plus the pure
// normalization of Graph's raw bodies into flat, typed records. It deliberately
// knows nothing about zod, tool results or the taint envelope: `taint()` lives in
// the `mcp` layer, so wrapping the untrusted fields returned here
// (`CommentNode.message`, `CommentNode.authorName`) is the job of
// `src/tools/moderation.ts`. Everything in this file treats those fields as
// opaque bytes and never interprets them.
//
// Endpoints (doc 03 "Comments, reactions, moderation"):
//   * GET    /{object-id}/comments   — list (`filter=toplevel|stream`, `order`)
//   * GET    /{object-id}/comments   — `summary=true` for the total count
//   * GET    /{comment-id}           — one comment (+ its nested replies edge)
//   * POST   /{comment-id}/comments  — public reply
//   * POST   /{comment-id}           — `is_hidden=true|false` (reversible)
//   * DELETE /{comment-id}           — permanent
//   * POST   /{page-id}/messages     — private reply (`recipient={comment_id}`)
//   * POST|DELETE /{page-id}/blocked — block / unblock by PSID
//
// A PAGE token is mandatory: with a user token the comments edge returns a
// silently EMPTY list rather than an error (doc 03), which is why
// {@link CommentScope.token} is a required part of the contract and why
// {@link EMPTY_PAGE_TOKEN_HINT} exists.
//
// Pagination is never hand-rolled — listings go through `fetchPage` so the
// token-bearing `paging.next` URL is never followed (C3 / CC-PAGE-4).

import { createHash } from 'node:crypto';

import { GraphApiError } from '../core/index.js';
import type {
  FbRequestFn,
  JsonRequest,
  Page,
  PageRequest,
  ParamValue,
} from '../core/index.js';
import { fetchPage, type EdgeRequest } from './shared.js';

// ---------------------------------------------------------------------------
// 1. Public constants
// ---------------------------------------------------------------------------

/**
 * Fields fetched for one comment node. `from` (author id + display name) needs
 * `pages_read_user_content` for visitor comments; when the scope lacks it Graph
 * simply omits the field, which normalizes to an absent author (CC-MOD-3).
 */
export const COMMENT_FIELDS =
  'id,message,created_time,like_count,comment_count,is_hidden,' +
  'can_reply_privately,permalink_url,from{id,name},parent{id}';

/**
 * Field set for the divergence before/after snapshot. `message` is fetched but
 * only its FINGERPRINT is kept — the divergence diff is surfaced to the model, so
 * putting raw UGC in it would smuggle untainted comment text into the session
 * (CC-MOD-8) while a hash still detects an edit (CC-MOD-6).
 */
const COMMENT_STATE_FIELDS = 'id,message,is_hidden';

/** Hard cap on the ids one bulk moderation call accepts (CC-MOD-5). */
export const MAX_BULK_IDS = 50;

/**
 * Exactly one private reply is possible per comment, and only within 7 days of
 * the comment (doc 03, verified). Both constraints are enforced client-side so
 * the single attempt is not spent on a call that cannot succeed (CC-MOD-2).
 */
export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Note attached to an EMPTY comments listing (CC-AUTH-2). Graph does not error
 * when a user token reads a Page's comments edge — it returns an empty list,
 * which is indistinguishable from "no comments" unless the caller is told.
 *
 * This is an ANNOTATION, not a refusal, deliberately. CC-AUTH-2 (and doc 06's
 * "refused with an actionable error") assumes the token on the wire is whatever
 * `debug_token` classified at startup. That predates the C1 per-page resolver:
 * a base USER token is the normal, fully supported configuration, because the
 * PAGE token is DERIVED from it for every page-scoped call. Refusing a comments
 * read because the CONFIGURED token debugs as USER would therefore refuse the
 * standard working setup, while the credential actually used is a Page token.
 * An empty edge stays genuinely ambiguous at this layer, so it is reported as
 * ambiguous rather than guessed in either direction.
 */
export const EMPTY_PAGE_TOKEN_HINT =
  'No comments were returned. If this object should have comments, the call was ' +
  'most likely made with a USER token: the Graph comments edge requires a PAGE ' +
  'token and answers with an empty list instead of an error. Run ' +
  'facebook_list_pages to confirm a Page token is available for this Page.';

/** Note used when a moderation target turned out to be already gone (CC-MOD-1). */
export const ALREADY_GONE_NOTE =
  'already gone — the comment was deleted before this action landed; treated as done';

/** Note used when an unblock targets a PSID that was not blocked (CC-MOD-7). */
export const NOT_BLOCKED_NOTE =
  'was not blocked — nothing to undo; treated as done (idempotent)';

// ---------------------------------------------------------------------------
// 2. Raw Graph shapes + normalized records
// ---------------------------------------------------------------------------

/** Raw Graph comment node — every field may be absent or malformed (CC-NET-2). */
export interface RawComment {
  readonly id?: string;
  readonly message?: string;
  readonly created_time?: string;
  readonly like_count?: number;
  readonly comment_count?: number;
  readonly is_hidden?: boolean;
  readonly can_reply_privately?: boolean;
  readonly permalink_url?: string;
  readonly from?: { readonly id?: string; readonly name?: string };
  readonly parent?: { readonly id?: string };
  /** The nested replies edge, present only when it was expanded in `fields`. */
  readonly comments?: { readonly data?: readonly RawComment[] };
}

/**
 * A normalized comment. `message` and `authorName` are ATTACKER-CONTROLLED: they
 * must be wrapped in a taint envelope by the `tools` layer before they reach the
 * model (B1 / CC-MOD-8). Nothing in this module interprets them.
 */
export interface CommentNode {
  readonly id: string;
  /** UNTRUSTED comment body. Must be tainted before it is surfaced. */
  readonly message: string;
  readonly createdTime?: string;
  readonly authorId?: string;
  /** UNTRUSTED author display name. Must be tainted before it is surfaced. */
  readonly authorName?: string;
  readonly likeCount?: number;
  readonly replyCount?: number;
  readonly hidden?: boolean;
  /** Graph's own read on private-reply eligibility, when it reports one. */
  readonly canReplyPrivately?: boolean;
  readonly permalink?: string;
  readonly parentId?: string;
  /**
   * Replies exactly as the API returned them. No client-side recursion is done:
   * Graph flattens deep reply chains and this module does not pretend otherwise
   * (CC-MOD-4).
   */
  readonly replies?: readonly CommentNode[];
}

/** `summary=true` projection of a comments edge. */
export interface CommentSummary {
  readonly totalCount?: number;
  readonly canComment?: boolean;
}

/** Which slice of a comments edge to read (doc 03). */
export type CommentFilter = 'toplevel' | 'stream';

/** Ordering accepted by the comments edge (doc 03). */
export type CommentOrder = 'chronological' | 'reverse_chronological';

/**
 * Recursively normalize a raw comment. Total: a body missing every field yields a
 * node with an empty id and an empty message rather than throwing.
 */
export function normalizeComment(raw: RawComment): CommentNode {
  const replies = raw.comments?.data;
  return {
    id: raw.id ?? '',
    message: raw.message ?? '',
    ...(raw.created_time !== undefined ? { createdTime: raw.created_time } : {}),
    ...(raw.from?.id !== undefined ? { authorId: raw.from.id } : {}),
    ...(raw.from?.name !== undefined ? { authorName: raw.from.name } : {}),
    ...(raw.like_count !== undefined ? { likeCount: raw.like_count } : {}),
    ...(raw.comment_count !== undefined ? { replyCount: raw.comment_count } : {}),
    ...(raw.is_hidden !== undefined ? { hidden: raw.is_hidden } : {}),
    ...(raw.can_reply_privately !== undefined
      ? { canReplyPrivately: raw.can_reply_privately }
      : {}),
    ...(raw.permalink_url !== undefined ? { permalink: raw.permalink_url } : {}),
    ...(raw.parent?.id !== undefined ? { parentId: raw.parent.id } : {}),
    ...(Array.isArray(replies) ? { replies: replies.map(normalizeComment) } : {}),
  };
}

// ---------------------------------------------------------------------------
// 3. Request scope
// ---------------------------------------------------------------------------

/**
 * The Page credential + cancellation scope every moderation call rides on. The
 * token is REQUIRED rather than inferred because the silent-empty user-token trap
 * (doc 03) makes an accidentally unscoped call look like a successful empty read.
 */
export interface CommentScope {
  /** The resolved PAGE token (C1: per-Page tokens, never a global one). */
  readonly token: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

type ScopeFields = Pick<JsonRequest, 'token' | 'timeoutMs' | 'signal'>;

function scopeFields(scope: CommentScope): ScopeFields {
  return {
    token: scope.token,
    ...(scope.timeoutMs !== undefined ? { timeoutMs: scope.timeoutMs } : {}),
    ...(scope.signal !== undefined ? { signal: scope.signal } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Re-key a `Page<A>` onto `Page<B>` without inventing or dropping metadata. */
function mapPage<A, B>(page: Page<A>, fn: (item: A) => B): Page<B> {
  return {
    data: page.data.map(fn),
    truncated: page.truncated,
    ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    ...(page.note !== undefined ? { note: page.note } : {}),
  };
}

// ---------------------------------------------------------------------------
// 4. Reads
// ---------------------------------------------------------------------------

/** Inputs for {@link listComments}. */
export interface ListCommentsInput extends CommentScope {
  /** Post / photo / video / comment ID whose comments edge is read. */
  readonly objectId: string;
  /** `toplevel` (default at the API) hides replies; `stream` flattens them in. */
  readonly filter?: CommentFilter;
  readonly order?: CommentOrder;
}

/**
 * Read ONE page of a comments edge. Cursors are opaque and forward-only; the
 * returned `nextCursor` resumes the next page (CC-PAGE-2/-4).
 *
 * An empty page carries {@link EMPTY_PAGE_TOKEN_HINT} (CC-AUTH-2) so EVERY
 * caller of this edge gets the silent-empty warning, not just the one tool that
 * remembered to add it. An existing note wins: when the pagination helper
 * already explains the empty page (an expired cursor) blaming the token would
 * be wrong.
 */
export async function listComments(
  fbRequest: FbRequestFn,
  input: ListCommentsInput,
  page: PageRequest = {},
): Promise<Page<CommentNode>> {
  const params: Record<string, ParamValue> = { fields: COMMENT_FIELDS };
  if (input.filter !== undefined) params.filter = input.filter;
  if (input.order !== undefined) params.order = input.order;

  const edge: EdgeRequest = {
    host: 'graph',
    path: `/${input.objectId}/comments`,
    params,
    ...scopeFields(input),
  };
  const raw = await fetchPage<RawComment>(fbRequest, edge, page);
  const mapped = mapPage(raw, normalizeComment);
  if (mapped.data.length > 0 || mapped.note !== undefined) return mapped;
  return { ...mapped, note: EMPTY_PAGE_TOKEN_HINT };
}

/**
 * Read the `summary=true` projection of a comments edge (total count + whether
 * commenting is open). Issued as its own `limit=0` request because the paging
 * helper intentionally exposes only `data`/`paging`.
 */
export async function fetchCommentSummary(
  fbRequest: FbRequestFn,
  input: { readonly objectId: string; readonly filter?: CommentFilter } & CommentScope,
): Promise<CommentSummary> {
  const params: Record<string, ParamValue> = { summary: 'true', limit: 0 };
  if (input.filter !== undefined) params.filter = input.filter;

  const res = await fbRequest<{ summary?: unknown }>({
    protocol: 'json',
    method: 'GET',
    host: 'graph',
    path: `/${input.objectId}/comments`,
    params,
    ...scopeFields(input),
  });
  const summary: unknown = res.data.summary;
  if (!isRecord(summary)) return {};
  return {
    ...(typeof summary.total_count === 'number'
      ? { totalCount: summary.total_count }
      : {}),
    ...(typeof summary.can_comment === 'boolean'
      ? { canComment: summary.can_comment }
      : {}),
  };
}

/** Inputs for {@link getComment}. */
export interface GetCommentInput extends CommentScope {
  readonly commentId: string;
  /** Replies to expand inline; `0`/omitted ⇒ the replies edge is not requested. */
  readonly replyLimit?: number;
}

/**
 * Read a single comment by ID (G-TOOL-1), optionally expanding its replies edge.
 * Also the re-fetch behind a moderation preview that must show the CURRENT text
 * (CC-MOD-6).
 */
export async function getComment(
  fbRequest: FbRequestFn,
  input: GetCommentInput,
): Promise<CommentNode> {
  const replyLimit = input.replyLimit ?? 0;
  const fields =
    replyLimit > 0
      ? `${COMMENT_FIELDS},comments.limit(${String(replyLimit)}){${COMMENT_FIELDS}}`
      : COMMENT_FIELDS;

  const res = await fbRequest<RawComment>({
    protocol: 'json',
    method: 'GET',
    host: 'graph',
    path: `/${input.commentId}`,
    params: { fields },
    ...scopeFields(input),
  });
  return normalizeComment(res.data);
}

// ---------------------------------------------------------------------------
// 5. Divergence snapshots (C4 before-state, CC-MOD-6)
// ---------------------------------------------------------------------------

/**
 * The state of one moderation target at a point in time. Deliberately free of
 * UGC: only a fingerprint of the body is kept, so this may safely appear in a
 * divergence diff shown to the model (CC-MOD-8).
 */
export interface CommentState {
  readonly id: string;
  /** `true` when the comment no longer exists / is not visible (CC-MOD-1). */
  readonly gone: boolean;
  readonly hidden?: boolean;
  /** Short digest of the comment body — detects an edit without leaking it. */
  readonly fingerprint?: string;
}

/** Short, stable digest of a comment body (edit detection only, not a secret). */
export function messageFingerprint(message: string): string {
  return createHash('sha256').update(message, 'utf8').digest('hex').slice(0, 16);
}

/**
 * True when a Graph failure means "the object is not there". Graph reports a
 * deleted comment as code 100 (subcode 33 when it bothers), so the matrix
 * category is preferred and the code/subcode pair plus Graph's stock wording are
 * the fallbacks (CC-MOD-1).
 */
export function isObjectGoneError(err: unknown): err is GraphApiError {
  if (!(err instanceof GraphApiError)) return false;
  if (err.action?.category === 'not_found') return true;
  if (err.code !== 100) return false;
  if (err.subcode === 33) return true;
  return /does not exist|has been deleted|cannot be loaded|unsupported get request/i.test(
    err.message,
  );
}

/**
 * Snapshot every target comment, keyed by ID so a divergence diff names the
 * comment that moved. A missing comment is recorded as `gone` instead of failing
 * the snapshot — one deleted id must not block a 50-comment sweep (CC-MOD-1/-5).
 */
export async function readCommentStates(
  fbRequest: FbRequestFn,
  input: { readonly commentIds: readonly string[] } & CommentScope,
): Promise<Record<string, CommentState>> {
  const states: Record<string, CommentState> = {};
  for (const id of input.commentIds) {
    try {
      const res = await fbRequest<RawComment>({
        protocol: 'json',
        method: 'GET',
        host: 'graph',
        path: `/${id}`,
        params: { fields: COMMENT_STATE_FIELDS },
        ...scopeFields(input),
      });
      states[id] = {
        id,
        gone: false,
        ...(res.data.is_hidden !== undefined ? { hidden: res.data.is_hidden } : {}),
        fingerprint: messageFingerprint(res.data.message ?? ''),
      };
    } catch (err) {
      if (!isObjectGoneError(err)) throw err;
      states[id] = { id, gone: true };
    }
  }
  return states;
}

// ---------------------------------------------------------------------------
// 6. Per-id bulk execution (CC-MOD-5 — never all-or-nothing)
// ---------------------------------------------------------------------------

/** The outcome of one id inside a bulk moderation call. */
export interface BulkOutcome {
  readonly id: string;
  readonly ok: boolean;
  /** Why a success was a no-op ("already gone", "was not blocked"). */
  readonly note?: string;
  /** Failure reason for this id only; the other ids still ran. */
  readonly error?: string;
}

/** What a bulk step reports for one id; a thrown error is caught by the runner. */
export interface BulkStep {
  readonly ok: boolean;
  readonly note?: string;
  readonly error?: string;
}

/** Counts derived from a bulk result, for a one-line summary. */
export interface BulkTally {
  readonly total: number;
  readonly ok: number;
  readonly failed: number;
}

/**
 * Run `step` once per id, SEQUENTIALLY, collecting a per-id outcome. A thrown
 * error is captured against its own id and the walk continues: one bad id never
 * fails the batch (CC-MOD-5). Sequential on purpose — a 50-way parallel burst is
 * exactly how a moderation sweep earns a rate-limit block.
 */
export async function runBulk(
  ids: readonly string[],
  step: (id: string) => Promise<BulkStep>,
): Promise<readonly BulkOutcome[]> {
  const outcomes: BulkOutcome[] = [];
  for (const id of ids) {
    try {
      const result = await step(id);
      outcomes.push({
        id,
        ok: result.ok,
        ...(result.note !== undefined ? { note: result.note } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
      });
    } catch (err) {
      outcomes.push({
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return outcomes;
}

/** Tally a bulk result. */
export function tallyBulk(outcomes: readonly BulkOutcome[]): BulkTally {
  const ok = outcomes.filter((o) => o.ok).length;
  return { total: outcomes.length, ok, failed: outcomes.length - ok };
}

// ---------------------------------------------------------------------------
// 7. Comment writes
// ---------------------------------------------------------------------------

/**
 * Post a PUBLIC reply under a comment. Additive, so there is no before-state;
 * a comment deleted in the meantime is a hard error — there is nothing to reply
 * to (CC-MOD-1).
 */
export async function replyToComment(
  fbRequest: FbRequestFn,
  input: { readonly commentId: string; readonly message: string } & CommentScope,
): Promise<{ readonly id: string }> {
  const res = await fbRequest<{ id?: unknown }>({
    protocol: 'json',
    method: 'POST',
    host: 'graph',
    path: `/${input.commentId}/comments`,
    body: { message: input.message },
    ...scopeFields(input),
  });
  return { id: typeof res.data.id === 'string' ? res.data.id : '' };
}

/**
 * Hide or unhide a comment (`is_hidden`). Reversible by design: a hidden comment
 * stays visible to its author and their friends, which is why this is the default
 * moderation verb rather than delete (doc 03).
 */
export async function setCommentHidden(
  fbRequest: FbRequestFn,
  input: { readonly commentId: string; readonly hidden: boolean } & CommentScope,
): Promise<boolean> {
  const res = await fbRequest<{ success?: unknown }>({
    protocol: 'json',
    method: 'POST',
    host: 'graph',
    path: `/${input.commentId}`,
    body: { is_hidden: input.hidden },
    ...scopeFields(input),
  });
  return res.data.success !== false;
}

/**
 * Delete a comment permanently. Deleting the Page's OWN comment needs
 * `pages_manage_engagement`; deleting a comment left BY a user needs
 * `pages_read_user_content` (doc 04 — the CC-AUTH-4 permission split).
 */
export async function deleteComment(
  fbRequest: FbRequestFn,
  input: { readonly commentId: string } & CommentScope,
): Promise<boolean> {
  const res = await fbRequest<{ success?: unknown }>({
    protocol: 'json',
    method: 'DELETE',
    host: 'graph',
    path: `/${input.commentId}`,
    ...scopeFields(input),
  });
  return res.data.success !== false;
}

/**
 * Hide/unhide or delete one comment, mapping "already gone" to
 * success-with-note. Shared by both bulk verbs so their gone-already semantics
 * cannot drift (CC-MOD-1).
 */
export async function moderateCommentStep(
  fbRequest: FbRequestFn,
  input: { readonly commentId: string; readonly hidden?: boolean } & CommentScope,
): Promise<BulkStep> {
  try {
    const ok =
      input.hidden === undefined
        ? await deleteComment(fbRequest, input)
        : await setCommentHidden(fbRequest, { ...input, hidden: input.hidden });
    return ok ? { ok: true } : { ok: false, error: 'Facebook reported success:false' };
  } catch (err) {
    if (isObjectGoneError(err)) return { ok: true, note: ALREADY_GONE_NOTE };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 8. Private reply — one shot, 7-day window (CC-MOD-2)
// ---------------------------------------------------------------------------

/** Whether the 7-day private-reply window is still open for a comment. */
export type PrivateReplyWindow =
  | { readonly open: true; readonly ageMs: number; readonly closesAtMs: number }
  | {
      readonly open: false;
      readonly reason: 'expired' | 'unknown_age';
      readonly ageMs?: number;
      readonly closesAtMs?: number;
    };

/**
 * Evaluate the 7-day window from the comment's `created_time` against the
 * injected clock. An absent or unparseable timestamp fails CLOSED: refusing is
 * recoverable, gambling the single irreversible attempt is not.
 */
export function privateReplyWindow(
  createdTime: string | undefined,
  nowMs: number,
): PrivateReplyWindow {
  const createdMs = createdTime !== undefined ? Date.parse(createdTime) : Number.NaN;
  if (Number.isNaN(createdMs)) return { open: false, reason: 'unknown_age' };
  const ageMs = nowMs - createdMs;
  const closesAtMs = createdMs + PRIVATE_REPLY_WINDOW_MS;
  return ageMs <= PRIVATE_REPLY_WINDOW_MS
    ? { open: true, ageMs, closesAtMs }
    : { open: false, reason: 'expired', ageMs, closesAtMs };
}

/** Why a private reply is impossible. Both are terminal — never retry (CC-MOD-2). */
export type PrivateReplyRefusal = 'exhausted' | 'window_closed' | 'unknown_age';

/**
 * Classify a Graph private-reply failure. Meta does not document a stable subcode
 * for the two constraints, so the wording is matched as well as the code family;
 * anything unrecognized stays `undefined` and propagates untouched rather than
 * being mislabeled.
 */
export function classifyPrivateReplyFailure(
  err: unknown,
): PrivateReplyRefusal | undefined {
  if (!(err instanceof GraphApiError)) return undefined;
  const message = err.message.toLowerCase();
  if (
    /already (been )?(sent|replied|used)|only one|one private (reply|message)|single private/.test(
      message,
    )
  ) {
    return 'exhausted';
  }
  if (
    /outside of allowed window|outside the allowed window|window (has )?(closed|expired)|no longer (allowed|possible)|too old/.test(
      message,
    )
  ) {
    return 'window_closed';
  }
  return undefined;
}

const REFUSAL_TEXT: Readonly<Record<PrivateReplyRefusal, string>> = {
  exhausted:
    'the single private reply allowed for this comment has already been used. ' +
    'Facebook permits exactly ONE private reply per comment and there is no way to ' +
    'send a second one, so this can never succeed — do NOT retry. Reply publicly ' +
    'with facebook_reply_to_comment instead, or continue the existing thread with ' +
    'the messages package.',
  window_closed:
    'the 7-day private-reply window for this comment has closed. A private reply ' +
    'is only possible within 7 days of the comment, so this can never succeed — do ' +
    'NOT retry. Reply publicly with facebook_reply_to_comment, or wait for the user ' +
    'to message the Page and answer inside the 24-hour messaging window.',
  unknown_age:
    "the comment's creation time could not be read, so the 7-day private-reply " +
    'window cannot be verified. The single private reply is not spent on a guess. ' +
    'Re-read the comment with facebook_get_comment and retry only once its ' +
    'created time is known.',
};

/**
 * Build the terminal, non-retryable refusal for a private reply. Carries the
 * originating Graph code/status when there is one (a mapped API error) and code
 * `0` when the refusal is purely client-side (the pre-flight window check).
 */
export function privateReplyRefusalError(
  refusal: PrivateReplyRefusal,
  commentId: string,
  cause?: unknown,
): GraphApiError {
  const graph = cause instanceof GraphApiError ? cause : undefined;
  const text = `Private reply to comment ${commentId} refused: ${REFUSAL_TEXT[refusal]}`;
  return new GraphApiError(text, {
    code: graph?.code ?? 0,
    ...(graph?.subcode !== undefined ? { subcode: graph.subcode } : {}),
    httpStatus: graph?.httpStatus ?? 400,
    action: {
      category: 'validation',
      retryable: false,
      nextTool: 'facebook_reply_to_comment',
      operatorText: text,
    },
    ...(cause !== undefined ? { cause } : {}),
  });
}

/** Receipt of a delivered private reply (ids only — no message content echoed). */
export interface PrivateReplyReceipt {
  readonly messageId?: string;
  readonly recipientId?: string;
}

/**
 * Send the one allowed private reply to a comment
 * (`POST /{page-id}/messages` with `recipient={"comment_id":…}`). Externally
 * visible with no unsend, so a lost response must NOT be retried blindly — the
 * client's ambiguous-write classification covers that; the two hard constraints
 * are mapped here to terminal, self-explaining refusals (CC-MOD-2).
 */
export async function sendPrivateReply(
  fbRequest: FbRequestFn,
  input: {
    readonly pageId: string;
    readonly commentId: string;
    readonly message: string;
  } & CommentScope,
): Promise<PrivateReplyReceipt> {
  try {
    const res = await fbRequest<{ message_id?: unknown; recipient_id?: unknown }>({
      protocol: 'json',
      method: 'POST',
      host: 'graph',
      path: `/${input.pageId}/messages`,
      body: {
        recipient: { comment_id: input.commentId },
        message: { text: input.message },
      },
      ...scopeFields(input),
    });
    return {
      ...(typeof res.data.message_id === 'string'
        ? { messageId: res.data.message_id }
        : {}),
      ...(typeof res.data.recipient_id === 'string'
        ? { recipientId: res.data.recipient_id }
        : {}),
    };
  } catch (err) {
    const refusal = classifyPrivateReplyFailure(err);
    if (refusal !== undefined) {
      throw privateReplyRefusalError(refusal, input.commentId, err);
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

// ---------------------------------------------------------------------------
// 9. Blocked users (CC-MOD-7)
// ---------------------------------------------------------------------------

function embeddedErrorMessage(entry: Record<string, unknown>): string | undefined {
  const error: unknown = entry.error;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  if (typeof entry.message === 'string') return entry.message;
  return undefined;
}

/**
 * Interpret one entry of the `/blocked` response map. Graph answers `true` per
 * PSID on success and an embedded `{success:false, error}` per PSID on failure —
 * i.e. the edge is natively per-id, so a bad PSID never fails the batch
 * (CC-MOD-5). An unblock of a PSID that was never blocked is normalized to
 * success-with-note so block/unblock stay symmetric (CC-MOD-7).
 */
function blockedOutcome(id: string, entry: unknown, blocking: boolean): BulkOutcome {
  if (entry === true) return { id, ok: true };
  if (isRecord(entry)) {
    if (entry.success === true) return { id, ok: true };
    const message = embeddedErrorMessage(entry);
    if (
      !blocking &&
      message !== undefined &&
      /not blocked|does not exist|no such|cannot be loaded/i.test(message)
    ) {
      return { id, ok: true, note: NOT_BLOCKED_NOTE };
    }
    return {
      id,
      ok: false,
      error: message ?? 'Facebook reported a failure for this PSID',
    };
  }
  if (entry === undefined) {
    return { id, ok: false, error: 'Facebook returned no result for this PSID' };
  }
  return {
    id,
    ok: false,
    error: `Facebook returned an unexpected result: ${JSON.stringify(entry) ?? typeof entry}`,
  };
}

/**
 * Block or unblock PSIDs on a Page's `/blocked` list in ONE call, returning a
 * per-PSID outcome in the caller's order. Blocking an already-blocked user is a
 * Graph-side no-op, which is what makes both verbs idempotent (CC-MOD-7).
 * `psids` rides the POST body and the DELETE query, matching the client's
 * "query for GET/DELETE, body for POST" rule.
 */
export async function setBlocked(
  fbRequest: FbRequestFn,
  input: {
    readonly pageId: string;
    readonly psids: readonly string[];
    readonly blocked: boolean;
  } & CommentScope,
): Promise<readonly BulkOutcome[]> {
  const psids = [...input.psids];
  const payload = { psids };
  const res = await fbRequest<Record<string, unknown>>({
    protocol: 'json',
    method: input.blocked ? 'POST' : 'DELETE',
    host: 'graph',
    path: `/${input.pageId}/blocked`,
    ...(input.blocked ? { body: payload } : { params: { psids: JSON.stringify(psids) } }),
    ...scopeFields(input),
  });
  const map: Record<string, unknown> = isRecord(res.data) ? res.data : {};
  return psids.map((id) => blockedOutcome(id, map[id], input.blocked));
}
