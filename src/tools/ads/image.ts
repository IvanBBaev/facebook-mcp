// `facebook_upload_ad_image`: add a local image to the ad account's image
// library and return its hash; creates no ad.

import { z } from 'zod';

import type { ToolAnnotations } from '../../core/index.js';
import { resolveAdAccountId } from '../../api/ads-read.js';
import {
  AD_IMAGE_LIBRARY_NOTE,
  AD_IMAGE_RERUN_NOTE,
  MAX_AD_IMAGE_BYTES,
  assertAdImageExtension,
  uploadAdImage,
} from '../../api/ads-media.js';
import type { AdImageUploadOutcome } from '../../api/ads-media.js';
import {
  MediaSourceError,
  digestLocalMedia,
  resolveLocalMediaPath,
} from '../../api/media-photos.js';
import type { LocalMediaOptions } from '../../api/media-photos.js';
import {
  APPLIED_VERDICT,
  ATTEMPTED_VERDICT,
  defineTool,
  type WriteResultVerdict,
} from '../../mcp/index.js';
import {
  applyArg,
  confirmTokenArg,
  executeWrite,
  gateArgs,
  planIdArg,
} from '../shared.js';
import {
  ADS_TERMS_NOTE,
  accountForWrite,
  adAccountIdArg,
  classifyUpdateFailure,
} from '../ads-shared.js';

/**
 * `facebook_upload_ad_image` (v2 ads §2). It adds a library entry and overwrites
 * nothing; Meta deduplicates by content hash, so a repeat lands on the same
 * entry.
 */
const UPLOAD_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** An upload landed only when the answer carried the image's hash. */
function adImageVerdict(outcome: AdImageUploadOutcome): WriteResultVerdict {
  return outcome.image !== undefined ? APPLIED_VERDICT : ATTEMPTED_VERDICT;
}

/**
 * `facebook_upload_ad_image` (v2 ads §2). The dry run resolves the file under
 * `FB_MEDIA_DIR` and binds its size and SHA-256; the apply re-reads it and
 * refuses bytes that no longer match.
 */
export const uploadAdImageTool = defineTool({
  name: 'facebook_upload_ad_image',
  title: 'Upload Ad Image',
  description:
    "Upload one local image (JPEG, PNG, GIF, BMP, TIFF or WEBP, at most 30 MB, inside FB_MEDIA_DIR) to the ad account's image library and return its hash, which creatives reference it by. Creates no ad and changes no delivery. Plan-first: without apply:true this returns a preview (file, size, account) and uploads NOTHING; applying requires apply:true plus the plan_id from that preview. Uploads are deduplicated by content hash, so re-running one is safe. " +
    ADS_TERMS_NOTE,
  inputSchema: z.object({
    ad_account_id: adAccountIdArg,
    file_path: z
      .string()
      .min(1)
      .describe(
        'The image file, relative to FB_MEDIA_DIR (or an absolute path inside it).',
      ),
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('The name the image gets in the library. Omitted ⇒ the file name.'),
    apply: applyArg,
    plan_id: planIdArg,
    confirm_token: confirmTokenArg,
  }),
  annotations: UPLOAD_ANNOTATIONS,
  writeTier: 'reversible',
  logFields: ['ad_account_id', 'apply', 'plan_id'],
  handler: async (input, ctx) => {
    const accountId = resolveAdAccountId(input.ad_account_id, ctx.settings.adAccountId);
    // An upload spends nothing, so only a disabled account refuses it.
    const account = await accountForWrite(ctx, accountId, { stopsDelivery: true });
    const resolvedAccount = account?.id ?? accountId;

    const opts: LocalMediaOptions = {
      ...(ctx.settings.mediaDir !== undefined ? { mediaDir: ctx.settings.mediaDir } : {}),
      maxBytes: MAX_AD_IMAGE_BYTES,
    };
    const resolved = await resolveLocalMediaPath(input.file_path, opts);
    assertAdImageExtension(input.file_path, resolved.filename);
    const digest = await digestLocalMedia(resolved, input.file_path, opts);
    const bound = { bytes: digest.bytes, sha256: digest.sha256 };

    // The hash exists only once Graph answers; the gate journals after
    // `perform` returns, so the upload fills it in here.
    const metadata: Record<string, unknown> = {
      accountId: resolvedAccount,
      bytes: bound.bytes,
    };
    let cancelledBeforeSend = false;

    return executeWrite(ctx, {
      tool: 'facebook_upload_ad_image',
      tier: 'reversible',
      params: {
        ad_account_id: resolvedAccount,
        file_path: resolved.path,
        byte_length: bound.bytes,
        sha256: bound.sha256,
        ...(input.name !== undefined ? { name: input.name } : {}),
      },
      ...gateArgs(input),
      summary:
        `Upload ${resolved.filename} (${String(bound.bytes)} bytes, sha256 ` +
        `${bound.sha256.slice(0, 12)}) to the image library of ${resolvedAccount}` +
        (input.name !== undefined ? ` as "${input.name}"` : ''),
      warnings: [AD_IMAGE_LIBRARY_NOTE, AD_IMAGE_RERUN_NOTE],
      notPerformedNotice: 'This was a dry run — nothing was uploaded.',
      perform: async (): Promise<Record<string, unknown>> => {
        cancelledBeforeSend = ctx.signal?.aborted === true;
        const outcome = await uploadAdImage(ctx.fbRequest, opts, {
          accountId: resolvedAccount,
          requested: input.file_path,
          bound,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        });
        if (outcome.image !== undefined) metadata.hash = outcome.image.hash;
        return {
          ...outcome,
          ...(outcome.image === undefined
            ? {
                unconfirmed:
                  'Graph answered without an image hash, so the upload is unconfirmed. ' +
                  AD_IMAGE_RERUN_NOTE,
              }
            : {}),
        };
      },
      classifyResult: (result: Record<string, unknown>) =>
        adImageVerdict(result as unknown as AdImageUploadOutcome),
      // A local refusal (the file changed, or is not an image) happens before the
      // POST, so nothing can have landed.
      classifyOutcome: (err) =>
        cancelledBeforeSend || err instanceof MediaSourceError
          ? 'failed'
          : classifyUpdateFailure(err),
      metadata,
    });
  },
});
