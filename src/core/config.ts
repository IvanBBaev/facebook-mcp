// Config plumbing for facebook-mcp (task F04).
//
// The low-level, Settings-agnostic half of the config layer: platform-aware
// config/state path resolution (XDG on POSIX, %APPDATA% on Windows), env-file
// loading via dotenv (quiet — stdout must stay pure for the stdio transport,
// CC-CFG-1; env-first — client-passed env beats the file), atomic 0600 writes,
// and *honest* file-protection reporting (0600 is a POSIX concept; on Windows we
// say so rather than pretend — CC-CFG-4). No knowledge of the `FB_*` surface or
// the `Settings` shape lives here; that is `settings.ts`.

import path from 'node:path';
import { homedir } from 'node:os';
import { chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';

/** Directory name used under the platform config/state roots. */
export const APP_DIR_NAME = 'facebook-mcp';

/** Basename of the env file inside the config dir. */
export const ENV_FILE_NAME = '.env';

/** Basename of the write journal inside the state dir. */
export const JOURNAL_FILE_NAME = 'journal.ndjson';

/** Inputs that make path resolution injectable (and cross-platform testable). */
export interface PathOptions {
  /** Defaults to `process.platform`. Pass `'win32'` to exercise the Windows branch. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Defaults to `os.homedir()`. */
  readonly homeDir?: string;
}

/** True on Windows, where POSIX file modes (0600) do not apply. */
export function isWindows(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

function resolvePlatform(o?: PathOptions): NodeJS.Platform {
  return o?.platform ?? process.platform;
}

function resolveEnv(o?: PathOptions): NodeJS.ProcessEnv {
  return o?.env ?? process.env;
}

function resolveHome(o?: PathOptions): string {
  return o?.homeDir ?? homedir();
}

/** Use the platform-correct path grammar even when running on another OS (tests). */
function pathFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * The config directory holding the env file.
 * POSIX: `$XDG_CONFIG_HOME/facebook-mcp` or `~/.config/facebook-mcp`.
 * Windows: `%APPDATA%\facebook-mcp` (falls back to `~\AppData\Roaming`).
 */
export function configDir(o?: PathOptions): string {
  const platform = resolvePlatform(o);
  const env = resolveEnv(o);
  const home = resolveHome(o);
  const p = pathFor(platform);
  if (platform === 'win32') {
    const base = env.APPDATA ?? p.join(home, 'AppData', 'Roaming');
    return p.join(base, APP_DIR_NAME);
  }
  const base = env.XDG_CONFIG_HOME ?? p.join(home, '.config');
  return p.join(base, APP_DIR_NAME);
}

/**
 * The state directory holding the write journal.
 * POSIX: `$XDG_STATE_HOME/facebook-mcp` or `~/.local/state/facebook-mcp`.
 * Windows: `%LOCALAPPDATA%` (or `%APPDATA%`) `\facebook-mcp`.
 */
export function stateDir(o?: PathOptions): string {
  const platform = resolvePlatform(o);
  const env = resolveEnv(o);
  const home = resolveHome(o);
  const p = pathFor(platform);
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA ?? env.APPDATA ?? p.join(home, 'AppData', 'Local');
    return p.join(base, APP_DIR_NAME);
  }
  const base = env.XDG_STATE_HOME ?? p.join(home, '.local', 'state');
  return p.join(base, APP_DIR_NAME);
}

/** Absolute path of the env file dotenv loads by default. */
export function envFilePath(o?: PathOptions): string {
  return pathFor(resolvePlatform(o)).join(configDir(o), ENV_FILE_NAME);
}

/** Absolute default path of the write journal (F13 owns the journal itself). */
export function defaultJournalPath(o?: PathOptions): string {
  return pathFor(resolvePlatform(o)).join(stateDir(o), JOURNAL_FILE_NAME);
}

/** Options for {@link loadEnvFile}. */
export interface LoadEnvFileOptions {
  /** Env file to read; defaults to dotenv's own default (`.env` in CWD). */
  readonly path?: string;
  /**
   * Whether file values overwrite values already present in `process.env`.
   * Default `false` — env-first: client-passed env wins over the file (decision 1).
   */
  readonly override?: boolean;
}

/** Outcome of an env-file load. */
export interface LoadEnvFileResult {
  /** The path we attempted to read, if one was given. */
  readonly path?: string;
  /** True when the file parsed without error (a missing file is *not* an error here). */
  readonly loaded: boolean;
  /** Keys the file contributed (before env-first filtering). */
  readonly parsedKeys: readonly string[];
  /** Non-fatal read error (e.g. ENOENT for a missing optional file). */
  readonly error?: NodeJS.ErrnoException;
}

/**
 * Load an env file into `process.env`.
 *
 * MUST pass `quiet: true`: dotenv v17 prints a stdout banner otherwise, which
 * corrupts the stdio JSON-RPC channel (CC-CFG-1). `override: false` (the default)
 * gives env-first semantics — a value already in `process.env` (client-passed)
 * beats the file. A missing file is tolerated (the file is optional).
 */
export function loadEnvFile(options: LoadEnvFileOptions = {}): LoadEnvFileResult {
  const result = dotenv.config({
    quiet: true,
    override: options.override ?? false,
    ...(options.path !== undefined ? { path: options.path } : {}),
  });
  const error = result.error as NodeJS.ErrnoException | undefined;
  const parsed = result.parsed ?? {};
  return {
    ...(options.path !== undefined ? { path: options.path } : {}),
    loaded: error === undefined,
    parsedKeys: Object.keys(parsed),
    ...(error !== undefined ? { error } : {}),
  };
}

/** Options for {@link atomicWriteFile}. */
export interface AtomicWriteOptions {
  /** Defaults to `process.platform`; drives the 0600 / Windows-honesty branch. */
  readonly platform?: NodeJS.Platform;
  /** POSIX file mode for the written file; default `0o600` (owner read/write). */
  readonly mode?: number;
  /** POSIX mode for any directories created; default `0o700`. */
  readonly dirMode?: number;
}

/** Result of an {@link atomicWriteFile}, reporting *actual* (not claimed) protection. */
export interface AtomicWriteResult {
  readonly path: string;
  /** True iff owner-only permissions were actually enforced (POSIX only). */
  readonly restricted: boolean;
  /** The POSIX mode that was requested. */
  readonly mode: number;
  /** Honest note when the platform cannot enforce POSIX modes (Windows). */
  readonly note?: string;
}

/**
 * Write `data` to `filePath` atomically with mode 0600.
 *
 * Writes to a sibling temp file (owner-only), fsyncs, chmods to the exact bits
 * (writeFile's mode is masked by umask), then renames over the target so a reader
 * never sees a partial or world-readable file. On Windows the POSIX 0600 has no
 * effect; rather than silently pretend, we still write and return
 * `restricted: false` with a `note` explaining that protection depends on the
 * NTFS ACL of the parent directory (CC-CFG-4).
 */
export async function atomicWriteFile(
  filePath: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<AtomicWriteResult> {
  const platform = options.platform ?? process.platform;
  const posix = platform !== 'win32';
  const mode = options.mode ?? 0o600;
  const dir = path.dirname(filePath);

  await mkdir(dir, {
    recursive: true,
    ...(posix ? { mode: options.dirMode ?? 0o700 } : {}),
  });

  const tmp = `${filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
  const handle = await open(tmp, 'wx', mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    if (posix) {
      await chmod(tmp, mode);
    }
    await rename(tmp, filePath);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }

  if (posix) {
    return { path: filePath, restricted: true, mode };
  }
  return {
    path: filePath,
    restricted: false,
    mode,
    note:
      'POSIX mode 0600 is not enforced on Windows; the file inherits the parent ' +
      'directory ACL. Keep it under a per-user profile directory (%APPDATA%).',
  };
}

/** What file protection *means* on a platform, for doctor messaging. */
export interface ProtectionClaim {
  /** Whether the platform enforces POSIX permission bits at all. */
  readonly posixPermissions: boolean;
  /** The mode we claim to write (`'0600'` on POSIX, `'n/a'` on Windows). */
  readonly claimedMode: string;
  /** Human-readable honesty note. */
  readonly note: string;
}

/** Describe how (and whether) file protection is enforced on `platform`. */
export function describeFileProtection(
  platform: NodeJS.Platform = process.platform,
): ProtectionClaim {
  if (platform === 'win32') {
    return {
      posixPermissions: false,
      claimedMode: 'n/a',
      note:
        'Windows does not honor POSIX 0600; effective protection is the NTFS ACL ' +
        'of the parent directory. The doctor reports the real ACL, not a claimed 0600.',
    };
  }
  return {
    posixPermissions: true,
    claimedMode: '0600',
    note: 'Owner read/write only (POSIX 0600), enforced on write.',
  };
}

/** The *actual* protection observed on a file (for `doctor`, CC-CFG-4). */
export interface FileProtection {
  /** True iff no group/other permission bits are set (POSIX). */
  readonly ownerOnly: boolean;
  /** The permission bits (`mode & 0o777`). */
  readonly mode: number;
  /** Whether the platform enforces POSIX permission bits. */
  readonly posixPermissions: boolean;
  /** Human-readable summary. */
  readonly note: string;
}

/**
 * Stat a file and report its *observed* protection — the honest counterpart to
 * {@link describeFileProtection}. Lets the doctor report actual file protection
 * instead of a claimed 0600 (CC-CFG-4).
 */
export async function statFileProtection(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<FileProtection> {
  const info = await stat(filePath);
  const bits = info.mode & 0o777;
  if (platform === 'win32') {
    return {
      ownerOnly: false,
      mode: bits,
      posixPermissions: false,
      note: describeFileProtection(platform).note,
    };
  }
  const ownerOnly = (bits & 0o077) === 0;
  const octal = bits.toString(8).padStart(4, '0');
  return {
    ownerOnly,
    mode: bits,
    posixPermissions: true,
    note: ownerOnly
      ? `Owner-only access (mode ${octal}).`
      : `Mode ${octal} grants group/other access.`,
  };
}
