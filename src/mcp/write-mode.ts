// Tiered plan-and-apply write gate (task F13, `mcp` layer). This is the
// safety-critical core of the write path (C4 / Security #3).
//
// Every write flows through one gate with two modes:
//
//   * PLAN (validating dry-run) — captures an optional before-state, stores an
//     internal `Plan` keyed by a fresh `planId`, and returns a model-facing
//     `PlanPreview` with an explicit "NOT performed" anti-hallucination line.
//     ZERO network mutation happens: the caller's `perform` thunk is never
//     invoked in plan mode. (Reads via `readState` are allowed — a dry-run is a
//     *validating* preview, not a no-op.)
//   * APPLY — binds to a `plan_id`, re-validates (tool/tier/params still match,
//     the plan has not expired) and computes a `DivergenceDiff[]` against the
//     captured before-state. If the world changed since the preview it returns
//     `{ applied:false, diverged }` and does NOT mutate (fail-with-diff). Only
//     when the gate authorizes does `perform` run, with the journal written
//     around it.
//
// Tier gating (the invariant that makes this a control, Security #3):
//   `irreversible` (delete) and `spend` (ads) are NEVER satisfied by the
//   `FB_WRITE_MODE=apply` env default. They always require an explicit per-call
//   `apply:true` AND a `plan_id` from a prior plan step. `safe` / `reversible`
//   may honor the env default. This is enforced by the pure {@link authorize}
//   decision so it can be unit-tested exhaustively.
//
// The out-of-band confirmation gate (B1) plugs in here via the optional
// `confirmer` dependency: for `irreversible`/`spend` applies the gate consults it
// (MCP elicitation / operator-token — F15 supplies the actual `Confirmer`) and
// refuses the mutation if confirmation is denied. It is never bypassable by
// `FB_WRITE_MODE`.
//
// All time is read through the injected `Clock` (no `Date.now()`).

import { randomUUID } from 'node:crypto';
import type {
  ApplyResult,
  Clock,
  Confirmer,
  DivergenceDiff,
  Journal,
  JournalEntryInput,
  JournalOutcome,
  Plan,
  PlanId,
  PlanPreview,
  ResolvedPage,
  WriteMode,
  WriteTier,
} from '../core/index.js';

/** Default plan lifetime: short-lived so a stale preview cannot be applied later (C4). */
export const PLAN_TTL_MS = 5 * 60 * 1000;

/** Tiers whose blast radius forbids the `FB_WRITE_MODE=apply` env bypass (Security #3). */
const HIGH_CONSEQUENCE_TIERS: ReadonlySet<WriteTier> = new Set<WriteTier>([
  'irreversible',
  'spend',
]);

// ---------------------------------------------------------------------------
// Authorization decision (pure — the Security #3 heart of the gate)
// ---------------------------------------------------------------------------

/** Inputs to the pure {@link authorize} decision. */
export interface AuthorizeInput {
  readonly tier: WriteTier;
  /** The explicit per-call `apply` argument, if the caller supplied one. */
  readonly apply?: boolean;
  /** The bound `plan_id`, if the caller supplied one. */
  readonly planId?: PlanId;
  /** The effective env / per-package default write mode (`FB_WRITE_MODE`). */
  readonly defaultWriteMode: WriteMode;
}

/** Whether the gate runs a dry-run preview or performs the mutation. */
export type GateDecision =
  { readonly mode: 'plan'; readonly reason: string } | { readonly mode: 'apply' };

function hasPlanId(planId: PlanId | undefined): planId is PlanId {
  return planId !== undefined && planId !== '';
}

/**
 * Decide plan vs apply for a single write call.
 *
 * `irreversible` / `spend` are gated to plan mode unless BOTH an explicit
 * `apply:true` AND a `plan_id` are present — the env default is ignored for them
 * entirely (Security #3). `safe` / `reversible` may be applied by an explicit
 * `apply:true` OR by the env/per-package default. Anything unauthorized degrades
 * safely to a dry-run preview (fail-safe: never mutate on ambiguity).
 */
export function authorize(input: AuthorizeInput): GateDecision {
  const explicit = input.apply === true;

  if (HIGH_CONSEQUENCE_TIERS.has(input.tier)) {
    if (!explicit) {
      return {
        mode: 'plan',
        reason:
          `"${input.tier}" writes require an explicit per-call apply:true; ` +
          'FB_WRITE_MODE=apply never covers them',
      };
    }
    if (!hasPlanId(input.planId)) {
      return {
        mode: 'plan',
        reason: `"${input.tier}" writes must bind apply:true to a plan_id from a prior plan step`,
      };
    }
    return { mode: 'apply' };
  }

  if (explicit || input.defaultWriteMode === 'apply') {
    return { mode: 'apply' };
  }
  return {
    mode: 'plan',
    reason: 'plan mode (dry-run) — re-call with apply:true to perform',
  };
}

// ---------------------------------------------------------------------------
// Gate errors (integrity failures — distinct from the `diverged` data outcome)
// ---------------------------------------------------------------------------

export type WriteGateErrorCode =
  'plan_not_found' | 'plan_expired' | 'plan_mismatch' | 'confirmation_denied';

/**
 * A hard rejection of an apply call: the plan is missing/expired, the apply does
 * not match its plan, or out-of-band confirmation was denied. A well-behaved
 * agent never triggers these; the handler maps them to an error `ToolResult`.
 * (Divergence is NOT an error — it is the `{applied:false, diverged}` outcome.)
 */
export class WriteGateError extends Error {
  readonly code: WriteGateErrorCode;
  readonly tool: string;
  readonly tier: WriteTier;

  constructor(
    code: WriteGateErrorCode,
    message: string,
    ctx: { readonly tool: string; readonly tier: WriteTier },
  ) {
    super(message);
    this.name = 'WriteGateError';
    this.code = code;
    this.tool = ctx.tool;
    this.tier = ctx.tier;
    Object.setPrototypeOf(this, WriteGateError.prototype);
  }
}

// ---------------------------------------------------------------------------
// The action a tool handler hands to the gate
// ---------------------------------------------------------------------------

/**
 * Everything the gate needs to preview OR perform one write. The tool handler
 * builds this from its validated input and its capability context, then calls
 * {@link WriteGate.execute} once; the gate decides which branch to run.
 */
export interface WriteAction<T = unknown> {
  /** Tool name, e.g. `facebook_delete_post`. */
  readonly tool: string;
  readonly tier: WriteTier;
  readonly pageId?: string;
  /** The validated params this write is bound to (compared at apply time). */
  readonly params: Readonly<Record<string, unknown>>;

  // --- gating inputs (from the tool's `apply` / `plan_id` args) ---
  readonly apply?: boolean;
  readonly planId?: PlanId;

  // --- preview content (plan mode) ---
  readonly summary: string;
  readonly warnings?: readonly string[];
  readonly resolvedPage?: ResolvedPage;
  /** Overrides the generic anti-hallucination line (e.g. "The post was NOT published."). */
  readonly notPerformedNotice?: string;

  /**
   * Reads the current world state for divergence detection. Called in plan mode
   * to capture the before-state, and again at apply time to compare. A read, not
   * a mutation — safe in plan mode. Omit for create-style writes with no prior
   * state.
   */
  readonly readState?: () => Promise<unknown>;

  // --- apply mode ---
  /** Performs the actual Graph mutation. Invoked ONLY after the gate authorizes. */
  readonly perform: () => Promise<T>;
  /**
   * Classifies a `perform` failure for the journal. Return `'attempted'` when the
   * request reached the wire but the outcome is ambiguous (C2 / CC-LIFE-2);
   * default is `'failed'`.
   */
  readonly classifyOutcome?: (err: unknown) => Exclude<JournalOutcome, 'applied'>;
  /** Structured metadata for the journal entry (redacted; no tokens/PII). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** What {@link WriteGate.execute} returns: a dry-run preview or an apply result. */
export type WriteOutcome<T = unknown> =
  | { readonly kind: 'preview'; readonly preview: PlanPreview }
  | { readonly kind: 'result'; readonly result: ApplyResult<T> };

// ---------------------------------------------------------------------------
// Gate construction
// ---------------------------------------------------------------------------

/** Construction dependencies for {@link createWriteGate}. */
export interface WriteGateDeps {
  readonly clock: Clock;
  readonly journal: Journal;
  /** Effective default write mode (`FB_WRITE_MODE`, or a per-package override). */
  readonly defaultWriteMode: WriteMode;
  /**
   * Out-of-band confirmation seam (B1). When present, `irreversible`/`spend`
   * applies must be confirmed through it before the mutation runs. F15 supplies
   * the real `Confirmer` (elicitation / operator-token); the gate only consumes
   * the contract. Never bypassable by `FB_WRITE_MODE`.
   */
  readonly confirmer?: Confirmer;
  /** Plan lifetime in ms; default {@link PLAN_TTL_MS}. */
  readonly planTtlMs?: number;
  /** Mint a fresh plan id; default `crypto.randomUUID`. Injectable for tests. */
  readonly newPlanId?: () => PlanId;
}

export interface WriteGate {
  /** Preview or perform one write, per the tier/mode/plan gating. */
  execute<T = unknown>(action: WriteAction<T>): Promise<WriteOutcome<T>>;
}

function defaultNotPerformedNotice(tool: string): string {
  return `This was a dry run — no change was made. The "${tool}" action was NOT performed.`;
}

/** Create a write gate backed by an in-memory plan store (one server lifetime). */
export function createWriteGate(deps: WriteGateDeps): WriteGate {
  const plans = new Map<PlanId, Plan>();
  const ttlMs = deps.planTtlMs ?? PLAN_TTL_MS;
  const mintId = deps.newPlanId ?? ((): PlanId => randomUUID());

  function sweepExpired(now: number): void {
    for (const [id, plan] of plans) {
      if (plan.expiresAt <= now) plans.delete(id);
    }
  }

  function storePlan(action: WriteAction, beforeState: unknown): Plan {
    const now = deps.clock.now();
    const plan: Plan = {
      planId: mintId(),
      tool: action.tool,
      tier: action.tier,
      ...(action.pageId !== undefined ? { pageId: action.pageId } : {}),
      params: action.params,
      ...(beforeState !== undefined ? { beforeState } : {}),
      createdAt: now,
      expiresAt: now + ttlMs,
    };
    plans.set(plan.planId, plan);
    return plan;
  }

  function toJournalInput(
    action: WriteAction,
    outcome: JournalOutcome,
    error?: string,
  ): JournalEntryInput {
    return {
      tool: action.tool,
      tier: action.tier,
      ...(action.pageId !== undefined ? { pageId: action.pageId } : {}),
      ...(hasPlanId(action.planId) ? { planId: action.planId } : {}),
      outcome,
      summary: action.summary,
      ...(action.metadata !== undefined ? { metadata: action.metadata } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }

  async function runPlan(
    action: WriteAction,
    decision: Extract<GateDecision, { mode: 'plan' }>,
  ): Promise<WriteOutcome> {
    const beforeState = action.readState ? await action.readState() : undefined;
    sweepExpired(deps.clock.now());
    const plan = storePlan(action, beforeState);

    const warnings = [...(action.warnings ?? [])];
    // Surface why an explicit apply attempt was downgraded to a preview so the
    // agent learns what it still owes (e.g. "must bind a plan_id").
    if (action.apply === true) warnings.push(decision.reason);

    const preview: PlanPreview = {
      planId: plan.planId,
      tool: action.tool,
      tier: action.tier,
      summary: action.summary,
      warnings,
      notPerformedNotice:
        action.notPerformedNotice ?? defaultNotPerformedNotice(action.tool),
      ...(action.resolvedPage !== undefined ? { resolvedPage: action.resolvedPage } : {}),
      ...(beforeState !== undefined ? { beforeState } : {}),
      expiresAt: plan.expiresAt,
    };
    return { kind: 'preview', preview };
  }

  function resolvePlanForApply(action: WriteAction, now: number): Plan | undefined {
    if (!hasPlanId(action.planId)) return undefined;
    const plan = plans.get(action.planId);
    if (!plan) {
      throw new WriteGateError(
        'plan_not_found',
        'no such plan_id (expired or never created)',
        action,
      );
    }
    if (plan.expiresAt <= now) {
      plans.delete(action.planId);
      throw new WriteGateError(
        'plan_expired',
        'this plan_id has expired — re-run in plan mode',
        action,
      );
    }
    if (plan.tool !== action.tool || plan.tier !== action.tier) {
      throw new WriteGateError(
        'plan_mismatch',
        'plan_id was created for a different tool/tier',
        action,
      );
    }
    if (!deepEqual(plan.params, action.params)) {
      throw new WriteGateError(
        'plan_mismatch',
        'apply params differ from the planned params',
        action,
      );
    }
    return plan;
  }

  async function runApply(action: WriteAction): Promise<WriteOutcome> {
    const plan = resolvePlanForApply(action, deps.clock.now());

    // Divergence check: re-read the world and compare to the captured before-state.
    if (plan?.beforeState !== undefined && action.readState) {
      const current = await action.readState();
      const diverged = computeDivergence(plan.beforeState, current);
      if (diverged.length > 0) {
        plans.delete(plan.planId); // spent — the agent must re-plan against fresh state
        return { kind: 'result', result: { applied: false, diverged } };
      }
    }

    // Out-of-band confirmation gate for high-consequence tiers (B1 / F15 seam).
    if (HIGH_CONSEQUENCE_TIERS.has(action.tier) && deps.confirmer) {
      const response = await deps.confirmer.confirm({
        tool: action.tool,
        tier: action.tier,
        ...(hasPlanId(action.planId) ? { planId: action.planId } : {}),
        summary: action.summary,
        reason: `${action.tier} write requires out-of-band confirmation`,
      });
      if (!response.confirmed) {
        throw new WriteGateError(
          'confirmation_denied',
          `out-of-band confirmation denied (${response.method})`,
          action,
        );
      }
    }

    // Authorized: perform the mutation with the journal written around it.
    try {
      const result = await action.perform();
      const journalStatus = await deps.journal.append(toJournalInput(action, 'applied'));
      if (plan) plans.delete(plan.planId);
      return { kind: 'result', result: { applied: true, result, journalStatus } };
    } catch (err) {
      // Ambiguous outcome (socket written, response lost) is journaled as
      // `attempted` so an operator can reconcile — never silently dropped
      // (CC-LIFE-2). Flush before re-throwing.
      const outcome: JournalOutcome = action.classifyOutcome
        ? action.classifyOutcome(err)
        : 'failed';
      await deps.journal.append(
        toJournalInput(action, outcome, err instanceof Error ? err.message : String(err)),
      );
      if (plan) plans.delete(plan.planId);
      throw err;
    }
  }

  function runExecute(action: WriteAction): Promise<WriteOutcome> {
    const decision = authorize({
      tier: action.tier,
      ...(action.apply !== undefined ? { apply: action.apply } : {}),
      ...(hasPlanId(action.planId) ? { planId: action.planId } : {}),
      defaultWriteMode: deps.defaultWriteMode,
    });
    return decision.mode === 'plan' ? runPlan(action, decision) : runApply(action);
  }

  return {
    execute<T>(action: WriteAction<T>): Promise<WriteOutcome<T>> {
      return runExecute(action) as Promise<WriteOutcome<T>>;
    },
  };
}

// ---------------------------------------------------------------------------
// Divergence computation (C4 divergence semantics)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural equality over JSON-shaped values (objects, arrays, primitives). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length) return false;
    if (!aKeys.every((key, i) => key === bKeys[i])) return false;
    return aKeys.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

/**
 * Field-level divergence between the captured before-state and the current
 * state. Compares top-level fields of two objects; if either side is not a plain
 * object it reports a single whole-value `(state)` diff. Returns `[]` when equal.
 */
export function computeDivergence(expected: unknown, actual: unknown): DivergenceDiff[] {
  if (deepEqual(expected, actual)) return [];
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const fields = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    const diffs: DivergenceDiff[] = [];
    for (const field of fields) {
      if (!deepEqual(expected[field], actual[field])) {
        diffs.push({ field, expected: expected[field], actual: actual[field] });
      }
    }
    return diffs;
  }
  return [{ field: '(state)', expected, actual }];
}
