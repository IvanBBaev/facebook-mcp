// Version surfaces: the server version and package name read from the root
// `package.json` at runtime, the defensive MCP SDK version resolver, and the
// one line `--version` prints.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/** Fallback version used when `package.json` cannot be read at runtime. */
const FALLBACK_VERSION = '0.0.0';

/** The runtime dependency whose version rides along in the version surfaces. */
const SDK_PACKAGE = '@modelcontextprotocol/sdk';

/** Last-resort SDK version when neither the install nor our manifest answers. */
const UNKNOWN_SDK_VERSION = 'unknown';

/**
 * Resolve the server version from `package.json` at RUNTIME (read as a file, not
 * imported as a module — the file sits outside `rootDir`). From `build/server/version.js`,
 * `../../package.json` resolves to the repository-root manifest. Any failure falls
 * back to {@link FALLBACK_VERSION} so a packaging quirk never crashes startup.
 */
export function resolveServerVersion(): string {
  return readManifestField('version') ?? FALLBACK_VERSION;
}

/**
 * The npm package name, read like the version so the `--help` text never names
 * a package the manifest does not (the scope has changed once already).
 * `undefined` when the manifest cannot be read.
 */
export function resolvePackageName(): string | undefined {
  return readManifestField('name');
}

/** One string field of the root `package.json`, or `undefined` on any failure. */
function readManifestField(field: string): string | undefined {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') {
      const value = (parsed as Record<string, unknown>)[field];
      if (typeof value === 'string') return value;
    }
  } catch {
    // fall through to the caller's fallback
  }
  return undefined;
}

/**
 * The filesystem seams {@link resolveSdkVersion} needs, injected so a test can
 * drive every fallback branch without a doctored `node_modules` tree (C14).
 */
export interface SdkVersionSources {
  /** Node module resolution. Throws when a package does not export the path. */
  readonly resolve: (specifier: string) => string;
  /** UTF-8 file read. Throws when the path is absent or unreadable. */
  readonly readText: (path: string | URL) => string;
}

/** The production seams: real Node resolution, real filesystem. */
function defaultSdkVersionSources(): SdkVersionSources {
  const requireFrom = createRequire(import.meta.url);
  return {
    resolve: (specifier) => requireFrom.resolve(specifier),
    readText: (path) => readFileSync(path, 'utf8'),
  };
}

/** `parsed[field]` when it is a non-empty string, else `undefined`. */
function stringField(parsed: unknown, field: string): string | undefined {
  if (parsed !== null && typeof parsed === 'object') {
    const value = (parsed as Record<string, unknown>)[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Every path that could hold the installed SDK manifest, most authoritative
 * first: whatever Node resolves, then `node_modules/<pkg>/package.json` beside
 * the build output root (`build/`, one level above this module) and in each
 * ancestor directory (npm hoists to the project root,
 * pnpm nests, a bundled install may sit next to the build output).
 */
function sdkManifestCandidates(
  resolve: SdkVersionSources['resolve'],
): readonly (string | URL)[] {
  const candidates: (string | URL)[] = [];
  try {
    candidates.push(resolve(`${SDK_PACKAGE}/package.json`));
  } catch {
    // The package does not export `./package.json` — the walk below covers it.
  }
  let dir = new URL('..', import.meta.url);
  for (;;) {
    candidates.push(new URL(`node_modules/${SDK_PACKAGE}/package.json`, dir));
    const parent = new URL('..', dir);
    if (parent.href === dir.href) break; // filesystem root reached
    dir = parent;
  }
  return candidates;
}

/**
 * Resolve the MCP SDK version at RUNTIME, defensively, never throwing.
 *
 * The chain exists because the surfaces that carry this value — `--version` and
 * `facebook_whoami` — are exactly the ones a BROKEN install is asked for. A
 * resolver that threw, or that answered only from a healthy `node_modules`,
 * would go silent precisely when a bug report needs it; so every step degrades
 * into the next and the last one always answers:
 *
 *   1. The installed package's own `package.json`. Node's resolver is asked
 *      first, but `@modelcontextprotocol/sdk` maps `./*` onto `./dist/esm/*`
 *      (import) and `./dist/cjs/*` (require), so
 *      `require.resolve('@modelcontextprotocol/sdk/package.json')` SUCCEEDS and
 *      hands back the one-line `{"type":"commonjs"}` stub inside `dist/cjs/` —
 *      a manifest with no `version` field at all. A resolved path is therefore
 *      only believed when it actually carries a version, and the walk up
 *      through `node_modules/` (which is what answers on a normal install)
 *      follows regardless.
 *   2. The version RANGE this repo declares for the SDK (e.g. `^1.29.0`). Not
 *      the installed version, but enough to triage a report from a tree whose
 *      dependencies never installed.
 *   3. {@link UNKNOWN_SDK_VERSION} — an honest literal beats an empty field.
 */
export function resolveSdkVersion(
  sources: SdkVersionSources = defaultSdkVersionSources(),
): string {
  for (const candidate of sdkManifestCandidates(sources.resolve)) {
    try {
      const parsed: unknown = JSON.parse(sources.readText(candidate));
      const version = stringField(parsed, 'version');
      if (version !== undefined) return version;
    } catch {
      // Absent, unreadable or not JSON — try the next candidate.
    }
  }
  try {
    // Same read as `resolveServerVersion`: a file next to the build output,
    // never an imported module (`package.json` sits outside `rootDir`).
    const parsed: unknown = JSON.parse(
      sources.readText(new URL('../../package.json', import.meta.url)),
    );
    if (parsed !== null && typeof parsed === 'object') {
      const range = stringField(
        (parsed as Record<string, unknown>)['dependencies'],
        SDK_PACKAGE,
      );
      if (range !== undefined) return range;
    }
  } catch {
    // fall through to the honest literal
  }
  return UNKNOWN_SDK_VERSION;
}

/**
 * The single line `--version` prints.
 *
 * It carries the runtime and the MCP SDK alongside the server version because
 * the bug report template asks for all three: a mismatched Node and a stale SDK
 * are the two causes that make a report unreproducible on the maintainer's box,
 * and neither is visible from the server version alone. Format stays
 * `name version (details)`, so `awk '{print $2}'` still yields a bare version
 * for a script — every addition goes inside the parenthetical.
 */
export function versionLine(
  serverVersion: string,
  sdkVersion: string,
  runtime: { readonly node: string; readonly platform: string; readonly arch: string } = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
): string {
  return `facebook-mcp ${serverVersion} (node ${runtime.node}, ${runtime.platform} ${runtime.arch}, sdk ${sdkVersion})`;
}
