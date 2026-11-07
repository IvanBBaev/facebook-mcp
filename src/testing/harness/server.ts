// Shared fixtures, fakes and helpers for the server bootstrap tests, split out of
// `index.test.ts` (R17). The test files import from here.
//
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

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
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
import {
  GraphApiError,
  classifyGraphError,
  loadSettings,
  type LogFields,
  type LogLevel,
  type Logger,
  type PackageSpec,
  type Redactor,
  type Settings,
  type ToolContext,
  type ToolResult,
} from '../../core/index.js';
import { defineTool, WriteGateError, type DoctorReport } from '../../mcp/index.js';
import {
  createAdsPackage,
  createCorePackage,
  createInsightsPackage,
  createMessagesPackage,
  createModerationPackage,
  createPostsPackage,
  createReaderPackage,
} from '../../tools/index.js';
import { buildServer, runDoctorCommand, type BuildServerDeps } from '../../index.js';

/** A raw Page access token that must NEVER survive into a tool result. */
export const SECRET_PAGE_TOKEN = 'EAA-PAGE-TOKEN-must-never-leak-9f8e7d6c5b4a';

/** The configured user token every harness here resolves its settings from. */
export const ACCESS_TOKEN = 'test-access-token-abc123';

/** Diagnostics are irrelevant to these assertions; stderr stays quiet. */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

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
export function testSettings(): Settings {
  const { settings } = loadSettings({
    env: {
      FB_ACCESS_TOKEN: ACCESS_TOKEN,
      FB_PACKAGES_DENY: 'posts,reader,insights,moderation,messages',
    },
    loadEnvFile: false,
  });
  return settings;
}

export interface Harness {
  readonly deps: BuildServerDeps;
  readonly packages: readonly PackageSpec[];
  readonly settings: Settings;
  readonly fb: FakeFbRequest;
  readonly journal: MemoryJournal;
}

/** What a test may swap out of the default (core-only, default-settings) wiring. */
export interface HarnessOverrides {
  readonly settings?: Settings;
  readonly packages?: readonly PackageSpec[];
  /** Swapped in by the log-line tests, which are ABOUT what the bootstrap logs. */
  readonly logger?: Logger;
  /** Swapped in when a test needs the real redactor rather than the value fake. */
  readonly redactor?: Redactor;
}

/** Assemble {@link buildServer} dependencies from in-memory fakes. */
export function makeHarness(overrides: HarnessOverrides = {}): Harness {
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
export async function connect(
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
export function firstText(result: CallToolResult): string {
  const block = result.content[0];
  assert.ok(block, 'expected at least one content block');
  assert.equal(block.type, 'text');
  return block.type === 'text' ? block.text : '';
}

/** Parse the JSON object a tool result carries in its first text block. */
export function parseResult(result: CallToolResult): Record<string, unknown> {
  return JSON.parse(firstText(result)) as Record<string, unknown>;
}

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
export function textResult(payload: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/** The read-only annotation quadruple both probe tools carry. */
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Error classes {@link probePackage}'s failing tool can raise on demand. */
export const FAILURE_KINDS = [
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
export function probePackage(): PackageSpec {
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
export function probeSettings(): Settings {
  const { settings } = loadSettings({
    env: { FB_ACCESS_TOKEN: ACCESS_TOKEN, FB_TOOL_PACKAGES: 'ads' },
    loadEnvFile: false,
  });
  return settings;
}

/** The injected package array for a probe-backed server. */
export function probePackages(): readonly PackageSpec[] {
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
export async function callProbeServer(
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

/** One captured log call, in the shape the bootstrap handed to the logger. */
export interface LogRecord {
  readonly level: LogLevel;
  readonly msg: string;
  readonly fields: LogFields | undefined;
}

/** A {@link Logger} that records instead of writing, so the fields stay inspectable. */
export function recordingLogger(): {
  readonly logger: Logger;
  readonly records: LogRecord[];
} {
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

/** A resolver whose default Page is the one the probes are expected to query. */
export function probePages(): ReturnType<typeof createFakePageResolver> {
  return createFakePageResolver({
    default: { pageId: '1010', name: 'Brand A', token: SECRET_PAGE_TOKEN },
  });
}

/**
 * The package array `main` assembles: everything the bootstrap can BUILD,
 * `ads` included — which the default profile leaves OFF. The two tests below
 * are precisely about the difference between "built" and "loaded".
 */
export function bootstrapPackages(): readonly PackageSpec[] {
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
export const DEFAULT_PROFILE_SCOPES = [
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
export const NO_CREDENTIAL_FILE = join(tmpdir(), 'facebook-mcp-index-absent', 'env');

/**
 * Drive the real `doctor` subcommand over the bootstrap's package array — the
 * FULL array, exactly as `main` hands it over — with a chosen scope set.
 *
 * Deliberately `runDoctorCommand` and not `runDoctor`: the narrowing under test
 * belongs to the command, and a helper that narrowed here would pass just as
 * happily with the command's own call deleted.
 */
export async function doctorOverBootstrapPackages(
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
