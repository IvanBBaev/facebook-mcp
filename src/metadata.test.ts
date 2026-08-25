// Metadata drift gate (R01).
//
// `scripts/gen-metadata.mjs` projects one SSOT onto every published artifact.
// A generator is only worth having if something fails when its output goes
// stale, so this file re-derives the same facts INDEPENDENTLY of the generator
// and asserts the artifacts on disk agree:
//
//   1. version — one version number, repeated in five places, must never fork;
//   2. environment — every FB_* variable the process actually reads (the server
//      via `src/core/settings.ts`, the setup subcommand via
//      `src/mcp/setup-token.ts`) must appear in `.env.example`, nothing may be
//      advertised there that nothing reads, and `server.json` — which tells a
//      client how to RUN the server — must carry the runtime set only. Names are
//      only half of it: the DEFAULTS and the enumerated CHOICES `.env.example`
//      prints are held against what `loadSettings` really resolves, so a
//      documented default cannot quietly become a lie (G2.3);
//   3. tools — the README table must list exactly the tools the package
//      factories register, with the tier the registry really enforces;
//   4. Node floor — the supported runtime version, restated in the launcher
//      guard, `.nvmrc`, the MCPB manifest and both workflows, must not fork.
//
// Deliberately no network, no token and no shelling out to git: the package
// factories are pure, so the tool inventory is obtained by calling them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PACKAGE_NAMES,
  loadSettings,
  type PackageSpec,
  type Settings,
  type ToolSpec,
} from './core/index.js';
import * as toolsIndex from './tools/index.js';

/** This file compiles to `build/metadata.test.js`, so the root is one level up. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const repoFile = (...parts: readonly string[]): string => join(REPO_ROOT, ...parts);

async function readText(...parts: readonly string[]): Promise<string> {
  return readFile(repoFile(...parts), 'utf8');
}

async function readJson(...parts: readonly string[]): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readText(...parts));
  assert.ok(
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
    `${parts.join('/')} is not a JSON object`,
  );
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Inventory — the same discovery the generator does, done independently
// ---------------------------------------------------------------------------

/**
 * Every `create<X>Package` export is a package factory. `core` takes options;
 * the others ignore the extra argument, so one call shape fits all of them.
 * Discovery is dynamic on purpose — a new package that nobody documents must
 * fail this file rather than slip past a hand-maintained list.
 */
function loadPackages(): readonly PackageSpec[] {
  const specs: PackageSpec[] = [];
  for (const [name, value] of Object.entries(toolsIndex as Record<string, unknown>)) {
    if (!/^create[A-Za-z0-9]*Package$/.test(name)) continue;
    if (typeof value !== 'function') continue;
    const factory = value as (opts: { serverVersion: string }) => PackageSpec;
    const spec = factory({ serverVersion: '0.0.0-test' });
    assert.ok(
      typeof spec.name === 'string' && Array.isArray(spec.tools),
      `${name}() did not return a PackageSpec`,
    );
    specs.push(spec);
  }
  assert.ok(specs.length > 0, 'no package factories found in src/tools/index.ts');
  return specs.sort(
    (a, b) =>
      PACKAGE_NAMES.indexOf(a.name as (typeof PACKAGE_NAMES)[number]) -
      PACKAGE_NAMES.indexOf(b.name as (typeof PACKAGE_NAMES)[number]),
  );
}

/** `read` for a read-only tool, otherwise the declared write tier. */
function tierOf(tool: ToolSpec): string {
  return tool.annotations?.readOnlyHint === true ? 'read' : (tool.writeTier ?? 'write');
}

// ---------------------------------------------------------------------------
// 1. Version
// ---------------------------------------------------------------------------

test('every generated artifact carries the package.json version', async () => {
  const pkg = await readJson('package.json');
  const version = pkg['version'];
  assert.equal(typeof version, 'string', 'package.json has no version');

  const server = await readJson('server.json');
  assert.equal(server['version'], version, 'server.json version drifted');

  const serverPackages = server['packages'];
  assert.ok(Array.isArray(serverPackages), 'server.json has no packages array');
  for (const entry of serverPackages as readonly Record<string, unknown>[]) {
    assert.equal(entry['version'], version, 'server.json packages[].version drifted');
  }

  const manifest = await readJson('manifest.json');
  assert.equal(manifest['version'], version, 'MCPB manifest version drifted');

  const plugin = await readJson('.claude-plugin', 'plugin.json');
  assert.equal(plugin['version'], version, '.claude-plugin/plugin.json version drifted');

  // The marketplace manifest states the version twice: once for the marketplace
  // and once for the single plugin entry inside it. Both are generated, so both
  // are asserted — a hand-edit that fixes only the outer one still ships a
  // plugin entry pointing at the wrong release.
  const marketplace = await readJson('.claude-plugin', 'marketplace.json');
  const marketplaceMeta = marketplace['metadata'] as Record<string, unknown> | undefined;
  assert.equal(
    marketplaceMeta?.['version'],
    version,
    '.claude-plugin/marketplace.json metadata.version drifted',
  );

  const marketplacePlugins = marketplace['plugins'];
  assert.ok(
    Array.isArray(marketplacePlugins) && marketplacePlugins.length > 0,
    '.claude-plugin/marketplace.json lists no plugins',
  );
  for (const entry of marketplacePlugins as readonly Record<string, unknown>[]) {
    assert.equal(
      entry['version'],
      version,
      '.claude-plugin/marketplace.json plugins[].version drifted',
    );
  }
});

test('the npm package identifier is the same everywhere', async () => {
  const pkg = await readJson('package.json');
  const name = pkg['name'];
  assert.equal(typeof name, 'string', 'package.json has no name');

  const server = await readJson('server.json');
  const serverPackages = server['packages'] as readonly Record<string, unknown>[];
  const npmEntry = serverPackages.find((entry) => entry['registryType'] === 'npm');
  assert.ok(npmEntry, 'server.json declares no npm package');
  assert.equal(npmEntry['identifier'], name, 'server.json npm identifier drifted');

  // `mcpName` is what npm publishes as proof of registry ownership; a mismatch
  // makes the first publish fail late, in CI, after the tag already exists.
  assert.equal(
    pkg['mcpName'],
    server['name'],
    'package.json mcpName drifted from server.json',
  );

  // `/plugin marketplace add IvanBBaev/facebook-mcp` resolves a plugin by the
  // name in the marketplace entry, which must therefore be the plugin's own
  // name; a mismatch installs nothing and reports no plugin found.
  const plugin = await readJson('.claude-plugin', 'plugin.json');
  const marketplace = await readJson('.claude-plugin', 'marketplace.json');
  const entries = marketplace['plugins'] as readonly Record<string, unknown>[];
  assert.ok(
    entries.some((entry) => entry['name'] === plugin['name']),
    'no marketplace entry names the plugin in .claude-plugin/plugin.json',
  );
});

// ---------------------------------------------------------------------------
// 2. Environment
// ---------------------------------------------------------------------------

/**
 * Names built at runtime from a user-chosen segment (`FB_PROFILE_<NAME>_PAGE_ID`)
 * cannot be enumerated, so `.env.example` documents them through one worked
 * example. Exempt that prefix rather than pretending the example is a real
 * variable the server looks up by that literal name.
 */
const DYNAMIC_ENV_PREFIX = 'FB_PROFILE_';

function envNames(source: string): ReadonlySet<string> {
  return new Set(source.match(/FB_[A-Z0-9_]+/g) ?? []);
}

/**
 * Variables the RUNNING server reads. `settings.ts` is the only place that
 * consults the environment at runtime, which is what makes this set the
 * authority for `server.json`.
 */
async function runtimeEnvNames(): Promise<ReadonlySet<string>> {
  return envNames(await readText('src', 'core', 'settings.ts'));
}

/**
 * Variables a SUBCOMMAND reads. `setup-token` accepts its short-lived token
 * through the environment precisely so it need not appear on a command line,
 * where `ps` and the shell history can see it — so it is a real, documented
 * variable even though `settings.ts` never looks it up.
 */
async function setupEnvNames(): Promise<ReadonlySet<string>> {
  return envNames(await readText('src', 'mcp', 'setup-token.ts'));
}

/** Everything the process reads anywhere: runtime ∪ setup-only. */
async function allEnvNames(): Promise<ReadonlySet<string>> {
  return new Set([...(await runtimeEnvNames()), ...(await setupEnvNames())]);
}

test('.env.example documents every environment variable the process reads', async () => {
  const known = await allEnvNames();
  const documented = envNames(await readText('.env.example'));

  // The dynamic prefix is exempt in BOTH directions. No literal `FB_PROFILE_*`
  // name is ever looked up — the source only ever mentions worked examples in
  // prose (`FB_PROFILE_DEFAULT_PAGE_ID`, `FB_PROFILE_ACME_PAGE_ID`), and this
  // scanner cannot tell a comment from a lookup. Demanding a `.env.example`
  // entry for each would document variables the server does not have.
  const missing = [...known]
    .filter((name) => !documented.has(name) && !name.startsWith(DYNAMIC_ENV_PREFIX))
    .sort();
  assert.deepEqual(
    missing,
    [],
    `variables read in src/ but absent from .env.example: ${missing.join(', ')}`,
  );
});

test('.env.example advertises nothing the server ignores', async () => {
  const known = await allEnvNames();
  const documented = envNames(await readText('.env.example'));

  const unknown = [...documented]
    .filter((name) => !known.has(name) && !name.startsWith(DYNAMIC_ENV_PREFIX))
    .sort();
  assert.deepEqual(
    unknown,
    [],
    `.env.example documents variables nothing in src/ reads: ${unknown.join(', ')}`,
  );
});

test('server.json declares only environment variables the server reads', async () => {
  const settings = await runtimeEnvNames();
  const server = await readJson('server.json');
  const packages = server['packages'] as readonly Record<string, unknown>[];

  for (const entry of packages) {
    const declared = (entry['environmentVariables'] ?? []) as readonly Record<
      string,
      unknown
    >[];
    for (const variable of declared) {
      const name = variable['name'];
      assert.equal(typeof name, 'string');
      assert.ok(
        settings.has(name as string) || (name as string).startsWith(DYNAMIC_ENV_PREFIX),
        `server.json declares ${String(name)}, which settings.ts never reads`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 2b. Environment — the documented VALUES, not just the names (G2.3)
// ---------------------------------------------------------------------------
//
// The tests above prove `.env.example` names the right variables. They say
// nothing about the text next to those names, and that text is what an operator
// actually acts on: `(default: 60000)` and `(one of: plan | apply)` are promises
// about behaviour. Both `.env.example` and the README table are projected from
// the same SSOT, so checking them against each other proves only that the
// generator ran; the only check worth having holds them against `loadSettings`.

/** One `#FB_X=` stanza of `.env.example`, with its leading comment block. */
interface EnvStanza {
  readonly name: string;
  /** Value printed after the `=`, or `''` when the line is a bare placeholder. */
  readonly example: string;
  /** Text of `(default: …)`, trimmed; `undefined` when no default is claimed. */
  readonly documentedDefault?: string;
  /** Values of `(one of: a | b)`; empty when the variable is not enumerated. */
  readonly documentedChoices: readonly string[];
}

/**
 * Parse `.env.example` into one stanza per variable. Each variable is a commented
 * assignment preceded by its own comment block, blocks being separated by blank
 * lines — so walking backwards from the assignment until a blank line or a `# ---`
 * rule collects exactly that variable's prose and no neighbour's.
 */
function parseEnvExample(source: string): readonly EnvStanza[] {
  const lines = source.split('\n');
  const stanzas: EnvStanza[] = [];

  lines.forEach((line, index) => {
    const assignment = /^#(FB_[A-Z0-9_<>]+)=(.*)$/.exec(line);
    if (!assignment) {
      return;
    }
    const prose: string[] = [];
    for (let i = index - 1; i >= 0; i -= 1) {
      const previous = lines[i] ?? '';
      if (previous.trim().length === 0 || previous.startsWith('# ---')) {
        break;
      }
      prose.unshift(previous.replace(/^#\s?/, ''));
    }
    const block = prose.join(' ');
    const defaultMatch = /\(default: ([^;)]+)/.exec(block);
    const choicesMatch = /one of: ([^)]+)\)/.exec(block);

    stanzas.push({
      name: assignment[1] ?? '',
      example: (assignment[2] ?? '').trim(),
      ...(defaultMatch ? { documentedDefault: (defaultMatch[1] ?? '').trim() } : {}),
      documentedChoices: choicesMatch
        ? (choicesMatch[1] ?? '')
            .split('|')
            .map((choice) => choice.trim())
            .filter((choice) => choice.length > 0)
        : [],
    });
  });

  return stanzas;
}

/** Resolve settings from an explicit env only — never `process.env`, never a file. */
function settingsFrom(env: NodeJS.ProcessEnv): Settings {
  return loadSettings({ env, loadEnvFile: false }).settings;
}

/**
 * Variables whose documented default is a LITERAL value, mapped to the field
 * `loadSettings` puts it in. `probe` is the env needed to make that field
 * resolvable at all — only `FB_HTTP_PORT` needs one, because the port is left
 * undefined unless the HTTP transport is actually selected.
 */
const LITERAL_DEFAULTS: readonly {
  readonly name: string;
  readonly read: (settings: Settings) => unknown;
  readonly probe?: NodeJS.ProcessEnv;
}[] = [
  { name: 'FB_API_VERSION', read: (s) => s.apiVersion },
  { name: 'FB_REQUEST_TIMEOUT_MS', read: (s) => s.requestTimeoutMs },
  { name: 'FB_HOST_CONCURRENCY', read: (s) => s.hostConcurrency },
  { name: 'FB_MAX_RESULT_CHARS', read: (s) => s.maxResultChars },
  { name: 'FB_WRITE_MODE', read: (s) => s.writeMode },
  { name: 'FB_TRANSPORT', read: (s) => s.transport },
  {
    name: 'FB_HTTP_PORT',
    read: (s) => s.httpPort,
    probe: { FB_TRANSPORT: 'http', FB_HTTP_TOKEN: 'placeholder-http-token' },
  },
  { name: 'FB_LOG_LEVEL', read: (s) => s.logLevel },
];

/**
 * Defaults documented as PROSE because no literal exists to print: the journal
 * path is derived per platform, and the tool-package default is a profile name
 * expanded elsewhere. They are exempt from the literal check by name, so a NEW
 * variable with a documented default cannot join them by accident.
 */
const PROSE_DEFAULTS: ReadonlySet<string> = new Set([
  'FB_JOURNAL_PATH',
  'FB_TOOL_PACKAGES',
]);

test('.env.example prints the defaults loadSettings actually resolves', async () => {
  const stanzas = parseEnvExample(await readText('.env.example'));
  const byName = new Map(stanzas.map((stanza) => [stanza.name, stanza]));

  for (const entry of LITERAL_DEFAULTS) {
    const stanza = byName.get(entry.name);
    assert.ok(stanza, `${entry.name} has no stanza in .env.example`);
    assert.ok(
      stanza.documentedDefault !== undefined,
      `${entry.name} documents no default, but its resolved value has one`,
    );

    const resolved = entry.read(settingsFrom({ ...entry.probe }));
    assert.equal(
      stanza.documentedDefault,
      String(resolved),
      `.env.example claims ${entry.name} defaults to ${String(stanza.documentedDefault)}, ` +
        `but loadSettings resolves ${String(resolved)}`,
    );

    // A commented-out example value that disagrees with the annotation above it
    // is worse than no example: uncommenting it silently changes behaviour.
    if (stanza.example.length > 0) {
      assert.equal(
        stanza.example,
        String(resolved),
        `${entry.name}'s example value ${stanza.example} is not its default ${String(resolved)}`,
      );
    }
  }
});

test('every documented default is either checked or a declared prose default', async () => {
  const checked = new Set(LITERAL_DEFAULTS.map((entry) => entry.name));

  const unchecked = parseEnvExample(await readText('.env.example'))
    .filter((stanza) => stanza.documentedDefault !== undefined)
    .map((stanza) => stanza.name)
    .filter((name) => !checked.has(name) && !PROSE_DEFAULTS.has(name))
    .sort();

  assert.deepEqual(
    unchecked,
    [],
    `.env.example documents defaults nothing verifies: ${unchecked.join(', ')}`,
  );
});

test('.env.example enumerates exactly the values loadSettings accepts', async () => {
  for (const stanza of parseEnvExample(await readText('.env.example'))) {
    if (stanza.documentedChoices.length === 0) {
      continue;
    }
    const entry = LITERAL_DEFAULTS.find((candidate) => candidate.name === stanza.name);
    assert.ok(
      entry,
      `${stanza.name} enumerates choices but has no default to fall back to`,
    );

    for (const choice of stanza.documentedChoices) {
      const resolved = entry.read(
        settingsFrom({ ...entry.probe, [stanza.name]: choice }),
      );
      assert.equal(
        resolved,
        choice,
        `.env.example offers ${stanza.name}=${choice}, which loadSettings does not accept`,
      );
    }

    // The converse: a value NOT on the list must be refused loudly and land on
    // the documented default, so an operator typo never widens what is enabled.
    const bogus = 'not-a-documented-choice';
    const result = loadSettings({
      env: { ...entry.probe, [stanza.name]: bogus },
      loadEnvFile: false,
    });
    assert.equal(
      entry.read(result.settings),
      stanza.documentedDefault,
      `${stanza.name}=${bogus} did not fall back to the documented default`,
    );
    assert.ok(
      result.report.errors.some((problem) => problem.field === stanza.name),
      `${stanza.name}=${bogus} was accepted without an error — an undocumented value passed`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Tools
// ---------------------------------------------------------------------------

interface DocumentedTool {
  readonly pkg: string;
  readonly tool: string;
  readonly tier: string;
}

/** Parse a generated README block into its table rows. */
function readmeToolRows(readme: string): readonly DocumentedTool[] {
  const block = /<!-- BEGIN GENERATED: tools -->([\s\S]*?)<!-- END GENERATED -->/.exec(
    readme,
  );
  assert.ok(block, 'README.md has no generated tools block');

  const rows: DocumentedTool[] = [];
  for (const line of (block[1] ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.slice(1, -1).split('|');
    const pkg = (cells[0] ?? '').trim().replace(/`/g, '');
    const tool = (cells[1] ?? '').trim().replace(/`/g, '');
    const tier = (cells[2] ?? '').trim().replace(/`/g, '');
    // Skip the header and the alignment separator.
    if (!tool.startsWith('facebook_')) continue;
    rows.push({ pkg, tool, tier });
  }
  assert.ok(rows.length > 0, 'the generated tools block has no rows');
  return rows;
}

test('the README tool table lists exactly the registered tools', async () => {
  const documented = readmeToolRows(await readText('README.md'));
  const registered = loadPackages().flatMap((pkg) =>
    pkg.tools.map((tool) => ({ pkg: pkg.name, tool: tool.name, tier: tierOf(tool) })),
  );

  const key = (row: DocumentedTool): string => `${row.pkg}/${row.tool}/${row.tier}`;
  assert.deepEqual(
    documented.map(key).sort(),
    registered.map(key).sort(),
    'README tool table drifted — run `npm run metadata`',
  );
});

test('the README package table matches the registered packages', async () => {
  const readme = await readText('README.md');
  const block = /<!-- BEGIN GENERATED: packages -->([\s\S]*?)<!-- END GENERATED -->/.exec(
    readme,
  );
  assert.ok(block, 'README.md has no generated packages block');

  for (const pkg of loadPackages()) {
    assert.match(
      block[1] ?? '',
      new RegExp(`\`${pkg.name}\``),
      `README package table omits ${pkg.name}`,
    );
  }
});

test('the MCPB manifest exposes the same tool names as the registry', async () => {
  const manifest = await readJson('manifest.json');
  const declared = manifest['tools'];
  assert.ok(Array.isArray(declared), 'manifest.json has no tools array');

  const names = (declared as readonly Record<string, unknown>[]).map(
    (entry) => entry['name'],
  );
  const registered = loadPackages().flatMap((pkg) => pkg.tools.map((tool) => tool.name));

  assert.deepEqual(
    [...names].sort(),
    [...registered].sort(),
    'MCPB manifest tool list drifted — run `npm run metadata`',
  );
});

// ---------------------------------------------------------------------------
// 4. Node floor
// ---------------------------------------------------------------------------
//
// The supported Node version is declared once in `scripts/metadata.config.mjs`
// and then restated in seven places that the generator does NOT all own — the
// launcher's guard, `.nvmrc`, and the CI/release workflows are hand-written.
// A floor that has forked is a slow failure: the package claims one thing,
// refuses at another, and CI proves a third. `package.json#engines` is taken as
// the reference here because it is the contract npm publishes.

/** The major version in a `>=NN` engine range, e.g. `'>=22'` -> `22`. */
function engineFloorMajor(range: string): number {
  const match = /^>=\s*(\d+)/.exec(range);
  assert.ok(match, `package.json engines.node "${range}" is not a ">=NN" range`);
  return Number(match[1]);
}

test('every surface declares the same Node floor', async () => {
  const pkg = await readJson('package.json');
  const engines = pkg['engines'] as Record<string, unknown> | undefined;
  const range = engines?.['node'];
  assert.equal(typeof range, 'string', 'package.json declares no engines.node');
  const floor = engineFloorMajor(range as string);

  // `.nvmrc` selects the version contributors and CI actually run.
  const nvmrc = (await readText('.nvmrc')).trim();
  assert.equal(
    Number(nvmrc.split('.')[0]),
    floor,
    `.nvmrc pins Node ${nvmrc}, but package.json requires >=${floor}`,
  );

  // The launcher refuses to boot below the floor. Its literal is hand-written,
  // so a bumped engines range with a stale guard silently keeps old runtimes.
  const launcher = await readText('bin', 'facebook-mcp.mjs');
  const guard = /major\s*<\s*(\d+)/.exec(launcher);
  assert.ok(guard, 'bin/facebook-mcp.mjs has no `major < NN` version guard');
  assert.equal(
    Number(guard[1]),
    floor,
    `the launcher guard refuses below Node ${guard[1]}, but the floor is ${floor}`,
  );
  assert.match(
    launcher,
    new RegExp(`requires Node\\.js >= ${floor}\\b`),
    `the launcher's error message does not name Node >= ${floor}`,
  );

  // The MCPB bundle states its own runtime requirement to the desktop host.
  const manifest = await readJson('manifest.json');
  const compatibility = manifest['compatibility'] as Record<string, unknown> | undefined;
  const runtimes = compatibility?.['runtimes'] as Record<string, unknown> | undefined;
  assert.equal(
    runtimes?.['node'],
    range,
    'manifest.json compatibility.runtimes.node drifted — run `npm run metadata`',
  );
});

test('CI and the release rail run the declared Node floor', async () => {
  const pkg = await readJson('package.json');
  const engines = pkg['engines'] as Record<string, unknown> | undefined;
  const floor = engineFloorMajor(String(engines?.['node']));

  // Regex rather than a YAML parser on purpose: this file must not acquire a
  // dependency to check a version number, and both shapes are stable.
  const ci = await readText('.github', 'workflows', 'ci.yml');
  const matrix = /node:\s*\[([^\]]+)\]/.exec(ci);
  assert.ok(matrix, 'ci.yml has no `node: [...]` matrix');
  const versions = String(matrix[1])
    .split(',')
    .map((entry) => Number(entry.trim().replace(/['"]/g, '').split('.')[0]));
  assert.ok(
    versions.includes(floor),
    `ci.yml tests Node ${versions.join(', ')} but never the floor (${floor}) — ` +
      'the oldest supported runtime is the one most likely to break',
  );

  const release = await readText('.github', 'workflows', 'release.yml');
  const nodeVersion = /NODE_VERSION:\s*'([^']+)'/.exec(release);
  assert.ok(nodeVersion, "release.yml has no NODE_VERSION: '…' constant");
  assert.equal(
    Number(String(nodeVersion[1]).split('.')[0]),
    floor,
    `release.yml builds on Node ${nodeVersion[1]}, but the floor is ${floor} — ` +
      'the published artifact must be built on the oldest runtime it claims to support',
  );
});
