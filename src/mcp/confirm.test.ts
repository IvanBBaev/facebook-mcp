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
