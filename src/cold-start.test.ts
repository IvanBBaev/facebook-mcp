// Cold-start check (`scripts/cold-start.mjs`) — the pure decisions.
//
// The script is the automated form of the Phase 4 exit gate (doc 08): `npx -y
// <pkg>` from a cold cache must start the server and answer MCP. Its run loop
// installs from the registry and spawns a process tree, so it is exercised by
// the `cold-start` CI job, not here. What IS pinned here are the decisions that
// make that run trustworthy and that no CI leg would flag if they regressed
// quietly: the child env really is scrubbed of the host's credentials and warm
// npm cache, the tarball is handed to npx in the one form `npm exec` installs
// rather than executes, the cmd.exe quoting refuses what it cannot escape, and
// the response checks fail on exactly the shapes a real client would choke on.
//
// Same import convention as `src/record-fixture.test.ts`: the script lives
// outside `rootDir`, so it is loaded the way Node loads it. Nothing here touches
// the network; the one child process below runs the fence against a `fetch` it
// blocks before any socket is opened.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

/** This file compiles to `build/cold-start.test.js`, so the root is one level up. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

type Json = Record<string, unknown>;

interface Dirs {
  readonly cache: string;
  readonly prefix: string;
  readonly userconfig: string;
  readonly config: string;
  readonly state: string;
  readonly fence: string;
}

interface ColdStart {
  readonly FAKE_TOKEN: string;
  readonly FENCE_MARKER: string;
  readonly DEFAULT_TIMEOUT_MS: number;
  readonly parseCliArgs: (argv: readonly string[]) => {
    help: boolean;
    spec?: string;
    expectVersion?: string;
    timeoutMs: number;
    keepTemp: boolean;
    verbose: boolean;
  };
  readonly isTarballSpec: (spec: string) => boolean;
  readonly tarballPath: (spec: string, cwd?: string) => string;
  readonly tarballSpec: (path: string) => string;
  readonly unscopedName: (name: string) => string;
  readonly splitRegistrySpec: (spec: string) => { name: string; selector?: string };
  readonly exactVersionOf: (spec: string) => string | undefined;
  readonly buildChildEnv: (
    base: Record<string, string | undefined>,
    dirs: Dirs,
    platform?: string,
  ) => Record<string, string>;
  readonly fenceSource: (marker?: string) => string;
  readonly quoteForCmd: (arg: string) => string;
  readonly npxInvocation: (
    spec: string,
    platform?: string,
  ) => { command: string; args: string[]; shell: boolean };
  readonly createFrameDecoder: () => {
    pollution: string[];
    push: (chunk: string) => Json[];
  };
  readonly checkInitialize: (
    response: Json,
    expected: { name: string; version: string },
  ) => string[];
  readonly checkToolsList: (response: Json) => string[];
  readonly packageJsonFromTarball: (gz: Buffer) => Json;
  readonly tailLines: (text: string, n?: number) => string[];
}

const coldStartUrl = pathToFileURL(join(REPO_ROOT, 'scripts', 'cold-start.mjs')).href;
const cs = (await import(coldStartUrl)) as ColdStart;

interface MetadataConfig {
  readonly identity: { readonly packageName: string; readonly shortName: string };
}
const metadataUrl = pathToFileURL(join(REPO_ROOT, 'scripts', 'metadata.config.mjs')).href;
const { identity } = (await import(metadataUrl)) as MetadataConfig;

const DIRS: Dirs = {
  cache: '/t/npm-cache',
  prefix: '/t/npm-prefix',
  userconfig: '/t/npmrc',
  config: '/t/config',
  state: '/t/state',
  fence: '/t/fence.mjs',
};

// --- identity -------------------------------------------------------------

test('the expected serverInfo.name is the unscoped package name, and that is the SSOT short name', () => {
  // The script derives the name it requires from the package it installed; the
  // server hard-codes its own. This pins that the two derivations agree.
  assert.equal(cs.unscopedName(identity.packageName), identity.shortName);
  assert.equal(cs.unscopedName('@ivanbaev/facebook-mcp'), 'facebook-mcp');
  assert.equal(cs.unscopedName('facebook-mcp'), 'facebook-mcp');
});

test('registry specs split on the version @, never on the scope @', () => {
  assert.deepEqual(cs.splitRegistrySpec('@ivanbaev/facebook-mcp@0.7.0'), {
    name: '@ivanbaev/facebook-mcp',
    selector: '0.7.0',
  });
  assert.deepEqual(cs.splitRegistrySpec('@ivanbaev/facebook-mcp'), {
    name: '@ivanbaev/facebook-mcp',
    selector: undefined,
  });
  assert.equal(cs.exactVersionOf('@ivanbaev/facebook-mcp@0.7.0'), '0.7.0');
  assert.equal(cs.exactVersionOf('@ivanbaev/facebook-mcp@1.0.0-rc.1'), '1.0.0-rc.1');
  // A tag or a range is not a version to compare serverInfo against.
  assert.equal(cs.exactVersionOf('@ivanbaev/facebook-mcp@latest'), undefined);
  assert.equal(cs.exactVersionOf('@ivanbaev/facebook-mcp@^0.7.0'), undefined);
  assert.equal(cs.exactVersionOf('@ivanbaev/facebook-mcp'), undefined);
});

// --- tarball handling -----------------------------------------------------

test('a tarball goes to npx as a file: URL, which npm exec installs instead of executing', () => {
  assert.equal(cs.isTarballSpec('/tmp/ivanbaev-facebook-mcp-0.7.0.tgz'), true);
  assert.equal(cs.isTarballSpec('file:///tmp/x.tar.gz'), true);
  assert.equal(cs.isTarballSpec('@ivanbaev/facebook-mcp@0.7.0'), false);

  const path = join(tmpdir(), 'ivanbaev-facebook-mcp-0.7.0.tgz');
  const spec = cs.tarballSpec(path);
  assert.match(spec, /^file:\/\//);
  // Round-trips through every accepted spelling back to the same path.
  assert.equal(cs.tarballPath(spec), path);
  assert.equal(cs.tarballPath(`file:${path}`), path);
  assert.equal(cs.tarballPath('x.tgz', tmpdir()), join(tmpdir(), 'x.tgz'));
});

/** One ustar entry: a 512-byte header with a valid checksum, then padded data. */
function tarEntry(name: string, body: string, prefix = ''): Buffer {
  const data = Buffer.from(body, 'utf8');
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii');
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}

test('package.json is read out of an npm pack tarball, past other entries', () => {
  const manifest = { name: '@ivanbaev/facebook-mcp', version: '9.9.9' };
  const gz = gzipSync(
    Buffer.concat([
      tarEntry('package/LICENSE', 'x'.repeat(700)),
      tarEntry('package.json', JSON.stringify(manifest), 'package'),
      Buffer.alloc(1024),
    ]),
  );
  assert.deepEqual(cs.packageJsonFromTarball(gz), manifest);

  const without = gzipSync(
    Buffer.concat([tarEntry('package/README.md', '#'), Buffer.alloc(1024)]),
  );
  assert.throws(() => cs.packageJsonFromTarball(without), /no package\/package\.json/);
});

// --- child environment ----------------------------------------------------

test('the child env drops host credentials, npm run state and NODE_OPTIONS', () => {
  const env = cs.buildChildEnv(
    {
      PATH: '/usr/bin',
      FB_ACCESS_TOKEN: 'EAA-real-looking-token',
      FB_SYSTEM_TOKEN: 'EAA-another',
      FB_PAGE_ID: '123',
      npm_config_cache: '/home/dev/.npm',
      npm_lifecycle_event: 'cold-start',
      NPM_CONFIG_REGISTRY: 'https://mirror.example',
      NODE_OPTIONS: '--inspect',
      UNSET: undefined,
    },
    DIRS,
    'linux',
  );

  assert.equal(env['PATH'], '/usr/bin');
  assert.equal(env['FB_ACCESS_TOKEN'], cs.FAKE_TOKEN);
  assert.equal(env['FB_SYSTEM_TOKEN'], undefined);
  assert.equal(env['FB_PAGE_ID'], undefined);
  assert.equal(env['NPM_CONFIG_REGISTRY'], undefined);
  assert.equal(env['npm_lifecycle_event'], undefined);
  assert.equal('UNSET' in env, false);
  // Cold means cold: the cache, userconfig and global prefix are the fresh ones.
  assert.equal(env['npm_config_cache'], DIRS.cache);
  assert.equal(env['npm_config_userconfig'], DIRS.userconfig);
  assert.equal(env['npm_config_prefix'], DIRS.prefix);
  assert.equal(env['XDG_CONFIG_HOME'], DIRS.config);
  // The only NODE_OPTIONS is the fence preload, as a URL (a bare Windows path is
  // not a valid --import specifier).
  assert.equal(env['NODE_OPTIONS'], `--import=${pathToFileURL(DIRS.fence).href}`);
  assert.equal(env['APPDATA'], undefined, 'APPDATA is only redirected on Windows');
});

test('on Windows the config/state dirs are redirected through APPDATA/LOCALAPPDATA too', () => {
  const env = cs.buildChildEnv(
    { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' },
    DIRS,
    'win32',
  );
  assert.equal(env['APPDATA'], DIRS.config);
  assert.equal(env['LOCALAPPDATA'], DIRS.state);
});

test('the fake token is visibly fake', () => {
  assert.match(cs.FAKE_TOKEN, /fake/);
  assert.doesNotMatch(cs.FAKE_TOKEN, /^EAA/, 'must not look like a Meta access token');
});

test('the fence blocks fetch, reports it on stderr and never echoes a query string', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'facebook-mcp-cold-start-test-'));
  try {
    const fence = join(dir, 'fence.mjs');
    await writeFile(fence, cs.fenceSource());
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(fence).href,
        '-e',
        "try { fetch('https://graph.facebook.com/v23.0/me?access_token=SECRET') } catch (e) { console.error(e.message) }",
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stderr.includes(cs.FENCE_MARKER), result.stderr);
    assert.match(
      result.stderr,
      /blocked fetch https:\/\/graph\.facebook\.com\/v23\.0\/me/,
    );
    assert.match(result.stderr, /startup must not perform network I\/O/);
    assert.doesNotMatch(result.stderr, /SECRET/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- spawning -------------------------------------------------------------

test('npx is spawned without a shell on POSIX and through cmd.exe on Windows', () => {
  assert.deepEqual(cs.npxInvocation('@ivanbaev/facebook-mcp@0.7.0', 'darwin'), {
    command: 'npx',
    args: ['-y', '@ivanbaev/facebook-mcp@0.7.0'],
    shell: false,
  });
  const win = cs.npxInvocation('file:///C:/Temp/x y/pkg.tgz', 'win32');
  assert.equal(win.command, 'npx.cmd');
  assert.equal(win.shell, true);
  assert.deepEqual(win.args, ['-y', '"file:///C:/Temp/x y/pkg.tgz"']);
});

test('cmd.exe quoting leaves safe args alone and refuses what it cannot escape', () => {
  assert.equal(
    cs.quoteForCmd('@ivanbaev/facebook-mcp@0.7.0'),
    '@ivanbaev/facebook-mcp@0.7.0',
  );
  assert.equal(cs.quoteForCmd('C:\\a b\\c.tgz'), '"C:\\a b\\c.tgz"');
  assert.equal(cs.quoteForCmd('a&b'), '"a&b"');
  for (const bad of ['a"b', 'file:///C:/a%20b.tgz', 'x!y', 'a\nb']) {
    assert.throws(() => cs.quoteForCmd(bad), /cannot be passed safely/, bad);
  }
});

// --- CLI ------------------------------------------------------------------

test('CLI arguments are validated', () => {
  const defaults = cs.parseCliArgs([]);
  assert.equal(defaults.spec, undefined);
  assert.equal(defaults.timeoutMs, cs.DEFAULT_TIMEOUT_MS);
  assert.equal(defaults.keepTemp, false);

  const set = cs.parseCliArgs([
    '--spec',
    '@ivanbaev/facebook-mcp@0.7.0',
    '--expect-version',
    '0.7.0',
    '--timeout-ms',
    '5000',
    '--keep-temp',
  ]);
  assert.equal(set.spec, '@ivanbaev/facebook-mcp@0.7.0');
  assert.equal(set.expectVersion, '0.7.0');
  assert.equal(set.timeoutMs, 5000);
  assert.equal(set.keepTemp, true);

  assert.throws(() => cs.parseCliArgs(['--timeout-ms', '10']), /--timeout-ms/);
  assert.throws(() => cs.parseCliArgs(['--timeout-ms', 'soon']), /--timeout-ms/);
  assert.throws(() => cs.parseCliArgs(['--spec', '  ']), /--spec/);
  assert.throws(
    () => cs.parseCliArgs(['--bogus']),
    (err: unknown) => {
      return err instanceof Error && err.name === 'UsageError';
    },
  );
  assert.throws(() => cs.parseCliArgs(['positional']));
});

// --- the MCP conversation -------------------------------------------------

test('stdout frames are decoded across chunk boundaries, and anything else is pollution', () => {
  const decoder = cs.createFrameDecoder();
  assert.deepEqual(decoder.push('{"jsonrpc":"2.0","id":1,'), []);
  assert.deepEqual(decoder.push('"result":{}}\r\n\n'), [
    { jsonrpc: '2.0', id: 1, result: {} },
  ]);
  assert.deepEqual(decoder.push('npm warn something\n[1,2]\n{"id":2}\n'), [{ id: 2 }]);
  assert.deepEqual(decoder.pollution, ['npm warn something', '[1,2]']);
});

const goodInit = (): Json => ({
  jsonrpc: '2.0',
  id: 1,
  result: {
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: { name: 'facebook-mcp', version: '0.7.0' },
  },
});

const EXPECTED = { name: 'facebook-mcp', version: '0.7.0' };

test('initialize passes only with the expected identity and a tools capability', () => {
  assert.deepEqual(cs.checkInitialize(goodInit(), EXPECTED), []);

  const wrongVersion = goodInit();
  (wrongVersion['result'] as { serverInfo: Json }).serverInfo = {
    name: 'facebook-mcp',
    version: '0.0.0-dev',
  };
  assert.match(
    cs.checkInitialize(wrongVersion, EXPECTED).join('\n'),
    /serverInfo\.version/,
  );

  const noTools = goodInit();
  (noTools['result'] as { capabilities: Json }).capabilities = {};
  assert.match(cs.checkInitialize(noTools, EXPECTED).join('\n'), /tools capability/);

  assert.match(
    cs
      .checkInitialize({ id: 1, error: { code: -32600, message: 'bad' } }, EXPECTED)
      .join(''),
    /initialize returned an error/,
  );
  assert.match(cs.checkInitialize({ id: 1 }, EXPECTED).join(''), /no result/);
});

test('tools/list passes only with a non-empty set of named tools', () => {
  assert.deepEqual(
    cs.checkToolsList({ result: { tools: [{ name: 'facebook_whoami' }] } }),
    [],
  );
  assert.match(cs.checkToolsList({ result: { tools: [] } }).join(''), /empty tool set/);
  assert.match(cs.checkToolsList({ result: {} }).join(''), /no tools array/);
  assert.match(cs.checkToolsList({ result: { tools: [{}] } }).join(''), /have no name/);
  assert.match(cs.checkToolsList({ error: { code: 1 } }).join(''), /returned an error/);
});

test('the failure tail keeps the last non-empty lines', () => {
  assert.deepEqual(cs.tailLines('a\n\nb\r\nc\n', 2), ['b', 'c']);
});
