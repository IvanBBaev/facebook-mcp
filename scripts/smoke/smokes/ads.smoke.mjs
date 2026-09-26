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
//   * `ads/read-surface` and `ads/hierarchy` talk to a real ad account. They spend
//     no money, but they consume that account's Marketing API rate-limit score — a
//     budget shared with whatever real tooling the operator runs against the same
//     account — and they need `FB_AD_ACCOUNT_ID` pointed at an account the token
//     can read. Hence `budget: 'ads'` on both (excluded from a default run; opt in
//     with `--include-budget` or `--only <id>`) plus `requires: ['FB_AD_ACCOUNT_ID']`,
//     which only bites once the smoke is actually selected.
//
//   * `ads/guardrails` makes NO Graph call at all — every assertion is about an
//     input the server must refuse before the wire. It is free, so it runs by
//     default. It does pull the `ads` package into `FB_TOOL_PACKAGES` for the
//     whole run, which is safe: the harness forces `FB_WRITE_MODE=plan`, and no
//     smoke here ever hands `facebook_update_ad_object` a plan id.
//
// WHY THESE ASSERTIONS AND NOT OTHERS. Four ads contracts can only be proven
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
//   4. THE PARENT CHAIN. An ad set names its `campaign_id`, an ad names both its
//      `adset_id` and its `campaign_id`, and those ids only point anywhere in
//      live data. A level wired to the wrong field set drops them; a listing
//      answered for the wrong parent keeps them and fills them with somebody
//      else's ids — and that failure looks exactly like ordinary data until
//      someone pauses "the parent" and stops something they did not mean to.
//      `ads/hierarchy` follows every id it is handed back to the object it names.

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

/** How many objects each listing asks for — enough to see variety, small enough
 *  to stay cheap against a real account's rate-limit score AND to keep the whole
 *  page comfortably inside the result budget (see `assertListing`). */
const LISTING_LIMIT = 10;

/** The review outcomes the ad level is documented to surface, and the only ones
 *  `EFFECTIVE_STATUS_EXPLANATIONS` must never fall through on (src/api/ads-read.ts). */
const REVIEW_STATUSES = new Set(['PENDING_REVIEW', 'DISAPPROVED', 'WITH_ISSUES']);

/** How `describeEffectiveStatus` opens when a status is NOT in its table. */
const UNRECOGNISED_EXPLANATION = 'Unrecognised effective status';

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

/** The distinct effective statuses in a page, for the run log. */
function statusSummary(records) {
  const seen = [...new Set(records.map((record) => String(record.effective_status)))];
  return seen.length === 0 ? 'no records' : `effective_status: ${seen.join(', ')}`;
}

/** Compare Graph's bare `account_id` with the normalised `act_<digits>` echo. */
function sameAccount(normalized, raw) {
  return String(normalized).replace(/^act_/, '') === String(raw).replace(/^act_/, '');
}

/**
 * The envelope contract EVERY ads listing carries, whatever level produced it.
 * One helper rather than a copy per level, for the same reason the server answers
 * all three listings from one handler (`listLevel`, src/tools/ads.ts): a per-level
 * copy is three chances for the contract to drift, and drift at the level nobody
 * reads closely is the drift that ships.
 *
 * A note on `ctx.unwrap`: ads records are NOT taint-wrapped, and that is correct
 * rather than an oversight. The taint envelope covers content a STRANGER authored
 * — `comment`, `message`, `visitor_post`, `user_profile` are the whole source list
 * (src/mcp/taint.ts) — and a campaign name is written by the ad account holder,
 * i.e. by the operator running this smoke. Nothing here asserts the ABSENCE of the
 * envelope: that would pin a decision nobody promised and would fight anyone who
 * later decides advertiser-authored text deserves it anyway. The unwrap stays so
 * the call site reads like every other listing in this harness and keeps working
 * either way.
 *
 * Returns the records, so a caller can go on to the fields its own level owns.
 */
function assertListing(ctx, listed, { tool, level, limit }) {
  ctx.assert(
    ACCOUNT_ID_SHAPE.test(String(listed.accountId)),
    `${tool}: accountId came back as ${String(listed.accountId)} — the tools must echo ` +
      'the normalised act_<digits> form, whatever FB_AD_ACCOUNT_ID was written as',
  );
  ctx.assert(
    listed.level === level,
    `${tool}: listing reported level ${String(listed.level)}, expected "${level}"`,
  );

  // The shaper trims arrays when a payload exceeds FB_MAX_RESULT_CHARS and says so
  // in `_truncation` (src/mcp/result.ts), while `count` is computed BEFORE that.
  // A trimmed page would therefore fail the count check below and read as "the
  // server dropped rows". Named here so that never has to be debugged.
  ctx.assert(
    listed._truncation === undefined,
    `${tool}: the result budget truncated this payload (${String(listed._truncation)}) — ` +
      'lower the limit or raise FB_MAX_RESULT_CHARS; no count below means anything now',
  );

  const objects = ctx.unwrap(listed.objects);
  ctx.assert(
    Array.isArray(objects),
    `${tool}: objects is not an array: ${typeof objects}`,
  );
  // `count` is the server's own claim about the array beside it. A shaping layer
  // that drops a row leaves both numbers plausible and only their DISAGREEMENT
  // visible, so this is the one place row loss can be caught at all.
  ctx.assert(
    listed.count === objects.length,
    `${tool}: count ${String(listed.count)} disagrees with the array length ${objects.length}`,
  );
  ctx.assert(
    objects.length <= limit,
    `${tool}: asked for ${limit} object(s) and got ${objects.length} — the page limit ` +
      'did not reach Graph, so a listing costs whatever Graph feels like returning',
  );
  ctx.assert(
    typeof listed.truncated === 'boolean',
    `${tool}: truncated is ${typeof listed.truncated}, not a boolean`,
  );
  ctx.assert(
    Array.isArray(listed.notes) && listed.notes.length > 0,
    `${tool}: the listing carries no notes — the effective_status pin is missing`,
  );

  // An empty page is the one answer a reader is most likely to over-read. Graph
  // hides ARCHIVED and DELETED objects unless asked, so "no ad sets" may mean
  // "none you can see" — and the server owes that sentence rather than an empty
  // array that looks like a fact about the account (src/api/ads-read.ts).
  if (objects.length === 0 && listed.truncated === false) {
    ctx.assert(
      listed.notes.some((note) => String(note).includes('ARCHIVED')),
      `${tool}: an empty listing came back without the note explaining that Graph hides ` +
        'ARCHIVED and DELETED objects — "none" would read as a fact about the account',
    );
  }

  for (const record of objects) {
    assertAdRecord(ctx, record, tool);
  }
  ctx.assert(
    listed.hasBudgets === objects.some(carriesBudget),
    `${tool}: hasBudgets=${String(listed.hasBudgets)} disagrees with the records themselves`,
  );
  return objects;
}

/**
 * Follow one parent id back to the object it names, and return that object.
 *
 * An ads id is opaque digits: it encodes neither the level of the object nor the
 * account that owns it. So a listing answered for the wrong ad account, or a
 * level wired to another level's field set, hands back parent ids that are
 * perfectly well-formed and point at somebody else's campaigns — and every
 * downstream reader treats them as the chain it asked for. The id echo plus the
 * account comparison is the only thing that can tell the two apart from out here.
 *
 * `level` is always passed: it is what selects the per-level DETAIL field set,
 * and `account_id` — the field this whole check turns on — is in that set and
 * NOT in the fields common to every ads object (src/api/ads-read.ts).
 */
async function resolveParent(ctx, { child, parentId, level, accountId }) {
  const read = await ctx.callTool('facebook_get_ad_object', {
    object_id: parentId,
    level,
  });
  ctx.assert(
    read.objectId === parentId,
    `facebook_get_ad_object: sent ${parentId}, got back ${String(read.objectId)}`,
  );
  ctx.assert(
    read.level === level,
    `facebook_get_ad_object: asked for level "${level}", the result reports ` +
      `${String(read.level)} — the richer field set may not be the one that was read`,
  );

  const object = ctx.unwrap(read.object);
  ctx.assert(
    object?.id === parentId,
    `${child} names ${level} ${parentId}, but that id read back as ` +
      `${String(object?.id)} — a parent id that resolves to a DIFFERENT object`,
  );
  assertAdRecord(ctx, object, `facebook_get_ad_object (${level})`);

  ctx.assert(
    typeof object.account_id === 'string' && object.account_id.length > 0,
    `${level} ${parentId} came back without account_id, so the chain cannot be checked ` +
      'against the account that was listed — the detail field set did not reach Graph',
  );
  // The failure this exists for: a plausible id belonging to another advertiser.
  // Nothing else in the payload would look wrong, and pausing "the parent" would
  // stop an object the operator has never seen.
  ctx.assert(
    sameAccount(accountId, object.account_id),
    `${child} names ${level} ${parentId}, which belongs to account ` +
      `${String(object.account_id)} and not to ${accountId} — the listing and the parent ` +
      'chain disagree about whose objects these are',
  );
  return object;
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
      limit: LISTING_LIMIT,
    });
    const campaigns = assertListing(ctx, listed, {
      tool: 'facebook_list_campaigns',
      level: 'campaign',
      limit: LISTING_LIMIT,
    });
    ctx.log.step(
      `${campaigns.length} campaign(s) on ${listed.accountId}, ` +
        `truncated=${String(listed.truncated)} — ${statusSummary(campaigns)}`,
    );

    if (campaigns.length === 0) {
      // A real ad account with no campaigns is a legitimate state, not a failure:
      // the read path and the account resolution are proven, the per-object
      // round-trip simply has no material. Graph also hides ARCHIVED and DELETED
      // objects by default, which the listing's own note says — and which
      // `assertListing` has just insisted the server actually said.
      //
      // This is `notExercised` rather than a log line because the two read very
      // differently in the summary: a log line disappears into a PASS, and a PASS
      // on this smoke is later quoted as "the id round-trip works". It does not
      // work or fail here — it was never asked.
      ctx.notExercised(
        'facebook_get_ad_object was never called: with no visible campaign there is no ' +
          'id to hand back, so nothing here proves an id from a listing is accepted ' +
          'verbatim, echoed unchanged, and answered with the SAME object',
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
// The parent chain
// ---------------------------------------------------------------------------
//
// `facebook_list_adsets` and `facebook_list_ads` are answered by the same handler
// as `facebook_list_campaigns` (`listLevel`, src/tools/ads.ts), so the envelope is
// already proven by `ads/read-surface`. What is NOT proven by it is everything the
// level itself decides: which fields each level asks Graph for, and the parent ids
// that only exist below the campaign. Those ids are account-scoped guesses until
// something resolves them — there is no parent filter on any listing (all three
// share `listAdArgs`), so the chain can only be walked upwards, one id at a time.
registerSmoke({
  id: 'ads/hierarchy',
  phase: 5,
  title: 'List ad sets and ads, then follow each parent id back to the object it names',
  page: 'none',
  writes: false,
  budget: 'ads',
  packages: ['ads'],
  requires: ['FB_AD_ACCOUNT_ID'],
  run: async (ctx) => {
    // ---- 1. ad sets: the level that owns budget and schedule -------------
    const adsetPage = await ctx.callTool('facebook_list_adsets', {
      limit: LISTING_LIMIT,
    });
    const adsets = assertListing(ctx, adsetPage, {
      tool: 'facebook_list_adsets',
      level: 'adset',
      limit: LISTING_LIMIT,
    });
    ctx.log.step(
      `${adsets.length} ad set(s) on ${adsetPage.accountId}, ` +
        `hasBudgets=${String(adsetPage.hasBudgets)} — ${statusSummary(adsets)}`,
    );

    for (const record of adsets) {
      // Without `campaign_id` an ad set is an orphan: the one question a model is
      // asked about a stalled ad set — "which campaign do I resume?" — becomes
      // unanswerable without opening Ads Manager.
      ctx.assert(
        typeof record.campaign_id === 'string' && record.campaign_id.length > 0,
        `facebook_list_adsets (${record.id}): no campaign_id — the ad set names no parent`,
      );
      // `targeting` is kept out of the listing field set deliberately: one spec can
      // outweigh the entire result budget, so a page of ten would come back trimmed
      // and the count check in `assertListing` would fail for a reason that has
      // nothing to do with the listing.
      ctx.assert(
        record.targeting === undefined,
        `facebook_list_adsets (${record.id}): a targeting spec rode along in a listing that ` +
          'does not ask for one — a page of these is what blows the result budget',
      );
    }

    if (adsets.length === 0) {
      // Legitimate on a real account (nothing built yet, or everything archived —
      // which Graph hides, as the listing's own note says). It is still not
      // evidence: with no ad set there is no campaign id to resolve.
      ctx.notExercised(
        'facebook_list_adsets returned no ad sets, so nothing here proves an ad set names ' +
          'its campaign, nor that the campaign id it names resolves to a campaign on the ' +
          'same ad account',
      );
    } else {
      if (!adsetPage.hasBudgets) {
        // Not a defect: under campaign budget optimisation the money sits on the
        // campaign and the ad sets carry none at all. Said out loud because a
        // silent pass here would read as "ad-set budgets were checked".
        ctx.notExercised(
          'no ad set in the page carries a daily or lifetime budget — under campaign budget ' +
            'optimisation the budget lives on the campaign instead, so the integer minor-unit ' +
            'check (CC-ADS-3) had no ad-set budget to look at',
        );
      }

      // ---- 2. ad set → campaign ------------------------------------------
      const adset = adsets[0];
      await resolveParent(ctx, {
        child: `ad set ${adset.id}`,
        parentId: String(adset.campaign_id),
        level: 'campaign',
        accountId: adsetPage.accountId,
      });
      ctx.log.step(`ad set ${adset.id} → campaign ${String(adset.campaign_id)}`);
    }

    // ---- 3. ads: the level where review outcomes surface -----------------
    const adPage = await ctx.callTool('facebook_list_ads', { limit: LISTING_LIMIT });
    const ads = assertListing(ctx, adPage, {
      tool: 'facebook_list_ads',
      level: 'ad',
      limit: LISTING_LIMIT,
    });
    ctx.log.step(`${ads.length} ad(s) on ${adPage.accountId} — ${statusSummary(ads)}`);

    // An ad has no budget of its own, and the ad field set asks for none. A budget
    // surfacing here would mean the ad level had been pointed at the ad set's field
    // list — after which every "what is this spending?" question is answered one
    // level too low, against a number nobody set on the ad.
    ctx.assert(
      adPage.hasBudgets === false,
      'facebook_list_ads: the listing reports budgets, but an ad has no budget of its own — ' +
        'budgets live on the ad set, or on the campaign under budget optimisation',
    );

    for (const record of ads) {
      // Both parents, because an ad is two levels down and either link alone leaves
      // the other hop to guesswork.
      ctx.assert(
        typeof record.adset_id === 'string' && record.adset_id.length > 0,
        `facebook_list_ads (${record.id}): no adset_id — the ad names no ad set`,
      );
      ctx.assert(
        typeof record.campaign_id === 'string' && record.campaign_id.length > 0,
        `facebook_list_ads (${record.id}): no campaign_id — the ad names no campaign`,
      );
      // Same reasoning as `targeting` above: the full creative spec is the other
      // blob that can be larger than the whole payload it travels in.
      ctx.assert(
        record.creative === undefined,
        `facebook_list_ads (${record.id}): a creative blob rode along in a listing that does ` +
          'not ask for one',
      );
    }

    const underReview = ads.filter((record) =>
      REVIEW_STATUSES.has(String(record.effective_status)),
    );
    if (underReview.length === 0) {
      ctx.notExercised(
        'no ad in the page came back PENDING_REVIEW, DISAPPROVED or WITH_ISSUES, and this ' +
          'harness cannot produce one (it creates no ads at all) — so the review outcomes ' +
          'only the ad level surfaces went unexercised on live data',
      );
    } else {
      for (const record of underReview) {
        // A review outcome that falls through to the unrecognised-status line reads
        // to a model as "state unknown", which is exactly the sentence a rejected
        // ad must never be described with.
        ctx.assert(
          !String(record.status_explanation).startsWith(UNRECOGNISED_EXPLANATION),
          `facebook_list_ads (${record.id}): effective_status ` +
            `${String(record.effective_status)} fell through to the unrecognised-status ` +
            'line, so a reviewed ad comes back unexplained',
        );
      }
      ctx.log.step(
        `${underReview.length} ad(s) under review or restricted, each with an explanation`,
      );
    }

    if (ads.length === 0) {
      ctx.notExercised(
        'facebook_list_ads returned no ads, so the two-hop chain was never walked: nothing ' +
          'here proves an ad and its own ad set agree about which campaign they belong to',
      );
      return;
    }

    // ---- 4. ad → ad set, and the two-hop agreement ------------------------
    const ad = ads[0];
    const parentAdset = await resolveParent(ctx, {
      child: `ad ${ad.id}`,
      parentId: String(ad.adset_id),
      level: 'adset',
      accountId: adPage.accountId,
    });

    // The point of the whole scenario. The ad names a campaign and its ad set names
    // a campaign; the two come from different Graph reads at different levels, and a
    // level wired to the wrong parent field is the failure where each id is
    // individually plausible and only their DISAGREEMENT is visible.
    ctx.assert(
      parentAdset.campaign_id === ad.campaign_id,
      `ad ${ad.id} names campaign ${String(ad.campaign_id)}, but its own ad set ` +
        `${String(ad.adset_id)} names ${String(parentAdset.campaign_id)} — the two halves ` +
        'of the same chain disagree',
    );
    ctx.log.step(
      `ad ${ad.id} → ad set ${String(ad.adset_id)} → campaign ${String(ad.campaign_id)}, ` +
        'all three agree',
    );

    // Schedule is an ad-set field, and only the DETAIL read asks for it — the
    // listing leaves start/end out to keep a page small, so this is the one place
    // it can be seen at all. A timestamp that does not parse is worse than a
    // missing one: it dates the flight wrong wherever something does arithmetic.
    if (typeof parentAdset.start_time === 'string') {
      ctx.assert(
        Number.isFinite(Date.parse(parentAdset.start_time)),
        `ad set ${String(ad.adset_id)}: start_time ${JSON.stringify(parentAdset.start_time)} ` +
          'is not a parseable timestamp',
      );
    } else {
      ctx.notExercised(
        `ad set ${String(ad.adset_id)} came back with no start_time, so the schedule half of ` +
          'the ad-set level — the fields only the per-level detail read asks for — went ' +
          'unchecked',
      );
    }
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
