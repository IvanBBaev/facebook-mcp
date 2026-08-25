// Integration smoke for the server bootstrap (task I1).
//
// These tests drive the EXPORTED `buildServer` builder over a real in-process
// MCP session: a low-level `Server` wired to an SDK `Client` through
// `InMemoryTransport.createLinkedPair()`. They never call `main()` (which would
// open a real transport and read the process environment) and never touch the
// network — every collaborator is an in-memory fake, so the test-runner's
// fetch-fence is never provoked.
//
// The properties pinned here:
//   (a) all-tools smoke — the four `core` tools are advertised with
//       `readOnlyHint: true` (the read-only posture the whole package promises);
//   (b) a read call returns a well-formed ToolResult and leaks no token —
//       `facebook_list_pages` exposes `hasToken`, never the raw access_token;
//   (c) a generic plan-mode no-write sweep — no tool run in the default (plan)
//       write mode ever produces an `applied` journal record. Vacuous today
//       (core is all read-only) but structured to fail the moment a future
//       write tool applies without an explicit `apply`;
//   (d) the composition decisions themselves — which packages a given
//       `FB_TOOL_PACKAGES` resolves to, what an unknown name does, and what the
//       bootstrap actually puts into the per-call `ToolContext`;
//   (e) failure mapping — every throw class a handler can produce becomes a
//       well-formed, redacted error result instead of a raw protocol error.
//
// (d) and (e) are observed through a synthetic package handed to the `packages`
// dependency: the bootstrap's own behaviour is what is under test, and no real
// package can report what its `ctx` contained or throw a chosen error on demand.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolResultSchema,
  ElicitRequestSchema,
  type CallToolResult,
  type ElicitResult,
  type Progress,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

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
} from './core/fakes/index.js';
import {
  GraphApiError,
  classifyGraphError,
  loadSettings,
  type Logger,
  type PackageName,
  type PackageSpec,
  type ProgressUpdate,
  type Settings,
  type ToolContext,
  type ToolResult,
  type WriteMode,
  type WriteTier,
} from './core/index.js';
import {
  createRegistry,
  defineTool,
  renderDoctorReport,
  runDoctor,
  WriteGateError,
  type DoctorReport,
  type MetricProbeContext,
} from './mcp/index.js';
import {
  confirmableWriteArgs,
  createCorePackage,
  executeWrite,
  gateArgs,
} from './tools/index.js';
import {
  adAccountProbe,
  buildServer,
  isVersionFlag,
  metricProbe,
  resolveSdkVersion,
  versionLine,
  type BuildServerDeps,
  type SdkVersionSources,
} from './index.js';

/** A raw Page access token that must NEVER survive into a tool result. */
const SECRET_PAGE_TOKEN = 'EAA-PAGE-TOKEN-must-never-leak-9f8e7d6c5b4a';

/** The configured user token every harness here resolves its settings from. */
const ACCESS_TOKEN = 'test-access-token-abc123';

/** Diagnostics are irrelevant to these assertions; stderr stays quiet. */
const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** The canonical `core` tool names, all read-only. */
const CORE_TOOLS = [
  'facebook_whoami',
  'facebook_list_pages',
  'facebook_get_page',
  'facebook_usage',
] as const;

/**
 * Resolve a real, valid {@link Settings} from a minimal env (never touches disk).
 *
 * Only the `core` package exists in this wave. The `core` *profile* token expands
 * to the full default surface (core + posts + reader + insights + moderation +
 * messages) and there is no token that selects the `core` package alone, so we
 * DENY the other default packages instead; the registry always forces `core`
 * back on after deny. The resolved registry is therefore exactly core's tools —
 * which is also all that is injectable until the Wave-4 verticals land.
 */
function testSettings(): Settings {
  const { settings } = loadSettings({
    env: {
      FB_ACCESS_TOKEN: ACCESS_TOKEN,
      FB_PACKAGES_DENY: 'posts,reader,insights,moderation,messages',
    },
    loadEnvFile: false,
  });
  return settings;
}

interface Harness {
  readonly deps: BuildServerDeps;
  readonly packages: readonly PackageSpec[];
  readonly settings: Settings;
  readonly fb: FakeFbRequest;
  readonly journal: MemoryJournal;
}

/** What a test may swap out of the default (core-only, default-settings) wiring. */
interface HarnessOverrides {
  readonly settings?: Settings;
  readonly packages?: readonly PackageSpec[];
}

/** Assemble {@link buildServer} dependencies from in-memory fakes. */
function makeHarness(overrides: HarnessOverrides = {}): Harness {
  const settings = overrides.settings ?? testSettings();
  const clock = createFakeClock(1_000);
  const redactor = createFakeRedactor({ secrets: [settings.accessToken ?? ''] });
  const journal = createMemoryJournal(clock);
  const fb = createFakeFbRequest();
  const pages = createFakePageResolver();
  const packages: readonly PackageSpec[] = overrides.packages ?? [
    createCorePackage({ serverVersion: '1.2.3-test', sdkVersion: '1.29.0-test' }),
  ];

  const deps: BuildServerDeps = {
    settings,
    packages,
    serverVersion: '1.2.3-test',
    clock,
    logger: silentLogger,
    redactor,
    journal,
    fbRequest: fb.fn,
    pages,
  };
  return { deps, packages, settings, fb, journal };
}

/** Connect an SDK `Client` to a freshly built server over a linked in-memory pair. */
async function connect(
  deps: BuildServerDeps,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = buildServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'facebook-mcp-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Extract the first text block from a tool result (v1 tools emit text only). */
function firstText(result: CallToolResult): string {
  const block = result.content[0];
  assert.ok(block, 'expected at least one content block');
  assert.equal(block.type, 'text');
  return block.type === 'text' ? block.text : '';
}

/** Parse the JSON object a tool result carries in its first text block. */
function parseResult(result: CallToolResult): Record<string, unknown> {
  return JSON.parse(firstText(result)) as Record<string, unknown>;
}

// (a) all-tools smoke — the four core tools advertise a read-only posture.
test('advertises the four read-only core tools', async () => {
  const { deps } = makeHarness();
  const { client, close } = await connect(deps);
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...CORE_TOOLS].sort());

    for (const tool of listed.tools) {
      assert.equal(
        tool.annotations?.readOnlyHint,
        true,
        `${tool.name} must advertise readOnlyHint:true`,
      );
      // A well-formed advertised tool always carries an object input schema.
      assert.equal(tool.inputSchema.type, 'object');
    }
  } finally {
    await close();
  }
});

// (b) read call — well-formed result, token presence only, no raw token leak.
test('list_pages exposes hasToken and never the raw access_token', async () => {
  const { deps, fb } = makeHarness();
  // /me/accounts returns a Page whose access_token must be dropped, not surfaced.
  fb.on(
    (req) => req.path === '/me/accounts',
    fbOk({
      data: [
        {
          id: '1010',
          name: 'Brand A',
          category: 'Software',
          tasks: ['MANAGE', 'CREATE_CONTENT'],
          access_token: SECRET_PAGE_TOKEN,
        },
      ],
    }),
  );

  const { client, close } = await connect(deps);
  try {
    const result = (await client.callTool({
      name: 'facebook_list_pages',
      arguments: {},
    })) as CallToolResult;

    assert.notEqual(result.isError, true);
    const text = firstText(result);

    // The token VALUE must appear nowhere in the serialized result.
    assert.ok(
      !text.includes(SECRET_PAGE_TOKEN),
      'raw Page access_token leaked into the tool result',
    );
    // Token PRESENCE is surfaced as a boolean instead.
    assert.ok(text.includes('hasToken'), 'expected hasToken in the result');

    const parsed = JSON.parse(text) as {
      pages: { id: string; hasToken: boolean; access_token?: unknown }[];
      count: number;
    };
    assert.equal(parsed.count, 1);
    assert.equal(parsed.pages[0]?.hasToken, true);
    assert.equal(parsed.pages[0]?.access_token, undefined);
  } finally {
    await close();
  }
});

// (c) plan-mode no-write sweep — nothing produces an `applied` journal record.
test('no tool produces an applied journal record in plan mode', async () => {
  const { deps, fb, packages, settings, journal } = makeHarness();
  assert.equal(settings.writeMode, 'plan', 'default write mode must be plan');

  // Any Graph call the read tools make resolves harmlessly (empty data).
  fb.on(() => true, fbOk({ data: [] }));

  // Enumerate the SAME tool set the server exposes and isolate the write tier.
  const registry = createRegistry(packages, settings);
  const writeTools = registry.tools.filter(
    (t) => t.writeTier !== undefined || t.annotations.readOnlyHint === false,
  );
  // Today core is entirely read-only; this guard turns a future regression
  // (a write tool leaking into `core`) into a failing assertion here.
  assert.equal(writeTools.length, 0, 'core must expose no write-tier tools');

  const { client, close } = await connect(deps);
  try {
    // Exercise every advertised tool in the default (plan) write mode. Each call
    // returns a ToolResult (errors are mapped, never thrown), so none rejects.
    for (const tool of registry.tools) {
      await client.callTool({ name: tool.name, arguments: {} });
    }
  } finally {
    await close();
  }

  const applied = journal.entries.filter((e) => e.outcome === 'applied');
  assert.equal(
    applied.length,
    0,
    'plan-mode calls must not write an applied journal record',
  );
});

// ---------------------------------------------------------------------------
// (d)+(e) Composition decisions and failure mapping, seen through a probe package
// ---------------------------------------------------------------------------
//
// `BuildServerDeps.packages` is the injection seam the bootstrap exists for, so
// a synthetic package is the honest way to observe the two things only the
// bootstrap does: assembling the per-call context, and mapping a thrown error.
// The probe occupies the `ads` slot — the one package name outside the default
// profile, so `FB_TOOL_PACKAGES=ads` selects exactly it (plus always-on `core`).

/** A minimal text-only result; the probe deliberately bypasses the shaper. */
function textResult(payload: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/** The read-only annotation quadruple both probe tools carry. */
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Error classes {@link probePackage}'s failing tool can raise on demand. */
const FAILURE_KINDS = [
  'write-gate',
  'graph',
  'graph-bare',
  'graph-throttled',
  'plain',
  'non-error',
] as const;

/** The probe package: one context mirror, one on-demand failure. */
function probePackage(): PackageSpec {
  const inspect = defineTool({
    // Deliberately NO `title`: every core tool sets one, so the tools/list
    // projection is otherwise never exercised for a spec that omits it.
    name: 'facebook_probe_context',
    description: 'Test-only: report what the bootstrap placed in the ToolContext.',
    inputSchema: z.object({
      profile: z
        .string()
        .optional()
        .describe('Forwarded verbatim; the bootstrap lifts it into the context.'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: (_input, ctx) => {
      // The write seams ride on a structural SUPERSET of the frozen ToolContext,
      // reached exactly as a write handler would: by widening its own ctx type.
      const wired = ctx as ToolContext & {
        readonly writeGate?: unknown;
        readonly confirmer?: unknown;
      };
      return Promise.resolve(
        textResult({
          profile: ctx.profile ?? null,
          hasWriteGate: wired.writeGate !== undefined,
          hasConfirmer: wired.confirmer !== undefined,
          hasSignal: ctx.signal !== undefined,
          writeMode: ctx.settings.writeMode,
        }),
      );
    },
  });

  const fail = defineTool({
    name: 'facebook_probe_fail',
    title: 'Probe failure',
    description: 'Test-only: throw the requested error class so the mapping shows.',
    inputSchema: z.object({
      kind: z.enum(FAILURE_KINDS).describe('Which error class the handler throws.'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: (input) => {
      switch (input.kind) {
        case 'write-gate':
          throw new WriteGateError('plan_expired', 'the plan expired; re-plan first', {
            tool: 'facebook_probe_fail',
            tier: 'irreversible',
          });
        case 'graph':
          throw new GraphApiError('(#200) Permissions error', {
            code: 200,
            subcode: 1_349_003,
            type: 'OAuthException',
            httpStatus: 403,
            fbtraceId: 'trace-abc',
            action: {
              category: 'permission',
              retryable: false,
              operatorText: 'Grant pages_manage_posts, then retry.',
            },
          });
        case 'graph-bare':
          throw new GraphApiError('Unsupported get request', {
            code: 100,
            httpStatus: 400,
          });
        case 'graph-throttled':
          // Classified by the real F06 matrix, ETA and all — the shape a live
          // throttle now reaches the bootstrap with.
          throw new GraphApiError('(#4) Application request limit reached', {
            code: 4,
            httpStatus: 400,
            action: classifyGraphError({
              code: 4,
              estimated_time_to_regain_access: 30,
            }),
          });
        case 'plain':
          throw new Error(`upstream blew up while holding ${ACCESS_TOKEN}`);
        default: {
          // Not every rejection is an Error — a library may reject with a bare
          // value, and the bootstrap must still produce a usable result.
          const notAnError: unknown = 'probe rejected with a bare string';
          throw notAnError;
        }
      }
    },
  });

  return {
    name: 'ads',
    title: 'Probe',
    description: 'Test-only package injected through the packages seam.',
    tools: [inspect, fail],
    enabledByDefault: false,
  };
}

/** Settings selecting ONLY the probe package (core is forced back on by the registry). */
function probeSettings(): Settings {
  const { settings } = loadSettings({
    env: { FB_ACCESS_TOKEN: ACCESS_TOKEN, FB_TOOL_PACKAGES: 'ads' },
    loadEnvFile: false,
  });
  return settings;
}

/** The injected package array for a probe-backed server. */
function probePackages(): readonly PackageSpec[] {
  return [
    createCorePackage({ serverVersion: '1.2.3-test', sdkVersion: '1.29.0-test' }),
    probePackage(),
  ];
}

/**
 * Drive one call against a probe-backed server. Passing no `args` omits the
 * `arguments` member entirely — a `tools/call` request may legally do so, and
 * the bootstrap has to default it rather than dereference undefined.
 */
async function callProbeServer(
  name: string,
  args?: Record<string, unknown>,
): Promise<CallToolResult> {
  const { deps } = makeHarness({ settings: probeSettings(), packages: probePackages() });
  const { client, close } = await connect(deps);
  try {
    return (await client.callTool({
      name,
      ...(args !== undefined ? { arguments: args } : {}),
    })) as CallToolResult;
  } finally {
    await close();
  }
}

test('an explicit package selection still advertises the always-on core tools', async () => {
  const { deps } = makeHarness({ settings: probeSettings(), packages: probePackages() });
  const { client, close } = await connect(deps);
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((t) => t.name).sort(),
      [...CORE_TOOLS, 'facebook_probe_context', 'facebook_probe_fail'].sort(),
      'FB_TOOL_PACKAGES=ads must resolve to the probe package plus core',
    );

    // `title` is optional on a ToolSpec and must survive — or stay absent —
    // through the SDK projection exactly as the spec declared it.
    const byName = new Map(listed.tools.map((t) => [t.name, t]));
    assert.equal(byName.get('facebook_probe_fail')?.title, 'Probe failure');
    assert.equal(byName.get('facebook_probe_context')?.title, undefined);
  } finally {
    await close();
  }
});

test('an unknown package name fails the build and lists the valid names', () => {
  const { settings } = loadSettings({
    // A plausible typo for `ads` — the operator must be told what to write.
    env: { FB_ACCESS_TOKEN: ACCESS_TOKEN, FB_TOOL_PACKAGES: 'core,add' },
    loadEnvFile: false,
  });
  const { deps } = makeHarness({ settings });

  assert.throws(
    () => buildServer(deps),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /"add"/, 'the offending token must be quoted verbatim');
      assert.match(err.message, /Valid names: .*\bads\b/);
      return true;
    },
  );
});

test('an unadvertised tool name returns an error result, not a protocol error', async () => {
  const { deps, fb } = makeHarness();
  const { client, close } = await connect(deps);
  try {
    // No `arguments` member at all, and a name the registry never advertised.
    const result = (await client.callTool({
      name: 'facebook_not_a_tool',
    })) as CallToolResult;

    assert.equal(result.isError, true);
    assert.equal(parseResult(result)['error'], 'unknown tool: facebook_not_a_tool');
  } finally {
    await close();
  }
  assert.equal(fb.calls.length, 0, 'an unknown tool must never reach Graph');
});

test('the bootstrap injects the profile, the write gate and the confirmer', async () => {
  const result = await callProbeServer('facebook_probe_context', { profile: 'brand-a' });

  assert.notEqual(result.isError, true);
  const ctx = parseResult(result);
  assert.equal(ctx['profile'], 'brand-a');
  // Both write seams are attached by the bootstrap, not by the frozen
  // ToolContext — a write handler that cannot see them cannot gate anything.
  assert.equal(ctx['hasWriteGate'], true);
  assert.equal(ctx['hasConfirmer'], true);
  // The MCP request's abort signal must reach the handler, or a cancelled call
  // keeps running against Graph.
  assert.equal(ctx['hasSignal'], true);
  assert.equal(ctx['writeMode'], 'plan');
});

test('a blank profile argument never becomes a context profile', async () => {
  // An empty string is not a page reference; letting it through would make the
  // resolver look up a Page named "" instead of falling back to the default.
  const result = await callProbeServer('facebook_probe_context', { profile: '' });

  assert.equal(parseResult(result)['profile'], null);
});

test('a thrown WriteGateError keeps the fields the model self-corrects on', async () => {
  const result = await callProbeServer('facebook_probe_fail', { kind: 'write-gate' });

  assert.equal(result.isError, true);
  const record = parseResult(result);
  assert.match(String(record['error']), /the plan expired/);
  assert.equal(record['code'], 'plan_expired');
  assert.equal(record['tool'], 'facebook_probe_fail');
  assert.equal(record['tier'], 'irreversible');
});

test('a thrown GraphApiError surfaces its codes and the operator action', async () => {
  const full = await callProbeServer('facebook_probe_fail', { kind: 'graph' });

  assert.equal(full.isError, true);
  const record = parseResult(full);
  assert.equal(record['code'], 200);
  assert.equal(record['subcode'], 1_349_003);
  assert.equal(record['type'], 'OAuthException');
  assert.equal(record['httpStatus'], 403);
  assert.equal(record['fbtraceId'], 'trace-abc');
  // The classification is what makes the failure actionable: the operator
  // sentence, flattened alongside the fields the model decides on.
  assert.equal(record['action'], 'Grant pages_manage_posts, then retry.');
  assert.equal(record['category'], 'permission');
  assert.equal(record['retryable'], false);
  // This action carries neither, so neither is invented.
  assert.ok(!('nextTool' in record));
  assert.ok(!('retryAfterMs' in record));

  // An unclassified Graph error must not invent the optional fields.
  const bare = parseResult(
    await callProbeServer('facebook_probe_fail', { kind: 'graph-bare' }),
  );
  assert.equal(bare['code'], 100);
  assert.equal(bare['httpStatus'], 400);
  for (const absent of [
    'subcode',
    'type',
    'fbtraceId',
    'action',
    'category',
    'retryable',
    'nextTool',
    'retryAfterMs',
  ]) {
    assert.ok(!(absent in bare), `${absent} must be absent, not null`);
  }
});

test('a throttled Graph error ships the next tool and the cool-down, not just prose', async () => {
  const record = parseResult(
    await callProbeServer('facebook_probe_fail', { kind: 'graph-throttled' }),
  );

  assert.equal(record['category'], 'rate_limit');
  // The model must not have to read "back off and retry" out of a sentence.
  assert.equal(record['retryable'], true);
  assert.equal(record['nextTool'], 'facebook_usage');
  assert.equal(record['retryAfterMs'], 30 * 60_000);
});

test('a non-Error rejection still maps to a well-formed error result', async () => {
  const result = await callProbeServer('facebook_probe_fail', { kind: 'non-error' });

  assert.equal(result.isError, true);
  assert.deepEqual(parseResult(result), { error: 'probe rejected with a bare string' });
});

test('an error message carrying the token is redacted before it reaches the client', async () => {
  const result = await callProbeServer('facebook_probe_fail', { kind: 'plain' });

  assert.equal(result.isError, true);
  const text = firstText(result);
  // The error path runs through the same redaction choke-point as the success
  // path — a token pasted into an exception message is the classic leak.
  assert.ok(
    !text.includes(ACCESS_TOKEN),
    'the access token leaked through the error path',
  );
  assert.match(text, /\[REDACTED\]/);
});

// ---------------------------------------------------------------------------
// The upload-progress seam (CC-MCP-1)
// ---------------------------------------------------------------------------
//
// `ToolContext.reportProgress` is the only channel a long upload has to say it
// is still alive, and the bootstrap owns BOTH ends of it: the caller's
// `_meta.progressToken` arrives on the SDK `extra`, and the matching
// `notifications/progress` frames leave through that same request's notification
// sender. Neither end is visible from a tool's own tests (which inject a fake
// reporter), so all three properties are pinned here on the raw wire, through a
// probe tool that does nothing but report:
//
//   * a call that supplied a token gets frames addressed with THAT token;
//   * a call that supplied none gets no reporter and no frames at all;
//   * a notification that cannot be delivered never fails the tool call.

/** The tool name of the progress probe. */
const PROGRESS_TOOL = 'facebook_probe_progress';

/**
 * The updates the probe pushes, in order. The three shapes are deliberate: a
 * full triple, one without a message, and a bare counter with no total (the
 * legal shape for an upload whose size is not known up front) — the optional
 * members must ride along only when present, never as explicit nulls.
 */
const PROBE_UPDATES: readonly ProgressUpdate[] = [
  { progress: 0, total: 3, message: 'uploading chunk 1/3' },
  { progress: 2, total: 3 },
  { progress: 3 },
];

/** An opaque, caller-chosen progress token; the spec allows a string or a number. */
const PROGRESS_TOKEN = 'probe-progress-token-7c3a';

/** A package holding one tool that forwards {@link PROBE_UPDATES} and reports back. */
function progressProbePackage(): PackageSpec {
  const tool = defineTool({
    name: PROGRESS_TOOL,
    title: 'Progress probe',
    description: 'Test-only: push a fixed progress sequence through the ToolContext.',
    inputSchema: z.object({}),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: (_input, ctx) => {
      // Exactly how a real upload reports: optional-call, fire and forget.
      for (const update of PROBE_UPDATES) ctx.reportProgress?.(update);
      return Promise.resolve(
        textResult({ hasReporter: ctx.reportProgress !== undefined }),
      );
    },
  });

  return {
    name: 'ads',
    title: 'Progress probe',
    description: 'Test-only package injected through the packages seam.',
    tools: [tool],
    enabledByDefault: false,
  };
}

/** Core plus the progress probe, which occupies the selectable `ads` slot. */
function progressPackages(): readonly PackageSpec[] {
  return [
    createCorePackage({ serverVersion: '1.2.3-test', sdkVersion: '1.29.0-test' }),
    progressProbePackage(),
  ];
}

/** One frame as it left the server transport, read structurally. */
interface WireFrame {
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

/**
 * Connect to a progress-probe server, recording every raw frame the SERVER
 * emits — the only place the progress token is observable, since the SDK's
 * client-side dispatcher strips it before handing the update to `onprogress`.
 *
 * `failProgress` makes the transport reject exactly the progress frames. That is
 * the honest way to reproduce the client that closed its stream mid-upload, and
 * the only way to observe that a doomed notification cannot fail the call it
 * belongs to.
 */
async function connectProgress(
  deps: BuildServerDeps,
  failProgress = false,
): Promise<{
  client: Client;
  /** Every server→client frame, in order. */
  readonly frames: readonly WireFrame[];
  close: () => Promise<void>;
}> {
  const server = buildServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const frames: WireFrame[] = [];
  const deliver = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, options) => {
    const frame = message as WireFrame;
    frames.push(frame);
    if (failProgress && frame.method === 'notifications/progress') {
      throw new Error('the client stream is gone');
    }
    await deliver(message, options);
  };

  await server.connect(serverTransport);
  const client = new Client({ name: 'facebook-mcp-test', version: '0.0.0' });
  // A caller-chosen token is unknown to the SDK's own progress bookkeeping, so
  // its dispatcher reports one as a protocol error on `onerror`. That is the
  // client's business, not the server's; swallow it to keep the run quiet.
  client.onerror = () => undefined;
  await client.connect(clientTransport);

  return {
    client,
    frames,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** The `notifications/progress` frames the server emitted, in order. */
function progressFrames(
  frames: readonly WireFrame[],
): readonly Record<string, unknown>[] {
  return frames
    .filter((frame) => frame.method === 'notifications/progress')
    .map((frame) => frame.params ?? {});
}

/** Drive one `tools/call` carrying an explicit, caller-chosen progress token. */
async function callWithProgressToken(
  client: Client,
  token: string,
): Promise<CallToolResult> {
  return await client.request(
    {
      method: 'tools/call',
      params: { name: PROGRESS_TOOL, arguments: {}, _meta: { progressToken: token } },
    },
    CallToolResultSchema,
  );
}

test('a progress token turns tool progress into notifications carrying that token', async () => {
  const { deps } = makeHarness({
    settings: probeSettings(),
    packages: progressPackages(),
  });
  const session = await connectProgress(deps);

  try {
    const result = await callWithProgressToken(session.client, PROGRESS_TOKEN);

    assert.notEqual(result.isError, true);
    // The reporter must be present, or the tool silently uploads in the dark.
    assert.equal(parseResult(result)['hasReporter'], true);

    // Every update reached the wire, in order, addressed with the caller's own
    // token — an unaddressed (or differently addressed) frame is undeliverable.
    assert.deepEqual(progressFrames(session.frames), [
      {
        progressToken: PROGRESS_TOKEN,
        progress: 0,
        total: 3,
        message: 'uploading chunk 1/3',
      },
      { progressToken: PROGRESS_TOKEN, progress: 2, total: 3 },
      { progressToken: PROGRESS_TOKEN, progress: 3 },
    ]);
  } finally {
    await session.close();
  }
});

test('an SDK client that asks for progress receives the updates it subscribed to', async () => {
  const { deps } = makeHarness({
    settings: probeSettings(),
    packages: progressPackages(),
  });
  const session = await connectProgress(deps);

  try {
    // The other half of the contract: a stock SDK client mints its own token
    // via `onprogress`, so this is the path a real MCP host actually takes.
    const seen: Progress[] = [];
    await session.client.callTool(
      { name: PROGRESS_TOOL, arguments: {} },
      CallToolResultSchema,
      { onprogress: (update) => seen.push(update) },
    );

    assert.deepEqual(seen, [...PROBE_UPDATES]);
  } finally {
    await session.close();
  }
});

test('a call without a progress token gets no reporter and emits no notification', async () => {
  const { deps } = makeHarness({
    settings: probeSettings(),
    packages: progressPackages(),
  });
  const session = await connectProgress(deps);

  try {
    const result = (await session.client.callTool({
      name: PROGRESS_TOOL,
      arguments: {},
    })) as CallToolResult;

    assert.notEqual(result.isError, true);
    // Absent, not a no-op stub: consumers branch on `reportProgress !== undefined`
    // to decide whether to wire an upload's `onProgress` at all.
    assert.equal(parseResult(result)['hasReporter'], false);
    // A frame with no token is undeliverable and would be reported by the client
    // as a protocol error, so none may be emitted.
    assert.deepEqual(progressFrames(session.frames), []);
  } finally {
    await session.close();
  }
});

test('a notification that cannot be delivered never fails the tool call', async () => {
  const { deps } = makeHarness({
    settings: probeSettings(),
    packages: progressPackages(),
  });
  const session = await connectProgress(deps, true);

  try {
    const result = await callWithProgressToken(session.client, PROGRESS_TOKEN);

    // Progress is best-effort: a publish that succeeded must not be reported as
    // a failure because the client stopped listening to the commentary.
    assert.notEqual(result.isError, true);
    assert.equal(parseResult(result)['hasReporter'], true);
    // All three sends were attempted and all three were rejected by the
    // transport; the rejections are swallowed, never left unhandled.
    assert.equal(progressFrames(session.frames).length, PROBE_UPDATES.length);
  } finally {
    await session.close();
  }
});

// ---------------------------------------------------------------------------
// Doctor probe seams (V02 metric probe, CC-ADS-6 ad-account probe)
// ---------------------------------------------------------------------------
//
// `mcp/doctor.ts` deliberately owns no api imports, so both probes are built
// here in the bootstrap and injected. They are exported for exactly this: the
// classification is the whole value of the seam, and it is invisible from the
// doctor's own tests (which inject stubs). Everything below runs against fakes.

/** A probe context over the given fake Graph transport. */
function probeContext(
  fb: FakeFbRequest,
  env: Record<string, string> = {},
  signal?: AbortSignal,
): {
  ctx: MetricProbeContext;
} {
  const { settings } = loadSettings({
    env: { FB_ACCESS_TOKEN: ACCESS_TOKEN, ...env },
    loadEnvFile: false,
  });
  return {
    ctx: {
      fbRequest: fb.fn,
      settings,
      clock: createFakeClock(1_760_000_000_000),
      ...(signal !== undefined ? { signal } : {}),
    },
  };
}

/** A resolver whose default Page is the one the probes are expected to query. */
function probePages(): ReturnType<typeof createFakePageResolver> {
  return createFakePageResolver({
    default: { pageId: '1010', name: 'Brand A', token: SECRET_PAGE_TOKEN },
  });
}

/** One Graph insights entry with `points` data points. */
function insightsEntry(name: string, points: number): Record<string, unknown> {
  return {
    name,
    period: 'day',
    values: Array.from({ length: points }, (_, i) => ({
      value: 10 + i,
      end_time: `2026-07-0${String(i + 1)}T07:00:00+0000`,
    })),
  };
}

test('metricProbe reports available when the Page answers insights', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    (req) => req.path === '/1010/insights',
    fbOk({
      data: [insightsEntry('page_media_view', 2), insightsEntry('page_follows', 2)],
    }),
  );
  const pages = probePages();

  const result = await metricProbe(pages)(probeContext(fb).ctx);

  assert.equal(result.available, true);
  assert.match(result.summary, /Page 1010 answers insights/);
  assert.match(result.summary, /page_media_view/);
  assert.equal(result.details?.['pageId'], '1010');
  // The probe must use the resolved PAGE token, not the user token — Page
  // insights are readable only with a Page token carrying ANALYZE.
  assert.equal(fb.calls[0]?.token, SECRET_PAGE_TOKEN);
  // Aggregate mode: totals only, so the result carries no row series at all.
  assert.equal(fb.calls.length, 1, 'the probe must cost exactly one Graph call');
});

test('metricProbe blames the eligibility floor when Graph answers with no data', async () => {
  const fb = createFakeFbRequest();
  // Graph accepted both names and returned entries — with zero data points.
  fb.on(
    (req) => req.path === '/1010/insights',
    fbOk({
      data: [insightsEntry('page_media_view', 0), insightsEntry('page_follows', 0)],
    }),
  );

  const result = await metricProbe(probePages())(probeContext(fb).ctx);

  assert.equal(result.available, false);
  // The two indistinguishable causes must BOTH be named, or the operator fixes
  // the wrong one: a Page under the floor, or a token missing the scope/task.
  assert.match(result.summary, /eligibility floor/);
  assert.match(result.summary, /read_insights/);
  assert.match(result.summary, /ANALYZE/);
  assert.deepEqual(result.details?.['empty'], ['page_media_view', 'page_follows']);
});

test('metricProbe blames the metric names when Graph returns no entry at all', async () => {
  const fb = createFakeFbRequest();
  fb.on((req) => req.path === '/1010/insights', fbOk({ data: [] }));

  const result = await metricProbe(probePages())(probeContext(fb).ctx);

  assert.equal(result.available, false);
  // An absent entry is a version problem, NOT a Page problem — saying "your
  // Page has no reach" here would send the operator chasing a ghost.
  assert.match(result.summary, /not valid for the pinned API version/);
  assert.equal((result.details?.['answered'] as string[]).length, 0);
});

test('adAccountProbe reports "not configured" without calling Graph', async () => {
  const fb = createFakeFbRequest();

  const result = await adAccountProbe()(probeContext(fb).ctx);

  assert.equal(result.available, false);
  assert.match(result.summary, /FB_AD_ACCOUNT_ID/);
  assert.equal(fb.calls.length, 0, 'an unconfigured probe must make no Graph call');
});

test('adAccountProbe reports a serving ad account', async () => {
  const fb = createFakeFbRequest();
  fb.on(
    (req) => req.path === '/act_12345',
    fbOk({ id: 'act_12345', account_status: 1, currency: 'EUR' }),
  );

  const { ctx } = probeContext(fb, { FB_AD_ACCOUNT_ID: '12345' });
  const result = await adAccountProbe()(ctx);

  assert.equal(result.available, true);
  assert.match(result.summary, /act_12345/);
  assert.equal(result.details?.['currency'], 'EUR');
});

test('adAccountProbe surfaces the disable reason and omits an absent currency', async () => {
  const fb = createFakeFbRequest();
  // A disabled account with no currency: the reason is the only thing that
  // tells the operator whether this is fixable in Ads Manager at all.
  fb.on(
    (req) => req.path === '/act_12345',
    fbOk({ id: 'act_12345', account_status: 2, disable_reason: 1 }),
  );

  const { ctx } = probeContext(fb, { FB_AD_ACCOUNT_ID: 'act_12345' });
  const result = await adAccountProbe()(ctx);

  assert.equal(result.available, false, 'a disabled account must not read as serving');
  assert.equal(result.details?.['statusLabel'], 'DISABLED');
  assert.equal(result.details?.['disableReason'], 'ADS_INTEGRITY_POLICY');
  // Absent, not null — the details map is read by an operator, and `currency:
  // null` would look like a second fault.
  assert.ok(!('currency' in (result.details ?? {})));
});

test('both probes forward an abort signal to Graph', async () => {
  const controller = new AbortController();

  const insightsFb = createFakeFbRequest();
  insightsFb.on(
    (req) => req.path === '/1010/insights',
    fbOk({ data: [insightsEntry('page_media_view', 1)] }),
  );
  await metricProbe(probePages())(probeContext(insightsFb, {}, controller.signal).ctx);
  assert.equal(insightsFb.calls[0]?.signal, controller.signal);

  const adsFb = createFakeFbRequest();
  adsFb.on(
    (req) => req.path === '/act_12345',
    fbOk({ id: 'act_12345', account_status: 1, currency: 'EUR' }),
  );
  await adAccountProbe()(
    probeContext(adsFb, { FB_AD_ACCOUNT_ID: '12345' }, controller.signal).ctx,
  );
  assert.equal(adsFb.calls[0]?.signal, controller.signal);
});

// ---------------------------------------------------------------------------
// The doctor as the bootstrap wires it
// ---------------------------------------------------------------------------

/** Run the doctor with BOTH bootstrap probes wired, exactly as `main` wires them. */
async function runWiredDoctor(
  fb: FakeFbRequest,
  env: Record<string, string> = {},
): Promise<{ report: DoctorReport; rendered: string }> {
  const { settings } = loadSettings({ env, loadEnvFile: false });
  const redactor = createFakeRedactor({ secrets: [settings.accessToken ?? ''] });
  const report = await runDoctor({
    fbRequest: fb.fn,
    settings,
    clock: createFakeClock(1_760_000_000_000),
    logger: silentLogger,
    redactor,
    packages: [
      createCorePackage({ serverVersion: '1.2.3-test', sdkVersion: '1.29.0-test' }),
    ],
    serverVersion: '1.2.3-test',
    metricProbe: metricProbe(probePages()),
    adAccountProbe: adAccountProbe(),
  });
  return { report, rendered: renderDoctorReport(report) };
}

test('the doctor names the missing credential instead of failing', async () => {
  const fb = createFakeFbRequest();

  // No FB_* at all — the state a first-run operator is actually in.
  const { report, rendered } = await runWiredDoctor(fb, {});

  assert.equal(report.token.configured, false);
  assert.match(report.token.error ?? '', /FB_ACCESS_TOKEN/);
  assert.match(rendered, /facebook-mcp doctor/);
  // Neither the token inspection nor the ad-account probe spends a call it
  // already knows will fail; only the metric probe (which has a resolved Page
  // to try) reaches Graph at all.
  assert.equal(report.adAccount.available, false);
  assert.match(report.adAccount.summary, /FB_AD_ACCOUNT_ID/);
  assert.deepEqual(
    fb.calls.map((call) => call.path),
    ['/1010/insights'],
  );
});

test('the doctor folds a rejected token into the report rather than throwing', async () => {
  const fb = createFakeFbRequest();
  // Every call fails the way a revoked token fails, including the probes'.
  fb.on(
    () => true,
    fbErr(
      new GraphApiError('Error validating access token: the session is invalid', {
        code: 190,
        type: 'OAuthException',
        httpStatus: 401,
      }),
    ),
  );

  const { report, rendered } = await runWiredDoctor(fb, {
    FB_ACCESS_TOKEN: ACCESS_TOKEN,
  });

  // The whole point of `doctor` is that it still prints when auth is broken.
  assert.equal(report.token.configured, true);
  assert.equal(report.token.valid, false);
  assert.equal(report.metricProbe.available, false);
  assert.match(report.metricProbe.summary, /failed/);
  assert.equal(report.adAccount.available, false);
  // The rendered report is what an operator pastes into an issue — the
  // configured token must not ride along with it.
  assert.ok(
    !rendered.includes(ACCESS_TOKEN),
    'the doctor report leaked the access token',
  );
});

// ---------------------------------------------------------------------------
// The confirmation seam over a live session (D12) and the per-package write
// gate (D9), seen through a synthetic WRITE package
// ---------------------------------------------------------------------------
//
// Everything below drives a real `tools/call` through the bootstrap's own write
// wiring: `buildServer` builds the confirmer from the live session's elicitation
// capability, memoizes one `WriteGate` per DISTINCT effective write mode, and
// picks the gate per call from `registry.writeModeFor`. None of that is visible
// from a read-only package, so the probe below is a write tool built out of the
// SAME shared authoring helpers a real vertical uses (`confirmableWriteArgs` +
// `gateArgs` + `executeWrite`) — a hand-rolled gate call would test the test.
//
// The properties pinned:
//   (a) an ACCEPTED elicitation authorizes an `irreversible` apply, and the
//       prompt the human sees names the tool and the plan it authorizes;
//   (b) a declined prompt — and an accepted one with the box left unticked —
//       both refuse the write, leaving no `applied` journal record;
//   (c) a client that cannot elicit falls through to the operator-token route
//       (CC-MCP-6), which denies without a token and authorizes with one;
//   (d) the per-package write mode is most-restrictive-wins, and two packages
//       resolving to different modes really do get different gates.

/** The operator token the confirm-token fall-through is authorized with. */
const OPERATOR_TOKEN = 'operator-confirm-token-4d3c2b1a';

/** The `irreversible` probe tool the confirmation tests drive. */
const CONFIRM_TOOL = 'facebook_probe_delete';

/** The two write probes used for the per-package write-mode tests. */
const POSTS_WRITE_TOOL = 'facebook_probe_posts_write';
const MODERATION_WRITE_TOOL = 'facebook_probe_moderation_write';

/** What a {@link writeProbePackage} is stamped out of. */
interface WriteProbeOptions {
  /** The package slot the probe occupies (it must be selectable by name). */
  readonly packageName: PackageName;
  readonly tool: string;
  readonly tier: WriteTier;
  /** The package's declared default; omitted ⇒ the package declares none. */
  readonly writeModeDefault?: WriteMode;
}

/**
 * A package holding ONE write tool that runs a trivial mutation through the
 * gate the bootstrap injected. `perform` only echoes its input: what is under
 * test is which gate ran it, and whether it ran at all.
 *
 * It spreads `confirmableWriteArgs` at every tier so a single factory serves
 * both the `irreversible` confirmation tests and the `reversible` write-mode
 * ones; a real reversible tool would spread the narrower `writeArgs`.
 */
function writeProbePackage(options: WriteProbeOptions): PackageSpec {
  const tool = defineTool({
    name: options.tool,
    title: 'Write probe',
    description: 'Test-only: run one write through the injected write gate.',
    inputSchema: z.object({
      ...confirmableWriteArgs,
      note: z.string().describe('Free text; the planned params this write binds to.'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    writeTier: options.tier,
    handler: (input, ctx) =>
      executeWrite(ctx, {
        tool: options.tool,
        tier: options.tier,
        params: { note: input.note },
        ...gateArgs(input),
        summary: `write the note "${input.note}"`,
        perform: () => Promise.resolve({ note: input.note }),
      }),
  });

  return {
    name: options.packageName,
    title: 'Write probe',
    description: 'Test-only write package injected through the packages seam.',
    tools: [tool],
    enabledByDefault: false,
    ...(options.writeModeDefault !== undefined
      ? { writeModeDefault: options.writeModeDefault }
      : {}),
  };
}

/** Settings selecting the `irreversible` probe (plus always-on `core`). */
function confirmSettings(env: Record<string, string> = {}): Settings {
  const { settings } = loadSettings({
    env: { FB_ACCESS_TOKEN: ACCESS_TOKEN, FB_TOOL_PACKAGES: 'ads', ...env },
    loadEnvFile: false,
  });
  return settings;
}

/** The injected packages for a confirmation test: core + the irreversible probe. */
function confirmPackages(): readonly PackageSpec[] {
  return [
    createCorePackage({ serverVersion: '1.2.3-test', sdkVersion: '1.29.0-test' }),
    writeProbePackage({
      packageName: 'ads',
      tool: CONFIRM_TOOL,
      tier: 'irreversible',
    }),
  ];
}

/** One elicitation request, as the client's handler received it. */
interface RecordedPrompt {
  readonly message: string;
  /** The form schema the server asked the human to fill in (form mode only). */
  readonly requestedSchema?: unknown;
}

/**
 * Connect a client that CAN answer an elicitation prompt, recording every prompt
 * it was shown and answering each through `respond`.
 *
 * The advertised capability is `{ form: {} }` rather than the bare `{}` of the
 * older spec revision: this SDK's server-side `elicitInput` requires the `form`
 * sub-capability, so a bare `{}` never reaches the client at all (it throws
 * inside the SDK, which `createConfirmer` then treats as a failed elicitation).
 */
async function connectEliciting(
  deps: BuildServerDeps,
  respond: (prompt: RecordedPrompt) => ElicitResult,
): Promise<{
  client: Client;
  prompts: readonly RecordedPrompt[];
  close: () => Promise<void>;
}> {
  const server = buildServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client(
    { name: 'facebook-mcp-test', version: '0.0.0' },
    { capabilities: { elicitation: { form: {} } } },
  );
  const prompts: RecordedPrompt[] = [];
  client.setRequestHandler(ElicitRequestSchema, (request) => {
    const params = request.params;
    const prompt: RecordedPrompt = {
      message: params.message,
      ...('requestedSchema' in params ? { requestedSchema: params.requestedSchema } : {}),
    };
    prompts.push(prompt);
    return respond(prompt);
  });
  await client.connect(clientTransport);

  return {
    client,
    prompts,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/**
 * Dry-run one write, then apply the plan it returned — both over the SAME
 * session, because the gate's plan store lives for one server lifetime.
 */
async function planThenApply(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ planId: string; applied: CallToolResult }> {
  const preview = parseResult(
    (await client.callTool({ name, arguments: args })) as CallToolResult,
  );
  assert.equal(preview['status'], 'preview', 'the first call must be a dry run');
  const planId = String(preview['planId']);
  const applied = (await client.callTool({
    name,
    arguments: { ...args, apply: true, plan_id: planId },
  })) as CallToolResult;
  return { planId, applied };
}

/** The `applied` records the journal holds (the only proof a mutation ran). */
function appliedEntries(journal: MemoryJournal): readonly { tool: string }[] {
  return journal.entries.filter((entry) => entry.outcome === 'applied');
}

test('an accepted elicitation authorizes an irreversible apply', async () => {
  const { deps, journal } = makeHarness({
    settings: confirmSettings(),
    packages: confirmPackages(),
  });
  const session = await connectEliciting(deps, () => ({
    action: 'accept',
    content: { confirm: true },
  }));

  try {
    const { planId, applied } = await planThenApply(session.client, CONFIRM_TOOL, {
      note: 'remove the spam comment',
    });

    assert.notEqual(applied.isError, true);
    const record = parseResult(applied);
    assert.equal(record['status'], 'applied');
    assert.equal(record['applied'], true);

    // Exactly one prompt: the dry run must never bother a human, only the apply.
    assert.equal(session.prompts.length, 1, 'only the apply may raise a prompt');
    const prompt = session.prompts[0];
    assert.ok(prompt);
    // The human answering this prompt is NOT reading the model transcript, so
    // the text has to identify the action and the plan on its own.
    assert.match(prompt.message, new RegExp(CONFIRM_TOOL));
    assert.match(prompt.message, /irreversible write requires out-of-band confirmation/);
    assert.match(prompt.message, /remove the spam comment/);
    assert.ok(
      prompt.message.includes(`Plan: ${planId}`),
      'the prompt must name the plan it authorizes',
    );
    // The prompt is rendered OUTSIDE the session, by whatever UI the client has;
    // a token riding along with it would hand the secret to that UI.
    assert.ok(
      !prompt.message.includes(ACCESS_TOKEN),
      'the confirmation prompt leaked the access token',
    );

    // One boolean to tick — not "type the tool name back", which a human who
    // cannot see the transcript could not answer.
    const schema = prompt.requestedSchema as {
      required?: readonly string[];
      properties?: Record<string, { type?: string }>;
    };
    assert.deepEqual(schema.required, ['confirm']);
    assert.equal(schema.properties?.['confirm']?.type, 'boolean');
  } finally {
    await session.close();
  }

  const applied = appliedEntries(journal);
  assert.equal(applied.length, 1, 'the confirmed apply must be journaled');
  assert.equal(applied[0]?.tool, CONFIRM_TOOL);
});

test('a declined elicitation refuses the write', async () => {
  const { deps, journal } = makeHarness({
    settings: confirmSettings(),
    packages: confirmPackages(),
  });
  const session = await connectEliciting(deps, () => ({ action: 'decline' }));

  try {
    const { applied } = await planThenApply(session.client, CONFIRM_TOOL, {
      note: 'remove the spam comment',
    });

    assert.equal(applied.isError, true);
    const record = parseResult(applied);
    assert.equal(record['code'], 'confirmation_denied');
    assert.equal(record['tool'], CONFIRM_TOOL);
    assert.equal(record['tier'], 'irreversible');
    // The reported method is the channel actually used (CC-MCP-6) — here the
    // human really was asked, and really said no.
    assert.match(String(record['error']), /\(elicitation\)/);
    assert.equal(session.prompts.length, 1);
  } finally {
    await session.close();
  }

  assert.equal(appliedEntries(journal).length, 0, 'a refused write must not apply');
});

test('an accepted elicitation with the box unticked still refuses the write', async () => {
  const { deps, journal } = makeHarness({
    settings: confirmSettings(),
    packages: confirmPackages(),
  });
  // `accept` is the client saying "the human answered", NOT "the human agreed":
  // reading the action alone would turn a submitted-but-unticked form into a
  // deletion.
  const session = await connectEliciting(deps, () => ({
    action: 'accept',
    content: { confirm: false },
  }));

  try {
    const { applied } = await planThenApply(session.client, CONFIRM_TOOL, {
      note: 'remove the spam comment',
    });

    assert.equal(applied.isError, true);
    const record = parseResult(applied);
    assert.equal(record['code'], 'confirmation_denied');
    assert.match(String(record['error']), /\(elicitation\)/);
  } finally {
    await session.close();
  }

  assert.equal(appliedEntries(journal).length, 0, 'an unticked box must not apply');
});

test('a client without elicitation is denied when no operator token is configured', async () => {
  const { deps, journal } = makeHarness({
    settings: confirmSettings(),
    packages: confirmPackages(),
  });
  // The default `connect` client advertises no capabilities at all, so
  // `elicitVia` throws and the confirmer falls through to the token route.
  const { client, close } = await connect(deps);

  try {
    const { applied } = await planThenApply(client, CONFIRM_TOOL, {
      note: 'remove the spam comment',
    });

    assert.equal(applied.isError, true);
    const record = parseResult(applied);
    assert.equal(record['code'], 'confirmation_denied');
    // Truthfully `denied`, never `elicitation`: no human was asked anything.
    assert.match(String(record['error']), /\(denied\)/);
  } finally {
    await close();
  }

  assert.equal(
    appliedEntries(journal).length,
    0,
    'an unconfirmable write must never fall through to a silent allow',
  );
});

test('the operator token authorizes an apply the client cannot elicit', async () => {
  const { deps, journal } = makeHarness({
    settings: confirmSettings({ FB_CONFIRM_TOKEN: OPERATOR_TOKEN }),
    packages: confirmPackages(),
  });
  const { client, close } = await connect(deps);

  try {
    // A token that does not match is exactly as good as no token at all.
    const wrong = await planThenApply(client, CONFIRM_TOOL, {
      note: 'remove the wrong comment',
      confirm_token: 'not-the-operator-token',
    });
    assert.equal(wrong.applied.isError, true);
    assert.equal(parseResult(wrong.applied)['code'], 'confirmation_denied');

    // The matching token is the whole out-of-band authorization for this apply.
    const right = await planThenApply(client, CONFIRM_TOOL, {
      note: 'remove the spam comment',
      confirm_token: OPERATOR_TOKEN,
    });
    assert.notEqual(right.applied.isError, true);
    const record = parseResult(right.applied);
    assert.equal(record['status'], 'applied');
    assert.equal(record['applied'], true);
  } finally {
    await close();
  }

  const applied = appliedEntries(journal);
  assert.equal(applied.length, 1);
  assert.equal(applied[0]?.tool, CONFIRM_TOOL);
  // The journal is a durable operator artifact; the token that authorized the
  // write is not part of the record (it is neither a param nor metadata).
  assert.ok(
    !JSON.stringify(journal.entries).includes(OPERATOR_TOKEN),
    'the operator token was journaled',
  );
});

/**
 * Settings selecting BOTH write probes. `mode` is the operator's `FB_WRITE_MODE`;
 * passing `undefined` LEAVES IT UNSET, which is the case where a package's own
 * `writeModeDefault` governs — the distinction the bootstrap turns on.
 */
function writeModeSettings(mode: WriteMode | undefined): Settings {
  const { settings } = loadSettings({
    env: {
      FB_ACCESS_TOKEN: ACCESS_TOKEN,
      FB_TOOL_PACKAGES: 'posts,moderation',
      ...(mode !== undefined ? { FB_WRITE_MODE: mode } : {}),
    },
    loadEnvFile: false,
  });
  return settings;
}

/**
 * Two `reversible` write probes plus core. Neither call below passes `apply`, so
 * the ONLY thing that decides preview-vs-apply is the write mode the bootstrap
 * resolved for that tool's package.
 */
function writeModePackages(
  postsDefault: WriteMode | undefined,
  moderationDefault: WriteMode | undefined,
): readonly PackageSpec[] {
  return [
    createCorePackage({ serverVersion: '1.2.3-test', sdkVersion: '1.29.0-test' }),
    writeProbePackage({
      packageName: 'posts',
      tool: POSTS_WRITE_TOOL,
      tier: 'reversible',
      ...(postsDefault !== undefined ? { writeModeDefault: postsDefault } : {}),
    }),
    writeProbePackage({
      packageName: 'moderation',
      tool: MODERATION_WRITE_TOOL,
      tier: 'reversible',
      ...(moderationDefault !== undefined ? { writeModeDefault: moderationDefault } : {}),
    }),
  ];
}

/** Call a write probe with no gating arguments and return its parsed envelope. */
async function callWriteProbe(
  client: Client,
  name: string,
): Promise<Record<string, unknown>> {
  return parseResult(
    (await client.callTool({
      name,
      arguments: { note: `from ${name}` },
    })) as CallToolResult,
  );
}

test('an explicit FB_WRITE_MODE=plan outranks a package that declares apply', async () => {
  const { deps, journal } = makeHarness({
    settings: writeModeSettings('plan'),
    // `moderation` asks for apply-by-default; `posts` declares nothing.
    packages: writeModePackages(undefined, 'apply'),
  });
  const { client, close } = await connect(deps);

  try {
    for (const tool of [POSTS_WRITE_TOOL, MODERATION_WRITE_TOOL]) {
      const record = await callWriteProbe(client, tool);
      // The kill switch: an operator who TYPED `FB_WRITE_MODE=plan` has spoken
      // about every package, so no package default may re-enable the unattended
      // writes that switch was flipped to stop.
      assert.equal(record['status'], 'preview', `${tool} must stay a dry run`);
      assert.equal(record['applied'], false);
    }
  } finally {
    await close();
  }

  assert.equal(appliedEntries(journal).length, 0, 'the kill switch must hold');
});

test('with FB_WRITE_MODE unset each package runs on its own gate', async () => {
  const { deps, journal } = makeHarness({
    settings: writeModeSettings(undefined),
    // `posts` is plan-first (as the real package is); `moderation` ships
    // apply-by-default so day-to-day hide/unhide does not stack a preview.
    packages: writeModePackages('plan', 'apply'),
  });
  const { client, close } = await connect(deps);

  try {
    const planned = await callWriteProbe(client, POSTS_WRITE_TOOL);
    assert.equal(planned['status'], 'preview', 'a plan-first package must dry-run');

    const performed = await callWriteProbe(client, MODERATION_WRITE_TOOL);
    assert.equal(performed['status'], 'applied');
    assert.equal(performed['applied'], true);
  } finally {
    await close();
  }

  // One gate per DISTINCT effective mode, picked per call: had the bootstrap
  // built a single gate from `settings.writeMode`, neither write would have
  // applied; had it built one from the first tool's package, both would.
  const applied = appliedEntries(journal);
  assert.equal(applied.length, 1);
  assert.equal(applied[0]?.tool, MODERATION_WRITE_TOOL);
});

test('an explicit FB_WRITE_MODE=apply overrides a plan-first package', async () => {
  const { deps, journal } = makeHarness({
    settings: writeModeSettings('apply'),
    packages: writeModePackages('plan', 'apply'),
  });
  const { client, close } = await connect(deps);

  try {
    // The operator opted in deliberately, so the declaration no longer governs.
    // The blast radius is bounded to `reversible` tools: `irreversible`/`spend`
    // ignore the write mode outright and still demand apply + plan_id + confirm.
    for (const tool of [POSTS_WRITE_TOOL, MODERATION_WRITE_TOOL]) {
      const record = await callWriteProbe(client, tool);
      assert.equal(record['status'], 'applied', `${tool} must apply`);
    }
  } finally {
    await close();
  }

  assert.equal(appliedEntries(journal).length, 2);
});

// --- `--version` (G-TOOL-5) ------------------------------------------------

test('isVersionFlag recognises only the version flag and its alias', () => {
  assert.equal(isVersionFlag('--version'), true);
  assert.equal(isVersionFlag('-v'), true);
  // Everything else must fall through to the subcommands and the server start,
  // so a typo can never be answered by silently printing a version and exiting 0.
  for (const arg of [undefined, '', 'version', '--v', '-V', 'doctor', '--verbose']) {
    assert.equal(isVersionFlag(arg), false, `${String(arg)} must not be the flag`);
  }
});

test('versionLine is greppable and names the server, the runtime and the SDK', () => {
  const line = versionLine('1.2.3', '1.29.0', {
    node: 'v22.23.0',
    platform: 'linux',
    arch: 'x64',
  });

  assert.equal(line, 'facebook-mcp 1.2.3 (node v22.23.0, linux x64, sdk 1.29.0)');
  // The second whitespace-separated field is the bare version, so a release
  // script can read it without parsing the parenthetical.
  assert.equal(line.split(' ')[1], '1.2.3');
  assert.equal(line.includes('\n'), false, 'the version output is one line');
});

/**
 * A fake for the two seams {@link resolveSdkVersion} reads through. `resolved`
 * absent ⇒ `resolve` throws, which is what a package that hides its manifest
 * does; every manifest slot absent ⇒ that read throws, as an absent file does.
 */
function fakeSdkSources(opts: {
  /** What `require.resolve` hands back for `<sdk>/package.json`. */
  readonly resolved?: string;
  /** Content served at `resolved`. */
  readonly stub?: string;
  /** Content served for `<ancestor>/node_modules/<sdk>/package.json`. */
  readonly installed?: string;
  /** Content served for this server's own `package.json`. */
  readonly own?: string;
}): SdkVersionSources {
  const serve = (content: string | undefined, path: string): string => {
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  };
  return {
    resolve: (specifier) => {
      if (opts.resolved === undefined) {
        throw new Error(`ERR_PACKAGE_PATH_NOT_EXPORTED: ${specifier}`);
      }
      return opts.resolved;
    },
    readText: (path) => {
      const key = String(path);
      if (key === opts.resolved) return serve(opts.stub, key);
      // The walk asks for a path under `node_modules`; nothing else does.
      return key.includes('node_modules')
        ? serve(opts.installed, key)
        : serve(opts.own, key);
    },
  };
}

test('resolveSdkVersion reads the version off the real installed SDK', () => {
  // Deliberately unfaked: this is the assertion that notices the resolution
  // chain rotting under a dependency bump (a new `exports` map, a different
  // install layout), which no fake can catch.
  assert.match(resolveSdkVersion(), /^\d+\.\d+\.\d+/);
});

test('resolveSdkVersion ignores the versionless dist stub Node resolves to', () => {
  const stubPath = '/app/node_modules/@modelcontextprotocol/sdk/dist/cjs/package.json';
  const version = resolveSdkVersion(
    fakeSdkSources({
      // What `require.resolve` really returns for this SDK: the `./*` exports
      // pattern maps `./package.json` onto `./dist/cjs/package.json`, a stub
      // that declares a module type and nothing else.
      resolved: stubPath,
      stub: '{"type":"commonjs"}',
      installed: '{"version":"9.9.9"}',
    }),
  );
  assert.equal(version, '9.9.9');
});

test('resolveSdkVersion walks up to node_modules when the package hides its manifest', () => {
  const version = resolveSdkVersion(
    fakeSdkSources({
      installed: '{"name":"@modelcontextprotocol/sdk","version":"1.2.3"}',
    }),
  );
  assert.equal(version, '1.2.3');
});

test('resolveSdkVersion falls back to the declared dependency range', () => {
  // The dependencies never installed — the range is not the running version,
  // but it still tells a bug report which SDK the tree asked for.
  const version = resolveSdkVersion(
    fakeSdkSources({ own: '{"dependencies":{"@modelcontextprotocol/sdk":"^1.29.0"}}' }),
  );
  assert.equal(version, '^1.29.0');
});

test('resolveSdkVersion degrades to "unknown" instead of throwing', () => {
  // Every source unreadable, then each shape that is readable but says nothing:
  // a manifest without the dependency, a non-object, a corrupt one, and an
  // installed manifest whose `version` is not a string.
  for (const sources of [
    fakeSdkSources({}),
    fakeSdkSources({ own: '{"dependencies":{}}' }),
    fakeSdkSources({ own: 'null' }),
    fakeSdkSources({ own: 'not json at all' }),
    fakeSdkSources({ installed: '{"version":123}' }),
  ]) {
    assert.equal(resolveSdkVersion(sources), 'unknown');
  }
});
