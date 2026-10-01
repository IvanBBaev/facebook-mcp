#!/usr/bin/env node
// cold-start.mjs — prove `npx -y <pkg>` cold-starts the server the way an MCP
// client launches it (doc 08, Phase 4 exit gate).
//
// Purpose
//   Claude Desktop and Claude Code start this server with `npx -y <pkg>` over
//   stdio. Every in-repo test runs the compiled build straight from `build/`, so
//   none of them would notice a package that installs but cannot start: a file
//   missing from package.json#files, a runtime import of a devDependency, a bin
//   shim that exits silently, stdout noise that corrupts the JSON-RPC channel.
//   This script installs the package from scratch and speaks MCP to it.
//
// What it does
//   1. Resolves a package spec: by default `npm pack` of the current build (so a
//      PR is checked before anything is published); `--spec` takes a published
//      spec such as `@ivanbaev/facebook-mcp@0.7.0`, or a local `.tgz`.
//   2. Spawns `npx -y <spec>` in an empty temp directory with an isolated npm
//      cache, userconfig and global prefix — a cache that has never seen the
//      package or its dependencies, so the run is genuinely cold.
//   3. Sends `initialize`, `notifications/initialized` and `tools/list` as
//      newline-delimited JSON-RPC, and asserts: the process starts, answers
//      `initialize` with serverInfo name/version matching the package metadata,
//      lists a non-empty tool set, and writes nothing but JSON-RPC to stdout.
//   4. Closes stdin (the stdio transport's clean-shutdown signal) and, if the
//      process tree is still alive after a grace period, kills it.
//
// Credentials and network
//   None, ever. Startup fails closed without a token (`assertStartupOk`), so the
//   child gets a clearly fake `FB_ACCESS_TOKEN`. Startup performs no Graph I/O:
//   the transport, the Page registry and the token resolver are all lazy, and
//   `initialize` / `tools/list` never reach `fetch`. That is enforced, not
//   assumed: a fence module is preloaded into every Node process of the spawned
//   tree via NODE_OPTIONS=--import, replacing `fetch` with a thrower that also
//   prints a marker to stderr — a startup that reaches for the network fails the
//   run even if the server swallows the error. (npm's own registry traffic does
//   not go through the global `fetch`, so the install is unaffected.) Every
//   inherited `FB_*` and `npm_*` variable is scrubbed and the config/state
//   directories point into the temp dir, so a developer's real env file is never
//   read.
//
// Usage
//   node scripts/cold-start.mjs [--spec <spec>] [--expect-version <v>]
//                               [--timeout-ms <n>] [--keep-temp] [--verbose]
//
//   --spec            Package spec to run. Default: `npm pack` of this checkout
//                     (requires `npm run build` first).
//   --expect-version  serverInfo.version to require. Default: the packed
//                     version, the exact version in --spec, or `npm view`.
//   --timeout-ms      Budget for install + `initialize` (default 240000). The
//                     `tools/list` answer then gets a fixed 30 s.
//   --keep-temp       Leave the temp directory behind for inspection.
//   --verbose         Stream the child's stderr live.
//   --help            Show usage and exit 0.
//
// Exit codes: 0 pass, 1 cold-start failed, 2 usage error.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2 });

/**
 * The credential handed to the child. Only its presence matters: startup fails
 * closed without one, and nothing on the checked path ever sends it anywhere.
 */
export const FAKE_TOKEN = 'cold-start-fake-token-not-a-real-credential';

/** Printed to stderr by the preloaded fence whenever anything calls `fetch`. */
export const FENCE_MARKER = '[cold-start network fence]';

export const DEFAULT_TIMEOUT_MS = 240_000;
const TOOLS_LIST_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 5_000;
const STDERR_TAIL_LINES = 60;

/** Any version the server negotiates down from is fine; this is only the offer. */
const PROTOCOL_VERSION = '2025-06-18';

const USAGE = `cold-start — prove \`npx -y <pkg>\` starts the MCP server from a cold cache

Usage:
  node scripts/cold-start.mjs [options]

Options:
  --spec <spec>          Package spec to run (default: npm pack of this checkout;
                         run \`npm run build\` first). Examples:
                         @ivanbaev/facebook-mcp@0.7.0, ./facebook-mcp-0.7.0.tgz
  --expect-version <v>   serverInfo.version to require (default: derived).
  --timeout-ms <n>       Budget for install + initialize (default ${String(DEFAULT_TIMEOUT_MS)}).
  --keep-temp            Keep the temp directory for inspection.
  --verbose              Stream the child's stderr live.
  --help                 Show this help.
`;

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

export class ColdStartError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ColdStartError';
  }
}

/** Parse argv (without the node + script prefix) into validated options. */
export function parseCliArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        spec: { type: 'string' },
        'expect-version': { type: 'string' },
        'timeout-ms': { type: 'string' },
        'keep-temp': { type: 'boolean', default: false },
        verbose: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (err) {
    throw new UsageError(err.message);
  }
  const { values } = parsed;
  const spec = values.spec?.trim();
  if (values.spec !== undefined && !spec)
    throw new UsageError('--spec must not be empty');
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (values['timeout-ms'] !== undefined) {
    timeoutMs = Number(values['timeout-ms']);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
      throw new UsageError(
        `--timeout-ms must be an integer >= 1000; got ${JSON.stringify(values['timeout-ms'])}`,
      );
    }
  }
  return {
    help: values.help,
    spec,
    expectVersion: values['expect-version']?.trim() || undefined,
    timeoutMs,
    keepTemp: values['keep-temp'],
    verbose: values.verbose,
  };
}

/** True when the spec names a local tarball rather than a registry package. */
export function isTarballSpec(spec) {
  return /\.(tgz|tar\.gz)$/i.test(spec);
}

/** The filesystem path a tarball spec names (`./x.tgz`, `file:x.tgz`, `file:///x.tgz`). */
export function tarballPath(spec, cwd = process.cwd()) {
  if (spec.startsWith('file://')) return fileURLToPath(spec);
  return resolve(cwd, spec.startsWith('file:') ? spec.slice('file:'.length) : spec);
}

/**
 * The spec npx is given for a tarball. A bare path is NOT a package spec to
 * `npm exec`: a positional that exists as a file is executed as the command
 * itself (libnpmexec checks the filesystem before it parses a package spec), so
 * `npx -y /tmp/x.tgz` fails with "Permission denied". A `file:` URL is never an
 * existing file name, so npm parses it as a package and installs it.
 */
export function tarballSpec(path) {
  return pathToFileURL(path).href;
}

/** `@scope/name` → `name`; the bare name the server reports as serverInfo.name. */
export function unscopedName(packageName) {
  const slash = packageName.lastIndexOf('/');
  return packageName.startsWith('@') && slash > 0
    ? packageName.slice(slash + 1)
    : packageName;
}

/**
 * Split a registry spec into name and version/range/tag. The `@` of a scope is
 * part of the name, so only an `@` after the first character separates them.
 */
export function splitRegistrySpec(spec) {
  const at = spec.indexOf('@', 1);
  if (at < 0) return { name: spec, selector: undefined };
  return { name: spec.slice(0, at), selector: spec.slice(at + 1) || undefined };
}

/** The version a registry spec pins exactly, or undefined for a tag or range. */
export function exactVersionOf(spec) {
  const { selector } = splitRegistrySpec(spec);
  return selector !== undefined && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(selector)
    ? selector
    : undefined;
}

/**
 * The child's environment: the host's, minus every `FB_*` credential/setting a
 * developer may have exported and every `npm_*` variable `npm run` injects (an
 * inherited `npm_config_cache` would silently warm the "cold" cache), plus the
 * isolation below. Pure: `dirs` are paths the caller has already created.
 */
export function buildChildEnv(baseEnv, dirs, platform = process.platform) {
  const env = {};
  for (const [name, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (upper.startsWith('FB_') || upper.startsWith('NPM_') || upper === 'NODE_OPTIONS') {
      continue;
    }
    env[name] = value;
  }
  Object.assign(env, {
    npm_config_cache: dirs.cache,
    npm_config_userconfig: dirs.userconfig,
    npm_config_prefix: dirs.prefix,
    npm_config_yes: 'true',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    // Config + state resolution for both platform conventions (src/core/config.ts):
    // the operator's own env file is never read, and any state lands in the temp dir.
    XDG_CONFIG_HOME: dirs.config,
    XDG_STATE_HOME: dirs.state,
    FB_ACCESS_TOKEN: FAKE_TOKEN,
    FB_LOG_LEVEL: 'info',
    NODE_OPTIONS: `--import=${pathToFileURL(dirs.fence).href}`,
  });
  if (platform === 'win32') {
    env.APPDATA = dirs.config;
    env.LOCALAPPDATA = dirs.state;
  }
  return env;
}

/** The fence module preloaded into every Node process of the spawned tree. */
export function fenceSource(marker = FENCE_MARKER) {
  // Only origin + path is reported: a query string may carry a token.
  return `// Generated by scripts/cold-start.mjs — blocks and reports every fetch.
globalThis.fetch = (input) => {
  const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
  let where = '<unparseable URL>';
  try {
    const u = new URL(raw);
    where = u.origin + u.pathname;
  } catch {}
  process.stderr.write(${JSON.stringify(marker)} + ' blocked fetch ' + where + '\\n');
  throw new Error('cold-start network fence: startup must not perform network I/O');
};
`;
}

/**
 * Quote one argument for the cmd.exe command line Node builds with
 * `shell: true` (Windows only, where `npx.cmd` cannot be spawned without a
 * shell since the CVE-2024-27980 fix). Refuses the characters cmd.exe would
 * still interpret inside quotes rather than guessing at an escape.
 */
export function quoteForCmd(arg) {
  if (/["%!\r\n]/.test(arg)) {
    throw new UsageError(`argument cannot be passed safely through cmd.exe: ${arg}`);
  }
  return /^[A-Za-z0-9_\-.,:\\/@=+]+$/.test(arg) ? arg : `"${arg}"`;
}

/** How to spawn `npx -y <spec>` on this platform. */
export function npxInvocation(spec, platform = process.platform) {
  const args = ['-y', spec];
  if (platform === 'win32') {
    return { command: 'npx.cmd', args: args.map(quoteForCmd), shell: true };
  }
  return { command: 'npx', args, shell: false };
}

/**
 * Incremental newline-delimited JSON-RPC decoder for the child's stdout. Every
 * line must be a JSON object: anything else on stdout would break a real MCP
 * client, so it is collected as pollution rather than skipped.
 */
export function createFrameDecoder() {
  let buffer = '';
  const pollution = [];
  return {
    pollution,
    push(chunk) {
      buffer += chunk;
      const frames = [];
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line.trim() === '') continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          pollution.push(line);
          continue;
        }
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          frames.push(parsed);
        } else {
          pollution.push(line);
        }
      }
      return frames;
    },
  };
}

/** Problems with an `initialize` response; empty when it is acceptable. */
export function checkInitialize(response, expected) {
  if (response.error)
    return [`initialize returned an error: ${JSON.stringify(response.error)}`];
  const result = response.result;
  if (result === null || typeof result !== 'object') {
    return ['initialize response carries no result object'];
  }
  const problems = [];
  const info = result.serverInfo;
  if (info === null || typeof info !== 'object') {
    problems.push('initialize result has no serverInfo');
  } else {
    if (info.name !== expected.name) {
      problems.push(
        `serverInfo.name is ${JSON.stringify(info.name)}, expected ${JSON.stringify(expected.name)}`,
      );
    }
    if (info.version !== expected.version) {
      problems.push(
        `serverInfo.version is ${JSON.stringify(info.version)}, expected ${JSON.stringify(expected.version)}`,
      );
    }
  }
  if (typeof result.protocolVersion !== 'string' || result.protocolVersion === '') {
    problems.push('initialize result has no protocolVersion');
  }
  if (result.capabilities === null || typeof result.capabilities !== 'object') {
    problems.push('initialize result has no capabilities object');
  } else if (!result.capabilities.tools) {
    problems.push('server does not advertise the tools capability');
  }
  return problems;
}

/** Problems with a `tools/list` response; empty when it is acceptable. */
export function checkToolsList(response) {
  if (response.error)
    return [`tools/list returned an error: ${JSON.stringify(response.error)}`];
  const tools = response.result?.tools;
  if (!Array.isArray(tools)) return ['tools/list result has no tools array'];
  if (tools.length === 0) return ['tools/list returned an empty tool set'];
  const unnamed = tools.filter((t) => typeof t?.name !== 'string' || t.name === '');
  return unnamed.length > 0
    ? [`${String(unnamed.length)} listed tool(s) have no name`]
    : [];
}

/**
 * Read `package/package.json` out of an `npm pack` tarball (gzip'd ustar), so a
 * `--spec ./x.tgz` run knows the identity it must see without asking npm — `npm
 * view` does not accept a tarball. Only what `npm pack` writes is handled: plain
 * 512-byte headers, with the path split into the ustar prefix + name fields.
 */
export function packageJsonFromTarball(gz) {
  const tar = gunzipSync(gz);
  const field = (off, len) => {
    const raw = tar.subarray(off, off + len);
    const nul = raw.indexOf(0);
    return raw.subarray(0, nul < 0 ? len : nul).toString('utf8');
  };
  for (let off = 0; off + 512 <= tar.length;) {
    const name = field(off, 100);
    if (name === '') break;
    const prefix = field(off + 345, 155);
    const size = parseInt(field(off + 124, 12).trim() || '0', 8);
    const path = prefix ? `${prefix}/${name}` : name;
    if (path === 'package/package.json') {
      return JSON.parse(tar.subarray(off + 512, off + 512 + size).toString('utf8'));
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('no package/package.json entry in the tarball');
}

/** The last `n` non-empty lines of `text`, for a readable failure report. */
export function tailLines(text, n = STDERR_TAIL_LINES) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  return lines.slice(-n);
}

// --- Side-effecting part (not unit-tested: it installs and spawns) -----------

const log = (line) => process.stdout.write(`cold-start: ${line}\n`);

function runNpm(args, options) {
  const win = process.platform === 'win32';
  const result = spawnSync(win ? 'npm.cmd' : 'npm', win ? args.map(quoteForCmd) : args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    shell: win,
    ...options,
  });
  if (result.error)
    throw new ColdStartError(`npm ${args[0]} failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new ColdStartError(
      `npm ${args.join(' ')} exited ${String(result.status)}:\n${tailLines(result.stderr).join('\n')}`,
    );
  }
  return result.stdout;
}

/** `npm pack` this checkout into `dest`; returns the tarball path + identity. */
function packCheckout(dest) {
  try {
    readFileSync(join(REPO_ROOT, 'build', 'index.js'));
  } catch {
    throw new ColdStartError('build/index.js is missing — run `npm run build` first.');
  }
  const stdout = runNpm(
    ['pack', '--json', '--ignore-scripts', '--pack-destination', dest],
    {
      cwd: REPO_ROOT,
    },
  );
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  let entry;
  try {
    entry = JSON.parse(stdout.slice(start, end + 1))[0];
  } catch (err) {
    throw new ColdStartError(
      `could not parse \`npm pack --json\` output: ${err.message}`,
    );
  }
  if (!entry?.filename || !entry.name || !entry.version) {
    throw new ColdStartError('`npm pack --json` did not report a filename/name/version.');
  }
  return {
    spec: tarballSpec(join(dest, entry.filename)),
    name: entry.name,
    version: entry.version,
  };
}

/** Expected identity for a spec the caller passed explicitly. */
function identityForSpec(spec, env, cwd) {
  if (isTarballSpec(spec)) {
    const path = tarballPath(spec);
    let meta;
    try {
      meta = packageJsonFromTarball(readFileSync(path));
    } catch (err) {
      throw new ColdStartError(`cannot read package.json from ${path}: ${err.message}`);
    }
    return { spec: tarballSpec(path), name: meta.name, version: meta.version };
  }
  const { name } = splitRegistrySpec(spec);
  const version =
    exactVersionOf(spec) ??
    JSON.parse(runNpm(['view', spec, 'version', '--json'], { env, cwd }));
  return { spec, name, version: Array.isArray(version) ? version.at(-1) : version };
}

/** Kill the whole spawned tree: npx → npm → sh → node on POSIX, cmd.exe → … on Windows. */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

async function coldStart(options) {
  const temp = mkdtempSync(join(tmpdir(), 'facebook-mcp-cold-start-'));
  const dirs = {
    work: join(temp, 'work'),
    cache: join(temp, 'npm-cache'),
    prefix: join(temp, 'npm-prefix'),
    userconfig: join(temp, 'npmrc'),
    config: join(temp, 'config'),
    state: join(temp, 'state'),
    fence: join(temp, 'fence.mjs'),
  };
  for (const dir of [dirs.work, dirs.cache, dirs.prefix, dirs.config, dirs.state]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(dirs.userconfig, '');
  writeFileSync(dirs.fence, fenceSource());
  const env = buildChildEnv(process.env, dirs);

  let child;
  const cleanup = () => {
    if (child) killTree(child);
    if (!options.keepTemp) rmSync(temp, { recursive: true, force: true });
  };
  process.once('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  try {
    const target = options.spec
      ? identityForSpec(options.spec, env, dirs.work)
      : packCheckout(temp);
    const expected = {
      name: unscopedName(target.name),
      version: options.expectVersion ?? target.version,
    };
    log(`spec      ${target.spec}`);
    log(`expect    serverInfo ${expected.name} ${expected.version}`);
    log(`temp      ${temp}${options.keepTemp ? ' (kept)' : ''}`);

    const inv = npxInvocation(target.spec);
    log(`spawn     ${inv.command} ${inv.args.join(' ')}  (cold cache, cwd = empty dir)`);
    const started = Date.now();
    child = spawn(inv.command, inv.args, {
      cwd: dirs.work,
      env,
      shell: inv.shell,
      // Own process group on POSIX so the whole npx → node tree can be killed.
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (options.verbose) process.stderr.write(chunk);
    });
    child.stdin.on('error', () => {
      // EPIPE when the child died first; the exit handler reports it.
    });

    const decoder = createFrameDecoder();
    const waiters = new Map();
    let exitInfo;
    const exited = new Promise((resolveExit) => {
      child.on('exit', (code, signal) => {
        exitInfo = { code, signal };
        for (const w of waiters.values()) w.reject(new ColdStartError(exitMessage()));
        resolveExit();
      });
    });
    child.on('error', (err) => {
      for (const w of waiters.values())
        w.reject(new ColdStartError(`spawn failed: ${err.message}`));
    });
    const exitMessage = () =>
      `the process exited before answering (code ${String(exitInfo?.code)}, signal ${String(exitInfo?.signal)})`;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      for (const frame of decoder.push(chunk)) {
        const w = waiters.get(frame.id);
        if (w) {
          waiters.delete(frame.id);
          w.resolve(frame);
        }
      }
    });

    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const request = (id, method, params, timeoutMs) =>
      new Promise((resolveReq, rejectReq) => {
        if (exitInfo) return rejectReq(new ColdStartError(exitMessage()));
        const timer = setTimeout(() => {
          waiters.delete(id);
          rejectReq(
            new ColdStartError(`no ${method} response within ${String(timeoutMs)} ms`),
          );
        }, timeoutMs);
        waiters.set(id, {
          resolve: (v) => (clearTimeout(timer), resolveReq(v)),
          reject: (e) => (clearTimeout(timer), rejectReq(e)),
        });
        send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
      });

    const fail = (problems) => {
      const lines = [...problems];
      if (decoder.pollution.length > 0) {
        lines.push(
          `non-JSON-RPC output on stdout:\n    ${decoder.pollution.slice(0, 10).join('\n    ')}`,
        );
      }
      const tail = tailLines(stderr);
      if (tail.length > 0) {
        lines.push(
          `child stderr (last ${String(tail.length)} lines):\n    ${tail.join('\n    ')}`,
        );
      }
      throw new ColdStartError(lines.join('\n  '));
    };

    let init;
    try {
      init = await request(
        1,
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'facebook-mcp-cold-start', version: '1.0.0' },
        },
        options.timeoutMs,
      );
    } catch (err) {
      fail([err.message]);
    }
    const initProblems = checkInitialize(init, expected);
    if (initProblems.length > 0) fail(initProblems);
    const info = init.result.serverInfo;
    log(
      `initialize ok after ${((Date.now() - started) / 1000).toFixed(1)} s — ` +
        `${info.name} ${info.version} (protocol ${init.result.protocolVersion})`,
    );

    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    let list;
    try {
      list = await request(2, 'tools/list', undefined, TOOLS_LIST_TIMEOUT_MS);
    } catch (err) {
      fail([err.message]);
    }
    const listProblems = checkToolsList(list);
    if (listProblems.length > 0) fail(listProblems);
    log(`tools/list ok — ${String(list.result.tools.length)} tools`);

    const late = [];
    if (decoder.pollution.length > 0) late.push('stdout carried non-JSON-RPC output');
    if (stderr.includes(FENCE_MARKER))
      late.push('startup attempted network I/O (fence hit)');
    if (late.length > 0) fail(late);

    // Clean shutdown: stdin EOF is the stdio transport's close signal.
    child.stdin.end();
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise((r) => setTimeout(() => r(false), SHUTDOWN_GRACE_MS)),
    ]);
    if (graceful) {
      log(`shutdown  exited on stdin EOF (code ${String(exitInfo.code)})`);
    } else {
      log(
        `shutdown  WARNING: still running ${String(SHUTDOWN_GRACE_MS)} ms after stdin EOF; killed`,
      );
    }
    log('PASS');
  } finally {
    cleanup();
  }
}

async function main(argv) {
  let options;
  try {
    options = parseCliArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`cold-start: ${err.message}\n\n${USAGE}`);
      return EXIT.usage;
    }
    throw err;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return EXIT.ok;
  }
  await coldStart(options);
  return EXIT.ok;
}

// Run only when this module is the process entry point, never on import — the
// unit tests import the pure helpers and must not trigger an install.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      if (err instanceof ColdStartError || err instanceof UsageError) {
        process.stderr.write(`cold-start: FAIL\n  ${err.message}\n`);
      } else {
        process.stderr.write(
          `cold-start: FAIL\n  ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
        );
      }
      process.exitCode = EXIT.failed;
    },
  );
}
