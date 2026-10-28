// The bulk-sweep plumbing of the `moderation` package (CC-MOD-5): per-id
// request fencing on a dead Page token or a rate limit, the per-id state reads
// the previews quote, and the tally / verdict / note of a bulk result.

import type { FbRequestFn, JournalOutcome, ToolContext } from '../../core/index.js';
import {
  GraphApiError,
  ambiguousWriteAction,
  errorMessageOf,
  isPageTokenDead,
} from '../../core/index.js';
import {
  isUnreadableState,
  readCommentStates,
  tallyBulk,
  type BulkOutcome,
  type BulkTally,
  type CommentScope,
  type CommentState,
} from '../../api/comments.js';
import { ATTEMPTED_VERDICT } from '../../mcp/index.js';

/**
 * The note attached to a bulk result that had at least one failure. The
 * all-failed case gets its own wording because "the rest were applied" when
 * there is no rest reports a change that never happened. The machine-readable
 * half of that statement is {@link bulkVerdict}, which also flips the gate's
 * `applied` flag and the journal outcome; this note is the human-readable half
 * and says what to do next.
 */
function bulkNote(tally: BulkTally): string {
  // An ambiguous id reached Facebook and only lost the answer, so it is neither
  // applied nor untouched. "Nothing was applied" is false about a batch holding
  // one, and "every id is still to do" turns that falsehood into an instruction:
  // a blind repeat of a write that may already have landed. The same sentence
  // fronts `facebook_delete_comment`, where the repeat is permanent.
  const unproven = tally.ambiguous ?? 0;
  const unprovenNote =
    unproven > 0
      ? ` ${String(unproven)} of the failures came back unproven — the request reached ` +
        'Facebook and the answer was lost, so those ids may ALREADY be applied. Verify ' +
        'them before acting on them again; do not retry them blind.'
      : '';

  if (tally.failed === tally.total) {
    return unproven > 0
      ? `All ${String(tally.total)} id(s) failed.${unprovenNote} Inspect \`outcomes\`: ` +
          'each entry stands alone, and only the ids it does not mark `ambiguous` are ' +
          'still to do once the cause is fixed.'
      : `All ${String(tally.total)} id(s) failed — nothing was applied. Inspect ` +
          '`outcomes`: each entry stands alone, so every id is still to do once the ' +
          'cause is fixed.';
  }
  return (
    `${String(tally.failed)} of ${String(tally.total)} ids failed; the rest were ` +
    `applied.${unprovenNote} Inspect \`outcomes\` — each entry stands alone, so only ` +
    'retry the failures.'
  );
}

/**
 * The fbRequest a bulk sweep's WRITES ride on. The http layer stamps
 * `ambiguous` on every fault it classifies (C2), but a caller cancellation is
 * rethrown RAW — and so is anything thrown after a response was read. The bulk
 * runner flags only a GraphApiError stamped `ambiguous`, so a DELETE cut off by
 * a cancel while it was on the wire became a plain failure: an all-cancelled
 * sweep then journaled `failed` and told the model "nothing was applied" for a
 * comment that may be gone for good. A write that rejects with anything but a
 * GraphApiError is therefore re-thrown as the C2 ambiguous error — unless the
 * signal was ALREADY aborted when the call was made, which fetch refuses before
 * a byte is sent, so that id stays a provable failure. Reads are untouched.
 *
 * The read that can confirm the write is the one the api layer stamped on the
 * request (`verifyTool`): a comment hide/delete names facebook_get_comment, a
 * block or unblock names none — no comment read can show a PSID's blocked state.
 */
export function sweepFbRequest(
  fbRequest: FbRequestFn,
  signal?: AbortSignal,
): FbRequestFn {
  return async <T>(req: Parameters<FbRequestFn>[0]) => {
    const isWrite = req.method !== 'GET';
    const cancelledBeforeSend = signal?.aborted === true;
    try {
      return await fbRequest<T>(req);
    } catch (err) {
      if (!isWrite || cancelledBeforeSend || err instanceof GraphApiError) throw err;
      const detail = `${req.method} interrupted: ${errorMessageOf(err)}`;
      throw new GraphApiError(
        `ambiguous write outcome (${detail}) — do NOT retry; verify first`,
        {
          code: 0,
          httpStatus: 0,
          action: ambiguousWriteAction({
            ...(req.verifyTool !== undefined ? { verifyTool: req.verifyTool } : {}),
            detail,
          }),
          cause: err,
        },
      );
    }
  };
}

/** The first Graph error down an error's `cause` chain (a wrapper keeps it there). */
function graphErrorBehind(err: unknown): GraphApiError | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
    if (current instanceof GraphApiError) return current;
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

/**
 * Whether a failed request proves the Page token dead: the core predicate
 * (190, 102, or 100 with a stale-object subcode). The stale-object half only
 * counts when a READ addressed the Page itself — the same 100/33 on a
 * `/{comment_id}` path is Graph saying that COMMENT is gone or out of reach,
 * which a sweep reports per id and which says nothing about the token. A write
 * on the Page's own edge is excluded for the same reason: the unblock DELETE on
 * `/{page_id}/blocked` answers 100/33 for a PSID that is not on the list, and
 * the api layer settles that with a read of the blocked list — the read this
 * fence would otherwise refuse, after evicting a live token and marking every
 * later PSID "not attempted". A Page that really is stale fails that read too.
 */
export function provesPageTokenDead(
  err: unknown,
  req: Parameters<FbRequestFn>[0],
  pageId: string,
): GraphApiError | undefined {
  const graph = graphErrorBehind(err);
  if (graph === undefined || !isPageTokenDead(graph)) return undefined;
  if (graph.code !== 100) return graph;
  if (req.method !== 'GET') return undefined;
  return req.path === `/${pageId}` || req.path.startsWith(`/${pageId}/`)
    ? graph
    : undefined;
}

/**
 * The fbRequest one bulk sweep rides, fenced against a dead Page token. A bulk
 * verb folds every per-id failure into an outcome row (CC-MOD-5), so a 190 in
 * the middle of a sweep never reaches the server's invalidate-on-190 hook and
 * the cached dead token would be replayed to every later call until its TTL.
 * The first request Graph refuses as token-dead therefore evicts the Page token
 * here — including the confirming read behind an "already gone" answer, whose
 * failure the api layer swallows — and every later request of the SAME sweep is
 * refused before it is sent: it could only fail the same way. Such an id is
 * reported as not attempted, a provable (never ambiguous) failure. A rate limit
 * stops the sweep the same way (without evicting the token): later ids are
 * reported as not attempted rather than sent into an exhausted budget.
 *
 * Build ONE fence per sweep, outside `sweepFbRequest`, so the pre-send refusal
 * is not re-read as an interrupted write.
 */
export function pageTokenFence(
  fbRequest: FbRequestFn,
  ctx: ToolContext,
  pageId: string,
): FbRequestFn {
  let dead: GraphApiError | undefined;
  let throttled: GraphApiError | undefined;
  return async <T>(req: Parameters<FbRequestFn>[0]) => {
    if (dead !== undefined) throw notAttemptedError(dead);
    if (throttled !== undefined) throw notAttemptedThrottledError(throttled);
    try {
      return await fbRequest<T>(req);
    } catch (err) {
      const graph = provesPageTokenDead(err, req, pageId);
      if (graph !== undefined && dead === undefined) {
        dead = graph;
        ctx.pages.invalidate(pageId);
      }
      // A rate limit reaches a tool only after the transport spent its own
      // retries: every later request of the sweep rides the same exhausted
      // bucket, so sending it would only deepen the throttle. The token is
      // fine, so nothing is evicted.
      const behind = graphErrorBehind(err);
      if (behind?.action?.category === 'rate_limit') throttled ??= behind;
      throw err;
    }
  };
}

/** The per-id refusal for a request a rate limit kept off the wire. */
function notAttemptedThrottledError(throttle: GraphApiError): GraphApiError {
  const wait = throttle.action?.retryAfterMs;
  const text =
    `Not attempted: Facebook reported a rate limit earlier in this call (Graph ` +
    `code ${String(throttle.code)}), so this id was never sent and nothing changed ` +
    'for it. ' +
    (wait !== undefined
      ? `Wait about ${String(Math.ceil(wait / 1000))} s, then run`
      : 'Wait for the limit to clear, then run') +
    ' the call again for the ids marked not attempted.';
  return new GraphApiError(text, {
    code: throttle.code,
    ...(throttle.subcode !== undefined ? { subcode: throttle.subcode } : {}),
    httpStatus: throttle.httpStatus,
    action: {
      category: 'rate_limit',
      retryable: false,
      ...(wait !== undefined ? { retryAfterMs: wait } : {}),
      operatorText: text,
    },
    cause: throttle,
  });
}

/** The per-id refusal for a request a dead Page token kept off the wire. */
function notAttemptedError(dead: GraphApiError): GraphApiError {
  const text =
    `Not attempted: Facebook rejected the Page token earlier in this call (Graph ` +
    `code ${String(dead.code)}), so this id was never sent and nothing changed for ` +
    'it. The cached token has been dropped; run the call again for the ids marked ' +
    'not attempted.';
  return new GraphApiError(text, {
    code: dead.code,
    ...(dead.subcode !== undefined ? { subcode: dead.subcode } : {}),
    httpStatus: dead.httpStatus,
    action: { category: 'auth', retryable: false, operatorText: text },
    cause: dead,
  });
}

/**
 * The per-id refusal for a comment whose snapshot read Facebook refused. The
 * plan could not show that comment's state, so the approval did not cover it.
 */
export const UNREADABLE_NOT_ACTED_ERROR =
  'Not acted on: Facebook refused to read this comment, so its state was never ' +
  'observed and the plan could not cover it. Nothing changed for this id; check ' +
  'the read error in the preview, then re-plan it on its own.';

/**
 * The preview warning naming every id whose snapshot read Facebook refused
 * (`WriteAction.stateWarnings`). The preview does not echo the before-state, so
 * without this the model would approve a plan believing it covers every id.
 */
export function unreadableWarnings(beforeState: unknown): readonly string[] {
  if (typeof beforeState !== 'object' || beforeState === null) return [];
  const refused = Object.values(beforeState as Record<string, CommentState>).filter(
    (state) => isUnreadableState(state),
  );
  if (refused.length === 0) return [];
  const listed = refused
    .map((state) => `${state.id} (${state.error ?? 'read refused'})`)
    .join('; ');
  return [
    `${String(refused.length)} comment id(s) could not be read, so their state is unknown ` +
      `and applying this plan will NOT act on them: ${listed}.`,
  ];
}

/**
 * The divergence reader a bulk comment verb hands the gate, plus the LAST answer
 * it gave. The gate re-reads immediately before `perform` on a plan-bound apply
 * (and again after an out-of-band confirmation), so that answer is the state the
 * apply was cleared against. An id it marks unreadable was never observed — by
 * the preview either, or the two reads would have diverged — so `perform` must
 * skip it rather than moderate a comment nobody saw.
 */
export function trackedCommentStates(
  fbRequest: FbRequestFn,
  scope: CommentScope,
  commentIds: readonly string[],
  withLikes = false,
): {
  readonly readState: () => Promise<Record<string, CommentState>>;
  readonly unread: (id: string) => boolean;
  readonly stateOf: (id: string) => CommentState | undefined;
  /** Whether `readState` has answered at least once (a plan or divergence read). */
  readonly observed: () => boolean;
} {
  let last: Record<string, CommentState> | undefined;
  return {
    readState: async () => {
      last = await readCommentStates(fbRequest, {
        ...scope,
        commentIds,
        ...(withLikes ? { withLikes } : {}),
      });
      return last;
    },
    unread: (id) => isUnreadableState(last?.[id]),
    stateOf: (id) => last?.[id],
    observed: () => last !== undefined,
  };
}

/** The applied payload of a bulk verb: the tally, the per-id outcomes, the note. */
interface BulkPayload extends BulkTally {
  readonly outcomes: readonly BulkOutcome[];
  readonly note?: string;
}

/** One-line human summary of a per-id bulk result, for the applied payload. */
export function bulkSummary(outcomes: readonly BulkOutcome[]): BulkPayload {
  const tally = tallyBulk(outcomes);
  return {
    ...tally,
    outcomes,
    ...(tally.failed > 0 ? { note: bulkNote(tally) } : {}),
  };
}

/**
 * Tell the write gate what a bulk batch really did (`WriteAction.classifyResult`).
 * A bulk verb never throws on a per-id failure — that is the CC-MOD-5 contract —
 * so without this the gate would journal `applied` for a sweep in which not one
 * id moved, and the journal is exactly what an operator reconciles a mutation
 * against (CC-LIFE-2).
 *
 * A PARTIAL failure deliberately stays `applied`. Some ids DID land, and for
 * `facebook_delete_comment` those comments are gone for good; recording the batch
 * as `failed` would tell that operator the world is untouched, which is the more
 * dangerous of the two possible lies. Which ids landed is in `outcomes`, per id.
 * Only the all-failed batch — where there is provably nothing to reconcile —
 * flips to `failed`.
 */
export function bulkVerdict(payload: BulkPayload): {
  readonly outcome: JournalOutcome;
  readonly applied: boolean;
} {
  // ...and "provably" is the whole licence for that shortcut. An ambiguous id
  // is not proof of an untouched world: the request reached Facebook and only
  // the response was lost, so the write may have landed and there IS something
  // to reconcile. It takes the verdict this package already gives every other
  // unconfirmed write — ATTEMPTED, which `applyPayload` renders `not_applied`
  // with the notice that says verify before retrying, never `failed`.
  if ((payload.ambiguous ?? 0) > 0) return ATTEMPTED_VERDICT;
  return payload.total > 0 && payload.failed === payload.total
    ? { outcome: 'failed', applied: false }
    : { outcome: 'applied', applied: true };
}

/**
 * The warning every bulk moderation preview carries. Names the count and the
 * per-id contract, and states explicitly that no comment text is echoed — the
 * model must call `facebook_get_comment` (which taints) to read a body.
 */
export function bulkPreviewWarnings(count: number, verb: string): readonly string[] {
  return [
    `${String(count)} comment id(s) will be ${verb} one at a time; each id gets its own ` +
      'outcome and a failure on one id does not stop the others.',
    'Comment bodies are untrusted user content and are deliberately NOT echoed in this ' +
      'preview. Read them with facebook_get_comment if you need to verify what you are moderating.',
  ];
}
