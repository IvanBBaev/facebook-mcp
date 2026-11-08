// Tools-as-data contract (X08 split of `core/types.ts`): annotations, results,
// the handler context and `ToolSpec`. The package contract lives in
// `./packages.ts`.

import type { ZodTypeAny } from 'zod';

import type { FbRequestFn, PageRef, PageResolver } from './graph.js';
import type { Clock, Logger, Redactor } from './runtime.js';
import type { Settings } from './settings.js';
import type { ActivityCursorStore, SavedReplyStore } from './stores.js';
import type { Journal, WriteTier } from './write.js';

// ---------------------------------------------------------------------------
// 8. Tools-as-data — ToolSpec / PackageSpec (C5, F11 implements define/registry)
// ---------------------------------------------------------------------------

/**
 * The full MCP annotation quadruple, all four hints REQUIRED and explicit. The
 * spec defaults `destructiveHint:true` / `idempotentHint:false` when an
 * annotations object is present, so a partial object silently misreports intent
 * (doc 06) — this interface makes omission a type error. `openWorldHint` is
 * `true` for every tool here (all touch a live external system).
 */
export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

/** A single text content block returned to the client (v1 emits text only). */
export interface ToolTextContent {
  readonly type: 'text';
  readonly text: string;
}

export type ToolContent = ToolTextContent;

/** What a tool handler returns — a lean projection of MCP's CallToolResult. */
export interface ToolResult {
  readonly content: readonly ToolContent[];
  /** Only for server-owned envelopes (whoami, usage) — CC-MCP-7. */
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

/** Progress update forwarded to the client when a `progressToken` is present (CC-MCP-1). */
export interface ProgressUpdate {
  readonly progress: number;
  readonly total?: number;
  readonly message?: string;
}

export type ProgressReporter = (update: ProgressUpdate) => void;

/**
 * The injectable seam bundle passed to every tool handler. This is the ambient
 * capability set a handler is allowed to touch — no globals, no ALS (C14).
 *
 * FREEZE NOTE: this is the shape most likely to gain fields at I1 (write-mode /
 * plan-apply helpers, taint wrapper, confirmer). Downstream should treat added
 * fields as additive-only.
 */
export interface ToolContext {
  readonly settings: Settings;
  readonly fbRequest: FbRequestFn;
  readonly pages: PageResolver;
  readonly logger: Logger;
  readonly redactor: Redactor;
  readonly clock: Clock;
  readonly journal: Journal;
  /** Local high-water marks for facebook_get_activity_since (absent ⇒ no persistence). */
  readonly activityState?: ActivityCursorStore;
  /** Operator-curated local reply templates (absent ⇒ the saved-reply tools refuse). */
  readonly savedReplies?: SavedReplyStore;
  /** Abort seam for this call (shutdown / cancellation). */
  readonly signal?: AbortSignal;
  /** Progress reporter, present only when the client supplied a progressToken. */
  readonly reportProgress?: ProgressReporter;
  /** The resolved `profile` argument for this call, when the tool is page-scoped. */
  readonly profile?: PageRef;
}

/**
 * A tool handler receives the RAW input (validation/typing happens inside F11's
 * generic `defineTool`, which parses `inputSchema` before calling this) plus the
 * capability context, and returns a {@link ToolResult}.
 */
export type ToolHandler = (input: unknown, ctx: ToolContext) => Promise<ToolResult>;

/**
 * Tools-as-data (C5). Deliberately NON-generic so heterogeneous specs live in a
 * single `ToolSpec[]` without variance gymnastics; the generic, type-safe
 * authoring wrapper (`defineTool`, which infers handler args from the schema)
 * is owned by F11. `inputSchema` is `.strict()` and every field `.describe()`d
 * at registration; `outputSchema` is present only for server-owned envelopes.
 */
export interface ToolSpec {
  /** `facebook_<verb>_<noun>`. */
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  /** Owning package name; the registry may set this from the PackageSpec. */
  readonly package?: string;
  readonly inputSchema: ZodTypeAny;
  readonly outputSchema?: ZodTypeAny;
  readonly annotations: ToolAnnotations;
  /**
   * Write blast-radius tier; absent ⇒ a read-only tool.
   *
   * PRESENCE drops writes under a read-only package (registry.ts), and
   * `defineTool` requires it to agree with `annotations.readOnlyHint`. The gate
   * is still handed a tier per call by the handler, which for a tool whose
   * consequence depends on its arguments is not a constant at all
   * (`facebook_update_ad_object` pauses at `irreversible` and resumes at
   * `spend`) — but the VALUE bounds it (QA-07): `defineTool` binds the gate so
   * a per-call tier in another gate class, or above this one, is refused.
   *
   * The value is therefore a CLAIM about the worst case: the highest tier any
   * call to this tool can hand the gate. It is published — `tierOf` in
   * scripts/gen-metadata.mjs turns it into the tier column operators read in the
   * README — so understating it is a documentation defect, not a harmless
   * mismatch, and it is invisible to the type system either way.
   */
  readonly writeTier?: WriteTier;
  /**
   * The argument names whose values this tool is allowed to put in its per-call
   * log line (04 §"Log hygiene"). The `tools/call` dispatcher logs the tool name
   * plus the values of exactly these keys — each passed through the
   * {@link Redactor}, and reduced to a bare type tag unless it is a
   * string/number/boolean, because a reviewed KEY says nothing about the shape
   * or the content a caller actually sent.
   *
   * Absent (or empty) ⇒ the call logs NOTHING. There is no default key set and
   * the argument object is never logged wholesale: an allowlist nobody wrote is
   * not permission to log everything.
   */
  readonly logFields?: readonly string[];
  readonly handler: ToolHandler;
}
