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
//   * POST   /{page-id}/blocked     — block a `psid` LIST (answers a per-id map)
//   * DELETE /{page-id}/blocked     — unblock ONE `psid` (answers `{success}`)
//
// A PAGE token is mandatory: with a user token the comments edge returns a
// silently EMPTY list rather than an error (doc 03), which is why
// {@link CommentScope.token} is a required part of the contract and why
// {@link EMPTY_PAGE_TOKEN_HINT} exists.
//
// Pagination is never hand-rolled — listings go through `fetchPage` so the
// token-bearing `paging.next` URL is never followed (C3 / CC-PAGE-4).

import { createHash } from 'node:crypto';

import { errorMessageOf, GraphApiError } from '../core/index.js';
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

/**
 * Note for an empty page reached WITH a forward cursor. That cursor was minted
 * by a successful read of this same edge with this same token, so the USER-token
 * diagnosis in {@link EMPTY_PAGE_TOKEN_HINT} is provably wrong here — the only
 * thing an empty continuation proves is that the walk ran past the last comment.
 */
export const EMPTY_CONTINUATION_NOTE =
  'No further comments. This page was fetched with a forward cursor, so the ' +
  'listing has run past its last comment — this says nothing about the token ' +
  'or about how many comments the object has.';

/**
 * Note for an empty page that itself hands back a FORWARD CURSOR. Graph pages a
 * filtered edge by scanning a fixed window of rows, so an empty `data` next to a
 * `paging.next` means "this slice held nothing, keep walking" (CC-PAGE-1) — not
 * "there is nothing here". The cursor also settles the token question the same
 * way {@link EMPTY_CONTINUATION_NOTE} does: a token that cannot see this edge is
 * answered with an empty list and NO paging, so a minted cursor proves the edge
 * answered. Blaming the token here would send the operator to re-mint a
 * credential when the next page is one call away.
 */
export const EMPTY_PAGE_MORE_FOLLOWS_NOTE =
  'No comments on this page, but Facebook returned a forward cursor — the edge ' +
  'answered and more pages follow. Resume with the returned cursor before ' +
  'concluding anything about the token or about how many comments this object ' +
  'has.';

/**
 * Note used when a moderation target turned out to be already gone (CC-MOD-1).
 * Worded as what the evidence shows, not as a deletion: Graph answers the write
 * AND the confirming read with the same 100/33 text for a deleted comment and
 * for one this Page's token cannot see at all (a comment on another Page's
 * content, or an id from a different profile), so neither call proves which.
 */
export const ALREADY_GONE_NOTE =
  "already gone — Facebook reports this comment does not exist or is not visible to this Page's " +
  'token, both to the action and to a confirming read; treated as done. That is also ' +
  "Facebook's answer for a comment on another Page's content, so if this id came from a " +
  'different Page, run the call again with that Page as the profile.';

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
  readonly comments?: {
    readonly data?: readonly RawComment[];
    readonly paging?: unknown;
  };
}

/**
 * A normalized comment. `message` and `authorName` are ATTACKER-CONTROLLED: they
 * must be wrapped in a taint envelope by the `tools` layer before they reach the
 * model (B1 / CC-MOD-8). Nothing in this module interprets them.
 */
export interface CommentNode {
  readonly id: string;
  /**
   * UNTRUSTED comment body. Must be tainted before it is surfaced. ABSENT when
   * Graph did not send one (a field-less node, a body that is not an object):
   * an empty string is a real value Facebook can return, so an absent field
   * is never materialised as one.
   */
  readonly message?: string;
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
  /**
   * `true` when the expanded replies edge advertised a further page
   * (`paging.next`): `replies` is then Graph's FIRST page of the thread, not all
   * of it. The paging block itself is never kept (it carries a token-bearing
   * URL, C3), so this flag is the only trace of the cut. Absent otherwise.
   */
  readonly repliesHasMore?: true;
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
 * A Graph node id off the wire (CC-NET-2). Strings only, and never coerced: a
 * comment id here is what a later hide, delete or reply is addressed to. A
 * number cannot be rescued — Graph ids run past the safe-integer range, so a
 * numeric id has already lost digits by the time `JSON.parse` is finished with
 * it, and `String(n)` would mint a plausible-looking id that moderates a comment
 * that does not exist. Reporting no id is the only honest answer, and the empty
 * id this yields already fails closed everywhere downstream.
 */
function graphId(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * Recursively normalize a raw comment. Total: a body missing every field yields a
 * node with an empty id and NO message rather than throwing — `message` is
 * carried only when the wire carried it.
 *
 * `fbRequest<T>` CASTS the parsed body, so `RawComment` is a hope about the wire
 * rather than a fact about it. `raw` is genuinely `unknown` here: a bodiless 2xx
 * parses to `undefined`, and a row inside `comments.data` may be `null` or a
 * scalar. Reaching for `.comments` on any of those is a `TypeError` that costs
 * the caller a read it already paid a metered Graph call for (CC-NET-2).
 */
export function normalizeComment(raw: RawComment): CommentNode {
  const node: RawComment = isRecord(raw) ? raw : {};
  const replies = node.comments?.data;
  const repliesHasMore = Array.isArray(replies) && advertisesNext(node.comments?.paging);
  const authorId = graphId(node.from?.id);
  const parentId = graphId(node.parent?.id);
  return {
    id: graphId(node.id) ?? '',
    ...(node.message !== undefined ? { message: node.message } : {}),
    ...(node.created_time !== undefined ? { createdTime: node.created_time } : {}),
    ...(authorId !== undefined ? { authorId } : {}),
    ...(node.from?.name !== undefined ? { authorName: node.from.name } : {}),
    ...(node.like_count !== undefined ? { likeCount: node.like_count } : {}),
    ...(node.comment_count !== undefined ? { replyCount: node.comment_count } : {}),
    ...(node.is_hidden !== undefined ? { hidden: node.is_hidden } : {}),
    ...(node.can_reply_privately !== undefined
      ? { canReplyPrivately: node.can_reply_privately }
      : {}),
    ...(node.permalink_url !== undefined ? { permalink: node.permalink_url } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
    ...(Array.isArray(replies) ? { replies: replies.map(normalizeComment) } : {}),
    ...(repliesHasMore ? { repliesHasMore: true as const } : {}),
  };
}

/** Whether a Graph `paging` object advertises a further page (`paging.next`). */
function advertisesNext(paging: unknown): boolean {
  return isRecord(paging) && typeof paging.next === 'string' && paging.next.length > 0;
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
 * An empty FIRST page carries {@link EMPTY_PAGE_TOKEN_HINT} (CC-AUTH-2) so every
 * caller of this edge gets the silent-empty warning, not just the one tool that
 * remembered to add it. An existing note wins: when the pagination helper
 * already explains the empty page (an expired cursor) blaming the token would
 * be wrong. So does a forward cursor, whether the page was REACHED with one
 * ({@link EMPTY_CONTINUATION_NOTE}) or RETURNED one
 * ({@link EMPTY_PAGE_MORE_FOLLOWS_NOTE}).
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
  // A returned cursor is checked BEFORE the cursor the page was reached with:
  // an empty slice in the middle of a filtered walk still hands back
  // `paging.next`, and "no further comments" next to a live cursor would stop
  // the walk while rows remain (CC-PAGE-1).
  if (mapped.nextCursor !== undefined) {
    return { ...mapped, note: EMPTY_PAGE_MORE_FOLLOWS_NOTE };
  }
  if (page.after !== undefined) return { ...mapped, note: EMPTY_CONTINUATION_NOTE };
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

  const res = await fbRequest<unknown>({
    protocol: 'json',
    method: 'GET',
    host: 'graph',
    path: `/${input.objectId}/comments`,
    params,
    ...scopeFields(input),
  });
  // The summary is an OPT-IN add-on to a page of comments the caller has already
  // fetched, so it degrades to "no counts" rather than to a failed read: reaching
  // for `.summary` on a bodiless 2xx (parsed as `undefined`) throws a TypeError
  // that escapes past the caller and throws away the comments it had in hand.
  const summary: unknown = isRecord(res.data) ? res.data.summary : undefined;
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
  /**
   * Set when Facebook refused THIS id's read for a reason other than "gone" (a
   * permission, a rate limit). Its state is unknown, so a moderation apply must
   * not act on it: see {@link isUnreadableState}.
   */
  readonly unreadable?: true;
  /** Why the read was refused; present only with `unreadable`. */
  readonly error?: string;
}

/** True for a snapshot whose read was refused — its state was never observed. */
export function isUnreadableState(state: CommentState | undefined): boolean {
  return state?.unreadable === true;
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
 *
 * The same holds for an id whose read Facebook REFUSES (a visitor comment the
 * token may not read, a rate limit that starts mid-sweep): it is recorded as
 * `unreadable` with the refusal, and the other ids keep their snapshot. Such an
 * id's state was never observed, so the caller must not act on it. Only when no
 * id could be read at all is the first refusal thrown — a snapshot made solely of
 * unreadable rows previews nothing, and the real error says more. A failure that
 * is not a Graph refusal (a caller abort, a bug) is always rethrown.
 */
export async function readCommentStates(
  fbRequest: FbRequestFn,
  input: { readonly commentIds: readonly string[] } & CommentScope,
): Promise<Record<string, CommentState>> {
  const states: Record<string, CommentState> = {};
  let firstRefusal: GraphApiError | undefined;
  let throttled: GraphApiError | undefined;
  let observed = false;
  for (const id of input.commentIds) {
    // A repeated id is read once: another GET would spend rate limit for
    // nothing, and a second answer that differs (a refusal mid-sweep) would
    // overwrite the state the first read actually observed.
    if (Object.hasOwn(states, id)) continue;
    // A rate limit reaches this layer only after the transport exhausted its own
    // retries, and every later GET rides the same exhausted bucket: reading on
    // would repeat those retries and back-offs once per remaining id and spend
    // more of a budget Facebook already said is gone. The rest are recorded
    // unreadable without a request, which the apply already refuses to act on.
    if (throttled !== undefined) {
      states[id] = {
        id,
        gone: false,
        unreadable: true,
        error: `not read — an earlier read in this snapshot hit a rate limit (${errorMessageOf(throttled)})`,
      };
      continue;
    }
    try {
      const res = await fbRequest<unknown>({
        protocol: 'json',
        method: 'GET',
        host: 'graph',
        path: `/${id}`,
        params: { fields: COMMENT_STATE_FIELDS },
        ...scopeFields(input),
      });
      // Typed `unknown` and read field by field: `RawComment` is a hope about
      // the body, not a guarantee (the client casts, it does not validate), and
      // this snapshot is the before/after state of a DESTRUCTIVE gate. A
      // mistyped field has to drop out rather than be recorded — the string
      // "false" is truthy, so stored as `hidden` it would let the divergence
      // check sign off on a hide that changed nothing, and a numeric `message`
      // throws inside the fingerprint hash and aborts the whole snapshot.
      const node: Record<string, unknown> = isRecord(res.data) ? res.data : {};
      const hidden = typeof node.is_hidden === 'boolean' ? node.is_hidden : undefined;
      const message = typeof node.message === 'string' ? node.message : '';
      states[id] = {
        id,
        gone: false,
        ...(hidden !== undefined ? { hidden } : {}),
        fingerprint: messageFingerprint(message),
      };
      observed = true;
    } catch (err) {
      if (isObjectGoneError(err)) {
        states[id] = { id, gone: true };
        observed = true;
        continue;
      }
      if (!(err instanceof GraphApiError)) throw err;
      firstRefusal ??= err;
      if (err.action?.category === 'rate_limit') throttled = err;
      states[id] = { id, gone: false, unreadable: true, error: errorMessageOf(err) };
    }
  }
  if (!observed && firstRefusal !== undefined) throw firstRefusal;
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
  /**
   * Set when this id's write failed with an AMBIGUOUS outcome (C2): the request
   * reached Facebook and the answer was lost, so `ok: false` records only that
   * nothing was CONFIRMED — never that nothing happened. Absent on every
   * provable result, so its presence is the signal.
   */
  readonly ambiguous?: true;
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
  /** Everything that is not `ok` — provable failures AND ambiguous outcomes. */
  readonly failed: number;
  /**
   * How many of `failed` are ambiguous (C2). Absent when there are none, so a
   * summary that ignores it stays correct for every provable batch. A batch
   * with a non-zero count may NOT be described as "nothing was applied".
   */
  readonly ambiguous?: number;
}

/**
 * Note attached to an id whose write outcome could not be established (C2).
 * Exported so a caller can recognise it without re-deriving the wording.
 */
export const AMBIGUOUS_OUTCOME_NOTE =
  'ambiguous — the request reached Facebook and the answer was lost, so this id ' +
  'may ALREADY be applied. Verify its current state before acting on it again; ' +
  'do not retry blind.';

/**
 * Run `step` once per DISTINCT id, SEQUENTIALLY, collecting a per-id outcome
 * (a repeated id keeps its first position and is acted on once). A thrown
 * error is captured against its own id and the walk continues: one bad id never
 * fails the batch (CC-MOD-5). Sequential on purpose — a 50-way parallel burst is
 * exactly how a moderation sweep earns a rate-limit block.
 *
 * `ok: false` means "not confirmed", which is not the same as "did not happen".
 * An `ambiguous` error (C2 — a 5xx, a lost response body, a network fault on a
 * write) is therefore flagged rather than folded into the plain failures: the
 * write may already have landed, and for `facebook_delete_comment` that
 * difference is permanent. The flag is the only honest way for a per-id summary
 * to stop short of "nothing was applied".
 */
export async function runBulk(
  ids: readonly string[],
  step: (id: string) => Promise<BulkStep>,
): Promise<readonly BulkOutcome[]> {
  const outcomes: BulkOutcome[] = [];
  // A repeated id is ONE comment/PSID: acting on it twice sends a write for
  // nothing and, on a delete, reports the repeat as "already gone" for a comment
  // this very batch removed, while the tally counts it twice. First occurrence
  // wins, so the caller's order is kept.
  for (const id of new Set(ids)) {
    try {
      const result = await step(id);
      outcomes.push({
        id,
        ok: result.ok,
        ...(result.note !== undefined ? { note: result.note } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
      });
    } catch (err) {
      const ambiguous =
        err instanceof GraphApiError && err.action?.category === 'ambiguous';
      outcomes.push({
        id,
        ok: false,
        ...(ambiguous ? { ambiguous: true as const, note: AMBIGUOUS_OUTCOME_NOTE } : {}),
        error: errorMessageOf(err),
      });
    }
  }
  return outcomes;
}

/**
 * Tally a bulk result. `failed` stays "everything that is not `ok`"; `ambiguous`
 * reports how much of that count is unproven (C2) and is omitted when it is
 * zero, so a summary written before the field existed stays correct.
 */
export function tallyBulk(outcomes: readonly BulkOutcome[]): BulkTally {
  const ok = outcomes.filter((o) => o.ok).length;
  const ambiguous = outcomes.filter((o) => o.ambiguous === true).length;
  return {
    total: outcomes.length,
    ok,
    failed: outcomes.length - ok,
    ...(ambiguous > 0 ? { ambiguous } : {}),
  };
}

// ---------------------------------------------------------------------------
// 7. Comment writes
// ---------------------------------------------------------------------------

/**
 * Whether an edit acknowledgement CONFIRMS the write. Everything is `unknown`
 * because the client casts the parsed body to the declared type without
 * validating it: a 2xx can arrive with no body at all (parsed as `undefined`),
 * as a raw non-JSON string, or with a `success` that is not the boolean Graph
 * documents.
 *
 * Absence still confirms — the transport has already turned an error payload
 * into a throw, so a bodiless 2xx on these edges is Facebook saying "done", and
 * reading it as a failure would report a hide that landed as a failed id. What
 * must NOT confirm is a `success` that is present and is anything other than
 * `true`: `false`, `"false"`, `0` and `null` are all Facebook saying no, and the
 * old `!== false` test read three of the four as a completed moderation.
 */
// The read that can SHOW each write's outcome when its answer is lost (C2). The
// transport puts it on the ambiguous error's guidance (`action.nextTool`); left
// unset, that guidance names no tool at all, and before the seam it named the
// post listing, which can never show a comment write. A reply lands on its
// parent's comments edge; a hide reads back as `is_hidden` and a delete as a
// 404 on the comment node; a private reply opens a Page-inbox conversation with
// the commenter. Block/unblock set none on purpose: no tool reads the blocked
// list, so the neutral guidance is the honest one.
const VERIFY_REPLY_TOOL = 'facebook_list_comments';
const VERIFY_COMMENT_TOOL = 'facebook_get_comment';
const VERIFY_PRIVATE_REPLY_TOOL = 'facebook_list_conversations';

/**
 * Whether a moderation write's 2xx body confirms it landed. A bodiless 2xx
 * (`undefined`) and a bare `true` confirm; a record confirms unless its
 * `success` flag is anything but `true`. Every other non-record body — a JSON
 * `false` or `null`, or unparsed text — is Facebook NOT saying yes, and reading
 * it as confirmation reports a comment deleted or hidden (or a user unblocked)
 * while it is not.
 */
function confirmsWrite(body: unknown): boolean {
  if (body === undefined || body === true) return true;
  if (!isRecord(body)) return false;
  const flag: unknown = body.success;
  return flag === undefined || flag === true;
}

/** A Graph id counts only when it is a non-empty string; anything else is absent. */
function ackId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The acknowledgement of a write as it actually arrives — never assumed to be a record. */
function ackOf(body: unknown): Record<string, unknown> {
  return isRecord(body) ? body : {};
}

/**
 * Post a PUBLIC reply under a comment. Additive, so there is no before-state;
 * a comment deleted in the meantime is a hard error — there is nothing to reply
 * to (CC-MOD-1).
 *
 * `id` is ABSENT when Facebook acknowledged the reply without a usable one.
 * That is not a hard failure — the reply may well be public — but it is not
 * a confirmation either: the caller must treat such an ack as unconfirmed
 * (the `tools` layer journals it `attempted`), and there is no handle to pass
 * to a follow-up call.
 */
export async function replyToComment(
  fbRequest: FbRequestFn,
  input: { readonly commentId: string; readonly message: string } & CommentScope,
): Promise<{ readonly id?: string }> {
  const res = await fbRequest<unknown>({
    protocol: 'json',
    method: 'POST',
    host: 'graph',
    path: `/${input.commentId}/comments`,
    body: { message: input.message },
    verifyTool: VERIFY_REPLY_TOOL,
    ...scopeFields(input),
  });
  const id = ackId(ackOf(res.data).id);
  return id !== undefined ? { id } : {};
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
  const res = await fbRequest<unknown>({
    protocol: 'json',
    method: 'POST',
    host: 'graph',
    path: `/${input.commentId}`,
    body: { is_hidden: input.hidden },
    verifyTool: VERIFY_COMMENT_TOOL,
    ...scopeFields(input),
  });
  return confirmsWrite(res.data);
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
  const res = await fbRequest<unknown>({
    protocol: 'json',
    method: 'DELETE',
    host: 'graph',
    path: `/${input.commentId}`,
    verifyTool: VERIFY_COMMENT_TOOL,
    ...scopeFields(input),
  });
  return confirmsWrite(res.data);
}

/**
 * Which verb {@link moderateCommentStep} runs, as an explicit discriminant. It is
 * a discriminant and not an optional `hidden` flag because with the flag the
 * ABSENCE of a field selected the permanent delete: "I forgot to pass a property"
 * and "destroy this comment forever" were the same call, and the compiler had no
 * way to tell them apart. Naming the verb makes the destructive path something a
 * caller has to ask for.
 */
export type ModerateCommentInput = { readonly commentId: string } & CommentScope &
  ({ readonly op: 'hide'; readonly hidden: boolean } | { readonly op: 'delete' });

/**
 * Hide/unhide or delete one comment, mapping "already gone" to
 * success-with-note. Shared by both bulk verbs so their gone-already semantics
 * cannot drift (CC-MOD-1).
 */
export async function moderateCommentStep(
  fbRequest: FbRequestFn,
  input: ModerateCommentInput,
): Promise<BulkStep> {
  // Read the verb once before any narrowing, so the fail-closed branch can still
  // name what it was handed.
  const requested: unknown = (input as { readonly op?: unknown }).op;
  try {
    // Both verbs are matched POSITIVELY and anything else throws. The delete is
    // never the fallthrough of a failed test, so input that lost its `op` on the
    // way here (a JSON boundary, a hand-built object) costs a rejected call
    // rather than a comment nobody can get back.
    let ok: boolean;
    if (input.op === 'hide') ok = await setCommentHidden(fbRequest, input);
    else if (input.op === 'delete') ok = await deleteComment(fbRequest, input);
    else throw new Error(`moderateCommentStep: unsupported op ${String(requested)}`);
    return ok ? { ok: true } : { ok: false, error: 'Facebook reported success:false' };
  } catch (err) {
    if (!isObjectGoneError(err)) throw err;
    // Graph answers a comment this token cannot moderate with the same 100/33
    // "does not exist, cannot be loaded due to missing permissions" text as a
    // deleted one. Calling that "already gone" would tell the operator an
    // abusive comment is down while it is still public, so the verdict is
    // confirmed with a read: only a comment that is ALSO gone to a GET is done.
    if (await commentStillThere(fbRequest, input)) throw err;
    return { ok: true, note: ALREADY_GONE_NOTE };
  }
}

/**
 * Whether a comment a write just called "gone" can still be read. Anything but
 * a gone-looking answer counts as "still there": a probe that cannot confirm
 * the deletion must not turn a failed write into a success.
 */
async function commentStillThere(
  fbRequest: FbRequestFn,
  input: { readonly commentId: string } & CommentScope,
): Promise<boolean> {
  try {
    await fbRequest<unknown>({
      protocol: 'json',
      method: 'GET',
      host: 'graph',
      path: `/${input.commentId}`,
      params: { fields: 'id' },
      ...scopeFields(input),
    });
    return true;
  } catch (probeErr) {
    return !isObjectGoneError(probeErr);
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
    const res = await fbRequest<unknown>({
      protocol: 'json',
      method: 'POST',
      host: 'graph',
      path: `/${input.pageId}/messages`,
      body: {
        recipient: { comment_id: input.commentId },
        message: { text: input.message },
      },
      verifyTool: VERIFY_PRIVATE_REPLY_TOOL,
      ...scopeFields(input),
    });
    // The receipt is read defensively because this send is the ONE private reply
    // the comment ever gets: an empty 200 body parses to `undefined`, and a
    // TypeError from the success path would report a delivered message as failed
    // and invite a retry that can never succeed (CC-MOD-2).
    const ack = ackOf(res.data);
    const messageId = ackId(ack.message_id);
    const recipientId = ackId(ack.recipient_id);
    return {
      ...(messageId !== undefined ? { messageId } : {}),
      ...(recipientId !== undefined ? { recipientId } : {}),
    };
  } catch (err) {
    const refusal = classifyPrivateReplyFailure(err);
    if (refusal !== undefined) {
      throw privateReplyRefusalError(refusal, input.commentId, err);
    }
    throw err instanceof Error ? err : new Error(errorMessageOf(err), { cause: err });
  }
}

// ---------------------------------------------------------------------------
// 9. Blocked users (CC-MOD-7)
//
// The two verbs are NOT mirror images on the wire (Graph reference, Page
// `/blocked` edge). Blocking is ONE POST carrying a LIST under `psid` and is
// answered with a map of `{ "<psid>": bool }` — natively per id. Unblocking is
// a DELETE that takes ONE `psid` and is answered with `{ success: bool }`, a
// struct with no id in it, so a batch unblock is one DELETE per PSID through
// `runBulk` and the per-id contract (CC-MOD-5) is kept by the runner rather
// than by the edge. The parameter is `psid` on both verbs (alongside `asid`,
// `uid` and `user`); there is no `psids`.
// ---------------------------------------------------------------------------

function embeddedErrorMessage(entry: Record<string, unknown>): string | undefined {
  const error: unknown = entry.error;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  if (typeof entry.message === 'string') return entry.message;
  return undefined;
}

/**
 * Interpret one entry of the block map. Graph answers `true` per PSID on
 * success and an embedded `{success:false, error}` per PSID on failure, so a
 * bad PSID never fails the batch (CC-MOD-5). Read with `Object.hasOwn`: the
 * key is the caller's PSID, and a PSID spelt `constructor` or `__proto__`
 * would otherwise read a prototype slot and report a failure Facebook never
 * sent.
 */
function blockedOutcome(id: string, map: Record<string, unknown>): BulkOutcome {
  const entry: unknown = Object.hasOwn(map, id) ? map[id] : undefined;
  if (entry === true) return { id, ok: true };
  if (isRecord(entry)) {
    if (entry.success === true) return { id, ok: true };
    return {
      id,
      ok: false,
      error: embeddedErrorMessage(entry) ?? 'Facebook reported a failure for this PSID',
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
 * True when a Graph failure SAYS "this PSID was not on the blocked list".
 * Meta documents no stable code for it, so the wording is matched — and only
 * the explicit wording: the gone-looking text below is shared with a refusal.
 */
function isNotBlockedError(err: unknown): err is GraphApiError {
  return err instanceof GraphApiError && /not blocked/i.test(err.message);
}

/**
 * True when a Graph failure LOOKS like "nothing to unblock" but cannot prove it.
 * Graph's 100/33 answer ("does not exist, cannot be loaded due to missing
 * permissions, or does not support this operation") is the same text for a
 * target that is not there and for a token that may not act on it, so it has
 * to be confirmed with a read before it may become a no-op.
 */
function looksNotBlockedError(err: unknown): err is GraphApiError {
  return (
    err instanceof GraphApiError &&
    /does not exist|no such|cannot be loaded/i.test(err.message)
  );
}

/**
 * Whether a read of the Page's blocked list CONFIRMS the PSID is not on it
 * (`GET /{page-id}/blocked?user=`, which answers only the matching entry). Only
 * an explicit empty `data` array confirms: a listed entry, an unreadable body or
 * a failed read all leave the user possibly blocked, and a probe that cannot
 * confirm must not turn a refused unblock into a success.
 */
async function confirmedNotBlocked(
  fbRequest: FbRequestFn,
  input: { readonly pageId: string; readonly psid: string } & CommentScope,
): Promise<boolean> {
  try {
    const res = await fbRequest<unknown>({
      protocol: 'json',
      method: 'GET',
      host: 'graph',
      path: `/${input.pageId}/blocked`,
      params: { user: input.psid },
      ...scopeFields(input),
    });
    const data: unknown = isRecord(res.data) ? res.data.data : undefined;
    return Array.isArray(data) && data.length === 0;
  } catch {
    return false;
  }
}

/**
 * Unblock ONE PSID. The DELETE answers a `{success}` struct read through the
 * same {@link confirmsWrite} rule as every other write (a bodiless 2xx confirms,
 * a present `success` must be `true`). A never-blocked PSID can only announce
 * itself as a Graph error on this call, and is normalized to success-with-note
 * so block/unblock stay symmetric (CC-MOD-7) — directly when Graph says "not
 * blocked", and after a confirming read when it answers the ambiguous 100/33
 * text, which a permission refusal shares: reporting THAT as done would tell the
 * operator a user is unblocked who is still blocked.
 */
async function unblockOne(
  fbRequest: FbRequestFn,
  input: { readonly pageId: string; readonly psid: string } & CommentScope,
): Promise<BulkStep> {
  try {
    const res = await fbRequest<unknown>({
      protocol: 'json',
      method: 'DELETE',
      host: 'graph',
      path: `/${input.pageId}/blocked`,
      params: { psid: input.psid },
      ...scopeFields(input),
    });
    return confirmsWrite(res.data)
      ? { ok: true }
      : { ok: false, error: 'Facebook reported success:false' };
  } catch (err) {
    if (isNotBlockedError(err)) return { ok: true, note: NOT_BLOCKED_NOTE };
    if (looksNotBlockedError(err) && (await confirmedNotBlocked(fbRequest, input))) {
      return { ok: true, note: NOT_BLOCKED_NOTE };
    }
    throw err;
  }
}

/**
 * Block or unblock PSIDs on a Page's `/blocked` list, returning a per-PSID
 * outcome in the caller's order. Blocking is one POST for the whole list;
 * unblocking is one DELETE per PSID (see the section note). Blocking an
 * already-blocked user is a Graph-side no-op, which is what makes both verbs
 * idempotent (CC-MOD-7).
 */
export async function setBlocked(
  fbRequest: FbRequestFn,
  input: {
    readonly pageId: string;
    readonly psids: readonly string[];
    readonly blocked: boolean;
  } & CommentScope,
): Promise<readonly BulkOutcome[]> {
  // Deduplicated for the same reason as `runBulk`: one PSID, one outcome.
  const psids = [...new Set(input.psids)];
  if (!input.blocked) {
    const { pageId, token, timeoutMs, signal } = input;
    return runBulk(psids, (psid) =>
      unblockOne(fbRequest, {
        pageId,
        psid,
        token,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(signal !== undefined ? { signal } : {}),
      }),
    );
  }
  const res = await fbRequest<unknown>({
    protocol: 'json',
    method: 'POST',
    host: 'graph',
    path: `/${input.pageId}/blocked`,
    body: { psid: psids },
    ...scopeFields(input),
  });
  const map: Record<string, unknown> = isRecord(res.data) ? res.data : {};
  return psids.map((id) => blockedOutcome(id, map));
}
