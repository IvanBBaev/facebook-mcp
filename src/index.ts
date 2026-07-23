// Server bootstrap (task I1) — the integration seam that ties the
// `core <- api <- mcp <- tools` stack into one runnable MCP server.
//
// Two entry points, kept apart so the wiring is unit-testable without a process:
//
//   * `buildServer(deps)` — a pure, dependency-injected builder. It resolves the
//     active tool set via the registry, registers a `tools/list` + `tools/call`
//     handler pair on a low-level MCP `Server`, assembles a per-call
//     `ToolContext` (plus the write-gate + confirmer seam), invokes the matching
//     tool handler and maps any thrown error to an error `ToolResult` through the
//     redaction choke-point. It never reads env, never touches process streams,
//     never opens a transport — a test drives it over an in-memory transport.
//
//   * `main()` — the real bootstrap. It resolves `Settings` from the environment,
//     constructs the concrete `core` collaborators, assembles the package array
//     (Wave-4 verticals slot in at the marked insertion point), then either runs
//     the `doctor` subcommand (diagnostics to STDERR, never stdout) or starts the
//     selected transport with SIGINT/SIGTERM graceful shutdown. It runs only when
//     this module is the process entry point.
//
// stdout is reserved for the stdio JSON-RPC channel (CC-CFG-1): every diagnostic
// here goes to stderr (the injected Logger) or, for the doctor report, to
// `process.stderr` explicitly. No secret ever leaves un-redacted — the redactor
// is the single value-based choke-point (C3). No AsyncLocalStorage: every
// capability a handler may touch arrives through the explicit `ToolContext` (C14).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import {
  assertStartupOk,
  createFbRequest,
  createLogger,
  createPagesRegistry,
  createRedactor,
  GraphApiError,
  loadSettings,
  type Clock,
  type Confirmer,
  type FbRequestFn,
  type Journal,
  type Logger,
  type PackageSpec,
  type PageResolver,
  type Redactor,
  type Settings,
  type ToolContext,
  type ToolResult,
  type ToolSpec,
} from './core/index.js';
import {
  createConfirmer,
  createJournal,
  createRegistry,
  createWriteGate,
  renderDoctorReport,
  runDoctor,
  shapeResult,
  startTransport,
  WriteGateError,
  type ConnectableServer,
  type WriteGate,
} from './mcp/index.js';
import { createCorePackage } from './tools/index.js';

/** Advertised MCP server name (matches the whoami / doctor envelopes). */
const SERVER_NAME = 'facebook-mcp';

/** Fallback version used when `package.json` cannot be read at runtime. */
const FALLBACK_VERSION = '0.0.0';

// ---------------------------------------------------------------------------
// buildServer — the testable, dependency-injected wiring
// ---------------------------------------------------------------------------

/**
 * Everything {@link buildServer} needs, injected explicitly (C14 — no globals,
 * no ambient context). `main()` builds the production instances; tests pass in
 * in-memory fakes.
 */
export interface BuildServerDeps {
  readonly settings: Settings;
  /** The available tool packages (core + any Wave-4 verticals); the registry selects. */
  readonly packages: readonly PackageSpec[];
  /** Resolved at runtime from `package.json` (never imported as a module). */
  readonly serverVersion: string;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly redactor: Redactor;
  readonly journal: Journal;
  readonly fbRequest: FbRequestFn;
  readonly pages: PageResolver;
  /**
   * Out-of-band confirmation seam (B1). Defaults to a settings-backed
   * operator-token confirmer (no elicitation until the live MCP session wires
   * one). Injectable so tests can supply an approving/denying fake.
   */
  readonly confirmer?: Confirmer;
}

/**
 * The per-call capability bundle. It is a structural SUPERSET of the frozen
 * {@link ToolContext} — `types.ts` is frozen and cannot gain `writeGate` /
 * `confirmer` fields at this task, so they are attached here and reach a handler
 * that opts in by widening its own `ctx` type. Read-only tools (all of `core`)
 * ignore them; Wave-4 write handlers consume them once `ToolContext` gains the
 * additive fields (see the FREEZE NOTE on `ToolContext`).
 */
interface ToolCallContext extends ToolContext {
  readonly writeGate: WriteGate;
  readonly confirmer: Confirmer;
}

/**
 * Build a connectable MCP server from injected dependencies. Pure: no env, no
 * process streams, no transport. Registers the resolved tools and returns the
 * server so the caller (main / a test) chooses the transport.
 */
export function buildServer(deps: BuildServerDeps): ConnectableServer {
  const { settings, redactor } = deps;
  const registry = createRegistry(deps.packages, settings);
  const confirmer = deps.confirmer ?? createConfirmer({ settings });
  const writeGate = createWriteGate({
    clock: deps.clock,
    journal: deps.journal,
    defaultWriteMode: settings.writeMode,
    confirmer,
  });

  const server = new Server(
    { name: SERVER_NAME, version: deps.serverVersion },
    { capabilities: { tools: {} } },
  );

  // tools/list — advertise every resolved spec (schemas converted lazily here).
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: registry.tools.map(toMcpTool),
  }));

  // tools/call — resolve the spec, assemble the context, invoke, map errors.
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const spec = registry.get(request.params.name);
    const args = request.params.arguments ?? {};
    if (spec === undefined) {
      // A tool the registry never advertised — return a well-formed, redacted
      // error result rather than throwing a raw protocol error.
      return toCallToolResult(
        shapeResult(
          { error: `unknown tool: ${request.params.name}` },
          { maxResultChars: settings.maxResultChars, redactor, isError: true },
        ),
      );
    }

    const profile = extractProfile(args);
    const ctx: ToolCallContext = {
      settings,
      fbRequest: deps.fbRequest,
      pages: deps.pages,
      logger: deps.logger,
      redactor,
      clock: deps.clock,
      journal: deps.journal,
      signal: extra.signal,
      ...(profile !== undefined ? { profile } : {}),
      writeGate,
      confirmer,
    };

    try {
      const result = await spec.handler(args, ctx);
      return toCallToolResult(result);
    } catch (err) {
      return toCallToolResult(
        shapeResult(buildErrorRecord(err), {
          maxResultChars: settings.maxResultChars,
          redactor,
          isError: true,
        }),
      );
    }
  });

  return server;
}

/** Convert a frozen {@link ToolSpec} into the SDK's `tools/list` `Tool` shape. */
function toMcpTool(spec: ToolSpec): Tool {
  const inputSchema = toJsonSchemaCompat(spec.inputSchema, {
    strictUnions: true,
    pipeStrategy: 'input',
  }) as Tool['inputSchema'];
  return {
    name: spec.name,
    ...(spec.title !== undefined ? { title: spec.title } : {}),
    description: spec.description,
    inputSchema,
    ...(spec.outputSchema !== undefined
      ? {
          outputSchema: toJsonSchemaCompat(spec.outputSchema, {
            strictUnions: true,
            pipeStrategy: 'output',
          }) as Tool['outputSchema'],
        }
      : {}),
    annotations: spec.annotations,
  };
}

/**
 * Project a lean {@link ToolResult} onto the SDK's `CallToolResult`. `content` is
 * copied into a FRESH mutable array (the frozen result's array is `readonly`);
 * `structuredContent` / `isError` ride along only when present.
 */
function toCallToolResult(result: ToolResult): CallToolResult {
  return {
    content: result.content.map((block) => ({ type: 'text' as const, text: block.text })),
    ...(result.structuredContent !== undefined
      ? { structuredContent: result.structuredContent }
      : {}),
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
  };
}

/**
 * Turn a thrown error into a redactable record for the error `ToolResult`.
 * `WriteGateError` and `GraphApiError` surface their machine-readable fields so
 * the model can self-correct; everything else degrades to a bare message. The
 * record is redacted downstream by {@link shapeResult}, never here.
 */
function buildErrorRecord(err: unknown): Record<string, unknown> {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof WriteGateError) {
    return { error: message, code: err.code, tool: err.tool, tier: err.tier };
  }
  if (err instanceof GraphApiError) {
    return {
      error: message,
      code: err.code,
      ...(err.subcode !== undefined ? { subcode: err.subcode } : {}),
      ...(err.type !== undefined ? { type: err.type } : {}),
      httpStatus: err.httpStatus,
      ...(err.fbtraceId !== undefined ? { fbtraceId: err.fbtraceId } : {}),
      ...(err.action !== undefined ? { action: err.action.operatorText } : {}),
    };
  }
  return { error: message };
}

/** Read the optional auto-injected `profile` arg (a profile key or Page ID). */
function extractProfile(args: Record<string, unknown>): string | undefined {
  const raw = args['profile'];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

// ---------------------------------------------------------------------------
// main — the real process bootstrap
// ---------------------------------------------------------------------------

/** System clock: real time + an abortable sleep (mirrors the transport fixture). */
const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('aborted'));
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        },
        { once: true },
      );
    }),
};

/**
 * Resolve the server version from `package.json` at RUNTIME (read as a file, not
 * imported as a module — the file sits outside `rootDir`). From `build/index.js`,
 * `../package.json` resolves to the repository-root manifest. Any failure falls
 * back to {@link FALLBACK_VERSION} so a packaging quirk never crashes startup.
 */
function resolveServerVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') {
      const version = (parsed as Record<string, unknown>)['version'];
      if (typeof version === 'string') return version;
    }
  } catch {
    // fall through to the safe fallback
  }
  return FALLBACK_VERSION;
}

/** Collect every configured secret VALUE so the redactor can scrub it (C3). */
function collectSecrets(settings: Settings): string[] {
  const secrets: string[] = [];
  const push = (value: string | undefined): void => {
    if (typeof value === 'string' && value.length > 0) secrets.push(value);
  };
  push(settings.accessToken);
  push(settings.systemToken);
  push(settings.pageToken);
  push(settings.appSecret);
  push(settings.httpToken);
  push(settings.confirmToken);
  if (settings.appId !== undefined && settings.appSecret !== undefined) {
    push(`${settings.appId}|${settings.appSecret}`);
  }
  for (const profile of Object.values(settings.profiles)) {
    push(profile.tokenOverride);
  }
  return secrets;
}

/**
 * Real bootstrap: resolve settings, build collaborators, then run `doctor` or
 * start the transport. Never called by tests (they drive {@link buildServer}).
 */
async function main(): Promise<void> {
  const serverVersion = resolveServerVersion();
  const { settings, report } = loadSettings();

  const clock = systemClock;
  const redactor = createRedactor({ secrets: collectSecrets(settings) });
  const logger = createLogger({ clock, redactor, level: settings.logLevel });
  const fbRequest = createFbRequest({ settings, clock, redactor, logger });
  const journal = createJournal({ clock, redactor, journalPath: settings.journalPath });
  const pages = createPagesRegistry({ settings, fbRequest, clock, redactor, logger });

  // --- Package assembly -----------------------------------------------------
  // WAVE 4 INSERTION POINT (V01–V08): append each vertical `PackageSpec` factory
  // exported from `./tools/index.js` to this array as its module lands — e.g.
  // `createReaderPackage({ ... })`, `createPostsPackage({ ... })`. The registry
  // then applies selection / deny-list / read-only posture from `settings`; no
  // other change here is required.
  const packages: PackageSpec[] = [
    createCorePackage({ serverVersion }),
    // <-- add Wave-4 vertical packages here
  ];

  // `doctor` subcommand: emit the diagnostic report to STDERR (never stdout) and
  // exit BEFORE the fail-closed assertion, so it still reports when the token is
  // missing (the doctor never throws for an auth/scope problem).
  if (process.argv[2] === 'doctor') {
    const doctorReport = await runDoctor({
      fbRequest,
      settings,
      clock,
      logger,
      redactor,
      packages,
      serverVersion,
    });
    process.stderr.write(`${renderDoctorReport(doctorReport)}\n`);
    process.exit(0);
  }

  // Fail closed on error-severity config problems (missing token; http w/o token).
  assertStartupOk(report);

  const controller = new AbortController();
  const server = buildServer({
    settings,
    packages,
    serverVersion,
    clock,
    logger,
    redactor,
    journal,
    fbRequest,
    pages,
  });

  const handle = await startTransport(server, settings, {
    logger,
    signal: controller.signal,
  });
  logger.info('facebook-mcp server started', {
    transport: handle.kind,
    version: serverVersion,
    packages: packages.map((pkg) => pkg.name),
  });

  // Graceful shutdown: aborting the controller drives the transport's own
  // shutdown path (close listener + unwind in-flight work — CC-MCP-5).
  const requestShutdown = (signal: NodeJS.Signals): void => {
    logger.info('shutdown signal received', { signal });
    controller.abort();
  };
  process.once('SIGINT', requestShutdown);
  process.once('SIGTERM', requestShutdown);

  await handle.closed;
}

// Run only when this module is the process entry point (not on import — tests
// import `buildServer` without ever triggering the bootstrap).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((err: unknown) => {
    process.stderr.write(
      `facebook-mcp failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
