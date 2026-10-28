// Argument reader of the `setup-token` subcommand: `parseSetupTokenArgs` turns
// argv + env into a `SetupTokenInput`. Pure — no process access.

import { DEFAULT_LAUNCH_COMMAND, subcommandHint } from '../../mcp/launch-command.js';
import { SETUP_TOKEN_ENV_VAR } from './constants.js';
import type { SetupTokenInput, SetupTokenSource } from './types.js';

export function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const out = value.trim();
  return out.length > 0 ? out : undefined;
}

/**
 * Parse the arguments FOLLOWING the subcommand (`process.argv.slice(3)`) plus the
 * environment. Pure: it reads neither `process.argv` nor `process.env` itself.
 *
 * Token precedence: an explicit positional argument wins over
 * `FB_SETUP_TOKEN`, but doing so is flagged — a token on the command line is
 * visible to every process on the machine (`ps`) and lands in shell history.
 */
export function parseSetupTokenArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = {},
  launchCommand: string = DEFAULT_LAUNCH_COMMAND,
): SetupTokenInput {
  const notes: string[] = [];
  const envToken = trimmed(env[SETUP_TOKEN_ENV_VAR]);

  let argToken: string | undefined;
  let pageId: string | undefined;
  let envFile: string | undefined;
  let write = true;
  let force = false;

  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index] ?? '';
    if (raw === '--force') {
      force = true;
    } else if (raw === '--no-write' || raw === '--dry-run') {
      write = false;
    } else if (raw.startsWith('--page=')) {
      pageId = trimmed(raw.slice('--page='.length));
    } else if (raw.startsWith('--env-file=')) {
      envFile = trimmed(raw.slice('--env-file='.length));
    } else if (raw === '--page' || raw === '--env-file') {
      // The space-separated form. Left to the positional branch below, the
      // VALUE became the token: FB_SETUP_TOKEN was dropped and a Page ID or a
      // path was sent to Graph as the credential.
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('-')) {
        index++;
        if (raw === '--page') pageId = trimmed(next);
        else envFile = trimmed(next);
      } else {
        notes.push(`Ignored ${raw}: it needs a value (${raw}=<value>).`);
      }
    } else if (raw.startsWith('-')) {
      // Echo the option NAME only, never its value. `--token=EAAB…` is exactly
      // what an operator reaches for when the positional form is not obvious, and
      // it lands here — quoting the raw argument would print the token into the
      // rendered report, which by this file's contract never carries one.
      const eq = raw.indexOf('=');
      const name = eq === -1 ? raw : raw.slice(0, eq);
      notes.push(
        `Ignored unknown option ${JSON.stringify(name)}. Supported: --page=<id>, ` +
          `--env-file=<path>, --force, --no-write.`,
      );
    } else {
      argToken = trimmed(raw);
    }
  }

  if (argToken !== undefined) {
    notes.push(
      'The token was passed as a command-line argument, so it is visible in the ' +
        `process list and your shell history. Prefer ${SETUP_TOKEN_ENV_VAR}=… ` +
        `${subcommandHint(launchCommand, 'setup-token')}, and clear the history entry.`,
    );
    if (envToken !== undefined) {
      notes.push(
        `Both ${SETUP_TOKEN_ENV_VAR} and a command-line token were supplied; the ` +
          'command-line token was used.',
      );
    }
  }

  const token = argToken ?? envToken;
  const tokenSource: SetupTokenSource =
    argToken !== undefined ? 'argument' : envToken !== undefined ? 'env' : 'none';

  return {
    ...(token !== undefined ? { token } : {}),
    tokenSource,
    ...(pageId !== undefined ? { pageId } : {}),
    write,
    force,
    ...(envFile !== undefined ? { envFilePath: envFile } : {}),
    notes,
  };
}
