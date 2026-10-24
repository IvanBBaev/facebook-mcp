// Comment triage (v2 messaging F6, facebook_triage_comments) — "which comments
// on my recent posts has the Page not answered yet", optionally narrowed by
// keyword, in one call instead of one listing per post.
//
// The scan reads each recent post's comments newest first and stops at the
// first comment older than `since`, so every comment NEWER than a kept one has
// already been seen. That ordering is what lets the `filter=stream` mode decide
// "answered" locally: a Page reply is always newer than the comment it answers.
// The toplevel mode cannot see replies, so it reads each candidate's reply edge
// (newest 25) under a budget; a comment with no replies needs no read at all.
//
// Failures degrade per post: a refused post becomes a note and `truncated`. A
// permission or token refusal fails the whole call (every post would fail the
// same way), and a rate limit stops the scan with what was already read.
// Comment bodies and author names are returned UNTAINTED; the tools layer
// wraps them before they reach the model.

import { GraphApiError } from '../core/index.js';
import type { FbRequestFn } from '../core/index.js';
import { listComments, type CommentFilter, type CommentNode } from './comments.js';
import { parseGraphTime } from './messaging.js';
import { fetchPage } from './shared.js';

export const TRIAGE_DEFAULT_POSTS = 10;
export const TRIAGE_MAX_POSTS = 25;
export const TRIAGE_DEFAULT_MAX_COMMENTS = 100;
export const TRIAGE_MAX_COMMENTS = 200;
export const TRIAGE_MAX_KEYWORDS = 20;
/** Posts scanned at once. */
export const TRIAGE_CONCURRENCY = 4;
/** Rows per comments-edge page. */
export const TRIAGE_COMMENT_PAGE_LIMIT = 100;
/** Hard cap on comments-edge requests per call, across every post. */
export const TRIAGE_MAX_COMMENT_CALLS = 50;
/** Hard cap on per-comment reply reads (toplevel mode, `unanswered`). */
export const MAX_REPLY_SCANS = 100;
/** Newest replies read per comment when looking for a Page reply. */
export const TRIAGE_REPLY_SCAN_LIMIT = 25;

export type TriageStatus = 'unanswered' | 'all' | 'hidden';

export const RATE_LIMITED_NOTE = 'rate limited; partial results';

/** One comment the scan kept. `message` and `authorName` are UNTRUSTED. */
export interface TriageComment {
  readonly commentId: string;
  readonly postId: string;
  readonly createdTime?: string;
  readonly parentId?: string;
  readonly isHidden?: boolean;
  readonly likeCount?: number;
  readonly commentCount?: number;
  readonly authorId?: string;
  readonly authorName?: string;
  readonly message?: string;
  readonly matchedKeywords: readonly string[];
  /** `null` when the reply read was over budget, refused or incomplete. */
  readonly pageReplied: boolean | null;
  readonly canReplyPrivately: boolean | null;
}

export interface TriageOptions {
  readonly pageId: string;
  readonly token: string;
  readonly posts: number;
  /** Keep comments created at or after this instant. */
  readonly sinceMs?: number;
  readonly status: TriageStatus;
  readonly keywords?: readonly string[];
  readonly includeReplies: boolean;
  readonly maxComments: number;
  readonly signal?: AbortSignal;
  /** Override for tests; defaults to {@link MAX_REPLY_SCANS}. */
  readonly maxReplyScans?: number;
}

export interface TriageScan {
  readonly scannedPosts: number;
  readonly scannedComments: number;
  readonly truncated: boolean;
  /** Newest first, across every post. */
  readonly items: readonly TriageComment[];
  readonly notes: readonly string[];
  /** True when the Page has no published post to scan. */
  readonly noPosts: boolean;
}

// ---------------------------------------------------------------------------
// Keyword matching (pure)
// ---------------------------------------------------------------------------

function foldText(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase();
}

/**
 * The keywords a text contains: NFKC-normalised, case-folded substring match,
 * any keyword counts. No regex is ever built from input, so untrusted text
 * cannot trigger catastrophic backtracking. Returns the keywords as the caller
 * wrote them (deduplicated), never a slice of the text.
 */
export function matchKeywords(
  text: string | undefined,
  keywords: readonly string[],
): string[] {
  if (text === undefined || keywords.length === 0) return [];
  const folded = foldText(text);
  const seen = new Set<string>();
  const matched: string[] = [];
  for (const keyword of keywords) {
    const needle = foldText(keyword);
    if (needle.length === 0 || seen.has(needle)) continue;
    seen.add(needle);
    if (folded.includes(needle)) matched.push(keyword);
  }
  return matched;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

function isRateLimit(err: unknown): boolean {
  if (!(err instanceof GraphApiError)) return false;
  return err.action?.category === 'rate_limit' || RATE_LIMIT_CODES.has(err.code);
}

/** A refusal every other post would repeat: permission (10, 2xx) or a dead token. */
function failsWholeCall(err: unknown): boolean {
  if (!(err instanceof GraphApiError)) return false;
  const category = err.action?.category;
  if (category === 'permission' || category === 'auth') return true;
  return err.code === 10 || (err.code >= 200 && err.code < 300) || err.code === 190;
}

function errorSummary(err: unknown): string {
  if (err instanceof GraphApiError) return `(#${String(err.code)}) ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

async function recentPostIds(
  fbRequest: FbRequestFn,
  opts: TriageOptions,
): Promise<string[]> {
  const page = await fetchPage<unknown>(
    fbRequest,
    {
      host: 'graph',
      path: `/${opts.pageId}/published_posts`,
      params: { fields: 'id,created_time' },
      pageId: opts.pageId,
      token: opts.token,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    },
    { limit: opts.posts },
  );
  return page.data.slice(0, opts.posts).flatMap((raw) => {
    const id = (raw as { id?: unknown } | null)?.id;
    return typeof id === 'string' && id.length > 0 ? [id] : [];
  });
}

/** A thrown value as an Error (Graph and the fetch layer always throw Errors). */
function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(JSON.stringify(err) ?? 'unknown error');
}

/** Stop signal shared by every worker once a rate limit is hit. */
class ScanStopped extends Error {}

/**
 * Scan the most recent posts' comments and keep those matching the status and
 * keyword filters. See the module header for the ordering and budget rules.
 */
export async function scanRecentComments(
  fbRequest: FbRequestFn,
  opts: TriageOptions,
): Promise<TriageScan> {
  const postIds = await recentPostIds(fbRequest, opts);
  const filter: CommentFilter = opts.includeReplies ? 'stream' : 'toplevel';
  const keywords = opts.keywords ?? [];
  const replyBudget = opts.maxReplyScans ?? MAX_REPLY_SCANS;
  const items: { readonly item: TriageComment; readonly atMs: number }[] = [];
  const notes: string[] = [];
  let scannedComments = 0;
  let commentCalls = 0;
  let replyScans = 0;
  let replyScansSkipped = 0;
  let replyScansIncomplete = 0;
  let truncated = false;
  let full = false;
  let callBudgetHit = false;
  let rateLimited = false;
  let fatal: unknown;
  let next = 0;
  let failedPosts = 0;
  let firstPostError: unknown;

  const stopped = (): boolean => full || rateLimited || fatal !== undefined;

  /** Whether the Page replied in this comment's thread (toplevel mode). */
  const pageRepliedVia = async (node: CommentNode): Promise<boolean | null> => {
    if ((node.replyCount ?? 0) === 0) return false;
    if (replyScans >= replyBudget) {
      replyScansSkipped += 1;
      return null;
    }
    replyScans += 1;
    try {
      const page = await fetchPage<unknown>(
        fbRequest,
        {
          host: 'graph',
          path: `/${node.id}/comments`,
          params: { fields: 'from{id}', order: 'reverse_chronological' },
          token: opts.token,
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        },
        { limit: TRIAGE_REPLY_SCAN_LIMIT },
      );
      const replied = page.data.some(
        (raw) => (raw as { from?: { id?: unknown } } | null)?.from?.id === opts.pageId,
      );
      if (replied) return true;
      if (page.nextCursor !== undefined) {
        replyScansIncomplete += 1;
        return null;
      }
      return false;
    } catch (err) {
      if (opts.signal?.aborted === true) throw err;
      if (isRateLimit(err)) {
        rateLimited = true;
        throw new ScanStopped();
      }
      if (failsWholeCall(err)) {
        fatal ??= err;
        throw new ScanStopped();
      }
      replyScansIncomplete += 1;
      return null;
    }
  };

  /** Stream mode: a Page reply newer than `node` in the same thread. */
  const pageRepliedInStream = (node: CommentNode, seen: readonly CommentNode[]) => {
    const atMs = parseGraphTime(node.createdTime) ?? Number.NEGATIVE_INFINITY;
    const thread = node.parentId;
    return seen.some((other) => {
      if (other.authorId !== opts.pageId) return false;
      if (other.parentId === node.id) return true;
      if (thread === undefined || other.parentId !== thread) return false;
      return (parseGraphTime(other.createdTime) ?? Number.NEGATIVE_INFINITY) > atMs;
    });
  };

  const consider = async (
    node: CommentNode,
    postId: string,
    seen: readonly CommentNode[],
  ): Promise<void> => {
    if (node.id === '' || node.authorId === opts.pageId) return;
    if (opts.status === 'hidden' && node.hidden !== true) return;
    const matchedKeywords = matchKeywords(node.message, keywords);
    if (keywords.length > 0 && matchedKeywords.length === 0) return;
    let pageReplied: boolean | null;
    if (opts.includeReplies) pageReplied = pageRepliedInStream(node, seen);
    else if (opts.status === 'unanswered') pageReplied = await pageRepliedVia(node);
    // `all` / `hidden` in toplevel mode: answer only what costs no request.
    else pageReplied = (node.replyCount ?? 0) === 0 ? false : null;
    if (opts.status === 'unanswered' && pageReplied === true) return;
    if (items.length >= opts.maxComments) {
      full = true;
      truncated = true;
      return;
    }
    items.push({
      atMs: parseGraphTime(node.createdTime) ?? 0,
      item: {
        commentId: node.id,
        postId,
        ...(node.createdTime !== undefined ? { createdTime: node.createdTime } : {}),
        ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
        ...(node.hidden !== undefined ? { isHidden: node.hidden } : {}),
        ...(node.likeCount !== undefined ? { likeCount: node.likeCount } : {}),
        ...(node.replyCount !== undefined ? { commentCount: node.replyCount } : {}),
        ...(node.authorId !== undefined ? { authorId: node.authorId } : {}),
        ...(node.authorName !== undefined ? { authorName: node.authorName } : {}),
        ...(node.message !== undefined ? { message: node.message } : {}),
        matchedKeywords,
        pageReplied,
        canReplyPrivately: node.canReplyPrivately ?? null,
      },
    });
  };

  const scanPost = async (postId: string): Promise<void> => {
    const seen: CommentNode[] = [];
    let after: string | undefined;
    for (;;) {
      if (stopped()) return;
      if (commentCalls >= TRIAGE_MAX_COMMENT_CALLS) {
        callBudgetHit = true;
        truncated = true;
        return;
      }
      commentCalls += 1;
      const page = await listComments(
        fbRequest,
        {
          objectId: postId,
          filter,
          order: 'reverse_chronological',
          token: opts.token,
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        },
        {
          limit: TRIAGE_COMMENT_PAGE_LIMIT,
          ...(after !== undefined ? { after } : {}),
        },
      );
      for (const node of page.data) {
        if (stopped()) return;
        const atMs = parseGraphTime(node.createdTime);
        if (opts.sinceMs !== undefined && atMs !== undefined && atMs < opts.sinceMs) {
          return;
        }
        scannedComments += 1;
        await consider(node, postId, seen);
        seen.push(node);
      }
      if (page.nextCursor === undefined) return;
      after = page.nextCursor;
    }
  };

  const worker = async (): Promise<void> => {
    while (next < postIds.length && !stopped()) {
      const postId = postIds[next] as string;
      next += 1;
      try {
        await scanPost(postId);
      } catch (err) {
        if (err instanceof ScanStopped) continue;
        if (opts.signal?.aborted === true) throw err;
        if (isRateLimit(err)) {
          rateLimited = true;
          continue;
        }
        if (failsWholeCall(err)) {
          fatal ??= err;
          continue;
        }
        failedPosts += 1;
        firstPostError ??= err;
        truncated = true;
        notes.push(`post ${postId}: ${errorSummary(err)}`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(TRIAGE_CONCURRENCY, postIds.length) }, worker),
  );

  if (fatal !== undefined) throw asError(fatal);
  if (postIds.length > 0 && failedPosts === postIds.length) {
    throw asError(firstPostError);
  }

  if (rateLimited) {
    truncated = true;
    notes.push(RATE_LIMITED_NOTE);
  }
  if (callBudgetHit) {
    notes.push(
      `Stopped after ${String(TRIAGE_MAX_COMMENT_CALLS)} comment pages; narrow \`since\` ` +
        'or scan fewer posts to reach the rest.',
    );
  }
  if (full) {
    notes.push(
      `Stopped at max_comments (${String(opts.maxComments)}); more comments match.`,
    );
  }
  if (replyScansSkipped > 0) {
    notes.push(
      `Reply scan skipped for ${String(replyScansSkipped)} thread(s) (budget ` +
        `${String(replyBudget)}): their pageReplied is null.`,
    );
  }
  if (replyScansIncomplete > 0) {
    notes.push(
      `For ${String(replyScansIncomplete)} thread(s) no Page reply was found in the ` +
        'readable replies, but not every reply could be checked: their pageReplied is null.',
    );
  }

  items.sort((a, b) => b.atMs - a.atMs);
  return {
    scannedPosts: postIds.length,
    scannedComments,
    truncated,
    items: items.map((entry) => entry.item),
    notes,
    noPosts: postIds.length === 0,
  };
}
