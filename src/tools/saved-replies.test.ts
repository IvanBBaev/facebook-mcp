// Tests for the local saved replies (v2 messaging F10) at the tool boundary:
// the three curation tools over a real file in a temp directory, and the
// `saved_reply_id` argument of the send / reply tools — XOR with `message`, the
// `{{page_name}}` fill, and the plan binding to the resolved TEXT (editing the
// template after the preview makes the apply diverge). The file format itself
// is covered in `../core/saved-replies.test.ts`. Placeholder tokens only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createFakeClock,
  createFakeFbRequest,
  createFakePageResolver,
  createFakeRedactor,
  createMemoryJournal,
  fbOk,
  type FakeFbRequest,
  type MemoryJournal,
} from '../core/fakes/index.js';
import {
  SavedRepliesError,
  createSavedReplyStore,
  type Confirmer,
  type Logger,
  type SavedReplyStore,
  type Settings,
  type ToolResult,
  type ToolSpec,
} from '../core/index.js';
import { WriteGateError, createWriteGate } from '../mcp/index.js';
import { createMessagesPackage } from './messages.js';
import { createModerationPackage } from './moderation.js';
import type { WriteToolContext } from './shared.js';

const PAGE_ID = '111222333';
const PAGE_NAME = 'Corner Bakery';
const PAGE_TOKEN = 'EAA-PAGE-TOKEN-0123456789';
const PSID = '900800700';
const CONVERSATION_ID = 't_1';
const COMMENT_ID = `${PAGE_ID}_5_6`;
const NOW = Date.parse('2026-10-24T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const graphTime = (ms: number): string =>
  new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+0000');

const ALWAYS_CONFIRMS: Confirmer = {
  confirm: () => Promise.resolve({ confirmed: true, method: 'operator_token' }),
};

function makeSettings(): Settings {
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
  };
}

function makeLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

interface Harness {
  readonly fb: FakeFbRequest;
  readonly ctx: WriteToolContext;
  readonly journal: MemoryJournal;
  readonly store: SavedReplyStore;
  readonly file: string;
  readonly cleanup: () => Promise<void>;
}

async function makeHarness(opts: { withStore?: boolean } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'fb-saved-replies-'));
  const file = join(dir, 'saved-replies.json');
  const fb = createFakeFbRequest();
  const clock = createFakeClock(NOW);
  const journal = createMemoryJournal(clock);
  const store = createSavedReplyStore({ filePath: file, clock });
  const ctx: WriteToolContext = {
    settings: makeSettings(),
    fbRequest: fb.fn,
    pages: createFakePageResolver({
      default: { pageId: PAGE_ID, name: PAGE_NAME, token: PAGE_TOKEN },
    }),
    logger: makeLogger(),
    redactor: createFakeRedactor({ secrets: [PAGE_TOKEN] }),
    clock,
    journal,
    writeGate: createWriteGate({
      confirmer: ALWAYS_CONFIRMS,
      clock,
      journal,
      defaultWriteMode: 'plan',
    }),
    ...(opts.withStore !== false ? { savedReplies: store } : {}),
  };
  return {
    fb,
    ctx,
    journal,
    store,
    file,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const ALL_TOOLS: readonly ToolSpec[] = [
  ...createMessagesPackage().tools,
  ...createModerationPackage().tools,
];

function tool(name: string): ToolSpec {
  const spec = ALL_TOOLS.find((t) => t.name === name);
  assert.ok(spec, `expected a tool named ${name}`);
  return spec;
}

async function call(
  name: string,
  input: Record<string, unknown>,
  ctx: WriteToolContext,
): Promise<Record<string, unknown>> {
  const spec = tool(name);
  const result: ToolResult = await spec.handler(spec.inputSchema.parse(input), ctx);
  return JSON.parse(result.content[0]?.text ?? '') as Record<string, unknown>;
}

function stubThread(fb: FakeFbRequest): void {
  fb.on(
    (req) => req.path === `/${CONVERSATION_ID}/messages` && req.method === 'GET',
    fbOk({
      data: [
        {
          id: 'm_in',
          created_time: graphTime(NOW - HOUR),
          from: { id: PSID, name: 'Visitor' },
          to: { data: [{ id: PAGE_ID, name: PAGE_NAME }] },
          message: 'When do you open?',
        },
      ],
    }),
  );
}

function sends(fb: FakeFbRequest): readonly Record<string, unknown>[] {
  return fb.calls
    .filter((r) => r.protocol === 'json' && r.method === 'POST')
    .map((r) => (r as { body?: Record<string, unknown> }).body ?? {});
}

// ---------------------------------------------------------------------------
// Curation tools
// ---------------------------------------------------------------------------

test('the saved-reply tools are local: closed world, reversible writes', () => {
  const list = tool('facebook_list_saved_replies');
  assert.equal(list.writeTier, undefined);
  assert.equal(list.annotations.readOnlyHint, true);
  assert.equal(list.annotations.openWorldHint, false);
  for (const name of ['facebook_save_reply', 'facebook_delete_saved_reply']) {
    const spec = tool(name);
    assert.equal(spec.writeTier, 'reversible', `${name} tier`);
    assert.equal(spec.annotations.readOnlyHint, false);
    assert.equal(spec.annotations.destructiveHint, false);
    assert.equal(spec.annotations.openWorldHint, false);
  }
});

test('save, list and delete round-trip through the file without a Graph call', async () => {
  const h = await makeHarness();
  try {
    const saved = await call(
      'facebook_save_reply',
      { title: 'Opening hours', text: '{{page_name}} opens at 8.', tags: ['hours'] },
      h.ctx,
    );
    assert.equal(saved.status, 'created');
    const reply = saved.reply as Record<string, unknown>;
    assert.equal(reply.id, 'opening-hours', 'the id is derived from the title');
    assert.equal(reply.updatedAt, new Date(NOW).toISOString());
    assert.equal(saved.file, h.file);

    await call(
      'facebook_save_reply',
      { id: 'refunds', title: 'Refunds', text: 'DM us.' },
      h.ctx,
    );

    const all = await call('facebook_list_saved_replies', {}, h.ctx);
    assert.equal(all.count, 2);
    const tagged = await call('facebook_list_saved_replies', { tag: 'hours' }, h.ctx);
    assert.equal(tagged.count, 1);
    assert.equal(tagged.total, 2);
    // Stored verbatim: the placeholder is filled at send time, not at save time.
    assert.equal(
      (tagged.items as Record<string, unknown>[])[0]?.text,
      '{{page_name}} opens at 8.',
    );

    const deleted = await call('facebook_delete_saved_reply', { id: 'refunds' }, h.ctx);
    assert.equal(deleted.status, 'deleted');
    assert.equal((deleted.deleted as Record<string, unknown>).text, 'DM us.');
    assert.equal((await call('facebook_list_saved_replies', {}, h.ctx)).count, 1);

    assert.equal(h.fb.calls.length, 0, 'saved replies never reach Facebook');
    assert.equal(h.journal.entries.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('an existing id is a conflict unless overwrite:true, which returns the old record', async () => {
  const h = await makeHarness();
  try {
    const args = { id: 'hours', title: 'Hours', text: 'Open at 8.' };
    await call('facebook_save_reply', args, h.ctx);
    await assert.rejects(
      call('facebook_save_reply', { ...args, text: 'Open at 9.' }, h.ctx),
      (err: unknown) => err instanceof SavedRepliesError && err.code === 'conflict',
    );
    const over = await call(
      'facebook_save_reply',
      { ...args, text: 'Open at 9.', overwrite: true },
      h.ctx,
    );
    assert.equal(over.status, 'updated');
    assert.equal((over.previous as Record<string, unknown>).text, 'Open at 8.');
  } finally {
    await h.cleanup();
  }
});

test('save refuses unknown placeholders, blank text and an underivable id', async () => {
  const h = await makeHarness();
  try {
    await assert.rejects(
      call('facebook_save_reply', { title: 'Hi', text: 'Hi {{first_name}}!' }, h.ctx),
      /Unknown placeholder \{\{first_name\}\}/,
    );
    await assert.rejects(
      call('facebook_save_reply', { title: 'Hi', text: '   ' }, h.ctx),
      /blank/,
    );
    await assert.rejects(
      call('facebook_save_reply', { title: '!!!', text: 'Hello.' }, h.ctx),
      /pass `id`/,
    );
    await assert.rejects(readFile(h.file), /ENOENT/, 'nothing was written');
  } finally {
    await h.cleanup();
  }
});

test('delete of an unknown id is not_found; without a store every tool refuses', async () => {
  const h = await makeHarness();
  const bare = await makeHarness({ withStore: false });
  try {
    await assert.rejects(
      call('facebook_delete_saved_reply', { id: 'nope' }, h.ctx),
      (err: unknown) => err instanceof SavedRepliesError && err.code === 'not_found',
    );
    await assert.rejects(
      call('facebook_list_saved_replies', {}, bare.ctx),
      /not available/,
    );
  } finally {
    await h.cleanup();
    await bare.cleanup();
  }
});

// ---------------------------------------------------------------------------
// saved_reply_id on the send / reply tools
// ---------------------------------------------------------------------------

test('send_message sends the filled template and journals its id, not its text', async () => {
  const h = await makeHarness();
  try {
    await h.store.save(
      PAGE_ID,
      { id: 'hours', title: 'Hours', text: '{{page_name}} opens at 8.', tags: [] },
      { overwrite: false },
    );
    stubThread(h.fb);
    h.fb.on(
      (req) => req.path === `/${PAGE_ID}/messages` && req.method === 'POST',
      fbOk({ message_id: 'mid.1', recipient_id: PSID }),
    );
    const args = { conversation_id: CONVERSATION_ID, saved_reply_id: 'hours' };
    const preview = await call('facebook_send_message', args, h.ctx);
    assert.equal(preview.status, 'preview');
    assert.ok(String(preview.summary).includes('saved reply "hours"'));

    const applied = await call(
      'facebook_send_message',
      { ...args, apply: true, plan_id: preview.planId },
      h.ctx,
    );
    assert.equal(applied.status, 'applied');
    const [sent] = sends(h.fb);
    assert.deepEqual(
      (sent?.message as Record<string, unknown>).text,
      'Corner Bakery opens at 8.',
    );
    const entry = h.journal.entries.at(-1);
    assert.equal(entry?.metadata?.savedReplyId, 'hours');
  } finally {
    await h.cleanup();
  }
});

test('editing the template after the preview makes the apply diverge', async () => {
  const h = await makeHarness();
  try {
    const reply = { id: 'hours', title: 'Hours', text: 'Open at 8.', tags: [] };
    await h.store.save(PAGE_ID, reply, { overwrite: false });
    stubThread(h.fb);
    const args = { conversation_id: CONVERSATION_ID, saved_reply_id: 'hours' };
    const preview = await call('facebook_send_message', args, h.ctx);

    await h.store.save(PAGE_ID, { ...reply, text: 'Open at 9.' }, { overwrite: true });
    await assert.rejects(
      call(
        'facebook_send_message',
        { ...args, apply: true, plan_id: preview.planId },
        h.ctx,
      ),
      (err: unknown) => err instanceof WriteGateError && err.code === 'plan_mismatch',
    );
    assert.equal(sends(h.fb).length, 0);
  } finally {
    await h.cleanup();
  }
});

test('message and saved_reply_id are exclusive, and one of them is required', async () => {
  const h = await makeHarness();
  try {
    await assert.rejects(
      call(
        'facebook_send_message',
        { conversation_id: CONVERSATION_ID, message: 'Hi', saved_reply_id: 'hours' },
        h.ctx,
      ),
      /exactly one of `message`, `saved_reply_id` or `attachment`/,
    );
    await assert.rejects(
      call('facebook_send_message', { conversation_id: CONVERSATION_ID }, h.ctx),
      /`message`, `saved_reply_id` or `attachment`/,
    );
    await assert.rejects(
      call('facebook_private_reply', { comment_id: COMMENT_ID }, h.ctx),
      /`message`, `saved_reply_id` or `attachment`/,
    );
    await assert.rejects(
      call(
        'facebook_reply_to_comment',
        { comment_id: COMMENT_ID, message: 'Hi', saved_reply_id: 'hours' },
        h.ctx,
      ),
      /either `message` or `saved_reply_id`/,
    );
    assert.equal(h.fb.calls.length, 0, 'refused before any Graph call');
  } finally {
    await h.cleanup();
  }
});

test('an unknown saved_reply_id is refused before the private reply reads the comment', async () => {
  const h = await makeHarness();
  try {
    await assert.rejects(
      call(
        'facebook_private_reply',
        { comment_id: COMMENT_ID, saved_reply_id: 'nope' },
        h.ctx,
      ),
      (err: unknown) => err instanceof SavedRepliesError && err.code === 'not_found',
    );
    assert.equal(h.fb.calls.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('reply_to_comment previews and binds the filled template text', async () => {
  const h = await makeHarness();
  try {
    await h.store.save(
      PAGE_ID,
      { id: 'thanks', title: 'Thanks', text: 'Thanks from {{page_name}}!', tags: [] },
      { overwrite: false },
    );
    const preview = await call(
      'facebook_reply_to_comment',
      { comment_id: COMMENT_ID, saved_reply_id: 'thanks' },
      h.ctx,
    );
    assert.equal(preview.status, 'preview');
    assert.ok(String(preview.summary).includes('Thanks from Corner Bakery!'));
  } finally {
    await h.cleanup();
  }
});
