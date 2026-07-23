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

import type { PackageName, PackageSpec, Settings, ToolSpec } from '../core/index.js';
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
      tools.push(stamped);
    }
  }

  return {
    tools,
    packageNames,
    get: (name) => byToolName.get(name),
    has: (name) => byToolName.has(name),
  };
}
