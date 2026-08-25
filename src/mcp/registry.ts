// Tool registry: resolve the active tool set from settings (task F11, C5).
//
// `createRegistry` takes the INJECTED `PackageSpec[]` (I1 aggregates the real
// tool packages) plus resolved {@link Settings} and produces the final, ordered
// `ToolSpec[]` the MCP server registers, with each spec's `package` field
// stamped from its owning package. Selection policy:
//
//   1. `settings.toolPackages === undefined` ⇒ the default profile expansion
//      (`packages.ts` DEFAULT_PROFILE); otherwise the explicit list is expanded
//      (profiles + packages, one namespace) — unknown names throw (CC-CFG-3).
//   2. `FB_PACKAGES_DENY` removes whole packages; `core` is always-on and is
//      re-added AFTER deny, so it can never be dropped.
//   3. `FB_PACKAGES_READONLY` drops every write-tier tool from the named
//      packages (read-only posture for unattended untrusted-content ingestion —
//      doc 05 §6). Deny wins over readonly (a denied package contributes nothing).
//
// No runtime Zod here — the registry only ever sees `ToolSpec.inputSchema` as an
// opaque `ZodTypeAny` (Arch nit: Zod is quarantined to `define.ts`).

import type {
  PackageName,
  PackageSpec,
  Settings,
  ToolSpec,
  WriteMode,
} from '../core/index.js';
import {
  DEFAULT_PROFILE_PACKAGES,
  expandSelection,
  sortByCanonical,
} from './packages.js';

/** The `core` package is always enabled (doc 06 "Package `core` (always on)"). */
const ALWAYS_ON: PackageName = 'core';

/** Thrown for a wiring fault: a selected package is missing, or a name collides. */
export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
    Object.setPrototypeOf(this, RegistryError.prototype);
  }
}

/** The resolved tool set plus by-name lookup. */
export interface ToolRegistry {
  /** Final, ordered specs (canonical package order; each `package` stamped). */
  readonly tools: readonly ToolSpec[];
  /** Resolved package names, canonical order (informational / doctor). */
  readonly packageNames: readonly PackageName[];
  /** Look a tool up by its `name`; `undefined` if not in the resolved set. */
  get(name: string): ToolSpec | undefined;
  /** Whether a tool with `name` is in the resolved set. */
  has(name: string): boolean;
  /**
   * The write mode that governs `name` — see {@link effectiveWriteMode} for how
   * `PackageSpec.writeModeDefault` and `settings.writeMode` combine. An unknown
   * tool falls back to `settings.writeMode`; that arm is unreachable through the
   * bootstrap, which resolves the spec first and errors on a name it does not
   * have. The bootstrap builds one {@link WriteGate} per distinct result.
   */
  writeModeFor(name: string): WriteMode;
}

/**
 * Fold a package's declared default into the operator's `FB_WRITE_MODE`.
 *
 * Two claims have to hold at once, and which one applies turns on whether the
 * operator actually SET the variable:
 *
 * - `FB_WRITE_MODE` is a global kill switch. An operator who typed it has spoken
 *   about every package, so it wins outright — `FB_WRITE_MODE=plan` forces plan
 *   even on `moderation`, which ships `'apply'`.
 * - A package default is what governs an operator who said nothing. That is the
 *   whole point of `moderation`'s `writeModeDefault: 'apply'` (A6 / UX #6):
 *   hiding a comment is reversible, high-volume work that must not stack a plan
 *   preview on every call. Folding it into the compiled-in default with a
 *   most-restrictive rule would make the declaration permanently inert, since a
 *   package default of `'apply'` can only ever loosen.
 *
 * Loosening is bounded by design: the `irreversible` and `spend` tiers ignore the
 * write mode entirely (C4) and still demand an explicit `apply` plus a `plan_id`
 * plus out-of-band confirmation. What a package default can reach is exactly the
 * `reversible` tier.
 */
export function effectiveWriteMode(
  globalMode: WriteMode,
  packageDefault: WriteMode | undefined,
  globalExplicit = false,
): WriteMode {
  if (globalExplicit) return globalMode;
  return packageDefault ?? globalMode;
}

/**
 * Resolve the active tool set from the injected packages and settings.
 *
 * @param packages The available packages (injected by I1; never the real tool
 *   modules imported here — that would violate the `mcp -> tools` layer rule).
 * @param settings Resolved {@link Settings}; reads `toolPackages`, `packagesDeny`,
 *   `packagesReadonly`.
 * @throws PackageSelectionError if any selection/deny/readonly token is unknown.
 * @throws RegistryError on duplicate package names, a selected-but-unregistered
 *   package, or a duplicate tool name across the resolved packages.
 */
export function createRegistry(
  packages: readonly PackageSpec[],
  settings: Settings,
): ToolRegistry {
  // Index the injected packages; a duplicate name is a wiring fault.
  const specByName = new Map<string, PackageSpec>();
  for (const pkg of packages) {
    if (specByName.has(pkg.name)) {
      throw new RegistryError(
        `duplicate package name '${pkg.name}' in injected packages.`,
      );
    }
    specByName.set(pkg.name, pkg);
  }

  // 1. Base selection: default profile, or the explicit list (unknown ⇒ throws).
  const selectedRaw =
    settings.toolPackages === undefined
      ? [...DEFAULT_PROFILE_PACKAGES]
      : expandSelection(settings.toolPackages);

  // 2. Deny (unknown deny names also throw), then force `core` back on.
  const denied = new Set<PackageName>(expandSelection(settings.packagesDeny));
  const selected = new Set<PackageName>();
  for (const name of selectedRaw) {
    if (!denied.has(name)) {
      selected.add(name);
    }
  }
  selected.add(ALWAYS_ON); // always-on: survives deny.

  // 3. Read-only packages: their write-tier tools are dropped.
  const readOnly = new Set<PackageName>(expandSelection(settings.packagesReadonly));

  const tools: ToolSpec[] = [];
  const byToolName = new Map<string, ToolSpec>();
  const writeModeByToolName = new Map<string, WriteMode>();
  const packageNames: PackageName[] = [];

  for (const name of sortByCanonical(selected)) {
    const pkg = specByName.get(name);
    if (pkg === undefined) {
      throw new RegistryError(
        `package '${name}' is selected but not registered; injected packages: ` +
          `${[...specByName.keys()].join(', ') || '(none)'}.`,
      );
    }
    packageNames.push(name);
    const dropWrites = readOnly.has(name);
    // Constant per package, so it is resolved once rather than per tool.
    const packageWriteMode = effectiveWriteMode(
      settings.writeMode,
      pkg.writeModeDefault,
      settings.writeModeExplicit === true,
    );
    for (const tool of pkg.tools) {
      // writeTier absent ⇒ read-only tool (ToolSpec contract): keep it.
      if (dropWrites && tool.writeTier !== undefined) {
        continue;
      }
      if (byToolName.has(tool.name)) {
        throw new RegistryError(
          `duplicate tool name '${tool.name}' (package '${pkg.name}').`,
        );
      }
      const stamped: ToolSpec = { ...tool, package: pkg.name };
      byToolName.set(stamped.name, stamped);
      writeModeByToolName.set(stamped.name, packageWriteMode);
      tools.push(stamped);
    }
  }

  return {
    tools,
    packageNames,
    get: (name) => byToolName.get(name),
    has: (name) => byToolName.has(name),
    writeModeFor: (name) => writeModeByToolName.get(name) ?? settings.writeMode,
  };
}
