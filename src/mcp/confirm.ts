// Out-of-band confirmation seam (task F15, `mcp` layer) — the B1 / CC-MCP-6 gate.
//
// Destructive and spend-tier writes must be confirmed OUT of the model session,
// because the model that would issue them may itself have read attacker
// controlled UGC (the confused-deputy scenario, B1). Plan-and-apply is an
// accident control run by that same model; this seam is the security control.
//
// Strict order, with NO silent downgrade to "just allow" (CC-MCP-6):
//   1. MCP elicitation, when the client supports it (injected `elicit` seam).
//   2. Operator-token fallback: an operator-supplied token compared, in
//      constant time, against the configured `Settings.confirmToken`.
//   3. Otherwise -> denied.
//
// The returned `method` ALWAYS reports truthfully how the decision was obtained
// (CC-MCP-6); it never claims a channel it did not use. The gate reads neither
// `writeMode` nor any env flag — there is no such input on its surface — so it
// is NOT bypassable by `FB_WRITE_MODE`.
//
// Elicitation is injected as a capability (not a live MCP session) so the gate
// is unit-testable; F13's write-gating and I1's bootstrap wire the real seam
// (see `createConfirmer` below).

import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  ConfirmationRequest,
  ConfirmationResponse,
  Confirmer,
  Settings,
} from '../core/index.js';

/** Outcome of a client-side MCP elicitation prompt. */
export interface ElicitOutcome {
  /** Did the human approve the action in the client's out-of-band prompt? */
  readonly confirmed: boolean;
  /** Optional human-supplied note, echoed back to the caller. */
  readonly note?: string;
}

/**
 * Injected MCP elicitation capability. Presence of this function means the
 * connected client supports elicitation; its ABSENCE is exactly CC-MCP-6 — the
 * gate then falls back to the operator token. Wired by I1 from the live MCP
 * session; faked in tests.
 */
export type ElicitCapability = (request: ConfirmationRequest) => Promise<ElicitOutcome>;

/**
 * Resolves the operator-supplied token authorizing THIS request (e.g. a
 * `confirm_token` tool argument). Injected because request-scoped values are
 * passed explicitly, never read from ambient context (C14). Returns `undefined`
 * when the caller supplied no token.
 */
export type OperatorTokenResolver = (
  request: ConfirmationRequest,
) => string | undefined | Promise<string | undefined>;

/** Dependencies wired into a Confirmer. All are injected, for testability. */
export interface ConfirmerDeps {
  /** Client elicitation capability; omit when the client lacks support (CC-MCP-6). */
  readonly elicit?: ElicitCapability;
  /** Settings carrying the configured operator token (`confirmToken`). */
  readonly settings: Pick<Settings, 'confirmToken'>;
  /** Resolves the operator-supplied token for the request; omit ⇒ never supplied. */
  readonly resolveOperatorToken?: OperatorTokenResolver;
}

/** Constant-time string equality over SHA-256 digests (length-safe). */
function constantTimeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

/**
 * Build a `Confirmer` (the F13/I1 seam). Wave-3 write-gating (F13) confirms
 * `irreversible`/`spend` writes through the returned gate; I1's bootstrap
 * constructs it, passing:
 *   - `elicit`: the live client's elicitation capability, or omitted when the
 *     client does not advertise elicitation (CC-MCP-6);
 *   - `settings`: the resolved settings (for `confirmToken`);
 *   - `resolveOperatorToken`: a resolver that reads the operator token from the
 *     current tool call's arguments.
 * The gate has no `writeMode`/env input, so it cannot be bypassed by
 * `FB_WRITE_MODE` (B1).
 */
export function createConfirmer(deps: ConfirmerDeps): Confirmer {
  const { elicit, settings, resolveOperatorToken } = deps;

  async function viaOperatorToken(
    request: ConfirmationRequest,
  ): Promise<ConfirmationResponse> {
    const expected = settings.confirmToken;
    const hasExpected = typeof expected === 'string' && expected.length > 0;
    const supplied = await resolveOperatorToken?.(request);
    if (
      hasExpected &&
      typeof supplied === 'string' &&
      supplied.length > 0 &&
      constantTimeEqual(expected, supplied)
    ) {
      return { confirmed: true, method: 'operator_token' };
    }
    return {
      confirmed: false,
      method: 'denied',
      note: hasExpected
        ? 'operator token did not match'
        : 'no elicitation support and no operator token configured',
    };
  }

  return {
    async confirm(request: ConfirmationRequest): Promise<ConfirmationResponse> {
      if (elicit) {
        try {
          const outcome = await elicit(request);
          return {
            confirmed: outcome.confirmed,
            method: 'elicitation',
            ...(outcome.note !== undefined ? { note: outcome.note } : {}),
          };
        } catch {
          // Elicitation was advertised but failed to complete. Do NOT claim an
          // elicitation result; fall through to the operator-token path, whose
          // method is reported truthfully (still never a silent "just allow").
          return viaOperatorToken(request);
        }
      }
      return viaOperatorToken(request);
    },
  };
}
