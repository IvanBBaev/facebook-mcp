// Shared fixtures, fakes and helpers for the `messages` tool package tests, split out
// of `messages.test.ts` (R17). The test files import from here.
//
// Tests for the `messages` tool package (task V08): facebook_list_conversations,
// facebook_get_conversation and facebook_send_message, plus the package-level
// invariants (plan-first default, annotation quadruples, tool order).
//
// Every Graph call is served by `createFakeFbRequest` and every write runs
// through a real `createWriteGate`, so the plan/apply and journal behaviour is
// exercised end to end without a network (the fence in
// `testing/network-fence.ts` enforces that globally). Tokens in fixtures are
// placeholders, never real credentials.
//
// The load-bearing behaviours under test:
//   * `platform=messenger` is actually on the wire (G-RUN-2).
//   * NO user-generated string reaches the model outside the taint envelope,
//     including a hostile injection payload (B1 / CC-MOD-8).
//   * the 24-hour standard messaging window is decided from the injected clock —
//     inside it a send proceeds, outside it the send is refused locally and
//     nothing leaves the process (CC-MSG-1).
//   * an ambiguous send is journalled `attempted`, never `failed` (CC-MSG-2).
//   * attachments are typed placeholders built from trusted metadata only, with
//     the user-supplied file name kept inside the envelope (CC-MSG-6).
//   * plan-then-apply: a bare call previews and sends nothing.

import assert from 'node:assert/strict';
import {
  createFakeClock,
  createFakeFbRequest,
  createFakePageResolver,
  createFakeRedactor,
  createMemoryJournal,
  fbOk,
  type FakeClock,
  type FakeFbRequest,
  type FakePageResolver,
  type MemoryJournal,
} from '../../core/fakes/index.js';
import { GraphApiError } from '../../core/index.js';
import type {
  Confirmer,
  JsonRequest,
  Logger,
  Settings,
  ToolResult,
  ToolSpec,
  WriteMode,
} from '../../core/index.js';
import { TAINT_BEGIN, TAINT_END, createWriteGate } from '../../mcp/index.js';
import { createMessagesPackage } from '../../tools/messages.js';
import type { WriteToolContext } from '../../tools/shared.js';

/**
 * The gate requires an out-of-band confirmation seam to exist. These suites never
 * reach a high-consequence apply, so they hand in one that always approves rather
 * than leaving the seam missing — which the gate now (correctly) refuses.
 */
export const ALWAYS_CONFIRMS: Confirmer = {
  confirm: () => Promise.resolve({ confirmed: true, method: 'operator_token' }),
};

// ---------------------------------------------------------------------------
// Fixtures & scaffolding
// ---------------------------------------------------------------------------

export const PAGE_ID = '100';
export const PAGE_NAME = 'Test Page';
export const PAGE_TOKEN = 'EAA-PAGE-TOKEN-PLACEHOLDER';
export const PSID = '2000';
export const CONVERSATION_ID = 't_1';
export const NOW = Date.parse('2026-07-28T12:00:00.000Z');
export const HOUR_MS = 60 * 60 * 1000;

export const TOOL_LIST = 'facebook_list_conversations';
export const TOOL_GET = 'facebook_get_conversation';
export const TOOL_SEND = 'facebook_send_message';
export const TOOL_REACT = 'facebook_react_to_message';
export const TOOL_UPLOAD = 'facebook_upload_message_attachment';

/** Format an epoch-ms instant the way Graph does (`2026-07-28T10:00:00+0000`). */
export function graphTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+0000');
}

/** A recording-free no-op logger (satisfies the contract without side effects). */
export function makeLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

export function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    profiles: {},
    apiVersion: 'v23.0',
    adsApiVersion: 'v26.0',
    hosts: {
      graph: 'graph.facebook.com',
      graphVideo: 'graph-video.facebook.com',
      rupload: 'rupload.facebook.com',
    },
    requestTimeoutMs: 30_000,
    hostConcurrency: 4,
    writeMode: 'plan',
    maxResultChars: 25_000,
    transport: 'stdio',
    packagesDeny: [],
    packagesReadonly: [],
    journalPath: '/tmp/journal.ndjson',
    logLevel: 'info',
    ...overrides,
  };
}

export interface CtxParts {
  readonly fb: FakeFbRequest;
  readonly pages: FakePageResolver;
  readonly journal: MemoryJournal;
  readonly clock: FakeClock;
  readonly ctx: WriteToolContext;
}

/**
 * A tool context equipped with a REAL write gate — `executeWrite` refuses to run
 * without one, and the plan/apply and journal assertions below depend on the
 * genuine gating logic rather than a stub of it.
 */
export function makeCtx(
  opts: { nowMs?: number; writeMode?: WriteMode; maxResultChars?: number } = {},
): CtxParts {
  const fb = createFakeFbRequest();
  const pages = createFakePageResolver({
    default: { pageId: PAGE_ID, name: PAGE_NAME, token: PAGE_TOKEN },
  });
  const clock = createFakeClock(opts.nowMs ?? NOW);
  const journal = createMemoryJournal(clock);
  const settings = makeSettings(
    opts.maxResultChars !== undefined ? { maxResultChars: opts.maxResultChars } : {},
  );
  const ctx: WriteToolContext = {
    settings,
    fbRequest: fb.fn,
    pages,
    logger: makeLogger(),
    redactor: createFakeRedactor({ secrets: [PAGE_TOKEN] }),
    clock,
    journal,
    writeGate: createWriteGate({
      confirmer: ALWAYS_CONFIRMS,
      clock,
      journal,
      defaultWriteMode: opts.writeMode ?? 'plan',
    }),
  };
  return { fb, pages, journal, clock, ctx };
}

/** Look a tool up in the built package by name (fails loudly if renamed). */
export function tool(name: string): ToolSpec {
  const spec = createMessagesPackage().tools.find((t) => t.name === name);
  assert.ok(spec, `expected a tool named ${name}`);
  return spec;
}

/** The single text part of a tool result. */
export function textOf(result: ToolResult): string {
  return result.content[0]?.text ?? '';
}

/** Parse a text-only ToolResult body as an object. */
export function body(result: ToolResult): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

export function jsonOf(req: JsonRequest | undefined): JsonRequest {
  assert.ok(req, 'expected a json request');
  return req;
}

export function lastJson(fb: FakeFbRequest): JsonRequest {
  const req = fb.lastRequest();
  if (req === undefined || req.protocol !== 'json') {
    throw new Error(`expected a json request, got ${req?.protocol ?? 'none'}`);
  }
  return req;
}

/** Every JSON request the fake saw, in order. */
export function jsonCalls(fb: FakeFbRequest): JsonRequest[] {
  return fb.calls.filter((r): r is JsonRequest => r.protocol === 'json');
}

/** The POST requests issued — a send is the only POST these tools make. */
export function posts(fb: FakeFbRequest): JsonRequest[] {
  return jsonCalls(fb).filter((r) => r.method === 'POST');
}

/**
 * Preview a send, then apply the plan it returned.
 *
 * `facebook_send_message` is plan-bound (`requirePlanId`), so `apply:true` on its
 * own is always a preview — no write mode can send without a `plan_id`. Every
 * test that wants a message on the wire therefore does the two steps a real
 * caller does, and a bare-apply regression shows up as a preview, not a send.
 */
export async function sendApplied(
  args: Record<string, unknown>,
  ctx: WriteToolContext,
): Promise<Record<string, unknown>> {
  const preview = body(await tool(TOOL_SEND).handler(args, ctx));
  assert.equal(preview.status, 'preview', 'a bare send must never leave the process');
  return body(
    await tool(TOOL_SEND).handler({ ...args, apply: true, plan_id: preview.planId }, ctx),
  );
}

/** Read an object field as a record (throws with a useful message otherwise). */
export function record(value: unknown, what: string): Record<string, unknown> {
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    `expected ${what} to be an object`,
  );
  return value as Record<string, unknown>;
}

/** Read an object field as an array. */
export function list(value: unknown, what: string): unknown[] {
  assert.ok(Array.isArray(value), `expected ${what} to be an array`);
  return value;
}

/** Every `[begin, end)` span of a rendered taint envelope's content, in order. */
export function envelopeSpans(haystack: string): { from: number; to: number }[] {
  const spans: { from: number; to: number }[] = [];
  let cursor = 0;
  for (;;) {
    const begin = haystack.indexOf(TAINT_BEGIN, cursor);
    if (begin < 0) break;
    const end = haystack.indexOf(TAINT_END, begin);
    assert.ok(end > begin, 'every opening taint delimiter needs a closing one');
    spans.push({ from: begin + TAINT_BEGIN.length, to: end });
    cursor = end + TAINT_END.length;
  }
  return spans;
}

/**
 * Assert `needle` occurs in `haystack` at least once and that EVERY occurrence
 * sits inside a taint envelope — i.e. the untrusted string never escaped into a
 * trusted field. Needles must be free of `"` and `\` : the envelope body is JSON,
 * so those characters would be compared against their escaped form.
 */
export function assertOnlyInsideEnvelope(haystack: string, needle: string): void {
  assert.ok(!/["\\]/.test(needle), 'the needle must survive JSON escaping verbatim');
  const spans = envelopeSpans(haystack);
  assert.ok(spans.length > 0, 'expected at least one taint envelope');
  let hits = 0;
  for (
    let at = haystack.indexOf(needle);
    at >= 0;
    at = haystack.indexOf(needle, at + 1)
  ) {
    hits += 1;
    assert.ok(
      spans.some((span) => at >= span.from && at + needle.length <= span.to),
      `${JSON.stringify(needle)} appeared outside the taint envelope`,
    );
  }
  assert.ok(hits > 0, `expected to find ${JSON.stringify(needle)}`);
}

/** A Graph conversation node. */
export function conversationNode(opts: {
  updatedAgoMs: number;
  snippet?: string;
  name?: string;
}): unknown {
  return {
    id: CONVERSATION_ID,
    ...(opts.snippet !== undefined ? { snippet: opts.snippet } : {}),
    updated_time: graphTime(NOW - opts.updatedAgoMs),
    unread_count: 2,
    message_count: 7,
    can_reply: true,
    participants: {
      data: [
        { id: PSID, name: opts.name ?? 'Visitor', email: 'visitor@example.com' },
        { id: PAGE_ID, name: PAGE_NAME },
      ],
    },
  };
}

/** A Graph message node sent BY the visitor (inbound). */
export function inboundNode(opts: {
  agoMs: number;
  message?: string;
  id?: string;
  name?: string;
}): unknown {
  return {
    id: opts.id ?? 'm_in',
    created_time: graphTime(NOW - opts.agoMs),
    from: { id: PSID, name: opts.name ?? 'Visitor' },
    to: { data: [{ id: PAGE_ID, name: PAGE_NAME }] },
    ...(opts.message !== undefined ? { message: opts.message } : {}),
  };
}

/** A Graph message node sent BY the Page (outbound). */
export function outboundNode(opts: { agoMs: number; message: string }): unknown {
  return {
    id: 'm_out',
    created_time: graphTime(NOW - opts.agoMs),
    from: { id: PAGE_ID, name: PAGE_NAME },
    to: { data: [{ id: PSID, name: 'Visitor' }] },
    message: opts.message,
  };
}

/** Program the fake to answer the thread read for `CONVERSATION_ID`. */
export function stubThread(fb: FakeFbRequest, data: unknown[]): void {
  fb.on(
    (req) => req.path === `/${CONVERSATION_ID}/messages` && req.method === 'GET',
    fbOk({ data }),
  );
}

/** Program the fake to answer the conversation listing. */
export function stubConversations(fb: FakeFbRequest, page: unknown): void {
  fb.on(
    (req) => req.path === `/${PAGE_ID}/conversations` && req.method === 'GET',
    fbOk(page),
  );
}

/** Program the fake to answer (or reject) the send POST. */
export function stubSend(
  fb: FakeFbRequest,
  result: Parameters<FakeFbRequest['on']>[1],
): void {
  fb.on((req) => req.path === `/${PAGE_ID}/messages` && req.method === 'POST', result);
}

export function graphError(
  message: string,
  init: {
    code?: number;
    subcode?: number;
    category?: 'ambiguous' | 'permission' | 'unsupported';
  } = {},
): GraphApiError {
  return new GraphApiError(message, {
    code: init.code ?? 10,
    ...(init.subcode !== undefined ? { subcode: init.subcode } : {}),
    httpStatus: 400,
    ...(init.category !== undefined
      ? {
          action: {
            category: init.category,
            retryable: false,
            operatorText: 'original operator guidance',
          },
        }
      : {}),
  });
}
