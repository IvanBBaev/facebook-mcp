// Error mapping for `tools/call`: turns a thrown error into the redactable
// record of an error ToolResult, and decides when a thrown Graph refusal
// invalidates the Page token a call resolved (the C1 invalidate-on-190 hook).

import {
  errorMessageOf,
  GraphApiError,
  isPageTokenDead,
  SavedRepliesError,
  usageOfGraphError,
  type PageResolver,
} from '../core/index.js';
import { WriteGateError } from '../mcp/index.js';
import { graphErrorFields } from '../tools/index.js';

/**
 * Wrap the shared {@link PageResolver} for ONE call so the hub knows which
 * Page(s) the handler resolved a token for. The registry's cache would otherwise
 * keep serving a Page token Graph has already refused until its TTL expires
 * (15 min), and every retry the model makes in that window fails the same way:
 * no handler reports a dead token back, so the hub does it on their behalf.
 *
 * Invalidating a Page whose token is a configured override is harmless — the
 * registry returns an override before consulting the cache, so nothing is lost.
 */
export function trackResolvedPages(pages: PageResolver): {
  readonly pages: PageResolver;
  readonly resolved: ReadonlySet<string>;
} {
  const resolved = new Set<string>();
  return {
    pages: {
      resolvePage: async (profile) => {
        const page = await pages.resolvePage(profile);
        resolved.add(page.pageId);
        return page;
      },
      invalidate: (pageId) => {
        pages.invalidate(pageId);
      },
    },
    resolved,
  };
}

/**
 * Whether a thrown error proves the resolved Page token worthless: core/auth's
 * {@link isPageTokenDead} (190, 102, or 100 with a stale-object subcode — the
 * resolver cache's own CC-AUTH-7 signal) on the error or anywhere down its
 * `cause` chain, bounded at depth 4. A tool that re-words a Graph refusal into
 * its own error keeps the original as `cause`; reading only the top level would
 * leave that dead token cached for the rest of its TTL. Anything else says
 * nothing about the Page token and leaves the cache alone.
 */
export function invalidatesPageToken(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
    if (isPageTokenDead(current)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/**
 * The compact usage figures of the response a Graph error was raised for — the
 * percentage of each bucket Meta reported — or `undefined` when that response
 * carried none. Only the parsed percentages ship: the raw header bag is
 * unbounded and adds nothing the model can act on.
 */
function usageRecord(err: unknown): Record<string, number> | undefined {
  const snapshot = usageOfGraphError(err);
  if (snapshot === undefined) return undefined;
  const usage: Record<string, number> = {};
  if (snapshot.appUsagePct !== undefined) usage['appUsagePct'] = snapshot.appUsagePct;
  if (snapshot.businessUseCasePct !== undefined) {
    usage['businessUseCasePct'] = snapshot.businessUseCasePct;
  }
  if (snapshot.adsInsightsThrottlePct !== undefined) {
    usage['adsInsightsThrottlePct'] = snapshot.adsInsightsThrottlePct;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * Turn a thrown error into a redactable record for the error `ToolResult`.
 * `WriteGateError` and `GraphApiError` surface their machine-readable fields so
 * the model can self-correct; everything else degrades to a bare message. The
 * record is redacted downstream by {@link shapeResult}, never here.
 *
 * The F06 classification is flattened onto the record rather than nested: the
 * operator SENTENCE lands on `action` as before, and the decisions the model has
 * to make — is this worth retrying, what should it run next, how long is the
 * cool-down — ship as their own fields. Prose alone forces the model to infer
 * "do NOT retry" from wording; `retryable: false` and `nextTool` state it.
 */
export function buildErrorRecord(err: unknown): Record<string, unknown> {
  const message = errorMessageOf(err);
  if (err instanceof WriteGateError) {
    return { error: message, code: err.code, tool: err.tool, tier: err.tier };
  }
  if (err instanceof SavedRepliesError) {
    return { error: message, code: err.code };
  }
  if (err instanceof GraphApiError) {
    const action = err.action;
    const usage = usageRecord(err);
    return {
      error: message,
      // Graph's identity plus its human-readable refusal, when it sent one: on
      // an ads or publishing rejection `error` is the generic "Invalid
      // parameter" and userTitle/userMessage are the only reason the model can
      // act on. Shared with the package-local envelopes, which bound Meta's
      // text the same way so a pathological body cannot dominate the record.
      ...graphErrorFields(err),
      ...(action !== undefined
        ? {
            action: action.operatorText,
            category: action.category,
            retryable: action.retryable,
            ...(action.nextTool !== undefined ? { nextTool: action.nextTool } : {}),
            ...(action.retryAfterMs !== undefined
              ? { retryAfterMs: action.retryAfterMs }
              : {}),
          }
        : {}),
      // The usage figures of the refusing response. A throttle sends the model
      // to facebook_usage, but that tool probes `/me` — a different call that
      // may land in a different bucket, or be refused by the same throttle — so
      // only this response names the bucket that refused THIS call.
      ...(usage !== undefined ? { usage } : {}),
    };
  }
  return { error: message };
}
