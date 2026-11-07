// Package contract (X08 split of `core/types.ts`). Integration-owned (doc 05
// §1 rule 3): `PACKAGE_NAMES` and `PackageSpec` change only in an I-task.

import type { ToolSpec } from './tool.js';
import type { WriteMode } from './write.js';

/** A package groups tools and carries selection + write-mode defaults (C5). */
export interface PackageSpec {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly tools: readonly ToolSpec[];
  /** Whether the package is part of the default profile expansion (F11 authoritative). */
  readonly enabledByDefault: boolean;
  /** Per-package write-mode default to avoid confirmation stacking (C4). */
  readonly writeModeDefault?: WriteMode;
}

/**
 * The eight canonical package names. This is a convenience contract constant;
 * F11 (`mcp/packages.ts`) owns the authoritative PACKAGES manifest and the
 * snapshot-tested DEFAULT PROFILE EXPANSION. The default expansion set is
 * intentionally NOT defined here (single source of truth stays with F11's
 * snapshot test): default `FB_TOOL_PACKAGES` ⇒
 * core + posts + reader + insights + moderation + messages (ads excluded).
 */
export const PACKAGE_NAMES = [
  'core',
  'reader',
  'posts',
  'insights',
  'moderation',
  'messages',
  'ads',
  'page_admin',
] as const;

export type PackageName = (typeof PACKAGE_NAMES)[number];
