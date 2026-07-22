// In-memory PageResolver fake (test-only).
//
// Returns pre-configured pages by profile key or raw Page ID, records resolve
// calls and invalidations, and can be told to fail (simulating token death or an
// ambiguous-name refusal). No network, no ALS.

import type { PageRef, PageResolver, ResolvedPage } from '../types.js';

/** Config for {@link createFakePageResolver}. */
export interface FakePageResolverConfig {
  /** Page returned when `resolvePage()` is called with no profile. */
  readonly default?: ResolvedPage;
  /** Pages keyed by profile name (and matched by raw Page ID too). */
  readonly pages?: Readonly<Record<string, ResolvedPage>>;
}

/** A {@link PageResolver} with recorded calls and controllable failure. */
export interface FakePageResolver extends PageResolver {
  /** Profiles passed to `resolvePage()`, in order. */
  readonly resolveCalls: readonly (PageRef | undefined)[];
  /** Page IDs passed to `invalidate()`, in order. */
  readonly invalidated: readonly string[];
  /** Register/replace a page for a profile key (undefined ⇒ the default). */
  setPage(profile: PageRef | undefined, page: ResolvedPage): void;
  /** Make every subsequent `resolvePage()` reject with `error`; pass undefined to clear. */
  failWith(error: Error | undefined): void;
}

/** Create a page resolver seeded from `config`. */
export function createFakePageResolver(
  config: FakePageResolverConfig = {},
): FakePageResolver {
  const pages = new Map<string, ResolvedPage>(Object.entries(config.pages ?? {}));
  let defaultPage = config.default;
  let failure: Error | undefined;
  const resolveCalls: (PageRef | undefined)[] = [];
  const invalidated: string[] = [];

  const lookup = (profile: PageRef | undefined): ResolvedPage | undefined => {
    if (profile === undefined) return defaultPage;
    const byKey = pages.get(profile);
    if (byKey) return byKey;
    // Also match a raw Page ID against configured pages.
    for (const page of pages.values()) {
      if (page.pageId === profile) return page;
    }
    if (defaultPage?.pageId === profile) return defaultPage;
    return undefined;
  };

  return {
    get resolveCalls() {
      return resolveCalls;
    },
    get invalidated() {
      return invalidated;
    },
    resolvePage: (profile?: PageRef): Promise<ResolvedPage> => {
      resolveCalls.push(profile);
      if (failure) {
        return Promise.reject(failure);
      }
      const page = lookup(profile);
      if (!page) {
        return Promise.reject(
          new Error(
            profile === undefined
              ? 'fakePageResolver: no default page configured'
              : `fakePageResolver: no page configured for profile "${profile}"`,
          ),
        );
      }
      return Promise.resolve(page);
    },
    invalidate: (pageId: string): void => {
      invalidated.push(pageId);
    },
    setPage: (profile: PageRef | undefined, page: ResolvedPage): void => {
      if (profile === undefined) {
        defaultPage = page;
      } else {
        pages.set(profile, page);
      }
    },
    failWith: (error: Error | undefined): void => {
      failure = error;
    },
  };
}
