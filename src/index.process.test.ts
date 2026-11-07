// Tests for the server bootstrap: main() as a real process — the startup and shutdown
// paths.
//
// Split out of `index.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/server.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// main() as a real process: the startup and shutdown paths nothing injectable
// reaches. Each child gets a throwaway cwd and config dirs (so no operator
// `.env` or config file is read) and inherits NODE_V8_COVERAGE so its coverage
// still counts.
// ---------------------------------------------------------------------------

const ENTRY_POINT = fileURLToPath(new URL('./index.js', import.meta.url));

/** A fake but well-formed environment for a child server rooted at `dir`. */
function childEnv(dir: string, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: dir,
    USERPROFILE: dir,
    XDG_CONFIG_HOME: dir,
    APPDATA: dir,
    FB_ACCESS_TOKEN: 'EAAfake-child-process-token',
    FB_JOURNAL_PATH: join(dir, 'journal.jsonl'),
    ...extra,
  };
  const coverage = process.env['NODE_V8_COVERAGE'];
  if (coverage !== undefined) env['NODE_V8_COVERAGE'] = coverage;
  const systemRoot = process.env['SystemRoot'];
  if (systemRoot !== undefined) env['SystemRoot'] = systemRoot;
  return env;
}

/** Ask the OS for a port that is free right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

interface ChildOutcome {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

/**
 * Run the built entry point. `onStderr` sees the accumulated stderr after every
 * chunk, so a test can act (send a signal, close stdin) once a line appears.
 */
function runServer(
  env: Record<string, string>,
  cwd: string,
  onStderr?: (stderr: string, child: ChildProcess) => void,
): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY_POINT], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child did not exit in time; stderr: ${stderr}`));
    }, 20_000);
    child.stdout.resume();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      onStderr?.(stderr, child);
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
}

test('main() over stdio starts, then exits 0 when the client closes stdin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'facebook-mcp-stdio-'));
  try {
    let closed = false;
    const outcome = await runServer(
      // The app pair is set so the redactor's secret collection sees it too.
      childEnv(dir, { FB_APP_ID: '1234567890', FB_APP_SECRET: 'fake-app-secret-value' }),
      dir,
      (stderr, child) => {
        if (!closed && stderr.includes('server started')) {
          closed = true;
          child.stdin?.end();
        }
      },
    );
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.match(outcome.stderr, /server started/);
    assert.match(outcome.stderr, /stdio transport shutting down/);
    assert.doesNotMatch(outcome.stderr, /fake-app-secret-value/);
    assert.doesNotMatch(outcome.stderr, /failed to start|stopped unexpectedly/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main() over http shuts down cleanly on SIGTERM and SIGINT', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX signals cannot be delivered to a child process on Windows');
    return;
  }
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'facebook-mcp-http-'));
    try {
      const port = await freePort();
      let sent = false;
      const outcome = await runServer(
        childEnv(dir, {
          FB_TRANSPORT: 'http',
          FB_HTTP_PORT: String(port),
          FB_HTTP_TOKEN: 'h'.repeat(40),
        }),
        dir,
        (stderr, child) => {
          if (!sent && stderr.includes('server started')) {
            sent = true;
            child.kill(signal);
          }
        },
      );
      assert.equal(outcome.code, 0, `${signal}: ${outcome.stderr}`);
      assert.match(outcome.stderr, /shutdown signal received/);
      assert.ok(outcome.stderr.includes(`"signal":"${signal}"`), outcome.stderr);
      assert.match(outcome.stderr, /http transport shutting down/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('main() reports a transport that cannot start as a startup failure, exit 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'facebook-mcp-busy-'));
  const blocker = createNetServer();
  try {
    const port = await freePort();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(port, '127.0.0.1', () => {
        resolve();
      });
    });
    const outcome = await runServer(
      childEnv(dir, {
        FB_TRANSPORT: 'http',
        FB_HTTP_PORT: String(port),
        FB_HTTP_TOKEN: 'h'.repeat(40),
      }),
      dir,
    );
    assert.equal(outcome.code, 1, outcome.stderr);
    assert.match(outcome.stderr, /facebook-mcp failed to start: .*EADDRINUSE/);
    assert.doesNotMatch(outcome.stderr, /server started/);
  } finally {
    await new Promise<void>((resolve) => {
      blocker.close(() => {
        resolve();
      });
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
