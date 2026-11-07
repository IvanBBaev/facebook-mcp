// Shared fixtures, fakes and helpers for the `posts` tool package tests, split out of
// `posts.test.ts` (R17). The test files import from here.
//
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

import { type TestContext } from 'node:test';
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
} from '../../core/fakes/index.js';
import { GraphApiError } from '../../core/index.js';
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
} from '../../core/index.js';
import { createWriteGate } from '../../mcp/index.js';
import { createPostsPackage } from '../../tools/posts.js';
import { type WriteToolContext } from '../../tools/shared.js';

/**
 * The gate requires an out-of-band confirmation seam to exist. These suites never
 * reach a high-consequence apply, so they hand in one that always approves rather
 * than leaving the seam missing — which the gate now (correctly) refuses.
 */
export const ALWAYS_CONFIRMS: Confirmer = {
  confirm: () => Promise.resolve({ confirmed: true, method: 'operator_token' }),
};

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

export const PAGE_ID = '100';
export const PAGE_TOKEN = 'EAA-PAGE-TOKEN';
export const POST_ID = '100_555';
/** 2026-01-01T00:00:00Z — a fixed "now" so every schedule assertion is exact. */
export const NOW_MS = Date.parse('2026-01-01T00:00:00.000Z');
/** Comfortably inside the 10 min … 29 d window both feed posts and Reels share. */
export const SOON = '2026-01-05T12:00:00+00:00';

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
  readonly ctx: ToolContext;
  /** Everything the handler pushed through `ctx.reportProgress`. */
  readonly progress: readonly ProgressUpdate[];
  /** The write journal the gate writes through — inspected for outcome classification. */
  readonly journal: MemoryJournal;
}

export function makeCtx(
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
export function tool(name: string): ToolSpec {
  const spec = createPostsPackage().tools.find((t) => t.name === name);
  assert.ok(spec, `expected a tool named ${name}`);
  return spec;
}

/** Parse a text-only ToolResult body as an object. */
export function body(result: ToolResult): Record<string, unknown> {
  const text = result.content[0]?.text ?? '';
  return JSON.parse(text) as Record<string, unknown>;
}

export function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null, 'expected an object');
  return value as Record<string, unknown>;
}

export function strings(value: unknown): string[] {
  assert.ok(Array.isArray(value), 'expected an array');
  return value as string[];
}

/** All json requests the handler issued, in order. */
export function jsonCalls(fb: FakeFbRequest): JsonRequest[] {
  return fb.calls.filter((req): req is JsonRequest => req.protocol === 'json');
}

export function findJson(
  fb: FakeFbRequest,
  match: (req: JsonRequest) => boolean,
): JsonRequest {
  const req = jsonCalls(fb).find(match);
  assert.ok(req, 'expected a matching json request');
  return req;
}

export function jsonBody(req: JsonRequest): Record<string, unknown> {
  return record(req.body);
}

export const isWrite = (req: FbRequest): boolean =>
  req.method !== 'GET' || req.protocol !== 'json';

/** Stub the display-only Page-timezone read (`GET /{page-id}?fields=id,timezone`). */
export function stubPageTimezone(fb: FakeFbRequest, timezone = 'Europe/Sofia'): void {
  fb.on(
    (req) => req.method === 'GET' && req.path === `/${PAGE_ID}`,
    fbOk({ id: PAGE_ID, timezone }),
  );
}

/** Stub the divergence pre-read of one post (`GET /{post-id}`). */
export function stubPostState(
  fb: FakeFbRequest,
  node: Record<string, unknown>,
  times?: number,
): void {
  fb.on((req) => req.method === 'GET' && req.path === `/${POST_ID}`, fbOk(node), times);
}

export interface MediaFixture {
  readonly dir: string;
  readonly name: string;
  readonly bytes: number;
}

/** A real FB_MEDIA_DIR holding one small file — the video/Reels flows need bytes. */
export async function mediaFixture(
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

/**
 * Graph answers the post GET with "does not exist" once a DELETE has been sent —
 * the post really is gone after the delete, which is what the already-absent
 * path must be able to prove with a re-read.
 */
export function stubPostGoneAfterDelete(fb: FakeFbRequest): void {
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

/** Register the three resumable-upload phases for a local video; `finish` is the variable. */
export function stubVideoUploadPhases(fb: FakeFbRequest, finish: unknown): void {
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
