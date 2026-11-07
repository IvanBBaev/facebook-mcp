// Tests for the server bootstrap: the all-tools smoke, composition decisions and failure
// mapping.
//
// Split out of `index.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/server.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CallToolResultSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { fbOk } from './core/fakes/index.js';
import { loadSettings } from './core/index.js';
import { createRegistry } from './mcp/index.js';
import { createAdsPackage } from './tools/index.js';
import { buildServer } from './index.js';
import {
  ACCESS_TOKEN,
  SECRET_PAGE_TOKEN,
  bootstrapPackages,
  callProbeServer,
  connect,
  firstText,
  makeHarness,
  parseResult,
  probePackages,
  probeSettings,
} from './testing/harness/server.js';

/** The canonical `core` tool names, all read-only. */
const CORE_TOOLS = [
  'facebook_whoami',
  'facebook_list_pages',
  'facebook_get_page',
  'facebook_usage',
] as const;

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

test('an explicit package selection still advertises the always-on core tools', async () => {
  const { deps } = makeHarness({ settings: probeSettings(), packages: probePackages() });
  const { client, close } = await connect(deps);
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((t) => t.name).sort(),
      [...CORE_TOOLS, 'facebook_probe_context', 'facebook_probe_fail'].sort(),
      'FB_TOOL_PACKAGES=ads must resolve to the probe package plus core',
    );

    // `title` is optional on a ToolSpec and must survive — or stay absent —
    // through the SDK projection exactly as the spec declared it.
    const byName = new Map(listed.tools.map((t) => [t.name, t]));
    assert.equal(byName.get('facebook_probe_fail')?.title, 'Probe failure');
    assert.equal(byName.get('facebook_probe_context')?.title, undefined);
  } finally {
    await close();
  }
});

test('an unknown package name fails the build and lists the valid names', () => {
  const { settings } = loadSettings({
    // A plausible typo for `ads` — the operator must be told what to write.
    env: { FB_ACCESS_TOKEN: ACCESS_TOKEN, FB_TOOL_PACKAGES: 'core,add' },
    loadEnvFile: false,
  });
  const { deps } = makeHarness({ settings });

  assert.throws(
    () => buildServer(deps),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /"add"/, 'the offending token must be quoted verbatim');
      assert.match(err.message, /Valid names: .*\bads\b/);
      return true;
    },
  );
});

test('a tool disabled by package configuration says so, not "unknown tool"', async () => {
  // `ads` is built but off in the default profile; `posts` read-only drops its
  // write tools. Either way the name is real, and "unknown tool" sends the
  // model looking for a typo instead of at the operator's package settings.
  const adsTool = createAdsPackage().tools[0]?.name ?? '';
  const cases: readonly [Record<string, string>, string, RegExp][] = [
    [{}, adsTool, /package 'ads' is not loaded.*FB_TOOL_PACKAGES.*FB_PACKAGES_DENY/],
    [
      { FB_PACKAGES_READONLY: 'posts' },
      'facebook_delete_post',
      /FB_PACKAGES_READONLY drops the write tools of package 'posts'/,
    ],
  ];
  for (const [env, name, expected] of cases) {
    const { settings } = loadSettings({
      env: { FB_ACCESS_TOKEN: ACCESS_TOKEN, ...env },
      loadEnvFile: false,
    });
    const { deps, fb } = makeHarness({ settings, packages: bootstrapPackages() });
    const { client, close } = await connect(deps);
    try {
      const result = (await client.callTool({ name, arguments: {} })) as CallToolResult;
      assert.equal(result.isError, true);
      const error = String(parseResult(result)['error']);
      assert.match(error, new RegExp(`tool ${name} is disabled`));
      assert.match(error, expected);
    } finally {
      await close();
    }
    assert.equal(fb.calls.length, 0, 'a disabled tool must never reach Graph');
  }
});

test('an unadvertised tool name returns an error result, not a protocol error', async () => {
  const { deps, fb } = makeHarness();
  const { client, close } = await connect(deps);
  try {
    // No `arguments` member at all, and a name the registry never advertised.
    const result = (await client.callTool({
      name: 'facebook_not_a_tool',
    })) as CallToolResult;

    assert.equal(result.isError, true);
    assert.equal(parseResult(result)['error'], 'unknown tool: facebook_not_a_tool');
  } finally {
    await close();
  }
  assert.equal(fb.calls.length, 0, 'an unknown tool must never reach Graph');
});

test('a tools/call whose arguments are not an object is a tool error, not -32603', async () => {
  // The SDK's own request schema rejects `arguments: null` (or an array, or a
  // scalar) while parsing, which surfaces as a JSON-RPC -32603 "internal error"
  // — the one code that tells the model the SERVER broke. The caller sent a
  // malformed call and must be told so in a result it can correct from.
  const { deps, fb } = makeHarness();
  const { client, close } = await connect(deps);
  try {
    for (const [bad, shape] of [
      [null, 'null'],
      [['a'], 'an array'],
      ['x', 'a string'],
    ] as const) {
      const result = await client.request(
        {
          method: 'tools/call',
          params: {
            name: 'facebook_whoami',
            arguments: bad as unknown as Record<string, unknown>,
          },
        },
        CallToolResultSchema,
      );
      assert.equal(result.isError, true, `arguments ${shape} must be a tool error`);
      const error = String(parseResult(result)['error']);
      assert.match(error, /facebook_whoami/);
      assert.match(error, /`arguments` must be an object/);
      assert.ok(
        error.includes(`got ${shape}`),
        `the message must name ${shape}: ${error}`,
      );
    }
  } finally {
    await close();
  }
  assert.equal(fb.calls.length, 0, 'a malformed call must never reach Graph');
});

test('the bootstrap injects the profile, the write gate and the confirmer', async () => {
  const result = await callProbeServer('facebook_probe_context', { profile: 'brand-a' });

  assert.notEqual(result.isError, true);
  const ctx = parseResult(result);
  assert.equal(ctx['profile'], 'brand-a');
  // Both write seams are attached by the bootstrap, not by the frozen
  // ToolContext — a write handler that cannot see them cannot gate anything.
  assert.equal(ctx['hasWriteGate'], true);
  assert.equal(ctx['hasConfirmer'], true);
  // The MCP request's abort signal must reach the handler, or a cancelled call
  // keeps running against Graph.
  assert.equal(ctx['hasSignal'], true);
  assert.equal(ctx['writeMode'], 'plan');
});

test('a blank profile argument never becomes a context profile', async () => {
  // An empty string is not a page reference; letting it through would make the
  // resolver look up a Page named "" instead of falling back to the default.
  const result = await callProbeServer('facebook_probe_context', { profile: '' });

  assert.equal(parseResult(result)['profile'], null);
});

test('a thrown WriteGateError keeps the fields the model self-corrects on', async () => {
  const result = await callProbeServer('facebook_probe_fail', { kind: 'write-gate' });

  assert.equal(result.isError, true);
  const record = parseResult(result);
  assert.match(String(record['error']), /the plan expired/);
  assert.equal(record['code'], 'plan_expired');
  assert.equal(record['tool'], 'facebook_probe_fail');
  assert.equal(record['tier'], 'irreversible');
});

test('a thrown GraphApiError surfaces its codes and the operator action', async () => {
  const full = await callProbeServer('facebook_probe_fail', { kind: 'graph' });

  assert.equal(full.isError, true);
  const record = parseResult(full);
  assert.equal(record['code'], 200);
  assert.equal(record['subcode'], 1_349_003);
  assert.equal(record['type'], 'OAuthException');
  assert.equal(record['httpStatus'], 403);
  assert.equal(record['fbtraceId'], 'trace-abc');
  // The classification is what makes the failure actionable: the operator
  // sentence, flattened alongside the fields the model decides on.
  assert.equal(record['action'], 'Grant pages_manage_posts, then retry.');
  assert.equal(record['category'], 'permission');
  assert.equal(record['retryable'], false);
  // This action carries neither, so neither is invented.
  assert.ok(!('nextTool' in record));
  assert.ok(!('retryAfterMs' in record));

  // An unclassified Graph error must not invent the optional fields.
  const bare = parseResult(
    await callProbeServer('facebook_probe_fail', { kind: 'graph-bare' }),
  );
  assert.equal(bare['code'], 100);
  assert.equal(bare['httpStatus'], 400);
  for (const absent of [
    'subcode',
    'type',
    'fbtraceId',
    'action',
    'category',
    'retryable',
    'nextTool',
    'retryAfterMs',
  ]) {
    assert.ok(!(absent in bare), `${absent} must be absent, not null`);
  }
});

test('a throttled Graph error ships the next tool and the cool-down, not just prose', async () => {
  const record = parseResult(
    await callProbeServer('facebook_probe_fail', { kind: 'graph-throttled' }),
  );

  assert.equal(record['category'], 'rate_limit');
  // The model must not have to read "back off and retry" out of a sentence.
  assert.equal(record['retryable'], true);
  assert.equal(record['nextTool'], 'facebook_usage');
  assert.equal(record['retryAfterMs'], 30 * 60_000);
});

test('a Graph error with user-facing text surfaces it beside the message, redacted', async () => {
  const result = await callProbeServer('facebook_probe_fail', {
    kind: 'graph-user-text',
  });

  assert.equal(result.isError, true);
  const record = parseResult(result);
  // Graph's own message is untouched (operators grep for it) …
  assert.equal(record['error'], 'Graph API error (HTTP 400): Invalid parameter');
  // … and the reason ships as its own two fields, through the same redaction
  // choke-point as everything else in the record.
  assert.equal(record['userTitle'], 'Budget Too Low');
  assert.equal(
    record['userMessage'],
    'The daily budget must be at least $1.00 (token [REDACTED]).',
  );
  assert.equal(record['code'], 100);
  assert.equal(record['subcode'], 1_487_390);

  // Absent on the error ⇒ absent on the record, never null.
  const bare = parseResult(
    await callProbeServer('facebook_probe_fail', { kind: 'graph-bare' }),
  );
  assert.ok(!('userTitle' in bare));
  assert.ok(!('userMessage' in bare));
});

test('a non-Error rejection still maps to a well-formed error result', async () => {
  const result = await callProbeServer('facebook_probe_fail', { kind: 'non-error' });

  assert.equal(result.isError, true);
  assert.deepEqual(parseResult(result), { error: 'probe rejected with a bare string' });
});

test('a non-Error object rejection keeps its message instead of "[object Object]"', async () => {
  const result = await callProbeServer('facebook_probe_fail', {
    kind: 'non-error-object',
  });

  assert.equal(result.isError, true);
  assert.deepEqual(parseResult(result), { error: 'probe rejected with an object' });
});

test('an error message carrying the token is redacted before it reaches the client', async () => {
  const result = await callProbeServer('facebook_probe_fail', { kind: 'plain' });

  assert.equal(result.isError, true);
  const text = firstText(result);
  // The error path runs through the same redaction choke-point as the success
  // path — a token pasted into an exception message is the classic leak.
  assert.ok(
    !text.includes(ACCESS_TOKEN),
    'the access token leaked through the error path',
  );
  assert.match(text, /\[REDACTED\]/);
});
