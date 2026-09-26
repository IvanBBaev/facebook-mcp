// Tests for the stdio + Streamable HTTP transport factory (task F14, C12).
//
// Coverage map:
//   * CC-CFG-1 / C12  — stdout purity: a spawned child booting the real stdio
//     transport writes ONLY JSON-RPC frames to stdout; stray console.log/.info
//     are redirected to stderr (see `transport.spawn-fixture.ts`).
//   * CC-CFG-1 / C12  — a failed stdio connect restores the console guard.
//   * CC-CFG-6        — HTTP transport refuses to start without FB_HTTP_TOKEN.
//   * Security #4     — HTTP rejects a non-loopback bind host; enforces bearer
//     token (401) and same-origin Origin (403), accepts a valid loopback origin;
//     rejects malformed, non-http and port-mismatched origins.
//   * CC-MCP-5        — clean shutdown propagates the AbortSignal and resolves
//     `closed` (stdio: on stdin EOF; HTTP: on close(); either: on an external
//     abort signal), completes even when the transport's own close fails, and
//     surfaces a bind failure instead of reporting a live listener.
//
// No outbound `fetch` is used (the network fence forbids it): the HTTP tests
// drive the loopback server with the node:http client; the stdio tests use
// in-process PassThrough streams and a spawned child.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

import {
  GRAPH_HOSTS,
  DEFAULT_API_VERSION,
  DEFAULT_HOST_CONCURRENCY,
  DEFAULT_MAX_RESULT_CHARS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  HTTP_LOOPBACK_HOST,
} from '../core/index.js';
import type { LogFields, Logger, Settings } from '../core/index.js';
import { HTTP_MAX_BODY_BYTES, startTransport } from './transport.js';
import type { ConnectableServer } from './transport.js';

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

interface FakeServerOptions {
  /** Make `connect()` reject, as a server that refuses the transport would. */
  readonly connectError?: Error;
  /**
   * Value thrown by the transport's `onclose` hook. The SDK's `Server` installs
   * such a hook on connect (it unwinds pending requests), so a failure there is
   * how `transport.close()` realistically rejects.
   */
  readonly closeError?: unknown;
}

/**
 * Minimal {@link ConnectableServer} stand-in — the injection seam the transport
 * is built around. Used where a real `McpServer` cannot produce the failure
 * under test.
 */
function fakeServer(options: FakeServerOptions = {}): ConnectableServer {
  return {
    connect: (transport: Transport): Promise<void> => {
      if (options.connectError !== undefined) {
        return Promise.reject(options.connectError);
      }
      if (options.closeError !== undefined) {
        transport.onclose = (): void => {
          throw options.closeError;
        };
      }
      return Promise.resolve();
    },
    close: (): Promise<void> => Promise.resolve(),
  };
}

/**
 * Typed alias for the stdout-bound console methods. Reading them through a
 * record (rather than `console.log`) keeps the no-console lint rule — which
 * guards the stdio protocol channel — meaningful in this file.
 */
type ConsoleWriter = (...args: unknown[]) => void;
const consoleSink = console as unknown as Record<'log' | 'info' | 'debug', ConsoleWriter>;

/** Hold a loopback port so the transport's bind attempt fails with EADDRINUSE. */
async function withBusyPort(fn: (port: number) => Promise<void>): Promise<void> {
  const blocker = createServer(() => {});
  await new Promise<void>((resolve) => {
    blocker.listen(0, HTTP_LOOPBACK_HOST, resolve);
  });
  try {
    await fn((blocker.address() as AddressInfo).port);
  } finally {
    await new Promise<void>((resolve) => {
      blocker.close(() => {
        resolve();
      });
    });
  }
}

/** True when a plain server can bind `port` again — i.e. the listener was released. */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer(() => {});
    probe.once('error', () => {
      resolve(false);
    });
    probe.once('listening', () => {
      probe.close(() => {
        resolve(true);
      });
    });
    probe.listen(port, HTTP_LOOPBACK_HOST);
  });
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
  readonly headers: IncomingHttpHeaders;
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
            headers: res.headers,
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

test('HTTP transport rejects a DNS name that merely starts with "127." (Security #4)', async () => {
  const { logger } = captureLogger();
  // `listen()` resolves a non-literal host through DNS, so a name like
  // `127.0.0.1.example.com` can answer with ANY address — including a public
  // one. The guard promises "a literal IPv4/IPv6 loopback bind address", so the
  // name must be refused here rather than handed to the resolver.
  for (const httpHost of ['127.0.0.1.example.com', '127.evil.invalid', '127.']) {
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
      `expected "${httpHost}" to be rejected as a non-literal bind host`,
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

test('HTTP transport defaults to the loopback host, an ephemeral port and SSE replies', async () => {
  const { logger } = captureLogger();
  // No httpHost / httpPort / httpJsonResponse => every default is exercised.
  const handle = await startTransport(
    newServer(),
    makeSettings({ transport: 'http', httpToken: 'test-token' }),
    { logger },
  );
  try {
    const address = handle.address;
    assert(address, 'http handle must expose a bound address');
    assert.equal(address.host, HTTP_LOOPBACK_HOST);
    assert.ok(address.port > 0, 'port 0 must be resolved to the bound ephemeral port');

    const res = await httpPost(address.port, JSON.stringify(initializeRequest(1)), {
      authorization: 'Bearer test-token',
      origin: `http://127.0.0.1:${String(address.port)}`,
    });
    assert.equal(res.status, 200);
    // Default framing is SSE (it can also carry progress notifications).
    assert.match(String(res.headers['content-type']), /text\/event-stream/);
    const dataLine = res.body.split('\n').find((l) => l.startsWith('data: '));
    assert(dataLine, `expected an SSE data frame, got: ${res.body}`);
    const parsed = asMessage(parseJson(dataLine.slice('data: '.length)));
    assert(parsed, 'expected a JSON-RPC message inside the SSE data frame');
    assert.equal(parsed.id, 1);
    assert(parsed.result, 'expected an initialize result');
  } finally {
    await handle.close();
  }
  await handle.closed;
});

test('HTTP transport rejects malformed, non-http and mismatched Origins (Security #4)', async () => {
  const { logger, lines } = captureLogger();
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
    const address = handle.address;
    assert(address, 'http handle must expose a bound address');
    const port = String(address.port);
    const initBody = JSON.stringify(initializeRequest(1));
    const auth = { authorization: 'Bearer test-token' };

    const rejectedOrigins = [
      'not-a-valid-url', // unparsable Origin
      `https://127.0.0.1:${port}`, // right host and port, wrong scheme
      'http://localhost', // implicit port 80 != the bound port
      'http://127.0.0.1:1', // explicit port mismatch
    ];
    for (const origin of rejectedOrigins) {
      const res = await httpPost(address.port, initBody, { ...auth, origin });
      assert.equal(res.status, 403, `expected origin "${origin}" to be rejected`);
    }
    assert.equal(
      lines.filter((l) => l.msg.includes('disallowed Origin')).length,
      rejectedOrigins.length,
      'every rejected Origin must be reported on the logger',
    );

    // A loopback *hostname* on the bound port is what a browser actually sends.
    const ok = await httpPost(address.port, initBody, {
      ...auth,
      origin: `http://localhost:${port}`,
    });
    assert.equal(ok.status, 200);
  } finally {
    await handle.close();
  }
});

test('a request with no Origin is served, but only with the bearer token', async () => {
  const { logger, lines } = captureLogger();
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
    const address = handle.address;
    assert(address, 'http handle must expose a bound address');
    const initBody = JSON.stringify(initializeRequest(1));

    // No `Origin` at all is what curl and every non-browser MCP client sends;
    // demanding the header would lock out exactly the intended callers, while
    // the rebinding attack it defends against always carries one.
    const ok = await httpPost(address.port, initBody, {
      authorization: 'Bearer test-token',
    });
    assert.equal(ok.status, 200);
    assert.equal(
      lines.filter((l) => l.msg.includes('disallowed Origin')).length,
      0,
      'an absent Origin is not a rejected Origin',
    );

    // Omitting the header is not a way around the credential.
    const noAuth = await httpPost(address.port, initBody, {});
    assert.equal(noAuth.status, 401);
  } finally {
    await handle.close();
  }
});

test('HTTP transport rejects a missing or non-Bearer Authorization header (Security #4)', async () => {
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
    const address = handle.address;
    assert(address, 'http handle must expose a bound address');
    const initBody = JSON.stringify(initializeRequest(1));

    const noHeader = await httpPost(address.port, initBody, {});
    assert.equal(noHeader.status, 401);
    assert.equal(noHeader.headers['www-authenticate'], 'Bearer');

    const wrongScheme = await httpPost(address.port, initBody, {
      authorization: 'Basic dGVzdC10b2tlbg==',
    });
    assert.equal(wrongScheme.status, 401);

    // Same length as the real token, different bytes: the constant-time
    // comparison must still reject it.
    const sameLength = await httpPost(address.port, initBody, {
      authorization: 'Bearer TEST-TOKEN',
    });
    assert.equal(sameLength.status, 401);
  } finally {
    await handle.close();
  }
});

// ---------------------------------------------------------------------------
// HTTP: bind failure and close failure (CC-MCP-5)
// ---------------------------------------------------------------------------

test('HTTP transport surfaces a bind failure and reports no listener (CC-MCP-5)', async () => {
  const { logger, lines } = captureLogger();
  await withBusyPort(async (port) => {
    await assert.rejects(
      startTransport(
        newServer(),
        makeSettings({
          transport: 'http',
          httpToken: 'test-token',
          httpHost: '127.0.0.1',
          httpPort: port,
        }),
        { logger },
      ),
      /EADDRINUSE/,
    );
  });
  assert.equal(
    lines.some((l) => l.msg === 'http transport listening'),
    false,
    'a failed bind must never be reported as a live listener',
  );
});

test('a cleanup failure after a bind failure does not mask the bind error (CC-MCP-5)', async () => {
  const { logger, lines } = captureLogger();
  await withBusyPort(async (port) => {
    await assert.rejects(
      startTransport(
        fakeServer({ closeError: new Error('cleanup boom') }),
        makeSettings({
          transport: 'http',
          httpToken: 'test-token',
          httpHost: '127.0.0.1',
          httpPort: port,
        }),
        { logger },
      ),
      /EADDRINUSE/,
    );
  });
  const cleanup = lines.find((l) => l.level === 'debug');
  assert(cleanup, 'the cleanup failure must be reported on the logger');
  assert.match(cleanup.msg, /close after bind failure/);
  assert.deepEqual(cleanup.fields, { error: 'cleanup boom' });
});

test('HTTP shutdown releases the listener even when the transport close fails (CC-MCP-5)', async () => {
  const { logger, lines } = captureLogger();
  // A non-Error rejection value also checks that the diagnostic stays readable.
  const handle = await startTransport(
    fakeServer({ closeError: 'close boom' }),
    makeSettings({
      transport: 'http',
      httpToken: 'test-token',
      httpHost: '127.0.0.1',
      httpPort: 0,
    }),
    { logger },
  );
  const address = handle.address;
  assert(address, 'http handle must expose a bound address');

  await handle.close();
  await handle.closed;
  assert.equal(handle.signal.aborted, true);
  assert.equal(
    await portIsFree(address.port),
    true,
    'the listener must be released despite the transport close failure',
  );

  const failure = lines.find((l) => l.level === 'error');
  assert(failure, 'the close failure must be reported on the logger');
  assert.match(failure.msg, /http transport close failed/);
  assert.deepEqual(failure.fields, { error: 'close boom' });
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

/** A server whose `slow` tool waits for the test to release it. */
function gatedServer(): {
  server: McpServer;
  release: () => void;
  started: Promise<void>;
  sawAbort: () => boolean;
} {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let aborted = false;
  const server = new McpServer({ name: 'fbmcp-transport-test', version: '0.0.0' });
  server.registerTool(
    'slow',
    { description: 'Waits for the test to release it.' },
    async (extra) => {
      markStarted();
      await gate;
      aborted = extra.signal.aborted;
      return { content: [{ type: 'text' as const, text: 'done' }] };
    },
  );
  return { server, release, started, sawAbort: () => aborted };
}

test('stdin EOF with a tool call in flight still delivers its response before shutting down', async () => {
  // `printf '<requests>' | facebook-mcp`, or a host that closes stdin right
  // after its last request, sends EOF while a call is still running. Closing
  // the transport on EOF aborted every in-flight handler and dropped its
  // response: a write that reached Graph was cancelled mid-flight and the
  // caller never learned whether it happened.
  const { logger } = captureLogger();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const gated = gatedServer();
  const handle = await startTransport(
    gated.server,
    makeSettings({ transport: 'stdio' }),
    {
      logger,
      stdin,
      stdout,
    },
  );

  const initP = nextMessageWithId(stdout, 1);
  stdin.write(frame(initializeRequest(1)));
  await initP;
  stdin.write(frame({ jsonrpc: '2.0', method: 'notifications/initialized' }));

  const callP = nextMessageWithId(stdout, 2, 3000);
  stdin.write(
    frame({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow' } }),
  );
  await gated.started;
  stdin.end();
  await new Promise((resolve) => setImmediate(resolve));
  gated.release();

  const response = await callP;
  assert.equal(response.error, undefined);
  assert.ok(response.result, 'the in-flight call must still be answered');
  assert.equal(gated.sawAbort(), false, 'EOF must not abort a call already running');
  await handle.closed;
  assert.equal(handle.signal.aborted, true);
});

test('stdin EOF still shuts down once the in-flight drain window elapses', async () => {
  // The EOF drain is bounded: a handler that never settles must not wedge
  // shutdown. It is aborted when the window elapses.
  const { logger, lines } = captureLogger();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const gated = gatedServer();
  const handle = await startTransport(
    gated.server,
    makeSettings({ transport: 'stdio' }),
    {
      logger,
      stdin,
      stdout,
      eofDrainMs: 50,
    },
  );

  const initP = nextMessageWithId(stdout, 1);
  stdin.write(frame(initializeRequest(1)));
  await initP;
  stdin.write(frame({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  stdin.write(
    frame({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow' } }),
  );
  await gated.started;
  stdin.end();

  await handle.closed;
  assert.equal(handle.signal.aborted, true);
  assert.ok(
    lines.some((l) => l.level === 'warn' && /did not finish/.test(l.msg)),
    'the forced shutdown is logged',
  );
  gated.release();
});

test('stdin EOF waits for every in-flight request sharing one id, not just the first answered', async () => {
  // Two requests that reuse one id (a client bug the SDK still serves: it runs
  // both handlers and answers both) were tracked as ONE in-flight entry. The
  // first answer retired it, so EOF then saw nothing in flight and closed at
  // once — aborting the second call mid-flight and dropping its answer.
  const { logger } = captureLogger();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const gated = gatedServer();
  gated.server.registerTool('noop', { description: 'Answers at once.' }, () => ({
    content: [{ type: 'text' as const, text: 'ok' }],
  }));
  const handle = await startTransport(
    gated.server,
    makeSettings({ transport: 'stdio' }),
    { logger, stdin, stdout },
  );

  const initP = nextMessageWithId(stdout, 1);
  stdin.write(frame(initializeRequest(1)));
  await initP;
  stdin.write(frame({ jsonrpc: '2.0', method: 'notifications/initialized' }));

  const answers: JsonRpcMessage[] = [];
  let buffer = '';
  stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const msg = asMessage(parseJson(buffer.slice(0, idx)));
      buffer = buffer.slice(idx + 1);
      if (msg?.id === 2) answers.push(msg);
      idx = buffer.indexOf('\n');
    }
  });
  stdin.write(
    frame({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'noop' } }) +
      frame({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow' } }),
  );
  await gated.started;
  while (answers.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  stdin.end();
  await new Promise((resolve) => setImmediate(resolve));
  gated.release();

  await handle.closed;
  assert.equal(gated.sawAbort(), false, 'EOF must not abort the call still running');
  assert.equal(answers.length, 2, 'both requests must be answered before shutdown');
});

test('a malformed stdin frame is reported on stderr and the session survives it', async () => {
  const { logger, lines } = captureLogger();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const handle = await startTransport(newServer(), makeSettings({ transport: 'stdio' }), {
    logger,
    stdin,
    stdout,
  });

  // Three shapes the SDK's parser refuses: not JSON at all, valid JSON that is
  // not JSON-RPC, and a request whose id is neither an integer nor a string.
  // None of them can be answered (there is no id to answer TO), so the only
  // place the failure can surface is the operator's stderr.
  stdin.write('this is not json\n');
  stdin.write(frame({ hello: 'world' }));
  stdin.write(frame({ jsonrpc: '2.0', id: 1.5, method: 'ping' }));

  // The session must outlive the garbage: a well-formed request still round-trips.
  const responseP = nextMessageWithId(stdout, 7);
  stdin.write(frame(initializeRequest(7)));
  const response = await responseP;
  assert(
    response.result,
    'the session must survive malformed frames (anti-over-refusal)',
  );

  const reported = lines.filter(
    (l) => l.level === 'warn' && /stdio transport error/.test(l.msg),
  );
  assert.equal(
    reported.length,
    3,
    `each malformed frame must leave a warn line on the logger; got:\n${JSON.stringify(lines, null, 2)}`,
  );
  for (const line of reported) {
    assert.equal(typeof line.fields?.['error'], 'string');
  }

  stdin.end();
  await handle.closed;
});

test('stdio framing: a frame split across chunks is reassembled, CRLF is accepted, a notification gets no reply', async () => {
  // Regression coverage for behaviour the SDK's read buffer already provides;
  // pinned here because the transport's contract with its host depends on it.
  const { logger, lines } = captureLogger();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const handle = await startTransport(newServer(), makeSettings({ transport: 'stdio' }), {
    logger,
    stdin,
    stdout,
  });

  let frames = 0;
  stdout.on('data', (chunk: Buffer) => {
    frames += chunk
      .toString('utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0).length;
  });

  // One request, delivered in three chunks with a CRLF terminator.
  const wire = frame(initializeRequest(1)).replace(/\n$/, '\r\n');
  const responseP = nextMessageWithId(stdout, 1);
  stdin.write(wire.slice(0, 10));
  await new Promise((resolve) => setImmediate(resolve));
  stdin.write(wire.slice(10, 40));
  await new Promise((resolve) => setImmediate(resolve));
  stdin.write(wire.slice(40));
  const response = await responseP;
  assert(response.result, 'expected the reassembled initialize to be answered');

  // A notification has no id and must not be answered — and it is not an error.
  stdin.write(frame({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  const pingP = nextMessageWithId(stdout, 2);
  stdin.write(frame({ jsonrpc: '2.0', id: 2, method: 'ping' }));
  await pingP;

  assert.equal(frames, 2, 'exactly one reply per request, none for the notification');
  assert.equal(lines.filter((l) => l.level === 'warn' || l.level === 'error').length, 0);

  stdin.end();
  await handle.closed;
});

test('stdio framing: a chunk boundary inside a multi-byte character and a blank line do not corrupt the next frame', async () => {
  // Regression coverage: the SDK's read buffer splits raw bytes on 0x0A, which
  // never occurs inside a multi-byte UTF-8 sequence, and decodes only whole
  // lines. Pinned because a decoder that ran per chunk would mangle the text.
  const { logger, lines } = captureLogger();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const handle = await startTransport(newServer(), makeSettings({ transport: 'stdio' }), {
    logger,
    stdin,
    stdout,
  });

  // The response id echoes the request id verbatim, so a string id carrying
  // multi-byte characters proves the bytes were reassembled intact.
  const id = 'café-\u{1F680}-ž';
  const wire = Buffer.from(
    `${JSON.stringify({ ...(initializeRequest(0) as object), id })}\n`,
    'utf8',
  );
  const rocket = wire.indexOf(Buffer.from('\u{1F680}', 'utf8'));
  assert.ok(rocket > 0, 'fixture must contain the 4-byte character');

  const received = new Promise<JsonRpcMessage>((resolve) => {
    let buffer = '';
    stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (const line of buffer.split('\n').slice(0, -1)) {
        const msg = asMessage(parseJson(line));
        if (msg?.id !== undefined && typeof msg.id === 'string') resolve(msg);
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
    });
  });

  // A blank line first: refused by the parser (and reported), but it must not
  // swallow or poison the frame behind it.
  stdin.write('\n');
  // Split the frame two bytes into the 4-byte character.
  stdin.write(wire.subarray(0, rocket + 2));
  await new Promise((resolve) => setImmediate(resolve));
  stdin.write(wire.subarray(rocket + 2));

  const response = await received;
  assert.equal(response.id, id, 'the multi-byte id must round-trip byte-exact');
  assert(response.result, 'expected the reassembled initialize to be answered');
  assert.equal(
    lines.filter((l) => l.level === 'warn' && /stdio transport error/.test(l.msg)).length,
    1,
    'only the blank line is reported',
  );

  stdin.end();
  await handle.closed;
});

test('stdio shutdown completes and reports a failing transport close (CC-MCP-5)', async () => {
  const { logger, lines } = captureLogger();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const handle = await startTransport(
    fakeServer({ closeError: new Error('close boom') }),
    makeSettings({ transport: 'stdio' }),
    { logger, stdin, stdout },
  );

  // close() must resolve rather than propagate the transport's failure ...
  await handle.close();
  await handle.closed;
  assert.equal(handle.signal.aborted, true);
  // ... and the EOF hooks must still be unwired.
  assert.equal(stdin.listenerCount('end'), 0);
  assert.equal(stdin.listenerCount('close'), 0);

  const failure = lines.find((l) => l.level === 'error');
  assert(failure, 'the close failure must be reported on the logger');
  assert.match(failure.msg, /stdio transport close failed/);
  assert.deepEqual(failure.fields, { error: 'close boom' });
});

test('a failed stdio connect restores the console guard and unwires stdin (CC-CFG-1)', async () => {
  const { logger } = captureLogger();
  const stdin = new PassThrough();
  const original = {
    log: consoleSink.log,
    info: consoleSink.info,
    debug: consoleSink.debug,
  };

  // No injected stdout => the real stdout is the protocol channel, so the
  // console guard is installed. A failed connect must not leave it behind.
  await assert.rejects(
    startTransport(
      fakeServer({ connectError: new Error('connect refused') }),
      makeSettings({ transport: 'stdio' }),
      { logger, stdin },
    ),
    /connect refused/,
  );

  assert.equal(consoleSink.log, original.log);
  assert.equal(consoleSink.info, original.info);
  assert.equal(consoleSink.debug, original.debug);
  assert.equal(stdin.listenerCount('end'), 0);
  assert.equal(stdin.listenerCount('close'), 0);
});

test('the stdio console guard covers EVERY console method that writes to stdout (CC-CFG-1)', async () => {
  const { logger } = captureLogger();
  const stdin = new PassThrough();
  // No injected stdout => the real process stdout is the JSON-RPC channel, so
  // the guard is installed over the process-wide console.
  const handle = await startTransport(newServer(), makeSettings({ transport: 'stdio' }), {
    logger,
    stdin,
  });

  // Capture instead of emit everything that reaches the real stdout while the
  // stray calls run. The whole window below is synchronous, so nothing else
  // (the test reporter included) can interleave a write into it.
  const escaped: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  const stray = console as unknown as Record<string, ConsoleWriter | undefined>;
  try {
    process.stdout.write = (chunk: unknown): boolean => {
      escaped.push(String(chunk));
      return true;
    };
    // Every console method Node routes to stdout — not just log/info/debug.
    stray.dir?.({ chatty: 'dependency' });
    stray.dirxml?.({ chatty: 'dependency' });
    stray.table?.([{ chatty: 'dependency' }]);
    stray.group?.('chatty');
    stray.groupCollapsed?.('chatty');
    stray.groupEnd?.();
    stray.count?.('chatty');
    stray.countReset?.('chatty');
    stray.time?.('chatty');
    stray.timeLog?.('chatty');
    stray.timeEnd?.('chatty');
  } finally {
    process.stdout.write = realWrite;
  }

  stdin.end();
  await handle.closed;

  assert.deepEqual(
    escaped,
    [],
    `stray console output corrupted the JSON-RPC channel: ${JSON.stringify(escaped)}`,
  );
});

// ---------------------------------------------------------------------------
// External shutdown signal (I1 wires SIGINT/SIGTERM here) — CC-MCP-5
// ---------------------------------------------------------------------------

test('an external abort signal shuts the stdio transport down (CC-MCP-5)', async () => {
  const { logger } = captureLogger();
  const controller = new AbortController();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const handle = await startTransport(newServer(), makeSettings({ transport: 'stdio' }), {
    logger,
    signal: controller.signal,
    stdin,
    stdout,
  });
  assert.equal(handle.signal.aborted, false);

  controller.abort();
  await handle.closed;
  assert.equal(handle.signal.aborted, true);
  assert.equal(stdin.listenerCount('end'), 0);
  assert.equal(stdin.listenerCount('close'), 0);
});

test('an external signal aborted before start yields an already shut-down handle', async () => {
  const { logger } = captureLogger();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const handle = await startTransport(
    fakeServer(),
    makeSettings({ transport: 'stdio' }),
    {
      logger,
      signal: AbortSignal.abort(),
      stdin,
      stdout,
    },
  );

  await handle.closed;
  assert.equal(handle.signal.aborted, true);
  // Idempotent: the handle is already closed.
  await handle.close();
});

// Both of the following are regressions for the same defect: the shutdown hook
// used to be wired *before* startup finished, so an abort arriving during boot
// ran the teardown against a transport that startup then brought up. A real
// SIGTERM during boot is exactly when this happens.

test('a signal aborted before start leaves no live stdio transport behind', async () => {
  const { logger } = captureLogger();
  const stdin = new PassThrough();
  const stdout = new PassThrough();

  // A real McpServer, because the leak is in what `connect()` does: it attaches
  // the stdin `data` listener a fake never installs.
  const handle = await startTransport(newServer(), makeSettings({ transport: 'stdio' }), {
    logger,
    signal: AbortSignal.abort(),
    stdin,
    stdout,
  });
  await handle.closed;

  assert.equal(handle.signal.aborted, true);
  // The whole point: a handle reporting `closed` must not still be reading
  // stdin. It used to, and `close()` was memoized to the resolved promise, so
  // nothing could stop it afterwards.
  assert.equal(stdin.listenerCount('data'), 0, 'stdin must not still be read');
  assert.equal(stdin.listenerCount('end'), 0);
  assert.equal(stdin.listenerCount('close'), 0);
});

test(
  'a signal aborted before start does not wedge the HTTP bind',
  // A short timeout is the assertion: the regression was an unsettled promise,
  // so a failure here means `startTransport` never returned at all.
  { timeout: 10000 },
  async () => {
    const { logger } = captureLogger();
    const settings = makeSettings({
      transport: 'http',
      httpToken: 'test-http-token',
      httpHost: '127.0.0.1',
      httpPort: 0,
    });

    const handle = await startTransport(newServer(), settings, {
      logger,
      signal: AbortSignal.abort(),
    });
    await handle.closed;

    assert.equal(handle.signal.aborted, true);
    assert.equal(handle.kind, 'http');
    const port = handle.address?.port;
    assert.ok(port !== undefined && port > 0, 'the listener bound before shutting down');
    assert.equal(await portIsFree(port), true, 'the listener must be released');
  },
);

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

test(
  'a peer that stops reading stdout shuts the stdio server down cleanly instead of crashing on EPIPE (CC-MCP-5)',
  { timeout: 20000 },
  async () => {
    // A real EPIPE needs a real pipe: the parent closes ITS read end of the
    // child's stdout while keeping stdin open (a host that crashed or was
    // killed mid-session leaves exactly this behind), then keeps sending
    // requests so the child has responses to write.
    const fixturePath = fileURLToPath(
      new URL('./transport.spawn-fixture.js', import.meta.url),
    );
    const child = spawn(process.execPath, [fixturePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.setEncoding('utf8');
    let stderrRaw = '';
    child.stderr.on('data', (d: string) => {
      stderrRaw += d;
    });
    // Once the child exits, our own writes to its stdin fail the same way;
    // that is expected here and must not fail the test process instead.
    child.stdin.on('error', () => undefined);

    const exited = new Promise<number>((resolve) => {
      child.on('exit', (code) => resolve(code ?? -1));
    });

    let exitCode = -1;
    let pump: NodeJS.Timeout | undefined;
    try {
      const initialized = nextMessageWithId(child.stdout, 1);
      child.stdin.write(frame(initializeRequest(1)));
      await initialized;

      const readEndClosed = once(child.stdout, 'close');
      child.stdout.destroy();
      await readEndClosed;

      // Keep the child writing until it exits (or the test times out).
      let id = 2;
      pump = setInterval(() => {
        child.stdin.write(
          frame({ jsonrpc: '2.0', id: id++, method: 'tools/list', params: {} }),
        );
      }, 25);
      exitCode = await exited;
    } finally {
      if (pump !== undefined) clearInterval(pump);
      if (exitCode < 0) {
        child.kill('SIGKILL');
      }
    }

    // A vanished reader is a shutdown, not a crash: exit 0 through the normal
    // close path, with no uncaught-exception trace on stderr.
    assert.equal(exitCode, 0, `child stderr:\n${stderrRaw}`);
    assert.ok(
      !stderrRaw.includes("Unhandled 'error' event"),
      `stdout EPIPE escaped as an uncaught exception:\n${stderrRaw}`,
    );
    assert.ok(
      stderrRaw.includes('stdio transport shutting down'),
      `the shutdown must go through the transport's close path:\n${stderrRaw}`,
    );
  },
);

// ---------------------------------------------------------------------------
// HTTP: RFC-conformant credential parsing + Host-header rebinding defense
// ---------------------------------------------------------------------------

/**
 * Run ONE `initialize` against a freshly started HTTP transport and hand back
 * its status plus the logger's lines. A fresh server per request is not
 * ceremony: the SDK transport answers a second `initialize` on the same session
 * with `-32600 Server already initialized`, which would mask the status the
 * guards under test actually produced.
 */
async function initializeOnce(
  headers: Record<string, string>,
): Promise<{ status: number; lines: readonly CapturedLine[] }> {
  const { logger, lines } = captureLogger();
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
    const address = handle.address;
    assert(address, 'http handle must expose a bound address');
    const body = JSON.stringify(initializeRequest(1));
    const port = String(address.port);
    // `__PORT__` lets a caller name the bound port it could not know in advance.
    const resolved = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k, v.replaceAll('__PORT__', port)]),
    );
    const res = await httpPost(address.port, body, resolved);
    return { status: res.status, lines };
  } finally {
    await handle.close();
  }
}

test('an unparseable HTTP body is answered 400 by the SDK and reported on the logger', async () => {
  const { logger, lines } = captureLogger();
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
    const address = handle.address;
    assert(address, 'http handle must expose a bound address');
    const res = await httpPost(address.port, 'this is not json', {
      authorization: 'Bearer test-token',
    });
    // The SDK answers the client itself (JSON-RPC -32700 over HTTP 400) ...
    assert.equal(res.status, 400);
    // ... and the operator hears about it too, instead of a stderr that says
    // only "listening" while the client reports parse errors.
    const reported = lines.filter(
      (l) => l.level === 'warn' && /http transport error/.test(l.msg),
    );
    assert.equal(
      reported.length,
      1,
      `expected one warn line for the rejected body; got:\n${JSON.stringify(lines, null, 2)}`,
    );
    assert.match(String(reported[0]?.fields?.['error']), /Parse error/);
  } finally {
    await handle.close();
  }
});

test('the Bearer scheme is matched case-insensitively, as RFC 7235 requires', async () => {
  // RFC 7235 §2.1: "the scheme name is case-insensitive", and credentials are
  // `auth-scheme 1*SP token68` — more than one space is legal too. A client
  // that spells it `bearer` is holding the right credential, and 401 is the one
  // answer that gives an operator no way to tell that from a wrong token.
  for (const header of [
    'bearer test-token',
    'BEARER test-token',
    'BeArEr test-token',
    'Bearer   test-token',
  ]) {
    const { status } = await initializeOnce({ authorization: header });
    assert.equal(status, 200, `expected "${header}" to be accepted`);
  }

  // Case-insensitivity stops at the scheme: the credential stays exact.
  const wrongCase = await initializeOnce({ authorization: 'Bearer TEST-TOKEN' });
  assert.equal(wrongCase.status, 401, 'the token itself is compared exactly');
});

test('a forged non-loopback Host is rejected even with the bearer token (Security #4)', async () => {
  const auth = { authorization: 'Bearer test-token' };

  // DNS rebinding: an attacker page on a name that re-resolves to 127.0.0.1 is
  // SAME-ORIGIN with itself, so a GET carries no `Origin` at all and the Origin
  // check never fires. `Host` still names where the browser believes it is
  // going, and it is the one header the attack cannot spell as loopback.
  for (const host of [
    'evil.test:__PORT__',
    '127.0.0.1.evil.test:__PORT__',
    'evil.test',
  ]) {
    const { status, lines } = await initializeOnce({ ...auth, host });
    assert.equal(status, 403, `expected Host "${host}" to be rejected`);
    assert.equal(
      lines.filter((l) => l.msg.includes('disallowed Host')).length,
      1,
      `the rejected Host "${host}" must be reported on the logger`,
    );
  }

  // The names a legitimate local client actually uses keep working, on whatever
  // port it reached us through — a port-forward in front of the server is a
  // setup, not an attack.
  for (const host of [
    '127.0.0.1:__PORT__',
    'localhost:__PORT__',
    '[::1]:8080',
    'localhost',
  ]) {
    const { status } = await initializeOnce({ ...auth, host });
    assert.equal(status, 200, `expected Host "${host}" to be accepted`);
  }
});

test('HTTP shutdown survives a non-Error close failure and still reports its text', async () => {
  for (const [closeError, expected] of [
    [{ message: 'close boom' }, 'close boom'],
    [Object.create(null) as object, 'unknown error (no message)'],
  ] as const) {
    const { logger, lines } = captureLogger();
    const handle = await startTransport(
      fakeServer({ closeError }),
      makeSettings({
        transport: 'http',
        httpToken: 'test-token',
        httpHost: '127.0.0.1',
        httpPort: 0,
      }),
      { logger },
    );
    const address = handle.address;
    assert(address, 'http handle must expose a bound address');

    // Describing the failure must not become a second failure that aborts the
    // shutdown before the listener is released.
    await assert.doesNotReject(handle.close());
    await handle.closed;
    assert.equal(await portIsFree(address.port), true);

    const failure = lines.find((l) => l.level === 'error');
    assert(failure, 'the close failure must be reported on the logger');
    assert.deepEqual(failure.fields, { error: expected });
  }
});

// ---------------------------------------------------------------------------
// HTTP: session lifecycle + request-body cap
// ---------------------------------------------------------------------------

/** One HTTP exchange with an arbitrary method; `body` undefined sends none. */
function httpExchange(
  port: number,
  method: string,
  body: string | Buffer | undefined,
  headers: Record<string, string>,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path: '/mcp',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const result: HttpResult = {
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          };
          // Settle only once the upload is over too: a server answering before
          // it has read the whole body is still receiving it, and closing the
          // listener mid-upload would surface as a stray EPIPE later.
          if (req.writableFinished || req.destroyed) {
            resolve(result);
          } else {
            req.once('finish', () => {
              resolve(result);
            });
          }
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function startJsonHttp(logger: Logger): Promise<{
  handle: Awaited<ReturnType<typeof startTransport>>;
  port: number;
}> {
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
  const address = handle.address;
  assert(address, 'http handle must expose a bound address');
  return { handle, port: address.port };
}

test('a client that ends its session with DELETE does not leave a server that refuses every later client', async () => {
  const { logger, lines } = captureLogger();
  const { handle, port } = await startJsonHttp(logger);
  const auth = { authorization: 'Bearer test-token' };
  try {
    const first = await httpPost(port, JSON.stringify(initializeRequest(1)), auth);
    assert.equal(first.status, 200);
    const firstSession = first.headers['mcp-session-id'];
    assert.equal(typeof firstSession, 'string', 'initialize must mint a session id');

    // What the SDK client's `terminateSession()` sends when it disconnects.
    const ended = await httpExchange(port, 'DELETE', undefined, {
      ...auth,
      'mcp-session-id': String(firstSession),
    });
    assert.equal(ended.status, 200);

    // The listener is still up, so the next client must be able to start a
    // session — not be told "Server already initialized" until a restart.
    const second = await httpPost(port, JSON.stringify(initializeRequest(2)), auth);
    assert.equal(second.status, 200, `re-initialize after DELETE failed: ${second.body}`);
    const secondSession = second.headers['mcp-session-id'];
    assert.equal(typeof secondSession, 'string');
    assert.notEqual(secondSession, firstSession, 'a new session gets a new id');

    // ... and that session is actually served end to end.
    const session = { ...auth, 'mcp-session-id': String(secondSession) };
    const initialized = await httpPost(
      port,
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      session,
    );
    assert.equal(initialized.status, 202);
    const listed = await httpPost(
      port,
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
      session,
    );
    assert.equal(listed.status, 200, listed.body);
    const msg = asMessage(parseJson(listed.body));
    assert(msg?.result, `expected a tools/list result, got: ${listed.body}`);

    // The terminated session stays terminated.
    const stale = await httpPost(
      port,
      JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
      { ...auth, 'mcp-session-id': String(firstSession) },
    );
    assert.equal(stale.status, 404);

    // The server did not shut itself down, and the operator can see why the
    // session changed.
    assert.equal(handle.signal.aborted, false);
    assert.equal(
      lines.filter((l) => /session ended by the client/.test(l.msg)).length,
      1,
      `expected one session-ended line; got:\n${JSON.stringify(lines, null, 2)}`,
    );
  } finally {
    await handle.close();
  }
  await handle.closed;
  assert.equal(handle.signal.aborted, true);
});

test('an oversized request body is refused with 413 and the server stays up', async () => {
  const { logger, lines } = captureLogger();
  const { handle, port } = await startJsonHttp(logger);
  const auth = { authorization: 'Bearer test-token' };
  const oversized = Buffer.alloc(HTTP_MAX_BODY_BYTES + 1, 0x20);
  try {
    // Declared up front with Content-Length ...
    const declared = await httpExchange(port, 'POST', oversized, {
      ...auth,
      'content-length': String(oversized.length),
    });
    assert.equal(declared.status, 413, declared.body);
    assert.equal(asMessage(parseJson(declared.body))?.jsonrpc, '2.0');

    // ... and streamed chunked, where no header announces the size.
    const chunked = await httpExchange(port, 'POST', oversized, {
      ...auth,
      'transfer-encoding': 'chunked',
    });
    assert.equal(chunked.status, 413, chunked.body);

    assert.equal(
      lines.filter((l) => /body too large/.test(l.msg)).length,
      2,
      `each refusal must be reported; got:\n${JSON.stringify(lines, null, 2)}`,
    );

    // A body under the cap is still served, on the same listener.
    const ok = await httpPost(port, JSON.stringify(initializeRequest(1)), auth);
    assert.equal(ok.status, 200, ok.body);
  } finally {
    await handle.close();
  }
});

test('the body cap is not a credential bypass: an oversized unauthenticated body is still 401', async () => {
  const { logger } = captureLogger();
  const { handle, port } = await startJsonHttp(logger);
  try {
    const oversized = Buffer.alloc(HTTP_MAX_BODY_BYTES + 1, 0x20);
    const res = await httpExchange(port, 'POST', oversized, {
      'content-length': String(oversized.length),
    });
    assert.equal(res.status, 401);
  } finally {
    await handle.close();
  }
});
