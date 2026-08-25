// Phase-5 smokes for the `ads` vertical (Marketing API).
//
// SCOPE: READ ONLY, WITHOUT EXCEPTION. Every registration in this file declares
// `writes: false`, and `facebook_update_ad_object` is NEVER called — not with
// `apply: true`, not as a dry run. See the third registration at the bottom for
// why even the preview is out of bounds here.
//
// Nothing in this file creates, changes or deletes remote state, so the ads
// vertical needs no sweeper: there is no artifact to leak.
//
// TWO DIFFERENT OPT-INS, for two different costs
//
//   * `ads/read-surface` talks to a real ad account. It spends no money, but it
//     consumes that account's Marketing API rate-limit score — a budget shared
//     with whatever real tooling the operator runs against the same account — and
//     it needs `FB_AD_ACCOUNT_ID` pointed at an account the token can read. Hence
//     `budget: 'ads'` (excluded from a default run; opt in with `--include-budget`
//     or `--only ads/read-surface`) plus `requires: ['FB_AD_ACCOUNT_ID']`, which
//     only bites once the smoke is actually selected.
//
//   * `ads/guardrails` makes NO Graph call at all — every assertion is about an
//     input the server must refuse before the wire. It is free, so it runs by
//     default. It does pull the `ads` package into `FB_TOOL_PACKAGES` for the
//     whole run, which is safe: the harness forces `FB_WRITE_MODE=plan`, and no
//     smoke here ever hands `facebook_update_ad_object` a plan id.
//
// WHY THESE ASSERTIONS AND NOT OTHERS. Three ads contracts can only be proven
// against live data, because they are about what Meta actually returns:
//
//   1. CC-ADS-2 — delivery truth. `status` is what the account holder configured;
//      `effective_status` is what Meta is doing about it. The `delivering` flag
//      must be derived from the latter, never the former, and an ACTIVE object
//      under a paused parent is the case that catches a wrong derivation. The
//      smoke asserts `delivering === (effective_status === 'ACTIVE')` on every
//      record it sees, at both the listing and the single-object read.
//   2. CC-ADS-3 — money is integers. Budgets come back as `*_minor` fields in the
//      account currency (1000 = 10.00). A float anywhere in that chain is a
//      rounding bug waiting to become a real overspend, so every budget value
//      that surfaces is asserted to be an integer.
//   3. CC-ADS-5 — the async report path. A large insights query is answered with
//      `mode: "async"`, a `reportRunId` and NO rows; the probe tool answers once
//      and never loops. Whichever path the live account takes, the smoke asserts
//      the shape of that path — including the part that matters most, that an
//      unfinished run never masquerades as an empty result set.

import { registerSmoke } from '../registry.mjs';

/** `normalizeAdAccountId` output — the only form the tools should ever echo. */
const ACCOUNT_ID_SHAPE = /^act_\d+$/;

/** `reportRunIdArg` accepts digits only. */
const REPORT_RUN_ID_SHAPE = /^\d+$/;

/** Every phase `classifyAsyncStatus` can report (src/api/ads-read.ts). */
const REPORT_PHASES = new Set([
  'pending',
  'running',
  'complete',
  'failed',
  'skipped',
  'unknown',
]);

/** The phases that mean the run will never change again. */
const TERMINAL_PHASES = new Set(['complete', 'failed', 'skipped']);

/** The two budget fields, both minor units, both integers or absent. */
const BUDGET_FIELDS = ['daily_budget_minor', 'lifetime_budget_minor'];

/** How many campaigns the read smoke asks for — enough to see variety, small
 *  enough to stay cheap against a real account's rate-limit score. */
const CAMPAIGN_LIMIT = 10;

/**
 * The invariants every ads record carries, whichever tool produced it. Asserted
 * per record rather than on the first one: a delivery flag derived from the
 * wrong field is most likely to be wrong on exactly the object that differs.
 */
function assertAdRecord(ctx, record, where) {
  ctx.assert(
    typeof record?.id === 'string' && record.id.length > 0,
    `${where}: record carries no id`,
  );
  ctx.assert(
    typeof record.delivering === 'boolean',
    `${where} (${record.id}): delivering is ${typeof record.delivering}, not a boolean`,
  );
  ctx.assert(
    typeof record.status_explanation === 'string' && record.status_explanation.length > 0,
    `${where} (${record.id}): no status_explanation — the delivery state would be unexplained`,
  );

  // CC-ADS-2. The trap this exists for: `status: "ACTIVE"` under a paused parent
  // reports `effective_status: "CAMPAIGN_PAUSED"` and must NOT read as delivering.
  ctx.assert(
    record.delivering === (record.effective_status === 'ACTIVE'),
    `${where} (${record.id}): delivering=${String(record.delivering)} but ` +
      `effective_status=${String(record.effective_status)} — the flag is not derived ` +
      'from the delivery truth (CC-ADS-2)',
  );
  if (record.status === 'ACTIVE' && record.effective_status !== 'ACTIVE') {
    ctx.log.step(
      `${record.id}: configured ACTIVE but effective_status=${String(
        record.effective_status,
      )} — the live case CC-ADS-2 exists for`,
    );
  }

  // CC-ADS-3. Minor units, integers only — a float here is a money bug.
  for (const field of BUDGET_FIELDS) {
    const value = record[field];
    if (value === undefined || value === null) {
      continue;
    }
    ctx.assert(
      Number.isInteger(value),
      `${where} (${record.id}): ${field} is ${JSON.stringify(value)} — budgets are ` +
        'INTEGER minor currency units, never floats (CC-ADS-3)',
    );
  }
}

/** True when a record carries either budget field — mirrors `hasBudget`. */
function carriesBudget(record) {
  return BUDGET_FIELDS.some(
    (field) => record[field] !== undefined && record[field] !== null,
  );
}

registerSmoke({
  id: 'ads/read-surface',
  phase: 5,
  title: 'List campaigns, read one back by id, and read account insights (read-only)',
  // The ads tools are account-scoped, not Page-scoped: they take `ad_account_id`
  // and have no `profile` argument at all. No Page is touched either way.
  page: 'none',
  writes: false,
  budget: 'ads',
  packages: ['ads'],
  requires: ['FB_AD_ACCOUNT_ID'],
  run: async (ctx) => {
    // ---- 1. the listing -------------------------------------------------
    const listed = await ctx.callTool('facebook_list_campaigns', {
      limit: CAMPAIGN_LIMIT,
    });

    ctx.assert(
      ACCOUNT_ID_SHAPE.test(String(listed.accountId)),
      `accountId came back as ${String(listed.accountId)} — the tools must echo the ` +
        'normalised act_<digits> form, whatever FB_AD_ACCOUNT_ID was written as',
    );
    ctx.assert(
      listed.level === 'campaign',
      `listing reported level ${String(listed.level)}, expected "campaign"`,
    );

    const campaigns = ctx.unwrap(listed.objects);
    ctx.assert(Array.isArray(campaigns), `objects is not an array: ${typeof campaigns}`);
    ctx.assert(
      listed.count === campaigns.length,
      `count ${listed.count} disagrees with the array length ${campaigns.length}`,
    );
    ctx.assert(
      typeof listed.truncated === 'boolean',
      `truncated is ${typeof listed.truncated}, not a boolean`,
    );
    ctx.assert(
      Array.isArray(listed.notes) && listed.notes.length > 0,
      'the listing carries no notes — the effective_status pin is missing',
    );
    ctx.log.step(
      `${campaigns.length} campaign(s) on ${listed.accountId}, ` +
        `truncated=${String(listed.truncated)}`,
    );

    for (const campaign of campaigns) {
      assertAdRecord(ctx, campaign, 'facebook_list_campaigns');
    }
    ctx.assert(
      listed.hasBudgets === campaigns.some(carriesBudget),
      `hasBudgets=${String(listed.hasBudgets)} disagrees with the records themselves`,
    );

    if (campaigns.length === 0) {
      // A real ad account with no campaigns is a legitimate state, not a failure:
      // the read path and the account resolution are proven, the per-object
      // round-trip simply has no material. Graph also hides ARCHIVED and DELETED
      // objects by default, which the listing's own note says.
      ctx.log.step(
        'ad account has no visible campaigns — the id round-trip was not exercised',
      );
    } else {
      // ---- 2. one object, by id ----------------------------------------
      const first = campaigns[0];
      const read = await ctx.callTool('facebook_get_ad_object', {
        object_id: first.id,
        level: 'campaign',
      });
      ctx.assert(
        read.objectId === first.id,
        `object id did not round-trip: sent ${first.id}, got back ${String(read.objectId)}`,
      );
      const object = ctx.unwrap(read.object);
      ctx.assert(
        object?.id === first.id,
        `the record came back with id ${String(object?.id)}, expected ${first.id}`,
      );
      assertAdRecord(ctx, object, 'facebook_get_ad_object');
      ctx.log.step(`round-tripped campaign ${first.id}`);
    }

    // ---- 3. account-level insights --------------------------------------
    // `all_days` and a short preset on purpose: the cheapest query that still
    // proves the path, and the one least likely to be pushed onto the async
    // route by size alone. Which route it takes is the account's call, not the
    // smoke's — both are asserted below.
    const insights = await ctx.callTool('facebook_ads_insights', {
      date_preset: 'last_7d',
      time_increment: 'all_days',
      limit: 5,
    });

    ctx.assert(
      insights.mode === 'sync' || insights.mode === 'async',
      `unexpected insights mode: ${String(insights.mode)}`,
    );
    ctx.assert(
      insights.objectId === listed.accountId,
      `insights reported objectId ${String(insights.objectId)}, expected the account ` +
        `${listed.accountId} — omitting object_id must mean account-level`,
    );
    ctx.assert(
      Array.isArray(insights.notes),
      'the insights result carries no notes array',
    );

    if (insights.mode === 'sync') {
      const rows = ctx.unwrap(insights.rows) ?? [];
      ctx.assert(Array.isArray(rows), `rows is not an array: ${typeof rows}`);
      ctx.assert(
        insights.rowCount === rows.length,
        `rowCount ${String(insights.rowCount)} disagrees with ${rows.length} row(s)`,
      );
      ctx.assert(
        insights.reportRunId === undefined,
        'a synchronous result carries a reportRunId — nothing should be polled',
      );
      // Zero rows is DATA, not an error: the account did not deliver in the
      // window. Saying so out loud beats a silent pass that looks like coverage.
      ctx.log.step(
        rows.length === 0
          ? 'insights returned no rows — the account did not deliver in the last 7 days'
          : `insights returned ${rows.length} row(s) synchronously`,
      );
      return;
    }

    // ---- 3b. the async report path (CC-ADS-5) ---------------------------
    ctx.assert(
      typeof insights.reportRunId === 'string' &&
        REPORT_RUN_ID_SHAPE.test(insights.reportRunId),
      `async insights returned reportRunId ${JSON.stringify(insights.reportRunId)}, ` +
        'expected the numeric run id to poll',
    );
    ctx.assert(
      insights.rows === undefined,
      'an async result carries rows — it must return the run id and NOTHING else, or ' +
        'an unfinished run reads as "this query has no data"',
    );
    ctx.log.step(`insights fell back to async run ${insights.reportRunId}`);

    // ONE probe, never a loop: the tool's whole contract is that it answers once
    // and tells the caller when to stop (CC-ADS-5). A smoke that polled to
    // completion would be asserting Meta's queue latency, not this server's
    // behaviour — and would hang a run for as long as Meta felt like.
    const status = await ctx.callTool('facebook_ads_report_status', {
      report_run_id: insights.reportRunId,
    });
    ctx.assert(
      status.reportRunId === insights.reportRunId,
      `report run id did not round-trip: sent ${insights.reportRunId}, got back ` +
        String(status.reportRunId),
    );
    ctx.assert(
      REPORT_PHASES.has(status.phase),
      `unexpected report phase: ${String(status.phase)}`,
    );
    ctx.assert(
      status.terminal === TERMINAL_PHASES.has(status.phase),
      `phase ${String(status.phase)} reports terminal=${String(status.terminal)}`,
    );
    ctx.assert(
      status.resultsReady !== true || status.phase === 'complete',
      `phase ${String(status.phase)} claims resultsReady — only a completed run has rows`,
    );
    ctx.assert(
      typeof status.advice === 'string' && status.advice.length > 0,
      'the probe returned no advice — the caller would not know when to stop polling',
    );
    ctx.log.step(`report run is ${status.phase} (terminal=${String(status.terminal)})`);
  },
});

// ---------------------------------------------------------------------------
// Refusals that never reach the wire
// ---------------------------------------------------------------------------
//
// Both cases below are rejected by the tool's own input schema, BEFORE the
// handler runs (src/mcp/define.ts parses the input first). That is what makes
// this smoke free and account-independent — and it is also what the assertion
// on the error payload proves: `buildErrorRecord` (src/index.ts) attaches `code`
// and `httpStatus` only to a GraphApiError. A payload carrying neither is a
// schema rejection, which means no request was ever built. A locally raised
// GraphApiError would carry `code: 100, httpStatus: 400` and would look the same
// to a human reading the message alone.
registerSmoke({
  id: 'ads/guardrails',
  phase: 5,
  title: 'Ads-Manager URLs and non-numeric run ids are refused before any Graph call',
  page: 'none',
  writes: false,
  packages: ['ads'],
  run: async (ctx) => {
    // 1. An Ads Manager link instead of an id. This is the most common way a
    //    model gets an ads id wrong, and `object_id` is interpolated straight
    //    into `/{objectId}`, so the shape check is path containment rather than
    //    cosmetics.
    const url = await ctx.callToolRaw('facebook_get_ad_object', {
      object_id: 'https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=1',
    });
    ctx.assert(url.isError === true, 'an Ads Manager URL was accepted as an object id');
    const urlMessage = String(url.payload?.error ?? '');
    ctx.assert(
      urlMessage.includes('Ads Manager'),
      `the refusal does not point at Ads Manager links: ${urlMessage}`,
    );
    ctx.assert(
      url.payload?.code === undefined && url.payload?.httpStatus === undefined,
      `the refusal carries code=${String(url.payload?.code)} / httpStatus=` +
        `${String(url.payload?.httpStatus)} — that is a Graph error, so the id reached the wire`,
    );

    // 2. A report run id that is not a run id. `facebook_ads_report_status` only
    //    ever accepts the digits `facebook_ads_insights` handed back.
    const run = await ctx.callToolRaw('facebook_ads_report_status', {
      report_run_id: 'run-42',
    });
    ctx.assert(run.isError === true, 'a non-numeric report_run_id was accepted');
    const runMessage = String(run.payload?.error ?? '');
    ctx.assert(
      runMessage.includes('reportRunId'),
      `the refusal does not name reportRunId: ${runMessage}`,
    );
    ctx.assert(
      run.payload?.code === undefined && run.payload?.httpStatus === undefined,
      `the refusal carries code=${String(run.payload?.code)} / httpStatus=` +
        `${String(run.payload?.httpStatus)} — that is a Graph error, so the id reached the wire`,
    );

    // 3. The spend-tier tool is present and annotated as what it is. Asserted
    //    from `tools/list` rather than by calling it: this is the one ads tool
    //    this harness must never invoke, and its annotations are what a client
    //    uses to decide whether to prompt a human first.
    const listed = await ctx.listTools();
    const update = (listed.tools ?? []).find(
      (tool) => tool.name === 'facebook_update_ad_object',
    );
    ctx.assert(
      update !== undefined,
      'facebook_update_ad_object is missing from tools/list although the ads package is loaded',
    );
    ctx.assert(
      update.annotations?.readOnlyHint === false &&
        update.annotations?.destructiveHint === true,
      `facebook_update_ad_object is annotated ${JSON.stringify(update.annotations)} — a ` +
        'tool that can resume spending must not read as safe',
    );
    ctx.log.step(
      'both malformed ids refused before the wire; spend tool correctly annotated',
    );
  },
});

// ---------------------------------------------------------------------------
// facebook_update_ad_object — DELIBERATELY NOT COVERED BY A LIVE SMOKE
// ---------------------------------------------------------------------------
//
// Registered as a no-op so the gap is visible in `--list` and in every run,
// rather than quietly absent. It calls no tool and asserts nothing; there is no
// pretend coverage here.
//
// Why not even a dry run:
//   1. There is no safe object to point it at. The harness can create a Page post
//      and delete it again; it CANNOT create a campaign — this server has no
//      create verb for ads objects at all, by design (doc 06: creating and
//      deleting ads objects belongs in Ads Manager). So any exercise would target
//      an object a real advertiser owns and is spending on.
//   2. A dry run is not free of consequence here either. `facebook_update_ad_object`
//      reads the ad account and the object BEFORE `executeWrite`, and the plan it
//      returns names before → after values for a real campaign — but more to the
//      point, the preview's purpose is to be applied, and the only way to prove
//      the apply half is to apply it. Pausing someone's campaign to prove a smoke
//      passes is not a trade this harness makes.
//   3. Resuming an object or raising a budget is `spend` tier, and `spend` is
//      excluded from the harness's confirmation branch on purpose
//      (scripts/smoke/README.md, "Confirmation"): no amount of harness
//      configuration may auto-approve a write that moves money. A smoke that
//      needed a human to approve each apply is not a smoke.
//
// What IS covered without it: the plan itself is pure. `planAdObjectUpdate`
// takes the current record and the requested change and returns the tier, the
// summary, the warnings and the refusals (read-only object, both budget kinds at
// once, an amount over FB_ADS_BUDGET_CEILING) with no request involved — which is
// why those live in the unit tests (src/tools/ads.test.ts, src/api/ads-control.test.ts)
// and not here. A live smoke would add nothing they do not already pin.
//
// What an operator must do BY HAND, once, on an account they own:
//   a. pick a PAUSED campaign that is not scheduled to resume;
//   b. call `facebook_update_ad_object` with `status: "PAUSED"` and no `apply` —
//      confirm the preview reports `applied: false`, a no-op summary, and the
//      rate-limit warning;
//   c. call it with `daily_budget_minor` set above FB_ADS_BUDGET_CEILING — confirm
//      it is REFUSED, not clamped, and that the refusal names the ceiling;
//   d. only if the account is genuinely disposable: apply a PAUSED → PAUSED write
//      and confirm the plan id is single-use (a second apply with the same id
//      comes back `plan_mismatch`).
registerSmoke({
  id: 'ads/update-not-covered',
  phase: 5,
  title: 'NOT COVERED LIVE: facebook_update_ad_object would target a real advertiser',
  page: 'none',
  writes: false,
  run: async (ctx) => {
    ctx.log.step(
      'facebook_update_ad_object is not smoked: this server cannot create an ads object ' +
        'to practise on, so any call — dry run included — would target a campaign someone ' +
        'is really spending on. See the comment above this registration for the manual check.',
    );
  },
});
