// MCP transport factory — stdio + Streamable HTTP (task F14, cluster C12).
//
// Drives the MCP SDK's real server transports — it never reimplements the
// JSON-RPC protocol — and adds the operational guarantees the SDK leaves to the
// host process:
//
//   * stdio: stdout carries ONLY JSON-RPC frames. All diagnostics go to stderr
//     (the injected Logger writes to stderr; a console guard redirects every
//     stray stdout-bound `console` call — `log`/`info`/`debug`, but also `dir`,
//     `dirxml`, `table`, `group`, `count`, `time*` — e.g. from a chatty
//     dependency — to stderr too), so nothing can corrupt the framing on stdout
//     (CC-CFG-1 / C12). Clean shutdown on stdin EOF — and on a peer that stops
//     READING stdout, which surfaces as EPIPE on the next response and would
//     otherwise be an uncaught exception — propagating an AbortSignal to
//     in-flight work so requests and `Clock.sleep` waits unwind (CC-MCP-5).
//
//   * Either transport: every failure the SDK cannot answer on the wire (a frame
//     it cannot parse, a response it could not send) is reported on the logger.
//     The SDK routes those to `transport.onerror`, and a hook nobody sets is a
//     frame nobody hears about.
//
//   * Streamable HTTP: binds a loopback address ONLY (refuses a non-loopback
//     host), fails closed when `FB_HTTP_TOKEN` is unset (refuses to start with a
//     clear error — CC-CFG-6), requires a bearer token on every request, rejects
//     any request whose `Origin` is not this exact loopback port (DNS-rebinding
//     defense — Security #4), and shuts down the listener plus in-flight
//     connections cleanly (CC-MCP-5).
//
//     A request with NO `Origin` header is allowed through to the bearer check.
//     That is deliberate: ordinary local agent clients (curl, an SDK HTTP
//     client) send no `Origin` at all, and demanding one would bar exactly the
//     legitimate callers. The bearer token, which a rebound page cannot read, is
//     the credential that actually holds.
//
//     `Origin` alone does not cover the whole rebinding surface, though, which
//     is why the `Host` header is validated the same way. A page served from a
//     name that re-resolves to 127.0.0.1 is SAME-ORIGIN with the server it is
//     attacking, and a same-origin GET — the Streamable-HTTP event stream is one
//     — carries no `Origin` header for the check above to reject. `Host` is what
//     still names where the browser believes it is going, and it is the one
//     header an attacker cannot spell as loopback without giving up the attack.
//     Only the HOSTNAME is checked, never the port: a port-forward in front of
//     the server is a legitimate setup, not an attack. As with `Origin`, absent
//     is passed on (HTTP/1.0 has no `Host`) and present-and-wrong is refused.
//
// Layer: `mcp` (may import core/api, never tools).

import { Console } from 'node:console';
import { createServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { randomUUID, timingSafeEqual } from 'node:crypto';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { errorMessageOf, HTTP_LOOPBACK_HOST } from '../core/index.js';
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

/**
 * Largest request body the HTTP transport will buffer, in bytes. The SDK's
 * Streamable-HTTP transport reads a POST body whole (`Request.json()`) with no
 * limit of its own, so without this cap one oversized body — a runaway client
 * loop, a mis-pointed upload — is held in memory in full, and a large enough
 * one takes the whole server down. 4 MiB is the cap earlier SDK releases
 * enforced themselves, far above any JSON-RPC frame this server exchanges.
 */
export const HTTP_MAX_BODY_BYTES = 4 * 1024 * 1024;

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
  /**
   * stdio only: how long stdin EOF waits for requests already in flight to be
   * answered before the transport closes anyway. Defaults to
   * {@link STDIO_EOF_DRAIN_MS}. An external signal or a failed stdout never waits.
   */
  readonly eofDrainMs?: number;
}

/**
 * Upper bound on how long stdin EOF lets in-flight requests finish (stdio).
 *
 * EOF means "no more requests", not "discard the answers": a host that closes
 * stdin right after its last request — or `printf … | facebook-mcp` — is still
 * reading stdout. Closing at once aborted every running handler (the SDK aborts
 * them on close) and dropped their responses, so a write that already reached
 * Graph was cut off mid-flight and the caller never learned its outcome. The
 * bound keeps a handler that never settles from wedging shutdown; SIGTERM still
 * stops the process immediately.
 */
export const STDIO_EOF_DRAIN_MS = 120_000;

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
  const stdout = deps.stdout ?? process.stdout;
  // Guard the process console only when the real stdout IS the protocol channel.
  const restoreConsole = deps.stdout === undefined ? guardStdout() : undefined;
  const transport =
    deps.stdout === undefined
      ? new StdioServerTransport(stdin)
      : new StdioServerTransport(stdin, deps.stdout);
  reportTransportErrors(transport, 'stdio', deps.logger);
  const inFlight = trackInFlightRequests(transport);

  const controller = new AbortController();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closePromise: Promise<void> | undefined;

  // stdin EOF lets requests already running finish and answer before the
  // transport closes (see STDIO_EOF_DRAIN_MS); `end` and `close` both fire.
  let eofSeen = false;
  function onEof(): void {
    if (eofSeen) return;
    eofSeen = true;
    void drainThenClose();
  }
  async function drainThenClose(): Promise<void> {
    if (closePromise === undefined && inFlight.size() > 0) {
      deps.logger.info('stdin closed; waiting for in-flight requests', {
        transport: 'stdio',
        inFlight: inFlight.size(),
      });
      const drained = await inFlight.drained(deps.eofDrainMs ?? STDIO_EOF_DRAIN_MS);
      if (!drained && closePromise === undefined) {
        deps.logger.warn('stdio in-flight requests did not finish; shutting down', {
          transport: 'stdio',
          inFlight: inFlight.size(),
        });
      }
    }
    await close();
  }

  // A peer that stops reading stdout — a host that crashed, was killed, or
  // closed its end mid-session while leaving stdin open — turns the next
  // response into a `write EPIPE` `'error'` event on the stdout stream. The SDK
  // writes to that stream directly and never listens for `'error'`, and Node
  // turns an unlistened `'error'` into an uncaught exception: the process died
  // with a stack trace and exit code 1 for what is, from this side, an EOF that
  // arrived on the other pipe. It is treated as exactly that — a shutdown
  // through the same close path as stdin EOF (CC-MCP-5). Only the first failure
  // is worth a line; the stream is destroyed after it, and everything queued
  // behind it fails the same way.
  //
  // The listener is deliberately NEVER removed. A response that was in flight
  // when `close()` ran can still complete — and fail — after it, and an EPIPE
  // arriving on a stream with no listener would crash a process whose shutdown
  // had otherwise been clean, turning the exit code into a lie.
  let stdoutFailed = false;
  function onStdoutError(err: unknown): void {
    if (stdoutFailed) return;
    stdoutFailed = true;
    deps.logger.warn('stdio transport stdout failed; shutting down', {
      error: errText(err),
    });
    void close();
  }

  const doClose = async (): Promise<void> => {
    deps.logger.info('stdio transport shutting down', { transport: 'stdio' });
    inFlight.release();
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

  stdout.on('error', onStdoutError);
  try {
    await server.connect(transport);
  } catch (err) {
    stdout.off('error', onStdoutError);
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
  // Set once shutdown (or a failed bind) begins; from then on a closing SDK
  // transport is the end of the server, not the end of one session.
  let closing = false;
  // Pending while a replacement transport is being connected after a client
  // ended its session; requests arriving meanwhile wait for it.
  let rearming: Promise<void> | undefined;

  const newHttpTransport = (): StreamableHTTPServerTransport => {
    const next = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: deps.httpJsonResponse ?? false,
    });
    reportTransportErrors(next, 'http', deps.logger);
    // A client ends its session with `DELETE` (the SDK client's
    // `terminateSession()` does exactly that on disconnect), and the SDK
    // answers it by closing the WHOLE transport. That transport never accepts
    // another `initialize` — it keeps its old session id and answers every
    // newcomer "Server already initialized" — while the listener stays up and
    // the operator's log still says "listening": a server that refuses every
    // later client until someone restarts it. So a close this module did not
    // ask for is the end of one session, and the server is re-armed with a
    // fresh transport for the next one. Wired BEFORE `connect`, so
    // `Protocol.connect` chains it ahead of its own hook; the re-arm is
    // deferred a microtask so that hook has detached the server first.
    next.onclose = (): void => {
      if (closing || next !== transport) return;
      rearming = new Promise<void>((resolve) => {
        queueMicrotask(resolve);
      }).then(rearm);
    };
    return next;
  };

  const rearm = async (): Promise<void> => {
    if (closing) return;
    deps.logger.info('http session ended by the client; accepting a new session', {
      host,
      port: boundPort,
    });
    const next = newHttpTransport();
    try {
      await server.connect(next);
      transport = next;
    } catch (err) {
      deps.logger.error('http transport could not accept a new session; shutting down', {
        error: errText(err),
      });
      void close();
    } finally {
      rearming = undefined;
    }
  };

  let transport = newHttpTransport();
  await server.connect(transport);

  // Resolved after listen(); the Origin check compares against the bound port.
  let boundPort = requestedPort;

  const handleHttpRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    try {
      // Present-and-wrong is rejected; absent is passed on — see the "no
      // `Origin` header" paragraph in this file's header for why both headers
      // are treated this way.
      const hostHeader = req.headers.host;
      if (
        typeof hostHeader === 'string' &&
        hostHeader.length > 0 &&
        !isAllowedLoopbackHostHeader(hostHeader)
      ) {
        deps.logger.warn('http request rejected: disallowed Host', { host: hostHeader });
        writeJsonRpcError(res, 403, 'host not allowed');
        return;
      }
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
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const body = await readBodyCapped(req, HTTP_MAX_BODY_BYTES);
        if (body === undefined) {
          deps.logger.warn('http request rejected: body too large', {
            limitBytes: HTTP_MAX_BODY_BYTES,
          });
          // Nothing more is buffered: the rest of the body is read and
          // discarded (Node dumps an unconsumed request once the response is
          // written), so the client receives the 413 instead of a reset.
          writeJsonRpcError(
            res,
            413,
            `request body exceeds the ${String(HTTP_MAX_BODY_BYTES)}-byte limit`,
          );
          return;
        }
        // The body is consumed now, so hand the SDK the buffered bytes. Its
        // Node adapter (`@hono/node-server`) reads a `rawBody` Buffer in place
        // of the stream, so every check the SDK makes on the body — content
        // type, JSON, JSON-RPC shape — runs exactly as before.
        (req as IncomingMessage & { rawBody?: Buffer }).rawBody = body;
      }
      if (rearming !== undefined) {
        await rearming;
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
    closing = true;
    if (!controller.signal.aborted) {
      controller.abort();
    }
    if (rearming !== undefined) {
      await rearming;
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
    closing = true;
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

/**
 * Route the SDK's out-of-band failures to the logger.
 *
 * A frame the SDK cannot parse — bytes that are not JSON, JSON that is not
 * JSON-RPC, a request whose id is a float — has no id to answer TO, so the SDK
 * drops it and reports through `transport.onerror`, which `Protocol.connect`
 * forwards to `server.onerror`. Nothing in this process sets either, and an
 * unset hook is silence: the client hangs waiting for a reply that can never
 * come, and the operator's stderr says only "connected". The same hook carries
 * `Failed to send response` and `Unknown message type`, which are the other
 * ways a request can vanish between the wire and a handler.
 *
 * Wired BEFORE `connect` on purpose: `Protocol.connect` chains a hook already
 * on the transport (ours first, then its own) but replaces one set later.
 */
function reportTransportErrors(
  transport: Transport,
  kind: TransportKind,
  logger: Logger,
): void {
  transport.onerror = (err: Error): void => {
    logger.warn(`${kind} transport error`, { error: errText(err) });
  };
}

/** Requests received but not yet answered on one transport. */
interface InFlightRequests {
  size(): number;
  /** Resolves `true` once none are in flight, `false` after `timeoutMs` or on release. */
  drained(timeoutMs: number): Promise<boolean>;
  /** Stop waiting (shutdown began through another path). */
  release(): void;
}

/**
 * Count requests between arrival and their response. Hooked on the transport
 * itself — `onmessage` set BEFORE `connect` (Protocol chains it) and `send`
 * wrapped — so no SDK internals are touched. A request the client cancels gets
 * no response by protocol, so `notifications/cancelled` retires it too.
 *
 * Counted per id, not merely flagged: a client that reuses an id while the
 * first request is still running gets BOTH handlers run and both answered by
 * the SDK, and a set would let the first answer retire the second request too —
 * EOF would then close at once and abort the call still running.
 */
function trackInFlightRequests(transport: Transport): InFlightRequests {
  const pending = new Map<string, number>();
  let total = 0;
  const waiters = new Set<(drained: boolean) => void>();
  const keyOf = (id: unknown): string | undefined =>
    typeof id === 'string' || typeof id === 'number'
      ? `${typeof id}:${String(id)}`
      : undefined;
  const retire = (key: string | undefined): void => {
    if (key === undefined) return;
    const count = pending.get(key);
    if (count === undefined) return;
    if (count > 1) pending.set(key, count - 1);
    else pending.delete(key);
    total -= 1;
    if (total > 0) return;
    for (const wake of waiters) wake(true);
    waiters.clear();
  };

  transport.onmessage = (message): void => {
    const msg = message as Record<string, unknown>;
    if (typeof msg['method'] !== 'string') return;
    if (msg['method'] === 'notifications/cancelled') {
      const params = msg['params'] as Record<string, unknown> | undefined;
      retire(keyOf(params?.['requestId']));
      return;
    }
    const key = keyOf(msg['id']);
    if (key === undefined) return;
    pending.set(key, (pending.get(key) ?? 0) + 1);
    total += 1;
  };

  const send = transport.send.bind(transport);
  transport.send = async (message, options): Promise<void> => {
    try {
      await send(message, options);
    } finally {
      const msg = message as Record<string, unknown>;
      if (typeof msg['method'] !== 'string') retire(keyOf(msg['id']));
    }
  };

  return {
    size: () => total,
    drained: (timeoutMs) =>
      total === 0
        ? Promise.resolve(true)
        : new Promise<boolean>((resolve) => {
            // Deliberately ref'd: stdin is gone, so this timer is what keeps the
            // process alive for a handler awaiting nothing else; it is cleared
            // the moment the last request is answered.
            const timer = setTimeout(() => {
              waiters.delete(wake);
              resolve(false);
            }, timeoutMs);
            const wake = (drained: boolean): void => {
              clearTimeout(timer);
              resolve(drained);
            };
            waiters.add(wake);
          }),
    release: () => {
      for (const wake of waiters) wake(false);
      waiters.clear();
    },
  };
}

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

/** The literal IPv6 loopback address, in both spellings `isIP` accepts. */
const IPV6_LOOPBACK_LITERALS: ReadonlySet<string> = new Set(['::1', '0:0:0:0:0:0:0:1']);

/**
 * True only for a literal IPv4/IPv6 loopback *bind* address. Anything that is
 * not a literal IP is rejected — `localhost`, but equally a DNS name that merely
 * *starts* with `127.` (`127.0.0.1.example.com`) or a bracketed URL-style host
 * (`[::1]`, which `listen()` treats as a name and never resolves). `listen()`
 * hands a non-literal host to the resolver, which may answer with a public
 * address; the contract mandates the literal loopback address (Security #4).
 */
function isLoopbackBindHost(host: string): boolean {
  const family = isIP(host);
  if (family === 4) return host.startsWith('127.');
  return family === 6 && IPV6_LOOPBACK_LITERALS.has(host.toLowerCase());
}

/** Loopback hostnames accepted in an `Origin` header (browsers send names, not IPs). */
const LOOPBACK_ORIGIN_HOSTNAMES: ReadonlySet<string> = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
]);

/**
 * Validate a `Host` header as a loopback name. Parsed through `URL` so the
 * `name:port` and bracketed-IPv6 (`[::1]:8080`) spellings are handled by the
 * same code that handles `Origin`, and so a name that merely CONTAINS a
 * loopback address (`127.0.0.1.evil.test`) is not mistaken for one.
 *
 * Deliberately hostname-only: the port a client reached us through says nothing
 * about whether it is hostile, and pinning it would break a port-forward.
 */
function isAllowedLoopbackHostHeader(host: string): boolean {
  let url: URL;
  try {
    url = new URL(`http://${host}`);
  } catch {
    return false;
  }
  return LOOPBACK_ORIGIN_HOSTNAMES.has(url.hostname);
}

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

/**
 * Constant-time bearer-token check against the `Authorization` header.
 *
 * The SCHEME is matched case-insensitively and may be followed by more than one
 * space, because RFC 7235 §2.1 says so on both counts (`auth-scheme` is a
 * case-insensitive token, and credentials are `auth-scheme 1*SP token68`). A
 * client spelling it `bearer` is holding the right credential, and 401 is the
 * one answer that gives an operator no way to tell that from a wrong token.
 * The CREDENTIAL itself stays exact, and is still compared in constant time.
 */
const BEARER_SCHEME = /^Bearer +/i;

function hasValidBearerToken(req: IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') {
    return false;
  }
  const match = BEARER_SCHEME.exec(header);
  if (match === null) {
    return false;
  }
  return timingSafeStringEqual(header.slice(match[0].length), expected);
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Buffer a request body, giving up as soon as it is known to exceed `limit`:
 * up front from a declared `Content-Length`, otherwise (chunked) the moment
 * the running total passes it. Resolves `undefined` when over the limit.
 */
function readBodyCapped(
  req: IncomingMessage,
  limit: number,
): Promise<Buffer | undefined> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('request closed before its body was complete'));
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
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
 * EVERY `console` method Node routes to **stdout**, plus the state partners of
 * those methods (`time` feeds `timeEnd`/`timeLog`, `groupEnd` closes `group`,
 * `countReset` clears `count`) so a redirected pair keeps its bookkeeping on one
 * object. `console.warn`/`.error`/`.trace`/`.assert` already target stderr and
 * are deliberately absent.
 *
 * Redirecting `log` alone is not enough: `dir` and `dirxml` write to stdout
 * without going through `console.log`, so a dependency calling either would
 * still corrupt the JSON-RPC framing. The rest are listed explicitly rather
 * than relying on Node's internals happening to funnel them through `log`.
 */
const STDOUT_CONSOLE_METHODS = [
  'log',
  'info',
  'debug',
  'dir',
  'dirxml',
  'table',
  'group',
  'groupCollapsed',
  'groupEnd',
  'count',
  'countReset',
  'time',
  'timeLog',
  'timeEnd',
  'clear',
] as const;

type StdoutConsoleMethod = (typeof STDOUT_CONSOLE_METHODS)[number];

/**
 * Redirect every stdout-writing `console` method to stderr for the lifetime of
 * the stdio transport, so a dependency that logs to stdout cannot corrupt the
 * JSON-RPC framing (CC-CFG-1). Returns a restore function.
 *
 * The redirect targets a real {@link Console} whose *stdout* is `process.stderr`,
 * so formatting (`table`, `dir`), indentation (`group`) and label state (`time`,
 * `count`) survive intact — they just land on the diagnostics channel.
 */
function guardStdout(): () => void {
  // Access via typed record aliases so the redirect is not itself a
  // `console.log`/`.info`/`.debug` reference (which the no-console lint forbids).
  const sink = console as unknown as Record<StdoutConsoleMethod, ConsoleWriter>;
  const stderrSink = new Console({
    stdout: process.stderr,
    stderr: process.stderr,
  }) as unknown as Record<StdoutConsoleMethod, ConsoleWriter>;
  const originals = new Map<StdoutConsoleMethod, ConsoleWriter>();
  for (const name of STDOUT_CONSOLE_METHODS) {
    originals.set(name, sink[name]);
    sink[name] = (...args: unknown[]): void => {
      stderrSink[name](...args);
    };
  }
  return () => {
    for (const [name, fn] of originals) {
      sink[name] = fn;
    }
  };
}

function errText(err: unknown): string {
  return errorMessageOf(err);
}
