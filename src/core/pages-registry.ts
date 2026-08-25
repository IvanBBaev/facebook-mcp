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
  /** Optional derived-token cache TTL in ms (forwarded to the token resolver). */
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
 * base token exists** (first-class fallback route B). Per-profile overrides are
 * always applied for their Page.
 */
function buildTokenPlan(
  settings: Settings,
  entries: readonly ProfileEntry[],
): { baseToken?: string; overrides: Record<string, string> } {
  const baseToken = settings.systemToken ?? settings.accessToken;
  const overrides: Record<string, string> = {};

  for (const entry of entries) {
    if (entry.tokenOverride !== undefined && entry.tokenOverride.length > 0) {
      overrides[entry.pageId] = entry.tokenOverride;
    }
  }

  // Long-lived Page token is the default Page's token only when nothing can
  // derive one — a base token (system/user) always wins over it.
  if (
    baseToken === undefined &&
    settings.pageToken !== undefined &&
    settings.pageToken.length > 0 &&
    settings.defaultPageId !== undefined &&
    overrides[settings.defaultPageId] === undefined
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
}

/**
 * Create the frozen {@link PageResolver}. Reads its topology from `settings`,
 * derives/caches per-Page tokens via the C1 resolver, and refuses ambiguous
 * references rather than guessing.
 */
export function createPagesRegistry(deps: PagesRegistryDeps): PageResolver {
  const { settings } = deps;
  const entries = buildEntries(settings);
  const { baseToken, overrides } = buildTokenPlan(settings, entries);

  const tokenResolver =
    deps.tokenResolver ??
    createPageTokenResolver({
      fbRequest: deps.fbRequest,
      baseToken,
      clock: deps.clock,
      redactor: deps.redactor,
      overrides,
      cacheTtlMs: deps.cacheTtlMs,
    });

  logActiveCredential(settings, deps.logger);

  const knownKeys = (): string => {
    const keys = entries.map((e) => e.key);
    return keys.length > 0 ? keys.join(', ') : '(none)';
  };

  const selectEntry = (ref: PageRef | undefined): ProfileEntry => {
    if (ref === undefined) {
      const def = entries.find((e) => e.isDefault);
      if (def === undefined) {
        throw new Error(
          'No default Page configured. Set FB_PAGE_ID, or pass an explicit ' +
            'profile — a profile key from FB_PROFILE_<NAME>_PAGE_ID or a raw Page ID.',
        );
      }
      return def;
    }

    // 1. An exact profile-key match is explicit and always wins (never a guess).
    const byKey = entries.find((e) => e.key === ref);
    if (byKey !== undefined) return byKey;

    // 2. Otherwise resolve by raw Page ID across the default + all profiles.
    const byId = entries.filter((e) => e.pageId === ref);
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
      // override verbatim (registered as a secret at once); only derivation and the
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
