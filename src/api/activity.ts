// "What is new since X" across comments and Messenger conversations (v2
// insights F3, facebook_get_activity_since). This module owns the reads, the
// cutoff and the budgets; the tool owns the high-water marks, the taint
// rendering and the result shape.
//
// The window is half-open on the left: an item is kept iff
// `since < time ≤ horizon`, where `horizon` is the clock captured BEFORE the
// first request. The next call's stored `since` is that horizon, so an item
// that lands mid-scan (time > horizon) is left for the next call instead of
// being lost, and the strict `>` keeps the boundary item from being reported
// twice.
//
// Each section degrades on its own: a failed section becomes `{error}` and the
// other one is still returned. Only when every requested section fails does
// the read throw (the first error), and an abort always propagates.

import { GraphApiError, classifyGraphError } from '../core/index.js';
import type { ActivityMarks, FbRequestFn } from '../core/index.js';
import { listComments, type CommentNode } from './comments.js';
import {
  listConversations,
  parseGraphTime,
  type ConversationRecord,
} from './messaging.js';
import { fetchPage } from './shared.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** `since` may reach this far back; older scans are unbounded in practice. */
export const ACTIVITY_MAX_LOOKBACK_DAYS = 90;
/** The window used when there is neither an argument nor a stored mark. */
export const ACTIVITY_DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const ACTIVITY_DEFAULT_POSTS = 10;
export const ACTIVITY_MAX_POSTS = 25;
export const ACTIVITY_DEFAULT_MAX_COMMENTS = 50;
export const ACTIVITY_MAX_COMMENTS = 100;
/** Hard cap on comment-edge requests per call, across every post. */
export const ACTIVITY_MAX_COMMENT_CALLS = 30;
/** Posts whose comments are read concurrently. */
export const ACTIVITY_COMMENT_CONCURRENCY = 3;
/** Comments per edge page. */
export const ACTIVITY_COMMENT_PAGE_LIMIT = 25;
/** Conversation pages walked at most. */
export const ACTIVITY_MAX_CONVERSATION_PAGES = 3;
/** Conversations per edge page. */
export const ACTIVITY_CONVERSATION_PAGE_LIMIT = 25;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const POST_FIELDS = 'id,created_time,updated_time,permalink_url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A failed section, in the shape the tool surfaces. */
export interface SectionFailure {
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly hint?: string;
  };
}

/** One new comment. `authorName` and `message` are UNTRUSTED and must be tainted. */
export interface ActivityComment {
  readonly commentId: string;
  readonly postId: string;
  readonly createdTime: string;
  readonly createdAtMs: number;
  readonly isReply: boolean;
  readonly parentId: string | null;
  readonly likeCount: number | null;
  readonly commentCount: number | null;
  readonly isHidden: boolean | null;
  readonly canReplyPrivately: boolean | null;
  readonly permalinkUrl: string | null;
  readonly authorName?: string;
  readonly message?: string;
}

export interface CommentsCollected {
  readonly items: readonly ActivityComment[];
  readonly postsScanned: number;
  /** A budget (max_comments or the call cap) stopped the scan early. */
  readonly truncated: boolean;
  /** Posts whose comments could not be read (the others were). */
  readonly postErrors?: readonly { readonly postId: string; readonly code: number }[];
}

/** One conversation with new or unread messages. `snippet` / names are UNTRUSTED. */
export interface ActivityConversation {
  readonly conversationId: string;
  readonly updatedTime: string;
  readonly updatedAtMs: number;
  readonly unreadCount: number | null;
  readonly messageCount: number | null;
  readonly canReply: boolean | null;
  readonly snippet?: string;
  readonly participantNames: readonly (string | null)[];
}

export interface ConversationsCollected {
  readonly items: readonly ActivityConversation[];
  readonly unreadTotal: number;
  /** The page or item cap stopped the walk before it reached `since`. */
  readonly truncated: boolean;
}

export interface ActivityOptions {
  readonly pageId: string;
  readonly token: string;
  /** Exclusive lower bound per section (epoch ms). */
  readonly commentsSinceMs: number;
  readonly conversationsSinceMs: number;
  /** Inclusive upper bound (epoch ms), captured before the first request. */
  readonly horizonMs: number;
  readonly posts: number;
  readonly maxComments: number;
  readonly includeComments: boolean;
  readonly includeConversations: boolean;
  readonly signal?: AbortSignal;
}

export interface ActivityCollected {
  readonly comments?: CommentsCollected | SectionFailure;
  readonly conversations?: ConversationsCollected | SectionFailure;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** A client-side parameter error, classified through the shared matrix (code 100). */
function validationError(message: string): GraphApiError {
  return new GraphApiError(message, {
    code: 100,
    httpStatus: 400,
    action: classifyGraphError({ code: 100, message }),
  });
}

/**
 * Validate an explicit `since` against `nowMs`: not in the future and not more
 * than {@link ACTIVITY_MAX_LOOKBACK_DAYS} back. Returns epoch ms.
 */
export function checkActivitySince(since: string, nowMs: number): number {
  const ms = Date.parse(since);
  if (!Number.isFinite(ms)) {
    throw validationError(
      `\`since\` ${JSON.stringify(since)} is not an ISO-8601 instant.`,
    );
  }
  if (ms > nowMs) {
    throw validationError(
      `\`since\` ${since} is in the future; pass an instant before now (${new Date(nowMs).toISOString()}).`,
    );
  }
  if (nowMs - ms > ACTIVITY_MAX_LOOKBACK_DAYS * MS_PER_DAY) {
    throw validationError(
      `\`since\` ${since} is more than ${ACTIVITY_MAX_LOOKBACK_DAYS} days back; use a later ` +
        'instant, or facebook_list_comments / facebook_list_conversations for older history.',
    );
  }
  return ms;
}

/** True when `timeMs` falls in the half-open window `(sinceMs, horizonMs]`. */
export function inActivityWindow(
  timeMs: number,
  sinceMs: number,
  horizonMs: number,
): boolean {
  return timeMs > sinceMs && timeMs <= horizonMs;
}

export function isSectionFailure(value: unknown): value is SectionFailure {
  return typeof value === 'object' && value !== null && 'error' in value;
}

function failureOf(err: unknown): SectionFailure {
  const code = err instanceof GraphApiError ? err.code : 0;
  const message = err instanceof Error ? err.message : String(err);
  const hint = err instanceof GraphApiError ? err.action?.operatorText : undefined;
  return { error: { code, message, ...(hint !== undefined ? { hint } : {}) } };
}

/** Abort is the caller's decision, never a section to degrade. */
function rethrowIfAborted(err: unknown, signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw err;
}

function toActivityComment(
  node: CommentNode,
  postId: string,
): ActivityComment | undefined {
  const createdAtMs = parseGraphTime(node.createdTime);
  if (node.id === '' || node.createdTime === undefined || createdAtMs === undefined) {
    return undefined;
  }
  return {
    commentId: node.id,
    postId,
    createdTime: node.createdTime,
    createdAtMs,
    isReply: node.parentId !== undefined,
    parentId: node.parentId ?? null,
    likeCount: node.likeCount ?? null,
    commentCount: node.replyCount ?? null,
    isHidden: node.hidden ?? null,
    canReplyPrivately: node.canReplyPrivately ?? null,
    permalinkUrl: node.permalink ?? null,
    ...(node.authorName !== undefined ? { authorName: node.authorName } : {}),
    ...(node.message !== undefined ? { message: node.message } : {}),
  };
}

function toActivityConversation(
  record: ConversationRecord,
): ActivityConversation | undefined {
  if (
    record.id === undefined ||
    record.updatedTime === undefined ||
    record.updatedAtMs === undefined
  ) {
    return undefined;
  }
  return {
    conversationId: record.id,
    updatedTime: record.updatedTime,
    updatedAtMs: record.updatedAtMs,
    unreadCount: record.unreadCount ?? null,
    messageCount: record.messageCount ?? null,
    canReply: record.canReply ?? null,
    ...(record.snippet !== undefined ? { snippet: record.snippet } : {}),
    participantNames: record.participants.map((p) => p.name ?? null),
  };
}

// ---------------------------------------------------------------------------
// The window and the marks (pure)
// ---------------------------------------------------------------------------

export type SinceSource = 'argument' | 'stored' | 'default_24h';
export type ActivitySection = 'comments' | 'conversations';

const MARK_KEY: Record<ActivitySection, 'commentsSeenAt' | 'conversationsSeenAt'> = {
  comments: 'commentsSeenAt',
  conversations: 'conversationsSeenAt',
};

export interface SinceResolution {
  readonly commentsSinceMs: number;
  readonly conversationsSinceMs: number;
  readonly sinceSource: SinceSource;
  readonly notes: readonly string[];
}

/**
 * Pick each section's exclusive lower bound. An explicit `since` (already
 * validated by {@link checkActivitySince}) wins for both sections; otherwise
 * each section uses its own stored mark, clamped to the 90-day guard, and
 * falls back to now − 24h. `stored` is the store's answer for this Page.
 */
export function resolveActivitySince(input: {
  readonly sinceMs?: number;
  readonly stored: ActivityMarks | undefined | 'unreadable';
  readonly nowMs: number;
  readonly sections: readonly ActivitySection[];
}): SinceResolution {
  const { nowMs } = input;
  const fallbackMs = nowMs - ACTIVITY_DEFAULT_LOOKBACK_MS;
  if (input.sinceMs !== undefined) {
    return {
      commentsSinceMs: input.sinceMs,
      conversationsSinceMs: input.sinceMs,
      sinceSource: 'argument',
      notes: [],
    };
  }
  const notes: string[] = [];
  if (input.stored === 'unreadable') {
    notes.push(
      'The local activity state file could not be read; the window defaults to the ' +
        'last 24 hours. The next successful read rewrites the file.',
    );
  }
  const marks = input.stored === 'unreadable' ? undefined : input.stored;
  const floorMs = nowMs - ACTIVITY_MAX_LOOKBACK_DAYS * MS_PER_DAY;
  let usedStored = false;
  const sinceFor = (section: ActivitySection): number => {
    const raw = marks?.[MARK_KEY[section]];
    const ms = raw === undefined ? Number.NaN : Date.parse(raw);
    if (!Number.isFinite(ms)) return fallbackMs;
    if (!input.sections.includes(section)) return ms;
    if (ms > nowMs) {
      notes.push(
        `The stored ${section} mark (${raw ?? ''}) is in the future (clock change?); ` +
          'the last 24 hours were read instead.',
      );
      return fallbackMs;
    }
    usedStored = true;
    if (ms < floorMs) {
      notes.push(
        `The stored ${section} mark is more than ${String(ACTIVITY_MAX_LOOKBACK_DAYS)} days ` +
          `old; only the last ${String(ACTIVITY_MAX_LOOKBACK_DAYS)} days were read.`,
      );
      return floorMs;
    }
    return ms;
  };
  const commentsSinceMs = sinceFor('comments');
  const conversationsSinceMs = sinceFor('conversations');
  return {
    commentsSinceMs,
    conversationsSinceMs,
    sinceSource: usedStored ? 'stored' : 'default_24h',
    notes,
  };
}

export interface SectionOutcome {
  /** The section was requested, read without error and not truncated. */
  readonly complete: boolean;
  readonly truncated: boolean;
}

export interface MarkAdvancePlan {
  /** Marks to store; `undefined` when no section may advance. */
  readonly marks?: ActivityMarks;
  readonly notes: readonly string[];
}

/**
 * Decide which section marks move to `horizonMs`. A section advances only when
 * it was read completely; a truncated or failed section keeps its mark, so the
 * next call reads the uncovered items again. With an explicit `since` a section
 * advances only when that `since` does not skip past its stored mark (the gap
 * between them was never read).
 */
export function planMarkAdvance(input: {
  readonly sinceSource: SinceSource;
  readonly argumentSinceMs?: number;
  readonly stored: ActivityMarks | undefined | 'unreadable';
  readonly horizonMs: number;
  readonly sections: Partial<Record<ActivitySection, SectionOutcome>>;
}): MarkAdvancePlan {
  const notes: string[] = [];
  const marks: Record<string, string> = {};
  const stored = input.stored === 'unreadable' ? undefined : input.stored;
  for (const section of ['comments', 'conversations'] as const) {
    const outcome = input.sections[section];
    if (outcome === undefined) continue;
    if (!outcome.complete) {
      if (outcome.truncated) {
        notes.push(
          `The ${section} section hit its budget, so its mark was not advanced; the ` +
            'next call reads the same window again.',
        );
      }
      continue;
    }
    const raw = stored?.[MARK_KEY[section]];
    const storedMs = raw === undefined ? Number.NaN : Date.parse(raw);
    const hasStored = Number.isFinite(storedMs);
    if (
      input.sinceSource === 'argument' &&
      hasStored &&
      input.argumentSinceMs !== undefined &&
      input.argumentSinceMs > storedMs
    ) {
      notes.push(
        `The ${section} mark was not advanced: the explicit since is later than the ` +
          `stored mark (${raw ?? ''}), so the time between them was never read.`,
      );
      continue;
    }
    // A valid mark is never after the horizon (it was a past horizon); one that
    // is came from a clock change and is replaced rather than kept forever.
    if (hasStored && storedMs === input.horizonMs) continue;
    marks[MARK_KEY[section]] = new Date(input.horizonMs).toISOString();
  }
  if (Object.keys(marks).length === 0) return { notes };
  marks.updatedAt = new Date(input.horizonMs).toISOString();
  return { marks, notes };
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

async function recentPostIds(
  fbRequest: FbRequestFn,
  opts: ActivityOptions,
): Promise<string[]> {
  const page = await fetchPage<unknown>(
    fbRequest,
    {
      host: 'graph',
      path: `/${opts.pageId}/published_posts`,
      params: { fields: POST_FIELDS },
      pageId: opts.pageId,
      token: opts.token,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    },
    { limit: opts.posts },
  );
  return page.data.flatMap((raw) => {
    const id = (raw as { id?: unknown } | null)?.id;
    return typeof id === 'string' && id.length > 0 ? [id] : [];
  });
}

/**
 * New comments on the most recent posts. Each post's comments are read newest
 * first (`filter=stream`, `order=reverse_chronological`) and the read stops at
 * the first comment at or before `since`, so an unchanged post costs one call.
 */
export async function collectComments(
  fbRequest: FbRequestFn,
  opts: ActivityOptions,
): Promise<CommentsCollected> {
  const postIds = await recentPostIds(fbRequest, opts);
  const items: ActivityComment[] = [];
  const postErrors: { postId: string; code: number }[] = [];
  let firstError: unknown;
  let calls = 0;
  let truncated = false;
  let next = 0;

  const scanPost = async (postId: string): Promise<void> => {
    let after: string | undefined;
    for (;;) {
      if (truncated) return;
      if (calls >= ACTIVITY_MAX_COMMENT_CALLS) {
        truncated = true;
        return;
      }
      calls += 1;
      const page = await listComments(
        fbRequest,
        {
          objectId: postId,
          filter: 'stream',
          order: 'reverse_chronological',
          token: opts.token,
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        },
        {
          limit: ACTIVITY_COMMENT_PAGE_LIMIT,
          ...(after !== undefined ? { after } : {}),
        },
      );
      for (const node of page.data) {
        const comment = toActivityComment(node, postId);
        if (comment === undefined) continue;
        if (comment.createdAtMs > opts.horizonMs) continue;
        if (comment.createdAtMs <= opts.commentsSinceMs) return;
        if (items.length >= opts.maxComments) {
          truncated = true;
          return;
        }
        items.push(comment);
      }
      if (page.nextCursor === undefined) return;
      after = page.nextCursor;
    }
  };

  const worker = async (): Promise<void> => {
    while (next < postIds.length && !truncated) {
      const postId = postIds[next] as string;
      next += 1;
      try {
        await scanPost(postId);
      } catch (err) {
        rethrowIfAborted(err, opts.signal);
        firstError ??= err;
        postErrors.push({ postId, code: err instanceof GraphApiError ? err.code : 0 });
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(ACTIVITY_COMMENT_CONCURRENCY, postIds.length) },
      worker,
    ),
  );

  if (postIds.length > 0 && postErrors.length === postIds.length) throw firstError;
  items.sort((a, b) => b.createdAtMs - a.createdAtMs);
  return {
    items,
    postsScanned: postIds.length,
    truncated,
    ...(postErrors.length > 0 ? { postErrors } : {}),
  };
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

/**
 * Conversations updated since `since`, newest first. The walk stops at the
 * first conversation at or before `since`; unread conversations on that last
 * page are still included, since "unread" is new to whoever reads this.
 */
export async function collectConversations(
  fbRequest: FbRequestFn,
  opts: ActivityOptions,
): Promise<ConversationsCollected> {
  const items: ActivityConversation[] = [];
  let after: string | undefined;
  let truncated = true;
  walk: for (let pageNo = 0; pageNo < ACTIVITY_MAX_CONVERSATION_PAGES; pageNo += 1) {
    const page = await listConversations(fbRequest, {
      pageId: opts.pageId,
      token: opts.token,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      page: {
        limit: ACTIVITY_CONVERSATION_PAGE_LIMIT,
        ...(after !== undefined ? { after } : {}),
      },
    });
    let reachedSince = false;
    for (const record of page.data) {
      const conversation = toActivityConversation(record);
      if (conversation === undefined) continue;
      if (conversation.updatedAtMs > opts.horizonMs) continue;
      const isNew = conversation.updatedAtMs > opts.conversationsSinceMs;
      if (!isNew) reachedSince = true;
      if (!isNew && (conversation.unreadCount ?? 0) <= 0) continue;
      if (items.length >= opts.maxComments) break walk;
      items.push(conversation);
    }
    if (reachedSince || page.nextCursor === undefined) {
      truncated = false;
      break;
    }
    after = page.nextCursor;
  }
  return {
    items,
    unreadTotal: items.reduce((sum, c) => sum + (c.unreadCount ?? 0), 0),
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Read every requested section. A failed section becomes `{error}`; when every
 * requested section fails, the first error is thrown instead.
 */
export async function collectActivity(
  fbRequest: FbRequestFn,
  opts: ActivityOptions,
): Promise<ActivityCollected> {
  const errors: { comments?: unknown; conversations?: unknown } = {};
  const guard = async <T>(
    section: 'comments' | 'conversations',
    read: () => Promise<T>,
  ): Promise<T | SectionFailure> => {
    try {
      return await read();
    } catch (err) {
      rethrowIfAborted(err, opts.signal);
      errors[section] = err;
      return failureOf(err);
    }
  };
  const [comments, conversations] = await Promise.all([
    opts.includeComments
      ? guard('comments', () => collectComments(fbRequest, opts))
      : undefined,
    opts.includeConversations
      ? guard('conversations', () => collectConversations(fbRequest, opts))
      : undefined,
  ]);
  const failed = Object.keys(errors).length;
  const requested = Number(opts.includeComments) + Number(opts.includeConversations);
  if (requested > 0 && failed === requested) {
    // Comments come first in the result, so theirs is the error to throw.
    throw 'comments' in errors ? errors.comments : errors.conversations;
  }
  return {
    ...(comments !== undefined ? { comments } : {}),
    ...(conversations !== undefined ? { conversations } : {}),
  };
}
