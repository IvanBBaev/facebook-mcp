// Messenger conversation plumbing for the `messages` package (task V08, `api` layer).
//
// Wire facts encoded here (doc 03 "Messenger", doc 06 messages rows):
//   * conversations — `GET /{page-id}/conversations?platform=messenger`. The
//     `platform` param is pinned EXPLICITLY instead of trusting the API default
//     (G-RUN-2), so a Page with a linked Instagram account can never silently
//     return IG threads under a Messenger tool name.
//   * thread        — `GET /{conversation-id}/messages`, newest-first as Graph
//     returns it. Ordering is best-effort and the snapshot is poll-based, never
//     a stream (CC-MSG-5).
//   * send          — `POST /{page-id}/messages` with `messaging_type=RESPONSE`,
//     `recipient={id}` and `message={text}`. Requires `pages_messaging` plus the
//     `MESSAGING` task on the Page.
//
// The module is SHAPING-ONLY and deliberately does not touch the taint envelope:
// `taint()` lives in the `mcp` layer, which `api` may not import. So every field
// carrying user-generated content (message bodies, conversation snippets,
// participant names, attachment file names) is returned as a plainly documented
// RAW string, and `../tools/messages.ts` is responsible for wrapping it before it
// reaches the model. Nothing here is model-facing prose except the operator
// guidance constants, which exist so the same wording is used by the client-side
// window refusal and by the mapped Graph error.
//
// Corner cases owned here:
//   * CC-MSG-1 — the 24-hour standard messaging window, checked client-side where
//     a last-inbound timestamp is known and mapped to actionable guidance when
//     Graph rejects the send.
//   * CC-MSG-2 — an ambiguous send outcome is classified `attempted`, never
//     `failed`, and is never retried automatically.
//   * CC-MSG-3 — a blocked / deleted recipient becomes a terminal, non-retryable
//     "recipient unavailable".
//   * CC-MSG-6 — attachments are summarised as typed placeholders with their
//     metadata; binary payloads are never inlined and the CDN URLs are flagged
//     as short-lived.

import { GraphApiError } from '../core/index.js';
import type {
  ErrorAction,
  FbRequestFn,
  JournalOutcome,
  JsonRequest,
  Page,
  PageRequest,
} from '../core/index.js';
import { fetchPage, type EdgeRequest } from './shared.js';

// ---------------------------------------------------------------------------
// 1. Wire constants
// ---------------------------------------------------------------------------

/** The standard messaging window: 24 hours from the person's last message. */
export const STANDARD_MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The `platform` value pinned on every conversation read (G-RUN-2). Passing it
 * explicitly is the whole point: the Graph default has changed before and a
 * Messenger tool must never return Instagram threads.
 */
export const PLATFORM_MESSENGER = 'messenger';

/** The only `messaging_type` this server sends: a reply inside the 24h window. */
export const MESSAGING_TYPE_RESPONSE = 'RESPONSE';

/** Fields read for a conversation node — polling-friendly (doc 06). */
export const CONVERSATION_FIELDS =
  'id,snippet,updated_time,unread_count,message_count,can_reply,participants{id,name}';

/** Fields read for a message node, including attachment metadata (CC-MSG-6). */
export const MESSAGE_FIELDS =
  'id,created_time,from{id,name},to{id,name},message,sticker,' +
  'attachments{id,mime_type,name,size,image_data,video_data,file_url},' +
  'shares{link,name}';

/**
 * What a caller can actually do once the 24-hour window has closed. Used both by
 * the client-side refusal and by the mapped Graph window error so the model never
 * sees two different explanations of the same rule.
 */
export const MESSAGE_TAG_GUIDANCE =
  'Outside the 24-hour standard messaging window a plain RESPONSE message is ' +
  'rejected by Facebook: a message tag would be required. Every message tag now ' +
  'hard-fails except HUMAN_AGENT, which needs a separate App Review approval and ' +
  'is NOT supported by this server — so there is no tag this tool can send. ' +
  'Options: (1) wait until the person messages the Page again, which reopens the ' +
  'window; (2) if they commented in the last 7 days, reply privately with ' +
  'facebook_private_reply; (3) answer publicly on the post. Never resend blindly.';

/** Honest description of what a conversation listing is (CC-MSG-5). */
export const POLLING_NOTE =
  'Poll-based snapshot, not a stream: messages that arrived and were handled ' +
  'between two calls are not replayed. Diff `updatedTime` / `unreadCount` against ' +
  'your previous call and re-read the affected thread; ordering is best-effort.';

/** Why attachment URLs may already be dead by the time they are used (CC-MSG-6). */
export const ATTACHMENT_URL_NOTE =
  'Attachments are summarised as typed placeholders — binary payloads are never ' +
  'inlined. Attachment URLs are CDN links carrying a short-lived token and expire; ' +
  're-read the thread to obtain a fresh one rather than caching them.';

// ---------------------------------------------------------------------------
// 2. Raw wire shapes (parsed defensively — any field may be absent, CC-NET-2)
// ---------------------------------------------------------------------------

/** A Graph list edge as returned inside a field expansion. */
export interface RawEdge<T> {
  readonly data?: readonly T[];
}

/** A conversation participant / message sender. `name` is USER-CONTROLLED. */
export interface RawParticipant {
  readonly id?: string;
  readonly name?: string;
  /** Present on some threads; deliberately dropped when shaping (PII). */
  readonly email?: string;
}

export interface RawConversation {
  readonly id?: string;
  /** Preview of the latest message — USER-CONTROLLED text. */
  readonly snippet?: string;
  readonly updated_time?: string;
  readonly unread_count?: number;
  readonly message_count?: number;
  readonly can_reply?: boolean;
  readonly participants?: RawEdge<RawParticipant>;
}

/** Image/video sub-object of an attachment. */
export interface RawMediaData {
  readonly width?: number;
  readonly height?: number;
  readonly url?: string;
  readonly preview_url?: string;
}

export interface RawAttachment {
  readonly id?: string;
  readonly mime_type?: string;
  /** File name — USER-CONTROLLED text. */
  readonly name?: string;
  readonly size?: number;
  readonly image_data?: RawMediaData;
  readonly video_data?: RawMediaData;
  readonly file_url?: string;
}

export interface RawShare {
  readonly link?: string;
  /** Shared-link title — USER-CONTROLLED text. */
  readonly name?: string;
}

export interface RawMessage {
  readonly id?: string;
  readonly created_time?: string;
  readonly from?: RawParticipant;
  readonly to?: RawEdge<RawParticipant>;
  /** The message body — USER-CONTROLLED text; must be tainted downstream. */
  readonly message?: string;
  readonly sticker?: string;
  readonly attachments?: RawEdge<RawAttachment>;
  readonly shares?: RawEdge<RawShare>;
}

// ---------------------------------------------------------------------------
// 3. Shaped records
// ---------------------------------------------------------------------------

/** A participant reduced to identity; `name` is raw UGC (taint downstream). */
export interface ParticipantRecord {
  readonly id?: string;
  readonly name?: string;
}

/** The attachment classes this server distinguishes (CC-MSG-6). */
export type AttachmentKind =
  'image' | 'video' | 'audio' | 'file' | 'sticker' | 'share' | 'unknown';

/**
 * A typed stand-in for one inbound attachment. `placeholder` is a one-line
 * human/model-readable summary built only from Meta-supplied metadata — never
 * from the user-supplied file name, which travels separately so it can be
 * tainted (see {@link AttachmentNameRef}).
 */
export interface AttachmentPlaceholder {
  readonly kind: AttachmentKind;
  readonly placeholder: string;
  readonly mimeType?: string;
  readonly sizeBytes?: number;
  readonly width?: number;
  readonly height?: number;
  /** Short-lived CDN URL — see {@link ATTACHMENT_URL_NOTE}. */
  readonly url?: string;
}

/**
 * User-supplied attachment text (a file name, or a shared link and its title),
 * bound to its index in the placeholder list for the same message.
 */
export interface AttachmentNameRef {
  readonly index: number;
  /** Raw UGC — taint downstream. */
  readonly name: string;
}

export interface MessageRecord {
  readonly id?: string;
  readonly createdTime?: string;
  /** `createdTime` parsed to epoch ms; absent when Graph omitted/garbled it. */
  readonly createdAtMs?: number;
  readonly from?: ParticipantRecord;
  readonly to: readonly ParticipantRecord[];
  /** The message text — raw UGC; MUST be tainted before it reaches the model. */
  readonly body?: string;
  readonly attachments: readonly AttachmentPlaceholder[];
  readonly attachmentNames: readonly AttachmentNameRef[];
}

export interface ConversationRecord {
  readonly id?: string;
  readonly updatedTime?: string;
  /** `updatedTime` parsed to epoch ms; absent when Graph omitted/garbled it. */
  readonly updatedAtMs?: number;
  readonly unreadCount?: number;
  readonly messageCount?: number;
  readonly canReply?: boolean;
  /** Latest-message preview — raw UGC; MUST be tainted before it is surfaced. */
  readonly snippet?: string;
  readonly participants: readonly ParticipantRecord[];
}

// ---------------------------------------------------------------------------
// 4. Pure shaping helpers
// ---------------------------------------------------------------------------

/**
 * Parse a Graph timestamp (`2026-07-28T10:00:00+0000`) to epoch ms. Returns
 * `undefined` for anything unparseable rather than propagating `NaN`.
 */
export function parseGraphTime(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0) return undefined;
  // Graph emits `+0000`; normalize to the `+00:00` form every engine accepts.
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : undefined;
}

function shapeParticipant(raw: RawParticipant): ParticipantRecord {
  // `email` is intentionally dropped: it is PII the model never needs to reply.
  return {
    ...(raw.id !== undefined ? { id: raw.id } : {}),
    ...(raw.name !== undefined ? { name: raw.name } : {}),
  };
}

function shapeParticipants(
  edge: RawEdge<RawParticipant> | undefined,
): ParticipantRecord[] {
  return (edge?.data ?? []).map(shapeParticipant);
}

/** Human-readable byte size for a placeholder (never a precise contract). */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${String(Math.round(bytes))} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** Classify an attachment from its media sub-objects and MIME type. */
export function attachmentKind(raw: RawAttachment): AttachmentKind {
  const mime = raw.mime_type?.toLowerCase() ?? '';
  if (raw.image_data !== undefined || mime.startsWith('image/')) return 'image';
  if (raw.video_data !== undefined || mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (raw.file_url !== undefined || mime.length > 0) return 'file';
  return 'unknown';
}

/** Build the `[kind …] <url>` placeholder line from trusted metadata only. */
export function formatAttachmentPlaceholder(parts: {
  readonly kind: AttachmentKind;
  readonly mimeType?: string;
  readonly sizeBytes?: number;
  readonly width?: number;
  readonly height?: number;
  readonly url?: string;
}): string {
  const bits: string[] = [parts.kind];
  if (parts.width !== undefined && parts.height !== undefined) {
    bits.push(`${String(parts.width)}x${String(parts.height)}`);
  }
  if (parts.mimeType !== undefined) bits.push(parts.mimeType);
  if (parts.sizeBytes !== undefined) bits.push(formatBytes(parts.sizeBytes));
  const head = `[${bits.join(' ')}]`;
  return parts.url !== undefined ? `${head} ${parts.url}` : head;
}

function shapeAttachment(raw: RawAttachment): AttachmentPlaceholder {
  const kind = attachmentKind(raw);
  const media = raw.image_data ?? raw.video_data;
  const url = media?.url ?? raw.file_url;
  const parts = {
    kind,
    ...(raw.mime_type !== undefined ? { mimeType: raw.mime_type } : {}),
    ...(raw.size !== undefined ? { sizeBytes: raw.size } : {}),
    ...(media?.width !== undefined ? { width: media.width } : {}),
    ...(media?.height !== undefined ? { height: media.height } : {}),
    ...(url !== undefined ? { url } : {}),
  };
  return { ...parts, placeholder: formatAttachmentPlaceholder(parts) };
}

/**
 * Collapse everything non-textual on a message into typed placeholders
 * (CC-MSG-6): the `attachments` edge, a bare `sticker` URL and shared links.
 * Never inlines a payload; each entry carries only metadata plus a CDN URL.
 */
export function summariseAttachments(raw: RawMessage): AttachmentPlaceholder[] {
  const out: AttachmentPlaceholder[] = (raw.attachments?.data ?? []).map(shapeAttachment);
  if (raw.sticker !== undefined && raw.sticker.length > 0) {
    out.push({
      kind: 'sticker',
      url: raw.sticker,
      placeholder: formatAttachmentPlaceholder({ kind: 'sticker', url: raw.sticker }),
    });
  }
  // A shared link and its title are chosen by the SENDER, not by Meta, so
  // neither may appear in the trusted placeholder line — an arbitrary URL is as
  // attacker-controlled as a message body. Both travel in the untrusted channel
  // built by `attachmentNames` instead.
  for (let i = 0; i < (raw.shares?.data ?? []).length; i += 1) {
    out.push({
      kind: 'share',
      placeholder: formatAttachmentPlaceholder({ kind: 'share' }),
    });
  }
  return out;
}

/**
 * The user-supplied text carried by a message's attachments — file names, and a
 * shared link together with its title — index-bound to the placeholders that
 * {@link summariseAttachments} produces for the same message. Raw UGC: the tools
 * layer puts these inside the taint envelope.
 */
export function attachmentNames(raw: RawMessage): AttachmentNameRef[] {
  const names: AttachmentNameRef[] = [];
  const attachments = raw.attachments?.data ?? [];
  attachments.forEach((att, index) => {
    if (att.name !== undefined && att.name.length > 0) {
      names.push({ index, name: att.name });
    }
  });
  // `summariseAttachments` emits attachments, then the sticker, then the shares;
  // mirror that layout so `index` addresses the same placeholder in both lists.
  const hasSticker = raw.sticker !== undefined && raw.sticker.length > 0;
  const shareOffset = attachments.length + (hasSticker ? 1 : 0);
  (raw.shares?.data ?? []).forEach((share, offset) => {
    const parts = [share.name, share.link].filter(
      (part): part is string => part !== undefined && part.length > 0,
    );
    if (parts.length > 0) {
      names.push({ index: shareOffset + offset, name: parts.join(' — ') });
    }
  });
  return names;
}

export function shapeMessage(raw: RawMessage): MessageRecord {
  const createdAtMs = parseGraphTime(raw.created_time);
  return {
    ...(raw.id !== undefined ? { id: raw.id } : {}),
    ...(raw.created_time !== undefined ? { createdTime: raw.created_time } : {}),
    ...(createdAtMs !== undefined ? { createdAtMs } : {}),
    ...(raw.from !== undefined ? { from: shapeParticipant(raw.from) } : {}),
    to: shapeParticipants(raw.to),
    ...(raw.message !== undefined ? { body: raw.message } : {}),
    attachments: summariseAttachments(raw),
    attachmentNames: attachmentNames(raw),
  };
}

export function shapeConversation(raw: RawConversation): ConversationRecord {
  const updatedAtMs = parseGraphTime(raw.updated_time);
  return {
    ...(raw.id !== undefined ? { id: raw.id } : {}),
    ...(raw.updated_time !== undefined ? { updatedTime: raw.updated_time } : {}),
    ...(updatedAtMs !== undefined ? { updatedAtMs } : {}),
    ...(raw.unread_count !== undefined ? { unreadCount: raw.unread_count } : {}),
    ...(raw.message_count !== undefined ? { messageCount: raw.message_count } : {}),
    ...(raw.can_reply !== undefined ? { canReply: raw.can_reply } : {}),
    ...(raw.snippet !== undefined ? { snippet: raw.snippet } : {}),
    participants: shapeParticipants(raw.participants),
  };
}

/** Map a `Page<A>` to a `Page<B>` keeping the cursor / truncation metadata. */
function mapPage<A, B>(page: Page<A>, fn: (item: A) => B): Page<B> {
  return {
    data: page.data.map(fn),
    truncated: page.truncated,
    ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    ...(page.note !== undefined ? { note: page.note } : {}),
  };
}

// ---------------------------------------------------------------------------
// 5. The 24-hour standard messaging window (CC-MSG-1)
// ---------------------------------------------------------------------------

export type MessagingWindowStatus = 'open' | 'closed' | 'unknown';

export interface MessagingWindow {
  readonly status: MessagingWindowStatus;
  /** Epoch ms of the person's most recent inbound message, when known. */
  readonly lastInboundAtMs?: number;
  /** Age of that message at evaluation time, in ms. */
  readonly ageMs?: number;
  /** Epoch ms at which the window closes (`lastInbound + 24h`). */
  readonly closesAtMs?: number;
  readonly explanation: string;
}

/**
 * Decide client-side whether a plain RESPONSE send is allowed, using the injected
 * clock (never `Date.now()`). `unknown` is a first-class answer: without a
 * last-inbound timestamp the server does not guess, it says so and lets Graph be
 * the authority.
 */
export function evaluateMessagingWindow(input: {
  readonly lastInboundAtMs?: number;
  readonly nowMs: number;
}): MessagingWindow {
  const { lastInboundAtMs, nowMs } = input;
  if (lastInboundAtMs === undefined) {
    return {
      status: 'unknown',
      explanation:
        'No inbound message timestamp is available, so the 24-hour standard ' +
        'messaging window could not be verified before sending. Facebook remains ' +
        'the authority: if the window is closed the send is rejected. ' +
        MESSAGE_TAG_GUIDANCE,
    };
  }
  const ageMs = nowMs - lastInboundAtMs;
  const closesAtMs = lastInboundAtMs + STANDARD_MESSAGING_WINDOW_MS;
  const hours = (ageMs / (60 * 60 * 1000)).toFixed(1);
  if (ageMs > STANDARD_MESSAGING_WINDOW_MS) {
    return {
      status: 'closed',
      lastInboundAtMs,
      ageMs,
      closesAtMs,
      explanation:
        `The person's last message arrived ${hours}h ago, so the 24-hour standard ` +
        `messaging window CLOSED at ${new Date(closesAtMs).toISOString()}. ` +
        MESSAGE_TAG_GUIDANCE,
    };
  }
  return {
    status: 'open',
    lastInboundAtMs,
    ageMs,
    closesAtMs,
    explanation:
      `The person's last message arrived ${hours}h ago; the 24-hour standard ` +
      `messaging window is open until ${new Date(closesAtMs).toISOString()}.`,
  };
}

/**
 * The newest inbound (not-from-the-Page) message timestamp in a thread. Messages
 * whose sender or timestamp Graph omitted are ignored rather than guessed at.
 */
export function findLastInboundAtMs(
  messages: readonly MessageRecord[],
  pageId: string,
): number | undefined {
  let newest: number | undefined;
  for (const message of messages) {
    const fromId = message.from?.id;
    if (fromId === undefined || fromId === pageId) continue;
    const at = message.createdAtMs;
    if (at === undefined) continue;
    if (newest === undefined || at > newest) newest = at;
  }
  return newest;
}

/**
 * The only sound inference available from a conversation listing: `updated_time`
 * is an UPPER bound on the last inbound message (it also moves on outbound
 * activity), so an old `updated_time` proves the window is closed while a recent
 * one proves nothing. Never returns `'open'`.
 */
export function windowStatusFromLastActivity(
  lastActivityAtMs: number | undefined,
  nowMs: number,
): Extract<MessagingWindowStatus, 'closed' | 'unknown'> {
  if (lastActivityAtMs === undefined) return 'unknown';
  return nowMs - lastActivityAtMs > STANDARD_MESSAGING_WINDOW_MS ? 'closed' : 'unknown';
}

// ---------------------------------------------------------------------------
// 6. Error mapping for sends (CC-MSG-1 / -2 / -3)
// ---------------------------------------------------------------------------

/** Subcodes Meta returns when the standard messaging window has closed. */
const MESSAGING_WINDOW_SUBCODES: ReadonlySet<number> = new Set([
  2018278, 2018065, 2534022,
]);

/** Codes/subcodes meaning the recipient can no longer be reached (CC-MSG-3). */
const RECIPIENT_UNAVAILABLE_SUBCODES: ReadonlySet<number> = new Set([
  1545041, 1545043, 2018108,
]);
const RECIPIENT_UNAVAILABLE_CODES: ReadonlySet<number> = new Set([551]);

function matchesWindowText(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes('outside') &&
    (text.includes('window') || text.includes('24-hour') || text.includes('24 hour'))
  );
}

function matchesRecipientText(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes("isn't available") ||
    text.includes('is not available') ||
    text.includes('no longer available') ||
    text.includes('blocked')
  );
}

// NOTE: these two classifiers deliberately return a plain `boolean` rather than a
// `err is GraphApiError` type predicate. Every caller consults them on a value
// that is ALREADY narrowed to `GraphApiError`, and a predicate would make the
// negative branch subtract `GraphApiError` from itself, narrowing the value to
// `never` for the rest of the function.

/** True when a send failure is the closed 24-hour window (CC-MSG-1). */
export function isMessagingWindowError(err: unknown): boolean {
  if (!(err instanceof GraphApiError)) return false;
  if (err.subcode !== undefined && MESSAGING_WINDOW_SUBCODES.has(err.subcode)) {
    return true;
  }
  return matchesWindowText(err.message);
}

/** True when a send failure means the recipient is unreachable (CC-MSG-3). */
export function isRecipientUnavailableError(err: unknown): boolean {
  if (!(err instanceof GraphApiError)) return false;
  if (isMessagingWindowError(err)) return false;
  if (err.subcode !== undefined && RECIPIENT_UNAVAILABLE_SUBCODES.has(err.subcode)) {
    return true;
  }
  return RECIPIENT_UNAVAILABLE_CODES.has(err.code) && matchesRecipientText(err.message);
}

function windowClosedAction(): ErrorAction {
  return {
    category: 'unsupported',
    retryable: false,
    nextTool: 'facebook_get_conversation',
    operatorText: MESSAGE_TAG_GUIDANCE,
  };
}

function recipientUnavailableAction(): ErrorAction {
  return {
    category: 'not_found',
    retryable: false,
    nextTool: 'facebook_get_conversation',
    operatorText:
      'The recipient can no longer be reached — they blocked the Page, deleted the ' +
      'conversation, or their account is gone. Terminal: do not retry, and do not ' +
      'try to reach them on another surface. Nothing was delivered.',
  };
}

/** Rebuild a Graph error keeping its machine-readable fields, swapping guidance. */
function reclassify(
  err: GraphApiError,
  message: string,
  action: ErrorAction,
): GraphApiError {
  return new GraphApiError(message, {
    code: err.code,
    ...(err.subcode !== undefined ? { subcode: err.subcode } : {}),
    ...(err.type !== undefined ? { type: err.type } : {}),
    ...(err.fbtraceId !== undefined ? { fbtraceId: err.fbtraceId } : {}),
    httpStatus: err.httpStatus,
    action,
    cause: err,
  });
}

/**
 * The client-side refusal used when the window is provably closed BEFORE any
 * request is made. Expressed as a `GraphApiError` so the server surfaces its
 * `action.operatorText` like any other classified failure; `code -1` /
 * `httpStatus 0` mark it as locally generated, and the message states plainly
 * that nothing was sent (no request left the process).
 */
export function messagingWindowClosedError(window: MessagingWindow): GraphApiError {
  return new GraphApiError(
    `Not sent: the 24-hour standard messaging window is closed. ${window.explanation}`,
    { code: -1, httpStatus: 0, action: windowClosedAction() },
  );
}

/**
 * Turn a raw send failure into an actionable one. Window and recipient failures
 * get the specific explanation the corpus demands (CC-MSG-1 / -3); an ambiguous
 * outcome is passed through untouched because the transport already classified it
 * as "may have landed — verify first" (C2 / CC-MSG-2), and everything else is
 * returned unchanged so no information is invented.
 */
export function explainSendFailure(err: unknown): Error {
  if (!(err instanceof GraphApiError)) {
    return err instanceof Error ? err : new Error(`send failed: ${String(err)}`);
  }
  if (err.action?.category === 'ambiguous') return err;
  if (isMessagingWindowError(err)) {
    return reclassify(
      err,
      `Message NOT sent — the 24-hour standard messaging window is closed. ${err.message}`,
      windowClosedAction(),
    );
  }
  if (isRecipientUnavailableError(err)) {
    return reclassify(
      err,
      `Message NOT sent — the recipient is unavailable. ${err.message}`,
      recipientUnavailableAction(),
    );
  }
  return err;
}

/**
 * Journal classification for a failed send (CC-MSG-2). A Graph error ENVELOPE
 * proves Facebook processed and rejected the request, so the message definitely
 * did not go out (`failed`). Anything else — a lost response, a timeout, an
 * aborted request, an unexpected transport fault — leaves delivery UNKNOWN, and
 * the honest journal outcome is `attempted`. Never claim a send did not happen
 * when it might have.
 */
export function classifySendOutcome(err: unknown): Exclude<JournalOutcome, 'applied'> {
  if (err instanceof GraphApiError) {
    return err.action?.category === 'ambiguous' ? 'attempted' : 'failed';
  }
  return 'attempted';
}

// ---------------------------------------------------------------------------
// 7. Graph calls
// ---------------------------------------------------------------------------

export interface ListConversationsInput {
  readonly pageId: string;
  readonly token?: string;
  readonly signal?: AbortSignal;
  readonly page?: PageRequest;
}

/**
 * One page of Messenger conversations, newest activity first as Graph orders
 * them. `platform=messenger` is pinned on the request (G-RUN-2).
 */
export async function listConversations(
  fbRequest: FbRequestFn,
  input: ListConversationsInput,
): Promise<Page<ConversationRecord>> {
  const edge: EdgeRequest = {
    host: 'graph',
    path: `/${input.pageId}/conversations`,
    params: { fields: CONVERSATION_FIELDS, platform: PLATFORM_MESSENGER },
    pageId: input.pageId,
    ...(input.token !== undefined ? { token: input.token } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };
  const page = await fetchPage<RawConversation>(fbRequest, edge, input.page ?? {});
  return mapPage(page, shapeConversation);
}

export interface GetConversationInput {
  readonly conversationId: string;
  readonly pageId?: string;
  readonly token?: string;
  readonly signal?: AbortSignal;
  readonly page?: PageRequest;
}

/**
 * One page of a thread's messages, newest-first as Graph returns them. Ordering
 * is best-effort (CC-MSG-5) and attachments come back as placeholders only.
 */
export async function getConversationMessages(
  fbRequest: FbRequestFn,
  input: GetConversationInput,
): Promise<Page<MessageRecord>> {
  const edge: EdgeRequest = {
    host: 'graph',
    path: `/${input.conversationId}/messages`,
    params: { fields: MESSAGE_FIELDS },
    ...(input.pageId !== undefined ? { pageId: input.pageId } : {}),
    ...(input.token !== undefined ? { token: input.token } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };
  const page = await fetchPage<RawMessage>(fbRequest, edge, input.page ?? {});
  return mapPage(page, shapeMessage);
}

export interface SendMessageInput {
  readonly pageId: string;
  /** The recipient's page-scoped ID (PSID). */
  readonly recipientId: string;
  readonly text: string;
  readonly token?: string;
  readonly signal?: AbortSignal;
}

export interface SendMessageResult {
  readonly messageId?: string;
  readonly recipientId?: string;
}

interface RawSendResponse {
  readonly message_id?: string;
  readonly recipient_id?: string;
}

/**
 * Send one plain text message as the Page (`messaging_type=RESPONSE`). There is
 * no idempotency key on this endpoint, so a lost response means UNKNOWN delivery:
 * failures are re-thrown through {@link explainSendFailure} and callers must pair
 * this with {@link classifySendOutcome} instead of retrying (C2 / CC-MSG-2).
 */
export async function sendMessage(
  fbRequest: FbRequestFn,
  input: SendMessageInput,
): Promise<SendMessageResult> {
  const req: JsonRequest = {
    protocol: 'json',
    method: 'POST',
    host: 'graph',
    path: `/${input.pageId}/messages`,
    body: {
      recipient: { id: input.recipientId },
      message: { text: input.text },
      messaging_type: MESSAGING_TYPE_RESPONSE,
    },
    pageId: input.pageId,
    ...(input.token !== undefined ? { token: input.token } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };
  try {
    const res = await fbRequest<RawSendResponse>(req);
    return {
      ...(res.data.message_id !== undefined ? { messageId: res.data.message_id } : {}),
      ...(res.data.recipient_id !== undefined
        ? { recipientId: res.data.recipient_id }
        : {}),
    };
  } catch (err) {
    throw explainSendFailure(err);
  }
}
