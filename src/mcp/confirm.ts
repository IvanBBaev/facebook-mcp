// Out-of-band confirmation seam (task F15, `mcp` layer) — the B1 / CC-MCP-6 gate.
//
// Destructive and spend-tier writes must be confirmed OUT of the model session,
// because the model that would issue them may itself have read attacker
// controlled UGC (the confused-deputy scenario, B1). Plan-and-apply is an
// accident control run by that same model; this seam is the security control.
//
// Strict order, with NO silent downgrade to "just allow" (CC-MCP-6):
//   1. MCP elicitation, when the client supports it (injected `elicit` seam).
//   2. Operator-token fallback: the token supplied WITH the call (the gated
//      tools' `confirm_token` argument, threaded through the write gate)
//      compared, in constant time, against the configured `Settings.confirmToken`.
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
import { errorMessageOf } from '../core/index.js';
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
 * Fallback resolver for the operator-supplied token, used only when the caller
 * did not pass one to `confirm()` directly. The primary route is the per-call
 * `operatorToken` argument, which the write gate threads from the tool's
 * `confirm_token` input; this seam remains for a deployment that sources the
 * token some other way. Injected because request-scoped values are passed
 * explicitly, never read from ambient context (C14).
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
  /** Fallback token resolver; consulted only when `confirm()` got no per-call token. */
  readonly resolveOperatorToken?: OperatorTokenResolver;
}

/** Longest elicitation-supplied text carried back to the caller, either way. */
const MAX_ELICIT_TEXT_CHARS = 200;

/**
 * Flatten text to one line and cap it.
 *
 * Everything this seam echoes back — a failure reason, a human's note — ends up
 * in a tool result the MODEL reads, and every one of those strings arrives from
 * outside: a thrown message, or a JSON-RPC payload the client composed. Uncapped
 * and un-flattened, the confirmation channel becomes a way to push newlines and
 * kilobytes of attacker-chosen prose into the model's context — through the one
 * channel whose entire job is to be the trustworthy half of the conversation.
 * Neither string may carry a secret: the {@link ConfirmationRequest} holds none
 * (tool, tier, plan id, human summary) and no token is ever in scope here.
 */
function condense(raw: string): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_ELICIT_TEXT_CHARS
    ? `${oneLine.slice(0, MAX_ELICIT_TEXT_CHARS)}…`
    : oneLine;
}

/** One line describing why an advertised elicitation prompt did not complete. */
function describeElicitFailure(error: unknown): string {
  const text = condense(errorMessageOf(error));
  return `elicitation failed (${text.length > 0 ? text : 'no reason given'})`;
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

  /**
   * Why the token route was reached, when it was reached as a FALLBACK. Prefixed
   * onto the denial note so the caller can tell "the client has no elicitation"
   * from "the prompt was shown and blew up", which look identical otherwise.
   */
  function denialNote(reason: string, elicitFailure: string | undefined): string {
    return elicitFailure === undefined ? reason : `${elicitFailure}; ${reason}`;
  }

  async function viaOperatorToken(
    request: ConfirmationRequest,
    perCallToken: string | undefined,
    elicitFailure?: string,
  ): Promise<ConfirmationResponse> {
    const expected = settings.confirmToken;
    const hasExpected = typeof expected === 'string' && expected.length > 0;
    // The per-call token wins: it is the concrete authorization for THIS write,
    // whereas the resolver is a construction-time seam that may answer for a
    // different notion of "current call". Only a genuinely ABSENT argument falls
    // through — `??` would also fall through on `null` and `''`, and the write
    // gate threads this straight from a `confirm_token` a JSON-RPC caller wrote.
    // A caller who sends `"confirm_token": null` supplied no credential, and
    // must not thereby reach a resolver holding one that says yes: a wrong or
    // empty credential is a refusal, never an invitation to go looking for
    // another that might answer differently.
    const supplied =
      perCallToken === undefined ? await resolveOperatorToken?.(request) : perCallToken;
    const hasSupplied = typeof supplied === 'string' && supplied.length > 0;
    if (hasExpected && hasSupplied && constantTimeEqual(expected, supplied)) {
      return { confirmed: true, method: 'operator_token' };
    }
    // Three distinguishable failures, because the fix differs for each: configure
    // FB_CONFIRM_TOKEN / pass `confirm_token` on the call / pass the RIGHT one.
    // None of them names or echoes a token value.
    const reason = !hasExpected
      ? 'no operator token is configured (set FB_CONFIRM_TOKEN)'
      : hasSupplied
        ? 'the supplied confirm_token did not match'
        : 'no confirm_token was supplied with this call';
    return {
      confirmed: false,
      method: 'denied',
      note: denialNote(reason, elicitFailure),
    };
  }

  return {
    async confirm(
      request: ConfirmationRequest,
      operatorToken?: string,
    ): Promise<ConfirmationResponse> {
      if (elicit) {
        try {
          const outcome: ElicitOutcome | undefined = await elicit(request);
          // Narrow the WIRE value rather than trust its declared type. This
          // object was decoded from a JSON-RPC response the client composed, and
          // no type checker stands between that payload and this field: copying
          // it through means `"no"`, `"false"` and `{}` — all truthy — confirm a
          // delete or a budget raise downstream. Only an explicit boolean `true`
          // is a human saying yes; anything else, including a client that
          // answered with nothing at all, is not.
          const note =
            typeof outcome?.note === 'string' ? condense(outcome.note) : undefined;
          return {
            confirmed: outcome?.confirmed === true,
            method: 'elicitation',
            // An empty note is dropped rather than echoed: after flattening,
            // whitespace-only text carries nothing a caller can act on.
            ...(note !== undefined && note.length > 0 ? { note } : {}),
          };
        } catch (error) {
          // Elicitation was advertised but failed to complete. Do NOT claim an
          // elicitation result; fall through to the operator-token path, whose
          // method is reported truthfully (still never a silent "just allow").
          // The reason is carried forward so the denial does not misreport a
          // failed prompt as a client that never had elicitation at all.
          return viaOperatorToken(request, operatorToken, describeElicitFailure(error));
        }
      }
      return viaOperatorToken(request, operatorToken);
    },
  };
}
