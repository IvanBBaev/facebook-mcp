// The Page's blocked-users list in the `moderation` package:
// facebook_block_user and facebook_unblock_user.

import { z } from 'zod';

import { MAX_BULK_IDS, setBlocked } from '../../api/comments.js';
import { defineTool } from '../../mcp/index.js';

import { executeWrite, writeArgs } from '../shared.js';

import {
  REVERSIBLE_ANNOTATIONS,
  TIERS,
  classifyWriteFailure,
  scopeOf,
} from './common.js';
import { sweepFbRequest, pageTokenFence, bulkSummary, bulkVerdict } from './bulk.js';

const psidsArg = z
  .array(z.string().min(1))
  .min(1)
  .max(MAX_BULK_IDS)
  .describe(
    `Page-scoped user IDs (PSIDs) — 1 to ${String(MAX_BULK_IDS)} per call. A PSID is the ` +
      'per-Page id from a comment author or a conversation, NOT a public profile ID or a username.',
  );

// -------------------------------------------------------------------------
// facebook_block_user / facebook_unblock_user (reversible, bulk)
// -------------------------------------------------------------------------
export function createBlockedTool(blocked: boolean) {
  const name = blocked ? 'facebook_block_user' : 'facebook_unblock_user';
  const verb = blocked ? 'blocked' : 'unblocked';
  const inverse = blocked ? 'facebook_unblock_user' : 'facebook_block_user';
  return defineTool({
    name,
    title: blocked ? 'Block users' : 'Unblock users',
    description: blocked
      ? "Add up to 50 PSIDs to the Page's blocked list: they can no longer comment " +
        'on the Page or message it. Fully reversible with facebook_unblock_user, and ' +
        'blocking an already-blocked user changes nothing, so this is safe to repeat. ' +
        'Each PSID gets its own outcome. Needs a PAGE token with ' +
        'pages_manage_engagement (blocking also affects messaging) and the MODERATE task.'
      : "Remove up to 50 PSIDs from the Page's blocked list, restoring their ability " +
        'to comment and message. The inverse of facebook_block_user; unblocking a user ' +
        'who was never blocked is reported as done rather than as an error. Each PSID ' +
        'gets its own outcome. Needs a PAGE token with pages_manage_engagement and the ' +
        'MODERATE task.',
    inputSchema: z.object({ ...writeArgs, psids: psidsArg }),
    annotations: REVERSIBLE_ANNOTATIONS,
    writeTier: TIERS[name],
    // `psids` are recipient identities AND an array, so they are excluded
    // twice over; the line records that a block or unblock was armed on this
    // Page, which is the part an operator can act on.
    logFields: ['profile', 'apply', 'plan_id'],
    handler: async (input, ctx) => {
      const resolved = await ctx.pages.resolvePage(input.profile);
      const scope = scopeOf(ctx, resolved);
      return executeWrite(ctx, {
        tool: name,
        tier: TIERS[name],
        pageId: resolved.pageId,
        resolvedPage: resolved,
        params: { psids: input.psids },
        ...(input.apply !== undefined ? { apply: input.apply } : {}),
        ...(input.plan_id !== undefined ? { planId: input.plan_id } : {}),
        summary:
          `${blocked ? 'Block' : 'Unblock'} ${String(new Set(input.psids).size)} user(s) on Page ` +
          `${resolved.pageId}. Reversible with ${inverse}.`,
        warnings: [
          `${String(new Set(input.psids).size)} PSID(s) will be ${verb}; each one gets its own ` +
            'outcome, so a bad PSID does not fail the rest.',
          blocked
            ? 'A blocked user can no longer comment on or message the Page.'
            : 'An unblocked user can comment on and message the Page again.',
        ],
        notPerformedNotice: `This was a dry run — nobody was ${verb}.`,
        perform: async () =>
          bulkSummary(
            await setBlocked(
              pageTokenFence(
                sweepFbRequest(ctx.fbRequest, ctx.signal),
                ctx,
                resolved.pageId,
              ),
              {
                ...scope,
                pageId: resolved.pageId,
                psids: input.psids,
                blocked,
              },
            ),
          ),
        // Blocking is one POST for the whole list, so a lost answer rejects
        // the call rather than landing per id — and every PSID may be blocked.
        classifyOutcome: classifyWriteFailure,
        classifyResult: bulkVerdict,
        metadata: { psids: input.psids, blocked },
      });
    },
  });
}
