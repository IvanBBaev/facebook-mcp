// Shared fixtures, fakes and helpers for the `ads` tool package tests, split out of
// `ads.test.ts` (R17). The test files import from here.
//
// Tests for the `ads` tool package (tasks V09 read / V10 control): the six
// read-only tools, the plan-gated write tool, the ad-account resolution the
// whole package hangs off, the async report-run path (CC-ADS-5), the ceiling
// refusal (CC-ADS-7) and the package invariants doc 06 pins.
//
// Every Graph call is served by `createFakeFbRequest` — the network fence
// guarantees no real fetch escapes. Placeholder tokens only.
//
// The api-layer behaviour (minor-unit rewriting, effective-status explanations,
// the planner's tier arithmetic) is covered by `../api/ads-*.test.ts`; what is
// asserted here is the WIRING: which edge each tool hits, which arguments reach
// the api layer, that a dry run touches nothing, and that the tier the gate sees
// is the PLAN's tier rather than a constant.

import assert from 'node:assert/strict';
import {
  createFakeClock,
  createFakeFbRequest,
  createFakePageResolver,
  createFakeRedactor,
  createMemoryJournal,
  fbOk,
  type FakeFbRequest,
  type MemoryJournal,
} from '../../core/fakes/index.js';
import type {
  Confirmer,
  FbRequest,
  JsonRequest,
  Logger,
  Settings,
  ToolResult,
  ToolSpec,
} from '../../core/index.js';
import { createWriteGate } from '../../mcp/index.js';
import { createAdsPackage } from '../../tools/ads.js';
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
// Fixtures
// ---------------------------------------------------------------------------

export const ACCOUNT_ID = 'act_1234567890';
export const BARE_ACCOUNT_ID = '1234567890';
export const OTHER_ACCOUNT_ID = 'act_9876543210';
export const CAMPAIGN_ID = '23851234567890123';
export const ADSET_ID = '23859876543210987';

/** Fixed "now" — the run-age and stall verdicts must never read the wall clock. */
export const NOW_MS = Date.parse('2026-08-07T09:00:00Z');

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

export interface Harness {
  readonly fb: FakeFbRequest;
  readonly journal: MemoryJournal;
  readonly ctx: WriteToolContext;
}

/**
 * A tool context equipped exactly the way the server bootstrap equips one: a
 * real write gate over a fake clock and a memory journal. `writeMode` stays
 * `'plan'` — the package declares `writeModeDefault: 'plan'`, and every tier the
 * write tool can reach ignores the env default anyway.
 */
export function makeHarness(settingsOverrides: Partial<Settings> = {}): Harness {
  const fb = createFakeFbRequest();
  const clock = createFakeClock(NOW_MS);
  const journal = createMemoryJournal(clock);
  let planSeq = 0;
  const ctx: WriteToolContext = {
    settings: makeSettings({ adAccountId: ACCOUNT_ID, ...settingsOverrides }),
    fbRequest: fb.fn,
    pages: createFakePageResolver({
      default: { pageId: '111222333', name: 'Default', token: 'EAA-PAGE-TOKEN-01234' },
    }),
    logger: makeLogger(),
    redactor: createFakeRedactor(),
    clock,
    journal,
    writeGate: createWriteGate({
      confirmer: ALWAYS_CONFIRMS,
      clock,
      journal,
      defaultWriteMode: 'plan',
      newPlanId: () => `plan-${String(++planSeq)}`,
    }),
  };
  return { fb, journal, ctx };
}

export const PACKAGE = createAdsPackage();

/** Look a tool up in the built package by name (fails loudly if renamed). */
export function tool(name: string): ToolSpec {
  const spec = PACKAGE.tools.find((t) => t.name === name);
  assert.ok(spec, `expected a tool named ${name}`);
  return spec;
}

export function text(result: ToolResult): string {
  return result.content[0]?.text ?? '';
}

export function body(result: ToolResult): Record<string, unknown> {
  return JSON.parse(text(result)) as Record<string, unknown>;
}

export function obj(value: unknown): Record<string, unknown> {
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'expected an object',
  );
  return value as Record<string, unknown>;
}

export function arr(value: unknown): readonly unknown[] {
  assert.ok(Array.isArray(value), 'expected an array');
  return value as readonly unknown[];
}

export function str(value: unknown): string {
  assert.equal(typeof value, 'string', 'expected a string');
  return value as string;
}

export function isJson(req: FbRequest): req is JsonRequest {
  return req.protocol === 'json';
}

export function writes(fb: FakeFbRequest): readonly FbRequest[] {
  return fb.calls.filter((r) => r.method !== 'GET');
}

/** A campaign node as Graph sends it: budgets are decimal STRINGS of minor units. */
export function campaignNode(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: CAMPAIGN_ID,
    name: 'Summer sale',
    status: 'PAUSED',
    effective_status: 'PAUSED',
    daily_budget: '5000',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 6. The write tool — dry runs (V10)
// ---------------------------------------------------------------------------

/** Serve the object read and the ad-account read a write does before planning. */
export function stubWriteReads(
  fb: FakeFbRequest,
  opts: {
    readonly object?: Record<string, unknown>;
    readonly accountStatus?: number;
    readonly currency?: string;
  } = {},
): void {
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${ACCOUNT_ID}`,
    fbOk({
      id: ACCOUNT_ID,
      account_status: opts.accountStatus ?? 1,
      currency: opts.currency ?? 'EUR',
      name: 'Test account',
    }),
  );
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${CAMPAIGN_ID}`,
    fbOk(opts.object ?? campaignNode()),
  );
}
