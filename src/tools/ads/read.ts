// Read tools of the `ads` package: the three cursor-paged listings, the
// single-object read and the placement preview.

import { z } from 'zod';

import { GraphApiError, classifyGraphError } from '../../core/index.js';
import type { ToolContext, ToolResult } from '../../core/index.js';
import {
  ADS_RATE_LIMIT_NOTE,
  EFFECTIVE_STATUS_NOTE,
  type AdLevel,
  getAdObject,
  listAdObjects,
  resolveAdAccountId,
} from '../../api/ads-read.js';
import {
  DEFAULT_PREVIEW_FORMAT,
  PREVIEW_FORMATS,
  generateAdPreview,
  normalizeObjectStoryId,
  type PreviewSource,
} from '../../api/ads-preview.js';
import { defineTool } from '../../mcp/index.js';
import { afterArg, limitArg, shapeFor } from '../shared.js';
import { adAccountIdArg, signalOf } from '../ads-shared.js';
import {
  AD_OBJECT_ID_SHAPE,
  READ_ONLY,
  fieldsArg,
  levelArg,
  objectIdArg,
} from './common.js';

// ---------------------------------------------------------------------------
// Input fields
// ---------------------------------------------------------------------------

const previewSourceArg = z
  .object({
    kind: z
      .enum(['ad', 'creative', 'post'])
      .describe(
        'ad ⇒ an existing ad (`id` from facebook_list_ads); creative ⇒ an existing ad creative; ' +
          'post ⇒ a Page post rendered as an ad (`id` in the "<page-id>_<post-id>" form), ' +
          'read through the ad account.',
      ),
    id: z
      .string()
      .trim()
      .min(1)
      .regex(
        AD_OBJECT_ID_SHAPE,
        'Expected a numeric ad / creative id, or "<page-id>_<post-id>" for a post — not a URL.',
      )
      .describe('The ad, creative or post id.'),
  })
  .strict()
  .describe('What to preview.');

const effectiveStatusArg = z
  .array(z.string().trim().min(1))
  .min(1)
  .max(12)
  .optional()
  .describe(
    'Filter applied SERVER-side by Graph, e.g. ["ACTIVE"] or ["PAUSED","CAMPAIGN_PAUSED"]. Graph\'s own default already hides archived and deleted objects, so pass ["ARCHIVED"] explicitly to see them.',
  );

/** The fields the three listing tools share, spread into each tool's own object. */
const listAdArgs = {
  ad_account_id: adAccountIdArg,
  limit: limitArg,
  after: afterArg,
  effective_status: effectiveStatusArg,
  fields: fieldsArg,
} as const;

// ---------------------------------------------------------------------------
// Parsed-input shapes
// ---------------------------------------------------------------------------

// Optional members are written `T | undefined` rather than a bare `?:` because
// `exactOptionalPropertyTypes` makes zod's inferred `{ x?: T | undefined }`
// incompatible with `{ x?: T }`.

interface ListAdInput {
  readonly ad_account_id?: string | undefined;
  readonly limit?: number | undefined;
  readonly after?: string | undefined;
  readonly effective_status?: readonly string[] | undefined;
  readonly fields?: string | undefined;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * One cursor page of campaigns / ad sets / ads. The three listing tools differ
 * only in the level they pin, so they share this handler — a per-level copy
 * would be three chances for the effective-status contract to drift.
 */
async function listLevel(
  ctx: ToolContext,
  input: ListAdInput,
  level: AdLevel,
): Promise<ToolResult> {
  const accountId = resolveAdAccountId(input.ad_account_id, ctx.settings.adAccountId);
  const result = await listAdObjects(ctx.fbRequest, {
    accountId,
    level,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.after !== undefined ? { after: input.after } : {}),
    ...(input.effective_status !== undefined
      ? { effectiveStatus: input.effective_status }
      : {}),
    ...(input.fields !== undefined ? { fields: input.fields } : {}),
    ...signalOf(ctx),
  });
  return shapeFor(ctx, result);
}

/**
 * Build the five plain read tools. Called once per `createAdsPackage()` so every
 * package instance gets its own tool objects, exactly as before the split.
 */
export function createReadTools() {
  // None of the four plain reads below (the three listings and
  // facebook_get_ad_object) declares `logFields`. Their arguments are the ad
  // account — a constant the operator configured — plus paging and field
  // selection, so the per-call line could only report that the configured
  // account was read. Silence is the correct posture there; a padded allowlist
  // is worse than none.
  const listCampaigns = defineTool({
    name: 'facebook_list_campaigns',
    title: 'List Campaigns',
    description:
      'List campaigns under one ad account, a cursor page at a time. Each record ' +
      `carries the delivery truth, not just the configuration: ${EFFECTIVE_STATUS_NOTE} ` +
      'Budgets come back as integer `*_minor` fields in the account currency ' +
      '(USD 1000 = 10.00; a zero-decimal currency such as JPY has no sub-unit, so ' +
      '1000 = 1000), never as floats. Filter server-side with effective_status; ' +
      'archived and deleted campaigns are hidden by Graph unless you ask for them. ' +
      `${ADS_RATE_LIMIT_NOTE}`,
    inputSchema: z.object(listAdArgs),
    annotations: READ_ONLY,
    handler: async (input, ctx) => listLevel(ctx, input, 'campaign'),
  });

  const listAdsets = defineTool({
    name: 'facebook_list_adsets',
    title: 'List Ad Sets',
    description:
      'List ad sets under one ad account, a cursor page at a time. Ad sets are ' +
      'where budget, schedule and targeting live, so this is the level most ' +
      'budget questions are answered at. Each record carries `effective_status` ' +
      'plus a derived `delivering` flag and a one-line explanation — an ad set ' +
      'with status ACTIVE under a PAUSED campaign is NOT delivering, and the ' +
      'record says exactly that. Budgets are integer `*_minor` fields in the ' +
      'account currency. Targeting specs are omitted from the default field set ' +
      'because they are large; request them with `fields` if you need them.',
    inputSchema: z.object(listAdArgs),
    annotations: READ_ONLY,
    handler: async (input, ctx) => listLevel(ctx, input, 'adset'),
  });

  const listAds = defineTool({
    name: 'facebook_list_ads',
    title: 'List Ads',
    description:
      'List individual ads under one ad account, a cursor page at a time. This is ' +
      'the level where review outcomes surface: `effective_status` values such as ' +
      'PENDING_REVIEW, DISAPPROVED and WITH_ISSUES appear here, each with a ' +
      'one-line explanation, so a rejected ad is never reported as "running". ' +
      'Ads have no budget of their own — budgets live on the ad set (or the ' +
      'campaign under campaign budget optimisation). Creative blobs are omitted ' +
      'from the default field set.',
    inputSchema: z.object(listAdArgs),
    annotations: READ_ONLY,
    handler: async (input, ctx) => listLevel(ctx, input, 'ad'),
  });

  const getAdObjectTool = defineTool({
    name: 'facebook_get_ad_object',
    title: 'Get Ad Object',
    description:
      'Read one campaign, ad set or ad by id. Pass `level` when you know it — the ' +
      'read then uses the richer per-level field set instead of the fields common ' +
      'to every ads object. The record carries `effective_status`, a `delivering` ' +
      'flag and an explanation of what that status means, and budgets as integer ' +
      '`*_minor` values in the account currency. Use `fields` to request anything ' +
      'outside the defaults (targeting, creative), remembering that large blobs ' +
      'are what truncate a result.',
    inputSchema: z.object({
      object_id: objectIdArg,
      level: levelArg,
      fields: fieldsArg,
    }),
    annotations: READ_ONLY,
    handler: async (input, ctx) => {
      const result = await getAdObject(ctx.fbRequest, {
        objectId: input.object_id,
        ...(input.level !== undefined ? { level: input.level } : {}),
        ...(input.fields !== undefined ? { fields: input.fields } : {}),
        ...signalOf(ctx),
      });
      return shapeFor(ctx, result);
    },
  });

  // No `logFields`: the arguments are an object id and a placement, and the
  // answer carries a short-lived view token that must never reach a log line.
  const getAdPreview = defineTool({
    name: 'facebook_get_ad_preview',
    title: 'Get Ad Preview',
    description:
      'Show how an existing ad, an existing ad creative, or a Page post used as an ' +
      'ad would render in one placement (`ad_format`, default MOBILE_FEED_STANDARD). ' +
      'Creates nothing and spends nothing. Returns `iframeSrc`, a facebook.com link ' +
      'to open in a browser, valid for about 24 hours; it carries a view token, so ' +
      'do not post it publicly. A post preview needs the ad account ' +
      '(`ad_account_id` or FB_AD_ACCOUNT_ID). Not every creative renders in every ' +
      'placement; Meta refuses an unsupported pairing.',
    inputSchema: z.object({
      source: previewSourceArg,
      ad_format: z
        .enum(PREVIEW_FORMATS)
        .optional()
        .describe(`Placement to render. Omitted ⇒ ${DEFAULT_PREVIEW_FORMAT}.`),
      ad_account_id: adAccountIdArg,
    }),
    annotations: READ_ONLY,
    handler: async (input, ctx) => {
      let source: PreviewSource;
      if (input.source.kind === 'post') {
        source = {
          kind: 'post',
          objectStoryId: normalizeObjectStoryId(input.source.id),
          accountId: resolveAdAccountId(input.ad_account_id, ctx.settings.adAccountId),
        };
      } else {
        if (!/^\d+$/.test(input.source.id)) {
          throw new GraphApiError(
            `Invalid ${input.source.kind} id: "${input.source.id}". Ad and creative ids are digits only.`,
            {
              code: 100,
              httpStatus: 400,
              action: classifyGraphError({ code: 100, message: 'invalid id' }),
            },
          );
        }
        source =
          input.source.kind === 'ad'
            ? { kind: 'ad', adId: input.source.id }
            : { kind: 'creative', creativeId: input.source.id };
      }
      const preview = await generateAdPreview(ctx.fbRequest, {
        source,
        adFormat: input.ad_format ?? DEFAULT_PREVIEW_FORMAT,
        nowMs: ctx.clock.now(),
        ...signalOf(ctx),
      });
      return shapeFor(ctx, { source: input.source, ...preview });
    },
  });

  return { listCampaigns, listAdsets, listAds, getAdObjectTool, getAdPreview };
}
