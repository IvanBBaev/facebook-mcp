// buildServer — the testable, dependency-injected wiring: registers the
// `tools/list` + `tools/call` request handlers on a low-level MCP Server,
// assembles the per-call ToolContext and emits the allowlisted log line.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type {
  ActivityCursorStore,
  Clock,
  Confirmer,
  FbRequestFn,
  Journal,
  LogFields,
  Logger,
  PackageSpec,
  PageResolver,
  Redactor,
  SavedReplyStore,
  Settings,
  ToolContext,
  ToolSpec,
  WriteMode,
} from '../core/index.js';
import {
  createConfirmer,
  createRegistry,
  createWriteGate,
  shapeResult,
  type ConnectableServer,
  type WriteGate,
} from '../mcp/index.js';
import { elicitVia } from './elicitation.js';
import { buildErrorRecord, invalidatesPageToken, trackResolvedPages } from './errors.js';
import { progressReporterFor } from './progress.js';
import { TolerantCallToolRequestSchema, toCallToolResult, toMcpTool } from './schema.js';

/** Advertised MCP server name (matches the whoami / doctor envelopes). */
const SERVER_NAME = 'facebook-mcp';

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
  /** High-water marks for facebook_get_activity_since; absent ⇒ no persistence. */
  readonly activityState?: ActivityCursorStore;
  /** Local saved replies (F10); absent ⇒ the saved-reply tools refuse. */
  readonly savedReplies?: SavedReplyStore;
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
  server.setRequestHandler(TolerantCallToolRequestSchema, async (request, extra) => {
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
    const invalid = request.params.invalidArguments;
    if (invalid !== undefined) {
      // Answered as a tool error, like every other input the caller got wrong:
      // the model reads a result, and a protocol error tells it nothing it can
      // correct. Nothing ran, so there is nothing to retry but the call itself.
      return toCallToolResult(
        shapeResult(
          {
            error:
              `invalid call to ${spec.name}: \`arguments\` must be an object of named ` +
              `parameters (or omitted), got ${invalid}. Nothing was run; resend the ` +
              'call with an object.',
          },
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
      ...(deps.activityState !== undefined ? { activityState: deps.activityState } : {}),
      ...(deps.savedReplies !== undefined ? { savedReplies: deps.savedReplies } : {}),
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
