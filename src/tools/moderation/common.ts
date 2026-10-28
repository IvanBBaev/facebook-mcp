// Shared building blocks of the `moderation` package: the annotation
// quadruples, the write tiers, the input fields several tools take, and the
// small helpers every handler leans on (the Page scope, preview truncation,
// the write-failure classifier).

import { z } from 'zod';

import type {
  ResolvedPage,
  ToolAnnotations,
  ToolContext,
  WriteTier,
} from '../../core/index.js';
import { GraphApiError, isProvablyNotSent } from '../../core/index.js';
import { MAX_BULK_IDS } from '../../api/comments.js';

import { graphNodeIdArg } from '../shared.js';

/** Both read tools: read-only, non-destructive, idempotent, open-world. */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * `facebook_reply_to_comment`. Not destructive (it only adds), but NOT
 * idempotent: a retry after a lost response posts the reply twice.
 */
export const REPLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * `facebook_hide_comment`, `facebook_block_user`, `facebook_unblock_user`.
 * Reversible by design (each has an inverse verb / flag), so `destructiveHint`
 * stays `false` and client prompting stays proportionate; repeating the call
 * lands on the same state, so `idempotentHint` is `true`.
 */
export const REVERSIBLE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * `facebook_delete_comment`. Permanent, so `destructiveHint:true`; deleting an
 * already-deleted comment has no further effect, so `idempotentHint:true`.
 */
export const DELETE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * `facebook_private_reply`. Externally visible with no unsend, so
 * `destructiveHint:true`; a lost-response retry can double-send, so
 * `idempotentHint:false`.
 */
export const PRIVATE_REPLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * The write tier of every mutating tool, declared exactly once. Both the tool's
 * `writeTier` annotation (what the client shows the human) and the gate action's
 * `tier` (what actually enforces plan-then-apply) read from this map, so the two
 * can never drift — a tool advertised as `reversible` while the gate treats it as
 * `irreversible`, or worse the other way round, would be a silent consent bug.
 */
export const TIERS = {
  facebook_reply_to_comment: 'reversible',
  facebook_comment_on_post: 'reversible',
  facebook_edit_comment: 'reversible',
  facebook_hide_comment: 'reversible',
  facebook_reply_and_hide_comment: 'reversible',
  facebook_like_comment: 'reversible',
  facebook_delete_comment: 'irreversible',
  facebook_private_reply: 'irreversible',
  facebook_block_user: 'reversible',
  facebook_unblock_user: 'reversible',
} as const satisfies Record<string, WriteTier>;

/**
 * Every comment id below is interpolated into a Graph edge (`/{comment_id}`,
 * `/{comment_id}/comments`), so the shared containment shape applies: the HTTP
 * layer sees the joined pathname and cannot tell an id from a structural
 * segment, which makes a `/` inside an id a retarget of the whole call rather
 * than a malformed string (`GRAPH_NODE_ID_SHAPE` in `./shared.js`).
 */
export const commentIdArg = graphNodeIdArg({
  hint: 'facebook_list_comments returns it as `id`.',
  description:
    'Comment ID, e.g. "123456_789012" as returned by facebook_list_comments. Not a post ID.',
});

export const commentIdsArg = z
  .array(graphNodeIdArg({ hint: 'facebook_list_comments returns each one as `id`.' }))
  .min(1)
  .max(MAX_BULK_IDS)
  .describe(
    `Comment IDs to act on — 1 to ${String(MAX_BULK_IDS)} per call. Each id gets its own ` +
      'outcome, so one bad id does not fail the rest. Split larger sweeps into several calls.',
  );

/** Whether a URL is https:// and carries no credentials (Facebook would get them). */
export function isSafeHttpsUrl(raw: string): boolean {
  const url = new URL(raw);
  return url.protocol === 'https:' && url.username === '' && url.password === '';
}

/** Longest text the comment and private-reply tools accept. */
export const MAX_COMMENT_MESSAGE_CHARS = 8000;

export const messageArg = z
  .string()
  .min(1)
  .max(MAX_COMMENT_MESSAGE_CHARS)
  .describe('The text to send. Written by you — Facebook rejects an empty message.');

/**
 * Journal classification for a write whose `perform` REJECTED (C2 / CC-LIFE-2).
 * A received Graph error envelope proves Facebook processed the request and
 * refused it, so nothing landed (`failed`) — including the mapped private-reply
 * refusals, which carry the originating envelope — and so does a status-0
 * fault whose cause is a connect-phase code. An `ambiguous` error, a 5xx or
 * any other status-0 fault, or anything that is not a Graph error at all (an abort, a
 * transport fault) leaves the outcome UNKNOWN: the request may have landed, so
 * the honest entry is `attempted`. Without this hook the gate records every
 * rejection as `failed`, which tells an operator reconciling the journal that a
 * reply or block which may be live never happened.
 */
export function classifyWriteFailure(err: unknown): 'attempted' | 'failed' {
  if (!(err instanceof GraphApiError)) return 'attempted';
  if (err.action?.category === 'ambiguous') return 'attempted';
  // A connect-phase fault (DNS, ECONNREFUSED) provably put no byte of the write
  // on the wire, so no reply, private reply or block can have landed; only a
  // cause that proves it flips — a mid-flight reset stays `attempted`.
  if (err.httpStatus === 0 && isProvablyNotSent(err.cause)) return 'failed';
  return err.httpStatus === 0 || err.httpStatus >= 500 ? 'attempted' : 'failed';
}

/** Cap a caller-authored string before it enters a preview summary. */
export function truncate(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}… (${String(text.length)} chars)`;
}

/** The Page credential + cancellation scope every api call in this package rides. */
export function scopeOf(
  ctx: ToolContext,
  resolved: ResolvedPage,
): {
  readonly token: string;
  readonly signal?: AbortSignal;
} {
  return {
    token: resolved.token,
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  };
}
