// Integration smoke for the server bootstrap (task I1).
//
// These tests drive the EXPORTED `buildServer` builder over a real in-process
// MCP session: a low-level `Server` wired to an SDK `Client` through
// `InMemoryTransport.createLinkedPair()`. They never call `main()` in-process
// (which would open a real transport and read the process environment) and never
// touch the network: every collaborator is an in-memory fake, so the
// test-runner's fetch-fence is never provoked. The one exception is the
// `--help` test, which runs the entry point as a child process that exits
// before settings are loaded.
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
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  createFbRequest,
  createLogger,
  createPagesRegistry,
  createRedactor,
  loadSettings,
  type LogFields,
  type LogLevel,
  type Logger,
  type PackageName,
  type PackageSpec,
  type ProgressUpdate,
  type Redactor,
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
  createAdsPackage,
  createCorePackage,
  createInsightsPackage,
  createMessagesPackage,
  createModerationPackage,
  createPostsPackage,
  createReaderPackage,
  executeWrite,
  gateArgs,
  META_ERROR_TEXT_MAX,
} from './tools/index.js';
import { withFetch, type FetchMock } from './testing/index.js';
import {
  adAccountProbe,
  buildServer,
  createTransport,
  isStrictFlag,
  isVersionFlag,
  logStartupWarnings,
  loadedPackages,
  metricProbe,
  resolveSdkVersion,
  runDoctorCommand,
  serverStartedFields,
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
  /** Swapped in by the log-line tests, which are ABOUT what the bootstrap logs. */
  readonly logger?: Logger;
  /** Swapped in when a test needs the real redactor rather than the value fake. */
  readonly redactor?: Redactor;
}

/** Assemble {@link buildServer} dependencies from in-memory fakes. */
function makeHarness(overrides: HarnessOverrides = {}): Harness {
  const settings = overrides.settings ?? testSettings();
  const clock = createFakeClock(1_000);
  const redactor =
    overrides.redactor ?? createFakeRedactor({ secrets: [settings.accessToken ?? ''] });
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
    logger: overrides.logger ?? silentLogger,
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
  'graph-user-text',
  'plain',
  'non-error',
  'non-error-object',
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
        case 'graph-user-text':
          // An ads/publishing refusal: `message` is the generic line, the
          // user-facing pair is the only human-readable reason.
          throw new GraphApiError('Graph API error (HTTP 400): Invalid parameter', {
            code: 100,
            subcode: 1_487_390,
            type: 'OAuthException',
            httpStatus: 400,
            userTitle: 'Budget Too Low',
            userMessage: `The daily budget must be at least $1.00 (token ${ACCESS_TOKEN}).`,
          });
        case 'plain':
          throw new Error(`upstream blew up while holding ${ACCESS_TOKEN}`);
        case 'non-error-object': {
          // A library that rejects with a plain object still names its reason.
          const notAnError: unknown = {
            message: 'probe rejected with an object',
            code: 'EPROBE',
          };
          throw notAnError;
        }
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

test('a tool disabled by package configuration says so, not "unknown tool"', async () => {
  // `ads` is built but off in the default profile; `posts` read-only drops its
  // write tools. Either way the name is real, and "unknown tool" sends the
  // model looking for a typo instead of at the operator's package settings.
  const adsTool = createAdsPackage().tools[0]?.name ?? '';
  const cases: readonly [Record<string, string>, string, RegExp][] = [
    [{}, adsTool, /package 'ads' is not loaded.*FB_TOOL_PACKAGES.*FB_PACKAGES_DENY/],
    [
      { FB_PACKAGES_READONLY: 'posts' },
      'facebook_delete_post',
      /FB_PACKAGES_READONLY drops the write tools of package 'posts'/,
    ],
  ];
  for (const [env, name, expected] of cases) {
    const { settings } = loadSettings({
      env: { FB_ACCESS_TOKEN: ACCESS_TOKEN, ...env },
      loadEnvFile: false,
    });
    const { deps, fb } = makeHarness({ settings, packages: bootstrapPackages() });
    const { client, close } = await connect(deps);
    try {
      const result = (await client.callTool({ name, arguments: {} })) as CallToolResult;
      assert.equal(result.isError, true);
      const error = String(parseResult(result)['error']);
      assert.match(error, new RegExp(`tool ${name} is disabled`));
      assert.match(error, expected);
    } finally {
      await close();
    }
    assert.equal(fb.calls.length, 0, 'a disabled tool must never reach Graph');
  }
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

test('a Graph error with user-facing text surfaces it beside the message, redacted', async () => {
  const result = await callProbeServer('facebook_probe_fail', {
    kind: 'graph-user-text',
  });

  assert.equal(result.isError, true);
  const record = parseResult(result);
  // Graph's own message is untouched (operators grep for it) …
  assert.equal(record['error'], 'Graph API error (HTTP 400): Invalid parameter');
  // … and the reason ships as its own two fields, through the same redaction
  // choke-point as everything else in the record.
  assert.equal(record['userTitle'], 'Budget Too Low');
  assert.equal(
    record['userMessage'],
    'The daily budget must be at least $1.00 (token [REDACTED]).',
  );
  assert.equal(record['code'], 100);
  assert.equal(record['subcode'], 1_487_390);

  // Absent on the error ⇒ absent on the record, never null.
  const bare = parseResult(
    await callProbeServer('facebook_probe_fail', { kind: 'graph-bare' }),
  );
  assert.ok(!('userTitle' in bare));
  assert.ok(!('userMessage' in bare));
});

test('a non-Error rejection still maps to a well-formed error result', async () => {
  const result = await callProbeServer('facebook_probe_fail', { kind: 'non-error' });

  assert.equal(result.isError, true);
  assert.deepEqual(parseResult(result), { error: 'probe rejected with a bare string' });
});

test('a non-Error object rejection keeps its message instead of "[object Object]"', async () => {
  const result = await callProbeServer('facebook_probe_fail', {
    kind: 'non-error-object',
  });

  assert.equal(result.isError, true);
  assert.deepEqual(parseResult(result), { error: 'probe rejected with an object' });
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
// (f) The per-call log line — `ToolSpec.logFields` (04 §"Log hygiene")
// ---------------------------------------------------------------------------
//
// The allowlist is a SECURITY control, so it is pinned from the outside, on the
// wire, rather than by unit-testing the projection helper: what matters is what
// a real `tools/call` puts in front of the logger. Four properties are load
// bearing and each gets its own test —
//
//   * only allowlisted keys appear, and the un-allowlisted sibling never does;
//   * a spec with no allowlist logs NOTHING (no default key set);
//   * every logged value goes through the redactor at the dispatch site;
//   * a non-scalar is reduced to its shape, never its content;
//
// plus the two the placement decision rests on: the line exists even when the
// call is rejected, and it lands on stderr, never on the stdio JSON-RPC channel.

/** The `msg` the bootstrap stamps on its one per-call line. */
const TOOL_CALL_MSG = 'tool call';

/** The probe whose spec allowlists three of its four arguments. */
const LOG_TOOL = 'facebook_probe_logged';

/** The probe that declares no allowlist at all — the 35-of-36 case. */
const QUIET_TOOL = 'facebook_probe_quiet';

/** One captured log call, in the shape the bootstrap handed to the logger. */
interface LogRecord {
  readonly level: LogLevel;
  readonly msg: string;
  readonly fields: LogFields | undefined;
}

/** A {@link Logger} that records instead of writing, so the fields stay inspectable. */
function recordingLogger(): { readonly logger: Logger; readonly records: LogRecord[] } {
  const records: LogRecord[] = [];
  const capture =
    (level: LogLevel) =>
    (msg: string, fields?: LogFields): void => {
      records.push({ level, msg, fields });
    };
  return {
    logger: {
      debug: capture('debug'),
      info: capture('info'),
      warn: capture('warn'),
      error: capture('error'),
    },
    records,
  };
}

/**
 * A probe package (again in the `ads` slot) holding the two specs the log tests
 * contrast: one with an allowlist, one without. `payload` is typed `unknown` on
 * purpose — the allowlist may name an argument whose value is not a scalar, and
 * that is precisely the case the projection has to refuse to serialize.
 */
function logProbePackage(): PackageSpec {
  const logged = defineTool({
    name: LOG_TOOL,
    description: 'Test-only: three of these four arguments are safe to log.',
    inputSchema: z.object({
      page_id: z.string().optional().describe('Allowlisted, and a string.'),
      limit: z.number().optional().describe('Allowlisted, and a non-string scalar.'),
      payload: z.unknown().optional().describe('Allowlisted, but any shape at all.'),
      note: z.string().optional().describe('NOT allowlisted; must never be logged.'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    logFields: ['page_id', 'limit', 'payload'],
    handler: () => Promise.resolve(textResult({ ok: true })),
  });

  const quiet = defineTool({
    name: QUIET_TOOL,
    description: 'Test-only: the same argument, with no allowlist declared.',
    inputSchema: z.object({
      page_id: z
        .string()
        .optional()
        .describe('Never logged: the spec allowlists nothing.'),
    }),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: () => Promise.resolve(textResult({ ok: true })),
  });

  return {
    name: 'ads',
    title: 'Log probe',
    description: 'Test-only package for the per-call log line.',
    tools: [logged, quiet],
    enabledByDefault: false,
  };
}

/** The injected package array for a log-probe-backed server. */
function logProbePackages(): readonly PackageSpec[] {
  return [
    createCorePackage({ serverVersion: '1.2.3-test', sdkVersion: '1.29.0-test' }),
    logProbePackage(),
  ];
}

/**
 * Drive one call against a log-probe server and hand back both the result and
 * everything the bootstrap logged. `redactor` is injectable because one test
 * needs the REAL redactor (the fake omits the defensive pattern scan).
 */
async function callLogProbe(
  name: string,
  args: Record<string, unknown>,
  redactor?: Redactor,
): Promise<{ readonly result: CallToolResult; readonly records: readonly LogRecord[] }> {
  const { logger, records } = recordingLogger();
  const { deps } = makeHarness({
    settings: probeSettings(),
    packages: logProbePackages(),
    logger,
    ...(redactor !== undefined ? { redactor } : {}),
  });
  const { client, close } = await connect(deps);
  try {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    return { result, records };
  } finally {
    await close();
  }
}

/** The single per-call line, asserted to exist exactly once. */
function onlyCallLine(records: readonly LogRecord[]): LogRecord {
  const lines = records.filter((r) => r.msg === TOOL_CALL_MSG);
  assert.equal(lines.length, 1, `expected exactly one ${TOOL_CALL_MSG} line`);
  const line = lines[0];
  assert.ok(line);
  return line;
}

test('a tool call logs the allowlisted arguments and nothing else', async () => {
  const { records } = await callLogProbe(LOG_TOOL, {
    page_id: '1234567890',
    limit: 7,
    note: 'free-text the operator never reviewed for hygiene',
  });

  // Exactly one line for the whole call, at `info` — the default level, so the
  // control is visible in a default install rather than only under FB_LOG_LEVEL.
  assert.equal(records.length, 1);
  const line = onlyCallLine(records);
  assert.equal(line.level, 'info');
  // The tool name sits at the top level and the arguments nest under `args`, so
  // an argument called `tool` can never displace the name of the tool.
  assert.deepEqual(line.fields, {
    tool: LOG_TOOL,
    args: { page_id: '1234567890', limit: 7 },
  });
  // `note` is an argument the caller DID send; it is absent because the spec
  // does not name it, which is the whole point of an allowlist.
  assert.ok(!JSON.stringify(line.fields).includes('free-text'));
});

test('a tool with no logFields allowlist logs nothing about the call', async () => {
  const { result, records } = await callLogProbe(QUIET_TOOL, { page_id: '1234567890' });

  assert.notEqual(result.isError, true);
  // Not "logs less" — logs NOTHING. An allowlist nobody wrote is not permission
  // to fall back to a default key set, and never to the argument object whole.
  assert.deepEqual(records, []);
});

test('an allowlisted value is redacted before it reaches the log', async () => {
  // The REAL redactor, because both of its strategies matter here: the user
  // token is a registered VALUE, while the Page token is one the process never
  // held and only the defensive pattern scan can catch.
  const { records } = await callLogProbe(
    LOG_TOOL,
    { page_id: `page-of-${ACCESS_TOKEN}`, payload: SECRET_PAGE_TOKEN },
    createRedactor({ secrets: [ACCESS_TOKEN] }),
  );

  const line = onlyCallLine(records);
  const rendered = JSON.stringify(line.fields);
  assert.ok(!rendered.includes(ACCESS_TOKEN), 'the access token reached the log');
  assert.ok(!rendered.includes(SECRET_PAGE_TOKEN), 'the Page token reached the log');
  assert.deepEqual(line.fields, {
    tool: LOG_TOOL,
    args: { page_id: 'page-of-[REDACTED]', payload: '[REDACTED]' },
  });
});

test('a non-scalar allowlisted argument is logged as a type tag, not its content', async () => {
  // An author reviews a KEY, not the arbitrary tree a caller can hang under it,
  // and the line is written before the strict parse — so the runtime shape of a
  // value is whatever the client sent. Anything but a scalar logs its shape.
  const cases: readonly (readonly [unknown, string])[] = [
    [{ token: SECRET_PAGE_TOKEN }, '[object]'],
    [[SECRET_PAGE_TOKEN], '[array]'],
    [null, '[null]'],
  ];

  for (const [value, tag] of cases) {
    const { records } = await callLogProbe(LOG_TOOL, { payload: value });
    const line = onlyCallLine(records);
    assert.deepEqual(line.fields, { tool: LOG_TOOL, args: { payload: tag } });
    assert.ok(
      !JSON.stringify(line.fields).includes('EAA'),
      `a ${tag} argument leaked its content into the log`,
    );
  }
});

test('the log line is written before the handler, so a rejected call still leaves a record', async () => {
  // `limit` must be a number: this call dies in the strict parse inside the
  // spec handler. A line emitted only on success would be missing for exactly
  // the calls worth diagnosing, so the record must exist anyway — carrying the
  // RAW argument, because validation has not run yet.
  const { result, records } = await callLogProbe(LOG_TOOL, { limit: 'not-a-number' });

  assert.equal(result.isError, true);
  assert.deepEqual(onlyCallLine(records).fields, {
    tool: LOG_TOOL,
    args: { limit: 'not-a-number' },
  });
});

test('the per-call log line lands on stderr, never on the stdout channel (CC-CFG-1)', async () => {
  // The other tests inject a recording logger, which proves what the bootstrap
  // hands over but not where it goes. This one runs the REAL logger with its
  // real default sink: on stdio, stdout is the JSON-RPC channel, so a log line
  // that reaches it corrupts the protocol.
  const marker = '1234567890-stdout-purity';
  const logger = createLogger({
    clock: createFakeClock(1_000),
    redactor: createFakeRedactor(),
    level: 'info',
  });
  const { deps } = makeHarness({
    settings: probeSettings(),
    packages: logProbePackages(),
    logger,
  });

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const realStdout = process.stdout.write.bind(process.stdout);
  const realStderr = process.stderr.write.bind(process.stderr);
  try {
    process.stdout.write = (chunk: unknown): boolean => {
      stdoutChunks.push(String(chunk));
      return true;
    };
    process.stderr.write = (chunk: unknown): boolean => {
      stderrChunks.push(String(chunk));
      return true;
    };
    const { client, close } = await connect(deps);
    try {
      await client.callTool({ name: LOG_TOOL, arguments: { page_id: marker } });
    } finally {
      await close();
    }
  } finally {
    process.stdout.write = realStdout;
    process.stderr.write = realStderr;
    // The capture window spans an await, so the runner's own output can land in
    // it; replay both streams rather than swallowing a failure report.
    for (const chunk of stdoutChunks) realStdout(chunk);
    for (const chunk of stderrChunks) realStderr(chunk);
  }

  assert.ok(
    stderrChunks.some((chunk) => chunk.includes(marker)),
    'the per-call line never reached stderr',
  );
  assert.ok(
    !stdoutChunks.some((chunk) => chunk.includes(marker)),
    'the per-call line corrupted the stdout JSON-RPC channel',
  );
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

test('metricProbe does not call a metric Graph never returned "accepted" when the other came back empty', async () => {
  const fb = createFakeFbRequest();
  // Graph answered page_follows with zero points and said nothing at all about
  // page_media_view: one accepted-but-empty metric, one absent entry.
  fb.on(
    (req) => req.path === '/1010/insights',
    fbOk({ data: [insightsEntry('page_follows', 0)] }),
  );

  const result = await metricProbe(probePages())(probeContext(fb).ctx);

  assert.equal(result.available, false);
  assert.equal(result.degraded, true);
  assert.deepEqual(result.details?.['empty'], ['page_follows']);
  assert.deepEqual(result.details?.['unavailable'], ['page_media_view']);
  // The summary is the line the operator reads; it must not claim Graph
  // accepted a name it never mentioned, and it must name that name.
  assert.doesNotMatch(result.summary, /accepted the metrics/);
  assert.match(result.summary, /no data for page_follows/);
  assert.match(result.summary, /no entry for page_media_view/);
  // The accepted-but-empty half still carries both indistinguishable causes.
  assert.match(result.summary, /eligibility floor/);
  assert.match(result.summary, /read_insights/);
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

test('the probes mark "configured but unhealthy" so the doctor can tell it from "not configured" (wave 9)', async () => {
  // A configured ad account Graph says cannot serve: the exact situation the
  // probe exists to surface (CC-ADS-6). It used to answer the same
  // `available: false` an UNCONFIGURED account does, so the doctor's verdict
  // could not tell them apart and printed it above "OK — nothing needs attention".
  const disabledFb = createFakeFbRequest();
  disabledFb.on(
    (req) => req.path === '/act_12345',
    fbOk({ id: 'act_12345', account_status: 2, disable_reason: 1 }),
  );
  const disabled = await adAccountProbe()(
    probeContext(disabledFb, { FB_AD_ACCOUNT_ID: 'act_12345' }).ctx,
  );
  assert.equal(disabled.available, false);
  assert.equal(disabled.degraded, true, 'a configured, non-serving account is degraded');

  // A Page that accepted the metric names and returned nothing: the operator
  // has something to do (floor, scope or task), so the doctor must say so.
  const emptyFb = createFakeFbRequest();
  emptyFb.on(
    (req) => req.path === '/1010/insights',
    fbOk({
      data: [insightsEntry('page_media_view', 0), insightsEntry('page_follows', 0)],
    }),
  );
  const empty = await metricProbe(probePages())(probeContext(emptyFb).ctx);
  assert.equal(empty.available, false);
  assert.equal(empty.degraded, true, 'an empty-insights Page is degraded');

  // Graph returned no entry at all: the pinned names are not valid for this
  // API version, so the probe cannot judge the Page. Not the operator's Page,
  // but still an install that cannot read insights as pinned — degraded too.
  const noEntryFb = createFakeFbRequest();
  noEntryFb.on((req) => req.path === '/1010/insights', fbOk({ data: [] }));
  const noEntry = await metricProbe(probePages())(probeContext(noEntryFb).ctx);
  assert.equal(noEntry.available, false);
  assert.equal(noEntry.degraded, true, 'unknown metric names are degraded');

  // Controls: nothing to check is NOT unhealthy, and a healthy answer carries
  // no flag either — `degraded` is absent, not `false`, in both.
  const unconfigured = await adAccountProbe()(probeContext(createFakeFbRequest()).ctx);
  assert.equal(unconfigured.available, false);
  assert.ok(
    !('degraded' in unconfigured),
    'an unconfigured ad account must carry no flag',
  );

  const servingFb = createFakeFbRequest();
  servingFb.on(
    (req) => req.path === '/act_12345',
    fbOk({ id: 'act_12345', account_status: 1, currency: 'EUR' }),
  );
  const serving = await adAccountProbe()(
    probeContext(servingFb, { FB_AD_ACCOUNT_ID: '12345' }).ctx,
  );
  assert.equal(serving.available, true);
  assert.ok(!('degraded' in serving), 'a serving account must carry no flag');

  const answeringFb = createFakeFbRequest();
  answeringFb.on(
    (req) => req.path === '/1010/insights',
    fbOk({ data: [insightsEntry('page_media_view', 2)] }),
  );
  const answering = await metricProbe(probePages())(probeContext(answeringFb).ctx);
  assert.equal(answering.available, true);
  assert.ok(!('degraded' in answering), 'an answering Page must carry no flag');
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

/**
 * The package array `main` assembles: everything the bootstrap can BUILD,
 * `ads` included — which the default profile leaves OFF. The two tests below
 * are precisely about the difference between "built" and "loaded".
 */
function bootstrapPackages(): readonly PackageSpec[] {
  return [
    createCorePackage({ serverVersion: '1.2.3-test', sdkVersion: '1.29.0-test' }),
    createReaderPackage(),
    createInsightsPackage(),
    createModerationPackage(),
    createMessagesPackage(),
    createPostsPackage(),
    createAdsPackage(),
  ];
}

/**
 * Exactly the permissions the six default-profile packages need, and nothing
 * else — the scope set a correctly provisioned out-of-box install has. No ads
 * permission appears: `ads` is not in the default profile, so no operator of a
 * default install has any reason to grant one.
 */
const DEFAULT_PROFILE_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_read_user_content',
  'pages_manage_posts',
  'pages_manage_engagement',
  'pages_messaging',
  'pages_manage_metadata',
  'read_insights',
] as const;

/** A path that cannot exist, so the credential-file check never stats a real file. */
const NO_CREDENTIAL_FILE = join(tmpdir(), 'facebook-mcp-index-absent', 'env');

/**
 * Drive the real `doctor` subcommand over the bootstrap's package array — the
 * FULL array, exactly as `main` hands it over — with a chosen scope set.
 *
 * Deliberately `runDoctorCommand` and not `runDoctor`: the narrowing under test
 * belongs to the command, and a helper that narrowed here would pass just as
 * happily with the command's own call deleted.
 */
async function doctorOverBootstrapPackages(
  scopes: readonly string[],
  args: readonly string[] = [],
  env: Record<string, string> = {},
): Promise<{
  readonly report: DoctorReport;
  readonly text: string;
  readonly exitCode: number;
}> {
  const fb = createFakeFbRequest();
  fb.on(
    (req) => req.path === '/debug_token',
    fbOk({
      data: {
        type: 'SYSTEM_USER',
        is_valid: true,
        scopes: [...scopes],
        granular_scopes: [{ scope: 'pages_show_list', target_ids: ['1010'] }],
        // What Graph really says for a System-User token. Without it the
        // fixture describes an answer that never states an expiry, and the
        // doctor (rightly) has something to say about that.
        expires_at: 0,
      },
    }),
  );
  const { settings, report: startup } = loadSettings({
    // An app secret belongs to a correctly provisioned install (the README
    // tells the operator to enable "Require App Secret"); without one the
    // startup report carries a warning, and the doctor has to say so too.
    env: { FB_SYSTEM_TOKEN: 'EAA-system-token', FB_APP_SECRET: 'app-secret', ...env },
    loadEnvFile: false,
  });
  return runDoctorCommand(
    {
      fbRequest: fb.fn,
      settings,
      clock: createFakeClock(1_760_000_000_000),
      logger: silentLogger,
      redactor: createFakeRedactor(),
      packages: bootstrapPackages(),
      serverVersion: '1.2.3-test',
      credentialFilePath: NO_CREDENTIAL_FILE,
    },
    args,
    startup,
  );
}

test('a correctly provisioned default install verdicts ok, --strict included', async () => {
  const { report, exitCode } = await doctorOverBootstrapPackages(DEFAULT_PROFILE_SCOPES, [
    '--strict',
  ]);

  // `ads` is off by default, so its scopes are not part of "correctly
  // provisioned" and its row must not exist to be judged.
  assert.equal(
    report.matrix.some((matrixRow) => matrixRow.package === 'ads'),
    false,
    'the doctor judged a package the registry never loads',
  );
  assert.deepEqual(
    report.summary.findings.map((finding) => finding.detail),
    [],
  );
  assert.equal(report.summary.verdict, 'ok');
  // The point of `--strict`: an out-of-box install must be able to pass it, or
  // the flag is one nobody can put in a pipeline.
  assert.equal(exitCode, 0);
});

test('the package narrowing follows the registry, and never costs a report', () => {
  const packages = bootstrapPackages();
  const named = (env: Record<string, string>): readonly string[] => {
    const { settings } = loadSettings({
      env: { FB_SYSTEM_TOKEN: 'EAA-system-token', ...env },
      loadEnvFile: false,
    });
    return loadedPackages(packages, settings).map((pkg) => pkg.name);
  };

  assert.deepEqual(named({ FB_TOOL_PACKAGES: 'ads' }), ['core', 'ads']);
  assert.deepEqual(named({ FB_PACKAGES_DENY: 'messages' }), [
    'core',
    'reader',
    'insights',
    'moderation',
    'posts',
  ]);

  // An unknown selection name is a startup error, but the doctor's whole value
  // is that it still prints for an operator whose config is broken — so the
  // narrowing falls back to the full array instead of propagating the throw.
  const { settings: broken } = loadSettings({
    env: { FB_SYSTEM_TOKEN: 'EAA-system-token', FB_TOOL_PACKAGES: 'reader,typo' },
    loadEnvFile: false,
  });
  assert.throws(() => createRegistry(packages, broken));
  assert.deepEqual(
    loadedPackages(packages, broken).map((pkg) => pkg.name),
    packages.map((pkg) => pkg.name),
  );
});

test('the "server started" line names the packages the registry loaded, not every package built', () => {
  const packages = bootstrapPackages();
  const { settings } = loadSettings({
    env: { FB_SYSTEM_TOKEN: 'EAA-system-token' },
    loadEnvFile: false,
  });

  const fields = serverStartedFields('stdio', '1.2.3', packages, settings);

  // `ads` is built on every start but off by default: logging it as started
  // tells the operator the ads tools are there when tools/list has none.
  assert.deepEqual(fields['packages'], [
    'core',
    'reader',
    'insights',
    'moderation',
    'messages',
    'posts',
  ]);
  assert.equal(fields['transport'], 'stdio');
  assert.equal(fields['version'], '1.2.3');

  const { settings: adsOnly } = loadSettings({
    env: { FB_SYSTEM_TOKEN: 'EAA-system-token', FB_TOOL_PACKAGES: 'ads' },
    loadEnvFile: false,
  });
  assert.deepEqual(serverStartedFields('stdio', '1.2.3', packages, adsOnly)['packages'], [
    'core',
    'ads',
  ]);
});

test('the doctor names an unresolvable package selection instead of judging the full array', async () => {
  // The narrowing above falls back to every package so the report still prints.
  // That is right, and on its own it is also a lie: the operator gets a matrix
  // over seven packages for an install that starts none of them. The command
  // asks separately why the selection failed and folds the answer into the
  // verdict, so `doctor --strict` in a pipeline goes red for a config that
  // cannot boot.
  const { report, text, exitCode } = await doctorOverBootstrapPackages(
    [...DEFAULT_PROFILE_SCOPES],
    ['--strict'],
    { FB_PACKAGES_DENY: 'reeder' },
  );

  assert.equal(report.summary.verdict, 'fail');
  assert.equal(exitCode, 2);
  const finding = report.summary.findings.find((f) => f.area === 'configuration');
  assert.ok(finding, 'expected a configuration finding');
  // Which variable — the deny list, not the allow list that is perfectly fine.
  assert.match(finding.detail, /FB_PACKAGES_DENY/);
  assert.match(finding.detail, /"reeder"/);
  assert.match(text, /WILL NOT START/);
});

test('a resolvable selection leaves the doctor with nothing to say about configuration', async () => {
  const { report, text } = await doctorOverBootstrapPackages(
    [...DEFAULT_PROFILE_SCOPES],
    [],
    {
      FB_PACKAGES_DENY: 'messages',
    },
  );

  assert.equal(
    report.summary.findings.some((f) => f.area === 'configuration'),
    false,
  );
  assert.doesNotMatch(text, /WILL NOT START/);
});

test('a configuration the server refuses to start on fails the doctor, --strict included (wave 9)', async () => {
  // `loadSettings` is the bootstrap's own judgement of the configuration, and
  // `assertStartupOk` refuses to start the server on any error in it. The
  // doctor runs BEFORE that assertion (so it can still report on a broken
  // install) — which meant the startup report was computed and then thrown
  // away on the doctor path, and `doctor --strict` exited 0 for a server that
  // would not start. FB_TRANSPORT=http without FB_HTTP_TOKEN is such an error.
  const { report, text, exitCode } = await doctorOverBootstrapPackages(
    [...DEFAULT_PROFILE_SCOPES],
    ['--strict'],
    { FB_TRANSPORT: 'http' },
  );

  const finding = report.summary.findings.find((f) => f.area === 'configuration');
  assert.ok(finding, 'expected a configuration finding for the startup error');
  assert.equal(finding.severity, 'fail');
  assert.match(finding.detail, /FB_HTTP_TOKEN/);
  assert.equal(report.summary.verdict, 'fail');
  assert.equal(exitCode, 2);
  assert.match(text, /WILL NOT START/);
  assert.match(text, /\[FAIL {3}\] configuration: .*FB_HTTP_TOKEN/);

  // A warning-severity startup problem the doctor does not judge on its own
  // (no app secret) is a warning here as well: on a real start the server
  // logs it, and the doctor is the one path where it was said nowhere.
  const warned = await doctorOverBootstrapPackages(
    [...DEFAULT_PROFILE_SCOPES],
    ['--strict'],
    {
      FB_APP_SECRET: '',
    },
  );
  const warning = warned.report.summary.findings.find((f) => f.area === 'configuration');
  assert.ok(warning, 'expected a configuration finding for the startup warning');
  assert.equal(warning.severity, 'warn');
  assert.match(warning.detail, /FB_APP_SECRET/);
  assert.equal(warned.report.summary.verdict, 'warn');
  assert.equal(warned.exitCode, 1);
});

test('an ads scope on a default install is over-scope', async () => {
  const { report } = await doctorOverBootstrapPackages([
    ...DEFAULT_PROFILE_SCOPES,
    'ads_management',
  ]);

  // The over-scope check exists to catch a runtime token carrying a privilege
  // nothing loaded can use. `ads_management` on an install whose `ads` package
  // is off is exactly that, and it stays exactly that until the operator turns
  // the package on.
  assert.deepEqual(report.overScopePermissions, ['ads_management']);
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

// --- Startup config warnings reach the operator ------------------------------

test('a successful start logs every startup config warning, one WARN each', () => {
  // `assertStartupOk` only throws on errors, and the warnings live inside that
  // thrown text — so on a clean start (the common case) an operator whose
  // FB_PAGE_TOKEN is bound to no Page, or whose FB_APP_SECRET is unset, saw
  // nothing at all. The bootstrap must hand the warnings to the logger.
  const { settings, report } = loadSettings({
    env: { FB_PAGE_TOKEN: 'fake-page-token' },
    loadEnvFile: false,
  });
  assert.ok(report.ok, 'a Page token alone is a valid (if warned) configuration');
  assert.ok(report.warnings.length >= 2, 'the fixture must carry several warnings');
  assert.equal(settings.defaultPageId, undefined);

  const { logger, records } = recordingLogger();
  logStartupWarnings(logger, report);

  const warned = records.filter((r) => r.level === 'warn');
  assert.equal(warned.length, report.warnings.length, 'one WARN per warning, no more');
  assert.ok(
    records.every((r) => r.level === 'warn'),
    'warnings never escalate to error nor demote to info',
  );
  for (const problem of report.warnings) {
    const record = warned.find((r) => r.fields?.['code'] === problem.code);
    assert.ok(record, `warning ${problem.code} must be logged`);
    assert.equal(record.msg, 'startup config warning');
    assert.equal(record.fields?.['message'], problem.message);
    if (problem.field !== undefined)
      assert.equal(record.fields?.['field'], problem.field);
  }
  // The unbound-Page-token diagnostic specifically must be among them.
  assert.ok(warned.some((r) => r.fields?.['code'] === 'page-token-unbound'));
});

test('regression: a warning-free start logs nothing at startup-warning level', () => {
  const { report } = loadSettings({
    env: { FB_SYSTEM_TOKEN: 'fake-system-token', FB_APP_SECRET: 's', FB_PAGE_ID: '100' },
    loadEnvFile: false,
  });
  assert.deepEqual(report.warnings, []);
  const { logger, records } = recordingLogger();
  logStartupWarnings(logger, report);
  assert.deepEqual(records, []);
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

test('isStrictFlag reads only the doctor argument list, and only the long form', () => {
  assert.equal(isStrictFlag(['--strict']), true);
  // The flag may sit anywhere after the subcommand.
  assert.equal(isStrictFlag(['--json', '--strict']), true);
  // A near-miss must NOT gate: silently exiting non-zero on a typo is worse than
  // ignoring a flag the operator can see was ignored in the report.
  for (const args of [[], ['strict'], ['-s'], ['--Strict'], ['--strict=true']]) {
    assert.equal(isStrictFlag(args), false, `${JSON.stringify(args)} must not gate`);
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

// ---------------------------------------------------------------------------
// CLI argument handling (wave 15)
// ---------------------------------------------------------------------------

test('doctor names an argument it ignored instead of dropping it silently', async () => {
  // `--stric` is the typo a CI script acquires; the doctor must not gate on it
  // (see isStrictFlag), but the operator has to be able to SEE that it was
  // ignored, or a pipeline that meant to gate reads exit 0 as a pass.
  const { text, exitCode } = await doctorOverBootstrapPackages(DEFAULT_PROFILE_SCOPES, [
    '--stric',
  ]);
  assert.match(text, /Ignored unknown doctor argument "--stric"/);
  assert.match(text, /--strict/);
  assert.equal(exitCode, 0, 'a near-miss still never gates');
});

test('doctor never echoes the value of an ignored argument', async () => {
  const pasted = 'EAAB-pasted-into-argv-must-not-echo';
  const { text } = await doctorOverBootstrapPackages(DEFAULT_PROFILE_SCOPES, [
    `--token=${pasted}`,
    pasted,
  ]);
  assert.match(text, /"--token=\u2026"/);
  assert.match(text, /positional argument/);
  assert.equal(
    text.includes(pasted),
    false,
    'an ignored argument value reached the report',
  );
});

test('regression: a clean doctor argument list adds no ignored-argument line', async () => {
  const { text } = await doctorOverBootstrapPackages(DEFAULT_PROFILE_SCOPES, [
    '--strict',
  ]);
  assert.equal(/Ignored unknown doctor argument/.test(text), false);
});

test('--help prints usage and exits 0 without loading settings or starting a server', () => {
  // The only test here that runs the real entry point: `--help` is decided in
  // `main()`, before anything injectable exists. The child gets no FB_* env and
  // a cwd with no `.env`, so a build that ignores `--help` fails fast on the
  // missing token instead of waiting on stdin as a stdio server.
  const cwd = mkdtempSync(join(tmpdir(), 'facebook-mcp-help-'));
  try {
    for (const flag of ['--help', '-h']) {
      const child = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./index.js', import.meta.url)), flag],
        {
          cwd,
          env: { PATH: process.env['PATH'] ?? '', HOME: cwd, USERPROFILE: cwd },
          input: '',
          encoding: 'utf8',
          timeout: 15_000,
        },
      );
      assert.equal(
        child.status,
        0,
        `${flag}: exit ${String(child.status)}; stderr: ${child.stderr}`,
      );
      assert.match(child.stdout, /^Usage: facebook-mcp/m, `${flag}: no usage on stdout`);
      for (const word of ['doctor', '--strict', 'setup-token', '--version']) {
        assert.ok(child.stdout.includes(word), `${flag}: usage does not mention ${word}`);
      }
      assert.equal(child.stderr, '', `${flag}: unexpected stderr: ${child.stderr}`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Wave 16 (lane A): the error hub evicts a dead Page token, names the full
// usage bucket, and bounds Meta's own refusal text
// ---------------------------------------------------------------------------

/** The Page the dead-token tests resolve, and the base token that derives it. */
const HUB_PAGE_ID = '424242';

/** Settings with a default Page, so `resolvePage()` derives through the registry. */
function hubSettings(): Settings {
  const { settings } = loadSettings({
    env: {
      FB_ACCESS_TOKEN: ACCESS_TOKEN,
      FB_PAGE_ID: HUB_PAGE_ID,
      FB_TOOL_PACKAGES: 'ads',
    },
    loadEnvFile: false,
  });
  return settings;
}

/**
 * A package whose one tool reads the default Page's feed with the token the
 * registry resolves — the shape of every Page-scoped read in the real packages.
 */
function pageReadPackage(wrap?: (err: unknown) => unknown): PackageSpec {
  const read = defineTool({
    name: 'facebook_probe_page_read',
    description: 'Test-only: read the default Page feed with its resolved token.',
    inputSchema: z.object({}),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async (_input, ctx) => {
      const page = await ctx.pages.resolvePage(ctx.profile);
      try {
        const res = await ctx.fbRequest({
          protocol: 'json',
          host: 'graph',
          method: 'GET',
          path: `/${page.pageId}/feed`,
          token: page.token,
        });
        return textResult({ data: res.data });
      } catch (err) {
        throw wrap !== undefined ? wrap(err) : err;
      }
    },
  });
  return {
    name: 'ads',
    title: 'Probe',
    description: 'Test-only package injected through the packages seam.',
    tools: [read],
    enabledByDefault: false,
  };
}

/** Is `req` the registry's `/PAGE_ID?fields=access_token` derivation? */
function isDerivation(req: {
  readonly path: string;
  readonly params?: unknown;
}): boolean {
  const params = req.params as Record<string, unknown> | undefined;
  return req.path === `/${HUB_PAGE_ID}` && params?.['fields'] === 'access_token';
}

/**
 * Two calls of the page-read probe against a REAL pages registry whose feed read
 * fails with `feedError` every time. Returns how many times the registry derived
 * the Page token, and the second call's error record.
 */
async function twoPageReads(
  feedError: GraphApiError,
  wrap?: (err: unknown) => unknown,
): Promise<{ derivations: number; second: Record<string, unknown> }> {
  const settings = hubSettings();
  const clock = createFakeClock(1_000);
  const redactor = createFakeRedactor({ secrets: [ACCESS_TOKEN] });
  const fb = createFakeFbRequest();
  fb.on(isDerivation, fbOk({ access_token: 'derived-page-token-1', id: HUB_PAGE_ID }), 1);
  fb.on(isDerivation, fbOk({ access_token: 'derived-page-token-2', id: HUB_PAGE_ID }));
  fb.on((req) => req.path === `/${HUB_PAGE_ID}/feed`, fbErr(feedError));
  const pages = createPagesRegistry({ settings, fbRequest: fb.fn, clock, redactor });

  const { client, close } = await connect({
    settings,
    packages: [
      createCorePackage({ serverVersion: '1.2.3-test', sdkVersion: '1.29.0-test' }),
      pageReadPackage(wrap),
    ],
    serverVersion: '1.2.3-test',
    clock,
    logger: silentLogger,
    redactor,
    journal: createMemoryJournal(clock),
    fbRequest: fb.fn,
    pages,
  });
  try {
    const first = (await client.callTool({
      name: 'facebook_probe_page_read',
      arguments: {},
    })) as CallToolResult;
    assert.equal(first.isError, true);
    const second = (await client.callTool({
      name: 'facebook_probe_page_read',
      arguments: {},
    })) as CallToolResult;
    assert.equal(second.isError, true);
    return {
      derivations: fb.calls.filter(isDerivation).length,
      second: parseResult(second),
    };
  } finally {
    await close();
  }
}

test('a Page token Graph refuses with 190 is evicted, so the next call re-derives', async () => {
  const { derivations, second } = await twoPageReads(
    new GraphApiError('(#190) Error validating access token', {
      code: 190,
      subcode: 460,
      type: 'OAuthException',
      httpStatus: 400,
    }),
  );
  // Without the eviction the second call is served the SAME dead token from the
  // registry cache (15-minute TTL) and fails identically without asking Graph.
  assert.equal(derivations, 2, 'the second call must re-derive the Page token');
  assert.equal(second['code'], 190);
});

test('a Page token refused as an expired session (102) is evicted too', async () => {
  const { derivations } = await twoPageReads(
    new GraphApiError('(#102) Session has expired', {
      code: 102,
      type: 'OAuthException',
      httpStatus: 400,
    }),
  );
  assert.equal(derivations, 2, 'a 102 on the Page token must drop the cached token');
});

test('a stale Page object (100 / subcode 21) evicts the cached Page token too', async () => {
  const { derivations } = await twoPageReads(
    new GraphApiError('(#21) Page ID was migrated to page ID 999', {
      code: 100,
      subcode: 21,
      type: 'OAuthException',
      httpStatus: 400,
    }),
  );
  assert.equal(derivations, 2, 'a stale Page object must drop the cached derivation');
});

test('a tool that re-words a 190 keeping it as cause still evicts the Page token', async () => {
  // A tool layer that rebuilds a Graph refusal into its own error (a carousel or
  // multi-photo wrapper, a reclassified send) keeps the original as `cause`. The
  // hub must read the refusal down that chain, the way core/auth's
  // isPageTokenDead is applied everywhere else, or the dead token stays cached.
  const { derivations } = await twoPageReads(
    new GraphApiError('(#190) Error validating access token', {
      code: 190,
      subcode: 463,
      type: 'OAuthException',
      httpStatus: 400,
    }),
    (err) => new Error('the probe failed while reading the feed', { cause: err }),
  );
  assert.equal(derivations, 2, 'a 190 behind a wrapper must drop the cached token');
});

test('regression: an error that says nothing about the token keeps the cached Page token', async () => {
  const { derivations } = await twoPageReads(
    new GraphApiError('(#200) Permissions error', {
      code: 200,
      type: 'OAuthException',
      httpStatus: 403,
    }),
  );
  assert.equal(derivations, 1, 'a permission refusal must not cost a re-derivation');
});

test('regression: an ads-style 100/33 on a call that resolved no Page keeps the cached Page token', async () => {
  // The ads tools read and write ad objects with the user token and never
  // resolve a Page, yet a missing ad object answers with the same 100/33 shape
  // as a stale Page object. The hub evicts only Pages the failing call itself
  // resolved, so an ads miss must not cost the next Page read a re-derivation.
  const settings = hubSettings();
  const clock = createFakeClock(1_000);
  const redactor = createFakeRedactor({ secrets: [ACCESS_TOKEN] });
  const fb = createFakeFbRequest();
  fb.on(isDerivation, fbOk({ access_token: 'derived-page-token-1', id: HUB_PAGE_ID }), 1);
  fb.on(isDerivation, fbOk({ access_token: 'derived-page-token-2', id: HUB_PAGE_ID }));
  fb.on((req) => req.path === `/${HUB_PAGE_ID}/feed`, fbOk({ data: [] }));
  fb.on(
    (req) => req.path === '/120000000000001',
    fbErr(
      new GraphApiError('(#100) Object with ID does not exist', {
        code: 100,
        subcode: 33,
        type: 'GraphMethodException',
        httpStatus: 400,
      }),
    ),
  );
  const pages = createPagesRegistry({ settings, fbRequest: fb.fn, clock, redactor });
  const adRead = defineTool({
    name: 'facebook_probe_ad_read',
    description: 'Test-only: read an ad object with the user token, resolving no Page.',
    inputSchema: z.object({}),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: async (_input, ctx) => {
      const res = await ctx.fbRequest({
        protocol: 'json',
        host: 'graph',
        method: 'GET',
        path: '/120000000000001',
      });
      return textResult({ data: res.data });
    },
  });
  const probe = pageReadPackage();
  const { client, close } = await connect({
    settings,
    packages: [
      createCorePackage({ serverVersion: '1.2.3-test', sdkVersion: '1.29.0-test' }),
      { ...probe, tools: [...probe.tools, adRead] },
    ],
    serverVersion: '1.2.3-test',
    clock,
    logger: silentLogger,
    redactor,
    journal: createMemoryJournal(clock),
    fbRequest: fb.fn,
    pages,
  });
  try {
    const first = (await client.callTool({
      name: 'facebook_probe_page_read',
      arguments: {},
    })) as CallToolResult;
    assert.notEqual(first.isError, true);
    const miss = (await client.callTool({
      name: 'facebook_probe_ad_read',
      arguments: {},
    })) as CallToolResult;
    assert.equal(miss.isError, true);
    assert.equal(parseResult(miss)['code'], 100);
    const second = (await client.callTool({
      name: 'facebook_probe_page_read',
      arguments: {},
    })) as CallToolResult;
    assert.notEqual(second.isError, true);
    assert.equal(
      fb.calls.filter(isDerivation).length,
      1,
      'an ads miss must not evict the Page token another call derived',
    );
  } finally {
    await close();
  }
});

test('a Graph refusal carrying usage headers names the full bucket in the error record', async () => {
  // Build the error the way production does: through the real HTTP client, on
  // a throttle response that carries Meta's usage headers.
  const settings = probeSettings();
  const refused = await withFetch(async (mock: FetchMock) => {
    mock.on(() => true, {
      status: 400,
      json: {
        error: {
          message: '(#4) Application request limit reached',
          type: 'OAuthException',
          code: 4,
        },
      },
      headers: {
        'x-app-usage': '{"call_count":100,"total_cputime":40,"total_time":35}',
        'x-business-use-case-usage':
          '{"1234":[{"type":"pages","call_count":12,"total_cputime":5,"total_time":5,"estimated_time_to_regain_access":0}]}',
      },
    });
    const fbRequest = createFbRequest({
      settings,
      clock: createFakeClock(1_000),
      redactor: createFakeRedactor(),
      logger: silentLogger,
      retry: { maxRetries: 0 },
    });
    return fbRequest({
      protocol: 'json',
      host: 'graph',
      method: 'GET',
      path: '/me',
    }).then(
      () => assert.fail('expected the throttle to reject'),
      (err: unknown) => err,
    );
  });
  assert.ok(refused instanceof GraphApiError);

  const thrower = defineTool({
    name: 'facebook_probe_throttled',
    description: 'Test-only: rethrow a real throttle refusal.',
    inputSchema: z.object({}),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: () => Promise.reject(refused),
  });
  const { deps } = makeHarness({
    settings,
    packages: [
      createCorePackage({ serverVersion: '1.2.3-test', sdkVersion: '1.29.0-test' }),
      {
        name: 'ads',
        title: 'Probe',
        description: 'Test-only package injected through the packages seam.',
        tools: [thrower],
        enabledByDefault: false,
      },
    ],
  });
  const { client, close } = await connect(deps);
  try {
    const record = parseResult(
      (await client.callTool({
        name: 'facebook_probe_throttled',
        arguments: {},
      })) as CallToolResult,
    );
    assert.equal(record['category'], 'rate_limit');
    assert.equal(record['nextTool'], 'facebook_usage');
    // facebook_usage probes `/me`, not the refused call, so only the refusing
    // response names the bucket that refused it.
    assert.deepEqual(record['usage'], { appUsagePct: 100, businessUseCasePct: 12 });
  } finally {
    await close();
  }
});

test('regression: a Graph error with no usage headers carries no usage field', async () => {
  const record = parseResult(
    await callProbeServer('facebook_probe_fail', { kind: 'graph-throttled' }),
  );
  assert.ok(!('usage' in record), 'usage must be absent, not invented');
});

test("Meta's own refusal text is length-bounded in the error record", async () => {
  const huge = 'x'.repeat(10_000);
  const thrower = defineTool({
    name: 'facebook_probe_verbose',
    description: 'Test-only: throw a Graph error with a pathological user message.',
    inputSchema: z.object({}),
    annotations: READ_ONLY_ANNOTATIONS,
    handler: () =>
      Promise.reject(
        new GraphApiError('Graph API error (HTTP 400): Invalid parameter', {
          code: 100,
          httpStatus: 400,
          userTitle: huge,
          userMessage: huge,
          action: {
            category: 'validation',
            retryable: false,
            operatorText: 'Fix the request, then retry.',
          },
        }),
      ),
  });
  const { deps } = makeHarness({
    settings: probeSettings(),
    packages: [
      createCorePackage({ serverVersion: '1.2.3-test', sdkVersion: '1.29.0-test' }),
      {
        name: 'ads',
        title: 'Probe',
        description: 'Test-only package injected through the packages seam.',
        tools: [thrower],
        enabledByDefault: false,
      },
    ],
  });
  const { client, close } = await connect(deps);
  try {
    const record = parseResult(
      (await client.callTool({
        name: 'facebook_probe_verbose',
        arguments: {},
      })) as CallToolResult,
    );
    assert.ok(
      String(record['userMessage']).length <= META_ERROR_TEXT_MAX,
      `userMessage is ${String(String(record['userMessage']).length)} chars`,
    );
    assert.ok(String(record['userTitle']).length <= META_ERROR_TEXT_MAX);
    // The decision fields still ride along beside the bounded text.
    assert.equal(record['retryable'], false);
    assert.equal(record['category'], 'validation');
  } finally {
    await close();
  }
});

test('the production transport sends a multipart upload instead of refusing it', async () => {
  // main() builds its Graph client through createTransport. A local-file photo,
  // a video chunk and a reel all use a non-JSON protocol, so without the upload
  // handler wired in every one of them rejected before reaching the network.
  const res = await withFetch(async (mock: FetchMock) => {
    mock.enqueue({ json: { id: 'photo_1' } });
    const fbRequest = createTransport({
      settings: probeSettings(),
      clock: createFakeClock(1_000),
      redactor: createFakeRedactor(),
      logger: silentLogger,
    });
    const out = await fbRequest<{ id: string }>({
      protocol: 'multipart',
      host: 'graph',
      method: 'POST',
      path: '/me/photos',
      fields: { published: 'false' },
      files: [
        {
          name: 'source',
          data: new Uint8Array([0xff, 0xd8, 0xff]),
          filename: 'pic.jpg',
          contentType: 'image/jpeg',
        },
      ],
    });
    assert.equal(mock.lastRequest()?.body.kind, 'formData');
    return out;
  });
  assert.deepEqual(res.data, { id: 'photo_1' });
});
