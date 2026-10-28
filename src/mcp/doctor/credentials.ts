// Token and credential-file inspection for the doctor (shared, not a lane).

import {
  GraphApiError,
  debugToken,
  envFilePath,
  errorMessageOf,
  statFileProtection,
  type GranularScope,
  type Settings,
} from '../../core/index.js';
import {
  type AssetAccess,
  type CredentialFileReport,
  type CredentialSource,
  type DoctorDeps,
  type DoctorTokenReport,
  type PageTokenBinding,
  type TokenDiagnosis,
} from './types.js';

/** A token within this window of expiry (or already past it) is "expiring soon". */
export const EXPIRY_SOON_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Token credential helpers (mirror `tools/core.ts` — both are layer-isolated)
// ---------------------------------------------------------------------------

function runtimeToken(settings: Settings): string | undefined {
  return settings.systemToken ?? settings.accessToken ?? settings.pageToken;
}

/** The credential precedence, highest first — must mirror {@link runtimeToken}. */
const CREDENTIAL_PRECEDENCE: readonly (readonly [
  CredentialSource,
  (s: Settings) => string | undefined,
])[] = [
  ['FB_SYSTEM_TOKEN', (s) => s.systemToken],
  ['FB_ACCESS_TOKEN', (s) => s.accessToken],
  ['FB_PAGE_TOKEN', (s) => s.pageToken],
];

/**
 * Name the credential that actually won, plus the ones that are set and lost
 * (CC-AUTH-9). Two tokens configured is legal and produces no error anywhere —
 * naming the winner is the only way an operator can tell which token the rest
 * of this report is about.
 */
export function activeCredential(settings: Settings): {
  source: CredentialSource;
  shadowed: readonly string[];
} {
  const set = CREDENTIAL_PRECEDENCE.filter(([, read]) => read(settings) !== undefined);
  const winner = set[0];
  if (winner === undefined) return { source: 'none', shadowed: [] };
  return { source: winner[0], shadowed: set.slice(1).map(([name]) => name) };
}

/**
 * Permission families Meta grants PER ASSET, and therefore the ones that appear
 * in `granular_scopes` with `target_ids`. A token holding one of these with no
 * target left is the CC-AUTH-5 fingerprint.
 */
const ASSET_SCOPED_PREFIXES = ['pages_', 'ads_', 'instagram_', 'leads_', 'catalog_'];

/** Non-prefixed permissions that are nonetheless granted per asset. */
const ASSET_SCOPED_EXACT = new Set(['business_management', 'read_insights']);

function isAssetScopedPermission(scope: string): boolean {
  return (
    ASSET_SCOPED_EXACT.has(scope) ||
    ASSET_SCOPED_PREFIXES.some((prefix) => scope.startsWith(prefix))
  );
}

/**
 * Read `granular_scopes` for the CC-AUTH-5 verdict. Only asset-scoped
 * permissions are consulted: a user-level permission legitimately has no
 * `target_ids`, so counting it would report a healthy token as revoked.
 */
export function classifyAssetAccess(
  granularScopes: readonly GranularScope[],
): AssetAccess {
  const assetScoped = granularScopes.filter((entry) =>
    isAssetScopedPermission(entry.scope),
  );
  if (assetScoped.length === 0) return 'not_reported';
  return assetScoped.some(
    (entry) => entry.appliesToAllTargets === true || entry.targetIds.length > 0,
  )
    ? 'ok'
    : 'revoked';
}

/** Collapse validity + asset access into the one verdict CC-AUTH-5 asks for. */
function diagnose(input: {
  configured: boolean;
  valid: boolean;
  assetAccess: AssetAccess;
}): TokenDiagnosis {
  if (!input.configured) return 'no_token';
  if (!input.valid) return 'token_malformed';
  return input.assetAccess === 'revoked' ? 'asset_access_revoked' : 'ok';
}

function usesAppCredential(settings: Settings): boolean {
  return settings.appId !== undefined && settings.appSecret !== undefined;
}

function debugCredential(settings: Settings, token: string): string {
  return usesAppCredential(settings) ? `${settings.appId}|${settings.appSecret}` : token;
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export async function inspectToken(
  deps: DoctorDeps,
  now: number,
): Promise<DoctorTokenReport> {
  const { settings } = deps;
  const runtime = runtimeToken(settings);
  const credential = activeCredential(settings);
  if (runtime === undefined) {
    return {
      configured: false,
      type: 'UNKNOWN',
      valid: false,
      scopes: [],
      credentialSource: credential.source,
      shadowedCredentials: credential.shadowed,
      granularScopes: [],
      assetAccess: 'not_reported',
      diagnosis: 'no_token',
      neverExpiring: false,
      expiryUnknown: false,
      expiringSoon: false,
      error:
        'No access token configured — set FB_SYSTEM_TOKEN, FB_ACCESS_TOKEN, or FB_PAGE_TOKEN.',
    };
  }
  try {
    const info = await debugToken(runtime, {
      fbRequest: deps.fbRequest,
      accessToken: debugCredential(settings, runtime),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    });
    const granularScopes = info.granularScopes ?? [];
    const assetAccess = classifyAssetAccess(granularScopes);
    const binding = bindPageToken(
      credential.source,
      info.profileId,
      settings.defaultPageId,
    );
    return {
      configured: true,
      type: info.type,
      valid: info.valid,
      appId: info.appId,
      scopes: info.scopes,
      credentialSource: credential.source,
      shadowedCredentials: credential.shadowed,
      granularScopes,
      assetAccess,
      diagnosis: diagnose({ configured: true, valid: info.valid, assetAccess }),
      expiresAt: info.expiresAt,
      // Only the wire's literal `expires_at: 0` reads as "never". An answer that
      // said nothing used to land here as the same `undefined` and print the
      // never-expiring line for a token nobody knows the lifetime of.
      neverExpiring: info.valid && info.expiry === 'never',
      expiryUnknown: info.valid && info.expiry === 'unknown',
      expiringSoon:
        info.expiresAt !== undefined && info.expiresAt - now <= EXPIRY_SOON_MS,
      dataAccessExpiresAt: info.dataAccessExpiresAt,
      ...(info.dataAccessExpiresAt !== undefined
        ? {
            dataAccessExpiringSoon: info.dataAccessExpiresAt - now <= EXPIRY_SOON_MS,
          }
        : {}),
      actingUserId: info.userId,
      actingPageId: info.profileId,
      ...(binding !== undefined ? { pageBinding: binding } : {}),
      // Graph rejects a token INSIDE a 200, so this branch — not the catch below
      // — is where most malformed-token verdicts are reached. Without the reason
      // the report printed the verdict and an empty `error:` line. Redacted like
      // every other error string: Graph's message can quote the credential back.
      ...(info.invalidReason !== undefined
        ? { error: deps.redactor.redactString(info.invalidReason) }
        : {}),
    };
  } catch (err) {
    const message = errorMessageOf(err);
    // `core/http` puts the remedy — the CC-NET-6 proxy self-diagnosis for a
    // connection that never opened, the back-off for a throttle — in
    // `action.operatorText`, never in the message. The `error:` line is the one
    // place the report shows this failure, and the diagnosis below sends the
    // operator there for the proxy hint, so the hint has to be on that line.
    const operatorText =
      err instanceof GraphApiError ? err.action?.operatorText : undefined;
    const detail = operatorText !== undefined ? `${message} — ${operatorText}` : message;
    // Did Graph actually rule on this token, or did the call never get an answer?
    // Only a 4xx that is a real rejection is Facebook's verdict. Anything else —
    // `httpStatus: 0` (the network-fault shape), a timeout, a body that would not
    // parse — means the credential was never assessed, and so do the two shapes
    // that arrive wearing a status code without being a ruling: a 5xx is Meta's
    // own outage (or a proxy's 502), and a throttle reaches us as HTTP 400 with a
    // body code (CC-NET-1), so status alone convicted healthy credentials and
    // sent operators off to rotate them.
    const category = err instanceof GraphApiError ? err.action?.category : undefined;
    const answered =
      err instanceof GraphApiError &&
      err.httpStatus >= 400 &&
      err.httpStatus < 500 &&
      category !== 'transient' &&
      category !== 'rate_limit';
    return {
      configured: true,
      type: 'UNKNOWN',
      valid: false,
      scopes: [],
      credentialSource: credential.source,
      shadowedCredentials: credential.shadowed,
      granularScopes: [],
      assetAccess: 'not_reported',
      // debug_token never answered, so asset access is unknowable either way; the
      // two verdicts differ in what the operator should go and fix.
      diagnosis: answered ? 'token_malformed' : 'token_check_failed',
      ...(answered
        ? {
            debugCallRejected: {
              authenticatedWith: usesAppCredential(settings)
                ? ('app_credential' as const)
                : ('token' as const),
            },
          }
        : {}),
      neverExpiring: false,
      expiryUnknown: false,
      expiringSoon: false,
      error: deps.redactor.redactString(detail),
    };
  }
}

/**
 * Relate the acting Page token to `FB_PAGE_ID` (see {@link PageTokenBinding}).
 * `undefined` whenever there is nothing to judge: another credential is acting,
 * or Graph did not name a Page — the doctor never invents one. `FB_PAGE_ID` is
 * compared trimmed, the same way {@link resolveProbePage} reads it, so a stray
 * space around a matching id is not reported as a different Page.
 */
export function bindPageToken(
  source: CredentialSource,
  tokenPageId: string | undefined,
  configuredPageId: string | undefined,
): PageTokenBinding | undefined {
  if (source !== 'FB_PAGE_TOKEN' || tokenPageId === undefined) return undefined;
  const configured = configuredPageId?.trim();
  if (configured === undefined || configured === '') {
    return { status: 'unbound', tokenPageId };
  }
  if (configured === tokenPageId) return { status: 'bound', tokenPageId };
  return { status: 'mismatch', tokenPageId, configuredPageId: configured };
}

/**
 * The one message for a binding that needs the operator (`undefined` for a
 * bound token): it is printed next to `acting as:` in the Token block AND is
 * the detail of the verdict finding, so the report says it once, the same way.
 */
export function describePageBinding(binding: PageTokenBinding): string | undefined {
  switch (binding.status) {
    case 'bound':
      return undefined;
    case 'unbound':
      return `this Page token belongs to Page ${binding.tokenPageId}; set FB_PAGE_ID=${binding.tokenPageId} so Page-scoped tools can use it`;
    case 'mismatch':
      return `this Page token belongs to Page ${binding.tokenPageId}, but FB_PAGE_ID names ${binding.configuredPageId} — Page-scoped tools will call Page ${binding.configuredPageId} with a token for Page ${binding.tokenPageId}; set FB_PAGE_ID=${binding.tokenPageId}`;
  }
}

/**
 * Report the file protection actually observed on the credential file, not the
 * 0600 the writer claims (CC-CFG-4). A missing file is normal (env-only setups),
 * and a stat failure is reported rather than thrown: the doctor is the command
 * an operator runs when things are already broken.
 */
export async function inspectCredentialFile(
  deps: DoctorDeps,
): Promise<CredentialFileReport> {
  const platform = deps.platform ?? process.platform;
  return inspectFileProtection(
    deps,
    deps.credentialFilePath ?? envFilePath({ platform }),
    'No credential file — credentials come from the environment only.',
  );
}

/**
 * The activity state file holds Page ids and timestamps only, but it is kept
 * 0600 like the credential file; an absent file just means no mark is stored.
 */
export async function inspectActivityStateFile(
  deps: DoctorDeps,
): Promise<CredentialFileReport | undefined> {
  const filePath = deps.settings.activityStatePath;
  if (filePath === undefined) return undefined;
  return inspectFileProtection(
    deps,
    filePath,
    'No activity state file yet — written on the first facebook_get_activity_since call.',
  );
}

async function inspectFileProtection(
  deps: DoctorDeps,
  filePath: string,
  absentNote: string,
): Promise<CredentialFileReport> {
  const platform = deps.platform ?? process.platform;
  try {
    const protection = await statFileProtection(filePath, platform);
    return {
      path: filePath,
      exists: true,
      ownerOnly: protection.ownerOnly,
      mode: protection.mode,
      posixPermissions: protection.posixPermissions,
      note: protection.note,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const posixPermissions = platform !== 'win32';
    if (code === 'ENOENT') {
      return {
        path: filePath,
        exists: false,
        posixPermissions,
        note: absentNote,
      };
    }
    const message = errorMessageOf(err);
    return {
      path: filePath,
      exists: false,
      posixPermissions,
      unreadable: true,
      note: `Could not read file protection: ${deps.redactor.redactString(message)}`,
    };
  }
}
