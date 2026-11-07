#!/usr/bin/env node
// build-fresh.mjs — refuse to run the tests against a stale or missing build
// (R11; review finding QA-04).
//
// The test runner executes the compiled `build/**/*.test.js`, not the
// TypeScript sources. `npm test` after a source edit without a rebuild would
// therefore test the old JavaScript and could report green for code that no
// longer exists. This guard runs before the tests and fails when any file under
// `src/` (or `tsconfig.json`) is newer than the oldest emitted `build/**/*.js`.
// `npm run build` deletes `build/` and re-emits every file, so the oldest
// emitted file marks when the build started.
//
// Usage: node scripts/build-fresh.mjs   (exit 0 fresh, 1 stale or missing)

import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every file under `dir` whose name passes `keep`, recursively. */
function walk(dir, keep) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path, keep));
    else if (keep(entry.name)) out.push(path);
  }
  return out;
}

/**
 * The stale-build verdict for a repo root: `undefined` when the build is fresh,
 * otherwise the reason. Exported for the test.
 */
export function staleReason(root = REPO_ROOT) {
  const buildDir = join(root, 'build');
  let built;
  try {
    built = walk(buildDir, (name) => name.endsWith('.js'));
  } catch {
    built = [];
  }
  if (built.length === 0) return 'no build output; run `npm run build` first';
  const buildStart = Math.min(...built.map((f) => statSync(f).mtimeMs));
  const sources = [join(root, 'tsconfig.json'), ...walk(join(root, 'src'), () => true)];
  const newer = sources.filter((f) => statSync(f).mtimeMs > buildStart);
  if (newer.length === 0) return undefined;
  const shown = newer
    .slice(0, 5)
    .map((f) => relative(root, f))
    .join(', ');
  const more = newer.length > 5 ? ` and ${newer.length - 5} more` : '';
  return `build/ is older than ${shown}${more}; run \`npm run build\` first`;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const reason = staleReason();
  if (reason !== undefined) {
    console.error(`build-fresh: ${reason}`);
    process.exitCode = 1;
  }
}
