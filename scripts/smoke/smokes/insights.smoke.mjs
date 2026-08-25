// Phase-1 smokes for the V02 insights vertical (`insights` package).
//
// Read-only by construction: every call here is a GET against the READ Page,
// nothing is created or changed, so `page: 'read'` is safe and there is no
// sweeper to write. `ctx.applyWrite` is never used.
//
// What these prove, beyond "the call did not throw":
//
//   * insights/page — the RESHAPE CONTRACT holds against LIVE data: rows are
//     flat and carry only `{metric, date?, breakdown?, value}` (Graph's
//     per-entry `title`/`description`/`id` boilerplate and the per-point
//     `end_time`/`period` are gone), there is exactly one summary per metric
//     Graph answered, and each summary's `points` agrees with the number of
//     rows carrying that metric. Then the SAME request is re-read with
//     `aggregate:true`: totals-only mode must DROP `rows` while reporting the
//     identical period/points/total/rowsAvailable. That cross-check is the real
//     value of this smoke — a fixture proves each path in isolation, only a live
//     run proves the two paths read the same numbers off the same window.
//   * insights/row-cap — a wide window against a small `max_rows` must be
//     truncated LOUDLY: `truncated === true`, `rowsAvailable` above the returned
//     row count, a note naming both figures and the aggregate escape hatch, and
//     a per-metric `points` that still reports the UNCAPPED series length. A
//     silently short series is exactly the bug this smoke exists to catch.
//   * insights/unknown-metric — a bogus metric name is never silently dropped.
//     Live Graph has two legitimate answers here (omit the entry, or reject the
//     whole metric list — the api module documents and handles both), so both
//     branches are asserted to be SELF-DESCRIBING; a third, silent outcome fails.
//   * insights/post — the composite post id round-trips from
//     `facebook_list_posts` into `facebook_post_insights`, and an all-empty
//     result is EXPLAINED (publish lag / "Reel metrics live on the other edge")
//     instead of looking like zero engagement. The Page-only eligibility note
//     must not leak onto a post.
//   * insights/reel-guardrail — the newly shipped `facebook_reel_insights`
//     refuses a `{page-id}_{post-id}` composite in its INPUT SCHEMA, before any
//     Graph call, and the refusal points at the VIDEO id. No Reel is created
//     here: Reel creation consumes the 30-per-24h budget and is owned by another
//     file. When the read Page already has Reels, the first one is additionally
//     read and must come back keyed as `videoId`, never `postId`.
//
// One deliberate asymmetry, worth stating because the schema (not the prompt)
// decides it: `facebook_post_insights` does NOT reject a bare video id. Its
// `post_id` pattern is `^(?=.*\w)[\w.-]+$` — path containment against dot
// segments, not a composite-shape check — so a digits-only id parses fine and
// the confusion is handled at the RESULT end instead, by the empty-series note
// that names /video_insights (asserted by insights/post). The only schema-level
// rejections that exist are the composite handed to the Reel tool and a
// URL-shaped id handed to the post tool; those are the two asserted below.

import { registerSmoke } from '../registry.mjs';

// ---------------------------------------------------------------------------
// Metric names
//
// Every name here is one the SERVER itself references, so the smoke stays
// honest about the pinned Graph version instead of inventing a vocabulary.
// ---------------------------------------------------------------------------

/**
 * Page metrics, quoted verbatim from `metricsArg` in src/tools/insights.ts
 * (`["page_media_view","page_follows"]`). These are the POST-rename spellings:
 * the pre-wave names (`page_impressions`, `page_fans`) sit in the api module's
 * deprecation table and would be dropped before the request ever leaves, which
 * would smoke-test the rename table rather than the live edge.
 */
const PAGE_METRICS = ['page_media_view', 'page_follows'];

/** The one daily-series Page metric used where a long series is the point. */
const PAGE_SERIES_METRIC = 'page_media_view';

/**
 * The live replacement the api module's deprecation table names for
 * `post_impressions` (2025-11 wave). Because the server asserts this name is
 * alive, a Graph rejection of it is a real finding and is allowed to fail here.
 */
const POST_METRIC = 'post_media_view';

/**
 * A Reel metric taken from `facebook_reel_insights`'s own description. That
 * list is explicitly "examples, not a whitelist", so a Graph rejection of this
 * name is reported and tolerated below rather than failed.
 */
const REEL_METRIC = 'blue_reels_play_count';

/**
 * A name Graph certainly does not know — the same deliberate typo
 * src/tools/insights.test.ts uses, and absent from the deprecation table, so it
 * is genuinely SENT to Graph instead of being dropped client-side.
 */
const BOGUS_METRIC = 'page_vieuws_total';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/** The UTC calendar date `offsetDays` before today, in Graph's YYYY-MM-DD form. */
function utcDay(offsetDays) {
  return new Date(Date.now() - offsetDays * MS_PER_DAY).toISOString().slice(0, 10);
}

/** The only keys a reshaped row may carry (`InsightRow` in src/api/insights.ts). */
const ROW_KEYS = new Set(['metric', 'date', 'breakdown', 'value']);

/** First note matching `pattern`, or undefined. */
function noteMatching(payload, pattern) {
  const notes = Array.isArray(payload?.notes) ? payload.notes : [];
  return notes.find((note) => typeof note === 'string' && pattern.test(note));
}

/**
 * The row shape IS the contract (CC-INS-4): flat, compact, and stripped of
 * Graph's boilerplate. An extra key here means `title`, `description`, `id`,
 * `end_time` or the per-point `period` leaked through the reshape and is eating
 * the result budget on every single data point.
 */
function assertRowShape(ctx, rows, where) {
  rows.forEach((row, index) => {
    const extra = Object.keys(row ?? {}).filter((key) => !ROW_KEYS.has(key));
    ctx.assert(
      extra.length === 0,
      `${where}: row ${index} carries unexpected key(s) ${extra.join(', ')} — ` +
        `Graph boilerplate leaked through the reshape`,
    );
    ctx.assert(
      typeof row.metric === 'string' && row.metric.length > 0,
      `${where}: row ${index} carries no metric name`,
    );
    ctx.assert(
      typeof row.value === 'number' || typeof row.value === 'string',
      `${where}: row ${index} has a non-scalar value ${JSON.stringify(row.value)}`,
    );
  });
}

/**
 * An insights result with no rows must SAY why. Two shapes count as an
 * explanation, and they are different situations:
 *
 *   * Graph answered for the metric but with zero points ⇒ the scope's own
 *     empty-series note (lag / wrong edge / publish state) plus the USER-token
 *     ambiguity hint;
 *   * Graph never mentioned the metric ⇒ it is reported in `unavailableMetrics`
 *     with the "no entry for" note, which is a name problem, not a data problem.
 *
 * Anything else — no rows, no summary, no report — is the silent zero this
 * server exists to avoid. `forbidden` catches a note from a DIFFERENT scope
 * leaking in (the Page follower floor has no business on a post or a Reel).
 */
function assertEmptyExplained(ctx, payload, opts) {
  const summaries = Array.isArray(payload.metrics) ? payload.metrics : [];
  const answeredButEmpty =
    summaries.length > 0 && summaries.every((summary) => summary.points === 0);

  if (answeredButEmpty) {
    const note = noteMatching(payload, opts.expect);
    ctx.assert(
      note !== undefined,
      `${opts.where}: an all-empty result carries no explanation (notes: ${JSON.stringify(
        payload.notes,
      )})`,
    );
    for (const phrase of opts.phrases) {
      ctx.assert(
        note.includes(phrase),
        `${opts.where}: the empty-result note never mentions "${phrase}": ${note}`,
      );
    }
    ctx.assert(
      noteMatching(payload, /USER token/) !== undefined,
      `${opts.where}: the silent USER-token cause of an empty series is not named`,
    );
  } else {
    const unavailable = Array.isArray(payload.unavailableMetrics)
      ? payload.unavailableMetrics
      : [];
    ctx.assert(
      unavailable.includes(opts.metric),
      `${opts.where}: "${opts.metric}" produced no rows, no summary and no ` +
        `"unavailable" report — that is a silent drop`,
    );
    ctx.assert(
      noteMatching(payload, /^Graph returned no entry for/) !== undefined,
      `${opts.where}: an unavailable metric was not explained by a note`,
    );
  }

  for (const pattern of opts.forbidden) {
    ctx.assert(
      noteMatching(payload, pattern) === undefined,
      `${opts.where}: a note belonging to another scope leaked in (${String(pattern)})`,
    );
  }
}

// ---------------------------------------------------------------------------
// insights/page — the reshape contract and the series ⇄ aggregate cross-check
// ---------------------------------------------------------------------------

registerSmoke({
  id: 'insights/page',
  phase: 1,
  title: 'Read Page insights, then re-read the same window as totals-only',
  page: 'read',
  writes: false,
  packages: ['reader', 'insights'],
  run: async (ctx) => {
    // A short window that ENDS BEFORE TODAY: both reads below must see the same
    // already-computed buckets (insights lag by minutes to hours), and seven
    // days over two metrics can never approach the 250-row cap.
    const request = {
      profile: ctx.profile,
      metrics: PAGE_METRICS,
      period: 'day',
      since: utcDay(8),
      until: utcDay(2),
    };

    const series = await ctx.callTool('facebook_page_insights', request);

    ctx.assert(
      series.pageId === ctx.pages.readPageId,
      `page_insights resolved Page ${series.pageId}, expected ${ctx.pages.readPageId}`,
    );
    ctx.assert(series.mode === 'series', `expected series mode, got ${series.mode}`);
    ctx.assert(
      series.period === 'day',
      `expected the requested period, got ${series.period}`,
    );
    ctx.assert(
      series.truncated === false,
      `a 7-day window must not hit the row cap (rowsAvailable=${series.rowsAvailable})`,
    );

    const rows = series.rows;
    ctx.assert(Array.isArray(rows), 'series mode returned no `rows` array');
    assertRowShape(ctx, rows, 'page_insights');
    ctx.assert(
      series.rowsAvailable === rows.length,
      `rowsAvailable ${series.rowsAvailable} disagrees with ${rows.length} untruncated rows`,
    );

    const queried = series.queriedMetrics ?? [];
    const unavailable = series.unavailableMetrics ?? [];
    // Both requested names are post-rename spellings, so nothing may be dropped
    // by the deprecation table before the request.
    ctx.assert(
      queried.length === PAGE_METRICS.length,
      `queriedMetrics [${queried.join(', ')}] does not match the ${PAGE_METRICS.length} requested names`,
    );
    ctx.assert(
      (series.deprecatedMetrics ?? []).length === 0,
      'a post-rename metric name was reported as deprecated',
    );

    const summaries = series.metrics;
    ctx.assert(Array.isArray(summaries), 'no `metrics` summary array came back');
    // One summary per metric Graph answered; the rest are accounted for by name
    // in `unavailableMetrics`, never by simply going missing from both.
    ctx.assert(
      summaries.length + unavailable.length === queried.length,
      `${summaries.length} summaries + ${unavailable.length} unavailable != ${queried.length} queried metrics`,
    );
    for (const summary of summaries) {
      ctx.assert(
        queried.includes(summary.metric),
        `a summary came back for un-requested metric ${summary.metric}`,
      );
      ctx.assert(
        typeof summary.period === 'string' && summary.period.length > 0,
        `summary for ${summary.metric} carries no period`,
      );
      const own = rows.filter((row) => row.metric === summary.metric).length;
      ctx.assert(
        summary.points === own,
        `metric ${summary.metric}: summary reports ${summary.points} point(s) but ${own} row(s) carry it`,
      );
    }

    if (rows.length === 0 && summaries.length > 0) {
      ctx.assert(
        noteMatching(series, /eligibility floor/) !== undefined,
        'an all-empty Page result must be explained by the eligibility floor, not left as zeros',
      );
      ctx.log.step(
        'read Page returned no data points; the eligibility note explains why',
      );
    }

    // The cross-check: the SAME window, totals only. No fixture can prove these
    // two code paths agree on live data — only reading both can.
    const totals = await ctx.callTool('facebook_page_insights', {
      ...request,
      aggregate: true,
    });

    ctx.assert(
      totals.mode === 'aggregate',
      `expected aggregate mode, got ${totals.mode}`,
    );
    ctx.assert(
      Object.hasOwn(totals, 'rows') === false,
      'aggregate mode must DROP the rows key entirely, not return an empty array',
    );
    ctx.assert(
      totals.truncated === false,
      'aggregate mode emits no rows, so it can never report row truncation',
    );
    ctx.assert(
      totals.pageId === series.pageId,
      `aggregate resolved Page ${totals.pageId}, series resolved ${series.pageId}`,
    );
    ctx.assert(
      JSON.stringify(totals.window) === JSON.stringify(series.window),
      `the two reads echoed different windows: ${JSON.stringify(series.window)} vs ${JSON.stringify(totals.window)}`,
    );
    ctx.assert(
      totals.rowsAvailable === series.rowsAvailable,
      `aggregate saw ${totals.rowsAvailable} data points, the series read saw ${series.rowsAvailable}`,
    );

    const totalSummaries = totals.metrics ?? [];
    ctx.assert(
      totalSummaries.length === summaries.length,
      `aggregate returned ${totalSummaries.length} summaries, the series read returned ${summaries.length}`,
    );
    for (const summary of summaries) {
      const twin = totalSummaries.find((item) => item.metric === summary.metric);
      ctx.assert(
        twin !== undefined,
        `aggregate mode lost the summary for ${summary.metric}`,
      );
      ctx.assert(
        twin.period === summary.period &&
          twin.points === summary.points &&
          twin.total === summary.total,
        `totals disagree for ${summary.metric}: series ${JSON.stringify(summary)} vs aggregate ${JSON.stringify(twin)}`,
      );
    }

    ctx.log.step(
      `${rows.length} row(s) over ${queried.length} metric(s); aggregate agreed on every total`,
    );
  },
});

// ---------------------------------------------------------------------------
// insights/row-cap — truncation must be loud
// ---------------------------------------------------------------------------

/** Deliberately tiny, so any Page with a month of daily data exceeds it. */
const SMALL_CAP = 5;

registerSmoke({
  id: 'insights/row-cap',
  phase: 1,
  title: 'A wide window against a small max_rows truncates loudly, never silently',
  page: 'read',
  writes: false,
  packages: ['reader', 'insights'],
  run: async (ctx) => {
    const capped = await ctx.callTool('facebook_page_insights', {
      profile: ctx.profile,
      metrics: [PAGE_SERIES_METRIC],
      period: 'day',
      since: utcDay(30),
      until: utcDay(1),
      max_rows: SMALL_CAP,
    });

    ctx.assert(
      capped.pageId === ctx.pages.readPageId,
      `page_insights resolved Page ${capped.pageId}, expected ${ctx.pages.readPageId}`,
    );
    const rows = capped.rows;
    ctx.assert(Array.isArray(rows), 'series mode returned no `rows` array');
    assertRowShape(ctx, rows, 'page_insights');

    if (capped.rowsAvailable <= SMALL_CAP) {
      // Nothing to drop — but then the result must not CLAIM a truncation
      // either, which is the other half of the same honesty property.
      ctx.assert(
        capped.truncated === false,
        `nothing exceeded the cap (${capped.rowsAvailable} point(s)) yet the result reports truncation`,
      );
      ctx.assert(
        rows.length === capped.rowsAvailable,
        `no truncation, but ${rows.length} rows came back for ${capped.rowsAvailable} available points`,
      );
      ctx.log.step(
        `read Page returned only ${capped.rowsAvailable} data point(s) over 30 days ` +
          `(unavailable: ${(capped.unavailableMetrics ?? []).join(', ') || 'none'}) — ` +
          'the row cap could not be exercised',
      );
      return;
    }

    ctx.assert(
      rows.length === SMALL_CAP,
      `max_rows ${SMALL_CAP} was requested but ${rows.length} rows came back`,
    );
    ctx.assert(
      capped.truncated === true,
      'the cap was applied but the result does not admit it',
    );
    ctx.assert(
      capped.rowsAvailable > rows.length,
      `truncated, yet rowsAvailable ${capped.rowsAvailable} is not above the ${rows.length} returned rows`,
    );

    const note = noteMatching(capped, /^Row cap reached/);
    ctx.assert(note !== undefined, 'rows were dropped without the note that explains it');
    ctx.assert(
      note.includes(`kept the first ${SMALL_CAP} of ${capped.rowsAvailable} data points`),
      `the truncation note does not name the real figures: ${note}`,
    );
    ctx.assert(
      note.includes('aggregate:true'),
      'the truncation note does not point at the way to get the whole picture',
    );

    // The per-metric summary is computed BEFORE the cap, so it still reports the
    // full series length — that is what makes a capped result self-describing.
    const summary = (capped.metrics ?? [])[0];
    ctx.assert(summary !== undefined, `no summary came back for ${PAGE_SERIES_METRIC}`);
    ctx.assert(
      summary.points === capped.rowsAvailable,
      `summary reports ${summary.points} point(s) but ${capped.rowsAvailable} were available`,
    );
    ctx.log.step(
      `kept ${rows.length} of ${capped.rowsAvailable} point(s), and said so in the notes`,
    );
  },
});

// ---------------------------------------------------------------------------
// insights/unknown-metric — a name Graph does not know is never dropped silently
// ---------------------------------------------------------------------------

registerSmoke({
  id: 'insights/unknown-metric',
  phase: 1,
  title: 'A bogus metric name is reported, never silently dropped',
  page: 'read',
  writes: false,
  packages: ['reader', 'insights'],
  run: async (ctx) => {
    // `callToolRaw`, because one of the two legitimate live outcomes IS a tool
    // error and this smoke asserts on its text rather than being killed by it.
    const { payload, isError } = await ctx.callToolRaw('facebook_page_insights', {
      profile: ctx.profile,
      metrics: [PAGE_SERIES_METRIC, BOGUS_METRIC],
      period: 'day',
      since: utcDay(3),
      until: utcDay(1),
    });

    if (isError) {
      // Outcome 1: Graph refused the whole metric list (it fails the entire call
      // over a single bad name). The api module must still hand back something
      // actionable — Graph's own text lists hundreds of valid names and is
      // useless to a model.
      const message = String(payload?.error ?? '');
      ctx.assert(
        message.includes('NO metric was read'),
        `a metric rejection must say the whole call failed, got: ${message}`,
      );
      ctx.assert(
        message.includes('one metric at a time'),
        `a metric rejection must say how to isolate the bad name, got: ${message}`,
      );
      ctx.log.step(
        'Graph rejected the whole metric list; the server explained it and said how to isolate the name',
      );
      return;
    }

    // Outcome 2: Graph answered and simply omitted the entry.
    ctx.assert(
      payload.pageId === ctx.pages.readPageId,
      `page_insights resolved Page ${payload.pageId}, expected ${ctx.pages.readPageId}`,
    );
    ctx.assert(
      (payload.deprecatedMetrics ?? []).length === 0,
      'neither requested name is in the rename table, so nothing may be reported as deprecated',
    );
    // The bogus name is absent from the deprecation table, so it was genuinely
    // SENT — this is what makes "Graph never mentioned it" meaningful.
    ctx.assert(
      (payload.queriedMetrics ?? []).includes(BOGUS_METRIC),
      `${BOGUS_METRIC} never reached Graph, so its absence proves nothing`,
    );

    const unavailable = payload.unavailableMetrics ?? [];
    ctx.assert(
      unavailable.includes(BOGUS_METRIC),
      `${BOGUS_METRIC} was dropped silently: unavailableMetrics is [${unavailable.join(', ')}]`,
    );
    ctx.assert(
      (payload.emptyMetrics ?? []).includes(BOGUS_METRIC) === false,
      'a name Graph never mentioned must not be reported as "valid but empty"',
    );

    const note = noteMatching(payload, /^Graph returned no entry for/);
    ctx.assert(note !== undefined, 'an unavailable metric came back without its note');
    ctx.assert(
      note.includes(BOGUS_METRIC),
      `the note does not name the metric it is about: ${note}`,
    );
    ctx.assert(
      note.includes('different from a valid metric with no data'),
      `the note does not separate an invalid name from an empty series: ${note}`,
    );
    ctx.log.step(
      `"${BOGUS_METRIC}" was reported as unavailable, with an actionable note`,
    );
  },
});

// ---------------------------------------------------------------------------
// insights/post — the id round-trip and the explained empty result
// ---------------------------------------------------------------------------

registerSmoke({
  id: 'insights/post',
  phase: 1,
  title: 'Read insights for the newest published post, id round-trip included',
  page: 'read',
  writes: false,
  packages: ['reader', 'insights'],
  run: async (ctx) => {
    const listed = await ctx.callTool('facebook_list_posts', {
      profile: ctx.profile,
      edge: 'published_posts',
      limit: 3,
    });
    // `published_posts` is Page-authored and therefore not taint-wrapped; unwrap
    // defensively so this keeps working if that default ever changes.
    const posts = ctx.unwrap(listed.posts);
    ctx.assert(Array.isArray(posts), `posts is not an array: ${typeof posts}`);

    if (posts.length === 0) {
      ctx.log.step(
        'read Page has no published posts — post insights not exercised (an empty Page is not a failure)',
      );
      return;
    }

    const newest = posts[0];
    ctx.assert(
      typeof newest.id === 'string' && newest.id.length > 0,
      'the newest post carries no id',
    );

    const insights = await ctx.callTool('facebook_post_insights', {
      profile: ctx.profile,
      post_id: newest.id,
      metrics: [POST_METRIC],
    });

    ctx.assert(
      insights.pageId === ctx.pages.readPageId,
      `post_insights resolved Page ${insights.pageId}, expected ${ctx.pages.readPageId}`,
    );
    ctx.assert(
      insights.postId === newest.id,
      `post id did not round-trip: sent ${newest.id}, got back ${insights.postId}`,
    );
    ctx.assert(
      Object.hasOwn(insights, 'videoId') === false,
      'a post must never be reported under the Reel key',
    );
    ctx.assert(
      insights.period === 'lifetime',
      `a post defaults to cumulative lifetime values, got period ${insights.period}`,
    );

    const rows = insights.rows;
    ctx.assert(Array.isArray(rows), 'series mode returned no `rows` array');
    assertRowShape(ctx, rows, 'post_insights');

    if (rows.length === 0) {
      assertEmptyExplained(ctx, insights, {
        where: 'post_insights',
        metric: POST_METRIC,
        expect: /just-published post/,
        // The lag AND the Reels edge, because "empty" has two common causes and
        // they need different fixes.
        phrases: ['video_insights', 'facebook_reel_insights'],
        forbidden: [/eligibility floor/],
      });
      ctx.log.step(`post ${newest.id} has no data points yet, and the result says why`);
      return;
    }

    for (const row of rows) {
      ctx.assert(
        row.metric === POST_METRIC,
        `a row came back for un-requested metric ${row.metric}`,
      );
    }
    ctx.log.step(`post ${newest.id}: ${rows.length} row(s) for ${POST_METRIC}`);
  },
});

// ---------------------------------------------------------------------------
// insights/reel-guardrail — the id-space guard, at zero Graph cost
// ---------------------------------------------------------------------------

registerSmoke({
  id: 'insights/reel-guardrail',
  phase: 1,
  title: 'facebook_reel_insights refuses a post composite before any Graph call',
  page: 'read',
  writes: false,
  packages: ['reader', 'insights'],
  run: async (ctx) => {
    // 1. The negative half. Costs nothing: the composite never leaves the
    //    server, so this half runs even on a Page with no Reels at all.
    const composite = `${ctx.pages.readPageId}_1234567890`;
    const rejected = await ctx.callToolRaw('facebook_reel_insights', {
      profile: ctx.profile,
      video_id: composite,
      metrics: [REEL_METRIC],
    });

    ctx.assert(
      rejected.isError === true,
      `facebook_reel_insights accepted the post composite ${composite}`,
    );
    const message = String(rejected.payload?.error ?? '');
    ctx.assert(
      /VIDEO id/.test(message),
      `the refusal does not point at the VIDEO id: ${message}`,
    );
    ctx.assert(
      message.includes('digits only'),
      `the refusal does not describe the id shape it wants: ${message}`,
    );
    ctx.assert(
      message.includes('facebook_create_reel'),
      `the refusal does not say where a VIDEO id comes from: ${message}`,
    );
    // A schema rejection carries nothing but `error`; a Graph failure would have
    // brought `code`/`httpStatus` along. This is the proof that no Graph call
    // was made — the guard is in the input schema, not in the error mapping.
    ctx.assert(
      rejected.payload?.code === undefined && rejected.payload?.httpStatus === undefined,
      `the composite reached Graph: ${JSON.stringify(rejected.payload)}`,
    );

    // The post tool has its own path-containment guard. It deliberately does NOT
    // reject a bare video id (a digits-only string is a legal post-id shape), so
    // the URL form is what can be asserted here; the video-id-on-the-post-edge
    // confusion is handled at the result end, by the note insights/post asserts.
    const permalink = await ctx.callToolRaw('facebook_post_insights', {
      profile: ctx.profile,
      post_id: 'https://www.facebook.com/somepage/posts/1234567890',
      metrics: [POST_METRIC],
    });
    ctx.assert(
      permalink.isError === true,
      'facebook_post_insights accepted a permalink URL as a post id',
    );
    ctx.assert(
      String(permalink.payload?.error ?? '').includes(
        'not a URL, a permalink or a query string',
      ),
      `the permalink refusal is not the schema's: ${String(permalink.payload?.error ?? '')}`,
    );
    ctx.log.step('both id-space guards refused before reaching Graph');

    // 2. The positive half, only if the read Page already has Reels. Creating
    //    one is budget-gated (30 per 24 h) and owned by another smoke file.
    const listed = await ctx.callTool('facebook_list_reels', {
      profile: ctx.profile,
      limit: 1,
    });
    const reels = ctx.unwrap(listed.reels);
    ctx.assert(Array.isArray(reels), `reels is not an array: ${typeof reels}`);

    if (reels.length === 0) {
      ctx.log.step(
        'read Page has no Reels — the live /video_insights read is not exercised (no Reel is created here)',
      );
      return;
    }

    const reel = reels[0];
    // The two tools must agree on the id space: whatever the reader lists has to
    // be accepted verbatim by the Reel insights schema.
    ctx.assert(
      typeof reel.id === 'string' && /^\d+$/.test(reel.id),
      `facebook_list_reels returned id ${String(reel.id)}, which facebook_reel_insights would refuse`,
    );

    const read = await ctx.callToolRaw('facebook_reel_insights', {
      profile: ctx.profile,
      video_id: reel.id,
      metrics: [REEL_METRIC],
    });

    if (read.isError) {
      // The Reel metric vocabulary is documented as "examples, not a whitelist",
      // so a name this Graph version does not serve is a finding about Meta, not
      // a bug here — but the server still has to say so actionably.
      const text = String(read.payload?.error ?? '');
      ctx.assert(
        text.includes('NO metric was read') && text.includes('one metric at a time'),
        `an unusable Reel metric was not reported actionably: ${text}`,
      );
      ctx.log.warn(
        `the pinned Graph version does not serve "${REEL_METRIC}" on /video_insights; ` +
          'the server reported it as an isolatable metric rejection',
      );
      return;
    }

    const reelInsights = read.payload;
    ctx.assert(
      reelInsights.videoId === reel.id,
      `video id did not round-trip: sent ${reel.id}, got back ${reelInsights.videoId}`,
    );
    ctx.assert(
      Object.hasOwn(reelInsights, 'postId') === false,
      'a Reel must never be echoed under a post key — that is the confusion the schema just refused',
    );
    ctx.assert(
      reelInsights.pageId === ctx.pages.readPageId,
      `reel_insights resolved Page ${reelInsights.pageId}, expected ${ctx.pages.readPageId}`,
    );
    ctx.assert(
      reelInsights.period === 'lifetime',
      `/video_insights is a lifetime edge; got period ${reelInsights.period}`,
    );

    const rows = reelInsights.rows;
    ctx.assert(Array.isArray(rows), 'series mode returned no `rows` array');
    assertRowShape(ctx, rows, 'reel_insights');

    if (rows.length === 0) {
      assertEmptyExplained(ctx, reelInsights, {
        where: 'reel_insights',
        metric: REEL_METRIC,
        expect: /VIDEO id/,
        phrases: ['PUBLISHED', 'lag minutes to hours'],
        // Neither the Page follower floor nor the post lag story belongs here.
        forbidden: [/eligibility floor/, /just-published post/],
      });
      ctx.log.step(
        `reel ${reel.id} reports no plays yet, and the result says what to check`,
      );
      return;
    }
    ctx.log.step(`reel ${reel.id}: ${rows.length} row(s) for ${REEL_METRIC}`);
  },
});
