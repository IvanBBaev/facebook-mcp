// Tests for the `posts` tool package (task V03).
//
// Every Graph call is served by `createFakeFbRequest`, which REJECTS an
// unstubbed request — so "nothing reached the wire" assertions are backed by
// two independent mechanisms (the network fence and the fake's own refusal).
// The filesystem is real where it has to be: the resumable video and Reels
// flows only mean something against actual bytes inside a real FB_MEDIA_DIR, so
// those tests build a temp tree and remove it afterwards.
//
// The write gate is wired here exactly as the server bootstrap wires it (the
// frozen `ToolContext` does not carry it), with an injected plan-id minter so a
// plan-then-apply exchange is deterministic.

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createFakeClock,
  createFakeFbRequest,
  createFakePageResolver,
  createFakeRedactor,
  createMemoryJournal,
  fbErr,
  fbOk,
  type FakeFbRequest,
  type FakePageResolver,
  type MemoryJournal,
} from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import type {
  FbRequest,
  JsonRequest,
  Logger,
  PlanId,
  ProgressUpdate,
  Settings,
  ToolContext,
  ToolResult,
  ToolSpec,
  WriteMode,
} from '../core/index.js';
import { createWriteGate } from '../mcp/index.js';
import { createPostsPackage } from './posts.js';
import type { WriteToolContext } from './shared.js';

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const PAGE_ID = '100';
const PAGE_TOKEN = 'EAA-PAGE-TOKEN';
const POST_ID = '100_555';
/** A bare video id — deliberately NOT a "{page}_{post}" post id (CC-MEDIA-7). */
const VIDEO_ID = 'vid-777';
/** 2026-01-01T00:00:00Z — a fixed "now" so every schedule assertion is exact. */
const NOW_MS = Date.parse('2026-01-01T00:00:00.000Z');
/** Comfortably inside the 10 min … 29 d window both feed posts and Reels share. */
const SOON = '2026-01-05T12:00:00+00:00';

function makeLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    profiles: {},
    apiVersion: 'v23.0',
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

interface CtxParts {
  readonly fb: FakeFbRequest;
  readonly pages: FakePageResolver;
  readonly ctx: ToolContext;
  /** Everything the handler pushed through `ctx.reportProgress`. */
  readonly progress: readonly ProgressUpdate[];
  /** The write journal the gate writes through — inspected for outcome classification. */
  readonly journal: MemoryJournal;
}

function makeCtx(
  opts: {
    settings?: Settings;
    pages?: FakePageResolver;
    nowMs?: number;
    /** The package default is 'plan'; only a divergence-free path needs 'apply'. */
    writeMode?: WriteMode;
  } = {},
): CtxParts {
  const fb = createFakeFbRequest();
  const pages =
    opts.pages ??
    createFakePageResolver({
      default: { pageId: PAGE_ID, name: 'Test Page', token: PAGE_TOKEN },
    });
  const clock = createFakeClock(opts.nowMs ?? NOW_MS);
  const settings = opts.settings ?? makeSettings();
  const journal = createMemoryJournal(clock);
  const progress: ProgressUpdate[] = [];
  let planCounter = 0;

  const ctx: WriteToolContext = {
    settings,
    fbRequest: fb.fn,
    pages,
    logger: makeLogger(),
    redactor: createFakeRedactor({ secrets: [PAGE_TOKEN] }),
    clock,
    journal,
    reportProgress: (update: ProgressUpdate) => progress.push(update),
    writeGate: createWriteGate({
      clock,
      journal,
      defaultWriteMode: opts.writeMode ?? 'plan',
      newPlanId: (): PlanId => {
        planCounter += 1;
        return `plan-${String(planCounter)}`;
      },
    }),
  };
  return { fb, pages, ctx, progress, journal };
}

/** Look a tool up in the built package by name (fails loudly if renamed). */
function tool(name: string): ToolSpec {
  const spec = createPostsPackage().tools.find((t) => t.name === name);
  assert.ok(spec, `expected a tool named ${name}`);
  return spec;
}

/** Parse a text-only ToolResult body as an object. */
function body(result: ToolResult): Record<string, unknown> {
  const text = result.content[0]?.text ?? '';
  return JSON.parse(text) as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null, 'expected an object');
  return value as Record<string, unknown>;
}

function strings(value: unknown): string[] {
  assert.ok(Array.isArray(value), 'expected an array');
  return value as string[];
}

/** All json requests the handler issued, in order. */
function jsonCalls(fb: FakeFbRequest): JsonRequest[] {
  return fb.calls.filter((req): req is JsonRequest => req.protocol === 'json');
}

function findJson(fb: FakeFbRequest, match: (req: JsonRequest) => boolean): JsonRequest {
  const req = jsonCalls(fb).find(match);
  assert.ok(req, 'expected a matching json request');
  return req;
}

function jsonBody(req: JsonRequest): Record<string, unknown> {
  return record(req.body);
}

const isWrite = (req: FbRequest): boolean =>
  req.method !== 'GET' || req.protocol !== 'json';

/** Stub the display-only Page-timezone read (`GET /{page-id}?fields=id,timezone`). */
function stubPageTimezone(fb: FakeFbRequest, timezone = 'Europe/Sofia'): void {
  fb.on(
    (req) => req.method === 'GET' && req.path === `/${PAGE_ID}`,
    fbOk({ id: PAGE_ID, timezone }),
  );
}

/** Stub the divergence pre-read of one post (`GET /{post-id}`). */
function stubPostState(
  fb: FakeFbRequest,
  node: Record<string, unknown>,
  times?: number,
): void {
  fb.on((req) => req.method === 'GET' && req.path === `/${POST_ID}`, fbOk(node), times);
}

interface MediaFixture {
  readonly dir: string;
  readonly name: string;
  readonly bytes: number;
}

/** A real FB_MEDIA_DIR holding one small file — the video/Reels flows need bytes. */
async function mediaFixture(
  t: TestContext,
  name: string,
  bytes = 2048,
): Promise<MediaFixture> {
  const raw = await mkdtemp(join(tmpdir(), 'fbmcp-posts-'));
  t.after(() => rm(raw, { recursive: true, force: true }));
  const dir = await realpath(raw);
  await writeFile(join(dir, name), Buffer.alloc(bytes, 7));
  return { dir, name, bytes };
}

/** Register the three Reels phases; the start phase can be overridden first. */
function stubReelPhases(fb: FakeFbRequest, finish: Record<string, unknown>): void {
  fb.on(
    (req) =>
      req.protocol === 'json' &&
      req.path === `/${PAGE_ID}/video_reels` &&
      record(req.params)['upload_phase'] === 'start',
    fbOk({ video_id: 'reel-1', upload_url: 'https://rupload.facebook.com/x/reel-1' }),
  );
  fb.on((req) => req.protocol === 'rupload', fbOk({ success: true }));
  fb.on(
    (req) =>
      req.protocol === 'json' &&
      req.path === `/${PAGE_ID}/video_reels` &&
      record(req.params)['upload_phase'] === 'finish',
    fbOk(finish),
  );
}

// ---------------------------------------------------------------------------
// Package invariants
// ---------------------------------------------------------------------------

test('createPostsPackage builds the plan-first posts package with eight tools', () => {
  const pkg = createPostsPackage();
  assert.equal(pkg.name, 'posts');
  assert.equal(pkg.enabledByDefault, true);
  assert.equal(pkg.writeModeDefault, 'plan');
  assert.deepEqual(
    pkg.tools.map((t) => t.name),
    [
      'facebook_create_post',
      'facebook_create_photo_post',
      'facebook_create_video_post',
      'facebook_create_reel',
      'facebook_update_post',
      'facebook_delete_post',
      'facebook_list_scheduled_posts',
      'facebook_get_video_status',
    ],
  );
});

test('every posts tool carries the exact doc-06 annotation quadruple and tier', () => {
  const expected = new Map<
    string,
    {
      readOnlyHint: boolean;
      destructiveHint: boolean;
      idempotentHint: boolean;
      openWorldHint: boolean;
      writeTier: string | undefined;
    }
  >([
    [
      'facebook_create_post',
      {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        writeTier: 'reversible',
      },
    ],
    [
      'facebook_create_photo_post',
      {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        writeTier: 'reversible',
      },
    ],
    [
      'facebook_create_video_post',
      {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        writeTier: 'reversible',
      },
    ],
    [
      'facebook_create_reel',
      {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        writeTier: 'reversible',
      },
    ],
    [
      'facebook_update_post',
      {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
        writeTier: 'reversible',
      },
    ],
    [
      'facebook_delete_post',
      {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
        writeTier: 'irreversible',
      },
    ],
    [
      'facebook_list_scheduled_posts',
      {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        writeTier: undefined,
      },
    ],
    [
      'facebook_get_video_status',
      {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        writeTier: undefined,
      },
    ],
  ]);

  for (const spec of createPostsPackage().tools) {
    const want = expected.get(spec.name);
    assert.ok(want, `unexpected tool ${spec.name}`);
    assert.equal(spec.annotations.readOnlyHint, want.readOnlyHint, spec.name);
    assert.equal(spec.annotations.destructiveHint, want.destructiveHint, spec.name);
    assert.equal(spec.annotations.idempotentHint, want.idempotentHint, spec.name);
    assert.equal(spec.annotations.openWorldHint, want.openWorldHint, spec.name);
    assert.equal(spec.writeTier, want.writeTier, spec.name);
  }
});

test('every posts tool describes each of its own input fields for a model', () => {
  for (const spec of createPostsPackage().tools) {
    // `inputSchema` is typed as `ZodTypeAny`; every tool must in fact be an object.
    const view = spec.inputSchema as unknown as {
      shape?: Record<string, { description?: string }>;
    };
    assert.ok(view.shape, `${spec.name} must declare an object input schema`);
    for (const [field, schema] of Object.entries(view.shape)) {
      assert.ok(
        (schema.description ?? '').length > 20,
        `${spec.name}.${field} needs a useful .describe()`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// facebook_create_post — plan then apply
// ---------------------------------------------------------------------------

test('create_post previews without touching the wire, then applies with the plan id', async () => {
  const { fb, ctx } = makeCtx();

  const preview = body(
    await tool('facebook_create_post').handler({ message: 'Hello world' }, ctx),
  );
  assert.equal(preview['status'], 'preview');
  assert.equal(preview['applied'], false);
  assert.equal(preview['planId'], 'plan-1');
  assert.equal(preview['tier'], 'reversible');
  assert.equal(preview['pageId'], PAGE_ID);
  assert.match(String(preview['nextStep']), /apply:true and plan_id:"plan-1"/);
  assert.equal(fb.calls.length, 0, 'a dry run performs no Graph call at all');

  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
    fbOk({ id: '100_777', post_id: '100_777' }),
  );

  const applied = body(
    await tool('facebook_create_post').handler(
      { message: 'Hello world', apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'applied');
  assert.equal(applied['applied'], true);
  const result = record(applied['result']);
  assert.equal(result['postId'], '100_777');
  assert.equal(result['publishState'], 'published');

  const feed = findJson(fb, (req) => req.path === `/${PAGE_ID}/feed`);
  assert.deepEqual(jsonBody(feed), { message: 'Hello world' });
  assert.equal(feed.token, PAGE_TOKEN);
});

// CC-LIFE-2 / C2: Graph offers no idempotency key for a create, so a 5xx must be
// journaled as `attempted` — recording it as a clean `failed` would invite a
// blind retry that publishes the same post twice.
test('create_post journals a 5xx publish failure as attempted, not failed', async () => {
  const { fb, ctx, journal } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
    fbErr(new GraphApiError('upstream is unavailable', { code: 2, httpStatus: 503 })),
  );

  await tool('facebook_create_post').handler({ message: 'Maybe posted' }, ctx);

  // A bare GraphApiError is deliberately re-thrown: the server bootstrap owns the
  // Graph error envelope, so this package must not swallow it into a plain record.
  await assert.rejects(
    () =>
      tool('facebook_create_post').handler(
        { message: 'Maybe posted', apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    /unavailable/,
  );

  assert.equal(journal.entries.length, 1);
  const entry = journal.entries[0];
  assert.ok(entry);
  assert.equal(entry.tool, 'facebook_create_post');
  assert.equal(
    entry.outcome,
    'attempted',
    'an ambiguous wire failure must never be journaled as a clean failure',
  );
  assert.match(String(entry.error), /unavailable/);
});

test('create_post journals a 4xx publish rejection as failed', async () => {
  const { fb, ctx, journal } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
    fbErr(new GraphApiError('(#200) Permissions error', { code: 200, httpStatus: 400 })),
  );

  await tool('facebook_create_post').handler({ message: 'Rejected outright' }, ctx);

  await assert.rejects(
    () =>
      tool('facebook_create_post').handler(
        { message: 'Rejected outright', apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    /Permissions error/,
  );

  const entry = journal.entries[0];
  assert.ok(entry);
  assert.equal(
    entry.outcome,
    'failed',
    'a 4xx created nothing, so a clean failure is the honest record',
  );
});

// Doc 06: publishing to a live audience is plan-bound. The tier stays
// `reversible` (deleting the post is one call), so the binding comes from the
// per-call `requirePlanId` rather than from a tier promotion — which is why the
// same tool still applies in one call when nothing reaches an audience.
test('create_post refuses to publish on apply:true alone — a plan_id is required', async () => {
  const { fb, ctx } = makeCtx();

  const result = await tool('facebook_create_post').handler(
    { message: 'One shot', published: true, apply: true },
    ctx,
  );

  const preview = body(result);
  assert.equal(preview['status'], 'preview');
  assert.ok(
    strings(preview['warnings']).some((w) => w.includes('plan_id')),
    'the downgrade tells the agent what it still owes',
  );
  assert.equal(fb.calls.length, 0, 'nothing reached Graph');
});

test('create_post publishes once the apply is bound to the plan it previewed', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
    fbOk({ id: '100_1001' }),
  );
  await tool('facebook_create_post').handler(
    { message: 'One shot', published: true },
    ctx,
  );

  const applied = body(
    await tool('facebook_create_post').handler(
      { message: 'One shot', published: true, apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'applied');
  assert.equal(record(applied['result'])['postId'], '100_1001');
});

test('a draft is NOT plan-bound — it reaches no audience, so one call is enough', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
    fbOk({ id: '100_1002' }),
  );

  const applied = body(
    await tool('facebook_create_post').handler(
      { message: 'Draft', published: false, apply: true },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'applied');
  assert.equal(record(applied['result'])['postId'], '100_1002');
});

test('create_post refuses an apply whose params no longer match the plan', async () => {
  const { fb, ctx } = makeCtx();
  await tool('facebook_create_post').handler({ message: 'first' }, ctx);

  const result = await tool('facebook_create_post').handler(
    { message: 'second', apply: true, plan_id: 'plan-1' },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.equal(body(result)['reason'], 'plan_mismatch');
  assert.equal(fb.calls.length, 0, 'a mismatched apply never reaches Graph');
});

test('create_post surfaces the empty-post refusal instead of previewing nothing', async () => {
  const { fb, ctx } = makeCtx();
  const result = await tool('facebook_create_post').handler({}, ctx);
  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'empty_post');
  assert.equal(parsed['applied'], false);
  assert.equal(fb.calls.length, 0);
});

test('create_post rejects a carousel of one card before any preview is minted', async () => {
  const { ctx } = makeCtx();
  const result = await tool('facebook_create_post').handler(
    { link: 'https://example.com', child_attachments: [{ link: 'https://a.example' }] },
    ctx,
  );
  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'child_attachments_range');
  assert.equal(parsed['field'], 'child_attachments');
});

test('create_post refuses a message past the 63206-character ceiling', async () => {
  const { fb, ctx } = makeCtx();
  const result = await tool('facebook_create_post').handler(
    { message: 'a'.repeat(63_207) },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.equal(body(result)['reason'], 'message_too_long');
  assert.equal(fb.calls.length, 0);
});

// ---------------------------------------------------------------------------
// facebook_create_post — scheduling
// ---------------------------------------------------------------------------

test('create_post refuses published:true together with a schedule', async () => {
  const { fb, ctx } = makeCtx();
  const result = await tool('facebook_create_post').handler(
    { message: 'x', published: true, scheduled_publish_time: SOON },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.equal(body(result)['reason'], 'conflicting_params');
  assert.equal(fb.calls.filter(isWrite).length, 0);
});

test('create_post refuses a schedule beyond the 75-day ceiling', async () => {
  const { fb, ctx } = makeCtx();
  stubPageTimezone(fb);
  const result = await tool('facebook_create_post').handler(
    { message: 'x', scheduled_publish_time: '2026-06-01T00:00:00Z' },
    ctx,
  );
  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'schedule_too_far');
  assert.match(String(parsed['help']), /ISO-8601/);
  assert.equal(fb.calls.filter(isWrite).length, 0);
});

test('create_post echoes the publish time in UTC and Page-local time in preview AND result', async () => {
  const { fb, ctx } = makeCtx();
  stubPageTimezone(fb, 'Europe/Sofia');

  const preview = body(
    await tool('facebook_create_post').handler(
      { message: 'Later', scheduled_publish_time: SOON },
      ctx,
    ),
  );
  const warnings = strings(preview['warnings']);
  const echoed = warnings.find((w) => w.startsWith('Publish time:'));
  assert.ok(echoed, 'the preview states the resolved publish time');
  assert.match(echoed, /2026-01-05T12:00:00\.000Z \(UTC/);
  assert.match(echoed, /Europe\/Sofia/);

  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
    fbOk({ id: '100_778' }),
  );
  const applied = body(
    await tool('facebook_create_post').handler(
      { message: 'Later', scheduled_publish_time: SOON, apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  const schedule = record(record(applied['result'])['schedule']);
  assert.equal(schedule['utc'], '2026-01-05T12:00:00.000Z');
  assert.equal(schedule['epochSeconds'], Date.parse(SOON) / 1000);
  assert.equal(schedule['pageTimezone'], 'Europe/Sofia');
  assert.ok(
    typeof schedule['pageLocal'] === 'string' && schedule['pageLocal'].length > 0,
    'the applied result repeats the Page-local echo, not only the preview',
  );

  const feed = findJson(fb, (req) => req.path === `/${PAGE_ID}/feed`);
  assert.equal(jsonBody(feed)['scheduled_publish_time'], Date.parse(SOON) / 1000);
  assert.equal(jsonBody(feed)['published'], false);
});

test('create_post falls back to a UTC-only echo when the Page timezone is unreadable', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'GET' && req.path === `/${PAGE_ID}`,
    fbErr(new Error('timezone read failed')),
  );

  const preview = body(
    await tool('facebook_create_post').handler(
      { message: 'Later', scheduled_publish_time: SOON },
      ctx,
    ),
  );
  const warnings = strings(preview['warnings']);
  assert.ok(
    warnings.some((w) => w.includes('the Page timezone is unknown')),
    'the preview says plainly that the Page-local echo is unavailable',
  );
  assert.ok(
    warnings.some((w) => w.includes('page_timezone')),
    'and tells the model how to supply it',
  );
});

test('create_post surfaces a too-soon schedule with actionable format help', async () => {
  const { fb, ctx } = makeCtx();
  stubPageTimezone(fb);
  const result = await tool('facebook_create_post').handler(
    { message: 'Too soon', scheduled_publish_time: '2026-01-01T00:05:00Z' },
    ctx,
  );
  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'schedule_too_soon');
  assert.match(String(parsed['help']), /ISO-8601/);
  assert.equal(fb.calls.filter(isWrite).length, 0, 'nothing was written');
});

test('create_post refuses a schedule without an explicit UTC offset', async () => {
  const { ctx } = makeCtx();
  const result = await tool('facebook_create_post').handler(
    { message: 'Ambiguous', scheduled_publish_time: '2026-01-05T12:00:00' },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.equal(body(result)['reason'], 'schedule_format');
});

test('create_post rejects an unrecognised page_timezone rather than degrading silently', async () => {
  const { fb, ctx } = makeCtx();
  const result = await tool('facebook_create_post').handler(
    { message: 'x', scheduled_publish_time: SOON, page_timezone: 'Mars/Olympus' },
    ctx,
  );
  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'invalid_argument');
  assert.equal(parsed['field'], 'page_timezone');
  assert.match(String(parsed['hint']), /Europe\/Sofia/);
  assert.equal(fb.calls.length, 0);
});

// ---------------------------------------------------------------------------
// facebook_create_post — the multi-photo carousel
// ---------------------------------------------------------------------------

test('create_post uploads carousel children unpublished and attaches them to one post', async () => {
  const { fb, ctx, progress } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`,
    fbOk({ id: 'ph-1' }),
    1,
  );
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`,
    fbOk({ id: 'ph-2' }),
    1,
  );
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
    fbOk({ id: '100_900' }),
  );

  const photos = ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'];
  const preview = body(
    await tool('facebook_create_post').handler({ message: 'Gallery', photos }, ctx),
  );
  assert.equal(preview['status'], 'preview');
  assert.equal(fb.calls.length, 0, 'a carousel dry run uploads nothing');

  const applied = body(
    await tool('facebook_create_post').handler(
      { message: 'Gallery', photos, apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  const result = record(applied['result']);
  assert.deepEqual(result['photoIds'], ['ph-1', 'ph-2']);

  const uploads = jsonCalls(fb).filter((req) => req.path === `/${PAGE_ID}/photos`);
  assert.equal(uploads.length, 2);
  for (const upload of uploads) {
    assert.equal(jsonBody(upload)['published'], false, 'children stay unpublished');
  }
  const feed = findJson(fb, (req) => req.path === `/${PAGE_ID}/feed`);
  assert.deepEqual(jsonBody(feed)['attached_media[0]'], '{"media_fbid":"ph-1"}');
  assert.deepEqual(jsonBody(feed)['attached_media[1]'], '{"media_fbid":"ph-2"}');
  assert.deepEqual(
    progress.map((p) => p.progress),
    [1, 2],
    'each uploaded child is reported',
  );
});

test('create_post reports orphaned children to the operator when the feed call fails', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`,
    fbOk({ id: 'ph-1' }),
    1,
  );
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`,
    fbOk({ id: 'ph-2' }),
    1,
  );
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
    fbErr(new GraphApiError('feed write failed', { code: 1, httpStatus: 500 })),
  );
  // The first child is cleaned up; the second survives and must be named.
  fb.on(
    (req) => req.method === 'DELETE' && req.path === '/ph-1',
    fbOk({ success: true }),
  );
  fb.on(
    (req) => req.method === 'DELETE' && req.path === '/ph-2',
    fbErr(new Error('delete refused')),
  );

  const photos = ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'];
  await tool('facebook_create_post').handler({ message: 'Gallery', photos }, ctx);
  const result = await tool('facebook_create_post').handler(
    { message: 'Gallery', photos, apply: true, plan_id: 'plan-1' },
    ctx,
  );

  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'carousel_post_failed');
  const cleanup = record(parsed['cleanup']);
  assert.deepEqual(cleanup['deleted'], ['ph-1']);
  assert.deepEqual(cleanup['orphans'], ['ph-2']);
  assert.match(String(cleanup['operatorNotice']), /ph-2/);
  assert.match(String(parsed['hint']), /photo library/);
});

test('create_post reports the child upload that failed mid-carousel', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`,
    fbOk({ id: 'ph-1' }),
    1,
  );
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`,
    fbErr(new GraphApiError('photo rejected', { code: 1, httpStatus: 400 })),
    1,
  );
  fb.on(
    (req) => req.method === 'DELETE' && req.path === '/ph-1',
    fbOk({ success: true }),
  );

  const photos = ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'];
  await tool('facebook_create_post').handler({ photos }, ctx);
  const result = await tool('facebook_create_post').handler(
    { photos, apply: true, plan_id: 'plan-1' },
    ctx,
  );

  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'multi_photo_upload_failed');
  assert.equal(parsed['failedIndex'], 1);
  assert.equal(parsed['total'], 2);
  assert.deepEqual(record(parsed['cleanup'])['deleted'], ['ph-1']);
  assert.equal(
    jsonCalls(fb).filter((req) => req.path === `/${PAGE_ID}/feed`).length,
    0,
    'no post is created when a child upload fails',
  );
});

test('create_post refuses a non-https photo source in the dry run', async () => {
  const { fb, ctx } = makeCtx();
  const result = await tool('facebook_create_post').handler(
    { photos: ['ftp://cdn.example/a.jpg'] },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.match(String(body(result)['hint']), /https:\/\//);
  assert.equal(fb.calls.length, 0);
});

// ---------------------------------------------------------------------------
// facebook_create_photo_post
// ---------------------------------------------------------------------------

test('create_photo_post posts one remote photo and reports both ids', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`,
    fbOk({ id: 'ph-9', post_id: '100_909' }),
  );

  const preview = body(
    await tool('facebook_create_photo_post').handler(
      { photo: 'https://cdn.example/a.jpg', caption: 'Look' },
      ctx,
    ),
  );
  assert.equal(preview['status'], 'preview');
  assert.equal(fb.calls.length, 0);

  const applied = body(
    await tool('facebook_create_photo_post').handler(
      {
        photo: 'https://cdn.example/a.jpg',
        caption: 'Look',
        apply: true,
        plan_id: 'plan-1',
      },
      ctx,
    ),
  );
  const result = record(applied['result']);
  assert.equal(result['photoId'], 'ph-9');
  assert.equal(result['postId'], '100_909');
  const upload = findJson(fb, (req) => req.path === `/${PAGE_ID}/photos`);
  assert.equal(jsonBody(upload)['caption'], 'Look');
  assert.equal(jsonBody(upload)['published'], true);
});

test('create_photo_post keeps a scheduled photo unpublished and passes the epoch through', async () => {
  const { fb, ctx } = makeCtx();
  stubPageTimezone(fb);
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`,
    fbOk({ id: 'ph-10' }),
  );

  await tool('facebook_create_photo_post').handler(
    { photo: 'https://cdn.example/a.jpg', scheduled_publish_time: SOON },
    ctx,
  );
  const applied = body(
    await tool('facebook_create_photo_post').handler(
      {
        photo: 'https://cdn.example/a.jpg',
        scheduled_publish_time: SOON,
        apply: true,
        plan_id: 'plan-1',
      },
      ctx,
    ),
  );
  assert.equal(record(applied['result'])['publishState'], 'scheduled');
  const upload = findJson(fb, (req) => req.path === `/${PAGE_ID}/photos`);
  assert.equal(jsonBody(upload)['published'], false);
  assert.equal(jsonBody(upload)['scheduled_publish_time'], Date.parse(SOON) / 1000);
});

test('create_photo_post refuses a local file when FB_MEDIA_DIR is not configured', async () => {
  const { fb, ctx } = makeCtx();
  const result = await tool('facebook_create_photo_post').handler(
    { photo: 'holiday.jpg' },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.match(String(body(result)['hint']), /FB_MEDIA_DIR/);
  assert.equal(fb.calls.length, 0);
});

// ---------------------------------------------------------------------------
// facebook_create_video_post
// ---------------------------------------------------------------------------

test('create_video_post bridges resumable upload progress to the MCP client', async (t) => {
  const media = await mediaFixture(t, 'clip.mp4', 4096);
  const { fb, ctx, progress } = makeCtx({
    settings: makeSettings({ mediaDir: media.dir }),
  });
  fb.on(
    (req) =>
      req.protocol === 'json' &&
      req.host === 'graph-video' &&
      record(req.body)['upload_phase'] === 'start',
    fbOk({ upload_session_id: 'sess-1', video_id: 'vid-1', start_offset: 0 }),
  );
  fb.on((req) => req.protocol === 'rupload', fbOk({}));
  fb.on(
    (req) =>
      req.protocol === 'json' &&
      req.host === 'graph-video' &&
      record(req.body)['upload_phase'] === 'finish',
    fbOk({ video_id: 'vid-1' }),
  );

  const preview = body(
    await tool('facebook_create_video_post').handler(
      { video: media.name, description: 'A clip' },
      ctx,
    ),
  );
  assert.equal(preview['status'], 'preview');
  assert.equal(fb.calls.length, 0, 'the dry run streams no bytes');
  assert.equal(progress.length, 0, 'and therefore reports no upload progress');

  const applied = body(
    await tool('facebook_create_video_post').handler(
      { video: media.name, description: 'A clip', apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  const result = record(applied['result']);
  assert.equal(result['videoId'], 'vid-1');
  assert.equal(result['delivery'], 'resumable-upload');
  assert.equal(result['bytesSent'], media.bytes);
  assert.equal(
    result['isPublishedAndProcessed'],
    false,
    'a finished upload is explicitly NOT a published, processed video',
  );
  assert.match(String(result['processingNote']), /\S/);

  assert.ok(progress.length > 0, 'the upload reported progress');
  const last = progress[progress.length - 1];
  assert.equal(last?.progress, media.bytes);
  assert.equal(last?.total, media.bytes);
  assert.match(String(last?.message), /video bytes/);
});

test('create_video_post hands a remote URL to Meta instead of streaming it', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) =>
      req.protocol === 'json' &&
      req.host === 'graph-video' &&
      req.path === `/${PAGE_ID}/videos`,
    fbOk({ id: 'vid-2' }),
  );

  await tool('facebook_create_video_post').handler(
    { video: 'https://cdn.example/clip.mp4' },
    ctx,
  );
  const applied = body(
    await tool('facebook_create_video_post').handler(
      { video: 'https://cdn.example/clip.mp4', apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  const result = record(applied['result']);
  assert.equal(result['delivery'], 'file-url');
  assert.equal(result['videoId'], 'vid-2');
  assert.equal(result['isPublishedAndProcessed'], false);
  const req = findJson(fb, (r) => r.path === `/${PAGE_ID}/videos`);
  assert.equal(jsonBody(req)['file_url'], 'https://cdn.example/clip.mp4');
  assert.equal(
    fb.calls.filter((r) => r.protocol === 'rupload').length,
    0,
    'no bytes leave this process for a file_url delivery',
  );
});

test('create_video_post refuses a local file outside FB_MEDIA_DIR before previewing', async (t) => {
  const media = await mediaFixture(t, 'clip.mp4', 16);
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  const result = await tool('facebook_create_video_post').handler(
    { video: '../escape.mp4' },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.match(String(body(result)['hint']), /FB_MEDIA_DIR/);
  assert.equal(fb.calls.length, 0);
});

// ---------------------------------------------------------------------------
// facebook_create_reel
// ---------------------------------------------------------------------------

test('create_reel publishes through the three phases and exposes video_state', async (t) => {
  const media = await mediaFixture(t, 'reel.mp4', 1024);
  const { fb, ctx, progress } = makeCtx({
    settings: makeSettings({ mediaDir: media.dir }),
  });
  stubReelPhases(fb, { success: true, post_id: '100_reel' });

  const preview = body(
    await tool('facebook_create_reel').handler(
      { video: media.name, description: 'Reel', video_state: 'PUBLISHED' },
      ctx,
    ),
  );
  assert.equal(preview['status'], 'preview');
  assert.equal(fb.calls.length, 0);
  assert.ok(
    strings(preview['warnings']).some((w) => w.includes('video_reels')),
    'the preview states where a Reel is readable back from',
  );

  const applied = body(
    await tool('facebook_create_reel').handler(
      {
        video: media.name,
        description: 'Reel',
        video_state: 'PUBLISHED',
        apply: true,
        plan_id: 'plan-1',
      },
      ctx,
    ),
  );
  const result = record(applied['result']);
  assert.equal(result['videoState'], 'PUBLISHED');
  assert.equal(result['videoId'], 'reel-1');
  assert.equal(result['postId'], '100_reel');
  assert.equal(result['bytesSent'], media.bytes);
  assert.equal(result['isPublishedAndProcessed'], false);
  assert.match(String(result['quotaNote']), /24 h/);
  assert.match(String(result['readEdge']), /video_reels/);
  assert.ok(
    progress.some((p) => /start phase/.test(p.message ?? '')),
    'the three-phase flow reports its phases to the MCP client',
  );
  assert.ok(progress.some((p) => /finish phase/.test(p.message ?? '')));
});

test('create_reel is plan-bound when PUBLISHED and one-call when DRAFT', async (t) => {
  const media = await mediaFixture(t, 'reel.mp4', 1024);
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  stubReelPhases(fb, { success: true });

  const refused = body(
    await tool('facebook_create_reel').handler(
      { video: media.name, video_state: 'PUBLISHED', apply: true },
      ctx,
    ),
  );
  assert.equal(refused['status'], 'preview');
  assert.equal(fb.calls.length, 0, 'a Reel that would go live never uploads on one call');

  const applied = body(
    await tool('facebook_create_reel').handler(
      { video: media.name, video_state: 'DRAFT', apply: true },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'applied');
  assert.equal(record(applied['result'])['videoState'], 'DRAFT');
});

test('create_reel refuses video_state:"SCHEDULED" with no publish time', async (t) => {
  const media = await mediaFixture(t, 'reel.mp4', 512);
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  const result = await tool('facebook_create_reel').handler(
    { video: media.name, video_state: 'SCHEDULED' },
    ctx,
  );
  assert.equal(result.isError, true);
  const parsed = body(result);
  // The Reels planner owns its own window, so this is a reel-kind refusal
  // rather than the feed planner's `schedule_missing`.
  assert.equal(parsed['reason'], 'reel_schedule');
  assert.equal(parsed['retryable'], false);
  assert.match(String(parsed['operatorText']), /\S/);
  assert.equal(fb.calls.length, 0);
});

test('create_reel maps the rolling 24 h quota error instead of leaking a generic failure', async (t) => {
  const media = await mediaFixture(t, 'reel.mp4', 512);
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  fb.on(
    (req) => req.protocol === 'json' && req.path === `/${PAGE_ID}/video_reels`,
    fbErr(
      new GraphApiError(
        'You have reached the limit of Reels you can publish per 24 hours',
        { code: 32, httpStatus: 400 },
      ),
    ),
  );

  await tool('facebook_create_reel').handler({ video: media.name }, ctx);
  const result = await tool('facebook_create_reel').handler(
    { video: media.name, apply: true, plan_id: 'plan-1' },
    ctx,
  );

  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'reel_quota');
  assert.equal(parsed['phase'], 'start');
  assert.equal(parsed['category'], 'rate_limit');
  assert.equal(
    parsed['retryable'],
    false,
    'a rolling-24 h quota must never become an in-process retry',
  );
  assert.ok(Number(parsed['retryAfterMs']) > 0, 'the caller is told how long to wait');
  assert.equal(parsed['nextTool'], 'facebook_usage');
  assert.match(String(parsed['operatorText']), /\S/);
  assert.equal(typeof parsed['verified'], 'boolean');
  assert.equal(
    fb.calls.filter((req) => req.protocol === 'rupload').length,
    0,
    'a quota refusal at the start phase streams no bytes',
  );
});

test('create_reel validates the shorter Reels schedule window in the dry run', async (t) => {
  const media = await mediaFixture(t, 'reel.mp4', 512);
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  stubPageTimezone(fb);

  const result = await tool('facebook_create_reel').handler(
    {
      video: media.name,
      video_state: 'SCHEDULED',
      // 40 days out: legal for a feed post (75 d) but past the 29 d Reels cap.
      scheduled_publish_time: '2026-02-10T12:00:00Z',
    },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.match(String(body(result)['error']), /29/);
  assert.equal(fb.calls.filter(isWrite).length, 0);
});

test('create_reel echoes a scheduled instant in UTC and Page-local time', async (t) => {
  const media = await mediaFixture(t, 'reel.mp4', 512);
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  stubPageTimezone(fb, 'Europe/Sofia');
  stubReelPhases(fb, { success: true });

  const preview = body(
    await tool('facebook_create_reel').handler(
      { video: media.name, video_state: 'SCHEDULED', scheduled_publish_time: SOON },
      ctx,
    ),
  );
  const echoed = strings(preview['warnings']).find((w) => w.startsWith('Publish time:'));
  assert.ok(echoed, 'the Reels preview carries the same echo line as a feed post');
  assert.match(echoed, /2026-01-05T12:00:00\.000Z \(UTC/);
  assert.match(echoed, /Europe\/Sofia/);

  const applied = body(
    await tool('facebook_create_reel').handler(
      {
        video: media.name,
        video_state: 'SCHEDULED',
        scheduled_publish_time: SOON,
        apply: true,
        plan_id: 'plan-1',
      },
      ctx,
    ),
  );
  const schedule = record(record(applied['result'])['schedule']);
  assert.equal(schedule['epochSeconds'], Date.parse(SOON) / 1000);
  assert.equal(schedule['pageTimezone'], 'Europe/Sofia');
  assert.ok(typeof schedule['pageLocal'] === 'string');
  const finish = findJson(fb, (req) => record(req.params)['upload_phase'] === 'finish');
  assert.equal(record(finish.params)['video_state'], 'SCHEDULED');
});

test('create_reel refuses a remote URL because the protocol streams local bytes', async () => {
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: '/tmp' }) });
  const result = await tool('facebook_create_reel').handler(
    { video: 'https://cdn.example/reel.mp4' },
    ctx,
  );
  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'unsupported_media_source');
  assert.match(String(parsed['error']), /facebook_create_video_post/);
  assert.equal(fb.calls.length, 0);
});

// ---------------------------------------------------------------------------
// facebook_update_post
// ---------------------------------------------------------------------------

test('update_post previews an edit, then applies it against the unchanged post', async () => {
  const { fb, ctx } = makeCtx();
  stubPostState(fb, {
    id: POST_ID,
    message: 'old text',
    is_published: true,
    created_time: '2025-12-20T10:00:00+0000',
  });
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
    fbOk({ success: true }),
  );

  const preview = body(
    await tool('facebook_update_post').handler(
      { post_id: POST_ID, action: 'edit', message: 'new text' },
      ctx,
    ),
  );
  assert.equal(preview['status'], 'preview');
  assert.equal(
    fb.calls.filter(isWrite).length,
    0,
    'the dry run reads the post but writes nothing',
  );

  const applied = body(
    await tool('facebook_update_post').handler(
      {
        post_id: POST_ID,
        action: 'edit',
        message: 'new text',
        apply: true,
        plan_id: 'plan-1',
      },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'applied');
  const result = record(applied['result']);
  assert.equal(result['action'], 'edit');
  assert.deepEqual(result['changed'], { message: 'new text' });
  const write = findJson(
    fb,
    (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
  );
  assert.deepEqual(jsonBody(write), { message: 'new text' });
});

test('update_post detects divergence when the post changed after the preview', async () => {
  const { fb, ctx } = makeCtx();
  stubPostState(
    fb,
    { id: POST_ID, message: 'old text', is_published: true },
    1, // the plan-time read
  );
  stubPostState(fb, {
    id: POST_ID,
    message: 'someone else edited it',
    is_published: true,
  });

  await tool('facebook_update_post').handler(
    { post_id: POST_ID, action: 'edit', message: 'new text' },
    ctx,
  );
  const applied = body(
    await tool('facebook_update_post').handler(
      {
        post_id: POST_ID,
        action: 'edit',
        message: 'new text',
        apply: true,
        plan_id: 'plan-1',
      },
      ctx,
    ),
  );

  assert.equal(applied['status'], 'diverged');
  assert.equal(applied['applied'], false);
  const diverged = applied['diverged'];
  assert.ok(Array.isArray(diverged) && diverged.length > 0, 'the diff is reported');
  assert.match(String(applied['notPerformedNotice']), /nothing was written/);
  assert.equal(
    fb.calls.filter(isWrite).length,
    0,
    'a diverged apply performs no mutation',
  );
});

test('update_post publish_now flips is_published and warns about the race', async () => {
  const { fb, ctx } = makeCtx();
  stubPostState(fb, {
    id: POST_ID,
    is_published: false,
    scheduled_publish_time: 1_800_000_000,
  });
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
    fbOk({ success: true }),
  );

  const preview = body(
    await tool('facebook_update_post').handler(
      { post_id: POST_ID, action: 'publish_now' },
      ctx,
    ),
  );
  assert.ok(
    strings(preview['warnings']).length > 0,
    'publishing early carries operator notes',
  );

  const applied = body(
    await tool('facebook_update_post').handler(
      { post_id: POST_ID, action: 'publish_now', apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'applied');
  const write = findJson(
    fb,
    (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
  );
  assert.equal(jsonBody(write)['is_published'], true);
});

test('update_post publish_now is plan-bound, an edit under the same mode is not', async () => {
  // publish_now reaches a live audience exactly as create_post published:true
  // does, so no write mode may perform it from a bare apply:true; an edit
  // reaches nobody new and stays ungated, which is what keeps the gate honest.
  const { fb, ctx } = makeCtx({ writeMode: 'apply' });
  stubPostState(fb, {
    id: POST_ID,
    is_published: false,
    scheduled_publish_time: 1_800_000_000,
  });
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
    fbOk({ success: true }),
  );

  const bare = body(
    await tool('facebook_update_post').handler(
      { post_id: POST_ID, action: 'publish_now', apply: true },
      ctx,
    ),
  );
  assert.equal(bare['status'], 'preview');
  assert.ok(
    strings(bare['warnings']).some((w) => w.includes('plan_id')),
    'the preview must say what the call still owes',
  );
  assert.equal(
    fb.calls.filter((r) => r.protocol === 'json' && r.method === 'POST').length,
    0,
    'nothing may be published',
  );

  const edited = body(
    await tool('facebook_update_post').handler(
      { post_id: POST_ID, action: 'edit', message: 'Fixed a typo.', apply: true },
      ctx,
    ),
  );
  assert.equal(edited['status'], 'applied');
});

test('update_post reschedules within the window and echoes both timezones', async () => {
  const { fb, ctx } = makeCtx();
  stubPageTimezone(fb, 'Europe/Sofia');
  stubPostState(fb, {
    id: POST_ID,
    is_published: false,
    created_time: '2025-12-20T10:00:00+0000',
  });
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
    fbOk({ success: true }),
  );

  const preview = body(
    await tool('facebook_update_post').handler(
      { post_id: POST_ID, action: 'reschedule', scheduled_publish_time: SOON },
      ctx,
    ),
  );
  const echoed = strings(preview['warnings']).find((w) => w.startsWith('Publish time:'));
  assert.ok(echoed);
  assert.match(echoed, /Europe\/Sofia/);

  const applied = body(
    await tool('facebook_update_post').handler(
      {
        post_id: POST_ID,
        action: 'reschedule',
        scheduled_publish_time: SOON,
        apply: true,
        plan_id: 'plan-1',
      },
      ctx,
    ),
  );
  const write = findJson(
    fb,
    (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
  );
  assert.equal(jsonBody(write)['scheduled_publish_time'], Date.parse(SOON) / 1000);
  assert.equal(
    record(record(applied['result'])['schedule'])['pageTimezone'],
    'Europe/Sofia',
  );
});

test('update_post refuses a reschedule past 29 days from the original creation', async () => {
  const { fb, ctx } = makeCtx();
  stubPageTimezone(fb);
  stubPostState(fb, {
    id: POST_ID,
    is_published: false,
    // Created 25 days before "now": only 4 days of the 29-day allowance remain.
    created_time: '2025-12-07T00:00:00+0000',
  });

  const result = await tool('facebook_update_post').handler(
    {
      post_id: POST_ID,
      action: 'reschedule',
      scheduled_publish_time: '2026-02-01T12:00:00Z',
    },
    ctx,
  );
  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'schedule_reschedule_window');
  assert.match(String(parsed['help']), /ISO-8601/);
  assert.equal(fb.calls.filter(isWrite).length, 0);
});

test('update_post answers cancel_schedule with the delete path Graph actually offers', async () => {
  const { fb, ctx } = makeCtx();
  stubPostState(fb, { id: POST_ID, is_published: false });

  const result = await tool('facebook_update_post').handler(
    { post_id: POST_ID, action: 'cancel_schedule' },
    ctx,
  );
  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'unsupported_transition');
  assert.match(String(parsed['error']), /facebook_delete_post/);
  assert.match(String(parsed['error']), /plan_id/);
  assert.equal(fb.calls.filter(isWrite).length, 0);
});

test('update_post refuses an edit with no field to change', async () => {
  const { fb, ctx } = makeCtx();
  stubPostState(fb, { id: POST_ID, message: 'text' });
  const result = await tool('facebook_update_post').handler(
    { post_id: POST_ID, action: 'edit' },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.equal(body(result)['reason'], 'no_update_fields');
  assert.equal(fb.calls.filter(isWrite).length, 0);
});

test('update_post refuses to plan against a post it cannot read', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'GET' && req.path === `/${POST_ID}`,
    fbErr(
      new GraphApiError('Unsupported get request. Object does not exist', {
        code: 100,
        subcode: 33,
        httpStatus: 400,
      }),
    ),
  );

  const result = await tool('facebook_update_post').handler(
    { post_id: POST_ID, action: 'edit', message: 'new' },
    ctx,
  );
  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['field'], 'post_id');
  assert.match(String(parsed['hint']), /facebook_list_scheduled_posts/);
});

// ---------------------------------------------------------------------------
// facebook_delete_post
// ---------------------------------------------------------------------------

test('delete_post refuses to apply without a plan_id even with apply:true', async () => {
  const { fb, ctx } = makeCtx({ writeMode: 'apply' });
  stubPostState(fb, { id: POST_ID, message: 'still here' });

  const result = body(
    await tool('facebook_delete_post').handler({ post_id: POST_ID, apply: true }, ctx),
  );
  assert.equal(result['status'], 'preview');
  assert.equal(result['applied'], false);
  assert.equal(result['tier'], 'irreversible');
  assert.ok(
    strings(result['warnings']).some((w) => w.includes('plan_id')),
    'the caller is told WHY the apply degraded to a preview, not just that it did',
  );
  assert.equal(
    fb.calls.filter((req) => req.method === 'DELETE').length,
    0,
    'an unbound irreversible apply deletes nothing, even in FB_WRITE_MODE=apply',
  );
});

test('delete_post applies only when apply:true is bound to the plan id', async () => {
  const { fb, ctx } = makeCtx();
  stubPostState(fb, { id: POST_ID, message: 'still here' });
  fb.on(
    (req) => req.method === 'DELETE' && req.path === `/${POST_ID}`,
    fbOk({ success: true }),
  );

  const preview = body(
    await tool('facebook_delete_post').handler({ post_id: POST_ID }, ctx),
  );
  assert.equal(preview['planId'], 'plan-1');
  assert.match(String(preview['notPerformedNotice']), /still exists/);
  assert.ok(
    strings(preview['warnings']).some((w) => /permanent|cannot be undone/i.test(w)),
    'the preview states that the deletion is permanent',
  );

  const applied = body(
    await tool('facebook_delete_post').handler(
      { post_id: POST_ID, apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'applied');
  const result = record(applied['result']);
  assert.equal(result['deleted'], true);
  assert.equal(result['alreadyAbsent'], false);
  assert.equal(fb.calls.filter((req) => req.method === 'DELETE').length, 1);
});

test('delete_post reports an already-absent post as done without claiming it deleted it', async () => {
  const { fb, ctx } = makeCtx();
  stubPostState(fb, { id: POST_ID, message: 'here for now' }, 1);
  stubPostState(fb, { id: POST_ID, message: 'here for now' });
  fb.on(
    (req) => req.method === 'DELETE' && req.path === `/${POST_ID}`,
    fbErr(
      new GraphApiError('Unsupported delete request. Object does not exist', {
        code: 100,
        subcode: 33,
        httpStatus: 400,
      }),
    ),
  );

  await tool('facebook_delete_post').handler({ post_id: POST_ID }, ctx);
  const applied = body(
    await tool('facebook_delete_post').handler(
      { post_id: POST_ID, apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  const result = record(applied['result']);
  assert.equal(result['deleted'], false);
  assert.equal(result['alreadyAbsent'], true);
  assert.match(String(result['note']), /\S/);
});

test('delete_post diverges when the post disappears between preview and apply', async () => {
  const { fb, ctx } = makeCtx();
  stubPostState(fb, { id: POST_ID, message: 'here for now' }, 1);
  fb.on(
    (req) => req.method === 'GET' && req.path === `/${POST_ID}`,
    fbErr(
      new GraphApiError('Unsupported get request. Object does not exist', {
        code: 100,
        subcode: 33,
        httpStatus: 400,
      }),
    ),
  );

  await tool('facebook_delete_post').handler({ post_id: POST_ID }, ctx);
  const applied = body(
    await tool('facebook_delete_post').handler(
      { post_id: POST_ID, apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'diverged');
  assert.equal(
    fb.calls.filter((req) => req.method === 'DELETE').length,
    0,
    'divergence stops the delete',
  );
});

test('delete_post rejects a stale plan id instead of deleting on a guess', async () => {
  const { fb, ctx } = makeCtx();
  stubPostState(fb, { id: POST_ID, message: 'still here' });

  const result = await tool('facebook_delete_post').handler(
    { post_id: POST_ID, apply: true, plan_id: 'plan-does-not-exist' },
    ctx,
  );
  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['reason'], 'plan_not_found');
  assert.equal(parsed['tier'], 'irreversible');
  assert.equal(fb.calls.filter((req) => req.method === 'DELETE').length, 0);
});

// ---------------------------------------------------------------------------
// facebook_list_scheduled_posts
// ---------------------------------------------------------------------------

test('list_scheduled_posts returns the queue with a dual UTC + Page-local echo', async () => {
  const { fb, ctx } = makeCtx();
  stubPageTimezone(fb, 'Europe/Sofia');
  fb.on(
    (req) => req.path === `/${PAGE_ID}/scheduled_posts`,
    fbOk({
      data: [
        {
          id: '100_1',
          message: 'Queued',
          created_time: '2025-12-30T08:00:00+0000',
          scheduled_publish_time: 1_767_614_400,
          is_published: false,
        },
      ],
      paging: { cursors: { after: 'CUR2' }, next: 'https://graph.facebook.com/next' },
    }),
  );

  const result = await tool('facebook_list_scheduled_posts').handler({ limit: 5 }, ctx);
  assert.equal(result.isError, undefined);
  const parsed = body(result);
  assert.equal(parsed['pageId'], PAGE_ID);
  assert.equal(parsed['pageTimezone'], 'Europe/Sofia');
  assert.equal(parsed['nextCursor'], 'CUR2');

  const posts = parsed['posts'];
  assert.ok(Array.isArray(posts) && posts.length === 1);
  const post = record(posts[0]);
  assert.equal(post['id'], '100_1');
  assert.equal(post['isPublished'], false);
  const when = record(post['scheduledPublishTime']);
  assert.equal(when['epochSeconds'], 1_767_614_400);
  assert.equal(when['utc'], new Date(1_767_614_400 * 1000).toISOString());
  assert.equal(when['pageTimezone'], 'Europe/Sofia');
  assert.ok(typeof when['pageLocal'] === 'string' && when['pageLocal'].length > 0);

  const edge = findJson(fb, (req) => req.path === `/${PAGE_ID}/scheduled_posts`);
  assert.equal(record(edge.params)['limit'], 5);
  assert.equal(edge.token, PAGE_TOKEN);
});

test('list_scheduled_posts forwards the cursor and performs no write', async () => {
  const { fb, ctx } = makeCtx();
  stubPageTimezone(fb);
  fb.on((req) => req.path === `/${PAGE_ID}/scheduled_posts`, fbOk({ data: [] }));

  const parsed = body(
    await tool('facebook_list_scheduled_posts').handler({ after: 'CUR1' }, ctx),
  );
  assert.deepEqual(parsed['posts'], []);
  assert.equal(parsed['nextCursor'], null);
  assert.match(String(parsed['timezoneCaveat']), /\S/);

  const edge = findJson(fb, (req) => req.path === `/${PAGE_ID}/scheduled_posts`);
  assert.equal(record(edge.params)['after'], 'CUR1');
  assert.equal(fb.calls.filter(isWrite).length, 0);
});

test('list_scheduled_posts still lists the queue when the Page timezone is unreadable', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'GET' && req.path === `/${PAGE_ID}`,
    fbErr(new Error('no timezone for you')),
  );
  fb.on(
    (req) => req.path === `/${PAGE_ID}/scheduled_posts`,
    fbOk({ data: [{ id: '100_2', scheduled_publish_time: '1767614400' }] }),
  );

  const parsed = body(await tool('facebook_list_scheduled_posts').handler({}, ctx));
  assert.equal(parsed['pageTimezone'], null);
  const posts = parsed['posts'];
  assert.ok(Array.isArray(posts));
  const when = record(record(posts[0])['scheduledPublishTime']);
  assert.equal(when['epochSeconds'], 1_767_614_400, 'a string epoch is normalized');
  assert.equal(when['pageLocal'], null);
});

test('list_scheduled_posts honours the profile selector', async () => {
  const pages = createFakePageResolver({
    default: { pageId: PAGE_ID, name: 'Test Page', token: PAGE_TOKEN },
    pages: { 'brand-b': { pageId: '200', name: 'Brand B', token: 'EAA-B' } },
  });
  const { fb, ctx } = makeCtx({ pages });
  fb.on((req) => req.method === 'GET' && req.path === '/200', fbOk({ id: '200' }));
  fb.on((req) => req.path === '/200/scheduled_posts', fbOk({ data: [] }));

  const parsed = body(
    await tool('facebook_list_scheduled_posts').handler({ profile: 'brand-b' }, ctx),
  );
  assert.equal(parsed['pageId'], '200');
  assert.deepEqual(pages.resolveCalls, ['brand-b']);
});

// ---------------------------------------------------------------------------
// facebook_get_video_status
// ---------------------------------------------------------------------------

/** Stub the one probe the status tool makes (`GET /{video-id}?fields=status`). */
function stubVideoStatus(
  fb: FakeFbRequest,
  status: Record<string, unknown>,
  videoId = VIDEO_ID,
): void {
  fb.on(
    (req) => req.method === 'GET' && req.path === `/${videoId}`,
    fbOk({ id: videoId, status }),
  );
}

/** Assert the envelope really validates against the tool's declared outputSchema. */
function assertStatusEnvelope(result: ToolResult): Record<string, unknown> {
  const schema = tool('facebook_get_video_status').outputSchema;
  assert.ok(schema, 'the status envelope declares an outputSchema (CC-MCP-7)');
  const structured = result.structuredContent;
  assert.ok(structured, 'a server-owned envelope emits structuredContent');
  schema.parse(structured);
  return record(structured);
}

test('get_video_status probes GET /{video-id}?fields=status with the Page token', async () => {
  const { fb, ctx } = makeCtx();
  stubVideoStatus(fb, {
    video_status: 'processing',
    uploading_phase: { status: 'in_progress', bytes_transferred: 1024 },
  });

  const result = await tool('facebook_get_video_status').handler(
    { video_id: VIDEO_ID },
    ctx,
  );
  assert.equal(result.isError, undefined);

  const probe = findJson(fb, (req) => req.path === `/${VIDEO_ID}`);
  assert.equal(probe.method, 'GET');
  assert.equal(probe.host, 'graph', 'status reads go to the ordinary graph edge');
  assert.equal(record(probe.params)['fields'], 'status');
  assert.equal(probe.token, PAGE_TOKEN);
  assert.equal(probe.pageId, PAGE_ID);
  assert.equal(fb.calls.filter(isWrite).length, 0);
});

test('get_video_status reports an in-flight upload as non-terminal with the byte offset', async () => {
  const { fb, ctx } = makeCtx();
  stubVideoStatus(fb, {
    video_status: 'upload',
    uploading_phase: { status: 'in_progress', bytes_transferred: 4096 },
  });

  const result = await tool('facebook_get_video_status').handler(
    { video_id: VIDEO_ID },
    ctx,
  );
  const envelope = assertStatusEnvelope(result);
  assert.deepEqual(body(result), envelope, 'text body and structuredContent agree');
  assert.equal(envelope['videoId'], VIDEO_ID);
  assert.equal(envelope['pageId'], PAGE_ID);
  assert.equal(envelope['state'], 'uploading');
  assert.equal(envelope['terminal'], false);
  assert.equal(envelope['bytesTransferred'], 4096);
  assert.match(String(envelope['note']), /\S/);
  assert.equal(envelope['error'], undefined);
});

test('get_video_status reports a ready video as terminal and echoes the publishing phase', async () => {
  const { fb, ctx } = makeCtx();
  stubVideoStatus(fb, {
    video_status: 'ready',
    processing_phase: { status: 'complete' },
    publishing_phase: { status: 'complete', publish_status: 'published' },
  });

  const envelope = assertStatusEnvelope(
    await tool('facebook_get_video_status').handler({ video_id: VIDEO_ID }, ctx),
  );
  assert.equal(envelope['state'], 'ready');
  assert.equal(envelope['terminal'], true);
  assert.equal(envelope['publishStatus'], 'published');
  assert.equal(envelope['bytesTransferred'], undefined);
});

test('get_video_status surfaces the failure message on an errored video', async () => {
  const { fb, ctx } = makeCtx();
  stubVideoStatus(fb, {
    video_status: 'error',
    processing_phase: { status: 'error', errors: [{ message: 'codec unsupported' }] },
  });

  const envelope = assertStatusEnvelope(
    await tool('facebook_get_video_status').handler({ video_id: VIDEO_ID }, ctx),
  );
  assert.equal(envelope['state'], 'error');
  assert.equal(envelope['terminal'], true);
  assert.equal(envelope['error'], 'codec unsupported');
});

test('get_video_status treats an unrecognized status as still processing, never as done', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'GET' && req.path === `/${VIDEO_ID}`,
    fbOk({ id: VIDEO_ID }),
  );

  const envelope = assertStatusEnvelope(
    await tool('facebook_get_video_status').handler({ video_id: VIDEO_ID }, ctx),
  );
  assert.equal(envelope['state'], 'processing');
  assert.equal(envelope['terminal'], false, 'unknown means "poll again", not "ready"');
});

test('get_video_status honours the profile selector', async () => {
  const pages = createFakePageResolver({
    default: { pageId: PAGE_ID, name: 'Test Page', token: PAGE_TOKEN },
    pages: { 'brand-b': { pageId: '200', name: 'Brand B', token: 'EAA-B' } },
  });
  const { fb, ctx } = makeCtx({ pages });
  stubVideoStatus(fb, { video_status: 'ready' });

  const envelope = assertStatusEnvelope(
    await tool('facebook_get_video_status').handler(
      { video_id: VIDEO_ID, profile: 'brand-b' },
      ctx,
    ),
  );
  assert.equal(envelope['pageId'], '200');
  assert.deepEqual(pages.resolveCalls, ['brand-b']);
  assert.equal(findJson(fb, (req) => req.path === `/${VIDEO_ID}`).token, 'EAA-B');
});

test('get_video_status never invents a state when the probe itself fails', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'GET' && req.path === `/${VIDEO_ID}`,
    fbErr(new GraphApiError('Unsupported get request', { code: 100, httpStatus: 400 })),
  );

  // Same contract as every other tool here: the Graph error envelope belongs to
  // the server bootstrap, so a bare GraphApiError travels out untouched rather
  // than being flattened into a fifth, invented status.
  await assert.rejects(
    () => tool('facebook_get_video_status').handler({ video_id: VIDEO_ID }, ctx),
    GraphApiError,
  );
});

// ---------------------------------------------------------------------------
// G-TOOL-3 — Reels lifecycle honesty (doc 10 §2)
// ---------------------------------------------------------------------------

test('delete_post and list_scheduled_posts state the Reels answer as unverified', () => {
  for (const name of ['facebook_delete_post', 'facebook_list_scheduled_posts']) {
    const description = tool(name).description;
    assert.match(description, /Reels/, `${name} must speak about Reels at all`);
    assert.match(
      description,
      /UNVERIFIED/,
      `${name} must not imply a verified Reels answer`,
    );
  }
});
