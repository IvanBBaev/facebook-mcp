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
 * Graph's "API Session" code. Without a subcode it means the login status or
 * access token has expired, been revoked or is otherwise invalid — the same
 * token-death signal as 190 (the error matrix's `auth-102` row says so). A
 * derived Page token refused with it is dead and must leave the cache.
 */
export const ERROR_CODE_SESSION = 102;

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
  /**
   * `true` when Graph sent the entry with NO `target_ids` key at all. Meta's
   * debug_token reference: "If permission applies to all, targets will not be
   * shown" — so an absent list is the broadest grant there is, the opposite of
   * the CC-AUTH-5 empty list. `targetIds` stays `[]` for such an entry (there
   * are no ids to report); read this flag before calling it revoked. Absent
   * when `target_ids` was present (listed, empty, or malformed).
   */
  readonly appliesToAllTargets?: true;
}

/**
 * What Graph said about when a token stops working. `expires_at: 0` is the one
 * wire fact that means "never"; a finite positive value is a known instant; and
 * an absent, non-numeric, non-finite or negative value says NOTHING — which is
 * not the same as "never". The three used to collapse into one
 * `expiresAt: undefined`, which whoami and the doctor then read as the confident
 * "never expires": a statement Graph never made.
 */
export type TokenExpiry = 'known' | 'never' | 'unknown';

/** Parsed, normalized subset of a `debug_token` response. Times are epoch ms. */
export interface DebugTokenInfo {
  readonly type: TokenType;
  readonly valid: boolean;
  readonly appId?: string;
  readonly scopes: readonly string[];
  /**
   * Which of the three things the wire said about expiry (see
   * {@link TokenExpiry}). `known` ⇔ {@link DebugTokenInfo.expiresAt} is set.
   */
  readonly expiry: TokenExpiry;
  /**
   * Per-asset grants behind {@link DebugTokenInfo.scopes} (CC-AUTH-5). Always
   * present from {@link debugToken} — empty when Graph reported none (an older
   * token, or an app with no asset-scoped permission), which is NOT the same as
   * "granted over zero assets". Optional only so hand-built fallback stubs (e.g.
   * the `UNKNOWN` token in the tools layer) stay valid without asserting a
   * granular-scope answer they never had.
   */
  readonly granularScopes?: readonly GranularScope[];
  /**
   * Epoch ms of the expiry when {@link DebugTokenInfo.expiry} is `known`;
   * absent for both `never` and `unknown` — read `expiry` to tell those apart.
   */
  readonly expiresAt?: number;
  /** Epoch ms of data-access expiry, when present. */
  readonly dataAccessExpiresAt?: number;
  /** For PAGE tokens, the Page ID the token acts as (`profile_id`). */
  readonly profileId?: string;
  /** For USER / SYSTEM_USER tokens, the acting user id. */
  readonly userId?: string;
  /**
   * Why Graph rejected the token, when it said. An invalid `input_token` does
   * NOT come back as an HTTP error — Graph answers 200 with `is_valid: false`
   * and the cause in `data.error`. Reading only `is_valid` reduced every failure
   * to a bare "not valid", which is a symptom with no cause: an expired token, a
   * revoked one, and one issued by a different app all read identically, and the
   * operator has no way to tell whether to re-issue, re-grant, or re-check which
   * app they configured. Absent when the token is valid, and when Graph sent
   * nothing usable — never a fabricated explanation.
   */
  readonly invalidReason?: string;
}

/**
 * Raw `/debug_token` payload. Every field is `unknown` ON PURPOSE (CC-NET-2):
 * this body reaches us through a cast, so a field declared `string` is a hope
 * about the wire, not a fact about the value, and TypeScript will then let a
 * `{}` flow into `.toUpperCase()`. Declaring the truth forces every field
 * through a normalizer below, where the shape is actually checked.
 */
interface DebugTokenData {
  readonly type?: unknown;
  readonly is_valid?: unknown;
  readonly app_id?: unknown;
  readonly scopes?: unknown;
  readonly granular_scopes?: unknown;
  /** Unix **seconds**; 0 ⇒ never-expiring. */
  readonly expires_at?: unknown;
  readonly data_access_expires_at?: unknown;
  readonly profile_id?: unknown;
  readonly user_id?: unknown;
  /** Present on a 200 that reports `is_valid: false` — the reason, in band. */
  readonly error?: unknown;
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

/**
 * Classify `data.type`, defensively (CC-NET-2). The parameter is `unknown`
 * because the body is a cast: `(raw ?? '').toUpperCase()` on a non-string is a
 * TypeError that escapes {@link debugToken} and takes down `facebook_doctor` —
 * the one command an operator runs precisely when their token has stopped
 * working, so the crash lands exactly where the diagnosis was needed. A type
 * we cannot read is what `UNKNOWN` exists to say.
 */
function toTokenType(raw: unknown): TokenType {
  switch (typeof raw === 'string' ? raw.toUpperCase() : '') {
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

/**
 * Graph timestamps are Unix seconds; 0 means never-expiring (⇒ `undefined`).
 * Anything that is not a finite number is dropped rather than coerced
 * (CC-NET-2): `'soon' * 1000` is `NaN`, and the doctor renders token expiry
 * with `new Date(ms).toISOString()`, which throws `RangeError: Invalid time
 * value` on `NaN`. Used for `data_access_expires_at`, whose absence carries no
 * claim; the token's own `expires_at` goes through {@link classifyExpiry}, which
 * keeps the difference between "0" and "nothing usable" (see {@link TokenExpiry}).
 */
function secondsToMs(seconds: unknown): number | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds === 0) {
    return undefined;
  }
  return seconds * 1000;
}

/**
 * The token's own `expires_at`, classified (see {@link TokenExpiry}). Only the
 * literal `0` means never; only a finite positive number is a known instant (a
 * negative epoch is not a moment this token can expire at, and rendering it as
 * 1969 would send an operator chasing a wrong date instead of a missing one).
 * Everything else — absent, non-numeric, NaN, the infinities — is `unknown`,
 * and carries no `expiresAt` so nothing downstream can render junk (CC-NET-2).
 */
function classifyExpiry(raw: unknown): {
  readonly expiry: TokenExpiry;
  readonly expiresAt?: number;
} {
  if (raw === 0) return { expiry: 'never' };
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return { expiry: 'known', expiresAt: raw * 1000 };
  }
  return { expiry: 'unknown' };
}

/**
 * A Graph node id off the wire (CC-NET-2). Strings only, and never coerced:
 * these fields are declared `string` and consumed as such — `profile_id`
 * becomes the doctor's `actingPageId`, an id an operator may go on to address a
 * Page with. A number cannot be rescued: Graph ids run past the safe-integer
 * range, so a numeric id has already lost digits by the time `JSON.parse` is
 * finished with it, and `String(n)` would mint a plausible-looking id that
 * points at nothing. Reporting no id is the only honest answer.
 */
function graphId(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * Parse `scopes` defensively (CC-NET-2). Graph is *documented* to return an array
 * of permission strings, but nothing here validates the wire shape, and
 * {@link DebugTokenInfo.scopes} is declared `readonly string[]`: passing a bare
 * string through would hand consumers a value that answers `.length` with a
 * character count, throws on `.join()` (setup-token's summary) and expands to a
 * set of single characters under `new Set(...)` (the doctor's permission check),
 * which then reports every required permission as missing on a token that has
 * them all. Anything that is not a string is dropped, not coerced.
 */
function normalizeScopes(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return (raw as readonly unknown[]).filter((s): s is string => typeof s === 'string');
}

/**
 * Parse `granular_scopes` defensively (CC-NET-2): entries without a `scope`
 * string are dropped, and a malformed `target_ids` becomes `[]` rather than
 * throwing — an empty target list is itself the CC-AUTH-5 signal. A MISSING
 * `target_ids` is not malformed: Meta leaves it out when the permission applies
 * to every asset, so it is flagged {@link GranularScope.appliesToAllTargets}.
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
    if (rawIds === undefined) {
      // Meta omits the key when the permission covers every asset.
      out.push({ scope, targetIds: [], appliesToAllTargets: true });
      continue;
    }
    const ids = Array.isArray(rawIds)
      ? (rawIds as readonly unknown[]).filter(
          (id): id is string => typeof id === 'string',
        )
      : [];
    out.push({ scope, targetIds: ids });
  }
  return out;
}

/**
 * Render Graph's in-band `data.error` as one operator-facing line, defensively
 * (CC-NET-2). Everything here is untrusted wire data reached through a cast, so
 * each part is used only if it is the type it claims to be: a non-string
 * `message` would otherwise print as `[object Object]` and a non-numeric `code`
 * as `NaN`, which is worse than saying nothing. When nothing usable survives the
 * result is `undefined` — the caller then reports "not valid" with no cause,
 * which is at least true.
 */
function normalizeInvalidReason(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const err = raw as Record<string, unknown>;
  const message = typeof err['message'] === 'string' ? err['message'].trim() : '';
  const nums: string[] = [];
  if (typeof err['code'] === 'number') nums.push(`code ${String(err['code'])}`);
  if (typeof err['subcode'] === 'number') nums.push(`subcode ${String(err['subcode'])}`);
  const detail = nums.join(', ');
  if (message.length > 0) return detail.length > 0 ? `${message} (${detail})` : message;
  return detail.length > 0 ? detail : undefined;
}

function normalizeDebugToken(data: DebugTokenData): DebugTokenInfo {
  // Only meaningful alongside a rejection: Graph has been seen to leave a stale
  // `error` in a body it then reports valid, and echoing it would have the
  // doctor explain the failure of a token that did not fail.
  const reason = data.is_valid === true ? undefined : normalizeInvalidReason(data.error);
  const { expiry, expiresAt } = classifyExpiry(data.expires_at);
  return {
    type: toTokenType(data.type),
    valid: data.is_valid === true,
    appId: graphId(data.app_id),
    scopes: normalizeScopes(data.scopes),
    granularScopes: normalizeGranularScopes(data.granular_scopes),
    expiry,
    expiresAt,
    dataAccessExpiresAt: secondsToMs(data.data_access_expires_at),
    profileId: graphId(data.profile_id),
    userId: graphId(data.user_id),
    ...(reason !== undefined ? { invalidReason: reason } : {}),
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
  const res = await deps.fbRequest<unknown>({
    protocol: 'json',
    method: 'GET',
    host: 'graph',
    path: '/debug_token',
    params: { input_token: inputToken },
    token: deps.accessToken,
    signal: deps.signal,
  });
  return normalizeDebugToken(verdictOf(res.data, res.status));
}

/**
 * The `data` object of a `/debug_token` answer, only when it carries Graph's
 * ruling. Graph always states a boolean `is_valid` when it rules on a token, so
 * a 2xx without one — a bodiless 200, a non-JSON body (a proxy or captive
 * portal page), `{}` with no `data`, a `data` that is not an object, or an
 * `is_valid` that is absent or not a boolean — is not a verdict. Reading it as
 * `valid:false` told the doctor "token malformed, re-issue it" and gave whoami
 * an unexplained invalid token for a credential nobody assessed. It is thrown
 * as an unanswered call instead: no Graph code (`0`) and the real 2xx status, so
 * the doctor classifies it as `token_check_failed` (it only calls a 4xx a
 * ruling) and whoami labels its placeholder `unverified`.
 */
function verdictOf(body: unknown, status: number): DebugTokenData {
  const data =
    typeof body === 'object' && body !== null
      ? (body as { data?: unknown }).data
      : undefined;
  if (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    typeof (data as DebugTokenData).is_valid === 'boolean'
  ) {
    return data;
  }
  throw new GraphApiError(
    `debug_token answered HTTP ${String(status)} without an is_valid verdict — ` +
      `Graph did not rule on the token, so its validity is unknown.`,
    {
      code: 0,
      httpStatus: status,
      action: {
        category: 'unknown',
        retryable: false,
        nextTool: 'facebook_whoami',
        operatorText:
          'The debug_token answer carried no is_valid verdict (an empty or non-Graph ' +
          'body, e.g. from a proxy). The token was not assessed: do not re-issue it on ' +
          'this basis — check the network path to graph.facebook.com and re-run the doctor.',
      },
    },
  );
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
   * Run a page-scoped Graph operation with the resolved token. On error 190 (or
   * 102, session expired) from a **derived** token: invalidate, re-derive once, and retry the operation
   * exactly once; a second 190/102 (or a dead base token) evicts the token and
   * fails with guidance. An
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
 * Subcodes of error 190 that lock the ACCOUNT, not the token: 459 (checkpoint)
 * and 464 (unconfirmed user). Every token issued for the account is refused the
 * same way until a person clears the block, so "refresh the token" is advice
 * that loops (see the `auth-190-459` / `auth-190-464` matrix rows).
 */
const ACCOUNT_BLOCK_SUBCODES: Readonly<Record<number, string>> = {
  459: 'checkpointed',
  464: 'unconfirmed',
};

/**
 * Subcode of error 190 meaning the token is VALID but its user has no role on
 * the Page it tried to act for (the `permission-190-492` matrix row). A fresh
 * token for the same user is refused identically, so derivation must not call
 * the base token "invalid or expired" on it.
 */
const SUBCODE_NO_PAGE_ROLE = 492;

/** The account-block wording for a 190/459 or 190/464, else `undefined`. */
function accountBlockOf(err: unknown): string | undefined {
  if (!isTokenDead(err)) return undefined;
  const subcode = (err as GraphApiError).subcode;
  return subcode !== undefined && Object.hasOwn(ACCOUNT_BLOCK_SUBCODES, subcode)
    ? ACCOUNT_BLOCK_SUBCODES[subcode]
    : undefined;
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

/**
 * Whether `err` proves a cached Page token is worthless: the token itself is
 * dead (190 / 102), or the Page id it was derived for is a stale object
 * (100 with subcode 21 / 33). A tool layer that turns such an error into its own
 * result — instead of throwing it to the hub — evicts the Page token on it.
 */
export function isPageTokenDead(err: unknown): boolean {
  return isOpTokenDead(err) || isStalePageObject(err);
}

/**
 * A token refused as dead by an operation: 190, or 102 (API session expired /
 * revoked). Only the resolver's cache rail uses the wider set — derivation keeps
 * its 190-specific guidance and leaves a base-token 102 to the error matrix.
 */
function isOpTokenDead(err: unknown): boolean {
  return (
    err instanceof GraphApiError &&
    (err.code === ERROR_CODE_TOKEN_INVALID || err.code === ERROR_CODE_SESSION)
  );
}

/** The Graph code to name in guidance: the real one, else 190. */
function deadCodeOf(err: unknown): number {
  return err instanceof GraphApiError ? err.code : ERROR_CODE_TOKEN_INVALID;
}

/** The CC-AUTH-7 cache signal: drop the cached Page token and re-derive once. */
function invalidatesPageCache(err: unknown): boolean {
  return isOpTokenDead(err) || isStalePageObject(err);
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

/**
 * Read `access_token` out of a derive response without trusting the declared
 * type. `FbResponse<T>.data` is a CAST, not a validation (core/http.ts parses
 * the body and hands the result back as `T`), so three shapes reach here on a
 * 2xx that the type says cannot: `undefined` from a bodiless 200 — which the
 * client produces BY DESIGN — the raw string of a body that was not JSON, and
 * any JSON that is simply not this object. Dereferencing `.access_token`
 * through the first two throws `TypeError: Cannot read properties of undefined`
 * — an unclassified crash exactly where the caller needed the actionable "the
 * base token may lack a role on this Page" error and its `permission` action.
 * A non-string value is the quieter half of the same problem: it has no
 * `.length`, so an emptiness check waves it through, and a number ends up
 * registered with the redactor and pasted into an `Authorization` header. Only a non-blank string
 * is a token; everything else is "no token", which the caller already knows how
 * to explain.
 */
function readAccessToken(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const raw = (data as { access_token?: unknown }).access_token;
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
  return raw;
}

/** Create the per-page token resolver (C1). */
export function createPageTokenResolver(deps: PageTokenResolverDeps): PageTokenResolver {
  const cache = new Map<string, CacheEntry>();
  /**
   * One shared derivation per Page. Concurrent resolves after a cache miss (a
   * burst of parallel tool calls, or the moment the TTL lapses) would otherwise
   * each spend a `/{page}?fields=access_token` call against the rate-limit
   * budget. A flight is removed when it settles, so a rejection is never cached.
   */
  const inflight = new Map<string, Promise<string>>();
  /**
   * Bumped by `invalidate`. A derivation caches its result only if no
   * invalidation happened while it was in flight — a flight that started before
   * the token was reported dead must not overwrite a newer derivation.
   */
  const epochs = new Map<string, number>();
  const epochOf = (pageId: string): number => epochs.get(pageId) ?? 0;
  const overrides = deps.overrides ?? {};

  /**
   * Look up a configured override by OWN property only. `overrides` is a plain
   * object, so a bare `overrides[pageId]` answers inherited `Object.prototype`
   * members too: a Page id of `toString` / `constructor` / `__proto__` reads back
   * a function or the prototype object, which the `!== undefined` guard then
   * accepts as a configured token — `resolve` would return a non-string from a
   * `Promise<string>` and skip derivation entirely.
   */
  const overrideFor = (pageId: string): string | undefined =>
    Object.hasOwn(overrides, pageId) ? overrides[pageId] : undefined;

  // Register configured overrides as secrets up front — they exist from startup.
  for (const token of Object.values(overrides)) {
    deps.redactor.addSecret(token);
  }

  const isFresh = (entry: CacheEntry): boolean =>
    deps.cacheTtlMs === undefined || deps.clock.now() - entry.derivedAt < deps.cacheTtlMs;

  const derive = async (pageId: string, signal?: AbortSignal): Promise<string> => {
    const baseToken = deps.baseToken;
    if (baseToken === undefined || baseToken.length === 0) {
      // One message for both operators who land here: the one with no token at
      // all, and the one whose FB_PAGE_TOKEN is set without FB_PAGE_ID (bound to
      // nothing, so `overrides` is empty and this resolver cannot tell the two
      // apart). "Bind" is right for both; "provide a Page token" was wrong for
      // the second.
      throw tokenDeadError(
        `No base token available to derive a Page token for Page ${pageId}. ` +
          `Set FB_SYSTEM_TOKEN or FB_ACCESS_TOKEN so a Page token can be derived, ` +
          `or bind a long-lived Page token to this Page: FB_PAGE_TOKEN with ` +
          `FB_PAGE_ID=${pageId}, or FB_PROFILE_<NAME>_TOKEN with ` +
          `FB_PROFILE_<NAME>_PAGE_ID=${pageId}. A Page token that is set without ` +
          `its Page ID is bound to nothing. Then run the doctor (facebook_whoami).`,
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
      const block = accountBlockOf(err);
      if (block !== undefined) {
        throw tokenDeadError(
          `The account behind the base token is ${block} (Graph error ` +
            `190/${String((err as GraphApiError).subcode)}) — cannot derive a Page ` +
            `token for Page ${pageId}. Meta refuses every token issued for this ` +
            `account until a person clears it, so do not mint a new one yet: log ` +
            `in to facebook.com as that user, resolve it, then run the doctor ` +
            `(facebook_whoami).`,
          err,
        );
      }
      if (isTokenDead(err) && (err as GraphApiError).subcode === SUBCODE_NO_PAGE_ROLE) {
        throw tokenDeadError(
          `The base token is valid, but its user has no role on Page ${pageId} ` +
            `(Graph error 190/492) — cannot derive a Page token for it. Refreshing ` +
            `FB_SYSTEM_TOKEN / FB_ACCESS_TOKEN will not help: the same user is ` +
            `refused again. Grant that user a Page role in Meta Business Suite, ` +
            `then run the doctor (facebook_whoami).`,
          err,
        );
      }
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

    const token = readAccessToken(res.data);
    if (token === undefined) {
      // Graph ANSWERED (2xx, no error envelope) and simply left the field out,
      // so there is no Graph code to report: `0` is this codebase's "no Graph
      // code" value, and the status is the one Graph actually sent. Inventing
      // 190 / 403 put "Invalid OAuth access token" into the tool result next to
      // a message saying the token is fine but lacks a role, and made every
      // eviction hook (`isPageTokenDead`) read a missing role as a dead token.
      const message =
        `Graph returned no Page access token for Page ${pageId}. The base token ` +
        `may lack a role on this Page or the ` +
        `pages_show_list / pages_manage_metadata permission — run the doctor ` +
        `(facebook_whoami).`;
      throw new GraphApiError(message, {
        code: 0,
        httpStatus: res.status,
        action: {
          category: 'permission',
          retryable: false,
          nextTool: 'facebook_whoami',
          operatorText:
            'Graph answered the Page-token derivation without an access_token. Refreshing ' +
            'the base token will not help: grant its user a role on this Page (and the ' +
            'pages_show_list / pages_manage_metadata permissions), then run facebook_whoami.',
        },
      });
    }

    // A per-Page token derived after startup must be scrubbable immediately (C1).
    deps.redactor.addSecret(token);
    return token;
  };

  const resolve = async (pageId: string, signal?: AbortSignal): Promise<string> => {
    const override = overrideFor(pageId);
    if (override !== undefined) return override; // first-class fallback; never derive

    const cached = cache.get(pageId);
    if (cached !== undefined && isFresh(cached)) return cached.token;

    const deriveAndCache = async (): Promise<string> => {
      const epoch = epochOf(pageId);
      const token = await derive(pageId, signal);
      if (epochOf(pageId) === epoch) {
        cache.set(pageId, { token, derivedAt: deps.clock.now() });
      }
      return token;
    };

    // A caller with its own AbortSignal derives alone: sharing its flight would
    // let one caller's abort reject every other caller waiting on the same Page.
    if (signal !== undefined) return deriveAndCache();

    const pending = inflight.get(pageId);
    if (pending !== undefined) return pending;

    const flight = deriveAndCache().finally(() => {
      if (inflight.get(pageId) === flight) inflight.delete(pageId);
    });
    inflight.set(pageId, flight);
    return flight;
  };

  const invalidate = (pageId: string): void => {
    cache.delete(pageId);
    inflight.delete(pageId);
    epochs.set(pageId, epochOf(pageId) + 1);
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
      if (overrideFor(pageId) !== undefined) {
        if (isStalePageObject(err)) {
          throw stalePageError(
            `Page ${pageId} no longer resolves (Graph error 100) — it was merged, ` +
              `renamed or unpublished. Re-run facebook_list_pages for the current ` +
              `Page ID and update FB_PAGE_ID / FB_PROFILE_<NAME>_PAGE_ID.`,
            err,
          );
        }
        throw tokenDeadError(
          `Configured Page token for Page ${pageId} is invalid (Graph error ` +
            `${String(deadCodeOf(err))}). ` +
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
        // The re-derived token was just refused too: evict it so the next
        // resolve derives again instead of serving a token Graph already rejected.
        if (invalidatesPageCache(err2)) invalidate(pageId);
        if (isStalePageObject(err2)) {
          throw stalePageError(
            `Page ${pageId} still does not resolve after one re-derivation (Graph ` +
              `error 100) — the Page was merged, renamed or unpublished. Re-run ` +
              `facebook_list_pages for the current Page ID and update ` +
              `FB_PAGE_ID / FB_PROFILE_<NAME>_PAGE_ID.`,
            err2,
          );
        }
        if (isOpTokenDead(err2)) {
          throw tokenDeadError(
            `Page token for Page ${pageId} is still invalid after one ` +
              `re-derivation (Graph error ${String(deadCodeOf(err2))}). The base token may have lost ` +
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
