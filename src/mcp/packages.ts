// PACKAGES manifest machinery + default profile expansion (task F11, C5).
//
// This module is the AUTHORITATIVE source of truth for the default tool surface
// (`PackageSpec.enabledByDefault` is informational; the snapshot-tested constant
// here is the authority — see doc 06 §"Default surface"). It deliberately does
// NOT import the concrete tool packages: doing so would create a `mcp -> tools`
// layering violation (ESLint-enforced) and a circular dependency. The registry
// (`registry.ts`) operates over an INJECTED `PackageSpec[]` that I1 aggregates;
// this file only owns the NAME-level policy: which package names the default
// profile expands to, the named-profile aliases, and name resolution/validation
// (CC-CFG-3: unknown/misspelled names, profile↔package namespace collision).
//
// No runtime Zod here (Arch nit — Zod is quarantined to `define.ts`).

import { PACKAGE_NAMES, type PackageName } from '../core/index.js';

/**
 * The default `FB_TOOL_PACKAGES` expansion (C5): the `core` profile. `ads` is
 * excluded by default and must be enabled explicitly. This ordered constant is
 * the single source of truth for the out-of-box surface and is snapshot-tested
 * in `packages.test.ts` so the surface can never drift silently.
 */
export const DEFAULT_PROFILE_PACKAGES = [
  'core',
  'posts',
  'reader',
  'insights',
  'moderation',
  'messages',
] as const satisfies readonly PackageName[];

/** Set form of {@link DEFAULT_PROFILE_PACKAGES} for membership tests. */
export const DEFAULT_PROFILE: ReadonlySet<PackageName> = new Set(
  DEFAULT_PROFILE_PACKAGES,
);

/**
 * Named profiles: reserved selection tokens that expand to a set of package
 * names. Profiles and packages share ONE namespace (CC-CFG-3); a reserved
 * profile name WINS over a same-spelled package name, which is why `core` here
 * expands to the six-package default rather than the single `core` package.
 *
 *  - `core` — the default profile (six packages; `ads` excluded).
 *  - `all`  — every package including `ads`.
 *  - `reader`/`publisher`/`moderator`/`ads` — single-package persona aliases
 *    (doc 06 package headers). `core` is always forced on by the registry, so a
 *    `reader`-only install is still a read-only posture (all `core` tools read).
 */
export const PROFILES = {
  core: DEFAULT_PROFILE_PACKAGES,
  all: PACKAGE_NAMES,
  reader: ['reader'],
  publisher: ['posts'],
  moderator: ['moderation'],
  ads: ['ads'],
} as const satisfies Record<string, readonly PackageName[]>;

/** The reserved profile names (keys of {@link PROFILES}). */
export type ProfileName = keyof typeof PROFILES;

const PROFILE_LOOKUP: ReadonlyMap<string, readonly PackageName[]> = new Map(
  Object.entries(PROFILES),
);
const PACKAGE_NAME_SET: ReadonlySet<string> = new Set(PACKAGE_NAMES);

/**
 * Every valid selection token (profiles ∪ packages), sorted — surfaced verbatim
 * in {@link PackageSelectionError} so an operator sees the full valid set
 * (CC-CFG-3: "startup error lists valid names").
 */
export function knownSelectionNames(): readonly string[] {
  return [...new Set<string>([...PROFILE_LOOKUP.keys(), ...PACKAGE_NAMES])].sort();
}

/** Thrown when a selection token is neither a known profile nor package (CC-CFG-3). */
export class PackageSelectionError extends Error {
  /** The offending tokens, verbatim as supplied. */
  readonly unknownNames: readonly string[];
  /** The full set of valid selection tokens. */
  readonly validNames: readonly string[];

  constructor(unknownNames: readonly string[], validNames: readonly string[]) {
    super(
      `Unknown tool package/profile name(s): ${unknownNames
        .map((n) => JSON.stringify(n))
        .join(', ')}. Valid names: ${validNames.join(', ')}.`,
    );
    this.name = 'PackageSelectionError';
    this.unknownNames = unknownNames;
    this.validNames = validNames;
    Object.setPrototypeOf(this, PackageSelectionError.prototype);
  }
}

/**
 * Expand a list of selection tokens (from `FB_TOOL_PACKAGES` / `FB_PACKAGES_DENY`
 * / `FB_PACKAGES_READONLY`) into a de-duplicated list of package names. Tokens
 * are matched case-insensitively; profiles are resolved BEFORE packages so a
 * reserved profile name wins the shared namespace (CC-CFG-3). Blank tokens are
 * ignored. Any token that is neither a profile nor a package collects into a
 * single {@link PackageSelectionError} (all unknowns reported at once).
 *
 * The returned list preserves first-seen order; call {@link sortByCanonical} for
 * a deterministic, snapshot-friendly ordering.
 */
export function expandSelection(tokens: readonly string[]): PackageName[] {
  const out = new Set<PackageName>();
  const unknown: string[] = [];

  for (const raw of tokens) {
    const token = raw.trim().toLowerCase();
    if (token.length === 0) {
      continue;
    }
    const profile = PROFILE_LOOKUP.get(token);
    if (profile !== undefined) {
      for (const name of profile) {
        out.add(name);
      }
    } else if (PACKAGE_NAME_SET.has(token)) {
      out.add(token as PackageName);
    } else {
      unknown.push(raw);
    }
  }

  if (unknown.length > 0) {
    throw new PackageSelectionError(unknown, knownSelectionNames());
  }
  return [...out];
}

/** Order package names by their canonical {@link PACKAGE_NAMES} position. */
export function sortByCanonical(names: Iterable<PackageName>): PackageName[] {
  return [...names].sort((a, b) => PACKAGE_NAMES.indexOf(a) - PACKAGE_NAMES.indexOf(b));
}
