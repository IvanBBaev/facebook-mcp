// Second, independent kills for the safety invariants the 2026-10-29 QA review
// found resting on a single test (R12, finding QA-06).
//
// Each test here catches the probe mutant named in its title on a different path
// from the original guard: through a tool handler, a real gate or a real
// confirmer, not the unit that owns the check. Waves 1 and 2 rewrite the files
// holding the original guards, so the second kill lives outside them.
// `src/guards.manifest.test.ts` names both tests of every pair, so neither can
// disappear unnoticed. M16 is the exception: its second kill needs the upload
// harness and stays in `src/api/media-video.test.ts`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchAll, fetchPage } from './api/shared.js';
import {
  createFakeClock,
  createFakeFbRequest,
  createFakePageResolver,
  createFakeRedactor,
  createMemoryJournal,
  fbOk,
  type FakeClock,
  type FakeFbRequest,
  type FakePageResolver,
  type MemoryJournal,
} from './core/fakes/index.js';
import {
  GraphApiError,
  createFbRequest,
  createRedactor,
  graphErrorFromResponse,
} from './core/index.js';
import type {
  ConfirmationRequest,
  Confirmer,
  Logger,
  Settings,
  ToolResult,
  ToolSpec,
  WriteMode,
} from './core/index.js';
import { createConfirmer, type ElicitOutcome } from './mcp/confirm.js';
import { PLAN_TTL_MS, WriteGateError, createWriteGate } from './mcp/index.js';
import { withFetch, type FetchMock } from './testing/index.js';
import { createAdsPackage } from './tools/ads.js';
import { createPostsPackage } from './tools/posts.js';
import type { WriteToolContext } from './tools/shared.js';

const PAGE_A = { pageId: '111', name: 'Page A', token: 'EAA-PAGE-TOKEN-A' };
const PAGE_B = { pageId: '222', name: 'Page B', token: 'EAA-PAGE-TOKEN-B' };
const POST_ID = '111_555';
const ACCOUNT_ID = 'act_1234567890';
const ADSET_ID = '23859876543210987';
const NOW_MS = Date.parse('2026-08-07T09:00:00Z');
const OPERATOR_TOKEN = 'operator-token-for-tests';

const ALWAYS_CONFIRMS: Confirmer = {
  confirm: () => Promise.resolve({ confirmed: true, method: 'operator_token' }),
};

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    profiles: {},
    apiVersion: 'v23.0',
    adsApiVersion: 'v26.0',
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

function makeLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

interface Harness {
  readonly fb: FakeFbRequest;
  readonly clock: FakeClock;
  readonly journal: MemoryJournal;
  readonly ctx: WriteToolContext;
}

/** A tool context with the real write gate, as the server bootstrap builds one. */
function makeHarness(
  opts: {
    readonly pages?: FakePageResolver;
    readonly confirmer?: Confirmer;
    readonly writeMode?: WriteMode;
  } = {},
): Harness {
  const fb = createFakeFbRequest();
  const clock = createFakeClock(NOW_MS);
  const journal = createMemoryJournal(clock);
  let planSeq = 0;
  const ctx: WriteToolContext = {
    settings: makeSettings({ adAccountId: ACCOUNT_ID }),
    fbRequest: fb.fn,
    pages: opts.pages ?? createFakePageResolver({ default: PAGE_A }),
    logger: makeLogger(),
    redactor: createFakeRedactor(),
    clock,
    journal,
    writeGate: createWriteGate({
      confirmer: opts.confirmer ?? ALWAYS_CONFIRMS,
      clock,
      journal,
      defaultWriteMode: opts.writeMode ?? 'plan',
      newPlanId: () => `plan-${String(++planSeq)}`,
    }),
  };
  return { fb, clock, journal, ctx };
}

function tool(specs: readonly ToolSpec[], name: string): ToolSpec {
  const spec = specs.find((t) => t.name === name);
  assert.ok(spec, `expected a tool named ${name}`);
  return spec;
}

function postsTool(name: string): ToolSpec {
  return tool(createPostsPackage().tools, name);
}

function adsTool(name: string): ToolSpec {
  return tool(createAdsPackage().tools, name);
}

function body(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '') as Record<string, unknown>;
}

function writes(fb: FakeFbRequest): readonly unknown[] {
  return fb.calls.filter((r) => r.method !== 'GET');
}

// ---------------------------------------------------------------------------
// M03: Graph code 1/2 on a write
// ---------------------------------------------------------------------------

test('guard M03: a transient Graph code on an applied write journals attempted and never replays', async () => {
  // The original guard stops at the HTTP client. This one follows the error up
  // through the gate: the journal must say the write may have landed.
  await withFetch(async (mock: FetchMock) => {
    mock.enqueue({
      status: 400,
      json: { error: { code: 2, message: 'Unavailable', type: 'OAuthException' } },
    });
    const clock = createFakeClock(NOW_MS);
    const journal = createMemoryJournal(clock);
    const fbRequest = createFbRequest({
      settings: makeSettings(),
      clock,
      redactor: createFakeRedactor(),
      logger: makeLogger(),
    });
    const gate = createWriteGate({
      confirmer: ALWAYS_CONFIRMS,
      clock,
      journal,
      defaultWriteMode: 'plan',
      newPlanId: () => 'plan-1',
    });
    const action = {
      tool: 'facebook_create_post',
      tier: 'reversible',
      pageId: PAGE_A.pageId,
      params: { message: 'x' },
      summary: 'Publish a post',
      perform: () =>
        fbRequest({
          protocol: 'json',
          host: 'graph',
          method: 'POST',
          path: `/${PAGE_A.pageId}/feed`,
          token: PAGE_A.token,
          body: { message: 'x' },
        }),
    } as const;
    const planned = await gate.execute(action);
    assert.ok(planned.kind === 'preview');

    await assert.rejects(
      gate.execute({ ...action, apply: true, planId: planned.preview.planId }),
      (err: unknown) => {
        assert.ok(err instanceof GraphApiError);
        assert.equal(err.action?.category, 'ambiguous');
        assert.equal(err.action?.retryable, false);
        return true;
      },
    );
    assert.equal(mock.requests.length, 1, 'an ambiguous write is never replayed');
    assert.deepEqual(
      journal.entries.map((e) => e.outcome),
      ['attempted'],
    );
  });
});

// ---------------------------------------------------------------------------
// M06: a plan is bound to its Page
// ---------------------------------------------------------------------------

test('guard M06: a post planned on one profile cannot be applied through another', async () => {
  const pages = createFakePageResolver({ pages: { a: PAGE_A, b: PAGE_B } });
  const { fb, ctx } = makeHarness({ pages });
  const create = postsTool('facebook_create_post');
  const args = { message: 'Hi', published: true };

  const preview = body(await create.handler({ ...args, profile: 'a' }, ctx));
  assert.equal(preview['status'], 'preview');

  const refused = await create.handler(
    { ...args, profile: 'b', apply: true, plan_id: preview['planId'] },
    ctx,
  );
  assert.equal(refused.isError, true);
  assert.equal(body(refused)['reason'], 'plan_mismatch');
  assert.equal(writes(fb).length, 0, 'nothing reaches Graph');
});

// ---------------------------------------------------------------------------
// M07: the plan TTL boundary
// ---------------------------------------------------------------------------

test('guard M07: a tool call at exactly the plan TTL is refused as expired', async () => {
  const { fb, clock, ctx } = makeHarness();
  const create = postsTool('facebook_create_post');
  const args = { message: 'Hi', published: true };

  const preview = body(await create.handler(args, ctx));
  clock.advance(PLAN_TTL_MS);

  const refused = await create.handler(
    { ...args, apply: true, plan_id: preview['planId'] },
    ctx,
  );
  assert.equal(refused.isError, true);
  assert.equal(body(refused)['reason'], 'plan_expired');
  assert.equal(writes(fb).length, 0, 'nothing reaches Graph');
});

// ---------------------------------------------------------------------------
// M11: only `true` from elicitation is a yes
// ---------------------------------------------------------------------------

test('guard M11: a truthy non-boolean elicitation answer does not delete a post', async () => {
  // The real confirmer behind the real gate, reached through the tool handler.
  const confirmer = createConfirmer({
    elicit: () => Promise.resolve({ confirmed: 'no' } as unknown as ElicitOutcome),
    settings: {},
  });
  const { fb, ctx } = makeHarness({ confirmer });
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${POST_ID}`,
    fbOk({ id: POST_ID, message: 'still here' }),
  );
  const del = postsTool('facebook_delete_post');

  const preview = body(await del.handler({ post_id: POST_ID }, ctx));
  const refused = await del.handler(
    { post_id: POST_ID, apply: true, plan_id: preview['planId'] },
    ctx,
  );

  assert.equal(refused.isError, true);
  assert.equal(body(refused)['reason'], 'confirmation_denied');
  assert.equal(writes(fb).length, 0, 'nothing is deleted');
});

// ---------------------------------------------------------------------------
// M12: a supplied token never falls through to the resolver
// ---------------------------------------------------------------------------

test('guard M12: a null confirm_token through the gate never reaches the token resolver', async () => {
  // The tool schemas refuse `null`, but `createWriteGate` is exported and has no
  // schema in front of it, so the property is checked at the seam that threads
  // the token. An absent token is the control: it does reach the resolver.
  const makeGate = (): {
    readonly gate: ReturnType<typeof createWriteGate>;
    readonly resolved: ConfirmationRequest[];
  } => {
    const clock = createFakeClock(NOW_MS);
    const resolved: ConfirmationRequest[] = [];
    let planSeq = 0;
    const gate = createWriteGate({
      confirmer: createConfirmer({
        settings: { confirmToken: OPERATOR_TOKEN },
        resolveOperatorToken: (request) => {
          resolved.push(request);
          return Promise.resolve(OPERATOR_TOKEN);
        },
      }),
      clock,
      journal: createMemoryJournal(clock),
      defaultWriteMode: 'plan',
      newPlanId: () => `plan-${String(++planSeq)}`,
    });
    return { gate, resolved };
  };
  const makeAction = (performed: string[]) =>
    ({
      tool: 'facebook_delete_post',
      tier: 'irreversible',
      pageId: PAGE_A.pageId,
      params: { post_id: POST_ID },
      summary: 'Delete a post',
      perform: () => {
        performed.push('delete');
        return Promise.resolve('deleted');
      },
    }) as const;

  const denied = makeGate();
  const deniedPerformed: string[] = [];
  const deniedAction = makeAction(deniedPerformed);
  const deniedPlan = await denied.gate.execute(deniedAction);
  assert.ok(deniedPlan.kind === 'preview');
  await assert.rejects(
    denied.gate.execute({
      ...deniedAction,
      apply: true,
      planId: deniedPlan.preview.planId,
      confirmToken: null as unknown as string,
    }),
    (err: unknown) => err instanceof WriteGateError && err.code === 'confirmation_denied',
  );
  assert.equal(denied.resolved.length, 0, 'a supplied value ends the search');
  assert.deepEqual(deniedPerformed, []);

  const absent = makeGate();
  const absentPerformed: string[] = [];
  const absentAction = makeAction(absentPerformed);
  const absentPlan = await absent.gate.execute(absentAction);
  assert.ok(absentPlan.kind === 'preview');
  await absent.gate.execute({
    ...absentAction,
    apply: true,
    planId: absentPlan.preview.planId,
  });
  assert.equal(absent.resolved.length, 1, 'an absent token falls through');
  assert.deepEqual(absentPerformed, ['delete']);
});

// ---------------------------------------------------------------------------
// M13: the EAA pattern covers the whole token alphabet
// ---------------------------------------------------------------------------

test('guard M13: a token with `_` and `-` is masked whole in a Graph error message', () => {
  // The original guard is a log line. This one is the other way a token leaves
  // the process: Graph echoing it back in an error message the model reads.
  // Built at run time so the fixture never looks like a literal credential.
  const token = ['EAAtestFAKE', '_klmnop', '-qrstuvwxyz012345'].join('');
  const redactor = createRedactor();
  assert.equal(redactor.redactString(`t=${token}`), 't=[REDACTED]');

  const err = graphErrorFromResponse(
    400,
    JSON.stringify({
      error: { code: 190, message: `Bad token ${token}`, type: 'OAuthException' },
    }),
    redactor,
  );
  assert.ok(!err.message.includes(token.slice(11)), err.message);
});

// ---------------------------------------------------------------------------
// M14: `paging.next` alone says there is another page
// ---------------------------------------------------------------------------

test('guard M14: a last page with cursors.after and no paging.next ends the listing', async () => {
  const fb = createFakeFbRequest();
  const lastPage = {
    data: [{ id: '1' }],
    paging: { cursors: { before: 'first', after: 'last' } },
  };
  const edge = { host: 'graph', path: '/111/posts', token: PAGE_A.token } as const;
  fb.on(() => true, fbOk(lastPage));

  const page = await fetchPage(fb.fn, edge);
  assert.equal(page.nextCursor, undefined);
  assert.equal(page.truncated, false);

  const all = await fetchAll(fb.fn, edge);
  assert.equal(all.data.length, 1);
  assert.equal(fb.calls.length, 2, 'one request each: a stale cursor is never followed');
});

// ---------------------------------------------------------------------------
// M17: the targeting tool really runs at the spend tier
// ---------------------------------------------------------------------------

test('guard M17: FB_WRITE_MODE=apply does not push a targeting edit past the spend gate', async () => {
  // The original guard reads the tier off the preview label. This one watches
  // what the tier does: the env default must not apply the edit, and the
  // explicit apply must reach the confirmer as spend.
  const confirmed: ConfirmationRequest[] = [];
  const { fb, ctx } = makeHarness({
    writeMode: 'apply',
    confirmer: {
      confirm: (request) => {
        confirmed.push(request);
        return Promise.resolve({ confirmed: false, method: 'denied' });
      },
    },
  });
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${ACCOUNT_ID}`,
    fbOk({ id: ACCOUNT_ID, account_status: 1, currency: 'EUR', name: 'Test account' }),
  );
  fb.on(
    (r) => r.method === 'GET' && r.path === `/${ADSET_ID}`,
    fbOk({
      id: ADSET_ID,
      name: 'Lookalikes',
      account_id: ACCOUNT_ID.slice('act_'.length),
      targeting: {
        age_min: 25,
        age_max: 54,
        geo_locations: { countries: ['US'], location_types: ['home'] },
        publisher_platforms: ['facebook'],
        targeting_automation: { advantage_audience: 0 },
      },
    }),
  );
  const update = adsTool('facebook_update_ad_set_targeting');
  const args = { adset_id: ADSET_ID, age_max: 65 };

  const preview = body(await update.handler(update.inputSchema.parse(args), ctx));
  assert.equal(preview['status'], 'preview');
  assert.equal(writes(fb).length, 0, 'the env default never applies a spend write');

  await assert.rejects(
    () =>
      update.handler(
        update.inputSchema.parse({ ...args, apply: true, plan_id: preview['planId'] }),
        ctx,
      ),
    (err: unknown) => err instanceof WriteGateError && err.code === 'confirmation_denied',
  );
  assert.deepEqual(
    confirmed.map((r) => r.tier),
    ['spend'],
  );
  assert.equal(writes(fb).length, 0, 'a denied confirmation writes nothing');
});
