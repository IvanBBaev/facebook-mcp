#!/usr/bin/env node
// Build the distributable `.mcpb` bundle (MCP Bundle — a plain ZIP that Claude
// Desktop installs by double-click).
//
// Zero runtime dependencies on purpose: the release rail must not pull an
// unpinned packer into the one pipeline that produces a signed artifact. The
// ZIP writer below is ~120 lines of `node:zlib` and is deterministic — same
// inputs, same Node/zlib, byte-identical output — because every entry is stored
// with a fixed timestamp (1980-01-01), a fixed mode, a fixed compression level
// and a fixed (sorted) entry order. That is what makes the published SHA-256
// reproducible by a third party.
//
// What goes into the bundle:
//   manifest.json    the MCPB manifest (bundle root)
//   <publish files>  exactly the npm publish surface, taken from
//                    `npm pack --dry-run --json` so it can never drift from
//                    package.json#files
//   node_modules/    production dependencies only, installed from the committed
//                    lockfile into a throwaway staging directory
//
// Usage:
//   node scripts/pack-mcpb.mjs [--out <dir>] [--manifest <file>] [--skip-deps]
//                              [--json] [--json-out <file>] [--help]
//
// Machine-readable output: prefer `--json-out <file>` over `--json` + a pipe.
// This packer shells out to npm, and npm writes progress/summary lines that a
// caller cannot suppress from the outside; anything that treats this process's
// stdout as "pure JSON" is one npm release away from breaking. `--json-out`
// writes the result object to its own file, so the contract does not depend on
// stdout being clean. Child stdout is also redirected to fd 2 below, so `--json`
// stays usable, but the file is the supported machine interface.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { deflateRawSync } from 'node:zlib';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Where the MCPB manifest may live. `manifest.json` at the repo root is the
// convention used by the MCPB tooling and by the metadata generator (R01).
const MANIFEST_CANDIDATES = [
  'manifest.json',
  'mcpb/manifest.json',
  '.mcpb/manifest.json',
];

const USAGE = `pack-mcpb — build the .mcpb bundle for this MCP server

Usage:
  node scripts/pack-mcpb.mjs [options]

Options:
  --out <dir>        Output directory (default: build/mcpb).
  --manifest <file>  MCPB manifest to embed. Default: the first of
                     ${MANIFEST_CANDIDATES.join(', ')} that exists.
  --skip-deps        Do not install/embed production node_modules. Produces a
                     structurally valid but NOT runnable bundle — use only for a
                     quick local smoke of the packer itself, never for a release.
  --json             Print a single JSON object on stdout instead of
                     human-readable lines.
  --json-out <file>  Write the same JSON object to <file>. Preferred over
                     piping --json: it cannot be corrupted by output from the
                     npm child processes this packer runs.
  --help             Show this help.

Outputs <name>-<version>.mcpb plus a <name>-<version>.mcpb.sha256 sidecar in the
standard \`sha256sum -c\` format.

Run \`npm run build\` first — the bundle is built from build/, never from src/.`;

/** Thrown for expected, operator-actionable failures: reported without a stack. */
class PackError extends Error {}

// ---------------------------------------------------------------------------
// ZIP writer (deflate, no ZIP64) — see the header comment for why it is inline.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// 1980-01-01 00:00:00 in MS-DOS date/time — the earliest value the format can
// express, and the conventional "no timestamp" marker for reproducible builds.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;
const UNIX_MODE_0644 = 0o100644;
const VERSION_MADE_BY = 0x0314; // UNIX, spec 2.0
const VERSION_NEEDED = 20;
const FLAG_UTF8_NAMES = 0x0800;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;

/**
 * @param {{ path: string, data: Buffer }[]} entries already sorted by `path`
 * @returns {Buffer} the complete ZIP archive
 */
function buildZip(entries) {
  if (entries.length > MAX_U16) {
    throw new PackError(
      `bundle has ${entries.length} entries, which exceeds the ${MAX_U16}-entry ` +
        'limit of the non-ZIP64 archive format this packer emits.',
    );
  }

  const local = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.path, 'utf8');
    const raw = entry.data;
    const deflated = deflateRawSync(raw, { level: 9 });
    // Storing is smaller for already-compressed or tiny payloads; the choice is
    // a pure function of the bytes, so it stays deterministic.
    const stored = deflated.length >= raw.length;
    const payload = stored ? raw : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(raw);

    if (offset > MAX_U32 || raw.length > MAX_U32 || payload.length > MAX_U32) {
      throw new PackError(
        'bundle exceeds 4 GiB, which the non-ZIP64 archive format this packer ' +
          'emits cannot represent.',
      );
    }

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(VERSION_NEEDED, 4);
    header.writeUInt16LE(FLAG_UTF8_NAMES, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, nameBuf, payload);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(VERSION_MADE_BY, 4);
    dir.writeUInt16LE(VERSION_NEEDED, 6);
    dir.writeUInt16LE(FLAG_UTF8_NAMES, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(payload.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE((UNIX_MODE_0644 << 16) >>> 0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += header.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...local, centralBuf, eocd]);
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

function readJson(path, label) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new PackError(`cannot read ${label} at ${path}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new PackError(`${label} at ${path} is not valid JSON: ${err.message}`);
  }
}

function resolveManifestPath(explicit) {
  if (explicit) {
    const path = resolve(REPO_ROOT, explicit);
    if (!existsSync(path)) {
      throw new PackError(`--manifest ${explicit} does not exist (looked at ${path}).`);
    }
    return path;
  }
  for (const candidate of MANIFEST_CANDIDATES) {
    const path = join(REPO_ROOT, candidate);
    if (existsSync(path)) return path;
  }
  throw new PackError(
    'no MCPB manifest found. Expected `manifest.json` at the repository root ' +
      `(searched: ${MANIFEST_CANDIDATES.join(', ')}).\n` +
      'The manifest is part of the generated metadata surface — run the ' +
      'metadata generator (`npm run metadata`) or create manifest.json, ' +
      'then re-run this packer. Pass --manifest <file> if it lives elsewhere.',
  );
}

function assertManifestShape(manifest, manifestPath, pkgVersion) {
  const problems = [];
  for (const field of ['manifest_version', 'name', 'version', 'server']) {
    if (manifest[field] === undefined) problems.push(`missing required field "${field}"`);
  }
  if (manifest.version !== undefined && manifest.version !== pkgVersion) {
    problems.push(
      `version "${manifest.version}" does not match package.json "${pkgVersion}" ` +
        '(regenerate the metadata surface before packing)',
    );
  }
  if (problems.length > 0) {
    throw new PackError(
      `${displayPath(manifestPath)} is not a usable MCPB manifest:\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
  }
}

/** The exact npm publish surface, so the bundle can never drift from `files`. */
function publishSurface() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  let stdout;
  try {
    stdout = execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
  } catch (err) {
    throw new PackError(
      `\`npm pack --dry-run --json\` failed, so the publish surface is unknown: ${err.message}`,
    );
  }
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end < start) {
    throw new PackError('`npm pack --dry-run --json` produced no JSON array on stdout.');
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch (err) {
    throw new PackError(`could not parse \`npm pack --json\` output: ${err.message}`);
  }
  const files = parsed?.[0]?.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new PackError('`npm pack --json` reported an empty publish surface.');
  }
  return files.map((f) => f.path.split(/[\\/]/).join('/'));
}

/**
 * Install production dependencies from the committed lockfile into a throwaway
 * directory and return its node_modules root. Using a clean staging dir (rather
 * than the repo's own node_modules) is what keeps devDependencies out.
 */
function stageProductionDeps(stageDir) {
  for (const file of ['package.json', 'package-lock.json']) {
    const src = join(REPO_ROOT, file);
    if (!existsSync(src)) {
      throw new PackError(`${file} is required to stage production dependencies.`);
    }
    copyFileSync(src, join(stageDir, file));
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    execFileSync(
      npm,
      ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
      {
        cwd: stageDir,
        // fd 2 for BOTH child streams: npm's install summary is diagnostics, not
        // packer output, and letting it reach fd 1 would corrupt `--json`. Using
        // the raw fd (rather than 'pipe') keeps the log streaming live.
        stdio: ['ignore', 2, 2],
        shell: process.platform === 'win32',
      },
    );
  } catch (err) {
    throw new PackError(
      `\`npm ci --omit=dev\` failed while staging deps: ${err.message}`,
    );
  }
  const modules = join(stageDir, 'node_modules');
  if (!existsSync(modules)) {
    throw new PackError('`npm ci --omit=dev` produced no node_modules directory.');
  }
  return modules;
}

/** Depth-first file walk that never follows or embeds symlinks. */
function walkFiles(root, prefix, out) {
  for (const dirent of readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const abs = join(root, dirent.name);
    const rel = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
    if (dirent.isSymbolicLink()) continue; // node_modules/.bin shims — not needed
    if (dirent.isDirectory()) {
      walkFiles(abs, rel, out);
    } else if (dirent.isFile()) {
      out.push({ path: rel, source: abs });
    }
  }
  return out;
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(`..${sep}`);
}

/** Repo-relative when the path is inside the repo, absolute otherwise. */
function displayPath(path) {
  const rel = relative(REPO_ROOT, path);
  return rel.startsWith('..') ? path : rel.split(sep).join('/');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function pack(options) {
  const pkg = readJson(join(REPO_ROOT, 'package.json'), 'package.json');
  if (!pkg.name || !pkg.version) {
    throw new PackError('package.json is missing "name" or "version".');
  }

  const manifestPath = resolveManifestPath(options.manifest);
  const manifest = readJson(manifestPath, 'MCPB manifest');
  assertManifestShape(manifest, manifestPath, pkg.version);

  if (!existsSync(join(REPO_ROOT, 'build', 'index.js'))) {
    throw new PackError(
      'build/index.js is missing — run `npm run build` before packing.',
    );
  }

  const outDir = resolve(REPO_ROOT, options.out);
  mkdirSync(outDir, { recursive: true });

  const bundleName = `${basename(pkg.name)}-${pkg.version}.mcpb`;
  const bundlePath = join(outDir, bundleName);

  /** @type {Map<string, { path: string, data: Buffer }>} */
  const entries = new Map();
  const add = (archivePath, data) => {
    entries.set(archivePath, { path: archivePath, data });
  };

  // 1. The manifest always sits at the bundle root, whatever it is called on disk.
  add('manifest.json', readFileSync(manifestPath));

  // 2. The npm publish surface, minus anything that lives in the output
  //    directory (a previous .mcpb must never end up inside the next one).
  for (const rel of publishSurface()) {
    const abs = join(REPO_ROOT, rel);
    if (isInside(outDir, abs)) continue;
    if (rel.endsWith('.mcpb') || rel.endsWith('.tgz')) continue;
    if (!existsSync(abs)) {
      throw new PackError(`npm reported ${rel} as published, but it is not on disk.`);
    }
    if (lstatSync(abs).isSymbolicLink()) continue;
    add(rel, readFileSync(abs));
  }

  // 3. Production dependencies — the bundle must run without a network.
  let stageDir;
  try {
    if (options.skipDeps) {
      process.stderr.write(
        'pack-mcpb: --skip-deps set — the bundle will NOT run; do not release it.\n',
      );
    } else {
      stageDir = mkdtempSync(join(tmpdir(), 'facebook-mcp-mcpb-'));
      const modulesRoot = stageProductionDeps(stageDir);
      for (const file of walkFiles(modulesRoot, 'node_modules', [])) {
        add(file.path, readFileSync(file.source));
      }
    }
  } finally {
    if (stageDir) rmSync(stageDir, { recursive: true, force: true });
  }

  // 4. Integrity: a bundle whose declared entry point is not inside it is broken.
  const entryPoint =
    typeof manifest.server?.entry_point === 'string'
      ? manifest.server.entry_point.split(/[\\/]/).join('/')
      : undefined;
  if (entryPoint && !entries.has(entryPoint)) {
    throw new PackError(
      `the manifest declares server.entry_point "${entryPoint}", but that file is ` +
        'not in the bundle. Either the entry point is wrong or package.json#files ' +
        'does not publish it.',
    );
  }

  const sorted = [...entries.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const zip = buildZip(sorted);
  const sha256 = createHash('sha256').update(zip).digest('hex');

  writeFileSync(bundlePath, zip);
  writeFileSync(`${bundlePath}.sha256`, `${sha256}  ${bundleName}\n`);

  return {
    path: bundlePath,
    name: bundleName,
    sha256,
    bytes: zip.length,
    entries: sorted.length,
    manifest: displayPath(manifestPath),
    depsIncluded: !options.skipDeps,
  };
}

function main() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        out: { type: 'string', default: join('build', 'mcpb') },
        manifest: { type: 'string' },
        'skip-deps': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        'json-out': { type: 'string' },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    process.stderr.write(`pack-mcpb: ${err.message}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  if (parsed.values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  try {
    const result = pack({
      out: parsed.values.out,
      manifest: parsed.values.manifest,
      skipDeps: parsed.values['skip-deps'],
    });
    const jsonOut = parsed.values['json-out'];
    if (jsonOut) {
      const target = resolve(REPO_ROOT, jsonOut);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`);
    }
    if (parsed.values.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const kib = (result.bytes / 1024).toFixed(1);
      process.stdout.write(
        `bundle:   ${result.path}\n` +
          `sha256:   ${result.sha256}\n` +
          `size:     ${kib} KiB (${result.entries} entries)\n` +
          `manifest: ${result.manifest}\n` +
          `deps:     ${result.depsIncluded ? 'production dependencies embedded' : 'OMITTED (--skip-deps)'}\n`,
      );
    }
  } catch (err) {
    if (err instanceof PackError) {
      process.stderr.write(`pack-mcpb: ${err.message}\n`);
    } else {
      process.stderr.write(
        `pack-mcpb: unexpected failure\n${err?.stack ?? String(err)}\n`,
      );
    }
    process.exitCode = 1;
  }
}

main();
