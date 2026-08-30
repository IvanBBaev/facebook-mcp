// The `core` tool package (task F16) — always-on identity, Page discovery and
// rate-limit diagnostics. Four READ-ONLY tools, no writes, so `core` is a
// read-only posture even when it is the only package enabled (doc 06
// "Package `core` (always on)").
//
//   * facebook_whoami     — classify the configured token (type / validity /
//                           scopes / expiry) + report server, MCP SDK and API
//                           version. Server-owned envelope (structuredContent,
//                           CC-MCP-7).
//   * facebook_list_pages — the Pages the operator administers (`/me/accounts`):
//                           id, name, category, tasks, and token presence.
//   * facebook_get_page   — metadata for one resolved Page (profile-scoped).
//   * facebook_usage      — last-seen rate-limit headers as a UsageSnapshot.
//                           Server-owned envelope (structuredContent, CC-MCP-7).
//
// Layer 3 (`tools`): imports the frozen `core` contracts + `core` helpers
// (debugToken, parseUsageHeaders) and the `mcp` authoring/shaping helpers
// (defineTool, shapeResult, shapeEnvelope). It never reaches into a sibling
// tool package and depends only on the injected {@link ToolContext} — no
// globals, no AsyncLocalStorage (C14). The server and MCP SDK versions are
// INJECTED via `opts` rather than read from `package.json` / `node_modules`,
// which would sit outside `rootDir` and break the build.

import { z } from 'zod';

import {
  debugToken,
  parseUsageHeaders,
  type DebugTokenInfo,
  type PackageSpec,
  type Settings,
  type ToolAnnotations,
  type UsageSnapshot,
} from '../core/index.js';
import { defineTool, shapeEnvelope, shapeResult } from '../mcp/index.js';

// ---------------------------------------------------------------------------
// Shared annotation quadruple — every core tool is read-only (doc 06).
// ---------------------------------------------------------------------------

/**
 * The MCP annotation quadruple shared by every `core` tool: read-only,
 * non-destructive, idempotent, open-world (all four touch a live external
 * system). `readOnlyHint:true` ⇔ `writeTier` absent, which `defineTool`
 * enforces.
 */
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

// ---------------------------------------------------------------------------
// Token credential helpers (shared by whoami; mirrored by the doctor)
// ---------------------------------------------------------------------------

/**
 * The runtime token to classify: system-user wins over the primary access
 * token, which wins over a long-lived Page token (CC-AUTH-9). `undefined` when
 * nothing is configured.
 */
function runtimeToken(settings: Settings): string | undefined {
  return settings.systemToken ?? settings.accessToken ?? settings.pageToken;
}

/**
 * The credential authorizing a `/debug_token` call. Graph wants a credential
 * distinct from the token under inspection: prefer the app access token
 * (`{app-id}|{app-secret}`) when both halves are configured, else fall back to
 * the runtime token itself (self-inspection still works for a valid token).
 */
function debugCredential(settings: Settings, token: string): string {
  return settings.appId !== undefined && settings.appSecret !== undefined
    ? `${settings.appId}|${settings.appSecret}`
    : token;
}

// ---------------------------------------------------------------------------
// whoami — server-owned identity envelope
// ---------------------------------------------------------------------------

const whoamiOutputSchema = z.object({
  server: z.object({
    name: z.string(),
    version: z.string(),
    apiVersion: z.string(),
    sdkVersion: z.string(),
  }),
  token: z.object({
    type: z.string(),
    valid: z.boolean(),
    appId: z.string().optional(),
    scopes: z.array(z.string()),
    neverExpiring: z.boolean(),
    expiresAt: z.number().optional(),
    dataAccessExpiresAt: z.number().optional(),
    actingUserId: z.string().optional(),
    actingPageId: z.string().optional(),
  }),
  error: z.string().optional(),
});

/**
 * The version trio the whoami envelope reports. Both values are INJECTED by the
 * bootstrap (see {@link createCorePackage}); this layer resolves neither.
 */
interface CoreVersions {
  /** This server's own version, read from `package.json` at runtime. */
  readonly serverVersion: string;
  /** The `@modelcontextprotocol/sdk` version this install actually loaded. */
  readonly sdkVersion: string;
}

/**
 * Build the whoami envelope from the classified token. `neverExpiring` is only
 * meaningful for a valid token whose `expiresAt` is absent (Graph `expires_at`
 * 0 ⇒ undefined — the System-User signature). `error` is set on the token-less
 * / debug-failure paths so the caller still gets a schema-valid envelope.
 */
function buildWhoamiPayload(
  versions: CoreVersions,
  settings: Settings,
  info: DebugTokenInfo,
  error?: string,
): Record<string, unknown> {
  return {
    server: {
      name: 'facebook-mcp',
      version: versions.serverVersion,
      apiVersion: settings.apiVersion,
      sdkVersion: versions.sdkVersion,
    },
    token: {
      type: info.type,
      valid: info.valid,
      ...(info.appId !== undefined ? { appId: info.appId } : {}),
      scopes: info.scopes,
      neverExpiring: info.valid && info.expiresAt === undefined,
      ...(info.expiresAt !== undefined ? { expiresAt: info.expiresAt } : {}),
      ...(info.dataAccessExpiresAt !== undefined
        ? { dataAccessExpiresAt: info.dataAccessExpiresAt }
        : {}),
      ...(info.userId !== undefined ? { actingUserId: info.userId } : {}),
      ...(info.profileId !== undefined ? { actingPageId: info.profileId } : {}),
    },
    ...(error !== undefined ? { error } : {}),
  };
}

const UNKNOWN_TOKEN: DebugTokenInfo = { type: 'UNKNOWN', valid: false, scopes: [] };

// ---------------------------------------------------------------------------
// list_pages / get_page raw response shapes (parsed defensively — CC-NET-2)
// ---------------------------------------------------------------------------

interface RawPageAccount {
  readonly id?: string;
  readonly name?: string;
  readonly category?: string;
  readonly tasks?: readonly string[];
  /** Present ⇒ a Page token is available; the VALUE never leaves this module. */
  readonly access_token?: string;
}

/** Fields fetched for a single Page node (doc 06 `facebook_get_page`). */
const GET_PAGE_FIELDS =
  'id,name,username,category,category_list,about,link,fan_count,followers_count,' +
  'has_transitioned_to_new_page_experience,is_published,' +
  'verification_status';

// ---------------------------------------------------------------------------
// usage — server-owned rate-limit envelope
// ---------------------------------------------------------------------------

const usageOutputSchema = z.object({
  usage: z.object({
    appUsagePct: z.number().optional(),
    businessUseCasePct: z.number().optional(),
    adsInsightsThrottlePct: z.number().optional(),
    seenAt: z.number(),
    raw: z.record(z.string()),
  }),
  hasData: z.boolean(),
  note: z.string().optional(),
});

function buildUsagePayload(snapshot: UsageSnapshot): Record<string, unknown> {
  const hasData = Object.keys(snapshot.raw).length > 0;
  return {
    usage: {
      ...(snapshot.appUsagePct !== undefined
        ? { appUsagePct: snapshot.appUsagePct }
        : {}),
      ...(snapshot.businessUseCasePct !== undefined
        ? { businessUseCasePct: snapshot.businessUseCasePct }
        : {}),
      ...(snapshot.adsInsightsThrottlePct !== undefined
        ? { adsInsightsThrottlePct: snapshot.adsInsightsThrottlePct }
        : {}),
      seenAt: snapshot.seenAt,
      raw: snapshot.raw,
    },
    hasData,
    ...(hasData
      ? {}
      : {
          note:
            'No usage headers observed on the probe request — the app may be ' +
            'idle or Graph omitted them. Make a Graph call and re-run.',
        }),
  };
}

// ---------------------------------------------------------------------------
// Package factory
// ---------------------------------------------------------------------------

/**
 * Build the always-on `core` package. Both versions in `opts` are injected (not
 * read from `package.json`, not resolved from `node_modules`) so the module
 * stays inside `rootDir` and this layer keeps no filesystem dependency. All four
 * tools are read-only; `enabledByDefault` is `true` and the registry forces
 * `core` on regardless of selection.
 */
export function createCorePackage(opts: CoreVersions): PackageSpec {
  const whoami = defineTool({
    name: 'facebook_whoami',
    title: 'Who am I',
    description:
      'Report the identity behind the configured token (type, validity, granted ' +
      'permissions, expiry) plus the server, MCP SDK and pinned Graph API version. ' +
      'Run this first to diagnose auth problems.',
    inputSchema: z.object({}),
    outputSchema: whoamiOutputSchema,
    annotations: READ_ONLY,
    handler: async (_input, ctx) => {
      const { settings } = ctx;
      const shape = { maxResultChars: settings.maxResultChars, redactor: ctx.redactor };
      const runtime = runtimeToken(settings);
      if (runtime === undefined) {
        return shapeEnvelope(
          buildWhoamiPayload(
            opts,
            settings,
            UNKNOWN_TOKEN,
            'No access token configured — set FB_ACCESS_TOKEN, FB_SYSTEM_TOKEN, or FB_PAGE_TOKEN.',
          ),
          { ...shape, isError: true },
        );
      }
      try {
        const info = await debugToken(runtime, {
          fbRequest: ctx.fbRequest,
          accessToken: debugCredential(settings, runtime),
          signal: ctx.signal,
        });
        return shapeEnvelope(buildWhoamiPayload(opts, settings, info), shape);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return shapeEnvelope(buildWhoamiPayload(opts, settings, UNKNOWN_TOKEN, message), {
          ...shape,
          isError: true,
        });
      }
    },
  });

  const listPages = defineTool({
    name: 'facebook_list_pages',
    title: 'List Pages',
    description:
      'List the Facebook Pages the operator administers (via /me/accounts): id, ' +
      'name, category, the granted tasks, and whether a Page token is available. ' +
      'Page access tokens themselves are never returned.',
    inputSchema: z.object({}),
    annotations: READ_ONLY,
    handler: async (_input, ctx) => {
      const res = await ctx.fbRequest<{ data?: readonly RawPageAccount[] }>({
        protocol: 'json',
        method: 'GET',
        host: 'graph',
        path: '/me/accounts',
        params: { fields: 'id,name,category,tasks,access_token' },
        signal: ctx.signal,
      });
      const pages = (res.data.data ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        ...(p.category !== undefined ? { category: p.category } : {}),
        tasks: p.tasks ?? [],
        // Derive presence, then DROP the value — it must not enter the payload.
        hasToken: typeof p.access_token === 'string' && p.access_token.length > 0,
      }));
      return shapeResult(
        { pages, count: pages.length },
        { maxResultChars: ctx.settings.maxResultChars, redactor: ctx.redactor },
      );
    },
  });

  const getPage = defineTool({
    name: 'facebook_get_page',
    title: 'Get Page',
    description:
      'Fetch metadata for one Page — name, category, follower/fan counts, publish ' +
      'state and new-Page-experience flag. Accepts ' +
      'an optional profile key or Page ID; omitted ⇒ the default Page.',
    inputSchema: z.object({
      profile: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Page profile key (e.g. "brand-a") or a raw Page ID. Omitted ⇒ the default Page (FB_PAGE_ID).',
        ),
    }),
    annotations: READ_ONLY,
    handler: async (input, ctx) => {
      const resolved = await ctx.pages.resolvePage(input.profile);
      const res = await ctx.fbRequest<Record<string, unknown>>({
        protocol: 'json',
        method: 'GET',
        host: 'graph',
        path: `/${resolved.pageId}`,
        params: { fields: GET_PAGE_FIELDS },
        token: resolved.token,
        signal: ctx.signal,
      });
      return shapeResult(
        {
          profile: input.profile ?? null,
          pageId: resolved.pageId,
          name: resolved.name,
          page: res.data,
        },
        { maxResultChars: ctx.settings.maxResultChars, redactor: ctx.redactor },
      );
    },
  });

  const usage = defineTool({
    name: 'facebook_usage',
    title: 'API Usage',
    description:
      'Report the most recent Graph rate-limit signals (X-App-Usage, ' +
      'X-Business-Use-Case-Usage, x-fb-ads-insights-throttle) as usage ' +
      'percentages, so you can back off before hitting a throttle.',
    inputSchema: z.object({}),
    outputSchema: usageOutputSchema,
    annotations: READ_ONLY,
    handler: async (_input, ctx) => {
      let snapshot: UsageSnapshot;
      try {
        const res = await ctx.fbRequest<{ id?: string }>({
          protocol: 'json',
          method: 'GET',
          host: 'graph',
          path: '/me',
          params: { fields: 'id' },
          signal: ctx.signal,
        });
        snapshot = parseUsageHeaders(res.headers, ctx.clock.now());
      } catch {
        // A failed probe still yields an honest "no data" snapshot.
        snapshot = { raw: {}, seenAt: ctx.clock.now() };
      }
      return shapeEnvelope(buildUsagePayload(snapshot), {
        maxResultChars: ctx.settings.maxResultChars,
        redactor: ctx.redactor,
      });
    },
  });

  return {
    name: 'core',
    title: 'Core',
    description:
      'Always-on identity, Page discovery and rate-limit diagnostics (read-only).',
    tools: [whoami, listPages, getPage, usage],
    enabledByDefault: true,
  };
}
