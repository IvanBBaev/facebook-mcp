// Tests for the stdio + Streamable HTTP transport factory (task F14, C12).
//
// Coverage map:
//   * CC-CFG-1 / C12  — stdout purity: a spawned child booting the real stdio
//     transport writes ONLY JSON-RPC frames to stdout; stray console.log/.info
//     are redirected to stderr (see `transport.spawn-fixture.ts`).
//   * CC-CFG-6        — HTTP transport refuses to start without FB_HTTP_TOKEN.
//   * Security #4     — HTTP rejects a non-loopback bind host; enforces bearer
//     token (401) and same-origin Origin (403), accepts a valid loopback origin.
//   * CC-MCP-5        — clean shutdown propagates the AbortSignal and resolves
//     `closed` (stdio: on stdin EOF; HTTP: on close()).
//
// No outbound `fetch` is used (the network fence forbids it): the HTTP tests
// drive the loopback server with the node:http client; the stdio tests use
// in-process PassThrough streams and a spawned child.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

import {
  GRAPH_HOSTS,
  DEFAULT_API_VERSION,
  DEFAULT_HOST_CONCURRENCY,
  DEFAULT_MAX_RESULT_CHARS,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from '../core/index.js';
import type { LogFields, Logger, Settings } from '../core/index.js';
import { startTransport } from './transport.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface CapturedLine {
  readonly level: string;
  readonly msg: string;
  readonly fields?: LogFields;
}

function captureLogger(): { logger: Logger; lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  const at =
    (level: string) =>
    (msg: string, fields?: LogFields): void => {
      lines.push({ level, msg, fields });
    };
  const logger: Logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  };
  return { logger, lines };
}

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    profiles: {},
    apiVersion: DEFAULT_API_VERSION,
    hosts: GRAPH_HOSTS,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    hostConcurrency: DEFAULT_HOST_CONCURRENCY,
    writeMode: 'plan',
    maxResultChars: DEFAULT_MAX_RESULT_CHARS,
    transport: 'stdio',
    packagesDeny: [],
    packagesReadonly: [],
    journalPath: '/tmp/fbmcp-transport-test.ndjson',
    logLevel: 'error',
    ...overrides,
  };
}

function newServer(): McpServer {
  const server = new McpServer({ name: 'fbmcp-transport-test', version: '0.0.0' });
  server.registerTool('noop', { description: 'No-op tool for transport tests.' }, () => ({
    content: [{ type: 'text' as const, text: 'ok' }],
  }));
  return server;
}

interface JsonRpcMessage {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly method?: unknown;
}

function parseJson(line: string): unknown {
  return JSON.parse(line) as unknown;
}

function asMessage(value: unknown): JsonRpcMessage | undefined {
  return typeof value === 'object' && value !== null ? value : undefined;
}

function frame(msg: unknown): string {
  return `${JSON.stringify(msg)}\n`;
}

function initializeRequest(id: number): unknown {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'transport-test', version: '0.0.0' },
    },
  };
}

/** Resolve with the first newline-framed JSON-RPC message on `stream` matching `id`. */
function nextMessageWithId(
  stream: Readable,
  id: number,
  timeoutMs = 5000,
): Promise<JsonRpcMessage> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) {
          const msg = asMessage(parseJson(line));
          if (msg && msg.id === id) {
            cleanup();
            resolve(msg);
            return;
          }
        }
        idx = buffer.indexOf('\n');
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for message id=${String(id)}`));
    }, timeoutMs);
    const cleanup = (): void => {
      stream.off('data', onData);
      clearTimeout(timer);
    };
    stream.on('data', onData);
  });
}

interface HttpResult {
  readonly status: number;
  readonly body: string;
}

function httpPost(
  port: number,
  body: string,
  headers: Record<string, string>,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/mcp',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// HTTP: fail-closed & bind-host validation (CC-CFG-6 / Security #4)
// ---------------------------------------------------------------------------

test('HTTP transport refuses to start without FB_HTTP_TOKEN (fail-closed, CC-CFG-6)', async () => {
  const { logger } = captureLogger();
  await assert.rejects(
    startTransport(newServer(), makeSettings({ transport: 'http', httpPort: 0 }), {
      logger,
    }),
    /FB_HTTP_TOKEN/,
  );
});

test('HTTP transport rejects a non-loopback bind host (Security #4)', async () => {
  const { logger } = captureLogger();
  for (const httpHost of ['0.0.0.0', '192.168.1.10', 'example.com', 'localhost']) {
    await assert.rejects(
      startTransport(
        newServer(),
        makeSettings({
          transport: 'http',
          httpToken: 'test-token',
          httpHost,
          httpPort: 0,
        }),
        { logger },
      ),
      /loopback/,
      `expected "${httpHost}" to be rejected as non-loopback`,
    );
  }
});

// ---------------------------------------------------------------------------
// HTTP: token + Origin enforcement, happy path, clean shutdown
// (Security #4 / CC-MCP-5)
// ---------------------------------------------------------------------------

test('HTTP transport enforces bearer token + Origin and serves initialize (Security #4, CC-MCP-5)', async () => {
  const { logger } = captureLogger();
  const handle = await startTransport(
    newServer(),
    makeSettings({
      transport: 'http',
      httpToken: 'test-token',
      httpHost: '127.0.0.1',
      httpPort: 0,
    }),
    { logger, httpJsonResponse: true },
  );
  try {
    assert.equal(handle.kind, 'http');
    assert.equal(handle.signal.aborted, false);
    const address = handle.address;
    assert(address, 'http handle must expose a bound address');
    assert.ok(address.port > 0);
    assert.equal(address.host, '127.0.0.1');

    const initBody = JSON.stringify(initializeRequest(1));

    // Wrong bearer token => 401, never reaches the MCP transport.
    const badToken = await httpPost(address.port, initBody, {
      authorization: 'Bearer wrong',
    });
    assert.equal(badToken.status, 401);

    // Valid token but cross-origin => 403 (DNS-rebinding defense).
    const badOrigin = await httpPost(address.port, initBody, {
      authorization: 'Bearer test-token',
      origin: 'http://evil.example.com',
    });
    assert.equal(badOrigin.status, 403);

    // Valid token + a same-origin loopback Origin => initialize succeeds.
    const ok = await httpPost(address.port, initBody, {
      authorization: 'Bearer test-token',
      origin: `http://127.0.0.1:${String(address.port)}`,
    });
    assert.equal(ok.status, 200);
    const parsed = asMessage(parseJson(ok.body));
    assert(parsed, 'expected a JSON-RPC response body');
    assert.equal(parsed.error, undefined);
    assert(parsed.result, 'expected an initialize result');
  } finally {
    await handle.close();
  }

  // Clean shutdown propagated the abort signal and resolved `closed`.
  assert.equal(handle.signal.aborted, true);
  await handle.closed;

  // close() is idempotent.
  await handle.close();
});

// ---------------------------------------------------------------------------
// stdio: in-process round-trip + EOF shutdown (CC-MCP-5)
// ---------------------------------------------------------------------------

test('stdio transport round-trips a request and shuts down cleanly on stdin EOF (CC-MCP-5)', async () => {
  const { logger } = captureLogger();
  const clientToServer = new PassThrough(); // the server reads this as its stdin
  const serverToClient = new PassThrough(); // the server writes this as its stdout

  const handle = await startTransport(newServer(), makeSettings({ transport: 'stdio' }), {
    logger,
    stdin: clientToServer,
    stdout: serverToClient,
  });
  assert.equal(handle.kind, 'stdio');
  assert.equal(handle.signal.aborted, false);
  assert.equal(handle.address, undefined);

  const responseP = nextMessageWithId(serverToClient, 1);
  clientToServer.write(frame(initializeRequest(1)));
  const response = await responseP;
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.error, undefined);
  assert(response.result, 'expected an initialize result on stdout');

  // Client closes the pipe (EOF) => the transport shuts down and aborts.
  clientToServer.end();
  await handle.closed;
  assert.equal(handle.signal.aborted, true);
});

// ---------------------------------------------------------------------------
// stdio: stdout purity under a real spawned process (CC-CFG-1 / C12)
// ---------------------------------------------------------------------------

test(
  'spawned stdio server keeps stdout pure; stray console output goes to stderr (CC-CFG-1)',
  { timeout: 20000 },
  async () => {
    const fixturePath = fileURLToPath(
      new URL('./transport.spawn-fixture.js', import.meta.url),
    );
    const child = spawn(process.execPath, [fixturePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdoutRaw = '';
    let stderrRaw = '';
    const stdoutFrames: JsonRpcMessage[] = [];
    let pending = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      stdoutRaw += d;
      pending += d;
      let idx = pending.indexOf('\n');
      while (idx >= 0) {
        const line = pending.slice(0, idx).trim();
        pending = pending.slice(idx + 1);
        if (line.length > 0) {
          const msg = asMessage(parseJson(line));
          if (msg) {
            stdoutFrames.push(msg);
          }
        }
        idx = pending.indexOf('\n');
      }
    });
    child.stderr.on('data', (d: string) => {
      stderrRaw += d;
    });

    const exited = new Promise<number>((resolve) => {
      child.on('exit', (code) => resolve(code ?? -1));
    });

    const waitForId = (id: number, timeoutMs = 10000): Promise<void> =>
      new Promise((resolve, reject) => {
        const has = (): boolean => stdoutFrames.some((f) => f.id === id);
        if (has()) {
          resolve();
          return;
        }
        const onData = (): void => {
          if (has()) {
            cleanup();
            resolve();
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`timeout waiting for stdout frame id=${String(id)}`));
        }, timeoutMs);
        const cleanup = (): void => {
          child.stdout.off('data', onData);
          clearTimeout(timer);
        };
        child.stdout.on('data', onData);
      });

    let exitCode = -1;
    try {
      child.stdin.write(frame(initializeRequest(1)));
      await waitForId(1);

      child.stdin.write(frame({ jsonrpc: '2.0', method: 'notifications/initialized' }));
      child.stdin.write(
        frame({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      );
      await waitForId(2);

      // EOF => the child shuts down cleanly and exits 0.
      child.stdin.end();
      exitCode = await exited;
    } finally {
      if (exitCode < 0) {
        child.kill('SIGKILL');
      }
    }

    // Clean shutdown on EOF (CC-MCP-5).
    assert.equal(exitCode, 0, `child stderr:\n${stderrRaw}`);

    // Every non-empty stdout line is a well-formed JSON-RPC frame — nothing else.
    const stdoutLines = stdoutRaw.split('\n').filter((l) => l.trim().length > 0);
    assert.ok(
      stdoutLines.length >= 2,
      'expected at least the two JSON-RPC responses on stdout',
    );
    for (const line of stdoutLines) {
      const msg = asMessage(parseJson(line));
      assert(msg, `stdout line is not a JSON object: ${line}`);
      assert.equal(msg.jsonrpc, '2.0', `stdout line is not JSON-RPC 2.0: ${line}`);
    }
    assert.ok(
      stdoutFrames.some((f) => f.id === 1),
      'initialize response missing from stdout',
    );
    assert.ok(
      stdoutFrames.some((f) => f.id === 2),
      'tools/list response missing from stdout',
    );

    // The stray console.log/.info NEVER reached stdout ...
    assert.ok(!stdoutRaw.includes('STRAY'), 'stray console output leaked onto stdout');
    // ... and the guard redirected them to stderr, alongside the logger line.
    assert.ok(
      stderrRaw.includes('STRAY-STDOUT-LOG'),
      'console.log was not redirected to stderr',
    );
    assert.ok(
      stderrRaw.includes('STRAY-STDOUT-INFO'),
      'console.info was not redirected to stderr',
    );
    assert.ok(
      stderrRaw.includes('spawn fixture ready'),
      'structured logger line missing from stderr',
    );
  },
);
