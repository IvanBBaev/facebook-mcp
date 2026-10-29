// MCP form elicitation: binds the live session's elicitation capability into
// the shape the out-of-band Confirmer expects (B1 / CC-MCP-6).

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import type { ConfirmationRequest } from '../core/index.js';
import type { ElicitCapability } from '../mcp/index.js';

/**
 * Bind the live MCP session's elicitation capability into the shape the
 * {@link Confirmer} expects (B1 / CC-MCP-6).
 *
 * The client is asked to tick one boolean rather than to type the action back,
 * because the prompt must be answerable by a human who is NOT reading the model
 * transcript — that is the whole point of an out-of-band gate. Anything other
 * than an explicit `accept` + `confirm:true` is a refusal: a client that returns
 * `accept` with no content has not confirmed anything.
 *
 * A client without elicitation support makes this throw, which `createConfirmer`
 * catches and converts into the operator-token route. That is deliberate — the
 * fall-through lives in one place and is reported truthfully as
 * `method: 'operator_token'` or `'denied'`, never as an elicitation.
 */
export function elicitVia(server: Server): ElicitCapability {
  return async (request: ConfirmationRequest) => {
    // `Server.elicitInput` demands `elicitation.form` specifically, not merely
    // `elicitation` — a client advertising a bare `elicitation: {}` would sail
    // past a looser check and then throw from inside the SDK, which is still
    // fail-closed but reports the wrong reason. Probe what the SDK probes.
    if (server.getClientCapabilities()?.elicitation?.form === undefined) {
      throw new Error('the connected client does not support MCP form elicitation');
    }
    const result = await server.elicitInput({
      message: elicitationPrompt(request),
      requestedSchema: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            title: 'Perform this action',
            description: `Tick to authorize this ${request.tier} write. Leave unticked to refuse.`,
          },
        },
        required: ['confirm'],
      },
    });
    if (result.action !== 'accept') {
      return {
        confirmed: false,
        note: `the operator ${result.action === 'decline' ? 'declined' : 'cancelled'} the confirmation prompt`,
      };
    }
    if (result.content?.confirm !== true) {
      return { confirmed: false, note: 'the operator did not tick the confirmation box' };
    }
    return { confirmed: true };
  };
}

/** The human-facing text of the confirmation prompt. Carries no secret. */
function elicitationPrompt(request: ConfirmationRequest): string {
  const lines = [`${request.tool} — ${request.reason}.`, '', request.summary];
  if (request.planId !== undefined) lines.push('', `Plan: ${request.planId}`);
  return lines.join('\n');
}
