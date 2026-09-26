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
import { GraphApiError, ambiguousWriteAction } from '../core/index.js';
import type {
  Confirmer,
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
import {
  PLAN_IN_PROGRESS_MESSAGE,
  WriteGateError,
  createWriteGate,
} from '../mcp/index.js';
import { createPostsPackage } from './posts.js';
import { VIDEO_ID_MESSAGE, type WriteToolContext } from './shared.js';

/**
 * The gate requires an out-of-band confirmation seam to exist. These suites never
 * reach a high-consequence apply, so they hand in one that always approves rather
 * than leaving the seam missing — which the gate now (correctly) refuses.
 */
const ALWAYS_CONFIRMS: Confirmer = {
  confirm: () => Promise.resolve({ confirmed: true, method: 'operator_token' }),
};

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const PAGE_ID = '100';
const PAGE_TOKEN = 'EAA-PAGE-TOKEN';
const POST_ID = '100_555';
/**
 * A bare video id — deliberately NOT a "{page}_{post}" post id (CC-MEDIA-7),
 * and digits-only, which is the shape Graph's video node ids actually take and
 * the shape `video_id` arguments enforce.
 */
const VIDEO_ID = '987654321';
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
      confirmer: ALWAYS_CONFIRMS,
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

/**
 * The arguments this package has cleared for the per-call stderr line: the Page
 * selector, the write-gate flags, the ids Graph itself puts in a URL, and the
 * enum/boolean knobs that say WHICH mutation was armed. Every model-composed
 * value — post text, captions, links, file paths — and the operator's
 * `confirm_token` are absent by construction, so a new allowlist entry has to be
 * argued into this set before the audit below will accept it.
 */
const SAFE_TO_LOG: ReadonlySet<string> = new Set([
  'profile',
  'apply',
  'plan_id',
  'post_id',
  'action',
  'published',
  'scheduled_publish_time',
  'video_state',
  'is_hidden',
  'is_pinned',
]);

test('every posts log allowlist names real, non-content arguments', () => {
  // `logFields` is the ONLY thing that reaches the per-call log line
  // (04 §"Log hygiene"), so the declarations are audited rather than trusted:
  // this table IS the reviewed decision, and a tool missing from it must stay
  // silent. Both silent tools are reads whose arguments are the profile selector
  // and paging, which is why they say nothing at all.
  const created = ['profile', 'apply', 'plan_id', 'published', 'scheduled_publish_time'];
  const expected: Record<string, readonly string[]> = {
    facebook_create_post: created,
    facebook_create_photo_post: created,
    facebook_create_video_post: created,
    facebook_create_reel: [
      'profile',
      'apply',
      'plan_id',
      'video_state',
      'scheduled_publish_time',
    ],
    facebook_update_post: [
      'profile',
      'apply',
      'plan_id',
      'post_id',
      'action',
      'is_hidden',
      'is_pinned',
      'scheduled_publish_time',
    ],
    facebook_delete_post: ['profile', 'apply', 'plan_id', 'post_id'],
  };

  for (const spec of createPostsPackage().tools) {
    const want = expected[spec.name];
    if (want === undefined) {
      assert.equal(
        spec.logFields,
        undefined,
        `${spec.name} started logging without being audited here`,
      );
      continue;
    }
    assert.deepEqual(
      [...(spec.logFields ?? [])],
      [...want],
      `${spec.name}'s allowlist changed without this audit changing with it`,
    );

    // The zod shape is the argument list: a key that is not in it would log
    // nothing at all while reading like a control.
    const { shape } = spec.inputSchema as unknown as {
      readonly shape: Record<string, unknown>;
    };
    for (const key of want) {
      assert.ok(key in shape, `${spec.name} logs ${key}, which is not an argument`);
      assert.ok(
        SAFE_TO_LOG.has(key),
        `${spec.name} logs ${key}, which is not cleared for stderr`,
      );
    }
  }

  // The named dangers, spelled out so the reason survives a refactor of the set:
  // the operator's out-of-band secret, and every argument that carries text a
  // model composed or a path into FB_MEDIA_DIR.
  for (const banned of [
    'confirm_token',
    'message',
    'caption',
    'description',
    'title',
    'link',
    'photo',
    'photos',
    'video',
    'child_attachments',
  ]) {
    assert.ok(!SAFE_TO_LOG.has(banned), `${banned} must never be cleared for stderr`);
  }
});

// ---------------------------------------------------------------------------
// facebook_create_post — plan then apply
// ---------------------------------------------------------------------------

test('create_post publishing stays plan-bound under FB_WRITE_MODE=apply', async () => {
  // The package comment used to credit `writeModeDefault: 'plan'` for this. It
  // is not the reason: an explicitly set FB_WRITE_MODE=apply overrides a package
  // default outright (`effectiveWriteMode`). `requirePlanId: publishesNow(...)`
  // is, which is why a bare apply:true still only previews here — while the same
  // tool applies in one call when the post reaches nobody (published:false).
  const { fb, ctx } = makeCtx({ writeMode: 'apply' });

  const preview = body(
    await tool('facebook_create_post').handler(
      { message: 'One shot', published: true, apply: true },
      ctx,
    ),
  );
  assert.equal(preview['status'], 'preview');
  assert.equal(preview['applied'], false);
  assert.ok(
    strings(preview['warnings']).some((w) => w.includes('plan_id')),
    'the caller is told WHY the apply degraded to a preview',
  );
  assert.equal(
    jsonCalls(fb).filter((req) => req.method === 'POST').length,
    0,
    'no write mode may publish to an audience without a plan id',
  );
});

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

// C2: the http layer can hand back a GraphApiError whose `httpStatus` is a 2xx
// and whose action is `ambiguous` (the body was lost after the status line was
// read). Its status says nothing about whether the post landed — the category
// does — so the journal must record `attempted`, exactly as it does for a 5xx.
test('create_post journals an ambiguous 2xx (lost body) as attempted, not failed', async () => {
  const { fb, ctx, journal } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
    fbErr(
      new GraphApiError(
        'ambiguous write outcome (response body lost after HTTP 200) — do NOT retry; verify first',
        {
          code: 0,
          httpStatus: 200,
          action: ambiguousWriteAction({ detail: 'response body lost after HTTP 200' }),
        },
      ),
    ),
  );

  await tool('facebook_create_post').handler({ message: 'Maybe posted' }, ctx);

  await assert.rejects(
    () =>
      tool('facebook_create_post').handler(
        { message: 'Maybe posted', apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    /do NOT retry/,
  );

  const entry = journal.entries[0];
  assert.ok(entry);
  assert.equal(
    entry.outcome,
    'attempted',
    'an ambiguous outcome is ambiguous whatever its HTTP status; a clean failure invites a duplicate',
  );
});

// Same shape on the photo edge: `uploadPhoto` turns a 2xx without a photo id into
// an ambiguous GraphApiError carrying the 2xx status. A photo may now exist.
test('create_photo_post journals a 2xx with no photo id as attempted, not failed', async () => {
  const { fb, ctx, journal } = makeCtx();
  fb.on((req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`, fbOk({}));

  await tool('facebook_create_photo_post').handler(
    { photo: 'https://cdn.example/a.jpg', caption: 'Look' },
    ctx,
  );

  await assert.rejects(
    () =>
      tool('facebook_create_photo_post').handler(
        {
          photo: 'https://cdn.example/a.jpg',
          caption: 'Look',
          apply: true,
          plan_id: 'plan-1',
        },
        ctx,
      ),
    /returned no photo id/,
  );

  const entry = journal.entries[0];
  assert.ok(entry);
  assert.equal(entry.tool, 'facebook_create_photo_post');
  assert.equal(
    entry.outcome,
    'attempted',
    'a 2xx that carried no id may have created a photo; it must not be journaled as failed',
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

test('create_post never tells a scheduled post or a draft to verify on the published listing', async () => {
  const cases = [
    {
      input: { message: 'Later', scheduled_publish_time: SOON },
      tool: /facebook_list_scheduled_posts/,
    },
    { input: { message: 'Draft', published: false }, tool: /Meta Business Suite/ },
  ];
  for (const { input, tool: expected } of cases) {
    const { fb, ctx } = makeCtx();
    fb.on(
      (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
      fbOk({ id: '100_779' }),
    );
    await tool('facebook_create_post').handler(input, ctx);
    const applied = body(
      await tool('facebook_create_post').handler(
        { ...input, apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    );
    assert.equal(applied['status'], 'applied');
    const note = String(record(applied['result'])['verifyNote']);
    assert.doesNotMatch(note, /facebook_list_posts/, `${input.message}: ${note}`);
    assert.match(note, expected);
  }
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
  // A 4xx is Graph REJECTING the carousel post: nothing references the
  // children, so this call owns their cleanup. (A 5xx or a lost response is a
  // different case — see the unconfirmed-carousel test below.)
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
    fbErr(new GraphApiError('feed write failed', { code: 100, httpStatus: 400 })),
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

test('create_post never deletes the children of a carousel post that may have landed', async () => {
  // A 5xx or a transport fault on POST /feed is the C2-ambiguous case: the
  // carousel post may exist and reference every child photo. Deleting those
  // photos would gut a live post, and "no post references them" would be false.
  // The journal already files this as `attempted`; the error record must agree,
  // keep the photos, and hand back their ids to reconcile.
  const failures: readonly GraphApiError[] = [
    new GraphApiError('feed write failed', { code: 1, httpStatus: 500 }),
    new GraphApiError('socket hang up', { code: 1, httpStatus: 0 }),
  ];
  for (const failure of failures) {
    const { fb, ctx, journal } = makeCtx();
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
      fbErr(failure),
    );
    fb.on((req) => req.method === 'DELETE', fbOk({ success: true }));

    const photos = ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'];
    await tool('facebook_create_post').handler({ message: 'Gallery', photos }, ctx);
    const result = await tool('facebook_create_post').handler(
      { message: 'Gallery', photos, apply: true, plan_id: 'plan-1' },
      ctx,
    );

    const label = `HTTP ${String(failure.httpStatus)}`;
    assert.equal(
      fb.calls.filter((req) => req.method === 'DELETE').length,
      0,
      `${label}: no child photo of a possibly-live post is deleted`,
    );
    assert.equal(result.isError, true, label);
    const parsed = body(result);
    assert.equal(parsed['reason'], 'carousel_post_unconfirmed', label);
    assert.equal(parsed['outcome'], 'attempted', label);
    assert.deepEqual(parsed['photoIds'], ['ph-1', 'ph-2'], label);
    assert.doesNotMatch(String(parsed['hint']), /no post references them/, label);
    assert.match(String(parsed['hint']), /[Vv]erify/, label);
    assert.equal(journal.entries[0]?.outcome, 'attempted', `${label}: journal outcome`);
  }
});

test('create_post points an unconfirmed carousel at the listing that can show it', async () => {
  // A scheduled carousel sits on the scheduled queue and a draft on no listing
  // this server reads: sending either to facebook_list_posts reads as "it did not
  // land", and the model then deletes the photos of a live post or re-sends it.
  const cases = [
    {
      input: {},
      expected: /facebook_list_posts\b[^.]*created_time/,
      absent: /filtered to/,
    },
    {
      input: { scheduled_publish_time: SOON },
      expected: /facebook_list_scheduled_posts/,
      absent: /facebook_list_posts\b/,
    },
    {
      input: { published: false },
      expected: /Meta Business Suite/,
      absent: /facebook_list_posts\b/,
    },
  ];
  for (const { input, expected, absent } of cases) {
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

    const photos = ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'];
    const args = { message: 'Gallery', photos, ...input };
    await tool('facebook_create_post').handler(args, ctx);
    const result = await tool('facebook_create_post').handler(
      { ...args, apply: true, plan_id: 'plan-1' },
      ctx,
    );

    const label = JSON.stringify(input);
    const parsed = body(result);
    assert.equal(parsed['reason'], 'carousel_post_unconfirmed', label);
    const hint = String(parsed['hint']);
    assert.match(hint, expected, `${label}: ${hint}`);
    if (absent !== undefined) assert.doesNotMatch(hint, absent, `${label}: ${hint}`);
  }
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

test('create_post names a child upload of unknown outcome as a structured field, not only in prose', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`,
    fbOk({ id: 'ph-1' }),
    1,
  );
  // A non-Graph fault mid-request: the photo may exist, its id never came back.
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`,
    fbErr(new Error('socket hang up')),
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
  const cleanup = record(body(result)['cleanup']);
  // `orphans` is empty — there is no id to delete — so a caller reading the
  // structured fields alone would conclude nothing was left behind.
  assert.deepEqual(cleanup['orphans'], []);
  assert.deepEqual(cleanup['unconfirmedUploads'], [
    { photo: 2, error: 'socket hang up' },
  ]);
  assert.match(String(cleanup['operatorNotice']), /photo 2/);
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

test('create_video_post tells a scheduled or draft video where it can be verified', async () => {
  // Regression coverage: a scheduled or unpublished video is not on the
  // published post listing, so its verify note must not send the model there.
  const cases = [{ scheduled_publish_time: SOON }, { published: false }];
  for (const input of cases) {
    const { fb, ctx } = makeCtx();
    fb.on(
      (req) =>
        req.protocol === 'json' &&
        req.host === 'graph-video' &&
        req.path === `/${PAGE_ID}/videos`,
      fbOk({ id: 'vid-3' }),
    );
    const args = { video: 'https://cdn.example/clip.mp4', ...input };
    await tool('facebook_create_video_post').handler(args, ctx);
    const applied = body(
      await tool('facebook_create_video_post').handler(
        { ...args, apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    );
    const label = JSON.stringify(input);
    assert.equal(applied['status'], 'applied', label);
    const note = String(record(applied['result'])['verifyNote']);
    assert.doesNotMatch(note, /facebook_list_posts/, `${label}: ${note}`);
    assert.match(note, /facebook_get_video_status/, `${label}: ${note}`);
  }
});

test('create_video_post does not send an id-less scheduled or draft video to a feed listing', async () => {
  // A file_url create whose 2xx named no id may still have created the video.
  // A scheduled or draft video is on no feed listing, so "check a feed listing"
  // reads as "it did not land" and invites the duplicate CC-PUB-1 exists to stop.
  const cases = [{ scheduled_publish_time: SOON }, { published: false }];
  for (const input of cases) {
    const { fb, ctx } = makeCtx();
    fb.on(
      (req) =>
        req.protocol === 'json' &&
        req.host === 'graph-video' &&
        req.path === `/${PAGE_ID}/videos`,
      fbOk(undefined),
    );
    const args = { video: 'https://cdn.example/clip.mp4', ...input };
    await tool('facebook_create_video_post').handler(args, ctx);
    const applied = body(
      await tool('facebook_create_video_post').handler(
        { ...args, apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    );
    const label = JSON.stringify(input);
    assert.equal(applied['outcome'], 'attempted', label);
    const note = String(record(applied['result'])['processingNote']);
    assert.doesNotMatch(note, /feed listing/, `${label}: ${note}`);
    assert.match(note, /Meta Business Suite/, `${label}: ${note}`);
  }
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

test('create_reel keeps Meta\u2019s own explanation and trace id on a phase failure', async (t) => {
  const media = await mediaFixture(t, 'reel.mp4', 512);
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  fb.on(
    (req) => req.protocol === 'json' && req.path === `/${PAGE_ID}/video_reels`,
    fbErr(
      new GraphApiError('Invalid parameter', {
        code: 100,
        subcode: 1363040,
        httpStatus: 400,
        fbtraceId: 'AbCtrace',
        userTitle: 'Video Too Long',
        userMessage: 'Reels must be 90 seconds or shorter.',
      }),
    ),
  );

  await tool('facebook_create_reel').handler({ video: media.name }, ctx);
  const result = await tool('facebook_create_reel').handler(
    { video: media.name, apply: true, plan_id: 'plan-1' },
    ctx,
  );

  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.match(String(parsed['reason']), /^reel_/);
  // "Invalid parameter" alone is not actionable: Meta's own title and message
  // are the reason the model can act on, and the trace id is what support asks for.
  assert.equal(parsed['userMessage'], 'Reels must be 90 seconds or shorter.');
  assert.equal(parsed['userTitle'], 'Video Too Long');
  assert.equal(parsed['subcode'], 1363040);
  assert.equal(parsed['fbtraceId'], 'AbCtrace');
});

test('create_reel does not invent a Graph code for a locally raised refusal', async (t) => {
  const media = await mediaFixture(t, 'reel.mp4', 512);
  const { ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  const parsed = body(
    await tool('facebook_create_reel').handler(
      { video: media.name, video_state: 'SCHEDULED' },
      ctx,
    ),
  );
  assert.equal(parsed['reason'], 'reel_schedule');
  assert.equal(
    Object.hasOwn(parsed, 'code'),
    false,
    'no Graph round trip, so no Graph code',
  );
  assert.equal(Object.hasOwn(parsed, 'httpStatus'), false);
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

test('create_reel names the uploaded video_id when the finish phase fails', async (t) => {
  const media = await mediaFixture(t, 'reel.mp4', 512);
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  fb.on(
    (req) =>
      req.protocol === 'json' &&
      req.path === `/${PAGE_ID}/video_reels` &&
      record(req.params)['upload_phase'] === 'finish',
    fbErr(new GraphApiError('An unknown error occurred', { code: 1, httpStatus: 500 })),
  );
  stubReelPhases(fb, { success: true });

  await tool('facebook_create_reel').handler({ video: media.name }, ctx);
  const result = await tool('facebook_create_reel').handler(
    { video: media.name, apply: true, plan_id: 'plan-1' },
    ctx,
  );

  assert.equal(result.isError, true);
  const parsed = body(result);
  assert.equal(parsed['phase'], 'finish');
  assert.equal(
    parsed['videoId'],
    'reel-1',
    'the uploaded video exists at Meta, so the caller gets its id to inspect or delete it',
  );
});

// Only the finish phase can publish a Reel. An ambiguous start leaves at most an
// unused upload reservation, so journaling it as `attempted` would tell the
// operator a Reel may be live when none can be.
test('create_reel journals an ambiguous start as failed and an ambiguous finish as attempted', async (t) => {
  const media = await mediaFixture(t, 'reel.mp4', 512);
  const ambiguous = (): GraphApiError =>
    new GraphApiError('network fault: socket hang up', {
      code: 0,
      httpStatus: 0,
      action: {
        category: 'ambiguous',
        retryable: false,
        operatorText: 'outcome unknown',
      },
    });
  for (const phase of ['start', 'finish'] as const) {
    const { fb, ctx, journal } = makeCtx({
      settings: makeSettings({ mediaDir: media.dir }),
    });
    fb.on(
      (req) =>
        req.protocol === 'json' &&
        req.path === `/${PAGE_ID}/video_reels` &&
        record(req.params)['upload_phase'] === phase,
      fbErr(ambiguous()),
    );
    stubReelPhases(fb, { success: true });

    await tool('facebook_create_reel').handler({ video: media.name }, ctx);
    const result = await tool('facebook_create_reel').handler(
      { video: media.name, apply: true, plan_id: 'plan-1' },
      ctx,
    );

    assert.equal(result.isError, true, phase);
    assert.equal(body(result)['phase'], phase);
    const entry = journal.entries.at(-1);
    assert.ok(entry, phase);
    assert.equal(entry.outcome, phase === 'finish' ? 'attempted' : 'failed', phase);
  }
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

test('update_post names the read that shows the change it applied, not a publish note', async () => {
  // An edit or a reschedule is not a publish: "A publish that times out ...
  // verify with facebook_list_posts" sends the model to a listing that cannot
  // show a changed text or a moved time (a rescheduled post is not on it at all).
  const cases = [
    {
      input: { action: 'edit', message: 'new text' },
      state: { id: POST_ID, message: 'old', is_published: true },
      expected: /facebook_get_post/,
    },
    {
      input: { action: 'reschedule', scheduled_publish_time: SOON },
      state: {
        id: POST_ID,
        is_published: false,
        created_time: '2025-12-20T10:00:00+0000',
      },
      expected: /facebook_list_scheduled_posts/,
    },
  ];
  for (const { input, state, expected } of cases) {
    const { fb, ctx } = makeCtx();
    stubPageTimezone(fb, 'Europe/Sofia');
    stubPostState(fb, state);
    fb.on(
      (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
      fbOk({ success: true }),
    );
    const args = { post_id: POST_ID, ...input };
    await tool('facebook_update_post').handler(args, ctx);
    const applied = body(
      await tool('facebook_update_post').handler(
        { ...args, apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    );
    assert.equal(applied['status'], 'applied', input.action);
    const note = String(record(applied['result'])['verifyNote']);
    assert.doesNotMatch(note, /A publish/, `${input.action}: ${note}`);
    assert.doesNotMatch(note, /facebook_list_posts/, `${input.action}: ${note}`);
    assert.match(note, expected, `${input.action}: ${note}`);
  }
});

test('update_post publish_now keeps the publish verify note', async () => {
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
  const args = { post_id: POST_ID, action: 'publish_now' };
  await tool('facebook_update_post').handler(args, ctx);
  const applied = body(
    await tool('facebook_update_post').handler(
      { ...args, apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'applied');
  const note = String(record(applied['result'])['verifyNote']);
  assert.match(note, /A publish_now/);
  assert.match(note, /facebook_get_post/);
});

test('update_post publish_now names a check the caller can actually run on the plan it holds', async () => {
  // publish_now sends only is_published:true — the plan carries no message text
  // and no created_time to match on a listing, and the post id is known. The
  // one read that shows whether it went live is the post itself.
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
  const args = { post_id: POST_ID, action: 'publish_now' };
  const preview = body(await tool('facebook_update_post').handler(args, ctx));
  const applied = body(
    await tool('facebook_update_post').handler(
      { ...args, apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'applied');
  const note = String(record(applied['result'])['verifyNote']);
  const warning = strings(preview['warnings']).find((w) => /times out/.test(w));
  for (const [label, text] of [
    ['verifyNote', note],
    ['preview warning', String(warning)],
  ] as const) {
    assert.match(text, /facebook_get_post/, `${label}: ${text}`);
    assert.match(text, /is_published/, `${label}: ${text}`);
    assert.doesNotMatch(text, /message text/, `${label}: ${text}`);
  }
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

test('update_post publish_now refuses a post that is already live instead of claiming it published it', async () => {
  // is_published:true on a live post changes nothing; a preview saying
  // "Publish scheduled/draft post ... right now" and an `applied` result would
  // tell the operator this call put the post in front of the audience.
  const { fb, ctx } = makeCtx();
  stubPostState(fb, {
    id: POST_ID,
    message: 'live since yesterday',
    is_published: true,
    created_time: '2025-12-31T10:00:00+0000',
  });
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
    fbOk({ success: true }),
  );

  const result = await tool('facebook_update_post').handler(
    { post_id: POST_ID, action: 'publish_now' },
    ctx,
  );
  const parsed = body(result);
  assert.equal(
    result.isError,
    true,
    `expected a refusal, got ${String(parsed['summary'])}`,
  );
  assert.equal(parsed['field'], 'action');
  assert.match(String(parsed['message'] ?? parsed['error']), /already published/);
  assert.equal(fb.calls.filter(isWrite).length, 0);
});

test('update_post reschedule refuses a post that is already live instead of claiming it moved it', async () => {
  // A live post has no publish time left to move: previewing "Move post ... to
  // <time>" and applying it would tell the operator the post now waits for that
  // instant, while it stays in front of the audience.
  const { fb, ctx } = makeCtx();
  stubPageTimezone(fb);
  stubPostState(fb, {
    id: POST_ID,
    message: 'live since yesterday',
    is_published: true,
    created_time: '2025-12-31T10:00:00+0000',
  });
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
    fbOk({ success: true }),
  );

  const result = await tool('facebook_update_post').handler(
    { post_id: POST_ID, action: 'reschedule', scheduled_publish_time: SOON },
    ctx,
  );
  const parsed = body(result);
  assert.equal(
    result.isError,
    true,
    `expected a refusal, got ${String(parsed['summary'])}`,
  );
  assert.equal(parsed['field'], 'action');
  assert.match(String(parsed['error']), /already published/);
  assert.match(String(parsed['hint']), /facebook_delete_post/);
  assert.equal(fb.calls.filter(isWrite).length, 0);
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
  // The re-read after the refused DELETE agrees the post is gone.
  stubPostGoneAfterDelete(fb);
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
// Graph acknowledgements — read, never assumed
// ---------------------------------------------------------------------------
//
// `fbRequest<T>` CASTS the parsed body to `T` without validating it
// (`data as T`, src/core/http.ts), so every one of these edges can hand the
// handler a body its declared type says is impossible. Two distinct ways to get
// a write wrong follow from that, and both are worse than an error: a bodiless
// 2xx used to throw a TypeError on the SUCCESS path, reporting a completed
// publish or delete as failed and inviting a retry that duplicates a post or
// hunts for one already gone; and `?? true` only rejects null/undefined, so a
// `success` Facebook sent as "false" or 0 was recorded as a completed write.
//
// A create's ack is its id. A 2xx that names no post is the same epistemic
// state the http layer files as C2-ambiguous when the body is lost after the
// status line: something may exist, and this call cannot vouch for it. So the
// envelope says `not_applied` + `attempted` (verify first), never `applied`
// beside `postId:null` — an "applied" with no handle reads as "published" and
// invites the blind retry that duplicates it.

test('create_post reports a 2xx that names no post as attempted, not as applied', async () => {
  // `{ success: true }` is the update ack, not the create ack: it confirms that
  // Graph answered, not that a post exists, and it carries nothing to verify by.
  const { fb, ctx, journal } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
    fbOk({ success: true }),
  );

  await tool('facebook_create_post').handler({ message: 'Ack without a post' }, ctx);
  const applied = body(
    await tool('facebook_create_post').handler(
      { message: 'Ack without a post', apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );

  assert.equal(applied['status'], 'not_applied');
  assert.equal(applied['applied'], false);
  assert.equal(applied['outcome'], 'attempted');
  assert.match(String(applied['notPerformedNotice']), /unconfirmed/);
  assert.equal(record(applied['result'])['postId'], null);
  const entry = journal.entries[0];
  assert.ok(entry);
  assert.equal(entry.outcome, 'attempted');
});

test('create_post reports a bodiless 2xx as attempted with no id, not as a crash', async () => {
  // Graph acknowledged the feed write with an empty body. A post MAY exist; the
  // handle for it never arrived, so the result must say exactly that.
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
    fbOk(undefined),
  );

  await tool('facebook_create_post').handler(
    { message: 'Acknowledged, unnamed', published: true },
    ctx,
  );
  const applied = body(
    await tool('facebook_create_post').handler(
      {
        message: 'Acknowledged, unnamed',
        published: true,
        apply: true,
        plan_id: 'plan-1',
      },
      ctx,
    ),
  );

  assert.equal(applied['status'], 'not_applied');
  assert.equal(applied['outcome'], 'attempted');
  assert.equal(record(applied['result'])['postId'], null);
});

test('create_post ignores a post_id that is not a usable string', async () => {
  // An id of the wrong type is not a handle: passing 12345 or "" to a follow-up
  // call is worse than admitting the id never arrived — and without a handle
  // the write is unconfirmed, not applied.
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/feed`,
    fbOk({ post_id: '', id: 12345 }),
  );

  await tool('facebook_create_post').handler({ message: 'Odd ack' }, ctx);
  const applied = body(
    await tool('facebook_create_post').handler(
      { message: 'Odd ack', apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );

  assert.equal(applied['status'], 'not_applied');
  assert.equal(applied['outcome'], 'attempted');
  assert.equal(record(applied['result'])['postId'], null);
});

test('create_video_post reports a bodiless 2xx from the file_url edge as attempted', async () => {
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) =>
      req.protocol === 'json' &&
      req.host === 'graph-video' &&
      req.path === `/${PAGE_ID}/videos`,
    fbOk(undefined),
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

  assert.equal(applied['status'], 'not_applied');
  assert.equal(applied['outcome'], 'attempted');
  const result = record(applied['result']);
  assert.equal(result['videoId'], null);
  assert.equal(result['delivery'], 'file-url');
});

test('update_post treats a bodiless 2xx as done and a non-true success as refused', async () => {
  // Absence confirms: the transport already turned an error payload into a
  // throw, so an empty 2xx here is Facebook saying "done". A `success` that is
  // PRESENT and not `true` is the opposite, whatever its JSON type.
  const cases: readonly [unknown, boolean][] = [
    [undefined, true],
    [true, true],
    [false, false],
    [null, false],
    ['', false],
    [{}, true],
    [{ success: true }, true],
    [{ success: false }, false],
    [{ success: 'false' }, false],
    [{ success: 0 }, false],
  ];

  for (const [ack, expected] of cases) {
    const { fb, ctx } = makeCtx();
    stubPostState(fb, { id: POST_ID, message: 'before' });
    fb.on((req) => req.method === 'POST' && req.path === `/${POST_ID}`, fbOk(ack));

    await tool('facebook_update_post').handler(
      { post_id: POST_ID, action: 'edit', message: 'after' },
      ctx,
    );
    const applied = body(
      await tool('facebook_update_post').handler(
        {
          post_id: POST_ID,
          action: 'edit',
          message: 'after',
          apply: true,
          plan_id: 'plan-1',
        },
        ctx,
      ),
    );

    // The envelope follows the acknowledgement: a refused edit is `not_applied`.
    assert.equal(applied['status'], expected ? 'applied' : 'not_applied');
    assert.equal(applied['applied'], expected);
    assert.equal(
      record(applied['result'])['success'],
      expected,
      `acknowledgement ${JSON.stringify(ack)} must read as ${String(expected)}`,
    );
  }
});

test('delete_post never claims a post is gone on an acknowledgement that refused', async () => {
  // The most consequential of the four: `deleted: true` tells the model to stop
  // looking. A `success` of "false" or 0 is Facebook declining the delete, and
  // `?? true` used to record both as a completed removal.
  const cases: readonly [unknown, boolean][] = [
    [undefined, true],
    [true, true],
    [false, false],
    [null, false],
    ['ok', false],
    [{ success: true }, true],
    [{ success: false }, false],
    [{ success: 'false' }, false],
    [{ success: 0 }, false],
  ];

  for (const [ack, expected] of cases) {
    const { fb, ctx } = makeCtx();
    stubPostState(fb, { id: POST_ID, message: 'still here' });
    fb.on((req) => req.method === 'DELETE' && req.path === `/${POST_ID}`, fbOk(ack));

    await tool('facebook_delete_post').handler({ post_id: POST_ID }, ctx);
    const applied = body(
      await tool('facebook_delete_post').handler(
        { post_id: POST_ID, apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    );

    // The envelope follows the acknowledgement: a refused delete is `not_applied`.
    assert.equal(applied['status'], expected ? 'applied' : 'not_applied');
    assert.equal(applied['applied'], expected);
    const result = record(applied['result']);
    assert.equal(
      result['deleted'],
      expected,
      `acknowledgement ${JSON.stringify(ack)} must read as ${String(expected)}`,
    );
    // A refused delete is still not the "already gone" end state — that one is
    // reached through the absent-object error path, never through a body.
    assert.equal(result['alreadyAbsent'], false);
  }
});

test('a plan another call is still applying is answered "wait", not "re-plan"', async () => {
  // The gate refuses a racing apply with plan_not_found and says the plan is in
  // progress. The generic recovery hint ("run WITHOUT apply, then apply the new
  // plan") is exactly the second write racing the first that the gate refused.
  const { fb, ctx } = makeCtx();
  stubPostState(fb, { id: POST_ID, message: 'still here' });
  const writeCtx = ctx as WriteToolContext;
  const racing: WriteToolContext = {
    ...writeCtx,
    writeGate: {
      execute: (action) =>
        action.apply === true
          ? Promise.reject(
              new WriteGateError('plan_not_found', PLAN_IN_PROGRESS_MESSAGE, action),
            )
          : writeCtx.writeGate.execute(action),
    },
  };

  const refused = body(
    await tool('facebook_delete_post').handler(
      { post_id: POST_ID, apply: true, plan_id: 'plan-1' },
      racing,
    ),
  );
  assert.equal(refused['reason'], 'plan_not_found');
  const hint = String(refused['hint']);
  assert.match(hint, /[Ww]ait for its result/);
  assert.doesNotMatch(hint, /WITHOUT apply|fresh preview/);
});

// A refused acknowledgement is a write that did not land. The result already
// says so (`success:false` / `deleted:false`); the envelope and the journal must
// agree with it instead of stamping the same call `applied` (CC-MOD-5 rule for a
// resolved-but-unapplied write; the gate reads it from `classifyResult`).
test('update_post envelopes and journals a refused acknowledgement as not applied', async () => {
  const refusals: readonly unknown[] = [
    { success: false },
    { success: 'false' },
    { success: 0 },
  ];

  for (const ack of refusals) {
    const { fb, ctx, journal } = makeCtx();
    stubPostState(fb, { id: POST_ID, message: 'before' });
    fb.on((req) => req.method === 'POST' && req.path === `/${POST_ID}`, fbOk(ack));

    await tool('facebook_update_post').handler(
      { post_id: POST_ID, action: 'edit', message: 'after' },
      ctx,
    );
    const applied = body(
      await tool('facebook_update_post').handler(
        {
          post_id: POST_ID,
          action: 'edit',
          message: 'after',
          apply: true,
          plan_id: 'plan-1',
        },
        ctx,
      ),
    );

    const label = JSON.stringify(ack);
    assert.equal(applied['status'], 'not_applied', `${label}: envelope status`);
    assert.equal(applied['applied'], false, `${label}: envelope applied flag`);
    assert.equal(record(applied['result'])['success'], false, `${label}: result success`);
    assert.equal(journal.entries.length, 1, `${label}: exactly one journal entry`);
    assert.equal(journal.entries[0]?.outcome, 'failed', `${label}: journal outcome`);
  }

  // Positive control: a confirming acknowledgement still lands as applied.
  const { fb, ctx, journal } = makeCtx();
  stubPostState(fb, { id: POST_ID, message: 'before' });
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
    fbOk({ success: true }),
  );
  await tool('facebook_update_post').handler(
    { post_id: POST_ID, action: 'edit', message: 'after' },
    ctx,
  );
  const applied = body(
    await tool('facebook_update_post').handler(
      {
        post_id: POST_ID,
        action: 'edit',
        message: 'after',
        apply: true,
        plan_id: 'plan-1',
      },
      ctx,
    ),
  );
  assert.equal(applied['status'], 'applied');
  assert.equal(applied['applied'], true);
  assert.equal(journal.entries[0]?.outcome, 'applied');
});

test('delete_post envelopes and journals a refused acknowledgement as not applied', async () => {
  const refusals: readonly unknown[] = [
    { success: false },
    { success: 'false' },
    { success: 0 },
  ];

  for (const ack of refusals) {
    const { fb, ctx, journal } = makeCtx();
    stubPostState(fb, { id: POST_ID, message: 'still here' });
    fb.on((req) => req.method === 'DELETE' && req.path === `/${POST_ID}`, fbOk(ack));

    await tool('facebook_delete_post').handler({ post_id: POST_ID }, ctx);
    const applied = body(
      await tool('facebook_delete_post').handler(
        { post_id: POST_ID, apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    );

    const label = JSON.stringify(ack);
    assert.equal(applied['status'], 'not_applied', `${label}: envelope status`);
    assert.equal(applied['applied'], false, `${label}: envelope applied flag`);
    const result = record(applied['result']);
    assert.equal(result['deleted'], false, `${label}: result deleted`);
    assert.equal(result['alreadyAbsent'], false, `${label}: result alreadyAbsent`);
    assert.equal(journal.entries.length, 1, `${label}: exactly one journal entry`);
    assert.equal(journal.entries[0]?.outcome, 'failed', `${label}: journal outcome`);
  }
});

test('delete_post keeps the already-absent end state as applied in the envelope and journal', async () => {
  // The post is gone, which is the state the operator asked for: nothing to
  // reconcile, so this is not a failure. `deleted:false` + `alreadyAbsent:true`
  // already says the tool did not do the removing.
  const { fb, ctx, journal } = makeCtx();
  stubPostGoneAfterDelete(fb);
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

  assert.equal(applied['status'], 'applied');
  assert.equal(applied['applied'], true);
  assert.equal(record(applied['result'])['alreadyAbsent'], true);
  assert.equal(journal.entries[0]?.outcome, 'applied');
});

/**
 * Graph answers the post GET with "does not exist" once a DELETE has been sent —
 * the post really is gone after the delete, which is what the already-absent
 * path must be able to prove with a re-read.
 */
function stubPostGoneAfterDelete(fb: FakeFbRequest): void {
  fb.on(
    (req) =>
      req.method === 'GET' &&
      req.path === `/${POST_ID}` &&
      fb.calls.some((call) => call.method === 'DELETE'),
    fbErr(
      new GraphApiError('Unsupported get request. Object does not exist', {
        code: 100,
        subcode: 33,
        httpStatus: 400,
      }),
    ),
  );
}

test('delete_post does not call a post it just read "already absent" when the re-read still finds it', async () => {
  // 100/33 on a DELETE means "does not exist, cannot be loaded due to missing
  // permissions, or does not support this operation" — the answer Graph gives
  // for a post another app created. The post was readable a moment ago; a
  // blind `alreadyAbsent:true` + `applied` tells the operator a still-live
  // post is gone.
  const { fb, ctx, journal } = makeCtx();
  stubPostState(fb, { id: POST_ID, message: 'still here' });
  fb.on(
    (req) => req.method === 'DELETE' && req.path === `/${POST_ID}`,
    fbErr(
      new GraphApiError(
        'Unsupported delete request. Object with ID does not exist, cannot be loaded due to missing permissions, or does not support this operation',
        { code: 100, subcode: 33, httpStatus: 400 },
      ),
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
  assert.equal(result['alreadyAbsent'], false, 'the post is still readable');
  assert.equal(result['deleted'], false);
  assert.equal(applied['status'], 'not_applied');
  assert.match(String(result['note']), /still/i);
  assert.equal(journal.entries[0]?.outcome, 'failed');
});

test('update_post does not let a 100/33 refusal of a post it just read pass as "the post is gone"', async () => {
  // 100/33 on `POST /{post-id}` is Graph's "does not exist, cannot be loaded due
  // to missing permissions, or does not support this operation" — the answer
  // for an edit of a post another app (or a human in the Page UI) created.
  // Propagated raw it is mapped `not_found` ("treat it as already gone"), yet
  // this very call just read the post. A re-read that still finds it proves the
  // post exists and was NOT changed.
  for (const [action, extra] of [
    ['edit', { message: 'after' }],
    ['publish_now', {}],
  ] as const) {
    const { fb, ctx, journal } = makeCtx();
    stubPostState(fb, { id: POST_ID, message: 'before', is_published: false });
    fb.on(
      (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
      fbErr(
        new GraphApiError(
          'Unsupported post request. Object with ID does not exist, cannot be loaded due to missing permissions, or does not support this operation',
          { code: 100, subcode: 33, httpStatus: 400 },
        ),
      ),
    );

    await tool('facebook_update_post').handler(
      { post_id: POST_ID, action, ...extra },
      ctx,
    );
    const applied = body(
      await tool('facebook_update_post').handler(
        { post_id: POST_ID, action, ...extra, apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    );

    const result = record(applied['result']);
    assert.equal(applied['status'], 'not_applied', `${action}: envelope status`);
    assert.equal(result['success'], false, `${action}: result success`);
    assert.match(String(result['note']), /still readable/, `${action}: note`);
    assert.match(String(result['note']), /NOT changed/, `${action}: note`);
    assert.match(
      String(result['note']),
      /SAME app/,
      `${action}: names the same-app rule`,
    );
    assert.equal(journal.entries[0]?.outcome, 'failed', `${action}: journal outcome`);
  }
});

test('update_post keeps the 100/33 refusal when the re-read confirms the post is gone', async () => {
  const { fb, ctx } = makeCtx();
  const absent = new GraphApiError(
    'Unsupported post request. Object with ID does not exist, cannot be loaded due to missing permissions, or does not support this operation',
    { code: 100, subcode: 33, httpStatus: 400 },
  );
  // Present for the preview and the apply pre-read, gone for the re-read.
  stubPostState(fb, { id: POST_ID, message: 'before' }, 2);
  fb.on((req) => req.method === 'GET' && req.path === `/${POST_ID}`, fbErr(absent));
  fb.on((req) => req.method === 'POST' && req.path === `/${POST_ID}`, fbErr(absent));

  await tool('facebook_update_post').handler(
    { post_id: POST_ID, action: 'edit', message: 'after' },
    ctx,
  );
  await assert.rejects(
    tool('facebook_update_post').handler(
      {
        post_id: POST_ID,
        action: 'edit',
        message: 'after',
        apply: true,
        plan_id: 'plan-1',
      },
      ctx,
    ),
    (err: unknown) => err === absent,
  );
});

/** Register the three resumable-upload phases for a local video; `finish` is the variable. */
function stubVideoUploadPhases(fb: FakeFbRequest, finish: unknown): void {
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
    fbOk(finish),
  );
}

test('create_video_post envelopes and journals a declined finish as attempted, not applied', async (t) => {
  // The video object exists from the `start` phase on, so a `finish` Graph
  // declines is not "nothing landed": the operator has an object to reconcile
  // (verify, then publish or delete). That is what `attempted` is defined for —
  // a plain `failed` would invite the retry that creates a duplicate
  // (CC-PUB-1), and `applied` beside `accepted:false` is two answers to one
  // question.
  const refusals: readonly unknown[] = [
    { video_id: 'vid-1', success: false },
    { video_id: 'vid-1', success: 'false' },
    { video_id: 'vid-1', success: 0 },
  ];

  for (const ack of refusals) {
    const media = await mediaFixture(t, 'clip.mp4', 64);
    const { fb, ctx, journal } = makeCtx({
      settings: makeSettings({ mediaDir: media.dir }),
    });
    stubVideoUploadPhases(fb, ack);

    await tool('facebook_create_video_post').handler({ video: media.name }, ctx);
    const applied = body(
      await tool('facebook_create_video_post').handler(
        { video: media.name, apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    );

    const label = JSON.stringify(ack);
    assert.equal(applied['status'], 'not_applied', `${label}: envelope status`);
    assert.equal(applied['applied'], false, `${label}: envelope applied flag`);
    assert.equal(applied['outcome'], 'attempted', `${label}: envelope outcome`);
    const result = record(applied['result']);
    assert.equal(result['accepted'], false, `${label}: result accepted`);
    assert.equal(result['videoId'], 'vid-1', `${label}: the id to reconcile survives`);
    assert.equal(journal.entries.length, 1, `${label}: exactly one journal entry`);
    assert.equal(journal.entries[0]?.outcome, 'attempted', `${label}: journal outcome`);
    const notice = String(applied['notPerformedNotice']);
    assert.match(notice, /ATTEMPTED/, `${label}: ${notice}`);
    assert.match(notice, /[Vv]erify/, `${label}: ${notice}`);
    assert.match(notice, /duplicate/, `${label}: ${notice}`);
    assert.doesNotMatch(notice, /nothing landed/, `${label}: ${notice}`);
  }

  // Positive control: a confirming (or bodiless) finish still lands as applied.
  for (const ack of [{ video_id: 'vid-1', success: true }, { video_id: 'vid-1' }]) {
    const media = await mediaFixture(t, 'clip.mp4', 64);
    const { fb, ctx, journal } = makeCtx({
      settings: makeSettings({ mediaDir: media.dir }),
    });
    stubVideoUploadPhases(fb, ack);

    await tool('facebook_create_video_post').handler({ video: media.name }, ctx);
    const applied = body(
      await tool('facebook_create_video_post').handler(
        { video: media.name, apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    );

    const label = JSON.stringify(ack);
    assert.equal(applied['status'], 'applied', `${label}: envelope status`);
    assert.equal(applied['applied'], true, `${label}: envelope applied flag`);
    assert.equal(applied['outcome'], 'applied', `${label}: envelope outcome`);
    assert.equal(
      record(applied['result'])['accepted'],
      true,
      `${label}: result accepted`,
    );
    assert.equal(journal.entries[0]?.outcome, 'applied', `${label}: journal outcome`);
  }
});

test('create_video_post does not tell the caller a declined finish is a finished upload being transcoded', async (t) => {
  // `processingNote` is what the model reads to decide what to say next. On a
  // finish Graph declined, "a finished upload ... Meta still has to transcode
  // it ... the video id comes back immediately" is false: the upload was NOT
  // committed and nothing is being prepared for publishing. The note must say
  // it was declined and name the id to reconcile.
  const media = await mediaFixture(t, 'clip.mp4', 64);
  const { fb, ctx } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  stubVideoUploadPhases(fb, { video_id: 'vid-1', success: false });

  await tool('facebook_create_video_post').handler({ video: media.name }, ctx);
  const applied = body(
    await tool('facebook_create_video_post').handler(
      { video: media.name, apply: true, plan_id: 'plan-1' },
      ctx,
    ),
  );

  const result = record(applied['result']);
  assert.equal(result['accepted'], false);
  const note = String(result['processingNote']);
  assert.doesNotMatch(note, /finished upload/, note);
  assert.doesNotMatch(note, /transcode/, note);
  assert.match(note, /DECLINED/, note);
  assert.match(note, /vid-1/, note);
  assert.match(note, /facebook_get_video_status/, note);
});

test('create_video_post does not promise a video id when the file_url edge named none', async () => {
  // A 2xx from the file_url edge that names no id is the unconfirmed state
  // (`attempted`, `videoId:null`). "The video id comes back immediately" beside
  // `videoId:null` tells the model an id exists that it was never given.
  const { fb, ctx } = makeCtx();
  fb.on(
    (req) =>
      req.protocol === 'json' &&
      req.host === 'graph-video' &&
      req.path === `/${PAGE_ID}/videos`,
    fbOk({}),
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
  assert.equal(result['videoId'], null);
  const note = String(result['processingNote']);
  assert.doesNotMatch(note, /video id comes back/, note);
  assert.match(note, /no video id/i, note);
  assert.match(note, /[Vv]erify/, note);
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

test('get_video_status refuses a {page-id}_{post-id} composite before any Graph call', async () => {
  const { fb, ctx } = makeCtx();
  // Stub the edge anyway: if the guard ever regresses, the call succeeds and
  // `fb.calls` proves the composite was spent on a request that cannot resolve.
  stubVideoStatus(fb, { video_status: 'ready' }, POST_ID);

  await assert.rejects(
    () => tool('facebook_get_video_status').handler({ video_id: POST_ID }, ctx),
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      // Both substrings are asserted by the live `reels/status-guardrail` smoke,
      // so they are contract, not prose.
      assert.match(message, /VIDEO id/);
      assert.match(message, /digits only/);
      return true;
    },
  );
  assert.equal(fb.calls.length, 0, 'the composite never reached Graph');
});

test('get_video_status refuses every id shape that could escape the path', async () => {
  const { fb, ctx } = makeCtx();

  for (const videoId of ['..', '.', 'me/videos', '123?fields=id', 'vid-777', '12 34']) {
    await assert.rejects(
      () => tool('facebook_get_video_status').handler({ video_id: videoId }, ctx),
      /VIDEO id/,
      `"${videoId}" must not be accepted as a video id`,
    );
  }
  assert.equal(fb.calls.length, 0, 'nothing but a bare numeric id is sent');
});

test('get_video_status and reel_insights enforce one shared video-id contract', () => {
  // One definition, two tools: the divergence this collapses is what let a post
  // composite through `facebook_get_video_status` while `facebook_reel_insights`
  // rejected it locally.
  const schema = tool('facebook_get_video_status').inputSchema;
  const rejected = schema.safeParse({ video_id: POST_ID });
  assert.equal(rejected.success, false);
  assert.equal(
    rejected.success ? '' : (rejected.error.issues[0]?.message ?? ''),
    `${VIDEO_ID_MESSAGE} facebook_create_video_post returns it as \`videoId\`.`,
  );
  // A pasted id with stray whitespace is judged on its digits, not its padding.
  assert.equal(schema.safeParse({ video_id: `  ${VIDEO_ID} ` }).success, true);
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

// ---------------------------------------------------------------------------
// Path containment — an id must never be able to address another Graph node
// ---------------------------------------------------------------------------

test('update_post and delete_post refuse a post id that would address another Graph node', async () => {
  // `containPathname` receives the path ALREADY joined, so a `/` inside an
  // interpolated id becomes a new SEGMENT rather than an escaped character: a
  // `post_id` of "{page-id}/conversations" turns an advertised post write into a
  // request against the inbox, under the same Page token and the same HTTP
  // method. The fake below answers ANY path, so a regression shows up as the
  // call the last assertion says must not exist.
  for (const name of ['facebook_update_post', 'facebook_delete_post']) {
    const { fb, ctx } = makeCtx();
    fb.on(() => true, fbOk({ id: POST_ID, is_published: true, success: true }));

    for (const escaped of [
      `${PAGE_ID}/conversations`,
      'me/accounts',
      `${POST_ID}/comments?filter=stream`,
      '..',
      '.',
    ]) {
      const args =
        name === 'facebook_update_post'
          ? { post_id: escaped, action: 'edit', message: 'edited' }
          : { post_id: escaped };
      await assert.rejects(
        () => tool(name).handler(args, ctx),
        /bare Graph ID/,
        `${name} must refuse post_id ${JSON.stringify(escaped)}`,
      );
    }
    assert.equal(fb.calls.length, 0, `${name} let an escaped post id reach Graph`);
  }
});

test('the post-id shape still accepts every id Graph actually mints', () => {
  // Regression coverage: containment must not narrow Graph's ID space. These
  // shapes passed before the check existed and must keep passing after it.
  for (const name of ['facebook_update_post', 'facebook_delete_post']) {
    for (const ok of [
      POST_ID,
      '100200300_999888777',
      '1234567890',
      'act_123',
      't_1234567890',
      'v1.2-3_4',
    ]) {
      const args =
        name === 'facebook_update_post'
          ? { post_id: ok, action: 'edit', message: 'edited' }
          : { post_id: ok };
      assert.equal(
        tool(name).inputSchema.safeParse(args).success,
        true,
        `${name} must accept post_id ${JSON.stringify(ok)}`,
      );
    }
  }
});

test('feed schedule descriptions state the minimum lead the validator enforces', () => {
  // resolveSchedule accepts a time exactly 10 minutes ahead (the feed window is
  // inclusive), so "more than 10 minutes" makes the model pad a valid time or
  // doubt an accepted one. Reels are different: their window is strictly more
  // than 10 minutes, and their descriptions name 29 days, not 75.
  const feedFields: string[] = [];
  for (const spec of createPostsPackage().tools) {
    const { shape } = spec.inputSchema as unknown as {
      readonly shape: Record<string, { readonly description?: string } | undefined>;
    };
    const description = shape.scheduled_publish_time?.description ?? '';
    if (!/75 days/.test(description)) continue;
    feedFields.push(spec.name);
    assert.doesNotMatch(description, /more than 10 minutes/, spec.name);
    assert.match(description, /at least 10 minutes/, spec.name);
  }
  assert.ok(
    feedFields.length >= 2,
    `expected create and reschedule fields, got ${feedFields.join(',')}`,
  );
});

// ---------------------------------------------------------------------------
// update/delete failure classification — a write that may have landed
// ---------------------------------------------------------------------------

// The http client re-throws the caller's cancellation RAW (it is terminal and
// never retried) — including when it fires while the response body is still
// arriving, i.e. after Graph has already processed the request. That error is
// not a GraphApiError, so it carries no `ambiguous` stamp: without a classifier
// of its own, the gate files it as `failed`, and a journal that says a DELETE
// failed invites a second delete of a post the first one already removed.
function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError');
}

test('delete_post journals a delete cancelled in flight as attempted, not failed', async () => {
  const { fb, ctx, journal } = makeCtx();
  stubPostState(fb, { id: POST_ID, message: 'still here' });
  fb.on(
    (req) => req.method === 'DELETE' && req.path === `/${POST_ID}`,
    fbErr(abortError()),
  );

  await tool('facebook_delete_post').handler({ post_id: POST_ID }, ctx);
  await assert.rejects(
    () =>
      tool('facebook_delete_post').handler(
        { post_id: POST_ID, apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    /aborted/,
  );

  assert.equal(journal.entries.length, 1);
  assert.equal(
    journal.entries[0]?.outcome,
    'attempted',
    'a cancelled DELETE may already have removed the post; `failed` invites a second delete',
  );
});

test('update_post journals an edit cancelled in flight as attempted, not failed', async () => {
  const { fb, ctx, journal } = makeCtx();
  stubPostState(fb, { id: POST_ID, message: 'before' });
  fb.on(
    (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
    fbErr(abortError()),
  );

  await tool('facebook_update_post').handler(
    { post_id: POST_ID, action: 'edit', message: 'after' },
    ctx,
  );
  await assert.rejects(
    () =>
      tool('facebook_update_post').handler(
        {
          post_id: POST_ID,
          action: 'edit',
          message: 'after',
          apply: true,
          plan_id: 'plan-1',
        },
        ctx,
      ),
    /aborted/,
  );

  assert.equal(journal.entries.length, 1);
  assert.equal(
    journal.entries[0]?.outcome,
    'attempted',
    'a cancelled edit may already have overwritten the text; `failed` asserts it did not',
  );
});

test('update_post and delete_post still journal a clean Graph refusal or a provably unsent write as failed', async () => {
  const refusals: readonly [string, Error][] = [
    [
      '4xx refusal',
      new GraphApiError('(#200) Permissions error', { code: 200, httpStatus: 400 }),
    ],
    [
      'connect-phase network fault',
      new GraphApiError('network error: connect ECONNREFUSED', {
        code: 0,
        httpStatus: 0,
      }),
    ],
  ];
  for (const [label, error] of refusals) {
    {
      const { fb, ctx, journal } = makeCtx();
      stubPostState(fb, { id: POST_ID, message: 'still here' });
      fb.on((req) => req.method === 'DELETE' && req.path === `/${POST_ID}`, fbErr(error));
      await tool('facebook_delete_post').handler({ post_id: POST_ID }, ctx);
      await tool('facebook_delete_post')
        .handler({ post_id: POST_ID, apply: true, plan_id: 'plan-1' }, ctx)
        .catch(() => undefined);
      assert.equal(journal.entries[0]?.outcome, 'failed', `delete, ${label}`);
    }
    {
      const { fb, ctx, journal } = makeCtx();
      stubPostState(fb, { id: POST_ID, message: 'before' });
      fb.on((req) => req.method === 'POST' && req.path === `/${POST_ID}`, fbErr(error));
      await tool('facebook_update_post').handler(
        { post_id: POST_ID, action: 'edit', message: 'after' },
        ctx,
      );
      await tool('facebook_update_post')
        .handler(
          {
            post_id: POST_ID,
            action: 'edit',
            message: 'after',
            apply: true,
            plan_id: 'plan-1',
          },
          ctx,
        )
        .catch(() => undefined);
      assert.equal(journal.entries[0]?.outcome, 'failed', `update, ${label}`);
    }
  }
});

test('get_video_status names the field facebook_create_video_post actually returns', () => {
  // The create result carries the id as `videoId`; a model told to look for
  // `video_id` in it finds nothing and may conclude no video was created.
  const { description } = tool('facebook_get_video_status');
  assert.doesNotMatch(description, /returns a video_id/);
  assert.match(description, /`videoId`/);
});

// ---------------------------------------------------------------------------
// Page-token eviction on a failure this package shapes itself (C1)
// ---------------------------------------------------------------------------

// The server evicts a derived Page token when a tool THROWS a token-dead Graph
// error (190, 102, or 100 with a stale-object subcode). The failures below are
// caught here and returned as an `isError` record, so the server never sees
// them: unless this package evicts the token itself, every retry for the next
// cache TTL replays the same dead token and fails the same way.
function tokenDeadErrors(): readonly [string, GraphApiError][] {
  return [
    [
      '190',
      new GraphApiError('Error validating access token', { code: 190, httpStatus: 400 }),
    ],
    ['102', new GraphApiError('Session has expired', { code: 102, httpStatus: 400 })],
    [
      '100/33',
      new GraphApiError('Unsupported post request', {
        code: 100,
        subcode: 33,
        httpStatus: 400,
      }),
    ],
  ];
}

test('create_reel drops the cached Page token when a phase fails on a dead token', async (t) => {
  const media = await mediaFixture(t, 'reel.mp4', 512);
  for (const [label, error] of tokenDeadErrors()) {
    const { fb, ctx, pages } = makeCtx({
      settings: makeSettings({ mediaDir: media.dir }),
    });
    fb.on(
      (req) => req.protocol === 'json' && req.path === `/${PAGE_ID}/video_reels`,
      fbErr(error),
    );
    await tool('facebook_create_reel').handler({ video: media.name }, ctx);
    const result = await tool('facebook_create_reel').handler(
      { video: media.name, apply: true, plan_id: 'plan-1' },
      ctx,
    );
    assert.equal(result.isError, true, label);
    assert.match(String(body(result)['reason']), /^reel_/, label);
    assert.deepEqual(pages.invalidated, [PAGE_ID], `${label}: Page token evicted`);
  }
});

test('create_reel keeps the cached Page token on a phase failure that is not token-dead', async (t) => {
  const media = await mediaFixture(t, 'reel.mp4', 512);
  const { fb, ctx, pages } = makeCtx({ settings: makeSettings({ mediaDir: media.dir }) });
  fb.on(
    (req) => req.protocol === 'json' && req.path === `/${PAGE_ID}/video_reels`,
    fbErr(
      new GraphApiError('Invalid parameter', {
        code: 100,
        subcode: 1363040,
        httpStatus: 400,
      }),
    ),
  );
  await tool('facebook_create_reel').handler({ video: media.name }, ctx);
  const result = await tool('facebook_create_reel').handler(
    { video: media.name, apply: true, plan_id: 'plan-1' },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.deepEqual(
    pages.invalidated,
    [],
    'a content refusal says nothing about the token',
  );
});

test('create_post drops the cached Page token when the carousel post fails on a dead token', async () => {
  for (const [label, error] of tokenDeadErrors()) {
    const { fb, ctx, pages } = makeCtx();
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
      fbErr(error),
    );
    fb.on((req) => req.method === 'DELETE', fbOk({ success: true }));

    const photos = ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'];
    await tool('facebook_create_post').handler({ message: 'Gallery', photos }, ctx);
    const result = await tool('facebook_create_post').handler(
      { message: 'Gallery', photos, apply: true, plan_id: 'plan-1' },
      ctx,
    );
    assert.equal(result.isError, true, label);
    assert.equal(body(result)['reason'], 'carousel_post_failed', label);
    assert.deepEqual(pages.invalidated, [PAGE_ID], `${label}: Page token evicted`);
  }
});

test('create_post drops the cached Page token when a carousel child upload fails on a dead token', async () => {
  for (const [label, error] of tokenDeadErrors()) {
    const { fb, ctx, pages } = makeCtx();
    fb.on(
      (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`,
      fbOk({ id: 'ph-1' }),
      1,
    );
    fb.on(
      (req) => req.method === 'POST' && req.path === `/${PAGE_ID}/photos`,
      fbErr(error),
      1,
    );
    fb.on((req) => req.method === 'DELETE', fbOk({ success: true }));

    const photos = ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'];
    await tool('facebook_create_post').handler({ photos }, ctx);
    const result = await tool('facebook_create_post').handler(
      { photos, apply: true, plan_id: 'plan-1' },
      ctx,
    );
    assert.equal(result.isError, true, label);
    assert.equal(body(result)['reason'], 'multi_photo_upload_failed', label);
    assert.deepEqual(pages.invalidated, [PAGE_ID], `${label}: Page token evicted`);
  }
});

// ---------------------------------------------------------------------------
// update/delete — a 5xx the http layer stamped ambiguous
// ---------------------------------------------------------------------------

test('update_post and delete_post journal a 5xx the transport stamped ambiguous as attempted', async () => {
  const ambiguous = (): GraphApiError =>
    new GraphApiError('ambiguous write outcome (HTTP 502) — do NOT retry; verify first', {
      code: 1,
      httpStatus: 502,
      action: ambiguousWriteAction({ detail: 'HTTP 502' }),
    });
  {
    const { fb, ctx, journal } = makeCtx();
    stubPostState(fb, { id: POST_ID, message: 'still here' });
    fb.on(
      (req) => req.method === 'DELETE' && req.path === `/${POST_ID}`,
      fbErr(ambiguous()),
    );
    await tool('facebook_delete_post').handler({ post_id: POST_ID }, ctx);
    await assert.rejects(() =>
      tool('facebook_delete_post').handler(
        { post_id: POST_ID, apply: true, plan_id: 'plan-1' },
        ctx,
      ),
    );
    assert.equal(journal.entries.length, 1);
    assert.equal(
      journal.entries[0]?.outcome,
      'attempted',
      'a 5xx DELETE may have removed the post; `failed` invites a second delete',
    );
  }
  {
    const { fb, ctx, journal } = makeCtx();
    stubPostState(fb, { id: POST_ID, message: 'before' });
    fb.on(
      (req) => req.method === 'POST' && req.path === `/${POST_ID}`,
      fbErr(ambiguous()),
    );
    await tool('facebook_update_post').handler(
      { post_id: POST_ID, action: 'edit', message: 'after' },
      ctx,
    );
    await assert.rejects(() =>
      tool('facebook_update_post').handler(
        {
          post_id: POST_ID,
          action: 'edit',
          message: 'after',
          apply: true,
          plan_id: 'plan-1',
        },
        ctx,
      ),
    );
    assert.equal(journal.entries.length, 1);
    assert.equal(
      journal.entries[0]?.outcome,
      'attempted',
      'a 5xx edit may have landed; `failed` asserts it did not',
    );
  }
});
