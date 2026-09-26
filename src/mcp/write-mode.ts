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
import { errorMessageOf, GraphApiError } from '../core/index.js';
import type {
  ApplyResult,
  Clock,
  Confirmer,
  DivergenceDiff,
  Journal,
  JournalEntryInput,
  JournalOutcome,
  JournalStatus,
  Plan,
  PlanId,
  PlanPreview,
  ResolvedPage,
  WriteMode,
  WriteTier,
} from '../core/index.js';

/** Default plan lifetime: short-lived so a stale preview cannot be applied later (C4). */
export const PLAN_TTL_MS = 5 * 60 * 1000;

/**
 * The ONLY tiers the `FB_WRITE_MODE=apply` env default may cover (Security #3).
 *
 * Stated as an allowlist rather than as its complement (`irreversible`/`spend`)
 * on purpose: the two spellings agree on every value in `WriteTier` and differ
 * on the one case neither the type system nor a shipped build controls — a tier
 * OUTSIDE the union. It arrives from a JS caller of the published `authorize` /
 * `createWriteGate`, and from a handler compiled against a newer union than the
 * gate it calls. As a denylist such a value reads as "not high-consequence", so
 * `FB_WRITE_MODE=apply` performs it on sight: no plan_id, no confirmer, unknown
 * blast radius. As an allowlist it lands on the guarded side, which is the only
 * defensible default for a consequence the gate cannot assess.
 */
const ENV_BYPASSABLE_TIERS: ReadonlySet<WriteTier> = new Set<WriteTier>([
  'safe',
  'reversible',
]);

/**
 * Whether a tier needs the full two-step gate (explicit `apply:true` bound to a
 * plan_id) plus out-of-band confirmation: `irreversible`, `spend`, and anything
 * this build does not recognise.
 */
function isHighConsequence(tier: WriteTier): boolean {
  return !ENV_BYPASSABLE_TIERS.has(tier);
}

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
  /**
   * Forces plan-id binding on a call whose tier alone would not demand it —
   * publishing to a live audience being the motivating case (doc 06): deleting the
   * post afterwards is easy, so the tier stays `reversible`, but the impressions it
   * collected in the meantime are not recallable, and one careless call should not
   * be able to reach an audience. Does NOT raise the tier, so the out-of-band
   * {@link Confirmer} stays reserved for `irreversible`/`spend`.
   */
  readonly requirePlanId?: boolean;
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
 * `irreversible` / `spend` — and any tier this build does not recognise — are
 * gated to plan mode unless BOTH an explicit `apply:true` AND a `plan_id` are
 * present; the env default is ignored for them entirely (Security #3). A call that sets {@link AuthorizeInput.requirePlanId}
 * opts into that same two-step gate without raising its tier. Every other
 * `safe` / `reversible` write may be applied by an explicit `apply:true` OR by the
 * env/per-package default. Anything unauthorized degrades safely to a dry-run
 * preview (fail-safe: never mutate on ambiguity).
 */
export function authorize(input: AuthorizeInput): GateDecision {
  const explicit = input.apply === true;
  const tierGated = isHighConsequence(input.tier);

  if (tierGated || input.requirePlanId === true) {
    const subject = tierGated ? `"${input.tier}" writes` : 'plan-bound calls';
    if (!explicit) {
      return {
        mode: 'plan',
        reason:
          `${subject} require an explicit per-call apply:true; ` +
          'FB_WRITE_MODE=apply never covers them',
      };
    }
    if (!hasPlanId(input.planId)) {
      return {
        mode: 'plan',
        reason: `${subject} must bind apply:true to a plan_id from a prior plan step`,
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
  | 'plan_not_found'
  | 'plan_expired'
  | 'plan_mismatch'
  | 'confirmation_denied'
  /**
   * The gate reached a high-consequence tier with no confirmation seam to reach.
   * Distinct from `confirmation_denied`: nothing declined the write, there was
   * nowhere to ask. The two must not be conflated — a denial is an answer the
   * operator gave, this is a broken install.
   */
  | 'confirmation_unavailable';

/**
 * The `plan_not_found` message for a plan another call is applying right now.
 * Exported so a tool's recovery hint can tell "wait for that result" apart from
 * "re-plan": re-planning an in-flight plan is the duplicate-write path.
 */
export const PLAN_IN_PROGRESS_MESSAGE =
  'this plan_id is in progress: another call is applying it and has not finished — wait for that result; re-planning now could perform the write twice';

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
 * What a resolved `perform` actually achieved, as judged by the action that ran
 * it. Two fields rather than one because they answer different questions:
 * `outcome` is what the audit trail records, `applied` is what the caller is
 * told — an ambiguous write is journaled `attempted` while still being reported
 * as unconfirmed.
 */
export interface WriteResultVerdict {
  readonly outcome: JournalOutcome;
  readonly applied: boolean;
}

/** The verdict for an action that does not classify its own result. */
export const APPLIED_VERDICT: WriteResultVerdict = Object.freeze({
  outcome: 'applied',
  applied: true,
});

/**
 * The verdict for a resolved write whose acknowledgement said "no": Graph
 * answered, the answer was a refusal, and nothing exists that did not before.
 * Journaled `failed`; the caller may fix the input and retry.
 */
export const REFUSED_VERDICT: WriteResultVerdict = Object.freeze({
  outcome: 'failed',
  applied: false,
});

/**
 * The verdict for a resolved write whose acknowledgement leaves the outcome
 * open: the request reached the wire and something may now exist at Graph
 * that the action cannot vouch for (a multi-phase upload whose `finish` was
 * declined after the object was created, for instance). Journaled `attempted`
 * so an operator can reconcile (C2 / CC-LIFE-2); the caller is told it is
 * unconfirmed, not failed — a blind retry can duplicate the write.
 */
export const ATTEMPTED_VERDICT: WriteResultVerdict = Object.freeze({
  outcome: 'attempted',
  applied: false,
});

/**
 * The values `JournalOutcome` admits, as a runtime set. The classifier hooks
 * below are injected seams and `createWriteGate` is exported from the package
 * barrel, so what they answer is data the gate validates, not a guarantee the
 * type system already made.
 */
const JOURNAL_OUTCOMES: ReadonlySet<string> = new Set<JournalOutcome>([
  'applied',
  'attempted',
  'failed',
]);

/** Whether a `classifyResult` answer is a verdict the gate can act on. */
function isWriteResultVerdict(value: unknown): value is WriteResultVerdict {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { readonly outcome?: unknown; readonly applied?: unknown };
  return (
    typeof candidate.applied === 'boolean' &&
    typeof candidate.outcome === 'string' &&
    JOURNAL_OUTCOMES.has(candidate.outcome)
  );
}

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
  /**
   * Demand plan-id binding for this one call even though its tier would not.
   * Set it per call, not per tool: `facebook_create_post` needs it when
   * `published:true` and not when the post is a draft or scheduled. See
   * {@link AuthorizeInput.requirePlanId} for why the tier stays as it is.
   */
  readonly requirePlanId?: boolean;
  /**
   * The operator token supplied with THIS call (the gated tools' `confirm_token`
   * argument). Handed to the {@link Confirmer} as a separate argument, never
   * folded into the `ConfirmationRequest` — that object is forwarded to the
   * client by the elicitation path, and a secret must not travel with it. Also
   * never journaled: {@link toJournalInput} takes only `params`/`metadata`, and
   * this is neither.
   */
  readonly confirmToken?: string;

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
  /**
   * Extra preview warnings derived from the before-state `readState` just
   * captured — for a caveat that only the read can reveal (a bulk snapshot in
   * which some ids could not be read, say). Called in plan mode only, after
   * {@link readState} and only when it returned a state; appended after
   * {@link warnings}. Omitted ⇒ no change.
   */
  readonly stateWarnings?: (beforeState: unknown) => readonly string[];

  // --- apply mode ---
  /** Performs the actual Graph mutation. Invoked ONLY after the gate authorizes. */
  readonly perform: () => Promise<T>;
  /**
   * Classifies a `perform` failure for the journal. Return `'attempted'` when the
   * request reached the wire but the outcome is ambiguous (C2 / CC-LIFE-2).
   * When omitted, a `GraphApiError` the http layer stamped `ambiguous` is journaled
   * `'attempted'` and anything else `'failed'`.
   */
  readonly classifyOutcome?: (err: unknown) => Exclude<JournalOutcome, 'applied'>;
  /**
   * The success-path counterpart of {@link classifyOutcome}. A `perform` that
   * RESOLVES is not evidence that anything changed: a bulk verb runs its ids one
   * at a time and returns its per-id outcome array normally even when every id
   * failed. The gate cannot see that — the result is opaque to it — so without
   * this hook it journals `applied` for a batch that mutated nothing, and the
   * journal is precisely what an operator reconciles a mutation against
   * (CC-LIFE-2). Omitted ⇒ {@link APPLIED_VERDICT}, so an action that does not
   * opt in behaves exactly as before.
   */
  readonly classifyResult?: (result: T) => WriteResultVerdict;
  /** Structured metadata for the journal entry (redacted; no tokens/PII). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** What {@link WriteGate.execute} returns: a dry-run preview or an apply result. */
export type WriteOutcome<T = unknown> =
  | { readonly kind: 'preview'; readonly preview: PlanPreview }
  | { readonly kind: 'result'; readonly result: ApplyResult<T> };

/**
 * The result-type-free face of a {@link WriteAction}: everything the gate stores,
 * validates and journals, minus the two members that mention `T`. Those two make
 * `WriteAction<T>` invariant in `T` under `strictFunctionTypes`, so the internal
 * helpers take this view instead and `T` stays confined to the apply path.
 */
type GateAction = Omit<WriteAction, 'perform' | 'classifyResult'>;

/**
 * The stored plan, plus the one field the shared {@link Plan} record does not
 * carry: the human-readable `summary` the preview showed.
 *
 * `params` is what the gate COMPARES; `summary` is what a PERSON reads — in the
 * out-of-band confirmation prompt, and afterwards in the journal an operator
 * reconciles a landed mutation against. Read off the apply call, that sentence
 * is authored by the same untrusted turn that is asking to be approved, and can
 * describe something other than the params it is attached to (a tool derives it
 * from state and arguments the plan never bound — an ad account's currency, for
 * one). Binding the machine-readable half of a write while letting its
 * human-readable half be rewritten between preview and apply is only half a
 * binding, so the plan keeps its own copy and the apply path uses that.
 *
 * Local to this module rather than added to `core`'s `Plan`: it is an internal
 * bookkeeping need of the gate, and `Plan` is a published type other packages
 * construct.
 */
interface StoredPlan extends Plan {
  readonly summary: string;
}

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
   * Out-of-band confirmation seam (B1). Every high-consequence apply —
   * `irreversible`, `spend`, and any tier this build does not recognise — must
   * be confirmed through it before the mutation runs. F15 supplies the real
   * `Confirmer` (elicitation / operator-token); the gate only consumes the
   * contract. Never bypassable by `FB_WRITE_MODE`.
   *
   * REQUIRED, and re-checked at runtime. This was optional, which quietly made
   * the control itself optional: a gate built without it ran `spend` and
   * `irreversible` writes on sight, with no plan id and nothing to ask. A
   * security control whose presence depends on the caller remembering to wire it
   * is not a control, and `createWriteGate` is exported from the package barrel
   * where a JS consumer meets no type checker at all.
   */
  readonly confirmer: Confirmer;
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
  const plans = new Map<PlanId, StoredPlan>();
  // Plans claimed by an apply that has not settled yet. A claimed plan is gone
  // from `plans`, but it is not spent: an apply that bails out before
  // `perform()` hands it back. A racing apply must hear that, not "expired".
  const inFlight = new Set<PlanId>();
  const ttlMs = deps.planTtlMs ?? PLAN_TTL_MS;
  const mintId = deps.newPlanId ?? ((): PlanId => randomUUID());

  function sweepExpired(now: number): void {
    for (const [id, plan] of plans) {
      if (plan.expiresAt <= now) plans.delete(id);
    }
  }

  function storePlan(action: GateAction, beforeState: unknown): StoredPlan {
    const now = deps.clock.now();
    const plan: StoredPlan = {
      planId: mintId(),
      tool: action.tool,
      tier: action.tier,
      ...(action.pageId !== undefined ? { pageId: action.pageId } : {}),
      // Pinned copies, not the caller's live objects — see `pinValue`.
      params: pinValue(action.params),
      summary: action.summary,
      ...(beforeState !== undefined ? { beforeState: pinValue(beforeState) } : {}),
      createdAt: now,
      expiresAt: now + ttlMs,
    };
    plans.set(plan.planId, plan);
    return plan;
  }

  /**
   * Append to the journal without letting a journal fault escape into the write
   * path. The {@link Journal} contract already says `append` returns `'failed'`
   * rather than rejecting, and the shipped implementation honours it — but the
   * journal is an INJECTED seam, and this is the one call site where a broken
   * one could turn a Graph mutation that already landed into a thrown error
   * (CC-LIFE-1).
   */
  async function journalQuietly(entry: JournalEntryInput): Promise<JournalStatus> {
    try {
      return await deps.journal.append(entry);
    } catch {
      return 'failed';
    }
  }

  /**
   * @param summary The sentence this write was APPROVED under — the plan's when
   *   the call was bound to one. The journal is what an operator reconciles a
   *   landed mutation against, so it has to record what was authorized, not
   *   what the apply call described itself as afterwards.
   */
  function toJournalInput(
    action: GateAction,
    summary: string,
    outcome: JournalOutcome,
    error?: string,
  ): JournalEntryInput {
    return {
      tool: action.tool,
      tier: action.tier,
      ...(action.pageId !== undefined ? { pageId: action.pageId } : {}),
      ...(hasPlanId(action.planId) ? { planId: action.planId } : {}),
      outcome,
      summary,
      ...(action.metadata !== undefined ? { metadata: action.metadata } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }

  async function runPlan(
    action: GateAction,
    decision: Extract<GateDecision, { mode: 'plan' }>,
  ): Promise<Extract<WriteOutcome<never>, { kind: 'preview' }>> {
    const beforeState = action.readState ? await action.readState() : undefined;
    sweepExpired(deps.clock.now());
    const plan = storePlan(action, beforeState);

    const warnings = [...(action.warnings ?? [])];
    if (beforeState !== undefined && action.stateWarnings) {
      warnings.push(...action.stateWarnings(beforeState));
    }
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

  /**
   * Validate the bound plan and CLAIM it: the plan is removed from the store in
   * the same synchronous turn that looked it up.
   *
   * Claiming here rather than after `perform()` is what makes the plan single-use
   * under concurrency. Everything the apply path does next awaits — the
   * divergence re-read, the out-of-band confirmation, the mutation itself — and
   * an MCP client may have several `tools/call` requests in flight at once. With
   * the claim at the end, two applies carrying the same `plan_id` would both find
   * the plan present, both pass the gate and both perform: one authorization,
   * two mutations (two posts, two messages, two budget changes). The loser of
   * the race now gets `plan_not_found`, which is the fail-safe answer.
   *
   * A caller that bails out BEFORE `perform()` returns the claim — see
   * {@link runApply}.
   */
  function claimPlanForApply(action: GateAction, now: number): StoredPlan | undefined {
    if (!hasPlanId(action.planId)) return undefined;
    const plan = plans.get(action.planId);
    if (!plan) {
      // A plan another call is applying right now is neither expired nor
      // (yet) applied, and it comes back if that call is refused before the
      // write. Telling the caller it is gone sends it to re-plan and apply
      // again — a second mutation racing the first. Same code, true reason.
      if (inFlight.has(action.planId)) {
        throw new WriteGateError('plan_not_found', PLAN_IN_PROGRESS_MESSAGE, action);
      }
      throw new WriteGateError(
        'plan_not_found',
        'no such plan_id (expired, already applied, or never created)',
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
    // The Page is bound identity, not a parameter. `params` carries the payload
    // only (message, link, budget…), and `profile` is a per-call argument the
    // model chooses, so without this check a preview approved for one Page could
    // be applied byte-identically to another: same tool, same tier, same params,
    // different audience. That is precisely the cross-talk `plan_id` binding
    // exists to prevent (C4).
    if (plan.pageId !== action.pageId) {
      throw new WriteGateError(
        'plan_mismatch',
        'plan_id was created for a different Page',
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
    // The two calls must agree on WHETHER this write is divergence-checked. The
    // check in `runApply` runs only when both the plan holds a before-state and
    // the apply call can re-read the world; a caller that simply omits
    // `readState` on the second call keeps the plan, keeps the params, and
    // silently loses the check the preview promised — the mutation then lands on
    // a world nobody re-compared, which for a delete or a budget change is the
    // whole hazard. An apply that cannot re-read is not the apply this plan
    // previewed, so it is a mismatch rather than a licence to skip. Checked
    // BEFORE the claim, so a malformed apply cannot spend a good plan.
    if (plan.beforeState !== undefined && !action.readState) {
      throw new WriteGateError(
        'plan_mismatch',
        'this plan captured a before-state, so the apply call must be able to re-read it',
        action,
      );
    }
    plans.delete(plan.planId);
    return plan;
  }

  async function runApply<T>(action: WriteAction<T>): Promise<WriteOutcome<T>> {
    const plan = claimPlanForApply(action, deps.clock.now());
    if (!plan) return applyClaimed(action, plan);
    inFlight.add(plan.planId);
    try {
      return await applyClaimed(action, plan);
    } finally {
      inFlight.delete(plan.planId);
    }
  }

  async function applyClaimed<T>(
    action: WriteAction<T>,
    plan: StoredPlan | undefined,
  ): Promise<WriteOutcome<T>> {
    // The sentence a human is asked to approve, and the one the audit trail
    // keeps. It comes from the PLAN whenever this apply is bound to one; only an
    // unbound low-tier apply — where the call IS the whole authorization — has
    // nothing but its own text to go on. See {@link StoredPlan}.
    const approvedSummary = plan?.summary ?? action.summary;

    // Pre-authorization section. The plan is already claimed, so anything that
    // throws here must hand the claim back: a denied confirmation or a failed
    // re-read is a condition the agent can retry against the SAME preview, and
    // burning the plan would force a pointless re-plan. Divergence is the one
    // exception — it returns rather than throws, and the plan stays spent
    // because the world it was approved against no longer exists.
    try {
      // Divergence check: re-read the world and compare to the captured before-state.
      if (plan?.beforeState !== undefined && action.readState) {
        const current = await action.readState();
        const diverged = computeDivergence(plan.beforeState, current);
        if (diverged.length > 0) {
          return { kind: 'result', result: { applied: false, diverged } };
        }
      }

      // Out-of-band confirmation gate for high-consequence tiers (B1 / F15 seam).
      if (isHighConsequence(action.tier)) {
        // A missing seam is unreachable through the types, so getting here means
        // an untyped caller. Refusing is the only safe reading: performing the
        // write would be the gate deciding, on its own, that a tier requiring
        // confirmation does not require confirmation today.
        if (!deps.confirmer) {
          throw new WriteGateError(
            'confirmation_unavailable',
            `no out-of-band confirmation seam is configured, and a ${action.tier} write cannot proceed without one`,
            action,
          );
        }
        const response = await deps.confirmer.confirm(
          {
            tool: action.tool,
            tier: action.tier,
            ...(hasPlanId(action.planId) ? { planId: action.planId } : {}),
            summary: approvedSummary,
            reason: `${action.tier} write requires out-of-band confirmation`,
          },
          action.confirmToken,
        );
        // Nothing but an explicit `true` is a yes. `Confirmer` is an injected
        // seam and `createWriteGate` is exported from the package barrel, so the
        // object answering here need never have met a type checker; the real one
        // builds its answer out of a JSON-RPC payload a client sent. Under a
        // truthiness test the strings `'no'`, `'false'` and `'denied'`, and a
        // bare `{}`, all authorize a delete or a budget raise. A confirmation is
        // the one answer in this server that must be read at its narrowest.
        if (response?.confirmed !== true) {
          // Carry the confirmer's note: without it a declined prompt, an unticked
          // box, a missing `confirm_token` and a wrong one are one indistinguishable
          // failure, and the model cannot tell which of them it can act on.
          throw new WriteGateError(
            'confirmation_denied',
            `out-of-band confirmation denied (${response?.method ?? 'no answer'})` +
              (typeof response?.note === 'string' ? `: ${response.note}` : ''),
            action,
          );
        }
        // Re-compare AFTER the confirmation, too. It is the one await on this
        // path that waits on a human — an elicitation prompt can sit open for
        // minutes — so the comparison above only proves the world matched when
        // the prompt was RAISED. An approval given for the previewed world must
        // not be spent on one that moved while the operator was reading it: a
        // comment edited, a budget changed by another tool. The earlier check
        // stays so a human is never asked to approve a plan already stale.
        if (plan?.beforeState !== undefined && action.readState) {
          const current = await action.readState();
          const diverged = computeDivergence(plan.beforeState, current);
          if (diverged.length > 0) {
            return { kind: 'result', result: { applied: false, diverged } };
          }
        }
      }
    } catch (err) {
      if (plan) plans.set(plan.planId, plan);
      throw err;
    }

    // Authorized: perform the mutation with the journal written around it. The
    // plan is NOT returned past this line whatever happens — once `perform` has
    // been entered the authorization is spent, including on an ambiguous
    // outcome, where a retry could duplicate a mutation that already landed.
    //
    // ONLY `perform` sits inside the failure-classifying try. Everything after
    // it is bookkeeping about a mutation that is already at Graph, and
    // bookkeeping must never be able to restate a landed write as a failure.
    let result: T;
    try {
      result = await action.perform();
    } catch (err) {
      // Ambiguous outcome (socket written, response lost) is journaled as
      // `attempted` so an operator can reconcile — never silently dropped
      // (CC-LIFE-2). Flush before re-throwing, and re-throw the GRAPH error:
      // it is the one that says whether the write landed, so a journal that is
      // itself broken must not become the cause the operator sees.
      // With no hook of its own, the action still inherits what the transport
      // already decided: the http layer stamps `ambiguous` on a 5xx or a
      // mid-flight network fault on a write (C2), and a `failed` entry for one
      // would assert that a mutation which may have landed did not.
      let outcome: JournalOutcome = isTransportAmbiguous(err) ? 'attempted' : 'failed';
      if (action.classifyOutcome) {
        try {
          const classified: unknown = action.classifyOutcome(err);
          // `perform` REJECTED and the gate is about to re-throw, so `applied`
          // is not a fact this branch can record however the hook answers it;
          // an unrecognised value is not a claim that nothing happened either.
          // Both collapse to the ambiguity the throwing classifier is given.
          outcome =
            classified === 'failed' || classified === 'attempted'
              ? classified
              : 'attempted';
        } catch {
          // A classifier that blew up did not tell us the write did NOT land,
          // so the entry records the ambiguity rather than asserting the
          // comfortable-sounding `failed`.
          outcome = 'attempted';
        }
      }
      await journalQuietly(
        toJournalInput(action, approvedSummary, outcome, errorMessageOf(err)),
      );
      throw err;
    }

    // `perform` RESOLVED: the mutation is at Graph. Nothing below may throw.
    // A thrown error here tells the model the write failed; its obvious next
    // move is to retry, and since the plan is spent it re-plans and applies
    // again — one authorization, two mutations. `ApplyResult.journalStatus`
    // exists to carry a bookkeeping failure as a fact about the RECORD instead
    // (CC-LIFE-1), which is what the caller can actually act on.
    //
    // Resolving is not the same as changing something, so the action gets the
    // last word on what it did; the default keeps the historical
    // "resolved ⇒ applied" for every action that has no opinion.
    let verdict: WriteResultVerdict = APPLIED_VERDICT;
    let verdictError: string | undefined;
    if (action.classifyResult) {
      try {
        const classified: unknown = action.classifyResult(result);
        if (isWriteResultVerdict(classified)) {
          verdict = classified;
        } else {
          // Same bug as a hook that threw, in its commoner shape: a branch that
          // falls off the end, or a JS caller of the barrel-exported gate.
          // Reading `.outcome` off that answer throws HERE, below the line that
          // says nothing may throw, and the caller is told a landed write
          // failed while no entry is written at all.
          verdictError = `result classification returned no usable verdict (${
            classified === null ? 'null' : typeof classified
          })`;
        }
      } catch (err) {
        // The hook reads a response shape it did not build, so it can throw on
        // a payload Graph shaped differently today. That is a bug in the
        // verdict, not evidence the mutation did not happen: keep the default
        // and let the entry admit the verdict was never computed.
        verdictError = `result classification failed: ${errorMessageOf(err)}`;
      }
    }
    const journalStatus = await journalQuietly(
      toJournalInput(action, approvedSummary, verdict.outcome, verdictError),
    );
    // The outcome travels with the result, not only into the journal: on
    // `applied:false` it is the one fact that separates a refusal (fix and
    // retry) from an ambiguous write (verify first — a retry can duplicate it).
    return {
      kind: 'result',
      result: {
        applied: verdict.applied,
        outcome: verdict.outcome,
        result,
        journalStatus,
      },
    };
  }

  function runExecute<T>(action: WriteAction<T>): Promise<WriteOutcome<T>> {
    const decision = authorize({
      tier: action.tier,
      ...(action.apply !== undefined ? { apply: action.apply } : {}),
      ...(hasPlanId(action.planId) ? { planId: action.planId } : {}),
      ...(action.requirePlanId !== undefined
        ? { requirePlanId: action.requirePlanId }
        : {}),
      defaultWriteMode: deps.defaultWriteMode,
    });
    return decision.mode === 'plan' ? runPlan(action, decision) : runApply(action);
  }

  return {
    execute<T>(action: WriteAction<T>): Promise<WriteOutcome<T>> {
      return runExecute(action);
    },
  };
}

/**
 * Whether the http layer classified this failure as an ambiguous write — the
 * request reached the wire and the mutation may have landed (C2). The default
 * journal outcome for an action that supplies no `classifyOutcome`.
 */
function isTransportAmbiguous(err: unknown): boolean {
  return err instanceof GraphApiError && err.action?.category === 'ambiguous';
}

// ---------------------------------------------------------------------------
// Divergence computation (C4 divergence semantics)
// ---------------------------------------------------------------------------

/**
 * Is this a PLAIN object — an object literal or a `JSON.parse` result — rather
 * than merely something `typeof` calls an object?
 *
 * The prototype check is the whole point of this function. `typeof x ===
 * 'object'` is equally true of a Date, a Buffer, a Map, a Set and every class
 * instance, and not one of those carries its contents in its own enumerable
 * keys — `Object.entries(new Date())` is `[]`. Counted as plain, they flow into
 * {@link pinValue}, which snapshots each of them as `{}`, and then into
 * {@link deepEqual}, which duly finds ANY two of them equal. A plan previewed
 * with one Date, Buffer or instance in its params would apply with a different
 * one in that slot: same plan_id, same summary, same confirmation, a write
 * nobody previewed. That is the precise cross-binding `plan_id` exists to make
 * impossible, so anything not provably plain is treated as opaque and compared
 * by identity — which is what {@link pinValue} and {@link deepEqual} already
 * document as their contract.
 *
 * A plain object built in another realm (`vm`, a worker) has a different
 * `Object.prototype` and reads as opaque here. Nothing in this server produces
 * one; if something ever does, the failure is a `plan_mismatch` on a write that
 * should have matched, which is the direction a gate is allowed to be wrong in.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  // `null` is `Object.create(null)` — a bare dictionary with no inherited keys,
  // still a plain bag of data (a `JSON.parse` reviver can hand one back).
  return proto === Object.prototype || proto === null;
}

/**
 * Define a key on the pinned copy. `JSON.parse` creates `__proto__` as an OWN
 * enumerable property, so a raw tool payload or a Graph node walked by
 * {@link Object.entries} hands it straight here — where a plain assignment runs
 * the inherited setter instead of storing a field. A string value is swallowed
 * (the key vanishes from the fingerprint, and an apply that omits it compares
 * equal); an object value re-parents the copy, so {@link isPlainObject} reports
 * false and {@link deepEqual} refuses to walk it at all. Either way the snapshot
 * stops matching what was previewed. Mirrors `setOwn` in `src/mcp/result.ts`.
 */
function setOwn(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(out, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return;
  }
  out[key] = value;
}

/**
 * Deep-copy the plain-object/array spine of a value; share everything else.
 *
 * A stored {@link Plan} is the gate's fingerprint of what was previewed, and its
 * `params` / `beforeState` arrive as objects the CALLER still holds a live
 * reference to — a handler's own action object, or params it shares across the
 * two `tools/call` requests. Kept by reference, the fingerprint mutates with
 * them: the apply-time `deepEqual(plan.params, action.params)` then compares an
 * object with itself, matches unconditionally, and the gate performs a write
 * nobody previewed — under the previewed summary, with the plan_id binding
 * asserting the two matched.
 *
 * The copy covers exactly the spine {@link deepEqual} traverses, so the snapshot
 * and the comparison stay in step. Anything the comparison treats as opaque
 * (Date, Buffer, a class instance) is shared, since copying it could not
 * preserve the identity `deepEqual` compares it by.
 */
function pinValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => pinValue(item)) as T;
  }
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      setOwn(copy, key, pinValue(item));
    }
    return copy as T;
  }
  return value;
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
