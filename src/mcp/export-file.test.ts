// Tests for local file exports (v2 insights F5): the `output` argument's name
// containment, RFC 4180 CSV with the formula guard, default names, and the
// atomic no-overwrite write (0600 file in a 0700 dir, numeric suffixes, no temp
// file left behind, one actionable error).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ExportFileError,
  csvField,
  encodeCsv,
  exportFileName,
  exportOutputArg,
  writeExportFile,
} from './export-file.js';

const POSIX = process.platform !== 'win32';
const NOW = Date.parse('2026-10-24T12:00:05.123Z');

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fbmcp-export-')));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('exportOutputArg accepts a bare name and refuses anything that could leave the dir', () => {
  assert.equal(exportOutputArg.safeParse(undefined).success, true);
  assert.equal(exportOutputArg.safeParse({ format: 'csv' }).success, true);
  assert.equal(
    exportOutputArg.safeParse({ format: 'json', file_name: 'q3_report.v2' }).success,
    true,
  );
  for (const bad of [
    '..',
    '.hidden',
    '../x',
    'a/b',
    'a\\b',
    'C:x',
    '',
    'a b',
    'x'.repeat(81),
  ]) {
    assert.equal(
      exportOutputArg.safeParse({ format: 'csv', file_name: bad }).success,
      false,
      `expected "${bad}" to be refused`,
    );
  }
  assert.equal(exportOutputArg.safeParse({ format: 'xlsx' }).success, false);
  assert.equal(exportOutputArg.safeParse({ format: 'csv', path: '/tmp' }).success, false);
});

test('csvField quotes delimiters, doubles quotes and guards formula starts', () => {
  assert.equal(csvField(undefined), '');
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('two\nlines'), '"two\nlines"');
  assert.equal(csvField('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvField('+1'), "'+1");
  assert.equal(csvField('-cmd'), "'-cmd");
  assert.equal(csvField('@SUM(A1)'), "'@SUM(A1)");
  // Numbers are data, never formulas — a negative value stays a number.
  assert.equal(csvField(-5), '-5');
  assert.equal(csvField(2.5), '2.5');
  assert.equal(csvField(Number.NaN), '');
});

test('encodeCsv writes a header and CRLF-terminated lines', () => {
  assert.equal(
    encodeCsv(
      ['metric', 'value'],
      [
        ['a', 1],
        ['b,c', undefined],
      ],
    ),
    'metric,value\r\na,1\r\n"b,c",\r\n',
  );
});

test('exportFileName adds the extension once and builds a sortable default', () => {
  assert.equal(exportFileName({ format: 'csv', file_name: 'q3' }, [], NOW), 'q3.csv');
  assert.equal(exportFileName({ format: 'csv', file_name: 'q3.CSV' }, [], NOW), 'q3.CSV');
  assert.equal(
    exportFileName({ format: 'json', file_name: 'q3.csv' }, [], NOW),
    'q3.csv.json',
  );
  assert.equal(
    exportFileName({ format: 'json' }, ['page', '111', '2026-07-01', 'default'], NOW),
    'page-111-2026-07-01-default-20261024T120005Z.json',
  );
  assert.equal(
    exportFileName({ format: 'csv' }, ['../x', 'a/b'], NOW),
    '__x-a_b-20261024T120005Z.csv',
  );
});

test('writeExportFile writes a 0600 file in a 0700 dir and returns its receipt', async () => {
  await withDir(async (root) => {
    const dir = join(root, 'exports', 'nested');
    const data = 'metric,value\r\na,1\r\n';
    const receipt = await writeExportFile({
      dir,
      fileName: 'out.csv',
      data,
      rows: 1,
      format: 'csv',
    });
    assert.equal(receipt.path, join(dir, 'out.csv'));
    assert.equal(receipt.rows, 1);
    assert.equal(receipt.bytes, Buffer.byteLength(data));
    assert.equal(receipt.sha256, createHash('sha256').update(data).digest('hex'));
    assert.equal(await readFile(receipt.path, 'utf8'), data);
    assert.deepEqual(await readdir(dir), ['out.csv'], 'no temp file is left behind');
    if (POSIX) {
      assert.equal((await stat(receipt.path)).mode & 0o777, 0o600);
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
    }
  });
});

test('writeExportFile never overwrites: a taken name gets a numeric suffix', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'out.csv'), 'keep me');
    const first = await writeExportFile({
      dir,
      fileName: 'out.csv',
      data: 'one',
      rows: 0,
      format: 'csv',
    });
    const second = await writeExportFile({
      dir,
      fileName: 'out.csv',
      data: 'two',
      rows: 0,
      format: 'csv',
    });
    assert.equal(first.path, join(dir, 'out-1.csv'));
    assert.equal(second.path, join(dir, 'out-2.csv'));
    assert.equal(await readFile(join(dir, 'out.csv'), 'utf8'), 'keep me');
    assert.equal(await readFile(second.path, 'utf8'), 'two');
  });
});

test('writeExportFile turns a filesystem failure into one error naming FB_EXPORT_DIR', async () => {
  await withDir(async (root) => {
    const blocker = join(root, 'not-a-dir');
    await writeFile(blocker, 'x');
    await assert.rejects(
      writeExportFile({
        dir: join(blocker, 'exports'),
        fileName: 'out.csv',
        data: 'x',
        rows: 0,
        format: 'csv',
      }),
      (err: unknown) =>
        err instanceof ExportFileError &&
        /FB_EXPORT_DIR/.test(err.message) &&
        /without `output`/.test(err.message),
    );
  });
});
