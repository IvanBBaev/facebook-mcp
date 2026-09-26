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

import {
  GraphApiError,
  type ApplyResult,
  type PlanPreview,
  type ToolContext,
  type ToolResult,
  type WriteTier,
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
 * Graph video/Reel IDs are bare decimal node IDs. Digits-only is both the true
 * shape and the strictest possible path containment for `/{videoId}/…` — no dot
 * segment, no slash, no percent-escape can survive it — and it rejects the one
 * mistake every video edge invites: handing it the `{page-id}_{post-id}`
 * composite, which addresses a POST and resolves on no video edge at all.
 */
export const VIDEO_ID_SHAPE = /^\d+$/;

/**
 * The one rejection message every `video_id` argument shares. It lives here
 * because the shape it describes is a property of Graph's ID space, not of any
 * single tool: two tools that disagree about which IDs are acceptable is how
 * `facebook_get_video_status` came to accept a composite that can never resolve.
 * Tool-specific follow-up prose is appended by {@link videoIdArg}; this sentence
 * is the part that stays identical everywhere, and the live
 * `reels/status-guardrail` smoke asserts its "VIDEO id" / "digits only" wording.
 */
export const VIDEO_ID_MESSAGE =
  'Expected the bare VIDEO id (digits only, e.g. "1234567890"), not a "{page-id}_{post-id}" post ID, a permalink or a URL.';

/** What {@link videoIdArg} needs from the tool that mounts the argument. */
export interface VideoIdArgOptions {
  /**
   * The model-facing `.describe()` prose for this tool — genuinely
   * tool-specific (which edge it reads, which tool minted the id).
   */
  readonly description: string;
  /**
   * Optional tool-specific sentence appended to {@link VIDEO_ID_MESSAGE} in the
   * rejection, naming where the caller can obtain a real video id.
   */
  readonly hint?: string;
}

/**
 * Build the `video_id` argument for one tool: one shape and one rejection
 * message for every video edge, with the prose left per-tool. `.trim()` runs
 * before the checks, so a pasted id with stray whitespace is accepted on its
 * digits rather than refused on its padding.
 */
export function videoIdArg(options: VideoIdArgOptions): z.ZodString {
  const message =
    options.hint === undefined ? VIDEO_ID_MESSAGE : `${VIDEO_ID_MESSAGE} ${options.hint}`;
  return z
    .string()
    .trim()
    .min(1)
    .regex(VIDEO_ID_SHAPE, message)
    .describe(options.description);
}

/**
 * The shape a Graph node ID must have before it is interpolated into an edge
 * path.
 *
 * This is PATH CONTAINMENT, not cosmetics. Every edge in this server is built by
 * interpolating a model-supplied id — `/{post_id}`, `/{comment_id}`,
 * `/{conversation_id}`, `/{object_id}/comments` — and `containPathname`
 * (`../core/http.ts`) receives the pathname ALREADY JOINED. It refuses dot
 * segments and percent-encodes each segment it can see, but it cannot tell an
 * interpolated id from a structural one, so a `/` inside an id silently becomes
 * a new segment: `post_id: "100200300/conversations"` reaches
 * `/v23.0/100200300/conversations` — the inbox — under the same Page token and
 * the same HTTP method as the write the tool advertised, and `"me/accounts"`
 * reaches the Page listing. `?`, `%` and whitespace are already contained
 * (encoded per segment) and `..` is already refused; `/` is the one character
 * that escapes, and this shape is where it is stopped.
 *
 * The class admits every id Graph actually mints: the `{page-id}_{post-id}`
 * composite, `t_1234567890` thread ids, bare numeric node ids and prefixed ones
 * such as `act_123`. The lookahead keeps a bare `"."` / `".."` out as well.
 * The reader tools' `POST_ID_SHAPE` (`./reader.ts`) is deliberately STRICTER —
 * digits or `{digits}_{digits}` only — because an always-on read with a free
 * `fields` list must not reach the Page node through its vanity username; this
 * shape still has to admit `t_…` thread ids and `act_…` ids.
 */
export const GRAPH_NODE_ID_SHAPE = /^(?=.*\w)[\w.-]+$/;

/**
 * The rejection message every path-bound id argument shares. Like
 * {@link VIDEO_ID_MESSAGE} it lives here because the shape it describes is a
 * property of Graph's ID space rather than of any single tool; per-tool prose is
 * appended by {@link graphNodeIdArg}.
 */
export const GRAPH_NODE_ID_MESSAGE =
  'Expected a bare Graph ID (letters, digits, "_", "-" and "." only, e.g. "111222333_999"), not a URL, a permalink, a query string or a path.';

/** What {@link graphNodeIdArg} needs from the tool that mounts the argument. */
export interface GraphNodeIdArgOptions {
  /**
   * The model-facing `.describe()` prose for this tool. Omitted for an array
   * ELEMENT schema, where the describing is done once on the array itself.
   */
  readonly description?: string;
  /**
   * Optional tool-specific sentence appended to {@link GRAPH_NODE_ID_MESSAGE},
   * naming where the caller can obtain a real id for this edge.
   */
  readonly hint?: string;
}

/**
 * Build a path-bound id argument: one shape and one rejection message for every
 * edge, with the prose left per-tool. `.trim()` runs before the checks, so a
 * pasted id is judged on its characters rather than on its padding.
 */
export function graphNodeIdArg(options: GraphNodeIdArgOptions = {}): z.ZodString {
  const message =
    options.hint === undefined
      ? GRAPH_NODE_ID_MESSAGE
      : `${GRAPH_NODE_ID_MESSAGE} ${options.hint}`;
  const arg = z.string().trim().min(1).regex(GRAPH_NODE_ID_SHAPE, message);
  return options.description === undefined ? arg : arg.describe(options.description);
}

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
 * Is this actually a gate? The whole point of the check is that the value did
 * NOT come through the type system — `ToolContext` does not declare `writeGate`,
 * so whatever the bootstrap attached is unverified at this seam.
 *
 * `null` is the shape that has to be named explicitly. Testing only for
 * `undefined` and then reaching for `.execute` turns the one mis-wiring that
 * writes an absence down as a value — `writeGate: lookup() ?? null`, a context
 * rebuilt from JSON, a JS consumer of the package barrel who meets no type
 * checker at all — into `TypeError: Cannot read properties of null (reading
 * 'execute')`. That names no tool, names no cause, and reads like a crash in the
 * write path rather than a server that was never wired, which is the exact
 * confusion {@link MissingWriteGateError} exists to prevent.
 */
function isWriteGate(value: unknown): value is WriteGate {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { execute?: unknown }).execute === 'function'
  );
}

/**
 * Runtime-checked accessor for the write gate. Fails loudly and immediately
 * instead of letting a mis-wired context reach `perform()`.
 */
export function writeGateOf(ctx: ToolContext, tool: string): WriteGate {
  const candidate: unknown = (ctx as Partial<WriteToolContext>).writeGate;
  if (!isWriteGate(candidate)) {
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

/**
 * The `not_applied` notice for a refusal — Graph answered "no" and nothing
 * changed. Also the wording for an `ApplyResult` that carries no `outcome`:
 * every classifier that predates `attempted` being reachable meant a refusal.
 */
const REFUSED_NOTICE =
  'The write was attempted and nothing landed. Read the per-item outcomes below for why; ' +
  'the audit journal records this as a failure, not as a change.';

/**
 * The `not_applied` notice for an ambiguous write. Telling the model "nothing
 * landed" here invites the retry that duplicates a video whose object already
 * exists (CC-PUB-1); the truth is that the journal holds an ATTEMPTED entry
 * an operator has to reconcile.
 */
const ATTEMPTED_NOTICE =
  'The request reached Facebook, but what it did is unconfirmed: the acknowledgement did not ' +
  'confirm the write, and an object may now exist that this call cannot vouch for. The audit ' +
  'journal records this as ATTEMPTED — not as a change, not as a failure. Verify the current ' +
  'state (the result below carries the ids to check) before retrying; a blind retry can ' +
  'create a duplicate.';

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
  // The journal's verdict, echoed so the caller and the audit trail agree; absent
  // only when the gate computed none (an older caller handing in the bare shape).
  const outcome = result.outcome !== undefined ? { outcome: result.outcome } : {};
  // `applied` is not always true on this path. A bulk verb reports per-id
  // outcomes instead of throwing (CC-MOD-5), so a batch in which every id failed
  // resolves normally and still changed nothing; the action says so through
  // `WriteAction.classifyResult`. Echoing a hardcoded `status:"applied"` beside
  // `applied:false` would hand the model two contradictory answers to the single
  // question this envelope exists to answer, and the contradictory one is the
  // one that reads first.
  //
  // `status` stays `not_applied` for every such verdict; what differs is the
  // notice, because `attempted` (something may exist — verify) and `failed`
  // (nothing does — fix and retry) call for opposite next moves.
  if (!result.applied) {
    return {
      status: 'not_applied',
      applied: false,
      ...outcome,
      tool,
      notPerformedNotice:
        result.outcome === 'attempted' ? ATTEMPTED_NOTICE : REFUSED_NOTICE,
      ...(result.result !== undefined ? { result: result.result } : {}),
      ...(result.journalStatus !== undefined
        ? { journalStatus: result.journalStatus }
        : {}),
    };
  }
  return {
    status: 'applied',
    applied: result.applied,
    ...outcome,
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

// ---------------------------------------------------------------------------
// 4. Graph error identity for package-local error envelopes
// ---------------------------------------------------------------------------

/**
 * Upper bound on each Meta-authored explanation (`userTitle` / `userMessage`)
 * carried by {@link graphErrorFields}. Meta's own sentences are short; the bound
 * only keeps a pathological body from dominating an error envelope.
 */
export const META_ERROR_TEXT_MAX = 500;

function boundMetaText(text: string): string {
  if (text.length <= META_ERROR_TEXT_MAX) return text;
  let head = text.slice(0, META_ERROR_TEXT_MAX - 1);
  // The slice counts UTF-16 units, so an astral character straddling the cut
  // leaves its high surrogate behind \u2014 half a character, which no decoder can
  // render. Drop it: the ellipsis already says the text goes on.
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return `${head}\u2026`;
}

/**
 * The Graph identity of a failure, for a package that catches an error and
 * shapes its own `isError` record instead of letting it reach the server's
 * error mapper: code, subcode, type, HTTP status, trace id, and Meta's own
 * human-readable refusal (`userTitle` / `userMessage`). On a publishing or ads
 * refusal `message` is usually the generic "Invalid parameter" and those two
 * fields are the only reason the model can act on; the trace id is what Meta
 * support asks for. A package record that omits them tells the caller less than
 * the server-level envelope would have.
 *
 * Returns `{}` for anything that is not a {@link GraphApiError}, so it can be
 * spread unconditionally. The Meta texts are length-bounded here and redacted
 * downstream by the shaper, like every other field.
 */
export function graphErrorFields(err: unknown): Record<string, unknown> {
  if (!(err instanceof GraphApiError)) return {};
  return {
    code: err.code,
    ...(err.subcode !== undefined ? { subcode: err.subcode } : {}),
    ...(err.type !== undefined ? { type: err.type } : {}),
    httpStatus: err.httpStatus,
    ...(err.fbtraceId !== undefined ? { fbtraceId: err.fbtraceId } : {}),
    ...(err.userTitle !== undefined ? { userTitle: boundMetaText(err.userTitle) } : {}),
    ...(err.userMessage !== undefined
      ? { userMessage: boundMetaText(err.userMessage) }
      : {}),
  };
}
