import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConfirmationRequest } from '../core/index.js';
import {
  createConfirmer,
  type ElicitCapability,
  type ElicitOutcome,
  type OperatorTokenResolver,
} from './confirm.js';

const REQUEST: ConfirmationRequest = {
  tool: 'facebook_delete_comment',
  tier: 'irreversible',
  summary: 'Delete comment 123 on post 456',
  reason: 'irreversible delete',
};

// Placeholder operator token — never a real secret.
const OPERATOR_TOKEN = 'operator-token-PLACEHOLDER';

/** An elicit seam that records its calls and returns a fixed outcome. */
function fakeElicit(outcome: ElicitOutcome): {
  elicit: ElicitCapability;
  calls: ConfirmationRequest[];
} {
  const calls: ConfirmationRequest[] = [];
  return {
    calls,
    elicit: (req) => {
      calls.push(req);
      return Promise.resolve(outcome);
    },
  };
}

/** A token resolver that records whether it was consulted. */
function spyResolver(value: string | undefined): {
  resolveOperatorToken: OperatorTokenResolver;
  calls: number;
} {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    resolveOperatorToken: () => {
      state.calls += 1;
      return value;
    },
  };
}

test('elicitation success -> confirmed via method "elicitation" (CC-MCP-6)', async () => {
  const { elicit, calls } = fakeElicit({ confirmed: true, note: 'approved' });
  const gate = createConfirmer({ elicit, settings: {} });

  const res = await gate.confirm(REQUEST);

  assert.deepEqual(res, {
    confirmed: true,
    method: 'elicitation',
    note: 'approved',
  });
  assert.equal(calls.length, 1);
});

test('elicitation decline is reported as "elicitation", NOT escalated to token', async () => {
  const { elicit } = fakeElicit({ confirmed: false });
  const resolver = spyResolver(OPERATOR_TOKEN);
  const gate = createConfirmer({
    elicit,
    settings: { confirmToken: OPERATOR_TOKEN },
    resolveOperatorToken: resolver.resolveOperatorToken,
  });

  const res = await gate.confirm(REQUEST);

  // A human said no out-of-band; the gate must honour that truthfully...
  assert.equal(res.confirmed, false);
  assert.equal(res.method, 'elicitation');
  // ...and must NOT fall through to the operator token to override the decline.
  assert.equal(resolver.calls, 0);
});

test('no elicitation + matching operator token -> method "operator_token" (CC-MCP-6)', async () => {
  const resolver = spyResolver(OPERATOR_TOKEN);
  const gate = createConfirmer({
    settings: { confirmToken: OPERATOR_TOKEN },
    resolveOperatorToken: resolver.resolveOperatorToken,
  });

  const res = await gate.confirm(REQUEST);

  assert.equal(res.confirmed, true);
  assert.equal(res.method, 'operator_token');
  assert.equal(resolver.calls, 1);
});

test('no elicitation + wrong operator token -> denied', async () => {
  const gate = createConfirmer({
    settings: { confirmToken: OPERATOR_TOKEN },
    resolveOperatorToken: () => 'wrong-token-PLACEHOLDER',
  });

  const res = await gate.confirm(REQUEST);

  assert.equal(res.confirmed, false);
  assert.equal(res.method, 'denied');
});

test('no elicitation + no supplied token -> denied', async () => {
  const gate = createConfirmer({
    settings: { confirmToken: OPERATOR_TOKEN },
    resolveOperatorToken: () => undefined,
  });

  const res = await gate.confirm(REQUEST);
  assert.equal(res.confirmed, false);
  assert.equal(res.method, 'denied');
});

test('no elicitation + no configured token -> denied (fail closed)', async () => {
  const gate = createConfirmer({
    settings: {},
    resolveOperatorToken: () => OPERATOR_TOKEN,
  });

  const res = await gate.confirm(REQUEST);
  assert.equal(res.confirmed, false);
  assert.equal(res.method, 'denied');
});

test('never reports a method it did not use: token path never claims elicitation', async () => {
  // Elicitation is present but the client-side prompt throws mid-flight.
  let elicitCalls = 0;
  const throwingElicit: ElicitCapability = () => {
    elicitCalls += 1;
    return Promise.reject(new Error('client closed the elicitation channel'));
  };

  const gate = createConfirmer({
    elicit: throwingElicit,
    settings: { confirmToken: OPERATOR_TOKEN },
    resolveOperatorToken: () => OPERATOR_TOKEN,
  });

  const res = await gate.confirm(REQUEST);

  // Elicitation failed, so the gate must not claim it; it truthfully falls back.
  assert.equal(res.method, 'operator_token');
  assert.equal(res.confirmed, true);
  assert.equal(elicitCalls, 1);
});

test('elicitation failure with no token -> denied, never a silent allow', async () => {
  const gate = createConfirmer({
    elicit: () => Promise.reject(new Error('no client')),
    settings: {},
  });

  const res = await gate.confirm(REQUEST);
  assert.equal(res.confirmed, false);
  assert.equal(res.method, 'denied');
});

// --- per-call operator token (D12) -----------------------------------------

test('a matching per-call operator token confirms without consulting the resolver (D12)', async () => {
  const resolver = spyResolver('resolver-token-PLACEHOLDER');
  const gate = createConfirmer({
    settings: { confirmToken: OPERATOR_TOKEN },
    resolveOperatorToken: resolver.resolveOperatorToken,
  });

  const res = await gate.confirm(REQUEST, OPERATOR_TOKEN);

  assert.equal(res.confirmed, true);
  assert.equal(res.method, 'operator_token');
  // The token that came WITH the call is the authorization for this write; the
  // construction-time resolver is a fallback and must stay untouched.
  assert.equal(resolver.calls, 0);
});

test('a wrong per-call token is denied and never falls back to the resolver (D12)', async () => {
  const resolver = spyResolver(OPERATOR_TOKEN);
  const gate = createConfirmer({
    settings: { confirmToken: OPERATOR_TOKEN },
    resolveOperatorToken: resolver.resolveOperatorToken,
  });

  const res = await gate.confirm(REQUEST, 'wrong-token-PLACEHOLDER');

  assert.equal(res.confirmed, false);
  assert.equal(res.method, 'denied');
  assert.equal(res.note, 'the supplied confirm_token did not match');
  // `??` short-circuits on ANY defined value, and that is the security property:
  // a caller-supplied wrong token is a refusal, not an invitation to go looking
  // for another credential that might say yes.
  assert.equal(resolver.calls, 0);
});

test('with no per-call token the resolver is still the fallback route (D12)', async () => {
  const resolver = spyResolver(OPERATOR_TOKEN);
  const gate = createConfirmer({
    settings: { confirmToken: OPERATOR_TOKEN },
    resolveOperatorToken: resolver.resolveOperatorToken,
  });

  const res = await gate.confirm(REQUEST, undefined);

  assert.equal(res.confirmed, true);
  assert.equal(res.method, 'operator_token');
  assert.equal(resolver.calls, 1);
});

test('elicitation failure + matching per-call token -> "operator_token", never "elicitation" (D12)', async () => {
  const gate = createConfirmer({
    elicit: () => Promise.reject(new Error('client closed the elicitation channel')),
    settings: { confirmToken: OPERATOR_TOKEN },
  });

  const res = await gate.confirm(REQUEST, OPERATOR_TOKEN);

  assert.equal(res.confirmed, true);
  // The elicitation channel was advertised but never produced a decision, so the
  // gate must report the channel it actually used.
  assert.equal(res.method, 'operator_token');
});

test('elicitation failure + per-call token but no configured token -> denied (D12)', async () => {
  const gate = createConfirmer({
    elicit: () => Promise.reject(new Error('no client')),
    settings: {},
  });

  const res = await gate.confirm(REQUEST, OPERATOR_TOKEN);

  // Nothing to compare against: a caller-supplied token can never authorize
  // itself, so the gate fails closed.
  assert.equal(res.confirmed, false);
  assert.equal(res.method, 'denied');
  // The note names BOTH halves: the prompt was advertised and then failed (with
  // the thrown reason), and the fallback route had nothing to compare against.
  assert.equal(
    res.note,
    'elicitation failed (no client); no operator token is configured (set FB_CONFIRM_TOKEN)',
  );
});

test('the operator token matches whole or not at all — no prefix, no case folding', async () => {
  const gate = createConfirmer({ settings: { confirmToken: OPERATOR_TOKEN } });

  // Every near-miss the digest comparison has to refuse. The existing wrong-token
  // fixture is a different LENGTH, which a sloppy prefix or `startsWith` check
  // would also reject — these are the shapes that would slip past one.
  const nearMisses = [
    OPERATOR_TOKEN.slice(0, -1), // a strict prefix
    `${OPERATOR_TOKEN}x`, // the real token plus a suffix
    OPERATOR_TOKEN.toUpperCase(), // same length, same letters, wrong bytes
    `${OPERATOR_TOKEN.slice(0, -1)}X`, // same length, one byte off, at the end
    ` ${OPERATOR_TOKEN}`, // untrimmed — the gate compares verbatim
  ];
  for (const supplied of nearMisses) {
    const res = await gate.confirm(REQUEST, supplied);
    assert.equal(res.confirmed, false, `must reject ${JSON.stringify(supplied)}`);
    assert.equal(res.note, 'the supplied confirm_token did not match');
  }

  // …and the exact value still passes, so the above is not proving a dead gate.
  assert.equal((await gate.confirm(REQUEST, OPERATOR_TOKEN)).confirmed, true);
});

test('a denial distinguishes a missing confirm_token from a wrong one (D12)', async () => {
  const gate = createConfirmer({ settings: { confirmToken: OPERATOR_TOKEN } });

  const missing = await gate.confirm(REQUEST);
  assert.equal(missing.confirmed, false);
  // Actionable: the operator token EXISTS, so the caller's fix is to pass it —
  // a note reading "did not match" would send them to rotate a working token.
  assert.equal(missing.note, 'no confirm_token was supplied with this call');

  const wrong = await gate.confirm(REQUEST, 'wrong-token-PLACEHOLDER');
  assert.equal(wrong.confirmed, false);
  assert.equal(wrong.note, 'the supplied confirm_token did not match');
});

test('a failed elicitation is not reported as a client that never had it (D12)', async () => {
  const gate = createConfirmer({
    elicit: () => Promise.reject(new Error('request timed out\n  after 60s')),
    settings: { confirmToken: OPERATOR_TOKEN },
  });

  const res = await gate.confirm(REQUEST);

  assert.equal(res.confirmed, false);
  assert.equal(res.method, 'denied');
  // Whitespace is flattened so the note stays one line inside a tool error.
  assert.equal(
    res.note,
    'elicitation failed (request timed out after 60s); no confirm_token was supplied with this call',
  );
});

test('the gate has no write-mode input, so it cannot be bypassed by FB_WRITE_MODE', async () => {
  // The seam's only inputs are elicit + settings.confirmToken + a token
  // resolver. There is no writeMode/env knob on ConfirmerDeps, so a spend-tier
  // request with no confirmation channel stays denied regardless of write mode.
  const spend: ConfirmationRequest = {
    tool: 'facebook_update_ad_budget',
    tier: 'spend',
    summary: 'Raise daily budget to 5000',
    reason: 'spend action',
  };
  const gate = createConfirmer({ settings: {} });

  const res = await gate.confirm(spend);
  assert.equal(res.confirmed, false);
  assert.equal(res.method, 'denied');
});
