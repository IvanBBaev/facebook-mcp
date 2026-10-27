// Tests for the `page_admin` tool package (organic F8):
// facebook_update_page_profile through the production write gate.
//
// Covered: the package invariants (opt-in, plan by default, one reversible
// tool), the preview with before → after lines and no POST, the plan-bound
// apply that sends only the changing fields and re-reads them, a profile
// changed after the preview diverging without a write, the verdicts (accepted
// but read back differently ⇒ attempted; success:false ⇒ failed; a refused POST
// ⇒ failed, a lost answer ⇒ attempted), and the validation refusals that send
// nothing.
//
// Placeholder tokens only; never a real secret in a fixture.

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
import { GraphApiError } from '../core/index.js';
import type {
  Confirmer,
  FbRequest,
  JsonRequest,
  Logger,
  ResolvedPage,
  Settings,
  ToolResult,
  ToolSpec,
  WriteMode,
} from '../core/index.js';
import { createWriteGate } from '../mcp/index.js';

import { createPageAdminPackage } from './page-admin.js';
import type { WriteToolContext } from './shared.js';

const ALWAYS_CONFIRMS: Confirmer = {
  confirm: () => Promise.resolve({ confirmed: true, method: 'operator_token' }),
};

const TOOL = 'facebook_update_page_profile';

const PAGE: ResolvedPage = {
  pageId: '900',
  name: 'Test Page',
  token: 'PAGE-TOKEN-PLACEHOLDER',
};

/** The profile as Graph reports it before the edit. */
const PROFILE = {
  id: PAGE.pageId,
  about: 'Synthetic Page for the unit suite.',
  phone: '+1 555 0100',
  website: 'https://example.com',
  hours: { mon_1_open: '09:00', mon_1_close: '18:00' },
  is_always_open: false,
  temporary_status: 'OPERATING_AS_USUAL',
};

function makeSettings(overrides: Partial<Settings> = {}): Settings {
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

function makeLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

interface Harness {
  readonly fb: FakeFbRequest;
  readonly journal: MemoryJournal;
  readonly ctx: WriteToolContext;
}

/** A context wired like the server's, in the package's own `plan` mode. */
function makeHarness(opts: { readonly writeMode?: WriteMode } = {}): Harness {
  const fb = createFakeFbRequest();
  const pages = createFakePageResolver({ default: PAGE });
  const clock = createFakeClock(Date.parse('2026-10-27T10:00:00Z'));
  const journal = createMemoryJournal(clock);
  let planSeq = 0;
  const writeGate = createWriteGate({
    confirmer: ALWAYS_CONFIRMS,
    clock,
    journal,
    defaultWriteMode: opts.writeMode ?? 'plan',
    newPlanId: () => `plan-${String(++planSeq)}`,
  });
  const ctx: WriteToolContext = {
    settings: makeSettings(),
    fbRequest: fb.fn,
    pages,
    logger: makeLogger(),
    redactor: createFakeRedactor({ secrets: [PAGE.token] }),
    clock,
    journal,
    writeGate,
  };
  return { fb, journal, ctx };
}

const PACKAGE = createPageAdminPackage();

function tool(name: string): ToolSpec {
  const spec = PACKAGE.tools.find((t) => t.name === name);
  assert.ok(spec, `expected a tool named ${name}`);
  return spec;
}

function body(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '') as Record<string, unknown>;
}

function obj(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function isJson(req: FbRequest): req is JsonRequest {
  return req.protocol === 'json';
}

function posts(fb: FakeFbRequest): JsonRequest[] {
  return fb.calls.filter(isJson).filter((r) => r.method === 'POST');
}

const isRead = (r: FbRequest): boolean => r.method === 'GET' && r.path === '/900';
const isWrite = (r: FbRequest): boolean => r.method === 'POST' && r.path === '/900';

function isValidation(err: unknown): boolean {
  return err instanceof GraphApiError && err.code === 100 && err.httpStatus === 400;
}

/** Preview, then apply the plan it returned. */
async function previewThenApply(
  fb: FakeFbRequest,
  ctx: WriteToolContext,
  args: Record<string, unknown>,
): Promise<{ preview: Record<string, unknown>; applied: Record<string, unknown> }> {
  const update = tool(TOOL);
  const preview = body(await update.handler(args, ctx));
  assert.equal(preview.status, 'preview');
  assert.equal(posts(fb).length, 0, 'a preview must not write');
  const applied = body(
    await update.handler({ ...args, apply: true, plan_id: preview.planId }, ctx),
  );
  return { preview, applied };
}

// ---------------------------------------------------------------------------
// Package invariants
// ---------------------------------------------------------------------------

test('page_admin is opt-in, plan by default, with one reversible tool', () => {
  assert.equal(PACKAGE.name, 'page_admin');
  assert.equal(PACKAGE.enabledByDefault, false);
  assert.equal(PACKAGE.writeModeDefault, 'plan');
  assert.deepEqual(
    PACKAGE.tools.map((t) => t.name),
    [TOOL],
  );
  const spec = tool(TOOL);
  assert.equal(spec.writeTier, 'reversible');
  assert.equal(spec.annotations.destructiveHint, false);
  assert.equal(spec.annotations.idempotentHint, true);
});

// ---------------------------------------------------------------------------
// Preview and apply
// ---------------------------------------------------------------------------

test('the preview shows each field before → after and the unchanged ones, with no POST', async () => {
  const { fb, journal, ctx } = makeHarness();
  fb.on(isRead, fbOk(PROFILE));

  const preview = body(
    await tool(TOOL).handler(
      {
        phone: '+1 555 0199',
        temporary_status: 'TEMPORARILY_CLOSED',
        website: 'https://example.com',
      },
      ctx,
    ),
  );

  assert.equal(preview.status, 'preview');
  assert.equal(typeof preview.planId, 'string');
  const summary = String(preview.summary);
  assert.match(summary, /phone: "\+1 555 0100" → "\+1 555 0199"/);
  assert.match(summary, /temporary_status: "OPERATING_AS_USUAL" → "TEMPORARILY_CLOSED"/);
  assert.doesNotMatch(summary, /website:/);
  const warnings = (preview.warnings as readonly string[]).join('\n');
  assert.match(warnings, /TEMPORARILY CLOSED/);
  assert.match(warnings, /Already set, not sent: website/);
  assert.equal(posts(fb).length, 0);
  assert.equal(journal.entries.length, 0);
});

test('a bare apply without plan_id stays a preview', async () => {
  const { fb, ctx } = makeHarness({ writeMode: 'apply' });
  fb.on(isRead, fbOk(PROFILE));
  fb.on(isWrite, fbOk({ success: true }));

  const result = body(
    await tool(TOOL).handler({ phone: '+1 555 0199', apply: true }, ctx),
  );

  assert.equal(result.status, 'preview');
  assert.equal(posts(fb).length, 0);
});

test('apply sends only the changing fields, hours as JSON, and verifies them', async () => {
  const { fb, journal, ctx } = makeHarness();
  const hours = [
    { day: 'mon', open: '09:00', close: '18:00' },
    { day: 'fri', open: '18:00', close: '02:00' },
  ];
  fb.on(isRead, fbOk(PROFILE), 2);
  fb.on(isWrite, fbOk({ success: true }));
  fb.on(
    isRead,
    fbOk({
      ...PROFILE,
      phone: '+1 555 0199',
      hours: {
        mon_1_open: '09:00',
        mon_1_close: '18:00',
        fri_1_open: '18:00',
        fri_1_close: '02:00',
      },
    }),
  );

  const { preview, applied } = await previewThenApply(fb, ctx, {
    phone: '+1 555 0199',
    about: PROFILE.about,
    hours,
  });

  const warnings = (preview.warnings as readonly string[]).join('\n');
  assert.match(warnings, /past midnight/);
  assert.equal(applied.status, 'applied');
  assert.equal(applied.applied, true);
  const [write] = posts(fb);
  assert.ok(write);
  assert.deepEqual(write.body, {
    phone: '+1 555 0199',
    hours: JSON.stringify({
      mon_1_open: '09:00',
      mon_1_close: '18:00',
      fri_1_open: '18:00',
      fri_1_close: '02:00',
    }),
  });
  assert.equal(write.token, PAGE.token);
  const result = obj(applied.result);
  assert.deepEqual(result.changed, ['phone', 'hours']);
  assert.equal(result.confirmed, true);
  assert.equal(result.mismatched, undefined);
  assert.equal(journal.entries.at(-1)?.outcome, 'applied');
});

test('a profile changed after the preview diverges without writing', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(isRead, fbOk(PROFILE), 1);
  fb.on(isRead, fbOk({ ...PROFILE, phone: '+1 555 0142' }));
  fb.on(isWrite, fbOk({ success: true }));

  const { applied } = await previewThenApply(fb, ctx, { phone: '+1 555 0199' });

  assert.equal(applied.status, 'diverged');
  assert.equal(applied.applied, false);
  assert.equal(posts(fb).length, 0, 'a diverged apply must not write');
});

test('a field Graph reads back differently makes the write attempted', async () => {
  const { fb, journal, ctx } = makeHarness();
  fb.on(isRead, fbOk(PROFILE), 2);
  fb.on(isWrite, fbOk({ success: true }));
  fb.on(isRead, fbOk({ ...PROFILE, phone: '+15550199' }));

  const { applied } = await previewThenApply(fb, ctx, { phone: '+1 555 0199' });

  assert.equal(applied.outcome, 'attempted');
  const result = obj(applied.result);
  assert.deepEqual(result.mismatched, ['phone']);
  assert.match(String(result.note), /differs for: phone/);
  assert.equal(journal.entries.at(-1)?.outcome, 'attempted');
});

test('success:false is a failed write that claims no change', async () => {
  const { fb, journal, ctx } = makeHarness();
  fb.on(isRead, fbOk(PROFILE));
  fb.on(isWrite, fbOk({ success: false }));

  const { applied } = await previewThenApply(fb, ctx, { phone: '+1 555 0199' });

  assert.equal(applied.applied, false);
  assert.equal(applied.outcome, 'failed');
  const result = obj(applied.result);
  assert.deepEqual(result.changed, []);
  assert.equal(result.confirmed, false);
  assert.equal(journal.entries.at(-1)?.outcome, 'failed');
});

test('a re-read that fails after a confirmed write stays applied, flagged unverified', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(isRead, fbOk(PROFILE), 2);
  fb.on(isWrite, fbOk({ success: true }));
  fb.on(
    isRead,
    fbErr(new GraphApiError('Service unavailable', { code: 2, httpStatus: 503 })),
  );

  const { applied } = await previewThenApply(fb, ctx, { phone: '+1 555 0199' });

  assert.equal(applied.status, 'applied');
  const result = obj(applied.result);
  assert.equal(result.after, undefined);
  assert.match(String(result.note), /could not be read back/);
});

test('a refused POST is journaled failed, a lost answer attempted', async () => {
  const cases: ReadonlyArray<readonly [Error, 'attempted' | 'failed']> = [
    [
      new GraphApiError('(#100) Invalid parameter', { code: 100, httpStatus: 400 }),
      'failed',
    ],
    [new GraphApiError('Service unavailable', { code: 2, httpStatus: 503 }), 'attempted'],
    [new GraphApiError('socket hang up', { code: 0, httpStatus: 0 }), 'attempted'],
  ];
  for (const [err, expected] of cases) {
    const { fb, journal, ctx } = makeHarness();
    fb.on(isRead, fbOk(PROFILE));
    fb.on(isWrite, fbErr(err));
    const update = tool(TOOL);
    const args = { phone: '+1 555 0199' };
    const preview = body(await update.handler(args, ctx));
    await assert.rejects(() =>
      update.handler({ ...args, apply: true, plan_id: preview.planId }, ctx),
    );
    assert.equal(journal.entries.at(-1)?.outcome, expected, err.message);
  }
});

test('a permission refusal names pages_manage_metadata and facebook_whoami', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(isRead, fbOk(PROFILE));
  fb.on(
    isWrite,
    fbErr(new GraphApiError('(#200) Permissions error', { code: 200, httpStatus: 403 })),
  );
  const update = tool(TOOL);
  const args = { about: 'New about text.' };
  const preview = body(await update.handler(args, ctx));
  await assert.rejects(
    () => update.handler({ ...args, apply: true, plan_id: preview.planId }, ctx),
    (err: unknown) =>
      err instanceof GraphApiError &&
      err.action?.nextTool === 'facebook_whoami' &&
      /pages_manage_metadata/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// Validation (nothing is read or sent)
// ---------------------------------------------------------------------------

test('a request naming no field is refused', async () => {
  const { fb, ctx } = makeHarness();
  await assert.rejects(() => tool(TOOL).handler({}, ctx), isValidation);
  assert.equal(fb.calls.length, 0);
});

test('hours together with is_always_open is refused', async () => {
  const { fb, ctx } = makeHarness();
  await assert.rejects(
    () =>
      tool(TOOL).handler(
        {
          hours: [{ day: 'mon', open: '09:00', close: '18:00' }],
          is_always_open: true,
        },
        ctx,
      ),
    isValidation,
  );
  assert.equal(fb.calls.length, 0);
});

test('invalid hours are refused before any request', async () => {
  const { fb, ctx } = makeHarness();
  await assert.rejects(
    () =>
      tool(TOOL).handler({ hours: [{ day: 'sat', open: '18:00', close: '07:00' }] }, ctx),
    isValidation,
  );
  assert.equal(fb.calls.length, 0);
});

test('a request whose every field already holds its value is refused', async () => {
  const { fb, ctx } = makeHarness();
  fb.on(isRead, fbOk(PROFILE));
  await assert.rejects(
    () => tool(TOOL).handler({ phone: PROFILE.phone, website: PROFILE.website }, ctx),
    (err: unknown) => isValidation(err) && /already hold/.test((err as Error).message),
  );
  assert.equal(posts(fb).length, 0);
});
