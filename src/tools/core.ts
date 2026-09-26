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
//   * facebook_usage      — rate-limit headers from a fresh `/me` probe (or from
//                           the response that refused it) as a UsageSnapshot.
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
  errorMessageOf,
  GraphApiError,
  parseUsageHeaders,
  USAGE_HEADERS,
  usageOfGraphError,
  type DebugTokenInfo,
  type PackageSpec,
  type Redactor,
  type Settings,
  type ToolAnnotations,
  type UsageSnapshot,
} from '../core/index.js';
import { defineTool, shapeEnvelope, shapeResult } from '../mcp/index.js';
import { graphErrorFields } from './shared.js';

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
    /** True only when Graph literally said `expires_at: 0` for a valid token. */
    neverExpiring: z.boolean(),
    /**
     * Present (and true) when the token is valid but Graph's `debug_token`
     * answer carried no usable `expires_at`: the caller is told that nobody
     * knows when this credential stops working, instead of being told "never".
     */
    expiryUnknown: z.boolean().optional(),
    /**
     * Present (and true) when `debug_token` gave no answer about this token (a
     * network fault, an outage, a refused call). `valid` and `scopes` are then
     * placeholders, not Graph's ruling — see `error` for what went wrong.
     */
    unverified: z.boolean().optional(),
    expiresAt: z.number().optional(),
    dataAccessExpiresAt: z.number().optional(),
    actingUserId: z.string().optional(),
    actingPageId: z.string().optional(),
  }),
  error: z.string().optional(),
  /**
   * The Graph identity of a failed `debug_token` call (code, subcode, type, HTTP
   * status, trace id, Meta's `userTitle` / `userMessage`). Absent when the
   * failure was not a Graph error. `error` alone cannot tell an expired token
   * (190/463) from a changed password (190/460) or a throttle (4).
   */
  graphError: z
    .object({
      code: z.number(),
      subcode: z.number().optional(),
      type: z.string().optional(),
      httpStatus: z.number(),
      fbtraceId: z.string().optional(),
      userTitle: z.string().optional(),
      userMessage: z.string().optional(),
    })
    .optional(),
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
 * meaningful for a valid token Graph reported with `expires_at: 0` (the
 * System-User signature); a valid token whose answer carried no usable
 * `expires_at` is reported as `expiryUnknown` instead, because "Graph did not
 * say" and "never" are different facts and the caller is entitled to the
 * difference. `error` is set on the token-less / debug-failure paths so the
 * caller still gets a schema-valid envelope.
 *
 * The THIRD source of `error` is the one that matters most here: Graph rejects a
 * token INSIDE a 200 (`is_valid:false` plus the cause in `data.error`), so an
 * expired, revoked or wrong-app token never reaches the `catch` below — it
 * arrives as a perfectly successful call. `debugToken` already normalizes that
 * cause into {@link DebugTokenInfo.invalidReason}; dropping it left the tool
 * that says "run this first to diagnose auth problems" reporting `valid:false`
 * with no subject, and an expired token, a revoked one and one issued by a
 * different app all read identically. The doctor surfaces the same field for the
 * same reason (`src/mcp/doctor.ts`). An explicit `error` argument still wins:
 * on the `catch` path the thrown message is what actually happened, and `info`
 * is the {@link UNKNOWN_TOKEN} placeholder that never carries a reason anyway.
 */
function buildWhoamiPayload(
  versions: CoreVersions,
  settings: Settings,
  info: DebugTokenInfo,
  error?: string,
  graphError?: Record<string, unknown>,
  unverified = false,
): Record<string, unknown> {
  const reason = error ?? info.invalidReason;
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
      // Only the wire's literal `expires_at: 0` says "never"; an answer that
      // said nothing is reported as exactly that, and never promoted to "never".
      neverExpiring: info.valid && info.expiry === 'never',
      ...(info.valid && info.expiry === 'unknown' ? { expiryUnknown: true } : {}),
      // The catch path's placeholder reads `valid:false, scopes:[]` — the exact
      // answer for a token Graph ruled dead with nothing granted. Label it.
      ...(unverified ? { unverified: true } : {}),
      ...(info.expiresAt !== undefined ? { expiresAt: info.expiresAt } : {}),
      ...(info.dataAccessExpiresAt !== undefined
        ? { dataAccessExpiresAt: info.dataAccessExpiresAt }
        : {}),
      ...(info.userId !== undefined ? { actingUserId: info.userId } : {}),
      ...(info.profileId !== undefined ? { actingPageId: info.profileId } : {}),
    },
    ...(reason !== undefined ? { error: reason } : {}),
    ...(graphError !== undefined && Object.keys(graphError).length > 0
      ? { graphError }
      : {}),
  };
}

const UNKNOWN_TOKEN: DebugTokenInfo = {
  type: 'UNKNOWN',
  valid: false,
  scopes: [],
  expiry: 'unknown',
};

// ---------------------------------------------------------------------------
// list_pages / get_page raw response shapes (parsed defensively — CC-NET-2)
// ---------------------------------------------------------------------------

/**
 * The readers below exist because "parsed defensively" was a claim this section
 * made and did not honour. `fbRequest<T>` CASTS the parsed body to `T` (`data as
 * T`, src/core/http.ts): the declared shape is a hope, not a guarantee. A 2xx can
 * arrive with no body at all (parsed as `undefined`), as a raw non-JSON string,
 * or with members of the wrong type — and none of that is exotic enough to be
 * worth a TypeError thrown at the operator as a failed read of their own Pages.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The `/me/accounts` edge reduced to the entries this tool can actually read.
 * Anything that is not a record — a `null` hole in the array, a bare number, the
 * whole body when it is not an object — is dropped rather than reached into.
 */
function pageAccounts(body: unknown): readonly Record<string, unknown>[] {
  if (!isRecord(body)) return [];
  const edge: unknown = body.data;
  return Array.isArray(edge) ? edge.filter(isRecord) : [];
}

/**
 * How many entries the `/me/accounts` body's account list held, or `undefined`
 * when it carried no account list at all. Only a record whose `data` is an
 * array is one; anything else is survived by
 * {@link pageAccounts} as an empty list, which on its own reads exactly like an
 * operator who administers no Pages.
 */
function accountListLength(body: unknown): number | undefined {
  if (!isRecord(body)) return undefined;
  const edge: unknown = body.data;
  return Array.isArray(edge) ? edge.length : undefined;
}

/**
 * The note for an answer that carried no readable account list. `count: 0`
 * then means "nothing could be read", never "no Pages exist".
 */
const UNREADABLE_LIST_NOTE =
  "Graph's /me/accounts answer was not a readable account list, so `pages` is " +
  'empty because nothing could be read — this is not evidence that the operator ' +
  'administers no Pages or that the token cannot see a Page. Re-run, and address ' +
  'a known Page by its raw Page ID meanwhile.';

/** The note for account entries dropped because they carried no usable id. */
function droppedEntriesNote(dropped: number): string {
  return (
    `${String(dropped)} account ${dropped === 1 ? 'entry' : 'entries'} in Graph's ` +
    'answer could not be read (no usable string id) and are not listed; the ' +
    'listing is incomplete by that many.'
  );
}

/**
 * The granted tasks, keeping only real task names. A non-array becomes an empty
 * list and a non-string entry is dropped: `tasks` is what the model reads to
 * decide whether a write is even permitted, so a number sitting in it is worse
 * than its absence.
 */
function taskNames(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((t): t is string => typeof t === 'string')
    : [];
}

/**
 * How many accounts one `facebook_list_pages` call asks Graph for. The tool
 * reads exactly ONE page of `/me/accounts` and follows no cursor, so this is the
 * hard ceiling on what it can report — the same ceiling, and the same reason, as
 * the setup-token flow (`src/mcp/setup-token.ts`). Left unset, Graph applies its
 * own default edge window (25), which is small enough that an ordinary agency
 * account is cut without anyone asking for a page size at all.
 */
const PAGE_LIST_LIMIT = 100;

/**
 * Whether Graph left a `next` cursor on the body, i.e. answered with one window
 * of a longer edge.
 *
 * This has to be read off the RAW body, before shaping: `shapeResult` strips
 * every `paging` object structurally (C3 / CC-PAGE-4), so by the time the result
 * exists the only evidence that the listing was cut has already been removed.
 * Read defensively like the rest of this section (CC-NET-2) — `paging` is cast,
 * not validated, so a non-record `paging` or a non-string `next` means "no
 * evidence of more", never a throw.
 */
function hasNextPage(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const paging: unknown = body.paging;
  if (!isRecord(paging)) return false;
  const next: unknown = paging.next;
  return typeof next === 'string' && next.length > 0;
}

/**
 * What the payload says when Graph reported more Pages than were listed. An
 * operator whose Page sits outside the window must read "the listing was cut",
 * never "your Page does not exist" — the second sends them to re-check roles and
 * asset assignments for a Page the token can see perfectly well.
 */
const MORE_PAGES_NOTE =
  `Graph reported MORE Pages than the ${String(PAGE_LIST_LIMIT)} listed here; ` +
  'this is one window of a longer list, not the complete set. A Page missing ' +
  'from `pages` is not evidence that it does not exist or that the token cannot ' +
  'see it — the tools that take a `profile` also accept a raw Page ID, so ' +
  'address such a Page by its id directly.';

/** Fields fetched for a single Page node (doc 06 `facebook_get_page`). */
const GET_PAGE_FIELDS =
  'id,name,username,category,category_list,about,link,fan_count,followers_count,' +
  'has_transitioned_to_new_page_experience,video_upload_limits,is_published,' +
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
  /**
   * Present (and true) when the probe itself was refused by a rate limit: the
   * figures are unknown because the app IS throttled, not because of a token or
   * connectivity fault.
   */
  throttled: z.boolean().optional(),
  /** The cool-down surfaced with a throttled probe (ms); an estimate, never a sleep. */
  retryAfterMs: z.number().optional(),
  note: z.string().optional(),
});

/**
 * What the `note` says when the probe SUCCEEDED and Graph simply sent no
 * rate-limit headers back. This is the only case in which "idle" is an honest
 * reading of an empty snapshot.
 */
const NO_HEADERS_NOTE =
  'No usage headers observed on the probe request — the app may be ' +
  'idle or Graph omitted them. Make a Graph call and re-run.';

/** Longest probe-failure reason echoed into the (deliberately un-truncated) envelope. */
const PROBE_REASON_MAX_CHARS = 200;

/**
 * The `note` for the OTHER empty snapshot: the probe threw, so nothing was ever
 * read. An expired token or a dropped connection produces exactly the same
 * empty `raw` map as an idle app, and reporting it as idle sends the operator
 * looking for a quota problem that is not there — so this note says the figures
 * are UNKNOWN and names the probe as the thing to fix.
 *
 * `reason` is redacted at the choke-point BEFORE it is trimmed: trimming first
 * could slice a secret in half and leave the surviving prefix unmatched by the
 * value-based redactor.
 */
function probeFailedNote(
  reason: string,
  redactor: Redactor,
  figuresKnown: boolean,
): string {
  const trimmed = trimProbeReason(reason, redactor);
  const figures = figuresKnown
    ? 'The rate-limit probe FAILED, but its error response still carried usage ' +
      'headers: the figures in `usage` were read from that response. '
    : 'The rate-limit probe FAILED, so the usage figures are unknown — this is ' +
      'not evidence that the app is idle. ';
  return (
    figures +
    'Check the token and connectivity ' +
    `(facebook_whoami classifies the token), then re-run. Probe error: ${trimmed}`
  );
}

/** Redact, THEN trim, a probe-failure reason (see {@link probeFailedNote}). */
function trimProbeReason(reason: string, redactor: Redactor): string {
  const redacted = redactor.redactString(reason);
  return redacted.length > PROBE_REASON_MAX_CHARS
    ? `${redacted.slice(0, PROBE_REASON_MAX_CHARS)}…`
    : redacted;
}

/**
 * The `note` for a probe that Graph REFUSED with a rate limit. Every throttle
 * row in the error matrix names `facebook_usage` as the next tool, and an
 * app-level throttle refuses this probe too — so the generic "check the token
 * and connectivity" note sent the caller to `facebook_whoami` for an auth fault
 * that does not exist, while the one fact the tool exists to report (the app is
 * throttled) was lost.
 */
function probeThrottledNote(
  reason: string,
  redactor: Redactor,
  figuresKnown: boolean,
): string {
  // Graph names the full bucket on the very response that refuses the call
  // (`usageOfGraphError`), so "unavailable" is only true when none came back.
  const figures = figuresKnown
    ? 'the figures in `usage` were read from the headers of that refusing ' + 'response. '
    : 'the exact usage figures are unavailable. ';
  return (
    'The rate-limit probe was itself REFUSED by a Graph rate limit: the app (or ' +
    'this token / Business use case) is currently throttled, and ' +
    figures +
    'Back off and re-run after the cool-down; this is ' +
    `not a token or connectivity fault. Probe error: ${trimProbeReason(reason, redactor)}`
  );
}

/** How a failed probe is reported: its note, and the throttle facts if any. */
interface ProbeFailure {
  readonly note: string;
  readonly throttled?: true;
  readonly retryAfterMs?: number;
}

/** Classify a probe rejection into the {@link ProbeFailure} the envelope carries. */
function probeFailureOf(
  err: unknown,
  redactor: Redactor,
  figuresKnown: boolean,
): ProbeFailure {
  const message = errorMessageOf(err);
  const action = err instanceof GraphApiError ? err.action : undefined;
  if (action?.category !== 'rate_limit') {
    return { note: probeFailedNote(message, redactor, figuresKnown) };
  }
  return {
    note: probeThrottledNote(message, redactor, figuresKnown),
    throttled: true,
    ...(action.retryAfterMs !== undefined ? { retryAfterMs: action.retryAfterMs } : {}),
  };
}

/** Which snapshot field each usage header feeds. */
const USAGE_HEADER_FIELDS = [
  [USAGE_HEADERS.appUsage, 'appUsagePct'],
  [USAGE_HEADERS.businessUseCaseUsage, 'businessUseCasePct'],
  [USAGE_HEADERS.adsInsightsThrottle, 'adsInsightsThrottlePct'],
] as const;

/**
 * The note for headers that ARRIVED but yielded no percentage (malformed JSON,
 * an unexpected shape). Without it `hasData:true` plus a missing figure reads as
 * "seen, and quiet"; the honest reading is "seen, and unreadable". `undefined`
 * when every present header parsed.
 */
function unreadableHeadersNote(snapshot: UsageSnapshot): string | undefined {
  const unreadable = USAGE_HEADER_FIELDS.filter(
    ([header, field]) =>
      snapshot.raw[header] !== undefined && snapshot[field] === undefined,
  ).map(([header]) => header);
  if (unreadable.length === 0) return undefined;
  return (
    `Usage header(s) present but unreadable: ${unreadable.join(', ')}. Their ` +
    'percentages are UNKNOWN (not 0%); the verbatim values are in `usage.raw`.'
  );
}

/** Join the notes that are present with a space; `undefined` when none is. */
function joinNotes(...notes: readonly (string | undefined)[]): string | undefined {
  const present = notes.filter((n): n is string => n !== undefined);
  return present.length > 0 ? present.join(' ') : undefined;
}

/**
 * `probeFailure` is the note produced by {@link probeFailedNote} when the probe
 * threw, and `undefined` when it completed. Either way `hasData` is the only
 * claim made about the headers themselves; the note explains WHY they are
 * missing, and the two reasons are not interchangeable.
 */
function buildUsagePayload(
  snapshot: UsageSnapshot,
  probeFailure?: ProbeFailure,
): Record<string, unknown> {
  const hasData = Object.keys(snapshot.raw).length > 0;
  // A failed probe whose error response carried headers has BOTH facts to
  // report: why the probe failed, and whether those headers were readable.
  const note = hasData
    ? joinNotes(probeFailure?.note, unreadableHeadersNote(snapshot))
    : (probeFailure?.note ?? NO_HEADERS_NOTE);
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
    ...(probeFailure?.throttled === true ? { throttled: true } : {}),
    ...(probeFailure?.retryAfterMs !== undefined
      ? { retryAfterMs: probeFailure.retryAfterMs }
      : {}),
    ...(note !== undefined ? { note } : {}),
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
  // No tool in this package declares `logFields` (04 §"Log hygiene"). Three of
  // the four take no arguments at all, and facebook_get_page takes only the
  // profile selector, so a per-call line could say nothing beyond "a Page was
  // read". The identity and quota answers these tools exist to give belong in
  // their results; naming an argument that does not exist would read like a
  // control while logging nothing.
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
        const message = errorMessageOf(err);
        return shapeEnvelope(
          buildWhoamiPayload(
            opts,
            settings,
            UNKNOWN_TOKEN,
            message,
            graphErrorFields(err),
            true,
          ),
          { ...shape, isError: true },
        );
      }
    },
  });

  const listPages = defineTool({
    name: 'facebook_list_pages',
    title: 'List Pages',
    description:
      'List the Facebook Pages the operator administers (via /me/accounts): id, ' +
      'name, category, the granted tasks, and whether a Page token is available. ' +
      'Page access tokens themselves are never returned. This reads ONE window of ' +
      `up to ${String(PAGE_LIST_LIMIT)} Pages and follows no cursor: when ` +
      '`hasMore` is true the list is incomplete, so a Page you cannot find in it ' +
      'may still exist — address it by its raw Page ID rather than reporting it ' +
      'as missing.',
    inputSchema: z.object({}),
    annotations: READ_ONLY,
    handler: async (_input, ctx) => {
      const res = await ctx.fbRequest<unknown>({
        protocol: 'json',
        method: 'GET',
        host: 'graph',
        path: '/me/accounts',
        params: {
          fields: 'id,name,category,tasks,access_token',
          limit: PAGE_LIST_LIMIT,
        },
        signal: ctx.signal,
      });
      // Decided on the RAW body: the shaper is about to delete `paging`.
      const hasMore = hasNextPage(res.data);
      const arrived = accountListLength(res.data);
      const pages = pageAccounts(res.data).flatMap((p) => {
        // An account with no usable id is not an answer: every other tool in the
        // server takes a Page id, so passing one on that the model cannot spend
        // only moves the failure to the next call, where it is harder to read.
        const id: unknown = p.id;
        if (typeof id !== 'string' || id.length === 0) return [];
        return [
          {
            id,
            ...(typeof p.name === 'string' ? { name: p.name } : {}),
            ...(typeof p.category === 'string' ? { category: p.category } : {}),
            tasks: taskNames(p.tasks),
            // Derive presence, then DROP the value — it must not enter the payload.
            hasToken: typeof p.access_token === 'string' && p.access_token.length > 0,
          },
        ];
      });
      // Every entry of a readable list that did not become a Page — a `null`
      // hole, a bare scalar, an account with no string id — is a Page the
      // operator may hold that this answer does not show.
      const dropped = (arrived ?? 0) - pages.length;
      const note = joinNotes(
        arrived === undefined ? UNREADABLE_LIST_NOTE : undefined,
        dropped > 0 ? droppedEntriesNote(dropped) : undefined,
        hasMore ? MORE_PAGES_NOTE : undefined,
      );
      return shapeResult(
        {
          pages,
          count: pages.length,
          // `count` is how many Pages this WINDOW held, never how many exist.
          hasMore,
          ...(note !== undefined ? { note } : {}),
        },
        { maxResultChars: ctx.settings.maxResultChars, redactor: ctx.redactor },
      );
    },
  });

  const getPage = defineTool({
    name: 'facebook_get_page',
    title: 'Get Page',
    description:
      'Fetch metadata for one Page — name, category, follower/fan counts, ' +
      'publish state, new-Page-experience flag and video upload limits. Accepts ' +
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
      // Set only on the throwing path, so an empty snapshot is never confused
      // with an idle app (the two look identical in `raw`).
      let probeFailure: ProbeFailure | undefined;
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
      } catch (err) {
        // A failed probe still yields an honest "no data" snapshot — and now
        // says which kind of "no data" it is. The tool still does not throw:
        // usage is a diagnostic, and a diagnostic that fails loudly on a broken
        // token is one more error on top of the one being diagnosed.
        // The error response's own usage headers, when Graph sent any, are real
        // figures (a throttle names the full bucket on its refusal) — reported
        // with the `seenAt` of that response, not invented as an empty map.
        const refused = usageOfGraphError(err);
        snapshot = refused ?? { raw: {}, seenAt: ctx.clock.now() };
        probeFailure = probeFailureOf(err, ctx.redactor, refused !== undefined);
      }
      return shapeEnvelope(buildUsagePayload(snapshot, probeFailure), {
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
