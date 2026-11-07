// Shared fixtures, fakes and helpers for the doctor (`mcp/doctor.ts`) tests, split out
// of `doctor.test.ts` (R17). The test files import from here.
//
// Tests for the `facebook doctor` diagnostic (task F16): token classification +
// never-expiring / expiring-soon detection, the permission x package matrix over
// INJECTED packages (usable / partial / blocked / unknown), over-scope
// detection, the optional metric-probe seam, and the text renderer. All Graph
// calls are served by `createFakeFbRequest`; placeholder tokens only.

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  createFakeClock,
  createFakeFbRequest,
  createFakeRedactor,
  fbOk,
  type FakeFbRequest,
} from '../../core/fakes/index.js';
import { GraphApiError } from '../../core/index.js';
import type {
  JsonRequest,
  Logger,
  PackageSpec,
  Settings,
  ToolAnnotations,
  ToolSpec,
} from '../../core/index.js';
import { defineTool } from '../../mcp/define.js';
import {
  runDoctor,
  type AdAccountProbe,
  type DoctorDeps,
  type DoctorReport,
  type MetricProbe,
  type PackageMatrixRow,
  type ProbedMetric,
} from '../../mcp/doctor.js';

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export function makeLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

export function rtool(name: string): ToolSpec {
  return defineTool({
    name,
    description: 'diagnostic fixture tool',
    inputSchema: z.object({}),
    annotations: READ_ONLY,
    handler: () => Promise.resolve({ content: [{ type: 'text', text: 'ok' }] }),
  });
}

export function pkg(name: string, toolNames: readonly string[]): PackageSpec {
  return { name, tools: toolNames.map(rtool), enabledByDefault: false };
}

/** The real core package's tool names, so the matrix mirrors production. */
export const CORE_TOOLS = [
  'facebook_whoami',
  'facebook_list_pages',
  'facebook_get_page',
  'facebook_usage',
] as const;

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

export interface DoctorParts {
  readonly fb: FakeFbRequest;
  readonly deps: DoctorDeps;
}

/**
 * A path that cannot exist, so the credential-file check (CC-CFG-4) never stats
 * the operator's real config during a test run.
 */
export const NO_CREDENTIAL_FILE = join(tmpdir(), 'facebook-mcp-doctor-absent', 'env');

export function makeDeps(
  opts: {
    settings?: Settings;
    packages?: readonly PackageSpec[];
    nowMs?: number;
    metricProbe?: MetricProbe;
    adAccountProbe?: AdAccountProbe;
    credentialFilePath?: string;
    platform?: NodeJS.Platform;
    metricSet?: readonly ProbedMetric[];
  } = {},
): DoctorParts {
  const fb = createFakeFbRequest();
  const deps: DoctorDeps = {
    fbRequest: fb.fn,
    settings: opts.settings ?? makeSettings({ accessToken: 'EAA-runtime-test' }),
    clock: createFakeClock(opts.nowMs ?? 1000),
    logger: makeLogger(),
    redactor: createFakeRedactor(),
    packages: opts.packages ?? [pkg('core', CORE_TOOLS)],
    serverVersion: '9.9.9',
    credentialFilePath: opts.credentialFilePath ?? NO_CREDENTIAL_FILE,
    ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
    ...(opts.metricProbe !== undefined ? { metricProbe: opts.metricProbe } : {}),
    ...(opts.adAccountProbe !== undefined ? { adAccountProbe: opts.adAccountProbe } : {}),
    ...(opts.metricSet !== undefined ? { metricSet: opts.metricSet } : {}),
  };
  return { fb, deps };
}

/** Program `/debug_token` to return a given normalized payload. */
export function withDebugToken(fb: FakeFbRequest, data: Record<string, unknown>): void {
  fb.on((req) => req.path === '/debug_token', fbOk({ data }));
}

export function row(rows: readonly PackageMatrixRow[], name: string): PackageMatrixRow {
  const found = rows.find((r) => r.package === name);
  assert.ok(found, `expected a matrix row for ${name}`);
  return found;
}

// ---------------------------------------------------------------------------
// Insights metric-set probe (C6 / CC-INS-1)
// ---------------------------------------------------------------------------

/** A three-name stand-in for the shipped set: two renamed lineages + one plain. */
export const PROBE_SET: readonly ProbedMetric[] = [
  { metric: 'page_media_view', replaces: ['page_impressions'] },
  { metric: 'page_follows', replaces: ['page_fans'] },
  { metric: 'page_video_views' },
];

export const ALL_METRICS = 'page_media_view,page_follows,page_video_views';

/** Noon UTC, so the day boundaries in the assertions are unambiguous. */
export const PROBE_NOW = Date.UTC(2026, 2, 15, 12, 0, 0);

/** A Graph insights row with `points` daily values. */
export function insightRow(name: string, values: readonly (number | null)[]): unknown {
  return {
    name,
    period: 'day',
    values: values.map((value, index) => ({
      value,
      end_time: `2026-03-1${String(3 + index)}`,
    })),
  };
}

/** The shape Graph uses to refuse a metric NAME (as opposed to the call). */
export function metricRejection(metric: string): GraphApiError {
  return new GraphApiError(
    `(#100) Requires metric to be one of the following values: ..., ${metric} is not valid`,
    {
      code: 100,
      httpStatus: 400,
      type: 'OAuthException',
      action: {
        category: 'validation',
        retryable: false,
        operatorText: 'Check the metric name against the Graph API changelog.',
      },
    },
  );
}

export function makeMetricSetDeps(
  opts: {
    settings?: Settings;
    metricSet?: readonly ProbedMetric[];
    tokenValid?: boolean;
  } = {},
): DoctorParts {
  const parts = makeDeps({
    settings:
      opts.settings ??
      makeSettings({ accessToken: 'ACCESS-TOKEN-PLACEHOLDER', defaultPageId: '1010' }),
    nowMs: PROBE_NOW,
    metricSet: opts.metricSet ?? PROBE_SET,
  });
  withDebugToken(parts.fb, {
    type: 'SYSTEM_USER',
    is_valid: opts.tokenValid ?? true,
    scopes: ['read_insights', 'pages_read_engagement'],
    expires_at: 0,
  });
  // A user / system-user credential is not what Graph wants on a Page insights
  // edge: the probe derives the Page token the tools would use, like they do.
  onPageTokenDerivation(parts.fb, '1010');
  return parts;
}

/** The Page token the fake hands out for `pageId` on a derivation call. */
export function derivedPageToken(pageId: string): string {
  return `PAGE-${pageId}-TOKEN-PLACEHOLDER`;
}

/** Program the `/{page}?fields=access_token` derivation for one Page. */
export function onPageTokenDerivation(fb: FakeFbRequest, pageId: string): void {
  fb.on(
    (req) =>
      req.protocol === 'json' &&
      req.path === `/${pageId}` &&
      req.params?.fields === 'access_token',
    fbOk({ access_token: derivedPageToken(pageId), id: pageId }),
  );
}

/** Every insights call the probe made, in order. */
export function insightsCalls(fb: FakeFbRequest): readonly JsonRequest[] {
  return fb.calls.filter(
    (call): call is JsonRequest =>
      call.protocol === 'json' && call.path.endsWith('/insights'),
  );
}

/** Program the batched attempt (all names at once). */
export function onBatch(
  fb: FakeFbRequest,
  result: Parameters<FakeFbRequest['on']>[1],
): void {
  fb.on((req) => req.protocol === 'json' && req.params?.metric === ALL_METRICS, result);
}

/** Program the isolated attempt for a single name. */
export function onSingle(
  fb: FakeFbRequest,
  metric: string,
  result: Parameters<FakeFbRequest['on']>[1],
): void {
  fb.on((req) => req.protocol === 'json' && req.params?.metric === metric, result);
}

// ---------------------------------------------------------------------------
// Overall verdict (`doctor --strict`)
// ---------------------------------------------------------------------------

/**
 * A healthy report, used as the base every rule test mutates. Returning the
 * whole report (summary included) is deliberate: `summarizeDoctor` takes the
 * report minus its own summary, and a `DoctorReport` satisfies that, so each
 * test can override one slice and re-derive the verdict from the same input the
 * real run would have produced.
 */
export async function healthyReport(): Promise<DoctorReport> {
  const { fb, deps } = makeDeps();
  withDebugToken(fb, {
    type: 'SYSTEM_USER',
    is_valid: true,
    scopes: ['pages_show_list', 'pages_read_engagement'],
    // What Graph really says for a System-User token. A fixture that leaves
    // the expiry unstated is not "healthy": the doctor cannot tell when that
    // credential stops working, and says so.
    expires_at: 0,
  });
  return runDoctor(deps);
}
