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
  createLogger,
  createPagesRegistry,
  createRedactor,
  GraphApiError,
  loadSettings,
  type Clock,
  type ConfirmationRequest,
  type Confirmer,
  type FbRequestFn,
  type Journal,
  type Logger,
  type PackageSpec,
  type PageResolver,
  type ProgressReporter,
  type Redactor,
  type Settings,
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
  parseSetupTokenArgs,
  renderDoctorReport,
  renderSetupTokenReport,
  runDoctor,
  runSetupToken,
  shapeResult,
  startTransport,
  WriteGateError,
  type AdAccountProbe,
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
    const reportProgress = progressReporterFor(extra, deps.logger);
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
      ...(reportProgress !== undefined ? { reportProgress } : {}),
      writeGate: gateFor(registry.writeModeFor(spec.name)),
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
        error: err instanceof Error ? err.message : String(err),
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
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof WriteGateError) {
    return { error: message, code: err.code, tool: err.tool, tier: err.tier };
  }
  if (err instanceof GraphApiError) {
    const action = err.action;
    return {
      error: message,
      code: err.code,
      ...(err.subcode !== undefined ? { subcode: err.subcode } : {}),
      ...(err.type !== undefined ? { type: err.type } : {}),
      httpStatus: err.httpStatus,
      ...(err.fbtraceId !== undefined ? { fbtraceId: err.fbtraceId } : {}),
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
    return {
      available: info.serving,
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
    if (unavailable.size === result.queriedMetrics.length) {
      return {
        available: false,
        summary: `metric probe: Graph returned no entry for ${result.queriedMetrics.join(', ')} on Page ${resolved.pageId} — those names are not valid for the pinned API version, so the probe cannot judge the Page. Ask facebook_page_insights for a name Meta still serves.`,
        details,
      };
    }
    return {
      available: false,
      summary: `metric probe: Page ${resolved.pageId} accepted the metrics and returned no data. Usually the eligibility floor (a Page under ~${String(PAGE_INSIGHTS_LIKES_FLOOR)} followers returns empty insights), otherwise a token missing read_insights or the ANALYZE Page task.`,
      details,
    };
  };
}

/**
 * Real bootstrap: resolve settings, build collaborators, then run `doctor` or
 * start the transport. Never called by tests (they drive {@link buildServer}).
 */
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

  const { settings, report } = loadSettings();

  const clock = systemClock;
  const redactor = createRedactor({ secrets: collectSecrets(settings) });
  const logger = createLogger({ clock, redactor, level: settings.logLevel });
  const fbRequest = createFbRequest({ settings, clock, redactor, logger });
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
      metricProbe: metricProbe(pages),
      adAccountProbe: adAccountProbe(),
    });
    process.stderr.write(`${renderDoctorReport(doctorReport)}\n`);
    process.exit(0);
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
    process.stderr.write(
      `facebook-mcp failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}

// Run only when this module is the process entry point (not on import — tests
// import `buildServer` without ever triggering the bootstrap).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runCli();
}
