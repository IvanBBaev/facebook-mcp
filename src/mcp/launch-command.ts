// How the operator launched this process, rendered as the command prefix every
// user-facing hint should name.
//
// The binary is called `facebook-mcp`, but that name is only on PATH after a
// global install. An operator who started with `npx -y @ivanbaev/facebook-mcp`
// (the README's recommended form) or with `node build/index.js` from a source
// checkout was told to run `facebook-mcp doctor` — a command their shell does
// not know. The hints therefore name the form that actually started them.
//
// PURE: the environment, argv and package name are injected, so every branch
// is a unit test rather than a spawned process.

/** The name the package installs on PATH (`package.json` `bin`). */
export const BIN_NAME = 'facebook-mcp';

/** The source-checkout entry point, relative to the repository root. */
export const SOURCE_ENTRY = 'node build/index.js';

/** The launcher shim run directly from a source checkout. */
export const SOURCE_BIN_ENTRY = 'node bin/facebook-mcp.mjs';

/**
 * The launch form used when nothing better is known. The binary name, because
 * that is what every existing hint said and what a global install provides.
 */
export const DEFAULT_LAUNCH_COMMAND = BIN_NAME;

/** What {@link resolveLaunchCommand} reads — all injected, never ambient. */
export interface LaunchContext {
  /** The process environment (`process.env`). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The full process argv (`process.argv`): `[node, script, ...args]`. */
  readonly argv: readonly string[];
  /** The npm package name from `package.json`, when it could be read. */
  readonly packageName?: string | undefined;
}

/** Forward slashes, so one set of path checks covers Windows too. */
function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

/**
 * Was this process started by `npx` / `npm exec`?
 *
 * npm 7+ sets `npm_command=exec` and `npm_lifecycle_event=npx` for the child of
 * `npx` / `npm exec`, and installs the package under its `_npx` cache. Any one
 * is enough: an MCP client may scrub part of the environment, and the cache
 * path survives that.
 */
function launchedByNpx(env: LaunchContext['env'], script: string): boolean {
  return (
    env['npm_command'] === 'exec' ||
    env['npm_lifecycle_event'] === 'npx' ||
    script.includes('/_npx/')
  );
}

/**
 * The command prefix a hint should name for this process: one of
 * `npx -y <package>`, `facebook-mcp`, `node build/index.js` or
 * `node bin/facebook-mcp.mjs`.
 *
 * Order matters: the npx signals win over the script path (npx runs the same
 * bin shim a global install does), and a `build/index.js` inside
 * `node_modules` is an installed copy, not a source checkout. A global bin is
 * a symlink named `facebook-mcp` (POSIX) or the shim inside `node_modules`
 * (Windows). When nothing
 * matches, the npx form is the safe fallback — it works from any shell with
 * Node, whether or not the package is installed — and the bare binary name is
 * used only when the package name itself is unknown.
 */
export function resolveLaunchCommand(context: LaunchContext): string {
  const script = normalizePath(context.argv[1] ?? '');
  const npx =
    context.packageName !== undefined && context.packageName.trim() !== ''
      ? `npx -y ${context.packageName.trim()}`
      : undefined;
  const installed = script.includes('/node_modules/');

  if (launchedByNpx(context.env, script)) return npx ?? DEFAULT_LAUNCH_COMMAND;
  if (!installed && /(^|\/)build\/index\.js$/.test(script)) return SOURCE_ENTRY;
  if (!installed && /(^|\/)bin\/facebook-mcp\.mjs$/.test(script)) return SOURCE_BIN_ENTRY;
  const base = script.slice(script.lastIndexOf('/') + 1);
  if (installed || base === BIN_NAME || base === `${BIN_NAME}.mjs`) {
    return DEFAULT_LAUNCH_COMMAND;
  }
  return npx ?? DEFAULT_LAUNCH_COMMAND;
}

/** `<launch> <subcommand>`, e.g. `npx -y @ivanbaev/facebook-mcp doctor`. */
export function subcommandHint(launch: string, subcommand: string): string {
  return `${launch} ${subcommand}`;
}
