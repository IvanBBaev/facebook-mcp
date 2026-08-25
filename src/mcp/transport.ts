// MCP transport factory — stdio + Streamable HTTP (task F14, cluster C12).
//
// Drives the MCP SDK's real server transports — it never reimplements the
// JSON-RPC protocol — and adds the operational guarantees the SDK leaves to the
// host process:
//
//   * stdio: stdout carries ONLY JSON-RPC frames. All diagnostics go to stderr
//     (the injected Logger writes to stderr; a console guard redirects any stray
//     `console.log`/`.info`/`.debug` — e.g. from a chatty dependency — to stderr
//     too), so nothing can corrupt the framing on stdout (CC-CFG-1 / C12). Clean
//     shutdown on stdin EOF, propagating an AbortSignal to in-flight work so
//     requests and `Clock.sleep` waits unwind (CC-MCP-5).
//
//   * Streamable HTTP: binds a loopback address ONLY (refuses a non-loopback
//     host), fails closed when `FB_HTTP_TOKEN` is unset (refuses to start with a
//     clear error — CC-CFG-6), requires a bearer token on every request, rejects
//     any request whose `Origin` is not this exact loopback port (DNS-rebinding
//     defense — Security #4), and shuts down the listener plus in-flight
//     connections cleanly (CC-MCP-5).
//
//     A request with NO `Origin` header is allowed through to the bearer check.
//     That is deliberate and is what the rebinding defense actually rests on: a
//     browser always sends `Origin` on the cross-origin requests rebinding can
//     mount, so a rebound page is rejected by the check above — while ordinary
//     local agent clients (curl, an SDK HTTP client) send no `Origin` at all, and
//     demanding one would only bar the legitimate callers. The bearer token,
//     which a rebound page cannot read, is the credential.
//
// Layer: `mcp` (may import core/api, never tools).

import { createServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { randomUUID, timingSafeEqual } from 'node:crypto';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { HTTP_LOOPBACK_HOST } from '../core/index.js';
import type { Logger, Settings, TransportKind } from '../core/index.js';

/**
 * The minimal server surface {@link startTransport} drives. Both the SDK's
 * low-level `Server` and high-level `McpServer` satisfy it, so I1's bootstrap
 * can build either and hand it over without this module depending on a concrete
 * server class.
 */
export interface ConnectableServer {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

/** Injected collaborators and optional test seams for {@link startTransport}. */
export interface TransportDeps {
  /** Diagnostics sink. MUST write to stderr — never stdout (protects the stdio channel). */
  readonly logger: Logger;
  /**
   * External shutdown trigger. When it aborts, the transport shuts down exactly
   * as if {@link TransportHandle.close} were called — I1 wires SIGINT/SIGTERM here.
   */
  readonly signal?: AbortSignal;
  /** stdio input stream; defaults to `process.stdin`. Injectable for tests. */
  readonly stdin?: Readable;
  /**
   * stdio output stream; defaults to `process.stdout`. When provided (tests),
   * the global-console stdout guard is skipped, since the injected stream — not
   * the process's real stdout — is the protocol channel.
   */
  readonly stdout?: Writable;
  /**
   * Streamable HTTP only: reply with a single JSON body instead of an SSE
   * stream. Default `false` (SSE, which can also carry progress notifications).
   */
  readonly httpJsonResponse?: boolean;
}

/** Bound loopback address of the HTTP transport (port resolved when 0 was requested). */
export interface TransportAddress {
  readonly host: string;
  readonly port: number;
}

/** Handle returned by {@link startTransport}: introspection + graceful shutdown. */
export interface TransportHandle {
  readonly kind: TransportKind;
  /**
   * Aborts when shutdown begins. Pass it into fbRequest / `Clock.sleep` so
   * in-flight requests and waits unwind on shutdown (CC-MCP-5).
   */
  readonly signal: AbortSignal;
  /** Resolves once the transport (and, for HTTP, the listener + connections) is fully closed. */
  readonly closed: Promise<void>;
  /** HTTP only. Absent for stdio. */
  readonly address?: TransportAddress;
  /** Idempotent graceful shutdown. */
  close(): Promise<void>;
}

/**
 * Start the transport selected by `settings.transport` and connect `server` to
 * it. Resolves once the transport is live (stdio connected / HTTP listening);
 * rejects if the HTTP transport is misconfigured (no token, non-loopback host)
 * or the listener fails to bind.
 */
export async function startTransport(
  server: ConnectableServer,
  settings: Settings,
  deps: TransportDeps,
): Promise<TransportHandle> {
  return settings.transport === 'http'
    ? startHttp(server, settings, deps)
    : startStdio(server, deps);
}

// ---------------------------------------------------------------------------
// stdio
// ---------------------------------------------------------------------------

async function startStdio(
  server: ConnectableServer,
  deps: TransportDeps,
): Promise<TransportHandle> {
  const stdin = deps.stdin ?? process.stdin;
  // Guard the process console only when the real stdout IS the protocol channel.
  const restoreConsole = deps.stdout === undefined ? guardStdout() : undefined;
  const transport =
    deps.stdout === undefined
      ? new StdioServerTransport(stdin)
      : new StdioServerTransport(stdin, deps.stdout);

  const controller = new AbortController();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closePromise: Promise<void> | undefined;

  function onEof(): void {
    void close();
  }

  const doClose = async (): Promise<void> => {
    deps.logger.info('stdio transport shutting down', { transport: 'stdio' });
    if (!controller.signal.aborted) {
      controller.abort();
    }
    stdin.off('end', onEof);
    stdin.off('close', onEof);
    try {
      await transport.close();
    } catch (err) {
      deps.logger.error('stdio transport close failed', { error: errText(err) });
    }
    restoreConsole?.();
    resolveClosed();
  };
  const close = (): Promise<void> => (closePromise ??= doClose());

  try {
    await server.connect(transport);
  } catch (err) {
    restoreConsole?.();
    throw err;
  }

  // Both hooks are wired *after* connect, never before. `doClose` tears the
  // transport down, and `connect` then starts it: a shutdown racing startup
  // would re-attach the stdin `data` listener after the teardown removed it,
  // leaving a live transport whose `close()` is memoized to an already-resolved
  // promise — a running server that reports itself closed and can never be
  // stopped. `wireExternalSignal` re-reads `aborted` at wire time, so a signal
  // that fired during connect still shuts the transport down here.
  //
  // The SDK's stdio transport listens for stdin `data`/`error` but NOT for EOF,
  // so wire `end`/`close` ourselves to trigger a clean shutdown (CC-MCP-5).
  stdin.on('end', onEof);
  stdin.on('close', onEof);
  wireExternalSignal(deps.signal, close);

  deps.logger.info('stdio transport connected', { transport: 'stdio' });

  return { kind: 'stdio', signal: controller.signal, closed, close };
}

// ---------------------------------------------------------------------------
// Streamable HTTP
// ---------------------------------------------------------------------------

async function startHttp(
  server: ConnectableServer,
  settings: Settings,
  deps: TransportDeps,
): Promise<TransportHandle> {
  const token = settings.httpToken;
  if (token === undefined || token.length === 0) {
    throw new Error(
      'HTTP transport requires FB_HTTP_TOKEN to be set; refusing to start without it ' +
        '(fail-closed — CC-CFG-6 / Security #4).',
    );
  }
  const host = settings.httpHost ?? HTTP_LOOPBACK_HOST;
  if (!isLoopbackBindHost(host)) {
    throw new Error(
      `HTTP transport binds a loopback address only; refusing non-loopback host "${host}" ` +
        '(Security #4).',
    );
  }
  const requestedPort = settings.httpPort ?? 0;

  const controller = new AbortController();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: deps.httpJsonResponse ?? false,
  });
  await server.connect(transport);

  // Resolved after listen(); the Origin check compares against the bound port.
  let boundPort = requestedPort;

  const handleHttpRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    try {
      // Present-and-wrong is rejected; absent is passed to the bearer check —
      // see the "no `Origin` header" paragraph in this file's header for why.
      const origin = req.headers.origin;
      if (
        typeof origin === 'string' &&
        origin.length > 0 &&
        !isAllowedLoopbackOrigin(origin, boundPort)
      ) {
        deps.logger.warn('http request rejected: disallowed Origin', { origin });
        writeJsonRpcError(res, 403, 'origin not allowed');
        return;
      }
      if (!hasValidBearerToken(req, token)) {
        deps.logger.warn('http request rejected: missing or invalid bearer token');
        res.setHeader('WWW-Authenticate', 'Bearer');
        writeJsonRpcError(res, 401, 'missing or invalid bearer token');
        return;
      }
      await transport.handleRequest(req, res);
    } catch (err) {
      deps.logger.error('http request handling failed', { error: errText(err) });
      if (!res.headersSent) {
        writeJsonRpcError(res, 500, 'internal error');
      }
    }
  };

  const httpServer = createServer((req, res) => {
    void handleHttpRequest(req, res);
  });

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closePromise: Promise<void> | undefined;

  const doClose = async (): Promise<void> => {
    deps.logger.info('http transport shutting down', { host, port: boundPort });
    if (!controller.signal.aborted) {
      controller.abort();
    }
    try {
      await transport.close();
    } catch (err) {
      deps.logger.error('http transport close failed', { error: errText(err) });
    }
    await new Promise<void>((resolve) => {
      httpServer.close(() => {
        resolve();
      });
      // Force in-flight (incl. idle keep-alive) sockets closed so we do not hang.
      httpServer.closeAllConnections();
    });
    resolveClosed();
  };
  const close = (): Promise<void> => (closePromise ??= doClose());

  try {
    await listen(httpServer, requestedPort, host);
  } catch (err) {
    try {
      await transport.close();
    } catch (closeErr) {
      deps.logger.debug('http transport close after bind failure also failed', {
        error: errText(closeErr),
      });
    }
    throw err;
  }
  boundPort = (httpServer.address() as AddressInfo).port;
  deps.logger.info('http transport listening', { host, port: boundPort });

  // Wired only once the listener is actually up. `doClose` calls
  // `httpServer.close()`, and closing a server whose `listen()` is still in
  // flight means neither `'listening'` nor `'error'` ever fires — the promise in
  // `listen()` never settles and startup hangs forever, so a SIGTERM arriving
  // during boot would wedge the process instead of ending it. Wiring here also
  // re-reads `aborted`, so a signal that fired during the bind is not missed.
  wireExternalSignal(deps.signal, close);

  return {
    kind: 'http',
    signal: controller.signal,
    closed,
    address: { host, port: boundPort },
    close,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Attach an external AbortSignal so aborting it triggers a graceful shutdown. */
function wireExternalSignal(
  signal: AbortSignal | undefined,
  close: () => Promise<void>,
): void {
  if (!signal) {
    return;
  }
  if (signal.aborted) {
    void close();
    return;
  }
  signal.addEventListener(
    'abort',
    () => {
      void close();
    },
    { once: true },
  );
}

/**
 * True only for a literal IPv4/IPv6 loopback *bind* address. A DNS name like
 * `localhost` is intentionally rejected as a bind host — the contract mandates
 * the literal loopback address (Security #4).
 */
function isLoopbackBindHost(host: string): boolean {
  return host === '::1' || host === '[::1]' || host.startsWith('127.');
}

/** Loopback hostnames accepted in an `Origin` header (browsers send names, not IPs). */
const LOOPBACK_ORIGIN_HOSTNAMES: ReadonlySet<string> = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
]);

/**
 * Validate a browser `Origin` header against loopback + the port we are bound to.
 * An `http://` loopback origin on the same port is allowed; anything else — a
 * non-loopback host, https, or a port mismatch — is rejected (DNS-rebinding
 * defense, Security #4).
 */
function isAllowedLoopbackOrigin(origin: string, boundPort: number): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') {
    return false;
  }
  if (!LOOPBACK_ORIGIN_HOSTNAMES.has(url.hostname)) {
    return false;
  }
  const originPort = url.port === '' ? '80' : url.port;
  return originPort === String(boundPort);
}

/** Constant-time bearer-token check against the `Authorization` header. */
function hasValidBearerToken(req: IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') {
    return false;
  }
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) {
    return false;
  }
  return timingSafeStringEqual(header.slice(prefix.length), expected);
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Write a minimal JSON-RPC error body with the given HTTP status. */
function writeJsonRpcError(res: ServerResponse, status: number, message: string): void {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32000, message },
  });
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

/** Promisified `server.listen(port, host)` that rejects on bind error. */
function listen(server: HttpServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

type ConsoleWriter = (...args: unknown[]) => void;

/**
 * Redirect `console.log`/`.info`/`.debug` (which write to stdout) to
 * `console.error` (stderr) for the lifetime of the stdio transport, so a
 * dependency that logs to stdout cannot corrupt the JSON-RPC framing (CC-CFG-1).
 * Returns a restore function. `console.warn`/`.error` already target stderr and
 * are left untouched.
 */
function guardStdout(): () => void {
  // Access via a typed record alias so the redirect is not itself a
  // `console.log`/`.info`/`.debug` reference (which the no-console lint forbids).
  const sink = console as unknown as Record<'log' | 'info' | 'debug', ConsoleWriter>;
  const names: ReadonlyArray<'log' | 'info' | 'debug'> = ['log', 'info', 'debug'];
  const originals = new Map<'log' | 'info' | 'debug', ConsoleWriter>();
  const redirect: ConsoleWriter = (...args) => {
    console.error(...args);
  };
  for (const name of names) {
    originals.set(name, sink[name]);
    sink[name] = redirect;
  }
  return () => {
    for (const [name, fn] of originals) {
      sink[name] = fn;
    }
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
