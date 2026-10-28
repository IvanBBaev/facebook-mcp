// Env-file persistence of the `setup-token` flow: the overwrite probe, the
// existing-file reader, dropped-key reporting, dotenv-safe line encoding,
// `renderEnvFile`, and the default atomic 0600 writer.

import dotenv from 'dotenv';

import { atomicWriteFile } from '../../core/index.js';
import type { EnvFileWriter } from './types.js';

/** What already sits at the env-file path, as far as the overwrite guard cares. */
export type EnvTargetKind = 'absent' | 'present' | 'symlink';

/**
 * Default existence probe (kept off the hot path so tests can replace it).
 *
 * `lstat`, not `stat`: the write is a `rename` onto the path, which replaces a
 * symbolic link ITSELF rather than the file it points to. `stat` follows the
 * link, so a dangling one (`.env -> <a volume not mounted yet>`) read as
 * "absent" and was replaced without --force, and a live one was replaced under
 * --force while the file the operator actually manages kept the old token.
 */
export async function probeEnvTarget(filePath: string): Promise<EnvTargetKind> {
  const { lstat } = await import('node:fs/promises');
  try {
    return (await lstat(filePath)).isSymbolicLink() ? 'symlink' : 'present';
  } catch {
    return 'absent';
  }
}

/** Default reader for the existing env file: its text, or `undefined`. */
export async function readExistingEnvFile(filePath: string): Promise<string | undefined> {
  const { readFile } = await import('node:fs/promises');
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Key names the existing env file holds that `written` does not, in file order.
 * Parsed with dotenv — the same parser the loader uses — so a key is named
 * exactly when the server would have read it. Only NAMES leave this function.
 */
export function keysDroppedFrom(
  contents: string | undefined,
  written: readonly string[],
): readonly string[] {
  if (contents === undefined) return [];
  let existing: readonly string[];
  try {
    existing = Object.keys(dotenv.parse(contents));
  } catch {
    return [];
  }
  const kept = new Set(written);
  return existing.filter((key) => !kept.has(key));
}

/** The sentence naming dropped keys, or `''` when none are lost. */
export function describeDroppedKeys(dropped: readonly string[]): string {
  if (dropped.length === 0) return '';
  return (
    ` Replacing it drops ${dropped.join(', ')} (keys it holds that this run does ` +
    'not write; values are not printed): set them again afterwards if you still need them.'
  );
}

/**
 * Encode one `KEY=value` line the way the loader will actually read it back.
 *
 * dotenv strips ONE layer of quotes, and inside DOUBLE quotes it turns the two
 * characters `\n` / `\r` into real control characters — but it never unescapes
 * `\\` or `\"`. Escaping those on the way out therefore corrupts the value on the
 * way in: a secret containing `a\b` used to be written `a\\b` and loaded as
 * `a\\b`. Single quotes are taken literally by dotenv, so they carry a value with
 * a backslash or a double quote unharmed — except a TRAILING backslash: dotenv
 * matches `'(?:\\'|[^'])*'`, so the closing `\'` reads as an escaped quote and
 * the value runs on through the following lines, whose contents are then parsed
 * as keys of their own. Such a value is written bare when a bare value reads
 * back unchanged. dotenv also folds every CR in the file to LF before parsing;
 * only double quotes bring it back, through the escape `\r`.
 *
 * Anything left has no env-file representation at all and is refused loudly
 * instead of being written wrong, because a silently mangled secret fails later
 * as an unexplainable Graph auth error.
 */
function encodeEnvLine(key: string, value: string): string {
  if (!/["\\]/.test(value)) return `${key}="${value.replace(/\r/g, '\\r')}"`;
  if (!value.endsWith('\\')) {
    if (!/['\r]/.test(value)) return `${key}='${value}'`;
  } else if (BARE_ENV_VALUE.test(value)) {
    return `${key}=${value}`;
  }
  throw new Error(
    `${key} cannot be written to an env file: no env-file quoting reads its value ` +
      'back unchanged (a single quote or a carriage return next to a double quote ' +
      'or a backslash, or a trailing backslash on a value that cannot stand ' +
      `unquoted). Set ${key} in your environment by hand instead — the value is ` +
      'not printed here.',
  );
}

/**
 * A value dotenv reads back verbatim WITHOUT quotes: it opens with no quote,
 * `#` or whitespace (dotenv trims a bare value) and carries no `#` (a comment)
 * and no line break. Only used for values ending in a backslash, so trailing
 * whitespace cannot occur.
 */
const BARE_ENV_VALUE = /^[^\s'"`#][^#\r\n]*$/;

/**
 * Render the env file. Values are quoted so a token containing `#`, `$` or
 * whitespace can never be mis-parsed or re-expanded; see {@link encodeEnvLine}
 * for which quote is picked and why nothing is escaped.
 */
export function renderEnvFile(
  entries: readonly (readonly [string, string])[],
  generatedAt: number,
): string {
  const lines = [
    `# facebook-mcp configuration — written by \`facebook-mcp setup-token\``,
    `# ${new Date(generatedAt).toISOString()}`,
    '#',
    '# CONTAINS SECRETS. Keep it owner-readable only (mode 0600 on POSIX).',
    '# Re-running setup-token REPLACES this file; it is never merged.',
    '',
  ];
  for (const [key, value] of entries) {
    lines.push(encodeEnvLine(key, value));
  }
  lines.push('');
  return lines.join('\n');
}

/** The production writer: `core`'s atomic 0600 helper, no permission logic here. */
export function defaultWriter(platform: NodeJS.Platform | undefined): EnvFileWriter {
  return (filePath, contents) =>
    atomicWriteFile(filePath, contents, {
      mode: 0o600,
      ...(platform !== undefined ? { platform } : {}),
    });
}
