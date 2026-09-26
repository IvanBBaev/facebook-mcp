// Server bootstrap (task I1) — the integration seam that ties the
// `core <- api <- mcp <- tools` stack into one runnable MCP server.
//
// Two entry points, kept apart so the wiring is unit-testable without a process:
//
//   * `buildServer(deps)` — a pure, dependency-injected builder. It resolves the
//     active tool set via the registry, registers a `tools/list` + `tools/call`
//     handler pair on a low-level MCP `Server`, assembles a per-call
//     `ToolContext` (plus the write-gate + confirmer seam), emits the one
//     allowlisted log line the called spec authorizes, invokes the matching tool
//     handler and maps any thrown error to an error `ToolResult` through the
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
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Notification,
  type Request,
  type ServerNotification,
  type ServerRequest,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import {
  assertStartupOk,
  createFbRequest,
  createHostSemaphores,
  createUploadHandler,
  usageOfGraphError,
  createLogger,
  createPagesRegistry,
  createRedactor,
  errorMessageOf,
  GraphApiError,
  isPageTokenDead,
  loadSettings,
  type Clock,
  type ConfirmationRequest,
  type Confirmer,
  type FbRequestFn,
  type Journal,
  type LogFields,
  type Logger,
  type PackageSpec,
  type PageResolver,
  type ProgressReporter,
  type Redactor,
  type Settings,
  type StartupReport,
  type ToolContext,
  type ToolResult,
  type ToolSpec,
  type WriteMode,
} from './core/index.js';
import {
  createConfirmer,
  createJournal,
  createRegistry,
  createWriteGate,
  doctorExitCode,
  parseSetupTokenArgs,
  renderDoctorReport,
  renderSetupTokenReport,
  runDoctor,
  runSetupToken,
  shapeResult,
  startTransport,
  WriteGateError,
  type AdAccountProbe,
  type DoctorDeps,
  type DoctorReport,
  type ConnectableServer,
  type ElicitCapability,
  type MetricProbe,
  type WriteGate,
} from './mcp/index.js';
import { normalizeAdAccountId, readAdAccount } from './api/ads-read.js';
import { fetchInsights, PAGE_INSIGHTS_LIKES_FLOOR } from './api/insights.js';
import {
  createAdsPackage,
  createCorePackage,
  graphErrorFields,
  createInsightsPackage,
  createMessagesPackage,
  createModerationPackage,
  createPostsPackage,
  createReaderPackage,
} from './tools/index.js';

/** Advertised MCP server name (matches the whoami / doctor envelopes). */
const SERVER_NAME = 'facebook-mcp';

/** Fallback version used when `package.json` cannot be read at runtime. */
const FALLBACK_VERSION = '0.0.0';

/** The runtime dependency whose version rides along in the version surfaces. */
const SDK_PACKAGE = '@modelcontextprotocol/sdk';

/** Last-resort SDK version when neither the install nor our manifest answers. */
const UNKNOWN_SDK_VERSION = 'unknown';

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
   * Out-of-band confirmation seam (B1). Defaults to a confirmer bound to the
   * live session: MCP elicitation where the client supports it, the
   * `FB_CONFIRM_TOKEN` operator token otherwise. Injectable so tests can supply
   * an approving/denying fake.
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

  const server = new Server(
    { name: SERVER_NAME, version: deps.serverVersion },
    { capabilities: { tools: {} } },
  );

  // The elicitation seam is wired unconditionally: whether the connected client
  // can prompt a human is only knowable AFTER the handshake, and this builder
  // runs before it. `elicitVia` therefore probes the capability per call and
  // throws when it is absent, which `createConfirmer` turns into a fall-through
  // to the operator-token route (CC-MCP-6) — never into a silent allow.
  const confirmer =
    deps.confirmer ?? createConfirmer({ settings, elicit: elicitVia(server) });

  // One gate per DISTINCT effective write mode, not one per call: the gate owns
  // the in-memory plan store, so rebuilding it would throw away every plan_id it
  // has issued. A tool belongs to exactly one package and therefore always
  // resolves to the same mode, so a plan and its apply always meet in one gate.
  const gates = new Map<WriteMode, WriteGate>();
  const gateFor = (mode: WriteMode): WriteGate => {
    const existing = gates.get(mode);
    if (existing !== undefined) return existing;
    const gate = createWriteGate({
      clock: deps.clock,
      journal: deps.journal,
      defaultWriteMode: mode,
      confirmer,
    });
    gates.set(mode, gate);
    return gate;
  };

  // A name the registry dropped by configuration is not a typo: "unknown tool"
  // sends the model hunting for a spelling, while the fix is an operator's
  // package setting. Name the package and the variable that removed it.
  const unadvertisedToolMessage = (name: string): string => {
    const owner = deps.packages.find((pkg) =>
      pkg.tools.some((tool) => tool.name === name),
    );
    if (owner === undefined) return `unknown tool: ${name}`;
    const reason = registry.packageNames.some((loaded) => loaded === owner.name)
      ? `FB_PACKAGES_READONLY drops the write tools of package '${owner.name}'`
      : `package '${owner.name}' is not loaded (FB_TOOL_PACKAGES does not select it, or FB_PACKAGES_DENY removes it)`;
    return `tool ${name} is disabled in this deployment: ${reason}. Retrying will not help; an operator must change that setting and restart the server.`;
  };

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
          { error: unadvertisedToolMessage(request.params.name) },
          { maxResultChars: settings.maxResultChars, redactor, isError: true },
        ),
      );
    }

    const profile = extractProfile(args);
    const reportProgress = progressReporterFor(extra, deps.logger);
    const tracked = trackResolvedPages(deps.pages);
    const ctx: ToolCallContext = {
      settings,
      fbRequest: deps.fbRequest,
      pages: tracked.pages,
      logger: deps.logger,
      redactor,
      clock: deps.clock,
      journal: deps.journal,
      signal: extra.signal,
      ...(profile !== undefined ? { profile } : {}),
      ...(reportProgress !== undefined ? { reportProgress } : {}),
      writeGate: gateFor(registry.writeModeFor(spec.name)),
      confirmer,
    };

    // The log-hygiene control (04 §"Log hygiene"): at most ONE structured line
    // per call, carrying the tool name and only what `spec.logFields` allowlists.
    // It is emitted BEFORE the handler runs — a line written only on success is
    // missing for exactly the calls worth diagnosing (a throw, a hang, a call
    // that took the process down), and the failure path already ships its own
    // redacted error result, so a second line after the fact adds nothing.
    // Logging pre-handler means logging RAW, unvalidated arguments: the strict
    // parse happens inside `spec.handler`, which is why the projection below
    // trusts neither the declared type of a value nor the caller.
    const logged = allowlistedLogFields(spec, args, redactor);
    if (logged !== undefined) deps.logger.info('tool call', logged);

    try {
      const result = await spec.handler(args, ctx);
      return toCallToolResult(result);
    } catch (err) {
      // The C1 invalidate-on-190 hook, driven from the one place every thrown
      // Graph refusal passes: a Page token Graph just called dead is dropped so
      // the model's retry re-derives instead of replaying it from the cache.
      if (invalidatesPageToken(err)) {
        for (const pageId of tracked.resolved) deps.pages.invalidate(pageId);
      }
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

/**
 * The per-request argument the SDK hands a `tools/call` handler, spelled with
 * the generic parameters a `Server` built without type arguments produces. It
 * carries `_meta` (the caller's request metadata, where a `progressToken` rides)
 * and `sendNotification`, the request-scoped emitter that tags each notification
 * with the originating request id.
 */
type ToolCallExtra = RequestHandlerExtra<
  ServerRequest | Request,
  ServerNotification | Notification
>;

/**
 * Bind the request's `_meta.progressToken` into the {@link ProgressReporter} a
 * long upload calls while it works (CC-MCP-1).
 *
 * The token is what associates a `notifications/progress` frame with the call it
 * belongs to, so a client that supplied none gets NO reporter at all rather than
 * an emitter with nothing to address: `ToolContext.reportProgress` stays absent
 * and every consumer's `ctx.reportProgress?.(…)` degrades to a no-op. Inventing
 * a token here would emit frames the client must discard (the SDK's client-side
 * dispatcher reports an unknown token as a protocol error).
 *
 * Delivery is strictly best-effort and never observable by the tool. The
 * reporter is synchronous by contract, so the send is started and detached: the
 * async wrapper turns BOTH a synchronous throw and a rejected send into the same
 * rejection, which is logged at debug level to stderr and swallowed. A client
 * that closed its stream mid-upload, or a transport that cannot frame the
 * notification, must not be able to fail a publish that otherwise succeeded —
 * and an unhandled rejection here would take the whole process down.
 */
function progressReporterFor(
  extra: ToolCallExtra,
  logger: Logger,
): ProgressReporter | undefined {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return undefined;

  return (update) => {
    void (async () =>
      await extra.sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: update.progress,
          ...(update.total !== undefined ? { total: update.total } : {}),
          ...(update.message !== undefined ? { message: update.message } : {}),
        },
      }))().catch((err: unknown) => {
      logger.debug('progress notification failed', {
        error: errorMessageOf(err),
      });
    });
  };
}

/**
 * Bind the live MCP session's elicitation capability into the shape the
 * {@link Confirmer} expects (B1 / CC-MCP-6).
 *
 * The client is asked to tick one boolean rather than to type the action back,
 * because the prompt must be answerable by a human who is NOT reading the model
 * transcript — that is the whole point of an out-of-band gate. Anything other
 * than an explicit `accept` + `confirm:true` is a refusal: a client that returns
 * `accept` with no content has not confirmed anything.
 *
 * A client without elicitation support makes this throw, which `createConfirmer`
 * catches and converts into the operator-token route. That is deliberate — the
 * fall-through lives in one place and is reported truthfully as
 * `method: 'operator_token'` or `'denied'`, never as an elicitation.
 */
function elicitVia(server: Server): ElicitCapability {
  return async (request: ConfirmationRequest) => {
    // `Server.elicitInput` demands `elicitation.form` specifically, not merely
    // `elicitation` — a client advertising a bare `elicitation: {}` would sail
    // past a looser check and then throw from inside the SDK, which is still
    // fail-closed but reports the wrong reason. Probe what the SDK probes.
    if (server.getClientCapabilities()?.elicitation?.form === undefined) {
      throw new Error('the connected client does not support MCP form elicitation');
    }
    const result = await server.elicitInput({
      message: elicitationPrompt(request),
      requestedSchema: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            title: 'Perform this action',
            description: `Tick to authorize this ${request.tier} write. Leave unticked to refuse.`,
          },
        },
        required: ['confirm'],
      },
    });
    if (result.action !== 'accept') {
      return {
        confirmed: false,
        note: `the operator ${result.action === 'decline' ? 'declined' : 'cancelled'} the confirmation prompt`,
      };
    }
    if (result.content?.confirm !== true) {
      return { confirmed: false, note: 'the operator did not tick the confirmation box' };
    }
    return { confirmed: true };
  };
}

/** The human-facing text of the confirmation prompt. Carries no secret. */
function elicitationPrompt(request: ConfirmationRequest): string {
  const lines = [`${request.tool} — ${request.reason}.`, '', request.summary];
  if (request.planId !== undefined) lines.push('', `Plan: ${request.planId}`);
  return lines.join('\n');
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
 * Wrap the shared {@link PageResolver} for ONE call so the hub knows which
 * Page(s) the handler resolved a token for. The registry's cache would otherwise
 * keep serving a Page token Graph has already refused until its TTL expires
 * (15 min), and every retry the model makes in that window fails the same way:
 * no handler reports a dead token back, so the hub does it on their behalf.
 *
 * Invalidating a Page whose token is a configured override is harmless — the
 * registry returns an override before consulting the cache, so nothing is lost.
 */
function trackResolvedPages(pages: PageResolver): {
  readonly pages: PageResolver;
  readonly resolved: ReadonlySet<string>;
} {
  const resolved = new Set<string>();
  return {
    pages: {
      resolvePage: async (profile) => {
        const page = await pages.resolvePage(profile);
        resolved.add(page.pageId);
        return page;
      },
      invalidate: (pageId) => {
        pages.invalidate(pageId);
      },
    },
    resolved,
  };
}

/**
 * Whether a thrown error proves the resolved Page token worthless: core/auth's
 * {@link isPageTokenDead} (190, 102, or 100 with a stale-object subcode — the
 * resolver cache's own CC-AUTH-7 signal) on the error or anywhere down its
 * `cause` chain, bounded at depth 4. A tool that re-words a Graph refusal into
 * its own error keeps the original as `cause`; reading only the top level would
 * leave that dead token cached for the rest of its TTL. Anything else says
 * nothing about the Page token and leaves the cache alone.
 */
function invalidatesPageToken(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
    if (isPageTokenDead(current)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/**
 * The compact usage figures of the response a Graph error was raised for — the
 * percentage of each bucket Meta reported — or `undefined` when that response
 * carried none. Only the parsed percentages ship: the raw header bag is
 * unbounded and adds nothing the model can act on.
 */
function usageRecord(err: unknown): Record<string, number> | undefined {
  const snapshot = usageOfGraphError(err);
  if (snapshot === undefined) return undefined;
  const usage: Record<string, number> = {};
  if (snapshot.appUsagePct !== undefined) usage['appUsagePct'] = snapshot.appUsagePct;
  if (snapshot.businessUseCasePct !== undefined) {
    usage['businessUseCasePct'] = snapshot.businessUseCasePct;
  }
  if (snapshot.adsInsightsThrottlePct !== undefined) {
    usage['adsInsightsThrottlePct'] = snapshot.adsInsightsThrottlePct;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * Turn a thrown error into a redactable record for the error `ToolResult`.
 * `WriteGateError` and `GraphApiError` surface their machine-readable fields so
 * the model can self-correct; everything else degrades to a bare message. The
 * record is redacted downstream by {@link shapeResult}, never here.
 *
 * The F06 classification is flattened onto the record rather than nested: the
 * operator SENTENCE lands on `action` as before, and the decisions the model has
 * to make — is this worth retrying, what should it run next, how long is the
 * cool-down — ship as their own fields. Prose alone forces the model to infer
 * "do NOT retry" from wording; `retryable: false` and `nextTool` state it.
 */
function buildErrorRecord(err: unknown): Record<string, unknown> {
  const message = errorMessageOf(err);
  if (err instanceof WriteGateError) {
    return { error: message, code: err.code, tool: err.tool, tier: err.tier };
  }
  if (err instanceof GraphApiError) {
    const action = err.action;
    const usage = usageRecord(err);
    return {
      error: message,
      // Graph's identity plus its human-readable refusal, when it sent one: on
      // an ads or publishing rejection `error` is the generic "Invalid
      // parameter" and userTitle/userMessage are the only reason the model can
      // act on. Shared with the package-local envelopes, which bound Meta's
      // text the same way so a pathological body cannot dominate the record.
      ...graphErrorFields(err),
      ...(action !== undefined
        ? {
            action: action.operatorText,
            category: action.category,
            retryable: action.retryable,
            ...(action.nextTool !== undefined ? { nextTool: action.nextTool } : {}),
            ...(action.retryAfterMs !== undefined
              ? { retryAfterMs: action.retryAfterMs }
              : {}),
          }
        : {}),
      // The usage figures of the refusing response. A throttle sends the model
      // to facebook_usage, but that tool probes `/me` — a different call that
      // may land in a different bucket, or be refused by the same throttle — so
      // only this response names the bucket that refused THIS call.
      ...(usage !== undefined ? { usage } : {}),
    };
  }
  return { error: message };
}

/**
 * Project one call's allowlisted arguments into the fields of its log line
 * (04 §"Log hygiene"). `spec.logFields` is the ONLY source of keys: there is no
 * default key set and no whole-argument fallback, so a spec that declares no
 * allowlist returns `undefined` and the call logs NOTHING. Logging an argument
 * object nobody reviewed is the precise failure the allowlist exists to prevent.
 *
 * Three rules make the line safe to append to a long-lived operator log:
 *
 *  - the allowlist decides WHICH keys are eligible — a key the author never
 *    named cannot reach the log however innocuous it looks;
 *  - every surviving value still goes through the {@link Redactor}, because a
 *    reviewed key is no guarantee about the VALUE a caller put in it (a token
 *    pasted into `object_id` is a real shape). The allowlist is the first
 *    defence at the C3 choke-point, never the only one. Redacting here rather
 *    than relying on the logger's own pass is deliberate: the logger is an
 *    injected seam, and a caller that supplies a non-redacting one must not be
 *    able to turn this line into a leak;
 *  - only `string` / `number` / `boolean` values are logged. Anything else is
 *    replaced by a bare type tag: the author reviewed the KEY, and an object or
 *    array smuggles in sub-keys nobody reviewed — and since this runs before the
 *    strict parse, an argument's runtime shape is whatever the caller sent, not
 *    what the schema declares. The tag keeps the diagnostic signal (the argument
 *    was present, and it was an object) without emitting its content.
 *
 * An absent — or explicitly `undefined` — argument contributes nothing rather
 * than a `null` that a genuine `null` could not be told apart from.
 *
 * The values ride under a nested `args` member so that an allowlisted argument
 * named `tool` cannot displace the tool name, and no tool argument can even
 * reach the logger's reserved `time`/`level`/`msg` keys.
 */
function allowlistedLogFields(
  spec: ToolSpec,
  args: Record<string, unknown>,
  redactor: Redactor,
): LogFields | undefined {
  const allowed = spec.logFields;
  if (allowed === undefined || allowed.length === 0) return undefined;

  const projected: Record<string, unknown> = {};
  for (const key of allowed) {
    const value = args[key];
    if (value === undefined) continue;
    projected[key] =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? redactor.redact(value)
        : typeTag(value);
  }
  return { tool: spec.name, args: projected };
}

/**
 * The stand-in logged for a non-scalar allowlisted argument: its SHAPE, never
 * its content. `null` and arrays are named explicitly because `typeof` calls
 * both `'object'`, and the difference is the whole diagnostic value of the tag.
 */
function typeTag(value: unknown): string {
  if (value === null) return '[null]';
  if (Array.isArray(value)) return '[array]';
  return `[${typeof value}]`;
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

/**
 * The filesystem seams {@link resolveSdkVersion} needs, injected so a test can
 * drive every fallback branch without a doctored `node_modules` tree (C14).
 */
export interface SdkVersionSources {
  /** Node module resolution. Throws when a package does not export the path. */
  readonly resolve: (specifier: string) => string;
  /** UTF-8 file read. Throws when the path is absent or unreadable. */
  readonly readText: (path: string | URL) => string;
}

/** The production seams: real Node resolution, real filesystem. */
function defaultSdkVersionSources(): SdkVersionSources {
  const requireFrom = createRequire(import.meta.url);
  return {
    resolve: (specifier) => requireFrom.resolve(specifier),
    readText: (path) => readFileSync(path, 'utf8'),
  };
}

/** `parsed[field]` when it is a non-empty string, else `undefined`. */
function stringField(parsed: unknown, field: string): string | undefined {
  if (parsed !== null && typeof parsed === 'object') {
    const value = (parsed as Record<string, unknown>)[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Every path that could hold the installed SDK manifest, most authoritative
 * first: whatever Node resolves, then `node_modules/<pkg>/package.json` beside
 * this module and in each ancestor directory (npm hoists to the project root,
 * pnpm nests, a bundled install may sit next to the build output).
 */
function sdkManifestCandidates(
  resolve: SdkVersionSources['resolve'],
): readonly (string | URL)[] {
  const candidates: (string | URL)[] = [];
  try {
    candidates.push(resolve(`${SDK_PACKAGE}/package.json`));
  } catch {
    // The package does not export `./package.json` — the walk below covers it.
  }
  let dir = new URL('.', import.meta.url);
  for (;;) {
    candidates.push(new URL(`node_modules/${SDK_PACKAGE}/package.json`, dir));
    const parent = new URL('..', dir);
    if (parent.href === dir.href) break; // filesystem root reached
    dir = parent;
  }
  return candidates;
}

/**
 * Resolve the MCP SDK version at RUNTIME, defensively, never throwing.
 *
 * The chain exists because the surfaces that carry this value — `--version` and
 * `facebook_whoami` — are exactly the ones a BROKEN install is asked for. A
 * resolver that threw, or that answered only from a healthy `node_modules`,
 * would go silent precisely when a bug report needs it; so every step degrades
 * into the next and the last one always answers:
 *
 *   1. The installed package's own `package.json`. Node's resolver is asked
 *      first, but `@modelcontextprotocol/sdk` maps `./*` onto `./dist/esm/*`
 *      (import) and `./dist/cjs/*` (require), so
 *      `require.resolve('@modelcontextprotocol/sdk/package.json')` SUCCEEDS and
 *      hands back the one-line `{"type":"commonjs"}` stub inside `dist/cjs/` —
 *      a manifest with no `version` field at all. A resolved path is therefore
 *      only believed when it actually carries a version, and the walk up
 *      through `node_modules/` (which is what answers on a normal install)
 *      follows regardless.
 *   2. The version RANGE this repo declares for the SDK (e.g. `^1.29.0`). Not
 *      the installed version, but enough to triage a report from a tree whose
 *      dependencies never installed.
 *   3. {@link UNKNOWN_SDK_VERSION} — an honest literal beats an empty field.
 */
export function resolveSdkVersion(
  sources: SdkVersionSources = defaultSdkVersionSources(),
): string {
  for (const candidate of sdkManifestCandidates(sources.resolve)) {
    try {
      const parsed: unknown = JSON.parse(sources.readText(candidate));
      const version = stringField(parsed, 'version');
      if (version !== undefined) return version;
    } catch {
      // Absent, unreadable or not JSON — try the next candidate.
    }
  }
  try {
    // Same read as `resolveServerVersion`: a file next to the build output,
    // never an imported module (`package.json` sits outside `rootDir`).
    const parsed: unknown = JSON.parse(
      sources.readText(new URL('../package.json', import.meta.url)),
    );
    if (parsed !== null && typeof parsed === 'object') {
      const range = stringField(
        (parsed as Record<string, unknown>)['dependencies'],
        SDK_PACKAGE,
      );
      if (range !== undefined) return range;
    }
  } catch {
    // fall through to the honest literal
  }
  return UNKNOWN_SDK_VERSION;
}

/** Is `arg` the version flag? `-v` is an alias; there is no verbose flag to clash with. */
export function isVersionFlag(arg: string | undefined): boolean {
  return arg === '--version' || arg === '-v';
}

/** Is `arg` the help flag? `-h` is an alias. */
export function isHelpFlag(arg: string | undefined): boolean {
  return arg === '--help' || arg === '-h';
}

/**
 * What `--help` prints. Answered before settings are loaded, like `--version`:
 * without it, `--help` fell through to the server start, which either hung
 * silently on stdin (a token configured) or failed on the missing token — the
 * operator asking how to use the binary was told neither.
 */
export const USAGE_TEXT = [
  'Usage: facebook-mcp [command]',
  '',
  'With no command, starts the MCP server (stdio by default; FB_TRANSPORT=http',
  'selects the HTTP transport) and waits for a client. Any argument not listed',
  'below also starts the server.',
  '',
  'Commands:',
  '  doctor [--strict]      Pre-flight report on stderr: token, scopes, package',
  '                         matrix. Exits 0 unless --strict is passed and the',
  '                         verdict is not ok.',
  '  setup-token [options]  Exchange a short-lived user token for a long-lived',
  '                         credential. Read the token from FB_SETUP_TOKEN rather',
  '                         than passing it as an argument. Options: --page=<id>,',
  '                         --env-file=<path>, --force, --no-write.',
  '  --version, -v          Print the server, Node and MCP SDK versions.',
  '  --help, -h             Print this help.',
  '',
].join('\n');

/**
 * The arguments `doctor` did not understand, described without their values,
 * or `undefined` when there are none.
 *
 * A near-miss such as `--stric` deliberately does not gate (see
 * {@link isStrictFlag}), but ignoring it silently let a pipeline that meant to
 * gate read exit 0 as a pass with nothing on screen to say otherwise. Only the
 * option NAME is echoed: `--token=EAAB…` or a pasted bare token is exactly what
 * lands here, and the doctor report never carries a credential.
 */
function ignoredDoctorArgsNote(args: readonly string[]): string | undefined {
  const described = new Set<string>();
  for (const arg of args) {
    if (arg === '--strict') continue;
    if (arg.startsWith('-')) {
      const eq = arg.indexOf('=');
      described.add(JSON.stringify(eq === -1 ? arg : `${arg.slice(0, eq)}=\u2026`));
    } else {
      described.add('a positional argument');
    }
  }
  if (described.size === 0) return undefined;
  return `Ignored unknown doctor argument ${[...described].join(', ')}. The doctor accepts only --strict.`;
}

/**
 * Hand every warning-severity startup problem to the logger, one WARN each.
 *
 * `assertStartupOk` renders the warnings only inside the error it throws, so on
 * a clean start — the common case — an operator whose Page token is bound to no
 * Page, or whose app secret is unset, saw nothing at all. The fields mirror
 * `StartupProblem` so a log consumer can key on the stable `code`.
 */
export function logStartupWarnings(logger: Logger, report: StartupReport): void {
  for (const problem of report.warnings) {
    logger.warn('startup config warning', {
      code: problem.code,
      ...(problem.field !== undefined ? { field: problem.field } : {}),
      message: problem.message,
    });
  }
}

/**
 * Did the operator ask `doctor` to gate on its own verdict?
 *
 * Long form only: a one-letter alias for a flag that changes an exit code is
 * the kind of thing a CI script acquires by accident.
 */
export function isStrictFlag(args: readonly string[]): boolean {
  return args.includes('--strict');
}

/**
 * The single line `--version` prints.
 *
 * It carries the runtime and the MCP SDK alongside the server version because
 * the bug report template asks for all three: a mismatched Node and a stale SDK
 * are the two causes that make a report unreproducible on the maintainer's box,
 * and neither is visible from the server version alone. Format stays
 * `name version (details)`, so `awk '{print $2}'` still yields a bare version
 * for a script — every addition goes inside the parenthetical.
 */
export function versionLine(
  serverVersion: string,
  sdkVersion: string,
  runtime: { readonly node: string; readonly platform: string; readonly arch: string } = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
): string {
  return `facebook-mcp ${serverVersion} (node ${runtime.node}, ${runtime.platform} ${runtime.arch}, sdk ${sdkVersion})`;
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
 * Narrow the built package array to the packages the registry will actually
 * LOAD — the set the doctor documents as its input (`DoctorDeps.packages`) and
 * the set `ToolRegistry.packageNames` exists to name.
 *
 * The array `main` assembles is everything the bootstrap CAN build; selection
 * happens later, inside the registry. Handing the whole array to the doctor
 * makes it judge packages that are not running, and both directions are wrong:
 * `ads` is off by default, so a correctly provisioned default install reports
 * `ads: BLOCKED - missing ads_read, ads_management` and turns `doctor --strict`
 * red over a package nobody enabled; and in reverse, the over-scope check counts
 * the ads permissions as "needed", so an `ads_management` scope riding on a
 * runtime token that cannot use it is never flagged.
 *
 * A selection fault (an unknown `FB_TOOL_PACKAGES` name) is not the doctor's
 * failure to report: fall back to the full array so the report still comes out,
 * and leave the error to the startup path, which is where the operator is told
 * about it.
 */
export function loadedPackages(
  packages: readonly PackageSpec[],
  settings: Settings,
): readonly PackageSpec[] {
  let loaded: ReadonlySet<string>;
  try {
    loaded = new Set<string>(createRegistry(packages, settings).packageNames);
  } catch {
    return packages;
  }
  return packages.filter((pkg) => loaded.has(pkg.name));
}

/**
 * Why the configured package selection does not resolve, if it does not.
 *
 * {@link loadedPackages} deliberately swallows this — it has a report to
 * produce and no channel to complain through. But swallowing it everywhere left
 * the doctor, of all commands, silently judging an install against every package
 * when the truth is that the server will not start at all. This is the channel:
 * the bootstrap asks, and the doctor turns the answer into a `fail` finding.
 */
export function packageSelectionFault(
  packages: readonly PackageSpec[],
  settings: Settings,
  redactor: Redactor,
): string | undefined {
  try {
    createRegistry(packages, settings);
    return undefined;
  } catch (err) {
    return redactor.redactString(errorMessageOf(err));
  }
}

/**
 * The whole `doctor` subcommand, minus the two things only `main` can do: write
 * to stderr and exit the process.
 *
 * It exists as its own function because the narrowing below is the kind of
 * defect that cannot be caught where it is written. `loadedPackages` is unit
 * tested, but a test that calls it itself proves only that the helper works —
 * delete the call from the command and every such test still passes, while a
 * default install goes back to being judged on a package it never loads. The
 * seam has to sit where the report is actually produced for a test to be able
 * to hold the command to it.
 *
 * `startup` is the report `loadSettings()` produced for the environment the
 * doctor runs in. It is required, not optional, for the same reason the
 * package fault is computed here: the doctor runs BEFORE `assertStartupOk`,
 * so this is the only place a startup error — a server that will not start —
 * can still reach the verdict, and a caller that forgets it would get a green
 * report on an install that throws on the real start.
 *
 * Returns the rendered report and the exit code rather than performing either:
 * `process.exit` in a tested path would take the test runner with it.
 */
export async function runDoctorCommand(
  deps: DoctorDeps,
  args: readonly string[],
  startup: StartupReport,
): Promise<{
  readonly report: DoctorReport;
  readonly text: string;
  readonly exitCode: number;
}> {
  const fault = packageSelectionFault(deps.packages, deps.settings, deps.redactor);
  const report = await runDoctor({
    ...deps,
    packages: loadedPackages(deps.packages, deps.settings),
    ...(fault !== undefined ? { packageSelectionError: fault } : {}),
    startupProblems: startup.problems,
  });
  const ignored = ignoredDoctorArgsNote(args);
  const rendered = renderDoctorReport(report);
  return {
    report,
    text: ignored === undefined ? rendered : `${rendered}\n${ignored}`,
    exitCode: doctorExitCode(report.summary.verdict, isStrictFlag(args)),
  };
}

/**
 * Ad-account health probe for the doctor (CC-ADS-6). Lives here rather than in
 * `mcp/doctor.ts` for the same reason the metric probe does: the doctor stays
 * free of api-layer imports and the bootstrap does the wiring.
 *
 * A disabled or unsettled ad account fails every ads write with an error that
 * reads like a permission problem but cannot be fixed from the API — so the
 * doctor reports it up front instead of leaving it to the first write.
 */
export function adAccountProbe(): AdAccountProbe {
  return async ({ fbRequest, settings, signal }) => {
    const configured = settings.adAccountId;
    if (configured === undefined || configured.trim() === '') {
      return {
        available: false,
        summary:
          'ad account: not configured (set FB_AD_ACCOUNT_ID to the act_<id> of the account the ads tools should use).',
      };
    }
    const info = await readAdAccount(fbRequest, {
      accountId: normalizeAdAccountId(configured),
      ...(signal !== undefined ? { signal } : {}),
    });
    // `available: false` alone reads the same as "not configured" to the
    // doctor, so a configured account that cannot serve says so explicitly —
    // that is the one answer this probe exists to give (CC-ADS-6), and it has
    // to move the verdict.
    return {
      available: info.serving,
      ...(info.serving ? {} : { degraded: true }),
      summary: `ad account ${info.id}: ${info.summary}`,
      details: {
        statusLabel: info.statusLabel,
        ...(info.currency !== undefined ? { currency: info.currency } : {}),
        ...(info.disableReasonLabel !== undefined
          ? { disableReason: info.disableReasonLabel }
          : {}),
      },
    };
  };
}

/**
 * Metric names the probe asks for. Both are the post-2025-11 survivors, chosen
 * so the probe never trips the api layer's own deprecation table — a probe that
 * queried a dead name would report a tooling bug as a Page problem.
 */
const PROBE_METRICS: readonly string[] = ['page_media_view', 'page_follows'];

/**
 * Insights-metric probe for the doctor (V02). Lives here for the same reason as
 * {@link adAccountProbe}: `mcp/doctor.ts` must not import the api layer, so the
 * bootstrap does the wiring and the doctor only folds the verdict in.
 *
 * It answers the question the insights package fails on most confusingly. Graph
 * accepts the call, returns an empty series, and says nothing about why — and
 * the two causes are indistinguishable at the tool layer: a Page under Meta's
 * eligibility floor, or a token without `read_insights` plus the ANALYZE task.
 * Asking once at startup turns that silence into a line an operator can act on.
 */
export function metricProbe(pages: PageResolver): MetricProbe {
  return async ({ fbRequest, clock, signal }) => {
    const resolved = await pages.resolvePage();
    const result = await fetchInsights(fbRequest, {
      scope: 'page',
      objectId: resolved.pageId,
      metrics: PROBE_METRICS,
      // Totals only: the probe cares whether data exists at all, and a series
      // would drag back up to 250 rows nobody reads.
      aggregate: true,
      token: resolved.token,
      ...(signal !== undefined ? { signal } : {}),
      nowMs: clock.now(),
    });

    const empty = new Set(result.emptyMetrics);
    const unavailable = new Set(result.unavailableMetrics);
    const answered = result.queriedMetrics.filter(
      (metric) => !empty.has(metric) && !unavailable.has(metric),
    );
    const details = {
      pageId: resolved.pageId,
      queried: result.queriedMetrics,
      answered,
      empty: result.emptyMetrics,
      unavailable: result.unavailableMetrics,
    };

    if (answered.length > 0) {
      return {
        available: true,
        summary: `metric probe: Page ${resolved.pageId} answers insights (${answered.join(', ')}).`,
        details,
      };
    }
    // Both remaining answers are `degraded`, not silent: Graph answered, and
    // either way this install cannot read insights as pinned. The "no entry"
    // case is a version problem the operator fixes with FB_API_VERSION or a
    // server upgrade rather than from `.env` scopes — but it is still theirs to
    // act on, and the summary already says the Page is not at fault. `warn`
    // (not `unknown`) keeps the ladder honest: the probe DID complete; it is
    // a probe that threw that established nothing.
    if (unavailable.size === result.queriedMetrics.length) {
      return {
        available: false,
        degraded: true,
        summary: `metric probe: Graph returned no entry for ${result.queriedMetrics.join(', ')} on Page ${resolved.pageId} — those names are not valid for the pinned API version, so the probe cannot judge the Page. Ask facebook_page_insights for a name Meta still serves.`,
        details,
      };
    }
    // A mix — some names accepted with no data, the rest never mentioned —
    // must not be summarised as "accepted the metrics": the operator would read
    // a name the pinned version does not serve as one Graph took.
    const floor = `Usually the eligibility floor (a Page under ~${String(PAGE_INSIGHTS_LIKES_FLOOR)} followers returns empty insights), otherwise a token missing read_insights or the ANALYZE Page task.`;
    if (unavailable.size > 0) {
      return {
        available: false,
        degraded: true,
        summary: `metric probe: Page ${resolved.pageId} returned no data for ${result.emptyMetrics.join(', ')} and no entry for ${result.unavailableMetrics.join(', ')} (not valid for the pinned API version). ${floor}`,
        details,
      };
    }
    return {
      available: false,
      degraded: true,
      summary: `metric probe: Page ${resolved.pageId} accepted the metrics and returned no data. ${floor}`,
      details,
    };
  };
}

/**
 * The fields of the one `facebook-mcp server started` line.
 *
 * `packages` names what the registry actually LOADED, not every package the
 * bootstrap built: selection, the deny-list and the default expansion all
 * happen inside the registry, so the built array always lists `ads` — which
 * is off by default. An operator reading this line to learn why a tool is
 * missing was told the package serving it was running.
 */
export function serverStartedFields(
  transport: string,
  serverVersion: string,
  packages: readonly PackageSpec[],
  settings: Settings,
): LogFields {
  return {
    transport,
    version: serverVersion,
    packages: loadedPackages(packages, settings).map((pkg) => pkg.name),
  };
}

/**
 * Real bootstrap: resolve settings, build collaborators, then run `doctor` or
 * start the transport. Never called by tests (they drive {@link buildServer}).
 */
/**
 * The production Graph transport: the JSON client with the multipart / rupload
 * handler wired in, both sharing ONE per-host semaphore set so upload traffic
 * and JSON calls honor a single concurrency budget. Without the upload handler
 * every local-file photo, video chunk and reel upload rejects before it is sent.
 */
export function createTransport(deps: {
  readonly settings: Settings;
  readonly clock: Clock;
  readonly redactor: Redactor;
  readonly logger: Logger;
}): FbRequestFn {
  const semaphores = createHostSemaphores(deps.settings.hostConcurrency);
  const uploadHandler = createUploadHandler({ ...deps, semaphores });
  return createFbRequest({ ...deps, semaphores, uploadHandler });
}

async function main(): Promise<void> {
  const serverVersion = resolveServerVersion();
  const sdkVersion = resolveSdkVersion();

  // `--version` answers BEFORE settings are loaded: a bug reporter asked for the
  // version is usually looking at an install that will not start, and a flag that
  // needs a working credential to tell you its own version is useless exactly
  // then. stdout is right here — nothing else will ever be written to it on this
  // path, so no JSON-RPC frame can be corrupted (G-TOOL-5).
  if (isVersionFlag(process.argv[2])) {
    process.stdout.write(`${versionLine(serverVersion, sdkVersion)}\n`);
    process.exit(0);
  }
  if (isHelpFlag(process.argv[2])) {
    process.stdout.write(USAGE_TEXT);
    process.exit(0);
  }

  const { settings, report } = loadSettings();

  const clock = systemClock;
  const redactor = createRedactor({ secrets: collectSecrets(settings) });
  const logger = createLogger({ clock, redactor, level: settings.logLevel });
  const fbRequest = createTransport({ settings, clock, redactor, logger });
  const journal = createJournal({ clock, redactor, journalPath: settings.journalPath });
  const pages = createPagesRegistry({ settings, fbRequest, clock, redactor, logger });

  // --- Package assembly -----------------------------------------------------
  // Declaration order is the order tools are advertised to the client, so it runs
  // read-only-first (core, reader, insights) before the write-gated packages. The
  // registry then applies selection / deny-list / read-only posture from
  // `settings`; no other change here is required as further packages land.
  const packages: PackageSpec[] = [
    createCorePackage({ serverVersion, sdkVersion }),
    createReaderPackage(),
    createInsightsPackage(),
    createModerationPackage(),
    createMessagesPackage(),
    createPostsPackage(),
    createAdsPackage(),
  ];

  // `doctor` subcommand: emit the diagnostic report to STDERR (never stdout) and
  // exit BEFORE the fail-closed assertion, so it still reports when the token is
  // missing (the doctor never throws for an auth/scope problem). What that
  // assertion would have thrown on still reaches the verdict: the startup
  // report is handed to the doctor rather than dropped on this path. The exit
  // code stays 0 unless `--strict` was passed — see {@link doctorExitCode}.
  if (process.argv[2] === 'doctor') {
    const doctor = await runDoctorCommand(
      {
        fbRequest,
        settings,
        clock,
        logger,
        redactor,
        packages,
        serverVersion,
        metricProbe: metricProbe(pages),
        adAccountProbe: adAccountProbe(),
      },
      process.argv.slice(3),
      report,
    );
    process.stderr.write(`${doctor.text}\n`);
    process.exit(doctor.exitCode);
  }

  // `setup-token` subcommand: the guided onboarding that MINTS the credential,
  // so like `doctor` it must run before the fail-closed assertion — requiring a
  // configured token to obtain a token would be a deadlock. Report to STDERR
  // (stdout belongs to the stdio transport) and exit non-zero when the flow
  // failed, so a wrapper script can branch on it.
  if (process.argv[2] === 'setup-token') {
    const setupResult = await runSetupToken({
      fbRequest,
      settings,
      clock,
      logger,
      redactor,
      input: parseSetupTokenArgs(process.argv.slice(3), process.env),
    });
    process.stderr.write(`${renderSetupTokenReport(setupResult)}\n`);
    process.exit(setupResult.ok ? 0 : 2);
  }

  // Fail closed on error-severity config problems (missing token; http w/o token).
  assertStartupOk(report);
  // Then surface the warning-severity ones, which the assertion never prints on
  // a start it lets through (stderr — stdout is the stdio channel, CC-CFG-1).
  logStartupWarnings(logger, report);

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
  logger.info(
    'facebook-mcp server started',
    serverStartedFields(handle.kind, serverVersion, packages, settings),
  );

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

/**
 * Process entry point, with the top-level failure handling attached.
 *
 * Exported because the published binary is `bin/facebook-mcp.mjs`, which imports
 * this module: through that launcher `process.argv[1]` is the shim's path, never
 * this file's, so the self-run guard below cannot fire. The launcher therefore
 * calls this explicitly. Both paths funnel through one function so a packaged
 * install and a `node build/index.js` run behave identically — a silently
 * exiting binary is the worst possible first impression.
 */
export async function runCli(): Promise<void> {
  try {
    await main();
  } catch (err: unknown) {
    process.stderr.write(`facebook-mcp failed to start: ${errorMessageOf(err)}\n`);
    process.exit(1);
  }
}

// Run only when this module is the process entry point (not on import — tests
// import `buildServer` without ever triggering the bootstrap).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runCli();
}
