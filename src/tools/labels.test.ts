// Tests for the custom-label tools (v2 messaging F11) at the tool boundary: the
// preview names the label and fails open when it cannot be read, the PSID never
// reaches a summary or the journal, delete is bound to a plan, and an
// unconfirmed acknowledgement is not `applied`. The wire shapes are covered in
// `../api/labels.test.ts`. Placeholder tokens only.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFakeClock,
  createFakeFbRequest,
  createFakePageResolver,
  createFakeRedactor,
  createMemoryJournal,
  fbErr,
  fbOk,
  type FakeFbRequest,
  type MemoryJournal,
} from '../core/fakes/index.js';
import {
  GraphApiError,
  type Confirmer,
  type Logger,
  type Settings,
  type ToolResult,
  type ToolSpec,
} from '../core/index.js';
import { createWriteGate } from '../mcp/index.js';
import { createMessagesPackage } from './messages.js';
import type { WriteToolContext } from './shared.js';

const PAGE_ID = '111222333';
const PAGE_NAME = 'Corner Bakery';
const PAGE_TOKEN = 'EAA-PAGE-TOKEN-0123456789';
const PSID = '900800700';
const LABEL_ID = '555';
const NOW = Date.parse('2026-10-27T12:00:00Z');

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
}

function makeHarness(): Harness {
  const fb = createFakeFbRequest();
  const clock = createFakeClock(NOW);
  const journal = createMemoryJournal(clock);
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
  };
  return { fb, ctx, journal };
}

function tool(name: string): ToolSpec {
  const spec = createMessagesPackage().tools.find((t) => t.name === name);
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

function stubLabelRead(fb: FakeFbRequest): void {
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${LABEL_ID}`,
    fbOk({ id: LABEL_ID, page_label_name: 'vip' }),
  );
}

function writes(fb: FakeFbRequest): readonly string[] {
  return fb.calls.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`);
}

test('list reads the Page labels, or one person’s with psid', async () => {
  const h = makeHarness();
  h.fb.on(() => true, fbOk({ data: [{ id: LABEL_ID, page_label_name: 'vip' }] }));
  const page = await call('facebook_list_labels', {}, h.ctx);
  assert.equal(page.scope, 'page');
  assert.equal(page.count, 1);
  assert.deepEqual(page.labels, [{ id: LABEL_ID, name: 'vip' }]);

  const person = await call('facebook_list_labels', { psid: PSID }, h.ctx);
  assert.equal(person.scope, 'person');
  assert.equal(h.fb.lastRequest()?.path, `/${PSID}/custom_labels`);
});

test('assign previews the label by name and keeps the PSID out of summary and journal', async () => {
  const h = makeHarness();
  stubLabelRead(h.fb);
  h.fb.on((r) => r.method === 'POST', fbOk({ success: true }));
  const args = { label_id: LABEL_ID, psid: PSID };

  const preview = await call('facebook_assign_label', args, h.ctx);
  assert.equal(preview.status, 'preview');
  assert.ok(String(preview.summary).includes('label 555 ("vip")'));
  assert.ok(!String(preview.summary).includes(PSID), 'the PSID is never in a summary');
  assert.equal(writes(h.fb).length, 0);

  const applied = await call('facebook_assign_label', { ...args, apply: true }, h.ctx);
  assert.equal(applied.status, 'applied');
  assert.deepEqual(writes(h.fb), [`POST /${LABEL_ID}/label`]);
  assert.ok(!String(applied.summary).includes(PSID));
  const entry = h.journal.entries[0];
  assert.equal(entry?.outcome, 'applied');
  assert.deepEqual(entry?.metadata, { action: 'assign', labelId: LABEL_ID });
  assert.ok(!JSON.stringify(h.journal.entries).includes(PSID), 'no PSID in the journal');
});

test('remove:true unassigns; an unconfirmed acknowledgement is not applied', async () => {
  const h = makeHarness();
  stubLabelRead(h.fb);
  h.fb.on((r) => r.method === 'DELETE', fbOk({ success: false }));
  const out = await call(
    'facebook_assign_label',
    { label_id: LABEL_ID, psid: PSID, remove: true, apply: true },
    h.ctx,
  );
  assert.deepEqual(writes(h.fb), [`DELETE /${LABEL_ID}/label`]);
  assert.notEqual(out.status, 'applied');
  assert.equal(h.journal.entries[0]?.outcome, 'failed');
  assert.equal(h.journal.entries[0]?.metadata?.action, 'unassign');
});

test('an unreadable label still previews, with a warning (fail open)', async () => {
  const h = makeHarness();
  h.fb.on(
    (r) => r.method === 'GET',
    fbErr(
      new GraphApiError('(#100) Unsupported get request', { code: 100, httpStatus: 400 }),
    ),
  );
  const preview = await call(
    'facebook_assign_label',
    { label_id: LABEL_ID, psid: PSID },
    h.ctx,
  );
  assert.equal(preview.status, 'preview');
  assert.ok(String(preview.summary).includes(`label ${LABEL_ID}`));
  const warnings = preview.warnings as unknown[];
  assert.ok(warnings.some((w) => String(w).includes('could not be read')));
});

test('delete is permanent: apply without a plan_id only previews', async () => {
  const h = makeHarness();
  stubLabelRead(h.fb);
  h.fb.on((r) => r.method === 'DELETE', fbOk({ success: true }));

  const unbound = await call(
    'facebook_delete_label',
    { label_id: LABEL_ID, apply: true },
    h.ctx,
  );
  assert.equal(unbound.status, 'preview');
  assert.equal(unbound.tier, 'irreversible');
  assert.ok((unbound.warnings as unknown[]).some((w) => String(w).includes('PERMANENT')));
  assert.equal(writes(h.fb).length, 0);

  const applied = await call(
    'facebook_delete_label',
    { label_id: LABEL_ID, apply: true, plan_id: unbound.planId },
    h.ctx,
  );
  assert.equal(applied.status, 'applied');
  assert.deepEqual(writes(h.fb), [`DELETE /${LABEL_ID}`]);
  assert.deepEqual(h.journal.entries[0]?.metadata, {
    action: 'delete',
    labelId: LABEL_ID,
  });
});

test('create is applied with an id, attempted without one', async () => {
  const h = makeHarness();
  h.fb.on((r) => r.method === 'POST', fbOk({ id: LABEL_ID }));
  const made = await call('facebook_create_label', { name: ' vip ', apply: true }, h.ctx);
  assert.equal(made.status, 'applied');
  assert.deepEqual((made.result as Record<string, unknown>).labelId, LABEL_ID);
  assert.equal(
    (made.result as Record<string, unknown>).name,
    'vip',
    'the name is trimmed',
  );

  const bare = makeHarness();
  bare.fb.on((r) => r.method === 'POST', fbOk({ success: true }));
  await call('facebook_create_label', { name: 'vip', apply: true }, bare.ctx);
  assert.equal(bare.journal.entries[0]?.outcome, 'attempted');
});
