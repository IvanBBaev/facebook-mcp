import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MessageChannel } from 'node:worker_threads';
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

test('an empty or relative XDG base is ignored, not turned into a relative path', () => {
  // `XDG_CONFIG_HOME=` (exported empty by a launcher or a systemd unit) joined
  // to nothing yields "facebook-mcp" — a path relative to whatever CWD the MCP
  // client happened to spawn the server in. The credential env file and the
  // write journal would be created there, outside the per-user config dir and
  // its 0700 protection. The XDG spec calls an empty or non-absolute value
  // invalid; use the home default for both.
  assert.equal(
    configDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '' }, homeDir: '/home/t' }),
    '/home/t/.config/facebook-mcp',
  );
  assert.equal(
    stateDir({ platform: 'linux', env: { XDG_STATE_HOME: '   ' }, homeDir: '/home/t' }),
    '/home/t/.local/state/facebook-mcp',
  );
  assert.equal(
    configDir({
      platform: 'linux',
      env: { XDG_CONFIG_HOME: 'relative/cfg' },
      homeDir: '/home/t',
    }),
    '/home/t/.config/facebook-mcp',
  );
});

test('CC-CFG-4: an empty %APPDATA%/%LOCALAPPDATA% falls back to the user profile', () => {
  assert.equal(
    configDir({ platform: 'win32', env: { APPDATA: '' }, homeDir: 'C:\\Users\\Test' }),
    'C:\\Users\\Test\\AppData\\Roaming\\facebook-mcp',
  );
  assert.equal(
    stateDir({
      platform: 'win32',
      env: { LOCALAPPDATA: '', APPDATA: 'C:\\Users\\Test\\AppData\\Roaming' },
      homeDir: 'C:\\Users\\Test',
    }),
    'C:\\Users\\Test\\AppData\\Roaming\\facebook-mcp',
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

test('atomicWriteFile removes the temp file when the write itself fails', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-cfg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'secret.env');

  // A Uint8Array over a detached ArrayBuffer is still a valid `data` argument by
  // type, but writing it rejects — standing in for every real write-time failure
  // (ENOSPC, EIO, a quota kill) that lands after `open('wx')` has already put the
  // temp file on disk. That window had no cleanup at all: only the rename step
  // was guarded, so the orphan survived under a 0600 `.tmp` name in the config
  // dir, one per failed write. (Transferring through a MessagePort detaches the
  // buffer without `ArrayBuffer.prototype.transfer`, which is ES2024 and above
  // this repo's `lib`.)
  const buffer = new ArrayBuffer(8);
  const view = new Uint8Array(buffer);
  const channel = new MessageChannel();
  channel.port1.postMessage(null, [buffer]);
  channel.port1.close();
  channel.port2.close();
  assert.equal(buffer.byteLength, 0, 'the buffer is detached');

  await assert.rejects(() => atomicWriteFile(target, view));

  const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'the temp file must not survive a failed write');
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

test('loadEnvFile parses the .env dialects an operator pastes: quotes, CRLF, export, # in quotes', async (t) => {
  // Regression pin over the dotenv contract this module delegates to. Every key
  // is FB_TESTONLY_* and cleared first so the file — not the ambient env — wins.
  const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-env-dialect-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.env');
  await writeFile(
    file,
    [
      'FB_TESTONLY_DQ="123"',
      'export FB_TESTONLY_EXPORT=abc',
      'FB_TESTONLY_HASH="a#b"',
      'FB_TESTONLY_COMMENT=abc # trailing comment',
      "FB_TESTONLY_SQ='x y'",
      'FB_TESTONLY_EMPTY=',
      'FB_TESTONLY_ESC="line1\\nline2"',
      'FB_TESTONLY_PAD=  padded  ',
    ].join('\r\n') + '\r\n',
  );
  const keys = {
    FB_TESTONLY_DQ: undefined,
    FB_TESTONLY_EXPORT: undefined,
    FB_TESTONLY_HASH: undefined,
    FB_TESTONLY_COMMENT: undefined,
    FB_TESTONLY_SQ: undefined,
    FB_TESTONLY_EMPTY: undefined,
    FB_TESTONLY_ESC: undefined,
    FB_TESTONLY_PAD: undefined,
  };
  await withEnv(keys, () => {
    const result = loadEnvFile({ path: file });
    assert.equal(result.loaded, true);
    assert.deepEqual([...result.parsedKeys].sort(), Object.keys(keys).sort());
    assert.equal(process.env.FB_TESTONLY_DQ, '123', 'double quotes stripped');
    assert.equal(process.env.FB_TESTONLY_EXPORT, 'abc', '`export` prefix accepted');
    assert.equal(process.env.FB_TESTONLY_HASH, 'a#b', '# inside quotes is not a comment');
    assert.equal(
      process.env.FB_TESTONLY_COMMENT,
      'abc',
      'unquoted trailing comment dropped',
    );
    assert.equal(process.env.FB_TESTONLY_SQ, 'x y', 'single quotes stripped');
    assert.equal(
      process.env.FB_TESTONLY_EMPTY,
      '',
      'an empty assignment is the empty string',
    );
    assert.equal(
      process.env.FB_TESTONLY_ESC,
      'line1\nline2',
      '\\n expands in double quotes',
    );
    assert.equal(
      process.env.FB_TESTONLY_PAD,
      'padded',
      'no CR survives, padding trimmed',
    );
  });
});

test('loadEnvFile: a blank client-passed value does not shadow the env file', async (t) => {
  // An MCPB install maps every optional `user_config` field into the env, so a
  // field the operator left empty arrives as FB_ACCESS_TOKEN="" rather than
  // absent. Settings treats blank as unset, so env-first must too: otherwise the
  // token the operator saved with `setup-token` is silently skipped and startup
  // reports "No access token configured" with the token sitting in the file.
  const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-env-blank-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.env');
  await writeFile(
    file,
    'FB_TESTONLY_BLANK=from-file\nFB_TESTONLY_WS=ws-file\nFB_TESTONLY_SET=file-loses\n',
  );

  await withEnv(
    { FB_TESTONLY_BLANK: '', FB_TESTONLY_WS: '   ', FB_TESTONLY_SET: 'from-client' },
    () => {
      const result = loadEnvFile({ path: file });
      assert.equal(result.loaded, true);
      assert.equal(process.env.FB_TESTONLY_BLANK, 'from-file', 'empty ⇒ file fills it');
      assert.equal(
        process.env.FB_TESTONLY_WS,
        'ws-file',
        'whitespace-only ⇒ file fills it',
      );
      assert.equal(process.env.FB_TESTONLY_SET, 'from-client', 'a real value still wins');
    },
  );
});

test('statFileProtection refuses to call a directory an owner-only credential file', async (t) => {
  if (isWindows()) return; // POSIX-only assertion
  // A directory sitting where the env file belongs cannot be loaded (dotenv
  // fails EISDIR), yet stat() succeeds on it with 0700 — so the doctor used to
  // report an existing, owner-only credential file that holds no credentials.
  const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-cfg-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, '.env');
  await mkdir(target, { mode: 0o700 });

  await assert.rejects(
    () => statFileProtection(target),
    (err: NodeJS.ErrnoException) => {
      assert.equal(err.code, 'EISDIR');
      assert.match(err.message, /not a regular file/);
      return true;
    },
  );
});

test('loadEnvFile reads a UTF-16 env file (what Windows PowerShell 5.1 `>` / Out-File writes)', async (t) => {
  // Windows PowerShell 5.1 redirects and `Out-File`s as UTF-16LE with a BOM by
  // default, so `echo FB_ACCESS_TOKEN=... > $env:APPDATA\facebook-mcp\.env` is
  // a UTF-16 file. dotenv decodes every file as UTF-8, sees NUL-interleaved
  // bytes, parses ZERO keys and reports no error — startup then says "No access
  // token configured" with the token sitting in the file and nothing naming it.
  const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-env-utf16-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const text = 'FB_TESTONLY_U16=from-utf16\r\nFB_TESTONLY_U16B="quoted # value"\r\n';
  const le = path.join(dir, 'le.env');
  await writeFile(
    le,
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]),
  );
  const beBody = Buffer.from(text, 'utf16le');
  beBody.swap16();
  const be = path.join(dir, 'be.env');
  await writeFile(be, Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]));

  for (const file of [le, be]) {
    await withEnv({ FB_TESTONLY_U16: undefined, FB_TESTONLY_U16B: undefined }, () => {
      const result = loadEnvFile({ path: file });
      assert.equal(result.loaded, true, `${file}: loaded`);
      assert.deepEqual(
        [...result.parsedKeys].sort(),
        ['FB_TESTONLY_U16', 'FB_TESTONLY_U16B'],
        `${file}: both keys parsed`,
      );
      assert.equal(process.env.FB_TESTONLY_U16, 'from-utf16');
      assert.equal(process.env.FB_TESTONLY_U16B, 'quoted # value');
    });
  }
});

test('regression: loadEnvFile strips a UTF-8 BOM from the first key', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fbmcp-env-bom-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.env');
  await writeFile(file, '﻿FB_TESTONLY_BOM=first\nFB_TESTONLY_BOM2=second\n');
  await withEnv({ FB_TESTONLY_BOM: undefined, FB_TESTONLY_BOM2: undefined }, () => {
    const result = loadEnvFile({ path: file });
    assert.deepEqual([...result.parsedKeys].sort(), [
      'FB_TESTONLY_BOM',
      'FB_TESTONLY_BOM2',
    ]);
    assert.equal(process.env.FB_TESTONLY_BOM, 'first');
  });
});
