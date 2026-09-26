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
import { readFileSync } from 'node:fs';
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
 * An env-supplied base directory, or `undefined` when the value cannot be one.
 *
 * `??` only guards `undefined`, and an EMPTY `XDG_CONFIG_HOME` is a real thing —
 * a launcher, a systemd unit or a `sudo` that scrubbed the variable exports it
 * as `""`. Joined with the app name that yields the RELATIVE path
 * `facebook-mcp`, so the credential env file and the write journal would be
 * created under whatever directory the MCP client happened to spawn the server
 * in: outside the per-user config dir, and outside the 0600/0700 that protects
 * it. A non-absolute value has the same effect, which is why the XDG spec calls
 * unset, empty and relative all invalid and says the default applies. The same
 * reasoning covers %APPDATA%/%LOCALAPPDATA%.
 */
function envBaseDir(value: string | undefined, p: typeof path.posix): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  return p.isAbsolute(value) ? value : undefined;
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
    const base = envBaseDir(env.APPDATA, p) ?? p.join(home, 'AppData', 'Roaming');
    return p.join(base, APP_DIR_NAME);
  }
  const base = envBaseDir(env.XDG_CONFIG_HOME, p) ?? p.join(home, '.config');
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
    const base =
      envBaseDir(env.LOCALAPPDATA, p) ??
      envBaseDir(env.APPDATA, p) ??
      p.join(home, 'AppData', 'Local');
    return p.join(base, APP_DIR_NAME);
  }
  const base = envBaseDir(env.XDG_STATE_HOME, p) ?? p.join(home, '.local', 'state');
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
 * gives env-first semantics — a non-blank value already in `process.env`
 * (client-passed) beats the file; a blank one does not. A missing file is
 * tolerated (the file is optional).
 */
export function loadEnvFile(options: LoadEnvFileOptions = {}): LoadEnvFileResult {
  // Parse into a scratch object and populate `process.env` here, not in dotenv:
  // dotenv's env-first test is "the key exists", so a client that passes a
  // BLANK value — an MCPB install maps every optional `user_config` field, and
  // a field left empty arrives as FB_ACCESS_TOKEN="" — shadowed the file's
  // value. Settings reads blank as unset, so startup then said "No access token
  // configured" while the token sat in the env file. Blank is unset here too.
  const scratch: Record<string, string> = {};
  const utf16 = readUtf16EnvFile(options.path ?? path.resolve(process.cwd(), '.env'));
  const result =
    utf16 !== undefined
      ? { parsed: dotenv.parse(utf16) }
      : dotenv.config({
          quiet: true,
          processEnv: scratch,
          ...(options.path !== undefined ? { path: options.path } : {}),
        });
  const error = result.error as NodeJS.ErrnoException | undefined;
  const parsed = result.parsed ?? {};
  const override = options.override ?? false;
  for (const [key, value] of Object.entries(parsed)) {
    const current = process.env[key];
    if (override || current === undefined || current.trim().length === 0) {
      process.env[key] = value;
    }
  }
  return {
    ...(options.path !== undefined ? { path: options.path } : {}),
    loaded: error === undefined,
    parsedKeys: Object.keys(parsed),
    ...(error !== undefined ? { error } : {}),
  };
}

/**
 * The text of a UTF-16 env file (BOM-marked), or `undefined` for anything else.
 *
 * Windows PowerShell 5.1 writes UTF-16LE with a BOM from `>` and `Out-File` by
 * default, so `echo FB_ACCESS_TOKEN=... > $env:APPDATA\facebook-mcp\.env` is
 * a UTF-16 file. dotenv decodes every file as UTF-8, sees NUL-interleaved bytes,
 * parses zero keys and reports NO error — startup then says "No access token
 * configured" with the token in the file and nothing naming it. Decoding it here
 * reads what the operator wrote. A file that cannot be read returns `undefined`
 * so dotenv's own read reports the error exactly as before.
 */
function readUtf16EnvFile(filePath: string): string | undefined {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch {
    return undefined;
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString('utf16le');
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = Buffer.from(bytes.subarray(2));
    return body
      .subarray(0, body.length - (body.length % 2))
      .swap16()
      .toString('utf16le');
  }
  return undefined;
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
 * never sees a partial or world-readable file. Any failure after the temp file
 * exists — write, fsync, close, chmod or rename — removes it before rethrowing,
 * so a failed write never leaves a half-written credential file behind. On
 * Windows the POSIX 0600 has no
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

  // Every step after the temp file exists is inside one try: a failure in the
  // write, the fsync, the close, the chmod or the rename must not leave an
  // orphaned `.tmp` sibling behind in the config/state dir. `rm(..., force)` is a
  // no-op when `open` itself failed and no temp file was ever created.
  const tmp = `${filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tmp, 'wx', mode);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }

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
 * instead of a claimed 0600 (CC-CFG-4). Rejects (code `EISDIR`/`EINVAL`) when
 * the path is not a regular file.
 */
export async function statFileProtection(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<FileProtection> {
  const info = await stat(filePath);
  // stat() succeeds on a directory, and a directory's 0700 would read as an
  // owner-only credential file that dotenv cannot load at all (EISDIR). Refuse
  // to describe anything but a regular file; the doctor reports the rejection.
  if (!info.isFile()) {
    const notFile: NodeJS.ErrnoException = new Error(
      `${filePath} is not a regular file${info.isDirectory() ? ' (it is a directory)' : ''}.`,
    );
    notFile.code = info.isDirectory() ? 'EISDIR' : 'EINVAL';
    throw notFile;
  }
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
