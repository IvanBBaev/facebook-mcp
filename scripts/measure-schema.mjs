#!/usr/bin/env node
// measure-schema.mjs — measure the `tools/list` surface per profile and keep it
// under a ratcheting byte ceiling (R13; review finding AUX-01, decision OD-4).
//
// Purpose
//   Every tool definition a client loads costs context on every uncached turn.
//   This script measures exactly what the server advertises: for each named
//   profile it builds the real registry from the compiled packages, converts the
//   resolved specs with the same `toMcpTool` the `tools/list` handler uses, and
//   counts the UTF-8 bytes of the compact JSON `{ "tools": [...] }` payload.
//
// The budget (`scripts/schema-budget.json`)
//   - `ceilings`: the recorded size per profile. A profile that grows past its
//     ceiling fails `src/schema-budget.test.ts`. Raising a ceiling is deliberate:
//     `--write --allow-growth`, with the reason in the commit message.
//   - `slack`: a profile that shrinks more than this many bytes below its ceiling
//     also fails the test until `--write` locks the gain in. The ceiling only
//     moves down on its own; that is the ratchet.
//   - `targets`: the OD-4 goals (default <= 90 KB, `all` <= 110 KB, personas
//     <= 40 KB, KB = 1000 B). Reported as the remaining gap; they never fail.
//
// Usage (needs `npm run build` first)
//   node scripts/measure-schema.mjs                 table: size, ceiling, target
//   node scripts/measure-schema.mjs --json          the measurement as JSON
//   node scripts/measure-schema.mjs --check         exit 1 on a budget violation
//   node scripts/measure-schema.mjs --write         lower the ceilings to the
//                                                   measured sizes
//   node scripts/measure-schema.mjs --write --allow-growth
//                                                   also raise grown ceilings
//
// No network, no credentials: the settings get a placeholder token and the
// registry is assembled without any Graph I/O.
//
// Exit codes: 0 ok, 1 budget violation or refused write, 2 usage error.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The budget file the test and `--write` share. */
export const BUDGET_PATH = join(REPO_ROOT, 'scripts', 'schema-budget.json');

const PACKAGE_FACTORY_RE = /^create[A-Za-z0-9]*Package$/;

/** Bytes of a value as compact JSON, the way it travels on the wire. */
function jsonBytes(value) {
  return value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Measure every named profile against the compiled build.
 *
 * Packages are discovered from the `create<X>Package` exports of the tools
 * barrel, so a new package is measured without editing this script.
 *
 * @param {string} [buildDir] Compiled output; defaults to `<repo>/build`.
 * @returns {Promise<Array<{profile: string, tools: number, bytes: number,
 *   descriptionBytes: number, inputSchemaBytes: number, outputSchemaBytes: number}>>}
 */
export async function measureProfiles(buildDir = join(REPO_ROOT, 'build')) {
  const load = (...parts) => import(pathToFileURL(join(buildDir, ...parts)).href);
  const [toolsIndex, mcp, core, schema] = await Promise.all([
    load('tools', 'index.js'),
    load('mcp', 'index.js'),
    load('core', 'index.js'),
    load('server', 'schema.js'),
  ]);

  const packages = Object.entries(toolsIndex)
    .filter(
      ([name, value]) => PACKAGE_FACTORY_RE.test(name) && typeof value === 'function',
    )
    .map(([, factory]) => factory({ serverVersion: '0.0.0', sdkVersion: '0.0.0' }));
  if (packages.length === 0) throw new Error(`no package factories found in ${buildDir}`);

  return Object.keys(mcp.PROFILES).map((profile) => {
    const { settings } = core.loadSettings({
      env: { FB_ACCESS_TOKEN: 'placeholder-token', FB_TOOL_PACKAGES: profile },
      loadEnvFile: false,
    });
    const tools = mcp.createRegistry(packages, settings).tools.map(schema.toMcpTool);
    return {
      profile,
      tools: tools.length,
      bytes: jsonBytes({ tools }),
      descriptionBytes: tools.reduce((n, t) => n + jsonBytes(t.description), 0),
      inputSchemaBytes: tools.reduce((n, t) => n + jsonBytes(t.inputSchema), 0),
      outputSchemaBytes: tools.reduce((n, t) => n + jsonBytes(t.outputSchema), 0),
    };
  });
}

/** Read and minimally validate the budget file. */
export function readBudget(path = BUDGET_PATH) {
  const budget = JSON.parse(readFileSync(path, 'utf8'));
  for (const key of ['ceilings', 'targets']) {
    if (budget[key] === null || typeof budget[key] !== 'object') {
      throw new Error(`${path}: "${key}" must be an object of profile -> bytes`);
    }
  }
  if (!Number.isInteger(budget.slack) || budget.slack < 0) {
    throw new Error(`${path}: "slack" must be a non-negative integer`);
  }
  return budget;
}

/**
 * Compare a measurement with the budget. Pure; the test and `--check` use it.
 *
 * @returns {{ grown: Array<{profile: string, bytes: number, ceiling: number}>,
 *   tighten: Array<{profile: string, bytes: number, ceiling: number}>,
 *   unbudgeted: string[], stale: string[],
 *   gaps: Array<{profile: string, bytes: number, target: number, over: number}> }}
 */
export function checkBudget(measured, budget) {
  const names = new Set(measured.map((m) => m.profile));
  const result = {
    grown: [],
    tighten: [],
    unbudgeted: [],
    stale: Object.keys(budget.ceilings).filter((p) => !names.has(p)),
    gaps: [],
  };
  for (const { profile, bytes } of measured) {
    const ceiling = budget.ceilings[profile];
    const target = budget.targets[profile];
    if (!Number.isInteger(ceiling) || !Number.isInteger(target)) {
      result.unbudgeted.push(profile);
      continue;
    }
    if (bytes > ceiling) result.grown.push({ profile, bytes, ceiling });
    else if (ceiling - bytes > budget.slack)
      result.tighten.push({ profile, bytes, ceiling });
    result.gaps.push({ profile, bytes, target, over: Math.max(0, bytes - target) });
  }
  return result;
}

/**
 * The budget with ceilings moved to the measurement. Lowering is always
 * allowed; raising needs `allowGrowth`. A profile without a target is refused:
 * a new profile needs its OD-4 target written by hand first.
 *
 * @throws Error naming the profiles that would grow, or lack a target.
 */
export function ratchetBudget(measured, budget, { allowGrowth = false } = {}) {
  const untargeted = measured.filter((m) => !Number.isInteger(budget.targets[m.profile]));
  if (untargeted.length > 0) {
    throw new Error(
      `no target for profile(s) ${untargeted.map((m) => m.profile).join(', ')}: add it to "targets" in schema-budget.json first`,
    );
  }
  const grown = measured.filter(
    (m) =>
      Number.isInteger(budget.ceilings[m.profile]) &&
      m.bytes > budget.ceilings[m.profile],
  );
  if (grown.length > 0 && !allowGrowth) {
    throw new Error(
      `refusing to raise the ceiling of ${grown
        .map((m) => `${m.profile} (${budget.ceilings[m.profile]} -> ${m.bytes} B)`)
        .join(', ')}; pass --allow-growth and give the reason in the commit message`,
    );
  }
  const ceilings = Object.fromEntries(measured.map((m) => [m.profile, m.bytes]));
  return { ...budget, ceilings };
}

/** Human-readable violations, one line each; empty when the budget holds. */
export function describeViolations(check) {
  const lines = [];
  for (const g of check.grown) {
    lines.push(
      `${g.profile}: ${g.bytes} B is over its ceiling ${g.ceiling} B (+${g.bytes - g.ceiling}). Shrink the surface, or raise it deliberately: node scripts/measure-schema.mjs --write --allow-growth`,
    );
  }
  for (const t of check.tighten) {
    lines.push(
      `${t.profile}: ${t.bytes} B is ${t.ceiling - t.bytes} B under its ceiling ${t.ceiling} B. Lock the gain in: node scripts/measure-schema.mjs --write`,
    );
  }
  for (const p of check.unbudgeted) {
    lines.push(`${p}: profile has no ceiling/target in scripts/schema-budget.json`);
  }
  for (const p of check.stale) {
    lines.push(`${p}: budget entry for a profile that no longer exists`);
  }
  return lines;
}

/** Serialise the budget the way the repo formats JSON. */
export function formatBudget(budget) {
  return `${JSON.stringify(budget, null, 2)}\n`;
}

function renderTable(measured, budget) {
  const rows = [
    ['profile', 'tools', 'bytes', '~tokens', 'ceiling', 'target', 'over target'],
  ];
  for (const m of measured) {
    const target = budget.targets[m.profile];
    rows.push([
      m.profile,
      String(m.tools),
      String(m.bytes),
      `${(m.bytes / 4000).toFixed(1)}k`,
      String(budget.ceilings[m.profile] ?? '-'),
      String(target ?? '-'),
      target === undefined ? '-' : String(Math.max(0, m.bytes - target)),
    ]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => c.padStart(widths[i])).join('  ')).join('\n');
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        json: { type: 'boolean', default: false },
        check: { type: 'boolean', default: false },
        write: { type: 'boolean', default: false },
        'allow-growth': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    process.stderr.write(`measure-schema: ${err.message}\n`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(
      'usage: node scripts/measure-schema.mjs [--json] [--check] [--write [--allow-growth]]\n',
    );
    return 0;
  }
  if (values['allow-growth'] && !values.write) {
    process.stderr.write('measure-schema: --allow-growth only applies to --write\n');
    return 2;
  }

  const measured = await measureProfiles();
  const budget = readBudget();

  if (values.write) {
    try {
      writeFileSync(
        BUDGET_PATH,
        formatBudget(
          ratchetBudget(measured, budget, { allowGrowth: values['allow-growth'] }),
        ),
      );
    } catch (err) {
      process.stderr.write(`measure-schema: ${err.message}\n`);
      return 1;
    }
    process.stdout.write(`measure-schema: ceilings written to ${BUDGET_PATH}\n`);
    return 0;
  }

  if (values.json) process.stdout.write(`${JSON.stringify(measured, null, 2)}\n`);
  else process.stdout.write(`${renderTable(measured, budget)}\n`);

  if (values.check) {
    const lines = describeViolations(checkBudget(measured, budget));
    for (const line of lines) process.stderr.write(`measure-schema: ${line}\n`);
    return lines.length === 0 ? 0 : 1;
  }
  return 0;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main();
}
