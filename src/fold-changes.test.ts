// CHANGELOG fragment fold (`scripts/fold-changes.mjs`).
//
// Parallel tasks write `changes/unreleased/<task-id>.md` instead of editing
// CHANGELOG.md; the release I-task folds them. What matters and is pinned here:
//
//   1. sections land in canonical Keep-a-Changelog order, fragments in file-name
//      order, and whatever `## [Unreleased]` already holds is kept first;
//   2. nothing outside `## [Unreleased]` changes;
//   3. a fragment that would lose text is refused before anything is written;
//   4. `--dry-run` writes and deletes nothing; a real run deletes exactly the
//      folded fragments and keeps the README.
//
// Same import convention as `src/record-fixture.test.ts`: the script lives
// outside `rootDir`, so it is loaded the way Node loads it. Only temp files are
// touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This file compiles to `build/fold-changes.test.js`, so the root is one level up. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'fold-changes.mjs');

interface Fragment {
  readonly name: string;
  readonly text: string;
}

interface FoldModule {
  readonly SECTION_ORDER: readonly string[];
  readonly FoldError: new (message: string) => Error;
  foldChangelog(
    changelog: string,
    fragments: readonly Fragment[],
  ): { changelog: string; unreleased: string; folded: string[] };
}

const fold = (await import(pathToFileURL(SCRIPT).href)) as FoldModule;

const HEAD = '# Changelog\n\nIntro line.\n\n';
const RELEASED = '## [0.8.0] - 2026-10-28\n\n### Changed\n\n- Old entry.\n';

test('fragments fold into an empty [Unreleased] in canonical section order', () => {
  const changelog = `${HEAD}## [Unreleased]\n\n${RELEASED}`;
  const result = fold.foldChangelog(changelog, [
    {
      name: 'x02.md',
      text: '### Fixed\n\n- Fix from x02.\n\n### Added\n\n- Add from x02.\n',
    },
    {
      name: 'c01.md',
      text: '### Security\n\n- Sec from c01.\n\n### Added\n\n- Add from c01.\n',
    },
  ]);

  assert.equal(
    result.changelog,
    `${HEAD}## [Unreleased]\n\n` +
      '### Added\n\n- Add from c01.\n\n- Add from x02.\n\n' +
      '### Fixed\n\n- Fix from x02.\n\n' +
      '### Security\n\n- Sec from c01.\n\n' +
      RELEASED,
  );
  assert.deepEqual(result.folded, ['c01.md', 'x02.md']);
  assert.ok(result.unreleased.startsWith('## [Unreleased]\n\n### Added'));
});

test('existing [Unreleased] content is kept first, and the order is canonical', () => {
  const changelog =
    `${HEAD}## [Unreleased]\n\nPreamble kept.\n\n` +
    '### Fixed\n\n- Existing fix.\n  continued line.\n\n' +
    '### Notes\n\n- Custom section kept.\n\n' +
    '### Changed\n\n- Existing change.\n\n' +
    RELEASED;
  const result = fold.foldChangelog(changelog, [
    { name: 'a.md', text: '### Changed\n\n- New change.\n  - nested bullet.\n' },
  ]);

  assert.equal(
    result.changelog,
    `${HEAD}## [Unreleased]\n\nPreamble kept.\n\n` +
      '### Changed\n\n- Existing change.\n\n- New change.\n  - nested bullet.\n\n' +
      '### Fixed\n\n- Existing fix.\n  continued line.\n\n' +
      '### Notes\n\n- Custom section kept.\n\n' +
      RELEASED,
  );
});

test('the canonical order is the Keep-a-Changelog one', () => {
  assert.deepEqual(fold.SECTION_ORDER, [
    'Added',
    'Changed',
    'Deprecated',
    'Removed',
    'Fixed',
    'Security',
  ]);
});

test('[Unreleased] as the last block keeps the file tail', () => {
  const result = fold.foldChangelog(`${HEAD}## [Unreleased]\n`, [
    { name: 'a.md', text: '### Removed\n\n- Gone.\n' },
  ]);
  assert.equal(result.changelog, `${HEAD}## [Unreleased]\n\n### Removed\n\n- Gone.\n`);
});

test('a fragment that would lose text is refused', () => {
  const changelog = `${HEAD}## [Unreleased]\n\n${RELEASED}`;
  const bad: readonly [string, RegExp][] = [
    ['Intro.\n\n### Added\n\n- x\n', /text before the first/],
    ['### Improved\n\n- x\n', /unknown section "### Improved"/],
    ['### Added\n\n- x\n\n### Added\n\n- y\n', /appears twice/],
    ['### Added\n\n', /is empty/],
    ['\n\n', /no `### <Section>` heading/],
    ['## [1.0.0]\n\n### Added\n\n- x\n', /only `### <Section>` headings/],
  ];
  for (const [text, message] of bad) {
    assert.throws(
      () => fold.foldChangelog(changelog, [{ name: 'bad.md', text }]),
      (error: unknown) => error instanceof fold.FoldError && message.test(error.message),
      `expected ${String(message)} for ${JSON.stringify(text)}`,
    );
  }
});

test('a changelog without [Unreleased] is refused', () => {
  assert.throws(
    () =>
      fold.foldChangelog(`${HEAD}${RELEASED}`, [
        { name: 'a.md', text: '### Added\n\n- x\n' },
      ]),
    /no "## \[Unreleased\]" heading/,
  );
});

test('the CLI: --dry-run writes nothing, a real run folds and deletes fragments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fold-changes-'));
  try {
    const dir = join(root, 'changes', 'unreleased');
    await mkdir(dir, { recursive: true });
    const changelog = `${HEAD}## [Unreleased]\n\n${RELEASED}`;
    await writeFile(join(root, 'CHANGELOG.md'), changelog);
    await writeFile(join(dir, 'README.md'), '# not a fragment\n');
    await writeFile(join(dir, 'b.md'), '### Fixed\n\n- From b.\n');
    await writeFile(join(dir, 'a.md'), '### Added\n\n- From a.\n');
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], {
        encoding: 'utf8',
      });

    const dry = run('--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /### Added\n\n- From a\.\n\n### Fixed\n\n- From b\./);
    assert.match(dry.stdout, /would fold 2 fragment\(s\): a\.md, b\.md/);
    assert.equal(await readFile(join(root, 'CHANGELOG.md'), 'utf8'), changelog);
    assert.deepEqual((await readdir(dir)).sort(), ['README.md', 'a.md', 'b.md']);

    const real = run();
    assert.equal(real.status, 0, real.stderr);
    assert.equal(
      await readFile(join(root, 'CHANGELOG.md'), 'utf8'),
      `${HEAD}## [Unreleased]\n\n### Added\n\n- From a.\n\n### Fixed\n\n- From b.\n\n${RELEASED}`,
    );
    assert.deepEqual(await readdir(dir), ['README.md']);

    const again = run();
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /nothing to fold/);

    await writeFile(join(dir, 'c.md'), 'loose text\n');
    const before = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
    const refused = run();
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /c\.md: text before the first/);
    assert.equal(await readFile(join(root, 'CHANGELOG.md'), 'utf8'), before);
    assert.deepEqual((await readdir(dir)).sort(), ['README.md', 'c.md']);

    const usage = run('--bogus');
    assert.equal(usage.status, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
