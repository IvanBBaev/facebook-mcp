#!/usr/bin/env node
// fold-changes.mjs — fold CHANGELOG fragments into `## [Unreleased]`.
//
// Purpose
//   Parallel tasks never edit CHANGELOG.md (an integration-only file). Each one
//   writes `changes/unreleased/<task-id>.md` instead — see
//   changes/unreleased/README.md for the fragment format. The release I-task runs
//   this script once: it merges every fragment into the `## [Unreleased]` block
//   of CHANGELOG.md and deletes the fragments it folded.
//
// What it does
//   * Reads every `changes/unreleased/*.md` except README.md, in file-name order
//     (plain code-point order, so the result does not depend on the locale).
//   * Each fragment is a list of Keep-a-Changelog sections (`### Added`,
//     `### Changed`, `### Deprecated`, `### Removed`, `### Fixed`,
//     `### Security`). The body of a section is taken verbatim.
//   * The `## [Unreleased]` block is rebuilt with its sections in that canonical
//     order. Whatever the block already holds is kept: its own text comes first
//     in each section, the fragments' bodies follow in file-name order. A
//     section heading outside the canonical six that is already in the block is
//     kept after them, in its original order.
//   * Nothing outside the `## [Unreleased]` block is touched.
//   * A fragment that cannot be folded without losing text (text outside a
//     section, an unknown or repeated section, an empty fragment) stops the
//     whole run before anything is written.
//
// Usage
//   node scripts/fold-changes.mjs              fold, write CHANGELOG.md, delete fragments
//   node scripts/fold-changes.mjs --dry-run    print the new `## [Unreleased]` block
//                                              and the fragments it would fold;
//                                              write and delete nothing
//   node scripts/fold-changes.mjs --check      same as --dry-run
//   --root <dir>   repository root (default: the directory above scripts/)
//   --help         usage, exit 0
//
// Exit status
//   0  folded (or, with --dry-run/--check, foldable); also when there is nothing
//      to fold
//   2  usage or input error — bad arguments, no `## [Unreleased]` heading, or a
//      malformed fragment. Nothing was written.

import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Keep-a-Changelog section order. */
export const SECTION_ORDER = Object.freeze([
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
]);

const UNRELEASED_HEADING = '## [Unreleased]';
const SKIPPED_FILES = new Set(['README.md']);

/** A user-facing input error; the CLI prints the message and exits 2. */
export class FoldError extends Error {}

/** Code-point comparison: deterministic regardless of locale. */
function byCodePoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Drops leading and trailing blank lines, keeps inner layout verbatim. */
function trimBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start += 1;
  while (end > start && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(start, end);
}

/** Splits text into `### <name>` sections; returns the preamble and the sections. */
function splitSections(lines) {
  const preamble = [];
  const sections = [];
  let current = null;
  for (const line of lines) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { name: heading[1], lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  return {
    preamble: trimBlankLines(preamble),
    sections: sections.map((s) => ({
      name: s.name,
      body: trimBlankLines(s.lines).join('\n'),
    })),
  };
}

/**
 * Parses one fragment into `Map<section, body>`. Strict on purpose: anything
 * that would be dropped or reordered silently is an error instead.
 */
export function parseFragment(fileName, text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    if (/^#{1,2}\s/.test(line)) {
      throw new FoldError(
        `${fileName}: only \`### <Section>\` headings are allowed in a fragment, found "${line}"`,
      );
    }
  }
  const { preamble, sections } = splitSections(lines);
  if (preamble.length > 0) {
    throw new FoldError(
      `${fileName}: text before the first \`### <Section>\` heading would be lost: "${preamble[0]}"`,
    );
  }
  if (sections.length === 0) {
    throw new FoldError(
      `${fileName}: no \`### <Section>\` heading; an empty fragment folds nothing`,
    );
  }
  const result = new Map();
  for (const { name, body } of sections) {
    if (!SECTION_ORDER.includes(name)) {
      throw new FoldError(
        `${fileName}: unknown section "### ${name}"; use one of ${SECTION_ORDER.join(', ')}`,
      );
    }
    if (result.has(name)) {
      throw new FoldError(`${fileName}: section "### ${name}" appears twice; merge them`);
    }
    if (body === '') {
      throw new FoldError(`${fileName}: section "### ${name}" is empty`);
    }
    result.set(name, body);
  }
  return result;
}

/**
 * Folds parsed fragments into the changelog text.
 *
 * @param {string} changelog            the current CHANGELOG.md
 * @param {{ name: string, text: string }[]} fragments  fragment file names and contents
 * @returns {{ changelog: string, unreleased: string, folded: string[] }}
 */
export function foldChangelog(changelog, fragments) {
  const eol = changelog.includes('\r\n') ? '\r\n' : '\n';
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');

  const start = lines.findIndex((line) => line.trim() === UNRELEASED_HEADING);
  if (start === -1) {
    throw new FoldError(`CHANGELOG.md has no "${UNRELEASED_HEADING}" heading`);
  }
  let end = lines.findIndex((line, i) => i > start && /^##\s/.test(line));
  if (end === -1) end = lines.length;

  const ordered = [...fragments].sort((a, b) => byCodePoint(a.name, b.name));
  const parsed = ordered.map((f) => parseFragment(f.name, f.text));

  const existing = splitSections(lines.slice(start + 1, end));
  const bodies = new Map();
  const extraNames = [];
  for (const { name, body } of existing.sections) {
    if (bodies.has(name)) {
      throw new FoldError(
        `CHANGELOG.md: "### ${name}" appears twice under ${UNRELEASED_HEADING}`,
      );
    }
    if (!SECTION_ORDER.includes(name)) extraNames.push(name);
    bodies.set(name, body === '' ? [] : [body]);
  }
  for (const fragment of parsed) {
    for (const [name, body] of fragment) {
      if (!bodies.has(name)) bodies.set(name, []);
      bodies.get(name).push(body);
    }
  }

  const block = [UNRELEASED_HEADING, ''];
  if (existing.preamble.length > 0) block.push(...existing.preamble, '');
  for (const name of [...SECTION_ORDER, ...extraNames]) {
    const parts = bodies.get(name);
    if (!parts) continue;
    block.push(`### ${name}`, '');
    if (parts.length > 0) block.push(parts.join('\n\n'), '');
  }

  const after = lines.slice(end);
  // Keep the file's tail exactly: no extra blank line when the block is last.
  if (after.length === 0 || (after.length === 1 && after[0] === '')) {
    while (block.length > 0 && block[block.length - 1] === '') block.pop();
    block.push('');
  }
  const next = [...lines.slice(0, start), ...block, ...after].join('\n');
  const unreleased = trimBlankLines(block).join('\n');
  return {
    changelog: eol === '\n' ? next : next.replace(/\n/g, eol),
    unreleased,
    folded: ordered.map((f) => f.name),
  };
}

/** Lists the fragment files of `<root>/changes/unreleased`, sorted. */
export async function listFragments(root) {
  const dir = join(root, 'changes', 'unreleased');
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !SKIPPED_FILES.has(e.name))
    .map((e) => e.name)
    .sort(byCodePoint);
}

function usage() {
  return [
    'Usage: node scripts/fold-changes.mjs [--dry-run | --check] [--root <dir>]',
    '',
    'Folds changes/unreleased/*.md into the "## [Unreleased]" block of CHANGELOG.md',
    'and deletes the folded fragments. --dry-run / --check print the result only.',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    help: false,
    root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run' || arg === '--check') opts.dryRun = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--root') {
      const value = argv[i + 1];
      if (!value) throw new FoldError('--root needs a directory');
      opts.root = resolve(value);
      i += 1;
    } else throw new FoldError(`unknown argument: ${arg}`);
  }
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(usage());
    return;
  }
  const names = await listFragments(opts.root);
  if (names.length === 0) {
    console.log('fold-changes: no fragments in changes/unreleased/ — nothing to fold');
    return;
  }
  const changelogPath = join(opts.root, 'CHANGELOG.md');
  const dir = join(opts.root, 'changes', 'unreleased');
  const changelog = await readFile(changelogPath, 'utf8');
  const fragments = await Promise.all(
    names.map(async (name) => ({ name, text: await readFile(join(dir, name), 'utf8') })),
  );
  const result = foldChangelog(changelog, fragments);

  if (opts.dryRun) {
    console.log(result.unreleased);
    console.log('');
    console.log(
      `fold-changes: dry run — would fold ${result.folded.length} fragment(s): ${result.folded.join(', ')}`,
    );
    return;
  }
  await writeFile(changelogPath, result.changelog, 'utf8');
  for (const name of result.folded) await rm(join(dir, name));
  console.log(
    `fold-changes: folded ${result.folded.length} fragment(s) into CHANGELOG.md: ${result.folded.join(', ')}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    if (error instanceof FoldError) {
      console.error(`fold-changes: ${error.message}`);
      console.error(usage());
      process.exit(2);
    }
    console.error(error);
    process.exit(1);
  });
}
