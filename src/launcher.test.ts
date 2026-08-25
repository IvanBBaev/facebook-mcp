// Launcher regression gate.
//
// The published binary is `bin/facebook-mcp.mjs`, which imports the compiled
// entry module. Importing it is NOT enough to start it: the entry module's
// self-run guard compares `process.argv[1]` against its own path, and through
// the launcher `argv[1]` is the shim. When the shim only imported the module and
// never called the exported entry point, `facebook-mcp doctor` exited 0 having
// printed nothing — an install that looks fine and does nothing. Every in-process
// test still passed, because none of them went through the shim.
//
// So these tests spawn the real launcher the way npm does. They are deliberately
// offline: with no credential configured, both subcommands report and exit before
// any Graph call, so nothing here depends on a token or the network. (The network
// fence guards the test process, not its children — hence the care.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This file compiles to `build/launcher.test.js`, so the root is one level up. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = join(REPO_ROOT, 'bin', 'facebook-mcp.mjs');

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run the launcher with a scrubbed environment: no inherited `FB_*` (a developer
 * with real credentials exported must not change the outcome) and the config
 * directory pointed at a throwaway path on both platform conventions, so the
 * operator's own env file is neither read nor written.
 */
async function runLauncher(args: readonly string[]): Promise<RunResult> {
  const configHome = await mkdtemp(join(tmpdir(), 'facebook-mcp-launcher-'));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of Object.keys(env)) {
      if (name.startsWith('FB_')) delete env[name];
    }
    env['XDG_CONFIG_HOME'] = configHome;
    env['APPDATA'] = configHome;

    return await new Promise<RunResult>((resolve, reject) => {
      const child = spawn(process.execPath, [LAUNCHER, ...args], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => (stdout += chunk));
      child.stderr.on('data', (chunk: string) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
}

test('the packaged launcher actually runs `doctor`', async () => {
  const result = await runLauncher(['doctor']);

  assert.notEqual(result.stderr.trim(), '', 'the launcher produced no output at all');
  assert.match(result.stderr, /facebook-mcp doctor/, 'no doctor report in the output');
  assert.equal(result.code, 0, 'doctor must exit 0 even with no credential configured');
});

test('the packaged launcher actually runs `setup-token`', async () => {
  const result = await runLauncher(['setup-token', '--no-write']);

  assert.notEqual(result.stderr.trim(), '', 'the launcher produced no output at all');
  assert.match(
    result.stderr,
    /facebook-mcp setup-token/,
    'no setup report in the output',
  );
  // No token was supplied, so the run is incomplete by design and exits non-zero
  // for a wrapper script to branch on.
  assert.match(result.stderr, /INCOMPLETE/);
  assert.equal(result.code, 2);
});

test('the packaged launcher answers `--version` without any configuration', async () => {
  // The environment is scrubbed of every `FB_*`, so this run has no credential:
  // the version must still print, because the install that cannot start is
  // precisely the one a bug reporter is asked to name a version for (G-TOOL-5).
  const result = await runLauncher(['--version']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /^facebook-mcp \d+\.\d+\.\d+/, result.stdout);
  assert.match(result.stdout, /node v\d+\./);
  assert.equal(result.stderr, '', 'the version flag must not warn about config');
});

test('`-v` is an alias for `--version`', async () => {
  const [long, short] = await Promise.all([
    runLauncher(['--version']),
    runLauncher(['-v']),
  ]);

  assert.equal(short.code, 0);
  assert.equal(short.stdout, long.stdout);
});

test('the launcher keeps stdout clean for the stdio transport', async () => {
  // stdout carries JSON-RPC frames. A stray diagnostic byte there corrupts the
  // protocol stream, so diagnostics must go to stderr without exception.
  const result = await runLauncher(['doctor']);

  assert.equal(result.stdout, '', 'the launcher wrote diagnostics to stdout');
});
