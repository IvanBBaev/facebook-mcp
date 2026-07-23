// Self-contained spawn fixture for the stdout-purity test (task F14, CC-CFG-1 / C12).
//
// `transport.test.ts` spawns this module as a child process and drives it over
// stdin/stdout. It boots a minimal MCP server (one no-op tool) on the real stdio
// transport from `./transport.js`, then deliberately emits stray
// `console.log`/`.info` output plus a structured logger line. The transport's
// console guard must redirect the stray stdout writes to stderr, so the child's
// stdout carries ONLY well-formed JSON-RPC frames.
//
// It depends on `./transport.js` and the core barrel only — NOT on `src/index.ts`
// (I1's bootstrap, which does not exist yet).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createLogger, createRedactor } from '../core/index.js';
import type { Clock, Settings } from '../core/index.js';
import { startTransport } from './transport.js';

const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('aborted'));
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        },
        { once: true },
      );
    }),
};

async function main(): Promise<void> {
  const logger = createLogger({
    clock: systemClock,
    redactor: createRedactor(),
    level: 'debug',
  });

  const server = new McpServer({ name: 'fbmcp-spawn-fixture', version: '0.0.0' });
  server.registerTool(
    'noop',
    { description: 'No-op tool for the stdout-purity fixture.' },
    () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }),
  );

  // No injected streams => the real process.stdin/stdout, so the console guard
  // is installed (this is exactly the production stdio path).
  const handle = await startTransport(
    server,
    { transport: 'stdio' } as unknown as Settings,
    {
      logger,
    },
  );

  // Stray stdout-bound output emitted AFTER the guard is installed. If the guard
  // works these land on stderr and never corrupt the JSON-RPC frames on stdout.
  // The two writes below are the whole point of the fixture, hence the disables.
  // eslint-disable-next-line no-console -- deliberately exercise the stdout guard
  console.log('STRAY-STDOUT-LOG must not reach stdout');
  // eslint-disable-next-line no-console -- deliberately exercise the stdout guard
  console.info('STRAY-STDOUT-INFO must not reach stdout');
  logger.info('spawn fixture ready', { via: 'stderr-logger' });

  // Serve until the parent closes our stdin (EOF => clean shutdown, CC-MCP-5).
  await handle.closed;
  process.exit(0);
}

void main().catch((err: unknown) => {
  process.stderr.write(
    `spawn fixture failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
