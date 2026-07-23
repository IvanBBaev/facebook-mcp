// Generic, type-safe tool-authoring wrapper (task F11, C5).
//
// `defineTool` is the single authoring entry point every tool package uses. It
// infers the handler's input type from a Zod object schema, forces the schema to
// `.strict()` (unknown keys are rejected — doc 06 "cross-cutting behaviors"),
// parses the raw input BEFORE the user handler runs, and requires the full MCP
// annotation quadruple explicitly so a partial object can never silently
// misreport intent (the spec defaults `destructiveHint:true`/`idempotentHint:
// false` when annotations are present — doc 06 §top). The result is a
// heterogeneous, non-generic {@link ToolSpec} that lives in a plain `ToolSpec[]`.
//
// Zod-v3 RUNTIME usage is deliberately quarantined to this file (Arch nit):
// `registry.ts` and `packages.ts` only ever see `ZodTypeAny` as a type.

import { z } from 'zod';

import type {
  ToolAnnotations,
  ToolContext,
  ToolHandler,
  ToolResult,
  ToolSpec,
  WriteTier,
} from '../core/index.js';

/**
 * Authoring shape accepted by {@link defineTool}. Generic over the input schema
 * so `handler` receives the parsed, typed value (`z.infer<Schema>`) rather than
 * `unknown`. `annotations` is the frozen {@link ToolAnnotations} quadruple, so
 * omitting a hint is a compile error. `writeTier` absent ⇒ the tool is read-only
 * (matching {@link ToolSpec.writeTier} semantics) and MUST agree with
 * `annotations.readOnlyHint`.
 */
export interface ToolDefinition<Schema extends z.AnyZodObject> {
  /** `facebook_<verb>_<noun>`. */
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  /** Zod object schema; every field `.describe()`d by the author. */
  readonly inputSchema: Schema;
  /** Present only for server-owned envelopes (whoami, usage) — CC-MCP-7. */
  readonly outputSchema?: z.ZodTypeAny;
  /** The full MCP annotation quadruple — all four hints explicit (doc 06). */
  readonly annotations: ToolAnnotations;
  /** Write blast-radius tier; absent ⇒ a read-only tool. */
  readonly writeTier?: WriteTier;
  /** Whitelisted field names safe to log for this tool (redaction-audited). */
  readonly logFields?: readonly string[];
  /** Receives the strict-parsed, typed input plus the capability context. */
  readonly handler: (input: z.infer<Schema>, ctx: ToolContext) => Promise<ToolResult>;
}

/**
 * Build a {@link ToolSpec} from a {@link ToolDefinition}. The returned spec:
 *
 *  - stores the `.strict()` form of `inputSchema` (unknown keys rejected);
 *  - wraps `handler` so the raw input is parsed against that strict schema
 *    BEFORE the author's handler runs — a validation failure rejects the call
 *    and the handler never sees malformed input;
 *  - carries the annotation quadruple verbatim;
 *  - omits `title`/`outputSchema`/`writeTier`/`logFields` when absent (clean
 *    heterogeneous specs), leaving `package` unset for the registry to stamp.
 *
 * @throws Error if `name`/`description` are empty, or if `writeTier` and
 *   `annotations.readOnlyHint` disagree (a write-tier tool cannot be read-only,
 *   and a read-only tool must not carry a tier).
 */
export function defineTool<Schema extends z.AnyZodObject>(
  def: ToolDefinition<Schema>,
): ToolSpec {
  if (def.name.trim().length === 0) {
    throw new Error('defineTool: `name` must be a non-empty string.');
  }
  if (def.description.trim().length === 0) {
    throw new Error(`defineTool(${def.name}): \`description\` must be non-empty.`);
  }

  // writeTier and readOnlyHint must agree — absent tier ⇔ read-only (ToolSpec
  // contract). This is exactly the "silent misreport" class doc 06 warns about.
  const isReadOnly = def.writeTier === undefined;
  if (def.annotations.readOnlyHint !== isReadOnly) {
    throw new Error(
      `defineTool(${def.name}): annotations.readOnlyHint=${String(
        def.annotations.readOnlyHint,
      )} disagrees with writeTier=${def.writeTier ?? 'absent'}; a read-only tool ` +
        `must have writeTier absent and a write tool must set a tier.`,
    );
  }

  const strictSchema = def.inputSchema.strict();

  const handler: ToolHandler = async (input, ctx) => {
    // `.strict()` parse rejects unknown keys before the author's handler runs.
    const parsed: z.infer<Schema> = await strictSchema.parseAsync(input);
    return def.handler(parsed, ctx);
  };

  return {
    name: def.name,
    ...(def.title !== undefined ? { title: def.title } : {}),
    description: def.description,
    inputSchema: strictSchema,
    ...(def.outputSchema !== undefined ? { outputSchema: def.outputSchema } : {}),
    annotations: def.annotations,
    ...(def.writeTier !== undefined ? { writeTier: def.writeTier } : {}),
    ...(def.logFields !== undefined ? { logFields: def.logFields } : {}),
    handler,
  };
}
