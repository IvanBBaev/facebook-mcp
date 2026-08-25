// Auth for facebook-mcp (task F09) — `debug_token` type detection and the
// per-page token resolver (cluster C1).
//
// Two independent pieces live here:
//
//   * `debugToken()` — asks Graph's `/debug_token` edge to classify a token
//     (USER vs PAGE vs SYSTEM_USER), report validity, scopes, granular scopes
//     and expiry. The doctor / `facebook_whoami` (F16) use it. The type is
//     REPORTED, never used to refuse a call: under C1 a base USER token is the
//     supported setup (Page tokens are derived from it), so the api layer
//     annotates a silently-empty read instead of refusing it (CC-AUTH-2 — see
//     `EMPTY_PAGE_TOKEN_HINT` in `api/comments.ts`).
//
//   * `createPageTokenResolver()` — the C1 resolver. It derives a Page token
//     from the base user/system-user token, caches it, and on Graph error 190
//     (or 100 with a stale-object subcode — CC-AUTH-7) invalidates and
//     re-derives **once** before failing with actionable guidance. A configured long-lived Page token override is a first-class
//     fallback (never derived, never re-derived). Every token is registered with
//     the redactor the moment it exists so it can never survive a log/result.
//
// This module is layer 0 (`core`): it imports only the frozen contracts + the
// injected seams (`FbRequestFn`, `Clock`, `Redactor`). It never imports a
// sibling real module — tests stub the Graph calls with `createFakeFbRequest`.

import type { Clock, FbRequestFn, Redactor } from './types.js';
import { GraphApiError } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Graph error code for a dead / invalid token (expired, revoked, password
 * change, "Require App Secret" toggled on). Subcodes 460/463/467 refine it; the
 * code alone is the token-death rail (CC-AUTH-1). Never retried blindly — the
 * per-page cache is invalidated and re-derived once, then the error surfaces.
 */
export const ERROR_CODE_TOKEN_INVALID = 190;

/**
 * Graph's broad "invalid parameter" code. On its own it means nothing about the
 * token — a misspelled field or a bad id raises it too — so it is only a cache
 * signal together with one of {@link STALE_OBJECT_SUBCODES} (CC-AUTH-7).
 */
export const ERROR_CODE_INVALID_PARAM = 100;

/**
 * Subcodes of error 100 that mean "the object this Page id points at is gone or
 * moved", i.e. exactly the CC-AUTH-7 rail (Page merged, renamed, unpublished):
 *
 *   * 21 — "Page ID X was migrated to page ID Y" (merge / rename).
 *   * 33 — object does not exist, cannot be accessed, or was deleted.
 *
 * CC-AUTH-7 decides the resolver cache invalidates on "190/100". Code 100 is
 * qualified by these subcodes on purpose: an unqualified 100 would drop the
 * cached Page token (and burn a re-derivation + one operation retry) on every
 * parameter typo, which the corner case never intended.
 */
export const STALE_OBJECT_SUBCODES: readonly number[] = [21, 33];

// ---------------------------------------------------------------------------
// debug_token — token type detection
// ---------------------------------------------------------------------------

/** Token classes distinguished by `debug_token`; anything unrecognized ⇒ `UNKNOWN`. */
export type TokenType = 'USER' | 'PAGE' | 'SYSTEM_USER' | 'APP' | 'UNKNOWN';

/**
 * One `granular_scopes` entry: a permission plus the asset ids it was actually
 * granted over. Meta reports asset-scoped permissions (`pages_*`, `ads_*`, ...)
 * here; an entry whose `targetIds` is empty means the permission string survives
 * but no asset is attached to it any more — the CC-AUTH-5 signature of a deleted
 * system user or an app removed from the Business.
 */
export interface GranularScope {
  readonly scope: string;
  readonly targetIds: readonly string[];
}

/** Parsed, normalized subset of a `debug_token` response. Times are epoch ms. */
export interface DebugTokenInfo {
  readonly type: TokenType;
  readonly valid: boolean;
  readonly appId?: string;
  readonly scopes: readonly string[];
  /**
   * Per-asset grants behind {@link DebugTokenInfo.scopes} (CC-AUTH-5). Always
   * present from {@link debugToken} — empty when Graph reported none (an older
   * token, or an app with no asset-scoped permission), which is NOT the same as
   * "granted over zero assets". Optional only so hand-built fallback stubs (e.g.
   * the `UNKNOWN` token in the tools layer) stay valid without asserting a
   * granular-scope answer they never had.
   */
  readonly granularScopes?: readonly GranularScope[];
  /** Epoch ms; `undefined` ⇒ never-expiring (Graph `expires_at` 0) — doctor warns. */
  readonly expiresAt?: number;
  /** Epoch ms of data-access expiry, when present. */
  readonly dataAccessExpiresAt?: number;
  /** For PAGE tokens, the Page ID the token acts as (`profile_id`). */
  readonly profileId?: string;
  /** For USER / SYSTEM_USER tokens, the acting user id. */
  readonly userId?: string;
}

/** Raw `/debug_token` payload — every field optional; parsed defensively (CC-NET-2). */
interface DebugTokenData {
  readonly type?: string;
  readonly is_valid?: boolean;
  readonly app_id?: string;
  readonly scopes?: readonly string[];
  readonly granular_scopes?: readonly {
    readonly scope?: string;
    readonly target_ids?: readonly string[];
  }[];
  /** Unix **seconds**; 0 ⇒ never-expiring. */
  readonly expires_at?: number;
  readonly data_access_expires_at?: number;
  readonly profile_id?: string;
  readonly user_id?: string;
}

/** Injected inputs for {@link debugToken}. */
export interface DebugTokenDeps {
  readonly fbRequest: FbRequestFn;
  /**
   * Token authorizing the debug call — an app access token (`{app-id}|{app-secret}`)
   * or an admin/base token. Graph requires a credential distinct from the input.
   */
  readonly accessToken: string;
  readonly signal?: AbortSignal;
}

function toTokenType(raw: string | undefined): TokenType {
  switch ((raw ?? '').toUpperCase()) {
    case 'USER':
      return 'USER';
    case 'PAGE':
      return 'PAGE';
    case 'SYSTEM_USER':
      return 'SYSTEM_USER';
    case 'APP':
      return 'APP';
    default:
      return 'UNKNOWN';
  }
}

/** Graph timestamps are Unix seconds; 0 means never-expiring (⇒ `undefined`). */
function secondsToMs(seconds: number | undefined): number | undefined {
  if (seconds === undefined || seconds === 0) return undefined;
  return seconds * 1000;
}

/**
 * Parse `granular_scopes` defensively (CC-NET-2): entries without a `scope`
 * string are dropped, and a missing/malformed `target_ids` becomes `[]` rather
 * than throwing — an empty target list is itself the CC-AUTH-5 signal.
 */
function normalizeGranularScopes(raw: unknown): readonly GranularScope[] {
  if (!Array.isArray(raw)) return [];
  const entries = raw as readonly unknown[];
  const out: GranularScope[] = [];
  for (const item of entries) {
    const entry = item as { scope?: unknown; target_ids?: unknown } | null;
    const scope = entry?.scope;
    if (typeof scope !== 'string' || scope.length === 0) continue;
    const rawIds = entry?.target_ids;
    const ids = Array.isArray(rawIds)
      ? (rawIds as readonly unknown[]).filter(
          (id): id is string => typeof id === 'string',
        )
      : [];
    out.push({ scope, targetIds: ids });
  }
  return out;
}

function normalizeDebugToken(data: DebugTokenData): DebugTokenInfo {
  return {
    type: toTokenType(data.type),
    valid: data.is_valid === true,
    appId: data.app_id,
    scopes: data.scopes ?? [],
    granularScopes: normalizeGranularScopes(data.granular_scopes),
    expiresAt: secondsToMs(data.expires_at),
    dataAccessExpiresAt: secondsToMs(data.data_access_expires_at),
    profileId: data.profile_id,
    userId: data.user_id,
  };
}

/**
 * Classify a token via Graph's `/debug_token` edge. The result feeds the doctor
 * (validity / scopes / granular scopes / expiry / type), which reports the type
 * so an operator can see whether a USER token is about to read a Page-only edge
 * (CC-AUTH-2) and reads {@link DebugTokenInfo.granularScopes} to tell a
 * malformed token from a revoked asset grant (CC-AUTH-5).
 */
export async function debugToken(
  inputToken: string,
  deps: DebugTokenDeps,
): Promise<DebugTokenInfo> {
  const res = await deps.fbRequest<{ data?: DebugTokenData }>({
    protocol: 'json',
    method: 'GET',
    host: 'graph',
    path: '/debug_token',
    params: { input_token: inputToken },
    token: deps.accessToken,
    signal: deps.signal,
  });
  return normalizeDebugToken(res.data?.data ?? {});
}

// ---------------------------------------------------------------------------
// Per-page token resolver (C1)
// ---------------------------------------------------------------------------

/** Injected inputs for {@link createPageTokenResolver}. */
export interface PageTokenResolverDeps {
  readonly fbRequest: FbRequestFn;
  /**
   * Base user / system-user token the Page token is derived from
   * (`systemToken ?? accessToken`). Absent ⇒ derivation is impossible and only
   * `overrides` can satisfy a resolve.
   */
  readonly baseToken?: string;
  readonly clock: Clock;
  readonly redactor: Redactor;
  /**
   * Explicit long-lived Page token overrides, keyed by Page ID — the first-class
   * Page-token fallback (C1). An override is used verbatim, never derived and
   * never re-derived (it has no re-derivation source).
   */
  readonly overrides?: Readonly<Record<string, string>>;
  /**
   * Optional cache TTL in ms. Omitted ⇒ a derived token is cached until it is
   * explicitly invalidated (error 190) — Graph does not tell us the Page token's
   * lifetime up front, so time-based expiry is opt-in.
   */
  readonly cacheTtlMs?: number;
}

/**
 * Owns the per-Page token cache. `resolve` returns an override verbatim or a
 * cached/freshly-derived token; `runWithPageToken` embodies the full C1 rail —
 * derive → run → on error 190 invalidate & re-derive **once** → then fail with
 * actionable guidance.
 */
export interface PageTokenResolver {
  /** Resolve the Page token: override verbatim, else cached, else derive + cache. */
  resolve(pageId: string, signal?: AbortSignal): Promise<string>;
  /** Drop the cached derived token for a Page ID (the error-190 hook). */
  invalidate(pageId: string): void;
  /**
   * Run a page-scoped Graph operation with the resolved token. On error 190 from
   * a **derived** token: invalidate, re-derive once, and retry the operation
   * exactly once; a second 190 (or a dead base token) fails with guidance. An
   * **override** token cannot be re-derived, so its 190 fails immediately with
   * guidance to refresh the configured token.
   */
  runWithPageToken<T>(
    pageId: string,
    op: (token: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

interface CacheEntry {
  readonly token: string;
  readonly derivedAt: number;
}

function isTokenDead(err: unknown): boolean {
  return err instanceof GraphApiError && err.code === ERROR_CODE_TOKEN_INVALID;
}

/**
 * Error 100 with a stale-object subcode — the Page this id points at was merged,
 * renamed or unpublished, so the cached derivation is worthless (CC-AUTH-7).
 */
function isStalePageObject(err: unknown): boolean {
  return (
    err instanceof GraphApiError &&
    err.code === ERROR_CODE_INVALID_PARAM &&
    err.subcode !== undefined &&
    STALE_OBJECT_SUBCODES.includes(err.subcode)
  );
}

/** The CC-AUTH-7 cache signal: drop the cached Page token and re-derive once. */
function invalidatesPageCache(err: unknown): boolean {
  return isTokenDead(err) || isStalePageObject(err);
}

/** Re-throw a stale-Page error with the "the Page itself moved" guidance. */
function stalePageError(message: string, cause: unknown): GraphApiError {
  const g = cause instanceof GraphApiError ? cause : undefined;
  return new GraphApiError(message, {
    code: g?.code ?? ERROR_CODE_INVALID_PARAM,
    subcode: g?.subcode,
    type: g?.type,
    fbtraceId: g?.fbtraceId,
    httpStatus: g?.httpStatus ?? 400,
    action: g?.action,
    cause,
  });
}

/** Re-throw a token-death error with operator-actionable guidance, preserving the cause. */
function tokenDeadError(message: string, cause: unknown): GraphApiError {
  const g = cause instanceof GraphApiError ? cause : undefined;
  return new GraphApiError(message, {
    code: g?.code ?? ERROR_CODE_TOKEN_INVALID,
    subcode: g?.subcode,
    type: g?.type,
    fbtraceId: g?.fbtraceId,
    httpStatus: g?.httpStatus ?? 401,
    action: g?.action,
    cause,
  });
}

/** Create the per-page token resolver (C1). */
export function createPageTokenResolver(deps: PageTokenResolverDeps): PageTokenResolver {
  const cache = new Map<string, CacheEntry>();
  const overrides = deps.overrides ?? {};

  // Register configured overrides as secrets up front — they exist from startup.
  for (const token of Object.values(overrides)) {
    deps.redactor.addSecret(token);
  }

  const isFresh = (entry: CacheEntry): boolean =>
    deps.cacheTtlMs === undefined || deps.clock.now() - entry.derivedAt < deps.cacheTtlMs;

  const derive = async (pageId: string, signal?: AbortSignal): Promise<string> => {
    const baseToken = deps.baseToken;
    if (baseToken === undefined || baseToken.length === 0) {
      throw tokenDeadError(
        `No base token available to derive a Page token for Page ${pageId}. ` +
          `Set FB_SYSTEM_TOKEN or FB_ACCESS_TOKEN, or provide a long-lived Page ` +
          `token (FB_PAGE_TOKEN / FB_PROFILE_<NAME>_TOKEN), then run the doctor ` +
          `(facebook_whoami).`,
        undefined,
      );
    }

    let res;
    try {
      res = await deps.fbRequest<{ access_token?: string; id?: string }>({
        protocol: 'json',
        method: 'GET',
        host: 'graph',
        path: `/${pageId}`,
        params: { fields: 'access_token' },
        token: baseToken,
        signal,
      });
    } catch (err) {
      if (isTokenDead(err)) {
        throw tokenDeadError(
          `Base access token is invalid or expired (Graph error 190) — cannot ` +
            `derive a Page token for Page ${pageId}. Refresh FB_SYSTEM_TOKEN / ` +
            `FB_ACCESS_TOKEN and run the doctor (facebook_whoami).`,
          err,
        );
      }
      throw err;
    }

    const token = res.data.access_token;
    if (token === undefined || token.length === 0) {
      throw new GraphApiError(
        `Graph returned no Page access token for Page ${pageId}. The base token ` +
          `may lack a role on this Page or the ` +
          `pages_show_list / pages_manage_metadata permission — run the doctor ` +
          `(facebook_whoami).`,
        { code: 190, httpStatus: 403 },
      );
    }

    // A per-Page token derived after startup must be scrubbable immediately (C1).
    deps.redactor.addSecret(token);
    return token;
  };

  const resolve = async (pageId: string, signal?: AbortSignal): Promise<string> => {
    const override = overrides[pageId];
    if (override !== undefined) return override; // first-class fallback; never derive

    const cached = cache.get(pageId);
    if (cached !== undefined && isFresh(cached)) return cached.token;

    const token = await derive(pageId, signal);
    cache.set(pageId, { token, derivedAt: deps.clock.now() });
    return token;
  };

  const invalidate = (pageId: string): void => {
    cache.delete(pageId);
  };

  const runWithPageToken = async <T>(
    pageId: string,
    op: (token: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    const token = await resolve(pageId, signal);
    try {
      return await op(token);
    } catch (err) {
      if (!invalidatesPageCache(err)) throw err;

      // An override token has no re-derivation source — fail with guidance now.
      if (overrides[pageId] !== undefined) {
        if (isStalePageObject(err)) {
          throw stalePageError(
            `Page ${pageId} no longer resolves (Graph error 100) — it was merged, ` +
              `renamed or unpublished. Re-run facebook_list_pages for the current ` +
              `Page ID and update FB_PAGE_ID / FB_PROFILE_<NAME>_ID.`,
            err,
          );
        }
        throw tokenDeadError(
          `Configured Page token for Page ${pageId} is invalid (Graph error 190). ` +
            `Refresh FB_PAGE_TOKEN / FB_PROFILE_<NAME>_TOKEN and run the doctor ` +
            `(facebook_whoami).`,
          err,
        );
      }

      // Derived token died mid-use: invalidate and re-derive exactly once.
      invalidate(pageId);
      const fresh = await resolve(pageId, signal);
      try {
        return await op(fresh);
      } catch (err2) {
        if (isStalePageObject(err2)) {
          throw stalePageError(
            `Page ${pageId} still does not resolve after one re-derivation (Graph ` +
              `error 100) — the Page was merged, renamed or unpublished. Re-run ` +
              `facebook_list_pages for the current Page ID and update ` +
              `FB_PAGE_ID / FB_PROFILE_<NAME>_ID.`,
            err2,
          );
        }
        if (isTokenDead(err2)) {
          throw tokenDeadError(
            `Page token for Page ${pageId} is still invalid after one ` +
              `re-derivation (Graph error 190). The base token may have lost ` +
              `access to this Page, or the Page was merged / unpublished. Refresh ` +
              `FB_SYSTEM_TOKEN / FB_ACCESS_TOKEN, check your Page role, and run the ` +
              `doctor (facebook_whoami).`,
            err2,
          );
        }
        throw err2;
      }
    }
  };

  return { resolve, invalidate, runWithPageToken };
}
