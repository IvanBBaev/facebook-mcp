// Shared authoring helpers for the vertical tool packages (Wave 4, V01–V08).
//
// The `tools` layer sits at the top of the DAG (core ← api ← mcp ← tools) and
// is the only layer allowed to import from every layer below, so this module is
// where the frozen `ToolContext` is bound to the write-gate seam that the server
// bootstrap attaches per call. Vertical packages import these helpers instead of
// re-deriving the contract, so the `profile` argument, the plan/apply arguments
// and the shape of a preview / applied / diverged result are byte-identical
// across every package.
//
// Owned by the integrator (task I1). Vertical tasks consume it; they do not edit
// it — a change here is a cross-package contract change.

import { z } from 'zod';

import type {
  ApplyResult,
  PlanPreview,
  ToolContext,
  ToolResult,
  WriteTier,
} from '../core/index.js';
import { DEFAULT_PAGE_LIMIT } from '../api/shared.js';
import {
  shapeResult,
  type ShapeOptions,
  type WriteAction,
  type WriteGate,
} from '../mcp/index.js';

// ---------------------------------------------------------------------------
// 1. Shared input fields
// ---------------------------------------------------------------------------

/**
 * The optional profile selector every Page-scoped tool accepts (doc 06
 * cross-cutting). Omitted ⇒ the default Page resolved from `FB_PAGE_ID`.
 */
export const profileArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Page profile key (e.g. "brand-a") or a raw Page ID. Omitted ⇒ the default Page (FB_PAGE_ID).',
  );

/** Forward-only cursor argument for listing tools (CC-PAGE-2). */
export const afterArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Opaque forward cursor from a previous call's `nextCursor`. Omitted ⇒ start from the first page. Cursors expire; on an expiry note, restart the listing without this argument.",
  );

/** Page-size argument for listing tools; kept small to protect the char budget. */
export const limitArg = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe(
    `Maximum items to return in this page (1–100). Defaults to ${String(DEFAULT_PAGE_LIMIT)}. Large values risk truncation by the result budget.`,
  );

/**
 * The apply switch every write tool carries. `apply:true` is the only way to
 * REQUEST a mutation; whether omitting it yields a dry run is not this
 * argument's to promise. The server's effective write mode decides that, and
 * `moderation` ships `writeModeDefault: 'apply'` while `FB_WRITE_MODE=apply`
 * reaches every `reversible` tool — so "omitted ⇒ dry run" was true for most
 * deployments and false for the rest, which is the worst thing a model-facing
 * description can be. The text below states the guarantee that always holds and
 * points at the plan preview as the way to be certain. For `irreversible` and
 * `spend` tiers, and for plan-bound calls like publishing to a live audience,
 * this flag alone is never enough — a `plan_id` from a preceding preview is also
 * required and no write mode can substitute for it (C4).
 */
export const applyArg = z
  .boolean()
  .optional()
  .describe(
    'Set true to actually perform the write. Omitted or false ⇒ the server decides from its configured write mode: usually a dry run that returns a plan preview and changes nothing, but a server (or package) configured apply-first performs the write. To be certain nothing happens, read the result: a dry run always reports the plan and says the write was NOT performed.',
  );

/**
 * Binds an apply call to the preview that produced it. Required for the
 * `irreversible` and `spend` tiers; optional (but recommended) for the rest.
 */
export const planIdArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    'The `planId` returned by a preceding dry-run preview of this same tool. Required for irreversible and spend-tier writes; plans expire a few minutes after they are created.',
  );

/**
 * Carries the out-of-band operator token (`FB_CONFIRM_TOKEN`) for a single
 * `irreversible`/`spend` apply (B1). Only the two high-consequence tiers consult
 * it, so it is deliberately NOT part of {@link writeArgs} — advertising it on
 * every reversible write would invite the model to ask a human for the token
 * where no confirmation is required.
 *
 * It is the fallback route: with a client that supports MCP elicitation the
 * confirmation prompt is raised there instead and this argument is unnecessary.
 */
export const confirmTokenArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Out-of-band operator token (FB_CONFIRM_TOKEN) authorizing this one irreversible or spend-tier apply. Needed only when the MCP client cannot show a confirmation prompt. Ask the human operator for it; it is not stored between calls and is never echoed back.',
  );

/**
 * The three arguments shared by every write tool. Spread into an
 * `z.object({...})` alongside the tool's own fields:
 * `z.object({ ...writeArgs, message: z.string()... })`.
 */
export const writeArgs = {
  profile: profileArg,
  apply: applyArg,
  plan_id: planIdArg,
} as const;

/** {@link writeArgs} plus {@link confirmTokenArg}, for `irreversible`/`spend` tools. */
export const confirmableWriteArgs = {
  ...writeArgs,
  confirm_token: confirmTokenArg,
} as const;

/** The arguments shared by every cursor-paginated listing tool. */
export const listArgs = {
  profile: profileArg,
  limit: limitArg,
  after: afterArg,
} as const;

/** Narrow shape a write tool's parsed input satisfies once it spreads {@link writeArgs}. */
export interface WriteInput {
  readonly profile?: string;
  readonly apply?: boolean;
  readonly plan_id?: string;
  /** Present only on tools that spread {@link confirmableWriteArgs}. */
  readonly confirm_token?: string;
}

/** The subset of {@link WriteAction} that {@link gateArgs} projects from an input. */
export interface GateArgs {
  readonly apply?: boolean;
  readonly planId?: string;
  readonly confirmToken?: string;
}

/**
 * The gating fields of a parsed write input, renamed into the shape
 * {@link WriteAction} wants. Spread into the action literal — under
 * `exactOptionalPropertyTypes` an absent field must be absent, not `undefined`,
 * which is what the conditional spreads below achieve:
 *
 * ```ts
 * return executeWrite(ctx, { tool, tier, ...gateArgs(input), summary, perform });
 * ```
 */
export function gateArgs(input: WriteInput): GateArgs {
  return {
    ...(input.apply !== undefined ? { apply: input.apply } : {}),
    ...(input.plan_id !== undefined ? { planId: input.plan_id } : {}),
    ...(input.confirm_token !== undefined ? { confirmToken: input.confirm_token } : {}),
  };
}

// ---------------------------------------------------------------------------
// 2. The write-gate seam
// ---------------------------------------------------------------------------

/**
 * `ToolContext` plus the write gate. The frozen `ToolContext` deliberately does
 * not carry the gate (it lives in the `mcp` layer, which `core` may not import);
 * the server bootstrap attaches it to the per-call context object it builds, so
 * every write handler receives it at runtime. This interface is the typed view
 * of that fact — obtain it via {@link writeGateOf} rather than casting.
 */
export interface WriteToolContext extends ToolContext {
  readonly writeGate: WriteGate;
}

/** Thrown when a write tool runs on a context the bootstrap did not equip. */
export class MissingWriteGateError extends Error {
  override readonly name = 'MissingWriteGateError';

  constructor(tool: string) {
    super(
      `tool "${tool}" requires the write gate, but the tool context does not carry one — this is a server wiring bug`,
    );
  }
}

/**
 * Runtime-checked accessor for the write gate. Fails loudly and immediately
 * instead of letting a mis-wired context reach `perform()`.
 */
export function writeGateOf(ctx: ToolContext, tool: string): WriteGate {
  const candidate = (ctx as Partial<WriteToolContext>).writeGate;
  if (candidate === undefined || typeof candidate.execute !== 'function') {
    throw new MissingWriteGateError(tool);
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// 3. Result shaping
// ---------------------------------------------------------------------------

/** The shaper options carried by a context — spread or pass straight through. */
export function shapeOptionsOf(ctx: ToolContext): ShapeOptions {
  return { maxResultChars: ctx.settings.maxResultChars, redactor: ctx.redactor };
}

/** Shape an arbitrary read payload with the context's budget and redactor. */
export function shapeFor(ctx: ToolContext, payload: unknown): ToolResult {
  return shapeResult(payload, shapeOptionsOf(ctx));
}

/** The model-facing projection of a plan preview (the internal `Plan` never leaks). */
interface PreviewPayload {
  readonly status: 'preview';
  readonly applied: false;
  readonly planId: string;
  readonly tool: string;
  readonly tier: WriteTier;
  readonly summary: string;
  readonly warnings: readonly string[];
  readonly notPerformedNotice: string;
  readonly pageId?: string;
  readonly expiresAt: string;
  readonly nextStep: string;
}

function previewPayload(preview: PlanPreview): PreviewPayload {
  return {
    status: 'preview',
    applied: false,
    planId: preview.planId,
    tool: preview.tool,
    tier: preview.tier,
    summary: preview.summary,
    warnings: preview.warnings,
    notPerformedNotice: preview.notPerformedNotice,
    ...(preview.resolvedPage !== undefined
      ? { pageId: preview.resolvedPage.pageId }
      : {}),
    expiresAt: new Date(preview.expiresAt).toISOString(),
    nextStep: `To perform it, call ${preview.tool} again with the same arguments plus apply:true and plan_id:"${preview.planId}".`,
  };
}

function applyPayload<T>(tool: string, result: ApplyResult<T>): Record<string, unknown> {
  if (result.diverged !== undefined) {
    return {
      status: 'diverged',
      applied: false,
      tool,
      diverged: result.diverged,
      notPerformedNotice:
        'The remote state changed after the preview was taken, so nothing was written. Re-run the dry run to get a fresh plan.',
      ...(result.journalStatus !== undefined
        ? { journalStatus: result.journalStatus }
        : {}),
    };
  }
  return {
    status: 'applied',
    applied: result.applied,
    tool,
    ...(result.result !== undefined ? { result: result.result } : {}),
    ...(result.journalStatus !== undefined
      ? { journalStatus: result.journalStatus }
      : {}),
  };
}

/**
 * Run a write action through the gate and shape whatever comes back into the
 * uniform preview / applied / diverged envelope. This is the single call site
 * every write handler uses:
 *
 * ```ts
 * return executeWrite(ctx, {
 *   tool: 'facebook_delete_post', tier: 'irreversible', ...
 *   perform: async () => { ... },
 * });
 * ```
 */
export async function executeWrite<T>(
  ctx: ToolContext,
  action: WriteAction<T>,
): Promise<ToolResult> {
  const gate = writeGateOf(ctx, action.tool);
  const outcome = await gate.execute(action);
  const payload =
    outcome.kind === 'preview'
      ? previewPayload(outcome.preview)
      : applyPayload(action.tool, outcome.result);
  return shapeResult(payload, shapeOptionsOf(ctx));
}
