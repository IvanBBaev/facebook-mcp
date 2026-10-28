// Graph-side helpers of the `setup-token` flow: token classification and its
// failure remedy, the package-scope cross-reference, `/me/accounts` parsing and
// the explicit Page-token derivation.

import { GraphApiError, type PackageName, type Settings } from '../../core/index.js';
import { PACKAGE_PERMISSIONS } from '../../mcp/doctor.js';
import {
  DEFAULT_PROFILE_PACKAGES,
  expandSelection,
  sortByCanonical,
} from '../../mcp/packages.js';
import { trimmed } from './args.js';
import type {
  MissingPackageScope,
  SetupTokenClassification,
  SetupTokenDeps,
  SetupTokenPage,
} from './types.js';

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * One `/me/accounts` entry. Every field is `unknown` on purpose: this is
 * untrusted Graph JSON, not a validated shape, and it is parsed defensively
 * (CC-NET-2) — a `tasks` that is not an array must not reach the renderer,
 * which joins that list.
 */
export interface RawPageAccount {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly category?: unknown;
  readonly tasks?: unknown;
  readonly access_token?: unknown;
}

/** A non-empty trimmed string, or `undefined` for any other JSON shape. */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? trimmed(value) : undefined;
}

/** Graph sends `tasks` as strings; anything else is dropped, never rendered. */
function normalizeTasks(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return (value as readonly unknown[]).filter(
    (task): task is string => typeof task === 'string',
  );
}

export const UNKNOWN_TOKEN: SetupTokenClassification = {
  valid: false,
  type: 'UNKNOWN',
  scopes: [],
  expiry: 'unknown',
};

/** The credential authorizing `debug_token` (Graph wants one distinct from the input). */
export function debugCredential(settings: Settings, token: string): string {
  return settings.appId !== undefined && settings.appSecret !== undefined
    ? `${settings.appId}|${settings.appSecret}`
    : token;
}

/**
 * The packages this install will actually run, for the scope cross-reference.
 *
 * An unparseable `FB_TOOL_PACKAGES` is not this command's job to fix — the server
 * refuses to start on it and says so. But it IS this command's job to stop
 * claiming otherwise: falling back to the default profile silently means the whole
 * scope cross-reference below is computed against a package set the install will
 * never load, and the operator finishes onboarding believing they are configured.
 * The fallback stays (a scope report is still worth more than an aborted setup);
 * the silence does not.
 */
export function targetPackages(
  settings: Settings,
  warnings: string[],
  redact: (err: unknown) => string,
): readonly PackageName[] {
  const selection = settings.toolPackages;
  if (selection === undefined || selection.length === 0) {
    return DEFAULT_PROFILE_PACKAGES;
  }
  try {
    return sortByCanonical(expandSelection([...selection], 'FB_TOOL_PACKAGES'));
  } catch (err) {
    warnings.push(
      `FB_TOOL_PACKAGES could not be read (${redact(err)}); the scope report below ` +
        'covers the default package set instead. Fix that variable before starting ' +
        'the server — it will refuse to start until you do.',
    );
    return DEFAULT_PROFILE_PACKAGES;
  }
}

/** Scope → packages that need it, for every scope the token did not grant. */
export function findMissingPackageScopes(
  packages: readonly PackageName[],
  granted: ReadonlySet<string>,
): MissingPackageScope[] {
  const byScope = new Map<string, PackageName[]>();
  for (const name of packages) {
    for (const scope of PACKAGE_PERMISSIONS[name] ?? []) {
      if (granted.has(scope)) continue;
      const owners = byScope.get(scope) ?? [];
      owners.push(name);
      byScope.set(scope, owners);
    }
  }
  return [...byScope.entries()]
    .map(([scope, owners]) => ({ scope, packages: owners }))
    .sort((a, b) => a.scope.localeCompare(b.scope));
}

export function toPage(
  account: RawPageAccount & { id: string },
  selectedPageId: string | undefined,
): SetupTokenPage {
  const name = asString(account.name);
  const category = asString(account.category);
  return {
    id: account.id,
    name: name ?? '(unnamed Page)',
    ...(category !== undefined ? { category } : {}),
    tasks: normalizeTasks(account.tasks),
    // Presence only — the value is dropped here and never enters the result
    // (it is registered with the redactor at the listing, see runSetupToken).
    hasToken: asString(account.access_token) !== undefined,
    selected: account.id === selectedPageId,
  };
}

/**
 * Derive a Page token explicitly; a failure is a warning, never a throw. The
 * failure's (redacted) reason is handed back: a timeout or a dead token is not
 * fixed by checking the Page role, and the operator needs Graph's own words to
 * tell which one it was.
 */
export async function derivePageToken(
  deps: SetupTokenDeps,
  pageId: string,
  baseToken: string,
  redact: (err: unknown) => string,
): Promise<{ readonly token?: string; readonly error?: string }> {
  try {
    const res = await deps.fbRequest<{ access_token?: string }>({
      protocol: 'json',
      method: 'GET',
      host: 'graph',
      path: `/${pageId}`,
      params: { fields: 'access_token' },
      token: baseToken,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    });
    const token = trimmed(res.data.access_token);
    return token !== undefined ? { token } : {};
  } catch (err) {
    return { error: redact(err) };
  }
}

/**
 * The remedy for a `debug_token` call that did not classify the pasted token.
 * Mirrors the doctor's verdict: only a real 4xx rejection is Facebook's ruling
 * on the token. A network fault, a 5xx or a throttle means the token was never
 * assessed, so sending the operator to regenerate it (or to check app
 * credentials that may not even be set) would be the wrong fix.
 */
export function classifyFailureDetail(
  err: unknown,
  message: string,
  settings: Settings,
): string {
  const category = err instanceof GraphApiError ? err.action?.category : undefined;
  const answered =
    err instanceof GraphApiError &&
    err.httpStatus >= 400 &&
    err.httpStatus < 500 &&
    category !== 'transient' &&
    category !== 'rate_limit';
  if (!answered) {
    const operatorText =
      err instanceof GraphApiError ? err.action?.operatorText : undefined;
    return (
      `Graph did not answer the token check: ${message}` +
      (operatorText !== undefined ? ` — ${operatorText}` : '') +
      '. The token was not assessed, so do not regenerate it yet: check the ' +
      'network (and any HTTPS_PROXY), then re-run while the pasted token is ' +
      'still valid (Graph API Explorer user tokens last about 1-2 hours).'
    );
  }
  // `debugCredential` inspects with the app token only when both are set.
  const appCreds = settings.appId !== undefined && settings.appSecret !== undefined;
  return appCreds
    ? `Graph could not classify the token: ${message}. Check FB_APP_ID / ` +
        'FB_APP_SECRET (App settings → Basic) and that the token belongs to that app.'
    : `Graph rejected the token: ${message}. It may have expired or been ` +
        'copied incompletely; generate a fresh User token in Graph API Explorer.';
}
