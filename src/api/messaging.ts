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
//     `MESSAGING` task on the Page. An optional `reply_to={mid}` threads the
//     message as a quoted reply to one message of the same conversation.
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

import { ambiguousWriteAction, errorMessageOf, GraphApiError } from '../core/index.js';
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

/**
 * Whether message reads ask for `reply_to{mid,is_self_reply}`. Off until the
 * field is verified on a live thread (probe P-1): an unknown field fails the
 * whole read, so it must not ride along on every `get_conversation`.
 */
export const READ_REPLY_TO = false;

/** Fields read for a message node, including attachment metadata (CC-MSG-6). */
export const MESSAGE_FIELDS =
  'id,created_time,from{id,name},to{id,name},message,sticker,' +
  'attachments{id,mime_type,name,size,image_data,video_data,file_url},' +
  'shares{link,name},reactions{reaction,users{id}}' +
  (READ_REPLY_TO ? ',reply_to{mid,is_self_reply}' : '');

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

/** One reaction on a message. `reaction` is the emoji — USER-CHOSEN content. */
export interface RawReaction {
  readonly reaction?: string;
  /** A bare array or an edge, depending on the expansion. */
  readonly users?: readonly RawParticipant[] | RawEdge<RawParticipant>;
}

/** The message a message quotes (read only when {@link READ_REPLY_TO}). */
export interface RawReplyTo {
  readonly mid?: string;
  readonly is_self_reply?: boolean;
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
  readonly reactions?: RawEdge<RawReaction>;
  readonly reply_to?: RawReplyTo;
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
  /** The quoted message's mid (`reply_to.mid`). */
  readonly replyToMessageId?: string;
  readonly isSelfReply?: boolean;
  /** Reactions folded per emoji; absent when the message has none. */
  readonly reactions?: readonly ReactionSummary[];
}

/**
 * One emoji's reactions on a message, with the reactors folded to a count: a
 * reactor's PSID identifies a person and is never echoed, only whether the
 * Page itself is among them.
 */
export interface ReactionSummary {
  /** The emoji — raw user content; MUST be tainted before it is surfaced. */
  readonly reaction: string;
  readonly count: number;
  readonly byPage: boolean;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A string field off the wire, or `undefined` when Graph sent something else. */
function readString(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * A NON-EMPTY string field off the wire, else `undefined`. The sticker URL, an
 * attachment's file name and a share's link and title are all declared
 * `string` and were all read with `.length` — on a `null` that is a TypeError,
 * thrown inside `fetchPage`'s shaping pass, which costs the caller the whole
 * thread page for one malformed node. The send tool pays twice: its window
 * probe reads the same page, so one such node made `facebook_send_message`
 * fail before it could even plan (CC-NET-2).
 */
function readText(raw: unknown): string | undefined {
  const text = readString(raw);
  return text !== undefined && text.length > 0 ? text : undefined;
}

/**
 * A Graph node id off the wire (CC-NET-2). Strings only, and never coerced. A
 * sender id here becomes the `recipient` of a reply and a conversation id
 * becomes the thread the operator polls next, so a wrong id is not a cosmetic
 * problem. A number cannot be rescued: Graph ids run past the safe-integer
 * range, so a numeric id has already lost digits by the time `JSON.parse` is
 * finished with it, and `String(n)` would mint a plausible-looking id that
 * addresses nobody. Reporting no id is the only honest answer — the same call
 * `graphId` makes in `core/auth.ts` for the token-debug identity.
 */
function graphId(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * The usable rows of a Graph edge. `fbRequest<T>` CASTS the body, so `data`
 * being an array of objects is a hope about the wire, not a fact about it: a
 * non-array reaches `.map` as a `TypeError` and a `null` row reaches the shaper
 * as one. Either would cost the caller the whole page — already paid for with a
 * metered Graph call — instead of the one malformed edge (CC-NET-2).
 */
function edgeRows<T>(edge: RawEdge<T> | undefined): readonly T[] {
  const rows: unknown = edge?.data;
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is T => isRecord(row));
}

/**
 * An ISO-8601 date-time carrying an EXPLICIT offset (`Z`, `+0000`, `+05:30`).
 * Anything else is refused before it reaches `Date.parse`, which reads an
 * offset-less date-time in the server's LOCAL zone and turns bare numbers and
 * month names (`"12"`, `"July 28"`) into dates in 2001 — either one a confident
 * epoch that would shift, or invent, the 24-hour window verdict (CC-MSG-1).
 */
const GRAPH_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Parse a Graph timestamp (`2026-07-28T10:00:00+0000`) to epoch ms. Returns
 * `undefined` for anything unparseable or zone-less rather than propagating
 * `NaN` or guessing a zone — and takes `unknown`, because the declared `string`
 * is only a cast (CC-NET-2).
 */
export function parseGraphTime(value: unknown): number | undefined {
  if (typeof value !== 'string' || !GRAPH_TIME.test(value)) return undefined;
  // Graph emits `+0000`; normalize to the `+00:00` form every engine accepts.
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : undefined;
}

function shapeParticipant(raw: RawParticipant): ParticipantRecord {
  // `email` is intentionally dropped: it is PII the model never needs to reply.
  const id = graphId(raw.id);
  const name = readString(raw.name);
  return {
    ...(id !== undefined ? { id } : {}),
    ...(name !== undefined ? { name } : {}),
  };
}

function shapeParticipants(
  edge: RawEdge<RawParticipant> | undefined,
): ParticipantRecord[] {
  return edgeRows(edge).map(shapeParticipant);
}

/** Human-readable byte size for a placeholder (never a precise contract). */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${String(Math.round(bytes))} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * A MIME type in RFC 6838 token grammar (optionally with `; key=value`
 * parameters), else `undefined`. The MIME type, dimensions, size and URL of an
 * attachment are all rendered OUTSIDE the taint envelope, in the placeholder
 * the model reads as trusted metadata — so each one must look like what it
 * claims to be, or it is not reported at all. A free-text "MIME type" carrying
 * a `]` and a sentence would otherwise close the placeholder bracket and speak
 * with the server's voice (CC-MSG-6).
 */
const MIME_TOKEN = '[a-z0-9][a-z0-9!#$&^_.+-]{0,126}';
const MIME_TYPE = new RegExp(
  `^${MIME_TOKEN}/${MIME_TOKEN}(?:\\s*;\\s*${MIME_TOKEN}=${MIME_TOKEN})*$`,
  'i',
);

function readMimeType(raw: unknown): string | undefined {
  return typeof raw === 'string' && MIME_TYPE.test(raw) ? raw : undefined;
}

/** A finite, non-negative number (a size or a pixel dimension), else `undefined`. */
function readCount(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

/**
 * An absolute http(s) URL of printable ASCII only, else `undefined`. A CDN link
 * is percent-encoded by construction; whitespace, a line break or a control
 * character in one means it is not a CDN link, and it must not ride into the
 * trusted placeholder line (CC-MSG-6).
 */
function readUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !/^[\x21-\x7e]+$/.test(raw)) return undefined;
  try {
    const { protocol } = new URL(raw);
    return protocol === 'https:' || protocol === 'http:' ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Classify an attachment from its media sub-objects and MIME type. */
export function attachmentKind(raw: RawAttachment): AttachmentKind {
  const mime = readMimeType(raw.mime_type)?.toLowerCase() ?? '';
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
  const media: RawMediaData | undefined = isRecord(raw.image_data)
    ? raw.image_data
    : isRecord(raw.video_data)
      ? raw.video_data
      : undefined;
  const url = readUrl(media?.url) ?? readUrl(raw.file_url);
  const mimeType = readMimeType(raw.mime_type);
  const sizeBytes = readCount(raw.size);
  const width = readCount(media?.width);
  const height = readCount(media?.height);
  const parts = {
    kind,
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
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
  const out: AttachmentPlaceholder[] = edgeRows(raw.attachments).map(shapeAttachment);
  const sticker = readUrl(raw.sticker);
  if (sticker !== undefined) {
    out.push({
      kind: 'sticker',
      url: sticker,
      placeholder: formatAttachmentPlaceholder({ kind: 'sticker', url: sticker }),
    });
  }
  // A shared link and its title are chosen by the SENDER, not by Meta, so
  // neither may appear in the trusted placeholder line — an arbitrary URL is as
  // attacker-controlled as a message body. Both travel in the untrusted channel
  // built by `attachmentNames` instead.
  for (let i = 0; i < edgeRows(raw.shares).length; i += 1) {
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
  const attachments = edgeRows(raw.attachments);
  attachments.forEach((att, index) => {
    const name = readText(att.name);
    if (name !== undefined) names.push({ index, name });
  });
  // `summariseAttachments` emits attachments, then the sticker, then the shares;
  // mirror that layout so `index` addresses the same placeholder in both lists.
  // The sticker test is the same `readUrl` as above on purpose: the two
  // functions must agree on what counts as a sticker, or the share indexes
  // drift by one and a title is pinned to the wrong placeholder.
  const hasSticker = readUrl(raw.sticker) !== undefined;
  const shareOffset = attachments.length + (hasSticker ? 1 : 0);
  edgeRows(raw.shares).forEach((share, offset) => {
    const parts = [readText(share.name), readText(share.link)].filter(
      (part): part is string => part !== undefined,
    );
    if (parts.length > 0) {
      names.push({ index: shareOffset + offset, name: parts.join(' — ') });
    }
  });
  return names;
}

/**
 * A reaction's users, whether Graph sends them as a bare array or as an edge
 * (`{data: [...]}`); anything else counts as no users.
 */
function reactionUsers(raw: unknown): readonly RawParticipant[] {
  const rows: unknown = Array.isArray(raw) ? raw : isRecord(raw) ? raw.data : undefined;
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is RawParticipant => isRecord(row));
}

/**
 * Fold a message's reactions per emoji. A row without users still counts as
 * one reaction; a row without an emoji is dropped rather than guessed.
 */
export function foldReactions(
  edge: RawEdge<RawReaction> | undefined,
  pageId: string | undefined,
): ReactionSummary[] {
  const folded = new Map<string, { count: number; byPage: boolean }>();
  for (const row of edgeRows(edge)) {
    const reaction = readText(row.reaction);
    if (reaction === undefined) continue;
    const users = reactionUsers(row.users);
    const entry = folded.get(reaction) ?? { count: 0, byPage: false };
    entry.count += Math.max(users.length, 1);
    if (pageId !== undefined && users.some((u) => graphId(u.id) === pageId)) {
      entry.byPage = true;
    }
    folded.set(reaction, entry);
  }
  return [...folded].map(([reaction, entry]) => ({ reaction, ...entry }));
}

export function shapeMessage(raw: RawMessage, pageId?: string): MessageRecord {
  const createdAtMs = parseGraphTime(raw.created_time);
  const id = graphId(raw.id);
  const createdTime = readString(raw.created_time);
  const replyTo = isRecord(raw.reply_to) ? raw.reply_to : undefined;
  const replyToMessageId = graphId(replyTo?.mid);
  const reactions = foldReactions(raw.reactions, pageId);
  return {
    ...(id !== undefined ? { id } : {}),
    ...(createdTime !== undefined ? { createdTime } : {}),
    ...(createdAtMs !== undefined ? { createdAtMs } : {}),
    ...(isRecord(raw.from) ? { from: shapeParticipant(raw.from) } : {}),
    to: shapeParticipants(raw.to),
    ...(raw.message !== undefined ? { body: raw.message } : {}),
    attachments: summariseAttachments(raw),
    attachmentNames: attachmentNames(raw),
    ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
    ...(typeof replyTo?.is_self_reply === 'boolean'
      ? { isSelfReply: replyTo.is_self_reply }
      : {}),
    ...(reactions.length > 0 ? { reactions } : {}),
  };
}

export function shapeConversation(raw: RawConversation): ConversationRecord {
  const updatedAtMs = parseGraphTime(raw.updated_time);
  const id = graphId(raw.id);
  const updatedTime = readString(raw.updated_time);
  return {
    ...(id !== undefined ? { id } : {}),
    ...(updatedTime !== undefined ? { updatedTime } : {}),
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
 * last-inbound timestamp — or with one that cannot be true, because it is ahead
 * of the clock — the server does not guess, it says so and lets Graph be the
 * authority.
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
  if (ageMs < 0) {
    // A last-inbound timestamp AHEAD of the clock cannot be true, so nothing
    // derived from it is an age. `open` would be the dangerous answer: it hands
    // back a `closesAtMs` later than the real deadline and the caller sends
    // untagged on the strength of it. An unusable timestamp is worth exactly
    // what no timestamp is worth here — Facebook stays the authority.
    return {
      status: 'unknown',
      lastInboundAtMs,
      ageMs,
      explanation:
        'The most recent inbound timestamp is in the future relative to this ' +
        "server's clock, so the 24-hour standard messaging window could not be " +
        'verified: one of the two clocks is wrong and the age computed from them ' +
        'would be meaningless. Facebook remains the authority: if the window is ' +
        'closed the send is rejected. ' +
        MESSAGE_TAG_GUIDANCE,
    };
  }
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

/** Graph's generic invalid-parameter code, which an unknown reply_to mid returns. */
const INVALID_PARAMETER_CODE = 100;

/** Invalid, expired (90 days) or another Page's reusable attachment id (V9). */
const ATTACHMENT_ID_REJECTED_SUBCODE = 2018074;

/**
 * Meta could not fetch an attachment URL. The subcode comes from the spec's
 * reading of the Send API errors and is not yet confirmed live.
 */
const ATTACHMENT_FETCH_FAILED_SUBCODE = 2018047;

function attachmentIdAction(): ErrorAction {
  return {
    category: 'validation',
    retryable: false,
    nextTool: 'facebook_upload_message_attachment',
    operatorText:
      'The attachment id is invalid, expired (ids last 90 days) or belongs to another ' +
      'Page, so nothing was delivered. Upload the file again with ' +
      'facebook_upload_message_attachment, or send it by URL.',
  };
}

function attachmentFetchAction(): ErrorAction {
  return {
    category: 'validation',
    retryable: false,
    operatorText:
      'Meta could not fetch the attachment URL, so nothing was delivered. The URL must ' +
      'be public (no login), answer within 10 s (75 s for video) and stay within the ' +
      'size limits (images 8 MB, other files 25 MB).',
  };
}

function replyTargetAction(): ErrorAction {
  return {
    category: 'validation',
    retryable: false,
    nextTool: 'facebook_get_conversation',
    operatorText:
      'Facebook rejected the reply target, so nothing was delivered. Take the mid ' +
      'from facebook_get_conversation of this same thread, or send without ' +
      'reply_to_message_id.',
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
    // Meta's own headline and reason: on a refusal they are often the only
    // human-readable explanation, so a rebuilt error must not drop them.
    ...(err.userTitle !== undefined ? { userTitle: err.userTitle } : {}),
    ...(err.userMessage !== undefined ? { userMessage: err.userMessage } : {}),
    cause: err,
  });
}

/** Where a possibly-delivered private message can be verified (never the feed). */
const SEND_VERIFY_TOOL = 'facebook_get_conversation';

/** The transport detail inside the standard `ambiguousWriteAction` guidance. */
const AMBIGUOUS_DETAIL =
  /^Write outcome unknown \((.*)\) — the request reached Facebook/s;

/**
 * Point an ambiguous send at the conversation instead of the transport default
 * (`facebook_list_posts`, where a DM never appears). The category, the
 * not-retryable verdict and the transport detail are all kept; when the guidance
 * is not the standard shape only the verify tool is swapped, so no text is lost.
 */
function ambiguousSendError(err: GraphApiError, action: ErrorAction): GraphApiError {
  if (action.nextTool === SEND_VERIFY_TOOL) return err;
  const detail = AMBIGUOUS_DETAIL.exec(action.operatorText)?.[1];
  const rebuilt: ErrorAction =
    detail !== undefined
      ? {
          ...action,
          ...ambiguousWriteAction({ verifyTool: SEND_VERIFY_TOOL, detail }),
        }
      : { ...action, nextTool: SEND_VERIFY_TOOL };
  return reclassify(err, err.message, rebuilt);
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
 * outcome keeps the transport's "may have landed — verify first" verdict (C2 /
 * CC-MSG-2) but names the conversation as the place to verify, and everything
 * else is returned unchanged so no information is invented.
 */
export function explainSendFailure(
  err: unknown,
  options: {
    readonly replyTo?: boolean;
    /** How the message's attachment was given, when it carries one. */
    readonly attachmentSource?: AttachmentSource;
  } = {},
): Error {
  if (!(err instanceof GraphApiError)) {
    return err instanceof Error
      ? err
      : new Error(`send failed: ${errorMessageOf(err)}`, { cause: err });
  }
  if (err.action?.category === 'ambiguous') return ambiguousSendError(err, err.action);
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
  const attachmentFailure =
    options.attachmentSource !== undefined
      ? explainAttachmentFailure(err, options.attachmentSource)
      : undefined;
  if (attachmentFailure !== undefined) return attachmentFailure;
  if (options.replyTo === true && err.code === INVALID_PARAMETER_CODE) {
    return reclassify(
      err,
      `Message NOT sent — the reply_to mid was not found in this conversation. ${err.message}`,
      replyTargetAction(),
    );
  }
  return err;
}

/**
 * Explain a Graph refusal of a message's attachment: a rejected reusable id, or
 * a URL Meta could not fetch. `undefined` when the error is about something
 * else. Shared by the Messenger send and the private reply.
 */
export function explainAttachmentFailure(
  err: GraphApiError,
  source: AttachmentSource,
): GraphApiError | undefined {
  if (source === 'id' && err.subcode === ATTACHMENT_ID_REJECTED_SUBCODE) {
    return reclassify(
      err,
      `Message NOT sent — the attachment id was rejected. ${err.message}`,
      attachmentIdAction(),
    );
  }
  if (source === 'url' && err.subcode === ATTACHMENT_FETCH_FAILED_SUBCODE) {
    return reclassify(
      err,
      `Message NOT sent — Meta could not fetch the attachment URL. ${err.message}`,
      attachmentFetchAction(),
    );
  }
  return undefined;
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
  /** Only the conversation with this person (their PSID). */
  readonly userId?: string;
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
    params: {
      fields: CONVERSATION_FIELDS,
      platform: PLATFORM_MESSENGER,
      ...(input.userId !== undefined ? { user_id: input.userId } : {}),
    },
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
  return mapPage(page, (raw) => shapeMessage(raw, input.pageId));
}

/** The kinds of file Messenger renders as an outbound attachment (V6). */
export type OutboundAttachmentType = 'image' | 'audio' | 'video' | 'file';

/** How an outbound attachment is given: a URL Meta fetches, or a reusable id. */
export type AttachmentSource = 'url' | 'id';

/** One outbound attachment: a public URL Meta fetches, or a reusable id (V6, V8). */
export type OutboundAttachment =
  | { readonly type: OutboundAttachmentType; readonly url: string }
  | { readonly type: OutboundAttachmentType; readonly attachmentId: string };

export function attachmentSourceOf(attachment: OutboundAttachment): AttachmentSource {
  return 'url' in attachment ? 'url' : 'id';
}

/** What a message carries: text, or one attachment — never both (V7). */
export type OutboundContent =
  { readonly text: string } | { readonly attachment: OutboundAttachment };

/** The Send API `message` object for some content: `{text}` or `{attachment}`. */
export function messageBody(content: OutboundContent): Record<string, unknown> {
  if ('text' in content) return { text: content.text };
  const { attachment } = content;
  return {
    attachment: {
      type: attachment.type,
      payload:
        'url' in attachment
          ? { url: attachment.url, is_reusable: false }
          : { attachment_id: attachment.attachmentId },
    },
  };
}

export interface SendMessageInput {
  readonly pageId: string;
  /** The recipient's page-scoped ID (PSID). */
  readonly recipientId: string;
  readonly content: OutboundContent;
  /** The mid this message quotes (`reply_to`); same conversation only. */
  readonly replyToMessageId?: string;
  readonly token?: string;
  readonly signal?: AbortSignal;
}

export interface SendMessageResult {
  readonly messageId?: string;
  readonly recipientId?: string;
}

/**
 * The send acknowledgement as it actually arrives. The transport casts the
 * parsed body to the declared type without validating it (`data as T`), so the
 * fields are `unknown` here on purpose: Graph is free to answer with a null id,
 * a numeric one, or no body at all, and a wrong assumption here is what turns
 * an unconfirmed send into a claimed one.
 */
interface RawSendResponse {
  readonly message_id?: unknown;
  readonly recipient_id?: unknown;
}

/** A Graph id counts only when it is a non-empty string; anything else is absent. */
function sendId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Send one message as the Page (`messaging_type=RESPONSE`): plain text or one
 * attachment. There is
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
      message: messageBody(input.content),
      messaging_type: MESSAGING_TYPE_RESPONSE,
      ...(input.replyToMessageId !== undefined
        ? { reply_to: { mid: input.replyToMessageId } }
        : {}),
    },
    pageId: input.pageId,
    ...(input.token !== undefined ? { token: input.token } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };
  try {
    const res = await fbRequest<RawSendResponse>(req);
    // An HTTP 200 with an empty body parses to `undefined`, so the acknowledgement
    // is read defensively: a crash here would report a send that DID go out as a
    // failure, and an unusable id would report one that did not as confirmed.
    const ack: RawSendResponse =
      typeof res.data === 'object' && res.data !== null ? res.data : {};
    const messageId = sendId(ack.message_id);
    const recipientId = sendId(ack.recipient_id);
    return {
      ...(messageId !== undefined ? { messageId } : {}),
      ...(recipientId !== undefined ? { recipientId } : {}),
    };
  } catch (err) {
    throw explainSendFailure(err, {
      replyTo: input.replyToMessageId !== undefined,
      ...('attachment' in input.content
        ? { attachmentSource: attachmentSourceOf(input.content.attachment) }
        : {}),
    });
  }
}

export interface SendReactionInput {
  readonly pageId: string;
  /** The recipient's page-scoped ID (PSID). */
  readonly recipientId: string;
  /** The mid the Page reacts to. */
  readonly messageId: string;
  /** The emoji to set; absent ⇒ the Page's reaction is removed (`unreact`). */
  readonly reaction?: string;
  readonly token?: string;
  readonly signal?: AbortSignal;
}

export interface SendReactionResult {
  readonly recipientId?: string;
}

function reactionRejectedAction(): ErrorAction {
  return {
    category: 'validation',
    retryable: false,
    nextTool: 'facebook_get_conversation',
    operatorText:
      'Facebook rejected the reaction, so nothing changed: either the message id was ' +
      'not found for this recipient (take the mid from facebook_get_conversation of the ' +
      'same thread) or Meta rejected this reaction emoji (try a common one such as ❤️).',
  };
}

/**
 * Turn a raw reaction failure into an actionable one: the window, recipient and
 * ambiguous cases exactly as for a send ({@link explainSendFailure}), plus
 * Graph's invalid-parameter code, which covers both an unknown mid and an emoji
 * Meta does not accept — the two cannot be told apart from the envelope.
 */
function explainReactionFailure(err: unknown): Error {
  const explained = explainSendFailure(err);
  if (
    explained === err &&
    err instanceof GraphApiError &&
    err.code === INVALID_PARAMETER_CODE
  ) {
    return reclassify(
      err,
      `Reaction NOT applied — Facebook rejected the message id or the emoji. ${err.message}`,
      reactionRejectedAction(),
    );
  }
  return explained;
}

/**
 * React to one message as the Page (`sender_action: react`), or remove the
 * Page's reaction (`unreact`) when no emoji is given. No `messaging_type` is
 * sent: a sender action is not a message. Like a send, there is no idempotency
 * key, so failures keep the send classification ({@link classifySendOutcome})
 * and the acknowledgement is judged by {@link classifyReactionOutcome}.
 */
export async function sendReaction(
  fbRequest: FbRequestFn,
  input: SendReactionInput,
): Promise<SendReactionResult> {
  const req: JsonRequest = {
    protocol: 'json',
    method: 'POST',
    host: 'graph',
    path: `/${input.pageId}/messages`,
    body: {
      recipient: { id: input.recipientId },
      sender_action: input.reaction !== undefined ? 'react' : 'unreact',
      payload: {
        message_id: input.messageId,
        ...(input.reaction !== undefined ? { reaction: input.reaction } : {}),
      },
    },
    pageId: input.pageId,
    ...(input.token !== undefined ? { token: input.token } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };
  try {
    const res = await fbRequest<RawSendResponse>(req);
    const ack: RawSendResponse =
      typeof res.data === 'object' && res.data !== null ? res.data : {};
    const recipientId = sendId(ack.recipient_id);
    return recipientId !== undefined ? { recipientId } : {};
  } catch (err) {
    throw explainReactionFailure(err);
  }
}

/**
 * Journal verdict for an acknowledged reaction. Only an ack that names the
 * requested recipient proves Facebook acted on it; a 2xx without one (or naming
 * somebody else) is `attempted` — the reaction may or may not be showing (C2).
 */
export function classifyReactionOutcome(
  result: SendReactionResult,
  requestedRecipientId: string,
): 'applied' | 'attempted' {
  return result.recipientId === requestedRecipientId ? 'applied' : 'attempted';
}

export interface UploadMessageAttachmentInput {
  readonly pageId: string;
  readonly type: OutboundAttachmentType;
  /** A public https URL Meta fetches once and stores. */
  readonly url: string;
  readonly token?: string;
  readonly signal?: AbortSignal;
}

export interface UploadMessageAttachmentResult {
  readonly attachmentId?: string;
}

interface RawUploadResponse {
  readonly attachment_id?: unknown;
}

/**
 * Upload a reusable Messenger attachment from a URL (V8): POST
 * `/{page}/message_attachments` with `is_reusable: true`. Nothing is sent to
 * anyone; the returned id is reusable by this Page for 90 days. A 2xx without
 * an id leaves the outcome unknown, so the result simply omits it.
 */
export async function uploadMessageAttachment(
  fbRequest: FbRequestFn,
  input: UploadMessageAttachmentInput,
): Promise<UploadMessageAttachmentResult> {
  const req: JsonRequest = {
    protocol: 'json',
    method: 'POST',
    host: 'graph',
    path: `/${input.pageId}/message_attachments`,
    body: {
      message: {
        attachment: {
          type: input.type,
          payload: { url: input.url, is_reusable: true },
        },
      },
    },
    pageId: input.pageId,
    ...(input.token !== undefined ? { token: input.token } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };
  try {
    const res = await fbRequest<RawUploadResponse>(req);
    const ack: RawUploadResponse =
      typeof res.data === 'object' && res.data !== null ? res.data : {};
    const attachmentId =
      sendId(ack.attachment_id) ??
      (typeof ack.attachment_id === 'number' ? String(ack.attachment_id) : undefined);
    return attachmentId !== undefined ? { attachmentId } : {};
  } catch (err) {
    if (err instanceof GraphApiError && err.subcode === ATTACHMENT_FETCH_FAILED_SUBCODE) {
      throw reclassify(
        err,
        `Attachment NOT uploaded — Meta could not fetch the URL. ${err.message}`,
        attachmentFetchAction(),
      );
    }
    throw err;
  }
}
