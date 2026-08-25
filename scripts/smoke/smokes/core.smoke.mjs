// Phase-0 smoke: the shipped server starts, speaks MCP, and the configured
// credential actually works against the live Graph API.
//
// This is the smoke that tells you WHICH of the two things is broken when a
// later smoke fails: the server/transport, or the token. It touches no Page and
// creates nothing, so it is safe to run anywhere the harness runs at all.

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
