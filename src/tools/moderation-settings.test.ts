// Tests for the Page moderation-settings tools (v2 moderation F12) at the tool
// boundary: the preview names the change and the resulting list, a no-op is
// refused, apply is bound to a plan whose list fingerprint diverges when someone
// else edits the list, each setting is its own POST in order, and a failed
// second step leaves the call `attempted`. The wire shapes are covered in
// `../api/page-settings.test.ts`. Placeholder tokens only.

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
  type FbRequest,
  type JsonRequest,
  type Logger,
  type Settings,
  type ToolResult,
  type ToolSpec,
} from '../core/index.js';
import { createWriteGate } from '../mcp/index.js';
import { createModerationPackage } from './moderation.js';
import type { WriteToolContext } from './shared.js';

const PAGE_ID = '111222333';
const PAGE_NAME = 'Corner Bakery';
const PAGE_TOKEN = 'EAA-PAGE-TOKEN-0123456789';
const NOW = Date.parse('2026-10-27T12:00:00Z');

const GET = 'facebook_get_moderation_settings';
const SET = 'facebook_set_moderation_settings';

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
      defaultWriteMode: 'apply',
    }),
  };
  return { fb, ctx, journal };
}

function tool(name: string): ToolSpec {
  const spec = createModerationPackage().tools.find((t) => t.name === name);
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

function settingsBody(words: string, profanity = 'MEDIUM'): unknown {
  return {
    data: [
      { setting: 'PAGE_MODERATION_BLACKLIST', value: words },
      { setting: 'PROFANITY_FILTER', value: profanity },
      { setting: 'USERS_CAN_MESSAGE', value: true },
    ],
  };
}

const isRead = (r: FbRequest): boolean => r.method === 'GET';
const isWrite = (r: FbRequest): boolean => r.method === 'POST';

function posts(fb: FakeFbRequest): readonly JsonRequest[] {
  return fb.calls.filter((r): r is JsonRequest => r.protocol === 'json' && isWrite(r));
}

async function previewThenApply(
  h: Harness,
  args: Record<string, unknown>,
): Promise<{ preview: Record<string, unknown>; applied: Record<string, unknown> }> {
  const preview = await call(SET, args, h.ctx);
  assert.equal(preview.status, 'preview');
  assert.equal(posts(h.fb).length, 0, 'a preview must not write');
  const applied = await call(
    SET,
    { ...args, apply: true, plan_id: preview.planId },
    h.ctx,
  );
  return { preview, applied };
}

test('get returns the list, the filter and the messaging flag', async () => {
  const h = makeHarness();
  h.fb.on(isRead, fbOk(settingsBody('spam,scam')));
  const out = await call(GET, {}, h.ctx);
  assert.deepEqual(out.blockedWords, ['spam', 'scam']);
  assert.equal(out.blockedWordsCount, 2);
  assert.equal(out.profanityFilter, 'MEDIUM');
  assert.equal(out.usersCanMessage, true);
  assert.equal(out.notes, undefined);
});

test('the moderation package lists both settings tools', () => {
  const names = createModerationPackage().tools.map((t) => t.name);
  assert.ok(names.includes(GET));
  assert.ok(names.includes(SET));
  assert.equal(tool(SET).writeTier, 'reversible');
});

test('apply without a plan_id only previews, even in apply mode', async () => {
  const h = makeHarness();
  h.fb.on(isRead, fbOk(settingsBody('spam')));
  h.fb.on(isWrite, fbOk({ success: true }));
  const out = await call(SET, { blocked_words: { add: ['crypto'] }, apply: true }, h.ctx);
  assert.equal(out.status, 'preview');
  assert.equal(posts(h.fb).length, 0);
});

test('preview and apply: one POST per setting, blocked words first', async () => {
  const h = makeHarness();
  h.fb.on(isRead, fbOk(settingsBody('spam,promo')));
  h.fb.on(isWrite, fbOk({ success: true }));

  const { preview, applied } = await previewThenApply(h, {
    blocked_words: { add: ['crypto', 'SPAM'], remove: ['promo'] },
    profanity_filter: 'STRONG',
  });

  const summary = String(preview.summary);
  assert.match(summary, /\+1 \(crypto\)/);
  assert.match(summary, /−1 \(promo\)/);
  assert.match(summary, /resulting list 2 words/);
  assert.match(summary, /Profanity filter MEDIUM → STRONG/);
  const warnings = (preview.warnings as readonly string[]).join('\n');
  assert.match(warnings, /AUTOMATICALLY/);
  assert.match(warnings, /Already blocked, not added: SPAM/);

  assert.equal(applied.status, 'applied');
  assert.deepEqual(
    posts(h.fb).map((r) => r.body),
    [
      { option: { PAGE_MODERATION_BLACKLIST: 'spam,crypto' } },
      { option: { PROFANITY_FILTER: 'STRONG' } },
    ],
  );
  const result = applied.result as Record<string, unknown>;
  assert.deepEqual(result.before, {
    blockedWords: ['spam', 'promo'],
    profanityFilter: 'MEDIUM',
  });
  assert.deepEqual(result.blockedWords, ['spam', 'crypto']);
  assert.equal(result.profanityFilter, 'STRONG');
  const entry = h.journal.entries.at(-1);
  assert.equal(entry?.outcome, 'applied');
  assert.deepEqual((entry?.metadata as Record<string, unknown>).added, ['crypto']);
});

test('a request that changes nothing is refused before any write', async () => {
  const h = makeHarness();
  h.fb.on(isRead, fbOk(settingsBody('spam', 'STRONG')));
  await assert.rejects(
    call(SET, { blocked_words: { add: ['Spam'] }, profanity_filter: 'STRONG' }, h.ctx),
    (err: unknown) =>
      err instanceof GraphApiError && /Nothing to change/.test(err.message),
  );
  await assert.rejects(call(SET, {}, h.ctx), /Nothing to change/);
  assert.equal(posts(h.fb).length, 0);
});

test('a comma inside a word is rejected by the schema', () => {
  assert.throws(() => tool(SET).inputSchema.parse({ blocked_words: { add: ['a,b'] } }));
});

test('a list edited after the preview diverges without writing', async () => {
  const h = makeHarness();
  h.fb.on(isRead, fbOk(settingsBody('spam')), 1);
  h.fb.on(isRead, fbOk(settingsBody('spam,lottery')));
  h.fb.on(isWrite, fbOk({ success: true }));

  const { applied } = await previewThenApply(h, { blocked_words: { add: ['crypto'] } });
  assert.equal(applied.status, 'diverged');
  assert.equal(posts(h.fb).length, 0, 'a diverged apply must not write');
});

test('a failed second step leaves the call attempted with per-step outcomes', async () => {
  const h = makeHarness();
  h.fb.on(isRead, fbOk(settingsBody('spam')));
  h.fb.on(isWrite, fbOk({ success: true }), 1);
  h.fb.on(
    isWrite,
    fbErr(new GraphApiError('(#200) Permissions error', { code: 200, httpStatus: 403 })),
  );

  const { applied } = await previewThenApply(h, {
    blocked_words: { remove: ['spam'] },
    profanity_filter: 'OFF',
  });
  assert.equal(applied.outcome, 'attempted');
  const result = applied.result as Record<string, unknown>;
  const steps = result.steps as readonly Record<string, unknown>[];
  assert.deepEqual(
    steps.map((s) => [s.setting, s.outcome]),
    [
      ['blocked_words', 'applied'],
      ['profanity_filter', 'failed'],
    ],
  );
  assert.deepEqual(result.blockedWords, []);
  assert.equal(result.profanityFilter, undefined);
  assert.match(String(result.note), /Not every step applied/);
  assert.equal(h.journal.entries.at(-1)?.outcome, 'attempted');
});

test('a declined first step skips the second and claims no change', async () => {
  const h = makeHarness();
  h.fb.on(isRead, fbOk(settingsBody('spam')));
  h.fb.on(isWrite, fbOk({ success: false }));

  const { applied } = await previewThenApply(h, {
    blocked_words: { add: ['crypto'] },
    profanity_filter: 'OFF',
  });
  assert.equal(posts(h.fb).length, 1);
  const steps = (applied.result as Record<string, unknown>).steps as readonly Record<
    string,
    unknown
  >[];
  assert.deepEqual(
    steps.map((s) => s.outcome),
    ['failed', 'skipped'],
  );
  assert.equal(h.journal.entries.at(-1)?.outcome, 'failed');
});
