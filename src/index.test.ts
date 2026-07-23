// Integration smoke for the server bootstrap (task I1).
//
// These tests drive the EXPORTED `buildServer` builder over a real in-process
// MCP session: a low-level `Server` wired to an SDK `Client` through
// `InMemoryTransport.createLinkedPair()`. They never call `main()` (which would
// open a real transport and read the process environment) and never touch the
// network — every collaborator is an in-memory fake, so the test-runner's
// fetch-fence is never provoked.
//
// Three properties are pinned:
//   (a) all-tools smoke — the four `core` tools are advertised with
//       `readOnlyHint: true` (the read-only posture the whole package promises);
//   (b) a read call returns a well-formed ToolResult and leaks no token —
//       `facebook_list_pages` exposes `hasToken`, never the raw access_token;
//   (c) a generic plan-mode no-write sweep — no tool run in the default (plan)
//       write mode ever produces an `applied` journal record. Vacuous today
//       (core is all read-only) but structured to fail the moment a future
//       write tool applies without an explicit `apply`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  createFakeClock,
  createFakeFbRequest,
  createFakePageResolver,
  createFakeRedactor,
  createMemoryJournal,
  fbOk,
  type FakeFbRequest,
  type MemoryJournal,
} from './core/fakes/index.js';
import { loadSettings, type PackageSpec, type Settings } from './core/index.js';
import { createRegistry } from './mcp/index.js';
import { createCorePackage } from './tools/index.js';
import { buildServer, type BuildServerDeps } from './index.js';

/** A raw Page access token that must NEVER survive into a tool result. */
const SECRET_PAGE_TOKEN = 'EAA-PAGE-TOKEN-must-never-leak-9f8e7d6c5b4a';

/** The canonical `core` tool names, all read-only. */
const CORE_TOOLS = [
  'facebook_whoami',
  'facebook_list_pages',
  'facebook_get_page',
  'facebook_usage',
] as const;

/**
 * Resolve a real, valid {@link Settings} from a minimal env (never touches disk).
 *
 * Only the `core` package exists in this wave. The `core` *profile* token expands
 * to the full default surface (core + posts + reader + insights + moderation +
 * messages) and there is no token that selects the `core` package alone, so we
 * DENY the other default packages instead; the registry always forces `core`
 * back on after deny. The resolved registry is therefore exactly core's tools —
 * which is also all that is injectable until the Wave-4 verticals land.
 */
function testSettings(): Settings {
  const { settings } = loadSettings({
    env: {
      FB_ACCESS_TOKEN: 'test-access-token-abc123',
      FB_PACKAGES_DENY: 'posts,reader,insights,moderation,messages',
    },
    loadEnvFile: false,
  });
  return settings;
}

interface Harness {
  readonly deps: BuildServerDeps;
  readonly packages: readonly PackageSpec[];
  readonly settings: Settings;
  readonly fb: FakeFbRequest;
  readonly journal: MemoryJournal;
}

/** Assemble {@link buildServer} dependencies from in-memory fakes. */
function makeHarness(): Harness {
  const settings = testSettings();
  const clock = createFakeClock(1_000);
  const redactor = createFakeRedactor({ secrets: [settings.accessToken ?? ''] });
  const journal = createMemoryJournal(clock);
  const fb = createFakeFbRequest();
  const pages = createFakePageResolver();
  const packages: PackageSpec[] = [createCorePackage({ serverVersion: '1.2.3-test' })];

  const deps: BuildServerDeps = {
    settings,
    packages,
    serverVersion: '1.2.3-test',
    clock,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    redactor,
    journal,
    fbRequest: fb.fn,
    pages,
  };
  return { deps, packages, settings, fb, journal };
}

/** Connect an SDK `Client` to a freshly built server over a linked in-memory pair. */
async function connect(
  deps: BuildServerDeps,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = buildServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'facebook-mcp-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Extract the first text block from a tool result (v1 tools emit text only). */
function firstText(result: CallToolResult): string {
  const block = result.content[0];
  assert.ok(block, 'expected at least one content block');
  assert.equal(block.type, 'text');
  return block.type === 'text' ? block.text : '';
}

// (a) all-tools smoke — the four core tools advertise a read-only posture.
test('advertises the four read-only core tools', async () => {
  const { deps } = makeHarness();
  const { client, close } = await connect(deps);
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...CORE_TOOLS].sort());

    for (const tool of listed.tools) {
      assert.equal(
        tool.annotations?.readOnlyHint,
        true,
        `${tool.name} must advertise readOnlyHint:true`,
      );
      // A well-formed advertised tool always carries an object input schema.
      assert.equal(tool.inputSchema.type, 'object');
    }
  } finally {
    await close();
  }
});

// (b) read call — well-formed result, token presence only, no raw token leak.
test('list_pages exposes hasToken and never the raw access_token', async () => {
  const { deps, fb } = makeHarness();
  // /me/accounts returns a Page whose access_token must be dropped, not surfaced.
  fb.on(
    (req) => req.path === '/me/accounts',
    fbOk({
      data: [
        {
          id: '1010',
          name: 'Brand A',
          category: 'Software',
          tasks: ['MANAGE', 'CREATE_CONTENT'],
          access_token: SECRET_PAGE_TOKEN,
        },
      ],
    }),
  );

  const { client, close } = await connect(deps);
  try {
    const result = (await client.callTool({
      name: 'facebook_list_pages',
      arguments: {},
    })) as CallToolResult;

    assert.notEqual(result.isError, true);
    const text = firstText(result);

    // The token VALUE must appear nowhere in the serialized result.
    assert.ok(
      !text.includes(SECRET_PAGE_TOKEN),
      'raw Page access_token leaked into the tool result',
    );
    // Token PRESENCE is surfaced as a boolean instead.
    assert.ok(text.includes('hasToken'), 'expected hasToken in the result');

    const parsed = JSON.parse(text) as {
      pages: { id: string; hasToken: boolean; access_token?: unknown }[];
      count: number;
    };
    assert.equal(parsed.count, 1);
    assert.equal(parsed.pages[0]?.hasToken, true);
    assert.equal(parsed.pages[0]?.access_token, undefined);
  } finally {
    await close();
  }
});

// (c) plan-mode no-write sweep — nothing produces an `applied` journal record.
test('no tool produces an applied journal record in plan mode', async () => {
  const { deps, fb, packages, settings, journal } = makeHarness();
  assert.equal(settings.writeMode, 'plan', 'default write mode must be plan');

  // Any Graph call the read tools make resolves harmlessly (empty data).
  fb.on(() => true, fbOk({ data: [] }));

  // Enumerate the SAME tool set the server exposes and isolate the write tier.
  const registry = createRegistry(packages, settings);
  const writeTools = registry.tools.filter(
    (t) => t.writeTier !== undefined || t.annotations.readOnlyHint === false,
  );
  // Today core is entirely read-only; this guard turns a future regression
  // (a write tool leaking into `core`) into a failing assertion here.
  assert.equal(writeTools.length, 0, 'core must expose no write-tier tools');

  const { client, close } = await connect(deps);
  try {
    // Exercise every advertised tool in the default (plan) write mode. Each call
    // returns a ToolResult (errors are mapped, never thrown), so none rejects.
    for (const tool of registry.tools) {
      await client.callTool({ name: tool.name, arguments: {} });
    }
  } finally {
    await close();
  }

  const applied = journal.entries.filter((e) => e.outcome === 'applied');
  assert.equal(
    applied.length,
    0,
    'plan-mode calls must not write an applied journal record',
  );
});
