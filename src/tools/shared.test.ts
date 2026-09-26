// Tests for `tools/shared.ts` — the seam EVERY vertical package is built on.
//
// Nothing here is a vertical's behaviour: these tests pin the cross-package
// contract itself, because a change to this module changes every write tool at
// once. Three things are worth pinning and are pinned below:
//
//   * the shared argument shapes (a tool that spells `limit` or `video_id`
//     differently is a tool the model has to learn twice),
//   * `gateArgs`, whose whole job is to produce an object with the ABSENT keys
//     absent rather than present-and-undefined (`exactOptionalPropertyTypes`),
//   * `executeWrite`, the single envelope every write result reaches the model
//     through — including the two facts a model must never be able to confuse:
//     whether the write happened, and that a plan preview leaks neither the
//     captured before-state nor the Page access token.
//
// The gate itself is stubbed where the assertion is about the ENVELOPE, and is
// the real `createWriteGate` where the assertion is about the round trip — the
// `nextStep` sentence is an instruction to the model, so a test proves it is
// actually executable rather than merely well-worded.
//
// Placeholder tokens only; never a real secret in a fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFakeClock,
  createFakeFbRequest,
  createFakePageResolver,
  createFakeRedactor,
  createMemoryJournal,
  type MemoryJournal,
} from '../core/fakes/index.js';
import { GraphApiError } from '../core/index.js';
import type {
  Confirmer,
  DivergenceDiff,
  Logger,
  PlanPreview,
  ResolvedPage,
  Settings,
  ToolContext,
  ToolResult,
} from '../core/index.js';
import {
  createWriteGate,
  type WriteAction,
  type WriteGate,
  type WriteOutcome,
} from '../mcp/index.js';

import {
  GRAPH_NODE_ID_MESSAGE,
  META_ERROR_TEXT_MAX,
  MissingWriteGateError,
  VIDEO_ID_MESSAGE,
  confirmableWriteArgs,
  executeWrite,
  gateArgs,
  graphErrorFields,
  graphNodeIdArg,
  limitArg,
  listArgs,
  shapeFor,
  shapeOptionsOf,
  videoIdArg,
  writeArgs,
  writeGateOf,
  type WriteToolContext,
} from './shared.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PAGE: ResolvedPage = {
  pageId: '900',
  name: 'Test Page',
  token: 'PAGE-TOKEN-PLACEHOLDER',
};

const NOW_MS = Date.parse('2026-07-01T10:00:00.000Z');

const ALWAYS_CONFIRMS: Confirmer = {
  confirm: () => Promise.resolve({ confirmed: true, method: 'operator_token' }),
};

function makeLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    profiles: {},
    apiVersion: 'v23.0',
    hosts: {
      graph: 'graph.facebook.com',
      graphVideo: 'graph-video.facebook.com',
      rupload: 'rupload.facebook.com',
    },
    requestTimeoutMs: 30_000,
    hostConcurrency: 4,
    writeMode: 'plan',
    maxResultChars: 25_000,
    transport: 'stdio',
    packagesDeny: [],
    packagesReadonly: [],
    journalPath: '/tmp/journal.ndjson',
    logLevel: 'info',
    ...overrides,
  };
}

/** A context WITHOUT a write gate — what a read tool receives. */
function makeReadCtx(overrides: Partial<Settings> = {}): ToolContext {
  const clock = createFakeClock(NOW_MS);
  return {
    settings: makeSettings(overrides),
    fbRequest: createFakeFbRequest().fn,
    pages: createFakePageResolver({ default: PAGE }),
    logger: makeLogger(),
    redactor: createFakeRedactor({ secrets: [PAGE.token] }),
    clock,
    journal: createMemoryJournal(clock),
  };
}

/** A recording stub gate: returns a canned outcome and keeps what it was handed. */
interface StubGate {
  readonly gate: WriteGate;
  readonly actions: readonly WriteAction<unknown>[];
}

function gateReturning(outcome: WriteOutcome<unknown>): StubGate {
  const actions: WriteAction<unknown>[] = [];
  const gate: WriteGate = {
    execute: <T = unknown>(action: WriteAction<T>): Promise<WriteOutcome<T>> => {
      actions.push(action as WriteAction<unknown>);
      return Promise.resolve(outcome as WriteOutcome<T>);
    },
  };
  return {
    gate,
    get actions() {
      return actions;
    },
  };
}

/** A context carrying the supplied gate (what the bootstrap builds for a write). */
function makeWriteCtx(gate: WriteGate, overrides: Partial<Settings> = {}): ToolContext {
  return { ...makeReadCtx(overrides), writeGate: gate } as WriteToolContext;
}

function preview(overrides: Partial<PlanPreview> = {}): PlanPreview {
  return {
    planId: 'plan-1',
    tool: 'facebook_delete_post',
    tier: 'irreversible',
    summary: 'Delete post 900_1 ("Autumn sale")',
    warnings: ['This cannot be undone.'],
    notPerformedNotice: 'The post was NOT deleted.',
    expiresAt: NOW_MS + 5 * 60 * 1000,
    ...overrides,
  };
}

/** The raw JSON text of a tool result (what actually reaches the model). */
function text(result: ToolResult): string {
  return result.content[0]?.text ?? '';
}

function body(result: ToolResult): Record<string, unknown> {
  return JSON.parse(text(result)) as Record<string, unknown>;
}

function str(value: unknown): string {
  assert.equal(typeof value, 'string', 'expected a string');
  return value as string;
}

// ---------------------------------------------------------------------------
// 1. Shared input arguments — the vocabulary every package speaks
// ---------------------------------------------------------------------------

test('limitArg is an optional 1–100 integer, so a page size cannot be 0 or fractional', () => {
  assert.equal(limitArg.parse(undefined), undefined);
  assert.equal(limitArg.parse(1), 1);
  assert.equal(limitArg.parse(100), 100);
  for (const bad of [0, -1, 101, 1000, 1.5]) {
    assert.throws(
      () => limitArg.parse(bad),
      `expected ${String(bad)} to be rejected as a page size`,
    );
  }
});

test('videoIdArg accepts a bare node id, trims padding, and refuses everything else', () => {
  const arg = videoIdArg({ description: 'The video id.' });
  assert.equal(arg.parse('1234567890'), '1234567890');
  // Trim runs BEFORE the shape check: a pasted id is accepted on its digits.
  assert.equal(arg.parse('  1234567890\n'), '1234567890');
  for (const bad of [
    '900_17841', // the {page-id}_{post-id} composite — a POST, not a video
    'https://facebook.com/watch/?v=1234567890',
    '1234567890/videos',
    '../1234567890',
    '12345 67890',
    '',
  ]) {
    assert.throws(() => arg.parse(bad), `expected ${bad} to be rejected as a video id`);
  }
});

test('videoIdArg appends the tool hint to the one shared rejection message', () => {
  const withHint = videoIdArg({
    description: 'The video id.',
    hint: 'Use the `videoId` from facebook_publish_reel.',
  });
  const result = withHint.safeParse('900_17841');
  assert.equal(result.success, false);
  const message = result.error.issues.map((i) => i.message).join(' ');
  assert.match(message, /Expected the bare VIDEO id/);
  assert.match(message, /facebook_publish_reel/);

  // The shared half is a property of Graph's ID space, not of any one tool, and
  // the live `reels/status-guardrail` smoke asserts this wording.
  assert.match(VIDEO_ID_MESSAGE, /VIDEO id/);
  assert.match(VIDEO_ID_MESSAGE, /digits only/);
});

test('graphNodeIdArg contains an id to ONE path segment, whatever the caller pastes', () => {
  // New-export coverage for the shared containment shape, not a proven fix: the
  // proof that a tool was reachable lives in the per-package suites. What is
  // pinned here is the shape itself, because `containPathname` receives the
  // pathname already joined and therefore cannot refuse a `/` that arrived
  // inside an interpolated id.
  const arg = graphNodeIdArg({ description: 'The node id.' });

  // Every id Graph actually mints stays acceptable.
  for (const ok of [
    '111222333_999888777', // the {page-id}_{post-id} composite
    't_1234567890', // a Messenger thread id
    '1234567890', // a bare node id
    'act_123', // an ad-account id
    'v1.2-3_4', // dots and dashes are legal id characters
  ]) {
    assert.equal(arg.parse(ok), ok, `expected ${ok} to be accepted as a node id`);
  }
  // Trim runs BEFORE the shape check, so padding is stripped, not refused.
  assert.equal(arg.parse('  100_555\n'), '100_555');

  for (const bad of [
    '100200300/conversations', // a new SEGMENT — the inbox, same token, same method
    'me/accounts', // the Page listing
    '..', // a dot segment
    '.',
    '100_555?fields=from', // a query string smuggled into the id
    'https://facebook.com/100_555',
    '100 555',
    '',
  ]) {
    assert.throws(
      () => arg.parse(bad),
      `expected ${JSON.stringify(bad)} to be refused as a node id`,
    );
  }
});

test('graphNodeIdArg appends the tool hint to the one shared rejection message', () => {
  const withHint = graphNodeIdArg({
    description: 'The comment id.',
    hint: 'facebook_list_comments returns it as `id`.',
  });
  const result = withHint.safeParse('me/accounts');
  assert.equal(result.success, false);
  const message = result.success
    ? ''
    : result.error.issues.map((i) => i.message).join(' ');
  assert.match(message, /Expected a bare Graph ID/);
  assert.match(message, /facebook_list_comments/);

  // Without a hint the shared sentence stands alone, and an ELEMENT schema needs
  // no description of its own — the array that holds it does the describing.
  const bare = graphNodeIdArg().safeParse('me/accounts');
  assert.equal(bare.success, false);
  assert.equal(
    bare.success ? '' : (bare.error.issues[0]?.message ?? ''),
    GRAPH_NODE_ID_MESSAGE,
  );
});

test('the argument bundles keep confirm_token off ordinary writes', () => {
  assert.deepEqual(Object.keys(writeArgs), ['profile', 'apply', 'plan_id']);
  // Advertising `confirm_token` on every write would invite the model to ask a
  // human for the operator token where no confirmation is required (B1).
  assert.deepEqual(Object.keys(confirmableWriteArgs), [
    'profile',
    'apply',
    'plan_id',
    'confirm_token',
  ]);
  assert.deepEqual(Object.keys(listArgs), ['profile', 'limit', 'after']);
});

// ---------------------------------------------------------------------------
// 2. gateArgs — absent must mean ABSENT
// ---------------------------------------------------------------------------

test('gateArgs renames the snake_case arguments into the gate’s camelCase shape', () => {
  assert.deepEqual(
    gateArgs({ apply: true, plan_id: 'plan-7', confirm_token: 'TOKEN-PLACEHOLDER' }),
    { apply: true, planId: 'plan-7', confirmToken: 'TOKEN-PLACEHOLDER' },
  );
});

test('gateArgs OMITS an absent field rather than setting it to undefined', () => {
  // Not cosmetic: under `exactOptionalPropertyTypes` a present-but-undefined
  // `planId` is a different value from an absent one, and the gate reads
  // `planId === undefined` to decide whether an apply is plan-bound at all.
  const out = gateArgs({});
  assert.deepEqual(Object.keys(out), []);
  assert.equal('apply' in out, false);
  assert.equal('planId' in out, false);
  assert.equal('confirmToken' in out, false);
});

test('gateArgs preserves an explicit apply:false instead of folding it into absent', () => {
  // `apply:false` is a caller who asked for a dry run; absent is a caller who
  // said nothing and lets the server's write mode decide. Distinct requests.
  const out = gateArgs({ apply: false });
  assert.deepEqual(out, { apply: false });
  assert.equal('apply' in out, true);
});

// ---------------------------------------------------------------------------
// 3. writeGateOf — turning a wiring bug into a message that names its subject
// ---------------------------------------------------------------------------

test('writeGateOf returns the gate the bootstrap attached', () => {
  const stub = gateReturning({ kind: 'preview', preview: preview() });
  assert.equal(writeGateOf(makeWriteCtx(stub.gate), 'facebook_delete_post'), stub.gate);
});

test('writeGateOf names the tool when the context carries no gate at all', () => {
  assert.throws(
    () => writeGateOf(makeReadCtx(), 'facebook_delete_post'),
    (err: unknown) => {
      assert.ok(err instanceof MissingWriteGateError);
      assert.match(err.message, /facebook_delete_post/);
      assert.match(err.message, /server wiring bug/);
      return true;
    },
  );
});

test('writeGateOf reports a null gate as the same wiring bug, not as a TypeError', () => {
  // `writeGate: lookup() ?? null` — or any context rebuilt from JSON, or any JS
  // caller of the published barrel — writes the absence down as a VALUE. A guard
  // that tests only for `undefined` then dereferences it, and the operator gets
  // "Cannot read properties of null (reading 'execute')": no tool named, no
  // cause named, and it reads like a crash inside the write rather than a server
  // that was never wired.
  for (const missing of [null, {}, { execute: 'nope' }, 42, 'gate']) {
    const ctx = { ...makeReadCtx(), writeGate: missing } as unknown as ToolContext;
    assert.throws(
      () => writeGateOf(ctx, 'facebook_delete_post'),
      (err: unknown) => {
        assert.ok(
          err instanceof MissingWriteGateError,
          `expected MissingWriteGateError for ${JSON.stringify(missing)}, got ${String(err)}`,
        );
        assert.match(err.message, /facebook_delete_post/);
        return true;
      },
    );
  }
});

test('executeWrite refuses a gate-less context BEFORE perform can touch the wire', async () => {
  let performed = false;
  await assert.rejects(
    executeWrite(makeReadCtx(), {
      tool: 'facebook_delete_post',
      tier: 'irreversible',
      params: { post_id: '900_1' },
      summary: 'Delete post 900_1',
      perform: () => {
        performed = true;
        return Promise.resolve({ success: true });
      },
    }),
    MissingWriteGateError,
  );
  assert.equal(performed, false, 'a mis-wired server must not reach the mutation');
});

// ---------------------------------------------------------------------------
// 4. executeWrite — the preview envelope
// ---------------------------------------------------------------------------

test('a preview says NOT performed, states the plan, and dates its expiry in ISO', async () => {
  const stub = gateReturning({ kind: 'preview', preview: preview() });
  const parsed = body(
    await executeWrite(makeWriteCtx(stub.gate), {
      tool: 'facebook_delete_post',
      tier: 'irreversible',
      params: { post_id: '900_1' },
      summary: 'Delete post 900_1',
      perform: () => Promise.resolve({ success: true }),
    }),
  );

  assert.equal(parsed.status, 'preview');
  assert.equal(parsed.applied, false);
  assert.equal(parsed.planId, 'plan-1');
  assert.equal(parsed.tool, 'facebook_delete_post');
  assert.equal(parsed.tier, 'irreversible');
  assert.equal(parsed.summary, 'Delete post 900_1 ("Autumn sale")');
  assert.deepEqual(parsed.warnings, ['This cannot be undone.']);
  assert.equal(parsed.notPerformedNotice, 'The post was NOT deleted.');
  // A raw epoch number is a date the model has to guess the units of.
  assert.equal(parsed.expiresAt, new Date(NOW_MS + 5 * 60 * 1000).toISOString());
});

test('the preview’s nextStep spells out the exact follow-up call, plan id included', async () => {
  const stub = gateReturning({ kind: 'preview', preview: preview() });
  const parsed = body(
    await executeWrite(makeWriteCtx(stub.gate), {
      tool: 'facebook_delete_post',
      tier: 'irreversible',
      params: { post_id: '900_1' },
      summary: 'Delete post 900_1',
      perform: () => Promise.resolve({ success: true }),
    }),
  );
  const nextStep = str(parsed.nextStep);
  assert.match(nextStep, /facebook_delete_post/);
  assert.match(nextStep, /apply:true/);
  assert.match(nextStep, /plan_id:"plan-1"/);
});

test('a preview leaks neither the captured before-state nor the Page token', async () => {
  const stub = gateReturning({
    kind: 'preview',
    preview: preview({
      resolvedPage: PAGE,
      // The gate captures this to detect divergence; it is internal bookkeeping
      // and can hold the whole prior object, including fields the tool never
      // asked for.
      beforeState: { message: 'Autumn sale', is_hidden: false, secret: 'internal' },
    }),
  });
  const result = await executeWrite(makeWriteCtx(stub.gate), {
    tool: 'facebook_delete_post',
    tier: 'irreversible',
    params: { post_id: '900_1' },
    summary: 'Delete post 900_1',
    resolvedPage: PAGE,
    perform: () => Promise.resolve({ success: true }),
  });
  const parsed = body(result);

  assert.equal(parsed.beforeState, undefined);
  assert.equal('beforeState' in parsed, false);
  // Only the id of the resolved Page is projected — never the whole
  // `ResolvedPage`, which carries the Page access token.
  assert.equal(parsed.pageId, '900');
  assert.equal(parsed.resolvedPage, undefined);
  assert.equal(text(result).includes(PAGE.token), false);
  assert.equal(text(result).includes('internal'), false);
});

// ---------------------------------------------------------------------------
// 5. executeWrite — the apply envelopes
// ---------------------------------------------------------------------------

test('an applied write reports applied:true and hands the result back', async () => {
  const stub = gateReturning({
    kind: 'result',
    result: { applied: true, result: { id: '900_1' }, journalStatus: 'ok' },
  });
  const parsed = body(
    await executeWrite(makeWriteCtx(stub.gate), {
      tool: 'facebook_create_post',
      tier: 'reversible',
      params: { message: 'hi' },
      summary: 'Create a post',
      perform: () => Promise.resolve({ id: '900_1' }),
    }),
  );
  assert.equal(parsed.status, 'applied');
  assert.equal(parsed.applied, true);
  assert.equal(parsed.tool, 'facebook_create_post');
  assert.deepEqual(parsed.result, { id: '900_1' });
  assert.equal(parsed.journalStatus, 'ok');
});

test('a write that landed nothing is never labelled applied, and keeps the reasons', async () => {
  // A bulk verb reports per-id outcomes instead of throwing (CC-MOD-5), so a
  // batch in which every id failed resolves normally. `status` and `applied`
  // answer the same question and must never disagree.
  const stub = gateReturning({
    kind: 'result',
    result: {
      applied: false,
      result: { results: [{ id: 'c1', ok: false, error: 'Permissions error' }] },
      journalStatus: 'ok',
    },
  });
  const parsed = body(
    await executeWrite(makeWriteCtx(stub.gate), {
      tool: 'facebook_hide_comments',
      tier: 'reversible',
      params: { comment_ids: ['c1'] },
      summary: 'Hide 1 comment',
      perform: () => Promise.resolve({ results: [] }),
    }),
  );
  assert.equal(parsed.status, 'not_applied');
  assert.equal(parsed.applied, false);
  assert.match(str(parsed.notPerformedNotice), /nothing landed/);
  // The per-item detail survives: it is the only place the WHY is written down.
  assert.deepEqual(parsed.result, {
    results: [{ id: 'c1', ok: false, error: 'Permissions error' }],
  });
});

test('an ambiguous write is not_applied, says the journal recorded ATTEMPTED, and warns off a blind retry', async () => {
  // A multi-phase upload whose `finish` Graph declined after the object was
  // created (CC-PUB-1): the request reached Facebook and something may exist
  // there. That is neither "nothing landed" nor "a failure" — telling the model
  // either invites the retry that duplicates the video.
  const stub = gateReturning({
    kind: 'result',
    result: {
      applied: false,
      outcome: 'attempted',
      result: { videoId: 'vid-1', accepted: false },
      journalStatus: 'ok',
    },
  });
  const parsed = body(
    await executeWrite(makeWriteCtx(stub.gate), {
      tool: 'facebook_create_video_post',
      tier: 'reversible',
      params: { video: 'clip.mp4' },
      summary: 'Create a video post',
      perform: () => Promise.resolve({ videoId: 'vid-1', accepted: false }),
    }),
  );
  assert.equal(parsed.status, 'not_applied', 'the status stays stable across outcomes');
  assert.equal(parsed.applied, false);
  assert.equal(parsed.outcome, 'attempted');
  const notice = str(parsed.notPerformedNotice);
  assert.match(notice, /reached Facebook/, notice);
  assert.match(notice, /unconfirmed/, notice);
  assert.match(notice, /ATTEMPTED/, notice);
  assert.match(notice, /not as a change, not as a failure/, notice);
  assert.match(notice, /[Vv]erify/, notice);
  assert.match(notice, /duplicate/, notice);
  assert.doesNotMatch(notice, /nothing landed/, notice);
  assert.doesNotMatch(notice, /records this as a failure/, notice);
  // The result survives: it carries the id the operator has to reconcile.
  assert.deepEqual(parsed.result, { videoId: 'vid-1', accepted: false });
  assert.equal(parsed.journalStatus, 'ok');
});

test('the journal outcome is echoed on the applied and the refused envelopes', async () => {
  const refused = body(
    await executeWrite(
      makeWriteCtx(
        gateReturning({
          kind: 'result',
          result: { applied: false, outcome: 'failed', result: { success: false } },
        }).gate,
      ),
      {
        tool: 'facebook_update_post',
        tier: 'reversible',
        params: { post_id: '100_1' },
        summary: 'Edit post 100_1',
        perform: () => Promise.resolve({ success: false }),
      },
    ),
  );
  assert.equal(refused.status, 'not_applied');
  assert.equal(refused.applied, false);
  assert.equal(refused.outcome, 'failed');
  // A refusal keeps the wording every bulk verb's caller already relies on.
  assert.match(str(refused.notPerformedNotice), /nothing landed/);
  assert.match(str(refused.notPerformedNotice), /records this as a failure/);

  const landed = body(
    await executeWrite(
      makeWriteCtx(
        gateReturning({
          kind: 'result',
          result: { applied: true, outcome: 'applied', result: { id: '100_1' } },
        }).gate,
      ),
      {
        tool: 'facebook_create_post',
        tier: 'reversible',
        params: { message: 'hi' },
        summary: 'Create a post',
        perform: () => Promise.resolve({ id: '100_1' }),
      },
    ),
  );
  assert.equal(landed.status, 'applied');
  assert.equal(landed.applied, true);
  assert.equal(landed.outcome, 'applied');
});

test('an applied:false result with no outcome still reads as a failure (old callers)', async () => {
  // A gate (or a stub) that predates `outcome` hands in the old shape; the
  // refusal wording is the safe default, because a refusal is what every
  // classifier that existed before `attempted` was reachable meant by it.
  const parsed = body(
    await executeWrite(
      makeWriteCtx(
        gateReturning({
          kind: 'result',
          result: { applied: false, result: { results: [] } },
        }).gate,
      ),
      {
        tool: 'facebook_hide_comments',
        tier: 'reversible',
        params: { comment_ids: ['c1'] },
        summary: 'Hide 1 comment',
        perform: () => Promise.resolve({ results: [] }),
      },
    ),
  );
  assert.equal(parsed.status, 'not_applied');
  assert.equal(parsed.applied, false);
  assert.equal('outcome' in parsed, false, 'no outcome is invented for the caller');
  assert.match(str(parsed.notPerformedNotice), /nothing landed/);
});

test('a diverged apply reports the diff and carries no result to mistake for one', async () => {
  const diverged: readonly DivergenceDiff[] = [
    { field: 'is_hidden', expected: false, actual: true },
  ];
  const stub = gateReturning({
    kind: 'result',
    result: { applied: false, diverged },
  });
  const parsed = body(
    await executeWrite(makeWriteCtx(stub.gate), {
      tool: 'facebook_hide_comment',
      tier: 'reversible',
      params: { comment_id: 'c1' },
      summary: 'Hide comment c1',
      perform: () => Promise.resolve({ success: true }),
    }),
  );
  assert.equal(parsed.status, 'diverged');
  assert.equal(parsed.applied, false);
  assert.deepEqual(parsed.diverged, [
    { field: 'is_hidden', expected: false, actual: true },
  ]);
  assert.match(str(parsed.notPerformedNotice), /nothing was written/);
  assert.equal('result' in parsed, false);
});

test('a failed journal write is reported as such and does NOT unsay the write', async () => {
  // `journalStatus` is about the RECORD, not about the mutation: the write
  // landed, the audit line did not. Collapsing the two would either hide a real
  // change or invent an unmade one.
  const stub = gateReturning({
    kind: 'result',
    result: { applied: true, result: { id: '900_1' }, journalStatus: 'failed' },
  });
  const parsed = body(
    await executeWrite(makeWriteCtx(stub.gate), {
      tool: 'facebook_create_post',
      tier: 'reversible',
      params: { message: 'hi' },
      summary: 'Create a post',
      perform: () => Promise.resolve({ id: '900_1' }),
    }),
  );
  assert.equal(parsed.applied, true);
  assert.equal(parsed.status, 'applied');
  assert.equal(parsed.journalStatus, 'failed');
});

test('executeWrite hands the action to the gate untouched', async () => {
  const stub = gateReturning({ kind: 'preview', preview: preview() });
  const action: WriteAction<{ success: boolean }> = {
    tool: 'facebook_delete_post',
    tier: 'irreversible',
    params: { post_id: '900_1' },
    apply: true,
    planId: 'plan-1',
    confirmToken: 'TOKEN-PLACEHOLDER',
    requirePlanId: true,
    summary: 'Delete post 900_1',
    perform: () => Promise.resolve({ success: true }),
  };
  await executeWrite(makeWriteCtx(stub.gate), action);
  // Identity, not deep equality: every gating field — including the ones the
  // envelope never prints — must reach the gate exactly as the handler built it.
  assert.equal(stub.actions.length, 1);
  assert.equal(stub.actions[0], action as unknown as WriteAction<unknown>);
});

// ---------------------------------------------------------------------------
// 6. executeWrite — the result passes the same shaping every read does
// ---------------------------------------------------------------------------

test('the write envelope is redacted and truncated like any other result', async () => {
  const stub = gateReturning({
    kind: 'result',
    result: {
      applied: true,
      result: {
        // A Graph echo can carry the Page token straight back into the payload,
        // as a URL query (caught by the structural strip) or as a bare value
        // (caught only by the redactor). Both passes have to run.
        echoed: `https://graph.facebook.com/900/feed?access_token=${PAGE.token}`,
        owner: PAGE.token,
        items: Array.from({ length: 200 }, (_, i) => ({
          id: `c${String(i)}`,
          message: 'x'.repeat(200),
        })),
      },
    },
  });
  const result = await executeWrite(makeWriteCtx(stub.gate, { maxResultChars: 2000 }), {
    tool: 'facebook_hide_comments',
    tier: 'reversible',
    params: {},
    summary: 'Hide comments',
    perform: () => Promise.resolve({}),
  });

  assert.equal(text(result).includes(PAGE.token), false);
  assert.match(text(result), /access_token=\[STRIPPED_TOKEN\]/);
  assert.match(text(result), /\[REDACTED\]/);
  assert.ok(
    text(result).length <= 2000,
    `expected the budget to be honoured, got ${String(text(result).length)} chars`,
  );
  assert.match(text(result), /_truncation/);
});

// ---------------------------------------------------------------------------
// 7. The round trip through the REAL gate — is `nextStep` executable?
// ---------------------------------------------------------------------------

test('the nextStep sentence really performs the write when followed verbatim', async () => {
  const clock = createFakeClock(NOW_MS);
  const journal: MemoryJournal = createMemoryJournal(clock);
  let planSeq = 0;
  const gate = createWriteGate({
    confirmer: ALWAYS_CONFIRMS,
    clock,
    journal,
    // `plan` is the safe default; an irreversible tier ignores it either way.
    defaultWriteMode: 'plan',
    newPlanId: () => `plan-${String(++planSeq)}`,
  });
  const ctx = makeWriteCtx(gate);

  let performed = 0;
  const action = (
    input: { readonly apply?: boolean; readonly plan_id?: string } = {},
  ): WriteAction<{ success: boolean }> => ({
    tool: 'facebook_delete_post',
    tier: 'irreversible',
    params: { post_id: '900_1' },
    summary: 'Delete post 900_1',
    resolvedPage: PAGE,
    ...gateArgs(input),
    perform: () => {
      performed += 1;
      return Promise.resolve({ success: true });
    },
  });

  // Step 1: no `apply` — the dry run must not touch the wire.
  const first = body(await executeWrite(ctx, action()));
  assert.equal(first.status, 'preview');
  assert.equal(performed, 0);

  // Step 2: exactly what `nextStep` instructs — same arguments, apply:true, and
  // the plan_id it quoted.
  const planId = str(first.planId);
  assert.match(str(first.nextStep), new RegExp(`plan_id:"${planId}"`));
  const second = body(await executeWrite(ctx, action({ apply: true, plan_id: planId })));

  assert.equal(second.status, 'applied');
  assert.equal(second.applied, true);
  assert.equal(performed, 1);
  assert.equal(journal.entries.at(-1)?.outcome, 'applied');
});

test('a preview alone never performs the write, whatever the envelope says', async () => {
  const clock = createFakeClock(NOW_MS);
  const gate = createWriteGate({
    confirmer: ALWAYS_CONFIRMS,
    clock,
    journal: createMemoryJournal(clock),
    defaultWriteMode: 'plan',
    newPlanId: () => 'plan-1',
  });
  let performed = 0;
  const parsed = body(
    await executeWrite(makeWriteCtx(gate), {
      tool: 'facebook_delete_post',
      tier: 'irreversible',
      // An `apply:true` with NO plan_id is the shape that must still preview:
      // the two high-consequence tiers are never satisfied by a flag alone.
      apply: true,
      params: { post_id: '900_1' },
      summary: 'Delete post 900_1',
      perform: () => {
        performed += 1;
        return Promise.resolve({ success: true });
      },
    }),
  );
  assert.equal(parsed.status, 'preview');
  assert.equal(parsed.applied, false);
  assert.equal(performed, 0);
});

// ---------------------------------------------------------------------------
// 8. shapeOptionsOf / shapeFor — the read side of the same seam
// ---------------------------------------------------------------------------

test('shapeOptionsOf reads the budget and the redactor off the context', () => {
  const ctx = makeReadCtx({ maxResultChars: 4096 });
  const options = shapeOptionsOf(ctx);
  assert.equal(options.maxResultChars, 4096);
  assert.equal(options.redactor, ctx.redactor);
  // `isError` is not this helper's to decide — an error result opts in.
  assert.equal('isError' in options, false);
});

test('shapeFor strips Graph paging and redacts, so no tool has to remember to', () => {
  const ctx = makeReadCtx();
  const result = shapeFor(ctx, {
    data: [{ id: 'c1', message: 'hi' }],
    paging: {
      cursors: { after: 'CURSOR' },
      next: `https://graph.facebook.com/v23.0/900/feed?access_token=${PAGE.token}`,
    },
    echoed: PAGE.token,
  });
  const parsed = body(result);
  assert.deepEqual(parsed.data, [{ id: 'c1', message: 'hi' }]);
  assert.equal('paging' in parsed, false);
  assert.equal(text(result).includes(PAGE.token), false);
  // Text-only: `structuredContent` is reserved for server-owned envelopes
  // (CC-MCP-7), and a Graph payload is not one.
  assert.equal('structuredContent' in result, false);
});

test('graphErrorFields carries the Graph identity and Meta\u2019s own explanation', () => {
  const err = new GraphApiError('Invalid parameter', {
    code: 100,
    subcode: 1363040,
    type: 'OAuthException',
    httpStatus: 400,
    fbtraceId: 'AbCtrace',
    userTitle: 'Video Too Long',
    userMessage: 'Reels must be 90 seconds or shorter.',
  });
  assert.deepEqual(graphErrorFields(err), {
    code: 100,
    subcode: 1363040,
    type: 'OAuthException',
    httpStatus: 400,
    fbtraceId: 'AbCtrace',
    userTitle: 'Video Too Long',
    userMessage: 'Reels must be 90 seconds or shorter.',
  });
});

test('graphErrorFields omits what Graph did not send and is empty for a non-Graph throw', () => {
  const bare = graphErrorFields(new GraphApiError('boom', { code: 1, httpStatus: 500 }));
  assert.deepEqual(bare, { code: 1, httpStatus: 500 });
  assert.deepEqual(graphErrorFields(new TypeError('x')), {});
  assert.deepEqual(graphErrorFields('a string'), {});
  assert.deepEqual(graphErrorFields(undefined), {});
});

test('graphErrorFields bounds Meta\u2019s text, and the shaper still redacts it', () => {
  const ctx = makeReadCtx();
  const long = `${PAGE.token} ${'x'.repeat(META_ERROR_TEXT_MAX * 2)}`;
  const fields = graphErrorFields(
    new GraphApiError('Invalid parameter', {
      code: 100,
      httpStatus: 400,
      userTitle: long,
      userMessage: long,
    }),
  );
  assert.equal(str(fields['userTitle']).length, META_ERROR_TEXT_MAX);
  assert.equal(str(fields['userMessage']).length, META_ERROR_TEXT_MAX);
  const rendered = text(shapeFor(ctx, { error: 'Invalid parameter', ...fields }));
  assert.equal(rendered.includes(PAGE.token), false);
});

test('graphErrorFields never cuts Meta’s text between the two halves of a surrogate pair', () => {
  // The bound slices UTF-16 units. An astral character (an emoji, which Meta's
  // localized refusals do carry) straddling the cut left a lone high surrogate
  // before the ellipsis: not a character at all, rendered as U+FFFD or refused
  // by a strict decoder, in the one field the model is meant to quote.
  const straddling = `${'x'.repeat(META_ERROR_TEXT_MAX - 2)}\u{1F600}${'y'.repeat(10)}`;
  const fields = graphErrorFields(
    new GraphApiError('Invalid parameter', {
      code: 100,
      httpStatus: 400,
      userTitle: straddling,
      userMessage: straddling,
    }),
  );
  const loneSurrogate =
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const key of ['userTitle', 'userMessage']) {
    const bounded = str(fields[key]);
    assert.equal(loneSurrogate.test(bounded), false, `${key} ends in a lone surrogate`);
    assert.ok(bounded.length <= META_ERROR_TEXT_MAX);
    assert.ok(bounded.endsWith('…'));
  }
});
