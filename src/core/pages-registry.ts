// Pages registry for facebook-mcp (task F09) — the frozen `PageResolver`, no
// AsyncLocalStorage (cluster C14).
//
// A Page is an **explicit argument**, not ambient context. This trivial registry
// maps the optional `profile` tool argument — a profile key OR a raw Page ID — to
// a concrete Page and its token, delegating token derivation/caching to the C1
// per-page token resolver in `./auth.ts`.
//
// Config comes from the injected, frozen `Settings` (this module never reads env
// or depends on F04's loader):
//   * default Page  ← `FB_PAGE_ID`            (Settings.defaultPageId)
//   * named profiles ← `FB_PROFILE_<NAME>_PAGE_ID` (+ optional token override)
//                                              (Settings.profiles)
//
// Token precedence (CC-AUTH-9): a base user/system token derives per-Page tokens
// (system wins over user); a long-lived `FB_PAGE_TOKEN` is the first-class
// fallback for the default Page when no base token exists; a per-profile token
// override is always honored for that profile.
//
// Ambiguity is refused, never guessed (CC-AUTH-6): an exact profile-key match
// wins; a raw Page ID that maps to several profiles with conflicting tokens is
// rejected with the candidate keys.

import { DEFAULT_PROFILE_KEY } from './types.js';
import type {
  Clock,
  FbRequestFn,
  Logger,
  PageRef,
  PageResolver,
  Redactor,
  ResolvedPage,
  Settings,
} from './types.js';
import { createPageTokenResolver, type PageTokenResolver } from './auth.js';

/**
 * Lifetime of a cached derived Page token when the caller sets none.
 *
 * The resolver's own default is "cache until explicitly invalidated" (auth.ts),
 * which is the right contract for a caller that drives the full C1 rail. No
 * production caller does: `runWithPageToken` is not surfaced through this
 * registry, and nothing outside the registry calls `invalidate`. So with no TTL
 * the cache has NO eviction path at all — a Page token that Meta revokes (a
 * password change, a removed role, a permission pulled in app review) stays
 * cached for the whole process lifetime, every call on that Page keeps failing
 * with the same dead token, and the only recovery is restarting the server.
 *
 * A bounded TTL turns that into a bounded outage. The cost is one `/PAGE_ID`
 * derivation per Page per window, which is negligible against Graph's own
 * limits; fifteen minutes keeps it that way while capping the blind spot at
 * something an operator will sit through rather than debug.
 */
const DEFAULT_TOKEN_CACHE_TTL_MS = 15 * 60_000;

/** One resolvable Page: a profile or the default, plus how its token is obtained. */
interface ProfileEntry {
  /** Human-facing label: the profile key, or `DEFAULT_PROFILE_KEY` for the default. */
  readonly key: string;
  readonly pageId: string;
  /** Explicit per-profile token override, if configured. */
  readonly tokenOverride?: string;
  readonly isDefault: boolean;
}

/** Injected inputs for {@link createPagesRegistry}. */
export interface PagesRegistryDeps {
  readonly settings: Settings;
  readonly fbRequest: FbRequestFn;
  readonly clock: Clock;
  readonly redactor: Redactor;
  /** Optional stderr logger — the active credential is logged once (CC-AUTH-9). */
  readonly logger?: Logger;
  /**
   * Derived-token cache TTL in ms, forwarded to the token resolver. Omitted ⇒
   * {@link DEFAULT_TOKEN_CACHE_TTL_MS}, because this registry exposes no way to
   * invalidate an entry from production code.
   */
  readonly cacheTtlMs?: number;
  /**
   * Optional shared token resolver. Production wiring injects a single resolver
   * so the registry and the HTTP retry layer share one cache; omitted ⇒ the
   * registry builds its own from `settings`.
   */
  readonly tokenResolver?: PageTokenResolver;
}

function buildEntries(settings: Settings): ProfileEntry[] {
  const entries: ProfileEntry[] = [];

  if (settings.defaultPageId !== undefined && settings.defaultPageId.length > 0) {
    entries.push({
      key: DEFAULT_PROFILE_KEY,
      pageId: settings.defaultPageId,
      isDefault: true,
    });
  }

  for (const [key, profile] of Object.entries(settings.profiles)) {
    entries.push({
      key,
      pageId: profile.pageId,
      tokenOverride: profile.tokenOverride,
      isDefault: false,
    });
  }

  return entries;
}

/**
 * Build the `pageId → token` override map and the base token from settings.
 *
 * Precedence (CC-AUTH-9): the base token is `systemToken ?? accessToken` (system
 * wins). `FB_PAGE_TOKEN` is used verbatim for the default Page **only when no
 * base token exists** (first-class fallback route B).
 *
 * Per-profile overrides are deliberately NOT in this map. The resolver keys its
 * overrides by Page ID, and `resolvePage` hands a profile its own override
 * before ever consulting the resolver — so the only thing a profile override
 * in this map could ever reach is a DIFFERENT entry on the same Page ID, which
 * in practice is the default Page. An operator who points a profile at the
 * default's Page with its own token (a rotation in flight, a narrowly-scoped
 * token for one workflow) then has every call that names no profile silently
 * act under that profile's token instead of the base credential, while the
 * same Page by raw ID is refused as ambiguous one door over (CC-AUTH-6). With
 * no base token it also blocks FB_PAGE_TOKEN from ever being installed. An
 * override belongs to the profile that declared it, and to nothing else.
 */
function buildTokenPlan(settings: Settings): {
  baseToken?: string;
  overrides: Record<string, string>;
} {
  const baseToken = settings.systemToken ?? settings.accessToken;
  const overrides: Record<string, string> = {};

  // Long-lived Page token is the default Page's token only when nothing can
  // derive one — a base token (system/user) always wins over it.
  if (
    baseToken === undefined &&
    settings.pageToken !== undefined &&
    settings.pageToken.length > 0 &&
    settings.defaultPageId !== undefined
  ) {
    overrides[settings.defaultPageId] = settings.pageToken;
  }

  return { baseToken, overrides };
}

function logActiveCredential(settings: Settings, logger: Logger | undefined): void {
  if (logger === undefined) return;
  let credential: string;
  if (settings.systemToken !== undefined) {
    credential = 'system-user token (FB_SYSTEM_TOKEN)';
  } else if (settings.accessToken !== undefined) {
    credential = 'user token (FB_ACCESS_TOKEN)';
  } else if (settings.pageToken !== undefined) {
    credential = 'long-lived Page token (FB_PAGE_TOKEN)';
  } else {
    credential = 'none';
  }
  // Both FB_SYSTEM_TOKEN and FB_PAGE_TOKEN set ⇒ system wins (CC-AUTH-9).
  logger.info('Resolved active Facebook credential for page resolution', {
    credential,
    pageTokenAlsoSet: settings.pageToken !== undefined,
  });

  // A long-lived Page token is the credential of exactly ONE Page, and
  // FB_PAGE_ID is the only setting that names which (`buildTokenPlan`): a
  // profile Page takes FB_PROFILE_<NAME>_TOKEN, never FB_PAGE_TOKEN. F04 accepts
  // FB_PAGE_TOKEN as the sole credential as long as SOME Page is configured, so
  // "FB_PAGE_TOKEN plus a profile, no FB_PAGE_ID" passes startup with a token
  // bound to nothing — every Page-scoped call then fails with the resolver's
  // "no base token; provide FB_PAGE_TOKEN", which the operator has already done,
  // while the line above just called that token the active credential. Say so
  // once, here, where the binding is known to be missing.
  if (
    settings.systemToken === undefined &&
    settings.accessToken === undefined &&
    settings.pageToken !== undefined &&
    (settings.defaultPageId === undefined || settings.defaultPageId.length === 0)
  ) {
    logger.warn(
      'FB_PAGE_TOKEN is set but FB_PAGE_ID is not, so the Page token is bound to ' +
        'no Page and no Page-scoped call can resolve a token. Set FB_PAGE_ID to ' +
        "that token's Page, or give each profile its own FB_PROFILE_<NAME>_TOKEN, " +
        'or configure FB_SYSTEM_TOKEN / FB_ACCESS_TOKEN to derive Page tokens.',
      { profiles: Object.keys(settings.profiles).length },
    );
  }
}

/**
 * Warn once for every profile key that equals ANOTHER Page's raw ID.
 *
 * An exact profile-key match wins over a raw-ID match (CC-AUTH-6: an explicit
 * key is never a guess), so a profile keyed `999` pointing at Page 111 makes
 * Page 999's raw ID unreachable: `profile: "999"` resolves to Page 111. A
 * caller that passes the raw ID it read back from facebook_list_pages then
 * acts on the wrong Page, and nothing in the result says so. The precedence
 * stays; the operator is told at startup which ID is shadowed and by whom. Only
 * key names and Page IDs are logged — never a token.
 */
function warnShadowedPageIds(
  entries: readonly ProfileEntry[],
  logger: Logger | undefined,
): void {
  if (logger === undefined) return;
  for (const shadowing of entries) {
    const shadowed = entries.filter(
      (e) => e.pageId === shadowing.key && e.pageId !== shadowing.pageId,
    );
    if (shadowed.length === 0) continue;
    const owners = shadowed.map((e) => e.key).join(', ');
    logger.warn(
      `Profile key "${shadowing.key}" shadows the raw Page ID of profile(s) ${owners}: ` +
        `profile "${shadowing.key}" resolves to Page ${shadowing.pageId}, so Page ` +
        `${shadowing.key} can only be reached by its profile key (${owners}), never by ` +
        `its raw ID. Rename the profile so its key is not a Page ID.`,
      { profile: shadowing.key, pageId: shadowing.pageId },
    );
  }
}

/**
 * Create the frozen {@link PageResolver}. Reads its topology from `settings`,
 * derives/caches per-Page tokens via the C1 resolver, and refuses ambiguous
 * references rather than guessing.
 */
export function createPagesRegistry(deps: PagesRegistryDeps): PageResolver {
  const { settings } = deps;
  const entries = buildEntries(settings);
  const { baseToken, overrides } = buildTokenPlan(settings);

  // Profile overrides exist from startup and are returned to callers verbatim,
  // so they are scrubbable from startup too. The resolver used to do this as a
  // side effect of holding them; it no longer holds them (see `buildTokenPlan`).
  for (const entry of entries) {
    if (entry.tokenOverride !== undefined && entry.tokenOverride.length > 0) {
      deps.redactor.addSecret(entry.tokenOverride);
    }
  }

  const tokenResolver =
    deps.tokenResolver ??
    createPageTokenResolver({
      fbRequest: deps.fbRequest,
      baseToken,
      clock: deps.clock,
      redactor: deps.redactor,
      overrides,
      cacheTtlMs: deps.cacheTtlMs ?? DEFAULT_TOKEN_CACHE_TTL_MS,
    });

  logActiveCredential(settings, deps.logger);
  warnShadowedPageIds(entries, deps.logger);

  const knownKeys = (): string => {
    const keys = entries.map((e) => e.key);
    return keys.length > 0 ? keys.join(', ') : '(none)';
  };

  const selectEntry = (ref: PageRef | undefined): ProfileEntry => {
    if (ref === undefined) {
      const def = entries.find((e) => e.isDefault);
      if (def === undefined) {
        // Name the keys: a caller that omitted `profile` has no other in-band way
        // to learn which ones exist, so without them its next call is a guess.
        throw new Error(
          'No default Page configured. Set FB_PAGE_ID, or pass an explicit ' +
            'profile — a profile key from FB_PROFILE_<NAME>_PAGE_ID or a raw Page ID. ' +
            `Known profiles: ${knownKeys()}.`,
        );
      }
      return def;
    }

    // The reference is normalized the way the config it names already was: F04
    // lowercases every profile key and refuses two spellings of one name as a
    // duplicate, so `acme` is the ONLY key an operator who wrote
    // FB_PROFILE_Acme_PAGE_ID can reach — while `Acme` is the spelling they read
    // back out of their own env and pass as `profile`. Matching that exactly
    // failed with "Unknown Page reference", which reads as a missing profile and
    // sends the operator to fix a config that was never wrong. Surrounding
    // whitespace goes the same way: a Page ID pasted with a trailing space names
    // the same Page.
    const trimmed = ref.trim();

    // 1. An exact profile-key match is explicit and always wins (never a guess).
    const byKey = entries.find((e) => e.key === trimmed);
    if (byKey !== undefined) return byKey;

    // 2. Then the same match case-insensitively. F04 cannot produce two keys
    //    differing only in case, but this registry resolves any injected
    //    Settings, and folding two distinct Pages onto whichever came first is
    //    the coin flip CC-AUTH-6 exists to refuse — a write would land on the
    //    wrong Page with no sign anything was ambiguous.
    const folded = trimmed.toLowerCase();
    const byFoldedKey = entries.filter((e) => e.key.toLowerCase() === folded);
    if (byFoldedKey.length === 1) return byFoldedKey[0]!;
    if (byFoldedKey.length > 1) {
      const candidates = byFoldedKey.map((e) => e.key).join(', ');
      throw new Error(
        `Ambiguous profile key "${ref}": it matches several configured profiles ` +
          `(${candidates}) that differ only in case. Pass one of them exactly as ` +
          `configured.`,
      );
    }

    // 3. Otherwise resolve by raw Page ID across the default + all profiles.
    const byId = entries.filter((e) => e.pageId === trimmed);
    if (byId.length === 0) {
      throw new Error(
        `Unknown Page reference "${ref}". Known profiles: ${knownKeys()}. Pass a ` +
          `configured profile key or the default Page's raw ID.`,
      );
    }

    // Conflicting configs for the same Page ID (different tokens) ⇒ ambiguous.
    const signatures = new Set(byId.map((e) => e.tokenOverride ?? '<derive>'));
    if (signatures.size > 1) {
      const candidates = byId.map((e) => e.key).join(', ');
      throw new Error(
        `Ambiguous Page reference "${ref}": it maps to multiple profiles ` +
          `(${candidates}) with different tokens. Pass a specific profile key ` +
          `instead — profiles keyed by name are always unambiguous.`,
      );
    }

    return byId[0]!;
  };

  return {
    resolvePage: async (profile?: PageRef): Promise<ResolvedPage> => {
      const entry = selectEntry(profile);

      // A per-profile token override belongs to the profile, not the Page ID: two
      // profiles may share a Page ID with different override tokens, which the
      // resolver's Page-ID-keyed cache cannot distinguish. Return the entry's own
      // override verbatim (registered as a secret at construction, and again
      // here in case an injected redactor was swapped); only derivation and the
      // FB_PAGE_TOKEN default fallback go through the shared resolver.
      if (entry.tokenOverride !== undefined && entry.tokenOverride.length > 0) {
        deps.redactor.addSecret(entry.tokenOverride);
        return { pageId: entry.pageId, name: entry.key, token: entry.tokenOverride };
      }

      const token = await tokenResolver.resolve(entry.pageId);
      return { pageId: entry.pageId, name: entry.key, token };
    },
    invalidate: (pageId: string): void => {
      tokenResolver.invalidate(pageId);
    },
  };
}
