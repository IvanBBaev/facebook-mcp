// Command-line argument handling for the entry point: the version / help /
// strict flags, the `--help` text, the doctor's ignored-argument note and the
// per-command log level.

import type { LogLevel } from '../core/index.js';
import {
  BIN_NAME,
  DEFAULT_LAUNCH_COMMAND,
  SOURCE_ENTRY,
  subcommandHint,
} from '../mcp/launch-command.js';

/** Is `arg` the version flag? `-v` is an alias; there is no verbose flag to clash with. */
export function isVersionFlag(arg: string | undefined): boolean {
  return arg === '--version' || arg === '-v';
}

/** Is `arg` the help flag? `-h` is an alias. */
export function isHelpFlag(arg: string | undefined): boolean {
  return arg === '--help' || arg === '-h';
}

/**
 * Does this argument vector ask for help — `--help` / `-h` on its own, or
 * after the `doctor` / `setup-token` subcommand?
 *
 * The subcommand form is what a first-time operator types to learn the flags,
 * and it used to be read as an unknown option: `setup-token --help` ran the
 * whole flow and ended in a FAIL report, `doctor --help` called Graph. Neither
 * subcommand takes a value that could legitimately be spelled `-h`.
 */
export function wantsHelp(args: readonly string[]): boolean {
  if (isHelpFlag(args[0])) return true;
  if (args[0] !== 'doctor' && args[0] !== 'setup-token') return false;
  return args.slice(1).some((arg) => isHelpFlag(arg));
}

/**
 * What `--help` prints. Answered before settings are loaded, like `--version`:
 * without it, `--help` fell through to the server start, which either hung
 * silently on stdin (a token configured) or failed on the missing token — the
 * operator asking how to use the binary was told neither.
 *
 * Every command is rendered with `launchCommand`, the form that started this
 * process (see `resolveLaunchCommand`): the usage line used to say
 * `facebook-mcp`, which is only on PATH after a global install.
 */
export function usageText(
  packageName: string | undefined,
  launchCommand: string = DEFAULT_LAUNCH_COMMAND,
): string {
  const npx =
    packageName !== undefined ? `npx -y ${packageName}` : 'npx -y <npm package>';
  return [...usageLines(launchCommand), ...firstRunLines(launchCommand, npx)].join('\n');
}

/**
 * The first-run hint, in the launch form that started this process, followed by
 * the other launch forms — the same help is read by an operator deciding how
 * to wire the server into a client, who may not launch it this way next time.
 */
function firstRunLines(launch: string, npx: string): string[] {
  const others = [
    { label: 'after a global install:', form: BIN_NAME },
    { label: 'through npx:', form: npx },
    { label: 'from a source checkout:', form: SOURCE_ENTRY },
  ].filter(({ form }) => form !== launch);
  return [
    'First run (FB_APP_ID / FB_APP_SECRET from your Meta app, Settings > Basic):',
    '  FB_APP_ID=<id> FB_APP_SECRET=<secret> \\',
    `  FB_SETUP_TOKEN=<Graph API Explorer user token> ${subcommandHint(launch, 'setup-token')}`,
    `  ${subcommandHint(launch, 'doctor')}`,
    `Launched another way, replace ${launch} with`,
    ...others.map(({ label, form }) => `  ${label.padEnd(24)} ${form}`),
    '',
  ];
}

function usageLines(launch: string): string[] {
  return [
    `Usage: ${launch} [command]`,
    '',
    'With no command, starts the MCP server (stdio by default; FB_TRANSPORT=http',
    'selects the HTTP transport) and waits for a client. Any argument not listed',
    'below also starts the server.',
    '',
    'Commands:',
    '  doctor [--strict]      Pre-flight report on stderr: token, scopes, package',
    '                         matrix. Exits 0 unless --strict is passed and the',
    '                         verdict is not ok.',
    '  setup-token [options]  Exchange a short-lived user token for a long-lived',
    '                         credential. Read the token from FB_SETUP_TOKEN rather',
    '                         than passing it as an argument. Options: --page=<id>,',
    '                         --env-file=<path>, --force, --no-write.',
    '  --version, -v          Print the server, Node and MCP SDK versions.',
    '  --help, -h             Print this help (also after doctor / setup-token).',
    '',
  ];
}

/**
 * The arguments `doctor` did not understand, described without their values,
 * or `undefined` when there are none.
 *
 * A near-miss such as `--stric` deliberately does not gate (see
 * {@link isStrictFlag}), but ignoring it silently let a pipeline that meant to
 * gate read exit 0 as a pass with nothing on screen to say otherwise. Only the
 * option NAME is echoed: `--token=EAAB…` or a pasted bare token is exactly what
 * lands here, and the doctor report never carries a credential.
 */
export function ignoredDoctorArgsNote(args: readonly string[]): string | undefined {
  const described = new Set<string>();
  for (const arg of args) {
    if (arg === '--strict') continue;
    if (arg.startsWith('-')) {
      const eq = arg.indexOf('=');
      described.add(JSON.stringify(eq === -1 ? arg : `${arg.slice(0, eq)}=\u2026`));
    } else {
      described.add('a positional argument');
    }
  }
  if (described.size === 0) return undefined;
  return `Ignored unknown doctor argument ${[...described].join(', ')}. The doctor accepts only --strict.`;
}

/** The interactive subcommands that print a human-readable report and exit. */
const CLI_REPORT_COMMANDS: ReadonlySet<string> = new Set(['doctor', 'setup-token']);

/** Warn is the quietest level a CLI report is preceded by (see {@link cliLogLevel}). */
const CLI_REPORT_FLOOR: LogLevel = 'warn';

const LOG_LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * The log level for this invocation.
 *
 * `doctor` and `setup-token` print a report for a human on stderr, and the
 * collaborators they share with the server (the Pages registry, the transport)
 * log their routine `info` lines there too — so the first thing a newcomer saw
 * was a JSON "Resolved active Facebook credential…" line above the report it
 * was meant to introduce. On those two commands the floor is `warn`: warnings
 * and errors still print, routine info does not. An explicit
 * `FB_LOG_LEVEL=debug` is a request for everything and is honored as asked.
 * Server mode (any other argv) keeps the configured level untouched — its
 * stderr JSON stream is a contract with log consumers.
 */
export function cliLogLevel(command: string | undefined, configured: LogLevel): LogLevel {
  if (command === undefined || !CLI_REPORT_COMMANDS.has(command)) return configured;
  if (configured === 'debug') return configured;
  return LOG_LEVEL_RANK[configured] >= LOG_LEVEL_RANK[CLI_REPORT_FLOOR]
    ? configured
    : CLI_REPORT_FLOOR;
}

/**
 * Did the operator ask `doctor` to gate on its own verdict?
 *
 * Long form only: a one-letter alias for a flag that changes an exit code is
 * the kind of thing a CI script acquires by accident.
 */
export function isStrictFlag(args: readonly string[]): boolean {
  return args.includes('--strict');
}
