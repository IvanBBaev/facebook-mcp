import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withEnv } from '../testing/index.js';
import {
  atomicWriteFile,
  configDir,
  defaultJournalPath,
  describeFileProtection,
  envFilePath,
  isWindows,
  loadEnvFile,
  stateDir,
  statFileProtection,
} from './config.js';

// --- Path resolution: POSIX (XDG) ---

test('configDir honors XDG_CONFIG_HOME on POSIX', () => {
  const dir = configDir({
    platform: 'linux',
    env: { XDG_CONFIG_HOME: '/xdg/cfg' },
    homeDir: '/home/t',
  });
  assert.equal(dir, '/xdg/cfg/facebook-mcp');
});

test('configDir falls back to ~/.config on POSIX', () => {
  const dir = configDir({ platform: 'linux', env: {}, homeDir: '/home/t' });
  assert.equal(dir, '/home/t/.config/facebook-mcp');
});

test('stateDir honors XDG_STATE_HOME then falls back to ~/.local/state', () => {
  assert.equal(
    stateDir({
      platform: 'linux',
      env: { XDG_STATE_HOME: '/xdg/state' },
      homeDir: '/home/t',
    }),
    '/xdg/state/facebook-mcp',
  );
  assert.equal(
    stateDir({ platform: 'linux', env: {}, homeDir: '/home/t' }),
    '/home/t/.local/state/facebook-mcp',
  );
});

test('envFilePath and defaultJournalPath compose off the config/state dirs', () => {
  const opts = { platform: 'linux' as const, env: {}, homeDir: '/home/t' };
  assert.equal(envFilePath(opts), '/home/t/.config/facebook-mcp/.env');
  assert.equal(
    defaultJournalPath(opts),
    '/home/t/.local/state/facebook-mcp/journal.ndjson',
  );
});

// --- CC-CFG-4: Windows path resolution ---

test('CC-CFG-4: configDir uses %APPDATA% on Windows', () => {
  const dir = configDir({
    platform: 'win32',
    env: { APPDATA: 'C:\\Users\\Test\\AppData\\Roaming' },
    homeDir: 'C:\\Users\\Test',
  });
  assert.equal(dir, 'C:\\Users\\Test\\AppData\\Roaming\\facebook-mcp');
});

test('CC-CFG-4: stateDir prefers %LOCALAPPDATA% on Windows, falls back to AppData\\Local', () => {
  assert.equal(
    stateDir({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' },
      homeDir: 'C:\\Users\\Test',
    }),
    'C:\\Users\\Test\\AppData\\Local\\facebook-mcp',
  );
  assert.equal(
    stateDir({ platform: 'win32', env: {}, homeDir: 'C:\\Users\\Test' }),
    'C:\\Users\\Test\\AppData\\Local\\facebook-mcp',
  );
});

test('isWindows reflects the platform argument', () => {
  assert.equal(isWindows('win32'), true);
  assert.equal(isWindows('linux'), false);
  assert.equal(isWindows('darwin'), false);
});

// --- CC-CFG-4: honest file protection reporting ---

test('CC-CFG-4: describeFileProtection is honest about Windows vs POSIX', () => {
  const posix = describeFileProtection('linux');
  assert.equal(posix.posixPermissions, true);
  assert.equal(posix.claimedMode, '0600');

  const win = describeFileProtection('win32');
  assert.equal(win.posixPermissions, false);
  assert.equal(win.claimedMode, 'n/a');
  assert.match(win.note, /Windows does not honor POSIX 0600/);
});

// --- Atomic 0600 writes ---

test('atomicWriteFile writes content with mode 0600 on POSIX and reports it', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-cfg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'nested', 'secret.env');

  const result = await atomicWriteFile(target, 'FB_ACCESS_TOKEN=fake-token\n');
  assert.equal(result.path, target);

  const body = await readFile(target, 'utf8');
  assert.equal(body, 'FB_ACCESS_TOKEN=fake-token\n');

  if (!isWindows()) {
    assert.equal(result.restricted, true);
    assert.equal(result.mode, 0o600);
    const prot = await statFileProtection(target);
    assert.equal(prot.ownerOnly, true, 'no group/other bits');
    assert.equal(prot.mode, 0o600);
  }
});

test('atomicWriteFile atomically replaces an existing file (no partial reads)', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-cfg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'data.txt');

  await atomicWriteFile(target, 'first');
  await atomicWriteFile(target, 'second');
  assert.equal(await readFile(target, 'utf8'), 'second');
});

test('statFileProtection flags group/other-readable files (doctor honesty)', async (t) => {
  if (isWindows()) return; // POSIX-only assertion
  const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-cfg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'loose.txt');
  await writeFile(target, 'x', { mode: 0o644 });
  const prot = await statFileProtection(target);
  assert.equal(prot.ownerOnly, false);
});

// --- CC-CFG-4: the Windows branches, exercised from POSIX ---
//
// Both functions take an injectable `platform`, so the win32 arms are reachable
// on any host. That matters more than usual here: these are the claims the
// server makes about how well a *credential file* is protected, and the only
// place they run for real is a CI job nobody reads until it goes red. Asserting
// them locally keeps the honesty note from drifting into a lie.

test('CC-CFG-4: atomicWriteFile on Windows still writes, and refuses to claim 0600', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-cfg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'nested', 'secret.env');

  const result = await atomicWriteFile(target, 'FB_ACCESS_TOKEN=fake-token\n', {
    platform: 'win32',
  });

  // The write itself is not conditional on the platform — only the claim is.
  assert.equal(await readFile(target, 'utf8'), 'FB_ACCESS_TOKEN=fake-token\n');
  assert.equal(result.path, target);
  assert.equal(result.restricted, false, 'no POSIX enforcement to claim');
  assert.equal(result.mode, 0o600, 'the requested mode is still reported');
  assert.match(String(result.note), /not enforced on Windows/);
  assert.match(String(result.note), /%APPDATA%/);
});

test('CC-CFG-4: statFileProtection reports no owner-only guarantee on Windows', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-cfg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'secret.env');
  await writeFile(target, 'x', { mode: 0o600 });

  const prot = await statFileProtection(target, 'win32');

  // Even on bits that would read as owner-only under POSIX, the win32 answer is
  // `false`: the NTFS ACL is what protects the file and we did not inspect it.
  assert.equal(prot.ownerOnly, false);
  assert.equal(prot.posixPermissions, false);
  assert.equal(prot.note, describeFileProtection('win32').note);
});

test('atomicWriteFile removes the temp file when the rename fails', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-cfg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // A directory at the target path makes rename() fail after the temp file is
  // already on disk — the one window in which a half-written credential file
  // could be left behind, world-readable name and all.
  const target = path.join(dir, 'occupied');
  await mkdir(target);

  await assert.rejects(() => atomicWriteFile(target, 'FB_ACCESS_TOKEN=fake-token\n'));

  const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'the temp file must not survive a failed rename');
});

// --- CC-CFG-1 (context): env-first + quiet loading ---

test('CC-CFG-1: loadEnvFile is env-first (client-passed env wins) and quiet on stdout', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.env');
  await writeFile(file, 'FB_ACCESS_TOKEN=from-file\nFB_TESTONLY_FROMFILE=file-value\n');

  await withEnv(
    { FB_ACCESS_TOKEN: 'from-client', FB_TESTONLY_FROMFILE: undefined },
    () => {
      // Capture stdout to prove dotenv's v17 banner is suppressed (CC-CFG-1).
      const original = process.stdout.write.bind(process.stdout);
      let captured = '';
      process.stdout.write = (chunk: string | Uint8Array): boolean => {
        captured +=
          typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
      };
      try {
        const result = loadEnvFile({ path: file });
        assert.equal(result.loaded, true);
        assert.ok(result.parsedKeys.includes('FB_ACCESS_TOKEN'));
      } finally {
        process.stdout.write = original;
      }
      assert.equal(captured, '', 'no banner written to stdout');

      // env-first: the pre-set client value is NOT overwritten by the file.
      assert.equal(process.env.FB_ACCESS_TOKEN, 'from-client');
      // A key absent from the client env IS taken from the file.
      assert.equal(process.env.FB_TESTONLY_FROMFILE, 'file-value');
    },
  );
});

test('loadEnvFile tolerates a missing file (optional env file)', () => {
  const result = loadEnvFile({
    path: path.join(tmpdir(), 'fbmcp-does-not-exist-xyz', '.env'),
  });
  assert.equal(result.loaded, false);
  assert.ok(result.error !== undefined);
});
