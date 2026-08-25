#!/usr/bin/env node
// Project the metadata SSOT (`scripts/metadata.config.mjs`) onto every artifact
// that repeats it (task R01).
//
// Nine files describe the same server to nine different consumers. Left to hand
// editing they drift, and the drift is only discovered by whoever installs the
// stale one. So exactly one of them is written by a human — the SSOT — and this
// script derives the rest:
//
//   package.json           metadata fields only (never scripts/dependencies)
//   server.json            official MCP registry manifest
//   manifest.json          MCPB bundle manifest (Claude Desktop double-click)
//   .claude-plugin/plugin.json
//   .claude-plugin/marketplace.json
//   .env.example           operator-facing env template
//   README.md              the `<!-- BEGIN GENERATED: … -->` blocks
//
// The tool inventory is not written down anywhere in the SSOT: it is read from
// the COMPILED server (`build/tools/index.js`) by instantiating every package
// factory, so the documented surface is by construction the registered surface.
// That is why a build is required — the script says so instead of guessing.
//
// Usage:
//   node scripts/gen-metadata.mjs --write   # regenerate in place
//   node scripts/gen-metadata.mjs --check   # exit 1 + diff if anything drifted
//
// `--check` runs in CI after `npm run check`. `src/metadata.test.ts` covers the
// invariants that must hold even if this script is never run again.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { dynamicEnv, env as ENV, identity } from './metadata.config.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Thrown for expected, operator-actionable failures: reported without a stack. */
class GenError extends Error {}

const USAGE = `gen-metadata — project the metadata SSOT onto the generated artifacts

Usage:
  node scripts/gen-metadata.mjs --write
  node scripts/gen-metadata.mjs --check

Options:
  --write   Rewrite every generated artifact in place.
  --check   Verify only. Prints a diff per drifted file and exits 1.
  --help    Show this help.

Requires a build (\`npm run build\`): the tool tables are derived from the
compiled package factories, never from a hand-maintained list.`;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const repoPath = (...parts) => join(REPO_ROOT, ...parts);
const displayPath = (abs) => relative(REPO_ROOT, abs).split(sep).join('/');

function readTextIfPresent(abs) {
  return existsSync(abs) ? readFileSync(abs, 'utf8') : undefined;
}

/** Escape a value for a single markdown table cell. */
function cell(text) {
  return String(text).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

// Sentence-final periods only: not the dot inside a common abbreviation, and
// not one of the dots of an ellipsis.
const ABBREVIATION_TAIL = /(?:\be\.g|\bi\.e|\betc|\bvs|\bcf|\bInc|\bNo|\.\.)$/i;
const PURPOSE_MAX_CHARS = 170;

/** The first sentence of a tool description, trimmed to one table-friendly line. */
function firstSentence(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  let sentence = flat;
  const dot = /\.(?=\s)/g;
  let match;
  while ((match = dot.exec(flat)) !== null) {
    const head = flat.slice(0, match.index);
    if (ABBREVIATION_TAIL.test(head)) continue;
    sentence = `${head}.`;
    break;
  }
  if (sentence.length <= PURPOSE_MAX_CHARS) return sentence;
  const cut = sentence.lastIndexOf(' ', PURPOSE_MAX_CHARS - 1);
  return `${sentence.slice(0, cut > 0 ? cut : PURPOSE_MAX_CHARS - 1).replace(/[,;:.]$/, '')}…`;
}

/** Render rows as a GitHub-flavoured markdown table (prettier re-aligns it). */
function table(headers, aligns, rows) {
  const sep = aligns.map((a) =>
    a === 'center' ? ':---:' : a === 'right' ? '---:' : '---',
  );
  return [headers, sep, ...rows].map((r) => `| ${r.join(' | ')} |`).join('\n');
}

// ---------------------------------------------------------------------------
// Inventory — read from the compiled server, never hand-maintained
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{packages: object[], toolPermissions: Record<string, readonly string[]>,
 *   packagePermissions: Record<string, readonly string[]>, defaultPackages: readonly string[]}>}
 */
async function loadInventory() {
  const toolsEntry = repoPath('build', 'tools', 'index.js');
  if (!existsSync(toolsEntry)) {
    throw new GenError(
      'build/tools/index.js is missing — run `npm run build` first. The tool ' +
        'tables are derived from the compiled package factories, so this script ' +
        'cannot run against source alone.',
    );
  }

  const tools = await import(pathToFileURL(toolsEntry).href);
  const doctor = await import(pathToFileURL(repoPath('build', 'mcp', 'doctor.js')).href);
  const packagesMod = await import(
    pathToFileURL(repoPath('build', 'mcp', 'packages.js')).href
  );
  const types = await import(pathToFileURL(repoPath('build', 'core', 'types.js')).href);

  // Every `create<X>Package` export is a package factory. Core takes options;
  // the rest ignore the extra argument, so one call shape fits all of them.
  const specs = [];
  for (const [name, value] of Object.entries(tools)) {
    if (!/^create[A-Za-z0-9]*Package$/.test(name)) continue;
    if (typeof value !== 'function') continue;
    const spec = value({ serverVersion: identity.version });
    if (!spec || typeof spec.name !== 'string' || !Array.isArray(spec.tools)) {
      throw new GenError(`${name}() did not return a PackageSpec.`);
    }
    specs.push(spec);
  }
  if (specs.length === 0) {
    throw new GenError('no package factories found in build/tools/index.js.');
  }

  const order = types.PACKAGE_NAMES;
  specs.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));

  return {
    packages: specs,
    toolPermissions: doctor.TOOL_PERMISSIONS,
    packagePermissions: doctor.PACKAGE_PERMISSIONS,
    defaultPackages: packagesMod.DEFAULT_PROFILE_PACKAGES,
  };
}

/** `read` for a read-only tool, otherwise the declared write tier. */
function tierOf(tool) {
  return tool.annotations?.readOnlyHint === true ? 'read' : (tool.writeTier ?? 'write');
}

// ---------------------------------------------------------------------------
// Generators — JSON artifacts
// ---------------------------------------------------------------------------

const authorString = `${identity.author.name} <${identity.author.email}>`;
const gitUrl = `git+${identity.repository}.git`;

/** Patch ONLY the metadata fields of package.json; scripts/deps are not ours. */
function generatePackageJson(currentText) {
  if (currentText === undefined) throw new GenError('package.json is missing.');
  const pkg = JSON.parse(currentText);

  pkg.name = identity.packageName;
  pkg.version = identity.version;
  pkg.mcpName = identity.mcpName;
  pkg.description = identity.description;
  pkg.license = identity.license;
  pkg.author = authorString;
  pkg.repository = { type: 'git', url: gitUrl };
  pkg.homepage = identity.homepage;
  pkg.bugs = { url: identity.issues };
  pkg.engines = { ...pkg.engines, node: identity.nodeEngine };
  pkg.keywords = [...identity.keywords];
  pkg.trademark = identity.trademark;

  // The binary name comes from the SSOT; its target path does not.
  const binTarget = Object.values(pkg.bin ?? {})[0] ?? `./bin/${identity.shortName}.mjs`;
  pkg.bin = { [identity.shortName]: binTarget };

  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/**
 * The `default` of a variable as a MACHINE-READABLE value, or `undefined` when
 * the config documents the default in prose instead of quoting it.
 *
 * Installers pre-fill these fields, and the operator normally accepts what they
 * see: shipping `"core profile (all packages except \`ads\`)"` as the default of
 * `FB_TOOL_PACKAGES` hands them a config the server refuses to start with. The
 * flag is explicit rather than inferred from `format`, so a new prose default
 * cannot slip through by having a format nobody thought to exclude.
 */
function machineDefault(v) {
  if (v.default === undefined || v.defaultIsProse === true) return undefined;
  return v.default;
}

/** Official MCP registry manifest. */
function generateServerJson() {
  // Setup-only variables are deliberately absent: server.json describes how a
  // client RUNS the server, and a client that prompts for a value the running
  // process never reads is asking the operator for a secret it cannot use.
  const environmentVariables = ENV.filter((v) => !v.setupOnly).map((v) => ({
    name: v.name,
    description: v.description,
    // No variable here is unconditionally required: `one-of` means "any ONE of
    // these three tokens", and `http` means "only when FB_TRANSPORT=http".
    // Projecting either as `isRequired` makes a registry client demand all three
    // credentials before it will save the config — two of which most operators
    // cannot even obtain. The prose in `description` carries the real rule.
    isRequired: false,
    ...(v.secret ? { isSecret: true } : {}),
    format: v.format,
    ...(machineDefault(v) !== undefined ? { default: machineDefault(v) } : {}),
    ...(v.choices ? { choices: [...v.choices] } : {}),
  }));

  return `${JSON.stringify(
    {
      $schema:
        'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
      name: identity.mcpName,
      description: identity.shortDescription,
      repository: { url: identity.repository, source: 'github' },
      version: identity.version,
      websiteUrl: identity.documentation,
      packages: [
        {
          registryType: 'npm',
          identifier: identity.packageName,
          version: identity.version,
          transport: { type: 'stdio' },
          environmentVariables,
        },
      ],
    },
    null,
    2,
  )}\n`;
}

/** MCPB bundle manifest (Claude Desktop installs this by double-click). */
function generateManifestJson(inventory) {
  const exposed = ENV.filter((v) => v.userConfig !== undefined);

  const userConfig = {};
  const serverEnv = {};
  for (const v of exposed) {
    const isDirectory = v.format === 'filepath';
    userConfig[v.userConfig] = {
      type: isDirectory ? 'directory' : 'string',
      title: v.userConfigTitle ?? v.name,
      description: v.description,
      required: false,
      ...(v.secret ? { sensitive: true } : {}),
      // `machineDefault` — Claude Desktop shows this field pre-filled and the
      // operator accepts what they see, so a prose default would be saved as if it
      // were a value. The `isDirectory` guard stays: a directory picker has nowhere
      // sensible to put a default anyway.
      ...(machineDefault(v) !== undefined && !isDirectory
        ? { default: machineDefault(v) }
        : {}),
    };
    serverEnv[v.name] = `\${user_config.${v.userConfig}}`;
  }

  const tools = inventory.packages.flatMap((pkg) =>
    pkg.tools.map((tool) => ({
      name: tool.name,
      description: firstSentence(tool.description),
    })),
  );

  return `${JSON.stringify(
    {
      manifest_version: '0.2',
      name: identity.shortName,
      display_name: identity.displayName,
      version: identity.version,
      description: identity.shortDescription,
      long_description: identity.description,
      author: {
        name: identity.author.name,
        email: identity.author.email,
        url: identity.author.url,
      },
      homepage: identity.homepage,
      documentation: identity.documentation,
      support: identity.issues,
      license: identity.license,
      keywords: [...identity.keywords],
      repository: { type: 'git', url: identity.repository },
      server: {
        type: 'node',
        entry_point: 'build/index.js',
        mcp_config: {
          command: 'node',
          args: ['${__dirname}/build/index.js'],
          env: serverEnv,
        },
      },
      tools_generated: false,
      tools,
      user_config: userConfig,
      compatibility: {
        platforms: ['darwin', 'linux', 'win32'],
        runtimes: { node: identity.nodeEngine },
      },
    },
    null,
    2,
  )}\n`;
}

/** Claude Code plugin manifest. */
function generatePluginJson() {
  return `${JSON.stringify(
    {
      name: identity.shortName,
      displayName: identity.displayName,
      version: identity.version,
      description: identity.description,
      author: { name: identity.author.name, url: identity.author.url },
      homepage: identity.documentation,
      repository: identity.repository,
      license: identity.license,
      keywords: identity.keywords.filter((k) => k !== 'model-context-protocol'),
      mcpServers: {
        [identity.serverKey]: {
          command: 'npx',
          args: ['-y', identity.packageName],
        },
      },
    },
    null,
    2,
  )}\n`;
}

/** Claude Code marketplace manifest (this repository is its own marketplace). */
function generateMarketplaceJson() {
  const slug = identity.repository.replace('https://github.com/', '');
  return `${JSON.stringify(
    {
      name: identity.shortName,
      owner: { name: identity.author.name, url: identity.author.url },
      metadata: { description: identity.shortDescription, version: identity.version },
      plugins: [
        {
          name: identity.shortName,
          source: './',
          version: identity.version,
          description: `${identity.shortDescription}. Add with: /plugin marketplace add ${slug}`,
        },
      ],
    },
    null,
    2,
  )}\n`;
}

// ---------------------------------------------------------------------------
// Generators — .env.example
// ---------------------------------------------------------------------------

/** Wrap a comment body at 78 columns with a `# ` prefix. */
function commentBlock(text, prefix = '# ') {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line === '') line = word;
    else if (`${line} ${word}`.length + prefix.length <= 78) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  return lines.map((l) => `${prefix}${l}`).join('\n');
}

function generateEnvExample() {
  const out = [
    '# facebook-mcp — environment template.',
    '#',
    '# GENERATED FILE — edit scripts/metadata.config.mjs and run `npm run metadata`.',
    '#',
    '# Copy to `.env` (git-ignored) or export these in your MCP client config.',
    '# Real environment variables always win over the env file.',
    '# Every variable is optional except where noted; leave a line commented out',
    '# to take the documented default.',
    '',
  ];

  let group;
  for (const v of ENV) {
    if (v.group !== group) {
      group = v.group;
      out.push(
        `# ---------------------------------------------------------------------------`,
        `# ${group}`,
        `# ---------------------------------------------------------------------------`,
        '',
      );
    }
    out.push(commentBlock(v.description));
    const notes = [];
    if (v.required === 'one-of') notes.push('required: at least one token');
    if (v.required === 'http') notes.push('required when FB_TRANSPORT=http');
    if (v.secret) notes.push('secret — never logged or returned by a tool');
    if (v.default !== undefined) notes.push(`default: ${v.default}`);
    if (v.choices) notes.push(`one of: ${v.choices.join(' | ')}`);
    if (notes.length > 0) out.push(`# (${notes.join('; ')})`);
    out.push(`#${v.name}=${v.example ?? ''}`, '');
  }

  out.push(
    `# ---------------------------------------------------------------------------`,
    '# Named profiles (dynamic — one pair per Page you address by name)',
    `# ---------------------------------------------------------------------------`,
    '',
  );
  for (const v of dynamicEnv) {
    out.push(commentBlock(v.description));
    if (v.secret) out.push('# (secret — never logged or returned by a tool)');
    out.push(`#${v.pattern}=`, '');
  }

  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

// ---------------------------------------------------------------------------
// Generators — README blocks
// ---------------------------------------------------------------------------

function renderToolsBlock(inventory) {
  const lines = [];
  const total = inventory.packages.reduce((n, p) => n + p.tools.length, 0);
  const onByDefault = inventory.packages.filter((p) => p.enabledByDefault).length;

  lines.push(
    `**${total} tools in ${inventory.packages.length} packages.** ` +
      `${onByDefault} packages are on by default; the rest are opt-in via ` +
      '`FB_TOOL_PACKAGES`. Tier `read` never mutates. `reversible` writes are ' +
      'gated by `FB_WRITE_MODE`; `irreversible` and `spend` additionally require ' +
      'a per-call `apply` plus the `plan_id` of a preview you just ran, and are ' +
      'never unlocked by an environment variable alone.',
    '',
    table(
      ['Package', 'Tool', 'Tier', 'Purpose'],
      ['left', 'left', 'center', 'left'],
      inventory.packages.flatMap((pkg) =>
        pkg.tools.map((tool) => [
          `\`${pkg.name}\``,
          `\`${tool.name}\``,
          `\`${tierOf(tool)}\``,
          cell(firstSentence(tool.description)),
        ]),
      ),
    ),
  );
  return lines.join('\n');
}

function renderPackagesBlock(inventory) {
  const rows = inventory.packages.map((pkg) => {
    const reads = pkg.tools.filter((t) => tierOf(t) === 'read').length;
    const writes = pkg.tools.length - reads;
    return [
      `\`${pkg.name}\``,
      pkg.enabledByDefault ? 'yes' : '**no** (opt-in)',
      `${reads} read${writes > 0 ? ` + ${writes} write` : ''}`,
      pkg.writeModeDefault === undefined ? '—' : `\`${pkg.writeModeDefault}\``,
      cell(pkg.description ?? ''),
    ];
  });
  return table(
    ['Package', 'On by default', 'Tools', 'Default write mode', 'What it covers'],
    ['left', 'center', 'left', 'center', 'left'],
    rows,
  );
}

function renderScopesBlock(inventory) {
  const { packagePermissions, toolPermissions } = inventory;

  const packageRows = inventory.packages.map((pkg) => {
    const perms = packagePermissions[pkg.name] ?? [];
    return [
      `\`${pkg.name}\``,
      perms.length === 0 ? '_(not mapped)_' : perms.map((p) => `\`${p}\``).join('<br>'),
    ];
  });

  const toolRows = inventory.packages.flatMap((pkg) =>
    pkg.tools.map((tool) => {
      const own = toolPermissions[tool.name];
      const effective = own ?? packagePermissions[pkg.name] ?? [];
      const rendered =
        effective.length === 0
          ? '_(none — the token itself is enough)_'
          : effective.map((p) => `\`${p}\``).join(', ');
      return [
        `\`${tool.name}\``,
        own === undefined ? `${rendered} _(inherited)_` : rendered,
      ];
    }),
  );

  return [
    'Grant only what the packages you actually enable require. The scopes below',
    'are the ones this server asks for; `node build/index.js doctor` compares them',
    'against what your token really has and prints a per-package usable / partial /',
    'blocked matrix. `business_management` is deliberately **not** in this list — it',
    'is a setup-only permission that should never ride on a runtime token.',
    '',
    table(['Package', 'Required Graph permissions'], ['left', 'left'], packageRows),
    '',
    '<details>',
    '<summary>Per-tool scopes (a tool marked <em>inherited</em> has no finer mapping and falls back to its package set)</summary>',
    '',
    table(['Tool', 'Required Graph permissions'], ['left', 'left'], toolRows),
    '',
    '</details>',
  ].join('\n');
}

function renderEnvBlock() {
  const rows = [];
  for (const v of ENV) {
    const required =
      v.required === 'one-of' ? 'one of¹' : v.required === 'http' ? 'if http' : 'no';
    rows.push([
      `\`${v.name}\``,
      required,
      // A prose default is a sentence, not a literal — code-fencing it both lies
      // about it being copy-pasteable and breaks the row when the sentence itself
      // contains backticks.
      v.default === undefined
        ? '—'
        : v.defaultIsProse
          ? cell(v.default)
          : `\`${v.default}\``,
      cell(v.summary),
    ]);
  }
  for (const v of dynamicEnv) {
    rows.push([
      `\`${v.pattern}\``,
      'no',
      '—',
      cell(`${v.secret ? '**Secret.** ' : ''}${firstSentence(v.description)}`),
    ]);
  }
  return [
    table(
      ['Variable', 'Required', 'Default', 'Description'],
      ['left', 'center', 'center', 'left'],
      rows,
    ),
    '',
    '¹ Provide at least one of `FB_SYSTEM_TOKEN`, `FB_ACCESS_TOKEN` or `FB_PAGE_TOKEN`.',
    'A full, commented template lives in [`.env.example`](.env.example).',
  ].join('\n');
}

/** Replace the body of every `<!-- BEGIN GENERATED: id -->` block. */
function spliceReadme(currentText, blocks) {
  if (currentText === undefined) throw new GenError('README.md is missing.');
  let out = currentText;
  for (const [id, body] of Object.entries(blocks)) {
    const begin = `<!-- BEGIN GENERATED: ${id} -->`;
    const end = '<!-- END GENERATED -->';
    const start = out.indexOf(begin);
    if (start === -1) {
      throw new GenError(
        `README.md has no \`${begin}\` marker. Add the marker pair around the ` +
          'section this generator owns.',
      );
    }
    const stop = out.indexOf(end, start);
    if (stop === -1) {
      throw new GenError(`README.md: \`${begin}\` is never closed by \`${end}\`.`);
    }
    out = `${out.slice(0, start + begin.length)}\n\n${body}\n\n${out.slice(stop)}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Diff (compact, generated-file oriented: trim the common head and tail)
// ---------------------------------------------------------------------------

function diff(expected, actual, label) {
  const a = actual.split('\n');
  const b = expected.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  const MAX = 40;
  const clip = (lines, mark) => [
    ...lines.slice(0, MAX).map((l) => `${mark}${l}`),
    ...(lines.length > MAX ? [`${mark}… ${lines.length - MAX} more line(s)`] : []),
  ];
  return [
    `--- ${label} (on disk)`,
    `+++ ${label} (generated)`,
    `@@ line ${head + 1} @@`,
    ...clip(removed, '-'),
    ...clip(added, '+'),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function buildTargets() {
  const inventory = await loadInventory();
  const prettier = await import('prettier');

  /** Format with the repository's prettier config so `format:check` stays green. */
  const pretty = async (text, filePath) => {
    const config = await prettier.resolveConfig(filePath);
    return prettier.format(text, { ...config, filepath: filePath });
  };

  const readmePath = repoPath('README.md');
  const readmeCurrent = readTextIfPresent(readmePath);

  const targets = [
    {
      path: repoPath('package.json'),
      text: generatePackageJson(readTextIfPresent(repoPath('package.json'))),
      format: true,
    },
    { path: repoPath('server.json'), text: generateServerJson(), format: true },
    {
      path: repoPath('manifest.json'),
      text: generateManifestJson(inventory),
      format: true,
    },
    {
      path: repoPath('.claude-plugin', 'plugin.json'),
      text: generatePluginJson(),
      format: true,
    },
    {
      path: repoPath('.claude-plugin', 'marketplace.json'),
      text: generateMarketplaceJson(),
      format: true,
    },
    { path: repoPath('.env.example'), text: generateEnvExample(), format: false },
    {
      path: readmePath,
      text: spliceReadme(readmeCurrent, {
        packages: renderPackagesBlock(inventory),
        tools: renderToolsBlock(inventory),
        scopes: renderScopesBlock(inventory),
        env: renderEnvBlock(),
      }),
      format: true,
    },
  ];

  for (const target of targets) {
    if (target.format) target.text = await pretty(target.text, target.path);
  }
  return targets;
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      write: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });

  if (values.help || (!values.write && !values.check)) {
    process.stdout.write(`${USAGE}\n`);
    return values.help ? 0 : 2;
  }
  if (values.write && values.check) {
    throw new GenError('--write and --check are mutually exclusive.');
  }

  const targets = await buildTargets();
  const drifted = [];
  for (const target of targets) {
    const current = readTextIfPresent(target.path);
    if (current === target.text) continue;
    drifted.push({ ...target, current });
  }

  if (values.check) {
    if (drifted.length === 0) {
      process.stdout.write(`gen-metadata: ${targets.length} artifact(s) up to date.\n`);
      return 0;
    }
    for (const target of drifted) {
      const label = displayPath(target.path);
      process.stdout.write(`${diff(target.text, target.current ?? '', label)}\n\n`);
    }
    process.stderr.write(
      `gen-metadata: ${drifted.length} file(s) drifted from the SSOT. ` +
        'Run `npm run metadata` and commit the result.\n',
    );
    return 1;
  }

  for (const target of drifted) {
    writeFileSync(target.path, target.text);
    process.stdout.write(`updated ${displayPath(target.path)}\n`);
  }
  process.stdout.write(
    drifted.length === 0
      ? `gen-metadata: ${targets.length} artifact(s) already up to date.\n`
      : `gen-metadata: rewrote ${drifted.length} of ${targets.length} artifact(s).\n`,
  );
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof GenError) {
    process.stderr.write(`gen-metadata: ${error.message}\n`);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
