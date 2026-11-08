// `tools/list` goldens (R10; review findings QA-01, ARC-06).
//
// A client sees this server through the bytes of `tools/list`, so names, order,
// descriptions, annotations and both JSON Schemas are the public contract. The real
// registry is listed over the wire for the full tool set and for the default one,
// and compared with `test/contract/tools-list.<name>.json`. A failure names the tools
// that drifted; intended drift goes through `test/contract/README.md`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This file compiles to `build/contract/`, so the root is two levels up. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD_DIR = join(REPO_ROOT, 'build');

interface ToolList {
  readonly tools: readonly unknown[];
}

interface ToolListDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly reordered: boolean;
}

interface WireModule {
  readonly CONTRACT_DIR: string;
  readonly TOOL_LIST_GOLDENS: Readonly<Record<string, string | undefined>>;
  updateRequested(env?: NodeJS.ProcessEnv): boolean;
  canonicalize(value: unknown): unknown;
  readGolden(path: string): ToolList;
  writeGolden(path: string, value: unknown): Promise<void>;
  diffToolLists(expected: readonly unknown[], actual: readonly unknown[]): ToolListDiff;
  recordToolList(buildDir: string, name: string): Promise<ToolList>;
}

const wire = (await import(
  pathToFileURL(join(REPO_ROOT, 'test', 'contract', 'wire.mjs')).href
)) as WireModule;

const NO_DRIFT: ToolListDiff = { added: [], removed: [], changed: [], reordered: false };
const tool = (name: string, description = 'd'): unknown => ({ name, description });

for (const name of Object.keys(wire.TOOL_LIST_GOLDENS)) {
  test(`tools/list golden: ${name}`, async () => {
    const path = join(wire.CONTRACT_DIR, `tools-list.${name}.json`);
    const live = await wire.recordToolList(BUILD_DIR, name);
    if (wire.updateRequested()) {
      await wire.writeGolden(path, live);
      return;
    }
    const golden = wire.readGolden(path);
    assert.deepEqual(
      wire.diffToolLists(golden.tools, live.tools),
      NO_DRIFT,
      'tools/list drift; if intended, UPDATE_CONTRACT=1 npm test and review the diff',
    );
    assert.deepEqual(wire.canonicalize(live), golden);
  });
}

test('canonicalize sorts keys at every depth and keeps array order', () => {
  const out = wire.canonicalize({ b: [{ z: 1, a: 2 }, 3], a: { d: 1, c: 2 } });
  assert.equal(JSON.stringify(out), '{"a":{"c":2,"d":1},"b":[{"a":2,"z":1},3]}');
});

test('diffToolLists reports each kind of drift', () => {
  const before = [tool('a'), tool('b'), tool('c')];
  assert.deepEqual(wire.diffToolLists(before, before), NO_DRIFT);
  assert.deepEqual(wire.diffToolLists(before, [...before, tool('d')]), {
    ...NO_DRIFT,
    added: ['d'],
  });
  assert.deepEqual(wire.diffToolLists(before, before.slice(0, 2)), {
    ...NO_DRIFT,
    removed: ['c'],
  });
  assert.deepEqual(wire.diffToolLists(before, [tool('a'), tool('b', 'x'), tool('c')]), {
    ...NO_DRIFT,
    changed: ['b'],
  });
  assert.deepEqual(wire.diffToolLists(before, [tool('b'), tool('a'), tool('c')]), {
    ...NO_DRIFT,
    reordered: true,
  });
});

test('updating the goldens is refused in CI', () => {
  assert.equal(wire.updateRequested({}), false);
  assert.equal(wire.updateRequested({ UPDATE_CONTRACT: '1' }), true);
  assert.throws(() => wire.updateRequested({ UPDATE_CONTRACT: '1', CI: 'true' }), /CI/);
});
