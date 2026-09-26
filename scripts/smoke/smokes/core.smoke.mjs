// Phase-0 smokes for the always-on `core` package.
//
// `core/identity` is the smoke that tells you WHICH of the two things is broken
// when a later smoke fails: the server/transport, or the token. It touches no
// Page and creates nothing, so it is safe to run anywhere the harness runs.
//
// `core/page-surface` (at the bottom) covers the three remaining read-only core
// tools — Page discovery, single-Page metadata and the rate-limit report. Both
// create nothing, so the sweeper has nothing to do for this file.

import { registerSmoke } from '../registry.mjs';

registerSmoke({
  id: 'core/identity',
  phase: 0,
  title: 'tools/list responds and facebook_whoami reports a valid live token',
  page: 'none',
  writes: false,
  packages: [],
  run: async (ctx) => {
    const listed = await ctx.listTools();
    const names = (listed.tools ?? []).map((tool) => tool.name);
    ctx.assert(names.length > 0, 'tools/list returned no tools at all');
    ctx.assert(
      names.includes('facebook_whoami'),
      `facebook_whoami is missing from tools/list (saw: ${names.join(', ')})`,
    );
    ctx.log.step(`server exposes ${names.length} tool(s)`);

    const who = await ctx.callTool('facebook_whoami', {});
    ctx.assert(
      who.server?.name === 'facebook-mcp',
      `unexpected server name: ${who.server?.name}`,
    );
    ctx.assert(
      typeof who.server?.apiVersion === 'string' && who.server.apiVersion.startsWith('v'),
      `unexpected pinned Graph API version: ${who.server?.apiVersion}`,
    );
    ctx.assert(
      who.token?.valid === true,
      `the configured token is not valid: ${who.error ?? JSON.stringify(who.token)}`,
    );
    ctx.assert(Array.isArray(who.token.scopes), 'whoami reported no scopes array');

    // Scope NAMES are permissions, not secrets — printing them is the fastest
    // way to diagnose "why did this Page call 403". The token itself never
    // appears in the payload at all (C3).
    ctx.log.step(
      `token type "${who.token.type}" on ${who.server.apiVersion}; scopes: ${
        who.token.scopes.length === 0 ? '(none)' : who.token.scopes.join(', ')
      }`,
    );
  },
});

// ---------------------------------------------------------------------------
// core/page-surface — the three read-only core tools nothing else touches
// ---------------------------------------------------------------------------
//
// `facebook_list_pages`, `facebook_get_page` and `facebook_usage` are the last
// read tools with no live coverage at all. They are deliberately NOT registered
// as accepted gaps: an accepted gap is a contract that CANNOT be exercised (see
// `messages/send-not-covered`, `ads/update-not-covered`,
// `posts/video-not-covered`), and these three are free, read-only GETs against a
// Page the harness already holds. Labelling them "not covered" would have called
// an oversight a decision.
//
// What they prove, beyond "the call did not throw":
//   * `facebook_list_pages` NEVER returns a Page access token. It asks Graph for
//     `access_token` and keeps only the derived `hasToken` — the one place in the
//     server where a secret is fetched and deliberately dropped (C3). A live run
//     is the only way to prove the REAL Graph response is stripped; a fixture
//     test can only prove the fixture was.
//   * `facebook_get_page` resolves the same Page the profile names, and the raw
//     Graph node echoes that id — so a wrong-Page read is detectable rather than
//     plausible-looking metadata about somebody else's Page.
//   * `facebook_usage` is honest about having no data. Its percentages are parsed
//     out of response HEADERS, which Graph may simply omit, so `hasData:false`
//     must arrive with the note that explains it — and `hasData:true` must not.
//
// The three share one registration because they share one server spawn and touch
// nothing between them; three registrations would mean three child processes for
// three GETs. Everything that could not be verified is accumulated and reported
// in a SINGLE `ctx.notExercised` at the end, so an unexercised first tool never
// costs the coverage of the two after it.
registerSmoke({
  id: 'core/page-surface',
  phase: 0,
  title: 'List Pages without leaking a token, read one Page back, and report usage',
  // `facebook_get_page` resolves a profile, so this needs the read Page. The
  // other two are account-scoped and touch no Page at all.
  page: 'read',
  writes: false,
  packages: [],
  run: async (ctx) => {
    /** Contracts this run could not put any evidence behind. */
    const unverified = [];

    // ---- 1. facebook_list_pages: the token-suppression contract -----------
    // Read raw: /me/accounts is an edge of the USER node, so a Page-token-only
    // credential cannot walk it. That is a fact about the operator's token, not
    // a defect in the server, and must be reported as neither pass nor failure.
    const pagesResult = await ctx.callToolRaw('facebook_list_pages', {});
    if (pagesResult.isError === true) {
      unverified.push(
        'the C3 contract that facebook_list_pages fetches a Page access token and ' +
          'DROPS it before the payload: /me/accounts is an edge of the USER node, so ' +
          'the configured credential cannot enumerate Pages at all (a bare ' +
          `FB_PAGE_TOKEN never can) — Graph said: ${String(pagesResult.payload?.error ?? 'no message')}`,
      );
    } else {
      const listed = pagesResult.payload;
      const pages = ctx.unwrap(listed.pages);
      ctx.assert(Array.isArray(pages), `pages is not an array: ${typeof pages}`);
      ctx.assert(
        listed.count === pages.length,
        `count ${listed.count} disagrees with the array length ${pages.length}`,
      );
      // The WHOLE payload, not just the rows: a token must not survive anywhere
      // in it — not under another key, not inside a note.
      ctx.assert(
        JSON.stringify(listed).includes('access_token') === false,
        'facebook_list_pages leaked an access_token into its payload',
      );
      for (const page of pages) {
        ctx.assert(
          typeof page?.id === 'string' && page.id.length > 0,
          'a listed Page carries no id, so it cannot be addressed',
        );
        ctx.assert(
          typeof page.hasToken === 'boolean',
          `Page ${page.id} reports hasToken=${String(page.hasToken)}, expected a boolean`,
        );
        ctx.assert(
          Array.isArray(page.tasks),
          `Page ${page.id} carries no tasks array, so its permissions are unreadable`,
        );
      }
      if (pages.length === 0) {
        unverified.push(
          'the C3 token-suppression contract: facebook_list_pages returned no Pages, ' +
            'so there was no row that could have carried a token — only the ' +
            'empty-listing shape was checked',
        );
      } else {
        ctx.log.step(`${pages.length} Page(s), no token anywhere in the payload`);
      }
    }

    // ---- 2. facebook_get_page: the Page really is the one asked for -------
    const page = await ctx.callTool('facebook_get_page', { profile: ctx.profile });
    ctx.assert(
      page.pageId === ctx.pages.readPageId,
      `get_page resolved Page ${String(page.pageId)}, expected ${ctx.pages.readPageId}`,
    );
    const node = ctx.unwrap(page.page);
    ctx.assert(
      node !== null && typeof node === 'object',
      `get_page returned no Page node: ${typeof node}`,
    );
    ctx.assert(
      String(node.id) === ctx.pages.readPageId,
      `the Graph node reports id ${String(node.id)}, but the tool resolved ${ctx.pages.readPageId}`,
    );
    ctx.log.step(`read Page ${page.pageId} back by profile`);

    // ---- 3. facebook_usage: honest about missing headers ------------------
    const usage = await ctx.callTool('facebook_usage', {});
    ctx.assert(
      usage.usage !== null && typeof usage.usage === 'object',
      'facebook_usage returned no usage object',
    );
    ctx.assert(
      typeof usage.usage.seenAt === 'number',
      `usage.seenAt is ${typeof usage.usage.seenAt}, expected a number`,
    );
    ctx.assert(
      usage.usage.raw !== null && typeof usage.usage.raw === 'object',
      'usage carries no raw header map',
    );
    ctx.assert(
      typeof usage.hasData === 'boolean',
      `hasData is ${typeof usage.hasData}, expected a boolean`,
    );

    if (usage.hasData === false) {
      // The empty case has its own contract — it must EXPLAIN itself — so this
      // half is still asserted rather than skipped.
      ctx.assert(
        typeof usage.note === 'string' && usage.note.length > 0,
        'usage reported no data and did not say why — an unexplained empty result',
      );
      unverified.push(
        'the rate-limit header parsing (X-App-Usage, X-Business-Use-Case-Usage, ' +
          'x-fb-ads-insights-throttle ⇒ percentages): Graph returned no usage headers ' +
          'on the probe request, so only the honest no-data shape was exercised',
      );
    } else {
      ctx.assert(
        usage.note === undefined,
        `usage reported data yet carried the no-data note: ${String(usage.note)}`,
      );
      ctx.assert(
        Object.keys(usage.usage.raw).length > 0,
        'hasData is true but no raw header was recorded',
      );
      for (const key of ['appUsagePct', 'businessUseCasePct', 'adsInsightsThrottlePct']) {
        const value = usage.usage[key];
        ctx.assert(
          value === undefined || (typeof value === 'number' && Number.isFinite(value)),
          `${key} came back as ${String(value)}, which is not a usable percentage`,
        );
      }
      ctx.log.step(`usage headers parsed: ${Object.keys(usage.usage.raw).join(', ')}`);
    }

    if (unverified.length > 0) {
      ctx.notExercised(unverified.join('; ALSO '));
    }
  },
});
