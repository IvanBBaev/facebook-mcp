// Write model (X08 split of `core/types.ts`): tiered plan-and-apply, the
// audit journal, the taint envelope and the out-of-band confirmation seam.

import type { ResolvedPage } from './graph.js';

// ---------------------------------------------------------------------------
// 9. Write gating — tiered plan-and-apply (C4, F13 implements)
// ---------------------------------------------------------------------------

/**
 * Blast-radius tier. `irreversible` (delete) and `spend` (ads) are NEVER covered
 * by the `FB_WRITE_MODE=apply` env bypass — they always require a per-call
 * `apply:true` (and the highest-consequence tools bind it to a `plan_id`).
 */
export type WriteTier = 'safe' | 'reversible' | 'irreversible' | 'spend';

/**
 * Effective write mode. `plan` returns a validating dry-run preview with zero
 * network mutations; `apply` performs the mutation (subject to per-tier gating).
 */
export type WriteMode = 'plan' | 'apply';

/** Short-lived opaque id binding an `apply` call to a specific preview (C4). */
export type PlanId = string;

/**
 * The stored plan record produced by a plan-mode call and consumed by the bound
 * apply call. Internal to the write-mode layer; the model sees {@link PlanPreview}.
 */
export interface Plan {
  readonly planId: PlanId;
  readonly tool: string;
  readonly tier: WriteTier;
  readonly pageId?: string;
  /** The validated params the apply is bound to. */
  readonly params: Readonly<Record<string, unknown>>;
  /** Captured before-state for update/delete divergence checks. */
  readonly beforeState?: unknown;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** Model-facing preview returned by a plan-mode (dry-run) write call. */
export interface PlanPreview {
  readonly planId: PlanId;
  readonly tool: string;
  readonly tier: WriteTier;
  /** Human summary of the intended action. */
  readonly summary: string;
  readonly warnings: readonly string[];
  /** Explicit anti-hallucination line, e.g. "The post was NOT published." (C4/UX). */
  readonly notPerformedNotice: string;
  readonly resolvedPage?: ResolvedPage;
  readonly beforeState?: unknown;
  readonly expiresAt: number;
}

/** One field-level divergence detected at apply time (C4 divergence semantics). */
export interface DivergenceDiff {
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

/**
 * Outcome envelope of an apply call. If `diverged` is present the state changed
 * since the preview and the mutation was NOT performed (fail-with-diff, C4).
 */
export interface ApplyResult<T = unknown> {
  readonly applied: boolean;
  readonly result?: T;
  readonly diverged?: readonly DivergenceDiff[];
  readonly journalStatus?: JournalStatus;
  /**
   * What the audit journal recorded for this apply, when the gate computed a
   * verdict. `applied:false` alone cannot tell a refusal (`failed`: nothing
   * changed at Graph) from an ambiguous write (`attempted`: the request reached
   * the wire and something may exist that an operator must reconcile), and the
   * caller-facing notice has to say which. Absent on a diverged apply.
   */
  readonly outcome?: JournalOutcome;
}

// ---------------------------------------------------------------------------
// 10. Journal — redaction-aware, rotation-aware write log (F13 implements)
// ---------------------------------------------------------------------------

export type JournalStatus = 'ok' | 'failed';

/**
 * `attempted` = the request reached the wire but the outcome is ambiguous
 * (C2 / CC-LIFE-2); recorded so an operator can reconcile.
 */
export type JournalOutcome = 'applied' | 'attempted' | 'failed';

/** Caller-supplied journal fields; the journal stamps `timestamp` itself. */
export interface JournalEntryInput {
  readonly tool: string;
  readonly tier: WriteTier;
  readonly pageId?: string;
  readonly planId?: PlanId;
  readonly outcome: JournalOutcome;
  readonly summary: string;
  /** Structured metadata ONLY — passed through the redactor (no tokens/PII). */
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

export interface JournalEntry extends JournalEntryInput {
  /** Epoch ms, stamped by the journal on append. */
  readonly timestamp: number;
}

/**
 * Append-only write journal. `append` is non-blocking and NEVER throws — a
 * journal failure returns `'failed'` so it cannot block the real write
 * (CC-LIFE-1). Implementations redact metadata and rotate at ~5 MB (0600).
 */
export interface Journal {
  append(entry: JournalEntryInput): Promise<JournalStatus>;
  /**
   * The entries still kept (the rotated generation, then the live file), oldest
   * first, as recorded — so already redacted. Optional: a journal that cannot be
   * read back leaves it out. Like `append` it NEVER throws: `'unreadable'` when
   * the journal exists but cannot be read. Lines that do not parse are skipped.
   */
  history?(): Promise<readonly JournalEntry[] | 'unreadable'>;
}

// ---------------------------------------------------------------------------
// 12. Taint (B1) — tainted UGC envelope + out-of-band confirmation seam
// ---------------------------------------------------------------------------

/** Origin of untrusted user-generated content. */
export type TaintSource =
  'comment' | 'message' | 'visitor_post' | 'user_profile' | 'unknown';

/**
 * Envelope wrapping attacker-controllable UGC (comments, DMs, visitor posts) so
 * it is clearly delimited and carries an injection warning before it enters the
 * model session (B1 / CC-MOD-8). The `__tainted` brand makes accidental
 * unwrapping detectable. F15 (`mcp/taint.ts`) implements the wrapper.
 */
export interface TaintedContent<T = string> {
  readonly __tainted: true;
  readonly source: TaintSource;
  /** The untrusted content itself. */
  readonly content: T;
  /** Injection warning shown alongside the content. */
  readonly warning: string;
}

/**
 * Request for out-of-band confirmation of a destructive/spend action (B1).
 *
 * This object is SENT TO THE CLIENT verbatim by the elicitation path, so it must
 * never carry a secret. The operator token travels as a separate argument to
 * {@link Confirmer.confirm}.
 */
export interface ConfirmationRequest {
  readonly tool: string;
  readonly tier: WriteTier;
  readonly planId?: PlanId;
  readonly summary: string;
  /** Why confirmation is required (e.g. "irreversible delete"). */
  readonly reason: string;
}

/** How the confirmation was obtained; the gate never silently downgrades (CC-MCP-6). */
export type ConfirmationMethod = 'elicitation' | 'operator_token' | 'denied';

export interface ConfirmationResponse {
  readonly confirmed: boolean;
  readonly method: ConfirmationMethod;
  readonly note?: string;
}

/**
 * Out-of-band confirmation seam: MCP elicitation where supported, operator-token
 * fallback otherwise, never bypassable by `FB_WRITE_MODE` (B1). F15
 * (`mcp/confirm.ts`) implements it.
 */
export interface Confirmer {
  /**
   * @param request What is being confirmed. Carries no secret — the elicitation
   *   path forwards it to the client.
   * @param operatorToken The token supplied with THIS call (the tool's
   *   `confirm_token` argument), passed separately from `request` for that
   *   reason, and passed explicitly rather than read from ambient state (C14).
   */
  confirm(
    request: ConfirmationRequest,
    operatorToken?: string,
  ): Promise<ConfirmationResponse>;
}
