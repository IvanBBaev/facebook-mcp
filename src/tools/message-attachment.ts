// One outbound Messenger attachment, shared by `facebook_send_message` and
// `facebook_private_reply`: the argument shape, its local validation and the
// preview warning for a URL Meta fetches itself.

import { z } from 'zod';

import { MediaSourceError, resolveRemoteMediaUrl } from '../api/media-photos.js';
import type { OutboundAttachment } from '../api/messaging.js';

const ATTACHMENT_TYPES = ['image', 'audio', 'video', 'file'] as const;
const MAX_ATTACHMENT_URL_CHARS = 2048;

export const attachmentTypeArg = z
  .enum(ATTACHMENT_TYPES)
  .describe('Attachment kind: image, audio, video or file (for example a PDF).');

export const attachmentUrlArg = z
  .string()
  .url()
  .max(MAX_ATTACHMENT_URL_CHARS)
  .describe(
    'A public https:// URL Meta fetches itself (no credentials in it). Meta gives up ' +
      'after about 10 s (75 s for video); images up to 8 MB, other files up to 25 MB.',
  );

export const attachmentArg = z
  .object({
    type: attachmentTypeArg,
    url: attachmentUrlArg.optional(),
    attachment_id: z
      .string()
      .regex(/^\d{1,32}$/, 'attachment_id must be the numeric id an upload returned.')
      .optional()
      .describe(
        'A reusable attachment id from facebook_upload_message_attachment (valid for ' +
          'about 90 days, this Page only).',
      ),
  })
  .strict()
  .describe(
    'ONE attachment instead of text: exactly one of url / attachment_id. A message ' +
      'carries text or one attachment, never both.',
  );

export type AttachmentArg = z.infer<typeof attachmentArg>;

export const ATTACHMENT_SOURCE_MESSAGE =
  'Nothing was sent: give the attachment exactly one of `url` or `attachment_id`.';

export const ATTACHMENT_FETCH_WARNING =
  'Meta fetches the attachment URL when the message is sent: it must be public and ' +
  'answer within 10 s (75 s for video); images ≤ 8 MB, other files ≤ 25 MB.';

/**
 * Validates an attachment URL locally (HTTPS, no embedded credentials) so a bad
 * one never reaches Meta. The URL itself is not echoed back: it can carry a
 * signed query string.
 */
export function checkedAttachmentUrl(raw: string, nothingDone: string): string {
  try {
    return resolveRemoteMediaUrl(raw);
  } catch (err) {
    if (err instanceof MediaSourceError) {
      throw new Error(
        `${nothingDone}: the attachment URL must be a public https:// URL without ` +
          `credentials (${err.reason}).`,
        { cause: err },
      );
    }
    throw err;
  }
}

/** The message's attachment, validated; `undefined` for a text message. */
export function outboundAttachmentOf(
  arg: AttachmentArg | undefined,
): OutboundAttachment | undefined {
  if (arg === undefined) return undefined;
  if ((arg.url === undefined) === (arg.attachment_id === undefined)) {
    throw new Error(ATTACHMENT_SOURCE_MESSAGE);
  }
  return arg.url !== undefined
    ? { type: arg.type, url: checkedAttachmentUrl(arg.url, 'Nothing was sent') }
    : { type: arg.type, attachmentId: arg.attachment_id ?? '' };
}
