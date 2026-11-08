#!/usr/bin/env node
// wire.mjs — the golden-snapshot plumbing of the contract tests (R10; review
// findings QA-01, ARC-06). See `test/contract/README.md`.
//
// It lives here rather than under `src/` for two reasons: nothing in it ships in
// the npm tarball, and it runs against ANY compiled tree, so the same code that
// checks today's build also records the baseline of an old tag:
//
//   node test/contract/wire.mjs --build <dir> --out <dir>
//
// The session is raw JSON-RPC over the SDK's in-memory transport, without the
// SDK `Client`: the client parses every response against its own schemas, and a
// key dropped by that parse is exactly the drift these goldens have to catch.
//
// No network, no credentials: a placeholder token and in-memory fakes.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { format, resolveConfig } from 'prettier';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where the goldens live. */
export const CONTRACT_DIR = join(REPO_ROOT, 'test', 'contract');

/** Golden name → the `FB_TOOL_PACKAGES` value it pins (absent ⇒ the default). */
export const TOOL_LIST_GOLDENS = { all: 'all', default: undefined };

/** Constant versions, so that a release never touches a golden. */
export const CONTRACT_VERSIONS = {
  serverVersion: '0.0.0-contract',
  sdkVersion: '0.0.0-contract',
};

const PACKAGE_FACTORY_RE = /^create[A-Za-z0-9]*Package$/;

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Whether this run rewrites the goldens. Refused in CI: a gate cannot pass itself. */
export function updateRequested(env = process.env) {
  if (env.UPDATE_CONTRACT !== '1') return false;
  if (env.CI) throw new Error('UPDATE_CONTRACT=1 is refused in CI: review a local diff');
  return true;
}

/** Sort object keys, recursively. Array order is part of the contract and stays. */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
  return sorted;
}

/** Read a golden, in canonical form; a missing one says how to create it. */
export function readGolden(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    const name = relative(REPO_ROOT, path);
    throw new Error(`no golden at ${name}; run UPDATE_CONTRACT=1 npm test`);
  }
  return canonicalize(JSON.parse(text));
}

/** Write a golden in canonical form, formatted the way `format:check` wants it. */
export async function writeGolden(path, value) {
  const text = JSON.stringify(canonicalize(value));
  mkdirSync(dirname(path), { recursive: true });
  // The repo's Prettier config, so `npm run format:check` agrees with the writer.
  const config = (await resolveConfig(path)) ?? {};
  writeFileSync(path, await format(text, { ...config, filepath: path, parser: 'json' }));
}

/**
 * Compare two tool lists by tool, so that a failure names what moved instead of
 * printing two 100 KB documents. Order counts: it is the order clients receive.
 */
export function diffToolLists(expected, actual) {
  const byName = (list) => new Map(list.map((tool) => [tool.name, tool]));
  const [was, now] = [byName(expected), byName(actual)];
  const kept = (list, other) => list.filter((n) => other.has(n));
  const [wasOrder, nowOrder] = [[...was.keys()], [...now.keys()]];
  return {
    added: nowOrder.filter((name) => !was.has(name)),
    removed: wasOrder.filter((name) => !now.has(name)),
    changed: kept(wasOrder, now).filter(
      (name) =>
        JSON.stringify(canonicalize(was.get(name))) !==
        JSON.stringify(canonicalize(now.get(name))),
    ),
    reordered:
      JSON.stringify(kept(wasOrder, now)) !== JSON.stringify(kept(nowOrder, was)),
  };
}

/** Connect to a built server and speak raw JSON-RPC to it. */
export async function openWire(server) {
  const [client, transport] = InMemoryTransport.createLinkedPair();
  const pending = new Map();
  let nextId = 0;

  client.onmessage = (message) => {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  await server.connect(transport);
  await client.start();

  const request = async (method, params) => {
    const id = ++nextId;
    const reply = new Promise((settle) => pending.set(id, settle));
    await client.send({ jsonrpc: '2.0', id, method, params });
    const { result, error } = await reply;
    if (error !== undefined) throw new Error(`${method}: ${JSON.stringify(error)}`);
    return result;
  };

  await request('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'facebook-mcp-contract', version: '0.0.0' },
  });
  await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  return { request, close: () => server.close() };
}

/** The `tools/list` answer of the compiled tree in `buildDir`, for one golden. */
export async function recordToolList(buildDir, name) {
  const load = (...parts) => import(pathToFileURL(join(buildDir, ...parts)).href);
  const [entry, toolsIndex, core, fakes] = await Promise.all([
    load('index.js'),
    load('tools', 'index.js'),
    load('core', 'index.js'),
    load('core', 'fakes', 'index.js'),
  ]);

  const packages = Object.entries(toolsIndex)
    .filter(([key, value]) => PACKAGE_FACTORY_RE.test(key) && typeof value === 'function')
    .map(([, factory]) => factory(CONTRACT_VERSIONS));
  const selection = TOOL_LIST_GOLDENS[name];
  const { settings } = core.loadSettings({
    env: {
      FB_ACCESS_TOKEN: 'placeholder-token',
      ...(selection === undefined ? {} : { FB_TOOL_PACKAGES: selection }),
    },
    loadEnvFile: false,
  });
  const clock = fakes.createFakeClock(0);
  const wire = await openWire(
    entry.buildServer({
      settings,
      packages,
      serverVersion: CONTRACT_VERSIONS.serverVersion,
      clock,
      logger: silentLogger,
      redactor: fakes.createFakeRedactor({ secrets: [] }),
      journal: fakes.createMemoryJournal(clock),
      fbRequest: fakes.createFakeFbRequest().fn,
      pages: fakes.createFakePageResolver(),
    }),
  );
  try {
    return await wire.request('tools/list', {});
  } finally {
    await wire.close();
  }
}

async function main() {
  const { values } = parseArgs({
    options: { build: { type: 'string' }, out: { type: 'string' } },
  });
  if (values.build === undefined || values.out === undefined) {
    process.stderr.write(
      'usage: node test/contract/wire.mjs --build <dir> --out <dir>\n',
    );
    process.exit(2);
  }
  for (const name of Object.keys(TOOL_LIST_GOLDENS)) {
    const answer = await recordToolList(resolve(values.build), name);
    await writeGolden(join(resolve(values.out), `tools-list.${name}.json`), answer);
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
