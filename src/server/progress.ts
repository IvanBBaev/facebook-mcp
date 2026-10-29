// Progress notifications: binds a request's `_meta.progressToken` into the
// ProgressReporter a long-running tool calls while it works.

import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  Notification,
  Request,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';

import { errorMessageOf, type Logger, type ProgressReporter } from '../core/index.js';

/**
 * The per-request argument the SDK hands a `tools/call` handler, spelled with
 * the generic parameters a `Server` built without type arguments produces. It
 * carries `_meta` (the caller's request metadata, where a `progressToken` rides)
 * and `sendNotification`, the request-scoped emitter that tags each notification
 * with the originating request id.
 */
type ToolCallExtra = RequestHandlerExtra<
  ServerRequest | Request,
  ServerNotification | Notification
>;

/**
 * Bind the request's `_meta.progressToken` into the {@link ProgressReporter} a
 * long upload calls while it works (CC-MCP-1).
 *
 * The token is what associates a `notifications/progress` frame with the call it
 * belongs to, so a client that supplied none gets NO reporter at all rather than
 * an emitter with nothing to address: `ToolContext.reportProgress` stays absent
 * and every consumer's `ctx.reportProgress?.(…)` degrades to a no-op. Inventing
 * a token here would emit frames the client must discard (the SDK's client-side
 * dispatcher reports an unknown token as a protocol error).
 *
 * Delivery is strictly best-effort and never observable by the tool. The
 * reporter is synchronous by contract, so the send is started and detached: the
 * async wrapper turns BOTH a synchronous throw and a rejected send into the same
 * rejection, which is logged at debug level to stderr and swallowed. A client
 * that closed its stream mid-upload, or a transport that cannot frame the
 * notification, must not be able to fail a publish that otherwise succeeded —
 * and an unhandled rejection here would take the whole process down.
 */
export function progressReporterFor(
  extra: ToolCallExtra,
  logger: Logger,
): ProgressReporter | undefined {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return undefined;

  return (update) => {
    void (async () =>
      await extra.sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: update.progress,
          ...(update.total !== undefined ? { total: update.total } : {}),
          ...(update.message !== undefined ? { message: update.message } : {}),
        },
      }))().catch((err: unknown) => {
      logger.debug('progress notification failed', {
        error: errorMessageOf(err),
      });
    });
  };
}
